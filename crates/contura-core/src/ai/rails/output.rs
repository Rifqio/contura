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
    /// SHA-256 (lowercase hex) of the fence body that was checked, after line ends were
    /// made LF. The UI uses the check only for a block whose own text has this hash, so a
    /// check can never land on another block; empty on records saved before it, which the
    /// UI reads as unchecked.
    #[serde(default)]
    pub body_sha256: String,
}

/// SHA-256 of `text`'s UTF-8 bytes, as lowercase hex.
pub fn sha256_hex(text: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
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
/// CRLF and a lone CR are line ends, as in the editor (and the UI's `parseAnswer`), so the
/// text checked is the text the editor will hold and the fence numbers match. Only space and
/// tab count as white space on a fence line (indent, the language word's end, a closing
/// line's tail), as in the UI's parser: Rust and JS disagree on NEL and BOM otherwise.
pub fn fences(answer: &str) -> Vec<Fence> {
    const BLANK: [char; 2] = [' ', '\t'];
    let answer = answer.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = Vec::new();
    let mut open: Option<(usize, Option<String>, Vec<&str>)> = None;
    for line in answer.split('\n') {
        let lead = line.trim_start_matches(BLANK);
        let ticks = lead.bytes().take_while(|b| *b == b'`').count();
        let rest = &lead[ticks..];
        match &mut open {
            None => {
                if ticks >= 3 && !rest.contains('`') {
                    let lang = rest
                        .split(BLANK)
                        .find(|w| !w.is_empty())
                        .map(str::to_string);
                    open = Some((ticks, lang, Vec::new()));
                }
            }
            Some((need, _, body)) => {
                if ticks >= *need && rest.trim_matches(BLANK).is_empty() {
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
/// statement word, each split as the editor splits it and checked with `dialect`. With no
/// Dialect (an Ask with no Connection, whose SQL may then be opened on any), each block is
/// read under every Dialect and keeps the worst reading (`worse`), so a statement that
/// writes on any of them reads as a write; PostgreSQL's reading when none is worse. An
/// unclosed last fence is checked only when the answer `ended` normally; a capped or
/// partial answer may have stopped mid-statement.
pub fn check_answer_with(
    answer: &str,
    dialect: Option<DialectKind>,
    action: &str,
    read_only: bool,
    ended: bool,
) -> Vec<SqlBlock> {
    let readings: &[DialectKind] = match &dialect {
        Some(d) => std::slice::from_ref(d),
        None => &[
            DialectKind::Postgres,
            DialectKind::MySql,
            DialectKind::Sqlite,
        ],
    };
    let mut out = Vec::new();
    for (n, f) in fences(answer).iter().enumerate() {
        if !f.closed && !ended {
            continue;
        }
        let mut kept: Option<SqlBlock> = None;
        for d in readings {
            let Some(block) = check_block(*d, n, f, action, read_only) else {
                continue;
            };
            if kept.as_ref().is_none_or(|k| worse(&block, k)) {
                kept = Some(block);
            }
        }
        out.extend(kept);
    }
    out
}

/// One fence read as `d`; `None` when it is not SQL there or holds no statement.
fn check_block(
    d: DialectKind,
    n: usize,
    f: &Fence,
    action: &str,
    read_only: bool,
) -> Option<SqlBlock> {
    if !is_sql(d, f) {
        return None;
    }
    let statements: Vec<StatementCheck> = split_statements(d, &f.body)
        .into_iter()
        .map(|r| check_statement(d, &f.body[r], action, read_only))
        .collect();
    if statements.is_empty() {
        return None;
    }
    Some(SqlBlock {
        fence: u32::try_from(n).unwrap_or(u32::MAX),
        label: label(d, &statements),
        statements,
        body_sha256: sha256_hex(&f.body),
    })
}

/// Whether reading `a` of a block is worse than reading `b`: it has a write and `b` has
/// none, then more writes, then more flags that are not "functions are not checked" (a
/// function built into another Dialect is not a reason to prefer its reading).
fn worse(a: &SqlBlock, b: &SqlBlock) -> bool {
    let key = |x: &SqlBlock| {
        let writes = x
            .statements
            .iter()
            .filter(|s| s.class == StatementClass::Write)
            .count();
        let flags = x
            .statements
            .iter()
            .flat_map(|s| &s.flags)
            .filter(|f| !matches!(f, Flag::UnknownFunction { .. }))
            .count();
        (writes > 0, writes, flags)
    };
    key(a) > key(b)
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

    /// `tests/fixtures/ai/answer_fences.json`, shared with the UI's answer parser.
    fn shared() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../../tests/fixtures/ai/answer_fences.json"
        ))
        .unwrap()
    }

    #[test]
    fn fences_match_the_shared_fixtures() {
        // The UI pairs a block with its check by fence number: both readers must number
        // alike, on NEL, BOM and no-break spaces too (only space and tab indent a fence).
        for case in shared()["fences"].as_array().unwrap() {
            let got: Vec<serde_json::Value> = fences(case["answer"].as_str().unwrap())
                .into_iter()
                .map(|f| serde_json::json!([f.lang, f.body, f.closed]))
                .collect();
            assert_eq!(
                got,
                case["fences"].as_array().unwrap().clone(),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn each_block_carries_the_hash_of_the_body_it_checked() {
        for pair in shared()["sha256"].as_array().unwrap() {
            assert_eq!(
                sha256_hex(pair[0].as_str().unwrap()),
                pair[1].as_str().unwrap()
            );
        }
        let blocks = check_answer("Run:\n```sql\nSELECT 1\n```", None, "ask", false);
        assert_eq!(blocks[0].body_sha256, sha256_hex("SELECT 1"));
        // Line ends are normalised first: the hash is of the text the editor will hold.
        let blocks = check_answer("```sql\r\nSELECT 1;\rSELECT 2\r\n```", None, "ask", false);
        assert_eq!(blocks[0].body_sha256, sha256_hex("SELECT 1;\nSELECT 2"));
        // Records saved before the hash load with none, which the UI reads as unchecked.
        let old: SqlBlock = serde_json::from_value(
            serde_json::json!({ "fence": 0, "label": "x", "statements": [] }),
        )
        .unwrap();
        assert_eq!(old.body_sha256, "");
    }

    #[test]
    fn a_lone_cr_is_a_line_end_as_in_the_editor() {
        // The editor turns a lone CR into a line break, so a write after a `--` comment and a
        // CR must be checked as the editor will hold it, on every Dialect.
        for dialect in [
            DialectKind::MySql,
            DialectKind::Sqlite,
            DialectKind::Postgres,
        ] {
            for body in [
                "SELECT 1; -- note\rDROP TABLE orders",
                "SELECT 1; # note\rDROP TABLE orders",
                "SELECT 1;\r\n-- note\rDROP TABLE orders",
            ] {
                if body.contains('#') && dialect != DialectKind::MySql {
                    continue;
                }
                let blocks =
                    check_answer(&format!("```sql\n{body}\n```"), Some(dialect), "ask", false);
                assert_eq!(blocks.len(), 1, "{dialect:?}: {body:?}");
                let writes: Vec<&str> = blocks[0]
                    .statements
                    .iter()
                    .filter(|s| s.class == StatementClass::Write)
                    .map(|s| s.text.as_str())
                    .collect();
                assert_eq!(writes.len(), 1, "{dialect:?}: {body:?}");
                assert!(writes[0].ends_with("DROP TABLE orders"), "{writes:?}");
                assert!(blocks[0].statements.iter().all(|s| !s.text.contains('\r')));
            }
        }
        // Fences are numbered on the same lines the UI's parser sees: a lone CR ends a line.
        let f = fences("```sql\rSELECT 1\r```\r```sql\nSELECT 2\n```");
        assert_eq!(f.len(), 2);
        assert_eq!(f[0].body, "SELECT 1");
        assert_eq!(f[1].body, "SELECT 2");
    }
    /// Task 4 review M9: an answer with no Dialect (an Ask with no Connection) is read under
    /// every Dialect and keeps the worst reading, so a statement that writes on any of them
    /// opens commented out whichever Connection the new query tab is then given.
    #[test]
    fn no_dialect_keeps_the_worst_reading() {
        // On PostgreSQL `--1` starts a comment; on MySQL `--` needs a space after it.
        let answer = "```sql\nSELECT 1 --1; DELETE FROM t\n```";
        let pg = check_answer(answer, Some(DialectKind::Postgres), "ask", false);
        assert!(
            pg[0]
                .statements
                .iter()
                .all(|s| s.class == StatementClass::Read),
            "{pg:?}"
        );
        let mysql = check_answer(answer, Some(DialectKind::MySql), "ask", false);
        let none = check_answer(answer, None, "ask", false);
        assert_eq!(none, mysql);
        assert!(
            none[0]
                .statements
                .iter()
                .any(|s| s.class == StatementClass::Write),
            "{none:?}"
        );
        // A write on every Dialect and a read on every Dialect read as before.
        for text in ["SELECT id FROM orders", "DELETE FROM orders WHERE id = 1"] {
            let answer = format!("```sql\n{text}\n```");
            assert_eq!(
                check_answer(&answer, None, "ask", false),
                check_answer(&answer, Some(DialectKind::Postgres), "ask", false),
                "{text}"
            );
        }
        // A function built into one Dialect is not "not checked" with no Dialect, when no
        // reading is worse: the PostgreSQL reading stays.
        let answer = "```sql\nSELECT ifnull(total, 0) FROM orders\n```";
        assert_eq!(
            check_answer(answer, None, "ask", false),
            check_answer(answer, Some(DialectKind::Postgres), "ask", false)
        );
        // A risky function on one Dialect only is flagged.
        let answer = "```sql\nSELECT load_file('/etc/hosts')\n```";
        let none = check_answer(answer, None, "ask", false);
        assert!(
            none[0].statements[0]
                .flags
                .iter()
                .any(|f| matches!(f, Flag::RiskyFunction { .. })),
            "{none:?}"
        );
    }
}
