//! The Backup service (step 9): `plan_backup` and `start_backup`. A Backup only reads,
//! so it needs no pass on any Connection, Production and Read-only included (spec
//! "Safety"). It writes `<path>.partial` through the path guard and renames it when
//! complete; a cancel or a failure deletes the partial.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use super::{ConnectionService, now_ms, plain_message};
use crate::backup::data::{
    BackupObserver, BackupProgress, SnapshotRead, Written, write_error, write_script,
};
use crate::backup::plan::{
    BackupFormat, BackupPlan, BackupRequest, build_script, counts, default_file_name, local_date,
    not_included_phrase, now_secs, rows_per_statement, utc_stamp,
};
use crate::dialect::Dialect;
use crate::error::{Error, Result};
use crate::jobs::paths::{PartialFile, PartialWriter, PathUse};
use crate::jobs::types::{JobId, JobKind, JobPhase, JobPosition, JobProgress, JobReport};
use crate::jobs::{JobCtx, JobSink};
use crate::model::{ConnectionConfig, DialectKind};
use crate::query::{Canceller, NewHistory, Outcome};

/// The job's observer: progress events, the cancel flag, the read to stop.
struct JobObserver<'a>(&'a JobCtx);

fn job_progress(p: &BackupProgress) -> JobProgress {
    JobProgress {
        phase: if p.table.is_some() {
            JobPhase::Reading
        } else {
            JobPhase::Writing
        },
        table: p.table.clone(),
        rows_done: p.rows_done,
        rows_total: Some(p.rows_total),
        bytes_done: p.bytes_done,
        statements_done: p.statements_done,
        tables_done: Some(p.tables_done),
        tables_total: Some(p.tables_total),
        ..JobProgress::default()
    }
}

impl BackupObserver for JobObserver<'_> {
    fn progress(&self, p: &BackupProgress) {
        self.0.progress(job_progress(p));
    }

    fn progress_now(&self, p: &BackupProgress) {
        self.0.progress_now(job_progress(p));
    }

    fn cancelled(&self) -> bool {
        self.0.is_cancelled()
    }

    fn reading(&self, canceller: Arc<dyn Canceller>) {
        self.0.set_canceller(canceller);
    }
}

/// The MyISAM note (spec "Consistency"), for a table outside the snapshot.
pub fn non_snapshot_note(table: &str, engine: &str) -> String {
    format!("{table} uses {engine}, so its rows may not match the moment the backup starts.")
}

/// The name the file and its header give the database: the SQLite file's own name
/// (its one database is always `main`), else the database asked for.
fn database_name(config: &ConnectionConfig, req: &BackupRequest) -> String {
    if config.dialect == DialectKind::Sqlite
        && let Some(stem) = config
            .file
            .as_deref()
            .and_then(Path::file_stem)
            .and_then(|s| s.to_str())
    {
        return stem.to_string();
    }
    req.database.clone()
}

/// A failure as the job reports it: the server's or the file's words, then what became
/// of the file. A full disk and a cancel keep their own text.
fn failed(e: Error) -> Error {
    match e {
        Error::Cancelled | Error::JobFailed { .. } | Error::FileExists(_) => e,
        other => {
            let text = plain_message(&other);
            let text = text.trim_end();
            let stop = if text.ends_with(['.', '!', '?']) {
                ""
            } else {
                "."
            };
            Error::JobFailed {
                at: JobPosition::default(),
                message: format!("{text}{stop} The unfinished file was deleted."),
            }
        }
    }
}

impl ConnectionService {
    fn check_backup(config: &ConnectionConfig, req: &BackupRequest) -> Result<()> {
        if req.format == BackupFormat::FileCopy && config.dialect != DialectKind::Sqlite {
            return Err(Error::InvalidInput(
                "Only a SQLite database can be copied as a file.".into(),
            ));
        }
        if config.dialect == DialectKind::Postgres
            && req.schema.as_deref().is_none_or(str::is_empty)
        {
            return Err(Error::InvalidInput("Choose a schema to back up.".into()));
        }
        rows_per_statement(req.rows_per_statement)?;
        Ok(())
    }

