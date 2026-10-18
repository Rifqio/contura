//! Query sessions: one database connection per query tab, owned by a task, so a
//! typed `BEGIN` lasts across statements, Cancel can reach it, and a result past
//! one page stays open on the server until more rows are asked for.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};

use crate::error::{Error, Result};
use crate::model::{Cell, ConnectionId};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResultColumn {
    pub name: String,
    pub type_name: String,
    pub numeric: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ExecOutcome {
    Rows {
        columns: Vec<ResultColumn>,
        rows: Vec<Vec<Cell>>,
        has_more: bool,
    },
    Affected {
        rows: u64,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MoreRows {
    pub rows: Vec<Vec<Cell>>,
    pub has_more: bool,
}

pub type QuerySessionId = uuid::Uuid;
pub type SavedQueryId = uuid::Uuid;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Execution {
    pub outcome: ExecOutcome,
    pub elapsed_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Ok,
    Error,
    Cancelled,
    TimedOut,
}

impl Outcome {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Outcome::Ok => "ok",
            Outcome::Error => "error",
            Outcome::Cancelled => "cancelled",
            Outcome::TimedOut => "timedOut",
        }
    }

    pub(crate) fn parse(s: &str) -> Option<Outcome> {
        [
            Outcome::Ok,
            Outcome::Error,
            Outcome::Cancelled,
            Outcome::TimedOut,
        ]
        .into_iter()
        .find(|o| o.as_str() == s)
    }
}

/// One statement run on a Connection, newest first in Query History.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub connection_id: ConnectionId,
    pub sql: String,
    pub ran_at_ms: i64,
    pub elapsed_ms: u64,
    pub outcome: Outcome,
    /// Rows returned (first page) or changed; `None` when the statement did not finish.
    pub rows: Option<u64>,
    /// The statement reported changed rows rather than returning them.
    pub changed: bool,
    pub error: Option<String>,
}

/// A history row before the store gives it an id.
#[derive(Clone, Debug)]
pub struct NewHistory {
    pub connection_id: ConnectionId,
    pub sql: String,
    pub ran_at_ms: i64,
    pub elapsed_ms: u64,
    pub outcome: Outcome,
    pub rows: Option<u64>,
    pub changed: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HistoryOnly {
    /// Errors, cancels and timeouts.
    Failed,
    /// Statements that changed rows.
    Changes,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryFilter {
    pub search: Option<String>,
    pub only: Option<HistoryOnly>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    pub id: uuid::Uuid,
    pub name: String,
    pub sql: String,
    pub updated_at_ms: i64,
    /// The Connection the query opens on.
    #[serde(default)]
    pub connection_id: Option<ConnectionId>,
    #[serde(default)]
    pub kind: SavedQueryKind,
    /// A Visual Query's model as the UI wrote it; `sql` keeps its last generated SQL.
    #[serde(default)]
    pub visual_json: Option<String>,
}

/// What a Saved Query holds: SQL text, or a Visual Query. One name space covers both.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SavedQueryKind {
    #[default]
    Sql,
    Visual,
}

impl SavedQueryKind {
    /// The `saved_queries.kind` text.
    pub fn as_str(self) -> &'static str {
        match self {
            SavedQueryKind::Sql => "sql",
            SavedQueryKind::Visual => "visual",
        }
    }

    pub fn from_store(s: &str) -> SavedQueryKind {
        if s == "visual" {
            SavedQueryKind::Visual
        } else {
            SavedQueryKind::Sql
        }
    }
}

/// The newest run of a Saved Query, found by its text.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedQueryRun {
    pub saved_id: uuid::Uuid,
    pub ran_at_ms: i64,
    pub rows: Option<u64>,
    pub elapsed_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedQueryInput {
    pub id: Option<uuid::Uuid>,
    pub name: String,
    pub sql: String,
    #[serde(default)]
    pub connection_id: Option<ConnectionId>,
    /// None keeps an existing row's kind (Sql for a new one); a different kind is refused.
    #[serde(default)]
    pub kind: Option<SavedQueryKind>,
    /// None keeps a Visual Query's stored model.
    #[serde(default)]
    pub visual_json: Option<String>,
}

