//! The user path guard: files a job reads or writes stay outside Contura's data folder,
//! and an export is written beside its target and renamed over it only when complete.

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use sha2::{Digest, Sha256};

use crate::error::{Error, Result};

/// Why a path is used, which picks the refusal text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathUse {
    Export,
    Import,
    Backup,
    SchemaModel,
    Flow,
    /// Opening a file the user chose, such as a Schema Model.
    Open,
    /// A SQLite database file for a Connection.
    Database,
}

/// `path` with its deepest existing ancestor resolved (links, `..`) and the rest
/// appended, with any `..` in the rest applied, so nothing slips into the data folder.
fn resolved(path: &Path) -> Option<PathBuf> {
    let mut rest: Vec<Component> = Vec::new();
    let mut at = path;
    loop {
        if let Ok(base) = at.canonicalize() {
            let mut out = base;
            for c in rest.iter().rev() {
                match c {
                    Component::ParentDir => {
                        out.pop();
                    }
                    Component::CurDir => {}
                    other => out.push(other.as_os_str()),
                }
            }
            return Some(out);
        }
        rest.push(at.components().next_back()?);
        at = at.parent()?;
    }
}

/// The folder inside Contura's data folder that holds every `.flow` file (Q35).
pub const DIAGRAMS_DIR: &str = "diagrams";

const FLOW_REFUSAL: &str = "Diagrams are kept in Contura's diagrams folder.";

/// Names Windows keeps for devices, with or without an extension.
fn reserved_on_windows(stem: &str) -> bool {
    let upper = stem.trim_end_matches([' ', '.']).to_ascii_uppercase();
    match upper.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" => true,
        _ => {
            let mut chars = upper.chars();
            let head: String = chars.by_ref().take(3).collect();
            let rest: Vec<char> = chars.collect();
            (head == "COM" || head == "LPT")
                && rest.len() == 1
                && matches!(rest[0], '0'..='9' | '\u{b9}' | '\u{b2}' | '\u{b3}')
        }
    }
}

/// The one refusal for a diagram name the rule does not allow (step 6+ spec, P1).
pub const DIAGRAM_NAME_REFUSAL: &str =
    r#"Use a name without \ / : * ? " < > | and under 120 characters."#;

/// The longest diagram name, in characters, without the `.flow` extension.
pub const DIAGRAM_NAME_MAX: usize = 120;

/// The longest diagram name in UTF-8 bytes, so `<name>.flow.layout.json` and its partial
/// and moved-aside spellings stay inside a file name's 255 UTF-16 units (P4).
pub const DIAGRAM_NAME_MAX_BYTES: usize = 200;

/// The file name of diagram `name` in the diagrams folder: `<name>.flow`. The Core adds
/// the extension. An empty name, one over 120 characters or 200 UTF-8 bytes, one ending in
/// `.flow` (any case), one with a path separator, `..`, a character Windows does not allow
/// in a file name, or a reserved Windows name is refused with `DIAGRAM_NAME_REFUSAL`
/// (Q35, P1, P4).
pub fn flow_file_name(name: &str) -> Result<String> {
    let bad_char = |c: char| c.is_control() || r#"\/:*?"<>|"#.contains(c);
    let has_flow_extension = name.len() >= 5
        && name.is_char_boundary(name.len() - 5)
        && name[name.len() - 5..].eq_ignore_ascii_case(".flow");
    let stem = name.split('.').next().unwrap_or(name);
    if name.trim().is_empty()
        || name.chars().count() > DIAGRAM_NAME_MAX
        || name.len() > DIAGRAM_NAME_MAX_BYTES
        || has_flow_extension
        || name.contains("..")
        || name.chars().any(bad_char)
        || reserved_on_windows(stem)
    {
        return Err(Error::InvalidInput(DIAGRAM_NAME_REFUSAL.into()));
    }
    Ok(format!("{name}.flow"))
}

/// The folder inside `<data>\diagrams` that holds lineage's moved-card layouts (spec 6+
/// section 5): one `<hash>.layout.json` per Connection and table.
pub const LINEAGE_DIR: &str = ".lineage";

/// The hex digits of a lineage layout file's name, before `.layout.json`.
pub const LINEAGE_HASH_LEN: usize = 32;

