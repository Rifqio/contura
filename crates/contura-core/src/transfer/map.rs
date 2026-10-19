//! `map_model`: the Schema Model of the ticked source tables, rewritten for the
//! target Dialect, with a note for every column whose type, default or name
//! changes in a way the user should see (step 8, "Type mapping").

use std::collections::BTreeMap;

use serde::Serialize;

use super::types::{SqlType, parse_type};
use crate::error::{Error, Result};
use crate::model::DialectKind::{self, MySql, Postgres, Sqlite};
use crate::schema_model::{SchemaModel, SmColumn, SmDefault, SmEnum, SmTable};

/// What the user set on the Type mapping step.
#[derive(Clone, Debug, Default)]
pub struct MapOptions {
    /// Typed target types, by (table, column), using the source names.
    pub overrides: BTreeMap<(String, String), String>,
    /// Picked options for columns that need a choice, by (table, column).
    pub choices: BTreeMap<(String, String), String>,
    /// New names for tables (column `None`) and columns whose names are too long.
    pub names: BTreeMap<(String, Option<String>), String>,
    /// The PostgreSQL schema the tables and new enum types go into.
    pub target_schema: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum NoteKind {
    Info,
    New,
    NeedsChoice { options: Vec<String> },
    NoMatch,
    Lossy,
}

/// A note on one table or column, named as it is in the source.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MappingNote {
    pub table: String,
    pub column: Option<String>,
    pub kind: NoteKind,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MappedModel {
    pub model: SchemaModel,
    pub notes: Vec<MappingNote>,
}

const ZERO_DATES: &str = "Zero dates (0000-00-00) are copied as NULL.";

/// Rewrites `model` (read from its own Dialect) for `target`. Pure and table-driven.
/// Refuses a typed type that is not one SQL expression.
pub fn map_model(
    model: &SchemaModel,
    target: DialectKind,
    opts: &MapOptions,
) -> Result<MappedModel> {
    let mut m = Mapper {
        src: model.dialect,
        target,
        source: model,
        opts,
        notes: Vec::new(),
        enums: Vec::new(),
    };
    let schema = |own: &Option<String>| match target {
        Postgres => opts.target_schema.clone().or_else(|| own.clone()),
        _ => None,
    };

    let mut table_names: BTreeMap<String, String> = BTreeMap::new();
    let mut column_names: BTreeMap<(String, String), String> = BTreeMap::new();
    let mut tables = Vec::with_capacity(model.tables.len());
    for t in &model.tables {
        let name = m.name(&t.name, None, &t.name);
        table_names.insert(t.name.clone(), name.clone());
        let single_pk = single_pk(t);
        let mut columns = Vec::with_capacity(t.columns.len());
        for c in &t.columns {
            let mut mapped = m.column(t, c, single_pk.as_deref())?;
            mapped.name = m.name(&t.name, Some(&c.name), &c.name);
            column_names.insert((t.name.clone(), c.name.clone()), mapped.name.clone());
            columns.push(mapped);
        }
        let indexes = t
            .indexes
            .iter()
            .map(|i| {
                let mut i = i.clone();
                for c in &mut i.columns {
                    if let Some(n) = column_names.get(&(t.name.clone(), c.clone())) {
                        *c = n.clone();
                    }
                }
                i
            })
            .collect();
        tables.push(SmTable {
            schema: schema(&t.schema),
            name,
            alias: t.alias.clone(),
            note: t.note.clone(),
            columns,
            indexes,
        });
    }

    let refs = model
        .refs
        .iter()
        .map(|r| {
            let mut r = r.clone();
            for end in [&mut r.from, &mut r.to] {
                let old = end.table.clone();
                for c in &mut end.columns {
                    if let Some(n) = column_names.get(&(old.clone(), c.clone())) {
                        *c = n.clone();
                    }
                }
                if let Some(n) = table_names.get(&old) {
                    end.table = n.clone();
                }
                end.schema = schema(&end.schema);
            }
            r
        })
        .collect();

    let Mapper { notes, enums, .. } = m;
    Ok(MappedModel {
        model: SchemaModel {
            dialect: target,
            tables,
            refs,
            enums,
            skipped: model.skipped.clone(),
        },
        notes,
    })
}

/// The name of the table's one primary key column, when it has exactly one.
fn single_pk(t: &SmTable) -> Option<String> {
    let mut pk: Vec<&str> = t
        .columns
        .iter()
        .filter(|c| c.pk)
        .map(|c| c.name.as_str())
        .collect();
    if let Some(i) = t.indexes.iter().find(|i| i.pk) {
        pk.extend(i.columns.iter().map(String::as_str));
    }
    pk.sort_unstable();
    pk.dedup();
    (pk.len() == 1).then(|| pk[0].to_string())
}

struct Mapper<'a> {
    src: DialectKind,
    target: DialectKind,
    source: &'a SchemaModel,
    opts: &'a MapOptions,
    notes: Vec<MappingNote>,
    enums: Vec<SmEnum>,
}

