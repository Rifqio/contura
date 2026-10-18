//! The SQL file import service (Task 9): `plan_script`, `script_statements`,
//! `confirm_script` and `start_script`.
//!
//! A script import is a Write job, with the checks of a table import: Read-only refuses
//! it before any job starts; Production needs one Job pass bound to the file's identity
//! and the Run as is choice (D5, Q29).
//!
//! The start opens the file once, with other writers refused for as long as the job
//! runs (Q44), reads it through that handle to find any refused statement, and hands the
//! same handle to the run, which reads at most the bytes the start checked. Each
//! statement runs through its own single-statement call.
//!
//! Transactions: the whole script runs in one transaction, except
//! - a file with its own transaction control runs as written, with no outer transaction;
//! - a statement that cannot run inside a transaction (MySQL DDL, which commits as it
//!   runs; PostgreSQL and SQLite VACUUM, CONCURRENTLY, CREATE DATABASE) commits what is
//!   open, runs on its own, and a new transaction starts after it.
//!
//! The file's size and SHA-256 are checked before the final COMMIT.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use tokio::sync::mpsc;

use super::import::{blocking_err, file_name, rows_text, statements_text};
use super::{ConnectionService, now_ms, plain_message};
use crate::dialect::Dialect;
use crate::error::{Error, Result};
use crate::jobs::fingerprint::{JobPlan, job_fingerprint};
use crate::jobs::formats::read_err;
use crate::jobs::paths::{hex, open_locked};
use crate::jobs::script::{Facts, ScriptReader, TxControl, insert_shape};
use crate::jobs::types::{
    ConfirmItem, InsertShape, JobId, JobKind, JobPhase, JobPosition, JobProgress, JobReport,
    JobVerdict, ScriptAction, ScriptPlan, ScriptRequest, ScriptStatement, StatementKind,
};
use crate::jobs::writer::{BulkWriter, WriterSetup};
use crate::jobs::{FileIdentity, JobCtx, JobSink};
use crate::model::{ConnectionConfig, ConnectionId, DialectKind};
use crate::query::{NewHistory, Outcome};
use crate::safety::PassId;

mod run;
mod scan;
#[cfg(test)]
mod tests;

use run::ScriptRun;
use scan::{LIST_BUDGET, PAGE, Scan, ScanMode, scan, shown};

/// "Line {n}: {reason}" for each refused statement.
fn refusals(plan: &ScriptPlan) -> Vec<String> {
    let mut out: Vec<String> = plan
        .refused
        .iter()
        .filter_map(|s| match &s.action {
            ScriptAction::Refuse { reason } => Some(format!("Line {}: {reason}", s.line)),
            _ => None,
        })
        .collect();
    match plan.refused_more {
        0 => {}
        1 => out.push("1 more statement is refused.".into()),
        n => out.push(format!("{n} more statements are refused.")),
    }
    out
}

/// The database a script runs in: the request's, or the Connection's.
fn target_database(config: &ConnectionConfig, req: &ScriptRequest) -> Option<String> {
    req.database.clone().or_else(|| config.database.clone())
}

/// What the Production pass covers: the Connection and database, Run as is, and the
/// file's path, size and SHA-256 (which fix every statement).
fn script_job_plan(
    connection_id: ConnectionId,
    database: Option<String>,
    run_as_is: bool,
    file: FileIdentity,
) -> JobPlan {
    JobPlan {
        kind: JobKind::ScriptImport,
        connection_id,
        database,
        schema: None,
        table: None,
        options: serde_json::json!({ "runAsIs": run_as_is }),
        mapping: Vec::new(),
        template: String::new(),
        file: Some(file),
    }
}

fn script_fingerprint(
    config: &ConnectionConfig,
    req: &ScriptRequest,
    file: FileIdentity,
) -> Result<[u8; 32]> {
    job_fingerprint(&script_job_plan(
        config.id,
        target_database(config, req),
        req.run_as_is,
        file,
    ))
}

fn identity(req: &ScriptRequest, plan: &ScriptPlan) -> FileIdentity {
    FileIdentity {
        path: req.path.clone(),
        bytes: plan.bytes,
        sha256: plan.sha256.clone(),
    }
}

/// Reads `path` once by path (the plan and the confirm), with no cancel.
fn scan_path(path: &Path, kind: DialectKind, run_as_is: bool, mode: ScanMode) -> Result<Scan> {
    let r = ScriptReader::open(path, kind, run_as_is)?;
    scan(r, kind, mode, &|| false, &mut |_, _| {})
}

