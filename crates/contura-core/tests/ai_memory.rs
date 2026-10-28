//! Thread memory in the preview and the Ask: the open Topic's recent turns and matching
//! earlier summaries go under the gate on history (R1.7), after cache mark 2, and the
//! preview shows exactly what the Ask sends (R1.6).

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use contura_core::Error;
use contura_core::ai::budget::PAYLOAD_CAP;
use contura_core::ai::context::store::{ContextStore, StoreContext};
use contura_core::ai::memory::store::StoreThreads;
use contura_core::ai::memory::{AskedIn, BreakReason, MemoryInfo, ThreadStore, TurnStamp};
use contura_core::ai::models::{ModelInfo, info_for};
use contura_core::ai::preview::{CatalogReader, Preview, PreviewItem, preview};
use contura_core::ai::provider::scripted::ScriptedProvider;
use contura_core::ai::provider::{ChatRequest, ChatRole, ProviderEvent, StopReason, Usage};
use contura_core::ai::rails::Secrets;
use contura_core::ai::request::{AskRequest, Focus, ItemKind, Switches, TableRef};
use contura_core::ai::scene::AskTab;
use contura_core::ai::sent::{AnswerRecord, SentRecord};
use contura_core::ai::steps::{StepIn, StepVerb};
use contura_core::ai::stream::{AiEvent, ask_stream, context_used};
use contura_core::ai::{
    AiAccess, AiError, AiMessage, AiProviderKind, AiRole, AiSettings, AiThread,
};
use contura_core::model::{
    Cell, ColumnInfo, ConnectionConfig, ConnectionId, DialectKind, ObjectPath, Page, SslMode,
};
use contura_core::schema_model::{SchemaModel, SmColumn, SmTable};
use contura_core::store::AppStore;
use uuid::Uuid;

const CONN: u128 = 42;
const PLACE: &str = "ungrouped";
const MIN: i64 = 60_000;

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn conn_id() -> ConnectionId {
    Uuid::from_u128(CONN)
}

fn shop_conn(access: AiAccess) -> ConnectionConfig {
    ConnectionConfig {
        id: conn_id(),
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
        ai_access: access,
        ai_sync: Default::default(),
        production: false,
        read_only: false,
    }
}

fn col(name: &str, pk: bool) -> SmColumn {
    SmColumn {
        name: name.into(),
        type_name: "int".into(),
        pk,
        increment: false,
        not_null: false,
        unique: false,
        default: None,
        note: None,
    }
}

fn table(name: &str, columns: Vec<SmColumn>) -> SmTable {
    SmTable {
        schema: Some("public".into()),
        name: name.into(),
        alias: None,
        note: None,
        columns,
        indexes: Vec::new(),
    }
}

fn shop_schema() -> SchemaModel {
    SchemaModel {
        dialect: DialectKind::Postgres,
        tables: vec![
            table("orders", vec![col("id", true), col("customer_id", false)]),
            table("customers", vec![col("id", true), col("name", false)]),
        ],
        refs: Vec::new(),
        enums: Vec::new(),
        skipped: Vec::new(),
    }
}

struct Catalog {
    configs: Vec<ConnectionConfig>,
    schema: SchemaModel,
    context: StoreContext,
    threads: StoreThreads,
    /// Step 11f: the sample reads that reached the database.
    sample_reads: std::sync::atomic::AtomicUsize,
}

#[async_trait::async_trait]
impl CatalogReader for Catalog {
    async fn sample_rows(
        &self,
        _id: ConnectionId,
        _path: &ObjectPath,
        _limit: u32,
    ) -> contura_core::Result<Page> {
        self.sample_reads
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
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

    async fn connection_config(
        &self,
        id: ConnectionId,
    ) -> contura_core::Result<Option<ConnectionConfig>> {
        Ok(self.configs.iter().find(|c| c.id == id).cloned())
    }

    async fn schema_snapshot(
        &self,
        _id: ConnectionId,
        _database: &str,
        _schema: Option<&str>,
    ) -> contura_core::Result<SchemaModel> {
        Ok(self.schema.clone())
    }

    async fn schema_fingerprint(
        &self,
        _id: ConnectionId,
        _database: &str,
        _schema: Option<&str>,
    ) -> contura_core::Result<String> {
        Ok("fp:1".into())
    }

    fn context(&self) -> &dyn ContextStore {
        &self.context
    }

    fn threads(&self) -> &dyn ThreadStore {
        &self.threads
    }
}

fn mem() -> AppStore {
    AppStore::open(std::path::Path::new(":memory:")).unwrap()
}

fn catalog_with(access: AiAccess, schema: SchemaModel) -> Catalog {
    Catalog {
        configs: vec![shop_conn(access)],
        schema,
        context: StoreContext::new(mem()),
        threads: StoreThreads::new(mem()),
        sample_reads: std::sync::atomic::AtomicUsize::new(0),
    }
}

fn catalog(access: AiAccess) -> Catalog {
    catalog_with(access, shop_schema())
}

/// Groq with a 131K window, so the history share holds whole turns.
fn settings() -> AiSettings {
    AiSettings {
        provider: Some(AiProviderKind::Groq),
        model: "llama-3.3-70b-versatile".into(),
        context_window: Some(131_072),
        keep_exact_text: true,
        ..AiSettings::default()
    }
}

fn model() -> ModelInfo {
    let s = settings();
    info_for(AiProviderKind::Groq, None, &s.model, None, &s)
}

fn ask(question: &str, thread: Option<Uuid>) -> AskRequest {
    AskRequest {
        request_id: "r1".into(),
        place: PLACE.into(),
        group_id: None,
        connection_id: Some(conn_id()),
        database: Some("shop".into()),
        schema: None,
        action: "ask".into(),
        question: question.into(),
        thread_id: thread,
        focus: Focus {
            tables: vec![TableRef {
                schema: None,
                name: "orders".into(),
            }],
            ..Focus::default()
        },
        switches: Switches::default(),
        off: Vec::new(),
        model: None,
        picks: None,
        tab: None,
        steps: Vec::new(),
    }
}

struct Stamp<'a> {
    topic: u32,
    database: &'a str,
    kinds: &'a [ItemKind],
    tables: &'a [&'a str],
}

const ASKED: &[ItemKind] = &[ItemKind::Question, ItemKind::Names, ItemKind::Cards];

fn stamp(topic: u32) -> Stamp<'static> {
    Stamp {
        topic,
        database: "shop",
        kinds: ASKED,
        tables: &["orders"],
    }
}

fn message(role: AiRole, text: &str, at: i64, s: &Stamp) -> AiMessage {
    AiMessage {
        role,
        text: text.into(),
        context: Vec::new(),
        at,
        record: None,
        topic: Some(s.topic),
        connection_id: Some(conn_id()),
        database: Some(s.database.into()),
        kinds: s.kinds.to_vec(),
        tables: s.tables.iter().map(|t| t.to_string()).collect(),
        action: Some("ask".into()),
        asked_in: None,
    }
}

fn turn(q: &str, a: &str, at: i64, s: &Stamp) -> Vec<AiMessage> {
    vec![
        message(AiRole::User, q, at, s),
        message(AiRole::Assistant, a, at + 1_000, s),
    ]
}

fn save(cat: &Catalog, place: &str, messages: Vec<AiMessage>) -> Uuid {
    let id = Uuid::new_v4();
    cat.threads
        .save_thread(&AiThread {
            id,
            place: place.into(),
            title: "t".into(),
            messages,
            updated_at: now(),
            title_by: Default::default(),
            title_tries: 0,
            last_work: None,
        })
        .unwrap();
    id
}

/// A two-turn Topic 1, written minutes ago.
fn two_turns() -> Vec<AiMessage> {
    let t = now() - 10 * MIN;
    let mut m = turn("How many orders today?", "About 40 orders.", t, &stamp(1));
    m.extend(turn(
        "And yesterday?",
        "52 orders yesterday.",
        t + 2 * MIN,
        &stamp(1),
    ));
    m
}

fn text(t: &str) -> Result<ProviderEvent, AiError> {
    Ok(ProviderEvent::Text(t.into()))
}

fn ok_script() -> ScriptedProvider {
    ScriptedProvider::new(vec![text("ok"), Ok(ProviderEvent::Stop(StopReason::End))])
}

async fn stream(provider: &ScriptedProvider, cat: &Catalog, req: &AskRequest) -> Vec<AiEvent> {
    let events = Mutex::new(Vec::new());
    let emit = |e: AiEvent| events.lock().unwrap().push(e);
    ask_stream(
        provider,
        cat,
        &settings(),
        &model(),
        &Secrets::default(),
        req,
        &emit,
    )
    .await
    .unwrap();
    events.into_inner().unwrap()
}

/// The Ask's own request: no Ask here makes a summary call, so it is the only one.
async fn ask_once(cat: &Catalog, req: &AskRequest) -> (ChatRequest, Vec<AiEvent>) {
    let provider = ok_script();
    let events = stream(&provider, cat, req).await;
    let seen = provider.seen.lock().unwrap();
    match seen.as_slice() {
        [ask] => (ask.clone(), events),
        other => panic!("{} requests", other.len()),
    }
}

async fn show(cat: &Catalog, req: &AskRequest) -> Preview {
    preview(cat, &settings(), &model(), &Secrets::default(), req)
        .await
        .unwrap()
}

fn row(p: &Preview, kind: ItemKind) -> Option<&PreviewItem> {
    p.items.iter().find(|i| i.kind == kind)
}

fn roles(chat: &ChatRequest) -> Vec<ChatRole> {
    chat.messages.iter().map(|m| m.role).collect()
}

/// Every text the request carries, joined.
fn all_text(chat: &ChatRequest) -> String {
    let mut out: Vec<&str> = chat.system.iter().map(|b| b.text.as_str()).collect();
    out.extend(chat.messages.iter().map(|m| m.text.as_str()));
    out.join("\n")
}

