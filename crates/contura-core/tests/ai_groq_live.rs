//! Live checks against the real Groq API. All `#[ignore]`; the key comes only from the
//! `CONTURA_GROQ_KEY` environment variable and each test returns early without it.
//! Run: `cargo test -j 4 -p contura-core --test ai_groq_live -- --ignored --nocapture`

use std::time::Instant;

use contura_core::Error;
use contura_core::ai::diagram_tool::{
    ChangeStatus, DiagramScope, FlowOutline, OutlineLink, OutlineNode, ProposeInput, TOOL_NAME,
    base_hash_of, check,
};
use contura_core::ai::log::Log;
use contura_core::ai::models::{MaxTokensField, is_chat_id};
use contura_core::ai::prompt::diagram_prompt;
use contura_core::ai::provider::openai::OpenAi;
use contura_core::ai::provider::{
    AiProvider, ChatMessage, ChatRequest, ChatRole, PromptBlock, ProviderEvent, StopReason,
    Thinking, Usage,
};
use contura_core::ai::rails::execution::{ToolsAllowed, tool_for};
use contura_core::ai::rails::output::check_answer;
use contura_core::ai::{AiError, AiProviderKind};
use contura_core::model::DialectKind;
use url::Url;

const BASE: &str = "https://api.groq.com/openai/v1";
const KEY_VAR: &str = "CONTURA_GROQ_KEY";

fn key(test: &str) -> Option<String> {
    match std::env::var(KEY_VAR) {
        Ok(k) if !k.trim().is_empty() => Some(k.trim().to_string()),
        _ => {
            println!("{test}: skipped, {KEY_VAR} is not set");
            None
        }
    }
}

fn groq(key: &str) -> OpenAi {
    OpenAi::new(
        Url::parse(BASE).unwrap(),
        Some(key.to_string()),
        AiProviderKind::Groq,
        vec![key.to_string()],
    )
    .unwrap()
}

/// The built-in default; gpt-oss reasons first, so it gets room to write the answer.
const MODEL: &str = "openai/gpt-oss-20b";
/// The diagram tool check uses the larger model: the small one often writes tool arguments
/// that are not JSON or names shapes the diagram does not have.
const DIAGRAM_MODEL: &str = "openai/gpt-oss-120b";

fn request(model: &str, max_tokens: u32, thinking: Thinking) -> ChatRequest {
    asking(
        model,
        max_tokens,
        thinking,
        "You are a terse assistant.",
        "Reply with the single word ok.",
    )
}

fn asking(
    model: &str,
    max_tokens: u32,
    thinking: Thinking,
    system: &str,
    user: &str,
) -> ChatRequest {
    ChatRequest {
        model: model.into(),
        system: vec![PromptBlock {
            text: system.into(),
            cache_mark: false,
        }],
        messages: vec![ChatMessage {
            role: ChatRole::User,
            text: user.into(),
        }],
        max_tokens,
        temperature: None,
        thinking,
        max_tokens_field: MaxTokensField::MaxTokens,
        tools: None,
    }
}

/// What one streamed answer produced.
#[derive(Default)]
struct Findings {
    first_byte: usize,
    text: usize,
    thinking: usize,
    usage: Option<Usage>,
    stop: Option<StopReason>,
    answer: String,
}

impl Findings {
    fn print(&self, label: &str, ms: u128) {
        let usage = self.usage.map_or("none".to_string(), |u| {
            format!(
                "input {} output {} cache_read {}",
                u.input, u.output, u.cache_read
            )
        });
        println!(
            "{label}: first_byte {} text {} thinking {} (reasoning delta: {}) usage [{usage}] \
             stop {:?} {ms}ms answer {:?}",
            self.first_byte,
            self.text,
            self.thinking,
            self.thinking > 0,
            self.stop,
            self.answer,
        );
    }
}

