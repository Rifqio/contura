//! Value conversions per Dialect pair (step 8, "Value coercions"). Rows are read by
//! step 7's `RowSource` as `Value`s with a `ValueKind`; each column gets one
//! `Conversion`, decided once from the source kind and the target type, then
//! applied to every value. A value the target cannot take fails its row.

use crate::jobs::source::{Value, ValueKind};
use crate::model::DialectKind;

use super::types::SqlType;

/// Why one value could not be written; the runner adds the table and the row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RowFault {
    pub column: String,
    pub reason: String,
}

/// What happens to every value of one column on its way to the target.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Conversion {
    steps: Vec<Step>,
    target_type: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    /// MySQL `0000-00-00` dates become NULL (answer 6b).
    ZeroDateToNull,
    /// PostgreSQL `infinity` dates have no MySQL form.
    InfinityDateFails,
    /// PostgreSQL timestamptz read in UTC: the `+00` offset is dropped for MySQL.
    DropUtcOffset,
    /// MySQL 0 and 1 to PostgreSQL boolean; anything else fails.
    FlagToBool,
    /// PostgreSQL booleans to 1 and 0.
    BoolToInt,
    /// Bytes into a column that is not binary are written as `0x` hex.
    BytesToHex,
    /// NaN and Infinity fail where the target cannot store them.
    NonFiniteFails,
    /// PostgreSQL text cannot hold a NUL character.
    NulFails,
}

const BINARY: &[&str] = &[
    "bytea",
    "blob",
    "tinyblob",
    "mediumblob",
    "longblob",
    "binary",
    "varbinary",
];

/// Decides the conversion for one column.
pub fn coerce(
    source: DialectKind,
    kind: ValueKind,
    target: DialectKind,
    target_type: &SqlType,
) -> Conversion {
    use DialectKind::{MySql, Postgres};
    use ValueKind as K;
    let base = target_type.base.as_str();
    let dated = matches!(kind, K::Date | K::Timestamp | K::TimestampTz);
    let mut steps = Vec::new();
    if source == MySql && dated {
        steps.push(Step::ZeroDateToNull);
    }
    if source == Postgres && dated && target == MySql {
        steps.push(Step::InfinityDateFails);
    }
    if source == Postgres && kind == K::TimestampTz && target == MySql {
        steps.push(Step::DropUtcOffset);
    }
    if source == MySql && target == Postgres && base == "boolean" {
        steps.push(Step::FlagToBool);
    }
    if source == Postgres && kind == K::Bool && target != Postgres {
        steps.push(Step::BoolToInt);
    }
    if kind == K::Binary && !BINARY.contains(&base) {
        steps.push(Step::BytesToHex);
    }
    let scaled_numeric = matches!(base, "numeric" | "decimal") && !target_type.params.is_empty();
    if matches!(kind, K::Float | K::Decimal)
        && (target == MySql || (target == Postgres && scaled_numeric))
    {
        steps.push(Step::NonFiniteFails);
    }
    if target == Postgres && matches!(kind, K::Text | K::Json | K::Other) {
        steps.push(Step::NulFails);
    }
    let params = if target_type.params.is_empty() {
        String::new()
    } else {
        format!("({})", target_type.params.join(","))
    };
    Conversion {
        steps,
        target_type: format!("{base}{params}"),
    }
}

fn is_non_finite(s: &str) -> bool {
    let s = s.trim().trim_start_matches(['+', '-']);
    s.eq_ignore_ascii_case("nan")
        || s.eq_ignore_ascii_case("infinity")
        || s.eq_ignore_ascii_case("inf")
}

/// `2024-05-01 10:30:00+00` to `2024-05-01 10:30:00`; `None` for an offset other than zero.
fn without_utc_offset(s: &str) -> Option<String> {
    if let Some(rest) = s.strip_suffix('Z') {
        return Some(rest.to_string());
    }
    // The offset sign comes after the time, past the date's own dashes.
    let at = s.rfind(['+', '-']).filter(|&i| i > 10)?;
    let offset = &s[at + 1..];
    if offset.is_empty() || !offset.chars().all(|c| c.is_ascii_digit() || c == ':') {
        return Some(s.to_string());
    }
    offset
        .chars()
        .all(|c| c == '0' || c == ':')
        .then(|| s[..at].to_string())
}

impl Conversion {
    /// Converts one value of `column`, or says why the target cannot take it.
    pub fn apply(&self, column: &str, value: Value) -> Result<Value, RowFault> {
        let mut v = value;
        for step in &self.steps {
            if v == Value::Null {
                return Ok(v);
            }
            v = self.step(*step, column, v)?;
        }
        Ok(v)
    }

