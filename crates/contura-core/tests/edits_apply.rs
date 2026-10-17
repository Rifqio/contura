//! Live tests for `Dialect::apply_planned`: a planned save runs in one transaction.

mod common;

use std::future::Future;
use std::sync::Arc;

use contura_core::dialect::Dialect;
use contura_core::edits::{
    CellChange, EditSet, NewValue, RowDelete, RowInsert, RowUpdate, TxOutcome, plan_edits,
};
use contura_core::error::Error;
use contura_core::model::{
    Cell, ColumnInfo, DialectKind, KeyPart, ObjectPath, PageRequest, SortSpec,
};

const AWKWARD: &str = "it's \\ \"x\"\nline 2 😀";

struct Env {
    db: Arc<dyn Dialect>,
    kind: DialectKind,
    database: String,
    /// `None` for MySQL and SQLite.
    schema: Option<String>,
}

impl Env {
    fn path(&self, name: &str) -> ObjectPath {
        ObjectPath {
            database: self.database.clone(),
            schema: self.schema.clone(),
            name: name.into(),
        }
    }

    async fn page(&self, name: &str) -> (Vec<ColumnInfo>, Vec<Vec<Cell>>) {
        let page = self
            .db
            .fetch_page(&PageRequest {
                table: self.path(name),
                page: 0,
                sort: Some(SortSpec {
                    column: "id".into(),
                    descending: false,
                }),
                filter: None,
            })
            .await
            .expect("fetch page");
        (page.columns, page.rows)
    }

    /// Every row as text, NULL as `None`.
    async fn rows(&self, name: &str) -> Vec<Vec<Option<String>>> {
        let (_, rows) = self.page(name).await;
        rows.iter()
            .map(|r| r.iter().map(text_of).collect())
            .collect()
    }

    async fn value(&self, name: &str, id: i64, column: &str) -> Cell {
        let (columns, rows) = self.page(name).await;
        let at = columns.iter().position(|c| c.name == column).unwrap();
        rows.into_iter()
            .find(|r| text_of(&r[0]) == Some(id.to_string()))
            .map(|r| r[at].clone())
            .unwrap_or_else(|| panic!("no row {id}"))
    }

    async fn plan(&self, name: &str, edits: EditSet) -> Vec<contura_core::edits::PlannedEdit> {
        let (columns, _) = self.page(name).await;
        plan_edits(self.kind, &columns, &edits).expect("plan")
    }

    async fn apply(&self, name: &str, edits: EditSet) -> contura_core::Result<TxOutcome> {
        let plan = self.plan(name, edits).await;
        self.db.apply_planned(&self.database, &plan).await
    }

    fn set(&self, updates: Vec<RowUpdate>, inserts: Vec<RowInsert>, deletes: Vec<i64>) -> EditSet {
        EditSet {
            table: self.path("orders"),
            updates,
            inserts,
            deletes: deletes
                .into_iter()
                .map(|id| RowDelete { key: key(id) })
                .collect(),
        }
    }
}

fn text_of(cell: &Cell) -> Option<String> {
    match cell {
        Cell::Null => None,
        Cell::Number { value } | Cell::Text { value, .. } => Some(value.clone()),
        Cell::Bytes { .. } => panic!("unexpected binary cell"),
    }
}

fn key(id: i64) -> Vec<KeyPart> {
    vec![KeyPart {
        column: "id".into(),
        value: Cell::Number {
            value: id.to_string(),
        },
    }]
}

fn nv(v: &str) -> NewValue {
    NewValue::Text { value: v.into() }
}

fn update(id: i64, changes: Vec<(&str, Cell, NewValue)>) -> RowUpdate {
    RowUpdate {
        key: key(id),
        changes: changes
            .into_iter()
            .map(|(column, old, new)| CellChange {
                column: column.into(),
                old,
                new,
            })
            .collect(),
    }
}

fn insert(values: &[(&str, &str)]) -> RowInsert {
    RowInsert {
        values: values.iter().map(|(c, v)| (c.to_string(), nv(v))).collect(),
    }
}

fn ids(rows: &[Vec<Option<String>>]) -> Vec<String> {
    rows.iter().map(|r| r[0].clone().unwrap()).collect()
}

// Columns: id, status, total, note, score[, data].

