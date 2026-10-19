//! The Restore service (step 9): `inspect_restore` (the check pass as a job),
//! `plan_restore`, `restore_statements`, `confirm_restore` and `start_restore`, and the
//! Restore run.
//!
//! Restore is a Write job. Read-only refuses every call with `ReadOnly(0)` before the file
//! is read past its header. On Production the start needs the Job pass issued for the
//! plan's fingerprint, which covers the file's SHA-256 and every statement Contura adds.
//! The start opens the file once with other writers refused, checks it again through
//! that handle, and the run reads the same handle, hashing it again; the hash is checked
//! before COMMIT.
//!
//! Run order (R15): `CREATE DATABASE` on its own line on the maintenance connection,
//! then (MySQL Replace) "Back up these tables first", then the session setup on the
//! writer, the Replace drops, the file's statements in file order (skipped ones left out
//! unless Run as is), the row counts against the header, then `after`. Every statement
//! runs by its own single-statement call. PostgreSQL and SQLite run in one transaction;
//! MySQL commits each DDL statement and the rows of each table section, and stops at the
//! first error. On failure or Cancel the run rolls back and, in Into a new database
//! mode, drops the database it created (SQLite: deletes the new file).

use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tokio::sync::mpsc;

use super::import::{blocking_err, file_name};
use super::{ConnectionService, now_ms, plain_message};
use crate::backup::restore::{
    self as rs, Class, RestoreCheck, RestoreMode, RestoreOutcome, RestorePlan, RestoreRequest,
    RestoreTarget, Walker,
};
use crate::common::sql_ident;
use crate::dialect::Dialect;
use crate::error::{Error, Result};
use crate::jobs::formats::read_err;
use crate::jobs::formats::xlsx::grouped;
use crate::jobs::paths::{PathUse, check_user_path, hex, open_locked};
use crate::jobs::script::{Facts, ScriptReader, calls_sequence_write, insert_table};
use crate::jobs::types::{
    JobId, JobKind, JobPhase, JobPosition, JobProgress, JobReport, JobVerdict, RestoreStep,
    ScriptStatement, StatementKind,
};
use crate::jobs::writer::{BulkWriter, WriterSetup};
use crate::jobs::{FileIdentity, JobCtx, JobSink};
use crate::model::{ConnectionConfig, DialectKind};
use crate::query::{NewHistory, Outcome};
use crate::safety::PassId;

/// Statements between the file reader and the run.
const CHANNEL: usize = 2;
/// The structure statements a history entry keeps, in bytes.
const HISTORY_BYTES: usize = 64 * 1024;

/// A lowercase hex SHA-256 as bytes.
fn unhex32(s: &str) -> Result<[u8; 32]> {
    let bad = || Error::InvalidInput("The plan's fingerprint is not a SHA-256.".into());
    if s.len() != 64 || !s.is_ascii() {
        return Err(bad());
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).map_err(|_| bad())?;
    }
    Ok(out)
}

/// A Blocked plan as the error a confirm or a start gives: the first refused statement
/// (`BackupRefused`), else the reasons.
fn blocked(check: &RestoreCheck, plan: &RestorePlan) -> Result<()> {
    if let JobVerdict::Blocked { reasons } = &plan.verdict {
        return Err(
            rs::refusal_error(check).unwrap_or_else(|| Error::InvalidInput(reasons.join(" ")))
        );
    }
    Ok(())
}

fn identity(req: &RestoreRequest, check: &RestoreCheck) -> FileIdentity {
    FileIdentity {
        path: req.path.clone(),
        bytes: check.bytes,
        sha256: check.sha256.clone(),
    }
}

/// The server's words without their last full stop, so a sentence can follow.
fn words(message: &str) -> &str {
    message.trim_end().trim_end_matches('.')
}

/// A statement's first line, at most 100 characters, for "Now".
fn first_line(text: &str) -> String {
    let line = text.trim_start().lines().next().unwrap_or("").trim_end();
    match line.char_indices().nth(100) {
        Some((at, _)) => format!("{}...", &line[..at]),
        None => line.to_string(),
    }
}

impl ConnectionService {
    /// The Connection of a Restore: Read-only refuses every Restore call (`ReadOnly(0)`).
    fn restore_config(&self, id: crate::model::ConnectionId) -> Result<ConnectionConfig> {
        let config = self.config(id)?;
        if config.read_only {
            return Err(Error::ReadOnly(0));
        }
        Ok(config)
    }

    /// The path guard on the Backup file and, for a SQLite Into a new database, on the
    /// new file: neither may be in Contura's data folder.
    fn guard_restore(&self, config: &ConnectionConfig, req: &RestoreRequest) -> Result<()> {
        self.guard_import_file(&req.path)?;
        if config.dialect == DialectKind::Sqlite
            && let RestoreMode::NewDatabase { name } = &req.mode
            && !name.trim().is_empty()
        {
            let data = self.data_dir.as_deref().ok_or_else(|| {
                Error::InvalidInput(
                    "Contura cannot find its data folder, so it cannot restore.".into(),
                )
            })?;
            check_user_path(Path::new(name.trim()), data, PathUse::Database)?;
        }
        Ok(())
    }

