//! Per-Dialect normalisers: two spellings of one type, default or name give the
//! same text, so `diff` reports only real differences. Pure functions.

use crate::model::DialectKind;
use crate::schema_model::{SmColumn, SmDefault, parse_sql_default};
use crate::transfer::{SqlType, parse_type};

/// What kind of name is folded: the Dialects fold them differently.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NameKind {
    Schema,
    Table,
    Column,
    Index,
    Enum,
}

/// A name as the Dialect compares it. PostgreSQL compares names exactly, as a
/// quoted name reads. MySQL folds column and index names always, and schema and
/// table names when `lower_case_table_names` is not 0 (as read from the server).
/// SQLite folds every name (ASCII only, as SQLite does).
pub fn fold_name(
    dialect: DialectKind,
    kind: NameKind,
    name: &str,
    lower_case_table_names: u8,
) -> String {
    match dialect {
        DialectKind::Postgres => name.to_string(),
        DialectKind::MySql => match kind {
            NameKind::Schema | NameKind::Table if lower_case_table_names == 0 => name.to_string(),
            _ => name.to_lowercase(),
        },
        DialectKind::Sqlite => name.to_ascii_lowercase(),
    }
}

const MYSQL_INTS: &[&str] = &["tinyint", "smallint", "mediumint", "int", "bigint"];

/// A column type as one canonical text per Dialect: lower case, synonyms merged
/// (`int4` and `integer`, `bool` and `boolean`, `character varying` and
/// `varchar`, `timestamp with time zone` and `timestamptz`, `float8` and
/// `double precision`, `decimal` and `numeric`), MySQL display widths dropped
/// except `tinyint(1)`, and `serial` read as its integer type (see
/// [`implies_increment`]).
pub fn normalise_type(dialect: DialectKind, text: &str) -> String {
    let t = parse_type(text);
    let mut params: Vec<String> = t.params.iter().map(|p| p.trim().to_string()).collect();
    let mut unsigned = t.unsigned;
    // `parse_type` drops ZEROFILL; on MySQL it changes how values read, and keeps
    // the display width.
    let zerofill = dialect == DialectKind::MySql
        && text
            .split(|c: char| c.is_whitespace() || c == ')')
            .any(|w| w.eq_ignore_ascii_case("zerofill"));
    let base = match dialect {
        DialectKind::Postgres => {
            let base = match t.base.as_str() {
                "int" | "int4" | "integer" | "serial" | "serial4" => "integer",
                "int8" | "bigint" | "bigserial" | "serial8" => "bigint",
                "int2" | "smallint" | "smallserial" | "serial2" => "smallint",
                "bool" | "boolean" => "boolean",
                "varchar" | "character varying" => "varchar",
                "char" | "character" | "bpchar" => "char",
                "float8" | "double precision" => "double precision",
                "float4" | "real" => "real",
                "decimal" | "numeric" => "numeric",
                "varbit" | "bit varying" => "varbit",
                "float" => {
                    // `float(p)`: up to 24 bits is `real`, otherwise `double precision`.
                    let real = t.param_u32(0).is_some_and(|p| p <= 24);
                    params.clear();
                    if real { "real" } else { "double precision" }
                }
                other => other,
            };
            if base == "char" && params.is_empty() {
                params.push("1".into());
            }
            base.to_string()
        }
        DialectKind::MySql => {
            let base = match t.base.as_str() {
                "integer" | "int4" => "int",
                "int1" => "tinyint",
                "int2" => "smallint",
                "int3" | "middleint" => "mediumint",
                "int8" => "bigint",
                "bool" | "boolean" => {
                    params = vec!["1".into()];
                    "tinyint"
                }
                "dec" | "numeric" | "fixed" | "decimal" => "decimal",
                "double precision" | "real" | "float8" | "double" => "double",
                "float4" => "float",
                "character varying" => "varchar",
                "character" => "char",
                "serial" => {
                    unsigned = true;
                    "bigint"
                }
                other => other,
            };
            if MYSQL_INTS.contains(&base) && !zerofill && !(base == "tinyint" && params == ["1"]) {
                params.clear();
            }
            if base == "year" {
                params.clear();
            }
            if base == "decimal" {
                match params.len() {
                    0 => params = vec!["10".into(), "0".into()],
                    1 => params.push("0".into()),
                    _ => {}
                }
            }
            if (base == "char" || base == "binary") && params.is_empty() {
                params.push("1".into());
            }
            base.to_string()
        }
        DialectKind::Sqlite => match t.base.as_str() {
            "int" | "int4" | "integer" => "integer",
            "bool" | "boolean" => "boolean",
            "varchar" | "character varying" => "varchar",
            "float8" | "double precision" => "double precision",
            "decimal" | "numeric" => "numeric",
            other => other,
        }
        .to_string(),
    };
    let mut out = write_type(&SqlType {
        base,
        params,
        unsigned,
        array: t.array,
        with_tz: t.with_tz,
    });
    if zerofill {
        out.push_str(" zerofill");
    }
    out
}

