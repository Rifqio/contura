use std::path::Path;
use std::sync::Arc;

use dbview_core::Error;
use dbview_core::dialect::{Dialect, connect};
use dbview_core::model::{
    ConnectionConfig, DbObject, DialectKind, ObjectKind, ObjectPath, SslMode,
};

async fn fixture() -> (tempfile::TempDir, Arc<dyn Dialect>) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("shop.sqlite");
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE stores (id INTEGER PRIMARY KEY, name TEXT);
             CREATE TABLE orders (id INTEGER PRIMARY KEY, store_id INTEGER, total REAL);
             CREATE INDEX orders_store ON orders (store_id);
             CREATE VIEW v_orders AS SELECT id, total FROM orders;
             CREATE TRIGGER orders_audit AFTER INSERT ON orders
             BEGIN
                 UPDATE stores SET name = name WHERE id = NEW.store_id;
             END;",
        )
        .unwrap();
    let db = open(&path).await;
    (dir, db)
}

async fn open(path: &Path) -> Arc<dyn Dialect> {
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
    };
    connect(&config, None).await.unwrap()
}

fn path(name: &str) -> ObjectPath {
    ObjectPath {
        database: "main".into(),
        schema: None,
        name: name.into(),
    }
}

#[tokio::test]
async fn lists_main_only() {
    let (_dir, db) = fixture().await;
    assert_eq!(db.list_databases().await.unwrap(), ["main"]);
    assert!(db.list_schemas("main").await.unwrap().is_empty());
}

#[tokio::test]
async fn lists_tables_views_triggers_in_order() {
    let (_dir, db) = fixture().await;
    let obj = |kind, name: &str| DbObject {
        kind,
        name: name.into(),
    };
    assert_eq!(
        db.list_objects("main", None).await.unwrap(),
        vec![
            obj(ObjectKind::Table, "orders"),
            obj(ObjectKind::Table, "stores"),
            obj(ObjectKind::View, "v_orders"),
            obj(ObjectKind::Trigger, "orders_audit"),
        ]
    );
}

#[tokio::test]
async fn definition_of_view_and_trigger_is_their_sql() {
    let (_dir, db) = fixture().await;
    let view = db
        .object_definition(ObjectKind::View, &path("v_orders"))
        .await
        .unwrap();
    assert!(view.starts_with("CREATE VIEW v_orders"));
    let trigger = db
        .object_definition(ObjectKind::Trigger, &path("orders_audit"))
        .await
        .unwrap();
    assert!(trigger.contains("AFTER INSERT ON orders"));
    let table = db
        .object_definition(ObjectKind::Table, &path("stores"))
        .await
        .unwrap();
    assert!(table.starts_with("CREATE TABLE stores"));
    let missing = db
        .object_definition(ObjectKind::Table, &path("nope"))
        .await
        .unwrap_err();
    assert!(matches!(missing, Error::NotFound(_)));
}

#[tokio::test]
async fn routines_are_invalid_input() {
    let (_dir, db) = fixture().await;
    for kind in [ObjectKind::Procedure, ObjectKind::Function] {
        let err = db.object_definition(kind, &path("x")).await.unwrap_err();
        assert!(matches!(err, Error::InvalidInput(m) if m == "SQLite has no stored routines"));
    }
}
