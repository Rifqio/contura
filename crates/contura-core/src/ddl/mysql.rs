/// MySQL treats a backslash in a string literal as an escape. Under NO_BACKSLASH_ESCAPES it
/// does not, so the design runner turns that flag off on its own connection (`run_design`).
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

#[cfg(test)]
mod tests {
    use super::string_lit;
    use crate::design::check_fragment;

    /// Written for backslash escapes; the runner turns NO_BACKSLASH_ESCAPES off for it. Read
    /// either way, a quote never ends the literal early: it stays one expression.
    #[test]
    fn string_lit_never_ends_early_under_either_reading() {
        assert_eq!(string_lit(r"a\b"), r"'a\\b'");
        assert_eq!(string_lit(r"\'"), r"'\\'''");
        assert_eq!(string_lit("it's"), "'it''s'");
        for s in [
            r"\'",
            r"\",
            r"'\",
            r"\\'",
            r"x\'); DROP TABLE t; -- ",
            r"\' OR 1=1 #",
            "a\nb",
        ] {
            let lit = string_lit(s);
            assert!(check_fragment(&lit), "{s:?} gave {lit}");
            // The literal ends where it should: a comma after it is outside every quote.
            assert!(!check_fragment(&format!("{lit}, 1")), "{lit}");
        }
    }
}