fn write_type(t: &SqlType) -> String {
    let mut out = t.base.clone();
    if t.with_tz {
        if out == "timestamp" || out == "time" {
            out.push_str("tz");
        } else {
            out.push_str(" with time zone");
        }
    }
    if !t.params.is_empty() {
        out.push('(');
        out.push_str(&t.params.join(","));
        out.push(')');
    }
    if t.unsigned {
        out.push_str(" unsigned");
    }
    if t.array {
        out.push_str("[]");
    }
    out
}

/// Whether a type name itself means an increment: PostgreSQL `serial` and
/// `bigserial` (and `smallserial`), MySQL `serial`.
pub fn implies_increment(dialect: DialectKind, text: &str) -> bool {
    let base = parse_type(text).base;
    match dialect {
        DialectKind::Postgres => matches!(
            base.as_str(),
            "serial" | "serial4" | "bigserial" | "serial8" | "smallserial" | "serial2"
        ),
        DialectKind::MySql => base == "serial",
        DialectKind::Sqlite => false,
    }
}

/// A column default as one canonical text, or `None` when it means no default:
/// `NULL`, or `nextval(...)` of the column's own sequence (that is the increment).
/// `raw` is the default as SQL text, as PostgreSQL and SQLite report it; `table`
/// is the column's table, which names its own sequence.
pub fn normalise_default<'a>(
    dialect: DialectKind,
    table: impl Into<TableRef<'a>>,
    column: &SmColumn,
    raw: &str,
) -> Option<String> {
    default_key(dialect, table.into(), column, &parse_sql_default(raw))
}

/// [`normalise_default`] for a default already classified, as a Schema Model holds it.
/// Casts are dropped (`'draft'::character varying` is `'draft'`), `now()` is
/// `CURRENT_TIMESTAMP` (with MySQL's other spellings), numbers lose trailing
/// zeros, and on a numeric column a quoted number is the number.
pub fn default_key<'a>(
    dialect: DialectKind,
    table: impl Into<TableRef<'a>>,
    column: &SmColumn,
    default: &SmDefault,
) -> Option<String> {
    let ty = normalise_type(dialect, &column.type_name);
    let numeric = is_numeric(&ty);
    let boolean = ty == "boolean" || ty == "tinyint(1)";
    let bool_text = |b: bool| -> String {
        match (dialect, b) {
            (DialectKind::MySql, true) => "1".into(),
            (DialectKind::MySql, false) => "0".into(),
            (_, true) => "true".into(),
            (_, false) => "false".into(),
        }
    };
    match default {
        SmDefault::Null => None,
        SmDefault::Bool { value } => Some(bool_text(*value)),
        SmDefault::Number { value } => {
            let n = number_key(value);
            if boolean && (n == "0" || n == "1") {
                Some(bool_text(n == "1"))
            } else {
                Some(n)
            }
        }
        SmDefault::String { value } => {
            if numeric && value.trim().parse::<f64>().is_ok() {
                Some(number_key(value))
            } else {
                Some(quote(value))
            }
        }
        SmDefault::Expression { value } => expression_key(dialect, table.into(), column, value),
    }
}

/// Whether the column's default is `nextval(...)` of the column's own sequence,
/// which is how PostgreSQL reports a `serial` column: an increment, not a default.
/// Only the name PostgreSQL gives a serial's sequence counts
/// (`<table>_<column>_seq`, cut to 63 bytes as PostgreSQL cuts it); any other
/// sequence is a real default.
pub fn is_own_sequence_default<'a>(table: impl Into<TableRef<'a>>, column: &SmColumn) -> bool {
    match &column.default {
        Some(SmDefault::Expression { value }) => own_sequence(value, table.into(), &column.name),
        _ => false,
    }
}

