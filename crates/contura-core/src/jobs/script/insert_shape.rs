//! The shape of a literal-rows INSERT, for the Production confirmation. The rows are
//! parsed as the tokens stream past, so a large statement is never held twice.

use crate::jobs::types::InsertShape;
use crate::model::DialectKind;

use super::tokens::{K, Lexer, Tok, lex};

/// A first row longer than this is cut, with "..." after it.
const ROW_PREVIEW_BYTES: usize = 1_000;

/// The shape of an INSERT whose rows are all literals (NULL, numbers, text, booleans,
/// casts of literals, and the pure constructors Contura's own SQL export writes:
/// PostgreSQL `decode(..)`, MySQL `ST_GeomFromText(..)`) into a named table. None for
/// anything else, which the confirmation then shows exactly; also None when the other
/// backslash reading finds more than one statement in it (Q37).
pub fn insert_shape(dialect: DialectKind, text: &str) -> Option<InsertShape> {
    if text.contains('\\') && pieces(dialect, text, true) != 1 {
        return None;
    }
    let mysql = dialect == DialectKind::MySql;
    let mut p = Parser {
        lx: lex(dialect, text, false),
        la: [None; 2],
        text,
        dialect,
        last_end: 0,
    };
    let head_start = p.peek(0)?.start;
    if !(p.eat_word("INSERT") || p.eat_word("REPLACE")) {
        return None;
    }
    if mysql {
        while p.eat_any(&["LOW_PRIORITY", "DELAYED", "HIGH_PRIORITY", "IGNORE"]) {}
    }
    if dialect == DialectKind::Sqlite
        && p.eat_word("OR")
        && !p.eat_any(&["ROLLBACK", "ABORT", "REPLACE", "FAIL", "IGNORE"])
    {
        return None;
    }
    if !p.eat_word("INTO") && !mysql {
        return None;
    }
    p.name()?;
    for _ in 0..2 {
        if !p.eat_punct(b'.') {
            break;
        }
        p.name()?;
    }
    if p.eat_punct(b'(') {
        loop {
            p.name()?;
            if p.eat_punct(b')') {
                break;
            }
            p.eat_punct(b',').then_some(())?;
        }
    }
    if dialect == DialectKind::Postgres && p.eat_word("OVERRIDING") {
        p.eat_any(&["SYSTEM", "USER"]).then_some(())?;
        p.eat_word("VALUE").then_some(())?;
    }
    if !(p.eat_word("VALUES") || mysql && p.eat_word("VALUE")) {
        return None;
    }
    let head = text[head_start..p.last_end].to_string();
    let mut first_rows = Vec::new();
    let mut rows = 0u64;
    loop {
        let row_start = p.peek(0)?.start;
        p.eat_punct(b'(').then_some(())?;
        p.list()?;
        rows += 1;
        if first_rows.len() < 4 {
            first_rows.push(preview(&text[row_start..p.last_end]));
        }
        if !p.eat_punct(b',') {
            break;
        }
    }
    while p.eat_punct(b';') {}
    if p.peek(0).is_some() {
        return None;
    }
    Some(InsertShape {
        head,
        first_rows,
        rows_per_statement: rows,
        statements: 1,
        rows,
    })
}

/// The non-empty `;`-separated pieces in one reading.
fn pieces(dialect: DialectKind, text: &str, flip: bool) -> usize {
    let mut count = 0;
    let mut open = false;
    for t in lex(dialect, text, flip) {
        if t.is_punct(b';') {
            open = false;
        } else if !open {
            open = true;
            count += 1;
        }
    }
    count
}

fn preview(row: &str) -> String {
    if row.len() <= ROW_PREVIEW_BYTES {
        return row.to_string();
    }
    let mut cut = ROW_PREVIEW_BYTES;
    while !row.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}...", &row[..cut])
}

struct Parser<'a> {
    lx: Lexer<'a>,
    la: [Option<Tok>; 2],
    text: &'a str,
    dialect: DialectKind,
    /// Where the last token taken ends.
    last_end: usize,
}

impl<'a> Parser<'a> {
    fn peek(&mut self, n: usize) -> Option<Tok> {
        for i in 0..=n {
            if self.la[i].is_none() {
                self.la[i] = self.lx.next();
            }
        }
        self.la[n]
    }

    fn take(&mut self) {
        if let Some(t) = self.peek(0) {
            self.last_end = t.end;
        }
        self.la = [self.la[1], None];
    }

