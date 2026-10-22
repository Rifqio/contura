//! The output rail (R5): the SQL blocks of an answer, split, classified and flagged.

use serde::{Deserialize, Serialize};

use crate::ai::log::{ProcessStep, StepKind};
use crate::ai::preview::count_of;
use crate::ai::rails::functions::is_builtin;
use crate::model::DialectKind;
use crate::safety::{
    StatementClass, classify, file_write, function_calls, leading_word, main_verb, missing_where,
    split_statements,
};

/// Why a statement of an answer needs a second look.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Flag {
    NoWhere {
        verb: String,
    },
    /// A risky function by name as written, or `INTO OUTFILE` / `INTO DUMPFILE`.
    RiskyFunction {
        name: String,
    },
    UnknownFunction {
        name: String,
    },
    WriteInReadAnswer,
    ReadOnlyConnection,
}

impl Flag {
    /// The flag's sentence on the label.
    pub fn sentence(&self) -> String {
        match self {
            Flag::NoWhere { verb } => format!("{verb} without WHERE."),
            Flag::RiskyFunction { name } if name.starts_with("INTO ") => {
                format!("Writes a file on the server ({name}).")
            }
            Flag::RiskyFunction { name } => format!("Calls {name}()."),
            Flag::UnknownFunction { name } => {
                format!("Calls {name}(): functions are not checked.")
            }
            Flag::WriteInReadAnswer => "This answer contains a write.".into(),
            Flag::ReadOnlyConnection => "Read-only Connection: this will not run.".into(),
        }
    }

