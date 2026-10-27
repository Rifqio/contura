//! The data folder and the files Contura writes in it are for this OS user only
//! (L1, security audit 1.0). On Unix, Contura's own entries lose their group and other
//! bits: its files end up 0600 and its folders 0700. That happens when they are made and
//! again on every start, when an older build left them looser. Only Contura's own names
//! are touched, never an entry that is a link or that another user owns, so a data
//! folder set with CONTURA_DATA_DIR to a folder that also holds the user's own files
//! keeps those as they are. On Windows the folder keeps the ACL of the per-user profile
//! it sits in.

use std::io;
use std::path::Path;

use crate::jobs::paths::DIAGRAMS_DIR;

/// The files Contura writes at the top of the data folder.
pub const OWN_FILES: &[&str] = &[
    "app.sqlite",
    "app.sqlite-wal",
    "app.sqlite-shm",
    "app.sqlite-journal",
    "contura.lock",
];

/// The folders Contura makes at the top of the data folder.
pub const OWN_DIRS: &[&str] = &["webview", DIAGRAMS_DIR, "group-images"];

/// Creates `dir` and any missing parents; each folder made here is 0700 on Unix. A
/// folder that is already there keeps its mode (see `tighten_own_entries`).
pub fn private_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
    }
}

/// Takes the group and other bits off the entry at `path` when it is there, is not a
/// link and belongs to this user.
pub fn private_file(path: &Path) {
    #[cfg(unix)]
    tighten(path);
    #[cfg(not(unix))]
    let _ = path;
}

/// On start: Contura's own entries at the top of `dir` (`OWN_FILES`, `OWN_DIRS`) are
/// made private, and so is `dir` itself once it holds `app.sqlite`, the sign that it is
/// Contura's data folder. Nothing else in `dir` is touched.
pub fn tighten_own_entries(dir: &Path) {
    #[cfg(unix)]
    {
        for name in OWN_FILES.iter().chain(OWN_DIRS) {
            tighten(&dir.join(name));
        }
        let holds_store = std::fs::symlink_metadata(dir.join("app.sqlite"))
            .is_ok_and(|m| m.file_type().is_file());
        if holds_store {
            tighten(dir);
        }
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Clears the group and other bits, never an owner bit, so a read-only entry stays
/// read-only and an executable stays executable. A link is never followed, and an entry
/// another user owns is left as it is. Errors are ignored: the caller's own open reports
/// a real problem.
#[cfg(unix)]
fn tighten(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    if meta.file_type().is_symlink() || !ours(&meta) {
        return;
    }
    let now = meta.permissions().mode() & 0o7777;
    if now & 0o077 != 0 {
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(now & !0o077));
    }
}

#[cfg(unix)]
fn euid() -> u32 {
    // SAFETY: geteuid takes no arguments, cannot fail and touches no memory.
    unsafe { libc::geteuid() }
}

#[cfg(unix)]
fn ours(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    meta.uid() == euid()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn mode(p: &Path) -> u32 {
        std::fs::symlink_metadata(p).unwrap().permissions().mode() & 0o777
    }
    fn set(p: &Path, m: u32) {
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap();
    }

    #[test]
    fn a_new_folder_is_0700() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("data");
        private_dir(&dir).unwrap();
        assert_eq!(mode(&dir), 0o700);
    }

    #[test]
    fn an_open_file_loses_only_group_and_other_bits() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("contura.lock");
        std::fs::write(&f, b"").unwrap();
        set(&f, 0o644);
        private_file(&f);
        assert_eq!(mode(&f), 0o600);
        private_file(&tmp.path().join("nothing"));
        assert!(!tmp.path().join("nothing").exists());
        // Bits are only taken away, and the owner's are kept: read-only stays read-only,
        // an executable stays executable.
        set(&f, 0o444);
        private_file(&f);
        assert_eq!(mode(&f), 0o400);
        set(&f, 0o755);
        private_file(&f);
        assert_eq!(mode(&f), 0o700);
    }

    #[test]
    fn a_link_is_never_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside.txt");
        std::fs::write(&outside, b"x").unwrap();
        set(&outside, 0o644);
        let link = tmp.path().join("app.sqlite-wal");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        private_file(&link);
        assert_eq!(mode(&outside), 0o644);
    }

    #[test]
    fn an_entry_of_another_user_is_left_alone() {
        // Root owns /etc/passwd; as anyone but root it is not ours.
        let meta = std::fs::symlink_metadata("/etc/passwd").unwrap();
        if euid() != 0 {
            assert!(!ours(&meta));
        }
        let tmp = tempfile::tempdir().unwrap();
        assert!(ours(&std::fs::symlink_metadata(tmp.path()).unwrap()));
    }

    #[test]
    fn only_conturas_own_entries_are_tightened() {
        // A data folder that also holds the user's own files (CONTURA_DATA_DIR pointing at
        // an existing folder): only Contura's names change.
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("shared");
        std::fs::create_dir(&dir).unwrap();
        set(&dir, 0o755);
        let outside = tmp.path().join("outside.txt");
        std::fs::write(&outside, b"x").unwrap();
        set(&outside, 0o644);
        std::fs::write(dir.join("notes.txt"), b"mine").unwrap();
        set(&dir.join("notes.txt"), 0o644);
        std::fs::write(dir.join("run.sh"), b"#!/bin/sh").unwrap();
        set(&dir.join("run.sh"), 0o755);
        std::fs::create_dir(dir.join("projects")).unwrap();
        set(&dir.join("projects"), 0o755);
        std::os::unix::fs::symlink(&outside, dir.join("link.txt")).unwrap();

        // Not yet Contura's (no app.sqlite): the folder itself keeps its mode.
        tighten_own_entries(&dir);
        assert_eq!(mode(&dir), 0o755);

        for (name, m) in [
            ("app.sqlite", 0o644),
            ("app.sqlite-wal", 0o664),
            ("contura.lock", 0o644),
        ] {
            std::fs::write(dir.join(name), b"").unwrap();
            set(&dir.join(name), m);
        }
        for name in ["webview", "diagrams", "group-images"] {
            std::fs::create_dir(dir.join(name)).unwrap();
            set(&dir.join(name), 0o775);
        }
        tighten_own_entries(&dir);
        assert_eq!(mode(&dir), 0o700);
        for name in ["app.sqlite", "app.sqlite-wal", "contura.lock"] {
            assert_eq!(mode(&dir.join(name)), 0o600, "{name}");
        }
        for name in ["webview", "diagrams", "group-images"] {
            assert_eq!(mode(&dir.join(name)), 0o700, "{name}");
        }
        assert_eq!(mode(&dir.join("notes.txt")), 0o644);
        assert_eq!(mode(&dir.join("run.sh")), 0o755);
        assert_eq!(mode(&dir.join("projects")), 0o755);
        assert_eq!(mode(&outside), 0o644);
    }
}
