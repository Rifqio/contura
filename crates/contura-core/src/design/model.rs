//! The read model of one table, as the Table Designer loads it.

use serde::{Deserialize, Serialize};

use crate::model::ObjectPath;

/// Adds `attribute` to `list` once.
pub(crate) fn add_attribute(list: &mut Vec<String>, attribute: &str) {
    if !list.iter().any(|a| a == attribute) {
        list.push(attribute.to_string());
    }
}

/// The `unsupported` note for an advanced index or key, such as
/// `index orders_ix (include columns, descending order)`.
pub(crate) fn advanced_note(kind: &str, name: &str, attributes: &[String]) -> String {
    format!("{kind} {name} ({})", attributes.join(", "))
}

/// One table as the server holds it, with the real names of its indexes and keys.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableDesign {
    pub path: ObjectPath,
    pub columns: Vec<TableColumn>,
    /// The primary key first, then the rest by name (SQLite: by creation).
    pub indexes: Vec<TableIndex>,
    pub foreign_keys: Vec<TableForeignKey>,
    /// Foreign Keys of other tables (or this one) that reference this table.
    pub referenced_by: Vec<IncomingRef>,
    pub comment: Option<String>,
    /// What the designer cannot edit: `check <name>`, `trigger <name>`,
    /// `generated column <name>`, `without rowid`, `strict`, and for an index or key
    /// with `advanced` set `index <name> (<attributes>)` or `foreign key <name> (<attributes>)`.
    pub unsupported: Vec<String>,
    pub sqlite: Option<SqliteExtras>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableColumn {
    pub name: String,
    /// The type as the server writes it, such as `varchar(16)` or `character varying(16)`.
    pub type_sql: String,
    pub nullable: bool,
    /// The default as SQL text, such as `'new'` or `CURRENT_TIMESTAMP`.
    pub default_sql: Option<String>,
    pub increment: Increment,
    pub comment: Option<String>,
    pub generated: bool,
    /// MySQL only: what a `MODIFY` must repeat to keep the column as it is.
    pub mysql: Option<MySqlColumn>,
    /// SQLite: the rowid alias was declared with the `AUTOINCREMENT` keyword, so ids
    /// are never reused. A plain rowid alias is `AutoIncrement` without it.
    #[serde(default)]
    pub sqlite_autoincrement: bool,
    /// The column's collation when it is not the default: MySQL when it differs
    /// from the table's, PostgreSQL when it differs from the type's, SQLite the
    /// `COLLATE` in the column definition as written.
    #[serde(default)]
    pub collation: Option<String>,
    /// MySQL: the column has something a restatement would lose (INVISIBLE, SRID,
    /// COLUMN_FORMAT, STORAGE, ENGINE_ATTRIBUTE), so it may only be renamed or
    /// dropped; `unsupported` names it as `column <name> (<attributes>)`.
    #[serde(default)]
    pub advanced: bool,
    /// PostgreSQL `GENERATED ALWAYS AS IDENTITY` (D6): an INSERT that gives the column a
    /// value needs `OVERRIDING SYSTEM VALUE`. False for BY DEFAULT and on other Dialects.
    #[serde(default)]
    pub identity_always: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Increment {
    #[default]
    None,
    /// MySQL `AUTO_INCREMENT`; on SQLite the single INTEGER primary key (the rowid alias).
    AutoIncrement,
    /// PostgreSQL identity column.
    Identity,
    /// PostgreSQL `serial`: a `nextval(...)` default.
    Serial,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MySqlColumn {
    pub charset: Option<String>,
    pub collation: Option<String>,
    /// The `on update` expression, such as `CURRENT_TIMESTAMP`.
    pub on_update: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableIndex {
    pub name: String,
    /// Column names; an expression key part holds its text.
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
    /// PostgreSQL: the index backs a PRIMARY KEY or UNIQUE constraint.
    pub constraint: bool,
    /// SQLite: the saved `CREATE INDEX` text; `None` for autoindexes and the primary key.
    pub sql: Option<String>,
    /// PostgreSQL `pg_am.amname`; MySQL `INDEX_TYPE` lower-cased; SQLite `None`.
    #[serde(default)]
    pub method: Option<String>,
    /// A partial index's WHERE text as the server writes it.
    #[serde(default)]
    pub predicate: Option<String>,
    /// Some key part is an expression.
    #[serde(default)]
    pub expression: bool,
    /// The index has something this model does not carry (INCLUDE columns, a sort
    /// order, an operator class, a collation, a prefix length, FULLTEXT and the
    /// like), so it cannot be recreated from the model; `unsupported` names it.
    #[serde(default)]
    pub advanced: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableForeignKey {
    /// SQLite keys have no names; they are `fk_<id>`.
    pub name: String,
    pub columns: Vec<String>,
    pub target: ObjectPath,
    pub target_columns: Vec<String>,
    /// Upper case, such as `CASCADE`; `None` for the Dialect's default.
    pub on_delete: Option<String>,
    pub on_update: Option<String>,
    /// The key is DEFERRABLE, INITIALLY DEFERRED or has a MATCH kind, which this model
    /// does not carry, so it cannot be recreated from the model; `unsupported` names it.
    #[serde(default)]
    pub advanced: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IncomingRef {
    pub name: String,
    pub table: ObjectPath,
    /// SQLite: the key's ON DELETE action, upper case, such as `CASCADE`; `None`
    /// for NO ACTION, and on MySQL and PostgreSQL, which refuse such a drop.
    #[serde(default)]
    pub on_delete: Option<String>,
}

/// What an SQLite rebuild must carry over.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SqliteExtras {
    pub create_sql: String,
    pub triggers: Vec<SavedObject>,
    /// Views that name the table, and views that name those, in creation order.
    pub views: Vec<SavedObject>,
    pub foreign_keys_on: bool,
    /// The INSTEAD OF triggers of `views`, which `DROP VIEW` drops with them.
    #[serde(default)]
    pub view_triggers: Vec<SavedObject>,
    /// The other tables with a Foreign Key to this one, with their saved
    /// `CREATE TABLE`, so a Drop can refuse when one changed since loading (S15).
    #[serde(default)]
    pub children: Vec<SavedObject>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedObject {
    pub name: String,
    pub sql: String,
}