/// A target type and the notes that go with it.
struct Mapped {
    type_name: String,
    notes: Vec<(NoteKind, String)>,
}

impl Mapped {
    fn plain(t: impl Into<String>) -> Self {
        Mapped {
            type_name: t.into(),
            notes: Vec::new(),
        }
    }

    fn with(t: impl Into<String>, kind: NoteKind, text: impl Into<String>) -> Self {
        Mapped {
            type_name: t.into(),
            notes: vec![(kind, text.into())],
        }
    }
}

/// The type families the mapping table is written in.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Family {
    Tiny,
    Small,
    Medium,
    Int,
    Big,
    Flag,
    Bool,
    Decimal,
    Float,
    Double,
    Char,
    Varchar,
    Text,
    Binary,
    Date,
    Time,
    Year,
    DateTime,
    Json,
    Uuid,
    Other,
}

fn family(src: DialectKind, t: &SqlType) -> Family {
    use Family::*;
    if t.array {
        return Other;
    }
    match t.base.as_str() {
        "tinyint" if src == MySql && t.params == ["1"] && !t.unsigned => Flag,
        "tinyint" => Tiny,
        "smallint" | "int2" => Small,
        "mediumint" => Medium,
        "int" | "integer" | "int4" => Int,
        "bigint" | "int8" => Big,
        "bool" | "boolean" => Bool,
        "decimal" | "numeric" | "dec" | "fixed" => Decimal,
        "float" | "real" | "float4" if !(src == MySql && t.base == "real") => Float,
        "double" | "double precision" | "float8" | "real" => Double,
        "char" | "character" | "bpchar" => Char,
        "varchar" | "character varying" => Varchar,
        "text" | "tinytext" | "mediumtext" | "longtext" | "citext" => Text,
        "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" | "bytea" => {
            Binary
        }
        "date" => Date,
        "time" => Time,
        "year" => Year,
        "datetime" | "timestamp" => DateTime,
        "json" | "jsonb" => Json,
        "uuid" => Uuid,
        _ => Other,
    }
}

fn dialect_name(d: DialectKind) -> &'static str {
    match d {
        MySql => "MySQL",
        Postgres => "PostgreSQL",
        Sqlite => "SQLite",
    }
}

/// An example value for a type with no match, as it reads once copied as text.
fn example(t: &SqlType) -> Option<String> {
    let b = t.base.as_str();
    if t.array {
        return Some("{1,2,3}".into());
    }
    let fixed = match b {
        "geometry" | "geography" | "point" | "linestring" | "polygon" | "multipoint"
        | "multilinestring" | "multipolygon" | "geometrycollection" => "POINT(-1.54 53.80)",
        "inet" | "cidr" => "192.168.0.1/24",
        "macaddr" | "macaddr8" => "08:00:2b:01:02:03",
        "interval" => "1 day 02:00:00",
        "money" => "$12.50",
        "xml" => "<a>1</a>",
        "tsvector" => "'cat':1",
        "set" => {
            let values: Vec<String> = t.params.iter().take(2).map(|p| unquote(p)).collect();
            return (!values.is_empty()).then(|| values.join(","));
        }
        _ if b.ends_with("range") => "[1,10)",
        _ => return None,
    };
    Some(fixed.into())
}

