//! `InsertBuilder`: multi-row INSERT statements with per-Dialect literals.
//!
//! The SQL export and the import write the same statements: one head
//! (`INSERT INTO t (a, b) VALUES`), then rows of literals cut by a row and a byte limit.
//! The same input always gives the same text, so a job's fingerprint can hold the head
//! and the per-column literal rule.

use crate::common::{hex_lower, sql_ident, sql_string};
use crate::edits::is_number;
use crate::error::{Error, Result};
use crate::jobs::source::Value;
use crate::model::DialectKind;

/// How a column's values are written as SQL literals.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Conversion {
    Text,
    Number,
    Bool,
    Binary,
    Json,
    /// A MySQL spatial column: WKT text written through `ST_GeomFromText`, with the
    /// column's SRID.
    Geometry {
        srid: Option<u32>,
    },
}

/// Base type words whose values are written as bare numbers.
const NUMBER_TYPES: &[&str] = &[
    "int",
    "integer",
    "bigint",
    "smallint",
    "tinyint",
    "mediumint",
    "numeric",
    "decimal",
    "dec",
    "fixed",
    "real",
    "double",
    "float",
    "int2",
    "int4",
    "int8",
    "float4",
    "float8",
    "serial",
    "smallserial",
    "bigserial",
    "serial2",
    "serial4",
    "serial8",
];

const BINARY_TYPES: &[&str] = &[
    "bytea",
    "blob",
    "tinyblob",
    "mediumblob",
    "longblob",
    "binary",
    "varbinary",
];

/// MySQL's spatial types, read as WKT (`ST_AsText`) by the export source.
const SPATIAL_TYPES: &[&str] = &[
    "geometry",
    "point",
    "linestring",
    "polygon",
    "multipoint",
    "multilinestring",
    "multipolygon",
    "geometrycollection",
    "geomcollection",
];

/// The `SRID n` a MySQL spatial type text carries (`point srid 4326`, or the
/// `/*!80003 SRID 4326 */` of SHOW CREATE TABLE).
pub(crate) fn srid_in(type_lower: &str) -> Option<u32> {
    let (_, rest) = type_lower.split_once("srid")?;
    let digits: String = rest
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

/// The literal rule for a column of `type_sql` (the type text the server reports).
/// A MySQL spatial column's type text carries its SRID as `SRID n` when it has one
/// (information_schema.COLUMNS.SRS_ID).
pub fn conversion_for(kind: DialectKind, type_sql: &str) -> Conversion {
    let lower = type_sql.trim().to_ascii_lowercase();
    // A PostgreSQL array (`integer[]`, or the udt form `_int4`) takes an array literal,
    // which is text.
    if lower.contains('[') || lower.starts_with('_') {
        return Conversion::Text;
    }
    if kind == DialectKind::MySql && lower.starts_with("tinyint(1)") {
        return Conversion::Bool;
    }
    let base: String = lower
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    if kind == DialectKind::MySql && SPATIAL_TYPES.contains(&base.as_str()) {
        return Conversion::Geometry {
            srid: srid_in(&lower),
        };
    }
    match base.as_str() {
        "bool" | "boolean" => Conversion::Bool,
        "json" | "jsonb" => Conversion::Json,
        // MySQL BIT values are read as numbers (`col + 0`); a quoted one would be bytes.
        "bit" if kind == DialectKind::MySql => Conversion::Number,
        b if NUMBER_TYPES.contains(&b) => Conversion::Number,
        b if BINARY_TYPES.contains(&b) => Conversion::Binary,
        _ => Conversion::Text,
    }
}

/// NaN or Infinity in any spelling a Dialect returns (PostgreSQL `Infinity`, SQLite
/// `inf`, Rust `NaN`), as PostgreSQL spells it.
fn pg_float_word(s: &str) -> Option<&'static str> {
    let lower = s.to_ascii_lowercase();
    let (negative, word) = match lower.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, lower.strip_prefix('+').unwrap_or(&lower)),
    };
    match (word, negative) {
        ("nan", _) => Some("NaN"),
        ("inf" | "infinity", false) => Some("Infinity"),
        ("inf" | "infinity", true) => Some("-Infinity"),
        _ => None,
    }
}

/// Whether `v` is NaN or Infinity, which only PostgreSQL floats can hold.
pub fn is_float_word(v: &Value) -> bool {
    match v {
        Value::Number(s) | Value::Text(s) => pg_float_word(s.trim()).is_some(),
        _ => false,
    }
}

