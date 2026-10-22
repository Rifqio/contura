//! The Anthropic Messages API.

use async_trait::async_trait;
use serde_json::{Map, Value, json};
use url::Url;

use super::http::{self, Call, Http};
use super::sse::{SseEvent, SseParser};
use super::{
    AiProvider, ChatRequest, ChatRole, ListedModel, ProviderEvent, StopReason, Thinking, Usage,
    count, effort_budget, sorted_models,
};
use crate::ai::log::Log;
use crate::ai::{AiError, AiProviderKind};
use crate::error::{Error, Result};

const VERSION: &str = "2023-06-01";
/// `max_tokens` when the request leaves it at 0; Anthropic always needs one.
const DEFAULT_MAX_TOKENS: u32 = 4096;
/// Room left for the answer on top of a thinking budget.
const ANSWER_ROOM: u32 = 4096;

/// The `max_tokens` the body carries: the request's (4,096 when 0), raised by a thinking
/// budget so the answer keeps room after it. The Ask measures `TooBig` with it.
pub fn max_tokens_sent(req: &ChatRequest) -> u32 {
    raised_max_tokens(req.max_tokens, &req.thinking)
}

/// `max_tokens` (4,096 when 0) raised by `thinking`'s budget, as `max_tokens_sent`.
pub(crate) fn raised_max_tokens(max_tokens: u32, thinking: &Thinking) -> u32 {
    let asked = if max_tokens > 0 {
        max_tokens
    } else {
        DEFAULT_MAX_TOKENS
    };
    let budget = match thinking {
        Thinking::Budget(budget) => Some(*budget),
        Thinking::Adaptive { effort, .. } => effort_budget(effort),
        _ => None,
    };
    budget.map_or(asked, |b| asked.max(b.saturating_add(ANSWER_ROOM)))
}
/// Models asked for per page of `GET /v1/models`, and the most pages read.
const MODELS_PAGE: u32 = 1000;
const MODELS_PAGES: usize = 10;

pub struct Anthropic {
    pub base: Url,
    pub key: String,
    /// Redacted from any provider message.
    pub secrets: Vec<String>,
    pub http: &'static Http,
}

/// The `v1/messages` body. Never has a `tools` key. The system blocks go in order, each
/// with a cache mark when asked, so the same pick sends the same prefix.
pub fn body(req: &ChatRequest) -> Value {
    let messages: Vec<Value> = req
        .messages
        .iter()
        .map(|m| {
            let role = match m.role {
                ChatRole::User => "user",
                ChatRole::Assistant => "assistant",
            };
            json!({ "role": role, "content": m.text })
        })
        .collect();
    let max_tokens = max_tokens_sent(req);
    let mut body = Map::new();
    body.insert("model".into(), json!(req.model));
    if !req.system.is_empty() {
        let blocks: Vec<Value> = req
            .system
            .iter()
            .map(|b| {
                let mut block = json!({ "type": "text", "text": b.text });
                if b.cache_mark {
                    block["cache_control"] = json!({ "type": "ephemeral" });
                }
                block
            })
            .collect();
        body.insert("system".into(), Value::Array(blocks));
    }
    body.insert("messages".into(), Value::Array(messages));
    body.insert("stream".into(), json!(true));
    let thinks = match &req.thinking {
        Thinking::Budget(budget) => {
            body.insert(
                "thinking".into(),
                json!({ "type": "enabled", "budget_tokens": budget }),
            );
            true
        }
        Thinking::Adaptive { effort, summarized } => {
            let display = if *summarized { "summarized" } else { "omitted" };
            body.insert(
                "thinking".into(),
                json!({ "type": "adaptive", "display": display }),
            );
            body.insert("output_config".into(), json!({ "effort": effort }));
            true
        }
        Thinking::Disabled => {
            body.insert("thinking".into(), json!({ "type": "disabled" }));
            false
        }
        Thinking::BetweenTools => {
            body.insert("thinking".into(), json!({ "type": "between_tools" }));
            false
        }
        // An effort is the OpenAI-compatible control; Anthropic is not sent one.
        Thinking::Off | Thinking::Effort(_) => false,
    };
    // Thinking takes no temperature, so it is sent only without it.
    if !thinks && let Some(t) = req.temperature {
        body.insert("temperature".into(), json!(t));
    }
    body.insert("max_tokens".into(), json!(max_tokens));
    Value::Object(body)
}

