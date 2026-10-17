//! Writes DBML from a Schema Model. Used for reverse-engineering only: a whole
//! file is generated once; later edits go through in-place text edits (ADR 0007).

use std::fmt::Write;

use crate::model::DialectKind;
use crate::schema_model::{SchemaModel, SmColumn, SmDefault, SmEndpoint, SmIndex, SmTable};

/// DBML keywords and common SQL reserved words. Quoting is always valid, so
/// quoting these too keeps the output readable by any DBML tool.
const RESERVED: &[&str] = &[
    "table",
    "ref",
    "enum",
    "note",
    "project",
    "indexes",
    "as",
    "tablegroup",
    "null",
    "true",
    "false",
    "select",
    "from",
    "where",
    "order",
    "group",
    "user",
    "index",
    "key",
    "default",
    "check",
];

pub fn write_dbml(model: &SchemaModel, source: &str) -> String {
    write_dbml_dated(model, source, &today_utc())
}

/// Today's date in UTC as `YYYY-MM-DD` (civil-from-days, Howard Hinnant).
pub(crate) fn today_utc() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let z = secs.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

fn dialect_label(d: DialectKind) -> &'static str {
    match d {
        DialectKind::MySql => "MySQL",
        DialectKind::Postgres => "PostgreSQL",
        DialectKind::Sqlite => "SQLite",
    }
}

fn is_plain(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !RESERVED.contains(&name.to_ascii_lowercase().as_str())
}

fn ident(name: &str) -> String {
    if is_plain(name) {
        name.to_string()
    } else {
        format!("\"{}\"", name.replace('\\', "\\\\").replace('"', "\\\""))
    }
}

fn qualified(schema: &Option<String>, name: &str) -> String {
    match schema {
        Some(s) => format!("{}.{}", ident(s), ident(name)),
        None => ident(name),
    }
}

