//! `BulkWriter` per Dialect: one held connection for a job's writes, with savepoints,
//! commit and rollback, the Read-only backstop and each Dialect's limits.
//! Live MySQL and PostgreSQL in `dbview_test_<8hex>` databases; SQLite in temp files.

mod common;

use std::sync::Arc;

use common::jobs::run_sql;
use contura_core::dialect::{Dialect, connect};
use contura_core::error::Error;
use contura_core::jobs::writer::{BulkWriter, WriterSetup};
use contura_core::model::{Cell, ConnectionConfig, ObjectPath, PageRequest, SortSpec};

/// The ids in the table, in order.
async fn ids(d: &dyn Dialect, path: &ObjectPath) -> Vec<String> {
    let page = d
        .fetch_page(&PageRequest {
            table: path.clone(),
            page: 0,
            sort: Some(SortSpec {
                column: "id".into(),
                descending: false,
            }),
            filter: None,
        })
        .await
        .expect("read the table");
    page.rows
        .iter()
        .map(|r| match &r[0] {
            Cell::Number { value } => value.clone(),
            other => panic!("id is {other:?}"),
        })
        .collect()
}

async fn open(d: &dyn Dialect, database: Option<&str>, setup: &WriterSetup) -> Box<dyn BulkWriter> {
    match d.open_bulk_writer(database, setup).await {
        Ok(w) => w,
        Err(e) => panic!("open the writer: {e}"),
    }
}

async fn check_commit_keeps_rows(
    d: &dyn Dialect,
    database: Option<&str>,
    path: &ObjectPath,
    t: &str,
) {
    let mut w = open(d, database, &WriterSetup::default()).await;
    w.begin().await.unwrap();
    let n = w
        .run(&format!(
            "INSERT INTO {t} (id, name) VALUES (1, 'a'), (2, 'b')"
        ))
        .await
        .unwrap();
    assert_eq!(n, 2, "rows the INSERT reports");
    assert_eq!(
        w.run(&format!("UPDATE {t} SET name = 'c' WHERE id > 0"))
            .await
            .unwrap(),
        2
    );
    w.commit().await.unwrap();
    w.close().await;
    assert_eq!(ids(d, path).await, ["1", "2"]);
}

async fn check_rollback_leaves_nothing(
    d: &dyn Dialect,
    database: Option<&str>,
    path: &ObjectPath,
    t: &str,
) {
    let mut w = open(d, database, &WriterSetup::default()).await;
    w.begin().await.unwrap();
    w.run(&format!("INSERT INTO {t} (id, name) VALUES (1, 'a')"))
        .await
        .unwrap();
    w.rollback().await.unwrap();
    // The writer is still usable after a rollback; closing without commit undoes the work.
    w.begin().await.unwrap();
    w.run(&format!("INSERT INTO {t} (id, name) VALUES (2, 'b')"))
        .await
        .unwrap();
    w.close().await;
    assert!(ids(d, path).await.is_empty());
}

async fn check_savepoint_rollback_keeps_earlier(
    d: &dyn Dialect,
    database: Option<&str>,
    path: &ObjectPath,
    t: &str,
) {
    let mut w = open(d, database, &WriterSetup::default()).await;
    w.begin().await.unwrap();
    w.run(&format!("INSERT INTO {t} (id, name) VALUES (1, 'a')"))
        .await
        .unwrap();
    w.savepoint("contura_s").await.unwrap();
    w.run(&format!("INSERT INTO {t} (id, name) VALUES (2, 'b')"))
        .await
        .unwrap();
    // A failed statement under the savepoint: the duplicate key.
    assert!(
        w.run(&format!("INSERT INTO {t} (id, name) VALUES (1, 'dup')"))
            .await
            .is_err()
    );
    w.rollback_to("contura_s").await.unwrap();
    w.release("contura_s").await.unwrap();
    w.savepoint("contura_s").await.unwrap();
    w.run(&format!("INSERT INTO {t} (id, name) VALUES (3, 'c')"))
        .await
        .unwrap();
    w.release("contura_s").await.unwrap();
    w.commit().await.unwrap();
    w.close().await;
    assert_eq!(ids(d, path).await, ["1", "3"]);
}

