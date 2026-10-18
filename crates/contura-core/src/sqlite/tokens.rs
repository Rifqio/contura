//! A tokenizer for saved SQLite text (`sqlite_master.sql`), so that words inside
//! strings, quoted names and comments are never read as keywords.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TokKind {
    /// A bare word: a keyword or an unquoted name.
    Word,
    /// A quoted name (`"x"`, `` `x` ``, `[x]`); its text is unquoted.
    Ident,
    Str,
    Punct(char),
}

#[derive(Debug)]
pub(crate) struct Tok {
    pub(crate) kind: TokKind,
    pub(crate) text: String,
    pub(crate) start: usize,
    pub(crate) end: usize,
}

impl Tok {
    pub(crate) fn is_word(&self, w: &str) -> bool {
        self.kind == TokKind::Word && self.text.eq_ignore_ascii_case(w)
    }

    pub(crate) fn is_name(&self, name: &str) -> bool {
        matches!(self.kind, TokKind::Word | TokKind::Ident) && self.text.eq_ignore_ascii_case(name)
    }
}

/// Splits saved SQLite text into tokens, skipping spaces and comments, so that words
/// inside strings, quoted names and comments are never read as keywords.
pub(crate) fn tokens(sql: &str) -> Vec<Tok> {
    let b = sql.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    // Index of the closing delimiter at or after `from`, honouring doubled delimiters.
    let close = |from: usize, delim: u8, doubled: bool| -> usize {
        let mut j = from;
        while j < b.len() {
            if b[j] == delim {
                if doubled && j + 1 < b.len() && b[j + 1] == delim {
                    j += 2;
                    continue;
                }
                return j;
            }
            j += 1;
        }
        b.len()
    };
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_whitespace() {
            i += 1;
        } else if c == b'-' && b.get(i + 1) == Some(&b'-') {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
        } else if c == b'/' && b.get(i + 1) == Some(&b'*') {
            i = sql[i + 2..].find("*/").map_or(b.len(), |p| i + 2 + p + 2);
        } else if matches!(c, b'\'' | b'"' | b'`' | b'[') {
            let (delim, doubled) = match c {
                b'[' => (b']', false),
                d => (d, true),
            };
            let end = close(i + 1, delim, doubled);
            let inner = &sql[i + 1..end.min(b.len())];
            let kind = if c == b'\'' {
                TokKind::Str
            } else {
                TokKind::Ident
            };
            let text = if doubled {
                let d = (delim as char).to_string();
                inner.replace(&d.repeat(2), &d)
            } else {
                inner.to_string()
            };
            let stop = (end + 1).min(b.len());
            out.push(Tok {
                kind,
                text,
                start: i,
                end: stop,
            });
            i = stop;
        } else if c.is_ascii_alphanumeric() || c == b'_' || c >= 0x80 || c == b'$' {
            let start = i;
            while i < b.len()
                && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] >= 0x80 || b[i] == b'$')
            {
                i += 1;
            }
            out.push(Tok {
                kind: TokKind::Word,
                text: sql[start..i].to_string(),
                start,
                end: i,
            });
        } else {
            out.push(Tok {
                kind: TokKind::Punct(c as char),
                text: (c as char).to_string(),
                start: i,
                end: i + 1,
            });
            i += 1;
        }
    }
    out
}

/// The index of the `)` matching the `(` at `open`.
pub(crate) fn matching_paren(toks: &[Tok], open: usize) -> Option<usize> {
    let mut depth = 0;
    for (j, t) in toks.iter().enumerate().skip(open) {
        match t.kind {
            TokKind::Punct('(') => depth += 1,
            TokKind::Punct(')') => {
                depth -= 1;
                if depth == 0 {
                    return Some(j);
                }
            }
            _ => {}
        }
    }
    None
}

