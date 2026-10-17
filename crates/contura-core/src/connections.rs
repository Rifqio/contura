use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ai::AiAccess;
use crate::dialect::{Dialect, connect};
use crate::edits::{self, EditSet, PlannedEdit, TxOutcome};
use crate::error::{Error, Result, browse_result};
use crate::model::{
    ConnectionConfig, ConnectionId, DialectKind, Group, GroupColor, GroupId, ObjectPath,
    PageRequest, SslMode,
};
use crate::query::{
    ExecOutcome, Execution, HistoryEntry, HistoryFilter, MoreRows, NewHistory, Outcome,
    QuerySessionId, SavedQuery, SavedQueryInput, SessionHandle,
};
use crate::safety::{PassId, RunVerdict, StatementClass, classify, verdict};
use crate::secrets::SecretStore;
use crate::store::AppStore;
use crate::suggest::{SuggestedConnection, laragon_suggestions};
use std::time::{Duration, Instant};

const LAST_GROUP_KEY: &str = "last_group";
const QUERY_TABS_KEY: &str = "query_tabs:";

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
    #[serde(default)]
    pub file: Option<PathBuf>,
    #[serde(default)]
    pub query_timeout_secs: Option<u32>,
    #[serde(default)]
    pub ai_access: AiAccess,
    #[serde(default)]
    pub production: bool,
    #[serde(default)]
    pub read_only: bool,
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
    /// One per query tab, each with its own database connection.
    /// The third part is the database the session was opened on.
    query_sessions: Mutex<HashMap<QuerySessionId, QuerySlot>>,
    /// Confirm passes handed out by `confirm_run`, used up by `execute_sql`.
    passes: Mutex<HashMap<PassId, Pass>>,
    pass_ttl: Mutex<Duration>,
}

type QuerySlot = (ConnectionId, Arc<SessionHandle>, Option<String>);

/// One confirmed run: the Production writes it covers, by hash of their exact text.
struct Pass {
    scope: PassScope,
    remaining: Vec<u64>,
    expires: Instant,
}

/// What a pass was issued for. A pass never covers anything outside its scope.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PassScope {
    /// A run in one query tab.
    Query(QuerySessionId),
    /// A save of pending edits to one table.
    Edits(ConnectionId, ObjectPath),
}

/// The statements a save would run and what running them needs.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EditPlan {
    pub statements: Vec<String>,
    pub verdict: RunVerdict,
}

/// Rows a committed save changed.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EditOutcome {
    pub updated: u64,
    pub inserted: u64,
    pub deleted: u64,
}

const PASS_TTL: Duration = Duration::from_secs(120);

