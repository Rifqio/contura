//! The Sync Script: the ticked items of a diff as the exact statements Apply
//! runs on the target, in run order, with the line shown under the script.
//!
//! - Selection: `needs` closes over the ticked set. Ticking an item ticks what
//!   it needs; unticking one unticks what needs it. The default selection is
//!   every item except data-loss items and items Contura cannot script.
//! - Order: 1. Drop (Foreign Keys, indexes, columns, tables, types), 2. Change
//!   (enum values, columns, notes), 3. Create (types, tables, columns, indexes,
//!   Foreign Keys), then any statement moves after the statements of what its
//!   items need. On MySQL, `DROP COLUMN` and `DROP TABLE` go last.
//! - Per table, the 5c planner writes the statements: MySQL one merged
//!   `ALTER TABLE` (its key drops, key adds and column drops apart), PostgreSQL
//!   one statement per clause, SQLite in place or a rebuild, the rebuilds framed
//!   once by the pragma lines.
//! - PostgreSQL `ADD VALUE` statements run first, in their own transaction, when
//!   another statement uses a new value: it cannot be used before it commits.
//!
//! Pure: the same input gives the same text and hash.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::diff::{
    Change, DataLoss, DiffItem, DiffKind, DiffObject, ItemId, ObjectDef, SchemaDiff,
};
use super::edits::{StepKind, SyncEdit, SyncGroup, TargetDesigns, items_to_edits};
use crate::common::{sql_ident, sql_table};
use crate::ddl;
use crate::design::{
    ChildAction, DesignEdit, DesignMode, DesignPlan, DesignWarning, Increment, Rule, RunMode,
    StatementPlan, TableDesign, checked_action, is_count_check, plan_design_for,
    sqlite_pragma_frame,
};
use crate::error::{Error, Result};
use crate::model::DialectKind;

/// One change of the Sync Script list.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncItem {
    #[serde(default)]
    pub id: ItemId,
    #[serde(default)]
    pub group: SyncGroup,
    #[serde(default)]
    pub kind: DiffKind,
    #[serde(default)]
    pub object: DiffObject,
    /// The list's text, such as `DROP COLUMN invoices.fax`.
    #[serde(default)]
    pub line: String,
    /// The table it changes, or the enum.
    #[serde(default)]
    pub table: Option<String>,
    /// In the script, after the closure over `needs`.
    #[serde(default)]
    pub ticked: bool,
    #[serde(default)]
    pub needs: Vec<ItemId>,
    #[serde(default)]
    pub loses_data: bool,
    #[serde(default)]
    pub data_loss: Option<DataLoss>,
    /// Why Contura cannot script it, or `None`.
    #[serde(default)]
    pub not_scriptable: Option<String>,
}

/// One statement of the script, exactly as Apply runs it.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatement {
    #[serde(default)]
    pub sql: String,
    /// The items it carries out (a MySQL merged `ALTER TABLE` carries several).
    #[serde(default)]
    pub items: Vec<ItemId>,
    #[serde(default)]
    pub group: SyncGroup,
    /// False for the SQLite pragma lines and the checks.
    #[serde(default)]
    pub writes: bool,
    #[serde(default)]
    pub drops_data: bool,
    /// The qualified object it changes, such as `billing.invoices.fax`.
    #[serde(default)]
    pub object: Option<String>,
}

/// How Apply runs the script: `Transaction` on PostgreSQL and SQLite,
/// `Sequential` on MySQL, `CopyOnly` when a ticked item cannot be scripted.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SyncMode {
    #[default]
    Transaction,
    Sequential,
    CopyOnly {
        reason: String,
    },
}

/// What Apply needs on the target. `plan_sync` cannot know the Connection, so it
/// says `Ok`; the service sets the verdict.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SyncVerdict {
    #[default]
    Ok,
    ReadOnly,
    NeedsConfirmation,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncPlan {
    /// Every item of the diff in group order, ticked or not.
    #[serde(default)]
    pub items: Vec<SyncItem>,
    /// The ticked items' statements, in run order.
    #[serde(default)]
    pub statements: Vec<SyncStatement>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub mode: SyncMode,
    /// The line under the script.
    #[serde(default)]
    pub line: String,
    #[serde(default)]
    pub verdict: SyncVerdict,
    /// SHA-256 of the statements' text, in order.
    #[serde(default)]
    pub hash: String,
    /// PostgreSQL: the `ADD VALUE` statements commit on their own before the
    /// rest runs, so the script is not one transaction (R13).
    #[serde(default, rename = "enumValuesFirst")]
    pub enum_values_split: bool,
    /// PostgreSQL: this many leading statements (`ADD VALUE`) commit on their
    /// own before the rest runs. Never taken from the UI.
    #[serde(skip)]
    pub enum_values_first: usize,
    /// SQLite: the statements are framed by `sqlite_pragma_frame`.
    #[serde(skip)]
    pub sqlite_pragmas: bool,
    #[serde(skip)]
    dialect: Option<DialectKind>,
    /// What Copy script, Save and Open in editor put around the statements (`ddl::script_frame`).
    #[serde(default)]
    pub frame: crate::ddl::ScriptFrame,
}

impl SyncPlan {
    /// The statement lists `Dialect::apply_statements` runs, one after another:
    /// on PostgreSQL the enum values first when they must commit first. A
    /// copy-only plan is refused.
    pub fn runs(&self) -> Result<Vec<StatementPlan>> {
        if let SyncMode::CopyOnly { reason } = &self.mode {
            return Err(Error::InvalidInput(reason.clone()));
        }
        let all: Vec<String> = self.statements.iter().map(|s| s.sql.clone()).collect();
        if all.is_empty() {
            return Ok(Vec::new());
        }
        let dialect = self
            .dialect
            .ok_or_else(|| Error::InvalidInput("Plan the Sync Script again.".into()))?;
        let one = |statements: Vec<String>, mode| StatementPlan {
            statements,
            mode,
            sqlite_pragmas: false,
        };
        Ok(match dialect {
            DialectKind::MySql => vec![one(all, RunMode::Sequential)],
            DialectKind::Sqlite => vec![StatementPlan {
                sqlite_pragmas: self.sqlite_pragmas,
                ..one(all, RunMode::Transaction)
            }],
            DialectKind::Postgres => {
                let first = self.enum_values_first.min(all.len());
                if first == 0 || first == all.len() {
                    vec![one(all, RunMode::Transaction)]
                } else {
                    vec![
                        one(all[..first].to_vec(), RunMode::Transaction),
                        one(all[first..].to_vec(), RunMode::Transaction),
                    ]
                }
            }
        })
    }
}

