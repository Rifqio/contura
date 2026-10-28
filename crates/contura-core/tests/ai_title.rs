//! Titles written by the AI (Decision 5): one short call after a chat's first answer, retried
//! once on the next answer, never over a title the user wrote, gated by each Connection's
//! own AI access, and never holding the place for the next Ask.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use contura_core::ai::context::store::{ContextStore, StoreContext};
use contura_core::ai::log::Log;
use contura_core::ai::memory::store::{StoreThreads, set_thread_title};
use contura_core::ai::memory::{AskedIn, ThreadStore, TitleBy};
use contura_core::ai::models::{ModelInfo, info_for};
use contura_core::ai::preview::CatalogReader;
use contura_core::ai::provider::scripted::ScriptedProvider;
use contura_core::ai::provider::{
    AiProvider, ChatRequest, ListedModel, ProviderEvent, StopReason, Usage,
};
use contura_core::ai::rails::Secrets;
use contura_core::ai::request::ItemKind;
use contura_core::ai::sent::{AnswerRecord, CallKind, SentRecord};
use contura_core::ai::title::{NameChatRequest, name_chat, title_place};
use contura_core::ai::{
    AiAccess, AiError, AiMessage, AiProviderKind, AiRole, AiService, AiSettings, AiThread,
};
use contura_core::model::{
    Cell, ColumnInfo, ConnectionConfig, ConnectionId, DialectKind, ObjectPath, Page, SslMode,
};
use contura_core::schema_model::{SchemaModel, SmColumn, SmTable};
use contura_core::secrets::MemorySecretStore;
use contura_core::store::AppStore;
use contura_core::{Error, Result};
use uuid::Uuid;

const A: u128 = 42;
const B: u128 = 43;
const PLACE: &str = "ungrouped";
const TITLE: &str = "Unpaid clients to date";

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn id(n: u128) -> ConnectionId {
    Uuid::from_u128(n)
}

fn conn(n: u128, access: AiAccess) -> ConnectionConfig {
    ConnectionConfig {
        id: id(n),
        name: format!("Conn {n}"),
        dialect: DialectKind::Postgres,
        host: "db.internal".into(),
        port: 5432,
        user: "app".into(),
        database: Some("shop".into()),
        ssl: SslMode::Disable,
        group_id: None,
        file: None,
        query_timeout_secs: None,
        ai_access: access,
        ai_sync: Default::default(),
        production: false,
        read_only: false,
    }
}

struct Catalog {
    configs: Vec<ConnectionConfig>,
    context: StoreContext,
    threads: StoreThreads,
    reads: std::sync::atomic::AtomicUsize,
}

#[async_trait]
impl CatalogReader for Catalog {
    async fn sample_rows(&self, _: ConnectionId, _: &ObjectPath, _: u32) -> Result<Page> {
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(Page {
            columns: vec![ColumnInfo {
                name: "note".into(),
                type_name: "text".into(),
                is_primary_key: false,
            }],
            rows: vec![vec![Cell::Text {
                value: "zq-cell-7731".into(),
                truncated: false,
                total_bytes: 12,
            }]],
            has_more: false,
        })
    }

    async fn connection_config(&self, id: ConnectionId) -> Result<Option<ConnectionConfig>> {
        Ok(self.configs.iter().find(|c| c.id == id).cloned())
    }

    async fn schema_snapshot(
        &self,
        _: ConnectionId,
        _: &str,
        _: Option<&str>,
    ) -> Result<SchemaModel> {
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(SchemaModel {
            dialect: DialectKind::Postgres,
            tables: vec![SmTable {
                schema: Some("public".into()),
                name: "invoices".into(),
                alias: None,
                note: None,
                columns: vec![SmColumn {
                    name: "zq_amount_col".into(),
                    type_name: "int".into(),
                    pk: false,
                    increment: false,
                    not_null: false,
                    unique: false,
                    default: None,
                    note: None,
                }],
                indexes: Vec::new(),
            }],
            refs: Vec::new(),
            enums: Vec::new(),
            skipped: Vec::new(),
        })
    }

    async fn schema_fingerprint(
        &self,
        _: ConnectionId,
        _: &str,
        _: Option<&str>,
    ) -> Result<String> {
        Ok("fp:1".into())
    }

    fn context(&self) -> &dyn ContextStore {
        &self.context
    }

    fn threads(&self) -> &dyn ThreadStore {
        &self.threads
    }
}

struct Env {
    dir: tempfile::TempDir,
    cat: Arc<Catalog>,
    svc: AiService,
}

impl Env {
    fn path(&self) -> std::path::PathBuf {
        self.dir.path().join("app.sqlite")
    }

