mod common;

use std::sync::Arc;

use common::TestDb;
use common::pg::PgTestDb;
use contura_core::ai::models::{ModelInfo, info_for};
use contura_core::ai::preview::preview;
use contura_core::ai::rails::Secrets;
use contura_core::ai::request::{AskRequest, Focus, Switches, TableRef};
use contura_core::ai::{AiAccess, AiProviderKind, AiSettings};
use contura_core::connections::{ConnectionInput, ConnectionService, PasswordChange};
use contura_core::model::{ConnectionConfig, DialectKind, SslMode};
use contura_core::secrets::MemorySecretStore;
use contura_core::store::AppStore;

const TABLES: [&str; 2] = [
    "CREATE TABLE stores (id INT PRIMARY KEY, name VARCHAR(80))",
    "CREATE TABLE orders (id INT PRIMARY KEY, store_id INT, \
     FOREIGN KEY (store_id) REFERENCES stores(id))",
];

fn service(dir: &tempfile::TempDir) -> Arc<ConnectionService> {
    let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
    Arc::new(
        ConnectionService::new(store, Arc::new(MemorySecretStore::new()))
            .with_data_dir(common::data_dir()),
    )
}

async fn save_and_open(
    svc: &ConnectionService,
    dialect: DialectKind,
    config: &ConnectionConfig,
    password: Option<String>,
) -> ConnectionConfig {
    let saved = svc
        .save(ConnectionInput {
            id: None,
            name: "live".into(),
            dialect,
            host: config.host.clone(),
            port: config.port,
            user: config.user.clone(),
            database: config.database.clone(),
            ssl: SslMode::Disable,
            password: PasswordChange::Set {
                value: password.unwrap(),
            },
            group_id: None,
            file: None,
            query_timeout_secs: None,
            ai_access: AiAccess::Schema,
            ai_sync: Default::default(),
            production: false,
            read_only: false,
        })
        .await
        .unwrap();
    svc.open(saved.id).await.unwrap();
    let s = svc.open_query_session(saved.id, None).await.unwrap();
    for sql in TABLES {
        svc.execute_sql(s, sql.into(), None).await.unwrap();
    }
    svc.close_query_session(s).await.unwrap();
    saved
}

fn ask(saved: &ConnectionConfig) -> AskRequest {
    let table = |name: &str| TableRef {
        schema: None,
        name: name.into(),
    };
    AskRequest {
        request_id: "live".into(),
        place: "ungrouped".into(),
        group_id: None,
        connection_id: Some(saved.id),
        database: saved.database.clone(),
        schema: None,
        action: "ask".into(),
        question: "which store sells most?".into(),
        thread_id: None,
        focus: Focus {
            tables: vec![table("orders"), table("stores")],
            ..Focus::default()
        },
        switches: Switches::default(),
        off: Vec::new(),
        model: None,
        picks: None,
    }
}

/// A model nothing is known about: the 8,000 token window.
fn model_m() -> ModelInfo {
    info_for(
        AiProviderKind::Custom,
        None,
        "m",
        None,
        &AiSettings::default(),
    )
}

fn assert_both_cards(exact: &str, orders: &str) {
    assert!(exact.contains(orders), "{exact}");
    assert!(exact.contains("stores(id "), "{exact}");
    assert!(exact.ends_with("Question: which store sells most?"));
}

#[tokio::test]
async fn mysql_preview_sends_both_cards() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service(&dir);
    let db = TestDb::create().await;
    let saved = save_and_open(&svc, DialectKind::MySql, &db.config, db.password.clone()).await;

    let p = preview(
        &*svc,
        &AiSettings::default(),
        &model_m(),
        &Secrets::default(),
        &ask(&saved),
    )
    .await
    .unwrap();
    assert_eq!(p.tables.full, ["orders", "stores"]);
    assert_both_cards(&p.exact, "orders(id int pk, store_id int -> stores.id)");

    svc.close(saved.id).await.unwrap();
    db.drop_db().await;
}

