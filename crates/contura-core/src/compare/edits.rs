//! Diff items to edits. A changed table's items become the Table Designer's
//! `DesignEdit`s, which 5c's planner turns into DDL exactly as the designer
//! would (MySQL one merged `ALTER TABLE` with full restatement, PostgreSQL
//! `ALTER COLUMN .. TYPE .. USING`, SQLite in place or a rebuild). New and
//! removed tables, the Foreign Keys of new tables and PostgreSQL enums become
//! statements of their own.
//!
//! Enums: PostgreSQL adds values with `ALTER TYPE .. ADD VALUE` and cannot
//! remove or reorder them (the item is not scriptable); MySQL's enum is the
//! column's type, so a change is a `MODIFY`; SQLite's is a CHECK, so a change is
//! a 5c rebuild.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::diff::{Change, DiffItem, DiffKind, DiffObject, ItemId, ObjectDef, SchemaDiff};
use super::normalise::implies_increment;
use super::script::item_line;
use crate::common::{sql_ident, sql_table};
use crate::ddl;
use crate::design::{
    ColumnDraft, DesignEdit, ForeignKeyDraft, IndexDraft, Position, TableDesign, TableIndex,
    column_draft,
};
use crate::model::{DialectKind, ObjectPath};
use crate::schema_model::{SchemaModel, SmColumn, SmDefault, SmEnum, SmIndex, SmRef, SmTable};

/// The target's tables as `Dialect::table_design` reads them: the real names of
/// primary keys, unique indexes, indexes and Foreign Keys the snapshot hides.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TargetDesigns {
    /// The target database (the SQLite file's name on SQLite).
    pub database: String,
    pub tables: Vec<TableDesign>,
    /// Names already taken in the target schema beyond these tables' indexes:
    /// on PostgreSQL and SQLite every table and index name there, since index
    /// names are schema-wide. A name Contura makes for a new index avoids them.
    pub taken_names: Vec<String>,
}

impl TargetDesigns {
    /// The table `name` (in `schema`, when given): the exact name first, then
    /// the same name in another case.
    pub fn find(&self, schema: Option<&str>, name: &str) -> Option<&TableDesign> {
        let in_schema = |t: &&TableDesign| schema.is_none() || t.path.schema.as_deref() == schema;
        self.tables
            .iter()
            .filter(in_schema)
            .find(|t| t.path.name == name)
            .or_else(|| {
                self.tables
                    .iter()
                    .filter(in_schema)
                    .find(|t| t.path.name.eq_ignore_ascii_case(name))
            })
    }
}

/// The Sync Script's groups, in script order.
#[derive(
    Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash,
)]
#[serde(rename_all = "camelCase")]
pub enum SyncGroup {
    /// Foreign Keys, indexes and columns removed or changed, tables removed.
    Drop,
    /// Column changes, enum changes, notes.
    #[default]
    Change,
    /// Types, tables, columns, indexes and Foreign Keys added.
    Create,
}

/// One 5c edit of a changed table, with the item it comes from. A changed index,
/// key or primary key gives two: the drop (group Drop) and the add (Create).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncEdit {
    pub item: ItemId,
    pub group: SyncGroup,
    pub edit: DesignEdit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum StepKind {
    /// `DROP TABLE`.
    DropTable,
    /// PostgreSQL `DROP TYPE`.
    DropType,
    /// PostgreSQL `ALTER TYPE .. ADD VALUE`: it cannot be used until it commits.
    AddEnumValue,
    /// PostgreSQL `CREATE TYPE .. AS ENUM`.
    CreateType,
    /// `CREATE TABLE`, then its comments (PostgreSQL) and indexes.
    CreateTable,
    /// A Foreign Key of a new table (MySQL, PostgreSQL), added once every new
    /// table exists. SQLite writes them inside `CREATE TABLE`.
    AddForeignKey,
}

/// Statements that are not a 5c table edit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncStep {
    /// The items the statements carry out: a new SQLite table also carries its
    /// ticked Foreign Keys, which it writes inline.
    pub items: Vec<ItemId>,
    pub group: SyncGroup,
    pub kind: StepKind,
    /// The table, or the enum type (`name` is the type's).
    pub path: ObjectPath,
    /// One statement each, without a trailing `;`.
    pub statements: Vec<String>,
}

