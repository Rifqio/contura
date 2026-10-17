//! Helpers shared by every Dialect: cell previews, page order, key checks.

use crate::error::{Error, Result};
use crate::model::{
    Cell, ColumnInfo, DbObject, DialectKind, KeyPart, ObjectKind, ObjectPath, PREVIEW_BYTES,
    PREVIEW_CHARS, SortSpec,
};

pub(crate) fn hex_lower(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0xf) as usize] as char);
    }
    out
}

pub(crate) fn decode_hex(hex: &str) -> Result<Vec<u8>> {
    let invalid = || Error::InvalidInput("a binary key value is not valid hex".into());
    if !hex.len().is_multiple_of(2) {
        return Err(invalid());
    }
    hex.as_bytes()
        .chunks(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).map_err(|_| invalid())?;
            u8::from_str_radix(text, 16).map_err(|_| invalid())
        })
        .collect()
}

/// A text cell cut to `PREVIEW_CHARS` chars; `truncated` when it was longer.
pub(crate) fn text_preview(text: &str, total_bytes: u64) -> Cell {
    match text.char_indices().nth(PREVIEW_CHARS) {
        Some((cut, _)) => Cell::Text {
            value: text[..cut].to_string(),
            truncated: true,
            total_bytes,
        },
        None => Cell::Text {
            value: text.to_string(),
            truncated: false,
            total_bytes,
        },
    }
}

/// A binary cell showing up to `PREVIEW_BYTES` bytes as hex.
pub(crate) fn bytes_preview(bytes: &[u8], total_bytes: u64) -> Cell {
    Cell::Bytes {
        preview_hex: hex_lower(&bytes[..bytes.len().min(PREVIEW_BYTES)]),
        truncated: bytes.len() > PREVIEW_BYTES,
        total_bytes,
    }
}

/// The sort column first, then the primary key columns as a tie-break.
pub(crate) fn order_columns(
    columns: &[ColumnInfo],
    sort: Option<&SortSpec>,
) -> Result<Vec<(String, bool)>> {
    let pk = columns
        .iter()
        .filter(|c| c.is_primary_key)
        .map(|c| (c.name.clone(), false));
    match sort {
        Some(sort) => {
            if !columns.iter().any(|c| c.name == sort.column) {
                return Err(Error::InvalidInput(format!(
                    "unknown column {}",
                    sort.column
                )));
            }
            let mut order = vec![(sort.column.clone(), sort.descending)];
            order.extend(pk.filter(|(n, _)| *n != sort.column));
            Ok(order)
        }
        None => Ok(pk.collect()),
    }
}

/// `key` must name each primary key column exactly once and nothing else.
pub(crate) fn check_key(columns: &[ColumnInfo], key: &[KeyPart]) -> Result<()> {
    let pk: Vec<&ColumnInfo> = columns.iter().filter(|c| c.is_primary_key).collect();
    if pk.is_empty() {
        return Err(Error::NoPrimaryKey);
    }
    let names_match = key.len() == pk.len()
        && pk
            .iter()
            .all(|c| key.iter().filter(|k| k.column == c.name).count() == 1);
    if !names_match {
        return Err(Error::InvalidInput(
            "key must name exactly the primary key columns".into(),
        ));
    }
    Ok(())
}

fn kind_rank(kind: ObjectKind) -> u8 {
    match kind {
        ObjectKind::Table => 0,
        ObjectKind::View => 1,
        ObjectKind::Procedure => 2,
        ObjectKind::Function => 3,
        ObjectKind::Trigger => 4,
    }
}

/// Kind order (table, view, procedure, function, trigger), then name.
pub(crate) fn sort_objects(objects: &mut [DbObject]) {
    objects.sort_by(|a, b| {
        kind_rank(a.kind)
            .cmp(&kind_rank(b.kind))
            .then_with(|| a.name.cmp(&b.name))
    });
}

