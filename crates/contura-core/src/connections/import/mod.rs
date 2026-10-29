//! The import service: `plan_import`, `check_import_file`, `confirm_import` and
//! `start_import`, for CSV, JSON and Excel files.
//!
//! An import is a Write job. Read-only refuses it before any job starts; Production
//! needs one Job pass bound to the plan's fingerprint and the file's SHA-256.
//! The run streams the file through a reader thread and a channel of 2 chunks into
//! multi-row INSERTs, each run by its own single-statement call under a savepoint.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use super::{ConnectionService, now_ms, plain_message};
use crate::common::grouped;
use crate::common::{sql_ident, sql_string, sql_table};
use crate::design::Increment;
use crate::dialect::Dialect;
use crate::error::{Error, Result};
use crate::jobs::checks::check_value;
use crate::jobs::fingerprint::{JobPlan, job_fingerprint};
use crate::jobs::formats::csv::CsvReader;
use crate::jobs::formats::json::JsonReader;
use crate::jobs::formats::xlsx::XlsxReader;
use crate::jobs::formats::{EXACT_COUNT_BYTES, FileRecord, PREVIEW_ROWS, RecordReader};
use crate::jobs::insert::{
    BuiltStatement, Conversion, InsertBuilder, InsertLimits, conversion_for, row_text, srid_in,
};
use crate::jobs::mapping::{TargetColumn, blockers, column_note, match_by_name, needs_value_text};
use crate::jobs::paths::{HeldFile, PathUse, check_user_path, file_sha256, hex};
use crate::jobs::pipeline::{FileMsg, import_pipeline};
use crate::jobs::source::Value;
use crate::jobs::types::{
    CellProblem, CheckReport, ColumnMap, CommitMode, EmptyAs, Format, ImportPlan, ImportRequest,
    InsertShape, JobId, JobKind, JobPhase, JobPosition, JobProgress, JobReport, JobVerdict,
    OnError, PlannedColumn, PreviewCell,
};
use crate::jobs::writer::{BulkWriter, WriterSetup};
use crate::jobs::{FileIdentity, JobCtx, JobSink};
use crate::model::{ConnectionConfig, DialectKind, ObjectPath};
use crate::query::{NewHistory, Outcome};
use crate::safety::PassId;

/// The sample INSERT holds up to this many rows.
const SAMPLE_ROWS: usize = 500;
/// The shape shows the first rows of the first statement.
const SHAPE_ROWS: usize = 4;
/// Skip lists at most this many rows; one more stops the job.
const SKIP_CAP: u64 = 1_000;
/// The check pass names this many problems.
const CHECK_FIRST: usize = 20;
/// Each statement runs under this savepoint; a failed one is replayed row by row, each
/// row under `ROW_SAVEPOINT`.
const SAVEPOINT: &str = "contura_s";
const ROW_SAVEPOINT: &str = "contura_r";

const TOO_MANY_HEAD: &str = "More than 1,000 rows failed.";
const TOO_MANY: &str = "More than 1,000 rows failed. Nothing was imported.";
/// Binary cells named one by one in warnings; the rest are counted.
const BINARY_WARNINGS: usize = 20;
const STORAGE_UNKNOWN: &str = "Could not check the table's storage engine.";

mod plan;
mod prepare;
mod run;
#[cfg(test)]
mod tests;

use prepare::*;
use run::*;

pub(super) fn blocking_err(e: tokio::task::JoinError) -> Error {
    Error::File(format!("the import's file reader stopped: {e}"))
}

/// The file's path, size and SHA-256, read in one streamed pass.
async fn file_identity(path: &Path, cancel: Arc<AtomicBool>) -> Result<FileIdentity> {
    let owned = path.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<FileIdentity> {
        let sha = file_sha256(&owned, &cancel)?;
        let bytes = std::fs::metadata(&owned)
            .map_err(|e| Error::File(format!("cannot read {}: {e}", owned.display())))?
            .len();
        Ok(FileIdentity {
            path: owned,
            bytes,
            sha256: hex(&sha),
        })
    })
    .await
    .map_err(blocking_err)?
}

pub(super) fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// Where statements are cut: 500 rows or 1 MiB, and below the server's own limit (the
/// plan uses the same). Commit every N below 500 cuts at N, so batches commit at N.
/// A table that does not roll back (MyISAM), or whose engine could not be read, takes
/// one row a statement, so a failure leaves exactly the rows before it and the count of
/// rows kept is exact.
fn insert_limits(
    transactional: Option<bool>,
    commit: CommitMode,
    server_limit: usize,
) -> InsertLimits {
    let d = InsertLimits::default();
    let rows = match (transactional, commit) {
        (Some(true), CommitMode::Every { rows }) => d.rows.min(rows.max(1) as usize),
        (Some(true), CommitMode::Once) => d.rows,
        _ => 1,
    };
    InsertLimits {
        rows,
        bytes: d.bytes.min(server_limit),
    }
}

