//! The AI Context kept by `ConnectionService`: the sync mode, stale marks after schema
//! changes, clearing at Never, Production and delete, and the saved queries kept up to
//! date with no database call.
mod common;

use std::sync::Arc;

use contura_core::ai::context::build::build_context;
use contura_core::ai::context::store::{BuiltContext, ContextKey, ContextStore};
use contura_core::ai::memory::ThreadStore;
use contura_core::ai::memory::store::StoreThreads;
use contura_core::ai::{AiAccess, AiMessage, AiRole, AiService, AiThread};
use contura_core::connections::{ConnectionInput, ConnectionService, PasswordChange};
use contura_core::design::Position;
use contura_core::design::{ColumnDraft, DesignEdit, DesignOutcome, DesignRequest, DesignTarget};
use contura_core::model::{
    AiSyncMode, ConnectionConfig, ConnectionId, DialectKind, ObjectPath, SslMode,
};
use contura_core::query::SavedQueryInput;
use contura_core::secrets::MemorySecretStore;
use contura_core::store::AppStore;
use uuid::Uuid;

struct Fixture {
    dir: tempfile::TempDir,
    svc: Arc<ConnectionService>,
    id: ConnectionId,
    file: std::path::PathBuf,
}

fn input(file: &std::path::Path, id: Option<ConnectionId>, production: bool) -> ConnectionInput {
    ConnectionInput {
        id,
        name: "shop".into(),
        dialect: DialectKind::Sqlite,
        host: String::new(),
        port: 0,
        user: String::new(),
        database: None,
        ssl: SslMode::Disable,
        password: PasswordChange::Keep,
        group_id: None,
        file: Some(file.to_path_buf()),
        query_timeout_secs: None,
        ai_access: Default::default(),
        ai_sync: Default::default(),
        production,
        read_only: false,
    }
}

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("shop.db");
    rusqlite::Connection::open(&file)
        .unwrap()
        .execute_batch(
            "CREATE TABLE orders(id INTEGER PRIMARY KEY, total INTEGER);
             CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT);",
        )
        .unwrap();
    let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
    let svc = Arc::new(
        ConnectionService::new(store, Arc::new(MemorySecretStore::new()))
            .with_data_dir(common::data_dir()),
    );
    let saved = svc.save(input(&file, None, false)).await.unwrap();
    Fixture {
        dir,
        svc,
        id: saved.id,
        file,
    }
}

fn key(id: ConnectionId, database: &str) -> ContextKey {
    ContextKey {
        connection_id: id,
        database: database.into(),
        schema: String::new(),
    }
}

fn keep(text: &str) -> String {
    text.to_string()
}

impl Fixture {
    /// Builds the Context of `main` from the file and stores it under `main` and `aux`,
    /// then closes the Connection.
    async fn seed(&self) -> BuiltContext {
        self.svc.open(self.id).await.unwrap();
        let model = self
            .svc
            .session(self.id)
            .await
            .unwrap()
            .schema_snapshot("main", None)
            .await
            .unwrap();
        let built = build_context(&model, DialectKind::Sqlite, "main", &[], &keep);
        for db in ["main", "aux"] {
            self.svc
                .replace_context(&key(self.id, db), &built, Some("sqlite:1"), 1_000)
                .unwrap();
        }
        self.svc.close(self.id).await.unwrap();
        built
    }

    fn stale(&self) -> Vec<bool> {
        self.svc
            .context_list(Some(self.id))
            .unwrap()
            .into_iter()
            .map(|(_, m)| m.stale)
            .collect()
    }

    fn contexts(&self) -> usize {
        self.svc.context_list(Some(self.id)).unwrap().len()
    }

    async fn run(&self, sql: &str) -> bool {
        self.svc.open(self.id).await.unwrap();
        let s = self.svc.open_query_session(self.id, None).await.unwrap();
        self.svc.execute_sql(s, sql.into(), None).await.is_ok()
    }

    fn saved_names(&self, database: &str) -> Vec<String> {
        self.svc
            .context_saved(&key(self.id, database))
            .unwrap()
            .into_iter()
            .map(|q| q.name)
            .collect()
    }
}

#[tokio::test]
async fn sync_mode_defaults_to_automatic() {
    let f = fixture().await;
    let stored = f.svc.list().unwrap().remove(0);
    let mut json = serde_json::to_value(&stored).unwrap();
    json.as_object_mut().unwrap().remove("aiSync");
    let read: ConnectionConfig = serde_json::from_value(json).unwrap();
    assert_eq!(read.ai_sync, AiSyncMode::Automatic);
    assert_eq!(stored.ai_sync, AiSyncMode::Automatic);

    let saved = f.svc.set_ai_sync_mode(f.id, AiSyncMode::Manual).unwrap();
    assert_eq!(saved.ai_sync, AiSyncMode::Manual);
    assert_eq!(f.svc.list().unwrap()[0].ai_sync, AiSyncMode::Manual);
    assert_eq!(
        serde_json::to_value(AiSyncMode::Manual).unwrap(),
        serde_json::json!("manual")
    );
}

#[tokio::test]
async fn never_clears_context() {
    let f = fixture().await;
    f.seed().await;
    f.svc.set_ai_access(f.id, AiAccess::Schema).await.unwrap();
    assert_eq!(f.contexts(), 2);
    f.svc.set_ai_access(f.id, AiAccess::Never).await.unwrap();
    assert_eq!(f.contexts(), 0);
}

#[tokio::test]
async fn production_on_clears_context() {
    let f = fixture().await;
    f.seed().await;
    f.svc.save(input(&f.file, Some(f.id), false)).await.unwrap();
    assert_eq!(f.contexts(), 2);
    let saved = f.svc.save(input(&f.file, Some(f.id), true)).await.unwrap();
    assert_eq!(saved.ai_access, AiAccess::Never);
    assert_eq!(f.contexts(), 0);
}

#[tokio::test]
async fn delete_clears_context() {
    let f = fixture().await;
    f.seed().await;
    let other = ConnectionId::new_v4();
    let built = BuiltContext::default();
    f.svc
        .replace_context(&key(other, "main"), &built, None, 1)
        .unwrap();
    f.svc.delete(f.id).await.unwrap();
    assert_eq!(f.contexts(), 0);
    assert_eq!(f.svc.context_list(None).unwrap().len(), 1);
}

#[tokio::test]
async fn ddl_marks_stale() {
    let f = fixture().await;
    f.seed().await;
    assert_eq!(f.stale(), [false, false]);
    assert!(f.run("create table t2(a int)").await);
    assert_eq!(f.stale(), [true, true]);
}

