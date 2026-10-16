mod common;

use common::pg::{pg_base_config, pg_test_password, pg_test_user};
use dbview_core::Error;
use dbview_core::dialect::connect;
use dbview_core::model::SslMode;
use dbview_core::postgres::PostgresDialect;
use std::time::{Duration, Instant};

#[tokio::test]
async fn connects_and_reports_version() {
    let config = pg_base_config(&pg_test_user(), None);
    let dialect = connect(&config, Some(&pg_test_password()))
        .await
        .expect("connect");
    let version = dialect.server_version().await.expect("version");
    let major: u32 = version
        .split('.')
        .next()
        .and_then(|m| m.parse().ok())
        .unwrap_or_else(|| panic!("unexpected version {version}"));
    assert!(major >= 13, "unexpected version {version}");
    dialect.disconnect().await.expect("disconnect");
}

#[tokio::test]
async fn connect_reports_auth_failure() {
    let config = pg_base_config(&pg_test_user(), None);
    let result = connect(&config, Some("nope")).await;
    assert!(
        matches!(result, Err(Error::Auth(_))),
        "got {:?}",
        result.err()
    );
}

#[tokio::test]
async fn connect_without_password_is_auth_failure() {
    let config = pg_base_config(&pg_test_user(), None);
    let result = connect(&config, None).await;
    match result {
        Err(Error::Auth(message)) => assert_eq!(
            message,
            "the server requires a password, and none is saved for this Connection"
        ),
        other => panic!("got {:?}", other.err()),
    }
}

#[tokio::test]
async fn connect_reports_unreachable_quickly() {
    let mut config = pg_base_config(&pg_test_user(), None);
    config.host = "127.0.0.1".into();
    config.port = 1;
    let start = Instant::now();
    let result = connect(&config, Some("x")).await;
    assert!(
        matches!(result, Err(Error::Connect(_))),
        "got {:?}",
        result.err()
    );
    assert!(start.elapsed() < Duration::from_secs(12));
}

#[tokio::test]
async fn connect_to_missing_database_is_query_error() {
    let missing = format!("dbview_missing_{}", uuid::Uuid::new_v4().simple());
    let config = pg_base_config(&pg_test_user(), Some(missing.clone()));
    let result = connect(&config, Some(&pg_test_password())).await;
    match result {
        Err(Error::Query(message)) => assert!(message.contains(&missing), "{message}"),
        other => panic!("got {:?}", other.err()),
    }
}

#[tokio::test]
async fn require_ssl_against_plain_server_is_connect_error() {
    let mut config = pg_base_config(&pg_test_user(), None);
    config.ssl = SslMode::Require;
    let result = connect(&config, Some(&pg_test_password())).await;
    assert!(
        matches!(result, Err(Error::Connect(_))),
        "got {:?}",
        result.err()
    );
}

#[tokio::test]
async fn verify_ca_with_unreadable_file_is_invalid_input() {
    let dir = tempfile::tempdir().unwrap();
    let ca_path = dir.path().join("missing-ca.pem");
    let mut config = pg_base_config(&pg_test_user(), None);
    config.ssl = SslMode::VerifyCa {
        ca_path: ca_path.clone(),
    };
    let result = connect(&config, Some(&pg_test_password())).await;
    let expected = format!("cannot read CA file {}: ", ca_path.display());
    match result {
        Err(Error::InvalidInput(message)) => {
            assert!(message.starts_with(&expected), "{message}")
        }
        other => panic!("got {:?}", other.err()),
    }
}

#[tokio::test]
async fn session_time_zone_is_utc() {
    let config = pg_base_config(&pg_test_user(), None);
    let dialect = PostgresDialect::connect(&config, Some(&pg_test_password()))
        .await
        .expect("connect");
    let client = dialect.client("postgres").await.expect("client");
    let row = client.query_one("SHOW TimeZone", &[]).await.expect("query");
    assert_eq!(row.get::<_, String>(0), "UTC");
}
