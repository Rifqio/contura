//! Lineage's catalog reads: every Foreign Key of one database, with
//! `pragma_foreign_key_list` read once per table, and the light column read of the tables
//! lineage reached. Table names resolve without regard to case, as SQLite resolves them.

use rusqlite::Connection;

use super::query_err;
use super::snapshot::rule;
use crate::common::quote_double;
use crate::error::Result;
use crate::lineage::{KeyColumn, KeyEdge, KeyTable};
use crate::model::ObjectPath;

fn path(database: &str, name: String) -> ObjectPath {
    ObjectPath {
        database: database.to_string(),
        schema: None,
        name,
    }
}

/// The tables of `database` as `sqlite_master` spells them.
fn table_names(conn: &Connection, database: &str) -> Result<Vec<String>> {
    let master = format!("{}.sqlite_master", quote_double(database));
    let mut stmt = conn
        .prepare(&format!(
            "SELECT name FROM {master} WHERE type = 'table' \
             AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
        ))
        .map_err(query_err)?;
    stmt.query_map([], |r| r.get(0))
        .map_err(query_err)?
        .collect::<rusqlite::Result<Vec<String>>>()
        .map_err(query_err)
}

fn resolve<'a>(names: &'a [String], name: &str) -> Option<&'a String> {
    names.iter().find(|n| n.eq_ignore_ascii_case(name))
}

fn pk_columns(conn: &Connection, database: &str, table: &str) -> Result<Vec<String>> {
    let mut stmt = conn
        .prepare_cached("SELECT name FROM pragma_table_info(?1, ?2) WHERE pk > 0 ORDER BY pk")
        .map_err(query_err)?;
    stmt.query_map((table, database), |r| r.get(0))
        .map_err(query_err)?
        .collect::<rusqlite::Result<Vec<String>>>()
        .map_err(query_err)
}

/// Every Foreign Key of `database`. A target names the table as `sqlite_master` spells it,
/// or as written when there is no such table; a key without a column list points to the
/// target's primary key.
pub(super) fn key_edges(conn: &Connection, database: &str) -> Result<Vec<KeyEdge>> {
    let names = table_names(conn, database)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, \"table\", \"from\", \"to\", on_update, on_delete \
             FROM pragma_foreign_key_list(?1, ?2) ORDER BY id, seq",
        )
        .map_err(query_err)?;
    let mut out: Vec<KeyEdge> = Vec::new();
    for table in &names {
        type Row = (i64, String, String, Option<String>, String, String);
        let rows = stmt
            .query_map((table, database), |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })
            .map_err(query_err)?
            .collect::<rusqlite::Result<Vec<Row>>>()
            .map_err(query_err)?;
        let first = out.len();
        let mut to_pk = Vec::new();
        for (id, target, from, to, on_update, on_delete) in rows {
            let name = format!("fk_{id}");
            if out.len() > first
                && let Some(last) = out.last_mut()
                && last.name == name
            {
                last.from_columns.push(from);
                last.to_columns.extend(to);
                continue;
            }
            if to.is_none() {
                to_pk.push(out.len());
            }
            let target = resolve(&names, &target).cloned().unwrap_or(target);
            out.push(KeyEdge {
                name,
                from: path(database, table.clone()),
                from_columns: vec![from],
                to: path(database, target),
                to_columns: to.into_iter().collect(),
                on_delete: rule(on_delete),
                on_update: rule(on_update),
            });
        }
        for i in to_pk {
            let target = out[i].to.name.clone();
            out[i].to_columns = pk_columns(conn, database, &target)?;
        }
    }
    Ok(out)
}

/// The columns of the tables among `tables` in `database`, in table order, with their
/// primary key part, under the names `sqlite_master` gives them. A table that is not
/// there is left out.
pub(super) fn key_tables(
    conn: &Connection,
    database: &str,
    tables: &[String],
) -> Result<Vec<KeyTable>> {
    let names = table_names(conn, database)?;
    let mut stmt = conn
        .prepare(
            "SELECT name, type, \"notnull\", pk FROM pragma_table_xinfo(?1, ?2) \
             WHERE hidden <> 1 ORDER BY cid",
        )
        .map_err(query_err)?;
    let mut out: Vec<KeyTable> = Vec::new();
    for wanted in tables {
        let Some(table) = resolve(&names, wanted) else {
            continue;
        };
        if out.iter().any(|t| &t.path.name == table) {
            continue;
        }
        let columns = stmt
            .query_map((table, database), |r| {
                Ok(KeyColumn {
                    name: r.get(0)?,
                    ty: r.get(1)?,
                    nullable: !r.get::<_, bool>(2)?,
                    pk: r.get::<_, i64>(3)? > 0,
                })
            })
            .map_err(query_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(query_err)?;
        out.push(KeyTable {
            path: path(database, table.clone()),
            columns,
        });
    }
    Ok(out)
}
