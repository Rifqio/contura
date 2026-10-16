mod common;

use common::TestDb;
use dbview_core::dialect::{Dialect, connect};
use dbview_core::error::Error;
use dbview_core::model::{Cell, ObjectPath, PageRequest, SortSpec};
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
        "SET SESSION cte_max_recursion_depth = 5000",
        "CREATE TABLE items (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50), body LONGTEXT, data LONGBLOB, \
         big BIGINT UNSIGNED, price DECIMAL(30,10), note TEXT NULL, flags BIT(8))",
        "INSERT INTO items (name) WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 2500) \
         SELECT CONCAT('n', LPAD(n, 5, '0')) FROM seq",
        "UPDATE items SET body = REPEAT('é', 3000), \
         data = CONCAT(RANDOM_BYTES(1024), RANDOM_BYTES(1024), RANDOM_BYTES(1024)), \
         big = 18446744073709551615, price = 12345678901234567890.1234567890, note = NULL, flags = b'101' WHERE id = 1",
        "CREATE TABLE `we``ird name` (`ñame 表` INT PRIMARY KEY, `select` TEXT)",
        "INSERT INTO `we``ird name` VALUES (1, 'x')",
    ] {
        conn.query_drop(sql)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    drop(conn);
    pool.disconnect().await.ok();
}

fn req(db: &TestDb, table: &str, page: u32, sort: Option<SortSpec>) -> PageRequest {
    PageRequest {
        table: ObjectPath {
            database: db.name.clone(),
            schema: None,
            name: table.into(),
        },
        page,
        sort,
        filter: None,
    }
}

fn filtered(db: &TestDb, table: &str, filter: &str) -> PageRequest {
    PageRequest {
        filter: Some(filter.into()),
        ..req(db, table, 0, None)
    }
}

#[tokio::test]
async fn filter_narrows_the_page() {
    let db = TestDb::create().await;
    seed(&db).await;
    let dialect = open(&db).await;
    let page = dialect
        .fetch_page(&filtered(&db, "items", "id > 2490 -- the last ten"))
        .await
        .expect("page");
    assert_eq!(page.rows.len(), 10);
    assert!(!page.has_more);
    db.drop_db().await;
}

#[tokio::test]
async fn filter_runs_one_expression_only() {
    let db = TestDb::create().await;
    seed(&db).await;
    let dialect = open(&db).await;
    let attempt = dialect
        .fetch_page(&filtered(
            &db,
            "items",
            "1=1); DROP TABLE `we``ird name`; SELECT (1",
        ))
        .await;
    assert!(attempt.is_err(), "a second statement must be refused");
    let still = dialect
        .fetch_page(&req(&db, "we`ird name", 0, None))
        .await
        .expect("the table is still there");
    assert_eq!(still.rows.len(), 1);
    db.drop_db().await;
}

async fn open(db: &TestDb) -> std::sync::Arc<dyn Dialect> {
    connect(&db.config, db.password.as_deref())
        .await
        .expect("connect")
}

#[tokio::test]
async fn first_page_has_1000_rows_and_more() {
    let db = TestDb::create().await;
    seed(&db).await;
    let page = open(&db)
        .await
        .fetch_page(&req(&db, "items", 0, None))
        .await
        .expect("page");
    assert_eq!(page.rows.len(), 1000);
    assert!(page.has_more);
    assert_eq!(page.columns.len(), 8);
    assert!(page.columns[0].is_primary_key);
    db.drop_db().await;
}

#[tokio::test]
async fn third_page_has_500_rows_and_no_more() {
    let db = TestDb::create().await;
    seed(&db).await;
    let page = open(&db)
        .await
        .fetch_page(&req(&db, "items", 2, None))
        .await
        .expect("page");
    assert_eq!(page.rows.len(), 500);
    assert!(!page.has_more);
    db.drop_db().await;
}

#[tokio::test]
async fn sort_by_name_desc() {
    let db = TestDb::create().await;
    seed(&db).await;
    let sort = Some(SortSpec {
        column: "name".into(),
        descending: true,
    });
    let page = open(&db)
        .await
        .fetch_page(&req(&db, "items", 0, sort))
        .await
        .expect("page");
    match &page.rows[0][1] {
        Cell::Text { value, .. } => assert_eq!(value, "n02500"),
        other => panic!("{other:?}"),
    }
    db.drop_db().await;
}

#[tokio::test]
async fn sort_by_unknown_column_is_invalid_input() {
    let db = TestDb::create().await;
    seed(&db).await;
    let sort = Some(SortSpec {
        column: "nope`; DROP".into(),
        descending: false,
    });
    let err = open(&db)
        .await
        .fetch_page(&req(&db, "items", 0, sort))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::InvalidInput(_)), "{err:?}");
    db.drop_db().await;
}

#[tokio::test]
async fn page_truncates_large_values_in_sql() {
    let db = TestDb::create().await;
    seed(&db).await;
    let page = open(&db)
        .await
        .fetch_page(&req(&db, "items", 0, None))
        .await
        .expect("page");
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
    db.drop_db().await;
}

#[tokio::test]
async fn page_preserves_numeric_precision() {
    let db = TestDb::create().await;
    seed(&db).await;
    let page = open(&db)
        .await
        .fetch_page(&req(&db, "items", 0, None))
        .await
        .expect("page");
    assert_eq!(
        page.rows[0][4],
        Cell::Number {
            value: "18446744073709551615".into()
        }
    );
    assert_eq!(
        page.rows[0][5],
        Cell::Number {
            value: "12345678901234567890.1234567890".into()
        }
    );
    db.drop_db().await;
}

#[tokio::test]
async fn bit_column_is_decimal_number() {
    let db = TestDb::create().await;
    seed(&db).await;
    let page = open(&db)
        .await
        .fetch_page(&req(&db, "items", 0, None))
        .await
        .expect("page");
    assert_eq!(page.rows[0][7], Cell::Number { value: "5".into() });
    db.drop_db().await;
}

#[tokio::test]
async fn null_is_null() {
    let db = TestDb::create().await;
    seed(&db).await;
    let page = open(&db)
        .await
        .fetch_page(&req(&db, "items", 0, None))
        .await
        .expect("page");
    assert_eq!(page.rows[0][6], Cell::Null);
    db.drop_db().await;
}

#[tokio::test]
async fn page_handles_odd_identifiers() {
    let db = TestDb::create().await;
    seed(&db).await;
    let page = open(&db)
        .await
        .fetch_page(&req(&db, "we`ird name", 0, None))
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
    db.drop_db().await;
}
