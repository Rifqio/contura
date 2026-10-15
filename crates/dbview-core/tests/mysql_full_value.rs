mod common;

use common::TestDb;
use dbview_core::dialect::{Dialect, connect};
use dbview_core::error::Error;
use dbview_core::model::{Cell, FullValue, FullValueRequest, KeyPart, ObjectPath};
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
        "CREATE TABLE items (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50), body LONGTEXT, data LONGBLOB)",
        "INSERT INTO items (name, body, data) VALUES \
         ('a', REPEAT('x', 3000), 0x000102FF), ('b', 'small', 0x41), ('c', 'big', REPEAT(0x41, 17*1024*1024))",
        "CREATE TABLE nopk (a INT, b TEXT)",
        "INSERT INTO nopk VALUES (1, 'x')",
        "CREATE TABLE kinds (id INT PRIMARY KEY, n INT, d DATE, f BIT(8), x DOUBLE)",
        "INSERT INTO kinds VALUES (1, -42, '2024-02-29', b'101', 1.5)",
        "CREATE TABLE bin_keyed (id BINARY(16) PRIMARY KEY, v TEXT)",
        "INSERT INTO bin_keyed VALUES (UNHEX('00112233445566778899AABBCCDDEEFF'), 'found by bytes')",
    ] {
        conn.query_drop(sql)
            .await
            .unwrap_or_else(|e| panic!("{}: {e}", &sql[..sql.len().min(60)]));
    }
    drop(conn);
    pool.disconnect().await.ok();
}

async fn open(db: &TestDb) -> std::sync::Arc<dyn Dialect> {
    connect(&db.config, db.password.as_deref())
        .await
        .expect("connect")
}

fn req(db: &TestDb, table: &str, column: &str, id: &str) -> FullValueRequest {
    FullValueRequest {
        table: ObjectPath {
            database: db.name.clone(),
            schema: None,
            name: table.into(),
        },
        column: column.into(),
        key: vec![KeyPart {
            column: "id".into(),
            value: Cell::Number { value: id.into() },
        }],
    }
}

#[tokio::test]
async fn returns_full_text() {
    let db = TestDb::create().await;
    seed(&db).await;
    match open(&db)
        .await
        .fetch_full_value(&req(&db, "items", "body", "1"))
        .await
        .expect("value")
    {
        FullValue::Text { value } => assert_eq!(value.chars().count(), 3000),
        other => panic!("{other:?}"),
    }
    db.drop_db().await;
}

#[tokio::test]
async fn returns_bytes_as_base64() {
    let db = TestDb::create().await;
    seed(&db).await;
    match open(&db)
        .await
        .fetch_full_value(&req(&db, "items", "data", "1"))
        .await
        .expect("value")
    {
        FullValue::Bytes { base64 } => assert_eq!(base64, "AAEC/w=="),
        other => panic!("{other:?}"),
    }
    db.drop_db().await;
}

#[tokio::test]
async fn no_primary_key() {
    let db = TestDb::create().await;
    seed(&db).await;
    let mut r = req(&db, "nopk", "b", "1");
    r.key = vec![KeyPart {
        column: "a".into(),
        value: Cell::Number { value: "1".into() },
    }];
    let err = open(&db)
        .await
        .fetch_full_value(&r)
        .await
        .expect_err("no pk");
    assert!(matches!(err, Error::NoPrimaryKey), "{err:?}");
    db.drop_db().await;
}

#[tokio::test]
async fn too_large_is_refused() {
    let db = TestDb::create().await;
    seed(&db).await;
    let err = open(&db)
        .await
        .fetch_full_value(&req(&db, "items", "data", "3"))
        .await
        .expect_err("too large");
    assert!(matches!(err, Error::ValueTooLarge(17_825_792)), "{err:?}");
    db.drop_db().await;
}

#[tokio::test]
async fn deleted_row_is_not_found() {
    let db = TestDb::create().await;
    seed(&db).await;
    let err = open(&db)
        .await
        .fetch_full_value(&req(&db, "items", "body", "999"))
        .await
        .expect_err("missing");
    assert!(matches!(err, Error::NotFound(_)), "{err:?}");
    db.drop_db().await;
}

#[tokio::test]
async fn key_must_name_the_primary_key_columns() {
    let db = TestDb::create().await;
    seed(&db).await;
    let mut r = req(&db, "items", "body", "1");
    r.key[0].column = "name".into();
    let err = open(&db)
        .await
        .fetch_full_value(&r)
        .await
        .expect_err("wrong key");
    assert!(matches!(err, Error::InvalidInput(_)), "{err:?}");
    db.drop_db().await;
}

#[tokio::test]
async fn truncated_text_key_is_invalid() {
    let db = TestDb::create().await;
    seed(&db).await;
    let mut r = req(&db, "items", "body", "1");
    r.key[0].value = Cell::Text {
        value: "1".into(),
        truncated: true,
        total_bytes: 5000,
    };
    let err = open(&db)
        .await
        .fetch_full_value(&r)
        .await
        .expect_err("truncated key");
    assert!(matches!(err, Error::InvalidInput(_)), "{err:?}");
    db.drop_db().await;
}

#[tokio::test]
async fn non_bytes_columns_return_text() {
    let db = TestDb::create().await;
    seed(&db).await;
    let dialect = open(&db).await;
    for (column, expected) in [("n", "-42"), ("d", "2024-02-29"), ("f", "5"), ("x", "1.5")] {
        match dialect
            .fetch_full_value(&req(&db, "kinds", column, "1"))
            .await
        {
            Ok(FullValue::Text { value }) => assert_eq!(value, expected, "column {column}"),
            other => panic!("column {column}: {other:?}"),
        }
    }
    db.drop_db().await;
}

fn binary_key(db: &TestDb, hex: &str, truncated: bool) -> FullValueRequest {
    FullValueRequest {
        table: ObjectPath {
            database: db.name.clone(),
            schema: None,
            name: "bin_keyed".into(),
        },
        column: "v".into(),
        key: vec![KeyPart {
            column: "id".into(),
            value: Cell::Bytes {
                preview_hex: hex.into(),
                truncated,
                total_bytes: 16,
            },
        }],
    }
}

#[tokio::test]
async fn binary_primary_key_identifies_the_row() {
    let db = TestDb::create().await;
    seed(&db).await;
    let dialect = open(&db).await;
    match dialect
        .fetch_full_value(&binary_key(&db, "00112233445566778899aabbccddeeff", false))
        .await
    {
        Ok(FullValue::Text { value }) => assert_eq!(value, "found by bytes"),
        other => panic!("{other:?}"),
    }
    let err = dialect
        .fetch_full_value(&binary_key(&db, "0011", true))
        .await
        .expect_err("truncated bytes key");
    assert!(matches!(err, Error::InvalidInput(_)), "{err:?}");
    let err = dialect
        .fetch_full_value(&binary_key(&db, "zz", false))
        .await
        .expect_err("bad hex");
    assert!(matches!(err, Error::InvalidInput(_)), "{err:?}");
    db.drop_db().await;
}
