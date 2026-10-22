//! Schema fingerprints on live databases: they follow DDL only, never rows, and only the
//! database (MySQL, SQLite) or schema (PostgreSQL) they were read for.

mod common;

use std::sync::Arc;

use common::TestDb;
use common::pg::{PgTestDb, pg_admin_client};
use contura_core::dialect::{Dialect, connect};
use contura_core::model::{ConnectionConfig, DialectKind, SslMode};
use mysql_async::prelude::Queryable;
use mysql_async::{Opts, OptsBuilder, Pool};

async fn fingerprint(db: &Arc<dyn Dialect>, database: &str, schema: Option<&str>) -> String {
    db.schema_fingerprint(database, schema)
        .await
        .expect("fingerprint")
}

#[tokio::test]
async fn sqlite_fingerprint_follows_ddl_only() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("shop.sqlite");
    let writer = rusqlite::Connection::open(&path).unwrap();
    writer
        .execute_batch(
            "CREATE TABLE stores (id INTEGER PRIMARY KEY, name TEXT);
             CREATE TABLE orders (id INTEGER PRIMARY KEY, total INTEGER);",
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
    let first = fingerprint(&db, "main", None).await;
    assert!(first.starts_with("sqlite:"), "{first}");
    assert_eq!(fingerprint(&db, "main", None).await, first);

    writer
        .execute_batch(
            "INSERT INTO stores (id, name) VALUES (1, 'a'); UPDATE stores SET name = 'b';",
        )
        .unwrap();
    assert_eq!(fingerprint(&db, "main", None).await, first, "rows only");

    let mut last = first;
    for ddl in [
        "ALTER TABLE orders ADD COLUMN note TEXT",
        "CREATE TABLE lines (id INTEGER PRIMARY KEY, store_id INTEGER REFERENCES stores(id))",
        "CREATE INDEX ix_total ON orders(total)",
        "DROP TABLE lines",
    ] {
        writer.execute_batch(ddl).unwrap();
        let next = fingerprint(&db, "main", None).await;
        assert_ne!(next, last, "{ddl}");
        last = next;
    }
    assert!(
        db.schema_fingerprint("no_such_db", None).await.is_err(),
        "a missing database has no fingerprint"
    );
    db.disconnect().await.ok();
}

fn mysql_pool(db: &TestDb, database: &str) -> Pool {
    let opts: Opts = OptsBuilder::default()
        .ip_or_hostname(db.config.host.clone())
        .tcp_port(db.config.port)
        .user(Some(db.config.user.clone()))
        .pass(db.password.clone())
        .db_name(Some(database.to_string()))
        .into();
    Pool::new(opts)
}

