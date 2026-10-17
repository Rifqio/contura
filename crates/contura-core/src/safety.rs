use serde::Serialize;

use crate::model::{ConnectionConfig, DialectKind};

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StatementClass {
    Read,
    Write,
}

/// Write when any top-level piece of `sql` writes; Read for text with only comments or whitespace.
pub fn classify(dialect: DialectKind, sql: &str) -> StatementClass {
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

/// Proof that the user confirmed one run; see `ConnectionService::confirm_run`.
pub type PassId = uuid::Uuid;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedStatement {
    pub text: String,
    pub class: StatementClass,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RunVerdict {
    Ok,
    /// The index of the first statement that writes.
    ReadOnly {
        statement: usize,
    },
    NeedsConfirmation {
        connection: String,
        database: Option<String>,
        statements: Vec<PlannedStatement>,
        writes: usize,
    },
}

/// Pure decision: Read-only wins over Production.
pub fn verdict(
    conn: &ConnectionConfig,
    database: Option<&str>,
    statements: &[String],
) -> RunVerdict {
    if !conn.production && !conn.read_only {
        return RunVerdict::Ok;
    }
    let planned: Vec<PlannedStatement> = statements
        .iter()
        .map(|text| PlannedStatement {
            text: text.clone(),
            class: classify(conn.dialect, text),
        })
        .collect();
    let writes = planned
        .iter()
        .filter(|p| p.class == StatementClass::Write)
        .count();
    if conn.read_only {
        return match planned
            .iter()
            .position(|p| p.class == StatementClass::Write)
        {
            Some(statement) => RunVerdict::ReadOnly { statement },
            None => RunVerdict::Ok,
        };
    }
    if writes == 0 {
        return RunVerdict::Ok;
    }
    RunVerdict::NeedsConfirmation {
        connection: conn.name.clone(),
        database: database.map(str::to_string),
        statements: planned,
        writes,
    }
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
            while i < chars.len() && chars[i] != '\n' {
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

#[cfg(test)]
mod tests {
    use super::*;

    const PG: DialectKind = DialectKind::Postgres;
    const MY: DialectKind = DialectKind::MySql;
    const SL: DialectKind = DialectKind::Sqlite;
    const R: StatementClass = StatementClass::Read;
    const W: StatementClass = StatementClass::Write;

    const CASES: &[(DialectKind, &str, StatementClass)] = &[
        // Postgres
        (PG, "select 1", R),
        (PG, "SELECT 'DELETE FROM x'", R),
        (PG, "/* drop */ SELECT 1", R),
        (PG, "-- delete\nSELECT 1", R),
        (PG, "SELECT $$ DELETE $$", R),
        (PG, "SELECT $a$ ; DROP TABLE t; $a$", R),
        (
            PG,
            "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
            W,
        ),
        (PG, "WITH c AS (SELECT 1) SELECT * FROM c", R),
        (PG, "SELECT * INTO new_t FROM t", W),
        (PG, "SELECT * FROM t FOR UPDATE", W),
        (PG, "EXPLAIN SELECT 1", R),
        (PG, "EXPLAIN ANALYZE DELETE FROM t", W),
        (PG, "EXPLAIN (ANALYZE, BUFFERS) UPDATE t SET a = 1", W),
        (PG, "EXPLAIN ANALYZE SELECT 1", R),
        (PG, "TABLE orders", R),
        (PG, "BEGIN", R),
        (PG, "BEGIN READ WRITE", W),
        (PG, "SET search_path = shop", R),
        (PG, "SET default_transaction_read_only = off", W),
        (
            PG,
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
            W,
        ),
        (PG, "COPY t FROM '/tmp/x'", W),
        (PG, "DO $$ BEGIN END $$", W),
        (PG, "CALL p()", W),
        (PG, "VACUUM", W),
        (PG, "", R),
        (PG, "  -- only a comment", R),
        (PG, "SELECT 1; DELETE FROM t", W),
        (PG, "frobnicate", W),
        (PG, "\"DELETE\"", W),
        (PG, "SELECT updated_at, \"update\" FROM t", R),
        (PG, "SELECT a.id, b.name FROM a JOIN b ON b.a_id = a.id", R),
        (PG, "SELECT * FROM (SELECT id FROM t) s WHERE id > 1", R),
        (PG, "/* a /* nested */ DROP TABLE t */ SELECT 1", R),
        (PG, "SELECT 'it''s; DROP TABLE t'", R),
        (PG, "SELECT E'it\\'s; DROP TABLE t'", R),
        (PG, "INSERT INTO t VALUES (1)", W),
        (PG, "update t set a = 1", W),
        (PG, "DELETE FROM t", W),
        (PG, "TRUNCATE t", W),
        (PG, "CREATE TABLE t (a int)", W),
        (PG, "DROP TABLE t", W),
        (PG, "ALTER TABLE t ADD COLUMN b int", W),
        (PG, "GRANT SELECT ON t TO u", W),
        (PG, "LOCK TABLE t", W),
        (PG, "ANALYZE t", W),
        (PG, "SHOW search_path", R),
        (PG, "VALUES (1), (2)", R),
        (PG, "COMMIT", R),
        (PG, "END", R),
        (PG, "ROLLBACK", R),
        (PG, "SAVEPOINT s1", R),
        (PG, "RELEASE SAVEPOINT s1", R),
        (PG, "SET transaction_read_only = off", W),
        (PG, "SET LOCAL transaction_read_only TO off", W),
        (PG, "SET TRANSACTION READ ONLY", R),
        (PG, "BEGIN; SELECT 1; COMMIT;", R),
        (PG, "BEGIN; DELETE FROM t; COMMIT;", W),
        (PG, "SELECT 1;;SELECT 2", R),
        (PG, "(SELECT 1) UNION (SELECT 2)", R),
        (PG, "SELECT * FROM t FOR SHARE", W),
        (PG, "SELECT * FROM t FOR NO KEY UPDATE", W),
        (PG, "SELECT * FROM t FOR KEY SHARE", W),
        (PG, "SELECT * FROM (SELECT 1 FROM t FOR UPDATE) s", W),
        (PG, "EXPLAIN ANALYSE DELETE FROM t", W),
        (PG, "EXPLAIN (ANALYSE) DELETE FROM t", W),
        (PG, "EXPLAIN (\"analyze\") DELETE FROM t", W),
        (PG, "EXPLAIN (", W),
        (PG, "EXPLAIN (ANALYZE", W),
        (PG, "SELECT 'x\\''; DELETE FROM t; --'", W),
        (PG, "SELECT 'it''s'", R),
        (
            PG,
            "SELECT set_config('transaction_read_only', 'off', false)",
            W,
        ),
        (PG, "SELECT pg_catalog.SET_CONFIG('a', 'b', false)", W),
        (
            PG,
            "SELECT \"set_config\"('default_transaction_read_only','off',false)",
            W,
        ),
        (PG, "SELECT pg_catalog.\"set_config\"('x','y',false)", W),
        (PG, "SELECT \"set_config2\"(1)", R),
        (
            PG,
            "SELECT U&\"\\0073et_config\"('default_transaction_read_only','off',false)",
            W,
        ),
        (PG, "SELECT u&\"col\" FROM t", W),
        (PG, "SELECT menu&\"x\" FROM t", R),
        (PG, "COMMIT PREPARED 'x'", W),
        (PG, "ROLLBACK PREPARED 'x'", W),
        (PG, "SELECT 1 FROM (SELECT * INTO t2 FROM t) s", W),
        (
            PG,
            "WITH u AS (UPDATE t SET a = 1 RETURNING a) SELECT * FROM u",
            W,
        ),
        (
            PG,
            "WITH i AS (INSERT INTO t VALUES (1) RETURNING a) SELECT * FROM i",
            W,
        ),
        (
            PG,
            "WITH m AS (MERGE INTO t USING s ON true WHEN MATCHED THEN DO NOTHING RETURNING 1) SELECT 1",
            W,
        ),
        (PG, "EXPLAIN (FORMAT JSON) DELETE FROM t", R),
        (PG, "EXPLAIN (ANALYZE) SELECT 1", R),
        (PG, "WITH c AS (SELECT 1) DELETE FROM t", W),
        // A quoted setting name writes whatever it names, since quoting can hide the name.
        (PG, "SET \"default_transaction_read_only\" = off", W),
        (
            PG,
            "SET SESSION \"default_transaction_read_only\" TO off",
            W,
        ),
        (PG, "SET U&\"default_transaction_read_onl\\0079\" = off", W),
        (PG, "SET \"search_path\" = shop", W),
        (PG, "SET search_path = \"Shop\", public", R),
        (PG, "SET search_path TO \"Shop\"", R),
        // MySQL
        // Without `=` the quoted value sits where a name would, so it asks first (decided).
        (MY, "SET NAMES \"utf8mb4\"", W),
        (MY, "SELECT 'a\\'; DELETE FROM t; SELECT '", W),
        (MY, "SELECT \"a\\\"; DELETE FROM t; SELECT \"", W),
        (MY, "SELECT 'it\\'s; DROP TABLE t'", R),
        (MY, "SELECT 1 --1; DELETE FROM t", W),
        (MY, "SELECT 1 -- 1; DELETE FROM t", R),
        (MY, "SELECT 1 --", R),
        (MY, "SET @@transaction_read_only = 0", W),
        (MY, "SET @@tx_read_only = 0", W),
        (MY, "SET autocommit = 0, transaction_read_only = 0", W),
        (MY, "DESC ANALYZE DELETE a FROM a JOIN b ON a.id = b.id", W),
        (MY, "DESCRIBE ANALYZE DELETE FROM t", W),
        (MY, "DESC orders", R),
        (MY, "SELECT 'a\\'; DELETE FROM t; -- '", W),
        (MY, "SELECT \"a\\\"; DELETE FROM t; -- \"", W),
        (MY, "SELECT 'it''s'", R),
        (MY, "/*M!100000 DELETE FROM t */", W),
        (MY, "SET PASSWORD = 'x'", W),
        (MY, "SET DEFAULT ROLE ALL TO u", W),
        (MY, "SET RESOURCE GROUP rg", W),
        (MY, "EXPLAIN ANALYSE DELETE FROM t", W),
        (MY, "# delete\nSELECT 1", R),
        (MY, "SELECT \"DELETE\"", R),
        (MY, "SELECT `delete` FROM t", R),
        (MY, "SELECT 'it\\'s; DROP TABLE t'", R),
        (MY, "SHOW TABLES", R),
        (MY, "DESC orders", R),
        (MY, "USE shop", R),
        (MY, "START TRANSACTION", R),
        (MY, "START TRANSACTION READ WRITE", W),
        (MY, "SET SESSION TRANSACTION READ WRITE", W),
        (MY, "SET TRANSACTION READ WRITE", W),
        (MY, "SET transaction_read_only = 0", W),
        (MY, "SET GLOBAL max_connections = 10", W),
        (MY, "SET PERSIST x = 1", W),
        (MY, "SET @@GLOBAL.x = 1", W),
        (MY, "SET NAMES utf8mb4", R),
        (MY, "SELECT * FROM t LOCK IN SHARE MODE", W),
        (MY, "SELECT a INTO @v FROM t", W),
        (MY, "LOAD DATA INFILE 'x' INTO TABLE t", W),
        (MY, "insert into t values (1)", W),
        (MY, "REPLACE INTO t VALUES (1)", W),
        (MY, "TRUNCATE t", W),
        (MY, "SELECT 1; DROP TABLE t", W),
        (MY, "SELECT updated_at, `update` FROM t", R),
        (
            MY,
            "SELECT u.id FROM users u LEFT JOIN orders o ON o.uid = u.id",
            R,
        ),
        (MY, "SELECT * FROM t WHERE a IN (SELECT a FROM s)", R),
        (MY, "/* c */ SELECT 1 -- x", R),
        (MY, "/*!50000 DELETE FROM t */", W),
        (MY, "SELECT 1 /*!50000 , 2 */", W),
        (MY, "SELECT 'a\\\\'; DELETE FROM t", W),
        (MY, "SELECT `a``b` FROM t", R),
        (MY, "SELECT \"a\"\"b; DROP\"", R),
        (MY, "UPDATE t SET a = 1", W),
        (MY, "DELETE FROM t", W),
        (MY, "CREATE TABLE t (a int)", W),
        (MY, "DROP DATABASE d", W),
        (MY, "ALTER TABLE t DROP COLUMN a", W),
        (MY, "CALL p()", W),
        (MY, "DO SLEEP(1)", W),
        (MY, "GRANT ALL ON *.* TO u", W),
        (MY, "LOCK TABLES t WRITE", W),
        (MY, "DESCRIBE orders", R),
        (MY, "EXPLAIN SELECT * FROM t", R),
        (MY, "EXPLAIN DELETE FROM t", R),
        (MY, "EXPLAIN ANALYZE SELECT * FROM t", R),
        (MY, "EXPLAIN ANALYZE FORMAT=TREE SELECT * FROM t", R),
        (MY, "BEGIN", R),
        (MY, "BEGIN WORK", R),
        (MY, "COMMIT", R),
        (MY, "ROLLBACK", R),
        (MY, "SAVEPOINT s", R),
        (MY, "RELEASE SAVEPOINT s", R),
        (MY, "START SLAVE", W),
        (MY, "WITH c AS (SELECT 1) SELECT * FROM c", R),
        (MY, "WITH c AS (SELECT 1) DELETE FROM t", W),
        (MY, "SET autocommit = 0", R),
        (MY, "SET @a = 1", R),
        (MY, "SET @@SESSION.tx_read_only = 0", W),
        (MY, "SET SESSION TRANSACTION READ ONLY", R),
        (MY, "SET sql_mode = ''", R),
        (MY, "SELECT * FROM t FOR UPDATE", W),
        (MY, "SELECT * FROM t INTO OUTFILE '/tmp/x'", W),
        (MY, "TABLE t", W),
        (MY, "VALUES ROW(1)", R),
        (MY, "SET SESSION `transaction_read_only` = 0", W),
        (MY, "SET @@session.`transaction_read_only` = 0", W),
        (MY, "SET autocommit = 0, `tx_read_only` = 0", W),
        (MY, "SET \"transaction_read_only\" = 0", W),
        (MY, "SET sql_mode = \"ANSI\"", R),
        (MY, "SET @a = 1, @b = (SELECT 2)", R),
        // SQLite
        (SL, "PRAGMA user_version(5)", W),
        (SL, "PRAGMA journal_mode(DELETE)", W),
        (SL, "PRAGMA main.user_version(5)", W),
        (SL, "PRAGMA table_info(t)", R),
        (SL, "PRAGMA index_list(t)", R),
        (SL, "PRAGMA table_list(t)", R),
        (SL, "PRAGMA integrity_check", R),
        (SL, "PRAGMA quick_check(1)", R),
        (SL, "PRAGMA table_info(t)", R),
        (SL, "PRAGMA foreign_keys = ON", W),
        (SL, "PRAGMA journal_mode", R),
        (SL, "SELECT [delete] FROM t", R),
        (SL, "ATTACH 'x.db' AS x", W),
        (SL, "VACUUM", W),
        (SL, "CREATE TABLE t (a)", W),
        (
            SL,
            "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 5) SELECT * FROM c",
            R,
        ),
        (SL, "SELECT updated_at, \"update\" FROM t", R),
        (SL, "SELECT `delete` FROM t", R),
        (SL, "SELECT 'a;b'; SELECT 2", R),
        (SL, "SELECT 1; INSERT INTO t VALUES (1)", W),
        (SL, "# not a comment here", W),
        (SL, "SELECT 1 # x", R),
        (SL, "INSERT INTO t VALUES (1)", W),
        (SL, "insert or replace into t values (1)", W),
        (SL, "UPDATE t SET a = 1", W),
        (SL, "DELETE FROM t", W),
        (SL, "DROP TABLE t", W),
        (SL, "ALTER TABLE t ADD COLUMN b", W),
        (SL, "REPLACE INTO t VALUES (1)", W),
        (SL, "EXPLAIN QUERY PLAN SELECT 1", R),
        (SL, "EXPLAIN DELETE FROM t", R),
        (SL, "BEGIN", R),
        (SL, "BEGIN IMMEDIATE", R),
        (SL, "COMMIT", R),
        (SL, "ROLLBACK", R),
        (SL, "SAVEPOINT s", R),
        (SL, "RELEASE s", R),
        (SL, "SELECT a.id FROM a JOIN b ON b.a_id = a.id", R),
        (SL, "SELECT * FROM (SELECT 1) s", R),
        (SL, "VALUES (1), (2)", R),
        (SL, "PRAGMA table_list", R),
        (SL, "PRAGMA user_version = 3", W),
        (SL, "DETACH x", W),
        (SL, "ANALYZE", W),
        (SL, "REINDEX", W),
        (SL, "CREATE INDEX i ON t (a)", W),
        (SL, "WITH c AS (SELECT 1) DELETE FROM t", W),
        (SL, "WITH c AS (SELECT 1) SELECT * FROM c", R),
        (SL, "/* c */ SELECT 1", R),
        (SL, "-- c\nSELECT 1", R),
        (SL, "SELECT * FROM t WHERE a IN (SELECT a FROM s)", R),
        (SL, "", R),
        (SL, "   ", R),
        (SL, "SELECT 'x\\'; DELETE FROM t", W),
        (SL, "frobnicate", W),
    ];

    #[test]
    fn classifier_table() {
        for (dialect, sql, expected) in CASES {
            assert_eq!(classify(*dialect, sql), *expected, "{dialect:?}: {sql:?}");
        }
        for d in [PG, MY, SL] {
            let n = CASES.iter().filter(|(c, _, _)| *c == d).count();
            assert!(n >= 40, "{d:?} has only {n} rows");
        }
    }
}

#[cfg(test)]
mod verdict_tests {
    use super::*;
    use crate::model::{ConnectionConfig, SslMode};

    fn conn(production: bool, read_only: bool) -> ConnectionConfig {
        ConnectionConfig {
            id: uuid::Uuid::nil(),
            name: "shop".into(),
            dialect: DialectKind::Sqlite,
            host: String::new(),
            port: 0,
            user: String::new(),
            database: None,
            ssl: SslMode::Disable,
            group_id: None,
            file: None,
            query_timeout_secs: None,
            ai_access: Default::default(),
            production,
            read_only,
        }
    }

    fn script() -> Vec<String> {
        ["SELECT 1", "UPDATE t SET a=1", "DELETE FROM t"]
            .map(String::from)
            .to_vec()
    }

    #[test]
    fn verdict_ok_for_reads_on_production() {
        let reads = vec!["SELECT 1".to_string(), "SELECT 2".to_string()];
        assert_eq!(verdict(&conn(true, false), None, &reads), RunVerdict::Ok);
    }

    #[test]
    fn verdict_read_only_points_at_first_write() {
        assert_eq!(
            verdict(&conn(false, true), None, &script()),
            RunVerdict::ReadOnly { statement: 1 }
        );
    }

    #[test]
    fn verdict_production_counts_writes() {
        let v = verdict(&conn(true, false), Some("db1"), &script());
        let RunVerdict::NeedsConfirmation {
            connection,
            database,
            statements,
            writes,
        } = v
        else {
            panic!("expected NeedsConfirmation, got {v:?}");
        };
        assert_eq!(connection, "shop");
        assert_eq!(database.as_deref(), Some("db1"));
        assert_eq!(writes, 2);
        let classes: Vec<StatementClass> = statements.iter().map(|s| s.class).collect();
        assert_eq!(
            classes,
            [
                StatementClass::Read,
                StatementClass::Write,
                StatementClass::Write
            ]
        );
        assert_eq!(statements[1].text, "UPDATE t SET a=1");
    }

    #[test]
    fn read_only_wins_over_production() {
        assert_eq!(
            verdict(&conn(true, true), None, &script()),
            RunVerdict::ReadOnly { statement: 1 }
        );
    }

    #[test]
    fn plain_connection_is_ok() {
        assert_eq!(
            verdict(&conn(false, false), None, &script()),
            RunVerdict::Ok
        );
    }
}