    /// Starts the check pass `job` on `path` (a job of kind `restoreCheck`, so a large
    /// file shows progress and can be cancelled). Its finished report carries the
    /// `restoreCheck`. Read-only is refused here, before the file is opened; a damaged,
    /// cut or other-Dialect file, or one with a statement over 16 MB, fails the job.
    pub async fn inspect_restore(
        &self,
        job: JobId,
        target: RestoreTarget,
        path: PathBuf,
        sink: Arc<dyn JobSink>,
    ) -> Result<JobId> {
        let config = self.restore_config(target.connection_id)?;
        self.guard_import_file(&path)?;
        let d = self.session(config.id).await?;
        let total = std::fs::metadata(&path).map(|m| m.len()).ok();
        let ctx = self.jobs.start(
            job,
            JobKind::RestoreCheck,
            config.id,
            &config.name,
            format!("Checking {}", file_name(&path)),
            false,
            sink,
        )?;
        tokio::spawn(async move {
            let started = Instant::now();
            let (cfg, p) = (config.clone(), path.clone());
            let joined = tokio::task::spawn_blocking(move || {
                let file = {
                    let mut sent = |bytes: u64, statements: u64| {
                        ctx.progress(JobProgress {
                            phase: JobPhase::Checking,
                            bytes_done: bytes,
                            bytes_total: total,
                            statements_done: statements,
                            ..JobProgress::default()
                        })
                    };
                    rs::inspect_file(&cfg, &p, false, &|| ctx.is_cancelled(), &mut sent)
                };
                (ctx, file)
            })
            .await;
            // A reader that panicked dropped the context, which fails the job.
            let Ok((ctx, file)) = joined else { return };
            let result = match file {
                Ok(file) => rs::check_target(d.as_ref(), &config, &target, &path, file).await,
                Err(e) => Err(e),
            };
            let result = match result {
                Err(_) if ctx.is_cancelled() => Err(Error::Cancelled),
                other => other,
            };
            let elapsed_ms = started.elapsed().as_millis() as u64;
            ctx.finish(result.map(|check| JobReport {
                kind: JobKind::RestoreCheck,
                statements: check.statements,
                bytes: check.bytes,
                file: Some(path.clone()),
                elapsed_ms,
                restore_check: Some(Box::new(check)),
                ..JobReport::default()
            }));
        });
        Ok(job)
    }

    /// The confirmation: the file and the target checked again for `req`, and the plan.
    pub async fn plan_restore(&self, req: RestoreRequest) -> Result<RestorePlan> {
        let config = self.restore_config(req.target.connection_id)?;
        self.guard_restore(&config, &req)?;
        let d = self.session(config.id).await?;
        rs::plan_restore(d, config, req).await
    }

    /// Up to 100 of the plan's structure statements from position `from`, read from the
    /// file on demand.
    pub async fn restore_statements(
        &self,
        req: RestoreRequest,
        from: u32,
    ) -> Result<Vec<ScriptStatement>> {
        let config = self.restore_config(req.target.connection_id)?;
        self.guard_restore(&config, &req)?;
        rs::restore_statements(config, req, from).await
    }

    /// Checks the file and the target again and issues the Job pass for the plan's
    /// fingerprint, with the file it was confirmed for. A Blocked plan is refused.
    pub async fn confirm_restore(&self, req: RestoreRequest) -> Result<PassId> {
        let config = self.restore_config(req.target.connection_id)?;
        self.guard_restore(&config, &req)?;
        let d = self.session(config.id).await?;
        let check = rs::inspect_restore(
            d,
            config.clone(),
            req.target.clone(),
            req.path.clone(),
            req.run_as_is,
        )
        .await?;
        let plan = rs::build_plan(&config, &req, &check)?;
        blocked(&check, &plan)?;
        self.issue_job_pass(
            config.id,
            unhex32(&plan.fingerprint)?,
            Some(identity(&req, &check)),
        )
    }

