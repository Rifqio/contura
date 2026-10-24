//! UX step 8: how many rows of a table match a filter, capped at 1,001, on a read of
//! its own (never the browse session), read-only, with a server-side time limit.

mod common;

use common::TestDb;
use common::pg::{PgTestDb, pg_admin_client};
use contura_core::dialect::Dialect;
use contura_core::model::{
    ConnectionConfig, CountRequest, DialectKind, ObjectPath, RowCount, SslMode,
};
use contura_core::mysql::MySqlDialect;
use contura_core::postgres::PostgresDialect;
use contura_core::sqlite::SqliteDialect;
use mysql_async::prelude::Queryable;
use mysql_async::{Opts, OptsBuilder, Pool};

const LIMIT_MS: u64 = 3_000;

fn req(database: &str, schema: Option<&str>, name: &str, filter: Option<&str>) -> CountRequest {
    CountRequest {
        table: ObjectPath {
            database: database.into(),
            schema: schema.map(Into::into),
            name: name.into(),
        },
        filter: filter.map(Into::into),
    }
}

fn counted(n: u64) -> RowCount {
    RowCount::Counted { rows: n }
}

async fn count(
    d: &dyn Dialect,
    database: &str,
    schema: Option<&str>,
    name: &str,
    filter: Option<&str>,
) -> contura_core::error::Result<RowCount> {
    d.count_rows(&req(database, schema, name, filter), LIMIT_MS)
        .await
}

/// The checks every Dialect passes: none, some, the filter, the cap, and a second statement refused.
async fn common_checks(d: &dyn Dialect, db: &str, s: Option<&str>) {
    assert_eq!(count(d, db, s, "t", None).await.unwrap(), counted(7));
    assert_eq!(
        count(d, db, s, "t", Some("id > 3")).await.unwrap(),
        counted(4)
    );
    assert_eq!(
        count(d, db, s, "t", Some("id > 100")).await.unwrap(),
        counted(0)
    );
    // 1,500 rows count as 1,001: the UI says "1,000+".
    assert_eq!(count(d, db, s, "big", None).await.unwrap(), counted(1001));
    assert_eq!(
        count(d, db, s, "big", Some("id <= 1000")).await.unwrap(),
        counted(1000)
    );
    // The filter can't smuggle in a second statement.
    let smuggled = Some("id > 0); DELETE FROM t WHERE (1 = 1");
    assert!(count(d, db, s, "t", smuggled).await.is_err());
    assert_eq!(count(d, db, s, "t", None).await.unwrap(), counted(7));
    assert!(count(d, db, s, "nope", None).await.is_err());
}

// ---------------------------------------------------------------- PostgreSQL

#[tokio::test]
async fn pg_counts_capped_and_times_out_on_the_server() {
    let db = PgTestDb::create().await;
    let admin = pg_admin_client(&db.name).await;
    admin
        .batch_execute(
            "CREATE TABLE public.t (id int PRIMARY KEY);
             INSERT INTO public.t SELECT g FROM generate_series(1, 7) g;
             CREATE TABLE public.big (id int PRIMARY KEY);
             INSERT INTO public.big SELECT g FROM generate_series(1, 1500) g;
             CREATE SEQUENCE public.s;",
        )
        .await
        .expect("seed");
    drop(admin);
    let d = PostgresDialect::connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    common_checks(&d, &db.name, Some("public")).await;
    let slow = req(
        &db.name,
        Some("public"),
        "t",
        Some("(SELECT pg_sleep(3)) IS NOT NULL"),
    );
    let started = std::time::Instant::now();
    assert_eq!(d.count_rows(&slow, 300).await.unwrap(), RowCount::TimedOut);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    // The count runs read-only: a real write in the filter (the sequence exists) is refused.
    let write = req(
        &db.name,
        Some("public"),
        "t",
        Some("nextval('public.s') > 0"),
    );
    let err = d.count_rows(&write, LIMIT_MS).await.unwrap_err();
    assert!(
        format!("{err:?}").to_lowercase().contains("read-only")
            || matches!(err, contura_core::error::Error::ReadOnlyRefused),
        "{err:?}"
    );
    // The same expression works outside the count, so the refusal is the transaction's.
    let admin = pg_admin_client(&db.name).await;
    admin
        .batch_execute("SELECT nextval('public.s')")
        .await
        .unwrap();
    drop(admin);
    drop(d);
    db.drop_db().await;
}

// ---------------------------------------------------------------- MySQL

#[tokio::test]
async fn my_counts_capped_and_times_out_on_the_server() {
    let db = TestDb::create().await;
    let opts: Opts = OptsBuilder::default()
        .ip_or_hostname(db.config.host.clone())
        .tcp_port(db.config.port)
        .user(Some(db.config.user.clone()))
        .pass(db.password.clone())
        .db_name(Some(db.name.clone()))
        .into();
    let pool = Pool::new(opts);
    let mut conn = pool.get_conn().await.expect("connect to test MySQL");
    for sql in [
        "CREATE TABLE t (id INT PRIMARY KEY)",
        "INSERT INTO t VALUES (1),(2),(3),(4),(5),(6),(7)",
        "CREATE TABLE big (id INT PRIMARY KEY)",
        "SET SESSION cte_max_recursion_depth = 2000",
        "INSERT INTO big WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 1500) SELECT n FROM g",
    ] {
        conn.query_drop(sql)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    drop(conn);
    pool.disconnect().await.ok();
    let d = MySqlDialect::connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    common_checks(&d, &db.name, None).await;
    let slow = req(&db.name, None, "big", Some("SLEEP(0.01) = 0"));
    let started = std::time::Instant::now();
    assert_eq!(d.count_rows(&slow, 300).await.unwrap(), RowCount::TimedOut);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    // Without the server's limit (as on a server that ignores it), the client stops waiting
    // and drops the count's own connection; the pool is never held.
    let started = std::time::Instant::now();
    assert_eq!(
        d.count_rows_without_server_limit(&slow, 300).await.unwrap(),
        RowCount::TimedOut
    );
    assert!(
        started.elapsed() < std::time::Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(
        d.count_rows(&req(&db.name, None, "t", None), LIMIT_MS)
            .await
            .unwrap(),
        counted(7)
    );
    drop(d);
    db.drop_db().await;
}

// ---------------------------------------------------------------- SQLite

#[tokio::test]
async fn lite_counts_capped_and_times_out() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("s.sqlite");
    rusqlite::Connection::open(&file)
        .unwrap()
        .execute_batch(
            "CREATE TABLE t (id INTEGER PRIMARY KEY);
             INSERT INTO t VALUES (1),(2),(3),(4),(5),(6),(7);
             CREATE TABLE big (id INTEGER PRIMARY KEY);
             WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 1500) INSERT INTO big SELECT n FROM g;",
        )
        .unwrap();
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
        file: Some(file),
        query_timeout_secs: None,
        ai_access: Default::default(),
        ai_sync: Default::default(),
        production: false,
        read_only: false,
    };
    let d = SqliteDialect::connect(&config).await.expect("connect");
    common_checks(&d, "main", None).await;
    let slow = req(
        "main",
        None,
        "t",
        Some(
            "(WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c) > 0",
        ),
    );
    let started = std::time::Instant::now();
    assert_eq!(d.count_rows(&slow, 300).await.unwrap(), RowCount::TimedOut);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
}
