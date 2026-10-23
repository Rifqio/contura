//! AI assistant settings, the provider key and the chat threads.

pub mod budget;
pub mod compact;
pub mod context;
pub mod diagram;
pub mod diagram_tool;
pub mod log;
pub mod memory;
pub mod models;
pub mod preview;
pub mod prompt;
pub mod provider;
pub mod rails;
pub mod request;
pub mod rows;
pub mod sent;
pub mod stream;
pub mod tool_uses;

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::ai::context::sync::ContextInfo;
use crate::ai::log::Log;
use crate::ai::models::{
    MaxTokensField, ModelInfo, ModelList, ModelPicks, ThinkingLevel, builtins, clamp, info_for,
    is_chat_id,
};
use crate::ai::provider::anthropic::Anthropic;
use crate::ai::provider::openai::OpenAi;
use crate::ai::provider::url::{check_base_url, host_of};
use crate::ai::provider::{AiProvider, ChatMessage, ChatRequest, ChatRole, ListedModel, Thinking};
use crate::ai::rails::Secrets;
use crate::ai::request::ItemKind;
use crate::ai::sent::{AnswerAction, AnswerActionKind, AnswerRecord, ToolOutcome};
use crate::error::{Error, Result};
use crate::model::{ConnectionConfig, ConnectionId, GroupId};
use crate::secrets::SecretStore;
use crate::store::AppStore;

const SETTINGS_KEY: &str = "ai.settings";
/// The host a saved key may be sent to, kept beside its account: `ai.keyhost.<account>`.
const KEY_HOST_KEY: &str = "ai.keyhost";
/// The OpenAI-compatible preset with its own key account and model listing.
const OPENROUTER: &str = "OpenRouter";
/// The last model listing per key account: `ai.models.<account>`.
const MODELS_KEY: &str = "ai.models";
/// The most characters of a listed model's name or id kept: a provider's text reaches the
/// picker as it is, so it is capped when stored.
pub(crate) const LISTED_TEXT_CHARS: usize = 200;
/// What "Test" asks, with room for a one-word answer.
const TEST_PROMPT: &str = "Reply with the single word ok.";
const TEST_MAX_TOKENS: u32 = 8;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AiProviderKind {
    OpenAi,
    Anthropic,
    Groq,
    DeepSeek,
    Custom,
}

impl AiProviderKind {
    /// The id used in the Credential Manager account, `AI/<id>`.
    pub fn id(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
            Self::Groq => "groq",
            Self::DeepSeek => "deepseek",
            Self::Custom => "custom",
        }
    }

    pub const ALL: [Self; 5] = [
        Self::OpenAi,
        Self::Anthropic,
        Self::Groq,
        Self::DeepSeek,
        Self::Custom,
    ];

    /// Every Credential Manager account a provider key is saved under: `AI/<provider>`
    /// and `AI/openrouter`.
    pub fn key_accounts() -> Vec<String> {
        let mut accounts: Vec<String> = Self::ALL.iter().map(|p| key_account(*p, None)).collect();
        accounts.push(key_account(Self::OpenAi, Some(OPENROUTER)));
        accounts
    }

    /// The preset's base URL, used when the settings leave it empty. Custom has none.
    pub fn default_base_url(self) -> Option<&'static str> {
        match self {
            Self::OpenAi => Some("https://api.openai.com/v1"),
            Self::Anthropic => Some("https://api.anthropic.com"),
            Self::Groq => Some("https://api.groq.com/openai/v1"),
            Self::DeepSeek => Some("https://api.deepseek.com"),
            Self::Custom => None,
        }
    }
}

/// The Credential Manager account the key for `kind` (with `preset`) is saved under:
/// `AI/openrouter` for the OpenRouter preset, else `AI/<id>`.
pub fn key_account(kind: AiProviderKind, preset: Option<&str>) -> String {
    match (kind, preset) {
        (AiProviderKind::OpenAi, Some(OPENROUTER)) => "AI/openrouter".to_string(),
        _ => format!("AI/{}", kind.id()),
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    pub provider: Option<AiProviderKind>,
    pub preset: Option<String>,
    pub base_url: String,
    pub model: String,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    /// The window of a model neither the listing nor the built-in table knows; unset
    /// means 8,000.
    #[serde(default)]
    pub context_window: Option<u32>,
    pub inline_ask: bool,
    pub error_ask: bool,
    #[serde(default)]
    pub new_connection_access: AiAccess,
    /// The host (with `:port` when not the default) the saved key was entered for; the
    /// key is only ever sent there. The binding is kept beside the key's account: here it
    /// is only shown, and a value in an older stored record is moved there on first read.
    #[serde(default)]
    pub key_host: Option<String>,
    /// The thinking level a model with no tier starts at.
    pub default_thinking: ThinkingLevel,
    /// Whether a model with cache marks starts with them on.
    pub prompt_caching: bool,
    pub share_thinking: bool,
    /// "Keep the exact text sent with each answer" (R7.2).
    pub keep_exact_text: bool,
    /// "Pick tables": a large database's outline may go to the model to pick the tables.
    /// Stored settings without it read on. A Privacy switch: always the global value.
    pub pick_tables: bool,
    /// "Compact long threads on their own". Stored settings without it read on. A
    /// Privacy switch: always the global value.
    #[serde(default = "yes")]
    pub auto_compact: bool,
    /// "Propose diagram changes": a diagram Ask offers its one tool. Stored settings
    /// without it read on. Global like the Privacy switches: a Group override never
    /// changes it.
    #[serde(default = "yes")]
    pub diagram_tool: bool,
    /// The picks remembered per model id, already clamped.
    pub model_prefs: BTreeMap<String, ModelPicks>,
}

impl AiSettings {
    /// The base URL Asks go to: the saved one, or the preset's when it is left empty.
    pub fn effective_base_url(&self) -> Option<&str> {
        match self.base_url.trim() {
            "" => self.provider.and_then(AiProviderKind::default_base_url),
            base => Some(base),
        }
    }

    /// The account this record's key is saved under, once a provider is chosen.
    pub fn key_account(&self) -> Option<String> {
        Some(key_account(self.provider?, self.preset.as_deref()))
    }
}

fn yes() -> bool {
    true
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            provider: None,
            preset: None,
            base_url: String::new(),
            model: String::new(),
            temperature: None,
            max_tokens: None,
            context_window: None,
            inline_ask: true,
            error_ask: true,
            new_connection_access: AiAccess::default(),
            key_host: None,
            default_thinking: ThinkingLevel::Medium,
            prompt_caching: true,
            share_thinking: true,
            keep_exact_text: false,
            pick_tables: true,
            auto_compact: true,
            diagram_tool: true,
            model_prefs: BTreeMap::new(),
        }
    }
}

