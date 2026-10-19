//! PostgreSQL structure of one schema (spec "Per-Dialect rules", PostgreSQL), read with
//! `search_path = ''` so every definition comes back fully qualified. Before the rows:
//! the schema, enums, sequences, functions and procedures (bodies not checked), tables
//! without constraints, comments. After the rows: primary key, unique, check and
//! exclusion constraints, indexes that back no constraint, Foreign Keys, views and
//! materialized views in `pg_depend` order, triggers, and `setval` for each sequence.
//! A sequence tied to a table the Backup leaves out (a partitioned or foreign table, or a
//! table in another schema) is left out with it: no CREATE, no `OWNED BY`, no `setval`.

use tokio_postgres::Client;

use super::StructureKind as K;
pub use super::postgres_catalog::read_catalog;
use super::{ContentCounts, StructureItem, StructureParts, dependency_order, terminated};
use crate::common::{pg_string, quote_double};
use crate::error::Result;

pub const SETTINGS: &[&str] = &[
    "SET client_encoding = 'UTF8';",
    "SET standard_conforming_strings = on;",
    "SET check_function_bodies = false;",
    "SET search_path = '';",
    "SET TimeZone = 'UTC';",
];

/// Server-wide objects a Backup never carries.
pub const GRANTS: &str = "grants and roles";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PgEnum {
    pub name: String,
    pub labels: Vec<String>,
    pub comment: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PgSequence {
    pub name: String,
    pub data_type: String,
    pub start: i64,
    pub increment: i64,
    pub min: i64,
    pub max: i64,
    pub cache: i64,
    pub cycle: bool,
    /// `last_value` and `is_called`, read from the sequence.
    pub last_value: i64,
    pub is_called: bool,
    /// A serial column's sequence: the owning table's schema, the table and the column.
    pub owned_by: Option<(String, String, String)>,
    /// An identity column's sequence: its table (in the schema) and column.
    pub identity_of: Option<(String, String)>,
    pub comment: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FunctionKind {
    Function,
    Procedure,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PgFunction {
    pub name: String,
    pub kind: FunctionKind,
    /// `pg_get_functiondef`.
    pub def: String,
    /// `pg_get_function_identity_arguments`, for `COMMENT ON`.
    pub args: String,
    pub comment: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PgColumn {
    pub name: String,
    /// `format_type`.
    pub type_sql: String,
    /// A collation other than the type's, qualified and quoted.
    pub collation: Option<String>,
    pub not_null: bool,
    /// `pg_get_expr` of the default, or of the generation expression.
    pub default: Option<String>,
    /// `attidentity`: `a` (ALWAYS), `d` (BY DEFAULT) or empty.
    pub identity: String,
    /// `attgenerated`: `s` (STORED), `v` (VIRTUAL) or empty.
    pub generated: String,
    pub comment: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PgTable {
    pub name: String,
    pub unlogged: bool,
    pub columns: Vec<PgColumn>,
    pub comment: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PgConstraint {
    pub table: String,
    pub name: String,
    /// `contype`: p, u, c, x or f.
    pub kind: char,
    /// `pg_get_constraintdef`.
    pub def: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PgIndex {
    pub table: String,
    /// `pg_get_indexdef`.
    pub def: String,
    /// It backs a primary key, unique or exclusion constraint, which makes it.
    pub backs_constraint: bool,
    pub on_materialized_view: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PgView {
    pub name: String,
    pub materialized: bool,
    /// `pg_get_viewdef`.
    pub def: String,
    /// `reloptions`, such as `check_option=local`.
    pub options: Vec<String>,
    /// The views of the schema it reads (`pg_depend` through its rewrite rule).
    pub deps: Vec<String>,
    pub comment: Option<String>,
}

/// What the catalog reads give, before any statement is built.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PgCatalog {
    pub schema: String,
    pub schema_comment: Option<String>,
    pub enums: Vec<PgEnum>,
    pub sequences: Vec<PgSequence>,
    pub functions: Vec<PgFunction>,
    pub tables: Vec<PgTable>,
    pub constraints: Vec<PgConstraint>,
    pub indexes: Vec<PgIndex>,
    pub views: Vec<PgView>,
    /// The table or view, and `pg_get_triggerdef`.
    pub triggers: Vec<(String, String)>,
    pub not_included: Vec<String>,
}

/// Reads the structure of `schema` on `client`, which is inside the backup's snapshot.
/// It sets `search_path` to `''` on the session first.
pub async fn read_structure(client: &Client, schema: &str) -> Result<StructureParts> {
    Ok(build(read_catalog(client, schema).await?))
}

pub(super) fn name(schema: &str, n: &str) -> String {
    format!("{}.{}", quote_double(schema), quote_double(n))
}

fn comment(on: &str, target: &str, text: &Option<String>) -> Option<String> {
    text.as_ref()
        .map(|t| format!("COMMENT ON {on} {target} IS {};", pg_string(t)))
}

/// Sequence options in `CREATE SEQUENCE` and identity form.
fn sequence_options(s: &PgSequence) -> String {
    format!(
        "INCREMENT BY {} MINVALUE {} MAXVALUE {} START WITH {} CACHE {} {}",
        s.increment,
        s.min,
        s.max,
        s.start,
        s.cache,
        if s.cycle { "CYCLE" } else { "NO CYCLE" }
    )
}

fn column_sql(schema: &str, table: &str, c: &PgColumn, seqs: &[PgSequence]) -> String {
    let mut out = format!("{} {}", quote_double(&c.name), c.type_sql);
    if let Some(coll) = &c.collation {
        out.push_str(&format!(" COLLATE {coll}"));
    }
    match (c.generated.as_str(), &c.default) {
        ("s", Some(expr)) => out.push_str(&format!(" GENERATED ALWAYS AS ({expr}) STORED")),
        ("v", Some(expr)) => out.push_str(&format!(" GENERATED ALWAYS AS ({expr}) VIRTUAL")),
        (_, Some(expr)) => out.push_str(&format!(" DEFAULT {expr}")),
        _ => {}
    }
    let kind = match c.identity.as_str() {
        "a" => Some("ALWAYS"),
        "d" => Some("BY DEFAULT"),
        _ => None,
    };
    if let Some(kind) = kind {
        out.push_str(&format!(" GENERATED {kind} AS IDENTITY"));
        let seq = seqs.iter().find(|s| {
            s.identity_of
                .as_ref()
                .is_some_and(|(t, col)| t == table && col == &c.name)
        });
        if let Some(s) = seq {
            out.push_str(&format!(
                " (SEQUENCE NAME {} {})",
                name(schema, &s.name),
                sequence_options(s)
            ));
        }
    }
    if c.not_null {
        out.push_str(" NOT NULL");
    }
    out
}

pub fn build(c: PgCatalog) -> StructureParts {
    let s = c.schema.as_str();
    let q_schema = quote_double(s);
    let in_backup = |t: &str| c.tables.iter().any(|x| x.name == t);
    // A serial sequence's owner, when the Backup holds that table.
    let owner = |q: &PgSequence| -> Option<(String, String)> {
        q.owned_by
            .as_ref()
            .filter(|(ns, t, _)| ns == s && in_backup(t))
            .map(|(_, t, col)| (t.clone(), col.clone()))
    };
    // A sequence tied to a table the Backup leaves out (identity or serial) is left out
    // with it (R33): a standalone copy would collide with the target's own on Replace.
    let sequences: Vec<&PgSequence> = c
        .sequences
        .iter()
        .filter(|q| q.identity_of.as_ref().is_none_or(|(t, _)| in_backup(t)))
        .filter(|q| q.owned_by.is_none() || owner(q).is_some())
        .collect();
    let seq_table = |q: &PgSequence| -> Option<String> {
        match &q.identity_of {
            Some((t, _)) => Some(t.clone()),
            None => owner(q).map(|(t, _)| t),
        }
    };
    let tagged = |kind: K, table: Option<&str>, sql: String| StructureItem {
        kind,
        table: table.map(str::to_string),
        sql,
    };
    let comment_item = |on: &str, target: &str, text: &Option<String>, table: Option<&str>| {
        comment(on, target, text).map(|sql| tagged(K::Comment, table, sql))
    };

    let mut before = vec![StructureItem::new(
        K::Schema,
        format!("CREATE SCHEMA IF NOT EXISTS {q_schema};"),
    )];
    before.extend(comment_item("SCHEMA", &q_schema, &c.schema_comment, None));

    for e in &c.enums {
        let labels: Vec<String> = e.labels.iter().map(|l| pg_string(l)).collect();
        let n = name(s, &e.name);
        before.push(StructureItem::new(
            K::Enum,
            format!("CREATE TYPE {n} AS ENUM ({});", labels.join(", ")),
        ));
        before.extend(comment_item("TYPE", &n, &e.comment, None));
    }

    for q in sequences.iter().filter(|q| q.identity_of.is_none()) {
        let n = name(s, &q.name);
        let table = seq_table(q);
        before.push(tagged(
            K::Sequence,
            table.as_deref(),
            format!(
                "CREATE SEQUENCE {n} AS {} {};",
                q.data_type,
                sequence_options(q)
            ),
        ));
        before.extend(comment_item("SEQUENCE", &n, &q.comment, table.as_deref()));
    }

    for f in &c.functions {
        let (kind, on) = match f.kind {
            FunctionKind::Function => (K::Function, "FUNCTION"),
            FunctionKind::Procedure => (K::Procedure, "PROCEDURE"),
        };
        before.push(StructureItem::new(kind, terminated(&f.def)));
        let target = format!("{}({})", name(s, &f.name), f.args);
        before.extend(comment_item(on, &target, &f.comment, None));
    }

    for t in &c.tables {
        let n = name(s, &t.name);
        let cols: Vec<String> = t
            .columns
            .iter()
            .map(|col| format!("    {}", column_sql(s, &t.name, col, &c.sequences)))
            .collect();
        let unlogged = if t.unlogged { "UNLOGGED " } else { "" };
        let sql = if cols.is_empty() {
            format!("CREATE {unlogged}TABLE {n} ();")
        } else {
            format!("CREATE {unlogged}TABLE {n} (\n{}\n);", cols.join(",\n"))
        };
        before.push(StructureItem::on(K::Table, &t.name, sql));
        before.extend(comment_item("TABLE", &n, &t.comment, Some(&t.name)));
        for col in &t.columns {
            let target = format!("{n}.{}", quote_double(&col.name));
            before.extend(comment_item("COLUMN", &target, &col.comment, Some(&t.name)));
        }
    }

    for q in &sequences {
        if let Some((table, column)) = owner(q) {
            let sql = format!(
                "ALTER SEQUENCE {} OWNED BY {}.{};",
                name(s, &q.name),
                name(s, &table),
                quote_double(&column)
            );
            before.push(StructureItem::on(K::OwnedBy, table, sql));
        }
    }

    let mut after = Vec::new();
    let rank = |k: char| match k {
        'p' => 0,
        'u' => 1,
        'x' => 2,
        _ => 3,
    };
    let mut constraints: Vec<&PgConstraint> =
        c.constraints.iter().filter(|k| k.kind != 'f').collect();
    constraints.sort_by_key(|k| rank(k.kind));
    let add = |k: &PgConstraint| {
        let kind = match k.kind {
            'f' => K::ForeignKey,
            'c' => K::Check,
            _ => K::Constraint,
        };
        StructureItem::on(
            kind,
            &k.table,
            format!(
                "ALTER TABLE {} ADD CONSTRAINT {} {};",
                name(s, &k.table),
                quote_double(&k.name),
                k.def
            ),
        )
    };
    after.extend(constraints.into_iter().map(add));
    after.extend(
        c.indexes
            .iter()
            .filter(|i| !i.backs_constraint && !i.on_materialized_view)
            .map(|i| StructureItem::on(K::Index, &i.table, terminated(&i.def))),
    );
    after.extend(c.constraints.iter().filter(|k| k.kind == 'f').map(add));

    let views = dependency_order(c.views.clone(), |v| &v.name, |v| &v.deps);
    for v in &views {
        let n = name(s, &v.name);
        let body = v.def.trim().trim_end_matches(';').trim_end();
        if v.materialized {
            after.push(StructureItem::new(
                K::View,
                format!("CREATE MATERIALIZED VIEW {n} AS\n{body}\nWITH DATA;"),
            ));
            after.extend(comment_item("MATERIALIZED VIEW", &n, &v.comment, None));
        } else {
            let with = if v.options.is_empty() {
                String::new()
            } else {
                format!(" WITH ({})", v.options.join(", "))
            };
            after.push(StructureItem::new(
                K::View,
                format!("CREATE VIEW {n}{with} AS\n{body};"),
            ));
            after.extend(comment_item("VIEW", &n, &v.comment, None));
        }
    }
    // An index on a materialized view goes with the view, under the Views tick.
    after.extend(
        c.indexes
            .iter()
            .filter(|i| i.on_materialized_view)
            .map(|i| StructureItem::new(K::View, terminated(&i.def))),
    );
    after.extend(
        c.triggers
            .iter()
            .map(|(table, def)| StructureItem::on(K::Trigger, table, terminated(def))),
    );
    for q in &sequences {
        let sql = format!(
            "SELECT pg_catalog.setval({}, {}, {});",
            pg_string(&name(s, &q.name)),
            q.last_value,
            q.is_called
        );
        after.push(tagged(K::Setval, seq_table(q).as_deref(), sql));
    }

    let columns = c.tables.iter().flat_map(|t| &t.columns);
    let counts = ContentCounts {
        tables: c.tables.len() as u32,
        indexes: c.indexes.len() as u32,
        foreign_keys: c.constraints.iter().filter(|k| k.kind == 'f').count() as u32,
        enums: c.enums.len() as u32,
        sequences: sequences.iter().filter(|q| q.identity_of.is_none()).count() as u32,
        views: c.views.len() as u32,
        functions: c
            .functions
            .iter()
            .filter(|f| f.kind == FunctionKind::Function)
            .count() as u32,
        procedures: c
            .functions
            .iter()
            .filter(|f| f.kind == FunctionKind::Procedure)
            .count() as u32,
        triggers: c.triggers.len() as u32,
        checks: c.constraints.iter().filter(|k| k.kind == 'c').count() as u32,
        generated: columns.filter(|col| !col.generated.is_empty()).count() as u32,
    };

    StructureParts {
        settings: SETTINGS
            .iter()
            .map(|s| StructureItem::new(K::Setting, *s))
            .collect(),
        before_rows: before,
        after_rows: after,
        finish: Vec::new(),
        not_included: c.not_included.clone(),
        counts,
        tables: c.tables.iter().map(|t| t.name.clone()).collect(),
        definer_removed: false,
    }
}
