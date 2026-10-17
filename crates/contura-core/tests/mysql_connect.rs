mod common;

use common::{TestDb, base_config, test_user};
use contura_core::Error;
use contura_core::dialect::connect;
use std::time::{Duration, Instant};

#[tokio::test]
async fn connect_reports_server_version() {
    let db = TestDb::create().await;
    let dialect = connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    let version = dialect.server_version().await.expect("version");
    assert!(version.starts_with("8."), "unexpected version {version}");
    dialect.disconnect().await.expect("disconnect");
    db.drop_db().await;
}

#[tokio::test]
async fn connect_reports_auth_failure() {
    let config = base_config(&test_user(), None);
    let result = connect(&config, Some("definitely-wrong")).await;
    assert!(
        matches!(result, Err(Error::Auth(_))),
        "got {:?}",
        result.err()
    );
}

#[tokio::test]
async fn connect_reports_unreachable_quickly() {
    let mut config = base_config(&test_user(), None);
    config.host = "127.0.0.1".into();
    config.port = 1;
    let start = Instant::now();
    let result = connect(&config, Some("x")).await;
    assert!(
        matches!(result, Err(Error::Connect(_))),
        "got {:?}",
        result.err()
    );
    assert!(start.elapsed() < Duration::from_secs(11));
}

#[tokio::test]
async fn unknown_database_is_not_a_reachability_error() {
    let db = TestDb::create().await;
    let mut config = db.config.clone();
    config.database = Some(format!("{}_missing", db.name));
    let result = connect(&config, db.password.as_deref()).await;
    match result {
        Err(Error::Query(message)) => assert!(message.contains("Unknown database"), "{message}"),
        other => panic!("got {:?}", other.err()),
    }
    db.drop_db().await;
}
