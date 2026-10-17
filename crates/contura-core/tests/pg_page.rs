mod common;

use std::collections::HashSet;
use std::sync::Arc;

use base64::Engine;
use common::pg::{PgTestDb, pg_admin_client};
use contura_core::dialect::{Dialect, connect};
use contura_core::error::Error;
use contura_core::model::{
    Cell, FullValue, FullValueRequest, KeyPart, ObjectPath, PageRequest, SortSpec,
};

async fn fixture() -> (PgTestDb, Arc<dyn Dialect>) {
    let db = PgTestDb::create().await;
    let admin = pg_admin_client(&db.name).await;
    admin
        .batch_execute(
            "CREATE TABLE public.items (id serial PRIMARY KEY, name text, body text, data bytea,
                 big bigint, price numeric(30,10), at timestamptz, tags text[], note text);
             INSERT INTO public.items (name)
               SELECT 'n' || lpad(g::text, 5, '0') FROM generate_series(1, 2500) g;
             UPDATE public.items SET body = repeat('é', 3000),
                                     data = decode(repeat('ab', 3072), 'hex'),
                                     big = 9223372036854775807,
                                     price = 12345678901234567890.1234567890,
                                     at = '2026-01-01 00:00:00+07',
                                     tags = '{a,\"b c\"}',
                                     note = NULL
               WHERE id = 1;
             CREATE SCHEMA sales;
             CREATE TABLE sales.items (id int PRIMARY KEY);
             INSERT INTO sales.items VALUES (1), (2), (3);
             CREATE TABLE public.nopk (v text);
             INSERT INTO public.nopk SELECT 'v' || g FROM generate_series(1, 1500) g;
             CREATE TABLE public.\"we\"\"ird name\" (\"ñame 表\" int PRIMARY KEY, \"select\" text);
             INSERT INTO public.\"we\"\"ird name\" VALUES (1, 'x');
             CREATE TABLE public.bk (k bytea PRIMARY KEY, v text);
             INSERT INTO public.bk VALUES ('\\x00ff10'::bytea, 'found by bytes'), ('\\x01'::bytea, 'other');
             CREATE TABLE public.docs (id int PRIMARY KEY, doc json, spot point);
             INSERT INTO public.docs VALUES (1, '\"cherry\"', '(3,3)'), (2, '\"apple\"', '(1,1)'),
                                            (3, '\"banana\"', '(2,2)');",
        )
        .await
        .expect("seed");
    drop(admin);
    let dialect = connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    (db, dialect)
}

fn table(db: &PgTestDb, schema: &str, name: &str) -> ObjectPath {
    ObjectPath {
        database: db.name.clone(),
        schema: Some(schema.into()),
        name: name.into(),
    }
}

fn req(db: &PgTestDb, name: &str, page: u32, sort: Option<SortSpec>) -> PageRequest {
    PageRequest {
        table: table(db, "public", name),
        page,
        sort,
        filter: None,
    }
}

fn filtered(db: &PgTestDb, name: &str, filter: &str) -> PageRequest {
    PageRequest {
        filter: Some(filter.into()),
        ..req(db, name, 0, None)
    }
}

#[tokio::test]
async fn filter_narrows_the_page() {
    let (db, dialect) = fixture().await;
    let page = dialect
        .fetch_page(&filtered(&db, "items", "id > 2490 -- the last ten"))
        .await
        .expect("page");
    assert_eq!(page.rows.len(), 10);
    assert!(!page.has_more);
    finish(db, dialect).await;
}

#[tokio::test]
async fn filter_runs_one_expression_only() {
    let (db, dialect) = fixture().await;
    let attempt = dialect
        // The tail is a valid statement too, so without the guard all three would commit.
        .fetch_page(&filtered(
            &db,
            "items",
            "1=1); DROP TABLE public.nopk; SELECT t.id FROM public.items t WHERE (true",
        ))
        .await;
    assert!(attempt.is_err(), "a second statement must be refused");
    let still = dialect
        .fetch_page(&req(&db, "nopk", 0, None))
        .await
        .expect("nopk is still there");
    assert_eq!(still.rows.len(), 1000);
    finish(db, dialect).await;
}

fn full(db: &PgTestDb, name: &str, column: &str, key: &str, value: Cell) -> FullValueRequest {
    FullValueRequest {
        table: table(db, "public", name),
        column: column.into(),
        key: vec![KeyPart {
            column: key.into(),
            value,
        }],
    }
}

async fn finish(db: PgTestDb, dialect: Arc<dyn Dialect>) {
    dialect.disconnect().await.ok();
    drop(dialect);
    db.drop_db().await;
}