/// What the ticked items become.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncEdits {
    /// Per changed table (its real path), its 5c edits: drops, then changes, then
    /// adds, each group in item order.
    pub tables: BTreeMap<ObjectPath, Vec<SyncEdit>>,
    /// Drop steps (tables before what they need gone first, then types), then
    /// change steps, then create steps (types, tables in dependency order, the
    /// new tables' Foreign Keys).
    pub steps: Vec<SyncStep>,
    /// Ticked items Contura cannot script, with the reason.
    pub not_scriptable: BTreeMap<ItemId, String>,
    /// What writing a new table left out, such as an SQLite increment.
    pub notes: Vec<String>,
}

impl SyncEdits {
    /// The edit lists alone, per table, for `design::plan_design_for`.
    pub fn design_edits(&self) -> BTreeMap<ObjectPath, Vec<DesignEdit>> {
        self.tables
            .iter()
            .map(|(p, edits)| (p.clone(), edits.iter().map(|e| e.edit.clone()).collect()))
            .collect()
    }
}

/// The edits and statements that apply the ticked `selection` of `diff` to the
/// target. Pure: the same input gives the same output.
pub fn items_to_edits(
    diff: &SchemaDiff,
    selection: &BTreeSet<ItemId>,
    designs: &TargetDesigns,
    dialect: DialectKind,
) -> SyncEdits {
    let added_tables: BTreeSet<(Option<String>, String)> = diff
        .items
        .iter()
        .filter(|i| i.object == DiffObject::Table && i.kind == DiffKind::Added)
        .map(|i| (i.path.schema.clone(), i.path.name.clone()))
        .collect();
    let cx = Cx {
        d: dialect,
        designs,
        enums: &diff.source_enums,
        taken: RefCell::new(BTreeSet::new()),
    };
    cx.note_taken(added_tables.iter().map(|(_, t)| t.as_str()));
    let mut out = SyncEdits::default();
    let mut pieces: Vec<Piece> = Vec::new();
    let mut new_tables: Vec<&DiffItem> = Vec::new();
    let mut new_keys: Vec<&DiffItem> = Vec::new();
    for item in diff.items.iter().filter(|i| selection.contains(&i.id)) {
        if let Err(reason) = &item.scriptable {
            out.not_scriptable.insert(item.id.clone(), reason.clone());
            continue;
        }
        // `plan_sync` closes the selection first; any other caller gets no
        // statement that would fail for want of what it needs.
        if let Some(need) = item.needs.iter().find(|n| !selection.contains(n)) {
            let line = diff
                .items
                .iter()
                .find(|i| &i.id == need)
                .map(item_line)
                .unwrap_or_else(|| need.to_string());
            out.not_scriptable
                .insert(item.id.clone(), format!("Needs {line}"));
            continue;
        }
        let made = match (item.object, item.kind) {
            (DiffObject::Table, DiffKind::Added) => {
                new_tables.push(item);
                Ok(Vec::new())
            }
            (DiffObject::Table, DiffKind::Removed) => cx.drop_table(item),
            (DiffObject::Table, DiffKind::Changed) => cx.table_note(item),
            (DiffObject::Column, DiffKind::Added) => cx.add_column(item),
            (DiffObject::Column, DiffKind::Removed) => cx.drop_column(item),
            (DiffObject::Column, DiffKind::Changed) => cx.change_column(item),
            (DiffObject::PrimaryKey, _) => cx.primary_key(item),
            (DiffObject::Index, _) => cx.index(item),
            (DiffObject::ForeignKey, DiffKind::Added)
                if item.path.table.as_ref().is_some_and(|t| {
                    added_tables.contains(&(item.path.schema.clone(), t.clone()))
                }) =>
            {
                new_keys.push(item);
                Ok(Vec::new())
            }
            (DiffObject::ForeignKey, _) => cx.foreign_key(item),
            (DiffObject::Enum, _) => cx.enum_item(item),
        };
        match made {
            Ok(p) => pieces.extend(p),
            Err(reason) => {
                out.not_scriptable.insert(item.id.clone(), reason);
            }
        }
    }
    let created = cx.new_tables(&new_tables, &new_keys, &mut out);
    pieces.extend(created);

    let mut steps: Vec<SyncStep> = Vec::new();
    for piece in pieces {
        match piece {
            Piece::Edit(path, edit) => out.tables.entry(path).or_default().push(edit),
            Piece::Step(step) => steps.push(step),
        }
    }
    for edits in out.tables.values_mut() {
        edits.sort_by_key(|e| e.group);
    }
    out.steps = order_steps(steps, diff);
    out
}

enum Piece {
    Edit(ObjectPath, SyncEdit),
    Step(SyncStep),
}

type Made = Result<Vec<Piece>, String>;