async fn check_setup_runs_before_begin_and_after_commit(
    d: &dyn Dialect,
    database: Option<&str>,
    path: &ObjectPath,
    t: &str,
) {
    let setup = WriterSetup {
        before: vec![format!("INSERT INTO {t} (id, name) VALUES (10, 'before')")],
        after: vec![format!("INSERT INTO {t} (id, name) VALUES (30, 'after')")],
    };
    let mut w = open(d, database, &setup).await;
    w.begin().await.unwrap();
    w.run(&format!("INSERT INTO {t} (id, name) VALUES (20, 'tx')"))
        .await
        .unwrap();
    w.rollback().await.unwrap();
    assert_eq!(ids(d, path).await, ["10"], "after runs only after a commit");
    w.begin().await.unwrap();
    w.run(&format!("INSERT INTO {t} (id, name) VALUES (20, 'tx')"))
        .await
        .unwrap();
    w.commit().await.unwrap();
    w.close().await;
    assert_eq!(ids(d, path).await, ["10", "20", "30"]);
}

/// A failing `after` statement after a good COMMIT is `AfterCommit`, and the rows are in.
async fn check_failing_after_is_after_commit(
    d: &dyn Dialect,
    database: Option<&str>,
    path: &ObjectPath,
    t: &str,
) {
    let dup = format!("INSERT INTO {t} (id, name) VALUES (1, 'dup')");
    let setup = WriterSetup {
        before: Vec::new(),
        after: vec![dup.clone()],
    };
    let mut w = open(d, database, &setup).await;
    w.begin().await.unwrap();
    w.run(&format!(
        "INSERT INTO {t} (id, name) VALUES (1, 'a'), (2, 'b')"
    ))
    .await
    .unwrap();
    match w.commit().await {
        Err(Error::AfterCommit { sql, message }) => {
            assert_eq!(sql, dup);
            assert!(!message.is_empty());
        }
        other => panic!("expected AfterCommit, got {other:?}"),
    }
    w.close().await;
    assert_eq!(ids(d, path).await, ["1", "2"]);
}

/// `run` is one single-statement call: two statements joined by `;` are refused
/// and neither runs, so no value can smuggle in a second statement.
async fn check_run_takes_one_statement(
    d: &dyn Dialect,
    database: Option<&str>,
    path: &ObjectPath,
    t: &str,
) {
    let mut w = open(d, database, &WriterSetup::default()).await;
    w.begin().await.unwrap();
    let two = format!(
        "INSERT INTO {t} (id, name) VALUES (1, 'a'); INSERT INTO {t} (id, name) VALUES (2, 'b')"
    );
    let result = w.run(&two).await;
    assert!(result.is_err(), "two statements ran: {result:?}");
    w.rollback().await.unwrap();
    // A single statement with a `;` inside a value still runs.
    w.begin().await.unwrap();
    w.run(&format!("INSERT INTO {t} (id, name) VALUES (3, 'x; y')"))
        .await
        .unwrap();
    w.commit().await.unwrap();
    w.close().await;
    assert_eq!(ids(d, path).await, ["3"]);
}

/// A writer opened on a Read-only Connection, bypassing the Core check: the server
/// refuses the INSERT.
async fn check_read_only_writer_refused_by_server(
    read_only: &dyn Dialect,
    database: Option<&str>,
    t: &str,
) {
    let mut w = open(read_only, database, &WriterSetup::default()).await;
    let result = async {
        w.begin().await?;
        w.run(&format!("INSERT INTO {t} (id, name) VALUES (1, 'a')"))
            .await
    }
    .await;
    assert!(matches!(result, Err(Error::ReadOnlyRefused)), "{result:?}");
    w.close().await;
}

mod mysql {
    use super::*;
    use crate::common::TestDb;
    use contura_core::mysql::MySqlDialect;

    const TABLE: &str = "CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(20))";