/// `text` with each 16-character framing boundary replaced by `x`.
fn same_boundary(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(i) = rest.find("context id=") {
        let end = i + "context id=".len();
        out.push_str(&rest[..end]);
        out.push('x');
        rest = &rest[end + 16..];
    }
    out.push_str(rest);
    out
}

/// "Show exactly" rebuilt from a request: the schema block, each history message after
/// its role line, then the turn.
fn exact_of(chat: &ChatRequest) -> String {
    let mut out = String::new();
    if let Some(schema) = chat.system.get(1) {
        out.push_str(&schema.text);
        out.push_str("\n\n");
    }
    let (turn, history) = chat.messages.split_last().unwrap();
    for m in history {
        out.push_str(match m.role {
            ChatRole::User => "[user]\n",
            ChatRole::Assistant => "[assistant]\n",
        });
        out.push_str(&m.text);
        out.push_str("\n\n");
    }
    out.push_str(&turn.text);
    out
}

fn memory_of(events: &[AiEvent]) -> TurnStamp {
    events
        .iter()
        .find_map(|e| match e {
            AiEvent::Memory { stamp } => Some(stamp.clone()),
            _ => None,
        })
        .expect("a Memory event")
}

fn sent_of(events: &[AiEvent]) -> SentRecord {
    events
        .iter()
        .rev()
        .find_map(|e| match e {
            AiEvent::Sent(s) => Some(s.clone()),
            _ => None,
        })
        .expect("a Sent event")
}

#[tokio::test]
async fn follow_up_sends_recent_turns() {
    let cat = catalog(AiAccess::Schema);
    let id = save(&cat, PLACE, two_turns());
    let req = ask("And last week?", Some(id));

    let (chat, _) = ask_once(&cat, &req).await;
    assert_eq!(
        roles(&chat),
        [
            ChatRole::User,
            ChatRole::Assistant,
            ChatRole::User,
            ChatRole::Assistant,
            ChatRole::User
        ]
    );
    let texts: Vec<&str> = chat.messages.iter().map(|m| m.text.as_str()).collect();
    assert_eq!(
        texts[..4],
        [
            "How many orders today?",
            "About 40 orders.",
            "And yesterday?",
            "52 orders yesterday."
        ]
    );
    assert!(
        texts[4].ends_with("Question: And last week?"),
        "{}",
        texts[4]
    );

    let p = show(&cat, &req).await;
    let thread = row(&p, ItemKind::History).expect("a Thread row");
    assert_eq!(thread.label, "Thread · 2 turns");
    assert!(thread.on);
    assert_eq!(
        p.memory,
        Some(MemoryInfo {
            topic: 1,
            opened: false,
            reason: None,
            title: "How many orders today?".into(),
            turns: 2,
            summaries: 0,
            blocked: 0,
            tokens: thread.tokens,
        })
    );
    // Only the texts count in the bytes, not the role lines "Show exactly" adds.
    let markers = "[user]\n\n\n".len() * 2 + "[assistant]\n\n\n".len() * 2;
    assert_eq!(p.total_bytes as usize, p.exact.len() - markers);
}

fn continue_ask(thread: Option<Uuid>) -> AskRequest {
    AskRequest {
        action: "continue".into(),
        ..ask("Continue", thread)
    }
}

#[tokio::test]
async fn continue_sends_the_cut_answer_last() {
    let cat = catalog(AiAccess::Schema);
    let t = now() - 2 * MIN;
    let id = save(
        &cat,
        PLACE,
        turn(
            "List the orders",
            "SELECT id FROM orders WHERE",
            t,
            &stamp(1),
        ),
    );
    let (chat, _) = ask_once(&cat, &continue_ask(Some(id))).await;
    assert_eq!(
        roles(&chat),
        [ChatRole::User, ChatRole::Assistant, ChatRole::User]
    );
    assert_eq!(chat.messages[1].text, "SELECT id FROM orders WHERE");
    assert!(chat.messages[2].text.ends_with("Question: Continue"));
    assert!(
        chat.system
            .iter()
            .any(|b| b.text.contains("Task: continue your previous answer"))
    );
}

#[tokio::test]
async fn continue_without_history_is_refused() {
    let cases: Vec<(&str, AskRequest, AiAccess, Vec<AiMessage>)> = vec![
        // No thread at all.
        (
            "no thread",
            continue_ask(None),
            AiAccess::Schema,
            Vec::new(),
        ),
        // The history gate blocks the only turn (it carried query text; the Connection is
        // now at Schema). Another database no longer blocks it (ruling 1 of 27 Oct).
        (
            "gate blocked",
            continue_ask(None),
            AiAccess::Schema,
            turn(
                "q",
                "a cut",
                now() - MIN,
                &Stamp {
                    kinds: &[ItemKind::Question, ItemKind::Sql],
                    ..stamp(1)
                },
            ),
        ),
    ];
    for (name, mut req, access, messages) in cases {
        let cat = catalog(access);
        if !messages.is_empty() {
            req.thread_id = Some(save(&cat, PLACE, messages));
        }
        let provider = ok_script();
        let events = Mutex::new(Vec::new());
        let emit = |e: AiEvent| events.lock().unwrap().push(e);
        let got = ask_stream(
            &provider,
            &cat,
            &settings(),
            &model(),
            &Secrets::default(),
            &req,
            &emit,
        )
        .await;
        assert!(
            matches!(&got, Err(Error::Ai(AiError::NothingToContinue))),
            "{name}: {got:?}"
        );
        assert!(provider.seen.lock().unwrap().is_empty(), "{name}: sent");
    }
}

fn no_focus(mut req: AskRequest) -> AskRequest {
    req.focus = Focus::default();
    req
}

/// Runs one Ask at a 32,000 window, where 300 wide tables are ranked and outlined.
async fn small_window(
    provider: &ScriptedProvider,
    cat: &Catalog,
    req: &AskRequest,
) -> contura_core::Result<()> {
    let mut s = settings();
    s.context_window = Some(32_000);
    let m = info_for(AiProviderKind::Groq, None, &s.model, None, &s);
    ask_stream(provider, cat, &s, &m, &Secrets::default(), req, &|_| {}).await
}

#[tokio::test]
async fn continue_never_makes_the_outline_call() {
    let cat = catalog_with(AiAccess::Schema, wide_schema(300));
    let q = "Which records matter most for retention?";
    let outline = |provider: &ScriptedProvider| {
        provider
            .seen
            .lock()
            .unwrap()
            .iter()
            .any(|c| c.system[0].text.contains("Pick the parts of this database"))
    };
    // Control: the same schema and no focus, as an Ask, does outline.
    let control = ScriptedProvider::new(vec![
        text("{}"),
        Ok(ProviderEvent::Stop(StopReason::End)),
        text("ok"),
        Ok(ProviderEvent::Stop(StopReason::End)),
    ]);
    let _ = small_window(&control, &cat, &no_focus(ask(q, None))).await;
    assert!(outline(&control), "the control Ask should outline");

    // A Continue with no history sends nothing at all.
    let provider = ok_script();
    let got = small_window(&provider, &cat, &no_focus(continue_ask(None))).await;
    assert!(
        matches!(got, Err(Error::Ai(AiError::NothingToContinue))),
        "{got:?}"
    );
    assert!(provider.seen.lock().unwrap().is_empty());

    // A valid Continue makes the one Ask call and no outline call.
    let id = save(
        &cat,
        PLACE,
        turn("List", "SELECT 1 FROM", now() - 2 * MIN, &stamp(1)),
    );
    let provider = ok_script();
    small_window(&provider, &cat, &no_focus(continue_ask(Some(id))))
        .await
        .unwrap();
    assert_eq!(provider.seen.lock().unwrap().len(), 1);
    assert!(!outline(&provider));
}

#[tokio::test]
async fn preview_refuses_a_continue_with_nothing_to_continue() {
    let cat = catalog(AiAccess::Schema);
    let got = preview(
        &cat,
        &settings(),
        &model(),
        &Secrets::default(),
        &continue_ask(None),
    )
    .await;
    assert!(
        matches!(&got, Err(Error::Ai(AiError::NothingToContinue))),
        "{got:?}"
    );
    // With a cut answer the preview shows the same history the Ask sends.
    let id = save(
        &cat,
        PLACE,
        turn("List", "SELECT 1 FROM", now() - 2 * MIN, &stamp(1)),
    );
    let p = show(&cat, &continue_ask(Some(id))).await;
    assert!(row(&p, ItemKind::History).is_some());
}

#[tokio::test]
async fn continue_needs_the_last_turn_in_the_pick() {
    let t = now() - 10 * MIN;
    // Earlier turn passes the gate, the last pair carried query text the Connection no
    // longer allows: dropped. (Another database no longer drops it: ruling 1 of 27 Oct.)
    let other = Stamp {
        kinds: &[ItemKind::Question, ItemKind::Sql],
        ..stamp(1)
    };
    let mut m = turn("first", "done answer", t, &stamp(1));
    m.extend(turn("second", "cut", t + 2 * MIN, &other));
    // The history budget drops the last (largest) turn.
    let mut huge = turn("first", "done answer", t, &stamp(1));
    huge.extend(turn(
        "second",
        &"word ".repeat(200_000),
        t + 2 * MIN,
        &stamp(1),
    ));
    for (name, messages) in [("gate", m), ("budget", huge)] {
        let cat = catalog(AiAccess::Schema);
        let id = save(&cat, PLACE, messages);
        let got = preview(
            &cat,
            &settings(),
            &model(),
            &Secrets::default(),
            &continue_ask(Some(id)),
        )
        .await;
        assert!(
            matches!(&got, Err(Error::Ai(AiError::NothingToContinue))),
            "{name}: {got:?}"
        );
    }
}