async fn commits_updates_inserts_and_deletes(env: &Env) {
    let old = env.value("orders", 1, "status").await;
    let set = env.set(
        vec![update(1, vec![("status", old, nv("shipped"))])],
        vec![insert(&[("id", "4"), ("status", "new"), ("total", "4.00")])],
        vec![3],
    );
    let outcome = env.apply("orders", set).await.expect("apply");
    assert_eq!(
        outcome,
        TxOutcome::Committed {
            rows: vec![1, 1, 1]
        }
    );
    let rows = env.rows("orders").await;
    assert_eq!(ids(&rows), ["1", "2", "4"]);
    assert_eq!(rows[0][1].as_deref(), Some("shipped"));
    assert_eq!(rows[2][1].as_deref(), Some("new"));
}

async fn round_trips_awkward_text(env: &Env) {
    let old = env.value("orders", 1, "note").await;
    let set = env.set(
        vec![update(1, vec![("note", old, nv(AWKWARD))])],
        vec![insert(&[("id", "5"), ("note", AWKWARD)])],
        vec![],
    );
    let outcome = env.apply("orders", set).await.expect("apply");
    assert_eq!(outcome, TxOutcome::Committed { rows: vec![1, 1] });
    assert_eq!(
        text_of(&env.value("orders", 1, "note").await).as_deref(),
        Some(AWKWARD)
    );
    assert_eq!(
        text_of(&env.value("orders", 5, "note").await).as_deref(),
        Some(AWKWARD)
    );
}

/// `behind` changes row 1's status to `shipped` after the plan is made.
async fn row_changed_rolls_back(env: &Env, behind: impl Future<Output = ()>) {
    let old = env.value("orders", 1, "status").await;
    assert_eq!(text_of(&old).as_deref(), Some("paid"));
    let set = env.set(
        vec![update(1, vec![("status", old, nv("done"))])],
        vec![insert(&[("id", "6"), ("status", "new")])],
        vec![2],
    );
    let plan = env.plan("orders", set).await;
    behind.await;
    let outcome = env
        .db
        .apply_planned(&env.database, &plan)
        .await
        .expect("apply");
    assert_eq!(
        outcome,
        TxOutcome::RowCount {
            statement: 1,
            rows: 0
        }
    );
    let rows = env.rows("orders").await;
    assert_eq!(
        ids(&rows),
        ["1", "2", "3"],
        "the delete and the insert rolled back"
    );
    assert_eq!(rows[0][1].as_deref(), Some("shipped"));
}

async fn server_error_rolls_back(env: &Env, bad: RowInsert) {
    let before = env.rows("orders").await;
    let old = env.value("orders", 1, "status").await;
    let set = env.set(
        vec![update(1, vec![("status", old, nv("x"))])],
        vec![bad],
        vec![],
    );
    let outcome = env.apply("orders", set).await.expect("apply");
    match outcome {
        TxOutcome::Failed { statement, message } => {
            assert_eq!(statement, 1);
            assert!(!message.is_empty());
        }
        other => panic!("expected Failed, got {other:?}"),
    }
    // A page fetch after the failure works and shows nothing changed.
    assert_eq!(env.rows("orders").await, before);
}

async fn read_only_refuses(rw: &Env, ro: &Env) {
    let before = rw.rows("orders").await;
    let old = ro.value("orders", 1, "status").await;
    let set = ro.set(
        vec![update(1, vec![("status", old, nv("shipped"))])],
        vec![insert(&[("id", "9")])],
        vec![],
    );
    match ro.apply("orders", set).await {
        Err(Error::ReadOnlyRefused) => {}
        other => panic!("expected ReadOnlyRefused, got {other:?}"),
    }
    assert_eq!(rw.rows("orders").await, before);
}

/// An old value as the grid shows it compares equal on the server.
async fn timestamp_old_value_matches(env: &Env) {
    let old = env.value("events", 1, "at").await;
    let set = EditSet {
        table: env.path("events"),
        updates: vec![update(
            1,
            vec![("at", old.clone(), nv("2025-05-06 07:08:09"))],
        )],
        inserts: vec![],
        deletes: vec![],
    };
    let outcome = env.apply("events", set).await.expect("apply");
    assert_eq!(
        outcome,
        TxOutcome::Committed { rows: vec![1] },
        "old cell was {old:?}"
    );
}