/// A value as a refusal message shows it: at most 40 characters.
fn shown(s: &str) -> String {
    match s.char_indices().nth(40) {
        Some((at, _)) => format!("{}...", &s[..at]),
        None => s.to_string(),
    }
}

/// Text as a literal. Text holding a NUL goes through hex, which MySQL's client and
/// SQLite's parser both take; PostgreSQL text cannot hold one.
fn text_literal(kind: DialectKind, s: &str) -> String {
    if s.contains('\0') {
        match kind {
            DialectKind::MySql => return format!("_utf8mb4 X'{}'", hex_lower(s.as_bytes())),
            DialectKind::Sqlite => return format!("CAST(X'{}' AS TEXT)", hex_lower(s.as_bytes())),
            DialectKind::Postgres => {}
        }
    }
    sql_string(kind, s)
}

/// WKT through `ST_GeomFromText`, with the value's own `SRID=n;` if it has one, else
/// the column's SRID.
fn geometry_literal(kind: DialectKind, srid: Option<u32>, s: &str) -> String {
    let own = s
        .strip_prefix("SRID=")
        .and_then(|rest| rest.split_once(';'))
        .and_then(|(n, wkt)| n.parse::<u32>().ok().map(|n| (n, wkt)));
    let (srid, wkt) = match own {
        Some((n, wkt)) => (Some(n), wkt),
        None => (srid, s),
    };
    match srid {
        Some(n) => format!("ST_GeomFromText({}, {n})", sql_string(kind, wkt)),
        None => format!("ST_GeomFromText({})", sql_string(kind, wkt)),
    }
}

fn bool_value_literal(kind: DialectKind, conv: Conversion, b: bool) -> String {
    match conv {
        Conversion::Text | Conversion::Json | Conversion::Geometry { .. } => {
            sql_string(kind, if b { "true" } else { "false" })
        }
        Conversion::Number => (if b { "1" } else { "0" }).into(),
        Conversion::Bool | Conversion::Binary => bool_literal(kind, b).into(),
    }
}

fn bytes_literal(kind: DialectKind, bytes: &[u8]) -> String {
    match kind {
        // `decode` reads the same whatever `standard_conforming_strings` says.
        DialectKind::Postgres => format!("decode('{}', 'hex')", hex_lower(bytes)),
        DialectKind::MySql | DialectKind::Sqlite => format!("X'{}'", hex_lower(bytes)),
    }
}

fn bool_literal(kind: DialectKind, b: bool) -> &'static str {
    match (kind, b) {
        (DialectKind::Postgres, true) => "TRUE",
        (DialectKind::Postgres, false) => "FALSE",
        (_, true) => "1",
        (_, false) => "0",
    }
}

fn parse_bool(s: &str) -> Option<bool> {
    match s.trim().to_ascii_lowercase().as_str() {
        "true" | "t" | "1" | "yes" | "y" | "on" => Some(true),
        "false" | "f" | "0" | "no" | "n" | "off" => Some(false),
        _ => None,
    }
}

/// `0x` and an even number of hex digits, as D10 writes bytes.
fn hex_text(s: &str) -> Option<Vec<u8>> {
    let digits = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X"))?;
    crate::common::decode_hex(digits).ok()
}

/// One value as a SQL literal for a column converted by `conv`.
pub fn literal(kind: DialectKind, conv: Conversion, v: &Value) -> Result<String> {
    let s = match v {
        Value::Null => return Ok("NULL".into()),
        Value::Bytes(b) => return Ok(bytes_literal(kind, b)),
        Value::Bool(b) => return Ok(bool_value_literal(kind, conv, *b)),
        Value::Number(s) | Value::Text(s) => s,
    };
    match conv {
        Conversion::Text | Conversion::Json => Ok(text_literal(kind, s)),
        Conversion::Geometry { srid } => Ok(geometry_literal(kind, srid, s)),
        Conversion::Number => {
            let t = s.trim();
            if is_number(t) {
                return Ok(t.to_string());
            }
            if kind == DialectKind::Postgres
                && let Some(word) = pg_float_word(t)
            {
                return Ok(format!("'{word}'::float8"));
            }
            Err(Error::InvalidInput(format!(
                "{} is not a number.",
                shown(s)
            )))
        }
        Conversion::Bool => {
            if let Some(b) = parse_bool(s) {
                return Ok(bool_literal(kind, b).to_string());
            }
            // A MySQL tinyint(1) or a SQLite BOOLEAN holds any number.
            let t = s.trim();
            if kind != DialectKind::Postgres && is_number(t) {
                return Ok(t.to_string());
            }
            Err(Error::InvalidInput(format!(
                "{} is not true or false.",
                shown(s)
            )))
        }
        Conversion::Binary => Ok(match hex_text(s) {
            Some(bytes) => bytes_literal(kind, &bytes),
            None => text_literal(kind, s),
        }),
    }
}