#[tokio::test]
async fn read_does_not_mark() {
    let f = fixture().await;
    f.seed().await;
    assert!(f.run("select 1").await);
    assert!(f.run("insert into orders(total) values (3)").await);
    assert_eq!(f.stale(), [false, false]);
}

#[tokio::test]
async fn failed_ddl_does_not_mark() {
    let f = fixture().await;
    f.seed().await;
    assert!(!f.run("create table orders(a int)").await);
    assert_eq!(f.stale(), [false, false]);
}

#[tokio::test]
async fn apply_design_marks_stale() {
    let f = fixture().await;
    f.seed().await;
    let req = DesignRequest {
        target: DesignTarget::Create {
            path: ObjectPath {
                database: "main".into(),
                schema: None,
                name: "notes".into(),
            },
        },
        edits: vec![DesignEdit::AddColumn {
            column: ColumnDraft {
                name: "id".into(),
                type_sql: "INTEGER".into(),
                nullable: true,
                default_sql: None,
                increment: false,
                comment: None,
            },
            position: Position::Last,
        }],
    };
    f.svc.open(f.id).await.unwrap();
    let out = f.svc.apply_design(f.id, req, None).await.unwrap();
    assert!(matches!(out, DesignOutcome::Done { .. }));
    assert_eq!(f.stale(), [true, true]);
}

#[tokio::test]
async fn context_changed_marks_stale() {
    let f = fixture().await;
    f.seed().await;
    f.svc.mark_ai_context_stale(f.id).unwrap();
    assert_eq!(f.stale(), [true, true]);
    assert!(!f.svc.is_open(f.id));
}

#[tokio::test]
async fn saved_query_upkeep_without_db_calls() {
    let f = fixture().await;
    f.seed().await;
    assert!(!f.svc.is_open(f.id));
    let save = |id: Option<Uuid>, name: &str, sql: &str| SavedQueryInput {
        id,
        name: name.into(),
        sql: sql.into(),
        connection_id: None,
        kind: None,
        visual_json: None,
    };
    let q = f
        .svc
        .save_saved_query(save(
            None,
            "Big orders",
            "select * from orders where total > 100",
        ))
        .unwrap();
    assert_eq!(f.saved_names("main"), ["Big orders"]);
    assert_eq!(f.saved_names("aux"), ["Big orders"]);
    let stored = f.svc.context_saved(&key(f.id, "main")).unwrap().remove(0);
    assert_eq!(stored.tables, ["orders"]);
    assert!(!stored.sql.contains("100"), "{}", stored.sql);

    f.svc
        .save_saved_query(save(Some(q.id), "Large orders", &q.sql))
        .unwrap();
    assert_eq!(f.saved_names("main"), ["Large orders"]);

    f.svc
        .save_saved_query(save(Some(q.id), "Large orders", "select * from missing"))
        .unwrap();
    assert!(f.saved_names("main").is_empty());
    assert!(f.saved_names("aux").is_empty());

    f.svc
        .save_saved_query(save(Some(q.id), "Large orders", &q.sql))
        .unwrap();
    assert_eq!(f.saved_names("main"), ["Large orders"]);
    f.svc.delete_saved_query(q.id).unwrap();
    assert!(f.saved_names("main").is_empty());
    assert!(f.saved_names("aux").is_empty());
    assert!(!f.svc.is_open(f.id));
}

