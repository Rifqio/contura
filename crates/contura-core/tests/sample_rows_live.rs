//! Step 11f: the read-only sample path, per Dialect. Rows are read in a read-only
//! transaction, base tables only, and a write through the same setup is refused.

mod common;

use common::TestDb;
use common::pg::{PgTestDb, pg_admin_client};
use contura_core::dialect::Dialect;
use contura_core::error::Error;
use contura_core::model::{Cell, ConnectionConfig, DialectKind, ObjectPath, Page, SslMode};
use contura_core::mysql::MySqlDialect;
use contura_core::postgres::PostgresDialect;
use contura_core::sqlite::SqliteDialect;
use mysql_async::prelude::Queryable;
use mysql_async::{Opts, OptsBuilder, Pool};

fn path(database: &str, schema: Option<&str>, name: &str) -> ObjectPath {
    ObjectPath {
        database: database.into(),
        schema: schema.map(Into::into),
        name: name.into(),
    }
}

fn numbers(page: &Page, column: usize) -> Vec<String> {
    page.rows
        .iter()
        .map(|r| match &r[column] {
            Cell::Number { value } => value.clone(),
            other => panic!("expected a number, got {other:?}"),
        })
        .collect()
}

// ---------------------------------------------------------------- PostgreSQL

async fn pg_fixture() -> (PgTestDb, PostgresDialect) {
    let db = PgTestDb::create().await;
    let admin = pg_admin_client(&db.name).await;
    admin
        .batch_execute(
            "CREATE TABLE public.t (id int PRIMARY KEY, name text, extra text);
             INSERT INTO public.t SELECT g, 'n' || g, NULL FROM generate_series(1, 7) g;
             CREATE VIEW public.v AS SELECT id FROM public.t;
             CREATE TABLE public.bin (id int PRIMARY KEY, data bytea, note text);
             INSERT INTO public.bin VALUES (1, '\\x00ff10'::bytea, NULL);",
        )
        .await
        .expect("seed");
    drop(admin);
    let dialect = PostgresDialect::connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    (db, dialect)
}

#[tokio::test]
async fn pg_samples_five_rows() {
    let (db, d) = pg_fixture().await;
    let page = d
        .sample_rows(&path(&db.name, Some("public"), "t"), 5)
        .await
        .unwrap();
    assert_eq!(page.rows.len(), 5);
    let names: Vec<_> = page.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["id", "name", "extra"]);
    assert!(!page.has_more);
    drop(d);
    db.drop_db().await;
}

#[tokio::test]
async fn pg_view_is_refused() {
    let (db, d) = pg_fixture().await;
    let err = d
        .sample_rows(&path(&db.name, Some("public"), "v"), 5)
        .await
        .unwrap_err();
    assert!(matches!(err, Error::InvalidInput(_)), "{err:?}");
    drop(d);
    db.drop_db().await;
}

#[tokio::test]
async fn pg_missing_table_not_found() {
    let (db, d) = pg_fixture().await;
    let err = d
        .sample_rows(&path(&db.name, Some("public"), "nope"), 5)
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NotFound(_)), "{err:?}");
    drop(d);
    db.drop_db().await;
}

#[tokio::test]
async fn pg_binary_and_null_cells() {
    let (db, d) = pg_fixture().await;
    let page = d
        .sample_rows(&path(&db.name, Some("public"), "bin"), 5)
        .await
        .unwrap();
    assert!(
        matches!(page.rows[0][1], Cell::Bytes { .. }),
        "{:?}",
        page.rows[0][1]
    );
    assert!(matches!(page.rows[0][2], Cell::Null));
    drop(d);
    db.drop_db().await;
}

#[tokio::test]
async fn pg_sample_session_refuses_writes() {
    let (db, d) = pg_fixture().await;
    let err = d
        .sample_probe(&db.name, "INSERT INTO public.t (id) VALUES (99)")
        .await
        .unwrap_err();
    // SQLSTATE 25006 is mapped to ReadOnlyRefused.
    assert!(matches!(err, Error::ReadOnlyRefused), "{err:?}");
    let admin = pg_admin_client(&db.name).await;
    let n: i64 = admin
        .query_one("SELECT count(*) FROM public.t", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(n, 7);
    drop(admin);
    drop(d);
    db.drop_db().await;
}

#[tokio::test]
async fn pg_sample_timeout_holds() {
    let (db, d) = pg_fixture().await;
    let started = std::time::Instant::now();
    let err = d.sample_probe(&db.name, "SELECT pg_sleep(6)").await;
    assert!(err.is_err());
    assert!(
        started.elapsed() < std::time::Duration::from_millis(5_900),
        "took {:?}",
        started.elapsed()
    );
    drop(d);
    db.drop_db().await;
}

// -------------------------------------------------------------------- MySQL

async fn my_pool(db: &TestDb) -> Pool {
    let opts: Opts = OptsBuilder::default()
        .ip_or_hostname(db.config.host.clone())
        .tcp_port(db.config.port)
        .user(Some(db.config.user.clone()))
        .pass(db.password.clone())
        .db_name(Some(db.name.clone()))
        .into();
    Pool::new(opts)
}

async fn my_fixture() -> (TestDb, MySqlDialect) {
    let db = TestDb::create().await;
    let pool = my_pool(&db).await;
    let mut conn = pool.get_conn().await.expect("connect to test MySQL");
    for sql in [
        "CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(20), extra TEXT NULL)",
        "INSERT INTO t VALUES (1,'n1',NULL),(2,'n2',NULL),(3,'n3',NULL),(4,'n4',NULL),(5,'n5',NULL),(6,'n6',NULL),(7,'n7',NULL)",
        "CREATE VIEW v AS SELECT id FROM t",
        "CREATE TABLE bin (id INT PRIMARY KEY, data BLOB, note TEXT NULL)",
        "INSERT INTO bin VALUES (1, x'00ff10', NULL)",
    ] {
        conn.query_drop(sql)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    drop(conn);
    pool.disconnect().await.ok();
    let dialect = MySqlDialect::connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    (db, dialect)
}

#[tokio::test]
async fn my_samples_five_rows() {
    let (db, d) = my_fixture().await;
    let page = d.sample_rows(&path(&db.name, None, "t"), 5).await.unwrap();
    assert_eq!(page.rows.len(), 5);
    let names: Vec<_> = page.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["id", "name", "extra"]);
    assert!(!page.has_more);
    assert_eq!(numbers(&page, 0).len(), 5);
    drop(d);
    db.drop_db().await;
}

#[tokio::test]
async fn my_view_is_refused() {
    let (db, d) = my_fixture().await;
    let err = d
        .sample_rows(&path(&db.name, None, "v"), 5)
        .await
        .unwrap_err();
    assert!(matches!(err, Error::InvalidInput(_)), "{err:?}");
    drop(d);
    db.drop_db().await;
}

#[tokio::test]
async fn my_missing_table_not_found() {
    let (db, d) = my_fixture().await;
    let err = d
        .sample_rows(&path(&db.name, None, "nope"), 5)
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NotFound(_)), "{err:?}");
    drop(d);
    db.drop_db().await;
}