    fn kind(&mut self, n: usize) -> Option<K> {
        self.peek(n).map(|t| t.k)
    }

    fn word_is(&mut self, n: usize, w: &str) -> bool {
        let text = self.text;
        self.peek(n).is_some_and(|t| t.is(text, w))
    }

    fn eat_word(&mut self, w: &str) -> bool {
        let hit = self.word_is(0, w);
        if hit {
            self.take();
        }
        hit
    }

    fn eat_any(&mut self, ws: &[&str]) -> bool {
        ws.iter().any(|w| self.eat_word(w))
    }

    fn eat_punct(&mut self, c: u8) -> bool {
        let hit = self.kind(0) == Some(K::Punct(c));
        if hit {
            self.take();
        }
        hit
    }

    fn name(&mut self) -> Option<()> {
        const NOT_NAMES: [&str; 7] = [
            "VALUES",
            "VALUE",
            "SELECT",
            "SET",
            "DEFAULT",
            "OVERRIDING",
            "TABLE",
        ];
        match self.kind(0)? {
            K::Ident => {}
            K::Word if !NOT_NAMES.iter().any(|w| self.word_is(0, w)) => {}
            _ => return None,
        }
        self.take();
        Some(())
    }

    /// Literals separated by commas, up to and including `)`.
    fn list(&mut self) -> Option<()> {
        loop {
            self.literal()?;
            if self.eat_punct(b')') {
                return Some(());
            }
            self.eat_punct(b',').then_some(())?;
        }
    }

    fn literal(&mut self) -> Option<()> {
        while self.eat_punct(b'-') || self.eat_punct(b'+') {}
        self.primary()?;
        while self.dialect == DialectKind::Postgres
            && self.kind(0) == Some(K::Punct(b':'))
            && self.kind(1) == Some(K::Punct(b':'))
        {
            self.take();
            self.take();
            self.type_name()?;
        }
        Some(())
    }

    fn primary(&mut self) -> Option<()> {
        let mysql = self.dialect == DialectKind::MySql;
        let postgres = self.dialect == DialectKind::Postgres;
        let next_str = self.kind(1) == Some(K::Str);
        let next_open = self.kind(1) == Some(K::Punct(b'('));
        match self.kind(0)? {
            K::Num | K::Str => self.take(),
            K::Word => {
                let t = self.peek(0)?;
                let text = self.text;
                let w: &'a str = &text[t.start..t.end];
                let is = |s: &str| w.eq_ignore_ascii_case(s);
                if is("NULL") || is("TRUE") || is("FALSE") {
                    self.take();
                } else if next_str
                    && ["DATE", "TIME", "TIMESTAMP", "TIMESTAMPTZ", "INTERVAL"]
                        .iter()
                        .any(|s| is(s))
                {
                    self.take();
                    self.take();
                } else if mysql
                    && w.starts_with('_')
                    && matches!(self.kind(1), Some(K::Str | K::Num))
                {
                    // A MySQL character set introducer: `_utf8mb4 X'..'`.
                    self.take();
                    self.take();
                } else if is("CAST") && next_open {
                    self.take();
                    self.take();
                    self.literal()?;
                    self.eat_word("AS").then_some(())?;
                    self.type_name()?;
                    self.eat_punct(b')').then_some(())?;
                } else if (postgres && is("DECODE") || mysql && is("ST_GEOMFROMTEXT")) && next_open
                {
                    self.take();
                    self.take();
                    self.list()?;
                } else {
                    return None;
                }
            }
            K::Punct(b'(') => {
                self.take();
                self.literal()?;
                self.eat_punct(b')').then_some(())?;
            }
            _ => return None,
        }
        Some(())
    }

    /// A type name: words (`timestamp with time zone`), dotted, then `(n, m)` and `[]`s.
    fn type_name(&mut self) -> Option<()> {
        let mut words = 0;
        loop {
            match self.kind(0) {
                Some(K::Word | K::Ident) => words += 1,
                Some(K::Punct(b'.')) if words > 0 => {}
                _ => break,
            }
            self.take();
        }
        if words == 0 {
            return None;
        }
        if self.eat_punct(b'(') {
            loop {
                (self.kind(0) == Some(K::Num)).then_some(())?;
                self.take();
                if self.eat_punct(b')') {
                    break;
                }
                self.eat_punct(b',').then_some(())?;
            }
        }
        while self.eat_punct(b'[') {
            if self.kind(0) == Some(K::Num) {
                self.take();
            }
            self.eat_punct(b']').then_some(())?;
        }
        Some(())
    }
}