fn rows(path: &std::path::Path, table: &str) -> i64 {
    rusqlite::Connection::open(path)
        .unwrap()
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

#[tokio::test]
async fn clear_all_ai_data() {
    let f = fixture().await;
    f.seed().await;
    f.svc
        .save_saved_query(SavedQueryInput {
            id: None,
            name: "All orders".into(),
            sql: "select * from orders".into(),
            connection_id: None,
            kind: None,
            visual_json: None,
        })
        .unwrap();
    let app = f.dir.path().join("app.sqlite");
    let ai = AiService::new(
        AppStore::open(&app).unwrap(),
        Arc::new(MemorySecretStore::new()),
    );
    for place in ["ungrouped", "group:g1"] {
        ai.save_thread(&AiThread {
            id: Uuid::new_v4(),
            place: place.into(),
            title: "t".into(),
            messages: vec![AiMessage {
                role: AiRole::User,
                text: "how many orders?".into(),
                context: vec![],
                at: 1,
                record: None,
                topic: None,
                connection_id: None,
                database: None,
                kinds: Vec::new(),
                tables: Vec::new(),
                action: None,
                asked_in: None,
            }],
            updated_at: 1,
        })
        .unwrap();
    }
    assert_eq!(rows(&app, "ai_threads"), 2);
    assert!(rows(&app, "ai_context_node") > 0);

    f.svc.clear_ai_context(None).unwrap();
    ai.clear_all_threads().unwrap();
    for table in [
        "ai_context_meta",
        "ai_context_node",
        "ai_context_card",
        "ai_context_fts",
        "ai_threads",
    ] {
        assert_eq!(rows(&app, table), 0, "{table}");
    }
}

// ---- ensure(): when the Context is checked and rebuilt ----

use contura_core::ai::context::store::StoreContext;
use contura_core::ai::context::sync::{
    CHECK_EVERY_MS, ContextInfo, Purpose, RebuildReason, SchemaCheck, ensure, resync,
    schema_wording,
};
use contura_core::ai::log::{Level, Log, ProcessStep};
use contura_core::ai::preview::CatalogReader;
use contura_core::ai::rails::Secrets;
use contura_core::schema_model::{SchemaModel, SmTable};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

const T0: i64 = 1_700_000_000_000;
const MIN: i64 = 60_000;

/// A catalog over its own `StoreContext`, counting catalog reads.
struct SyncCatalog {
    config: Mutex<ConnectionConfig>,
    model: Mutex<Result<SchemaModel, String>>,
    fingerprint: Mutex<Result<String, String>>,
    snapshots: AtomicUsize,
    fingerprints: AtomicUsize,
    never_on_snapshot: AtomicBool,
    /// As a Contura DDL finishing while the catalog is read: marks the Context stale.
    mark_on_snapshot: AtomicBool,
    store: StoreContext,
    threads: StoreThreads,
}

fn model(tables: &[&str]) -> SchemaModel {
    SchemaModel {
        dialect: DialectKind::Postgres,
        tables: tables
            .iter()
            .map(|t| SmTable {
                schema: Some("public".into()),
                name: (*t).into(),
                alias: None,
                note: None,
                columns: Vec::new(),
                indexes: Vec::new(),
            })
            .collect(),
        refs: Vec::new(),
        enums: Vec::new(),
        skipped: Vec::new(),
    }
}

fn pg(sync: AiSyncMode) -> ConnectionConfig {
    ConnectionConfig {
        id: Uuid::from_u128(9),
        name: "Shop prod".into(),
        dialect: DialectKind::Postgres,
        host: "db.internal".into(),
        port: 5432,
        user: "app".into(),
        database: Some("shop".into()),
        ssl: SslMode::Disable,
        group_id: None,
        file: None,
        query_timeout_secs: None,
        ai_access: AiAccess::Schema,
        ai_sync: sync,
        production: false,
        read_only: false,
    }
}

fn sync_catalog(sync: AiSyncMode) -> SyncCatalog {
    sync_catalog_on(
        sync,
        AppStore::open(std::path::Path::new(":memory:")).unwrap(),
    )
}

fn sync_catalog_on(sync: AiSyncMode, store: AppStore) -> SyncCatalog {
    SyncCatalog {
        config: Mutex::new(pg(sync)),
        model: Mutex::new(Ok(model(&["orders", "customers"]))),
        fingerprint: Mutex::new(Ok("pg:1".into())),
        snapshots: AtomicUsize::new(0),
        fingerprints: AtomicUsize::new(0),
        never_on_snapshot: AtomicBool::new(false),
        mark_on_snapshot: AtomicBool::new(false),
        store: StoreContext::new(store),
        threads: StoreThreads::new(AppStore::open(std::path::Path::new(":memory:")).unwrap()),
    }
}

#[async_trait::async_trait]
impl CatalogReader for SyncCatalog {
    async fn connection_config(
        &self,
        id: ConnectionId,
    ) -> contura_core::Result<Option<ConnectionConfig>> {
        let c = self.config.lock().unwrap().clone();
        Ok((c.id == id).then_some(c))
    }

    async fn schema_snapshot(
        &self,
        _id: ConnectionId,
        _database: &str,
        _schema: Option<&str>,
    ) -> contura_core::Result<SchemaModel> {
        self.snapshots.fetch_add(1, Ordering::SeqCst);
        // Lets two Asks at once overlap.
        tokio::task::yield_now().await;
        if self.never_on_snapshot.load(Ordering::SeqCst) {
            // As the service does: Never is saved and the Context cleared mid-build.
            let id = {
                let mut c = self.config.lock().unwrap();
                c.ai_access = AiAccess::Never;
                c.id
            };
            self.store.clear_context(Some(id)).unwrap();
        }
        if self.mark_on_snapshot.load(Ordering::SeqCst) {
            self.store.mark_stale(Uuid::from_u128(9)).unwrap();
        }
        self.model
            .lock()
            .unwrap()
            .clone()
            .map_err(contura_core::Error::Query)
    }

    async fn schema_fingerprint(
        &self,
        _id: ConnectionId,
        _database: &str,
        _schema: Option<&str>,
    ) -> contura_core::Result<String> {
        self.fingerprints.fetch_add(1, Ordering::SeqCst);
        tokio::task::yield_now().await;
        self.fingerprint
            .lock()
            .unwrap()
            .clone()
            .map_err(contura_core::Error::Query)
    }

    fn context(&self) -> &dyn ContextStore {
        &self.store
    }

    fn threads(&self) -> &dyn ThreadStore {
        &self.threads
    }
}

impl SyncCatalog {
    fn key(&self) -> ContextKey {
        ContextKey {
            connection_id: Uuid::from_u128(9),
            database: "shop".into(),
            schema: "public".into(),
        }
    }

    async fn ensure_at(&self, purpose: Purpose, now: i64) -> (ContextInfo, ProcessStep, Log) {
        let config = self.config.lock().unwrap().clone();
        let mut log = Log::new();
        let (info, step) = ensure(self, &config, &self.key(), purpose, &keep, now, &mut log).await;
        (info, step, log)
    }

    fn reads(&self) -> (usize, usize) {
        (
            self.snapshots.load(Ordering::SeqCst),
            self.fingerprints.load(Ordering::SeqCst),
        )
    }

    fn reset(&self) {
        self.snapshots.store(0, Ordering::SeqCst);
        self.fingerprints.store(0, Ordering::SeqCst);
    }

    fn cards(&self) -> Vec<String> {
        self.store
            .context_graph(&self.key())
            .unwrap()
            .into_iter()
            .map(|g| g.table)
            .collect()
    }
}

fn rebuilt(reason: RebuildReason) -> SchemaCheck {
    SchemaCheck::Rebuilt { reason }
}

#[tokio::test]
async fn first_ensure_builds() {
    let c = sync_catalog(AiSyncMode::Automatic);
    let (info, step, log) = c.ensure_at(Purpose::Ask, T0).await;
    assert_eq!(info.check, rebuilt(RebuildReason::First));
    assert_eq!(c.reads(), (1, 1));
    assert_eq!(info.built_at, Some(T0));
    assert_eq!(info.table_count, 2);
    assert!(!info.stale);
    let meta = c.store.context_meta(&c.key()).unwrap().unwrap();
    assert_eq!(meta.fingerprint.as_deref(), Some("pg:1"));
    assert_eq!(meta.built_at, T0);
    assert_eq!(step.value, "re-synced, 2 tables");
    let line = log.lines.iter().find(|l| l.source == "schema").unwrap();
    let field = |k: &str| {
        line.fields
            .iter()
            .find(|(f, _)| f == k)
            .map(|(_, v)| v.clone())
    };
    assert_eq!(field("rebuilt").as_deref(), Some("first"));
    assert_eq!(field("tables").as_deref(), Some("2"));
    assert!(field("ms").is_some() && field("bytes").is_some());

    // The first Context in Manual stores no fingerprint and reads none.
    let m = sync_catalog(AiSyncMode::Manual);
    let (info, _, _) = m.ensure_at(Purpose::Preview, T0).await;
    assert_eq!(info.check, rebuilt(RebuildReason::First));
    assert_eq!(m.reads(), (1, 0));
    assert_eq!(
        m.store.context_meta(&m.key()).unwrap().unwrap().fingerprint,
        None
    );
}

#[tokio::test]
async fn preview_never_fingerprints() {
    for sync in [AiSyncMode::Automatic, AiSyncMode::Manual] {
        let c = sync_catalog(sync);
        c.ensure_at(Purpose::Ask, T0).await;
        c.reset();
        let (info, step, _) = c.ensure_at(Purpose::Preview, T0 + 5 * MIN).await;
        assert_eq!(c.reads(), (0, 0), "{sync:?}");
        assert_eq!(info.check, SchemaCheck::Unchecked);
        assert_eq!(step.rule, "The preview never checks the schema.");
        c.store.mark_stale(c.key().connection_id).unwrap();
        let (info, _, _) = c.ensure_at(Purpose::Preview, T0 + 6 * MIN).await;
        assert_eq!(c.reads(), (0, 0), "{sync:?}");
        assert_eq!(info.check, SchemaCheck::Stale);
        assert!(info.stale);
    }
}

#[tokio::test]
async fn ask_checks_once_a_minute() {
    let c = sync_catalog(AiSyncMode::Automatic);
    c.ensure_at(Purpose::Ask, T0).await;
    c.reset();
    let (info, _, log) = c.ensure_at(Purpose::Ask, T0 + 10_000).await;
    assert_eq!((info.check, c.reads()), (SchemaCheck::Recent, (0, 0)));
    assert!(
        log.lines
            .iter()
            .any(|l| l.fields.contains(&("fingerprint".into(), "skipped".into())))
    );
    let (info, _, log) = c.ensure_at(Purpose::Ask, T0 + 61_000).await;
    assert_eq!((info.check, c.reads()), (SchemaCheck::Match, (0, 1)));
    assert!(
        log.lines
            .iter()
            .any(|l| l.fields.contains(&("fingerprint".into(), "match".into())))
    );
    assert_eq!(
        c.store.context_meta(&c.key()).unwrap().unwrap().checked_at,
        T0 + 61_000
    );
    let (info, _, _) = c.ensure_at(Purpose::Ask, T0 + 90_000).await;
    assert_eq!((info.check, c.reads()), (SchemaCheck::Recent, (0, 1)));
    // Exactly a minute after the last check checks again.
    let (info, _, _) = c
        .ensure_at(Purpose::Ask, T0 + 61_000 + CHECK_EVERY_MS)
        .await;
    assert_eq!((info.check, c.reads()), (SchemaCheck::Match, (0, 2)));
}

#[tokio::test]
async fn changed_fingerprint_rebuilds() {
    let c = sync_catalog(AiSyncMode::Automatic);
    c.ensure_at(Purpose::Ask, T0).await;
    c.reset();
    *c.fingerprint.lock().unwrap() = Ok("pg:2".into());
    *c.model.lock().unwrap() = Ok(model(&["orders", "customers", "refunds"]));
    let (info, step, _) = c.ensure_at(Purpose::Ask, T0 + 2 * MIN).await;
    assert_eq!(info.check, rebuilt(RebuildReason::Changed));
    assert_eq!(c.reads(), (1, 1));
    assert_eq!(info.table_count, 3);
    assert_eq!(info.built_at, Some(T0 + 2 * MIN));
    assert_eq!(
        c.store
            .context_meta(&c.key())
            .unwrap()
            .unwrap()
            .fingerprint
            .as_deref(),
        Some("pg:2")
    );
    assert_eq!(step.value, "re-synced, 3 tables");
}

#[tokio::test]
async fn stale_rebuilds_in_automatic() {
    let c = sync_catalog(AiSyncMode::Automatic);
    c.ensure_at(Purpose::Ask, T0).await;
    c.reset();
    c.store.mark_stale(c.key().connection_id).unwrap();
    // Even within the minute: a stale mark is not a query, and it rebuilds.
    let (info, _, _) = c.ensure_at(Purpose::Ask, T0 + 5_000).await;
    assert_eq!(info.check, rebuilt(RebuildReason::Stale));
    assert_eq!(c.reads(), (1, 1));
    assert!(!info.stale);
    assert!(!c.store.context_meta(&c.key()).unwrap().unwrap().stale);
}

#[tokio::test]
async fn ddl_during_a_build_keeps_its_stale_mark() {
    let c = sync_catalog(AiSyncMode::Manual);
    c.ensure_at(Purpose::Ask, T0).await;
    c.mark_on_snapshot.store(true, Ordering::SeqCst);
    let (info, _, _) = c.ensure_at(Purpose::Resync, T0 + MIN).await;
    assert_eq!(info.check, rebuilt(RebuildReason::Asked));
    assert!(info.stale);
    assert!(c.store.context_meta(&c.key()).unwrap().unwrap().stale);
    // With no mark during it, a build clears the mark.
    c.mark_on_snapshot.store(false, Ordering::SeqCst);
    let (info, _, _) = c.ensure_at(Purpose::Resync, T0 + 2 * MIN).await;
    assert!(!info.stale);
    assert!(!c.store.context_meta(&c.key()).unwrap().unwrap().stale);
}

#[tokio::test]
async fn ask_after_a_preview_build_checks_once() {
    let c = sync_catalog(AiSyncMode::Automatic);
    c.ensure_at(Purpose::Preview, T0).await;
    assert_eq!(c.reads(), (1, 0));
    let (info, _, log) = c.ensure_at(Purpose::Ask, T0 + 2 * MIN).await;
    // One check, no second build: the fingerprint read becomes the Context's.
    assert_eq!((info.check, c.reads()), (SchemaCheck::Match, (1, 1)));
    assert_eq!(field_of(&log, "fingerprint"), ["read"]);
    let meta = c.store.context_meta(&c.key()).unwrap().unwrap();
    assert_eq!(meta.fingerprint.as_deref(), Some("pg:1"));
    assert_eq!((meta.built_at, meta.checked_at), (T0, T0 + 2 * MIN));
    // From then on a change rebuilds as usual.
    *c.fingerprint.lock().unwrap() = Ok("pg:2".into());
    let (info, _, _) = c.ensure_at(Purpose::Ask, T0 + 4 * MIN).await;
    assert_eq!(info.check, rebuilt(RebuildReason::Changed));

    // A preview-built Context older than ten minutes is built again.
    let old = sync_catalog(AiSyncMode::Automatic);
    old.ensure_at(Purpose::Preview, T0).await;
    let (info, _, _) = old.ensure_at(Purpose::Ask, T0 + 11 * MIN).await;
    assert_eq!(
        (info.check, old.reads()),
        (rebuilt(RebuildReason::First), (2, 1))
    );
    assert_eq!(
        old.store
            .context_meta(&old.key())
            .unwrap()
            .unwrap()
            .fingerprint
            .as_deref(),
        Some("pg:1")
    );
}

#[tokio::test]
async fn manual_never_queries() {
    let c = sync_catalog(AiSyncMode::Manual);
    c.ensure_at(Purpose::Ask, T0).await;
    c.reset();
    *c.fingerprint.lock().unwrap() = Ok("pg:2".into());
    c.store.mark_stale(c.key().connection_id).unwrap();
    let (info, step, _) = c.ensure_at(Purpose::Ask, T0 + 2 * 86_400_000).await;
    assert_eq!(c.reads(), (0, 0));
    assert_eq!(info.check, SchemaCheck::Stale);
    assert_eq!(info.built_at, Some(T0));
    assert_eq!(step.value, "stale, synced 2d ago");
    assert_eq!(c.cards(), ["customers", "orders"]);

    let unmarked = sync_catalog(AiSyncMode::Manual);
    unmarked.ensure_at(Purpose::Ask, T0).await;
    unmarked.reset();
    let (info, step, _) = unmarked.ensure_at(Purpose::Ask, T0 + 3 * MIN).await;
    assert_eq!(unmarked.reads(), (0, 0));
    assert_eq!(info.check, SchemaCheck::Unchecked);
    assert_eq!(
        step.rule,
        "Sync is set to Manual, so the schema was not checked."
    );
}

#[tokio::test]
async fn resync_always_rebuilds() {
    for sync in [AiSyncMode::Automatic, AiSyncMode::Manual] {
        let c = sync_catalog(sync);
        c.ensure_at(Purpose::Ask, T0).await;
        c.reset();
        let (info, step, _) = c.ensure_at(Purpose::Resync, T0 + 1_000).await;
        assert_eq!(info.check, rebuilt(RebuildReason::Asked), "{sync:?}");
        assert_eq!(c.reads().0, 1);
        assert_eq!(c.reads().1, usize::from(sync == AiSyncMode::Automatic));
        assert_eq!(info.built_at, Some(T0 + 1_000));
        assert_eq!(
            step.rule,
            "Re-sync rebuilt the AI Context. No rows are read."
        );
    }
}

#[tokio::test]
async fn resync_command_refuses_never() {
    let c = sync_catalog(AiSyncMode::Automatic);
    let info = resync(&c, Uuid::from_u128(9), None, None, &Secrets::default(), T0)
        .await
        .unwrap();
    // No Context yet: still Re-sync's wording, since the user asked for it.
    assert_eq!(info.check, rebuilt(RebuildReason::Asked));
    let mut log = Log::new();
    let config = c.config.lock().unwrap().clone();
    c.store.clear_context(None).unwrap();
    let (_, step) = ensure(&c, &config, &c.key(), Purpose::Resync, &keep, T0, &mut log).await;
    assert_eq!(
        step.rule,
        "Re-sync rebuilt the AI Context. No rows are read."
    );
    let info = resync(&c, Uuid::from_u128(9), None, None, &Secrets::default(), T0)
        .await
        .unwrap();
    assert_eq!(info.check, rebuilt(RebuildReason::Asked));
    assert_eq!(
        (info.database.as_str(), info.schema.as_str()),
        ("shop", "public")
    );
    c.config.lock().unwrap().ai_access = AiAccess::Never;
    let err = resync(&c, Uuid::from_u128(9), None, None, &Secrets::default(), T0)
        .await
        .unwrap_err();
    assert!(
        matches!(&err, contura_core::Error::InvalidInput(m) if m == "AI access is Never for this Connection."),
        "{err:?}"
    );
    assert!(
        resync(&c, Uuid::from_u128(1), None, None, &Secrets::default(), T0)
            .await
            .is_err()
    );
}

fn warns(log: &Log) -> Vec<Vec<(String, String)>> {
    log.lines
        .iter()
        .filter(|l| l.level == Level::Warn)
        .map(|l| l.fields.clone())
        .collect()
}

#[tokio::test]
async fn failed_fingerprint_keeps_context() {
    let c = sync_catalog(AiSyncMode::Automatic);
    c.ensure_at(Purpose::Ask, T0).await;
    let before = c
        .store
        .context_cards(&c.key(), &["orders".into(), "customers".into()])
        .unwrap();
    *c.fingerprint.lock().unwrap() = Err("permission denied for user app at db.internal".into());
    let (info, step, log) = c.ensure_at(Purpose::Ask, T0 + 3 * MIN).await;
    assert_eq!(info.check, SchemaCheck::Failed);
    assert_eq!(info.built_at, Some(T0));
    assert_eq!(info.table_count, 2);
    assert_eq!(
        c.store
            .context_cards(&c.key(), &["orders".into(), "customers".into()])
            .unwrap(),
        before
    );
    assert_eq!(
        warns(&log),
        [vec![("error".to_string(), "query".to_string())]]
    );
    let text = format!("{:?}", log.lines);
    assert!(
        !text.contains("permission") && !text.contains("db.internal"),
        "{text}"
    );
    assert_eq!(step.value, "could not check, synced 3m ago");
    assert_eq!(
        step.rule,
        "Could not check the schema. The context from 3m ago was used."
    );
}

#[tokio::test]
async fn failed_rebuild_keeps_context() {
    let c = sync_catalog(AiSyncMode::Automatic);
    c.ensure_at(Purpose::Ask, T0).await;
    *c.fingerprint.lock().unwrap() = Ok("pg:2".into());
    *c.model.lock().unwrap() = Err("connection reset by 10.0.0.5".into());
    let (info, _, log) = c.ensure_at(Purpose::Ask, T0 + 2 * MIN).await;
    assert_eq!(info.check, SchemaCheck::Failed);
    assert_eq!(info.built_at, Some(T0));
    assert_eq!(c.cards(), ["customers", "orders"]);
    let meta = c.store.context_meta(&c.key()).unwrap().unwrap();
    assert_eq!(meta.fingerprint.as_deref(), Some("pg:1"));
    assert_eq!(
        warns(&log),
        [vec![("error".to_string(), "query".to_string())]]
    );

    let (info, _, _) = c.ensure_at(Purpose::Resync, T0 + 3 * MIN).await;
    assert_eq!(info.check, SchemaCheck::Failed);
    assert_eq!(c.cards(), ["customers", "orders"]);

    // With no Context to keep, a failed first build sends no tables.
    let none = sync_catalog(AiSyncMode::Automatic);
    *none.model.lock().unwrap() = Err("x".into());
    let (info, step, _) = none.ensure_at(Purpose::Preview, T0).await;
    assert_eq!(info.check, SchemaCheck::Missing);
    assert_eq!(info.built_at, None);
    assert_eq!(step.value, "could not read");
    assert_eq!(
        step.rule,
        "The schema could not be read, so no tables are sent."
    );
    assert!(none.store.context_list(None).unwrap().is_empty());
}

fn field_of(log: &Log, key: &str) -> Vec<String> {
    log.lines
        .iter()
        .filter(|l| l.source == "schema")
        .filter_map(|l| {
            l.fields
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
        })
        .collect()
}

#[tokio::test]
async fn preview_first_build_reads_no_fingerprint() {
    let c = sync_catalog(AiSyncMode::Automatic);
    let (info, _, log) = c.ensure_at(Purpose::Preview, T0).await;
    assert_eq!(info.check, rebuilt(RebuildReason::First));
    assert_eq!(c.reads(), (1, 0));
    assert_eq!(field_of(&log, "fingerprint"), ["skipped"]);
    let meta = c.store.context_meta(&c.key()).unwrap().unwrap();
    assert_eq!(meta.fingerprint, None);
    // The next Ask within the minute uses it; after the minute it checks once, and the
    // fingerprint it reads becomes the Context's, with no second build.
    c.reset();
    let (info, _, _) = c.ensure_at(Purpose::Ask, T0 + 10_000).await;
    assert_eq!((info.check, c.reads()), (SchemaCheck::Recent, (0, 0)));
    let (info, _, log) = c.ensure_at(Purpose::Ask, T0 + 61_000).await;
    assert_eq!(info.check, SchemaCheck::Match);
    assert_eq!(c.reads(), (0, 1));
    assert_eq!(field_of(&log, "fingerprint"), ["read"]);
    let meta = c.store.context_meta(&c.key()).unwrap().unwrap();
    assert_eq!(meta.fingerprint.as_deref(), Some("pg:1"));
}

#[tokio::test]
async fn a_build_logs_the_fingerprint_it_read() {
    let c = sync_catalog(AiSyncMode::Automatic);
    let (_, _, log) = c.ensure_at(Purpose::Ask, T0).await;
    assert_eq!(field_of(&log, "fingerprint"), ["read"]);
    let (_, _, log) = c.ensure_at(Purpose::Resync, T0 + 1_000).await;
    assert_eq!(field_of(&log, "fingerprint"), ["read"]);
    // A fingerprint that fails inside a build says so.
    let f = sync_catalog(AiSyncMode::Automatic);
    *f.fingerprint.lock().unwrap() = Err("x".into());
    let (info, _, log) = f.ensure_at(Purpose::Ask, T0).await;
    assert_eq!(info.check, SchemaCheck::Missing);
    assert_eq!(field_of(&log, "fingerprint"), ["failed"]);
    // Manual reads none.
    let m = sync_catalog(AiSyncMode::Manual);
    let (_, _, log) = m.ensure_at(Purpose::Ask, T0).await;
    assert_eq!(field_of(&log, "fingerprint"), ["skipped"]);
}

#[tokio::test]
async fn two_asks_at_once_check_once() {
    let c = sync_catalog(AiSyncMode::Automatic);
    c.ensure_at(Purpose::Ask, T0).await;
    c.reset();
    let (a, b) = tokio::join!(
        c.ensure_at(Purpose::Ask, T0 + 2 * MIN),
        c.ensure_at(Purpose::Ask, T0 + 2 * MIN)
    );
    assert_eq!(c.reads(), (0, 1));
    let mut checks = [a.0.check, b.0.check];
    checks.sort_by_key(|c| format!("{c:?}"));
    assert_eq!(checks, [SchemaCheck::Match, SchemaCheck::Recent]);

    // Two Asks on a stale Context rebuild once.
    c.reset();
    c.store.mark_stale(c.key().connection_id).unwrap();
    let (a, b) = tokio::join!(
        c.ensure_at(Purpose::Ask, T0 + 3 * MIN),
        c.ensure_at(Purpose::Ask, T0 + 3 * MIN)
    );
    assert_eq!(c.reads(), (1, 1));
    let rebuilds = [a.0.check, b.0.check]
        .iter()
        .filter(|c| matches!(c, SchemaCheck::Rebuilt { .. }))
        .count();
    assert_eq!(rebuilds, 1);

    // Two first Asks build once.
    let n = sync_catalog(AiSyncMode::Automatic);
    let _ = tokio::join!(n.ensure_at(Purpose::Ask, T0), n.ensure_at(Purpose::Ask, T0));
    assert_eq!(n.reads(), (1, 1));
}

#[tokio::test]
async fn failed_check_backs_off_a_minute() {
    let c = sync_catalog(AiSyncMode::Automatic);
    c.ensure_at(Purpose::Ask, T0).await;
    c.reset();
    *c.fingerprint.lock().unwrap() = Err("denied".into());
    let at = T0 + 3 * MIN;
    let (info, _, _) = c.ensure_at(Purpose::Ask, at).await;
    assert_eq!((info.check, c.reads()), (SchemaCheck::Failed, (0, 1)));
    // Within the minute: no query, the last Context with the failed wording.
    let (info, step, log) = c.ensure_at(Purpose::Ask, at + 10_000).await;
    assert_eq!((info.check, c.reads()), (SchemaCheck::Failed, (0, 1)));
    assert_eq!(info.built_at, Some(T0));
    assert_eq!(step.value, "could not check, synced 3m ago");
    assert_eq!(field_of(&log, "fingerprint"), ["skipped"]);
    // A minute later it tries again, and a success ends the back-off.
    *c.fingerprint.lock().unwrap() = Ok("pg:1".into());
    let (info, _, _) = c.ensure_at(Purpose::Ask, at + 60_000).await;
    assert_eq!((info.check, c.reads()), (SchemaCheck::Match, (0, 2)));

    // A failed first build backs the Ask off; the preview may still build once (with no
    // fingerprint), then its own failure backs it off too. Re-sync still tries.
    let n = sync_catalog(AiSyncMode::Automatic);
    *n.model.lock().unwrap() = Err("down".into());
    let (info, _, _) = n.ensure_at(Purpose::Ask, T0).await;
    assert_eq!((info.check, n.reads()), (SchemaCheck::Missing, (1, 1)));
    let (info, _, _) = n.ensure_at(Purpose::Ask, T0 + 5_000).await;
    assert_eq!((info.check, n.reads()), (SchemaCheck::Missing, (1, 1)));
    let (info, _, _) = n.ensure_at(Purpose::Preview, T0 + 6_000).await;
    assert_eq!((info.check, n.reads()), (SchemaCheck::Missing, (2, 1)));
    let (info, _, _) = n.ensure_at(Purpose::Preview, T0 + 6_500).await;
    assert_eq!((info.check, n.reads()), (SchemaCheck::Missing, (2, 1)));
    let (info, _, _) = n.ensure_at(Purpose::Ask, T0 + 6_800).await;
    assert_eq!((info.check, n.reads()), (SchemaCheck::Missing, (2, 1)));
    *n.model.lock().unwrap() = Ok(model(&["orders"]));
    let (info, _, _) = n.ensure_at(Purpose::Resync, T0 + 7_000).await;
    assert_eq!(info.check, rebuilt(RebuildReason::Asked));
}

#[tokio::test]
async fn checked_in_the_future_is_not_recent() {
    let c = sync_catalog(AiSyncMode::Automatic);
    c.ensure_at(Purpose::Ask, T0).await;
    c.reset();
    // The clock moved back five minutes.
    let (info, _, _) = c.ensure_at(Purpose::Ask, T0 - 5 * MIN).await;
    assert_eq!((info.check, c.reads()), (SchemaCheck::Match, (0, 1)));
}

#[tokio::test]
async fn store_read_error_runs_no_query() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.sqlite");
    for sync in [AiSyncMode::Manual, AiSyncMode::Automatic] {
        let c = sync_catalog_on(sync, AppStore::open(&path).unwrap());
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch("DROP TABLE IF EXISTS ai_context_meta")
            .unwrap();
        let (info, step, log) = c.ensure_at(Purpose::Ask, T0).await;
        assert_eq!(c.reads(), (0, 0), "{sync:?}");
        assert_eq!(info.check, SchemaCheck::Failed);
        assert_eq!(info.built_at, None);
        assert_eq!(step.value, "could not check");
        assert_eq!(warns(&log).len(), 1);
    }
}

