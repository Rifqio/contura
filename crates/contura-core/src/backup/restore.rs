//! Restore: the check pass and the plan (spec "Restore: checks", "Restore: confirm",
//! "Safety"). The run is built on top of these.
//!
//! - [`inspect_file`] refuses a Read-only target before the file is opened, reads the
//!   header and trailer ([`read_header`]), refuses a damaged or cut Backup and a Backup of
//!   another Dialect, then streams the file once through step 7's [`ScriptReader`] (64 KB
//!   reads, one statement at a time, at most 16 MB a statement, hashed as it goes). A file
//!   without a Contura header is plain SQL and is read the same way (R16). Each statement
//!   is refused, skipped, an INSERT shown as a shape, or shown exactly. The pass keeps
//!   counts, line numbers, the names the file creates and the first 50 statements shown
//!   exactly; never the file. Section markers are comments and are never read: they
//!   cannot hide a statement.
//! - [`read_target`] reads the target: its version, the objects in the database (or
//!   schema), the databases, PostgreSQL's extensions and materialized views, and SQLite's
//!   `foreign_keys`. It is the only part that needs a connection.
//! - [`build_check`] and [`build_plan`] are pure: the check from those two, and the plan
//!   from the request and the check, with the fingerprint the Job pass is bound to.
//! - [`structure_page`] pages the statements shown exactly, with the same rule.
//!
//! Run and shown order (R15): `create_database` (on its own), `setup` on the writer,
//! `drops`, the file's statements, `after`; `cleanup` only on failure or Cancel.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::format::{BackupFile, BackupHeader, Trailer, read_header};
use crate::common::grouped;
use crate::common::{quote_double, sql_ident, sql_string};
use crate::dialect::Dialect;
use crate::error::{Error, Result};
use crate::jobs::FileIdentity;
use crate::jobs::fingerprint::{JobPlan, job_fingerprint};
use crate::jobs::formats::sql::dialect_name as dialect_label;
use crate::jobs::paths::hex;
use crate::jobs::script::{
    DdlCounts, Facts, Name, ScriptReader, calls_sequence_write, created_object,
    created_type_or_sequence, ddl_counts, dml_calls, ends_shapes, insert_shape_strict,
    insert_table,
};
use crate::jobs::types::{
    InsertShape, JobKind, JobVerdict, ScriptAction, ScriptStatement, StatementKind,
};
use crate::model::{Cell, ConnectionConfig, ConnectionId, DbObject, DialectKind, ObjectKind};
use crate::query::{ExecOutcome, SessionHandle};
use crate::safety::{PlannedStatement, StatementClass, classify};

/// The check and the plan hold this many statements shown exactly; the rest are paged
/// from the file.
pub const FIRST_STRUCTURE: usize = 50;
/// `restore_statements` hands out this many statements a call.
pub const STATEMENTS_PAGE: usize = 100;
/// The refused and skipped lists hold this many lines; the rest are counted.
const LIST_CAP: usize = 1_000;
/// A statement shown exactly keeps this much of its text; the pass still binds all of it
/// through the file's hash.
const ITEM_BYTES: usize = 64 * 1024;
/// The first statements together hold at most this much text.
const STRUCTURE_BUDGET: usize = 8 * 1024 * 1024;
/// The pass sends progress this often.
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// The refusal kind of a statement too large to classify.
const TOO_LARGE: &str = "A statement too large to check";

/// Where a Restore goes: the Connection, the database (MySQL, PostgreSQL) the dialog was
/// opened on (None on a Connection row, where only a new database can be made), and on
/// PostgreSQL the schema row it was opened on.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RestoreTarget {
    pub connection_id: ConnectionId,
    pub database: Option<String>,
    pub schema: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RestoreMode {
    /// Into a new database named `name`; on SQLite `name` is the new file's path, which
    /// must not exist.
    NewDatabase {
        #[serde(default)]
        name: String,
    },
    /// Into the target database, which must be empty.
    IntoEmpty,
    /// Drops the target's objects that have the file's names, then restores.
    Replace {
        /// MySQL: back up the tables before any DROP (on by default in the dialog).
        #[serde(default)]
        backup_first: bool,
    },
}

impl Default for RestoreMode {
    fn default() -> Self {
        RestoreMode::NewDatabase {
            name: String::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RestoreRequest {
    pub target: RestoreTarget,
    pub path: PathBuf,
    pub mode: RestoreMode,
    pub run_as_is: bool,
    /// The user's local date, `yyyy-mm-dd`, for the Back up first file name (R25, R32
    /// M-4); UTC when absent or malformed.
    pub local_date: Option<String>,
}

/// A statement Restore skips unless Run as is: `kind` is "GRANT", "CREATE USER", ...
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RestoreSkipped {
    pub line: u64,
    pub kind: String,
}

/// A statement that makes the file refused: `kind` is "DROP DATABASE", "BEGIN", ...; the
/// UI writes "Line 2,041: DROP DATABASE is not run by Restore."
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RestoreRefused {
    pub line: u64,
    pub kind: String,
}

/// One table and its row count in the header.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct TableRows {
    pub table: String,
    pub rows: u64,
}

/// The file header as the dialog lists it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreHeader {
    #[serde(default)]
    pub format: u32,
    #[serde(default)]
    pub made_by: String,
    pub dialect: DialectKind,
    #[serde(default)]
    pub server_version: String,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(default)]
    pub taken_at: String,
    /// The header's words: "tables", "foreign-keys", ...
    #[serde(default)]
    pub contents: Vec<String>,
    #[serde(default)]
    pub rows: Vec<TableRows>,
    #[serde(default)]
    pub not_included: Vec<String>,
    #[serde(default)]
    pub definer_removed: bool,
    #[serde(default)]
    pub drop_tables: bool,
}

impl RestoreHeader {
    fn of(h: &BackupHeader) -> Self {
        RestoreHeader {
            format: h.format,
            made_by: h.made_by.clone(),
            dialect: h.dialect,
            server_version: h.server_version.clone(),
            database: h.database.clone(),
            schema: h.schema.clone(),
            taken_at: h.taken_at.clone(),
            contents: h.contents.iter().map(|c| c.as_str().to_string()).collect(),
            rows: h
                .rows
                .iter()
                .map(|(table, rows)| TableRows {
                    table: table.clone(),
                    rows: *rows,
                })
                .collect(),
            not_included: h.not_included.clone(),
            definer_removed: h.definer_removed,
            drop_tables: h.drop_tables,
        }
    }
}

/// An object in the target with a name the file creates.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExistingObject {
    pub kind: ObjectKind,
    /// As the target lists it: a PostgreSQL function carries its arguments, `f(integer)`.
    pub name: String,
    /// The server's row estimate; tables only.
    #[serde(default)]
    pub rows: Option<u64>,
    /// A PostgreSQL materialized view (listed as a view).
    #[serde(default)]
    pub materialized: bool,
}

/// What the structure statements make, for the confirmation's count line.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct StructureCounts {
    pub tables: u64,
    pub indexes: u64,
    pub foreign_keys: u64,
}

fn structure_counts(c: DdlCounts) -> StructureCounts {
    StructureCounts {
        tables: c.tables,
        indexes: c.indexes,
        foreign_keys: c.foreign_keys,
    }
}

/// What one streamed pass over the file found. `run_as_is` is the choice it was read
/// with: skipped statements are listed without it and shown exactly with it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileCheck {
    /// None for plain SQL.
    pub header: Option<BackupHeader>,
    pub trailer: Option<Trailer>,
    pub run_as_is: bool,
    pub bytes: u64,
    /// Lowercase hex.
    pub sha256: String,
    /// Every statement read.
    pub statements: u64,
    pub refused: Vec<RestoreRefused>,
    pub refused_more: u64,
    pub skipped: Vec<RestoreSkipped>,
    pub skipped_more: u64,
    /// Each skipped kind ("GRANT") and how many, in the order first seen.
    pub skipped_kinds: Vec<(String, u64)>,
    /// The first statements shown exactly (texts cut at 64 KB), and how many there are.
    pub structure: Vec<ScriptStatement>,
    pub structure_total: u64,
    pub creates: StructureCounts,
    /// INSERTs shown as a shape: how many, their rows, and the first one's shape with
    /// `statements` and `rows` counting them all.
    pub insert_count: u64,
    pub insert_rows: u64,
    pub insert_shape: Option<InsertShape>,
    /// The tables, views, routines and triggers the file creates.
    pub objects: Vec<(ObjectKind, Name)>,
    /// PostgreSQL types (false) and sequences (true) the file creates (R29).
    pub types_and_sequences: Vec<(bool, Name)>,
}