/// How much of a Connection the assistant may see.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiAccess {
    Never,
    #[default]
    Schema,
    SchemaQuery,
    SchemaQueryRows,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsView {
    pub settings: AiSettings,
    pub group_override: bool,
    pub key_saved: bool,
    pub key_last4: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum KeyChange {
    Keep,
    Set { value: String },
    Clear,
}

/// Read back from a stored answer record as well as sent to the WebView.
#[derive(thiserror::Error, Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AiError {
    #[error("no AI provider is set up")]
    NotConfigured,
    #[error("the provider rejected the key")]
    BadKey,
    #[error("the provider is rate limiting requests")]
    RateLimited { retry_after_secs: Option<u32> },
    #[error("could not reach {host}")]
    Network {
        host: String,
        /// True when the request never reached the host: a connection refused or reset
        /// before it was written. False once it may have been read.
        #[serde(default)]
        connect: bool,
    },
    #[error("the base URL now points to {host}; save the key again to send it there")]
    KeyHostChanged { host: String },
    #[error(
        "use https for {host}; plain http is allowed only on this computer or a private network"
    )]
    InsecureUrl { host: String },
    /// `phase` names the wait that ran out (connect, first byte, between chunks).
    #[error("the provider did not answer in time")]
    Timeout { phase: String },
    #[error("stopped")]
    Cancelled,
    /// `message` is the provider's short message, already cleaned and capped; never the body.
    #[error("the provider returned an error ({status}): {message}")]
    Provider { status: u16, message: String },
    #[error("the provider's answer could not be read")]
    BadResponse,
    #[error("the request is over the size this model accepts, even after trimming")]
    TooLarge,
    /// Not a failure: the Ask goes on with the context built at `built_at` (epoch milliseconds).
    #[error("could not check the schema; using the saved context")]
    ContextUnavailable { built_at: i64 },
    #[error("{} is busy right now", provider.id())]
    Overloaded { provider: AiProviderKind },
    #[error("remove the user name and password from the base URL for {host}")]
    UrlHasCredentials { host: String },
    #[error("no internet connection")]
    Offline,
    #[error("the {} account is out of credit", provider.id())]
    OutOfCredit { provider: AiProviderKind },
    /// From a 404 whose structured fields say the model is gone.
    #[error("{model} is no longer offered")]
    ModelRetired { model: String },
    /// With auto-compact off, an Ask at 85% of the window or more is not sent. `messages`
    /// are the open Topic's messages Compact now would fold (all but the last 2 turns).
    #[error("the thread fills {used} of {model}'s {window} token window")]
    ContextFull {
        used: u32,
        window: u32,
        model: String,
        messages: u32,
    },
    #[error("the question needs {needed} tokens; {model} holds {window}")]
    TooBig {
        needed: u32,
        window: u32,
        model: String,
    },
    /// The TLS handshake with `host` failed: a certificate the OS does not trust, or a
    /// proxy inspecting TLS. Never retried.
    #[error("could not set up a secure connection to {host}")]
    Tls { host: String },
    /// Another Ask in the same place is still running.
    #[error("An answer is still being written. Stop it first.")]
    Busy,
    /// A Continue with no cut answer to follow in what the Ask would send: no thread, a
    /// Topic that broke, a gate or a share that left the answer out, or the Thread row off.
    #[error("Nothing to continue.")]
    NothingToContinue,
    /// Contura itself failed (reading its own store) before anything was sent. Plain text
    /// only: the underlying message can name paths.
    #[error("something went wrong before the question was sent")]
    Internal,
    /// The .flow file on disk is not the text the model was shown: changed outside
    /// Contura while it worked, or gone. `line` is the first line (1-based) that differs
    /// and `now_reads` its new text, cut to 120 characters; both `None` when the file is
    /// gone.
    #[error("{file} changed while I worked")]
    FileChanged {
        file: String,
        line: Option<u32>,
        now_reads: Option<String>,
    },
    /// The model called a tool this Ask does not offer. `name` is stripped of invisible
    /// characters and cut to 64 characters.
    #[error("the assistant asked for a tool it cannot use")]
    ToolRejected { name: String },
    /// The tool input was empty, over 64 KB, or not a proposal.
    #[error("the proposed changes could not be read")]
    BadToolInput,
    /// "Propose diagram changes" is off in Settings: no diagram Ask is built.
    #[error("the diagram assistant is off in Settings")]
    ToolOff,
    /// The diagram's file name holds a control character: nothing is built or sent.
    #[error("the diagram's file name holds a control character")]
    BadFileName,
}

/// The most `FileChanged.now_reads` keeps, in characters.
pub const NOW_READS_CHARS: usize = 120;

