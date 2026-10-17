/// Quotes a MySQL identifier with backticks, doubling any embedded backtick.
pub fn quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_ident_escapes_backticks() {
        assert_eq!(quote_ident("plain"), "`plain`");
        assert_eq!(quote_ident("we`ird name"), "`we``ird name`");
        assert_eq!(quote_ident("ñame 表"), "`ñame 表`");
    }
}