/// What Restore reads from the target.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TargetFacts {
    pub version: String,
    /// The database Into and Replace write into; None on a Connection row.
    pub database: Option<String>,
    /// The schema read (PostgreSQL); None when every user schema was read.
    pub schema: Option<String>,
    /// Its objects (MySQL, SQLite) or those of the schema (PostgreSQL).
    pub objects: Vec<DbObject>,
    /// The server's databases (MySQL, PostgreSQL), for the new name.
    pub databases: Vec<String>,
    /// PostgreSQL's installed extensions.
    pub extensions: Vec<String>,
    /// PostgreSQL's materialized views in the schema.
    pub materialized_views: Vec<String>,
    /// SQLite's `foreign_keys` on a new connection, put back after the run.
    pub foreign_keys: Option<bool>,
    /// PostgreSQL's types (enums, ranges, composite types) and standalone sequences (no
    /// owning column) in the schema, for Replace (R29).
    pub types: Vec<String>,
    pub sequences: Vec<String>,
}

/// The checks dialog (the `restoreCheck` job's report). The contract's fields first, then
/// the Core's ready-made lines and what the plan is built from.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreCheck {
    #[serde(default)]
    pub path: PathBuf,
    /// None for plain SQL.
    #[serde(default)]
    pub header: Option<RestoreHeader>,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub target_name: String,
    pub target_dialect: DialectKind,
    #[serde(default)]
    pub target_version: String,
    #[serde(default)]
    pub dialect_ok: bool,
    /// The older-server warning.
    #[serde(default)]
    pub version_note: Option<String>,
    #[serde(default)]
    pub statements: u64,
    #[serde(default)]
    pub refused: Vec<RestoreRefused>,
    #[serde(default)]
    pub skipped: Vec<RestoreSkipped>,
    /// Tables in the target with the file's names.
    #[serde(default)]
    pub existing_tables: Vec<String>,
    /// The target database (or schema) holds no table, view, routine or trigger.
    #[serde(default)]
    pub target_empty: bool,
    #[serde(default)]
    pub missing_extensions: Vec<String>,
    /// A Contura Backup's trailer was found; false for plain SQL.
    #[serde(default)]
    pub trailer_ok: bool,

    /// Refused and skipped statements past the 1,000 the lists hold.
    #[serde(default)]
    pub refused_more: u64,
    #[serde(default)]
    pub skipped_more: u64,
    /// Every object in the target with a name the file creates, tables first.
    #[serde(default)]
    pub existing_objects: Vec<ExistingObject>,
    /// "Same Dialect as freight-prod: PostgreSQL".
    #[serde(default)]
    pub dialect_line: String,
    /// "1,503 statements read, none refused".
    #[serde(default)]
    pub statements_line: String,
    /// "2 GRANT statements are skipped. Tick Run as is to keep them."
    #[serde(default)]
    pub skipped_note: Option<String>,
    /// "freight already has 6 tables with these names".
    #[serde(default)]
    pub existing_note: Option<String>,
    /// "pgcrypto is not installed on freight-prod. Functions that use it will fail."
    #[serde(default)]
    pub extension_notes: Vec<String>,
    /// "freight is not empty": why Into <database> is disabled.
    #[serde(default)]
    pub empty_note: Option<String>,
    /// Why Replace is disabled: PostgreSQL with no known schema (R18).
    #[serde(default)]
    pub replace_note: Option<String>,
    /// `<database>_restore_<mmdd>`; on SQLite a new file beside the target's.
    #[serde(default)]
    pub default_name: String,
    /// The database Into and Replace write into.
    #[serde(default)]
    pub target_database: Option<String>,
    #[serde(default)]
    pub run_as_is: bool,
    #[serde(default)]
    pub structure: Vec<ScriptStatement>,
    #[serde(default)]
    pub structure_total: u64,
    #[serde(default)]
    pub creates: StructureCounts,
    #[serde(default)]
    pub insert_count: u64,
    #[serde(default)]
    pub insert_rows: u64,
    #[serde(default)]
    pub insert_shape: Option<InsertShape>,

    /// The header as read, for the run's row-count check; None for plain SQL.
    #[serde(skip)]
    pub backup_header: Option<BackupHeader>,
    #[serde(skip)]
    pub schema: Option<String>,
    #[serde(skip)]
    pub file_objects: Vec<(ObjectKind, Name)>,
    /// PostgreSQL types and standalone sequences in the target with names the file
    /// creates (R29); Replace drops them after the tables.
    #[serde(default)]
    pub existing_types: Vec<String>,
    #[serde(default)]
    pub existing_sequences: Vec<String>,
    #[serde(skip)]
    pub databases: Vec<String>,
    #[serde(skip)]
    pub foreign_keys: Option<bool>,
    /// `YYYY-MM-DD` (UTC) the check was made, for the plan's file names.
    #[serde(skip)]
    pub today: String,
}

/// The confirmation: what Contura adds around the file, the file's statements, and the
/// fingerprint the Job pass is bound to.
#[derive(Serialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RestorePlan {
    /// Contura's session setup on the writer, after `create_database` (R15).
    pub setup: Vec<PlannedStatement>,
    /// Replace: every DROP, after the setup and before the file's statements.
    pub drops: Vec<PlannedStatement>,
    /// The first file statements not shown as a shape, in file order.
    pub structure: Vec<ScriptStatement>,
    pub structure_total: u64,
    pub creates: StructureCounts,
    pub insert_count: u64,
    pub insert_rows: u64,
    pub insert_shape: Option<InsertShape>,
    /// What Contura runs after the file: the checks, COMMIT, settings back.
    pub after: Vec<PlannedStatement>,
    /// Run on failure or Cancel (after the roll back): `DROP DATABASE ..`. Empty unless
    /// Into a new database on MySQL or PostgreSQL.
    pub cleanup: Vec<String>,
    /// Replace: the target's rows in the dropped tables, when known.
    pub replaced_rows: Option<u64>,
    /// MySQL Replace with Back up first: the file that Backup writes.
    pub backup_first_path: Option<String>,
    /// MySQL Replace with Back up first: the tables it backs up, those Replace drops (R30).
    #[serde(skip)]
    pub backup_first_tables: Vec<String>,
    /// The running state's note: "One transaction. Cancel rolls back and removes ..."
    pub mode_line: String,
    /// Lowercase hex SHA-256 of the plan.
    pub fingerprint: String,
    pub verdict: JobVerdict,

    pub mode: RestoreMode,
    /// `CREATE DATABASE ..` on the maintenance connection, on its own, before `setup`.
    pub create_database: Option<PlannedStatement>,
    /// The database written into: the new one, or the target.
    pub database: Option<String>,
    /// SQLite, Into a new database: the new file, deleted on failure or Cancel.
    pub delete_file: Option<PathBuf>,
    /// "Into freight_restore_1017", "Replace the 6 tables in freight".
    pub into_line: String,
    /// "Creates freight_restore_1017, then 6 tables, ... All of it writes."
    pub count_line: String,
    /// "If the restore fails or is cancelled: DROP DATABASE freight_restore_1017".
    pub cleanup_line: Option<String>,
    /// Replace: "Replace drops 6 tables in freight with 742,818 rows. ..."
    pub replace_banner: Option<String>,
    /// MySQL Replace: "MySQL cannot undo DROP TABLE. ..."
    pub mysql_replace_note: Option<String>,
    /// MySQL Replace: "Back up these 6 tables first".
    pub backup_first_line: Option<String>,
    /// Replace mode, or a file written with DROP TABLE before each table.
    pub danger: bool,
    /// PostgreSQL and SQLite run in one transaction; MySQL commits each DDL statement.
    pub one_transaction: bool,
    pub bytes: u64,
    pub sha256: String,
}

fn refused_err(reason: String) -> Error {
    Error::BackupRefused { reason }
}

/// The refusal for a Backup of another Dialect.
pub fn other_dialect_text(backup: DialectKind) -> String {
    let d = dialect_label(backup);
    format!("This Backup is from {d}. Restore it on a {d} Connection, or use Data Transfer.")
}

