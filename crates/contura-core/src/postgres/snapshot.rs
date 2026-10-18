use std::collections::BTreeMap;

use tokio_postgres::Client;

use super::query_err;
use crate::design::{
    IncomingRef, Increment, TableColumn, TableDesign, TableForeignKey, TableIndex, advanced_note,
};
use crate::error::{Error, Result};
use crate::model::{DialectKind, ObjectPath};
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

const DESIGN_TABLE_SQL: &str = "SELECT obj_description(c.oid, 'pg_class') \
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
    WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p')";

const DESIGN_COLUMNS_SQL: &str = "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), \
    a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attidentity::text, a.attgenerated::text, \
    col_description(a.attrelid, a.attnum), \
    CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation \
         THEN (SELECT co.collname::text FROM pg_collation co WHERE co.oid = a.attcollation) END \
    FROM pg_attribute a \
    JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
    JOIN pg_type t ON t.oid = a.atttypid \
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
    WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped \
    ORDER BY a.attnum";

/// Key columns only (`indnkeyatts`); an expression key part reads as its text.
const DESIGN_INDEXES_SQL: &str = "SELECT i.relname::text, ix.indisunique, ix.indisprimary, \
    EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = ix.indexrelid \
            AND k.conrelid = ix.indrelid AND k.contype IN ('p','u')), \
    am.amname::text, pg_get_expr(ix.indpred, ix.indrelid), ix.indexprs IS NOT NULL, \
    ARRAY(SELECT CASE WHEN ix.indkey[k.ord - 1] = 0 \
                 THEN pg_get_indexdef(ix.indexrelid, k.ord, false) \
                 ELSE (SELECT a.attname::text FROM pg_attribute a \
                       WHERE a.attrelid = ix.indrelid AND a.attnum = ix.indkey[k.ord - 1]) END \
          FROM generate_series(1, ix.indnkeyatts::int) k(ord) ORDER BY k.ord), \
    array_remove(ARRAY[ \
      CASE WHEN ix.indnatts > ix.indnkeyatts THEN 'include columns' END, \
      CASE WHEN EXISTS (SELECT 1 FROM generate_series(0, ix.indnkeyatts - 1) k \
                        WHERE (ix.indoption[k] & 1) <> 0) THEN 'descending order' END, \
      CASE WHEN EXISTS (SELECT 1 FROM generate_series(0, ix.indnkeyatts - 1) k \
                        WHERE ((ix.indoption[k] & 1) <> 0) <> ((ix.indoption[k] & 2) <> 0)) \
           THEN 'nulls order' END, \
      CASE WHEN EXISTS (SELECT 1 FROM generate_series(0, ix.indnkeyatts - 1) k \
                        JOIN pg_opclass oc ON oc.oid = ix.indclass[k] WHERE NOT oc.opcdefault) \
           THEN 'operator class' END, \
      CASE WHEN EXISTS (SELECT 1 FROM generate_series(0, ix.indnkeyatts - 1) k \
                        LEFT JOIN pg_attribute a ON a.attrelid = ix.indrelid \
                             AND a.attnum = ix.indkey[k] AND ix.indkey[k] <> 0 \
                        WHERE ix.indcollation[k] <> 0 \
                          AND ix.indcollation[k] <> COALESCE(a.attcollation, 100)) \
           THEN 'collation' END, \
      CASE WHEN COALESCE((to_jsonb(ix) ->> 'indnullsnotdistinct')::boolean, false) \
           THEN 'nulls not distinct' END \
    ]::text[], NULL) \
    FROM pg_index ix JOIN pg_class c ON c.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid \
    JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_am am ON am.oid = i.relam \
    WHERE n.nspname = $1 AND c.relname = $2 \
    ORDER BY ix.indisprimary DESC, i.relname";

const DESIGN_REFS_SQL: &str = "SELECT con.conname::text, fn.nspname::text, fc.relname::text, \
    ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord) \
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord), \
    ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord) \
          JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord), \
    con.confdeltype::text, con.confupdtype::text, \
    con.condeferrable, con.condeferred, con.confmatchtype::text \
    FROM pg_constraint con \
    JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
    JOIN pg_class fc ON fc.oid = con.confrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace \
    WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2 \
    ORDER BY con.conname";