    /// Starts Restore `job` (the client's id). `fingerprint` is the plan the user
    /// reviewed (R28, every Connection). Before anything writes, in order: Read-only
    /// (`ReadOnly(0)`); the path guard; no fingerprint (`InvalidInput`); Production
    /// without a pass (`NeedsConfirmation`); the file opens with other writers refused;
    /// the job registers, which holds `JobBusy` for the Connection (one write job per
    /// target); the Job pass is checked against the reviewed fingerprint and spent, before
    /// any full read of the file (R31), so a large file cannot outlive its pass; then the
    /// file is checked again through that handle with Checking progress, the target is
    /// read and the plan built, and its fingerprint must equal the reviewed one
    /// (`FileChanged` otherwise); a Blocked plan is refused. The run's streaming re-hash
    /// before COMMIT stays the file guard. A start refused after the job registered
    /// leaves no job and no final event.
    pub async fn start_restore(
        &self,
        job: JobId,
        req: RestoreRequest,
        fingerprint: String,
        pass: Option<PassId>,
        sink: Arc<dyn JobSink>,
    ) -> Result<JobId> {
        let config = self.restore_config(req.target.connection_id)?;
        self.guard_restore(&config, &req)?;
        if fingerprint.is_empty() {
            return Err(Error::InvalidInput(
                "Review the restore's SQL before it starts.".into(),
            ));
        }
        let reviewed = unhex32(&fingerprint)?;
        if config.production && pass.is_none() {
            return Err(Error::NeedsConfirmation);
        }
        let data_dir = self.data_dir.clone().ok_or_else(|| {
            Error::InvalidInput("Contura cannot find its data folder, so it cannot restore.".into())
        })?;
        let d = self.session(config.id).await?;
        let file = open_locked(&req.path)?;
        let ctx = self.jobs.start(
            job,
            JobKind::Restore,
            config.id,
            &config.name,
            format!("Restoring {}", file_name(&req.path)),
            true,
            sink,
        )?;
        // R31: the pass first, against what the user reviewed.
        if let Err(e) = self.authorize_job(&config, reviewed, pass) {
            ctx.discard();
            return Err(e);
        }
        if let Some(pass) = pass {
            self.jobs.forget_file(pass);
        }
        let (ctx, checked) = self
            .restore_checked(&config, &d, &req, &fingerprint, &file, ctx)
            .await?;
        let (check, plan) = match checked {
            Ok(v) => v,
            Err(e) => {
                ctx.discard();
                return Err(e);
            }
        };
        let hold = match file.try_clone() {
            Ok(h) => h,
            Err(e) => {
                ctx.discard();
                return Err(read_err(Some(&req.path), e));
            }
        };
        let run = RestoreRun {
            ctx,
            config,
            d,
            req,
            check,
            plan,
            file: Some(file),
            hold: Some(hold),
            data_dir,
        };
        tokio::spawn(run.go());
        Ok(job)
    }

    /// The start's checks once the job is registered. Gives the context back with the
    /// outcome, so the caller can discard it on a refusal.
    #[allow(clippy::type_complexity)]
    async fn restore_checked(
        &self,
        config: &ConnectionConfig,
        d: &Arc<dyn Dialect>,
        req: &RestoreRequest,
        reviewed: &str,
        file: &File,
        ctx: JobCtx,
    ) -> Result<(JobCtx, Result<(RestoreCheck, RestorePlan)>)> {
        let held = match file.try_clone() {
            Ok(f) => f,
            Err(e) => {
                ctx.discard();
                return Err(read_err(Some(&req.path), e));
            }
        };
        let total = file.metadata().map(|m| m.len()).ok();
        let (cfg, path, run_as_is) = (config.clone(), req.path.clone(), req.run_as_is);
        let (ctx, scanned) = tokio::task::spawn_blocking(move || {
            let scanned = {
                let mut sent = |bytes: u64, statements: u64| {
                    ctx.progress(JobProgress {
                        phase: JobPhase::Checking,
                        bytes_done: bytes,
                        bytes_total: total,
                        statements_done: statements,
                        ..JobProgress::default()
                    })
                };
                rs::inspect_held(
                    &cfg,
                    &path,
                    held,
                    run_as_is,
                    &|| ctx.is_cancelled(),
                    &mut sent,
                )
            };
            (ctx, scanned)
        })
        .await
        .map_err(blocking_err)?;
        let checked = match scanned {
            Ok(file) => self.restore_planned(config, d, req, reviewed, file).await,
            Err(e) => Err(e),
        };
        Ok((ctx, checked))
    }

    /// The target and the plan; its fingerprint must be the reviewed one (R28): another
    /// file, mode or target gives `FileChanged`. Then a Blocked plan is refused.
    async fn restore_planned(
        &self,
        config: &ConnectionConfig,
        d: &Arc<dyn Dialect>,
        req: &RestoreRequest,
        reviewed: &str,
        file: rs::FileCheck,
    ) -> Result<(RestoreCheck, RestorePlan)> {
        let check = rs::check_target(d.as_ref(), config, &req.target, &req.path, file).await?;
        let plan = rs::build_plan(config, req, &check)?;
        if !plan.fingerprint.eq_ignore_ascii_case(reviewed) {
            return Err(Error::FileChanged {
                file: file_name(&req.path),
                confirmed: config.production,
            });
        }
        blocked(&check, &plan)?;
        Ok((check, plan))
    }
}

/// What the file reader sends the run.
enum Msg {
    Statement {
        s: ScriptStatement,
        facts: Facts,
        bytes: u64,
    },
    End {
        sha: Option<[u8; 32]>,
        bytes: u64,
    },
    Failed(Error),
}

/// Reads the held file on a blocking thread, at most `limit` bytes, one statement at a
/// time through a channel of 2. It stops on cancel or when the receiver is dropped.
fn read_statements(
    path: PathBuf,
    file: File,
    limit: u64,
    kind: DialectKind,
    run_as_is: bool,
    cancel: Arc<AtomicBool>,
) -> (mpsc::Receiver<Msg>, tokio::task::JoinHandle<()>) {
    let (tx, rx) = mpsc::channel(CHANNEL);
    let reader = tokio::task::spawn_blocking(move || {
        let mut r = match ScriptReader::from_file(&path, file, limit, kind, run_as_is) {
            Ok(r) => r,
            Err(e) => {
                let _ = tx.blocking_send(Msg::Failed(e));
                return;
            }
        };
        loop {
            if cancel.load(Ordering::SeqCst) {
                return;
            }
            let msg = match r.next_checked() {
                Ok(Some((s, facts))) => Msg::Statement {
                    s,
                    facts,
                    bytes: r.bytes_read(),
                },
                Ok(None) => Msg::End {
                    sha: r.sha256(),
                    bytes: r.bytes_read(),
                },
                Err(e) => Msg::Failed(e),
            };
            let last = !matches!(msg, Msg::Statement { .. });
            if tx.blocking_send(msg).is_err() || last {
                return;
            }
        }
    });
    (rx, reader)
}

