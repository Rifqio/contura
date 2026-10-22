//! `RowSource` per Dialect: full values in chunks, from one consistent snapshot.
//! Live MySQL and PostgreSQL in `dbview_test_<8hex>` databases; SQLite in temp files.

mod common;

use std::sync::Arc;

use common::jobs::{every_type_columns, every_type_table, run_sql};
use contura_core::dialect::Dialect;
use contura_core::error::Error;
use contura_core::jobs::source::{CHUNK_BYTES, CHUNK_ROWS, RowSource, SourceRequest, Value};
use contura_core::model::{Cell, DialectKind, KeyPart, ObjectPath, PageRequest, SortSpec};

const ROWS: u64 = 100_000;
const REFUSE_WRITE: &str = "Only a statement that reads can be exported this way.";

fn table_req(path: &ObjectPath) -> SourceRequest {
    SourceRequest::Table {
        path: path.clone(),
        columns: Vec::new(),
        filter: None,
        sort: None,
        keys: Vec::new(),
    }
}

fn filtered(path: &ObjectPath, filter: &str) -> SourceRequest {
    SourceRequest::Table {
        path: path.clone(),
        columns: Vec::new(),
        filter: Some(filter.into()),
        sort: None,
        keys: Vec::new(),
    }
}

fn query(sql: &str) -> SourceRequest {
    SourceRequest::Query {
        database: None,
        sql: sql.into(),
    }
}

fn open_err(r: contura_core::Result<Box<dyn RowSource>>) -> Error {
    match r {
        Ok(_) => panic!("expected the source to be refused"),
        Err(e) => e,
    }
}

/// Reads every chunk, checking the limits; the total row count.
async fn drain(src: &mut dyn RowSource) -> u64 {
    let mut total = 0u64;
    while let Some(chunk) = src.next_chunk().await.expect("next chunk") {
        assert!(!chunk.rows.is_empty(), "a chunk is never empty");
        assert!(chunk.rows.len() <= CHUNK_ROWS, "{} rows", chunk.rows.len());
        assert!(chunk.bytes <= CHUNK_BYTES, "{} bytes", chunk.bytes);
        let bytes: usize = chunk.rows.iter().flatten().map(Value::size).sum();
        assert_eq!(chunk.bytes, bytes);
        total += chunk.rows.len() as u64;
    }
    total
}

fn col_index(src: &dyn RowSource, name: &str) -> usize {
    src.columns()
        .iter()
        .position(|c| c.name == name)
        .unwrap_or_else(|| panic!("no column {name}"))
}

/// The one row a filter selects.
async fn one_row(
    d: &dyn Dialect,
    path: &ObjectPath,
    filter: &str,
) -> (Box<dyn RowSource>, Vec<Value>) {
    let mut src = d
        .open_row_source(&filtered(path, filter))
        .await
        .expect("open");
    let chunk = src.next_chunk().await.expect("chunk").expect("one row");
    assert_eq!(chunk.rows.len(), 1);
    assert!(src.next_chunk().await.expect("end").is_none());
    let row = chunk.rows.into_iter().next().unwrap();
    (src, row)
}

// ---- Shared checks, run per Dialect ----

async fn check_reads_every_row(d: &dyn Dialect, kind: DialectKind, path: &ObjectPath) {
    let mut src = d.open_row_source(&table_req(path)).await.expect("open");
    let names: Vec<&str> = src.columns().iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, every_type_columns(kind));
    assert!(src.sql().starts_with("SELECT "), "{}", src.sql());
    assert_eq!(drain(src.as_mut()).await, ROWS);
}

async fn check_full_values(d: &dyn Dialect, path: &ObjectPath, update: &str) {
    run_sql(d, update).await;
    let (src, row) = one_row(d, path, "id = 5").await;
    let body = &row[col_index(src.as_ref(), "body")];
    let Value::Text(text) = body else {
        panic!("body is {body:?}")
    };
    assert_eq!(text.len(), 2 * 1024 * 1024);
    assert!(text.chars().all(|c| c == 'é'));
}

