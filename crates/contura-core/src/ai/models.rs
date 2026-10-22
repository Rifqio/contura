//! Model capability records: what each model accepts (window, thinking, caching), from the
//! provider's listing where it says so and a built-in table otherwise, and the per-model
//! picks clamped to them.

use serde::{Deserialize, Serialize};

use crate::ai::provider::ListedModel;
use crate::ai::{AiProviderKind, AiSettings};

/// The window of a model nothing is known about, when the settings leave it unset.
const UNKNOWN_WINDOW: u32 = 8_000;
/// The window of an Anthropic model neither the listing nor the built-in table knows, when
/// the settings leave it unset: every Claude model has at least this.
pub const UNKNOWN_ANTHROPIC_WINDOW: u32 = 200_000;

/// Words in an id that mark a model that does not chat (speech, images, guards, embeddings).
const NOT_CHAT: [&str; 11] = [
    "whisper",
    "tts",
    "orpheus",
    "guard",
    "embed",
    "moderation",
    "transcribe",
    "audio",
    "dall-e",
    "image",
    "realtime",
];

/// How the model thinks before it answers, if it does.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ThinkingKind {
    None,
    /// Adaptive thinking with an effort (Anthropic 5.x).
    AnthropicEffort,
    /// Extended thinking with a token budget.
    AnthropicBudget,
    /// `reasoning_effort` (OpenAI-compatible).
    ReasoningEffort,
}

/// How thinking Off is sent.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ThinkingOff {
    /// Nothing is sent.
    Omit,
    /// The model always thinks; Off is not offered.
    NotAllowed,
    /// `{"type":"disabled"}`.
    Disabled,
    /// `{"type":"between_tools"}`.
    BetweenTools,
    /// `reasoning_effort: "none"`.
    EffortNone,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CachingKind {
    None,
    /// Cache marks in the request (Anthropic); the user can switch them off.
    Breakpoints,
    /// The provider caches on its own; always on.
    Automatic,
}

