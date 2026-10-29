//! The resumable statement splitter (D2).

use crate::error::{Error, Result};
use crate::model::DialectKind;

use super::RawStatement;
use super::lists::Facts;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Top,
    Word,
    Quote {
        q: char,
        escapes: bool,
    },
    Bracket,
    Dollar,
    LineComment,
    Block {
        level: u32,
    },
    /// A line starting with `\`: a client command, kept as a statement of its own.
    MetaLine,
    /// A MySQL `DELIMITER` line.
    DelimiterLine,
    /// The rest of a `COPY ... FROM STDIN` line, then each data line up to `\.`.
    CopyRest,
    CopyData,
}

// `sqlite3_complete`'s token classes and states (whitespace and comments never move it).
const T_SEMI: usize = 0;
const T_OTHER: usize = 2;
const T_EXPLAIN: usize = 3;
const T_CREATE: usize = 4;
const T_TEMP: usize = 5;
const T_TRIGGER: usize = 6;
const T_END: usize = 7;
const S_START: u8 = 1;
const TRIGGER_STATES: [[u8; 8]; 8] = [
    // SEMI WS OTHER EXPLAIN CREATE TEMP TRIGGER END
    [1, 0, 2, 3, 4, 2, 2, 2], // 0 invalid
    [1, 1, 2, 3, 4, 2, 2, 2], // 1 start
    [1, 2, 2, 2, 2, 2, 2, 2], // 2 normal
    [1, 3, 3, 2, 4, 2, 2, 2], // 3 explain
    [1, 4, 2, 2, 2, 4, 5, 2], // 4 create
    [6, 5, 5, 5, 5, 5, 5, 5], // 5 trigger
    [6, 6, 5, 5, 5, 5, 5, 7], // 6 semicolon inside a trigger
    [1, 7, 5, 5, 5, 5, 5, 5], // 7 END right after a semicolon
];

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '$' | '@' | '.')
}

/// A resumable statement splitter: text goes in as it is read, in pieces cut anywhere,
/// and whole statements come out. It holds only the statement it is in.
pub(crate) struct Splitter {
    dialect: DialectKind,
    buf: String,
    pos: usize,
    mode: Mode,
    /// The line at `pos`, from 1.
    line: u32,
    at_line_start: bool,
    /// Where the open statement's first token (or `/*! */`) sits in `buf`.
    start: Option<usize>,
    start_line: u32,
    depth: u32,
    /// The token just before `pos` is the lone word `E` (PostgreSQL `E'..'`).
    e_before: bool,
    word_start: usize,
    tag: String,
    delimiter: String,
    cmd: String,
    cmd_line: u32,
    trigger: u8,
    idents: [u8; 4],
    ident_count: usize,
    begin_depth: u32,
    /// How far a `$` waiting for more text was already checked.
    dollar_seen: usize,
}

impl Splitter {
    pub(crate) fn new(dialect: DialectKind) -> Self {
        Self {
            dialect,
            buf: String::new(),
            pos: 0,
            mode: Mode::Top,
            line: 1,
            at_line_start: true,
            start: None,
            start_line: 1,
            depth: 0,
            e_before: false,
            word_start: 0,
            tag: String::new(),
            delimiter: ";".into(),
            cmd: String::new(),
            cmd_line: 1,
            trigger: S_START,
            idents: [0; 4],
            ident_count: 0,
            begin_depth: 0,
            dollar_seen: 0,
        }
    }

    pub(crate) fn push(&mut self, text: &str, out: &mut Vec<RawStatement>) -> Result<()> {
        self.buf.push_str(text);
        self.scan(out, false)?;
        self.compact();
        Ok(())
    }

    pub(crate) fn finish(&mut self, out: &mut Vec<RawStatement>) -> Result<()> {
        self.scan(out, true)?;
        match self.mode {
            Mode::Word => {
                self.word_end();
                self.mode = Mode::Top;
            }
            Mode::MetaLine => self.end_meta(out),
            Mode::DelimiterLine => self.end_delimiter()?,
            _ => {}
        }
        self.end_statement(out, self.pos);
        self.compact();
        Ok(())
    }

    /// The bytes held for the statement still open.
    pub(crate) fn pending_len(&self) -> usize {
        match self.start {
            Some(s) => self.buf.len() - s,
            None => self.cmd.len(),
        }
    }

