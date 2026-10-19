//! The structure of a Backup, written from the server's own DDL text (spec "Core",
//! `structure/`): one writer per Dialect, each reading inside the backup's snapshot on
//! the connection the Backup job holds, and returning the statements in restore order.
//!
//! Each statement is a [`StructureItem`]: the exact text to write into the file,
//! terminator included, followed by a line end, tagged with what it makes and the table
//! it belongs to. A MySQL routine or trigger carries its own `DELIMITER ;;` and
//! `DELIMITER ;` lines, so one item is still one statement for the trailer's count.
//!
//! Every writer reads its catalog into a plain value first and builds the statements from
//! it, so the rules are tested on fixture catalog output without a server.

pub mod mysql;
pub mod postgres;
mod postgres_catalog;
#[cfg(test)]
mod postgres_tests;
pub mod sqlite;

use std::collections::HashMap;

/// How many of each object the structure holds, for the Backup dialog's count lines.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ContentCounts {
    pub tables: u32,
    /// Every index, including the ones behind primary keys and uniques.
    pub indexes: u32,
    pub foreign_keys: u32,
    /// PostgreSQL enum types; MySQL `ENUM` columns.
    pub enums: u32,
    /// PostgreSQL sequences that are not identity columns; MySQL and SQLite
    /// auto-increment counters.
    pub sequences: u32,
    /// Views and materialized views.
    pub views: u32,
    pub functions: u32,
    pub procedures: u32,
    pub triggers: u32,
    pub checks: u32,
    pub generated: u32,
}

/// What a structure statement makes, so the Backup job can apply the dialog's ticks and
/// put `DROP TABLE IF EXISTS` before each table's CREATE (ruling R8).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum StructureKind {
    /// A session setting, such as `SET sql_mode` or `PRAGMA foreign_keys`.
    Setting,
    Schema,
    /// A PostgreSQL enum type.
    Enum,
    Sequence,
    Function,
    Procedure,
    /// A `CREATE TABLE`. On MySQL and SQLite it holds the table's keys, indexes, Foreign
    /// Keys and checks as the server wrote them.
    Table,
    /// `COMMENT ON` (PostgreSQL).
    Comment,
    /// `ALTER SEQUENCE .. OWNED BY` (PostgreSQL).
    OwnedBy,
    /// A primary key, unique or exclusion constraint (PostgreSQL).
    Constraint,
    /// A check constraint (PostgreSQL).
    Check,
    Index,
    ForeignKey,
    /// A view or materialized view.
    View,
    Trigger,
    /// A sequence's current value (PostgreSQL `setval`, SQLite `sqlite_sequence`).
    Setval,
    /// SQLite `PRAGMA user_version`.
    UserVersion,
}

/// One statement: the exact text to write, terminator included, then a line end.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StructureItem {
    pub kind: StructureKind,
    /// The table it belongs to, where there is one: a table's own CREATE, its comments,
    /// constraints, indexes, Foreign Keys, triggers and owned sequences. Views have none.
    pub table: Option<String>,
    pub sql: String,
}

impl StructureItem {
    pub fn new(kind: StructureKind, sql: impl Into<String>) -> Self {
        Self {
            kind,
            table: None,
            sql: sql.into(),
        }
    }

    pub fn on(kind: StructureKind, table: impl Into<String>, sql: impl Into<String>) -> Self {
        Self {
            kind,
            table: Some(table.into()),
            sql: sql.into(),
        }
    }
}

/// The statements' texts, in order.
pub fn texts(items: &[StructureItem]) -> Vec<&str> {
    items.iter().map(|i| i.sql.as_str()).collect()
}

/// The structure sections of a Backup, in restore order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StructureParts {
    /// The settings section.
    pub settings: Vec<StructureItem>,
    /// The structure section, before the rows.
    pub before_rows: Vec<StructureItem>,
    /// The after-rows section.
    pub after_rows: Vec<StructureItem>,
    /// The finish section.
    pub finish: Vec<StructureItem>,
    /// For the header's `not-included` line, each item by name.
    pub not_included: Vec<String>,
    pub counts: ContentCounts,
    /// The tables whose rows the Backup writes, in the order their CREATE statements
    /// come: MySQL and SQLite table names, PostgreSQL names within the schema.
    pub tables: Vec<String>,
    /// MySQL: a `DEFINER=` clause was removed, for the header's `definer` line.
    pub definer_removed: bool,
}

/// Orders `items` so each comes after the items it names in `deps` (only names in
/// `items` count), keeping `items`' own order otherwise. A cycle keeps the rest in their
/// given order rather than looping.
pub(crate) fn dependency_order<T>(
    items: Vec<T>,
    name: impl Fn(&T) -> &str,
    deps: impl Fn(&T) -> &[String],
) -> Vec<T> {
    let index: HashMap<&str, usize> = items
        .iter()
        .enumerate()
        .map(|(i, item)| (name(item), i))
        .collect();
    let mut placed = vec![false; items.len()];
    let mut order = Vec::with_capacity(items.len());
    let mut first_open = 0;
    while order.len() < items.len() {
        while placed[first_open] {
            first_open += 1;
        }
        let ready = |i: usize| {
            deps(&items[i])
                .iter()
                .all(|d| index.get(d.as_str()).is_none_or(|&j| j == i || placed[j]))
        };
        // A cycle: take the first left, as written.
        let i = (first_open..items.len())
            .find(|&i| !placed[i] && ready(i))
            .unwrap_or(first_open);
        placed[i] = true;
        order.push(i);
    }
    let mut slots: Vec<Option<T>> = items.into_iter().map(Some).collect();
    order.into_iter().filter_map(|i| slots[i].take()).collect()
}

/// `text` ending in exactly one `;`.
pub(crate) fn terminated(text: &str) -> String {
    let t = text.trim_end();
    let t = t.strip_suffix(';').unwrap_or(t).trim_end();
    format!("{t};")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dependency_order_puts_dependencies_first_and_keeps_ties() {
        let items = vec![
            ("a_top", vec!["m_mid".to_string()]),
            ("b_plain", vec![]),
            ("m_mid", vec!["z_base".to_string(), "table_x".to_string()]),
            ("z_base", vec![]),
        ];
        let got: Vec<&str> = dependency_order(items, |i| i.0, |i| &i.1)
            .into_iter()
            .map(|i| i.0)
            .collect();
        assert_eq!(got, ["b_plain", "z_base", "m_mid", "a_top"]);
    }

    #[test]
    fn dependency_order_survives_a_cycle() {
        let items = vec![("a", vec!["b".to_string()]), ("b", vec!["a".to_string()])];
        let got: Vec<&str> = dependency_order(items, |i| i.0, |i| &i.1)
            .into_iter()
            .map(|i| i.0)
            .collect();
        assert_eq!(got, ["a", "b"]);
    }

    #[test]
    fn terminated_adds_one_semicolon() {
        assert_eq!(terminated("SELECT 1"), "SELECT 1;");
        assert_eq!(terminated(" SELECT 1;\n"), " SELECT 1;");
        assert_eq!(terminated("SELECT 1 ;"), "SELECT 1;");
    }
}
