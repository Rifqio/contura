//! Commands for import and export jobs. A job's events reach the page through a
//! `Channel`; the job commands of Tasks 7 to 9 are added here in those tasks (Task 8:
//! the table import; Task 9: the SQL file import) and step 8's Data Transfer.

use std::path::PathBuf;
use std::sync::Arc;

use contura_core::Error;
use contura_core::backup::plan::{BackupPlan, BackupRequest};
use contura_core::backup::restore::{RestorePlan, RestoreRequest, RestoreTarget};
use contura_core::connections::ConnectionService;
use contura_core::jobs::JobSink;
use contura_core::jobs::formats::inspect;
use contura_core::jobs::paths::{PathUse, check_user_path, read_user_text};
use contura_core::jobs::types::{
    ExportPreview, ExportRequest, FileSummary, Format, ImportPlan, ImportRequest, JobId,
    JobSummary, ScriptPlan, ScriptRequest, ScriptStatement,
};
use contura_core::model::ConnectionId;
use contura_core::safety::PassId;
use contura_core::transfer::{TransferPlan, TransferRequest};
use tauri::State;
use tauri::ipc::Channel;

use crate::commands::DataDir;

type Service<'a> = State<'a, ConnectionService>;

/// The most `read_text_file` reads: 1 MiB.
const TEXT_FILE_MAX: u64 = 1024 * 1024;

/// Sends a job's events to the page. A page that has gone away is not an error.
pub struct ChannelSink(pub Channel<serde_json::Value>);

impl JobSink for ChannelSink {
    fn send(&self, event: serde_json::Value) {
        let _ = self.0.send(event);
    }
}

/// The first lines or rows an export would write, its size per row and its notes.
#[tauri::command]
pub async fn preview_export(
    service: Service<'_>,
    req: ExportRequest,
) -> Result<ExportPreview, Error> {
    service.preview_export(req).await
}

/// Starts export `job` (made by the page, Q2). `FileExists` and the path guard's
/// refusals come back here, before the job starts; the rest arrives through `events`.
#[tauri::command]
pub async fn start_export(
    service: Service<'_>,
    job: JobId,
    req: ExportRequest,
    overwrite: bool,
    events: Channel<serde_json::Value>,
) -> Result<JobId, Error> {
    service
        .start_export(job, req, overwrite, Arc::new(ChannelSink(events)))
        .await
}

/// What the File step shows: format, delimiter, encoding, size, header, the first 20
/// rows and a row count. The path guard refuses the data folder.
#[tauri::command]
pub async fn inspect_import_file(
    data: State<'_, DataDir>,
    path: PathBuf,
    format: Option<Format>,
) -> Result<FileSummary, Error> {
    check_user_path(&path, &data.0, PathUse::Import)?;
    tauri::async_runtime::spawn_blocking(move || inspect(&path, format))
        .await
        .map_err(|e| Error::File(format!("cannot read the file: {e}")))?
}

/// The Columns step's plan: mapping, notes, preview, sample INSERT and verdict.
#[tauri::command]
pub async fn plan_import(service: Service<'_>, req: ImportRequest) -> Result<ImportPlan, Error> {
    service.plan_import(req).await
}

/// Starts the check pass over the whole file. `job` is the page's id (Q21); without one
/// the Core makes it. Its report carries the failing rows and the SHA-256.
#[tauri::command]
pub async fn check_import_file(
    service: Service<'_>,
    job: Option<JobId>,
    req: ImportRequest,
    events: Channel<serde_json::Value>,
) -> Result<JobId, Error> {
    let job = job.unwrap_or_else(JobId::new_v4);
    service
        .check_import_file(job, req, Arc::new(ChannelSink(events)))
        .await
}

/// The Production confirmation: a Job pass for this plan and this file.
#[tauri::command]
pub async fn confirm_import(service: Service<'_>, req: ImportRequest) -> Result<PassId, Error> {
    service.confirm_import(req).await
}

/// Starts import `job` (made by the page, Q2); `pass` comes from `confirm_import` on
/// Production. Read-only, a changed file, a missing pass and blockers come back here.
#[tauri::command]
pub async fn start_import(
    service: Service<'_>,
    job: JobId,
    req: ImportRequest,
    pass: Option<PassId>,
    events: Channel<serde_json::Value>,
) -> Result<JobId, Error> {
    service
        .start_import(job, req, pass, Arc::new(ChannelSink(events)))
        .await
}

