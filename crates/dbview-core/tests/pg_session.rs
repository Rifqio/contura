mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::pg::PgTestDb;
use dbview_core::dialect::{Dialect, connect};
use dbview_core::error::Error;
use dbview_core::model::{Cell, PREVIEW_CHARS};
use dbview_core::query::{ExecOutcome, ResultColumn};

async fn fixture() -> (PgTestDb, Arc<dyn Dialect>) {
    let db = PgTestDb::create().await;
    let dialect = connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    (db, dialect)
}

fn rows(o: ExecOutcome) -> (Vec<ResultColumn>, Vec<Vec<Cell>>, bool) {
    match o {
        ExecOutcome::Rows {
            columns,
            rows,
            has_more,
        } => (columns, rows, has_more),
        other => panic!("expected rows, got {other:?}"),
    }
}

fn text(c: &Cell) -> &str {
    match c {
        Cell::Number { value } | Cell::Text { value, .. } => value,
        other => panic!("expected a value, got {other:?}"),
    }
}

#[tokio::test]
async fn pg_rows_page_and_types() {
    let (db, d) = fixture().await;
    let s = d.open_query_session(Some(&db.name)).await.unwrap();
    let (cols, first, more) = rows(
        s.execute("SELECT g AS n, g::text AS s, NULL::int AS z, 1.50::numeric(4,2) AS d FROM generate_series(1, 2500) g")
            .await
            .unwrap(),
    );
    let shape: Vec<(&str, &str, bool)> = cols
        .iter()
        .map(|c| (c.name.as_str(), c.type_name.as_str(), c.numeric))
        .collect();
    assert_eq!(
        shape,
        vec![
            ("n", "int4", true),
            ("s", "text", false),
            ("z", "int4", true),
            ("d", "numeric", true)
        ]
    );
    assert_eq!((first.len(), more), (1000, true));
    assert!(matches!(first[0][0], Cell::Number { .. }));
    assert_eq!(text(&first[0][0]), "1");
    assert!(matches!(first[0][1], Cell::Text { .. }));
    assert_eq!(first[0][2], Cell::Null);
    assert_eq!(text(&first[0][3]), "1.50");
    let second = s.fetch_more().await.unwrap();
    assert_eq!((second.rows.len(), second.has_more), (1000, true));
    assert_eq!(text(&second.rows[0][0]), "1001");
    let third = s.fetch_more().await.unwrap();
    assert_eq!((third.rows.len(), third.has_more), (500, false));
    s.close().await.unwrap();
    db.drop_db().await;
}

#[tokio::test]
async fn pg_affected_rows() {
    let (db, d) = fixture().await;
    let s = d.open_query_session(Some(&db.name)).await.unwrap();
    s.execute("CREATE TABLE t (id int)").await.unwrap();
    assert_eq!(
        s.execute("INSERT INTO t VALUES (1), (2), (3)")
            .await
            .unwrap(),
        ExecOutcome::Affected { rows: 3 }
    );
    assert_eq!(
        s.execute("UPDATE t SET id = id + 10 WHERE id < 3")
            .await
            .unwrap(),
        ExecOutcome::Affected { rows: 2 }
    );
    s.close().await.unwrap();
    db.drop_db().await;
}