async fn check_snapshot(d: &dyn Dialect, path: &ObjectPath, insert: &str) {
    let mut src = d.open_row_source(&table_req(path)).await.expect("open");
    let first = src.next_chunk().await.expect("chunk").expect("rows");
    let mut total = first.rows.len() as u64;
    run_sql(d, insert).await;
    total += drain(src.as_mut()).await;
    assert_eq!(total, ROWS, "rows inserted meanwhile are not read");
    drop(src);
    // The rows are there: a new read sees them.
    let mut again = d.open_row_source(&table_req(path)).await.expect("open");
    assert_eq!(drain(again.as_mut()).await, ROWS + 10);
}

async fn check_filter(d: &dyn Dialect, path: &ObjectPath) {
    let err = open_err(
        d.open_row_source(&filtered(path, "1=1; DROP TABLE x"))
            .await,
    );
    assert!(matches!(err, Error::InvalidInput(_)), "{err:?}");
    let mut src = d
        .open_row_source(&filtered(path, "id <= 10"))
        .await
        .expect("open");
    assert!(src.sql().contains("WHERE (\nid <= 10\n)"), "{}", src.sql());
    assert_eq!(drain(src.as_mut()).await, 10);
    assert_eq!(src.estimate(), None, "no estimate for a filtered read");
}

fn key(a: i64, b: &str) -> Vec<KeyPart> {
    vec![
        KeyPart {
            column: "a".into(),
            value: Cell::Number {
                value: a.to_string(),
            },
        },
        KeyPart {
            column: "b".into(),
            value: Cell::Text {
                value: b.into(),
                truncated: false,
                total_bytes: b.len() as u64,
            },
        },
    ]
}

/// Table `pairs (a, b, v)` with primary key (a, b) and six rows.
async fn check_keys(d: &dyn Dialect, path: &ObjectPath) {
    let req = SourceRequest::Table {
        path: path.clone(),
        columns: vec!["v".into(), "a".into()],
        filter: None,
        sort: None,
        keys: vec![key(1, "x"), key(2, "it's"), key(3, "y")],
    };
    let mut src = d.open_row_source(&req).await.expect("open");
    let names: Vec<&str> = src.columns().iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["v", "a"]);
    assert_eq!(src.estimate(), None);
    let mut rows = Vec::new();
    while let Some(c) = src.next_chunk().await.expect("chunk") {
        rows.extend(c.rows);
    }
    rows.sort_by_key(|r| format!("{:?}", r[1]));
    assert_eq!(
        rows,
        vec![
            vec![Value::Text("one x".into()), Value::Number("1".into())],
            vec![Value::Text("two it's".into()), Value::Number("2".into())],
            vec![Value::Text("three y".into()), Value::Number("3".into())],
        ]
    );
}

async fn check_query_refuses_write(d: &dyn Dialect, path: &ObjectPath, write: &str) {
    let err = open_err(d.open_row_source(&query(write)).await);
    assert!(
        matches!(&err, Error::InvalidInput(m) if m == REFUSE_WRITE),
        "{err:?}"
    );
    // Nothing ran.
    let mut src = d.open_row_source(&table_req(path)).await.expect("open");
    assert_eq!(drain(src.as_mut()).await, ROWS);
}

async fn check_cancel(d: &dyn Dialect, path: &ObjectPath) {
    let mut src = d.open_row_source(&table_req(path)).await.expect("open");
    let first = src.next_chunk().await.expect("chunk").expect("rows");
    assert!(!first.rows.is_empty());
    src.canceller().cancel().await.expect("cancel");
    let started = std::time::Instant::now();
    let err = src.next_chunk().await.expect_err("cancelled");
    assert!(matches!(err, Error::Cancelled), "{err:?}");
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    // The source stays ended.
    assert!(matches!(
        src.next_chunk().await,
        Err(Error::Cancelled) | Ok(None)
    ));
}

async fn check_estimate(d: &dyn Dialect, path: &ObjectPath, select: &str) {
    let src = d.open_row_source(&table_req(path)).await.expect("open");
    let n = src.estimate().expect("an estimate for a plain table");
    assert!(n > 0, "estimate {n}");
    drop(src);
    let src = d.open_row_source(&query(select)).await.expect("open");
    assert_eq!(src.estimate(), None);
    assert_eq!(src.sql(), select);
}