impl ConnectionService {
    async fn script_scanned(
        &self,
        config: &ConnectionConfig,
        req: &ScriptRequest,
        mode: ScanMode,
    ) -> Result<Scan> {
        self.guard_import_file(&req.path)?;
        let (path, kind, run_as_is) = (req.path.clone(), config.dialect, req.run_as_is);
        tokio::task::spawn_blocking(move || scan_path(&path, kind, run_as_is, mode))
            .await
            .map_err(blocking_err)?
    }

    /// The Statements step: counts, the first 50 statements, the skipped and refused
    /// statements (texts cut at 4 KB), the transaction flags (Q28), the Production
    /// confirmation's items and the verdict: Read-only, then Blocked ("Line {n}:
    /// {reason}" for each refused statement), then the Production confirmation, then Ok.
    pub async fn plan_script(&self, req: ScriptRequest) -> Result<ScriptPlan> {
        let config = self.config(req.connection_id)?;
        let Scan { mut plan, .. } = self.script_scanned(&config, &req, ScanMode::Plan).await?;
        let reasons = refusals(&plan);
        plan.verdict = if config.read_only {
            JobVerdict::ReadOnly {
                connection: config.name.clone(),
            }
        } else if !reasons.is_empty() {
            JobVerdict::Blocked { reasons }
        } else if config.production {
            let fp = script_fingerprint(&config, &req, identity(&req, &plan))?;
            JobVerdict::NeedsConfirmation {
                connection: config.name.clone(),
                database: target_database(&config, &req),
                fingerprint: hex(&fp),
                file_bytes: plan.bytes,
                file_sha256: plan.sha256.clone(),
            }
        } else {
            JobVerdict::Ok
        };
        Ok(plan)
    }

    /// Up to 100 statements of the file from index `from`, read on demand, with texts cut
    /// at 4 KB; a page stops early at 4 MB of text, and the next asks from its last index.
    /// With `run_as_is` a statement that runs as is shows Run, not Skip (Q12).
    pub async fn script_statements(
        &self,
        connection_id: ConnectionId,
        path: &Path,
        from: u32,
        run_as_is: bool,
    ) -> Result<Vec<ScriptStatement>> {
        let config = self.config(connection_id)?;
        self.guard_import_file(path)?;
        let (path, kind) = (path.to_path_buf(), config.dialect);
        tokio::task::spawn_blocking(move || {
            let mut r = ScriptReader::open(&path, kind, run_as_is)?;
            let mut out = Vec::new();
            let mut bytes = 0usize;
            while out.len() < PAGE && bytes < LIST_BUDGET {
                let Some(s) = r.next_statement()? else { break };
                if s.index >= from {
                    let s = shown(&s);
                    bytes += s.text.len();
                    out.push(s);
                }
            }
            Ok(out)
        })
        .await
        .map_err(blocking_err)?
    }

    /// Reads the file again and issues the Job pass for it, bound to the file's identity
    /// (D5, Q29).
    pub async fn confirm_script(&self, req: ScriptRequest) -> Result<PassId> {
        let config = self.config(req.connection_id)?;
        if config.read_only {
            return Err(Error::ReadOnly(0));
        }
        let Scan { plan, .. } = self
            .script_scanned(&config, &req, ScanMode::Refusals)
            .await?;
        let reasons = refusals(&plan);
        if !reasons.is_empty() {
            return Err(Error::InvalidInput(reasons.join(" ")));
        }
        let file = identity(&req, &plan);
        let fp = script_fingerprint(&config, &req, file.clone())?;
        self.issue_job_pass(config.id, fp, Some(file))
    }

