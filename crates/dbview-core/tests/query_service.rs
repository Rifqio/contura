use std::sync::Arc;
use std::time::{Duration, Instant};

use dbview_core::Error;
use dbview_core::connections::{ConnectionInput, ConnectionService, PasswordChange};
use dbview_core::model::{ConnectionId, DialectKind, SslMode};
use dbview_core::query::{ExecOutcome, HistoryFilter, Outcome, SavedQueryInput};
use dbview_core::secrets::MemorySecretStore;
use dbview_core::store::AppStore;

const LONG: &str = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000000000) SELECT count(*) FROM n";

struct Fixture {
    _dir: tempfile::TempDir,
    svc: Arc<ConnectionService>,
    id: ConnectionId,
}

async fn fixture(timeout: Option<u32>) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("shop.db");
    rusqlite::Connection::open(&file)
        .unwrap()
        .execute_batch("CREATE TABLE t(a INTEGER); INSERT INTO t VALUES (1), (2);")
        .unwrap();
    let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
    let svc = Arc::new(ConnectionService::new(
        store,
        Arc::new(MemorySecretStore::new()),
    ));
    let saved = svc
        .save(ConnectionInput {
            id: None,
            name: "shop".into(),
            dialect: DialectKind::Sqlite,
            host: String::new(),
            port: 0,
            user: String::new(),
            database: None,
            ssl: SslMode::Disable,
            password: PasswordChange::Keep,
            group_id: None,
            file: Some(file),
            query_timeout_secs: timeout,
        })
        .await
        .unwrap();
    svc.open(saved.id).await.unwrap();
    Fixture {
        _dir: dir,
        svc,
        id: saved.id,
    }
}

fn all() -> HistoryFilter {
    HistoryFilter {
        search: None,
        only: None,
    }
}

#[tokio::test]
async fn execute_records_history_for_every_outcome() {
    let f = fixture(None).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    let ok = f.svc.execute_sql(s, "SELECT 1".into()).await.unwrap();
    assert!(matches!(ok.outcome, ExecOutcome::Rows { .. }));
    f.svc
        .execute_sql(s, "UPDATE t SET a = 3".into())
        .await
        .unwrap();
    f.svc
        .execute_sql(s, "SELECT * FROM missing".into())
        .await
        .unwrap_err();
    let svc = f.svc.clone();
    let run = tokio::spawn(async move { svc.execute_sql(s, LONG.into()).await });
    tokio::time::sleep(Duration::from_millis(200)).await;
    f.svc.cancel_query(s).await.unwrap();
    assert!(matches!(run.await.unwrap(), Err(Error::Cancelled)));

    let h = f.svc.query_history(f.id, all()).unwrap();
    let shape: Vec<(Outcome, bool, Option<u64>)> =
        h.iter().map(|e| (e.outcome, e.changed, e.rows)).collect();
    assert_eq!(
        shape,
        vec![
            (Outcome::Cancelled, false, None),
            (Outcome::Error, false, None),
            (Outcome::Ok, true, Some(2)),
            (Outcome::Ok, false, Some(1)),
        ]
    );
    assert!(
        h[1].error
            .as_deref()
            .unwrap()
            .contains("no such table: missing")
    );
    assert_eq!(h[3].sql, "SELECT 1");
}

#[tokio::test]
async fn timeout_cancels_and_reports_timed_out() {
    let f = fixture(Some(1)).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    let start = Instant::now();
    let err = f.svc.execute_sql(s, LONG.into()).await.unwrap_err();
    assert!(matches!(err, Error::TimedOut(1)), "{err:?}");
    assert!(start.elapsed() < Duration::from_secs(3));
    let h = f.svc.query_history(f.id, all()).unwrap();
    assert_eq!(h[0].outcome, Outcome::TimedOut);
}

#[tokio::test]
async fn closing_connection_closes_its_query_sessions() {
    let f = fixture(None).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    f.svc.close(f.id).await.unwrap();
    let err = f.svc.execute_sql(s, "SELECT 1".into()).await.unwrap_err();
    assert!(
        matches!(&err, Error::NotFound(m) if m == "That query session is closed."),
        "{err:?}"
    );
}