/// A lineage layout file name: 32 lower-case hex digits and `.layout.json`, nothing else.
pub fn is_lineage_layout_name(name: &str) -> bool {
    name.strip_suffix(".layout.json").is_some_and(|stem| {
        stem.len() == LINEAGE_HASH_LEN
            && stem
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// A lineage layout file directly in `<data>\diagrams\.lineage`, which must be a real
/// folder (not a link or junction) inside the diagrams folder, compared by file identity.
fn check_lineage_layout_path(parent: &Path, name: &str, data_dir: &Path) -> Result<()> {
    let refuse = || Error::InvalidInput(FLOW_REFUSAL.into());
    if !is_lineage_layout_name(name) || parent.file_name() != Some(LINEAGE_DIR.as_ref()) {
        return Err(refuse());
    }
    let Some(grand) = parent.parent() else {
        return Err(refuse());
    };
    let real_dir = std::fs::symlink_metadata(parent)
        .is_ok_and(|m| m.file_type().is_dir() && !m.file_type().is_symlink());
    if !real_dir {
        return Err(refuse());
    }
    let Ok(diagrams) = same_file::Handle::from_path(data_dir.join(DIAGRAMS_DIR)) else {
        return Err(refuse());
    };
    match same_file::Handle::from_path(grand) {
        Ok(h) if h == diagrams => Ok(()),
        _ => Err(refuse()),
    }
}

/// Q35: a `.flow` file or its layout file directly in `<data>\diagrams`, with a name
/// `flow_file_name` accepts, or a lineage layout file in its `.lineage` folder. The folder
/// is compared by file identity, like the data folder.
fn check_flow_path(path: &Path, data_dir: &Path) -> Result<()> {
    let refuse = || Error::InvalidInput(FLOW_REFUSAL.into());
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(refuse());
    };
    let name = name.to_str().ok_or_else(refuse)?;
    if parent.file_name() == Some(LINEAGE_DIR.as_ref()) {
        return check_lineage_layout_path(parent, name, data_dir);
    }
    let flow = name.strip_suffix(".layout.json").unwrap_or(name);
    let Some(base) = flow.strip_suffix(".flow") else {
        return Err(refuse());
    };
    if flow_file_name(base).ok().as_deref() != Some(flow) {
        return Err(refuse());
    }
    let Ok(diagrams) = same_file::Handle::from_path(data_dir.join(DIAGRAMS_DIR)) else {
        return Err(refuse());
    };
    match same_file::Handle::from_path(parent) {
        Ok(h) if h == diagrams => Ok(()),
        _ => Err(refuse()),
    }
}

fn refusal(what: PathUse) -> Error {
    let text = match what {
        PathUse::Export => "Save exports outside Contura's data folder.",
        PathUse::Import => "Choose an import file outside Contura's data folder.",
        PathUse::Backup => "Save backups outside Contura's data folder.",
        PathUse::SchemaModel => "Save Schema Models outside Contura's data folder.",
        PathUse::Flow => FLOW_REFUSAL,
        PathUse::Open => "Choose a file outside Contura's data folder.",
        PathUse::Database => "Choose a SQLite file outside Contura's data folder.",
    };
    Error::InvalidInput(text.into())
}

/// Refuses any path inside Contura's data folder: that folder belongs to the app (ADR 0006).
///
/// It compares file identities, not path text (Q24): every existing folder on the path,
/// resolved, is checked against the data folder's volume and file index (device and inode
/// elsewhere), so a UNC share, a junction, a subst drive or another spelling of the same
/// folder is caught. A relative path is refused, and so is any path when the data folder
/// itself cannot be opened: the guard fails closed.
pub fn check_user_path(path: &Path, data_dir: &Path, what: PathUse) -> Result<()> {
    if !path.is_absolute() {
        return Err(Error::InvalidInput(format!(
            "Choose a full path for the file, not {}.",
            path.display()
        )));
    }
    if what == PathUse::Flow {
        return check_flow_path(path, data_dir);
    }
    let Ok(data) = same_file::Handle::from_path(data_dir) else {
        return Err(refusal(what));
    };
    let Some(full) = resolved(path) else {
        return Err(refusal(what));
    };
    // `resolved` keeps every existing folder of the path, so the nearest existing ancestor
    // chain is all here; folders that do not exist yet cannot be the data folder. One that
    // exists but cannot be opened cannot be compared, so it refuses (fails closed).
    for folder in full.ancestors() {
        match same_file::Handle::from_path(folder) {
            Ok(h) if h == data => return Err(refusal(what)),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(file_err(folder, "check", e)),
        }
    }
    Ok(())
}

fn file_err(path: &Path, what: &str, e: std::io::Error) -> Error {
    Error::File(format!("cannot {what} {}: {e}", path.display()))
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// One partial file this process is writing: its resolved path and its file identity.
struct Live {
    key: PathBuf,
    handle: same_file::Handle,
}

/// The partial files this process is writing. A `.partial` on disk that matches none of
/// them, by path or by file identity, was left by a crash or a kill, so `create` removes
/// it (Q24). One that matches is busy and is never removed, whatever its spelling (Q33).
static LIVE: Mutex<Vec<Live>> = Mutex::new(Vec::new());

fn live() -> MutexGuard<'static, Vec<Live>> {
    // A panic while the lock was held leaves the list itself intact.
    LIVE.lock().unwrap_or_else(|p| p.into_inner())
}

/// Removes an uncommitted partial: closes it first, since Windows refuses to delete an
/// open file, then deletes it and frees its name, all under the lock.
fn discard(partial: &Path, key: &Path, file: Option<impl Sized>) {
    let mut live = live();
    live.retain(|l| l.key != key);
    drop(file);
    let _ = std::fs::remove_file(partial);
}

/// An export's temporary file, `<name>.partial` beside the target. `writer` hands it to a
/// movable `PartialWriter`, which renames it over the target on `commit`. Dropped first
/// (cancel, failure), either one deletes the partial.
pub struct PartialFile {
    target: PathBuf,
    partial: PathBuf,
    /// The partial's resolved path, its name in `LIVE`.
    key: PathBuf,
    overwrite: bool,
    /// Some until `writer` hands it over.
    file: Option<File>,
}

impl PartialFile {
    /// Runs the data-folder guard for `what` first, so no write can skip it (Q33). Refuses
    /// an existing target unless `overwrite` (`FileExists`), and a partial that another
    /// export in this process is still writing. A stale partial is replaced.
    pub fn create(
        target: &Path,
        overwrite: bool,
        what: PathUse,
        data_dir: &Path,
    ) -> Result<PartialFile> {
        check_user_path(target, data_dir, what)?;
        if !overwrite && target.exists() {
            return Err(Error::FileExists(target.to_path_buf()));
        }
        let mut partial = target.as_os_str().to_owned();
        partial.push(".partial");
        let partial = PathBuf::from(partial);
        // The guard passed, so the path is absolute and resolves; never key by raw text.
        let key = resolved(&partial).ok_or_else(|| {
            Error::File(format!(
                "cannot write {}: its folder cannot be found",
                target.display()
            ))
        })?;
        let busy = || {
            Error::InvalidInput(format!(
                "Another export is writing to {}.",
                file_name(target)
            ))
        };
        let mut live = live();
        if live.iter().any(|l| l.key == key) {
            return Err(busy());
        }
        match same_file::Handle::from_path(&partial) {
            Ok(existing) => {
                if live.iter().any(|l| l.handle == existing) {
                    return Err(busy());
                }
                drop(existing);
                std::fs::remove_file(&partial)
                    .map_err(|e| file_err(&partial, "remove the stale file", e))?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            // It exists but cannot be identified: it may be live, so it is never removed.
            Err(_) => return Err(busy()),
        }
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    // Another process made it between the removal and the open.
                    busy()
                } else {
                    file_err(target, "write", e)
                }
            })?;
        let handle = file
            .try_clone()
            .and_then(same_file::Handle::from_file)
            .map_err(|e| {
                let _ = std::fs::remove_file(&partial);
                file_err(target, "write", e)
            })?;
        live.push(Live {
            key: key.clone(),
            handle,
        });
        Ok(PartialFile {
            target: target.to_path_buf(),
            partial,
            key,
            overwrite,
            file: Some(file),
        })
    }

    pub fn target(&self) -> &Path {
        &self.target
    }

    pub fn partial_path(&self) -> &Path {
        &self.partial
    }

    /// The owner of the file from here on, with a 64 KB buffer. It is `Send`, so it can
    /// move into `spawn_blocking`.
    pub fn writer(mut self) -> PartialWriter {
        let file = self.file.take();
        PartialWriter {
            target: std::mem::take(&mut self.target),
            // Taken, so this value's Drop finds nothing to delete.
            partial: std::mem::take(&mut self.partial),
            key: std::mem::take(&mut self.key),
            overwrite: self.overwrite,
            writer: file.map(|f| BufWriter::with_capacity(64 * 1024, f)),
        }
    }
}

