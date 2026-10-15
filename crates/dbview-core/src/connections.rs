use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use serde::Deserialize;
use uuid::Uuid;

use crate::dialect::{Dialect, connect};
use crate::error::{Error, Result};
use crate::model::{
    ConnectionConfig, ConnectionId, DialectKind, Group, GroupColor, GroupId, SslMode,
};
use crate::secrets::SecretStore;
use crate::store::AppStore;
use crate::suggest::{SuggestedConnection, laragon_suggestions};

const LAST_GROUP_KEY: &str = "last_group";

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum PasswordChange {
    Keep,
    Set { value: String },
    Clear,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    pub id: Option<ConnectionId>,
    pub name: String,
    pub dialect: DialectKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: Option<String>,
    pub ssl: SslMode,
    pub password: PasswordChange,
    pub group_id: Option<GroupId>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInput {
    pub id: Option<GroupId>,
    pub name: String,
    pub color: GroupColor,
}

/// Owns the saved Connections, Groups and the open sessions. The store lock is
/// never held across an `.await`.
pub struct ConnectionService {
    store: Mutex<AppStore>,
    secrets: Arc<dyn SecretStore>,
    sessions: RwLock<HashMap<ConnectionId, Arc<dyn Dialect>>>,
    /// Bumped whenever a Connection is saved, deleted or closed, so an `open`
    /// that was connecting meanwhile can tell its settings went stale.
    generations: Mutex<HashMap<ConnectionId, u64>>,
}

fn poisoned() -> Error {
    Error::Store("lock poisoned".into())
}

impl ConnectionService {
    pub fn new(store: AppStore, secrets: Arc<dyn SecretStore>) -> Self {
        Self {
            store: Mutex::new(store),
            secrets,
            sessions: RwLock::new(HashMap::new()),
            generations: Mutex::new(HashMap::new()),
        }
    }

    fn store(&self) -> Result<MutexGuard<'_, AppStore>> {
        self.store.lock().map_err(|_| poisoned())
    }

    fn take_session(&self, id: ConnectionId) -> Result<Option<Arc<dyn Dialect>>> {
        Ok(self.sessions.write().map_err(|_| poisoned())?.remove(&id))
    }

    fn generation(&self, id: ConnectionId) -> Result<u64> {
        Ok(self
            .generations
            .lock()
            .map_err(|_| poisoned())?
            .get(&id)
            .copied()
            .unwrap_or(0))
    }

    fn bump_generation(&self, id: ConnectionId) -> Result<()> {
        *self
            .generations
            .lock()
            .map_err(|_| poisoned())?
            .entry(id)
            .or_insert(0) += 1;
        Ok(())
    }

    /// Bumps the generation first, so an in-flight `open` discards its session.
    async fn close_session(&self, id: ConnectionId) -> Result<()> {
        self.bump_generation(id)?;
        if let Some(session) = self.take_session(id)? {
            session.disconnect().await.ok();
        }
        Ok(())
    }

    fn validate(input: &ConnectionInput) -> Result<String> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err(Error::InvalidInput("name must not be empty".into()));
        }
        if input.host.trim().is_empty() {
            return Err(Error::InvalidInput("host must not be empty".into()));
        }
        Ok(name.to_string())
    }

    fn config_from(id: ConnectionId, name: String, input: &ConnectionInput) -> ConnectionConfig {
        ConnectionConfig {
            id,
            name,
            dialect: input.dialect,
            host: input.host.trim().to_string(),
            port: input.port,
            user: input.user.clone(),
            database: input.database.clone().filter(|d| !d.is_empty()),
            ssl: input.ssl.clone(),
            group_id: input.group_id,
        }
    }

    fn require_group(&self, id: GroupId) -> Result<()> {
        if self.store()?.list_groups()?.iter().any(|g| g.id == id) {
            Ok(())
        } else {
            Err(Error::NotFound("group not found".into()))
        }
    }

    pub fn list(&self) -> Result<Vec<ConnectionConfig>> {
        self.store()?.list_connections()
    }

    pub async fn save(&self, input: ConnectionInput) -> Result<ConnectionConfig> {
        let name = Self::validate(&input)?;
        if let Some(group) = input.group_id {
            self.require_group(group)?;
        }
        let id = input.id.unwrap_or_else(Uuid::new_v4);
        let config = Self::config_from(id, name, &input);
        self.store()?.save_connection(&config)?;
        match &input.password {
            PasswordChange::Keep => {
                if input.id.is_none() {
                    self.secrets.delete(id)?;
                }
            }
            PasswordChange::Set { value } => self.secrets.set(id, value)?,
            PasswordChange::Clear => self.secrets.delete(id)?,
        }
        self.close_session(id).await?;
        Ok(config)
    }

    pub async fn delete(&self, id: ConnectionId) -> Result<()> {
        self.close_session(id).await?;
        self.secrets.delete(id)?;
        self.store()?.delete_connection(id)?;
        // An open that started during the delete must not outlive it.
        self.bump_generation(id)
    }

    /// Connects with the input's settings and returns the server version. Never saves.
    pub async fn test(&self, input: ConnectionInput) -> Result<String> {
        let name = Self::validate(&input)?;
        let id = input.id.unwrap_or_else(Uuid::new_v4);
        let config = Self::config_from(id, name, &input);
        let password = match &input.password {
            PasswordChange::Keep => match input.id {
                Some(id) => self.secrets.get(id)?,
                None => None,
            },
            PasswordChange::Set { value } => Some(value.clone()),
            PasswordChange::Clear => None,
        };
        let dialect = connect(&config, password.as_deref()).await?;
        let version = dialect.server_version().await;
        dialect.disconnect().await.ok();
        version
    }

    pub fn suggestions(&self) -> Result<Vec<SuggestedConnection>> {
        let saved = self.list()?;
        Ok(laragon_suggestions(&saved))
    }

    pub async fn open(&self, id: ConnectionId) -> Result<()> {
        self.open_with_hook(id, async {}).await
    }

    /// `open`, awaiting `after_connect` between connecting and registering the
    /// session. Exists so tests can interleave a save or delete deterministically.
    #[doc(hidden)]
    pub async fn open_with_hook(
        &self,
        id: ConnectionId,
        after_connect: impl Future<Output = ()>,
    ) -> Result<()> {
        if self.is_open(id) {
            return Ok(());
        }
        let generation = self.generation(id)?;
        let config = self
            .list()?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| Error::NotFound("connection not found".into()))?;
        let password = self.secrets.get(id)?;
        let session = connect(&config, password.as_deref()).await?;
        after_connect.await;
        // Keep the first session if a concurrent open won, and drop ours if the
        // Connection was saved, deleted or closed while we were connecting.
        let (extra, stale) = {
            let mut sessions = self.sessions.write().map_err(|_| poisoned())?;
            if self.generation(id)? != generation {
                (Some(session), true)
            } else {
                match sessions.entry(id) {
                    Entry::Vacant(slot) => {
                        slot.insert(session);
                        (None, false)
                    }
                    Entry::Occupied(_) => (Some(session), false),
                }
            }
        };
        if let Some(extra) = extra {
            extra.disconnect().await.ok();
        }
        if stale && !self.list()?.iter().any(|c| c.id == id) {
            return Err(Error::NotFound("connection not found".into()));
        }
        Ok(())
    }

    pub async fn close(&self, id: ConnectionId) -> Result<()> {
        self.close_session(id).await
    }

    pub async fn session(&self, id: ConnectionId) -> Result<Arc<dyn Dialect>> {
        self.sessions
            .read()
            .map_err(|_| poisoned())?
            .get(&id)
            .cloned()
            .ok_or_else(|| Error::NotFound("connection not open".into()))
    }

    pub fn is_open(&self, id: ConnectionId) -> bool {
        self.sessions
            .read()
            .map(|s| s.contains_key(&id))
            .unwrap_or(false)
    }

    pub fn list_groups(&self) -> Result<Vec<Group>> {
        self.store()?.list_groups()
    }

    pub fn save_group(&self, input: GroupInput) -> Result<Group> {
        let name = input.name.trim().to_string();
        if name.is_empty() {
            return Err(Error::InvalidInput("group name must not be empty".into()));
        }
        let store = self.store()?;
        let id = input.id.unwrap_or_else(Uuid::new_v4);
        let taken = store
            .list_groups()?
            .iter()
            .any(|g| g.id != id && g.name.to_lowercase() == name.to_lowercase());
        if taken {
            return Err(Error::InvalidInput(
                "a group with that name already exists".into(),
            ));
        }
        let group = Group {
            id,
            name,
            color: input.color,
        };
        store.save_group(&group)?;
        Ok(group)
    }

    pub fn delete_group(&self, id: GroupId) -> Result<()> {
        self.store()?.delete_group(id)
    }

    pub fn move_connection(
        &self,
        id: ConnectionId,
        group: Option<GroupId>,
    ) -> Result<ConnectionConfig> {
        if let Some(group) = group {
            self.require_group(group)?;
        }
        let store = self.store()?;
        let mut config = store
            .list_connections()?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| Error::NotFound("connection not found".into()))?;
        config.group_id = group;
        store.save_connection(&config)?;
        Ok(config)
    }

    pub fn last_group(&self) -> Result<Option<GroupId>> {
        let store = self.store()?;
        let Some(raw) = store.get_setting(LAST_GROUP_KEY)? else {
            return Ok(None);
        };
        let Ok(id) = raw.parse::<GroupId>() else {
            return Ok(None);
        };
        Ok(store
            .list_groups()?
            .iter()
            .any(|g| g.id == id)
            .then_some(id))
    }

    pub fn set_last_group(&self, id: Option<GroupId>) -> Result<()> {
        self.store()?.set_setting(
            LAST_GROUP_KEY,
            &id.map(|g| g.to_string()).unwrap_or_default(),
        )
    }
}