const DESIGN_INCOMING_SQL: &str = "SELECT con.conname::text, n.nspname::text, c.relname::text \
    FROM pg_constraint con \
    JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
    JOIN pg_class fc ON fc.oid = con.confrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace \
    WHERE con.contype = 'f' AND fn.nspname = $1 AND fc.relname = $2 \
    ORDER BY n.nspname, c.relname, con.conname";

/// Checks and triggers of one table, as `unsupported` notes.
const DESIGN_NOTES_SQL: &str = "SELECT kind, name FROM ( \
    SELECT 1 AS ord, 'check' AS kind, con.conname::text AS name \
      FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid \
      JOIN pg_namespace n ON n.oid = c.relnamespace \
      WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'c' \
    UNION ALL \
    SELECT 2, 'trigger', t.tgname::text \
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid \
      JOIN pg_namespace n ON n.oid = c.relnamespace \
      WHERE n.nspname = $1 AND c.relname = $2 AND NOT t.tgisinternal \
    ) s ORDER BY ord, name";

/// `'new'::character varying` on a `character varying(16)` column reads as `'new'`: a
/// quoted literal takes the column's type anyway. A cast to any other type stays.
fn strip_own_cast(default: &str, type_sql: &str) -> String {
    let Some(rest) = default.strip_prefix('\'') else {
        return default.to_string();
    };
    let mut chars = rest.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c != '\'' {
            continue;
        }
        if chars.peek().is_some_and(|(_, n)| *n == '\'') {
            chars.next();
            continue;
        }
        let end = i + 2;
        let Some(cast) = default[end..].strip_prefix("::") else {
            return default.to_string();
        };
        let mut base = String::new();
        let mut depth = 0;
        for ch in type_sql.chars() {
            match ch {
                '(' => depth += 1,
                ')' => depth -= 1,
                _ if depth == 0 => base.push(ch),
                _ => {}
            }
        }
        let base = base.split_whitespace().collect::<Vec<_>>().join(" ");
        return if cast == type_sql || cast == base {
            default[..end].to_string()
        } else {
            default.to_string()
        };
    }
    default.to_string()
}