/// The header and trailer, or None for plain SQL; a cut or damaged Backup and one of
/// another Dialect are refused.
fn header_of(config: &ConnectionConfig, path: &Path) -> Result<Option<(BackupHeader, Trailer)>> {
    match read_header(path)? {
        BackupFile::Contura { header, trailer } => {
            if header.dialect != config.dialect {
                return Err(refused_err(other_dialect_text(header.dialect)));
            }
            Ok(Some((header, trailer)))
        }
        BackupFile::PlainSql => Ok(None),
    }
}

/// The check pass's file part. Refuses, in order: a Read-only target with
/// `ReadOnly(0)` before the file is opened; a Backup cut before its trailer or damaged
/// (`BackupRefused`); a Backup of another Dialect. Plain SQL is read with no header. Then
/// reads the whole file once; one statement over 16 MB stops it with its line.
/// `cancelled` stops it with `Cancelled`; `progress` gets the bytes and statements read,
/// at most every 100 ms.
pub fn inspect_file(
    config: &ConnectionConfig,
    path: &Path,
    run_as_is: bool,
    cancelled: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<FileCheck> {
    if config.read_only {
        return Err(Error::ReadOnly(0));
    }
    let head = header_of(config, path)?;
    let reader = ScriptReader::open(path, config.dialect, run_as_is)?;
    let (header, trailer) = match head {
        Some((h, t)) => (Some(h), Some(t)),
        None => (None, None),
    };
    scan(
        reader,
        config.dialect,
        header,
        trailer,
        run_as_is,
        cancelled,
        progress,
    )
}

/// [`inspect_file`] on a handle the caller holds open (with other writers refused), read
/// from its start: the Restore start checks the very handle its run then reads.
pub fn inspect_held(
    config: &ConnectionConfig,
    path: &Path,
    file: std::fs::File,
    run_as_is: bool,
    cancelled: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<FileCheck> {
    if config.read_only {
        return Err(Error::ReadOnly(0));
    }
    let head = header_of(config, path)?;
    let reader = ScriptReader::from_file(path, file, u64::MAX, config.dialect, run_as_is)?;
    let (header, trailer) = match head {
        Some((h, t)) => (Some(h), Some(t)),
        None => (None, None),
    };
    scan(
        reader,
        config.dialect,
        header,
        trailer,
        run_as_is,
        cancelled,
        progress,
    )
}

/// A header row label as name parts (I-5): Task 3 writes `<schema>.<table>` on
/// PostgreSQL and the bare table elsewhere, with no escaping, so a dot inside a name is
/// part of it. PostgreSQL: the header's schema and the rest; without a schema the first
/// dot splits. MySQL and SQLite: the whole label is the table.
pub(crate) fn label_parts(dialect: DialectKind, schema: Option<&str>, label: &str) -> Vec<String> {
    if dialect != DialectKind::Postgres {
        return vec![label.to_string()];
    }
    if let Some(s) = schema
        && let Some(table) = label.strip_prefix(s).and_then(|r| r.strip_prefix('.'))
    {
        return vec![s.to_string(), table.to_string()];
    }
    match label.split_once('.') {
        Some((a, b)) => vec![a.to_string(), b.to_string()],
        None => vec![label.to_string()],
    }
}

/// What Restore does with one statement.
pub(crate) enum Class {
    Refused(String),
    Skipped(String),
    Shape(InsertShape),
    Exact,
}

/// Same name part where extra matches are only listed (existing objects): ASCII case
/// ignored on MySQL and SQLite.
fn loose_part(dialect: DialectKind, a: &str, b: &str) -> bool {
    if dialect == DialectKind::Postgres {
        a == b
    } else {
        a.eq_ignore_ascii_case(b)
    }
}

/// Same name part where a match hides a statement (the shape rule): exact, except on
/// SQLite, which always folds ASCII case.
fn exact_part(dialect: DialectKind, a: &str, b: &str) -> bool {
    if dialect == DialectKind::Sqlite {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// Classifies statements in file order. An INSERT may be shown as a shape only when it
/// writes literal rows into a table the file has created so far or its header names,
/// matched part by part; the table comes from the statement, never a section marker.
pub(crate) struct Walker<'a> {
    dialect: DialectKind,
    header: &'a [(String, u64)],
    /// The header's schema, which starts each PostgreSQL row label.
    schema: Option<&'a str>,
    created: Vec<(ObjectKind, Name)>,
    /// PostgreSQL types (false) and sequences (true) created so far.
    extras: Vec<(bool, Name)>,
    /// A statement that ran changed where unqualified names land (R19): no INSERT after
    /// it is a shape.
    redirected: bool,
}

impl<'a> Walker<'a> {
    /// A walker over a file whose header (None for plain SQL) names `header` rows.
    pub(crate) fn new(dialect: DialectKind, header: Option<&'a BackupHeader>) -> Self {
        Walker {
            dialect,
            header: header.map_or(&[][..], |h| &h.rows[..]),
            schema: header.and_then(|h| h.schema.as_deref()),
            created: Vec::new(),
            extras: Vec::new(),
            redirected: false,
        }
    }

    fn holds(&self, name: &Name) -> bool {
        let d = self.dialect;
        let same = |a: &[String], b: &[&str]| {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| exact_part(d, x, y))
        };
        let parts: Vec<&str> = name.iter().map(String::as_str).collect();
        self.created
            .iter()
            .any(|(k, n)| *k == ObjectKind::Table && same(n, &parts))
            || self
                .header
                .iter()
                .any(|(h, _)| same(&label_parts(self.dialect, self.schema, h), &parts))
    }

    pub(crate) fn step(&mut self, s: &ScriptStatement, facts: &Facts) -> Class {
        if let Some(kind) = refusal(s, facts) {
            return Class::Refused(kind);
        }
        if matches!(s.action, ScriptAction::Skip { .. }) {
            let kind = facts.skipped.clone().unwrap_or_else(|| "Statement".into());
            return Class::Skipped(kind);
        }
        if s.kind == StatementKind::Insert
            && !self.redirected
            && let Some(name) = insert_table(self.dialect, &s.text)
            && self.holds(&name)
            && let Some(shape) = insert_shape_strict(self.dialect, &s.text)
        {
            return Class::Shape(shape);
        }
        if s.kind == StatementKind::Create
            && let Some(object) = created_object(self.dialect, &s.text)
        {
            self.created.push(object);
        }
        if s.kind == StatementKind::Create
            && let Some(extra) = created_type_or_sequence(self.dialect, &s.text)
        {
            self.extras.push(extra);
        }
        // R26: a write shown in full that calls a function may run code too.
        if ends_shapes(self.dialect, &s.text) || dml_calls(self.dialect, &s.text) {
            self.redirected = true;
        }
        Class::Exact
    }
}

/// The words a transaction-control refusal names.
fn control_words(text: &str) -> String {
    let mut words = text
        .split_whitespace()
        .map(|w| w.trim_end_matches(';').to_ascii_uppercase());
    let first = words.next().unwrap_or_default();
    let plain = |w: &str| !w.is_empty() && w.bytes().all(|b| b.is_ascii_alphabetic());
    match first.as_str() {
        "BEGIN" | "COMMIT" | "ROLLBACK" | "END" | "ABORT" => first.clone(),
        "START" | "LOCK" | "UNLOCK" | "XA" | "PREPARE" => match words.next() {
            Some(w) if plain(&w) => format!("{first} {w}"),
            _ => first.clone(),
        },
        "SET" => "SET autocommit".into(),
        _ => "Transaction control".into(),
    }
}

/// What Restore refuses in the statement: step 7's refusals, psql lines, a statement too
/// large to check, and transaction control (Restore owns the transaction). A CREATE's
/// body may hold COMMIT or START TRANSACTION; creating it runs neither.
fn refusal(s: &ScriptStatement, facts: &Facts) -> Option<String> {
    if let Some(what) = facts.refused {
        return Some(what.to_string());
    }
    if facts.psql_skip.is_some() {
        return Some("A psql meta-command".into());
    }
    if matches!(s.action, ScriptAction::Refuse { .. }) {
        return Some(TOO_LARGE.into());
    }
    if facts.control && s.kind != StatementKind::Create {
        return Some(control_words(&s.text));
    }
    None
}

/// The first `keep` bytes of `text`, at a character boundary.
fn head(text: &str, keep: usize) -> &str {
    let mut i = keep.min(text.len());
    while !text.is_char_boundary(i) {
        i -= 1;
    }
    &text[..i]
}

/// A statement's label: the 5a classifier's, except that a PostgreSQL `setval` or
/// `nextval` call writes (R11).
fn label(dialect: DialectKind, s: &ScriptStatement) -> StatementClass {
    if s.class == StatementClass::Read
        && dialect == DialectKind::Postgres
        && calls_sequence_write(dialect, &s.text)
    {
        StatementClass::Write
    } else {
        s.class
    }
}

/// A statement as the confirmation shows it: whole up to 64 KB, else cut with its size.
fn shown(dialect: DialectKind, s: &ScriptStatement) -> ScriptStatement {
    let text = if s.text.len() > ITEM_BYTES {
        let h = head(&s.text, ITEM_BYTES);
        format!(
            "{h}\n... ({} KB more, {} KB in all). The whole statement is bound to this file's hash.",
            (s.text.len() - h.len()).div_ceil(1024),
            s.text.len().div_ceil(1024)
        )
    } else {
        s.text.clone()
    };
    ScriptStatement {
        index: s.index,
        line: s.line,
        text,
        class: label(dialect, s),
        kind: s.kind,
        action: s.action.clone(),
        run_as_is: s.run_as_is,
    }
}

#[derive(Default)]
struct Tally {
    statements: u64,
    refused: Vec<RestoreRefused>,
    refused_more: u64,
    skipped: Vec<RestoreSkipped>,
    skipped_more: u64,
    skipped_kinds: Vec<(String, u64)>,
    structure: Vec<ScriptStatement>,
    structure_bytes: usize,
    structure_total: u64,
    counts: DdlCounts,
    insert_count: u64,
    insert_rows: u64,
    insert_shape: Option<InsertShape>,
}

fn scan(
    mut r: ScriptReader,
    dialect: DialectKind,
    header: Option<BackupHeader>,
    trailer: Option<Trailer>,
    run_as_is: bool,
    cancelled: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<FileCheck> {
    let mut t = Tally::default();
    let mut w = Walker::new(dialect, header.as_ref());
    let mut last = Instant::now();
    while let Some((s, facts)) = r.next_checked()? {
        if cancelled() {
            return Err(Error::Cancelled);
        }
        t.statements += 1;
        if last.elapsed() >= PROGRESS_EVERY {
            last = Instant::now();
            progress(r.bytes_read(), t.statements);
        }
        match w.step(&s, &facts) {
            Class::Refused(kind) => {
                if t.refused.len() < LIST_CAP {
                    t.refused.push(RestoreRefused {
                        line: u64::from(s.line),
                        kind,
                    });
                } else {
                    t.refused_more += 1;
                }
            }
            Class::Skipped(kind) => {
                match t.skipped_kinds.iter().position(|(k, _)| *k == kind) {
                    Some(i) => t.skipped_kinds[i].1 += 1,
                    None => t.skipped_kinds.push((kind.clone(), 1)),
                }
                if t.skipped.len() < LIST_CAP {
                    t.skipped.push(RestoreSkipped {
                        line: u64::from(s.line),
                        kind,
                    });
                } else {
                    t.skipped_more += 1;
                }
            }
            Class::Shape(shape) => {
                t.insert_count += 1;
                t.insert_rows += shape.rows;
                if t.insert_shape.is_none() {
                    t.insert_shape = Some(shape);
                } else if let Some(first) = &mut t.insert_shape {
                    first.statements += 1;
                    first.rows += shape.rows;
                }
            }
            Class::Exact => {
                t.structure_total += 1;
                t.counts.add(ddl_counts(dialect, &s.text));
                if t.structure.len() < FIRST_STRUCTURE && t.structure_bytes < STRUCTURE_BUDGET {
                    let item = shown(dialect, &s);
                    t.structure_bytes += item.text.len();
                    t.structure.push(item);
                }
            }
        }
    }
    let objects = std::mem::take(&mut w.created);
    let types_and_sequences = std::mem::take(&mut w.extras);
    let bytes = r.bytes_read();
    let sha = r
        .sha256()
        .ok_or_else(|| Error::File("the Backup was not read to its end".into()))?;
    Ok(FileCheck {
        header,
        trailer,
        run_as_is,
        bytes,
        sha256: hex(&sha),
        statements: t.statements,
        refused: t.refused,
        refused_more: t.refused_more,
        skipped: t.skipped,
        skipped_more: t.skipped_more,
        skipped_kinds: t.skipped_kinds,
        structure: t.structure,
        structure_total: t.structure_total,
        creates: structure_counts(t.counts),
        insert_count: t.insert_count,
        insert_rows: t.insert_rows,
        insert_shape: t.insert_shape,
        objects,
        types_and_sequences,
    })
}

/// The statements shown exactly (not a shape, not skipped unless Run as is, not
/// refused), in file order, from position `from` of that sequence: at most 100, cut and
/// labelled as the plan's first 50 are. Read from the file on demand.
pub fn structure_page(
    config: &ConnectionConfig,
    path: &Path,
    run_as_is: bool,
    from: u32,
) -> Result<Vec<ScriptStatement>> {
    if config.read_only {
        return Err(Error::ReadOnly(0));
    }
    let head = header_of(config, path)?;
    let mut r = ScriptReader::open(path, config.dialect, run_as_is)?;
    let mut w = Walker::new(config.dialect, head.as_ref().map(|(h, _)| h));
    let mut out = Vec::new();
    let mut at = 0u32;
    while out.len() < STATEMENTS_PAGE {
        let Some((s, facts)) = r.next_checked()? else {
            break;
        };
        if let Class::Exact = w.step(&s, &facts) {
            if at >= from {
                out.push(shown(config.dialect, &s));
            }
            at += 1;
        }
    }
    Ok(out)
}

/// The database Into and Replace write into: the dialog's, else the Connection's;
/// SQLite's is always `main`.
pub fn target_database(config: &ConnectionConfig, target: &RestoreTarget) -> Option<String> {
    if config.dialect == DialectKind::Sqlite {
        return Some("main".into());
    }
    target
        .database
        .clone()
        .or_else(|| config.database.clone())
        .filter(|d| !d.is_empty())
}

/// The schema a PostgreSQL Restore checks: the dialog's schema row, else the Backup's.
pub(crate) fn target_schema(
    target: &RestoreTarget,
    header: Option<&BackupHeader>,
) -> Option<String> {
    target
        .schema
        .clone()
        .or_else(|| header.and_then(|h| h.schema.clone()))
        .filter(|s| !s.is_empty())
}

/// Reads the target for the checks. `database` is where Into and Replace write (None on
/// a Connection row); `schema` is the PostgreSQL schema to check, and with None every
/// user schema is read (plain SQL). Catalog reads only.
pub async fn read_target(
    d: &dyn Dialect,
    config: &ConnectionConfig,
    database: Option<&str>,
    schema: Option<&str>,
) -> Result<TargetFacts> {
    let kind = config.dialect;
    let version = d.server_version().await?;
    let mut objects = Vec::new();
    if let Some(db) = database {
        match kind {
            DialectKind::Postgres => {
                let schemas: Vec<String> = match schema {
                    Some(s) => vec![s.to_string()],
                    None => d
                        .list_schemas(db)
                        .await?
                        .into_iter()
                        .filter(|s| !s.is_system)
                        .map(|s| s.name)
                        .collect(),
                };
                for s in schemas {
                    objects.extend(d.list_objects(db, Some(&s)).await?);
                }
            }
            _ => objects = d.list_objects(db, None).await?,
        }
    }
    let databases = if kind == DialectKind::Sqlite {
        Vec::new()
    } else {
        d.list_databases().await?
    };
    let mut facts = TargetFacts {
        version,
        database: database.map(str::to_string),
        schema: schema.map(str::to_string),
        objects,
        databases,
        ..TargetFacts::default()
    };
    match kind {
        DialectKind::Postgres => {
            let session = d.open_query_session(database).await?;
            let read = async {
                let extensions = first_column(
                    &session,
                    "SELECT extname::text FROM pg_catalog.pg_extension ORDER BY 1",
                )
                .await?;
                let (matviews, types, sequences) = match schema {
                    Some(s) => {
                        let s = sql_string(kind, s);
                        let matviews = first_column(
                            &session,
                            &format!(
                                "SELECT matviewname::text FROM pg_catalog.pg_matviews WHERE schemaname = {s}"
                            ),
                        )
                        .await?;
                        let types = first_column(&session, &types_sql(&s)).await?;
                        let sequences = first_column(&session, &sequences_sql(&s)).await?;
                        (matviews, types, sequences)
                    }
                    None => (Vec::new(), Vec::new(), Vec::new()),
                };
                Ok::<_, Error>((extensions, matviews, types, sequences))
            }
            .await;
            let _ = session.close().await;
            (
                facts.extensions,
                facts.materialized_views,
                facts.types,
                facts.sequences,
            ) = read?;
        }
        DialectKind::Sqlite => {
            let session = d.open_query_session(None).await?;
            let read = first_column(&session, "PRAGMA foreign_keys").await;
            let _ = session.close().await;
            facts.foreign_keys = read?.first().map(|v| v == "1");
        }
        DialectKind::MySql => {}
    }
    Ok(facts)
}

/// PostgreSQL types in schema `s` (an SQL literal) Replace may drop: enums, ranges and
/// standalone composite types (not a table's row type).
fn types_sql(s: &str) -> String {
    format!(
        "SELECT t.typname::text FROM pg_catalog.pg_type t \
         JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace \
         WHERE n.nspname = {s} AND (t.typtype IN ('e', 'r') OR (t.typtype = 'c' \
         AND EXISTS (SELECT 1 FROM pg_catalog.pg_class c \
         WHERE c.oid = t.typrelid AND c.relkind = 'c'))) ORDER BY 1"
    )
}

/// PostgreSQL sequences in schema `s` that no column owns (an identity's or a serial's
/// sequence goes with its table).
fn sequences_sql(s: &str) -> String {
    format!(
        "SELECT c.relname::text FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = {s} AND c.relkind = 'S' AND NOT EXISTS \
         (SELECT 1 FROM pg_catalog.pg_depend d \
         WHERE d.classid = 'pg_catalog.pg_class'::regclass \
         AND d.objid = c.oid AND d.deptype IN ('a', 'i')) ORDER BY 1"
    )
}

/// The first column of a small catalog read, as text.
async fn first_column(session: &SessionHandle, sql: &str) -> Result<Vec<String>> {
    let ExecOutcome::Rows { rows, .. } = session.execute(sql).await? else {
        return Ok(Vec::new());
    };
    Ok(rows
        .into_iter()
        .filter_map(|row| match row.into_iter().next() {
            Some(Cell::Text { value, .. }) | Some(Cell::Number { value }) => Some(value),
            _ => None,
        })
        .collect())
}

/// The leading numbers of a version (`16.4 (Debian ..)` is `[16, 4]`), cut to the
/// series that counts: PostgreSQL's major, MySQL's and SQLite's major and minor.
fn series(dialect: DialectKind, v: &str) -> Vec<u64> {
    let keep = if dialect == DialectKind::Postgres {
        1
    } else {
        2
    };
    v.trim()
        .split(|c: char| !c.is_ascii_digit() && c != '.')
        .next()
        .unwrap_or("")
        .split('.')
        .map_while(|p| p.parse().ok())
        .take(keep)
        .collect()
}

/// The warning when the target's series is older than the Backup's; None when it is the
/// same or newer, or either version cannot be read.
pub fn version_note(
    dialect: DialectKind,
    backup: &str,
    connection: &str,
    target: &str,
) -> Option<String> {
    let (b, t) = (series(dialect, backup), series(dialect, target));
    (!b.is_empty() && !t.is_empty() && t < b).then(|| {
        format!(
            "The backup is from {} {} and {connection} runs {}. Statements may fail.",
            dialect_label(dialect),
            backup.trim(),
            target.trim()
        )
    })
}

/// "1 table", "6 tables".
fn count_of(n: u64, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{} {many}", grouped(n))
    }
}

/// "a", "a and b", "a, b and c".
fn and_list(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

fn kind_words(kind: ObjectKind) -> (&'static str, &'static str) {
    match kind {
        ObjectKind::Table => ("table", "tables"),
        ObjectKind::View => ("view", "views"),
        ObjectKind::Function => ("function", "functions"),
        ObjectKind::Procedure => ("procedure", "procedures"),
        ObjectKind::Trigger => ("trigger", "triggers"),
    }
}

const KIND_ORDER: [ObjectKind; 5] = [
    ObjectKind::Table,
    ObjectKind::View,
    ObjectKind::Function,
    ObjectKind::Procedure,
    ObjectKind::Trigger,
];

/// "6 tables and 2 views".
fn objects_text(objects: &[ExistingObject]) -> String {
    let parts: Vec<String> = KIND_ORDER
        .iter()
        .filter_map(|k| {
            let n = objects.iter().filter(|o| o.kind == *k).count() as u64;
            let (one, many) = kind_words(*k);
            (n > 0).then(|| count_of(n, one, many))
        })
        .collect();
    and_list(&parts)
}

/// A target object's name as the file would write it: PostgreSQL lists functions with
/// their arguments.
fn bare_name(o: &DbObject) -> &str {
    match o.kind {
        ObjectKind::Function | ObjectKind::Procedure => o.name.split('(').next().unwrap_or(""),
        _ => o.name.as_str(),
    }
}

/// Whether the file creates an object that collides with `o`: tables and views share one
/// namespace; PostgreSQL functions and procedures share one; MySQL and SQLite triggers
/// are named per database. A PostgreSQL trigger belongs to its table, so dropping the
/// table drops it. On PostgreSQL with a known schema (R18) a file name qualified with
/// another schema never collides; an unqualified one counts as in that schema.
fn collides(
    dialect: DialectKind,
    schema: Option<&str>,
    o: &DbObject,
    file: &[(ObjectKind, Name)],
) -> bool {
    let pg = dialect == DialectKind::Postgres;
    if pg && o.kind == ObjectKind::Trigger {
        return false;
    }
    let group = |k: ObjectKind| match k {
        ObjectKind::Table | ObjectKind::View => 0,
        ObjectKind::Function if pg => 1,
        ObjectKind::Procedure if pg => 1,
        ObjectKind::Function => 2,
        ObjectKind::Procedure => 3,
        ObjectKind::Trigger => 4,
    };
    let name = bare_name(o);
    let in_schema = |n: &Name| match (pg, schema, n.len()) {
        (true, Some(s), len) if len >= 2 => n[len - 2] == s,
        _ => true,
    };
    file.iter().any(|(k, n)| {
        group(*k) == group(o.kind)
            && in_schema(n)
            && n.last().is_some_and(|last| loose_part(dialect, last, name))
    })
}

fn existing_objects(
    dialect: DialectKind,
    schema: Option<&str>,
    file: &[(ObjectKind, Name)],
    target: &TargetFacts,
) -> Vec<ExistingObject> {
    let mut out: Vec<ExistingObject> = target
        .objects
        .iter()
        .filter(|o| collides(dialect, schema, o, file))
        .map(|o| ExistingObject {
            kind: o.kind,
            name: o.name.clone(),
            rows: o.rows,
            materialized: o.kind == ObjectKind::View && target.materialized_views.contains(&o.name),
        })
        .collect();
    out.sort_by_key(|o| KIND_ORDER.iter().position(|k| *k == o.kind));
    out
}

/// The name messages use for the target database: SQLite's file name.
fn database_label(config: &ConnectionConfig, database: Option<&str>) -> String {
    if config.dialect == DialectKind::Sqlite {
        return config
            .file
            .as_ref()
            .and_then(|f| f.file_stem())
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| config.name.clone());
    }
    database.unwrap_or_default().to_string()
}

/// `<database>_restore_<mmdd>`, from the header's database (plain SQL: the target's);
/// on SQLite a new file of that name beside the target's.
fn default_name(config: &ConnectionConfig, database: &str, mmdd: &str) -> String {
    if config.dialect == DialectKind::Sqlite
        && let Some(file) = &config.file
    {
        let stem = file
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| database.to_string());
        let name = match file.extension() {
            Some(ext) => format!("{stem}_restore_{mmdd}.{}", ext.to_string_lossy()),
            None => format!("{stem}_restore_{mmdd}"),
        };
        return file.with_file_name(name).to_string_lossy().into_owned();
    }
    format!("{database}_restore_{mmdd}")
}

fn skipped_note(kinds: &[(String, u64)]) -> Option<String> {
    let total: u64 = kinds.iter().map(|(_, n)| n).sum();
    match kinds {
        [] => None,
        [(kind, 1)] => Some(format!(
            "1 {kind} statement is skipped. Tick Run as is to keep it."
        )),
        [(kind, n)] => Some(format!(
            "{} {kind} statements are skipped. Tick Run as is to keep them.",
            grouped(*n)
        )),
        _ => {
            let names: Vec<&str> = kinds.iter().map(|(k, _)| k.as_str()).collect();
            Some(format!(
                "{} statements are skipped ({}). Tick Run as is to keep them.",
                grouped(total),
                names.join(", ")
            ))
        }
    }
}

/// `mmdd` of a `YYYY-MM-DD` date.
pub fn mmdd_of(date: &str) -> String {
    date.get(5..7).unwrap_or("01").to_string() + date.get(8..10).unwrap_or("01")
}

/// The check from the file pass and the target reads. `today` (`YYYY-MM-DD`) dates the
/// default name and the Back up first file.
pub fn build_check(
    config: &ConnectionConfig,
    path: &Path,
    file: FileCheck,
    target: &TargetFacts,
    today: &str,
) -> RestoreCheck {
    let dialect = config.dialect;
    let header = file.header;
    let db_label = database_label(config, target.database.as_deref());
    let refused_total = file.refused.len() as u64 + file.refused_more;
    let statements_line = if refused_total == 0 {
        format!(
            "{} read, none refused",
            count_of(file.statements, "statement", "statements")
        )
    } else {
        format!(
            "{} read, {} refused",
            count_of(file.statements, "statement", "statements"),
            grouped(refused_total)
        )
    };
    let schema = target
        .schema
        .clone()
        .or_else(|| header.as_ref().and_then(|h| h.schema.clone()));
    let existing = existing_objects(dialect, schema.as_deref(), &file.objects, target);
    let existing_types = same_named(&schema, &file.types_and_sequences, false, &target.types);
    let existing_sequences =
        same_named(&schema, &file.types_and_sequences, true, &target.sequences);
    let existing_note = (!existing.is_empty()).then(|| {
        format!(
            "{db_label} already has {} with these names",
            objects_text(&existing)
        )
    });
    let missing_extensions: Vec<String> = match &header {
        Some(h) if dialect == DialectKind::Postgres => h
            .not_included
            .iter()
            .filter_map(|item| item.strip_prefix("extension "))
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty() && !target.extensions.iter().any(|e| e == name))
            .collect(),
        _ => Vec::new(),
    };
    let extension_notes = missing_extensions
        .iter()
        .map(|e| {
            format!(
                "{e} is not installed on {}. Functions that use it will fail.",
                config.name
            )
        })
        .collect();
    let has_database = target.database.is_some();
    let target_empty = has_database && target.objects.is_empty();
    let empty_note = (has_database && !target_empty).then(|| format!("{db_label} is not empty"));
    let replace_note = (dialect == DialectKind::Postgres && has_database && schema.is_none())
        .then(|| "Open Restore on a schema to replace its tables.".to_string());
    let name_base = match &header {
        Some(h) => h.database.clone(),
        None if db_label.is_empty() => "restore".to_string(),
        None => db_label.clone(),
    };
    RestoreCheck {
        path: path.to_path_buf(),
        header: header.as_ref().map(RestoreHeader::of),
        bytes: file.bytes,
        sha256: file.sha256,
        target_name: config.name.clone(),
        target_dialect: dialect,
        target_version: target.version.clone(),
        dialect_ok: header.as_ref().is_none_or(|h| h.dialect == dialect),
        version_note: header
            .as_ref()
            .and_then(|h| version_note(dialect, &h.server_version, &config.name, &target.version)),
        statements: file.statements,
        refused: file.refused,
        skipped: file.skipped,
        existing_tables: existing
            .iter()
            .filter(|o| o.kind == ObjectKind::Table)
            .map(|o| o.name.clone())
            .collect(),
        target_empty,
        missing_extensions,
        trailer_ok: file.trailer.is_some(),
        refused_more: file.refused_more,
        skipped_more: file.skipped_more,
        existing_objects: existing,
        dialect_line: format!(
            "Same Dialect as {}: {}",
            config.name,
            dialect_label(dialect)
        ),
        statements_line,
        skipped_note: skipped_note(&file.skipped_kinds),
        existing_note,
        extension_notes,
        empty_note,
        replace_note,
        default_name: default_name(config, &name_base, &mmdd_of(today)),
        target_database: target.database.clone(),
        run_as_is: file.run_as_is,
        structure: file.structure,
        structure_total: file.structure_total,
        creates: file.creates,
        insert_count: file.insert_count,
        insert_rows: file.insert_rows,
        insert_shape: file.insert_shape,
        backup_header: header,
        schema,
        existing_types,
        existing_sequences,
        file_objects: file.objects,
        databases: target.databases.clone(),
        foreign_keys: target.foreign_keys,
        today: today.to_string(),
    }
}