/// A table by name, with its schema when known.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TableRef<'a> {
    pub schema: Option<&'a str>,
    pub name: &'a str,
}

impl<'a> From<&'a str> for TableRef<'a> {
    fn from(name: &'a str) -> Self {
        TableRef { schema: None, name }
    }
}

impl<'a> From<&'a String> for TableRef<'a> {
    fn from(name: &'a String) -> Self {
        TableRef {
            schema: None,
            name: name.as_str(),
        }
    }
}

/// The one rule for a serial's own sequence, used by the PostgreSQL snapshot,
/// `table_design` and the compare. `owned` is what a live server says (the
/// sequence is OWNED BY the column, R11) and decides alone, whatever the name.
/// Where ownership is unknown (a Schema Model, default text) the sequence is
/// named `<table>_<column>_seq` (cut as PostgreSQL cuts it), and when both the
/// sequence's schema and the table's are known they are the same; an
/// unqualified name resolves through the search path, so it counts as own.
pub fn is_own_sequence(
    table: TableRef<'_>,
    column: &str,
    sequence_schema: Option<&str>,
    sequence: &str,
    owned: Option<bool>,
) -> bool {
    if let Some(owned) = owned {
        return owned;
    }
    sequence == serial_sequence_name(table.name, column)
        && match (sequence_schema, table.schema) {
            (Some(s), Some(t)) => s == t,
            _ => true,
        }
}

fn own_sequence(expr: &str, table: TableRef<'_>, column: &str) -> bool {
    nextval_parts(expr)
        .is_some_and(|(schema, seq)| is_own_sequence(table, column, schema.as_deref(), &seq, None))
}

/// The sequence `nextval('...')` reads, without its schema and quotes.
fn nextval_sequence(expr: &str) -> Option<String> {
    nextval_parts(expr).map(|(_, name)| name)
}

/// The sequence `nextval('...')` reads, as its schema (when written) and name.
fn nextval_parts(expr: &str) -> Option<(Option<String>, String)> {
    let e = expr.trim();
    if !e.to_ascii_lowercase().starts_with("nextval(") {
        return None;
    }
    let open = e.find('\'')?;
    let rest = &e[open + 1..];
    let mut text = String::new();
    let mut chars = rest.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\'' {
            if chars.peek() == Some(&'\'') {
                chars.next();
                text.push('\'');
                continue;
            }
            let mut parts = ident_parts(&text);
            let name = parts.pop().unwrap_or_default();
            return Some((parts.pop(), name));
        }
        text.push(c);
    }
    None
}

/// The parts of a dotted name, quotes removed: `billing."Inv_id_seq"` is
/// `billing`, `Inv_id_seq`.
fn ident_parts(name: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut chars = name.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                chars.next();
                current.push('"');
            }
            '"' => quoted = !quoted,
            '.' if !quoted => parts.push(std::mem::take(&mut current)),
            _ => current.push(c),
        }
    }
    parts.push(current);
    parts
}

/// The sequence name PostgreSQL makes for a serial column: `<table>_<column>_seq`,
/// with the longer of the two names shortened until it fits in 63 bytes.
pub(crate) fn serial_sequence_name(table: &str, column: &str) -> String {
    const MAX: usize = 63;
    let avail = MAX - "seq".len() - 2;
    let (mut n1, mut n2) = (table.len(), column.len());
    while n1 + n2 > avail {
        if n1 > n2 {
            n1 -= 1;
        } else {
            n2 -= 1;
        }
    }
    let clip = |s: &str, mut n: usize| {
        while !s.is_char_boundary(n) {
            n -= 1;
        }
        s[..n].to_string()
    };
    format!("{}_{}_seq", clip(table, n1), clip(column, n2))
}

