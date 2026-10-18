//! The SQLite `BulkWriter`: a write connection to the file on a thread of its own, opened
//! like a query session's, so a Read-only Connection's writer has no write access to the
//! file. `begin` is `BEGIN IMMEDIATE`, which takes the write lock up front; another writer
//! waits up to the 5s busy timeout and then gets a plain message.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc;

use rusqlite::{Connection, ErrorCode};
use tokio::sync::oneshot;

use super::session::Interrupt;
use super::{open_existing, session_err};
use crate::common::quote_double;
use crate::error::{Error, Result};
use crate::jobs::writer::{BulkWriter, WriterSetup, after_commit};
use crate::query::Canceller;

const LOCKED: &str = "Another connection is writing to this file. Try again when it ends.";

type Work = Box<dyn FnOnce(&Connection) + Send>;

pub(super) struct SqliteWriter {
    tx: mpsc::Sender<Work>,
    read_only: bool,
    after: Vec<String>,
    canceller: Arc<dyn Canceller>,
}

fn is_locked(e: &rusqlite::Error) -> bool {
    matches!(
        e,
        rusqlite::Error::SqliteFailure(f, _)
            if f.code == ErrorCode::DatabaseBusy || f.code == ErrorCode::DatabaseLocked
    )
}

/// A busy file is the plain locked message; anything else maps like a query session's.
fn writer_err(e: rusqlite::Error, read_only: bool) -> Error {
    if is_locked(&e) {
        Error::Query(LOCKED.into())
    } else {
        session_err(e, read_only)
    }
}

fn closed() -> Error {
    Error::Query("the import's connection to the file closed".into())
}

pub(super) async fn open(
    path: PathBuf,
    read_only: bool,
    setup: WriterSetup,
) -> Result<Box<dyn BulkWriter>> {
    let (tx, rx) = mpsc::channel::<Work>();
    let (ready_tx, ready_rx) = oneshot::channel();
    std::thread::Builder::new()
        .name("contura-sqlite-writer".into())
        .spawn(move || {
            let conn = match open_existing(&path, read_only) {
                Ok(conn) => conn,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            let _ = ready_tx.send(Ok(conn.get_interrupt_handle()));
            while let Ok(work) = rx.recv() {
                work(&conn);
            }
            // The writer is gone: closing the connection rolls back whatever is open.
        })
        .map_err(|e| Error::Connect(format!("cannot start the import's connection: {e}")))?;
    let interrupt = ready_rx.await.map_err(|_| closed())??;
    let mut writer = SqliteWriter {
        tx,
        read_only,
        after: setup.after,
        canceller: Arc::new(Interrupt(interrupt)),
    };
    for sql in &setup.before {
        writer.run(sql).await?;
    }
    Ok(Box::new(writer))
}

/// Runs one statement to its end; the rows it changed. `changes()` counts only the
/// statement's own rows (not a trigger's), and is read only when the statement changed
/// something, since it still holds the last INSERT, UPDATE or DELETE's count otherwise.
fn run_one(conn: &Connection, sql: &str) -> rusqlite::Result<u64> {
    let before = conn.total_changes();
    let mut stmt = conn.prepare(sql)?;
    let mut rows = stmt.raw_query();
    while rows.next()?.is_some() {}
    drop(rows);
    drop(stmt);
    Ok(if conn.total_changes() == before {
        0
    } else {
        conn.changes()
    })
}

impl SqliteWriter {
    async fn call<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (reply, answer) = oneshot::channel();
        self.tx
            .send(Box::new(move |conn| {
                let _ = reply.send(work(conn));
            }))
            .map_err(|_| closed())?;
        answer.await.map_err(|_| closed())?
    }

    async fn exec(&self, sql: String) -> Result<()> {
        let read_only = self.read_only;
        self.call(move |conn| {
            conn.execute_batch(&sql)
                .map_err(|e| writer_err(e, read_only))
        })
        .await
    }
}

#[async_trait::async_trait]
impl BulkWriter for SqliteWriter {
    async fn begin(&mut self) -> Result<()> {
        self.exec("BEGIN IMMEDIATE".into()).await
    }

    async fn run(&mut self, sql: &str) -> Result<u64> {
        let sql = sql.to_string();
        let read_only = self.read_only;
        self.call(move |conn| run_one(conn, &sql).map_err(|e| writer_err(e, read_only)))
            .await
    }

    async fn savepoint(&mut self, name: &str) -> Result<()> {
        self.exec(format!("SAVEPOINT {}", quote_double(name))).await
    }

    async fn rollback_to(&mut self, name: &str) -> Result<()> {
        self.exec(format!("ROLLBACK TO SAVEPOINT {}", quote_double(name)))
            .await
    }

    async fn release(&mut self, name: &str) -> Result<()> {
        self.exec(format!("RELEASE SAVEPOINT {}", quote_double(name)))
            .await
    }

    async fn commit(&mut self) -> Result<()> {
        self.exec("COMMIT".into()).await?;
        for sql in self.after.clone() {
            self.run(&sql).await.map_err(|e| after_commit(&sql, e))?;
        }
        Ok(())
    }

    /// SQLite rolls back on its own after some errors (SQLITE_FULL, an I/O error), so
    /// there may be nothing left to roll back.
    async fn rollback(&mut self) -> Result<()> {
        let read_only = self.read_only;
        self.call(move |conn| {
            if conn.is_autocommit() {
                return Ok(());
            }
            conn.execute_batch("ROLLBACK")
                .map_err(|e| writer_err(e, read_only))
        })
        .await
    }

    fn statement_limit(&self) -> usize {
        usize::MAX
    }

    fn canceller(&self) -> Arc<dyn Canceller> {
        self.canceller.clone()
    }

    async fn close(self: Box<Self>) {
        let _ = self
            .call(|conn| {
                if !conn.is_autocommit() {
                    let _ = conn.execute_batch("ROLLBACK");
                }
                Ok(())
            })
            .await;
        // Dropping the sender ends the thread, which closes the connection.
    }
}