#[tokio::test]
async fn continue_ignores_a_notice_after_the_cut_answer() {
    let cat = catalog(AiAccess::Schema);
    let t = now() - 2 * MIN;
    let mut m = turn("List", "SELECT 1 FROM", t, &stamp(1));
    m.push(message(AiRole::Notice, "Stopped.", t + 5_000, &stamp(1)));
    let id = save(&cat, PLACE, m);
    let (chat, _) = ask_once(&cat, &continue_ask(Some(id))).await;
    assert_eq!(chat.messages[1].text, "SELECT 1 FROM");
}

#[test]
fn nothing_to_continue_is_its_own_kind() {
    assert_eq!(
        serde_json::to_value(AiError::NothingToContinue).unwrap(),
        serde_json::json!({ "kind": "nothingToContinue" })
    );
}

#[tokio::test]
async fn continue_is_refused_as_its_own_kind() {
    let cat = catalog(AiAccess::Schema);
    let provider = ok_script();
    let events = Mutex::new(Vec::new());
    let emit = |e: AiEvent| events.lock().unwrap().push(e);
    let got = ask_stream(
        &provider,
        &cat,
        &settings(),
        &model(),
        &Secrets::default(),
        &continue_ask(None),
        &emit,
    )
    .await;
    assert!(
        matches!(got, Err(Error::Ai(AiError::NothingToContinue))),
        "{got:?}"
    );
    // The card reads the kind, not "Something went wrong".
    assert!(events.into_inner().unwrap().iter().any(|e| matches!(
        e,
        AiEvent::Error {
            error: AiError::NothingToContinue,
            partial: false
        }
    )));
}

#[tokio::test]
async fn continue_with_the_thread_row_off_is_refused() {
    let cat = catalog(AiAccess::Schema);
    let id = save(
        &cat,
        PLACE,
        turn("List", "SELECT 1 FROM", now() - 2 * MIN, &stamp(1)),
    );
    let mut req = continue_ask(Some(id));
    req.off = vec![ItemKind::History];
    let got = preview(&cat, &settings(), &model(), &Secrets::default(), &req).await;
    assert!(
        matches!(&got, Err(Error::Ai(AiError::NothingToContinue))),
        "{got:?}"
    );
    let provider = ok_script();
    let got = ask_stream(
        &provider,
        &cat,
        &settings(),
        &model(),
        &Secrets::default(),
        &req,
        &|_| {},
    )
    .await;
    assert!(
        matches!(got, Err(Error::Ai(AiError::NothingToContinue))),
        "{got:?}"
    );
    assert!(provider.seen.lock().unwrap().is_empty(), "nothing sent");
}

#[tokio::test]
async fn history_off_sends_none() {
    let cat = catalog(AiAccess::Schema);
    let id = save(&cat, PLACE, two_turns());
    let mut req = ask("And last week?", Some(id));
    req.off = vec![ItemKind::History];

    let (chat, events) = ask_once(&cat, &req).await;
    assert_eq!(roles(&chat), [ChatRole::User]);
    assert!(!all_text(&chat).contains("yesterday"));
    assert!(!sent_of(&events).kinds.contains(&ItemKind::History));

    let p = show(&cat, &req).await;
    let thread = row(&p, ItemKind::History).expect("the row stays, switched off");
    assert!(!thread.on);
    assert!(!p.exact.contains("yesterday"), "{}", p.exact);
}

#[tokio::test]
async fn history_is_cleaned() {
    let cat = catalog(AiAccess::Schema);
    let t = now() - 5 * MIN;
    let key = "sk-ant-api03-abcdefghijklmnopqrstuvwx";
    let mut messages = turn(
        &format!("my key is {key}, why does orders fail?"),
        "Look at orders.\u{202E}txet neddih",
        t,
        &stamp(1),
    );
    // An earlier turn of the same Topic with a zero-width space in its answer.
    messages.splice(
        0..0,
        turn(
            &format!("orders total with {key}"),
            "Sum\u{200B}med.",
            t - 2 * MIN,
            &stamp(1),
        ),
    );
    let id = save(&cat, PLACE, messages);
    let req = ask("and now?", Some(id));

    let (chat, _) = ask_once(&cat, &req).await;
    let all = all_text(&chat);
    assert!(chat.messages.len() > 1, "history went");
    assert!(all.contains("[redacted]"), "{all}");
    assert!(!all.contains("sk-ant-"), "{all}");
    assert!(!all.contains('\u{202E}'), "{all}");
    assert!(!all.contains('\u{200B}'), "{all}");
}

#[tokio::test]
async fn lowered_access_hides_history() {
    // Turn 1 carried query text at Schema and query text; the Connection is now Schema.
    let cat = catalog(AiAccess::Schema);
    let t = now() - 10 * MIN;
    let sql = Stamp {
        kinds: &[ItemKind::Question, ItemKind::Cards, ItemKind::Sql],
        ..stamp(1)
    };
    let mut messages = turn("Why is this select slow?", "Add an index.", t, &sql);
    messages.extend(turn(
        "Which tables hold orders?",
        "orders and customers.",
        t + MIN,
        &stamp(1),
    ));
    let id = save(&cat, PLACE, messages);
    let req = ask("and customers?", Some(id));

    let (chat, _) = ask_once(&cat, &req).await;
    let all = all_text(&chat);
    assert!(!all.contains("select slow"), "{all}");
    assert!(!all.contains("Add an index"), "{all}");
    assert!(all.contains("Which tables hold orders?"), "{all}");

    let p = show(&cat, &req).await;
    let m = p.memory.clone().unwrap();
    // The blocked turn's two messages.
    assert_eq!((m.turns, m.blocked), (1, 2));
    assert_eq!(row(&p, ItemKind::History).unwrap().label, "Thread · 1 turn");
}

/// The user's report of 25 Oct: at Never a turn that sent only the conversation goes,
/// through the same entry points the Ask uses; one that sent schema names stays held and
/// counted.
#[tokio::test]
async fn never_sends_only_the_plain_conversation() {
    let cat = catalog(AiAccess::Never);
    let t = now() - 5 * MIN;
    let q = Stamp {
        kinds: &[ItemKind::Question],
        tables: &[],
        ..stamp(1)
    };
    let mut messages = turn("call me andrew", "Hi Andrew", t, &q);
    messages.extend(turn(
        "which tables?",
        "orders, customers",
        t + MIN,
        &stamp(1),
    ));
    let id = save(&cat, PLACE, messages);
    let req = ask("remember my name", Some(id));

    let (chat, _) = ask_once(&cat, &req).await;
    assert_eq!(
        roles(&chat),
        [ChatRole::User, ChatRole::Assistant, ChatRole::User]
    );
    let all = all_text(&chat);
    assert!(all.contains("call me andrew"), "{all}");
    assert!(!all.contains("which tables?"), "{all}");
    assert!(!all.contains("orders, customers"), "{all}");

    let p = show(&cat, &req).await;
    assert_eq!(row(&p, ItemKind::History).unwrap().label, "Thread · 1 turn");
    let m = p.memory.clone().unwrap();
    assert_eq!((m.turns, m.blocked), (1, 2));
}

fn home_ask(question: &str, thread: Option<Uuid>) -> AskRequest {
    AskRequest {
        connection_id: None,
        database: None,
        focus: Focus::default(),
        tab: Some(AskTab::Home),
        ..ask(question, thread)
    }
}

fn home_turn(q: &str, a: &str, at: i64) -> Vec<AiMessage> {
    let mut m = turn(
        q,
        a,
        at,
        &Stamp {
            kinds: &[ItemKind::Question, ItemKind::Tab],
            tables: &[],
            ..stamp(1)
        },
    );
    for x in &mut m {
        x.connection_id = None;
        x.database = None;
    }
    m
}

/// The user's report of 25 Oct: on Home "call me andrew", then "remember my name" sent no
/// earlier turn. Through the Ask and its preview, turn 2 now carries turn 1.
#[tokio::test]
async fn home_remembers_the_conversation() {
    let cat = catalog(AiAccess::Schema);
    let id = save(
        &cat,
        PLACE,
        home_turn("call me andrew", "Hi Andrew", now() - 2 * MIN),
    );
    let req = home_ask("remember my name", Some(id));

    let (chat, events) = ask_once(&cat, &req).await;
    assert_eq!(
        roles(&chat),
        [ChatRole::User, ChatRole::Assistant, ChatRole::User]
    );
    assert!(chat.messages[0].text.ends_with("call me andrew"));
    assert_eq!(chat.messages[1].text, "Hi Andrew");
    assert_eq!(memory_of(&events).topic, 1, "the same Topic");

    let p = show(&cat, &req).await;
    assert_eq!(row(&p, ItemKind::History).unwrap().label, "Thread · 1 turn");
    assert_eq!(p.memory.unwrap().blocked, 0);
    assert_eq!(
        same_boundary(&show(&cat, &req).await.exact),
        same_boundary(&exact_of(&chat))
    );
}