    /// What the Backup dialog shows: the counts of each kind of object, the not-included
    /// list, the server's size estimate, the MySQL tables outside the snapshot and the
    /// default file name. It reads the structure inside a snapshot, as the Backup will.
    pub async fn plan_backup(&self, req: BackupRequest) -> Result<BackupPlan> {
        let config = self.config(req.connection_id)?;
        Self::check_backup(&config, &req)?;
        let d = self.session(req.connection_id).await?;
        let read = d
            .open_backup_read(&req.database, req.schema.as_deref(), false)
            .await?;
        let facts = &read.facts;
        let structure_bytes: u64 = facts
            .parts
            .settings
            .iter()
            .chain(&facts.parts.before_rows)
            .chain(&facts.parts.after_rows)
            .chain(&facts.parts.finish)
            .map(|i| i.sql.len() as u64 + 1)
            .sum();
        let estimate_bytes = match req.format {
            BackupFormat::FileCopy => facts.data_bytes,
            BackupFormat::Script => facts.data_bytes + structure_bytes,
        };
        let (_, utc) = utc_stamp(now_secs());
        let date = local_date(req.local_date.as_deref()).unwrap_or(&utc);
        Ok(BackupPlan {
            dialect: config.dialect,
            counts: counts(&facts.parts, &facts.tables),
            not_included: facts
                .parts
                .not_included
                .iter()
                .map(|s| not_included_phrase(s))
                .collect(),
            estimate_bytes,
            non_snapshot_tables: facts.non_snapshot.iter().map(|(t, _)| t.clone()).collect(),
            default_file_name: default_file_name(&database_name(&config, &req), date, req.format),
        })
    }

    /// Starts Backup `job` (the client's id). The path guard and the partial file come
    /// first, so an existing file without `overwrite` (`FileExists`), the data folder and
    /// a file another job is writing are refused here, before the job starts. No pass on
    /// any Connection: a Backup only reads. One history entry with `changed: false`.
    pub async fn start_backup(
        &self,
        job: JobId,
        req: BackupRequest,
        overwrite: bool,
        sink: Arc<dyn JobSink>,
    ) -> Result<JobId> {
        let config = self.config(req.connection_id)?;
        Self::check_backup(&config, &req)?;
        let d = self.session(req.connection_id).await?;
        let data = self.data_dir.as_deref().ok_or_else(|| {
            Error::InvalidInput("Contura cannot find its data folder, so it cannot back up.".into())
        })?;
        let target = PathBuf::from(&req.path);
        let partial = PartialFile::create(&target, overwrite, PathUse::Backup, data)?;
        let database = database_name(&config, &req);
        let shown = match &req.schema {
            Some(s) if config.dialect == DialectKind::Postgres => format!("{database}.{s}"),
            _ => database.clone(),
        };
        let ctx = self.jobs.start(
            job,
            JobKind::Backup,
            config.id,
            &config.name,
            format!("Backing up {shown}"),
            false,
            sink,
        )?;
        let run = Run {
            ctx,
            config,
            dialect: d,
            req,
            database,
            shown,
            out: partial.writer(),
            target,
        };
        tokio::spawn(run.go());
        Ok(job)
    }
}

/// One Backup job, moved into its task.
struct Run {
    ctx: JobCtx,
    config: ConnectionConfig,
    dialect: Arc<dyn Dialect>,
    req: BackupRequest,
    /// The header's database name.
    database: String,
    /// The database (and schema) as the history entry names it.
    shown: String,
    out: PartialWriter,
    target: PathBuf,
}