/// The target's types (`sequence` false) or sequences that the file creates again, by
/// exact name in the known schema (an unqualified file name counts as in it).
fn same_named(
    schema: &Option<String>,
    file: &[(bool, Name)],
    sequence: bool,
    target: &[String],
) -> Vec<String> {
    let Some(schema) = schema else {
        return Vec::new();
    };
    target
        .iter()
        .filter(|t| {
            file.iter().any(|(seq, n)| {
                *seq == sequence
                    && n.last() == Some(*t)
                    && (n.len() < 2 || n[n.len() - 2] == *schema)
            })
        })
        .cloned()
        .collect()
}

/// "Line 2,041: DROP DATABASE is not run by Restore." for each refused statement, and a
/// count of those past the list.
pub fn refusals(check: &RestoreCheck) -> Vec<String> {
    let mut out: Vec<String> = check
        .refused
        .iter()
        .map(|r| {
            format!(
                "Line {}: {} is not run by Restore.",
                grouped(r.line),
                r.kind
            )
        })
        .collect();
    match check.refused_more {
        0 => {}
        1 => out.push("1 more statement is refused.".into()),
        n => out.push(format!("{} more statements are refused.", grouped(n))),
    }
    out
}

/// `BackupRefused` with the first refusal, for a start that finds one.
pub fn refusal_error(check: &RestoreCheck) -> Option<Error> {
    refusals(check).into_iter().next().map(refused_err)
}

