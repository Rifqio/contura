use serde::{Deserialize, Serialize};

use crate::model::{ConnectionConfig, DialectKind};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StatementClass {
    Read,
    Write,
}

/// Write when any top-level piece of `sql` writes; Read for text with only comments or whitespace.
pub fn classify(dialect: DialectKind, sql: &str) -> StatementClass {
    let writes = |lexed: &Lexed| {
        lexed.pieces.iter().any(|p| {
            p.forced_write
                || p.sealed
                || classify_tokens(dialect, &p.toks, &lexed.words) == StatementClass::Write
        })
    };
    if writes(&lex(dialect, sql, false)) {
        return StatementClass::Write;
    }
    // Whether a backslash escapes a quote depends on server settings. When it matters, the
    // other reading also counts, unless it leaves a literal open (a syntax error there).
    if sql.contains('\\') {
        let mut other = lex(dialect, sql, true);
        // An open literal runs to the end, so it sits in the last piece. The pieces before it
        // were closed by `;` and may already have run, so only that last piece is dropped.
        if !other.clean {
            other.pieces.pop();
        }
        if writes(&other) {
            return StatementClass::Write;
        }
    }
    StatementClass::Read
}

/// How many non-empty top-level pieces `sql` holds, a routine or trigger body counting as
/// one with its CREATE. When a backslash makes the quoting ambiguous, the reading with more
/// pieces counts.
pub fn statement_count(dialect: DialectKind, sql: &str) -> usize {
    let mut count = whole_routines(dialect, sql, lex(dialect, sql, false).ranges).len();
    if sql.contains('\\') {
        let other = lex(dialect, sql, true);
        let clean = other.clean;
        let n = whole_routines(dialect, sql, other.ranges).len();
        count = count.max(n - usize::from(!clean && n > 0));
    }
    count
}

/// The byte ranges of the top-level pieces of `sql`, each running from just after the
/// previous `;` to the next, trimmed of whitespace; pieces with only comments are dropped.
/// Leading comments stay with the statement they precede, as the editor splits it, and a
/// CREATE TRIGGER, PROCEDURE, FUNCTION or EVENT keeps its `BEGIN ... END` body whole, `;`s
/// inside it included (round 5, N1). On MySQL, `DELIMITER` lines are read first (see
/// `delimited_chunks`): they are never part of a piece, and a custom delimiter ends one.
pub fn split_statements(dialect: DialectKind, sql: &str) -> Vec<std::ops::Range<usize>> {
    split_statements_from(dialect, sql, ";")
}

/// `split_statements` for text that starts where `delimiter` is in force (MySQL only; an
/// empty one is `;`). A chunk a custom delimiter ends is one piece, `;`s included, when it is
/// one routine or compound statement (see `compound`); any other chunk splits on `;`, so
/// each of its parts runs as its own statement with its own result.
pub fn split_statements_from(
    dialect: DialectKind,
    sql: &str,
    delimiter: &str,
) -> Vec<std::ops::Range<usize>> {
    let Some(chunks) = delimited_chunks(dialect, sql, delimiter, true) else {
        return split_plain(dialect, sql);
    };
    let mut out = Vec::new();
    for (c, whole) in chunks {
        let chunk = &sql[c.clone()];
        if whole && compound(dialect, chunk) {
            let start = c.start + (chunk.len() - trim_start(chunk).len());
            out.push(start..start + trim(chunk).len());
        } else {
            out.extend(
                split_plain(dialect, chunk)
                    .into_iter()
                    .map(|r| c.start + r.start..c.start + r.end),
            );
        }
    }
    out
}

/// Whether a MySQL chunk is one routine or compound statement, which the server reads as one
/// statement, `;`s inside: a routine's CREATE (`opens_routine`), or after an optional
/// `label:` a BEGIN block (BEGIN followed by a word other than WORK, so not a transaction),
/// LOOP, WHILE or REPEAT, or without a label an IF or CASE statement. The editor's
/// `compound` reads the same.
fn compound(dialect: DialectKind, chunk: &str) -> bool {
    let top = top_tokens(&plain_tokens(dialect, chunk, false));
    let word = |k: usize| match top.get(k) {
        Some(Top::Word(w)) => Some(w.as_str()),
        _ => None,
    };
    let heads: Vec<Option<String>> = top
        .iter()
        .map(|t| match t {
            Top::Word(w) => Some(w.clone()),
            _ => None,
        })
        .collect();
    if opens_routine(&heads) {
        return true;
    }
    let labelled = word(0).is_some() && matches!(top.get(1), Some(Top::Colon));
    let k = if labelled { 2 } else { 0 };
    match word(k) {
        Some("BEGIN") => word(k + 1).is_some_and(|w| w != "WORK"),
        Some("LOOP" | "WHILE" | "REPEAT") => true,
        Some("IF" | "CASE") => !labelled,
        _ => false,
    }
}

/// Trims as the editor's `String.trim` does: Unicode white space and the byte order mark,
/// but not U+0085, which JavaScript does not count as white space.
fn is_trimmed(c: char) -> bool {
    c == '\u{feff}' || c.is_whitespace() && c != '\u{85}'
}

fn trim(s: &str) -> &str {
    s.trim_matches(is_trimmed)
}

fn trim_start(s: &str) -> &str {
    s.trim_start_matches(is_trimmed)
}

/// MySQL `DELIMITER` lines, read as the mysql client reads them and as the SQL file
/// import's script reader does: a line whose first word is DELIMITER (any case, after
/// blanks), outside strings, quoted names and comments, sets the statement end to its
/// argument (a quoted string or the first word; the rest of the line is ignored) until the
/// next one, and is itself never sent. One with no argument, or a backslash in it, is text.
/// The chunks are the text between DELIMITER lines, cut at each custom delimiter; `true`
/// marks a chunk a custom delimiter is in force for, which is one statement sent whole, as
/// the client sends it, when it is a routine or compound statement (`compound`; its
/// `;`-parts are still each classified and checked, since `classify` and `no_where` read
/// every one). Any other chunk is split as any other text.
/// None on other Dialects and when the text has no DELIMITER line and starts under `;`, so
/// such text splits exactly as before. The editor's `delimitedChunks` reads the same.
fn delimited_chunks(
    dialect: DialectKind,
    sql: &str,
    initial: &str,
    backslash: bool,
) -> Option<Vec<(std::ops::Range<usize>, bool)>> {
    if dialect != DialectKind::MySql {
        return None;
    }
    const WORD: &[u8] = b"delimiter";
    let b = sql.as_bytes();
    let len = b.len();
    let mut chunks = Vec::new();
    let mut delimiter = if initial.is_empty() { ";" } else { initial };
    let mut found = delimiter != ";";
    let (mut from, mut i, mut line_start) = (0, 0, true);
    while i < len {
        let c = b[i];
        if c == b'\n' {
            line_start = true;
            i += 1;
            continue;
        }
        if matches!(c, b' ' | b'\t' | b'\r' | 0x0b | 0x0c) {
            i += 1;
            continue;
        }
        let word_after = b.get(i + WORD.len());
        if line_start
            && b[i..].len() >= WORD.len()
            && b[i..i + WORD.len()].eq_ignore_ascii_case(WORD)
            && word_after.is_none_or(|x| matches!(x, b' ' | b'\t' | b'\r' | b'\n'))
        {
            let end = b[i..]
                .iter()
                .position(|x| *x == b'\n')
                .map_or(len, |p| i + p);
            if let Some(arg) = delimiter_arg(&sql[i + WORD.len()..end]) {
                chunks.push((from..i, delimiter != ";"));
                delimiter = arg;
                found = true;
                (from, i) = (end, end);
                continue;
            }
        }
        line_start = false;
        if delimiter != ";" && b[i..].starts_with(delimiter.as_bytes()) {
            chunks.push((from..i, true));
            i += delimiter.len();
            from = i;
            continue;
        }
        let next = b.get(i + 1).copied();
        let dash_comment =
            c == b'-' && next == Some(b'-') && mysql_comment_after(char_at(sql, i + 2));
        i = if dash_comment || c == b'#' {
            line_comment_end(b, i, false)
        } else if c == b'/' && next == Some(b'*') {
            sql[i + 2..].find("*/").map_or(len, |p| i + 2 + p + 2)
        } else if c == b'\'' || c == b'"' {
            skip_quoted(sql, i, char::from(c), backslash).0
        } else if c == b'`' {
            skip_quoted(sql, i, '`', false).0
        } else {
            i + 1
        };
    }
    if !found {
        return None;
    }
    chunks.push((from..len, delimiter != ";"));
    Some(chunks)
}

/// Whether a MySQL `--` followed by `next` starts a comment: the server wants an ASCII
/// blank or control character (or the end) after it, so a no-break space does not.
pub(crate) fn mysql_comment_after(next: Option<char>) -> bool {
    next.is_none_or(|c| c.is_ascii_whitespace() || c.is_ascii_control())
}

/// The argument of a `DELIMITER` line; None when it is missing or holds a backslash.
fn delimiter_arg(rest: &str) -> Option<&str> {
    let src = rest.trim();
    let arg = match src.chars().next() {
        Some(q @ ('\'' | '"' | '`')) => {
            let inner = &src[1..];
            inner.find(q).map_or(inner, |i| &inner[..i])
        }
        _ => src
            .split([' ', '\t', '\r', '\x0b', '\x0c'])
            .next()
            .unwrap_or(""),
    };
    (!arg.is_empty() && !arg.contains('\\')).then_some(arg)
}

/// `split_statements` for text with no DELIMITER line in force.
fn split_plain(dialect: DialectKind, sql: &str) -> Vec<std::ops::Range<usize>> {
    whole_routines(dialect, sql, lex(dialect, sql, false).ranges)
        .into_iter()
        .map(|r| {
            let piece = &sql[r.clone()];
            let start = r.start + (piece.len() - trim_start(piece).len());
            start..start + trim(piece).len()
        })
        .collect()
}

/// Kinds of CREATE whose body is a `BEGIN ... END` block with `;`s inside it.
const ROUTINE: &[&str] = &["TRIGGER", "PROCEDURE", "FUNCTION", "EVENT"];
/// `END IF` and the like close a control structure, not a BEGIN or CASE.
const END_OF_CONTROL: &[&str] = &["IF", "LOOP", "WHILE", "REPEAT", "FOR"];

/// Follows CREATE TRIGGER, PROCEDURE, FUNCTION or EVENT bodies across `;`-separated parts,
/// as the editor's splitter does (round 7). A BEGIN opens a block only where a block can
/// start: in the routine's head where it is not a name, or at the start of a statement in
/// the body (after `;`, BEGIN, THEN, ELSE, DO, LOOP, REPEAT, END or a label's `:`). A CASE
/// opens unless it is a name. An END closes a BEGIN only at the start of a statement, and
/// closes a CASE anywhere; `END IF` and the like close a control structure, not a block.
#[derive(Default)]
struct RoutineDepth {
    open: bool,
    /// The routine's body has begun.
    body: bool,
    stack: Vec<Block>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Block {
    Begin,
    Case,
}

/// Words that may come between CREATE and the kind of object it makes.
const CREATE_MODIFIERS: &[&str] = &[
    "OR",
    "REPLACE",
    "TEMP",
    "TEMPORARY",
    "AGGREGATE",
    "CONSTRAINT",
];
/// Kinds of object a CREATE makes that end a `DEFINER = ...` clause without being a routine.
const OTHER_OBJECTS: &[&str] = &[
    "TABLE",
    "VIEW",
    "INDEX",
    "UNIQUE",
    "DATABASE",
    "SCHEMA",
    "USER",
    "ROLE",
    "SEQUENCE",
    "TYPE",
    "EXTENSION",
    "SERVER",
    "TABLESPACE",
];

/// Whether a part's top-level words (`None` for a token that is not a bare word) begin a
/// routine: `CREATE [OR REPLACE] [DEFINER = ...] [TEMP|TEMPORARY] [AGGREGATE] [CONSTRAINT]`
/// right before TRIGGER, PROCEDURE, FUNCTION or EVENT (round 6, N4).
fn opens_routine(top: &[Option<String>]) -> bool {
    let mut words = top.iter();
    if words.next().and_then(Option::as_deref) != Some("CREATE") {
        return false;
    }
    let mut definer = false;
    for w in words {
        let Some(w) = w.as_deref() else {
            // `=`, a quoted user or `@` in a DEFINER clause; anything else ends the head.
            if definer {
                continue;
            }
            return false;
        };
        if ROUTINE.contains(&w) {
            return true;
        }
        if OTHER_OBJECTS.contains(&w) {
            return false;
        }
        if w == "DEFINER" {
            definer = true;
            continue;
        }
        if definer || CREATE_MODIFIERS.contains(&w) {
            continue;
        }
        return false;
    }
    false
}

/// One top-level token of a part, outside parentheses.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Top {
    Word(String),
    /// A quoted name: always a name, never a keyword.
    Name,
    /// A number or a string.
    Value,
    Colon,
    Comma,
    /// A parenthesized group, ended.
    Group,
    /// An operator or other punctuation.
    Other,
}

/// Keywords a name follows: after one of them a BEGIN or CASE is a column, table, variable,
/// alias or routine name, unless the keyword is itself used as a name (`ON event BEGIN`).
const NAME_AFTER: &[&str] = &[
    "AS",
    "SET",
    "DECLARE",
    "ON",
    "OF",
    "FROM",
    "JOIN",
    "INTO",
    "UPDATE",
    "TABLE",
    "TRIGGER",
    "PROCEDURE",
    "FUNCTION",
    "EVENT",
    "SELECT",
    "WHERE",
    "AND",
    "OR",
    "BY",
    "NEW",
    "OLD",
    "IS",
    "NOT",
    "IN",
    "DEFINER",
    "CALL",
    "USING",
    "RETURN",
    "RETURNS",
    "VALUES",
    "LIKE",
    "WHEN",
    "FOLLOWS",
    "PRECEDES",
    "SETOF",
    "IF",
    "ELSEIF",
    "WHILE",
    "UNTIL",
    "HAVING",
    "LIMIT",
    "LEAVE",
    "ITERATE",
    "RETURNING",
];
/// Keywords after which a CASE is a name rather than an expression or statement.
const CASE_NAME_AFTER: &[&str] = &[
    "AS",
    "SET",
    "DECLARE",
    "ON",
    "OF",
    "FROM",
    "JOIN",
    "INTO",
    "UPDATE",
    "TABLE",
    "TRIGGER",
    "PROCEDURE",
    "FUNCTION",
    "EVENT",
    "DEFINER",
    "CALL",
    "FOLLOWS",
    "PRECEDES",
    "SETOF",
    "LEAVE",
    "ITERATE",
];
/// Words after which a statement starts inside a body (END is not one: `END begin` is a label).
const STATEMENT_START: &[&str] = &["BEGIN", "THEN", "ELSE", "DO", "LOOP", "REPEAT"];
/// Words after which a `DECLARE ... HANDLER FOR` condition ends and its block may start.
const HANDLER_CONDITIONS: &[&str] = &["SQLEXCEPTION", "SQLWARNING", "FOUND"];

/// Reads one part's top-level tokens for `RoutineDepth`.
struct Part<'a>(&'a [Top]);

impl Part<'_> {
    fn word(&self, k: usize) -> Option<&str> {
        match self.0.get(k) {
            Some(Top::Word(w)) => Some(w.as_str()),
            _ => None,
        }
    }

    /// Token `k` is a `:` of a `::` cast.
    fn cast(&self, k: usize) -> bool {
        self.0.get(k) == Some(&Top::Colon)
            && (k.checked_sub(1).and_then(|p| self.0.get(p)) == Some(&Top::Colon)
                || self.0.get(k + 1) == Some(&Top::Colon))
    }

    /// Word `k` is used as a name: it follows a keyword that takes a name, and that keyword
    /// is not itself a name.
    fn is_name(&self, k: usize) -> bool {
        let Some(p) = k.checked_sub(1) else {
            return false;
        };
        match self.0.get(p) {
            Some(Top::Word(w)) if NAME_AFTER.contains(&w.as_str()) => !self.is_name(p),
            Some(Top::Colon) => self.cast(p),
            _ => false,
        }
    }

    /// Token `k` is where a body statement starts.
    fn statement_start(&self, k: usize) -> bool {
        let Some(p) = k.checked_sub(1) else {
            return true;
        };
        match &self.0[p] {
            Top::Colon => !self.cast(p),
            Top::Word(w) => STATEMENT_START.contains(&w.as_str()) && !self.is_name(p),
            _ => false,
        }
    }

    /// Word `k` is a label, as in `begin: LOOP`.
    fn label(&self, k: usize) -> bool {
        self.0.get(k + 1) == Some(&Top::Colon) && !self.cast(k + 1)
    }
}

impl RoutineDepth {
    /// Feeds one `;`-separated part's tokens; true while the part is a routine's CREATE or
    /// inside its body, so the parts belong together. Strings, comments and quoted names are
    /// never words, and a dotted name is one word.
    fn feed<'a>(&mut self, toks: impl IntoIterator<Item = &'a PTok>) -> bool {
        let top = top_tokens(toks);
        if !self.open {
            let heads: Vec<Option<String>> = top
                .iter()
                .map(|t| match t {
                    Top::Word(w) => Some(w.clone()),
                    _ => None,
                })
                .collect();
            if !opens_routine(&heads) {
                return false;
            }
            self.open = true;
            self.body = false;
            self.stack.clear();
        }
        let part = Part(&top);
        let handler = |k: usize| (0..k).any(|i| part.word(i) == Some("HANDLER"));
        let mut k = 0;
        while k < top.len() {
            match part.word(k) {
                Some("BEGIN") if !part.is_name(k) && !part.label(k) => {
                    let prev = k.checked_sub(1).map(|p| &top[p]);
                    let opens = if !self.body && self.stack.is_empty() {
                        // In the head: after anything but a comma, an operator or a `::`.
                        !matches!(prev, Some(Top::Comma | Top::Other))
                            && !(prev == Some(&Top::Colon) && part.cast(k - 1))
                    } else {
                        part.statement_start(k)
                            || (handler(k)
                                && (matches!(prev, Some(Top::Value))
                                    || k.checked_sub(1)
                                        .and_then(|p| part.word(p))
                                        .is_some_and(|w| HANDLER_CONDITIONS.contains(&w))))
                    };
                    if opens {
                        self.stack.push(Block::Begin);
                        self.body = true;
                    }
                }
                Some("CASE")
                    if !part.label(k)
                        && !(k
                            .checked_sub(1)
                            .and_then(|p| part.word(p))
                            .is_some_and(|w| {
                                CASE_NAME_AFTER.contains(&w) && !part.is_name(k - 1)
                            })) =>
                {
                    self.stack.push(Block::Case);
                }
                Some("END") if !part.is_name(k) && !part.label(k) => {
                    let next = part.word(k + 1);
                    let closes_control = next.is_some_and(|n| END_OF_CONTROL.contains(&n));
                    if closes_control {
                        // `END IF`, `END LOOP` and the like.
                        k += 1;
                    } else if self.stack.last() == Some(&Block::Case) {
                        self.stack.pop();
                        if next == Some("CASE") {
                            k += 1;
                        }
                    } else if self.stack.last() == Some(&Block::Begin) && part.statement_start(k) {
                        self.stack.pop();
                    }
                    // `END lbl` or `END LOOP lbl`: the last word of the part is a label.
                    if (closes_control || part.statement_start(k))
                        && k + 2 == top.len()
                        && part.word(k + 1).is_some()
                    {
                        k += 1;
                    }
                }
                _ => {}
            }
            k += 1;
        }
        if self.stack.is_empty() {
            self.open = false;
        }
        true
    }

    /// Still inside a body after the last part fed.
    fn inside(&self) -> bool {
        self.open && !self.stack.is_empty()
    }
}

