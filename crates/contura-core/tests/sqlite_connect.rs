use std::path::Path;

use contura_core::Error;
use contura_core::dialect::{Dialect, connect};
use contura_core::model::{ConnectionConfig, DialectKind, SslMode};
use contura_core::sqlite::create_database;
use std::sync::Arc;

fn config(file: &Path) -> ConnectionConfig {
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
        file: Some(file.to_path_buf()),
        query_timeout_secs: None,
        ai_access: Default::default(),
        ai_sync: Default::default(),
        production: false,
        read_only: false,
    }
}

async fn open(file: &Path) -> Result<Arc<dyn Dialect>, Error> {
    connect(&config(file), None).await
}

#[tokio::test]
async fn opens_an_existing_database_and_reports_version() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.sqlite");
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch("CREATE TABLE t (id INTEGER)")
        .unwrap();
    let db = open(&path).await.unwrap();
    assert!(db.server_version().await.unwrap().starts_with("3."));
    db.disconnect().await.unwrap();
}

#[tokio::test]
async fn opening_missing_file_does_not_create_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing.sqlite");
    let err = open(&path).await.err().unwrap();
    assert!(matches!(&err, Error::Connect(m) if m.contains("the file does not exist")));
    assert!(!path.exists());
}

#[tokio::test]
async fn opening_a_non_database_file_is_a_connect_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notes.txt");
    std::fs::write(&path, "hello".repeat(1000)).unwrap();
    let err = open(&path).await.err().unwrap();
    assert!(matches!(&err, Error::Connect(m) if m.contains("not a SQLite database")));
}

#[tokio::test]
async fn create_database_makes_an_openable_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("new.sqlite");
    create_database(&path).unwrap();
    assert!(path.exists());
    let db = open(&path).await.unwrap();
    assert_eq!(db.list_databases().await.unwrap(), ["main"]);
}

#[tokio::test]
async fn create_database_refuses_an_existing_path() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("keep.txt");
    std::fs::write(&path, b"precious").unwrap();
    let err = create_database(&path).unwrap_err();
    assert!(matches!(&err, Error::InvalidInput(m) if m.contains("already exists")));
    assert_eq!(std::fs::read(&path).unwrap(), b"precious");
}

fn ro_config(file: &Path, read_only: bool) -> ConnectionConfig {
    ConnectionConfig {
        read_only,
        ..config(file)
    }
}

fn fixture_file() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.sqlite");
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1)")
        .unwrap();
    (dir, path)
}

#[tokio::test]
async fn read_only_session_refuses_insert_at_the_server() {
    let (_dir, path) = fixture_file();
    let db = connect(&ro_config(&path, true), None).await.unwrap();
    let s = db.open_query_session(None).await.unwrap();
    let err = s.execute("INSERT INTO t VALUES (2)").await.unwrap_err();
    assert!(matches!(err, Error::ReadOnlyRefused), "{err:?}");
    s.execute("SELECT a FROM t").await.unwrap();
}

#[tokio::test]
async fn read_only_browse_connection_refuses_writes() {
    let (_dir, path) = fixture_file();
    let db = contura_core::sqlite::SqliteDialect::connect(&ro_config(&path, true))
        .await
        .unwrap();
    let err = db
        .browse_execute_for_test("INSERT INTO t VALUES (2)")
        .await
        .unwrap_err();
    assert!(matches!(err, Error::ReadOnlyRefused), "{err:?}");
}

#[tokio::test]
async fn plain_session_still_writes() {
    let (_dir, path) = fixture_file();
    let db = connect(&ro_config(&path, false), None).await.unwrap();
    let s = db.open_query_session(None).await.unwrap();
    s.execute("INSERT INTO t VALUES (2)").await.unwrap();
}