    fn stored(&self, t: Uuid) -> AiThread {
        self.cat.threads.thread(t).unwrap().unwrap()
    }
}

fn env(configs: Vec<ConnectionConfig>) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.sqlite");
    let cat = Catalog {
        configs,
        context: StoreContext::new(AppStore::open(std::path::Path::new(":memory:")).unwrap()),
        threads: StoreThreads::new(AppStore::open(&path).unwrap()),
        reads: std::sync::atomic::AtomicUsize::new(0),
    };
    let svc = AiService::new(
        AppStore::open(&path).unwrap(),
        Arc::new(MemorySecretStore::new()),
    );
    Env {
        dir,
        cat: Arc::new(cat),
        svc,
    }
}

fn settings() -> AiSettings {
    AiSettings {
        provider: Some(AiProviderKind::Groq),
        model: "llama-3.3-70b-versatile".into(),
        keep_exact_text: true,
        ..AiSettings::default()
    }
}

fn model() -> ModelInfo {
    let s = settings();
    info_for(AiProviderKind::Groq, None, &s.model, None, &s)
}

fn message(role: AiRole, text: &str, at: i64, on: Option<u128>) -> AiMessage {
    AiMessage {
        role,
        text: text.into(),
        context: Vec::new(),
        at,
        record: (role == AiRole::Assistant).then(|| AnswerRecord {
            sent: Some(SentRecord {
                bytes: 900,
                ..SentRecord::default()
            }),
            ..AnswerRecord::default()
        }),
        topic: Some(1),
        connection_id: on.map(id),
        database: on.map(|_| "shop".into()),
        kinds: if on.is_some() {
            vec![ItemKind::Question, ItemKind::Names, ItemKind::Cards]
        } else {
            vec![ItemKind::Question]
        },
        tables: Vec::new(),
        action: Some("ask".into()),
        asked_in: None,
    }
}

/// `n` turns on `on` (Home with `None`), a minute apart.
fn turns(n: usize, at: i64, on: Option<u128>) -> Vec<AiMessage> {
    (0..n)
        .flat_map(|i| {
            let t = at + i as i64 * 60_000;
            [
                message(AiRole::User, "Which clients have not paid yet?", t, on),
                message(
                    AiRole::Assistant,
                    "Join invoices to payments and keep the rows with no payment.",
                    t + 1_000,
                    on,
                ),
            ]
        })
        .collect()
}

fn save(e: &Env, messages: Vec<AiMessage>) -> AiThread {
    let t = AiThread {
        id: Uuid::new_v4(),
        place: PLACE.into(),
        title: "Which clients have not paid yet?".into(),
        messages,
        updated_at: 1_000,
        title_by: TitleBy::Rule,
        title_tries: 0,
        last_work: None,
    };
    e.cat.threads.save_thread(&t).unwrap();
    t
}

/// Adds one more turn to the stored thread, as the next Ask's save does.
fn one_more_turn(e: &Env, t: Uuid, on: Option<u128>) {
    let mut stored = e.stored(t);
    let at = stored.messages.last().unwrap().at + 60_000;
    stored.messages.extend(turns(1, at, on));
    e.cat.threads.save_thread(&stored).unwrap();
}

fn reply(text: &str) -> Vec<std::result::Result<ProviderEvent, AiError>> {
    vec![
        Ok(ProviderEvent::FirstByte),
        Ok(ProviderEvent::Text(text.into())),
        Ok(ProviderEvent::Usage(Usage {
            input: 300,
            output: 6,
            cache_read: 0,
            cache_write: 0,
        })),
        Ok(ProviderEvent::Stop(StopReason::End)),
    ]
}

fn server_error() -> Vec<std::result::Result<ProviderEvent, AiError>> {
    vec![
        Ok(ProviderEvent::FirstByte),
        Err(AiError::Provider {
            status: 500,
            message: "Internal error".into(),
        }),
    ]
}

fn request(t: Uuid) -> NameChatRequest {
    NameChatRequest {
        request_id: "title-1".into(),
        place: PLACE.into(),
        group_id: None,
        thread_id: t,
        model: None,
        off: Vec::new(),
    }
}

async fn name(
    e: &Env,
    p: &dyn AiProvider,
    s: &AiSettings,
    req: &NameChatRequest,
) -> Result<Option<String>> {
    let mut log = Log::new();
    name_chat(p, &*e.cat, s, &model(), &Secrets::default(), req, &mut log).await
}

fn calls(p: &ScriptedProvider) -> Vec<ChatRequest> {
    p.seen.lock().unwrap().clone()
}