/// An object name for a DROP: PostgreSQL's qualified with the schema, a function with the
/// arguments the target listed.
fn drop_name(dialect: DialectKind, schema: Option<&str>, o: &ExistingObject) -> String {
    let bare = match o.kind {
        ObjectKind::Function | ObjectKind::Procedure => o.name.split('(').next().unwrap_or(""),
        _ => o.name.as_str(),
    };
    let mut name = match (dialect, schema) {
        (DialectKind::Postgres, Some(s)) => format!("{}.{}", quote_double(s), quote_double(bare)),
        _ => sql_ident(dialect, bare),
    };
    if dialect == DialectKind::Postgres
        && matches!(o.kind, ObjectKind::Function | ObjectKind::Procedure)
        && let Some(args) = o.name.get(bare.len()..)
    {
        name.push_str(args);
    }
    name
}

/// Every DROP for Replace: triggers, views, materialized views, functions, procedures,
/// then tables; on PostgreSQL views, materialized views, tables, functions, procedures,
/// then standalone sequences and types (R29). PostgreSQL drops each kind in one
/// statement, so objects that depend on each other go together; MySQL and SQLite run
/// with Foreign Key checks off and drop one by one.
///
/// Which existing objects one DROP word takes.
type Pick = fn(&ExistingObject) -> bool;