#[tokio::test]
async fn never_during_build_writes_nothing() {
    let c = sync_catalog(AiSyncMode::Automatic);
    c.never_on_snapshot.store(true, Ordering::SeqCst);
    let (info, _, _) = c.ensure_at(Purpose::Ask, T0).await;
    assert_eq!(info.check, SchemaCheck::Missing);
    assert!(c.store.context_list(None).unwrap().is_empty());
}

#[tokio::test]
async fn service_write_rechecks_access() {
    let f = fixture().await;
    let k = key(f.id, "main");
    let built = BuiltContext::default();
    let config = f.svc.list().unwrap().remove(0);
    assert!(
        f.svc
            .replace_if_allowed(&k, &built, None, 1, &config)
            .unwrap()
            .is_some()
    );
    // Re-pointed while it built: the old file's schema is not written for the new one.
    let mut before = config.clone();
    before.file = Some(f.dir.path().join("old.db"));
    assert!(
        f.svc
            .replace_if_allowed(&k, &built, None, 1, &before)
            .unwrap()
            .is_none()
    );
    let mut renamed = config.clone();
    renamed.name = "renamed".into();
    assert!(
        f.svc
            .replace_if_allowed(&k, &built, None, 1, &renamed)
            .unwrap()
            .is_some()
    );
    // A clear at Never lands between the build and the write: the write is dropped.
    f.svc.set_ai_access(f.id, AiAccess::Never).await.unwrap();
    assert!(
        f.svc
            .replace_if_allowed(&k, &built, None, 2, &config)
            .unwrap()
            .is_none()
    );
    assert_eq!(f.contexts(), 0);
    f.svc.set_ai_access(f.id, AiAccess::Schema).await.unwrap();
    f.svc.delete(f.id).await.unwrap();
    assert!(
        f.svc
            .replace_if_allowed(&k, &built, None, 3, &config)
            .unwrap()
            .is_none()
    );
    assert!(f.svc.context_list(None).unwrap().is_empty());
}

