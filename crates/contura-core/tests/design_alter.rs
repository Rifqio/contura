//! Live: ALTER plans against the real servers. The runner comes in Task 5, so
//! these send the planned statements themselves (PostgreSQL inside a transaction).

mod common;

use contura_core::design::{
    ColumnDraft, DesignEdit, DesignRequest, DesignTarget, TableDesign, plan_design,
};
use contura_core::model::{DialectKind, ObjectPath};

/// `ChangeColumn` of `name` with `edit` applied to the column as loaded.
fn change(base: &TableDesign, name: &str, edit: impl FnOnce(&mut ColumnDraft)) -> DesignEdit {
    let c = base
        .columns
        .iter()
        .find(|c| c.name == name)
        .expect("column");
    let mut column = ColumnDraft {
        name: c.name.clone(),
        type_sql: c.type_sql.clone(),
        nullable: c.nullable,
        default_sql: c.default_sql.clone(),
        increment: c.increment != contura_core::design::Increment::None,
        comment: c.comment.clone(),
    };
    edit(&mut column);
    DesignEdit::ChangeColumn {
        name: name.into(),
        column,
    }
}

fn alter(
    kind: DialectKind,
    base: &TableDesign,
    edits: Vec<DesignEdit>,
) -> contura_core::Result<Vec<String>> {
    plan_design(
        kind,
        &DesignRequest {
            target: DesignTarget::Alter { base: base.clone() },
            edits,
        },
    )
    .map(|p| p.statements)
}

mod pg {
    use super::*;
    use crate::common::pg::{PgTestDb, pg_admin_client};
    use contura_core::dialect::{Dialect, connect};
    use std::sync::Arc;
    use tokio_postgres::Client;

    async fn setup(seed: &str) -> (PgTestDb, Arc<dyn Dialect>, Client) {
        let db = PgTestDb::create().await;
        let admin = pg_admin_client(&db.name).await;
        admin.batch_execute(seed).await.expect("seed");
        let dialect = connect(&db.config, db.password.as_deref())
            .await
            .expect("connect");
        (db, dialect, admin)
    }

    fn path(db: &PgTestDb, name: &str) -> ObjectPath {
        ObjectPath {
            database: db.name.clone(),
            schema: Some("public".into()),
            name: name.into(),
        }
    }

    /// Runs the statements in one transaction; the first failure rolls back.
    async fn run(client: &Client, statements: &[String]) -> Result<(), String> {
        client.batch_execute("BEGIN").await.unwrap();
        for sql in statements {
            if let Err(e) = client.batch_execute(sql).await {
                client.batch_execute("ROLLBACK").await.unwrap();
                return Err(format!("{sql}: {e:?}"));
            }
        }
        client.batch_execute("COMMIT").await.unwrap();
        Ok(())
    }

