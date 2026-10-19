//! What a Backup holds (spec "Backup (dialog)"): the request and plan that cross IPC, the
//! five "What goes in" ticks applied to the structure items, and the file's header.
//! Pure: the same inputs always give the same script.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::data::{BackupScript, RowsTable, TableFacts};
use super::format::{BackupHeader, Content, FORMAT_VERSION, made_by};
use super::structure::{StructureItem, StructureKind as K, StructureParts};
use crate::common::{pg_string, sql_ident};
use crate::model::{ConnectionId, DialectKind};

/// The five ticks of "What goes in".
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct BackupInclude {
    /// Tables, columns and keys, with checks and generated columns.
    pub tables: bool,
    /// Indexes and Foreign Keys. On MySQL they live inside `CREATE TABLE` (ruling R8),
    /// so they go with the tables there.
    pub indexes: bool,
    /// Enums and sequences.
    pub enums: bool,
    /// Views, functions, procedures and triggers.
    pub definitions: bool,
    pub rows: bool,
}

impl Default for BackupInclude {
    fn default() -> Self {
        Self {
            tables: true,
            indexes: true,
            enums: true,
            definitions: true,
            rows: true,
        }
    }
}

impl BackupInclude {
    /// Without tables, nothing that needs them: indexes, views and triggers (with the
    /// routines of the same tick), rows. With tables, what they cannot do without:
    /// PostgreSQL enums and sequences (ruling R21), MySQL indexes and Foreign Keys, which
    /// live inside CREATE TABLE (ruling R8).
    pub fn effective(self, dialect: DialectKind) -> Self {
        if !self.tables {
            return Self {
                indexes: false,
                definitions: false,
                rows: false,
                ..self
            };
        }
        match dialect {
            DialectKind::Postgres => Self {
                enums: true,
                ..self
            },
            DialectKind::MySql => Self {
                indexes: true,
                ..self
            },
            DialectKind::Sqlite => self,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum BackupFormat {
    /// Contura's SQL script.
    #[default]
    Script,
    /// SQLite only: an exact copy of the file, made with `VACUUM INTO`.
    FileCopy,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct BackupRequest {
    pub connection_id: ConnectionId,
    /// MySQL database, SQLite `main`, PostgreSQL database.
    pub database: String,
    /// PostgreSQL: the schema backed up.
    pub schema: Option<String>,
    pub include: BackupInclude,
    pub format: BackupFormat,
    /// 100, 500 or 1,000.
    pub rows_per_statement: u32,
    pub add_drop_tables: bool,
    /// The final file; the job writes `<path>.partial` and renames it.
    pub path: String,
    /// The user's local date, `yyyy-mm-dd`, for the default file name (ruling R25).
    /// Absent or malformed, the UTC date is used.
    pub local_date: Option<String>,
    /// Internal (R30): only these tables (by the names Task 2 reads), their structure,
    /// triggers and rows; views and routines are left out. Restore's "Back up these
    /// tables first" sets it to the tables Replace drops. Never sent over Tauri.
    #[serde(skip)]
    pub tables: Option<Vec<String>>,
}

impl Default for BackupRequest {
    fn default() -> Self {
        Self {
            connection_id: ConnectionId::nil(),
            database: String::new(),
            schema: None,
            include: BackupInclude::default(),
            format: BackupFormat::Script,
            rows_per_statement: 500,
            add_drop_tables: false,
            path: String::new(),
            local_date: None,
            tables: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct BackupCounts {
    pub tables: u64,
    pub indexes: u64,
    pub foreign_keys: u64,
    pub enums: u64,
    pub sequences: u64,
    pub views: u64,
    /// Functions and procedures.
    pub functions: u64,
    pub triggers: u64,
    pub rows: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct BackupPlan {
    pub dialect: DialectKind,
    pub counts: BackupCounts,
    /// Phrases for the Not included banner: "the pgcrypto extension", "grants and roles".
    pub not_included: Vec<String>,
    pub estimate_bytes: u64,
    /// MySQL tables outside the snapshot (MyISAM and other non-transactional engines).
    pub non_snapshot_tables: Vec<String>,
    /// `<database>-<yyyy-mm-dd>.sql` (the SQLite file copy: `.sqlite`).
    pub default_file_name: String,
}

impl Default for BackupPlan {
    fn default() -> Self {
        Self {
            dialect: DialectKind::MySql,
            counts: BackupCounts::default(),
            not_included: Vec::new(),
            estimate_bytes: 0,
            non_snapshot_tables: Vec::new(),
            default_file_name: String::new(),
        }
    }
}

/// The rows per INSERT the dialog offers.
pub const ROWS_PER_STATEMENT: [u32; 3] = [100, 500, 1_000];

/// The refusal for any other rows per INSERT.
pub const ROWS_PER_STATEMENT_REFUSAL: &str = "Rows per INSERT must be 100, 500 or 1,000.";

/// The rows per INSERT the request asks for, once checked to be one the dialog offers.
pub fn rows_per_statement(n: u32) -> crate::error::Result<usize> {
    if ROWS_PER_STATEMENT.contains(&n) {
        Ok(n as usize)
    } else {
        Err(crate::error::Error::InvalidInput(
            ROWS_PER_STATEMENT_REFUSAL.into(),
        ))
    }
}

/// `date` when it reads as `yyyy-mm-dd`, else None.
pub fn local_date(date: Option<&str>) -> Option<&str> {
    let d = date?.trim();
    let b = d.as_bytes();
    let ok = b.len() == 10
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        });
    ok.then_some(d)
}

/// The dialog's counts, from the structure and the tables' rows.
pub fn counts(parts: &StructureParts, tables: &[TableFacts]) -> BackupCounts {
    let c = parts.counts;
    BackupCounts {
        tables: c.tables.into(),
        indexes: c.indexes.into(),
        foreign_keys: c.foreign_keys.into(),
        enums: c.enums.into(),
        sequences: c.sequences.into(),
        views: c.views.into(),
        functions: u64::from(c.functions) + u64::from(c.procedures),
        triggers: c.triggers.into(),
        rows: tables.iter().map(|t| t.rows).sum(),
    }
}

/// A header item as the Not included banner says it: `extension pgcrypto` is "the
/// pgcrypto extension"; the rest read as they are.
pub fn not_included_phrase(item: &str) -> String {
    match item.strip_prefix("extension ") {
        Some(name) => format!("the {name} extension"),
        None => item.to_string(),
    }
}

/// `<base>-<yyyy-mm-dd>.sql`, or `.sqlite` for the file copy, with characters Windows
/// refuses in a file name replaced.
pub fn default_file_name(base: &str, date: &str, format: BackupFormat) -> String {
    let clean: String = base
        .chars()
        .map(|c| {
            if c.is_control() || r#"<>:"/\|?*"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let clean = clean.trim().trim_end_matches('.');
    let base = if clean.is_empty() { "backup" } else { clean };
    let ext = match format {
        BackupFormat::Script => "sql",
        BackupFormat::FileCopy => "sqlite",
    };
    format!("{base}-{date}.{ext}")
}

/// Days since 1970-01-01 as (year, month, day), proleptic Gregorian.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// UTC `2026-10-16T22:00:00Z` and `2026-10-16` for `secs` since the Unix epoch.
pub fn utc_stamp(secs: i64) -> (String, String) {
    let days = secs.div_euclid(86_400);
    let rest = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let date = format!("{y:04}-{m:02}-{d:02}");
    let time = format!(
        "{date}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    );
    (time, date)
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// What the header's `contents` line lists for these ticks.
fn contents(dialect: DialectKind, inc: BackupInclude) -> Vec<Content> {
    let mut out = Vec::new();
    // Inside CREATE TABLE on MySQL (indexes and Foreign Keys) and SQLite (Foreign Keys).
    let indexes_inline = dialect == DialectKind::MySql;
    let keys_inline = dialect != DialectKind::Postgres;
    if inc.tables {
        out.push(Content::Tables);
    }
    if inc.indexes || (inc.tables && indexes_inline) {
        out.push(Content::Indexes);
    }
    if inc.indexes || (inc.tables && keys_inline) {
        out.push(Content::ForeignKeys);
    }
    if inc.enums {
        out.push(Content::Enums);
        out.push(Content::Sequences);
    }
    if inc.definitions {
        out.push(Content::Views);
        out.push(Content::Routines);
        out.push(Content::Triggers);
    }
    if inc.tables {
        out.push(Content::Checks);
        out.push(Content::Generated);
    }
    if inc.rows {
        out.push(Content::Rows);
    }
    out
}

/// The table as the file names it: PostgreSQL `"billing"."customers"`, MySQL
/// `` `customers` ``, SQLite `"customers"`, exactly as its CREATE TABLE does.
pub fn table_sql(dialect: DialectKind, schema: Option<&str>, table: &str) -> String {
    match (dialect, schema) {
        (DialectKind::Postgres, Some(s)) => {
            format!("{}.{}", sql_ident(dialect, s), sql_ident(dialect, table))
        }
        _ => sql_ident(dialect, table),
    }
}

/// The table as the header's `rows:` line and the section markers name it:
/// `billing.customers` on PostgreSQL, the bare name elsewhere.
pub fn table_label(dialect: DialectKind, schema: Option<&str>, table: &str) -> String {
    match (dialect, schema) {
        (DialectKind::Postgres, Some(s)) => format!("{s}.{table}"),
        _ => table.to_string(),
    }
}

/// The span of a `"a"."b"` name at the start of `s`, as written.
fn quoted_pair(s: &str) -> Option<&str> {
    fn ident(b: &[u8], mut i: usize) -> Option<usize> {
        if b.get(i) != Some(&b'"') {
            return None;
        }
        i += 1;
        while i < b.len() {
            if b[i] == b'"' {
                if b.get(i + 1) == Some(&b'"') {
                    i += 2;
                    continue;
                }
                return Some(i + 1);
            }
            i += 1;
        }
        None
    }
    let b = s.as_bytes();
    let first = ident(b, 0)?;
    if b.get(first) != Some(&b'.') {
        return None;
    }
    let end = ident(b, first + 1)?;
    Some(&s[..end])
}

/// Which items the ticks keep, item by item.
struct Keeper<'a> {
    inc: BackupInclude,
    kept_tables: HashSet<&'a str>,
    /// R30: only items of these tables (settings and schemas too).
    only: Option<HashSet<&'a str>>,
    /// The PostgreSQL sequences the file creates: by `CREATE SEQUENCE`, and by an
    /// identity column (`SEQUENCE NAME` in its table's CREATE).
    sequences: HashSet<String>,
}

impl<'a> Keeper<'a> {
    fn base(&self, kind: K, after_rows: bool) -> bool {
        let i = self.inc;
        match kind {
            K::Setting => !after_rows || i.definitions,
            K::Schema | K::UserVersion => true,
            K::Enum | K::Sequence => i.enums,
            K::Function | K::Procedure | K::View | K::Trigger => i.definitions,
            K::Table | K::Constraint | K::Check => i.tables,
            K::OwnedBy => i.tables && i.enums,
            K::Index | K::ForeignKey => i.indexes,
            // Decided by what precedes it or by its sequence.
            K::Comment | K::Setval => true,
        }
    }

    fn setval(&self, item: &StructureItem) -> bool {
        match item.sql.strip_prefix("SELECT pg_catalog.setval(") {
            // PostgreSQL: only for a sequence the file creates.
            Some(_) => self.sequences.iter().any(|q| {
                item.sql
                    .starts_with(&format!("SELECT pg_catalog.setval({}, ", pg_string(q)))
            }),
            // SQLite `sqlite_sequence`: with its table.
            None => item
                .table
                .as_deref()
                .is_none_or(|t| self.kept_tables.contains(t)),
        }
    }

    /// R30: with a table filter, an item of another table, or one with no table that is
    /// not a setting or schema (views, routines, enums), is left out.
    fn in_only(&self, item: &StructureItem) -> bool {
        let Some(only) = &self.only else {
            return true;
        };
        match (&item.table, item.kind) {
            (Some(t), _) => only.contains(t.as_str()),
            (None, K::Setting | K::Schema | K::UserVersion | K::Comment) => true,
            (None, _) => false,
        }
    }

    fn note(&mut self, item: &'a StructureItem) {
        match item.kind {
            K::Table => {
                if let Some(t) = &item.table {
                    self.kept_tables.insert(t);
                }
                let mut rest = item.sql.as_str();
                while let Some(at) = rest.find("(SEQUENCE NAME ") {
                    rest = &rest[at + "(SEQUENCE NAME ".len()..];
                    if let Some(q) = quoted_pair(rest) {
                        self.sequences.insert(q.to_string());
                    }
                }
            }
            K::Sequence => {
                if let Some(q) = item
                    .sql
                    .strip_prefix("CREATE SEQUENCE ")
                    .and_then(quoted_pair)
                {
                    self.sequences.insert(q.to_string());
                }
            }
            _ => {}
        }
    }

    /// The kept items of one section, in order. A comment goes with the item before it.
    fn section(&mut self, items: &'a [StructureItem], after_rows: bool) -> Vec<&'a StructureItem> {
        let mut out = Vec::new();
        let mut last_kept = true;
        for item in items {
            let keep = match item.kind {
                K::Comment => last_kept,
                K::Setval => self.setval(item),
                k => self.base(k, after_rows),
            } && self.in_only(item);
            if item.kind != K::Comment {
                last_kept = keep;
            }
            if keep {
                self.note(item);
                out.push(item);
            }
        }
        out
    }
}

/// Everything the request asks of the structure Task 2 read, as `write_script` writes
/// it. `facts` follows `parts.tables`; `database` is the header's name for it.
pub fn build_script(
    dialect: DialectKind,
    req: &BackupRequest,
    database: &str,
    parts: &StructureParts,
    facts: &[TableFacts],
    server_version: &str,
    taken_at: String,
) -> BackupScript {
    let inc = req.include.effective(dialect);
    let schema = match dialect {
        DialectKind::Postgres => req.schema.as_deref(),
        _ => None,
    };
    let mut keeper = Keeper {
        inc,
        kept_tables: HashSet::new(),
        sequences: HashSet::new(),
        only: req
            .tables
            .as_ref()
            .map(|t| t.iter().map(String::as_str).collect()),
    };
    let drop_tables = req.add_drop_tables && inc.tables;
    let mut structure = Vec::new();
    for item in keeper.section(&parts.before_rows, false) {
        if drop_tables
            && item.kind == K::Table
            && let Some(t) = &item.table
        {
            structure.push(format!(
                "DROP TABLE IF EXISTS {};",
                table_sql(dialect, schema, t)
            ));
        }
        structure.push(item.sql.clone());
    }
    let settings = keeper
        .section(&parts.settings, false)
        .into_iter()
        .map(|i| i.sql.clone())
        .collect();
    let after_rows = keeper
        .section(&parts.after_rows, true)
        .into_iter()
        .map(|i| i.sql.clone())
        .collect();
    let finish = keeper
        .section(&parts.finish, false)
        .into_iter()
        .map(|i| i.sql.clone())
        .collect();

    let tables: Vec<RowsTable> = if inc.rows {
        facts
            .iter()
            .filter(|f| {
                req.tables
                    .as_ref()
                    .is_none_or(|only| only.contains(&f.name))
            })
            .map(|f| RowsTable {
                name: f.name.clone(),
                label: table_label(dialect, schema, &f.name),
                table_sql: table_sql(dialect, schema, &f.name),
                rows: f.rows,
            })
            .collect()
    } else {
        Vec::new()
    };

    let header = BackupHeader {
        format: FORMAT_VERSION,
        made_by: made_by(),
        dialect,
        server_version: server_version.to_string(),
        database: database.to_string(),
        schema: schema.map(str::to_string),
        taken_at,
        contents: contents(dialect, inc),
        rows: tables.iter().map(|t| (t.label.clone(), t.rows)).collect(),
        not_included: parts.not_included.clone(),
        definer_removed: parts.definer_removed && inc.definitions,
        drop_tables,
    };

    BackupScript {
        dialect,
        header,
        settings,
        structure,
        tables,
        after_rows,
        finish,
        // Checked when the job starts; 500 for a request that was not.
        rows_per_statement: rows_per_statement(req.rows_per_statement).unwrap_or(500),
    }
}

#[cfg(test)]
#[path = "plan_tests.rs"]
mod tests;
