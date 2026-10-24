//! The tokens of one statement, for the lists and the INSERT shape. The lexer walks bytes
//! (every syntax character is ASCII, and UTF-8 never puts an ASCII byte inside a
//! character), yields tokens one at a time, and never copies the text: a word is a span
//! of it. Quoting and comments follow the splitter's rules; `flip` reads backslashes the
//! other way, as `safety::lex` does. On MySQL the inside of `/*! */` is read as code,
//! because the server runs it.

use crate::model::DialectKind;

use super::split::dollar_tag;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum K {
    Word,
    Num,
    Str,
    Ident,
    Punct(u8),
}

#[derive(Clone, Copy, Debug)]
pub(super) struct Tok {
    pub(super) k: K,
    pub(super) start: usize,
    pub(super) end: usize,
}

impl Tok {
    /// The word `w` (ASCII, any case).
    pub(super) fn is(&self, text: &str, w: &str) -> bool {
        self.k == K::Word && text[self.start..self.end].eq_ignore_ascii_case(w)
    }

    pub(super) fn is_punct(&self, c: u8) -> bool {
        self.k == K::Punct(c)
    }
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'$' | b'@') || b >= 0x80
}

pub(super) struct Lexer<'a> {
    text: &'a str,
    b: &'a [u8],
    i: usize,
    mysql: bool,
    postgres: bool,
    sqlite: bool,
    flip: bool,
    in_exec: bool,
}

pub(super) fn lex(dialect: DialectKind, text: &str, flip: bool) -> Lexer<'_> {
    Lexer {
        text,
        b: text.as_bytes(),
        i: 0,
        mysql: dialect == DialectKind::MySql,
        postgres: dialect == DialectKind::Postgres,
        sqlite: dialect == DialectKind::Sqlite,
        flip,
        in_exec: false,
    }
}

impl Lexer<'_> {
    fn at(&self, i: usize) -> Option<u8> {
        self.b.get(i).copied()
    }

    /// Index just past the closing `q`; a doubled `q` stays inside, and with `escapes`
    /// a backslash skips the next byte. An open literal runs to the end.
    fn skip_quoted(&self, start: usize, q: u8, escapes: bool) -> usize {
        let mut i = start + 1;
        while i < self.b.len() {
            let c = self.b[i];
            if escapes && c == b'\\' {
                i += 2;
            } else if c == q {
                if self.at(i + 1) == Some(q) {
                    i += 2;
                } else {
                    return i + 1;
                }
            } else {
                i += 1;
            }
        }
        self.b.len()
    }

    /// Whether a `'` string escapes with backslashes; `e` when an `E` prefix opens it.
    fn quote_escapes(&self, e: bool) -> bool {
        if self.mysql {
            !self.flip
        } else {
            self.flip || self.postgres && e
        }
    }

    fn digits(&self, mut j: usize, ok: fn(u8) -> bool) -> usize {
        while self.at(j).is_some_and(ok) {
            j += 1;
        }
        j
    }

    /// Where a number starting at `i` ends: `0x..`, `0b..`, or decimal with an optional
    /// fraction and exponent.
    fn number_end(&self, i: usize) -> usize {
        if self.at(i) == Some(b'0') {
            if matches!(self.at(i + 1), Some(b'x' | b'X'))
                && self.at(i + 2).is_some_and(|d| d.is_ascii_hexdigit())
            {
                return self.digits(i + 2, |d| d.is_ascii_hexdigit());
            }
            if matches!(self.at(i + 1), Some(b'b' | b'B'))
                && matches!(self.at(i + 2), Some(b'0' | b'1'))
            {
                return self.digits(i + 2, |d| matches!(d, b'0' | b'1'));
            }
        }
        let mut j = self.digits(i, |d| d.is_ascii_digit());
        if self.at(j) == Some(b'.') {
            j = self.digits(j + 1, |d| d.is_ascii_digit());
        }
        if matches!(self.at(j), Some(b'e' | b'E')) {
            let mut k = j + 1;
            if matches!(self.at(k), Some(b'+' | b'-')) {
                k += 1;
            }
            if self.at(k).is_some_and(|d| d.is_ascii_digit()) {
                j = self.digits(k, |d| d.is_ascii_digit());
            }
        }
        j
    }

    /// Skips whitespace and comments; false at the end.
    fn skip_space(&mut self) -> bool {
        while let Some(c) = self.at(self.i) {
            let n1 = self.at(self.i + 1);
            if c.is_ascii_whitespace() {
                self.i += 1;
            } else if self.in_exec && c == b'*' && n1 == Some(b'/') {
                self.in_exec = false;
                self.i += 2;
            } else if c == b'-'
                && n1 == Some(b'-')
                && (!self.mysql
                    || self
                        .at(self.i + 2)
                        .is_none_or(|x| x.is_ascii_whitespace() || x.is_ascii_control()))
                || self.mysql && c == b'#'
            {
                // PostgreSQL ends a line comment at a lone CR too, as the safety lexer does.
                while self
                    .at(self.i)
                    .is_some_and(|x| x != b'\n' && !(self.postgres && x == b'\r'))
                {
                    self.i += 1;
                }
            } else if c == b'/' && n1 == Some(b'*') {
                let bang = self.at(self.i + 2) == Some(b'!');
                let m_bang = self.at(self.i + 2) == Some(b'M') && self.at(self.i + 3) == Some(b'!');
                if self.mysql && (bang || m_bang) {
                    self.i = self.digits(self.i + if bang { 3 } else { 4 }, |d| d.is_ascii_digit());
                    self.in_exec = true;
                    continue;
                }
                let mut level = 1;
                self.i += 2;
                while self.i < self.b.len() && level > 0 {
                    let x = self.b[self.i];
                    let y = self.at(self.i + 1);
                    if x == b'*' && y == Some(b'/') {
                        level -= 1;
                        self.i += 2;
                    } else if self.postgres && x == b'/' && y == Some(b'*') {
                        level += 1;
                        self.i += 2;
                    } else {
                        self.i += 1;
                    }
                }
            } else {
                return true;
            }
        }
        false
    }
}