#[tokio::test]
async fn pg_cancel_returns_cancelled() {
    let (db, d) = fixture().await;
    let s = Arc::new(d.open_query_session(Some(&db.name)).await.unwrap());
    let runner = s.clone();
    let started = Instant::now();
    let run = tokio::spawn(async move { runner.execute("SELECT pg_sleep(30)").await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    s.cancel().await.unwrap();
    let err = run.await.unwrap().unwrap_err();
    assert!(matches!(err, Error::Cancelled), "{err:?}");
    assert!(started.elapsed() < Duration::from_secs(2));
    rows(s.execute("SELECT 1").await.unwrap());
    s.close().await.unwrap();
    db.drop_db().await;
}

#[tokio::test]
async fn execute_after_open_result_abandons_it_quickly() {
    let (db, d) = fixture().await;
    let s = d.open_query_session(Some(&db.name)).await.unwrap();
    let (_, _, more) = rows(
        s.execute("SELECT g FROM generate_series(1, 5000000) g")
            .await
            .unwrap(),
    );
    assert!(more);
    let start = Instant::now();
    rows(s.execute("SELECT 1").await.unwrap());
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "{:?}",
        start.elapsed()
    );
    s.close().await.unwrap();
    db.drop_db().await;
}

#[tokio::test]
async fn closing_session_rolls_back_open_transaction() {
    let (db, d) = fixture().await;
    let s = d.open_query_session(Some(&db.name)).await.unwrap();
    s.execute("BEGIN").await.unwrap();
    s.execute("CREATE TABLE t (id int)").await.unwrap();
    s.execute("INSERT INTO t VALUES (1)").await.unwrap();
    s.close().await.unwrap();
    let again = d.open_query_session(Some(&db.name)).await.unwrap();
    let (_, r, _) = rows(
        again
            .execute("SELECT to_regclass('t') IS NULL AS gone")
            .await
            .unwrap(),
    );
    assert_eq!(text(&r[0][0]), "t");
    again.close().await.unwrap();
    db.drop_db().await;
}

#[tokio::test]
async fn results_preview_large_and_binary_values() {
    let (db, d) = fixture().await;
    let s = d.open_query_session(Some(&db.name)).await.unwrap();
    let (_, r, _) = rows(
        s.execute("SELECT repeat('x', 5000000), '\\xdeadbeef'::bytea")
            .await
            .unwrap(),
    );
    match &r[0][0] {
        Cell::Text {
            value,
            truncated,
            total_bytes,
        } => {
            assert!(*truncated);
            assert_eq!(*total_bytes, 5_000_000);
            assert_eq!(value.chars().count(), PREVIEW_CHARS);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        r[0][1],
        Cell::Bytes {
            preview_hex: "deadbeef".into(),
            truncated: false,
            total_bytes: 4
        }
    );
    s.close().await.unwrap();
    db.drop_db().await;
}

#[tokio::test]
async fn pg_syntax_error_has_message_and_position() {
    let (db, d) = fixture().await;
    let s = d.open_query_session(Some(&db.name)).await.unwrap();
    let err = s.execute("SELEC 1").await.unwrap_err();
    match &err {
        Error::Query(m) => {
            assert!(m.contains("syntax error at or near \"SELEC\""), "{m}");
            assert!(m.contains("(position 1)"), "{m}");
        }
        other => panic!("{other:?}"),
    }
    s.close().await.unwrap();
    db.drop_db().await;
}

#[tokio::test]
async fn abandoning_a_finished_result_never_cancels_the_next_statement() {
    let (db, d) = fixture().await;
    let s = d.open_query_session(Some(&db.name)).await.unwrap();
    for _ in 0..5 {
        // 1,500 small rows: the server has sent them all before the abandon.
        let (_, _, more) = rows(
            s.execute("SELECT g FROM generate_series(1, 1500) g")
                .await
                .unwrap(),
        );
        assert!(more);
        rows(s.execute("SELECT pg_sleep(0.3)").await.unwrap());
    }
    s.close().await.unwrap();
    db.drop_db().await;
}

#[tokio::test]
async fn several_statements_in_one_run_keep_a_typed_transaction() {
    let (db, d) = fixture().await;
    let s = d.open_query_session(Some(&db.name)).await.unwrap();
    s.execute("BEGIN").await.unwrap();
    s.execute("SELECT 1; SELECT 2").await.unwrap();
    s.execute("CREATE TABLE kept (id int)").await.unwrap();
    s.execute("COMMIT").await.unwrap();
    let (_, r, _) = rows(
        s.execute("SELECT to_regclass('kept') IS NOT NULL")
            .await
            .unwrap(),
    );
    assert_eq!(text(&r[0][0]), "t");
    s.close().await.unwrap();
    db.drop_db().await;
}