fn no_match(target: DialectKind, t: &SqlType, as_type: &str) -> Mapped {
    let text = match example(t) {
        Some(e) => format!(
            "No {} match. Copied as text, for example {e}.",
            dialect_name(target)
        ),
        None => format!("No {} match. Copied as text.", dialect_name(target)),
    };
    Mapped::with(as_type, NoteKind::NoMatch, text)
}

/// `'it''s'` to `it's`.
fn unquote(p: &str) -> String {
    let p = p.trim();
    match p.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')) {
        Some(inner) => inner.replace("''", "'"),
        None => p.to_string(),
    }
}

fn params(t: &SqlType) -> String {
    if t.params.is_empty() {
        String::new()
    } else {
        format!("({})", t.params.join(","))
    }
}

/// A short name for a dropped default: `nextval(...)`, `uuid()`.
fn short_default(expr: &str) -> String {
    let e = expr.trim();
    match e.split_once('(') {
        Some((name, rest)) => {
            let inner = rest.trim_end().strip_suffix(')').unwrap_or(rest).trim();
            if inner.is_empty() {
                format!("{name}()")
            } else {
                format!("{name}(...)")
            }
        }
        None => e.to_string(),
    }
}

fn is_now(expr: &str) -> bool {
    let e = expr.trim().to_ascii_uppercase();
    let base = e.split('(').next().unwrap_or("").trim();
    matches!(base, "CURRENT_TIMESTAMP" | "NOW" | "LOCALTIMESTAMP")
        && (e == base || e.ends_with(')'))
}

