//! The file swap. A running program file cannot be overwritten on Windows, but it can be
//! renamed (on Linux both work): the program moves aside to `contura.old.*`, the
//! verified download takes its name, and the next start removes the old file.
//!
//! The download is written to a fresh file with a random name, created exclusively (an
//! existing file or symlink of that name is never opened), readable by the user only
//! until it is verified. The file and the folder are synced around the swap.
//!
//! Only the program file is touched; the `data` folder beside it never is.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::InstallKind;

/// Downloads are named `contura.update-<random>.part` beside the program.
const PART_PREFIX: &str = "contura.update-";
const PART_SUFFIX: &str = ".part";
/// The second rename is tried this many times: a virus scanner holds a new exe briefly.
const RENAME_TRIES: u32 = 5;
const RENAME_BACKOFF: Duration = Duration::from_millis(300);

/// The files beside the program an update uses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapPaths {
    /// The program file that runs now, and keeps its name.
    pub target: PathBuf,
    /// Where the program moves aside, kept until the new one has started.
    pub old: PathBuf,
}

impl SwapPaths {
    pub fn dir(&self) -> &Path {
        self.target.parent().unwrap_or(Path::new("."))
    }
}

/// The paths for `target` (the exe or `$APPIMAGE`); none for a package install or a
/// target with no folder.
pub fn swap_paths(kind: InstallKind, target: &Path) -> Option<SwapPaths> {
    let old = match kind {
        InstallKind::Portable => "contura.old.exe",
        InstallKind::AppImage => "contura.old.AppImage",
        InstallKind::Package => return None,
    };
    let dir = target.parent()?;
    Some(SwapPaths {
        target: target.to_path_buf(),
        old: dir.join(old),
    })
}

/// Creates a new download file in `dir` under a random name, exclusively (never an
/// existing file, never through a symlink), mode 0600 on unix. Read and write.
pub fn create_download(dir: &Path) -> io::Result<(PathBuf, File)> {
    let path = dir.join(format!(
        "{PART_PREFIX}{}{PART_SUFFIX}",
        uuid::Uuid::new_v4().simple()
    ));
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(&path)?;
    Ok((path, file))
}

/// Whether `name` is a download file `create_download` makes.
fn is_download_name(name: &str) -> bool {
    name.starts_with(PART_PREFIX) && name.ends_with(PART_SUFFIX)
}

/// Makes a verified download runnable (rwxr-xr-x) through its open handle. Windows needs
/// nothing.
pub fn make_runnable(file: &File) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o755))?;
    }
    #[cfg(not(unix))]
    let _ = file;
    Ok(())
}

/// How a swap failed.
#[derive(Debug)]
pub enum SwapError {
    /// Nothing changed: the program is where it was.
    Unchanged(io::Error),
    /// The program was moved aside and could not be put back: it is at `old`.
    Stranded(io::Error),
}

/// Moves the program aside and `update` into its place, then syncs the folder. On failure
/// the program is put back where it was, so the old version still starts.
pub fn swap(paths: &SwapPaths, update: &Path) -> Result<(), SwapError> {
    swap_with(paths, update, |from, to| std::fs::rename(from, to))?;
    sync_dir(paths.dir());
    Ok(())
}

/// [`swap`] over `rename`, so failed renames can be tested.
pub fn swap_with(
    paths: &SwapPaths,
    update: &Path,
    mut rename: impl FnMut(&Path, &Path) -> io::Result<()>,
) -> Result<(), SwapError> {
    if !update.is_file() {
        return Err(SwapError::Unchanged(io::Error::new(
            io::ErrorKind::NotFound,
            "the download is missing",
        )));
    }
    // An old file left by an earlier update that never started: replaced.
    match std::fs::remove_file(&paths.old) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(SwapError::Unchanged(e)),
    }
    rename(&paths.target, &paths.old).map_err(SwapError::Unchanged)?;
    let mut last = None;
    for attempt in 0..RENAME_TRIES {
        match rename(update, &paths.target) {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
        if attempt + 1 < RENAME_TRIES {
            std::thread::sleep(RENAME_BACKOFF);
        }
    }
    let error = last.expect("at least one try");
    // Put the program back; the download stays for another try.
    match rename(&paths.old, &paths.target) {
        Ok(()) => Err(SwapError::Unchanged(error)),
        Err(_) => Err(SwapError::Stranded(error)),
    }
}

