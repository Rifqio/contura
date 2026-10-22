//! Thread memory in the preview and the Ask: the open Topic's recent turns and matching
//! earlier summaries go under the gate on history (R1.7), after cache mark 2, and the
//! preview shows exactly what the Ask sends (R1.6).

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use contura_core::Error;
use contura_core::ai::budget::PAYLOAD_CAP;
use contura_core::ai::compact::TOPIC_SUMMARY_MAX_TOKENS;
use contura_core::ai::context::store::{ContextStore, StoreContext};
use contura_core::ai::memory::store::StoreThreads;
use contura_core::ai::memory::{BreakReason, MemoryInfo, ThreadStore, TurnStamp, rule_summary};
use contura_core::ai::models::{ModelInfo, info_for};
use contura_core::ai::preview::{CatalogReader, Preview, PreviewItem, preview};
use contura_core::ai::provider::scripted::ScriptedProvider;
use contura_core::ai::provider::{ChatRequest, ChatRole, ProviderEvent, StopReason, Usage};
use contura_core::ai::rails::Secrets;
use contura_core::ai::request::{AskRequest, Focus, ItemKind, Switches, TableRef};
use contura_core::ai::sent::{AnswerRecord, SentRecord};
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

/// The Ask's own request. An Ask that closes a Topic may first make its one summary
/// call (`TOPIC_SUMMARY_MAX_TOKENS`); nothing else goes before it.
async fn ask_once(cat: &Catalog, req: &AskRequest) -> (ChatRequest, Vec<AiEvent>) {
    let provider = ok_script();
    let events = stream(&provider, cat, req).await;
    let seen = provider.seen.lock().unwrap();
    match seen.as_slice() {
        [ask] => (ask.clone(), events),
        [summary, ask] => {
            assert_eq!(summary.max_tokens, TOPIC_SUMMARY_MAX_TOKENS);
            (ask.clone(), events)
        }
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
        // The history gate blocks the only turn (another database).
        (
            "gate blocked",
            AskRequest {
                database: Some("other".into()),
                ..continue_ask(None)
            },
            AiAccess::Schema,
            turn("q", "a cut", now() - MIN, &stamp(1)),
        ),
        // The Topic broke by Idle.
        (
            "idle",
            continue_ask(None),
            AiAccess::Schema,
            turn("q", "a cut", now() - 3 * 60 * MIN, &stamp(1)),
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
    // Earlier turn passes the gate, the last pair is from another database: dropped.
    let other = Stamp {
        database: "other",
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

#[tokio::test]
async fn never_sends_no_history() {
    // A question-only turn needs no AI access, but at Never nothing of the thread goes.
    let cat = catalog(AiAccess::Never);
    let t = now() - 5 * MIN;
    let q = Stamp {
        kinds: &[ItemKind::Question],
        tables: &[],
        ..stamp(1)
    };
    let id = save(
        &cat,
        PLACE,
        turn("hello there", "hi, how can I help", t, &q),
    );
    let req = ask("what did I say?", Some(id));

    let (chat, _) = ask_once(&cat, &req).await;
    assert_eq!(roles(&chat), [ChatRole::User]);
    assert!(!all_text(&chat).contains("hello there"));

    let p = show(&cat, &req).await;
    assert!(row(&p, ItemKind::History).is_none());
    let m = p.memory.clone().unwrap();
    assert_eq!((m.turns, m.summaries), (0, 0));
}

#[tokio::test]
async fn two_databases_one_thread() {
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
    assert_eq!(roles(&chat), [ChatRole::User]);
    let all = all_text(&chat);
    assert!(!all.contains("Store 4"), "{all}");
    assert!(!all.contains("Late orders"), "{all}");
    assert!(!all.contains("About 40"), "{all}");
    let s = memory_of(&events);
    assert_eq!(
        (s.topic, s.opened, s.reason),
        (3, true, Some(BreakReason::Place))
    );
    assert_eq!(s.database.as_deref(), Some("shop_archive"));

    let p = show(&cat, &req).await;
    assert!(row(&p, ItemKind::History).is_none(), "{:?}", p.items);
    let m = p.memory.clone().unwrap();
    assert_eq!((m.turns, m.summaries), (0, 0));
    // Another database is not lower AI access: Sends must not say so.
    assert_eq!(m.blocked, 0);
}

#[tokio::test]
async fn idle_break_sends_earlier_topic_summary_on_overlap() {
    let cat = catalog(AiAccess::Schema);
    let t = now() - 3 * 60 * MIN;
    // Topic 1 on orders, closed (it has a rule summary); Topic 2 on customers, open.
    let mut messages = turn("Which orders are late?", "Orders 7 and 9.", t, &stamp(1));
    let customers = Stamp {
        tables: &["customers"],
        ..stamp(2)
    };
    messages.extend(turn(
        "Customers without email",
        "Three of them.",
        t + MIN,
        &customers,
    ));
    let id = save(&cat, PLACE, messages);
    let topics = cat.threads.topics(id).unwrap();
    let summary = topics[0].summary.clone();
    assert!(!summary.is_empty());

    // Hours later: the open Topic is idle, so a new one opens.
    let mut req = ask("orders late this week?", Some(id));
    req.focus.tables = vec![TableRef {
        schema: None,
        name: "orders".into(),
    }];
    // Shown before the Ask: Topic 1, and Topic 2 (this Ask closes it) by its rule
    // summary, since the Ask sends customers in full too.
    let p = show(&cat, &req).await;
    assert_eq!(
        row(&p, ItemKind::History).unwrap().label,
        "Thread · 2 summaries"
    );
    let m = p.memory.clone().unwrap();
    assert_eq!((m.turns, m.summaries), (0, 2));

    let (chat, events) = ask_once(&cat, &req).await;
    assert_eq!(roles(&chat), [ChatRole::User], "no turns of a closed Topic");
    let s = memory_of(&events);
    assert_eq!(
        (s.topic, s.opened, s.reason),
        (3, true, Some(BreakReason::Idle))
    );
    let line = serde_json::to_string(&serde_json::json!({
        "source": "history",
        "text": format!("Earlier topic \"Which orders are late?\" ({}): {summary}", topics[0].first_at),
    }))
    .unwrap();
    // Topic 2 goes by the summary the model wrote in this Ask ("ok"), newest first.
    let closing = serde_json::to_string(&serde_json::json!({
        "source": "history",
        "text": format!("Earlier topic \"Customers without email\" ({}): ok", topics[1].first_at),
    }))
    .unwrap();
    let turn = &chat.messages[0].text;
    assert!(turn.contains(&line), "{turn}");
    // The summaries go first in the framed block.
    let block = turn.split_once('\n').unwrap().1;
    assert!(block.starts_with(&format!("{closing}\n{line}")), "{turn}");
    assert!(!turn.contains("Three of them"), "{turn}");
    assert_eq!(
        turn.matches("\"source\":\"history\"").count(),
        2,
        "the Ask sends as many summaries as the preview showed: {turn}"
    );
}

#[tokio::test]
async fn idle_break_sends_the_closing_topic_on_overlap() {
    let cat = catalog(AiAccess::Schema);
    let t = now() - 3 * 60 * MIN;
    // One Topic on orders, idle for hours: the next Ask on orders closes it.
    let messages = turn("Which orders are late?", "Orders 7 and 9.", t, &stamp(1));
    let id = save(&cat, PLACE, messages.clone());
    assert!(
        cat.threads.topics(id).unwrap()[0].summary.is_empty(),
        "still open"
    );
    let refs: Vec<&AiMessage> = messages.iter().collect();
    let rules = rule_summary(&refs);
    let head = format!("Earlier topic \"Which orders are late?\" ({t})");

    let req = ask("orders late this week?", Some(id));
    // The preview shows the closing Topic's rule summary.
    let p = show(&cat, &req).await;
    assert_eq!(
        row(&p, ItemKind::History).unwrap().label,
        "Thread · 1 summary"
    );
    let shown = serde_json::to_string(&serde_json::json!({
        "source": "history",
        "text": format!("{head}: {rules}"),
    }))
    .unwrap();
    assert!(p.exact.contains(&shown), "{}", p.exact);

    // The Ask summarises it by the model first, then sends that summary instead.
    let (chat, events) = ask_once(&cat, &req).await;
    let s = memory_of(&events);
    assert_eq!((s.topic, s.reason), (2, Some(BreakReason::Idle)));
    let turn = &chat.messages.last().unwrap().text;
    let line = serde_json::to_string(&serde_json::json!({
        "source": "history",
        "text": format!("{head}: ok"),
    }))
    .unwrap();
    assert!(turn.contains(&line), "{turn}");
    assert!(!turn.contains(&rules), "{turn}");
    assert_eq!(
        roles(&chat),
        [ChatRole::User],
        "no raw turns of a closed Topic"
    );

    // With the Summary row off the rule summary goes, as the preview showed.
    let mut off = req.clone();
    off.off = vec![ItemKind::Summary];
    let id = save(&cat, PLACE, messages.clone());
    off.thread_id = Some(id);
    let (chat, _) = ask_once(&cat, &off).await;
    let turn = &chat.messages.last().unwrap().text;
    assert!(turn.contains(&rules), "{turn}");

    // The gate still holds: a closing Topic that sent query text stays at Schema.
    let sql = Stamp {
        kinds: &[ItemKind::Question, ItemKind::Cards, ItemKind::Sql],
        ..stamp(1)
    };
    let id = save(&cat, PLACE, turn_of(&sql, t));
    let mut req = ask("orders late this week?", Some(id));
    req.request_id = "r3".into();
    let p = show(&cat, &req).await;
    assert!(row(&p, ItemKind::History).is_none(), "{:?}", p.items);
    assert_eq!(p.memory.clone().unwrap().blocked, 2);
    let (chat, _) = ask_once(&cat, &req).await;
    assert!(!all_text(&chat).contains("Which orders are late?"));
}

fn turn_of(s: &Stamp, t: i64) -> Vec<AiMessage> {
    turn("Which orders are late?", "Orders 7 and 9.", t, s)
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
