use rusqlite::Connection;

use super::query_err;
use crate::common::quote_double;
use crate::error::Result;
use crate::model::DialectKind;
use crate::schema_model::{
    SchemaModel, SmColumn, SmEndpoint, SmIndex, SmRef, SmTable, parse_sql_default,
};

fn rule(r: String) -> Option<String> {
    (r != "NO ACTION").then_some(r)
}

fn index_columns(conn: &Connection, database: &str, index: &str) -> Result<Vec<String>> {
    let mut stmt = conn
        .prepare("SELECT name FROM pragma_index_info(?1, ?2) ORDER BY seqno")
        .map_err(query_err)?;
    let cols = stmt
        .query_map((index, database), |r| r.get::<_, Option<String>>(0))
        .map_err(query_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(query_err)?;
    // An expression index has NULL column names.
    Ok(cols.into_iter().flatten().collect())
}

fn pk_columns(conn: &Connection, database: &str, table: &str) -> Result<Vec<String>> {
    let mut stmt = conn
        .prepare("SELECT name FROM pragma_table_info(?1, ?2) WHERE pk > 0 ORDER BY pk")
        .map_err(query_err)?;
    stmt.query_map((table, database), |r| r.get(0))
        .map_err(query_err)?
        .collect::<rusqlite::Result<Vec<String>>>()
        .map_err(query_err)
}

pub(super) fn schema_snapshot(conn: &Connection, database: &str) -> Result<SchemaModel> {
    let master = format!("{}.sqlite_master", quote_double(database));
    let mut skipped = Vec::new();
    let mut stmt = conn
        .prepare(&format!(
            "SELECT type, name, sql FROM {master} WHERE type IN ('table','view','trigger') \
             AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid"
        ))
        .map_err(query_err)?;
    let objects = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(query_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(query_err)?;

    let mut tables = Vec::new();
    let mut refs = Vec::new();
    for (kind, name, _sql) in objects {
        if kind != "table" {
            skipped.push(format!("{kind} {name}"));
            continue;
        }
        let pk = pk_columns(conn, database, &name)?;
        let mut cols_stmt = conn
            .prepare("SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?1, ?2) ORDER BY cid")
            .map_err(query_err)?;
        let mut columns = cols_stmt
            .query_map((&name, database), |r| {
                let col_name: String = r.get(0)?;
                let type_name: String = r.get(1)?;
                let not_null: bool = r.get(2)?;
                let default: Option<String> = r.get(3)?;
                let pk_pos: i64 = r.get(4)?;
                Ok((col_name, type_name, not_null, default, pk_pos))
            })
            .map_err(query_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(query_err)?
            .into_iter()
            .map(|(col_name, type_name, not_null, default, pk_pos)| {
                let single_pk = pk_pos > 0 && pk.len() == 1;
                let rowid_alias = single_pk && type_name.eq_ignore_ascii_case("INTEGER");
                SmColumn {
                    name: col_name,
                    // A single INTEGER PRIMARY KEY is the rowid alias, which SQLite fills in.
                    increment: rowid_alias,
                    type_name,
                    pk: single_pk,
                    not_null,
                    unique: false,
                    default: default.as_deref().map(parse_sql_default),
                    note: None,
                }
            })
            .collect::<Vec<_>>();

        let mut indexes = Vec::new();
        if pk.len() > 1 {
            indexes.push(SmIndex {
                name: None,
                columns: pk.clone(),
                unique: true,
                pk: true,
            });
        }
        let mut idx_stmt = conn
            .prepare(
                "SELECT name, \"unique\", origin FROM pragma_index_list(?1, ?2) ORDER BY seq DESC",
            )
            .map_err(query_err)?;
        let list = idx_stmt
            .query_map((&name, database), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, bool>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(query_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(query_err)?;
        for (index, unique, origin) in list {
            if origin == "pk" {
                continue;
            }
            let cols = index_columns(conn, database, &index)?;
            if cols.is_empty() {
                skipped.push(format!("expression index {index}"));
                continue;
            }
            if unique && cols.len() == 1 {
                if let Some(c) = columns.iter_mut().find(|c| c.name == cols[0]) {
                    c.unique = true;
                }
                continue;
            }
            indexes.push(SmIndex {
                name: (!index.starts_with("sqlite_autoindex_")).then_some(index),
                columns: cols,
                unique,
                pk: false,
            });
        }

        let mut fk_stmt = conn
            .prepare(
                "SELECT id, \"table\", \"from\", \"to\", on_update, on_delete \
                 FROM pragma_foreign_key_list(?1, ?2) ORDER BY id, seq",
            )
            .map_err(query_err)?;
        let fks = fk_stmt
            .query_map((&name, database), |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .map_err(query_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(query_err)?;
        let mut last_id = None;
        for (id, target, from, to, on_update, on_delete) in fks {
            if last_id == Some(id) {
                let r: &mut SmRef = refs.last_mut().expect("same id as the last ref");
                r.from.columns.push(from);
                if let Some(to) = to {
                    r.to.columns.push(to);
                }
                continue;
            }
            last_id = Some(id);
            // Without a column list, the reference is to the target's primary key.
            let to_cols = match to {
                Some(c) => vec![c],
                None => pk_columns(conn, database, &target)?,
            };
            refs.push(SmRef {
                name: None,
                from: SmEndpoint {
                    schema: None,
                    table: name.clone(),
                    columns: vec![from],
                },
                to: SmEndpoint {
                    schema: None,
                    table: target,
                    columns: to_cols,
                },
                on_delete: rule(on_delete),
                on_update: rule(on_update),
            });
        }

        indexes.reverse();
        tables.push(SmTable {
            schema: None,
            name,
            alias: None,
            note: None,
            columns,
            indexes,
        });
    }

    Ok(SchemaModel {
        dialect: DialectKind::Sqlite,
        tables,
        refs,
        enums: Vec::new(),
        skipped,
    })
}