#[tokio::test]
async fn postgres_preview_sends_both_cards() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service(&dir);
    let db = PgTestDb::create().await;
    let saved = save_and_open(&svc, DialectKind::Postgres, &db.config, db.password.clone()).await;

    let p = preview(
        &*svc,
        &AiSettings::default(),
        &model_m(),
        &Secrets::default(),
        &ask(&saved),
    )
    .await
    .unwrap();
    assert_eq!(p.tables.full, ["orders", "stores"]);
    assert_both_cards(
        &p.exact,
        "orders(id integer pk, store_id integer -> stores.id)",
    );

    svc.close(saved.id).await.unwrap();
    db.drop_db().await;
}

#[tokio::test]
async fn sqlite_preview_sends_both_cards() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("shop.db");
    rusqlite::Connection::open(&file)
        .unwrap()
        .execute_batch(&format!("{};{};", TABLES[0], TABLES[1]))
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
            ai_access: AiAccess::Schema,
            ai_sync: Default::default(),
            production: false,
            read_only: false,
        })
        .await
        .unwrap();
    svc.open(saved.id).await.unwrap();

    let p = preview(
        &*svc,
        &AiSettings::default(),
        &model_m(),
        &Secrets::default(),
        &ask(&saved),
    )
    .await
    .unwrap();
    assert_eq!(p.tables.full, ["orders", "stores"]);
    assert_both_cards(&p.exact, "orders(id INT pk, store_id INT -> stores.id)");
    svc.close(saved.id).await.unwrap();
}

async fn run_sql(svc: &ConnectionService, saved: &ConnectionConfig, sqls: &[&str]) {
    let s = svc.open_query_session(saved.id, None).await.unwrap();
    for sql in sqls {
        svc.execute_sql(s, (*sql).into(), None).await.unwrap();
    }
    svc.close_query_session(s).await.unwrap();
}

/// The comments reach the schema block, inside the card of their table.
fn assert_comments_sent(p: &contura_core::ai::preview::Preview) {
    let line = p
        .parts
        .schema
        .lines()
        .find(|l| l.contains(r#""text":"notes_t("#))
        .unwrap_or_else(|| panic!("no notes_t card in {}", p.parts.schema));
    assert!(
        line.contains(" -- note: one row per note -- body: what the customer wrote"),
        "{line}"
    );
    assert!(p.exact.starts_with(&p.parts.schema));
    assert!(p.tables.full.contains(&"notes_t".to_string()));
}

#[tokio::test]
async fn tier1_reads_comments_live_mysql() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service(&dir);
    let db = TestDb::create().await;
    let saved = save_and_open(&svc, DialectKind::MySql, &db.config, db.password.clone()).await;
    run_sql(
        &svc,
        &saved,
        &["CREATE TABLE notes_t (id INT PRIMARY KEY, \
           body TEXT COMMENT 'what the customer wrote') COMMENT='one row per note'"],
    )
    .await;

    let mut req = ask(&saved);
    req.focus.tables.clear();
    let p = preview(
        &*svc,
        &AiSettings::default(),
        &model_m(),
        &Secrets::default(),
        &req,
    )
    .await
    .unwrap();
    assert_comments_sent(&p);

    svc.close(saved.id).await.unwrap();
    db.drop_db().await;
}

#[tokio::test]
async fn tier1_reads_comments_live_postgres() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service(&dir);
    let db = PgTestDb::create().await;
    let saved = save_and_open(&svc, DialectKind::Postgres, &db.config, db.password.clone()).await;
    run_sql(
        &svc,
        &saved,
        &[
            "CREATE TABLE notes_t (id INT PRIMARY KEY, body TEXT)",
            "COMMENT ON TABLE notes_t IS 'one row per note'",
            "COMMENT ON COLUMN notes_t.body IS 'what the customer wrote'",
        ],
    )
    .await;

    let mut req = ask(&saved);
    req.focus.tables.clear();
    let p = preview(
        &*svc,
        &AiSettings::default(),
        &model_m(),
        &Secrets::default(),
        &req,
    )
    .await
    .unwrap();
    assert_comments_sent(&p);

    svc.close(saved.id).await.unwrap();
    db.drop_db().await;
}

