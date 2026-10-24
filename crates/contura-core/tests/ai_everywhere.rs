//! Ask everywhere, end to end (spec section 11): a question asked in a Visual Query, then
//! one asked in New table after a few more steps. The second Ask knows where the first was
//! asked and what the user did in between, at each AI access level, and the preview shows
//! exactly what it sends (R1.6). Made-up data only; the provider is scripted.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use contura_core::ai::compact::TOPIC_SUMMARY_MAX_TOKENS;
use contura_core::ai::context::store::{ContextStore, StoreContext};
use contura_core::ai::memory::store::StoreThreads;
use contura_core::ai::memory::{AskedIn, OtherStep};
use contura_core::ai::memory::{ThreadStore, TurnStamp};
use contura_core::ai::models::{ModelInfo, info_for};
use contura_core::ai::preview::{CatalogReader, Preview, SameProvider, preview};
use contura_core::ai::provider::scripted::ScriptedProvider;
use contura_core::ai::provider::{ChatRequest, ChatRole, ProviderEvent, StopReason};
use contura_core::ai::rails::Secrets;
use contura_core::ai::request::{AskRequest, Focus, ItemKind, Switches, TableRef};
use contura_core::ai::scene::{AskTab, CompareSide, DiffLine};
use contura_core::ai::steps::{StepIn, StepVerb};
use contura_core::ai::stream::{AiEvent, ask_stream};
use contura_core::ai::{
    AiAccess, AiMessage, AiProviderKind, AiRole, AiService, AiSettings, AiThread, KeyChange,
};
use contura_core::compare::diff::{DiffKind, DiffObject};
use contura_core::model::{ConnectionConfig, ConnectionId, DialectKind, ObjectPath, Page, SslMode};
use contura_core::schema_model::{SchemaModel, SmColumn, SmEndpoint, SmRef, SmTable};
use contura_core::secrets::MemorySecretStore;
use contura_core::store::AppStore;
use contura_core::visual_query::{GroupBy, VisualQuery, VqColumn, VqTable};
use uuid::Uuid;

const PLACE: &str = "ungrouped";
const MIN: i64 = 60_000;
const ASK_1: &str = "find orders over 1M";
const ASK_2: &str = "make a pivot table for monthly totals per customer";
/// The first answer, as the user got it. It names no value, so a value in Ask 2 could only
/// come from somewhere it must not.
const ANSWER_1: &str = "Add a filter on orders.total greater than one million, then run it.";
const VQ_SQL: &str = "SELECT orders.id, orders.customer_id, orders.total FROM orders";

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn hope() -> ConnectionId {
    Uuid::from_u128(4)
}