// ---------------------------------------------------------------------------
// Items: their group and list line.

/// The group an item is listed in: removed things and changed indexes, keys and
/// primary keys under Drop (a change drops first), other changes under Change,
/// added things under Create.
pub fn item_group(item: &DiffItem) -> SyncGroup {
    match (item.kind, item.object) {
        (DiffKind::Removed, _) => SyncGroup::Drop,
        (DiffKind::Added, _) => SyncGroup::Create,
        (_, DiffObject::Index | DiffObject::ForeignKey | DiffObject::PrimaryKey) => SyncGroup::Drop,
        _ => SyncGroup::Change,
    }
}

/// Where an item sits inside its group in the list, following the script.
fn list_rank(item: &DiffItem) -> u8 {
    use DiffObject as O;
    match (item_group(item), item.object) {
        (SyncGroup::Drop, O::ForeignKey) => 0,
        (SyncGroup::Drop, O::Index | O::PrimaryKey) => 1,
        (SyncGroup::Drop, O::Column) => 2,
        (SyncGroup::Drop, O::Table) => 3,
        (SyncGroup::Drop, O::Enum) => 4,
        (SyncGroup::Change, O::Enum) => 0,
        (SyncGroup::Change, O::Column) => 1,
        (SyncGroup::Change, _) => 2,
        (SyncGroup::Create, O::Enum) => 0,
        (SyncGroup::Create, O::Table) => 1,
        (SyncGroup::Create, O::Column) => 2,
        (SyncGroup::Create, O::Index | O::PrimaryKey) => 3,
        (SyncGroup::Create, O::ForeignKey) => 4,
    }
}

/// The list's line for an item, such as `DROP COLUMN invoices.fax`,
/// `CREATE TABLE refunds` or `ADD VALUE invoice_status 'written_off'`.
pub fn item_line(item: &DiffItem) -> String {
    let p = &item.path;
    let owned = |name: &str| match &p.table {
        Some(t) if name.starts_with('(') => format!("{t} {name}"),
        Some(t) => format!("{t}.{name}"),
        None => name.to_string(),
    };
    let quoted = |values: &[String]| {
        values
            .iter()
            .map(|v| format!("'{}'", v.replace('\'', "''")))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let (verb, what) = match (item.object, item.kind) {
        (DiffObject::Table, DiffKind::Added) => ("CREATE TABLE", p.name.clone()),
        (DiffObject::Table, DiffKind::Removed) => ("DROP TABLE", p.name.clone()),
        (DiffObject::Table, DiffKind::Changed) => ("COMMENT ON TABLE", p.name.clone()),
        (DiffObject::Column, DiffKind::Added) => ("ADD COLUMN", owned(&p.name)),
        (DiffObject::Column, DiffKind::Removed) => ("DROP COLUMN", owned(&p.name)),
        (DiffObject::Column, DiffKind::Changed) => return column_line(item, &owned(&p.name)),
        (DiffObject::PrimaryKey, DiffKind::Added) => ("ADD PRIMARY KEY", owned(&p.name)),
        (DiffObject::PrimaryKey, DiffKind::Removed) => ("DROP PRIMARY KEY", owned(&p.name)),
        (DiffObject::PrimaryKey, DiffKind::Changed) => ("REPLACE PRIMARY KEY", owned(&p.name)),
        (DiffObject::Index, DiffKind::Added) => ("CREATE INDEX", owned(&p.name)),
        (DiffObject::Index, DiffKind::Removed) => ("DROP INDEX", owned(&p.name)),
        (DiffObject::Index, DiffKind::Changed) => ("REPLACE INDEX", owned(&p.name)),
        (DiffObject::ForeignKey, DiffKind::Added) => ("ADD FOREIGN KEY", owned(&p.name)),
        (DiffObject::ForeignKey, DiffKind::Removed) => ("DROP FOREIGN KEY", owned(&p.name)),
        (DiffObject::ForeignKey, DiffKind::Changed) => ("REPLACE FOREIGN KEY", owned(&p.name)),
        (DiffObject::Enum, DiffKind::Added) => ("CREATE TYPE", p.name.clone()),
        (DiffObject::Enum, DiffKind::Removed) => ("DROP TYPE", p.name.clone()),
        (DiffObject::Enum, DiffKind::Changed) => {
            for ch in &item.changes {
                if let Change::EnumValues {
                    added,
                    removed,
                    reordered,
                } = ch
                {
                    let one = |v: &[String]| if v.len() == 1 { "value" } else { "values" };
                    if !removed.is_empty() {
                        return format!("Remove {} {} {}", p.name, one(removed), quoted(removed));
                    }
                    if *reordered && added.is_empty() {
                        return format!("Reorder {} values", p.name);
                    }
                    return format!("ADD VALUE {} {}", p.name, quoted(added));
                }
            }
            ("ALTER TYPE", p.name.clone())
        }
    };
    format!("{verb} {what}")
}

/// A changed column's line: the type change when there is one, else the one
/// thing that changes, else `ALTER COLUMN t.c`.
fn column_line(item: &DiffItem, name: &str) -> String {
    for ch in &item.changes {
        if let Change::Type { to, .. } = ch {
            return format!("ALTER COLUMN {name} TYPE {to}");
        }
    }
    match &item.changes[..] {
        [Change::Default { to: Some(v), .. }] => format!("SET DEFAULT {name} {v}"),
        [Change::Default { to: None, .. }] => format!("DROP DEFAULT {name}"),
        [Change::Nullable { to: false, .. }] => format!("SET NOT NULL {name}"),
        [Change::Nullable { to: true, .. }] => format!("DROP NOT NULL {name}"),
        [Change::Note { .. }] => format!("COMMENT ON COLUMN {name}"),
        _ => format!("ALTER COLUMN {name}"),
    }
}

/// The qualified object an item changes: `schema.table.column` for a column,
/// `schema.table` for a table, index or key, `schema.enum` for an enum.
fn object_name(item: &DiffItem) -> String {
    let p = &item.path;
    let mut parts: Vec<&str> = p.schema.iter().map(String::as_str).collect();
    match item.object {
        DiffObject::Column => {
            parts.extend(p.table.as_deref());
            parts.push(&p.name);
        }
        DiffObject::Table | DiffObject::Enum => parts.push(&p.name),
        _ => parts.push(p.table.as_deref().unwrap_or(&p.name)),
    }
    parts.join(".")
}

// ---------------------------------------------------------------------------
// Selection.

fn needs_of(diff: &SchemaDiff) -> BTreeMap<&ItemId, &[ItemId]> {
    diff.items
        .iter()
        .map(|i| (&i.id, i.needs.as_slice()))
        .collect()
}

/// `picked` with everything it needs, transitively (ticking ticks what an item
/// needs). Ids the diff does not have are left out.
pub fn selection_closure<'a>(
    diff: &SchemaDiff,
    picked: impl IntoIterator<Item = &'a ItemId>,
) -> BTreeSet<ItemId> {
    let needs = needs_of(diff);
    let mut out = BTreeSet::new();
    let mut todo: Vec<&ItemId> = picked.into_iter().collect();
    while let Some(id) = todo.pop() {
        let Some(n) = needs.get(id) else { continue };
        if out.insert(id.clone()) {
            todo.extend(n.iter());
        }
    }
    out
}