impl Drop for PartialFile {
    fn drop(&mut self) {
        if !self.partial.as_os_str().is_empty() {
            discard(&self.partial, &self.key, self.file.take());
        }
    }
}

/// Writes an export's partial file. `commit` renames it over the target; `abort`, or a
/// drop without `commit`, deletes it.
pub struct PartialWriter {
    target: PathBuf,
    partial: PathBuf,
    key: PathBuf,
    overwrite: bool,
    /// Some until `commit` or `abort` takes it.
    writer: Option<BufWriter<File>>,
}

fn closed_err(target: &Path) -> std::io::Error {
    std::io::Error::other(format!("{} is already closed", target.display()))
}

impl PartialWriter {
    pub fn target(&self) -> &Path {
        &self.target
    }

    pub fn partial_path(&self) -> &Path {
        &self.partial
    }

    /// The buffered file, for a writer that needs `Write + Seek` (the Excel writer).
    pub fn get_mut(&mut self) -> std::io::Result<&mut BufWriter<File>> {
        let target = &self.target;
        self.writer.as_mut().ok_or_else(|| closed_err(target))
    }

    /// Flushes, syncs and renames the partial over the target; returns the file's size.
    /// On failure the partial is removed and the old target is left as it was. Without
    /// `overwrite`, a target that appeared meanwhile is refused with `FileExists`.
    pub fn commit(mut self) -> Result<u64> {
        let target = self.target.clone();
        let finished = (|| {
            let writer = self
                .writer
                .take()
                .ok_or_else(|| file_err(&target, "write", closed_err(&target)))?;
            let file = writer
                .into_inner()
                .map_err(|e| file_err(&target, "write", e.into_error()))?;
            file.sync_all().map_err(|e| file_err(&target, "write", e))?;
            let bytes = file
                .metadata()
                .map_err(|e| file_err(&target, "write", e))?
                .len();
            drop(file);
            if !self.overwrite && target.exists() {
                return Err(Error::FileExists(target.clone()));
            }
            // Leaves the live list and renames under one lock, so no other create sees
            // the partial unlisted while it still exists.
            let mut live = live();
            live.retain(|l| l.key != self.key);
            std::fs::rename(&self.partial, &target).map_err(|e| file_err(&target, "replace", e))?;
            Ok(bytes)
        })();
        if finished.is_ok() {
            // Renamed: nothing is left for Drop to delete.
            self.partial = PathBuf::new();
        }
        finished
    }

    /// Closes and deletes the partial; the target is left as it was.
    pub fn abort(self) {
        drop(self);
    }
}

impl Write for PartialWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.get_mut()?.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.get_mut()?.flush()
    }
}

impl Seek for PartialWriter {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.get_mut()?.seek(pos)
    }
}

impl Drop for PartialWriter {
    fn drop(&mut self) {
        if !self.partial.as_os_str().is_empty() {
            discard(&self.partial, &self.key, self.writer.take());
        }
    }
}

/// Hashes what passes through it, so a file is read once for both its rows and its SHA-256.
pub struct HashingReader<R: Read> {
    inner: R,
    hasher: Sha256,
    bytes: u64,
}

