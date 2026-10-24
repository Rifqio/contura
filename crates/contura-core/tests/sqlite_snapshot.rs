use contura_core::dialect::connect;
use contura_core::model::{ConnectionConfig, DialectKind, SslMode};

#[tokio::test]
async fn sqlite_snapshot_reads_tables_indexes_refs() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("shop.sqlite");
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE stores (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
             CREATE TABLE orders (id INTEGER PRIMARY KEY, store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
                 status TEXT DEFAULT 'new');
             CREATE INDEX ix_store ON orders(store_id);
             CREATE TRIGGER orders_audit AFTER INSERT ON orders BEGIN SELECT 1; END;",
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
        file: Some(path.clone()),
        query_timeout_secs: None,
        ai_access: Default::default(),
        ai_sync: Default::default(),
        production: false,
        read_only: false,
    };
    let db = connect(&config, None).await.unwrap();
    let model = db.schema_snapshot("main", None).await.unwrap();
    let stores = model
        .tables
        .iter()
        .find(|t| t.name == "stores")
        .expect("stores");
    let id = &stores.columns[0];
    assert!(id.pk && id.increment, "{id:?}");
    let name = &stores.columns[1];
    assert!(name.unique && name.not_null, "{name:?}");
    let orders = model
        .tables
        .iter()
        .find(|t| t.name == "orders")
        .expect("orders");
    assert!(
        orders
            .indexes
            .iter()
            .any(|i| i.name.as_deref() == Some("ix_store") && i.columns == ["store_id"])
    );
    assert_eq!(
        orders.columns[2].default,
        Some(contura_core::schema_model::SmDefault::String {
            value: "new".into()
        })
    );
    assert_eq!(model.refs.len(), 1);
    assert_eq!(model.refs[0].on_delete.as_deref(), Some("CASCADE"));
    assert!(
        model.skipped.contains(&"trigger orders_audit".to_string()),
        "{:?}",
        model.skipped
    );
    assert!(!model.tables.iter().any(|t| t.name.starts_with("sqlite_")));
    db.disconnect().await.ok();
}

/// `REFERENCES Stores(ID)` is kept as written, but SQLite matches it without case: the ER
/// diagram's line needs the declared names to find its tables and columns.
#[tokio::test]
async fn sqlite_snapshot_refs_take_the_declared_case() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("shop.sqlite");
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE stores (id INTEGER PRIMARY KEY, name TEXT);
             CREATE TABLE orders (id INTEGER PRIMARY KEY, store_id INTEGER,
                 FOREIGN KEY (Store_ID) REFERENCES Stores(ID));",
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
        file: Some(path.clone()),
        query_timeout_secs: None,
        ai_access: Default::default(),
        ai_sync: Default::default(),
        production: false,
        read_only: false,
    };
    let db = connect(&config, None).await.unwrap();
    let model = db.schema_snapshot("main", None).await.unwrap();
    assert_eq!(model.refs.len(), 1);
    assert_eq!(model.refs[0].to.table, "stores");
    assert_eq!(model.refs[0].to.columns, ["id"]);
    assert_eq!(model.refs[0].from.columns, ["store_id"]);
    db.disconnect().await.ok();
}