async fn run(provider: &OpenAi, req: &ChatRequest) -> (contura_core::Result<()>, Findings, u128) {
    let mut found = Findings::default();
    let mut log = Log::new();
    let started = Instant::now();
    let result = provider
        .stream(req, &mut log, &mut |event| match event {
            ProviderEvent::FirstByte => found.first_byte += 1,
            ProviderEvent::Text(t) => {
                found.text += 1;
                found.answer.push_str(&t);
            }
            ProviderEvent::Thinking(_) => found.thinking += 1,
            ProviderEvent::Usage(u) => found.usage = Some(u),
            // These requests carry no tool.
            ProviderEvent::ToolCall { .. } => {}
            ProviderEvent::Stop(s) => found.stop = Some(s),
        })
        .await;
    (result, found, started.elapsed().as_millis())
}

/// The error with the key masked, in case a message ever carried it.
fn redacted(err: &Error, key: &str) -> String {
    format!("{err:?}").replace(key, "[redacted]")
}

#[tokio::test]
#[ignore]
async fn groq_streams_a_short_answer() {
    let Some(key) = key("groq_streams_a_short_answer") else {
        return;
    };
    let (result, found, ms) = run(
        &groq(&key),
        &request(MODEL, 512, Thinking::Effort("low".into())),
    )
    .await;
    found.print(MODEL, ms);
    if let Err(e) = &result {
        panic!("stream failed: {}", redacted(e, &key));
    }
    assert!(found.text > 0, "no Text event");
    assert!(
        found.usage.is_some_and(|u| u.input > 0),
        "no Usage with input"
    );
    assert_eq!(found.stop, Some(StopReason::End));
}

#[tokio::test]
#[ignore]
async fn groq_models_lists_the_default() {
    let Some(key) = key("groq_models_lists_the_default") else {
        return;
    };
    let started = Instant::now();
    let models = match groq(&key).models(&mut Log::new()).await {
        Ok(m) => m,
        Err(e) => panic!("models failed: {}", redacted(&e, &key)),
    };
    println!(
        "models: {} ids in {}ms, {MODEL} listed: {}",
        models.len(),
        started.elapsed().as_millis(),
        models.iter().any(|m| m.id == MODEL),
    );
    assert!(models.iter().any(|m| m.id == MODEL));
}

#[tokio::test]
#[ignore]
async fn groq_reasoning_effort_probe() {
    let Some(key) = key("groq_reasoning_effort_probe") else {
        return;
    };
    let provider = groq(&key);
    for model in [
        "openai/gpt-oss-20b",
        "openai/gpt-oss-120b",
        "qwen/qwen3.8-27b",
    ] {
        let req = request(model, 512, Thinking::Effort("low".into()));
        let (result, found, ms) = run(&provider, &req).await;
        found.print(model, ms);
        match result {
            Ok(()) => println!(
                "{model}: cache_read reported: {}",
                found.usage.is_some_and(|u| u.cache_read > 0)
            ),
            Err(e) if model != "openai/gpt-oss-20b" => {
                println!("{model}: rejected: {}", redacted(&e, &key));
                continue;
            }
            Err(e) => panic!("{model} failed: {}", redacted(&e, &key)),
        }
        if model == "openai/gpt-oss-20b" {
            assert!(
                matches!(found.stop, Some(StopReason::End | StopReason::Length)),
                "{model} did not finish: {:?}",
                found.stop
            );
        }
    }
}

#[tokio::test]
#[ignore]
async fn groq_bad_key_is_bad_key() {
    if key("groq_bad_key_is_bad_key").is_none() {
        return;
    }
    let bad = "gsk_invalid";
    let (result, found, ms) = run(&groq(bad), &request(MODEL, 16, Thinking::Off)).await;
    found.print("bad key", ms);
    let err = result.expect_err("a bad key must fail");
    let shown = format!("{err} {err:?}");
    println!("bad key: {}", redacted(&err, bad));
    assert!(matches!(err, Error::Ai(AiError::BadKey)), "got {err:?}");
    assert!(!shown.contains(bad), "the error text holds the key");
}

