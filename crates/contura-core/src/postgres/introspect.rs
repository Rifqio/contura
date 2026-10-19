//! Databases, schemas, objects and their definitions, from the Postgres catalogs.
//!
//! Function and trigger names are not unique inside a schema, so their listed
//! names carry what tells them apart: `add(a integer, b integer)` and
//! `audit on orders`. `definition` recomputes the same strings in its `WHERE`.

use tokio_postgres::Client;

use super::query_err;
use crate::common::{quote_double, sort_objects};
use crate::error::{Error, Result};
use crate::model::{DbObject, ObjectKind, ObjectPath, SchemaInfo};

pub(super) async fn list_databases(client: &Client) -> Result<Vec<String>> {
    let rows = client
        .query(
            "SELECT datname::text FROM pg_database \
             WHERE datallowconn AND NOT datistemplate \
               AND has_database_privilege(datname, 'CONNECT') \
             ORDER BY datname",
            &[],
        )
        .await
        .map_err(query_err)?;
    rows.iter()
        .map(|r| r.try_get(0).map_err(query_err))
        .collect()
}

pub(super) async fn list_schemas(client: &Client) -> Result<Vec<SchemaInfo>> {
    let rows = client
        .query(
            "SELECT nspname::text FROM pg_namespace \
             WHERE has_schema_privilege(oid, 'USAGE') \
             ORDER BY nspname",
            &[],
        )
        .await
        .map_err(query_err)?;
    rows.iter()
        .map(|r| {
            let name: String = r.try_get(0).map_err(query_err)?;
            let is_system = name == "information_schema" || name.starts_with("pg_");
            Ok(SchemaInfo { name, is_system })
        })
        .collect()
}

const OBJECTS_SQL: &str = "\
SELECT CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END, c.relname::text, CASE WHEN c.relkind IN ('r', 'p', 'f') AND c.reltuples >= 0 THEN c.reltuples::bigint END, \
       CASE WHEN c.relkind IN ('r', 'p') THEN pg_total_relation_size(c.oid) END \
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
 WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'f', 'v', 'm') \
UNION ALL \
SELECT CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END, \
       format('%s(%s)', p.proname, pg_get_function_identity_arguments(p.oid)), NULL::bigint, NULL::bigint \
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
 WHERE n.nspname = $1 AND p.prokind IN ('f', 'p') \
UNION ALL \
SELECT 'trigger', format('%s on %s', t.tgname, c.relname), NULL::bigint, NULL::bigint \
  FROM pg_trigger t \
  JOIN pg_class c ON c.oid = t.tgrelid \
  JOIN pg_namespace n ON n.oid = c.relnamespace \
 WHERE n.nspname = $1 AND NOT t.tgisinternal";

pub(super) async fn list_objects(client: &Client, schema: Option<&str>) -> Result<Vec<DbObject>> {
    let schema = schema.ok_or_else(|| Error::InvalidInput("choose a schema".into()))?;
    let rows = client
        .query(OBJECTS_SQL, &[&schema])
        .await
        .map_err(query_err)?;
    let mut objects = Vec::with_capacity(rows.len());
    for row in &rows {
        let kind: String = row.try_get(0).map_err(query_err)?;
        let name: String = row.try_get(1).map_err(query_err)?;
        let kind = match kind.as_str() {
            "table" => ObjectKind::Table,
            "view" => ObjectKind::View,
            "procedure" => ObjectKind::Procedure,
            "function" => ObjectKind::Function,
            _ => ObjectKind::Trigger,
        };
        let rows: Option<i64> = row.try_get(2).map_err(query_err)?;
        let bytes: Option<i64> = row.try_get(3).map_err(query_err)?;
        objects.push(DbObject {
            kind,
            name,
            rows: rows.map(|n| n as u64),
            bytes: bytes.map(|n| n as u64),
        });
    }
    sort_objects(&mut objects);
    Ok(objects)
}

const VIEW_SQL: &str = "\
SELECT c.relkind::text, pg_get_viewdef(c.oid, true) \
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
 WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('v', 'm')";

const ROUTINE_SQL: &str = "\
SELECT pg_get_functiondef(p.oid) \
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
 WHERE n.nspname = $1 AND p.prokind::text = $3 \
   AND format('%s(%s)', p.proname, pg_get_function_identity_arguments(p.oid)) = $2";

const TRIGGER_SQL: &str = "\
SELECT pg_get_triggerdef(t.oid, true) \
  FROM pg_trigger t \
  JOIN pg_class c ON c.oid = t.tgrelid \
  JOIN pg_namespace n ON n.oid = c.relnamespace \
 WHERE n.nspname = $1 AND NOT t.tgisinternal \
   AND format('%s on %s', t.tgname, c.relname) = $2";

pub(super) async fn definition(
    client: &Client,
    kind: ObjectKind,
    path: &ObjectPath,
) -> Result<String> {
    if kind == ObjectKind::Table {
        return Err(Error::InvalidInput(
            "Postgres table definitions are not available yet".into(),
        ));
    }
    let schema = path
        .schema
        .as_deref()
        .ok_or_else(|| Error::InvalidInput("choose a schema".into()))?;
    let name = path.name.as_str();
    let row = match kind {
        ObjectKind::View => client.query_opt(VIEW_SQL, &[&schema, &name]).await,
        ObjectKind::Function => {
            client
                .query_opt(ROUTINE_SQL, &[&schema, &name, &"f".to_string()])
                .await
        }
        ObjectKind::Procedure => {
            client
                .query_opt(ROUTINE_SQL, &[&schema, &name, &"p".to_string()])
                .await
        }
        _ => client.query_opt(TRIGGER_SQL, &[&schema, &name]).await,
    }
    .map_err(query_err)?
    .ok_or_else(|| Error::NotFound(format!("{name} in {schema}")))?;
    if kind == ObjectKind::View {
        let relkind: String = row.try_get(0).map_err(query_err)?;
        let body: String = row.try_get(1).map_err(query_err)?;
        let create = if relkind == "m" {
            "CREATE MATERIALIZED VIEW"
        } else {
            "CREATE VIEW"
        };
        return Ok(format!(
            "{create} {}.{} AS\n{body}",
            quote_double(schema),
            quote_double(name)
        ));
    }
    row.try_get(0).map_err(query_err)
}
