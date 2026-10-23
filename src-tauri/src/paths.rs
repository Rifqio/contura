use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

const ENV: &str = "CONTURA_DATA_DIR";
/// Accepted when `CONTURA_DATA_DIR` is unset, for setups made before the rename.
const LEGACY_ENV: &str = "DBVIEW_DATA_DIR";

/// The environment values the choice depends on, read once so the decision stays pure.
#[derive(Default)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
struct DirEnv {
    contura: Option<OsString>,
    legacy: Option<OsString>,
    appimage: Option<OsString>,
    appdir: Option<OsString>,
    xdg: Option<OsString>,
    home: Option<OsString>,
}

impl DirEnv {
    fn from_process() -> Self {
        DirEnv {
            contura: std::env::var_os(ENV),
            legacy: std::env::var_os(LEGACY_ENV),
            appimage: std::env::var_os("APPIMAGE"),
            appdir: std::env::var_os("APPDIR").map(canonical_appdir),
            xdg: std::env::var_os("XDG_DATA_HOME"),
            home: std::env::var_os("HOME"),
        }
    }
}

/// Picks the data folder without touching the disk except through `can_create`.
/// Order: `CONTURA_DATA_DIR`, `DBVIEW_DATA_DIR`; on Linux the folder beside the
/// AppImage file (if this process runs from that AppImage, see `own_appimage`, and
/// `can_create` accepts it), then `data` beside the executable (if
/// `can_create` accepts it), then the XDG data home (an installed .deb cannot write
/// to /usr/bin, and an AppImage may sit in a read-only folder). Elsewhere `data`
/// beside the executable.
fn resolve(env: &DirEnv, exe: &Path, can_create: impl Fn(&Path) -> bool) -> PathBuf {
    if let Some(dir) = env.contura.as_ref().or(env.legacy.as_ref()) {
        return PathBuf::from(dir);
    }
    #[cfg(target_os = "linux")]
    {
        let beside = |file: &Path| file.parent().map(|p| p.join("data"));
        if let Some(dir) = own_appimage(env, exe)
            .and_then(beside)
            .filter(|d| can_create(d))
        {
            return dir;
        }
        let local = beside(exe);
        if let Some(dir) = local.as_ref().filter(|d| can_create(d)) {
            return dir.clone();
        }
        let xdg = env
            .xdg
            .as_ref()
            .map(PathBuf::from)
            .filter(|p| p.is_absolute());
        let base = xdg.or_else(|| {
            env.home
                .as_ref()
                .filter(|h| !h.is_empty())
                .map(|h| PathBuf::from(h).join(".local/share"))
        });
        if let Some(base) = base {
            return base.join("contura");
        }
        // No home either: report the error from the exe folder.
        local.unwrap_or_else(|| exe.join("data"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = can_create;
        exe.parent()
            .map_or_else(|| exe.join("data"), |p| p.join("data"))
    }
}

/// `APPDIR` with its symlinks resolved, as `current_exe()` (`/proc/self/exe`) always is:
/// a mount under a linked `/tmp` or `$TMPDIR` (`/home` -> `/var/home` on Silverblue)
/// would otherwise never hold the exe. A relative or missing path is kept as it is, so
/// `own_appimage` still refuses it.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn canonical_appdir(raw: OsString) -> OsString {
    if !Path::new(&raw).is_absolute() {
        return raw;
    }
    std::fs::canonicalize(&raw).map_or(raw, PathBuf::into_os_string)
}

/// The AppImage file this process runs from: `APPIMAGE` only when it is an absolute
/// path and `APPDIR` (the AppImage's mount) is set, absolute and holds `exe`. Every
/// child of any AppImage inherits both variables, so a .deb Contura started from a
/// terminal inside another AppImage must not put its data beside that other file.
#[cfg(target_os = "linux")]
fn own_appimage<'a>(env: &'a DirEnv, exe: &Path) -> Option<&'a Path> {
    let file = Path::new(env.appimage.as_ref()?);
    let mount = Path::new(env.appdir.as_ref()?);
    (file.is_absolute() && mount.is_absolute() && exe.starts_with(mount)).then_some(file)
}

/// The AppImage file this process runs from, when it runs from one (see `own_appimage`)
/// and it passes `checked_appimage`: the file an update replaces. Otherwise None, and the
/// update shows a link to the release instead of swapping a file.
#[cfg(target_os = "linux")]
pub fn appimage_file() -> Option<PathBuf> {
    let env = DirEnv::from_process();
    let exe = std::env::current_exe().ok()?;
    checked_appimage(own_appimage(&env, &exe)?)
}