/// `check <name>` for each CHECK in a saved `CREATE TABLE`: the constraint's name, or
/// for an unnamed one its expression (SQLite's own wording when it fails).
pub(crate) fn check_notes(create_sql: &str) -> Vec<String> {
    let toks = tokens(create_sql);
    let mut notes = Vec::new();
    for (i, t) in toks.iter().enumerate() {
        if !t.is_word("CHECK") {
            continue;
        }
        let named = i >= 2 && toks[i - 2].is_word("CONSTRAINT");
        let name = if named {
            toks[i - 1].text.clone()
        } else {
            let open = i + 1;
            match (toks.get(open), matching_paren(&toks, open)) {
                (Some(o), Some(close)) if o.kind == TokKind::Punct('(') => {
                    create_sql[o.end..toks[close].start].trim().to_string()
                }
                _ => continue,
            }
        };
        notes.push(format!("check {name}"));
    }
    notes
}

/// The text after a partial index's top-level `WHERE`.
pub(crate) fn index_predicate(index_sql: &str) -> Option<String> {
    let toks = tokens(index_sql);
    let mut depth = 0i32;
    for t in &toks {
        match t.kind {
            TokKind::Punct('(') => depth += 1,
            TokKind::Punct(')') => depth -= 1,
            _ if depth == 0 && t.is_word("WHERE") => {
                let rest = index_sql[t.end..].trim().trim_end_matches(';').trim();
                return (!rest.is_empty()).then(|| rest.to_string());
            }
            _ => {}
        }
    }
    None
}

/// The key parts of a saved `CREATE INDEX`, as written, without a trailing ASC or DESC.
pub(crate) fn index_parts(index_sql: &str) -> Vec<String> {
    let toks = tokens(index_sql);
    let Some(on) = toks.iter().position(|t| t.is_word("ON")) else {
        return Vec::new();
    };
    let Some(open) = toks
        .iter()
        .skip(on)
        .position(|t| t.kind == TokKind::Punct('('))
        .map(|p| p + on)
    else {
        return Vec::new();
    };
    let Some(close) = matching_paren(&toks, open) else {
        return Vec::new();
    };
    let mut parts = Vec::new();
    let mut depth = 0;
    let mut first = open + 1;
    for j in open + 1..=close {
        match toks[j].kind {
            TokKind::Punct('(') => depth += 1,
            TokKind::Punct(')') if depth > 0 => depth -= 1,
            TokKind::Punct(',' | ')') if depth == 0 => {
                let mut last = j;
                if last > first && (toks[last - 1].is_word("ASC") || toks[last - 1].is_word("DESC"))
                {
                    last -= 1;
                }
                if last > first {
                    parts.push(
                        index_sql[toks[first].start..toks[last - 1].end]
                            .trim()
                            .to_string(),
                    );
                }
                first = j + 1;
            }
            _ => {}
        }
    }
    parts
}

/// A literal SQLite takes as a constant default: a string, a number, a blob,
/// NULL, TRUE or FALSE.
pub(crate) fn is_literal(text: &str) -> bool {
    let d = text.trim();
    let toks = tokens(d);
    match toks.as_slice() {
        [t] if t.kind == TokKind::Str => true,
        [t] if ["NULL", "TRUE", "FALSE"].iter().any(|w| t.is_word(w)) => true,
        [x, b] if x.is_word("X") && b.kind == TokKind::Str && x.end == b.start => true,
        _ => is_number(d),
    }
}

fn is_number(text: &str) -> bool {
    let s = text.strip_prefix(['+', '-']).unwrap_or(text);
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        return !hex.is_empty() && hex.chars().all(|c| c.is_ascii_hexdigit());
    }
    let (mantissa, exponent) = match s.find(['e', 'E']) {
        Some(at) => (&s[..at], Some(&s[at + 1..])),
        None => (s, None),
    };
    let mantissa_ok = mantissa.chars().any(|c| c.is_ascii_digit())
        && mantissa.chars().all(|c| c.is_ascii_digit() || c == '.')
        && mantissa.matches('.').count() <= 1;
    let exponent_ok = exponent.is_none_or(|e| {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        !e.is_empty() && e.chars().all(|c| c.is_ascii_digit())
    });
    mantissa_ok && exponent_ok
}

