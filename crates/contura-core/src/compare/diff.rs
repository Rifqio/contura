//! `diff`: what differs between two Schema Models of one Dialect, as items the
//! Sync Script can tick. Pure and deterministic: the same input gives the same
//! items, ids and order.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::{Deserialize, Serialize};

use super::normalise::{
    NameKind, TableRef, default_key, fold_name, implies_increment, is_own_sequence_default,
    narrowing, normalise_type,
};
use crate::model::DialectKind;
use crate::schema_model::{SchemaModel, SmColumn, SmEnum, SmIndex, SmRef, SmTable};

/// How the two sides are read.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompareOptions {
    /// The source's schema (PostgreSQL), stripped before matching. For a Schema
    /// Model source, the target's schema: a model table in another schema is not
    /// compared. `None` on MySQL and SQLite.
    #[serde(default)]
    pub source_schema: Option<String>,
    /// The target's schema, stripped before matching and put back on every item.
    #[serde(default)]
    pub target_schema: Option<String>,
    /// The MySQL server's `lower_case_table_names`: not 0 folds table names.
    #[serde(default)]
    pub lower_case_table_names: u8,
}

/// Stable text built from the object, its path and the kind of difference, such as
/// `column:billing.invoices.fax:removed`, so a selection survives comparing again.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(transparent)]
pub struct ItemId(pub String);

impl ItemId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ItemId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(
    Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash,
)]
#[serde(rename_all = "camelCase")]
pub enum DiffKind {
    /// In the source only.
    Added,
    /// In the target only.
    Removed,
    /// On both sides, different.
    #[default]
    Changed,
}

impl DiffKind {
    fn word(self) -> &'static str {
        match self {
            DiffKind::Added => "added",
            DiffKind::Removed => "removed",
            DiffKind::Changed => "changed",
        }
    }
}

#[derive(
    Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash,
)]
#[serde(rename_all = "camelCase")]
pub enum DiffObject {
    #[default]
    Table,
    Column,
    PrimaryKey,
    Index,
    ForeignKey,
    Enum,
}

impl DiffObject {
    fn word(self) -> &'static str {
        match self {
            DiffObject::Table => "table",
            DiffObject::Column => "column",
            DiffObject::PrimaryKey => "primaryKey",
            DiffObject::Index => "index",
            DiffObject::ForeignKey => "foreignKey",
            DiffObject::Enum => "enum",
        }
    }
}

/// Where an item is, with the target's schema. `table` is the table a column,
/// key or index belongs to (`None` for a table or an enum, whose own name is
/// `name`). An unnamed index is named by its columns, `(a, b)`; a Foreign Key by
/// its columns and target, `(customer_id) -> customers(id)`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ItemPath {
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(default)]
    pub table: Option<String>,
    #[serde(default)]
    pub name: String,
}

/// One thing that differs. `from` is the target's value, `to` the source's:
/// applying the change makes the target read `to`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Change {
    /// Normalised types, such as `varchar(16)` to `varchar(24)`.
    Type {
        from: String,
        to: String,
    },
    /// `true` when the column takes NULL.
    Nullable {
        from: bool,
        to: bool,
    },
    /// Normalised defaults; `None` is no default.
    Default {
        from: Option<String>,
        to: Option<String>,
    },
    Increment {
        from: bool,
        to: bool,
    },
    Unique {
        from: bool,
        to: bool,
    },
    Note {
        from: Option<String>,
        to: Option<String>,
    },
    OnDelete {
        from: Option<String>,
        to: Option<String>,
    },
    OnUpdate {
        from: Option<String>,
        to: Option<String>,
    },
    /// The columns of a primary key or an index.
    Columns {
        from: Vec<String>,
        to: Vec<String>,
    },
    /// Enum values the source has and the target lacks (`added`) and the reverse
    /// (`removed`); `reordered` when the values both have are in another order.
    EnumValues {
        added: Vec<String>,
        removed: Vec<String>,
        reordered: bool,
    },
}

/// Rows a data-loss item would lose, counted on the target after `diff`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DataLoss {
    #[serde(default)]
    pub rows: u64,
    /// `false` when `rows` is the server's estimate ("about").
    #[serde(default)]
    pub exact: bool,
}

/// One side's definition of an item's object, as that side's model holds it. A
/// source definition carries the target's schema in place of the source's. Kept
/// in the Core for the Sync Script; the UI gets the definition text.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ObjectDef {
    Table { def: SmTable },
    Column { def: SmColumn },
    PrimaryKey { columns: Vec<String> },
    Index { def: SmIndex },
    ForeignKey { def: SmRef },
    Enum { def: SmEnum },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffItem {
    #[serde(default)]
    pub id: ItemId,
    #[serde(default)]
    pub kind: DiffKind,
    #[serde(default)]
    pub object: DiffObject,
    #[serde(default)]
    pub path: ItemPath,
    /// The short text the tree shows after the name, such as
    /// `varchar(16) to varchar(24)`, `integer`, `index` or `+ written_off`.
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub changes: Vec<Change>,
    /// Filled by the data-loss counts; `diff` leaves it empty.
    #[serde(default)]
    pub data_loss: Option<DataLoss>,
    /// Whether applying the item can lose values: a removed table or column, a
    /// narrowing type change, or enum values removed. Such items start unticked.
    #[serde(default)]
    pub loses_data: bool,
    /// Items that must be applied for this one to apply.
    #[serde(default)]
    pub needs: Vec<ItemId>,
    /// `Err(reason)` when Contura cannot script the item. Sent as
    /// `notScriptable`: `null`, or the reason.
    #[serde(
        default = "scriptable_ok",
        rename = "notScriptable",
        with = "scriptable_serde"
    )]
    pub scriptable: Result<(), String>,
    /// The source's definition text of the item (its DDL line or block).
    #[serde(default)]
    pub source: Option<String>,
    /// The target's definition text of the item.
    #[serde(default)]
    pub target: Option<String>,
    /// The source's definition, for the Sync Script; not sent.
    #[serde(skip)]
    pub source_def: Option<ObjectDef>,
    /// The target's definition, for the Sync Script; not sent.
    #[serde(skip)]
    pub target_def: Option<ObjectDef>,
}

impl Default for DiffItem {
    fn default() -> Self {
        DiffItem {
            id: ItemId::default(),
            kind: DiffKind::default(),
            object: DiffObject::default(),
            path: ItemPath::default(),
            detail: String::new(),
            changes: Vec::new(),
            data_loss: None,
            loses_data: false,
            needs: Vec::new(),
            scriptable: Ok(()),
            source: None,
            target: None,
            source_def: None,
            target_def: None,
        }
    }
}

fn scriptable_ok() -> Result<(), String> {
    Ok(())
}

mod scriptable_serde {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(v: &Result<(), String>, s: S) -> Result<S::Ok, S::Error> {
        v.as_ref().err().serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Result<(), String>, D::Error> {
        Ok(match Option::<String>::deserialize(d)? {
            Some(reason) => Err(reason),
            None => Ok(()),
        })
    }
}

/// What Contura leaves out of the compare, in the order the line names them.
#[derive(
    Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash,
)]
#[serde(rename_all = "camelCase")]
pub enum NotComparedKind {
    /// Views, materialized views and foreign tables.
    #[default]
    View,
    /// Functions and procedures.
    Routine,
    Trigger,
    /// Check constraints and PostgreSQL domains.
    Check,
    GeneratedColumn,
    ExpressionIndex,
    PartialIndex,
    /// Table and column notes on SQLite, which has no comments.
    Comment,
    /// A model table in another schema than the target's.
    OtherSchema,
}

