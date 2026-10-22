//! Talking to an AI provider over HTTP.

pub mod anthropic;
pub mod http;
pub mod openai;
#[cfg(any(test, feature = "test-util"))]
pub mod scripted;
pub mod sse;
pub mod url;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::ai::AiProviderKind;
use crate::ai::log::Log;
use crate::ai::models::{MaxTokensField, ModelInfo, ThinkingKind, ThinkingLevel, ThinkingOff};
use crate::error::Result;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatRole {
    User,
    Assistant,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub text: String,
}

/// One block of the system prompt. A block with `cache_mark` ends a cached prefix where the
/// provider takes cache marks (Anthropic); elsewhere the mark is ignored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptBlock {
    pub text: String,
    pub cache_mark: bool,
}

/// How much the model may think before it answers, as it goes on the wire.
#[derive(Clone, Debug, PartialEq)]
pub enum Thinking {
    /// Nothing is sent.
    Off,
    /// `{"type":"disabled"}` (Anthropic models that think unless told not to).
    Disabled,
    /// `{"type":"between_tools"}`: the Anthropic Off for models that cannot switch it off fully.
    BetweenTools,
    /// A token budget (older Anthropic models).
    Budget(u32),
    /// Adaptive thinking with an effort (Anthropic 5.x); `summarized` asks for the
    /// thinking text, otherwise it is omitted.
    Adaptive { effort: String, summarized: bool },
    /// A named effort such as `low` or `none` (OpenAI-compatible).
    Effort(String),
}

/// The thinking budget of a level for models that take one.
fn level_budget(level: ThinkingLevel) -> Option<u32> {
    match level {
        ThinkingLevel::Off => None,
        ThinkingLevel::Low => Some(2_048),
        ThinkingLevel::Medium => Some(8_192),
        ThinkingLevel::High => Some(24_576),
    }
}

fn level_name(level: ThinkingLevel) -> &'static str {
    match level {
        ThinkingLevel::Off => "none",
        ThinkingLevel::Low => "low",
        ThinkingLevel::Medium => "medium",
        ThinkingLevel::High => "high",
    }
}

/// The thinking budget an effort name stands for, for raising Anthropic's `max_tokens`.
pub(crate) fn effort_budget(effort: &str) -> Option<u32> {
    match effort {
        "low" => level_budget(ThinkingLevel::Low),
        "medium" => level_budget(ThinkingLevel::Medium),
        "high" => level_budget(ThinkingLevel::High),
        _ => None,
    }
}

/// The `max_tokens` a `kind` provider's body carries: Anthropic raises it by a thinking
/// budget (`Budget`, `Adaptive`) so the answer keeps room after it; an OpenAI-compatible
/// body sends it as asked. The Ask measures `TooBig` with it, and the preview leaves it
/// out of the window before the schema share.
pub fn max_tokens_on_wire(kind: AiProviderKind, max_tokens: u32, thinking: &Thinking) -> u32 {
    match kind {
        AiProviderKind::Anthropic => anthropic::raised_max_tokens(max_tokens, thinking),
        _ => max_tokens,
    }
}

/// The wire form of `level` for `info`'s kind of thinking; `share` asks for the thinking
/// text where the model can leave it out. `level` is expected clamped.
pub fn wire_thinking(info: &ModelInfo, level: ThinkingLevel, share: bool) -> Thinking {
    match (info.thinking, level) {
        (ThinkingKind::None, _) => Thinking::Off,
        (ThinkingKind::AnthropicEffort, ThinkingLevel::Off) => match info.thinking_off {
            ThinkingOff::Disabled => Thinking::Disabled,
            ThinkingOff::BetweenTools => Thinking::BetweenTools,
            _ => Thinking::Off,
        },
        (ThinkingKind::AnthropicEffort, level) => Thinking::Adaptive {
            effort: level_name(level).into(),
            summarized: share,
        },
        (ThinkingKind::AnthropicBudget, level) => {
            level_budget(level).map_or(Thinking::Off, Thinking::Budget)
        }
        (ThinkingKind::ReasoningEffort, ThinkingLevel::Off) => match info.thinking_off {
            ThinkingOff::EffortNone => Thinking::Effort("none".into()),
            _ => Thinking::Off,
        },
        (ThinkingKind::ReasoningEffort, level) => Thinking::Effort(level_name(level).into()),
    }
}

/// A tool the model may call, as it goes on the wire. The Ask carries at most one.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChatRequest {
    pub model: String,
    /// In order; the stable blocks first so the same pick gives the same prefix.
    pub system: Vec<PromptBlock>,
    pub messages: Vec<ChatMessage>,
    pub max_tokens: u32,
    pub temperature: Option<f32>,
    pub thinking: Thinking,
    /// Which field carries `max_tokens` (OpenAI-compatible).
    pub max_tokens_field: MaxTokensField,
    /// `None` sends no `tools` key at all (every database Ask).
    pub tools: Option<ToolSpec>,
}

/// Token counts, the same for every provider: `input` excludes the tokens read from the
/// cache, which `cache_read` counts (Anthropic reports it so; OpenAI-compatible providers
/// include them in `prompt_tokens`, so they are taken out).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input: u32,
    pub output: u32,
    pub cache_read: u32,
    pub cache_write: u32,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    End,
    Length,
    Refusal,
    TooLong,
    /// The stream ended without the provider saying it was done.
    Dropped,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ProviderEvent {
    FirstByte,
    Text(String),
    Thinking(String),
    Usage(Usage),
    /// One finished tool call: the tool's name and its input as the JSON text the model wrote.
    ToolCall {
        name: String,
        input: String,
    },
    Stop(StopReason),
}