/// Syncs a folder's entries (the renames) to disk; unix only, best effort.
pub fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// After a start that got its window up: removes the program an update moved aside and
/// any download left by an update that did not finish, except `keep` (a verified
/// download waiting for its restart). True when nothing is left.
pub fn cleanup(paths: &SwapPaths, keep: Option<&Path>) -> bool {
    let mut clean = remove(&paths.old);
    if let Ok(entries) = std::fs::read_dir(paths.dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            let ours = entry.file_name().to_str().is_some_and(is_download_name);
            if ours && Some(path.as_path()) != keep {
                clean &= remove(&path);
            }
        }
    }
    clean
}

fn remove(path: &Path) -> bool {
    match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(e) => e.kind() == io::ErrorKind::NotFound,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(p: &Path) -> String {
        std::fs::read_to_string(p).unwrap()
    }

    fn download(dir: &Path, bytes: &str) -> PathBuf {
        use std::io::Write;
        let (path, mut file) = create_download(dir).unwrap();
        file.write_all(bytes.as_bytes()).unwrap();
        path
    }

    #[test]
    fn paths_for_each_kind() {
        let exe = Path::new("/apps/Contura/Contura_1.0.0_x64_portable.exe");
        let p = swap_paths(InstallKind::Portable, exe).unwrap();
        assert_eq!(p.target, exe);
        assert_eq!(p.old, Path::new("/apps/Contura/contura.old.exe"));
        let image = Path::new("/home/u/Apps/Contura_1.0.0_amd64.AppImage");
        let p = swap_paths(InstallKind::AppImage, image).unwrap();
        assert_eq!(p.old, Path::new("/home/u/Apps/contura.old.AppImage"));
        assert_eq!(swap_paths(InstallKind::Package, image), None);
    }

    #[test]
    fn downloads_get_fresh_private_names() {
        let dir = tempfile::tempdir().unwrap();
        let (a, _) = create_download(dir.path()).unwrap();
        let (b, _) = create_download(dir.path()).unwrap();
        assert_ne!(a, b);
        let name = a.file_name().unwrap().to_str().unwrap();
        assert!(is_download_name(name), "{name}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&a).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    /// `create_new` never opens what is already there, a planted symlink included.
    #[cfg(unix)]
    #[test]
    fn a_planted_symlink_is_never_followed() {
        let dir = tempfile::tempdir().unwrap();
        let victim = dir.path().join("victim");
        std::fs::write(&victim, "keep me").unwrap();
        let planted = dir.path().join("contura.update-x.part");
        std::os::unix::fs::symlink(&victim, &planted).unwrap();
        let err = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&planted)
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(read(&victim), "keep me");
    }

    #[test]
    fn swap_moves_the_update_into_place_and_keeps_the_old_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("Contura.AppImage");
        std::fs::write(&target, "v1").unwrap();
        std::fs::create_dir(dir.path().join("data")).unwrap();
        std::fs::write(dir.path().join("data/app.sqlite"), "mine").unwrap();
        let p = swap_paths(InstallKind::AppImage, &target).unwrap();
        let update = download(dir.path(), "v2");
        make_runnable(&File::open(&update).unwrap()).unwrap();
        swap(&p, &update).unwrap();
        assert_eq!(read(&target), "v2");
        assert_eq!(read(&p.old), "v1");
        assert!(!update.exists());
        // The data folder is never touched.
        assert_eq!(read(&dir.path().join("data/app.sqlite")), "mine");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&target).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755);
        }
    }

    #[test]
    fn the_portable_exe_swaps_the_same_way() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("Contura_1.0.0_x64_portable.exe");
        std::fs::write(&target, "v1").unwrap();
        let p = swap_paths(InstallKind::Portable, &target).unwrap();
        // A file left by an earlier update is replaced.
        std::fs::write(&p.old, "v0").unwrap();
        let update = download(dir.path(), "v2");
        swap(&p, &update).unwrap();
        assert_eq!(read(&target), "v2");
        assert_eq!(read(&p.old), "v1");
    }

    #[test]
    fn a_failing_second_rename_is_retried() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("contura.exe");
        std::fs::write(&target, "v1").unwrap();
        let p = swap_paths(InstallKind::Portable, &target).unwrap();
        let update = download(dir.path(), "v2");
        let mut calls = 0;
        swap_with(&p, &update, |from, to| {
            calls += 1;
            // A scanner holds the new exe for the first two tries.
            if calls == 2 || calls == 3 {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "in use"));
            }
            std::fs::rename(from, to)
        })
        .unwrap();
        assert_eq!(read(&target), "v2");
        assert_eq!(calls, 4);
    }

    #[test]
    fn a_failed_second_rename_puts_the_program_back() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("contura.exe");
        std::fs::write(&target, "v1").unwrap();
        let p = swap_paths(InstallKind::Portable, &target).unwrap();
        let update = download(dir.path(), "v2");
        let err = swap_with(&p, &update, |from, to| {
            if from == update.as_path() {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "locked"));
            }
            std::fs::rename(from, to)
        })
        .unwrap_err();
        assert!(
            matches!(err, SwapError::Unchanged(ref e) if e.kind() == io::ErrorKind::PermissionDenied)
        );
        assert_eq!(read(&target), "v1");
        assert_eq!(read(&update), "v2");
        assert!(!p.old.exists());
    }

    /// M3: the update cannot take the name and the program cannot go back: the error
    /// says so, and the program is kept as the old file.
    #[test]
    fn both_renames_failing_strands_the_program_as_the_old_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("contura.exe");
        std::fs::write(&target, "v1").unwrap();
        let p = swap_paths(InstallKind::Portable, &target).unwrap();
        let update = download(dir.path(), "v2");
        let err = swap_with(&p, &update, |from, to| {
            if from == p.target.as_path() {
                return std::fs::rename(from, to);
            }
            Err(io::Error::new(io::ErrorKind::PermissionDenied, "locked"))
        })
        .unwrap_err();
        assert!(matches!(err, SwapError::Stranded(_)));
        assert!(!target.exists());
        assert_eq!(read(&p.old), "v1");
        assert_eq!(read(&update), "v2");
    }

    #[test]
    fn swap_without_a_download_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("contura.exe");
        std::fs::write(&target, "v1").unwrap();
        let p = swap_paths(InstallKind::Portable, &target).unwrap();
        assert!(matches!(
            swap(&p, &dir.path().join("contura.update-none.part")),
            Err(SwapError::Unchanged(_))
        ));
        assert_eq!(read(&target), "v1");
    }

    #[test]
    fn cleanup_removes_the_old_file_and_stale_downloads_but_keeps_a_ready_one() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("contura.exe");
        std::fs::write(&target, "v2").unwrap();
        let p = swap_paths(InstallKind::Portable, &target).unwrap();
        std::fs::write(&p.old, "v1").unwrap();
        let stale = download(dir.path(), "partial");
        let ready = download(dir.path(), "verified");
        // Files that only look alike are not ours.
        std::fs::write(dir.path().join("contura.update.notes.txt"), "mine").unwrap();
        assert!(cleanup(&p, Some(&ready)));
        assert!(!p.old.exists());
        assert!(!stale.exists());
        assert_eq!(read(&ready), "verified");
        assert_eq!(read(&target), "v2");
        assert!(dir.path().join("contura.update.notes.txt").exists());
        // Nothing to remove is fine.
        assert!(cleanup(&p, Some(&ready)));
        assert!(cleanup(&p, None));
        assert!(!ready.exists());
    }
}
