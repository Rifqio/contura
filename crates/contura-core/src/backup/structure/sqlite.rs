//! SQLite structure (spec "Per-Dialect rules", SQLite): `sqlite_master.sql` verbatim, so
//! `WITHOUT ROWID`, `STRICT`, checks and generated columns come as written. Tables before
//! the rows; then the `sqlite_sequence` counters, indexes, views and triggers after them;
//! `PRAGMA user_version` last. Virtual tables and their shadow tables are not included,
//! and neither are the indexes, triggers and views on them.
//!
//! rusqlite is synchronous, so this writer is too; the Backup job calls it on the thread
//! that holds the read transaction.

use rusqlite::Connection;

use super::StructureKind as K;
use super::{ContentCounts, StructureItem, StructureParts, terminated};
use crate::common::sql_string;
use crate::error::Result;
use crate::model::DialectKind;
use crate::sqlite::query_err;
use crate::sqlite::tokens::{check_notes, names_object};

pub const SETTINGS: &[&str] = &["PRAGMA foreign_keys = OFF;"];

/// One `sqlite_master` row.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SqObject {
    pub name: String,
    /// `tbl_name`: the table an index or trigger is on; a view's own name.
    pub table: String,
    pub sql: String,
}

impl SqObject {
    pub fn new(name: &str, table: &str, sql: &str) -> Self {
        Self {
            name: name.into(),
            table: table.into(),
            sql: sql.into(),
        }
    }
}

/// What the catalog reads give, before any statement is built.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SqCatalog {
    /// Name and `sqlite_master.sql`, in `sqlite_master` order.
    pub tables: Vec<(String, String)>,
    /// Indexes made by `CREATE INDEX`, in order.
    pub indexes: Vec<SqObject>,
    pub views: Vec<SqObject>,
    pub triggers: Vec<SqObject>,
    /// `sqlite_sequence` rows: table and counter.
    pub sequences: Vec<(String, i64)>,
    pub user_version: i64,
    /// Virtual tables and shadow tables, by name.
    pub virtual_tables: Vec<String>,
    pub shadow_tables: Vec<String>,
    /// Foreign Keys and generated columns; the rest are counted from the lists.
    pub counts: ContentCounts,
}

/// Reads the structure on `conn`, inside the backup's read transaction.
pub fn read_structure(conn: &Connection) -> Result<StructureParts> {
    Ok(build(read_catalog(conn)?))
}

pub fn build(c: SqCatalog) -> StructureParts {
    let before_rows = c
        .tables
        .iter()
        .map(|(name, sql)| StructureItem::on(K::Table, name, terminated(sql)))
        .collect();

    let mut not_included: Vec<String> = c
        .virtual_tables
        .iter()
        .map(|t| format!("virtual table {t}"))
        .collect();
    not_included.extend(c.shadow_tables.iter().map(|t| format!("shadow table {t}")));

    // What stands on a table the Backup leaves out is left out too.
    let mut left_out: Vec<String> = c
        .virtual_tables
        .iter()
        .chain(&c.shadow_tables)
        .cloned()
        .collect();
    let mut views = Vec::new();
    for v in &c.views {
        if names_object(&v.sql, &left_out) {
            not_included.push(format!("view {}", v.name));
            left_out.push(v.name.clone());
        } else {
            views.push(v);
        }
    }
    let mut kept = |what: &str, objects: &[SqObject]| -> Vec<SqObject> {
        let mut out = Vec::new();
        for o in objects {
            if left_out.contains(&o.table) {
                not_included.push(format!("{what} {}", o.name));
            } else {
                out.push(o.clone());
            }
        }
        out
    };
    let indexes = kept("index", &c.indexes);
    let triggers = kept("trigger", &c.triggers);

    let mut after_rows = Vec::new();
    for (table, seq) in &c.sequences {
        let name = sql_string(DialectKind::Sqlite, table);
        after_rows.push(StructureItem::on(
            K::Setval,
            table,
            format!("DELETE FROM \"sqlite_sequence\" WHERE name = {name};"),
        ));
        after_rows.push(StructureItem::on(
            K::Setval,
            table,
            format!("INSERT INTO \"sqlite_sequence\" (name, seq) VALUES ({name}, {seq});"),
        ));
    }
    after_rows.extend(
        indexes
            .iter()
            .map(|i| StructureItem::on(K::Index, &i.table, terminated(&i.sql))),
    );
    after_rows.extend(
        views
            .iter()
            .map(|v| StructureItem::new(K::View, terminated(&v.sql))),
    );
    after_rows.extend(
        triggers
            .iter()
            .map(|t| StructureItem::on(K::Trigger, &t.table, terminated(&t.sql))),
    );

    let counts = ContentCounts {
        tables: c.tables.len() as u32,
        indexes: indexes.len() as u32,
        views: views.len() as u32,
        triggers: triggers.len() as u32,
        sequences: c.sequences.len() as u32,
        checks: c
            .tables
            .iter()
            .map(|(_, sql)| check_notes(sql).len() as u32)
            .sum(),
        ..c.counts
    };

    StructureParts {
        settings: SETTINGS
            .iter()
            .map(|s| StructureItem::new(K::Setting, *s))
            .collect(),
        before_rows,
        after_rows,
        finish: vec![StructureItem::new(
            K::UserVersion,
            format!("PRAGMA user_version = {};", c.user_version),
        )],
        not_included,
        counts,
        tables: c.tables.into_iter().map(|(name, _)| name).collect(),
        definer_removed: false,
    }
}