/// A default as SQLite's `DEFAULT` takes it. `pragma_table_info` reads an
/// expression default without its parentheses, which `DEFAULT` needs, so any
/// default that is not a literal or a CURRENT_* keyword is wrapped once.
pub(crate) fn default_clause(text: &str) -> String {
    let d = text.trim();
    let toks = tokens(d);
    let keyword = matches!(toks.as_slice(), [t] if ["CURRENT_TIME", "CURRENT_DATE", "CURRENT_TIMESTAMP"]
        .iter()
        .any(|w| t.is_word(w)));
    let wrapped = toks.first().is_some_and(|t| t.kind == TokKind::Punct('('))
        && matching_paren(&toks, 0) == Some(toks.len() - 1);
    if keyword || wrapped || is_literal(d) {
        return d.to_string();
    }
    // SQLite reads a default that is one quoted name or one bare word as a
    // string; wrapped, it would be an expression naming a column.
    if let [t] = toks.as_slice() {
        let word = t.kind == TokKind::Word && !t.text.starts_with(|c: char| c.is_ascii_digit());
        if t.kind == TokKind::Ident || word {
            return format!("'{}'", t.text.replace('\'', "''"));
        }
    }
    format!("({d})")
}

pub(crate) fn names_object(sql: &str, names: &[String]) -> bool {
    tokens(sql)
        .iter()
        .any(|t| names.iter().any(|n| t.is_name(n)))
}

/// Whether `word` appears as a keyword, outside strings, quoted names and comments.
pub(crate) fn has_word(sql: &str, word: &str) -> bool {
    tokens(sql).iter().any(|t| t.is_word(word))
}

/// One Foreign Key clause of a saved `CREATE TABLE`, with what `pragma_foreign_key_list`
/// does not report: `deferrable`, `initially deferred`, `match <kind>`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct FkClause {
    /// The `CONSTRAINT` name, when the text gives one.
    pub(crate) name: Option<String>,
    pub(crate) columns: Vec<String>,
    pub(crate) target: String,
    pub(crate) attributes: Vec<String>,
}

/// Words that start another column constraint after a `REFERENCES` clause.
const COLUMN_CONSTRAINTS: &[&str] = &[
    "CONSTRAINT",
    "PRIMARY",
    "UNIQUE",
    "CHECK",
    "DEFAULT",
    "COLLATE",
    "GENERATED",
    "AS",
    "REFERENCES",
    "NULL",
];

/// The items of a `CREATE TABLE` body (column definitions and table constraints),
/// split at top-level commas.
fn body_items(toks: &[Tok]) -> Vec<&[Tok]> {
    let Some(open) = toks.iter().position(|t| t.kind == TokKind::Punct('(')) else {
        return Vec::new();
    };
    let Some(close) = matching_paren(toks, open) else {
        return Vec::new();
    };
    let mut items: Vec<&[Tok]> = Vec::new();
    let (mut depth, mut first) = (0, open + 1);
    for j in open + 1..close {
        match toks[j].kind {
            TokKind::Punct('(') => depth += 1,
            TokKind::Punct(')') => depth -= 1,
            TokKind::Punct(',') if depth == 0 => {
                items.push(&toks[first..j]);
                first = j + 1;
            }
            _ => {}
        }
    }
    items.push(&toks[first..close]);
    items
}

const TABLE_CONSTRAINTS: &[&str] = &["CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN"];

/// `(column, collation)` for each column definition with a top-level `COLLATE`,
/// the collation as written.
pub(crate) fn column_collations(create_sql: &str) -> Vec<(String, String)> {
    let toks = tokens(create_sql);
    let mut out = Vec::new();
    for item in body_items(&toks) {
        let Some(head) = item.first() else { continue };
        if TABLE_CONSTRAINTS.iter().any(|w| head.is_word(w)) {
            continue;
        }
        let mut depth = 0;
        for (i, t) in item.iter().enumerate() {
            match t.kind {
                TokKind::Punct('(') => depth += 1,
                TokKind::Punct(')') => depth -= 1,
                _ if depth == 0 && i > 0 && t.is_word("COLLATE") => {
                    if let Some(name) = item.get(i + 1) {
                        out.push((head.text.clone(), name.text.clone()));
                    }
                    break;
                }
                _ => {}
            }
        }
    }
    out
}