/// Where the model sits in its provider's line-up; sets the default thinking level.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ModelTier {
    Largest,
    Mid,
    Fastest,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MaxTokensField {
    MaxTokens,
    MaxCompletionTokens,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ThinkingLevel {
    Off,
    Low,
    Medium,
    High,
}

/// The thinking level and caching switch picked for one model.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelPicks {
    pub thinking: ThinkingLevel,
    pub caching: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub context_window: u32,
    pub max_output: Option<u32>,
    pub thinking: ThinkingKind,
    pub thinking_off: ThinkingOff,
    pub shares_thinking: bool,
    pub caching: CachingKind,
    /// Whether the model takes a temperature.
    pub temperature: bool,
    pub max_tokens_field: MaxTokensField,
    pub tier: Option<ModelTier>,
    /// False when neither the built-in table nor the listing says anything about it.
    pub known: bool,
    /// The picks for this model, already clamped.
    pub picks: ModelPicks,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelList {
    pub models: Vec<ModelInfo>,
    pub current: String,
    /// When the listing was fetched, epoch milliseconds; `None` before the first fetch.
    pub fetched_at: Option<i64>,
}

/// One row of the built-in table.
struct Row {
    kind: AiProviderKind,
    /// For the OpenAI-compatible kind: the preset the row belongs to.
    preset: Option<&'static str>,
    id: &'static str,
    name: Option<&'static str>,
    window: u32,
    max_output: Option<u32>,
    thinking: ThinkingKind,
    off: ThinkingOff,
    caching: CachingKind,
    temperature: bool,
    max_tokens_field: MaxTokensField,
    tier: Option<ModelTier>,
}

// One argument per table column keeps each row on one line.
#[allow(clippy::too_many_arguments)]
const fn anthropic(
    id: &'static str,
    name: &'static str,
    window: u32,
    max_output: u32,
    thinking: ThinkingKind,
    off: ThinkingOff,
    temperature: bool,
    tier: ModelTier,
) -> Row {
    Row {
        kind: AiProviderKind::Anthropic,
        preset: None,
        id,
        name: Some(name),
        window,
        max_output: Some(max_output),
        thinking,
        off,
        caching: CachingKind::Breakpoints,
        temperature,
        max_tokens_field: MaxTokensField::MaxTokens,
        tier: Some(tier),
    }
}

#[allow(clippy::too_many_arguments)]
const fn compatible(
    kind: AiProviderKind,
    preset: Option<&'static str>,
    id: &'static str,
    window: u32,
    thinking: ThinkingKind,
    off: ThinkingOff,
    caching: CachingKind,
    temperature: bool,
    tier: Option<ModelTier>,
) -> Row {
    Row {
        kind,
        preset,
        id,
        name: None,
        window,
        max_output: None,
        thinking,
        off,
        caching,
        temperature,
        max_tokens_field: MaxTokensField::MaxTokens,
        tier,
    }
}

/// OpenAI values are guesses the listing overrides. Groq's are from the live checks
/// (`tests/ai_groq_live.rs`, 2026-10-20): gpt-oss rejects `reasoning_effort: "none"` and
/// reasons when nothing is sent, so it has no Off; qwen takes "none" and then does not
/// think. No Groq answer has reported `cache_read` above 0 yet, so caching is not claimed.
#[rustfmt::skip]
const BUILTIN: [Row; 13] = {
    use AiProviderKind::{DeepSeek, Groq, OpenAi};
    use CachingKind::{Automatic, None as NoCache};
    use ModelTier::{Fastest, Largest, Mid};
    use ThinkingKind::{AnthropicBudget, AnthropicEffort, None as NoThinking, ReasoningEffort};
    use ThinkingOff::{BetweenTools, Disabled, EffortNone, NotAllowed, Omit};
    const M: u32 = 1_000_000;
    const OUT: u32 = 128_000;
    [
        anthropic("claude-fable-5-1", "Claude Fable 5.1", M, OUT, AnthropicEffort, NotAllowed, false, Largest),
        anthropic("claude-opus-5-5", "Claude Opus 5.5", M, OUT, AnthropicEffort, NotAllowed, false, Mid),
        anthropic("claude-sonnet-5-5", "Claude Sonnet 5.5", M, OUT, AnthropicEffort, BetweenTools, false, Mid),
        anthropic("claude-haiku-5-5", "Claude Haiku 5.5", M, OUT, AnthropicEffort, Disabled, false, Fastest),
        anthropic("claude-haiku-4-5", "Claude Haiku 4.5", 200_000, 64_000, AnthropicBudget, Omit, true, Fastest),
        Row {
            max_output: Some(65_536),
            ..compatible(Groq, None, "openai/gpt-oss-120b", 131_072, ReasoningEffort, NotAllowed, NoCache, true, Some(Largest))
        },
        Row {
            max_output: Some(16_384),
            ..compatible(Groq, None, "qwen/qwen3.8-27b", 131_072, ReasoningEffort, EffortNone, NoCache, true, Some(Mid))
        },
        Row {
            max_output: Some(65_536),
            ..compatible(Groq, None, "openai/gpt-oss-20b", 131_072, ReasoningEffort, NotAllowed, NoCache, true, Some(Fastest))
        },
        Row {
            max_tokens_field: MaxTokensField::MaxCompletionTokens,
            ..compatible(OpenAi, Some("OpenAI"), "o4-mini", 200_000, ReasoningEffort, NotAllowed, Automatic, false, None)
        },
        compatible(OpenAi, Some("OpenAI"), "gpt-4.1", 1_047_576, NoThinking, Omit, Automatic, true, None),
        compatible(OpenAi, Some("OpenAI"), "gpt-4.1-mini", 1_047_576, NoThinking, Omit, Automatic, true, None),
        compatible(DeepSeek, None, "deepseek-chat", 64_000, NoThinking, Omit, Automatic, true, None),
        compatible(DeepSeek, None, "deepseek-reasoner", 64_000, NoThinking, Omit, Automatic, false, None),
    ]
};

/// The preset a row is looked up under: the OpenAI-compatible kind with no preset is OpenAI.
fn preset_of(kind: AiProviderKind, preset: Option<&str>) -> Option<&str> {
    match kind {
        AiProviderKind::OpenAi => Some(preset.unwrap_or("OpenAI")),
        _ => None,
    }
}

fn record(row: &Row) -> ModelInfo {
    let mut info = ModelInfo {
        id: row.id.to_string(),
        name: row.name.unwrap_or(row.id).to_string(),
        context_window: row.window,
        max_output: row.max_output,
        thinking: row.thinking,
        thinking_off: row.off,
        // DeepSeek's reasoner shares its thinking without a control for it.
        shares_thinking: row.thinking != ThinkingKind::None || row.id == "deepseek-reasoner",
        caching: row.caching,
        temperature: row.temperature,
        max_tokens_field: row.max_tokens_field,
        tier: row.tier,
        known: true,
        picks: OFF,
    };
    info.picks = clamp(&info, OFF);
    info
}

const OFF: ModelPicks = ModelPicks {
    thinking: ThinkingLevel::Off,
    caching: false,
};

/// The built-in records for a provider (and preset), in table order. Their picks are
/// the clamped Off; `info_for` fills the real ones.
pub fn builtins(kind: AiProviderKind, preset: Option<&str>) -> Vec<ModelInfo> {
    let preset = preset_of(kind, preset);
    BUILTIN
        .iter()
        .filter(|r| r.kind == kind && r.preset == preset)
        .map(record)
        .collect()
}

/// The built-in record for `id`, when the table has one for this provider.
pub fn builtin(kind: AiProviderKind, preset: Option<&str>, id: &str) -> Option<ModelInfo> {
    let preset = preset_of(kind, preset);
    BUILTIN
        .iter()
        .find(|r| r.kind == kind && r.preset == preset && r.id == id)
        .map(record)
}

/// False for ids of models that do not chat: speech, images, guards, embeddings.
pub fn is_chat_id(id: &str) -> bool {
    let id = id.to_lowercase();
    !NOT_CHAT.iter().any(|word| id.contains(word))
}

/// The record for `id`: the listing wins for the window, the name and whether the model
/// thinks; the built-in table fills the rest. A model neither knows gets the Custom
/// window (or 8,000; 200,000 for Anthropic) and no thinking or caching controls.
pub fn info_for(
    kind: AiProviderKind,
    preset: Option<&str>,
    id: &str,
    listed: Option<&ListedModel>,
    settings: &AiSettings,
) -> ModelInfo {
    let base = builtin(kind, preset, id);
    let listed_facts = listed.is_some_and(|l| l.context_window.is_some() || l.reasoning.is_some());
    let known = base.is_some() || listed_facts;
    let mut info = base.unwrap_or_else(|| ModelInfo {
        id: id.to_string(),
        name: id.to_string(),
        context_window: settings.context_window.unwrap_or(match kind {
            AiProviderKind::Anthropic => UNKNOWN_ANTHROPIC_WINDOW,
            _ => UNKNOWN_WINDOW,
        }),
        max_output: None,
        thinking: ThinkingKind::None,
        thinking_off: ThinkingOff::Omit,
        shares_thinking: false,
        caching: CachingKind::None,
        temperature: true,
        max_tokens_field: MaxTokensField::MaxTokens,
        tier: None,
        known,
        picks: OFF,
    });
    if let Some(l) = listed {
        if let Some(name) = l.name.as_deref().filter(|n| !n.trim().is_empty()) {
            info.name = name.to_string();
        }
        if let Some(window) = l.context_window.filter(|w| *w > 0) {
            info.context_window = window;
        }
        if let Some(out) = l.max_output.filter(|o| *o > 0) {
            info.max_output = Some(out);
        }
        match l.reasoning {
            Some(false) => {
                info.thinking = ThinkingKind::None;
                info.thinking_off = ThinkingOff::Omit;
                info.shares_thinking = false;
            }
            Some(true) if info.thinking == ThinkingKind::None => {
                info.thinking = match kind {
                    AiProviderKind::Anthropic => ThinkingKind::AnthropicEffort,
                    _ => ThinkingKind::ReasoningEffort,
                };
                info.thinking_off = ThinkingOff::Omit;
            }
            _ => {}
        }
        info.shares_thinking = info.thinking != ThinkingKind::None || info.shares_thinking;
    }
    info.picks = match settings.model_prefs.get(id) {
        Some(picks) => clamp(&info, *picks),
        None => default_picks(&info, settings),
    };
    info
}

/// The picks this model can honour: no thinking control means Off, a model that always
/// thinks turns Off into Low, and caching follows the model's kind.
pub fn clamp(info: &ModelInfo, wanted: ModelPicks) -> ModelPicks {
    let thinking = match (info.thinking, wanted.thinking, info.thinking_off) {
        (ThinkingKind::None, _, _) => ThinkingLevel::Off,
        (_, ThinkingLevel::Off, ThinkingOff::NotAllowed) => ThinkingLevel::Low,
        (_, level, _) => level,
    };
    let caching = match info.caching {
        CachingKind::Breakpoints => wanted.caching,
        CachingKind::Automatic => true,
        CachingKind::None => false,
    };
    ModelPicks { thinking, caching }
}

/// A model's picks before the user changes them: by tier (largest High, mid Medium,
/// fastest Off), else the settings' default; caching from the settings.
pub fn default_picks(info: &ModelInfo, settings: &AiSettings) -> ModelPicks {
    let thinking = match info.tier {
        Some(ModelTier::Largest) => ThinkingLevel::High,
        Some(ModelTier::Mid) => ThinkingLevel::Medium,
        Some(ModelTier::Fastest) => ThinkingLevel::Off,
        None => settings.default_thinking,
    };
    clamp(
        info,
        ModelPicks {
            thinking,
            caching: settings.prompt_caching,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use AiProviderKind::{Anthropic, Custom, DeepSeek, Groq, OpenAi};

    fn listed(id: &str, window: Option<u32>) -> ListedModel {
        ListedModel {
            id: id.into(),
            context_window: window,
            ..ListedModel::default()
        }
    }

    fn picks(thinking: ThinkingLevel, caching: bool) -> ModelPicks {
        ModelPicks { thinking, caching }
    }

    #[test]
    fn builtin_records() {
        use CachingKind as C;
        use ModelTier as T;
        use ThinkingKind as K;
        use ThinkingOff as O;
        type Line<'a> = (
            AiProviderKind,
            Option<&'a str>,
            &'a str,
            u32,
            K,
            O,
            C,
            bool,
            Option<T>,
        );
        #[rustfmt::skip]
        let rows: [Line; 13] = [
            (Anthropic, None, "claude-fable-5-1", 1_000_000, K::AnthropicEffort, O::NotAllowed, C::Breakpoints, false, Some(T::Largest)),
            (Anthropic, None, "claude-opus-5-5", 1_000_000, K::AnthropicEffort, O::NotAllowed, C::Breakpoints, false, Some(T::Mid)),
            (Anthropic, None, "claude-sonnet-5-5", 1_000_000, K::AnthropicEffort, O::BetweenTools, C::Breakpoints, false, Some(T::Mid)),
            (Anthropic, None, "claude-haiku-5-5", 1_000_000, K::AnthropicEffort, O::Disabled, C::Breakpoints, false, Some(T::Fastest)),
            (Anthropic, None, "claude-haiku-4-5", 200_000, K::AnthropicBudget, O::Omit, C::Breakpoints, true, Some(T::Fastest)),
            (Groq, None, "openai/gpt-oss-120b", 131_072, K::ReasoningEffort, O::NotAllowed, C::None, true, Some(T::Largest)),
            (Groq, None, "qwen/qwen3.8-27b", 131_072, K::ReasoningEffort, O::EffortNone, C::None, true, Some(T::Mid)),
            (Groq, None, "openai/gpt-oss-20b", 131_072, K::ReasoningEffort, O::NotAllowed, C::None, true, Some(T::Fastest)),
            (OpenAi, Some("OpenAI"), "o4-mini", 200_000, K::ReasoningEffort, O::NotAllowed, C::Automatic, false, None),
            (OpenAi, Some("OpenAI"), "gpt-4.1", 1_047_576, K::None, O::Omit, C::Automatic, true, None),
            (OpenAi, Some("OpenAI"), "gpt-4.1-mini", 1_047_576, K::None, O::Omit, C::Automatic, true, None),
            (DeepSeek, None, "deepseek-chat", 64_000, K::None, O::Omit, C::Automatic, true, None),
            (DeepSeek, None, "deepseek-reasoner", 64_000, K::None, O::Omit, C::Automatic, false, None),
        ];
        for (kind, preset, id, window, thinking, off, caching, temperature, tier) in rows {
            let info = builtin(kind, preset, id).unwrap_or_else(|| panic!("no row for {id}"));
            assert_eq!(info.context_window, window, "{id}");
            assert_eq!(info.thinking, thinking, "{id}");
            assert_eq!(info.thinking_off, off, "{id}");
            assert_eq!(info.caching, caching, "{id}");
            assert_eq!(info.temperature, temperature, "{id}");
            assert_eq!(info.tier, tier, "{id}");
            assert!(info.known, "{id}");
            let shares = thinking != K::None || id == "deepseek-reasoner";
            assert_eq!(info.shares_thinking, shares, "{id}");
        }
        let opus = builtin(Anthropic, None, "claude-opus-5-5").unwrap();
        assert_eq!(opus.name, "Claude Opus 5.5");
        assert_eq!(opus.max_output, Some(128_000));
        assert_eq!(
            builtin(Anthropic, None, "claude-haiku-4-5")
                .unwrap()
                .max_output,
            Some(64_000)
        );
        // Names default to the id; o4-mini takes `max_completion_tokens`.
        let o4 = builtin(OpenAi, Some("OpenAI"), "o4-mini").unwrap();
        assert_eq!(o4.name, "o4-mini");
        assert_eq!(o4.max_tokens_field, MaxTokensField::MaxCompletionTokens);
        assert_eq!(
            builtin(OpenAi, None, "gpt-4.1").unwrap().max_tokens_field,
            MaxTokensField::MaxTokens
        );
        // The OpenAI rows are the OpenAI preset's, not OpenRouter's.
        assert!(builtin(OpenAi, Some("OpenRouter"), "gpt-4.1").is_none());
        assert!(builtin(Groq, None, "claude-opus-5-5").is_none());
        // Groq output caps from the live listing.
        let max_out = |id: &str| builtin(Groq, None, id).unwrap().max_output;
        assert_eq!(max_out("openai/gpt-oss-120b"), Some(65_536));
        assert_eq!(max_out("openai/gpt-oss-20b"), Some(65_536));
        assert_eq!(max_out("qwen/qwen3.8-27b"), Some(16_384));
        assert_eq!(builtins(Anthropic, None).len(), 5);
    }

    #[test]
    fn listing_wins_for_the_window() {
        let l = listed("openai/gpt-oss-20b", Some(32_768));
        let info = info_for(
            Groq,
            None,
            "openai/gpt-oss-20b",
            Some(&l),
            &AiSettings::default(),
        );
        assert_eq!(info.context_window, 32_768);
        assert_eq!(info.thinking, ThinkingKind::ReasoningEffort);
        assert_eq!(info.caching, CachingKind::None);
        assert!(info.known);
    }

    #[test]
    fn listing_reasoning_and_name_win() {
        let l = ListedModel {
            name: Some("GPT OSS 20B".into()),
            reasoning: Some(false),
            ..listed("openai/gpt-oss-20b", None)
        };
        let info = info_for(
            Groq,
            None,
            "openai/gpt-oss-20b",
            Some(&l),
            &AiSettings::default(),
        );
        assert_eq!(info.name, "GPT OSS 20B");
        assert_eq!(info.thinking, ThinkingKind::None);
        assert!(!info.shares_thinking, "no thinking, so none to share");
        assert_eq!(info.picks.thinking, ThinkingLevel::Off);
        // A listed model the table does not know gets thinking when the listing says so.
        let l = ListedModel {
            reasoning: Some(true),
            ..listed("z-ai/glm-5", Some(200_000))
        };
        let settings = AiSettings {
            preset: Some("OpenRouter".into()),
            ..AiSettings::default()
        };
        let info = info_for(
            OpenAi,
            Some("OpenRouter"),
            "z-ai/glm-5",
            Some(&l),
            &settings,
        );
        assert!(info.known);
        assert_eq!(info.context_window, 200_000);
        assert_eq!(info.thinking, ThinkingKind::ReasoningEffort);
        assert_eq!(info.thinking_off, ThinkingOff::Omit);
        assert_eq!(info.caching, CachingKind::None);
    }

    #[test]
    fn unknown_model_gets_no_controls() {
        let settings = AiSettings {
            provider: Some(Custom),
            context_window: Some(32_000),
            ..AiSettings::default()
        };
        let info = info_for(Custom, None, "qwen2.5-coder:7b", None, &settings);
        assert!(!info.known);
        assert_eq!(info.context_window, 32_000);
        assert_eq!(info.thinking, ThinkingKind::None);
        assert_eq!(info.caching, CachingKind::None);
        assert!(info.temperature);
        assert_eq!(info.picks, picks(ThinkingLevel::Off, false));
        // A listing that only names it says nothing either.
        let bare = listed("qwen2.5-coder:7b", None);
        let info = info_for(Custom, None, "qwen2.5-coder:7b", Some(&bare), &settings);
        assert!(!info.known);
        let info = info_for(
            Custom,
            None,
            "qwen2.5-coder:7b",
            None,
            &AiSettings::default(),
        );
        assert_eq!(info.context_window, 8_000);
    }

    #[test]
    fn unknown_anthropic_model_gets_200k() {
        let info = info_for(
            Anthropic,
            None,
            "claude-next-9",
            None,
            &AiSettings::default(),
        );
        assert!(!info.known);
        assert_eq!(info.context_window, 200_000);
        let set = AiSettings {
            context_window: Some(50_000),
            ..AiSettings::default()
        };
        let info = info_for(Anthropic, None, "claude-next-9", None, &set);
        assert_eq!(info.context_window, 50_000);
    }

    #[test]
    fn unknown_openai_model_keeps_8k() {
        let info = info_for(OpenAi, None, "gpt-next-9", None, &AiSettings::default());
        assert_eq!(info.context_window, 8_000);
    }

    #[test]
    fn non_chat_ids_are_hidden() {
        for id in [
            "whisper-large-v3",
            "playai-tts",
            "canopylabs/orpheus-v1-english",
            "meta-llama/llama-prompt-guard-2-86m",
            "openai/gpt-oss-safeguard-20b",
            "text-embedding-3-small",
            "gpt-4o-realtime-preview",
        ] {
            assert!(!is_chat_id(id), "{id}");
        }
        for id in ["allam-2-7b", "openai/gpt-oss-20b", "claude-opus-5-5"] {
            assert!(is_chat_id(id), "{id}");
        }
    }

    #[test]
    fn opus_off_is_clamped_to_low() {
        let opus = builtin(Anthropic, None, "claude-opus-5-5").unwrap();
        assert_eq!(
            clamp(&opus, picks(ThinkingLevel::Off, true)),
            picks(ThinkingLevel::Low, true)
        );
        // A remembered Off for opus comes back as Low.
        let mut settings = AiSettings::default();
        settings
            .model_prefs
            .insert("claude-opus-5-5".into(), picks(ThinkingLevel::Off, false));
        let info = info_for(Anthropic, None, "claude-opus-5-5", None, &settings);
        assert_eq!(info.picks, picks(ThinkingLevel::Low, false));
        // Haiku 5.5 can switch thinking off.
        let haiku = builtin(Anthropic, None, "claude-haiku-5-5").unwrap();
        assert_eq!(
            clamp(&haiku, picks(ThinkingLevel::Off, true)).thinking,
            ThinkingLevel::Off
        );
    }

    #[test]
    fn automatic_caching_is_always_on() {
        let gpt = builtin(OpenAi, None, "gpt-4.1").unwrap();
        assert!(clamp(&gpt, picks(ThinkingLevel::Off, false)).caching);
        // Groq caching is not confirmed live: never on, whatever the pick.
        for id in [
            "openai/gpt-oss-120b",
            "qwen/qwen3.8-27b",
            "openai/gpt-oss-20b",
        ] {
            let groq = builtin(Groq, None, id).unwrap();
            assert!(
                !clamp(&groq, picks(ThinkingLevel::High, true)).caching,
                "{id}"
            );
        }
        let sonnet = builtin(Anthropic, None, "claude-sonnet-5-5").unwrap();
        assert!(!clamp(&sonnet, picks(ThinkingLevel::High, false)).caching);
        assert!(clamp(&sonnet, picks(ThinkingLevel::High, true)).caching);
    }

    #[test]
    fn defaults_by_tier() {
        let settings = AiSettings {
            default_thinking: ThinkingLevel::Low,
            ..AiSettings::default()
        };
        let level = |id: &str| {
            info_for(Anthropic, None, id, None, &settings)
                .picks
                .thinking
        };
        assert_eq!(level("claude-fable-5-1"), ThinkingLevel::High);
        assert_eq!(level("claude-opus-5-5"), ThinkingLevel::Medium);
        assert_eq!(level("claude-haiku-5-5"), ThinkingLevel::Off);
        // The fastest Groq model always thinks: its Off default is clamped to Low.
        let oss = info_for(Groq, None, "openai/gpt-oss-20b", None, &settings);
        assert_eq!(oss.picks.thinking, ThinkingLevel::Low);
        // No tier: the settings' default, when the model thinks at all.
        let o4 = info_for(OpenAi, None, "o4-mini", None, &settings);
        assert_eq!(o4.picks.thinking, ThinkingLevel::Low);
        let reasoning = ListedModel {
            reasoning: Some(true),
            ..listed("new-model", None)
        };
        let new = info_for(Custom, None, "new-model", Some(&reasoning), &settings);
        assert_eq!(new.picks.thinking, ThinkingLevel::Low);
        // Caching follows the settings for a model with breakpoints.
        let off = AiSettings {
            prompt_caching: false,
            ..AiSettings::default()
        };
        assert!(
            !info_for(Anthropic, None, "claude-opus-5-5", None, &off)
                .picks
                .caching
        );
        assert!(
            info_for(
                Anthropic,
                None,
                "claude-opus-5-5",
                None,
                &AiSettings::default()
            )
            .picks
            .caching
        );
    }

    #[test]
    fn serde_names_are_camel_case() {
        let info = builtin(Anthropic, None, "claude-haiku-4-5").unwrap();
        let v = serde_json::to_value(&info).unwrap();
        assert_eq!(v["contextWindow"], 200_000);
        assert_eq!(v["thinking"], "anthropicBudget");
        assert_eq!(v["thinkingOff"], "omit");
        assert_eq!(v["caching"], "breakpoints");
        assert_eq!(v["maxTokensField"], "maxTokens");
        assert_eq!(v["tier"], "fastest");
        assert_eq!(v["sharesThinking"], true);
        let p: ModelPicks =
            serde_json::from_value(serde_json::json!({ "thinking": "high", "caching": true }))
                .unwrap();
        assert_eq!(p, picks(ThinkingLevel::High, true));
    }
}