/// Why a run stopped, before the outcome sentence is added.
enum Stop {
    /// A statement of the file: its number (1-based), line and the server's words.
    Statement {
        number: u64,
        line: u32,
        message: String,
    },
    /// A statement Contura adds (CREATE DATABASE, setup, DROP, count, COMMIT).
    Added {
        text: String,
        message: String,
    },
    /// A row count that does not match the header: the sentence before the outcome.
    Count(String),
    /// SQLite's `foreign_key_check` found a row in this table.
    ForeignKey(String),
    /// "Back up these tables first" failed: nothing was dropped.
    BackupFirst(String),
    Error(Error),
}

impl From<Error> for Stop {
    fn from(e: Error) -> Self {
        Stop::Error(e)
    }
}

/// What the run did so far, kept apart from the run so the cleanup sees it.
#[derive(Default)]
struct Done {
    /// File statements run.
    ran: u64,
    /// INSERTs shown as a shape that ran.
    inserts: u64,
    rows: u64,
    skipped: u64,
    /// Rows in for good (MySQL: committed table sections and rows outside them).
    committed: u64,
    /// MySQL: rows in the open table section.
    open_rows: u64,
    bytes: u64,
    step: Option<RestoreStep>,
    now: Option<String>,
    /// This run created the new database (MySQL, PostgreSQL).
    created_db: bool,
    /// This run created the new SQLite file.
    created_file: Option<PathBuf>,
    /// The new SQLite file's Dialect, closed before the file is deleted.
    new_dialect: Option<Arc<dyn Dialect>>,
    /// MySQL: the table whose rows are in the open transaction.
    section: Option<String>,
    /// Rows so far per table, for "rows 154,001 to 154,500".
    table_rows: HashMap<String, u64>,
    counts_match: bool,
    /// Replace drops that ran (MySQL commits each one).
    drops_ran: u64,
}

/// One Restore job, moved into its task.
struct RestoreRun {
    ctx: JobCtx,
    config: ConnectionConfig,
    d: Arc<dyn Dialect>,
    req: RestoreRequest,
    check: RestoreCheck,
    plan: RestorePlan,
    /// The handle the start checked; the reader takes it.
    file: Option<File>,
    /// A second handle on the same open, so other writers stay refused until the job
    /// ends. Closed before the final event.
    hold: Option<File>,
    data_dir: PathBuf,
}

impl RestoreRun {
    fn mysql(&self) -> bool {
        self.config.dialect == DialectKind::MySql
    }

    /// The file statements the run runs (R32 M-3): every statement read, less those it
    /// skips. "n of m statements ran" and "Statement k" count in this one set.
    fn run_total(&self) -> u64 {
        if self.req.run_as_is {
            self.check.statements
        } else {
            let skipped = self.check.skipped.len() as u64 + self.check.skipped_more;
            self.check.statements.saturating_sub(skipped)
        }
    }

    fn changed(&self) -> Error {
        Error::FileChanged {
            file: file_name(&self.req.path),
            confirmed: self.config.production,
        }
    }

    /// `make` with the server's words, or `Cancelled` when the job was cancelled (a
    /// cancelled statement fails).
    fn fail(&self, e: Error, make: impl FnOnce(String) -> Stop) -> Stop {
        if self.ctx.is_cancelled() {
            Stop::Error(Error::Cancelled)
        } else {
            make(plain_message(&e))
        }
    }

    fn cancelled(&self) -> std::result::Result<(), Stop> {
        if self.ctx.is_cancelled() {
            Err(Stop::Error(Error::Cancelled))
        } else {
            Ok(())
        }
    }

    fn progress(&self, st: &Done, phase: JobPhase, now_anyway: bool) {
        let p = JobProgress {
            phase,
            rows_done: st.rows,
            rows_total: None,
            bytes_done: st.bytes,
            bytes_total: Some(self.check.bytes),
            statements_done: st.ran,
            restore_step: st.step,
            inserts_done: Some(st.inserts),
            now: st.now.clone(),
            ..JobProgress::default()
        };
        if now_anyway {
            self.ctx.progress_now(p);
        } else {
            self.ctx.progress(p);
        }
    }

    /// Runs a statement Contura adds.
    async fn added(&self, w: &mut dyn BulkWriter, text: &str) -> std::result::Result<(), Stop> {
        self.cancelled()?;
        w.run(text).await.map(drop).map_err(|e| {
            self.fail(e, |message| Stop::Added {
                text: text.to_string(),
                message,
            })
        })
    }

