//! The Backup's rows and the script writer (spec "Core", `data.rs`).
//!
//! A [`SnapshotRead`] is one connection of the Dialect's own, held in one read snapshot
//! (MySQL `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY`, PostgreSQL
//! `REPEATABLE READ READ ONLY`, SQLite one read transaction) with its session in UTC. It
//! reads the structure first, then serves each table's rows on request through step 7's
//! `RowSource`, in primary key order, generated columns left out. Dropping it ends the
//! snapshot and closes the connection.
//!
//! [`write_script`] writes the whole file from a [`BackupScript`]: header, settings,
//! structure, rows per table through `InsertBuilder`, after-rows, finish and trailer. The
//! text goes to a writer on a blocking thread through a channel of 8 pieces (a statement
//! is at most about 1 MB), so neither the database nor the file is held whole.

use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::{mpsc, oneshot};

use super::format::{self, BackupHeader, Section};
use super::structure::StructureParts;
use crate::error::{Error, Result};
use crate::jobs::insert::{InsertBuilder, InsertLimits, conversion_for};
use crate::jobs::limits::MAX_STATEMENT_BYTES;
use crate::jobs::source::{PendingSource, RowSource, Value};
use crate::jobs::types::JobPosition;
use crate::model::DialectKind;
use crate::query::Canceller;

/// A statement ends before it would pass about 1 MB (spec "The script format").
pub const STATEMENT_BYTES: usize = 1024 * 1024;

/// One table of the snapshot, in `StructureParts::tables` order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TableFacts {
    pub name: String,
    /// Counted inside the snapshot when the read was opened to count; otherwise the
    /// server's estimate.
    pub rows: u64,
}

/// What a snapshot read learns before its first row.
#[derive(Clone, Debug, Default)]
pub struct SnapshotFacts {
    pub parts: StructureParts,
    pub tables: Vec<TableFacts>,
    /// The server's size figures for the tables' data, in bytes.
    pub data_bytes: u64,
    /// MySQL tables outside the snapshot, with their engine (MyISAM and the like).
    pub non_snapshot: Vec<(String, String)>,
}

/// A table's rows as the Backup reads them.
pub struct TableRows {
    pub source: Box<dyn RowSource>,
    /// PostgreSQL: a value goes into an ALWAYS identity column, so each INSERT carries
    /// `OVERRIDING SYSTEM VALUE`.
    pub overriding: bool,
    /// The primary key's columns, to name a row in a message; empty without one.
    pub key: Vec<String>,
}

/// What the producer hands back for one table, before its read has opened.
pub(crate) struct PendingRows {
    pub source: PendingSource,
    pub overriding: bool,
    pub key: Vec<String>,
}

/// One request to the producer: the rows of `table`.
pub(crate) struct TableAsk {
    pub table: String,
    pub reply: oneshot::Sender<Result<PendingRows>>,
}

/// Where the Backup's rows come from, table by table.
#[async_trait::async_trait]
pub trait BackupSource: Send {
    /// The rows of `table` (a name from `StructureParts::tables`).
    async fn rows(&mut self, table: &str) -> Result<TableRows>;
}

/// One read snapshot on a connection of its own. See the module note.
pub struct SnapshotRead {
    pub facts: SnapshotFacts,
    asks: mpsc::Sender<TableAsk>,
}

impl SnapshotRead {
    pub(crate) fn new(facts: SnapshotFacts, asks: mpsc::Sender<TableAsk>) -> Self {
        Self { facts, asks }
    }
}

/// The producer's end for the facts.
pub(crate) type Ready = oneshot::Sender<Result<SnapshotFacts>>;
/// The read's end for the facts.
pub(crate) type Opened = oneshot::Receiver<Result<SnapshotFacts>>;

/// The two ends between a snapshot's producer and its `SnapshotRead`: `ready` takes the
/// facts once, then the producer serves `asks` until the read is dropped.
pub(crate) fn snapshot_channel() -> (
    Ready,
    Opened,
    mpsc::Sender<TableAsk>,
    mpsc::Receiver<TableAsk>,
) {
    let (ready, opened) = oneshot::channel();
    let (asks_tx, asks) = mpsc::channel(1);
    (ready, opened, asks_tx, asks)
}

/// Waits for the producer's facts and wraps them with the asks' sender.
pub(crate) async fn snapshot_opened(
    opened: Opened,
    asks: mpsc::Sender<TableAsk>,
) -> Result<SnapshotRead> {
    let facts = opened.await.map_err(|_| Error::ReadStopped)??;
    Ok(SnapshotRead::new(facts, asks))
}

