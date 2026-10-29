use std::collections::BTreeMap;

use tokio_postgres::Client;

use super::query_err;
use crate::error::Result;
use crate::schema_model::SmEndpoint;
use crate::sql_schema::{SqlColumn, SqlFk, SqlSchema, SqlTable, SqlTableKind};

/// Beyond this many schemas only the search_path ones are loaded.
const MAX_SCHEMAS: i64 = 200;

const SYSTEM_FILTER: &str = "n.nspname <> 'information_schema' AND n.nspname <> 'pg_catalog' \
    AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'";

fn scope(only_search_path: bool) -> &'static str {
    if only_search_path {
        "n.nspname = ANY(current_schemas(false))"
    } else {
        SYSTEM_FILTER
    }
}

fn columns_sql(only_search_path: bool) -> String {
    let scope = scope(only_search_path);
    // An array type is named `_int4`, so it is shown as `int4[]`. An enum's labels come
    // in their sort order; any other type has no pg_enum rows, so its array is empty.
    format!(
        "SELECT n.nspname::text, c.relname::text, c.relkind::text, a.attname::text, \
         CASE WHEN t.typcategory = 'A' THEN et.typname::text || '[]' ELSE t.typname::text END, \
         COALESCE(a.attnum = ANY(ix.indkey), false), \
         ARRAY(SELECT e.enumlabel::text FROM pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder) \
         FROM pg_attribute a \
         JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
         JOIN pg_type t ON t.oid = a.atttypid LEFT JOIN pg_type et ON et.oid = t.typelem \
         LEFT JOIN pg_index ix ON ix.indrelid = c.oid AND ix.indisprimary \
         WHERE c.relkind IN ('r','p','v','m') AND NOT c.relispartition AND {scope} \
           AND a.attnum > 0 AND NOT a.attisdropped \
         ORDER BY n.nspname, c.relname, a.attnum"
    )
}

/// A key to a partitioned table is one key. PostgreSQL also stores a copy of it per
/// partition of the referenced table, on the same table as the key it copies: those are
/// left out. A partition's copy of its parent's key sits on another table, the partition,
/// and stays, so a partition's grid finds the key it holds (to a leaf partition too).
fn fks_sql(only_search_path: bool) -> String {
    let scope = scope(only_search_path);
    format!(
        "SELECT n.nspname::text, c.relname::text, fn.nspname::text, fc.relname::text, \
         ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord) \
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord), \
         ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord) \
               JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord), \
         con.conname::text, obj_description(con.oid, 'pg_constraint') \
         FROM pg_constraint con \
         JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
         JOIN pg_class fc ON fc.oid = con.confrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace \
         WHERE con.contype = 'f' AND (con.conparentid = 0 OR (SELECT p.conrelid FROM pg_constraint p WHERE p.oid = con.conparentid) <> con.conrelid) AND {scope} \
         ORDER BY n.nspname, c.relname, con.conname"
    )
}

pub(super) async fn sql_schema(client: &Client) -> Result<SqlSchema> {
    let search_path: Vec<String> = client
        .query_one("SELECT current_schemas(false)::text[]", &[])
        .await
        .map_err(query_err)?
        .get(0);
    let count: i64 = client
        .query_one(
            &format!("SELECT count(*) FROM pg_namespace n WHERE {SYSTEM_FILTER}"),
            &[],
        )
        .await
        .map_err(query_err)?
        .get(0);
    let narrow = count > MAX_SCHEMAS;

    let mut tables: BTreeMap<(String, String), SqlTable> = BTreeMap::new();
    for row in client
        .query(&columns_sql(narrow), &[])
        .await
        .map_err(query_err)?
    {
        let schema: String = row.get(0);
        let name: String = row.get(1);
        let relkind: String = row.get(2);
        let t = tables
            .entry((schema.clone(), name.clone()))
            .or_insert_with(|| SqlTable {
                schema: Some(schema),
                name,
                kind: if relkind == "v" || relkind == "m" {
                    SqlTableKind::View
                } else {
                    SqlTableKind::Table
                },
                columns: Vec::new(),
            });
        t.columns.push(SqlColumn {
            name: row.get(3),
            type_name: row.get(4),
            pk: row.get(5),
            enum_values: row.get(6),
        });
    }

    let mut fks = Vec::new();
    for row in client
        .query(&fks_sql(narrow), &[])
        .await
        .map_err(query_err)?
    {
        fks.push(SqlFk {
            from: SmEndpoint {
                schema: Some(row.get(0)),
                table: row.get(1),
                columns: row.get(4),
            },
            to: SmEndpoint {
                schema: Some(row.get(2)),
                table: row.get(3),
                columns: row.get(5),
            },
            name: Some(row.get(6)),
            comment: row.get(7),
        });
    }

    Ok(SqlSchema {
        search_path,
        tables: tables.into_values().collect(),
        fks,
    })
}