fn all_text(chat: &ChatRequest) -> String {
    let mut out: Vec<&str> = chat.system.iter().map(|b| b.text.as_str()).collect();
    out.extend(chat.messages.iter().map(|m| m.text.as_str()));
    out.join("\n")
}

fn first_answer(t: &AiThread) -> &AiMessage {
    t.messages
        .iter()
        .find(|m| m.role == AiRole::Assistant)
        .unwrap()
}

#[tokio::test]
async fn the_first_answer_names_the_chat() {
    let e = env(vec![conn(A, AiAccess::Schema)]);
    let t = save(&e, turns(1, now(), Some(A)));
    let p = ScriptedProvider::new(reply("\"Unpaid clients to date.\""));
    let named = name(&e, &p, &settings(), &request(t.id)).await.unwrap();
    assert_eq!(named.as_deref(), Some(TITLE));
    assert_eq!(calls(&p).len(), 1, "one call");
    let stored = e.stored(t.id);
    assert_eq!(stored.title, TITLE);
    assert_eq!(stored.title_by, TitleBy::Ai);
    assert_eq!(stored.updated_at, 1_000, "the list keeps its order");
    assert_eq!(stored.title_tries, 0);
    // The list reads the columns: they took it too.
    let row = e.svc.list_threads(PLACE).unwrap();
    assert_eq!(row[0].title, TITLE);
    let json = serde_json::to_value(&row[0]).unwrap();
    assert_eq!(json["titleBy"], "ai");
    // Logged in the answer's record, as its own call.
    let record = first_answer(&stored).record.as_ref().unwrap();
    let sent = record.sent.as_ref().unwrap();
    assert_eq!(sent.bytes, 900, "the Ask's own record stays");
    let title = sent.title.as_ref().unwrap();
    assert_eq!(title.kind, CallKind::Title);
    assert_eq!(title.messages, 2);
    assert!(title.bytes > 0 && title.tokens > 0);
    assert!(title.exact.is_some(), "kept with Keep the exact text on");
    let line = record
        .log
        .iter()
        .find(|l| l.source == "title")
        .expect("a title log line");
    assert!(
        line.fields
            .contains(&("sends".into(), "question_and_answer_only".into()))
    );
    assert!(line.fields.contains(&("model".into(), model().id)));
    // The request: 24 tokens, no tools, the first question.
    let chat = &calls(&p)[0];
    assert_eq!(chat.max_tokens, 24);
    assert!(chat.tools.is_none());
    assert!(all_text(chat).contains("Which clients have not paid yet?"));
}

#[tokio::test]
async fn a_failed_title_is_tried_once_more_then_never() {
    let e = env(vec![conn(A, AiAccess::Schema)]);
    let t = save(&e, turns(1, now(), Some(A)));
    let p = ScriptedProvider::new(server_error());
    assert_eq!(
        name(&e, &p, &settings(), &request(t.id)).await.unwrap(),
        None
    );
    let stored = e.stored(t.id);
    assert_eq!(stored.title_tries, 1);
    assert_eq!(stored.title_by, TitleBy::Rule);
    assert_eq!(stored.title, "Which clients have not paid yet?");
    assert_eq!(stored.updated_at, 1_000);
    let record = first_answer(&stored).record.as_ref().unwrap();
    assert!(
        record
            .log
            .iter()
            .any(|l| l.source == "title" && l.fields.iter().any(|(k, _)| k == "error")),
        "{:?}",
        record.log
    );
    assert!(
        record.sent.as_ref().unwrap().title.is_some(),
        "it left this PC"
    );

    // The next answer tries once more.
    one_more_turn(&e, t.id, Some(A));
    assert_eq!(
        name(&e, &p, &settings(), &request(t.id)).await.unwrap(),
        None
    );
    assert_eq!(calls(&p).len(), 2);
    assert_eq!(e.stored(t.id).title_tries, 2);

    // Never a third call, even with a provider that would answer.
    one_more_turn(&e, t.id, Some(A));
    let good = ScriptedProvider::new(reply(TITLE));
    assert_eq!(
        name(&e, &good, &settings(), &request(t.id)).await.unwrap(),
        None
    );
    assert!(calls(&good).is_empty());
    assert_eq!(e.stored(t.id).title_tries, 2);

    // A reply with no title left in it counts as a failure too.
    let t2 = save(&e, turns(1, now(), Some(A)));
    let junk = ScriptedProvider::new(reply("\"\" ."));
    assert_eq!(
        name(&e, &junk, &settings(), &request(t2.id)).await.unwrap(),
        None
    );
    assert_eq!(e.stored(t2.id).title_tries, 1);
    assert_eq!(e.stored(t2.id).title_by, TitleBy::Rule);
}

