//! Lineage's catalog reads (B2, P6): every Foreign Key touching one schema in one query,
//! and the light column read of the tables lineage reached.

use tokio_postgres::Client;

use super::query_err;
use super::snapshot::rule;
use crate::error::Result;
use crate::lineage::{KeyColumn, KeyEdge, KeyTable};
use crate::model::ObjectPath;

/// Keys held by a table of the schema or pointing into it. `conparentid = 0` leaves out
/// the copies PostgreSQL makes on each partition of a partitioned table.
const EDGES_SQL: &str = "SELECT con.conname::text, n.nspname::text, c.relname::text, \
    fn.nspname::text, fc.relname::text, \
    ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord) \
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord), \
    ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord) \
          JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord), \
    con.confdeltype::text, con.confupdtype::text \
    FROM pg_constraint con \
    JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
    JOIN pg_class fc ON fc.oid = con.confrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace \
    WHERE con.contype = 'f' AND con.conparentid = 0 AND (n.nspname = $1 OR fn.nspname = $1) \
    ORDER BY n.nspname, c.relname, con.conname";

const TABLES_SQL: &str = "SELECT c.relname::text, a.attname::text, \
    format_type(a.atttypid, a.atttypmod), a.attnotnull, \
    COALESCE(a.attnum = ANY(pk.conkey), false) \
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
    LEFT JOIN pg_constraint pk ON pk.conrelid = c.oid AND pk.contype = 'p' \
    WHERE n.nspname = $1 AND c.relname = ANY($2) AND c.relkind IN ('r','p') \
    ORDER BY c.relname, a.attnum";

pub(super) async fn key_edges(
    client: &Client,
    database: &str,
    schema: &str,
) -> Result<Vec<KeyEdge>> {
    let path = |schema: String, name: String| ObjectPath {
        database: database.to_string(),
        schema: Some(schema),
        name,
    };
    Ok(client
        .query(EDGES_SQL, &[&schema])
        .await
        .map_err(query_err)?
        .into_iter()
        .map(|row| KeyEdge {
            name: row.get(0),
            from: path(row.get(1), row.get(2)),
            to: path(row.get(3), row.get(4)),
            from_columns: row.get(5),
            to_columns: row.get(6),
            on_delete: rule(&row.get::<_, String>(7)),
            on_update: rule(&row.get::<_, String>(8)),
        })
        .collect())
}

/// The columns of the tables among `tables` in `schema`, in table order, with their
/// primary key part. A table that is not there is left out.
pub(super) async fn key_tables(
    client: &Client,
    database: &str,
    schema: &str,
    tables: &[String],
) -> Result<Vec<KeyTable>> {
    let mut out: Vec<KeyTable> = Vec::new();
    for row in client
        .query(TABLES_SQL, &[&schema, &tables])
        .await
        .map_err(query_err)?
    {
        let table: String = row.get(0);
        let column = KeyColumn {
            name: row.get(1),
            ty: row.get(2),
            nullable: !row.get::<_, bool>(3),
            pk: row.get(4),
        };
        match out.last_mut() {
            Some(last) if last.path.name == table => last.columns.push(column),
            _ => out.push(KeyTable {
                path: ObjectPath {
                    database: database.to_string(),
                    schema: Some(schema.to_string()),
                    name: table,
                },
                columns: vec![column],
            }),
        }
    }
    Ok(out)
}

/// Views and materialized views whose rewrite rule depends on the table, from `pg_depend`:
/// the server's own record of what each view reads, not a match on its text.
const VIEWS_SQL: &str = "SELECT DISTINCT vn.nspname::text, v.relname::text \
    FROM pg_depend d \
    JOIN pg_rewrite r ON r.oid = d.objid \
    JOIN pg_class v ON v.oid = r.ev_class JOIN pg_namespace vn ON vn.oid = v.relnamespace \
    JOIN pg_class t ON t.oid = d.refobjid JOIN pg_namespace tn ON tn.oid = t.relnamespace \
    WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass \
      AND v.relkind IN ('v', 'm') AND v.oid <> t.oid \
      AND tn.nspname = $1 AND t.relname = $2 \
    ORDER BY 1, 2 LIMIT $3";

/// The views that read `table`, at most `limit`.
pub(super) async fn view_dependencies(
    client: &Client,
    table: &ObjectPath,
    schema: &str,
    limit: usize,
) -> Result<Vec<ObjectPath>> {
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    Ok(client
        .query(VIEWS_SQL, &[&schema, &table.name, &limit])
        .await
        .map_err(query_err)?
        .into_iter()
        .map(|row| ObjectPath {
            database: table.database.clone(),
            schema: Some(row.get(0)),
            name: row.get(1),
        })
        .collect())
}