/// The longest statement the server takes, as the writer reads it (MySQL: half of
/// `max_allowed_packet`), so the plan's sample is cut as the run cuts.
async fn statement_limit(d: &dyn Dialect, kind: DialectKind) -> usize {
    if kind != DialectKind::MySql {
        return usize::MAX;
    }
    let req = crate::jobs::source::SourceRequest::Query {
        database: None,
        sql: "SELECT @@max_allowed_packet".into(),
    };
    let Ok(mut src) = d.open_row_source(&req).await else {
        return usize::MAX;
    };
    let packet = match src.next_chunk().await {
        Ok(Some(chunk)) => chunk.rows.first().and_then(|r| match r.first() {
            Some(Value::Number(n) | Value::Text(n)) => n.trim().parse::<u64>().ok(),
            _ => None,
        }),
        _ => None,
    };
    packet.map_or(usize::MAX, |p| usize::try_from(p / 2).unwrap_or(usize::MAX))
}

/// The Skip cap's sentence: "Nothing was imported." only when nothing stayed.
fn too_many_text(kept: u64, table: &str) -> String {
    match kept {
        0 => TOO_MANY.into(),
        n => format!("{TOO_MANY_HEAD} {}", stayed_text(n, table)),
    }
}

/// "{n} rows were written before the stop and stay in {table}.", for `n` above 0.
fn stayed_text(n: u64, table: &str) -> String {
    match n {
        1 => format!("1 row was written before the stop and stays in {table}."),
        n => format!(
            "{} were written before the stop and stay in {table}.",
            rows_text(n)
        ),
    }
}

/// The MyISAM warning, or the note that the engine could not be read; and whether the
/// table rolls back.
async fn storage_of(d: &dyn Dialect, path: &ObjectPath) -> (Vec<String>, Option<bool>) {
    match d.table_storage(path).await {
        Ok(s) if !s.transactional => (
            vec![format!(
                "{} uses {}: rows written before a failure stay",
                path.name,
                s.engine.as_deref().unwrap_or("MyISAM")
            )],
            Some(false),
        ),
        Ok(_) => (Vec::new(), Some(true)),
        Err(_) => (vec![STORAGE_UNKNOWN.into()], None),
    }
}

/// `n rows`, with the thousands grouped and one row said as one.
pub(super) fn rows_text(n: u64) -> String {
    if n == 1 {
        "1 row".into()
    } else {
        format!("{} rows", grouped(n))
    }
}

pub(super) fn statements_text(n: u64) -> String {
    if n == 1 {
        "1 statement".into()
    } else {
        format!("{} statements", grouped(n))
    }
}

/// What the start's checks hand the run.
struct Checked {
    dialect: Arc<dyn Dialect>,
    prepared: Prepared,
    reader: Box<dyn RecordReader>,
    first: Option<FileRecord>,
    warnings: Vec<String>,
    transactional: Option<bool>,
    expected: Option<[u8; 32]>,
}

impl ConnectionService {
    /// The path guard for an import file; it fails closed without the data folder.
    pub(super) fn guard_import_file(&self, path: &Path) -> Result<()> {
        let data = self.data_dir.as_deref().ok_or_else(|| {
            Error::InvalidInput("Contura cannot find its data folder, so it cannot import.".into())
        })?;
        check_user_path(path, data, PathUse::Import)
    }

    /// Reads the table and the file's header, for the check pass and the run.
    async fn import_prepared(
        &self,
        config: &ConnectionConfig,
        req: &ImportRequest,
        hashed: bool,
    ) -> Result<(Arc<dyn Dialect>, Prepared, Box<dyn RecordReader>)> {
        self.guard_import_file(&req.file)?;
        let d = self.session(config.id).await?;
        let target = load_target(d.as_ref(), config.dialect, &req.table).await?;
        let owned = req.clone();
        let (prepared, reader) = tokio::task::spawn_blocking(move || {
            let (reader, _) = open_reader(&owned, hashed)?;
            let prepared = Prepared::new(target, reader.columns().to_vec(), &owned)?;
            Ok::<_, Error>((prepared, reader))
        })
        .await
        .map_err(blocking_err)??;
        Ok((d, prepared, reader))
    }

    /// Starts check pass `job` (the client's id): it reads the whole file, applies
    /// the checks and takes the SHA-256. Nothing is written; its report has `check`.
    pub async fn check_import_file(
        &self,
        job: JobId,
        req: ImportRequest,
        sink: Arc<dyn JobSink>,
    ) -> Result<JobId> {
        let config = self.config(req.connection_id)?;
        if config.read_only {
            return Err(Error::ReadOnly(0));
        }
        let (_, prepared, reader) = self.import_prepared(&config, &req, true).await?;
        let bytes_total = std::fs::metadata(&req.file).map(|m| m.len()).ok();
        let ctx = self.jobs.start(
            job,
            JobKind::Check,
            config.id,
            &config.name,
            format!("Checking {}", file_name(&req.file)),
            false,
            sink,
        )?;
        let path = req.file.clone();
        tokio::spawn(async move {
            let started = Instant::now();
            let run = tokio::task::spawn_blocking(move || {
                let report = check_all(&ctx, &prepared, reader, bytes_total);
                (ctx, report)
            })
            .await;
            if let Ok((ctx, report)) = run {
                let report = report.map(|(check, read)| JobReport {
                    kind: JobKind::Check,
                    rows_read: check.rows,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    file: Some(path),
                    bytes: read,
                    check: Some(check),
                    ..JobReport::default()
                });
                ctx.finish(report);
            }
        });
        Ok(job)
    }

