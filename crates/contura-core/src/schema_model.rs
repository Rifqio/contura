//! A Dialect-neutral Schema Model. The Core reads it from a live database,
//! writes DBML from it and writes DDL from it; the UI parses DBML into it.

use serde::{Deserialize, Serialize};

use crate::model::DialectKind;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaModel {
    pub dialect: DialectKind,
    pub tables: Vec<SmTable>,
    pub refs: Vec<SmRef>,
    pub enums: Vec<SmEnum>,
    /// Objects the model cannot express, e.g. `"view v_orders"`.
    pub skipped: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SmTable {
    pub schema: Option<String>,
    pub name: String,
    pub alias: Option<String>,
    pub note: Option<String>,
    pub columns: Vec<SmColumn>,
    pub indexes: Vec<SmIndex>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SmColumn {
    pub name: String,
    pub type_name: String,
    pub pk: bool,
    pub increment: bool,
    pub not_null: bool,
    pub unique: bool,
    pub default: Option<SmDefault>,
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SmDefault {
    String { value: String },
    Number { value: String },
    Bool { value: bool },
    Null,
    Expression { value: String },
}

/// A composite primary key is an index with `pk: true`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SmIndex {
    pub name: Option<String>,
    pub columns: Vec<String>,
    pub unique: bool,
    pub pk: bool,
}

/// `from` is the many side, `to` the one side. Actions are upper case, e.g. `"CASCADE"`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SmRef {
    pub name: Option<String>,
    pub from: SmEndpoint,
    pub to: SmEndpoint,
    pub on_delete: Option<String>,
    pub on_update: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SmEndpoint {
    pub schema: Option<String>,
    pub table: String,
    pub columns: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SmEnum {
    pub schema: Option<String>,
    pub name: String,
    pub values: Vec<String>,
}

/// Classifies a column default as the database reports it (already unquoted
/// text for literals). `quoted` says whether the source marked it as a string.
pub(crate) fn classify_default(raw: &str, quoted: bool) -> SmDefault {
    if quoted {
        return SmDefault::String {
            value: raw.to_string(),
        };
    }
    let t = raw.trim();
    if t.eq_ignore_ascii_case("null") {
        SmDefault::Null
    } else if t.eq_ignore_ascii_case("true") || t.eq_ignore_ascii_case("false") {
        SmDefault::Bool {
            value: t.eq_ignore_ascii_case("true"),
        }
    } else if !t.is_empty() && t.parse::<f64>().is_ok() {
        SmDefault::Number {
            value: t.to_string(),
        }
    } else {
        SmDefault::Expression {
            value: t.to_string(),
        }
    }
}

/// Classifies a default written as SQL, as Postgres (`'mall'::store_kind`) and
/// SQLite (`'new'`) report it. A quoted literal, with an optional cast, is a string.
pub(crate) fn parse_sql_default(expr: &str) -> SmDefault {
    let t = expr.trim();
    if let Some(rest) = t.strip_prefix('\'') {
        let mut value = String::new();
        let mut chars = rest.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\'' {
                if chars.peek() == Some(&'\'') {
                    chars.next();
                    value.push('\'');
                    continue;
                }
                let tail: String = chars.collect();
                if tail.is_empty() || tail.starts_with("::") {
                    return SmDefault::String { value };
                }
                break;
            }
            value.push(c);
        }
    }
    classify_default(t, false)
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_sql_defaults() {
        assert_eq!(
            parse_sql_default("'mall'::store_kind"),
            SmDefault::String {
                value: "mall".into()
            }
        );
        assert_eq!(
            parse_sql_default("'it''s'"),
            SmDefault::String {
                value: "it's".into()
            }
        );
        assert_eq!(
            parse_sql_default("CURRENT_TIMESTAMP"),
            SmDefault::Expression {
                value: "CURRENT_TIMESTAMP".into()
            }
        );
        assert_eq!(
            parse_sql_default("0"),
            SmDefault::Number { value: "0".into() }
        );
    }

    use super::*;

    #[test]
    fn default_shape() {
        assert_eq!(
            serde_json::to_value(SmDefault::String { value: "x".into() }).unwrap(),
            serde_json::json!({"t":"string","value":"x"})
        );
    }

    #[test]
    fn classifies_defaults() {
        assert_eq!(
            classify_default("0", false),
            SmDefault::Number { value: "0".into() }
        );
        assert_eq!(
            classify_default("now()", false),
            SmDefault::Expression {
                value: "now()".into()
            }
        );
        assert_eq!(
            classify_default("abc", true),
            SmDefault::String {
                value: "abc".into()
            }
        );
        assert_eq!(classify_default("NULL", false), SmDefault::Null);
    }
}
