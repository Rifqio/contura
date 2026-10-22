mod common;

use std::sync::Arc;

use common::TestDb;
use common::pg::PgTestDb;
use contura_core::Error;
use contura_core::connections::{ConnectionInput, ConnectionService, PasswordChange};
use contura_core::model::{ConnectionId, DialectKind, SslMode};
use contura_core::query::{ExecOutcome, HistoryFilter, QuerySessionId};
use contura_core::secrets::MemorySecretStore;
use contura_core::store::AppStore;

struct Fixture {
    _dir: tempfile::TempDir,
    svc: Arc<ConnectionService>,
    id: ConnectionId,
}

fn service(dir: &tempfile::TempDir) -> Arc<ConnectionService> {
    let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
    Arc::new(
        ConnectionService::new(store, Arc::new(MemorySecretStore::new()))
            .with_data_dir(common::data_dir()),
    )
}

async fn sqlite_fixture(production: bool, read_only: bool) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("shop.db");
    rusqlite::Connection::open(&file)
        .unwrap()
        .execute_batch("CREATE TABLE t(a INTEGER); INSERT INTO t VALUES (1), (2);")
        .unwrap();
    let svc = service(&dir);
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
            query_timeout_secs: None,
            ai_access: Default::default(),
            ai_sync: Default::default(),
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

fn first_count(o: ExecOutcome) -> String {
    match o {
        ExecOutcome::Rows { rows, .. } => match &rows[0][0] {
            contura_core::model::Cell::Number { value } => value.clone(),
            other => panic!("not a number: {other:?}"),
        },
        other => panic!("not rows: {other:?}"),
    }
}

#[tokio::test]
async fn explain_on_a_production_write_needs_no_pass_and_changes_nothing() {
    let f = sqlite_fixture(true, false).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    let before = f.svc.query_history(Some(f.id), all()).unwrap().len();
    let plan = f.svc.explain(s, "UPDATE t SET a = 9".into()).await.unwrap();
    assert!(!plan.nodes.is_empty());
    assert!(plan.raw.contains("t"));
    let n = f
        .svc
        .execute_sql(s, "SELECT count(*) FROM t WHERE a = 9".into(), None)
        .await
        .unwrap();
    assert_eq!(first_count(n.outcome), "0");
    // Only the count above is new.
    let after = f.svc.query_history(Some(f.id), all()).unwrap().len();
    assert_eq!(after, before + 1);
}

#[tokio::test]
async fn explain_on_read_only_is_allowed() {
    let f = sqlite_fixture(false, true).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    let plan = f
        .svc
        .explain(s, "DELETE FROM t WHERE a = 1".into())
        .await
        .unwrap();
    assert!(!plan.nodes.is_empty());
}

#[tokio::test]
async fn explain_leaves_no_history_row() {
    let f = sqlite_fixture(false, false).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    f.svc.explain(s, "SELECT * FROM t".into()).await.unwrap();
    assert!(f.svc.query_history(Some(f.id), all()).unwrap().is_empty());
}

async fn refused(f: &Fixture, s: QuerySessionId, sql: &str) -> String {
    match f.svc.explain(s, sql.into()).await {
        Err(Error::InvalidInput(m)) => m,
        other => panic!("expected InvalidInput for {sql:?}, got {other:?}"),
    }
}

#[tokio::test]
async fn explain_refuses_two_statements() {
    let f = sqlite_fixture(false, false).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    assert_eq!(
        refused(&f, s, "SELECT 1; DELETE FROM t").await,
        "Explain one statement at a time."
    );
    assert_eq!(
        refused(&f, s, "  ").await,
        "Explain one statement at a time."
    );
}

#[tokio::test]
async fn explain_refuses_explain_analyze() {
    let f = sqlite_fixture(false, false).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    assert_eq!(
        refused(&f, s, "EXPLAIN ANALYZE DELETE FROM t").await,
        "Explain the statement itself, without EXPLAIN."
    );
    assert_eq!(
        refused(&f, s, "-- c\nexplain query plan DELETE FROM t").await,
        "Explain the statement itself, without EXPLAIN."
    );
    // Nothing ran.
    let n = f
        .svc
        .execute_sql(s, "SELECT count(*) FROM t".into(), None)
        .await
        .unwrap();
    assert_eq!(first_count(n.outcome), "2");
}