#[async_trait::async_trait]
impl BackupSource for SnapshotRead {
    async fn rows(&mut self, table: &str) -> Result<TableRows> {
        let (reply, answer) = oneshot::channel();
        self.asks
            .send(TableAsk {
                table: table.to_string(),
                reply,
            })
            .await
            .map_err(|_| Error::ReadStopped)?;
        let pending = answer.await.map_err(|_| Error::ReadStopped)??;
        Ok(TableRows {
            source: pending.source.open().await?,
            overriding: pending.overriding,
            key: pending.key,
        })
    }
}

/// One table whose rows go into the file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RowsTable {
    /// The name in `StructureParts::tables`, asked of the source.
    pub name: String,
    /// The name in the header's `rows:` line and the section marker (`billing.customers`).
    pub label: String,
    /// The table after INTO, quoted exactly as its CREATE TABLE names it.
    pub table_sql: String,
    /// The header's count for it.
    pub rows: u64,
}

/// Everything the file holds, in file order, except the rows themselves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackupScript {
    pub dialect: DialectKind,
    pub header: BackupHeader,
    pub settings: Vec<String>,
    /// The structure section: each `DROP TABLE IF EXISTS` (when asked) right before its
    /// table's CREATE.
    pub structure: Vec<String>,
    /// Empty when Rows is not ticked.
    pub tables: Vec<RowsTable>,
    pub after_rows: Vec<String>,
    pub finish: Vec<String>,
    /// 100, 500 or 1,000.
    pub rows_per_statement: usize,
}

/// A Backup's progress, for the job's events.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BackupProgress {
    pub table: Option<String>,
    pub tables_done: u64,
    pub tables_total: u64,
    pub rows_done: u64,
    pub rows_total: u64,
    pub bytes_done: u64,
    pub statements_done: u64,
}

/// Who watches a Backup run: the job, or a test.
pub trait BackupObserver: Send + Sync {
    fn progress(&self, p: &BackupProgress);
    /// Sent whatever the throttle says: the end of a table.
    fn progress_now(&self, p: &BackupProgress) {
        self.progress(p);
    }
    fn cancelled(&self) -> bool;
    /// The read to stop on cancel: the current table's source.
    fn reading(&self, canceller: Arc<dyn Canceller>);
}

/// What `write_script` wrote.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Written {
    pub statements: u64,
    pub rows: u64,
    pub bytes: u64,
    /// Tables whose rows did not match the header's count (MySQL tables outside the
    /// snapshot), as sentences.
    pub warnings: Vec<String>,
}

/// The spec's text for a full disk.
pub fn disk_full_message(target: &Path) -> String {
    format!(
        "Cannot write {}: the disk is full. The unfinished file was deleted.",
        target.display()
    )
}

fn is_disk_full(e: &std::io::Error) -> bool {
    // ERROR_HANDLE_DISK_FULL (39) and ERROR_DISK_FULL (112) on Windows, ENOSPC (28).
    e.kind() == std::io::ErrorKind::StorageFull
        || matches!(e.raw_os_error(), Some(39) | Some(112))
        || (cfg!(unix) && e.raw_os_error() == Some(28))
}

/// A write error as the Backup reports it.
pub fn write_error(target: &Path, e: &std::io::Error) -> Error {
    if is_disk_full(e) {
        return Error::JobFailed {
            at: JobPosition::default(),
            message: disk_full_message(target),
        };
    }
    Error::JobFailed {
        at: JobPosition::default(),
        message: format!(
            "Cannot write {}: {e}. The unfinished file was deleted.",
            target.display()
        ),
    }
}

/// SQLite keeps an infinite REAL, which it reads back as `inf`; `9e999` writes it back.
/// NaN is never stored (SQLite keeps NULL).
fn fix_value(kind: DialectKind, v: Value) -> Value {
    if kind != DialectKind::Sqlite {
        return v;
    }
    match &v {
        Value::Number(s) => match s.as_str() {
            "inf" | "+inf" => Value::Number("9e999".into()),
            "-inf" => Value::Number("-9e999".into()),
            "NaN" | "nan" => Value::Null,
            _ => v,
        },
        _ => v,
    }
}

/// The text side of the writer thread: it counts statements as they go.
struct Pipe {
    tx: mpsc::Sender<String>,
    statements: u64,
}

