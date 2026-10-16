use dbview_core::dialect::connect;
use dbview_core::model::{ConnectionConfig, DialectKind, SslMode};

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
        Some(dbview_core::schema_model::SmDefault::String {
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