    /// The line the open statement starts on.
    pub(crate) fn pending_line(&self) -> u32 {
        if self.start.is_some() {
            self.start_line
        } else {
            self.cmd_line
        }
    }

    fn mysql(&self) -> bool {
        self.dialect == DialectKind::MySql
    }

    fn bump(&mut self, c: char) {
        self.pos += c.len_utf8();
        if c == '\n' {
            self.line += 1;
        }
    }

    /// The `n`th character after `pos` (0 is the one at `pos`).
    fn ahead(&self, n: usize) -> Option<char> {
        self.buf[self.pos..].chars().nth(n)
    }

    /// Drops what no statement needs any more.
    fn compact(&mut self) {
        let cut = self.start.unwrap_or(self.pos);
        if cut == 0 {
            return;
        }
        self.buf.drain(..cut);
        self.pos -= cut;
        self.start = self.start.map(|s| s - cut);
        self.word_start = self.word_start.saturating_sub(cut);
    }

    fn scan(&mut self, out: &mut Vec<RawStatement>, eof: bool) -> Result<()> {
        while let Some(c) = self.ahead(0) {
            let go = match self.mode {
                Mode::Top => self.top(c, out, eof),
                Mode::Word => self.word(c, eof),
                Mode::Quote { q, escapes } => self.quote(c, q, escapes, eof),
                Mode::Bracket => {
                    self.bump(c);
                    if c == ']' {
                        self.mode = Mode::Top;
                    }
                    true
                }
                Mode::Dollar => self.dollar(c, eof),
                Mode::LineComment => {
                    // PostgreSQL ends a line comment at a lone CR too, as the safety lexer does.
                    if c == '\n' || c == '\r' && self.dialect == DialectKind::Postgres {
                        self.mode = Mode::Top;
                    } else {
                        self.bump(c);
                    }
                    true
                }
                Mode::Block { level } => self.block(c, level, eof),
                Mode::MetaLine => {
                    if c == '\n' {
                        self.end_meta(out);
                    } else {
                        self.cmd.push(c);
                        self.bump(c);
                    }
                    true
                }
                Mode::DelimiterLine => {
                    if c == '\n' {
                        self.end_delimiter()?;
                    } else {
                        self.cmd.push(c);
                        self.bump(c);
                    }
                    true
                }
                Mode::CopyRest => {
                    self.bump(c);
                    if c == '\n' {
                        self.mode = Mode::CopyData;
                    }
                    true
                }
                Mode::CopyData => self.copy_data(eof),
            };
            if !go {
                break;
            }
        }
        Ok(())
    }

