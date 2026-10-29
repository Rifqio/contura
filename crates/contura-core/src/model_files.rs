//! Schema Model files: `<name>.dbml` plus `<name>.dbml.layout.json`, saved
//! wherever the user chooses, never in Contura's own data folder.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{Error, Result};
use crate::jobs::paths::{
    DIAGRAMS_DIR, PartialFile, PartialWriter, PathUse, check_user_path, flow_file_name,
};
use std::io::Write;

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

/// Reads a Schema Model the user chose; nothing in Contura's data folder.
pub fn read_model_files(dbml_path: &Path, data_dir: &Path) -> Result<ModelFiles> {
    check_user_path(dbml_path, data_dir, PathUse::Open)?;
    let dbml = std::fs::read_to_string(dbml_path).map_err(|e| file_err(dbml_path, "read", e))?;
    let lp = layout_path(dbml_path);
    let layout = match std::fs::read_to_string(&lp) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(file_err(&lp, "read", e)),
    };
    Ok(ModelFiles { dbml, layout })
}

/// Refuses any path inside Contura's data folder: that folder belongs to the app (ADR 0006).
fn check_outside_data(path: &Path, data_dir: &Path) -> Result<()> {
    check_user_path(path, data_dir, PathUse::SchemaModel)
}

/// Writes through a temporary file in the same folder, then renames it over the target.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
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

#[cfg(test)]
thread_local! {
    /// Makes the layout commit of `write_flow_files` fail, for the re-save tests.
    static FAIL_LAYOUT_COMMIT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Moves an existing file aside to `<name>.contura-old-<pid>[-n]`, refusing a read-only
/// one, so a failed save can put it back.
fn move_aside(target: &Path, aside: &mut Vec<(PathBuf, PathBuf)>) -> Result<()> {
    let meta = match std::fs::symlink_metadata(target) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(file_err(target, "replace", e)),
    };
    if meta.permissions().readonly() {
        return Err(Error::File(format!(
            "cannot replace {}: the file is read-only",
            target.display()
        )));
    }
    let base = format!(".contura-old-{}", std::process::id());
    let mut n = 0u32;
    let spot = loop {
        let mut name = target.as_os_str().to_owned();
        name.push(&base);
        if n > 0 {
            name.push(format!("-{n}"));
        }
        let spot = PathBuf::from(name);
        if std::fs::symlink_metadata(&spot).is_err() {
            break spot;
        }
        n += 1;
    };
    std::fs::rename(target, &spot).map_err(|e| file_err(target, "replace", e))?;
    aside.push((target.to_path_buf(), spot));
    Ok(())
}

/// Moves the old files aside, then puts both new ones in place. Records what it moved
/// and placed, so the caller can undo it.
fn place_flow_pair(
    files: [(&Path, PartialWriter); 2],
    aside: &mut Vec<(PathBuf, PathBuf)>,
    placed: &mut Vec<PathBuf>,
) -> Result<()> {
    for (target, _) in &files {
        move_aside(target, aside)?;
    }
    for (i, (target, w)) in files.into_iter().enumerate() {
        #[cfg(test)]
        if i == 1 && FAIL_LAYOUT_COMMIT.with(|f| f.get()) {
            return Err(Error::File(format!(
                "cannot replace {}: a test made it fail",
                target.display()
            )));
        }
        let _ = i;
        w.commit()?;
        placed.push(target.to_path_buf());
    }
    Ok(())
}

/// Whether diagram `name` is saved in `<data>\diagrams` already. The name is checked as
/// `write_flow_files` checks it.
pub fn flow_exists(name: &str, data_dir: &Path) -> Result<bool> {
    let file = flow_file_name(name)?;
    let path = data_dir.join(DIAGRAMS_DIR).join(file);
    match std::fs::symlink_metadata(&path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(file_err(&path, "check", e)),
    }
}

