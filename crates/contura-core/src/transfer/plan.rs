//! `plan_transfer`: the one deterministic plan for a transfer. Review SQL, the
//! Production pass and the run all build it from the same request, so the pass
//! covers exactly the structure SQL and row-copy shapes the user saw.

use serde::{Deserialize, Serialize};

use super::map::{MapOptions, MappingNote, NoteKind, map_model};
use super::types::parse_type;
use crate::common::sql_ident;
use crate::ddl::{DdlOptions, parts, table_order};
use crate::error::{Error, Result};
use crate::jobs::fingerprint::{JobPlan, job_fingerprint};
use crate::jobs::paths::hex;
use crate::jobs::types::JobKind;
use crate::model::{ConnectionId, DialectKind};
use crate::schema_model::{SchemaModel, SmColumn, SmTable};

/// One side of a transfer: a Connection and the database (and PostgreSQL schema) on it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    #[serde(default)]
    pub connection_id: ConnectionId,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub schema: Option<String>,
}

/// What to do when a ticked table already exists on the target.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum IfExists {
    #[default]
    Stop,
    Append,
    EmptyFirst,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum CopyKind {
    #[default]
    Both,
    StructureOnly,
    RowsOnly,
}

/// A source table and what the user set for it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableChoice {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub ticked: bool,
    #[serde(default)]
    pub if_exists: IfExists,
}

/// A typed type, a picked option or a new name for a table (`column` none) or column,
/// named as it is in the source.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSetting {
    #[serde(default)]
    pub table: String,
    #[serde(default)]
    pub column: Option<String>,
    #[serde(default)]
    pub value: String,
}

