//! Live checks of the memory calls against the real Groq API. All `#[ignore]`; the key
//! comes only from the `CONTURA_GROQ_KEY` environment variable and each test returns
//! early without it.
//! Run: `cargo test -j 6 -p contura-core --test ai_live -- --ignored --nocapture`

use std::time::{SystemTime, UNIX_EPOCH};

use contura_core::ai::compact::{COMPACT_CHARS, CompactRequest, compact_now};
use contura_core::ai::context::store::{ContextStore, StoreContext};
use contura_core::ai::memory::store::StoreThreads;
use contura_core::ai::memory::{SummaryBy, ThreadStore};
use contura_core::ai::models::info_for;
use contura_core::ai::preview::CatalogReader;
use contura_core::ai::provider::openai::OpenAi;
use contura_core::ai::rails::Secrets;
use contura_core::ai::request::ItemKind;
use contura_core::ai::{AiAccess, AiMessage, AiProviderKind, AiRole, AiSettings, AiThread};
use contura_core::model::{ConnectionConfig, ConnectionId, DialectKind, SslMode};
use contura_core::schema_model::SchemaModel;
use contura_core::store::AppStore;
use url::Url;
use uuid::Uuid;

const BASE: &str = "https://api.groq.com/openai/v1";
const KEY_VAR: &str = "CONTURA_GROQ_KEY";
/// The built-in default, as the other Groq live tests use; it reasons first (its
/// thinking cannot be off, so the call clamps to its lowest level) within the 1,024
/// tokens of a compaction.
const MODEL: &str = "openai/gpt-oss-20b";

fn key(test: &str) -> Option<String> {
    match std::env::var(KEY_VAR) {
        Ok(k) if !k.trim().is_empty() => Some(k.trim().to_string()),
        _ => {
            println!("{test}: skipped, {KEY_VAR} is not set");
            None
        }
    }
}

fn conn() -> ConnectionConfig {
    ConnectionConfig {
        id: Uuid::from_u128(42),
        name: "Shop".into(),
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
        ai_sync: Default::default(),
        production: false,
        read_only: false,
    }
}

struct Catalog {
    context: StoreContext,
    threads: StoreThreads,
}

#[async_trait::async_trait]
impl CatalogReader for Catalog {
    async fn connection_config(
        &self,
        id: ConnectionId,
    ) -> contura_core::Result<Option<ConnectionConfig>> {
        Ok(Some(conn()).filter(|c| c.id == id))
    }

    async fn schema_snapshot(
        &self,
        _id: ConnectionId,
        _database: &str,
        _schema: Option<&str>,
    ) -> contura_core::Result<SchemaModel> {
        unreachable!("Compact now never reads the database")
    }

    async fn schema_fingerprint(
        &self,
        _id: ConnectionId,
        _database: &str,
        _schema: Option<&str>,
    ) -> contura_core::Result<String> {
        unreachable!("Compact now never reads the database")
    }

    fn context(&self) -> &dyn ContextStore {
        &self.context
    }

    fn threads(&self) -> &dyn ThreadStore {
        &self.threads
    }
}

fn message(role: AiRole, text: &str, at: i64) -> AiMessage {
    AiMessage {
        role,
        text: text.into(),
        context: Vec::new(),
        at,
        record: None,
        topic: Some(1),
        connection_id: Some(conn().id),
        database: Some("shop".into()),
        kinds: vec![ItemKind::Question, ItemKind::Cards],
        tables: vec!["orders".into()],
        action: Some("ask".into()),
    }
}

#[tokio::test]
#[ignore]
async fn groq_compact_now_round_trip() {
    let Some(key) = key("groq_compact_now_round_trip") else {
        return;
    };
    let mem = || AppStore::open(std::path::Path::new(":memory:")).unwrap();
    let cat = Catalog {
        context: StoreContext::new(mem()),
        threads: StoreThreads::new(mem()),
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let turns = [
        (
            "How many orders were placed today?",
            "Count them with SELECT count(*) FROM orders WHERE created_at >= current_date.",
        ),
        (
            "And the total value?",
            "Sum the total column: SELECT sum(total) FROM orders WHERE created_at >= current_date.",
        ),
        (
            "Which customer ordered the most?",
            "Group by customer_id and order by the count, descending, limit 1.",
        ),
        (
            "Can it show the customer's name?",
            "Join customers on customers.id = orders.customer_id and select customers.name.",
        ),
    ];
    // Compact now refuses when half of what it folds is under 100 tokens: each answer
    // explains itself at some length, as real answers do.
    let detail = "The query reads only the orders table and uses the index on created_at, so it stays fast on a large table. Run it in the editor first and compare the result with the dashboard before you rely on it; a time zone that differs between the server and the dashboard is the usual reason two numbers disagree.";
    let mut messages = Vec::new();
    for (i, (q, a)) in turns.iter().enumerate() {
        let at = now - 30 * 60_000 + i as i64 * 60_000;
        messages.push(message(AiRole::User, q, at));
        messages.push(message(
            AiRole::Assistant,
            &format!("{a} {detail}"),
            at + 1_000,
        ));
    }
    let thread = AiThread {
        id: Uuid::new_v4(),
        place: "ungrouped".into(),
        title: "t".into(),
        messages,
        updated_at: now,
    };
    cat.threads.save_thread(&thread).unwrap();

    let settings = AiSettings {
        provider: Some(AiProviderKind::Groq),
        model: MODEL.into(),
        ..AiSettings::default()
    };
    let model = info_for(AiProviderKind::Groq, None, MODEL, None, &settings);
    let provider = OpenAi::new(
        Url::parse(BASE).unwrap(),
        Some(key.clone()),
        AiProviderKind::Groq,
        vec![key],
    )
    .unwrap();
    let req = CompactRequest {
        request_id: "live".into(),
        place: "ungrouped".into(),
        group_id: None,
        thread_id: thread.id,
        model: None,
    };
    let c = compact_now(
        &provider,
        &cat,
        &settings,
        &model,
        &Secrets::default(),
        &req,
        &|_| {},
    )
    .await
    .unwrap();
    let chars = c.summary.chars().count();
    println!(
        "summary: {chars} chars, {} messages, before {} after {}",
        c.messages, c.before, c.after
    );
    assert!(chars > 0 && chars <= COMPACT_CHARS);
    assert_eq!(c.messages, 4);
    assert!(c.after < c.before, "Compact now makes the thread smaller");
    assert!(matches!(c.summary_by, SummaryBy::Model { .. }));
    let sent = c.record.sent.clone().unwrap();
    let summary = sent.summary.unwrap();
    let usage = summary.usage.expect("usage read");
    println!(
        "usage: input {} output {}; sent {} B",
        usage.input, usage.output, summary.bytes
    );
    assert!(usage.input > 0 && usage.output > 0);
}
