//! Names in generated SQL: bare when that is safe, else quoted.

use super::is_reserved;
use crate::common::sql_ident;
use crate::model::DialectKind;

/// The name as written in SQL: bare when it matches `[a-z_][a-z0-9_]*`
/// (PostgreSQL folds bare names to lower case) or `[A-Za-z_][A-Za-z0-9_]*`
/// (MySQL, SQLite) and is not a reserved word; quoted otherwise.
pub(crate) fn bare_ident(kind: DialectKind, name: &str) -> String {
    let start_ok = |c: char| match kind {
        DialectKind::Postgres => c.is_ascii_lowercase() || c == '_',
        DialectKind::MySql | DialectKind::Sqlite => c.is_ascii_alphabetic() || c == '_',
    };
    let rest_ok = |c: char| start_ok(c) || c.is_ascii_digit();
    let mut chars = name.chars();
    let shape_ok = chars.next().is_some_and(start_ok) && chars.all(rest_ok);
    if shape_ok && !is_reserved(kind, name) && !mysql_introducer(kind, name) {
        name.to_string()
    } else {
        sql_ident(kind, name)
    }
}

/// MySQL's character sets. A bare `_<charset>` reads as a charset introducer
/// (`_utf8mb4 'x'`), not a name.
const MYSQL_CHARSETS: &[&str] = &[
    "armscii8", "ascii", "big5", "binary", "cp1250", "cp1251", "cp1256", "cp1257", "cp850",
    "cp852", "cp866", "cp932", "dec8", "eucjpms", "euckr", "filename", "gb18030", "gb2312", "gbk",
    "geostd8", "greek", "hebrew", "hp8", "keybcs2", "koi8r", "koi8u", "latin1", "latin2", "latin5",
    "latin7", "macce", "macroman", "sjis", "swe7", "tis620", "ucs2", "ujis", "utf16", "utf16le",
    "utf32", "utf8", "utf8mb3", "utf8mb4",
];

fn mysql_introducer(kind: DialectKind, name: &str) -> bool {
    kind == DialectKind::MySql
        && name
            .strip_prefix('_')
            .is_some_and(|rest| MYSQL_CHARSETS.iter().any(|c| c.eq_ignore_ascii_case(rest)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::visual_query::is_reserved;

    #[test]
    fn bare_when_safe() {
        let pg = DialectKind::Postgres;
        let my = DialectKind::MySql;
        let lite = DialectKind::Sqlite;
        assert_eq!(bare_ident(pg, "orders"), "orders");
        assert_eq!(bare_ident(pg, "_x9"), "_x9");
        assert_eq!(bare_ident(pg, "Orders"), r#""Orders""#);
        assert_eq!(bare_ident(pg, "order"), r#""order""#);
        assert_eq!(bare_ident(my, "Orders"), "Orders");
        assert_eq!(bare_ident(my, "order"), "`order`");
        assert_eq!(bare_ident(lite, "Orders"), "Orders");
        assert_eq!(bare_ident(lite, "order"), r#""order""#);
        assert_eq!(bare_ident(pg, "9lives"), r#""9lives""#);
        assert_eq!(bare_ident(pg, ""), r#""""#);

        assert_eq!(bare_ident(pg, "a b"), r#""a b""#);
        assert_eq!(bare_ident(my, "a b"), "`a b`");
        assert_eq!(bare_ident(lite, "a b"), r#""a b""#);
        assert_eq!(bare_ident(pg, r#"a"b"#), r#""a""b""#);
        assert_eq!(bare_ident(my, r#"a"b"#), r#"`a"b`"#);
        assert_eq!(bare_ident(lite, r#"a"b"#), r#""a""b""#);
        assert_eq!(bare_ident(pg, "a`b"), r#""a`b""#);
        assert_eq!(bare_ident(my, "a`b"), "`a``b`");
        assert_eq!(bare_ident(pg, "naïve"), r#""naïve""#);
        assert_eq!(bare_ident(my, "naïve"), "`naïve`");
        assert_eq!(bare_ident(lite, "naïve"), r#""naïve""#);

        assert!(is_reserved(pg, "OR"));
    }

    #[test]
    fn mysql_charset_introducers_are_quoted() {
        let my = DialectKind::MySql;
        assert_eq!(bare_ident(my, "_utf8mb4"), "`_utf8mb4`");
        assert_eq!(bare_ident(my, "_binary"), "`_binary`");
        assert_eq!(bare_ident(my, "_LATIN1"), "`_LATIN1`");
        assert_eq!(bare_ident(my, "_tmp"), "_tmp");
        assert_eq!(bare_ident(my, "_utf8mb4x"), "_utf8mb4x");
        assert_eq!(bare_ident(DialectKind::Postgres, "_binary"), "_binary");
        assert_eq!(bare_ident(DialectKind::Sqlite, "_utf8"), "_utf8");
    }
}