    /// Starts import `job` (the client's id). Before anything runs, in order:
    /// Read-only refuses (`ReadOnly(0)`); the path guard; Production without a pass
    /// (`NeedsConfirmation`); the file opens with other writers refused; the job
    /// registers, which holds `JobBusy` for the Connection from here on; the table and
    /// the file's first record are read through that handle and the blockers refuse the
    /// start (`InvalidInput`). Only then is the Production pass spent: the held
    /// bytes must be the file the pass was confirmed for (`FileChanged`) and the pass
    /// must cover this job's fingerprint (`NeedsConfirmation`). A start refused after the
    /// job registered leaves no job and no final event. The run goes on in the background
    /// and adds one history entry.
    pub async fn start_import(
        &self,
        job: JobId,
        req: ImportRequest,
        pass: Option<PassId>,
        sink: Arc<dyn JobSink>,
    ) -> Result<JobId> {
        let config = self.config(req.connection_id)?;
        if config.read_only {
            return Err(Error::ReadOnly(0));
        }
        self.guard_import_file(&req.file)?;
        if config.production && pass.is_none() {
            return Err(Error::NeedsConfirmation);
        }
        let held = HeldFile::open(&req.file)?;
        let ctx = self.jobs.start(
            job,
            JobKind::Import,
            config.id,
            &config.name,
            format!("Importing into {}", req.table.name),
            true,
            sink,
        )?;
        let cancel = ctx.cancel_flag().clone();
        let checked = match self
            .import_checked(&config, &req, pass, &held, cancel)
            .await
        {
            Ok(c) => c,
            Err(e) => {
                ctx.discard();
                return Err(e);
            }
        };
        for w in &checked.warnings {
            ctx.warning(w.clone());
        }
        let run = Run {
            ctx,
            connection_id: config.id,
            dialect: checked.dialect,
            prepared: checked.prepared,
            reader: Mutex::new(Some(checked.reader)),
            first: checked.first,
            expected: checked.expected,
            on_error: req.options.on_error,
            commit: req.options.commit,
            // Unknown is counted as not rolling back: exact counts over speed.
            transactional: checked.transactional,
            path: req.file.clone(),
            file_bytes: held.bytes(),
            held: Some(held),
            production: config.production,
            warnings: checked.warnings,
        };
        tokio::spawn(run.go());
        Ok(job)
    }

    /// The start's checks once the job is registered: the table, the reader through the
    /// held handle and its first record, the blockers, the table's storage, then the
    /// Production pass.
    async fn import_checked(
        &self,
        config: &ConnectionConfig,
        req: &ImportRequest,
        pass: Option<PassId>,
        held: &HeldFile,
        cancel: Arc<AtomicBool>,
    ) -> Result<Checked> {
        let d = self.session(config.id).await?;
        let target = load_target(d.as_ref(), config.dialect, &req.table).await?;
        let (owned, file) = (req.clone(), held.clone());
        let (prepared, reader, first) = tokio::task::spawn_blocking(move || {
            let mut reader = open_held_reader(&owned, &file)?;
            let prepared = Prepared::new(target, reader.columns().to_vec(), &owned)?;
            let first = reader.next_record()?;
            Ok::<_, Error>((prepared, reader, first))
        })
        .await
        .map_err(blocking_err)??;
        let reasons = prepared.blockers(first.is_some());
        if !reasons.is_empty() {
            return Err(Error::InvalidInput(reasons.join(" ")));
        }
        let (warnings, transactional) = storage_of(d.as_ref(), &req.table).await;
        let mut expected = None;
        if config.production {
            let pass = pass.ok_or(Error::NeedsConfirmation)?;
            let file = held.clone();
            let sha = tokio::task::spawn_blocking(move || file.sha256(&cancel))
                .await
                .map_err(blocking_err)??;
            let id = FileIdentity {
                path: req.file.clone(),
                bytes: held.bytes(),
                sha256: hex(&sha),
            };
            if let Some(confirmed) = self.jobs.confirmed_file(pass)
                && confirmed != id
            {
                self.jobs.forget_file(pass);
                return Err(Error::FileChanged {
                    file: file_name(&req.file),
                    confirmed: true,
                });
            }
            let fp = job_fingerprint(&prepared.job_plan(req, id)?)?;
            self.authorize_job(config, fp, Some(pass))?;
            self.jobs.forget_file(pass);
            expected = Some(sha);
        } else {
            self.authorize_job(config, [0; 32], pass)?;
        }
        Ok(Checked {
            dialect: d,
            prepared,
            reader,
            first,
            warnings,
            transactional,
            expected,
        })
    }
}