fn expression_key(
    dialect: DialectKind,
    table: TableRef<'_>,
    column: &SmColumn,
    value: &str,
) -> Option<String> {
    if own_sequence(value, table, &column.name) {
        return None;
    }
    // Another sequence is a real default, named without its schema so the
    // same sequence in two schemas reads alike.
    if let Some(seq) = nextval_sequence(value) {
        return Some(format!("NEXTVAL({})", quote(&seq)));
    }
    let mut e = value.trim().to_string();
    loop {
        let unwrapped = strip_outer_parens(&e);
        match strip_cast(&unwrapped) {
            Some(rest) => e = rest,
            None => {
                e = unwrapped;
                break;
            }
        }
    }
    // What is left may be a plain literal, such as `'draft'` or `-1`.
    match parse_sql_default(&e) {
        SmDefault::Expression { .. } => {}
        other => return default_key(dialect, table, column, &other),
    }
    let upper = upper_outside_quotes(&e);
    Some(time_function(dialect, &upper).unwrap_or(upper))
}

/// `now()` and the other spellings of the current time as `CURRENT_TIMESTAMP`,
/// keeping a precision (`CURRENT_TIMESTAMP(6)`).
fn time_function(dialect: DialectKind, upper: &str) -> Option<String> {
    let (name, args) = match upper.find('(') {
        Some(at) if upper.ends_with(')') => {
            (&upper[..at], Some(upper[at + 1..upper.len() - 1].trim()))
        }
        _ => (upper, None),
    };
    let name = name.trim();
    let timestamp = match dialect {
        DialectKind::MySql => matches!(
            name,
            "NOW" | "CURRENT_TIMESTAMP" | "LOCALTIMESTAMP" | "LOCALTIME"
        ),
        DialectKind::Postgres => {
            matches!(name, "CURRENT_TIMESTAMP" | "TRANSACTION_TIMESTAMP")
                || (name == "NOW" && args.is_some())
        }
        DialectKind::Sqlite => name == "CURRENT_TIMESTAMP",
    };
    if timestamp {
        // `NOW` without parentheses is a column name, not the function.
        if name == "NOW" && args.is_none() {
            return None;
        }
        return Some(match args {
            Some(p) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => {
                format!("CURRENT_TIMESTAMP({p})")
            }
            _ => "CURRENT_TIMESTAMP".into(),
        });
    }
    if dialect == DialectKind::MySql && matches!(name, "CURDATE" | "CURRENT_DATE") {
        return Some("CURRENT_DATE".into());
    }
    None
}

/// `(x)` as `x` when the parentheses wrap the whole text, repeatedly.
fn strip_outer_parens(text: &str) -> String {
    let mut e = text.trim().to_string();
    while e.starts_with('(') && closing_paren(&e) == Some(e.len() - 1) {
        e = e[1..e.len() - 1].trim().to_string();
    }
    e
}