fn default_batch() -> u32 {
    1_000
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TransferRequest {
    #[serde(default)]
    pub source: Side,
    #[serde(default)]
    pub target: Side,
    #[serde(default)]
    pub tables: Vec<TableChoice>,
    /// The user's load order (source table names); empty means parents first.
    #[serde(default)]
    pub order: Vec<String>,
    #[serde(default)]
    pub copy: CopyKind,
    #[serde(default = "default_batch")]
    pub batch_rows: u32,
    #[serde(default)]
    pub overrides: Vec<ColumnSetting>,
    #[serde(default)]
    pub choices: Vec<ColumnSetting>,
    #[serde(default)]
    pub names: Vec<ColumnSetting>,
    #[serde(default = "yes")]
    pub compare_counts: bool,
    /// Create the target schema (PostgreSQL) or database (MySQL) as part of the plan.
    #[serde(default)]
    pub create_target_scope: bool,
}

/// The target as it is now: its Dialect, its name for messages, and its tables.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TargetState {
    pub dialect: DialectKind,
    #[serde(default)]
    pub connection_name: String,
    #[serde(default)]
    pub tables: Vec<TargetTable>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TargetTable {
    pub name: String,
    #[serde(default)]
    pub rows: Option<u64>,
    #[serde(default)]
    pub columns: Vec<TargetColumn>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TargetColumn {
    pub name: String,
    #[serde(default)]
    pub not_null: bool,
    #[serde(default)]
    pub has_default: bool,
    /// Generated or identity: the server fills it.
    #[serde(default)]
    pub generated: bool,
    /// A PostgreSQL `GENERATED ALWAYS AS IDENTITY` column.
    #[serde(default)]
    pub identity_always: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferMode {
    OneTransaction,
    PerTable,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CopyColumn {
    pub source: String,
    pub target: String,
    pub target_type: String,
}

/// How one table's rows are copied: the source SELECT, the target INSERT head and
/// the columns with their target types (the runner picks each column's conversion).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RowCopy {
    /// The source table's name.
    pub table: String,
    /// Display names: `pos_live.sales`, `pos.sales`.
    pub source: String,
    pub target: String,
    pub columns: Vec<CopyColumn>,
    pub select: String,
    /// The source table as it goes after FROM, quoted.
    pub source_sql: String,
    pub insert_head: String,
    /// The target table as it goes after INTO, quoted.
    pub target_sql: String,
    /// `OVERRIDING SYSTEM VALUE`: Append into a PostgreSQL ALWAYS identity.
    pub overriding: bool,
    /// Empty it first: the `DELETE FROM` the structure lists for this table. MySQL runs
    /// it inside the table's own transaction.
    pub delete: Option<String>,
    /// The source table's primary key columns, to name a failing row by its key.
    pub key_columns: Vec<String>,
    /// The server's row estimate for the table, for "About N rows".
    pub rows_hint: Option<u64>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedColumn {
    pub name: String,
    pub target_name: String,
    pub source_type: String,
    pub target_type: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedTable {
    pub name: String,
    pub target: String,
    /// The table is already on the target (Append or Empty it first).
    pub exists: bool,
    pub columns: Vec<PlannedColumn>,
}

/// A note on one source table for the Tables step.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanNote {
    pub table: String,
    pub text: String,
}

/// A Foreign Key a MySQL target loads with `foreign_key_checks` off (its child loads
/// before its parent, in a cycle or by the user's order), checked for orphans after.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrphanCheck {
    /// The child table as it is in the source (the copy the check follows).
    pub source_table: String,
    /// The child table and columns, and the parent table, as they are on the target.
    pub table: String,
    pub columns: Vec<String>,
    pub parent: String,
    pub count_sql: String,
    pub sample_sql: String,
}

/// A table Empty it first deletes rows from, for the danger banner.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Emptied {
    pub table: String,
    pub rows: Option<u64>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferPlan {
    pub source_dialect: DialectKind,
    pub target_dialect: DialectKind,
    pub tables: Vec<PlannedTable>,
    pub mapping_notes: Vec<MappingNote>,
    pub notes: Vec<PlanNote>,
    pub structure: Vec<String>,
    pub after_rows: Vec<String>,
    pub copies: Vec<RowCopy>,
    pub not_copied: Vec<String>,
    pub emptied: Vec<Emptied>,
    pub mode: TransferMode,
    pub mode_line: String,
    /// What keeps the plan from running (a column that still needs a choice).
    pub blocked: Vec<String>,
    /// MySQL: tables (source names, in load order) whose rows load together in one
    /// transaction with `foreign_key_checks` off.
    pub fk_groups: Vec<Vec<String>>,
    /// MySQL: the keys checked for orphans before that transaction commits.
    pub orphan_checks: Vec<OrphanCheck>,
    /// SHA-256 hex of everything above plus the options, for the Job pass.
    pub fingerprint: String,
}

/// What happens to one ticked table on the target.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Action {
    Create,
    Append,
    EmptyFirst,
}

fn invalid(text: String) -> Error {
    Error::InvalidInput(text)
}

/// Builds the plan for `req` from the source scope's Schema Model and the target as
/// it is. Pure: the same inputs always give the same plan and fingerprint.
pub fn plan_transfer(
    req: &TransferRequest,
    source: &SchemaModel,
    target: &TargetState,
) -> Result<TransferPlan> {
    if req.source.connection_id == req.target.connection_id
        && req.source.database == req.target.database
        && req.source.schema == req.target.schema
    {
        return Err(invalid(
            "Source and target are the same. Pick another target.".into(),
        ));
    }
    let src = source.dialect;
    let dst = target.dialect;
    let conn = target.connection_name.as_str();

    // The ticked tables, in the source model's order.
    let ticked: Vec<&TableChoice> = req.tables.iter().filter(|t| t.ticked).collect();
    for t in &ticked {
        if !source.tables.iter().any(|s| s.name == t.name) {
            return Err(invalid(format!("{} is not in the source.", t.name)));
        }
    }
    let is_ticked = |name: &str| ticked.iter().any(|t| t.name == name);
    let mut notes = Vec::new();
    let mut sub = SchemaModel {
        dialect: src,
        tables: source
            .tables
            .iter()
            .filter(|t| is_ticked(&t.name))
            .cloned()
            .collect(),
        refs: Vec::new(),
        enums: source.enums.clone(),
        skipped: source.skipped.clone(),
    };
    for r in &source.refs {
        if !is_ticked(&r.from.table) {
            continue;
        }
        if is_ticked(&r.to.table) {
            sub.refs.push(r.clone());
        } else {
            let note = PlanNote {
                table: r.from.table.clone(),
                text: format!("Needs {}, which is not ticked", r.to.table),
            };
            if !notes.contains(&note) {
                notes.push(note);
            }
        }
    }

    // Map the types, then the names and settings, to the target.
    let mut opts = MapOptions {
        target_schema: match dst {
            DialectKind::Postgres => req.target.schema.clone(),
            _ => None,
        },
        ..Default::default()
    };
    for s in &req.overrides {
        if let Some(c) = &s.column {
            opts.overrides
                .insert((s.table.clone(), c.clone()), s.value.clone());
        }
    }
    for s in &req.choices {
        if let Some(c) = &s.column {
            opts.choices
                .insert((s.table.clone(), c.clone()), s.value.clone());
        }
    }
    for s in &req.names {
        opts.names
            .insert((s.table.clone(), s.column.clone()), s.value.clone());
    }
    let mapped = map_model(&sub, dst, &opts)?;
    let blocked: Vec<String> = mapped
        .notes
        .iter()
        .filter(|n| matches!(n.kind, NoteKind::NeedsChoice { .. }))
        .map(|n| match &n.column {
            Some(c) => format!("{}.{c}: {}", n.table, n.text),
            None => format!("{}: {}", n.table, n.text),
        })
        .collect();

    // Load order: parents first, then the user's drag order.
    let mut order: Vec<usize> = table_order(&mapped.model);
    if !req.order.is_empty() {
        let mut user: Vec<usize> = req
            .order
            .iter()
            .filter_map(|n| sub.tables.iter().position(|t| &t.name == n))
            .collect();
        user.dedup();
        for i in order {
            if !user.contains(&i) {
                user.push(i);
            }
        }
        order = user;
        for r in &sub.refs {
            let at = |name: &str| order.iter().position(|&i| sub.tables[i].name == name);
            if r.from.table != r.to.table
                && let (Some(child), Some(parent)) = (at(&r.from.table), at(&r.to.table))
                && child < parent
            {
                let note = PlanNote {
                    table: r.from.table.clone(),
                    text: format!(
                        "{} loads before {}, which it needs",
                        r.from.table, r.to.table
                    ),
                };
                if !notes.contains(&note) {
                    notes.push(note);
                }
            }
        }
    }

    // What happens to each table, and the Append checks.
    let target_schema = mapped.model.tables.first().and_then(|t| t.schema.clone());
    let shown = |name: &str| match dst {
        DialectKind::Postgres => format!("{}.{name}", target_schema.as_deref().unwrap_or("public")),
        DialectKind::MySql => format!("{}.{name}", req.target.database),
        DialectKind::Sqlite => name.to_string(),
    };
    let copies_rows = req.copy != CopyKind::StructureOnly;
    let mut actions = vec![Action::Create; sub.tables.len()];
    for &i in &order {
        let choice = ticked
            .iter()
            .find(|t| t.name == sub.tables[i].name)
            .copied()
            .cloned()
            .unwrap_or_default();
        let mt = &mapped.model.tables[i];
        let existing = target
            .tables
            .iter()
            .find(|t| t.name.eq_ignore_ascii_case(&mt.name));
        actions[i] = match (existing, req.copy, choice.if_exists) {
            (None, CopyKind::RowsOnly, _) => {
                return Err(invalid(format!(
                    "{} is not on {conn}. Copy the structure too, or untick it.",
                    sub.tables[i].name
                )));
            }
            (None, _, _) => Action::Create,
            (Some(_), CopyKind::RowsOnly, IfExists::EmptyFirst) => Action::EmptyFirst,
            (Some(_), CopyKind::RowsOnly, _) => Action::Append,
            (Some(_), _, IfExists::Stop) => {
                return Err(invalid(format!(
                    "{} already exists on {conn}. Choose Append or Empty it first, or untick it.",
                    mt.name
                )));
            }
            (Some(_), _, IfExists::Append) => Action::Append,
            (Some(_), _, IfExists::EmptyFirst) => Action::EmptyFirst,
        };
        if let (Some(t), true) = (existing, copies_rows) {
            for c in &mt.columns {
                if !t
                    .columns
                    .iter()
                    .any(|tc| tc.name.eq_ignore_ascii_case(&c.name))
                {
                    return Err(invalid(format!(
                        "{} on the target has no column {}. Map it or untick it.",
                        shown(&mt.name),
                        c.name
                    )));
                }
            }
            for tc in &t.columns {
                let copied = mt
                    .columns
                    .iter()
                    .any(|c| c.name.eq_ignore_ascii_case(&tc.name));
                if !copied && tc.not_null && !tc.has_default && !tc.generated {
                    return Err(invalid(format!(
                        "{} on the target needs a value for {}, which is not copied. Give it a default or untick it.",
                        shown(&mt.name),
                        tc.name
                    )));
                }
            }
        }
    }

    // The structure SQL from the ddl writer, for the tables Contura creates.
    let created: Vec<usize> = (0..sub.tables.len())
        .filter(|&i| actions[i] == Action::Create)
        .collect();
    let created_names: Vec<&str> = created
        .iter()
        .map(|&i| mapped.model.tables[i].name.as_str())
        .collect();
    let mut create_model = mapped.model.clone();
    create_model.tables = created
        .iter()
        .map(|&i| mapped.model.tables[i].clone())
        .collect();
    create_model
        .refs
        .retain(|r| created_names.contains(&r.from.table.as_str()));
    create_model.enums.retain(|e| {
        create_model.tables.iter().any(|t| {
            t.columns.iter().any(|c| {
                c.type_name == e.name
                    || e.schema
                        .as_deref()
                        .is_some_and(|s| c.type_name == format!("{s}.{}", e.name))
            })
        })
    });
    let parts = parts(
        &create_model,
        &DdlOptions {
            sqlite_autoincrement_as_note: true,
            create_schemas: req.create_target_scope,
            unique_index_names: true,
        },
    )?;
    for n in &parts.notes {
        notes.push(PlanNote {
            table: String::new(),
            text: n.clone(),
        });
    }

    let q = |name: &str| sql_ident(dst, name);
    let target_q = |i: usize| {
        let t = &mapped.model.tables[i];
        match (&t.schema, dst) {
            (Some(s), DialectKind::Postgres) => format!("{}.{}", q(s), q(&t.name)),
            _ => q(&t.name),
        }
    };
    let deletes: Vec<String> = order
        .iter()
        .rev()
        .filter(|&&i| actions[i] == Action::EmptyFirst)
        .map(|&i| format!("DELETE FROM {};", target_q(i)))
        .collect();
    let emptied: Vec<Emptied> = order
        .iter()
        .rev()
        .filter(|&&i| actions[i] == Action::EmptyFirst)
        .map(|&i| {
            let name = &mapped.model.tables[i].name;
            Emptied {
                table: name.clone(),
                rows: target
                    .tables
                    .iter()
                    .find(|t| t.name.eq_ignore_ascii_case(name))
                    .and_then(|t| t.rows),
            }
        })
        .collect();

    let (mode, mode_line) = match dst {
        DialectKind::Postgres => (
            TransferMode::OneTransaction,
            "PostgreSQL target: everything runs in one transaction. Cancel rolls it all back.",
        ),
        DialectKind::MySql => (
            TransferMode::PerTable,
            "MySQL creates tables one by one and they stay if a later step fails. Each table's rows are copied in its own transaction.",
        ),
        DialectKind::Sqlite => (
            TransferMode::OneTransaction,
            "SQLite target: everything runs in one transaction. Cancel rolls it all back. SQLite keeps any value in any column. Types here set affinity only.",
        ),
    };

    let mut structure = Vec::new();
    let mut after_rows = Vec::new();
    match dst {
        DialectKind::Postgres => {
            structure.extend(parts.schema);
            structure.extend(parts.types);
            structure.extend(parts.tables_without_fks);
            structure.extend(deletes);
            after_rows.extend(parts.indexes);
            after_rows.extend(parts.foreign_keys);
            if copies_rows {
                // Every copied table moves its counters past the copied ids: a created
                // one by its increment columns, an existing one by its generated ones.
                for &i in &order {
                    let t = &mapped.model.tables[i];
                    let generated: Vec<&str> = match actions[i] {
                        Action::Create => Vec::new(),
                        _ => target
                            .tables
                            .iter()
                            .find(|x| x.name.eq_ignore_ascii_case(&t.name))
                            .map(|x| {
                                x.columns
                                    .iter()
                                    .filter(|c| c.generated)
                                    .map(|c| c.name.as_str())
                                    .collect()
                            })
                            .unwrap_or_default(),
                    };
                    for c in t.columns.iter().filter(|c| match actions[i] {
                        Action::Create => c.increment,
                        _ => generated.contains(&c.name.as_str()),
                    }) {
                        let table = target_q(i);
                        let col = q(&c.name);
                        after_rows.push(format!(
                            "SELECT setval(pg_get_serial_sequence('{}', '{}'), coalesce(max({col}), 1), max({col}) IS NOT NULL) FROM {table};",
                            table.replace('\'', "''"),
                            c.name.replace('\'', "''"),
                        ));
                    }
                }
            }
        }
        DialectKind::MySql => {
            // A MySQL table name is not qualified, so a new database is created and used
            // first, on the writer's own connection.
            if req.create_target_scope {
                let db = q(&req.target.database);
                structure.push(format!(
                    "CREATE DATABASE {db} DEFAULT CHARACTER SET utf8mb4;"
                ));
                structure.push(format!("USE {db};"));
            }
            structure.extend(parts.schema);
            structure.extend(parts.tables);
            structure.extend(parts.deferred_fks);
            structure.extend(deletes);
            after_rows.extend(parts.indexes);
        }
        DialectKind::Sqlite => {
            structure.push("PRAGMA foreign_keys = OFF;".into());
            structure.extend(parts.tables);
            structure.extend(deletes);
            after_rows.extend(parts.indexes);
            after_rows.push("PRAGMA foreign_key_check;".into());
        }
    }

    // How each table's rows are read and written.
    let source_q = |name: &str| {
        let s = |n: &str| sql_ident(src, n);
        match src {
            DialectKind::MySql => format!("{}.{}", s(&req.source.database), s(name)),
            DialectKind::Postgres => format!(
                "{}.{}",
                s(req.source.schema.as_deref().unwrap_or("public")),
                s(name)
            ),
            DialectKind::Sqlite => s(name),
        }
    };
    let source_shown = |name: &str| match src {
        DialectKind::MySql => format!("{}.{name}", req.source.database),
        DialectKind::Postgres => format!(
            "{}.{name}",
            req.source.schema.as_deref().unwrap_or("public")
        ),
        DialectKind::Sqlite => name.to_string(),
    };
    let mut copies = Vec::new();
    let mut tables = Vec::new();
    for &i in &order {
        let st = &sub.tables[i];
        let mt = &mapped.model.tables[i];
        let existing = target
            .tables
            .iter()
            .find(|t| t.name.eq_ignore_ascii_case(&mt.name));
        let columns: Vec<PlannedColumn> = st
            .columns
            .iter()
            .zip(&mt.columns)
            .map(|(s, m)| PlannedColumn {
                name: s.name.clone(),
                target_name: m.name.clone(),
                source_type: s.type_name.clone(),
                target_type: m.type_name.clone(),
            })
            .collect();
        if copies_rows {
            let select_cols: Vec<String> = st.columns.iter().map(|c| read_column(src, c)).collect();
            let insert_cols: Vec<String> = mt.columns.iter().map(|c| q(&c.name)).collect();
            let overriding = dst == DialectKind::Postgres
                && existing.is_some_and(|t| {
                    t.columns.iter().any(|tc| {
                        tc.identity_always
                            && mt
                                .columns
                                .iter()
                                .any(|c| c.name.eq_ignore_ascii_case(&tc.name))
                    })
                });
            copies.push(RowCopy {
                table: st.name.clone(),
                source: source_shown(&st.name),
                target: shown(&mt.name),
                columns: columns
                    .iter()
                    .map(|c| CopyColumn {
                        source: c.name.clone(),
                        target: c.target_name.clone(),
                        target_type: c.target_type.clone(),
                    })
                    .collect(),
                select: format!(
                    "SELECT {} FROM {}",
                    select_cols.join(", "),
                    source_q(&st.name)
                ),
                source_sql: source_q(&st.name),
                target_sql: target_q(i),
                overriding,
                delete: (actions[i] == Action::EmptyFirst)
                    .then(|| format!("DELETE FROM {};", target_q(i))),
                key_columns: key_columns(st),
                insert_head: format!(
                    "INSERT INTO {} ({}){}",
                    target_q(i),
                    insert_cols.join(", "),
                    if overriding {
                        " OVERRIDING SYSTEM VALUE"
                    } else {
                        ""
                    }
                ),
                rows_hint: None,
            });
        }
        tables.push(PlannedTable {
            name: st.name.clone(),
            target: mt.name.clone(),
            exists: existing.is_some(),
            columns,
        });
    }

    // MySQL creates Foreign Keys with the tables and loads with checks on, so a key
    // whose child loads first (a cycle, a self reference or a drag) loads its tables
    // together with checks off, then is checked for orphans. So do a parent and child
    // both emptied first: the parent's DELETE would fail while the child keeps its rows.
    let mut fk_groups: Vec<Vec<String>> = Vec::new();
    let mut orphan_checks = Vec::new();
    if dst == DialectKind::MySql && copies_rows {
        let at = |name: &str| order.iter().position(|&i| sub.tables[i].name == name);
        let mut group: Vec<usize> = (0..sub.tables.len()).collect();
        fn root(g: &mut [usize], mut i: usize) -> usize {
            while g[i] != i {
                g[i] = g[g[i]];
                i = g[i];
            }
            i
        }
        // Group the tables of every key whose child loads first.
        let mut grouped = vec![false; sub.tables.len()];
        for r in &sub.refs {
            let (Some(child), Some(parent)) = (at(&r.from.table), at(&r.to.table)) else {
                continue;
            };
            let (ci, pi) = (order[child], order[parent]);
            let both_emptied =
                actions[ci] == Action::EmptyFirst && actions[pi] == Action::EmptyFirst;
            if child > parent && !(both_emptied && ci != pi) {
                continue;
            }
            let (a, b) = (root(&mut group, ci), root(&mut group, pi));
            group[a] = b;
            grouped[ci] = true;
            grouped[pi] = true;
        }
        let roots: Vec<usize> = (0..sub.tables.len()).map(|i| root(&mut group, i)).collect();
        for &i in &order {
            if !grouped[i] || fk_groups.iter().any(|g| g.contains(&sub.tables[i].name)) {
                continue;
            }
            fk_groups.push(
                order
                    .iter()
                    .filter(|&&j| grouped[j] && roots[j] == roots[i])
                    .map(|&j| sub.tables[j].name.clone())
                    .collect(),
            );
        }
        // Checks are off while a group loads, so every key of its tables is checked,
        // also one whose parent loaded before the group.
        for r in &sub.refs {
            let (Some(child), Some(parent)) = (at(&r.from.table), at(&r.to.table)) else {
                continue;
            };
            let (ci, pi) = (order[child], order[parent]);
            if !grouped[ci] {
                continue;
            }
            let cols = |t: usize, names: &[String]| -> Vec<String> {
                names
                    .iter()
                    .map(|n| {
                        sub.tables[t]
                            .columns
                            .iter()
                            .position(|c| &c.name == n)
                            .map(|k| mapped.model.tables[t].columns[k].name.clone())
                            .unwrap_or_else(|| n.clone())
                    })
                    .collect()
            };
            let (cc, pc) = (cols(ci, &r.from.columns), cols(pi, &r.to.columns));
            let on: Vec<String> = cc
                .iter()
                .zip(&pc)
                .map(|(c, p)| format!("p.{} = c.{}", q(p), q(c)))
                .collect();
            let from = format!(
                "FROM {} c LEFT JOIN {} p ON {} WHERE c.{} IS NOT NULL AND p.{} IS NULL",
                target_q(ci),
                target_q(pi),
                on.join(" AND "),
                q(&cc[0]),
                q(&pc[0])
            );
            orphan_checks.push(OrphanCheck {
                source_table: sub.tables[ci].name.clone(),
                table: mapped.model.tables[ci].name.clone(),
                columns: cc.clone(),
                parent: mapped.model.tables[pi].name.clone(),
                count_sql: format!("SELECT CAST(count(*) AS CHAR) {from}"),
                sample_sql: format!("SELECT CAST(c.{} AS CHAR) {from} LIMIT 1", q(&cc[0])),
            });
        }
    }

    let mut plan = TransferPlan {
        source_dialect: src,
        target_dialect: dst,
        tables,
        mapping_notes: mapped.notes,
        notes,
        structure,
        after_rows,
        copies,
        not_copied: source.skipped.clone(),
        emptied,
        mode,
        mode_line: mode_line.into(),
        blocked,
        fk_groups,
        orphan_checks,
        fingerprint: String::new(),
    };
    plan.fingerprint = fingerprint(req, &plan)?;
    Ok(plan)
}

/// The table's primary key columns: column flags, or a key index.
fn key_columns(t: &SmTable) -> Vec<String> {
    let flagged: Vec<String> = t
        .columns
        .iter()
        .filter(|c| c.pk)
        .map(|c| c.name.clone())
        .collect();
    if !flagged.is_empty() {
        return flagged;
    }
    t.indexes
        .iter()
        .find(|i| i.pk)
        .map(|i| i.columns.clone())
        .unwrap_or_default()
}

/// How one source column is read: MySQL spatial values as WKT, BIT as a number.
fn read_column(src: DialectKind, c: &SmColumn) -> String {
    let q = sql_ident(src, &c.name);
    if src != DialectKind::MySql {
        return q;
    }
    let base = parse_type(&c.type_name).base;
    match base.as_str() {
        "geometry" | "point" | "linestring" | "polygon" | "multipoint" | "multilinestring"
        | "multipolygon" | "geometrycollection" => format!("ST_AsText({q}) AS {q}"),
        "bit" => format!("{q} + 0 AS {q}"),
        _ => q,
    }
}

/// The plan's fingerprint: the statements, the row-copy shapes, the order and the
/// options, on the target Connection, through the step 7 Job fingerprint.
fn fingerprint(req: &TransferRequest, plan: &TransferPlan) -> Result<String> {
    let job = JobPlan {
        kind: JobKind::Transfer,
        connection_id: req.target.connection_id,
        database: Some(req.target.database.clone()),
        schema: req.target.schema.clone(),
        table: None,
        options: serde_json::json!({
            "source": req.source,
            "copy": req.copy,
            "batchRows": req.batch_rows,
            "compareCounts": req.compare_counts,
            "createTargetScope": req.create_target_scope,
            "ifExists": req.tables.iter().filter(|t| t.ticked).map(|t| (&t.name, t.if_exists)).collect::<Vec<_>>(),
            "structure": plan.structure,
            "afterRows": plan.after_rows,
            "copies": plan.copies,
            "blocked": plan.blocked,
            "fkGroups": plan.fk_groups,
            "orphanChecks": plan.orphan_checks,
        }),
        mapping: Vec::new(),
        template: String::new(),
        file: None,
    };
    Ok(hex(&job_fingerprint(&job)?))
}