/// Ticks (`on`) or unticks `id` in `ticked`: ticking also ticks what it needs,
/// unticking also unticks every item that needs it.
pub fn toggle(
    diff: &SchemaDiff,
    ticked: &BTreeSet<ItemId>,
    id: &ItemId,
    on: bool,
) -> BTreeSet<ItemId> {
    let mut out = ticked.clone();
    if !diff.items.iter().any(|i| &i.id == id) {
        return out;
    }
    if on {
        out.extend(selection_closure(diff, [id]));
        return out;
    }
    let mut gone: Vec<ItemId> = vec![id.clone()];
    out.remove(id);
    while let Some(g) = gone.pop() {
        for i in &diff.items {
            if i.needs.contains(&g) && out.remove(&i.id) {
                gone.push(i.id.clone());
            }
        }
    }
    out
}

/// Every item except `excluded` and what needs them, transitively.
fn closed_without(diff: &SchemaDiff, excluded: &BTreeSet<&ItemId>) -> BTreeSet<ItemId> {
    let mut out: BTreeSet<ItemId> = diff
        .items
        .iter()
        .filter(|i| !excluded.contains(&i.id))
        .map(|i| i.id.clone())
        .collect();
    loop {
        let orphans: Vec<ItemId> = diff
            .items
            .iter()
            .filter(|i| out.contains(&i.id) && i.needs.iter().any(|n| !out.contains(n)))
            .map(|i| i.id.clone())
            .collect();
        if orphans.is_empty() {
            return out;
        }
        for o in orphans {
            out.remove(&o);
        }
    }
}

/// The default selection: every item except data-loss items, the `blocked` ones
/// Contura cannot script, and what needs them.
fn default_selection(diff: &SchemaDiff, blocked: &BTreeMap<ItemId, String>) -> BTreeSet<ItemId> {
    let excluded: BTreeSet<&ItemId> = diff
        .items
        .iter()
        .filter(|i| i.loses_data)
        .map(|i| &i.id)
        .chain(blocked.keys())
        .collect();
    closed_without(diff, &excluded)
}

// ---------------------------------------------------------------------------
// The plan.

/// The Sync Script for `selection` (`None`: the default selection), closed over
/// `needs`, on a target whose changed tables `designs` holds.
pub fn plan_sync(
    diff: &SchemaDiff,
    selection: Option<&[ItemId]>,
    designs: &TargetDesigns,
    dialect: DialectKind,
) -> SyncPlan {
    let cx = Cx {
        diff,
        designs,
        d: dialect,
        needs: needs_of(diff),
    };
    let mut blocked = cx.blocked();
    let (ticked, built) = match selection {
        Some(ids) => {
            let ticked = selection_closure(diff, ids);
            let built = cx.build(&ticked);
            (ticked, built)
        }
        // A reason found only for this selection unticks the item and what needs
        // it, so the default script can always be applied.
        None => loop {
            let ticked = default_selection(diff, &blocked);
            let built = cx.build(&ticked);
            let fresh: Vec<(ItemId, String)> = built
                .failed
                .iter()
                .filter(|(id, _)| ticked.contains(*id) && !blocked.contains_key(*id))
                .map(|(id, r)| (id.clone(), r.clone()))
                .collect();
            if fresh.is_empty() {
                break (ticked, built);
            }
            blocked.extend(fresh);
        },
    };
    cx.assemble(&ticked, &blocked, built)
}

/// Run-order ranks before the dependency pass. PostgreSQL and SQLite: drops,
/// changes, creates as the spec orders them. MySQL: key drops, then one merged
/// `ALTER TABLE` per table, the creates, the key adds, then `DROP COLUMN` and
/// `DROP TABLE` last.
mod rank {
    pub const DROP_KEY: u8 = 0;
    pub const DROP_INDEX: u8 = 1;
    pub const MYSQL_TABLE: u8 = 1;
    pub const DROP_COLUMN: u8 = 2;
    pub const DROP_TABLE: u8 = 3;
    pub const DROP_TYPE: u8 = 4;
    pub const ADD_VALUE: u8 = 5;
    pub const CHANGE: u8 = 6;
    pub const COMMENT: u8 = 7;
    pub const CREATE_TYPE: u8 = 8;
    pub const CREATE_TABLE: u8 = 9;
    pub const ADD_COLUMN: u8 = 10;
    pub const ADD_INDEX: u8 = 11;
    pub const ADD_KEY: u8 = 12;
    pub const MYSQL_DROP_COLUMN: u8 = 13;
    pub const MYSQL_DROP_TABLE: u8 = 14;
}

/// An edit's rank; also the order a table's edits are planned in, so every
/// leading part of the list is a valid edit list on its own.
fn edit_rank(e: &DesignEdit) -> u8 {
    match e {
        DesignEdit::DropForeignKey { .. } => rank::DROP_KEY,
        DesignEdit::DropIndex { .. } => rank::DROP_INDEX,
        DesignEdit::DropColumn { .. } => rank::DROP_COLUMN,
        DesignEdit::ChangeColumn { .. }
        | DesignEdit::MoveColumn { .. }
        | DesignEdit::RenameIndex { .. } => rank::CHANGE,
        DesignEdit::TableComment { .. } => rank::COMMENT,
        DesignEdit::AddColumn { .. } => rank::ADD_COLUMN,
        DesignEdit::AddIndex { .. } => rank::ADD_INDEX,
        DesignEdit::AddForeignKey { .. } => rank::ADD_KEY,
    }
}