#[tokio::test]
async fn my_binary_and_null_cells() {
    let (db, d) = my_fixture().await;
    let page = d
        .sample_rows(&path(&db.name, None, "bin"), 5)
        .await
        .unwrap();
    assert!(
        matches!(page.rows[0][1], Cell::Bytes { .. }),
        "{:?}",
        page.rows[0][1]
    );
    assert!(matches!(page.rows[0][2], Cell::Null));
    drop(d);
    db.drop_db().await;
}

#[tokio::test]
async fn my_sample_session_refuses_writes() {
    let (db, d) = my_fixture().await;
    let err = d
        .sample_probe(&db.name, "INSERT INTO t VALUES (99, 'x', NULL)")
        .await
        .unwrap_err();
    assert!(matches!(err, Error::ReadOnlyRefused), "{err:?}");
    let pool = my_pool(&db).await;
    let mut conn = pool.get_conn().await.unwrap();
    let n: Option<i64> = conn.query_first("SELECT COUNT(*) FROM t").await.unwrap();
    assert_eq!(n, Some(7));
    drop(conn);
    pool.disconnect().await.ok();
    drop(d);
    db.drop_db().await;
}

// ------------------------------------------------------------------- SQLite

fn lite_fixture() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("s.sqlite");
    let conn = rusqlite::Connection::open(&file).unwrap();
    conn.execute_batch(
        "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, extra TEXT);
         INSERT INTO t (id, name) VALUES (1,'n1'),(2,'n2'),(3,'n3'),(4,'n4'),(5,'n5'),(6,'n6'),(7,'n7');
         CREATE VIEW v AS SELECT id FROM t;
         CREATE TABLE bin (id INTEGER PRIMARY KEY, data BLOB, note TEXT);
         INSERT INTO bin VALUES (1, x'00ff10', NULL);",
    )
    .unwrap();
    (dir, file)
}

async fn lite_open(file: &std::path::Path) -> SqliteDialect {
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
        file: Some(file.to_path_buf()),
        query_timeout_secs: None,
        ai_access: Default::default(),
        ai_sync: Default::default(),
        production: false,
        read_only: false,
    };
    SqliteDialect::connect(&config).await.expect("connect")
}

#[tokio::test]
async fn lite_samples_five_rows() {
    let (_dir, file) = lite_fixture();
    let d = lite_open(&file).await;
    let page = d.sample_rows(&path("main", None, "t"), 5).await.unwrap();
    assert_eq!(page.rows.len(), 5);
    let names: Vec<_> = page.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["id", "name", "extra"]);
    assert!(!page.has_more);
}

#[tokio::test]
async fn lite_view_is_refused() {
    let (_dir, file) = lite_fixture();
    let d = lite_open(&file).await;
    let err = d
        .sample_rows(&path("main", None, "v"), 5)
        .await
        .unwrap_err();
    assert!(matches!(err, Error::InvalidInput(_)), "{err:?}");
}

#[tokio::test]
async fn lite_missing_table_not_found() {
    let (_dir, file) = lite_fixture();
    let d = lite_open(&file).await;
    let err = d
        .sample_rows(&path("main", None, "nope"), 5)
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NotFound(_)), "{err:?}");
}

#[tokio::test]
async fn lite_binary_and_null_cells() {
    let (_dir, file) = lite_fixture();
    let d = lite_open(&file).await;
    let page = d.sample_rows(&path("main", None, "bin"), 5).await.unwrap();
    assert!(
        matches!(page.rows[0][1], Cell::Bytes { .. }),
        "{:?}",
        page.rows[0][1]
    );
    assert!(matches!(page.rows[0][2], Cell::Null));
}

#[tokio::test]
async fn lite_sample_session_refuses_writes() {
    let (_dir, file) = lite_fixture();
    let d = lite_open(&file).await;
    let err = d
        .sample_probe("main", "INSERT INTO t (id) VALUES (99)")
        .await
        .unwrap_err();
    assert!(matches!(err, Error::ReadOnlyRefused), "{err:?}");
    let conn = rusqlite::Connection::open(&file).unwrap();
    let n: i64 = conn
        .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 7);
}