#[tokio::test]
async fn ensure_over_the_service() {
    let f = fixture().await;
    f.svc.open(f.id).await.unwrap();
    let config = f.svc.list().unwrap().remove(0);
    let k = contura_core::ai::context::sync::context_key(&config, None, None, &[]);
    let mut log = Log::new();
    let (info, _) = ensure(&*f.svc, &config, &k, Purpose::Ask, &keep, T0, &mut log).await;
    assert_eq!(info.check, rebuilt(RebuildReason::First));
    assert_eq!(info.table_count, 2);
    let meta = f.svc.context_meta(&k).unwrap().unwrap();
    assert!(meta.fingerprint.unwrap().starts_with("sqlite:"));
    let (info, _) = ensure(
        &*f.svc,
        &config,
        &k,
        Purpose::Ask,
        &keep,
        T0 + 2 * MIN,
        &mut log,
    )
    .await;
    assert_eq!(info.check, SchemaCheck::Match);
}

#[test]
fn schema_steps_wording() {
    let now = T0 + 3 * MIN;
    let w = |check, purpose| schema_wording(check, purpose, Some(T0), Some(now - 20_000), 12, now);
    let pair = |a: &str, b: &str| (a.to_string(), b.to_string());
    assert_eq!(
        w(SchemaCheck::Match, Purpose::Ask),
        pair(
            "match, synced 3m ago",
            "The catalog fingerprint equals the one stored with the AI Context, so no re-sync ran."
        )
    );
    assert_eq!(
        w(SchemaCheck::Recent, Purpose::Ask),
        pair(
            "checked just now, synced 3m ago",
            "The schema was checked less than a minute ago, so no query ran."
        )
    );
    let reasons = [
        (
            RebuildReason::First,
            "First Ask on this database: the AI Context was built from the catalog. No rows are read.",
        ),
        (
            RebuildReason::Changed,
            "The catalog fingerprint changed, so the AI Context was rebuilt. No rows are read.",
        ),
        (
            RebuildReason::Stale,
            "Contura changed the schema here, so the AI Context was rebuilt. No rows are read.",
        ),
        (
            RebuildReason::Asked,
            "Re-sync rebuilt the AI Context. No rows are read.",
        ),
    ];
    for (reason, rule) in reasons {
        assert_eq!(
            w(rebuilt(reason), Purpose::Ask),
            pair("re-synced, 12 tables", rule)
        );
    }
    assert_eq!(
        schema_wording(
            rebuilt(RebuildReason::First),
            Purpose::Ask,
            Some(T0),
            Some(T0),
            1,
            T0
        )
        .0,
        "re-synced, 1 table"
    );
    assert_eq!(
        schema_wording(
            rebuilt(RebuildReason::First),
            Purpose::Ask,
            Some(T0),
            Some(T0),
            1_200,
            T0
        )
        .0,
        "re-synced, 1,200 tables"
    );
    assert_eq!(
        w(SchemaCheck::Stale, Purpose::Ask),
        pair(
            "stale, synced 3m ago",
            "The schema changed since the last sync. The context from then was used."
        )
    );
    assert_eq!(
        w(SchemaCheck::Unchecked, Purpose::Ask),
        pair(
            "not checked, synced 3m ago",
            "Sync is set to Manual, so the schema was not checked."
        )
    );
    assert_eq!(
        w(SchemaCheck::Unchecked, Purpose::Preview),
        pair(
            "not checked, synced 3m ago",
            "The preview never checks the schema."
        )
    );
    assert_eq!(
        w(SchemaCheck::Failed, Purpose::Ask),
        pair(
            "could not check, synced 3m ago",
            "Could not check the schema. The context from 3m ago was used."
        )
    );
    assert_eq!(
        schema_wording(SchemaCheck::Missing, Purpose::Ask, None, None, 0, now),
        pair(
            "could not read",
            "The schema could not be read, so no tables are sent."
        )
    );
    for (text, _) in [
        w(SchemaCheck::Match, Purpose::Ask),
        w(SchemaCheck::Failed, Purpose::Ask),
    ] {
        assert!(!text.contains('\u{2014}') && !text.contains('\u{2013}'));
    }
}

