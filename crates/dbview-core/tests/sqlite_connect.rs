use std::path::Path;

use dbview_core::Error;
use dbview_core::dialect::{Dialect, connect};
use dbview_core::model::{ConnectionConfig, DialectKind, SslMode};
use dbview_core::sqlite::create_database;
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