impl AiError {
    /// `FileChanged` with `now_reads` cut to 120 characters.
    pub fn file_changed(file: &str, line: Option<u32>, now_reads: Option<&str>) -> AiError {
        AiError::FileChanged {
            file: file.to_string(),
            line,
            now_reads: now_reads.map(|t| t.chars().take(NOW_READS_CHARS).collect()),
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiTestOk {
    pub model: String,
    pub millis: u64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiRole {
    User,
    Assistant,
    Notice,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    pub role: AiRole,
    pub text: String,
    /// The "Sends" pills that went with a question.
    #[serde(default)]
    pub context: Vec<String>,
    /// Epoch milliseconds.
    pub at: i64,
    /// What an assistant answer sent and did: kept in the thread JSON with the message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record: Option<AnswerRecord>,
    /// The Topic of the turn; both messages of a turn carry the same stamp. Messages
    /// saved before 11e have none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<ConnectionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    /// The kinds of item the turn carried.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub kinds: Vec<ItemKind>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tables: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
}

pub type ThreadId = uuid::Uuid;

/// One chat thread, kept per place (`ungrouped` or `group:<id>`, as the drafts' place key).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiThread {
    pub id: ThreadId,
    pub place: String,
    pub title: String,
    pub messages: Vec<AiMessage>,
    /// Epoch milliseconds; orders the list.
    pub updated_at: i64,
}

/// One running Ask: its place and the handle that stops it.
struct Running {
    place: String,
    handle: tokio::task::AbortHandle,
}

/// Settings in the app store, the key in the credential store, and the running Asks.
pub struct AiService {
    store: Mutex<AppStore>,
    secrets: Arc<dyn SecretStore>,
    /// By request id.
    running: Mutex<HashMap<String, Running>>,
    /// The AI Context each recent Ask used, by request id, newest last, until its answer
    /// is saved.
    asked: Mutex<VecDeque<(String, ContextInfo)>>,
    /// Held across each read-modify-write of a settings record, so a Settings save and a
    /// model pick never undo each other.
    writing: Mutex<()>,
}

/// How many Asks' AI Contexts are kept for the save of their answer.
const ASKED_KEPT: usize = 32;

fn group_key(group: GroupId) -> String {
    format!("{SETTINGS_KEY}.{group}")
}

/// A listed name with invisible characters removed, other control characters made
/// spaces, trimmed and cut to `LISTED_TEXT_CHARS`; `None` when nothing is left.
fn clean_listed_name(name: &str) -> Option<String> {
    let (visible, _) = crate::ai::rails::input::strip_invisible(name);
    let spaced: String = visible
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let cut: String = spaced.trim().chars().take(LISTED_TEXT_CHARS).collect();
    (!cut.is_empty()).then_some(cut)
}

/// `models` with an over-long id dropped (a cut id would name another model) and each name
/// cleaned of invisible and control characters and cut.
fn clean_listing(models: Vec<ListedModel>) -> Vec<ListedModel> {
    models
        .into_iter()
        .filter(|m| m.id.chars().count() <= LISTED_TEXT_CHARS)
        .map(|mut m| {
            m.name = m.name.and_then(|n| clean_listed_name(&n));
            m
        })
        .collect()
}

/// Where the listing for `settings`' provider is kept: per key account, so OpenRouter has
/// its own entry.
fn models_key(settings: &AiSettings) -> Option<String> {
    Some(format!("{MODELS_KEY}.{}", settings.key_account()?))
}

/// The host `settings`' listing comes from.
fn listing_host(settings: &AiSettings) -> Option<String> {
    settings.effective_base_url().and_then(url_host)
}

fn key_host_key(account: &str) -> String {
    format!("{KEY_HOST_KEY}.{account}")
}

/// The filtered `/models` listing as stored, so the model list works offline.
#[derive(Serialize, Deserialize)]
struct StoredListing {
    /// Epoch milliseconds.
    at: i64,
    /// The host it was fetched from; a listing from another host is not this one's. Absent
    /// in a listing stored before hosts were kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    host: Option<String>,
    models: Vec<ListedModel>,
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// The host of `raw` (with `:port` when not the default), when it parses as a URL with one.
fn url_host(raw: &str) -> Option<String> {
    url::Url::parse(raw.trim())
        .ok()
        .filter(|u| u.host_str().is_some())
        .map(|u| host_of(&u))
}

fn parse(raw: &str) -> Result<AiSettings> {
    serde_json::from_str(raw).map_err(|e| Error::Store(e.to_string()))
}

/// `settings` as read from `record`. A `key_host` left in the record from before bindings
/// were kept beside the key's account is moved there (unless the account already has one)
/// and taken out of the stored record.
fn moved_key_host(store: &AppStore, record: &str, mut settings: AiSettings) -> Result<AiSettings> {
    let Some(host) = settings.key_host.take() else {
        return Ok(settings);
    };
    // Under the account the key lived in when the host was recorded: before OpenRouter had
    // its own account, every OpenAI-compatible key was saved under `AI/openai`.
    if let Some(kind) = settings.provider {
        let binding = key_host_key(&key_account(kind, None));
        if store.get_setting(&binding)?.is_none() {
            store.set_setting(&binding, &host)?;
        }
    }
    let json = serde_json::to_string(&settings).map_err(|e| Error::Store(e.to_string()))?;
    store.set_setting(record, &json)?;
    Ok(settings)
}

impl AiService {
    pub fn new(store: AppStore, secrets: Arc<dyn SecretStore>) -> Self {
        // The spec's 1 MB page cache for the AI connection; on failure SQLite's default stays.
        store.set_cache_kib(1024).ok();
        Self {
            store: Mutex::new(store),
            secrets,
            running: Mutex::new(HashMap::new()),
            asked: Mutex::new(VecDeque::new()),
            writing: Mutex::new(()),
        }
    }

    fn writing(&self) -> MutexGuard<'_, ()> {
        self.writing.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn store(&self) -> Result<MutexGuard<'_, AppStore>> {
        self.store
            .lock()
            .map_err(|_| Error::Store("lock poisoned".into()))
    }

    /// The Group's override when it has one, else the global settings. The Privacy
    /// switches (Keep the exact text, Share thinking, Pick tables) always come from the
    /// global settings.
    /// `key_host` is always `None` here: the binding lives beside the key's account.
    fn effective(&self, group: Option<GroupId>) -> Result<(AiSettings, bool)> {
        let store = self.store()?;
        let global = match store.get_setting(SETTINGS_KEY)? {
            Some(raw) => moved_key_host(&store, SETTINGS_KEY, parse(&raw)?)?,
            None => AiSettings::default(),
        };
        if let Some(g) = group
            && let Some(raw) = store.get_setting(&group_key(g))?
        {
            let mut own = moved_key_host(&store, &group_key(g), parse(&raw)?)?;
            own.keep_exact_text = global.keep_exact_text;
            own.share_thinking = global.share_thinking;
            own.pick_tables = global.pick_tables;
            own.auto_compact = global.auto_compact;
            own.diagram_tool = global.diagram_tool;
            return Ok((own, true));
        }
        Ok((global, false))
    }

    /// The host the key saved under `account` may be sent to.
    fn key_host(&self, account: &str) -> Result<Option<String>> {
        self.store()?.get_setting(&key_host_key(account))
    }

    /// Binds the key saved under `account` to `host`, or removes the binding.
    fn set_key_host(&self, account: &str, host: Option<&str>) -> Result<()> {
        let store = self.store()?;
        match host {
            Some(host) => store.set_setting(&key_host_key(account), host),
            None => store.delete_setting(&key_host_key(account)),
        }
    }

    fn key_saved(&self, account: &str) -> Result<bool> {
        Ok(self
            .secrets
            .get_named(account)?
            .is_some_and(|k| !k.is_empty()))
    }

    pub fn settings(&self, group: Option<GroupId>) -> Result<AiSettingsView> {
        let (mut settings, group_override) = self.effective(group)?;
        let account = settings.key_account();
        let key = match &account {
            Some(account) => self.secrets.get_named(account)?,
            None => None,
        };
        settings.key_host = match &account {
            Some(account) => self.key_host(account)?,
            None => None,
        };
        let key_last4 = key.map(|k| {
            let chars: Vec<char> = k.chars().collect();
            chars[chars.len().saturating_sub(4)..].iter().collect()
        });
        Ok(AiSettingsView {
            settings,
            group_override,
            key_saved: key_last4.is_some(),
            key_last4,
        })
    }

    /// With a Group and `override_group`, the settings are that Group's own.
    /// Otherwise they are the global ones and any Group override is removed.
    pub fn save_settings(
        &self,
        group: Option<GroupId>,
        mut settings: AiSettings,
        override_group: bool,
        key: KeyChange,
    ) -> Result<()> {
        // A user name or password in the base URL would be stored in plain text.
        if let Ok(url) = url::Url::parse(settings.base_url.trim())
            && (!url.username().is_empty() || url.password().is_some())
        {
            return Err(Error::Ai(AiError::UrlHasCredentials {
                host: url.host_str().unwrap_or_default().to_string(),
            }));
        }
        let _writing = self.writing();
        let binding = self.key_host_after(group, override_group, &settings, &key)?;
        settings.key_host = None;
        match (&key, settings.provider) {
            (KeyChange::Set { value }, _) if value.trim().is_empty() => {
                return Err(Error::InvalidInput("the key must not be empty".into()));
            }
            (KeyChange::Set { .. }, None) => {
                return Err(Error::InvalidInput("choose a provider first".into()));
            }
            _ => {}
        }
        {
            let store = self.store()?;
            let record = match group {
                Some(g) if override_group => group_key(g),
                _ => SETTINGS_KEY.to_string(),
            };
            // The model picker writes the picks: a pick made since these settings were
            // read is kept.
            if let Some(raw) = store.get_setting(&record)?
                && let Ok(stored) = parse(&raw)
            {
                settings.model_prefs.extend(stored.model_prefs);
            }
            // The Privacy switches are global: a Group's record keeps the global values.
            if record != SETTINGS_KEY {
                let global = match store.get_setting(SETTINGS_KEY)? {
                    Some(raw) => parse(&raw)?,
                    None => AiSettings::default(),
                };
                settings.keep_exact_text = global.keep_exact_text;
                settings.share_thinking = global.share_thinking;
                settings.pick_tables = global.pick_tables;
                settings.auto_compact = global.auto_compact;
                settings.diagram_tool = global.diagram_tool;
            }
            let json = serde_json::to_string(&settings).map_err(|e| Error::Store(e.to_string()))?;
            if let Some(g) = group.filter(|_| !override_group) {
                store.delete_setting(&group_key(g))?;
            }
            store.set_setting(&record, &json)?;
        }
        if let Some(account) = settings.key_account() {
            match key {
                KeyChange::Keep => {}
                KeyChange::Set { value } => self.secrets.set_named(&account, value.trim())?,
                KeyChange::Clear => self.secrets.delete_named(&account)?,
            }
            if let Some(host) = binding {
                self.set_key_host(&account, host.as_deref())?;
            }
        }
        Ok(())
    }

    /// The change to the key's host binding once `key` is applied: `None` leaves it, and
    /// `Some(host)` sets it (`Some(None)` removes it). Never taken from the caller: a new
    /// key binds the base URL's host, a kept key keeps the host it is bound to. A saved key
    /// not bound yet binds to the host it would have gone to until now when this save moves
    /// the base URL to another host, so the new host is refused until the key is saved
    /// again or the new host is confirmed.
    fn key_host_after(
        &self,
        group: Option<GroupId>,
        override_group: bool,
        settings: &AiSettings,
        key: &KeyChange,
    ) -> Result<Option<Option<String>>> {
        let Some(account) = settings.key_account() else {
            return Ok(None);
        };
        Ok(match key {
            KeyChange::Set { .. } => Some(url_host(&settings.base_url)),
            KeyChange::Clear => Some(None),
            KeyChange::Keep => {
                // Read first: it moves a legacy binding beside its account.
                let (previous, _) = self.effective(group.filter(|_| override_group))?;
                if self.key_host(&account)?.is_some() {
                    return Ok(None);
                }
                // The previous record's key may be this one: its own account, or the
                // account its key lived in before OpenRouter had its own (`AI/openai`).
                let same_key = previous.key_account().as_ref() == Some(&account)
                    || previous.provider.map(|k| key_account(k, None)).as_ref() == Some(&account);
                if !same_key || !self.key_saved(&account)? {
                    return Ok(None);
                }
                let old = previous.effective_base_url().and_then(url_host);
                let new = settings.effective_base_url().and_then(url_host);
                old.filter(|old| Some(old) != new.as_ref()).map(Some)
            }
        })
    }

    /// Writes `settings` where they were read from: the Group's override or the global ones.
    fn write(&self, group: Option<GroupId>, settings: &AiSettings) -> Result<()> {
        let json = serde_json::to_string(settings).map_err(|e| Error::Store(e.to_string()))?;
        let store = self.store()?;
        match group {
            Some(g) => store.set_setting(&group_key(g), &json),
            None => store.set_setting(SETTINGS_KEY, &json),
        }
    }

    /// The provider for `group`'s settings, those settings and the model to ask, from one
    /// read. The key is used only once the base URL passed the URL policy and its host is
    /// the one the key is bound to; a key saved before hosts were recorded is bound to this
    /// host on its first use. A Custom server with no saved key gets no key, so a binding
    /// left from an earlier key never refuses it. Reads the credential store, so commands
    /// call it off the async runtime.
    pub fn provider_for(
        &self,
        group: Option<GroupId>,
    ) -> Result<(Box<dyn AiProvider>, AiSettings, String)> {
        let not_configured = || Error::Ai(AiError::NotConfigured);
        let (settings, _) = self.effective(group)?;
        let kind = settings.provider.ok_or_else(not_configured)?;
        let account = key_account(kind, settings.preset.as_deref());
        let model = settings.model.trim().to_string();
        if model.is_empty() {
            return Err(not_configured());
        }
        let base = settings.effective_base_url().ok_or_else(not_configured)?;
        let url = check_base_url(base).map_err(Error::Ai)?;
        let host = host_of(&url);
        let bound = self.key_host(&account)?;
        let moved = bound.as_ref().is_some_and(|bound| *bound != host);
        if moved && kind != AiProviderKind::Custom {
            return Err(Error::Ai(AiError::KeyHostChanged { host }));
        }
        let key = self.secrets.get_named(&account)?.filter(|k| !k.is_empty());
        match &key {
            None if kind != AiProviderKind::Custom => return Err(not_configured()),
            Some(_) if moved => return Err(Error::Ai(AiError::KeyHostChanged { host })),
            Some(_) if bound.is_none() => self.set_key_host(&account, Some(&host))?,
            _ => {}
        }
        let redact = self.secrets_for_redaction(&[])?.keys;
        let provider: Box<dyn AiProvider> = match kind {
            AiProviderKind::Anthropic => {
                Box::new(Anthropic::new(url, key.unwrap_or_default(), redact)?)
            }
            _ => Box::new(OpenAi::new(url, key, kind, redact)?),
        };
        Ok((provider, settings, model))
    }

    /// Binds the saved key to `host`, the one the user was asked about: the answer to
    /// "Send the saved key to <host>?" after `KeyHostChanged`. Refused with
    /// `KeyHostChanged` naming the current host when `group`'s settings no longer send to
    /// `host`. Nothing changes when no key is saved.
    pub fn confirm_key_host(&self, group: Option<GroupId>, host: &str) -> Result<()> {
        let not_configured = || Error::Ai(AiError::NotConfigured);
        let (settings, _) = self.effective(group)?;
        let account = settings.key_account().ok_or_else(not_configured)?;
        let base = settings.effective_base_url().ok_or_else(not_configured)?;
        let current = host_of(&check_base_url(base).map_err(Error::Ai)?);
        // The settings moved again since the question was asked: ask about the new host.
        if current != host {
            return Err(Error::Ai(AiError::KeyHostChanged { host: current }));
        }
        if self.key_saved(&account)? {
            self.set_key_host(&account, Some(&current))?;
        }
        Ok(())
    }

    /// Fetches the provider's models, keeps the chat models as the stored listing and
    /// returns the model list built from it.
    pub async fn models(&self, group: Option<GroupId>) -> Result<ModelList> {
        let (provider, settings, _) = self.provider_for(group)?;
        let listed = provider.models(&mut Log::new()).await?;
        self.store_listing(&settings, listed)
    }

    /// Keeps the chat models of a fresh listing for `settings`' provider and returns the
    /// model list built from it. `ai_models` fetches off the runtime's blocking reads and
    /// calls this.
    pub fn store_listing(
        &self,
        settings: &AiSettings,
        listed: Vec<ListedModel>,
    ) -> Result<ModelList> {
        let models: Vec<ListedModel> = clean_listing(listed)
            .into_iter()
            .filter(|m| m.chat != Some(false) && is_chat_id(&m.id))
            .collect();
        // A reply with no chat models keeps the listing stored before it.
        if models.is_empty() {
            let stored = self.stored_listing(settings)?;
            return Ok(model_list(settings, stored.as_ref()));
        }
        let stored = StoredListing {
            at: now_ms(),
            host: listing_host(settings),
            models,
        };
        if let Some(key) = models_key(settings) {
            let json = serde_json::to_string(&stored).map_err(|e| Error::Store(e.to_string()))?;
            self.store()?.set_setting(&key, &json)?;
        }
        Ok(model_list(settings, Some(&stored)))
    }

    /// The model list with no network: the built-in records and the stored listing. The
    /// current model is always in it.
    pub fn known_models(&self, group: Option<GroupId>) -> Result<ModelList> {
        let (settings, _) = self.effective(group)?;
        let stored = self.stored_listing(&settings)?;
        Ok(model_list(&settings, stored.as_ref()))
    }

    /// The capability record of `model` for `group`'s provider, with its picks.
    pub fn model_info(&self, group: Option<GroupId>, model: &str) -> Result<ModelInfo> {
        let (settings, _) = self.effective(group)?;
        let stored = self.stored_listing(&settings)?;
        Ok(info_in(&settings, stored.as_ref(), model.trim()))
    }

    /// The capability record of `model` under `settings` already read, with its picks: an
    /// Ask builds the record from the same read as its provider.
    pub fn model_info_in(&self, settings: &AiSettings, model: &str) -> Result<ModelInfo> {
        let stored = self.stored_listing(settings)?;
        Ok(info_in(settings, stored.as_ref(), model.trim()))
    }

    /// Keeps what the user did with the SQL of the answer at `message_at` in `thread`.
    /// `None` for an answer saved before records were kept.
    pub fn record_action(
        &self,
        thread: ThreadId,
        message_at: i64,
        kind: AnswerActionKind,
    ) -> Result<Option<AnswerAction>> {
        let store = self.store()?;
        let mut t = store
            .get_ai_thread(thread)?
            .ok_or_else(|| Error::InvalidInput("the chat is gone".into()))?;
        let message = t
            .messages
            .iter_mut()
            .find(|m| m.role == AiRole::Assistant && m.at == message_at)
            .ok_or_else(|| Error::InvalidInput("the answer is gone".into()))?;
        let Some(mut record) = message.record.take() else {
            return Ok(None);
        };
        let action = AnswerAction { kind, at: now_ms() };
        record.actions.push(action);
        message.record = Some(record.capped());
        store.save_ai_thread(&t)?;
        Ok(Some(action))
    }

    /// Keeps what the user did with the changes a diagram answer proposed: the changes
    /// landed and rejected. A second call replaces the outcome. `None` when the answer has
    /// no tool call (a database answer, or one kept before 11h).
    pub fn record_tool_result(
        &self,
        thread: ThreadId,
        message_at: i64,
        outcome: ToolOutcome,
    ) -> Result<Option<ToolOutcome>> {
        let store = self.store()?;
        let mut t = store
            .get_ai_thread(thread)?
            .ok_or_else(|| Error::InvalidInput("the chat is gone".into()))?;
        let message = t
            .messages
            .iter_mut()
            .find(|m| m.role == AiRole::Assistant && m.at == message_at)
            .ok_or_else(|| Error::InvalidInput("the answer is gone".into()))?;
        let Some(tool_use) = message.record.as_mut().and_then(|r| r.tool_use.as_mut()) else {
            return Ok(None);
        };
        tool_use.outcome = Some(outcome);
        store.save_ai_thread(&t)?;
        Ok(Some(outcome))
    }

    /// The newest `limit` tool uses (diagram proposals and table picks), newest first.
    pub fn recent_tool_uses(&self, limit: usize) -> Result<Vec<tool_uses::ToolUseRow>> {
        tool_uses::recent(self.store()?.conn(), limit)
    }

    /// Remembers `picks` for `model`, clamped to what it accepts, and makes it the current
    /// model, in the record the settings were read from (the Group's override or the
    /// global settings).
    pub fn set_model_prefs(
        &self,
        group: Option<GroupId>,
        model: &str,
        picks: ModelPicks,
    ) -> Result<()> {
        let model = model.trim();
        if model.is_empty() {
            return Err(Error::InvalidInput("choose a model".into()));
        }
        let _writing = self.writing();
        let (mut settings, group_override) = self.effective(group)?;
        let stored = self.stored_listing(&settings)?;
        let info = info_in(&settings, stored.as_ref(), model);
        settings
            .model_prefs
            .insert(model.to_string(), clamp(&info, picks));
        settings.model = model.to_string();
        self.write(group.filter(|_| group_override), &settings)
    }

    /// The listing last stored for `settings`' provider. One that no longer parses is
    /// treated as never fetched.
    fn stored_listing(&self, settings: &AiSettings) -> Result<Option<StoredListing>> {
        let Some(key) = models_key(settings) else {
            return Ok(None);
        };
        let raw = self.store()?.get_setting(&key)?;
        let stored: Option<StoredListing> = raw.and_then(|raw| serde_json::from_str(&raw).ok());
        // A listing stored before names were cleaned is cleaned on the way out too.
        let stored = stored.map(|mut s| {
            s.models = clean_listing(s.models);
            s
        });
        Ok(stored.filter(|s| s.host.is_none() || s.host == listing_host(settings)))
    }

    fn running(&self) -> MutexGuard<'_, HashMap<String, Running>> {
        self.running.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Registers a started Ask. One Ask runs per place, and a request id names one Ask: a
    /// second in the same place, or with the id of one still running, is refused with
    /// `Busy` while the first has not finished.
    pub fn start(
        &self,
        place: &str,
        request_id: &str,
        handle: tokio::task::AbortHandle,
    ) -> Result<()> {
        let mut running = self.running();
        let same_id = running
            .get(request_id)
            .is_some_and(|r| !r.handle.is_finished());
        if same_id
            || running
                .values()
                .any(|r| r.place == place && !r.handle.is_finished())
        {
            return Err(Error::Ai(AiError::Busy));
        }
        running.retain(|_, r| !r.handle.is_finished());
        running.insert(
            request_id.to_string(),
            Running {
                place: place.to_string(),
                handle,
            },
        );
        Ok(())
    }

    /// Runs `work` as its own task registered like an Ask (Compact now): refused with `Busy`
    /// while an Ask or another run is going in `place` or under `request_id`, stopped by
    /// `cancel(request_id)` (then `Cancelled`). The work starts only once it is registered.
    pub async fn run_registered<T, F>(&self, place: &str, request_id: &str, work: F) -> Result<T>
    where
        T: Send + 'static,
        F: std::future::Future<Output = Result<T>> + Send + 'static,
    {
        let (go, registered) = tokio::sync::oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            if registered.await.is_err() {
                return Err(Error::Cancelled);
            }
            work.await
        });
        if let Err(e) = self.start(place, request_id, task.abort_handle()) {
            task.abort();
            return Err(e);
        }
        let _ = go.send(());
        let out = task.await;
        self.finish(request_id);
        match out {
            Ok(result) => result,
            Err(_) => Err(Error::Cancelled),
        }
    }

    /// Called by the Ask's task when it ends, however it ends.
    pub fn finish(&self, request_id: &str) {
        self.running().remove(request_id);
    }

    /// Stops a running Ask: its task is aborted at its next wait, which drops the
    /// connection, and a retry waiting in back-off is never sent. False when none runs.
    pub fn cancel(&self, request_id: &str) -> bool {
        match self.running().remove(request_id) {
            Some(r) => {
                r.handle.abort();
                true
            }
            None => false,
        }
    }

    /// Stops every running Ask and Compact now of `place`, as `cancel` does for one. False
    /// when none runs there.
    pub fn cancel_place(&self, place: &str) -> bool {
        let mut running = self.running();
        let ids: Vec<String> = running
            .iter()
            .filter(|(_, r)| r.place == place)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            if let Some(r) = running.remove(id) {
                r.handle.abort();
            }
        }
        !ids.is_empty()
    }