/// Drop steps first (each table after the tables that must go before it, then
/// types), then change steps, then create steps (types, then tables as
/// `new_tables` ordered them, then Foreign Keys).
fn order_steps(steps: Vec<SyncStep>, diff: &SchemaDiff) -> Vec<SyncStep> {
    let needs: BTreeMap<&ItemId, &Vec<ItemId>> =
        diff.items.iter().map(|i| (&i.id, &i.needs)).collect();
    let (drops, rest): (Vec<SyncStep>, Vec<SyncStep>) = steps
        .into_iter()
        .partition(|s| s.kind == StepKind::DropTable);
    // A dropped table needs the dropped tables whose keys point at it gone first.
    let mut left = drops;
    let mut ordered: Vec<SyncStep> = Vec::new();
    while !left.is_empty() {
        let pending: BTreeSet<ItemId> = left.iter().flat_map(|s| s.items.clone()).collect();
        let at = left
            .iter()
            .position(|s| {
                s.items.iter().all(|id| {
                    needs.get(id).is_none_or(|n| {
                        n.iter()
                            .all(|x| !pending.contains(x) || s.items.contains(x))
                    })
                })
            })
            .unwrap_or(0);
        ordered.push(left.remove(at));
    }
    let mut rest = rest;
    rest.sort_by_key(|s| (s.group, s.kind));
    ordered.extend(rest);
    ordered
}

struct Cx<'a> {
    d: DialectKind,
    designs: &'a TargetDesigns,
    enums: &'a [SmEnum],
    /// Index names in use, lower case: `<table>.<name>` on MySQL (per table),
    /// `.<name>` on PostgreSQL and SQLite (per schema).
    taken: RefCell<BTreeSet<String>>,
}

fn same(a: &str, b: &str) -> bool {
    a == b || a.eq_ignore_ascii_case(b)
}

fn same_list(a: &[String], b: &[String]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same(x, y))
}