pub(crate) fn fk_clauses(create_sql: &str) -> Vec<FkClause> {
    let toks = tokens(create_sql);
    let mut out = Vec::new();
    for item in body_items(&toks) {
        let mut at = 0;
        if item.first().is_some_and(|t| t.is_word("CONSTRAINT")) {
            at = 2;
        }
        let Some(head) = item.get(at) else { continue };
        let table_key = head.is_word("FOREIGN");
        if !table_key
            && ["PRIMARY", "UNIQUE", "CHECK"]
                .iter()
                .any(|w| head.is_word(w))
        {
            continue;
        }
        for (r, t) in item.iter().enumerate() {
            if !t.is_word("REFERENCES") {
                continue;
            }
            let Some(target) = item.get(r + 1) else {
                continue;
            };
            let columns = if table_key {
                let mut cols = Vec::new();
                let mut inside = false;
                for c in &item[at..r] {
                    match c.kind {
                        TokKind::Punct('(') => inside = true,
                        TokKind::Punct(')') => break,
                        TokKind::Word | TokKind::Ident if inside => cols.push(c.text.clone()),
                        _ => {}
                    }
                }
                cols
            } else {
                vec![head.text.clone()]
            };
            let mut attributes = Vec::new();
            let mut k = r + 2;
            while k < item.len() {
                let w = &item[k];
                let next = item.get(k + 1);
                if w.is_word("NOT") && next.is_some_and(|n| n.is_word("DEFERRABLE")) {
                    k += 2;
                    continue;
                }
                if w.is_word("NOT") || COLUMN_CONSTRAINTS.iter().any(|c| w.is_word(c)) {
                    break;
                }
                if w.is_word("DEFERRABLE") {
                    attributes.push("deferrable".to_string());
                } else if w.is_word("INITIALLY") && next.is_some_and(|n| n.is_word("DEFERRED")) {
                    attributes.push("initially deferred".to_string());
                } else if w.is_word("MATCH")
                    && let Some(m) = next
                    && !m.text.eq_ignore_ascii_case("SIMPLE")
                {
                    attributes.push(format!("match {}", m.text.to_ascii_lowercase()));
                }
                k += 1;
            }
            // `CONSTRAINT n FOREIGN KEY ...` on the table, or `CONSTRAINT n REFERENCES` on a column.
            let name = if table_key {
                (at == 2).then(|| item[1].text.clone())
            } else {
                (r >= 2 && item[r - 2].is_word("CONSTRAINT")).then(|| item[r - 1].text.clone())
            };
            out.push(FkClause {
                name,
                columns,
                target: target.text.clone(),
                attributes,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fk_clauses_read_deferrable_and_match() {
        let sql = "CREATE TABLE c (id integer primary key, \
                   a int REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED NOT NULL, \
                   b int CONSTRAINT b_fk REFERENCES \"p\" (id) ON DELETE CASCADE, \
                   x int, y int, \
                   CONSTRAINT xy FOREIGN KEY (x, \"y\") REFERENCES q (a, b) MATCH FULL NOT DEFERRABLE, \
                   FOREIGN KEY (y) REFERENCES q (b) MATCH SIMPLE, \
                   note text DEFAULT 'REFERENCES z DEFERRABLE')";
        let got = fk_clauses(sql);
        let names: Vec<_> = got.iter().map(|c| c.name.as_deref()).collect();
        assert_eq!(names, [None, Some("b_fk"), Some("xy"), None]);
        let want = [
            (vec!["a"], "p", vec!["deferrable", "initially deferred"]),
            (vec!["b"], "p", vec![]),
            (vec!["x", "y"], "q", vec!["match full"]),
            (vec!["y"], "q", vec![]),
        ];
        assert_eq!(got.len(), want.len(), "{got:?}");
        for (g, (cols, target, attrs)) in got.iter().zip(want) {
            assert_eq!(g.columns, cols);
            assert_eq!(g.target, target);
            assert_eq!(g.attributes, attrs);
        }
    }

    #[test]
    fn column_collations_skip_constraints_and_nested_text() {
        let sql = "CREATE TABLE t (id integer primary key, \
                   a text COLLATE NOCASE NOT NULL, \
                   \"b c\" text collate \"rtrim\", \
                   d text CHECK (d COLLATE BINARY <> '') DEFAULT 'COLLATE x', \
                   CONSTRAINT u UNIQUE (a COLLATE BINARY))";
        assert_eq!(
            column_collations(sql),
            [
                ("a".to_string(), "NOCASE".to_string()),
                ("b c".to_string(), "rtrim".to_string()),
            ]
        );
    }

    #[test]
    fn expression_defaults_get_their_parentheses_back() {
        for (read, written) in [
            ("datetime('now')", "(datetime('now'))"),
            ("1+1", "(1+1)"),
            ("(1) + (2)", "((1) + (2))"),
            ("(datetime('now'))", "(datetime('now'))"),
            ("'new'", "'new'"),
            ("-1.5", "-1.5"),
            ("NULL", "NULL"),
            ("X'00'", "X'00'"),
            ("CURRENT_TIMESTAMP", "CURRENT_TIMESTAMP"),
            ("current_date", "current_date"),
            ("TRUE", "TRUE"),
            ("\"abc\"", "'abc'"),
            ("[abc]", "'abc'"),
            ("`abc`", "'abc'"),
            ("active", "'active'"),
            ("\"it's \"\"x\"\"\"", "'it''s \"x\"'"),
        ] {
            assert_eq!(default_clause(read), written, "{read}");
        }
    }

    #[test]
    fn has_word_skips_strings_and_names() {
        assert!(has_word(
            "CREATE TABLE t (id INTEGER PRIMARY KEY autoincrement)",
            "AUTOINCREMENT"
        ));
        assert!(!has_word(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, \"autoincrement\" int, n text DEFAULT 'AUTOINCREMENT')",
            "AUTOINCREMENT"
        ));
    }

    #[test]
    fn checks_outside_strings_and_comments() {
        let sql = "CREATE TABLE t (a int CHECK (a > (0)), b text DEFAULT 'CHECK (x)', \
                   -- CHECK (no)\n c int /* CHECK (no) */, \"check\" int, \
                   CONSTRAINT \"b ck\" CHECK (b <> ''))";
        assert_eq!(check_notes(sql), ["check a > (0)", "check b ck"]);
    }

    #[test]
    fn predicate_is_the_top_level_where() {
        assert_eq!(
            index_predicate("CREATE INDEX i ON t (a) WHERE a <> 'WHERE x'").as_deref(),
            Some("a <> 'WHERE x'")
        );
        assert_eq!(index_predicate("CREATE INDEX \"where\" ON t (a)"), None);
    }

    #[test]
    fn index_parts_as_written() {
        assert_eq!(
            index_parts("CREATE INDEX i ON t (lower(a), b DESC, substr(c, 1, 2) ASC) WHERE b > 0"),
            ["lower(a)", "b", "substr(c, 1, 2)"]
        );
    }

    #[test]
    fn view_names_match_words_and_quoted_names_only() {
        let names = vec!["orders".to_string()];
        assert!(names_object(
            "CREATE VIEW v AS SELECT * FROM \"Orders\"",
            &names
        ));
        assert!(names_object(
            "CREATE VIEW v AS SELECT * FROM [orders]",
            &names
        ));
        assert!(!names_object(
            "CREATE VIEW v AS SELECT 'orders' AS x",
            &names
        ));
        assert!(!names_object(
            "CREATE VIEW v AS SELECT * FROM orders_old",
            &names
        ));
    }
}