    /// False when it must see more text to decide.
    fn top(&mut self, c: char, out: &mut Vec<RawStatement>, eof: bool) -> bool {
        if c.is_whitespace() {
            self.bump(c);
            if c == '\n' {
                self.at_line_start = true;
            }
            self.e_before = false;
            return true;
        }
        if self.at_line_start {
            // A `\` line is a client command only where a statement starts.
            if c == '\\' && self.start.is_none() {
                self.end_statement(out, self.pos);
                self.start_command(Mode::MetaLine);
                return true;
            }
            if self.mysql() {
                match delimiter_command(&self.buf[self.pos..], eof) {
                    None => return false,
                    Some(true) => {
                        self.end_statement(out, self.pos);
                        self.start_command(Mode::DelimiterLine);
                        return true;
                    }
                    Some(false) => {}
                }
            }
            self.at_line_start = false;
        }

        let rest = &self.buf[self.pos..];
        if self.mysql() {
            if rest.starts_with(self.delimiter.as_str()) {
                let n = self.delimiter.len();
                self.end_statement(out, self.pos);
                self.pos += n;
                self.e_before = false;
                return true;
            }
            if !eof && self.delimiter.starts_with(rest) {
                return false;
            }
        } else if c == ';' {
            self.semicolon(out);
            return true;
        }

        let n1 = self.ahead(1);
        if (c == '-' || c == '/') && n1.is_none() && !eof {
            return false;
        }
        if c == '-' && n1 == Some('-') {
            if self.mysql() {
                let n2 = self.ahead(2);
                if n2.is_none() && !eof {
                    return false;
                }
                if crate::safety::mysql_comment_after(n2) {
                    self.line_comment();
                    return true;
                }
            } else {
                self.line_comment();
                return true;
            }
        }
        if c == '#' && self.mysql() {
            self.line_comment();
            return true;
        }
        if c == '/' && n1 == Some('*') {
            let mut executed = false;
            if self.mysql() {
                let n2 = self.ahead(2);
                let unsure = n2.is_none() || (n2 == Some('M') && self.ahead(3).is_none());
                if unsure && !eof {
                    return false;
                }
                executed = n2 == Some('!') || (n2 == Some('M') && self.ahead(3) == Some('!'));
            }
            // The server runs `/*! */`, so it opens a statement like a token does.
            if executed {
                self.begin();
            }
            self.pos += 2;
            self.mode = Mode::Block { level: 1 };
            self.e_before = false;
            return true;
        }

        let postgres = self.dialect == DialectKind::Postgres;
        let sqlite = self.dialect == DialectKind::Sqlite;
        if c == '$' && postgres {
            // A `$` opens a token either way; opening the statement first keeps a long
            // undecided run under the statement limit.
            self.begin();
            let (found, seen) =
                dollar_tag_from(&self.buf[self.pos..], eof, self.dollar_seen.max(1));
            // Resume where this look stopped, so a long run is checked once.
            self.dollar_seen = if found.is_none() { seen } else { 0 };
            match found {
                None => return false,
                Some(Some(len)) => {
                    self.tag = self.buf[self.pos..self.pos + len].to_string();
                    self.pos += len;
                    self.mode = Mode::Dollar;
                    self.other_token();
                    return true;
                }
                Some(None) => {}
            }
        }
        self.begin();
        match c {
            '\'' => {
                let escapes = self.mysql() || (postgres && self.e_before);
                self.bump(c);
                self.mode = Mode::Quote { q: c, escapes };
                self.other_token();
            }
            '"' => {
                self.bump(c);
                self.mode = Mode::Quote {
                    q: c,
                    escapes: self.mysql(),
                };
                self.other_token();
            }
            '`' if self.mysql() || sqlite => {
                self.bump(c);
                self.mode = Mode::Quote {
                    q: c,
                    escapes: false,
                };
                self.other_token();
            }
            '[' if sqlite => {
                self.bump(c);
                self.mode = Mode::Bracket;
                self.other_token();
            }
            c if is_word_char(c) => {
                self.word_start = self.pos;
                self.bump(c);
                self.mode = Mode::Word;
            }
            _ => {
                if c == '(' {
                    self.depth += 1;
                } else if c == ')' {
                    self.depth = self.depth.saturating_sub(1);
                }
                self.bump(c);
                self.other_token();
            }
        }
        true
    }

    fn line_comment(&mut self) {
        self.mode = Mode::LineComment;
        self.e_before = false;
    }

    fn start_command(&mut self, mode: Mode) {
        self.at_line_start = false;
        self.cmd.clear();
        self.cmd_line = self.line;
        self.mode = mode;
    }

    /// A `;` on PostgreSQL and SQLite: the end, unless a trigger or atomic body is open.
    fn semicolon(&mut self, out: &mut Vec<RawStatement>) {
        let inside = match self.dialect {
            DialectKind::Sqlite => {
                let next = TRIGGER_STATES[self.trigger as usize][T_SEMI];
                if next != S_START {
                    self.trigger = next;
                }
                next != S_START
            }
            DialectKind::Postgres => self.begin_depth > 0,
            _ => false,
        };
        if inside {
            self.begin();
            self.bump(';');
            self.e_before = false;
        } else {
            self.end_statement(out, self.pos);
            self.bump(';');
            self.e_before = false;
        }
    }

    fn begin(&mut self) {
        if self.start.is_none() {
            self.start = Some(self.pos);
            self.start_line = self.line;
        }
    }

    fn other_token(&mut self) {
        self.e_before = false;
        if self.dialect == DialectKind::Sqlite {
            self.trigger = TRIGGER_STATES[self.trigger as usize][T_OTHER];
        }
    }