fn step_rank(d: DialectKind, kind: StepKind) -> u8 {
    match kind {
        StepKind::DropTable if d == DialectKind::MySql => rank::MYSQL_DROP_TABLE,
        StepKind::DropTable => rank::DROP_TABLE,
        StepKind::DropType => rank::DROP_TYPE,
        StepKind::AddEnumValue => rank::ADD_VALUE,
        StepKind::CreateType => rank::CREATE_TYPE,
        StepKind::CreateTable => rank::CREATE_TABLE,
        StepKind::AddForeignKey => rank::ADD_KEY,
    }
}

/// A statement under construction.
struct Stmt {
    sql: String,
    items: Vec<ItemId>,
    rank: u8,
    /// The script group it is shown under; `None` takes its items' groups
    /// (a MySQL merged `ALTER TABLE`, a SQLite rebuild).
    group: Option<SyncGroup>,
    /// Part of a SQLite rebuild, which carries every item of its table.
    block: bool,
}

/// The group a statement of `rank` is shown under.
fn rank_group(r: u8) -> SyncGroup {
    match r {
        rank::ADD_VALUE..=rank::COMMENT => SyncGroup::Change,
        rank::CREATE_TYPE..=rank::ADD_KEY => SyncGroup::Create,
        _ => SyncGroup::Drop,
    }
}

#[derive(Default)]
struct Built {
    stmts: Vec<Stmt>,
    /// Ticked items Contura cannot script with this selection, with the reason.
    failed: BTreeMap<ItemId, String>,
    warnings: Vec<String>,
    /// SQLite: the `foreign_keys` value the first rebuild restores, when a
    /// table is rebuilt.
    rebuild: Option<bool>,
}

impl Built {
    fn push(&mut self, sql: String, items: Vec<ItemId>, rank: u8, block: bool) {
        self.stmts.push(Stmt {
            sql,
            items,
            rank,
            group: (!block).then(|| rank_group(rank)),
            block,
        });
    }

    fn warn(&mut self, warnings: &[DesignWarning]) {
        for w in warnings {
            if let Some(text) = warning_text(w)
                && !self.warnings.contains(&text)
            {
                self.warnings.push(text);
            }
        }
    }
}

struct Cx<'a> {
    diff: &'a SchemaDiff,
    designs: &'a TargetDesigns,
    d: DialectKind,
    needs: BTreeMap<&'a ItemId, &'a [ItemId]>,
}

fn reason(e: &Error) -> String {
    match e {
        Error::InvalidInput(m) => m.clone(),
        other => other.to_string(),
    }
}

/// The items of `edits`, each once, in order.
fn items_of(edits: &[&SyncEdit]) -> Vec<ItemId> {
    let mut out: Vec<ItemId> = Vec::new();
    for e in edits {
        if !out.contains(&e.item) {
            out.push(e.item.clone());
        }
    }
    out
}

fn by_rank<'e>(edits: impl Iterator<Item = &'e SyncEdit>) -> Vec<&'e SyncEdit> {
    let mut out: Vec<&SyncEdit> = edits.collect();
    out.sort_by_key(|e| edit_rank(&e.edit));
    out
}

fn design_edits(edits: &[&SyncEdit]) -> Vec<DesignEdit> {
    edits.iter().map(|e| e.edit.clone()).collect()
}