// ---- 11c: the comments come through the stored AI Context ----

use contura_core::ai::context::store::ContextStore;
use contura_core::ai::context::sync::{Purpose, RebuildReason, SchemaCheck, context_key};
use contura_core::ai::log::Log;
use contura_core::ai::preview::{Preview, preview_with_log};

async fn ask_now(svc: &ConnectionService, req: &AskRequest) -> Preview {
    preview_with_log(
        svc,
        &AiSettings::default(),
        &model_m(),
        &Secrets::default(),
        req,
        Purpose::Ask,
        None,
        &mut Log::new(),
    )
    .await
    .unwrap()
}

fn epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// The first Ask builds the Context with the comments; an `ALTER TABLE` run outside
/// Contura is not seen within the minute, then the fingerprint finds it.
async fn context_follows_an_outside_alter<F, Fut>(
    svc: &ConnectionService,
    saved: &ConnectionConfig,
    alter: F,
) where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let mut req = ask(saved);
    req.focus.tables.clear();
    let p = ask_now(svc, &req).await;
    assert_eq!(
        p.context.as_ref().unwrap().check,
        SchemaCheck::Rebuilt {
            reason: RebuildReason::First
        }
    );
    assert_comments_sent(&p);

    alter().await;
    let p = ask_now(svc, &req).await;
    assert_eq!(p.context.as_ref().unwrap().check, SchemaCheck::Recent);
    assert!(!p.parts.schema.contains("how they felt"));

    let key = context_key(saved, saved.database.as_deref(), None);
    svc.mark_checked(&key, epoch_ms() - 61_000).unwrap();
    let p = ask_now(svc, &req).await;
    assert_eq!(
        p.context.as_ref().unwrap().check,
        SchemaCheck::Rebuilt {
            reason: RebuildReason::Changed
        }
    );
    assert!(
        p.parts.schema.contains("-- mood: how they felt"),
        "{}",
        p.parts.schema
    );
    assert_comments_sent(&p);
}

#[tokio::test]
async fn context_reads_comments_live_mysql() {
    use mysql_async::prelude::Queryable;
    let dir = tempfile::tempdir().unwrap();
    let svc = service(&dir);
    let db = TestDb::create().await;
    let saved = save_and_open(&svc, DialectKind::MySql, &db.config, db.password.clone()).await;
    run_sql(
        &svc,
        &saved,
        &["CREATE TABLE notes_t (id INT PRIMARY KEY, \
           body TEXT COMMENT 'what the customer wrote') COMMENT='one row per note'"],
    )
    .await;
    context_follows_an_outside_alter(&svc, &saved, || async {
        let mut conn = common::backup_fixture::mysql_conn(&db, &db.name).await;
        conn.query_drop("ALTER TABLE notes_t ADD COLUMN mood TEXT COMMENT 'how they felt'")
            .await
            .unwrap();
        conn.disconnect().await.unwrap();
    })
    .await;

    svc.close(saved.id).await.unwrap();
    db.drop_db().await;
}

#[tokio::test]
async fn context_reads_comments_live_postgres() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service(&dir);
    let db = PgTestDb::create().await;
    let saved = save_and_open(&svc, DialectKind::Postgres, &db.config, db.password.clone()).await;
    run_sql(
        &svc,
        &saved,
        &[
            "CREATE TABLE notes_t (id INT PRIMARY KEY, body TEXT)",
            "COMMENT ON TABLE notes_t IS 'one row per note'",
            "COMMENT ON COLUMN notes_t.body IS 'what the customer wrote'",
        ],
    )
    .await;
    context_follows_an_outside_alter(&svc, &saved, || async {
        let client = common::pg::pg_admin_client(&db.name).await;
        client
            .batch_execute(
                "ALTER TABLE notes_t ADD COLUMN mood TEXT; \
                 COMMENT ON COLUMN notes_t.mood IS 'how they felt'",
            )
            .await
            .unwrap();
    })
    .await;

    svc.close(saved.id).await.unwrap();
    db.drop_db().await;
}