    fn invalid(&self, column: &str, shown: &str) -> RowFault {
        RowFault {
            column: column.to_string(),
            reason: format!("the value {shown} is not valid for {}", self.target_type),
        }
    }

    fn step(&self, step: Step, column: &str, v: Value) -> Result<Value, RowFault> {
        let text = match &v {
            Value::Text(s) | Value::Number(s) => Some(s.as_str()),
            _ => None,
        };
        Ok(match step {
            Step::ZeroDateToNull => match text {
                Some(s) if s.starts_with("0000-00-00") => Value::Null,
                _ => v,
            },
            Step::InfinityDateFails => match text {
                Some(s)
                    if s.trim_start_matches(['+', '-'])
                        .eq_ignore_ascii_case("infinity") =>
                {
                    return Err(self.invalid(column, s));
                }
                _ => v,
            },
            Step::DropUtcOffset => match text {
                Some(s) => match without_utc_offset(s) {
                    Some(local) => Value::Text(local),
                    None => return Err(self.invalid(column, s)),
                },
                None => v,
            },
            Step::FlagToBool => match &v {
                Value::Bool(_) => v,
                _ => match text.map(str::trim) {
                    Some("0") => Value::Bool(false),
                    Some("1") => Value::Bool(true),
                    Some(other) => return Err(self.invalid(column, other)),
                    None => return Err(self.invalid(column, "of this kind")),
                },
            },
            Step::BoolToInt => match &v {
                Value::Bool(b) => Value::Number(if *b { "1" } else { "0" }.into()),
                _ => match text.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
                    Some("t" | "true") => Value::Number("1".into()),
                    Some("f" | "false") => Value::Number("0".into()),
                    _ => v,
                },
            },
            Step::BytesToHex => match v {
                Value::Bytes(bytes) => {
                    let mut hex = String::with_capacity(2 + bytes.len() * 2);
                    hex.push_str("0x");
                    for b in bytes {
                        hex.push_str(&format!("{b:02x}"));
                    }
                    Value::Text(hex)
                }
                other => other,
            },
            Step::NonFiniteFails => match text {
                Some(s) if is_non_finite(s) => return Err(self.invalid(column, s)),
                _ => v,
            },
            Step::NulFails => match text {
                Some(s) if s.contains('\0') => {
                    return Err(RowFault {
                        column: column.to_string(),
                        reason: format!(
                            "the value has a NUL character, which PostgreSQL cannot store in {}",
                            self.target_type
                        ),
                    });
                }
                _ => v,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DialectKind::{MySql, Postgres, Sqlite};
    use crate::transfer::parse_type;

    fn conv(src: DialectKind, kind: ValueKind, target: DialectKind, ty: &str) -> Conversion {
        coerce(src, kind, target, &parse_type(ty))
    }

    fn n(s: &str) -> Value {
        Value::Number(s.into())
    }

    fn t(s: &str) -> Value {
        Value::Text(s.into())
    }

    fn fault(c: &Conversion, v: Value) -> String {
        c.apply("col", v).unwrap_err().reason
    }

    #[test]
    fn booleans_between_mysql_and_postgres() {
        let c = conv(MySql, ValueKind::Integer, Postgres, "boolean");
        assert_eq!(c.apply("col", n("0")), Ok(Value::Bool(false)));
        assert_eq!(c.apply("col", n("1")), Ok(Value::Bool(true)));
        assert_eq!(c.apply("col", Value::Null), Ok(Value::Null));
        assert_eq!(fault(&c, n("2")), "the value 2 is not valid for boolean");
        let c = conv(MySql, ValueKind::Bool, Postgres, "boolean");
        assert_eq!(c.apply("col", Value::Bool(true)), Ok(Value::Bool(true)));

        let c = conv(Postgres, ValueKind::Bool, MySql, "tinyint(1)");
        assert_eq!(c.apply("col", Value::Bool(true)), Ok(n("1")));
        assert_eq!(c.apply("col", t("f")), Ok(n("0")));
        assert_eq!(c.apply("col", t("t")), Ok(n("1")));
        let c = conv(Postgres, ValueKind::Bool, Sqlite, "INTEGER");
        assert_eq!(c.apply("col", Value::Bool(false)), Ok(n("0")));
    }

    #[test]
    fn binary_into_a_text_column_is_hex() {
        let c = conv(MySql, ValueKind::Binary, Postgres, "text");
        assert_eq!(
            c.apply("col", Value::Bytes(vec![0x0a, 0xff])),
            Ok(t("0x0aff"))
        );
        // Into a binary column the bytes travel as they are.
        let c = conv(MySql, ValueKind::Binary, Postgres, "bytea");
        assert_eq!(
            c.apply("col", Value::Bytes(vec![1, 2])),
            Ok(Value::Bytes(vec![1, 2]))
        );
    }

    #[test]
    fn mysql_zero_dates_become_null() {
        for (kind, ty, v) in [
            (ValueKind::Date, "date", "0000-00-00"),
            (ValueKind::Timestamp, "timestamp", "0000-00-00 00:00:00"),
            (
                ValueKind::Timestamp,
                "timestamp(3)",
                "0000-00-00 00:00:00.000",
            ),
        ] {
            for target in [MySql, Postgres, Sqlite] {
                let c = conv(MySql, kind, target, ty);
                assert_eq!(c.apply("col", t(v)), Ok(Value::Null), "{v} to {target:?}");
            }
        }
        let c = conv(MySql, ValueKind::Date, Postgres, "date");
        assert_eq!(c.apply("col", t("2024-02-29")), Ok(t("2024-02-29")));
    }

    #[test]
    fn postgres_infinity_dates() {
        let c = conv(Postgres, ValueKind::Timestamp, MySql, "datetime(6)");
        assert_eq!(
            fault(&c, t("infinity")),
            "the value infinity is not valid for datetime(6)"
        );
        assert_eq!(
            fault(&c, t("-infinity")),
            "the value -infinity is not valid for datetime(6)"
        );
        let c = conv(Postgres, ValueKind::Date, Sqlite, "TEXT");
        assert_eq!(c.apply("col", t("infinity")), Ok(t("infinity")));
    }

    #[test]
    fn nan_and_infinity_numbers() {
        for v in ["NaN", "Infinity", "-Infinity", "inf"] {
            let c = conv(Postgres, ValueKind::Float, MySql, "double");
            assert_eq!(
                fault(&c, n(v)),
                format!("the value {v} is not valid for double")
            );
            let c = conv(MySql, ValueKind::Float, Postgres, "numeric(10,2)");
            assert_eq!(
                fault(&c, n(v)),
                format!("the value {v} is not valid for numeric(10,2)")
            );
            let c = conv(MySql, ValueKind::Float, Postgres, "double precision");
            assert_eq!(c.apply("col", n(v)), Ok(n(v)));
            let c = conv(Postgres, ValueKind::Float, Sqlite, "REAL");
            assert_eq!(c.apply("col", n(v)), Ok(n(v)));
        }
        // A plain number is untouched everywhere.
        let c = conv(Postgres, ValueKind::Decimal, MySql, "decimal(10,2)");
        assert_eq!(c.apply("col", n("12.50")), Ok(n("12.50")));
    }

    #[test]
    fn nul_in_text_fails_on_postgres() {
        let c = conv(MySql, ValueKind::Text, Postgres, "text");
        assert_eq!(
            fault(&c, t("a\0b")),
            "the value has a NUL character, which PostgreSQL cannot store in text"
        );
        let c = conv(MySql, ValueKind::Text, Sqlite, "TEXT");
        assert_eq!(c.apply("col", t("a\0b")), Ok(t("a\0b")));
    }

    #[test]
    fn timestamptz_to_mysql_drops_the_utc_offset() {
        let c = conv(Postgres, ValueKind::TimestampTz, MySql, "datetime(6)");
        assert_eq!(
            c.apply("col", t("2024-05-01 10:30:00.25+00")),
            Ok(t("2024-05-01 10:30:00.25"))
        );
        assert_eq!(
            c.apply("col", t("2024-05-01 10:30:00+00:00")),
            Ok(t("2024-05-01 10:30:00"))
        );
        // The session reads in UTC, so any other offset means the read went wrong.
        assert_eq!(
            fault(&c, t("2024-05-01 10:30:00+02")),
            "the value 2024-05-01 10:30:00+02 is not valid for datetime(6)"
        );
    }

    #[test]
    fn spatial_and_everything_else_travel_as_they_are() {
        let c = conv(MySql, ValueKind::Other, Postgres, "text");
        assert_eq!(
            c.apply("col", t("POINT(-1.54 53.8)")),
            Ok(t("POINT(-1.54 53.8)"))
        );
        let c = conv(Postgres, ValueKind::Json, MySql, "json");
        assert_eq!(c.apply("col", t("{\"a\":1}")), Ok(t("{\"a\":1}")));
    }

    #[test]
    fn a_fault_names_its_column() {
        let c = conv(MySql, ValueKind::Integer, Postgres, "boolean");
        assert_eq!(
            c.apply("is_active", n("7")).unwrap_err().column,
            "is_active"
        );
    }
}