impl Cx<'_> {
    /// The items Contura cannot script whatever the selection: the diff's own
    /// reasons, then what planning every other item finds.
    fn blocked(&self) -> BTreeMap<ItemId, String> {
        let mut out: BTreeMap<ItemId, String> = self
            .diff
            .items
            .iter()
            .filter_map(|i| i.scriptable.clone().err().map(|r| (i.id.clone(), r)))
            .collect();
        let probe = closed_without(self.diff, &out.keys().collect());
        for (id, r) in self.build(&probe).failed {
            if probe.contains(&id) {
                out.entry(id).or_insert(r);
            }
        }
        out
    }

    fn build(&self, ticked: &BTreeSet<ItemId>) -> Built {
        let edits = items_to_edits(self.diff, ticked, self.designs, self.d);
        let mut b = Built {
            failed: edits.not_scriptable.clone(),
            warnings: edits.notes.clone(),
            ..Built::default()
        };
        for (path, list) in &edits.tables {
            let Some(design) = self.designs.tables.iter().find(|t| &t.path == path) else {
                let r = format!(
                    "Contura could not read the table {} on the target.",
                    path.name
                );
                for e in list {
                    b.failed.insert(e.item.clone(), r.clone());
                }
                continue;
            };
            if self.d == DialectKind::MySql {
                self.mysql_table(&mut b, design, list);
            } else {
                self.table(&mut b, design, list);
            }
        }
        for step in &edits.steps {
            for sql in &step.statements {
                b.push(
                    sql.clone(),
                    step.items.clone(),
                    step_rank(self.d, step.kind),
                    false,
                );
            }
        }
        b
    }

    /// PostgreSQL and SQLite: the table's 5c plan, each statement with the item
    /// whose edit wrote it; a SQLite rebuild as one block.
    fn table(&self, b: &mut Built, design: &TableDesign, list: &[SyncEdit]) {
        let sorted = by_rank(list.iter());
        let edits = design_edits(&sorted);
        let items = items_of(&sorted);
        let plan = match plan_design_for(design, &edits, self.d) {
            Ok(p) => p,
            Err(e) => {
                self.fail_table(b, design, &sorted, &reason(&e));
                return;
            }
        };
        b.warn(&plan.warnings);
        if let DesignMode::CopyOnly { reason } = &plan.mode {
            self.fail_table(b, design, &sorted, reason);
            return;
        }
        if plan.before > 0 || plan.after > 0 {
            let n = plan.statements.len();
            b.rebuild.get_or_insert(plan.foreign_keys.unwrap_or(true));
            for sql in &plan.statements[plan.before..n - plan.after] {
                b.push(sql.clone(), items.clone(), rank::CHANGE, true);
            }
            return;
        }
        let owners = attribute(design, &edits, &plan, self.d);
        for (k, sql) in plan.statements.iter().enumerate() {
            let (its, r) = match &owners {
                Some(o) => (vec![sorted[o[k]].item.clone()], edit_rank(&edits[o[k]])),
                None => (items.clone(), rank::CHANGE),
            };
            b.push(sql.clone(), its.clone(), r, false);
            if self.d == DialectKind::Postgres
                && let Some(start) = identity_start(design, &edits, sql)
            {
                b.push(start, its, r, false);
            }
        }
    }

    /// MySQL: the key drops, one merged `ALTER TABLE` of the rest, the key adds
    /// (once every table they point at exists) and the column drops (last).
    fn mysql_table(&self, b: &mut Built, design: &TableDesign, list: &[SyncEdit]) {
        let keys_off = by_rank(
            list.iter()
                .filter(|e| matches!(e.edit, DesignEdit::DropForeignKey { .. })),
        );
        let columns_off = by_rank(
            list.iter()
                .filter(|e| matches!(e.edit, DesignEdit::DropColumn { .. })),
        );
        let keys_on: Vec<&SyncEdit> = list
            .iter()
            .filter(|e| matches!(e.edit, DesignEdit::AddForeignKey { .. }))
            .collect();
        let rest = by_rank(list.iter().filter(|e| {
            !matches!(
                e.edit,
                DesignEdit::DropForeignKey { .. }
                    | DesignEdit::DropColumn { .. }
                    | DesignEdit::AddForeignKey { .. }
            )
        }));
        self.mysql_part(b, design, &keys_off, rank::DROP_KEY);
        self.mysql_part(b, design, &rest, rank::MYSQL_TABLE);
        self.mysql_keys(b, design, &keys_on);
        self.mysql_part(b, design, &columns_off, rank::MYSQL_DROP_COLUMN);
    }

    fn mysql_part(&self, b: &mut Built, design: &TableDesign, part: &[&SyncEdit], r: u8) {
        if part.is_empty() {
            return;
        }
        match plan_design_for(design, &design_edits(part), self.d) {
            Ok(plan) => {
                b.warn(&plan.warnings);
                let items = items_of(part);
                for sql in plan.statements {
                    b.push(sql, items.clone(), r, false);
                    if r == rank::MYSQL_TABLE
                        && let Some(s) = b.stmts.last_mut()
                    {
                        s.group = None;
                    }
                }
            }
            Err(e) => self.fail_table(b, design, part, &reason(&e)),
        }
    }

    /// One `ALTER TABLE` adding the table's new keys, written as 5c writes them.
    fn mysql_keys(&self, b: &mut Built, design: &TableDesign, keys: &[&SyncEdit]) {
        let my = DialectKind::MySql;
        let table =
            sql_table(my, &design.path).unwrap_or_else(|_| sql_ident(my, &design.path.name));
        let mut clauses = Vec::new();
        let mut items = Vec::new();
        for e in keys {
            let DesignEdit::AddForeignKey { key } = &e.edit else {
                continue;
            };
            let mut target = key.target.clone();
            if target.database.is_empty() {
                target.database = design.path.database.clone();
            }
            let actions = checked_action(&key.on_delete)
                .and_then(|d| checked_action(&key.on_update).map(|u| (d, u)));
            let fk = actions.and_then(|(on_delete, on_update)| {
                Ok(ddl::foreign_key_sql(
                    my,
                    &ddl::FkSql {
                        name: (!key.name.trim().is_empty()).then(|| key.name.clone()),
                        columns: key.columns.clone(),
                        target: sql_table(my, &target)?,
                        target_columns: key.target_columns.clone(),
                        on_delete,
                        on_update,
                    },
                ))
            });
            match fk {
                Ok(fk) => {
                    clauses.push(format!("ADD {fk}"));
                    if !items.contains(&e.item) {
                        items.push(e.item.clone());
                    }
                }
                Err(err) => {
                    b.failed.insert(e.item.clone(), reason(&err));
                }
            }
        }
        if !clauses.is_empty() {
            b.push(
                format!("ALTER TABLE {table}\n  {}", clauses.join(",\n  ")),
                items,
                rank::ADD_KEY,
                false,
            );
        }
    }

    /// A table's edits cannot be planned (or only copied): each item that fails
    /// with what it needs from this table gets its own reason; when none fails
    /// alone, every item gets the table's.
    fn fail_table(&self, b: &mut Built, design: &TableDesign, edits: &[&SyncEdit], whole: &str) {
        let items = items_of(edits);
        let mut any = false;
        for it in &items {
            let mut want: BTreeSet<&ItemId> = BTreeSet::new();
            let mut todo = vec![it];
            while let Some(x) = todo.pop() {
                if items.contains(x) && want.insert(x) {
                    todo.extend(self.needs.get(x).into_iter().flat_map(|n| n.iter()));
                }
            }
            let alone: Vec<DesignEdit> = edits
                .iter()
                .filter(|e| want.contains(&e.item))
                .map(|e| e.edit.clone())
                .collect();
            let failure = match plan_design_for(design, &alone, self.d) {
                Ok(p) => match p.mode {
                    DesignMode::CopyOnly { reason } => Some(reason),
                    _ => None,
                },
                Err(e) => Some(reason(&e)),
            };
            if let Some(r) = failure {
                b.failed.insert(it.clone(), r);
                any = true;
            }
        }
        if !any {
            for it in items {
                b.failed.insert(it, whole.to_string());
            }
        }
    }

    fn assemble(
        &self,
        ticked: &BTreeSet<ItemId>,
        blocked: &BTreeMap<ItemId, String>,
        built: Built,
    ) -> SyncPlan {
        let mut stmts = ordered(built.stmts, &self.needs);
        let first = if self.d == DialectKind::Postgres {
            values_first(&mut stmts, self.diff)
        } else {
            0
        };
        let by_id: BTreeMap<&ItemId, &DiffItem> =
            self.diff.items.iter().map(|i| (&i.id, i)).collect();
        let mut groups: Vec<Option<SyncGroup>> = Vec::with_capacity(stmts.len() + 3);
        let mut statements: Vec<SyncStatement> = Vec::with_capacity(stmts.len() + 3);
        for s in stmts {
            let (st, g) = statement(s, &by_id);
            statements.push(st);
            groups.push(g);
        }
        let framed = self.d == DialectKind::Sqlite && built.rebuild.is_some();
        if framed && !statements.is_empty() {
            let body: Vec<String> = statements.iter().map(|s| s.sql.clone()).collect();
            let all = sqlite_pragma_frame(body, built.rebuild.unwrap_or(true));
            let line = |sql: &String| SyncStatement {
                sql: sql.clone(),
                ..SyncStatement::default()
            };
            let n = all.len();
            statements.insert(0, line(&all[0]));
            groups.insert(0, None);
            statements.push(line(&all[n - 2]));
            statements.push(line(&all[n - 1]));
            groups.extend([None, None]);
        }
        // A line with no item (a pragma line) sits in its neighbour's group.
        let mut last = groups.iter().flatten().next().copied();
        for (s, g) in statements.iter_mut().zip(&groups) {
            if let Some(g) = g {
                last = Some(*g);
            }
            s.group = last.unwrap_or_default();
        }

        let reasons = |id: &ItemId| blocked.get(id).or_else(|| built.failed.get(id)).cloned();
        let mut items: Vec<(&DiffItem, SyncItem)> = self
            .diff
            .items
            .iter()
            .map(|i| {
                (
                    i,
                    SyncItem {
                        id: i.id.clone(),
                        group: item_group(i),
                        kind: i.kind,
                        object: i.object,
                        line: item_line(i),
                        table: Some(i.path.table.clone().unwrap_or_else(|| i.path.name.clone())),
                        ticked: ticked.contains(&i.id),
                        needs: i.needs.clone(),
                        loses_data: i.loses_data,
                        data_loss: i.data_loss,
                        not_scriptable: reasons(&i.id),
                    },
                )
            })
            .collect();
        items.sort_by_key(|(i, s)| (s.group, list_rank(i)));
        let items: Vec<SyncItem> = items.into_iter().map(|(_, s)| s).collect();

        let copy = items
            .iter()
            .find(|i| i.ticked && i.not_scriptable.is_some())
            .and_then(|i| i.not_scriptable.clone());
        let mode = match copy {
            Some(reason) => SyncMode::CopyOnly { reason },
            None if self.d == DialectKind::MySql => SyncMode::Sequential,
            None => SyncMode::Transaction,
        };
        let line = match &mode {
            SyncMode::CopyOnly { reason } => reason.clone(),
            _ if statements.is_empty() => "Nothing to apply.".to_string(),
            SyncMode::Sequential if statements.len() == 1 => {
                "MySQL runs this statement. If it fails, nothing changes.".to_string()
            }
            SyncMode::Sequential => format!(
                "MySQL runs these {} statements one by one. If one fails, the ones before it stay applied.",
                grouped(statements.len())
            ),
            _ if first == 1 => "1 enum value is added first, in its own transaction.".to_string(),
            _ if first > 1 => format!(
                "{} enum values are added first, in their own transaction.",
                grouped(first)
            ),
            _ => "Apply runs exactly this, in one transaction.".to_string(),
        };
        SyncPlan {
            hash: hash(&statements),
            items,
            statements,
            warnings: built.warnings,
            mode,
            line,
            verdict: SyncVerdict::Ok,
            enum_values_split: first > 0,
            enum_values_first: first,
            sqlite_pragmas: framed,
            dialect: Some(self.d),
            frame: crate::ddl::script_frame(self.d),
        }
    }
}