/// `raw` resolved (symlinks followed to the real file), when that is a regular file named
/// `*.AppImage` that starts like a type 2 AppImage: an ELF file with `AI` and 2 at byte 8,
/// as the runtime that sets `APPIMAGE` requires.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn checked_appimage(raw: &Path) -> Option<PathBuf> {
    use std::io::Read;
    let file = std::fs::canonicalize(raw).ok()?;
    if !std::fs::symlink_metadata(&file).ok()?.is_file() {
        return None;
    }
    if !file.file_name()?.to_str()?.ends_with(".AppImage") {
        return None;
    }
    let mut head = [0u8; 11];
    std::fs::File::open(&file)
        .ok()?
        .read_exact(&mut head)
        .ok()?;
    (head[..4] == *b"\x7fELF" && head[8..11] == *b"AI\x02").then_some(file)
}

/// Whether `dir` can hold the data: its `webview` subfolder can be made and a file can
/// be written in it. An existing folder the user cannot write to (made once by root,
/// or by an admin beside a shared AppImage) fails the second check.
fn writable(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir.join("webview")).is_err() {
        return false;
    }
    let probe = dir.join(format!(".contura-write-probe-{}", std::process::id()));
    probe_write(
        &probe,
        |p| {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(p)
                .map(drop)
        },
        |p| std::fs::remove_file(p),
    )
}

/// Creates and removes `probe` with `create` (create-new) and `remove`. A probe that is
/// already there (left by a crashed start, or made at this moment by a process with the
/// same pid in another pid namespace) is removed and the create is tried once more. Its
/// owner removing it first (`NotFound`) is no reason to call the folder read-only.
fn probe_write(
    probe: &Path,
    mut create: impl FnMut(&Path) -> io::Result<()>,
    mut remove: impl FnMut(&Path) -> io::Result<()>,
) -> bool {
    for _ in 0..2 {
        match create(probe) {
            Ok(()) => {
                let _ = remove(probe);
                return true;
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => match remove(probe) {
                // Removing an entry needs write access to the folder: that proves it.
                Ok(()) => return true,
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(_) => return false,
            },
            Err(_) => return false,
        }
    }
    // Made and removed by another process twice over: someone writes here.
    true
}

/// Held for the life of the process: one Contura per data folder.
pub struct DataLock(#[allow(dead_code)] std::fs::File);

/// Why the data folder could not be locked: another process holds it.
#[derive(Debug)]
pub struct DataFolderBusy(pub PathBuf);

impl std::fmt::Display for DataFolderBusy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Another Contura is using the data folder {}, or is still closing. Close it, or wait a moment, then start Contura again.",
            self.0.display()
        )
    }
}

impl std::error::Error for DataFolderBusy {}

