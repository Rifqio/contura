//! Live tests for `Dialect::apply_statements`: a statement list run the 5c way.
//! PostgreSQL and SQLite run it in one transaction, MySQL statement by statement;
//! a cancel stops between statements.

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use contura_core::Error;
use contura_core::design::{RunMode, RunOutcome, StatementPlan, sqlite_pragma_frame};
use contura_core::dialect::Dialect;

struct Env {
    db: Arc<dyn Dialect>,
    database: String,
    /// `None` for MySQL and SQLite.
    schema: Option<String>,
}

impl Env {
    async fn run(&self, plan: &StatementPlan) -> contura_core::Result<RunOutcome> {
        self.db
            .apply_statements(&self.database, plan, Arc::new(AtomicBool::new(false)))
            .await
    }

    /// Runs `plan` with a cancel that is set while statement 1 (a slow one) runs.
    async fn run_cancelled(&self, plan: &StatementPlan) -> contura_core::Result<RunOutcome> {
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            flag.store(true, Ordering::SeqCst);
        });
        self.db.apply_statements(&self.database, plan, cancel).await
    }

    async fn tables(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .db
            .list_objects(&self.database, self.schema.as_deref())
            .await
            .expect("list objects")
            .into_iter()
            .map(|o| o.name)
            .collect();
        names.sort();
        names
    }
}

fn plan(mode: RunMode, statements: &[&str]) -> StatementPlan {
    StatementPlan {
        statements: statements.iter().map(|s| s.to_string()).collect(),
        mode,
        sqlite_pragmas: false,
    }
}

const CREATE_A: &str = "CREATE TABLE dbview_a (id int PRIMARY KEY)";
const CREATE_B: &str = "CREATE TABLE dbview_b (id int PRIMARY KEY)";
const CREATE_C: &str = "CREATE TABLE dbview_c (id int PRIMARY KEY)";
const BAD: &str = "CREATE INDEX dbview_nope_ix ON dbview_a (nope)";

async fn runs_every_statement(env: &Env, mode: RunMode) {
    let p = plan(mode, &[CREATE_A, CREATE_B]);
    assert_eq!(
        env.run(&p).await.expect("run"),
        RunOutcome { ran: 2, of: 2 }
    );
    assert_eq!(env.tables().await, ["dbview_a", "dbview_b"]);
}

/// The third statement fails: in a transaction nothing stays.
async fn failure_rolls_back(env: &Env) {
    let p = plan(RunMode::Transaction, &[CREATE_A, CREATE_B, BAD, CREATE_C]);
    match env.run(&p).await {
        Err(Error::DesignFailed {
            statement: 2,
            ran: 0,
            total: 4,
            message,
        }) => assert!(message.contains("nope"), "{message}"),
        other => panic!("expected DesignFailed at 2 with nothing run, got {other:?}"),
    }
    assert!(env.tables().await.is_empty());
}

/// A cancel during the slow statement 1 stops before statement 2 and rolls back.
async fn cancel_rolls_back(env: &Env, slow: &str) {
    let p = plan(RunMode::Transaction, &[CREATE_A, slow, CREATE_B]);
    assert_eq!(
        env.run_cancelled(&p).await.expect("run"),
        RunOutcome { ran: 0, of: 3 }
    );
    assert!(env.tables().await.is_empty());
}

mod mysql {
    use super::*;
    use crate::common::TestDb;
    use contura_core::dialect::connect;

    async fn fixture() -> (TestDb, Env) {
        let db = TestDb::create().await;
        let env = Env {
            db: connect(&db.config, db.password.as_deref())
                .await
                .expect("connect"),
            database: db.name.clone(),
            schema: None,
        };
        (db, env)
    }

