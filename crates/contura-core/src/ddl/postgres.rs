pub(super) use crate::common::quote_double as quote;

pub(super) fn string_lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}
