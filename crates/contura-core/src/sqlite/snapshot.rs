use rusqlite::{Connection, OptionalExtension};

use super::query_err;
use super::tokens::{
    check_notes, column_collations, fk_clauses, has_word, index_parts, index_predicate,
    names_object,
};
use crate::common::quote_double;
use crate::design::{
    IncomingRef, Increment, SavedObject, SqliteExtras, TableColumn, TableDesign, TableForeignKey,
    TableIndex, add_attribute, advanced_note,
};
use crate::error::{Error, Result};
use crate::model::{DialectKind, ObjectPath};
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

fn rows<T, P, F>(conn: &Connection, sql: &str, params: P, map: F) -> Result<Vec<T>>
where
    P: rusqlite::Params,
    F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
{
    let mut stmt = conn.prepare(sql).map_err(query_err)?;
    stmt.query_map(params, map)
        .map_err(query_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(query_err)
}

/// One table for the Table Designer: the snapshot's pragmas for one table, with the
/// real index names, `fk_<id>` key names and what a rebuild must carry over.
pub(crate) fn table_design(conn: &Connection, path: &ObjectPath) -> Result<TableDesign> {
    let database = path.database.as_str();
    let master = format!("{}.sqlite_master", quote_double(database));
    let found: Option<(String, String)> = conn
        .query_row(
            &format!(
                "SELECT name, sql FROM {master} WHERE type = 'table' AND name = ?1 COLLATE NOCASE"
            ),
            [&path.name],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                ))
            },
        )
        .optional()
        .map_err(query_err)?;
    let Some((table, create_sql)) = found else {
        return Err(Error::NotFound(path.name.clone()));
    };
    let (without_rowid, strict): (bool, bool) = conn
        .query_row(
            "SELECT wr, \"strict\" FROM pragma_table_list WHERE schema = ?2 AND name = ?1",
            (&table, database),
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(query_err)?;
    let mut unsupported = Vec::new();

    let pk = pk_columns(conn, database, &table)?;
    let autoincrement = has_word(&create_sql, "AUTOINCREMENT");
    let collations = column_collations(&create_sql);
    let collation_of = |column: &str| {
        collations
            .iter()
            .find(|(c, _)| c.eq_ignore_ascii_case(column))
            .map(|(_, co)| co.clone())
    };
    let xinfo = rows(
        conn,
        "SELECT name, type, \"notnull\", dflt_value, pk, hidden FROM pragma_table_xinfo(?1, ?2) \
         WHERE hidden <> 1 ORDER BY cid",
        (&table, database),
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, bool>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
            ))
        },
    )?;
    let mut columns = Vec::with_capacity(xinfo.len());
    for (name, type_sql, not_null, default, pk_pos, hidden) in xinfo {
        let generated = hidden == 2 || hidden == 3;
        if generated {
            unsupported.push(format!("generated column {name}"));
        }
        // A single INTEGER PRIMARY KEY is the rowid alias, which SQLite fills in.
        let rowid_alias = !without_rowid
            && pk_pos > 0
            && pk.len() == 1
            && type_sql.eq_ignore_ascii_case("INTEGER");
        columns.push(TableColumn {
            type_sql,
            nullable: !not_null,
            default_sql: default.filter(|_| !generated),
            increment: if rowid_alias {
                Increment::AutoIncrement
            } else {
                Increment::None
            },
            comment: None,
            generated,
            mysql: None,
            sqlite_autoincrement: rowid_alias && autoincrement,
            collation: collation_of(&name),
            advanced: false,
            name,
        });
    }

    let mut indexes = Vec::new();
    if !pk.is_empty() {
        indexes.push(TableIndex {
            name: "primary".into(),
            columns: pk.clone(),
            unique: true,
            primary: true,
            constraint: false,
            sql: None,
            method: None,
            predicate: None,
            expression: false,
            advanced: false,
        });
    }
    let mut advanced = Vec::new();
    let list = rows(
        conn,
        &format!(
            "SELECT il.name, il.\"unique\", il.origin, m.sql FROM pragma_index_list(?1, ?2) il \
             LEFT JOIN {master} m ON m.type = 'index' AND m.name = il.name ORDER BY m.rowid, il.seq"
        ),
        (&table, database),
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, bool>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        },
    )?;
    for (name, unique, origin, sql) in list {
        if origin == "pk" {
            continue;
        }
        let keys = rows(
            conn,
            "SELECT cid, name, \"desc\", coll FROM pragma_index_xinfo(?1, ?2) WHERE key = 1 \
             ORDER BY seqno",
            (&name, database),
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, bool>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            },
        )?;
        let expression = keys.iter().any(|(cid, ..)| *cid == -2);
        let mut attrs = Vec::new();
        if keys.iter().any(|(_, _, desc, _)| *desc) {
            add_attribute(&mut attrs, "descending order");
        }
        // pragma_index_xinfo reports the collation in effect, which a plain key
        // inherits from its column; only a different one is the index's own.
        let own_collation = keys.iter().any(|(_, col, _, coll)| {
            let used = coll.as_deref().unwrap_or("BINARY");
            let inherited = col
                .as_deref()
                .and_then(collation_of)
                .unwrap_or_else(|| "BINARY".to_string());
            !used.eq_ignore_ascii_case(&inherited)
        });
        if own_collation {
            add_attribute(&mut attrs, "collation");
        }
        if !attrs.is_empty() {
            advanced.push(advanced_note("index", &name, &attrs));
        }
        let written = match (&sql, expression) {
            (Some(s), true) => index_parts(s),
            _ => Vec::new(),
        };
        let columns = keys
            .into_iter()
            .enumerate()
            .map(|(i, (_, col, ..))| col.or_else(|| written.get(i).cloned()).unwrap_or_default())
            .collect();
        indexes.push(TableIndex {
            predicate: sql.as_deref().and_then(index_predicate),
            name,
            columns,
            unique,
            primary: false,
            constraint: false,
            sql,
            method: None,
            expression,
            advanced: !attrs.is_empty(),
        });
    }

    let fk_rows = rows(
        conn,
        "SELECT id, \"table\", \"from\", \"to\", on_update, on_delete \
         FROM pragma_foreign_key_list(?1, ?2) ORDER BY id, seq",
        (&table, database),
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        },
    )?;
    let mut foreign_keys: Vec<TableForeignKey> = Vec::new();
    let mut to_pk = Vec::new();
    for (id, target, from, to, on_update, on_delete) in fk_rows {
        let name = format!("fk_{id}");
        if let Some(last) = foreign_keys.last_mut()
            && last.name == name
        {
            last.columns.push(from);
            last.target_columns.extend(to);
            continue;
        }
        if to.is_none() {
            to_pk.push(foreign_keys.len());
        }
        foreign_keys.push(TableForeignKey {
            name,
            columns: vec![from],
            target: ObjectPath {
                database: database.to_string(),
                schema: None,
                name: target,
            },
            target_columns: to.into_iter().collect(),
            on_delete: rule(on_delete),
            on_update: rule(on_update),
            advanced: false,
        });
    }
    // DEFERRABLE and MATCH are only in the saved text; pragma_foreign_key_list
    // reports neither.
    let clauses = fk_clauses(&create_sql);
    for key in &mut foreign_keys {
        let same = |a: &[String], b: &[String]| {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.eq_ignore_ascii_case(y))
        };
        let Some(clause) = clauses.iter().find(|c| {
            c.target.eq_ignore_ascii_case(&key.target.name) && same(&c.columns, &key.columns)
        }) else {
            continue;
        };
        if !clause.attributes.is_empty() {
            key.advanced = true;
            advanced.push(advanced_note("foreign key", &key.name, &clause.attributes));
        }
    }
    // Without a column list, the reference is to the target's primary key.
    for i in to_pk {
        let target = foreign_keys[i].target.name.clone();
        foreign_keys[i].target_columns = pk_columns(conn, database, &target)?;
    }

    let objects = rows(
        conn,
        &format!(
            "SELECT type, name, tbl_name, sql FROM {master} \
             WHERE type IN ('table','trigger','view') AND sql IS NOT NULL ORDER BY rowid"
        ),
        [],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        },
    )?;

    let mut referenced_by = Vec::new();
    let mut children = Vec::new();
    for (_, other, _, sql) in objects.iter().filter(|(k, ..)| k == "table") {
        let ids = rows(
            conn,
            "SELECT id, max(on_delete) FROM pragma_foreign_key_list(?1, ?2) \
             WHERE \"table\" = ?3 COLLATE NOCASE GROUP BY id ORDER BY id",
            (other, database, &table),
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        )?;
        if !ids.is_empty() && !other.eq_ignore_ascii_case(&table) {
            children.push(SavedObject {
                name: other.clone(),
                sql: sql.clone(),
            });
        }
        referenced_by.extend(ids.into_iter().map(|(id, on_delete)| IncomingRef {
            name: format!("fk_{id}"),
            table: ObjectPath {
                database: database.to_string(),
                schema: None,
                name: other.clone(),
            },
            on_delete: rule(on_delete),
        }));
    }

    let triggers: Vec<SavedObject> = objects
        .iter()
        .filter(|(k, _, on, _)| k == "trigger" && on.eq_ignore_ascii_case(&table))
        .map(|(_, name, _, sql)| SavedObject {
            name: name.clone(),
            sql: sql.clone(),
        })
        .collect();
    // Views that name the table, then views that name those, until nothing is added.
    let all_views: Vec<&(String, String, String, String)> =
        objects.iter().filter(|(k, ..)| k == "view").collect();
    let mut named = vec![table.clone()];
    let mut taken = vec![false; all_views.len()];
    loop {
        let mut added = false;
        for (i, (_, name, _, sql)) in all_views.iter().enumerate() {
            if !taken[i] && names_object(sql, &named) {
                taken[i] = true;
                named.push(name.clone());
                added = true;
            }
        }
        if !added {
            break;
        }
    }
    let views: Vec<SavedObject> = all_views
        .iter()
        .zip(&taken)
        .filter(|(_, t)| **t)
        .map(|((_, name, _, sql), _)| SavedObject {
            name: name.clone(),
            sql: sql.clone(),
        })
        .collect();
    // DROP VIEW drops the view's INSTEAD OF triggers, so a rebuild recreates them.
    let view_triggers = objects
        .iter()
        .filter(|(k, _, on, _)| {
            k == "trigger" && views.iter().any(|v| v.name.eq_ignore_ascii_case(on))
        })
        .map(|(_, name, _, sql)| SavedObject {
            name: name.clone(),
            sql: sql.clone(),
        })
        .collect();

    unsupported.extend(check_notes(&create_sql));
    unsupported.extend(triggers.iter().map(|t| format!("trigger {}", t.name)));
    unsupported.extend(advanced);
    if without_rowid {
        unsupported.push("without rowid".into());
    }
    if strict {
        unsupported.push("strict".into());
    }
    let foreign_keys_on: bool = conn
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .map_err(query_err)?;

    Ok(TableDesign {
        path: path.clone(),
        columns,
        indexes,
        foreign_keys,
        referenced_by,
        comment: None,
        unsupported,
        sqlite: Some(SqliteExtras {
            create_sql,
            triggers,
            views,
            foreign_keys_on,
            view_triggers,
            children,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ddl::{ColumnSql, column_sql};

    fn design(conn: &Connection, name: &str) -> TableDesign {
        let path = ObjectPath {
            database: "main".into(),
            schema: None,
            name: name.into(),
        };
        table_design(conn, &path).unwrap()
    }

    /// Writes a table back from its read model with the shared column writer.
    fn written(d: &TableDesign) -> String {
        let lines: Vec<String> = d
            .columns
            .iter()
            .map(|c| {
                let increment = c.increment == Increment::AutoIncrement;
                column_sql(
                    DialectKind::Sqlite,
                    &ColumnSql {
                        name: c.name.clone(),
                        type_sql: c.type_sql.clone(),
                        nullable: c.nullable,
                        default_sql: c.default_sql.clone(),
                        increment,
                        sqlite_autoincrement: c.sqlite_autoincrement,
                        primary_inline: false,
                        unique_inline: false,
                        comment: None,
                        mysql: None,
                        collation: c.collation.clone(),
                        explicit_null: false,
                    },
                )
            })
            .collect();
        format!(
            "CREATE TABLE {} ({})",
            quote_double(&d.path.name),
            lines.join(", ")
        )
    }

    #[test]
    fn rowid_alias_and_autoincrement_round_trip_through_the_writer() {
        let source = Connection::open_in_memory().unwrap();
        source
            .execute_batch(
                "CREATE TABLE plain (id INTEGER PRIMARY KEY, n int, s text COLLATE NOCASE);
                 CREATE TABLE seq (id INTEGER PRIMARY KEY AUTOINCREMENT, n int);",
            )
            .unwrap();
        let target = Connection::open_in_memory().unwrap();
        for (name, keyword) in [("plain", false), ("seq", true)] {
            let before = design(&source, name);
            assert_eq!(before.columns[0].sqlite_autoincrement, keyword, "{name}");
            if name == "plain" {
                assert_eq!(before.columns[2].collation.as_deref(), Some("NOCASE"));
            }
            let sql = written(&before);
            assert_eq!(sql.contains("AUTOINCREMENT"), keyword, "{name} wrote {sql}");
            target.execute_batch(&sql).unwrap();
            let after = design(&target, name);
            assert_eq!(after.columns, before.columns, "{name}");
            assert_eq!(after.indexes, before.indexes, "{name}");
        }
    }
}