impl Cx<'_> {
    /// Fills `taken` with the target's names and `new_tables` (the tables the
    /// script creates).
    fn note_taken<'n>(&self, new_tables: impl Iterator<Item = &'n str>) {
        let schema_wide = self.d != DialectKind::MySql;
        if schema_wide {
            for n in &self.designs.taken_names {
                self.take("", n);
            }
            for n in new_tables {
                self.take("", n);
            }
        }
        for t in &self.designs.tables {
            if schema_wide {
                self.take("", &t.path.name);
            }
            for i in &t.indexes {
                self.take(&t.path.name, &i.name);
            }
        }
    }

    fn scope_key(&self, table: &str, name: &str) -> String {
        let scope = if self.d == DialectKind::MySql {
            table.to_lowercase()
        } else {
            String::new()
        };
        format!("{scope}.{}", name.to_lowercase())
    }

    /// Marks `name` as used; false when it already was.
    fn take(&self, table: &str, name: &str) -> bool {
        self.taken.borrow_mut().insert(self.scope_key(table, name))
    }

    /// A new index name from `base`: within the Dialect's limit (PostgreSQL and
    /// SQLite 63 bytes, MySQL 64 characters; a cut name ends in a short hash)
    /// and not a name already used where it must be unique.
    fn fresh_index_name(&self, table: &str, base: &str) -> String {
        let (max, by_chars) = ddl::index_name_limit(self.d);
        for n in 1usize.. {
            let candidate = if n == 1 {
                base.to_string()
            } else {
                format!("{base}_{n}")
            };
            let name = ddl::fit_name(&candidate, max, by_chars);
            if self.take(table, &name) {
                return name;
            }
        }
        unreachable!("the numbered names never run out")
    }

    fn unique_draft(&self, table: &str, column: &str) -> IndexDraft {
        IndexDraft {
            name: self.fresh_index_name(table, &index_name(table, &[column.to_string()], "key")),
            columns: vec![column.to_string()],
            unique: true,
            primary: false,
        }
    }

    fn q(&self, name: &str) -> String {
        sql_ident(self.d, name)
    }

    fn path(&self, schema: &Option<String>, name: &str) -> ObjectPath {
        ObjectPath {
            database: self.designs.database.clone(),
            schema: schema.clone(),
            name: name.to_string(),
        }
    }

    /// A table as statements name it: `schema.table` (PostgreSQL),
    /// `database.table` (MySQL), `table` (SQLite).
    fn table_sql(&self, path: &ObjectPath) -> String {
        match self.d {
            DialectKind::Sqlite => self.q(&path.name),
            d => sql_table(d, path).unwrap_or_else(|_| self.q(&path.name)),
        }
    }

    /// The item's table on the target, as `table_design` read it.
    fn design(&self, item: &DiffItem) -> Result<&TableDesign, String> {
        let name = item.path.table.as_deref().unwrap_or(&item.path.name);
        self.designs
            .find(item.path.schema.as_deref(), name)
            .ok_or_else(|| format!("Contura could not read the table {name} on the target."))
    }

    fn edit(
        &self,
        item: &DiffItem,
        design: &TableDesign,
        group: SyncGroup,
        edit: DesignEdit,
    ) -> Piece {
        Piece::Edit(
            design.path.clone(),
            SyncEdit {
                item: item.id.clone(),
                group,
                edit,
            },
        )
    }

    /// The source enum `type_name` names, by its name with or without a schema.
    fn enum_named(&self, type_name: &str) -> Option<&SmEnum> {
        let bare = type_name.trim().rsplit('.').next()?.trim_matches('"');
        self.enums.iter().find(|e| same(&e.name, bare))
    }

    fn enum_values(&self, e: &SmEnum) -> String {
        e.values
            .iter()
            .map(|v| ddl::lit(self.d, v))
            .collect::<Vec<_>>()
            .join(", ")
    }

    fn type_name_sql(&self, e: &SmEnum) -> String {
        match &e.schema {
            Some(s) if self.d == DialectKind::Postgres => {
                format!("{}.{}", self.q(s), self.q(&e.name))
            }
            _ => self.q(&e.name),
        }
    }

    /// The column's type as the target writes it, and whether the type itself is
    /// the increment (`serial`). An enum is the qualified type on PostgreSQL,
    /// `enum(..)` on MySQL and TEXT with a CHECK on SQLite.
    fn column_type(&self, c: &SmColumn) -> (String, bool) {
        if let Some(e) = self.enum_named(&c.type_name) {
            let text = match self.d {
                DialectKind::Postgres => self.type_name_sql(e),
                DialectKind::MySql => format!(
                    "enum({})",
                    e.values
                        .iter()
                        .map(|v| ddl::lit(self.d, v))
                        .collect::<Vec<_>>()
                        .join(",")
                ),
                DialectKind::Sqlite => format!(
                    "TEXT CHECK ({} IN ({}))",
                    self.q(&c.name),
                    self.enum_values(e)
                ),
            };
            return (text, false);
        }
        let text = c.type_name.trim();
        if implies_increment(self.d, text) {
            let base = text.to_ascii_lowercase();
            let plain = match (self.d, base.as_str()) {
                (DialectKind::MySql, _) => "bigint unsigned",
                (_, "bigserial" | "serial8") => "bigint",
                (_, "smallserial" | "serial2") => "smallint",
                _ => "integer",
            };
            return (plain.to_string(), true);
        }
        (text.to_string(), false)
    }

    fn default_sql(&self, c: &SmColumn) -> Option<String> {
        match &c.default {
            None | Some(SmDefault::Null) => None,
            Some(d) => Some(ddl::default_sql(self.d, d)),
        }
    }

    fn note(&self, note: &Option<String>) -> Option<String> {
        // SQLite has no comments.
        note.clone().filter(|_| self.d != DialectKind::Sqlite)
    }

    fn source_column<'i>(&self, item: &'i DiffItem) -> Result<&'i SmColumn, String> {
        match &item.source_def {
            Some(ObjectDef::Column { def }) => Ok(def),
            _ => Err(missing(item)),
        }
    }

    fn drop_table(&self, item: &DiffItem) -> Made {
        let path = self
            .designs
            .find(item.path.schema.as_deref(), &item.path.name)
            .map(|t| t.path.clone())
            .unwrap_or_else(|| self.path(&item.path.schema, &item.path.name));
        Ok(vec![Piece::Step(SyncStep {
            items: vec![item.id.clone()],
            group: SyncGroup::Drop,
            kind: StepKind::DropTable,
            statements: vec![format!("DROP TABLE {}", self.table_sql(&path))],
            path,
        })])
    }

    fn table_note(&self, item: &DiffItem) -> Made {
        let design = self.design(item)?;
        let mut out = Vec::new();
        for ch in &item.changes {
            if let Change::Note { to, .. } = ch {
                out.push(self.edit(
                    item,
                    design,
                    SyncGroup::Change,
                    DesignEdit::TableComment {
                        comment: self.note(to),
                    },
                ));
            }
        }
        Ok(out)
    }

    fn add_column(&self, item: &DiffItem) -> Made {
        let design = self.design(item)?;
        let c = self.source_column(item)?;
        let (type_sql, serial) = self.column_type(c);
        let mut out = vec![self.edit(
            item,
            design,
            SyncGroup::Create,
            DesignEdit::AddColumn {
                column: ColumnDraft {
                    name: c.name.clone(),
                    type_sql,
                    nullable: !(c.not_null || c.pk || serial),
                    default_sql: self.default_sql(c),
                    increment: c.increment || serial,
                    comment: self.note(&c.note),
                },
                position: Position::Last,
            },
        )];
        if c.unique && !c.pk {
            out.push(self.edit(
                item,
                design,
                SyncGroup::Create,
                DesignEdit::AddIndex {
                    index: self.unique_draft(&design.path.name, &c.name),
                },
            ));
        }
        Ok(out)
    }

    fn drop_column(&self, item: &DiffItem) -> Made {
        let design = self.design(item)?;
        let column = design
            .columns
            .iter()
            .find(|c| same(&c.name, &item.path.name))
            .ok_or_else(|| no_column(&item.path.name, &design.path.name))?;
        Ok(vec![self.edit(
            item,
            design,
            SyncGroup::Drop,
            DesignEdit::DropColumn {
                name: column.name.clone(),
            },
        )])
    }

    /// The target's column restated with the source's value for each change.
    fn change_column(&self, item: &DiffItem) -> Made {
        let design = self.design(item)?;
        let base = design
            .columns
            .iter()
            .find(|c| same(&c.name, &item.path.name))
            .ok_or_else(|| no_column(&item.path.name, &design.path.name))?;
        let src = self.source_column(item)?;
        let mut column = column_draft(base);
        let mut changed = false;
        let mut out = Vec::new();
        for ch in &item.changes {
            match ch {
                Change::Type { .. } => {
                    let (type_sql, serial) = self.column_type(src);
                    column.type_sql = type_sql;
                    column.increment |= serial;
                    changed = true;
                }
                Change::Nullable { to, .. } => {
                    column.nullable = *to;
                    changed = true;
                }
                Change::Default { to, .. } => {
                    column.default_sql = to.as_ref().and_then(|_| self.default_sql(src));
                    changed = true;
                }
                Change::Increment { to, .. } => {
                    column.increment = *to;
                    changed = true;
                }
                Change::Note { .. } => {
                    column.comment = self.note(&src.note);
                    changed = true;
                }
                Change::Unique { to: true, .. } => out.push(self.edit(
                    item,
                    design,
                    SyncGroup::Create,
                    DesignEdit::AddIndex {
                        index: self.unique_draft(&design.path.name, &base.name),
                    },
                )),
                Change::Unique { to: false, .. } => {
                    let index = design
                        .indexes
                        .iter()
                        .find(|i| {
                            !i.primary
                                && i.unique
                                && i.columns.len() == 1
                                && same(&i.columns[0], &base.name)
                        })
                        .ok_or_else(|| {
                            format!("Contura cannot find the unique index on {}.", base.name)
                        })?;
                    out.push(self.edit(
                        item,
                        design,
                        SyncGroup::Drop,
                        DesignEdit::DropIndex {
                            name: index.name.clone(),
                        },
                    ));
                }
                // MySQL's enum values come with a type change, which restates them.
                Change::EnumValues { .. }
                | Change::OnDelete { .. }
                | Change::OnUpdate { .. }
                | Change::Columns { .. } => {}
            }
        }
        if changed {
            out.push(self.edit(
                item,
                design,
                SyncGroup::Change,
                DesignEdit::ChangeColumn {
                    name: base.name.clone(),
                    column,
                },
            ));
        }
        Ok(out)
    }

    fn primary_key(&self, item: &DiffItem) -> Made {
        let design = self.design(item)?;
        let mut out = Vec::new();
        if matches!(item.kind, DiffKind::Removed | DiffKind::Changed) {
            let pk = design.indexes.iter().find(|i| i.primary).ok_or_else(|| {
                format!(
                    "Contura cannot find the primary key of {}.",
                    design.path.name
                )
            })?;
            out.push(self.edit(
                item,
                design,
                SyncGroup::Drop,
                DesignEdit::DropIndex {
                    name: pk.name.clone(),
                },
            ));
        }
        if matches!(item.kind, DiffKind::Added | DiffKind::Changed) {
            let Some(ObjectDef::PrimaryKey { columns }) = &item.source_def else {
                return Err(missing(item));
            };
            out.push(self.edit(
                item,
                design,
                SyncGroup::Create,
                DesignEdit::AddIndex {
                    index: IndexDraft {
                        // MySQL names every primary key PRIMARY; the others let
                        // the server name it.
                        name: if self.d == DialectKind::MySql {
                            "PRIMARY".into()
                        } else {
                            String::new()
                        },
                        columns: columns.clone(),
                        unique: true,
                        primary: true,
                    },
                },
            ));
        }
        Ok(out)
    }

    /// The target's index for `def`: by name when it has one, else by columns
    /// and uniqueness.
    fn real_index<'d>(&self, design: &'d TableDesign, def: &SmIndex) -> Option<&'d TableIndex> {
        let plain = design.indexes.iter().filter(|i| !i.primary);
        let by_name = def
            .name
            .as_ref()
            .and_then(|n| plain.clone().find(|i| same(&i.name, n)));
        by_name.or_else(|| {
            plain
                .clone()
                .find(|i| i.unique == def.unique && same_list(&i.columns, &def.columns))
        })
    }

    fn index(&self, item: &DiffItem) -> Made {
        let design = self.design(item)?;
        let mut out = Vec::new();
        let mut kept_name = None;
        if matches!(item.kind, DiffKind::Removed | DiffKind::Changed) {
            let Some(ObjectDef::Index { def }) = &item.target_def else {
                return Err(missing(item));
            };
            let real = self.real_index(design, def).ok_or_else(|| {
                format!(
                    "Contura cannot find the index {} on {}.",
                    item.path.name, design.path.name
                )
            })?;
            kept_name = Some(real.name.clone());
            out.push(self.edit(
                item,
                design,
                SyncGroup::Drop,
                DesignEdit::DropIndex {
                    name: real.name.clone(),
                },
            ));
        }
        if matches!(item.kind, DiffKind::Added | DiffKind::Changed) {
            let Some(ObjectDef::Index { def }) = &item.source_def else {
                return Err(missing(item));
            };
            let name = match def.name.clone().or(kept_name) {
                Some(n) => {
                    self.take(&design.path.name, &n);
                    n
                }
                None => self.fresh_index_name(
                    &design.path.name,
                    &index_name(&design.path.name, &def.columns, "idx"),
                ),
            };
            out.push(self.edit(
                item,
                design,
                SyncGroup::Create,
                DesignEdit::AddIndex {
                    index: IndexDraft {
                        name,
                        columns: def.columns.clone(),
                        unique: def.unique,
                        primary: false,
                    },
                },
            ));
        }
        Ok(out)
    }

    /// The Foreign Key as the designer drafts it; `name` empty lets the server name it.
    fn key_draft(&self, def: &SmRef, name: String) -> ForeignKeyDraft {
        ForeignKeyDraft {
            name,
            columns: def.from.columns.clone(),
            target: ObjectPath {
                database: self.designs.database.clone(),
                schema: def
                    .to
                    .schema
                    .clone()
                    .filter(|_| self.d == DialectKind::Postgres),
                name: def.to.table.clone(),
            },
            target_columns: def.to.columns.clone(),
            on_delete: def.on_delete.clone(),
            on_update: def.on_update.clone(),
        }
    }

    fn foreign_key(&self, item: &DiffItem) -> Made {
        let design = self.design(item)?;
        let mut out = Vec::new();
        let mut kept_name = None;
        if matches!(item.kind, DiffKind::Removed | DiffKind::Changed) {
            let Some(ObjectDef::ForeignKey { def }) = &item.target_def else {
                return Err(missing(item));
            };
            let real = design
                .foreign_keys
                .iter()
                .find(|k| {
                    same_list(&k.columns, &def.from.columns)
                        && same(&k.target.name, &def.to.table)
                        && same_list(&k.target_columns, &def.to.columns)
                })
                .or_else(|| {
                    def.name
                        .as_ref()
                        .and_then(|n| design.foreign_keys.iter().find(|k| same(&k.name, n)))
                })
                .ok_or_else(|| {
                    format!(
                        "Contura cannot find the Foreign Key {} on {}.",
                        item.path.name, design.path.name
                    )
                })?;
            kept_name = Some(real.name.clone());
            out.push(self.edit(
                item,
                design,
                SyncGroup::Drop,
                DesignEdit::DropForeignKey {
                    name: real.name.clone(),
                },
            ));
        }
        if matches!(item.kind, DiffKind::Added | DiffKind::Changed) {
            let Some(ObjectDef::ForeignKey { def }) = &item.source_def else {
                return Err(missing(item));
            };
            // SQLite keys have no names of their own.
            let name = match self.d {
                DialectKind::Sqlite => String::new(),
                _ => def.name.clone().or(kept_name).unwrap_or_default(),
            };
            out.push(self.edit(
                item,
                design,
                SyncGroup::Create,
                DesignEdit::AddForeignKey {
                    key: self.key_draft(def, name),
                },
            ));
        }
        Ok(out)
    }

    /// PostgreSQL enums. A changed enum only gains values here: a removed or
    /// reordered value is not scriptable, which `diff` already said.
    fn enum_item(&self, item: &DiffItem) -> Made {
        if self.d != DialectKind::Postgres {
            return Err(missing(item));
        }
        let def = match (&item.source_def, &item.target_def) {
            (Some(ObjectDef::Enum { def }), _) | (None, Some(ObjectDef::Enum { def })) => def,
            _ => return Err(missing(item)),
        };
        let type_sql = self.type_name_sql(def);
        let path = self.path(&def.schema, &def.name);
        let step = |group, kind, statement: String| {
            Piece::Step(SyncStep {
                items: vec![item.id.clone()],
                group,
                kind,
                path: path.clone(),
                statements: vec![statement],
            })
        };
        Ok(match item.kind {
            DiffKind::Added => vec![step(
                SyncGroup::Create,
                StepKind::CreateType,
                format!("CREATE TYPE {type_sql} AS ENUM ({})", self.enum_values(def)),
            )],
            DiffKind::Removed => vec![step(
                SyncGroup::Drop,
                StepKind::DropType,
                format!("DROP TYPE {type_sql}"),
            )],
            DiffKind::Changed => {
                let Some(ObjectDef::Enum { def: target }) = &item.target_def else {
                    return Err(missing(item));
                };
                let mut known: Vec<&String> = target.values.iter().collect();
                let mut out = Vec::new();
                for (at, value) in def.values.iter().enumerate() {
                    if known.contains(&value) {
                        continue;
                    }
                    let before = def.values[..at].iter().rev().find(|v| known.contains(v));
                    let after = def.values[at + 1..].iter().find(|v| known.contains(v));
                    let place = match (before, after) {
                        (Some(b), _) => format!(" AFTER {}", ddl::lit(self.d, b)),
                        (None, Some(a)) => format!(" BEFORE {}", ddl::lit(self.d, a)),
                        (None, None) => String::new(),
                    };
                    out.push(step(
                        SyncGroup::Change,
                        StepKind::AddEnumValue,
                        format!(
                            "ALTER TYPE {type_sql} ADD VALUE {}{place}",
                            ddl::lit(self.d, value)
                        ),
                    ));
                    known.push(value);
                }
                out
            }
        })
    }

    /// New tables in dependency order, each `CREATE TABLE` from step 8's `ddl`
    /// parts with its comments and indexes, then (MySQL, PostgreSQL) the ticked
    /// Foreign Keys of new tables. SQLite cannot add a key later, so a new
    /// table's ticked keys are written inside its `CREATE TABLE`.
    fn new_tables(
        &self,
        tables: &[&DiffItem],
        keys: &[&DiffItem],
        out: &mut SyncEdits,
    ) -> Vec<Piece> {
        let mut defs: Vec<(&DiffItem, SmTable)> = Vec::new();
        for item in tables {
            match &item.source_def {
                Some(ObjectDef::Table { def }) => defs.push((item, self.table_def(def))),
                _ => {
                    out.not_scriptable.insert(item.id.clone(), missing(item));
                }
            }
        }
        let refs: Vec<(&DiffItem, &SmRef)> = keys
            .iter()
            .filter_map(|k| match &k.source_def {
                Some(ObjectDef::ForeignKey { def }) => Some((*k, def)),
                _ => None,
            })
            .collect();
        let owns = |t: &SmTable, r: &SmRef| same(&t.name, &r.from.table);
        for (k, r) in &refs {
            if !defs.iter().any(|(_, t)| owns(t, r)) {
                out.not_scriptable
                    .insert(k.id.clone(), format!("Needs CREATE TABLE {}", r.from.table));
            }
        }
        let all = SchemaModel {
            dialect: self.d,
            tables: defs.iter().map(|(_, t)| t.clone()).collect(),
            refs: refs.iter().map(|(_, r)| self.ref_def(r)).collect(),
            enums: Vec::new(),
            skipped: Vec::new(),
        };
        let mut pieces = Vec::new();
        for i in ddl::table_order(&all) {
            let (item, def) = &defs[i];
            let mut items = vec![item.id.clone()];
            let mut inline = Vec::new();
            if self.d == DialectKind::Sqlite {
                for (k, r) in refs.iter().filter(|(_, r)| owns(def, r)) {
                    items.push(k.id.clone());
                    inline.push(self.ref_def(r));
                }
            }
            let model = SchemaModel {
                dialect: self.d,
                tables: vec![def.clone()],
                refs: inline,
                // PostgreSQL types are written qualified already; MySQL and
                // SQLite write a model enum inline.
                enums: if self.d == DialectKind::Postgres {
                    Vec::new()
                } else {
                    self.enums.to_vec()
                },
                skipped: Vec::new(),
            };
            let opts = ddl::DdlOptions {
                sqlite_autoincrement_as_note: true,
                ..ddl::DdlOptions::default()
            };
            match ddl::parts(&model, &opts) {
                Ok(p) => {
                    out.notes.extend(p.notes);
                    pieces.push(Piece::Step(SyncStep {
                        items,
                        group: SyncGroup::Create,
                        kind: StepKind::CreateTable,
                        path: self.path(&item.path.schema, &def.name),
                        statements: p.tables.iter().chain(&p.indexes).map(|s| bare(s)).collect(),
                    }));
                }
                Err(e) => {
                    out.not_scriptable.insert(item.id.clone(), e.to_string());
                }
            }
        }
        if self.d != DialectKind::Sqlite {
            for (k, r) in &refs {
                if !defs.iter().any(|(_, t)| owns(t, r)) {
                    continue;
                }
                let owner = self.path(&k.path.schema, &r.from.table);
                let target = self.path(
                    &r.to
                        .schema
                        .clone()
                        .filter(|_| self.d == DialectKind::Postgres),
                    &r.to.table,
                );
                let fk = ddl::foreign_key_sql(
                    self.d,
                    &ddl::FkSql {
                        name: r.name.clone(),
                        columns: r.from.columns.clone(),
                        target: self.table_sql(&target),
                        target_columns: r.to.columns.clone(),
                        on_delete: r.on_delete.clone(),
                        on_update: r.on_update.clone(),
                    },
                );
                pieces.push(Piece::Step(SyncStep {
                    items: vec![k.id.clone()],
                    group: SyncGroup::Create,
                    kind: StepKind::AddForeignKey,
                    statements: vec![format!("ALTER TABLE {} ADD {fk}", self.table_sql(&owner))],
                    path: owner,
                }));
            }
        }
        pieces
    }

    /// A new table as the target writes it: PostgreSQL enum types qualified, MySQL
    /// tables in the target database.
    fn table_def(&self, def: &SmTable) -> SmTable {
        let mut def = def.clone();
        match self.d {
            DialectKind::Postgres => {
                for c in &mut def.columns {
                    if let Some(e) = self.enum_named(&c.type_name) {
                        c.type_name = self.type_name_sql(e);
                    }
                }
            }
            DialectKind::MySql => def.schema = Some(self.designs.database.clone()),
            DialectKind::Sqlite => def.schema = None,
        }
        // Unnamed indexes get a name that fits and is free; named ones keep it.
        let table = def.name.clone();
        for i in def.indexes.iter_mut().filter(|i| !i.pk) {
            match &i.name {
                Some(n) => {
                    self.take(&table, n);
                }
                None => {
                    let base = index_name(&table, &i.columns, "idx");
                    i.name = Some(self.fresh_index_name(&table, &base));
                }
            }
        }
        def
    }

    fn ref_def(&self, r: &SmRef) -> SmRef {
        let mut r = r.clone();
        match self.d {
            DialectKind::MySql => {
                r.from.schema = Some(self.designs.database.clone());
                r.to.schema = Some(self.designs.database.clone());
            }
            DialectKind::Sqlite => {
                r.from.schema = None;
                r.to.schema = None;
            }
            DialectKind::Postgres => {}
        }
        r
    }
}

/// A statement without its trailing `;`.
fn bare(s: &str) -> String {
    s.trim_end().trim_end_matches(';').to_string()
}

/// `<table>_<columns>_<suffix>`, as PostgreSQL names an index it names itself.
fn index_name(table: &str, columns: &[String], suffix: &str) -> String {
    format!("{table}_{}_{suffix}", columns.join("_"))
}

fn no_column(column: &str, table: &str) -> String {
    format!("There is no column {column} in {table} on the target.")
}

fn missing(item: &DiffItem) -> String {
    format!("Contura cannot script {}.", item.path.name)
}

#[cfg(test)]
#[path = "edits_tests.rs"]
pub(crate) mod tests;