/// The status a mid-stream `error` event stands for, from its documented type.
fn error_status(kind: &str) -> u16 {
    match kind {
        "invalid_request_error" => 400,
        "authentication_error" => 401,
        "billing_error" => 402,
        "permission_error" => 403,
        "not_found_error" => 404,
        "request_too_large" => 413,
        "rate_limit_error" => 429,
        "overloaded_error" => 529,
        _ => 500,
    }
}

/// The running stream: the usage so far and the stop reason `message_delta` gave.
#[derive(Default)]
struct State {
    usage: Usage,
    stop: Option<StopReason>,
}

impl State {
    /// Takes the counts present in `usage`; the ones missing keep their last value.
    fn take_usage(&mut self, usage: &Value) -> Usage {
        let n = |key: &str| {
            usage
                .get(key)
                .and_then(Value::as_u64)
                .map(|v| u32::try_from(v).unwrap_or(u32::MAX))
        };
        let u = &mut self.usage;
        u.input = n("input_tokens").unwrap_or(u.input);
        u.output = n("output_tokens").unwrap_or(u.output);
        u.cache_read = n("cache_read_input_tokens").unwrap_or(u.cache_read);
        u.cache_write = n("cache_creation_input_tokens").unwrap_or(u.cache_write);
        *u
    }
}

impl Anthropic {
    /// A provider on the shared HTTP client; fails when that client could not be built.
    pub fn new(base: Url, key: String, secrets: Vec<String>) -> Result<Self> {
        Ok(Self {
            base,
            key,
            secrets,
            http: Http::shared()?,
        })
    }

    /// `{base}/{path}`, keeping any path the base has.
    fn url(&self, path: &str) -> Result<Url> {
        let joined = format!("{}/{path}", self.base.as_str().trim_end_matches('/'));
        Url::parse(&joined).map_err(|_| Error::Ai(AiError::BadResponse))
    }

    fn headers(&self) -> Vec<(&'static str, String, bool)> {
        vec![
            ("x-api-key", self.key.clone(), true),
            ("anthropic-version", VERSION.into(), false),
        ]
    }

    /// The given secrets plus the key itself, so a provider echoing the key never shows it.
    fn redact_list(&self) -> Vec<String> {
        let mut list = self.secrets.clone();
        if !self.key.is_empty() {
            list.push(self.key.clone());
        }
        list
    }