    /// Text matched exactly and redacted before anything goes out (R2.1): every saved
    /// provider key (a Group may use another provider) and the saved password of each
    /// of `connections`.
    pub fn secrets_for_redaction(&self, connections: &[ConnectionConfig]) -> Result<Secrets> {
        redaction_secrets(&*self.secrets, connections)
    }

    /// The place's threads as summaries, newest first, at most 50.
    pub fn list_threads(&self, place: &str) -> Result<Vec<memory::ThreadSummary>> {
        memory::store::list_summaries(self.store()?.conn(), place, crate::store::THREAD_LIMIT)
    }

    /// As `list_threads`, after registering the SQL of every stored thread of the place
    /// with `connections` (R6.3): the register is memory only, and a stored answer can
    /// still be inserted and run, opened or not.
    pub fn list_threads_registering(
        &self,
        place: &str,
        connections: &crate::connections::ConnectionService,
    ) -> Result<Vec<memory::ThreadSummary>> {
        // Only the statements are read: a thread's logs, thinking and exact text are not
        // built for this (memory).
        let statements = self.store()?.ai_thread_statements(place)?;
        connections.register_ai_sql(&statements);
        self.list_threads(place)
    }

    /// The thread with its Topics and compactions, every record trimmed.
    pub fn thread_view(&self, id: ThreadId) -> Result<Option<memory::ThreadView>> {
        let store = self.store()?;
        let conn = store.conn();
        let Some(mut thread) = memory::store::thread(conn, id)? else {
            return Ok(None);
        };
        for m in &mut thread.messages {
            m.record = m.record.as_ref().map(AnswerRecord::trimmed_copy);
        }
        let topics = memory::store::topics(conn, id)?;
        let mut compactions = memory::store::compactions(conn, id)?;
        for c in &mut compactions {
            c.record = c.record.trimmed_copy();
        }
        Ok(Some(memory::ThreadView {
            thread,
            topics,
            compactions,
        }))
    }