/// Double-quoted identifier, as Postgres and SQLite expect.
pub(crate) fn quote_double(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// An identifier quoted the way its Dialect expects.
pub(crate) fn sql_ident(kind: DialectKind, name: &str) -> String {
    match kind {
        DialectKind::MySql => crate::mysql::quote::quote_ident(name),
        DialectKind::Postgres | DialectKind::Sqlite => quote_double(name),
    }
}

/// A text value as a SQL literal. MySQL reads `\` as an escape, so a value
/// holding one is sent as a hex literal, which has no escapes to get wrong.
pub(crate) fn sql_string(kind: DialectKind, s: &str) -> String {
    if kind == DialectKind::MySql && s.contains('\\') {
        return format!("_utf8mb4 X'{}'", hex_lower(s.as_bytes()));
    }
    format!("'{}'", s.replace('\'', "''"))
}

/// The qualified table name a page query puts after FROM.
pub(crate) fn sql_table(kind: DialectKind, table: &ObjectPath) -> Result<String> {
    let scope = match kind {
        DialectKind::MySql | DialectKind::Sqlite => &table.database,
        DialectKind::Postgres => table
            .schema
            .as_ref()
            .ok_or_else(|| Error::InvalidInput("choose a schema".into()))?,
    };
    Ok(sql_scoped(kind, scope, &table.name))
}

/// `scope.name`, each part quoted: a MySQL database, a Postgres schema or a SQLite file.
pub(crate) fn sql_scoped(kind: DialectKind, scope: &str, name: &str) -> String {
    format!("{}.{}", sql_ident(kind, scope), sql_ident(kind, name))
}

#[cfg(test)]
mod sql_text_tests {
    use super::*;

    #[test]
    fn postgres_table_needs_a_schema() {
        let mut path = ObjectPath {
            database: "app".into(),
            schema: None,
            name: "t".into(),
        };
        assert!(matches!(
            sql_table(DialectKind::Postgres, &path),
            Err(Error::InvalidInput(m)) if m == "choose a schema"
        ));
        path.schema = Some("public".into());
        assert_eq!(
            sql_table(DialectKind::Postgres, &path).unwrap(),
            r#""public"."t""#
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, pk: bool) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            type_name: "x".into(),
            is_primary_key: pk,
        }
    }

    fn part(name: &str) -> KeyPart {
        KeyPart {
            column: name.into(),
            value: Cell::Number { value: "1".into() },
        }
    }

    fn sort(name: &str, descending: bool) -> SortSpec {
        SortSpec {
            column: name.into(),
            descending,
        }
    }

    #[test]
    fn text_preview_cuts_on_chars() {
        let text = "é".repeat(3000);
        match text_preview(&text, 6000) {
            Cell::Text {
                value,
                truncated,
                total_bytes,
            } => {
                assert_eq!(value.chars().count(), 1024);
                assert!(truncated);
                assert_eq!(total_bytes, 6000);
            }
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn bytes_preview_marks_truncation() {
        match bytes_preview(&[0xab; 1025], 1025) {
            Cell::Bytes {
                preview_hex,
                truncated,
                ..
            } => {
                assert_eq!(preview_hex.len(), 2048);
                assert!(truncated);
            }
            other => panic!("expected bytes, got {other:?}"),
        }
        match bytes_preview(&[0xab; 1024], 1024) {
            Cell::Bytes { truncated, .. } => assert!(!truncated),
            other => panic!("expected bytes, got {other:?}"),
        }
    }

    #[test]
    fn order_columns_sort_then_pk() {
        let cols = [col("id", true), col("name", false)];
        assert_eq!(
            order_columns(&cols, Some(&sort("name", true))).unwrap(),
            vec![("name".to_string(), true), ("id".to_string(), false)]
        );
        assert_eq!(
            order_columns(&cols, Some(&sort("id", true))).unwrap(),
            vec![("id".to_string(), true)]
        );
        assert_eq!(
            order_columns(&cols, None).unwrap(),
            vec![("id".to_string(), false)]
        );
    }

    #[test]
    fn order_columns_unknown_is_invalid_input() {
        let cols = [col("id", true)];
        let err = order_columns(&cols, Some(&sort("nope", false))).unwrap_err();
        assert!(matches!(err, Error::InvalidInput(m) if m == "unknown column nope"));
    }

    #[test]
    fn check_key_rules() {
        let no_pk = [col("a", false)];
        assert!(matches!(
            check_key(&no_pk, &[part("a")]),
            Err(Error::NoPrimaryKey)
        ));

        let cols = [col("a", true), col("b", true), col("c", false)];
        assert!(check_key(&cols, &[part("b"), part("a")]).is_ok());
        for bad in [
            vec![part("a")],
            vec![part("a"), part("b"), part("c")],
            vec![part("a"), part("a")],
            vec![part("a"), part("c")],
        ] {
            assert!(matches!(
                check_key(&cols, &bad),
                Err(Error::InvalidInput(_))
            ));
        }
    }

    #[test]
    fn quote_double_escapes_quotes() {
        assert_eq!(quote_double("we\"ird"), "\"we\"\"ird\"");
        assert_eq!(quote_double("ñame 表"), "\"ñame 表\"");
    }

    #[test]
    fn decode_hex_round_trips_and_rejects_bad_hex() {
        let bytes = [0u8, 1, 0x7f, 0x80, 0xff];
        assert_eq!(decode_hex(&hex_lower(&bytes)).unwrap(), bytes);
        assert!(matches!(decode_hex("abc"), Err(Error::InvalidInput(_))));
        assert!(matches!(decode_hex("zz"), Err(Error::InvalidInput(_))));
    }

    #[test]
    fn sort_objects_by_kind_then_name() {
        let obj = |kind, name: &str| DbObject {
            kind,
            name: name.into(),
            rows: None,
        };
        let mut v = vec![
            obj(ObjectKind::Trigger, "a"),
            obj(ObjectKind::Table, "z"),
            obj(ObjectKind::Table, "b"),
            obj(ObjectKind::View, "m"),
        ];
        sort_objects(&mut v);
        let names: Vec<&str> = v.iter().map(|o| o.name.as_str()).collect();
        assert_eq!(names, ["b", "z", "m", "a"]);
    }
}
