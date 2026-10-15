use std::io;
use std::path::PathBuf;

/// The portable data folder: `DBVIEW_DATA_DIR` if set (tests and dev), otherwise
/// `data` next to the executable. Creates it and its `webview` subfolder.
pub fn data_dir() -> io::Result<PathBuf> {
    let dir = match std::env::var_os("DBVIEW_DATA_DIR") {
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

    #[test]
    fn data_dir_honours_env_override() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("custom");
        // SAFETY: this is the only test in the crate that touches the environment.
        unsafe { std::env::set_var("DBVIEW_DATA_DIR", &target) };
        let dir = data_dir().unwrap();
        unsafe { std::env::remove_var("DBVIEW_DATA_DIR") };
        assert_eq!(dir, target);
        assert!(dir.join("webview").is_dir());
    }
}