/// One value as an export writes it: never refused, never coerced. A value
/// outside its column's usual form (`2` in a `tinyint(1)`, `''` in a SQLite INTEGER,
/// `yes` in a SQLite BOOLEAN) is written as it is stored: a number bare, anything else
/// as text. NaN and Infinity follow Q32b on PostgreSQL; the SQL writer turns them into
/// NULL elsewhere.
pub fn literal_as_stored(kind: DialectKind, conv: Conversion, v: &Value) -> String {
    let s = match v {
        Value::Null => return "NULL".into(),
        Value::Bytes(b) => return bytes_literal(kind, b),
        Value::Bool(b) => return bool_value_literal(kind, conv, *b),
        Value::Number(s) | Value::Text(s) => s,
    };
    match conv {
        Conversion::Geometry { srid } => geometry_literal(kind, srid, s),
        Conversion::Number | Conversion::Bool => {
            if is_number(s) {
                return s.clone();
            }
            if kind == DialectKind::Postgres
                && matches!(v, Value::Number(_))
                && let Some(word) = pg_float_word(s)
            {
                return format!("'{word}'::float8");
            }
            text_literal(kind, s)
        }
        Conversion::Text | Conversion::Json | Conversion::Binary => text_literal(kind, s),
    }
}

/// One VALUES row, `(a, b)`, exactly as `InsertBuilder::push` writes it; a refused
/// value is the error.
pub fn row_text(kind: DialectKind, conversions: &[Conversion], row: &[Value]) -> Result<String> {
    row_literals(kind, conversions, row, false)
}

fn row_literals(
    kind: DialectKind,
    conversions: &[Conversion],
    row: &[Value],
    as_stored: bool,
) -> Result<String> {
    if row.len() != conversions.len() {
        return Err(Error::InvalidInput(format!(
            "a row has {} values; the INSERT has {} columns",
            row.len(),
            conversions.len()
        )));
    }
    let mut text = String::from("(");
    for (i, (v, conv)) in row.iter().zip(conversions).enumerate() {
        if i > 0 {
            text.push_str(", ");
        }
        if as_stored {
            text.push_str(&literal_as_stored(kind, *conv, v));
        } else {
            text.push_str(&literal(kind, *conv, v)?);
        }
    }
    text.push(')');
    Ok(text)
}

/// When a statement is cut: before the next row would pass either limit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InsertLimits {
    pub rows: usize,
    pub bytes: usize,
}

impl Default for InsertLimits {
    fn default() -> Self {
        Self {
            rows: 500,
            bytes: 1024 * 1024,
        }
    }
}

/// One finished INSERT, without a trailing `;`. `first_row` is the file row (or source
/// row) of its first VALUES row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuiltStatement {
    pub sql: String,
    pub rows: u64,
    pub first_row: u64,
}

/// Gathers rows into multi-row INSERT statements.
pub struct InsertBuilder {
    kind: DialectKind,
    conversions: Vec<Conversion>,
    limits: InsertLimits,
    head: String,
    sql: String,
    rows: u64,
    first_row: u64,
    /// Values as they are stored (exports), not checked (imports).
    as_stored: bool,
}

impl InsertBuilder {
    /// `table_sql` is the table as it goes after INTO, already quoted. `overriding` adds
    /// `OVERRIDING SYSTEM VALUE` on PostgreSQL (a value for an ALWAYS identity column).
    pub fn new(
        kind: DialectKind,
        table_sql: String,
        columns: &[String],
        conversions: Vec<Conversion>,
        limits: InsertLimits,
        overriding: bool,
    ) -> Self {
        debug_assert_eq!(columns.len(), conversions.len());
        let names: Vec<String> = columns.iter().map(|c| sql_ident(kind, c)).collect();
        let overriding = if overriding && kind == DialectKind::Postgres {
            " OVERRIDING SYSTEM VALUE"
        } else {
            ""
        };
        let head = format!(
            "INSERT INTO {table_sql} ({}){overriding} VALUES",
            names.join(", ")
        );
        Self {
            kind,
            conversions,
            limits: InsertLimits {
                rows: limits.rows.max(1),
                bytes: limits.bytes,
            },
            head,
            sql: String::new(),
            rows: 0,
            first_row: 0,
            as_stored: false,
        }
    }