/// I2: a Home turn that carried Recent steps on a Connection keeps replaying; each step is
/// re-gated by its own Connection (ADR 0027 rule 1) and Sends counts nothing as held.
#[tokio::test]
async fn home_turn_with_other_steps_replays_and_regates_them() {
    use contura_core::ai::memory::OtherStep;
    let b = Uuid::from_u128(43);
    let mut cat = catalog(AiAccess::Schema);
    cat.configs.push(ConnectionConfig {
        id: b,
        name: "Kestrel staging".into(),
        ..shop_conn(AiAccess::SchemaQuery)
    });
    let mut m = home_turn("call me andrew", "Hi Andrew", now() - 2 * MIN);
    m[0].asked_in = Some(AskedIn {
        tab: "home".into(),
        label: "Home".into(),
        summary: String::new(),
        steps: Vec::new(),
        also: Vec::new(),
        other_steps: vec![OtherStep {
            connection_id: b,
            text: "opened the table invoices on another Connection".into(),
            level: AiAccess::Schema,
        }],
        tab_key: None,
    });
    let id = save(&cat, PLACE, m);
    let req = home_ask("remember my name", Some(id));

    let (chat, _) = ask_once(&cat, &req).await;
    assert!(all_text(&chat).contains("call me andrew"));
    assert!(other_steps_line(&chat).unwrap().contains("invoices"));

    cat.configs[1].ai_access = AiAccess::Never;
    let (chat, _) = ask_once(&cat, &req).await;
    let all = all_text(&chat);
    assert!(all.contains("call me andrew"), "{all}");
    assert!(!all.contains("invoices"), "{all}");
    assert_eq!(show(&cat, &req).await.memory.unwrap().blocked, 0);
}

/// C2: at Never the tab's table names went nowhere, so the turn does not keep them: a
/// Topic summary built by rules from it can never carry them at Never.
#[tokio::test]
async fn never_turn_keeps_no_table_names() {
    let cat = catalog(AiAccess::Never);
    let p = show(&cat, &ask("hello", None)).await;
    assert!(p.stamp.tables.is_empty(), "{:?}", p.stamp.tables);
    assert!(
        p.stamp
            .kinds
            .iter()
            .all(|k| matches!(k, ItemKind::Question | ItemKind::Tab | ItemKind::Steps)),
        "{:?}",
        p.stamp.kinds
    );
    // At Schema only the names went, and the turn keeps them.
    let cat = catalog(AiAccess::Schema);
    let p = show(&cat, &ask("hello", None)).await;
    assert!(
        p.stamp.tables.contains(&"orders".to_string()),
        "{:?}",
        p.stamp.tables
    );
}

/// I1: a turn is stamped with the kinds of the history it replayed, so content built on an
/// earlier turn's query text is held when access is lowered below it.
#[tokio::test]
async fn stamp_carries_the_replayed_history_kinds() {
    let cat = catalog(AiAccess::SchemaQuery);
    let sql = Stamp {
        kinds: &[ItemKind::Question, ItemKind::Names, ItemKind::Sql],
        ..stamp(1)
    };
    let id = save(
        &cat,
        PLACE,
        turn(
            "why is this slow?",
            "Add an index on status.",
            now() - 2 * MIN,
            &sql,
        ),
    );
    let mut req = ask("and the other one?", Some(id));
    req.off = vec![ItemKind::Cards];
    let p = show(&cat, &req).await;
    assert!(row(&p, ItemKind::History).is_some());
    assert!(
        p.stamp.kinds.contains(&ItemKind::Sql),
        "{:?}",
        p.stamp.kinds
    );

    // With the Thread row off nothing of it went, and the stamp does not claim it.
    req.off.push(ItemKind::History);
    let p = show(&cat, &req).await;
    assert!(
        !p.stamp.kinds.contains(&ItemKind::Sql),
        "{:?}",
        p.stamp.kinds
    );
}

/// I1: a Continue extends an answer built on sample rows: its stamp takes the continued
/// turn's kinds, so it is held with that turn when access is lowered.
#[tokio::test]
async fn continue_stamp_takes_the_continued_kinds() {
    let cat = catalog(AiAccess::SchemaQueryRows);
    let rows = Stamp {
        kinds: &[ItemKind::Question, ItemKind::Cards, ItemKind::Rows],
        ..stamp(1)
    };
    let id = save(
        &cat,
        PLACE,
        turn(
            "show me some orders",
            "Order 1 is zq-cell",
            now() - 2 * MIN,
            &rows,
        ),
    );
    // Nothing of this Ask's own carries cards or rows: no open table, so no card and no row.
    let mut req = continue_ask(Some(id));
    req.focus = Focus::default();
    req.switches.rows = true;
    let (_, events) = ask_once(&cat, &req).await;
    let kinds = memory_of(&events).kinds;
    assert!(kinds.contains(&ItemKind::Rows), "{kinds:?}");
    assert!(kinds.contains(&ItemKind::Cards), "{kinds:?}");
}

/// Ruling 1 (27 Oct): the history follows the conversation across databases. The open
/// Topic's turns and the closed Topic's summary asked on `shop` go with an Ask on
/// `shop_archive`, gated by the Connection's own access (Decision 2).
#[tokio::test]
async fn another_database_keeps_the_history() {
    let cat = catalog(AiAccess::Schema);
    let t = now() - 10 * MIN;
    // Topic 1 is closed and has a summary that names orders; Topic 2 is open.
    let mut messages = turn(
        "Late orders by store",
        "Store 4 is late.",
        t - 5 * MIN,
        &stamp(1),
    );
    messages.extend(turn("How many orders today?", "About 40.", t, &stamp(2)));
    let id = save(&cat, PLACE, messages);
    assert!(!cat.threads.topics(id).unwrap()[0].summary.is_empty());

    // The same place now asks about another database of the same Connection.
    let mut req = ask("orders in the archive?", Some(id));
    req.database = Some("shop_archive".into());

    let (chat, events) = ask_once(&cat, &req).await;
    let all = all_text(&chat);
    assert!(all.contains("How many orders today?"), "{all}");
    assert!(all.contains("About 40."), "{all}");
    let s = memory_of(&events);
    // One conversation (ruling 1): the open Topic goes on on another database.
    assert_eq!((s.topic, s.opened, s.reason), (2, false, None));
    assert_eq!(s.database.as_deref(), Some("shop_archive"));

    let p = show(&cat, &req).await;
    assert!(row(&p, ItemKind::History).is_some(), "{:?}", p.items);
    let m = p.memory.clone().unwrap();
    assert_eq!((m.topic, m.opened, m.turns), (2, false, 1));
    assert_eq!(m.blocked, 0);
    assert_eq!(same_boundary(&p.exact), same_boundary(&exact_of(&chat)));
}

/// Ruling 1 (27 Oct): no Idle break. Topic 1 asked 3 hours later goes on, its turns in
/// History, and no Topic summary call is made.
#[tokio::test]
async fn an_idle_thread_continues_its_topic() {
    let cat = catalog(AiAccess::Schema);
    let t = now() - 3 * 60 * MIN;
    let messages = turn("Which orders are late?", "Orders 7 and 9.", t, &stamp(1));
    let id = save(&cat, PLACE, messages);

    let req = ask("orders late this week?", Some(id));
    let p = show(&cat, &req).await;
    assert_eq!(row(&p, ItemKind::History).unwrap().label, "Thread · 1 turn");
    let m = p.memory.clone().unwrap();
    assert_eq!((m.topic, m.opened, m.reason), (1, false, None));
    assert_eq!((m.turns, m.summaries), (1, 0));
    assert!(p.summary.is_none(), "no Topic summary step");

    let (chat, events) = ask_once(&cat, &req).await;
    let s = memory_of(&events);
    assert_eq!((s.topic, s.opened, s.reason), (1, false, None));
    assert_eq!(
        roles(&chat),
        [ChatRole::User, ChatRole::Assistant, ChatRole::User]
    );
    assert_eq!(chat.messages[0].text, "Which orders are late?");
    assert_eq!(chat.messages[1].text, "Orders 7 and 9.");
    // The Topic stays open: no summary was written for it.
    assert!(cat.threads.topics(id).unwrap()[0].summary.is_empty());
}

#[tokio::test]
async fn history_after_cache_mark_2() {
    let cat = catalog(AiAccess::Schema);
    let id = save(&cat, PLACE, two_turns());
    let (with, _) = ask_once(&cat, &ask("And last week?", Some(id))).await;
    let (without, _) = ask_once(&cat, &ask("And last week?", None)).await;
    assert_eq!(with.system, without.system);
    assert_eq!(without.messages.len(), 1);
    assert_eq!(with.messages.len(), 5);
    for block in &with.system {
        assert!(!block.text.contains("yesterday"));
    }
}

#[tokio::test]
async fn thread_of_another_place_is_ignored() {
    let cat = catalog(AiAccess::Schema);
    let id = save(&cat, "group:other", two_turns());
    let req = ask("And last week?", Some(id));

    let (chat, events) = ask_once(&cat, &req).await;
    assert_eq!(roles(&chat), [ChatRole::User]);
    let s = memory_of(&events);
    assert_eq!(
        (s.topic, s.opened, s.reason),
        (1, true, Some(BreakReason::First))
    );

    let p = show(&cat, &req).await;
    assert_eq!(p.memory, None);
    assert!(row(&p, ItemKind::History).is_none());
}