/// A part's tokens outside parentheses, each group of parentheses as one `Group`.
fn top_tokens<'a>(toks: impl IntoIterator<Item = &'a PTok>) -> Vec<Top> {
    let mut paren = 0usize;
    let mut top = Vec::new();
    for t in toks {
        match t {
            PTok::Open => paren += 1,
            PTok::Close => {
                paren = paren.saturating_sub(1);
                if paren == 0 {
                    top.push(Top::Group);
                }
            }
            _ if paren > 0 => {}
            PTok::Word(w) if w.starts_with(|c: char| c.is_ascii_digit()) => top.push(Top::Value),
            PTok::Word(w) => top.push(Top::Word(w.to_uppercase())),
            PTok::Str => top.push(Top::Value),
            PTok::Quoted(_) => top.push(Top::Name),
            PTok::Colon => top.push(Top::Colon),
            PTok::Comma => top.push(Top::Comma),
            _ => top.push(Top::Other),
        }
    }
    top
}

/// For each `;`-separated part, whether it belongs to a real routine (its CREATE or its body).
/// A routine whose body is still open at the end of the text is not one: its parts, and all
/// after them, are plain statements (round 7, C1).
fn routine_parts<'a, I>(parts: impl IntoIterator<Item = I>) -> Vec<bool>
where
    I: IntoIterator<Item = &'a PTok>,
{
    let mut routine = RoutineDepth::default();
    let mut member = Vec::new();
    let mut open_from: Option<usize> = None;
    for part in parts {
        let k = member.len();
        let was_open = routine.open;
        let mine = routine.feed(part);
        if mine && !was_open {
            open_from = Some(k);
        }
        member.push(mine);
        if !routine.inside() {
            open_from = None;
        }
    }
    if let Some(from) = open_from.filter(|_| routine.inside()) {
        for m in &mut member[from..] {
            *m = false;
        }
    }
    member
}

/// `ranges` with each routine's parts joined into one range.
fn whole_routines(
    dialect: DialectKind,
    sql: &str,
    ranges: Vec<std::ops::Range<usize>>,
) -> Vec<std::ops::Range<usize>> {
    let toks: Vec<Vec<PTok>> = ranges
        .iter()
        .map(|r| plain_tokens(dialect, &sql[r.clone()], false))
        .collect();
    let member = routine_parts(toks.iter());
    // Join a routine's parts: one closes when its body does, so re-follow the depth.
    let mut out: Vec<std::ops::Range<usize>> = Vec::with_capacity(ranges.len());
    let mut routine = RoutineDepth::default();
    let mut joining: Option<usize> = None;
    for (k, r) in ranges.into_iter().enumerate() {
        if !member[k] {
            out.push(r);
            continue;
        }
        let start = joining.unwrap_or(r.start);
        routine.feed(&toks[k]);
        if routine.inside() {
            joining = Some(start);
            continue;
        }
        joining = None;
        out.push(start..r.end);
    }
    out
}

/// The functions `sql` calls: each word followed by `(` (whitespace and comments between
/// count), lower-cased and schema-qualified as written, in text order. Keywords and type
/// names that take parentheses are not calls, nor is a CTE's name.
pub fn function_calls(dialect: DialectKind, sql: &str) -> Vec<String> {
    let mut out = calls_in(&plain_tokens(dialect, sql, false));
    // Whether a backslash escapes a quote depends on server settings: both readings count.
    if sql.contains('\\') {
        for name in calls_in(&plain_tokens(dialect, sql, true)) {
            if !out.contains(&name) {
                out.push(name);
            }
        }
    }
    out
}

fn calls_in(toks: &[PTok]) -> Vec<String> {
    let depths = depths(toks);
    let mut out = Vec::new();
    for (k, t) in toks.iter().enumerate() {
        if toks.get(k + 1) != Some(&PTok::Open) || cte_name(toks, &depths, k) {
            continue;
        }
        let text = match t {
            PTok::Word(w) => w.as_str(),
            PTok::Quoted(q) => q.as_str(),
            _ => continue,
        };
        // A qualifier written with quotes reaches here as `"schema"` then `.name`, or
        // `schema.` then `"name"`: join the chain back to its start.
        let mut parts = vec![text];
        let mut j = k;
        while let Some(prev) = j.checked_sub(1) {
            let linked = match (&toks[prev], &toks[j]) {
                (PTok::Quoted(_), PTok::Word(w)) => w.starts_with('.'),
                (PTok::Word(p), PTok::Quoted(_)) => p.ends_with('.'),
                _ => false,
            };
            if !linked {
                break;
            }
            j = prev;
            parts.push(match &toks[j] {
                PTok::Word(w) => w.as_str(),
                PTok::Quoted(q) => q.as_str(),
                _ => "",
            });
        }
        parts.reverse();
        let name = parts.concat().to_lowercase();
        // `AS [NOT] MATERIALIZED (` opens a CTE body; an alias is never followed by `(`.
        let word_at = |i: Option<usize>, w: &str| matches!(i.map(|i| &toks[i]), Some(PTok::Word(x)) if x.eq_ignore_ascii_case(w));
        let as_before = word_at(k.checked_sub(1), "AS")
            || word_at(k.checked_sub(1), "NOT") && word_at(k.checked_sub(2), "AS");
        if name == "materialized" && as_before {
            continue;
        }
        if let PTok::Word(w) = t
            && parts.len() == 1
            && (is_number(w)
                || w.starts_with(['@', '$'])
                || NOT_CALLS.contains(&w.to_uppercase().as_str())
                || keyword_use(toks, &depths, k, &w.to_uppercase()))
        {
            continue;
        }
        out.push(name);
    }
    out
}

/// Each token's parenthesis depth; for `Open` and `Close` the depth outside the pair.
fn depths(toks: &[PTok]) -> Vec<usize> {
    let mut d = 0usize;
    toks.iter()
        .map(|t| match t {
            PTok::Open => {
                d += 1;
                d - 1
            }
            PTok::Close => {
                d = d.saturating_sub(1);
                d
            }
            _ => d,
        })
        .collect()
}

/// True when `sql` writes a file on the server: `INTO OUTFILE` or `INTO DUMPFILE`.
pub fn writes_to_file(dialect: DialectKind, sql: &str) -> bool {
    file_write(dialect, sql).is_some()
}

/// `"INTO OUTFILE"` or `"INTO DUMPFILE"` when `sql` holds one outside strings and comments.
pub fn file_write(dialect: DialectKind, sql: &str) -> Option<&'static str> {
    let toks = plain_tokens(dialect, sql, false);
    toks.windows(2).find_map(|w| match (&w[0], &w[1]) {
        (PTok::Word(a), PTok::Word(b)) if a.eq_ignore_ascii_case("INTO") => {
            if b.eq_ignore_ascii_case("OUTFILE") {
                Some("INTO OUTFILE")
            } else if b.eq_ignore_ascii_case("DUMPFILE") {
                Some("INTO DUMPFILE")
            } else {
                None
            }
        }
        _ => None,
    })
}

/// `"UPDATE"` or `"DELETE"` when the first statement of `sql` is one with no top-level
/// `WHERE`; a `WITH` before it is looked through.
pub fn missing_where(dialect: DialectKind, sql: &str) -> Option<&'static str> {
    let top = top_words(dialect, sql);
    let at = verb_at(&top)?;
    let verb = match top[at].as_str() {
        "UPDATE" => "UPDATE",
        "DELETE" => "DELETE",
        _ => return None,
    };
    (!top[at..].iter().any(|w| w == "WHERE")).then_some(verb)
}

/// The statement's verb, upper-cased: its first word, or after a `WITH` the first
/// top-level SELECT, INSERT, UPDATE, DELETE or MERGE.
pub fn main_verb(dialect: DialectKind, sql: &str) -> Option<String> {
    let top = top_words(dialect, sql);
    verb_at(&top).map(|at| top[at].clone())
}

fn verb_at(top: &[String]) -> Option<usize> {
    match top.first()?.as_str() {
        "WITH" => top.iter().position(|w| {
            matches!(
                w.as_str(),
                "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE"
            )
        }),
        _ => Some(0),
    }
}

/// The upper-cased bare words of the first statement of `sql` outside parentheses.
fn top_words(dialect: DialectKind, sql: &str) -> Vec<String> {
    let mut depth = 0usize;
    let mut out = Vec::new();
    for t in plain_tokens(dialect, sql, false) {
        match t {
            PTok::Semi if !out.is_empty() => break,
            PTok::Open => depth += 1,
            PTok::Close => depth = depth.saturating_sub(1),
            PTok::Word(w) if depth == 0 => out.push(w.to_uppercase()),
            _ => {}
        }
    }
    out
}

/// Keywords that are also fair names for a user's function: a call in an expression,
/// not in the places `keyword_use` knows.
const KEYWORD_OR_CALL: &[&str] = &["CUBE", "INDEX", "KEY", "MATCH", "RANGE", "TIME"];

/// Whether `word` at `k`, one of `KEYWORD_OR_CALL` followed by `(`, is the keyword: any
/// of them in CREATE or ALTER (a key or index definition, a column type, partitioning),
/// an index hint or key kind (`USE INDEX (`, `PRIMARY KEY (`), `MATCH (..) AGAINST`,
/// `BY RANGE (`, `CUBE (` in a GROUP BY, and the `TIME(3)` type in a cast.
fn keyword_use(toks: &[PTok], depths: &[usize], k: usize, word: &str) -> bool {
    if !KEYWORD_OR_CALL.contains(&word) {
        return false;
    }
    let upper = |i: usize| match &toks[i] {
        PTok::Word(w) => Some(w.to_uppercase()),
        _ => None,
    };
    let prev = k.checked_sub(1).and_then(upper);
    let first = (0..k)
        .rev()
        .take_while(|i| toks[*i] != PTok::Semi)
        .filter_map(upper)
        .last()
        .or_else(|| upper(k));
    if matches!(first.as_deref(), Some("CREATE" | "ALTER")) {
        return true;
    }
    match word {
        "INDEX" | "KEY" => matches!(
            prev.as_deref(),
            Some(
                "USE"
                    | "FORCE"
                    | "IGNORE"
                    | "PRIMARY"
                    | "FOREIGN"
                    | "UNIQUE"
                    | "FULLTEXT"
                    | "SPATIAL"
            )
        ),
        "MATCH" => {
            let level = depths[k + 1];
            (k + 2..toks.len())
                .find(|j| toks[*j] == PTok::Close && depths[*j] == level)
                .and_then(|j| toks.get(j + 1).map(|_| j + 1))
                .and_then(upper)
                .as_deref()
                == Some("AGAINST")
        }
        "RANGE" => prev.as_deref() == Some("BY"),
        "CUBE" => in_group_by(toks, depths, k),
        "TIME" => {
            prev.as_deref() == Some("AS")
                || k >= 2 && toks[k - 1] == PTok::Colon && toks[k - 2] == PTok::Colon
        }
        _ => false,
    }
}

/// Whether the item at `k` is in a GROUP BY list at its own depth.
fn in_group_by(toks: &[PTok], depths: &[usize], k: usize) -> bool {
    let level = depths[k];
    for j in (0..k).rev() {
        if depths[j] > level {
            continue;
        }
        if depths[j] < level || toks[j] == PTok::Semi {
            return false;
        }
        if let PTok::Word(w) = &toks[j] {
            if w.eq_ignore_ascii_case("BY") {
                return matches!(j.checked_sub(1).map(|i| &toks[i]), Some(PTok::Word(g)) if g.eq_ignore_ascii_case("GROUP"));
            }
            if ["SELECT", "FROM", "WHERE", "HAVING", "ON", "SET", "VALUES"]
                .iter()
                .any(|c| w.eq_ignore_ascii_case(c))
            {
                return false;
            }
        }
    }
    false
}

/// Words that take parentheses without being a function call.
const NOT_CALLS: &[&str] = &[
    "AGAINST",
    "ALL",
    "AND",
    "ANY",
    "ARRAY",
    "AS",
    "BETWEEN",
    "BIGINT",
    "BINARY",
    "BIT",
    "BY",
    "CASE",
    "CHAR",
    "CHARACTER",
    "CHECK",
    "COLLATE",
    "CONFLICT",
    "CONSTRAINT",
    "DEC",
    "DECIMAL",
    "DEFAULT",
    "DELETE",
    "DISTINCT",
    "DOUBLE",
    "ELSE",
    "END",
    "ESCAPE",
    "EXCEPT",
    "EXISTS",
    "FILTER",
    "FLOAT",
    "FOR",
    "FOREIGN",
    "FROM",
    "GROUPING",
    "GROUPS",
    "HAVING",
    "ILIKE",
    "IN",
    "INSERT",
    "INT",
    "INTEGER",
    "INTERSECT",
    "INTERVAL",
    "INTO",
    "IS",
    "JOIN",
    "LATERAL",
    "LIKE",
    "LIMIT",
    "MEDIUMINT",
    "NCHAR",
    "NOT",
    "NUMERIC",
    "NVARCHAR",
    "OFFSET",
    "ON",
    "ONLY",
    "OR",
    "OVER",
    "PARTITION",
    "PRECISION",
    "PRIMARY",
    "RECURSIVE",
    "REFERENCES",
    "RETURNING",
    "ROLLUP",
    "ROW",
    "ROWS",
    "SELECT",
    "SET",
    "SETS",
    "SMALLINT",
    "SOME",
    "TABLE",
    "THEN",
    "TIMESTAMP",
    "TIMESTAMPTZ",
    "TINYINT",
    "TO",
    "UNION",
    "UNIQUE",
    "UPDATE",
    "USING",
    "VALUES",
    "VARBINARY",
    "VARCHAR",
    "VARYING",
    "WHEN",
    "WHERE",
    "WITH",
    "WITHIN",
];

/// Whether the name at token `k` stands where a WITH list defines a name: right after
/// `WITH` (or `RECURSIVE`), or after a comma of that WITH list before its statement starts.
fn cte_listed(toks: &[PTok], depths: &[usize], k: usize) -> bool {
    let is_word =
        |t: Option<&PTok>, w: &str| matches!(t, Some(PTok::Word(x)) if x.eq_ignore_ascii_case(w));
    let Some(before) = k.checked_sub(1) else {
        return false;
    };
    if is_word(Some(&toks[before]), "WITH") || is_word(Some(&toks[before]), "RECURSIVE") {
        return true;
    }
    if toks[before] != PTok::Comma {
        return false;
    }
    let level = depths[before];
    for j in (0..before).rev() {
        if depths[j] > level {
            continue;
        }
        if depths[j] < level || toks[j] == PTok::Semi {
            return false;
        }
        if let PTok::Word(w) = &toks[j] {
            let w = w.to_uppercase();
            if w == "WITH" {
                return true;
            }
            if matches!(
                w.as_str(),
                "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "VALUES" | "TABLE"
            ) {
                return false;
            }
        }
    }
    false
}

/// A CTE's name with a column list: right after `WITH` (or `RECURSIVE`), or after a
/// comma of that WITH list before its statement starts, and followed by its column list
/// and `AS (`, `AS MATERIALIZED (` or `AS NOT MATERIALIZED (`. A select-list item such as
/// `, f(x) AS materialized` is a call.
fn cte_name(toks: &[PTok], depths: &[usize], k: usize) -> bool {
    let is_word =
        |t: Option<&PTok>, w: &str| matches!(t, Some(PTok::Word(x)) if x.eq_ignore_ascii_case(w));
    if !cte_listed(toks, depths, k) {
        return false;
    }
    let level = depths[k + 1];
    let Some(close) = (k + 2..toks.len()).find(|j| toks[*j] == PTok::Close && depths[*j] == level)
    else {
        return false;
    };
    if !is_word(toks.get(close + 1), "AS") {
        return false;
    }
    let mut at = close + 2;
    if is_word(toks.get(at), "NOT") {
        at += 1;
        if !is_word(toks.get(at), "MATERIALIZED") {
            return false;
        }
        at += 1;
    } else if is_word(toks.get(at), "MATERIALIZED") {
        at += 1;
    }
    toks.get(at) == Some(&PTok::Open)
}

/// One token of `plain_tokens`.
#[derive(Debug, Clone, PartialEq, Eq)]
enum PTok {
    /// A bare word as written; a dotted name is one word.
    Word(String),
    /// A quoted identifier's text, without its quotes.
    Quoted(String),
    Open,
    Close,
    Comma,
    Semi,
    /// `:`, so a Postgres `::` cast is seen.
    Colon,
    /// A string or a dollar-quoted body.
    Str,
    /// Any other punctuation.
    Other,
}

/// Where a `--` or `#` comment starting at `from` ends: at the next LF, and on PostgreSQL at a
/// lone CR too, as each server's own lexer reads it (PostgreSQL's `newline` is `[\n\r]`; MySQL
/// and SQLite read to the LF).
fn line_comment_end(b: &[u8], from: usize, postgres: bool) -> usize {
    b[from..]
        .iter()
        .position(|x| *x == b'\n' || postgres && *x == b'\r')
        .map_or(b.len(), |p| from + p)
}