/// Which edit of `edits` wrote each statement of `full`, found by planning each
/// leading part of the list: the statements a part adds are its last edit's.
/// `None` when the plans do not grow that way.
fn attribute(
    design: &TableDesign,
    edits: &[DesignEdit],
    full: &DesignPlan,
    d: DialectKind,
) -> Option<Vec<usize>> {
    let mut pool: Vec<(String, usize)> = Vec::new();
    let mut prev: Vec<String> = Vec::new();
    for k in 0..edits.len() {
        let p = plan_design_for(design, &edits[..=k], d).ok()?;
        if p.before != 0 || p.after != 0 {
            return None;
        }
        let mut added = p.statements.clone();
        for s in &prev {
            let at = added.iter().position(|x| x == s)?;
            added.remove(at);
        }
        pool.extend(added.into_iter().map(|s| (s, k)));
        prev = p.statements;
    }
    let mut owners = Vec::with_capacity(full.statements.len());
    for s in &full.statements {
        let at = pool.iter().position(|(x, _)| x == s)?;
        owners.push(pool.remove(at).1);
    }
    pool.is_empty().then_some(owners)
}

/// PostgreSQL: after `ADD GENERATED BY DEFAULT AS IDENTITY` on a column that had
/// no increment, the identity starts after the largest value already in it, so
/// the next insert does not collide. A `DO` block, because a `SELECT setval`
/// returns a row, which stops the runner.
fn identity_start(design: &TableDesign, edits: &[DesignEdit], sql: &str) -> Option<String> {
    let pg = DialectKind::Postgres;
    let table = sql_table(pg, &design.path).ok()?;
    edits.iter().find_map(|e| {
        let DesignEdit::ChangeColumn { name, column } = e else {
            return None;
        };
        let base = design.columns.iter().find(|c| &c.name == name)?;
        if !column.increment || base.increment != Increment::None {
            return None;
        }
        let c = sql_ident(pg, &column.name);
        let add =
            format!("ALTER TABLE {table} ALTER COLUMN {c} ADD GENERATED BY DEFAULT AS IDENTITY");
        (sql == add).then(|| {
            let body = format!(
                "BEGIN PERFORM setval(pg_get_serial_sequence({}, {}), \
                 greatest(coalesce(max({c}), 0) + 1, 1), false) FROM {table}; END",
                ddl::lit(pg, &table),
                ddl::lit(pg, &column.name),
            );
            dollar_quoted(&body)
        })
    })
}

/// `DO <tag><body><tag>` with a dollar-quote tag the body does not hold, so no
/// name in the body can end the quote early.
fn dollar_quoted(body: &str) -> String {
    let tag = (0..)
        .map(|n| match n {
            0 => "$contura$".to_string(),
            n => format!("$contura{n}$"),
        })
        .find(|t| !body.contains(t.as_str()))
        .expect("a free tag");
    format!("DO {tag}{body}{tag}")
}