fn string_lit(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// Types such as `numeric(10,2)` or `text[]` stay bare; anything with spaces or quotes is quoted.
fn type_name(t: &str) -> String {
    if t.chars()
        .any(|c| c.is_whitespace() || c == '"' || c == '\'')
    {
        format!("\"{}\"", t.replace('"', "\\\""))
    } else {
        t.to_string()
    }
}

fn column_settings(c: &SmColumn) -> Vec<String> {
    let mut s = Vec::new();
    if c.pk {
        s.push("pk".to_string());
    }
    if c.increment {
        s.push("increment".to_string());
    }
    if c.not_null && !c.pk {
        s.push("not null".to_string());
    }
    if c.unique {
        s.push("unique".to_string());
    }
    if let Some(d) = &c.default {
        s.push(format!(
            "default: {}",
            match d {
                SmDefault::String { value } => string_lit(value),
                SmDefault::Number { value } => value.clone(),
                SmDefault::Bool { value } => value.to_string(),
                SmDefault::Null => "null".to_string(),
                SmDefault::Expression { value } => format!("`{value}`"),
            }
        ));
    }
    if let Some(n) = &c.note {
        s.push(format!("note: {}", string_lit(n)));
    }
    s
}

fn columns_list(cols: &[String]) -> String {
    match cols {
        [one] => ident(one),
        many => format!(
            "({})",
            many.iter().map(|c| ident(c)).collect::<Vec<_>>().join(", ")
        ),
    }
}

fn index_line(i: &SmIndex) -> String {
    let mut settings = Vec::new();
    if i.pk {
        settings.push("pk".to_string());
    } else if i.unique {
        settings.push("unique".to_string());
    }
    if let Some(n) = &i.name {
        settings.push(format!("name: {}", string_lit(n)));
    }
    let cols = columns_list(&i.columns);
    if settings.is_empty() {
        cols
    } else {
        format!("{cols} [{}]", settings.join(", "))
    }
}

fn write_table(out: &mut String, t: &SmTable) {
    let alias = t
        .alias
        .as_deref()
        .map(|a| format!(" as {}", ident(a)))
        .unwrap_or_default();
    let _ = writeln!(out, "Table {}{alias} {{", qualified(&t.schema, &t.name));
    for c in &t.columns {
        let settings = column_settings(c);
        let tail = if settings.is_empty() {
            String::new()
        } else {
            format!(" [{}]", settings.join(", "))
        };
        let _ = writeln!(
            out,
            "  {} {}{tail}",
            ident(&c.name),
            type_name(&c.type_name)
        );
    }
    if !t.indexes.is_empty() {
        out.push_str("\n  indexes {\n");
        for i in &t.indexes {
            let _ = writeln!(out, "    {}", index_line(i));
        }
        out.push_str("  }\n");
    }
    if let Some(n) = &t.note {
        let _ = write!(out, "\n  Note: {}\n", string_lit(n));
    }
    out.push_str("}\n");
}

fn endpoint(e: &SmEndpoint) -> String {
    let cols = match e.columns.as_slice() {
        [one] => ident(one),
        many => format!(
            "({})",
            many.iter().map(|c| ident(c)).collect::<Vec<_>>().join(", ")
        ),
    };
    format!("{}.{cols}", qualified(&e.schema, &e.table))
}

pub(crate) fn write_dbml_dated(model: &SchemaModel, source: &str, date: &str) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "// Reverse-engineered from {source} on {date}");
    let _ = writeln!(out, "// Dialect: {}", dialect_label(model.dialect));
    if !model.skipped.is_empty() {
        let _ = writeln!(out, "// Not included: {}", model.skipped.join(", "));
    }
    for e in &model.enums {
        let _ = writeln!(out, "\nEnum {} {{", qualified(&e.schema, &e.name));
        for v in &e.values {
            let _ = writeln!(out, "  {}", ident(v));
        }
        out.push_str("}\n");
    }
    for t in &model.tables {
        out.push('\n');
        write_table(&mut out, t);
    }
    if !model.refs.is_empty() {
        out.push('\n');
    }
    for r in &model.refs {
        let mut settings = Vec::new();
        if let Some(d) = &r.on_delete {
            settings.push(format!("delete: {}", d.to_ascii_lowercase()));
        }
        if let Some(u) = &r.on_update {
            settings.push(format!("update: {}", u.to_ascii_lowercase()));
        }
        let name = r
            .name
            .as_deref()
            .map(|n| format!(" {}", ident(n)))
            .unwrap_or_default();
        let tail = if settings.is_empty() {
            String::new()
        } else {
            format!(" [{}]", settings.join(", "))
        };
        let _ = writeln!(
            out,
            "Ref{name}: {} > {}{tail}",
            endpoint(&r.from),
            endpoint(&r.to)
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DialectKind;
    use crate::schema_model::*;

    fn col(name: &str, type_name: &str) -> SmColumn {
        SmColumn {
            name: name.into(),
            type_name: type_name.into(),
            pk: false,
            increment: false,
            not_null: false,
            unique: false,
            default: None,
            note: None,
        }
    }

    pub(crate) fn kfc_model() -> SchemaModel {
        let public = Some("public".to_string());
        SchemaModel {
            dialect: DialectKind::Postgres,
            enums: vec![SmEnum {
                schema: public.clone(),
                name: "store_kind".into(),
                values: vec!["drive".into(), "mall".into()],
            }],
            tables: vec![
                SmTable {
                    schema: public.clone(),
                    name: "stores".into(),
                    alias: None,
                    note: Some("KFC stores".into()),
                    columns: vec![
                        SmColumn {
                            pk: true,
                            increment: true,
                            note: Some("store's id".into()),
                            ..col("id", "integer")
                        },
                        SmColumn {
                            not_null: true,
                            unique: true,
                            ..col("name", "character varying(80)")
                        },
                        SmColumn {
                            default: Some(SmDefault::String {
                                value: "mall".into(),
                            }),
                            ..col("kind", "store_kind")
                        },
                        SmColumn {
                            default: Some(SmDefault::Expression {
                                value: "now()".into(),
                            }),
                            ..col("opened_at", "timestamptz")
                        },
                    ],
                    indexes: vec![],
                },
                SmTable {
                    schema: public.clone(),
                    name: "orders".into(),
                    alias: None,
                    note: None,
                    columns: vec![
                        col("id", "bigint"),
                        col("line", "integer"),
                        SmColumn {
                            not_null: true,
                            ..col("store_id", "integer")
                        },
                        SmColumn {
                            default: Some(SmDefault::Number { value: "0".into() }),
                            ..col("total", "numeric(10,2)")
                        },
                    ],
                    indexes: vec![
                        SmIndex {
                            name: None,
                            columns: vec!["id".into(), "line".into()],
                            unique: true,
                            pk: true,
                        },
                        SmIndex {
                            name: Some("ix_store".into()),
                            columns: vec!["store_id".into()],
                            unique: false,
                            pk: false,
                        },
                    ],
                },
            ],
            refs: vec![SmRef {
                name: None,
                from: SmEndpoint {
                    schema: public.clone(),
                    table: "orders".into(),
                    columns: vec!["store_id".into()],
                },
                to: SmEndpoint {
                    schema: public,
                    table: "stores".into(),
                    columns: vec!["id".into()],
                },
                on_delete: Some("CASCADE".into()),
                on_update: None,
            }],
            skipped: vec![],
        }
    }

    pub(crate) const KFC_DBML: &str = "// Reverse-engineered from kfc / shop.public on 2026-10-16
// Dialect: PostgreSQL

Enum public.store_kind {
  drive
  mall
}

Table public.stores {
  id integer [pk, increment, note: 'store\\'s id']
  name \"character varying(80)\" [not null, unique]
  kind store_kind [default: 'mall']
  opened_at timestamptz [default: `now()`]

  Note: 'KFC stores'
}

Table public.orders {
  id bigint
  line integer
  store_id integer [not null]
  total numeric(10,2) [default: 0]

  indexes {
    (id, line) [pk]
    store_id [name: 'ix_store']
  }
}

Ref: public.orders.store_id > public.stores.id [delete: cascade]
";

    #[test]
    fn writes_tables_settings_and_refs() {
        assert_eq!(
            write_dbml_dated(&kfc_model(), "kfc / shop.public", "2026-10-16"),
            KFC_DBML
        );
    }

    #[test]
    fn dbml_header_lists_skipped() {
        let mut m = kfc_model();
        m.skipped = vec!["view v_orders".into(), "trigger audit on orders".into()];
        let out = write_dbml_dated(&m, "kfc / shop.public", "2026-10-16");
        assert!(
            out.starts_with(
                "// Reverse-engineered from kfc / shop.public on 2026-10-16\n// Dialect: PostgreSQL\n// Not included: view v_orders, trigger audit on orders\n\n"
            ),
            "{out}"
        );
    }

    #[test]
    fn odd_names_round_trip() {
        let m = SchemaModel {
            dialect: DialectKind::MySql,
            tables: vec![SmTable {
                schema: None,
                name: "we\"ird name".into(),
                alias: None,
                note: None,
                columns: vec![col("ñame 表", "int"), col("select", "text")],
                indexes: vec![],
            }],
            refs: vec![],
            enums: vec![],
            skipped: vec![],
        };
        let out = write_dbml_dated(&m, "x", "2026-10-16");
        assert!(out.contains("Table \"we\\\"ird name\" {\n"), "{out}");
        assert!(out.contains("  \"ñame 表\" int\n"), "{out}");
        assert!(out.contains("  \"select\" text\n"), "{out}");
    }

    #[test]
    fn string_defaults_escape_quotes() {
        let mut m = kfc_model();
        m.tables[0].columns[2].default = Some(SmDefault::String {
            value: "it's".into(),
        });
        let out = write_dbml_dated(&m, "x", "2026-10-16");
        assert!(out.contains("kind store_kind [default: 'it\\'s']"), "{out}");
    }

    #[test]
    fn today_is_iso_date() {
        let d = today_utc();
        assert_eq!(d.len(), 10, "{d}");
        assert!(
            d.starts_with("20") && d.as_bytes()[4] == b'-' && d.as_bytes()[7] == b'-',
            "{d}"
        );
    }
}
