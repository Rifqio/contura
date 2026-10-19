//! Object names in one statement, for Restore (step 9): the table a literal-rows INSERT
//! writes to, the object a CREATE makes, and the tables, indexes and Foreign Keys a DDL
//! statement adds. Read with the same lexer as the lists and the INSERT shape, so quotes
//! and comments are read the way the server reads them.

use std::iter::Peekable;

use crate::model::{DialectKind, ObjectKind};

use super::tokens::{K, Lexer, Tok, lex};

/// A name's parts, unquoted: `"billing"."Customers"` is `["billing", "Customers"]`. An
/// unquoted PostgreSQL name is folded to lower case, as the server folds it.
pub(crate) type Name = Vec<String>;

/// What one DDL statement adds, for the confirmation's count line.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct DdlCounts {
    pub tables: u64,
    pub indexes: u64,
    pub foreign_keys: u64,
}

impl DdlCounts {
    pub(crate) fn add(&mut self, o: DdlCounts) {
        self.tables += o.tables;
        self.indexes += o.indexes;
        self.foreign_keys += o.foreign_keys;
    }
}

/// One name part, unquoted. A MySQL `"..."` is a string, never a name.
fn part(dialect: DialectKind, text: &str, t: Tok) -> Option<String> {
    let s = &text[t.start..t.end];
    match t.k {
        K::Word => Some(if dialect == DialectKind::Postgres {
            s.to_lowercase()
        } else {
            s.to_string()
        }),
        K::Ident => {
            let (open, close, doubled) = match s.as_bytes().first()? {
                b'"' => ('"', '"', "\"\""),
                b'`' => ('`', '`', "``"),
                b'[' => ('[', ']', ""),
                _ => return None,
            };
            // An identifier left open runs to the end of the statement: not a name.
            if s.len() < 2 || !s.ends_with(close) {
                return None;
            }
            let inner = &s[open.len_utf8()..s.len() - close.len_utf8()];
            Some(if doubled.is_empty() {
                inner.to_string()
            } else {
                inner.replace(doubled, &open.to_string())
            })
        }
        _ => None,
    }
}

/// A dotted name at the front of `toks`.
fn name(dialect: DialectKind, text: &str, toks: &mut Peekable<Lexer<'_>>) -> Option<Name> {
    // A PostgreSQL `U&"..."` name reads as the word `U`, then `&`: no name we can read.
    let unicode = |toks: &mut Peekable<Lexer<'_>>| toks.peek().is_some_and(|t| t.is_punct(b'&'));
    let mut parts = vec![part(dialect, text, toks.next()?)?];
    if unicode(toks) {
        return None;
    }
    while toks.peek().is_some_and(|t| t.is_punct(b'.')) {
        toks.next();
        parts.push(part(dialect, text, toks.next()?)?);
        if unicode(toks) {
            return None;
        }
    }
    Some(parts)
}

fn peek_is(toks: &mut Peekable<Lexer<'_>>, text: &str, w: &str) -> bool {
    toks.peek().is_some_and(|t| t.is(text, w))
}

/// The table an `INSERT` names (not `REPLACE`, which deletes rows): MySQL's modifiers,
/// SQLite's `OR <action>` and MySQL's optional `INTO` are passed over.
pub(crate) fn insert_table(dialect: DialectKind, text: &str) -> Option<Name> {
    let mut toks = lex(dialect, text, false).peekable();
    if !toks.next()?.is(text, "INSERT") {
        return None;
    }
    if dialect == DialectKind::MySql {
        while ["LOW_PRIORITY", "DELAYED", "HIGH_PRIORITY", "IGNORE"]
            .iter()
            .any(|w| peek_is(&mut toks, text, w))
        {
            toks.next();
        }
    }
    if dialect == DialectKind::Sqlite && peek_is(&mut toks, text, "OR") {
        toks.next();
        toks.next();
    }
    if peek_is(&mut toks, text, "INTO") {
        toks.next();
    }
    name(dialect, text, &mut toks)
}