/// The statements by rank, then each moved after the statements of what its
/// items need (keeping the order otherwise). Statements in a cycle keep the
/// rank order.
fn ordered(mut stmts: Vec<Stmt>, needs: &BTreeMap<&ItemId, &[ItemId]>) -> Vec<Stmt> {
    stmts.sort_by_key(|s| s.rank);
    let n = stmts.len();
    let mut carriers: BTreeMap<&ItemId, Vec<usize>> = BTreeMap::new();
    for (i, s) in stmts.iter().enumerate() {
        for it in &s.items {
            carriers.entry(it).or_default().push(i);
        }
    }
    let mut preds: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); n];
    for (i, s) in stmts.iter().enumerate() {
        for it in &s.items {
            for need in needs.get(it).copied().unwrap_or_default() {
                if s.items.contains(need) {
                    continue;
                }
                for &j in carriers.get(need).map(Vec::as_slice).unwrap_or_default() {
                    if j != i {
                        preds[i].insert(j);
                    }
                }
            }
        }
    }
    // Statements that need each other in a cycle keep their rank order: the
    // edges inside a cycle are dropped.
    let comp = components(&preds);
    for (i, p) in preds.iter_mut().enumerate() {
        p.retain(|&j| comp[j] != comp[i]);
    }
    let mut succs: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (i, p) in preds.iter().enumerate() {
        for &j in p {
            succs[j].push(i);
        }
    }
    let mut left: Vec<usize> = preds.iter().map(BTreeSet::len).collect();
    let mut ready: BTreeSet<usize> = (0..n).filter(|&i| left[i] == 0).collect();
    let mut placed = vec![false; n];
    let mut order = Vec::with_capacity(n);
    while order.len() < n {
        let i = match ready.pop_first() {
            Some(i) => i,
            None => (0..n).find(|&i| !placed[i]).expect("one is left"),
        };
        if placed[i] {
            continue;
        }
        placed[i] = true;
        order.push(i);
        for &k in &succs[i] {
            if !placed[k] {
                left[k] -= 1;
                if left[k] == 0 {
                    ready.insert(k);
                }
            }
        }
    }
    let mut slots: Vec<Option<Stmt>> = stmts.into_iter().map(Some).collect();
    order.into_iter().filter_map(|i| slots[i].take()).collect()
}

/// The strongly connected component of each statement (Kosaraju, without
/// recursion), where `preds[i]` holds the statements that must run before `i`.
fn components(preds: &[BTreeSet<usize>]) -> Vec<usize> {
    let n = preds.len();
    let mut succs: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (i, p) in preds.iter().enumerate() {
        for &j in p {
            succs[j].push(i);
        }
    }
    let mut seen = vec![false; n];
    let mut finished = Vec::with_capacity(n);
    for start in 0..n {
        if seen[start] {
            continue;
        }
        seen[start] = true;
        let mut stack = vec![(start, 0usize)];
        while let Some((v, k)) = stack.pop() {
            if let Some(&w) = succs[v].get(k) {
                stack.push((v, k + 1));
                if !seen[w] {
                    seen[w] = true;
                    stack.push((w, 0));
                }
            } else {
                finished.push(v);
            }
        }
    }
    let mut comp = vec![usize::MAX; n];
    for (c, &start) in finished.iter().rev().enumerate() {
        if comp[start] != usize::MAX {
            continue;
        }
        comp[start] = c;
        let mut stack = vec![start];
        while let Some(v) = stack.pop() {
            for &w in &preds[v] {
                if comp[w] == usize::MAX {
                    comp[w] = c;
                    stack.push(w);
                }
            }
        }
    }
    comp
}

/// `ALTER TYPE <type> ADD VALUE '<v>' ...`: the type and the quoted value. A
/// value holding a backslash is an `E'..'` string (`pg_string`); its value is
/// given from the opening quote, as `literals` finds it in other statements.
fn added_value(sql: &str) -> Option<(&str, &str)> {
    let rest = sql.strip_prefix("ALTER TYPE ")?;
    let at = rest.find(" ADD VALUE ")?;
    let (ty, tail) = (&rest[..at], &rest[at + " ADD VALUE ".len()..]);
    let (escaped, tail) = match tail.strip_prefix(['E', 'e']) {
        Some(t) => (true, t),
        None => (false, tail),
    };
    let bytes = tail.as_bytes();
    if bytes.first() != Some(&b'\'') {
        return None;
    }
    let mut i = 1;
    while i < bytes.len() {
        if escaped && bytes[i] == b'\\' {
            i += 2;
            continue;
        }
        if bytes[i] == b'\'' {
            if bytes.get(i + 1) == Some(&b'\'') {
                i += 2;
                continue;
            }
            return Some((ty, &tail[..=i]));
        }
        i += 1;
    }
    None
}

/// The last part of a type name, unquoted, lower case: `"billing"."mood"` is
/// `mood`.
fn bare_type(name: &str) -> String {
    let mut name = name.trim();
    while let Some(element) = name.strip_suffix("[]") {
        name = element.trim_end();
    }
    name.rsplit('.')
        .next()
        .unwrap_or_default()
        .trim_matches('"')
        .to_lowercase()
}

/// The string literals of a statement, each with its quotes (`'it''s'`).
fn literals(sql: &str) -> Vec<&str> {
    let bytes = sql.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\'' {
            i += 1;
            continue;
        }
        let start = i;
        i += 1;
        while i < bytes.len() {
            if bytes[i] == b'\'' {
                if bytes.get(i + 1) == Some(&b'\'') {
                    i += 2;
                    continue;
                }
                break;
            }
            i += 1;
        }
        let end = (i + 1).min(bytes.len());
        out.push(&sql[start..end]);
        i = end;
    }
    out
}

/// The text of each string literal of a statement, unquoted; an array literal
/// (`'{a,"b"}'`) also gives each of its elements.
fn literal_values(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    for lit in literals(sql) {
        let inner = lit
            .strip_prefix('\'')
            .and_then(|l| l.strip_suffix('\''))
            .unwrap_or(lit)
            .replace("''", "'");
        let elements = inner
            .strip_prefix('{')
            .and_then(|i| i.strip_suffix('}'))
            .map(|i| {
                i.split(',')
                    .map(|e| e.trim().trim_matches('"').to_string())
                    .collect::<Vec<_>>()
            });
        out.push(inner);
        out.extend(elements.into_iter().flatten());
    }
    out
}

/// Whether a statement can hold a value of any type in a condition: a partial
/// index or a CHECK.
fn has_condition(sql: &str) -> bool {
    let lower = sql.to_ascii_lowercase();
    let index = lower.trim_start().starts_with("create") && lower.contains(" index ");
    (index && lower.contains(" where ")) || lower.contains("check (") || lower.contains("check(")
}

/// Whether `item` is a column of the enum named `bare`, or a table with one.
fn uses_enum(item: &DiffItem, bare: &str) -> bool {
    let of = |c: &crate::schema_model::SmColumn| bare_type(&c.type_name) == bare;
    match &item.source_def {
        Some(ObjectDef::Column { def }) => of(def),
        Some(ObjectDef::Table { def }) => def.columns.iter().any(of),
        _ => false,
    }
}