impl NotComparedKind {
    /// The kind as the not-compared line names one of it.
    pub fn word(self) -> &'static str {
        match self {
            NotComparedKind::View => "view",
            NotComparedKind::Routine => "routine",
            NotComparedKind::Trigger => "trigger",
            NotComparedKind::Check => "check constraint",
            NotComparedKind::GeneratedColumn => "generated column",
            NotComparedKind::ExpressionIndex => "expression index",
            NotComparedKind::PartialIndex => "partial index",
            NotComparedKind::Comment => "comment",
            NotComparedKind::OtherSchema => "table in another schema",
        }
    }

    /// The kind of a snapshot's `skipped` entry, such as `"check constraint c"`.
    /// An entry of an unknown kind counts as a view.
    fn of_skipped(entry: &str) -> NotComparedKind {
        const PREFIXES: &[(&str, NotComparedKind)] = &[
            ("materialized view ", NotComparedKind::View),
            ("foreign table ", NotComparedKind::View),
            ("view ", NotComparedKind::View),
            ("function ", NotComparedKind::Routine),
            ("procedure ", NotComparedKind::Routine),
            ("trigger ", NotComparedKind::Trigger),
            ("check constraint ", NotComparedKind::Check),
            ("domain ", NotComparedKind::Check),
            ("generated column ", NotComparedKind::GeneratedColumn),
            ("expression index ", NotComparedKind::ExpressionIndex),
            ("partial index ", NotComparedKind::PartialIndex),
        ];
        PREFIXES
            .iter()
            .find(|(p, _)| entry.starts_with(p))
            .map(|(_, k)| *k)
            .unwrap_or_default()
    }
}

/// Objects of one kind that were not compared on one side, such as 2 views.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotComparedGroup {
    #[serde(default)]
    pub kind: NotComparedKind,
    #[serde(default)]
    pub count: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotCompared {
    #[serde(default)]
    pub source: Vec<NotComparedGroup>,
    #[serde(default)]
    pub target: Vec<NotComparedGroup>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompareSummary {
    #[serde(default)]
    pub added: u32,
    #[serde(default)]
    pub removed: u32,
    #[serde(default)]
    pub changed: u32,
    /// What was compared, counted on the source.
    #[serde(default)]
    pub tables: u32,
    #[serde(default)]
    pub enums: u32,
    /// Indexes, unique columns included.
    #[serde(default)]
    pub indexes: u32,
    #[serde(default)]
    pub foreign_keys: u32,
    /// No items and the same objects not compared on both sides. Only then may the
    /// screen say the two sides match.
    #[serde(default)]
    pub matches: bool,
    /// Whether both sides left out the same objects.
    #[serde(default)]
    pub not_compared_same: bool,
    /// `6 tables, 1 enum, 14 indexes, 5 Foreign Keys`.
    #[serde(default)]
    pub counts_line: String,
    /// `Not compared yet: 2 views, 1 trigger.`, naming each side when they differ;
    /// `None` when nothing was left out.
    #[serde(default)]
    pub not_compared_line: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiff {
    #[serde(default)]
    pub items: Vec<DiffItem>,
    #[serde(default)]
    pub not_compared: NotCompared,
    #[serde(default)]
    pub summary: CompareSummary,
    /// The source's enums in scope, in the target's schema, for the Sync Script:
    /// MySQL and SQLite write a model enum inline in the column. Not sent.
    #[serde(skip)]
    pub source_enums: Vec<SmEnum>,
}

/// Compares `source` with `target` (the Sync Script changes the target to match the
/// source). Both are of the target's Dialect; the caller refuses a mismatch.
pub fn diff(source: &SchemaModel, target: &SchemaModel, opts: &CompareOptions) -> SchemaDiff {
    let cx = Cx {
        d: target.dialect,
        lctn: opts.lower_case_table_names,
        out_schema: opts.target_schema.clone(),
    };
    let src = cx.side(source, &opts.source_schema);
    let tgt = cx.side(target, &opts.target_schema);
    let mut b = Builder::default();

    if cx.d == DialectKind::Postgres {
        cx.enums(&src, &tgt, &mut b);
    }
    let keys: BTreeSet<&String> = src.tables.keys().chain(tgt.tables.keys()).collect();
    for key in keys {
        match (src.tables.get(key), tgt.tables.get(key)) {
            (Some(s), None) => {
                b.push(
                    cx.item(
                        DiffKind::Added,
                        DiffObject::Table,
                        cx.path(None, &s.raw.name),
                    )
                    .detail("table")
                    .source(ObjectDef::Table {
                        def: cx.source_table(s.raw, &src),
                    })
                    .wants(s.enum_wants()),
                    key,
                    "",
                );
            }
            (None, Some(t)) => {
                let at = b.push(
                    cx.item(
                        DiffKind::Removed,
                        DiffObject::Table,
                        cx.path(None, &t.raw.name),
                    )
                    .detail("table")
                    .loses_data()
                    .target(ObjectDef::Table { def: t.raw.clone() })
                    .wants(vec![Want::DropsOn {
                        table: key.clone(),
                        column: None,
                    }]),
                    key,
                    "",
                );
                // Its own Foreign Keys go with it.
                for r in tgt.refs.iter().filter(|r| r.from_table == *key) {
                    b.drop_fact(at, r);
                }
            }
            (Some(s), Some(t)) => cx.table_pair(key, s, t, &src, &tgt, &mut b),
            (None, None) => {}
        }
        cx.foreign_keys(key, &src, &tgt, &mut b);
    }

    let mut items = b.finish();
    for item in &mut items {
        item.source = item
            .source_def
            .as_ref()
            .map(|d| def_text(cx.d, d, &source.enums));
        item.target = item
            .target_def
            .as_ref()
            .map(|d| def_text(cx.d, d, &target.enums));
    }
    let not_compared = NotCompared {
        source: groups(cx.d, source, &src.other_schema),
        target: groups(cx.d, target, &tgt.other_schema),
    };
    let summary = summary(&items, &not_compared, &src);
    let source_enums = src
        .enums
        .values()
        .map(|e| SmEnum {
            schema: cx.out_schema.clone(),
            ..(*e).clone()
        })
        .collect();
    SchemaDiff {
        items,
        not_compared,
        summary,
        source_enums,
    }
}

// ---------------------------------------------------------------------------
// One side, normalised.

struct Side<'a> {
    schema: Option<String>,
    tables: BTreeMap<String, NTable<'a>>,
    enums: BTreeMap<String, &'a SmEnum>,
    refs: Vec<NRef<'a>>,
    other_schema: Vec<String>,
}

struct NTable<'a> {
    raw: &'a SmTable,
    cols: Vec<NCol<'a>>,
    pk: Vec<String>,
    pk_keys: Vec<String>,
    indexes: Vec<NIndex<'a>>,
}

impl NTable<'_> {
    fn col(&self, key: &str) -> Option<&NCol<'_>> {
        self.cols.iter().find(|c| c.key == key)
    }

    /// Enums the table's columns use, as wants of their added or changed items.
    fn enum_wants(&self) -> Vec<Want> {
        self.cols
            .iter()
            .filter_map(|c| c.enum_key.as_deref())
            .map(Want::enum_ready)
            .collect()
    }
}

struct NCol<'a> {
    raw: &'a SmColumn,
    key: String,
    ty: String,
    enum_key: Option<String>,
    not_null: bool,
    unique: bool,
    increment: bool,
    default: Option<String>,
    note: Option<String>,
}

