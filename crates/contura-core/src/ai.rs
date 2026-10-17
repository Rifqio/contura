//! AI assistant settings, the provider key and the Placeholder provider.
//! Nothing here opens a socket: real providers arrive in a later version.

use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::model::GroupId;
use crate::secrets::SecretStore;
use crate::store::AppStore;

const SETTINGS_KEY: &str = "ai.settings";

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

    /// Every `AI/<provider>` Credential Manager account.
    pub fn key_accounts() -> Vec<String> {
        Self::ALL.iter().map(|p| p.key_account()).collect()
    }

    fn key_account(self) -> String {
        format!("AI/{}", self.id())
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
    pub inline_ask: bool,
    pub error_ask: bool,
    #[serde(default)]
    pub new_connection_access: AiAccess,
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
            inline_ask: true,
            error_ask: true,
            new_connection_access: AiAccess::default(),
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

#[derive(thiserror::Error, Debug, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AiError {
    #[error("no AI provider is set up")]
    NotConfigured,
    #[error("answers from {} are not available yet", provider.id())]
    NotAvailable { provider: AiProviderKind },
    #[error("the provider rejected the key")]
    BadKey,
    #[error("the provider is rate limiting requests")]
    RateLimited { retry_after_secs: Option<u32> },
    #[error("could not reach {host}")]
    Network { host: String },
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    pub question: String,
    pub payload: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiAnswer {
    pub text: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiTestOk {
    pub model: String,
    pub millis: u64,
}

pub trait AiProvider {
    fn ask(&self, req: &AiRequest) -> Result<AiAnswer>;
    fn test(&self) -> Result<AiTestOk>;
}

/// Answers by state and never touches the network.
pub struct Placeholder {
    pub configured: Option<AiProviderKind>,
}

impl Placeholder {
    fn refusal(&self) -> Error {
        Error::Ai(match self.configured {
            None => AiError::NotConfigured,
            Some(provider) => AiError::NotAvailable { provider },
        })
    }
}

impl AiProvider for Placeholder {
    fn ask(&self, _req: &AiRequest) -> Result<AiAnswer> {
        Err(self.refusal())
    }

    fn test(&self) -> Result<AiTestOk> {
        Err(self.refusal())
    }
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

/// Settings in the app store, the key in the credential store.
pub struct AiService {
    store: Mutex<AppStore>,
    secrets: Arc<dyn SecretStore>,
}

fn group_key(group: GroupId) -> String {
    format!("{SETTINGS_KEY}.{group}")
}

fn parse(raw: &str) -> Result<AiSettings> {
    serde_json::from_str(raw).map_err(|e| Error::Store(e.to_string()))
}

impl AiService {
    pub fn new(store: AppStore, secrets: Arc<dyn SecretStore>) -> Self {
        Self {
            store: Mutex::new(store),
            secrets,
        }
    }

    fn store(&self) -> Result<MutexGuard<'_, AppStore>> {
        self.store
            .lock()
            .map_err(|_| Error::Store("lock poisoned".into()))
    }

    /// The Group's override when it has one, else the global settings.
    fn effective(&self, group: Option<GroupId>) -> Result<(AiSettings, bool)> {
        let store = self.store()?;
        if let Some(g) = group
            && let Some(raw) = store.get_setting(&group_key(g))?
        {
            return Ok((parse(&raw)?, true));
        }
        let settings = match store.get_setting(SETTINGS_KEY)? {
            Some(raw) => parse(&raw)?,
            None => AiSettings::default(),
        };
        Ok((settings, false))
    }

    pub fn settings(&self, group: Option<GroupId>) -> Result<AiSettingsView> {
        let (settings, group_override) = self.effective(group)?;
        let key = match settings.provider {
            Some(p) => self.secrets.get_named(&p.key_account())?,
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
        settings: AiSettings,
        override_group: bool,
        key: KeyChange,
    ) -> Result<()> {
        let json = serde_json::to_string(&settings).map_err(|e| Error::Store(e.to_string()))?;
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
            match group {
                Some(g) if override_group => store.set_setting(&group_key(g), &json)?,
                Some(g) => {
                    store.delete_setting(&group_key(g))?;
                    store.set_setting(SETTINGS_KEY, &json)?;
                }
                None => store.set_setting(SETTINGS_KEY, &json)?,
            }
        }
        if let Some(provider) = settings.provider {
            let account = provider.key_account();
            match key {
                KeyChange::Keep => {}
                KeyChange::Set { value } => self.secrets.set_named(&account, value.trim())?,
                KeyChange::Clear => self.secrets.delete_named(&account)?,
            }
        }
        Ok(())
    }

    fn provider(&self, group: Option<GroupId>) -> Result<Placeholder> {
        let (settings, _) = self.effective(group)?;
        Ok(Placeholder {
            configured: settings.provider,
        })
    }

    pub fn test(&self, group: Option<GroupId>) -> Result<AiTestOk> {
        self.provider(group)?.test()
    }

    pub fn ask(&self, group: Option<GroupId>, req: &AiRequest) -> Result<AiAnswer> {
        self.provider(group)?.ask(req)
    }

    pub fn list_threads(&self, place: &str) -> Result<Vec<AiThread>> {
        self.store()?.list_ai_threads(place)
    }

    pub fn save_thread(&self, thread: &AiThread) -> Result<()> {
        self.store()?.save_ai_thread(thread)
    }

    pub fn delete_thread(&self, id: ThreadId) -> Result<()> {
        self.store()?.delete_ai_thread(id)
    }

    pub fn clear_threads(&self, place: &str) -> Result<()> {
        self.store()?.clear_ai_threads(place)
    }
}