#[tokio::test]
async fn omitted_sync_mode_keeps_the_stored_one() {
    let f = fixture().await;
    f.svc.set_ai_sync_mode(f.id, AiSyncMode::Manual).unwrap();
    let saved = f.svc.save(input(&f.file, Some(f.id), false)).await.unwrap();
    assert_eq!(saved.ai_sync, AiSyncMode::Manual);
    assert_eq!(f.svc.list().unwrap()[0].ai_sync, AiSyncMode::Manual);
    let mut set = input(&f.file, Some(f.id), false);
    set.ai_sync = Some(AiSyncMode::Automatic);
    assert_eq!(
        f.svc.save(set).await.unwrap().ai_sync,
        AiSyncMode::Automatic
    );
    // A new Connection with none is Automatically.
    let fresh = f.svc.save(input(&f.file, None, false)).await.unwrap();
    assert_eq!(fresh.ai_sync, AiSyncMode::Automatic);
    // The UI may leave the field out of the JSON.
    let read: ConnectionInput = serde_json::from_value(serde_json::json!({
        "id": null, "name": "shop", "dialect": "sqlite", "host": "", "port": 0, "user": "",
        "database": null, "ssl": { "mode": "disable" }, "password": { "t": "keep" },
        "groupId": null
    }))
    .unwrap();
    assert_eq!(read.ai_sync, None);
}

