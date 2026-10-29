//! The 5a lexer and classifier as they were before the byte lexer (10c682b), frozen for
//! the differential test only. Do not change it.

use super::StatementClass;
use crate::model::DialectKind;

/// Write when any top-level piece of `sql` writes; Read for text with only comments or whitespace.
pub(super) fn classify(dialect: DialectKind, sql: &str) -> StatementClass {
    let writes = |pieces: &[Piece]| {
        pieces
            .iter()
            .any(|p| p.forced_write || classify_tokens(dialect, &p.toks) == StatementClass::Write)
    };
    let (pieces, _) = lex(dialect, sql, false);
    if writes(&pieces) {
        return StatementClass::Write;
    }
    // Whether a backslash escapes a quote depends on server settings. When it matters, the
    // other reading also counts, unless it leaves a literal open (a syntax error there).
    if sql.contains('\\') {
        let (mut other, clean) = lex(dialect, sql, true);
        // An open literal runs to the end, so it sits in the last piece. The pieces before it
        // were closed by `;` and may already have run, so only that last piece is dropped.
        if !clean {
            other.pop();
        }
        if writes(&other) {
            return StatementClass::Write;
        }
    }
    StatementClass::Read
}

/// How many non-empty top-level pieces `sql` holds. When a backslash makes the quoting
/// ambiguous, the reading with more pieces counts.
pub(super) fn statement_count(dialect: DialectKind, sql: &str) -> usize {
    let (pieces, _) = lex(dialect, sql, false);
    let mut count = pieces.len();
    if sql.contains('\\') {
        let (other, clean) = lex(dialect, sql, true);
        count = count.max(other.len() - usize::from(!clean && !other.is_empty()));
    }
    count
}

/// The first word of the first piece of `sql`, upper-cased; `None` when it has none.
pub(super) fn leading_word(dialect: DialectKind, sql: &str) -> Option<String> {
    let (pieces, _) = lex(dialect, sql, false);
    let toks = &pieces.first()?.toks;
    toks.iter()
        .find_map(|t| word(t).map(|(w, _)| w.to_string()))
}

#[derive(Debug, PartialEq)]
enum Kind {
    /// Upper-cased bare word, number, variable or dotted name.
    Word(String),
    Open,
    Close,
    Eq,
    Comma,
    /// Quoted text, quoted identifier or punctuation.
    Other,
}

#[derive(Debug)]
struct Tok {
    kind: Kind,
    /// Parenthesis depth; for `Open` and `Close` the depth outside the pair.
    depth: usize,
    /// A quoted identifier, or MySQL `"..."`, which names a column under `ANSI_QUOTES`.
    quoted_name: bool,
}

#[derive(Default)]
struct Piece {
    toks: Vec<Tok>,
    /// A MySQL `/*! ... */` comment, which the server executes.
    forced_write: bool,
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '$' | '@' | '.')
}

/// Index just past the closing `quote`, where a doubled quote stays inside and, with
/// `backslash`, `\x` is skipped, and whether the literal was closed. An unterminated
/// literal runs to the end of the text.
fn skip_quoted(chars: &[char], start: usize, quote: char, backslash: bool) -> (usize, bool) {
    let mut i = start + 1;
    while i < chars.len() {
        let c = chars[i];
        if backslash && c == '\\' {
            i += 2;
        } else if c == quote {
            if chars.get(i + 1) == Some(&quote) {
                i += 2;
            } else {
                return (i + 1, true);
            }
        } else {
            i += 1;
        }
    }
    (chars.len(), false)
}

/// Length of a Postgres dollar-quote opener (`$$` or `$tag$`) at `start`, if there is one.
fn dollar_tag_len(chars: &[char], start: usize) -> Option<usize> {
    let mut i = start + 1;
    if chars.get(i).is_some_and(|c| c.is_alphabetic() || *c == '_') {
        while chars
            .get(i)
            .is_some_and(|c| c.is_alphanumeric() || *c == '_')
        {
            i += 1;
        }
    }
    (chars.get(i) == Some(&'$')).then(|| i + 1 - start)
}

