//! AI assistant settings, the provider key and the chat threads.

pub mod attachment;
pub mod board;
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
pub mod scene;
pub mod sent;
pub mod steps;
pub mod stream;
pub mod title;
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
use crate::ai::provider::url::{check_base_url, host_of, plain_text_off_this_computer};
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
    /// "Name chats with the AI": after a chat's first answer, one short call writes its
    /// title. Stored settings without it read on. Global like auto-compact: a
    /// Group override never changes it.
    #[serde(default = "yes")]
    pub name_chats: bool,
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
            name_chats: true,
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
        "this address is not encrypted; use https or a local address on this computer, or remove the saved key"
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
    /// The diagram Ask names an attached file the Core no longer holds (sent by an Ask that
    /// ended well, replaced by another pick, or removed): nothing is built or sent.
    #[error("the attached file is no longer held")]
    AttachmentGone,
    /// A frame of the diagram was drawn from a Connection the AI may not see (AI access
    /// Never, deleted, or another Group's provider), or a node links to a table of one:
    /// nothing is built or sent, and the text is never cut to get around it.
    /// `message` names the frame or node and the Connection, never the schema.
    #[error("{message}")]
    DiagramHeld { message: String },
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
    /// Where the question was asked, on the question only. Stored whole; the webview is
    /// given `AskedIn::label_only`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asked_in: Option<memory::AskedIn>,
}

impl AiMessage {
    /// The copy the webview is given: the record trimmed, the Asked in label only.
    fn for_view(&self) -> AiMessage {
        AiMessage {
            record: self.record.as_ref().map(AnswerRecord::trimmed_copy),
            asked_in: self.asked_in.as_ref().map(memory::AskedIn::label_only),
            ..self.clone()
        }
    }
}

pub type ThreadId = uuid::Uuid;

fn is_zero(n: &u8) -> bool {
    *n == 0
}

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
    /// Who wrote `title`. A save never changes it, nor `title`, nor `title_tries`, on a
    /// stored thread: only a rename, an AI title and a failed title call do.
    /// Left out of the JSON while it is the rule's, so a thread saved before reads back
    /// as it was written.
    #[serde(default, skip_serializing_if = "memory::TitleBy::is_rule")]
    pub title_by: memory::TitleBy,
    /// The AI title calls that failed.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub title_tries: u8,
    /// Where the chat last worked, with the SQL a resume puts back. Never sent to the
    /// webview with the thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_work: Option<memory::LastWork>,
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
    /// The steps on other Connections each recent Ask's stamp kept, by request id, newest
    /// last, until its turn is stored: the webview is never sent them (`hold_other_steps`).
    held: Mutex<VecDeque<(String, Vec<memory::OtherStep>)>>,
    /// The Connections whose steps were forgotten (`None`: every Connection) and when,
    /// newest last: a turn whose Ask began before is stored without their steps, whatever
    /// the webview sends back (`after_forgets`). One entry per Connection, its newest
    /// forget; at most `FORGOTTEN_KEPT` Connections, those forgotten longest ago dropped
    /// first.
    forgotten: Mutex<VecDeque<(Option<ConnectionId>, i64)>>,
    /// Makes the next purge fail, for the test of its retry.
    #[cfg(feature = "test-util")]
    fail_purge: std::sync::atomic::AtomicBool,
    /// Held across each read-modify-write of a settings record, so a Settings save and a
    /// model pick never undo each other.
    writing: Mutex<()>,
}

/// How many Asks' AI Contexts are kept for the save of their answer.
const ASKED_KEPT: usize = 32;
/// The longest chat title a rename keeps, in characters.
const RENAME_CHARS: usize = 120;
/// How many forgotten Connections (one entry each, `None` for every Connection) are
/// remembered for the turns of Asks still running. Past it, the Connection forgotten
/// longest ago is dropped first: an Ask that began before that forget and is still
/// running then could keep that Connection's labels in its kept exact text.
const FORGOTTEN_KEPT: usize = 256;
/// The settings row of the step purges a Connection delete left to do: a JSON list of
/// Connection ids, written before the delete and cleared once the purge is done.
pub const PENDING_PURGE_KEY: &str = "ai.pending_step_purge";

