mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::TestDb;
use contura_core::dialect::{Dialect, connect};
use contura_core::error::Error;
use contura_core::model::{Cell, PREVIEW_CHARS};
use contura_core::query::{ExecOutcome, ResultColumn, SessionHandle};

async fn fixture() -> (TestDb, Arc<dyn Dialect>, SessionHandle) {
    let db = TestDb::create().await;
    let dialect = connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    let s = dialect.open_query_session(Some(&db.name)).await.unwrap();
    // The default depth of 1,000 is too shallow for the row counts below.
    s.execute("SET SESSION cte_max_recursion_depth = 10000")
        .await
        .unwrap();
    (db, dialect, s)
}

const N2500: &str =
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2500)";

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
async fn my_rows_page_and_types() {
    let (db, _d, s) = fixture().await;
    let sql = format!(
        "{N2500} SELECT CAST(i AS SIGNED) AS n, CAST(i AS CHAR) AS s, CAST(1.50 AS DECIMAL(4,2)) AS d, NULL AS z FROM n"
    );
    let (cols, first, more) = rows(s.execute(&sql).await.unwrap());
    let shape: Vec<(&str, &str, bool)> = cols
        .iter()
        .map(|c| (c.name.as_str(), c.type_name.as_str(), c.numeric))
        .collect();
    assert_eq!(shape[0], ("n", "bigint", true));
    assert_eq!(shape[1], ("s", "varchar", false));
    assert_eq!(shape[2], ("d", "decimal", true));
    assert_eq!((first.len(), more), (1000, true));
    assert!(matches!(first[0][0], Cell::Number { .. }));
    assert_eq!(text(&first[0][0]), "1");
    assert_eq!(text(&first[0][2]), "1.50");
    assert_eq!(first[0][3], Cell::Null);
    let second = s.fetch_more().await.unwrap();
    assert_eq!((second.rows.len(), second.has_more), (1000, true));
    assert_eq!(text(&second.rows[0][0]), "1001");
    let third = s.fetch_more().await.unwrap();
    assert_eq!((third.rows.len(), third.has_more), (500, false));
    s.close().await.unwrap();
    db.drop_db().await;
}