mod mysql {
    use super::*;
    use crate::common::TestDb;
    use contura_core::dialect::connect;
    use mysql_async::prelude::Queryable;
    use mysql_async::{Opts, OptsBuilder, Pool};

    async fn exec(db: &TestDb, sqls: &[&str]) {
        let opts: Opts = OptsBuilder::default()
            .ip_or_hostname(db.config.host.clone())
            .tcp_port(db.config.port)
            .user(Some(db.config.user.clone()))
            .pass(db.password.clone())
            .db_name(Some(db.name.clone()))
            .into();
        let pool = Pool::new(opts);
        let mut conn = pool.get_conn().await.expect("connect to test MySQL");
        for sql in sqls {
            conn.query_drop(*sql)
                .await
                .unwrap_or_else(|e| panic!("{sql}: {e}"));
        }
        drop(conn);
        pool.disconnect().await.ok();
    }

    async fn env_for(db: &TestDb, read_only: bool) -> Env {
        let mut config = db.config.clone();
        config.read_only = read_only;
        Env {
            db: connect(&config, db.password.as_deref())
                .await
                .expect("connect"),
            kind: DialectKind::MySql,
            database: db.name.clone(),
            schema: None,
        }
    }

    async fn fixture() -> (TestDb, Env) {
        let db = TestDb::create().await;
        exec(
            &db,
            &[
                "CREATE TABLE orders (id bigint PRIMARY KEY, status varchar(32), total decimal(10,2), \
                 note text, score double)",
                "INSERT INTO orders VALUES (1, 'paid', 1.00, 'first', 1.5), (2, 'new', 2.50, NULL, NULL), \
                 (3, 'paid', 3.00, 'third', 3.25)",
                "CREATE TABLE events (id bigint PRIMARY KEY, at datetime)",
                "INSERT INTO events VALUES (1, '2024-01-02 03:04:05')",
            ],
        )
        .await;
        let env = env_for(&db, false).await;
        (db, env)
    }

    #[tokio::test]
    async fn commits_updates_inserts_and_deletes() {
        let (db, env) = fixture().await;
        super::commits_updates_inserts_and_deletes(&env).await;
        db.drop_db().await;
    }

    #[tokio::test]
    async fn round_trips_awkward_text() {
        let (db, env) = fixture().await;
        super::round_trips_awkward_text(&env).await;
        db.drop_db().await;
    }

    #[tokio::test]
    async fn row_changed_rolls_back() {
        let (db, env) = fixture().await;
        super::row_changed_rolls_back(
            &env,
            exec(&db, &["UPDATE orders SET status = 'shipped' WHERE id = 1"]),
        )
        .await;
        db.drop_db().await;
    }

    #[tokio::test]
    async fn server_error_rolls_back() {
        let (db, env) = fixture().await;
        super::server_error_rolls_back(&env, insert(&[("id", "7"), ("total", "abc")])).await;
        db.drop_db().await;
    }

    #[tokio::test]
    async fn decimal_same_value_counts() {
        let (db, env) = fixture().await;
        let old = env.value("orders", 1, "total").await;
        assert_eq!(text_of(&old).as_deref(), Some("1.00"));
        let set = env.set(
            vec![update(1, vec![("total", old, nv("1"))])],
            vec![],
            vec![],
        );
        let outcome = env.apply("orders", set).await.expect("apply");
        assert_eq!(outcome, TxOutcome::Committed { rows: vec![1] });
        db.drop_db().await;
    }

    #[tokio::test]
    async fn read_only_refuses() {
        let (db, env) = fixture().await;
        let ro = env_for(&db, true).await;
        super::read_only_refuses(&env, &ro).await;
        db.drop_db().await;
    }

    #[tokio::test]
    async fn timestamp_old_value_matches() {
        let (db, env) = fixture().await;
        super::timestamp_old_value_matches(&env).await;
        db.drop_db().await;
    }
}

mod pg {
    use super::*;
    use crate::common::pg::{PgTestDb, pg_admin_client};
    use contura_core::dialect::connect;

    async fn exec(db: &PgTestDb, sql: &str) {
        let client = pg_admin_client(&db.name).await;
        client
            .batch_execute(sql)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }

