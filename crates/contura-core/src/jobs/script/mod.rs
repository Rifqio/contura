//! The SQL file reader (D2). `Splitter` cuts a streamed file into statements with the
//! rules of the 5a lexer (`safety::lex`): `--` comments (MySQL wants whitespace after
//! them), `#` on MySQL, `/* */` (nested on PostgreSQL), `/*! */`, quotes with each
//! Dialect's backslash rule, backticks, SQLite `[..]` and PostgreSQL dollar quotes. On top
//! of those it keeps what a Dialect's own client keeps together: MySQL `DELIMITER` lines,
//! SQLite `CREATE TRIGGER ... BEGIN ... END` (the `sqlite3_complete` rule), PostgreSQL
//! `BEGIN ATOMIC ... END` bodies (psql's rule), and psql `COPY ... FROM STDIN` data.
//! Backslashes are read the way the server reads them by default; `safety::classify`
//! still looks at both readings of each statement.

mod insert_shape;
mod lists;
mod names;
mod split;
#[cfg(test)]
mod tests;
mod tokens;

use std::collections::VecDeque;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::jobs::formats::{BUF_BYTES, read_err, read_head};
use crate::jobs::paths::HashingReader;
use crate::jobs::types::{ScriptAction, ScriptStatement};
use crate::model::DialectKind;
use crate::safety::{StatementClass, classify};

pub use insert_shape::insert_shape;
pub(crate) use insert_shape::insert_shape_strict;
pub(crate) use lists::{Facts, TxControl};
pub use lists::{ends_transaction, is_transaction_control, statement_action, statement_kind};
pub(crate) use names::{
    DdlCounts, Name, calls_sequence_write, created_object, created_type_or_sequence, ddl_counts,
    dml_calls, ends_shapes, insert_table,
};
pub(crate) use split::Splitter;

use crate::jobs::limits::MAX_STATEMENT_BYTES;

const BACKUP_PREFIX: &str = "-- Contura backup, format ";
const BOM: &[u8] = b"\xEF\xBB\xBF";
/// Enough of the file's start to read its first line.
const HEAD_BYTES: u64 = 4096;

/// One statement as the splitter cut it, without its delimiter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RawStatement {
    pub text: String,
    pub line: u32,
    /// The lists and checks, from the one look the splitter takes at the statement.
    pub facts: Facts,
}

/// Reads a `.sql` file one statement at a time through a 64 KB buffer, hashing every byte.
pub struct ScriptReader {
    path: PathBuf,
    dialect: DialectKind,
    run_as_is: bool,
    file: HashingReader<Box<dyn Read + Send>>,
    read_buf: Vec<u8>,
    /// An incomplete UTF-8 sequence cut by the last read.
    carry: Vec<u8>,
    first_read: bool,
    splitter: Splitter,
    queue: VecDeque<RawStatement>,
    done: bool,
    /// The error that stops the read once the statements before it are handed out.
    stop: Option<Error>,
    hash: Option<[u8; 32]>,
    next_index: u32,
    limit: usize,
    /// 1 plus the line ends handed to the splitter.
    lines_fed: u32,
    contura_backup: bool,
    own_transactions: bool,
    one_transaction: bool,
}

impl ScriptReader {
    pub fn open(path: &Path, dialect: DialectKind, run_as_is: bool) -> Result<ScriptReader> {
        let contura_backup = backup_header(&read_head(path)?);
        let file = File::open(path).map_err(|e| read_err(Some(path), e))?;
        Ok(Self::reading(
            path,
            Box::new(file),
            contura_backup,
            dialect,
            run_as_is,
        ))
    }

    /// Reads the open `file` (named `path` in messages) from its start, and at most its
    /// first `limit` bytes: the import run reads the very handle the start checked, up to
    /// the size it checked.
    pub fn from_file(
        path: &Path,
        mut file: File,
        limit: u64,
        dialect: DialectKind,
        run_as_is: bool,
    ) -> Result<ScriptReader> {
        let err = |e| read_err(Some(path), e);
        file.seek(SeekFrom::Start(0)).map_err(err)?;
        let mut head = Vec::new();
        (&mut file)
            .take(HEAD_BYTES.min(limit))
            .read_to_end(&mut head)
            .map_err(err)?;
        file.seek(SeekFrom::Start(0)).map_err(err)?;
        let contura_backup = backup_header(&head);
        Ok(Self::reading(
            path,
            Box::new(file.take(limit)),
            contura_backup,
            dialect,
            run_as_is,
        ))
    }

    fn reading(
        path: &Path,
        file: Box<dyn Read + Send>,
        contura_backup: bool,
        dialect: DialectKind,
        run_as_is: bool,
    ) -> ScriptReader {
        ScriptReader {
            path: path.to_path_buf(),
            dialect,
            run_as_is,
            file: HashingReader::new(file),
            read_buf: vec![0; BUF_BYTES],
            carry: Vec::new(),
            first_read: true,
            splitter: Splitter::new(dialect),
            queue: VecDeque::new(),
            done: false,
            stop: None,
            hash: None,
            next_index: 0,
            limit: MAX_STATEMENT_BYTES,
            lines_fed: 1,
            contura_backup,
            own_transactions: false,
            one_transaction: true,
        }
    }

    #[cfg(test)]
    fn with_limit(mut self, n: usize) -> Self {
        self.limit = n;
        self
    }

    /// Reads from `r` instead of the file, to force read errors.
    #[cfg(test)]
    fn with_reader(mut self, r: Box<dyn Read + Send>) -> Self {
        self.file = HashingReader::new(r);
        self
    }

    pub fn next_statement(&mut self) -> Result<Option<ScriptStatement>> {
        Ok(self.next_checked()?.map(|(s, _)| s))
    }