    async fn finish(db: TestDb, env: Env) {
        env.db.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn apply_statements_modes_runs_every_statement() {
        let (db, env) = fixture().await;
        runs_every_statement(&env, RunMode::Sequential).await;
        finish(db, env).await;
    }

    /// "4 of 9 statements were applied. Statement 5 failed": the ones before stay.
    #[tokio::test]
    async fn apply_statements_modes_failure_keeps_what_ran() {
        let (db, env) = fixture().await;
        let p = plan(RunMode::Sequential, &[CREATE_A, CREATE_B, BAD, CREATE_C]);
        match env.run(&p).await {
            Err(Error::DesignFailed {
                statement: 2,
                ran: 2,
                total: 4,
                message,
            }) => assert!(message.contains("nope"), "{message}"),
            other => panic!("expected DesignFailed at 2 with 2 run, got {other:?}"),
        }
        assert_eq!(env.tables().await, ["dbview_a", "dbview_b"]);
        finish(db, env).await;
    }

    #[tokio::test]
    async fn apply_statements_modes_cancel_keeps_what_ran() {
        let (db, env) = fixture().await;
        let p = plan(RunMode::Sequential, &[CREATE_A, "DO SLEEP(1)", CREATE_B]);
        assert_eq!(
            env.run_cancelled(&p).await.expect("run"),
            RunOutcome { ran: 2, of: 3 }
        );
        assert_eq!(env.tables().await, ["dbview_a"]);
        finish(db, env).await;
    }

    #[tokio::test]
    async fn apply_statements_modes_transaction_is_refused() {
        let (db, env) = fixture().await;
        let p = plan(RunMode::Transaction, &[CREATE_A]);
        assert!(matches!(env.run(&p).await, Err(Error::InvalidInput(_))));
        assert!(env.tables().await.is_empty());
        finish(db, env).await;
    }
}

mod pg {
    use super::*;
    use crate::common::pg::PgTestDb;
    use contura_core::dialect::connect;

    async fn fixture() -> (PgTestDb, Env) {
        let db = PgTestDb::create().await;
        let env = Env {
            db: connect(&db.config, db.password.as_deref())
                .await
                .expect("connect"),
            database: db.name.clone(),
            schema: Some("public".into()),
        };
        (db, env)
    }

    async fn finish(db: PgTestDb, env: Env) {
        env.db.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn apply_statements_modes_runs_every_statement() {
        let (db, env) = fixture().await;
        runs_every_statement(&env, RunMode::Transaction).await;
        finish(db, env).await;
    }

    #[tokio::test]
    async fn apply_statements_modes_failure_rolls_back() {
        let (db, env) = fixture().await;
        failure_rolls_back(&env).await;
        finish(db, env).await;
    }

    #[tokio::test]
    async fn apply_statements_modes_cancel_rolls_back() {
        let (db, env) = fixture().await;
        cancel_rolls_back(&env, "DO $$ BEGIN PERFORM pg_sleep(1); END $$").await;
        finish(db, env).await;
    }

    #[tokio::test]
    async fn apply_statements_modes_sequential_is_refused() {
        let (db, env) = fixture().await;
        let p = plan(RunMode::Sequential, &[CREATE_A]);
        assert!(matches!(env.run(&p).await, Err(Error::InvalidInput(_))));
        assert!(env.tables().await.is_empty());
        finish(db, env).await;
    }
}

mod sqlite {
    use std::path::Path;

    use super::*;
    use contura_core::model::{ConnectionConfig, DialectKind, SslMode};
    use contura_core::sqlite::SqliteDialect;

    fn config(path: &Path) -> ConnectionConfig {
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
            file: Some(path.to_path_buf()),
            query_timeout_secs: None,
            ai_access: Default::default(),
            production: false,
            read_only: false,
        }
    }

    struct Lite {
        _dir: tempfile::TempDir,
        lite: Arc<SqliteDialect>,
        env: Env,
    }

    async fn fixture() -> Lite {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("statements.sqlite");
        rusqlite::Connection::open(&path).unwrap();
        let lite = Arc::new(
            SqliteDialect::connect(&config(&path))
                .await
                .expect("connect"),
        );
        lite.browse_execute_for_test("PRAGMA foreign_keys = ON")
            .await
            .unwrap();
        let env = Env {
            db: lite.clone(),
            database: "main".into(),
            schema: None,
        };
        Lite {
            _dir: dir,
            lite,
            env,
        }
    }