fn drops(
    dialect: DialectKind,
    schema: Option<&str>,
    existing: &[ExistingObject],
    types: &[String],
    sequences: &[String],
) -> Vec<String> {
    let mut groups: [(&str, Pick); 6] = [
        ("TRIGGER", |o| o.kind == ObjectKind::Trigger),
        ("VIEW", |o| o.kind == ObjectKind::View && !o.materialized),
        ("MATERIALIZED VIEW", |o| {
            o.kind == ObjectKind::View && o.materialized
        }),
        ("FUNCTION", |o| o.kind == ObjectKind::Function),
        ("PROCEDURE", |o| o.kind == ObjectKind::Procedure),
        ("TABLE", |o| o.kind == ObjectKind::Table),
    ];
    // PostgreSQL records a table's triggers, defaults and checks as depending on the
    // functions they call, so its tables go before its functions (R29); a function
    // records no dependency on the tables its body names.
    if dialect == DialectKind::Postgres {
        groups[3..].rotate_right(1);
    }
    let mut out = Vec::new();
    for (word, pick) in groups {
        let list: Vec<String> = existing
            .iter()
            .filter(|o| pick(o))
            .map(|o| drop_name(dialect, schema, o))
            .collect();
        if list.is_empty() {
            continue;
        }
        let together = dialect == DialectKind::Postgres
            && matches!(word, "TABLE" | "VIEW" | "MATERIALIZED VIEW");
        if together {
            out.push(format!("DROP {word} {}", list.join(", ")));
        } else {
            out.extend(list.into_iter().map(|n| format!("DROP {word} {n}")));
        }
    }
    // R29, PostgreSQL: the sequences and column types the tables used go after them.
    if dialect == DialectKind::Postgres {
        let q = |n: &String| match schema {
            Some(s) => format!("{}.{}", quote_double(s), quote_double(n)),
            None => quote_double(n),
        };
        for (word, names) in [("SEQUENCE", sequences), ("TYPE", types)] {
            if !names.is_empty() {
                let list: Vec<String> = names.iter().map(q).collect();
                out.push(format!("DROP {word} {}", list.join(", ")));
            }
        }
    }
    out
}