    /// Risky or not built in: on Production the register makes such a read a write (R6.4).
    pub fn escalates(&self) -> bool {
        matches!(
            self,
            Flag::RiskyFunction { .. } | Flag::UnknownFunction { .. }
        )
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatementCheck {
    pub text: String,
    pub class: StatementClass,
    pub flags: Vec<Flag>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SqlBlock {
    /// The 0-based index of the block among all fenced blocks of the answer.
    pub fence: u32,
    pub label: String,
    pub statements: Vec<StatementCheck>,
}

/// One fenced code block of an answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fence {
    pub lang: Option<String>,
    pub body: String,
    /// False when the answer ended inside it.
    pub closed: bool,
}

/// R5.3: functions that reach outside the query: other sessions, files, the network,
/// the server's time.
const RISKY: [&str; 15] = [
    "pg_terminate_backend",
    "pg_cancel_backend",
    "set_config",
    "dblink",
    "dblink_exec",
    "lo_import",
    "lo_export",
    "pg_read_file",
    "pg_read_binary_file",
    "pg_ls_dir",
    "load_file",
    "sleep",
    "benchmark",
    "pg_sleep",
    "load_extension",
];

/// First words that make an untagged block SQL.
const SQL_STARTS: [&str; 20] = [
    "SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP", "TRUNCATE",
    "EXPLAIN", "MERGE", "REPLACE", "GRANT", "REVOKE", "SET", "SHOW", "PRAGMA", "VALUES", "TABLE",
    "DESCRIBE",
];

/// Tags read as SQL.
const SQL_TAGS: [&str; 7] = [
    "sql",
    "postgresql",
    "postgres",
    "pgsql",
    "mysql",
    "sqlite",
    "plpgsql",
];

/// Actions whose answers should only read.
const READ_ACTIONS: [&str; 3] = ["explain", "optimize", "indexes"];

/// The fenced code blocks of `answer`, in order. A fence opens on a line whose first
/// non-space characters are three or more backticks, with an optional language word, and
/// closes on a line of at least as many backticks; an unclosed fence runs to the end.
pub fn fences(answer: &str) -> Vec<Fence> {
    let mut out = Vec::new();
    let mut open: Option<(usize, Option<String>, Vec<&str>)> = None;
    for line in answer.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let lead = line.trim_start();
        let ticks = lead.bytes().take_while(|b| *b == b'`').count();
        let rest = &lead[ticks..];
        match &mut open {
            None => {
                if ticks >= 3 && !rest.contains('`') {
                    let lang = rest.split_whitespace().next().map(str::to_string);
                    open = Some((ticks, lang, Vec::new()));
                }
            }
            Some((need, _, body)) => {
                if ticks >= *need && rest.trim().is_empty() {
                    if let Some((_, lang, body)) = open.take() {
                        out.push(Fence {
                            lang,
                            body: body.join("\n"),
                            closed: true,
                        });
                    }
                } else {
                    body.push(line);
                }
            }
        }
    }
    if let Some((_, lang, body)) = open {
        out.push(Fence {
            lang,
            body: body.join("\n"),
            closed: false,
        });
    }
    out
}

/// The SQL blocks of a finished answer; see `check_answer_with`.
pub fn check_answer(
    answer: &str,
    dialect: Option<DialectKind>,
    action: &str,
    read_only: bool,
) -> Vec<SqlBlock> {
    check_answer_with(answer, dialect, action, read_only, true)
}

/// Blocks tagged `sql` (or a Dialect's name) and untagged blocks that start with a SQL
/// statement word, each split as the editor splits it and checked with `dialect`
/// (Postgres when unknown). An unclosed last fence is checked only when the answer
/// `ended` normally; a capped or partial answer may have stopped mid-statement.
pub fn check_answer_with(
    answer: &str,
    dialect: Option<DialectKind>,
    action: &str,
    read_only: bool,
    ended: bool,
) -> Vec<SqlBlock> {
    let d = dialect.unwrap_or(DialectKind::Postgres);
    let mut out = Vec::new();
    for (n, f) in fences(answer).iter().enumerate() {
        if (!f.closed && !ended) || !is_sql(d, f) {
            continue;
        }
        let statements: Vec<StatementCheck> = split_statements(d, &f.body)
            .into_iter()
            .map(|r| check_statement(d, &f.body[r], action, read_only))
            .collect();
        if statements.is_empty() {
            continue;
        }
        out.push(SqlBlock {
            fence: u32::try_from(n).unwrap_or(u32::MAX),
            label: label(d, &statements),
            statements,
        });
    }
    out
}

/// Why a flagged statement of an answer counts as a write on Production, read as
/// `dialect`, to follow "Written by the assistant and": "calls pg_sleep()", "writes a file
/// on the server (INTO OUTFILE)". A flag found only in another Dialect's reading gets the
/// general reason.
pub fn flag_reason(dialect: DialectKind, text: &str) -> String {
    if let Some(into) = file_write(dialect, text) {
        return format!("writes a file on the server ({into})");
    }
    let mut names: Vec<String> = Vec::new();
    for name in function_calls(dialect, text) {
        let base = name.rsplit('.').next().unwrap_or(&name);
        if (RISKY.contains(&base) || !is_builtin(dialect, &name)) && !names.contains(&name) {
            names.push(name);
        }
    }
    match names.as_slice() {
        [] => "was flagged by the SQL check".into(),
        _ => format!(
            "calls {}",
            names
                .iter()
                .map(|n| format!("{n}()"))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// Whether `text` calls a risky function or writes a file, read as any Dialect: for SQL
/// whose Dialect is not known, such as a stored answer checked again.
pub fn risky_anywhere(text: &str) -> bool {
    [
        DialectKind::Postgres,
        DialectKind::MySql,
        DialectKind::Sqlite,
    ]
    .into_iter()
    .any(|d| {
        file_write(d, text).is_some()
            || function_calls(d, text)
                .iter()
                .any(|n| RISKY.contains(&n.rsplit('.').next().unwrap_or(n)))
    })
}

fn is_sql(d: DialectKind, f: &Fence) -> bool {
    match &f.lang {
        Some(lang) => SQL_TAGS.contains(&lang.to_lowercase().as_str()),
        None => leading_word(d, &f.body).is_some_and(|w| SQL_STARTS.contains(&w.as_str())),
    }
}

fn check_statement(d: DialectKind, text: &str, action: &str, read_only: bool) -> StatementCheck {
    let class = classify(d, text);
    let write = class == StatementClass::Write;
    let mut flags = Vec::new();
    let mut add = |f: Flag| {
        if !flags.contains(&f) {
            flags.push(f);
        }
    };
    if let Some(verb) = missing_where(d, text) {
        add(Flag::NoWhere { verb: verb.into() });
    }
    for name in function_calls(d, text) {
        let base = name.rsplit('.').next().unwrap_or(&name);
        if RISKY.contains(&base) {
            add(Flag::RiskyFunction { name });
        } else if !write && !is_builtin(d, &name) {
            add(Flag::UnknownFunction { name });
        }
    }
    if let Some(into) = file_write(d, text) {
        add(Flag::RiskyFunction { name: into.into() });
    }
    if write && READ_ACTIONS.contains(&action) {
        add(Flag::WriteInReadAnswer);
    }
    if write && read_only {
        add(Flag::ReadOnlyConnection);
    }
    StatementCheck {
        text: text.to_string(),
        class,
        flags,
    }
}

/// Each flag's sentence once, in statement order.
fn sentences<'a>(statements: impl IntoIterator<Item = &'a StatementCheck>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in statements {
        for f in &s.flags {
            let line = f.sentence();
            if !out.contains(&line) {
                out.push(line);
            }
        }
    }
    out
}

/// "3 statements: 2 reads, 1 write (DELETE)", then the flags' sentences after a period.
fn label(d: DialectKind, statements: &[StatementCheck]) -> String {
    let writes: Vec<&StatementCheck> = statements
        .iter()
        .filter(|s| s.class == StatementClass::Write)
        .collect();
    let reads = statements.len() - writes.len();
    let mut verbs: Vec<String> = Vec::new();
    for s in &writes {
        let verb = main_verb(d, &s.text).unwrap_or_default();
        if !verb.is_empty() && !verbs.contains(&verb) {
            verbs.push(verb);
        }
    }
    let mut parts = Vec::new();
    if reads > 0 {
        parts.push(count_of(reads, "read", "reads"));
    }
    if !writes.is_empty() {
        let mut w = count_of(writes.len(), "write", "writes");
        if !verbs.is_empty() {
            w.push_str(&format!(" ({})", verbs.join(", ")));
        }
        parts.push(w);
    }
    let mut out = format!(
        "{}: {}",
        count_of(statements.len(), "statement", "statements"),
        parts.join(", ")
    );
    let lines = sentences(statements);
    if !lines.is_empty() {
        out.push_str(". ");
        out.push_str(&lines.join(" "));
    }
    out
}

fn dialect_name(d: DialectKind) -> &'static str {
    match d {
        DialectKind::Postgres => "PostgreSQL",
        DialectKind::MySql => "MySQL",
        DialectKind::Sqlite => "SQLite",
    }
}

/// What the SQL check found, for its Steps row and its log line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckSummary {
    pub reads: usize,
    pub writes: usize,
    pub flags: usize,
    pub step: ProcessStep,
}

/// The SQL check Steps row over `blocks`, checked with `dialect` (Postgres when unknown).
pub fn check_summary(
    blocks: &[SqlBlock],
    dialect: Option<DialectKind>,
    at_ms: u64,
) -> CheckSummary {
    let d = dialect.unwrap_or(DialectKind::Postgres);
    let all: Vec<&StatementCheck> = blocks.iter().flat_map(|b| &b.statements).collect();
    let writes = all
        .iter()
        .filter(|s| s.class == StatementClass::Write)
        .count();
    let reads = all.len() - writes;
    let flags: usize = all.iter().map(|s| s.flags.len()).sum();
    let (value, rule) = if flags == 0 {
        let no_write = if writes == 0 { "No write, no" } else { "No" };
        (
            format!(
                "{}, {}, no flags",
                count_of(reads, "read", "reads"),
                count_of(writes, "write", "writes")
            ),
            format!(
                "Each statement split and classified. {no_write} risky function, no function outside {}.",
                dialect_name(d)
            ),
        )
    } else {
        (
            count_of(flags, "flag", "flags"),
            sentences(all.iter().copied()).join(" "),
        )
    };
    let evidence = all
        .iter()
        .map(|s| {
            let class = match s.class {
                StatementClass::Read => "read",
                StatementClass::Write => "write",
            };
            let found: Vec<String> = s.flags.iter().map(Flag::sentence).collect();
            [
                first_line(&s.text),
                class.to_string(),
                if found.is_empty() {
                    "no flags".to_string()
                } else {
                    found.join(" ")
                },
            ]
        })
        .collect();
    CheckSummary {
        reads,
        writes,
        flags,
        step: ProcessStep {
            step: StepKind::SqlCheck,
            at_ms,
            value,
            rule,
            evidence,
            by_model: false,
            left_out: None,
        },
    }
}

/// The statement's first non-comment line, cut to 80 characters.
fn first_line(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("--"))
        .unwrap_or("");
    let mut out: String = line.chars().take(80).collect();
    if line.chars().count() > 80 {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_wording() {
        let blocks = check_answer(
            "```sql\nSELECT 1; DELETE FROM t WHERE a = 1\n```",
            Some(DialectKind::MySql),
            "ask",
            false,
        );
        let s = check_summary(&blocks, Some(DialectKind::MySql), 3);
        assert_eq!(s.step.value, "1 read, 1 write, no flags");
        assert_eq!(
            s.step.rule,
            "Each statement split and classified. No risky function, no function outside MySQL."
        );
        assert_eq!(
            s.step.evidence[1],
            [
                "DELETE FROM t WHERE a = 1".to_string(),
                "write".into(),
                "no flags".into()
            ]
        );
        let s = check_summary(&[], None, 0);
        assert_eq!(s.step.value, "0 reads, 0 writes, no flags");
    }
}