    /// The full stored record of the answer at `message_at`.
    pub fn answer_record(&self, thread: ThreadId, message_at: i64) -> Result<Option<AnswerRecord>> {
        Ok(self.store()?.get_ai_thread(thread)?.and_then(|t| {
            t.messages
                .into_iter()
                .find(|m| m.role == AiRole::Assistant && m.at == message_at)
                .and_then(|m| m.record)
        }))
    }

    /// The Topics of the place's threads that hold a word of `text`, best 20.
    pub fn search_threads(&self, place: &str, text: &str) -> Result<Vec<memory::ThreadHit>> {
        let terms = context::retrieve::question_terms(text);
        memory::store::search_place(self.store()?.conn(), place, &terms, 20)
    }

    /// Keeps the AI Context the Ask `request_id` used (its `Context` event), for the save
    /// of its answer to write into the record.
    pub fn remember_context(&self, request_id: &str, info: ContextInfo) {
        let mut asked = self.asked.lock().unwrap_or_else(|e| e.into_inner());
        asked.retain(|(id, _)| id != request_id);
        asked.push_back((request_id.to_string(), info));
        while asked.len() > ASKED_KEPT {
            asked.pop_front();
        }
    }

    /// As `save_thread`, for the save that adds the answer to the Ask `request_id`: the
    /// Core writes the AI Context that Ask used into the last answer's record.
    pub fn save_thread_for(
        &self,
        thread: &AiThread,
        request_id: Option<&str>,
    ) -> Result<memory::ThreadView> {
        let used = request_id.and_then(|id| {
            let mut asked = self.asked.lock().unwrap_or_else(|e| e.into_inner());
            let at = asked.iter().position(|(r, _)| r == id)?;
            asked.remove(at).map(|(_, info)| info)
        });
        let Some(info) = used else {
            return self.save_thread(thread);
        };
        let mut thread = thread.clone();
        if let Some(record) = thread
            .messages
            .iter_mut()
            .rev()
            .find(|m| m.role == AiRole::Assistant)
            .and_then(|m| m.record.as_mut())
        {
            record.context = Some(info);
        }
        self.save_thread(&thread)
    }

