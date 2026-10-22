//! The outline step against the real Groq API. `#[ignore]`; the key comes only from the
//! `CONTURA_GROQ_KEY` environment variable at run time and the test returns early without it.
//! Nothing here prints the key, a request or a reply: only counts, bytes and recall.
//! Run: `cargo test -j 6 -p contura-core --test ai_outline_live -- --ignored --nocapture`
#[path = "support/eval_schema.rs"]
mod eval_schema;

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use contura_core::Error;
use contura_core::ai::context::outline::{
    OUTLINE_MIN_WINDOW, OutlineRequest, PickReply, REPLY_CAP_BYTES, TablePicker, parse_reply,
};
use contura_core::ai::context::store::{ContextStore, StoreContext};
use contura_core::ai::context::sync::Purpose;
use contura_core::ai::log::{Log, error_kind};
use contura_core::ai::models::{ModelInfo, info_for};
use contura_core::ai::preview::{CatalogReader, preview_with_log};
use contura_core::ai::provider::openai::OpenAi;
use contura_core::ai::provider::{AiProvider, ProviderEvent};
use contura_core::ai::rails::Secrets;
use contura_core::ai::rails::input::cap_chars;
use contura_core::ai::request::{AskRequest, Focus, Switches};
use contura_core::ai::sent::OutlineSent;
use contura_core::ai::stream::outline_chat_request;
use contura_core::ai::{AiAccess, AiError, AiProviderKind, AiSettings};
use contura_core::model::{ConnectionConfig, ConnectionId, DialectKind, SslMode};
use contura_core::schema_model::SchemaModel;
use contura_core::store::AppStore;
use serde::Deserialize;
use url::Url;
use uuid::Uuid;

const BASE: &str = "https://api.groq.com/openai/v1";
const KEY_VAR: &str = "CONTURA_GROQ_KEY";
/// Groq's built-in default model.
const MODEL: &str = "openai/gpt-oss-20b";
/// Free-tier Groq limits tokens per minute; an outline is thousands of them.
/// The 300-table schema: free-tier providers may reject the 2,000-table outline as too large
/// (the app then falls back to tier 2), so the live check uses the smaller schema.
const SIZE: usize = 300;
const PAUSE: Duration = Duration::from_secs(10);

#[derive(Deserialize)]
struct Case {
    schema: usize,
    kind: String,
    question: String,
    expect: Vec<String>,
}

fn key() -> Option<String> {
    match std::env::var(KEY_VAR) {
        Ok(k) if !k.trim().is_empty() => Some(k.trim().to_string()),
        _ => {
            println!("groq_picks_tables_from_the_outline: skipped, {KEY_VAR} is not set");
            None
        }
    }
}

/// The Ask's outline call over the real provider, shaped as `StreamPicker` shapes it: the
/// outline prompt and block as system blocks, the framed question as the one message, no
/// tools, the reply read as data up to 8 KB. Counts the calls it makes.
struct LivePicker {
    provider: OpenAi,
    model: ModelInfo,
    calls: Mutex<u32>,
    /// Replies with at least one name.
    accepted: Mutex<u32>,
    /// Well-formed JSON with both lists empty: the model picked nothing.
    nothing: Mutex<u32>,
    /// No balanced object, or an object without the two lists.
    malformed: Mutex<u32>,
    failed: Mutex<u32>,
    /// Calls the provider refused as too large: a provider limit, not a bad reply.
    skipped: Mutex<u32>,
}