#[tokio::test]
async fn memory_event_before_sent() {
    let cat = catalog(AiAccess::SchemaQuery);
    let id = save(&cat, PLACE, two_turns());
    let mut req = ask("And last week?", Some(id));
    req.focus.sql = Some("select count(*) from orders".into());

    let (_, events) = ask_once(&cat, &req).await;
    let memory = events
        .iter()
        .position(|e| matches!(e, AiEvent::Memory { .. }))
        .unwrap();
    let sent = events
        .iter()
        .position(|e| matches!(e, AiEvent::Sent(_)))
        .unwrap();
    assert_eq!(memory + 1, sent, "Memory goes right before Sent");

    let s = memory_of(&events);
    assert_eq!(s.topic, 1);
    assert!(!s.opened);
    assert_eq!(s.title, "How many orders today?");
    assert_eq!(s.connection_id, Some(conn_id()));
    assert_eq!(s.database.as_deref(), Some("shop"));
    assert_eq!(s.action, "ask");
    assert!(s.tables.contains(&"orders".to_string()), "{:?}", s.tables);
    // The kinds the turn sent: SQL went, so the stamp says so; the thread itself is not
    // a kind of the turn.
    assert!(s.kinds.contains(&ItemKind::Sql), "{:?}", s.kinds);
    assert!(s.kinds.contains(&ItemKind::Question));
    assert!(!s.kinds.contains(&ItemKind::History));
    let sent = sent_of(&events);
    assert!(sent.kinds.contains(&ItemKind::History));
    for k in &s.kinds {
        assert!(sent.kinds.contains(k), "{k:?} was not sent");
    }

    let json = serde_json::to_value(&events[memory]).unwrap();
    assert_eq!(json["type"], "memory");
    assert_eq!(json["stamp"]["topic"], 1);
    assert_eq!(json["stamp"]["connectionId"], conn_id().to_string());

    // One memory log line, counts only.
    let lines: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            AiEvent::Log(l) if l.source == "memory" => Some(l.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(lines.len(), 1);
    let fields: Vec<(&str, &str)> = lines[0]
        .fields
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    assert_eq!(
        fields[..6],
        [
            ("topic", "1"),
            ("opened", "no"),
            ("break", "none"),
            ("turns", "2"),
            ("summaries", "0"),
            ("blocked", "0"),
        ]
    );
    assert_eq!(fields[6].0, "tokens");
}

/// Many wide tables: their cards fill most of the schema share.
fn wide_schema(tables: usize) -> SchemaModel {
    SchemaModel {
        dialect: DialectKind::Postgres,
        tables: (0..tables)
            .map(|t| {
                table(
                    &format!("t_{t:04}"),
                    (0..12)
                        .map(|c| col(&format!("column_name_{c:02}"), c == 0))
                        .collect(),
                )
            })
            .collect(),
        refs: Vec::new(),
        enums: Vec::new(),
        skipped: Vec::new(),
    }
}

#[tokio::test]
async fn trim_cuts_history_before_cards() {
    let cat = catalog_with(AiAccess::SchemaQuery, wide_schema(340));
    let t = now() - 30 * MIN;
    let mut messages = turn(
        "Totals per t_0001",
        "By month.",
        t - 10 * MIN,
        &Stamp {
            tables: &["t_0001"],
            ..stamp(1)
        },
    );
    let open = Stamp {
        tables: &["t_0001"],
        ..stamp(2)
    };
    for n in 0..8 {
        messages.extend(turn(
            &format!("question {n} {}", "q".repeat(900)),
            &format!("answer {n} {}", "a".repeat(4_000)),
            t + n * MIN,
            &open,
        ));
    }
    let id = save(&cat, PLACE, messages);
    let mut req = ask(&"why ".repeat(4_000), Some(id));
    // Query text whose quotes double when framed.
    req.focus.sql = Some(format!("select {} 1", "\"x\",".repeat(10_000)));

    let mut alone = req.clone();
    alone.thread_id = None;
    let without = show(&cat, &alone).await;
    let p = show(&cat, &req).await;
    assert!(p.exact.len() <= PAYLOAD_CAP);
    let m = p.memory.clone().unwrap();
    // Summaries go first, then the oldest turns; the newest stays.
    assert_eq!(m.summaries, 0, "{m:?}");
    assert!(m.turns > 0 && m.turns < 8, "{m:?}");
    assert!(p.exact.contains("answer 7 "));
    assert!(!p.exact.contains("answer 0 "));
    assert!(!p.exact.contains("By month"));
    // The cards were not cut.
    assert_eq!(
        row(&p, ItemKind::Cards).unwrap().bytes,
        row(&without, ItemKind::Cards).unwrap().bytes
    );
    assert!(p.tables.left_out.is_empty());
}

#[tokio::test]
async fn preview_shows_the_same_history_as_the_ask() {
    let cat = catalog(AiAccess::Schema);
    let id = save(&cat, PLACE, two_turns());
    let req = ask("And last week?", Some(id));

    let p = show(&cat, &req).await;
    let (chat, events) = ask_once(&cat, &req).await;
    assert_eq!(same_boundary(&p.exact), same_boundary(&exact_of(&chat)));
    let sent = sent_of(&events);
    assert_eq!(
        same_boundary(sent.exact.as_deref().unwrap()),
        same_boundary(&p.exact)
    );
    assert!(
        p.exact
            .contains("[user]\nHow many orders today?\n\n[assistant]\nAbout 40 orders.")
    );
}

#[test]
fn context_used_takes_the_larger_figure() {
    let t = now();
    let answer = |topic: u32, input: u32, cache_read: u32| AiMessage {
        record: Some(AnswerRecord {
            usage: Some(Usage {
                input,
                output: 10,
                cache_read,
                cache_write: 0,
            }),
            ..AnswerRecord::default()
        }),
        ..message(AiRole::Assistant, "a", t, &stamp(topic))
    };
    let thread = AiThread {
        id: Uuid::new_v4(),
        place: PLACE.into(),
        title: "t".into(),
        messages: vec![
            answer(1, 9_000, 1_000),
            answer(2, 3_000, 500),
            answer(2, 4_000, 2_000),
        ],
        updated_at: t,
        title_by: Default::default(),
        title_tries: 0,
        last_work: None,
    };
    // The newest answer of Topic 2 reported 6,000.
    assert_eq!(context_used(5_000, Some(&thread), 2), 6_000);
    assert_eq!(context_used(7_000, Some(&thread), 2), 7_000);
    assert_eq!(context_used(5_000, Some(&thread), 3), 5_000);
    assert_eq!(context_used(5_000, None, 1), 5_000);
}

#[tokio::test]
async fn rows_turn_needs_rows_for_history() {
    let cat = catalog(AiAccess::SchemaQueryRows);
    // Turn 1 sends rows for `orders`.
    let mut first = ask("Why are orders slow?", None);
    first.switches.rows = true;
    let (chat, events) = ask_once(&cat, &first).await;
    assert!(all_text(&chat).contains("zq-cell-7731"));
    let sent_stamp = memory_of(&events);
    assert!(
        sent_stamp.kinds.contains(&ItemKind::Rows),
        "{:?}",
        sent_stamp.kinds
    );
    assert!(sent_of(&events).kinds.contains(&ItemKind::Rows));
    let at = now() - 5 * MIN;
    let rows_turn = Stamp {
        kinds: &sent_stamp.kinds,
        ..stamp(1)
    };
    let id = save(
        &cat,
        PLACE,
        turn(
            "Why are orders slow?",
            "Missing index on orders.",
            at,
            &rows_turn,
        ),
    );

    // Turn 2: the switch is off, so neither the question nor the answer of turn 1 goes.
    let second = ask("and customers?", Some(id));
    let (chat, _) = ask_once(&cat, &second).await;
    let all = all_text(&chat);
    assert!(!all.contains("Why are orders slow?"), "{all}");
    assert!(!all.contains("Missing index"), "{all}");
    let m = show(&cat, &second).await.memory.unwrap();
    assert_eq!((m.turns, m.blocked), (0, 2));

    // Turn 3: the switch is on again, so they go.
    let mut third = ask("and customers?", Some(id));
    third.switches.rows = true;
    let (chat, _) = ask_once(&cat, &third).await;
    let all = all_text(&chat);
    assert!(all.contains("Why are orders slow?"), "{all}");
    assert!(all.contains("Missing index"), "{all}");
    let m = show(&cat, &third).await.memory.unwrap();
    assert_eq!((m.turns, m.blocked), (1, 0));
}

#[tokio::test]
async fn a_turn_without_rows_is_not_gated_as_one() {
    // The switch is on but nothing is named: no rows went, so no Rows kind.
    let cat = catalog(AiAccess::SchemaQueryRows);
    let mut first = ask("How many are there?", None);
    first.focus.tables = Vec::new();
    first.switches.rows = true;
    let (_, events) = ask_once(&cat, &first).await;
    assert!(!memory_of(&events).kinds.contains(&ItemKind::Rows));
    assert!(!sent_of(&events).kinds.contains(&ItemKind::Rows));
    assert_eq!(
        cat.sample_reads.load(std::sync::atomic::Ordering::SeqCst),
        0
    );
}

// Spec 6: the Asked in stamp, kept with the question and replayed through the gate.

fn shop_step(verb: StepVerb, names: &[&str], ago_ms: i64) -> StepIn {
    StepIn {
        at: now() - ago_ms,
        verb,
        tab: "visual".into(),
        title: Some("Orders over 1M".into()),
        connection_id: Some(conn_id()),
        database: Some("shop".into()),
        schema: None,
        names: names.iter().map(|n| n.to_string()).collect(),
        more: 0,
        count: Some(1),
        has_more: false,
        failed: false,
        descending: false,
        source_connection_id: None,
    }
}

/// A turn as the panel stores it from an Ask's stamp: the Asked in on the question only.
fn stamped_turn(q: &str, a: &str, at: i64, s: &TurnStamp) -> Vec<AiMessage> {
    let m = |role, text: &str, at| AiMessage {
        role,
        text: text.into(),
        context: Vec::new(),
        at,
        record: None,
        topic: Some(s.topic),
        connection_id: s.connection_id,
        database: s.database.clone(),
        kinds: s.kinds.clone(),
        tables: s.tables.clone(),
        action: Some(s.action.clone()),
        asked_in: None,
    };
    let mut question = m(AiRole::User, q, at);
    question.asked_in = s.asked_in.clone();
    vec![question, m(AiRole::Assistant, a, at + 1_000)]
}

fn visual_asked(also: Vec<ConnectionId>) -> AskedIn {
    AskedIn {
        tab: "visual".into(),
        label: "Visual Query in shop".into(),
        summary: "tables orders; ticked orders.id".into(),
        steps: vec!["opened Visual Query in shop".into()],
        also,
        other_steps: Vec::new(),
        tab_key: None,
    }
}

/// A turn of Topic 1 asked on a Visual Query tab, minutes ago.
fn asked_turn(
    q: &str,
    a: &str,
    at: i64,
    database: &str,
    also: Vec<ConnectionId>,
) -> Vec<AiMessage> {
    let mut m = turn(
        q,
        a,
        at,
        &Stamp {
            database,
            kinds: &[
                ItemKind::Question,
                ItemKind::Names,
                ItemKind::Cards,
                ItemKind::Tab,
            ],
            ..stamp(1)
        },
    );
    m[0].asked_in = Some(visual_asked(also));
    m
}

/// The request's boundary, read from its turn.
fn boundary_of(chat: &ChatRequest) -> String {
    let turn = &chat.messages.last().unwrap().text;
    let at = turn.find("context id=").expect("a framed turn") + "context id=".len();
    turn[at..at + 16].to_string()
}

#[tokio::test]
async fn past_turn_replays_asked_in_framed() {
    let cat = catalog(AiAccess::Schema);
    let t = now() - 10 * MIN;
    let mut messages = asked_turn(
        "How many orders today?",
        "About 40 orders.",
        t,
        "shop",
        Vec::new(),
    );
    messages.extend(turn(
        "And yesterday?",
        "52 orders yesterday.",
        t + 2 * MIN,
        &stamp(1),
    ));
    let id = save(&cat, PLACE, messages);
    let req = ask("And last week?", Some(id));

    let (chat, _) = ask_once(&cat, &req).await;
    assert_eq!(chat.messages.len(), 5);
    let b = boundary_of(&chat);
    // Framed as the turn is, with the same boundary, then the question.
    assert_eq!(
        chat.messages[0].text,
        format!(
            "<<contura:context id={b}>>\n\
             {{\"source\":\"asked_in\",\"text\":\"Visual Query in shop: tables orders; ticked orders.id\"}}\n\
             {{\"source\":\"asked_in\",\"text\":\"steps before it: opened Visual Query in shop\"}}\n\
             <</contura:context id={b}>>\n\nQuestion: How many orders today?"
        )
    );
    // A turn without an Asked in goes as today: plain text.
    let texts: Vec<&str> = chat.messages.iter().map(|m| m.text.as_str()).collect();
    assert_eq!(
        texts[1..4],
        ["About 40 orders.", "And yesterday?", "52 orders yesterday."]
    );

    // The preview shows the same, and the Thread row counts the framed question.
    let p = show(&cat, &req).await;
    assert_eq!(same_boundary(&p.exact), same_boundary(&exact_of(&chat)));
    let thread = row(&p, ItemKind::History).unwrap();
    assert_eq!(thread.label, "Thread · 2 turns");
    let sent: usize = chat.messages[..4].iter().map(|m| m.text.len()).sum();
    assert_eq!(thread.bytes as usize, sent);
}

#[tokio::test]
async fn lowered_access_holds_asked_in_turn() {
    let mut cat = catalog(AiAccess::SchemaQuery);
    // An Ask on a query tab at query text: its title went, so the stamp carries `sql`
    // though no query text item went.
    let mut first = ask("find orders over 1M", None);
    first.tab = Some(AskTab::Query {
        title: "Orders over 1M".into(),
    });
    first.steps = vec![shop_step(StepVerb::VqTable, &["orders"], MIN)];
    let (_, events) = ask_once(&cat, &first).await;
    let s = memory_of(&events);
    let asked = s.asked_in.clone().expect("an Asked in");
    assert_eq!(asked.label, "Query tab \"Orders over 1M\" in shop");
    assert!(!asked.steps.is_empty(), "{asked:?}");
    assert!(
        s.kinds.contains(&ItemKind::Tab) && s.kinds.contains(&ItemKind::Sql),
        "{:?}",
        s.kinds
    );
    let id = save(
        &cat,
        PLACE,
        stamped_turn(
            "find orders over 1M",
            "Filter on total.",
            now() - 5 * MIN,
            &s,
        ),
    );
    let req = ask("and per customer?", Some(id));

    // At the access it was written at, it goes framed.
    let (chat, _) = ask_once(&cat, &req).await;
    let all = all_text(&chat);
    assert!(all.contains("find orders over 1M"), "{all}");
    assert!(
        all.contains(r#""source":"asked_in","text":"Query tab \"Orders over 1M\" in shop""#),
        "{all}"
    );

    // Lowered to Schema only: the whole turn stays, counted as held back.
    cat.configs[0].ai_access = AiAccess::Schema;
    let (chat, _) = ask_once(&cat, &req).await;
    assert_eq!(roles(&chat), [ChatRole::User]);
    let all = all_text(&chat);
    assert!(!all.contains("find orders over 1M"), "{all}");
    assert!(!all.contains("Orders over 1M"), "{all}");
    assert!(!all.contains(r#""source":"asked_in""#), "{all}");
    let p = show(&cat, &req).await;
    let m = p.memory.clone().unwrap();
    assert_eq!((m.turns, m.blocked), (0, 2));
}

/// Ruling 1: a turn asked on another database of the Ask's Connection replays, its Asked
/// in framed with it.
#[tokio::test]
async fn another_database_turn_is_replayed() {
    let cat = catalog(AiAccess::SchemaQuery);
    let t = now() - 5 * MIN;
    let id = save(
        &cat,
        PLACE,
        asked_turn(
            "orders in staging?",
            "12 orders.",
            t,
            "shop_staging",
            Vec::new(),
        ),
    );
    let req = ask("and in shop?", Some(id));
    let (chat, _) = ask_once(&cat, &req).await;
    assert_eq!(
        roles(&chat),
        [ChatRole::User, ChatRole::Assistant, ChatRole::User]
    );
    let all = all_text(&chat);
    assert!(all.contains("orders in staging?"), "{all}");
    assert!(all.contains("12 orders."), "{all}");
    assert!(
        chat.messages[0]
            .text
            .contains(r#"{"source":"asked_in","text":"Visual Query in shop: tables orders; ticked orders.id"}"#),
        "{}",
        chat.messages[0].text
    );
    let m = show(&cat, &req).await.memory.unwrap();
    assert_eq!((m.turns, m.blocked), (1, 0));
}

/// A second Connection in the test catalog.
fn kestrel(id: ConnectionId, access: AiAccess) -> ConnectionConfig {
    ConnectionConfig {
        id,
        name: "Kestrel staging".into(),
        ..shop_conn(access)
    }
}

/// `turn`, stamped on Connection `on` (`None`: Home).
fn turn_on(
    q: &str,
    a: &str,
    at: i64,
    on: Option<ConnectionId>,
    kinds: &'static [ItemKind],
) -> Vec<AiMessage> {
    let mut m = turn(
        q,
        a,
        at,
        &Stamp {
            kinds,
            tables: &[],
            ..stamp(1)
        },
    );
    for x in &mut m {
        x.connection_id = on;
        if on.is_none() {
            x.database = None;
        }
    }
    m
}

/// Decision 2: a turn on another Connection is gated at that Connection's own current
/// access, not the Ask's: asked from A at Never, B's turn at Schema goes.
#[tokio::test]
async fn another_connection_turn_goes_at_its_own_access() {
    let b = Uuid::from_u128(43);
    let mut cat = catalog(AiAccess::Never);
    cat.configs.push(kestrel(b, AiAccess::Schema));
    let id = save(
        &cat,
        PLACE,
        turn_on(
            "which tables hold invoices?",
            "invoices and lines.",
            now() - 5 * MIN,
            Some(b),
            &[ItemKind::Question, ItemKind::Cards],
        ),
    );
    let req = ask("and on shop?", Some(id));
    let (chat, _) = ask_once(&cat, &req).await;
    let all = all_text(&chat);
    assert!(all.contains("which tables hold invoices?"), "{all}");
    assert!(all.contains("invoices and lines."), "{all}");
    let m = show(&cat, &req).await.memory.unwrap();
    assert_eq!((m.turns, m.blocked), (1, 0));
}

/// Carried from Task 1 (it replaces `summary_gate_uses_the_closing_topics_own_connection`):
/// a turn on another Connection in the same thread stays out of the prompt once that
/// Connection no longer allows what it carried; the Ask's own turns still go, and Sends
/// counts nothing as held, since B is not the Ask's place.
#[tokio::test]
async fn a_connection_lowered_to_never_holds_only_its_own_turns() {
    let b = Uuid::from_u128(43);
    let mut cat = catalog(AiAccess::Schema);
    cat.configs.push(kestrel(b, AiAccess::SchemaQuery));
    let t = now() - 10 * MIN;
    let mut messages = turn("How many orders today?", "About 40.", t, &stamp(1));
    messages.extend(turn_on(
        "slow invoices query?",
        "Index invoices.due.",
        t + MIN,
        Some(b),
        &[ItemKind::Question, ItemKind::Cards, ItemKind::Sql],
    ));
    messages.extend(turn_on(
        "call me andrew",
        "Hi Andrew",
        t + 2 * MIN,
        Some(b),
        &[ItemKind::Question],
    ));
    messages.extend(turn(
        "And yesterday?",
        "52 yesterday.",
        t + 3 * MIN,
        &stamp(1),
    ));
    let id = save(&cat, PLACE, messages);
    let req = ask("and last week?", Some(id));

    let (chat, _) = ask_once(&cat, &req).await;
    let all = all_text(&chat);
    assert!(all.contains("slow invoices query?"), "{all}");
    assert!(all.contains("call me andrew"), "{all}");

    // B lowered below the query text its first turn carried: that turn is held.
    cat.configs[1].ai_access = AiAccess::Schema;
    let (chat, _) = ask_once(&cat, &req).await;
    let all = all_text(&chat);
    assert!(!all.contains("slow invoices query?"), "{all}");
    assert!(!all.contains("Index invoices.due."), "{all}");
    assert!(all.contains("call me andrew"), "{all}");

    // B at Never: every turn on B is held, the plain one too; A's turns go.
    cat.configs[1].ai_access = AiAccess::Never;
    let (chat, _) = ask_once(&cat, &req).await;
    let all = all_text(&chat);
    for held in [
        "slow invoices query?",
        "Index invoices.due.",
        "call me andrew",
        "Hi Andrew",
    ] {
        assert!(!all.contains(held), "{held}: {all}");
    }
    for sent in [
        "How many orders today?",
        "About 40.",
        "And yesterday?",
        "52 yesterday.",
    ] {
        assert!(all.contains(sent), "{sent}: {all}");
    }
    let p = show(&cat, &req).await;
    let m = p.memory.clone().unwrap();
    assert_eq!((m.turns, m.blocked), (2, 0));
    assert_eq!(same_boundary(&p.exact), same_boundary(&exact_of(&chat)));
}

/// Decision 2: a Home Ask (no Connection) gets each database turn its own Connection
/// allows now, and the Home turns; Sends counts none as held.
#[tokio::test]
async fn a_home_ask_gets_the_database_turns_their_connection_allows() {
    let cat = catalog(AiAccess::Schema);
    let t = now() - 10 * MIN;
    let mut messages = home_turn("call me andrew", "Hi Andrew", t);
    messages.extend(turn(
        "Which tables hold orders?",
        "orders.",
        t + MIN,
        &stamp(1),
    ));
    messages.extend(turn(
        "why is this select slow?",
        "Add an index.",
        t + 2 * MIN,
        &Stamp {
            kinds: &[ItemKind::Question, ItemKind::Cards, ItemKind::Sql],
            ..stamp(1)
        },
    ));
    let id = save(&cat, PLACE, messages);
    let req = home_ask("remember my name?", Some(id));

    let (chat, _) = ask_once(&cat, &req).await;
    let all = all_text(&chat);
    assert!(all.contains("call me andrew"), "{all}");
    assert!(all.contains("Which tables hold orders?"), "{all}");
    assert!(!all.contains("select slow"), "{all}");
    assert!(!all.contains("Add an index"), "{all}");
    let m = show(&cat, &req).await.memory.unwrap();
    assert_eq!((m.turns, m.blocked), (2, 0));
}

/// A deleted Connection is Never: its turns are held, a plain one too, and not counted.
#[tokio::test]
async fn a_deleted_connection_holds_its_turns() {
    let gone = Uuid::from_u128(44);
    let cat = catalog(AiAccess::Schema);
    let t = now() - 10 * MIN;
    let mut messages = turn_on(
        "tables on the old server?",
        "invoices.",
        t,
        Some(gone),
        &[ItemKind::Question, ItemKind::Names],
    );
    messages.extend(turn_on(
        "call me andrew",
        "Hi Andrew",
        t + MIN,
        Some(gone),
        &[ItemKind::Question],
    ));
    messages.extend(turn(
        "How many orders?",
        "About 40.",
        t + 2 * MIN,
        &stamp(1),
    ));
    let id = save(&cat, PLACE, messages);
    let req = ask("and today?", Some(id));
    let (chat, _) = ask_once(&cat, &req).await;
    let all = all_text(&chat);
    assert!(!all.contains("old server"), "{all}");
    assert!(!all.contains("call me andrew"), "{all}");
    assert!(all.contains("How many orders?"), "{all}");
    let m = show(&cat, &req).await.memory.unwrap();
    assert_eq!((m.turns, m.blocked), (1, 0));
}

#[tokio::test]
async fn turn_asked_across_two_connections_follows_the_lower_access() {
    let other = Uuid::from_u128(43);
    let mut cat = catalog(AiAccess::Schema);
    cat.configs.push(ConnectionConfig {
        id: other,
        name: "Kestrel staging".into(),
        ..shop_conn(AiAccess::Schema)
    });
    let t = now() - 5 * MIN;
    let id = save(
        &cat,
        PLACE,
        asked_turn("compare the two", "3 changed.", t, "shop", vec![other]),
    );
    let req = ask("which changed?", Some(id));
    let (chat, _) = ask_once(&cat, &req).await;
    assert!(all_text(&chat).contains("compare the two"));

    // The other Connection lowered to Never: held, though the Ask's own allows it.
    cat.configs[1].ai_access = AiAccess::Never;
    let (chat, _) = ask_once(&cat, &req).await;
    assert_eq!(roles(&chat), [ChatRole::User]);
    assert!(!all_text(&chat).contains("compare the two"));
    assert_eq!(show(&cat, &req).await.memory.unwrap().blocked, 2);

    // Deleted: the same.
    cat.configs.pop();
    let (chat, _) = ask_once(&cat, &req).await;
    assert_eq!(roles(&chat), [ChatRole::User]);
}

/// Task 3 ruling N4: a Continue extends an answer asked across another Connection, so its
/// stamp takes the continued question's other Connections (with its own, each once), and
/// the continued answer is held when that Connection is lowered, as the first one is.
#[tokio::test]
async fn continue_stamp_takes_the_continued_questions_other_connections() {
    let (b, c) = (Uuid::from_u128(43), Uuid::from_u128(44));
    let mut cat = catalog(AiAccess::Schema);
    for (id, name) in [(b, "Kestrel staging"), (c, "Kestrel archive")] {
        cat.configs.push(ConnectionConfig {
            id,
            name: name.into(),
            ..shop_conn(AiAccess::Schema)
        });
    }
    let id = save(
        &cat,
        PLACE,
        asked_turn(
            "compare the two",
            "3 changed: orders, refunds and",
            now() - 2 * MIN,
            "shop",
            vec![b],
        ),
    );
    // From a tab with no other Connection.
    let req = continue_ask(Some(id));
    let (_, events) = ask_once(&cat, &req).await;
    assert_eq!(memory_of(&events).asked_in.expect("an Asked in").also, [b]);
    assert_eq!(show(&cat, &req).await.stamp.asked_in.unwrap().also, [b]);

    // From a tab that spans another Connection itself: both, each once.
    let mut req = continue_ask(Some(id));
    req.focus.also = vec![c, b];
    let (_, events) = ask_once(&cat, &req).await;
    let mut also = memory_of(&events).asked_in.unwrap().also;
    also.sort();
    assert_eq!(also, [b, c]);

    // A plain Ask after it keeps its own stamp: no other Connection.
    let (_, events) = ask_once(&cat, &ask("and the totals?", Some(id))).await;
    assert_eq!(memory_of(&events).asked_in, None);
}

/// A turn asked on A whose Asked in keeps one step on B at Schema only and one at query
/// text, and one step on C.
fn turn_with_other_steps(b: ConnectionId, c: ConnectionId) -> Vec<AiMessage> {
    use contura_core::ai::memory::OtherStep;
    let mut m = asked_turn(
        "what did I just run?",
        "You ran Late orders.",
        now() - 5 * MIN,
        "shop",
        Vec::new(),
    );
    m[0].asked_in.as_mut().unwrap().other_steps = vec![
        OtherStep {
            connection_id: b,
            text: "opened Visual Query on another Connection".into(),
            level: AiAccess::Schema,
        },
        OtherStep {
            connection_id: b,
            text: "ran the Visual Query \"Late orders\" on another Connection, 3 rows".into(),
            level: AiAccess::SchemaQuery,
        },
        OtherStep {
            connection_id: c,
            text: "opened Query tab on another Connection".into(),
            level: AiAccess::Schema,
        },
    ];
    m
}

fn with_others(access: AiAccess, b: (ConnectionId, AiAccess), c: ConnectionId) -> Catalog {
    let mut cat = catalog(access);
    cat.configs.push(ConnectionConfig {
        id: b.0,
        name: "Kestrel staging".into(),
        ..shop_conn(b.1)
    });
    cat.configs.push(ConnectionConfig {
        id: c,
        name: "Kestrel archive".into(),
        ..shop_conn(AiAccess::Schema)
    });
    cat
}

/// The other Connections' steps line of the framed question, if one went.
fn other_steps_line(chat: &ChatRequest) -> Option<String> {
    let lead = r#"{"source":"asked_in","text":"steps on other Connections before it: "#;
    chat.messages
        .iter()
        .flat_map(|m| m.text.lines())
        .find(|l| l.starts_with(lead))
        .map(|l| l[lead.len()..l.len() - 2].to_string())
}

/// Task 5b, test 2: a stored step on B is replayed only while B still exists and its
/// current access reaches the level the step needed; the rest of the turn replays.
#[tokio::test]
async fn other_steps_replay_at_their_connection_current_access() {
    let (b, c) = (Uuid::from_u128(43), Uuid::from_u128(44));
    let mut cat = with_others(AiAccess::Schema, (b, AiAccess::SchemaQuery), c);
    let id = save(&cat, PLACE, turn_with_other_steps(b, c));
    let req = ask("and before that?", Some(id));
    let lines = |chat: &ChatRequest| {
        assert!(all_text(chat).contains("what did I just run?"));
        assert!(all_text(chat).contains("You ran Late orders."));
        assert!(all_text(chat).contains("steps before it: opened Visual Query in shop"));
        other_steps_line(chat)
    };

    // B at query text: every line goes.
    let (chat, _) = ask_once(&cat, &req).await;
    assert_eq!(
        lines(&chat).as_deref(),
        Some(
            r#"opened Visual Query on another Connection; ran the Visual Query \"Late orders\" on another Connection, 3 rows; opened Query tab on another Connection"#
        )
    );
    // The preview sends the same.
    assert_eq!(
        same_boundary(&show(&cat, &req).await.exact),
        same_boundary(&exact_of(&chat))
    );

    // B lowered to Schema only: its query-text line is dropped.
    cat.configs[1].ai_access = AiAccess::Schema;
    let (chat, _) = ask_once(&cat, &req).await;
    assert_eq!(
        lines(&chat).as_deref(),
        Some("opened Visual Query on another Connection; opened Query tab on another Connection")
    );
    assert!(!all_text(&chat).contains("3 rows"));

    // B at Never: none of B's lines.
    cat.configs[1].ai_access = AiAccess::Never;
    let (chat, _) = ask_once(&cat, &req).await;
    assert_eq!(
        lines(&chat).as_deref(),
        Some("opened Query tab on another Connection")
    );
    assert_eq!(show(&cat, &req).await.memory.unwrap().blocked, 0);

    // B deleted: the same.
    cat.configs.remove(1);
    let (chat, _) = ask_once(&cat, &req).await;
    assert_eq!(
        lines(&chat).as_deref(),
        Some("opened Query tab on another Connection")
    );
    // C deleted too: no line of other steps at all, the turn still replays.
    cat.configs.remove(1);
    let (chat, _) = ask_once(&cat, &req).await;
    assert_eq!(lines(&chat), None);
}

/// Task 5b, test 3: Continue replays the stored steps under the same check.
#[tokio::test]
async fn continue_regates_other_steps() {
    let (b, c) = (Uuid::from_u128(43), Uuid::from_u128(44));
    let mut cat = with_others(AiAccess::Schema, (b, AiAccess::SchemaQuery), c);
    let id = save(&cat, PLACE, turn_with_other_steps(b, c));
    let req = continue_ask(Some(id));
    let (chat, _) = ask_once(&cat, &req).await;
    assert!(
        chat.messages
            .last()
            .unwrap()
            .text
            .ends_with("Question: Continue")
    );
    assert!(other_steps_line(&chat).unwrap().contains("3 rows"));
    cat.configs[1].ai_access = AiAccess::Schema;
    let (chat, _) = ask_once(&cat, &req).await;
    assert_eq!(
        other_steps_line(&chat).as_deref(),
        Some("opened Visual Query on another Connection; opened Query tab on another Connection")
    );
    cat.configs.remove(1);
    let (chat, _) = ask_once(&cat, &req).await;
    assert_eq!(
        other_steps_line(&chat).as_deref(),
        Some("opened Query tab on another Connection")
    );
}

/// Task 5b, test 7: a thread stored before other steps loads and replays unchanged.
#[tokio::test]
async fn old_asked_in_without_other_steps_replays_unchanged() {
    let cat = catalog(AiAccess::Schema);
    let mut messages = asked_turn(
        "How many orders today?",
        "About 40 orders.",
        now() - 5 * MIN,
        "shop",
        Vec::new(),
    );
    // As an older build wrote it: no `otherSteps` key.
    let json = serde_json::to_string(&messages[0]).unwrap();
    assert!(!json.contains("otherSteps"));
    messages[0] = serde_json::from_str(&json).unwrap();
    let id = save(&cat, PLACE, messages);
    let (chat, _) = ask_once(&cat, &ask("And last week?", Some(id))).await;
    let b = boundary_of(&chat);
    assert_eq!(
        chat.messages[0].text,
        format!(
            "<<contura:context id={b}>>\n\
             {{\"source\":\"asked_in\",\"text\":\"Visual Query in shop: tables orders; ticked orders.id\"}}\n\
             {{\"source\":\"asked_in\",\"text\":\"steps before it: opened Visual Query in shop\"}}\n\
             <</contura:context id={b}>>\n\nQuestion: How many orders today?"
        )
    );
}

// Fix round 2 (re-review Critical): a closed Topic's row is rebuilt from the messages the
// thread still holds, but its summary text was written from all of them. Once a trim cuts
// the Topic's first turns, its summary is held.

const A_WORDS: [&str; 3] = ["zebra", "quokka", "secret_ledger"];

fn no_a(text: &str) {
    for w in A_WORDS {
        assert!(!text.contains(w), "{w} went: {text}");
    }
}

/// A turn of Topic `seq` on `on`'s `database`.
#[allow(clippy::too_many_arguments)]
fn topic_turn(
    q: &str,
    a: &str,
    at: i64,
    seq: u32,
    on: ConnectionId,
    database: &'static str,
    kinds: &'static [ItemKind],
    tables: &'static [&'static str],
) -> Vec<AiMessage> {
    let mut m = turn(
        q,
        a,
        at,
        &Stamp {
            topic: seq,
            database,
            kinds,
            tables,
        },
    );
    for x in &mut m {
        x.connection_id = Some(on);
    }
    m
}

/// A pre-D2 thread: closed Topic 1 opened by `first` then one plain turn on its place,
/// open Topic 2 on B with `n` turns. Saved through the real write path.
fn pre_d2(
    cat: &Catalog,
    first: Vec<AiMessage>,
    place: (ConnectionId, &'static str),
    n: usize,
) -> Uuid {
    let t0 = now() - 500 * MIN;
    let mut m = first;
    m.extend(topic_turn(
        "plain follow up?",
        "follow up ok.",
        t0 + MIN,
        1,
        place.0,
        place.1,
        &[ItemKind::Question],
        &["invoices"],
    ));
    let b = Uuid::from_u128(43);
    for i in 0..n {
        m.extend(topic_turn(
            &format!("B question {i}?"),
            &format!("B answer {i}."),
            t0 + (2 + i as i64) * MIN,
            2,
            b,
            "invoices",
            ASKED,
            &["invoices"],
        ));
    }
    save(cat, PLACE, m)
}

/// Grows the stored thread by one open-Topic turn on B, past MESSAGE_LIMIT.
fn trim_one_turn(cat: &Catalog, id: Uuid) -> AiThread {
    let mut th = cat.threads.thread(id).unwrap().unwrap();
    assert_eq!(th.messages.len(), contura_core::store::MESSAGE_LIMIT);
    th.messages.extend(topic_turn(
        "B question last?",
        "B answer last.",
        now() - MIN,
        2,
        Uuid::from_u128(43),
        "invoices",
        ASKED,
        &["invoices"],
    ));
    cat.threads.save_thread(&th).unwrap();
    cat.threads.thread(id).unwrap().unwrap()
}

fn b_ask(thread: Uuid) -> AskRequest {
    AskRequest {
        connection_id: Some(Uuid::from_u128(43)),
        database: Some("invoices".into()),
        focus: Focus {
            tables: vec![TableRef {
                schema: None,
                name: "invoices".into(),
            }],
            ..Focus::default()
        },
        ..ask("invoices and the follow up?", Some(thread))
    }
}

/// Every request the Ask sends and its preview: nothing of A's turn.
async fn asks_without_a(cat: &Catalog, req: &AskRequest) {
    let provider = ok_script();
    stream(&provider, cat, req).await;
    let seen = provider.seen.lock().unwrap().clone();
    assert!(!seen.is_empty());
    for c in &seen {
        no_a(&all_text(c));
    }
    no_a(&show(cat, req).await.exact);
}

#[tokio::test]
async fn a_trimmed_topic_opened_across_a_never_connection_stays_out() {
    let (a, b) = (conn_id(), Uuid::from_u128(43));
    let mut cat = catalog(AiAccess::Never);
    cat.configs.push(kestrel(b, AiAccess::Schema));
    // A Compare on B across A (A at Never): A's table, question and answer in its turn.
    let mut first = topic_turn(
        "compare the zebra ledger?",
        "quokka differs.",
        now() - 500 * MIN,
        1,
        b,
        "invoices",
        &[ItemKind::Question, ItemKind::Names, ItemKind::Cards],
        &["secret_ledger", "invoices"],
    );
    first[0].asked_in = Some(visual_asked(vec![a]));
    let id = pre_d2(&cat, first, (b, "invoices"), 98);
    let summary = cat.threads.topics(id).unwrap()[0].summary.clone();
    assert!(
        summary.contains("zebra") && summary.contains("secret_ledger"),
        "{summary}"
    );
    asks_without_a(&cat, &b_ask(id)).await;

    // The Compare turn is trimmed; Topic 1 survives with its plain turn and its summary.
    let stored = trim_one_turn(&cat, id);
    assert!(stored.messages.iter().all(|m| !m.text.contains("zebra")));
    let t1 = cat.threads.topics(id).unwrap()[0].clone();
    assert!(t1.summary.contains("zebra"), "{}", t1.summary);
    asks_without_a(&cat, &b_ask(id)).await;
    asks_without_a(&cat, &home_ask("any plain follow up?", Some(id))).await;
}

#[tokio::test]
async fn a_trimmed_topic_on_a_stays_out_of_b_and_home() {
    let (a, b) = (conn_id(), Uuid::from_u128(43));
    // A at Schema: its first turn carried query text, which A no longer allows.
    let mut cat = catalog(AiAccess::Schema);
    cat.configs.push(kestrel(b, AiAccess::Schema));
    let first = topic_turn(
        "why is the zebra query slow?",
        "quokka index on secret_ledger.",
        now() - 500 * MIN,
        1,
        a,
        "shop",
        &[ItemKind::Question, ItemKind::Cards, ItemKind::Sql],
        &["secret_ledger", "invoices"],
    );
    let id = pre_d2(&cat, first, (a, "shop"), 98);
    asks_without_a(&cat, &b_ask(id)).await;
    let stored = trim_one_turn(&cat, id);
    assert!(stored.messages.iter().all(|m| !m.text.contains("zebra")));
    asks_without_a(&cat, &b_ask(id)).await;
    asks_without_a(&cat, &home_ask("any plain follow up?", Some(id))).await;

    // A at Never: held by its own Connection, plain first turn or not.
    cat.configs[0].ai_access = AiAccess::Never;
    asks_without_a(&cat, &b_ask(id)).await;
    asks_without_a(&cat, &home_ask("any plain follow up?", Some(id))).await;
}