impl Mapper<'_> {
    fn note(&mut self, table: &str, column: Option<&str>, kind: NoteKind, text: String) {
        self.notes.push(MappingNote {
            table: table.to_string(),
            column: column.map(str::to_string),
            kind,
            text,
        });
    }

    /// The target name for a table or column, with a choice note when the source
    /// name (or the picked one) is longer than the target keeps.
    fn name(&mut self, table: &str, column: Option<&str>, source: &str) -> String {
        let key = (table.to_string(), column.map(str::to_string));
        let candidate = self
            .opts
            .names
            .get(&key)
            .cloned()
            .unwrap_or_else(|| source.to_string());
        let (too_long, cut, limit): (bool, String, &str) = match self.target {
            Postgres => {
                let mut end = 63.min(source.len());
                while !source.is_char_boundary(end) {
                    end -= 1;
                }
                (
                    candidate.len() > 63,
                    source[..end].to_string(),
                    "PostgreSQL's 63 bytes",
                )
            }
            MySql => (
                candidate.chars().count() > 64,
                source.chars().take(64).collect(),
                "MySQL's 64 characters",
            ),
            Sqlite => (false, String::new(), ""),
        };
        if !too_long {
            return candidate;
        }
        self.note(
            table,
            column,
            NoteKind::NeedsChoice {
                options: vec![cut.clone()],
            },
            format!(
                "The name {source} is longer than {limit}. The server would cut it, so pick a name."
            ),
        );
        cut
    }

    fn column(&mut self, t: &SmTable, c: &SmColumn, single_pk: Option<&str>) -> Result<SmColumn> {
        let key = (t.name.clone(), c.name.clone());
        let parsed = parse_type(&c.type_name);
        let mut out = c.clone();

        let mapped = if let Some(typed) = self.opts.overrides.get(&key) {
            if !crate::design::check_fragment(typed) {
                return Err(Error::InvalidInput(format!(
                    "The type of {} is not one SQL expression.",
                    c.name
                )));
            }
            Mapped::plain(typed.trim())
        } else {
            let mut mapped = self.type_for(t, c, &parsed);
            // A picked option replaces the default and settles the choice.
            if let Some(picked) = self.opts.choices.get(&key) {
                let settles = mapped.notes.iter().any(|(k, _)| {
                    matches!(k, NoteKind::NeedsChoice { options } if options.contains(picked))
                });
                if settles {
                    mapped.type_name = picked.clone();
                    mapped
                        .notes
                        .retain(|(k, _)| !matches!(k, NoteKind::NeedsChoice { .. }));
                }
            }
            mapped
        };
        out.type_name = mapped.type_name;
        for (kind, text) in mapped.notes {
            self.note(&t.name, Some(&c.name), kind, text);
        }

        // MySQL zero dates always become NULL (answer 6b).
        if self.src == MySql && matches!(family(MySql, &parsed), Family::Date | Family::DateTime) {
            self.note(&t.name, Some(&c.name), NoteKind::Info, ZERO_DATES.into());
        }

        if self.target == Sqlite && self.src != Sqlite && c.increment {
            let rowid =
                single_pk == Some(c.name.as_str()) && out.type_name.eq_ignore_ascii_case("INTEGER");
            if !rowid {
                out.increment = false;
                self.note(
                    &t.name,
                    Some(&c.name),
                    NoteKind::Info,
                    "AUTOINCREMENT is left out; values are copied as they are".into(),
                );
            }
        }

        if self.src != self.target
            && let Some(SmDefault::Expression { value }) = &c.default
        {
            if is_now(value) {
                out.default = Some(SmDefault::Expression {
                    value: match self.target {
                        Postgres => "now()".into(),
                        _ => "CURRENT_TIMESTAMP".into(),
                    },
                });
            } else {
                out.default = None;
                self.note(
                    &t.name,
                    Some(&c.name),
                    NoteKind::Info,
                    format!("Default {} is not copied", short_default(value)),
                );
            }
        }
        Ok(out)
    }

    /// The PostgreSQL enum in the source model that `type_name` names, if any.
    fn source_enum(&self, type_name: &str) -> Option<&SmEnum> {
        let wanted = type_name.trim();
        self.source.enums.iter().find(|e| {
            e.name.eq_ignore_ascii_case(wanted)
                || e.schema
                    .as_deref()
                    .is_some_and(|s| format!("{s}.{}", e.name).eq_ignore_ascii_case(wanted))
        })
    }

    /// Adds an enum to the target model (once) and returns the type text that names it.
    fn add_enum(&mut self, name: String, values: Vec<String>) -> String {
        let schema = match self.target {
            Postgres => self.opts.target_schema.clone(),
            _ => None,
        };
        let qualified = match &schema {
            Some(s) => format!("{s}.{name}"),
            None => name.clone(),
        };
        if !self
            .enums
            .iter()
            .any(|e| e.name == name && e.schema == schema)
        {
            self.enums.push(SmEnum {
                schema,
                name,
                values,
            });
        }
        qualified
    }

    fn type_for(&mut self, t: &SmTable, c: &SmColumn, st: &SqlType) -> Mapped {
        // Enums: MySQL inline `enum(...)`, or a PostgreSQL type in the model's enums.
        let pg_enum = (self.src == Postgres)
            .then(|| self.source_enum(&c.type_name).cloned())
            .flatten();
        let mysql_enum = self.src == MySql && st.base == "enum";
        if let Some(e) = pg_enum {
            return match self.target {
                Postgres => Mapped::plain(self.add_enum(e.name, e.values)),
                MySql => Mapped::plain(self.add_enum(e.name, e.values)),
                Sqlite => Mapped::with(
                    self.add_enum(e.name, e.values),
                    NoteKind::Info,
                    "Copied as TEXT with a CHECK on its values.",
                ),
            };
        }
        if mysql_enum && self.target != MySql {
            let values = st.params.iter().map(|p| unquote(p)).collect();
            let type_name = self.add_enum(format!("{}_{}", t.name, c.name), values);
            return match self.target {
                Postgres => Mapped::with(
                    type_name.clone(),
                    NoteKind::New,
                    format!("Creates the enum type {type_name}"),
                ),
                _ => Mapped::with(
                    type_name,
                    NoteKind::Info,
                    "Copied as TEXT with a CHECK on its values.",
                ),
            };
        }
        if self.src == self.target {
            return Mapped::plain(c.type_name.clone());
        }
        if self.src == Sqlite {
            return self.by_affinity(&c.type_name);
        }
        let raw = c.type_name.trim().to_string();
        match self.target {
            Postgres => to_postgres(st, &raw),
            MySql => to_mysql(st, &raw),
            Sqlite => to_sqlite(self.src, st, &raw),
        }
    }

    /// SQLite's affinity rules, for a SQLite source copied to another Dialect.
    fn by_affinity(&self, declared: &str) -> Mapped {
        let up = declared.trim().to_ascii_uppercase();
        let (pg, my) = if up.contains("INT") {
            ("bigint", "bigint")
        } else if up.contains("CHAR") || up.contains("CLOB") || up.contains("TEXT") {
            ("text", "longtext")
        } else if up.contains("BLOB") || up.is_empty() {
            ("bytea", "longblob")
        } else if up.contains("REAL") || up.contains("FLOA") || up.contains("DOUB") {
            ("double precision", "double")
        } else {
            ("numeric", "decimal(65,30)")
        };
        let to = if self.target == Postgres { pg } else { my };
        let text = if declared.trim().is_empty() {
            format!("SQLite columns without a type are copied by their affinity as {to}.")
        } else {
            format!(
                "SQLite type {} is copied by its affinity as {to}.",
                declared.trim()
            )
        };
        Mapped::with(to, NoteKind::Info, text)
    }
}