    /// Appends one Ask's turn to the stored thread (made from `turn` when there is none),
    /// in one read and one write: the thread never crosses IPC, and the reply holds only
    /// the new messages. A `replace_from` drops the stored messages from that time on
    /// first (a Retry). Each record is held to its caps; with `request_id`, the Core
    /// writes the AI Context that Ask used into the answer's record, as `save_thread_for`.
    /// The same `MESSAGE_LIMIT` and syncs as a save apply.
    pub fn append_turn(
        &self,
        turn: memory::AppendTurn,
        request_id: Option<&str>,
    ) -> Result<memory::TurnView> {
        let used = request_id.and_then(|id| {
            let mut asked = self.asked.lock().unwrap_or_else(|e| e.into_inner());
            let at = asked.iter().position(|(r, _)| r == id)?;
            asked.remove(at).map(|(_, info)| info)
        });
        let mut add = turn.messages;
        if let Some(info) = used
            && let Some(record) = add
                .iter_mut()
                .rev()
                .find(|m| m.role == AiRole::Assistant)
                .and_then(|m| m.record.as_mut())
        {
            record.context = Some(info);
        }
        for m in &mut add {
            m.record = m.record.take().map(AnswerRecord::capped);
        }
        let added = add.len();
        let store = self.store()?;
        let mut thread = store
            .get_ai_thread(turn.thread_id)?
            .unwrap_or_else(|| AiThread {
                id: turn.thread_id,
                place: turn.place,
                title: turn.title,
                messages: Vec::new(),
                updated_at: turn.updated_at,
            });
        if let Some(from) = turn.replace_from
            && let Some(at) = thread.messages.iter().position(|m| m.at >= from)
        {
            thread.messages.truncate(at);
        }
        thread.messages.extend(add);
        thread.updated_at = turn.updated_at;
        let written = store.write_ai_thread(thread)?;
        let conn = store.conn();
        let new_from = written.messages.len().saturating_sub(added);
        let messages = written.messages[new_from..]
            .iter()
            .map(|m| AiMessage {
                record: m.record.as_ref().map(AnswerRecord::trimmed_copy),
                ..m.clone()
            })
            .collect();
        let mut compactions = memory::store::compactions(conn, written.id)?;
        for c in &mut compactions {
            c.record = c.record.trimmed_copy();
        }
        Ok(memory::TurnView {
            thread_id: written.id,
            place: written.place.clone(),
            title: written.title.clone(),
            updated_at: written.updated_at,
            kept_from: written.messages.first().map(|m| m.at),
            message_count: written.messages.len() as u32,
            messages,
            topics: memory::store::topics(conn, written.id)?,
            compactions,
        })
    }

    /// Saves `thread`, each answer record held to its caps, and returns its view. The
    /// actions kept with an answer (`record_action`) and its tool outcome
    /// (`record_tool_result`) that the saved copy lacks are kept,
    /// and so is the AI Context the Core wrote into it. A trimmed record takes back the
    /// stored `log`, `steps`, `thinking` and exact text, and the stamp fields of a stored
    /// message win over the saved copy's.
    pub fn save_thread(&self, thread: &AiThread) -> Result<memory::ThreadView> {
        {
            let store = self.store()?;
            let before = store.get_ai_thread(thread.id)?;
            let thread = Self::merged(thread, before.as_ref());
            store.save_ai_thread(&thread)?;
        }
        self.thread_view(thread.id)?
            .ok_or_else(|| Error::Store("the saved thread is gone".into()))
    }

    fn merged(thread: &AiThread, before: Option<&AiThread>) -> AiThread {
        let mut thread = thread.clone();
        for m in &mut thread.messages {
            let old_message =
                before.and_then(|b| b.messages.iter().find(|o| o.role == m.role && o.at == m.at));
            if let Some(o) = old_message {
                if o.topic.is_some() {
                    m.topic = o.topic;
                    m.connection_id = o.connection_id;
                    m.database = o.database.clone();
                    m.kinds = o.kinds.clone();
                    m.tables = o.tables.clone();
                }
                if o.action.is_some() {
                    m.action = o.action.clone();
                }
            }
            let old = old_message.and_then(|o| o.record.as_ref());
            let kept = old.map(|r| r.actions.as_slice()).unwrap_or_default();
            if let Some(r) = &mut m.record {
                if r.trimmed
                    && let Some(o) = old
                {
                    r.log = o.log.clone();
                    r.steps = o.steps.clone();
                    r.thinking = o.thinking.clone();
                    if let Some(sent) = &mut r.sent {
                        sent.exact = o.sent.as_ref().and_then(|s| s.exact.clone());
                        if let Some(outline) = &mut sent.outline {
                            outline.exact = o
                                .sent
                                .as_ref()
                                .and_then(|s| s.outline.as_ref())
                                .and_then(|x| x.exact.clone());
                        }
                        if let Some(summary) = &mut sent.summary {
                            summary.exact = o
                                .sent
                                .as_ref()
                                .and_then(|s| s.summary.as_ref())
                                .and_then(|x| x.exact.clone());
                        }
                    }
                    r.trimmed = false;
                }
                if r.context.is_none() {
                    r.context = old.and_then(|o| o.context.clone());
                }
                for a in kept {
                    if !r.actions.contains(a) {
                        r.actions.push(*a);
                    }
                }
                r.actions.sort_by_key(|a| a.at);
                // The outcome `record_tool_result` kept, when the saved copy lacks it and is the
                // same tool use (same base hash and input); a message replaced at the same
                // `at` by another tool use keeps no old outcome.
                if let (Some(tu), Some(old_tu)) =
                    (r.tool_use.as_mut(), old.and_then(|o| o.tool_use.as_ref()))
                    && tu.outcome.is_none()
                    && tu.proposal.base_hash == old_tu.proposal.base_hash
                    && tu.input == old_tu.input
                {
                    tu.outcome = old_tu.outcome;
                }
            }
            m.record = m.record.take().map(AnswerRecord::capped);
        }
        thread
    }