    /// Writes values as they are stored (`literal_as_stored`), for exports.
    pub fn as_stored(mut self) -> Self {
        self.as_stored = true;
        self
    }

    /// The bytes of the statement still open.
    pub fn open_bytes(&self) -> usize {
        self.sql.len()
    }

    /// `INSERT INTO t (a, b) VALUES`, the part every statement shares.
    pub fn head(&self) -> &str {
        &self.head
    }

    /// Adds a row. Returns the statement it closed when this row would have passed a
    /// limit; the row then starts the next statement. A refused value adds nothing.
    pub fn push(&mut self, row: &[Value], file_row: u64) -> Result<Option<BuiltStatement>> {
        let text = row_literals(self.kind, &self.conversions, row, self.as_stored)?;
        // ",\n" joins a row to the one before it.
        let full = self.rows > 0
            && (self.rows as usize >= self.limits.rows
                || self.sql.len() + 2 + text.len() > self.limits.bytes);
        let done = if full { self.finish() } else { None };
        if self.rows == 0 {
            self.sql.push_str(&self.head);
            self.sql.push('\n');
            self.first_row = file_row;
        } else {
            self.sql.push_str(",\n");
        }
        self.sql.push_str(&text);
        self.rows += 1;
        Ok(done)
    }

    /// The statement still open, if it holds any rows.
    pub fn finish(&mut self) -> Option<BuiltStatement> {
        if self.rows == 0 {
            return None;
        }
        let rows = std::mem::take(&mut self.rows);
        Some(BuiltStatement {
            sql: std::mem::take(&mut self.sql),
            rows,
            first_row: self.first_row,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MY: DialectKind = DialectKind::MySql;
    const PG: DialectKind = DialectKind::Postgres;
    const LITE: DialectKind = DialectKind::Sqlite;
    const ALL: [DialectKind; 3] = [MY, PG, LITE];

    fn text(s: &str) -> Value {
        Value::Text(s.into())
    }
    fn num(s: &str) -> Value {
        Value::Number(s.into())
    }

    fn builder(kind: DialectKind, limits: InsertLimits) -> InsertBuilder {
        InsertBuilder::new(
            kind,
            sql_ident(kind, "t"),
            &["id".to_string(), "name".to_string()],
            vec![Conversion::Number, Conversion::Text],
            limits,
            false,
        )
    }

    #[test]
    fn conversion_for_types() {
        let cases: Vec<(DialectKind, &str, Conversion)> = vec![
            (PG, "integer", Conversion::Number),
            (PG, "bigint", Conversion::Number),
            (PG, "numeric(10,2)", Conversion::Number),
            (PG, "double precision", Conversion::Number),
            (PG, "boolean", Conversion::Bool),
            (PG, "bytea", Conversion::Binary),
            (PG, "jsonb", Conversion::Json),
            (PG, "json", Conversion::Json),
            (PG, "integer[]", Conversion::Text),
            (PG, "_int4", Conversion::Text),
            (PG, "text", Conversion::Text),
            (PG, "timestamp with time zone", Conversion::Text),
            (PG, "bit(4)", Conversion::Text),
            (MY, "int(11)", Conversion::Number),
            (MY, "bigint unsigned", Conversion::Number),
            (MY, "decimal(12,4)", Conversion::Number),
            (MY, "tinyint(1)", Conversion::Bool),
            (MY, "tinyint(4)", Conversion::Number),
            (MY, "bit(8)", Conversion::Number),
            (MY, "varbinary(16)", Conversion::Binary),
            (MY, "longblob", Conversion::Binary),
            (MY, "json", Conversion::Json),
            (MY, "varchar(20)", Conversion::Text),
            (MY, "datetime", Conversion::Text),
            (LITE, "INTEGER", Conversion::Number),
            (LITE, "BLOB", Conversion::Binary),
            (LITE, "BOOLEAN", Conversion::Bool),
            (LITE, "", Conversion::Text),
            (LITE, "TEXT", Conversion::Text),
        ];
        for (kind, ty, want) in cases {
            assert_eq!(conversion_for(kind, ty), want, "{kind:?} {ty}");
        }
    }

    #[test]
    fn quotes_backslashes_unicode() {
        let v = text(r"it's a\b ñ 表");
        assert_eq!(
            literal(MY, Conversion::Text, &v).unwrap(),
            format!("_utf8mb4 X'{}'", hex_lower(r"it's a\b ñ 表".as_bytes()))
        );
        assert_eq!(
            literal(PG, Conversion::Text, &v).unwrap(),
            r"E'it''s a\\b ñ 表'"
        );
        assert_eq!(
            literal(LITE, Conversion::Text, &v).unwrap(),
            r"'it''s a\b ñ 表'"
        );
        for kind in ALL {
            assert_eq!(
                literal(kind, Conversion::Text, &text("plain 'q'")).unwrap(),
                "'plain ''q'''"
            );
            assert_eq!(
                literal(kind, Conversion::Json, &text(r#"{"a":1}"#)).unwrap(),
                r#"'{"a":1}'"#
            );
        }
    }

    #[test]
    fn binary_per_dialect() {
        let v = Value::Bytes(vec![0, 0xab, 0xff]);
        assert_eq!(literal(MY, Conversion::Binary, &v).unwrap(), "X'00abff'");
        assert_eq!(literal(LITE, Conversion::Binary, &v).unwrap(), "X'00abff'");
        // never '\x..'::bytea, which misreads when standard_conforming_strings is off.
        assert_eq!(
            literal(PG, Conversion::Binary, &v).unwrap(),
            "decode('00abff', 'hex')"
        );
        assert_eq!(
            literal(PG, Conversion::Binary, &Value::Bytes(vec![])).unwrap(),
            "decode('', 'hex')"
        );
        // Bytes keep their binary form whatever the column says.
        assert_eq!(literal(MY, Conversion::Text, &v).unwrap(), "X'00abff'");
        // text starting 0x going into a binary column is hex.
        assert_eq!(
            literal(MY, Conversion::Binary, &text("0x00ABff")).unwrap(),
            "X'00abff'"
        );
        assert_eq!(
            literal(PG, Conversion::Binary, &text("0x0a")).unwrap(),
            "decode('0a', 'hex')"
        );
        // Other text goes in as text, and the server converts it.
        assert_eq!(
            literal(LITE, Conversion::Binary, &text("0xzz")).unwrap(),
            "'0xzz'"
        );
    }

    #[test]
    fn booleans_per_dialect() {
        let cases: Vec<(DialectKind, Value, &str)> = vec![
            (PG, Value::Bool(true), "TRUE"),
            (PG, Value::Bool(false), "FALSE"),
            (MY, Value::Bool(true), "1"),
            (MY, Value::Bool(false), "0"),
            (LITE, Value::Bool(true), "1"),
            (LITE, Value::Bool(false), "0"),
            (PG, text("t"), "TRUE"),
            (PG, text("False"), "FALSE"),
            (MY, num("1"), "1"),
            (MY, num("0"), "0"),
            (LITE, text("true"), "1"),
            (PG, text("yes"), "TRUE"),
            (MY, text("no"), "0"),
            // The import checks take on and off too.
            (PG, text("on"), "TRUE"),
            (MY, text("OFF"), "0"),
        ];
        for (kind, v, want) in cases {
            assert_eq!(
                literal(kind, Conversion::Bool, &v).unwrap(),
                want,
                "{kind:?} {v:?}"
            );
        }
        let err = literal(PG, Conversion::Bool, &text("maybe")).unwrap_err();
        assert!(
            matches!(&err, Error::InvalidInput(m) if m == "maybe is not true or false."),
            "{err:?}"
        );
        // A boolean into a number column is 1 or 0.
        assert_eq!(
            literal(PG, Conversion::Number, &Value::Bool(true)).unwrap(),
            "1"
        );
    }

    #[test]
    fn null() {
        for kind in ALL {
            for conv in [
                Conversion::Text,
                Conversion::Number,
                Conversion::Bool,
                Conversion::Binary,
                Conversion::Json,
            ] {
                assert_eq!(literal(kind, conv, &Value::Null).unwrap(), "NULL");
            }
        }
    }

    #[test]
    fn numbers_refused_by_grammar() {
        for kind in ALL {
            for ok in ["12", "-1.50", "+3", "1e5", "00123", "2.5E-3"] {
                assert_eq!(literal(kind, Conversion::Number, &num(ok)).unwrap(), ok);
            }
            assert_eq!(
                literal(kind, Conversion::Number, &text(" 42 ")).unwrap(),
                "42"
            );
            for bad in ["12,50", "n/a", "", "1.", ".5", "0x1f", "1;DROP TABLE t"] {
                let err = literal(kind, Conversion::Number, &text(bad)).unwrap_err();
                let want = format!("{bad} is not a number.");
                assert!(
                    matches!(&err, Error::InvalidInput(m) if *m == want),
                    "{kind:?} {bad}: {err:?}"
                );
            }
        }
        // PostgreSQL floats keep NaN and Infinity, as typed literals.
        assert_eq!(
            literal(PG, Conversion::Number, &num("NaN")).unwrap(),
            "'NaN'::float8"
        );
        assert_eq!(
            literal(PG, Conversion::Number, &num("-infinity")).unwrap(),
            "'-Infinity'::float8"
        );
        assert_eq!(
            literal(PG, Conversion::Text, &num("Infinity")).unwrap(),
            "'Infinity'"
        );
        assert!(literal(MY, Conversion::Number, &num("NaN")).is_err());
    }

    #[test]
    fn statement_text() {
        let mut b = builder(PG, InsertLimits::default());
        assert_eq!(b.head(), r#"INSERT INTO "t" ("id", "name") VALUES"#);
        assert!(b.push(&[num("1"), text("a")], 1).unwrap().is_none());
        assert!(b.push(&[num("2"), Value::Null], 2).unwrap().is_none());
        let s = b.finish().unwrap();
        assert_eq!(
            s.sql,
            "INSERT INTO \"t\" (\"id\", \"name\") VALUES\n(1, 'a'),\n(2, NULL)"
        );
        assert_eq!((s.rows, s.first_row), (2, 1));
        assert!(b.finish().is_none());
    }

    #[test]
    fn row_text_is_the_pushed_row() {
        let conv = [Conversion::Number, Conversion::Text];
        assert_eq!(
            row_text(PG, &conv, &[num("1"), text("a,\nb")]).unwrap(),
            "(1, 'a,\nb')"
        );
        let mut b = builder(PG, InsertLimits::default());
        b.push(&[num("1"), text("a,\nb")], 1).unwrap();
        assert!(b.finish().unwrap().sql.ends_with("(1, 'a,\nb')"));
        assert!(row_text(PG, &conv, &[text("x"), text("a")]).is_err());
    }

    #[test]
    fn refused_value_adds_nothing() {
        let mut b = builder(MY, InsertLimits::default());
        b.push(&[num("1"), text("a")], 1).unwrap();
        assert!(b.push(&[text("n/a"), text("b")], 2).is_err());
        let err = b.push(&[num("3")], 3).unwrap_err();
        assert!(matches!(err, Error::InvalidInput(_)));
        let s = b.finish().unwrap();
        assert_eq!(s.rows, 1);
        assert_eq!(s.sql, "INSERT INTO `t` (`id`, `name`) VALUES\n(1, 'a')");
    }

    #[test]
    fn cut_by_rows() {
        let mut b = builder(LITE, InsertLimits::default());
        let mut built = Vec::new();
        for i in 1..=1_200u64 {
            if let Some(s) = b.push(&[num(&i.to_string()), text("x")], i).unwrap() {
                built.push(s);
            }
        }
        built.extend(b.finish());
        let shape: Vec<(u64, u64)> = built.iter().map(|s| (s.rows, s.first_row)).collect();
        assert_eq!(shape, vec![(500, 1), (500, 501), (200, 1001)]);
        assert!(built[1].sql.contains("\n(501, 'x'),"));
        assert!(built[1].sql.ends_with("(1000, 'x')"));
    }

    #[test]
    fn cut_by_bytes() {
        let limits = InsertLimits::default();
        let mut b = builder(PG, limits);
        let cell = "y".repeat(300 * 1024);
        let mut built = Vec::new();
        for i in 1..=7u64 {
            if let Some(s) = b.push(&[num(&i.to_string()), text(&cell)], i).unwrap() {
                built.push(s);
            }
        }
        built.extend(b.finish());
        // Three 300 KB rows fit under 1 MiB; a fourth would pass it.
        let shape: Vec<(u64, u64)> = built.iter().map(|s| (s.rows, s.first_row)).collect();
        assert_eq!(shape, vec![(3, 1), (3, 4), (1, 7)]);
        for s in &built {
            assert!(s.sql.len() <= limits.bytes, "{}", s.sql.len());
        }

        // One huge row is a statement of its own.
        let mut b = builder(PG, limits);
        let huge = "z".repeat(2 * 1024 * 1024);
        assert!(b.push(&[num("1"), text("a")], 1).unwrap().is_none());
        let s = b.push(&[num("2"), text(&huge)], 2).unwrap().unwrap();
        assert_eq!((s.rows, s.first_row), (1, 1));
        let s = b.push(&[num("3"), text("c")], 3).unwrap().unwrap();
        assert_eq!((s.rows, s.first_row), (1, 2));
        assert!(s.sql.len() > limits.bytes);
        let s = b.finish().unwrap();
        assert_eq!((s.rows, s.first_row), (1, 3));
    }

    #[test]
    fn same_input_same_text() {
        let rows: Vec<Vec<Value>> = (0..50)
            .map(|i| vec![num(&i.to_string()), text(&format!("r'{i}\\"))])
            .collect();
        for kind in ALL {
            let run = || {
                let mut b = builder(
                    kind,
                    InsertLimits {
                        rows: 7,
                        bytes: 1024 * 1024,
                    },
                );
                let mut out = Vec::new();
                for (i, r) in rows.iter().enumerate() {
                    out.extend(b.push(r, i as u64 + 1).unwrap());
                }
                out.extend(b.finish());
                out
            };
            assert_eq!(run(), run());
        }
    }

    #[test]
    fn overriding_system_value_on_postgres() {
        let cols = ["id".to_string()];
        let pg = InsertBuilder::new(
            PG,
            "\"public\".\"t\"".into(),
            &cols,
            vec![Conversion::Number],
            InsertLimits::default(),
            true,
        );
        assert_eq!(
            pg.head(),
            r#"INSERT INTO "public"."t" ("id") OVERRIDING SYSTEM VALUE VALUES"#
        );
        for kind in [MY, LITE] {
            let b = InsertBuilder::new(
                kind,
                sql_ident(kind, "t"),
                &cols,
                vec![Conversion::Number],
                InsertLimits::default(),
                true,
            );
            assert!(!b.head().contains("OVERRIDING"), "{kind:?}");
        }
    }

    #[test]
    fn hostile_column_names_quoted() {
        let cols: Vec<String> = ["a\"b", "a`b", "order", "Odd Name"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let conv = vec![Conversion::Text; 4];
        let head = |kind| {
            InsertBuilder::new(
                kind,
                sql_ident(kind, "t"),
                &cols,
                conv.clone(),
                InsertLimits::default(),
                false,
            )
            .head()
            .to_string()
        };
        assert_eq!(
            head(PG),
            r#"INSERT INTO "t" ("a""b", "a`b", "order", "Odd Name") VALUES"#
        );
        assert_eq!(
            head(LITE),
            r#"INSERT INTO "t" ("a""b", "a`b", "order", "Odd Name") VALUES"#
        );
        assert_eq!(
            head(MY),
            "INSERT INTO `t` (`a\"b`, `a``b`, `order`, `Odd Name`) VALUES"
        );
    }

    #[test]
    fn conversion_for_geometry() {
        let cases: Vec<(DialectKind, &str, Conversion)> = vec![
            (MY, "point", Conversion::Geometry { srid: None }),
            (MY, "geometry", Conversion::Geometry { srid: None }),
            (MY, "multipolygon", Conversion::Geometry { srid: None }),
            (MY, "geomcollection", Conversion::Geometry { srid: None }),
            (
                MY,
                "point srid 4326",
                Conversion::Geometry { srid: Some(4326) },
            ),
            (
                MY,
                "POINT /*!80003 SRID 3857 */",
                Conversion::Geometry { srid: Some(3857) },
            ),
            // PostGIS text is hex EWKB, which loads back as text.
            (PG, "geometry", Conversion::Text),
            (PG, "point", Conversion::Text),
            (LITE, "POINT", Conversion::Text),
        ];
        for (kind, ty, want) in cases {
            assert_eq!(conversion_for(kind, ty), want, "{kind:?} {ty}");
        }
    }

    #[test]
    fn geometry_literal() {
        let geo = |srid| Conversion::Geometry { srid };
        assert_eq!(
            literal(MY, geo(Some(4326)), &text("POINT(1 2)")).unwrap(),
            "ST_GeomFromText('POINT(1 2)', 4326)"
        );
        assert_eq!(
            literal_as_stored(MY, geo(Some(4326)), &text("POINT(1 2)")),
            "ST_GeomFromText('POINT(1 2)', 4326)"
        );
        // A value read with its own SRID (`SRID=n;` before the WKT) keeps it.
        assert_eq!(
            literal(MY, geo(None), &text("SRID=3857;POINT(1 2)")).unwrap(),
            "ST_GeomFromText('POINT(1 2)', 3857)"
        );
        assert_eq!(
            literal(MY, geo(None), &text("LINESTRING(0 0,1 1)")).unwrap(),
            "ST_GeomFromText('LINESTRING(0 0,1 1)')"
        );
        assert_eq!(literal(MY, geo(Some(4326)), &Value::Null).unwrap(), "NULL");
    }

    #[test]
    fn values_as_stored() {
        let cases: Vec<(DialectKind, Conversion, Value, &str)> = vec![
            (MY, Conversion::Bool, num("2"), "2"),
            (MY, Conversion::Bool, num("-1"), "-1"),
            (MY, Conversion::Bool, num("1"), "1"),
            (LITE, Conversion::Number, text(""), "''"),
            (LITE, Conversion::Number, text(" 5"), "' 5'"),
            (LITE, Conversion::Number, text("12,50"), "'12,50'"),
            (LITE, Conversion::Bool, text("yes"), "'yes'"),
            (LITE, Conversion::Bool, num("2"), "2"),
            (LITE, Conversion::Binary, text("0xab"), "'0xab'"),
            (PG, Conversion::Bool, Value::Bool(true), "TRUE"),
            (PG, Conversion::Number, num("1.50"), "1.50"),
            (PG, Conversion::Number, num("inf"), "'Infinity'::float8"),
            (MY, Conversion::Binary, Value::Bytes(vec![1]), "X'01'"),
            (LITE, Conversion::Text, Value::Null, "NULL"),
        ];
        for (kind, conv, v, want) in cases {
            assert_eq!(
                literal_as_stored(kind, conv, &v),
                want,
                "{kind:?} {conv:?} {v:?}"
            );
        }
        // The import keeps its checks, but takes a number into tinyint(1) and SQLite
        // BOOLEAN as it is.
        assert_eq!(literal(MY, Conversion::Bool, &num("2")).unwrap(), "2");
        assert_eq!(literal(LITE, Conversion::Bool, &num("2")).unwrap(), "2");
        assert!(literal(PG, Conversion::Bool, &num("2")).is_err());
        assert!(literal(LITE, Conversion::Number, &text("")).is_err());
    }

    #[test]
    fn builder_as_stored() {
        let mut b = InsertBuilder::new(
            LITE,
            "\"t\"".into(),
            &["n".to_string()],
            vec![Conversion::Number],
            InsertLimits::default(),
            false,
        )
        .as_stored();
        assert!(b.push(&[text("")], 1).unwrap().is_none());
        assert!(b.push(&[text("n/a")], 2).unwrap().is_none());
        assert_eq!(
            b.finish().unwrap().sql,
            "INSERT INTO \"t\" (\"n\") VALUES\n(''),\n('n/a')"
        );
    }

    #[test]
    fn all_float_words() {
        for (word, pg) in [
            ("inf", "Infinity"),
            ("+inf", "Infinity"),
            ("-inf", "-Infinity"),
            ("INF", "Infinity"),
            ("infinity", "Infinity"),
            ("+Infinity", "Infinity"),
            ("-infinity", "-Infinity"),
            ("nan", "NaN"),
            ("NaN", "NaN"),
            ("-nan", "NaN"),
        ] {
            assert!(is_float_word(&num(word)), "{word}");
            assert_eq!(
                literal(PG, Conversion::Number, &num(word)).unwrap(),
                format!("'{pg}'::float8"),
                "{word}"
            );
        }
        for not in ["info", "in", "nano", "1e999", ""] {
            assert!(!is_float_word(&num(not)), "{not}");
        }
    }

    #[test]
    fn nul_text_goes_through_hex() {
        let v = text("a\0b");
        assert_eq!(
            literal(MY, Conversion::Text, &v).unwrap(),
            "_utf8mb4 X'610062'"
        );
        assert_eq!(
            literal(LITE, Conversion::Text, &v).unwrap(),
            "CAST(X'610062' AS TEXT)"
        );
        assert_eq!(
            literal_as_stored(LITE, Conversion::Text, &v),
            "CAST(X'610062' AS TEXT)"
        );
    }

    #[test]
    fn long_values_are_cut_in_messages() {
        let long = "x".repeat(100);
        let err = literal(PG, Conversion::Number, &text(&long)).unwrap_err();
        let want = format!("{}... is not a number.", "x".repeat(40));
        assert!(
            matches!(&err, Error::InvalidInput(m) if *m == want),
            "{err:?}"
        );
    }
}