/// What Contura runs around the file (R15): the CREATE DATABASE on its own, the writer's
/// session setup, what runs after the file, and the cleanup after a failure.
struct Frame {
    create_database: Option<String>,
    setup: Vec<String>,
    after: Vec<String>,
    cleanup: Vec<String>,
}

fn frame(dialect: DialectKind, mode: &RestoreMode, foreign_keys: Option<bool>) -> Frame {
    let new_db = match mode {
        RestoreMode::NewDatabase { name } if dialect != DialectKind::Sqlite => {
            Some(sql_ident(dialect, name.trim()))
        }
        _ => None,
    };
    let (setup, after): (Vec<String>, Vec<String>) = match dialect {
        DialectKind::MySql => (vec!["SET FOREIGN_KEY_CHECKS = 0".into()], Vec::new()),
        DialectKind::Postgres => (vec!["BEGIN".into()], vec!["COMMIT".into()]),
        DialectKind::Sqlite => {
            let mut after = vec!["PRAGMA foreign_key_check".into(), "COMMIT".into()];
            if let Some(on) = foreign_keys {
                after.push(format!(
                    "PRAGMA foreign_keys = {}",
                    if on { "ON" } else { "OFF" }
                ));
            }
            (
                vec!["PRAGMA foreign_keys = OFF".into(), "BEGIN".into()],
                after,
            )
        }
    };
    Frame {
        create_database: new_db.as_ref().map(|db| format!("CREATE DATABASE {db}")),
        setup,
        after,
        cleanup: new_db
            .map(|db| vec![format!("DROP DATABASE {db}")])
            .unwrap_or_default(),
    }
}

fn planned(dialect: DialectKind, text: String) -> PlannedStatement {
    PlannedStatement {
        class: classify(dialect, &text),
        text,
        by_assistant: false,
        reason: None,
    }
}

/// SHA-256 over the target (Connection, database, schema), the mode with its new name,
/// Run as is, the file's path, size and SHA-256, and every statement or file Contura adds
/// (CREATE DATABASE, setup, drops, after, cleanup, the Back up first file), through step
/// 7's `job_fingerprint`.
pub fn restore_fingerprint(
    connection_id: ConnectionId,
    database: Option<String>,
    schema: Option<String>,
    req: &RestoreRequest,
    file: FileIdentity,
    added: serde_json::Value,
) -> Result<[u8; 32]> {
    job_fingerprint(&JobPlan {
        kind: JobKind::Restore,
        connection_id,
        database,
        schema,
        table: None,
        options: serde_json::json!({
            "mode": req.mode,
            "runAsIs": req.run_as_is,
            "added": added,
        }),
        mapping: Vec::new(),
        template: String::new(),
        file: Some(file),
    })
}