impl Iterator for Lexer<'_> {
    type Item = Tok;

    fn next(&mut self) -> Option<Tok> {
        if !self.skip_space() {
            return None;
        }
        let start = self.i;
        let c = self.b[start];
        let n1 = self.at(start + 1);
        let k = match c {
            b'\'' => {
                self.i = self.skip_quoted(start, b'\'', self.quote_escapes(false));
                K::Str
            }
            b'"' => {
                self.i = self.skip_quoted(start, b'"', self.mysql && !self.flip);
                if self.mysql { K::Str } else { K::Ident }
            }
            b'`' if self.mysql || self.sqlite => {
                self.i = self.skip_quoted(start, b'`', false);
                K::Ident
            }
            b'[' if self.sqlite => {
                let close = self.b[start..].iter().position(|x| *x == b']');
                self.i = close.map_or(self.b.len(), |p| start + p + 1);
                K::Ident
            }
            b'$' if self.postgres
                && matches!(dollar_tag(&self.text[start..], true), Some(Some(_))) =>
            {
                let len = dollar_tag(&self.text[start..], true).flatten().unwrap_or(2);
                let tag = &self.b[start..start + len];
                let body = start + len;
                self.i = self.b[body..]
                    .windows(len)
                    .position(|w| w == tag)
                    .map_or(self.b.len(), |p| body + p + len);
                K::Str
            }
            c if c.is_ascii_digit() || c == b'.' && n1.is_some_and(|d| d.is_ascii_digit()) => {
                self.i = self.number_end(start);
                if self.at(self.i).is_some_and(is_ident_byte) {
                    self.i = self.digits(self.i, is_ident_byte);
                    K::Word
                } else {
                    K::Num
                }
            }
            c if is_ident_byte(c) => {
                self.i = self.digits(start, is_ident_byte);
                // `E'..'`, `N'..'`, `B'..'` and `X'..'` are one literal.
                if self.i == start + 1
                    && self.at(self.i) == Some(b'\'')
                    && matches!(c.to_ascii_uppercase(), b'E' | b'N' | b'B' | b'X')
                {
                    let e = c.eq_ignore_ascii_case(&b'E');
                    self.i = self.skip_quoted(self.i, b'\'', self.quote_escapes(e));
                    K::Str
                } else {
                    K::Word
                }
            }
            _ => {
                self.i += 1;
                K::Punct(c)
            }
        };
        Some(Tok {
            k,
            start,
            end: self.i,
        })
    }
}