#[tokio::test]
#[ignore]
async fn groq_listing_has_windows_and_no_audio() {
    let Some(key) = key("groq_listing_has_windows_and_no_audio") else {
        return;
    };
    let models = match groq(&key).models(&mut Log::new()).await {
        Ok(m) => m,
        Err(e) => panic!("models failed: {}", redacted(&e, &key)),
    };
    for m in &models {
        println!(
            "listing: {} context_window {:?} max_output {:?} chat {:?} shown {}",
            m.id,
            m.context_window,
            m.max_output,
            m.chat,
            is_chat_id(&m.id),
        );
    }
    let shown: Vec<_> = models.iter().filter(|m| is_chat_id(&m.id)).collect();
    println!(
        "listing: {} ids, {} shown, {} hidden",
        models.len(),
        shown.len(),
        models.len() - shown.len()
    );
    for m in &shown {
        let id = m.id.to_lowercase();
        assert!(
            !["whisper", "tts", "orpheus", "guard", "audio"]
                .iter()
                .any(|w| id.contains(w)),
            "{} is shown",
            m.id
        );
    }
    let default = shown
        .iter()
        .find(|m| m.id == MODEL)
        .unwrap_or_else(|| panic!("{MODEL} is not shown"));
    assert!(default.context_window.is_some(), "{MODEL} has no window");
}

/// About 6,000 tokens of stable text: the same bytes every call, so a provider that caches
/// prefixes can serve the second call from its cache.
fn long_system() -> String {
    let mut text = String::from(
        "You are a terse assistant. The schema below is reference only; reply as asked.\n",
    );
    for n in 0..180 {
        text.push_str(&format!(
            "table_{n:03}(id bigint primary key, owner_{n} int not null, label text, \
             created_at timestamp, amount_{n} numeric(12,2))\n"
        ));
    }
    text
}

/// Seconds to wait before a retry: the server's hint, at least 1 (so a hint of 0 still
/// retries) and at most one minute of free-tier window plus a margin; 65 without a hint.
/// 0 for any other error.
fn rate_wait(err: &Error) -> u64 {
    match err {
        Error::Ai(AiError::RateLimited { retry_after_secs }) => {
            retry_after_secs.map_or(65, |s| u64::from(s).clamp(1, 65))
        }
        _ => 0,
    }
}

/// One call, retried up to 3 times when the free tier rate limits it.
async fn run_patient(
    provider: &OpenAi,
    req: &ChatRequest,
    label: &str,
) -> (contura_core::Result<()>, Findings, u128) {
    let mut retries = 0;
    loop {
        let (result, found, ms) = run(provider, req).await;
        let wait = result.as_ref().err().map_or(0, rate_wait);
        if wait == 0 || retries == 3 {
            return (result, found, ms);
        }
        retries += 1;
        println!("{label}: rate limited, waiting {wait}s (retry {retries} of 3)");
        tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
    }
}

