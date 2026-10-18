//! Design edits and the planner that turns them into DDL.

use serde::{Deserialize, Serialize};

use super::model::{Increment, TableColumn, TableDesign, TableForeignKey, TableIndex};
use super::warning::{
    ChildAction, DesignWarning, Rule, TypeChange, rounding, type_base, type_change,
};
use crate::common::{sql_ident, sql_scoped, sql_table};
use crate::ddl::{ColumnSql, FkSql, column_sql, foreign_key_sql, idents, lit};
use crate::error::{Error, Result};
use crate::model::{DialectKind, ObjectPath};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDraft {
    pub name: String,
    /// SQL text, checked by `check_fragment`.
    pub type_sql: String,
    pub nullable: bool,
    /// SQL text, checked by `check_fragment`.
    pub default_sql: Option<String>,
    pub increment: bool,
    pub comment: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexDraft {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDraft {
    pub name: String,
    pub columns: Vec<String>,
    pub target: ObjectPath,
    pub target_columns: Vec<String>,
    pub on_delete: Option<String>,
    pub on_update: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Position {
    Last,
    First,
    After { column: String },
}

/// One change, keyed by the name as loaded.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum DesignEdit {
    AddColumn {
        column: ColumnDraft,
        position: Position,
    },
    DropColumn {
        name: String,
    },
    /// A rename when `column.name != name`.
    ChangeColumn {
        name: String,
        column: ColumnDraft,
    },
    MoveColumn {
        name: String,
        position: Position,
    },
    AddIndex {
        index: IndexDraft,
    },
    DropIndex {
        name: String,
    },
    RenameIndex {
        name: String,
        to: String,
    },
    AddForeignKey {
        key: ForeignKeyDraft,
    },
    DropForeignKey {
        name: String,
    },
    TableComment {
        comment: Option<String>,
    },
}

/// What the edits apply to. Alter and Drop carry the design the UI loaded (D1).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DesignTarget {
    Alter { base: TableDesign },
    Create { path: ObjectPath },
    Drop { base: TableDesign },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesignRequest {
    pub target: DesignTarget,
    pub edits: Vec<DesignEdit>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DesignMode {
    /// One MySQL statement: all or nothing.
    Atomic,
    /// MySQL statements one by one; the ones before a failure stay applied.
    Sequential,
    Transaction,
    /// Shown for copying only; Apply refuses it.
    CopyOnly {
        reason: String,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesignPlan {
    pub statements: Vec<String>,
    pub warnings: Vec<DesignWarning>,
    pub mode: DesignMode,
    /// Leading statements that run before the transaction (SQLite rebuild only).
    pub before: usize,
    /// Trailing statements that run after it, also after a failure (SQLite rebuild only).
    pub after: usize,
    /// Positions of the statements that are checks (SQLite rebuild): a check that
    /// returns any row fails the plan, and the transaction rolls back.
    #[serde(default)]
    pub checks: Vec<usize>,
    /// SQLite rebuild: the `PRAGMA foreign_keys` value the `after` statements
    /// restore, as loaded. The runner refuses before any statement when the
    /// connection's value differs, so the value it finds is the value restored.
    #[serde(default)]
    pub foreign_keys: Option<bool>,
    /// SQLite Alter and Drop: the saved SQL the plan was made from. The runner
    /// compares it with the server inside its transaction and refuses on any
    /// difference (S14). Never sent to the UI and never part of a pass.
    #[serde(skip)]
    pub(crate) loaded: Option<LoadedSchema>,
}

/// The `sqlite_schema` rows a SQLite plan was made from.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub(crate) struct LoadedSchema {
    pub database: String,
    pub table: String,
    /// `(type, name, sql)` of the table and of its indexes and triggers that have
    /// saved SQL: every row whose `tbl_name` is the table.
    pub own: Vec<(String, String, String)>,
    /// `(type, name, sql)` of the loaded views and their triggers, which a
    /// rebuild drops and recreates.
    pub named: Vec<(String, String, String)>,
    /// Drop only: `(name, sql)` of every other table with a Foreign Key to this
    /// one, whose ON DELETE actions the drop runs and the warning names (S15).
    pub children: Option<Vec<(String, String)>>,
}

/// The rows of `base` a SQLite apply must still find; `None` without SQLite extras.
fn loaded_schema(base: &TableDesign) -> Option<LoadedSchema> {
    let extras = base.sqlite.as_ref()?;
    let row =
        |kind: &str, name: &str, sql: &str| (kind.to_string(), name.to_string(), sql.to_string());
    let mut own = vec![row("table", &base.path.name, &extras.create_sql)];
    own.extend(
        base.indexes
            .iter()
            .filter_map(|i| i.sql.as_deref().map(|sql| row("index", &i.name, sql))),
    );
    own.extend(
        extras
            .triggers
            .iter()
            .map(|t| row("trigger", &t.name, &t.sql)),
    );
    let mut named: Vec<_> = extras
        .views
        .iter()
        .map(|v| row("view", &v.name, &v.sql))
        .collect();
    named.extend(
        extras
            .view_triggers
            .iter()
            .map(|t| row("trigger", &t.name, &t.sql)),
    );
    Some(LoadedSchema {
        database: base.path.database.clone(),
        table: base.path.name.clone(),
        own,
        named,
        children: None,
    })
}

/// The refusal when the table on the server is not the design the plan was made from (S14).
pub(crate) const TABLE_CHANGED: &str =
    "The table changed since it was opened. Reload it and make the change again.";

/// The exact DDL for a request. Pure: the same request gives the same text.
pub fn plan_design(kind: DialectKind, req: &DesignRequest) -> Result<DesignPlan> {
    let mut plan = match &req.target {
        DesignTarget::Create { path } => plan_create(kind, path, &req.edits),
        DesignTarget::Drop { base } => plan_drop(kind, base, &req.edits),
        DesignTarget::Alter { base } => match kind {
            DialectKind::MySql => super::mysql::plan(&diff(kind, base, &req.edits)?),
            DialectKind::Postgres => super::postgres::plan(base, &req.edits),
            DialectKind::Sqlite => super::sqlite::plan(base, &req.edits),
        },
    }?;
    if kind == DialectKind::Sqlite
        && let DesignTarget::Alter { base } | DesignTarget::Drop { base } = &req.target
    {
        plan.loaded = loaded_schema(base);
        if let (DesignTarget::Drop { .. }, Some(loaded), Some(extras)) =
            (&req.target, plan.loaded.as_mut(), base.sqlite.as_ref())
        {
            loaded.children = Some(
                extras
                    .children
                    .iter()
                    .map(|c| (c.name.clone(), c.sql.clone()))
                    .collect(),
            );
        }
    }
    Ok(plan)
}

pub(crate) fn invalid(message: impl Into<String>) -> Error {
    Error::InvalidInput(message.into())
}

const NEEDS_NAME: &str = "Add a name and at least one column.";

/// The columns, keys and comment a table has once its edits are applied.
///
/// Each `*_origins` entry runs beside its list and holds the item's name as
/// loaded, or `None` for an item the edits add, so a rename is never guessed.
#[derive(Default)]
pub(crate) struct Draft {
    pub columns: Vec<ColumnDraft>,
    pub column_origins: Vec<Option<String>>,
    /// Loaded names of the columns a `MoveColumn` moved.
    pub moved: Vec<String>,
    pub indexes: Vec<IndexDraft>,
    pub index_origins: Vec<Option<String>>,
    pub foreign_keys: Vec<ForeignKeyDraft>,
    pub key_origins: Vec<Option<String>>,
    pub comment: Option<String>,
    /// The table itself, so a rename also reaches a self-referencing key's target columns.
    pub table: Option<ObjectPath>,
}

/// `target` names `table` (an empty database or no schema means the table's own).
fn same_table(table: &ObjectPath, target: &ObjectPath) -> bool {
    target.name == table.name
        && (target.database.is_empty() || target.database == table.database)
        && (target.schema.is_none() || target.schema == table.schema)
}

/// A loaded column as the designer shows it before any edit.
pub(crate) fn column_draft(c: &TableColumn) -> ColumnDraft {
    ColumnDraft {
        name: c.name.clone(),
        type_sql: c.type_sql.clone(),
        nullable: c.nullable,
        default_sql: c.default_sql.clone(),
        increment: c.increment != Increment::None,
        comment: c.comment.clone(),
    }
}

impl Draft {
    /// The loaded table, every item tracked by its loaded name.
    pub(crate) fn from_base(base: &TableDesign) -> Draft {
        Draft {
            columns: base.columns.iter().map(column_draft).collect(),
            column_origins: base.columns.iter().map(|c| Some(c.name.clone())).collect(),
            moved: Vec::new(),
            indexes: base
                .indexes
                .iter()
                .map(|i| IndexDraft {
                    name: i.name.clone(),
                    columns: i.columns.clone(),
                    unique: i.unique,
                    primary: i.primary,
                })
                .collect(),
            index_origins: base.indexes.iter().map(|i| Some(i.name.clone())).collect(),
            foreign_keys: base
                .foreign_keys
                .iter()
                .map(|k| ForeignKeyDraft {
                    name: k.name.clone(),
                    columns: k.columns.clone(),
                    target: k.target.clone(),
                    target_columns: k.target_columns.clone(),
                    on_delete: k.on_delete.clone(),
                    on_update: k.on_update.clone(),
                })
                .collect(),
            key_origins: base
                .foreign_keys
                .iter()
                .map(|k| Some(k.name.clone()))
                .collect(),
            comment: base.comment.clone(),
            table: Some(base.path.clone()),
        }
    }

    fn column_at(&self, name: &str) -> Result<usize> {
        self.columns
            .iter()
            .position(|c| c.name == name)
            .ok_or_else(|| invalid(format!("There is no column {name}.")))
    }

    fn insert(
        &mut self,
        column: ColumnDraft,
        origin: Option<String>,
        position: &Position,
    ) -> Result<()> {
        if self.columns.iter().any(|c| c.name == column.name) {
            return Err(invalid(format!(
                "There is already a column {}.",
                column.name
            )));
        }
        let at = match position {
            Position::Last => self.columns.len(),
            Position::First => 0,
            Position::After { column } => self.column_at(column)? + 1,
        };
        self.columns.insert(at, column);
        self.column_origins.insert(at, origin);
        Ok(())
    }

    fn index_at(&self, name: &str) -> Result<usize> {
        self.indexes
            .iter()
            .position(|i| i.name == name)
            .ok_or_else(|| invalid(format!("There is no index {name}.")))
    }

    fn index_name_free(&self, name: &str) -> Result<()> {
        if !name.trim().is_empty() && self.indexes.iter().any(|i| i.name == name) {
            return Err(invalid(format!("There is already an index {name}.")));
        }
        Ok(())
    }

    /// Applies the edits in order; a name that is not there, or one already
    /// taken, is `InvalidInput`.
    pub(crate) fn apply(&mut self, edits: &[DesignEdit]) -> Result<()> {
        for edit in edits {
            match edit {
                DesignEdit::AddColumn { column, position } => {
                    self.insert(column.clone(), None, position)?;
                }
                DesignEdit::DropColumn { name } => {
                    let at = self.column_at(name)?;
                    self.columns.remove(at);
                    self.column_origins.remove(at);
                }
                DesignEdit::ChangeColumn { name, column } => {
                    let at = self.column_at(name)?;
                    if column.name != *name {
                        if self.columns.iter().any(|c| c.name == column.name) {
                            return Err(invalid(format!(
                                "There is already a column {}.",
                                column.name
                            )));
                        }
                        // Indexes and keys follow the column to its new name, and so
                        // does a self-referencing key's target.
                        let rename = |list: &mut Vec<String>| {
                            for c in list.iter_mut().filter(|c| **c == *name) {
                                *c = column.name.clone();
                            }
                        };
                        for i in &mut self.indexes {
                            rename(&mut i.columns);
                        }
                        for k in &mut self.foreign_keys {
                            rename(&mut k.columns);
                            if self
                                .table
                                .as_ref()
                                .is_some_and(|t| same_table(t, &k.target))
                            {
                                rename(&mut k.target_columns);
                            }
                        }
                    }
                    self.columns[at] = column.clone();
                }
                DesignEdit::MoveColumn { name, position } => {
                    let at = self.column_at(name)?;
                    let column = self.columns.remove(at);
                    let origin = self.column_origins.remove(at);
                    if let Some(o) = &origin
                        && !self.moved.contains(o)
                    {
                        self.moved.push(o.clone());
                    }
                    self.insert(column, origin, position)?;
                }
                DesignEdit::AddIndex { index } => {
                    self.index_name_free(&index.name)?;
                    self.indexes.push(index.clone());
                    self.index_origins.push(None);
                }
                DesignEdit::DropIndex { name } => {
                    let at = self.index_at(name)?;
                    self.indexes.remove(at);
                    self.index_origins.remove(at);
                }
                DesignEdit::RenameIndex { name, to } => {
                    let at = self.index_at(name)?;
                    if to.trim().is_empty() {
                        return Err(invalid("Every index needs a name."));
                    }
                    if to != name {
                        self.index_name_free(to)?;
                    }
                    self.indexes[at].name = to.clone();
                }
                DesignEdit::AddForeignKey { key } => {
                    if !key.name.trim().is_empty()
                        && self.foreign_keys.iter().any(|k| k.name == key.name)
                    {
                        return Err(invalid(format!(
                            "There is already a Foreign Key {}.",
                            key.name
                        )));
                    }
                    self.foreign_keys.push(key.clone());
                    self.key_origins.push(None);
                }
                DesignEdit::DropForeignKey { name } => {
                    let at = self
                        .foreign_keys
                        .iter()
                        .position(|k| k.name == *name)
                        .ok_or_else(|| invalid(format!("There is no Foreign Key {name}.")))?;
                    self.foreign_keys.remove(at);
                    self.key_origins.remove(at);
                }
                DesignEdit::TableComment { comment } => self.comment = comment.clone(),
            }
        }
        Ok(())
    }
}

/// The column's type, checked; its default, checked, with blank text as none.
pub(crate) fn checked_fragments(c: &ColumnDraft) -> Result<(String, Option<String>)> {
    let type_sql = c.type_sql.trim();
    if !super::check_fragment(type_sql) {
        return Err(invalid(format!(
            "The type of {} is not one SQL expression.",
            c.name
        )));
    }
    let default_sql = match c.default_sql.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(d) if super::check_fragment(d) => Some(d.to_string()),
        Some(_) => {
            return Err(invalid(format!(
                "The default of {} is not one SQL expression.",
                c.name
            )));
        }
    };
    Ok((type_sql.to_string(), default_sql))
}

/// An ON DELETE or ON UPDATE action as its keywords, upper case; anything else is refused.
pub(crate) fn checked_action(action: &Option<String>) -> Result<Option<String>> {
    let Some(text) = action else {
        return Ok(None);
    };
    let words = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let upper = words.to_ascii_uppercase();
    match upper.as_str() {
        "CASCADE" | "SET NULL" | "SET DEFAULT" | "RESTRICT" | "NO ACTION" => Ok(Some(upper)),
        _ => Err(invalid(format!("{text} is not a Foreign Key action."))),
    }
}

/// The referenced table as SQL. SQLite takes no schema there; an empty scope
/// is the new table's own.
pub(crate) fn fk_target(
    kind: DialectKind,
    table: &ObjectPath,
    target: &ObjectPath,
) -> Result<String> {
    if kind == DialectKind::Sqlite {
        return Ok(sql_ident(kind, &target.name));
    }
    let mut target = target.clone();
    if target.database.is_empty() {
        target.database = table.database.clone();
    }
    if target.schema.is_none() {
        target.schema = table.schema.clone();
    }
    sql_table(kind, &target)
}

fn plan_create(kind: DialectKind, path: &ObjectPath, edits: &[DesignEdit]) -> Result<DesignPlan> {
    let mut draft = Draft {
        table: Some(path.clone()),
        ..Draft::default()
    };
    draft.apply(edits)?;
    if path.name.trim().is_empty() || draft.columns.is_empty() {
        return Err(invalid(NEEDS_NAME));
    }
    let table = sql_table(kind, path)?;
    let q = |name: &str| sql_ident(kind, name);

    let mut primaries = draft.indexes.iter().filter(|i| i.primary);
    let primary = primaries.next();
    if primaries.next().is_some() {
        return Err(invalid("A table has one primary key."));
    }
    for i in &draft.indexes {
        if !i.primary && i.name.trim().is_empty() {
            return Err(invalid("Every index needs a name."));
        }
        if i.columns.is_empty() {
            return Err(invalid(format!(
                "Index {} needs at least one column.",
                i.name
            )));
        }
    }

    // SQLite: an increment is the rowid alias, the single INTEGER primary key,
    // written inline. The read model reads that key as an increment and cannot
    // tell AUTOINCREMENT apart, so it is not written.
    let mut inline_key = None;
    if kind == DialectKind::Sqlite
        && let Some(c) = draft.columns.iter().find(|c| c.increment)
    {
        let alias = draft.columns.iter().filter(|c| c.increment).count() == 1
            && primary.is_some_and(|p| p.columns == [c.name.clone()])
            && c.type_sql.trim().eq_ignore_ascii_case("integer");
        if !alias {
            return Err(invalid(format!(
                "SQLite can only auto-increment a single INTEGER primary key ({}.{})",
                path.name, c.name
            )));
        }
        inline_key = Some(c.name.clone());
    }

    let mut lines = Vec::new();
    for c in &draft.columns {
        if c.name.trim().is_empty() {
            return Err(invalid("Every column needs a name."));
        }
        let (type_sql, default_sql) = checked_fragments(c)?;
        let inline = inline_key.as_deref() == Some(c.name.as_str());
        lines.push(column_sql(
            kind,
            &ColumnSql {
                name: c.name.clone(),
                type_sql,
                nullable: c.nullable,
                default_sql,
                increment: c.increment && kind != DialectKind::Sqlite,
                sqlite_autoincrement: false,
                primary_inline: inline,
                unique_inline: false,
                comment: c.comment.clone().filter(|n| !n.is_empty()),
                mysql: None,
                collation: None,
                explicit_null: false,
            },
        ));
    }
    if let Some(p) = primary.filter(|_| inline_key.is_none()) {
        let name = match kind {
            DialectKind::Postgres if !p.name.trim().is_empty() => {
                format!("CONSTRAINT {} ", q(&p.name))
            }
            _ => String::new(),
        };
        lines.push(format!("{name}PRIMARY KEY ({})", idents(kind, &p.columns)));
    }
    if kind == DialectKind::MySql {
        for i in draft.indexes.iter().filter(|i| !i.primary) {
            let unique = if i.unique { "UNIQUE " } else { "" };
            lines.push(format!(
                "{unique}KEY {} ({})",
                q(&i.name),
                idents(kind, &i.columns)
            ));
        }
    }
    for k in &draft.foreign_keys {
        if k.columns.is_empty() || k.columns.len() != k.target_columns.len() {
            return Err(invalid(format!(
                "Foreign Key {} needs the same number of columns on both sides.",
                k.name
            )));
        }
        let named = kind != DialectKind::Sqlite && !k.name.trim().is_empty();
        lines.push(foreign_key_sql(
            kind,
            &FkSql {
                name: named.then(|| k.name.clone()),
                columns: k.columns.clone(),
                target: fk_target(kind, path, &k.target)?,
                target_columns: k.target_columns.clone(),
                on_delete: checked_action(&k.on_delete)?,
                on_update: checked_action(&k.on_update)?,
            },
        ));
    }

    let comment = draft.comment.as_ref().filter(|c| !c.is_empty());
    let tail = match (comment, kind) {
        (Some(c), DialectKind::MySql) => format!(" COMMENT={}", lit(kind, c)),
        _ => String::new(),
    };
    let mut statements = vec![format!(
        "CREATE TABLE {table} (\n  {}\n){tail}",
        lines.join(",\n  ")
    )];

    if kind != DialectKind::MySql {
        for i in draft.indexes.iter().filter(|i| !i.primary) {
            let unique = if i.unique { "UNIQUE " } else { "" };
            // SQLite names the index's schema, never the table's.
            let (name, on) = match kind {
                DialectKind::Sqlite => (sql_scoped(kind, &path.database, &i.name), q(&path.name)),
                _ => (q(&i.name), table.clone()),
            };
            statements.push(format!(
                "CREATE {unique}INDEX {name} ON {on} ({})",
                idents(kind, &i.columns)
            ));
        }
    }
    if kind == DialectKind::Postgres {
        if let Some(c) = comment {
            statements.push(format!("COMMENT ON TABLE {table} IS {}", lit(kind, c)));
        }
        for c in &draft.columns {
            if let Some(n) = c.comment.as_ref().filter(|n| !n.is_empty()) {
                statements.push(format!(
                    "COMMENT ON COLUMN {table}.{} IS {}",
                    q(&c.name),
                    lit(kind, n)
                ));
            }
        }
    }

    Ok(DesignPlan {
        statements,
        warnings: vec![],
        mode: single_mode(kind),
        before: 0,
        after: 0,
        checks: vec![],
        foreign_keys: None,
        loaded: None,
    })
}

/// Orders renames so none takes a name another still holds; a cycle is refused.
pub(crate) fn rename_order(
    mut pending: Vec<(String, String)>,
    what: &str,
) -> Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    while !pending.is_empty() {
        let free = pending
            .iter()
            .position(|(_, to)| !pending.iter().any(|(from, _)| from == to));
        let Some(at) = free else {
            let names: Vec<&str> = pending.iter().map(|(from, _)| from.as_str()).collect();
            return Err(invalid(format!(
                "The {what} {} swap names. Rename one of them in a separate change first.",
                names.join(", ")
            )));
        };
        out.push(pending.remove(at));
    }
    Ok(out)
}

/// MySQL runs one statement all or nothing; the others run in a transaction.
fn single_mode(kind: DialectKind) -> DesignMode {
    match kind {
        DialectKind::MySql => DesignMode::Atomic,
        _ => DesignMode::Transaction,
    }
}

/// Where a MySQL column goes: `FIRST` or `AFTER <name>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Placement {
    First,
    After(String),
}

impl Placement {
    pub(crate) fn sql(&self, kind: DialectKind) -> String {
        match self {
            Placement::First => "FIRST".into(),
            Placement::After(c) => format!("AFTER {}", sql_ident(kind, c)),
        }
    }
}

/// A loaded column that is kept and renamed, changed or moved.
pub(crate) struct ColumnChange {
    pub base: TableColumn,
    /// The column after the edits, its type and default checked, a blank
    /// default or comment read as none.
    pub column: ColumnDraft,
    pub renamed: bool,
    pub type_change: TypeChange,
    pub nullable: bool,
    pub default: bool,
    pub increment: bool,
    pub comment: bool,
    /// MySQL: the column moves (computed on every Dialect; PostgreSQL refuses moves).
    pub placement: Option<Placement>,
}

impl ColumnChange {
    /// Something besides the name or the comment changes.
    pub(crate) fn definition_changed(&self) -> bool {
        self.type_change != TypeChange::Same || self.nullable || self.default || self.increment
    }
}

/// A column the edits add.
pub(crate) struct NewColumn {
    pub column: ColumnDraft,
    /// `None` when it goes last.
    pub placement: Option<Placement>,
    /// It comes after every kept loaded column.
    pub at_end: bool,
}

/// The difference between the loaded table and the edited one, in the order
/// the statements run, with the warnings every Dialect shares.
pub(crate) struct Alter {
    pub path: ObjectPath,
    pub table: String,
    pub dropped_keys: Vec<TableForeignKey>,
    pub dropped_indexes: Vec<TableIndex>,
    pub dropped_columns: Vec<TableColumn>,
    /// In the edited column order.
    pub changes: Vec<ColumnChange>,
    pub added_columns: Vec<NewColumn>,
    /// The loaded index and its new name.
    pub renamed_indexes: Vec<(TableIndex, String)>,
    /// The new primary key first, then the other new indexes in edit order.
    pub added_indexes: Vec<IndexDraft>,
    pub added_keys: Vec<ForeignKeyDraft>,
    /// `Some` when the table comment changes; `Some(None)` clears it.
    pub comment: Option<Option<String>>,
    pub warnings: Vec<DesignWarning>,
}

fn blank_is_none(text: &Option<String>) -> Option<String> {
    text.as_ref()
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

/// The column with its type and default checked and a blank comment read as none.
fn checked_column(c: &ColumnDraft) -> Result<ColumnDraft> {
    if c.name.trim().is_empty() {
        return Err(invalid("Every column needs a name."));
    }
    let (type_sql, default_sql) = checked_fragments(c)?;
    Ok(ColumnDraft {
        name: c.name.clone(),
        type_sql,
        nullable: c.nullable,
        default_sql,
        increment: c.increment,
        comment: c.comment.clone().filter(|n| !n.is_empty()),
    })
}

/// An index or key the read model cannot carry in full (S2): it may be renamed
/// or dropped, never recreated.
fn cannot_recreate(base: &TableDesign, kind: &str, name: &str) -> Error {
    let prefix = format!("{kind} {name} (");
    let note = base
        .unsupported
        .iter()
        .find(|n| n.starts_with(&prefix))
        .cloned()
        .unwrap_or_else(|| format!("{kind} {name}"));
    invalid(format!(
        "Contura cannot recreate {note}. Rename or drop it here, or change it in SQL."
    ))
}

/// A MySQL column with attributes a restatement would lose (S6c): it may be
/// renamed or dropped, never restated.
fn cannot_restate(base: &TableDesign, name: &str) -> Error {
    let prefix = format!("column {name} (");
    let note = base
        .unsupported
        .iter()
        .find(|n| n.starts_with(&prefix))
        .cloned()
        .unwrap_or_else(|| format!("column {name}"));
    invalid(format!(
        "Contura cannot restate {note}. Rename or drop it here, or change it in SQL."
    ))
}

/// MySQL types that carry a character set and a collation.
const MYSQL_TEXT_TYPES: [&str; 8] = [
    "char",
    "varchar",
    "tinytext",
    "text",
    "mediumtext",
    "longtext",
    "enum",
    "set",
];

/// PostgreSQL types a collation applies to.
const POSTGRES_COLLATABLE: [&str; 5] = ["text", "character varying", "character", "citext", "name"];

/// Whether a restated column keeps (its character set and) its collation, and
/// its MySQL `ON UPDATE`, under its new type (S4). The server refuses them on a
/// type that cannot hold them.
pub(crate) fn kept_attributes(
    kind: DialectKind,
    loaded: &TableColumn,
    new_type: &str,
    change: TypeChange,
) -> (bool, bool) {
    if change == TypeChange::Same {
        return (true, true);
    }
    let new_base = type_base(kind, new_type);
    let collation = match kind {
        DialectKind::MySql => MYSQL_TEXT_TYPES.contains(&new_base.as_str()),
        DialectKind::Postgres => {
            new_base == type_base(kind, &loaded.type_sql)
                || POSTGRES_COLLATABLE.contains(&new_base.as_str())
        }
        DialectKind::Sqlite => true,
    };
    let on_update = new_base == "timestamp" || new_base == "datetime";
    (collation, on_update)
}

/// What a type change loses besides values that may not fit, in plain words.
fn narrowing_notes(
    kind: DialectKind,
    column: &str,
    loaded: &TableColumn,
    new_type: &str,
    change: TypeChange,
) -> Vec<String> {
    let mut notes = Vec::new();
    let (from, to) = (type_base(kind, &loaded.type_sql), type_base(kind, new_type));
    if kind == DialectKind::MySql && to == "timestamp" && (from == "date" || from == "datetime") {
        notes.push("MySQL TIMESTAMP holds only dates from 1970 to 2038.".to_string());
    }
    if let Some(what) = rounding(kind, &loaded.type_sql, new_type) {
        notes.push(format!("Values in {column} are rounded to the new {what}."));
    }
    let (keeps_collation, keeps_on_update) = kept_attributes(kind, loaded, new_type, change);
    if let Some(c) = loaded.collation.as_ref().filter(|_| !keeps_collation) {
        notes.push(format!("The column loses its collation {c}."));
    }
    let on_update = loaded.mysql.as_ref().and_then(|m| m.on_update.as_ref());
    if let Some(u) = on_update.filter(|_| !keeps_on_update) {
        notes.push(format!("The column loses ON UPDATE {u}."));
    }
    notes
}

/// The loaded columns that stay where they are: the longest run in loaded order,
/// preferring columns no `MoveColumn` touched. The rest are moved.
fn stationary(kept: &[(usize, bool)]) -> Vec<bool> {
    let n = kept.len();
    let weight = |moved: bool| if moved { 1 } else { n + 1 };
    let mut best = vec![0usize; n];
    let mut parent = vec![None; n];
    for i in 0..n {
        best[i] = weight(kept[i].1);
        for j in 0..i {
            if kept[j].0 < kept[i].0 && best[j] + weight(kept[i].1) > best[i] {
                best[i] = best[j] + weight(kept[i].1);
                parent[i] = Some(j);
            }
        }
    }
    let mut stays = vec![false; n];
    let mut at = (0..n).rev().max_by_key(|&i| best[i]);
    while let Some(i) = at {
        stays[i] = true;
        at = parent[i];
    }
    stays
}

/// Turns the edits on a loaded table into its difference, refusing what the
/// Dialect or the read model cannot do.
pub(crate) fn diff(kind: DialectKind, base: &TableDesign, edits: &[DesignEdit]) -> Result<Alter> {
    let mut draft = Draft::from_base(base);
    draft.apply(edits)?;
    let table = sql_table(kind, &base.path)?;
    let mut warnings = Vec::new();

    // Foreign Keys.
    let mut dropped_keys = Vec::new();
    for k in &base.foreign_keys {
        if !draft.key_origins.contains(&Some(k.name.clone())) {
            dropped_keys.push(k.clone());
            warnings.push(DesignWarning::DropRule {
                rule: Rule::ForeignKey,
                name: k.name.clone(),
            });
        }
    }
    let added_keys: Vec<ForeignKeyDraft> = draft
        .foreign_keys
        .iter()
        .zip(&draft.key_origins)
        .filter(|(_, o)| o.is_none())
        .map(|(k, _)| k.clone())
        .collect();
    for k in &dropped_keys {
        if k.advanced && added_keys.iter().any(|a| a.name == k.name) {
            return Err(cannot_recreate(base, "foreign key", &k.name));
        }
    }
    for k in &added_keys {
        if k.columns.is_empty() || k.columns.len() != k.target_columns.len() {
            return Err(invalid(format!(
                "Foreign Key {} needs the same number of columns on both sides.",
                k.name
            )));
        }
    }

    // Indexes.
    let mut dropped_indexes = Vec::new();
    let mut renamed_indexes = Vec::new();
    for i in &base.indexes {
        match draft
            .index_origins
            .iter()
            .position(|o| o.as_deref() == Some(i.name.as_str()))
        {
            None => {
                dropped_indexes.push(i.clone());
                let rule = if i.primary {
                    Some(Rule::PrimaryKey)
                } else if i.unique {
                    Some(Rule::Unique)
                } else {
                    None
                };
                if let Some(rule) = rule {
                    warnings.push(DesignWarning::DropRule {
                        rule,
                        name: i.name.clone(),
                    });
                }
            }
            Some(at) if draft.indexes[at].name != i.name => {
                renamed_indexes.push((i.clone(), draft.indexes[at].name.clone()));
            }
            Some(_) => {}
        }
    }
    let mut added_indexes: Vec<IndexDraft> = draft
        .indexes
        .iter()
        .zip(&draft.index_origins)
        .filter(|(_, o)| o.is_none())
        .map(|(i, _)| i.clone())
        .collect();
    added_indexes.sort_by_key(|i| !i.primary);
    if draft.indexes.iter().filter(|i| i.primary).count() > 1 {
        return Err(invalid("A table has one primary key."));
    }
    for i in &dropped_indexes {
        let fixed = i.advanced || i.expression || i.predicate.is_some();
        let again = added_indexes
            .iter()
            .any(|a| a.name == i.name || (a.primary && i.primary));
        if fixed && again {
            return Err(cannot_recreate(base, "index", &i.name));
        }
    }
    for i in &added_indexes {
        if !i.primary && i.name.trim().is_empty() {
            return Err(invalid("Every index needs a name."));
        }
        if i.columns.is_empty() {
            return Err(invalid(format!(
                "Index {} needs at least one column.",
                i.name
            )));
        }
    }

    // Columns.
    let mut dropped_columns = Vec::new();
    for c in &base.columns {
        if !draft.column_origins.contains(&Some(c.name.clone())) {
            dropped_columns.push(c.clone());
            warnings.push(DesignWarning::DropColumn {
                column: c.name.clone(),
            });
        }
    }
    let kept: Vec<(usize, bool)> = draft
        .column_origins
        .iter()
        .flatten()
        .map(|o| {
            let at = base.columns.iter().position(|c| c.name == *o).unwrap_or(0);
            (at, draft.moved.contains(o))
        })
        .collect();
    let stays = stationary(&kept);
    let last_kept = draft.column_origins.iter().rposition(Option::is_some);

    let mut changes = Vec::new();
    let mut added_columns = Vec::new();
    let mut kept_at = 0;
    let mut placed_before: Option<String> = None;
    for (at, (column, origin)) in draft.columns.iter().zip(&draft.column_origins).enumerate() {
        let Some(origin) = origin else {
            let placement = if at + 1 == draft.columns.len() {
                None
            } else if at == 0 {
                Some(Placement::First)
            } else {
                Some(Placement::After(draft.columns[at - 1].name.clone()))
            };
            let column = checked_column(column)?;
            if !column.nullable && column.default_sql.is_none() && !column.increment {
                warnings.push(DesignWarning::ExistingRows {
                    rule: Rule::NotNull,
                    name: column.name.clone(),
                });
            }
            added_columns.push(NewColumn {
                column,
                placement,
                at_end: last_kept.is_none_or(|k| at > k),
            });
            continue;
        };
        let loaded = base
            .columns
            .iter()
            .find(|c| c.name == *origin)
            .expect("a kept column is loaded");
        let placement = (!stays[kept_at]).then(|| match &placed_before {
            None => Placement::First,
            Some(c) => Placement::After(c.clone()),
        });
        kept_at += 1;
        placed_before = Some(column.name.clone());

        let was = column_draft(loaded);
        let renamed = column.name != loaded.name;
        let same_text = column.type_sql.trim() == loaded.type_sql.trim();
        let type_change = if same_text {
            TypeChange::Same
        } else {
            type_change(kind, &loaded.type_sql, &column.type_sql)
        };
        let nullable = column.nullable != was.nullable;
        let default = blank_is_none(&column.default_sql) != blank_is_none(&was.default_sql);
        let increment = column.increment != was.increment;
        let comment = blank_is_none(&column.comment) != blank_is_none(&was.comment);
        let change = ColumnChange {
            base: loaded.clone(),
            column: column.clone(),
            renamed,
            type_change,
            nullable,
            default,
            increment,
            comment,
            placement,
        };
        if !renamed && !change.definition_changed() && !comment && change.placement.is_none() {
            continue;
        }
        if loaded.generated {
            let restated = kind == DialectKind::MySql
                && (comment || change.placement.is_some() || change.definition_changed());
            if change.definition_changed() || restated {
                return Err(invalid(format!(
                    "Contura cannot change the generated column {}. Rename or drop it here, or change it in SQL.",
                    loaded.name
                )));
            }
        }
        let restated = change.definition_changed() || comment || change.placement.is_some();
        if loaded.advanced && restated {
            return Err(cannot_restate(base, &loaded.name));
        }
        let column = ColumnDraft {
            comment: blank_is_none(&column.comment),
            ..checked_column(column)?
        };
        if renamed {
            warnings.push(DesignWarning::RenameColumn {
                from: loaded.name.clone(),
                to: column.name.clone(),
            });
        }
        let notes = narrowing_notes(kind, &column.name, loaded, &column.type_sql, type_change);
        if type_change == TypeChange::Narrowing || !notes.is_empty() {
            warnings.push(DesignWarning::NarrowType {
                column: column.name.clone(),
                from: loaded.type_sql.clone(),
                to: column.type_sql.clone(),
                note: (!notes.is_empty()).then(|| notes.join(" ")),
            });
        }
        if loaded.nullable && !column.nullable {
            warnings.push(DesignWarning::ExistingRows {
                rule: Rule::NotNull,
                name: column.name.clone(),
            });
        }
        changes.push(ColumnChange { column, ..change });
    }

    for i in &added_indexes {
        if i.primary || i.unique {
            warnings.push(DesignWarning::ExistingRows {
                rule: if i.primary {
                    Rule::PrimaryKey
                } else {
                    Rule::Unique
                },
                name: i.name.clone(),
            });
        }
    }
    for k in &added_keys {
        warnings.push(DesignWarning::ExistingRows {
            rule: Rule::ForeignKey,
            name: k.name.clone(),
        });
    }

    let comment = blank_is_none(&draft.comment);
    let comment = (comment != blank_is_none(&base.comment)).then_some(comment);

    Ok(Alter {
        path: base.path.clone(),
        table,
        dropped_keys,
        dropped_indexes,
        dropped_columns,
        changes,
        added_columns,
        renamed_indexes,
        added_indexes,
        added_keys,
        comment,
        warnings,
    })
}

fn plan_drop(kind: DialectKind, base: &TableDesign, edits: &[DesignEdit]) -> Result<DesignPlan> {
    if !edits.is_empty() {
        return Err(invalid("A table that is dropped takes no other changes."));
    }
    let mut referenced_by: Vec<String> = Vec::new();
    for r in &base.referenced_by {
        let own = r.table == base.path;
        if !own && !referenced_by.contains(&r.table.name) {
            referenced_by.push(r.table.name.clone());
        }
    }
    let mut warnings = vec![DesignWarning::DropTable {
        table: base.path.name.clone(),
        rows: None,
        referenced_by,
    }];
    // SQLite with Foreign Keys on deletes the rows first, which runs each child
    // key's ON DELETE action: name each one (I1).
    let sqlite_keys = base
        .sqlite
        .as_ref()
        .filter(|_| kind == DialectKind::Sqlite)
        .map(|e| e.foreign_keys_on);
    if sqlite_keys == Some(true) {
        for r in base.referenced_by.iter().filter(|r| r.table != base.path) {
            let w = DesignWarning::ChildRows {
                table: base.path.name.clone(),
                child: r.table.name.clone(),
                action: ChildAction::from_rule(r.on_delete.as_deref()),
            };
            if !warnings.contains(&w) {
                warnings.push(w);
            }
        }
    }
    Ok(DesignPlan {
        statements: vec![format!("DROP TABLE {}", sql_table(kind, &base.path)?)],
        warnings,
        mode: single_mode(kind),
        before: 0,
        after: 0,
        checks: vec![],
        // The warnings hold only with the Foreign Key enforcement they were made for (S9).
        foreign_keys: sqlite_keys,
        loaded: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::design::model::IncomingRef;
    use crate::design::warning::DesignWarning;

    fn path(database: &str, schema: Option<&str>, name: &str) -> ObjectPath {
        ObjectPath {
            database: database.into(),
            schema: schema.map(Into::into),
            name: name.into(),
        }
    }

    /// The path of `name` in the usual test scope of each Dialect.
    fn at(kind: DialectKind, name: &str) -> ObjectPath {
        match kind {
            DialectKind::MySql => path("shop", None, name),
            DialectKind::Postgres => path("shop", Some("public"), name),
            DialectKind::Sqlite => path("main", None, name),
        }
    }

    fn column(name: &str, type_sql: &str) -> ColumnDraft {
        ColumnDraft {
            name: name.into(),
            type_sql: type_sql.into(),
            nullable: true,
            default_sql: None,
            increment: false,
            comment: None,
        }
    }

    fn add(column: ColumnDraft) -> DesignEdit {
        DesignEdit::AddColumn {
            column,
            position: Position::Last,
        }
    }

    fn index(name: &str, columns: &[&str], primary: bool) -> DesignEdit {
        DesignEdit::AddIndex {
            index: IndexDraft {
                name: name.into(),
                columns: columns.iter().map(|c| c.to_string()).collect(),
                unique: primary,
                primary,
            },
        }
    }

    /// `t (id <id_type> increment not null, name text comment 'x')`, key `t_pkey`,
    /// index `t_name_idx`, Foreign Key `t_owner_fkey` to `users`.
    fn new_table(kind: DialectKind, id_type: &str) -> DesignRequest {
        DesignRequest {
            target: DesignTarget::Create {
                path: at(kind, "t"),
            },
            edits: vec![
                add(ColumnDraft {
                    nullable: false,
                    increment: true,
                    ..column("id", id_type)
                }),
                add(ColumnDraft {
                    comment: Some("x".into()),
                    ..column("name", "text")
                }),
                index("t_pkey", &["id"], true),
                index("t_name_idx", &["name"], false),
                DesignEdit::AddForeignKey {
                    key: ForeignKeyDraft {
                        name: "t_owner_fkey".into(),
                        columns: vec!["owner".into()],
                        target: at(kind, "users"),
                        target_columns: vec!["id".into()],
                        on_delete: Some("CASCADE".into()),
                        on_update: None,
                    },
                },
            ],
        }
    }

    fn create(kind: DialectKind, edits: Vec<DesignEdit>) -> Result<DesignPlan> {
        plan_design(
            kind,
            &DesignRequest {
                target: DesignTarget::Create {
                    path: at(kind, "t"),
                },
                edits,
            },
        )
    }

    fn invalid(r: Result<DesignPlan>) -> String {
        match r {
            Err(Error::InvalidInput(m)) => m,
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[test]
    fn create_postgres() {
        let plan = plan_design(
            DialectKind::Postgres,
            &new_table(DialectKind::Postgres, "bigint"),
        )
        .unwrap();
        assert_eq!(
            plan.statements,
            vec![
                "CREATE TABLE \"public\".\"t\" (\n  \"id\" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,\n  \"name\" text,\n  CONSTRAINT \"t_pkey\" PRIMARY KEY (\"id\"),\n  CONSTRAINT \"t_owner_fkey\" FOREIGN KEY (\"owner\") REFERENCES \"public\".\"users\" (\"id\") ON DELETE CASCADE\n)",
                "CREATE INDEX \"t_name_idx\" ON \"public\".\"t\" (\"name\")",
                "COMMENT ON COLUMN \"public\".\"t\".\"name\" IS 'x'",
            ]
        );
        assert_eq!(plan.mode, DesignMode::Transaction);
        assert_eq!((plan.before, plan.after), (0, 0));
        assert!(plan.warnings.is_empty());
    }

    #[test]
    fn create_postgres_table_comment_and_unique_index() {
        let mut req = new_table(DialectKind::Postgres, "bigint");
        req.edits.push(DesignEdit::TableComment {
            comment: Some("it's".into()),
        });
        req.edits.push(DesignEdit::AddIndex {
            index: IndexDraft {
                name: "t_id_name".into(),
                columns: vec!["id".into(), "name".into()],
                unique: true,
                primary: false,
            },
        });
        let plan = plan_design(DialectKind::Postgres, &req).unwrap();
        assert_eq!(
            plan.statements[1..],
            [
                "CREATE INDEX \"t_name_idx\" ON \"public\".\"t\" (\"name\")",
                "CREATE UNIQUE INDEX \"t_id_name\" ON \"public\".\"t\" (\"id\", \"name\")",
                "COMMENT ON TABLE \"public\".\"t\" IS 'it''s'",
                "COMMENT ON COLUMN \"public\".\"t\".\"name\" IS 'x'",
            ]
        );
    }

    #[test]
    fn postgres_comment_with_a_backslash_is_an_e_string() {
        let mut req = new_table(DialectKind::Postgres, "bigint");
        req.edits.push(DesignEdit::TableComment {
            comment: Some(r"\' ; DROP TABLE x; --".into()),
        });
        let plan = plan_design(DialectKind::Postgres, &req).unwrap();
        assert_eq!(
            plan.statements[2],
            r#"COMMENT ON TABLE "public"."t" IS E'\\'' ; DROP TABLE x; --'"#
        );
    }

    #[test]
    fn create_mysql_is_one_statement() {
        let mut req = new_table(DialectKind::MySql, "bigint");
        req.edits.push(DesignEdit::TableComment {
            comment: Some("t note".into()),
        });
        let plan = plan_design(DialectKind::MySql, &req).unwrap();
        assert_eq!(
            plan.statements,
            vec![
                "CREATE TABLE `shop`.`t` (\n  `id` bigint AUTO_INCREMENT NOT NULL,\n  `name` text COMMENT 'x',\n  PRIMARY KEY (`id`),\n  KEY `t_name_idx` (`name`),\n  CONSTRAINT `t_owner_fkey` FOREIGN KEY (`owner`) REFERENCES `shop`.`users` (`id`) ON DELETE CASCADE\n) COMMENT='t note'"
            ]
        );
        assert!(plan.statements[0].contains("KEY `t_name_idx` (`name`)"));
        assert!(plan.statements[0].contains("`name` text COMMENT 'x'"));
        assert!(plan.statements[0].ends_with(") COMMENT='t note'"));
        assert_eq!(plan.mode, DesignMode::Atomic);
        assert!(plan.warnings.is_empty());
    }

    #[test]
    fn create_mysql_comment_doubles_backslashes() {
        let mut req = new_table(DialectKind::MySql, "bigint");
        req.edits.push(DesignEdit::TableComment {
            comment: Some("a\\b 'c'".into()),
        });
        let plan = plan_design(DialectKind::MySql, &req).unwrap();
        assert!(
            plan.statements[0].ends_with(") COMMENT='a\\\\b ''c'''"),
            "{}",
            plan.statements[0]
        );
    }

    #[test]
    fn create_sqlite() {
        let mut req = new_table(DialectKind::Sqlite, "integer");
        req.edits.push(DesignEdit::TableComment {
            comment: Some("t note".into()),
        });
        let plan = plan_design(DialectKind::Sqlite, &req).unwrap();
        assert_eq!(
            plan.statements,
            vec![
                "CREATE TABLE \"main\".\"t\" (\n  \"id\" integer PRIMARY KEY,\n  \"name\" text,\n  FOREIGN KEY (\"owner\") REFERENCES \"users\" (\"id\") ON DELETE CASCADE\n)",
                "CREATE INDEX \"main\".\"t_name_idx\" ON \"t\" (\"name\")",
            ]
        );
        assert!(
            plan.statements
                .iter()
                .all(|s| !s.contains("COMMENT") && !s.contains("note") && !s.contains("'x'"))
        );
        assert_eq!(plan.mode, DesignMode::Transaction);
        assert!(plan.warnings.is_empty());
    }

    #[test]
    fn create_sqlite_key_without_increment_is_a_table_constraint() {
        let plan = create(
            DialectKind::Sqlite,
            vec![
                add(ColumnDraft {
                    nullable: false,
                    ..column("a", "integer")
                }),
                add(ColumnDraft {
                    nullable: false,
                    ..column("b", "text")
                }),
                index("primary", &["a", "b"], true),
            ],
        )
        .unwrap();
        assert_eq!(
            plan.statements,
            vec![
                "CREATE TABLE \"main\".\"t\" (\n  \"a\" integer NOT NULL,\n  \"b\" text NOT NULL,\n  PRIMARY KEY (\"a\", \"b\")\n)"
            ]
        );
    }

    #[test]
    fn sqlite_increment_needs_the_single_integer_key() {
        let not_key = invalid(create(
            DialectKind::Sqlite,
            vec![add(ColumnDraft {
                increment: true,
                ..column("id", "integer")
            })],
        ));
        assert!(not_key.contains("single INTEGER primary key"), "{not_key}");
        let not_integer = invalid(create(
            DialectKind::Sqlite,
            vec![
                add(ColumnDraft {
                    increment: true,
                    ..column("id", "bigint")
                }),
                index("primary", &["id"], true),
            ],
        ));
        assert!(not_integer.contains("single INTEGER primary key"));
        let second = invalid(create(
            DialectKind::Sqlite,
            vec![
                add(ColumnDraft {
                    increment: true,
                    ..column("id", "integer")
                }),
                add(ColumnDraft {
                    increment: true,
                    ..column("n", "integer")
                }),
                index("primary", &["id"], true),
            ],
        ));
        assert!(second.contains("single INTEGER primary key"), "{second}");
    }

    #[test]
    fn create_defaults_and_column_order() {
        let plan = create(
            DialectKind::Postgres,
            vec![
                add(ColumnDraft {
                    default_sql: Some("'new'".into()),
                    nullable: false,
                    ..column("status", "varchar(16)")
                }),
                add(column("total", "numeric(10,2)")),
                DesignEdit::AddColumn {
                    column: column("id", "bigint"),
                    position: Position::First,
                },
                DesignEdit::AddColumn {
                    column: column("note", "text"),
                    position: Position::After {
                        column: "id".into(),
                    },
                },
                DesignEdit::MoveColumn {
                    name: "total".into(),
                    position: Position::After {
                        column: "note".into(),
                    },
                },
                DesignEdit::ChangeColumn {
                    name: "note".into(),
                    column: column("memo", "text"),
                },
                add(column("gone", "int")),
                DesignEdit::DropColumn {
                    name: "gone".into(),
                },
                DesignEdit::AddColumn {
                    column: ColumnDraft {
                        default_sql: Some("  ".into()),
                        ..column("blank", "int")
                    },
                    position: Position::Last,
                },
            ],
        )
        .unwrap();
        assert_eq!(
            plan.statements,
            vec![
                "CREATE TABLE \"public\".\"t\" (\n  \"id\" bigint,\n  \"memo\" text,\n  \"total\" numeric(10,2),\n  \"status\" varchar(16) NOT NULL DEFAULT 'new',\n  \"blank\" int\n)"
            ]
        );
    }

    #[test]
    fn index_and_key_edits_apply_in_order() {
        let mut req = new_table(DialectKind::Postgres, "bigint");
        req.edits.extend([
            DesignEdit::RenameIndex {
                name: "t_name_idx".into(),
                to: "t_name_ix".into(),
            },
            DesignEdit::DropForeignKey {
                name: "t_owner_fkey".into(),
            },
            DesignEdit::DropIndex {
                name: "t_pkey".into(),
            },
            DesignEdit::TableComment {
                comment: Some("x".into()),
            },
            DesignEdit::TableComment { comment: None },
        ]);
        let plan = plan_design(DialectKind::Postgres, &req).unwrap();
        assert_eq!(
            plan.statements,
            vec![
                "CREATE TABLE \"public\".\"t\" (\n  \"id\" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,\n  \"name\" text\n)",
                "CREATE INDEX \"t_name_ix\" ON \"public\".\"t\" (\"name\")",
                "COMMENT ON COLUMN \"public\".\"t\".\"name\" IS 'x'",
            ]
        );
    }

    fn orders(kind: DialectKind) -> TableDesign {
        TableDesign {
            path: at(kind, "orders"),
            columns: vec![],
            indexes: vec![],
            foreign_keys: vec![],
            referenced_by: vec![
                IncomingRef {
                    name: "items_order_id_fkey".into(),
                    table: at(kind, "items"),
                    on_delete: None,
                },
                IncomingRef {
                    name: "orders_parent_fkey".into(),
                    table: at(kind, "orders"),
                    on_delete: None,
                },
                IncomingRef {
                    name: "items_first_order_fkey".into(),
                    table: at(kind, "items"),
                    on_delete: None,
                },
            ],
            comment: None,
            unsupported: vec![],
            sqlite: None,
        }
    }

    fn drop(kind: DialectKind) -> DesignPlan {
        plan_design(
            kind,
            &DesignRequest {
                target: DesignTarget::Drop { base: orders(kind) },
                edits: vec![],
            },
        )
        .unwrap()
    }

    #[test]
    fn drop_table_per_dialect() {
        let warning = vec![DesignWarning::DropTable {
            table: "orders".into(),
            rows: None,
            referenced_by: vec!["items".into()],
        }];
        let pg = drop(DialectKind::Postgres);
        assert_eq!(pg.statements, vec!["DROP TABLE \"public\".\"orders\""]);
        assert_eq!(pg.warnings, warning);
        assert_eq!(pg.mode, DesignMode::Transaction);
        let my = drop(DialectKind::MySql);
        assert_eq!(my.statements, vec!["DROP TABLE `shop`.`orders`"]);
        assert_eq!(my.warnings, warning);
        assert_eq!(my.mode, DesignMode::Atomic);
        let lite = drop(DialectKind::Sqlite);
        assert_eq!(lite.statements, vec!["DROP TABLE \"main\".\"orders\""]);
        assert_eq!(lite.warnings, warning);
    }

    #[test]
    fn sqlite_drop_names_what_happens_to_each_child() {
        use crate::design::model::SqliteExtras;
        use crate::design::warning::ChildAction;
        let lite = DialectKind::Sqlite;
        let incoming = |table: &str, on_delete: Option<&str>| IncomingRef {
            name: "fk_0".into(),
            table: at(lite, table),
            on_delete: on_delete.map(Into::into),
        };
        let mut base = orders(lite);
        base.referenced_by = vec![
            incoming("items", Some("CASCADE")),
            incoming("notes", Some("SET NULL")),
            incoming("audit", None),
            incoming("orders", Some("CASCADE")),
        ];
        base.sqlite = Some(SqliteExtras {
            create_sql: "CREATE TABLE orders (id integer primary key)".into(),
            triggers: vec![],
            views: vec![],
            foreign_keys_on: true,
            view_triggers: vec![],
            children: vec![],
        });
        let plan_for = |base: &TableDesign| {
            plan_design(
                lite,
                &DesignRequest {
                    target: DesignTarget::Drop { base: base.clone() },
                    edits: vec![],
                },
            )
            .unwrap()
        };
        let child = |child: &str, action| DesignWarning::ChildRows {
            table: "orders".into(),
            child: child.into(),
            action,
        };
        let plan = plan_for(&base);
        assert_eq!(
            plan.warnings[1..],
            [
                child("items", ChildAction::Delete),
                child("notes", ChildAction::Clear),
                child("audit", ChildAction::Fail),
            ]
        );
        assert_eq!(plan.foreign_keys, Some(true));
        assert!(plan.loaded.is_some());

        // With Foreign Keys off, the drop leaves child rows as they are.
        base.sqlite.as_mut().unwrap().foreign_keys_on = false;
        let plan = plan_for(&base);
        assert_eq!(plan.warnings.len(), 1);
        assert_eq!(plan.foreign_keys, Some(false));
    }

    #[test]
    fn same_name_in_another_database_is_not_a_self_reference() {
        let mut base = orders(DialectKind::MySql);
        base.referenced_by = vec![IncomingRef {
            name: "archive_fk".into(),
            table: path("archive", None, "orders"),
            on_delete: None,
        }];
        let plan = plan_design(
            DialectKind::MySql,
            &DesignRequest {
                target: DesignTarget::Drop { base },
                edits: vec![],
            },
        )
        .unwrap();
        assert_eq!(
            plan.warnings,
            vec![DesignWarning::DropTable {
                table: "orders".into(),
                rows: None,
                referenced_by: vec!["orders".into()],
            }]
        );
    }

    #[test]
    fn drop_takes_no_edits() {
        let req = DesignRequest {
            target: DesignTarget::Drop {
                base: orders(DialectKind::MySql),
            },
            edits: vec![DesignEdit::TableComment { comment: None }],
        };
        invalid(plan_design(DialectKind::MySql, &req));
    }

    #[test]
    fn new_table_needs_a_name_and_a_column() {
        const ASK: &str = "Add a name and at least one column.";
        assert_eq!(invalid(create(DialectKind::MySql, vec![])), ASK);
        let unnamed = DesignRequest {
            target: DesignTarget::Create {
                path: at(DialectKind::Postgres, " "),
            },
            edits: vec![add(column("id", "int"))],
        };
        assert_eq!(invalid(plan_design(DialectKind::Postgres, &unnamed)), ASK);
        let dropped_last = vec![
            add(column("id", "int")),
            DesignEdit::DropColumn { name: "id".into() },
        ];
        assert_eq!(invalid(create(DialectKind::Sqlite, dropped_last)), ASK);
    }

    #[test]
    fn refuses_a_type_or_default_that_is_not_one_expression() {
        for kind in [
            DialectKind::MySql,
            DialectKind::Postgres,
            DialectKind::Sqlite,
        ] {
            let bad_type = vec![add(column("total", "int; drop table x"))];
            assert_eq!(
                invalid(create(kind, bad_type)),
                "The type of total is not one SQL expression."
            );
            let empty_type = vec![add(column("total", " "))];
            assert_eq!(
                invalid(create(kind, empty_type)),
                "The type of total is not one SQL expression."
            );
            let bad_default = vec![add(ColumnDraft {
                default_sql: Some("0 -- x".into()),
                ..column("total", "int")
            })];
            assert_eq!(
                invalid(create(kind, bad_default)),
                "The default of total is not one SQL expression."
            );
        }
    }

    #[test]
    fn refuses_unknown_names_and_actions() {
        invalid(create(
            DialectKind::MySql,
            vec![
                add(column("id", "int")),
                DesignEdit::DropColumn {
                    name: "nope".into(),
                },
            ],
        ));
        invalid(create(
            DialectKind::MySql,
            vec![
                add(column("id", "int")),
                DesignEdit::AddColumn {
                    column: column("b", "int"),
                    position: Position::After {
                        column: "nope".into(),
                    },
                },
            ],
        ));
        invalid(create(
            DialectKind::MySql,
            vec![add(column("id", "int")), add(column("id", "int"))],
        ));
        let mut req = new_table(DialectKind::Postgres, "bigint");
        if let DesignEdit::AddForeignKey { key } = &mut req.edits[4] {
            key.on_delete = Some("CASCADE; DROP TABLE x".into());
        }
        invalid(plan_design(DialectKind::Postgres, &req));
        let mut two_keys = new_table(DialectKind::Postgres, "bigint");
        two_keys.edits.push(index("t_pkey2", &["name"], true));
        invalid(plan_design(DialectKind::Postgres, &two_keys));
    }

    #[test]
    fn actions_are_written_upper_case() {
        let mut req = new_table(DialectKind::Postgres, "bigint");
        if let DesignEdit::AddForeignKey { key } = &mut req.edits[4] {
            key.on_delete = Some("set null".into());
            key.on_update = Some(" no  action ".into());
        }
        let plan = plan_design(DialectKind::Postgres, &req).unwrap();
        assert!(
            plan.statements[0].contains("ON DELETE SET NULL ON UPDATE NO ACTION\n)"),
            "{}",
            plan.statements[0]
        );
    }

    #[test]
    fn quotes_names_per_dialect() {
        let names = ["it's", "a\"b", "a`b", "naïve 表"];
        let edits = || {
            let mut e: Vec<DesignEdit> = names.iter().map(|n| add(column(n, "int"))).collect();
            e.push(index("naïve 表", &["a`b", "a\"b"], false));
            e
        };
        let req = |kind| DesignRequest {
            target: DesignTarget::Create {
                path: at(kind, "it's"),
            },
            edits: edits(),
        };
        let my = plan_design(DialectKind::MySql, &req(DialectKind::MySql)).unwrap();
        assert_eq!(
            my.statements,
            vec![
                "CREATE TABLE `shop`.`it's` (\n  `it's` int,\n  `a\"b` int,\n  `a``b` int,\n  `naïve 表` int,\n  KEY `naïve 表` (`a``b`, `a\"b`)\n)"
            ]
        );
        for kind in [DialectKind::Postgres, DialectKind::Sqlite] {
            let plan = plan_design(kind, &req(kind)).unwrap();
            let scope = if kind == DialectKind::Postgres {
                "public"
            } else {
                "main"
            };
            assert_eq!(
                plan.statements[0],
                format!(
                    "CREATE TABLE \"{scope}\".\"it's\" (\n  \"it's\" int,\n  \"a\"\"b\" int,\n  \"a`b\" int,\n  \"naïve 表\" int\n)"
                )
            );
            assert!(
                plan.statements[1].contains("\"naïve 表\" ON ")
                    && plan.statements[1].ends_with("\"it's\" (\"a`b\", \"a\"\"b\")"),
                "{}",
                plan.statements[1]
            );
        }
    }

    #[test]
    fn same_request_same_text() {
        for kind in [
            DialectKind::MySql,
            DialectKind::Postgres,
            DialectKind::Sqlite,
        ] {
            let req = new_table(kind, "integer");
            assert_eq!(
                plan_design(kind, &req).unwrap(),
                plan_design(kind, &req).unwrap()
            );
            let drop_req = DesignRequest {
                target: DesignTarget::Drop { base: orders(kind) },
                edits: vec![],
            };
            assert_eq!(
                plan_design(kind, &drop_req).unwrap(),
                plan_design(kind, &drop_req).unwrap()
            );
        }
    }

    #[test]
    fn request_shape() {
        let edit = DesignEdit::AddColumn {
            column: column("id", "int"),
            position: Position::After { column: "x".into() },
        };
        assert_eq!(
            serde_json::to_value(&edit).unwrap(),
            serde_json::json!({"op":"addColumn","column":{"name":"id","typeSql":"int",
                "nullable":true,"defaultSql":null,"increment":false,"comment":null},
                "position":{"kind":"after","column":"x"}})
        );
        let req: DesignRequest = serde_json::from_value(serde_json::json!({
            "target": {"kind":"create","path":{"database":"main","schema":null,"name":"t"}},
            "edits": [{"op":"tableComment","comment":"x"},{"op":"dropIndex","name":"i"}]
        }))
        .unwrap();
        assert_eq!(req.edits.len(), 2);
        assert_eq!(
            serde_json::to_value(DesignMode::CopyOnly {
                reason: "it is STRICT".into()
            })
            .unwrap(),
            serde_json::json!({"kind":"copyOnly","reason":"it is STRICT"})
        );
    }
}

/// Loaded tables and edits the planner tests share.
#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    pub(crate) fn path(database: &str, schema: Option<&str>, name: &str) -> ObjectPath {
        ObjectPath {
            database: database.into(),
            schema: schema.map(Into::into),
            name: name.into(),
        }
    }

    /// The path of `name` in the usual test scope of each Dialect.
    pub(crate) fn at(kind: DialectKind, name: &str) -> ObjectPath {
        match kind {
            DialectKind::MySql => path("shop", None, name),
            DialectKind::Postgres => path("shop", Some("public"), name),
            DialectKind::Sqlite => path("main", None, name),
        }
    }

    pub(crate) fn col(name: &str, type_sql: &str) -> TableColumn {
        TableColumn {
            name: name.into(),
            type_sql: type_sql.into(),
            nullable: true,
            ..TableColumn::default()
        }
    }

    pub(crate) fn idx(name: &str, columns: &[&str], unique: bool, primary: bool) -> TableIndex {
        TableIndex {
            name: name.into(),
            columns: columns.iter().map(|c| c.to_string()).collect(),
            unique,
            primary,
            constraint: false,
            sql: None,
            method: Some("btree".into()),
            predicate: None,
            expression: false,
            advanced: false,
        }
    }

    pub(crate) fn key(kind: DialectKind, name: &str, column: &str) -> TableForeignKey {
        TableForeignKey {
            name: name.into(),
            columns: vec![column.into()],
            target: at(kind, "customers"),
            target_columns: vec!["id".into()],
            on_delete: None,
            on_update: None,
            advanced: false,
        }
    }

    pub(crate) fn key_draft(kind: DialectKind, name: &str, column: &str) -> ForeignKeyDraft {
        ForeignKeyDraft {
            name: name.into(),
            columns: vec![column.into()],
            target: at(kind, "customers"),
            target_columns: vec!["id".into()],
            on_delete: Some("CASCADE".into()),
            on_update: None,
        }
    }

    /// `orders (id <int> increment primary key, email varchar(80) unique,
    /// status varchar(16) not null default 'new', total decimal(10,2),
    /// created_at timestamp default current_timestamp)`, as each server reads it.
    pub(crate) fn orders(kind: DialectKind) -> TableDesign {
        let pg = kind == DialectKind::Postgres;
        let (int, varchar, decimal) = if pg {
            ("integer", "character varying", "numeric")
        } else {
            ("int", "varchar", "decimal")
        };
        let mut primary = idx(
            if pg { "orders_pkey" } else { "PRIMARY" },
            &["id"],
            true,
            true,
        );
        let mut email = idx(
            if pg { "orders_email_key" } else { "email" },
            &["email"],
            true,
            false,
        );
        primary.constraint = pg;
        email.constraint = pg;
        TableDesign {
            path: at(kind, "orders"),
            columns: vec![
                TableColumn {
                    nullable: false,
                    increment: if pg {
                        Increment::Identity
                    } else {
                        Increment::AutoIncrement
                    },
                    ..col("id", int)
                },
                col("email", &format!("{varchar}(80)")),
                TableColumn {
                    nullable: false,
                    default_sql: Some("'new'".into()),
                    ..col("status", &format!("{varchar}(16)"))
                },
                col("total", &format!("{decimal}(10,2)")),
                TableColumn {
                    default_sql: Some("CURRENT_TIMESTAMP".into()),
                    ..col("created_at", "timestamp")
                },
            ],
            indexes: vec![primary, email],
            foreign_keys: vec![],
            referenced_by: vec![],
            comment: None,
            unsupported: vec![],
            sqlite: None,
        }
    }

    /// The loaded column `name` of `base` as the designer would send it unchanged.
    pub(crate) fn same(base: &TableDesign, name: &str) -> ColumnDraft {
        column_draft(base.columns.iter().find(|c| c.name == name).unwrap())
    }

    /// `ChangeColumn` of `name` with `edit` applied to it as loaded.
    pub(crate) fn change(
        base: &TableDesign,
        name: &str,
        edit: impl FnOnce(&mut ColumnDraft),
    ) -> DesignEdit {
        let mut column = same(base, name);
        edit(&mut column);
        DesignEdit::ChangeColumn {
            name: name.into(),
            column,
        }
    }

    pub(crate) fn new_column(name: &str, type_sql: &str) -> ColumnDraft {
        ColumnDraft {
            name: name.into(),
            type_sql: type_sql.into(),
            nullable: true,
            default_sql: None,
            increment: false,
            comment: None,
        }
    }

    pub(crate) fn add_index(
        name: &str,
        columns: &[&str],
        unique: bool,
        primary: bool,
    ) -> DesignEdit {
        DesignEdit::AddIndex {
            index: IndexDraft {
                name: name.into(),
                columns: columns.iter().map(|c| c.to_string()).collect(),
                unique,
                primary,
            },
        }
    }

    pub(crate) fn alter(
        kind: DialectKind,
        base: &TableDesign,
        edits: Vec<DesignEdit>,
    ) -> Result<DesignPlan> {
        plan_design(
            kind,
            &DesignRequest {
                target: DesignTarget::Alter { base: base.clone() },
                edits,
            },
        )
    }

    pub(crate) fn refusal(r: Result<DesignPlan>) -> String {
        match r {
            Err(Error::InvalidInput(m)) => m,
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }
}

#[cfg(test)]
mod alter_tests {
    use super::fixtures::*;
    use super::*;

    const BOTH: [DialectKind; 2] = [DialectKind::MySql, DialectKind::Postgres];

    #[test]
    fn widening_gives_no_warning() {
        for kind in BOTH {
            let base = orders(kind);
            let plan = alter(
                kind,
                &base,
                vec![change(&base, "email", |c| {
                    c.type_sql = "varchar(100)".into()
                })],
            )
            .unwrap();
            assert_eq!(plan.statements.len(), 1, "{kind:?}");
            assert!(plan.warnings.is_empty(), "{kind:?} {:?}", plan.warnings);
        }
    }

    #[test]
    fn rename_gives_only_rename_column() {
        for kind in BOTH {
            let base = orders(kind);
            let plan = alter(
                kind,
                &base,
                vec![change(&base, "total", |c| c.name = "amount".into())],
            )
            .unwrap();
            assert_eq!(
                plan.warnings,
                vec![DesignWarning::RenameColumn {
                    from: "total".into(),
                    to: "amount".into()
                }],
                "{kind:?}"
            );
        }
    }

    #[test]
    fn drop_plus_add_of_one_name_is_a_drop_column() {
        for kind in BOTH {
            let base = orders(kind);
            let plan = alter(
                kind,
                &base,
                vec![
                    DesignEdit::DropColumn {
                        name: "total".into(),
                    },
                    DesignEdit::AddColumn {
                        column: new_column("total", "int"),
                        position: Position::Last,
                    },
                ],
            )
            .unwrap();
            assert_eq!(
                plan.warnings,
                vec![DesignWarning::DropColumn {
                    column: "total".into()
                }],
                "{kind:?}"
            );
            let text = plan.statements.join("\n");
            let drop = text.find("DROP COLUMN").unwrap();
            let add = text.find("ADD COLUMN").unwrap();
            assert!(drop < add, "{text}");
        }
    }

    #[test]
    fn no_change_is_an_empty_plan() {
        for kind in BOTH {
            let base = orders(kind);
            let plan = alter(
                kind,
                &base,
                vec![change(&base, "total", |c| c.comment = Some(" ".into()))],
            )
            .unwrap();
            assert!(plan.statements.is_empty(), "{kind:?} {:?}", plan.statements);
            assert!(plan.warnings.is_empty());
        }
    }

    #[test]
    fn rules_warn_for_their_case() {
        for kind in BOTH {
            let base = orders(kind);
            let email = base.indexes[1].name.clone();
            let plan = alter(
                kind,
                &base,
                vec![
                    DesignEdit::DropIndex {
                        name: email.clone(),
                    },
                    change(&base, "total", |c| c.nullable = false),
                    add_index("orders_status_uq", &["status"], true, false),
                    add_index("orders_total_ix", &["total"], false, false),
                    DesignEdit::AddColumn {
                        column: new_column("customer_id", "int"),
                        position: Position::Last,
                    },
                    DesignEdit::AddForeignKey {
                        key: key_draft(kind, "orders_customer_fk", "customer_id"),
                    },
                ],
            )
            .unwrap();
            assert_eq!(
                plan.warnings,
                vec![
                    DesignWarning::DropRule {
                        rule: Rule::Unique,
                        name: email
                    },
                    DesignWarning::ExistingRows {
                        rule: Rule::NotNull,
                        name: "total".into()
                    },
                    DesignWarning::ExistingRows {
                        rule: Rule::Unique,
                        name: "orders_status_uq".into()
                    },
                    DesignWarning::ExistingRows {
                        rule: Rule::ForeignKey,
                        name: "orders_customer_fk".into()
                    },
                ],
                "{kind:?}"
            );
        }
    }

    /// Ruling S12: a removed loaded column takes every loaded index and key on it whole. The
    /// designer sends the drops; the plan names each primary key, UNIQUE and Foreign Key lost.
    #[test]
    fn a_removed_column_drops_its_rules_whole_and_names_them() {
        for kind in BOTH {
            let mut base = orders(kind);
            base.indexes.push(idx(
                "orders_email_status_ix",
                &["email", "status"],
                false,
                false,
            ));
            base.foreign_keys
                .push(key(kind, "orders_email_fk", "email"));
            let primary = base.indexes[0].name.clone();
            let unique = base.indexes[1].name.clone();
            let plan = alter(
                kind,
                &base,
                vec![
                    DesignEdit::DropForeignKey {
                        name: "orders_email_fk".into(),
                    },
                    DesignEdit::DropIndex {
                        name: unique.clone(),
                    },
                    DesignEdit::DropIndex {
                        name: "orders_email_status_ix".into(),
                    },
                    DesignEdit::DropColumn {
                        name: "email".into(),
                    },
                ],
            )
            .unwrap();
            for w in [
                DesignWarning::DropRule {
                    rule: Rule::ForeignKey,
                    name: "orders_email_fk".into(),
                },
                DesignWarning::DropRule {
                    rule: Rule::Unique,
                    name: unique.clone(),
                },
                DesignWarning::DropColumn {
                    column: "email".into(),
                },
            ] {
                assert!(
                    plan.warnings.contains(&w),
                    "{kind:?} {w:?} {:?}",
                    plan.warnings
                );
            }
            // A plain index gets no Core warning: the designer names it in its own note.
            assert!(
                !plan
                    .warnings
                    .iter()
                    .any(|w| matches!(w, DesignWarning::DropRule { name, .. } if name == "orders_email_status_ix")),
                "{kind:?}"
            );
            let plan = alter(
                kind,
                &base,
                vec![
                    DesignEdit::DropIndex {
                        name: primary.clone(),
                    },
                    DesignEdit::DropColumn { name: "id".into() },
                ],
            )
            .unwrap();
            assert!(
                plan.warnings.contains(&DesignWarning::DropRule {
                    rule: Rule::PrimaryKey,
                    name: primary
                }),
                "{kind:?} {:?}",
                plan.warnings
            );
        }
    }

    #[test]
    fn advanced_index_or_key_is_renamed_or_dropped_never_recreated() {
        for kind in BOTH {
            let mut base = orders(kind);
            base.indexes.push(TableIndex {
                advanced: true,
                ..idx("orders_ix", &["status"], false, false)
            });
            base.columns.push(col("customer_id", "int"));
            base.foreign_keys.push(TableForeignKey {
                advanced: true,
                ..key(kind, "fk_a", "customer_id")
            });
            base.unsupported = vec![
                "index orders_ix (include columns, descending order)".into(),
                "foreign key fk_a (deferrable)".into(),
            ];
            let drop_index = DesignEdit::DropIndex {
                name: "orders_ix".into(),
            };
            let refused = refusal(alter(
                kind,
                &base,
                vec![
                    drop_index.clone(),
                    add_index("orders_ix", &["total"], false, false),
                ],
            ));
            assert!(
                refused.contains("orders_ix (include columns, descending order)"),
                "{refused}"
            );
            let drop_key = DesignEdit::DropForeignKey {
                name: "fk_a".into(),
            };
            let refused = refusal(alter(
                kind,
                &base,
                vec![
                    drop_key.clone(),
                    DesignEdit::AddForeignKey {
                        key: key_draft(kind, "fk_a", "customer_id"),
                    },
                ],
            ));
            assert!(refused.contains("fk_a (deferrable)"), "{refused}");
            // Rename and drop stay allowed.
            alter(kind, &base, vec![drop_index, drop_key]).unwrap();
            alter(
                kind,
                &base,
                vec![DesignEdit::RenameIndex {
                    name: "orders_ix".into(),
                    to: "orders_status_ix".into(),
                }],
            )
            .unwrap();
        }
    }

    #[test]
    fn advanced_primary_key_is_not_rebuilt() {
        let kind = DialectKind::Postgres;
        let mut base = orders(kind);
        base.indexes[0].advanced = true;
        base.unsupported = vec!["index orders_pkey (include columns)".into()];
        let refused = refusal(alter(
            kind,
            &base,
            vec![
                DesignEdit::DropIndex {
                    name: "orders_pkey".into(),
                },
                add_index("orders_id_email_pkey", &["id", "email"], true, true),
            ],
        ));
        assert!(
            refused.contains("orders_pkey (include columns)"),
            "{refused}"
        );
        // A partial index is just as fixed.
        let mut base = orders(kind);
        base.indexes.push(TableIndex {
            predicate: Some("(total > 0)".into()),
            ..idx("orders_paid_ix", &["total"], false, false)
        });
        let refused = refusal(alter(
            kind,
            &base,
            vec![
                DesignEdit::DropIndex {
                    name: "orders_paid_ix".into(),
                },
                add_index("orders_paid_ix", &["total"], false, false),
            ],
        ));
        assert!(refused.contains("orders_paid_ix"), "{refused}");
    }

    #[test]
    fn names_already_taken_are_refused() {
        let kind = DialectKind::MySql;
        let mut base = orders(kind);
        base.columns.push(col("customer_id", "int"));
        base.foreign_keys.push(key(kind, "fk_a", "customer_id"));
        let taken = refusal(alter(
            kind,
            &base,
            vec![add_index("email", &["status"], false, false)],
        ));
        assert_eq!(taken, "There is already an index email.");
        let taken = refusal(alter(
            kind,
            &base,
            vec![
                add_index("ix", &["status"], false, false),
                DesignEdit::RenameIndex {
                    name: "ix".into(),
                    to: "email".into(),
                },
            ],
        ));
        assert_eq!(taken, "There is already an index email.");
        let taken = refusal(alter(
            kind,
            &base,
            vec![DesignEdit::AddForeignKey {
                key: key_draft(kind, "fk_a", "customer_id"),
            }],
        ));
        assert_eq!(taken, "There is already a Foreign Key fk_a.");
        // Dropping first frees the name.
        alter(
            kind,
            &base,
            vec![
                DesignEdit::DropIndex {
                    name: "email".into(),
                },
                add_index("email", &["email", "status"], true, false),
            ],
        )
        .unwrap();
    }

    #[test]
    fn a_column_rename_carries_into_indexes_and_keys() {
        let kind = DialectKind::Postgres;
        let mut base = orders(kind);
        base.columns.push(col("customer_id", "integer"));
        base.foreign_keys.push(key(kind, "fk_a", "customer_id"));
        let mut draft = Draft::from_base(&base);
        draft
            .apply(&[
                change(&base, "email", |c| c.name = "mail".into()),
                change(&base, "customer_id", |c| c.name = "buyer_id".into()),
            ])
            .unwrap();
        assert_eq!(draft.indexes[1].columns, ["mail"]);
        assert_eq!(draft.foreign_keys[0].columns, ["buyer_id"]);
        assert_eq!(draft.index_origins[1].as_deref(), Some("orders_email_key"));
    }

    #[test]
    fn generated_column_is_renamed_or_dropped_only() {
        for kind in BOTH {
            let mut base = orders(kind);
            base.columns.push(TableColumn {
                generated: true,
                ..col("total_x2", "int")
            });
            let refused = refusal(alter(
                kind,
                &base,
                vec![change(&base, "total_x2", |c| c.type_sql = "bigint".into())],
            ));
            assert!(refused.contains("generated column total_x2"), "{refused}");
            alter(
                kind,
                &base,
                vec![change(&base, "total_x2", |c| {
                    c.name = "double_total".into()
                })],
            )
            .unwrap();
        }
    }

    #[test]
    fn a_rounding_change_says_so() {
        for kind in BOTH {
            let base = orders(kind);
            let plan = alter(
                kind,
                &base,
                vec![change(&base, "total", |c| {
                    c.type_sql = "decimal(10,1)".into()
                })],
            )
            .unwrap();
            let DesignWarning::NarrowType { note, .. } = &plan.warnings[0] else {
                panic!("{:?}", plan.warnings);
            };
            assert_eq!(
                note.as_deref(),
                Some("Values in total are rounded to the new scale."),
                "{kind:?}"
            );
        }
    }

    #[test]
    fn a_new_not_null_column_without_a_default_warns() {
        for kind in BOTH {
            let base = orders(kind);
            let add = |column: ColumnDraft| DesignEdit::AddColumn {
                column,
                position: Position::Last,
            };
            let plan = alter(
                kind,
                &base,
                vec![
                    add(ColumnDraft {
                        nullable: false,
                        ..new_column("code", "int")
                    }),
                    add(ColumnDraft {
                        nullable: false,
                        default_sql: Some("0".into()),
                        ..new_column("count", "int")
                    }),
                    add(ColumnDraft {
                        nullable: false,
                        increment: true,
                        ..new_column("seq", "bigint")
                    }),
                ],
            )
            .unwrap();
            assert_eq!(
                plan.warnings,
                vec![DesignWarning::ExistingRows {
                    rule: Rule::NotNull,
                    name: "code".into()
                }],
                "{kind:?}"
            );
        }
    }

    #[test]
    fn a_rename_reaches_a_self_referencing_key_target() {
        let kind = DialectKind::Postgres;
        let mut base = orders(kind);
        base.columns.push(col("parent_id", "integer"));
        base.foreign_keys.push(TableForeignKey {
            target: at(kind, "orders"),
            ..key(kind, "orders_parent_fkey", "parent_id")
        });
        base.foreign_keys.push(key(kind, "fk_a", "parent_id"));
        let mut draft = Draft::from_base(&base);
        draft
            .apply(&[change(&base, "id", |c| c.name = "order_id".into())])
            .unwrap();
        assert_eq!(draft.foreign_keys[0].target_columns, ["order_id"]);
        // A key to another table keeps its target's `id`.
        assert_eq!(draft.foreign_keys[1].target_columns, ["id"]);
    }

    #[test]
    fn sqlite_alter_needs_the_saved_sql() {
        let base = orders(DialectKind::Sqlite);
        assert_eq!(
            refusal(alter(DialectKind::Sqlite, &base, vec![])),
            "Reload orders: Contura needs its saved SQL to change it."
        );
    }
}
