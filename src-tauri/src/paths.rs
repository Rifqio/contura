use std::ffi::OsString;
use std::io;
use std::path::PathBuf;

const ENV: &str = "CONTURA_DATA_DIR";
/// Accepted when `CONTURA_DATA_DIR` is unset, for setups made before the rename.
const LEGACY_ENV: &str = "DBVIEW_DATA_DIR";

fn override_dir() -> Option<OsString> {
    std::env::var_os(ENV).or_else(|| std::env::var_os(LEGACY_ENV))
}

/// The portable data folder: `CONTURA_DATA_DIR` if set (tests and dev; the older
/// `DBVIEW_DATA_DIR` still works), otherwise `data` next to the executable.
/// Creates it and its `webview` subfolder.
pub fn data_dir() -> io::Result<PathBuf> {
    let dir = match override_dir() {
        Some(dir) => PathBuf::from(dir),
        None => {
            let exe = std::env::current_exe()?;
            let parent = exe
                .parent()
                .ok_or_else(|| io::Error::other("executable has no parent folder"))?;
            parent.join("data")
        }
    };
    std::fs::create_dir_all(dir.join("webview"))?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