impl<R: Read> HashingReader<R> {
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
            bytes: 0,
        }
    }

    /// The bytes read so far. Call it as `HashingReader::bytes(&r)`: written `r.bytes()`,
    /// method lookup picks `Read::bytes` first, which takes the reader by value.
    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    /// The SHA-256 of what has been read so far; reading may go on.
    pub fn digest(&self) -> [u8; 32] {
        self.hasher.clone().finalize().into()
    }

    pub fn get_ref(&self) -> &R {
        &self.inner
    }

    pub fn finish(self) -> [u8; 32] {
        self.hasher.finalize().into()
    }
}

impl<R: Read> Read for HashingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.hasher.update(&buf[..n]);
        self.bytes += n as u64;
        Ok(n)
    }
}

/// Streams the file through SHA-256 in 64 KB reads; `cancel` stops it with `Cancelled`.
pub fn file_sha256(path: &Path, cancel: &AtomicBool) -> Result<[u8; 32]> {
    let file = File::open(path).map_err(|e| file_err(path, "read", e))?;
    let mut reader = HashingReader::new(file);
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        let n = reader
            .read(&mut buf)
            .map_err(|e| file_err(path, "read", e))?;
        if n == 0 {
            return Ok(reader.finish());
        }
    }
}

/// Lowercase hex.
pub fn hex(h: &[u8; 32]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(64);
    for b in h {
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn size_text(bytes: u64) -> String {
    const MIB: u64 = 1024 * 1024;
    if bytes >= MIB && bytes.is_multiple_of(MIB) {
        format!("{} MB", bytes / MIB)
    } else if bytes >= 1024 && bytes.is_multiple_of(1024) {
        format!("{} KB", bytes / 1024)
    } else {
        format!("{bytes} bytes")
    }
}

/// Reads a small UTF-8 text file the user chose (a leading BOM is dropped).
pub fn read_user_text(path: &Path, max_bytes: u64) -> Result<String> {
    let file = File::open(path).map_err(|e| file_err(path, "read", e))?;
    let len = file
        .metadata()
        .map_err(|e| file_err(path, "read", e))?
        .len();
    if len > max_bytes {
        return Err(Error::InvalidInput(format!(
            "This file is larger than {}.",
            size_text(max_bytes)
        )));
    }
    let mut bytes = Vec::with_capacity(len as usize);
    // One more byte than allowed, in case the file grew since its size was read.
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| file_err(path, "read", e))?;
    if bytes.len() as u64 > max_bytes {
        return Err(Error::InvalidInput(format!(
            "This file is larger than {}.",
            size_text(max_bytes)
        )));
    }
    let text = String::from_utf8(bytes).map_err(|_| {
        Error::File(format!(
            "cannot read {}: the file is not UTF-8 text",
            path.display()
        ))
    })?;
    Ok(match text.strip_prefix('\u{feff}') {
        Some(rest) => rest.to_string(),
        None => text,
    })
}

/// Opens a file the user chose for a whole import job, with other writers refused while
/// it is open: on Windows by its share mode (read sharing only, so no writer and no
/// rename or delete), elsewhere by an advisory shared lock (Q44, Q45).
pub fn open_locked(path: &Path) -> Result<File> {
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 1;
        OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(path)
    };
    #[cfg(not(windows))]
    let file = File::open(path).and_then(|f| match f.try_lock_shared() {
        Ok(()) => Ok(f),
        Err(std::fs::TryLockError::WouldBlock) => Err(std::io::ErrorKind::ResourceBusy.into()),
        Err(std::fs::TryLockError::Error(e)) => Err(e),
    });
    file.map_err(|e| {
        #[cfg(windows)]
        // ERROR_SHARING_VIOLATION: another program has it open for writing.
        let busy = e.raw_os_error() == Some(32);
        #[cfg(not(windows))]
        let busy = e.kind() == std::io::ErrorKind::ResourceBusy;
        if busy {
            Error::File(format!(
                "{} is in use by another program. Close it there, then import again.",
                file_name(path)
            ))
        } else {
            file_err(path, "read", e)
        }
    })
}

/// An import's file, opened once with `open_locked` and held until the job ends: the
/// handle closes when the last clone and the last reader are dropped. Its size is read
/// from the handle when it opens, and every reader of the job reads the handle at its
/// own offset up to that size, so the bytes checked are the bytes that run (Q45).
#[derive(Clone)]
pub struct HeldFile {
    file: Arc<File>,
    bytes: u64,
    path: PathBuf,
}

impl HeldFile {
    pub fn open(path: &Path) -> Result<HeldFile> {
        let file = open_locked(path)?;
        let bytes = file
            .metadata()
            .map_err(|e| file_err(path, "read", e))?
            .len();
        Ok(HeldFile {
            file: Arc::new(file),
            bytes,
            path: path.to_path_buf(),
        })
    }

    /// The size the handle had when it opened.
    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// A reader of the held file from its start, up to `bytes()`, with an offset of its
    /// own.
    pub fn reader(&self) -> AtReader {
        AtReader {
            file: self.file.clone(),
            pos: 0,
            end: self.bytes,
        }
    }

    /// The SHA-256 of the held bytes, read through the handle; `cancel` stops it.
    pub fn sha256(&self, cancel: &AtomicBool) -> Result<[u8; 32]> {
        let mut reader = HashingReader::new(self.reader());
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(Error::Cancelled);
            }
            let n = reader
                .read(&mut buf)
                .map_err(|e| file_err(&self.path, "read", e))?;
            if n == 0 {
                return Ok(reader.finish());
            }
        }
    }
}

