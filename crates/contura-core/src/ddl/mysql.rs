/// MySQL treats a backslash in a string literal as an escape.
pub(super) fn string_lit(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
}

/// A character set or collation name: bare when it is one plain word, as the
/// server writes them, otherwise quoted like an identifier.
pub(super) fn charset_name(name: &str) -> String {
    if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        name.to_string()
    } else {
        crate::mysql::quote::quote_ident(name)
    }
}