/// Writes diagram `name` as `<data>\diagrams\<name>.flow` and its `.flow.layout.json`
/// together, making the folder if it is missing, and returns the `.flow`
/// path. Both are written to partial files first; existing files are moved aside, both new
/// files are put in place, and on any failure the new ones are removed and the originals
/// restored.
pub fn write_flow_files(name: &str, flow: &str, layout: &str, data_dir: &Path) -> Result<PathBuf> {
    let file = flow_file_name(name)?;
    let dir = data_dir.join(DIAGRAMS_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| file_err(&dir, "create", e))?;
    let path = dir.join(file);
    let path = path.as_path();
    let layout_file = layout_path(path);
    let filled = |target: &Path, text: &str| -> Result<PartialWriter> {
        let mut w = PartialFile::create(target, true, PathUse::Flow, data_dir)?.writer();
        w.write_all(text.as_bytes())
            .map_err(|e| file_err(target, "write", e))?;
        Ok(w)
    };
    let flow_w = filled(path, flow)?;
    let layout_w = filled(&layout_file, layout)?;
    let mut aside = Vec::new();
    let mut placed = Vec::new();
    let result = place_flow_pair(
        [(path, flow_w), (&layout_file, layout_w)],
        &mut aside,
        &mut placed,
    );
    match result {
        Ok(()) => {
            for (_, spot) in &aside {
                let _ = std::fs::remove_file(spot);
            }
            Ok(path.to_path_buf())
        }
        Err(e) => {
            for p in placed.iter().rev() {
                let _ = std::fs::remove_file(p);
            }
            for (original, spot) in aside.iter().rev() {
                let _ = std::fs::rename(spot, original);
            }
            Err(e)
        }
    }
}

pub fn write_binary_file(path: &Path, bytes: &[u8], data_dir: &Path) -> Result<()> {
    check_outside_data(path, data_dir)?;
    write_atomic(path, bytes)
}

pub fn decode_base64(text: &str) -> Result<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|e| Error::InvalidInput(format!("the file data is not valid base64: {e}")))
}