impl Run {
    async fn go(self) {
        let Run {
            ctx,
            config,
            dialect,
            req,
            database,
            shown,
            out,
            target,
        } = self;
        let started = Instant::now();
        let ran_at_ms = now_ms();
        ctx.progress(JobProgress {
            phase: JobPhase::Reading,
            ..JobProgress::default()
        });
        let result =
            match req.format {
                BackupFormat::FileCopy => file_copy(dialect.as_ref(), out, &target, &ctx)
                    .await
                    .map(|bytes| Written {
                        bytes,
                        ..Written::default()
                    }),
                BackupFormat::Script => {
                    script(
                        dialect.as_ref(),
                        &config,
                        &req,
                        &database,
                        out,
                        &target,
                        &ctx,
                        false,
                    )
                    .await
                }
            };
        let result = result.map_err(failed);
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let (outcome, rows, error) = match &result {
            Ok(w) => (Outcome::Ok, Some(w.rows), None),
            Err(Error::Cancelled) => (Outcome::Cancelled, None, None),
            Err(e) => (Outcome::Error, None, Some(plain_message(e))),
        };
        ctx.history(NewHistory {
            connection_id: config.id,
            sql: format!("-- Backup of {shown} to {}", target.display()),
            ran_at_ms,
            elapsed_ms,
            outcome,
            rows,
            changed: false,
            error,
        });
        let report = result.map(|w| JobReport {
            kind: JobKind::Backup,
            rows_read: w.rows,
            rows_written: w.rows,
            statements: w.statements,
            warnings: w.warnings,
            elapsed_ms,
            file: Some(target.clone()),
            bytes: w.bytes,
            ..JobReport::default()
        });
        ctx.finish(report);
    }
}

/// Renames the finished partial over the target, unless the job was cancelled first.
async fn commit(out: PartialWriter, ctx: &JobCtx) -> Result<u64> {
    let flag = ctx.cancel_flag().clone();
    tokio::task::spawn_blocking(move || {
        if flag.load(std::sync::atomic::Ordering::SeqCst) {
            // Dropped, so deleted.
            return Err(Error::Cancelled);
        }
        out.commit()
    })
    .await
    .map_err(|e| Error::File(format!("the Backup's file could not be finished: {e}")))?
}

/// `work`, unless the job is cancelled first (checked every 50 ms).
async fn until_cancelled<T>(
    ctx: &JobCtx,
    work: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    let watch = async {
        while !ctx.is_cancelled() {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    };
    tokio::select! {
        done = work => done,
        () = watch => Err(Error::Cancelled),
    }
}

/// Watches a Backup run inside another job (Restore's "Back up these tables first"):
/// the cancel and the read to stop, no progress of its own.
struct QuietObserver<'a>(&'a JobCtx);

impl BackupObserver for QuietObserver<'_> {
    fn progress(&self, _: &BackupProgress) {}

    fn cancelled(&self) -> bool {
        self.0.is_cancelled()
    }

    fn reading(&self, canceller: Arc<dyn Canceller>) {
        self.0.set_canceller(canceller);
    }
}

/// MySQL Restore's "Back up these tables first" (spec "Per-Dialect rules"): a Backup of
/// exactly the `tables` Replace drops (R30), their structure, triggers and rows, to
/// `path`, inside the Restore job `ctx`, before any DROP.
/// The file is written as `<path>.partial` through the path guard and never over an
/// existing file. Any failure deletes the partial and comes back as the job's error.
pub(super) async fn backup_first(
    d: &dyn Dialect,
    config: &ConnectionConfig,
    data_dir: &Path,
    database: &str,
    tables: &[String],
    path: &Path,
    ctx: &JobCtx,
) -> Result<Written> {
    let req = BackupRequest {
        connection_id: config.id,
        database: database.to_string(),
        path: path.display().to_string(),
        tables: Some(tables.to_vec()),
        ..BackupRequest::default()
    };
    let partial = PartialFile::create(path, false, PathUse::Backup, data_dir)?;
    let database = database_name(config, &req);
    script(
        d,
        config,
        &req,
        &database,
        partial.writer(),
        path,
        ctx,
        true,
    )
    .await
    .map_err(failed)
}