/// P34: a call stopped while it runs counts no try.
#[tokio::test]
async fn a_cancelled_title_counts_no_try() {
    let e = env(vec![conn(A, AiAccess::Schema)]);
    let t = save(&e, turns(1, now(), Some(A)));
    let p = ScriptedProvider::new(vec![Err(AiError::Cancelled)]);
    assert!(name(&e, &p, &settings(), &request(t.id)).await.is_err());
    assert_eq!(e.stored(t.id).title_tries, 0);
}

/// P10: a chat saved before D2, already past its first answers, is never named.
#[tokio::test]
async fn an_older_chat_is_not_named() {
    let e = env(vec![conn(A, AiAccess::Schema)]);
    let t = save(&e, turns(3, now(), Some(A)));
    let p = ScriptedProvider::new(reply(TITLE));
    assert_eq!(
        name(&e, &p, &settings(), &request(t.id)).await.unwrap(),
        None
    );
    assert!(calls(&p).is_empty());
    let stored = e.stored(t.id);
    assert_eq!(stored.title_tries, 0);
    assert_eq!(stored.title_by, TitleBy::Rule);
}

/// A provider that lets `during` run while its call is out, then answers `TITLE`.
struct During<F: Fn() + Send + Sync> {
    during: F,
}

#[async_trait]
impl<F: Fn() + Send + Sync> AiProvider for During<F> {
    async fn stream(
        &self,
        _req: &ChatRequest,
        _log: &mut Log,
        sink: &mut (dyn FnMut(ProviderEvent) + Send),
    ) -> Result<()> {
        sink(ProviderEvent::FirstByte);
        (self.during)();
        sink(ProviderEvent::Text(TITLE.into()));
        sink(ProviderEvent::Stop(StopReason::End));
        Ok(())
    }

    async fn models(&self, _log: &mut Log) -> Result<Vec<ListedModel>> {
        Ok(Vec::new())
    }
}

#[tokio::test]
async fn an_ai_title_never_replaces_a_user_title() {
    let e = env(vec![conn(A, AiAccess::Schema)]);
    // Renamed before the call: no call at all.
    let t = save(&e, turns(1, now(), Some(A)));
    e.svc.rename_thread(t.id, "Mine").unwrap();
    let p = ScriptedProvider::new(reply(TITLE));
    assert_eq!(
        name(&e, &p, &settings(), &request(t.id)).await.unwrap(),
        None
    );
    assert!(calls(&p).is_empty());
    assert_eq!(e.stored(t.id).title, "Mine");

    // Renamed while the call is out: the AI title that lands after it is dropped.
    let t = save(&e, turns(1, now(), Some(A)));
    let path = e.path();
    let racing = During {
        during: move || {
            let db = rusqlite::Connection::open(&path).unwrap();
            assert!(set_thread_title(&db, t.id, "Mine too", TitleBy::User).unwrap());
        },
    };
    assert_eq!(
        name(&e, &racing, &settings(), &request(t.id))
            .await
            .unwrap(),
        None
    );
    let stored = e.stored(t.id);
    assert_eq!(stored.title, "Mine too");
    assert_eq!(stored.title_by, TitleBy::User);
    // Every chat here has the same `updated_at`: find the row by its id.
    let rows = e.svc.list_threads(PLACE).unwrap();
    let row = rows.iter().find(|r| r.id == t.id).unwrap();
    assert_eq!(row.title, "Mine too");

    // An AI title is never written again either.
    let t = save(&e, turns(1, now(), Some(A)));
    let db = rusqlite::Connection::open(e.path()).unwrap();
    assert!(set_thread_title(&db, t.id, "Old AI", TitleBy::Ai).unwrap());
    let p = ScriptedProvider::new(reply(TITLE));
    assert_eq!(
        name(&e, &p, &settings(), &request(t.id)).await.unwrap(),
        None
    );
    assert!(calls(&p).is_empty());
}

#[tokio::test]
async fn never_access_gets_no_call() {
    let e = env(vec![conn(A, AiAccess::Never)]);
    let t = save(&e, turns(1, now(), Some(A)));
    let p = ScriptedProvider::new(reply(TITLE));
    assert_eq!(
        name(&e, &p, &settings(), &request(t.id)).await.unwrap(),
        None
    );
    assert!(calls(&p).is_empty());
    assert_eq!(e.stored(t.id).title_tries, 0, "no try counted");
    // A deleted Connection is Never too.
    let gone = env(Vec::new());
    let t = save(&gone, turns(1, now(), Some(A)));
    assert_eq!(
        name(&gone, &p, &settings(), &request(t.id)).await.unwrap(),
        None
    );
    assert!(calls(&p).is_empty());
}

