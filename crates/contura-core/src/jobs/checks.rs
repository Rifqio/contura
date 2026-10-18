//! The import checks: each value against its table column before a write (Task 8).
//!
//! They are a first filter, run on the preview and by the check pass; the server has the
//! final word. A check never changes a value.

use crate::edits::is_number;
use crate::jobs::insert::{Conversion, conversion_for, is_float_word};
use crate::jobs::mapping::TargetColumn;
use crate::jobs::source::Value;
use crate::model::DialectKind;

pub const NUL_TEXT: &str = "Text with a NUL character cannot go into PostgreSQL.";

/// A value as a message shows it: at most 40 characters.
fn shown(s: &str) -> String {
    match s.char_indices().nth(40) {
        Some((at, _)) => format!("{}...", &s[..at]),
        None => s.to_string(),
    }
}

/// The type text in lower case, its first word, and whether it is an array.
fn type_parts(type_sql: &str) -> (String, String, bool) {
    let lower = type_sql.trim().to_ascii_lowercase();
    let base: String = lower
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    let array = lower.contains('[') || lower.starts_with('_');
    (lower, base, array)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Temporal {
    Date,
    Time,
    Timestamp,
}

fn temporal(base: &str) -> Option<Temporal> {
    match base {
        "date" => Some(Temporal::Date),
        "time" | "timetz" => Some(Temporal::Time),
        "timestamp" | "timestamptz" | "datetime" => Some(Temporal::Timestamp),
        _ => None,
    }
}

/// `n` of `varchar(n)`, `char(n)`, `character varying(n)` and the like.
fn char_limit(lower: &str, base: &str) -> Option<usize> {
    if !matches!(
        base,
        "varchar" | "char" | "character" | "nvarchar" | "nchar" | "bpchar"
    ) {
        return None;
    }
    let (_, rest) = lower.split_once('(')?;
    let (n, _) = rest.split_once(')')?;
    n.trim().parse().ok()
}

/// At least `min` and at most `max` leading digits; the rest after them.
fn digits(s: &str, min: usize, max: usize) -> Option<&str> {
    let n = s.bytes().take(max).take_while(u8::is_ascii_digit).count();
    (n >= min).then(|| &s[n..])
}

fn take(s: &str, c: char) -> Option<&str> {
    s.strip_prefix(c)
}

/// `YYYY-MM-DD`; the rest after it.
fn date_part(s: &str) -> Option<&str> {
    let s = digits(s, 4, 4)?;
    let s = digits(take(s, '-')?, 2, 2)?;
    digits(take(s, '-')?, 2, 2)
}

/// `HH:MM`, `HH:MM:SS` or `HH:MM:SS.f`; MySQL TIME also takes up to three hour digits.
fn time_part(s: &str, hours: usize) -> Option<&str> {
    let s = digits(s, 1, hours)?;
    let s = digits(take(s, ':')?, 2, 2)?;
    let Some(rest) = take(s, ':') else {
        return Some(s);
    };
    let s = digits(rest, 2, 2)?;
    match s.strip_prefix(['.', ',']) {
        Some(frac) => digits(frac, 1, 9),
        None => Some(s),
    }
}

/// An offset: `Z`, `+HH`, `+HH:MM`, `+HHMM`, with an optional space before it.
fn offset(s: &str) -> Option<&str> {
    let s = s.strip_prefix(' ').unwrap_or(s);
    if let Some(rest) = s.strip_prefix(['Z', 'z']) {
        return Some(rest);
    }
    let s = digits(s.strip_prefix(['+', '-'])?, 2, 2)?;
    match s.strip_prefix(':') {
        Some(rest) => digits(rest, 2, 2),
        None => Some(digits(s, 2, 2).unwrap_or(s)),
    }
}

fn whole(rest: Option<&str>) -> bool {
    rest.is_some_and(str::is_empty)
}

fn with_offset(rest: Option<&str>) -> bool {
    match rest {
        Some("") => true,
        Some(r) => whole(offset(r)),
        None => false,
    }
}

/// ISO 8601 for a date, a time or a timestamp, as the Dialects write and read them.
fn is_iso(kind: DialectKind, what: Temporal, s: &str) -> bool {
    if kind == DialectKind::Postgres
        && matches!(what, Temporal::Date | Temporal::Timestamp)
        && matches!(
            s.to_ascii_lowercase().as_str(),
            "infinity" | "-infinity" | "+infinity"
        )
    {
        return true;
    }
    match what {
        Temporal::Date => whole(date_part(s)),
        Temporal::Time => {
            let (s, hours) = match kind {
                DialectKind::MySql => (s.strip_prefix('-').unwrap_or(s), 3),
                _ => (s, 2),
            };
            with_offset(time_part(s, hours))
        }
        Temporal::Timestamp => {
            let Some(rest) = date_part(s) else {
                return false;
            };
            if rest.is_empty() {
                return true;
            }
            let Some(rest) = rest.strip_prefix(['T', 't', ' ']) else {
                return false;
            };
            with_offset(time_part(rest, 2))
        }
    }
}

fn is_comma_decimal(s: &str) -> bool {
    match s.split_once(',') {
        Some((a, b)) => {
            !a.is_empty()
                && !b.is_empty()
                && a.bytes().all(|c| c.is_ascii_digit())
                && b.bytes().all(|c| c.is_ascii_digit())
        }
        None => false,
    }
}

fn is_bool_word(s: &str) -> bool {
    matches!(
        s.trim().to_ascii_lowercase().as_str(),
        "true" | "false" | "t" | "f" | "yes" | "no" | "y" | "n" | "on" | "off" | "1" | "0"
    )
}

/// What Contura's checks say about `text` going into `col`, or None when it fits.
pub fn check_value(kind: DialectKind, col: &TargetColumn, text: &str) -> Option<String> {
    let (lower, base, array) = type_parts(&col.type_sql);
    let v = shown(text);
    let name = &col.name;
    match conversion_for(kind, &col.type_sql) {
        Conversion::Number => {
            let t = text.trim();
            let float_word =
                kind == DialectKind::Postgres && is_float_word(&Value::Text(t.to_string()));
            if !is_number(t) && !float_word {
                if is_comma_decimal(t) {
                    return Some(format!("{v} uses a comma."));
                }
                return Some(format!("{v} is not a number for {name}."));
            }
        }
        Conversion::Bool => {
            let number = kind != DialectKind::Postgres && is_number(text.trim());
            if !is_bool_word(text) && !number {
                return Some(format!("{v} is not true or false for {name}."));
            }
        }
        _ => {}
    }
    if !array
        && let Some(what) = temporal(&base)
        && !is_iso(kind, what, text.trim())
    {
        return Some(format!("{v} is not a date for {name}."));
    }
    if kind == DialectKind::Postgres && text.contains('\0') && !matches!(base.as_str(), "bytea") {
        return Some(NUL_TEXT.into());
    }
    // SQLite keeps any length, so only MySQL and PostgreSQL are checked. Both drop
    // trailing spaces past the limit rather than refuse them.
    if kind != DialectKind::Sqlite
        && !array
        && let Some(n) = char_limit(&lower, &base)
        && text.trim_end_matches(' ').chars().count() > n
    {
        return Some(format!(
            "{v} is longer than {} allows for {name}.",
            col.type_sql
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const MY: DialectKind = DialectKind::MySql;
    const PG: DialectKind = DialectKind::Postgres;
    const LITE: DialectKind = DialectKind::Sqlite;

    fn col(name: &str, type_sql: &str) -> TargetColumn {
        TargetColumn {
            name: name.into(),
            type_sql: type_sql.into(),
            nullable: true,
            ..TargetColumn::default()
        }
    }

    /// (Dialect, type, value, expected message or None).
    #[test]
    fn check_value_table() {
        let cases: Vec<(DialectKind, &str, &str, Option<&str>)> = vec![
            // Numbers, by the 5b grammar.
            (PG, "integer", "12", None),
            (PG, "integer", " 42 ", None),
            (MY, "decimal(10,2)", "-1.50", None),
            (LITE, "INTEGER", "1e5", None),
            (PG, "numeric", "n/a", Some("n/a is not a number for c.")),
            (MY, "int", "12,50", Some("12,50 uses a comma.")),
            (LITE, "REAL", "1,5", Some("1,5 uses a comma.")),
            (PG, "integer", "", Some(" is not a number for c.")),
            (
                MY,
                "bigint",
                "1;DROP",
                Some("1;DROP is not a number for c."),
            ),
            (PG, "double precision", "NaN", None),
            (PG, "real", "-Infinity", None),
            (MY, "double", "NaN", Some("NaN is not a number for c.")),
            // Booleans: true/false, t/f, yes/no, y/n, on/off, 1/0, any case.
            (PG, "boolean", "TRUE", None),
            (PG, "boolean", "f", None),
            (PG, "boolean", "Yes", None),
            (PG, "boolean", "n", None),
            (PG, "boolean", "ON", None),
            (PG, "boolean", "off", None),
            (PG, "boolean", "0", None),
            (
                PG,
                "boolean",
                "maybe",
                Some("maybe is not true or false for c."),
            ),
            (PG, "boolean", "2", Some("2 is not true or false for c.")),
            // MySQL tinyint(1) and SQLite BOOLEAN hold any number.
            (MY, "tinyint(1)", "2", None),
            (LITE, "BOOLEAN", "-1", None),
            (
                MY,
                "tinyint(1)",
                "nope",
                Some("nope is not true or false for c."),
            ),
            // Dates, times and timestamps in ISO 8601.
            (PG, "date", "2026-10-18", None),
            (
                MY,
                "date",
                "18/10/2026",
                Some("18/10/2026 is not a date for c."),
            ),
            (PG, "date", "infinity", None),
            (
                MY,
                "date",
                "infinity",
                Some("infinity is not a date for c."),
            ),
            (PG, "time without time zone", "04:05:06.789", None),
            (PG, "time", "04:05", None),
            (PG, "time with time zone", "04:05:06+07", None),
            (MY, "time", "838:59:59", None),
            (MY, "time", "-12:00:00", None),
            (PG, "time", "4pm", Some("4pm is not a date for c.")),
            (
                PG,
                "timestamp(6) without time zone",
                "2001-02-03 04:05:06.000001",
                None,
            ),
            (
                PG,
                "timestamp with time zone",
                "2001-02-03 04:05:06+00",
                None,
            ),
            (PG, "timestamptz", "2001-02-03T04:05:06Z", None),
            (MY, "datetime(6)", "2001-02-03T04:05:06.123", None),
            (MY, "timestamp", "2001-02-03 04:05:06+05:30", None),
            (LITE, "TIMESTAMP", "2001-02-03 04:05:06.000+00:00", None),
            (MY, "datetime", "2001-02-03", None),
            (
                MY,
                "datetime",
                "yesterday",
                Some("yesterday is not a date for c."),
            ),
            (
                PG,
                "timestamp",
                "2001-02-03 25",
                Some("2001-02-03 25 is not a date for c."),
            ),
            (PG, "date[]", "{2001-02-03}", None),
            // NUL in PostgreSQL text.
            (PG, "text", "a\0b", Some(NUL_TEXT)),
            (MY, "text", "a\0b", None),
            (LITE, "TEXT", "a\0b", None),
            // varchar(n) and char(n).
            (PG, "character varying(3)", "abc", None),
            (
                PG,
                "character varying(3)",
                "abcd",
                Some("abcd is longer than character varying(3) allows for c."),
            ),
            (
                MY,
                "varchar(2)",
                "è¡¨è¡¨è¡¨",
                Some("è¡¨è¡¨è¡¨ is longer than varchar(2) allows for c."),
            ),
            (MY, "char(2)", "ab  ", None),
            (
                PG,
                "character(1)",
                "ab",
                Some("ab is longer than character(1) allows for c."),
            ),
            (LITE, "VARCHAR(2)", "abcdef", None),
            (PG, "text", "anything at all", None),
            (PG, "varchar", "no limit here", None),
        ];
        for (kind, ty, value, want) in cases {
            assert_eq!(
                check_value(kind, &col("c", ty), value).as_deref(),
                want,
                "{kind:?} {ty} {value:?}"
            );
        }
    }

    #[test]
    fn long_values_are_cut() {
        let long = "x".repeat(100);
        let got = check_value(PG, &col("price", "numeric"), &long).unwrap();
        assert_eq!(
            got,
            format!("{}... is not a number for price.", "x".repeat(40))
        );
    }
}
