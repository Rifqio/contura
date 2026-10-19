use rusqlite::{Connection, OptionalExtension};

use super::query_err;
use crate::common::{quote_double, sort_objects};
use crate::error::{Error, Result};
use crate::model::{DbObject, ObjectKind, ObjectPath};

pub fn list_databases(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn
        .prepare("SELECT name FROM pragma_database_list WHERE name <> 'temp' ORDER BY seq")
        .map_err(query_err)?;
    stmt.query_map([], |r| r.get(0))
        .map_err(query_err)?
        .collect::<std::result::Result<_, _>>()
        .map_err(query_err)
}

pub fn list_objects(conn: &Connection, database: &str) -> Result<Vec<DbObject>> {
    let sql = format!(
        "SELECT type, name FROM {}.sqlite_master \
         WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
        quote_double(database)
    );
    let mut stmt = conn.prepare(&sql).map_err(query_err)?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(query_err)?
        .collect::<std::result::Result<_, _>>()
        .map_err(query_err)?;
    let mut objects: Vec<DbObject> = rows
        .into_iter()
        .filter_map(|(kind, name)| {
            let kind = match kind.as_str() {
                "table" => ObjectKind::Table,
                "view" => ObjectKind::View,
                "trigger" => ObjectKind::Trigger,
                _ => return None,
            };
            Some(DbObject {
                kind,
                name,
                rows: None,
                bytes: None,
            })
        })
        .collect();
    sort_objects(&mut objects);
    Ok(objects)
}

pub fn object_definition(conn: &Connection, kind: ObjectKind, path: &ObjectPath) -> Result<String> {
    let type_name = match kind {
        ObjectKind::Table => "table",
        ObjectKind::View => "view",
        ObjectKind::Trigger => "trigger",
        ObjectKind::Procedure | ObjectKind::Function => {
            return Err(Error::InvalidInput("SQLite has no stored routines".into()));
        }
    };
    let sql = format!(
        "SELECT sql FROM {}.sqlite_master WHERE type = ?1 AND name = ?2",
        quote_double(&path.database)
    );
    let found: Option<Option<String>> = conn
        .query_row(&sql, [type_name, path.name.as_str()], |r| r.get(0))
        .optional()
        .map_err(query_err)?;
    found
        .flatten()
        .ok_or_else(|| Error::NotFound(format!("{type_name} {} not found", path.name)))
}