/// Words a CREATE that makes no object Restore tracks stops at.
const OTHER_OBJECTS: [&str; 9] = [
    "INDEX",
    "TYPE",
    "SEQUENCE",
    "SCHEMA",
    "DATABASE",
    "EXTENSION",
    "DOMAIN",
    "USER",
    "ROLE",
];

/// The table, view, function, procedure or trigger a CREATE statement makes, with its
/// name. The words between CREATE and the kind (`OR REPLACE`, `TEMPORARY`, `UNLOGGED`,
/// `MATERIALIZED`, `VIRTUAL`, MySQL's `ALGORITHM=..`, `DEFINER=..`, `SQL SECURITY ..`)
/// are passed over; `IF NOT EXISTS` after the kind too.
pub(crate) fn created_object(dialect: DialectKind, text: &str) -> Option<(ObjectKind, Name)> {
    let mut toks = lex(dialect, text, false).peekable();
    if !toks.next()?.is(text, "CREATE") {
        return None;
    }
    let mut kind = None;
    for _ in 0..24 {
        let t = toks.next()?;
        if t.is_punct(b'(') || t.is(text, "AS") || OTHER_OBJECTS.iter().any(|w| t.is(text, w)) {
            return None;
        }
        kind = [
            ("TABLE", ObjectKind::Table),
            ("VIEW", ObjectKind::View),
            ("FUNCTION", ObjectKind::Function),
            ("PROCEDURE", ObjectKind::Procedure),
            ("TRIGGER", ObjectKind::Trigger),
        ]
        .iter()
        .find(|(w, _)| t.is(text, w))
        .map(|(_, k)| *k);
        if kind.is_some() {
            break;
        }
    }
    let kind = kind?;
    if peek_is(&mut toks, text, "IF") {
        toks.next();
        if peek_is(&mut toks, text, "NOT") {
            toks.next();
        }
        if !peek_is(&mut toks, text, "EXISTS") {
            return None;
        }
        toks.next();
    }
    Some((kind, name(dialect, text, &mut toks)?))
}

/// A PostgreSQL type (`CREATE TYPE`) or sequence (`CREATE SEQUENCE`) a statement makes,
/// with its name: `Some((true, name))` for a sequence. Replace drops same-named ones
/// (R29). `TEMP`, `TEMPORARY` and `UNLOGGED` before the kind and `IF NOT EXISTS` after
/// it are passed over.
pub(crate) fn created_type_or_sequence(dialect: DialectKind, text: &str) -> Option<(bool, Name)> {
    if dialect != DialectKind::Postgres {
        return None;
    }
    let mut toks = lex(dialect, text, false).peekable();
    if !toks.next()?.is(text, "CREATE") {
        return None;
    }
    let mut sequence = None;
    for _ in 0..3 {
        let t = toks.next()?;
        if t.is(text, "SEQUENCE") {
            sequence = Some(true);
            break;
        }
        if t.is(text, "TYPE") {
            sequence = Some(false);
            break;
        }
        if !(t.is(text, "TEMP") || t.is(text, "TEMPORARY") || t.is(text, "UNLOGGED")) {
            return None;
        }
    }
    let sequence = sequence?;
    if peek_is(&mut toks, text, "IF") {
        toks.next();
        if peek_is(&mut toks, text, "NOT") {
            toks.next();
        }
        if !peek_is(&mut toks, text, "EXISTS") {
            return None;
        }
        toks.next();
    }
    Some((sequence, name(dialect, text, &mut toks)?))
}