struct NIndex<'a> {
    raw: &'a SmIndex,
    name_key: Option<String>,
    col_keys: Vec<String>,
}

/// A Foreign Key's columns on one table, with its folded name when the side
/// names it.
struct KeyCols {
    name: Option<String>,
    cols: Vec<String>,
}

/// Whether `name` is a name MySQL gives a key it names itself: `<table>_ibfk_<n>`.
fn mysql_key_name(table: &str, name: &str) -> bool {
    let name = name.to_lowercase();
    name.strip_prefix(&format!("{}_ibfk_", table.to_lowercase()))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

struct NRef<'a> {
    raw: &'a SmRef,
    from_table: String,
    from_cols: Vec<String>,
    to_table: String,
    to_cols: Vec<String>,
    /// The target table's schema when it is not the side's own.
    to_schema: Option<String>,
    on_delete: Option<String>,
    on_update: Option<String>,
}

impl NRef<'_> {
    fn key(&self) -> String {
        format!(
            "({})->{}({})",
            self.from_cols.join(","),
            self.to_table,
            self.to_cols.join(",")
        )
    }
}

// ---------------------------------------------------------------------------
// Items under construction, with their needs as keys until every item exists.

/// What an item needs, resolved to ids once every item exists.
#[derive(Clone)]
enum Want {
    /// The item of `object` at (`table`, `key`) with one of `kinds`, if it exists.
    Item {
        object: DiffObject,
        table: String,
        key: String,
        kinds: &'static [DiffKind],
    },
    /// What must go before dropping `table` (or its `column`): the removed Foreign
    /// Keys that point at it or, for a column, use it, and the removed tables
    /// whose keys point at it.
    DropsOn {
        table: String,
        column: Option<String>,
    },
}

const ADDED: &[DiffKind] = &[DiffKind::Added];
const REMOVED: &[DiffKind] = &[DiffKind::Removed];
const ADDED_OR_CHANGED: &[DiffKind] = &[DiffKind::Added, DiffKind::Changed];
const REMOVED_OR_CHANGED: &[DiffKind] = &[DiffKind::Removed, DiffKind::Changed];

impl Want {
    fn item(object: DiffObject, table: &str, key: &str, kinds: &'static [DiffKind]) -> Want {
        Want::Item {
            object,
            table: table.into(),
            key: key.into(),
            kinds,
        }
    }

    fn added(object: DiffObject, table: &str, key: &str) -> Want {
        Want::item(object, table, key, ADDED)
    }

    /// The enum a column uses, when it is added or changed.
    fn enum_ready(key: &str) -> Want {
        Want::item(DiffObject::Enum, "", key, ADDED_OR_CHANGED)
    }
}

struct Pending {
    item: DiffItem,
    table_key: String,
    key: String,
    wants: Vec<Want>,
}

impl Pending {
    fn detail(mut self, d: impl Into<String>) -> Self {
        self.item.detail = d.into();
        self
    }
    fn loses_data(mut self) -> Self {
        self.item.loses_data = true;
        self
    }
    fn source(mut self, def: ObjectDef) -> Self {
        self.item.source_def = Some(def);
        self
    }
    fn target(mut self, def: ObjectDef) -> Self {
        self.item.target_def = Some(def);
        self
    }
    fn wants(mut self, wants: Vec<Want>) -> Self {
        self.wants.extend(wants);
        self
    }
}

/// A target Foreign Key that a drop goes with: removed itself, or on a removed
/// table. `at` is the item that drops it.
struct DropFact {
    at: usize,
    from_table: String,
    from_cols: Vec<String>,
    to_table: String,
    to_cols: Vec<String>,
}

#[derive(Default)]
struct Builder {
    items: Vec<Pending>,
    drops: Vec<DropFact>,
}

impl Builder {
    /// Adds an item and returns its index.
    fn push(&mut self, mut p: Pending, table_key: &str, key: &str) -> usize {
        p.table_key = table_key.into();
        p.key = key.into();
        self.items.push(p);
        self.items.len() - 1
    }

    fn push_fk(&mut self, p: Pending, table_key: &str, r: &NRef<'_>) {
        let removed = p.item.kind == DiffKind::Removed;
        let at = self.push(p, table_key, &r.key());
        if removed {
            self.drop_fact(at, r);
        }
    }

    /// Records that item `at` drops the target Foreign Key `r`.
    fn drop_fact(&mut self, at: usize, r: &NRef<'_>) {
        self.drops.push(DropFact {
            at,
            from_table: r.from_table.clone(),
            from_cols: r.from_cols.clone(),
            to_table: r.to_table.clone(),
            to_cols: r.to_cols.clone(),
        });
    }

    fn finish(mut self) -> Vec<DiffItem> {
        // Two objects can share an id (two Foreign Keys on the same columns under
        // different names): the later ones get `#2`, `#3` in item order.
        let mut seen: BTreeMap<String, u32> = BTreeMap::new();
        for p in &mut self.items {
            let n = seen.entry(p.item.id.0.clone()).or_insert(0);
            *n += 1;
            if *n > 1 {
                p.item.id.0 = format!("{}#{n}", p.item.id.0);
            }
        }
        let mut by_key: BTreeMap<(DiffObject, &str, &str, DiffKind), &ItemId> = BTreeMap::new();
        for p in &self.items {
            by_key.insert(
                (
                    p.item.object,
                    p.table_key.as_str(),
                    p.key.as_str(),
                    p.item.kind,
                ),
                &p.item.id,
            );
        }
        let mut needs: Vec<Vec<ItemId>> = Vec::with_capacity(self.items.len());
        for p in &self.items {
            let mut found: BTreeSet<ItemId> = BTreeSet::new();
            for w in &p.wants {
                match w {
                    Want::Item {
                        object,
                        table,
                        key,
                        kinds,
                    } => {
                        for kind in *kinds {
                            if let Some(id) =
                                by_key.get(&(*object, table.as_str(), key.as_str(), *kind))
                            {
                                found.insert((*id).clone());
                            }
                        }
                    }
                    Want::DropsOn { table, column } => {
                        for f in &self.drops {
                            let hit = match column {
                                None => f.to_table == *table && f.from_table != *table,
                                Some(c) => {
                                    (f.to_table == *table && f.to_cols.contains(c))
                                        || (f.from_table == *table && f.from_cols.contains(c))
                                }
                            };
                            if hit {
                                found.insert(self.items[f.at].item.id.clone());
                            }
                        }
                    }
                }
            }
            found.remove(&p.item.id);
            needs.push(found.into_iter().collect());
        }
        self.items
            .into_iter()
            .zip(needs)
            .map(|(p, needs)| DiffItem { needs, ..p.item })
            .collect()
    }
}

// ---------------------------------------------------------------------------

struct Cx {
    d: DialectKind,
    lctn: u8,
    out_schema: Option<String>,
}

impl Cx {
    fn fold(&self, kind: NameKind, name: &str) -> String {
        fold_name(self.d, kind, name, self.lctn)
    }

    fn same_schema(&self, a: &str, b: &str) -> bool {
        self.fold(NameKind::Schema, a) == self.fold(NameKind::Schema, b)
    }

    fn path(&self, table: Option<&str>, name: &str) -> ItemPath {
        ItemPath {
            schema: self.out_schema.clone(),
            table: table.map(str::to_string),
            name: name.to_string(),
        }
    }