/// One model from the provider's `/models` listing, with what the listing says about it.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ListedModel {
    pub id: String,
    pub name: Option<String>,
    pub context_window: Option<u32>,
    pub max_output: Option<u32>,
    /// `Some(false)` when the listing says the model does not write text.
    pub chat: Option<bool>,
    /// Whether the model accepts a thinking control, when the listing says.
    pub reasoning: Option<bool>,
}

/// Sorted by id, one entry per id (the first listed wins).
pub(crate) fn sorted_models(mut models: Vec<ListedModel>) -> Vec<ListedModel> {
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    models
}

/// A positive count from a listing field.
pub(crate) fn count(v: &serde_json::Value) -> Option<u32> {
    v.as_u64()
        .filter(|n| *n > 0)
        .map(|n| u32::try_from(n).unwrap_or(u32::MAX))
}

/// The tool definition as one wire text, for the Sent record's bytes and hash.
pub(crate) fn tool_text(req: &ChatRequest) -> Option<String> {
    req.tools
        .as_ref()
        .and_then(|tool| serde_json::to_string(&[tool]).ok())
}

#[async_trait]
pub trait AiProvider: Send + Sync {
    /// Each text `stream` puts on the wire for `req`, in order: the Sent record's bytes and
    /// hash are taken over exactly these. By default each system block, then each message,
    /// then the tool definition when there is one.
    fn wire_texts(&self, req: &ChatRequest) -> Vec<String> {
        req.system
            .iter()
            .map(|b| b.text.clone())
            .chain(req.messages.iter().map(|m| m.text.clone()))
            .chain(tool_text(req))
            .collect()
    }

    /// Streams one answer into `sink`; returns once the provider stops or fails. Each HTTP
    /// attempt and retry is a line in `log`.
    async fn stream(
        &self,
        req: &ChatRequest,
        log: &mut Log,
        sink: &mut (dyn FnMut(ProviderEvent) + Send),
    ) -> Result<()>;

    /// The models the provider offers, sorted by id.
    async fn models(&self, log: &mut Log) -> Result<Vec<ListedModel>>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::AiProviderKind::{Anthropic, Groq, OpenAi};
    use crate::ai::models::builtin;
    use ThinkingLevel::{High, Low, Medium, Off};

    fn adaptive(effort: &str, summarized: bool) -> Thinking {
        Thinking::Adaptive {
            effort: effort.into(),
            summarized,
        }
    }

    #[test]
    fn max_tokens_on_wire_per_provider() {
        use crate::ai::AiProviderKind as K;
        let high = Thinking::Budget(24_576);
        assert_eq!(max_tokens_on_wire(K::Anthropic, 4_096, &high), 28_672);
        assert_eq!(
            max_tokens_on_wire(K::Anthropic, 8_000, &Thinking::Off),
            8_000
        );
        let adaptive = Thinking::Adaptive {
            effort: "medium".into(),
            summarized: true,
        };
        assert_eq!(max_tokens_on_wire(K::Anthropic, 4_096, &adaptive), 12_288);
        // An OpenAI-compatible body never raises it, whatever the thinking.
        for kind in [K::OpenAi, K::Groq, K::DeepSeek, K::Custom] {
            assert_eq!(max_tokens_on_wire(kind, 4_096, &high), 4_096);
            assert_eq!(max_tokens_on_wire(kind, 4_096, &adaptive), 4_096);
        }
    }

    #[test]
    fn wire_thinking_per_kind() {
        let model = |kind, id| builtin(kind, None, id).unwrap();
        let sonnet = model(Anthropic, "claude-sonnet-5-5");
        assert_eq!(wire_thinking(&sonnet, Low, true), adaptive("low", true));
        assert_eq!(
            wire_thinking(&sonnet, Medium, false),
            adaptive("medium", false)
        );
        assert_eq!(wire_thinking(&sonnet, High, true), adaptive("high", true));
        assert_eq!(wire_thinking(&sonnet, Off, true), Thinking::BetweenTools);
        let haiku5 = model(Anthropic, "claude-haiku-5-5");
        assert_eq!(wire_thinking(&haiku5, Off, true), Thinking::Disabled);
        let haiku4 = model(Anthropic, "claude-haiku-4-5");
        assert_eq!(wire_thinking(&haiku4, Low, true), Thinking::Budget(2_048));
        assert_eq!(
            wire_thinking(&haiku4, Medium, true),
            Thinking::Budget(8_192)
        );
        assert_eq!(wire_thinking(&haiku4, High, true), Thinking::Budget(24_576));
        assert_eq!(wire_thinking(&haiku4, Off, true), Thinking::Off);
        let qwen = model(Groq, "qwen/qwen3.8-27b");
        assert_eq!(
            wire_thinking(&qwen, Off, true),
            Thinking::Effort("none".into())
        );
        assert_eq!(
            wire_thinking(&qwen, High, true),
            Thinking::Effort("high".into())
        );
        let oss = model(Groq, "openai/gpt-oss-20b");
        assert_eq!(wire_thinking(&oss, Off, true), Thinking::Off);
        let gpt = builtin(OpenAi, Some("OpenAI"), "gpt-4.1").unwrap();
        assert_eq!(wire_thinking(&gpt, High, true), Thinking::Off);
    }
}
