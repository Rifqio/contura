//! Schema Model files: `<name>.dbml` plus `<name>.dbml.layout.json`, saved
//! wherever the user chooses, never in DB View's own data folder.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{Error, Result};

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelFiles {
    pub dbml: String,
    pub layout: Option<String>,
}

pub fn layout_path(dbml_path: &Path) -> PathBuf {
    let mut p = dbml_path.as_os_str().to_owned();
    p.push(".layout.json");
    PathBuf::from(p)
}

fn file_err(path: &Path, what: &str, e: std::io::Error) -> Error {
    Error::File(format!("cannot {what} {}: {e}", path.display()))
}

pub fn read_model_files(dbml_path: &Path) -> Result<ModelFiles> {
    let dbml = std::fs::read_to_string(dbml_path).map_err(|e| file_err(dbml_path, "read", e))?;
    let lp = layout_path(dbml_path);
    let layout = match std::fs::read_to_string(&lp) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(file_err(&lp, "read", e)),
    };
    Ok(ModelFiles { dbml, layout })
}

/// The full path of `path`'s parent folder plus its file name, resolving `..` and links.
fn resolved(path: &Path) -> Option<PathBuf> {
    let parent = path.parent()?.canonicalize().ok()?;
    Some(parent.join(path.file_name()?))
}

/// Refuses any path inside DB View's data folder: that folder belongs to the app (ADR 0006).
fn check_outside_data(path: &Path, data_dir: &Path) -> Result<()> {
    let inside = match (resolved(path), data_dir.canonicalize()) {
        (Some(p), Ok(d)) => p.starts_with(d),
        _ => false,
    };
    if inside {
        return Err(Error::InvalidInput(
            "Save Schema Models outside DB View's data folder".into(),
        ));
    }
    Ok(())
}

/// Writes through a temporary file in the same folder, then renames it over the target.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".tmp-{}", std::process::id()));
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, bytes).map_err(|e| file_err(path, "write", e))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        file_err(path, "write", e)
    })
}

pub fn write_model_files(
    dbml_path: &Path,
    dbml: &str,
    layout: &str,
    data_dir: &Path,
) -> Result<()> {
    check_outside_data(dbml_path, data_dir)?;
    write_atomic(dbml_path, dbml.as_bytes())?;
    write_atomic(&layout_path(dbml_path), layout.as_bytes())
}

pub fn write_text_file(path: &Path, text: &str, data_dir: &Path) -> Result<()> {
    check_outside_data(path, data_dir)?;
    write_atomic(path, text.as_bytes())
}

pub fn write_binary_file(path: &Path, bytes: &[u8], data_dir: &Path) -> Result<()> {
    check_outside_data(path, data_dir)?;
    write_atomic(path, bytes)
}

/// For a PNG from the UI, which arrives as base64 over IPC.
pub fn write_base64_file(path: &Path, base64: &str, data_dir: &Path) -> Result<()> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64)
        .map_err(|e| Error::InvalidInput(format!("the file data is not valid base64: {e}")))?;
    write_binary_file(path, &bytes, data_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_base64_files() {
        let dir = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let path = dir.path().join("d.png");
        write_base64_file(&path, "iVBORw==", data.path()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), vec![137, 80, 78, 71]);
        assert!(matches!(
            write_base64_file(&path, "%%", data.path()),
            Err(Error::InvalidInput(_))
        ));
    }

    #[test]
    fn write_then_read_round_trips_with_layout() {
        let dir = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let path = dir.path().join("shop.dbml");
        write_model_files(&path, "Table a {}\n", "{\"version\":1}\n", data.path()).unwrap();
        assert!(dir.path().join("shop.dbml.layout.json").exists());
        let files = read_model_files(&path).unwrap();
        assert_eq!(files.dbml, "Table a {}\n");
        assert_eq!(files.layout.as_deref(), Some("{\"version\":1}\n"));
        // Saving again replaces both files.
        write_model_files(&path, "Table b {}\n", "{}\n", data.path()).unwrap();
        assert_eq!(read_model_files(&path).unwrap().dbml, "Table b {}\n");
    }

    #[test]
    fn read_without_layout_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plain.dbml");
        std::fs::write(&path, "Table a {}\n").unwrap();
        assert_eq!(read_model_files(&path).unwrap().layout, None);
    }

    #[test]
    fn read_missing_file_is_file_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = read_model_files(&dir.path().join("nope.dbml")).unwrap_err();
        assert!(matches!(err, Error::File(_)), "{err:?}");
    }

    #[test]
    fn refuses_data_folder() {
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("models").join("shop.dbml");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let err = write_model_files(&path, "x", "{}", data.path()).unwrap_err();
        assert!(
            matches!(&err, Error::InvalidInput(m) if m == "Save Schema Models outside DB View's data folder"),
            "{err:?}"
        );
        assert!(!path.exists());
        let err = write_text_file(&data.path().join("x.sql"), "x", data.path()).unwrap_err();
        assert!(matches!(err, Error::InvalidInput(_)), "{err:?}");
    }

    #[test]
    fn writes_binary_files() {
        let dir = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let path = dir.path().join("diagram.png");
        write_binary_file(&path, &[137, 80, 78, 71], data.path()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), vec![137, 80, 78, 71]);
    }
}