    async fn setup() -> (TestDb, Arc<dyn Dialect>, ObjectPath) {
        let db = TestDb::create().await;
        let d = connect(&db.config, db.password.as_deref())
            .await
            .expect("connect");
        run_sql(d.as_ref(), TABLE).await;
        let path = ObjectPath {
            database: db.name.clone(),
            schema: None,
            name: "t".into(),
        };
        (db, d, path)
    }

    #[tokio::test]
    async fn commit_keeps_rows() {
        let (db, d, path) = setup().await;
        check_commit_keeps_rows(d.as_ref(), Some(&db.name), &path, "t").await;
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn rollback_leaves_nothing() {
        let (db, d, path) = setup().await;
        check_rollback_leaves_nothing(d.as_ref(), Some(&db.name), &path, "t").await;
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn savepoint_rollback_keeps_earlier() {
        let (db, d, path) = setup().await;
        check_savepoint_rollback_keeps_earlier(d.as_ref(), Some(&db.name), &path, "t").await;
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn setup_runs_before_begin_and_after_commit() {
        let (db, d, path) = setup().await;
        check_setup_runs_before_begin_and_after_commit(d.as_ref(), Some(&db.name), &path, "t")
            .await;
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn failing_after_is_after_commit() {
        let (db, d, path) = setup().await;
        check_failing_after_is_after_commit(d.as_ref(), Some(&db.name), &path, "t").await;
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn read_only_writer_refused_by_server() {
        let (db, d, path) = setup().await;
        let config = ConnectionConfig {
            read_only: true,
            ..db.config.clone()
        };
        let ro = connect(&config, db.password.as_deref()).await.unwrap();
        check_read_only_writer_refused_by_server(ro.as_ref(), Some(&db.name), "t").await;
        assert!(ids(d.as_ref(), &path).await.is_empty());
        ro.disconnect().await.ok();
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn run_takes_one_statement() {
        let (db, d, path) = setup().await;
        check_run_takes_one_statement(d.as_ref(), Some(&db.name), &path, "t").await;
        d.disconnect().await.ok();
    }

    /// A routine, trigger or event body (BEGIN ... END holding `;`) cannot be
    /// prepared and runs as text: the server parsed it as one statement.
    #[tokio::test]
    async fn routine_bodies_run() {
        let (db, d, path) = setup().await;
        let mut w = open(d.as_ref(), Some(&db.name), &WriterSetup::default()).await;
        for sql in [
            "CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END",
            "CREATE TRIGGER t_bi BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.name = UPPER(NEW.name); SET NEW.id = NEW.id + 0; END",
            "CREATE EVENT e ON SCHEDULE AT CURRENT_TIMESTAMP + INTERVAL 1 DAY DISABLE DO BEGIN DELETE FROM t WHERE id < 0; DELETE FROM t WHERE id < -1; END",
        ] {
            if let Err(e) = w.run(sql).await {
                panic!("{sql}: {e}");
            }
        }
        w.begin().await.unwrap();
        w.run("INSERT INTO t (id, name) VALUES (1, 'a')")
            .await
            .unwrap();
        w.commit().await.unwrap();
        w.close().await;
        assert_eq!(ids(d.as_ref(), &path).await, ["1"]);
        d.disconnect().await.ok();
    }

    /// Two statements are still refused, and the second never runs.
    #[tokio::test]
    async fn select_then_drop_refused_table_intact() {
        let (db, d, path) = setup().await;
        let mut w = open(d.as_ref(), Some(&db.name), &WriterSetup::default()).await;
        assert!(w.run("SELECT 1; DROP TABLE t").await.is_err());
        w.close().await;
        assert!(ids(d.as_ref(), &path).await.is_empty(), "t is still there");
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn mysql_statement_limit_is_half_packet() {
        let db = TestDb::create().await;
        let d = MySqlDialect::connect(&db.config, db.password.as_deref())
            .await
            .unwrap();
        let packet: usize = d
            .browse_first_for_test("SELECT @@max_allowed_packet")
            .await
            .unwrap()
            .unwrap()
            .parse()
            .unwrap();
        let w = d
            .open_bulk_writer(Some(&db.name), &WriterSetup::default())
            .await
            .unwrap();
        assert_eq!(w.statement_limit(), packet / 2);
        w.close().await;
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn writer_speaks_utf8mb4() {
        let (db, d, path) = setup().await;
        let mut w = open(d.as_ref(), Some(&db.name), &WriterSetup::default()).await;
        w.begin().await.unwrap();
        w.run("INSERT INTO t (id, name) VALUES (1, '\u{1F600}')")
            .await
            .unwrap();
        w.commit().await.unwrap();
        w.close().await;
        let page = d
            .fetch_page(&PageRequest {
                table: path,
                page: 0,
                sort: None,
                filter: None,
            })
            .await
            .unwrap();
        assert!(
            matches!(&page.rows[0][1], Cell::Text { value, .. } if value == "\u{1F600}"),
            "{:?}",
            page.rows[0][1]
        );
        d.disconnect().await.ok();
    }
}

mod postgres {
    use super::*;
    use crate::common::pg::PgTestDb;

    const TABLE: &str = "CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(20))";

    async fn setup() -> (PgTestDb, Arc<dyn Dialect>, ObjectPath) {
        let db = PgTestDb::create().await;
        let d = connect(&db.config, db.password.as_deref())
            .await
            .expect("connect");
        run_sql(d.as_ref(), TABLE).await;
        let path = ObjectPath {
            database: db.name.clone(),
            schema: Some("public".into()),
            name: "t".into(),
        };
        (db, d, path)
    }

    #[tokio::test]
    async fn commit_keeps_rows() {
        let (db, d, path) = setup().await;
        check_commit_keeps_rows(d.as_ref(), Some(&db.name), &path, "t").await;
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn rollback_leaves_nothing() {
        let (db, d, path) = setup().await;
        check_rollback_leaves_nothing(d.as_ref(), Some(&db.name), &path, "t").await;
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn savepoint_rollback_keeps_earlier() {
        let (db, d, path) = setup().await;
        check_savepoint_rollback_keeps_earlier(d.as_ref(), Some(&db.name), &path, "t").await;
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn setup_runs_before_begin_and_after_commit() {
        let (db, d, path) = setup().await;
        check_setup_runs_before_begin_and_after_commit(d.as_ref(), Some(&db.name), &path, "t")
            .await;
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn failing_after_is_after_commit() {
        let (db, d, path) = setup().await;
        check_failing_after_is_after_commit(d.as_ref(), Some(&db.name), &path, "t").await;
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn read_only_writer_refused_by_server() {
        let (db, d, path) = setup().await;
        let config = ConnectionConfig {
            read_only: true,
            ..db.config.clone()
        };
        let ro = connect(&config, db.password.as_deref()).await.unwrap();
        check_read_only_writer_refused_by_server(ro.as_ref(), Some(&db.name), "t").await;
        assert!(ids(d.as_ref(), &path).await.is_empty());
        ro.disconnect().await.ok();
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn run_takes_one_statement() {
        let (db, d, path) = setup().await;
        check_run_takes_one_statement(d.as_ref(), Some(&db.name), &path, "t").await;
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn statement_limit_is_unbounded() {
        let (db, d, _) = setup().await;
        let w = open(d.as_ref(), Some(&db.name), &WriterSetup::default()).await;
        assert_eq!(w.statement_limit(), usize::MAX);
        w.close().await;
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn pg_identity_always_read() {
        let db = PgTestDb::create().await;
        let d = connect(&db.config, db.password.as_deref())
            .await
            .expect("connect");
        run_sql(
            d.as_ref(),
            "CREATE TABLE ids (a int GENERATED ALWAYS AS IDENTITY, \
             b int GENERATED BY DEFAULT AS IDENTITY, c serial, d int)",
        )
        .await;
        let design = d
            .table_design(&ObjectPath {
                database: db.name.clone(),
                schema: Some("public".into()),
                name: "ids".into(),
            })
            .await
            .unwrap();
        let always: Vec<(&str, bool)> = design
            .columns
            .iter()
            .map(|c| (c.name.as_str(), c.identity_always))
            .collect();
        assert_eq!(
            always,
            [("a", true), ("b", false), ("c", false), ("d", false)]
        );
        d.disconnect().await.ok();
    }
}

mod sqlite {
    use super::*;
    use contura_core::model::{DialectKind, SslMode};

    fn config(file: std::path::PathBuf, read_only: bool) -> ConnectionConfig {
        ConnectionConfig {
            id: uuid::Uuid::new_v4(),
            name: "t".into(),
            dialect: DialectKind::Sqlite,
            host: String::new(),
            port: 0,
            user: String::new(),
            database: None,
            ssl: SslMode::Disable,
            group_id: None,
            file: Some(file),
            query_timeout_secs: None,
            ai_access: Default::default(),
            ai_sync: Default::default(),
            production: false,
            read_only,
        }
    }

    async fn setup() -> (tempfile::TempDir, Arc<dyn Dialect>, ObjectPath) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("w.sqlite");
        rusqlite::Connection::open(&file)
            .unwrap()
            .execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
            .unwrap();
        let d = connect(&config(file, false), None).await.expect("connect");
        let path = ObjectPath {
            database: "main".into(),
            schema: None,
            name: "t".into(),
        };
        (dir, d, path)
    }

    #[tokio::test]
    async fn run_takes_one_statement() {
        let (_dir, d, path) = setup().await;
        check_run_takes_one_statement(d.as_ref(), None, &path, "t").await;
    }

    #[tokio::test]
    async fn commit_keeps_rows() {
        let (_dir, d, path) = setup().await;
        check_commit_keeps_rows(d.as_ref(), None, &path, "t").await;
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn rollback_leaves_nothing() {
        let (_dir, d, path) = setup().await;
        check_rollback_leaves_nothing(d.as_ref(), None, &path, "t").await;
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn savepoint_rollback_keeps_earlier() {
        let (_dir, d, path) = setup().await;
        check_savepoint_rollback_keeps_earlier(d.as_ref(), None, &path, "t").await;
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn setup_runs_before_begin_and_after_commit() {
        let (_dir, d, path) = setup().await;
        check_setup_runs_before_begin_and_after_commit(d.as_ref(), None, &path, "t").await;
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn failing_after_is_after_commit() {
        let (_dir, d, path) = setup().await;
        check_failing_after_is_after_commit(d.as_ref(), None, &path, "t").await;
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn read_only_writer_refused_by_server() {
        let (dir, d, path) = setup().await;
        let ro = connect(&config(dir.path().join("w.sqlite"), true), None)
            .await
            .unwrap();
        check_read_only_writer_refused_by_server(ro.as_ref(), None, "t").await;
        assert!(ids(d.as_ref(), &path).await.is_empty());
        ro.disconnect().await.ok();
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn statement_limit_is_unbounded() {
        let (_dir, d, _) = setup().await;
        let w = open(d.as_ref(), None, &WriterSetup::default()).await;
        assert_eq!(w.statement_limit(), usize::MAX);
        w.close().await;
        d.disconnect().await.ok();
    }

    #[tokio::test]
    async fn sqlite_second_writer_gets_locked_message() {
        let (_dir, d, path) = setup().await;
        let mut first = open(d.as_ref(), None, &WriterSetup::default()).await;
        first.begin().await.unwrap();
        first
            .run("INSERT INTO t (id, name) VALUES (1, 'a')")
            .await
            .unwrap();
        let mut second = open(d.as_ref(), None, &WriterSetup::default()).await;
        match second.begin().await {
            Err(Error::Query(m)) => assert_eq!(
                m,
                "Another connection is writing to this file. Try again when it ends."
            ),
            other => panic!("expected the locked message, got {other:?}"),
        }
        second.close().await;
        first.commit().await.unwrap();
        first.close().await;
        assert_eq!(ids(d.as_ref(), &path).await, ["1"]);
        d.disconnect().await.ok();
    }
}