mod mysql {
    use super::*;
    use crate::common::TestDb;
    use contura_core::dialect::connect;
    use contura_core::jobs::source::TableStorage;

    async fn setup(rows: u64) -> (TestDb, Arc<dyn Dialect>, ObjectPath) {
        let db = TestDb::create().await;
        let d = connect(&db.config, db.password.as_deref())
            .await
            .expect("connect");
        if rows > 0 {
            every_type_table(d.as_ref(), DialectKind::MySql, "every", rows).await;
        }
        let path = ObjectPath {
            database: db.name.clone(),
            schema: None,
            name: "every".into(),
        };
        (db, d, path)
    }

    #[tokio::test]
    async fn reads_every_row_in_chunks() {
        let (db, d, path) = setup(ROWS).await;
        check_reads_every_row(d.as_ref(), DialectKind::MySql, &path).await;
        d.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn full_values_not_previews() {
        let (db, d, path) = setup(ROWS).await;
        check_full_values(
            d.as_ref(),
            &path,
            "UPDATE every SET body = REPEAT('é', 1048576) WHERE id = 5",
        )
        .await;
        d.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn snapshot_excludes_rows_inserted_meanwhile() {
        let (db, d, path) = setup(ROWS).await;
        check_snapshot(
            d.as_ref(),
            &path,
            "INSERT INTO every (id) VALUES (100001), (100002), (100003), (100004), (100005), \
             (100006), (100007), (100008), (100009), (100010)",
        )
        .await;
        d.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn filter_passes_where_sql_and_one_statement_check() {
        let (db, d, path) = setup(ROWS).await;
        check_filter(d.as_ref(), &path).await;
        d.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn keys_select_only_those_rows() {
        let (db, d, mut path) = setup(0).await;
        run_sql(
            d.as_ref(),
            "CREATE TABLE pairs (a INT, b VARCHAR(10), v TEXT, PRIMARY KEY (a, b))",
        )
        .await;
        run_sql(
            d.as_ref(),
            "INSERT INTO pairs VALUES (1, 'x', 'one x'), (1, 'y', 'one y'), (2, 'it''s', 'two it''s'), \
             (2, 'x', 'two x'), (3, 'y', 'three y'), (4, 'x', 'four x')",
        )
        .await;
        path.name = "pairs".into();
        check_keys(d.as_ref(), &path).await;
        d.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn query_source_refuses_a_write() {
        let (db, d, path) = setup(ROWS).await;
        check_query_refuses_write(d.as_ref(), &path, "UPDATE every SET int_n = 0").await;
        let (_, row) = one_row(d.as_ref(), &path, "id = 1").await;
        assert_eq!(row[3], Value::Number("-349993".into()));
        // Row 1 of the fixture, type by type.
        let num = |v: &str| Value::Number(v.into());
        let text = |v: &str| Value::Text(v.into());
        assert_eq!(row[4], num("9223372036854775807"));
        assert_eq!(row[6], num("18446744073709551615"));
        assert_eq!(row[10], num("0"), "BOOLEAN is TINYINT(1)");
        assert_eq!(row[12], Value::Bytes(vec![0, 0xff, 0, 0, 0, 1]));
        assert!(matches!(&row[13], Value::Text(j) if j.contains("\"s\": \"v1\"")));
        assert_eq!(row[14], text("2000-01-02"));
        assert_eq!(row[18], text("sad"));
        assert_eq!(row[19], text("00000001-0000-4000-8000-000000000001"));
        d.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn cancel_stops_the_stream() {
        let (db, d, path) = setup(ROWS).await;
        check_cancel(d.as_ref(), &path).await;
        d.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn estimate_present_for_plain_table_absent_for_query() {
        let (db, d, path) = setup(ROWS).await;
        check_estimate(d.as_ref(), &path, "SELECT id, body FROM every WHERE id < 5").await;
        d.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn mysql_bit_and_spatial_as_text() {
        let (db, d, mut path) = setup(0).await;
        run_sql(
            d.as_ref(),
            "CREATE TABLE geo (id INT PRIMARY KEY, bits BIT(8), spot POINT, raw BLOB)",
        )
        .await;
        run_sql(
            d.as_ref(),
            "INSERT INTO geo VALUES (1, b'101', ST_GeomFromText('POINT(1 2)'), X'00FF'), (2, NULL, NULL, NULL)",
        )
        .await;
        path.name = "geo".into();
        let mut src = d.open_row_source(&table_req(&path)).await.expect("open");
        let kinds: Vec<_> = src.columns().iter().map(|c| c.type_name.clone()).collect();
        assert_eq!(kinds, ["int", "bit(8)", "point", "blob"]);
        let chunk = src.next_chunk().await.expect("chunk").expect("rows");
        assert_eq!(
            chunk.rows,
            vec![
                vec![
                    Value::Number("1".into()),
                    Value::Number("5".into()),
                    Value::Text("POINT(1 2)".into()),
                    Value::Bytes(vec![0, 0xff]),
                ],
                vec![
                    Value::Number("2".into()),
                    Value::Null,
                    Value::Null,
                    Value::Null
                ],
            ]
        );
        assert!(src.sql().contains("`bits` + 0"), "{}", src.sql());
        assert!(src.sql().contains("ST_AsText(`spot`)"), "{}", src.sql());
        d.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn table_storage_reports_myisam() {
        let (db, d, mut path) = setup(0).await;
        run_sql(d.as_ref(), "CREATE TABLE old_t (id INT) ENGINE=MyISAM").await;
        run_sql(d.as_ref(), "CREATE TABLE new_t (id INT) ENGINE=InnoDB").await;
        path.name = "old_t".into();
        assert_eq!(
            d.table_storage(&path).await.expect("storage"),
            TableStorage {
                transactional: false,
                engine: Some("MyISAM".into()),
                sqlite_wal: None,
            }
        );
        path.name = "new_t".into();
        assert_eq!(
            d.table_storage(&path).await.expect("storage"),
            TableStorage {
                transactional: true,
                engine: Some("InnoDB".into()),
                sqlite_wal: None,
            }
        );
        d.disconnect().await.ok();
        db.drop_db().await;
    }
}

mod postgres {
    use super::*;
    use crate::common::pg::PgTestDb;
    use contura_core::dialect::connect;
    use contura_core::jobs::source::TableStorage;

    async fn setup(rows: u64) -> (PgTestDb, Arc<dyn Dialect>, ObjectPath) {
        let db = PgTestDb::create().await;
        let d = connect(&db.config, db.password.as_deref())
            .await
            .expect("connect");
        if rows > 0 {
            every_type_table(d.as_ref(), DialectKind::Postgres, "every", rows).await;
        }
        let path = ObjectPath {
            database: db.name.clone(),
            schema: Some("public".into()),
            name: "every".into(),
        };
        (db, d, path)
    }

    #[tokio::test]
    async fn reads_every_row_in_chunks() {
        let (db, d, path) = setup(ROWS).await;
        check_reads_every_row(d.as_ref(), DialectKind::Postgres, &path).await;
        d.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn full_values_not_previews() {
        let (db, d, path) = setup(ROWS).await;
        check_full_values(
            d.as_ref(),
            &path,
            "UPDATE every SET body = repeat('é', 1048576) WHERE id = 5",
        )
        .await;
        d.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn snapshot_excludes_rows_inserted_meanwhile() {
        let (db, d, path) = setup(ROWS).await;
        check_snapshot(
            d.as_ref(),
            &path,
            "INSERT INTO every (id) SELECT g FROM generate_series(100001, 100010) g",
        )
        .await;
        d.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn filter_passes_where_sql_and_one_statement_check() {
        let (db, d, path) = setup(ROWS).await;
        check_filter(d.as_ref(), &path).await;
        d.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn keys_select_only_those_rows() {
        let (db, d, mut path) = setup(0).await;
        run_sql(
            d.as_ref(),
            "CREATE TABLE pairs (a int, b text, v text, PRIMARY KEY (a, b))",
        )
        .await;
        run_sql(
            d.as_ref(),
            "INSERT INTO pairs VALUES (1, 'x', 'one x'), (1, 'y', 'one y'), (2, 'it''s', 'two it''s'), \
             (2, 'x', 'two x'), (3, 'y', 'three y'), (4, 'x', 'four x')",
        )
        .await;
        path.name = "pairs".into();
        check_keys(d.as_ref(), &path).await;
        d.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn query_source_refuses_a_write() {
        let (db, d, path) = setup(ROWS).await;
        check_query_refuses_write(
            d.as_ref(),
            &path,
            "INSERT INTO every (id) VALUES (0) RETURNING id",
        )
        .await;
        d.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn cancel_stops_the_stream() {
        let (db, d, path) = setup(ROWS).await;
        check_cancel(d.as_ref(), &path).await;
        d.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn estimate_present_for_plain_table_absent_for_query() {
        let (db, d, path) = setup(ROWS).await;
        check_estimate(d.as_ref(), &path, "SELECT id, body FROM every WHERE id < 5").await;
        assert_eq!(
            d.table_storage(&path).await.expect("storage"),
            TableStorage {
                transactional: true,
                engine: None,
                sqlite_wal: None,
            }
        );
        d.disconnect().await.ok();
        db.drop_db().await;
    }

    /// Dropping the source mid-read closes its connection, which ends its transaction.
    #[tokio::test]
    async fn dropping_the_source_closes_its_connection() {
        let (db, d, path) = setup(ROWS).await;
        let admin = crate::common::pg::pg_admin_client(&db.name).await;
        let readers = || async {
            admin
                .query_one(
                    "SELECT count(*) FROM pg_stat_activity \
                     WHERE datname = current_database() AND query LIKE 'FETCH FORWARD%'",
                    &[],
                )
                .await
                .unwrap()
                .get::<_, i64>(0)
        };
        let mut src = d.open_row_source(&table_req(&path)).await.expect("open");
        src.next_chunk().await.expect("chunk").expect("rows");
        assert_eq!(readers().await, 1);
        drop(src);
        let mut left = 1;
        for _ in 0..50 {
            left = readers().await;
            if left == 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert_eq!(left, 0, "the export connection is closed");
        drop(admin);
        d.disconnect().await.ok();
        db.drop_db().await;
    }

    /// Rows of 64 KB: after the first FETCH of 1,000, each FETCH holds at most 8 MB.
    #[tokio::test]
    async fn wide_rows_keep_each_fetch_bounded_by_bytes() {
        let (db, d, mut path) = setup(0).await;
        run_sql(
            d.as_ref(),
            "CREATE TABLE wide (id int PRIMARY KEY, body text)",
        )
        .await;
        run_sql(
            d.as_ref(),
            "INSERT INTO wide SELECT g, repeat(chr(97 + g % 26), 65536) FROM generate_series(1, 2500) g",
        )
        .await;
        path.name = "wide".into();
        let mut src = d.open_row_source(&table_req(&path)).await.expect("open");
        let mut total = 0;
        while let Some(chunk) = src.next_chunk().await.expect("chunk") {
            for row in &chunk.rows {
                assert!(matches!(&row[1], Value::Text(t) if t.len() == 65536));
            }
            total += chunk.rows.len();
        }
        assert_eq!(total, 2500);
        let fetches = contura_core::postgres::fetches_for_test(&db.name);
        assert_eq!(fetches[0].0, 64, "the first FETCH is small: {fetches:?}");
        assert_eq!(fetches.last().unwrap().0, 0, "the last FETCH finds no rows");
        let later = &fetches[1..];
        assert!(later.len() > 3, "{fetches:?}");
        for (rows, bytes) in later {
            assert!(*bytes <= CHUNK_BYTES, "{rows} rows held {bytes} bytes");
        }
        assert_eq!(fetches.iter().map(|f| f.0).sum::<u64>(), 2500);
        d.disconnect().await.ok();
        db.drop_db().await;
    }

    /// json and point have no ordering: the sort casts them to text, as the grid does.
    #[tokio::test]
    async fn sort_on_unorderable_type_casts_like_the_grid() {
        let (db, d, mut path) = setup(0).await;
        run_sql(
            d.as_ref(),
            "CREATE TABLE docs (id int PRIMARY KEY, doc json, spot point)",
        )
        .await;
        run_sql(
            d.as_ref(),
            "INSERT INTO docs VALUES (1, '{\"b\": 1}', '(1,1)'), (2, '{\"a\": 2}', '(0,0)'),              (3, '{\"c\": 0}', '(2,2)')",
        )
        .await;
        path.name = "docs".into();
        let ids = |sort: SortSpec| {
            let d = d.clone();
            let path = path.clone();
            async move {
                let req = SourceRequest::Table {
                    path,
                    columns: vec!["id".into()],
                    filter: None,
                    sort: Some(sort),
                    keys: Vec::new(),
                };
                let mut src = d.open_row_source(&req).await.expect("open");
                let mut ids = Vec::new();
                while let Some(c) = src.next_chunk().await.expect("chunk") {
                    ids.extend(c.rows.into_iter().map(|r| r[0].clone()));
                }
                ids
            }
        };
        let n = |v: &str| Value::Number(v.into());
        assert_eq!(
            ids(SortSpec {
                column: "doc".into(),
                descending: false
            })
            .await,
            [n("2"), n("1"), n("3")]
        );
        assert_eq!(
            ids(SortSpec {
                column: "spot".into(),
                descending: true
            })
            .await,
            [n("3"), n("1"), n("2")]
        );
        d.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn pg_bytea_bool_and_utc_timestamptz() {
        let (db, d, path) = setup(20).await;
        let (src, row) = one_row(d.as_ref(), &path, "id = 1").await;
        let at = |name: &str| row[col_index(src.as_ref(), name)].clone();
        assert_eq!(at("bin"), Value::Bytes(vec![0, 0xff, 0, 0, 0, 1]));
        assert_eq!(at("flag"), Value::Bool(false));
        assert_eq!(
            at("at_tz"),
            Value::Text("2001-02-02 21:05:07.000001+00".into())
        );
        assert_eq!(at("big_n"), Value::Number("9223372036854775807".into()));
        assert_eq!(at("tags"), Value::Text("{1,2,NULL}".into()));
        let (src, row) = one_row(d.as_ref(), &path, "id = 2").await;
        assert_eq!(row[col_index(src.as_ref(), "flag")], Value::Bool(true));
        assert_eq!(
            row[col_index(src.as_ref(), "float_n")],
            Value::Number("NaN".into())
        );
        let (src, row) = one_row(d.as_ref(), &path, "id = 10").await;
        assert_eq!(row[col_index(src.as_ref(), "flag")], Value::Null);
        assert_eq!(row[col_index(src.as_ref(), "bin")], Value::Null);
        // A query reads the same way.
        let mut q = d
            .open_row_source(&query("SELECT bin, flag, at_tz FROM every WHERE id = 1"))
            .await
            .expect("open");
        let rows = q.next_chunk().await.expect("chunk").expect("row").rows;
        assert_eq!(
            rows[0],
            vec![
                Value::Bytes(vec![0, 0xff, 0, 0, 0, 1]),
                Value::Bool(false),
                Value::Text("2001-02-02 21:05:07.000001+00".into()),
            ]
        );
        d.disconnect().await.ok();
        db.drop_db().await;
    }
}

mod sqlite {
    use super::*;
    use contura_core::dialect::connect;
    use contura_core::jobs::source::TableStorage;
    use contura_core::model::{ConnectionConfig, SslMode};

    /// A WAL file in a temp folder, so another connection can write while a read runs.
    async fn setup(rows: u64) -> (tempfile::TempDir, Arc<dyn Dialect>, ObjectPath) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("every.sqlite");
        {
            let conn = rusqlite::Connection::open(&file).unwrap();
            let mode: String = conn
                .query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))
                .unwrap();
            assert_eq!(mode, "wal");
        }
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
            file: Some(file),
            query_timeout_secs: None,
            ai_access: Default::default(),
            ai_sync: Default::default(),
            production: false,
            read_only: false,
        };
        let d = connect(&config, None).await.expect("connect");
        if rows > 0 {
            every_type_table(d.as_ref(), DialectKind::Sqlite, "every", rows).await;
        }
        let path = ObjectPath {
            database: "main".into(),
            schema: None,
            name: "every".into(),
        };
        (dir, d, path)
    }

    #[tokio::test]
    async fn reads_every_row_in_chunks() {
        let (_dir, d, path) = setup(ROWS).await;
        check_reads_every_row(d.as_ref(), DialectKind::Sqlite, &path).await;
    }

    #[tokio::test]
    async fn full_values_not_previews() {
        let (_dir, d, path) = setup(ROWS).await;
        check_full_values(
            d.as_ref(),
            &path,
            "UPDATE every SET body = replace(hex(zeroblob(1048576)), '00', 'é') WHERE id = 5",
        )
        .await;
    }

    /// Q7: the file is in WAL mode, so the insert goes through while the read is open,
    /// and the read still sees its own snapshot.
    #[tokio::test]
    async fn snapshot_excludes_rows_inserted_meanwhile() {
        let (_dir, d, path) = setup(ROWS).await;
        assert_eq!(
            d.table_storage(&path).await.expect("storage").sqlite_wal,
            Some(true)
        );
        check_snapshot(
            d.as_ref(),
            &path,
            "INSERT INTO every (id) WITH RECURSIVE s(n) AS (SELECT 100001 UNION ALL \
             SELECT n + 1 FROM s WHERE n < 100010) SELECT n FROM s",
        )
        .await;
    }

    #[tokio::test]
    async fn filter_passes_where_sql_and_one_statement_check() {
        let (_dir, d, path) = setup(ROWS).await;
        check_filter(d.as_ref(), &path).await;
    }

    #[tokio::test]
    async fn keys_select_only_those_rows() {
        let (_dir, d, mut path) = setup(0).await;
        run_sql(
            d.as_ref(),
            "CREATE TABLE pairs (a INTEGER, b TEXT, v TEXT, PRIMARY KEY (a, b))",
        )
        .await;
        run_sql(
            d.as_ref(),
            "INSERT INTO pairs VALUES (1, 'x', 'one x'), (1, 'y', 'one y'), (2, 'it''s', 'two it''s'), \
             (2, 'x', 'two x'), (3, 'y', 'three y'), (4, 'x', 'four x')",
        )
        .await;
        path.name = "pairs".into();
        check_keys(d.as_ref(), &path).await;
    }

    #[tokio::test]
    async fn query_source_refuses_a_write() {
        let (_dir, d, path) = setup(ROWS).await;
        check_query_refuses_write(d.as_ref(), &path, "UPDATE every SET int_n = 0").await;
        let (_, row) = one_row(d.as_ref(), &path, "id = 1").await;
        assert_eq!(row[2], Value::Number("-349993".into()));
    }

    #[tokio::test]
    async fn cancel_stops_the_stream() {
        let (_dir, d, path) = setup(ROWS).await;
        check_cancel(d.as_ref(), &path).await;
    }

    #[tokio::test]
    async fn estimate_present_for_plain_table_absent_for_query() {
        let (_dir, d, path) = setup(ROWS).await;
        check_estimate(d.as_ref(), &path, "SELECT id, body FROM every WHERE id < 5").await;
        let src = d.open_row_source(&table_req(&path)).await.expect("open");
        assert_eq!(src.estimate(), Some(ROWS));
    }

    #[tokio::test]
    async fn sqlite_wal_browse_reads_while_exporting() {
        let (_dir, d, path) = setup(ROWS).await;
        assert_eq!(
            d.table_storage(&path).await.expect("storage"),
            TableStorage {
                transactional: true,
                engine: None,
                sqlite_wal: Some(true),
            }
        );
        let mut src = d.open_row_source(&table_req(&path)).await.expect("open");
        let first = src.next_chunk().await.expect("chunk").expect("rows");
        // While the export holds its read, browsing reads and saving writes go on.
        let page = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            d.fetch_page(&PageRequest {
                table: path.clone(),
                page: 0,
                sort: None,
                filter: None,
            }),
        )
        .await
        .expect("browse does not wait")
        .expect("page");
        assert_eq!(page.rows.len(), 1000);
        let edits = d.open_query_session(None).await.expect("session");
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            edits.execute("UPDATE every SET body = 'changed' WHERE id = 99999"),
        )
        .await
        .expect("a save does not wait")
        .expect("update");
        edits.close().await.ok();
        let total = first.rows.len() as u64 + drain(src.as_mut()).await;
        assert_eq!(total, ROWS);
    }
}