/// Reads a shared handle at its own offset (positional reads), so several readers of one
/// held file never move each other, and stops at `end`.
pub struct AtReader {
    file: Arc<File>,
    pos: u64,
    end: u64,
}

impl Read for AtReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let left = self.end.saturating_sub(self.pos);
        let want = buf.len().min(usize::try_from(left).unwrap_or(usize::MAX));
        if want == 0 {
            return Ok(0);
        }
        #[cfg(windows)]
        let n = std::os::windows::fs::FileExt::seek_read(&*self.file, &mut buf[..want], self.pos)?;
        #[cfg(unix)]
        let n = std::os::unix::fs::FileExt::read_at(&*self.file, &mut buf[..want], self.pos)?;
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for AtReader {
    fn seek(&mut self, to: SeekFrom) -> std::io::Result<u64> {
        let at = match to {
            SeekFrom::Start(n) => Some(n),
            SeekFrom::End(d) => self.end.checked_add_signed(d),
            SeekFrom::Current(d) => self.pos.checked_add_signed(d),
        };
        let at = at.ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "a seek before the start of the file",
            )
        })?;
        self.pos = at;
        Ok(at)
    }
}

/// A data folder no test writes into, so the guard inside `PartialFile::create` lets
/// test targets through.
#[cfg(test)]
pub(crate) fn outside_data() -> PathBuf {
    let d = std::env::temp_dir().join("contura-paths-test-data");
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create(target: &Path, overwrite: bool) -> Result<PartialFile> {
        PartialFile::create(target, overwrite, PathUse::Export, &outside_data())
    }

    #[test]
    fn create_runs_the_guard_itself() {
        let data = tempfile::tempdir().unwrap();
        let inside = data.path().join("orders.csv");
        assert!(matches!(
            PartialFile::create(&inside, false, PathUse::Export, data.path()),
            Err(Error::InvalidInput(m)) if m == "Save exports outside Contura's data folder."
        ));
        assert!(!data.path().join("orders.csv.partial").exists());
        // A relative target never reaches the live list.
        assert!(
            PartialFile::create(Path::new("orders.csv"), false, PathUse::Export, data.path())
                .is_err()
        );
        assert!(!Path::new("orders.csv.partial").exists());
    }

    /// A file this process cannot open (here: locked by another handle with no sharing)
    /// cannot be compared with the data folder, so the guard refuses.
    #[cfg(windows)]
    #[test]
    fn an_ancestor_that_cannot_be_opened_refuses() {
        use std::os::windows::fs::OpenOptionsExt;
        let data = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let locked = out.path().join("locked.csv");
        std::fs::write(&locked, b"x").unwrap();
        let _hold = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&locked)
            .unwrap();
        assert!(check_user_path(&locked, data.path(), PathUse::Import).is_err());
        // Folders that do not exist yet are skipped, not refused.
        assert!(
            check_user_path(
                &out.path().join("new").join("x.csv"),
                data.path(),
                PathUse::Export
            )
            .is_ok()
        );
    }

    /// The same partial reached by another spelling (`\\localhost\C$`) is busy, and the live
    /// export's file is never removed. Skipped when the admin share is not reachable.
    #[cfg(windows)]
    #[test]
    fn a_live_partial_under_another_spelling_is_busy() {
        let dir = tempfile::tempdir().unwrap();
        let canon = dir.path().canonicalize().unwrap();
        let text = canon.to_string_lossy();
        let plain = text.strip_prefix(r"\\?\").unwrap_or(&text).to_string();
        let mut chars = plain.chars();
        let (Some(drive), Some(':')) = (chars.next(), chars.next()) else {
            eprintln!("skipped: {plain} has no drive letter");
            return;
        };
        let unc = PathBuf::from(format!(r"\\localhost\{drive}${}", &plain[2..]));
        if !unc.exists() {
            eprintln!("skipped: {} is not reachable", unc.display());
            return;
        }
        let mut first = create(&dir.path().join("o.csv"), false).unwrap().writer();
        first.write_all(b"first export").unwrap();
        first.flush().unwrap();
        assert!(matches!(
            create(&unc.join("o.csv"), false),
            Err(Error::InvalidInput(m)) if m == "Another export is writing to o.csv."
        ));
        assert!(first.partial_path().exists());
        assert_eq!(first.commit().unwrap(), 12);
        assert_eq!(
            std::fs::read(dir.path().join("o.csv")).unwrap(),
            b"first export"
        );
    }

    const MIB: u64 = 1024 * 1024;

    #[test]
    fn refuses_inside_data_dir_for_each_use() {
        let data = tempfile::tempdir().unwrap();
        let inside = data.path().join("orders.csv");
        let msg = |what| match check_user_path(&inside, data.path(), what) {
            Err(Error::InvalidInput(m)) => m,
            other => panic!("expected a refusal, got {other:?}"),
        };
        assert_eq!(
            msg(PathUse::Export),
            "Save exports outside Contura's data folder."
        );
        assert_eq!(
            msg(PathUse::Import),
            "Choose an import file outside Contura's data folder."
        );
        assert_eq!(
            msg(PathUse::Backup),
            "Save backups outside Contura's data folder."
        );
        assert_eq!(
            msg(PathUse::SchemaModel),
            "Save Schema Models outside Contura's data folder."
        );
        assert_eq!(
            msg(PathUse::Flow),
            "Diagrams are kept in Contura's diagrams folder."
        );
        // A folder inside that does not exist yet is still inside.
        let deep = data.path().join("new").join("deeper").join("x.csv");
        assert!(check_user_path(&deep, data.path(), PathUse::Export).is_err());

        let other = tempfile::tempdir().unwrap();
        assert!(check_user_path(&other.path().join("x.csv"), data.path(), PathUse::Export).is_ok());
    }

    const FLOW_REFUSAL: &str = "Diagrams are kept in Contura's diagrams folder.";

    fn flow_refusal(path: &Path, data: &Path) -> String {
        match check_user_path(path, data, PathUse::Flow) {
            Err(Error::InvalidInput(m)) => m,
            other => panic!("expected a refusal for {}, got {other:?}", path.display()),
        }
    }

    #[test]
    fn flow_allows_only_the_diagrams_folder() {
        let data = tempfile::tempdir().unwrap();
        let diagrams = data.path().join(DIAGRAMS_DIR);
        std::fs::create_dir_all(diagrams.join("sub")).unwrap();
        check_user_path(&diagrams.join("orders.flow"), data.path(), PathUse::Flow).unwrap();
        check_user_path(
            &diagrams.join("orders.flow.layout.json"),
            data.path(),
            PathUse::Flow,
        )
        .unwrap();
        // Another spelling of the same folder.
        let around = diagrams.join("sub").join("..").join("orders.flow");
        check_user_path(&around, data.path(), PathUse::Flow).unwrap();
        // Any other folder, inside the data folder or not, is refused.
        let other = tempfile::tempdir().unwrap();
        for p in [
            other.path().join("orders.flow"),
            data.path().join("orders.flow"),
            diagrams.join("sub").join("orders.flow"),
            diagrams.join(".."),
            diagrams.join("orders.txt"),
            diagrams.join("CON.flow"),
        ] {
            assert_eq!(
                flow_refusal(&p, data.path()),
                FLOW_REFUSAL,
                "{}",
                p.display()
            );
        }
        // Every other use still refuses the diagrams folder, as part of the data folder.
        for what in [
            PathUse::Export,
            PathUse::Import,
            PathUse::Backup,
            PathUse::SchemaModel,
            PathUse::Open,
            PathUse::Database,
        ] {
            assert!(
                check_user_path(&diagrams.join("orders.flow"), data.path(), what).is_err(),
                "{what:?}"
            );
        }
    }

    #[test]
    fn flow_without_a_diagrams_folder_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let p = data.path().join(DIAGRAMS_DIR).join("orders.flow");
        assert_eq!(flow_refusal(&p, data.path()), FLOW_REFUSAL);
    }

    #[test]
    fn flow_names_are_checked() {
        assert_eq!(flow_file_name("orders").unwrap(), "orders.flow");
        assert_eq!(
            flow_file_name("Order handover").unwrap(),
            "Order handover.flow"
        );
        // The Core adds the extension; a name that has one already is refused (P4).
        assert_eq!(flow_file_name("orders.flows").unwrap(), "orders.flows.flow");
        for bad in [
            "",
            "  ",
            ".flow",
            "a/b",
            r"a\b",
            "..",
            "a..b",
            "../x",
            "c:x",
            "a*b",
            "a?b",
            "a|b",
            "a<b",
            "a>b",
            "a\"b",
            "a\u{1}b",
            "orders.flow",
            "orders.FLOW",
            "a.flow.flow",
        ] {
            match flow_file_name(bad) {
                Err(Error::InvalidInput(m)) => assert_eq!(m, DIAGRAM_NAME_REFUSAL, "{bad:?}"),
                other => panic!("{bad:?}: {other:?}"),
            }
        }
        // At most 120 characters and at most 200 bytes of UTF-8.
        let at_most = "a".repeat(DIAGRAM_NAME_MAX);
        assert!(flow_file_name(&at_most).is_ok());
        assert!(flow_file_name(&format!("{at_most}a")).is_err());
        let wide = "\u{e9}".repeat(100);
        assert!(flow_file_name(&wide).is_ok());
        assert!(flow_file_name(&format!("{wide}\u{e9}")).is_err());
        for reserved in [
            "CON", "con", "Nul", "aux.x", "PRN", "COM0", "COM1", "lpt0", "lpt9", "com1.x", "NUL ",
        ] {
            match flow_file_name(reserved) {
                Err(Error::InvalidInput(m)) => assert_eq!(m, DIAGRAM_NAME_REFUSAL, "{reserved}"),
                other => panic!("{reserved}: {other:?}"),
            }
        }
        // Names that only start like a reserved one are fine.
        assert_eq!(flow_file_name("console").unwrap(), "console.flow");
        assert_eq!(flow_file_name("COM10").unwrap(), "COM10.flow");
    }

    #[test]
    fn parent_dot_dot_resolved() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let out = root.path().join("out");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        // out/../data/x.csv is inside the data folder.
        let sneaky = out.join("..").join("data").join("x.csv");
        assert!(check_user_path(&sneaky, &data, PathUse::Export).is_err());
        // Through a folder that does not exist: out/missing/../../data/x.csv.
        let sneaky = out
            .join("missing")
            .join("..")
            .join("..")
            .join("data")
            .join("x.csv");
        assert!(check_user_path(&sneaky, &data, PathUse::Export).is_err());
        // data/../out/x.csv is outside.
        let fine = data.join("..").join("out").join("x.csv");
        assert!(check_user_path(&fine, &data, PathUse::Export).is_ok());
    }

    #[test]
    fn existing_target_refused_without_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("orders.csv");
        std::fs::write(&target, b"old").unwrap();
        match create(&target, false) {
            Err(Error::FileExists(p)) => assert_eq!(p, target),
            Err(e) => panic!("expected FileExists, got {e:?}"),
            Ok(_) => panic!("expected FileExists"),
        }
        assert!(!dir.path().join("orders.csv.partial").exists());
        let mut w = create(&target, true).unwrap().writer();
        w.write_all(b"new").unwrap();
        assert_eq!(w.commit().unwrap(), 3);
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
    }

    #[test]
    fn commit_renames_partial() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("orders.csv");
        let f = create(&target, false).unwrap();
        assert_eq!(f.partial_path(), dir.path().join("orders.csv.partial"));
        assert_eq!(f.target(), target);
        let mut w = f.writer();
        // The writer moves to another thread, as it does into `spawn_blocking`.
        let w = std::thread::spawn(move || {
            w.write_all(b"id,name\r\n1,a\r\n").unwrap();
            w
        })
        .join()
        .unwrap();
        assert!(w.partial_path().exists());
        assert!(!target.exists());
        assert_eq!(w.commit().unwrap(), 14);
        assert_eq!(std::fs::read(&target).unwrap(), b"id,name\r\n1,a\r\n");
        assert!(!dir.path().join("orders.csv.partial").exists());
    }

    #[test]
    fn drop_deletes_uncommitted_partial() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("orders.csv");
        let partial = {
            let mut w = create(&target, false).unwrap().writer();
            w.write_all(&[b'x'; 100_000]).unwrap();
            w.partial_path().to_path_buf()
        };
        assert!(!partial.exists());
        assert!(!target.exists());
        // Dropped before a writer is made.
        let f = create(&target, false).unwrap();
        let partial = f.partial_path().to_path_buf();
        assert!(partial.exists());
        drop(f);
        assert!(!partial.exists());
        // Aborted.
        let mut w = create(&target, false).unwrap().writer();
        w.write_all(b"x").unwrap();
        w.abort();
        assert!(!partial.exists());
        assert!(!target.exists());
    }

    /// Windows refuses to rename over a read-only file; elsewhere the rename only needs a
    /// writable folder, so the commit succeeds and there is nothing to test.
    #[cfg(windows)]
    #[test]
    fn commit_onto_read_only_target_keeps_old_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("orders.csv");
        std::fs::write(&target, b"old").unwrap();
        let mut perms = std::fs::metadata(&target).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&target, perms.clone()).unwrap();

        let mut w = create(&target, true).unwrap().writer();
        w.write_all(b"new rows").unwrap();
        let err = w.commit().unwrap_err();
        let shown = target.display().to_string();
        assert!(
            matches!(&err, Error::File(m) if m.contains(&shown)),
            "expected a File error naming the path, got {err:?}"
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
        assert!(!dir.path().join("orders.csv.partial").exists());

        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        std::fs::set_permissions(&target, perms).unwrap();
    }

    #[test]
    fn second_partial_refused() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("orders.csv");
        let first = create(&target, false).unwrap();
        match create(&target, false) {
            Err(Error::InvalidInput(m)) => {
                assert_eq!(m, "Another export is writing to orders.csv.")
            }
            Err(e) => panic!("expected InvalidInput, got {e:?}"),
            Ok(_) => panic!("expected a refusal"),
        }
        // The refusal must not delete the first export's partial.
        assert!(first.partial_path().exists());
    }

    /// Q45: readers of one held file keep their own offsets and stop at the size the
    /// handle saw when it opened; on Windows the hold refuses writers until all are gone.
    #[test]
    fn held_file_readers_are_independent_and_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("held.csv");
        std::fs::write(&p, b"0123456789").unwrap();
        let held = HeldFile::open(&p).unwrap();
        assert_eq!(held.bytes(), 10);
        let (mut a, mut b) = (held.reader(), held.reader());
        let mut buf = [0u8; 4];
        a.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"0123");
        b.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"0123", "b starts at the start whatever a read");
        let mut rest = Vec::new();
        a.read_to_end(&mut rest).unwrap();
        assert_eq!(rest, b"456789");
        b.seek(SeekFrom::End(-2)).unwrap();
        rest.clear();
        b.read_to_end(&mut rest).unwrap();
        assert_eq!(rest, b"89");
        let mut want = Sha256::new();
        want.update(b"0123456789");
        let want: [u8; 32] = want.finalize().into();
        assert_eq!(held.sha256(&AtomicBool::new(false)).unwrap(), want);
        #[cfg(windows)]
        {
            assert!(OpenOptions::new().append(true).open(&p).is_err());
            drop(held);
            drop(a);
            assert!(
                OpenOptions::new().append(true).open(&p).is_err(),
                "a reader still holds it"
            );
            drop(b);
            assert!(OpenOptions::new().append(true).open(&p).is_ok());
        }
    }

    #[test]
    fn hashing_reader_matches_sha256_of_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.txt");
        std::fs::write(&path, b"abc").unwrap();
        let mut r = HashingReader::new(File::open(&path).unwrap());
        let mut out = String::new();
        r.read_to_string(&mut out).unwrap();
        assert_eq!(out, "abc");
        assert_eq!(
            hex(&r.digest()),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(HashingReader::bytes(&r), 3);
        let h = r.finish();
        // SHA-256("abc").
        let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert_eq!(hex(&h), abc);
        let flag = AtomicBool::new(false);
        assert_eq!(hex(&file_sha256(&path, &flag).unwrap()), abc);
        flag.store(true, Ordering::SeqCst);
        assert!(matches!(file_sha256(&path, &flag), Err(Error::Cancelled)));
    }

    #[test]
    fn read_user_text_caps_size_and_needs_utf8() {
        let dir = tempfile::tempdir().unwrap();
        let ok = dir.path().join("flow.mmd");
        std::fs::write(&ok, "\u{feff}flowchart TD\n  a --> b\n").unwrap();
        assert_eq!(
            read_user_text(&ok, MIB).unwrap(),
            "flowchart TD\n  a --> b\n"
        );
        let big = dir.path().join("big.mmd");
        std::fs::write(&big, vec![b'a'; (MIB + 1) as usize]).unwrap();
        assert!(matches!(read_user_text(&big, MIB),
            Err(Error::InvalidInput(m)) if m == "This file is larger than 1 MB."));
        let bin = dir.path().join("bin.mmd");
        std::fs::write(&bin, [0xff, 0xfe, 0x00, 0x41]).unwrap();
        assert!(matches!(read_user_text(&bin, MIB), Err(Error::File(_))));
        assert!(matches!(
            read_user_text(&dir.path().join("missing.mmd"), MIB),
            Err(Error::File(_))
        ));
    }

    #[test]
    fn stale_partial_is_removed_on_create() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("orders.csv");
        // Left behind by a crash: no live PartialFile in this process owns it.
        std::fs::write(dir.path().join("orders.csv.partial"), b"half a file").unwrap();
        let mut w = create(&target, false).unwrap().writer();
        w.write_all(b"id\r\n").unwrap();
        assert_eq!(w.commit().unwrap(), 4);
        assert_eq!(std::fs::read(&target).unwrap(), b"id\r\n");
        // Once committed, the name is free again.
        let again = create(&target, true).unwrap();
        drop(again);
        let w = create(&target, true).unwrap().writer();
        // A live writer still holds its name.
        assert!(matches!(
            create(&target, true),
            Err(Error::InvalidInput(m)) if m == "Another export is writing to orders.csv."
        ));
        w.abort();
        assert!(create(&target, true).is_ok());
    }

    #[test]
    fn commit_refuses_a_target_created_meanwhile() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("orders.csv");
        let mut w = create(&target, false).unwrap().writer();
        w.write_all(b"new").unwrap();
        std::fs::write(&target, b"someone else's").unwrap();
        assert!(matches!(w.commit(), Err(Error::FileExists(p)) if p == target));
        assert_eq!(std::fs::read(&target).unwrap(), b"someone else's");
        assert!(!dir.path().join("orders.csv.partial").exists());
    }

    #[test]
    fn relative_paths_are_refused() {
        let data = tempfile::tempdir().unwrap();
        for p in ["orders.csv", "out/orders.csv", "../orders.csv"] {
            assert!(
                check_user_path(Path::new(p), data.path(), PathUse::Export).is_err(),
                "{p} was let through"
            );
        }
        #[cfg(windows)]
        assert!(check_user_path(Path::new("C:orders.csv"), data.path(), PathUse::Export).is_err());
    }

    #[test]
    fn an_unresolvable_data_folder_refuses() {
        let root = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let missing = root.path().join("no-such-folder");
        assert!(matches!(
            check_user_path(&out.path().join("x.csv"), &missing, PathUse::Export),
            Err(Error::InvalidInput(m)) if m == "Save exports outside Contura's data folder."
        ));
    }

    #[test]
    fn dot_dot_and_case_aliases_are_inside() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("Data");
        std::fs::create_dir_all(data.join("sub")).unwrap();
        let via = data.join("sub").join("..").join("x.csv");
        assert!(check_user_path(&via, &data, PathUse::Export).is_err());
        #[cfg(windows)]
        {
            let upper = PathBuf::from(root.path().to_string_lossy().to_uppercase())
                .join("DATA")
                .join("x.csv");
            assert!(check_user_path(&upper, &data, PathUse::Export).is_err());
        }
    }

    #[cfg(windows)]
    #[test]
    fn junction_into_the_data_folder_is_inside() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let link = root.path().join("link");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&data)
            .output()
            .unwrap();
        assert!(made.status.success(), "mklink /J failed: {made:?}");
        assert!(check_user_path(&link.join("x.csv"), &data, PathUse::Export).is_err());
        std::fs::remove_dir(&link).unwrap();
    }

    /// `\\localhost\C$\...` reaches the data folder through the admin share. Skipped when
    /// the share is not reachable for this user.
    #[cfg(windows)]
    #[test]
    fn loopback_unc_into_the_data_folder_is_inside() {
        let data = tempfile::tempdir().unwrap();
        let canon = data.path().canonicalize().unwrap();
        let text = canon.to_string_lossy();
        let plain = text.strip_prefix(r"\\?\").unwrap_or(&text).to_string();
        let mut chars = plain.chars();
        let (Some(drive), Some(':')) = (chars.next(), chars.next()) else {
            eprintln!("skipped: {plain} has no drive letter");
            return;
        };
        let unc = PathBuf::from(format!(r"\\localhost\{drive}${}", &plain[2..]));
        if !unc.exists() {
            eprintln!("skipped: {} is not reachable", unc.display());
            return;
        }
        assert!(check_user_path(&unc.join("app.sqlite"), data.path(), PathUse::Export).is_err());
        assert!(
            check_user_path(&unc.join("new").join("x.csv"), data.path(), PathUse::Import).is_err()
        );
    }
}