    /// A parent, a child, and a child row: an orphan when `parent` is 42.
    fn keyed(parent: i64) -> Vec<String> {
        vec![
            "CREATE TABLE dbview_p (id integer PRIMARY KEY)".into(),
            "CREATE TABLE dbview_c (id integer PRIMARY KEY, \
             p_id int REFERENCES dbview_p (id))"
                .into(),
            "INSERT INTO dbview_p VALUES (1)".into(),
            format!("INSERT INTO dbview_c VALUES (1, {parent})"),
        ]
    }

    #[tokio::test]
    async fn apply_statements_modes_runs_every_statement() {
        let t = fixture().await;
        runs_every_statement(&t.env, RunMode::Transaction).await;
    }

    #[tokio::test]
    async fn apply_statements_modes_failure_rolls_back() {
        let t = fixture().await;
        failure_rolls_back(&t.env).await;
    }

    #[tokio::test]
    async fn apply_statements_modes_cancel_rolls_back() {
        let t = fixture().await;
        // A count over ten million generated rows: long enough for the cancel.
        cancel_rolls_back(
            &t.env,
            "CREATE TABLE dbview_slow AS SELECT count(*) AS n FROM \
             (WITH RECURSIVE c(x) AS (VALUES (1) UNION ALL SELECT x + 1 FROM c \
             WHERE x < 10000000) SELECT x FROM c)",
        )
        .await;
    }

    #[test]
    fn the_pragma_frame() {
        assert_eq!(
            sqlite_pragma_frame(vec!["CREATE TABLE t (id int)".into()], true),
            [
                "PRAGMA foreign_keys = OFF",
                "CREATE TABLE t (id int)",
                "PRAGMA foreign_key_check",
                "PRAGMA foreign_keys = ON",
            ]
        );
        assert_eq!(
            sqlite_pragma_frame(vec![], false)
                .last()
                .map(String::as_str),
            Some("PRAGMA foreign_keys = OFF")
        );
    }

    #[tokio::test]
    async fn apply_statements_modes_pragmas_run_and_restore() {
        let t = fixture().await;
        let p = StatementPlan {
            statements: sqlite_pragma_frame(keyed(1), true),
            mode: RunMode::Transaction,
            sqlite_pragmas: true,
        };
        assert_eq!(
            t.env.run(&p).await.expect("run"),
            RunOutcome { ran: 7, of: 7 }
        );
        assert_eq!(t.env.tables().await, ["dbview_c", "dbview_p"]);
        assert_eq!(
            t.lite
                .browse_i64_for_test("PRAGMA foreign_keys")
                .await
                .unwrap(),
            1
        );
    }

    /// A row from `foreign_key_check` rolls back; the pragma is restored.
    #[tokio::test]
    async fn apply_statements_modes_foreign_key_check_row_rolls_back() {
        let t = fixture().await;
        let p = StatementPlan {
            statements: sqlite_pragma_frame(keyed(42), true),
            mode: RunMode::Transaction,
            sqlite_pragmas: true,
        };
        match t.env.run(&p).await {
            Err(Error::DesignForeignKeys { table }) => assert_eq!(table, "dbview_c"),
            other => panic!("expected DesignForeignKeys, got {other:?}"),
        }
        assert!(t.env.tables().await.is_empty());
        assert_eq!(
            t.lite
                .browse_i64_for_test("PRAGMA foreign_keys")
                .await
                .unwrap(),
            1
        );
    }

    /// The restore line must be the setting the Connection has now (S9).
    #[tokio::test]
    async fn apply_statements_modes_changed_foreign_keys_setting_is_refused() {
        let t = fixture().await;
        let p = StatementPlan {
            statements: sqlite_pragma_frame(keyed(1), false),
            mode: RunMode::Transaction,
            sqlite_pragmas: true,
        };
        assert!(matches!(t.env.run(&p).await, Err(Error::InvalidInput(_))));
        assert!(t.env.tables().await.is_empty());
    }

    /// `sqlite_pragmas` needs the frame's first and last lines.
    #[tokio::test]
    async fn apply_statements_modes_pragmas_without_the_frame_are_refused() {
        let t = fixture().await;
        let p = StatementPlan {
            statements: keyed(1),
            mode: RunMode::Transaction,
            sqlite_pragmas: true,
        };
        assert!(matches!(t.env.run(&p).await, Err(Error::InvalidInput(_))));
        assert!(t.env.tables().await.is_empty());
    }
}
