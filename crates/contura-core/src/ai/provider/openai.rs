//! The OpenAI-compatible chat API: OpenAI, Groq, OpenRouter, DeepSeek and Custom.

use async_trait::async_trait;
use serde_json::{Map, Value, json};
use url::Url;

use super::http::{self, Call, Http};
use super::sse::{SseEvent, SseParser};
use super::{
    AiProvider, ChatRequest, ChatRole, ListedModel, ProviderEvent, StopReason, Thinking, Usage,
    count, sorted_models,
};
use crate::ai::log::{Level, Log};
use crate::ai::models::MaxTokensField;
use crate::ai::rails::input::{Secrets, redact_secrets, strip_invisible};
use crate::ai::{AiError, AiProviderKind};
use crate::error::{Error, Result};

pub struct OpenAi {
    pub base: Url,
    /// `None` or empty sends no `Authorization` header (a Custom server without a key).
    pub key: Option<String>,
    pub kind: AiProviderKind,
    /// Redacted from any provider message.
    pub secrets: Vec<String>,
    pub http: &'static Http,
}

/// The `chat/completions` body. Never has a `tools` key or a cache field: the system
/// blocks go as one system message, left out when there are none.
/// The system blocks as one system message: an OpenAI-compatible body has no blocks.
fn system_text(req: &ChatRequest) -> String {
    req.system
        .iter()
        .map(|b| b.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Each message's content as `body` puts it on the wire, in order.
pub fn wire_texts(req: &ChatRequest) -> Vec<String> {
    let system = system_text(req);
    (!system.is_empty())
        .then_some(system)
        .into_iter()
        .chain(req.messages.iter().map(|m| m.text.clone()))
        .collect()
}

pub fn body(req: &ChatRequest) -> Value {
    let system = system_text(req);
    let mut messages = Vec::new();
    if !system.is_empty() {
        messages.push(json!({ "role": "system", "content": system }));
    }
    messages.extend(req.messages.iter().map(|m| {
        let role = match m.role {
            ChatRole::User => "user",
            ChatRole::Assistant => "assistant",
        };
        json!({ "role": role, "content": m.text })
    }));
    let mut body = Map::new();
    body.insert("model".into(), json!(req.model));
    body.insert("messages".into(), Value::Array(messages));
    body.insert("stream".into(), json!(true));
    body.insert("stream_options".into(), json!({ "include_usage": true }));
    if req.max_tokens > 0 {
        let field = match req.max_tokens_field {
            MaxTokensField::MaxTokens => "max_tokens",
            MaxTokensField::MaxCompletionTokens => "max_completion_tokens",
        };
        body.insert(field.into(), json!(req.max_tokens));
    }
    if let Some(t) = req.temperature {
        body.insert("temperature".into(), json!(t));
    }
    if let Thinking::Effort(effort) = &req.thinking {
        body.insert("reasoning_effort".into(), json!(effort));
    }
    Value::Object(body)
}

/// The longest finish reason kept in the log line for one the client does not know.
const REASON_CHARS: usize = 40;

/// The reason sent last: the finish reason, or `End` after `[DONE]` without one. A body that
/// ends with neither was cut off.
fn final_stop(stop: Option<StopReason>, done: bool) -> StopReason {
    match (stop, done) {
        (Some(reason), _) => reason,
        (None, true) => StopReason::End,
        (None, false) => StopReason::Dropped,
    }
}

impl OpenAi {
    /// A provider on the shared HTTP client; fails when that client could not be built.
    pub fn new(
        base: Url,
        key: Option<String>,
        kind: AiProviderKind,
        secrets: Vec<String>,
    ) -> Result<Self> {
        Ok(Self {
            base,
            key,
            kind,
            secrets,
            http: Http::shared()?,
        })
    }

    /// `{base}/{path}`, keeping the base's own path (`/openai/v1`).
    fn url(&self, path: &str) -> Result<Url> {
        let joined = format!("{}/{path}", self.base.as_str().trim_end_matches('/'));
        Url::parse(&joined).map_err(|_| Error::Ai(AiError::BadResponse))
    }

    fn headers(&self) -> Vec<(&'static str, String, bool)> {
        match self.key.as_deref().filter(|k| !k.is_empty()) {
            Some(key) => vec![("authorization", format!("Bearer {key}"), true)],
            None => Vec::new(),
        }
    }

    /// The given secrets plus the key itself, so a provider echoing the key never shows it.
    fn redact_list(&self) -> Vec<String> {
        let mut list = self.secrets.clone();
        if let Some(key) = self.key.as_deref().filter(|k| !k.is_empty()) {
            list.push(key.to_string());
        }
        list
    }

    fn call<'a>(&self, path: &str, body: Option<Value>, secrets: &'a [String]) -> Result<Call<'a>> {
        Ok(Call {
            url: self.url(path)?,
            headers: self.headers(),
            body,
            provider: self.kind,
            secrets,
            deadline: self.http.deadline(),
        })
    }

    /// Hands one event's thinking, text and usage to `sink` and keeps its finish reason in
    /// `stop`, which `stream` sends last. True once `[DONE]` arrives. `model` is the one
    /// asked for, named by a mid-stream "model not found".
    fn on_event(
        &self,
        ev: &SseEvent,
        model: &str,
        stop: &mut Option<StopReason>,
        log: &mut Log,
        sink: &mut (dyn FnMut(ProviderEvent) + Send),
    ) -> Result<bool> {
        let data = ev.data.trim();
        if data == "[DONE]" {
            return Ok(true);
        }
        let chunk: Value =
            serde_json::from_str(data).map_err(|_| Error::Ai(AiError::BadResponse))?;
        if chunk.get("error").is_some_and(|e| !e.is_null()) {
            // A failure after the 200 head, mapped as its own error status would be. One
            // with no such code says nothing usable.
            let status = chunk
                .pointer("/error/code")
                .and_then(Value::as_u64)
                .and_then(|c| u16::try_from(c).ok())
                .filter(|c| (400..600).contains(c));
            return Err(Error::Ai(match status {
                Some(status) => {
                    http::map_status(status, None, data, self.kind, model, &self.redact_list())
                }
                None => AiError::BadResponse,
            }));
        }
        if let Some(choice) = chunk.pointer("/choices/0") {
            let delta = &choice["delta"];
            // `reasoning` (Groq, OpenRouter) or `reasoning_content` (DeepSeek).
            for field in ["reasoning", "reasoning_content"] {
                if let Some(text) = delta[field].as_str().filter(|t| !t.is_empty()) {
                    sink(ProviderEvent::Thinking(text.to_string()));
                }
            }
            if let Some(text) = delta["content"].as_str().filter(|t| !t.is_empty()) {
                sink(ProviderEvent::Text(text.to_string()));
            }
            if let Some(reason) = choice["finish_reason"].as_str() {
                *stop = Some(match reason {
                    "stop" => StopReason::End,
                    "length" => StopReason::Length,
                    "content_filter" => StopReason::Refusal,
                    other => {
                        // Provider text: cleaned and redacted like a provider message.
                        let (clean, _) = strip_invisible(other);
                        let keys = Secrets {
                            keys: self.redact_list(),
                            passwords: Vec::new(),
                        };
                        let (clean, _) = redact_secrets(&clean, &keys);
                        let clean: String = clean.chars().take(REASON_CHARS).collect();
                        log.push(Level::Warn, "answer", &[("finish_reason", clean)]);
                        StopReason::End
                    }
                });
            }
        }
        if let Some(usage) = chunk.get("usage").filter(|u| u.is_object()) {
            let n = |path: &str| {
                usage
                    .pointer(path)
                    .and_then(Value::as_u64)
                    .map(|v| u32::try_from(v).unwrap_or(u32::MAX))
            };
            // `prompt_tokens` counts the cached ones too (DeepSeek names them
            // `prompt_cache_hit_tokens`); `input` leaves them out.
            let cached = n("/prompt_tokens_details/cached_tokens")
                .or_else(|| n("/prompt_cache_hit_tokens"))
                .unwrap_or(0);
            sink(ProviderEvent::Usage(Usage {
                input: n("/prompt_tokens").unwrap_or(0).saturating_sub(cached),
                output: n("/completion_tokens").unwrap_or(0),
                cache_read: cached,
                cache_write: 0,
            }));
        }
        Ok(false)
    }
}