pub fn encode_base64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// For a PNG from the UI, which arrives as base64 over IPC.
pub fn write_base64_file(path: &Path, base64: &str, data_dir: &Path) -> Result<()> {
    let bytes = decode_base64(base64)?;
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
        let files = read_model_files(&path, &outside()).unwrap();
        assert_eq!(files.dbml, "Table a {}\n");
        assert_eq!(files.layout.as_deref(), Some("{\"version\":1}\n"));
        // Saving again replaces both files.
        write_model_files(&path, "Table b {}\n", "{}\n", data.path()).unwrap();
        assert_eq!(
            read_model_files(&path, &outside()).unwrap().dbml,
            "Table b {}\n"
        );
    }

    /// A data folder these tests never write into.
    fn outside() -> PathBuf {
        let d = std::env::temp_dir().join("contura-model-files-test-data");
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn reading_from_the_data_folder_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("notes.dbml");
        std::fs::write(&path, "Table a {}\n").unwrap();
        assert!(matches!(
            read_model_files(&path, data.path()),
            Err(Error::InvalidInput(m)) if m == "Choose a file outside Contura's data folder."
        ));
    }

    fn resave_setup() -> (PathBuf, tempfile::TempDir, PathBuf, PathBuf) {
        let data = tempfile::tempdir().unwrap();
        let path = write_flow_files("orders", "old flow", "old layout", data.path()).unwrap();
        let layout = layout_path(&path);
        (data.path().join(DIAGRAMS_DIR), data, path, layout)
    }

    fn only_the_two_files_remain(dir: &Path) {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["orders.flow", "orders.flow.layout.json"]);
    }

    #[test]
    fn a_failed_layout_commit_on_resave_keeps_both_old_files() {
        let (dir, data, path, layout) = resave_setup();
        FAIL_LAYOUT_COMMIT.with(|f| f.set(true));
        let err = write_flow_files("orders", "new flow", "new layout", data.path()).unwrap_err();
        FAIL_LAYOUT_COMMIT.with(|f| f.set(false));
        assert!(matches!(err, Error::File(_)), "{err:?}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "old flow");
        assert_eq!(std::fs::read_to_string(&layout).unwrap(), "old layout");
        only_the_two_files_remain(&dir);
        // A save that works replaces both and leaves nothing aside.
        write_flow_files("orders", "new flow", "new layout", data.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new flow");
        assert_eq!(std::fs::read_to_string(&layout).unwrap(), "new layout");
        only_the_two_files_remain(&dir);
    }

    /// The old layout is held open with no sharing, so it cannot be moved aside or replaced.
    #[cfg(windows)]
    #[test]
    fn a_locked_layout_on_resave_keeps_both_old_files() {
        use std::os::windows::fs::OpenOptionsExt;
        let (dir, data, path, layout) = resave_setup();
        let hold = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&layout)
            .unwrap();
        let err = write_flow_files("orders", "new flow", "new layout", data.path()).unwrap_err();
        drop(hold);
        assert!(matches!(err, Error::File(_)), "{err:?}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "old flow");
        assert_eq!(std::fs::read_to_string(&layout).unwrap(), "old layout");
        only_the_two_files_remain(&dir);
    }

    #[test]
    fn read_without_layout_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plain.dbml");
        std::fs::write(&path, "Table a {}\n").unwrap();
        assert_eq!(read_model_files(&path, &outside()).unwrap().layout, None);
    }

    #[test]
    fn read_missing_file_is_file_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = read_model_files(&dir.path().join("nope.dbml"), &outside()).unwrap_err();
        assert!(matches!(err, Error::File(_)), "{err:?}");
    }

    #[test]
    fn writes_flow_files_together_in_the_diagrams_folder() {
        let data = tempfile::tempdir().unwrap();
        let dir = data.path().join(DIAGRAMS_DIR);
        assert!(!dir.exists());
        assert!(!flow_exists("orders", data.path()).unwrap());
        let path = write_flow_files(
            "orders",
            "diagram flow \"orders\"\n",
            "{\"version\":1}",
            data.path(),
        )
        .unwrap();
        // The folder is made on the first save.
        assert_eq!(path, dir.join("orders.flow"));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "diagram flow \"orders\"\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("orders.flow.layout.json")).unwrap(),
            "{\"version\":1}"
        );
        assert!(flow_exists("orders", data.path()).unwrap());
        // Written again, both are replaced.
        write_flow_files("orders", "b", "c", data.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "b");
        assert!(!dir.join("orders.flow.partial").exists());
    }

    #[test]
    fn flow_names_with_a_path_are_refused() {
        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let full = outside.path().join("orders").display().to_string();
        for name in [
            "../orders",
            "sub/orders",
            r"sub\orders",
            "..",
            "CON",
            full.as_str(),
        ] {
            let err = write_flow_files(name, "x", "{}", data.path()).unwrap_err();
            assert!(matches!(&err, Error::InvalidInput(_)), "{name}: {err:?}");
            assert!(
                matches!(flow_exists(name, data.path()), Err(Error::InvalidInput(_))),
                "{name}"
            );
        }
        assert!(!data.path().join("orders.flow").exists());
        assert!(!outside.path().join("orders.flow").exists());
    }

    #[test]
    fn a_failed_layout_write_removes_the_flow_file() {
        let data = tempfile::tempdir().unwrap();
        let dir = data.path().join(DIAGRAMS_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("orders.flow");
        let layout = dir.join("orders.flow.layout.json");
        std::fs::write(&layout, "old").unwrap();
        let mut perms = std::fs::metadata(&layout).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&layout, perms.clone()).unwrap();
        let err = write_flow_files("orders", "x", "{}", data.path()).unwrap_err();
        assert!(matches!(err, Error::File(_)), "{err:?}");
        assert!(!path.exists());
        assert_eq!(std::fs::read_to_string(&layout).unwrap(), "old");
        assert!(!dir.join("orders.flow.partial").exists());
        assert!(!dir.join("orders.flow.layout.json.partial").exists());
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        std::fs::set_permissions(&layout, perms).unwrap();
    }

    #[test]
    fn refuses_data_folder() {
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("models").join("shop.dbml");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let err = write_model_files(&path, "x", "{}", data.path()).unwrap_err();
        assert!(
            matches!(&err, Error::InvalidInput(m) if m == "Save Schema Models outside Contura's data folder."),
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