    /// MySQL: commits the open table section.
    async fn end_section(
        &self,
        w: &mut dyn BulkWriter,
        st: &mut Done,
    ) -> std::result::Result<(), Stop> {
        if st.section.take().is_some() {
            w.commit().await.map_err(|e| {
                self.fail(e, |message| Stop::Added {
                    text: "COMMIT".into(),
                    message,
                })
            })?;
            st.committed += std::mem::take(&mut st.open_rows);
        }
        Ok(())
    }

    async fn run_file(
        &self,
        w: &mut dyn BulkWriter,
        s: &ScriptStatement,
        number: u64,
    ) -> std::result::Result<u64, Stop> {
        w.run(&s.text).await.map_err(|e| {
            self.fail(e, |message| Stop::Statement {
                number,
                line: s.line,
                message,
            })
        })
    }

    /// Runs one statement of the file, or skips it.
    async fn statement(
        &self,
        w: &mut dyn BulkWriter,
        st: &mut Done,
        walker: &mut Walker<'_>,
        s: ScriptStatement,
        facts: &Facts,
    ) -> std::result::Result<(), Stop> {
        let dialect = self.config.dialect;
        match walker.step(&s, facts) {
            // The start found no refused statement: the file changed since.
            Class::Refused(_) => return Err(Stop::Error(self.changed())),
            Class::Skipped(_) => {
                st.skipped += 1;
                return Ok(());
            }
            Class::Shape(shape) => {
                let table = insert_table(dialect, &s.text)
                    .map(|n| n.join("."))
                    .unwrap_or_default();
                st.step = Some(RestoreStep::Rows);
                if self.mysql() && st.section.as_deref() != Some(table.as_str()) {
                    self.end_section(w, st).await?;
                    w.begin().await.map_err(|e| {
                        self.fail(e, |message| Stop::Added {
                            text: "START TRANSACTION".into(),
                            message,
                        })
                    })?;
                    st.section = Some(table.clone());
                }
                let done = st.table_rows.entry(table.clone()).or_default();
                st.now = Some(format!(
                    "INSERT INTO {table}, rows {} to {}",
                    grouped(*done + 1),
                    grouped(*done + shape.rows)
                ));
                *done += shape.rows;
                let n = self.run_file(w, &s, st.ran + 1).await?;
                st.inserts += 1;
                st.rows += n;
                if self.mysql() {
                    st.open_rows += n;
                }
            }
            Class::Exact => {
                if self.mysql() {
                    self.end_section(w, st).await?;
                }
                st.step = Some(if st.inserts == 0 {
                    RestoreStep::Structure
                } else if dialect == DialectKind::Postgres && calls_sequence_write(dialect, &s.text)
                {
                    RestoreStep::Sequences
                } else {
                    RestoreStep::AfterRows
                });
                st.now = Some(first_line(&s.text));
                let n = self.run_file(w, &s, st.ran + 1).await?;
                // SQLite's AUTOINCREMENT counters are not rows of the file's tables.
                let counter = dialect == DialectKind::Sqlite
                    && insert_table(dialect, &s.text).is_some_and(|t| {
                        t.last()
                            .is_some_and(|n| n.eq_ignore_ascii_case("sqlite_sequence"))
                    });
                if s.kind == StatementKind::Insert && !counter {
                    st.rows += n;
                    if self.mysql() {
                        st.committed += n;
                    }
                }
            }
        }
        st.ran += 1;
        Ok(())
    }

    /// The row counts against the header, in the run's own transaction where it has one.
    async fn counts(&self, w: &mut dyn BulkWriter, st: &mut Done) -> std::result::Result<(), Stop> {
        let Some(header) = &self.check.backup_header else {
            return Ok(());
        };
        let dialect = self.config.dialect;
        st.step = Some(RestoreStep::Counts);
        st.now = None;
        self.progress(st, JobPhase::Writing, true);
        for (label, expected) in &header.rows {
            self.cancelled()?;
            let table: Vec<String> = rs::label_parts(dialect, header.schema.as_deref(), label)
                .iter()
                .map(|p| sql_ident(dialect, p))
                .collect();
            let table = table.join(".");
            let sql = if dialect == DialectKind::Postgres {
                format!("SELECT count(*)::text FROM {table}")
            } else {
                format!("SELECT count(*) FROM {table}")
            };
            let got = w
                .first_value(&sql)
                .await
                .map_err(|e| {
                    self.fail(e, |message| Stop::Added {
                        text: sql.clone(),
                        message,
                    })
                })?
                .and_then(|v| v.trim().parse::<u64>().ok())
                .unwrap_or(0);
            if got != *expected {
                return Err(Stop::Count(format!(
                    "{label}: the file says {} rows, {} were restored.",
                    grouped(*expected),
                    grouped(got)
                )));
            }
        }
        st.counts_match = true;
        Ok(())
    }

