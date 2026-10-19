//! The diagrams folder: every diagram is `<data>\diagrams\<name>.flow` plus its
//! `<name>.flow.layout.json` (step 6+, answer 1B, Q35). The Core builds each path from the
//! name; the only ways a diagram leaves the folder are "Save a copy as..." and Publish.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::error::{Error, Result};
use crate::jobs::paths::{DIAGRAMS_DIR, PartialFile, PathUse, check_user_path, flow_file_name};
use crate::model_files::{flow_exists, layout_path, write_atomic, write_flow_files};

pub use crate::jobs::paths::DIAGRAM_NAME_REFUSAL as NAME_REFUSAL;

/// The most `diagram_head` reads of a file: the first line of any real diagram fits.
const HEAD_MAX: u64 = 4096;

/// The largest diagram file `read_diagram` opens (P24 M4): a mistaken huge file is refused with a
/// plain message instead of filling memory. The parser's own tests go up to this size.
pub const READ_MAX: u64 = 5 * 1024 * 1024;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiagramKind {
    Dfd,
    Flow,
    Cloud,
    /// The first line is not `diagram dfd`, `diagram flow` or `diagram cloud`.
    Unknown,
}

/// One diagram in the folder, from its file's first line.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagramEntry {
    /// The name as typed: the file name without `.flow`.
    pub name: String,
    pub kind: DiagramKind,
    /// The quoted title on the first line, or the name when there is none.
    pub title: String,
    /// When the `.flow` file last changed, in milliseconds since 1970.
    pub modified_ms: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagramFiles {
    pub text: String,
    pub layout: Option<String>,
}

pub fn diagrams_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(DIAGRAMS_DIR)
}

/// The one name rule, shared with the step 7 `write_flow_files` and the `PathUse::Flow`
/// guard: every bad name is refused with `NAME_REFUSAL`.
pub fn check_diagram_name(name: &str) -> Result<()> {
    flow_file_name(name).map(|_| ())
}

/// The `.flow` path of `name` and the name without the extension.
fn flow_path(data_dir: &Path, name: &str) -> Result<(PathBuf, String)> {
    let file = flow_file_name(name)?;
    let base = file.strip_suffix(".flow").unwrap_or(&file).to_string();
    Ok((diagrams_dir(data_dir).join(file), base))
}

fn file_err(path: &Path, what: &str, e: std::io::Error) -> Error {
    Error::File(format!("cannot {what} {}: {e}", path.display()))
}

fn not_found(base: &str) -> Error {
    Error::NotFound(format!("{base}.flow"))
}

fn exists(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(file_err(path, "check", e)),
    }
}

/// `"..."` with `\\` and `\"` escapes, and `\n` and `\r` for the line breaks the writer
/// escapes (P5), as `flowModel.ts` writes it; `None` when unclosed.
fn unquote(rest: &str) -> Option<String> {
    let mut out = String::new();
    let mut chars = rest.strip_prefix('"')?.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => out.push(match chars.next()? {
                'n' => '\n',
                'r' => '\r',
                c => c,
            }),
            c => out.push(c),
        }
    }
    None
}

/// The kind and title from a diagram's first line, `diagram dfd "Checkout"`. It reads at
/// most 4 KB, so a large file costs no more than a small one.
pub fn diagram_head(reader: impl Read) -> (DiagramKind, Option<String>) {
    let mut line = Vec::new();
    if BufReader::new(reader.take(HEAD_MAX))
        .read_until(b'\n', &mut line)
        .is_err()
    {
        return (DiagramKind::Unknown, None);
    }
    let line = String::from_utf8_lossy(&line);
    let line = line.trim_start_matches('\u{feff}').trim();
    let Some(rest) = line.strip_prefix("diagram") else {
        return (DiagramKind::Unknown, None);
    };
    if !rest.starts_with(char::is_whitespace) {
        return (DiagramKind::Unknown, None);
    }
    let rest = rest.trim_start();
    let (word, rest) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    let kind = match word {
        "dfd" => DiagramKind::Dfd,
        "flow" => DiagramKind::Flow,
        "cloud" => DiagramKind::Cloud,
        _ => return (DiagramKind::Unknown, None),
    };
    let rest = rest.trim();
    let title = if rest.starts_with('"') {
        unquote(rest)
    } else {
        let bare = rest.split("//").next().unwrap_or("").trim();
        (!bare.is_empty()).then(|| bare.to_string())
    };
    (kind, title.filter(|t| !t.is_empty()))
}

