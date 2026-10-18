//! Types and defaults are SQL text the user typed. The planner puts them into
//! DDL as they are, so each must be one expression and nothing more.

/// True when `text` is one SQL expression: not empty, no `;`, `--`, `/*`, `#` or
/// dollar quote outside quotes, no `,` outside quotes, parentheses and
/// brackets, quotes, parentheses and brackets balanced, and no control
/// character other than tab, line feed and carriage return.
///
/// Where a string ends depends on how the server reads a backslash in it, so
/// the text must pass under every reading a Dialect can use: never an escape
/// (PostgreSQL, MySQL `NO_BACKSLASH_ESCAPES`), always one (MySQL), and only in
/// `E'..'` strings (PostgreSQL).
pub(crate) fn check_fragment(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    !text.trim().is_empty()
        && !chars
            .iter()
            .any(|&c| c.is_ascii_control() && !matches!(c, '\t' | '\n' | '\r'))
        && [Backslash::Never, Backslash::Always, Backslash::EStrings]
            .into_iter()
            .all(|reading| one_expression(&chars, reading))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Backslash {
    Never,
    Always,
    EStrings,
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn one_expression(c: &[char], reading: Backslash) -> bool {
    // Open `(` and `[` (PostgreSQL `ARRAY[..]`), innermost last.
    let mut open: Vec<char> = Vec::new();
    let mut i = 0;
    while i < c.len() {
        let next = c.get(i + 1).copied();
        match c[i] {
            ';' | '#' => return false,
            ',' if open.is_empty() => return false,
            '-' if next == Some('-') => return false,
            '/' if next == Some('*') => return false,
            '$' if starts_dollar_quote(c, i) => return false,
            b @ ('(' | '[') => open.push(b),
            ')' if open.pop() != Some('(') => return false,
            ']' if open.pop() != Some('[') => return false,
            q @ ('\'' | '"' | '`') => {
                let e_prefix = q == '\''
                    && i > 0
                    && matches!(c[i - 1], 'e' | 'E')
                    && (i < 2 || !is_word(c[i - 2]));
                let escapes = q != '`'
                    && match reading {
                        Backslash::Never => false,
                        Backslash::Always => true,
                        Backslash::EStrings => e_prefix,
                    };
                match quoted_end(c, i, escapes) {
                    Some(end) => {
                        i = end;
                        continue;
                    }
                    None => return false,
                }
            }
            _ => {}
        }
        i += 1;
    }
    open.is_empty()
}

/// The index after the quote that closes the one at `start`; `None` when it never closes.
fn quoted_end(c: &[char], start: usize, escapes: bool) -> Option<usize> {
    let q = c[start];
    let mut j = start + 1;
    while j < c.len() {
        if escapes && c[j] == '\\' {
            j += 2;
        } else if c[j] == q {
            if c.get(j + 1) == Some(&q) {
                j += 2;
            } else {
                return Some(j + 1);
            }
        } else {
            j += 1;
        }
    }
    None
}

/// `$$` or `$tag$` at the start of a word: a PostgreSQL dollar quote.
fn starts_dollar_quote(c: &[char], i: usize) -> bool {
    if i > 0 && is_word(c[i - 1]) {
        return false;
    }
    let mut j = i + 1;
    if c.get(j).is_some_and(|&x| x.is_alphabetic() || x == '_') {
        while c.get(j).is_some_and(|&x| is_word(x)) {
            j += 1;
        }
    }
    c.get(j) == Some(&'$')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_more_than_one_expression() {
        for text in [
            "int; drop table x",
            "int -- x",
            "varchar(10",
            "'abc",
            "",
            "  ",
            "int /* x */",
            "1 # x",
            "(1))(",
            "\"a",
            "`a",
            "int\0",
            "'a\u{1}'",
            "int\u{7}",
            "1\u{1b}",
            "int, x int",
            "0, DROP COLUMN email",
            "0,1",
            "varchar(10), DROP COLUMN x",
            "ARRAY[1], DROP COLUMN x",
            "ARRAY[1, 2",
            "(1]",
            "[1)",
        ] {
            assert!(!check_fragment(text), "{text:?} was accepted");
        }
    }

    #[test]
    fn accepts_one_expression() {
        for text in [
            "numeric(10,2)",
            "'a;b'",
            "now()",
            "'it''s'",
            "'a -- b /* c */ # d'",
            "'a\\\\b'",
            "E'\\n'",
            "\"my type\"",
            "nextval('orders_id_seq'::regclass)",
            "a$b",
            "numeric(10,\n\t2)",
            "numeric(10,\r\n2)",
            "enum('a','b')",
            "'a,b'",
            "coalesce(a, 0)",
            "ARRAY[1, 2]",
            "ARRAY['a,b', 'c']",
            "'{}'::integer[]",
        ] {
            assert!(check_fragment(text), "{text:?} was refused");
        }
    }

    /// MySQL reads `\'` as a quote inside the string, PostgreSQL does not: text
    /// that ends a string early under either reading is refused.
    #[test]
    fn refuses_text_a_backslash_reading_turns_into_two_statements() {
        assert!(!check_fragment("'\\' ';DROP TABLE y;#'"));
        assert!(!check_fragment("E'\\' ';DROP TABLE y;'"));
    }

    #[test]
    fn refuses_dollar_quotes() {
        assert!(!check_fragment("$$ ' $$ ; DROP x; $$ ' $$"));
        assert!(!check_fragment("$t$x$t$"));
    }
}