    /// Undoes a compaction of `thread` (its messages show and go again) and returns the
    /// thread's view. A compaction already undone, or one that is not there, changes
    /// nothing: a second Undo returns the same view.
    pub fn undo_compaction(
        &self,
        thread: ThreadId,
        id: memory::CompactionId,
    ) -> Result<memory::ThreadView> {
        memory::store::undo_compaction(self.store()?.conn(), thread, id)?;
        self.thread_view(thread)?
            .ok_or_else(|| Error::InvalidInput("the chat is gone".into()))
    }

    pub fn delete_thread(&self, id: ThreadId) -> Result<()> {
        self.store()?.delete_ai_thread(id)
    }

    pub fn clear_threads(&self, place: &str) -> Result<()> {
        self.store()?.clear_ai_threads(place)
    }

    /// Every thread of every place ("Clear all AI data").
    pub fn clear_all_threads(&self) -> Result<()> {
        self.store()?.clear_all_ai_threads()
    }
}

/// Every saved provider key (a Group may use another provider) and the saved password
/// of each of `connections`, read from `secrets`.
pub(crate) fn redaction_secrets(
    secrets: &dyn SecretStore,
    connections: &[ConnectionConfig],
) -> Result<Secrets> {
    let mut out = Secrets::default();
    for account in AiProviderKind::key_accounts() {
        if let Some(key) = secrets.get_named(&account)? {
            out.keys.push(key);
        }
    }
    for c in connections {
        if let Some(password) = secrets.get(c.id)? {
            out.passwords.push(password);
        }
    }
    Ok(out)
}

/// The record for `model` under `settings`, with the stored listing's entry for it.
fn info_in(settings: &AiSettings, stored: Option<&StoredListing>, model: &str) -> ModelInfo {
    let kind = settings.provider.unwrap_or(AiProviderKind::Custom);
    let listed = stored.and_then(|s| s.models.iter().find(|m| m.id == model));
    info_for(kind, settings.preset.as_deref(), model, listed, settings)
}

/// The built-in models first, then the listed ones the table does not have, then the
/// current model when neither has it.
fn model_list(settings: &AiSettings, stored: Option<&StoredListing>) -> ModelList {
    let current = settings.model.trim().to_string();
    let mut ids: Vec<String> = match settings.provider {
        Some(kind) => builtins(kind, settings.preset.as_deref())
            .into_iter()
            .map(|m| m.id)
            .collect(),
        None => Vec::new(),
    };
    for m in stored.map(|s| s.models.as_slice()).unwrap_or_default() {
        if !ids.contains(&m.id) {
            ids.push(m.id.clone());
        }
    }
    if !current.is_empty() && !ids.contains(&current) {
        ids.push(current.clone());
    }
    ModelList {
        models: ids.iter().map(|id| info_in(settings, stored, id)).collect(),
        current,
        fetched_at: stored.map(|s| s.at),
    }
}

