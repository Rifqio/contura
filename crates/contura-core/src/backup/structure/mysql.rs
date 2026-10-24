//! MySQL structure (spec "Per-Dialect rules", MySQL): `SHOW CREATE` text with `DEFINER=`
//! removed. Tables in name order before the rows; after them routines, views in
//! `VIEW_TABLE_USAGE` order, then triggers (ruling R7: a view may call a function, and
//! triggers come last so they never fire on the restored rows). Each routine and trigger
//! is framed by `DELIMITER ;;` and `DELIMITER ;` lines and created under its own
//! `sql_mode`, as mysqldump does; the settings value comes back after them.
//!
//! The reading connection must be inside the backup's snapshot. [`read_structure`] makes
//! the backed-up database the default one (`USE`), so `SHOW CREATE VIEW` leaves the
//! database name out of the view and its body, and the file restores into any database.
//! It reads with `sql_mode = ''` (no `ANSI_QUOTES`, so names come backticked) and puts the
//! session's mode back after.
//!
//! Indexes and Foreign Keys stay inside the `SHOW CREATE TABLE` text: there are no items
//! of their own on MySQL (ruling R8).

use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Row};

use super::StructureKind as K;
use super::{ContentCounts, StructureItem, StructureParts, dependency_order, terminated};
use crate::common::sql_string;
use crate::error::{Error, Result};
use crate::model::DialectKind;
use crate::mysql::query_err;
use crate::mysql::quote::quote_ident;

/// The `sql_mode` the settings section sets: the mode a Backup file
/// runs under (`ddl::SqlModeFrame::Backup`).
pub const RESTORE_SQL_MODE: &str = crate::ddl::MYSQL_BACKUP_SQL_MODE;

pub const SETTINGS: &[&str] = &[
    "SET NAMES utf8mb4;",
    "SET FOREIGN_KEY_CHECKS = 0;",
    "SET UNIQUE_CHECKS = 0;",
    "SET time_zone = '+00:00';",
    crate::ddl::mysql_sql_mode_set(crate::ddl::SqlModeFrame::Backup),
];

pub const FINISH: &[&str] = &["SET FOREIGN_KEY_CHECKS = 1;", "SET UNIQUE_CHECKS = 1;"];