/// With `flip`, backslash escapes are read the opposite way from the Dialect's default.
/// The bool is false when a quoted literal was left open.
fn lex(dialect: DialectKind, sql: &str, flip: bool) -> (Vec<Piece>, bool) {
    let mut clean = true;
    let mysql = dialect == DialectKind::MySql;
    let postgres = dialect == DialectKind::Postgres;
    let sqlite = dialect == DialectKind::Sqlite;
    let chars: Vec<char> = sql.chars().collect();
    let mut pieces = Vec::new();
    let mut cur = Piece::default();
    let mut depth = 0usize;
    let mut i = 0;
    // Where the last token ended, and whether it was the lone word `E` (Postgres `E'..'`).
    let mut last_end = 0;
    let mut last_was_e = false;

    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        // MySQL needs whitespace, a control character or the end after `--`.
        let dash_comment = c == '-'
            && next == Some('-')
            && (!mysql
                || chars
                    .get(i + 2)
                    .is_none_or(|c| c.is_whitespace() || c.is_control()));
        if dash_comment || mysql && c == '#' {
            // PostgreSQL ends a line comment at a lone CR too.
            while i < chars.len() && chars[i] != '\n' && !(postgres && chars[i] == '\r') {
                i += 1;
            }
            continue;
        }
        if c == '/' && next == Some('*') {
            // `/*! */` and MariaDB's `/*M! */` are executed by the server.
            let executed = chars.get(i + 2) == Some(&'!')
                || (chars.get(i + 2) == Some(&'M') && chars.get(i + 3) == Some(&'!'));
            if mysql && executed {
                cur.forced_write = true;
            }
            let mut level = 1;
            i += 2;
            while i < chars.len() && level > 0 {
                if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    level -= 1;
                    i += 2;
                } else if postgres && chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                    level += 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            continue;
        }

        let start = i;
        let mut kind = Kind::Other;
        let mut e_word = false;
        match c {
            ';' => {
                i += 1;
                if !cur.toks.is_empty() || cur.forced_write {
                    pieces.push(std::mem::take(&mut cur));
                }
                depth = 0;
                continue;
            }
            '(' => {
                kind = Kind::Open;
                i += 1;
            }
            ')' => {
                kind = Kind::Close;
                i += 1;
            }
            '=' => {
                kind = Kind::Eq;
                i += 1;
            }
            ',' => {
                kind = Kind::Comma;
                i += 1;
            }
            '\'' => {
                let escapes = if mysql {
                    !flip
                } else {
                    flip || postgres && last_was_e && last_end == i
                };
                let (end, closed) = skip_quoted(&chars, i, '\'', escapes);
                i = end;
                clean &= closed;
            }
            '"' => {
                let (end, closed) = skip_quoted(&chars, i, '"', mysql && !flip);
                i = end;
                clean &= closed;
            }
            '`' if mysql || sqlite => i = skip_quoted(&chars, i, '`', false).0,
            '[' if sqlite => {
                i += 1;
                while i < chars.len() && chars[i] != ']' {
                    i += 1;
                }
                i = (i + 1).min(chars.len());
            }
            '$' if postgres && dollar_tag_len(&chars, i).is_some() => {
                let tag = dollar_tag_len(&chars, i).unwrap_or(2);
                let opener: Vec<char> = chars[i..i + tag].to_vec();
                i += tag;
                while i < chars.len() && !chars[i..].starts_with(&opener) {
                    i += 1;
                }
                i = (i + tag).min(chars.len());
            }
            c if is_word_char(c) => {
                while i < chars.len() && is_word_char(chars[i]) {
                    i += 1;
                }
                let word: String = chars[start..i].iter().collect();
                e_word = word.eq_ignore_ascii_case("e");
                kind = Kind::Word(word.to_uppercase());
            }
            _ => i += 1,
        }

        // `"set_config"(...)` must not slip past the word check by being quoted.
        let quoted_ident =
            (c == '"' && !mysql) || (c == '`' && (mysql || sqlite)) || (c == '[' && sqlite);
        if quoted_ident {
            let content: String = chars[start + 1..i.saturating_sub(1).max(start + 1)]
                .iter()
                .collect();
            // A Postgres `U&"..."` name can spell `set_config` in escapes, so any one writes.
            let unicode_escaped = postgres
                && start >= 2
                && chars[start - 1] == '&'
                && chars[start - 2].eq_ignore_ascii_case(&'u')
                && (start == 2 || !is_word_char(chars[start - 3]));
            if unicode_escaped || content.eq_ignore_ascii_case("set_config") {
                cur.forced_write = true;
            }
        }

        let tok_depth = match kind {
            Kind::Open => {
                depth += 1;
                depth - 1
            }
            Kind::Close => {
                depth = depth.saturating_sub(1);
                depth
            }
            _ => depth,
        };
        cur.toks.push(Tok {
            kind,
            depth: tok_depth,
            quoted_name: quoted_ident || (c == '"' && mysql),
        });
        last_end = i;
        last_was_e = e_word;
    }
    if !cur.toks.is_empty() || cur.forced_write {
        pieces.push(cur);
    }
    (pieces, clean)
}