/// Every diagram in the folder, newest first. Only the first line of each file is read.
pub fn list_diagrams(data_dir: &Path) -> Result<Vec<DiagramEntry>> {
    let dir = diagrams_dir(data_dir);
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(file_err(&dir, "read", e)),
    };
    let mut out = Vec::new();
    for entry in entries {
        // One entry that cannot be read is skipped, like an unreadable file.
        let Ok(entry) = entry else {
            continue;
        };
        let Some(file) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Some(name) = file.strip_suffix(".flow") else {
            continue;
        };
        if flow_file_name(name).ok().as_deref() != Some(file.as_str()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
        let (kind, title) = match std::fs::File::open(entry.path()) {
            Ok(f) => diagram_head(f),
            Err(_) => (DiagramKind::Unknown, None),
        };
        out.push(DiagramEntry {
            name: name.to_string(),
            kind,
            title: title.unwrap_or_else(|| name.to_string()),
            modified_ms,
        });
    }
    out.sort_by(|a, b| {
        b.modified_ms
            .cmp(&a.modified_ms)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

/// Reads at most `READ_MAX` bytes of `path` as text; `None` when it has more.
fn read_capped(path: &Path) -> std::io::Result<Option<String>> {
    let mut text = String::new();
    std::fs::File::open(path)?
        .take(READ_MAX + 1)
        .read_to_string(&mut text)?;
    Ok((text.len() as u64 <= READ_MAX).then_some(text))
}

fn too_large(file: &str) -> Error {
    Error::InvalidInput(format!(
        "{file} is over 5 MB, too large to open as a diagram."
    ))
}

/// Both files of diagram `name`; either one over `READ_MAX` is refused.
pub fn read_diagram(data_dir: &Path, name: &str) -> Result<DiagramFiles> {
    let (path, base) = flow_path(data_dir, name)?;
    let text = match read_capped(&path) {
        Ok(Some(text)) => text,
        Ok(None) => return Err(too_large(&format!("{base}.flow"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(not_found(&base)),
        Err(e) => return Err(file_err(&path, "read", e)),
    };
    let lp = layout_path(&path);
    let layout = match read_capped(&lp) {
        Ok(Some(text)) => Some(text),
        Ok(None) => return Err(too_large(&format!("{base}.flow.layout.json"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(file_err(&lp, "read", e)),
    };
    Ok(DiagramFiles { text, layout })
}

/// Saves both files through the step 7 `write_flow_files` (the safe re-save). Without
/// `overwrite`, a name that is taken returns `DiagramExists` and nothing is written.
pub fn write_diagram(
    data_dir: &Path,
    name: &str,
    text: &str,
    layout: &str,
    overwrite: bool,
) -> Result<()> {
    let (_, base) = flow_path(data_dir, name)?;
    if !overwrite && flow_exists(name, data_dir)? {
        return Err(Error::DiagramExists { name: base });
    }
    write_flow_files(name, text, layout, data_dir).map(|_| ())
}

/// Saves only the layout file of diagram `name` (P24 I1): moves, Classic and the direction never
/// touch the `.flow`, so an edit made outside Contura while the tab is open survives them. It goes
/// through the same `PathUse::Flow` guard as `write_diagram`, and refuses when the `.flow` is not
/// there, so a diagram deleted outside Contura is never brought back by a layout save.
pub fn write_diagram_layout(data_dir: &Path, name: &str, layout: &str) -> Result<()> {
    let (path, base) = flow_path(data_dir, name)?;
    if !exists(&path)? {
        return Err(not_found(&base));
    }
    let lp = layout_path(&path);
    let mut w = PartialFile::create(&lp, true, PathUse::Flow, data_dir)?.writer();
    w.write_all(layout.as_bytes())
        .map_err(|e| file_err(&lp, "write", e))?;
    w.commit().map(|_| ())
}

/// Moves both files to the Recycle Bin. It blocks while the shell works, so the app calls
/// it off the main thread.
pub fn delete_diagram(data_dir: &Path, name: &str) -> Result<()> {
    delete_diagram_with(data_dir, name, |files: &[PathBuf]| {
        trash::delete_all(files).map_err(|e| {
            Error::File(format!(
                "cannot move {} to the Recycle Bin: {e}",
                files[0].display()
            ))
        })
    })
}

/// `delete_diagram` with the Recycle Bin call passed in, so tests never touch the user's
/// own Recycle Bin (P3). `recycle` gets the `.flow` path, then the layout path when it
/// exists; it is not called for a bad name or a diagram that is not there.
pub fn delete_diagram_with(
    data_dir: &Path,
    name: &str,
    recycle: impl FnOnce(&[PathBuf]) -> Result<()>,
) -> Result<()> {
    let (path, base) = flow_path(data_dir, name)?;
    if !exists(&path)? {
        return Err(not_found(&base));
    }
    let lp = layout_path(&path);
    let mut files = vec![path];
    if exists(&lp)? {
        files.push(lp);
    }
    recycle(&files)
}

/// Renames both files. A name that is taken, by its `.flow` or by a layout file left
/// without one, returns `DiagramExists`; a name that differs only in case renames the
/// same files.
pub fn rename_diagram(data_dir: &Path, from: &str, to: &str) -> Result<()> {
    let (from_path, from_base) = flow_path(data_dir, from)?;
    let (to_path, to_base) = flow_path(data_dir, to)?;
    if !exists(&from_path)? {
        return Err(not_found(&from_base));
    }
    if from_base == to_base {
        return Ok(());
    }
    let (from_layout, to_layout) = (layout_path(&from_path), layout_path(&to_path));
    let taken = |from: &Path, to: &Path| -> Result<bool> {
        Ok(exists(to)? && !same_file::is_same_file(from, to).unwrap_or(false))
    };
    if taken(&from_path, &to_path)? || taken(&from_layout, &to_layout)? {
        return Err(Error::DiagramExists { name: to_base });
    }
    let has_layout = exists(&from_layout)?;
    std::fs::rename(&from_path, &to_path).map_err(|e| file_err(&from_path, "rename", e))?;
    if has_layout && let Err(e) = std::fs::rename(&from_layout, &to_layout) {
        let _ = std::fs::rename(&to_path, &from_path);
        return Err(file_err(&from_layout, "rename", e));
    }
    Ok(())
}

/// "Save a copy as...": `target` and `<target>.layout.json`, wherever the user chose
/// outside Contura's data folder (`PathUse::Export`).
pub fn save_diagram_copy(text: &str, layout: &str, target: &Path, data_dir: &Path) -> Result<()> {
    let lp = layout_path(target);
    check_user_path(target, data_dir, PathUse::Export)?;
    check_user_path(&lp, data_dir, PathUse::Export)?;
    write_atomic(target, text.as_bytes())?;
    write_atomic(&lp, layout.as_bytes())
}