fn text_value(cell: &Cell) -> &str {
    match cell {
        Cell::Text { value, .. } => value,
        other => panic!("expected text, got {other:?}"),
    }
}

#[tokio::test]
async fn first_page_has_1000_rows_and_more() {
    let (db, dialect) = fixture().await;
    let page = dialect
        .fetch_page(&req(&db, "items", 0, None))
        .await
        .expect("page");
    assert_eq!(page.rows.len(), 1000);
    assert!(page.has_more);
    assert_eq!(page.columns.len(), 9);
    assert!(page.columns[0].is_primary_key);
    assert!(!page.columns[1].is_primary_key);
    assert_eq!(page.columns[0].type_name, "integer");
    assert_eq!(page.columns[3].type_name, "bytea");
    assert_eq!(page.columns[5].type_name, "numeric(30,10)");
    assert_eq!(page.columns[7].type_name, "text[]");
    assert_eq!(page.rows[0][0], Cell::Number { value: "1".into() });
    assert_eq!(
        page.rows[999][0],
        Cell::Number {
            value: "1000".into()
        }
    );
    finish(db, dialect).await;
}

#[tokio::test]
async fn third_page_has_500_rows_and_no_more() {
    let (db, dialect) = fixture().await;
    let page = dialect
        .fetch_page(&req(&db, "items", 2, None))
        .await
        .expect("page");
    assert_eq!(page.rows.len(), 500);
    assert!(!page.has_more);
    assert_eq!(
        page.rows[0][0],
        Cell::Number {
            value: "2001".into()
        }
    );
    finish(db, dialect).await;
}

#[tokio::test]
async fn sort_by_name_desc() {
    let (db, dialect) = fixture().await;
    let sort = Some(SortSpec {
        column: "name".into(),
        descending: true,
    });
    let page = dialect
        .fetch_page(&req(&db, "items", 0, sort))
        .await
        .expect("page");
    assert_eq!(text_value(&page.rows[0][1]), "n02500");
    assert_eq!(text_value(&page.rows[1][1]), "n02499");
    finish(db, dialect).await;
}

#[tokio::test]
async fn sort_by_unknown_column_is_invalid_input() {
    let (db, dialect) = fixture().await;
    let sort = Some(SortSpec {
        column: "nope\"; DROP".into(),
        descending: false,
    });
    let err = dialect
        .fetch_page(&req(&db, "items", 0, sort))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::InvalidInput(_)), "{err:?}");
    finish(db, dialect).await;
}

#[tokio::test]
async fn sort_by_json_column_sorts_by_text() {
    let (db, dialect) = fixture().await;
    for (column, descending, expected) in [
        ("doc", false, ["2", "3", "1"]),
        ("doc", true, ["1", "3", "2"]),
        ("spot", false, ["2", "3", "1"]),
    ] {
        let sort = Some(SortSpec {
            column: column.into(),
            descending,
        });
        let page = dialect
            .fetch_page(&req(&db, "docs", 0, sort))
            .await
            .unwrap_or_else(|e| panic!("sort by {column}: {e:?}"));
        let ids: Vec<Cell> = page.rows.iter().map(|r| r[0].clone()).collect();
        let expected: Vec<Cell> = expected
            .iter()
            .map(|v| Cell::Number { value: (*v).into() })
            .collect();
        assert_eq!(ids, expected, "sort by {column} descending={descending}");
    }
    finish(db, dialect).await;
}

#[tokio::test]
async fn page_truncates_large_values_in_sql() {
    let (db, dialect) = fixture().await;
    let page = dialect
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
            assert!(preview_hex.starts_with("abab"));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(page.rows[1][3], Cell::Null);
    finish(db, dialect).await;
}

#[tokio::test]
async fn values_are_shown_as_stored() {
    let (db, dialect) = fixture().await;
    let page = dialect
        .fetch_page(&req(&db, "items", 0, None))
        .await
        .expect("page");
    let row = &page.rows[0];
    assert_eq!(
        row[4],
        Cell::Number {
            value: "9223372036854775807".into()
        }
    );
    assert_eq!(
        row[5],
        Cell::Number {
            value: "12345678901234567890.1234567890".into()
        }
    );
    assert_eq!(text_value(&row[6]), "2025-12-31 17:00:00+00");
    assert_eq!(
        row[7],
        Cell::Text {
            value: "{a,\"b c\"}".into(),
            truncated: false,
            total_bytes: 9
        }
    );
    assert_eq!(row[8], Cell::Null);
    finish(db, dialect).await;
}

