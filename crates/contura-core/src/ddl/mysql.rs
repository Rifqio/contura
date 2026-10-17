/// MySQL treats a backslash in a string literal as an escape.
pub(super) fn string_lit(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
}