/// What a CREATE or ALTER statement adds: a CREATE TABLE is one table, a CREATE INDEX
/// one index, each REFERENCES one Foreign Key, and on MySQL each KEY, INDEX, UNIQUE,
/// FULLTEXT or SPATIAL entry in a CREATE TABLE's list one index (SHOW CREATE TABLE
/// writes them there).
pub(crate) fn ddl_counts(dialect: DialectKind, text: &str) -> DdlCounts {
    let mut c = DdlCounts::default();
    let mut toks = lex(dialect, text, false);
    let Some(first) = toks.next() else { return c };
    let create = first.is(text, "CREATE");
    if !create && !first.is(text, "ALTER") {
        return c;
    }
    let table = create && matches!(created_object(dialect, text), Some((ObjectKind::Table, _)));
    if table {
        c.tables = 1;
    }
    // Only a table's or an ALTER's REFERENCES is a Foreign Key, never one in a body.
    let keys = table || !create;
    // Words after CREATE.
    let mut words = 0;
    let mut depth = 0u32;
    // The next token starts an entry of the CREATE TABLE's list.
    let mut entry = false;
    for t in toks {
        if t.k == K::Word {
            words += 1;
            // CREATE [UNIQUE | FULLTEXT | SPATIAL] INDEX
            if create && !table && words <= 2 && depth == 0 && t.is(text, "INDEX") {
                c.indexes = 1;
            }
            if keys && t.is(text, "REFERENCES") {
                c.foreign_keys += 1;
            }
            if entry
                && table
                && dialect == DialectKind::MySql
                && ["KEY", "INDEX", "UNIQUE", "FULLTEXT", "SPATIAL"]
                    .iter()
                    .any(|w| t.is(text, w))
            {
                c.indexes += 1;
            }
        }
        entry = false;
        match t.k {
            K::Punct(b'(') => {
                depth += 1;
                entry = depth == 1;
            }
            K::Punct(b')') => depth = depth.saturating_sub(1),
            K::Punct(b',') => entry = depth == 1,
            _ => {}
        }
    }
    c
}

/// The statement calls PostgreSQL's `setval` or `nextval` outside strings and comments:
/// a `SELECT` the 5a classifier reads as Read that changes a sequence.
pub(crate) fn calls_sequence_write(dialect: DialectKind, text: &str) -> bool {
    let mut toks = lex(dialect, text, false).peekable();
    while let Some(t) = toks.next() {
        let call = t.is(text, "SETVAL") || t.is(text, "NEXTVAL");
        if call && toks.peek().is_some_and(|n| n.is_punct(b'(')) {
            return true;
        }
    }
    false
}

/// R19, R22: after this statement runs, no later INSERT is shown as a shape, because it
/// could change where unqualified names land or run code that does:
/// - MySQL `USE`;
/// - `SET [SESSION | LOCAL] search_path | SCHEMA | ROLE | SESSION AUTHORIZATION` and the
///   matching `RESET` (and `RESET ALL`), quoted names included;
/// - any `set_config(..)` call, whatever its arguments, quoted or schema-qualified;
/// - any `SELECT`, `WITH`, `VALUES`, `DO`, `CALL`, `EXECUTE`, `PREPARE`, `TABLE` or
///   `EXPLAIN` statement, and any statement starting with `(` (R26);
/// - `CREATE [OR REPLACE] [CONSTRAINT] TRIGGER`, `CREATE RULE`, `CREATE EVENT TRIGGER`,
///   and `CREATE TABLE .. AS` (or MySQL's `CREATE TABLE .. SELECT`) (R26).
///
/// A PostgreSQL `U&"..."` name can spell any word in escapes, so one counts as every
/// word it is compared with (R26), as `safety` treats it.
///
/// Setting `search_path` to exactly `''` (Contura's own settings line, R20) is not one:
/// then no unqualified name resolves at all.
pub(crate) fn ends_shapes(dialect: DialectKind, text: &str) -> bool {
    let mut toks = lex(dialect, text, false).peekable();
    let Some(first) = toks.next() else {
        return false;
    };
    let named = |t: &Tok, w: &str| name_is(dialect, text, t, w);
    if first.is_punct(b'(')
        || [
            "SELECT", "WITH", "VALUES", "DO", "CALL", "EXECUTE", "PREPARE", "TABLE", "EXPLAIN",
        ]
        .iter()
        .any(|w| named(&first, w))
    {
        return true;
    }
    if named(&first, "CREATE") && create_runs_code(dialect, text) {
        return true;
    }
    if dialect == DialectKind::MySql && named(&first, "USE") {
        return true;
    }
    if dialect != DialectKind::Sqlite && (named(&first, "SET") || named(&first, "RESET")) {
        let reset = named(&first, "RESET");
        if toks
            .peek()
            .is_some_and(|t| named(t, "SESSION") || named(t, "LOCAL"))
        {
            toks.next();
        }
        // `SET SESSION AUTHORIZATION`: the SESSION above was its first word.
        let Some(t) = toks.next() else {
            return false;
        };
        // `SET U&"search\005fpath"`: a name we cannot read is any name.
        if dialect == DialectKind::Postgres
            && named(&t, "U")
            && toks.peek().is_some_and(|n| n.is_punct(b'&'))
        {
            return true;
        }
        if ["SCHEMA", "ROLE", "AUTHORIZATION"]
            .iter()
            .any(|w| named(&t, w))
            || reset && named(&t, "ALL")
        {
            return true;
        }
        if named(&t, "SEARCH_PATH") {
            if reset {
                return true;
            }
            if toks
                .peek()
                .is_some_and(|n| named(n, "TO") || n.is_punct(b'='))
            {
                toks.next();
            }
            let empty = toks
                .next()
                .is_some_and(|v| v.k == K::Str && &text[v.start..v.end] == "''");
            let ends = toks.all(|t| t.is_punct(b';'));
            return !(empty && ends);
        }
        return calls_set_config(dialect, text);
    }
    calls_set_config(dialect, text)
}