/// P9: the first question was asked across B; B is now at Never, so the chat gets no call.
#[tokio::test]
async fn a_lowered_also_connection_gets_no_call() {
    let across = |e: &Env| {
        let mut m = turns(1, now(), Some(A));
        for x in &mut m {
            x.kinds = vec![ItemKind::Question, ItemKind::Tab];
        }
        m[0].asked_in = Some(AskedIn {
            tab: "compare".into(),
            label: "Schema Compare".into(),
            also: vec![id(B)],
            ..AskedIn::default()
        });
        save(e, m)
    };
    let e = env(vec![
        conn(A, AiAccess::SchemaQuery),
        conn(B, AiAccess::Never),
    ]);
    let t = across(&e);
    let p = ScriptedProvider::new(reply(TITLE));
    assert_eq!(
        name(&e, &p, &settings(), &request(t.id)).await.unwrap(),
        None
    );
    assert!(calls(&p).is_empty());
    assert_eq!(e.stored(t.id).title_tries, 0);
    // With B allowing it, the same chat is named.
    let e = env(vec![
        conn(A, AiAccess::SchemaQuery),
        conn(B, AiAccess::Schema),
    ]);
    let t = across(&e);
    assert_eq!(
        name(&e, &p, &settings(), &request(t.id))
            .await
            .unwrap()
            .as_deref(),
        Some(TITLE)
    );
    assert_eq!(calls(&p).len(), 1);
}

#[tokio::test]
async fn the_setting_off_or_the_switch_off_makes_no_call() {
    let e = env(vec![conn(A, AiAccess::Schema)]);
    let t = save(&e, turns(1, now(), Some(A)));
    let p = ScriptedProvider::new(reply(TITLE));
    let off = AiSettings {
        name_chats: false,
        ..settings()
    };
    assert_eq!(name(&e, &p, &off, &request(t.id)).await.unwrap(), None);
    let switched = NameChatRequest {
        off: vec![ItemKind::Title],
        ..request(t.id)
    };
    assert_eq!(name(&e, &p, &settings(), &switched).await.unwrap(), None);
    assert!(calls(&p).is_empty());
    let stored = e.stored(t.id);
    assert_eq!(stored.title_tries, 0);
    assert_eq!(stored.title_by, TitleBy::Rule);
}

#[tokio::test]
async fn a_home_chat_is_named() {
    let e = env(Vec::new());
    let t = save(&e, turns(1, now(), None));
    let p = ScriptedProvider::new(reply(TITLE));
    assert_eq!(
        name(&e, &p, &settings(), &request(t.id))
            .await
            .unwrap()
            .as_deref(),
        Some(TITLE)
    );
    assert_eq!(e.stored(t.id).title_by, TitleBy::Ai);
}

/// A provider that holds its answer until told to go.
struct Held {
    out: tokio::sync::Notify,
    go: tokio::sync::Notify,
}

#[async_trait]
impl AiProvider for Held {
    async fn stream(
        &self,
        _req: &ChatRequest,
        _log: &mut Log,
        sink: &mut (dyn FnMut(ProviderEvent) + Send),
    ) -> Result<()> {
        sink(ProviderEvent::FirstByte);
        self.out.notify_one();
        self.go.notified().await;
        sink(ProviderEvent::Text(TITLE.into()));
        sink(ProviderEvent::Stop(StopReason::End));
        Ok(())
    }

    async fn models(&self, _log: &mut Log) -> Result<Vec<ListedModel>> {
        Ok(Vec::new())
    }
}

/// P2: the title call is registered as `title:<place>`, so an Ask in the same place starts
/// while it is held, and `cancel(request_id)` would stop it.
#[tokio::test]
async fn the_place_is_not_busy_while_naming() {
    let e = env(vec![conn(A, AiAccess::Schema)]);
    let t = save(&e, turns(1, now(), Some(A)));
    let held = Arc::new(Held {
        out: tokio::sync::Notify::new(),
        go: tokio::sync::Notify::new(),
    });
    let (p, cat, req) = (held.clone(), e.cat.clone(), request(t.id));
    let work = async move {
        let mut log = Log::new();
        name_chat(
            &*p,
            &*cat,
            &settings(),
            &model(),
            &Secrets::default(),
            &req,
            &mut log,
        )
        .await
    };
    assert_eq!(title_place(PLACE), "title:ungrouped");
    let key = title_place(PLACE);
    let naming = e.svc.run_registered(&key, "title-1", work);
    let asking = async {
        held.out.notified().await;
        let task = tokio::spawn(async {});
        let started = e.svc.start(PLACE, "ask-2", task.abort_handle());
        e.svc.finish("ask-2");
        // A second title call in the same place waits its turn: one at a time.
        let again = e.svc.start(
            &title_place(PLACE),
            "title-2",
            tokio::spawn(async {}).abort_handle(),
        );
        held.go.notify_one();
        (started, again)
    };
    // A hang fails fast instead of holding the build lock.
    let (named, (started, again)) =
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            tokio::join!(naming, asking)
        })
        .await
        .expect("the title call and the Ask both finish");
    assert!(started.is_ok(), "{started:?}");
    assert!(matches!(again, Err(Error::Ai(AiError::Busy))), "{again:?}");
    assert_eq!(named.unwrap().as_deref(), Some(TITLE));
}