#[tokio::test]
async fn mysql_explain_tree_on_dbview_test() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service(&dir);
    let db = TestDb::create().await;
    let saved = svc
        .save(ConnectionInput {
            id: None,
            name: "live".into(),
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
            ai_sync: Default::default(),
            production: false,
            read_only: false,
        })
        .await
        .unwrap();
    svc.open(saved.id).await.unwrap();
    let s = svc.open_query_session(saved.id, None).await.unwrap();
    svc.execute_sql(
        s,
        "CREATE TABLE orders (id INT PRIMARY KEY, status VARCHAR(8))".into(),
        None,
    )
    .await
    .unwrap();
    let plan = svc
        .explain(s, "SELECT * FROM orders WHERE status = 'paid'".into())
        .await
        .unwrap();
    assert!(plan.raw.starts_with("-> "), "{}", plan.raw);
    assert!(!plan.nodes.is_empty());
    assert!(!plan.nodes[0].label.is_empty());
    svc.close_query_session(s).await.unwrap();
    svc.close(saved.id).await.unwrap();
    db.drop_db().await;
}

#[tokio::test]
async fn pg_explain_json_is_not_cut() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service(&dir);
    let db = PgTestDb::create().await;
    let saved = svc
        .save(ConnectionInput {
            id: None,
            name: "live".into(),
            dialect: DialectKind::Postgres,
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
            ai_sync: Default::default(),
            production: false,
            read_only: false,
        })
        .await
        .unwrap();
    svc.open(saved.id).await.unwrap();
    let s = svc.open_query_session(saved.id, None).await.unwrap();
    for t in ["a", "b", "c", "d", "e"] {
        svc.execute_sql(
            s,
            format!("CREATE TABLE {t} (id INT PRIMARY KEY, v TEXT)"),
            None,
        )
        .await
        .unwrap();
    }
    let plan = svc
        .explain(
            s,
            "SELECT * FROM a JOIN b ON a.v = b.v JOIN c ON b.v = c.v JOIN d ON c.v = d.v JOIN e ON d.v = e.v"
                .into(),
        )
        .await
        .unwrap();
    assert!(plan.raw.len() > 1024, "raw is {} chars", plan.raw.len());
    assert!(!plan.nodes.is_empty());
    assert!(plan.total_cost.is_some());
    svc.close_query_session(s).await.unwrap();
    svc.close(saved.id).await.unwrap();
    db.drop_db().await;
}

#[tokio::test]
async fn explain_refuses_statements_it_cannot_plan_and_pragma_stays_put() {
    let f = sqlite_fixture(true, false).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    let pragma = |s| {
        let svc = f.svc.clone();
        async move {
            let n = svc
                .execute_sql(s, "PRAGMA foreign_keys".into(), None)
                .await
                .unwrap();
            first_count(n.outcome)
        }
    };
    let before = pragma(s).await;
    let msg = "Contura explains only statements it can plan without running them.";
    for sql in [
        "PRAGMA foreign_keys = OFF",
        "ANALYZE t",
        "ANALYSE t",
        "DESC t",
        "DESCRIBE t",
        "VACUUM",
    ] {
        let got = refused(&f, s, sql).await;
        if sql.starts_with("DESC") {
            assert_eq!(
                got, "Explain the statement itself, without EXPLAIN.",
                "{sql}"
            );
        } else {
            assert_eq!(got, msg, "{sql}");
        }
    }
    assert_eq!(pragma(s).await, before);
}

#[tokio::test]
async fn explain_skips_leading_semicolons() {
    let f = sqlite_fixture(false, false).await;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    let plan = f
        .svc
        .explain(
            s,
            ";
 ; SELECT * FROM t"
                .into(),
        )
        .await
        .unwrap();
    assert!(!plan.nodes.is_empty());
}
