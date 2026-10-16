use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use base64::Engine;
use dbview_core::dialect::{Dialect, connect};
use dbview_core::error::Error;
use dbview_core::model::{
    Cell, ConnectionConfig, DialectKind, FullValue, FullValueRequest, KeyPart, ObjectPath,
    PageRequest, SortSpec, SslMode,
};

fn seed(path: &Path) {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch(
        "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, body TEXT, data BLOB, n INTEGER, r REAL, note TEXT);
         INSERT INTO items (id, name)
           WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 2500)
           SELECT n, printf('n%05d', n) FROM seq;
         UPDATE items SET body = (WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 3000)
                                  SELECT group_concat('é', '') FROM s),
                          data = randomblob(3072),
                          n = 9223372036854775807,
                          r = 0.1 + 0.2,
                          note = NULL
           WHERE id = 1;
         CREATE TABLE mixed (k TEXT PRIMARY KEY, v INTEGER);
         INSERT INTO mixed VALUES ('a', 5), ('b', 'five'), ('c', x'00ff');
         CREATE TABLE nopk (v TEXT);
         INSERT INTO nopk
           WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1500)
           SELECT 'v' || n FROM seq;
         CREATE TABLE \"we\"\"ird name\" (\"ñame 表\" INTEGER PRIMARY KEY, \"select\" TEXT);
         INSERT INTO \"we\"\"ird name\" VALUES (1, 'x');",
    )
    .unwrap();
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
        query_timeout_secs: None,
    };
    connect(&config, None).await.expect("connect")
}

async fn fixture() -> (tempfile::TempDir, Arc<dyn Dialect>) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p.sqlite");
    seed(&path);
    let db = open(&path).await;
    (dir, db)
}

fn table(name: &str) -> ObjectPath {
    ObjectPath {
        database: "main".into(),
        schema: None,
        name: name.into(),
    }
}

fn req(name: &str, page: u32, sort: Option<SortSpec>) -> PageRequest {
    PageRequest {
        table: table(name),
        page,
        sort,
    }
}

fn full(name: &str, column: &str, key: &str, value: Cell) -> FullValueRequest {
    FullValueRequest {
        table: table(name),
        column: column.into(),
        key: vec![KeyPart {
            column: key.into(),
            value,
        }],
    }
}

#[tokio::test]
async fn first_page_has_1000_rows_and_more() {
    let (_d, db) = fixture().await;
    let page = db.fetch_page(&req("items", 0, None)).await.expect("page");
    assert_eq!(page.rows.len(), 1000);
    assert!(page.has_more);
    assert_eq!(page.columns.len(), 7);
    assert!(page.columns[0].is_primary_key);
    assert_eq!(page.columns[3].type_name, "BLOB");
}

#[tokio::test]
async fn third_page_has_500_rows_and_no_more() {
    let (_d, db) = fixture().await;
    let page = db.fetch_page(&req("items", 2, None)).await.expect("page");
    assert_eq!(page.rows.len(), 500);
    assert!(!page.has_more);
}