    /// Starts script `job` (the client's id, Q21). Before anything runs, in order:
    /// Read-only refuses (`ReadOnly(0)`); the path guard; Production without a pass
    /// (`NeedsConfirmation`); the file opens with other writers refused (Q44); the job
    /// registers, which holds `JobBusy` for the Connection from here on; the file is read
    /// through that handle, with Checking progress and cancel, and a refused statement
    /// anywhere refuses the start (`InvalidInput`). Only then is the Production pass
    /// spent: the file must be the one confirmed (`FileChanged`, Q29) and the pass must
    /// cover it. A start refused after the job registered leaves no job and no final
    /// event. The run goes on in the background and adds one history entry.
    pub async fn start_script(
        &self,
        job: JobId,
        req: ScriptRequest,
        pass: Option<PassId>,
        sink: Arc<dyn JobSink>,
    ) -> Result<JobId> {
        let config = self.config(req.connection_id)?;
        if config.read_only {
            return Err(Error::ReadOnly(0));
        }
        self.guard_import_file(&req.path)?;
        if config.production && pass.is_none() {
            return Err(Error::NeedsConfirmation);
        }
        let file = open_locked(&req.path)?;
        let ctx = self.jobs.start(
            job,
            JobKind::ScriptImport,
            config.id,
            &config.name,
            format!("Importing {}", file_name(&req.path)),
            true,
            sink,
        )?;
        let (ctx, checked) = self.start_checked(&config, &req, pass, &file, ctx).await?;
        let (scan, d) = match checked {
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
        let run = ScriptRun {
            ctx,
            connection_id: config.id,
            dialect: d,
            kind: config.dialect,
            database: target_database(&config, &req),
            path: req.path.clone(),
            file: Some(file),
            hold: Some(hold),
            run_as_is: req.run_as_is,
            own: scan.plan.own_transactions,
            expected: scan.sha,
            file_bytes: scan.plan.bytes,
            production: config.production,
        };
        tokio::spawn(run.go());
        Ok(job)
    }

    /// The start's checks once the job is registered: the read through the held handle,
    /// the refusals, the session and the Production pass. Gives the context back with the
    /// outcome, so the caller can discard it on a refusal.
    #[allow(clippy::type_complexity)]
    async fn start_checked(
        &self,
        config: &ConnectionConfig,
        req: &ScriptRequest,
        pass: Option<PassId>,
        file: &File,
        ctx: JobCtx,
    ) -> Result<(JobCtx, Result<(Scan, Arc<dyn Dialect>)>)> {
        let scan_file = match file.try_clone() {
            Ok(f) => f,
            Err(e) => {
                ctx.discard();
                return Err(read_err(Some(&req.path), e));
            }
        };
        let total = file.metadata().map(|m| m.len()).ok();
        let (path, kind, run_as_is) = (req.path.clone(), config.dialect, req.run_as_is);
        let (ctx, scanned) = tokio::task::spawn_blocking(move || {
            let mut sent = |bytes: u64, statements: u64| {
                ctx.progress(JobProgress {
                    phase: JobPhase::Checking,
                    bytes_done: bytes,
                    bytes_total: total,
                    statements_done: statements,
                    ..JobProgress::default()
                })
            };
            let scanned = ScriptReader::from_file(&path, scan_file, u64::MAX, kind, run_as_is)
                .and_then(|r| {
                    scan(
                        r,
                        kind,
                        ScanMode::Refusals,
                        &|| ctx.is_cancelled(),
                        &mut sent,
                    )
                });
            (ctx, scanned)
        })
        .await
        .map_err(blocking_err)?;
        let checked = match scanned {
            Ok(s) => self.start_authorized(config, req, total, pass, s).await,
            Err(e) => Err(e),
        };
        Ok((ctx, checked))
    }

    /// The refusals, the size check, the session, then the Production pass (Q29).
    async fn start_authorized(
        &self,
        config: &ConnectionConfig,
        req: &ScriptRequest,
        total: Option<u64>,
        pass: Option<PassId>,
        scan: Scan,
    ) -> Result<(Scan, Arc<dyn Dialect>)> {
        let reasons = refusals(&scan.plan);
        if !reasons.is_empty() {
            return Err(Error::InvalidInput(reasons.join(" ")));
        }
        if total != Some(scan.plan.bytes) {
            return Err(Error::FileChanged {
                file: file_name(&req.path),
                confirmed: config.production,
            });
        }
        let d = self.session(config.id).await?;
        if config.production {
            let pass = pass.ok_or(Error::NeedsConfirmation)?;
            let file = identity(req, &scan.plan);
            if let Some(confirmed) = self.jobs.confirmed_file(pass)
                && confirmed != file
            {
                self.jobs.forget_file(pass);
                return Err(Error::FileChanged {
                    file: file_name(&req.path),
                    confirmed: true,
                });
            }
            let fp = script_fingerprint(config, req, file)?;
            self.authorize_job(config, fp, Some(pass))?;
            self.jobs.forget_file(pass);
        } else {
            self.authorize_job(config, [0; 32], pass)?;
        }
        Ok((scan, d))
    }
}
