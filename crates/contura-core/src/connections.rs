use std::collections::hash_map::Entry;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ai::AiAccess;
use crate::ai::AiThread;
use crate::ai::context::store::ContextStore;
use crate::ai::preview::CatalogReader;
use crate::ai::rails::output::{Flag, StatementCheck, risky_anywhere};
use crate::ai::sent::fnv1a64;
use crate::common::sql_table;
use crate::design::{
    self, DesignOutcome, DesignPlan, DesignRequest, DesignTarget, DesignWarning, RowCount,
    TableDesign,
};
use crate::dialect::{Dialect, connect};
use crate::edits::{self, EditSet, PlannedEdit, TxOutcome};
use crate::error::{Error, Result, browse_result};
use crate::explain::{Plan, explain_sql, plan_from_rows};
use crate::jobs::paths::{PathUse, check_user_path};
use crate::jobs::{FileIdentity, JobService};
use crate::model::{
    AiSyncMode, Cell, ConnectionConfig, ConnectionId, DialectKind, EditorPrefs, GROUP_IMAGE_MAX,
    Group, GroupColor, GroupId, KeymapOverrides, ObjectPath, PageRequest, RowHeight, SslMode,
    UiPrefs,
};
use crate::query::{
    ExecOutcome, Execution, HistoryEntry, HistoryFilter, MoreRows, NewHistory, Outcome,
    QuerySessionId, SavedQuery, SavedQueryInput, SavedQueryKind, SavedQueryRun, SessionHandle,
};
use crate::recent::{RecentItem, RecentTarget, merge_restored, push_recent};
use crate::safety::{
    AssistantSql, PassId, RunVerdict, StatementClass, classify, is_ddl, leading_word, run_class,
    split_statements, statement_count, verdict, verdict_with,
};
use crate::secrets::SecretStore;
use crate::store::AppStore;
use crate::suggest::{SuggestedConnection, laragon_suggestions};
use crate::visual_query::{self, ColumnTypes, VisualQuery, VqPreview, VqRun};
use std::time::{Duration, Instant};

mod ai_context;
mod backup;
mod compare;
mod export;
mod import;
mod restore;
mod script;
mod transfer;
pub use backup::non_snapshot_note;
pub use compare::{
    CompareDatabase, CompareRequest, CompareResult, CompareSide, DdlPair, SyncOutcome,
};
pub use transfer::TARGET_CHANGED;

const LAST_GROUP_KEY: &str = "last_group";
const UI_PREFS_KEY: &str = "ui_prefs";
const KEYMAP_KEY: &str = "keymap";
const KNOWN_EDITOR_FAMILIES: [&str; 3] = ["JetBrains Mono", "Cascadia Mono", "Consolas"];
const RECENT_ITEMS_KEY: &str = "recent_items";
const QUERY_TABS_KEY: &str = "query_tabs:";
const SAVED_QUERY_CONNECTIONS_KEY: &str = "saved_query_connections";
const CONNECTION_OPENED_KEY: &str = "connection_opened";
const DAY_MS: i64 = 86_400_000;

/// The server version a Visual Query is written for, without a round trip (D3): only
/// SQLite's matters (RIGHT and FULL JOIN), and that is the bundled library's.
fn server_version(kind: DialectKind) -> &'static str {
    match kind {
        DialectKind::Sqlite => rusqlite::version(),
        DialectKind::MySql | DialectKind::Postgres => "",
    }
}

/// What the data folder holds, for Settings.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DataFolderInfo {
    pub path: Option<PathBuf>,
    pub connections: u32,
    pub groups: u32,
    pub saved_queries: u32,
    pub history_bytes: u64,
}

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
    /// None keeps the stored mode; a new Connection gets Automatically.
    #[serde(default)]
    pub ai_sync: Option<AiSyncMode>,
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

const PNG_SIGNATURE: &[u8] = &[0x89, b'P', b'N', b'G', 13, 10, 26, 10];

fn too_large() -> Error {
    Error::InvalidInput("the image is larger than 256 KB".into())
}

/// Decodes a Group image sent as base64, refusing oversize text before decoding.
pub fn decode_group_image(text: &str) -> Result<Vec<u8>> {
    if text.len() > GROUP_IMAGE_MAX / 3 * 4 + 4 {
        return Err(too_large());
    }
    crate::model_files::decode_base64(text)
}

fn remove_if_present(path: &std::path::Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(Error::Store(e.to_string())),
    }
}

/// Owns the saved Connections, Groups and the open sessions. The store lock is
/// never held across an `.await`.
pub struct ConnectionService {
    store: Arc<Mutex<AppStore>>,
    secrets: Arc<dyn SecretStore>,
    /// The import and export jobs (D3); it shares the store for history entries.
    jobs: Arc<JobService>,
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
    /// R6.3: the statements of answers, by hash, for every Connection: SQL from an Ask on
    /// one Connection (or none) can be run on another. Memory only; stored answers are
    /// registered again when their threads load.
    ai_sql: Mutex<AiSqlRegister>,
    /// One AI Context check or build at a time per Context, and the failure back-off.
    context_gates: crate::ai::context::sync::ContextGates,
    data_dir: Option<PathBuf>,
}

/// How many flagged statements the register keeps; plain ones cannot push them out.
const AI_SQL_FLAGGED: usize = 1024;
/// How many unflagged statements it keeps, for the "Written by the assistant" tag.
const AI_SQL_PLAIN: usize = 256;

/// The AI SQL register: flagged and plain statement hashes, each oldest first.
#[derive(Default)]
struct AiSqlRegister {
    flagged: VecDeque<u64>,
    plain: VecDeque<u64>,
}

impl AiSqlRegister {
    /// Adds `hash`; a statement once flagged stays flagged (a later unflagged text with
    /// the same hash never clears it).
    fn add(&mut self, hash: u64, flagged: bool) {
        let push = |list: &mut VecDeque<u64>, cap: usize| {
            list.retain(|h| *h != hash);
            list.push_back(hash);
            while list.len() > cap {
                list.pop_front();
            }
        };
        if flagged || self.flagged.contains(&hash) {
            self.plain.retain(|h| *h != hash);
            push(&mut self.flagged, AI_SQL_FLAGGED);
        } else {
            push(&mut self.plain, AI_SQL_PLAIN);
        }
    }

    fn get(&self, hash: u64) -> Option<AssistantSql> {
        if self.flagged.contains(&hash) {
            Some(AssistantSql { flagged: true })
        } else {
            self.plain
                .contains(&hash)
                .then_some(AssistantSql { flagged: false })
        }
    }
}

/// The register's hash of a statement: whitespace runs collapsed to one space, trimmed,
/// a final `;` dropped. Any other edit gives another hash (R6.6).
fn ai_sql_hash(text: &str) -> u64 {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let body = joined.strip_suffix(';').unwrap_or(&joined).trim_end();
    fnv1a64(body.as_bytes())
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
    /// A design of one table: the table changed, created or dropped.
    Design(ConnectionId, ObjectPath),
    /// One import or script job on a Connection, bound to its fingerprint (D5): the
    /// request, the mapping, the template and the file, exactly as confirmed.
    Job(ConnectionId, [u8; 32]),
    /// One Sync Script on the target database (and schema; `name` is empty): it
    /// covers exactly the script's statements, once (step 10).
    Sync(ConnectionId, ObjectPath),
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

/// A design plan and what applying it needs.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesignVerdict {
    pub plan: DesignPlan,
    pub verdict: RunVerdict,
}

/// The Query History entry an applied design leaves.
#[derive(Debug, PartialEq, Eq)]
struct DesignHistory {
    sql: String,
    outcome: Outcome,
    error: Option<String>,
}