pub(crate) enum Command {
    Execute {
        sql: String,
        reply: oneshot::Sender<Result<ExecOutcome>>,
    },
    FetchMore {
        reply: oneshot::Sender<Result<MoreRows>>,
    },
    /// Runs an EXPLAIN statement and answers every cell as full text.
    Explain {
        sql: String,
        reply: oneshot::Sender<Result<Vec<Vec<String>>>>,
    },
    CloseResult {
        reply: oneshot::Sender<()>,
    },
    Close {
        reply: oneshot::Sender<()>,
    },
}

/// Stops the statement a session is running, from outside the session's task.
#[async_trait::async_trait]
pub trait Canceller: Send + Sync {
    async fn cancel(&self) -> Result<()>;
}

/// Set when the user asks to cancel, so the actor can tell a cancel from a failure.
#[derive(Clone, Default)]
pub(crate) struct CancelFlag(Arc<AtomicBool>);

impl CancelFlag {
    fn request(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    fn clear(&self) {
        self.0.store(false, Ordering::SeqCst);
    }
    /// True once after a cancel request.
    pub(crate) fn take(&self) -> bool {
        self.0.swap(false, Ordering::SeqCst)
    }
}

pub struct SessionHandle {
    tx: mpsc::Sender<Command>,
    canceller: Arc<dyn Canceller>,
    flag: CancelFlag,
    /// A statement or a page fetch is in flight.
    busy: Arc<AtomicBool>,
}

/// Clears the busy flag however the call ends, including when it is dropped.
struct Busy<'a>(&'a AtomicBool);

impl<'a> Busy<'a> {
    fn start(b: &'a AtomicBool) -> Self {
        b.store(true, Ordering::SeqCst);
        Busy(b)
    }
}

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

pub(crate) fn closed() -> Error {
    Error::Query("the query session closed".into())
}

pub(crate) fn no_more() -> Error {
    Error::InvalidInput("There are no more rows to fetch.".into())
}

impl SessionHandle {
    pub(crate) fn new(
        tx: mpsc::Sender<Command>,
        canceller: Arc<dyn Canceller>,
        flag: CancelFlag,
    ) -> Self {
        Self {
            tx,
            canceller,
            flag,
            busy: Arc::new(AtomicBool::new(false)),
        }
    }

    async fn ask<T>(&self, make: impl FnOnce(oneshot::Sender<T>) -> Command) -> Result<T> {
        let (reply, answer) = oneshot::channel();
        self.tx.send(make(reply)).await.map_err(|_| closed())?;
        answer.await.map_err(|_| closed())
    }

    pub async fn execute(&self, sql: &str) -> Result<ExecOutcome> {
        // Cleared before sending: a cancel that arrives while this runs still counts.
        self.flag.clear();
        let _busy = Busy::start(&self.busy);
        let sql = sql.to_string();
        self.ask(|reply| Command::Execute { sql, reply }).await?
    }

    /// Runs `sql`, an EXPLAIN statement, and returns every cell as full text, with no
    /// preview cut. Nothing is recorded.
    pub async fn explain_rows(&self, sql: &str) -> Result<Vec<Vec<String>>> {
        self.flag.clear();
        let _busy = Busy::start(&self.busy);
        let sql = sql.to_string();
        self.ask(|reply| Command::Explain { sql, reply }).await?
    }

    pub async fn fetch_more(&self) -> Result<MoreRows> {
        let _busy = Busy::start(&self.busy);
        self.ask(|reply| Command::FetchMore { reply }).await?
    }

    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }

    pub async fn cancel(&self) -> Result<()> {
        self.flag.request();
        self.canceller.cancel().await
    }

    /// Abandons the open result, if any. Its remaining rows are never read into memory.
    pub async fn close_result(&self) -> Result<()> {
        self.ask(|reply| Command::CloseResult { reply }).await
    }

    /// Rolls back an open transaction and closes the connection.
    pub async fn close(&self) -> Result<()> {
        self.ask(|reply| Command::Close { reply }).await
    }
}

/// Maps a failure to `Cancelled` when the user asked to cancel.
pub(crate) fn or_cancelled(flag: &CancelFlag, e: Error) -> Error {
    if flag.take() { Error::Cancelled } else { e }
}