/// `hope-4`: MySQL, database `shop`.
fn hope_4(access: AiAccess) -> ConnectionConfig {
    ConnectionConfig {
        id: hope(),
        name: "hope-4".into(),
        dialect: DialectKind::MySql,
        host: "db.kestrel.internal".into(),
        port: 3306,
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

fn col(name: &str, type_name: &str, pk: bool) -> SmColumn {
    SmColumn {
        name: name.into(),
        type_name: type_name.into(),
        pk,
        increment: false,
        not_null: pk,
        unique: false,
        default: None,
        note: None,
    }
}

fn table(name: &str, columns: Vec<SmColumn>) -> SmTable {
    SmTable {
        schema: None,
        name: name.into(),
        alias: None,
        note: None,
        columns,
        indexes: Vec::new(),
    }
}

/// `orders(id, customer_id, total decimal(14,2), created_at datetime)` and
/// `customers(id, name)`, with the foreign key between them.
fn shop_schema() -> SchemaModel {
    SchemaModel {
        dialect: DialectKind::MySql,
        tables: vec![
            table(
                "orders",
                vec![
                    col("id", "int", true),
                    col("customer_id", "int", false),
                    col("total", "decimal(14,2)", false),
                    col("created_at", "datetime", false),
                ],
            ),
            table(
                "customers",
                vec![col("id", "int", true), col("name", "varchar(80)", false)],
            ),
        ],
        refs: vec![SmRef {
            name: None,
            from: SmEndpoint {
                schema: None,
                table: "orders".into(),
                columns: vec!["customer_id".into()],
            },
            to: SmEndpoint {
                schema: None,
                table: "customers".into(),
                columns: vec!["id".into()],
            },
            on_delete: None,
            on_update: None,
        }],
        enums: Vec::new(),
        skipped: Vec::new(),
    }
}

struct Catalog {
    configs: Vec<ConnectionConfig>,
    context: StoreContext,
    threads: StoreThreads,
}

#[async_trait::async_trait]
impl CatalogReader for Catalog {
    async fn sample_rows(
        &self,
        _id: ConnectionId,
        _path: &ObjectPath,
        _limit: u32,
    ) -> contura_core::Result<Page> {
        panic!("no rows are read below Plus sample rows");
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
        Ok(shop_schema())
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

fn catalog(access: AiAccess) -> Catalog {
    Catalog {
        configs: vec![hope_4(access)],
        context: StoreContext::new(mem()),
        threads: StoreThreads::new(mem()),
    }
}

impl Catalog {
    fn set_access(&mut self, access: AiAccess) {
        self.configs[0].ai_access = access;
    }
}

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

fn step(verb: StepVerb, tab: &str, names: &[&str], count: Option<u64>, ago: i64) -> StepIn {
    StepIn {
        at: now() - ago,
        verb,
        tab: tab.into(),
        title: (tab == "visual").then(|| "Untitled 1".into()),
        connection_id: Some(hope()),
        database: Some("shop".into()),
        schema: None,
        names: names.iter().map(|n| n.to_string()).collect(),
        more: 0,
        count,
        has_more: false,
        failed: false,
        descending: false,
        source_connection_id: None,
    }
}

fn request(question: &str, thread: Option<Uuid>) -> AskRequest {
    AskRequest {
        request_id: Uuid::new_v4().to_string(),
        place: PLACE.into(),
        group_id: None,
        connection_id: Some(hope()),
        database: Some("shop".into()),
        schema: None,
        action: "ask".into(),
        question: question.into(),
        thread_id: thread,
        focus: Focus::default(),
        switches: Switches::default(),
        off: Vec::new(),
        model: None,
        picks: None,
        tab: None,
        steps: Vec::new(),
    }
}

/// Spec 11 steps 1 and 2: a Visual Query on `shop` with `orders` on the canvas and three
/// columns ticked, asked minutes ago after three steps.
fn ask_1() -> AskRequest {
    let tick = |column: &str| VqColumn {
        table: "t0".into(),
        column: column.into(),
        alias: None,
        aggregate: None,
    };
    let mut req = request(ASK_1, None);
    req.focus.sql = Some(VQ_SQL.into());
    req.focus.tables = vec![TableRef {
        schema: None,
        name: "orders".into(),
    }];
    req.tab = Some(AskTab::Visual {
        title: "Untitled 1".into(),
        model: VisualQuery {
            version: 1,
            database: Some("shop".into()),
            dialect: None,
            tables: vec![VqTable {
                id: "t0".into(),
                schema: None,
                name: "orders".into(),
                alias: String::new(),
                x: 0.0,
                y: 0.0,
            }],
            joins: Vec::new(),
            columns: vec![tick("id"), tick("customer_id"), tick("total")],
            filters: Vec::new(),
            group_by: GroupBy::Auto,
            order_by: Vec::new(),
            limit: None,
            distinct: false,
        },
        sql_written: true,
        problems: 0,
        last_run: None,
    });
    req.steps = vec![
        step(StepVerb::OpenTab, "visual", &[], None, 2 * MIN),
        step(StepVerb::VqTable, "visual", &["orders"], None, 2 * MIN),
        step(
            StepVerb::VqTick,
            "visual",
            &["orders.id", "orders.customer_id", "orders.total"],
            None,
            2 * MIN,
        ),
    ];
    req
}

/// Spec 11 steps 3 to 5: a filter added and run in the Visual Query, then New table on
/// `shop`, asked in that tab.
fn ask_2(thread: Uuid) -> AskRequest {
    let mut req = request(ASK_2, Some(thread));
    req.tab = Some(AskTab::Design {
        create: true,
        path: ObjectPath {
            database: "shop".into(),
            schema: None,
            name: "new_table".into(),
        },
        columns: Vec::new(),
        primary: Vec::new(),
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        removed: Vec::new(),
        comment: None,
        types: vec![
            "int".into(),
            "bigint".into(),
            "decimal(p,s)".into(),
            "date".into(),
        ],
    });
    req.steps = vec![
        step(
            StepVerb::VqFilter,
            "visual",
            &["orders.total"],
            None,
            3 * MIN,
        ),
        step(StepVerb::RunVisual, "visual", &[], Some(1), 3 * MIN),
        step(StepVerb::OpenTab, "newTable", &[], None, 0),
    ];
    req
}

fn ok_script() -> ScriptedProvider {
    ScriptedProvider::new(vec![
        Ok(ProviderEvent::Text("ok".into())),
        Ok(ProviderEvent::Stop(StopReason::End)),
    ])
}

/// The Ask's own request and its events. A summary call may go first; nothing else.
async fn ask_once(cat: &dyn CatalogReader, req: &AskRequest) -> (ChatRequest, Vec<AiEvent>) {
    let provider = ok_script();
    let events = Mutex::new(Vec::new());
    let emit = |e: AiEvent| events.lock().unwrap().push(e);
    ask_stream(
        &provider,
        cat,
        &settings(),
        &model(),
        &Secrets::default(),
        req,
        &emit,
    )
    .await
    .unwrap();
    let seen = provider.seen.lock().unwrap();
    let chat = match seen.as_slice() {
        [ask] => ask.clone(),
        [summary, ask] => {
            assert_eq!(summary.max_tokens, TOPIC_SUMMARY_MAX_TOKENS);
            ask.clone()
        }
        other => panic!("{} requests", other.len()),
    };
    (chat, events.into_inner().unwrap())
}

async fn show(cat: &dyn CatalogReader, req: &AskRequest) -> Preview {
    preview(cat, &settings(), &model(), &Secrets::default(), req)
        .await
        .unwrap()
}

fn stamp_of(events: &[AiEvent]) -> TurnStamp {
    events
        .iter()
        .find_map(|e| match e {
            AiEvent::Memory { stamp } => Some(stamp.clone()),
            _ => None,
        })
        .expect("a Memory event")
}

/// The turn as the panel stores it from the stamp: the Asked in on the question only.
fn stored_turn(q: &str, a: &str, at: i64, s: &TurnStamp) -> Vec<AiMessage> {
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

/// Asks the first question at the catalog's access, stores its turn with the stamp it
/// emitted, and returns the thread and that stamp.
async fn first_turn(cat: &Catalog) -> (Uuid, TurnStamp, ChatRequest) {
    let (chat, events) = ask_once(cat, &ask_1()).await;
    let stamp = stamp_of(&events);
    let id = Uuid::new_v4();
    cat.threads
        .save_thread(&AiThread {
            id,
            place: PLACE.into(),
            title: ASK_1.into(),
            messages: stored_turn(ASK_1, ANSWER_1, now() - 4 * MIN, &stamp),
            updated_at: now(),
        })
        .unwrap();
    (id, stamp, chat)
}

/// Every text the request carries, joined.
fn all_text(chat: &ChatRequest) -> String {
    let mut out: Vec<&str> = chat.system.iter().map(|b| b.text.as_str()).collect();
    out.extend(chat.messages.iter().map(|m| m.text.as_str()));
    out.join("\n")
}

/// The framed lines of `source` in `text`, each item's text.
fn framed(text: &str, source: &str) -> Vec<String> {
    let lead = format!(r#"{{"source":"{source}","#);
    text.lines()
        .filter(|l| l.starts_with(&lead))
        .map(|l| {
            let v: serde_json::Value = serde_json::from_str(l).unwrap();
            v["text"].as_str().unwrap().to_string()
        })
        .collect()
}

/// The steps that went, without their age: `(3 min ago) ran ...` gives `ran ...`.
fn step_labels(turn: &str) -> Vec<String> {
    framed(turn, "steps")
        .iter()
        .flat_map(|t| t.lines().map(str::to_string).collect::<Vec<_>>())
        .map(|l| l.split_once(") ").unwrap().1.to_string())
        .collect()
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

/// "Show exactly" rebuilt from a request: the schema block, each history message after its
/// role line, then the turn.
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

/// Spec 11 at Schema and query text (L2): the New table Ask knows the Visual Query turn,
/// where it was asked, and the three steps since, in one Topic.
#[tokio::test]
async fn visual_query_then_new_table() {
    let cat = catalog(AiAccess::SchemaQuery);
    let (thread, first, chat_1) = first_turn(&cat).await;

    // Ask 1 sent the Visual Query as This tab, its SQL masked, and its three steps.
    let turn_1 = &chat_1.messages.last().unwrap().text;
    assert_eq!(
        framed(turn_1, "tab"),
        ["Visual Query \"Untitled 1\" in shop\n\
          tables: orders\n\
          ticked: orders.id, orders.customer_id, orders.total\n\
          SQL: written"]
    );
    assert_eq!(
        step_labels(turn_1),
        [
            "opened Visual Query \"Untitled 1\" in shop",
            "added orders to the Visual Query",
            "ticked orders.id, orders.customer_id, orders.total",
        ]
    );
    let asked = first.asked_in.clone().expect("an Asked in");
    assert_eq!(asked.tab, "visual");
    assert_eq!(asked.label, "Visual Query \"Untitled 1\" in shop");
    assert_eq!(
        asked.summary,
        "tables orders; ticked orders.id, orders.customer_id, orders.total"
    );
    assert_eq!(asked.steps.len(), 3);
    for kind in [ItemKind::Tab, ItemKind::Steps, ItemKind::Sql] {
        assert!(first.kinds.contains(&kind), "{kind:?} in {:?}", first.kinds);
    }

    let req = ask_2(thread);
    let (chat, events) = ask_once(&cat, &req).await;
    let second = stamp_of(&events);

    // The history: Ask 1's question framed with its Asked in, then its answer.
    assert_eq!(
        chat.messages.iter().map(|m| m.role).collect::<Vec<_>>(),
        [ChatRole::User, ChatRole::Assistant, ChatRole::User]
    );
    let past = &chat.messages[0].text;
    assert_eq!(
        framed(past, "asked_in"),
        [
            "Visual Query \"Untitled 1\" in shop: tables orders; ticked orders.id, orders.customer_id, orders.total".to_string(),
            format!("steps before it: {}", asked.steps.join("; ")),
        ]
    );
    assert!(past.ends_with(&format!("Question: {ASK_1}")), "{past}");
    assert_eq!(chat.messages[1].text, ANSWER_1);

    // The turn: New table as This tab, the three steps since, oldest first.
    let turn = &chat.messages[2].text;
    let tab = framed(turn, "tab");
    assert_eq!(tab.len(), 1);
    assert!(
        tab[0].starts_with("New table \"new_table\" in shop\ndialect: MySQL\n"),
        "{}",
        tab[0]
    );
    assert!(
        tab[0].contains("\ntables in shop: customers, orders"),
        "{}",
        tab[0]
    );
    assert_eq!(
        step_labels(turn),
        [
            "added a filter on orders.total",
            "ran the Visual Query \"Untitled 1\", 1 row",
            "opened New table in shop",
        ]
    );
    let ages: Vec<String> = framed(turn, "steps")[0]
        .lines()
        .map(|l| l.split_once(") ").unwrap().0.to_string())
        .collect();
    assert_eq!(ages, ["(3 min ago", "(3 min ago", "(just now"]);
    // No query text: the designer has none.
    assert!(framed(turn, "sql").is_empty(), "{turn}");
    assert!(turn.ends_with(&format!("Question: {ASK_2}")), "{turn}");

    // The schema block has both tables: `orders` from the steps, `customers` by its key.
    let schema = &chat.system[1].text;
    assert!(schema.contains("orders("), "{schema}");
    assert!(schema.contains("customers("), "{schema}");

    // No value anywhere: the filter's 1,000,000 never left the canvas.
    let all = all_text(&chat);
    assert!(!all.contains("1000000"), "{all}");
    assert!(!all.contains("1,000,000"), "{all}");
    assert!(!all.contains("hope-4"), "a Connection name went: {all}");

    // One Topic: the steps name `orders`, as the open Topic does.
    assert_eq!(second.topic, first.topic);
    let memory = show(&cat, &req).await.memory.unwrap();
    assert!(!memory.opened, "{memory:?}");
    assert_eq!(memory.reason, None);
    assert_eq!((memory.turns, memory.blocked), (1, 0));
    // Asked in New table, with the steps that went.
    let asked = second.asked_in.unwrap();
    assert_eq!(
        (asked.tab.as_str(), asked.label.as_str()),
        ("design", "New table \"new_table\" in shop")
    );
    assert_eq!(asked.steps.len(), 3);
}

/// Spec 11, the same run at Schema only (L1): no query text, no titles, no counts, and the
/// Visual Query turn still replays.
#[tokio::test]
async fn same_run_at_schema_only() {
    let cat = catalog(AiAccess::Schema);
    let (thread, first, chat_1) = first_turn(&cat).await;
    let turn_1 = &chat_1.messages.last().unwrap().text;
    assert!(framed(turn_1, "sql").is_empty(), "{turn_1}");
    let tab = framed(turn_1, "tab");
    assert!(tab[0].starts_with("Visual Query in shop\n"), "{}", tab[0]);
    assert!(!turn_1.contains("Untitled 1"), "{turn_1}");
    assert!(!turn_1.contains(VQ_SQL), "{turn_1}");
    assert!(!first.kinds.contains(&ItemKind::Sql), "{:?}", first.kinds);
    assert_eq!(
        first.asked_in.as_ref().unwrap().label,
        "Visual Query in shop"
    );

    let (chat, _) = ask_once(&cat, &ask_2(thread)).await;
    let turn = &chat.messages.last().unwrap().text;
    assert_eq!(
        step_labels(turn),
        [
            "added a filter on orders.total",
            "ran the Visual Query",
            "opened New table in shop",
        ]
    );
    let all = all_text(&chat);
    assert!(!all.contains("Untitled 1"), "{all}");
    assert!(!all.contains("1 row"), "{all}");
    // The Visual Query turn replays, framed, at the level it was written at.
    assert_eq!(chat.messages.len(), 3);
    assert!(
        chat.messages[0]
            .text
            .ends_with(&format!("Question: {ASK_1}"))
    );
    assert_eq!(
        framed(&chat.messages[0].text, "asked_in")[0],
        "Visual Query in shop: tables orders; ticked orders.id, orders.customer_id, orders.total"
    );
}

/// Spec 11: AI access lowered from L2 to L1 between the two Asks holds the Visual Query
/// turn back (its stamp carries query text) and counts it.
#[tokio::test]
async fn access_lowered_between_asks() {
    let mut cat = catalog(AiAccess::SchemaQuery);
    let (thread, first, _) = first_turn(&cat).await;
    assert!(first.kinds.contains(&ItemKind::Sql), "{:?}", first.kinds);
    cat.set_access(AiAccess::Schema);
    let req = ask_2(thread);

    let (chat, _) = ask_once(&cat, &req).await;
    assert_eq!(
        chat.messages.iter().map(|m| m.role).collect::<Vec<_>>(),
        [ChatRole::User]
    );
    let all = all_text(&chat);
    assert!(!all.contains(ASK_1), "{all}");
    assert!(!all.contains(ANSWER_1), "{all}");
    assert!(!all.contains(r#""source":"asked_in""#), "{all}");
    // Sends counts them: "2 earlier messages stay on this computer: AI access is lower now."
    let p = show(&cat, &req).await;
    assert_eq!(p.memory.unwrap().blocked, 2);
}

/// Spec 11: at Nothing (L0) the New table Ask sends the question only: no tab, no steps,
/// no history.
#[tokio::test]
async fn never_sends_question_only() {
    let mut cat = catalog(AiAccess::SchemaQuery);
    let (thread, _, _) = first_turn(&cat).await;
    cat.set_access(AiAccess::Never);

    let (chat, _) = ask_once(&cat, &ask_2(thread)).await;
    assert_eq!(chat.messages.len(), 1);
    let turn = &chat.messages[0].text;
    assert!(turn.ends_with(&format!("Question: {ASK_2}")), "{turn}");
    for source in ["tab", "steps", "asked_in", "sql", "names"] {
        assert!(framed(turn, source).is_empty(), "{source} went: {turn}");
    }
    let all = all_text(&chat);
    for word in ["shop", "orders", "customers", "Untitled 1", ASK_1] {
        assert!(!all.contains(word), "{word} went: {all}");
    }
}

/// R1.6: the preview of Ask 2 is exactly the text the Ask sends.
#[tokio::test]
async fn preview_equals_ask() {
    let cat = catalog(AiAccess::SchemaQuery);
    let (thread, _, _) = first_turn(&cat).await;
    let req = ask_2(thread);
    let p = show(&cat, &req).await;
    let (chat, _) = ask_once(&cat, &req).await;
    assert_eq!(same_boundary(&p.exact), same_boundary(&exact_of(&chat)));
    assert!(p.exact.contains(r#""source":"asked_in""#), "{}", p.exact);
    assert!(p.exact.contains(r#""source":"steps""#), "{}", p.exact);
}

// ---- Final review I1: a Connection whose Group sends to another AI provider ----

const PROD: &str = "prod-7";

fn prod() -> ConnectionId {
    Uuid::from_u128(7)
}

fn prod_group() -> Uuid {
    Uuid::from_u128(70)
}

/// `prod-7` in the Prod Group: PostgreSQL, database `payroll`, at Schema and query text.
fn prod_7() -> ConnectionConfig {
    ConnectionConfig {
        id: prod(),
        name: PROD.into(),
        dialect: DialectKind::Postgres,
        database: Some("payroll".into()),
        group_id: Some(prod_group()),
        ..hope_4(AiAccess::SchemaQuery)
    }
}

/// The AI service with the global settings on Groq; the Prod Group sends to `prod`.
fn ai_with_prod(prod: AiSettings) -> (tempfile::TempDir, AiService) {
    let dir = tempfile::tempdir().unwrap();
    let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
    let svc = AiService::new(store, std::sync::Arc::new(MemorySecretStore::new()));
    svc.save_settings(None, settings(), false, KeyChange::Keep)
        .unwrap();
    svc.save_settings(Some(prod_group()), prod, true, KeyChange::Keep)
        .unwrap();
    (dir, svc)
}

/// A self-hosted model for Prod: its schemas must not reach the cloud provider.
fn self_hosted() -> AiSettings {
    AiSettings {
        provider: Some(AiProviderKind::Custom),
        base_url: "http://10.0.0.5:8080/v1".into(),
        model: "local-coder".into(),
        ..AiSettings::default()
    }
}

/// `hope-4` (no Group) and `prod-7` (Prod), both at Schema and query text.
fn two_groups() -> Catalog {
    let mut cat = catalog(AiAccess::SchemaQuery);
    cat.configs.push(prod_7());
    cat
}

/// A Schema Compare from `payroll` on prod-7 to `shop` on hope-4, asked in the ungrouped
/// place (the global provider).
fn compare_across() -> AskRequest {
    let mut req = request("why are these two different?", None);
    req.focus.also = vec![prod()];
    req.tab = Some(AskTab::Compare {
        source: CompareSide::Database {
            database: "payroll".into(),
        },
        target_database: "shop".into(),
        items: vec![DiffLine {
            kind: DiffKind::Added,
            object: DiffObject::Table,
            table: "payroll_runs".into(),
            name: "payroll_runs".into(),
            from_type: None,
            to_type: None,
            loses_data: false,
            loses_rows: None,
        }],
        added: 1,
        removed: 0,
        changed: 0,
        not_compared: 0,
        ticked: 0,
        compared: true,
    });
    req
}

fn held_note(p: &Preview) -> bool {
    p.notes
        .iter()
        .any(|n| n == "prod-7 uses another Group's AI provider, so nothing about it goes.")
}

#[tokio::test]
async fn another_groups_provider_gets_nothing_about_its_connection() {
    let cat = two_groups();
    let (_dir, ai) = ai_with_prod(self_hosted());
    let gated = SameProvider::new(&cat, ai.same_provider(None, &cat.configs).unwrap());

    // The tab spans prod-7: none of its schema or diff goes, and Sends says why.
    let req = compare_across();
    let p = show(&gated, &req).await;
    assert!(held_note(&p), "{:?}", p.notes);
    for word in ["payroll", "prod-7"] {
        assert!(!p.exact.contains(word), "{word} would go: {}", p.exact);
    }
    let (chat, _) = ask_once(&gated, &req).await;
    let all = all_text(&chat);
    assert!(!all.contains("payroll"), "{all}");

    // Asked on prod-7 itself from this place: the Ask goes with nothing about it.
    let mut on_prod = compare_across();
    on_prod.connection_id = Some(prod());
    on_prod.database = Some("payroll".into());
    on_prod.focus.also = vec![hope()];
    let p = show(&gated, &on_prod).await;
    assert!(held_note(&p), "{:?}", p.notes);
    assert!(!p.exact.contains("payroll"), "{}", p.exact);
    let (chat, _) = ask_once(&gated, &on_prod).await;
    assert_eq!(chat.messages.len(), 1);
    let turn = &chat.messages[0].text;
    for source in ["tab", "names", "sql"] {
        assert!(framed(turn, source).is_empty(), "{source} went: {turn}");
    }
    assert!(chat.system.len() < 2, "a schema block went");
}

#[tokio::test]
async fn a_step_on_another_groups_provider_is_not_sent_or_stored() {
    let cat = two_groups();
    let (_dir, ai) = ai_with_prod(self_hosted());
    let gated = SameProvider::new(&cat, ai.same_provider(None, &cat.configs).unwrap());
    let mut on_prod = step(StepVerb::RunQuery, "query", &[], Some(3), MIN);
    on_prod.connection_id = Some(prod());
    on_prod.database = Some("payroll".into());
    on_prod.title = Some("Payroll check".into());
    let mut req = request("what did I just run?", None);
    req.steps = vec![
        on_prod,
        step(StepVerb::OpenTab, "query", &[], None, MIN / 2),
    ];

    let p = show(&gated, &req).await;
    assert!(held_note(&p), "{:?}", p.notes);
    let (chat, events) = ask_once(&gated, &req).await;
    let turn = &chat.messages.last().unwrap().text;
    assert_eq!(step_labels(turn), ["opened Query tab in shop"]);
    assert!(!all_text(&chat).contains("Payroll"), "{turn}");
    let asked = stamp_of(&events).asked_in.expect("an Asked in");
    assert!(asked.other_steps.is_empty(), "{:?}", asked.other_steps);
    assert!(!asked.also.contains(&prod()));
}

/// A step stored on prod-7 while Prod still used the global provider is dropped from the
/// replay once Prod's Group sends elsewhere; with the same provider it goes again.
#[tokio::test]
async fn a_stored_step_from_another_groups_provider_is_not_replayed() {
    let cat = two_groups();
    let label = "ran the query \"Payroll check\" on another Connection, 3 rows";
    let id = Uuid::new_v4();
    let stamp = TurnStamp {
        asked_in: Some(AskedIn {
            tab: "query".into(),
            label: "Query tab in shop".into(),
            other_steps: vec![OtherStep {
                connection_id: prod(),
                text: label.into(),
                level: AiAccess::SchemaQuery,
            }],
            ..AskedIn::default()
        }),
        ..stamp_of(&ask_once(&cat, &request(ASK_1, None)).await.1)
    };
    cat.threads
        .save_thread(&AiThread {
            id,
            place: PLACE.into(),
            title: ASK_1.into(),
            messages: stored_turn(ASK_1, ANSWER_1, now() - 4 * MIN, &stamp),
            updated_at: now(),
        })
        .unwrap();
    let req = request(ASK_2, Some(id));

    let (_dir, ai) = ai_with_prod(self_hosted());
    let gated = SameProvider::new(&cat, ai.same_provider(None, &cat.configs).unwrap());
    let (chat, _) = ask_once(&gated, &req).await;
    assert_eq!(chat.messages.len(), 3, "the turn itself replays");
    assert!(!all_text(&chat).contains("Payroll"), "{}", all_text(&chat));

    // Prod on the global provider again (its own record, the same destination): it goes.
    let mut same = settings();
    same.temperature = Some(0.2);
    let (_dir, ai) = ai_with_prod(same);
    let gated = SameProvider::new(&cat, ai.same_provider(None, &cat.configs).unwrap());
    let (chat, _) = ask_once(&gated, &req).await;
    assert!(
        all_text(&chat).contains("Payroll check"),
        "{}",
        all_text(&chat)
    );
}

/// Groups that send to the same provider still share: the tab, the step and the schema.
#[tokio::test]
async fn same_provider_groups_still_send() {
    let cat = two_groups();
    let mut same = settings();
    same.model = "llama-3.1-8b-instant".into();
    let (_dir, ai) = ai_with_prod(same);
    let ids = ai.same_provider(None, &cat.configs).unwrap();
    assert!(ids.contains(&prod()) && ids.contains(&hope()), "{ids:?}");
    let gated = SameProvider::new(&cat, ids);
    let p = show(&gated, &compare_across()).await;
    assert!(!held_note(&p), "{:?}", p.notes);
    assert!(p.exact.contains("payroll"), "{}", p.exact);
    let mut on_prod = step(StepVerb::RunQuery, "query", &[], Some(3), MIN);
    on_prod.connection_id = Some(prod());
    let mut req = request("what did I just run?", None);
    req.steps = vec![on_prod];
    let (_, events) = ask_once(&gated, &req).await;
    let asked = stamp_of(&events).asked_in.expect("an Asked in");
    assert_eq!(asked.other_steps.len(), 1);
}