/// PostgreSQL: when another statement uses a value an `ADD VALUE` adds, every
/// `ADD VALUE` moves to the front to commit on its own. A statement uses it when
/// it changes a column to that type, or when it holds the value as a whole
/// string literal (or an element of an array literal) and either carries a
/// column of that type or an array of it (or a table with one), names the
/// type, or is a partial index or a CHECK (R14). Returns how many lead.
fn values_first(stmts: &mut Vec<Stmt>, diff: &SchemaDiff) -> usize {
    let adds: Vec<usize> = (0..stmts.len())
        .filter(|&i| added_value(&stmts[i].sql).is_some())
        .collect();
    if adds.is_empty() {
        return 0;
    }
    let by_id: BTreeMap<&ItemId, &DiffItem> = diff.items.iter().map(|i| (&i.id, i)).collect();
    let added: Vec<(&str, String, String)> = adds
        .iter()
        .filter_map(|&i| added_value(&stmts[i].sql))
        .map(|(ty, value)| {
            let value = literal_values(value).into_iter().next().unwrap_or_default();
            (ty, bare_type(ty), value)
        })
        .collect();
    let used = stmts
        .iter()
        .enumerate()
        .filter(|(i, _)| !adds.contains(i))
        .any(|(_, s)| {
            let values = literal_values(&s.sql);
            added.iter().any(|(ty, bare, value)| {
                s.sql.contains(&format!("TYPE {ty}"))
                    || (values.contains(value)
                        && (s.sql.contains(ty)
                            || has_condition(&s.sql)
                            || s.items
                                .iter()
                                .filter_map(|id| by_id.get(id))
                                .any(|i| uses_enum(i, bare))))
            })
        });
    if !used {
        return 0;
    }
    let (front, back): (Vec<Stmt>, Vec<Stmt>) = std::mem::take(stmts)
        .into_iter()
        .partition(|s| added_value(&s.sql).is_some());
    let n = front.len();
    stmts.extend(front);
    stmts.extend(back);
    n
}

/// Whether a statement changes the target: not a pragma line, not a check.
fn writes(sql: &str) -> bool {
    let lower = sql.trim_start().to_ascii_lowercase();
    !(lower.starts_with("pragma") || is_count_check(&lower))
}

/// The statement as shown, and its group (`None` with no item).
fn statement(s: Stmt, by_id: &BTreeMap<&ItemId, &DiffItem>) -> (SyncStatement, Option<SyncGroup>) {
    let carried: Vec<&DiffItem> = s
        .items
        .iter()
        .filter_map(|i| by_id.get(i).copied())
        .collect();
    let group = s
        .group
        .or_else(|| carried.iter().map(|i| item_group(i)).min());
    let writes = writes(&s.sql);
    let lower = s.sql.trim_start().to_ascii_lowercase();
    // Where the values go: a rebuild's copy, a type change, a drop.
    let loses = |i: &&DiffItem| {
        i.loses_data
            && writes
            && if s.block {
                lower.starts_with("insert into")
            } else if i.kind == DiffKind::Changed {
                lower.contains(" type ")
                    || lower.contains("modify column")
                    || lower.contains("change column")
            } else {
                true
            }
    };
    let lossy = carried.iter().copied().find(|i| loses(i));
    let object = lossy.or(carried.first().copied()).map(object_name);
    (
        SyncStatement {
            drops_data: lossy.is_some(),
            sql: s.sql,
            items: s.items,
            group: group.unwrap_or_default(),
            writes,
            object,
        },
        group,
    )
}

/// SHA-256 of the statements' text in order, each prefixed by its length.
fn hash(statements: &[SyncStatement]) -> String {
    let mut h = Sha256::new();
    for s in statements {
        h.update((s.sql.len() as u64).to_le_bytes());
        h.update(s.sql.as_bytes());
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// `18402` as `18,402`.
fn grouped(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

// ---------------------------------------------------------------------------
// Warnings, worded as the Table Designer words them (src/design/warnings.ts).

fn rule_name(rule: Rule, name: &str) -> String {
    match rule {
        Rule::PrimaryKey => "the primary key".into(),
        Rule::Unique => format!("the unique index {name}"),
        Rule::ForeignKey => format!("the Foreign Key {name}"),
        Rule::NotNull => format!("the NOT NULL rule on {name}"),
    }
}

fn warning_text(w: &DesignWarning) -> Option<String> {
    Some(match w {
        DesignWarning::DropColumn { column } => {
            format!("Dropping {column} deletes its data in every row.")
        }
        DesignWarning::NarrowType {
            column,
            from,
            to,
            note,
        } => {
            let text = format!("Changing {column} from {from} to {to} can cut or round existing values.");
            match note {
                Some(n) => format!("{text} {n}"),
                None => text,
            }
        }
        DesignWarning::ExistingRows { rule, name } => match rule {
            Rule::NotNull => {
                format!("Making {name} required fails if a row holds NULL. Nothing is lost.")
            }
            Rule::Unique => format!(
                "A unique index on {name} fails if two rows share a value. Nothing is lost."
            ),
            Rule::PrimaryKey => "Adding the primary key fails if two rows share a value or a row holds NULL. Nothing is lost.".into(),
            Rule::ForeignKey => format!(
                "The Foreign Key {name} fails if a row points at a missing row. Nothing is lost."
            ),
        },
        DesignWarning::DropRule { rule, name } => format!(
            "Dropping {} removes a rule the data relies on.",
            rule_name(*rule, name)
        ),
        DesignWarning::RewriteLock { table } => format!(
            "PostgreSQL rewrites {table} and blocks reads and writes on it until this finishes."
        ),
        DesignWarning::RebuildCopy { table } => format!(
            "SQLite copies every row of {table} into a new table. A large table takes time and disk space."
        ),
        DesignWarning::RenameColumn { from, to } => format!(
            "Views, routines and applications that use {from} stop working until they use {to}."
        ),
        // The Sync Script's drop items carry their own row counts.
        DesignWarning::DropTable { .. } => return None,
        DesignWarning::ChildRows {
            table,
            child,
            action,
        } => match action {
            ChildAction::Delete => {
                format!("Dropping {table} also deletes the matching rows in {child}.")
            }
            ChildAction::Clear => format!(
                "Dropping {table} also clears the key in {child} on the matching rows, or fails if that key is required."
            ),
            ChildAction::SetDefault => format!(
                "Dropping {table} also sets the key in {child} to its default on the matching rows, or fails if that default is not NULL."
            ),
            ChildAction::Fail => {
                format!("Dropping {table} fails while rows in {child} point at it. Nothing is lost.")
            }
        },
    })
}

#[cfg(test)]
#[path = "script_tests.rs"]
mod tests;
