//! `BulkWriter`: one held connection that runs the INSERTs of an import (Task 6).
//!
//! Each Dialect opens it through `Dialect::open_bulk_writer`, on a connection of its own
//! with the same Read-only backstop as its query sessions: a writer opened on a Read-only
//! Connection is refused by the server (`ReadOnlyRefused`), although a job never gets that
//! far, because `authorize_job` refuses it first.

use std::sync::Arc;

use crate::error::{Error, Result};
use crate::query::Canceller;

/// Session statements a job needs around its writes: `before` run once when the writer
/// opens, before any `begin`; `after` run after each COMMIT that succeeded, so under
/// Commit every N they run after every batch. A writer's session settings end with its
/// connection.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WriterSetup {
    pub before: Vec<String>,
    pub after: Vec<String>,
}

/// One held connection for a job's writes. Every method runs on that one connection, in
/// order. Errors are mapped like the Dialect's query sessions; a server refusal on a
/// Read-only Connection is `ReadOnlyRefused`.
///
/// `commit` reports the COMMIT's own outcome: `Ok`, or the error of a COMMIT that failed
/// (nothing of the batch is in). When the COMMIT succeeded and an `after` statement then
/// failed, it returns `Error::AfterCommit`: the batch's rows are in, and callers count
/// them as committed. `close` never reports an error.
#[async_trait::async_trait]
pub trait BulkWriter: Send {
    /// Starts a transaction (SQLite: `BEGIN IMMEDIATE`, so the write lock is taken now).
    async fn begin(&mut self) -> Result<()>;
    /// Runs one statement, never several joined by `;` (the Dialects differ on those);
    /// the rows it changed.
    async fn run(&mut self, sql: &str) -> Result<u64>;
    /// Runs one statement that reads, and returns the first column of its first row as
    /// text (`None` for no row or a NULL). Used for counts and checks inside the job's
    /// own transaction.
    async fn first_value(&mut self, sql: &str) -> Result<Option<String>>;
    async fn savepoint(&mut self, name: &str) -> Result<()>;
    async fn rollback_to(&mut self, name: &str) -> Result<()>;
    async fn release(&mut self, name: &str) -> Result<()>;
    /// Commits, then runs the setup's `after` statements; see the trait doc for
    /// `AfterCommit`.
    async fn commit(&mut self) -> Result<()>;
    async fn rollback(&mut self) -> Result<()>;
    /// The longest statement, in bytes, the server takes: MySQL half its
    /// `max_allowed_packet`; no limit (`usize::MAX`) elsewhere.
    fn statement_limit(&self) -> usize;
    /// Stops the statement running now.
    fn canceller(&self) -> Arc<dyn Canceller>;
    /// Closes the connection; an open transaction is rolled back. Never reports an error.
    async fn close(self: Box<Self>);
}

/// The error of an `after` statement `sql` that failed once the COMMIT had succeeded,
/// with the server's text.
pub(crate) fn after_commit(sql: &str, e: Error) -> Error {
    let message = match e {
        Error::Query(m) => m,
        other => other.to_string(),
    };
    Error::AfterCommit {
        sql: sql.to_string(),
        message,
    }
}