    fn call<'a>(&self, path: &str, body: Option<Value>, secrets: &'a [String]) -> Result<Call<'a>> {
        Ok(Call {
            url: self.url(path)?,
            headers: self.headers(),
            body,
            provider: AiProviderKind::Anthropic,
            secrets,
            deadline: self.http.deadline(),
        })
    }

    /// Hands one event's thinking, text and usage to `sink` and keeps its stop reason in
    /// `state`. True once `message_stop` arrives. `model` is the one asked for, named by a
    /// mid-stream `not_found_error`.
    fn on_event(
        &self,
        ev: &SseEvent,
        model: &str,
        state: &mut State,
        sink: &mut (dyn FnMut(ProviderEvent) + Send),
    ) -> Result<bool> {
        let data = ev.data.trim();
        if data.is_empty() {
            return Ok(false);
        }
        let event: Value =
            serde_json::from_str(data).map_err(|_| Error::Ai(AiError::BadResponse))?;
        match event["type"].as_str().unwrap_or_default() {
            "message_start" => {
                if let Some(usage) = event.pointer("/message/usage").filter(|u| u.is_object()) {
                    sink(ProviderEvent::Usage(state.take_usage(usage)));
                }
            }
            "content_block_delta" => {
                // `signature_delta` and other block kinds carry nothing to show.
                let delta = &event["delta"];
                let text = |field: &str| {
                    delta[field]
                        .as_str()
                        .filter(|t| !t.is_empty())
                        .map(str::to_string)
                };
                match delta["type"].as_str() {
                    Some("text_delta") => text("text").map(|t| sink(ProviderEvent::Text(t))),
                    Some("thinking_delta") => {
                        text("thinking").map(|t| sink(ProviderEvent::Thinking(t)))
                    }
                    _ => None,
                };
            }
            "message_delta" => {
                if let Some(reason) = event.pointer("/delta/stop_reason").and_then(Value::as_str) {
                    state.stop = Some(match reason {
                        "max_tokens" => StopReason::Length,
                        "refusal" => StopReason::Refusal,
                        _ => StopReason::End,
                    });
                }
                if let Some(usage) = event.get("usage").filter(|u| u.is_object()) {
                    sink(ProviderEvent::Usage(state.take_usage(usage)));
                }
            }
            "message_stop" => return Ok(true),
            "error" => {
                // Mapped as the status its type stands for; one with no type says nothing usable.
                let Some(kind) = event.pointer("/error/type").and_then(Value::as_str) else {
                    return Err(Error::Ai(AiError::BadResponse));
                };
                return Err(Error::Ai(http::map_status(
                    error_status(kind),
                    None,
                    data,
                    AiProviderKind::Anthropic,
                    model,
                    &self.redact_list(),
                )));
            }
            // `ping`, `content_block_start`, `content_block_stop` and new types carry nothing.
            _ => {}
        }
        Ok(false)
    }
}

/// The reason sent last: `message_delta`'s, or `End` after `message_stop` without one. A body
/// that ends before `message_stop` was cut off.
fn final_stop(stop: Option<StopReason>, done: bool) -> StopReason {
    match (done, stop) {
        (false, _) => StopReason::Dropped,
        (true, Some(reason)) => reason,
        (true, None) => StopReason::End,
    }
}

#[async_trait]
impl AiProvider for Anthropic {
    async fn stream(
        &self,
        req: &ChatRequest,
        log: &mut Log,
        sink: &mut (dyn FnMut(ProviderEvent) + Send),
    ) -> Result<()> {
        let secrets = self.redact_list();
        let call = self.call("v1/messages", Some(body(req)), &secrets)?;
        let resp = self.http.send(&call, log).await?;
        sink(ProviderEvent::FirstByte);
        let mut parser = SseParser::new();
        let mut state = State::default();
        let mut done = false;
        let mut failed = None;
        self.http
            .read_stream(resp, call.deadline, &mut |bytes| {
                let events = match parser.push(bytes) {
                    Ok(events) => events,
                    Err(e) => {
                        failed = Some(Error::Ai(e));
                        return false;
                    }
                };
                for ev in &events {
                    match self.on_event(ev, &req.model, &mut state, sink) {
                        Ok(false) => {}
                        Ok(true) => {
                            done = true;
                            return false;
                        }
                        Err(e) => {
                            failed = Some(e);
                            return false;
                        }
                    }
                }
                true
            })
            .await?;
        if let Some(e) = failed {
            return Err(e);
        }
        // The body ended: a last event with no blank line after it still counts.
        if !done && let Some(ev) = parser.finish().map_err(Error::Ai)? {
            done = self.on_event(&ev, &req.model, &mut state, sink)?;
        }
        sink(ProviderEvent::Stop(final_stop(state.stop, done)));
        Ok(())
    }

    async fn models(&self, log: &mut Log) -> Result<Vec<ListedModel>> {
        let secrets = self.redact_list();
        let mut models = Vec::new();
        let mut after: Option<String> = None;
        for _ in 0..MODELS_PAGES {
            let path = match &after {
                None => format!("v1/models?limit={MODELS_PAGE}"),
                Some(id) => format!("v1/models?limit={MODELS_PAGE}&after_id={id}"),
            };
            let call = self.call(&path, None, &secrets)?;
            let resp = self.http.send(&call, log).await?;
            let page = self.http.read_json(resp, call.deadline).await?;
            let data = page["data"]
                .as_array()
                .ok_or(Error::Ai(AiError::BadResponse))?;
            models.extend(data.iter().filter_map(listed));
            after = page["last_id"]
                .as_str()
                .filter(|_| page["has_more"].as_bool() == Some(true))
                .map(|id| url::form_urlencoded::byte_serialize(id.as_bytes()).collect());
            if after.is_none() {
                break;
            }
        }
        Ok(sorted_models(models))
    }
}