fn fits(raw: &str, to: &str) -> Mapped {
    Mapped::with(
        to,
        NoteKind::Info,
        format!("{raw} becomes {to}, so every value fits."),
    )
}

fn to_postgres(st: &SqlType, raw: &str) -> Mapped {
    use Family::*;
    let f = family(MySql, st);
    match f {
        Tiny if st.unsigned => fits(raw, "smallint"),
        Tiny | Small if !st.unsigned => Mapped::plain("smallint"),
        Small | Medium if st.unsigned => fits(raw, "integer"),
        Medium => Mapped::plain("integer"),
        Int if st.unsigned => fits(raw, "bigint"),
        Int => Mapped::plain("integer"),
        Big if st.unsigned => fits(raw, "numeric(20)"),
        Big => Mapped::plain("bigint"),
        Flag => Mapped::with(
            "smallint",
            NoteKind::NeedsChoice {
                options: vec!["boolean".into(), "smallint".into()],
            },
            "tinyint(1) is often a flag. Pick boolean or smallint.",
        ),
        Bool => Mapped::plain("boolean"),
        Decimal if st.params.is_empty() => Mapped::plain("numeric(10,0)"),
        Decimal => Mapped::plain(format!("numeric{}", params(st))),
        Float => Mapped::plain("real"),
        Double => Mapped::plain("double precision"),
        Char if st.params.is_empty() => Mapped::plain("char(1)"),
        Char => Mapped::plain(format!("char{}", params(st))),
        Varchar => Mapped::plain(format!("varchar{}", params(st))),
        Text => Mapped::plain("text"),
        Binary => Mapped::plain("bytea"),
        Date => Mapped::plain("date"),
        Time => Mapped::plain(format!("time{}", params(st))),
        Year => Mapped::with("smallint", NoteKind::Info, "year becomes smallint."),
        DateTime => Mapped::with(
            format!("timestamp{}", params(st)),
            NoteKind::Info,
            "The source has no time zone. Values are kept as they are.",
        ),
        Json => Mapped::plain("jsonb"),
        Uuid => Mapped::plain("uuid"),
        // Every integer case is guarded above; these never reach here.
        Tiny | Small => Mapped::plain("smallint"),
        Other => no_match(Postgres, st, "text"),
    }
}