/// What a design's run puts in Query History: the whole plan when it ran to the
/// end; on MySQL only the statements already committed before one failed (D12);
/// the whole plan when the change was applied but a closing statement failed;
/// nothing when nothing was changed, and nothing for a plan with no statements.
fn design_history(statements: &[String], result: &Result<DesignOutcome>) -> Option<DesignHistory> {
    if statements.is_empty() {
        return None;
    }
    match result {
        Ok(DesignOutcome::Done { .. }) => Some(DesignHistory {
            sql: statements.join(";\n"),
            outcome: Outcome::Ok,
            error: None,
        }),
        Ok(DesignOutcome::Failed { ran, message, .. }) if *ran > 0 => Some(DesignHistory {
            sql: statements[..(*ran).min(statements.len())].join(";\n"),
            outcome: Outcome::Error,
            error: Some(message.clone()),
        }),
        Err(e @ Error::DesignRestoreFailed { applied: true, .. }) => Some(DesignHistory {
            sql: statements.join(";\n"),
            outcome: Outcome::Error,
            error: Some(e.to_string()),
        }),
        _ => None,
    }
}

/// Where a Drop's row count stops (D5).
const DROP_COUNT_LIMIT: u64 = 10_000;

/// The table a design request changes, creates or drops.
fn design_path(req: &DesignRequest) -> &ObjectPath {
    match &req.target {
        DesignTarget::Alter { base } | DesignTarget::Drop { base } => &base.path,
        DesignTarget::Create { path } => path,
    }
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

/// Whether two configs of a Connection point at the same server, database or file, so an
/// AI Context built through one is the other's too.
pub(crate) fn same_target(a: &ConnectionConfig, b: &ConnectionConfig) -> bool {
    (&a.dialect, &a.host, a.port, &a.database, &a.file)
        == (&b.dialect, &b.host, b.port, &b.database, &b.file)
}

impl ConnectionService {
    pub fn new(store: AppStore, secrets: Arc<dyn SecretStore>) -> Self {
        let store = Arc::new(Mutex::new(store));
        let svc = Self {
            jobs: Arc::new(JobService::new(store.clone())),
            store,
            secrets,
            sessions: RwLock::new(HashMap::new()),
            generations: Mutex::new(HashMap::new()),
            query_sessions: Mutex::new(HashMap::new()),
            passes: Mutex::new(HashMap::new()),
            pass_ttl: Mutex::new(PASS_TTL),
            ai_sql: Mutex::new(AiSqlRegister::default()),
            context_gates: Default::default(),
            data_dir: None,
        };
        let _ = svc.prune_history_by_prefs();
        svc
    }

    /// Records where the data folder is, for Settings.
    pub fn with_data_dir(mut self, dir: PathBuf) -> Self {
        self.data_dir = Some(dir);
        self
    }

    /// Drops history older than the kept days; Forever keeps everything.
    fn prune_history_by_prefs(&self) -> Result<()> {
        if let Some(days) = self.ui_prefs()?.history_keep_days {
            self.store()?
                .prune_history(now_ms() - i64::from(days) * DAY_MS)?;
        }
        Ok(())
    }

    fn setting_map<T: serde::de::DeserializeOwned>(&self, key: &str) -> Result<HashMap<String, T>> {
        Ok(self
            .store()?
            .get_setting(key)?
            .and_then(|r| serde_json::from_str(&r).ok())
            .unwrap_or_default())
    }

    fn save_setting_map<T: Serialize>(&self, key: &str, map: &HashMap<String, T>) -> Result<()> {
        let json = serde_json::to_string(map).map_err(|e| Error::Store(e.to_string()))?;
        self.store()?.set_setting(key, &json)
    }

    pub fn data_folder_info(&self) -> Result<DataFolderInfo> {
        let store = self.store()?;
        Ok(DataFolderInfo {
            path: self.data_dir.clone(),
            connections: store.list_connections()?.len() as u32,
            groups: store.list_groups()?.len() as u32,
            saved_queries: store.list_saved_queries()?.len() as u32,
            history_bytes: store.history_bytes()?,
        })
    }

    /// Lets tests make passes expire at once.
    #[cfg(any(test, feature = "test-util"))]
    pub fn set_pass_ttl_for_test(&self, ttl: Duration) {
        if let Ok(mut t) = self.pass_ttl.lock() {
            *t = ttl;
        }
    }

    /// Connects through the data-folder guard: a SQLite Connection can never open
    /// app.sqlite or any other file in Contura's data folder (Q33). Every connection the
    /// service makes from a config goes through here.
    async fn connect_checked(
        &self,
        config: &ConnectionConfig,
        password: Option<&str>,
    ) -> Result<Arc<dyn Dialect>> {
        if config.dialect == DialectKind::Sqlite
            && let Some(file) = &config.file
        {
            // Without the data folder the guard cannot check the file: it fails closed.
            let data = self.data_dir.as_deref().ok_or_else(|| {
                Error::InvalidInput(
                    "Contura cannot find its data folder, so it cannot open this file.".into(),
                )
            })?;
            check_user_path(file, data, PathUse::Database)?;
        }
        connect(config, password).await
    }

    pub fn jobs(&self) -> &Arc<JobService> {
        &self.jobs
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
    /// The Connection's query sessions close too, and its jobs are cancelled.
    async fn close_session(&self, id: ConnectionId) -> Result<()> {
        self.bump_generation(id)?;
        self.jobs.cancel_on(id).await;
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

    /// A Production pass for one job (D5): it covers exactly the job whose fingerprint is
    /// `fingerprint`, once, for a limited time, and replaces the job's earlier pass. The
    /// file it was confirmed for is kept with the Job service, so start can tell a file
    /// that changed since.
    pub(crate) fn issue_job_pass(
        &self,
        id: ConnectionId,
        fingerprint: [u8; 32],
        file: Option<FileIdentity>,
    ) -> Result<PassId> {
        let scope = PassScope::Job(id, fingerprint);
        // The passes `issue_pass` drops (this job's earlier one, and expired ones) take
        // their confirmed files with them.
        let now = Instant::now();
        let dropped: Vec<PassId> = self
            .passes
            .lock()
            .map_err(|_| poisoned())?
            .iter()
            .filter(|(_, p)| p.scope == scope || p.expires <= now)
            .map(|(id, _)| *id)
            .collect();
        let pass = self.issue_pass(scope, &[])?;
        for old in dropped {
            self.jobs.forget_file(old);
        }
        if let Some(file) = file {
            self.jobs.confirm_file(pass, file);
        }
        Ok(pass)
    }

    /// Applies Read-only and Production to a job before anything opens (D5). A plain
    /// Connection needs nothing. A Read-only one is refused as `ReadOnly(0)`, whatever
    /// the job holds and even when it is also Production. A Production one needs an
    /// unexpired pass issued for exactly `Job(config.id, fingerprint)`, and uses it up;
    /// any other pass, or none, is `NeedsConfirmation` and leaves the pass as it was.
    pub(crate) fn authorize_job(
        &self,
        config: &ConnectionConfig,
        fingerprint: [u8; 32],
        pass: Option<PassId>,
    ) -> Result<()> {
        if config.read_only {
            return Err(Error::ReadOnly(0));
        }
        if !config.production {
            return Ok(());
        }
        let pass = pass.ok_or(Error::NeedsConfirmation)?;
        let mut passes = self.passes.lock().map_err(|_| poisoned())?;
        let p = passes.get(&pass).ok_or(Error::NeedsConfirmation)?;
        if p.scope != PassScope::Job(config.id, fingerprint) || p.expires <= Instant::now() {
            return Err(Error::NeedsConfirmation);
        }
        passes.remove(&pass);
        Ok(())
    }

    /// Keeps the statements of an answer in the AI SQL register (R6.3), newest last. Each
    /// statement is also checked for risky calls in every Dialect, as on reload, since the
    /// Ask's Dialect may not be the one it runs on.
    pub fn register_ai_sql(&self, statements: &[StatementCheck]) {
        let mut register = self.ai_sql.lock().unwrap_or_else(|e| e.into_inner());
        for st in statements {
            let flagged = st.flags.iter().any(Flag::escalates) || risky_anywhere(&st.text);
            register.add(ai_sql_hash(&st.text), flagged);
        }
    }

    /// Registers the SQL of every stored answer in `threads` again, as they load: the
    /// register is memory only, and a stored answer can still be inserted and run. A stored
    /// flag is kept, and each statement is checked again for risky calls, so a record
    /// edited on disk cannot drop one.
    pub fn register_ai_threads(&self, threads: &[AiThread]) {
        let mut register = self.ai_sql.lock().unwrap_or_else(|e| e.into_inner());
        let records = threads
            .iter()
            .flat_map(|t| &t.messages)
            .filter_map(|m| m.record.as_ref());
        for st in records
            .flat_map(|r| &r.sql_blocks)
            .flat_map(|b| &b.statements)
        {
            let flagged = st.flags.iter().any(Flag::escalates) || risky_anywhere(&st.text);
            register.add(ai_sql_hash(&st.text), flagged);
        }
    }

    /// The register's entry for `text`: the whole text, or any statement in it as
    /// `split_statements` reads it, so text holding several statements cannot slip past.
    /// Flagged when any of them is flagged.
    fn assistant_sql(&self, dialect: DialectKind, text: &str) -> Option<AssistantSql> {
        let register = self.ai_sql.lock().unwrap_or_else(|e| e.into_inner());
        let pieces = split_statements(dialect, text);
        let found: Vec<AssistantSql> = std::iter::once(text)
            .chain(pieces.into_iter().map(|r| &text[r]))
            .filter_map(|t| register.get(ai_sql_hash(t)))
            .collect();
        let flagged = found.iter().any(|a| a.flagged);
        (!found.is_empty()).then_some(AssistantSql { flagged })
    }

    /// What running these statements on the session needs: nothing, a block or a confirmation.
    /// A new run starts here, so the session's earlier passes end.
    pub fn prepare_run(&self, s: QuerySessionId, statements: Vec<String>) -> Result<RunVerdict> {
        let (conn, _, database) = self.query_slot(s)?;
        self.drop_passes(&PassScope::Query(s))?;
        let config = self.config(conn)?;
        let database = database.or_else(|| config.database.clone());
        Ok(verdict_with(
            &config,
            database.as_deref(),
            &statements,
            &|t| self.assistant_sql(config.dialect, t),
        ))
    }

    /// Records the user's confirmation of the writes among `statements`. The pass covers
    /// each write once, by its exact text, for a limited time, and replaces the session's
    /// earlier passes.
    pub fn confirm_run(&self, s: QuerySessionId, statements: Vec<String>) -> Result<PassId> {
        let (conn, _, _) = self.query_slot(s)?;
        let config = self.config(conn)?;
        let writes: Vec<String> = statements
            .into_iter()
            .filter(|t| {
                run_class(&config, t, self.assistant_sql(config.dialect, t))
                    == StatementClass::Write
            })
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
        // Only a query tab runs answer SQL, so only its runs consult the register (R6.4).
        let query = matches!(scope, PassScope::Query(_));
        let writes: Vec<(usize, &String)> = statements
            .iter()
            .enumerate()
            .filter(|(_, sql)| {
                let mine = query
                    .then(|| self.assistant_sql(config.dialect, sql))
                    .flatten();
                run_class(config, sql, mine) == StatementClass::Write
            })
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
        // A design or Sync pass covers every statement of the plan, its checks included.
        let exact = matches!(scope, PassScope::Design(..) | PassScope::Sync(..));
        let covered: Vec<&String> = if exact {
            statements.iter().collect()
        } else {
            writes.iter().map(|(_, sql)| *sql).collect()
        };
        let mut remaining = p.remaining.clone();
        for sql in covered {
            let hash = text_hash(sql);
            let at = remaining
                .iter()
                .position(|h| *h == hash)
                .ok_or(Error::NeedsConfirmation)?;
            remaining.swap_remove(at);
        }
        if (exact || matches!(scope, PassScope::Edits(..))) && !remaining.is_empty() {
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

    /// The table as the Table Designer loads it.
    pub async fn table_design(&self, id: ConnectionId, path: ObjectPath) -> Result<TableDesign> {
        self.session(id).await?.table_design(&path).await
    }

    /// The tables around `path`, `depth` steps each way (0 is All, up to 300 tables, at
    /// most 10s), from catalog details only: one key read and one light column read per
    /// database or schema reached, and no row is read (B2, P6).
    pub async fn lineage(
        &self,
        id: ConnectionId,
        path: ObjectPath,
        depth: u8,
        direction: crate::lineage::Direction,
    ) -> Result<crate::lineage::Lineage> {
        let fold = self.config(id)?.dialect == DialectKind::Sqlite;
        let source = crate::lineage::DialectKeys(self.session(id).await?);
        crate::lineage::walk(
            &source,
            path,
            depth,
            direction,
            fold,
            crate::lineage::DEADLINE,
        )
        .await
    }

    /// Lineage's Views source: the views the catalog records as reading `path`, at most
    /// `MAX_VIEWS` (one catalog read, bound parameters, no rows). `catalog` is false when
    /// the server keeps no such record (SQLite, MySQL before 8.0.13).
    pub async fn view_dependencies(
        &self,
        id: ConnectionId,
        path: ObjectPath,
    ) -> Result<crate::lineage::ViewDependencies> {
        use crate::lineage::{MAX_VIEWS, ViewDependencies};
        let found = self
            .session(id)
            .await?
            .view_dependencies(&path, MAX_VIEWS + 1)
            .await?;
        Ok(match found {
            None => ViewDependencies {
                catalog: false,
                views: Vec::new(),
                capped: false,
            },
            Some(mut views) => {
                let capped = views.len() > MAX_VIEWS;
                views.truncate(MAX_VIEWS);
                ViewDependencies {
                    catalog: true,
                    views,
                    capped,
                }
            }
        })
    }

    /// The table's CREATE statements for copying, as the server holds the table (D14).
    pub async fn table_ddl(&self, id: ConnectionId, path: ObjectPath) -> Result<String> {
        self.session(id).await?.table_ddl(&path).await
    }

    /// The table's rows, counted up to just past the limit on a session of its own;
    /// `None` when the count could not run, so the Drop warning shows no figure.
    async fn drop_row_count(
        &self,
        id: ConnectionId,
        kind: DialectKind,
        path: &ObjectPath,
    ) -> Option<RowCount> {
        let sql = format!(
            "SELECT COUNT(*) FROM (SELECT 1 FROM {} LIMIT {}) x",
            sql_table(kind, path).ok()?,
            DROP_COUNT_LIMIT + 1
        );
        let handle = self
            .session(id)
            .await
            .ok()?
            .open_query_session(Some(&path.database))
            .await
            .ok()?;
        let result = handle.execute(&sql).await;
        close_handle(&handle).await;
        let ExecOutcome::Rows { rows, .. } = result.ok()? else {
            return None;
        };
        let n: u64 = match rows.first()?.first()? {
            Cell::Number { value } | Cell::Text { value, .. } => value.trim().parse().ok()?,
            _ => return None,
        };
        Some(if n > DROP_COUNT_LIMIT {
            RowCount::Over {
                n: DROP_COUNT_LIMIT,
            }
        } else {
            RowCount::Exact { n }
        })
    }

    /// The DDL a design runs, its warnings, and whether it may run, needs a
    /// confirmation or is blocked. A Drop's warning carries a bounded row count (D5).
    pub async fn plan_design(&self, id: ConnectionId, req: DesignRequest) -> Result<DesignVerdict> {
        let config = self.config(id)?;
        let mut plan = design::plan_design(config.dialect, &req)?;
        if let DesignTarget::Drop { base } = &req.target {
            let count = self.drop_row_count(id, config.dialect, &base.path).await;
            for w in &mut plan.warnings {
                if let DesignWarning::DropTable { rows, .. } = w {
                    *rows = count;
                }
            }
        }
        let verdict = verdict(&config, Some(&design_path(&req).database), &plan.statements);
        Ok(DesignVerdict { plan, verdict })
    }

    /// Records the user's confirmation of a design on a Production Connection. The pass
    /// covers exactly this plan's statements, its checks included, once, for a limited
    /// time, and replaces the table's earlier design pass.
    pub async fn confirm_design(&self, id: ConnectionId, req: DesignRequest) -> Result<PassId> {
        let config = self.config(id)?;
        let plan = design::plan_design(config.dialect, &req)?;
        self.issue_pass(
            PassScope::Design(id, design_path(&req).clone()),
            &plan.statements,
        )
    }

    /// Runs a design after the Read-only and Production checks. A plan that ran to the
    /// end is one Query History entry; so are the statements MySQL already committed
    /// before one failed (D12). A failure that rolled back records nothing.
    pub async fn apply_design(
        &self,
        id: ConnectionId,
        req: DesignRequest,
        pass: Option<PassId>,
    ) -> Result<DesignOutcome> {
        let config = self.config(id)?;
        let plan = design::plan_design(config.dialect, &req)?;
        let path = design_path(&req).clone();
        let scope = PassScope::Design(id, path.clone());
        self.authorize(&scope, &config, &plan.statements, pass)?;
        let session = self.session(id).await?;
        // S14: a plan made from an older design would put back what changed since.
        // SQLite compares inside the runner's transaction; here the table is read again.
        if config.dialect != DialectKind::Sqlite
            && let DesignTarget::Alter { base } | DesignTarget::Drop { base } = &req.target
            && session.table_design(&base.path).await? != *base
        {
            return Err(Error::InvalidInput(design::TABLE_CHANGED.into()));
        }
        let ran_at_ms = now_ms();
        let started = Instant::now();
        let result = browse_result(
            session.apply_design(&path.database, &plan).await,
            config.read_only,
        );
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let entry = design_history(&plan.statements, &result);
        // A history entry means statements stayed applied: the AI Context may be out of date.
        if entry.is_some() {
            let _ = self.mark_ai_context_stale(id);
        }
        // History is a record, not part of the change: a store failure must not hide the result.
        if let Some(entry) = entry
            && let Ok(store) = self.store()
        {
            let _ = store.add_history(&NewHistory {
                connection_id: id,
                sql: entry.sql,
                ran_at_ms,
                elapsed_ms,
                outcome: entry.outcome,
                rows: None,
                changed: true,
                error: entry.error,
            });
        }
        match result? {
            DesignOutcome::Failed {
                statement,
                ran,
                message,
            } => Err(Error::DesignFailed {
                statement,
                ran,
                total: plan.statements.len(),
                message,
            }),
            DesignOutcome::ForeignKeys { table } => Err(Error::DesignForeignKeys { table }),
            done => Ok(done),
        }
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
                ai_sync: input.ai_sync.unwrap_or_default(),
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
            ai_sync: input.ai_sync.unwrap_or_default(),
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
        let repointed = {
            let store = self.store()?;
            let stored = store.list_connections()?.into_iter().find(|c| c.id == id);
            let was_production = stored.as_ref().is_some_and(|c| c.production);
            if config.production && !was_production {
                config.ai_access = AiAccess::Never;
            }
            if input.ai_sync.is_none()
                && let Some(stored) = &stored
            {
                config.ai_sync = stored.ai_sync;
            }
            store.save_connection(&config)?;
            stored.is_some_and(|c| !same_target(&c, &config))
        };
        // A Connection at Never has no AI Context (this covers Production turning on). One
        // pointed at another server or file loses it too: the old schema is not this one's.
        if config.ai_access == AiAccess::Never || repointed {
            self.clear_ai_context(Some(id))?;
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
        drop(store);
        if access == AiAccess::Never {
            self.clear_ai_context(Some(id))?;
        }
        Ok(config)
    }

    pub async fn delete(&self, id: ConnectionId) -> Result<()> {
        self.close_session(id).await?;
        self.secrets.delete(id)?;
        self.store()?.delete_connection(id)?;
        self.store()?.clear_history(id)?;
        self.clear_ai_context(Some(id))?;
        let _ = self.forget_connection(id);
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
        let dialect = self.connect_checked(&config, password.as_deref()).await?;
        let version = dialect.server_version().await;
        dialect.disconnect().await.ok();
        version
    }

    pub fn suggestions(&self) -> Result<Vec<SuggestedConnection>> {
        let saved = self.list()?;
        Ok(laragon_suggestions(&saved))
    }

    /// Opens the Connection's session and returns the server version.
    pub async fn open(&self, id: ConnectionId) -> Result<String> {
        self.open_with_hook(id, async {}).await
    }

    /// `open`, awaiting `after_connect` between connecting and registering the
    /// session. Exists so tests can interleave a save or delete deterministically.
    #[doc(hidden)]
    pub async fn open_with_hook(
        &self,
        id: ConnectionId,
        after_connect: impl Future<Output = ()>,
    ) -> Result<String> {
        if self.is_open(id) {
            let version = self.session(id).await?.server_version().await?;
            self.record_opened(id);
            return Ok(version);
        }
        let generation = self.generation(id)?;
        let config = self
            .list()?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| Error::NotFound("connection not found".into()))?;
        let password = self.secrets.get(id)?;
        let session = self.connect_checked(&config, password.as_deref()).await?;
        let version = match session.server_version().await {
            Ok(v) => v,
            Err(e) => {
                session.disconnect().await.ok();
                return Err(e);
            }
        };
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
        self.record_opened(id);
        Ok(version)
    }

    /// Best effort: a failed write must not fail the open.
    fn record_opened(&self, id: ConnectionId) {
        let _ = (|| -> Result<()> {
            let mut map = self.setting_map::<i64>(CONNECTION_OPENED_KEY)?;
            map.insert(id.to_string(), now_ms());
            self.save_setting_map(CONNECTION_OPENED_KEY, &map)
        })();
    }

    /// Best effort: drops a deleted Connection from the opened-time and opens-on maps.
    fn forget_connection(&self, id: ConnectionId) -> Result<()> {
        let mut opened = self.setting_map::<i64>(CONNECTION_OPENED_KEY)?;
        if opened.remove(&id.to_string()).is_some() {
            self.save_setting_map(CONNECTION_OPENED_KEY, &opened)?;
        }
        let mut opens_on = self.setting_map::<ConnectionId>(SAVED_QUERY_CONNECTIONS_KEY)?;
        let before = opens_on.len();
        opens_on.retain(|_, c| *c != id);
        if opens_on.len() != before {
            self.save_setting_map(SAVED_QUERY_CONNECTIONS_KEY, &opens_on)?;
        }
        Ok(())
    }

    /// When each Connection last opened successfully.
    pub fn connection_opened_times(&self) -> Result<HashMap<ConnectionId, i64>> {
        let live: Vec<ConnectionId> = self
            .store()?
            .list_connections()?
            .iter()
            .map(|c| c.id)
            .collect();
        Ok(self
            .setting_map::<i64>(CONNECTION_OPENED_KEY)?
            .into_iter()
            .filter_map(|(k, v)| Some((k.parse::<ConnectionId>().ok()?, v)))
            .filter(|(k, _)| live.contains(k))
            .collect())
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
        let mut groups = self.store()?.list_groups()?;
        for g in &mut groups {
            g.has_image = self.group_image_path(g.id).is_some_and(|p| p.is_file());
        }
        Ok(groups)
    }

    fn group_image_path(&self, id: GroupId) -> Option<PathBuf> {
        self.data_dir
            .as_ref()
            .map(|d| d.join("group-images").join(format!("{id}.png")))
    }

    fn require_group_image_path(&self, id: GroupId) -> Result<PathBuf> {
        self.group_image_path(id)
            .ok_or_else(|| Error::InvalidInput("no data folder".into()))
    }

    fn find_group(&self, id: GroupId) -> Result<Group> {
        self.list_groups()?
            .into_iter()
            .find(|g| g.id == id)
            .ok_or_else(|| Error::NotFound("group not found".into()))
    }

    pub fn set_group_image(&self, id: GroupId, png: &[u8]) -> Result<Group> {
        let path = self.require_group_image_path(id)?;
        self.require_group(id)?;
        if !png.starts_with(PNG_SIGNATURE) {
            return Err(Error::InvalidInput("the image is not a PNG".into()));
        }
        if png.len() > GROUP_IMAGE_MAX {
            return Err(too_large());
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| Error::Store(e.to_string()))?;
        }
        crate::model_files::write_atomic(&path, png)?;
        self.find_group(id)
    }

    pub fn clear_group_image(&self, id: GroupId) -> Result<Group> {
        let path = self.require_group_image_path(id)?;
        self.require_group(id)?;
        remove_if_present(&path)?;
        self.find_group(id)
    }

    pub fn group_image(&self, id: GroupId) -> Result<Option<Vec<u8>>> {
        let path = self.require_group_image_path(id)?;
        match std::fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(Error::Store(e.to_string())),
        }
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
            has_image: false,
        };
        store.save_group(&group)?;
        drop(store);
        self.find_group(id)
    }

    pub fn delete_group(&self, id: GroupId) -> Result<()> {
        self.store()?.delete_group(id)?;
        if let Some(path) = self.group_image_path(id) {
            remove_if_present(&path)?;
        }
        Ok(())
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

    /// Reads each field on its own, so one bad value keeps the others, then clamps.
    pub fn ui_prefs(&self) -> Result<UiPrefs> {
        let raw = self.store()?.get_setting(UI_PREFS_KEY)?;
        let value: serde_json::Value = raw
            .and_then(|r| serde_json::from_str(&r).ok())
            .unwrap_or_default();
        fn field<T: serde::de::DeserializeOwned>(v: &serde_json::Value, key: &str) -> Option<T> {
            v.get(key)
                .and_then(|x| serde_json::from_value(x.clone()).ok())
        }
        let mut p = UiPrefs::default();
        if let Some(t) = field(&value, "theme") {
            p.theme = t;
        }
        if let Some(r) = field::<RowHeight>(&value, "rowHeight") {
            p.row_height = r;
        }
        if let Some(e) = value.get("editor") {
            if let Some(f) = field::<String>(e, "family") {
                p.editor.family = f;
            }
            if let Some(s) = field(e, "size") {
                p.editor.size = s;
            }
            if let Some(l) = field(e, "lineHeight") {
                p.editor.line_height = l;
            }
            if let Some(l) = field(e, "ligatures") {
                p.editor.ligatures = l;
            }
        }
        if let Some(b) = field(&value, "brighterComments") {
            p.brighter_comments = b;
        }
        if let Some(b) = field(&value, "inlineSuggestions") {
            p.inline_suggestions = b;
        }
        if let Some(d) = field(&value, "historyKeepDays") {
            p.history_keep_days = d;
        }
        if p.row_height.0 != 24 {
            p.row_height = RowHeight(28);
        }
        // Retention deletes history, so 0 days must never mean "delete everything after each run".
        p.history_keep_days = p.history_keep_days.map(|d| d.max(1));
        p.editor.size = p.editor.size.clamp(11, 20);
        p.editor.line_height = p.editor.line_height.clamp(16, 28);
        if !KNOWN_EDITOR_FAMILIES.contains(&p.editor.family.as_str()) {
            p.editor.family = EditorPrefs::default().family;
        }
        Ok(p)
    }

    pub fn keymap(&self) -> Result<KeymapOverrides> {
        let raw = self.store()?.get_setting(KEYMAP_KEY)?;
        Ok(raw
            .and_then(|r| serde_json::from_str(&r).ok())
            .unwrap_or_default())
    }

    pub fn save_keymap(&self, overrides: KeymapOverrides) -> Result<()> {
        let json = serde_json::to_string(&overrides).map_err(|e| Error::Store(e.to_string()))?;
        self.store()?.set_setting(KEYMAP_KEY, &json)
    }

    pub fn save_ui_prefs(&self, prefs: UiPrefs) -> Result<()> {
        let json = serde_json::to_string(&prefs).map_err(|e| Error::Store(e.to_string()))?;
        let days_before = self.ui_prefs()?.history_keep_days;
        self.store()?.set_setting(UI_PREFS_KEY, &json)?;
        if days_before != self.ui_prefs()?.history_keep_days {
            // Retention is housekeeping: the prefs are saved either way.
            let _ = self.prune_history_by_prefs();
        }
        Ok(())
    }

    /// The last opened items, newest first. Items whose Connection or Saved Query is
    /// gone are left out; an unreadable value lists empty.
    pub fn recent_items(&self) -> Result<Vec<RecentItem>> {
        let store = self.store()?;
        let list: Vec<RecentItem> = store
            .get_setting(RECENT_ITEMS_KEY)?
            .and_then(|r| serde_json::from_str(&r).ok())
            .unwrap_or_default();
        let connections: Vec<ConnectionId> =
            store.list_connections()?.iter().map(|c| c.id).collect();
        let queries = store.list_saved_queries()?;
        Ok(list
            .into_iter()
            .filter(|i| i.connection_id.is_none_or(|c| connections.contains(&c)))
            .filter_map(|mut i| {
                if let RecentTarget::Query { saved_id, name } = &mut i.target {
                    // The Saved Query's current name, so a rename shows.
                    *name = queries.iter().find(|q| q.id == *saved_id)?.name.clone();
                }
                Some(i)
            })
            .collect())
    }

    /// Empties Recent and returns what it held, so the caller can offer an undo.
    pub fn clear_recent(&self) -> Result<Vec<RecentItem>> {
        let items = self.recent_items()?;
        self.store()?.set_setting(RECENT_ITEMS_KEY, "[]")?;
        Ok(items)
    }

    /// Puts cleared items back under whatever was opened since.
    pub fn restore_recent(&self, items: Vec<RecentItem>) -> Result<()> {
        let store = self.store()?;
        let current: Vec<RecentItem> = store
            .get_setting(RECENT_ITEMS_KEY)?
            .and_then(|r| serde_json::from_str(&r).ok())
            .unwrap_or_default();
        let json = serde_json::to_string(&merge_restored(current, items))
            .map_err(|e| Error::Store(e.to_string()))?;
        store.set_setting(RECENT_ITEMS_KEY, &json)
    }

    pub fn record_recent(
        &self,
        target: RecentTarget,
        connection_id: Option<ConnectionId>,
    ) -> Result<()> {
        let store = self.store()?;
        let list: Vec<RecentItem> = store
            .get_setting(RECENT_ITEMS_KEY)?
            .and_then(|r| serde_json::from_str(&r).ok())
            .unwrap_or_default();
        let list = push_recent(
            list,
            RecentItem {
                target,
                connection_id,
                opened_at_ms: now_ms(),
            },
        );
        let json = serde_json::to_string(&list).map_err(|e| Error::Store(e.to_string()))?;
        store.set_setting(RECENT_ITEMS_KEY, &json)
    }

    /// Drops the Recent items of a dropped table: any object kind with that path on
    /// that Connection (D28).
    pub fn forget_recent(&self, connection_id: ConnectionId, path: &ObjectPath) -> Result<()> {
        let store = self.store()?;
        let mut list: Vec<RecentItem> = store
            .get_setting(RECENT_ITEMS_KEY)?
            .and_then(|r| serde_json::from_str(&r).ok())
            .unwrap_or_default();
        list.retain(|i| {
            !(i.connection_id == Some(connection_id)
                && matches!(&i.target, RecentTarget::Table { path: p, .. } if p == path))
        });
        let json = serde_json::to_string(&list).map_err(|e| Error::Store(e.to_string()))?;
        store.set_setting(RECENT_ITEMS_KEY, &json)
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

    /// The SQL a Visual Query writes on this Connection, or its problems. Reads only the
    /// Connection's Dialect, so it works while the Connection is closed (D3): only SQLite's
    /// version matters, and that is the bundled library's.
    pub fn visual_query_sql(
        &self,
        id: ConnectionId,
        query: VisualQuery,
        types: ColumnTypes,
    ) -> Result<VqPreview> {
        let kind = self.config(id)?.dialect;
        Ok(visual_query::preview(
            kind,
            server_version(kind),
            &query,
            &types,
        ))
    }

    /// Writes a Visual Query for the session's Connection and runs it exactly as the editor
    /// runs a statement (D12): the same Read-only and Production check, Query History and
    /// paged result. A query with problems is refused before anything reaches the server.
    pub async fn run_visual_query(
        &self,
        s: QuerySessionId,
        query: VisualQuery,
        types: ColumnTypes,
        pass: Option<PassId>,
    ) -> Result<VqRun> {
        let (conn, _, session_db) = self.query_slot(s)?;
        let config = self.config(conn)?;
        let kind = config.dialect;
        // MySQL writes the model's own tables bare, so they resolve against the session's
        // database: a session left on another one would read the wrong tables. A session
        // opened with no database is on the Connection's own. SQLite names a scope, not a
        // database, in the model.
        let on = session_db.or(config.database);
        if kind != DialectKind::Sqlite
            && let Some(want) = query.database.as_deref()
            && on.as_deref() != Some(want)
        {
            return Err(Error::InvalidInput(
                "The tab's database changed. Run again.".into(),
            ));
        }
        let sql = visual_query::generate(kind, server_version(kind), &query, &types)?.sql;
        let execution = self.execute_sql(s, sql.clone(), pass).await?;
        Ok(VqRun { sql, execution })
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
        let ddl = is_ddl(config.dialect, &sql);
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
        let _ = self.prune_history_by_prefs();
        if result.is_ok() && ddl {
            let _ = self.mark_ai_context_stale(conn);
        }
        result.map(|outcome| Execution {
            outcome,
            elapsed_ms,
        })
    }

    /// The plan of one statement, from an EXPLAIN that never runs it: no ANALYZE and no
    /// Query History row. The wrapped text goes through the same check as a run and must
    /// classify as a read, so Read-only and Production never treat it as a write.
    pub async fn explain(&self, s: QuerySessionId, statement: String) -> Result<Plan> {
        let (conn, handle) = self.query_session(s)?;
        let config = self.config(conn)?;
        let dialect = config.dialect;
        // Leading `;` and whitespace are not part of the statement.
        let statement = statement
            .trim_start_matches(|c: char| c == ';' || c.is_whitespace())
            .to_string();
        if statement_count(dialect, &statement) != 1 {
            return Err(Error::InvalidInput(
                "Explain one statement at a time.".into(),
            ));
        }
        let refuse = || {
            Error::InvalidInput(
                "Contura explains only statements it can plan without running them.".into(),
            )
        };
        // The user's own EXPLAIN (or DESC, its MySQL synonym) is never wrapped or run.
        match leading_word(dialect, &statement).as_deref() {
            Some("EXPLAIN" | "DESC" | "DESCRIBE") => {
                return Err(Error::InvalidInput(
                    "Explain the statement itself, without EXPLAIN.".into(),
                ));
            }
            // Only these can be planned; anything else (a PRAGMA, say) may act at prepare time.
            Some(
                "SELECT" | "WITH" | "INSERT" | "UPDATE" | "DELETE" | "REPLACE" | "VALUES" | "TABLE"
                | "MERGE",
            ) => {}
            _ => return Err(refuse()),
        }
        let wrapped = explain_sql(dialect, statement.trim());
        self.authorize(
            &PassScope::Query(s),
            &config,
            std::slice::from_ref(&wrapped),
            None,
        )?;
        if classify(dialect, &wrapped) != StatementClass::Read {
            return Err(refuse());
        }
        let rows = {
            let run = handle.explain_rows(&wrapped);
            tokio::pin!(run);
            match config.query_timeout_secs {
                None => run.await?,
                Some(secs) => {
                    match tokio::time::timeout(Duration::from_secs(secs.into()), &mut run).await {
                        Ok(r) => r?,
                        Err(_) => {
                            handle.cancel().await.ok();
                            let _ = tokio::time::timeout(CLOSE_WAIT, &mut run).await;
                            return Err(Error::TimedOut(secs));
                        }
                    }
                }
            }
        };
        plan_from_rows(dialect, &rows)
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

    /// Stops every running query and job, such as when the app quits (Q22), waiting at
    /// most `wait` for the servers. Every job's cancel flag is set before anything waits.
    pub async fn stop_everything(&self, wait: Duration) {
        let _ = tokio::time::timeout(wait, async {
            tokio::join!(self.jobs().cancel_all(), self.cancel_all_queries());
        })
        .await;
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
        id: Option<ConnectionId>,
        filter: HistoryFilter,
    ) -> Result<Vec<HistoryEntry>> {
        self.store()?.query_history(id, &filter)
    }

    /// `None` clears every Connection's history.
    pub fn clear_query_history(&self, id: Option<ConnectionId>) -> Result<()> {
        match id {
            Some(id) => self.store()?.clear_history(id),
            None => self.store()?.clear_all_history(),
        }
    }

    /// With the Connection each opens on; one whose Connection is gone lists `None`.
    pub fn list_saved_queries(&self) -> Result<Vec<SavedQuery>> {
        let mut list = self.store()?.list_saved_queries()?;
        let opens_on = self.setting_map::<ConnectionId>(SAVED_QUERY_CONNECTIONS_KEY)?;
        let live: Vec<ConnectionId> = self
            .store()?
            .list_connections()?
            .iter()
            .map(|c| c.id)
            .collect();
        for q in &mut list {
            q.connection_id = opens_on
                .get(&q.id.to_string())
                .copied()
                .filter(|c| live.contains(c));
        }
        Ok(list)
    }

    pub fn saved_query_runs(&self) -> Result<Vec<SavedQueryRun>> {
        self.store()?.saved_query_runs()
    }

    pub fn save_saved_query(&self, input: SavedQueryInput) -> Result<SavedQuery> {
        let name = input.name.trim().to_string();
        if name.is_empty() {
            return Err(Error::InvalidInput("Give the query a name.".into()));
        }
        // An update keeps the row's kind and model unless the request sets them, so a client
        // that leaves them out never drops a Visual Query's model. A kind never changes.
        let stored = match input.id {
            Some(id) => self.store()?.get_saved_query(id)?,
            None => None,
        };
        let kind = match (&stored, input.kind) {
            (Some(s), Some(k)) if s.kind != k => {
                return Err(Error::InvalidInput(
                    match s.kind {
                        SavedQueryKind::Visual => {
                            "This name belongs to a Visual Query. Pick another name."
                        }
                        SavedQueryKind::Sql => {
                            "This name belongs to a SQL query. Pick another name."
                        }
                    }
                    .into(),
                ));
            }
            (Some(s), _) => s.kind,
            (None, k) => k.unwrap_or_default(),
        };
        // A Visual Query update with no SQL text (no preview to take it from) keeps the stored
        // SQL, so the row's tooltip, search and Open in editor never go blank.
        let sql = match &stored {
            Some(s) if kind == SavedQueryKind::Visual && input.sql.trim().is_empty() => {
                s.sql.clone()
            }
            _ => input.sql,
        };
        // A SQL row has no model; a Visual Query row keeps its model and its last generated SQL.
        let visual_json = match kind {
            SavedQueryKind::Sql => None,
            SavedQueryKind::Visual => {
                match input
                    .visual_json
                    .or_else(|| stored.and_then(|s| s.visual_json))
                {
                    Some(j) => Some(j),
                    None => {
                        return Err(Error::InvalidInput(
                            "A Visual Query needs its model.".into(),
                        ));
                    }
                }
            }
        };
        let mut q = SavedQuery {
            id: input.id.unwrap_or_else(Uuid::new_v4),
            name,
            sql,
            updated_at_ms: now_ms(),
            connection_id: input.connection_id,
            kind,
            visual_json,
        };
        self.store()?.save_saved_query(&q)?;
        let mut opens_on = self.setting_map::<ConnectionId>(SAVED_QUERY_CONNECTIONS_KEY)?;
        // None keeps what is stored; only Some(id) changes it.
        match q.connection_id {
            Some(c) => {
                opens_on.insert(q.id.to_string(), c);
                self.save_setting_map(SAVED_QUERY_CONNECTIONS_KEY, &opens_on)?;
            }
            None => q.connection_id = opens_on.get(&q.id.to_string()).copied(),
        }
        // The AI Context follows from its stored tables. Saving has happened, so a failure
        // here takes the query out of every Context rather than leaving an old copy.
        if self.keep_saved_in_context(&q).is_err() {
            let _ = self.remove_saved(None, q.id);
        }
        Ok(q)
    }

    pub fn delete_saved_query(&self, id: Uuid) -> Result<()> {
        self.store()?.delete_saved_query(id)?;
        self.remove_saved(None, id)?;
        let mut opens_on = self.setting_map::<ConnectionId>(SAVED_QUERY_CONNECTIONS_KEY)?;
        if opens_on.remove(&id.to_string()).is_some() {
            self.save_setting_map(SAVED_QUERY_CONNECTIONS_KEY, &opens_on)?;
        }
        Ok(())
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

/// The AI preview reads the saved Connection and the open session's schema.
#[async_trait::async_trait]
impl CatalogReader for ConnectionService {
    async fn connection_config(&self, id: ConnectionId) -> Result<Option<ConnectionConfig>> {
        Ok(self.list()?.into_iter().find(|c| c.id == id))
    }

    async fn schema_snapshot(
        &self,
        id: ConnectionId,
        database: &str,
        schema: Option<&str>,
    ) -> Result<crate::schema_model::SchemaModel> {
        self.session(id)
            .await?
            .schema_snapshot(database, schema)
            .await
    }

    async fn schema_fingerprint(
        &self,
        id: ConnectionId,
        database: &str,
        schema: Option<&str>,
    ) -> Result<String> {
        self.session(id)
            .await?
            .schema_fingerprint(database, schema)
            .await
    }

    fn context(&self) -> &dyn crate::ai::context::store::ContextStore {
        self
    }

    async fn saved_queries(&self) -> Result<Vec<SavedQuery>> {
        self.list_saved_queries()
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

#[cfg(test)]
mod design_history_tests {
    use super::*;

    fn plan() -> Vec<String> {
        vec!["ALTER A".into(), "ALTER B".into(), "ALTER C".into()]
    }

    #[test]
    fn done_records_the_whole_plan() {
        let entry = design_history(&plan(), &Ok(DesignOutcome::Done { ran: 3 })).unwrap();
        assert_eq!(entry.sql, "ALTER A;\nALTER B;\nALTER C");
        assert_eq!(entry.outcome, Outcome::Ok);
        assert_eq!(entry.error, None);
    }

    /// D12: only the statements MySQL already committed.
    #[test]
    fn partial_failure_records_the_applied_statements() {
        let failed = Ok(DesignOutcome::Failed {
            statement: 2,
            ran: 2,
            message: "no such table".into(),
        });
        let entry = design_history(&plan(), &failed).unwrap();
        assert_eq!(entry.sql, "ALTER A;\nALTER B");
        assert_eq!(entry.outcome, Outcome::Error);
        assert_eq!(entry.error.as_deref(), Some("no such table"));
    }

    #[test]
    fn nothing_changed_records_nothing() {
        let clean = Ok(DesignOutcome::Failed {
            statement: 0,
            ran: 0,
            message: "x".into(),
        });
        assert_eq!(design_history(&plan(), &clean), None);
        let fk = Ok(DesignOutcome::ForeignKeys {
            table: "orders".into(),
        });
        assert_eq!(design_history(&plan(), &fk), None);
        assert_eq!(design_history(&plan(), &Err(Error::ReadOnlyRefused)), None);
        let not_applied = Err(Error::DesignRestoreFailed {
            applied: false,
            sql: "ALTER C".into(),
            message: "x".into(),
        });
        assert_eq!(design_history(&plan(), &not_applied), None);
    }

    #[test]
    fn an_empty_plan_records_nothing() {
        assert_eq!(
            design_history(&[], &Ok(DesignOutcome::Done { ran: 0 })),
            None
        );
    }

    #[test]
    fn applied_change_with_a_failed_restore_is_recorded() {
        let restore = Err(Error::DesignRestoreFailed {
            applied: true,
            sql: "PRAGMA foreign_keys = ON".into(),
            message: "disk I/O error".into(),
        });
        let entry = design_history(&plan(), &restore).unwrap();
        assert_eq!(entry.sql, "ALTER A;\nALTER B;\nALTER C");
        assert_eq!(entry.outcome, Outcome::Error);
        assert_eq!(
            entry.error.as_deref(),
            Some("restoring the connection with PRAGMA foreign_keys = ON failed: disk I/O error")
        );
    }
}

#[cfg(test)]
mod job_pass_tests {
    use super::*;
    use crate::secrets::MemorySecretStore;

    fn service() -> (tempfile::TempDir, ConnectionService) {
        let dir = tempfile::tempdir().unwrap();
        let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
        let svc = ConnectionService::new(store, Arc::new(MemorySecretStore::new()))
            .with_data_dir(crate::jobs::paths::outside_data());
        (dir, svc)
    }

    fn config(production: bool, read_only: bool) -> ConnectionConfig {
        ConnectionConfig {
            id: Uuid::new_v4(),
            name: "prod".into(),
            dialect: DialectKind::Postgres,
            host: "127.0.0.1".into(),
            port: 5432,
            user: "u".into(),
            database: None,
            ssl: crate::model::SslMode::Disable,
            group_id: None,
            file: None,
            query_timeout_secs: None,
            ai_access: Default::default(),
            ai_sync: Default::default(),
            production,
            read_only,
        }
    }

    const FP: [u8; 32] = [7; 32];

    fn file() -> FileIdentity {
        FileIdentity {
            path: PathBuf::from("C:/data/orders.csv"),
            bytes: 10,
            sha256: "ab".repeat(32),
        }
    }

    #[test]
    fn plain_connection_needs_no_pass() {
        let (_d, svc) = service();
        assert!(svc.authorize_job(&config(false, false), FP, None).is_ok());
    }

    #[test]
    fn job_pass_works_once() {
        let (_d, svc) = service();
        let c = config(true, false);
        assert!(matches!(
            svc.authorize_job(&c, FP, None),
            Err(Error::NeedsConfirmation)
        ));
        let pass = svc.issue_job_pass(c.id, FP, Some(file())).unwrap();
        assert_eq!(svc.jobs.confirmed_file(pass), Some(file()));
        svc.authorize_job(&c, FP, Some(pass)).unwrap();
        assert!(matches!(
            svc.authorize_job(&c, FP, Some(pass)),
            Err(Error::NeedsConfirmation)
        ));
    }

    #[test]
    fn job_pass_expires() {
        let (_d, svc) = service();
        svc.set_pass_ttl_for_test(Duration::ZERO);
        let c = config(true, false);
        let pass = svc.issue_job_pass(c.id, FP, None).unwrap();
        assert!(matches!(
            svc.authorize_job(&c, FP, Some(pass)),
            Err(Error::NeedsConfirmation)
        ));
    }

    #[test]
    fn job_pass_other_fingerprint_refused() {
        let (_d, svc) = service();
        let c = config(true, false);
        let pass = svc.issue_job_pass(c.id, FP, None).unwrap();
        assert!(matches!(
            svc.authorize_job(&c, [8; 32], Some(pass)),
            Err(Error::NeedsConfirmation)
        ));
        // Another Connection with the same fingerprint is refused too.
        let other = config(true, false);
        assert!(matches!(
            svc.authorize_job(&other, FP, Some(pass)),
            Err(Error::NeedsConfirmation)
        ));
        // A refusal leaves the pass for the job it was issued for.
        svc.authorize_job(&c, FP, Some(pass)).unwrap();
    }

    #[test]
    fn a_new_job_pass_replaces_the_earlier_one() {
        let (_d, svc) = service();
        let c = config(true, false);
        let first = svc.issue_job_pass(c.id, FP, Some(file())).unwrap();
        let second = svc.issue_job_pass(c.id, FP, None).unwrap();
        assert_eq!(
            svc.jobs.confirmed_file(first),
            None,
            "the replaced pass's file"
        );
        assert!(matches!(
            svc.authorize_job(&c, FP, Some(first)),
            Err(Error::NeedsConfirmation)
        ));
        svc.authorize_job(&c, FP, Some(second)).unwrap();
    }

    #[test]
    fn job_pass_never_covers_query_edits_design_and_reverse() {
        let (_d, svc) = service();
        let c = config(true, false);
        let path = ObjectPath {
            database: "shop".into(),
            schema: Some("public".into()),
            name: "orders".into(),
        };
        let write = vec!["DELETE FROM orders".to_string()];
        let session = Uuid::new_v4();

        // A Job pass covers no Query, Edits or Design run...
        let job = svc.issue_job_pass(c.id, FP, None).unwrap();
        for scope in [
            PassScope::Query(session),
            PassScope::Edits(c.id, path.clone()),
            PassScope::Design(c.id, path.clone()),
        ] {
            assert!(
                matches!(
                    svc.authorize(&scope, &c, &write, Some(job)),
                    Err(Error::NeedsConfirmation)
                ),
                "{scope:?}"
            );
        }
        // ...and is still there for its own job.
        svc.authorize_job(&c, FP, Some(job)).unwrap();

        // No Query, Edits or Design pass covers a job.
        for scope in [
            PassScope::Query(session),
            PassScope::Edits(c.id, path.clone()),
            PassScope::Design(c.id, path.clone()),
        ] {
            let pass = svc.issue_pass(scope.clone(), &write).unwrap();
            assert!(
                matches!(
                    svc.authorize_job(&c, FP, Some(pass)),
                    Err(Error::NeedsConfirmation)
                ),
                "{scope:?}"
            );
            svc.authorize(&scope, &c, &write, Some(pass)).unwrap();
        }
    }

    #[test]
    fn read_only_wins_over_production() {
        let (_d, svc) = service();
        let c = config(true, true);
        let pass = svc.issue_job_pass(c.id, FP, None).unwrap();
        assert!(matches!(
            svc.authorize_job(&c, FP, Some(pass)),
            Err(Error::ReadOnly(0))
        ));
        assert!(matches!(
            svc.authorize_job(&config(false, true), FP, None),
            Err(Error::ReadOnly(0))
        ));
    }

    fn sync_scope(c: &ConnectionConfig) -> PassScope {
        PassScope::Sync(
            c.id,
            ObjectPath {
                database: "freight".into(),
                schema: Some("billing".into()),
                name: String::new(),
            },
        )
    }

    fn script() -> Vec<String> {
        vec![
            "ALTER TABLE \"billing\".\"invoices\" DROP COLUMN \"fax\"".to_string(),
            "CREATE TABLE \"billing\".\"refunds\" (\"id\" integer)".to_string(),
        ]
    }

    #[test]
    fn sync_pass_covers_exactly_its_script_once() {
        let (_d, svc) = service();
        let c = config(true, false);
        let scope = sync_scope(&c);
        let pass = svc.issue_pass(scope.clone(), &script()).unwrap();
        // One statement less (the selection changed): refused, the pass stays.
        assert!(matches!(
            svc.authorize(&scope, &c, &script()[..1], Some(pass)),
            Err(Error::NeedsConfirmation)
        ));
        // One statement more: refused.
        let mut more = script();
        more.push("DROP TABLE \"billing\".\"old\"".into());
        assert!(matches!(
            svc.authorize(&scope, &c, &more, Some(pass)),
            Err(Error::NeedsConfirmation)
        ));
        // Another target database: refused.
        let other = PassScope::Sync(
            c.id,
            ObjectPath {
                database: "other".into(),
                schema: Some("billing".into()),
                name: String::new(),
            },
        );
        assert!(matches!(
            svc.authorize(&other, &c, &script(), Some(pass)),
            Err(Error::NeedsConfirmation)
        ));
        svc.authorize(&scope, &c, &script(), Some(pass)).unwrap();
        // Used up.
        assert!(matches!(
            svc.authorize(&scope, &c, &script(), Some(pass)),
            Err(Error::NeedsConfirmation)
        ));
        assert!(matches!(
            svc.authorize(&scope, &c, &script(), None),
            Err(Error::NeedsConfirmation)
        ));
    }

    #[test]
    fn sync_pass_never_covers_query_edits_design_job_and_reverse() {
        let (_d, svc) = service();
        let c = config(true, false);
        let path = ObjectPath {
            database: "freight".into(),
            schema: Some("billing".into()),
            name: "invoices".into(),
        };
        let session = Uuid::new_v4();
        let others = [
            PassScope::Query(session),
            PassScope::Edits(c.id, path.clone()),
            PassScope::Design(c.id, path.clone()),
        ];
        let sync = svc.issue_pass(sync_scope(&c), &script()).unwrap();
        for scope in &others {
            assert!(
                matches!(
                    svc.authorize(scope, &c, &script(), Some(sync)),
                    Err(Error::NeedsConfirmation)
                ),
                "{scope:?}"
            );
        }
        assert!(matches!(
            svc.authorize_job(&c, FP, Some(sync)),
            Err(Error::NeedsConfirmation)
        ));
        // Still there for its own script.
        svc.authorize(&sync_scope(&c), &c, &script(), Some(sync))
            .unwrap();

        for scope in others {
            let pass = svc.issue_pass(scope.clone(), &script()).unwrap();
            assert!(
                matches!(
                    svc.authorize(&sync_scope(&c), &c, &script(), Some(pass)),
                    Err(Error::NeedsConfirmation)
                ),
                "{scope:?}"
            );
        }
        let job = svc.issue_job_pass(c.id, FP, None).unwrap();
        assert!(matches!(
            svc.authorize(&sync_scope(&c), &c, &script(), Some(job)),
            Err(Error::NeedsConfirmation)
        ));
    }

    #[test]
    fn sync_read_only_wins() {
        let (_d, svc) = service();
        let c = config(true, true);
        let pass = svc.issue_pass(sync_scope(&c), &script()).unwrap();
        assert!(matches!(
            svc.authorize(&sync_scope(&c), &c, &script(), Some(pass)),
            Err(Error::ReadOnly(0))
        ));
    }
}