#[tokio::test]
async fn repointing_clears_context() {
    let f = fixture().await;
    f.seed().await;
    // A save that changes only the name keeps the Context.
    let mut renamed = input(&f.file, Some(f.id), false);
    renamed.name = "shop 2".into();
    f.svc.save(renamed).await.unwrap();
    assert_eq!(f.contexts(), 2);
    let other = f.dir.path().join("other.db");
    drop(rusqlite::Connection::open(&other).unwrap());
    f.svc.save(input(&other, Some(f.id), false)).await.unwrap();
    assert_eq!(f.contexts(), 0);
}

// ---- Areas: stored with the Context, backfilled for older ones ----

fn fk_model(tables: &[&str], refs: &[(&str, &str)]) -> SchemaModel {
    use contura_core::schema_model::{SmEndpoint, SmRef};
    let end = |table: &str, column: &str| SmEndpoint {
        schema: Some("public".into()),
        table: table.into(),
        columns: vec![column.into()],
    };
    let mut m = model(tables);
    m.refs = refs
        .iter()
        .map(|(from, to)| SmRef {
            name: None,
            from: end(from, "x_id"),
            to: end(to, "id"),
            on_delete: None,
            on_update: None,
        })
        .collect();
    m
}

#[tokio::test]
async fn old_context_backfills_areas_without_a_query() {
    use contura_core::ai::context::tree::areas_for;
    let c = sync_catalog(AiSyncMode::Manual);
    let m = fk_model(
        &["orders", "customers", "order_items"],
        &[("orders", "customers"), ("order_items", "orders")],
    );
    let mut built = build_context(&m, DialectKind::Postgres, "public", &[], &keep);
    // As 11c wrote it: no Area nodes.
    built.areas = vec![];
    c.store.replace_context(&c.key(), &built, None, T0).unwrap();
    assert!(c.store.context_areas(&c.key()).unwrap().is_empty());
    c.reset();

    // An Ask in Manual reads nothing, and the Areas come from the stored graph.
    c.ensure_at(Purpose::Ask, T0 + 5 * MIN).await;
    let areas = areas_for(&c.store, &c.key()).unwrap();
    assert_eq!(areas.len(), 1);
    assert_eq!(areas[0].tables.len(), 3);
    assert_eq!(c.reads(), (0, 0));
    assert_eq!(c.store.context_areas(&c.key()).unwrap(), areas);
    // Stored: the second call reads them back, and they are the ones a build makes.
    assert_eq!(areas_for(&c.store, &c.key()).unwrap(), areas);
    let fresh = build_context(&m, DialectKind::Postgres, "public", &[], &keep);
    assert_eq!(fresh.areas, areas);
    assert_eq!(c.reads(), (0, 0));
}