/// One table for the Table Designer: the snapshot's catalog sources, filtered by
/// table, with real index and key names and nothing folded into columns.
pub(super) async fn table_design(
    client: &Client,
    schema: &str,
    path: &ObjectPath,
) -> Result<TableDesign> {
    let table = path.name.as_str();
    let Some(found) = client
        .query_opt(DESIGN_TABLE_SQL, &[&schema, &table])
        .await
        .map_err(query_err)?
    else {
        return Err(Error::NotFound(table.to_string()));
    };
    let comment: Option<String> = found.get(0);
    let mut unsupported = Vec::new();

    let mut columns = Vec::new();
    for row in client
        .query(DESIGN_COLUMNS_SQL, &[&schema, &table])
        .await
        .map_err(query_err)?
    {
        let name: String = row.get(0);
        let type_sql: String = row.get(1);
        let not_null: bool = row.get(2);
        let default_expr: Option<String> = row.get(3);
        let identity: String = row.get(4);
        // `s` stored, `v` virtual (PostgreSQL 18); both are generated.
        let generated = !row.get::<_, String>(5).is_empty();
        if generated {
            unsupported.push(format!("generated column {name}"));
        }
        let increment = if !identity.is_empty() {
            Increment::Identity
        } else if default_expr
            .as_deref()
            .is_some_and(|d| d.starts_with("nextval("))
        {
            Increment::Serial
        } else {
            Increment::None
        };
        let default_sql = default_expr
            .filter(|_| !generated)
            .map(|d| strip_own_cast(&d, &type_sql));
        columns.push(TableColumn {
            name,
            type_sql,
            nullable: !not_null,
            default_sql,
            increment,
            comment: row.get(6),
            generated,
            mysql: None,
            sqlite_autoincrement: false,
            collation: row.get(7),
            advanced: false,
            // `a` ALWAYS, `d` BY DEFAULT.
            identity_always: identity == "a",
        });
    }

    let mut indexes = Vec::new();
    let mut advanced = Vec::new();
    for row in client
        .query(DESIGN_INDEXES_SQL, &[&schema, &table])
        .await
        .map_err(query_err)?
    {
        let attrs: Vec<String> = row.get(8);
        let name: String = row.get(0);
        if !attrs.is_empty() {
            advanced.push(advanced_note("index", &name, &attrs));
        }
        indexes.push(TableIndex {
            name,
            unique: row.get(1),
            primary: row.get(2),
            constraint: row.get(3),
            sql: None,
            method: Some(row.get(4)),
            predicate: row.get(5),
            expression: row.get(6),
            columns: row.get(7),
            advanced: !attrs.is_empty(),
        });
    }

    let foreign_keys = client
        .query(DESIGN_REFS_SQL, &[&schema, &table])
        .await
        .map_err(query_err)?
        .into_iter()
        .map(|row| {
            let on_delete: String = row.get(5);
            let on_update: String = row.get(6);
            let mut attrs = Vec::new();
            if row.get::<_, bool>(7) {
                attrs.push("deferrable".to_string());
            }
            if row.get::<_, bool>(8) {
                attrs.push("initially deferred".to_string());
            }
            match row.get::<_, String>(9).as_str() {
                "f" => attrs.push("match full".to_string()),
                "p" => attrs.push("match partial".to_string()),
                _ => {}
            }
            let name: String = row.get(0);
            if !attrs.is_empty() {
                advanced.push(advanced_note("foreign key", &name, &attrs));
            }
            TableForeignKey {
                advanced: !attrs.is_empty(),
                name,
                columns: row.get(3),
                target: ObjectPath {
                    database: path.database.clone(),
                    schema: Some(row.get(1)),
                    name: row.get(2),
                },
                target_columns: row.get(4),
                on_delete: rule(&on_delete),
                on_update: rule(&on_update),
            }
        })
        .collect();

    let referenced_by = client
        .query(DESIGN_INCOMING_SQL, &[&schema, &table])
        .await
        .map_err(query_err)?
        .into_iter()
        .map(|row| IncomingRef {
            name: row.get(0),
            table: ObjectPath {
                database: path.database.clone(),
                schema: Some(row.get(1)),
                name: row.get(2),
            },
            on_delete: None,
        })
        .collect();

    for row in client
        .query(DESIGN_NOTES_SQL, &[&schema, &table])
        .await
        .map_err(query_err)?
    {
        let kind: String = row.get(0);
        let name: String = row.get(1);
        unsupported.push(format!("{kind} {name}"));
    }
    unsupported.extend(advanced);

    Ok(TableDesign {
        path: path.clone(),
        columns,
        indexes,
        foreign_keys,
        referenced_by,
        comment,
        unsupported,
        sqlite: None,
    })
}

#[cfg(test)]
mod tests {
    use super::strip_own_cast;

    #[test]
    fn strips_only_a_cast_to_the_column_type() {
        let cases = [
            ("'new'::character varying", "character varying(16)", "'new'"),
            ("'it''s'::text", "text", "'it''s'"),
            ("'mall'::store_kind", "store_kind", "'mall'"),
            ("'{}'::text[]", "text[]", "'{}'"),
            ("'2020-01-01'::date", "text", "'2020-01-01'::date"),
            ("'a'::text || 'b'::text", "text", "'a'::text || 'b'::text"),
            ("0", "numeric(10,2)", "0"),
            (
                "CURRENT_TIMESTAMP",
                "timestamp without time zone",
                "CURRENT_TIMESTAMP",
            ),
            ("'x'", "text", "'x'"),
        ];
        for (default, type_sql, want) in cases {
            assert_eq!(
                strip_own_cast(default, type_sql),
                want,
                "{default} on {type_sql}"
            );
        }
    }
}