/// The byte index of the `)` matching the `(` at index 0, quotes respected.
fn closing_paren(text: &str) -> Option<usize> {
    let mut depth = 0usize;
    let mut quote: Option<char> = None;
    for (i, c) in text.char_indices() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => quote = Some(c),
            '(' => depth += 1,
            ')' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// The text before a trailing `::type` cast, when the text ends with one.
fn strip_cast(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut last = None;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        match c {
            b'\'' | b'"' => quote = Some(c),
            b'(' => depth += 1,
            b')' => depth = depth.saturating_sub(1),
            b':' if depth == 0 && bytes.get(i + 1) == Some(&b':') => {
                last = Some(i);
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }
    let at = last?;
    let cast = text[at + 2..].trim();
    let type_like = !cast.is_empty()
        && cast
            .chars()
            .all(|c| c.is_alphanumeric() || " _.\"[](),".contains(c));
    type_like.then(|| text[..at].trim().to_string())
}

/// Upper case outside quoted parts, with runs of white space as one space.
fn upper_outside_quotes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut quote: Option<char> = None;
    let mut space = false;
    for c in text.trim().chars() {
        if let Some(q) = quote {
            out.push(c);
            if c == q {
                quote = None;
            }
            continue;
        }
        if c.is_whitespace() {
            space = true;
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
            out.push(c);
        } else {
            out.extend(c.to_uppercase());
        }
    }
    out
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// A number without a leading `+` or trailing fractional zeros: `0.00` is `0`.
fn number_key(value: &str) -> String {
    let mut v = value.trim().trim_start_matches('+').to_string();
    if v.contains('.') && !v.contains(['e', 'E']) {
        while v.ends_with('0') {
            v.pop();
        }
        if v.ends_with('.') {
            v.pop();
        }
    }
    if v.is_empty() || v == "-" || v == "-0" {
        return "0".into();
    }
    v
}

fn is_numeric(normalised: &str) -> bool {
    let base = parse_type(normalised).base;
    matches!(
        base.as_str(),
        "tinyint"
            | "smallint"
            | "mediumint"
            | "int"
            | "integer"
            | "bigint"
            | "decimal"
            | "numeric"
            | "float"
            | "double"
            | "double precision"
            | "real"
    )
}

/// Whether changing a column from `from` to `to` (both normalised) can lose
/// values: a shorter length, a smaller integer or precision, a change of sign,
/// fewer enum values, or a change of type family. Equal types never do.
pub fn narrowing(from: &str, to: &str) -> bool {
    if from == to {
        return false;
    }
    let a = parse_type(from);
    let b = parse_type(to);
    if a.array != b.array {
        return true;
    }
    if let (Some(ra), Some(rb)) = (int_rank(&a.base), int_rank(&b.base)) {
        return a.unsigned != b.unsigned || rb < ra;
    }
    if let (Some((fa, ca)), Some((fb, cb))) = (capacity(&a), capacity(&b)) {
        return fa != fb || cb < ca;
    }
    let decimal = |t: &SqlType| t.base == "numeric" || t.base == "decimal";
    if decimal(&a) && decimal(&b) {
        if b.params.is_empty() {
            return false;
        }
        if a.params.is_empty() {
            return true;
        }
        let p = |t: &SqlType, i| t.param_u32(i).unwrap_or(0);
        // Fewer digits before the point lose large values, fewer after it lose
        // fractions.
        let whole = |t: &SqlType| p(t, 0).saturating_sub(p(t, 1));
        return whole(&b) < whole(&a) || p(&b, 1) < p(&a, 1);
    }
    if let (Some(fa), Some(fb)) = (float_rank(&a.base), float_rank(&b.base)) {
        return fb < fa;
    }
    if a.base == "enum" || a.base == "set" {
        return b.base != a.base || a.params.iter().any(|v| !b.params.contains(v));
    }
    if a.base == b.base {
        if a.with_tz && !b.with_tz {
            return true;
        }
        return match (a.param_u32(0), b.param_u32(0)) {
            (_, None) if b.params.is_empty() => false,
            (Some(x), Some(y)) => y < x,
            _ => a.params != b.params,
        };
    }
    true
}

fn int_rank(base: &str) -> Option<u8> {
    Some(match base {
        "tinyint" => 1,
        "smallint" => 2,
        "mediumint" => 3,
        "int" | "integer" => 4,
        "bigint" => 5,
        _ => return None,
    })
}

fn float_rank(base: &str) -> Option<u8> {
    Some(match base {
        "real" | "float" => 1,
        "double" | "double precision" => 2,
        _ => return None,
    })
}

/// The family (text 0, binary 1) and the most a string type holds.
fn capacity(t: &SqlType) -> Option<(u8, u64)> {
    let len = || t.param_u32(0).map(u64::from);
    let unbounded = u64::MAX;
    Some(match t.base.as_str() {
        "varchar" | "char" | "nvarchar" | "nchar" => (0, len().unwrap_or(unbounded)),
        "text" | "clob" | "citext" => (0, len().unwrap_or(unbounded)),
        "tinytext" => (0, 255),
        "mediumtext" => (0, 16_777_215),
        "longtext" => (0, 4_294_967_295),
        "varbinary" | "binary" => (1, len().unwrap_or(unbounded)),
        "bytea" => (1, unbounded),
        "blob" => (1, len().unwrap_or(65_535)),
        "tinyblob" => (1, 255),
        "mediumblob" => (1, 16_777_215),
        "longblob" => (1, 4_294_967_295),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use DialectKind::{MySql, Postgres, Sqlite};

    fn col(name: &str, ty: &str) -> SmColumn {
        SmColumn {
            name: name.into(),
            type_name: ty.into(),
            pk: false,
            increment: false,
            not_null: false,
            unique: false,
            default: None,
            note: None,
        }
    }

    fn same_type(d: DialectKind, a: &str, b: &str) {
        assert_eq!(
            normalise_type(d, a),
            normalise_type(d, b),
            "{a} and {b} on {d:?}"
        );
    }

    #[test]
    fn synonym_pairs_per_dialect() {
        for d in [Postgres, MySql, Sqlite] {
            same_type(d, "int", "integer");
            same_type(d, "int4", "INTEGER");
            same_type(d, "bool", "boolean");
            same_type(d, "varchar(24)", "character varying(24)");
            same_type(d, "decimal(10,2)", "numeric(10, 2)");
            same_type(d, "float8", "double precision");
        }
        same_type(Postgres, "timestamp", "timestamp without time zone");
        same_type(Postgres, "timestamptz", "timestamp with time zone");
        same_type(Postgres, "timestamptz(3)", "timestamp(3) with time zone");
        same_type(Postgres, "int8", "bigint");
        same_type(Postgres, "float4", "real");
        same_type(Postgres, "char", "character(1)");
        same_type(Postgres, "integer[]", "int4[]");
        assert_eq!(
            normalise_type(Postgres, "character varying(24)"),
            "varchar(24)"
        );
        assert_eq!(
            normalise_type(Postgres, "timestamp with time zone"),
            "timestamptz"
        );
        assert_ne!(
            normalise_type(Postgres, "timestamp"),
            normalise_type(Postgres, "timestamptz")
        );
        assert_ne!(
            normalise_type(Postgres, "varchar(16)"),
            normalise_type(Postgres, "varchar(24)")
        );
        same_type(MySql, "bool", "tinyint(1)");
        same_type(MySql, "decimal", "decimal(10,0)");
        same_type(MySql, "numeric(8)", "decimal(8,0)");
        same_type(MySql, "double precision", "double");
        same_type(MySql, "INT UNSIGNED", "int(10) unsigned");
        assert_eq!(
            normalise_type(MySql, "enum('a','b')"),
            normalise_type(MySql, "ENUM('a', 'b')")
        );
        assert_ne!(
            normalise_type(MySql, "enum('a','b')"),
            normalise_type(MySql, "enum('a','B')")
        );
    }

    #[test]
    fn mysql_display_widths_dropped_except_tinyint_1() {
        assert_eq!(normalise_type(MySql, "int(11)"), "int");
        assert_eq!(
            normalise_type(MySql, "bigint(20) unsigned"),
            "bigint unsigned"
        );
        assert_eq!(normalise_type(MySql, "smallint(6)"), "smallint");
        assert_eq!(normalise_type(MySql, "year(4)"), "year");
        assert_eq!(normalise_type(MySql, "tinyint(4)"), "tinyint");
        assert_eq!(normalise_type(MySql, "tinyint(1)"), "tinyint(1)");
        assert_ne!(
            normalise_type(MySql, "tinyint(1)"),
            normalise_type(MySql, "tinyint")
        );
        assert_eq!(normalise_type(MySql, "varchar(255)"), "varchar(255)");
        assert_eq!(
            normalise_type(MySql, "int(5) unsigned zerofill"),
            "int(5) unsigned zerofill"
        );
        assert_ne!(
            normalise_type(MySql, "int(11) zerofill"),
            normalise_type(MySql, "int(11)")
        );
    }

    #[test]
    fn serial_against_identity() {
        assert_eq!(normalise_type(Postgres, "serial"), "integer");
        assert_eq!(normalise_type(Postgres, "bigserial"), "bigint");
        assert_eq!(normalise_type(Postgres, "smallserial"), "smallint");
        assert!(implies_increment(Postgres, "serial"));
        assert!(implies_increment(Postgres, "BIGSERIAL"));
        assert!(!implies_increment(Postgres, "integer"));
        assert_eq!(normalise_type(MySql, "serial"), "bigint unsigned");
        assert!(implies_increment(MySql, "serial"));
        assert!(!implies_increment(Sqlite, "serial"));
    }

    #[test]
    fn default_forms() {
        let status = col("status", "character varying(16)");
        assert_eq!(
            normalise_default(Postgres, "invoices", &status, "'draft'::character varying"),
            Some("'draft'".into())
        );
        assert_eq!(
            normalise_default(
                Postgres,
                "invoices",
                &status,
                "('draft'::character varying)"
            ),
            normalise_default(Postgres, "invoices", &status, "'draft'")
        );
        assert_eq!(
            normalise_default(Postgres, "invoices", &status, "'it''s'::text"),
            Some("'it''s'".into())
        );
        let created = col("created_at", "timestamptz");
        let now = normalise_default(Postgres, "invoices", &created, "now()");
        assert_eq!(now, Some("CURRENT_TIMESTAMP".into()));
        assert_eq!(
            normalise_default(Postgres, "invoices", &created, "CURRENT_TIMESTAMP"),
            now
        );
        assert_eq!(
            normalise_default(Postgres, "invoices", &created, "current_timestamp"),
            now
        );
        assert_eq!(
            normalise_default(
                Postgres,
                "invoices",
                &created,
                "(now())::timestamp with time zone"
            ),
            now
        );
        assert_ne!(
            normalise_default(Postgres, "invoices", &created, "localtimestamp"),
            now
        );

        let id = col("id", "integer");
        assert_eq!(
            normalise_default(
                Postgres,
                "invoices",
                &id,
                "nextval('invoices_id_seq'::regclass)"
            ),
            None
        );
        assert_eq!(
            normalise_default(
                Postgres,
                "invoices",
                &id,
                "nextval('billing.\"invoices_id_seq\"'::regclass)"
            ),
            None
        );
        assert_eq!(
            normalise_default(Postgres, "invoices", &id, "nextval('shared_seq'::regclass)"),
            Some("NEXTVAL('shared_seq')".into())
        );
        // Another table's sequence, even one ending in `_id_seq`, is a real default.
        assert_eq!(
            normalise_default(
                Postgres,
                "invoices",
                &id,
                "nextval('orders_id_seq'::regclass)"
            ),
            Some("NEXTVAL('orders_id_seq')".into())
        );
        assert_eq!(
            normalise_default(
                Postgres,
                "invoices",
                &id,
                "nextval('staging.orders_id_seq'::regclass)"
            ),
            normalise_default(
                Postgres,
                "invoices",
                &id,
                "nextval('billing.orders_id_seq'::regclass)"
            ),
        );
        // Names are compared as PostgreSQL stores them.
        assert!(
            normalise_default(
                Postgres,
                "invoices",
                &id,
                "nextval('Invoices_id_seq'::regclass)"
            )
            .is_some()
        );
        let mut serial = col("id", "integer");
        serial.default = Some(SmDefault::Expression {
            value: "nextval('t_id_seq'::regclass)".into(),
        });
        assert!(is_own_sequence_default("t", &serial));
        assert!(!is_own_sequence_default("orders_t", &serial));
        // PostgreSQL cuts the longer name so the sequence fits in 63 bytes.
        let long_table = "a".repeat(70);
        let cut = format!("{}_id_seq", "a".repeat(56));
        assert_eq!(serial_sequence_name(&long_table, "id"), cut);
        serial.default = Some(SmDefault::Expression {
            value: format!("nextval('{cut}'::regclass)"),
        });
        assert!(is_own_sequence_default(&long_table, &serial));
        // Schema-aware: the serial's name in another schema is not the column's own.
        let public_t = TableRef {
            schema: Some("public"),
            name: "t",
        };
        for (text, own) in [
            ("nextval('t_id_seq'::regclass)", true),
            ("nextval('public.t_id_seq'::regclass)", true),
            ("nextval('other.t_id_seq'::regclass)", false),
        ] {
            serial.default = Some(SmDefault::Expression { value: text.into() });
            assert_eq!(is_own_sequence_default(public_t, &serial), own, "{text}");
        }
        assert!(is_own_sequence(public_t, "id", None, "t_id_seq", None));
        assert!(is_own_sequence(
            public_t,
            "id",
            None,
            "renamed_seq",
            Some(true)
        ));
        assert!(!is_own_sequence(
            public_t,
            "id",
            Some("other"),
            "t_id_seq",
            None
        ));
        assert!(!is_own_sequence(
            public_t,
            "id",
            None,
            "t_id_seq",
            Some(false)
        ));

        let amount = col("amount", "numeric(12,2)");
        assert_eq!(
            normalise_default(Postgres, "invoices", &amount, "0.00"),
            Some("0".into())
        );
        assert_eq!(
            normalise_default(Postgres, "invoices", &amount, "'-1'::numeric"),
            Some("-1".into())
        );
        assert_eq!(
            normalise_default(Postgres, "invoices", &amount, "0"),
            Some("0".into())
        );
        assert_eq!(
            normalise_default(Postgres, "invoices", &amount, "NULL::numeric"),
            None
        );
        assert_eq!(
            normalise_default(Postgres, "invoices", &amount, "NULL"),
            None
        );

        let flag = col("flag", "boolean");
        assert_eq!(
            normalise_default(Postgres, "invoices", &flag, "true"),
            Some("true".into())
        );

        let ts = col("created", "timestamp");
        let mysql_now = default_key(
            MySql,
            "invoices",
            &ts,
            &SmDefault::Expression {
                value: "CURRENT_TIMESTAMP".into(),
            },
        );
        assert_eq!(mysql_now, Some("CURRENT_TIMESTAMP".into()));
        for spelling in [
            "current_timestamp()",
            "now()",
            "NOW()",
            "localtimestamp",
            "LOCALTIME()",
        ] {
            assert_eq!(
                default_key(
                    MySql,
                    "invoices",
                    &ts,
                    &SmDefault::Expression {
                        value: spelling.into()
                    }
                ),
                mysql_now,
                "{spelling}"
            );
        }
        assert_eq!(
            default_key(
                MySql,
                "invoices",
                &ts,
                &SmDefault::Expression {
                    value: "current_timestamp(6)".into()
                }
            ),
            Some("CURRENT_TIMESTAMP(6)".into())
        );
        let active = col("active", "tinyint(1)");
        assert_eq!(
            default_key(MySql, "invoices", &active, &SmDefault::Bool { value: true }),
            default_key(
                MySql,
                "invoices",
                &active,
                &SmDefault::Number { value: "1".into() }
            )
        );
        let sqlite_dt = col("at", "TEXT");
        assert_eq!(
            normalise_default(Sqlite, "invoices", &sqlite_dt, "CURRENT_TIMESTAMP"),
            Some("CURRENT_TIMESTAMP".into())
        );
        assert_eq!(
            normalise_default(Sqlite, "invoices", &sqlite_dt, "(datetime('now'))"),
            Some("DATETIME('now')".into())
        );
        assert_eq!(
            normalise_default(Sqlite, "invoices", &col("name", "TEXT"), "'x'"),
            default_key(
                Sqlite,
                "invoices",
                &col("name", "TEXT"),
                &SmDefault::String { value: "x".into() }
            )
        );
    }

    #[test]
    fn name_folding() {
        assert_eq!(fold_name(Postgres, NameKind::Table, "Orders", 0), "Orders");
        assert_ne!(
            fold_name(Postgres, NameKind::Column, "Total", 0),
            fold_name(Postgres, NameKind::Column, "total", 0)
        );
        assert_eq!(fold_name(MySql, NameKind::Table, "Orders", 0), "Orders");
        assert_eq!(fold_name(MySql, NameKind::Table, "Orders", 1), "orders");
        assert_eq!(fold_name(MySql, NameKind::Table, "Orders", 2), "orders");
        assert_eq!(fold_name(MySql, NameKind::Column, "Total", 0), "total");
        assert_eq!(fold_name(MySql, NameKind::Index, "IX_Total", 0), "ix_total");
        assert_eq!(fold_name(Sqlite, NameKind::Table, "Orders", 0), "orders");
        assert_eq!(fold_name(Sqlite, NameKind::Column, "Total", 0), "total");
    }

    #[test]
    fn narrowing_changes() {
        assert!(narrowing("varchar(24)", "varchar(16)"));
        assert!(!narrowing("varchar(16)", "varchar(24)"));
        assert!(!narrowing("varchar(16)", "text"));
        assert!(narrowing("text", "varchar(255)"));
        assert!(narrowing("bigint", "integer"));
        assert!(!narrowing("integer", "bigint"));
        assert!(narrowing("int", "int unsigned"));
        assert!(narrowing("numeric(12,2)", "numeric(10,2)"));
        assert!(narrowing("numeric(12,2)", "numeric(12,0)"));
        assert!(!narrowing("numeric(10,2)", "numeric(12,2)"));
        assert!(
            narrowing("numeric(10,2)", "numeric(10,4)"),
            "8 digits before the point become 6"
        );
        assert!(!narrowing("numeric(10,2)", "numeric(12,4)"));
        assert!(narrowing("double precision", "real"));
        assert!(narrowing("enum('a','b')", "enum('a')"));
        assert!(!narrowing("enum('a')", "enum('a','b')"));
        assert!(narrowing("text", "integer"));
        assert!(!narrowing("integer", "integer"));
        assert!(narrowing("timestamptz", "timestamp"));
    }
}