/// P4: a webview save of its copy, which never holds the title call's record, keeps it.
#[tokio::test]
async fn a_save_keeps_the_title_call_record() {
    let e = env(vec![conn(A, AiAccess::Schema)]);
    let t = save(&e, turns(1, now(), Some(A)));
    let p = ScriptedProvider::new(reply(TITLE));
    name(&e, &p, &settings(), &request(t.id)).await.unwrap();
    // The open copy: the view (records trimmed) as it was before the title landed.
    let mut copy = e.svc.thread_view(t.id).unwrap().unwrap().thread;
    for m in &mut copy.messages {
        if let Some(s) = m.record.as_mut().and_then(|r| r.sent.as_mut()) {
            s.title = None;
        }
    }
    copy.title = "Which clients have not paid yet?".into();
    copy.title_by = TitleBy::Rule;
    e.svc.save_thread(&copy).unwrap();
    let stored = e.stored(t.id);
    assert_eq!(stored.title, TITLE);
    assert_eq!(stored.title_by, TitleBy::Ai);
    let record = first_answer(&stored).record.as_ref().unwrap();
    let title = record.sent.as_ref().unwrap().title.as_ref().unwrap();
    assert_eq!(title.kind, CallKind::Title);
    assert!(
        title.exact.is_some(),
        "its exact text comes back with the stored record"
    );
    assert!(record.log.iter().any(|l| l.source == "title"));
    // A whole (not trimmed) copy keeps them too.
    let mut whole = e.stored(t.id);
    for m in &mut whole.messages {
        if let Some(r) = m.record.as_mut() {
            r.log.clear();
            if let Some(s) = r.sent.as_mut() {
                s.title = None;
            }
        }
    }
    e.svc.save_thread(&whole).unwrap();
    let record = first_answer(&e.stored(t.id)).record.clone().unwrap();
    assert!(record.sent.unwrap().title.is_some());
    assert!(record.log.iter().any(|l| l.source == "title"));
}

/// The title call sends the first question and answer only: no table card, no column, no
/// row value of the thread's Connection, and nothing is read from it.
#[tokio::test]
async fn no_schema_or_rows_are_sent() {
    let e = env(vec![conn(A, AiAccess::SchemaQueryRows)]);
    let t = save(&e, turns(1, now(), Some(A)));
    let p = ScriptedProvider::new(reply(TITLE));
    name(&e, &p, &settings(), &request(t.id)).await.unwrap();
    let text = all_text(&calls(&p)[0]);
    assert!(!text.contains("zq-cell-7731"), "{text}");
    assert!(!text.contains("zq_amount_col"), "{text}");
    assert!(!text.contains("\"source\":\"cards\""), "{text}");
    assert!(!text.contains("\"source\":\"rows\""), "{text}");
    assert!(text.contains("\"source\":\"history\""), "{text}");
    assert_eq!(e.cat.reads.load(std::sync::atomic::Ordering::SeqCst), 0);
}