#[tokio::test]
async fn same_table_name_in_two_schemas_pages_separately() {
    let (db, dialect) = fixture().await;
    let page = dialect
        .fetch_page(&PageRequest {
            table: table(&db, "sales", "items"),
            page: 0,
            sort: None,
            filter: None,
        })
        .await
        .expect("page");
    assert_eq!(page.rows.len(), 3);
    assert_eq!(page.columns.len(), 1);
    assert!(!page.has_more);
    finish(db, dialect).await;
}

#[tokio::test]
async fn table_without_pk_pages_without_overlap() {
    let (db, dialect) = fixture().await;
    let first = dialect
        .fetch_page(&req(&db, "nopk", 0, None))
        .await
        .expect("page");
    let second = dialect
        .fetch_page(&req(&db, "nopk", 1, None))
        .await
        .expect("page");
    assert_eq!(first.rows.len(), 1000);
    assert!(first.has_more);
    assert_eq!(second.rows.len(), 500);
    assert!(!second.has_more);
    let distinct: HashSet<String> = first
        .rows
        .iter()
        .chain(second.rows.iter())
        .map(|r| text_value(&r[0]).to_string())
        .collect();
    assert_eq!(distinct.len(), 1500);
    finish(db, dialect).await;
}

#[tokio::test]
async fn missing_schema_is_invalid_input() {
    let (db, dialect) = fixture().await;
    let mut request = req(&db, "items", 0, None);
    request.table.schema = None;
    let err = dialect.fetch_page(&request).await.unwrap_err();
    assert!(
        matches!(&err, Error::InvalidInput(m) if m == "choose a schema"),
        "{err:?}"
    );
    finish(db, dialect).await;
}

#[tokio::test]
async fn unknown_table_is_not_found() {
    let (db, dialect) = fixture().await;
    let err = dialect
        .fetch_page(&req(&db, "nothing_here", 0, None))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NotFound(_)), "{err:?}");
    finish(db, dialect).await;
}

#[tokio::test]
async fn page_handles_odd_identifiers() {
    let (db, dialect) = fixture().await;
    let page = dialect
        .fetch_page(&req(&db, "we\"ird name", 0, None))
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
    finish(db, dialect).await;
}

#[tokio::test]
async fn full_value_returns_whole_text_and_bytes() {
    let (db, dialect) = fixture().await;
    let key = Cell::Number { value: "1".into() };
    match dialect
        .fetch_full_value(&full(&db, "items", "body", "id", key.clone()))
        .await
        .expect("body")
    {
        FullValue::Text { value } => assert_eq!(value, "é".repeat(3000)),
        other => panic!("{other:?}"),
    }
    match dialect
        .fetch_full_value(&full(&db, "items", "data", "id", key.clone()))
        .await
        .expect("data")
    {
        FullValue::Bytes { base64 } => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(base64)
                .unwrap();
            assert_eq!(bytes, vec![0xab; 3072]);
        }
        other => panic!("{other:?}"),
    }
    match dialect
        .fetch_full_value(&full(&db, "items", "at", "id", key.clone()))
        .await
        .expect("at")
    {
        FullValue::Text { value } => assert_eq!(value, "2025-12-31 17:00:00+00"),
        other => panic!("{other:?}"),
    }
    let gone = dialect
        .fetch_full_value(&full(
            &db,
            "items",
            "body",
            "id",
            Cell::Number {
                value: "99999".into(),
            },
        ))
        .await
        .unwrap_err();
    assert!(
        matches!(&gone, Error::NotFound(m) if m == "row no longer exists"),
        "{gone:?}"
    );
    finish(db, dialect).await;
}

#[tokio::test]
async fn full_value_without_pk_is_no_primary_key() {
    let (db, dialect) = fixture().await;
    let err = dialect
        .fetch_full_value(&full(
            &db,
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
    finish(db, dialect).await;
}

#[tokio::test]
async fn full_value_by_bytea_key() {
    let (db, dialect) = fixture().await;
    let page = dialect
        .fetch_page(&req(&db, "bk", 0, None))
        .await
        .expect("page");
    let key = page
        .rows
        .iter()
        .find(|r| text_value(&r[1]) == "found by bytes")
        .map(|r| r[0].clone())
        .expect("row");
    assert_eq!(
        key,
        Cell::Bytes {
            preview_hex: "00ff10".into(),
            truncated: false,
            total_bytes: 3
        }
    );
    match dialect
        .fetch_full_value(&full(&db, "bk", "v", "k", key))
        .await
        .expect("value")
    {
        FullValue::Text { value } => assert_eq!(value, "found by bytes"),
        other => panic!("{other:?}"),
    }
    finish(db, dialect).await;
}
