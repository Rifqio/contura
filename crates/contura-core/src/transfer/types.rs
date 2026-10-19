//! A small parser for column type text as the three Dialects report it, such as
//! `int unsigned`, `numeric(10,2)`, `character varying(255)`, `timestamp(3) with time zone`,
//! `enum('a','b')` or `integer[]`. Step 10's normalisers reuse it.

use serde::{Deserialize, Serialize};

/// A parsed column type. `base` is lower case with single spaces (`character varying`);
/// `params` are the parenthesised parts as written, quotes kept (`'a'` for an enum value).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SqlType {
    pub base: String,
    pub params: Vec<String>,
    pub unsigned: bool,
    pub array: bool,
    pub with_tz: bool,
}

impl SqlType {
    /// The first parameter as a number, such as the precision of `numeric(10,2)`.
    pub fn param_u32(&self, i: usize) -> Option<u32> {
        self.params.get(i).and_then(|p| p.trim().parse().ok())
    }
}

/// Parses a column type. It never fails: text it cannot read becomes the base.
pub fn parse_type(text: &str) -> SqlType {
    let mut rest = text.trim().to_string();
    let mut array = false;
    while let Some(stripped) = rest.strip_suffix("[]") {
        array = true;
        rest = stripped.trim_end().to_string();
    }
    let (outside, params) = split_params(&rest);
    let mut unsigned = false;
    let mut with_tz = false;
    let lower: Vec<String> = outside
        .split_whitespace()
        .map(|w| w.to_ascii_lowercase())
        .collect();
    let mut words: Vec<String> = Vec::new();
    let mut i = 0;
    while i < lower.len() {
        let w = lower[i].as_str();
        let next_two = (
            lower.get(i + 1).map(String::as_str),
            lower.get(i + 2).map(String::as_str),
        );
        match (w, next_two) {
            ("unsigned", _) => unsigned = true,
            ("signed" | "zerofill", _) => {}
            ("with", (Some("time"), Some("zone"))) => {
                with_tz = true;
                i += 2;
            }
            ("without", (Some("time"), Some("zone"))) => i += 2,
            _ => words.push(lower[i].clone()),
        }
        i += 1;
    }
    let mut base = words.join(" ");
    // PostgreSQL's short spellings of zoned types.
    if base == "timestamptz" || base == "timetz" {
        base.truncate(base.len() - 2);
        with_tz = true;
    }
    SqlType {
        base,
        params,
        unsigned,
        array,
        with_tz,
    }
}

/// Splits off the first top-level `( ... )` group: the text outside it (with a space
/// where it was) and its comma-separated parts, quotes kept and respected.
fn split_params(text: &str) -> (String, Vec<String>) {
    let Some(open) = text.find('(') else {
        return (text.to_string(), Vec::new());
    };
    let chars: Vec<char> = text[open + 1..].chars().collect();
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut depth = 0usize;
    let mut quote: Option<char> = None;
    let mut end = None;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            current.push(c);
            if c == q {
                if chars.get(i + 1) == Some(&q) {
                    current.push(q);
                    i += 1;
                } else {
                    quote = None;
                }
            }
        } else {
            match c {
                '\'' | '"' => {
                    quote = Some(c);
                    current.push(c);
                }
                '(' => {
                    depth += 1;
                    current.push(c);
                }
                ')' if depth == 0 => {
                    end = Some(i);
                    break;
                }
                ')' => {
                    depth -= 1;
                    current.push(c);
                }
                ',' if depth == 0 => parts.push(std::mem::take(&mut current).trim().to_string()),
                _ => current.push(c),
            }
        }
        i += 1;
    }
    let Some(end) = end else {
        return (text.to_string(), Vec::new());
    };
    parts.push(current.trim().to_string());
    let after: String = chars[end + 1..].iter().collect();
    (format!("{} {}", &text[..open], after), parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(base: &str, params: &[&str]) -> SqlType {
        SqlType {
            base: base.into(),
            params: params.iter().map(|p| p.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn parses_the_shapes_each_dialect_reports() {
        assert_eq!(parse_type("int"), t("int", &[]));
        assert_eq!(parse_type("numeric(10,2)"), t("numeric", &["10", "2"]));
        assert_eq!(
            parse_type("character varying(255)"),
            t("character varying", &["255"])
        );
        assert_eq!(parse_type("DOUBLE PRECISION"), t("double precision", &[]));
        assert_eq!(
            parse_type("int(10) unsigned zerofill"),
            SqlType {
                unsigned: true,
                ..t("int", &["10"])
            }
        );
        assert_eq!(
            parse_type("timestamp(3) with time zone"),
            SqlType {
                with_tz: true,
                ..t("timestamp", &["3"])
            }
        );
        assert_eq!(
            parse_type("timestamp without time zone"),
            t("timestamp", &[])
        );
        assert_eq!(
            parse_type("timestamptz"),
            SqlType {
                with_tz: true,
                ..t("timestamp", &[])
            }
        );
        assert_eq!(
            parse_type("integer[]"),
            SqlType {
                array: true,
                ..t("integer", &[])
            }
        );
        assert_eq!(
            parse_type("enum('a','it''s, here')"),
            t("enum", &["'a'", "'it''s, here'"])
        );
    }

    #[test]
    fn unreadable_text_becomes_the_base() {
        assert_eq!(parse_type("weird(type"), t("weird(type", &[]));
        assert_eq!(parse_type("  "), t("", &[]));
    }
}
