//! Filter values as SQL literals.

use crate::common::sql_string;
use crate::model::DialectKind;

/// Base type words whose values are written as bare numbers. PostgreSQL's
/// short names (`int4`, `float8`) and MySQL's `mediumint` count too.
const NUMERIC: &[&str] = &[
    "int",
    "integer",
    "bigint",
    "smallint",
    "tinyint",
    "mediumint",
    "numeric",
    "decimal",
    "real",
    "double",
    "float",
    "int2",
    "int4",
    "int8",
    "float4",
    "float8",
];

enum TypeClass {
    Number,
    Boolean,
    Text,
    /// A SQLite column declared with no type, such as a view's computed
    /// column: it compares by value, so `'5'` never equals `5`.
    Untyped,
}

fn classify(kind: DialectKind, type_text: Option<&str>) -> TypeClass {
    let Some(type_text) = type_text else {
        return TypeClass::Text;
    };
    let lower = type_text.trim().to_ascii_lowercase();
    if kind == DialectKind::Sqlite && lower.is_empty() {
        return TypeClass::Untyped;
    }
    // A PostgreSQL array (`integer[]`, or the udt form `_int4`) takes an
    // array literal such as `'{1,2}'`, which is text.
    if lower.contains('[') || lower.starts_with('_') {
        return TypeClass::Text;
    }
    if kind == DialectKind::MySql && lower.starts_with("tinyint(1)") {
        return TypeClass::Boolean;
    }
    let base: String = lower
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    match base.as_str() {
        "bool" | "boolean" => TypeClass::Boolean,
        b if NUMERIC.contains(&b) => TypeClass::Number,
        _ => TypeClass::Text,
    }
}