/// Every token of `sql` at every depth, with strings and comments read the Dialect's
/// default way, as `lex` reads them. A MySQL `/*! */` comment is read as code, since the
/// server runs it. For the AI checks only; `classify` never uses it.
fn plain_tokens(dialect: DialectKind, sql: &str, flip: bool) -> Vec<PTok> {
    gated_tokens(dialect, sql, flip)
        .into_iter()
        .map(|(t, _)| t)
        .collect()
}

/// `plain_tokens`, each with whether it sits in a MySQL executable comment the server may
/// skip: one with a version (`/*!99999 */` runs only from that version on) or MariaDB's
/// `/*M! */`, which MySQL reads as a plain comment.
fn gated_tokens(dialect: DialectKind, sql: &str, flip: bool) -> Vec<(PTok, bool)> {
    let mysql = dialect == DialectKind::MySql;
    let postgres = dialect == DialectKind::Postgres;
    let sqlite = dialect == DialectKind::Sqlite;
    let b = sql.as_bytes();
    let len = b.len();
    let mut out = Vec::new();
    let mut i = 0;
    // Where a lone word `E` ended: Postgres `E'..'` reads backslashes.
    let mut e_end = None;
    // Inside a MySQL executable comment: whether it is version-gated.
    let mut exec: Option<bool> = None;
    while let Some(c) = char_at(sql, i) {
        let next = char_at(sql, i + c.len_utf8());
        if c.is_whitespace() {
            i += c.len_utf8();
            continue;
        }
        let gated = exec == Some(true);
        if exec.is_some() && c == '*' && next == Some('/') {
            exec = None;
        }
        let dash_comment =
            c == '-' && next == Some('-') && (!mysql || mysql_comment_after(char_at(sql, i + 2)));
        if dash_comment || mysql && c == '#' {
            i = line_comment_end(b, i, postgres);
            continue;
        }
        if c == '/' && next == Some('*') {
            let opener = match (b.get(i + 2), b.get(i + 3)) {
                (Some(b'!'), _) => Some(3),
                (Some(b'M'), Some(b'!')) => Some(4),
                _ => None,
            };
            if let Some(skip) = opener.filter(|_| mysql) {
                i += skip;
                let version = i;
                while b.get(i).is_some_and(u8::is_ascii_digit) {
                    i += 1;
                }
                exec = Some(skip == 4 || i > version);
                continue;
            }
            let mut level = 1;
            i += 2;
            while i < len && level > 0 {
                if b[i] == b'*' && b.get(i + 1) == Some(&b'/') {
                    level -= 1;
                    i += 2;
                } else if postgres && b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
                    level += 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        let start = i;
        let quoted_name =
            (c == '"' && !mysql) || (c == '`' && (mysql || sqlite)) || (c == '[' && sqlite);
        let tok = match c {
            ';' => PTok::Semi,
            '(' => PTok::Open,
            ')' => PTok::Close,
            ',' => PTok::Comma,
            ':' => PTok::Colon,
            _ => PTok::Other,
        };
        let tok = if tok != PTok::Other {
            i += 1;
            tok
        } else if c == '\'' {
            let escapes = if mysql {
                !flip
            } else {
                flip || postgres && e_end == Some(i)
            };
            i = skip_quoted(sql, i, '\'', escapes).0;
            PTok::Str
        } else if c == '"' && mysql {
            i = skip_quoted(sql, i, '"', !flip).0;
            PTok::Str
        } else if quoted_name {
            let (end, closed) = if c == '[' {
                b[i + 1..]
                    .iter()
                    .position(|x| *x == b']')
                    .map_or((len, false), |p| (i + 1 + p + 1, true))
            } else {
                skip_quoted(sql, i, c, false)
            };
            i = end;
            let inner = &sql[start + 1..end - usize::from(closed)];
            PTok::Quoted(inner.to_string())
        } else if c == '$' && postgres && dollar_tag_len(sql, i).is_some() {
            let tag = dollar_tag_len(sql, i).unwrap_or(2);
            let opener = &sql[i..i + tag];
            i += tag;
            i = sql[i..].find(opener).map_or(len, |p| i + p + tag);
            PTok::Str
        } else if is_word_char(c) {
            while let Some(w) = char_at(sql, i).filter(|w| is_word_char(*w)) {
                i += w.len_utf8();
            }
            PTok::Word(sql[start..i].to_string())
        } else {
            i += c.len_utf8();
            PTok::Other
        };
        e_end = matches!(&tok, PTok::Word(w) if w.eq_ignore_ascii_case("e")).then_some(i);
        out.push((tok, gated));
    }
    out
}

/// An UPDATE or DELETE that changes every row: no top-level `WHERE`.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoWhere {
    /// `"UPDATE"` or `"DELETE"`.
    pub verb: String,
    /// The table as written, without quotes; empty when it cannot be told.
    pub table: String,
    /// The piece of a plain `;` split that asks, trimmed: the text the ask shows.
    pub text: String,
}

/// The first UPDATE or DELETE in `sql` with no top-level `WHERE`, read by the Dialect's own
/// lexer (UX step 9, round 4: the gate for the missing-WHERE ask). Every `;`-separated part
/// counts, also inside a MySQL executable comment, and a `WITH` before the verb is looked
/// through. A `WHERE` only inside a version-gated executable comment does not count, unless
/// the verb is gated too. When a backslash makes the quoting ambiguous, either reading asks.
pub fn no_where(dialect: DialectKind, sql: &str) -> Option<NoWhere> {
    let found = no_where_reading(dialect, sql, false);
    if found.is_some() || !sql.contains('\\') {
        return found;
    }
    no_where_reading(dialect, sql, true)
}

fn no_where_reading(dialect: DialectKind, sql: &str, flip: bool) -> Option<NoWhere> {
    // The safety net (round 8): every piece of a plain `;` split is read, a routine's body
    // included, so no grouping of statements can hide an UPDATE or DELETE without WHERE.
    // MySQL DELIMITER lines are read first, as `split_statements` reads them.
    let chunks = delimited_chunks(dialect, sql, ";", !flip)
        .unwrap_or_else(|| std::iter::once((0..sql.len(), false)).collect());
    for (c, _) in chunks {
        let chunk = &sql[c];
        for r in lex(dialect, chunk, flip).ranges {
            let piece = chunk[r].trim();
            if let Some((verb, table)) = no_where_piece(dialect, piece, flip) {
                return Some(NoWhere {
                    verb,
                    table,
                    text: piece.to_string(),
                });
            }
        }
    }
    None
}

/// The first UPDATE or DELETE without WHERE in one piece, reading every `;`-part of it (a
/// MySQL executable comment can hold `;`s the lexer does not split on).
fn no_where_piece(dialect: DialectKind, sql: &str, flip: bool) -> Option<(String, String)> {
    let toks = gated_tokens(dialect, sql, flip);
    for part in toks.split(|(t, _)| *t == PTok::Semi) {
        // Each token with its parenthesis depth; `(` and `)` sit at the depth outside them.
        let mut depth = 0usize;
        let mut items: Vec<(usize, &PTok, bool)> = Vec::with_capacity(part.len());
        for (t, gated) in part.iter() {
            match t {
                PTok::Open => {
                    items.push((depth, t, *gated));
                    depth += 1;
                }
                PTok::Close => {
                    depth = depth.saturating_sub(1);
                    items.push((depth, t, *gated));
                }
                _ => items.push((depth, t, *gated)),
            }
        }
        let word = |i: usize| match items[i].1 {
            PTok::Word(w) => w.to_uppercase(),
            _ => String::new(),
        };
        let top: Vec<usize> = (0..items.len()).filter(|&i| items[i].0 == 0).collect();
        let mut start = 0;
        // EXPLAIN ANALYZE runs what it explains; plain EXPLAIN does not (N3).
        if top.first().is_some_and(|&i| word(i) == "EXPLAIN") {
            let body = top.iter().copied().skip(1).find(|&i| {
                matches!(
                    word(i).as_str(),
                    "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "WITH" | "MERGE" | "VALUES"
                )
            });
            let Some(body) = body else { continue };
            let analyze = (1..body).any(|i| matches!(word(i).as_str(), "ANALYZE" | "ANALYSE"));
            if !analyze {
                continue;
            }
            start = top.iter().position(|&i| i == body).unwrap_or(0);
        }
        let top = &top[start..];
        let top_words: Vec<String> = top.iter().map(|&i| word(i)).collect();
        // The writes to check: the statement's own verb, and in a WITH every UPDATE or
        // DELETE that opens a parenthesis group, at any depth (N2).
        let mut writes: Vec<usize> = Vec::new();
        if let Some(at) = verb_at_in(&top_words) {
            writes.push(top[at]);
        }
        // A routine's first body statement shares its piece with the CREATE: an UPDATE or
        // DELETE right after a block start is read too (an event such as AFTER DELETE is not).
        if top_words
            .iter()
            .find(|w| !w.is_empty())
            .is_some_and(|w| w == "CREATE")
        {
            for w in 1..top_words.len() {
                if matches!(top_words[w].as_str(), "UPDATE" | "DELETE")
                    && matches!(
                        top_words[w - 1].as_str(),
                        "BEGIN" | "ATOMIC" | "THEN" | "ELSE" | "DO" | "LOOP" | "REPEAT"
                    )
                {
                    writes.push(top[w]);
                }
            }
        }
        if top_words
            .iter()
            .find(|w| !w.is_empty())
            .is_some_and(|w| w == "WITH")
        {
            let from = top.first().copied().unwrap_or(0);
            writes.extend((from + 1..items.len()).filter(|&i| {
                items[i].0 > 0
                    && matches!(word(i).as_str(), "UPDATE" | "DELETE")
                    && matches!(items[i - 1].1, PTok::Open)
            }));
        }
        for k in writes {
            let verb = word(k);
            if verb != "UPDATE" && verb != "DELETE" {
                continue;
            }
            let (d, _, verb_gated) = items[k];
            let scope: Vec<usize> = (k + 1..items.len())
                .take_while(|&j| items[j].0 >= d)
                .collect();
            let has_where = scope
                .iter()
                .any(|&j| items[j].0 == d && word(j) == "WHERE" && (!items[j].2 || verb_gated));
            if has_where {
                continue;
            }
            const MODIFIERS: &[&str] = &["LOW_PRIORITY", "IGNORE", "QUICK", "ONLY", "FROM"];
            let table = scope
                .iter()
                .copied()
                .filter(|&j| items[j].0 == d)
                .find(|&j| {
                    !(matches!(items[j].1, PTok::Word(_)) && MODIFIERS.contains(&word(j).as_str()))
                })
                .and_then(|j| match items[j].1 {
                    PTok::Word(w) | PTok::Quoted(w) => Some(w.clone()),
                    _ => None,
                })
                .unwrap_or_default();
            return Some((verb, table));
        }
    }
    None
}

/// `verb_at` over words where a non-word is an empty string.
fn verb_at_in(words: &[String]) -> Option<usize> {
    let first = words.iter().position(|w| !w.is_empty())?;
    match words[first].as_str() {
        "WITH" => words.iter().position(|w| {
            matches!(
                w.as_str(),
                "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE"
            )
        }),
        _ => Some(first),
    }
}

/// One statement a run will send, as the Core splits it (UX step 9, round 4).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedRun {
    /// The exact text sent.
    pub text: String,
    /// Which of the given statements it came from.
    pub piece: usize,
    /// Where it sits in that statement, in UTF-16 units, as the editor counts.
    pub from: usize,
    pub to: usize,
    /// It changes every row: the missing-WHERE ask comes before it runs.
    pub no_where: Option<NoWhere>,
}

/// The statements a run of `statements` sends, split by the Core's lexer, each with its
/// missing-WHERE answer. A piece with only comments sends nothing.
pub fn plan_run(dialect: DialectKind, statements: &[String]) -> Vec<PlannedRun> {
    plan_run_delimited(dialect, statements, &[])
}

/// `plan_run`, each statement split from the MySQL delimiter in force where it starts
/// (`delimiters`, by index; a missing one is `;`). The editor sends a statement it cut at a
/// custom delimiter with that delimiter, so it stays one statement here too. Grouping never
/// hides a write: `classify` and the missing-WHERE answer read every `;`-part of a statement.
pub fn plan_run_delimited(
    dialect: DialectKind,
    statements: &[String],
    delimiters: &[String],
) -> Vec<PlannedRun> {
    let utf16 = |s: &str| s.encode_utf16().count();
    let mut out = Vec::new();
    for (piece, sql) in statements.iter().enumerate() {
        let delimiter = delimiters.get(piece).map_or(";", String::as_str);
        // A running count, so a long script is read once (the ranges come in order).
        let (mut at, mut units) = (0, 0);
        for r in split_statements_from(dialect, sql, delimiter) {
            let text = &sql[r.clone()];
            if text.is_empty() {
                continue;
            }
            units += utf16(&sql[at..r.start]);
            at = r.start;
            let from = units;
            out.push(PlannedRun {
                text: text.to_string(),
                piece,
                from,
                to: from + utf16(text),
                no_where: no_where(dialect, text),
            });
        }
    }
    out
}

/// The first word of the first piece of `sql`, upper-cased; `None` when it has none.
pub fn leading_word(dialect: DialectKind, sql: &str) -> Option<String> {
    let lexed = lex(dialect, sql, false);
    let toks = &lexed.pieces.first()?.toks;
    toks.iter()
        .find_map(|t| word(&lexed.words, t).map(|(w, _)| w.to_string()))
}

/// Whether any statement of `sql` changes the schema: its first word is CREATE, ALTER,
/// DROP, RENAME, TRUNCATE or COMMENT. As `classify` does, when a backslash makes the
/// quoting depend on server settings, the other reading counts too (minus a last piece
/// it leaves inside an open literal).
pub fn is_ddl(dialect: DialectKind, sql: &str) -> bool {
    let ddl = |lexed: &Lexed| {
        lexed.pieces.iter().any(|p| {
            p.toks
                .iter()
                .find_map(|t| word(&lexed.words, t).map(|(w, _)| w))
                .is_some_and(|w| {
                    matches!(
                        w,
                        "CREATE" | "ALTER" | "DROP" | "RENAME" | "TRUNCATE" | "COMMENT"
                    )
                })
        })
    };
    if ddl(&lex(dialect, sql, false)) {
        return true;
    }
    if sql.contains('\\') {
        let mut other = lex(dialect, sql, true);
        if !other.clean {
            other.pieces.pop();
        }
        return ddl(&other);
    }
    false
}

/// Words that may stand between a table keyword and its name.
const TABLE_MODIFIERS: &[&str] = &[
    "ONLY",
    "LATERAL",
    "IF",
    "NOT",
    "EXISTS",
    "LOW_PRIORITY",
    "HIGH_PRIORITY",
    "DELAYED",
    "IGNORE",
];

/// The name parts of the (possibly dotted) name starting at token `k`, quotes removed,
/// and the index just past it. A dotted name lexes as a word holding the dots, next to
/// any quoted parts: `public."Orders"` is `public.` then `Orders`.
fn dotted_name(toks: &[PTok], k: usize) -> Option<(Vec<String>, usize)> {
    let mut parts = Vec::new();
    let mut at = k;
    let mut open_dot = false;
    while let Some(t) = toks.get(at) {
        let joins = at == k || open_dot || matches!(t, PTok::Word(w) if w.starts_with('.'));
        if !joins {
            break;
        }
        match t {
            PTok::Word(w) => {
                parts.extend(w.split('.').filter(|p| !p.is_empty()).map(str::to_string));
                open_dot = w.ends_with('.');
            }
            PTok::Quoted(q) => {
                parts.push(q.clone());
                open_dot = false;
            }
            _ => break,
        }
        at += 1;
    }
    (!parts.is_empty()).then_some((parts, at))
}

/// Whether the FROM at token `k` sits inside a call's parentheses, such as
/// `extract(year from x)`, rather than in a query.
fn from_in_call(toks: &[PTok], depths: &[usize], k: usize) -> bool {
    let Some(open) = (0..k)
        .rev()
        .find(|j| toks[*j] == PTok::Open && depths[*j] < depths[k])
    else {
        return false;
    };
    !matches!(
        toks.get(open + 1),
        Some(PTok::Word(w)) if ["SELECT", "WITH", "VALUES"].iter().any(|q| w.eq_ignore_ascii_case(q))
    )
}

/// The names a WITH clause defines: a name of a WITH list followed by `AS (` (or
/// `AS MATERIALIZED (`, `AS NOT MATERIALIZED (`), or by a column list that `cte_name`
/// accepts. `create table t as (select ...)` defines no CTE.
fn cte_names(toks: &[PTok], depths: &[usize]) -> Vec<String> {
    let is_word =
        |t: Option<&PTok>, w: &str| matches!(t, Some(PTok::Word(x)) if x.eq_ignore_ascii_case(w));
    let mut out = Vec::new();
    for (k, t) in toks.iter().enumerate() {
        let name = match t {
            PTok::Word(w) | PTok::Quoted(w) => w,
            _ => continue,
        };
        let defines = if toks.get(k + 1) == Some(&PTok::Open) {
            cte_name(toks, depths, k)
        } else if is_word(toks.get(k + 1), "AS") && cte_listed(toks, depths, k) {
            let mut at = k + 2;
            if is_word(toks.get(at), "NOT") {
                at += 1;
            }
            if is_word(toks.get(at), "MATERIALIZED") {
                at += 1;
            }
            toks.get(at) == Some(&PTok::Open)
        } else {
            false
        };
        if defines {
            out.push(name.clone());
        }
    }
    out
}

/// Words that end a FROM, UPDATE, USING or DROP TABLE list at its own depth.
const LIST_ENDS: &[&str] = &[
    "WHERE",
    "SET",
    "GROUP",
    "ORDER",
    "HAVING",
    "LIMIT",
    "WINDOW",
    "UNION",
    "EXCEPT",
    "INTERSECT",
    "RETURNING",
    "FOR",
    "OFFSET",
    "FETCH",
    "INTO",
    "CASCADE",
    "RESTRICT",
    "WHEN",
    "LOCK",
    "SELECT",
    "VALUES",
];