fn text_hash(sql: &str) -> u64 {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut h = DefaultHasher::new();
    sql.hash(&mut h);
    h.finish()
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
            query_sessions: Mutex::new(HashMap::new()),
            passes: Mutex::new(HashMap::new()),
            pass_ttl: Mutex::new(PASS_TTL),
        }
    }

    /// Lets tests make passes expire at once.
    #[cfg(any(test, feature = "test-util"))]
    pub fn set_pass_ttl_for_test(&self, ttl: Duration) {
        if let Ok(mut t) = self.pass_ttl.lock() {
            *t = ttl;
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
    /// The Connection's query sessions close too.
    async fn close_session(&self, id: ConnectionId) -> Result<()> {
        self.bump_generation(id)?;
        let handles: Vec<Arc<SessionHandle>> = {
            let mut qs = self.query_sessions.lock().map_err(|_| poisoned())?;
            let mine: Vec<QuerySessionId> = qs
                .iter()
                .filter(|(_, (conn, _, _))| *conn == id)
                .map(|(s, _)| *s)
                .collect();
            mine.iter()
                .filter_map(|s| qs.remove(s).map(|(_, h, _)| h))
                .collect()
        };
        close_all(handles).await;
        if let Some(session) = self.take_session(id)? {
            session.disconnect().await.ok();
        }
        Ok(())
    }

    fn query_slot(&self, s: QuerySessionId) -> Result<QuerySlot> {
        self.query_sessions
            .lock()
            .map_err(|_| poisoned())?
            .get(&s)
            .cloned()
            .ok_or_else(|| Error::NotFound("That query session is closed.".into()))
    }

    fn query_session(&self, s: QuerySessionId) -> Result<(ConnectionId, Arc<SessionHandle>)> {
        let (conn, handle, _) = self.query_slot(s)?;
        Ok((conn, handle))
    }

    /// Drops the session's passes, so a partly used one cannot cover a later run, and every
    /// expired pass.
    fn drop_passes(&self, scope: &PassScope) -> Result<()> {
        let now = Instant::now();
        self.passes
            .lock()
            .map_err(|_| poisoned())?
            .retain(|_, p| p.scope != *scope && p.expires > now);
        Ok(())
    }

    /// A pass for `scope` covering each of `writes` once; it replaces the scope's earlier passes.
    fn issue_pass(&self, scope: PassScope, writes: &[String]) -> Result<PassId> {
        let remaining = writes.iter().map(|t| text_hash(t)).collect();
        let ttl = *self.pass_ttl.lock().map_err(|_| poisoned())?;
        let now = Instant::now();
        let mut passes = self.passes.lock().map_err(|_| poisoned())?;
        passes.retain(|_, p| p.scope != scope && p.expires > now);
        let id = Uuid::new_v4();
        passes.insert(
            id,
            Pass {
                scope,
                remaining,
                expires: now + ttl,
            },
        );
        Ok(id)
    }

    /// What running these statements on the session needs: nothing, a block or a confirmation.
    /// A new run starts here, so the session's earlier passes end.
    pub fn prepare_run(&self, s: QuerySessionId, statements: Vec<String>) -> Result<RunVerdict> {
        let (conn, _, database) = self.query_slot(s)?;
        self.drop_passes(&PassScope::Query(s))?;
        let config = self.config(conn)?;
        let database = database.or_else(|| config.database.clone());
        Ok(verdict(&config, database.as_deref(), &statements))
    }

    /// Records the user's confirmation of the writes among `statements`. The pass covers
    /// each write once, by its exact text, for a limited time, and replaces the session's
    /// earlier passes.
    pub fn confirm_run(&self, s: QuerySessionId, statements: Vec<String>) -> Result<PassId> {
        let (conn, _, _) = self.query_slot(s)?;
        let dialect = self.config(conn)?.dialect;
        let writes: Vec<String> = statements
            .into_iter()
            .filter(|t| classify(dialect, t) == StatementClass::Write)
            .collect();
        self.issue_pass(PassScope::Query(s), &writes)
    }

    /// Applies Read-only and Production to statements before any reaches the server.
    /// Either the pass covers every write and gives them up, or nothing runs and the pass
    /// stays as it was. A save's pass must cover exactly the save's statements.
    fn authorize(
        &self,
        scope: &PassScope,
        config: &ConnectionConfig,
        statements: &[String],
        pass: Option<PassId>,
    ) -> Result<()> {
        if !config.read_only && !config.production {
            return Ok(());
        }
        let writes: Vec<(usize, &String)> = statements
            .iter()
            .enumerate()
            .filter(|(_, sql)| classify(config.dialect, sql) == StatementClass::Write)
            .collect();
        let Some((first, _)) = writes.first() else {
            return Ok(());
        };
        if config.read_only {
            return Err(Error::ReadOnly(*first));
        }
        let pass = pass.ok_or(Error::NeedsConfirmation)?;
        let mut passes = self.passes.lock().map_err(|_| poisoned())?;
        let p = passes.get_mut(&pass).ok_or(Error::NeedsConfirmation)?;
        if p.scope != *scope || p.expires <= Instant::now() {
            return Err(Error::NeedsConfirmation);
        }
        let mut remaining = p.remaining.clone();
        for (_, sql) in &writes {
            let hash = text_hash(sql);
            let at = remaining
                .iter()
                .position(|h| *h == hash)
                .ok_or(Error::NeedsConfirmation)?;
            remaining.swap_remove(at);
        }
        if matches!(scope, PassScope::Edits(..)) && !remaining.is_empty() {
            return Err(Error::NeedsConfirmation);
        }
        if remaining.is_empty() {
            passes.remove(&pass);
        } else {
            p.remaining = remaining;
        }
        Ok(())
    }

    /// The statements a save of `edits` runs, built from the table's current columns.
    async fn planned(
        &self,
        id: ConnectionId,
        config: &ConnectionConfig,
        edits: &EditSet,
    ) -> Result<Vec<PlannedEdit>> {
        let columns = self
            .session(id)
            .await?
            .fetch_page(&PageRequest {
                table: edits.table.clone(),
                page: 0,
                sort: None,
                filter: None,
            })
            .await?
            .columns;
        edits::plan_edits(config.dialect, &columns, edits)
    }

    /// The SQL a save would run, and whether it may run, needs a confirmation or is blocked.
    pub async fn plan_edits(&self, id: ConnectionId, edits: EditSet) -> Result<EditPlan> {
        let config = self.config(id)?;
        let statements: Vec<String> = self
            .planned(id, &config, &edits)
            .await?
            .into_iter()
            .map(|p| p.sql)
            .collect();
        let verdict = verdict(&config, Some(&edits.table.database), &statements);
        Ok(EditPlan {
            statements,
            verdict,
        })
    }

    /// Records the user's confirmation of a save on a Production Connection. The pass covers
    /// exactly these statements once, for a limited time, and replaces the table's earlier pass.
    pub async fn confirm_edits(&self, id: ConnectionId, edits: EditSet) -> Result<PassId> {
        let config = self.config(id)?;
        let writes: Vec<String> = self
            .planned(id, &config, &edits)
            .await?
            .into_iter()
            .map(|p| p.sql)
            .filter(|t| classify(config.dialect, t) == StatementClass::Write)
            .collect();
        self.issue_pass(PassScope::Edits(id, edits.table), &writes)
    }

    /// Runs a save in one transaction after the Read-only and Production checks, and records
    /// it in Query History. A row that changed since it was loaded rolls the whole save back.
    pub async fn apply_edits(
        &self,
        id: ConnectionId,
        edits: EditSet,
        pass: Option<PassId>,
    ) -> Result<EditOutcome> {
        let config = self.config(id)?;
        let plan = self.planned(id, &config, &edits).await?;
        let statements: Vec<String> = plan.iter().map(|p| p.sql.clone()).collect();
        let scope = PassScope::Edits(id, edits.table.clone());
        self.authorize(&scope, &config, &statements, pass)?;
        let session = self.session(id).await?;
        let ran_at_ms = now_ms();
        let started = Instant::now();
        let result = browse_result(
            session.apply_planned(&edits.table.database, &plan).await,
            config.read_only,
        )?;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let rows = match result {
            TxOutcome::Committed { rows } => rows,
            TxOutcome::RowCount { statement, .. } => {
                return Err(Error::RowChanged {
                    statement,
                    key: plan
                        .get(statement)
                        .map(|p| p.key.clone())
                        .unwrap_or_default(),
                });
            }
            TxOutcome::Failed { statement, message } => {
                return Err(Error::EditFailed { statement, message });
            }
        };
        // `plan_edits` orders the statements: deletes, then updates, then inserts.
        let sum = |from: usize, to: usize| -> u64 {
            rows.get(from.min(rows.len())..to.min(rows.len()))
                .map(|r| r.iter().sum())
                .unwrap_or(0)
        };
        let (d, u) = (edits.deletes.len(), edits.updates.len());
        let outcome = EditOutcome {
            deleted: sum(0, d),
            updated: sum(d, d + u),
            inserted: sum(d + u, rows.len()),
        };
        // History is a record, not part of the save: a store failure must not hide the result.
        if let Ok(store) = self.store() {
            let _ = store.add_history(&NewHistory {
                connection_id: id,
                sql: statements.join(";\n"),
                ran_at_ms,
                elapsed_ms,
                outcome: Outcome::Ok,
                rows: Some(rows.iter().sum()),
                changed: true,
                error: None,
            });
        }
        Ok(outcome)
    }

    fn config(&self, id: ConnectionId) -> Result<ConnectionConfig> {
        self.list()?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| Error::NotFound("connection not found".into()))
    }

    fn validate(input: &ConnectionInput) -> Result<String> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err(Error::InvalidInput("name must not be empty".into()));
        }
        match input.dialect {
            DialectKind::Sqlite => {
                let blank = input
                    .file
                    .as_ref()
                    .is_none_or(|f| f.as_os_str().to_string_lossy().trim().is_empty());
                if blank {
                    return Err(Error::InvalidInput("choose a SQLite file".into()));
                }
            }
            DialectKind::MySql | DialectKind::Postgres => {
                if input.host.trim().is_empty() {
                    return Err(Error::InvalidInput("host must not be empty".into()));
                }
                if input.port == 0 {
                    return Err(Error::InvalidInput("port must be from 1 to 65535".into()));
                }
            }
        }
        Ok(name.to_string())
    }

    fn config_from(id: ConnectionId, name: String, input: &ConnectionInput) -> ConnectionConfig {
        if input.dialect == DialectKind::Sqlite {
            return ConnectionConfig {
                id,
                name,
                dialect: input.dialect,
                host: String::new(),
                port: 0,
                user: String::new(),
                database: None,
                ssl: SslMode::Disable,
                group_id: input.group_id,
                file: input.file.clone(),
                query_timeout_secs: input.query_timeout_secs.filter(|s| *s > 0),
                ai_access: input.ai_access,
                production: input.production,
                read_only: input.read_only,
            };
        }
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
            file: None,
            query_timeout_secs: input.query_timeout_secs.filter(|s| *s > 0),
            ai_access: input.ai_access,
            production: input.production,
            read_only: input.read_only,
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
        let mut config = Self::config_from(id, name, &input);
        {
            let store = self.store()?;
            let was_production = store
                .list_connections()?
                .iter()
                .any(|c| c.id == id && c.production);
            if config.production && !was_production {
                config.ai_access = AiAccess::Never;
            }
            store.save_connection(&config)?;
        }
        // A SQLite file has no password, so nothing may be stored for it.
        let change = if input.dialect == DialectKind::Sqlite {
            &PasswordChange::Clear
        } else {
            &input.password
        };
        match change {
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

    /// Rewrites only the Connection's AI access. Sessions, open transactions and the
    /// password are left alone, since the setting never reaches the database.
    pub async fn set_ai_access(
        &self,
        id: ConnectionId,
        access: AiAccess,
    ) -> Result<ConnectionConfig> {
        let store = self.store()?;
        let mut config = store
            .list_connections()?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| Error::NotFound("connection not found".into()))?;
        config.ai_access = access;
        store.save_connection(&config)?;
        Ok(config)
    }

    pub async fn delete(&self, id: ConnectionId) -> Result<()> {
        self.close_session(id).await?;
        self.secrets.delete(id)?;
        self.store()?.delete_connection(id)?;
        self.store()?.clear_history(id)?;
        // An open that started during the delete must not outlive it.
        self.bump_generation(id)
    }

    /// Connects with the input's settings and returns the server version. Never saves.
    pub async fn test(&self, input: ConnectionInput) -> Result<String> {
        let name = Self::validate(&input)?;
        let id = input.id.unwrap_or_else(Uuid::new_v4);
        let config = Self::config_from(id, name, &input);
        let password = match &input.password {
            _ if input.dialect == DialectKind::Sqlite => None,
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

    /// A query tab's own session on an open Connection.
    pub async fn open_query_session(
        &self,
        id: ConnectionId,
        database: Option<String>,
    ) -> Result<QuerySessionId> {
        self.open_query_session_with_hook(id, database, async {})
            .await
    }

    /// `open_query_session`, awaiting `after_open` between opening and registering the
    /// session. Exists so tests can interleave a save deterministically.
    #[doc(hidden)]
    pub async fn open_query_session_with_hook(
        &self,
        id: ConnectionId,
        database: Option<String>,
        after_open: impl Future<Output = ()>,
    ) -> Result<QuerySessionId> {
        let generation = self.generation(id)?;
        let dialect = self.session(id).await?;
        let handle = dialect.open_query_session(database.as_deref()).await?;
        after_open.await;
        let s = Uuid::new_v4();
        // A save, delete or close meanwhile already closed the Connection's sessions, and
        // this one was opened with the old settings.
        {
            let mut qs = self.query_sessions.lock().map_err(|_| poisoned())?;
            if self.generation(id)? == generation {
                qs.insert(s, (id, Arc::new(handle), database));
                return Ok(s);
            }
        }
        close_handle(&handle).await;
        Err(Error::NotFound("connection not open".into()))
    }

    /// Runs one statement, applying the Connection's timeout, and records it in Query History.
    /// Read-only and Production are enforced first; a blocked statement is not recorded.
    pub async fn execute_sql(
        &self,
        s: QuerySessionId,
        sql: String,
        pass: Option<PassId>,
    ) -> Result<Execution> {
        let (conn, handle) = self.query_session(s)?;
        let config = self.config(conn)?;
        self.authorize(
            &PassScope::Query(s),
            &config,
            std::slice::from_ref(&sql),
            pass,
        )?;
        let timeout = config.query_timeout_secs;
        let ran_at_ms = now_ms();
        let started = Instant::now();
        let result = {
            let run = handle.execute(&sql);
            tokio::pin!(run);
            match timeout {
                None => run.await,
                Some(secs) => {
                    match tokio::time::timeout(Duration::from_secs(secs.into()), &mut run).await {
                        Ok(r) => r,
                        Err(_) => {
                            handle.cancel().await.ok();
                            // Let the server stop it before the next statement can start.
                            let _ = tokio::time::timeout(CLOSE_WAIT, &mut run).await;
                            Err(Error::TimedOut(secs))
                        }
                    }
                }
            }
        };
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let (outcome, rows, changed, error) = match &result {
            Ok(ExecOutcome::Rows { rows, .. }) => {
                (Outcome::Ok, Some(rows.len() as u64), false, None)
            }
            Ok(ExecOutcome::Affected { rows }) => (Outcome::Ok, Some(*rows), true, None),
            Err(Error::Cancelled) => (Outcome::Cancelled, None, false, None),
            Err(Error::TimedOut(_)) => (Outcome::TimedOut, None, false, None),
            Err(e) => (Outcome::Error, None, false, Some(plain_message(e))),
        };
        // History is a record, not part of the run: a store failure must not hide the result.
        if let Ok(store) = self.store() {
            let _ = store.add_history(&NewHistory {
                connection_id: conn,
                sql,
                ran_at_ms,
                elapsed_ms,
                outcome,
                rows,
                changed,
                error,
            });
        }
        result.map(|outcome| Execution {
            outcome,
            elapsed_ms,
        })
    }

    pub async fn fetch_more_rows(&self, s: QuerySessionId) -> Result<MoreRows> {
        self.query_session(s)?.1.fetch_more().await
    }

    pub async fn cancel_query(&self, s: QuerySessionId) -> Result<()> {
        self.query_session(s)?.1.cancel().await
    }

    pub async fn close_query_result(&self, s: QuerySessionId) -> Result<()> {
        self.query_session(s)?.1.close_result().await
    }

    /// Stops every running query, such as when the app closes. Sessions stay open.
    pub async fn cancel_all_queries(&self) {
        let busy: Vec<Arc<SessionHandle>> = match self.query_sessions.lock() {
            Ok(qs) => qs
                .values()
                .map(|(_, h, _)| h.clone())
                .filter(|h| h.is_busy())
                .collect(),
            Err(_) => return,
        };
        let tasks: Vec<_> = busy
            .into_iter()
            .map(|h| {
                tokio::spawn(async move { tokio::time::timeout(CANCEL_WAIT, h.cancel()).await })
            })
            .collect();
        for t in tasks {
            let _ = t.await;
        }
    }

    pub async fn close_query_session(&self, s: QuerySessionId) -> Result<()> {
        let removed = self
            .query_sessions
            .lock()
            .map_err(|_| poisoned())?
            .remove(&s);
        if let Some((_, h, _)) = removed {
            close_handle(&h).await;
        }
        Ok(())
    }

    pub fn query_history(
        &self,
        id: ConnectionId,
        filter: HistoryFilter,
    ) -> Result<Vec<HistoryEntry>> {
        self.store()?.query_history(id, &filter)
    }

    pub fn clear_query_history(&self, id: ConnectionId) -> Result<()> {
        self.store()?.clear_history(id)
    }

    pub fn list_saved_queries(&self) -> Result<Vec<SavedQuery>> {
        self.store()?.list_saved_queries()
    }

    pub fn save_saved_query(&self, input: SavedQueryInput) -> Result<SavedQuery> {
        let name = input.name.trim().to_string();
        if name.is_empty() {
            return Err(Error::InvalidInput("Give the query a name.".into()));
        }
        let q = SavedQuery {
            id: input.id.unwrap_or_else(Uuid::new_v4),
            name,
            sql: input.sql,
            updated_at_ms: now_ms(),
        };
        self.store()?.save_saved_query(&q)?;
        Ok(q)
    }

    pub fn delete_saved_query(&self, id: Uuid) -> Result<()> {
        self.store()?.delete_saved_query(id)
    }

    /// The query tab drafts of a place (`group:<id>` or `ungrouped`), as the UI wrote them.
    pub fn load_query_tabs(&self, place: String) -> Result<Option<String>> {
        self.store()?
            .get_setting(&format!("{QUERY_TABS_KEY}{place}"))
    }

    pub fn save_query_tabs(&self, place: String, json: String) -> Result<()> {
        self.store()?
            .set_setting(&format!("{QUERY_TABS_KEY}{place}"), &json)
    }
}

/// How long cancel_all_queries waits for each cancel to reach its server.
const CANCEL_WAIT: Duration = Duration::from_secs(2);

/// How long closing or a timed-out run waits for the server to stop.
const CLOSE_WAIT: Duration = Duration::from_secs(5);

async fn close_handle(h: &SessionHandle) {
    // A running statement would hold the close up; stop it first.
    if h.is_busy() {
        h.cancel().await.ok();
    }
    if tokio::time::timeout(CLOSE_WAIT, h.close()).await.is_err() {
        h.cancel().await.ok();
    }
}

/// Closes sessions side by side, so several busy tabs do not add up their waits.
async fn close_all(handles: Vec<Arc<SessionHandle>>) {
    let tasks: Vec<_> = handles
        .into_iter()
        .map(|h| tokio::spawn(async move { close_handle(&h).await }))
        .collect();
    for t in tasks {
        let _ = t.await;
    }
}
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The server's words, without the "query failed:" prefix the error's Display adds.
fn plain_message(e: &Error) -> String {
    match e {
        Error::Query(m) | Error::InvalidInput(m) | Error::NotFound(m) | Error::Connect(m) => {
            m.clone()
        }
        other => other.to_string(),
    }
}