/// Whether `s` is a plain decimal number: an optional sign, digits with at most
/// one point, and an optional exponent. No `NaN`, `inf` or separators.
fn is_number(s: &str) -> bool {
    let s = s.strip_prefix(['-', '+']).unwrap_or(s);
    let (mantissa, exponent) = match s.find(['e', 'E']) {
        Some(at) => (&s[..at], Some(&s[at + 1..])),
        None => (s, None),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |p: &str| p.chars().all(|c| c.is_ascii_digit());
    let mantissa_ok =
        digits(whole) && digits(fraction) && !(whole.is_empty() && fraction.is_empty());
    let exponent_ok = exponent.is_none_or(|e| {
        let e = e.strip_prefix(['-', '+']).unwrap_or(e);
        !e.is_empty() && digits(e)
    });
    mantissa_ok && exponent_ok
}

/// A value typed inside one pair of single quotes, without them; a doubled
/// quote inside reads as one.
fn unwrap_quotes(value: &str) -> Option<String> {
    let t = value.trim();
    (t.len() >= 2 && t.starts_with('\'') && t.ends_with('\''))
        .then(|| t[1..t.len() - 1].replace("''", "'"))
}

/// A filter value as a SQL literal for a column of `type_text` (`None` when the
/// type is not loaded yet, which writes text). A non-number on a number column
/// is refused with a message whose `{column}` the caller fills in (D5), and so
/// is a NUL character, which no Dialect takes inside a statement.
pub(crate) fn literal(
    kind: DialectKind,
    type_text: Option<&str>,
    value: &str,
) -> Result<String, String> {
    if value.contains('\0') {
        return Err(NUL_IN_VALUE.into());
    }
    let class = classify(kind, type_text);
    let quoted = unwrap_quotes(value);
    if matches!(class, TypeClass::Untyped) {
        // A value typed inside quotes stays text; a bare number-looking one is a number.
        return Ok(match quoted {
            None if is_number(value.trim()) => value.trim().to_string(),
            q => sql_string(kind, &q.unwrap_or_else(|| value.to_string())),
        });
    }
    let value = quoted.unwrap_or_else(|| value.to_string());
    let trimmed = value.trim();
    match class {
        TypeClass::Number => {
            if is_number(trimmed) {
                Ok(trimmed.to_string())
            } else {
                Err(format!(
                    "{{column}} is a number column; {trimmed} is not a number."
                ))
            }
        }
        TypeClass::Boolean => {
            let b = if trimmed.eq_ignore_ascii_case("true") {
                Some(true)
            } else if trimmed.eq_ignore_ascii_case("false") {
                Some(false)
            } else {
                None
            };
            Ok(match (b, kind) {
                (Some(b), DialectKind::Sqlite) => if b { "1" } else { "0" }.to_string(),
                (Some(b), _) => b.to_string(),
                (None, DialectKind::MySql) if is_number(trimmed) => trimmed.to_string(),
                (None, _) => sql_string(kind, &value),
            })
        }
        TypeClass::Text | TypeClass::Untyped => Ok(sql_string(kind, &value)),
    }
}

const NUL_IN_VALUE: &str = "A value for {column} has a NUL character. Remove it.";

/// A LIKE or NOT LIKE pattern: always text, on any column.
pub(crate) fn pattern(kind: DialectKind, value: &str) -> Result<String, String> {
    if value.contains('\0') {
        return Err(NUL_IN_VALUE.into());
    }
    Ok(sql_string(
        kind,
        &unwrap_quotes(value).unwrap_or_else(|| value.to_string()),
    ))
}

/// Whether values on a column of `type_text` are written as bare numbers.
pub(crate) fn is_number_column(kind: DialectKind, type_text: Option<&str>) -> bool {
    matches!(classify(kind, type_text), TypeClass::Number)
}

/// An IN list typed as one value: split on commas outside single quotes, each
/// item trimmed, empty items dropped.
pub fn split_in_list(value: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for c in value.chars() {
        match c {
            '\'' => {
                quoted = !quoted;
                current.push(c);
            }
            ',' if !quoted => items.push(std::mem::take(&mut current)),
            _ => current.push(c),
        }
    }
    items.push(current);
    items
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PG: DialectKind = DialectKind::Postgres;
    const MY: DialectKind = DialectKind::MySql;
    const LITE: DialectKind = DialectKind::Sqlite;

    fn lit(kind: DialectKind, ty: Option<&str>, value: &str) -> String {
        literal(kind, ty, value).unwrap()
    }

    #[test]
    fn text_is_quoted_and_one_outer_pair_unwrapped() {
        for kind in [PG, MY, LITE] {
            assert_eq!(lit(kind, Some("text"), "late"), "'late'");
            assert_eq!(lit(kind, Some("text"), "'late'"), "'late'");
            assert_eq!(lit(kind, Some("varchar(20)"), "it's"), "'it''s'");
            assert_eq!(lit(kind, Some("text"), "'it''s'"), "'it''s'");
            assert_eq!(lit(kind, Some("text"), "'"), "''''");
            assert_eq!(lit(kind, Some("text"), "''"), "''");
        }
        assert_eq!(lit(MY, Some("varchar(20)"), r"a\b"), "_utf8mb4 X'615c62'");
        assert_eq!(lit(PG, Some("text"), r"a\b"), r"E'a\\b'");
    }

    #[test]
    fn numbers_on_numeric_columns_are_bare() {
        assert_eq!(lit(PG, Some("int"), "12"), "12");
        assert_eq!(lit(PG, Some("numeric(12,2)"), "12.5"), "12.5");
        assert_eq!(lit(MY, Some("bigint unsigned"), "-3"), "-3");
        assert_eq!(lit(MY, Some("int(11)"), "'12'"), "12");
        assert_eq!(lit(PG, Some("double precision"), "1e3"), "1e3");
        assert_eq!(lit(LITE, Some("REAL"), " 0.5 "), "0.5");
        assert_eq!(lit(MY, Some("tinyint"), "7"), "7");
    }

    #[test]
    fn non_number_on_numeric_column_is_refused() {
        assert_eq!(
            literal(PG, Some("numeric"), "12,5"),
            Err("{column} is a number column; 12,5 is not a number.".to_string())
        );
        for bad in ["abc", "NaN", "inf", "1.2.3", "-", "1e", ""] {
            assert!(literal(PG, Some("integer"), bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn injection_shaped_numbers_are_refused() {
        for kind in [PG, MY, LITE] {
            for bad in ["--1", "0x1", "1;", "1 OR 1=1"] {
                assert_eq!(
                    literal(kind, Some("integer"), bad),
                    Err(format!(
                        "{{column}} is a number column; {bad} is not a number."
                    )),
                    "{kind:?} {bad}"
                );
            }
        }
    }

    #[test]
    fn array_types_are_text() {
        assert_eq!(lit(PG, Some("integer[]"), "12"), "'12'");
        assert_eq!(lit(PG, Some("numeric(12,2)[]"), "{1,2}"), "'{1,2}'");
        assert_eq!(lit(PG, Some("_int4"), "12"), "'12'");
        assert_eq!(lit(PG, Some("_bool"), "true"), "'true'");
        assert_eq!(lit(PG, Some("integer"), "12"), "12");
    }

    #[test]
    fn nul_in_a_value_is_refused() {
        for kind in [PG, MY, LITE] {
            for ty in [None, Some("text"), Some("integer"), Some("boolean")] {
                assert_eq!(
                    literal(kind, ty, "a\0b"),
                    Err("A value for {column} has a NUL character. Remove it.".to_string())
                );
            }
        }
    }

    #[test]
    fn number_typed_into_text_column_stays_text() {
        assert_eq!(lit(PG, Some("varchar(8)"), "12"), "'12'");
        assert_eq!(lit(MY, Some("char(3)"), "12"), "'12'");
        assert_eq!(lit(PG, Some("interval"), "12"), "'12'");
        assert_eq!(lit(PG, Some("point"), "12"), "'12'");
    }

    #[test]
    fn missing_type_writes_text_literal() {
        assert_eq!(lit(PG, None, "5"), "'5'");
        assert_eq!(lit(MY, None, "5"), "'5'");
        assert_eq!(lit(LITE, None, "5"), "'5'");
    }

    #[test]
    fn untyped_sqlite_column_takes_a_number_bare() {
        assert_eq!(lit(LITE, Some(""), "5"), "5");
        assert_eq!(lit(LITE, Some(" "), " -2.5 "), "-2.5");
        assert_eq!(lit(LITE, Some(""), "late"), "'late'");
        assert_eq!(lit(LITE, Some(""), "'5'"), "'5'");
        assert_eq!(lit(LITE, Some(""), "true"), "'true'");
        assert_eq!(lit(LITE, Some(""), "1 OR 1=1"), "'1 OR 1=1'");
        // Only SQLite: elsewhere an empty type text is text, and a missing type stays text.
        assert_eq!(lit(PG, Some(""), "5"), "'5'");
        assert_eq!(lit(MY, Some(""), "5"), "'5'");
        assert_eq!(lit(LITE, None, "5"), "'5'");
    }

    #[test]
    fn a_pattern_is_text_on_any_column() {
        for kind in [PG, MY, LITE] {
            assert_eq!(pattern(kind, "12%").unwrap(), "'12%'");
            assert_eq!(pattern(kind, "'1_'").unwrap(), "'1_'");
            assert_eq!(
                pattern(kind, "a\0b"),
                Err("A value for {column} has a NUL character. Remove it.".to_string())
            );
        }
        assert!(is_number_column(PG, Some("integer")));
        assert!(!is_number_column(PG, Some("integer[]")));
        assert!(!is_number_column(LITE, Some("")));
        assert!(!is_number_column(PG, None));
    }

    #[test]
    fn booleans_per_dialect() {
        assert_eq!(lit(PG, Some("boolean"), "true"), "true");
        assert_eq!(lit(PG, Some("bool"), "FALSE"), "false");
        assert_eq!(lit(MY, Some("tinyint(1)"), "True"), "true");
        assert_eq!(lit(MY, Some("tinyint(1)"), "0"), "0");
        assert_eq!(lit(LITE, Some("boolean"), "true"), "1");
        assert_eq!(lit(LITE, Some("BOOLEAN"), "false"), "0");
        assert_eq!(lit(PG, Some("boolean"), "t"), "'t'");
        assert_eq!(lit(PG, Some("text"), "true"), "'true'");
    }

    #[test]
    fn in_list_splits_on_commas_outside_quotes() {
        assert_eq!(split_in_list("'app', 'kiosk'"), vec!["'app'", "'kiosk'"]);
        assert_eq!(split_in_list("'a,b', c"), vec!["'a,b'", "c"]);
        assert_eq!(split_in_list(" 1 ,2,3 "), vec!["1", "2", "3"]);
        assert_eq!(split_in_list("'it''s', x"), vec!["'it''s'", "x"]);
        assert!(split_in_list("").is_empty());
        assert!(split_in_list(" , ").is_empty());
        assert_eq!(split_in_list("a,,b,"), vec!["a", "b"]);
    }
}