/// The lead word of a statement `table_refs` reads all the names of, upper-cased. A
/// CREATE, ALTER or DROP must be of a TABLE (after OR REPLACE, TEMP, TEMPORARY,
/// UNLOGGED, GLOBAL or LOCAL).
fn statement_lead(toks: &[PTok], start: usize) -> Option<String> {
    let word_at = |j: usize| match toks.get(j) {
        Some(PTok::Word(w)) => Some(w.to_uppercase()),
        _ => None,
    };
    let lead = word_at(start)?;
    match lead.as_str() {
        "SELECT" | "WITH" | "INSERT" | "REPLACE" | "UPDATE" | "DELETE" | "MERGE" | "TABLE"
        | "VALUES" | "TRUNCATE" => Some(lead),
        "CREATE" | "ALTER" | "DROP" => {
            let mut at = start + 1;
            while word_at(at).is_some_and(|w| {
                matches!(
                    w.as_str(),
                    "OR" | "REPLACE" | "TEMP" | "TEMPORARY" | "UNLOGGED" | "GLOBAL" | "LOCAL"
                )
            }) {
                at += 1;
            }
            (word_at(at).as_deref() == Some("TABLE")).then_some(lead)
        }
        _ => None,
    }
}

/// The tables `sql` names, outside strings and comments, quotes removed, a dotted name
/// reduced to its last part, deduplicated as written, minus the names a WITH list
/// defines. Names are read after FROM, JOIN, UPDATE, INTO, TABLE, USING, TRUNCATE and
/// REFERENCES (and LIKE in a CREATE, TO in an ALTER, the target of `INSERT t` without
/// INTO); FROM, UPDATE, USING, TRUNCATE and a DROP's TABLE take a comma list, and a
/// parenthesised join is read inside. A FROM inside a call (`extract(year from x)`) and
/// the UPDATE of `FOR UPDATE`, `DO UPDATE`, `KEY UPDATE` and `THEN UPDATE` name no table.
///
/// `None` when a statement is of a kind it does not read (CREATE INDEX, LOCK, a
/// statement opening with a parenthesis, ...): the caller then leaves the query out
/// rather than miss a table it names (it may wrongly exclude, never wrongly include).
pub fn table_refs(dialect: DialectKind, sql: &str) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for parts in qualified_table_refs(dialect, sql)? {
        if let Some(name) = parts.last()
            && !out.contains(name)
        {
            out.push(name.clone());
        }
    }
    Some(out)
}

/// As `table_refs`, each name with the parts written before it (`audit.orders` gives
/// `["audit", "orders"]`), deduplicated as written.
pub fn qualified_table_refs(dialect: DialectKind, sql: &str) -> Option<Vec<Vec<String>>> {
    let toks = plain_tokens(dialect, sql, false);
    let depths = depths(&toks);
    let ctes = cte_names(&toks, &depths);
    let word_at = |j: usize| match toks.get(j) {
        Some(PTok::Word(w)) => Some(w.to_uppercase()),
        _ => None,
    };
    // The lead word of the statement each token belongs to, and where each one starts.
    let mut leads: Vec<(String, usize)> = Vec::with_capacity(toks.len());
    let mut start = 0;
    let mut lead = String::new();
    for k in 0..toks.len() {
        if k == start && toks[k] != PTok::Semi {
            lead = statement_lead(&toks, k)?;
        }
        leads.push((lead.clone(), start));
        if toks[k] == PTok::Semi && depths[k] == 0 {
            start = k + 1;
        }
    }
    let mut items: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
    for (k, (lead, begins)) in leads.iter().enumerate() {
        let Some(kw) = word_at(k) else {
            continue;
        };
        let (lead, begins) = (lead.as_str(), *begins);
        let list = match kw.as_str() {
            "FROM" if from_in_call(&toks, &depths, k) => continue,
            "UPDATE"
                if k.checked_sub(1)
                    .and_then(word_at)
                    .is_some_and(|w| matches!(w.as_str(), "FOR" | "DO" | "KEY" | "THEN")) =>
            {
                continue;
            }
            // `JOIN ... USING (id)` lists columns, not tables.
            "USING"
                if toks.get(k + 1) == Some(&PTok::Open)
                    && !matches!(
                        word_at(k + 2).as_deref(),
                        Some("SELECT" | "WITH" | "VALUES")
                    ) =>
            {
                continue;
            }
            "FROM" | "UPDATE" | "USING" | "TRUNCATE" => true,
            "TABLE" => matches!(lead, "DROP" | "TRUNCATE"),
            "JOIN" | "STRAIGHT_JOIN" | "INTO" | "REFERENCES" => false,
            "LIKE" if lead == "CREATE" => false,
            "TO" if lead == "ALTER" => false,
            "INSERT" | "REPLACE" if k == begins => {
                let mut at = k + 1;
                while word_at(at).is_some_and(|w| TABLE_MODIFIERS.contains(&w.as_str())) {
                    at += 1;
                }
                if word_at(at).as_deref() != Some("INTO") {
                    items.insert(at);
                }
                continue;
            }
            _ => continue,
        };
        if list {
            list_items(&toks, &depths, k + 1, &mut items);
        } else {
            items.insert(k + 1);
        }
    }
    let mut out: Vec<Vec<String>> = Vec::new();
    // Items run in the order they are written; a parenthesised join adds later ones.
    while let Some(mut at) = items.pop_first() {
        while word_at(at).is_some_and(|w| {
            TABLE_MODIFIERS.contains(&w.as_str()) || matches!(w.as_str(), "TABLE" | "QUICK")
        }) {
            at += 1;
        }
        if toks.get(at) == Some(&PTok::Open) {
            // A subquery's own keywords name its tables; a parenthesised join is a list.
            if !matches!(
                word_at(at + 1).as_deref(),
                Some("SELECT" | "WITH" | "VALUES")
            ) {
                list_items(&toks, &depths, at + 1, &mut items);
            }
            continue;
        }
        let Some((parts, _)) = dotted_name(&toks, at) else {
            continue;
        };
        let Some(name) = parts.last() else {
            continue;
        };
        if matches!(word_at(at).as_deref(), Some("SET" | "SELECT" | "OF")) {
            continue;
        }
        if ctes.iter().any(|c| c.eq_ignore_ascii_case(name)) || out.contains(&parts) {
            continue;
        }
        out.push(parts);
    }
    Some(out)
}

/// The start of every item of the list that begins at token `start`: `start` itself and
/// the token after each comma at its depth, up to a word of `LIST_ENDS`, a `;` or the
/// close of the enclosing parenthesis.
fn list_items(
    toks: &[PTok],
    depths: &[usize],
    start: usize,
    items: &mut std::collections::BTreeSet<usize>,
) {
    let Some(&level) = depths.get(start) else {
        return;
    };
    items.insert(start);
    for j in start..toks.len() {
        if depths[j] < level {
            break;
        }
        if depths[j] > level {
            continue;
        }
        match &toks[j] {
            PTok::Semi => break,
            PTok::Comma => {
                items.insert(j + 1);
            }
            PTok::Word(w) if j > start && LIST_ENDS.iter().any(|e| w.eq_ignore_ascii_case(e)) => {
                break;
            }
            _ => {}
        }
    }
}

/// Every word and quoted identifier of `sql` outside strings and comments, quotes
/// removed, dotted names split into their parts, deduplicated as written. Numbers are
/// values, not names, and are left out.
pub fn identifiers(dialect: DialectKind, sql: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |part: &str| {
        if !part.is_empty() && !is_number(part) && !out.iter().any(|o| o == part) {
            out.push(part.to_string());
        }
    };
    for t in plain_tokens(dialect, sql, false) {
        match t {
            PTok::Word(w) => w.split('.').for_each(&mut push),
            PTok::Quoted(q) => push(&q),
            _ => {}
        }
    }
    out
}

/// `sql` with its literal values hidden, for text sent to a model: quoted strings become
/// `'…'`, numbers `?` and dollar-quoted bodies `$tag$…$tag$`. Names, keywords and comments
/// stay as written. Backslashes are read the Dialect's default way.
pub fn mask_literals(dialect: DialectKind, sql: &str) -> String {
    let mut spans = Vec::new();
    scan(dialect, sql, false, Some(&mut spans));
    let mut out = String::with_capacity(sql.len());
    let mut at = 0;
    for s in spans {
        out.push_str(&sql[at..s.start]);
        match s.mask {
            Mask::Quoted { quote, closed } => {
                out.push(quote);
                out.push('…');
                if closed {
                    out.push(quote);
                }
            }
            Mask::Number => out.push('?'),
            Mask::Dollar { tag, closed } => {
                let opener = &sql[s.start..s.start + tag];
                out.push_str(opener);
                out.push('…');
                if closed {
                    out.push_str(opener);
                }
            }
        }
        at = s.end;
    }
    out.push_str(&sql[at..]);
    out
}

/// How many values `mask_literals` hides in `sql`: numbers, then strings (quoted and
/// dollar-quoted).
pub fn literal_counts(dialect: DialectKind, sql: &str) -> (usize, usize) {
    let mut spans = Vec::new();
    scan(dialect, sql, false, Some(&mut spans));
    let numbers = spans
        .iter()
        .filter(|s| matches!(s.mask, Mask::Number))
        .count();
    (numbers, spans.len() - numbers)
}

/// Proof that the user confirmed one run; see `ConnectionService::confirm_run`.
pub type PassId = uuid::Uuid;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedStatement {
    pub text: String,
    pub class: StatementClass,
    /// The statement is in the AI SQL register: it came from an answer, unedited (R6.5).
    pub by_assistant: bool,
    /// Why a read from an answer counts as a write here (R6.4): "calls pg_sleep()".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// What the AI SQL register knows of one statement (R6.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AssistantSql {
    /// The output rail flagged a risky function or one not built into the Dialect.
    pub flagged: bool,
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
    verdict_with(conn, database, statements, &|_| None)
}

/// The class a run gives `text`: on a Production Connection a statement the AI SQL
/// register holds as flagged counts as a write (R6.4), so the register only adds
/// confirmations.
pub fn run_class(
    conn: &ConnectionConfig,
    text: &str,
    assistant: Option<AssistantSql>,
) -> StatementClass {
    if conn.production && assistant.is_some_and(|a| a.flagged) {
        StatementClass::Write
    } else {
        classify(conn.dialect, text)
    }
}