/// P3, follow-up: a whole-thread write (an Ask's append, a save, an action) that read the
/// thread before a rename, an AI title, a failed title call or the title call's record were
/// committed never writes the older ones back. The append is simulated by its two store
/// steps (read, then write) with the title change committed between them.
#[test]
fn a_whole_thread_write_never_puts_back_an_older_title() {
    use contura_core::ai::log::{Level, LogLine};
    use contura_core::ai::sent::SummarySent;
    let e = env(vec![conn(A, AiAccess::Schema)]);
    let store = AppStore::open(&e.path()).unwrap();
    let db = rusqlite::Connection::open(e.path()).unwrap();
    let append = |stale: AiThread| {
        let mut stale = stale;
        let at = stale.messages.last().unwrap().at + 60_000;
        stale.messages.extend(turns(1, at, Some(A)));
        store.write_ai_thread(stale).unwrap();
    };

    // A rename lands while the append runs.
    let t = save(&e, turns(1, now(), Some(A)));
    let stale = store.get_ai_thread(t.id).unwrap().unwrap();
    assert!(set_thread_title(&db, t.id, "Mine", TitleBy::User).unwrap());
    append(stale);
    let stored = e.stored(t.id);
    assert_eq!(
        (stored.title.as_str(), stored.title_by),
        ("Mine", TitleBy::User)
    );
    assert_eq!(stored.messages.len(), 4, "the turn is kept too");
    let row = e.svc.list_threads(PLACE).unwrap();
    let row = row.iter().find(|r| r.id == t.id).unwrap();
    assert_eq!((row.title.as_str(), row.title_by), ("Mine", TitleBy::User));

    // The AI title and its call record land while the append runs.
    let t = save(&e, turns(1, now(), Some(A)));
    let stale = store.get_ai_thread(t.id).unwrap().unwrap();
    let answer_at = first_answer(&stale).at;
    assert!(e.cat.threads.set_title(t.id, TITLE, TitleBy::Ai).unwrap());
    let sent = SummarySent {
        kind: CallKind::Title,
        messages: 2,
        exact: Some("kept text".into()),
        ..SummarySent::default()
    };
    let line = LogLine {
        at_ms: 1,
        level: Level::Info,
        source: "title".into(),
        fields: vec![("sends".into(), "question_and_answer_only".into())],
    };
    e.cat
        .threads
        .record_title_call(t.id, answer_at, Some(&sent), std::slice::from_ref(&line))
        .unwrap();
    append(stale);
    let stored = e.stored(t.id);
    assert_eq!(
        (stored.title.as_str(), stored.title_by),
        (TITLE, TitleBy::Ai)
    );
    assert_eq!(stored.messages.len(), 4);
    let record = first_answer(&stored).record.as_ref().unwrap();
    assert_eq!(record.sent.as_ref().unwrap().title.as_ref(), Some(&sent));
    assert!(record.log.contains(&line));

    // A failed title call is counted while the append runs.
    let t = save(&e, turns(1, now(), Some(A)));
    let stale = store.get_ai_thread(t.id).unwrap().unwrap();
    assert_eq!(e.cat.threads.title_failed(t.id).unwrap(), 1);
    append(stale);
    let stored = e.stored(t.id);
    assert_eq!(stored.title_tries, 1);
    assert_eq!(stored.title_by, TitleBy::Rule);
    assert_eq!(stored.messages.len(), 4);
}

/// Controller ruling (Task 5 review, Minor 1): a first turn that sent sample rows or literal
/// values is never named, and the Sends "Chat title" row is not shown for such an Ask.
#[tokio::test]
async fn a_first_turn_with_rows_is_not_named() {
    use contura_core::ai::preview::preview;
    use contura_core::ai::request::{AskRequest, Focus, TableRef};
    let e = env(vec![conn(A, AiAccess::SchemaQueryRows)]);
    // Stored: no call, no try.
    let mut m = turns(1, now(), Some(A));
    for x in &mut m {
        x.kinds.push(ItemKind::Rows);
    }
    let t = save(&e, m);
    let p = ScriptedProvider::new(reply(TITLE));
    assert_eq!(
        name(&e, &p, &settings(), &request(t.id)).await.unwrap(),
        None
    );
    assert!(calls(&p).is_empty());
    assert_eq!(e.stored(t.id).title_tries, 0);
    let mut values = turns(1, now(), Some(A));
    values[0].kinds.push(ItemKind::Values);
    let t = save(&e, values);
    assert_eq!(
        name(&e, &p, &settings(), &request(t.id)).await.unwrap(),
        None
    );
    assert!(calls(&p).is_empty());

    // The preview of a new chat's first Ask: no Chat title row while rows go.
    let ask = |rows: bool| AskRequest {
        request_id: "r1".into(),
        place: PLACE.into(),
        group_id: None,
        connection_id: Some(id(A)),
        database: Some("shop".into()),
        schema: None,
        action: "ask".into(),
        question: "Which invoices are unpaid?".into(),
        thread_id: None,
        focus: Focus {
            tables: vec![TableRef {
                schema: None,
                name: "invoices".into(),
            }],
            ..Focus::default()
        },
        switches: contura_core::ai::request::Switches {
            rows,
            ..Default::default()
        },
        off: Vec::new(),
        model: None,
        picks: None,
        tab: None,
        steps: Vec::new(),
    };
    let s = settings();
    let with_rows = preview(&*e.cat, &s, &model(), &Secrets::default(), &ask(true))
        .await
        .unwrap();
    assert!(
        with_rows.stamp.kinds.contains(&ItemKind::Rows),
        "{:?}",
        with_rows.stamp.kinds
    );
    assert_eq!(with_rows.title, None);
    let without = preview(&*e.cat, &s, &model(), &Secrets::default(), &ask(false))
        .await
        .unwrap();
    let row = without.title.expect("the Chat title row");
    assert!(row.on && !row.exact && row.tokens > 0);
}