#[async_trait::async_trait]
impl TablePicker for LivePicker {
    async fn pick(&self, req: &OutlineRequest, log: &mut Log) -> contura_core::Result<PickReply> {
        *self.calls.lock().unwrap() += 1;
        let chat = outline_chat_request(&self.model, self.model.picks, req);
        let mut text = String::new();
        let mut stop = None;
        let mut usage = None;
        let mut thinking_bytes = 0usize;
        let result = self
            .provider
            .stream(&chat, log, &mut |ev| match ev {
                ProviderEvent::Text(t) => {
                    let room = REPLY_CAP_BYTES - text.len();
                    text.push_str(cap_chars(&t, room));
                }
                ProviderEvent::Stop(s) => stop = Some(s),
                ProviderEvent::Usage(u) => usage = Some(u),
                ProviderEvent::Thinking(t) => thinking_bytes += t.len(),
                ProviderEvent::FirstByte => {}
            })
            .await;
        if let Err(e) = result {
            if matches!(e, Error::Ai(AiError::TooLarge)) {
                *self.skipped.lock().unwrap() += 1;
                println!("skipped: provider limit");
            } else {
                *self.failed.lock().unwrap() += 1;
                println!("an outline call failed: {}", error_kind(&e));
            }
            return Err(e);
        }
        let shape = reject_reason(&text);
        let counter = match shape {
            "accepted" => &self.accepted,
            "object with empty lists" => &self.nothing,
            _ => &self.malformed,
        };
        *counter.lock().unwrap() += 1;
        debug_assert_eq!(shape == "accepted", parse_reply(&text).is_some());
        // The shape of the reply only, never its text.
        let call = *self.calls.lock().unwrap();
        println!(
            "call {call}: stop {stop:?}, {} bytes, thinking {thinking_bytes} bytes, usage {}, \
             fence {}, starts with brace {}: {shape}",
            text.len(),
            usage.map_or("none".to_string(), |u| format!(
                "in {} out {}",
                u.input, u.output
            )),
            text.contains("```"),
            text.trim_start().starts_with('{'),
        );
        Ok(PickReply {
            text,
            sent: OutlineSent::default(),
        })
    }
}