#[tokio::test]
#[ignore]
async fn groq_cache_probe() {
    let Some(key) = key("groq_cache_probe") else {
        return;
    };
    let provider = groq(&key);
    let system = long_system();
    let estimate = contura_core::ai::budget::estimate_tokens(&system, false);
    println!("cache probe: system prompt estimate {estimate} tokens");
    assert!(estimate >= 1_024, "the system prompt is too short to cache");
    // A miss on the free tier is not a failure: this test reports and asserts nothing else.
    for (i, model) in ["openai/gpt-oss-20b", "qwen/qwen3.8-27b"]
        .iter()
        .enumerate()
    {
        if i > 0 {
            // The free tier counts tokens per minute.
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
        let req = asking(
            model,
            512,
            Thinking::Effort("low".into()),
            &system,
            "Reply with the single word ok.",
        );
        let mut verdict = String::from("not confirmed (no second answer)");
        for round in 1..=2 {
            let label = format!("cache {model} call {round}");
            let (result, found, ms) = run_patient(&provider, &req, &label).await;
            found.print(&label, ms);
            if let Err(e) = &result {
                let why = redacted(e, &key);
                println!("{label}: failed: {why}");
                verdict = format!("not confirmed (call {round} failed: {why})");
                break;
            }
            if round == 2 {
                verdict = match found.usage {
                    Some(u) if u.cache_read > 0 => {
                        format!("confirmed (cache_read {})", u.cache_read)
                    }
                    Some(_) => "not confirmed (cache_read 0)".to_string(),
                    None => "not confirmed (no usage reported)".to_string(),
                };
            }
        }
        println!("CACHE {model}: {verdict}");
    }
}

#[tokio::test]
#[ignore]
async fn groq_effort_none_probe() {
    let Some(key) = key("groq_effort_none_probe") else {
        return;
    };
    let model = "qwen/qwen3.8-27b";
    let req = request(model, 512, Thinking::Effort("none".into()));
    let (result, found, ms) = run(&groq(&key), &req).await;
    found.print(&format!("effort none {model}"), ms);
    match &result {
        Ok(()) => println!(
            "EFFORT_NONE {model}: accepted, thinking arrived {}",
            found.thinking > 0
        ),
        Err(e) => println!("EFFORT_NONE {model}: rejected: {}", redacted(e, &key)),
    }
    assert!(result.is_ok(), "{model} rejected effort none");
    assert_eq!(found.stop, Some(StopReason::End), "{model} did not finish");
}

#[tokio::test]
#[ignore]
async fn groq_gpt_oss_has_no_off() {
    let Some(key) = key("groq_gpt_oss_has_no_off") else {
        return;
    };
    let provider = groq(&key);
    let (result, found, ms) = run(&provider, &request(MODEL, 512, Thinking::Off)).await;
    found.print(&format!("off {MODEL}"), ms);
    match &result {
        Ok(()) => println!(
            "OFF {MODEL}: nothing sent, reasoning still arrived {}",
            found.thinking > 0
        ),
        Err(e) => println!("OFF {MODEL}: failed: {}", redacted(e, &key)),
    }
    // Whether gpt-oss takes "none" at all decides between NotAllowed and EffortNone.
    let req = request(MODEL, 512, Thinking::Effort("none".into()));
    let (none, found, ms) = run(&provider, &req).await;
    found.print(&format!("effort none {MODEL}"), ms);
    match &none {
        Ok(()) => println!(
            "EFFORT_NONE {MODEL}: accepted, thinking arrived {}",
            found.thinking > 0
        ),
        Err(e) => println!("EFFORT_NONE {MODEL}: rejected: {}", redacted(e, &key)),
    }
    if let Err(e) = &result {
        panic!(
            "{MODEL} with no thinking control failed: {}",
            redacted(e, &key)
        );
    }
}

#[tokio::test]
#[ignore]
async fn groq_answer_is_checked() {
    let Some(key) = key("groq_answer_is_checked") else {
        return;
    };
    let req = asking(
        MODEL,
        2_048,
        Thinking::Effort("low".into()),
        "You write MySQL. Put SQL in a fenced code block tagged sql.",
        "Reply with only this query in one sql code block, nothing else: select 1;",
    );
    let (result, found, ms) = run(&groq(&key), &req).await;
    found.print(&format!("checked {MODEL}"), ms);
    if let Err(e) = &result {
        panic!("stream failed: {}", redacted(e, &key));
    }
    let blocks = check_answer(&found.answer, Some(DialectKind::MySql), "ask", false);
    println!(
        "CHECKED {MODEL}: {} blocks, labels {:?}",
        blocks.len(),
        blocks.iter().map(|b| b.label.as_str()).collect::<Vec<_>>()
    );
    assert_eq!(blocks.len(), 1, "answer {:?}", found.answer);
    assert_eq!(blocks[0].label, "1 statement: 1 read");
}

const DATA_FLOW: &str = "diagram dfd \"Orders\"\n\
Customer [entity]\n\
Take order [process]\n\
Pick and pack [process]\n\
Warehouse [store]\n\
Ship [process]\n\
Courier [entity]\n\
Customer > Take order: order\n\
Take order > Pick and pack\n\
Pick and pack > Warehouse\n\
Warehouse > Ship\n\
Ship > Courier\n";

/// The outline the worker would build from [`DATA_FLOW`].
fn data_flow_outline() -> FlowOutline {
    let nodes = [
        ("Customer", "entity"),
        ("Take order", "process"),
        ("Pick and pack", "process"),
        ("Warehouse", "store"),
        ("Ship", "process"),
        ("Courier", "entity"),
    ];
    let links = [
        ("Customer", "Take order", Some("order")),
        ("Take order", "Pick and pack", None),
        ("Pick and pack", "Warehouse", None),
        ("Warehouse", "Ship", None),
        ("Ship", "Courier", None),
    ];
    FlowOutline {
        kind: Some("dfd".into()),
        // KINDS.dfd in src/lang/flow/model.ts: the worker sends the kinds the diagram takes.
        kinds: vec!["entity".into(), "process".into(), "store".into()],
        nodes: nodes
            .iter()
            .enumerate()
            .map(|(i, (name, kind))| OutlineNode {
                name: (*name).into(),
                id: None,
                kind: Some((*kind).into()),
                group: None,
                line: i as u32 + 2,
                table: false,
                columns: None,
            })
            .collect(),
        groups: Vec::new(),
        links: links
            .iter()
            .enumerate()
            .map(|(i, (from, to, label))| OutlineLink {
                from: (*from).into(),
                to: (*to).into(),
                label: label.map(Into::into),
                line: i as u32 + 8,
                from_column: None,
                to_column: None,
            })
            .collect(),
    }
}

#[tokio::test]
#[ignore]
async fn groq_proposes_diagram_changes() {
    let Some(key) = key("groq_proposes_diagram_changes") else {
        return;
    };
    let mut req = asking(
        DIAGRAM_MODEL,
        4_096,
        Thinking::Effort("low".into()),
        &diagram_prompt(
            Some("dfd"),
            &["entity".into(), "process".into(), "store".into()],
        ),
        &format!(
            "<<contura:context id=0123456789abcdef>>\n{}\n<</contura:context id=0123456789abcdef>>\n\n\
             File: orders.flow. base_hash: {}.\n\n\
             Question: Add a customs check between Pick and pack and Warehouse",
            serde_json::json!({ "source": "diagram", "text": DATA_FLOW }),
            base_hash_of(DATA_FLOW)
        ),
    );
    req.tools = tool_for(ToolsAllowed::DiagramTool);
    assert!(req.tools.is_some(), "the request carries no tool");
    let provider = groq(&key);
    // One stream call below, so this counts by construction: the test makes exactly one request.
    let mut requests = 0;
    let mut calls = Vec::new();
    let mut found = Findings::default();
    let mut log = Log::new();
    requests += 1;
    let result = provider
        .stream(&req, &mut log, &mut |event| match event {
            ProviderEvent::FirstByte => found.first_byte += 1,
            ProviderEvent::Text(_) => found.text += 1,
            ProviderEvent::Thinking(_) => found.thinking += 1,
            ProviderEvent::Usage(u) => found.usage = Some(u),
            ProviderEvent::ToolCall { name, input } => calls.push((name, input)),
            ProviderEvent::Stop(s) => found.stop = Some(s),
        })
        .await;
    if let Err(e) = &result {
        panic!("stream failed: {}", redacted(e, &key));
    }
    let (name, input) = calls.first().expect("the model made no tool call");
    assert_eq!(name, TOOL_NAME);
    let parsed: ProposeInput = serde_json::from_str(input)
        .unwrap_or_else(|e| panic!("the tool input does not parse: {:?}", e.classify()));
    let changes = check(&parsed, &data_flow_outline(), &DiagramScope::Whole);
    let ok = changes
        .iter()
        .filter(|c| matches!(c.status, ChangeStatus::Ok))
        .count();
    // The model id and counts only: no names, labels or text.
    println!(
        "PROPOSED {DIAGRAM_MODEL}: tool calls {}, ops {}, changes {}, ok {ok}, requests {requests}",
        calls.len(),
        parsed.ops.len(),
        changes.len(),
    );
    assert!(ok >= 1, "no change passed the check");
    assert_eq!(requests, 1);
}
