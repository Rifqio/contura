mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use contura_core::Error;
use contura_core::ai::AiAccess;
use contura_core::connections::{ConnectionInput, ConnectionService, PasswordChange};
use contura_core::model::{ConnectionConfig, ConnectionId, DialectKind, SslMode};
use contura_core::query::{ExecOutcome, HistoryFilter, Outcome, SavedQueryInput};
use contura_core::secrets::MemorySecretStore;
use contura_core::store::AppStore;

const LONG: &str = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000000000) SELECT count(*) FROM n";

struct Fixture {
    _dir: tempfile::TempDir,
    svc: Arc<ConnectionService>,
    id: ConnectionId,
}

async fn fixture(timeout: Option<u32>) -> Fixture {
    fixture_with(timeout, false, false).await
}

async fn fixture_with(timeout: Option<u32>, production: bool, read_only: bool) -> Fixture {
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
            ai_access: Default::default(),
            production,
            read_only,
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
    let ok = f.svc.execute_sql(s, "SELECT 1".into(), None).await.unwrap();
    assert!(matches!(ok.outcome, ExecOutcome::Rows { .. }));
    f.svc
        .execute_sql(s, "UPDATE t SET a = 3".into(), None)
        .await
        .unwrap();
    f.svc
        .execute_sql(s, "SELECT * FROM missing".into(), None)
        .await
        .unwrap_err();
    let svc = f.svc.clone();
    let run = tokio::spawn(async move { svc.execute_sql(s, LONG.into(), None).await });
    tokio::time::sleep(Duration::from_millis(200)).await;
    f.svc.cancel_query(s).await.unwrap();
    assert!(matches!(run.await.unwrap(), Err(Error::Cancelled)));

    let h = f.svc.query_history(Some(f.id), all()).unwrap();
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
    let err = f.svc.execute_sql(s, LONG.into(), None).await.unwrap_err();
    assert!(matches!(err, Error::TimedOut(1)), "{err:?}");
    assert!(start.elapsed() < Duration::from_secs(3));
    let h = f.svc.query_history(Some(f.id), all()).unwrap();
    assert_eq!(h[0].outcome, Outcome::TimedOut);
}

#[tokio::test]
async fn closing_connection_closes_its_query_sessions() {
    let f = fixture(None).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    f.svc.close(f.id).await.unwrap();
    let err = f
        .svc
        .execute_sql(s, "SELECT 1".into(), None)
        .await
        .unwrap_err();
    assert!(
        matches!(&err, Error::NotFound(m) if m == "That query session is closed."),
        "{err:?}"
    );
}

#[tokio::test]
async fn changing_ai_access_keeps_sessions_and_changes_only_that_field() {
    let f = fixture(None).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    let before = f.svc.list().unwrap().remove(0);
    let saved = f.svc.set_ai_access(f.id, AiAccess::Never).await.unwrap();
    assert_eq!(
        saved,
        ConnectionConfig {
            ai_access: AiAccess::Never,
            ..before
        }
    );
    assert_eq!(f.svc.list().unwrap(), vec![saved]);
    assert!(f.svc.is_open(f.id));
    f.svc.execute_sql(s, "SELECT 1".into(), None).await.unwrap();
}

