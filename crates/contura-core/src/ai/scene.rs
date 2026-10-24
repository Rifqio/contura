//! The This tab item: what the active tab shows, sent as typed fields by the UI and
//! rendered here, part by part, at the Ask's AI access. No part holds row data: no cell,
//! filter value, default literal or file row goes at any level.

use serde::{Deserialize, Serialize};

use crate::ai::AiAccess;
use crate::ai::context::cards::comment;
use crate::ai::rails::input::rank;
use crate::ai::request::TableRef;
use crate::common::grouped;
use crate::compare::diff::{DiffKind, DiffObject};
use crate::design::{ColumnDraft, ForeignKeyDraft, IndexDraft};
use crate::model::{DialectKind, ObjectKind, ObjectPath, SortSpec};
use crate::safety::mask_literals;
use crate::transfer::{IfExists, TransferMode};
use crate::visual_query::{
    Aggregate, FilterOp, GroupBy, JoinKind, SortDir, SortTarget, VisualQuery, VqColumn,
};

/// The rendered This tab item's cap; the where line is never cut.
pub const TAB_CAP: usize = 8 * 1024;
/// The most characters of any one name; a longer one is cut and ends with `…`.
const NAME_CHARS: usize = 128;
/// List caps, first N in screen order, then `(+<n> more)`.
const CANVAS_TABLES: usize = 30;
const TICKED_COLUMNS: usize = 200;
const JOINS: usize = 50;
const FILTERS: usize = 50;
const SORTS: usize = 50;
const HIDDEN_COLUMNS: usize = 20;
const FILTER_COLUMNS: usize = 50;
const DIFF_LINES: usize = 300;
const TRANSFER_COLUMNS: usize = 500;
const FILE_COLUMNS: usize = 200;
const TYPES: usize = 80;
const REMOVED_COLUMNS: usize = 200;
const OUTLINE_NAMES: usize = 300;
const OUTLINE_BYTES: usize = 4 * 1024;
const NEIGHBOURS: usize = 30;
const CARD_TABLES: usize = 30;
const NOTES: usize = 50;
/// The summary the turn stamp keeps (spec 6.1).
const SUMMARY_BYTES: usize = crate::ai::memory::ASKED_IN_SUMMARY_BYTES;
/// The draft columns a design summary names.
const SUMMARY_COLUMNS: usize = 40;
/// The ticked Data Transfer tables listed.
const TRANSFER_TABLES: usize = 500;

fn yes() -> bool {
    true
}

/// What the active tab shows, as the UI publishes it. A closed enum: an unknown `kind`
/// fails the request, so no partial context is ever sent.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AskTab {
    Query {
        title: String,
    },
    /// Table data, or a view, routine or trigger tab.
    Object {
        title: String,
        path: ObjectPath,
        object: ObjectKind,
        sort: Option<SortSpec>,
        /// The row filters' column names; never their values.
        filter_columns: Vec<String>,
        hidden: Vec<String>,
        pending_edits: u32,
    },
    Visual {
        title: String,
        model: VisualQuery,
        sql_written: bool,
        problems: u32,
        last_run: Option<RunCount>,
    },
    /// Table Designer, or New table when `create`.
    Design {
        create: bool,
        path: ObjectPath,
        columns: Vec<ColumnDraft>,
        primary: Vec<String>,
        indexes: Vec<IndexDraft>,
        foreign_keys: Vec<ForeignKeyDraft>,
        removed: Vec<String>,
        comment: Option<String>,
        /// The Dialect's type list the designer offers.
        types: Vec<String>,
    },
    Schema {
        file: String,
        tables: u32,
        error_line: Option<u32>,
    },
    Compare {
        source: CompareSide,
        target_database: String,
        items: Vec<DiffLine>,
        added: u32,
        removed: u32,
        changed: u32,
        not_compared: u32,
        ticked: u32,
        /// False until a result is in: no counts, items or ticks are rendered, so none is made up.
        #[serde(default = "yes")]
        compared: bool,
    },
    Transfer {
        source_database: String,
        /// Empty until a target is chosen.
        target_database: String,
        /// `None` until a plan exists: no mode is claimed for a plan that is not made yet.
        #[serde(default)]
        mode: Option<TransferMode>,
        /// The ticked tables.
        tables: Vec<TransferLine>,
        /// The plan's mapping notes, typed: their text can name values (a default, set
        /// members), so only the Core's words for each kind go.
        notes: Vec<TransferNote>,
    },
    /// The file's rows are never part of this: they are not database rows.
    Import {
        file: String,
        format: String,
        delimiter: Option<String>,
        encoding: String,
        target: ImportInto,
        header: Vec<String>,
        /// File column to target column; `None` skips it.
        mapping: Vec<(String, Option<String>)>,
        rows_estimate: Option<u64>,
    },
    Lineage {
        path: ObjectPath,
        neighbours: Vec<String>,
    },
    SavedQueries,
    Home,
    Settings {
        section: SettingsPage,
    },
}

/// Mirrors `SettingsSection` in `src/shell/tabs.ts`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SettingsPage {
    General,
    Appearance,
    Editor,
    Keymap,
    Ai,
    DataFolder,
    Updates,
    About,
}

/// A Visual Query's last run: a row count, `more` when the page was full.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunCount {
    pub rows: u64,
    pub more: bool,
    pub failed: bool,
}

/// A Compare source as the This tab names it: a database, or a Schema Model file. Lighter
/// than `connections::compare::CompareSide`, which carries the whole model.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CompareSide {
    Database { database: String },
    Model { file: String },
}

/// One Compare item, in tree order. Typed, so no default or enum value can ride along in
/// a free detail text.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffKind,
    pub object: DiffObject,
    pub table: String,
    /// The column, index or key name; the table's for a table item.
    pub name: String,
    pub from_type: Option<String>,
    pub to_type: Option<String>,
    pub loses_data: bool,
    /// The data-loss count, when it was read.
    pub loses_rows: Option<u64>,
}

/// One ticked Data Transfer table.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferLine {
    pub source: String,
    pub target: String,
    pub exists: bool,
    pub if_exists: IfExists,
    pub columns: Vec<TransferColumn>,
    /// The rows Empty it first deletes, when the plan has the estimate.
    pub emptied_rows: Option<u64>,
}

/// A Data Transfer mapping note, as `transfer::MappingNote` without its text.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferNote {
    pub table: String,
    pub column: Option<String>,
    pub kind: TransferNoteKind,
}

/// Mirrors `transfer::NoteKind` with no payload.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferNoteKind {
    Info,
    New,
    NeedsChoice,
    NoMatch,
    Lossy,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferColumn {
    pub name: String,
    pub target_name: String,
    pub source_type: String,
    pub target_type: String,
}

/// Where an Import goes: a table, or a database where it makes a new one.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ImportInto {
    Table {
        path: ObjectPath,
    },
    Database {
        database: String,
        schema: Option<String>,
    },
}

/// The This tab item as it goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TabText {
    /// The first line, gated: `Visual Query "Orders over 1M" in shop`.
    pub where_line: String,
    /// The where line and the other lines, at most `TAB_CAP` bytes.
    pub text: String,
    /// The first facts joined with `; `, at most 400 bytes; empty for some kinds. It is
    /// the summary when every line goes; the stamp keeps `sent_summary` instead.
    pub summary: String,
    /// Each fact of the summary with the lines of `text` it comes from (0 is the where
    /// line): a fact goes into the stamp only when all of them went.
    pub facts: Vec<(Vec<usize>, String)>,
    /// The highest level any part used: 0 with no Connection, else 1 to 3.
    pub used: u8,
    /// The tables the tab shows, as hints for the cards.
    pub tables: Vec<TableRef>,
}

/// The lines of one tab as they are built, gated at `level`.
struct Scene {
    level: u8,
    used: u8,
    lines: Vec<String>,
    /// The bytes of `lines`; past `TAB_CAP` a line is only counted in `dropped`, so the
    /// Core holds O(cap) whatever the request carries.
    bytes: usize,
    dropped: usize,
    /// The summary's facts, each with the line numbers it comes from (see `TabText`).
    facts: Vec<(Vec<usize>, String)>,
    tables: Vec<TableRef>,
}

impl Scene {
    /// Whether a part that needs `need` may go; marks the level used when it may.
    fn reaches(&mut self, need: u8) -> bool {
        let ok = self.level >= need;
        if ok {
            self.used = self.used.max(need);
        }
        ok
    }

    /// Adds `line` when the level reaches `need`; its line number when it was kept.
    fn line(&mut self, need: u8, line: String) -> Option<usize> {
        if self.reaches(need) {
            self.push(line)
        } else {
            None
        }
    }

    /// Its line number in the text (the where line is 0), or `None` past `TAB_CAP`.
    fn push(&mut self, line: String) -> Option<usize> {
        // Fact line numbers count the lines of the text: one pushed line is one line.
        debug_assert!(!line.contains('\n'), "a This tab line holds a line break");
        if self.bytes + line.len() + 1 > TAB_CAP {
            self.dropped += 1;
            None
        } else {
            self.bytes += line.len() + 1;
            self.lines.push(line);
            Some(self.lines.len())
        }
    }

    /// A summary fact from the lines `from`; one whose line was not kept is no fact.
    fn fact(&mut self, from: &[Option<usize>], fact: String) {
        if let Some(from) = from.iter().copied().collect::<Option<Vec<usize>>>() {
            self.facts.push((from, fact));
        }
    }

    fn table(&mut self, schema: Option<&str>, name: &str) {
        let t = TableRef {
            schema: schema.map(str::to_string),
            name: name.to_string(),
        };
        if !name.is_empty() && self.tables.len() < CARD_TABLES && !self.tables.contains(&t) {
            self.tables.push(t);
        }
    }
}

/// A name on one line, cut at 128 characters with `…` added.
pub(crate) fn name(s: &str) -> String {
    let one: String = s
        .chars()
        .map(|c| {
            // Line and paragraph separators read as line breaks too.
            if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') {
                ' '
            } else {
                c
            }
        })
        .collect();
    if one.chars().count() <= NAME_CHARS {
        return one;
    }
    let mut out: String = one.chars().take(NAME_CHARS).collect();
    out.push('…');
    out
}

/// `(+<n> more)`.
pub(crate) fn more(n: usize) -> String {
    format!("(+{} more)", grouped(n as u64))
}

/// The first `max` of `items`, each through `f`, joined with `, `, then ` (+<n> more)`.
/// Only the first `max` are mapped, so a long list costs O(max).
fn list_of<T>(items: impl IntoIterator<Item = T>, max: usize, f: impl Fn(T) -> String) -> String {
    let mut items = items.into_iter();
    let mut out = items
        .by_ref()
        .take(max)
        .map(f)
        .collect::<Vec<_>>()
        .join(", ");
    let rest = items.count();
    if rest > 0 {
        out.push(' ');
        out.push_str(&more(rest));
    }
    out
}

/// Names, at most `max`.
fn names(items: &[String], max: usize) -> String {
    list_of(items, max, |s| name(s))
}

/// `<kind>[ "<title>"][ in <database>[.<schema>]]`.
fn where_line(
    kind: &str,
    title: Option<&str>,
    database: Option<&str>,
    schema: Option<&str>,
) -> String {
    let mut out = kind.to_string();
    if let Some(t) = title.filter(|t| !t.is_empty()) {
        out.push_str(&format!(" \"{}\"", name(t)));
    }
    if let Some(d) = database.filter(|d| !d.is_empty()) {
        out.push_str(" in ");
        out.push_str(&name(d));
        if let Some(s) = schema.filter(|s| !s.is_empty()) {
            out.push('.');
            out.push_str(&name(s));
        }
    }
    out
}