#[async_trait]
impl AiProvider for OpenAi {
    fn wire_texts(&self, req: &ChatRequest) -> Vec<String> {
        wire_texts(req)
    }

    async fn stream(
        &self,
        req: &ChatRequest,
        log: &mut Log,
        sink: &mut (dyn FnMut(ProviderEvent) + Send),
    ) -> Result<()> {
        let secrets = self.redact_list();
        let call = self.call("chat/completions", Some(body(req)), &secrets)?;
        let resp = self.http.send(&call, log).await?;
        sink(ProviderEvent::FirstByte);
        let mut parser = SseParser::new();
        let mut stop = None;
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
                    match self.on_event(ev, &req.model, &mut stop, log, sink) {
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
            done = self.on_event(&ev, &req.model, &mut stop, log, sink)?;
        }
        sink(ProviderEvent::Stop(final_stop(stop, done)));
        Ok(())
    }

    async fn models(&self, log: &mut Log) -> Result<Vec<ListedModel>> {
        let secrets = self.redact_list();
        let call = self.call("models", None, &secrets)?;
        let resp = self.http.send(&call, log).await?;
        let list = self.http.read_json(resp, call.deadline).await?;
        let data = list["data"]
            .as_array()
            .ok_or(Error::Ai(AiError::BadResponse))?;
        Ok(sorted_models(data.iter().filter_map(listed).collect()))
    }
}