async fn mysql_run(pool: &Pool, sql: &str) {
    let mut conn = pool.get_conn().await.expect("connect to test MySQL");
    conn.query_drop(sql)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

#[tokio::test]
async fn mysql_fingerprint_follows_ddl_only() {
    let db = TestDb::create().await;
    let other = TestDb::create().await;
    let pool = mysql_pool(&db, &db.name);
    let other_pool = mysql_pool(&other, &other.name);
    for sql in [
        "CREATE TABLE stores (id INT PRIMARY KEY, name VARCHAR(80))",
        "CREATE TABLE orders (id INT PRIMARY KEY, store_id INT, total INT)",
    ] {
        mysql_run(&pool, sql).await;
    }
    mysql_run(&other_pool, "CREATE TABLE elsewhere (id INT PRIMARY KEY)").await;

    let dialect = connect(&db.config, db.password.as_deref()).await.unwrap();
    let first = fingerprint(&dialect, &db.name, None).await;
    assert!(first.starts_with("mysql:"), "{first}");
    assert_eq!(first.split('/').count(), 4, "{first}");
    assert_eq!(fingerprint(&dialect, &db.name, None).await, first);

    mysql_run(&pool, "INSERT INTO stores VALUES (1, 'a')").await;
    mysql_run(&pool, "UPDATE stores SET name = 'b' WHERE id = 1").await;
    assert_eq!(
        fingerprint(&dialect, &db.name, None).await,
        first,
        "rows only"
    );

    mysql_run(&other_pool, "ALTER TABLE elsewhere ADD COLUMN x INT").await;
    mysql_run(&other_pool, "CREATE TABLE elsewhere2 (id INT)").await;
    assert_eq!(
        fingerprint(&dialect, &db.name, None).await,
        first,
        "another database"
    );

    let mut last = first;
    for ddl in [
        "ALTER TABLE orders ADD COLUMN note VARCHAR(20)",
        "ALTER TABLE orders MODIFY note VARCHAR(20) COMMENT 'free text'",
        "ALTER TABLE orders ADD CONSTRAINT fk_store FOREIGN KEY (store_id) REFERENCES stores(id)",
        "CREATE INDEX ix_total ON orders(total)",
        "DROP TABLE orders",
    ] {
        mysql_run(&pool, ddl).await;
        let next = fingerprint(&dialect, &db.name, None).await;
        assert_ne!(next, last, "{ddl}");
        last = next;
    }
    let missing = format!("{}_missing", db.name);
    assert!(
        dialect.schema_fingerprint(&missing, None).await.is_err(),
        "a missing database has no fingerprint"
    );
    dialect.disconnect().await.ok();
    pool.disconnect().await.ok();
    other_pool.disconnect().await.ok();
    db.drop_db().await;
    other.drop_db().await;
}

#[tokio::test]
async fn postgres_fingerprint_follows_ddl_only() {
    let db = PgTestDb::create().await;
    let client = pg_admin_client(&db.name).await;
    client
        .batch_execute(
            "CREATE TABLE stores (id INT PRIMARY KEY, name TEXT);
             CREATE TABLE orders (id INT PRIMARY KEY, store_id INT, total INT);
             CREATE TYPE mood AS ENUM ('ok', 'sad');
             CREATE SCHEMA other;
             CREATE TABLE other.elsewhere (id INT PRIMARY KEY);",
        )
        .await
        .unwrap();

    let dialect = connect(&db.config, db.password.as_deref()).await.unwrap();
    let first = fingerprint(&dialect, &db.name, Some("public")).await;
    assert!(first.starts_with("pg:"), "{first}");
    assert_eq!(first.len(), "pg:".len() + 32, "{first}");
    assert_eq!(fingerprint(&dialect, &db.name, Some("public")).await, first);

    client
        .batch_execute(
            "INSERT INTO stores VALUES (1, 'a'); UPDATE stores SET name = 'b' WHERE id = 1;",
        )
        .await
        .unwrap();
    assert_eq!(
        fingerprint(&dialect, &db.name, Some("public")).await,
        first,
        "rows only"
    );

    client
        .batch_execute(
            "ALTER TABLE other.elsewhere ADD COLUMN x INT;
             CREATE TABLE other.elsewhere2 (id INT);
             COMMENT ON COLUMN other.elsewhere.x IS 'n';",
        )
        .await
        .unwrap();
    assert_eq!(
        fingerprint(&dialect, &db.name, Some("public")).await,
        first,
        "another schema"
    );

    let mut last = first;
    for ddl in [
        "ALTER TABLE orders ADD COLUMN note TEXT",
        "COMMENT ON COLUMN orders.note IS 'free text'",
        "ALTER TABLE orders ADD CONSTRAINT fk_store FOREIGN KEY (store_id) REFERENCES stores(id)",
        "CREATE INDEX ix_total ON orders(total)",
        "DROP INDEX ix_total; CREATE UNIQUE INDEX ix_total ON orders(total)",
        "DROP INDEX ix_total; CREATE UNIQUE INDEX ix_total ON orders(total) WHERE total > 0",
        "DROP INDEX ix_total; CREATE UNIQUE INDEX ix_total ON orders(total DESC) WHERE total > 0",
        "ALTER TABLE orders ALTER COLUMN total SET DEFAULT 0",
        "ALTER TYPE mood ADD VALUE 'glad'",
        "DROP TABLE orders",
    ] {
        client
            .batch_execute(ddl)
            .await
            .unwrap_or_else(|e| panic!("{ddl}: {e}"));
        let next = fingerprint(&dialect, &db.name, Some("public")).await;
        assert_ne!(next, last, "{ddl}");
        last = next;
    }
    assert!(
        dialect
            .schema_fingerprint(&db.name, Some("no_such_schema"))
            .await
            .is_err(),
        "a missing schema has no fingerprint"
    );
    dialect.disconnect().await.ok();
    drop(client);
    db.drop_db().await;
}