/// Last dotted segment without a leading `@`: `@@SESSION.TX_READ_ONLY` becomes `TX_READ_ONLY`.
fn base_name(w: &str) -> &str {
    w.rsplit('.').next().unwrap_or(w).trim_start_matches('@')
}

fn word(t: &Tok) -> Option<(&str, usize)> {
    match &t.kind {
        Kind::Word(w) => Some((w.as_str(), t.depth)),
        _ => None,
    }
}

fn has_pair(words: &[&str], a: &str, b: &str) -> bool {
    words.windows(2).any(|w| w[0] == a && w[1] == b)
}

fn classify_tokens(dialect: DialectKind, toks: &[Tok]) -> StatementClass {
    use StatementClass::{Read, Write};
    // Only leading `(` may come before the first word, as in `(SELECT 1) UNION (SELECT 2)`.
    let Some(start) = toks.iter().position(|t| word(t).is_some()) else {
        return Write;
    };
    if toks[..start].iter().any(|t| t.kind != Kind::Open) {
        return Write;
    }
    let words: Vec<(&str, usize)> = toks[start..].iter().filter_map(word).collect();
    let base = words[0].1;
    let top: Vec<&str> = words
        .iter()
        .filter(|(_, d)| *d <= base)
        .map(|(w, _)| *w)
        .collect();
    let all: Vec<&str> = words.iter().map(|(w, _)| *w).collect();

    // A function that changes session settings can sit anywhere in a query.
    if all.iter().any(|w| base_name(w) == "SET_CONFIG") {
        return Write;
    }

    match top[0] {
        "SELECT" => select_class(&all),
        "WITH" => {
            if all
                .iter()
                .any(|w| matches!(*w, "INSERT" | "UPDATE" | "DELETE" | "MERGE"))
            {
                Write
            } else {
                select_class(&all)
            }
        }
        // MySQL's DESC and DESCRIBE are EXPLAIN synonyms, including `DESC ANALYZE <stmt>`.
        "DESCRIBE" | "DESC" => explain_class(dialect, &toks[start + 1..]),
        "COMMIT" | "ROLLBACK" if top.get(1) == Some(&"PREPARED") => Write,
        "SHOW" | "VALUES" | "USE" | "COMMIT" | "ROLLBACK" | "SAVEPOINT" | "RELEASE" => Read,
        "TABLE" | "END" if dialect == DialectKind::Postgres => Read,
        "PRAGMA" if dialect == DialectKind::Sqlite => pragma_class(&toks[start..], &all),
        "EXPLAIN" => explain_class(dialect, &toks[start + 1..]),
        "BEGIN" => {
            if has_pair(&all, "READ", "WRITE") {
                Write
            } else {
                Read
            }
        }
        "START" => {
            if top.get(1) == Some(&"TRANSACTION") && !has_pair(&all, "READ", "WRITE") {
                Read
            } else {
                Write
            }
        }
        "SET" => set_class(dialect, &toks[start..], &all),
        _ => Write,
    }
}

/// `toks` starts at `PRAGMA`. Setting forms write; the `name(value)` form reads only for
/// pragmas that take an argument to look something up.
fn pragma_class(toks: &[Tok], all: &[&str]) -> StatementClass {
    const LOOKUPS: [&str; 10] = [
        "TABLE_LIST",
        "TABLE_INFO",
        "TABLE_XINFO",
        "INDEX_LIST",
        "INDEX_INFO",
        "INDEX_XINFO",
        "FOREIGN_KEY_LIST",
        "FOREIGN_KEY_CHECK",
        "INTEGRITY_CHECK",
        "QUICK_CHECK",
    ];
    if toks.iter().any(|t| t.kind == Kind::Eq) {
        return StatementClass::Write;
    }
    let called = toks.iter().any(|t| t.kind == Kind::Open);
    let name = all.get(1).map_or("", |w| base_name(w));
    if called && !LOOKUPS.contains(&name) {
        StatementClass::Write
    } else {
        StatementClass::Read
    }
}

fn select_class(top: &[&str]) -> StatementClass {
    let locking = top.contains(&"INTO")
        || top.windows(2).any(|w| {
            (w[0] == "FOR" && matches!(w[1], "UPDATE" | "SHARE" | "NO" | "KEY"))
                || (w[0] == "LOCK" && w[1] == "IN")
        });
    if locking {
        StatementClass::Write
    } else {
        StatementClass::Read
    }
}

