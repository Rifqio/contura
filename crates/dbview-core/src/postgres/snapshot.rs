use std::collections::BTreeMap;

use tokio_postgres::Client;

use super::query_err;
use crate::error::{Error, Result};
use crate::model::DialectKind;
use crate::schema_model::{
    SchemaModel, SmColumn, SmEndpoint, SmEnum, SmIndex, SmRef, SmTable, parse_sql_default,
};

fn rule(code: &str) -> Option<String> {
    match code {
        "r" => Some("RESTRICT"),
        "c" => Some("CASCADE"),
        "n" => Some("SET NULL"),
        "d" => Some("SET DEFAULT"),
        _ => None,
    }
    .map(str::to_string)
}

const TABLES_SQL: &str = "SELECT c.relname::text, c.relkind::text, obj_description(c.oid, 'pg_class') \
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
    WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition \
    ORDER BY c.relname";

const COLUMNS_SQL: &str = "SELECT c.relname::text, a.attname::text, format_type(a.atttypid, a.atttypmod), \
    a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attidentity::text, a.attgenerated::text, \
    col_description(a.attrelid, a.attnum) \
    FROM pg_attribute a \
    JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
    WHERE n.nspname = $1 AND c.relkind IN ('r','p') AND NOT c.relispartition \
      AND a.attnum > 0 AND NOT a.attisdropped \
    ORDER BY c.relname, a.attnum";

const INDEXES_SQL: &str = "SELECT c.relname::text, i.relname::text, ix.indisunique, ix.indisprimary, \
    ix.indexprs IS NOT NULL, \
    ARRAY(SELECT a.attname::text FROM unnest(ix.indkey) WITH ORDINALITY k(attnum, ord) \
          JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum ORDER BY k.ord) \
    FROM pg_index ix JOIN pg_class c ON c.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid \
    JOIN pg_namespace n ON n.oid = c.relnamespace \
    WHERE n.nspname = $1 AND c.relkind IN ('r','p') \
    ORDER BY c.relname, i.relname";

const REFS_SQL: &str = "SELECT con.conname::text, c.relname::text, fn.nspname::text, fc.relname::text, \
    ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord) \
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord), \
    ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord) \
          JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord), \
    con.confdeltype::text, con.confupdtype::text \
    FROM pg_constraint con \
    JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
    JOIN pg_class fc ON fc.oid = con.confrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace \
    WHERE con.contype = 'f' AND n.nspname = $1 \
    ORDER BY c.relname, con.conname";

const ENUMS_SQL: &str = "SELECT t.typname::text, \
    ARRAY(SELECT e.enumlabel::text FROM pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder) \
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace \
    WHERE t.typtype = 'e' AND n.nspname = $1 ORDER BY t.typname";

/// Objects the model cannot express, as `(kind, name)`.
const SKIPPED_SQL: &str = "SELECT kind, name FROM ( \
    SELECT CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind, p.proname::text AS name \
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
      WHERE n.nspname = $1 AND p.prokind IN ('f','p') \
    UNION ALL \
    SELECT 'trigger', t.tgname::text || ' on ' || c.relname::text \
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
      WHERE n.nspname = $1 AND NOT t.tgisinternal \
    UNION ALL \
    SELECT 'check constraint', con.conname::text \
      FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace \
      WHERE n.nspname = $1 AND con.contype = 'c' \
    UNION ALL \
    SELECT 'domain', t.typname::text \
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace \
      WHERE n.nspname = $1 AND t.typtype = 'd' \
    ) s ORDER BY kind, name";

