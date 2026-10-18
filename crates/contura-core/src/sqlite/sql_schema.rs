use rusqlite::Connection;

use super::query_err;
use super::tokens::fk_clauses;
use crate::common::quote_double;
use crate::error::Result;
use crate::schema_model::SmEndpoint;
use crate::sql_schema::{SqlColumn, SqlFk, SqlSchema, SqlTable, SqlTableKind};

fn endpoint(table: &str, columns: Vec<String>) -> SmEndpoint {
    SmEndpoint {
        schema: Some("main".into()),
        table: table.to_string(),
        columns,
    }
}

pub(super) fn sql_schema(conn: &Connection, database: &str) -> Result<SqlSchema> {
    let master = format!("{}.sqlite_master", quote_double(database));
    let mut stmt = conn
        .prepare(&format!(
            "SELECT type, name, sql FROM {master} WHERE type IN ('table','view') \
             AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
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
    let mut fks: Vec<SqlFk> = Vec::new();
    for (kind, name, create_sql) in objects {
        let mut cols = conn
            .prepare("SELECT name, type, pk FROM pragma_table_info(?1, ?2) ORDER BY cid")
            .map_err(query_err)?;
        let columns = cols
            .query_map((&name, database), |r| {
                Ok(SqlColumn {
                    name: r.get(0)?,
                    type_name: r.get(1)?,
                    pk: r.get::<_, i64>(2)? > 0,
                })
            })
            .map_err(query_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(query_err)?;
        let is_table = kind == "table";
        if is_table {
            let mut stmt = conn
                .prepare(
                    "SELECT id, \"table\", \"from\", \"to\" FROM pragma_foreign_key_list(?1, ?2) \
                     ORDER BY id, seq",
                )
                .map_err(query_err)?;
            let rows = stmt
                .query_map((&name, database), |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                    ))
                })
                .map_err(query_err)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(query_err)?;
            let first = fks.len();
            let mut last_id = None;
            for (id, ref_table, from, to) in rows {
                // A missing target column means the parent's primary key.
                let to = to.unwrap_or_default();
                match fks.last_mut() {
                    Some(fk) if last_id == Some(id) => {
                        fk.from.columns.push(from);
                        fk.to.columns.push(to);
                    }
                    _ => {
                        last_id = Some(id);
                        fks.push(SqlFk {
                            from: endpoint(&name, vec![from]),
                            to: endpoint(&ref_table, vec![to]),
                            name: None,
                            // SQLite keeps no comments.
                            comment: None,
                        });
                    }
                }
            }
            // pragma_foreign_key_list has no names; a `CONSTRAINT` name is only in the text.
            let clauses = fk_clauses(create_sql.as_deref().unwrap_or_default());
            for fk in &mut fks[first..] {
                let same = |a: &[String], b: &[String]| {
                    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.eq_ignore_ascii_case(y))
                };
                fk.name = clauses
                    .iter()
                    .find(|c| {
                        c.target.eq_ignore_ascii_case(&fk.to.table)
                            && same(&c.columns, &fk.from.columns)
                    })
                    .and_then(|c| c.name.clone());
            }
        }
        tables.push(SqlTable {
            schema: Some("main".into()),
            name,
            kind: if is_table {
                SqlTableKind::Table
            } else {
                SqlTableKind::View
            },
            columns,
        });
    }
    Ok(SqlSchema {
        search_path: vec!["main".into()],
        tables,
        fks,
    })
}