/// `verdict`, with `assistant` telling which statements are in the AI SQL register.
pub fn verdict_with(
    conn: &ConnectionConfig,
    database: Option<&str>,
    statements: &[String],
    assistant: &dyn Fn(&str) -> Option<AssistantSql>,
) -> RunVerdict {
    if !conn.production && !conn.read_only {
        return RunVerdict::Ok;
    }
    let planned: Vec<PlannedStatement> = statements
        .iter()
        .map(|text| {
            let mine = assistant(text);
            let class = run_class(conn, text, mine);
            // A read the register made a write says why (R6.4).
            let escalated = class == StatementClass::Write
                && classify(conn.dialect, text) == StatementClass::Read;
            PlannedStatement {
                text: text.clone(),
                class,
                by_assistant: mine.is_some(),
                reason: escalated
                    .then(|| crate::ai::rails::output::flag_reason(conn.dialect, text)),
            }
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

#[derive(Debug, PartialEq, Clone, Copy)]
enum Kind {
    /// Upper-cased bare word, number, variable or dotted name: a byte range of
    /// `Lexed::words`, so no word owns a `String`.
    Word(u32, u32),
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
    /// `classify_tokens` would call the piece a write whatever follows: a token other
    /// than `(` before the first word, or a first word whose branch always writes. Only
    /// the first word is kept after that, so a long INSERT holds a few tokens, not one
    /// per value. Memory only: the class and the counts are the same.
    sealed: bool,
    has_word: bool,
}

struct Lexed {
    pieces: Vec<Piece>,
    /// Each piece's text, from just after the previous `;` to its own `;` or the end.
    ranges: Vec<std::ops::Range<usize>>,
    /// False when a quoted literal was left open.
    clean: bool,
    /// The upper-cased text of every kept word, end to end.
    words: String,
}

/// First words whose `classify_tokens` branch can give Read; every other first word
/// gives Write.
pub(crate) fn may_read(dialect: DialectKind, first: &str) -> bool {
    matches!(
        first,
        "SELECT"
            | "WITH"
            | "DESCRIBE"
            | "DESC"
            | "COMMIT"
            | "ROLLBACK"
            | "SHOW"
            | "VALUES"
            | "USE"
            | "SAVEPOINT"
            | "RELEASE"
            | "EXPLAIN"
            | "BEGIN"
            | "START"
            | "SET"
    ) || dialect == DialectKind::Postgres && matches!(first, "TABLE" | "END")
        || dialect == DialectKind::Sqlite && first == "PRAGMA"
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '$' | '@' | '.')
}

/// The character at byte `i` of `s` (a character boundary), if any.
fn char_at(s: &str, i: usize) -> Option<char> {
    s.get(i..).and_then(|r| r.chars().next())
}

/// Byte index just past the closing `quote`, where a doubled quote stays inside and,
/// with `backslash`, `\x` is skipped, and whether the literal was closed. An
/// unterminated literal runs to the end of the text.
fn skip_quoted(sql: &str, start: usize, quote: char, backslash: bool) -> (usize, bool) {
    let b = sql.as_bytes();
    let q = quote as u8;
    let mut i = start + 1;
    while i < b.len() {
        let c = b[i];
        if backslash && c == b'\\' {
            i += 1 + char_at(sql, i + 1).map_or(1, char::len_utf8);
        } else if c == q {
            if b.get(i + 1) == Some(&q) {
                i += 2;
            } else {
                return (i + 1, true);
            }
        } else {
            i += 1;
        }
    }
    (b.len(), false)
}

/// Byte length of a Postgres dollar-quote opener (`$$` or `$tag$`) at `start`, if any.
fn dollar_tag_len(sql: &str, start: usize) -> Option<usize> {
    let mut i = start + 1;
    if char_at(sql, i).is_some_and(|c| c.is_alphabetic() || c == '_') {
        while let Some(c) = char_at(sql, i).filter(|c| c.is_alphanumeric() || *c == '_') {
            i += c.len_utf8();
        }
    }
    (char_at(sql, i) == Some('$')).then(|| i + 1 - start)
}

/// How `mask_literals` rewrites one literal.
enum Mask {
    Quoted {
        quote: char,
        closed: bool,
    },
    Number,
    /// `tag` is the byte length of the opener, `$` signs included.
    Dollar {
        tag: usize,
        closed: bool,
    },
}

/// A literal value at bytes `start..end` of the scanned text.
struct LiteralSpan {
    start: usize,
    end: usize,
    mask: Mask,
}

/// A word that starts a number: `10`, `1.5`, `1e3`, `0x1F`, `.5`.
fn is_number(word: &str) -> bool {
    let b = word.as_bytes();
    b[0].is_ascii_digit() || b[0] == b'.' && b.get(1).is_some_and(u8::is_ascii_digit)
}

fn is_name_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Records the literal values inside the comment text at bytes `from..to`: a quoted
/// string not straight after a letter or digit (so `don't` stays), to its closing quote
/// or the comment's end, and a digit run that is not part of a word.
fn comment_literals(
    sql: &str,
    from: usize,
    to: usize,
    record: &mut impl FnMut(usize, usize, Mask),
) {
    let b = sql.as_bytes();
    let after_name = |i: usize| sql[..i].chars().next_back().is_some_and(is_name_char);
    let mut i = from;
    while i < to {
        let c = b[i];
        if (c == b'\'' || c == b'"') && !after_name(i) {
            let close = b[i + 1..to].iter().position(|x| *x == c);
            let end = close.map_or(to, |p| i + 1 + p + 1);
            let quote = char::from(c);
            let closed = close.is_some();
            record(i, end, Mask::Quoted { quote, closed });
            i = end;
        } else if c.is_ascii_digit() && !after_name(i) {
            let run = b[i..to].iter().take_while(|x| x.is_ascii_digit()).count();
            let end = i + run;
            if !sql[end..].chars().next().is_some_and(is_name_char) {
                record(i, end, Mask::Number);
            }
            i = end;
        } else {
            i += 1;
        }
    }
}

/// With `flip`, backslash escapes are read the opposite way from the Dialect's default.
/// It walks the text by byte index (every syntax character is ASCII) and decodes a
/// character only where a Unicode rule needs one, so it holds no copy of the text.
fn lex(dialect: DialectKind, sql: &str, flip: bool) -> Lexed {
    scan(dialect, sql, flip, None)
}

/// `lex`, also pushing every literal value it passes onto `literals` in text order.
fn scan(
    dialect: DialectKind,
    sql: &str,
    flip: bool,
    mut literals: Option<&mut Vec<LiteralSpan>>,
) -> Lexed {
    let masking = literals.is_some();
    let mut record = |start: usize, end: usize, mask: Mask| {
        if let Some(l) = literals.as_deref_mut() {
            l.push(LiteralSpan { start, end, mask });
        }
    };
    let mut clean = true;
    let mysql = dialect == DialectKind::MySql;
    let postgres = dialect == DialectKind::Postgres;
    let sqlite = dialect == DialectKind::Sqlite;
    let b = sql.as_bytes();
    let len = b.len();
    let mut pieces = Vec::new();
    let mut ranges = Vec::new();
    let mut piece_from = 0;
    let mut words = String::new();
    let mut cur = Piece::default();
    let mut depth = 0usize;
    let mut i = 0;
    // Where the last token ended, and whether it was the lone word `E` (Postgres `E'..'`).
    let mut last_end = 0;
    let mut last_was_e = false;

    while let Some(c) = char_at(sql, i) {
        let next = char_at(sql, i + c.len_utf8());
        if c.is_whitespace() {
            i += c.len_utf8();
            continue;
        }
        // MySQL needs whitespace, a control character or the end after `--`.
        let dash_comment =
            c == '-' && next == Some('-') && (!mysql || mysql_comment_after(char_at(sql, i + 2)));
        if dash_comment || mysql && c == '#' {
            let body = i + if c == '#' { 1 } else { 2 };
            i = line_comment_end(b, i, postgres);
            if masking {
                comment_literals(sql, body, i, &mut record);
            }
            continue;
        }
        if c == '/' && next == Some('*') {
            // `/*! */` and MariaDB's `/*M! */` are executed by the server.
            let executed = b.get(i + 2) == Some(&b'!')
                || (b.get(i + 2) == Some(&b'M') && b.get(i + 3) == Some(&b'!'));
            if mysql && executed {
                cur.forced_write = true;
            }
            let mut level = 1;
            i += 2;
            let body = i;
            while i < len && level > 0 {
                if b[i] == b'*' && b.get(i + 1) == Some(&b'/') {
                    level -= 1;
                    i += 2;
                } else if postgres && b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
                    level += 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            if masking {
                let end = if level == 0 { i - 2 } else { len };
                comment_literals(sql, body, end, &mut record);
            }
            continue;
        }

        let start = i;
        let mut kind = Kind::Other;
        let mut e_word = false;
        match c {
            ';' => {
                if !cur.toks.is_empty() || cur.forced_write {
                    pieces.push(std::mem::take(&mut cur));
                    ranges.push(piece_from..i);
                }
                i += 1;
                piece_from = i;
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
                let (end, closed) = skip_quoted(sql, i, '\'', escapes);
                record(
                    i,
                    end,
                    Mask::Quoted {
                        quote: '\'',
                        closed,
                    },
                );
                i = end;
                clean &= closed;
            }
            '"' => {
                let (end, closed) = skip_quoted(sql, i, '"', mysql && !flip);
                // MySQL reads `"..."` as a string unless ANSI_QUOTES is on.
                if mysql {
                    record(i, end, Mask::Quoted { quote: '"', closed });
                }
                i = end;
                clean &= closed;
            }
            '`' if mysql || sqlite => i = skip_quoted(sql, i, '`', false).0,
            '[' if sqlite => {
                i = b[i + 1..]
                    .iter()
                    .position(|x| *x == b']')
                    .map_or(len, |p| i + 1 + p + 1);
            }
            '$' if postgres && dollar_tag_len(sql, i).is_some() => {
                let tag = dollar_tag_len(sql, i).unwrap_or(2);
                let opener = &sql[i..i + tag];
                i += tag;
                let close = sql[i..].find(opener);
                i = close.map_or(len, |p| i + p + tag);
                let closed = close.is_some();
                record(start, i, Mask::Dollar { tag, closed });
            }
            c if is_word_char(c) => {
                while let Some(w) = char_at(sql, i).filter(|w| is_word_char(*w)) {
                    i += w.len_utf8();
                }
                let word = &sql[start..i];
                if is_number(word) {
                    record(start, i, Mask::Number);
                }
                e_word = word.eq_ignore_ascii_case("e");
                // A sealed piece keeps no more words; the first word is always kept.
                if !cur.sealed || !cur.has_word {
                    let from = words.len() as u32;
                    words.push_str(&word.to_uppercase());
                    kind = Kind::Word(from, words.len() as u32);
                }
            }
            _ => i += c.len_utf8(),
        }

        // `"set_config"(...)` must not slip past the word check by being quoted.
        let quoted_ident =
            (c == '"' && !mysql) || (c == '`' && (mysql || sqlite)) || (c == '[' && sqlite);
        if quoted_ident {
            // The text after the opening quote, without its last character.
            let inner = &sql[start + 1..i];
            let content = &inner[..inner.char_indices().last().map_or(0, |(j, _)| j)];
            // A Postgres `U&"..."` name can spell `set_config` in escapes, so any one writes.
            let mut before = sql[..start].chars().rev();
            let (p1, p2, p3) = (before.next(), before.next(), before.next());
            let unicode_escaped = postgres
                && p1 == Some('&')
                && p2.is_some_and(|u| u.eq_ignore_ascii_case(&'u'))
                && p3.is_none_or(|w| !is_word_char(w));
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
        let is_word = matches!(kind, Kind::Word(..));
        if !cur.sealed || is_word && !cur.has_word {
            cur.toks.push(Tok {
                kind,
                depth: tok_depth,
                quoted_name: quoted_ident || (c == '"' && mysql),
            });
        }
        if !cur.has_word {
            if let Kind::Word(from, to) = kind {
                cur.has_word = true;
                cur.sealed |= !may_read(dialect, &words[from as usize..to as usize]);
            } else if kind != Kind::Open {
                cur.sealed = true;
            }
        }
        last_end = i;
        last_was_e = e_word;
    }
    if !cur.toks.is_empty() || cur.forced_write {
        pieces.push(cur);
        ranges.push(piece_from..len);
    }
    Lexed {
        pieces,
        ranges,
        clean,
        words,
    }
}

/// Last dotted segment without a leading `@`: `@@SESSION.TX_READ_ONLY` becomes `TX_READ_ONLY`.
fn base_name(w: &str) -> &str {
    w.rsplit('.').next().unwrap_or(w).trim_start_matches('@')
}

fn word<'w>(words: &'w str, t: &Tok) -> Option<(&'w str, usize)> {
    match t.kind {
        Kind::Word(from, to) => Some((&words[from as usize..to as usize], t.depth)),
        _ => None,
    }
}

fn has_pair(words: &[&str], a: &str, b: &str) -> bool {
    words.windows(2).any(|w| w[0] == a && w[1] == b)
}

fn classify_tokens(dialect: DialectKind, toks: &[Tok], wt: &str) -> StatementClass {
    use StatementClass::{Read, Write};
    // Only leading `(` may come before the first word, as in `(SELECT 1) UNION (SELECT 2)`.
    let Some(start) = toks.iter().position(|t| word(wt, t).is_some()) else {
        return Write;
    };
    if toks[..start].iter().any(|t| t.kind != Kind::Open) {
        return Write;
    }
    let words: Vec<(&str, usize)> = toks[start..].iter().filter_map(|t| word(wt, t)).collect();
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
        "DESCRIBE" | "DESC" => explain_class(dialect, &toks[start + 1..], wt),
        "COMMIT" | "ROLLBACK" if top.get(1) == Some(&"PREPARED") => Write,
        "SHOW" | "VALUES" | "USE" | "COMMIT" | "ROLLBACK" | "SAVEPOINT" | "RELEASE" => Read,
        "TABLE" | "END" if dialect == DialectKind::Postgres => Read,
        "PRAGMA" if dialect == DialectKind::Sqlite => pragma_class(&toks[start..], &all),
        "EXPLAIN" => explain_class(dialect, &toks[start + 1..], wt),
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
        "SET" => set_class(dialect, &toks[start..], &all, wt),
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
fn explain_class(dialect: DialectKind, rest: &[Tok], wt: &str) -> StatementClass {
    let is_analyze = |w: &str| matches!(w, "ANALYZE" | "ANALYSE");
    let inner = match rest.first() {
        Some(t) if word(wt, t).is_some_and(|(w, _)| is_analyze(w)) => &rest[1..],
        Some(t) if t.kind == Kind::Open => {
            let open_depth = rest[0].depth;
            let Some(close) = rest
                .iter()
                .position(|t| t.kind == Kind::Close && t.depth == open_depth)
            else {
                // Unclosed option list: not a statement the server would accept as a read.
                return StatementClass::Write;
            };
            // A quoted option could be spelled ANALYZE, so any quoted token counts.
            let analyze = rest[1..close].iter().any(|t| match t.kind {
                Kind::Word(..) => word(wt, t).is_some_and(|(w, _)| is_analyze(w)),
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
        match inner.first().and_then(|t| word(wt, t)).map(|(w, _)| w) {
            Some("VERBOSE") => inner = &inner[1..],
            Some("FORMAT") if inner.get(1).is_some_and(|t| t.kind == Kind::Eq) => {
                inner = &inner[(3).min(inner.len())..];
            }
            _ => break,
        }
    }
    if inner.is_empty() {
        StatementClass::Write
    } else {
        classify_tokens(dialect, inner, wt)
    }
}

/// Whether a quoted name sits where a SET names its setting: before the `=` or `TO`, in
/// each assignment. Quoting can spell any setting, `U&"..."` escapes included, so the
/// name is never read. Postgres sets one setting, so a comma there starts another value.
fn quoted_setting_name(dialect: DialectKind, toks: &[Tok], wt: &str) -> bool {
    let Some(set) = toks.first() else {
        return false;
    };
    let mut in_name = true;
    for t in &toks[1..] {
        match t.kind {
            Kind::Comma if t.depth == set.depth && dialect != DialectKind::Postgres => {
                in_name = true;
            }
            Kind::Eq => in_name = false,
            Kind::Word(..) if word(wt, t).is_some_and(|(w, _)| w == "TO") => in_name = false,
            _ if in_name && t.quoted_name => return true,
            _ => {}
        }
    }
    false
}

/// `toks` starts at `SET`; `all` holds every word of the piece.
fn set_class(dialect: DialectKind, toks: &[Tok], all: &[&str], wt: &str) -> StatementClass {
    if quoted_setting_name(dialect, toks, wt) {
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
    let scope_word = |i: usize| word(wt, &toks[i]).is_some_and(|(w, _)| PERSISTENT.contains(&w));
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

/// The 5a classifier case table, shared with the script splitter's tests (D2).
#[cfg(test)]
pub(crate) mod cases {
    use super::StatementClass;
    use crate::model::DialectKind;

    const PG: DialectKind = DialectKind::Postgres;
    const MY: DialectKind = DialectKind::MySql;
    const SL: DialectKind = DialectKind::Sqlite;
    const R: StatementClass = StatementClass::Read;
    const W: StatementClass = StatementClass::Write;

    pub const CASES: &[(DialectKind, &str, StatementClass)] = &[
        // Postgres
        (PG, "select 1", R),
        (PG, "SELECT 'DELETE FROM x'", R),
        (PG, "/* drop */ SELECT 1", R),
        (PG, "-- delete\nSELECT 1", R),
        // A lone CR ends a line comment, as in PostgreSQL's lexer.
        (PG, "-- note\rDROP TABLE orders", W),
        (PG, "SELECT 1; -- note\r\nDELETE FROM orders", W),
        // MySQL and SQLite read a line comment to the LF, past a lone CR, as their servers do.
        (MY, "-- note\rDROP TABLE orders", R),
        (MY, "# note\rDROP TABLE orders", R),
        (SL, "-- note\rDROP TABLE orders", R),
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
}

#[cfg(test)]
mod tests {
    use super::cases::CASES;
    use super::*;

    const PG: DialectKind = DialectKind::Postgres;
    const MY: DialectKind = DialectKind::MySql;
    const SL: DialectKind = DialectKind::Sqlite;
    const R: StatementClass = StatementClass::Read;
    const W: StatementClass = StatementClass::Write;

    fn refs(dialect: DialectKind, sql: &str) -> Vec<String> {
        table_refs(dialect, sql).unwrap_or_else(|| panic!("unsure: {sql}"))
    }

    #[test]
    fn is_ddl_cases() {
        for sql in [
            "create table t(a int)",
            "  ALTER TABLE x",
            "select 1; drop table t",
            "comment on table t is 'x'",
            "rename table a to b",
            "truncate t",
        ] {
            assert!(is_ddl(PG, sql), "{sql}");
        }
        for sql in [
            "select 'create table'",
            "-- drop table t
select 1",
            "insert into t values (1)",
            "",
        ] {
            assert!(!is_ddl(PG, sql), "{sql}");
        }
        assert!(is_ddl(MY, "/* x */ DROP TABLE t"));
        // With NO_BACKSLASH_ESCAPES the backslash ends the literal, so DROP runs.
        assert!(is_ddl(MY, r"select 'a\'; drop table t; --'"));
        // Either reading of the backslash keeps this one statement.
        assert!(!is_ddl(MY, r"select 'a\' drop table t'"));
    }

    #[test]
    fn table_refs_cases() {
        assert_eq!(
            refs(
                PG,
                "select * from orders o join public.\"Customers\" c on o.customer_id = c.id"
            ),
            ["orders", "Customers"]
        );
        assert_eq!(
            refs(
                PG,
                "select 'from secret' from orders -- join hidden
"
            ),
            ["orders"]
        );
        assert_eq!(
            refs(PG, "select * /* from hidden */ from orders"),
            ["orders"]
        );
        assert_eq!(
            refs(
                PG,
                "with recent as (select * from orders) select * from recent"
            ),
            ["orders"]
        );
        assert_eq!(
            refs(
                PG,
                "with a (x) as (select 1 from items), b as materialized (select * from a)                  select * from b join items i on true"
            ),
            ["items"]
        );
        assert_eq!(refs(PG, "update stock set qty = 1"), ["stock"]);
        assert_eq!(refs(PG, "insert into audit_log values (1)"), ["audit_log"]);
        assert_eq!(refs(MY, "select * from `shop`.`Orders`"), ["Orders"]);
        assert_eq!(
            refs(
                PG,
                "select * from orders join orders o2 on true join Orders x on true"
            ),
            ["orders", "Orders"]
        );
        assert_eq!(
            refs(PG, "select extract(year from created_at) from orders"),
            ["orders"]
        );
        assert_eq!(
            refs(PG, "select * from t where id in (select id from u)"),
            ["t", "u"]
        );
        assert_eq!(refs(PG, "select * from only orders for update"), ["orders"]);
        assert_eq!(
            refs(
                MY,
                "insert into t (a) values (1) on duplicate key update a = 2"
            ),
            ["t"]
        );
        assert_eq!(refs(PG, "drop table if exists old_t"), ["old_t"]);
        assert!(refs(PG, "select 1").is_empty());
        assert!(refs(PG, "select * from (select 1) s").is_empty());
        // Comma lists, USING, parenthesised joins.
        assert_eq!(
            refs(PG, "select * from orders o, secret_t s where o.id = s.id"),
            ["orders", "secret_t"]
        );
        assert_eq!(
            refs(MY, "update orders, other set orders.a = other.b"),
            ["orders", "other"]
        );
        assert_eq!(
            refs(PG, "drop table orders, missing cascade"),
            ["orders", "missing"]
        );
        assert_eq!(refs(PG, "truncate table a, b"), ["a", "b"]);
        assert_eq!(
            refs(
                PG,
                "delete from orders using archive a where orders.id = a.id"
            ),
            ["orders", "archive"]
        );
        assert_eq!(
            refs(
                PG,
                "merge into orders o using staged s on o.id = s.id when matched then update set a = 1"
            ),
            ["orders", "staged"]
        );
        assert_eq!(
            refs(
                PG,
                "select * from (orders o join customers c on o.c = c.id) x, extra"
            ),
            ["orders", "customers", "extra"]
        );
        assert_eq!(
            refs(PG, "select * from (select 1) s, secret_t"),
            ["secret_t"]
        );
        assert_eq!(
            refs(PG, "select * from a join b using (id), c"),
            ["a", "b", "c"]
        );
        assert_eq!(
            refs(
                PG,
                "select * from a join b on a.x = b.y, c where c.z in (1, 2)"
            ),
            ["a", "b", "c"]
        );
        assert_eq!(refs(PG, "update t set a = 1, b = 2 where c = 3"), ["t"]);
        // `name AS (` is a CTE only in a WITH list.
        assert_eq!(
            refs(PG, "create table newt as (select * from orders)"),
            ["newt", "orders"]
        );
        assert_eq!(refs(PG, "select x as (y) from orders"), ["orders"]);
        assert_eq!(
            refs(MY, "insert secret_t select * from orders"),
            ["secret_t", "orders"]
        );
        assert_eq!(
            refs(
                PG,
                "alter table orders add foreign key (c) references secret_t (id)"
            ),
            ["orders", "secret_t"]
        );
        assert_eq!(
            refs(MY, "create table copy_t like secret_t"),
            ["copy_t", "secret_t"]
        );
        // Shapes it does not read leave the query out.
        for sql in [
            "create index ix on secret_t (a)",
            "lock tables secret_t read",
            "(select * from orders) union (select * from secret_t)",
            "select * from orders; vacuum secret_t",
            "create view v as select * from orders",
        ] {
            assert_eq!(table_refs(PG, sql), None, "{sql}");
        }
    }

    #[test]
    fn identifiers_cases() {
        assert_eq!(
            identifiers(
                PG,
                "select o.id, \"Total\" from public.orders o where name = 'bob' -- note
 and x > 42"
            ),
            [
                "select", "o", "id", "Total", "from", "public", "orders", "where", "name", "and",
                "x"
            ]
        );
        assert_eq!(
            identifiers(MY, "SELECT `a b`.c FROM t /* hidden */ JOIN t"),
            ["SELECT", "a b", "c", "FROM", "t", "JOIN"]
        );
    }

    #[test]
    fn statement_count_counts_top_level_pieces() {
        assert_eq!(statement_count(PG, "SELECT 1; SELECT 2"), 2);
        assert_eq!(statement_count(PG, "SELECT ';'"), 1);
        assert_eq!(statement_count(MY, "-- c\nSELECT 1;"), 1);
        assert_eq!(statement_count(SL, "  "), 0);
        assert_eq!(statement_count(MY, "SELECT 'a\\'; DELETE FROM t; -- '"), 2);
    }

    #[test]
    fn explain_without_analyze_is_read_and_with_analyze_never_is() {
        let cases: &[(DialectKind, &str, StatementClass)] = &[
            (MY, "EXPLAIN FORMAT=TREE UPDATE t SET a = 9", R),
            (MY, "EXPLAIN FORMAT=TREE DELETE FROM t", R),
            (MY, "EXPLAIN UPDATE t SET a = 9", R),
            (MY, "EXPLAIN ANALYZE FORMAT=TREE DELETE FROM t", W),
            (PG, "EXPLAIN (FORMAT JSON) UPDATE t SET a = 9", R),
            (PG, "EXPLAIN (FORMAT JSON) DELETE FROM t", R),
            (PG, "EXPLAIN (FORMAT JSON, ANALYZE) DELETE FROM t", W),
            (PG, "EXPLAIN (ANALYZE, FORMAT JSON) UPDATE t SET a = 9", W),
            (PG, "EXPLAIN ANALYZE UPDATE t SET a = 9", W),
            (SL, "EXPLAIN QUERY PLAN UPDATE t SET a = 9", R),
            (SL, "EXPLAIN QUERY PLAN DELETE FROM t", R),
        ];
        for (d, sql, want) in cases {
            assert_eq!(classify(*d, sql), *want, "{d:?}: {sql:?}");
        }
    }

    #[test]
    fn leading_word_skips_comments() {
        assert_eq!(
            leading_word(PG, "-- x\n explain select 1").as_deref(),
            Some("EXPLAIN")
        );
        assert_eq!(leading_word(PG, "  "), None);
    }

    #[test]
    fn masks_strings_and_numbers() {
        assert_eq!(
            mask_literals(PG, "where a = 'x' and b > 10"),
            "where a = '…' and b > ?"
        );
    }

    #[test]
    fn mysql_backslash_quote_is_one_literal() {
        assert_eq!(mask_literals(MY, "select 'it\\'s', 2"), "select '…', ?");
    }

    #[test]
    fn postgres_e_string_is_one_literal() {
        assert_eq!(mask_literals(PG, "select E'a\\'b'"), "select E'…'");
    }

    #[test]
    fn dollar_body_masked_tag_kept() {
        assert_eq!(
            mask_literals(PG, "select $fn$ secret $fn$"),
            "select $fn$…$fn$"
        );
    }

    #[test]
    fn identifiers_untouched() {
        let pg = "select \"col 1\", t2.x3 from t2";
        assert_eq!(mask_literals(PG, pg), pg);
        let my = "select `col 1`, t2.x3 from t2";
        assert_eq!(mask_literals(MY, my), my);
    }

    #[test]
    fn numbers_inside_names_untouched() {
        let sql = "select c1 from t_2024";
        assert_eq!(mask_literals(PG, sql), sql);
    }

    #[test]
    fn comment_literals_masked() {
        assert_eq!(
            mask_literals(PG, "select 1 -- id = 42 and name = 'bob'"),
            "select ? -- id = ? and name = '…'"
        );
        assert_eq!(
            mask_literals(MY, "/* code 'x9' */ select a"),
            "/* code '…' */ select a"
        );
        // Digits inside a word stay; the next line is still read as SQL.
        assert_eq!(
            mask_literals(PG, "-- see t_2024 v2 # 7\nselect 3"),
            "-- see t_2024 v2 # ?\nselect ?"
        );
    }

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

    fn same_as_frozen(d: DialectKind, sql: &str) {
        use super::frozen_lex as old;
        assert_eq!(classify(d, sql), old::classify(d, sql), "{d:?}: {sql:?}");
        assert_eq!(
            statement_count(d, sql),
            old::statement_count(d, sql),
            "{d:?}: {sql:?}"
        );
        assert_eq!(
            leading_word(d, sql),
            old::leading_word(d, sql),
            "{d:?}: {sql:?}"
        );
    }

    /// Q40: the byte lexer with sealing gives the same answers as the lexer before it,
    /// on every case text in every Dialect and on seeded joins of them.
    #[test]
    fn byte_lexer_matches_the_frozen_lexer() {
        for (_, sql, _) in CASES {
            for d in [PG, MY, SL] {
                same_as_frozen(d, sql);
            }
        }
        let mut seed: u64 = 0x0dd5eed;
        let mut next = move || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 33) as usize
        };
        const JOINS: [&str; 4] = [";", "; ", ";\n", " ;"];
        for _ in 0..4000 {
            let n = 1 + next() % 5;
            let mut sql = String::new();
            for k in 0..n {
                if k > 0 {
                    sql.push_str(JOINS[next() % JOINS.len()]);
                }
                sql.push_str(CASES[next() % CASES.len()].1);
            }
            for d in [PG, MY, SL] {
                same_as_frozen(d, &sql);
            }
        }
    }

    /// Separators `plain_tokens` sees: each `;` that ends a piece holding anything, as
    /// `lex` drops a `;` that follows nothing.
    fn plain_semis(d: DialectKind, s: &str, flip: bool) -> usize {
        let mut open = false;
        let mut n = 0;
        for t in plain_tokens(d, s, flip) {
            if t == PTok::Semi {
                n += usize::from(open);
                open = false;
            } else {
                open = true;
            }
        }
        n
    }

    /// Separators `lex` sees: a range ends at its `;`, except the last, which ends at the
    /// end of the text (and may end in a `;` inside an open string).
    fn lex_semis(d: DialectKind, s: &str, flip: bool) -> usize {
        lex(d, s, flip)
            .ranges
            .iter()
            .filter(|r| r.end < s.len())
            .count()
    }

    fn assert_tokenizers_agree(d: DialectKind, s: &str, flip: bool) {
        // Deliberate: `plain_tokens` reads a MySQL `/*! */` body as code, since the server
        // runs it, and `lex` skips it as a comment. The rail then sees more, never less.
        if d == MY && (s.contains("/*!") || s.contains("/*M!")) {
            let p = format!("{s}\n;select zz_probe(1)");
            let seen = calls_in(&plain_tokens(d, &p, flip)).contains(&"zz_probe".to_string());
            let code = lex(d, &p, flip).words.contains("ZZ_PROBE");
            assert!(seen || !code, "{d:?} flip={flip}: {s:?}");
            return;
        }
        assert_eq!(
            plain_semis(d, s, flip),
            lex_semis(d, s, flip),
            "{d:?} flip={flip}: {s:?}"
        );
        let p = format!("{s}\n;select zz_probe(1)");
        let seen = calls_in(&plain_tokens(d, &p, flip)).contains(&"zz_probe".to_string());
        // The brief's `lex_semis(p) > lex_semis(s)` is false for a text holding nothing
        // or ending in `;` (the probe's `;` then ends no piece) though the probe is code: ask `lex` for the
        // probe as a word instead, which it keeps only when it reads it as code.
        let code = lex(d, &p, flip).words.contains("ZZ_PROBE");
        assert_eq!(seen, code, "probe {d:?} flip={flip}: {s:?}");
    }

    /// The AI output rail's tokenizer finds a statement boundary wherever 5a's lexer does.
    #[test]
    fn plain_tokens_agree_with_lex() {
        const TRAPS: &[&str] = &[
            "E'a\\';' ; select 1",
            "select $t$ ; $t$",
            "select $$;$$",
            "/* /* */ ; */ select 1",
            "# ; \nselect 1",
            "--x;\nselect 1",
            "select 1 --;\n",
            "/*! select 1; */",
            "select `a;b`",
            "select \"a;b\"",
            "select [a;b]",
            "select x'3b'",
            "select N';'",
            "select U&';'",
            "select B'0'",
            "select 'it''s;'",
            "select 'a\\';'",
            "select 'abc",
            "select \"abc",
            "select 1 /* abc",
            "select $q$ abc",
        ];
        let mut texts: Vec<String> = CASES.iter().map(|c| c.1.to_string()).collect();
        texts.extend(TRAPS.iter().map(|t| t.to_string()));
        let mut seed: u64 = 0x0dd5eed;
        let mut next = move || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 33) as usize
        };
        const JOINS: [&str; 4] = [";", "; ", ";\n", " ;"];
        for _ in 0..2000 {
            let n = 1 + next() % 5;
            let mut sql = String::new();
            for k in 0..n {
                if k > 0 {
                    sql.push_str(JOINS[next() % JOINS.len()]);
                }
                sql.push_str(CASES[next() % CASES.len()].1);
            }
            texts.push(sql);
        }
        for s in &texts {
            for d in [PG, MY, SL] {
                for flip in [false, true] {
                    assert_tokenizers_agree(d, s, flip);
                }
            }
        }
    }

    #[test]
    fn keyword_names_called_as_functions_are_flagged() {
        for d in [MY, PG] {
            for name in ["index", "key", "match", "range", "cube", "time"] {
                let calls = function_calls(d, &format!("select {name}(1)"));
                assert!(calls.contains(&name.to_string()), "{d:?} {name}: {calls:?}");
            }
            for (sql, name) in [
                ("create index i on t (a)", "index"),
                ("select * from t use index (i)", "index"),
                ("select * from t where match (a) against ('x')", "match"),
                ("select a from t group by cube (a)", "cube"),
                ("select cast(x as time(3))", "time"),
                ("alter table t add primary key (a)", "key"),
            ] {
                let calls = function_calls(d, sql);
                assert!(!calls.contains(&name.to_string()), "{d:?} {sql}: {calls:?}");
            }
        }
    }
}

#[cfg(test)]
mod frozen_lex;

#[cfg(test)]
mod verdict_tests {
    use super::*;
    use crate::model::{ConnectionConfig, SslMode};

    const PG: DialectKind = DialectKind::Postgres;
    const MY: DialectKind = DialectKind::MySql;
    const R: StatementClass = StatementClass::Read;
    const W: StatementClass = StatementClass::Write;

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
            ai_sync: Default::default(),
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

    #[test]
    fn split_statements_ranges() {
        let sql = "  SELECT 1;\n\n -- note\nSELECT ';' ; ;  DELETE FROM t  ";
        let got: Vec<&str> = split_statements(PG, sql)
            .into_iter()
            .map(|r| &sql[r])
            .collect();
        assert_eq!(got, ["SELECT 1", "-- note\nSELECT ';'", "DELETE FROM t"]);
        assert!(split_statements(PG, " ; -- only\n ").is_empty());
        let dollar = "select $$a;b$$; select 2;";
        let got: Vec<&str> = split_statements(PG, dollar)
            .into_iter()
            .map(|r| &dollar[r])
            .collect();
        assert_eq!(got, ["select $$a;b$$", "select 2"]);
        assert_eq!(split_statements(MY, "SELECT 1 # ;\n; SELECT 2").len(), 2);
    }

    #[test]
    fn function_calls_skip_keywords_and_strings() {
        assert_eq!(
            function_calls(PG, "select count(*) from t where x in (1) and f('g(')"),
            ["count", "f"]
        );
        assert_eq!(
            function_calls(PG, "SELECT pg_catalog.Now (), -- x(\n \"Odd\"(1) FROM t"),
            ["pg_catalog.now", "odd"]
        );
        assert_eq!(
            function_calls(
                PG,
                "WITH c(a) AS (SELECT 1) SELECT CAST(a AS varchar(3)) FROM c WHERE EXISTS (SELECT 1) AND a = ANY (ARRAY[1])"
            ),
            ["cast"]
        );
        assert_eq!(
            function_calls(PG, "select $$f(1)$$, 'x'"),
            Vec::<String>::new()
        );
        assert_eq!(function_calls(MY, "SELECT SLEEP(1) # g(\n"), ["sleep"]);
        assert_eq!(
            function_calls(PG, "SELECT \"a\".\"B\".f(1), \"pg_catalog\".pg_sleep(1)"),
            ["a.b.f", "pg_catalog.pg_sleep"]
        );
        assert_eq!(function_calls(MY, "SELECT `d`.sleep(1)"), ["d.sleep"]);
        assert_eq!(
            function_calls(PG, "SELECT 1, f(1) AS materialized, g(2) AS not"),
            ["f", "g"]
        );
        // NO_BACKSLASH_ESCAPES reads this as two strings around a call.
        assert_eq!(
            function_calls(MY, r"select '\' , sleep(1) , '\'"),
            ["sleep"]
        );
    }

    #[test]
    fn keyword_named_calls_count_in_expressions() {
        // Final review F5: a function named like a keyword is still a call in an expression.
        assert_eq!(
            function_calls(
                PG,
                "SELECT index(a), key(b), match(c), range(d), cube(e), time(f) FROM t"
            ),
            ["index", "key", "match", "range", "cube", "time"]
        );
        assert_eq!(
            function_calls(MY, "SELECT a FROM t WHERE x = key(1) GROUP BY a, b"),
            ["key"]
        );
        // Their keyword uses are not calls.
        let words = ["index", "key", "match", "range", "cube", "time"];
        for (d, sql) in [
            (
                MY,
                "CREATE TABLE t (a int, b time(3), KEY (a), INDEX (b), PRIMARY KEY (a), UNIQUE KEY (b))",
            ),
            (MY, "ALTER TABLE t ADD INDEX (a), ADD KEY (b)"),
            (MY, "SELECT a FROM t USE INDEX (i) WHERE b = 1"),
            (MY, "SELECT a FROM t FORCE KEY (i)"),
            (MY, "SELECT a FROM t IGNORE INDEX (i)"),
            (MY, "SELECT a FROM t WHERE MATCH (a, b) AGAINST ('x')"),
            (PG, "SELECT a, b FROM t GROUP BY CUBE (a, b)"),
            (PG, "SELECT a, b FROM t GROUP BY a, CUBE (b)"),
            (
                MY,
                "CREATE TABLE t (a int) PARTITION BY RANGE (a) (PARTITION p0 VALUES LESS THAN (10))",
            ),
            (PG, "SELECT CAST(a AS TIME(3)), b::time(0) FROM t"),
            (PG, "CREATE TABLE t (a time(3) with time zone)"),
        ] {
            let calls = function_calls(d, sql);
            assert!(
                !calls.iter().any(|c| words.contains(&c.as_str())),
                "{sql}: {calls:?}"
            );
        }
    }

    #[test]
    fn writes_to_file_cases() {
        assert!(writes_to_file(MY, "SELECT * FROM t INTO OUTFILE '/tmp/x'"));
        assert!(writes_to_file(MY, "select a into dumpfile '/tmp/x' from t"));
        assert!(!writes_to_file(MY, "SELECT 'INTO OUTFILE' FROM t"));
        assert!(!writes_to_file(MY, "SELECT a INTO @v FROM t"));
    }

    #[test]
    fn missing_where_cases() {
        assert_eq!(missing_where(PG, "UPDATE t SET a = 1"), Some("UPDATE"));
        assert_eq!(missing_where(PG, "delete from t"), Some("DELETE"));
        assert_eq!(missing_where(PG, "DELETE FROM t WHERE id = 1"), None);
        assert_eq!(
            missing_where(PG, "UPDATE t SET a = (SELECT 1 FROM s WHERE s.x = 1)"),
            Some("UPDATE")
        );
        assert_eq!(
            missing_where(PG, "WITH c AS (SELECT 1 WHERE true) DELETE FROM t"),
            Some("DELETE")
        );
        assert_eq!(
            missing_where(PG, "UPDATE t SET a = 'where'"),
            Some("UPDATE")
        );
        assert_eq!(missing_where(PG, "SELECT 1"), None);
        assert_eq!(missing_where(PG, "INSERT INTO t VALUES (1)"), None);
        assert_eq!(
            missing_where(MY, "DELETE FROM t -- WHERE id = 1"),
            Some("DELETE")
        );
    }

    #[test]
    fn assistant_statements_escalate_on_production_only() {
        let flagged = |t: &str| (t == "SELECT f()").then_some(AssistantSql { flagged: true });
        let plain = |t: &str| (t == "SELECT 1").then_some(AssistantSql { flagged: false });
        let stmts = vec!["SELECT f()".to_string(), "SELECT 1".to_string()];
        let RunVerdict::NeedsConfirmation {
            statements, writes, ..
        } = verdict_with(&conn(true, false), None, &stmts, &flagged)
        else {
            panic!("a flagged read on Production needs a pass");
        };
        assert_eq!(writes, 1);
        assert_eq!(statements[0].class, W);
        assert!(statements[0].by_assistant);
        assert!(!statements[1].by_assistant);
        assert_eq!(
            verdict_with(&conn(true, false), None, &stmts, &plain),
            RunVerdict::Ok
        );
        assert_eq!(
            verdict_with(&conn(false, false), None, &stmts, &flagged),
            RunVerdict::Ok
        );
        assert_eq!(
            verdict_with(&conn(false, true), None, &stmts, &flagged),
            RunVerdict::Ok
        );
        let mixed = vec!["SELECT 1".to_string(), "DELETE FROM t".to_string()];
        let RunVerdict::NeedsConfirmation { statements, .. } =
            verdict_with(&conn(true, false), None, &mixed, &plain)
        else {
            panic!("a write needs a pass");
        };
        assert!(statements[0].by_assistant);
        assert_eq!(statements[0].class, R);
    }
}

/// UX step 9, round 4: the missing-WHERE ask and the statements that run come from the
/// Core's lexer, for every input the round 2 and round 3 reviews found.
#[cfg(test)]
mod no_where_tests {
    use super::*;

    const PG: DialectKind = DialectKind::Postgres;
    const MY: DialectKind = DialectKind::MySql;
    const SL: DialectKind = DialectKind::Sqlite;
    const ALL: [DialectKind; 3] = [PG, MY, SL];

    fn verb(d: DialectKind, sql: &str) -> Option<String> {
        no_where(d, sql).map(|n| n.verb)
    }

    #[test]
    fn plain_updates_and_deletes() {
        for d in ALL {
            assert_eq!(verb(d, "DELETE FROM t"), Some("DELETE".into()), "{d:?}");
            assert_eq!(
                verb(d, "update t set a = 1"),
                Some("UPDATE".into()),
                "{d:?}"
            );
            assert_eq!(verb(d, "UPDATE t SET a = 1 WHERE id = 2"), None, "{d:?}");
            assert_eq!(
                verb(d, "UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1)"),
                Some("UPDATE".into()),
                "{d:?}"
            );
            assert_eq!(
                verb(d, "-- WHERE\nDELETE FROM t"),
                Some("DELETE".into()),
                "{d:?}"
            );
            assert_eq!(verb(d, "SELECT 1"), None, "{d:?}");
            assert_eq!(
                no_where(d, "DELETE FROM sales.orders").unwrap().table,
                "sales.orders"
            );
        }
        assert_eq!(
            no_where(MY, "DELETE LOW_PRIORITY QUICK FROM `t`")
                .unwrap()
                .table,
            "t"
        );
    }

    #[test]
    fn a_cte_write_is_checked() {
        for d in ALL {
            assert_eq!(
                verb(d, "WITH x AS (SELECT 1) DELETE FROM t"),
                Some("DELETE".into()),
                "{d:?}"
            );
            assert_eq!(
                verb(d, "WITH x AS (SELECT 1) UPDATE t SET a = 1"),
                Some("UPDATE".into()),
                "{d:?}"
            );
            assert_eq!(
                verb(d, "WITH x AS (SELECT 1 WHERE true) DELETE FROM t"),
                Some("DELETE".into()),
                "{d:?}"
            );
            assert_eq!(
                verb(
                    d,
                    "WITH x AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT * FROM x)"
                ),
                None,
                "{d:?}"
            );
        }
    }

    #[test]
    fn round_2_mysql_executable_comments_and_dashes() {
        assert_eq!(verb(MY, "/*! DELETE FROM t */"), Some("DELETE".into()));
        assert_eq!(
            verb(MY, "/*!40101 UPDATE t SET a=1 */"),
            Some("UPDATE".into())
        );
        assert_eq!(verb(MY, "UPDATE t SET a=1 /*! WHERE id = 1 */"), None);
        assert_eq!(verb(PG, "/*! DELETE FROM t */"), None);
        // `--` needs white space on MySQL: `1--1` is code, and the DELETE is its own statement.
        let plan = plan_run(MY, &["SELECT 1--1; DELETE FROM t".into()]);
        assert_eq!(
            plan.iter().map(|p| p.text.as_str()).collect::<Vec<_>>(),
            ["SELECT 1--1", "DELETE FROM t"]
        );
        assert_eq!(
            plan[1].no_where.as_ref().map(|n| n.verb.as_str()),
            Some("DELETE")
        );
        assert_eq!(verb(MY, "DELETE FROM t WHERE a = 1--1"), None);
    }

    #[test]
    fn round_2_postgres_comments_nest() {
        assert_eq!(
            verb(PG, "DELETE FROM t /* a /* b */ WHERE id=1 */"),
            Some("DELETE".into())
        );
        assert_eq!(
            verb(PG, "/* a /* b */ c */ DELETE FROM t"),
            Some("DELETE".into())
        );
        assert_eq!(verb(MY, "DELETE FROM t /* a /* b */ WHERE id=1"), None);
    }

    #[test]
    fn c1_a_semicolon_inside_an_executable_comment_still_asks() {
        assert_eq!(
            verb(MY, "/*! SELECT 1; DELETE FROM t */"),
            Some("DELETE".into())
        );
        assert_eq!(
            verb(MY, "SELECT 1 /*! ; DELETE FROM t */"),
            Some("DELETE".into())
        );
        assert_eq!(
            verb(MY, "SELECT 1 /*! ; DELETE FROM t WHERE id = 1 */"),
            None
        );
    }

    #[test]
    fn c2_sqlite_bracket_names() {
        let texts = |sql: &str| {
            plan_run(SL, &[sql.into()])
                .into_iter()
                .map(|p| p.text)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            texts("SELECT [--]; DELETE FROM t"),
            ["SELECT [--]", "DELETE FROM t"]
        );
        assert_eq!(
            plan_run(SL, &["SELECT [--]; DELETE FROM t".into()])[1]
                .no_where
                .as_ref()
                .unwrap()
                .verb,
            "DELETE"
        );
        assert_eq!(texts("SELECT [a;b] FROM t"), ["SELECT [a;b] FROM t"]);
        assert_eq!(
            texts("SELECT [x;DELETE FROM t;y]"),
            ["SELECT [x;DELETE FROM t;y]"]
        );
        assert_eq!(verb(SL, "SELECT [x;DELETE FROM t;y]"), None);
    }

    #[test]
    fn c3_a_postgres_word_ending_in_e_is_not_an_escape_string() {
        let plan = plan_run(PG, &["SELECT DATE'\\'; DELETE FROM t; SELECT '".into()]);
        assert_eq!(plan.len(), 3, "{plan:?}");
        assert_eq!(plan[1].text, "DELETE FROM t");
        assert_eq!(plan[1].no_where.as_ref().unwrap().verb, "DELETE");
        for w in ["TIME", "NAME"] {
            let plan = plan_run(PG, &[format!("SELECT {w}'\\'; DELETE FROM t")]);
            assert_eq!(plan.len(), 2, "{w}");
        }
    }

    #[test]
    fn c4_a_where_only_in_a_version_gated_comment_does_not_count() {
        assert_eq!(
            verb(MY, "DELETE FROM t /*!99999 WHERE id=1 */"),
            Some("DELETE".into())
        );
        assert_eq!(
            verb(MY, "DELETE FROM t /*M!100100 WHERE id=1 */"),
            Some("DELETE".into())
        );
        assert_eq!(
            verb(MY, "DELETE FROM t /*M! WHERE id=1 */"),
            Some("DELETE".into())
        );
        // In the same gated comment as the verb, it runs or not with it.
        assert_eq!(verb(MY, "/*!50000 DELETE FROM t WHERE id=1 */"), None);
    }

    #[test]
    fn c5_mysql_dash_dash_then_a_control_character_is_a_comment() {
        assert_eq!(
            verb(MY, "DELETE FROM t --\u{1}WHERE id=1\n"),
            Some("DELETE".into())
        );
        assert_eq!(
            verb(MY, "DELETE FROM t --\tWHERE id=1\n"),
            Some("DELETE".into())
        );
    }

    fn texts(d: DialectKind, sql: &str) -> Vec<String> {
        plan_run(d, &[sql.to_string()])
            .into_iter()
            .map(|p| p.text)
            .collect()
    }

    /// Round 5, N1: a routine or trigger body is one statement, as the editor splits it.
    #[test]
    fn n1_compound_bodies_stay_whole() {
        let trigger = "CREATE TRIGGER x BEFORE INSERT ON t FOR EACH ROW BEGIN UPDATE a SET x=1; DELETE FROM u WHERE id=1; END";
        assert_eq!(texts(MY, trigger), [trigger]);
        let proc = "CREATE DEFINER=`root`@`%` PROCEDURE p()\nBEGIN\n  IF x THEN SELECT 1; END IF;\n  CASE WHEN a THEN SELECT 2; END CASE;\n  l: LOOP LEAVE l; END LOOP;\n  WHILE y DO SET y = 0; END WHILE;\n  REPEAT SET z = 1; UNTIL z END REPEAT;\n  BEGIN SELECT 3; END;\nEND";
        assert_eq!(
            texts(MY, &format!("{proc};\nSELECT 9;")),
            [proc, "SELECT 9"]
        );
        let event =
            "CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO BEGIN DELETE FROM log WHERE old; END";
        assert_eq!(texts(MY, event), [event]);
        let func = "CREATE FUNCTION f() RETURNS INT DETERMINISTIC BEGIN DECLARE n INT; SET n = 1; RETURN n; END";
        assert_eq!(texts(MY, func), [func]);
        let sqlite = "CREATE TRIGGER t1 AFTER INSERT ON a BEGIN UPDATE b SET n = n + 1; INSERT INTO c VALUES (1); END";
        assert_eq!(
            texts(SL, &format!("{sqlite};\nSELECT 1;")),
            [sqlite, "SELECT 1"]
        );
        let atomic =
            "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END";
        assert_eq!(
            texts(PG, &format!("{atomic};\nSELECT 3")),
            [atomic, "SELECT 3"]
        );
        let dollar =
            "CREATE FUNCTION g() RETURNS void AS $$ BEGIN DELETE FROM t; END $$ LANGUAGE plpgsql";
        assert_eq!(texts(PG, dollar), [dollar]);
        // A transaction's BEGIN is a statement of its own.
        assert_eq!(
            texts(MY, "BEGIN; DELETE FROM t WHERE id = 1; COMMIT"),
            ["BEGIN", "DELETE FROM t WHERE id = 1", "COMMIT"]
        );
        assert_eq!(
            texts(PG, "BEGIN; SELECT 1; END"),
            ["BEGIN", "SELECT 1", "END"]
        );
        // Round 8: a WHERE-less write in the body asks, its first statement included.
        assert!(plan_run(MY, &[trigger.into()])[0].no_where.is_some());
    }

    /// Run all on a script with a trigger plans the trigger as one statement.
    #[test]
    fn n1_run_all_plans_a_trigger_as_one_statement() {
        let script = "SELECT 1;\nCREATE TRIGGER x BEFORE INSERT ON t FOR EACH ROW BEGIN UPDATE a SET x=1; DELETE FROM u; END;\nDELETE FROM v;";
        let plan = plan_run(MY, &[script.into()]);
        assert_eq!(plan.len(), 3, "{plan:?}");
        assert!(plan[1].text.starts_with("CREATE TRIGGER") && plan[1].text.ends_with("END"));
        // Round 8's net reads the body too: its first WHERE-less write asks, the UPDATE that
        // shares its piece with the CREATE.
        assert_eq!(
            plan[1].no_where.as_ref().map(|n| n.verb.as_str()),
            Some("UPDATE")
        );
        assert_eq!(
            plan[2].no_where.as_ref().map(|n| n.verb.as_str()),
            Some("DELETE")
        );
        assert_eq!(statement_count(MY, script), 3);
    }

    /// Round 6, N4: only a real routine's CREATE opens a body; a plain CREATE with columns
    /// called begin, case, end, event, function, trigger or procedure never swallows what follows.
    #[test]
    fn n4_a_plain_create_with_routine_words_never_swallows_the_next_statement() {
        for d in ALL {
            let plan = plan_run(
                d,
                &["CREATE TABLE shifts (begin time, event text); DELETE FROM t".into()],
            );
            assert_eq!(plan.len(), 2, "{d:?} {plan:?}");
            assert_eq!(
                plan[1].no_where.as_ref().map(|n| n.verb.as_str()),
                Some("DELETE"),
                "{d:?}"
            );
            let plan = plan_run(
                d,
                &["CREATE TABLE t (begin int, function int); UPDATE u SET a=1".into()],
            );
            assert_eq!(plan.len(), 2, "{d:?} {plan:?}");
            assert_eq!(
                plan[1].no_where.as_ref().map(|n| n.verb.as_str()),
                Some("UPDATE"),
                "{d:?}"
            );
        }
    }

    /// Property: outside a real routine body the Core never joins `;`-separated statements.
    #[test]
    fn n4_statements_never_merge_outside_a_routine() {
        const NAMES: &[&str] = &[
            "begin",
            "case",
            "end",
            "event",
            "function",
            "trigger",
            "procedure",
            "atomic",
        ];
        for d in ALL {
            for a in NAMES {
                for b in NAMES {
                    let inputs = [
                        format!("CREATE TABLE {a} ({b} int, x int); DELETE FROM t"),
                        format!("CREATE TABLE t ({a} int, {b} text); DELETE FROM t"),
                        format!("CREATE TABLE IF NOT EXISTS t ({a} int, {b} int); DELETE FROM t"),
                        format!("CREATE INDEX {a} ON t ({b}); DELETE FROM t"),
                        format!("CREATE VIEW v AS SELECT {a}, {b} FROM t; DELETE FROM t"),
                        format!("CREATE TABLE t AS SELECT 1 AS {a}, 2 AS {b}; DELETE FROM t"),
                        format!("ALTER TABLE {a} ADD {b} int; DELETE FROM t"),
                        format!("INSERT INTO {a} ({b}) VALUES (1); DELETE FROM t"),
                        format!("SELECT {a}, {b} FROM t; DELETE FROM t"),
                        format!(
                            "CREATE TABLE t (x int CHECK (CASE WHEN x > 0 THEN true END), {a} int); DELETE FROM t"
                        ),
                    ];
                    for sql in inputs {
                        let naive = lex(d, &sql, false).ranges.len();
                        let plan = plan_run(d, std::slice::from_ref(&sql));
                        assert_eq!(plan.len(), naive, "{d:?}: {sql}");
                        assert_eq!(statement_count(d, &sql), naive, "{d:?}: {sql}");
                        assert_eq!(
                            plan.last()
                                .and_then(|p| p.no_where.as_ref())
                                .map(|n| n.verb.as_str()),
                            Some("DELETE"),
                            "{d:?}: {sql}"
                        );
                    }
                }
            }
        }
    }

    /// The real routine forms still open a body, with their modifiers.
    #[test]
    fn n4_real_routines_with_modifiers_still_stay_whole() {
        let body = "BEGIN UPDATE a SET x = 1; DELETE FROM u; END";
        for head in [
            "CREATE OR REPLACE PROCEDURE p()",
            "CREATE DEFINER = `root`@`%` TRIGGER x BEFORE INSERT ON t FOR EACH ROW",
            "CREATE DEFINER=CURRENT_USER EVENT e ON SCHEDULE EVERY 1 DAY DO",
            "CREATE DEFINER = root@localhost FUNCTION f() RETURNS INT",
            "CREATE AGGREGATE FUNCTION f() RETURNS INT",
            "CREATE TRIGGER IF NOT EXISTS x AFTER INSERT ON t FOR EACH ROW",
        ] {
            let sql = format!("{head} {body}; SELECT 1");
            assert_eq!(plan_run(MY, std::slice::from_ref(&sql)).len(), 2, "{sql}");
        }
        for head in [
            "CREATE TEMP TRIGGER x AFTER INSERT ON t",
            "CREATE TEMPORARY TRIGGER IF NOT EXISTS x AFTER INSERT ON t",
        ] {
            let sql = format!("{head} {body}; SELECT 1");
            assert_eq!(plan_run(SL, std::slice::from_ref(&sql)).len(), 2, "{sql}");
        }
        let pg = "CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END; SELECT 3";
        assert_eq!(plan_run(PG, &[pg.into()]).len(), 2);
        // A BEGIN inside parentheses (a default, a column) is not the body's.
        let paren = "CREATE PROCEDURE p(begin int) BEGIN SELECT 1; END; DELETE FROM t";
        let plan = plan_run(MY, &[paren.into()]);
        assert_eq!(plan.len(), 2, "{plan:?}");
        assert_eq!(
            plan[1].no_where.as_ref().map(|n| n.verb.as_str()),
            Some("DELETE")
        );
    }

    /// Round 7 (C1, I1, I2): the shared cases in `src/query/fixtures/splitCases.json`, which
    /// the editor's splitter is tested on too, so both give the same statements.
    #[test]
    fn r7_shared_split_cases() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Case {
            note: String,
            dialect: String,
            sql: String,
            pieces: Vec<String>,
            last_asks: Option<String>,
        }
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../../src/query/fixtures/splitCases.json"))
                .unwrap();
        assert!(cases.len() > 20);
        for c in cases {
            let d = match c.dialect.as_str() {
                "mysql" => MY,
                "postgres" => PG,
                _ => SL,
            };
            let plan = plan_run(d, std::slice::from_ref(&c.sql));
            let got: Vec<&str> = plan.iter().map(|p| p.text.as_str()).collect();
            assert_eq!(got, c.pieces, "{}: {}", c.note, c.sql);
            // `statement_count` reads `;` only, so a MySQL DELIMITER script counts its
            // DELIMITER lines and `;`-parts instead.
            if !(d == MY && c.sql.to_ascii_uppercase().contains("DELIMITER")) {
                assert_eq!(statement_count(d, &c.sql), c.pieces.len(), "{}", c.note);
            }
            let asks = plan
                .last()
                .and_then(|p| p.no_where.as_ref())
                .map(|n| n.verb.clone());
            assert_eq!(asks, c.last_asks, "{}: {}", c.note, c.sql);
            // The whole text's own answer sees the DELETE too.
            if c.last_asks.is_some() {
                assert!(no_where(d, &c.sql).is_some(), "{}: {}", c.note, c.sql);
            }
        }
    }

    /// Round 8: whatever the routine tracker decides, a plain `;` piece that is an UPDATE or
    /// DELETE without WHERE asks, and the ask names that piece.
    fn asks_for(d: DialectKind, sql: &str, piece: &str) -> bool {
        let planned = plan_run(d, &[sql.to_string()]);
        let whole = no_where(d, sql).is_some();
        whole
            && planned
                .iter()
                .any(|p| p.no_where.as_ref().is_some_and(|n| n.text == piece))
    }

    #[test]
    fn r8_every_critical_reproduction_asks() {
        let cases: &[(DialectKind, &str)] = &[
            (
                MY,
                "CREATE TABLE shifts (begin time, event text); DELETE FROM t",
            ),
            (
                PG,
                "CREATE TABLE shifts (begin time, event text); DELETE FROM t",
            ),
            (
                SL,
                "CREATE TABLE shifts (begin time, event text); DELETE FROM t",
            ),
            (
                MY,
                "CREATE PROCEDURE p() BEGIN SELECT ts AS begin FROM t; END; DELETE FROM t",
            ),
            (
                MY,
                "CREATE PROCEDURE p() BEGIN DECLARE begin INT; SET begin = 1; END; DELETE FROM t",
            ),
            (
                MY,
                "CREATE TRIGGER x BEFORE UPDATE ON begin FOR EACH ROW SET NEW.a=1; DELETE FROM t",
            ),
            (
                MY,
                "CREATE FUNCTION begin() RETURNS INT RETURN 1; DELETE FROM t",
            ),
            (
                MY,
                "CREATE PROCEDURE case() BEGIN SELECT 1; END; DELETE FROM t",
            ),
            (
                SL,
                "CREATE TRIGGER x AFTER UPDATE ON s BEGIN UPDATE s SET begin = 1 WHERE id = NEW.id; END; DELETE FROM t",
            ),
            (
                SL,
                "CREATE TRIGGER x AFTER INSERT ON begin BEGIN SELECT 1; END; DELETE FROM t",
            ),
            (
                PG,
                "CREATE FUNCTION f() RETURNS void LANGUAGE sql BEGIN ATOMIC UPDATE s SET begin = 1 WHERE id = 1; END; DELETE FROM t",
            ),
            (
                PG,
                "CREATE TRIGGER x BEFORE UPDATE OF begin ON s FOR EACH ROW EXECUTE FUNCTION f(); DELETE FROM t",
            ),
            (
                PG,
                "CREATE TRIGGER begin BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f(); DELETE FROM t",
            ),
            (
                MY,
                "CREATE PROCEDURE p() BEGIN SELECT 1; END begin; DELETE FROM t; CREATE PROCEDURE q() BEGIN SELECT 1; END; DELETE FROM u",
            ),
            (
                MY,
                "CREATE PROCEDURE p() BEGIN begin: LOOP LEAVE begin; END LOOP begin; END; DELETE FROM t",
            ),
            (
                PG,
                "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1::begin; END; DELETE FROM t",
            ),
            (
                MY,
                "CREATE TRIGGER y BEFORE INSERT ON t FOR EACH ROW FOLLOWS begin BEGIN SET NEW.a = 1; END; DELETE FROM t",
            ),
            (
                PG,
                "CREATE FUNCTION f() RETURNS SETOF begin LANGUAGE sql BEGIN ATOMIC SELECT 1; END; DELETE FROM t",
            ),
        ];
        for (d, sql) in cases {
            assert!(asks_for(*d, sql, "DELETE FROM t"), "{d:?}: {sql}");
        }
    }

    /// Found in the round-8 live check: a body's first statement shares its piece with the
    /// CREATE, and a WHERE-less write there asks as one later in the body does.
    #[test]
    fn r8_a_write_first_in_a_body_asks() {
        let asks: &[(DialectKind, &str)] = &[
            (
                SL,
                "CREATE TEMP TRIGGER y AFTER INSERT ON orders BEGIN DELETE FROM u; END",
            ),
            (MY, "CREATE PROCEDURE p() BEGIN UPDATE t SET a = 1; END"),
            (
                MY,
                "CREATE PROCEDURE p() BEGIN IF x THEN DELETE FROM t; END IF; END",
            ),
            (
                PG,
                "CREATE FUNCTION f() RETURNS void LANGUAGE sql BEGIN ATOMIC DELETE FROM t; END",
            ),
        ];
        for (d, sql) in asks {
            assert!(no_where(*d, sql).is_some(), "{d:?}: {sql}");
        }
        let quiet: &[(DialectKind, &str)] = &[
            (
                SL,
                "CREATE TRIGGER y AFTER DELETE ON orders BEGIN SELECT 1; END",
            ),
            (
                MY,
                "CREATE TRIGGER y BEFORE UPDATE ON t FOR EACH ROW BEGIN SET NEW.a = 1; END",
            ),
            (
                SL,
                "CREATE TRIGGER y AFTER INSERT ON orders BEGIN DELETE FROM u WHERE id = NEW.id; END",
            ),
            (
                PG,
                "CREATE TABLE a (b int REFERENCES c ON DELETE CASCADE ON UPDATE CASCADE)",
            ),
        ];
        for (d, sql) in quiet {
            assert!(no_where(*d, sql).is_none(), "{d:?}: {sql}");
        }
    }

    /// The net reads every plain piece, a routine's body included: asking more is safe.
    #[test]
    fn r8_a_routine_body_without_where_asks_and_names_its_piece() {
        let sql = "CREATE PROCEDURE p() BEGIN SELECT 1; DELETE FROM u; END";
        let n = no_where(MY, sql).unwrap();
        assert_eq!(
            (n.verb.as_str(), n.text.as_str()),
            ("DELETE", "DELETE FROM u")
        );
        let plan = plan_run(MY, &[sql.into()]);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].no_where.as_ref().unwrap().text, "DELETE FROM u");
        // A body whose writes all have a WHERE does not ask.
        assert!(
            no_where(
                MY,
                "CREATE PROCEDURE p() BEGIN SELECT 1; DELETE FROM u WHERE a; END"
            )
            .is_none()
        );
    }

    /// Property: scripts made of routine heads, name words and `;`, in any order. Any piece of
    /// a plain `;` split that is `DELETE FROM t` makes the run ask, naming that piece.
    #[test]
    fn r8_a_plain_delete_piece_always_asks() {
        const BITS: &[&str] = &[
            "CREATE PROCEDURE p() BEGIN",
            "CREATE TRIGGER x AFTER INSERT ON t FOR EACH ROW BEGIN",
            "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC",
            "CREATE TRIGGER y AFTER INSERT ON s BEGIN",
            "begin",
            "end",
            "case",
            "event",
            "trigger",
            "function",
            "procedure",
            "atomic",
            "END",
            "END IF",
            "END CASE",
            "BEGIN",
            "CASE WHEN 1 THEN 2",
            "SELECT 1",
            "SET begin = 1",
            "AS begin",
            "x:",
            "l: LOOP",
            "COMMENT 'doc'",
            "5",
            "::begin",
            "FOLLOWS",
            "SETOF",
            "DECLARE EXIT HANDLER FOR SQLEXCEPTION",
            ";",
            ";",
            ";",
            ";",
            "DELETE FROM t",
            "DELETE FROM t",
        ];
        let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
        let mut next = |n: usize| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % n as u64) as usize
        };
        let mut checked = 0;
        for _ in 0..20000 {
            let len = 3 + next(14);
            let script: Vec<&str> = (0..len).map(|_| BITS[next(BITS.len())]).collect();
            let sql = script.join(" ");
            for d in [MY, PG, SL] {
                let plain: Vec<&str> = lex(d, &sql, false)
                    .ranges
                    .into_iter()
                    .map(|r| sql[r].trim())
                    .collect();
                if !plain.contains(&"DELETE FROM t") {
                    continue;
                }
                checked += 1;
                assert!(asks_for(d, &sql, "DELETE FROM t"), "{d:?}: {sql}");
            }
        }
        assert!(checked > 1000, "{checked}");
    }

    /// Round 7 (I3): code the lexer cannot see into counts as a write, so Production asks
    /// and Read-only refuses.
    #[test]
    fn r7_code_that_runs_code_is_a_write() {
        for (d, sql) in [
            (PG, "DO $$ BEGIN DELETE FROM t; END $$"),
            (PG, "DO LANGUAGE plpgsql $$ BEGIN NULL; END $$"),
            (PG, "CALL p()"),
            (MY, "CALL p()"),
            (PG, "EXECUTE p"),
            (MY, "EXECUTE s"),
            (MY, "EXECUTE s USING @a"),
            (PG, "PREPARE p AS DELETE FROM t"),
            (MY, "PREPARE s FROM 'DELETE FROM t'"),
        ] {
            assert_eq!(classify(d, sql), StatementClass::Write, "{d:?}: {sql}");
        }
    }

    /// N2: a write inside a CTE is checked with its own WHERE, at any depth.
    #[test]
    fn n2_writes_inside_ctes() {
        assert_eq!(
            verb(PG, "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x"),
            Some("DELETE".into())
        );
        assert_eq!(
            verb(
                PG,
                "WITH x AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM x"
            ),
            Some("UPDATE".into())
        );
        assert_eq!(
            verb(
                PG,
                "WITH x AS (DELETE FROM t WHERE id = 1 RETURNING *) SELECT * FROM x"
            ),
            None
        );
        assert_eq!(
            verb(
                PG,
                "WITH a AS (SELECT 1), b AS (WITH c AS (DELETE FROM t RETURNING id) SELECT * FROM c) SELECT * FROM b WHERE true"
            ),
            Some("DELETE".into())
        );
        // The outer WHERE is not the inner write's.
        assert_eq!(
            verb(
                PG,
                "WITH x AS (DELETE FROM t RETURNING id) SELECT * FROM x WHERE id = 1"
            ),
            Some("DELETE".into())
        );
        assert_eq!(
            no_where(PG, "WITH x AS (UPDATE s.t SET a = 1 RETURNING *) SELECT 1")
                .unwrap()
                .table,
            "s.t"
        );
        // SELECT ... FOR UPDATE is a lock, not a write.
        assert_eq!(
            verb(PG, "WITH x AS (SELECT * FROM t FOR UPDATE) SELECT * FROM x"),
            None
        );
    }

    /// N3: EXPLAIN ANALYZE runs the statement it explains.
    #[test]
    fn n3_explain_analyze_runs_the_write() {
        assert_eq!(
            verb(PG, "EXPLAIN ANALYZE DELETE FROM t"),
            Some("DELETE".into())
        );
        assert_eq!(
            verb(PG, "EXPLAIN ANALYSE VERBOSE UPDATE t SET a = 1"),
            Some("UPDATE".into())
        );
        assert_eq!(
            verb(PG, "EXPLAIN (ANALYZE, BUFFERS) DELETE FROM t"),
            Some("DELETE".into())
        );
        assert_eq!(
            verb(
                PG,
                "EXPLAIN (ANALYZE true) WITH x AS (DELETE FROM t RETURNING 1) SELECT * FROM x"
            ),
            Some("DELETE".into())
        );
        assert_eq!(
            verb(MY, "EXPLAIN ANALYZE DELETE FROM t"),
            Some("DELETE".into())
        );
        assert_eq!(verb(PG, "EXPLAIN ANALYZE DELETE FROM t WHERE id = 1"), None);
        // Without ANALYZE nothing runs.
        assert_eq!(verb(PG, "EXPLAIN DELETE FROM t"), None);
        assert_eq!(verb(MY, "EXPLAIN DELETE FROM t"), None);
        for d in [PG, MY] {
            assert_eq!(
                classify(d, "EXPLAIN ANALYZE DELETE FROM t"),
                StatementClass::Write,
                "{d:?}"
            );
            assert_eq!(
                classify(d, "EXPLAIN DELETE FROM t"),
                StatementClass::Read,
                "{d:?}"
            );
            assert_eq!(
                classify(d, "EXPLAIN SELECT 1"),
                StatementClass::Read,
                "{d:?}"
            );
        }
        assert_eq!(
            classify(PG, "EXPLAIN (ANALYZE) DELETE FROM t"),
            StatementClass::Write
        );
    }

    #[test]
    fn plan_run_splits_each_statement_and_keeps_its_place() {
        let plan = plan_run(
            PG,
            &[
                "SELECT 1; DELETE FROM t".into(),
                "-- only a note".into(),
                "SELECT 'é'; UPDATE u SET a = 1 WHERE b".into(),
            ],
        );
        let got: Vec<_> = plan
            .iter()
            .map(|p| (p.piece, p.from, p.to, p.text.as_str()))
            .collect();
        assert_eq!(
            got,
            [
                (0, 0, 8, "SELECT 1"),
                (0, 10, 23, "DELETE FROM t"),
                (2, 0, 10, "SELECT 'é'"),
                (2, 12, 38, "UPDATE u SET a = 1 WHERE b"),
            ]
        );
        assert!(plan[1].no_where.is_some() && plan[3].no_where.is_none());
    }

    const R: StatementClass = StatementClass::Read;
    const W: StatementClass = StatementClass::Write;

    fn mysql(production: bool, read_only: bool) -> ConnectionConfig {
        ConnectionConfig {
            id: uuid::Uuid::nil(),
            name: "shop".into(),
            dialect: MY,
            host: String::new(),
            port: 0,
            user: String::new(),
            database: None,
            ssl: crate::model::SslMode::Disable,
            group_id: None,
            file: None,
            query_timeout_secs: None,
            ai_access: Default::default(),
            ai_sync: Default::default(),
            production,
            read_only,
        }
    }

    /// MySQL DELIMITER: the gate sees the statements the run sends, so no DELIMITER can
    /// hide a write, a CALL, DO, PREPARE or EXECUTE from Production or Read-only.
    #[test]
    fn delimiter_cannot_hide_a_write_from_the_gate() {
        let scripts: &[(&str, &str)] = &[
            ("DELIMITER //\nDROP TABLE x//", "DROP TABLE x"),
            ("DELIMITER //\nDROP TABLE x//\nDELIMITER ;", "DROP TABLE x"),
            (
                "delimiter //\nSELECT 1//\n  DROP TABLE x //",
                "DROP TABLE x",
            ),
            ("DELIMITER $$\nSELECT 1; DROP TABLE x$$", "DROP TABLE x"),
            (
                "DELIMITER $$\nBEGIN NOT ATOMIC SELECT 1; DROP TABLE x; END$$",
                "BEGIN NOT ATOMIC SELECT 1; DROP TABLE x; END",
            ),
            ("DELIMITER ;;\nSELECT 1;;DROP TABLE x;;", "DROP TABLE x"),
            ("DELIMITER //\nSELECT '//'//DROP TABLE x", "DROP TABLE x"),
            ("DELIMITER ;;\nCALL p();;", "CALL p()"),
            (
                "DELIMITER //\nDO RELEASE_LOCK('a')//",
                "DO RELEASE_LOCK('a')",
            ),
            ("DELIMITER //\nPREPARE s FROM @q//", "PREPARE s FROM @q"),
            ("DELIMITER //\nEXECUTE s//", "EXECUTE s"),
        ];
        for (sql, write) in scripts {
            let texts = texts(MY, sql);
            assert!(texts.iter().any(|t| t == write), "{sql:?}: {texts:?}");
            for t in &texts {
                assert!(
                    !t.to_ascii_uppercase().contains("DELIMITER"),
                    "{sql:?}: {t:?}"
                );
            }
            let at = texts.iter().position(|t| t == write).unwrap();
            assert_eq!(
                verdict(&mysql(false, true), None, &texts),
                RunVerdict::ReadOnly { statement: at },
                "{sql:?}"
            );
            let RunVerdict::NeedsConfirmation { statements, .. } =
                verdict(&mysql(true, false), None, &texts)
            else {
                panic!("{sql:?} must ask on Production");
            };
            assert_eq!(statements[at].class, W, "{sql:?}");
        }
    }

    /// Statements inside DELIMITER blocks are classified as the same statements are without
    /// them: the trigger with its BEGIN ... END body is one statement, as it is with `;`.
    #[test]
    fn delimiter_blocks_plan_as_the_same_statements_do() {
        let trigger = "CREATE TRIGGER t BEFORE INSERT ON orders FOR EACH ROW\nBEGIN\n  SET NEW.total = 0;\nEND";
        let delimited =
            format!("DELIMITER $$\n{trigger}$$\nDELIMITER ;\nINSERT INTO orders VALUES (1);");
        let plain = format!("{trigger};\nINSERT INTO orders VALUES (1);");
        assert_eq!(texts(MY, &delimited), texts(MY, &plain));
        assert_eq!(
            texts(MY, &delimited),
            [trigger, "INSERT INTO orders VALUES (1)"]
        );
        let classes = |sql: &str| -> Vec<StatementClass> {
            texts(MY, sql).iter().map(|t| classify(MY, t)).collect()
        };
        assert_eq!(classes(&delimited), classes(&plain));
        assert_eq!(classes(&delimited), [W, W]);
        assert_eq!(classes("DELIMITER //\nSELECT 1//\nSHOW TABLES//"), [R, R]);
        // The missing-WHERE ask reads what is sent.
        let plan = plan_run(
            MY,
            &["DELIMITER //\nUPDATE t SET a = 1//\nDELIMITER ;".into()],
        );
        assert_eq!(plan[0].text, "UPDATE t SET a = 1");
        assert!(plan[0].no_where.is_some());
    }

    /// A custom delimiter's chunk that is one routine or compound statement is sent whole,
    /// as the mysql client sends it, and each of its `;`-parts still counts: one write makes
    /// it a write, and one UPDATE or DELETE without WHERE asks. Any other chunk splits on
    /// `;`, so each part runs as its own statement with its own result.
    #[test]
    fn delimiter_chunk_is_whole_only_for_a_compound_statement() {
        let trigger = "CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW IF NEW.a > 0 THEN SET NEW.b = 1; DELETE FROM log WHERE id < 5; END IF";
        assert_eq!(texts(MY, &format!("DELIMITER $$\n{trigger}$$")), [trigger]);
        let block = "BEGIN NOT ATOMIC DELETE FROM t WHERE a=1; SELECT 1; END";
        assert_eq!(texts(MY, &format!("DELIMITER //\n{block}//")), [block]);
        assert_eq!(classify(MY, block), W);
        assert_eq!(
            texts(MY, "DELIMITER $$\nSELECT 1; DROP TABLE x$$"),
            ["SELECT 1", "DROP TABLE x"]
        );
        for (sql, whole) in [
            ("lbl: BEGIN SELECT 1; END", true),
            ("lbl: WHILE 1 DO SELECT 1; END WHILE", true),
            ("REPEAT SELECT 1; UNTIL 1 END REPEAT", true),
            (
                "CREATE OR REPLACE DEFINER = `a`@`%` EVENT e ON SCHEDULE EVERY 1 DAY DO BEGIN SELECT 1; END",
                true,
            ),
            ("BEGIN; SELECT 1", false),
            ("BEGIN WORK; SELECT 1", false),
            ("CREATE TABLE t (a int); INSERT INTO t VALUES (1)", false),
            ("lbl: SELECT 1; SELECT 2", false),
            ("WITH a AS (SELECT 1) SELECT * FROM a; SELECT 2", false),
        ] {
            let n = texts(MY, &format!("DELIMITER //\n{sql}//")).len();
            assert_eq!(n == 1, whole, "{sql}");
        }

        let hidden = texts(
            MY,
            "DELIMITER $$\nBEGIN NOT ATOMIC SELECT 1; DROP TABLE x; END$$",
        );
        assert_eq!(hidden.len(), 1);
        assert_eq!(
            verdict(&mysql(false, true), None, &hidden),
            RunVerdict::ReadOnly { statement: 0 }
        );
        assert!(matches!(
            verdict(&mysql(true, false), None, &hidden),
            RunVerdict::NeedsConfirmation { writes: 1, .. }
        ));
        let plan = plan_run(
            MY,
            &["DELIMITER $$\nBEGIN NOT ATOMIC SELECT 1; DELETE FROM t; END$$".into()],
        );
        assert_eq!(plan.len(), 1);
        assert_eq!(
            plan[0].no_where.as_ref().map(|n| n.text.as_str()),
            Some("DELETE FROM t")
        );

        // The editor sends a statement it cut at a custom delimiter with that delimiter, so
        // the Core reads it the same way; `;` and other Dialects split as before.
        let run = |d: DialectKind, sql: &str, delimiter: &str| -> Vec<String> {
            plan_run_delimited(d, &[sql.to_string()], &[delimiter.to_string()])
                .into_iter()
                .map(|p| p.text)
                .collect()
        };
        assert_eq!(run(MY, trigger, "$$"), [trigger]);
        assert_eq!(run(MY, trigger, ";").len(), 3);
        assert_eq!(run(MY, "SELECT 1; SELECT 2", "$$").len(), 2);
        assert_eq!(
            run(MY, "SELECT 1$$ SELECT 2", "$$"),
            ["SELECT 1", "SELECT 2"]
        );
        assert_eq!(run(MY, "SELECT 1; SELECT 2", ""), ["SELECT 1", "SELECT 2"]);
        assert_eq!(
            run(PG, "SELECT 1; SELECT 2", "$$"),
            ["SELECT 1", "SELECT 2"]
        );
        // A DELIMITER line inside the statement still applies.
        assert_eq!(
            run(MY, "SELECT 1$$\nDELIMITER ;\nSELECT 2; SELECT 3", "$$"),
            ["SELECT 1", "SELECT 2", "SELECT 3"]
        );
        // Missing delimiters mean `;`.
        assert_eq!(
            plan_run_delimited(MY, &["SELECT 1; SELECT 2".into()], &[]).len(),
            2
        );
    }

    /// Each planned statement points at its own text, in UTF-16 units, past DELIMITER lines.
    #[test]
    fn delimiter_statements_keep_their_place() {
        let sql = "-- é\nDELIMITER //\nSELECT 'ü'//\nDELIMITER ;\nSELECT 2;";
        let plan = plan_run(MY, &[sql.to_string()]);
        let units: Vec<u16> = sql.encode_utf16().collect();
        let got: Vec<String> = plan
            .iter()
            .map(|p| String::from_utf16(&units[p.from..p.to]).unwrap())
            .collect();
        assert_eq!(got, ["SELECT 'ü'", "SELECT 2"]);
        for r in split_statements(MY, sql) {
            assert!(!sql[r].contains("//"));
        }
    }
}