/// Server-wide objects a Backup never carries.
pub const GRANTS: &str = "grants and roles";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoutineKind {
    Procedure,
    Function,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MyView {
    pub name: String,
    /// `SHOW CREATE VIEW` text.
    pub create: String,
    /// The views and tables it reads (`VIEW_TABLE_USAGE`).
    pub uses: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MyRoutine {
    pub kind: RoutineKind,
    pub name: String,
    /// `SHOW CREATE PROCEDURE` or `FUNCTION` text.
    pub create: String,
    /// The `sql_mode` it was created under.
    pub sql_mode: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MyTrigger {
    pub name: String,
    pub table: String,
    /// `SHOW CREATE TRIGGER` text.
    pub create: String,
    pub sql_mode: String,
}

/// What the catalog reads give, before any statement is built.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MyCatalog {
    /// Name and `SHOW CREATE TABLE` text, in name order.
    pub tables: Vec<(String, String)>,
    /// In name order.
    pub views: Vec<MyView>,
    /// Procedures, then functions, each in name order.
    pub routines: Vec<MyRoutine>,
    /// By table and action order.
    pub triggers: Vec<MyTrigger>,
    pub events: Vec<String>,
    /// Indexes, Foreign Keys, checks, generated columns, enum columns and auto-increment
    /// columns; the object counts are taken from the lists above.
    pub counts: ContentCounts,
}

/// Reads the structure of `database` on `conn`, which is inside the backup's snapshot.
pub async fn read_structure(conn: &mut Conn, database: &str) -> Result<StructureParts> {
    conn.query_drop("SET @contura_sql_mode = @@SESSION.sql_mode, SESSION sql_mode = ''")
        .await
        .map_err(query_err)?;
    let read = read_catalog(conn, database).await;
    let restored = conn
        .query_drop("SET SESSION sql_mode = @contura_sql_mode")
        .await
        .map_err(query_err);
    let catalog = read?;
    restored?;
    Ok(build(catalog))
}

fn set_mode(mode: &str) -> StructureItem {
    StructureItem::new(
        K::Setting,
        format!("SET sql_mode = {};", sql_string(DialectKind::MySql, mode)),
    )
}

/// Builds the statements from what the catalog reads gave.
pub fn build(c: MyCatalog) -> StructureParts {
    let mut definer_removed = false;
    let mut strip = |sql: &str| {
        let (out, removed) = strip_definer(sql);
        definer_removed |= removed;
        out
    };

    let before_rows = c
        .tables
        .iter()
        .map(|(name, sql)| StructureItem::on(K::Table, name, terminated(sql)))
        .collect();

    let mut after_rows = Vec::new();
    // Each routine and trigger under its own mode; a SET only where the mode changes.
    let mut mode = RESTORE_SQL_MODE.to_string();
    let mut switch = |to: &str, out: &mut Vec<StructureItem>| {
        if mode != to {
            out.push(set_mode(to));
            mode = to.to_string();
        }
    };
    for r in &c.routines {
        switch(&r.sql_mode, &mut after_rows);
        let kind = match r.kind {
            RoutineKind::Procedure => K::Procedure,
            RoutineKind::Function => K::Function,
        };
        after_rows.push(StructureItem::new(kind, framed(&strip(&r.create))));
    }
    switch(RESTORE_SQL_MODE, &mut after_rows);
    let views = dependency_order(c.views.clone(), |v| &v.name, |v| &v.uses);
    for v in &views {
        after_rows.push(StructureItem::new(K::View, terminated(&strip(&v.create))));
    }
    for t in &c.triggers {
        switch(&t.sql_mode, &mut after_rows);
        after_rows.push(StructureItem::on(
            K::Trigger,
            &t.table,
            framed(&strip(&t.create)),
        ));
    }
    switch(RESTORE_SQL_MODE, &mut after_rows);

    let mut not_included: Vec<String> = c.events.iter().map(|e| format!("event {e}")).collect();
    not_included.push(GRANTS.to_string());

    let counts = ContentCounts {
        tables: c.tables.len() as u32,
        views: c.views.len() as u32,
        functions: c
            .routines
            .iter()
            .filter(|r| r.kind == RoutineKind::Function)
            .count() as u32,
        procedures: c
            .routines
            .iter()
            .filter(|r| r.kind == RoutineKind::Procedure)
            .count() as u32,
        triggers: c.triggers.len() as u32,
        ..c.counts
    };

    StructureParts {
        settings: SETTINGS
            .iter()
            .map(|s| StructureItem::new(K::Setting, *s))
            .collect(),
        before_rows,
        after_rows,
        finish: FINISH
            .iter()
            .map(|s| StructureItem::new(K::Setting, *s))
            .collect(),
        not_included,
        counts,
        tables: c.tables.into_iter().map(|(name, _)| name).collect(),
        definer_removed,
    }
}

/// A routine or trigger between `DELIMITER ;;` and `DELIMITER ;` lines, which step 7's
/// script reader and the mysql client both understand.
pub fn framed(sql: &str) -> String {
    let body = sql.trim_end();
    let body = body.strip_suffix(";;").unwrap_or(body).trim_end();
    format!("DELIMITER ;;\n{body};;\nDELIMITER ;")
}

/// Removes the `DEFINER=user@host` clause from the head of a `SHOW CREATE` statement
/// (between `CREATE` and the object keyword), so the object belongs to the restoring
/// user. `SQL SECURITY` stays as written. Returns the text and whether a clause went.
pub fn strip_definer(sql: &str) -> (String, bool) {
    const OBJECTS: &[&str] = &[
        "VIEW",
        "PROCEDURE",
        "FUNCTION",
        "TRIGGER",
        "EVENT",
        "AGGREGATE",
    ];
    let b = sql.as_bytes();
    let mut i = 0;
    loop {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= b.len() {
            return (sql.to_string(), false);
        }
        let rest = &sql[i..];
        if rest.len() >= 8 && rest[..8].eq_ignore_ascii_case("DEFINER=") {
            let Some(len) = account_len(&rest[8..]) else {
                return (sql.to_string(), false);
            };
            // Drop the clause and the whitespace before it.
            let start = sql[..i].trim_end().len();
            let end = i + 8 + len;
            return (format!("{}{}", &sql[..start], &sql[end..]), true);
        }
        let word_end = rest
            .find(|ch: char| ch.is_ascii_whitespace())
            .unwrap_or(rest.len());
        let word = &rest[..word_end];
        if OBJECTS.iter().any(|o| word.eq_ignore_ascii_case(o)) {
            return (sql.to_string(), false);
        }
        i += word_end;
    }
}

/// The length of `user@host` at the start of `s`; each part backticked, quoted or bare.
fn account_len(s: &str) -> Option<usize> {
    let user = ident_len(s)?;
    let rest = &s[user..];
    if !rest.starts_with('@') {
        // `DEFINER=CURRENT_USER` and the like: the bare word alone.
        return Some(user);
    }
    let host = ident_len(&rest[1..])?;
    Some(user + 1 + host)
}

fn ident_len(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    let q = *b.first()?;
    if q == b'`' || q == b'\'' || q == b'"' {
        let mut i = 1;
        while i < b.len() {
            if b[i] == q {
                if b.get(i + 1) == Some(&q) {
                    i += 2;
                    continue;
                }
                return Some(i + 1);
            }
            if b[i] == b'\\' && q != b'`' {
                i += 1;
            }
            i += 1;
        }
        None
    } else {
        let n = s
            .find(|ch: char| ch.is_ascii_whitespace() || ch == '@')
            .unwrap_or(s.len());
        (n > 0).then_some(n)
    }
}

async fn names(conn: &mut Conn, sql: &str, database: &str) -> Result<Vec<String>> {
    conn.exec(sql, (database,)).await.map_err(query_err)
}

async fn count(conn: &mut Conn, sql: &str, database: &str) -> Result<u32> {
    let n: Option<u64> = conn.exec_first(sql, (database,)).await.map_err(query_err)?;
    Ok(n.unwrap_or(0) as u32)
}

/// One text column of a `SHOW CREATE` row; NULL when the user may not see it.
fn create_text(row: Option<Row>, column: &str, what: &str) -> Result<String> {
    let text: Option<Option<String>> = row.and_then(|r| r.get_opt(column).and_then(|v| v.ok()));
    match text.flatten() {
        Some(t) => Ok(t),
        None => Err(Error::Query(format!(
            "cannot read the definition of {what}: the server returned none. \
             The Connection's user may lack the privilege to see it."
        ))),
    }
}

pub async fn read_catalog(conn: &mut Conn, database: &str) -> Result<MyCatalog> {
    conn.query_drop(format!("USE {}", quote_ident(database)))
        .await
        .map_err(query_err)?;

    let table_names = names(
        conn,
        "SELECT CAST(TABLE_NAME AS CHAR) FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
        database,
    )
    .await?;
    let mut tables = Vec::with_capacity(table_names.len());
    for name in table_names {
        let row: Option<Row> = conn
            .query_first(format!("SHOW CREATE TABLE {}", quote_ident(&name)))
            .await
            .map_err(query_err)?;
        let sql = create_text(row, "Create Table", &format!("table {name}"))?;
        tables.push((name, sql));
    }

    let view_names = names(
        conn,
        "SELECT CAST(TABLE_NAME AS CHAR) FROM information_schema.VIEWS \
         WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
        database,
    )
    .await?;
    let usage: Vec<(String, String)> = conn
        .exec(
            "SELECT CAST(VIEW_NAME AS CHAR), CAST(TABLE_NAME AS CHAR) \
             FROM information_schema.VIEW_TABLE_USAGE \
             WHERE VIEW_SCHEMA = ? AND TABLE_SCHEMA = VIEW_SCHEMA",
            (database,),
        )
        .await
        .map_err(query_err)?;
    let mut views = Vec::with_capacity(view_names.len());
    for name in view_names {
        let row: Option<Row> = conn
            .query_first(format!("SHOW CREATE VIEW {}", quote_ident(&name)))
            .await
            .map_err(query_err)?;
        let create = create_text(row, "Create View", &format!("view {name}"))?;
        let uses = usage
            .iter()
            .filter(|(v, _)| v == &name)
            .map(|(_, t)| t.clone())
            .collect();
        views.push(MyView { name, create, uses });
    }

    let routine_rows: Vec<(String, String, String)> = conn
        .exec(
            "SELECT CAST(ROUTINE_TYPE AS CHAR), CAST(ROUTINE_NAME AS CHAR), \
             CAST(SQL_MODE AS CHAR) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? \
             ORDER BY ROUTINE_TYPE DESC, ROUTINE_NAME",
            (database,),
        )
        .await
        .map_err(query_err)?;
    let mut routines = Vec::with_capacity(routine_rows.len());
    for (kind, name, sql_mode) in routine_rows {
        let (kind, word, column) = if kind.eq_ignore_ascii_case("FUNCTION") {
            (RoutineKind::Function, "FUNCTION", "Create Function")
        } else {
            (RoutineKind::Procedure, "PROCEDURE", "Create Procedure")
        };
        let row: Option<Row> = conn
            .query_first(format!("SHOW CREATE {word} {}", quote_ident(&name)))
            .await
            .map_err(query_err)?;
        let create = create_text(row, column, &format!("{} {name}", word.to_lowercase()))?;
        routines.push(MyRoutine {
            kind,
            name,
            create,
            sql_mode,
        });
    }

    let trigger_rows: Vec<(String, String, String)> = conn
        .exec(
            "SELECT CAST(TRIGGER_NAME AS CHAR), CAST(EVENT_OBJECT_TABLE AS CHAR), \
             CAST(SQL_MODE AS CHAR) FROM information_schema.TRIGGERS \
             WHERE TRIGGER_SCHEMA = ? \
             ORDER BY EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORDER",
            (database,),
        )
        .await
        .map_err(query_err)?;
    let mut triggers = Vec::with_capacity(trigger_rows.len());
    for (name, table, sql_mode) in trigger_rows {
        let row: Option<Row> = conn
            .query_first(format!("SHOW CREATE TRIGGER {}", quote_ident(&name)))
            .await
            .map_err(query_err)?;
        let create = create_text(row, "SQL Original Statement", &format!("trigger {name}"))?;
        triggers.push(MyTrigger {
            name,
            table,
            create,
            sql_mode,
        });
    }

    let events = names(
        conn,
        "SELECT CAST(EVENT_NAME AS CHAR) FROM information_schema.EVENTS \
         WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME",
        database,
    )
    .await?;

    // Columns of tables only, not of views.
    let base = "FROM information_schema.TABLES t WHERE t.TABLE_TYPE = 'BASE TABLE'";
    let counts = ContentCounts {
        indexes: count(
            conn,
            "SELECT COUNT(DISTINCT s.TABLE_NAME, s.INDEX_NAME) \
             FROM information_schema.STATISTICS s JOIN information_schema.TABLES t \
             ON t.TABLE_SCHEMA = s.TABLE_SCHEMA AND t.TABLE_NAME = s.TABLE_NAME \
             WHERE s.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE'",
            database,
        )
        .await?,
        foreign_keys: count(
            conn,
            "SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS \
             WHERE CONSTRAINT_SCHEMA = ?",
            database,
        )
        .await?,
        checks: count(
            conn,
            "SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS \
             WHERE TABLE_SCHEMA = ? AND CONSTRAINT_TYPE = 'CHECK'",
            database,
        )
        .await?,
        generated: count(
            conn,
            &format!(
                "SELECT COUNT(*) FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA = ? \
                 AND c.GENERATION_EXPRESSION <> '' AND EXISTS (SELECT 1 {base} \
                 AND t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_SCHEMA = c.TABLE_SCHEMA)"
            ),
            database,
        )
        .await?,
        enums: count(
            conn,
            &format!(
                "SELECT COUNT(*) FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA = ? \
                 AND c.DATA_TYPE = 'enum' AND EXISTS (SELECT 1 {base} \
                 AND t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_SCHEMA = c.TABLE_SCHEMA)"
            ),
            database,
        )
        .await?,
        sequences: count(
            conn,
            &format!(
                "SELECT COUNT(*) FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA = ? \
                 AND c.EXTRA LIKE '%auto_increment%' AND EXISTS (SELECT 1 {base} \
                 AND t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_SCHEMA = c.TABLE_SCHEMA)"
            ),
            database,
        )
        .await?,
        ..ContentCounts::default()
    };

    Ok(MyCatalog {
        tables,
        views,
        routines,
        triggers,
        events,
        counts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::structure::texts;

    fn fixture() -> MyCatalog {
        MyCatalog {
            tables: vec![
                (
                    "a".into(),
                    "CREATE TABLE `a` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  `b_id` int,\n  \
                     PRIMARY KEY (`id`),\n  CONSTRAINT `a_b` FOREIGN KEY (`b_id`) REFERENCES `b` (`id`)\n) \
                     ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4"
                        .into(),
                ),
                (
                    "b".into(),
                    "CREATE TABLE `b` (\n  `id` int NOT NULL,\n  `a_id` int,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB"
                        .into(),
                ),
            ],
            views: vec![
                MyView {
                    name: "a_top".into(),
                    create: "CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER \
                             VIEW `a_top` AS select `f`() AS `one`,`v_base`.`id` AS `id` from `v_base`"
                        .into(),
                    uses: vec!["v_base".into()],
                },
                MyView {
                    name: "v_base".into(),
                    create: "CREATE ALGORITHM=UNDEFINED DEFINER=`dbview_test`@`%` SQL SECURITY INVOKER \
                             VIEW `v_base` AS select `a`.`id` AS `id` from `a`"
                        .into(),
                    uses: vec!["a".into()],
                },
            ],
            routines: vec![
                MyRoutine {
                    kind: RoutineKind::Procedure,
                    name: "p".into(),
                    create: "CREATE DEFINER=`root`@`localhost` PROCEDURE `p`()\nBEGIN\n  SELECT 'DEFINER=`x`@`y`';\nEND"
                        .into(),
                    sql_mode: "STRICT_TRANS_TABLES".into(),
                },
                MyRoutine {
                    kind: RoutineKind::Function,
                    name: "f".into(),
                    create: "CREATE DEFINER=`root`@`localhost` FUNCTION `f`() RETURNS int\n    DETERMINISTIC\nRETURN 1"
                        .into(),
                    sql_mode: "STRICT_TRANS_TABLES".into(),
                },
            ],
            triggers: vec![MyTrigger {
                name: "tr".into(),
                table: "a".into(),
                create: "CREATE DEFINER=`root`@`localhost` TRIGGER `tr` BEFORE INSERT ON `a` FOR EACH ROW SET NEW.b_id = 1"
                    .into(),
                sql_mode: "STRICT_ALL_TABLES".into(),
            }],
            events: vec!["nightly".into()],
            counts: ContentCounts {
                indexes: 3,
                foreign_keys: 1,
                ..ContentCounts::default()
            },
        }
    }

    #[test]
    fn settings_and_finish_are_the_spec_lines() {
        let p = build(fixture());
        assert_eq!(
            texts(&p.settings),
            [
                "SET NAMES utf8mb4;",
                "SET FOREIGN_KEY_CHECKS = 0;",
                "SET UNIQUE_CHECKS = 0;",
                "SET time_zone = '+00:00';",
                "SET sql_mode = 'NO_AUTO_VALUE_ON_ZERO';",
            ]
        );
        assert_eq!(
            texts(&p.finish),
            ["SET FOREIGN_KEY_CHECKS = 1;", "SET UNIQUE_CHECKS = 1;"]
        );
        assert!(
            p.settings
                .iter()
                .chain(&p.finish)
                .all(|i| i.kind == K::Setting && i.table.is_none())
        );
    }

    #[test]
    fn tables_before_rows_keep_show_create_text() {
        let p = build(fixture());
        assert_eq!(p.tables, ["a", "b"]);
        assert_eq!(p.before_rows.len(), 2);
        let a = &p.before_rows[0];
        assert_eq!((a.kind, a.table.as_deref()), (K::Table, Some("a")));
        // Indexes and Foreign Keys stay inside the table's own text.
        assert!(a.sql.starts_with("CREATE TABLE `a`"));
        assert!(a.sql.contains("FOREIGN KEY (`b_id`)"));
        assert!(a.sql.ends_with("AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4;"));
        assert!(p.before_rows[1].sql.ends_with("ENGINE=InnoDB;"));
    }

    #[test]
    fn routines_then_views_in_usage_order_then_triggers() {
        let p = build(fixture());
        let kinds: Vec<(K, Option<&str>)> = p
            .after_rows
            .iter()
            .map(|i| (i.kind, i.table.as_deref()))
            .collect();
        assert_eq!(
            kinds,
            [
                (K::Setting, None),
                (K::Procedure, None),
                (K::Function, None),
                (K::Setting, None),
                (K::View, None),
                (K::View, None),
                (K::Setting, None),
                (K::Trigger, Some("a")),
                (K::Setting, None),
            ]
        );
        let t = texts(&p.after_rows);
        assert!(t[1].contains("PROCEDURE `p`"));
        assert!(t[2].contains("FUNCTION `f`"));
        assert!(t[4].contains("VIEW `v_base`"), "{}", t[4]);
        // The view that calls `f` comes after it.
        assert!(t[5].contains("VIEW `a_top`"));
        assert!(t[7].contains("TRIGGER `tr`"));
    }

    #[test]
    fn each_routine_and_trigger_under_its_own_sql_mode() {
        let p = build(fixture());
        let t = texts(&p.after_rows);
        // One SET where the mode changes, and the settings value back after.
        assert_eq!(t[0], "SET sql_mode = 'STRICT_TRANS_TABLES';");
        assert_eq!(t[3], "SET sql_mode = 'NO_AUTO_VALUE_ON_ZERO';");
        assert_eq!(t[6], "SET sql_mode = 'STRICT_ALL_TABLES';");
        assert_eq!(t[8], "SET sql_mode = 'NO_AUTO_VALUE_ON_ZERO';");

        // A routine already under the settings mode needs no SET at all.
        let mut c = fixture();
        for r in &mut c.routines {
            r.sql_mode = RESTORE_SQL_MODE.into();
        }
        c.triggers.clear();
        let p = build(c);
        assert!(p.after_rows.iter().all(|i| i.kind != K::Setting));
    }

    #[test]
    fn definer_removed_and_sql_security_kept() {
        let p = build(fixture());
        let t = texts(&p.after_rows);
        assert!(p.definer_removed);
        assert_eq!(
            t[4],
            "CREATE ALGORITHM=UNDEFINED SQL SECURITY INVOKER VIEW `v_base` AS select `a`.`id` AS `id` from `a`;"
        );
        assert!(t[5].contains("SQL SECURITY DEFINER VIEW"));
        // The body's text is never touched.
        assert!(t[1].contains("SELECT 'DEFINER=`x`@`y`';"));
        assert!(t[1].starts_with("DELIMITER ;;\nCREATE PROCEDURE `p`()"));
        for s in t {
            assert!(!s.contains("`root`@`localhost`"), "{s}");
        }
    }

    #[test]
    fn routines_and_triggers_are_framed() {
        let p = build(fixture());
        let t = texts(&p.after_rows);
        assert_eq!(
            t[2],
            "DELIMITER ;;\nCREATE FUNCTION `f`() RETURNS int\n    DETERMINISTIC\nRETURN 1;;\nDELIMITER ;"
        );
        assert_eq!(
            t[7],
            "DELIMITER ;;\nCREATE TRIGGER `tr` BEFORE INSERT ON `a` FOR EACH ROW SET NEW.b_id = 1;;\nDELIMITER ;"
        );
    }

    #[test]
    fn events_and_grants_are_not_included() {
        let p = build(fixture());
        assert_eq!(p.not_included, ["event nightly", "grants and roles"]);
    }

    #[test]
    fn counts_from_lists_and_catalog() {
        let c = build(fixture()).counts;
        assert_eq!(
            (c.tables, c.views, c.functions, c.procedures, c.triggers),
            (2, 2, 1, 1, 1)
        );
        assert_eq!((c.indexes, c.foreign_keys), (3, 1));
    }

    #[test]
    fn strip_definer_forms() {
        let cases = [
            (
                "CREATE DEFINER=`we``ird`@`%` PROCEDURE `p`() BEGIN END",
                "CREATE PROCEDURE `p`() BEGIN END",
            ),
            (
                "CREATE DEFINER='u'@'h' TRIGGER t BEFORE INSERT ON a FOR EACH ROW SET @x = 1",
                "CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW SET @x = 1",
            ),
            (
                "CREATE DEFINER=root@localhost FUNCTION f() RETURNS int RETURN 1",
                "CREATE FUNCTION f() RETURNS int RETURN 1",
            ),
            (
                "CREATE definer=CURRENT_USER VIEW v AS select 1",
                "CREATE VIEW v AS select 1",
            ),
        ];
        for (from, to) in cases {
            assert_eq!(strip_definer(from), (to.to_string(), true), "{from}");
        }
        // No clause in the head: nothing changes, even with one in the body.
        let plain = "CREATE VIEW v AS select 'DEFINER=`a`@`b`' AS x";
        assert_eq!(strip_definer(plain), (plain.to_string(), false));
    }
}