/// A secret store that counts every read, to show a check reads no key.
#[derive(Default)]
struct Counted {
    inner: MemorySecretStore,
    reads: std::sync::atomic::AtomicUsize,
}

impl contura_core::secrets::SecretStore for Counted {
    fn get(&self, id: ConnectionId) -> Result<Option<String>> {
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.inner.get(id)
    }
    fn set(&self, id: ConnectionId, secret: &str) -> Result<()> {
        self.inner.set(id, secret)
    }
    fn delete(&self, id: ConnectionId) -> Result<()> {
        self.inner.delete(id)
    }
    fn get_named(&self, name: &str) -> Result<Option<String>> {
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.inner.get_named(name)
    }
    fn set_named(&self, name: &str, secret: &str) -> Result<()> {
        self.inner.set_named(name, secret)
    }
    fn delete_named(&self, name: &str) -> Result<()> {
        self.inner.delete_named(name)
    }
}

/// Final review M1: the command asks `title_may_go` before any keyring read, so an older,
/// renamed, tried-out or switched-off chat costs no key read and makes no call.
#[test]
fn a_chat_that_will_not_be_named_reads_no_key() {
    let e = env(vec![conn(A, AiAccess::Schema)]);
    let secrets = Arc::new(Counted::default());
    let svc = AiService::new(AppStore::open(&e.path()).unwrap(), secrets.clone());
    let fresh = save(&e, turns(1, now(), Some(A)));
    let retry = save(&e, turns(2, now(), Some(A)));
    assert!(svc.title_may_go(&request(fresh.id)).unwrap());
    assert!(svc.title_may_go(&request(retry.id)).unwrap());

    let older = save(&e, turns(3, now(), Some(A)));
    let renamed = save(&e, turns(1, now(), Some(A)));
    let db = rusqlite::Connection::open(e.path()).unwrap();
    assert!(set_thread_title(&db, renamed.id, "Mine", TitleBy::User).unwrap());
    let tried = save(&e, turns(1, now(), Some(A)));
    e.cat.threads.title_failed(tried.id).unwrap();
    e.cat.threads.title_failed(tried.id).unwrap();
    assert_eq!(e.stored(tried.id).title_tries, 2);
    let switched = NameChatRequest {
        off: vec![ItemKind::Title],
        ..request(fresh.id)
    };
    let elsewhere = NameChatRequest {
        place: "group:other".into(),
        ..request(fresh.id)
    };
    for (what, req) in [
        ("older", request(older.id)),
        ("renamed", request(renamed.id)),
        ("tried", request(tried.id)),
        ("switched off", switched),
        ("other place", elsewhere),
        ("missing", request(Uuid::new_v4())),
    ] {
        assert!(!svc.title_may_go(&req).unwrap(), "{what}");
    }
    assert_eq!(secrets.reads.load(std::sync::atomic::Ordering::SeqCst), 0);
}

/// Final review M2: the Sends "Chat title" row applies the call's own gate (P9), so a chat
/// whose first question was asked on a Connection now at Never shows no row.
#[tokio::test]
async fn the_chat_title_row_follows_the_first_questions_connection() {
    use contura_core::ai::preview::preview;
    use contura_core::ai::request::{AskRequest, Focus};
    let ask = |t: Uuid| AskRequest {
        request_id: "r2".into(),
        place: PLACE.into(),
        group_id: None,
        connection_id: Some(id(B)),
        database: Some("shop".into()),
        schema: None,
        action: "ask".into(),
        question: "And the overdue ones?".into(),
        thread_id: Some(t),
        focus: Focus::default(),
        switches: Default::default(),
        off: Vec::new(),
        model: None,
        picks: None,
        tab: None,
        steps: Vec::new(),
    };
    let s = settings();
    for (a, shown) in [(AiAccess::Schema, true), (AiAccess::Never, false)] {
        let e = env(vec![conn(A, a), conn(B, AiAccess::Schema)]);
        let t = save(&e, turns(1, now(), Some(A)));
        let p = preview(&*e.cat, &s, &model(), &Secrets::default(), &ask(t.id))
            .await
            .unwrap();
        assert_eq!(p.title.is_some(), shown, "A at {a:?}");
        // The call agrees with the row.
        let provider = ScriptedProvider::new(reply(TITLE));
        let named = name(&e, &provider, &s, &request(t.id)).await.unwrap();
        assert_eq!(named.is_some(), shown, "A at {a:?}");
    }
}