/// One `/v1/models` entry: `display_name`, `max_input_tokens`, `max_tokens` and whether
/// adaptive thinking is supported. A model with only budget thinking makes no claim, so
/// its built-in record decides.
fn listed(m: &Value) -> Option<ListedModel> {
    let id = m["id"].as_str().filter(|id| !id.is_empty())?;
    let thinking = |kind: &str| {
        m.pointer(&format!("/capabilities/thinking/types/{kind}/supported"))
            .and_then(Value::as_bool)
    };
    let reasoning = match (thinking("adaptive"), thinking("enabled")) {
        (Some(false), Some(true)) => None,
        (adaptive, _) => adaptive,
    };
    Some(ListedModel {
        id: id.to_string(),
        name: m["display_name"].as_str().map(str::to_string),
        context_window: count(&m["max_input_tokens"]),
        max_output: count(&m["max_tokens"]),
        chat: None,
        reasoning,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::ai::models::MaxTokensField;
    use crate::ai::provider::{ChatMessage, PromptBlock};

    fn request(thinking: Thinking, max_tokens: u32) -> ChatRequest {
        ChatRequest {
            model: "claude-sonnet-5-5".into(),
            system: vec![block("You write SQL.", false)],
            messages: vec![
                ChatMessage {
                    role: ChatRole::User,
                    text: "count users".into(),
                },
                ChatMessage {
                    role: ChatRole::Assistant,
                    text: "SELECT count(*) FROM users;".into(),
                },
            ],
            max_tokens,
            temperature: None,
            thinking,
            max_tokens_field: MaxTokensField::MaxTokens,
        }
    }

    fn block(text: &str, cache_mark: bool) -> PromptBlock {
        PromptBlock {
            text: text.into(),
            cache_mark,
        }
    }

    fn adaptive(effort: &str, summarized: bool) -> Thinking {
        Thinking::Adaptive {
            effort: effort.into(),
            summarized,
        }
    }

    fn provider() -> Anthropic {
        Anthropic::new(
            Url::parse("https://api.anthropic.com").unwrap(),
            "sk-ant-api03-unit-secret".into(),
            vec!["fixture-password".into()],
        )
        .unwrap()
    }

    /// Runs a fixture through the parser and `on_event`, as `stream` does.
    fn play(fixture: &str) -> (Vec<ProviderEvent>, Result<()>) {
        let p = provider();
        let mut parser = SseParser::new();
        let mut state = State::default();
        let mut got = Vec::new();
        let mut sink = |e| got.push(e);
        let mut result = Ok(());
        let mut done = false;
        for ev in parser.push(fixture.as_bytes()).unwrap() {
            match p.on_event(&ev, "m", &mut state, &mut sink) {
                Ok(true) => {
                    done = true;
                    break;
                }
                Ok(false) => {}
                Err(e) => {
                    result = Err(e);
                    break;
                }
            }
        }
        if result.is_ok() {
            sink(ProviderEvent::Stop(final_stop(state.stop, done)));
        }
        (got, result)
    }

    #[test]
    fn body_snapshot_plain() {
        assert_eq!(
            body(&request(Thinking::Off, 4096)),
            json!({
                "model": "claude-sonnet-5-5",
                "system": [{"type": "text", "text": "You write SQL."}],
                "messages": [
                    {"role": "user", "content": "count users"},
                    {"role": "assistant", "content": "SELECT count(*) FROM users;"}
                ],
                "stream": true,
                "max_tokens": 4096
            })
        );
    }

    #[test]
    fn body_with_budget_raises_max_tokens() {
        let b = body(&request(Thinking::Budget(8192), 4096));
        assert_eq!(b["max_tokens"], json!(12_288));
        assert_eq!(
            b["thinking"],
            json!({"type": "enabled", "budget_tokens": 8192})
        );
        // A max already above budget + 4,096 is kept.
        let b = body(&request(Thinking::Budget(2048), 32_000));
        assert_eq!(b["max_tokens"], json!(32_000));
    }

    #[test]
    fn body_max_tokens_always_set() {
        assert_eq!(body(&request(Thinking::Off, 0))["max_tokens"], json!(4096));
    }

    #[test]
    fn body_temperature_only_without_thinking() {
        let mut req = request(Thinking::Off, 4096);
        req.temperature = Some(0.25);
        assert_eq!(body(&req)["temperature"], json!(0.25));
        req.thinking = Thinking::Budget(2048);
        assert!(body(&req).get("temperature").is_none());
    }

    #[test]
    fn body_never_has_tools() {
        for thinking in [
            Thinking::Off,
            Thinking::Budget(1024),
            Thinking::Effort("high".into()),
            adaptive("high", true),
        ] {
            let b = body(&request(thinking, 4096));
            assert!(b.get("tools").is_none());
            assert!(b.get("tool_choice").is_none());
            assert!(!b.to_string().contains("\"tools\""));
        }
    }

    #[test]
    fn body_effort_is_not_sent() {
        let b = body(&request(Thinking::Effort("low".into()), 4096));
        assert!(b.get("thinking").is_none());
        assert!(b.get("reasoning_effort").is_none());
    }

    #[test]
    fn body_system_blocks_with_cache_marks() {
        const SCHEMA_BLOCK: &str = concat!("<<contura:schema>>\n", "<</contura:schema>>");
        let mut req = request(Thinking::Off, 4096);
        req.system = vec![block("You write SQL.", true), block(SCHEMA_BLOCK, true)];
        req.messages.truncate(1);
        assert_eq!(
            body(&req),
            json!({
                "model": "claude-sonnet-5-5",
                "system": [
                    {
                        "type": "text",
                        "text": "You write SQL.",
                        "cache_control": {"type": "ephemeral"}
                    },
                    {
                        "type": "text",
                        "text": SCHEMA_BLOCK,
                        "cache_control": {"type": "ephemeral"}
                    }
                ],
                "messages": [{"role": "user", "content": "count users"}],
                "stream": true,
                "max_tokens": 4096
            })
        );
    }

    #[test]
    fn body_without_caching_has_no_cache_control() {
        let mut req = request(Thinking::Off, 4096);
        req.system = vec![block("a", false), block("b", false)];
        let b = body(&req);
        assert!(!b.to_string().contains("cache_control"));
        assert_eq!(b["system"].as_array().unwrap().len(), 2);
        // No blocks: no `system` at all.
        req.system.clear();
        assert!(body(&req).get("system").is_none());
    }

    #[test]
    fn body_adaptive_effort_summarized() {
        let b = body(&request(adaptive("medium", true), 4096));
        assert_eq!(
            b["thinking"],
            json!({"type": "adaptive", "display": "summarized"})
        );
        assert_eq!(b["output_config"], json!({"effort": "medium"}));
        assert_eq!(b["max_tokens"], json!(12_288));
        let b = body(&request(adaptive("low", false), 4096));
        assert_eq!(
            b["thinking"],
            json!({"type": "adaptive", "display": "omitted"})
        );
        assert_eq!(b["max_tokens"], json!(6_144));
        let b = body(&request(adaptive("high", true), 4096));
        assert_eq!(b["max_tokens"], json!(28_672));
        assert_eq!(b["output_config"], json!({"effort": "high"}));
    }

    #[test]
    fn body_between_tools_and_disabled() {
        let b = body(&request(Thinking::BetweenTools, 4096));
        assert_eq!(b["thinking"], json!({"type": "between_tools"}));
        assert_eq!(b["max_tokens"], json!(4096));
        assert!(b.get("output_config").is_none());
        let b = body(&request(Thinking::Disabled, 4096));
        assert_eq!(b["thinking"], json!({"type": "disabled"}));
        assert_eq!(b["max_tokens"], json!(4096));
    }

    #[test]
    fn body_never_has_temperature_when_none() {
        for thinking in [
            Thinking::Off,
            Thinking::Disabled,
            Thinking::BetweenTools,
            adaptive("low", true),
            Thinking::Budget(2048),
        ] {
            let b = body(&request(thinking, 4096));
            assert!(b.get("temperature").is_none(), "{b}");
        }
    }

    #[test]
    fn cache_usage_is_kept_as_reported() {
        let (got, result) = play(include_str!(
            "../../../tests/fixtures/ai/anthropic_cache_usage.sse"
        ));
        result.unwrap();
        // Anthropic's `input_tokens` already leaves the cached tokens out.
        assert_eq!(
            got.iter()
                .filter_map(|e| match e {
                    ProviderEvent::Usage(u) => Some(*u),
                    _ => None,
                })
                .next_back(),
            Some(Usage {
                input: 200,
                output: 12,
                cache_read: 1_800,
                cache_write: 300,
            })
        );
    }

    #[test]
    fn stream_fixture_text_thinking_usage() {
        let (got, result) = play(include_str!(
            "../../../tests/fixtures/ai/anthropic_text_thinking_usage.sse"
        ));
        result.unwrap();
        let start = Usage {
            input: 812,
            output: 1,
            cache_read: 128,
            cache_write: 64,
        };
        assert_eq!(
            got,
            vec![
                ProviderEvent::Usage(start),
                ProviderEvent::Thinking("The user wants a count.".into()),
                ProviderEvent::Text("SELECT count(*)".into()),
                ProviderEvent::Text(" FROM users;".into()),
                ProviderEvent::Usage(Usage { output: 9, ..start }),
                ProviderEvent::Stop(StopReason::End),
            ]
        );
    }

    #[test]
    fn overloaded_error_event() {
        let (got, result) = play(include_str!(
            "../../../tests/fixtures/ai/anthropic_overloaded.sse"
        ));
        assert_eq!(got.last(), Some(&ProviderEvent::Text("SEL".into())));
        assert!(matches!(
            result,
            Err(Error::Ai(AiError::Overloaded {
                provider: AiProviderKind::Anthropic
            }))
        ));
    }

    #[test]
    fn other_error_event_is_redacted_provider_error() {
        let (_, result) = play(
            "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Bad key sk-ant-api03-unit-secret\"}}\n\n",
        );
        let Err(Error::Ai(AiError::Provider { status, message })) = result else {
            panic!("{result:?}");
        };
        assert_eq!(status, 500);
        assert_eq!(message, "Bad key [redacted]");
    }

    #[test]
    fn refusal_stop() {
        let (got, result) = play(include_str!(
            "../../../tests/fixtures/ai/anthropic_refusal.sse"
        ));
        result.unwrap();
        assert_eq!(got.last(), Some(&ProviderEvent::Stop(StopReason::Refusal)));
    }

    #[test]
    fn max_tokens_stop_is_length() {
        let (got, _) = play(include_str!(
            "../../../tests/fixtures/ai/anthropic_length.sse"
        ));
        assert_eq!(got.last(), Some(&ProviderEvent::Stop(StopReason::Length)));
    }

    #[test]
    fn ending_before_message_stop_is_dropped() {
        let (got, result) = play(include_str!(
            "../../../tests/fixtures/ai/anthropic_cut_off.sse"
        ));
        result.unwrap();
        assert_eq!(
            got[1..],
            [
                ProviderEvent::Text("SELECT ".into()),
                ProviderEvent::Text("name FROM".into()),
                ProviderEvent::Stop(StopReason::Dropped),
            ]
        );
    }

    #[test]
    fn bad_json_is_bad_response() {
        let (_, result) = play("event: message_start\ndata: {not json\n\n");
        assert!(matches!(result, Err(Error::Ai(AiError::BadResponse))));
    }

    #[test]
    fn urls_join_the_base() {
        let p = provider();
        assert_eq!(
            p.url("v1/messages").unwrap().as_str(),
            "https://api.anthropic.com/v1/messages"
        );
    }
}