pub(super) async fn schema_snapshot(client: &Client, schema: &str) -> Result<SchemaModel> {
    let mut skipped = Vec::new();
    let mut tables: BTreeMap<String, SmTable> = BTreeMap::new();
    for row in client
        .query(TABLES_SQL, &[&schema])
        .await
        .map_err(query_err)?
    {
        let name: String = row.get(0);
        let kind: String = row.get(1);
        match kind.as_str() {
            "r" | "p" => {
                let note: Option<String> = row.get(2);
                tables.insert(
                    name.clone(),
                    SmTable {
                        schema: Some(schema.to_string()),
                        name,
                        alias: None,
                        note,
                        columns: Vec::new(),
                        indexes: Vec::new(),
                    },
                );
            }
            "v" => skipped.push(format!("view {name}")),
            "m" => skipped.push(format!("materialized view {name}")),
            _ => skipped.push(format!("foreign table {name}")),
        }
    }

    for row in client
        .query(COLUMNS_SQL, &[&schema])
        .await
        .map_err(query_err)?
    {
        let table: String = row.get(0);
        let Some(t) = tables.get_mut(&table) else {
            continue;
        };
        let name: String = row.get(1);
        let default_expr: Option<String> = row.get(4);
        let identity: String = row.get(5);
        let generated: String = row.get(6);
        let mut note: Option<String> = row.get(7);
        let serial = default_expr
            .as_deref()
            .is_some_and(|d| d.starts_with("nextval("));
        let mut default = None;
        if generated == "s" {
            skipped.push(format!("generated column {table}.{name}"));
            note = Some(format!(
                "generated: {}",
                default_expr.clone().unwrap_or_default()
            ));
        } else if !serial {
            default = default_expr.as_deref().map(parse_sql_default);
        }
        t.columns.push(SmColumn {
            name,
            type_name: row.get(2),
            pk: false,
            increment: serial || !identity.is_empty(),
            not_null: row.get(3),
            unique: false,
            default,
            note,
        });
    }

    for row in client
        .query(INDEXES_SQL, &[&schema])
        .await
        .map_err(query_err)?
    {
        let table: String = row.get(0);
        let Some(t) = tables.get_mut(&table) else {
            continue;
        };
        let index: String = row.get(1);
        let unique: bool = row.get(2);
        let primary: bool = row.get(3);
        if row.get::<_, bool>(4) {
            skipped.push(format!("expression index {index}"));
            continue;
        }
        let cols: Vec<String> = row.get(5);
        if cols.len() == 1 && (primary || unique) {
            if let Some(c) = t.columns.iter_mut().find(|c| c.name == cols[0]) {
                if primary {
                    c.pk = true;
                } else {
                    c.unique = true;
                }
            }
            continue;
        }
        t.indexes.push(SmIndex {
            name: (!primary).then_some(index),
            columns: cols,
            unique: unique || primary,
            pk: primary,
        });
    }

    let mut refs = Vec::new();
    for row in client
        .query(REFS_SQL, &[&schema])
        .await
        .map_err(query_err)?
    {
        let name: String = row.get(0);
        let table: String = row.get(1);
        let from_cols: Vec<String> = row.get(4);
        let auto = format!("{table}_{}_fkey", from_cols.join("_"));
        let on_delete: String = row.get(6);
        let on_update: String = row.get(7);
        refs.push(SmRef {
            name: (name != auto).then_some(name),
            from: SmEndpoint {
                schema: Some(schema.to_string()),
                table,
                columns: from_cols,
            },
            to: SmEndpoint {
                schema: Some(row.get(2)),
                table: row.get(3),
                columns: row.get(5),
            },
            on_delete: rule(&on_delete),
            on_update: rule(&on_update),
        });
    }

    let enums = client
        .query(ENUMS_SQL, &[&schema])
        .await
        .map_err(query_err)?
        .into_iter()
        .map(|row| SmEnum {
            schema: Some(schema.to_string()),
            name: row.get(0),
            values: row.get(1),
        })
        .collect();

    for row in client
        .query(SKIPPED_SQL, &[&schema])
        .await
        .map_err(query_err)?
    {
        let kind: String = row.get(0);
        let name: String = row.get(1);
        skipped.push(format!("{kind} {name}"));
    }

    Ok(SchemaModel {
        dialect: DialectKind::Postgres,
        tables: tables.into_values().collect(),
        refs,
        enums,
        skipped,
    })
}

pub(super) fn require_schema(schema: Option<&str>) -> Result<&str> {
    schema.ok_or_else(|| Error::InvalidInput("choose a schema".into()))
}