/// Takes the exclusive lock on `dir/contura.lock`, trying for up to `wait`, so two
/// Contura processes never share one data folder, whatever the single-instance plugin
/// does. A file system without locks (some network shares) is not refused: the lock is
/// then skipped.
pub fn lock_data_dir(
    dir: &Path,
    wait: std::time::Duration,
) -> Result<Option<DataLock>, DataFolderBusy> {
    let Ok(file) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join("contura.lock"))
    else {
        return Ok(None);
    };
    let end = std::time::Instant::now() + wait;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(Some(DataLock(file))),
            Err(std::fs::TryLockError::WouldBlock) => {}
            Err(std::fs::TryLockError::Error(_)) => return Ok(None),
        }
        if std::time::Instant::now() >= end {
            return Err(DataFolderBusy(dir.to_path_buf()));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// The data folder: `CONTURA_DATA_DIR` if set (tests and dev; the older
/// `DBVIEW_DATA_DIR` still works), otherwise `data` next to the executable (next to
/// the .AppImage file inside an AppImage), falling back to the XDG data home when
/// that folder is not writable. Creates it and its `webview` subfolder.
pub fn data_dir() -> io::Result<PathBuf> {
    let env = DirEnv::from_process();
    let dir = match env.contura.as_ref().or(env.legacy.as_ref()) {
        Some(dir) => PathBuf::from(dir),
        None => {
            let exe = std::env::current_exe()?;
            resolve(&env, &exe, writable)
        }
    };
    std::fs::create_dir_all(dir.join("webview"))?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn os(s: &str) -> Option<OsString> {
        Some(OsString::from(s))
    }

    const EXE: &str = "/opt/app/contura";

    fn yes(_: &Path) -> bool {
        true
    }

    fn no(_: &Path) -> bool {
        false
    }

    #[test]
    fn env_override_wins_over_everything() {
        let env = DirEnv {
            contura: os("/x/new"),
            legacy: os("/x/old"),
            appimage: os("/home/u/Contura.AppImage"),
            ..DirEnv::default()
        };
        assert_eq!(resolve(&env, Path::new(EXE), no), PathBuf::from("/x/new"));
    }

    #[test]
    fn legacy_env_wins_when_the_new_one_is_unset() {
        let env = DirEnv {
            legacy: os("/x/old"),
            appimage: os("/home/u/Contura.AppImage"),
            ..DirEnv::default()
        };
        assert_eq!(resolve(&env, Path::new(EXE), no), PathBuf::from("/x/old"));
    }

    #[test]
    fn exe_dir_is_used_when_nothing_else_applies() {
        assert_eq!(
            resolve(&DirEnv::default(), Path::new(EXE), yes),
            PathBuf::from("/opt/app/data")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn appimage_uses_data_beside_the_appimage_file() {
        let env = DirEnv {
            appimage: os("/home/u/apps/Contura.AppImage"),
            appdir: os("/tmp/.mount_x"),
            ..DirEnv::default()
        };
        // The exe sits in a read-only mount; it must not even be consulted.
        let seen = std::cell::RefCell::new(Vec::new());
        let got = resolve(&env, Path::new("/tmp/.mount_x/usr/bin/contura"), |p| {
            seen.borrow_mut().push(p.to_path_buf());
            true
        });
        assert_eq!(*seen.borrow(), vec![PathBuf::from("/home/u/apps/data")]);
        assert_eq!(got, PathBuf::from("/home/u/apps/data"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn read_only_appimage_folder_falls_back_to_xdg() {
        let env = DirEnv {
            appimage: os("/home/u/apps/Contura.AppImage"),
            appdir: os("/tmp/.mount_x"),
            xdg: os("/home/u/xdg"),
            ..DirEnv::default()
        };
        assert_eq!(
            resolve(&env, Path::new("/tmp/.mount_x/usr/bin/contura"), no),
            PathBuf::from("/home/u/xdg/contura")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn empty_appimage_is_ignored() {
        let env = DirEnv {
            appimage: os(""),
            ..DirEnv::default()
        };
        assert_eq!(
            resolve(&env, Path::new(EXE), yes),
            PathBuf::from("/opt/app/data")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_inherited_appimage_is_not_ours() {
        // A .deb Contura started from a terminal inside another AppImage: both variables
        // name that other app, or only APPIMAGE survived. The data stays beside the exe.
        let deb = Path::new("/usr/bin/contura");
        let cases = [
            ("no APPDIR", None),
            ("exe outside APPDIR", os("/tmp/.mount_ide")),
            ("relative APPDIR", os("tmp/.mount_ide")),
            ("empty APPDIR", os("")),
        ];
        for (what, appdir) in cases {
            let env = DirEnv {
                appimage: os("/home/u/Applications/Ide.AppImage"),
                appdir,
                xdg: os("/home/u/xdg"),
                ..DirEnv::default()
            };
            let seen = std::cell::RefCell::new(Vec::new());
            let got = resolve(&env, deb, |p| {
                seen.borrow_mut().push(p.to_path_buf());
                false
            });
            assert_eq!(got, PathBuf::from("/home/u/xdg/contura"), "{what}");
            assert_eq!(
                *seen.borrow(),
                vec![PathBuf::from("/usr/bin/data")],
                "{what}"
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_relative_appimage_is_ignored() {
        // A relative APPIMAGE would put `data` under whatever the current folder is.
        let env = DirEnv {
            appimage: os("Contura.AppImage"),
            appdir: os("/tmp/.mount_x"),
            xdg: os("/home/u/xdg"),
            ..DirEnv::default()
        };
        assert_eq!(
            resolve(&env, Path::new("/tmp/.mount_x/usr/bin/contura"), yes),
            PathBuf::from("/tmp/.mount_x/usr/bin/data")
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_existing_read_only_folder_is_not_writable() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let fresh = tmp.path().join("fresh");
        assert!(writable(&fresh));
        assert!(fresh.join("webview").is_dir());
        // The probe file is gone again.
        assert_eq!(std::fs::read_dir(&fresh).unwrap().count(), 1);

        // Made once by root (`sudo contura`): webview exists, nothing can be written.
        let locked = tmp.path().join("locked");
        std::fs::create_dir_all(locked.join("webview")).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
        // Gives the folder its write bit back even when the assertion below fails, so the
        // temp dir can still be removed.
        struct Unlock<'a>(&'a Path);
        impl Drop for Unlock<'_> {
            fn drop(&mut self) {
                let _ = std::fs::set_permissions(self.0, std::fs::Permissions::from_mode(0o755));
            }
        }
        let _unlock = Unlock(&locked);
        // Root writes through any mode bits; the check means nothing there.
        let root = std::fs::File::create(locked.join("root-check")).is_ok();
        if !root {
            assert!(!writable(&locked));
        }
    }

    fn kind(k: io::ErrorKind) -> io::Result<()> {
        Err(io::Error::from(k))
    }

    #[test]
    fn a_probe_its_owner_removes_first_is_tried_again() {
        // Same pid in another namespace: our create finds its probe, then it removes it
        // before we can. The folder is writable; the second create proves it.
        let creates = std::cell::Cell::new(0);
        let ok = probe_write(
            Path::new("/d/.probe"),
            |_| {
                creates.set(creates.get() + 1);
                if creates.get() == 1 {
                    kind(io::ErrorKind::AlreadyExists)
                } else {
                    Ok(())
                }
            },
            |_| {
                if creates.get() == 1 {
                    kind(io::ErrorKind::NotFound)
                } else {
                    Ok(())
                }
            },
        );
        assert!(ok);
        assert_eq!(creates.get(), 2);
    }

    #[test]
    fn a_probe_that_cannot_be_written_or_removed_is_not_writable() {
        let denied = || kind(io::ErrorKind::PermissionDenied);
        assert!(!probe_write(
            Path::new("/d/.probe"),
            |_| denied(),
            |_| Ok(())
        ));
        assert!(!probe_write(
            Path::new("/d/.probe"),
            |_| kind(io::ErrorKind::AlreadyExists),
            |_| denied()
        ));
        // A leftover probe this process can remove proves the folder.
        assert!(probe_write(
            Path::new("/d/.probe"),
            |_| kind(io::ErrorKind::AlreadyExists),
            |_| Ok(())
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_symlinked_appdir_still_holds_the_exe() {
        // The runtime mounts under a linked folder; /proc/self/exe gives the real path.
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("var-home/.mount_x");
        std::fs::create_dir_all(real.join("usr/bin")).unwrap();
        let link = tmp.path().join("home");
        std::os::unix::fs::symlink(tmp.path().join("var-home"), &link).unwrap();
        let raw = link.join(".mount_x").into_os_string();
        let exe = std::fs::canonicalize(&real)
            .unwrap()
            .join("usr/bin/contura");
        let env = DirEnv {
            appimage: os("/home/u/apps/Contura.AppImage"),
            appdir: Some(canonical_appdir(raw.clone())),
            ..DirEnv::default()
        };
        assert_eq!(resolve(&env, &exe, yes), PathBuf::from("/home/u/apps/data"));
        // Unresolved, the same mount is not recognised.
        let env = DirEnv {
            appdir: Some(raw),
            ..env
        };
        assert_ne!(resolve(&env, &exe, yes), PathBuf::from("/home/u/apps/data"));
        // Relative and missing paths are left alone.
        assert_eq!(canonical_appdir("rel/x".into()), OsString::from("rel/x"));
        assert_eq!(
            canonical_appdir("/no/such/mount".into()),
            OsString::from("/no/such/mount")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn read_only_exe_dir_falls_back_to_xdg_data_home() {
        let env = DirEnv {
            xdg: os("/home/u/xdg"),
            home: os("/home/u"),
            ..DirEnv::default()
        };
        assert_eq!(
            resolve(&env, Path::new("/usr/bin/contura"), no),
            PathBuf::from("/home/u/xdg/contura")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn empty_or_relative_xdg_falls_back_to_home() {
        for xdg in ["", "relative/dir"] {
            let env = DirEnv {
                xdg: os(xdg),
                home: os("/home/u"),
                ..DirEnv::default()
            };
            assert_eq!(
                resolve(&env, Path::new("/usr/bin/contura"), no),
                PathBuf::from("/home/u/.local/share/contura"),
                "xdg = {xdg:?}"
            );
        }
        let unset = DirEnv {
            home: os("/home/u"),
            ..DirEnv::default()
        };
        assert_eq!(
            resolve(&unset, Path::new("/usr/bin/contura"), no),
            PathBuf::from("/home/u/.local/share/contura")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_closure_is_asked_about_the_exe_data_folder() {
        let seen = std::cell::RefCell::new(Vec::new());
        let env = DirEnv::default();
        resolve(&env, Path::new(EXE), |p| {
            seen.borrow_mut().push(p.to_path_buf());
            true
        });
        assert_eq!(*seen.borrow(), vec![PathBuf::from("/opt/app/data")]);
    }

    // One test owns the environment so the cases cannot race each other.
    #[test]
    fn data_dir_honours_env_override_and_legacy_fallback() {
        let tmp = tempfile::tempdir().unwrap();
        let new = tmp.path().join("new");
        let old = tmp.path().join("old");
        // SAFETY: this is the only test in the crate that touches the environment.
        unsafe {
            std::env::remove_var(ENV);
            std::env::set_var(LEGACY_ENV, &old);
        }
        let from_legacy = data_dir().unwrap();
        unsafe { std::env::set_var(ENV, &new) };
        let from_new = data_dir().unwrap();
        unsafe {
            std::env::remove_var(ENV);
            std::env::remove_var(LEGACY_ENV);
        }
        assert_eq!(from_legacy, old);
        assert_eq!(from_new, new);
        assert!(new.join("webview").is_dir());
    }

    fn appimage_bytes() -> Vec<u8> {
        let mut b = b"\x7fELF\x02\x01\x01\x00AI\x02".to_vec();
        b.extend_from_slice(&[0u8; 64]);
        b
    }

    #[test]
    fn a_real_appimage_file_is_accepted_through_a_link() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("Contura_1.0.0_amd64.AppImage");
        std::fs::write(&file, appimage_bytes()).unwrap();
        let real = std::fs::canonicalize(&file).unwrap();
        assert_eq!(checked_appimage(&file), Some(real.clone()));
        #[cfg(unix)]
        {
            let link = dir.path().join("contura");
            std::os::unix::fs::symlink(&file, &link).unwrap();
            // The link resolves to the real file, which is what gets swapped.
            assert_eq!(checked_appimage(&link), Some(real));
        }
    }

    #[test]
    fn anything_else_falls_back_to_the_notice() {
        let dir = tempfile::tempdir().unwrap();
        // Not named .AppImage.
        let plain = dir.path().join("contura");
        std::fs::write(&plain, appimage_bytes()).unwrap();
        assert_eq!(checked_appimage(&plain), None);
        // Named .AppImage, but not one.
        let fake = dir.path().join("notes.AppImage");
        std::fs::write(&fake, b"just some text in a file").unwrap();
        assert_eq!(checked_appimage(&fake), None);
        // An ELF without the AppImage mark.
        let mut elf = appimage_bytes();
        elf[8] = 0;
        let bare = dir.path().join("bare.AppImage");
        std::fs::write(&bare, elf).unwrap();
        assert_eq!(checked_appimage(&bare), None);
        // A folder, and a missing file.
        let folder = dir.path().join("dir.AppImage");
        std::fs::create_dir(&folder).unwrap();
        assert_eq!(checked_appimage(&folder), None);
        assert_eq!(checked_appimage(&dir.path().join("gone.AppImage")), None);
    }

    #[test]
    fn one_process_at_a_time_holds_the_data_folder() {
        use std::time::{Duration, Instant};
        let dir = tempfile::tempdir().unwrap();
        let first = lock_data_dir(dir.path(), Duration::ZERO).unwrap();
        assert!(first.is_some());
        // A second holder (another open of the file, as another process would make) waits,
        // then is refused with a sentence that names the folder.
        let started = Instant::now();
        let err = lock_data_dir(dir.path(), Duration::from_millis(300))
            .err()
            .unwrap();
        assert!(started.elapsed() >= Duration::from_millis(300));
        assert!(
            err.to_string()
                .starts_with("Another Contura is using the data folder")
        );
        assert!(err.to_string().contains(&dir.path().display().to_string()));
        // Once the first lets go (it exits), the next one gets it, within its wait.
        let holder = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            drop(first);
        });
        assert!(
            lock_data_dir(dir.path(), Duration::from_secs(5))
                .unwrap()
                .is_some()
        );
        holder.join().unwrap();
    }

    /// The same across processes: `flock(1)` holds the lock file as another Contura would.
    #[cfg(target_os = "linux")]
    #[test]
    fn another_process_holding_the_data_folder_is_waited_for_then_refused() {
        use std::time::Duration;
        if std::process::Command::new("flock")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("contura.lock");
        let ready = dir.path().join("held");
        let mut other = std::process::Command::new("flock")
            .arg(&lock)
            .args(["sh", "-c", &format!("touch '{}'; sleep 3", ready.display())])
            .spawn()
            .unwrap();
        while !ready.exists() {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(lock_data_dir(dir.path(), Duration::from_millis(300)).is_err());
        // The relaunch wait outlasts the other process, then takes the folder.
        assert!(
            lock_data_dir(dir.path(), Duration::from_secs(10))
                .unwrap()
                .is_some()
        );
        other.wait().unwrap();
    }
}