/// The Statements step: counts, the first 50 statements, the skipped and refused ones,
/// the transaction flags, the Production confirmation's items and the verdict.
#[tauri::command]
pub async fn plan_script(service: Service<'_>, req: ScriptRequest) -> Result<ScriptPlan, Error> {
    service.plan_script(req).await
}

/// 100 statements of the file from index `from`, read on demand; `run_as_is` shows the
/// statements that run as is as Run (Q12).
#[tauri::command]
pub async fn script_statements(
    service: Service<'_>,
    connection_id: ConnectionId,
    path: PathBuf,
    from: u32,
    run_as_is: Option<bool>,
) -> Result<Vec<ScriptStatement>, Error> {
    service
        .script_statements(connection_id, &path, from, run_as_is.unwrap_or(false))
        .await
}

/// The Production confirmation of a script: a Job pass for this file.
#[tauri::command]
pub async fn confirm_script(service: Service<'_>, req: ScriptRequest) -> Result<PassId, Error> {
    service.confirm_script(req).await
}

/// Starts script `job` (made by the page, Q21; without one the Core makes it); `pass`
/// comes from `confirm_script` on Production. Read-only, a refused statement, a changed
/// file and a missing pass come back here.
#[tauri::command]
pub async fn start_script(
    service: Service<'_>,
    job: Option<JobId>,
    req: ScriptRequest,
    pass: Option<PassId>,
    events: Channel<serde_json::Value>,
) -> Result<JobId, Error> {
    let job = job.unwrap_or_else(JobId::new_v4);
    service
        .start_script(job, req, pass, Arc::new(ChannelSink(events)))
        .await
}

/// The Data Transfer plan Review SQL shows. Read-only and the planner's refusals come
/// back here.
#[tauri::command]
pub async fn plan_transfer(
    service: Service<'_>,
    req: TransferRequest,
) -> Result<TransferPlan, Error> {
    service.plan_transfer(req).await
}

/// The first INSERT of `table`'s copy, from 4 source rows.
#[tauri::command]
pub async fn transfer_sample(
    service: Service<'_>,
    req: TransferRequest,
    table: String,
) -> Result<String, Error> {
    service.transfer_sample(req, table).await
}

/// The Production confirmation of a transfer: a Job pass on the target for this plan.
#[tauri::command]
pub async fn confirm_transfer(service: Service<'_>, req: TransferRequest) -> Result<PassId, Error> {
    service.confirm_transfer(req).await
}

/// Starts transfer `job` (made by the page); `reviewed` is the fingerprint Review SQL
/// showed and `pass` comes from `confirm_transfer` on a Production target.
#[tauri::command]
pub async fn start_transfer(
    service: Service<'_>,
    job: JobId,
    req: TransferRequest,
    reviewed: Option<String>,
    pass: Option<PassId>,
    events: Channel<serde_json::Value>,
) -> Result<JobId, Error> {
    service
        .start_transfer(job, req, reviewed, pass, Arc::new(ChannelSink(events)))
        .await
}

/// What a Backup would hold: counts, not-included list, estimate and file name.
#[tauri::command]
pub async fn plan_backup(service: Service<'_>, req: BackupRequest) -> Result<BackupPlan, Error> {
    service.plan_backup(req).await
}

/// Starts Backup `job` (made by the page). A read job: no pass on any Connection.
/// `FileExists` and the path guard's refusals come back here, before the job starts.
#[tauri::command]
pub async fn start_backup(
    service: Service<'_>,
    job: JobId,
    req: BackupRequest,
    overwrite: bool,
    events: Channel<serde_json::Value>,
) -> Result<(), Error> {
    service
        .start_backup(job, req, overwrite, Arc::new(ChannelSink(events)))
        .await
        .map(|_| ())
}

/// Starts Restore's check pass `job` on `path`: a job of kind `restoreCheck` whose
/// finished report carries the `restoreCheck`. Read-only is refused here.
#[tauri::command]
pub async fn inspect_restore(
    service: Service<'_>,
    job: JobId,
    target: RestoreTarget,
    path: PathBuf,
    events: Channel<serde_json::Value>,
) -> Result<(), Error> {
    service
        .inspect_restore(job, target, path, Arc::new(ChannelSink(events)))
        .await
        .map(|_| ())
}

/// The Restore confirmation: the plan, its run order and its fingerprint.
#[tauri::command]
pub async fn plan_restore(service: Service<'_>, req: RestoreRequest) -> Result<RestorePlan, Error> {
    service.plan_restore(req).await
}

