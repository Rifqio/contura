mod common;

use common::TestDb;
use dbview_core::dialect::connect;
use dbview_core::schema_model::{SchemaModel, SmDefault, SmIndex};
use mysql_async::prelude::Queryable;
use mysql_async::{Opts, OptsBuilder, Pool};

async fn seed(db: &TestDb) {
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
        "CREATE TABLE stores (id INT AUTO_INCREMENT PRIMARY KEY COMMENT 'store id', \
         name VARCHAR(80) NOT NULL UNIQUE, kind ENUM('drive','mall') DEFAULT 'mall', \
         opened_at DATETIME DEFAULT CURRENT_TIMESTAMP) COMMENT 'KFC stores'",
        "CREATE TABLE orders (id BIGINT, line INT, store_id INT NOT NULL, total DECIMAL(10,2) DEFAULT 0, \
         PRIMARY KEY (id, line), INDEX ix_store (store_id), \
         FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE)",
        "CREATE VIEW v_orders AS SELECT id FROM orders",
        "CREATE TRIGGER orders_audit BEFORE INSERT ON orders FOR EACH ROW SET NEW.line = NEW.line",
        "CREATE TABLE `we``ird name` (`ñame 表` INT PRIMARY KEY)",
    ] {
        conn.query_drop(sql)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    drop(conn);
    pool.disconnect().await.ok();
}

async fn snapshot(db: &TestDb) -> SchemaModel {
    let dialect = connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    let model = dialect
        .schema_snapshot(&db.name, None)
        .await
        .expect("snapshot");
    dialect.disconnect().await.ok();
    model
}

#[tokio::test]
async fn snapshot_reads_tables_columns_and_notes() {
    let db = TestDb::create().await;
    seed(&db).await;
    let model = snapshot(&db).await;
    let stores = model
        .tables
        .iter()
        .find(|t| t.name == "stores")
        .expect("stores");
    assert_eq!(stores.note.as_deref(), Some("KFC stores"));
    let col = |n: &str| stores.columns.iter().find(|c| c.name == n).expect(n);
    let id = col("id");
    assert!(id.pk && id.increment);
    assert_eq!(id.note.as_deref(), Some("store id"));
    let name = col("name");
    assert!(name.not_null && name.unique);
    let kind = col("kind");
    assert_eq!(kind.type_name, "enum('drive','mall')");
    assert_eq!(
        kind.default,
        Some(SmDefault::String {
            value: "mall".into()
        })
    );
    assert_eq!(
        col("opened_at").default,
        Some(SmDefault::Expression {
            value: "CURRENT_TIMESTAMP".into()
        })
    );
    db.drop_db().await;
}

#[tokio::test]
async fn snapshot_reads_composite_pk_indexes_and_refs() {
    let db = TestDb::create().await;
    seed(&db).await;
    let model = snapshot(&db).await;
    let orders = model
        .tables
        .iter()
        .find(|t| t.name == "orders")
        .expect("orders");
    assert!(orders.indexes.contains(&SmIndex {
        name: None,
        columns: vec!["id".into(), "line".into()],
        unique: true,
        pk: true,
    }));
    assert!(
        orders
            .indexes
            .iter()
            .any(|i| i.name.as_deref() == Some("ix_store") && i.columns == ["store_id"])
    );
    assert_eq!(model.refs.len(), 1);
    let r = &model.refs[0];
    assert_eq!(
        (r.from.table.as_str(), r.from.columns.as_slice()),
        ("orders", ["store_id".to_string()].as_slice())
    );
    assert_eq!(
        (r.to.table.as_str(), r.to.columns.as_slice()),
        ("stores", ["id".to_string()].as_slice())
    );
    assert_eq!(r.on_delete.as_deref(), Some("CASCADE"));
    db.drop_db().await;
}

#[tokio::test]
async fn snapshot_skips_and_reports_inexpressible() {
    let db = TestDb::create().await;
    seed(&db).await;
    let model = snapshot(&db).await;
    assert!(
        model.skipped.contains(&"view v_orders".to_string()),
        "{:?}",
        model.skipped
    );
    assert!(
        model.skipped.contains(&"trigger orders_audit".to_string()),
        "{:?}",
        model.skipped
    );
    assert!(!model.tables.iter().any(|t| t.name == "v_orders"));
    db.drop_db().await;
}

#[tokio::test]
async fn snapshot_handles_odd_names() {
    let db = TestDb::create().await;
    seed(&db).await;
    let model = snapshot(&db).await;
    let odd = model
        .tables
        .iter()
        .find(|t| t.name == "we`ird name")
        .expect("odd table");
    assert_eq!(odd.columns[0].name, "ñame 表");
    assert!(odd.columns[0].pk);
    db.drop_db().await;
}