/// What one purge of stored steps did (`AiService::forget_steps`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StepPurge {
    /// Threads rewritten without the forgotten steps.
    pub rewritten: u32,
    /// Thread rows that could not be read, skipped.
    pub unreadable: u32,
}

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
            held: Mutex::new(VecDeque::new()),
            forgotten: Mutex::new(VecDeque::new()),
            #[cfg(feature = "test-util")]
            fail_purge: std::sync::atomic::AtomicBool::new(false),
            writing: Mutex::new(()),
        }
    }

    /// As `new`, then runs the step purges a Connection delete left pending (a purge that
    /// failed after its delete). Bounded by the thread caps; a failure stays pending.
    pub fn open(store: AppStore, secrets: Arc<dyn SecretStore>) -> Self {
        let svc = Self::new(store, secrets);
        let _ = svc.run_pending_purges();
        svc
    }

    /// Makes the next purge fail once.
    #[cfg(feature = "test-util")]
    pub fn fail_next_purge(&self) {
        self.fail_purge
            .store(true, std::sync::atomic::Ordering::SeqCst);
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
            own.name_chats = global.name_chats;
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
                settings.name_chats = global.name_chats;
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

    /// The Connections of `connections` whose Group's AI settings send to the same
    /// provider as `group`'s: the same provider kind, key and base URL. An Ask in `group`'s
    /// place reads every other one as AI access Never (`preview::SameProvider`).
    pub fn same_provider(
        &self,
        group: Option<GroupId>,
        connections: &[ConnectionConfig],
    ) -> Result<Vec<ConnectionId>> {
        // Where a record sends: the model and the other picks do not matter.
        let destination = |s: &AiSettings| {
            (
                s.provider,
                s.key_account(),
                s.effective_base_url()
                    .map(|u| u.trim().trim_end_matches('/').to_string()),
            )
        };
        let ask = destination(&self.effective(group)?.0);
        // Each Group's settings are read once; one that cannot be read is held back.
        let mut groups: Vec<(Option<GroupId>, bool)> = Vec::new();
        let mut out = Vec::new();
        for c in connections {
            let same = match groups.iter().find(|(g, _)| *g == c.group_id) {
                Some((_, same)) => *same,
                None => {
                    let same = self
                        .effective(c.group_id)
                        .is_ok_and(|(s, _)| destination(&s) == ask);
                    groups.push((c.group_id, same));
                    same
                }
            };
            if same {
                out.push(c.id);
            }
        }
        Ok(out)
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
        let key = self.secrets.get_named(&account)?.filter(|k| !k.is_empty());
        // L3: a key never goes over plain http to another machine; keyless is fine. Asked
        // before the key host, so the user is not asked to send the key where it cannot go.
        if key.is_some() && plain_text_off_this_computer(&url) {
            return Err(Error::Ai(AiError::InsecureUrl { host }));
        }
        let bound = self.key_host(&account)?;
        let moved = bound.as_ref().is_some_and(|bound| *bound != host);
        if moved && kind != AiProviderKind::Custom {
            return Err(Error::Ai(AiError::KeyHostChanged { host }));
        }
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
        let url = check_base_url(base).map_err(Error::Ai)?;
        let current = host_of(&url);
        // The settings moved again since the question was asked: ask about the new host.
        if current != host {
            return Err(Error::Ai(AiError::KeyHostChanged { host: current }));
        }
        if self.key_saved(&account)? && plain_text_off_this_computer(&url) {
            return Err(Error::Ai(AiError::InsecureUrl { host: current }));
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

    /// Keeps what the user did with the SQL of the answer at `message_at` in `thread`, and
    /// with `work`, where it went: the tab, the place and the SQL become where the chat
    /// last worked, also for an answer with no record. `None` for an answer
    /// saved before records were kept.
    pub fn record_action(
        &self,
        thread: ThreadId,
        message_at: i64,
        kind: AnswerActionKind,
        work: Option<memory::WorkInput>,
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
        let at = now_ms();
        let action = message.record.take().map(|mut record| {
            let action = AnswerAction { kind, at };
            record.actions.push(action);
            message.record = Some(record.capped());
            action
        });
        if action.is_none() && work.is_none() {
            return Ok(None);
        }
        if let Some(work) = work {
            t.last_work = Some(memory::LastWork::after_insert(
                t.last_work.take(),
                work,
                message_at,
                at,
            ));
        }
        store.save_ai_thread(&t)?;
        Ok(action)
    }

    /// Where the chat last worked, with its SQL, for a resume: the stored record, or for a
    /// chat saved before D2, the one its newest answer with SQL gives. `None` for a
    /// chat that is gone or never worked anywhere. Read only on a resume: the thread's
    /// JSON is read whole.
    pub fn thread_work(&self, id: ThreadId) -> Result<Option<memory::LastWork>> {
        let Some(t) = self.store()?.get_ai_thread(id)? else {
            return Ok(None);
        };
        Ok(t.last_work.clone().or_else(|| memory::LastWork::derive(&t)))
    }

    /// `thread_work` under the AI access gate: `access` is each Connection's current
    /// access (Never for one that is gone). A chat on a Connection at Never, or on none,
    /// comes back without its SQL.
    pub fn thread_work_for(
        &self,
        id: ThreadId,
        access: impl Fn(ConnectionId) -> AiAccess,
    ) -> Result<Option<memory::LastWork>> {
        Ok(self.thread_work(id)?.map(|w| w.gated(access)))
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
    /// Whether a title call for `req` may go, from the setting and the stored thread
    /// (`title::title_wanted`): no keyring read, so the command asks it first (final
    /// review M1).
    pub fn title_may_go(&self, req: &title::NameChatRequest) -> Result<bool> {
        let (settings, _) = self.effective(req.group_id)?;
        let thread = memory::store::thread(self.store()?.conn(), req.thread_id)?;
        Ok(title::title_wanted(
            settings.name_chats,
            thread.as_ref(),
            req,
        ))
    }

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

    /// The stored thread for a diagram Ask's history, slimmed to what `board_history` reads:
    /// each message's text and stamp, and of its record only the tool use's proposal and
    /// outcome and the Sent record's `sources` for the history gate (no sent text, thinking,
    /// log, steps or tool input), so the copy the Ask keeps stays small. Never sent to the webview.
    pub fn thread(&self, id: ThreadId) -> Result<Option<AiThread>> {
        let thread = memory::store::thread(self.store()?.conn(), id)?;
        Ok(thread.map(|mut t| {
            for m in &mut t.messages {
                m.asked_in = None;
                m.record = m.record.take().map(|r| sent::AnswerRecord {
                    tool_use: r.tool_use.map(|tu| sent::ToolUse {
                        input: String::new(),
                        ..tu
                    }),
                    // The history gate reads the Connections the answer drew on.
                    sent: r.sent.map(|s| sent::SentRecord {
                        sources: s.sources,
                        ..sent::SentRecord::default()
                    }),
                    ..sent::AnswerRecord::default()
                });
            }
            t
        }))
    }

    /// The thread with its Topics and compactions, every record trimmed.
    pub fn thread_view(&self, id: ThreadId) -> Result<Option<memory::ThreadView>> {
        let store = self.store()?;
        let conn = store.conn();
        let Some(mut thread) = memory::store::thread(conn, id)? else {
            return Ok(None);
        };
        // Its SQL stays in the Core: a save that lacks it keeps the stored one.
        thread.last_work = None;
        for m in &mut thread.messages {
            *m = m.for_view();
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

    /// The place's chats that hold a word of `text` in a question, a Topic, the title or
    /// where they last worked, as summaries, best 20 (`memory::store::search_place`).
    pub fn search_threads(&self, place: &str, text: &str) -> Result<Vec<memory::ThreadSummary>> {
        let terms = context::retrieve::question_terms(text);
        memory::store::search_place(self.store()?.conn(), place, &terms, 20)
    }

    /// Renames the chat: the title is the user's from now on (the AI never writes over
    /// it), and the list keeps its order (`updated_at` is not changed). The title is
    /// trimmed, on one line, 1 to 120 characters.
    pub fn rename_thread(&self, id: ThreadId, title: &str) -> Result<memory::ThreadSummary> {
        let title: String = title
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect();
        let title = title.trim();
        if title.is_empty() || title.chars().count() > RENAME_CHARS {
            return Err(Error::InvalidInput(
                "A chat title has 1 to 120 characters.".into(),
            ));
        }
        let store = self.store()?;
        let conn = store.conn();
        if !memory::store::set_thread_title(conn, id, title, memory::TitleBy::User)? {
            return Err(Error::InvalidInput("the chat is gone".into()));
        }
        memory::store::summary(conn, id)?
            .ok_or_else(|| Error::InvalidInput("the chat is gone".into()))
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

    /// Keeps the steps on other Connections of the Ask `request_id`'s stamp (its `Memory`
    /// event) for the save of its turn: the event reaches the webview without them (the
    /// stamp's `asked_in` is serialized so), and the save puts them back on the question.
    /// At most `ASKED_KEPT` Asks are kept; an Ask whose turn is never stored is dropped.
    pub fn hold_other_steps(&self, request_id: &str, event: &stream::AiEvent) {
        let stream::AiEvent::Memory { stamp } = event else {
            return;
        };
        let Some(steps) = stamp
            .asked_in
            .as_ref()
            .map(|a| a.other_steps.clone())
            .filter(|s| !s.is_empty())
        else {
            return;
        };
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        held.retain(|(id, _)| id != request_id);
        held.push_back((request_id.to_string(), steps));
        while held.len() > ASKED_KEPT {
            held.pop_front();
        }
    }

    /// The steps `hold_other_steps` kept for `request_id`. They stay held until the turn
    /// is written (`drop_held`), so the full save after a failed append still has them.
    fn peek_held(&self, request_id: Option<&str>) -> Option<Vec<memory::OtherStep>> {
        let id = request_id?;
        let held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        held.iter()
            .find(|(r, _)| r == id)
            .map(|(_, steps)| steps.clone())
    }

    /// Lets go of the steps held for `request_id`, once its turn is written.
    fn drop_held(&self, request_id: Option<&str>) {
        let Some(id) = request_id else { return };
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        held.retain(|(r, _)| r != id);
    }

    /// Remembers that the steps of `which` (every Connection with `None`) were forgotten
    /// now, and takes them out of the steps held for Asks still running.
    fn forget_running(&self, which: Option<&[ConnectionId]>) {
        let now = now_ms();
        {
            let mut forgotten = self.forgotten.lock().unwrap_or_else(|e| e.into_inner());
            let keys: Vec<Option<ConnectionId>> = match which {
                None => vec![None],
                Some(ids) => ids.iter().map(|id| Some(*id)).collect(),
            };
            // One entry per Connection: the newest forget covers every Ask an older one did.
            forgotten.retain(|(c, _)| !keys.contains(c));
            forgotten.extend(keys.into_iter().map(|c| (c, now)));
            while forgotten.len() > FORGOTTEN_KEPT {
                forgotten.pop_front();
            }
        }
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        for (_, steps) in held.iter_mut() {
            steps.retain(|s| which.is_some_and(|w| !w.contains(&s.connection_id)));
        }
    }

    /// Holds the messages of `thread` that `is_new` names to the forgets made since their
    /// Ask began (the question's time): as `forget_steps` would have left them on disk.
    fn after_forgets(&self, thread: &mut AiThread, is_new: &dyn Fn(usize) -> bool) {
        let forgets: Vec<(Option<ConnectionId>, i64)> = self
            .forgotten
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .copied()
            .collect();
        if forgets.is_empty() {
            return;
        }
        scrub_thread(
            thread,
            is_new,
            &|asked, id| {
                forgets
                    .iter()
                    .any(|(c, at)| *at >= asked && c.is_none_or(|c| c == *id))
            },
            &|asked| forgets.iter().any(|(_, at)| *at >= asked),
        );
    }

    /// As `save_thread`, for the save that adds the answer to the Ask `request_id`: the
    /// Core writes the AI Context that Ask used into the last answer's record, and the
    /// steps on other Connections it holds for that Ask onto the last question.
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
        let held = self.peek_held(request_id);
        let mut thread = thread.clone();
        if let Some(info) = used
            && let Some(record) = thread
                .messages
                .iter_mut()
                .rev()
                .find(|m| m.role == AiRole::Assistant)
                .and_then(|m| m.record.as_mut())
        {
            record.context = Some(info);
        }
        let view = self.save_held(&thread, held)?;
        self.drop_held(request_id);
        Ok(view)
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
        let held = self.peek_held(request_id);
        for m in &mut add {
            m.record = m.record.take().map(AnswerRecord::capped);
            // On the question only, held to its caps.
            m.asked_in = m
                .asked_in
                .take()
                .filter(|_| m.role == AiRole::User)
                .map(from_webview);
        }
        with_held(add.iter_mut(), held);
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
                title_by: Default::default(),
                title_tries: 0,
                last_work: None,
            });
        if let Some(from) = turn.replace_from
            && let Some(at) = thread.messages.iter().position(|m| m.at >= from)
        {
            thread.messages.truncate(at);
        }
        let new_at = thread.messages.len();
        thread.messages.extend(add);
        thread.updated_at = turn.updated_at;
        let end = thread.messages.len();
        // A Retry removed the stored messages from `replace_from` on: SQL from an answer
        // among them goes with it. One that the cap trimmed from the front stays.
        let cut = match turn.replace_from {
            Some(from) => memory::LastWork::after_cut(
                thread.last_work.take(),
                &thread.messages[..new_at],
                |at| at >= from,
            ),
            None => thread.last_work.take(),
        };
        thread.last_work = after_answers(cut, &thread.messages, new_at..end);
        self.after_forgets(&mut thread, &|i| i >= new_at);
        let written = store.write_ai_thread(thread)?;
        self.drop_held(request_id);
        let conn = store.conn();
        let new_from = written.messages.len().saturating_sub(added);
        let messages = written.messages[new_from..]
            .iter()
            .map(AiMessage::for_view)
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
            title_by: written.title_by,
            title_tries: written.title_tries,
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
        self.save_held(thread, None)
    }

    /// As `save_thread`, putting `held` (the steps on other Connections the Core kept for
    /// the Ask) on the last question when it is new to the store.
    fn save_held(
        &self,
        thread: &AiThread,
        held: Option<Vec<memory::OtherStep>>,
    ) -> Result<memory::ThreadView> {
        {
            let store = self.store()?;
            let before = store.get_ai_thread(thread.id)?;
            let mut thread = Self::merged(thread, before.as_ref(), held);
            let stored = |m: &AiMessage| {
                before
                    .as_ref()
                    .is_some_and(|b| b.messages.iter().any(|o| o.role == m.role && o.at == m.at))
            };
            let new: Vec<bool> = thread.messages.iter().map(|m| !stored(m)).collect();
            let added = (0..new.len()).filter(|i| new[*i]);
            // SQL from an answer the copy no longer holds goes with it (a Retry): one missing
            // from the copy and not older than its oldest message. One older than that only
            // fell off the front (the cap) and stays.
            let oldest = thread.messages.first().map_or(i64::MAX, |m| m.at);
            let cut =
                memory::LastWork::after_cut(thread.last_work.take(), &thread.messages, |at| {
                    at >= oldest
                        && !thread
                            .messages
                            .iter()
                            .any(|m| m.role == AiRole::Assistant && m.at == at)
                });
            thread.last_work = after_answers(cut, &thread.messages, added);
            self.after_forgets(&mut thread, &|i| new[i]);
            store.save_ai_thread(&thread)?;
        }
        self.thread_view(thread.id)?
            .ok_or_else(|| Error::Store("the saved thread is gone".into()))
    }

    /// Removes the stored steps on the Connections `which` names (every Connection with
    /// `None`) from every Ask of every place, and their labels from every kept copy of sent
    /// text (an answer record's exact text, and its outline and summary calls'), then
    /// rewrites each thread that changed with the threads' own write (one transaction
    /// each). Only threads whose JSON holds steps on other Connections are read.
    ///
    /// A label in a kept copy is tied to a Connection by the stored steps: in the Recent
    /// steps item, those of the turn's own question; in a replayed Asked in line, those of
    /// any question of the thread. A label tied to no Connection, or to more than one that
    /// includes a forgotten one, goes too. Returns how many threads were rewritten and how
    /// many rows could not be read.
    ///
    /// A thread row that cannot be read is skipped and counted in `unreadable` (the count
    /// goes to the error output, never the row's text), so one bad row never blocks the
    /// purge of the others or keeps a delete's purge pending for ever.
    pub fn forget_steps(&self, which: Option<&[ConnectionId]>) -> Result<StepPurge> {
        // Asks still running store their turns without them, whatever comes back.
        self.forget_running(which);
        #[cfg(feature = "test-util")]
        if self
            .fail_purge
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return Err(Error::Store("the purge failed (test)".into()));
        }
        let forgotten = |_: i64, id: &ConnectionId| which.is_none_or(|w| w.contains(id));
        let store = self.store()?;
        let mut done = StepPurge::default();
        for id in store.ai_threads_holding("\"otherSteps\"", "on another Connection")? {
            let mut thread = match store.get_ai_thread(id) {
                Ok(Some(t)) => t,
                Ok(None) => continue,
                Err(_) => {
                    done.unreadable += 1;
                    continue;
                }
            };
            if scrub_thread(&mut thread, &|_| true, &forgotten, &|_| true) {
                store.write_ai_thread(thread)?;
                done.rewritten += 1;
            }
        }
        if done.unreadable > 0 {
            eprintln!(
                "AI step purge: {} thread rows could not be read and were skipped",
                done.unreadable
            );
        }
        Ok(done)
    }

    /// Runs the step purges a Connection delete left pending (`delete_connection`), and
    /// clears each once done. A failure leaves it pending for the next try or start.
    pub fn run_pending_purges(&self) -> Result<StepPurge> {
        let ids = self.pending_purges()?;
        if ids.is_empty() {
            return Ok(StepPurge::default());
        }
        let done = self.forget_steps(Some(&ids))?;
        // Only the ids purged here: a delete may have added one since the read.
        self.update_pending_purges(|pending| pending.retain(|id| !ids.contains(id)))?;
        // The rewritten threads leave their old text in the WAL until this (L2).
        self.store()?.checkpoint();
        Ok(done)
    }

    /// Reads, changes and writes the pending purges as one step, under the settings write
    /// lock, so overlapping deletes and purges never lose each other's ids.
    fn update_pending_purges(&self, change: impl FnOnce(&mut Vec<ConnectionId>)) -> Result<()> {
        let _writing = self.writing();
        let mut ids = self.pending_purges()?;
        change(&mut ids);
        self.set_pending_purges(&ids)
    }

    fn pending_purges(&self) -> Result<Vec<ConnectionId>> {
        let json = self.store()?.get_setting(PENDING_PURGE_KEY)?;
        // An unreadable row purges nothing and is replaced by the next write.
        Ok(json
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default())
    }

    fn set_pending_purges(&self, ids: &[ConnectionId]) -> Result<()> {
        let store = self.store()?;
        if ids.is_empty() {
            return store.delete_setting(PENDING_PURGE_KEY);
        }
        let json = serde_json::to_string(ids).map_err(|e| Error::Store(e.to_string()))?;
        store.set_setting(PENDING_PURGE_KEY, &json)
    }

    /// "Clear AI history" of `place`: its threads, as `clear_threads`, then the steps of
    /// the Connections in that place kept with the Asks of every other place.
    pub fn clear_place_history(
        &self,
        place: &str,
        connections: &crate::connections::ConnectionService,
    ) -> Result<()> {
        self.clear_threads(place)?;
        let ids: Vec<ConnectionId> = connections
            .list()?
            .into_iter()
            .filter(|c| place_key(c) == place)
            .map(|c| c.id)
            .collect();
        if !ids.is_empty() {
            self.forget_steps(Some(&ids))?;
            self.store()?.checkpoint();
        }
        Ok(())
    }

    /// Deletes the Connection (`ConnectionService::delete`) and marks the purge of its
    /// steps kept with the Asks of every place as pending, in the AI store, before the
    /// delete. Asks still running store their turns without its steps. The caller then runs
    /// `run_pending_purges` off the async runtime; one that fails stays pending and runs
    /// again on the next try or the next start (`open`), so the steps never stay behind.
    pub async fn delete_connection(
        &self,
        connections: &crate::connections::ConnectionService,
        id: ConnectionId,
    ) -> Result<()> {
        self.update_pending_purges(|pending| {
            if !pending.contains(&id) {
                pending.push(id);
            }
        })?;
        if let Err(e) = connections.delete(id).await {
            // Not deleted: its steps stay.
            let _ = self.update_pending_purges(|pending| pending.retain(|p| *p != id));
            return Err(e);
        }
        self.forget_running(Some(&[id]));
        Ok(())
    }

    /// "Clear history" of a Connection, or of every Connection with `None`
    /// (`ConnectionService::clear_query_history`), then its steps kept with the Asks of
    /// every place.
    pub fn clear_query_history(
        &self,
        connections: &crate::connections::ConnectionService,
        id: Option<ConnectionId>,
    ) -> Result<()> {
        connections.clear_query_history(id)?;
        self.forget_steps(id.as_ref().map(std::slice::from_ref))?;
        // The threads the forget rewrote leave their old text in the WAL until this.
        self.store()?.checkpoint();
        Ok(())
    }

    fn merged(
        thread: &AiThread,
        before: Option<&AiThread>,
        held: Option<Vec<memory::OtherStep>>,
    ) -> AiThread {
        let mut thread = thread.clone();
        // A save never changes the title, its source or its tries: only a rename, an AI
        // title and a failed title call do. A new thread's title is the rule's. Where
        // it last worked is the Core's: a copy that lacks it keeps the stored one.
        match before {
            Some(b) => {
                thread.title = b.title.clone();
                thread.title_by = b.title_by;
                thread.title_tries = b.title_tries;
                // The webview never holds it; a copy that does wins only when it is
                // newer than the stored one, so a stale copy never puts older work back.
                let copy_newer = match (&thread.last_work, &b.last_work) {
                    (Some(c), Some(s)) => c.at > s.at,
                    (Some(_), None) => true,
                    (None, _) => false,
                };
                if !copy_newer {
                    thread.last_work = b.last_work.clone();
                }
            }
            None => {
                thread.title_by = memory::TitleBy::Rule;
                thread.title_tries = 0;
            }
        }
        // The last question, when it is new to the store, takes the held steps.
        let last_new = thread
            .messages
            .iter()
            .rposition(|m| m.role == AiRole::User)
            .filter(|i| {
                let m = &thread.messages[*i];
                !before.is_some_and(|b| b.messages.iter().any(|o| o.role == m.role && o.at == m.at))
            });
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
                // The webview holds the label only: the stored Asked in wins, as stored.
                m.asked_in = o.asked_in.clone();
            } else {
                m.asked_in = m
                    .asked_in
                    .take()
                    .filter(|_| m.role == AiRole::User)
                    .map(from_webview);
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
                        if let Some(title) = &mut sent.title {
                            title.exact = o
                                .sent
                                .as_ref()
                                .and_then(|s| s.title.as_ref())
                                .and_then(|x| x.exact.clone());
                        }
                    }
                    r.trimmed = false;
                } else if let Some(o) = old {
                    // A whole copy keeps the title call's lines the Core wrote after the
                    // turn was stored.
                    for line in o.log.iter().filter(|l| l.source == "title") {
                        if !r.log.contains(line) {
                            r.log.push(line.clone());
                        }
                    }
                }
                // The title call lands after the turn is stored: a copy that lacks its
                // record keeps the stored one.
                if let Some(stored) = old
                    .and_then(|o| o.sent.as_ref())
                    .filter(|s| s.title.is_some())
                {
                    match &mut r.sent {
                        Some(sent) if sent.title.is_none() => sent.title = stored.title.clone(),
                        Some(_) => {}
                        None => r.sent = Some(stored.clone()),
                    }
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
        if let Some(i) = last_new {
            with_held(thread.messages[i..=i].iter_mut(), held);
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

    /// Every board's chats (each `diagram:<name>` place), with their Topics, search rows and
    /// tool-use rows: Settings' "Clear AI history" clears them with the place's Ask threads,
    /// as its hint says, since boards belong to no Group.
    pub fn clear_diagram_chats(&self) -> Result<()> {
        let store = self.store()?;
        for place in store.diagram_ai_places()? {
            store.clear_ai_threads(&place)?;
        }
        Ok(())
    }

    /// A board's rename: the files move first, and only when that succeeds do the board's
    /// chats follow (A14). A chat move that fails is logged, not returned: the files are
    /// already renamed, and the command must not report a rename that happened as failed.
    pub fn rename_board(&self, data_dir: &std::path::Path, from: &str, to: &str) -> Result<()> {
        crate::diagrams::rename_diagram(data_dir, from, to)?;
        let base = |n: &str| n.strip_suffix(".flow").unwrap_or(n).to_string();
        let (from, to) = (
            diagram::diagram_place(&base(from)),
            diagram::diagram_place(&base(to)),
        );
        if let Err(e) = self.store().and_then(|s| s.move_ai_place(&from, &to)) {
            eprintln!("ai: the chats of {from} did not follow the rename to {to}: {e}");
        }
        Ok(())
    }

    /// A deleted board's chats go with it, so a later board of the same name starts empty.
    pub fn forget_board(&self, name: &str) -> Result<()> {
        let base = name.strip_suffix(".flow").unwrap_or(name);
        self.clear_threads(&diagram::diagram_place(base))
    }

    /// A board's delete: both files to the Recycle Bin, then its chats. It blocks while the
    /// shell works, so the app calls it off the main thread.
    pub fn delete_board(&self, data_dir: &std::path::Path, name: &str) -> Result<()> {
        self.delete_board_with(data_dir, name, crate::diagrams::recycle)
    }

    /// `diagrams::delete_diagram_with`, then the board's chats; they stay when the files do.
    /// Chats that cannot be cleared are logged, not returned: the board is gone, and the
    /// command must not report a delete that happened as failed (as `rename_board`).
    pub fn delete_board_with(
        &self,
        data_dir: &std::path::Path,
        name: &str,
        recycle: impl FnOnce(&[std::path::PathBuf]) -> Result<()>,
    ) -> Result<()> {
        crate::diagrams::delete_diagram_with(data_dir, name, recycle)?;
        if let Err(e) = self.forget_board(name) {
            eprintln!("ai: the chats of the deleted board {name} were not cleared: {e}");
        }
        Ok(())
    }

    /// Every thread of every place ("Clear all AI data").
    pub fn clear_all_threads(&self) -> Result<()> {
        self.store()?.clear_all_ai_threads()
    }
}

/// Takes the steps on forgotten Connections out of the messages of `thread` that `scope`
/// names, for the turns `any` says a forget reaches (by the question's time): from each
/// question's Asked in, those `forgotten` names; from each answer's kept copies of sent
/// text (its exact text, and its outline and summary calls'), their labels. A label is tied
/// to its Connection by the stored steps, read before any is removed: in the Recent steps
/// item, those of the turn's own question; in a replayed Asked in line, those of any
/// question of the thread. A label of the question's own steps never goes; a label on
/// another Connection tied to none, or to more than one including a forgotten one, goes.
/// True when anything changed.
fn scrub_thread(
    thread: &mut AiThread,
    scope: &dyn Fn(usize) -> bool,
    forgotten: &dyn Fn(i64, &ConnectionId) -> bool,
    any: &dyn Fn(i64) -> bool,
) -> bool {
    let steps_of = |m: &AiMessage| -> Vec<(String, ConnectionId)> {
        m.asked_in
            .as_ref()
            .map(|a| {
                a.other_steps
                    .iter()
                    .map(|s| (s.text.clone(), s.connection_id))
                    .collect()
            })
            .unwrap_or_default()
    };
    let all: Vec<(String, ConnectionId)> = thread.messages.iter().flat_map(steps_of).collect();
    let mut changed = false;
    let mut turn: Vec<(String, ConnectionId)> = Vec::new();
    let mut own: Vec<String> = Vec::new();
    let mut asked = i64::MIN;
    for (i, m) in thread.messages.iter_mut().enumerate() {
        if m.role == AiRole::User {
            turn = steps_of(m);
            own = m
                .asked_in
                .as_ref()
                .map(|a| a.steps.clone())
                .unwrap_or_default();
            asked = m.at;
        }
        if !scope(i) || !any(asked) {
            continue;
        }
        let gone = |known: &[(String, ConnectionId)], label: &str| {
            let mut owners = known.iter().filter(|(t, _)| t == label).peekable();
            owners.peek().is_none() || owners.any(|(_, c)| forgotten(asked, c))
        };
        if let Some(sent) = m.record.as_mut().and_then(|r| r.sent.as_mut()) {
            let exacts = [
                sent.exact.as_mut(),
                sent.outline.as_mut().and_then(|o| o.exact.as_mut()),
                sent.summary.as_mut().and_then(|s| s.exact.as_mut()),
            ];
            for exact in exacts.into_iter().flatten() {
                if let Some(clean) = rails::retrieval::without_steps_of(
                    exact,
                    memory::OTHER_STEPS_LEAD,
                    &|l| !own.iter().any(|o| o == l) && gone(&turn, l),
                    &|l| gone(&all, l),
                ) {
                    *exact = clean;
                    changed = true;
                }
            }
        }
        if let Some(a) = m.asked_in.as_mut() {
            let before = a.other_steps.len();
            a.other_steps
                .retain(|s| !forgotten(asked, &s.connection_id));
            changed |= a.other_steps.len() != before;
        }
    }
    changed
}

/// `work` after each answer at `added` of `messages` arrived, oldest first
/// (`LastWork::after_answer`).
fn after_answers(
    work: Option<memory::LastWork>,
    messages: &[AiMessage],
    added: impl IntoIterator<Item = usize>,
) -> Option<memory::LastWork> {
    added
        .into_iter()
        .take_while(|i| *i < messages.len())
        .fold(work, |w, i| memory::LastWork::after_answer(w, messages, i))
}

/// An Asked in the webview sent, held to its caps: steps on other Connections are never in
/// the webview, so any it sends are dropped (`hold_other_steps` keeps the real ones).
fn from_webview(a: memory::AskedIn) -> memory::AskedIn {
    memory::AskedIn {
        other_steps: Vec::new(),
        ..a
    }
    .capped()
}

/// Puts `held` on the last question of `messages`, when it has an Asked in, held to its
/// caps.
fn with_held<'m>(
    messages: impl DoubleEndedIterator<Item = &'m mut AiMessage>,
    held: Option<Vec<memory::OtherStep>>,
) {
    let Some(held) = held else { return };
    if let Some(a) = messages
        .rev()
        .find(|m| m.role == AiRole::User)
        .and_then(|m| m.asked_in.as_mut())
    {
        a.other_steps = held;
        *a = a.capped();
    }
}

/// The place a Connection's threads are kept under, as the UI names it: its Group's, or
/// Ungrouped.
fn place_key(c: &ConnectionConfig) -> String {
    match c.group_id {
        Some(g) => format!("group:{g}"),
        None => "ungrouped".into(),
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

    /// Task 5b review N3: the forget record keeps one entry per Connection, its newest
    /// forget, so forgetting one Connection again and again never pushes another out; past
    /// `FORGOTTEN_KEPT` Connections, those forgotten longest ago go first.
    #[test]
    fn forget_record_keeps_the_newest_forget_per_connection() {
        let (_dir, ai) = service();
        let kept = |ai: &AiService| -> Vec<Option<ConnectionId>> {
            ai.forgotten
                .lock()
                .unwrap()
                .iter()
                .map(|(c, _)| *c)
                .collect()
        };
        let (first, again) = (uuid::Uuid::from_u128(1), uuid::Uuid::from_u128(2));
        ai.forget_running(Some(&[first]));
        for _ in 0..FORGOTTEN_KEPT + 10 {
            ai.forget_running(Some(&[again]));
        }
        assert_eq!(kept(&ai), [Some(first), Some(again)]);
        // Every Connection is one entry too, and a newer forget moves an entry to the end.
        ai.forget_running(None);
        ai.forget_running(None);
        ai.forget_running(Some(&[first]));
        assert_eq!(kept(&ai), [Some(again), None, Some(first)]);
        // Past the cap: the oldest go first, the newest forget of each stays.
        let many: Vec<ConnectionId> = (100..100 + FORGOTTEN_KEPT as u128 - 1)
            .map(uuid::Uuid::from_u128)
            .collect();
        ai.forget_running(Some(&many));
        let now = kept(&ai);
        assert_eq!(now.len(), FORGOTTEN_KEPT);
        // `again` and every Connection were forgotten longest ago; `first` is next.
        assert_eq!(now[0], Some(first));
        assert!(!now.contains(&Some(again)) && !now.contains(&None));
        assert_eq!(now.last(), Some(&many.last().copied()));
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

    /// P20: "Name chats with the AI" reads on when not stored, and is global like
    /// auto-compact: a Group's record never changes it.
    #[test]
    fn name_chats_defaults_on_and_is_global() {
        let (_dir, svc) = service();
        let s: AiSettings = serde_json::from_str("{}").unwrap();
        assert!(s.name_chats);
        assert!(AiSettings::default().name_chats);
        let g = uuid::Uuid::new_v4();
        {
            let store = svc.store().unwrap();
            store.set_setting(SETTINGS_KEY, r#"{"model":"m"}"#).unwrap();
            store
                .set_setting(&group_key(g), r#"{"model":"m","nameChats":false}"#)
                .unwrap();
        }
        let (effective, own) = svc.effective(Some(g)).unwrap();
        assert!(own);
        assert!(effective.name_chats);
        svc.store()
            .unwrap()
            .set_setting(SETTINGS_KEY, r#"{"nameChats":false}"#)
            .unwrap();
        assert!(!svc.effective(Some(g)).unwrap().0.name_chats);
        assert!(!svc.effective(None).unwrap().0.name_chats);
        let json = serde_json::to_value(AiSettings::default()).unwrap();
        assert_eq!(json["nameChats"], true);
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

    fn raw_thread(svc: &AiService, id: ThreadId) -> serde_json::Value {
        let store = svc.store().unwrap();
        let raw: String = store
            .conn()
            .query_row(
                "SELECT json FROM ai_threads WHERE id = ?1",
                [id.to_string()],
                |r| r.get(0),
            )
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    fn asked_in() -> memory::AskedIn {
        memory::AskedIn {
            tab: "visual".into(),
            label: "Visual Query \"Orders over 1M\" in shop".into(),
            summary: "tables orders, customers; ticked orders.id, orders.total".into(),
            steps: vec![
                "opened Visual Query in shop".into(),
                "ticked orders.id".into(),
            ],
            also: Vec::new(),
            other_steps: Vec::new(),
            tab_key: None,
        }
    }

    fn asked_turn(thread: ThreadId) -> memory::AppendTurn {
        let msg = |role, text: &str, at| AiMessage {
            role,
            text: text.into(),
            context: Vec::new(),
            at,
            record: None,
            topic: Some(1),
            connection_id: Some(uuid::Uuid::from_u128(42)),
            database: Some("shop".into()),
            kinds: vec![ItemKind::Question, ItemKind::Tab],
            tables: vec!["orders".into()],
            action: Some("ask".into()),
            asked_in: Some(asked_in()),
        };
        memory::AppendTurn {
            thread_id: thread,
            place: "ungrouped".into(),
            title: "orders".into(),
            updated_at: 10,
            messages: vec![
                msg(AiRole::User, "find orders over 1M", 10),
                msg(AiRole::Assistant, "Filter on total.", 11),
            ],
            replace_from: None,
        }
    }

    #[test]
    fn append_turn_keeps_the_tab_key_for_the_asked_in_link() {
        let (_dir, svc) = service();
        let id = uuid::Uuid::new_v4();
        let mut turn = asked_turn(id);
        if let Some(a) = turn.messages[0].asked_in.as_mut() {
            a.tab_key = Some("query:d1".into());
        }
        let view = svc.append_turn(turn, None).unwrap();
        let shown = view.messages[0].asked_in.as_ref().unwrap();
        assert_eq!(shown.tab_key.as_deref(), Some("query:d1"));
        let back = svc.thread_view(id).unwrap().unwrap();
        assert_eq!(
            back.thread.messages[0]
                .asked_in
                .as_ref()
                .unwrap()
                .tab_key
                .as_deref(),
            Some("query:d1")
        );
    }

    #[test]
    fn append_turn_keeps_asked_in_and_view_has_label_only() {
        let (_dir, svc) = service();
        let id = uuid::Uuid::new_v4();
        let view = svc.append_turn(asked_turn(id), None).unwrap();

        // Stored whole on the question; never on the answer.
        let raw = raw_thread(&svc, id);
        let stored = &raw["messages"][0]["askedIn"];
        assert_eq!(
            stored["summary"],
            "tables orders, customers; ticked orders.id, orders.total"
        );
        assert_eq!(stored["steps"].as_array().unwrap().len(), 2);
        assert!(raw["messages"][1].get("askedIn").is_none(), "{raw}");

        // The webview gets the tab and the label only, from the append and the view.
        let label_only = Some(asked_in().label_only());
        assert_eq!(view.messages[0].asked_in, label_only);
        assert_eq!(view.messages[1].asked_in, None);
        let shown = svc.thread_view(id).unwrap().unwrap();
        assert_eq!(shown.thread.messages[0].asked_in, label_only);
        let a = shown.thread.messages[0].asked_in.as_ref().unwrap();
        assert!(a.summary.is_empty() && a.steps.is_empty());
        assert_eq!(a.label, "Visual Query \"Orders over 1M\" in shop");
        let json = serde_json::to_string(&shown).unwrap();
        assert!(!json.contains("ticked orders.id"), "{json}");
    }

    #[test]
    fn append_turn_caps_asked_in() {
        let (_dir, svc) = service();
        let id = uuid::Uuid::new_v4();
        let mut turn = asked_turn(id);
        let a = turn.messages[0].asked_in.as_mut().unwrap();
        a.summary = "x".repeat(5_000);
        a.steps = vec!["s".repeat(100); 40];
        svc.append_turn(turn, None).unwrap();
        let back = svc.store().unwrap().get_ai_thread(id).unwrap().unwrap();
        let a = back.messages[0].asked_in.as_ref().unwrap();
        assert_eq!(a.summary.len(), memory::ASKED_IN_SUMMARY_BYTES);
        let steps: usize = a.steps.iter().map(|s| s.len() + 1).sum();
        assert!(steps <= memory::ASKED_IN_STEPS_BYTES + 1, "{steps}");
    }

    #[test]
    fn save_thread_keeps_stored_asked_in() {
        let (_dir, svc) = service();
        let id = uuid::Uuid::new_v4();
        svc.append_turn(asked_turn(id), None).unwrap();
        // The webview's copy: label only, as it was given; a forged summary loses too.
        let mut copy = svc.thread_view(id).unwrap().unwrap().thread;
        assert!(
            copy.messages[0]
                .asked_in
                .as_ref()
                .unwrap()
                .summary
                .is_empty()
        );
        copy.messages[1].asked_in = Some(memory::AskedIn {
            summary: "forged".into(),
            ..asked_in()
        });
        svc.save_thread(&copy).unwrap();
        let back = svc.store().unwrap().get_ai_thread(id).unwrap().unwrap();
        assert_eq!(back.messages[0].asked_in, Some(asked_in()));
        assert_eq!(back.messages[1].asked_in, None);
    }

    /// A failed append: the webview's next save sends its label-only copy for a question
    /// the Core does not hold. The other Connection's id stays, so the gate still holds
    /// the turn once that Connection is lowered.
    #[test]
    fn label_only_copy_keeps_the_gate_on_other_connections() {
        let (_dir, svc) = service();
        let id = uuid::Uuid::new_v4();
        let other = uuid::Uuid::from_u128(43);
        let mut turn = asked_turn(id);
        turn.messages[0].asked_in.as_mut().unwrap().also = vec![other];
        let copy = AiThread {
            id,
            place: turn.place.clone(),
            title: turn.title.clone(),
            messages: turn.messages.iter().map(AiMessage::for_view).collect(),
            updated_at: turn.updated_at,
            title_by: Default::default(),
            title_tries: 0,
            last_work: None,
        };
        let shown = copy.messages[0].asked_in.as_ref().unwrap();
        assert!(shown.summary.is_empty() && shown.steps.is_empty());
        svc.save_thread(&copy).unwrap();
        let back = svc.store().unwrap().get_ai_thread(id).unwrap().unwrap();
        assert_eq!(
            back.messages[0].asked_in.as_ref().unwrap().also,
            vec![other]
        );
        // Gated at the lower access, held at Never.
        let q = &back.messages[0];
        let own = AiAccess::SchemaQuery;
        let ask = memory::AskFacts {
            connection_id: q.connection_id,
            database: Some("shop"),
            tables: &[],
        };
        assert_eq!(
            memory::message_access(q, &ask, own, &[(other, AiAccess::Schema)]),
            AiAccess::Schema
        );
        assert_eq!(
            memory::message_access(q, &ask, own, &[(other, AiAccess::Never)]),
            AiAccess::Never
        );
        assert_eq!(memory::message_access(q, &ask, own, &[]), AiAccess::Never);
    }

    #[test]
    fn old_threads_load() {
        const OLD: &str = r#"{"id":"00000000-0000-0000-0000-00000000002a","place":"ungrouped","title":"orders","messages":[{"role":"user","text":"how many orders?","context":["Question"],"at":10,"topic":1,"connectionId":"00000000-0000-0000-0000-00000000002a","database":"shop","kinds":["question","names"],"tables":["orders"],"action":"ask"},{"role":"assistant","text":"About 40.","context":[],"at":11,"topic":1,"connectionId":"00000000-0000-0000-0000-00000000002a","database":"shop","kinds":["question","names"],"tables":["orders"],"action":"ask"}],"updatedAt":11}"#;
        let (_dir, svc) = service();
        let id = uuid::Uuid::from_u128(42);
        svc.store()
            .unwrap()
            .conn()
            .execute(
                "INSERT INTO ai_threads (id, place, json, updated_at) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![id.to_string(), "ungrouped", OLD, 11],
            )
            .unwrap();
        let view = svc.thread_view(id).unwrap().unwrap();
        assert_eq!(view.thread.messages.len(), 2);
        assert!(view.thread.messages.iter().all(|m| m.asked_in.is_none()));
        svc.save_thread(&view.thread).unwrap();
        let old: serde_json::Value = serde_json::from_str(OLD).unwrap();
        assert_eq!(raw_thread(&svc, id), old);
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