/// The script: snapshot, header, sections, rows, trailer, rename. `quiet` sends no
/// progress (a Backup inside a Restore).
#[allow(clippy::too_many_arguments)]
async fn script(
    d: &dyn Dialect,
    config: &ConnectionConfig,
    req: &BackupRequest,
    database: &str,
    out: PartialWriter,
    target: &Path,
    ctx: &JobCtx,
    quiet: bool,
) -> Result<Written> {
    let server_version = until_cancelled(ctx, d.server_version()).await?;
    // Counting each table's rows can take a while: a cancel ends the wait, and the
    // dropped read closes its connection once the server answers.
    let mut read: SnapshotRead = until_cancelled(
        ctx,
        d.open_backup_read(&req.database, req.schema.as_deref(), req.include.rows),
    )
    .await?;
    let (taken_at, _) = utc_stamp(now_secs());
    let script = build_script(
        config.dialect,
        req,
        database,
        &read.facts.parts,
        &read.facts.tables,
        &server_version,
        taken_at,
    );
    if !script.tables.is_empty() {
        for (table, engine) in &read.facts.non_snapshot {
            ctx.warning(non_snapshot_note(table, engine));
        }
    }
    let (loud, still) = (JobObserver(ctx), QuietObserver(ctx));
    let observer: &dyn BackupObserver = if quiet { &still } else { &loud };
    let (out, mut written) = write_script(&script, &mut read, out, target, observer).await?;
    // The snapshot ends before the rename.
    drop(read);
    let tables = script.tables.len() as u64;
    if !quiet {
        ctx.progress_now(JobProgress {
            phase: JobPhase::Committing,
            rows_done: written.rows,
            rows_total: Some(written.rows),
            bytes_done: written.bytes,
            statements_done: written.statements,
            tables_done: Some(tables),
            tables_total: Some(tables),
            ..JobProgress::default()
        });
    }
    written.bytes = commit(out, ctx).await.map_err(|e| match e {
        Error::File(m) => Error::JobFailed {
            at: JobPosition::default(),
            message: format!("{m}. The unfinished file was deleted."),
        },
        other => other,
    })?;
    for w in &written.warnings {
        ctx.warning(w.clone());
    }
    Ok(written)
}

/// SQLite's exact file copy: `VACUUM INTO` the partial (empty, so SQLite takes it), then
/// the rename.
async fn file_copy(
    d: &dyn Dialect,
    out: PartialWriter,
    target: &Path,
    ctx: &JobCtx,
) -> Result<u64> {
    let partial = out.partial_path().to_path_buf();
    match d.backup_file_copy(&partial).await {
        Ok(()) => {}
        Err(Error::Query(m)) if m.to_ascii_lowercase().contains("full") => {
            return Err(write_error(
                target,
                &std::io::Error::new(std::io::ErrorKind::StorageFull, m),
            ));
        }
        Err(e) => return Err(e),
    }
    commit(out, ctx).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::types::JobEvent;

    #[test]
    fn progress_carries_the_table_counts() {
        let json = serde_json::to_value(JobEvent::from(JobProgress {
            tables_done: Some(2),
            tables_total: Some(6),
            ..JobProgress::default()
        }))
        .unwrap();
        assert_eq!(json["tablesDone"], 2);
        assert_eq!(json["tablesTotal"], 6);
        let plain = serde_json::to_value(JobEvent::from(JobProgress::default())).unwrap();
        assert!(plain.get("tablesDone").is_none());
    }

    #[test]
    fn failures_say_the_file_was_deleted() {
        assert_eq!(
            failed(Error::Query("server closed the connection".into())).to_string(),
            "server closed the connection. The unfinished file was deleted."
        );
        assert!(matches!(failed(Error::Cancelled), Error::Cancelled));
        assert_eq!(
            non_snapshot_note("orders", "MyISAM"),
            "orders uses MyISAM, so its rows may not match the moment the backup starts."
        );
    }
}