/// Asks "Reply with the single word ok." with `max_tokens` 8 and times the answer.
pub async fn test_provider(provider: &dyn AiProvider, model: &str) -> Result<AiTestOk> {
    let started = std::time::Instant::now();
    let req = ChatRequest {
        model: model.to_string(),
        system: Vec::new(),
        messages: vec![ChatMessage {
            role: ChatRole::User,
            text: TEST_PROMPT.into(),
        }],
        max_tokens: TEST_MAX_TOKENS,
        temperature: None,
        thinking: Thinking::Off,
        max_tokens_field: MaxTokensField::MaxTokens,
        // R0.1: the connection test carries no tools.
        tools: rails::execution::tool_for(rails::execution::ToolsAllowed::None),
    };
    let mut log = Log::new();
    rails::execution::ExecutionRail::new(rails::execution::ToolsAllowed::None)
        .check_request(&req, &mut log)?;
    provider.stream(&req, &mut log, &mut |_| {}).await?;
    Ok(AiTestOk {
        model: model.to_string(),
        millis: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemorySecretStore;

    #[tokio::test]
    async fn cancel_place_stops_every_ask_of_the_place() {
        let (_dir, ai) = service();
        let spawn = || tokio::spawn(std::future::pending::<()>());
        let (a, b, c) = (spawn(), spawn(), spawn());
        ai.start("g:1", "r1", a.abort_handle()).unwrap();
        ai.start("g:2", "r2", b.abort_handle()).unwrap();
        // A Compact now registers like an Ask, under its own id, once the Ask is gone.
        assert!(ai.cancel_place("g:1"));
        assert!(a.await.unwrap_err().is_cancelled());
        ai.start("g:1", "r3", c.abort_handle()).unwrap();
        assert!(!ai.cancel_place("nowhere"));
        assert!(ai.cancel_place("g:1"));
        assert!(c.await.unwrap_err().is_cancelled());
        // The other place still runs, and its id is still cancellable.
        assert!(!b.is_finished());
        assert!(!ai.cancel_place("g:1"));
        assert!(ai.cancel("r2"));
        assert!(b.await.unwrap_err().is_cancelled());
    }

    fn service() -> (tempfile::TempDir, AiService) {
        let dir = tempfile::tempdir().unwrap();
        let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
        (
            dir,
            AiService::new(store, Arc::new(MemorySecretStore::new())),
        )
    }

    fn groq(base_url: &str) -> AiSettings {
        AiSettings {
            provider: Some(AiProviderKind::Groq),
            base_url: base_url.into(),
            model: "llama-3.3-70b-versatile".into(),
            ..AiSettings::default()
        }
    }

    fn set(value: &str) -> KeyChange {
        KeyChange::Set {
            value: value.into(),
        }
    }

    fn key_host(svc: &AiService) -> Option<String> {
        svc.settings(None).unwrap().settings.key_host
    }

    #[test]
    fn saving_a_key_binds_its_host() {
        let (_dir, svc) = service();
        svc.save_settings(
            None,
            groq("https://api.groq.com/openai/v1"),
            false,
            set("gsk_1"),
        )
        .unwrap();
        assert_eq!(key_host(&svc).as_deref(), Some("api.groq.com"));
    }

    #[test]
    fn keeping_the_key_keeps_its_host() {
        let (_dir, svc) = service();
        svc.save_settings(
            None,
            groq("https://api.groq.com/openai/v1"),
            false,
            set("gsk_1"),
        )
        .unwrap();
        // The base URL moves without the key being entered again: the key stays bound.
        svc.save_settings(
            None,
            groq("https://evil.example/v1"),
            false,
            KeyChange::Keep,
        )
        .unwrap();
        assert_eq!(key_host(&svc).as_deref(), Some("api.groq.com"));
    }

    #[test]
    fn a_host_sent_by_the_caller_is_ignored() {
        let (_dir, svc) = service();
        let mut s = groq("https://api.groq.com/openai/v1");
        s.key_host = Some("evil.example".into());
        svc.save_settings(None, s, false, KeyChange::Keep).unwrap();
        assert_eq!(key_host(&svc), None);
    }

    #[test]
    fn clearing_the_key_clears_its_host() {
        let (_dir, svc) = service();
        svc.save_settings(
            None,
            groq("https://api.groq.com/openai/v1"),
            false,
            set("gsk_1"),
        )
        .unwrap();
        svc.save_settings(
            None,
            groq("https://api.groq.com/openai/v1"),
            false,
            KeyChange::Clear,
        )
        .unwrap();
        assert_eq!(key_host(&svc), None);
    }

    #[test]
    fn saving_a_url_with_credentials_is_refused() {
        let (_dir, svc) = service();
        svc.save_settings(
            None,
            groq("https://api.groq.com/openai/v1"),
            false,
            KeyChange::Keep,
        )
        .unwrap();
        for bad in [
            "https://user:pass@proxy.example/v1",
            "https://user@proxy.example/v1",
            " https://:pass@proxy.example/v1 ",
        ] {
            let err = svc
                .save_settings(None, groq(bad), false, KeyChange::Keep)
                .unwrap_err();
            assert!(
                matches!(
                    &err,
                    Error::Ai(AiError::UrlHasCredentials { host }) if host == "proxy.example"
                ),
                "{bad}: {err:?}"
            );
        }
        // Nothing was stored: the earlier base URL is still the saved one.
        assert_eq!(
            svc.settings(None).unwrap().settings.base_url,
            "https://api.groq.com/openai/v1"
        );
    }

    #[test]
    fn unbound_key_binds_to_the_old_host_when_the_base_url_moves() {
        let (_dir, svc) = service();
        // A key with no host: the base URL is empty, so Asks go to the preset's host.
        svc.save_settings(None, groq(""), false, set("gsk_1"))
            .unwrap();
        assert_eq!(key_host(&svc), None);
        svc.save_settings(
            None,
            groq("https://proxy.example/v1"),
            false,
            KeyChange::Keep,
        )
        .unwrap();
        assert_eq!(key_host(&svc).as_deref(), Some("api.groq.com"));
        assert!(matches!(
            svc.provider_for(None),
            Err(Error::Ai(AiError::KeyHostChanged { host })) if host == "proxy.example"
        ));
    }

    #[test]
    fn unbound_key_stays_unbound_when_the_host_does_not_move() {
        let (_dir, svc) = service();
        svc.save_settings(None, groq(""), false, set("gsk_1"))
            .unwrap();
        svc.save_settings(
            None,
            groq("https://api.groq.com/openai/v1"),
            false,
            KeyChange::Keep,
        )
        .unwrap();
        assert_eq!(key_host(&svc), None);
    }

    #[test]
    fn a_host_move_without_a_saved_key_binds_nothing() {
        let (_dir, svc) = service();
        svc.save_settings(None, groq(""), false, KeyChange::Keep)
            .unwrap();
        svc.save_settings(
            None,
            groq("https://proxy.example/v1"),
            false,
            KeyChange::Keep,
        )
        .unwrap();
        assert_eq!(key_host(&svc), None);
    }

    #[test]
    fn pick_tables_defaults_on() {
        let s: AiSettings = serde_json::from_str("{}").unwrap();
        assert!(s.pick_tables);
        assert!(AiSettings::default().pick_tables);
        let off = AiSettings {
            pick_tables: false,
            ..AiSettings::default()
        };
        let json = serde_json::to_value(&off).unwrap();
        assert_eq!(json["pickTables"], false);
        let back: AiSettings = serde_json::from_value(json).unwrap();
        assert!(!back.pick_tables);
    }

    #[test]
    fn auto_compact_defaults_on_and_is_global() {
        let (_dir, svc) = service();
        let s: AiSettings = serde_json::from_str("{}").unwrap();
        assert!(s.auto_compact);
        assert!(AiSettings::default().auto_compact);
        // A stored global record without the field reads on; a Group record that says
        // off never changes the effective value.
        let g = uuid::Uuid::new_v4();
        {
            let store = svc.store().unwrap();
            store.set_setting(SETTINGS_KEY, r#"{"model":"m"}"#).unwrap();
            store
                .set_setting(&group_key(g), r#"{"model":"m","autoCompact":false}"#)
                .unwrap();
        }
        let (effective, own) = svc.effective(Some(g)).unwrap();
        assert!(own);
        assert!(effective.auto_compact);
        // Turning it off globally is what turns it off for a Group too.
        svc.store()
            .unwrap()
            .set_setting(SETTINGS_KEY, r#"{"autoCompact":false}"#)
            .unwrap();
        assert!(!svc.effective(Some(g)).unwrap().0.auto_compact);
        assert!(!svc.effective(None).unwrap().0.auto_compact);
    }

    #[test]
    fn tool_errors_serialize_camel_case() {
        let long = "x".repeat(300);
        let e = AiError::file_changed("orders", Some(9), Some(&long));
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            serde_json::json!({
                "kind": "fileChanged",
                "file": "orders",
                "line": 9,
                "nowReads": "x".repeat(NOW_READS_CHARS),
            })
        );
        assert_eq!(e.to_string(), "orders changed while I worked");
        assert_eq!(
            serde_json::to_value(AiError::file_changed("orders", None, None)).unwrap(),
            serde_json::json!({ "kind": "fileChanged", "file": "orders", "line": null, "nowReads": null })
        );
        assert_eq!(
            serde_json::to_value(AiError::ToolRejected {
                name: "run_sql".into()
            })
            .unwrap(),
            serde_json::json!({ "kind": "toolRejected", "name": "run_sql" })
        );
        assert_eq!(
            serde_json::to_value(AiError::BadToolInput).unwrap(),
            serde_json::json!({ "kind": "badToolInput" })
        );
        assert_eq!(
            serde_json::to_value(AiError::ToolOff).unwrap(),
            serde_json::json!({ "kind": "toolOff" })
        );
    }

    #[tokio::test]
    async fn the_connection_test_carries_no_tools() {
        use crate::ai::provider::ProviderEvent;
        use crate::ai::provider::scripted::ScriptedProvider;
        let p = ScriptedProvider::new(vec![Ok(ProviderEvent::Text("ok".into()))]);
        test_provider(&p, "m").await.unwrap();
        assert_eq!(p.seen.lock().unwrap()[0].tools, None);
    }

    #[test]
    fn diagram_tool_is_global() {
        let (_dir, svc) = service();
        let g = uuid::Uuid::new_v4();
        {
            let store = svc.store().unwrap();
            store.set_setting(SETTINGS_KEY, r#"{"model":"m"}"#).unwrap();
            store
                .set_setting(&group_key(g), r#"{"model":"m","diagramTool":false}"#)
                .unwrap();
        }
        let (effective, own) = svc.effective(Some(g)).unwrap();
        assert!(own);
        assert!(effective.diagram_tool);
        svc.store()
            .unwrap()
            .set_setting(SETTINGS_KEY, r#"{"diagramTool":false}"#)
            .unwrap();
        assert!(!svc.effective(Some(g)).unwrap().0.diagram_tool);
    }

    #[test]
    fn a_key_with_no_base_url_has_no_host() {
        let (_dir, svc) = service();
        svc.save_settings(None, groq(""), false, set("gsk_1"))
            .unwrap();
        assert_eq!(key_host(&svc), None);
        assert!(svc.settings(None).unwrap().key_saved);
    }
}