#[tokio::test]
async fn changing_ai_access_of_a_missing_connection_is_not_found() {
    let f = fixture(None).await;
    let err = f
        .svc
        .set_ai_access(uuid::Uuid::new_v4(), AiAccess::Never)
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NotFound(_)), "{err:?}");
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
            None,
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
            connection_id: None,
        })
        .unwrap();
    let err = f
        .svc
        .save_saved_query(SavedQueryInput {
            id: None,
            name: "weekly SALES".into(),
            sql: "SELECT 2".into(),
            connection_id: None,
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
            connection_id: None,
        })
        .unwrap();
    assert_eq!(again.id, q.id);
    let empty = f.svc.save_saved_query(SavedQueryInput {
        id: None,
        name: "  ".into(),
        sql: String::new(),
        connection_id: None,
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
    f.svc.execute_sql(s, "SELECT 1".into(), None).await.unwrap();
    f.svc.delete(f.id).await.unwrap();
    assert!(f.svc.query_history(Some(f.id), all()).unwrap().is_empty());
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
    let run = tokio::spawn(async move { svc.execute_sql(s, LONG.into(), None).await });
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
    let run = tokio::spawn(async move { svc.execute_sql(a, LONG.into(), None).await });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let start = Instant::now();
    f.svc.cancel_all_queries().await;
    assert!(matches!(run.await.unwrap(), Err(Error::Cancelled)));
    assert!(start.elapsed() < Duration::from_secs(2));
}

fn count_rows(f: &Fixture) -> i64 {
    rusqlite::Connection::open(f._dir.path().join("shop.db"))
        .unwrap()
        .query_row("SELECT count(*) FROM t WHERE a < 100", [], |r| r.get(0))
        .unwrap()
}

fn a_value(f: &Fixture) -> Vec<i64> {
    let c = rusqlite::Connection::open(f._dir.path().join("shop.db")).unwrap();
    let mut st = c.prepare("SELECT a FROM t ORDER BY a").unwrap();
    st.query_map([], |r| r.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
}

const DELETE_ALL: &str = "DELETE FROM t";

#[tokio::test]
async fn production_write_without_pass_is_refused_and_not_run() {
    let f = fixture_with(None, true, false).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    let err = f
        .svc
        .execute_sql(s, DELETE_ALL.into(), None)
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NeedsConfirmation), "{err:?}");
    assert_eq!(count_rows(&f), 2);
    assert!(f.svc.query_history(Some(f.id), all()).unwrap().is_empty());
}

#[tokio::test]
async fn production_write_with_pass_runs_once() {
    let f = fixture_with(None, true, false).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    let pass = f.svc.confirm_run(s, vec![DELETE_ALL.into()]).unwrap();
    f.svc
        .execute_sql(s, DELETE_ALL.into(), Some(pass))
        .await
        .unwrap();
    assert_eq!(count_rows(&f), 0);
    let err = f
        .svc
        .execute_sql(s, DELETE_ALL.into(), Some(pass))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NeedsConfirmation), "{err:?}");
}

#[tokio::test]
async fn pass_covers_every_write_of_a_script_once_each() {
    let f = fixture_with(None, true, false).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    let script = vec![
        "UPDATE t SET a = 5 WHERE a = 1".to_string(),
        "SELECT 1".to_string(),
        "UPDATE t SET a = 6 WHERE a = 2".to_string(),
    ];
    let pass = f.svc.confirm_run(s, script.clone()).unwrap();
    for sql in script {
        f.svc.execute_sql(s, sql, Some(pass)).await.unwrap();
    }
    assert_eq!(a_value(&f), vec![5, 6]);
}

#[tokio::test]
async fn pass_does_not_cover_changed_text() {
    let f = fixture_with(None, true, false).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    let pass = f
        .svc
        .confirm_run(s, vec!["UPDATE t SET a = 1".into()])
        .unwrap();
    let err = f
        .svc
        .execute_sql(s, "UPDATE t SET a = 2".into(), Some(pass))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NeedsConfirmation), "{err:?}");
    assert_eq!(a_value(&f), vec![1, 2]);
}

#[tokio::test]
async fn pass_is_bound_to_its_session() {
    let f = fixture_with(None, true, false).await;
    let a = f.svc.open_query_session(f.id, None).await.unwrap();
    let b = f.svc.open_query_session(f.id, None).await.unwrap();
    let pass = f.svc.confirm_run(a, vec![DELETE_ALL.into()]).unwrap();
    let err = f
        .svc
        .execute_sql(b, DELETE_ALL.into(), Some(pass))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NeedsConfirmation), "{err:?}");
    assert_eq!(count_rows(&f), 2);
}