    fn word(&mut self, c: char, eof: bool) -> bool {
        if self.mysql() {
            let rest = &self.buf[self.pos..];
            if rest.starts_with(self.delimiter.as_str()) {
                self.word_end();
                self.mode = Mode::Top;
                return true;
            }
            if !eof && self.delimiter.starts_with(rest) {
                return false;
            }
        }
        if is_word_char(c) {
            self.bump(c);
        } else {
            self.word_end();
            self.mode = Mode::Top;
        }
        true
    }

    fn word_end(&mut self) {
        let word = &self.buf[self.word_start..self.pos];
        let identifier = word.starts_with(|c: char| c.is_alphabetic() || c == '_');
        let upper = if word.len() <= 16 {
            word.to_ascii_uppercase()
        } else {
            String::new()
        };
        self.e_before = upper == "E";
        match self.dialect {
            DialectKind::Sqlite => {
                let class = match upper.as_str() {
                    "CREATE" => T_CREATE,
                    "TEMP" | "TEMPORARY" => T_TEMP,
                    "TRIGGER" => T_TRIGGER,
                    "EXPLAIN" => T_EXPLAIN,
                    "END" => T_END,
                    _ => T_OTHER,
                };
                self.trigger = TRIGGER_STATES[self.trigger as usize][class];
            }
            DialectKind::Postgres if identifier => self.psql_identifier(&upper),
            _ => {}
        }
    }

    /// psql's rule: in `CREATE [OR REPLACE] FUNCTION|PROCEDURE`, `BEGIN` (and `CASE`
    /// inside it) opens a body that `END` closes, and `;` inside it does not end the
    /// statement.
    fn psql_identifier(&mut self, upper: &str) {
        if matches!(
            upper,
            "CREATE" | "FUNCTION" | "PROCEDURE" | "OR" | "REPLACE"
        ) && self.ident_count < 4
        {
            self.idents[self.ident_count] = upper.as_bytes()[0];
        }
        self.ident_count = self.ident_count.saturating_add(1);
        let i = self.idents;
        let routine = i[0] == b'C'
            && (i[1] == b'F'
                || i[1] == b'P'
                || (i[1] == b'O' && i[2] == b'R' && (i[3] == b'F' || i[3] == b'P')));
        if routine && self.depth == 0 {
            match upper {
                "BEGIN" => self.begin_depth += 1,
                "CASE" if self.begin_depth >= 1 => self.begin_depth += 1,
                "END" => self.begin_depth = self.begin_depth.saturating_sub(1),
                _ => {}
            }
        }
    }

    fn quote(&mut self, c: char, q: char, escapes: bool, eof: bool) -> bool {
        if c == q {
            let n1 = self.ahead(1);
            if n1.is_none() && !eof {
                return false;
            }
            self.bump(c);
            if n1 == Some(q) {
                self.bump(q);
            } else {
                self.mode = Mode::Top;
            }
        } else if escapes && c == '\\' {
            let n1 = self.ahead(1);
            if n1.is_none() && !eof {
                return false;
            }
            self.bump(c);
            if let Some(n) = n1 {
                self.bump(n);
            }
        } else {
            self.bump(c);
        }
        true
    }

    fn block(&mut self, c: char, level: u32, eof: bool) -> bool {
        let opens = c == '/' && self.dialect == DialectKind::Postgres;
        if c == '*' || opens {
            let n1 = self.ahead(1);
            if n1.is_none() && !eof {
                return false;
            }
            if c == '*' && n1 == Some('/') {
                self.pos += 2;
                self.mode = if level == 1 {
                    Mode::Top
                } else {
                    Mode::Block { level: level - 1 }
                };
                return true;
            }
            if opens && n1 == Some('*') {
                self.pos += 2;
                self.mode = Mode::Block { level: level + 1 };
                return true;
            }
        }
        self.bump(c);
        true
    }

    fn dollar(&mut self, c: char, eof: bool) -> bool {
        let rest = &self.buf[self.pos..];
        if rest.starts_with(self.tag.as_str()) {
            self.pos += self.tag.len();
            self.mode = Mode::Top;
            return true;
        }
        if !eof && self.tag.starts_with(rest) {
            return false;
        }
        self.bump(c);
        true
    }