    async fn finish(db: PgTestDb, dialect: Arc<dyn Dialect>) {
        dialect.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn narrowing_refuses_values_that_do_not_fit() {
        let (db, dialect, client) = setup(
            "CREATE TABLE public.t (id int PRIMARY KEY, v varchar(10));
             INSERT INTO public.t VALUES (1, 'abcdefgh');",
        )
        .await;
        // The explicit cast D10 used would have cut the value short.
        client.batch_execute("BEGIN").await.unwrap();
        client
            .batch_execute(
                "ALTER TABLE public.t ALTER COLUMN v TYPE varchar(5) USING v::varchar(5)",
            )
            .await
            .unwrap();
        let cut: String = client
            .query_one("SELECT v FROM public.t", &[])
            .await
            .unwrap()
            .get(0);
        assert_eq!(cut, "abcde");
        client.batch_execute("ROLLBACK").await.unwrap();

        let base = dialect.table_design(&path(&db, "t")).await.unwrap();
        let statements = alter(
            DialectKind::Postgres,
            &base,
            vec![change(&base, "v", |c| c.type_sql = "varchar(5)".into())],
        )
        .unwrap();
        let err = run(&client, &statements).await.unwrap_err();
        assert!(err.contains("too long"), "{err}");
        let row = client
            .query_one(
                "SELECT v, format_type(atttypid, atttypmod) FROM public.t, pg_attribute \
                 WHERE attrelid = 'public.t'::regclass AND attname = 'v'",
                &[],
            )
            .await
            .unwrap();
        assert_eq!(row.get::<_, String>(0), "abcdefgh");
        assert_eq!(row.get::<_, String>(1), "character varying(10)");

        // When every value fits, the same change applies.
        client
            .batch_execute("UPDATE public.t SET v = 'abc'")
            .await
            .unwrap();
        run(&client, &statements).await.unwrap();
        let after = dialect.table_design(&path(&db, "t")).await.unwrap();
        assert_eq!(after.columns[1].type_sql, "character varying(5)");
        let v: String = client
            .query_one("SELECT v FROM public.t", &[])
            .await
            .unwrap()
            .get(0);
        assert_eq!(v, "abc");
        drop(client);
        finish(db, dialect).await;
    }

    #[tokio::test]
    async fn a_change_across_families_refuses_values_that_do_not_fit() {
        let (db, dialect, client) = setup(
            "CREATE TABLE public.t (id int PRIMARY KEY, n integer);
             INSERT INTO public.t VALUES (1, 12345);",
        )
        .await;
        let base = dialect.table_design(&path(&db, "t")).await.unwrap();
        let statements = alter(
            DialectKind::Postgres,
            &base,
            vec![change(&base, "n", |c| c.type_sql = "varchar(3)".into())],
        )
        .unwrap();
        let err = run(&client, &statements).await.unwrap_err();
        assert!(err.contains("too long"), "{err}");
        let n: i32 = client
            .query_one("SELECT n FROM public.t", &[])
            .await
            .unwrap()
            .get(0);
        assert_eq!(n, 12345);

        client
            .batch_execute("UPDATE public.t SET n = 12")
            .await
            .unwrap();
        run(&client, &statements).await.unwrap();
        let v: String = client
            .query_one("SELECT n FROM public.t", &[])
            .await
            .unwrap()
            .get(0);
        assert_eq!(v, "12");
        drop(client);
        finish(db, dialect).await;
    }

    #[tokio::test]
    async fn a_type_change_with_a_default_applies() {
        let (db, dialect, client) = setup(
            "CREATE TABLE public.t (id int PRIMARY KEY, flag int DEFAULT 0);
             INSERT INTO public.t VALUES (1, 1), (2, 0);",
        )
        .await;
        let base = dialect.table_design(&path(&db, "t")).await.unwrap();
        let statements = alter(
            DialectKind::Postgres,
            &base,
            vec![change(&base, "flag", |c| {
                c.type_sql = "boolean".into();
                c.default_sql = Some("false".into());
            })],
        )
        .unwrap();
        run(&client, &statements).await.unwrap();
        let after = dialect.table_design(&path(&db, "t")).await.unwrap();
        assert_eq!(after.columns[1].type_sql, "boolean");
        assert_eq!(after.columns[1].default_sql.as_deref(), Some("false"));
        let flags: Vec<bool> = client
            .query("SELECT flag FROM public.t ORDER BY id", &[])
            .await
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect();
        assert_eq!(flags, [true, false]);
        drop(client);
        finish(db, dialect).await;
    }
}

mod mysql {
    use super::*;
    use crate::common::TestDb;
    use contura_core::Error;
    use contura_core::dialect::{Dialect, connect};
    use mysql_async::prelude::Queryable;
    use mysql_async::{Conn, Opts, OptsBuilder};
    use std::sync::Arc;

    async fn conn(db: &TestDb) -> Conn {
        let opts: Opts = OptsBuilder::default()
            .ip_or_hostname(db.config.host.clone())
            .tcp_port(db.config.port)
            .user(Some(db.config.user.clone()))
            .pass(db.password.clone())
            .db_name(Some(db.name.clone()))
            .into();
        Conn::new(opts).await.expect("connect to test MySQL")
    }

    fn path(db: &TestDb, name: &str) -> ObjectPath {
        ObjectPath {
            database: db.name.clone(),
            schema: None,
            name: name.into(),
        }
    }