fn to_mysql(st: &SqlType, raw: &str) -> Mapped {
    use Family::*;
    match family(Postgres, st) {
        Tiny | Small => Mapped::plain("smallint"),
        Medium | Int => Mapped::plain("int"),
        Big => Mapped::plain("bigint"),
        Flag | Bool => Mapped::plain("tinyint(1)"),
        Decimal => match st.param_u32(0) {
            None => Mapped::with(
                "text",
                NoteKind::Lossy,
                "numeric has no set precision. It becomes text, so digits are kept.",
            ),
            Some(p) if p > 65 => Mapped::with(
                "text",
                NoteKind::Lossy,
                format!(
                    "Precision {p} is above MySQL's 65. {raw} becomes text, so digits are kept."
                ),
            ),
            Some(_) => Mapped::plain(format!("decimal{}", params(st))),
        },
        Float => Mapped::plain("float"),
        Double => Mapped::plain("double"),
        Char if st.params.is_empty() => Mapped::plain("char(1)"),
        Char => Mapped::plain(format!("char{}", params(st))),
        Varchar => match st.param_u32(0) {
            None => Mapped::plain("longtext"),
            Some(n) if n > 16_383 => Mapped::with(
                "longtext",
                NoteKind::Info,
                format!("varchar({n}) is over MySQL's 16,383 characters. It becomes longtext."),
            ),
            Some(n) => Mapped::plain(format!("varchar({n})")),
        },
        Text => Mapped::plain("longtext"),
        Binary => Mapped::plain("longblob"),
        Date => Mapped::plain("date"),
        Time if st.with_tz => Mapped::with(
            format!("time{}", params(st)),
            NoteKind::Info,
            "The time zone is not kept.",
        ),
        Time => Mapped::plain(format!("time{}", params(st))),
        Year => Mapped::plain("year"),
        DateTime => {
            let p = st.param_u32(0).unwrap_or(6).min(6);
            let to = format!("datetime({p})");
            if st.with_tz {
                Mapped::with(
                    to,
                    NoteKind::Info,
                    "Values are converted to UTC; the time zone is not kept.",
                )
            } else {
                Mapped::plain(to)
            }
        }
        Json => Mapped::plain("json"),
        Uuid => Mapped::with(
            "char(36)",
            NoteKind::NeedsChoice {
                options: vec!["char(36)".into(), "binary(16)".into()],
            },
            "uuid has no MySQL match. Pick char(36) or binary(16).",
        ),
        Other => no_match(MySql, st, "text"),
    }
}

fn to_sqlite(src: DialectKind, st: &SqlType, raw: &str) -> Mapped {
    use Family::*;
    let iso = || Mapped::with("TEXT", NoteKind::Info, "Stored as ISO 8601 text.");
    match family(src, st) {
        Big if st.unsigned => Mapped::with(
            "INTEGER",
            NoteKind::Info,
            "bigint unsigned values over 9,223,372,036,854,775,807 do not fit INTEGER and stop the run.",
        ),
        Tiny | Small | Medium | Int | Big | Flag | Bool | Year => Mapped::plain("INTEGER"),
        Decimal => match st.param_u32(0) {
            Some(p) if p > 15 => Mapped::with(
                "TEXT",
                NoteKind::Lossy,
                format!(
                    "Precision {p} is above SQLite's 15 exact digits. {raw} becomes TEXT, so digits are kept."
                ),
            ),
            None if src == Postgres => Mapped::with(
                "TEXT",
                NoteKind::Lossy,
                "numeric has no set precision. It becomes TEXT, so digits are kept.",
            ),
            _ => Mapped::plain("NUMERIC"),
        },
        Float | Double => Mapped::plain("REAL"),
        Char | Varchar | Text | Json | Uuid => Mapped::plain("TEXT"),
        Binary => Mapped::plain("BLOB"),
        Date | Time | DateTime => iso(),
        Other => no_match(Sqlite, st, "TEXT"),
    }
}