/// A CREATE that makes a trigger or rule (code that runs on later writes), or a table
/// filled from a query (which runs it now).
fn create_runs_code(dialect: DialectKind, text: &str) -> bool {
    let mut toks = lex(dialect, text, false);
    toks.next();
    let mut prev: Option<Tok> = None;
    for _ in 0..24 {
        let Some(t) = toks.next() else {
            return false;
        };
        // MySQL's `DEFINER = CURRENT_USER()` comes before the kind.
        let definer_call = prev.is_some_and(|p| p.is(text, "CURRENT_USER"));
        if t.is_punct(b'(') && !definer_call || t.is(text, "AS") {
            return false;
        }
        if t.is(text, "TRIGGER") || t.is(text, "RULE") {
            return true;
        }
        if t.is(text, "TABLE") {
            return table_from_query(text, toks);
        }
        if OTHER_OBJECTS
            .iter()
            .chain(&["VIEW", "FUNCTION", "PROCEDURE"])
            .any(|w| t.is(text, w))
        {
            return false;
        }
        prev = Some(t);
    }
    false
}

/// The rest of a CREATE TABLE fills it from a query: `AS`, `TABLE` or `VALUES` outside
/// the column list (not PostgreSQL's `FOR VALUES` of a partition), or `SELECT` anywhere.
fn table_from_query(text: &str, toks: Lexer<'_>) -> bool {
    let mut depth = 0u32;
    let mut prev: Option<Tok> = None;
    for t in toks {
        match t.k {
            K::Punct(b'(') => depth += 1,
            K::Punct(b')') => depth = depth.saturating_sub(1),
            _ => {}
        }
        if t.is(text, "SELECT") {
            return true;
        }
        let values = t.is(text, "VALUES") && !prev.is_some_and(|p| p.is(text, "FOR"));
        if depth == 0 && (t.is(text, "AS") || t.is(text, "TABLE") || values) {
            return true;
        }
        prev = Some(t);
    }
    false
}

/// Words that may stand before `(` without calling a function: syntax, and type names
/// with a size. None of them can name a function the file made, unqualified.
const NOT_CALLS: [&str; 45] = [
    "VALUES",
    "IN",
    "ANY",
    "ALL",
    "SOME",
    "EXISTS",
    "ARRAY",
    "ROW",
    "CAST",
    "AND",
    "OR",
    "NOT",
    "ON",
    "WHERE",
    "AS",
    "FROM",
    "SELECT",
    "RETURNING",
    "WHEN",
    "THEN",
    "ELSE",
    "CASE",
    "USING",
    "LATERAL",
    "INTO",
    "DISTINCT",
    "UNION",
    "EXCEPT",
    "INTERSECT",
    "WITH",
    "HAVING",
    "BETWEEN",
    "ONLY",
    "NUMERIC",
    "DECIMAL",
    "DEC",
    "VARCHAR",
    "CHAR",
    "CHARACTER",
    "NCHAR",
    "BIT",
    "TIME",
    "TIMESTAMP",
    "INTERVAL",
    "FLOAT",
];