/// `schema.name`, or `database.name` where there is no schema.
fn qualified(path: &ObjectPath) -> String {
    let scope = path.schema.as_deref().unwrap_or(&path.database);
    if scope.is_empty() {
        name(&path.name)
    } else {
        format!("{}.{}", name(scope), name(&path.name))
    }
}

/// The file's base name: never the folder it is in.
fn base_name(file: &str) -> String {
    name(file.rsplit(['/', '\\']).next().unwrap_or(file))
}

pub(crate) fn count(n: u64, one: &str, many: &str) -> String {
    format!("{} {}", grouped(n), if n == 1 { one } else { many })
}

fn dialect_words(d: DialectKind) -> &'static str {
    match d {
        DialectKind::MySql => "MySQL",
        DialectKind::Postgres => "PostgreSQL",
        DialectKind::Sqlite => "SQLite",
    }
}

fn settings_words(page: SettingsPage) -> &'static str {
    match page {
        SettingsPage::General => "General",
        SettingsPage::Appearance => "Appearance",
        SettingsPage::Editor => "Editor",
        SettingsPage::Keymap => "Keymap",
        SettingsPage::Ai => "AI assistant",
        SettingsPage::DataFolder => "Data folder",
        SettingsPage::Updates => "Updates",
        SettingsPage::About => "About Contura",
    }
}

/// A default with every literal masked by the Dialect's own lexer: each number token is
/// `?` (`1e5`, `0x1F`, the `0` of `0::numeric`), each string `'…'`, and a double-quoted
/// string `"…"` where double quotes can hold one (MySQL, SQLite, no Dialect). Comments
/// are dropped first, so no note in a default goes. Names and calls stay: `now()`.
fn default_masked(sql: &str, dialect: Option<DialectKind>) -> String {
    let lexer = dialect.unwrap_or(DialectKind::MySql);
    let masked = mask_literals(lexer, &strip_comments(sql, lexer));
    // The lexer reads SQLite's double quotes as a name; SQLite stores an unknown one as
    // text, so it is masked as a string.
    let masked = if lexer == DialectKind::Sqlite {
        mask_quotes(&masked, true, false)
    } else {
        masked
    };
    name(&masked.split_whitespace().collect::<Vec<_>>().join(" "))
}

/// `sql` without its comments (`--` and, on MySQL, `#` to the line end, `/* */`), each
/// replaced by a space; quoted text is read past whole, so a `--` in a string stays. A line
/// comment ends at the LF, and on PostgreSQL at a lone CR too, as the safety lexer reads it.
fn strip_comments(sql: &str, dialect: DialectKind) -> String {
    let mysql = dialect == DialectKind::MySql;
    let pg = dialect == DialectKind::Postgres;
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if matches!(c, '\'' | '"' | '`') {
            let end = quoted_end(&chars, i + 1, c, mysql && c != '`');
            out.extend(&chars[i..end]);
            i = end;
        } else if let Some(tag) = (pg && c == '$').then(|| dollar_tag(&chars, i)).flatten() {
            // A dollar-quoted body is read past whole; unclosed, it runs to the end.
            let opener = &chars[i..i + tag];
            let end = (i + tag..chars.len())
                .find(|&k| chars[k..].starts_with(opener))
                .map_or(chars.len(), |k| k + tag);
            out.extend(&chars[i..end]);
            i = end;
        } else if (c == '-' && next == Some('-')) || (mysql && c == '#') {
            while i < chars.len() && chars[i] != '\n' && !(pg && chars[i] == '\r') {
                i += 1;
            }
            out.push(' ');
        } else if c == '/' && next == Some('*') {
            // PostgreSQL nests block comments; the others close at the first `*/`.
            let mut depth = 0;
            while i < chars.len() {
                if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                    if depth == 0 || pg {
                        depth += 1;
                    }
                    i += 2;
                } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    i += 2;
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            out.push(' ');
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// The length of the `$tag$` opener at `i` (`$$` included), if one starts there.
fn dollar_tag(chars: &[char], i: usize) -> Option<usize> {
    let len = chars[i + 1..]
        .iter()
        .take_while(|c| c.is_alphanumeric() || **c == '_')
        .count();
    let starts_with_digit = chars.get(i + 1).is_some_and(char::is_ascii_digit);
    (chars.get(i + 1 + len) == Some(&'$') && !starts_with_digit).then_some(len + 2)
}

/// The end (exclusive) of the quoted run whose body starts at `from`: a doubled quote,
/// or with `backslash` a `\` and the char after it, stays inside. Unclosed runs to the end.
fn quoted_end(chars: &[char], mut j: usize, quote: char, backslash: bool) -> usize {
    while j < chars.len() {
        if backslash && chars[j] == '\\' {
            j += 2;
        } else if chars[j] == quote {
            if chars.get(j + 1) == Some(&quote) {
                j += 2;
            } else {
                return j + 1;
            }
        } else {
            j += 1;
        }
    }
    chars.len()
}

/// Whether double quotes may hold a string: everywhere but PostgreSQL, where they quote
/// a name. SQLite reads an unknown double-quoted name as a string, so it counts.
fn double_quoted_strings(dialect: Option<DialectKind>) -> bool {
    dialect != Some(DialectKind::Postgres)
}

/// A type as the tab names it: quoted enum and set values are masked (single quotes
/// always, double quotes with `double`, backslash escapes read off PostgreSQL); its
/// numbers (`decimal(14,2)`) stay.
fn type_text(sql: &str, double: bool) -> String {
    let one = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    name(&mask_quotes(&one, double, double))
}

/// `text` with each single-quoted run, and each double-quoted one with `double`, as
/// `'…'` or `"…"`. A doubled quote, and with `backslash` an escaped one, stays inside.
pub(crate) fn mask_quotes(text: &str, double: bool, backslash: bool) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\'' || (double && c == '"') {
            i = quoted_end(&chars, i + 1, c, backslash);
            out.push(c);
            out.push('…');
            out.push(c);
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// A referential action from the closed list; anything else is not repeated.
fn action_word(a: &str) -> Option<&'static str> {
    match a.trim().to_ascii_lowercase().as_str() {
        "cascade" => Some("cascade"),
        "restrict" => Some("restrict"),
        "set null" => Some("set null"),
        "set default" => Some("set default"),
        "no action" => Some("no action"),
        _ => None,
    }
}

/// A short plain word (a format or encoding name), else `None`.
fn plain(word: &str, max: usize) -> Option<&str> {
    let w = word.trim();
    (!w.is_empty()
        && w.len() <= max
        && w.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    .then_some(w)
}

fn delimiter_word(d: &str) -> &'static str {
    match d {
        "," => "comma",
        ";" => "semicolon",
        "\t" => "tab",
        "|" => "pipe",
        " " => "space",
        _ => "other",
    }
}

/// The text at `level`; `None` when nothing of it may go (a Connection at L0, or a
/// database tab with no Connection). `access: None` means no Connection (Home, Settings,
/// an untied Schema Model). `database` and `schema` are the Ask's, for the tabs whose
/// fields do not name them. `outline` is the design tab's table names from the stored AI
/// Context. `clean` cleans comments and Core-written notes before they are cut.
pub fn tab_text(
    tab: &AskTab,
    access: Option<AiAccess>,
    database: Option<&str>,
    schema: Option<&str>,
    dialect: Option<DialectKind>,
    outline: &[String],
    clean: &dyn Fn(&str) -> String,
) -> Option<TabText> {
    let connected = match access {
        Some(a) if rank(a) == 0 => return None,
        Some(_) => true,
        None => false,
    };
    let mut s = Scene {
        level: access.map_or(0, rank),
        used: 0,
        lines: Vec::new(),
        bytes: 0,
        dropped: 0,
        facts: Vec::new(),
        tables: Vec::new(),
    };
    let where_line = match tab {
        AskTab::Home => "Home".to_string(),
        AskTab::SavedQueries => "Saved Queries list".to_string(),
        AskTab::Settings { section } => format!("Settings, {}", settings_words(*section)),
        AskTab::Schema {
            file,
            tables,
            error_line,
        } => {
            let file = base_name(file);
            let line = if connected {
                let title = s.reaches(2).then_some(file.as_str());
                s.reaches(1);
                where_line("Schema Builder", title, database, schema)
            } else {
                where_line("Schema Builder", Some(&file), None, None)
            };
            let tables = count(u64::from(*tables), "table", "tables");
            let at = s.push(tables.clone());
            s.fact(&[at], format!("model with {tables}"));
            if let Some(n) = error_line {
                s.push(format!("DBML error on line {}", grouped(u64::from(*n))));
            }
            line
        }
        _ if !connected => return None,
        AskTab::Query { title } => {
            s.reaches(1);
            let title = s.reaches(2).then_some(title.as_str());
            where_line("Query tab", title, database, schema)
        }
        AskTab::Object {
            title: _,
            path,
            object,
            sort,
            filter_columns,
            hidden,
            pending_edits,
        } => object_tab(
            &mut s,
            path,
            *object,
            sort,
            filter_columns,
            hidden,
            *pending_edits,
        ),
        AskTab::Visual {
            title,
            model,
            sql_written,
            problems,
            last_run,
        } => visual_tab(
            &mut s,
            title,
            model,
            database,
            schema,
            *sql_written,
            *problems,
            *last_run,
        ),
        AskTab::Design { .. } => design_tab(&mut s, tab, dialect, outline, clean),
        AskTab::Compare { .. } => compare_tab(&mut s, tab),
        AskTab::Transfer {
            source_database,
            target_database,
            mode,
            tables,
            notes,
        } => {
            s.reaches(1);
            // No card hints: the source tables are not in the Ask's (target) Context.
            transfer_lines(&mut s, tables, *mode, notes);
            if target_database.is_empty() {
                format!(
                    "Data Transfer {}, no target chosen yet",
                    name(source_database)
                )
            } else {
                format!(
                    "Data Transfer {} to {}",
                    name(source_database),
                    name(target_database)
                )
            }
        }
        AskTab::Import { .. } => import_tab(&mut s, tab),
        AskTab::Lineage { path, neighbours } => {
            s.reaches(1);
            s.table(path.schema.as_deref(), &path.name);
            for n in neighbours {
                s.table(path.schema.as_deref(), n);
            }
            if !neighbours.is_empty() {
                s.line(1, format!("neighbours: {}", names(neighbours, NEIGHBOURS)));
            }
            where_line(
                "Lineage",
                Some(&path.name),
                Some(&path.database),
                path.schema.as_deref(),
            )
        }
    };
    let (text, kept) = capped(&where_line, &s.lines, s.dropped);
    // Only facts whose lines are in the text.
    s.facts.retain(|(from, _)| from.iter().all(|n| *n <= kept));
    let facts: Vec<String> = s.facts.iter().map(|(_, f)| f.clone()).collect();
    Some(TabText {
        where_line,
        text,
        summary: summary(&facts),
        facts: s.facts,
        used: s.used,
        tables: s.tables,
    })
}

fn object_tab(
    s: &mut Scene,
    path: &ObjectPath,
    object: ObjectKind,
    sort: &Option<SortSpec>,
    filter_columns: &[String],
    hidden: &[String],
    pending_edits: u32,
) -> String {
    s.reaches(1);
    let kind = match object {
        ObjectKind::Table => "Table data",
        ObjectKind::View => "View",
        ObjectKind::Procedure => "Procedure",
        ObjectKind::Function => "Function",
        ObjectKind::Trigger => "Trigger",
    };
    let line = where_line(
        kind,
        Some(&path.name),
        Some(&path.database),
        path.schema.as_deref(),
    );
    match object {
        ObjectKind::Table | ObjectKind::View => {
            s.table(path.schema.as_deref(), &path.name);
            let word = if object == ObjectKind::Table {
                "table"
            } else {
                "view"
            };
            s.fact(&[Some(0)], format!("{word} {}", qualified(path)));
        }
        _ => return line,
    }
    // Grid state: a table's data tab only.
    if object != ObjectKind::Table {
        return line;
    }
    if let Some(sort) = sort {
        let dir = if sort.descending { "desc" } else { "asc" };
        let sorted = format!("sorted by {} {dir}", name(&sort.column));
        let at = s.line(1, sorted.clone());
        s.fact(&[at], sorted);
    }
    if !filter_columns.is_empty() {
        let filtered = format!("filtered on {}", names(filter_columns, FILTER_COLUMNS));
        let at = s.line(1, filtered.clone());
        s.fact(&[at], filtered);
    }
    if !hidden.is_empty() {
        s.line(
            1,
            format!("hidden columns: {}", names(hidden, HIDDEN_COLUMNS)),
        );
    }
    if pending_edits > 0 {
        let edits = if pending_edits == 1 {
            "1 Pending Edit not saved".to_string()
        } else {
            format!(
                "{} Pending Edits not saved",
                grouped(u64::from(pending_edits))
            )
        };
        s.line(2, edits);
    }
    line
}

fn aggregate_text(a: Aggregate, col: &str) -> String {
    match a {
        Aggregate::Count => format!("count({col})"),
        Aggregate::CountDistinct => format!("count(distinct {col})"),
        Aggregate::Sum => format!("sum({col})"),
        Aggregate::Avg => format!("avg({col})"),
        Aggregate::Min => format!("min({col})"),
        Aggregate::Max => format!("max({col})"),
    }
}

/// The operator word, never its operand.
fn op_word(op: FilterOp) -> &'static str {
    match op {
        FilterOp::Eq => "=",
        FilterOp::Ne => "<>",
        FilterOp::Lt => "<",
        FilterOp::Le => "<=",
        FilterOp::Gt => ">",
        FilterOp::Ge => ">=",
        FilterOp::Like => "like",
        FilterOp::NotLike => "not like",
        FilterOp::In => "in",
        FilterOp::NotIn => "not in",
        FilterOp::Between => "between",
        FilterOp::IsNull => "is null",
        FilterOp::IsNotNull => "is not null",
    }
}

fn join_word(kind: JoinKind) -> &'static str {
    match kind {
        JoinKind::Inner => "inner",
        JoinKind::Left => "left",
        JoinKind::Right => "right",
        JoinKind::Full => "full",
    }
}

