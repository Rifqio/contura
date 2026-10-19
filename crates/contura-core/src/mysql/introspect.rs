use mysql_async::prelude::Queryable;
use mysql_async::{Pool, Row};

use super::query_err;
use super::quote::quote_ident;
use crate::common::sort_objects;
use crate::error::{Error, Result};
use crate::model::{DbObject, ObjectKind, ObjectPath};

pub async fn list_databases(pool: &Pool) -> Result<Vec<String>> {
    let mut conn = pool.get_conn().await.map_err(query_err)?;
    let mut names: Vec<String> = conn
        .query("SELECT CAST(SCHEMA_NAME AS CHAR) FROM information_schema.SCHEMATA")
        .await
        .map_err(query_err)?;
    names.sort();
    Ok(names)
}

pub async fn list_objects(pool: &Pool, database: &str) -> Result<Vec<DbObject>> {
    let mut conn = pool.get_conn().await.map_err(query_err)?;
    let tables: Vec<(String, String, Option<u64>, Option<u64>)> = conn
        .exec(
            "SELECT CAST(TABLE_NAME AS CHAR), CAST(TABLE_TYPE AS CHAR), TABLE_ROWS, \
             DATA_LENGTH + INDEX_LENGTH \
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
            (database,),
        )
        .await
        .map_err(query_err)?;
    let routines: Vec<(String, String)> = conn
        .exec(
            "SELECT CAST(ROUTINE_NAME AS CHAR), CAST(ROUTINE_TYPE AS CHAR) \
             FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?",
            (database,),
        )
        .await
        .map_err(query_err)?;
    let triggers: Vec<String> = conn
        .exec(
            "SELECT CAST(TRIGGER_NAME AS CHAR) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?",
            (database,),
        )
        .await
        .map_err(query_err)?;

    let mut objects = Vec::new();
    for (name, table_type, table_rows, table_bytes) in tables {
        let (kind, rows, bytes) = match table_type.as_str() {
            "BASE TABLE" => (ObjectKind::Table, table_rows, table_bytes),
            "VIEW" | "SYSTEM VIEW" => (ObjectKind::View, None, None),
            _ => continue,
        };
        objects.push(DbObject {
            kind,
            name,
            rows,
            bytes,
        });
    }
    for (name, routine_type) in routines {
        let kind = match routine_type.as_str() {
            "PROCEDURE" => ObjectKind::Procedure,
            "FUNCTION" => ObjectKind::Function,
            _ => continue,
        };
        objects.push(DbObject {
            kind,
            name,
            rows: None,
            bytes: None,
        });
    }
    objects.extend(triggers.into_iter().map(|name| DbObject {
        kind: ObjectKind::Trigger,
        name,
        rows: None,
        bytes: None,
    }));
    sort_objects(&mut objects);
    Ok(objects)
}

pub async fn object_definition(pool: &Pool, kind: ObjectKind, path: &ObjectPath) -> Result<String> {
    let (keyword, column) = match kind {
        ObjectKind::Table => ("TABLE", "Create Table"),
        ObjectKind::View => ("VIEW", "Create View"),
        ObjectKind::Procedure => ("PROCEDURE", "Create Procedure"),
        ObjectKind::Function => ("FUNCTION", "Create Function"),
        ObjectKind::Trigger => ("TRIGGER", "SQL Original Statement"),
    };
    let sql = format!(
        "SHOW CREATE {keyword} {}.{}",
        quote_ident(&path.database),
        quote_ident(&path.name)
    );
    let mut conn = pool.get_conn().await.map_err(query_err)?;
    let row: Row = conn
        .query_first(sql)
        .await
        .map_err(query_err)?
        .ok_or_else(|| Error::NotFound(format!("{} not found", path.name)))?;
    let definition: Option<String> = row
        .get_opt::<Option<String>, _>(column)
        .ok_or_else(|| {
            Error::Query(format!(
                "SHOW CREATE {keyword} returned no `{column}` column"
            ))
        })?
        .map_err(|e| Error::Query(e.to_string()))?;
    definition.ok_or_else(|| Error::NotFound("definition not visible to this user".into()))
}