    #[tokio::test]
    async fn attributes_are_read_whatever_the_quoting() {
        let db = TestDb::create().await;
        let mut c = conn(&db).await;
        c.query_drop("CREATE TABLE t (id int PRIMARY KEY, h int INVISIBLE, v int)")
            .await
            .unwrap();
        drop(c);
        let dialect =
            contura_core::mysql::MySqlDialect::connect(&db.config, db.password.as_deref())
                .await
                .expect("connect");
        for session in [
            "SET SESSION sql_mode = CONCAT(@@sql_mode, ',ANSI_QUOTES')",
            "SET SESSION sql_quote_show_create = 0",
        ] {
            let d = dialect
                .table_design_after_for_test(session, &path(&db, "t"))
                .await
                .unwrap();
            let advanced: Vec<bool> = d.columns.iter().map(|c| c.advanced).collect();
            assert_eq!(advanced, [false, true, false], "{session}");
            assert!(
                d.unsupported.contains(&"column h (invisible)".to_string()),
                "{session}: {:?}",
                d.unsupported
            );
        }
        dialect.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn an_invisible_column_is_renamed_only() {
        let db = TestDb::create().await;
        let mut c = conn(&db).await;
        c.query_drop("CREATE TABLE t (id int PRIMARY KEY, h int INVISIBLE, v int)")
            .await
            .unwrap();
        let dialect: Arc<dyn Dialect> = connect(&db.config, db.password.as_deref())
            .await
            .expect("connect");
        let base = dialect.table_design(&path(&db, "t")).await.unwrap();
        assert!(base.columns[1].advanced);
        assert!(!base.columns[0].advanced && !base.columns[2].advanced);
        assert!(
            base.unsupported
                .contains(&"column h (invisible)".to_string()),
            "{:?}",
            base.unsupported
        );

        let refused = alter(
            DialectKind::MySql,
            &base,
            vec![change(&base, "h", |c| c.comment = Some("x".into()))],
        )
        .unwrap_err();
        assert!(
            matches!(&refused, Error::InvalidInput(m) if m.contains("column h (invisible)")),
            "{refused:?}"
        );

        let statements = alter(
            DialectKind::MySql,
            &base,
            vec![change(&base, "h", |c| c.name = "hidden".into())],
        )
        .unwrap();
        for sql in &statements {
            c.query_drop(sql)
                .await
                .unwrap_or_else(|e| panic!("{sql}: {e}"));
        }
        let (_, create): (String, String) =
            c.query_first("SHOW CREATE TABLE t").await.unwrap().unwrap();
        assert!(
            create.contains("`hidden` int DEFAULT NULL /*!80023 INVISIBLE */"),
            "{create}"
        );
        drop(c);
        dialect.disconnect().await.ok();
        db.drop_db().await;
    }

    /// A loaded default and comment holding `\` and `\'` survive a change that restates the
    /// column, whether or not the server's sql_mode has NO_BACKSLASH_ESCAPES.
    #[tokio::test]
    async fn backslashes_survive_either_sql_mode() {
        let db = TestDb::create().await;
        let dialect =
            contura_core::mysql::MySqlDialect::connect(&db.config, db.password.as_deref())
                .await
                .expect("connect");
        for (i, session) in [
            "SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')",
            "SET SESSION sql_mode = REPLACE(@@sql_mode, 'NO_BACKSLASH_ESCAPES', '')",
        ]
        .into_iter()
        .enumerate()
        {
            let table = format!("t{i}");
            let mut c = conn(&db).await;
            // Read with backslash escapes: the default is `a\b`, the comment `it\'s \ x`.
            c.query_drop(format!(
                "CREATE TABLE {table} (id int PRIMARY KEY, \
                 v varchar(20) DEFAULT 'a\\\\b' COMMENT 'it\\\\''s \\\\ x')"
            ))
            .await
            .unwrap();
            drop(c);
            let base = dialect.table_design(&path(&db, &table)).await.unwrap();
            let v = base.columns.iter().find(|c| c.name == "v").unwrap();
            assert_eq!(v.comment.as_deref(), Some(r"it\'s \ x"));
            let plan = plan_design(
                DialectKind::MySql,
                &DesignRequest {
                    target: DesignTarget::Alter { base: base.clone() },
                    edits: vec![change(&base, "v", |c| c.type_sql = "varchar(30)".into())],
                },
            )
            .unwrap();
            dialect
                .apply_design_after_for_test(session, &db.name, &plan)
                .await
                .unwrap_or_else(|e| panic!("{session}: {e}"));
            let mut c = conn(&db).await;
            let (default, comment): (String, String) = c
                .query_first(format!(
                    "SELECT COLUMN_DEFAULT, COLUMN_COMMENT FROM information_schema.COLUMNS \
                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{table}' AND COLUMN_NAME = 'v'"
                ))
                .await
                .unwrap()
                .unwrap();
            drop(c);
            assert_eq!(default, r"a\b", "{session}");
            assert_eq!(comment, r"it\'s \ x", "{session}");
        }
        dialect.disconnect().await.ok();
        db.drop_db().await;
    }

    /// I1: the SQL the user copies (Designer Copy SQL, Compare Copy script, the CREATE
    /// export) carries the MySQL sql_mode frame, so run in a query tab on a server with
    /// NO_BACKSLASH_ESCAPES it stores `a\b`, not `a\\b`, and the tab's mode comes back.
    #[tokio::test]
    async fn a_copied_script_runs_right_in_a_no_backslash_escapes_session() {
        let db = TestDb::create().await;
        let dialect =
            contura_core::mysql::MySqlDialect::connect(&db.config, db.password.as_deref())
                .await
                .expect("connect");
        let mut c = conn(&db).await;
        c.query_drop(
            "CREATE TABLE t (id int PRIMARY KEY, \
             v varchar(20) DEFAULT 'a\\\\b' COMMENT 'it\\\\''s \\\\ x')",
        )
        .await
        .unwrap();
        let base = dialect.table_design(&path(&db, "t")).await.unwrap();
        let plan = plan_design(
            DialectKind::MySql,
            &DesignRequest {
                target: DesignTarget::Alter { base: base.clone() },
                edits: vec![change(&base, "v", |c| c.type_sql = "varchar(30)".into())],
            },
        )
        .unwrap();
        // As DesignPreview copies it: the statements, each with its `;`, in the frame.
        let body = format!("{};", plan.statements.join(";\n\n"));
        let script = contura_core::ddl::framed_script(DialectKind::MySql, &body);
        assert!(script.starts_with("SET @OLD_SQL_MODE"), "{script}");
        // The query tab's session: the server's mode with NO_BACKSLASH_ESCAPES.
        c.query_drop("SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')")
            .await
            .unwrap();
        for range in contura_core::safety::split_statements(DialectKind::MySql, &script) {
            let sql = script[range].trim();
            if !sql.is_empty() {
                c.query_drop(sql)
                    .await
                    .unwrap_or_else(|e| panic!("{sql}: {e}"));
            }
        }
        let (default, comment): (String, String) = c
            .query_first(
                "SELECT COLUMN_DEFAULT, COLUMN_COMMENT FROM information_schema.COLUMNS \
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't' AND COLUMN_NAME = 'v'",
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(default, r"a\b");
        assert_eq!(comment, r"it\'s \ x");
        let mode: String = c
            .query_first("SELECT @@SESSION.sql_mode")
            .await
            .unwrap()
            .unwrap();
        assert!(mode.contains("NO_BACKSLASH_ESCAPES"), "{mode}");
        drop(c);
        dialect.disconnect().await.ok();
        db.drop_db().await;
    }

    /// M9: Apply turns NO_BACKSLASH_ESCAPES off only on its own connection: a pooled
    /// browse session keeps the server's mode.
    #[tokio::test]
    async fn apply_leaves_the_browse_sessions_sql_mode_alone() {
        let db = TestDb::create().await;
        let dialect =
            contura_core::mysql::MySqlDialect::connect(&db.config, db.password.as_deref())
                .await
                .expect("connect");
        let mut c = conn(&db).await;
        c.query_drop("CREATE TABLE t (id int PRIMARY KEY, v varchar(20))")
            .await
            .unwrap();
        drop(c);
        let base = dialect.table_design(&path(&db, "t")).await.unwrap();
        let plan = plan_design(
            DialectKind::MySql,
            &DesignRequest {
                target: DesignTarget::Alter { base: base.clone() },
                edits: vec![change(&base, "v", |c| c.type_sql = "varchar(30)".into())],
            },
        )
        .unwrap();
        // A pooled session with NO_BACKSLASH_ESCAPES, then Apply, then the same session again.
        let (mode, held, applied) = dialect
            .pooled_sql_mode_around_apply_for_test(&db.name, &plan)
            .await
            .unwrap();
        assert!(mode.contains("NO_BACKSLASH_ESCAPES"), "{mode}");
        // Apply ran on a connection of its own, which it closed: the session whose mode it
        // changed can never be handed to a later browse read. A pooled one would still be
        // open, waiting in the pool.
        assert_ne!(applied, 0);
        assert_ne!(applied, held);
        let mut c = conn(&db).await;
        let mut alive = true;
        for _ in 0..40 {
            let n: u64 = c
                .query_first(format!(
                    "SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE ID = {applied}"
                ))
                .await
                .unwrap()
                .unwrap();
            if n == 0 {
                alive = false;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(!alive, "the connection Apply used is still open");
        drop(c);
        dialect.disconnect().await.ok();
        db.drop_db().await;
    }

    /// N2: the frame keeps the session's strict mode, so a copied narrowing change that
    /// would cut data is refused, as Apply would refuse it, and the row stays whole.
    #[tokio::test]
    async fn a_copied_narrowing_script_refuses_under_strict_mode() {
        let db = TestDb::create().await;
        let dialect =
            contura_core::mysql::MySqlDialect::connect(&db.config, db.password.as_deref())
                .await
                .expect("connect");
        let mut c = conn(&db).await;
        c.query_drop("CREATE TABLE t (id int PRIMARY KEY, v varchar(20))")
            .await
            .unwrap();
        c.query_drop("INSERT INTO t VALUES (1, 'abcdefghij')")
            .await
            .unwrap();
        let base = dialect.table_design(&path(&db, "t")).await.unwrap();
        let plan = plan_design(
            DialectKind::MySql,
            &DesignRequest {
                target: DesignTarget::Alter { base: base.clone() },
                edits: vec![change(&base, "v", |c| c.type_sql = "varchar(5)".into())],
            },
        )
        .unwrap();
        let body = format!("{};", plan.statements.join(";\n\n"));
        let script = contura_core::ddl::framed_script(DialectKind::MySql, &body);
        c.query_drop("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES'")
            .await
            .unwrap();
        let mut failed = None;
        for range in contura_core::safety::split_statements(DialectKind::MySql, &script) {
            let sql = script[range].trim();
            if sql.is_empty() {
                continue;
            }
            if let Err(e) = c.query_drop(sql).await {
                failed = Some((sql.to_string(), e.to_string()));
                break;
            }
            let mode: String = c
                .query_first("SELECT @@SESSION.sql_mode")
                .await
                .unwrap()
                .unwrap();
            if sql.starts_with("SET @OLD_SQL_MODE") {
                // Only NO_BACKSLASH_ESCAPES went; no empty flag is left behind.
                assert_eq!(mode, "STRICT_TRANS_TABLES");
            }
        }
        let (sql, error) = failed.expect("the narrowing ALTER must fail");
        assert!(sql.starts_with("ALTER TABLE"), "{sql}");
        assert!(
            error.contains("1265") || error.contains("Data truncated"),
            "{error}"
        );
        let v: String = c.query_first("SELECT v FROM t").await.unwrap().unwrap();
        assert_eq!(v, "abcdefghij");
        drop(c);
        dialect.disconnect().await.ok();
        db.drop_db().await;
    }
}