/// One `/models` entry. Groq gives `context_window` and `max_completion_tokens`;
/// OpenRouter gives `name`, `context_length`, `architecture.output_modalities`,
/// `supported_parameters` and `top_provider.max_completion_tokens`.
fn listed(m: &Value) -> Option<ListedModel> {
    let id = m["id"].as_str().filter(|id| !id.is_empty())?;
    let chat = m
        .pointer("/architecture/output_modalities")
        .and_then(Value::as_array)
        .map(|out| out.iter().any(|o| o.as_str() == Some("text")));
    let reasoning = m["supported_parameters"]
        .as_array()
        .map(|params| params.iter().any(|p| p.as_str() == Some("reasoning")));
    Some(ListedModel {
        id: id.to_string(),
        name: m["name"].as_str().map(str::to_string),
        context_window: count(&m["context_window"]).or_else(|| count(&m["context_length"])),
        max_output: count(&m["max_completion_tokens"])
            .or_else(|| count(&m["top_provider"]["max_completion_tokens"])),
        chat,
        reasoning,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::ai::provider::{ChatMessage, PromptBlock};

    fn request(thinking: Thinking, temperature: Option<f32>) -> ChatRequest {
        ChatRequest {
            model: "llama-3.3-70b-versatile".into(),
            system: vec![block("You write SQL.")],
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
            max_tokens: 4096,
            temperature,
            thinking,
            max_tokens_field: MaxTokensField::MaxTokens,
        }
    }

    fn block(text: &str) -> PromptBlock {
        PromptBlock {
            text: text.into(),
            cache_mark: true,
        }
    }

    fn provider() -> OpenAi {
        OpenAi {
            base: Url::parse("https://api.groq.com/openai/v1").unwrap(),
            key: Some("gsk_unit_secret".into()),
            kind: AiProviderKind::Groq,
            secrets: vec!["sk-or-v1-fixture-secret".into()],
            http: Http::shared().unwrap(),
        }
    }

    /// Runs a fixture through the parser and `on_event`, as `stream` does.
    fn play(fixture: &str) -> (Vec<ProviderEvent>, Result<()>) {
        let p = provider();
        let mut parser = SseParser::new();
        let mut stop = None;
        let mut log = Log::new();
        let mut got = Vec::new();
        let mut sink = |e| got.push(e);
        let mut result = Ok(());
        let mut done = false;
        for ev in parser.push(fixture.as_bytes()).unwrap() {
            match p.on_event(&ev, "m", &mut stop, &mut log, &mut sink) {
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
            sink(ProviderEvent::Stop(final_stop(stop, done)));
        }
        (got, result)
    }

    #[test]
    fn body_snapshot_plain() {
        assert_eq!(
            body(&request(Thinking::Off, None)),
            json!({
                "model": "llama-3.3-70b-versatile",
                "messages": [
                    {"role": "system", "content": "You write SQL."},
                    {"role": "user", "content": "count users"},
                    {"role": "assistant", "content": "SELECT count(*) FROM users;"}
                ],
                "stream": true,
                "stream_options": {"include_usage": true},
                "max_tokens": 4096
            })
        );
    }

    #[test]
    fn body_snapshot_with_effort() {
        assert_eq!(
            body(&request(Thinking::Effort("low".into()), Some(0.25))),
            json!({
                "model": "llama-3.3-70b-versatile",
                "messages": [
                    {"role": "system", "content": "You write SQL."},
                    {"role": "user", "content": "count users"},
                    {"role": "assistant", "content": "SELECT count(*) FROM users;"}
                ],
                "stream": true,
                "stream_options": {"include_usage": true},
                "max_tokens": 4096,
                "temperature": 0.25,
                "reasoning_effort": "low"
            })
        );
    }

    #[test]
    fn body_budget_thinking_is_not_sent() {
        let b = body(&request(Thinking::Budget(2048), None));
        assert!(b.get("reasoning_effort").is_none());
        assert!(b.get("thinking").is_none());
    }

    #[test]
    fn body_never_has_tools() {
        for thinking in [
            Thinking::Off,
            Thinking::Budget(1024),
            Thinking::Effort("high".into()),
        ] {
            let b = body(&request(thinking, Some(0.5)));
            assert!(b.get("tools").is_none());
            assert!(b.get("tool_choice").is_none());
            assert!(!b.to_string().contains("\"tools\""));
        }
    }

    #[test]
    fn wire_texts_are_the_body_contents() {
        let mut req = request(Thinking::Off, None);
        req.system = vec![block("You write SQL."), block("<<contura:schema>>")];
        let b = body(&req);
        let contents: Vec<String> = b["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["content"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(wire_texts(&req), contents);
        req.system.clear();
        assert_eq!(wire_texts(&req).len(), 2);
    }

    #[test]
    fn body_joins_system_blocks() {
        let mut req = request(Thinking::Off, None);
        req.system = vec![block("You write SQL."), block("<<contura:schema>>")];
        let b = body(&req);
        assert_eq!(
            b["messages"][0],
            json!({"role": "system", "content": "You write SQL.\n\n<<contura:schema>>"})
        );
        // Cache marks never reach an OpenAI-compatible body.
        assert!(!b.to_string().contains("cache"));
    }

    #[test]
    fn empty_system_is_left_out() {
        let mut req = request(Thinking::Off, None);
        req.system.clear();
        let b = body(&req);
        assert_eq!(b["messages"][0]["role"], "user");
        assert_eq!(b["messages"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn max_completion_tokens_field() {
        let mut req = request(Thinking::Effort("low".into()), None);
        req.max_tokens_field = MaxTokensField::MaxCompletionTokens;
        let b = body(&req);
        assert_eq!(b["max_completion_tokens"], json!(4096));
        assert!(b.get("max_tokens").is_none());
    }

    #[test]
    fn effort_none_for_qwen_off() {
        let b = body(&request(Thinking::Effort("none".into()), None));
        assert_eq!(b["reasoning_effort"], "none");
        for thinking in [
            Thinking::Disabled,
            Thinking::BetweenTools,
            Thinking::Adaptive {
                effort: "low".into(),
                summarized: true,
            },
        ] {
            let b = body(&request(thinking, None));
            assert!(b.get("reasoning_effort").is_none());
            assert!(b.get("thinking").is_none());
        }
    }

    fn usage_of(got: &[ProviderEvent]) -> Option<Usage> {
        got.iter().find_map(|e| match e {
            ProviderEvent::Usage(u) => Some(*u),
            _ => None,
        })
    }

    #[test]
    fn cached_tokens_leave_input() {
        let (got, result) = play(include_str!(
            "../../../tests/fixtures/ai/openai_cached_usage.sse"
        ));
        result.unwrap();
        assert_eq!(
            usage_of(&got),
            Some(Usage {
                input: 200,
                output: 7,
                cache_read: 800,
                cache_write: 0,
            })
        );
    }

    #[test]
    fn deepseek_cache_hit_tokens() {
        let (got, _) = play(
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":900,\"completion_tokens\":5,\"prompt_cache_hit_tokens\":600,\"prompt_cache_miss_tokens\":300}}\n\ndata: [DONE]\n\n",
        );
        assert_eq!(
            usage_of(&got),
            Some(Usage {
                input: 300,
                output: 5,
                cache_read: 600,
                cache_write: 0,
            })
        );
    }

    #[test]
    fn fixture_text_usage_done() {
        let (got, result) = play(include_str!(
            "../../../tests/fixtures/ai/openai_text_usage.sse"
        ));
        result.unwrap();
        assert_eq!(
            got,
            vec![
                ProviderEvent::Text("SELECT count(*)".into()),
                ProviderEvent::Text(" FROM users;".into()),
                ProviderEvent::Usage(Usage {
                    input: 684,
                    output: 9,
                    cache_read: 128,
                    cache_write: 0,
                }),
                ProviderEvent::Stop(StopReason::End),
            ]
        );
    }

    #[test]
    fn reasoning_delta_becomes_thinking() {
        let (got, result) = play(include_str!(
            "../../../tests/fixtures/ai/openai_reasoning.sse"
        ));
        result.unwrap();
        assert_eq!(
            got,
            vec![
                ProviderEvent::Thinking("The user wants a count.".into()),
                ProviderEvent::Text("SELECT 1;".into()),
                ProviderEvent::Stop(StopReason::End),
            ]
        );
    }

    #[test]
    fn reasoning_content_becomes_thinking() {
        let (got, _) = play(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"hmm\"}}]}\n\ndata: [DONE]\n\n",
        );
        assert_eq!(got[0], ProviderEvent::Thinking("hmm".into()));
    }

    #[test]
    fn length_finish_maps() {
        let (got, _) = play(include_str!("../../../tests/fixtures/ai/openai_length.sse"));
        assert_eq!(got.last(), Some(&ProviderEvent::Stop(StopReason::Length)));
    }

    #[test]
    fn content_filter_finish_is_refusal() {
        let (got, _) = play(
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"content_filter\"}]}\n\ndata: [DONE]\n\n",
        );
        assert_eq!(got, vec![ProviderEvent::Stop(StopReason::Refusal)]);
    }

    #[test]
    fn done_ends_even_with_more_after() {
        let p = provider();
        let mut stop = None;
        let ev = SseEvent {
            event: None,
            data: "[DONE]".into(),
        };
        assert!(
            p.on_event(&ev, "m", &mut stop, &mut Log::new(), &mut |_| {})
                .unwrap()
        );
    }

    #[test]
    fn cut_off_without_finish_is_dropped() {
        let (got, result) = play(include_str!(
            "../../../tests/fixtures/ai/openai_cut_off.sse"
        ));
        result.unwrap();
        assert_eq!(got.last(), Some(&ProviderEvent::Stop(StopReason::Dropped)));
    }

    #[test]
    fn error_object_is_redacted_provider_error() {
        let (got, result) = play(include_str!("../../../tests/fixtures/ai/openai_error.sse"));
        assert_eq!(got, vec![ProviderEvent::Text("SEL".into())]);
        let Err(Error::Ai(AiError::Provider { status, message })) = result else {
            panic!("{result:?}");
        };
        assert_eq!(status, 502);
        assert_eq!(message, "Upstream failed for key [redacted]");
    }

    #[test]
    fn bad_json_is_bad_response() {
        let (_, result) = play("data: {not json\n\n");
        assert!(matches!(result, Err(Error::Ai(AiError::BadResponse))));
    }
}
