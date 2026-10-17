mod common;

use common::pg::{PgTestDb, pg_admin_client, pg_database_exists};
use common::{TestDb, base_config, database_exists, test_password, test_user};
use mysql_async::prelude::Queryable;
use mysql_async::{Opts, OptsBuilder, Pool};

#[tokio::test]
async fn panicking_test_still_drops_its_database() {
    let (tx, rx) = std::sync::mpsc::channel();
    let outcome = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        rt.block_on(async {
            let db = TestDb::create().await;
            tx.send(db.name.clone()).expect("send name");
            panic!("failing on purpose before drop_db");
        })
    })
    .join();
    assert!(outcome.is_err(), "the inner test should have panicked");
    let name = rx.recv().expect("database name");
    assert!(!database_exists(&name).await, "{name} was left behind");
}

/// Drops `dbview_test_<8 hex>` databases left by killed runs. Run it alone:
/// `cargo test -p contura-core --test test_db_cleanup -- --ignored`.
#[tokio::test]
#[ignore]
async fn sweep_leftover_test_databases() {
    let config = base_config(&test_user(), None);
    let opts: Opts = OptsBuilder::default()
        .ip_or_hostname(config.host.clone())
        .tcp_port(config.port)
        .user(Some(config.user.clone()))
        .pass(Some(test_password()))
        .into();
    let pool = Pool::new(opts);
    let mut conn = pool.get_conn().await.expect("connect to test MySQL");
    let names: Vec<String> = conn
        .query("SELECT CAST(SCHEMA_NAME AS CHAR) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'dbview\\_test\\_%'")
        .await
        .expect("list databases");
    let is_test_db = |n: &str| {
        n.strip_prefix("dbview_test_")
            .is_some_and(|s| s.len() == 8 && s.bytes().all(|b| b.is_ascii_hexdigit()))
    };
    for name in names.into_iter().filter(|n| is_test_db(n)) {
        conn.query_drop(format!("DROP DATABASE `{name}`"))
            .await
            .expect("drop");
        println!("dropped {name}");
    }
    drop(conn);
    pool.disconnect().await.ok();
}

#[tokio::test]
async fn panicking_pg_test_still_drops_its_database() {
    let (tx, rx) = std::sync::mpsc::channel();
    let outcome = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        rt.block_on(async {
            let db = PgTestDb::create().await;
            tx.send(db.name.clone()).expect("send name");
            panic!("failing on purpose before drop_db");
        })
    })
    .join();
    assert!(outcome.is_err(), "the inner test should have panicked");
    let name = rx.recv().expect("database name");
    assert!(!pg_database_exists(&name).await, "{name} was left behind");
}

/// Drops `dbview_test_<8 hex>` PostgreSQL databases left by killed runs. Run it alone:
/// `cargo test -p contura-core --test test_db_cleanup -- --ignored`.
#[tokio::test]
#[ignore]
async fn sweep_leftover_pg_test_databases() {
    let client = pg_admin_client("postgres").await;
    let names: Vec<String> = client
        .query(
            "SELECT datname FROM pg_database WHERE datname LIKE 'dbview\\_test\\_%'",
            &[],
        )
        .await
        .expect("list databases")
        .iter()
        .map(|row| row.get(0))
        .collect();
    let is_test_db = |n: &str| {
        n.strip_prefix("dbview_test_")
            .is_some_and(|s| s.len() == 8 && s.bytes().all(|b| b.is_ascii_hexdigit()))
    };
    for name in names.into_iter().filter(|n| is_test_db(n)) {
        client
            .batch_execute(&format!("DROP DATABASE \"{name}\" WITH (FORCE)"))
            .await
            .expect("drop");
        println!("dropped {name}");
    }
}