#[tokio::test]
async fn expired_pass_is_refused() {
    let f = fixture_with(None, true, false).await;
    f.svc.set_pass_ttl_for_test(Duration::from_secs(0));
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    let pass = f.svc.confirm_run(s, vec![DELETE_ALL.into()]).unwrap();
    let err = f
        .svc
        .execute_sql(s, DELETE_ALL.into(), Some(pass))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NeedsConfirmation), "{err:?}");
    assert_eq!(count_rows(&f), 2);
}

#[tokio::test]
async fn a_new_run_ends_the_sessions_partly_used_pass() {
    let f = fixture_with(None, true, false).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    let first = "UPDATE t SET a = 5 WHERE a = 1".to_string();
    let second = "UPDATE t SET a = 6 WHERE a = 2".to_string();
    let pass = f
        .svc
        .confirm_run(s, vec![first.clone(), second.clone()])
        .unwrap();
    f.svc.execute_sql(s, first, Some(pass)).await.unwrap();
    f.svc.prepare_run(s, vec!["SELECT 1".into()]).unwrap();
    let err = f
        .svc
        .execute_sql(s, second.clone(), Some(pass))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NeedsConfirmation), "{err:?}");

    let again = f.svc.confirm_run(s, vec![second.clone()]).unwrap();
    f.svc.confirm_run(s, vec![DELETE_ALL.into()]).unwrap();
    let err = f.svc.execute_sql(s, second, Some(again)).await.unwrap_err();
    assert!(matches!(err, Error::NeedsConfirmation), "{err:?}");
    assert_eq!(a_value(&f), vec![2, 5]);
}

#[tokio::test]
async fn query_session_opened_during_a_save_is_discarded() {
    let f = fixture(None).await;
    let err = f
        .svc
        .open_query_session_with_hook(f.id, None, resave(&f, true, false))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NotFound(_)), "{err:?}");
}

#[tokio::test]
async fn read_only_write_is_refused_before_the_server() {
    let f = fixture_with(None, false, true).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    let err = f
        .svc
        .execute_sql(s, DELETE_ALL.into(), None)
        .await
        .unwrap_err();
    assert!(matches!(err, Error::ReadOnly(0)), "{err:?}");
    assert_eq!(count_rows(&f), 2);
    assert!(f.svc.query_history(Some(f.id), all()).unwrap().is_empty());
}

#[tokio::test]
async fn reads_run_on_production_without_a_pass() {
    let f = fixture_with(None, true, false).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    f.svc
        .execute_sql(s, "SELECT * FROM t".into(), None)
        .await
        .unwrap();
}

#[tokio::test]
async fn prepare_run_reports_the_verdict_for_the_session() {
    use contura_core::safety::RunVerdict;
    let f = fixture_with(None, true, false).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    let v = f
        .svc
        .prepare_run(s, vec!["SELECT 1".into(), DELETE_ALL.into()])
        .unwrap();
    assert!(
        matches!(v, RunVerdict::NeedsConfirmation { writes: 1, .. }),
        "{v:?}"
    );
}

