//! One-click updates in the app (ADR 0026): which file this copy runs from, the commands
//! Settings > Updates calls, the relaunch after the swap, and the clean-up once the new
//! version is up. The checks, the download and the swap live in the Core (`update`).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use contura_core::Error;
use contura_core::update::{InstallKind, UpdateError, UpdateService, UpdateStatus};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// The relaunched process waits for the one that started it (its pid) to exit, so the
/// single-instance lock is free when it asks for it.
const RELAUNCH_ENV: &str = "CONTURA_RELAUNCH_FROM";
/// The longest the new process waits for the old one to go.
const RELAUNCH_WAIT: Duration = Duration::from_secs(20);
/// The old program file is removed this long after the new version's window is up.
const CLEANUP_AFTER: Duration = Duration::from_secs(10);

/// How this copy updates, and the program file a swap replaces.
pub fn install_target() -> (InstallKind, Option<PathBuf>) {
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        (InstallKind::Portable, std::env::current_exe().ok())
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        match crate::paths::appimage_file() {
            Some(file) => (InstallKind::AppImage, Some(file)),
            None => (InstallKind::Package, None),
        }
    }
    #[cfg(not(any(
        all(windows, target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64")
    )))]
    {
        (InstallKind::Package, None)
    }
}

/// Whether this process was started by an update (set by `wait_for_previous`).
static RELAUNCHED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// How long `start` waits for the data folder lock: long for a start made by an update
/// (the old process may still be closing), short otherwise.
pub fn data_lock_wait() -> Duration {
    if RELAUNCHED.load(std::sync::atomic::Ordering::SeqCst) {
        RELAUNCH_WAIT
    } else {
        Duration::from_secs(3)
    }
}

/// Run first in `run()`, before the single-instance plugin: a process started by an
/// update waits until the old one has exited (it released the single-instance lock
/// before starting this one). Past the wait, `start` still waits on the data folder
/// lock, so two processes never share the data folder. True when the old one has gone.
pub fn wait_for_previous() -> bool {
    let Some(raw) = std::env::var_os(RELAUNCH_ENV) else {
        return true;
    };
    RELAUNCHED.store(true, std::sync::atomic::Ordering::SeqCst);
    // SAFETY: called at the top of `run()`, before Tauri or any other thread starts.
    unsafe { std::env::remove_var(RELAUNCH_ENV) };
    match raw.to_str().and_then(|s| s.parse::<u32>().ok()) {
        Some(pid) => wait_for_exit(pid, RELAUNCH_WAIT),
        None => true,
    }
}