/// Which branch of `parse_reply` the text ends in, by shape only: the first balanced JSON
/// object decides, as in `parse_reply`.
fn reject_reason(text: &str) -> &'static str {
    if !text.contains('{') {
        return "no object (no brace)";
    }
    for (start, _) in text.match_indices('{') {
        let mut depth = 0usize;
        let (mut in_str, mut esc) = (false, false);
        let mut stop = None;
        for (i, c) in text[start..].char_indices() {
            if in_str {
                match (esc, c) {
                    (true, _) => esc = false,
                    (false, '\\') => esc = true,
                    (false, '"') => in_str = false,
                    _ => {}
                }
                continue;
            }
            match c {
                '"' => in_str = true,
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        stop = Some(start + i + 1);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(stop) = stop else { continue };
        let Ok(serde_json::Value::Object(map)) =
            serde_json::from_str::<serde_json::Value>(&text[start..stop])
        else {
            continue;
        };
        let list = |k: &str| map.get(k).and_then(|v| v.as_array()).map(Vec::len);
        return match (list("areas"), list("tables")) {
            (None, None) => "object without the two lists",
            (a, t) if a.unwrap_or(0) + t.unwrap_or(0) == 0 => "object with empty lists",
            _ => "accepted",
        };
    }
    "no object (no balanced JSON object)"
}

/// One Connection and the generated schema.
struct Catalog {
    schema: SchemaModel,
    context: StoreContext,
}

#[async_trait::async_trait]
impl CatalogReader for Catalog {
    async fn connection_config(
        &self,
        id: ConnectionId,
    ) -> contura_core::Result<Option<ConnectionConfig>> {
        Ok(Some(ConnectionConfig {
            id,
            name: "Shop".into(),
            dialect: DialectKind::MySql,
            host: "127.0.0.1".into(),
            port: 3306,
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
        }))
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
}

fn ask_request(question: &str) -> AskRequest {
    AskRequest {
        request_id: "r1".into(),
        place: "ungrouped".into(),
        group_id: None,
        connection_id: Some(Uuid::from_u128(42)),
        database: Some("shop".into()),
        schema: None,
        action: "ask".into(),
        question: question.into(),
        thread_id: None,
        focus: Focus::default(),
        switches: Switches::default(),
        off: Vec::new(),
        model: None,
        picks: None,
    }
}

#[tokio::test]
/// Runs on the 300-table schema because free-tier providers may reject a large outline (TooLarge); the app then falls back to tier 2, and such calls are counted as skipped.
#[ignore]
async fn groq_picks_tables_from_the_outline() {
    let Some(key) = key() else {
        return;
    };
    let cases: Vec<Case> =
        serde_json::from_str(include_str!("fixtures/ai/retrieval_eval.json")).unwrap();
    let schema = eval_schema::schema(SIZE);
    let names: Vec<String> = schema.tables.iter().map(|t| t.name.clone()).collect();
    let catalog = Catalog {
        schema,
        context: StoreContext::new(AppStore::open(Path::new(":memory:")).unwrap()),
    };
    let settings = AiSettings {
        provider: Some(AiProviderKind::Groq),
        model: MODEL.into(),
        ..AiSettings::default()
    };
    let mut model = info_for(AiProviderKind::Groq, None, MODEL, None, &settings);
    // A model with the smallest window the outline needs (a real user case): the 300-table
    // schema then does not fit whole, tier 2 ranks, and a vague question triggers the outline.
    model.context_window = OUTLINE_MIN_WINDOW;
    println!("effective window: {} tokens", model.context_window);
    let picker = LivePicker {
        provider: OpenAi::new(
            Url::parse(BASE).unwrap(),
            Some(key.clone()),
            AiProviderKind::Groq,
            vec![key.clone()],
        )
        .unwrap(),
        model: model.clone(),
        calls: Mutex::new(0),
        accepted: Mutex::new(0),
        nothing: Mutex::new(0),
        malformed: Mutex::new(0),
        failed: Mutex::new(0),
        skipped: Mutex::new(0),
    };

    let mut outline_bytes = 0usize;
    for kind in ["vague", "paraphrase"] {
        let (mut found, mut wanted, mut asked) = (0usize, 0usize, 0u32);
        for c in cases.iter().filter(|c| c.schema == SIZE && c.kind == kind) {
            let before = *picker.calls.lock().unwrap();
            let p = preview_with_log(
                &catalog,
                &settings,
                &model,
                &Secrets::default(),
                &ask_request(&c.question),
                Purpose::Ask,
                Some(&picker),
                &mut Log::new(),
            )
            .await
            .unwrap();
            let made = *picker.calls.lock().unwrap() - before;
            assert!(made <= 1, "{made} outline requests for one Ask");
            if made == 1 {
                asked += 1;
                if let Some(o) = &p.outline {
                    outline_bytes = outline_bytes.max(o.exact.len());
                }
                tokio::time::sleep(PAUSE).await;
            }
            for t in p.tables.full.iter().chain(&p.tables.names_only) {
                assert!(names.contains(t), "{t} is not a table of the schema");
            }
            wanted += c.expect.len();
            found += c
                .expect
                .iter()
                .filter(|e| p.tables.full.contains(e))
                .count();
        }
        println!(
            "{kind}: recall {found}/{wanted} = {:.2}, {asked} outline calls",
            found as f64 / wanted.max(1) as f64
        );
    }
    let calls = *picker.calls.lock().unwrap();
    let accepted = *picker.accepted.lock().unwrap();
    let nothing = *picker.nothing.lock().unwrap();
    let malformed = *picker.malformed.lock().unwrap();
    let failed = *picker.failed.lock().unwrap();
    let skipped = *picker.skipped.lock().unwrap();
    println!(
        "outline bytes: {outline_bytes}; calls {calls}: accepted {accepted}, picked nothing {nothing}, \
         malformed {malformed}, failed {failed}, skipped (provider limit) {skipped}"
    );
    assert!(calls > 0, "no question asked for an outline");
    let replies = accepted + nothing + malformed;
    assert!(
        u64::from(malformed) * 2 <= u64::from(replies),
        "{malformed} of {replies} replies were malformed"
    );
}