/// `rest` is everything after `EXPLAIN`. Only `ANALYZE` runs the statement.
fn explain_class(dialect: DialectKind, rest: &[Tok]) -> StatementClass {
    let is_analyze = |w: &str| matches!(w, "ANALYZE" | "ANALYSE");
    let inner = match rest.first().map(|t| &t.kind) {
        Some(Kind::Word(w)) if is_analyze(w) => &rest[1..],
        Some(Kind::Open) => {
            let open_depth = rest[0].depth;
            let Some(close) = rest
                .iter()
                .position(|t| t.kind == Kind::Close && t.depth == open_depth)
            else {
                // Unclosed option list: not a statement the server would accept as a read.
                return StatementClass::Write;
            };
            // A quoted option could be spelled ANALYZE, so any quoted token counts.
            let analyze = rest[1..close].iter().any(|t| match &t.kind {
                Kind::Word(w) => is_analyze(w),
                Kind::Other => true,
                _ => false,
            });
            if !analyze {
                return StatementClass::Read;
            }
            &rest[close + 1..]
        }
        _ => return StatementClass::Read,
    };
    let mut inner = inner;
    // Skip `VERBOSE` and MySQL's `FORMAT = TREE` between ANALYZE and the statement.
    loop {
        match inner.first().map(|t| &t.kind) {
            Some(Kind::Word(w)) if w == "VERBOSE" => inner = &inner[1..],
            Some(Kind::Word(w))
                if w == "FORMAT" && inner.get(1).is_some_and(|t| t.kind == Kind::Eq) =>
            {
                inner = &inner[(3).min(inner.len())..];
            }
            _ => break,
        }
    }
    if inner.is_empty() {
        StatementClass::Write
    } else {
        classify_tokens(dialect, inner)
    }
}

/// Whether a quoted name sits where a SET names its setting: before the `=` or `TO`, in
/// each assignment. Quoting can spell any setting, `U&"..."` escapes included, so the
/// name is never read. Postgres sets one setting, so a comma there starts another value.
fn quoted_setting_name(dialect: DialectKind, toks: &[Tok]) -> bool {
    let Some(set) = toks.first() else {
        return false;
    };
    let mut in_name = true;
    for t in &toks[1..] {
        match &t.kind {
            Kind::Comma if t.depth == set.depth && dialect != DialectKind::Postgres => {
                in_name = true;
            }
            Kind::Eq => in_name = false,
            Kind::Word(w) if w == "TO" => in_name = false,
            _ if in_name && t.quoted_name => return true,
            _ => {}
        }
    }
    false
}

/// `toks` starts at `SET`; `all` holds every word of the piece.
fn set_class(dialect: DialectKind, toks: &[Tok], all: &[&str]) -> StatementClass {
    if quoted_setting_name(dialect, toks) {
        return StatementClass::Write;
    }
    const PERSISTENT: [&str; 3] = ["GLOBAL", "PERSIST", "PERSIST_ONLY"];
    const READ_ONLY_FLAGS: [&str; 3] = [
        "DEFAULT_TRANSACTION_READ_ONLY",
        "TRANSACTION_READ_ONLY",
        "TX_READ_ONLY",
    ];
    if has_pair(all, "READ", "WRITE") {
        return StatementClass::Write;
    }
    if all.iter().any(|w| {
        w.starts_with("@@GLOBAL.")
            || w.starts_with("@@PERSIST.")
            || w.starts_with("@@PERSIST_ONLY.")
    }) {
        return StatementClass::Write;
    }
    // `SET GLOBAL x = 1, SESSION y = 2`: the scope word starts each assignment.
    let scope_word = |i: usize| match &toks[i].kind {
        Kind::Word(w) => PERSISTENT.contains(&w.as_str()),
        _ => false,
    };
    if toks.len() > 1 && scope_word(1) {
        return StatementClass::Write;
    }
    for i in 1..toks.len() {
        if toks[i - 1].kind == Kind::Comma && scope_word(i) {
            return StatementClass::Write;
        }
    }
    // Account and resource-group changes.
    if all.get(1) == Some(&"PASSWORD")
        || has_pair(all, "DEFAULT", "ROLE")
        || has_pair(all, "RESOURCE", "GROUP")
    {
        return StatementClass::Write;
    }
    // Any word may name the flag (`SET autocommit = 0, transaction_read_only = 0`).
    if all.iter().any(|w| READ_ONLY_FLAGS.contains(&base_name(w))) {
        StatementClass::Write
    } else {
        StatementClass::Read
    }
}