#[allow(clippy::too_many_arguments)]
fn visual_tab(
    s: &mut Scene,
    title: &str,
    model: &VisualQuery,
    database: Option<&str>,
    schema: Option<&str>,
    sql_written: bool,
    problems: u32,
    last_run: Option<RunCount>,
) -> String {
    s.reaches(1);
    let titled = s.reaches(2).then_some(title);
    let line = where_line(
        "Visual Query",
        titled,
        model.database.as_deref().or(database),
        schema,
    );
    // A card is named by its alias, else by its table.
    let label = |id: &str| {
        model
            .tables
            .iter()
            .find(|t| t.id == id)
            .map(|t| {
                name(if t.alias.is_empty() {
                    &t.name
                } else {
                    &t.alias
                })
            })
            .unwrap_or_default()
    };
    let col = |table: &str, column: &str| format!("{}.{}", label(table), name(column));

    let tick = |c: &VqColumn| {
        let r = col(&c.table, &c.column);
        c.aggregate.map_or(r.clone(), |a| aggregate_text(a, &r))
    };
    let named = || model.filters.iter().filter(|f| !f.column.is_empty());

    for t in &model.tables {
        s.table(t.schema.as_deref(), &t.name);
    }
    if !model.tables.is_empty() {
        let fact = format!(
            "tables {}",
            list_of(&model.tables, CANVAS_TABLES, |t| name(&t.name))
        );
        let tables = list_of(&model.tables, CANVAS_TABLES, |t| {
            let mut out = match &t.schema {
                Some(sc) => format!("{}.{}", name(sc), name(&t.name)),
                None => name(&t.name),
            };
            if !t.alias.is_empty() && t.alias != t.name {
                out.push(' ');
                out.push_str(&name(&t.alias));
            }
            out
        });
        let at = s.line(1, format!("tables: {tables}"));
        s.fact(&[at], fact);
    }
    if !model.columns.is_empty() {
        let ticked = list_of(&model.columns, TICKED_COLUMNS, tick);
        let at = s.line(1, format!("ticked: {ticked}"));
        s.fact(&[at], format!("ticked {ticked}"));
    }
    if model.joins.iter().any(|j| !j.on.is_empty()) {
        let joins = list_of(
            model.joins.iter().filter(|j| !j.on.is_empty()),
            JOINS,
            |j| {
                let on: Vec<String> =
                    j.on.iter()
                        .take(JOINS)
                        .map(|p| {
                            format!(
                                "{} = {}",
                                col(&j.left, &p.left_column),
                                col(&j.right, &p.right_column)
                            )
                        })
                        .collect();
                format!("{} ({})", on.join(" and "), join_word(j.kind))
            },
        );
        s.line(1, format!("joins: {joins}"));
    }
    if named().next().is_some() {
        let fact = format!(
            "filters on {}",
            list_of(named(), FILTERS, |f| col(&f.table, &f.column))
        );
        let filters = list_of(named(), FILTERS, |f| {
            format!("{} {}", col(&f.table, &f.column), op_word(f.op))
        });
        let at = s.line(1, format!("filters on: {filters}"));
        s.fact(&[at], fact);
    }
    if let GroupBy::Manual { columns } = &model.group_by
        && !columns.is_empty()
    {
        let cols = list_of(columns, TICKED_COLUMNS, |c| col(&c.table, &c.column));
        s.line(1, format!("group by: {cols}"));
    }
    if !model.order_by.is_empty() {
        let sorts = list_of(&model.order_by, SORTS, |o| {
            let target = match &o.target {
                SortTarget::Output { index } => {
                    model.columns.get(*index).map(tick).unwrap_or_default()
                }
                SortTarget::Column { table, column } => col(table, column),
            };
            let dir = if o.dir == SortDir::Desc {
                "desc"
            } else {
                "asc"
            };
            format!("{target} {dir}")
        });
        s.line(1, format!("order by: {sorts}"));
    }
    if model.limit.is_some() {
        s.line(1, "limit: yes".into());
    }
    if model.distinct {
        s.line(1, "distinct: yes".into());
    }
    let sql = if problems > 0 {
        format!(
            "SQL: not written yet ({})",
            count(u64::from(problems), "problem", "problems")
        )
    } else if sql_written {
        "SQL: written".into()
    } else {
        "SQL: not written yet".into()
    };
    s.line(2, sql);
    if let Some(run) = last_run
        && s.reaches(2)
    {
        let ran = if run.failed {
            "failed".to_string()
        } else if run.more {
            format!("{}+ rows", grouped(run.rows))
        } else {
            count(run.rows, "row", "rows")
        };
        let at = s.push(format!("last run: {ran}"));
        s.fact(&[at], format!("last run {ran}"));
    }
    line
}

fn column_line(
    c: &ColumnDraft,
    dialect: Option<DialectKind>,
    clean: &dyn Fn(&str) -> String,
) -> String {
    let mut out = format!(
        "column {} {} {}",
        name(&c.name),
        type_text(&c.type_sql, double_quoted_strings(dialect)),
        if c.nullable { "null" } else { "not null" }
    );
    if let Some(d) = c.default_sql.as_deref().filter(|d| !d.trim().is_empty()) {
        out.push_str(" default ");
        out.push_str(&default_masked(d, dialect));
    }
    if c.increment {
        out.push_str(" increment");
    }
    if let Some(text) = c.comment.as_deref().map(|t| comment(t, clean))
        && !text.is_empty()
    {
        out.push_str(&format!(" comment \"{text}\""));
    }
    out
}

fn index_line(i: &IndexDraft) -> String {
    format!(
        "index {} ({}){}",
        name(&i.name),
        names(&i.columns, TICKED_COLUMNS),
        if i.unique { " unique" } else { "" }
    )
}

fn foreign_key_line(f: &ForeignKeyDraft) -> String {
    let mut out = format!(
        "foreign key ({}) references {} ({})",
        names(&f.columns, TICKED_COLUMNS),
        qualified(&f.target),
        names(&f.target_columns, TICKED_COLUMNS)
    );
    if let Some(a) = f.on_delete.as_deref().and_then(action_word) {
        out.push_str(" on delete ");
        out.push_str(a);
    }
    if let Some(a) = f.on_update.as_deref().and_then(action_word) {
        out.push_str(" on update ");
        out.push_str(a);
    }
    out
}

/// `tables in shop: a, b (+n more)`: at most 300 names and 4 KB.
fn outline_line(database: &str, outline: &[String]) -> String {
    let head = format!("tables in {}: ", name(database));
    let mut out = head.clone();
    let mut shown = 0;
    for n in outline.iter().take(OUTLINE_NAMES) {
        let n = name(n);
        // Room for the name, its comma and a `(+n more)` tail.
        if out.len() + n.len() + 2 + 24 > OUTLINE_BYTES {
            break;
        }
        if shown > 0 {
            out.push_str(", ");
        }
        out.push_str(&n);
        shown += 1;
    }
    if outline.len() > shown {
        if shown > 0 {
            out.push(' ');
        }
        out.push_str(&more(outline.len() - shown));
    }
    out
}

fn design_tab(
    s: &mut Scene,
    tab: &AskTab,
    dialect: Option<DialectKind>,
    outline: &[String],
    clean: &dyn Fn(&str) -> String,
) -> String {
    let AskTab::Design {
        create,
        path,
        columns,
        primary,
        indexes,
        foreign_keys,
        removed,
        comment: table_comment,
        types,
    } = tab
    else {
        unreachable!("design_tab takes a design tab")
    };
    s.reaches(1);
    let kind = if *create {
        "New table"
    } else {
        "Table Designer"
    };
    let line = where_line(
        kind,
        Some(&path.name),
        Some(&path.database),
        path.schema.as_deref(),
    );
    if !create {
        s.table(path.schema.as_deref(), &path.name);
    }
    for f in foreign_keys {
        s.table(f.target.schema.as_deref(), &f.target.name);
    }
    if let Some(d) = dialect {
        s.line(1, format!("dialect: {}", dialect_words(d)));
    }
    let double = double_quoted_strings(dialect);
    if !types.is_empty() {
        let types = list_of(types, TYPES, |t| type_text(t, double));
        s.line(1, format!("types: {types}"));
    }
    let draft = if columns.is_empty() {
        format!("draft {}", name(&path.name))
    } else {
        // The summary keeps 400 bytes: a few columns are enough.
        let drafted = list_of(columns, SUMMARY_COLUMNS, |c| {
            format!("{} {}", name(&c.name), type_text(&c.type_sql, double))
        });
        format!("draft {}: {drafted}", name(&path.name))
    };
    // The draft fact comes from the where line and the column lines it names.
    let mut from = vec![Some(0)];
    for (i, c) in columns.iter().enumerate() {
        let at = s.line(1, column_line(c, dialect, clean));
        if i < SUMMARY_COLUMNS {
            from.push(at);
        }
    }
    s.fact(&from, draft);
    if !primary.is_empty() {
        let pk = format!("primary key ({})", names(primary, TICKED_COLUMNS));
        let at = s.line(1, pk.clone());
        s.fact(&[at], pk);
    }
    for i in indexes.iter().filter(|i| !i.primary) {
        s.line(1, index_line(i));
    }
    for f in foreign_keys {
        s.line(1, foreign_key_line(f));
    }
    if !removed.is_empty() {
        s.line(1, format!("removed: {}", names(removed, REMOVED_COLUMNS)));
    }
    if let Some(text) = table_comment.as_deref().map(|t| comment(t, clean))
        && !text.is_empty()
    {
        s.line(1, format!("comment: {text}"));
    }
    if !outline.is_empty() {
        s.line(1, outline_line(&path.database, outline));
    }
    line
}