#[tokio::test]
async fn fetch_more_and_close_result_go_through_the_registry() {
    let f = fixture(None).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    let first = f
        .svc
        .execute_sql(
            s,
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500) SELECT i FROM n"
                .into(),
        )
        .await
        .unwrap();
    assert!(matches!(
        first.outcome,
        ExecOutcome::Rows { has_more: true, .. }
    ));
    assert_eq!(f.svc.fetch_more_rows(s).await.unwrap().rows.len(), 500);
    f.svc.close_query_session(s).await.unwrap();
    assert!(f.svc.fetch_more_rows(s).await.is_err());
}

#[tokio::test]
async fn saved_query_names_are_unique_ignoring_case() {
    let f = fixture(None).await;
    let q = f
        .svc
        .save_saved_query(SavedQueryInput {
            id: None,
            name: "Weekly sales".into(),
            sql: "SELECT 1".into(),
        })
        .unwrap();
    let err = f
        .svc
        .save_saved_query(SavedQueryInput {
            id: None,
            name: "weekly SALES".into(),
            sql: "SELECT 2".into(),
        })
        .unwrap_err();
    assert!(
        matches!(&err, Error::InvalidInput(m) if m == "A Saved Query named \"weekly SALES\" exists. Choose another name."),
        "{err:?}"
    );
    let again = f
        .svc
        .save_saved_query(SavedQueryInput {
            id: Some(q.id),
            name: "Weekly sales".into(),
            sql: "SELECT 3".into(),
        })
        .unwrap();
    assert_eq!(again.id, q.id);
    let empty = f.svc.save_saved_query(SavedQueryInput {
        id: None,
        name: "  ".into(),
        sql: String::new(),
    });
    assert!(matches!(empty, Err(Error::InvalidInput(m)) if m == "Give the query a name."));
    let list = f.svc.list_saved_queries().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].sql, "SELECT 3");
    f.svc.delete_saved_query(q.id).unwrap();
    assert!(f.svc.list_saved_queries().unwrap().is_empty());
}

#[tokio::test]
async fn deleting_a_connection_deletes_its_history() {
    let f = fixture(None).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    f.svc.execute_sql(s, "SELECT 1".into()).await.unwrap();
    f.svc.delete(f.id).await.unwrap();
    assert!(f.svc.query_history(f.id, all()).unwrap().is_empty());
}

#[tokio::test]
async fn query_tabs_round_trip_per_place() {
    let f = fixture(None).await;
    f.svc
        .save_query_tabs("group:abc".into(), "[{\"id\":\"1\"}]".into())
        .unwrap();
    assert_eq!(
        f.svc
            .load_query_tabs("group:abc".into())
            .unwrap()
            .as_deref(),
        Some("[{\"id\":\"1\"}]")
    );
    assert_eq!(f.svc.load_query_tabs("ungrouped".into()).unwrap(), None);
}

#[tokio::test]
async fn closing_a_connection_with_a_running_query_is_quick() {
    let f = fixture(None).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    let svc = f.svc.clone();
    let run = tokio::spawn(async move { svc.execute_sql(s, LONG.into()).await });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let start = Instant::now();
    f.svc.close(f.id).await.unwrap();
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "{:?}",
        start.elapsed()
    );
    assert!(run.await.unwrap().is_err());
}

#[tokio::test]
async fn cancel_all_stops_every_running_query() {
    let f = fixture(None).await;
    let a = f.svc.open_query_session(f.id, None).await.unwrap();
    let svc = f.svc.clone();
    let run = tokio::spawn(async move { svc.execute_sql(a, LONG.into()).await });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let start = Instant::now();
    f.svc.cancel_all_queries().await;
    assert!(matches!(run.await.unwrap(), Err(Error::Cancelled)));
    assert!(start.elapsed() < Duration::from_secs(2));
}