#[tokio::test]
async fn rebuild_keeps_areas_in_step() {
    let c = sync_catalog(AiSyncMode::Automatic);
    *c.model.lock().unwrap() = Ok(fk_model(
        &["orders", "customers", "refunds"],
        &[("orders", "customers")],
    ));
    c.ensure_at(Purpose::Ask, T0).await;
    let together = |c: &SyncCatalog, a: &str, b: &str| {
        c.store
            .context_areas(&c.key())
            .unwrap()
            .iter()
            .any(|x| x.tables.iter().any(|t| t == a) && x.tables.iter().any(|t| t == b))
    };
    assert!(together(&c, "orders", "customers"));
    assert!(!together(&c, "orders", "refunds"));

    *c.fingerprint.lock().unwrap() = Ok("pg:2".into());
    *c.model.lock().unwrap() = Ok(fk_model(
        &["orders", "customers", "refunds"],
        &[("orders", "customers"), ("refunds", "orders")],
    ));
    let (info, _, _) = c.ensure_at(Purpose::Ask, T0 + 2 * MIN).await;
    assert_eq!(info.check, rebuilt(RebuildReason::Changed));
    assert!(together(&c, "orders", "refunds"));
    assert_eq!(c.store.context_areas(&c.key()).unwrap().len(), 1);
}