/// Words before a table name whose `(` opens a column list, not a call.
const BEFORE_TABLE: [&str; 8] = [
    "INTO",
    "AS",
    "INSERT",
    "REPLACE",
    "IGNORE",
    "LOW_PRIORITY",
    "DELAYED",
    "HIGH_PRIORITY",
];

/// R26: an INSERT, REPLACE, UPDATE, DELETE or MERGE that calls a function (`word(` or
/// `"name"(` where the word is not syntax or a type name), which may run code that
/// changes where later names land. A qualified name before `(` is always a call; the
/// table's column list (`INTO t (`, `INSERT t (`, `AS x (`) is not. Only asked of a
/// statement shown in full: a shape holds literals only.
pub(crate) fn dml_calls(dialect: DialectKind, text: &str) -> bool {
    let mut toks = lex(dialect, text, false);
    let Some(first) = toks.next() else {
        return false;
    };
    if !["INSERT", "REPLACE", "UPDATE", "DELETE", "MERGE"]
        .iter()
        .any(|w| first.is(text, w))
    {
        return false;
    }
    let mut last = first;
    let mut before_last: Option<Tok> = None;
    // The token before the dotted name that ends at `last`.
    let mut before_name: Option<Tok> = None;
    for t in toks {
        if t.is_punct(b'(') && matches!(last.k, K::Word | K::Ident) {
            let qualified = before_last.is_some_and(|p| p.is_punct(b'.'));
            // `character varying(10)`, `bit varying(8)`.
            let varying = last.is(text, "VARYING")
                && before_last
                    .is_some_and(|p| ["CHARACTER", "CHAR", "BIT"].iter().any(|w| p.is(text, w)));
            let syntax = last.k == K::Word
                && !qualified
                && (varying || NOT_CALLS.iter().any(|w| last.is(text, w)));
            let table = before_name.is_some_and(|b| BEFORE_TABLE.iter().any(|w| b.is(text, w)));
            if !syntax && !table {
                return true;
            }
        }
        if matches!(t.k, K::Word | K::Ident) && !last.is_punct(b'.') {
            before_name = Some(last);
        }
        before_last = Some(last);
        last = t;
    }
    false
}

/// A `set_config(` call anywhere in the statement, quoted or qualified, read one token
/// of look-back at a time so a large statement is never held as tokens.
fn calls_set_config(dialect: DialectKind, text: &str) -> bool {
    let mut prev: Option<Tok> = None;
    for t in lex(dialect, text, false) {
        if let Some(p) = prev
            && t.is_punct(b'(')
            && name_is(dialect, text, &p, "SET_CONFIG")
        {
            return true;
        }
        prev = Some(t);
    }
    false
}

/// The token names the word `w`: a plain word in any case, or a quoted name whose text is
/// `w` (PostgreSQL: lower case, as an unquoted name folds; MySQL and SQLite: any case).
fn name_is(dialect: DialectKind, text: &str, t: &Tok, w: &str) -> bool {
    match t.k {
        K::Word => text[t.start..t.end].eq_ignore_ascii_case(w),
        K::Ident if dialect == DialectKind::Postgres && unicode_escaped(text, t) => true,
        K::Ident => part(dialect, text, *t).is_some_and(|n| {
            if dialect == DialectKind::Postgres {
                n == w.to_ascii_lowercase()
            } else {
                n.eq_ignore_ascii_case(w)
            }
        }),
        _ => false,
    }
}

/// A PostgreSQL `U&"..."` name: `U&` right before the quote, not ending a longer word.
fn unicode_escaped(text: &str, t: &Tok) -> bool {
    let b = text.as_bytes();
    let s = t.start;
    let word_byte = |c: u8| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'$') || c >= 0x80;
    b.get(s) == Some(&b'"')
        && s >= 2
        && b[s - 1] == b'&'
        && b[s - 2].eq_ignore_ascii_case(&b'u')
        && (s == 2 || !word_byte(b[s - 3]))
}