    /// Everything the run does, in the shown order. The writer and the maintenance
    /// connection are handed back through `writer` and `maint`, so the caller can roll
    /// back and clean up.
    async fn work(
        &self,
        st: &mut Done,
        writer: &mut Option<Box<dyn BulkWriter>>,
        maint: &mut Option<Box<dyn BulkWriter>>,
        rx: &mut mpsc::Receiver<Msg>,
    ) -> std::result::Result<(), Stop> {
        let dialect = self.config.dialect;
        // The new database, on its own.
        if let Some(create) = &self.plan.create_database {
            st.step = Some(RestoreStep::Database);
            st.now = Some(create.text.clone());
            self.progress(st, JobPhase::Writing, true);
            let m = maint.insert(
                self.d
                    .open_bulk_writer(None, &WriterSetup::default())
                    .await?,
            );
            self.added(m.as_mut(), &create.text).await?;
            st.created_db = true;
        }
        if let Some(path) = &self.plan.delete_file {
            st.step = Some(RestoreStep::Database);
            self.progress(st, JobPhase::Writing, true);
            let p = path.clone();
            tokio::task::spawn_blocking(move || crate::sqlite::create_database(&p))
                .await
                .map_err(blocking_err)??;
            st.created_file = Some(path.clone());
            let mut cfg = self.config.clone();
            cfg.file = Some(path.clone());
            st.new_dialect = Some(crate::dialect::connect(&cfg, None).await?);
        }
        self.cancelled()?;
        // MySQL Replace: "Back up these tables first", before any DROP.
        if let Some(path) = &self.plan.backup_first_path {
            let database = self.plan.database.clone().unwrap_or_default();
            st.now = Some(format!("Backing up {database} to {path}"));
            self.progress(st, JobPhase::Writing, true);
            super::backup::backup_first(
                self.d.as_ref(),
                &self.config,
                &self.data_dir,
                &database,
                &self.plan.backup_first_tables,
                Path::new(path),
                &self.ctx,
            )
            .await
            .map_err(|e| self.fail(e, Stop::BackupFirst))?;
        }
        self.cancelled()?;
        // The writer.
        let on = st.new_dialect.clone().unwrap_or_else(|| self.d.clone());
        let database = match dialect {
            DialectKind::Sqlite => None,
            _ => self.plan.database.clone(),
        };
        let w = writer.insert(
            on.open_bulk_writer(database.as_deref(), &WriterSetup::default())
                .await?,
        );
        // MySQL's Cancel stops after the current statement.
        if dialect != DialectKind::MySql {
            self.ctx.set_canceller(w.canceller());
        }
        st.step = Some(RestoreStep::Structure);
        for s in &self.plan.setup {
            st.now = Some(s.text.clone());
            self.added(w.as_mut(), &s.text).await?;
        }
        for s in &self.plan.drops {
            st.now = Some(first_line(&s.text));
            self.progress(st, JobPhase::Writing, false);
            self.added(w.as_mut(), &s.text).await?;
            st.drops_ran += 1;
        }
        // The file, in file order.
        let mut walker = Walker::new(dialect, self.check.backup_header.as_ref());
        let (sha, bytes) = loop {
            self.cancelled()?;
            let Some(msg) = rx.recv().await else {
                self.cancelled()?;
                return Err(Error::File("the Backup's file reader stopped".into()).into());
            };
            match msg {
                Msg::Statement { s, facts, bytes } => {
                    st.bytes = bytes;
                    self.statement(w.as_mut(), st, &mut walker, s, &facts)
                        .await?;
                    self.progress(st, JobPhase::Writing, false);
                }
                Msg::End { sha, bytes } => {
                    st.bytes = bytes;
                    break (sha, bytes);
                }
                Msg::Failed(e) => return Err(e.into()),
            }
        };
        if bytes != self.check.bytes || sha.map(|h| hex(&h)).as_deref() != Some(&self.check.sha256)
        {
            return Err(self.changed().into());
        }
        if self.mysql() {
            self.end_section(w.as_mut(), st).await?;
        }
        // What Contura runs after the file; the counts come right before COMMIT.
        let mut counted = false;
        for s in &self.plan.after {
            self.cancelled()?;
            let text = s.text.as_str();
            if text == "PRAGMA foreign_key_check" {
                st.now = Some(text.to_string());
                match w.first_value(text).await {
                    Ok(Some(table)) => return Err(Stop::ForeignKey(table)),
                    Ok(None) => {}
                    Err(e) => {
                        return Err(self.fail(e, |message| Stop::Added {
                            text: text.to_string(),
                            message,
                        }));
                    }
                }
            } else if text == "COMMIT" {
                self.counts(w.as_mut(), st).await?;
                counted = true;
                self.cancelled()?;
                self.progress(st, JobPhase::Committing, true);
                w.commit().await.map_err(|e| {
                    self.fail(e, |message| Stop::Added {
                        text: "COMMIT".into(),
                        message,
                    })
                })?;
                st.committed = st.rows;
            } else if let Err(e) = w.run(text).await {
                // A setting put back after the COMMIT: the restore is in.
                self.ctx
                    .warning(format!("{text} failed: {}.", words(&plain_message(&e))));
            }
        }
        if !counted {
            self.counts(w.as_mut(), st).await?;
        }
        Ok(())
    }