    /// At the start of a data line: `\.` ends the data, any other line is skipped.
    fn copy_data(&mut self, eof: bool) -> bool {
        const END: &str = "\\.\n";
        const END_CRLF: &str = "\\.\r\n";
        let rest = &self.buf[self.pos..];
        let last_line = eof && matches!(rest, "\\." | "\\.\r");
        if rest.starts_with(END) || rest.starts_with(END_CRLF) || last_line {
            self.pos += 2;
            self.mode = Mode::Top;
            return true;
        }
        if !eof && (END.starts_with(rest) || END_CRLF.starts_with(rest)) {
            return false;
        }
        self.mode = Mode::CopyRest;
        true
    }

    fn end_meta(&mut self, out: &mut Vec<RawStatement>) {
        let text = self.cmd.trim_end().to_string();
        out.push(RawStatement {
            facts: Facts::of(self.dialect, &text),
            text,
            line: self.cmd_line,
        });
        self.cmd.clear();
        self.mode = Mode::Top;
    }

    /// `DELIMITER x`, read as the mysql client reads it: the first word, or a quoted
    /// string; the rest of the line is ignored.
    fn end_delimiter(&mut self) -> Result<()> {
        let arg_src = self.cmd["delimiter".len()..].trim();
        let arg = match arg_src.chars().next() {
            Some(q @ ('\'' | '"' | '`')) => {
                let inner = &arg_src[1..];
                inner.find(q).map_or(inner, |i| &inner[..i])
            }
            _ => arg_src.split_whitespace().next().unwrap_or(""),
        };
        if arg.is_empty() {
            return Err(Error::File(format!(
                "Line {}: DELIMITER needs a delimiter after it.",
                self.cmd_line
            )));
        }
        if arg.contains('\\') {
            return Err(Error::File(format!(
                "Line {}: a DELIMITER cannot hold a backslash.",
                self.cmd_line
            )));
        }
        self.delimiter = arg.to_string();
        self.cmd.clear();
        self.mode = Mode::Top;
        Ok(())
    }

    /// Ends the open statement at `end` (where its delimiter starts), if it has content.
    fn end_statement(&mut self, out: &mut Vec<RawStatement>, end: usize) {
        if let Some(s) = self.start.take() {
            let text = self.buf[s..end].trim_end().to_string();
            // One look at the statement serves the splitter and every check after it.
            let facts = Facts::of(self.dialect, &text);
            if self.dialect == DialectKind::Postgres && facts.copy_from_stdin {
                self.mode = Mode::CopyRest;
            }
            out.push(RawStatement {
                text,
                line: self.start_line,
                facts,
            });
        }
        self.depth = 0;
        self.trigger = S_START;
        self.idents = [0; 4];
        self.ident_count = 0;
        self.begin_depth = 0;
    }
}

/// Whether `rest` (at the start of a line) is a `DELIMITER` command; None when more text
/// is needed to tell.
fn delimiter_command(rest: &str, eof: bool) -> Option<bool> {
    const WORD: &[u8] = b"delimiter";
    let b = rest.as_bytes();
    for (i, w) in WORD.iter().enumerate() {
        match b.get(i) {
            None => return if eof { Some(false) } else { None },
            Some(x) if !x.eq_ignore_ascii_case(w) => return Some(false),
            Some(_) => {}
        }
    }
    match b.get(WORD.len()) {
        None => {
            if eof {
                Some(true)
            } else {
                None
            }
        }
        Some(x) => Some(matches!(x, b' ' | b'\t' | b'\r' | b'\n')),
    }
}

/// The byte length of a dollar-quote opener (`$$` or `$tag$`) at the start of `rest`;
/// Some(None) when there is none, None when more text is needed to tell.
pub(super) fn dollar_tag(rest: &str, eof: bool) -> Option<Option<usize>> {
    dollar_tag_from(rest, eof, 1).0
}

/// `dollar_tag`, resuming at byte `from` (at least 1) when the characters before it are
/// already known to be tag characters; also gives how far it checked, to resume there.
fn dollar_tag_from(rest: &str, eof: bool, from: usize) -> (Option<Option<usize>>, usize) {
    let mut first = from == 1;
    for (i, c) in rest[from..].char_indices() {
        let i = from + i;
        let ok = match c {
            '$' => return (Some(Some(i + 1)), i),
            c if first => c.is_alphabetic() || c == '_',
            c => c.is_alphanumeric() || c == '_',
        };
        if !ok {
            return (Some(None), i);
        }
        first = false;
    }
    (if eof { Some(None) } else { None }, rest.len())
}