fn diff_line(d: &DiffLine, level: u8) -> String {
    let kind = match d.kind {
        DiffKind::Added => "added",
        DiffKind::Removed => "removed",
        DiffKind::Changed => "changed",
    };
    let (object, what) = match d.object {
        DiffObject::Table => ("table", name(&d.table)),
        DiffObject::Column => ("column", format!("{}.{}", name(&d.table), name(&d.name))),
        DiffObject::PrimaryKey => ("primary key", format!("on {}", name(&d.table))),
        DiffObject::Index => ("index", name(&d.name)),
        DiffObject::ForeignKey => ("foreign key", name(&d.name)),
        DiffObject::Enum => ("enum", name(&d.name)),
    };
    let mut out = format!("{kind} {object} {what}");
    if let (Some(from), Some(to)) = (&d.from_type, &d.to_type) {
        out.push_str(&format!(
            ": {} to {}",
            type_text(from, true),
            type_text(to, true)
        ));
    }
    match d.loses_rows {
        Some(n) if level >= 2 => {
            out.push_str(&format!(" (loses about {})", count(n, "row", "rows")));
        }
        _ if d.loses_data => out.push_str(" (loses data)"),
        _ => {}
    }
    out
}

fn compare_tab(s: &mut Scene, tab: &AskTab) -> String {
    let AskTab::Compare {
        source,
        target_database,
        items,
        added,
        removed,
        changed,
        not_compared,
        ticked,
        compared,
    } = tab
    else {
        unreachable!("compare_tab takes a compare tab")
    };
    s.reaches(1);
    let source = match source {
        CompareSide::Database { database } if database.is_empty() => "no source chosen yet".into(),
        CompareSide::Database { database } => name(database),
        CompareSide::Model { file } => {
            if s.reaches(2) {
                format!("model \"{}\"", base_name(file))
            } else {
                "model".into()
            }
        }
    };
    let line = if target_database.is_empty() {
        format!("Schema Compare {source} (source), no target chosen yet")
    } else {
        format!(
            "Schema Compare {source} (source) to {} (target)",
            name(target_database)
        )
    };
    if !*compared {
        s.line(1, "not compared yet".to_string());
        return line;
    }
    let counts = format!(
        "{} added, {} removed, {} changed",
        grouped(u64::from(*added)),
        grouped(u64::from(*removed)),
        grouped(u64::from(*changed))
    );
    let fact = counts.clone();
    let counts = if *not_compared > 0 {
        format!(
            "{counts}, {} not compared",
            grouped(u64::from(*not_compared))
        )
    } else {
        counts
    };
    let at = s.line(1, counts);
    s.fact(&[at], fact);
    if items.iter().any(|d| d.loses_rows.is_some()) {
        s.reaches(2);
    }
    for d in items.iter().take(DIFF_LINES) {
        let text = diff_line(d, s.level);
        s.push(text);
    }
    if items.len() > DIFF_LINES {
        s.push(more(items.len() - DIFF_LINES));
    }
    // Card hints on the target side: an added item is in the source only.
    for d in items.iter().filter(|d| d.kind != DiffKind::Added) {
        s.table(None, &d.table);
    }
    s.line(
        1,
        format!(
            "ticked: {} of {}",
            grouped(u64::from(*ticked)),
            grouped(items.len() as u64)
        ),
    );
    line
}

fn if_exists_words(i: IfExists) -> &'static str {
    match i {
        IfExists::Stop => "stop",
        IfExists::Append => "append",
        IfExists::EmptyFirst => "empty it first",
    }
}

fn mode_words(mode: TransferMode) -> &'static str {
    match mode {
        TransferMode::OneTransaction => "everything runs in one transaction",
        TransferMode::PerTable => "each table is copied in its own transaction",
    }
}

fn note_words(kind: TransferNoteKind) -> &'static str {
    match kind {
        TransferNoteKind::Info => "has a note in the plan",
        TransferNoteKind::New => "is new on the target",
        TransferNoteKind::NeedsChoice => "needs a type choice",
        TransferNoteKind::NoMatch => "has no type match, copied as text",
        TransferNoteKind::Lossy => "may lose precision or range",
    }
}

fn transfer_lines(
    s: &mut Scene,
    tables: &[TransferLine],
    mode: Option<TransferMode>,
    notes: &[TransferNote],
) {
    let mode = mode.map_or("not planned yet", mode_words);
    // The count fact comes from the where line, the mode line and every table line with
    // its `(+n more)`: a cut that drops a table line takes the count with it.
    let mut from = vec![Some(0), s.line(1, format!("mode: {mode}"))];
    let mut columns = 0usize;
    for t in tables.iter().take(TRANSFER_TABLES) {
        let mut state = if t.exists {
            format!("exists, if exists: {}", if_exists_words(t.if_exists))
        } else {
            "new".to_string()
        };
        if let Some(n) = t.emptied_rows
            && s.reaches(2)
        {
            state.push_str(&format!(", emptied: about {}", count(n, "row", "rows")));
        }
        from.push(s.line(
            1,
            format!("{} -> {} ({state})", name(&t.source), name(&t.target)),
        ));
        for c in t.columns.iter().take(TRANSFER_COLUMNS - columns) {
            columns += 1;
            // Types come from either Dialect: double-quoted values are masked too.
            let target = if c.target_name == c.name {
                type_text(&c.target_type, true)
            } else {
                format!(
                    "{} {}",
                    name(&c.target_name),
                    type_text(&c.target_type, true)
                )
            };
            s.push(format!(
                "  {} {} -> {target}",
                name(&c.name),
                type_text(&c.source_type, true)
            ));
        }
    }
    if tables.len() > TRANSFER_TABLES {
        from.push(s.push(more(tables.len() - TRANSFER_TABLES)));
    }
    s.fact(
        &from,
        format!(
            "{}, mode {mode}",
            count(tables.len() as u64, "table", "tables")
        ),
    );
    let all: usize = tables
        .iter()
        .take(TRANSFER_TABLES)
        .map(|t| t.columns.len())
        .sum();
    if all > columns {
        s.push(more(all - columns));
    }
    // A note names a listed table and one of its columns, or it does not go: its two
    // names are the only free text it has.
    let listed = |n: &&TransferNote| {
        tables.iter().take(TRANSFER_TABLES).any(|t| {
            (t.source == n.table || t.target == n.table)
                && n.column.as_ref().is_none_or(|c| {
                    t.columns
                        .iter()
                        .any(|tc| tc.name == *c || tc.target_name == *c)
                })
        })
    };
    for n in notes.iter().filter(listed).take(NOTES) {
        let at = match &n.column {
            Some(c) => format!("{}.{}", name(&n.table), name(c)),
            None => name(&n.table),
        };
        s.line(1, format!("note: {at} {}", note_words(n.kind)));
    }
    let listed_notes = notes.iter().filter(listed).count();
    if listed_notes > NOTES {
        s.push(more(listed_notes - NOTES));
    }
}

fn import_tab(s: &mut Scene, tab: &AskTab) -> String {
    let AskTab::Import {
        file,
        format,
        delimiter,
        encoding,
        target,
        header,
        mapping,
        rows_estimate,
    } = tab
    else {
        unreachable!("import_tab takes an import tab")
    };
    s.reaches(1);
    let into = match target {
        ImportInto::Table { path } => {
            s.table(path.schema.as_deref(), &path.name);
            qualified(path)
        }
        ImportInto::Database { database, schema } => match schema {
            Some(sc) if !sc.is_empty() => format!("{}.{}", name(database), name(sc)),
            _ => name(database),
        },
    };
    let line = format!("Import {} into {into}", base_name(file));
    let mut fmt = vec![plain(format, 16).map_or("other".into(), str::to_ascii_uppercase)];
    if let Some(d) = delimiter {
        fmt.push(format!("delimiter {}", delimiter_word(d)));
    }
    if let Some(e) = plain(encoding, 32) {
        fmt.push(e.to_string());
    }
    s.line(1, format!("format: {}", fmt.join(", ")));
    // The header names are file content (a headerless file read with the header option
    // on gives its first row): they go at L2, as titles and counts do. At L1 only the
    // target columns of the mapping go.
    if s.level >= 2 {
        let mut from = vec![Some(0)];
        if !header.is_empty() {
            from.push(s.line(2, format!("file columns: {}", names(header, FILE_COLUMNS))));
        }
        s.fact(
            &from,
            format!(
                "{} into {into}",
                count(header.len() as u64, "file column", "file columns")
            ),
        );
        if !mapping.is_empty() {
            let pairs = list_of(mapping, FILE_COLUMNS, |(from, to)| match to {
                Some(to) => format!("{} -> {}", name(from), name(to)),
                None => format!("(skipped) {}", name(from)),
            });
            s.line(2, format!("mapping: {pairs}"));
        }
    } else {
        let targets: Vec<&String> = mapping.iter().filter_map(|(_, to)| to.as_ref()).collect();
        if !targets.is_empty() {
            s.line(
                1,
                format!(
                    "target columns: {}",
                    list_of(targets, FILE_COLUMNS, |t| name(t))
                ),
            );
        }
    }
    if let Some(n) = rows_estimate {
        s.line(2, format!("about {} in the file", count(*n, "row", "rows")));
    }
    line
}

/// The where line and the lines, at most `TAB_CAP` bytes: whole lines are cut from the
/// end and `(cut: <n> more lines)` ends the text, counting the `dropped` lines the scene
/// did not keep. The where line is never cut. Also gives how many of `lines` were kept.
fn capped(where_line: &str, lines: &[String], dropped: usize) -> (String, usize) {
    let full = lines.iter().map(|l| l.len() + 1).sum::<usize>() + where_line.len();
    let mut out = where_line.to_string();
    if full <= TAB_CAP && dropped == 0 {
        for l in lines {
            out.push('\n');
            out.push_str(l);
        }
        return (out, lines.len());
    }
    let note = |n: usize| format!("(cut: {} more lines)", grouped(n as u64));
    let mut kept = 0;
    let mut len = out.len();
    for l in lines {
        let after = lines.len() - kept - 1 + dropped;
        if len + 1 + l.len() + 1 + note(after).len() > TAB_CAP {
            break;
        }
        len += 1 + l.len();
        kept += 1;
    }
    for l in &lines[..kept] {
        out.push('\n');
        out.push_str(l);
    }
    out.push('\n');
    out.push_str(&note(lines.len() - kept + dropped));
    (out, kept)
}