#[tokio::test]
async fn sort_by_name_desc() {
    let (_d, db) = fixture().await;
    let sort = Some(SortSpec {
        column: "name".into(),
        descending: true,
    });
    let page = db.fetch_page(&req("items", 0, sort)).await.expect("page");
    match &page.rows[0][1] {
        Cell::Text { value, .. } => assert_eq!(value, "n02500"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn sort_by_unknown_column_is_invalid_input() {
    let (_d, db) = fixture().await;
    let sort = Some(SortSpec {
        column: "nope\"; DROP".into(),
        descending: false,
    });
    let err = db.fetch_page(&req("items", 0, sort)).await.unwrap_err();
    assert!(matches!(err, Error::InvalidInput(_)), "{err:?}");
}

#[tokio::test]
async fn page_truncates_large_values_in_sql() {
    let (_d, db) = fixture().await;
    let page = db.fetch_page(&req("items", 0, None)).await.expect("page");
    match &page.rows[0][2] {
        Cell::Text {
            value,
            truncated,
            total_bytes,
        } => {
            assert!(*truncated);
            assert_eq!(*total_bytes, 6000);
            assert_eq!(value.chars().count(), 1024);
        }
        other => panic!("{other:?}"),
    }
    match &page.rows[0][3] {
        Cell::Bytes {
            preview_hex,
            truncated,
            total_bytes,
        } => {
            assert!(*truncated);
            assert_eq!(*total_bytes, 3072);
            assert_eq!(preview_hex.len(), 2048);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(page.rows[0][6], Cell::Null);
}

#[tokio::test]
async fn numbers_keep_their_exact_text() {
    let (_d, db) = fixture().await;
    let page = db.fetch_page(&req("items", 0, None)).await.expect("page");
    assert_eq!(
        page.rows[0][4],
        Cell::Number {
            value: "9223372036854775807".into()
        }
    );
    assert_eq!(
        page.rows[0][5],
        Cell::Number {
            value: "0.30000000000000004".into()
        }
    );
}

#[tokio::test]
async fn mixed_storage_classes_become_matching_cells() {
    let (_d, db) = fixture().await;
    let page = db.fetch_page(&req("mixed", 0, None)).await.expect("page");
    assert_eq!(page.rows[0][1], Cell::Number { value: "5".into() });
    assert_eq!(
        page.rows[1][1],
        Cell::Text {
            value: "five".into(),
            truncated: false,
            total_bytes: 4
        }
    );
    assert_eq!(
        page.rows[2][1],
        Cell::Bytes {
            preview_hex: "00ff".into(),
            truncated: false,
            total_bytes: 2
        }
    );
}

#[tokio::test]
async fn table_without_pk_pages_without_overlap() {
    let (_d, db) = fixture().await;
    let first = db.fetch_page(&req("nopk", 0, None)).await.expect("page");
    let second = db.fetch_page(&req("nopk", 1, None)).await.expect("page");
    assert_eq!(first.rows.len(), 1000);
    assert!(first.has_more);
    assert_eq!(second.rows.len(), 500);
    assert!(!second.has_more);
    let distinct: HashSet<String> = first
        .rows
        .iter()
        .chain(second.rows.iter())
        .map(|r| match &r[0] {
            Cell::Text { value, .. } => value.clone(),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(distinct.len(), 1500);
}

#[tokio::test]
async fn page_handles_odd_identifiers() {
    let (_d, db) = fixture().await;
    let page = db
        .fetch_page(&req("we\"ird name", 0, None))
        .await
        .expect("page");
    assert_eq!(page.rows.len(), 1);
    let names: Vec<&str> = page.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["ñame 表", "select"]);
    assert_eq!(page.rows[0][0], Cell::Number { value: "1".into() });
    assert_eq!(
        page.rows[0][1],
        Cell::Text {
            value: "x".into(),
            truncated: false,
            total_bytes: 1
        }
    );
}

#[tokio::test]
async fn full_value_returns_whole_text_and_bytes() {
    let (_d, db) = fixture().await;
    let key = Cell::Number { value: "1".into() };
    match db
        .fetch_full_value(&full("items", "body", "id", key.clone()))
        .await
        .expect("body")
    {
        FullValue::Text { value } => assert_eq!(value.chars().count(), 3000),
        other => panic!("{other:?}"),
    }
    match db
        .fetch_full_value(&full("items", "data", "id", key))
        .await
        .expect("data")
    {
        FullValue::Bytes { base64 } => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(base64)
                .unwrap();
            assert_eq!(bytes.len(), 3072);
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn full_value_with_text_key() {
    let (_d, db) = fixture().await;
    let key = Cell::Text {
        value: "b".into(),
        truncated: false,
        total_bytes: 1,
    };
    match db
        .fetch_full_value(&full("mixed", "v", "k", key))
        .await
        .expect("value")
    {
        FullValue::Text { value } => assert_eq!(value, "five"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn full_value_without_pk_is_no_primary_key() {
    let (_d, db) = fixture().await;
    let err = db
        .fetch_full_value(&full(
            "nopk",
            "v",
            "v",
            Cell::Text {
                value: "v1".into(),
                truncated: false,
                total_bytes: 2,
            },
        ))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NoPrimaryKey), "{err:?}");
}