impl Pipe {
    /// Sends `text`; a closed channel means the writer stopped, and its error is the one
    /// reported.
    async fn put(&mut self, text: String) -> Result<()> {
        self.tx.send(text).await.map_err(|_| Error::ReadStopped)
    }

    async fn statement(&mut self, sql: &str) -> Result<()> {
        self.statements += 1;
        self.put(format!("{sql}\n")).await
    }

    async fn section(&mut self, s: Section<'_>) -> Result<()> {
        let mut out = Vec::new();
        out.push(b'\n');
        format::section(&mut out, s).map_err(|e| Error::File(e.to_string()))?;
        self.put(String::from_utf8_lossy(&out).into_owned()).await
    }
}

/// Writes the whole script into `out` and hands `out` back once every byte is written
/// (and flushed), with what was written. On any failure, or a cancel, `out` is dropped
/// on the writer thread (a `PartialWriter` then deletes the partial) and the error
/// comes back: a write error as [`write_error`] makes it, a cancel as `Cancelled`.
pub async fn write_script<W: Write + Send + 'static>(
    script: &BackupScript,
    source: &mut dyn BackupSource,
    out: W,
    target: &Path,
    observer: &dyn BackupObserver,
) -> Result<(W, Written)> {
    let bytes = Arc::new(AtomicU64::new(0));
    let (tx, mut rx) = mpsc::channel::<String>(8);
    let counter = bytes.clone();
    let writer = tokio::task::spawn_blocking(move || -> std::io::Result<W> {
        let mut out = out;
        while let Some(text) = rx.blocking_recv() {
            out.write_all(text.as_bytes())?;
            counter.fetch_add(text.len() as u64, Ordering::Relaxed);
        }
        out.flush()?;
        Ok(out)
    });
    let mut pipe = Pipe { tx, statements: 0 };
    let mut written = Written::default();
    let produced = produce(script, source, &mut pipe, &bytes, observer, &mut written).await;
    written.statements = pipe.statements;
    // Closing the channel lets the writer flush and end.
    drop(pipe);
    let joined = writer
        .await
        .map_err(|e| Error::File(format!("the Backup's writer stopped: {e}")));
    let cancelled = |e: Error| {
        if observer.cancelled() {
            Error::Cancelled
        } else {
            e
        }
    };
    let out = match (produced, joined) {
        // A write error is the cause whenever the writer failed.
        (_, Ok(Err(e))) => return Err(cancelled(write_error(target, &e))),
        (_, Err(e)) => return Err(cancelled(e)),
        (Err(e), Ok(Ok(out))) => {
            drop(out);
            return Err(cancelled(e));
        }
        (Ok(()), Ok(Ok(out))) => out,
    };
    if observer.cancelled() {
        drop(out);
        return Err(Error::Cancelled);
    }
    written.bytes = bytes.load(Ordering::Relaxed);
    Ok((out, written))
}