#[tokio::test]
async fn my_affected_rows() {
    let (db, _d, s) = fixture().await;
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
async fn my_cancel_returns_cancelled() {
    let (db, _d, s) = fixture().await;
    let s = Arc::new(s);
    let runner = s.clone();
    let started = Instant::now();
    let run = tokio::spawn(async move {
        runner
            .execute("SELECT BENCHMARK(10000000000, MD5('x'))")
            .await
    });
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
async fn my_execute_after_open_result_abandons_it_quickly() {
    let (db, _d, s) = fixture().await;
    let sql = format!(
        "{N2500}, m(j) AS (SELECT 1 UNION ALL SELECT j + 1 FROM m WHERE j < 2000) SELECT n.i FROM n CROSS JOIN m"
    );
    let (_, _, more) = rows(s.execute(&sql).await.unwrap());
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
async fn my_use_database_applies() {
    let (db, _d, s) = fixture().await;
    let (_, r, _) = rows(s.execute("SELECT DATABASE()").await.unwrap());
    assert_eq!(text(&r[0][0]), db.name);
    s.close().await.unwrap();
    db.drop_db().await;
}

#[tokio::test]
async fn results_preview_large_and_binary_values() {
    let (db, _d, s) = fixture().await;
    let (_, r, _) = rows(
        s.execute("SELECT REPEAT('x', 5000000), 0xDEADBEEF, CAST(0xFF AS BINARY)")
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
    assert_eq!(
        r[0][2],
        Cell::Bytes {
            preview_hex: "ff".into(),
            truncated: false,
            total_bytes: 1
        }
    );
    s.close().await.unwrap();
    db.drop_db().await;
}

async fn ro_fixture(read_only: bool) -> (TestDb, Arc<dyn Dialect>, SessionHandle) {
    let db = TestDb::create().await;
    let plain = connect(&db.config, db.password.as_deref()).await.unwrap();
    let s = plain.open_query_session(Some(&db.name)).await.unwrap();
    s.execute("CREATE TABLE t (a INT)").await.unwrap();
    s.close().await.unwrap();
    let mut config = db.config.clone();
    config.read_only = read_only;
    let dialect = connect(&config, db.password.as_deref()).await.unwrap();
    let s = dialect.open_query_session(Some(&db.name)).await.unwrap();
    (db, dialect, s)
}

#[tokio::test]
async fn read_only_session_refuses_insert_at_the_server() {
    let (db, _d, s) = ro_fixture(true).await;
    let err = s.execute("INSERT INTO t VALUES (1)").await.unwrap_err();
    assert!(matches!(err, Error::ReadOnlyRefused), "{err:?}");
    s.execute("SELECT * FROM t").await.unwrap();
    db.drop_db().await;
}

#[tokio::test]
async fn read_only_session_is_read_only_at_open() {
    let (db, _d, s) = ro_fixture(true).await;
    let (_, r, _) = rows(s.execute("SELECT @@transaction_read_only").await.unwrap());
    assert_eq!(text(&r[0][0]), "1");
    db.drop_db().await;
}

#[tokio::test]
async fn read_only_browse_connection_refuses_writes() {
    use contura_core::model::{ObjectPath, PageRequest};
    let (db, _d, _s) = ro_fixture(true).await;
    // A function that writes, so a grid filter can try to write through the browse path.
    let plain = connect(&db.config, db.password.as_deref()).await.unwrap();
    let ps = plain.open_query_session(Some(&db.name)).await.unwrap();
    ps.execute("INSERT INTO t VALUES (1)").await.unwrap();
    ps.execute("CREATE TABLE lg (x INT)").await.unwrap();
    ps.execute(
        "CREATE FUNCTION bump() RETURNS INT NOT DETERMINISTIC MODIFIES SQL DATA \
         BEGIN INSERT INTO lg VALUES (1); RETURN 1; END",
    )
    .await
    .unwrap();
    let mut config = db.config.clone();
    config.read_only = true;
    let d = connect(&config, db.password.as_deref()).await.unwrap();
    let req = PageRequest {
        table: ObjectPath {
            database: db.name.clone(),
            schema: None,
            name: "t".into(),
        },
        page: 0,
        sort: None,
        filter: Some("bump() = 1".into()),
    };
    let err = d.fetch_page(&req).await.unwrap_err();
    assert!(matches!(err, Error::ReadOnlyRefused), "{err:?}");
    // The same filter on a plain Connection writes and succeeds.
    let plain_page = plain.fetch_page(&req).await.unwrap();
    assert_eq!(plain_page.rows.len(), 1);
    db.drop_db().await;
}

#[tokio::test]
async fn read_only_browse_connection_stays_read_only_after_reuse() {
    let (db, _d, _s) = ro_fixture(true).await;
    let mut config = db.config.clone();
    config.read_only = true;
    let d = contura_core::mysql::MySqlDialect::connect(&config, db.password.as_deref())
        .await
        .unwrap();
    for _ in 0..3 {
        let flag = d
            .browse_first_for_test("SELECT CAST(@@transaction_read_only AS CHAR)")
            .await
            .unwrap();
        assert_eq!(flag.as_deref(), Some("1"));
    }
    db.drop_db().await;
}
#[tokio::test]
async fn plain_connection_keeps_the_server_message_for_a_read_only_transaction() {
    let (db, _d, s) = ro_fixture(false).await;
    s.execute("START TRANSACTION READ ONLY").await.unwrap();
    let err = s.execute("INSERT INTO t VALUES (1)").await.unwrap_err();
    assert!(matches!(&err, Error::Query(_)), "{err:?}");
    db.drop_db().await;
}

#[tokio::test]
async fn plain_session_still_writes() {
    let (db, _d, s) = ro_fixture(false).await;
    s.execute("INSERT INTO t VALUES (1)").await.unwrap();
    db.drop_db().await;
}

/// N3: Run all stopped inside a framed script, before its footer: the tab's session gets
/// the mode the header kept back, once. A session the script never framed is left alone.
#[tokio::test]
async fn a_script_stopped_before_its_footer_gets_its_sql_mode_back() {
    let (db, _dialect, s) = fixture().await;
    s.execute("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES'")
        .await
        .unwrap();
    // Nothing framed yet: nothing to put back.
    assert!(!s.restore_script_sql_mode().await.unwrap());
    s.execute(contura_core::ddl::mysql_sql_mode_set(
        contura_core::ddl::SqlModeFrame::KeepSession,
    ))
    .await
    .unwrap();
    assert!(
        s.execute("ALTER TABLE nowhere ADD COLUMN x int")
            .await
            .is_err()
    );
    assert_eq!(mode(&s).await, "STRICT_TRANS_TABLES");
    assert!(s.restore_script_sql_mode().await.unwrap());
    assert_eq!(mode(&s).await, "NO_BACKSLASH_ESCAPES,STRICT_TRANS_TABLES");
    // Put back once: a later stop does not undo a change the user makes meanwhile.
    s.execute("SET SESSION sql_mode = 'ANSI_QUOTES'")
        .await
        .unwrap();
    assert!(!s.restore_script_sql_mode().await.unwrap());
    assert_eq!(mode(&s).await, "ANSI_QUOTES");
    db.drop_db().await;
}

async fn mode(s: &SessionHandle) -> String {
    let (_, r, _) = rows(s.execute("SELECT @@SESSION.sql_mode").await.unwrap());
    text(&r[0][0]).to_string()
}

/// A text the server answers with several results (a compound statement sent whole, a CALL,
/// or several statements): each is read before the run goes on, and the first error from
/// any of them is the statement's error, so Run all stops there.
#[tokio::test]
async fn my_several_results_surface_a_later_error() {
    let (db, _d, s) = fixture().await;
    assert!(
        s.execute("SELECT 1; DELETE FROM nope WHERE a = 1")
            .await
            .is_err()
    );
    assert!(
        s.execute("DO 1; DELETE FROM nope WHERE a = 1")
            .await
            .is_err()
    );
    s.execute("CREATE PROCEDURE p() BEGIN SELECT 1; DELETE FROM nope; END")
        .await
        .unwrap();
    assert!(s.execute("CALL p()").await.is_err());
    // The session goes on.
    let (_, r, _) = rows(s.execute("SELECT 2").await.unwrap());
    assert_eq!(text(&r[0][0]), "2");
    s.close().await.unwrap();
    db.drop_db().await;
}

/// Rows changed are summed over every result; a first result with rows is shown (at most
/// one page, with no more to fetch, when other results follow it), and every later part
/// has run when the outcome comes back.
#[tokio::test]
async fn my_several_results_run_every_part() {
    let (db, _d, s) = fixture().await;
    s.execute("CREATE TABLE t (id int)").await.unwrap();
    assert_eq!(
        s.execute("INSERT INTO t VALUES (1); INSERT INTO t VALUES (2), (3)")
            .await
            .unwrap(),
        ExecOutcome::Affected { rows: 3 }
    );
    let (_, r, more) = rows(
        s.execute("SELECT 1 AS a; INSERT INTO t VALUES (4)")
            .await
            .unwrap(),
    );
    assert_eq!((r.len(), more), (1, false));
    let big = format!("{N2500} SELECT i FROM n; INSERT INTO t VALUES (5)");
    let (_, r, more) = rows(s.execute(&big).await.unwrap());
    assert_eq!((r.len(), more), (1000, false));
    let (_, r, _) = rows(s.execute("SELECT COUNT(*) FROM t").await.unwrap());
    assert_eq!(text(&r[0][0]), "5");
    s.close().await.unwrap();
    db.drop_db().await;
}