    fn item(&self, kind: DiffKind, object: DiffObject, path: ItemPath) -> Pending {
        let mut parts: Vec<&str> = Vec::new();
        if let Some(s) = &path.schema {
            parts.push(s);
        }
        if let Some(t) = &path.table {
            parts.push(t);
        }
        if object != DiffObject::PrimaryKey {
            parts.push(&path.name);
        }
        let id = ItemId(format!(
            "{}:{}:{}",
            object.word(),
            parts.join("."),
            kind.word()
        ));
        Pending {
            item: DiffItem {
                id,
                kind,
                object,
                path,
                scriptable: Ok(()),
                ..DiffItem::default()
            },
            table_key: String::new(),
            key: String::new(),
            wants: Vec::new(),
        }
    }

    fn side<'a>(&self, m: &'a SchemaModel, schema: &Option<String>) -> Side<'a> {
        let in_scope = |s: &Option<String>| match (s, schema) {
            (Some(s), Some(side)) => self.same_schema(s, side),
            _ => true,
        };
        let mut other_schema = Vec::new();
        let mut enums = BTreeMap::new();
        for e in &m.enums {
            if in_scope(&e.schema) {
                enums.entry(self.fold(NameKind::Enum, &e.name)).or_insert(e);
            }
        }
        let mut tables = BTreeMap::new();
        for t in &m.tables {
            if !in_scope(&t.schema) {
                other_schema.push(format!(
                    "{}.{}",
                    t.schema.as_deref().unwrap_or_default(),
                    t.name
                ));
                continue;
            }
            let key = self.fold(NameKind::Table, &t.name);
            if tables.contains_key(&key) {
                continue;
            }
            tables.insert(key, self.table(t, schema, &enums));
        }
        let mut refs = Vec::new();
        for r in &m.refs {
            if !in_scope(&r.from.schema) {
                continue;
            }
            let from_table = self.fold(NameKind::Table, &r.from.table);
            if !tables.contains_key(&from_table) {
                continue;
            }
            let own = |s: &Option<String>| match s {
                None => true,
                Some(s) => {
                    schema
                        .as_deref()
                        .is_some_and(|side| self.same_schema(s, side))
                        || r.from
                            .schema
                            .as_deref()
                            .is_some_and(|f| self.same_schema(s, f))
                }
            };
            let to_schema = (!own(&r.to.schema)).then(|| r.to.schema.clone()).flatten();
            let to_name = self.fold(NameKind::Table, &r.to.table);
            let to_table = match &to_schema {
                Some(s) => format!("{}.{to_name}", self.fold(NameKind::Schema, s)),
                None => to_name,
            };
            refs.push(NRef {
                raw: r,
                from_table,
                from_cols: r
                    .from
                    .columns
                    .iter()
                    .map(|c| self.fold(NameKind::Column, c))
                    .collect(),
                to_table,
                to_cols: r
                    .to
                    .columns
                    .iter()
                    .map(|c| self.fold(NameKind::Column, c))
                    .collect(),
                to_schema,
                on_delete: self.action(&r.on_delete),
                on_update: self.action(&r.on_update),
            });
        }
        Side {
            schema: schema.clone(),
            tables,
            enums,
            refs,
            other_schema,
        }
    }

    /// `NO ACTION` is the default everywhere, and InnoDB treats RESTRICT alike.
    fn action(&self, a: &Option<String>) -> Option<String> {
        let a = a
            .as_deref()?
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let a = a.to_ascii_uppercase();
        let default = a == "NO ACTION" || (self.d == DialectKind::MySql && a == "RESTRICT");
        (!default && !a.is_empty()).then_some(a)
    }

    /// A column type without the side's schema in front (`billing.invoice_status`),
    /// and the enum it names, if any.
    fn column_type<'e>(
        &self,
        type_name: &str,
        schema: &Option<String>,
        enums: &BTreeMap<String, &'e SmEnum>,
    ) -> (String, Option<&'e SmEnum>) {
        let mut text = type_name.trim();
        if let Some(s) = schema {
            for prefix in [format!("{s}."), format!("\"{s}\".")] {
                if let Some(rest) = text.strip_prefix(prefix.as_str()) {
                    text = rest;
                    break;
                }
            }
        }
        let bare = text.trim_matches('"');
        let found = enums
            .get(&self.fold(NameKind::Enum, bare))
            .copied()
            .or_else(|| {
                // Only an enum in scope: `other.status` is not the local `status`.
                enums
                    .values()
                    .find(|e| e.name.eq_ignore_ascii_case(bare))
                    .copied()
            });
        (text.to_string(), found)
    }

    fn table<'a>(
        &self,
        t: &'a SmTable,
        schema: &Option<String>,
        enums: &BTreeMap<String, &'a SmEnum>,
    ) -> NTable<'a> {
        let pk: Vec<String> = match t.indexes.iter().find(|i| i.pk) {
            Some(i) => i.columns.clone(),
            None => t
                .columns
                .iter()
                .filter(|c| c.pk)
                .map(|c| c.name.clone())
                .collect(),
        };
        let pk_keys: Vec<String> = pk.iter().map(|c| self.fold(NameKind::Column, c)).collect();
        let col_keys: Vec<String> = t
            .columns
            .iter()
            .map(|c| self.fold(NameKind::Column, &c.name))
            .collect();
        // A single-column unique index is the column's unique flag, as the
        // snapshots fold it.
        let mut unique_cols = BTreeSet::new();
        let mut indexes = Vec::new();
        for i in t.indexes.iter().filter(|i| !i.pk) {
            let keys: Vec<String> = i
                .columns
                .iter()
                .map(|c| self.fold(NameKind::Column, c))
                .collect();
            if i.unique && keys.len() == 1 && col_keys.contains(&keys[0]) {
                unique_cols.insert(keys[0].clone());
                continue;
            }
            indexes.push(NIndex {
                raw: i,
                name_key: i.name.as_ref().map(|n| self.fold(NameKind::Index, n)),
                col_keys: keys,
            });
        }
        let single_pk = pk.len() == 1;
        let cols = t
            .columns
            .iter()
            .zip(col_keys)
            .map(|(c, key)| {
                let in_pk = pk_keys.contains(&key);
                let (text, en) = self.column_type(&c.type_name, schema, enums);
                let (ty, enum_key) = match (en, self.d) {
                    (Some(e), DialectKind::Postgres) => {
                        (e.name.clone(), Some(self.fold(NameKind::Enum, &e.name)))
                    }
                    // MySQL writes a model enum inline, SQLite as TEXT with a CHECK.
                    (Some(e), DialectKind::MySql) => {
                        let values: Vec<String> = e
                            .values
                            .iter()
                            .map(|v| format!("'{}'", v.replace('\'', "''")))
                            .collect();
                        (
                            normalise_type(self.d, &format!("enum({})", values.join(","))),
                            None,
                        )
                    }
                    (Some(_), DialectKind::Sqlite) => (normalise_type(self.d, "text"), None),
                    (None, _) => (normalise_type(self.d, &text), None),
                };
                // A single INTEGER primary key is SQLite's rowid, which fills itself in.
                let rowid = self.d == DialectKind::Sqlite
                    && single_pk
                    && in_pk
                    && c.type_name.trim().eq_ignore_ascii_case("integer");
                let tref = TableRef {
                    schema: t.schema.as_deref(),
                    name: &t.name,
                };
                let own_sequence = is_own_sequence_default(tref, c);
                let default = if own_sequence {
                    None
                } else {
                    c.default
                        .as_ref()
                        .and_then(|d| default_key(self.d, tref, c, d))
                };
                // `serial` is NOT NULL too, and MySQL's SERIAL also UNIQUE.
                let serial = implies_increment(self.d, &text);
                NCol {
                    raw: c,
                    increment: c.increment || serial || rowid || own_sequence,
                    not_null: c.not_null || in_pk || serial,
                    unique: c.unique
                        || unique_cols.contains(&key)
                        || (serial && self.d == DialectKind::MySql),
                    key,
                    ty,
                    enum_key,
                    default,
                    // SQLite has no comments.
                    note: if self.d == DialectKind::Sqlite {
                        None
                    } else {
                        c.note.clone()
                    },
                }
            })
            .collect();
        // Matched and listed by key, whatever order the snapshot gave.
        indexes.sort_by_key(index_key);
        NTable {
            raw: t,
            cols,
            pk,
            pk_keys,
            indexes,
        }
    }

    /// The source's table as the target would hold it: in the target's schema.
    fn source_table(&self, t: &SmTable, side: &Side<'_>) -> SmTable {
        let mut def = t.clone();
        def.schema = self.out_schema.clone();
        for c in &mut def.columns {
            c.type_name = self.unqualified_type(&c.type_name, side);
        }
        def
    }

    fn source_column(&self, c: &SmColumn, side: &Side<'_>) -> SmColumn {
        let mut def = c.clone();
        def.type_name = self.unqualified_type(&c.type_name, side);
        def
    }

    /// A type named with the source's schema loses it (`staging.invoice_status`
    /// is `invoice_status`), so it reads in the target's schema.
    fn unqualified_type(&self, type_name: &str, side: &Side<'_>) -> String {
        let text = type_name.trim();
        if let Some(s) = &side.schema {
            for prefix in [format!("{s}."), format!("\"{s}\".")] {
                if let Some(rest) = text.strip_prefix(prefix.as_str()) {
                    return rest.to_string();
                }
            }
        }
        text.to_string()
    }

    fn source_ref(&self, r: &NRef<'_>) -> SmRef {
        let mut def = r.raw.clone();
        def.from.schema = self.out_schema.clone();
        def.to.schema = match &r.to_schema {
            Some(s) => Some(s.clone()),
            None => self.out_schema.clone(),
        };
        def
    }

    fn enums(&self, src: &Side<'_>, tgt: &Side<'_>, b: &mut Builder) {
        let keys: BTreeSet<&String> = src.enums.keys().chain(tgt.enums.keys()).collect();
        for key in keys {
            let source_def = |e: &SmEnum| {
                let mut def = e.clone();
                def.schema = self.out_schema.clone();
                ObjectDef::Enum { def }
            };
            match (src.enums.get(key), tgt.enums.get(key)) {
                (Some(s), None) => {
                    b.push(
                        self.item(DiffKind::Added, DiffObject::Enum, self.path(None, &s.name))
                            .detail(format!("enum, {}", s.values.join(", ")))
                            .source(source_def(s)),
                        "",
                        key,
                    );
                }
                (None, Some(t)) => {
                    // Columns and tables that still use the type go first.
                    let mut wants = Vec::new();
                    for (tk, table) in &tgt.tables {
                        let uses: Vec<&NCol<'_>> = table
                            .cols
                            .iter()
                            .filter(|c| c.enum_key.as_deref() == Some(key.as_str()))
                            .collect();
                        if uses.is_empty() {
                            continue;
                        }
                        wants.push(Want::item(DiffObject::Table, tk, "", REMOVED));
                        for c in uses {
                            wants.push(Want::item(
                                DiffObject::Column,
                                tk,
                                &c.key,
                                REMOVED_OR_CHANGED,
                            ));
                        }
                    }
                    b.push(
                        self.item(
                            DiffKind::Removed,
                            DiffObject::Enum,
                            self.path(None, &t.name),
                        )
                        .detail("enum")
                        .target(ObjectDef::Enum { def: (*t).clone() })
                        .wants(wants),
                        "",
                        key,
                    );
                }
                (Some(s), Some(t)) => {
                    if s.values == t.values {
                        continue;
                    }
                    let added: Vec<String> = s
                        .values
                        .iter()
                        .filter(|v| !t.values.contains(v))
                        .cloned()
                        .collect();
                    let removed: Vec<String> = t
                        .values
                        .iter()
                        .filter(|v| !s.values.contains(v))
                        .cloned()
                        .collect();
                    let kept_s: Vec<&String> =
                        s.values.iter().filter(|v| t.values.contains(v)).collect();
                    let kept_t: Vec<&String> =
                        t.values.iter().filter(|v| s.values.contains(v)).collect();
                    let reordered = kept_s != kept_t;
                    let mut p = self
                        .item(
                            DiffKind::Changed,
                            DiffObject::Enum,
                            self.path(None, &t.name),
                        )
                        .detail(enum_detail(&added, &removed, reordered))
                        .source(source_def(s))
                        .target(ObjectDef::Enum { def: (*t).clone() });
                    if !removed.is_empty() {
                        p = p.loses_data();
                        p.item.scriptable = Err(format!(
                            "PostgreSQL cannot remove a value from an enum. Remove {} by hand.",
                            removed.join(", ")
                        ));
                    } else if reordered {
                        p.item.scriptable = Err(format!(
                            "PostgreSQL cannot reorder the values of an enum. Change {} by hand.",
                            t.name
                        ));
                    }
                    p.item.changes.push(Change::EnumValues {
                        added,
                        removed,
                        reordered,
                    });
                    b.push(p, "", key);
                }
                (None, None) => {}
            }
        }
    }

    fn table_pair(
        &self,
        tk: &str,
        s: &NTable<'_>,
        t: &NTable<'_>,
        src: &Side<'_>,
        tgt: &Side<'_>,
        b: &mut Builder,
    ) {
        let table = t.raw.name.as_str();
        // The table itself: only its note.
        let (sn, tn) = if self.d == DialectKind::Sqlite {
            (None, None)
        } else {
            (s.raw.note.clone(), t.raw.note.clone())
        };
        if sn != tn {
            let mut p = self
                .item(DiffKind::Changed, DiffObject::Table, self.path(None, table))
                .detail("note")
                .source(ObjectDef::Table {
                    def: self.source_table(s.raw, src),
                })
                .target(ObjectDef::Table { def: t.raw.clone() });
            p.item.changes.push(Change::Note { from: tn, to: sn });
            b.push(p, tk, "");
        }

        // Columns: the source's order, then the target's removed ones.
        for sc in &s.cols {
            match t.col(&sc.key) {
                None => {
                    let mut wants = Vec::new();
                    if let Some(e) = &sc.enum_key {
                        wants.push(Want::enum_ready(e));
                    }
                    b.push(
                        self.item(
                            DiffKind::Added,
                            DiffObject::Column,
                            self.path(Some(table), &sc.raw.name),
                        )
                        .detail(sc.ty.clone())
                        .source(ObjectDef::Column {
                            def: self.source_column(sc.raw, src),
                        })
                        .wants(wants),
                        tk,
                        &sc.key,
                    );
                }
                Some(tc) => {
                    let changes = column_changes(tc, sc);
                    if changes.is_empty() {
                        continue;
                    }
                    let mut wants = Vec::new();
                    if let Some(e) = &sc.enum_key {
                        wants.push(Want::enum_ready(e));
                    }
                    let mut p = self
                        .item(
                            DiffKind::Changed,
                            DiffObject::Column,
                            self.path(Some(table), &tc.raw.name),
                        )
                        .detail(change_detail(&changes))
                        .source(ObjectDef::Column {
                            def: self.source_column(sc.raw, src),
                        })
                        .target(ObjectDef::Column {
                            def: tc.raw.clone(),
                        })
                        .wants(wants);
                    let narrows = changes.iter().any(|c| match c {
                        Change::Type { from, to } => narrowing(from, to),
                        Change::EnumValues { removed, .. } => !removed.is_empty(),
                        _ => false,
                    });
                    if narrows {
                        p = p.loses_data();
                    }
                    p.item.changes = changes;
                    b.push(p, tk, &sc.key);
                }
            }
        }
        for tc in t.cols.iter().filter(|tc| s.col(&tc.key).is_none()) {
            b.push(
                self.item(
                    DiffKind::Removed,
                    DiffObject::Column,
                    self.path(Some(table), &tc.raw.name),
                )
                .detail(tc.ty.clone())
                .loses_data()
                .target(ObjectDef::Column {
                    def: tc.raw.clone(),
                })
                .wants(vec![Want::DropsOn {
                    table: tk.to_string(),
                    column: Some(tc.key.clone()),
                }]),
                tk,
                &tc.key,
            );
        }

        // The primary key, by column list.
        if s.pk_keys != t.pk_keys {
            let kind = match (s.pk.is_empty(), t.pk.is_empty()) {
                (false, true) => DiffKind::Added,
                (true, false) => DiffKind::Removed,
                _ => DiffKind::Changed,
            };
            // A primary key has no name the snapshots keep: it is named by its
            // columns (the source's, or the target's when removed). The id leaves
            // them out, so it survives a change of columns.
            let cols = if kind == DiffKind::Removed {
                &t.pk
            } else {
                &s.pk
            };
            let pk_name = format!("({})", cols.join(", "));
            let mut p = self
                .item(
                    kind,
                    DiffObject::PrimaryKey,
                    self.path(Some(table), &pk_name),
                )
                .detail(format!("primary key {pk_name}"));
            if !s.pk.is_empty() {
                p = p.source(ObjectDef::PrimaryKey {
                    columns: s.pk.clone(),
                });
                let wants = s
                    .pk_keys
                    .iter()
                    .map(|c| Want::added(DiffObject::Column, tk, c))
                    .collect();
                p = p.wants(wants);
            }
            if !t.pk.is_empty() {
                p = p.target(ObjectDef::PrimaryKey {
                    columns: t.pk.clone(),
                });
            }
            if kind == DiffKind::Changed {
                p.item.changes.push(Change::Columns {
                    from: t.pk.clone(),
                    to: s.pk.clone(),
                });
            }
            b.push(p, tk, "");
        }

        let keys = |side: &Side<'_>| -> Vec<KeyCols> {
            side.refs
                .iter()
                .filter(|r| r.from_table == tk)
                .map(|r| KeyCols {
                    name: r.raw.name.as_ref().map(|n| self.fold(NameKind::Index, n)),
                    cols: r.from_cols.clone(),
                })
                .collect()
        };
        self.indexes(tk, table, (s, &keys(src)), (t, &keys(tgt)), b);
    }

    /// Indexes match by name when both sides name them, otherwise by column list
    /// and uniqueness. On MySQL, a plain index that MySQL made for a Foreign Key
    /// on exactly its columns, on both sides, matches by columns whatever its name
    /// (R12, R14): MySQL names that index after the key or the key's first column,
    /// and makes it again under the key's name when the key is dropped and added.
    /// An index the user named otherwise keeps its name, so a rename still shows.
    fn indexes(
        &self,
        tk: &str,
        table: &str,
        (s, s_keys): (&NTable<'_>, &[KeyCols]),
        (t, t_keys): (&NTable<'_>, &[KeyCols]),
        b: &mut Builder,
    ) {
        let backs_key = |x: &NIndex<'_>, keys: &[KeyCols]| {
            if self.d != DialectKind::MySql || x.raw.unique {
                return false;
            }
            let Some(name) = &x.name_key else {
                return false;
            };
            let first = x.raw.columns.first().map(|c| self.fold(NameKind::Index, c));
            keys.iter().any(|k| {
                k.cols == x.col_keys
                    && (first.as_ref() == Some(name)
                        || k.name.as_ref() == Some(name)
                        || mysql_key_name(table, name))
            })
        };
        let mut matched_t = vec![false; t.indexes.len()];
        let mut pairs: Vec<(usize, Option<usize>)> = Vec::new();
        for (si, sx) in s.indexes.iter().enumerate() {
            let by_name = sx.name_key.as_ref().and_then(|n| {
                t.indexes
                    .iter()
                    .enumerate()
                    .find(|(ti, tx)| !matched_t[*ti] && tx.name_key.as_ref() == Some(n))
                    .map(|(ti, _)| ti)
            });
            let found = by_name.or_else(|| {
                t.indexes
                    .iter()
                    .enumerate()
                    .find(|(ti, tx)| {
                        !matched_t[*ti]
                            && (sx.name_key.is_none()
                                || tx.name_key.is_none()
                                || (backs_key(sx, s_keys) && backs_key(tx, t_keys)))
                            && tx.col_keys == sx.col_keys
                            && tx.raw.unique == sx.raw.unique
                    })
                    .map(|(ti, _)| ti)
            });
            if let Some(ti) = found {
                matched_t[ti] = true;
            }
            pairs.push((si, found));
        }
        let label = |x: &NIndex<'_>| match &x.raw.name {
            Some(n) => n.clone(),
            None => format!("({})", x.raw.columns.join(", ")),
        };
        let word = |x: &NIndex<'_>| {
            if x.raw.unique {
                "unique index"
            } else {
                "index"
            }
        };
        for (si, found) in pairs {
            let sx = &s.indexes[si];
            let column_wants: Vec<Want> = sx
                .col_keys
                .iter()
                .map(|c| Want::added(DiffObject::Column, tk, c))
                .collect();
            match found {
                None => {
                    b.push(
                        self.item(
                            DiffKind::Added,
                            DiffObject::Index,
                            self.path(Some(table), &label(sx)),
                        )
                        .detail(word(sx))
                        .source(ObjectDef::Index {
                            def: sx.raw.clone(),
                        })
                        .wants(column_wants),
                        tk,
                        &index_key(sx),
                    );
                }
                Some(ti) => {
                    let tx = &t.indexes[ti];
                    let mut changes = Vec::new();
                    if tx.col_keys != sx.col_keys {
                        changes.push(Change::Columns {
                            from: tx.raw.columns.clone(),
                            to: sx.raw.columns.clone(),
                        });
                    }
                    if tx.raw.unique != sx.raw.unique {
                        changes.push(Change::Unique {
                            from: tx.raw.unique,
                            to: sx.raw.unique,
                        });
                    }
                    if changes.is_empty() {
                        continue;
                    }
                    let mut p = self
                        .item(
                            DiffKind::Changed,
                            DiffObject::Index,
                            self.path(Some(table), &label(tx)),
                        )
                        .detail(change_detail(&changes))
                        .source(ObjectDef::Index {
                            def: sx.raw.clone(),
                        })
                        .target(ObjectDef::Index {
                            def: tx.raw.clone(),
                        })
                        .wants(column_wants);
                    p.item.changes = changes;
                    b.push(p, tk, &index_key(tx));
                }
            }
        }
        for (ti, tx) in t.indexes.iter().enumerate() {
            if matched_t[ti] {
                continue;
            }
            b.push(
                self.item(
                    DiffKind::Removed,
                    DiffObject::Index,
                    self.path(Some(table), &label(tx)),
                )
                .detail(word(tx))
                .target(ObjectDef::Index {
                    def: tx.raw.clone(),
                }),
                tk,
                &index_key(tx),
            );
        }
    }

    /// The Foreign Keys of one table, matched by columns, target table and target
    /// columns (names are ignored: the snapshots hide the automatic ones). The keys
    /// of a removed table go with it.
    fn foreign_keys(&self, tk: &str, src: &Side<'_>, tgt: &Side<'_>, b: &mut Builder) {
        // A removed table's keys go with it.
        if !src.tables.contains_key(tk) {
            return;
        }
        let mut s_refs: Vec<&NRef<'_>> = src.refs.iter().filter(|r| r.from_table == tk).collect();
        let mut t_refs: Vec<&NRef<'_>> = tgt.refs.iter().filter(|r| r.from_table == tk).collect();
        s_refs.sort_by_key(|r| r.key());
        t_refs.sort_by_key(|r| r.key());
        let table_name = |side: &Side<'_>| side.tables.get(tk).map(|t| t.raw.name.clone());
        let out_table = table_name(tgt)
            .or_else(|| table_name(src))
            .unwrap_or_default();
        let mut matched_t = vec![false; t_refs.len()];
        for sr in &s_refs {
            let found = t_refs
                .iter()
                .enumerate()
                .find(|(ti, tr)| !matched_t[*ti] && tr.key() == sr.key())
                .map(|(ti, _)| ti);
            let mut wants = vec![
                Want::added(DiffObject::Table, tk, ""),
                Want::added(DiffObject::Table, &sr.to_table, ""),
            ];
            // A primary key on exactly the referenced columns must exist first.
            let keyed = src
                .tables
                .get(&sr.to_table)
                .is_some_and(|t| t.pk_keys == sr.to_cols);
            if keyed {
                wants.push(Want::item(
                    DiffObject::PrimaryKey,
                    &sr.to_table,
                    "",
                    ADDED_OR_CHANGED,
                ));
            }
            wants.extend(
                sr.from_cols
                    .iter()
                    .map(|c| Want::added(DiffObject::Column, tk, c)),
            );
            wants.extend(
                sr.to_cols
                    .iter()
                    .map(|c| Want::added(DiffObject::Column, &sr.to_table, c)),
            );
            let def = ObjectDef::ForeignKey {
                def: self.source_ref(sr),
            };
            match found {
                None => {
                    let p = self
                        .item(
                            DiffKind::Added,
                            DiffObject::ForeignKey,
                            self.path(Some(&out_table), &fk_label(sr)),
                        )
                        .detail("Foreign Key")
                        .source(def)
                        .wants(wants);
                    b.push_fk(p, tk, sr);
                }
                Some(ti) => {
                    matched_t[ti] = true;
                    let tr = t_refs[ti];
                    let mut changes = Vec::new();
                    if tr.on_delete != sr.on_delete {
                        changes.push(Change::OnDelete {
                            from: tr.on_delete.clone(),
                            to: sr.on_delete.clone(),
                        });
                    }
                    if tr.on_update != sr.on_update {
                        changes.push(Change::OnUpdate {
                            from: tr.on_update.clone(),
                            to: sr.on_update.clone(),
                        });
                    }
                    if changes.is_empty() {
                        continue;
                    }
                    let mut p = self
                        .item(
                            DiffKind::Changed,
                            DiffObject::ForeignKey,
                            self.path(Some(&out_table), &fk_label(tr)),
                        )
                        .detail(change_detail(&changes))
                        .source(def)
                        .target(ObjectDef::ForeignKey {
                            def: tr.raw.clone(),
                        })
                        .wants(wants);
                    p.item.changes = changes;
                    b.push_fk(p, tk, tr);
                }
            }
        }
        for (ti, tr) in t_refs.iter().enumerate() {
            if matched_t[ti] {
                continue;
            }
            let p = self
                .item(
                    DiffKind::Removed,
                    DiffObject::ForeignKey,
                    self.path(Some(&out_table), &fk_label(tr)),
                )
                .detail("Foreign Key")
                .target(ObjectDef::ForeignKey {
                    def: tr.raw.clone(),
                });
            b.push_fk(p, tk, tr);
        }
    }
}