/// The tab kind id the AI log and the Asked in stamp name; never a label.
pub fn kind_id(tab: &AskTab) -> &'static str {
    match tab {
        AskTab::Query { .. } => "query",
        AskTab::Object { .. } => "object",
        AskTab::Visual { .. } => "visual",
        AskTab::Design { .. } => "design",
        AskTab::Schema { .. } => "schema",
        AskTab::Compare { .. } => "compare",
        AskTab::Transfer { .. } => "transfer",
        AskTab::Import { .. } => "import",
        AskTab::Lineage { .. } => "lineage",
        AskTab::SavedQueries => "savedQueries",
        AskTab::Home => "home",
        AskTab::Settings { .. } => "settings",
    }
}

/// The kind words of a tab with nothing of it named: the Asked in label when no This tab
/// item went.
pub fn kind_words(tab: &AskTab) -> &'static str {
    match tab {
        AskTab::Query { .. } => "Query tab",
        AskTab::Object { object, .. } => match object {
            ObjectKind::Table => "Table data",
            ObjectKind::View => "View",
            ObjectKind::Procedure => "Procedure",
            ObjectKind::Function => "Function",
            ObjectKind::Trigger => "Trigger",
        },
        AskTab::Visual { .. } => "Visual Query",
        AskTab::Design { create: true, .. } => "New table",
        AskTab::Design { .. } => "Table Designer",
        AskTab::Schema { .. } => "Schema Builder",
        AskTab::Compare { .. } => "Schema Compare",
        AskTab::Transfer { .. } => "Data Transfer",
        AskTab::Import { .. } => "Import",
        AskTab::Lineage { .. } => "Lineage",
        AskTab::SavedQueries => "Saved Queries list",
        AskTab::Home => "Home",
        AskTab::Settings { .. } => "Settings",
    }
}

impl TabText {
    /// The summary of what went: the facts whose lines are all in `sent`, the item's text
    /// after the rails and the 200 KB cut, each line compared as `clean` (the input rail's
    /// cleaner) leaves it. A line the cuts dropped, or the rails changed otherwise, takes
    /// its facts with it, so the stamp never holds more than the turn sent. The facts kept
    /// are cleaned the same way.
    pub fn sent_summary(&self, sent: &str, clean: &dyn Fn(&str) -> String) -> String {
        let built: Vec<&str> = self.text.lines().collect();
        let went: Vec<&str> = sent.lines().collect();
        let mut cleaned: Vec<Option<bool>> = vec![None; built.len()];
        let mut went_whole = |n: usize| match cleaned.get(n).copied().flatten() {
            Some(b) => b,
            None => {
                let ok = built
                    .get(n)
                    .is_some_and(|l| went.contains(&clean(l).as_str()));
                if let Some(slot) = cleaned.get_mut(n) {
                    *slot = Some(ok);
                }
                ok
            }
        };
        let mut facts = Vec::new();
        for (from, fact) in &self.facts {
            if from.iter().all(|n| went_whole(*n)) {
                facts.push(clean(fact));
            }
        }
        summary(&facts)
    }
}