async fn produce(
    script: &BackupScript,
    from: &mut dyn BackupSource,
    pipe: &mut Pipe,
    bytes: &AtomicU64,
    observer: &dyn BackupObserver,
    written: &mut Written,
) -> Result<()> {
    let kind = script.dialect;
    let mut head = Vec::new();
    format::write_header(&mut head, &script.header).map_err(|e| Error::File(e.to_string()))?;
    pipe.put(String::from_utf8_lossy(&head).into_owned())
        .await?;
    pipe.section(Section::Settings).await?;
    for s in &script.settings {
        pipe.statement(s).await?;
    }
    pipe.section(Section::Structure).await?;
    for s in &script.structure {
        if observer.cancelled() {
            return Err(Error::Cancelled);
        }
        pipe.statement(s).await?;
    }

    let rows_total: u64 = script.tables.iter().map(|t| t.rows).sum();
    let tables_total = script.tables.len() as u64;
    let mut progress = BackupProgress {
        tables_total,
        rows_total,
        ..BackupProgress::default()
    };
    for t in &script.tables {
        if observer.cancelled() {
            return Err(Error::Cancelled);
        }
        progress.table = Some(t.label.clone());
        progress.bytes_done = bytes.load(Ordering::Relaxed);
        progress.statements_done = pipe.statements;
        observer.progress(&progress);
        pipe.section(Section::Rows(&t.label)).await?;
        let TableRows {
            mut source,
            overriding,
            key,
        } = from.rows(&t.name).await?;
        observer.reading(source.canceller());
        let columns = source.columns().to_vec();
        let names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();
        let conversions = columns
            .iter()
            .map(|c| conversion_for(kind, &c.type_name))
            .collect();
        let mut builder = InsertBuilder::new(
            kind,
            t.table_sql.clone(),
            &names,
            conversions,
            InsertLimits {
                rows: script.rows_per_statement.max(1),
                bytes: STATEMENT_BYTES,
            },
            overriding,
        )
        .as_stored();
        let mut table_rows = 0u64;
        loop {
            if observer.cancelled() {
                return Err(Error::Cancelled);
            }
            let Some(chunk) = source.next_chunk().await? else {
                break;
            };
            if names.is_empty() {
                // A table with no column to write (PostgreSQL allows one) has no INSERT;
                // its rows are counted all the same.
                table_rows += chunk.rows.len() as u64;
                continue;
            }
            for row in chunk.rows {
                let row: Vec<Value> = row.into_iter().map(|v| fix_value(kind, v)).collect();
                table_rows += 1;
                if let Some(s) = builder.push(&row, table_rows)? {
                    pipe.statement(&format!("{};", s.sql)).await?;
                }
                // The builder closes a statement before a row would pass about 1 MB, so
                // an open statement this large holds this row alone (ruling R23).
                if builder.open_bytes() + 1 > MAX_STATEMENT_BYTES {
                    return Err(too_large(&t.label, &names, &key, &row, table_rows));
                }
            }
            progress.rows_done = written.rows + table_rows;
            progress.bytes_done = bytes.load(Ordering::Relaxed);
            progress.statements_done = pipe.statements;
            observer.progress(&progress);
        }
        if let Some(s) = builder.finish() {
            pipe.statement(&format!("{};", s.sql)).await?;
        }
        drop(source);
        written.rows += table_rows;
        if table_rows != t.rows {
            written.warnings.push(format!(
                "{}: {} rows were written, but the header counted {} when the backup started.",
                t.label,
                group(table_rows),
                group(t.rows)
            ));
        }
        progress.tables_done += 1;
        progress.rows_done = written.rows;
        progress.bytes_done = bytes.load(Ordering::Relaxed);
        progress.statements_done = pipe.statements;
        observer.progress_now(&progress);
    }

    pipe.section(Section::AfterRows).await?;
    for s in &script.after_rows {
        if observer.cancelled() {
            return Err(Error::Cancelled);
        }
        pipe.statement(s).await?;
    }
    pipe.section(Section::Finish).await?;
    for s in &script.finish {
        pipe.statement(s).await?;
    }
    // The trailer is the last line; its statement count leaves itself out.
    let mut trailer = Vec::new();
    trailer.push(b'\n');
    format::write_trailer(&mut trailer, pipe.statements, written.rows)
        .map_err(|e| Error::File(e.to_string()))?;
    pipe.put(String::from_utf8_lossy(&trailer).into_owned())
        .await?;
    progress.table = None;
    progress.bytes_done = bytes.load(Ordering::Relaxed);
    progress.statements_done = pipe.statements;
    observer.progress(&progress);
    Ok(())
}

/// A value as a message names it: at most 40 characters.
fn shown(v: &Value) -> String {
    let text = match v {
        Value::Null => return "NULL".into(),
        Value::Bool(b) => return b.to_string(),
        Value::Number(s) => s.clone(),
        Value::Text(s) => format!("'{s}'"),
        Value::Bytes(b) => format!("0x{}", crate::common::hex_lower(&b[..b.len().min(16)])),
    };
    match text.char_indices().nth(40) {
        Some((at, _)) => format!("{}...", &text[..at]),
        None => text,
    }
}

/// Ruling R23: a row over 16 MB as SQL fails the Backup, since Restore cannot read it.
fn too_large(label: &str, names: &[String], key: &[String], row: &[Value], n: u64) -> Error {
    let parts: Vec<String> = key
        .iter()
        .filter_map(|k| {
            let i = names.iter().position(|c| c == k)?;
            Some(format!("{k} = {}", shown(&row[i])))
        })
        .collect();
    let which = if parts.is_empty() || parts.len() != key.len() {
        format!("row {}", group(n))
    } else {
        format!("the row with {}", parts.join(", "))
    };
    Error::JobFailed {
        at: JobPosition {
            table: Some(label.to_string()),
            file_row: Some(n),
            ..JobPosition::default()
        },
        message: format!(
            "{label}: {which} is over 16 MB as SQL, so Restore could not read this file. \
             The unfinished file was deleted."
        ),
    }
}

/// `1503` as `1,503`.
pub fn group(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
#[path = "data_tests.rs"]
mod tests;