/// An item's definition as SQL text in `d`, as the UI shows it: a table's
/// `CREATE TABLE` and its indexes, a column's line, a key, an index or an enum.
/// `enums` are that side's enums, which MySQL and SQLite write inline.
fn def_text(d: DialectKind, def: &ObjectDef, enums: &[SmEnum]) -> String {
    use crate::ddl;
    let q = |name: &str| crate::common::sql_ident(d, name);
    let qualified = |schema: &Option<String>, name: &str| match (schema, d) {
        (Some(s), DialectKind::Postgres) => format!("{}.{}", q(s), q(name)),
        _ => q(name),
    };
    match def {
        ObjectDef::Table { def } => {
            let model = SchemaModel {
                dialect: d,
                tables: vec![def.clone()],
                refs: Vec::new(),
                enums: enums.to_vec(),
                skipped: Vec::new(),
            };
            let opts = ddl::DdlOptions {
                sqlite_autoincrement_as_note: true,
                ..ddl::DdlOptions::default()
            };
            match ddl::parts(&model, &opts) {
                Ok(p) => p
                    .tables
                    .into_iter()
                    .chain(p.indexes)
                    .collect::<Vec<_>>()
                    .join("\n"),
                Err(_) => format!("CREATE TABLE {}", qualified(&def.schema, &def.name)),
            }
        }
        ObjectDef::Column { def } => ddl::column_sql(
            d,
            &ddl::ColumnSql {
                name: def.name.clone(),
                type_sql: def.type_name.clone(),
                nullable: !def.not_null,
                default_sql: def.default.as_ref().map(|x| ddl::default_sql(d, x)),
                // SQLite's increment is the rowid key, shown on the primary key.
                increment: def.increment && d != DialectKind::Sqlite,
                sqlite_autoincrement: false,
                primary_inline: false,
                unique_inline: def.unique,
                comment: def.note.clone(),
                mysql: None,
                collation: None,
                explicit_null: false,
            },
        ),
        ObjectDef::PrimaryKey { columns } => {
            format!("PRIMARY KEY ({})", ddl::idents(d, columns))
        }
        ObjectDef::Index { def } => {
            let unique = if def.unique { "UNIQUE " } else { "" };
            let name = def
                .name
                .as_deref()
                .map(|n| format!("{} ", q(n)))
                .unwrap_or_default();
            format!("{unique}INDEX {name}({})", ddl::idents(d, &def.columns))
        }
        ObjectDef::ForeignKey { def } => ddl::foreign_key_sql(
            d,
            &ddl::FkSql {
                name: def.name.clone(),
                columns: def.from.columns.clone(),
                target: qualified(&def.to.schema, &def.to.table),
                target_columns: def.to.columns.clone(),
                on_delete: def.on_delete.clone(),
                on_update: def.on_update.clone(),
            },
        ),
        ObjectDef::Enum { def } => format!(
            "CREATE TYPE {} AS ENUM ({})",
            qualified(&def.schema, &def.name),
            def.values
                .iter()
                .map(|v| ddl::lit(d, v))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

fn index_key(x: &NIndex<'_>) -> String {
    match &x.name_key {
        Some(n) => n.clone(),
        None => format!("({})", x.col_keys.join(",")),
    }
}

/// `(customer_id) -> customers(id)`, with the target's schema when it is another.
fn fk_label(r: &NRef<'_>) -> String {
    let schema = r
        .to_schema
        .as_deref()
        .map(|s| format!("{s}."))
        .unwrap_or_default();
    format!(
        "({}) -> {schema}{}({})",
        r.raw.from.columns.join(", "),
        r.raw.to.table,
        r.raw.to.columns.join(", ")
    )
}

/// What differs between a target column `t` and a source column `s`.
fn column_changes(t: &NCol<'_>, s: &NCol<'_>) -> Vec<Change> {
    let mut changes = Vec::new();
    if t.ty != s.ty {
        changes.push(Change::Type {
            from: t.ty.clone(),
            to: s.ty.clone(),
        });
        if let (Some(a), Some(b)) = (enum_params(&t.ty), enum_params(&s.ty)) {
            let added: Vec<String> = b.iter().filter(|v| !a.contains(v)).cloned().collect();
            let removed: Vec<String> = a.iter().filter(|v| !b.contains(v)).cloned().collect();
            let kept_a: Vec<&String> = a.iter().filter(|v| b.contains(v)).collect();
            let kept_b: Vec<&String> = b.iter().filter(|v| a.contains(v)).collect();
            changes.push(Change::EnumValues {
                added,
                removed,
                reordered: kept_a != kept_b,
            });
        }
    }
    if t.not_null != s.not_null {
        changes.push(Change::Nullable {
            from: !t.not_null,
            to: !s.not_null,
        });
    }
    if t.default != s.default {
        changes.push(Change::Default {
            from: t.default.clone(),
            to: s.default.clone(),
        });
    }
    if t.increment != s.increment {
        changes.push(Change::Increment {
            from: t.increment,
            to: s.increment,
        });
    }
    if t.unique != s.unique {
        changes.push(Change::Unique {
            from: t.unique,
            to: s.unique,
        });
    }
    if t.note != s.note {
        changes.push(Change::Note {
            from: t.note.clone(),
            to: s.note.clone(),
        });
    }
    changes
}

/// The values of a MySQL `enum(...)` or `set(...)` type, unquoted.
fn enum_params(ty: &str) -> Option<Vec<String>> {
    let t = crate::transfer::parse_type(ty);
    if t.base != "enum" && t.base != "set" {
        return None;
    }
    Some(
        t.params
            .iter()
            .map(|p| {
                let p = p.trim();
                let inner = p
                    .strip_prefix('\'')
                    .and_then(|x| x.strip_suffix('\''))
                    .unwrap_or(p);
                inner.replace("''", "'")
            })
            .collect(),
    )
}

fn enum_detail(added: &[String], removed: &[String], reordered: bool) -> String {
    let mut parts: Vec<String> = added.iter().map(|v| format!("+ {v}")).collect();
    parts.extend(removed.iter().map(|v| format!("\u{2212} {v}")));
    if reordered {
        parts.push("order".into());
    }
    parts.join(", ")
}

fn change_detail(changes: &[Change]) -> String {
    let enum_values = changes
        .iter()
        .any(|c| matches!(c, Change::EnumValues { .. }));
    let parts: Vec<String> = changes
        .iter()
        .filter_map(|c| {
            Some(match c {
                Change::Type { .. } if enum_values => return None,
                Change::Type { from, to } => format!("{from} to {to}"),
                Change::Nullable { to: true, .. } => "nullable".into(),
                Change::Nullable { to: false, .. } => "not null".into(),
                Change::Default { .. } => "default".into(),
                Change::Increment { .. } => "increment".into(),
                Change::Unique { .. } => "unique".into(),
                Change::Note { .. } => "note".into(),
                Change::OnDelete { .. } => "On delete".into(),
                Change::OnUpdate { .. } => "On update".into(),
                Change::Columns { .. } => "columns".into(),
                Change::EnumValues {
                    added,
                    removed,
                    reordered,
                } => enum_detail(added, removed, *reordered),
            })
        })
        .collect();
    parts.join(", ")
}

// ---------------------------------------------------------------------------
// Not compared, and the summary.

/// Counts a side's left-out objects by kind: its `skipped` entries
/// (`"view v_orders"`), model tables in another schema, and on SQLite, which has
/// no comments, every table and column note.
fn groups(d: DialectKind, m: &SchemaModel, other_schema: &[String]) -> Vec<NotComparedGroup> {
    let mut by_kind: BTreeMap<NotComparedKind, u32> = BTreeMap::new();
    for entry in &m.skipped {
        *by_kind
            .entry(NotComparedKind::of_skipped(entry))
            .or_default() += 1;
    }
    if !other_schema.is_empty() {
        *by_kind.entry(NotComparedKind::OtherSchema).or_default() += other_schema.len() as u32;
    }
    if d == DialectKind::Sqlite {
        let notes = m
            .tables
            .iter()
            .map(|t| {
                usize::from(t.note.is_some())
                    + t.columns.iter().filter(|c| c.note.is_some()).count()
            })
            .sum::<usize>() as u32;
        if notes > 0 {
            *by_kind.entry(NotComparedKind::Comment).or_default() += notes;
        }
    }
    by_kind
        .into_iter()
        .map(|(kind, count)| NotComparedGroup { kind, count })
        .collect()
}

/// `1,234`.
fn grouped(n: u32) -> String {
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

/// `1 view`, `2 views`, `2 expression indexes`, `3 tables in another schema`.
fn counted(n: u32, kind: &str) -> String {
    if n == 1 {
        return format!("1 {kind}");
    }
    let (head, tail) = match kind.find(" in ") {
        Some(at) => (&kind[..at], &kind[at..]),
        None => (kind, ""),
    };
    let plural = if head.ends_with('x') {
        format!("{head}es")
    } else {
        format!("{head}s")
    };
    format!("{} {plural}{tail}", grouped(n))
}

fn group_list(groups: &[NotComparedGroup]) -> String {
    groups
        .iter()
        .map(|g| counted(g.count, g.kind.word()))
        .collect::<Vec<_>>()
        .join(", ")
}

fn summary(items: &[DiffItem], nc: &NotCompared, src: &Side<'_>) -> CompareSummary {
    let count = |k: DiffKind| items.iter().filter(|i| i.kind == k).count() as u32;
    let tables = src.tables.len() as u32;
    let enums = src.enums.len() as u32;
    let indexes = src
        .tables
        .values()
        .map(|t| t.indexes.len() + t.cols.iter().filter(|c| c.unique).count())
        .sum::<usize>() as u32;
    let foreign_keys = src.refs.len() as u32;
    let mut counts = vec![counted(tables, "table")];
    if enums > 0 {
        counts.push(counted(enums, "enum"));
    }
    if indexes > 0 {
        counts.push(counted(indexes, "index"));
    }
    if foreign_keys > 0 {
        counts.push(counted(foreign_keys, "Foreign Key"));
    }
    let same = nc.source == nc.target;
    let not_compared_line = if nc.source.is_empty() && nc.target.is_empty() {
        None
    } else if same {
        Some(format!("Not compared yet: {}.", group_list(&nc.source)))
    } else {
        let mut sides = Vec::new();
        if !nc.source.is_empty() {
            sides.push(format!("{} in the source", group_list(&nc.source)));
        }
        if !nc.target.is_empty() {
            sides.push(format!("{} in the target", group_list(&nc.target)));
        }
        Some(format!("Not compared yet: {}.", sides.join("; ")))
    };
    CompareSummary {
        added: count(DiffKind::Added),
        removed: count(DiffKind::Removed),
        changed: count(DiffKind::Changed),
        tables,
        enums,
        indexes,
        foreign_keys,
        matches: items.is_empty() && same,
        not_compared_same: same,
        counts_line: counts.join(", "),
        not_compared_line,
    }
}

#[cfg(test)]
#[path = "diff_tests.rs"]
mod tests;