/// The plan from the request and the check made for it. Read-only refuses with
/// `ReadOnly(0)`; a check read with the other Run as is choice is `InvalidInput`. The
/// verdict is Blocked by refused statements or a mode the target does not allow, then
/// NeedsConfirmation on Production, else Ok (the SQL is shown either way).
pub fn build_plan(
    config: &ConnectionConfig,
    req: &RestoreRequest,
    check: &RestoreCheck,
) -> Result<RestorePlan> {
    if config.read_only {
        return Err(Error::ReadOnly(0));
    }
    if req.run_as_is != check.run_as_is {
        return Err(Error::InvalidInput(
            "The file was checked with the other Run as is choice. Check it again.".into(),
        ));
    }
    let dialect = config.dialect;
    let schema = check.schema.clone();
    let db_label = database_label(config, check.target_database.as_deref());
    let mut reasons = refusals(check);
    let mode = match &req.mode {
        RestoreMode::NewDatabase { name } => RestoreMode::NewDatabase {
            name: name.trim().to_string(),
        },
        other => other.clone(),
    };
    let (written, into_line) = match &mode {
        RestoreMode::NewDatabase { name } => {
            if name.is_empty() {
                reasons.push("Name the new database.".into());
            } else if dialect == DialectKind::Sqlite {
                if Path::new(name).exists() {
                    reasons.push(format!("{name} already exists. Choose a new file."));
                }
            } else if check.databases.iter().any(|d| loose_part(dialect, d, name)) {
                reasons.push(format!("{name} already exists. Choose another name."));
            }
            (Some(name.clone()), format!("Into {name}"))
        }
        RestoreMode::IntoEmpty => {
            if check.target_database.is_none() {
                reasons.push("Choose a database to restore into.".into());
            } else if let Some(note) = &check.empty_note {
                reasons.push(note.clone());
            }
            (check.target_database.clone(), format!("Into {db_label}"))
        }
        RestoreMode::Replace { .. } => {
            if check.target_database.is_none() {
                reasons.push("Choose a database to restore into.".into());
            } else if let Some(note) = &check.replace_note {
                reasons.push(note.clone());
            }
            (
                check.target_database.clone(),
                format!(
                    "Replace the {} in {db_label}",
                    count_of(check.creates.tables, "table", "tables")
                ),
            )
        }
    };
    let replace = matches!(mode, RestoreMode::Replace { .. });
    let frame = frame(dialect, &mode, check.foreign_keys);
    let drop_list = if replace && check.replace_note.is_none() {
        drops(
            dialect,
            schema.as_deref(),
            &check.existing_objects,
            &check.existing_types,
            &check.existing_sequences,
        )
    } else {
        Vec::new()
    };
    let delete_file = match &mode {
        RestoreMode::NewDatabase { name } if dialect == DialectKind::Sqlite && !name.is_empty() => {
            Some(PathBuf::from(name))
        }
        _ => None,
    };
    // Nothing is dropped when Replace is blocked for want of a schema (R18).
    let dropped_tables: Vec<&ExistingObject> = check
        .existing_objects
        .iter()
        .filter(|o| o.kind == ObjectKind::Table && check.replace_note.is_none())
        .collect();
    let replaced_rows: Option<u64> = (replace && !dropped_tables.is_empty())
        .then(|| {
            dropped_tables
                .iter()
                .map(|o| o.rows)
                .try_fold(0u64, |sum, r| r.map(|r| sum + r))
        })
        .flatten();
    let mysql_replace = replace && dialect == DialectKind::MySql;
    let backup_first_path = match &mode {
        RestoreMode::Replace { backup_first: true }
            if mysql_replace && !dropped_tables.is_empty() =>
        {
            let dir = req.path.parent().unwrap_or(Path::new(""));
            Some(
                dir.join(format!(
                    "{db_label}-before-restore-{}.sql",
                    super::plan::local_date(req.local_date.as_deref()).unwrap_or(&check.today)
                ))
                .to_string_lossy()
                .into_owned(),
            )
        }
        _ => None,
    };
    let file = FileIdentity {
        path: req.path.clone(),
        bytes: check.bytes,
        sha256: check.sha256.clone(),
    };
    let fp = restore_fingerprint(
        config.id,
        check.target_database.clone(),
        schema,
        &RestoreRequest {
            mode: mode.clone(),
            ..req.clone()
        },
        file,
        serde_json::json!({
            "createDatabase": frame.create_database,
            "setup": frame.setup,
            "drops": drop_list,
            "after": frame.after,
            "cleanup": frame.cleanup,
            "backupFirstPath": backup_first_path,
        }),
    )?;
    let fingerprint = hex(&fp);

    // The count line.
    let c = check.creates;
    let made: Vec<String> = [
        (c.tables, "table", "tables"),
        (c.indexes, "index", "indexes"),
        (c.foreign_keys, "Foreign Key", "Foreign Keys"),
    ]
    .iter()
    .filter(|(n, _, _)| *n > 0)
    .map(|(n, one, many)| count_of(*n, one, many))
    .collect();
    let made = and_list(&made);
    let mut steps: Vec<String> = Vec::new();
    match &mode {
        RestoreMode::NewDatabase { name } => {
            steps.push(format!("Creates {name}"));
            if !made.is_empty() {
                steps.push(made.clone());
            }
        }
        RestoreMode::Replace { .. } if !check.existing_objects.is_empty() => {
            steps.push(format!("Drops {}", objects_text(&check.existing_objects)));
            if !made.is_empty() {
                steps.push(format!("creates {made}"));
            }
        }
        _ => {
            if !made.is_empty() {
                steps.push(format!("Creates {made}"));
            }
        }
    }
    if check.insert_count > 0 {
        let runs = format!(
            "runs {} ({})",
            count_of(check.insert_count, "INSERT statement", "INSERT statements"),
            count_of(check.insert_rows, "row", "rows")
        );
        steps.push(if steps.is_empty() {
            capitalized(&runs)
        } else {
            runs
        });
    }
    let count_line = if steps.is_empty() {
        format!(
            "Runs {}. All of it writes.",
            count_of(check.structure_total, "statement", "statements")
        )
    } else {
        format!("{}. All of it writes.", steps.join(", then "))
    };

    let cleanup_line = match &mode {
        RestoreMode::NewDatabase { name } if !name.is_empty() => {
            Some(if dialect == DialectKind::Sqlite {
                format!("If the restore fails or is cancelled: delete {name}")
            } else {
                format!("If the restore fails or is cancelled: DROP DATABASE {name}")
            })
        }
        _ => None,
    };
    let some_dropped = replace && !dropped_tables.is_empty();
    let replace_banner = some_dropped.then(|| {
        let tables = count_of(dropped_tables.len() as u64, "table", "tables");
        let with_rows = match replaced_rows {
            Some(r) => format!(" with {}", count_of(r, "row", "rows")),
            None => String::new(),
        };
        format!(
            "Replace drops {tables} in {db_label}{with_rows}. Tables in {db_label} that the file does not hold are left alone."
        )
    });
    let mysql_replace_note = mysql_replace.then(|| {
        "MySQL cannot undo DROP TABLE. If the restore fails, the dropped tables are gone."
            .to_string()
    });
    let backup_first_line = (mysql_replace && some_dropped).then(|| {
        format!(
            "Back up these {} first",
            count_of(dropped_tables.len() as u64, "table", "tables")
        )
    });
    let mode_line = match (&mode, dialect) {
        (RestoreMode::NewDatabase { name }, DialectKind::MySql) => format!(
            "MySQL commits each CREATE as it runs. Cancel stops after the current statement and removes {name}."
        ),
        (RestoreMode::NewDatabase { name }, _) => {
            format!("One transaction. Cancel rolls back and removes {name}.")
        }
        (_, DialectKind::MySql) => {
            "MySQL commits each CREATE as it runs. Cancel stops after the current statement.".into()
        }
        _ => "One transaction. Cancel rolls back.".into(),
    };

    let verdict = if !reasons.is_empty() {
        JobVerdict::Blocked { reasons }
    } else if config.production {
        JobVerdict::NeedsConfirmation {
            connection: config.name.clone(),
            database: written.clone(),
            fingerprint: fingerprint.clone(),
            file_bytes: check.bytes,
            file_sha256: check.sha256.clone(),
        }
    } else {
        JobVerdict::Ok
    };

    let to_planned = |v: Vec<String>| -> Vec<PlannedStatement> {
        v.into_iter().map(|t| planned(dialect, t)).collect()
    };
    Ok(RestorePlan {
        setup: to_planned(frame.setup),
        drops: to_planned(drop_list),
        structure: check.structure.clone(),
        structure_total: check.structure_total,
        creates: check.creates,
        insert_count: check.insert_count,
        insert_rows: check.insert_rows,
        insert_shape: check.insert_shape.clone(),
        after: to_planned(frame.after),
        cleanup: frame.cleanup,
        replaced_rows,
        backup_first_tables: if backup_first_path.is_some() {
            dropped_tables.iter().map(|o| o.name.clone()).collect()
        } else {
            Vec::new()
        },
        backup_first_path,
        mode_line,
        fingerprint,
        verdict,
        mode,
        create_database: frame.create_database.map(|t| planned(dialect, t)),
        database: written,
        delete_file,
        into_line,
        count_line,
        cleanup_line,
        replace_banner,
        mysql_replace_note,
        backup_first_line,
        danger: replace || check.backup_header.as_ref().is_some_and(|h| h.drop_tables),
        one_transaction: dialect != DialectKind::MySql,
        bytes: check.bytes,
        sha256: check.sha256.clone(),
    })
}

fn capitalized(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn blocking_err(e: tokio::task::JoinError) -> Error {
    Error::File(format!("the Restore check's file reader stopped: {e}"))
}

/// The whole check without progress or cancel: the file pass on a blocking thread, then
/// the target reads. The checks dialog runs [`inspect_file`] as a job with progress
/// instead, then [`read_target`] and [`build_check`].
pub async fn inspect_restore(
    d: Arc<dyn Dialect>,
    config: ConnectionConfig,
    target: RestoreTarget,
    path: PathBuf,
    run_as_is: bool,
) -> Result<RestoreCheck> {
    let (cfg, p) = (config.clone(), path.clone());
    let file = tokio::task::spawn_blocking(move || {
        inspect_file(&cfg, &p, run_as_is, &|| false, &mut |_, _| {})
    })
    .await
    .map_err(blocking_err)??;
    check_target(d.as_ref(), &config, &target, &path, file).await
}

/// The check from a file pass: the target reads, then [`build_check`] dated today (UTC).
pub async fn check_target(
    d: &dyn Dialect,
    config: &ConnectionConfig,
    target: &RestoreTarget,
    path: &Path,
    file: FileCheck,
) -> Result<RestoreCheck> {
    let database = target_database(config, target);
    let schema = match config.dialect {
        DialectKind::Postgres => target_schema(target, file.header.as_ref()),
        _ => None,
    };
    let facts = read_target(d, config, database.as_deref(), schema.as_deref()).await?;
    Ok(build_check(
        config,
        path,
        file,
        &facts,
        &crate::dbml_writer::today_utc(),
    ))
}

/// A finished Restore (the `restore` field of its job report).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RestoreOutcome {
    /// The database restored into (SQLite: the file path).
    pub database: String,
    pub tables: u64,
    pub rows: u64,
    /// Every row count matched the file header (false for plain SQL, which has none).
    pub counts_match: bool,
    /// SQLite Into a new database: the new file, for "Add it as a Connection" (R4).
    pub new_file: Option<String>,
}

/// Checks the file and the target again for `req` and builds its plan.
pub async fn plan_restore(
    d: Arc<dyn Dialect>,
    config: ConnectionConfig,
    req: RestoreRequest,
) -> Result<RestorePlan> {
    if config.read_only {
        return Err(Error::ReadOnly(0));
    }
    let check = inspect_restore(
        d,
        config.clone(),
        req.target.clone(),
        req.path.clone(),
        req.run_as_is,
    )
    .await?;
    build_plan(&config, &req, &check)
}

/// `restore_statements(req, from)`: [`structure_page`] on a blocking thread.
pub async fn restore_statements(
    config: ConnectionConfig,
    req: RestoreRequest,
    from: u32,
) -> Result<Vec<ScriptStatement>> {
    tokio::task::spawn_blocking(move || structure_page(&config, &req.path, req.run_as_is, from))
        .await
        .map_err(blocking_err)?
}