pub fn read_catalog(conn: &Connection) -> Result<SqCatalog> {
    // `PRAGMA table_list` tells virtual and shadow tables from ordinary ones.
    let mut kinds = std::collections::HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT name, type FROM pragma_table_list WHERE schema = 'main'")
            .map_err(query_err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(query_err)?;
        for row in rows {
            let (name, kind) = row.map_err(query_err)?;
            kinds.insert(name, kind);
        }
    }

    let master: Vec<(String, String, String, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT type, name, tbl_name, sql FROM main.sqlite_master \
                 WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
                 ORDER BY rowid",
            )
            .map_err(query_err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .map_err(query_err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(query_err)?
    };

    let mut c = SqCatalog::default();
    for (kind, name, table, sql) in master {
        match kind.as_str() {
            "table" => match kinds.get(&name).map(String::as_str) {
                Some("virtual") => c.virtual_tables.push(name),
                Some("shadow") => c.shadow_tables.push(name),
                _ => c.tables.push((name, sql)),
            },
            "index" => c.indexes.push(SqObject { name, table, sql }),
            "view" => c.views.push(SqObject { name, table, sql }),
            "trigger" => c.triggers.push(SqObject { name, table, sql }),
            _ => {}
        }
    }

    let has_sequence: bool = conn
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM main.sqlite_master \
             WHERE type = 'table' AND name = 'sqlite_sequence')",
            [],
            |r| r.get(0),
        )
        .map_err(query_err)?;
    if has_sequence {
        let mut stmt = conn
            .prepare("SELECT name, seq FROM main.sqlite_sequence ORDER BY rowid")
            .map_err(query_err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(query_err)?;
        for row in rows {
            let (name, seq) = row.map_err(query_err)?;
            if c.tables.iter().any(|(t, _)| t == &name) {
                c.sequences.push((name, seq));
            }
        }
    }

    c.user_version = conn
        .query_row("PRAGMA main.user_version", [], |r| r.get(0))
        .map_err(query_err)?;

    for (table, _) in &c.tables {
        let fks: u32 = conn
            .query_row(
                &format!(
                    "SELECT COUNT(DISTINCT id) FROM pragma_foreign_key_list({})",
                    sql_string(DialectKind::Sqlite, table)
                ),
                [],
                |r| r.get(0),
            )
            .map_err(query_err)?;
        let generated: u32 = conn
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM pragma_table_xinfo({}) WHERE hidden IN (2, 3)",
                    sql_string(DialectKind::Sqlite, table)
                ),
                [],
                |r| r.get(0),
            )
            .map_err(query_err)?;
        c.counts.foreign_keys += fks;
        c.counts.generated += generated;
    }
    Ok(c)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::structure::texts;

    fn fixture() -> SqCatalog {
        SqCatalog {
            tables: vec![
                (
                    "b".into(),
                    "CREATE TABLE b (id INTEGER PRIMARY KEY AUTOINCREMENT, a_id INTEGER REFERENCES a(id), \
                     n INT CHECK (n > 0), twice INT GENERATED ALWAYS AS (n * 2) STORED)"
                        .into(),
                ),
                (
                    "a".into(),
                    "CREATE TABLE a (id INTEGER PRIMARY KEY, b_id INTEGER REFERENCES b(id)) STRICT".into(),
                ),
            ],
            indexes: vec![SqObject::new("b_n", "b", "CREATE INDEX b_n ON b (n)")],
            views: vec![
                SqObject::new("v_base", "v_base", "CREATE VIEW v_base AS SELECT id FROM a"),
                SqObject::new("v_top", "v_top", "CREATE VIEW v_top AS SELECT id FROM v_base"),
            ],
            triggers: vec![SqObject::new(
                "tr",
                "a",
                "CREATE TRIGGER tr AFTER INSERT ON a BEGIN UPDATE b SET n = n + 1; END",
            )],
            sequences: vec![("b".into(), 41)],
            user_version: 7,
            virtual_tables: vec!["docs".into()],
            shadow_tables: vec!["docs_data".into()],
            counts: ContentCounts {
                foreign_keys: 2,
                generated: 1,
                ..ContentCounts::default()
            },
        }
    }

    #[test]
    fn verbatim_in_the_spec_order() {
        let p = build(fixture());
        assert_eq!(texts(&p.settings), ["PRAGMA foreign_keys = OFF;"]);
        assert_eq!(p.settings[0].kind, K::Setting);
        assert_eq!(p.tables, ["b", "a"]);
        assert_eq!(
            p.before_rows[1],
            StructureItem::on(
                K::Table,
                "a",
                "CREATE TABLE a (id INTEGER PRIMARY KEY, b_id INTEGER REFERENCES b(id)) STRICT;"
            )
        );
        assert_eq!(
            texts(&p.after_rows),
            [
                "DELETE FROM \"sqlite_sequence\" WHERE name = 'b';",
                "INSERT INTO \"sqlite_sequence\" (name, seq) VALUES ('b', 41);",
                "CREATE INDEX b_n ON b (n);",
                "CREATE VIEW v_base AS SELECT id FROM a;",
                "CREATE VIEW v_top AS SELECT id FROM v_base;",
                "CREATE TRIGGER tr AFTER INSERT ON a BEGIN UPDATE b SET n = n + 1; END;",
            ]
        );
        let tags: Vec<(K, Option<&str>)> = p
            .after_rows
            .iter()
            .map(|i| (i.kind, i.table.as_deref()))
            .collect();
        assert_eq!(
            tags,
            [
                (K::Setval, Some("b")),
                (K::Setval, Some("b")),
                (K::Index, Some("b")),
                (K::View, None),
                (K::View, None),
                (K::Trigger, Some("a")),
            ]
        );
        assert_eq!(
            p.finish,
            [StructureItem::new(
                K::UserVersion,
                "PRAGMA user_version = 7;"
            )]
        );
    }

    #[test]
    fn virtual_tables_are_not_included() {
        let p = build(fixture());
        assert_eq!(
            p.not_included,
            ["virtual table docs", "shadow table docs_data"]
        );
        assert!(!p.before_rows.iter().any(|s| s.sql.contains("docs")));
    }

    #[test]
    fn objects_on_left_out_tables_are_left_out() {
        let mut c = fixture();
        c.indexes.push(SqObject::new(
            "docs_data_ix",
            "docs_data",
            "CREATE INDEX docs_data_ix ON docs_data (block)",
        ));
        c.triggers.push(SqObject::new(
            "docs_log",
            "docs_data",
            "CREATE TRIGGER docs_log AFTER INSERT ON docs_data BEGIN SELECT 1; END",
        ));
        c.views.push(SqObject::new(
            "v_docs",
            "v_docs",
            "CREATE VIEW v_docs AS SELECT body FROM docs",
        ));
        c.views.push(SqObject::new(
            "v_docs2",
            "v_docs2",
            "CREATE VIEW v_docs2 AS SELECT * FROM \"v_docs\"",
        ));
        let p = build(c);
        assert_eq!(
            p.not_included,
            [
                "virtual table docs",
                "shadow table docs_data",
                "view v_docs",
                "view v_docs2",
                "index docs_data_ix",
                "trigger docs_log",
            ]
        );
        assert!(!p.after_rows.iter().any(|i| i.sql.contains("docs")));
        assert_eq!(
            (p.counts.indexes, p.counts.views, p.counts.triggers),
            (1, 2, 1)
        );
    }

    #[test]
    fn counts() {
        let c = build(fixture()).counts;
        assert_eq!(
            (
                c.tables,
                c.indexes,
                c.views,
                c.triggers,
                c.sequences,
                c.checks,
                c.foreign_keys,
                c.generated
            ),
            (2, 1, 2, 1, 1, 1, 2, 1)
        );
    }

    #[test]
    fn reads_a_file() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT, n INT CHECK (n > 0));
             CREATE INDEX a_n ON a (n);
             CREATE VIEW v AS SELECT id FROM a;
             CREATE VIRTUAL TABLE docs USING fts5(body);
             INSERT INTO a (n) VALUES (1), (2);
             DELETE FROM a WHERE id = 2;
             PRAGMA user_version = 3;",
        )
        .unwrap();
        let p = read_structure(&conn).unwrap();
        assert_eq!(p.tables, ["a"]);
        assert!(p.not_included.contains(&"virtual table docs".to_string()));
        assert!(
            p.not_included
                .iter()
                .any(|s| s.starts_with("shadow table docs_")),
            "{:?}",
            p.not_included
        );
        assert!(
            texts(&p.after_rows)
                .contains(&"INSERT INTO \"sqlite_sequence\" (name, seq) VALUES ('a', 2);")
        );
        assert_eq!(texts(&p.finish), ["PRAGMA user_version = 3;"]);
        assert_eq!(p.counts.checks, 1);
    }
}