/// Up to 100 of the plan's structure statements from position `from` (Show all).
#[tauri::command]
pub async fn restore_statements(
    service: Service<'_>,
    req: RestoreRequest,
    from: u32,
) -> Result<Vec<ScriptStatement>, Error> {
    service.restore_statements(req, from).await
}

/// The Production confirmation of a Restore: a Job pass for the plan's fingerprint.
#[tauri::command]
pub async fn confirm_restore(service: Service<'_>, req: RestoreRequest) -> Result<PassId, Error> {
    service.confirm_restore(req).await
}

/// Starts Restore `job` (made by the page). `fingerprint` is the reviewed plan's (R28),
/// on every Connection; `pass` from `confirm_restore` on Production.
#[tauri::command]
pub async fn start_restore(
    service: Service<'_>,
    job: JobId,
    req: RestoreRequest,
    fingerprint: String,
    pass: Option<PassId>,
    events: Channel<serde_json::Value>,
) -> Result<(), Error> {
    service
        .start_restore(job, req, fingerprint, pass, Arc::new(ChannelSink(events)))
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn cancel_job(service: Service<'_>, job: JobId) -> Result<(), Error> {
    service.jobs().cancel(job).await
}

#[tauri::command]
pub fn list_jobs(service: Service<'_>) -> Vec<JobSummary> {
    service.jobs().list()
}

/// Watches a job again after Run in the background: the last progress, or the final
/// event, arrives at once.
#[tauri::command]
pub fn job_events(
    service: Service<'_>,
    job: JobId,
    events: Channel<serde_json::Value>,
) -> Result<(), Error> {
    service.jobs().attach(job, Arc::new(ChannelSink(events)))
}

/// Explorer's one `/select,"<path>"` argument. The path comes from the page, so only an
/// absolute path that exists is taken, and never one with a double quote, which would
/// end the quoted path and pass the rest to Explorer as switches (Q45 M6).
fn select_arg(path: &std::path::Path) -> Result<String, Error> {
    let text = path.display().to_string();
    if text.contains('"') {
        return Err(Error::InvalidInput(
            "A file path cannot hold a double quote.".into(),
        ));
    }
    if !path.is_absolute() || !path.exists() {
        return Err(Error::InvalidInput(format!("Contura cannot find {text}.")));
    }
    Ok(format!("/select,\"{text}\""))
}

/// Opens Explorer with the file selected.
#[tauri::command]
pub fn reveal_in_folder(path: PathBuf) -> Result<(), Error> {
    let arg = select_arg(&path)?;
    let mut command = std::process::Command::new("explorer.exe");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Explorer reads `/select,"<path>"` itself; Rust's own quoting of the whole
        // argument breaks it for paths with spaces.
        command.raw_arg(arg);
    }
    #[cfg(not(windows))]
    {
        let _ = arg;
        command.arg(&path);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| Error::File(format!("cannot open the folder of {}: {e}", path.display())))
}

/// Reads a small UTF-8 text file the user chose, such as a Mermaid `.mmd` file (1 MiB at most).
#[tauri::command]
pub fn read_text_file(data: State<'_, DataDir>, path: PathBuf) -> Result<String, Error> {
    check_user_path(&path, &data.0, PathUse::Open)?;
    read_user_text(&path, TEXT_FILE_MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Q45 M6: only an absolute path that exists, with no double quote, and Explorer gets
    /// it as one `/select,` argument.
    #[test]
    fn reveal_takes_only_an_existing_absolute_path() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("orders 2026.csv");
        std::fs::write(&file, "id\n").unwrap();
        assert_eq!(
            select_arg(&file).unwrap(),
            format!("/select,\"{}\"", file.display())
        );
        let refused = |p: PathBuf| match select_arg(&p) {
            Err(Error::InvalidInput(m)) => m,
            other => panic!("{other:?}"),
        };
        assert_eq!(
            refused(PathBuf::from("orders.csv")),
            "Contura cannot find orders.csv."
        );
        let gone = dir.path().join("gone.csv");
        assert_eq!(
            refused(gone.clone()),
            format!("Contura cannot find {}.", gone.display())
        );
        let quoted = PathBuf::from(format!("{}\" /root,C:\\", file.display()));
        assert_eq!(refused(quoted), "A file path cannot hold a double quote.");
    }
}