    /// Drops the database this run created, or deletes the new SQLite file. None when
    /// there was nothing to remove; else the name, and the error when it stayed.
    async fn remove_new(
        &self,
        st: &mut Done,
        maint: &mut Option<Box<dyn BulkWriter>>,
    ) -> Option<(String, Option<String>)> {
        if st.created_db {
            let name = match &self.plan.mode {
                RestoreMode::NewDatabase { name } => name.clone(),
                _ => String::new(),
            };
            let text = self.plan.cleanup.first()?.clone();
            if maint.is_none() {
                match self.d.open_bulk_writer(None, &WriterSetup::default()).await {
                    Ok(m) => *maint = Some(m),
                    Err(e) => return Some((name, Some(plain_message(&e)))),
                }
            }
            let m = maint.as_mut()?;
            // The writer's own connection may still be closing on the server.
            let mut tries = 0;
            loop {
                match m.run(&text).await {
                    Ok(_) => return Some((name, None)),
                    Err(_) if tries < 20 && self.config.dialect == DialectKind::Postgres => {
                        tries += 1;
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                    Err(e) => return Some((name, Some(plain_message(&e)))),
                }
            }
        }
        if let Some(path) = st.created_file.take() {
            if let Some(d) = st.new_dialect.take() {
                let _ = d.disconnect().await;
            }
            let name = file_name(&path);
            let mut tries = 0;
            loop {
                let gone = match std::fs::remove_file(&path) {
                    Ok(()) => Ok(()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(e) => Err(e),
                };
                match gone {
                    Ok(()) => {
                        for end in ["-journal", "-wal", "-shm"] {
                            let mut side = path.clone().into_os_string();
                            side.push(end);
                            let _ = std::fs::remove_file(PathBuf::from(side));
                        }
                        return Some((name, None));
                    }
                    Err(_) if tries < 20 => {
                        tries += 1;
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                    Err(e) => return Some((name, Some(e.to_string()))),
                }
            }
        }
        None
    }

    /// The error the job ends with, after the clean up: the spec's line per Dialect.
    async fn stopped(
        &self,
        stop: Stop,
        st: &mut Done,
        maint: &mut Option<Box<dyn BulkWriter>>,
    ) -> Error {
        let mysql = self.mysql();
        // MySQL commits as it goes: a count that does not match leaves the rows.
        let keep = mysql && matches!(stop, Stop::Count(_));
        let removed = if keep {
            None
        } else {
            self.remove_new(st, maint).await
        };
        let outcome = match &removed {
            None => String::new(),
            Some((name, None)) => format!(" {name} was removed."),
            Some((name, Some(e))) => format!(" {name} could not be removed: {}.", words(e)),
        };
        let ran = format!(
            "{} of {} statements ran.",
            grouped(st.ran),
            grouped(self.run_total())
        );
        let mut at = JobPosition::default();
        let message = match stop {
            Stop::Error(Error::Cancelled) => {
                if let Some((name, Some(e))) = &removed {
                    self.ctx
                        .warning(format!("{name} could not be removed: {}.", words(e)));
                }
                return Error::Cancelled;
            }
            Stop::Error(e @ Error::FileChanged { .. }) => {
                if mysql && (st.ran > 0 || st.drops_ran > 0) && !st.created_db {
                    format!(
                        "{} changed while it was restored. {ran}",
                        file_name(&self.req.path)
                    )
                } else {
                    if let Some((name, Some(m))) = &removed {
                        self.ctx
                            .warning(format!("{name} could not be removed: {}.", words(m)));
                    }
                    return e;
                }
            }
            Stop::Statement {
                number,
                line,
                message,
            } => {
                at.line = Some(u64::from(line));
                at.statement = Some(number);
                if mysql {
                    format!(
                        "{ran} Statement {} failed: {}.",
                        grouped(number),
                        words(&message)
                    )
                } else {
                    format!(
                        "Statement {} failed: {}. Nothing was restored.",
                        grouped(number),
                        words(&message)
                    )
                }
            }
            Stop::Added { text, message } => {
                let what = first_line(&text);
                if mysql {
                    format!("{what} failed: {}. {ran}", words(&message))
                } else {
                    format!("{what} failed: {}. Nothing was restored.", words(&message))
                }
            }
            Stop::Count(line) if mysql => format!("{line} The restored rows stay."),
            Stop::Count(line) => format!("{line} Nothing was restored."),
            Stop::ForeignKey(table) => format!(
                "{table} has a Foreign Key value with no matching row. Nothing was restored."
            ),
            Stop::BackupFirst(message) => format!(
                "Backing up the tables first failed: {}. Nothing was dropped or restored.",
                words(&message)
            ),
            Stop::Error(e) => {
                let text = plain_message(&e);
                if mysql {
                    format!("{}. {ran}", words(&text))
                } else {
                    format!("{}. Nothing was restored.", words(&text))
                }
            }
        };
        Error::JobFailed {
            at,
            message: format!("{message}{outcome}"),
        }
    }

    /// The history entry: the summary, the statements Contura adds, the structure
    /// statements (up to 64 KB) and the INSERT count.
    fn history_sql(&self) -> String {
        let p = &self.plan;
        let into = p.database.clone().unwrap_or_default();
        let mut out = format!("-- Restore of {} into {into}\n", file_name(&self.req.path));
        let mut push = |t: &str| {
            out.push_str(t.trim_end().trim_end_matches(';'));
            out.push_str(";\n");
        };
        if let Some(c) = &p.create_database {
            push(&c.text);
        }
        p.setup.iter().for_each(|s| push(&s.text));
        p.drops.iter().for_each(|s| push(&s.text));
        let mut kept = 0usize;
        let mut shown = 0u64;
        for s in &p.structure {
            if kept + s.text.len() > HISTORY_BYTES {
                break;
            }
            kept += s.text.len();
            shown += 1;
            push(&s.text);
        }
        if p.structure_total > shown {
            let more = p.structure_total - shown;
            out.push_str(&format!(
                "-- {} more structure {}\n",
                grouped(more),
                if more == 1 { "statement" } else { "statements" }
            ));
        }
        if p.insert_count > 0 {
            out.push_str(&format!(
                "-- {} INSERT statements ({} rows)\n",
                grouped(p.insert_count),
                grouped(p.insert_rows)
            ));
        }
        p.after.iter().for_each(|s| {
            out.push_str(s.text.trim_end().trim_end_matches(';'));
            out.push_str(";\n");
        });
        out
    }

    async fn go(mut self) {
        let started = Instant::now();
        let ran_at_ms = now_ms();
        let mut st = Done::default();
        let mut writer: Option<Box<dyn BulkWriter>> = None;
        let mut maint: Option<Box<dyn BulkWriter>> = None;
        let file = self.file.take();
        let mut reader = None;
        let result: std::result::Result<(), Stop> = async {
            let file = file.ok_or_else(|| Error::File("the Backup's file is gone".into()))?;
            let (mut rx, handle) = read_statements(
                self.req.path.clone(),
                file,
                self.check.bytes,
                self.config.dialect,
                self.req.run_as_is,
                self.ctx.cancel_flag().clone(),
            );
            reader = Some(handle);
            let done = self.work(&mut st, &mut writer, &mut maint, &mut rx).await;
            // Dropping the receiver stops the reader thread.
            drop(rx);
            done
        }
        .await;
        if let Some(mut w) = writer.take() {
            if result.is_err() {
                self.progress(&st, JobPhase::RollingBack, true);
                let _ = w.rollback().await;
                st.open_rows = 0;
            }
            w.close().await;
        }
        if let Some(handle) = reader {
            let _ = handle.await;
        }
        drop(self.hold.take());
        let result = match result {
            Ok(()) => Ok(()),
            Err(stop) => Err(self.stopped(stop, &mut st, &mut maint).await),
        };
        if let Some(m) = maint.take() {
            m.close().await;
        }
        if let Some(d) = st.new_dialect.take() {
            let _ = d.disconnect().await;
        }
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let (outcome, error) = match &result {
            Ok(()) => (Outcome::Ok, None),
            Err(Error::Cancelled) => (Outcome::Cancelled, None),
            Err(e) => (Outcome::Error, Some(plain_message(e))),
        };
        let kept = if self.mysql() { st.committed } else { 0 };
        self.ctx.history(NewHistory {
            connection_id: self.config.id,
            sql: self.history_sql(),
            ran_at_ms,
            elapsed_ms,
            outcome,
            rows: Some(if result.is_ok() { st.rows } else { kept }),
            changed: true,
            error,
        });
        match result {
            Ok(()) => {
                let sqlite = self.config.dialect == DialectKind::Sqlite;
                let new_file = self
                    .plan
                    .delete_file
                    .as_ref()
                    .map(|p| p.display().to_string());
                let database = match (&new_file, sqlite) {
                    (Some(f), _) => f.clone(),
                    (None, true) => self
                        .config
                        .file
                        .as_ref()
                        .map(|f| f.display().to_string())
                        .unwrap_or_default(),
                    (None, false) => self.plan.database.clone().unwrap_or_default(),
                };
                let tables = match &self.check.backup_header {
                    _ if self.plan.creates.tables > 0 => self.plan.creates.tables,
                    Some(h) => h.rows.len() as u64,
                    None => 0,
                };
                let report = JobReport {
                    kind: JobKind::Restore,
                    rows_written: st.rows,
                    statements: st.ran,
                    skipped: st.skipped,
                    elapsed_ms,
                    file: Some(self.req.path.clone()),
                    bytes: self.check.bytes,
                    committed: st.rows,
                    restore: Some(RestoreOutcome {
                        database,
                        tables,
                        rows: st.rows,
                        counts_match: st.counts_match,
                        new_file,
                    }),
                    ..JobReport::default()
                };
                self.ctx.finish(Ok(report));
            }
            Err(e) => {
                // The cancel text reads statementsDone from the last progress.
                self.progress(&st, JobPhase::RollingBack, true);
                if self.mysql() {
                    self.ctx.fail(e, kept);
                } else {
                    self.ctx.finish(Err(e));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trip() {
        let bytes: [u8; 32] = core::array::from_fn(|i| i as u8 * 7);
        assert_eq!(unhex32(&hex(&bytes)).unwrap(), bytes);
        assert!(unhex32("zz").is_err());
    }

    #[test]
    fn first_lines_are_short() {
        assert_eq!(
            first_line("  CREATE TABLE t (\n a int)"),
            "CREATE TABLE t ("
        );
        let long = "x".repeat(150);
        assert_eq!(first_line(&long).len(), 103);
        assert_eq!(words("server says no. "), "server says no");
    }
}