async fn resave(f: &Fixture, production: bool, read_only: bool) {
    let file = f._dir.path().join("shop.db");
    f.svc
        .save(ConnectionInput {
            id: Some(f.id),
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
            query_timeout_secs: None,
            ai_access: Default::default(),
            production,
            read_only,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn toggling_read_only_reopens_sessions_read_only() {
    let f = fixture(None).await;
    let old = f.svc.open_query_session(f.id, None).await.unwrap();
    f.svc
        .execute_sql(old, "INSERT INTO t VALUES (3)".into(), None)
        .await
        .unwrap();
    resave(&f, false, true).await;
    let err = f
        .svc
        .execute_sql(old, "SELECT 1".into(), None)
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NotFound(_)), "{err:?}");
    f.svc.open(f.id).await.unwrap();
    let fresh = f.svc.open_query_session(f.id, None).await.unwrap();
    f.svc
        .execute_sql(fresh, "SELECT * FROM t".into(), None)
        .await
        .unwrap();
    let err = f
        .svc
        .execute_sql(fresh, "INSERT INTO t VALUES (4)".into(), None)
        .await
        .unwrap_err();
    assert!(matches!(err, Error::ReadOnly(0)), "{err:?}");
    assert_eq!(count_rows(&f), 3);
}

#[tokio::test]
async fn prepare_run_dialog_falls_back_to_the_configured_database() {
    use contura_core::safety::RunVerdict;
    // SQLite has no configured database name, so this one runs against MySQL.
    let db = common::TestDb::create().await;
    let dir = tempfile::tempdir().unwrap();
    let svc = ConnectionService::new(
        AppStore::open(&dir.path().join("app.sqlite")).unwrap(),
        Arc::new(MemorySecretStore::new()),
    );
    let saved = svc
        .save(ConnectionInput {
            id: None,
            name: "m".into(),
            dialect: DialectKind::MySql,
            host: db.config.host.clone(),
            port: db.config.port,
            user: db.config.user.clone(),
            database: db.config.database.clone(),
            ssl: SslMode::Disable,
            password: PasswordChange::Set {
                value: db.password.clone().unwrap(),
            },
            group_id: None,
            file: None,
            query_timeout_secs: None,
            ai_access: Default::default(),
            production: true,
            read_only: false,
        })
        .await
        .unwrap();
    svc.open(saved.id).await.unwrap();
    let s = svc.open_query_session(saved.id, None).await.unwrap();
    let v = svc.prepare_run(s, vec!["DELETE FROM t".into()]).unwrap();
    match v {
        RunVerdict::NeedsConfirmation { database, .. } => {
            assert_eq!(database.as_deref(), Some(db.name.as_str()));
        }
        other => panic!("{other:?}"),
    }
    svc.close(saved.id).await.unwrap();
    db.drop_db().await;
}

const DAY_MS: i64 = 86_400_000;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn app_db(f: &Fixture) -> rusqlite::Connection {
    rusqlite::Connection::open(f._dir.path().join("app.sqlite")).unwrap()
}

fn seed(db: &rusqlite::Connection, conn: ConnectionId, sql: &str, ran_at_ms: i64) {
    db.execute(
        "INSERT INTO query_history
           (connection_id, sql, ran_at_ms, elapsed_ms, outcome, rows, changed, error)
         VALUES (?1, ?2, ?3, 1, 'ok', NULL, 0, NULL)",
        rusqlite::params![conn.to_string(), sql, ran_at_ms],
    )
    .unwrap();
}

fn keep(days: Option<u32>) -> contura_core::model::UiPrefs {
    contura_core::model::UiPrefs {
        history_keep_days: days,
        ..Default::default()
    }
}

fn sqls(f: &Fixture) -> Vec<String> {
    f.svc
        .query_history(Some(f.id), all())
        .unwrap()
        .into_iter()
        .map(|e| e.sql)
        .collect()
}

#[tokio::test]
async fn history_older_than_keep_days_is_pruned_when_a_row_is_added() {
    let f = fixture(None).await;
    f.svc.save_ui_prefs(keep(Some(30))).unwrap();
    let db = app_db(&f);
    seed(&db, f.id, "old 1", now_ms() - 40 * DAY_MS);
    seed(&db, f.id, "old 2", now_ms() - 41 * DAY_MS);
    seed(&db, f.id, "recent", now_ms() - 2 * DAY_MS);
    assert_eq!(sqls(&f).len(), 3);
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    f.svc.execute_sql(s, "SELECT 1".into(), None).await.unwrap();
    assert_eq!(sqls(&f), vec!["SELECT 1", "recent"]);
}

#[tokio::test]
async fn history_is_pruned_when_the_service_starts() {
    let f = fixture(None).await;
    f.svc.save_ui_prefs(keep(Some(30))).unwrap();
    let db = app_db(&f);
    seed(&db, f.id, "old", now_ms() - 40 * DAY_MS);
    seed(&db, f.id, "recent", now_ms() - DAY_MS);
    let svc = ConnectionService::new(
        AppStore::open(&f._dir.path().join("app.sqlite")).unwrap(),
        Arc::new(MemorySecretStore::new()),
    );
    let left: Vec<String> = svc
        .query_history(Some(f.id), all())
        .unwrap()
        .into_iter()
        .map(|e| e.sql)
        .collect();
    assert_eq!(left, vec!["recent"]);
}

#[tokio::test]
async fn changing_the_keep_days_prunes_at_once() {
    let f = fixture(None).await;
    let db = app_db(&f);
    seed(&db, f.id, "old", now_ms() - 40 * DAY_MS);
    seed(&db, f.id, "recent", now_ms() - DAY_MS);
    f.svc.save_ui_prefs(keep(None)).unwrap();
    assert_eq!(sqls(&f).len(), 2);
    f.svc.save_ui_prefs(keep(Some(30))).unwrap();
    assert_eq!(sqls(&f), vec!["recent"]);
}

#[tokio::test]
async fn keep_days_of_zero_keeps_the_last_day() {
    let f = fixture(None).await;
    let db = app_db(&f);
    seed(&db, f.id, "old", now_ms() - 2 * DAY_MS);
    seed(&db, f.id, "an hour ago", now_ms() - DAY_MS / 24);
    f.svc.save_ui_prefs(keep(Some(0))).unwrap();
    assert_eq!(sqls(&f), vec!["an hour ago"]);
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    f.svc.execute_sql(s, "SELECT 1".into(), None).await.unwrap();
    assert_eq!(sqls(&f), vec!["SELECT 1", "an hour ago"]);
}

#[tokio::test]
async fn forever_keeps_old_rows_and_the_1000_cap_still_holds() {
    let f = fixture(None).await;
    f.svc.save_ui_prefs(keep(None)).unwrap();
    seed(&app_db(&f), f.id, "ancient", now_ms() - 400 * DAY_MS);
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    for _ in 0..5 {
        f.svc.execute_sql(s, "SELECT 1".into(), None).await.unwrap();
    }
    assert!(sqls(&f).contains(&"ancient".to_string()));
    for _ in 0..1000 {
        f.svc.execute_sql(s, "SELECT 1".into(), None).await.unwrap();
    }
    let left = sqls(&f);
    assert_eq!(left.len(), 1000);
    assert!(!left.contains(&"ancient".to_string()));
}

#[tokio::test]
async fn clear_history_for_all_connections() {
    let f = fixture(None).await;
    let other = uuid::Uuid::new_v4();
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    f.svc.execute_sql(s, "SELECT 1".into(), None).await.unwrap();
    seed(&app_db(&f), other, "other", now_ms());
    f.svc.clear_query_history(None).unwrap();
    assert!(f.svc.query_history(Some(f.id), all()).unwrap().is_empty());
    assert!(f.svc.query_history(Some(other), all()).unwrap().is_empty());
    assert!(f.svc.query_history(None, all()).unwrap().is_empty());
}

#[tokio::test]
async fn query_history_without_a_connection_lists_every_connection_newest_first() {
    let f = fixture(None).await;
    let other = uuid::Uuid::new_v4();
    seed(&app_db(&f), other, "first", now_ms() - 1000);
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    f.svc.execute_sql(s, "SELECT 1".into(), None).await.unwrap();
    seed(&app_db(&f), other, "last", now_ms());
    let all_rows = f.svc.query_history(None, all()).unwrap();
    let shape: Vec<(String, ConnectionId)> = all_rows
        .into_iter()
        .map(|e| (e.sql, e.connection_id))
        .collect();
    assert_eq!(
        shape,
        vec![
            ("last".to_string(), other),
            ("SELECT 1".to_string(), f.id),
            ("first".to_string(), other)
        ]
    );
}