    /// The next statement with what the lists and checks found in it, for the import run.
    pub(crate) fn next_checked(&mut self) -> Result<Option<(ScriptStatement, Facts)>> {
        loop {
            if let Some(raw) = self.queue.pop_front() {
                let facts = raw.facts.clone();
                return Ok(Some((self.statement(raw), facts)));
            }
            if let Some(e) = self.stop.take() {
                return Err(e);
            }
            if self.done {
                return Ok(None);
            }
            if let Err(e) = self.feed() {
                self.done = true;
                return Err(e);
            }
        }
    }

    fn feed(&mut self) -> Result<()> {
        let mut out = Vec::new();
        let n = loop {
            match self.file.read(&mut self.read_buf) {
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                r => break r.map_err(|e| read_err(Some(&self.path), e))?,
            }
        };
        if n == 0 {
            if !self.carry.is_empty() {
                return Err(not_utf8(self.lines_fed));
            }
            self.splitter.finish(&mut out)?;
            self.done = true;
            self.hash = Some(self.file.digest());
        } else {
            let mut bytes = std::mem::take(&mut self.carry);
            bytes.extend_from_slice(&self.read_buf[..n]);
            if self.first_read {
                self.first_read = false;
                if bytes.starts_with(BOM) {
                    bytes.drain(..BOM.len());
                }
            }
            let valid = match std::str::from_utf8(&bytes) {
                Ok(_) => bytes.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(e) => {
                    let before = &bytes[..e.valid_up_to()];
                    let ends = before.iter().filter(|b| **b == b'\n').count() as u32;
                    return Err(not_utf8(self.lines_fed + ends));
                }
            };
            let text =
                std::str::from_utf8(&bytes[..valid]).map_err(|_| not_utf8(self.lines_fed))?;
            self.lines_fed += text.bytes().filter(|b| *b == b'\n').count() as u32;
            self.splitter.push(text, &mut out)?;
            self.carry = bytes[valid..].to_vec();
        }
        // The statements before one that is too large are still handed out first.
        for raw in out {
            if raw.text.len() > self.limit {
                self.stop = Some(too_large(raw.line, self.limit));
                break;
            }
            self.queue.push_back(raw);
        }
        if self.stop.is_none() && self.splitter.pending_len() > self.limit {
            self.stop = Some(too_large(self.splitter.pending_line(), self.limit));
        }
        if self.stop.is_some() {
            self.done = true;
            self.hash = None;
        }
        Ok(())
    }

    fn statement(&mut self, raw: RawStatement) -> ScriptStatement {
        let facts = &raw.facts;
        let found = facts.action(false);
        // A psql line is skipped even with Run as is.
        let skippable = matches!(found, ScriptAction::Skip { .. }) && facts.psql_skip.is_none();
        let run_as_is = skippable && self.run_as_is;
        let action = if run_as_is { ScriptAction::Run } else { found };
        if action == ScriptAction::Run {
            self.own_transactions |= facts.control;
            self.one_transaction &= !facts.ends;
        }
        let index = self.next_index;
        self.next_index += 1;
        ScriptStatement {
            index,
            line: raw.line,
            // Over the token cap the classifier is not run at all; it is a write.
            class: if facts.too_large {
                StatementClass::Write
            } else {
                classify(self.dialect, &raw.text)
            },
            kind: facts.kind,
            action,
            run_as_is,
            text: raw.text,
        }
    }

    /// The bytes read from the file so far.
    pub fn bytes_read(&self) -> u64 {
        HashingReader::bytes(&self.file)
    }

    /// The SHA-256 of the whole file, once the last statement has been read.
    pub fn sha256(&self) -> Option<[u8; 32]> {
        self.hash
    }

    /// The file's first line says it is a Contura Backup.
    pub fn contura_backup(&self) -> bool {
        self.contura_backup
    }

    /// A statement read so far that runs controls transactions itself.
    pub fn own_transactions(&self) -> bool {
        self.own_transactions
    }

    /// The statements read so far that run can share one transaction: none controls
    /// transactions, and none is MySQL DDL, which commits as it runs.
    pub fn one_transaction(&self) -> bool {
        self.one_transaction
    }

    /// The SHA-256 of the whole file: what is left is read through the hash first. A read
    /// that fails is an error, never a hash of part of the file.
    pub fn finish(mut self) -> Result<[u8; 32]> {
        loop {
            match self.file.read(&mut self.read_buf) {
                Ok(0) => return Ok(self.file.finish()),
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => return Err(read_err(Some(&self.path), e)),
            }
        }
    }
}

fn not_utf8(line: u32) -> Error {
    Error::File(format!("Line {line} is not UTF-8. Save the file as UTF-8."))
}

fn too_large(line: u32, limit: usize) -> Error {
    Error::File(format!(
        "Line {line}: one statement is larger than {}.",
        limit_text(limit)
    ))
}

fn limit_text(limit: usize) -> String {
    const MB: usize = 1024 * 1024;
    if limit.is_multiple_of(MB) {
        format!("{} MB", limit / MB)
    } else if limit.is_multiple_of(1024) {
        format!("{} KB", limit / 1024)
    } else {
        format!("{limit} bytes")
    }
}

/// Whether the file that starts with `head` is a Contura Backup.
pub(crate) fn backup_header(head: &[u8]) -> bool {
    let body = head.strip_prefix(BOM).unwrap_or(head);
    let first = body.split(|b| *b == b'\n').next().unwrap_or_default();
    is_contura_backup(&String::from_utf8_lossy(first))
}

pub fn is_contura_backup(first_line: &str) -> bool {
    first_line
        .strip_prefix('\u{feff}')
        .unwrap_or(first_line)
        .starts_with(BACKUP_PREFIX)
}