    async fn env_for(db: &PgTestDb, read_only: bool) -> Env {
        let mut config = db.config.clone();
        config.read_only = read_only;
        Env {
            db: connect(&config, db.password.as_deref())
                .await
                .expect("connect"),
            kind: DialectKind::Postgres,
            database: db.name.clone(),
            schema: Some("public".into()),
        }
    }

    async fn fixture() -> (PgTestDb, Env) {
        let db = PgTestDb::create().await;
        exec(
            &db,
            "CREATE TABLE public.orders (id bigint PRIMARY KEY, status varchar(32), total decimal(10,2),
                 note text, score double precision, data jsonb);
             INSERT INTO public.orders VALUES (1, 'paid', 1.00, 'first', 1.5, '{\"a\": 1}'),
                 (2, 'new', 2.50, NULL, NULL, NULL), (3, 'paid', 3.00, 'third', 3.25, '[1, 2]');
             CREATE TABLE public.events (id bigint PRIMARY KEY, at timestamptz);
             INSERT INTO public.events VALUES (1, '2024-01-02 03:04:05.123456+07');",
        )
        .await;
        let env = env_for(&db, false).await;
        (db, env)
    }

    #[tokio::test]
    async fn commits_updates_inserts_and_deletes() {
        let (db, env) = fixture().await;
        super::commits_updates_inserts_and_deletes(&env).await;
        db.drop_db().await;
    }

    #[tokio::test]
    async fn round_trips_awkward_text() {
        let (db, env) = fixture().await;
        super::round_trips_awkward_text(&env).await;
        db.drop_db().await;
    }

    #[tokio::test]
    async fn row_changed_rolls_back() {
        let (db, env) = fixture().await;
        super::row_changed_rolls_back(
            &env,
            exec(
                &db,
                "UPDATE public.orders SET status = 'shipped' WHERE id = 1",
            ),
        )
        .await;
        db.drop_db().await;
    }

    #[tokio::test]
    async fn server_error_rolls_back() {
        let (db, env) = fixture().await;
        super::server_error_rolls_back(&env, insert(&[("id", "7"), ("total", "abc")])).await;
        db.drop_db().await;
    }

    #[tokio::test]
    async fn jsonb_and_double_edit() {
        let (db, env) = fixture().await;
        let data = env.value("orders", 1, "data").await;
        let score = env.value("orders", 1, "score").await;
        let set = env.set(
            vec![update(
                1,
                vec![
                    ("data", data, nv("{\"b\": [2, 3]}")),
                    ("score", score, nv("2.25")),
                ],
            )],
            vec![],
            vec![],
        );
        let outcome = env.apply("orders", set).await.expect("apply");
        assert_eq!(outcome, TxOutcome::Committed { rows: vec![1] });
        assert_eq!(
            text_of(&env.value("orders", 1, "data").await).as_deref(),
            Some("{\"b\": [2, 3]}")
        );
        assert_eq!(
            text_of(&env.value("orders", 1, "score").await).as_deref(),
            Some("2.25")
        );
        db.drop_db().await;
    }

    #[tokio::test]
    async fn read_only_refuses() {
        let (db, env) = fixture().await;
        let ro = env_for(&db, true).await;
        super::read_only_refuses(&env, &ro).await;
        db.drop_db().await;
    }

    #[tokio::test]
    async fn timestamp_old_value_matches() {
        let (db, env) = fixture().await;
        super::timestamp_old_value_matches(&env).await;
        db.drop_db().await;
    }
}

mod sqlite {
    use std::path::{Path, PathBuf};

    use super::*;
    use contura_core::dialect::connect;
    use contura_core::model::{ConnectionConfig, SslMode};

    async fn exec(path: PathBuf, sql: &'static str) {
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.execute_batch(sql).unwrap();
    }

    async fn env_for(path: &Path, read_only: bool) -> Env {
        let config = ConnectionConfig {
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
            read_only,
        };
        Env {
            db: connect(&config, None).await.expect("connect"),
            kind: DialectKind::Sqlite,
            database: "main".into(),
            schema: None,
        }
    }