/// Waits up to `limit` for `pid` to exit; true when it has.
#[cfg(target_os = "linux")]
fn wait_for_exit(pid: u32, limit: Duration) -> bool {
    let end = std::time::Instant::now() + limit;
    loop {
        if !linux_alive(pid) {
            return true;
        }
        if std::time::Instant::now() >= end {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Whether `pid` runs: its /proc entry exists and is not a zombie (state Z or X).
#[cfg(target_os = "linux")]
fn linux_alive(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    // The state follows the command name, which is in parentheses and may hold spaces.
    let state = stat
        .rsplit_once(')')
        .and_then(|(_, rest)| rest.split_whitespace().next());
    !matches!(state, Some("Z" | "X" | "x"))
}

#[cfg(windows)]
fn wait_for_exit(pid: u32, limit: Duration) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };
    // SAFETY: plain Win32 calls; the handle is closed once and only when it was opened.
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            // Gone already (or not ours to wait on).
            return true;
        }
        let ms = u32::try_from(limit.as_millis()).unwrap_or(u32::MAX);
        let waited = WaitForSingleObject(handle, ms);
        CloseHandle(handle);
        waited == WAIT_OBJECT_0
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
fn wait_for_exit(_pid: u32, limit: Duration) -> bool {
    std::thread::sleep(limit.min(Duration::from_secs(2)));
    true
}

/// Once the window is up, the program an update moved aside goes, with a few retries
/// while the old process may still hold it (Windows).
pub fn cleanup_later(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(CLEANUP_AFTER);
        for _ in 0..6 {
            match app.try_state::<UpdateService>() {
                Some(updates) if !updates.cleanup() => {}
                _ => return,
            }
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

type Updates<'a> = State<'a, UpdateService>;

#[tauri::command]
pub fn update_status(updates: Updates<'_>) -> Result<UpdateStatus, Error> {
    updates.status()
}

/// The first start guide's update step and the Settings switch.
#[tauri::command]
pub fn set_update_checks(updates: Updates<'_>, on: bool) -> Result<UpdateStatus, Error> {
    updates.set_checks(on)
}

/// `manual`: Check now, which runs with checks off too. Otherwise the daily check, which
/// the Core skips unless checks are on and a day has passed.
#[tauri::command]
pub async fn check_for_update(updates: Updates<'_>, manual: bool) -> Result<UpdateStatus, Error> {
    updates.check(manual, now_ms()).await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub done: u64,
    pub total: Option<u64>,
}

/// Downloads and verifies the offered file; progress goes to `on_progress` about every
/// half per cent.
#[tauri::command]
pub async fn download_update(
    updates: Updates<'_>,
    on_progress: Channel<UpdateProgress>,
) -> Result<UpdateStatus, Error> {
    let mut sent: Option<u64> = None;
    let mut progress = |done: u64, total: Option<u64>| {
        let step = total.map_or(1 << 20, |t| (t / 200).max(1 << 16));
        if sent.is_none_or(|s| done >= s + step) || total == Some(done) {
            sent = Some(done);
            let _ = on_progress.send(UpdateProgress { done, total });
        }
    };
    updates.download(&mut progress).await
}

/// Swaps the verified download in, starts it with the same arguments, and exits. The UI
/// asks about unsaved work first. The swap (which verifies the file again, up to 300 MB)
/// runs off the main thread.
#[tauri::command]
pub async fn restart_to_update(app: AppHandle) -> Result<(), Error> {
    let worker = app.clone();
    let (program, kind) = tauri::async_runtime::spawn_blocking(move || {
        let updates = worker.state::<UpdateService>();
        updates.apply().map(|p| (p, updates.install_kind()))
    })
    .await
    .map_err(|e| {
        Error::Update(UpdateError::Replace {
            message: e.to_string(),
        })
    })??;
    // The new process takes the single-instance lock at once; this one still holds the
    // data folder lock until it exits, and the new one waits for that.
    tauri_plugin_single_instance::destroy(&app);
    relaunch(&program, kind).map_err(|e| {
        Error::Update(UpdateError::Relaunch {
            message: e.to_string(),
        })
    })?;
    app.exit(0);
    Ok(())
}

fn relaunch(program: &Path, kind: InstallKind) -> std::io::Result<()> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(std::env::args_os().skip(1))
        .env(RELAUNCH_ENV, std::process::id().to_string());
    if kind == InstallKind::AppImage {
        // The new AppImage's runtime sets these for its own mount.
        for var in ["APPIMAGE", "APPDIR", "ARGV0", "OWD"] {
            cmd.env_remove(OsString::from(var));
        }
    }
    cmd.spawn().map(drop)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn this_process_is_alive_and_a_finished_child_is_not() {
        assert!(linux_alive(std::process::id()));
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(!linux_alive(pid));
        // A zombie (exited, not yet reaped) counts as gone.
        let child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        let start = std::time::Instant::now();
        assert!(wait_for_exit(pid, Duration::from_secs(5)));
        assert!(start.elapsed() < Duration::from_secs(5));
        drop(child);
    }

    /// M7: a process that outlives the wait is reported, so the new start stays open.
    #[test]
    fn a_process_that_does_not_exit_in_time_is_reported() {
        let mut child = std::process::Command::new("sleep")
            .arg("5")
            .spawn()
            .unwrap();
        let start = std::time::Instant::now();
        assert!(!wait_for_exit(child.id(), Duration::from_millis(300)));
        assert!(start.elapsed() < Duration::from_secs(3));
        // Stopped by its own handle (its pid), never by name.
        child.kill().unwrap();
        child.wait().unwrap();
    }
}