/// The facts joined with `; `, at most 400 bytes: cut at a `; ` boundary, then at a
/// character boundary when the first fact alone is over.
pub(crate) fn summary(parts: &[String]) -> String {
    let mut out = String::new();
    for p in parts {
        let sep = if out.is_empty() { 0 } else { 2 };
        if out.len() + sep + p.len() > SUMMARY_BYTES {
            if out.is_empty() {
                out = crate::ai::rails::cap_chars(p, SUMMARY_BYTES).to_string();
            }
            break;
        }
        if sep > 0 {
            out.push_str("; ");
        }
        out.push_str(p);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::context::cards::cleaner;
    use crate::ai::rails::Secrets;
    use crate::visual_query::{ColumnPair, Joiner, VqColumn, VqFilter, VqJoin, VqSort, VqTable};

    const LEVELS: [Option<AiAccess>; 5] = [
        Some(AiAccess::Never),
        Some(AiAccess::Schema),
        Some(AiAccess::SchemaQuery),
        Some(AiAccess::SchemaQueryRows),
        None,
    ];

    fn plain_clean(t: &str) -> String {
        t.to_string()
    }

    fn render(tab: &AskTab, access: Option<AiAccess>) -> Option<TabText> {
        tab_text(
            tab,
            access,
            Some("shop"),
            None,
            Some(DialectKind::MySql),
            &[],
            &plain_clean,
        )
    }

    fn text(tab: &AskTab, access: Option<AiAccess>) -> Option<String> {
        render(tab, access).map(|t| t.text)
    }

    fn path(database: &str, name: &str) -> ObjectPath {
        ObjectPath {
            database: database.into(),
            schema: None,
            name: name.into(),
        }
    }

    fn own(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn vq_table(id: &str, name: &str, alias: &str) -> VqTable {
        VqTable {
            id: id.into(),
            schema: None,
            name: name.into(),
            alias: alias.into(),
            x: 0.0,
            y: 0.0,
        }
    }

    fn vq_filter(table: &str, column: &str, op: FilterOp, value: &str) -> VqFilter {
        VqFilter {
            joiner: Joiner::And,
            table: table.into(),
            column: column.into(),
            op,
            values: vec![value.into()],
        }
    }

    fn vq_model() -> VisualQuery {
        VisualQuery {
            version: 1,
            database: Some("shop".into()),
            dialect: Some(DialectKind::MySql),
            tables: vec![
                vq_table("t1", "orders", "o"),
                vq_table("t2", "customers", "c"),
            ],
            joins: vec![VqJoin {
                id: "j1".into(),
                left: "t1".into(),
                right: "t2".into(),
                kind: JoinKind::Left,
                on: vec![ColumnPair {
                    left_column: "customer_id".into(),
                    right_column: "id".into(),
                }],
                pending: None,
            }],
            columns: vec![
                VqColumn {
                    table: "t1".into(),
                    column: "id".into(),
                    alias: None,
                    aggregate: None,
                },
                VqColumn {
                    table: "t1".into(),
                    column: "total".into(),
                    alias: Some("spent".into()),
                    aggregate: Some(Aggregate::Sum),
                },
            ],
            filters: vec![vq_filter("t1", "total", FilterOp::Gt, "1000000")],
            group_by: GroupBy::Auto,
            order_by: vec![VqSort {
                target: SortTarget::Output { index: 1 },
                dir: SortDir::Desc,
            }],
            limit: Some(100),
            distinct: false,
        }
    }

    fn visual(title: &str) -> AskTab {
        AskTab::Visual {
            title: title.into(),
            model: vq_model(),
            sql_written: true,
            problems: 0,
            last_run: Some(RunCount {
                rows: 1,
                more: false,
                failed: false,
            }),
        }
    }

    fn draft(name: &str, type_sql: &str, nullable: bool, default: Option<&str>) -> ColumnDraft {
        ColumnDraft {
            name: name.into(),
            type_sql: type_sql.into(),
            nullable,
            default_sql: default.map(str::to_string),
            increment: false,
            comment: None,
        }
    }

    fn design(columns: Vec<ColumnDraft>) -> AskTab {
        AskTab::Design {
            create: true,
            path: path("shop", "monthly_totals"),
            columns,
            primary: own(&["customer_id"]),
            indexes: vec![IndexDraft {
                name: "monthly_totals_total_idx".into(),
                columns: own(&["total"]),
                unique: false,
                primary: false,
            }],
            foreign_keys: vec![ForeignKeyDraft {
                name: "monthly_totals_customer_fk".into(),
                columns: own(&["customer_id"]),
                target: path("shop", "customers"),
                target_columns: own(&["id"]),
                on_delete: Some("CASCADE".into()),
                on_update: Some("drop table x".into()),
            }],
            removed: Vec::new(),
            comment: None,
            types: own(&["int", "decimal(p,s)"]),
        }
    }

    fn diff(kind: DiffKind, object: DiffObject, table: &str, name: &str) -> DiffLine {
        DiffLine {
            kind,
            object,
            table: table.into(),
            name: name.into(),
            from_type: None,
            to_type: None,
            loses_data: false,
            loses_rows: None,
        }
    }

    fn compare(items: Vec<DiffLine>) -> AskTab {
        AskTab::Compare {
            source: CompareSide::Database {
                database: "shop".into(),
            },
            target_database: "shop_staging".into(),
            items,
            added: 1,
            removed: 1,
            changed: 1,
            not_compared: 2,
            ticked: 2,
            compared: true,
        }
    }

    fn import() -> AskTab {
        AskTab::Import {
            file: r"C:\Users\x\orders.csv".into(),
            format: "csv".into(),
            delimiter: Some(",".into()),
            encoding: "UTF-8".into(),
            target: ImportInto::Table {
                path: path("shop", "orders"),
            },
            header: own(&["id", "customer", "total", "note"]),
            mapping: vec![
                ("customer".into(), Some("customer_id".into())),
                ("total".into(), Some("total".into())),
                ("note".into(), None),
            ],
            rows_estimate: Some(12_000),
        }
    }

    /// One fixture per variant, Kestrel Foods style.
    fn fixtures() -> Vec<(AskTab, [Option<&'static str>; 5])> {
        let query = AskTab::Query {
            title: "Untitled 1".into(),
        };
        let object = AskTab::Object {
            title: "orders".into(),
            path: path("shop", "orders"),
            object: ObjectKind::Table,
            sort: Some(SortSpec {
                column: "created_at".into(),
                descending: true,
            }),
            filter_columns: own(&["status"]),
            hidden: own(&["note"]),
            pending_edits: 2,
        };
        let table_l1 = "Table data \"orders\" in shop\nsorted by created_at desc\nfiltered on status\nhidden columns: note";
        let table_l2 = "Table data \"orders\" in shop\nsorted by created_at desc\nfiltered on status\nhidden columns: note\n2 Pending Edits not saved";
        let vq_l1 = "Visual Query in shop\ntables: orders o, customers c\nticked: o.id, sum(o.total)\njoins: o.customer_id = c.id (left)\nfilters on: o.total >\norder by: sum(o.total) desc\nlimit: yes";
        let vq_l2 = "Visual Query \"Orders over 1M\" in shop\ntables: orders o, customers c\nticked: o.id, sum(o.total)\njoins: o.customer_id = c.id (left)\nfilters on: o.total >\norder by: sum(o.total) desc\nlimit: yes\nSQL: written\nlast run: 1 row";
        let design_text = "New table \"monthly_totals\" in shop\ndialect: MySQL\ntypes: int, decimal(p,s)\ncolumn customer_id int not null\ncolumn total decimal(14,2) null default ?\nprimary key (customer_id)\nindex monthly_totals_total_idx (total)\nforeign key (customer_id) references shop.customers (id) on delete cascade";
        let schema = AskTab::Schema {
            file: "/home/kestrel/models/shop.dbml".into(),
            tables: 12,
            error_line: Some(5),
        };
        let mut changed = diff(DiffKind::Changed, DiffObject::Column, "orders", "total");
        changed.from_type = Some("decimal(10,2)".into());
        changed.to_type = Some("decimal(14,2)".into());
        let mut dropped = diff(
            DiffKind::Removed,
            DiffObject::Index,
            "orders",
            "orders_status_idx",
        );
        dropped.loses_data = true;
        dropped.loses_rows = Some(1_204);
        let compare = compare(vec![
            diff(DiffKind::Added, DiffObject::Table, "refunds", "refunds"),
            changed,
            dropped,
        ]);
        let cmp_l1 = "Schema Compare shop (source) to shop_staging (target)\n1 added, 1 removed, 1 changed, 2 not compared\nadded table refunds\nchanged column orders.total: decimal(10,2) to decimal(14,2)\nremoved index orders_status_idx (loses data)\nticked: 2 of 3";
        let cmp_l2 = "Schema Compare shop (source) to shop_staging (target)\n1 added, 1 removed, 1 changed, 2 not compared\nadded table refunds\nchanged column orders.total: decimal(10,2) to decimal(14,2)\nremoved index orders_status_idx (loses about 1,204 rows)\nticked: 2 of 3";
        let transfer = AskTab::Transfer {
            source_database: "shop".into(),
            target_database: "analytics".into(),
            mode: Some(TransferMode::PerTable),
            tables: vec![TransferLine {
                source: "orders".into(),
                target: "orders".into(),
                exists: true,
                if_exists: IfExists::EmptyFirst,
                columns: vec![TransferColumn {
                    name: "total".into(),
                    target_name: "total".into(),
                    source_type: "decimal(10,2)".into(),
                    target_type: "numeric(10,2)".into(),
                }],
                emptied_rows: Some(3_000),
            }],
            notes: vec![TransferNote {
                table: "orders".into(),
                column: Some("total".into()),
                kind: TransferNoteKind::Lossy,
            }],
        };
        let tr_l1 = "Data Transfer shop to analytics\nmode: each table is copied in its own transaction\norders -> orders (exists, if exists: empty it first)\n  total decimal(10,2) -> numeric(10,2)\nnote: orders.total may lose precision or range";
        let tr_l2 = "Data Transfer shop to analytics\nmode: each table is copied in its own transaction\norders -> orders (exists, if exists: empty it first, emptied: about 3,000 rows)\n  total decimal(10,2) -> numeric(10,2)\nnote: orders.total may lose precision or range";
        // File header names are file content: at L1 only the target columns go.
        let imp_l1 = "Import orders.csv into shop.orders\nformat: CSV, delimiter comma, UTF-8\ntarget columns: customer_id, total";
        let imp_l2 = "Import orders.csv into shop.orders\nformat: CSV, delimiter comma, UTF-8\nfile columns: id, customer, total, note\nmapping: customer -> customer_id, total -> total, (skipped) note\nabout 12,000 rows in the file";
        let lineage = AskTab::Lineage {
            path: path("shop", "orders"),
            neighbours: own(&["customers", "refunds"]),
        };
        let lin = "Lineage \"orders\" in shop\nneighbours: customers, refunds";
        vec![
            (
                query,
                [
                    None,
                    Some("Query tab in shop"),
                    Some("Query tab \"Untitled 1\" in shop"),
                    Some("Query tab \"Untitled 1\" in shop"),
                    None,
                ],
            ),
            (
                object,
                [None, Some(table_l1), Some(table_l2), Some(table_l2), None],
            ),
            (
                visual("Orders over 1M"),
                [None, Some(vq_l1), Some(vq_l2), Some(vq_l2), None],
            ),
            (
                design(vec![
                    draft("customer_id", "int", false, None),
                    draft("total", "decimal(14,2)", true, Some("0")),
                ]),
                [
                    None,
                    Some(design_text),
                    Some(design_text),
                    Some(design_text),
                    None,
                ],
            ),
            (
                schema,
                [
                    None,
                    Some("Schema Builder in shop\n12 tables\nDBML error on line 5"),
                    Some("Schema Builder \"shop.dbml\" in shop\n12 tables\nDBML error on line 5"),
                    Some("Schema Builder \"shop.dbml\" in shop\n12 tables\nDBML error on line 5"),
                    Some("Schema Builder \"shop.dbml\"\n12 tables\nDBML error on line 5"),
                ],
            ),
            (
                compare,
                [None, Some(cmp_l1), Some(cmp_l2), Some(cmp_l2), None],
            ),
            (
                transfer,
                [None, Some(tr_l1), Some(tr_l2), Some(tr_l2), None],
            ),
            (
                import(),
                [None, Some(imp_l1), Some(imp_l2), Some(imp_l2), None],
            ),
            (lineage, [None, Some(lin), Some(lin), Some(lin), None]),
            (
                AskTab::SavedQueries,
                [
                    None,
                    Some("Saved Queries list"),
                    Some("Saved Queries list"),
                    Some("Saved Queries list"),
                    Some("Saved Queries list"),
                ],
            ),
            (
                AskTab::Home,
                [None, Some("Home"), Some("Home"), Some("Home"), Some("Home")],
            ),
            (
                AskTab::Settings {
                    section: SettingsPage::Ai,
                },
                [
                    None,
                    Some("Settings, AI assistant"),
                    Some("Settings, AI assistant"),
                    Some("Settings, AI assistant"),
                    Some("Settings, AI assistant"),
                ],
            ),
        ]
    }

    #[test]
    fn tab_text_per_kind_and_level() {
        for (tab, want) in fixtures() {
            for (access, want) in LEVELS.iter().zip(want) {
                assert_eq!(
                    text(&tab, *access).as_deref(),
                    want,
                    "{tab:?} at {access:?}"
                );
            }
        }
    }

    #[test]
    fn where_line_and_summary_follow_the_text() {
        let t = render(&visual("Orders over 1M"), Some(AiAccess::SchemaQuery)).unwrap();
        assert_eq!(t.where_line, "Visual Query \"Orders over 1M\" in shop");
        assert_eq!(
            t.summary,
            "tables orders, customers; ticked o.id, sum(o.total); filters on o.total; last run 1 row"
        );
        assert_eq!(
            t.tables,
            vec![
                TableRef {
                    schema: None,
                    name: "orders".into()
                },
                TableRef {
                    schema: None,
                    name: "customers".into()
                }
            ]
        );
        // At L1 the run count is not in the summary either.
        let t = render(&visual("Orders over 1M"), Some(AiAccess::Schema)).unwrap();
        assert!(!t.summary.contains("last run"), "{}", t.summary);
    }

    #[test]
    fn sent_summary_keeps_only_facts_that_went() {
        let t = render(&visual("Orders over 1M"), Some(AiAccess::SchemaQuery)).unwrap();
        // Everything went: the summary as built.
        assert_eq!(t.sent_summary(&t.text, &plain_clean), t.summary);
        // The 200 KB cut takes whole lines from the end: their facts go with them.
        let lines: Vec<&str> = t.text.lines().collect();
        let at = |prefix: &str| lines.iter().position(|l| l.starts_with(prefix)).unwrap();
        let cut = lines[..at("filters on:")].join("\n");
        assert_eq!(
            t.sent_summary(&cut, &plain_clean),
            "tables orders, customers; ticked o.id, sum(o.total)"
        );
        let summary = t.sent_summary(&cut, &plain_clean);
        assert!(!summary.contains("filters on") && !summary.contains("last run"));
        // Only the where line went: no fact.
        assert_eq!(t.sent_summary(lines[0], &plain_clean), "");
        assert_eq!(t.sent_summary("", &plain_clean), "");
        // A line cleaned as `clean` cleans it keeps its fact, cleaned the same way.
        let clean = |s: &str| s.replace("customers", "[redacted]");
        let cleaned: Vec<String> = lines.iter().map(|l| clean(l)).collect();
        let summary = t.sent_summary(&cleaned.join("\n"), &clean);
        assert!(
            summary.starts_with("tables orders, [redacted]; ticked o.id"),
            "{summary}"
        );
        // A line the rails changed otherwise (a match that joined it to the next one)
        // takes its fact with it.
        let joined = t.text.replacen("\nticked: ", " [redacted] ", 1);
        let summary = t.sent_summary(&joined, &plain_clean);
        assert!(
            !summary.contains("tables ") && !summary.contains("ticked"),
            "{summary}"
        );
        assert!(summary.starts_with("filters on o.total"), "{summary}");
        // Lines are matched whole: a part of a line is not the line.
        let forged = format!("{}\n{}", lines[0], "tables: orders o, customers c");
        assert_eq!(
            t.sent_summary(&forged, &plain_clean),
            "tables orders, customers"
        );
        assert_eq!(
            t.sent_summary(&format!("{}\ntables:", lines[0]), &plain_clean),
            ""
        );

        // The draft fact needs the where line and every column line it names.
        let d = render(
            &design(vec![
                draft("customer_id", "int", false, None),
                draft("total", "decimal(14,2)", true, None),
            ]),
            Some(AiAccess::Schema),
        )
        .unwrap();
        assert!(
            d.summary
                .starts_with("draft monthly_totals: customer_id int, total decimal(14,2)")
        );
        let no_total: Vec<&str> = d
            .text
            .lines()
            .filter(|l| !l.starts_with("column total"))
            .collect();
        let summary = d.sent_summary(&no_total.join("\n"), &plain_clean);
        assert!(!summary.contains("draft"), "{summary}");
        assert!(summary.contains("primary key (customer_id)"), "{summary}");

        // The Transfer count needs every table line: a cut table takes the count with it.
        let line = |t: &str| TransferLine {
            source: t.into(),
            target: t.into(),
            exists: false,
            if_exists: IfExists::EmptyFirst,
            columns: Vec::new(),
            emptied_rows: None,
        };
        let tr = render(
            &AskTab::Transfer {
                source_database: "shop".into(),
                target_database: "analytics".into(),
                mode: Some(TransferMode::PerTable),
                tables: vec![line("orders"), line("refunds")],
                notes: Vec::new(),
            },
            Some(AiAccess::Schema),
        )
        .unwrap();
        assert!(tr.summary.starts_with("2 tables, mode "), "{}", tr.summary);
        assert_eq!(tr.sent_summary(&tr.text, &plain_clean), tr.summary);
        let cut: Vec<&str> = tr
            .text
            .lines()
            .filter(|l| !l.starts_with("refunds"))
            .collect();
        assert_eq!(tr.sent_summary(&cut.join("\n"), &plain_clean), "");
    }

    #[test]
    fn object_tab_never_sends_filter_values() {
        let tab = AskTab::Object {
            title: "orders".into(),
            path: path("shop", "orders"),
            object: ObjectKind::Table,
            sort: None,
            filter_columns: own(&["total"]),
            hidden: Vec::new(),
            pending_edits: 0,
        };
        for access in &LEVELS[1..4] {
            let text = text(&tab, *access).unwrap();
            let lines: Vec<&str> = text.lines().collect();
            assert_eq!(lines[1], "filtered on total");
            assert_eq!(lines.len(), 2, "{text}");
            assert!(!text.contains(['=', '>', '<']), "{text}");
        }
    }

    #[test]
    fn visual_tab_hides_filter_values() {
        let text = text(&visual("Orders"), Some(AiAccess::SchemaQueryRows)).unwrap();
        let mut model = vq_model();
        model.tables[0].alias = String::new();
        model.filters = vec![vq_filter("t1", "total", FilterOp::Gt, "1000000")];
        let tab = AskTab::Visual {
            title: "Orders".into(),
            model,
            sql_written: true,
            problems: 0,
            last_run: None,
        };
        let plain = self::text(&tab, Some(AiAccess::SchemaQueryRows)).unwrap();
        assert!(plain.contains("filters on: orders.total"), "{plain}");
        for t in [&text, &plain] {
            assert!(!t.contains("1000000"), "{t}");
        }
    }

    #[test]
    fn design_defaults_are_masked() {
        let tab = design(vec![
            draft("status", "varchar(16)", false, Some("'active'")),
            draft("qty", "int", false, Some("0")),
            draft("at", "datetime", false, Some("now()")),
            draft("label", "text", true, Some("concat('a', b)")),
            draft("kind", "enum('x','y')", true, None),
        ]);
        let text = text(&tab, Some(AiAccess::SchemaQueryRows)).unwrap();
        for line in [
            "column status varchar(16) not null default '…'",
            "column qty int not null default ?",
            "column at datetime not null default now()",
            "column label text null default concat('…', b)",
            "column kind enum('…','…') null",
        ] {
            assert!(text.lines().any(|l| l == line), "{line} in {text}");
        }
        assert!(!text.contains("active"));
        // An action outside the closed list is not repeated.
        assert!(!text.contains("drop table"), "{text}");

        // Every number token and, on MySQL, double-quoted strings.
        let tab = design(vec![
            draft("a", "varchar(16)", false, Some("\"active\"")),
            draft("b", "double", false, Some("1e5")),
            draft("c", "double", false, Some("1.5E-3")),
            draft("d", "int", false, Some("0x1F")),
            draft("e", "int", false, Some("- 5")),
            draft("f", "decimal(10,2)", false, Some("0::numeric")),
            draft("g", "enum(\"gold\",\"silver\")", true, None),
            draft("h", "set('gold','sil''ver')", true, None),
        ]);
        let text = self::text(&tab, Some(AiAccess::SchemaQueryRows)).unwrap();
        for line in [
            "column a varchar(16) not null default \"…\"",
            "column b double not null default ?",
            // The lexer reads the exponent's sign apart: both parts are masked.
            "column c double not null default ?-?",
            "column d int not null default ?",
            "column e int not null default - ?",
            "column f decimal(10,2) not null default ?::numeric",
            "column g enum(\"…\",\"…\") null",
            "column h set('…','…') null",
        ] {
            assert!(text.lines().any(|l| l == line), "{line} in {text}");
        }
        for value in ["active", "1e5", "1.5E", "0x1F", "5", "gold", "silver"] {
            assert!(
                !text.lines().skip(3).any(|l| l.contains(value)),
                "{value} in {text}"
            );
        }
        // PostgreSQL quotes names in double quotes: a type name stays.
        let tab = design(vec![draft(
            "k",
            "\"OrderKind\"",
            true,
            Some("'a'::\"OrderKind\""),
        )]);
        let t = tab_text(
            &tab,
            Some(AiAccess::Schema),
            None,
            None,
            Some(DialectKind::Postgres),
            &[],
            &plain_clean,
        )
        .unwrap();
        assert!(
            t.text
                .lines()
                .any(|l| l == "column k \"OrderKind\" null default '…'::\"OrderKind\""),
            "{}",
            t.text
        );
    }

    /// The column lines a design of `columns` renders on `dialect`.
    fn column_lines(columns: Vec<ColumnDraft>, dialect: DialectKind) -> Vec<String> {
        tab_text(
            &design(columns),
            Some(AiAccess::Schema),
            None,
            None,
            Some(dialect),
            &[],
            &plain_clean,
        )
        .unwrap()
        .text
        .lines()
        .filter(|l| l.starts_with("column "))
        .map(str::to_string)
        .collect()
    }

    #[test]
    fn sqlite_double_quoted_defaults_are_strings() {
        let lines = column_lines(
            vec![
                draft("status", "text", false, Some("\"active\"")),
                draft("tier", "text", false, Some("'gold'")),
                draft("n", "integer", false, Some("(7)")),
            ],
            DialectKind::Sqlite,
        );
        assert_eq!(
            lines,
            [
                "column status text not null default \"…\"",
                "column tier text not null default '…'",
                "column n integer not null default (?)",
            ]
        );
    }

    #[test]
    fn escaped_quotes_stay_inside_a_masked_value() {
        let lines = column_lines(
            vec![
                draft("k", "enum(\"a\\\"b\",\"secret\")", true, None),
                draft("j", "enum('it\\'s','secret')", true, None),
                draft("d", "varchar(9)", true, Some("\"a\\\"b secret\"")),
            ],
            DialectKind::MySql,
        );
        assert_eq!(
            lines,
            [
                "column k enum(\"…\",\"…\") null",
                "column j enum('…','…') null",
                "column d varchar(9) null default \"…\"",
            ]
        );
    }

    #[test]
    fn default_comments_are_dropped() {
        let lines = column_lines(
            vec![
                draft("a", "int", false, Some("0 -- gold tier only")),
                draft("b", "int", false, Some("/* gold */ 1")),
                draft("c", "int", false, Some("0 # gold")),
                draft("d", "text", false, Some("-- c\n_utf8mb4'gold'")),
                draft("e", "text", false, Some("_utf8mb4'gold'")),
                draft("f", "text", false, Some("'a--b # c /* d */'")),
            ],
            DialectKind::MySql,
        );
        assert_eq!(
            lines,
            [
                "column a int not null default ?",
                "column b int not null default ?",
                "column c int not null default ?",
                "column d text not null default _utf8mb4'…'",
                "column e text not null default _utf8mb4'…'",
                "column f text not null default '…'",
            ]
        );
        assert!(lines.iter().all(|l| !l.contains("gold")), "{lines:?}");
        // `#` is no comment off MySQL; the number is still masked.
        let lines = column_lines(
            vec![draft("a", "int", false, Some("0 -- gold"))],
            DialectKind::Postgres,
        );
        assert_eq!(lines, ["column a int not null default ?"]);
        // PostgreSQL ends a line comment at a lone CR, as the safety lexer does: what follows
        // is read (and masked) as SQL.
        let lines = column_lines(
            vec![draft("a", "text", false, Some("-- gold\r'silver'"))],
            DialectKind::Postgres,
        );
        assert_eq!(lines, ["column a text not null default '…'"]);
        // PostgreSQL nests block comments and reads `$tag$` bodies whole.
        let lines = column_lines(
            vec![
                draft("a", "int", false, Some("/* a /* b */ gold */ 1")),
                draft("b", "text", false, Some("$$it's$$ -- gold")),
                draft("c", "text", false, Some("$q$a -- b$q$ /* gold */")),
            ],
            DialectKind::Postgres,
        );
        assert_eq!(
            lines,
            [
                "column a int not null default ?",
                "column b text not null default $$…$$",
                "column c text not null default $q$…$q$",
            ]
        );
        assert!(lines.iter().all(|l| !l.contains("gold")), "{lines:?}");
    }

    #[test]
    fn transfer_notes_name_only_listed_columns() {
        let note = |table: &str, column: Option<&str>| TransferNote {
            table: table.into(),
            column: column.map(str::to_string),
            kind: TransferNoteKind::Info,
        };
        let tab = AskTab::Transfer {
            source_database: "shop".into(),
            target_database: "analytics".into(),
            mode: Some(TransferMode::PerTable),
            tables: vec![TransferLine {
                source: "orders".into(),
                target: "orders_copy".into(),
                exists: false,
                if_exists: IfExists::Stop,
                columns: vec![TransferColumn {
                    name: "total".into(),
                    target_name: "amount".into(),
                    source_type: "int".into(),
                    target_type: "int".into(),
                }],
                emptied_rows: None,
            }],
            notes: vec![
                note("orders", Some("total")),
                note("orders_copy", Some("amount")),
                note("orders", None),
                note("orders", Some("Default '{}'::jsonb is not copied")),
                note("No PostgreSQL match, for example gold", None),
            ],
        };
        let text = text(&tab, Some(AiAccess::Schema)).unwrap();
        let notes: Vec<&str> = text.lines().filter(|l| l.starts_with("note: ")).collect();
        assert_eq!(
            notes,
            [
                "note: orders.total has a note in the plan",
                "note: orders_copy.amount has a note in the plan",
                "note: orders has a note in the plan",
            ]
        );
        assert!(!text.contains("jsonb") && !text.contains("gold"), "{text}");
    }

    #[test]
    fn nothing_is_made_up_before_a_plan_or_a_result() {
        // A Transfer with no target and no plan claims no mode and names no empty target.
        let tab = AskTab::Transfer {
            source_database: "shop".into(),
            target_database: String::new(),
            mode: None,
            tables: Vec::new(),
            notes: Vec::new(),
        };
        let said = text(&tab, Some(AiAccess::Schema)).unwrap();
        assert_eq!(
            said,
            "Data Transfer shop, no target chosen yet\nmode: not planned yet"
        );
        // The mode is optional on the wire too.
        let json = serde_json::json!({
            "kind": "transfer", "sourceDatabase": "shop", "targetDatabase": "",
            "tables": [], "notes": []
        });
        assert_eq!(serde_json::from_value::<AskTab>(json).unwrap(), tab);
        // A Compare with no result says so: no counts, items or ticks.
        let tab = AskTab::Compare {
            source: CompareSide::Database {
                database: String::new(),
            },
            target_database: String::new(),
            items: Vec::new(),
            added: 0,
            removed: 0,
            changed: 0,
            not_compared: 0,
            ticked: 0,
            compared: false,
        };
        let said = text(&tab, Some(AiAccess::Schema)).unwrap();
        assert_eq!(
            said,
            "Schema Compare no source chosen yet (source), no target chosen yet\nnot compared yet"
        );
        // `compared` defaults to true for a request that does not name it.
        let json = serde_json::json!({
            "kind": "compare", "source": { "kind": "database", "database": "shop" },
            "targetDatabase": "shop_staging", "items": [], "added": 0, "removed": 0,
            "changed": 0, "notCompared": 0, "ticked": 0
        });
        assert!(matches!(
            serde_json::from_value::<AskTab>(json).unwrap(),
            AskTab::Compare { compared: true, .. }
        ));
    }

    #[test]
    fn transfer_notes_and_types_carry_no_values() {
        // The plan's notes can quote a default (`'{}'::jsonb`) or set members; the tab
        // sends each note's kind in the Core's words, never its text.
        let tab = AskTab::Transfer {
            source_database: "shop".into(),
            target_database: "analytics".into(),
            mode: Some(TransferMode::OneTransaction),
            tables: vec![TransferLine {
                source: "customers".into(),
                target: "customers".into(),
                exists: false,
                if_exists: IfExists::Stop,
                columns: vec![
                    TransferColumn {
                        name: "tier".into(),
                        target_name: "tier".into(),
                        source_type: "set('gold','silver')".into(),
                        target_type: "text".into(),
                    },
                    TransferColumn {
                        name: "meta".into(),
                        target_name: "meta".into(),
                        source_type: "json".into(),
                        target_type: "jsonb".into(),
                    },
                ],
                emptied_rows: None,
            }],
            notes: vec![
                TransferNote {
                    table: "customers".into(),
                    column: Some("tier".into()),
                    kind: TransferNoteKind::NoMatch,
                },
                TransferNote {
                    table: "customers".into(),
                    column: Some("meta".into()),
                    kind: TransferNoteKind::Info,
                },
            ],
        };
        let text = text(&tab, Some(AiAccess::SchemaQueryRows)).unwrap();
        assert_eq!(
            text,
            "Data Transfer shop to analytics\nmode: everything runs in one transaction\ncustomers -> customers (new)\n  tier set('…','…') -> text\n  meta json -> jsonb\nnote: customers.tier has no type match, copied as text\nnote: customers.meta has a note in the plan"
        );
        // The UI cannot slip a note's text in: the note is closed.
        let json = serde_json::json!({
            "table": "customers", "column": "meta", "kind": "info",
            "text": "Default '{}'::jsonb is not copied"
        });
        assert!(serde_json::from_value::<TransferNote>(json).is_err());
        let json = serde_json::json!({ "table": "t", "column": null, "kind": "chatter" });
        assert!(serde_json::from_value::<TransferNote>(json).is_err());
        // No card hints on a transfer: its tables are not in the target's Context.
        assert!(
            render(&tab, Some(AiAccess::Schema))
                .unwrap()
                .tables
                .is_empty()
        );
    }

    #[test]
    fn compare_hints_are_target_side() {
        let t = render(
            &compare(vec![
                diff(DiffKind::Added, DiffObject::Table, "refunds", "refunds"),
                diff(DiffKind::Changed, DiffObject::Column, "orders", "total"),
                diff(DiffKind::Removed, DiffObject::Index, "carts", "carts_idx"),
            ]),
            Some(AiAccess::Schema),
        )
        .unwrap();
        let names: Vec<&str> = t.tables.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["orders", "carts"]);
    }

    #[test]
    fn huge_lists_are_held_to_the_cap() {
        // 50,000 columns: the text says how many lines were cut, counted past the cap.
        let columns: Vec<ColumnDraft> = (0..50_000)
            .map(|i| draft(&format!("c{i}"), "int", true, None))
            .collect();
        let mut tab = design(columns);
        if let AskTab::Design {
            primary,
            indexes,
            foreign_keys,
            types,
            ..
        } = &mut tab
        {
            primary.clear();
            indexes.clear();
            foreign_keys.clear();
            types.clear();
        }
        let t = tab_text(
            &tab,
            Some(AiAccess::Schema),
            None,
            None,
            None,
            &[],
            &plain_clean,
        )
        .unwrap();
        assert!(t.text.len() <= TAB_CAP);
        let kept = t.text.lines().filter(|l| l.starts_with("column ")).count();
        assert_eq!(
            t.text.lines().last().unwrap(),
            format!("(cut: {} more lines)", grouped((50_000 - kept) as u64))
        );
        assert!(t.summary.len() <= SUMMARY_BYTES);
        assert_eq!(
            list_of(0..1_000_000, 2, |i| i.to_string()),
            "0, 1 (+999,998 more)"
        );
    }

    #[test]
    fn design_comment_is_cleaned_and_cut() {
        let key = "sk-kestrelAAAABBBBCCCCDDDD1234";
        let comment = format!("Monthly\u{200B} totals {key} {}", "x".repeat(1_000));
        let mut column = draft("total", "int", true, None);
        column.comment = Some(comment.clone());
        let mut tab = design(vec![column]);
        if let AskTab::Design { comment: c, .. } = &mut tab {
            *c = Some(comment);
        }
        let secrets = Secrets::default();
        let clean = cleaner(&secrets);
        let t = tab_text(&tab, Some(AiAccess::Schema), None, None, None, &[], &clean).unwrap();
        let line = t
            .text
            .lines()
            .find(|l| l.starts_with("column total"))
            .unwrap();
        let inner = line
            .split_once(" comment \"")
            .unwrap()
            .1
            .strip_suffix('"')
            .unwrap();
        assert_eq!(inner.chars().count(), 300, "{inner}");
        assert!(inner.starts_with("Monthly totals [redacted] x"), "{inner}");
        let table = t.text.lines().find(|l| l.starts_with("comment: ")).unwrap();
        assert_eq!(table["comment: ".len()..].chars().count(), 300);
        assert!(!t.text.contains('\u{200B}'));
        assert!(!t.text.contains(key));
    }

    #[test]
    fn user_titles_need_level_2() {
        let tab = visual("Q4 bonus list");
        let at = |a| text(&tab, Some(a)).unwrap();
        assert!(!at(AiAccess::Schema).contains("Q4 bonus list"));
        assert!(at(AiAccess::Schema).starts_with("Visual Query in shop\n"));
        assert!(at(AiAccess::SchemaQuery).starts_with("Visual Query \"Q4 bonus list\" in shop\n"));
        assert!(
            at(AiAccess::SchemaQueryRows).starts_with("Visual Query \"Q4 bonus list\" in shop\n")
        );
    }

    #[test]
    fn import_never_sends_file_rows_or_folder() {
        let tab = import();
        let json = serde_json::to_value(&tab).unwrap();
        let keys: Vec<&String> = json.as_object().unwrap().keys().collect();
        assert!(
            keys.iter()
                .all(|k| !k.contains("row") || *k == "rowsEstimate"),
            "{keys:?}"
        );
        for access in &LEVELS[1..4] {
            let text = text(&tab, *access).unwrap();
            assert!(text.starts_with("Import orders.csv into"), "{text}");
            assert!(!text.contains("Users") && !text.contains('\\'), "{text}");
        }
        // A folder written with forward slashes is dropped too.
        let tab = AskTab::Import {
            file: "/home/kestrel/drops/orders.csv".into(),
            format: "csv".into(),
            delimiter: None,
            encoding: "UTF-8".into(),
            target: ImportInto::Database {
                database: "shop".into(),
                schema: None,
            },
            header: Vec::new(),
            mapping: Vec::new(),
            rows_estimate: None,
        };
        assert_eq!(
            text(&tab, Some(AiAccess::Schema)).unwrap(),
            "Import orders.csv into shop\nformat: CSV, UTF-8"
        );
    }

    /// A headerless file read with the header option on: its first row is the header.
    #[test]
    fn import_header_names_wait_for_l2() {
        let first_row = ["1042", "alice@example.com", "555-0100", "1200.00"];
        let tab = AskTab::Import {
            file: "customers.csv".into(),
            format: "csv".into(),
            delimiter: Some(",".into()),
            encoding: "UTF-8".into(),
            target: ImportInto::Table {
                path: path("shop", "customers"),
            },
            header: own(&first_row),
            mapping: vec![
                ("1042".into(), Some("id".into())),
                ("alice@example.com".into(), Some("email".into())),
                ("555-0100".into(), None),
                ("1200.00".into(), Some("balance".into())),
            ],
            rows_estimate: Some(300),
        };
        let t = render(&tab, Some(AiAccess::Schema)).unwrap();
        for value in first_row {
            assert!(!t.text.contains(value), "{value} in {}", t.text);
            assert!(!t.summary.contains(value), "{value} in {}", t.summary);
        }
        assert_eq!(
            t.text,
            "Import customers.csv into shop.customers\nformat: CSV, delimiter comma, UTF-8\ntarget columns: id, email, balance"
        );
        assert_eq!(t.used, 1);
        // At L2 the header names go, as titles and counts do.
        let t = render(&tab, Some(AiAccess::SchemaQuery)).unwrap();
        assert!(
            t.text.contains("file columns: 1042, alice@example.com"),
            "{}",
            t.text
        );
        assert!(t.text.contains("mapping: 1042 -> id"), "{}", t.text);
        assert!(!t.text.contains("target columns"), "{}", t.text);
        assert_eq!(t.used, 2);
    }

    #[test]
    fn settings_tab_sends_no_values() {
        let tab = AskTab::Settings {
            section: SettingsPage::Ai,
        };
        assert_eq!(text(&tab, None).as_deref(), Some("Settings, AI assistant"));
        let t = render(&tab, None).unwrap();
        assert_eq!(t.used, 0);
        assert!(t.tables.is_empty());
        assert_eq!(t.summary, "");
    }

    #[test]
    fn lists_are_capped() {
        let mut model = vq_model();
        model.tables = (0..40)
            .map(|i| vq_table(&format!("t{i}"), &format!("tab{i}"), ""))
            .collect();
        model.columns.clear();
        model.joins.clear();
        model.filters.clear();
        model.order_by.clear();
        let tab = AskTab::Visual {
            title: String::new(),
            model,
            sql_written: false,
            problems: 0,
            last_run: None,
        };
        let text = text(&tab, Some(AiAccess::Schema)).unwrap();
        let line = text.lines().nth(1).unwrap();
        assert!(line.starts_with("tables: tab0, tab1, "), "{line}");
        assert!(line.ends_with(", tab29 (+10 more)"), "{line}");
        assert_eq!(line.matches(", ").count(), 29);

        let items: Vec<DiffLine> = (0..400)
            .map(|i| diff(DiffKind::Added, DiffObject::Table, &format!("t{i}"), ""))
            .collect();
        let text = self::text(&compare(items), Some(AiAccess::Schema)).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        let diffs = lines
            .iter()
            .filter(|l| l.starts_with("added table"))
            .count();
        assert_eq!(diffs, 300);
        assert!(lines.contains(&"(+100 more)"), "{text}");
        assert_eq!(lines.last(), Some(&"ticked: 2 of 400"));

        let long = "n".repeat(300);
        let tab = AskTab::Lineage {
            path: path("shop", &long),
            neighbours: Vec::new(),
        };
        let text = self::text(&tab, Some(AiAccess::Schema)).unwrap();
        assert_eq!(text, format!("Lineage \"{}…\" in shop", "n".repeat(128)));
    }

    #[test]
    fn tab_text_capped_at_8_kb() {
        let columns: Vec<ColumnDraft> = (0..2_000)
            .map(|i| draft(&format!("column_{i}"), "int", true, None))
            .collect();
        let tab = AskTab::Design {
            create: true,
            path: path("shop", "wide"),
            columns,
            primary: Vec::new(),
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
            removed: Vec::new(),
            comment: None,
            types: Vec::new(),
        };
        let t = tab_text(
            &tab,
            Some(AiAccess::Schema),
            None,
            None,
            None,
            &[],
            &plain_clean,
        )
        .unwrap();
        assert!(t.text.len() <= TAB_CAP, "{}", t.text.len());
        let lines: Vec<&str> = t.text.lines().collect();
        assert_eq!(lines[0], "New table \"wide\" in shop");
        let kept = lines.len() - 2;
        assert_eq!(
            lines.last().copied(),
            Some(format!("(cut: {} more lines)", grouped((2_000 - kept) as u64)).as_str())
        );
        assert!(
            lines[1..=kept]
                .iter()
                .all(|l| l.starts_with("column column_"))
        );
    }

    #[test]
    fn design_outline_is_capped_at_300_names() {
        let outline: Vec<String> = (0..420).map(|i| format!("t{i}")).collect();
        let t = tab_text(
            &design(Vec::new()),
            Some(AiAccess::Schema),
            None,
            None,
            None,
            &outline,
            &plain_clean,
        )
        .unwrap();
        let line = t.text.lines().last().unwrap();
        assert!(line.starts_with("tables in shop: t0, t1, "), "{line}");
        assert!(line.ends_with(", t299 (+120 more)"), "{line}");
        assert!(line.len() <= OUTLINE_BYTES);
        // Long names: the 4 KB bound comes first.
        let outline: Vec<String> = (0..300)
            .map(|i| format!("{i}_{}", "x".repeat(100)))
            .collect();
        let line = outline_line("shop", &outline);
        assert!(line.len() <= OUTLINE_BYTES, "{}", line.len());
        assert!(line.contains(" more)"), "{line}");
    }

    #[test]
    fn used_level_is_the_highest_part() {
        let tab = visual("Orders over 1M");
        assert_eq!(render(&tab, Some(AiAccess::SchemaQuery)).unwrap().used, 2);
        assert_eq!(
            render(&tab, Some(AiAccess::SchemaQueryRows)).unwrap().used,
            2
        );
        assert_eq!(render(&tab, Some(AiAccess::Schema)).unwrap().used, 1);
        assert_eq!(render(&AskTab::Home, None).unwrap().used, 0);
    }

    #[test]
    fn summary_is_cut_at_a_fact_boundary() {
        let facts = vec!["a".repeat(250), "b".repeat(100), "c".repeat(100)];
        assert_eq!(summary(&facts), format!("{}; {}", facts[0], facts[1]));
        assert_eq!(summary(&["é".repeat(300)]).len(), 400);
    }
}