    async fn fixture() -> (tempfile::TempDir, PathBuf, Env) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("edits.sqlite");
        exec(
            path.clone(),
            "CREATE TABLE orders (id bigint PRIMARY KEY, status varchar(32), total decimal(10,2),
                 note text, score real);
             INSERT INTO orders VALUES (1, 'paid', 1.00, 'first', 1.5), (2, 'new', 2.50, NULL, NULL),
                 (3, 'paid', 3.00, 'third', 3.25);
             CREATE TABLE events (id bigint PRIMARY KEY, at text);
             INSERT INTO events VALUES (1, '2024-01-02 03:04:05');",
        )
        .await;
        let env = env_for(&path, false).await;
        (dir, path, env)
    }

    #[tokio::test]
    async fn commits_updates_inserts_and_deletes() {
        let (_dir, _path, env) = fixture().await;
        super::commits_updates_inserts_and_deletes(&env).await;
    }

    #[tokio::test]
    async fn round_trips_awkward_text() {
        let (_dir, _path, env) = fixture().await;
        super::round_trips_awkward_text(&env).await;
    }

    #[tokio::test]
    async fn row_changed_rolls_back() {
        let (_dir, path, env) = fixture().await;
        super::row_changed_rolls_back(
            &env,
            exec(path, "UPDATE orders SET status = 'shipped' WHERE id = 1"),
        )
        .await;
    }

    /// SQLite stores `'abc'` in a decimal column, so a duplicate key is the server error here.
    #[tokio::test]
    async fn server_error_rolls_back() {
        let (_dir, _path, env) = fixture().await;
        super::server_error_rolls_back(&env, insert(&[("id", "2"), ("status", "dup")])).await;
    }

    #[tokio::test]
    async fn read_only_refuses() {
        let (_dir, path, env) = fixture().await;
        let ro = env_for(&path, true).await;
        super::read_only_refuses(&env, &ro).await;
    }

    #[tokio::test]
    async fn timestamp_old_value_matches() {
        let (_dir, _path, env) = fixture().await;
        super::timestamp_old_value_matches(&env).await;
    }

    /// A reader on another connection holds its SHARED lock, so COMMIT (which needs
    /// EXCLUSIVE in rollback-journal mode) gives SQLITE_BUSY after the busy timeout.
    /// The save must still leave the shared browse connection with no transaction open.
    #[tokio::test]
    async fn busy_commit_leaves_no_open_transaction() {
        let (_dir, path, env) = fixture().await;
        let before = env.rows("orders").await;
        let reader = rusqlite::Connection::open(&path).unwrap();
        reader.execute_batch("BEGIN").unwrap();
        let _: i64 = reader
            .query_row("SELECT count(*) FROM orders", [], |r| r.get(0))
            .unwrap();
        let old = env.value("orders", 1, "status").await;
        let set = env.set(
            vec![update(1, vec![("status", old.clone(), nv("shipped"))])],
            vec![],
            vec![],
        );
        assert!(
            env.apply("orders", set.clone()).await.is_err(),
            "COMMIT should fail while the reader holds its lock"
        );
        reader.execute_batch("COMMIT").unwrap();
        drop(reader);
        assert_eq!(
            env.rows("orders").await,
            before,
            "the browse connection must not show the uncommitted edit"
        );
        let outcome = env.apply("orders", set).await.expect("second apply");
        assert_eq!(outcome, TxOutcome::Committed { rows: vec![1] });
    }

    /// `ON CONFLICT ROLLBACK` ends the transaction inside SQLite; the failure is still
    /// `Failed`, and the earlier insert did not land.
    #[tokio::test]
    async fn auto_rollback_error_is_failed() {
        let (_dir, path, env) = fixture().await;
        exec(
            path,
            "CREATE TABLE rb (id bigint PRIMARY KEY ON CONFLICT ROLLBACK, v text);
             INSERT INTO rb VALUES (1, 'one');",
        )
        .await;
        let set = EditSet {
            table: env.path("rb"),
            updates: vec![],
            inserts: vec![insert(&[("id", "2")]), insert(&[("id", "1")])],
            deletes: vec![],
        };
        match env.apply("rb", set).await.expect("apply") {
            TxOutcome::Failed { statement, .. } => assert_eq!(statement, 1),
            other => panic!("expected Failed, got {other:?}"),
        }
        assert_eq!(ids(&env.rows("rb").await), ["1"]);
        let again = EditSet {
            table: env.path("rb"),
            updates: vec![],
            inserts: vec![insert(&[("id", "3")])],
            deletes: vec![],
        };
        assert_eq!(
            env.apply("rb", again).await.expect("apply"),
            TxOutcome::Committed { rows: vec![1] }
        );
    }
}
