//! Pending edits: a set of row changes turned into one statement per change.

use serde::{Deserialize, Serialize};

use crate::common::{check_key, sql_ident, sql_string, sql_table};
use crate::error::{Error, Result};
use crate::model::{Cell, ColumnInfo, DialectKind, KeyPart, ObjectPath};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum NewValue {
    Text { value: String },
    Null,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CellChange {
    pub column: String,
    pub old: Cell,
    pub new: NewValue,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RowUpdate {
    pub key: Vec<KeyPart>,
    pub changes: Vec<CellChange>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RowInsert {
    pub values: Vec<(String, NewValue)>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RowDelete {
    pub key: Vec<KeyPart>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EditSet {
    pub table: ObjectPath,
    pub updates: Vec<RowUpdate>,
    pub inserts: Vec<RowInsert>,
    pub deletes: Vec<RowDelete>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedEdit {
    pub sql: String,
    /// True for UPDATE and DELETE: exactly one row must be affected.
    pub one_row: bool,
    /// The row's key; empty for an INSERT.
    pub key: Vec<KeyPart>,
}

/// How a planned save ended. Statement numbers are indexes into the plan.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TxOutcome {
    /// Every statement ran and the transaction committed; affected rows per statement.
    Committed { rows: Vec<u64> },
    /// An UPDATE or DELETE affected other than one row, so the save rolled back.
    RowCount { statement: usize, rows: u64 },
    /// The server refused a statement, so the save rolled back.
    Failed { statement: usize, message: String },
}

/// Types whose old value cannot be compared exactly in a WHERE.
const INEXACT_TYPES: [&str; 14] = [
    "float",
    "double",
    "real",
    "float4",
    "float8",
    "json",
    "jsonb",
    "xml",
    "bytea",
    "blob",
    "binary",
    "varbinary",
    "geometry",
    "point",
];

fn compares_exactly(type_name: &str) -> bool {
    let first = type_name
        .split(|c: char| c.is_whitespace() || c == '(')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    !INEXACT_TYPES.contains(&first.as_str())
}

fn column<'a>(columns: &'a [ColumnInfo], name: &str) -> Result<&'a ColumnInfo> {
    columns
        .iter()
        .find(|c| c.name == name)
        .ok_or_else(|| Error::InvalidInput(format!("unknown column {name}")))
}

/// `[+-]digits[.digits][(e|E)[+-]digits]`, nothing else.
fn is_number(s: &str) -> bool {
    fn digits(s: &str) -> Option<&str> {
        let rest = s.trim_start_matches(|c: char| c.is_ascii_digit());
        (rest.len() < s.len()).then_some(rest)
    }
    let s = s.strip_prefix(['-', '+']).unwrap_or(s);
    let Some(mut rest) = digits(s) else {
        return false;
    };
    if let Some(frac) = rest.strip_prefix('.') {
        let Some(after) = digits(frac) else {
            return false;
        };
        rest = after;
    }
    if let Some(exp) = rest.strip_prefix(['e', 'E']) {
        let exp = exp.strip_prefix(['-', '+']).unwrap_or(exp);
        return digits(exp) == Some("");
    }
    rest.is_empty()
}

/// A Cell used as a key or an old value, as a SQL literal.
fn cell_literal(kind: DialectKind, cell: &Cell) -> Result<String> {
    match cell {
        Cell::Number { value } => {
            if is_number(value) {
                Ok(value.clone())
            } else {
                Err(Error::InvalidInput(format!("{value} is not a number")))
            }
        }
        Cell::Text {
            value, truncated, ..
        } => {
            if *truncated {
                Err(Error::InvalidInput(
                    "a cut-short text value cannot identify a row".into(),
                ))
            } else {
                Ok(sql_string(kind, value))
            }
        }
        Cell::Bytes { .. } => Err(Error::InvalidInput(
            "a binary value cannot identify a row".into(),
        )),
        Cell::Null => Ok("NULL".into()),
    }
}

fn new_literal(kind: DialectKind, value: &NewValue) -> String {
    match value {
        NewValue::Text { value } => sql_string(kind, value),
        NewValue::Null => "NULL".into(),
    }
}

/// `col = value` for each key part, or `col IS NULL`.
fn term(kind: DialectKind, name: &str, cell: &Cell) -> Result<String> {
    let q = sql_ident(kind, name);
    match cell {
        Cell::Null => Ok(format!("{q} IS NULL")),
        other => Ok(format!("{q} = {}", cell_literal(kind, other)?)),
    }
}

fn key_terms(kind: DialectKind, columns: &[ColumnInfo], key: &[KeyPart]) -> Result<Vec<String>> {
    check_key(columns, key)?;
    key.iter()
        .map(|part| {
            if part.value == Cell::Null {
                return Err(Error::InvalidInput("a key value cannot be NULL".into()));
            }
            term(kind, &part.column, &part.value)
        })
        .collect()
}

fn plan_delete(
    kind: DialectKind,
    columns: &[ColumnInfo],
    table: &str,
    row: &RowDelete,
) -> Result<PlannedEdit> {
    let terms = key_terms(kind, columns, &row.key)?;
    Ok(PlannedEdit {
        sql: format!("DELETE FROM {table} WHERE {}", terms.join(" AND ")),
        one_row: true,
        key: row.key.clone(),
    })
}

fn plan_update(
    kind: DialectKind,
    columns: &[ColumnInfo],
    table: &str,
    row: &RowUpdate,
) -> Result<PlannedEdit> {
    let mut terms = key_terms(kind, columns, &row.key)?;
    if row.changes.is_empty() {
        return Err(Error::InvalidInput("an update changes no column".into()));
    }
    let mut sets = Vec::new();
    for change in &row.changes {
        let info = column(columns, &change.column)?;
        sets.push(format!(
            "{} = {}",
            sql_ident(kind, &change.column),
            new_literal(kind, &change.new)
        ));
        // A binary old value is never compared, so Set NULL works on any binary column.
        if compares_exactly(&info.type_name) && !matches!(change.old, Cell::Bytes { .. }) {
            terms.push(term(kind, &change.column, &change.old)?);
        }
    }
    Ok(PlannedEdit {
        sql: format!(
            "UPDATE {table} SET {} WHERE {}",
            sets.join(", "),
            terms.join(" AND ")
        ),
        one_row: true,
        key: row.key.clone(),
    })
}

fn plan_insert(
    kind: DialectKind,
    columns: &[ColumnInfo],
    table: &str,
    row: &RowInsert,
) -> Result<PlannedEdit> {
    let sql = if row.values.is_empty() {
        match kind {
            DialectKind::MySql => format!("INSERT INTO {table} () VALUES ()"),
            DialectKind::Postgres | DialectKind::Sqlite => {
                format!("INSERT INTO {table} DEFAULT VALUES")
            }
        }
    } else {
        let mut names = Vec::new();
        let mut values = Vec::new();
        for (name, value) in &row.values {
            column(columns, name)?;
            names.push(sql_ident(kind, name));
            values.push(new_literal(kind, value));
        }
        format!(
            "INSERT INTO {table} ({}) VALUES ({})",
            names.join(", "),
            values.join(", ")
        )
    };
    Ok(PlannedEdit {
        sql,
        one_row: false,
        key: vec![],
    })
}

/// One statement per change: all deletes, then updates, then inserts, each in input order.
pub fn plan_edits(
    kind: DialectKind,
    columns: &[ColumnInfo],
    edits: &EditSet,
) -> Result<Vec<PlannedEdit>> {
    let table = sql_table(kind, &edits.table)?;
    let mut plan = Vec::new();
    for row in &edits.deletes {
        plan.push(plan_delete(kind, columns, &table, row)?);
    }
    for row in &edits.updates {
        plan.push(plan_update(kind, columns, &table, row)?);
    }
    for row in &edits.inserts {
        plan.push(plan_insert(kind, columns, &table, row)?);
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, ty: &str, pk: bool) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            type_name: ty.into(),
            is_primary_key: pk,
        }
    }

    fn num(v: &str) -> Cell {
        Cell::Number { value: v.into() }
    }

    fn text(v: &str) -> Cell {
        Cell::Text {
            value: v.into(),
            truncated: false,
            total_bytes: v.len() as u64,
        }
    }

    fn key(name: &str, value: Cell) -> KeyPart {
        KeyPart {
            column: name.into(),
            value,
        }
    }

    fn nv(v: &str) -> NewValue {
        NewValue::Text { value: v.into() }
    }

    fn path(kind: DialectKind) -> ObjectPath {
        match kind {
            DialectKind::MySql => ObjectPath {
                database: "shop".into(),
                schema: None,
                name: "orders".into(),
            },
            DialectKind::Postgres => ObjectPath {
                database: "app".into(),
                schema: Some("public".into()),
                name: "orders".into(),
            },
            DialectKind::Sqlite => ObjectPath {
                database: "main".into(),
                schema: None,
                name: "orders".into(),
            },
        }
    }

    fn cols() -> Vec<ColumnInfo> {
        vec![
            col("id", "int", true),
            col("status", "text", false),
            col("shipped_at", "timestamp", false),
            col("note", "text", false),
            col("price", "double precision", false),
            col("meta", "jsonb", false),
        ]
    }

    fn set(kind: DialectKind) -> EditSet {
        EditSet {
            table: path(kind),
            updates: vec![],
            inserts: vec![],
            deletes: vec![],
        }
    }

    fn change(column: &str, old: Cell, new: NewValue) -> CellChange {
        CellChange {
            column: column.into(),
            old,
            new,
        }
    }

    fn update(changes: Vec<CellChange>) -> RowUpdate {
        RowUpdate {
            key: vec![key("id", num("141352"))],
            changes,
        }
    }

    fn one_sql(kind: DialectKind, edits: &EditSet) -> String {
        let mut plan = plan_edits(kind, &cols(), edits).unwrap();
        assert_eq!(plan.len(), 1);
        plan.remove(0).sql
    }

    const ALL: [DialectKind; 3] = [
        DialectKind::MySql,
        DialectKind::Postgres,
        DialectKind::Sqlite,
    ];

    fn q(kind: DialectKind, name: &str) -> String {
        sql_ident(kind, name)
    }

    fn table(kind: DialectKind) -> String {
        sql_table(kind, &path(kind)).unwrap()
    }

    #[test]
    fn number_grammar() {
        for ok in ["-12", "3.50", "1e-3", "+7", "0", "2E+10", "1.5e3"] {
            assert!(is_number(ok), "{ok}");
        }
        for bad in [
            "1--", "1-1", "--", "1e", ".5", "", "-", "1.", "1e+", "1 ", "a",
        ] {
            assert!(!is_number(bad), "{bad:?}");
        }
        let mut e = set(DialectKind::Postgres);
        e.deletes.push(RowDelete {
            key: vec![key("id", num("1--"))],
        });
        assert!(matches!(
            plan_edits(DialectKind::Postgres, &cols(), &e),
            Err(Error::InvalidInput(_))
        ));
    }

    #[test]
    fn postgres_edit_without_schema_is_invalid() {
        let mut e = set(DialectKind::Postgres);
        e.table.schema = None;
        e.inserts.push(RowInsert { values: vec![] });
        assert!(matches!(
            plan_edits(DialectKind::Postgres, &cols(), &e),
            Err(Error::InvalidInput(m)) if m == "choose a schema"
        ));
    }

    #[test]
    fn binary_old_value_is_skipped_but_cut_text_old_is_not() {
        let bytes = Cell::Bytes {
            preview_hex: "00".into(),
            truncated: true,
            total_bytes: 99,
        };
        let mut e = set(DialectKind::MySql);
        e.updates
            .push(update(vec![change("note", bytes, NewValue::Null)]));
        assert_eq!(
            one_sql(DialectKind::MySql, &e),
            "UPDATE `shop`.`orders` SET `note` = NULL WHERE `id` = 141352"
        );
    }

    #[test]
    fn update_sets_value_and_checks_old() {
        let mut e = set(DialectKind::Postgres);
        e.updates.push(update(vec![change(
            "status",
            text("paid"),
            nv("cancelled"),
        )]));
        assert_eq!(
            one_sql(DialectKind::Postgres, &e),
            r#"UPDATE "public"."orders" SET "status" = 'cancelled' WHERE "id" = 141352 AND "status" = 'paid'"#
        );
        let mut e = set(DialectKind::MySql);
        e.updates.push(update(vec![change(
            "status",
            text("paid"),
            nv("cancelled"),
        )]));
        assert_eq!(
            one_sql(DialectKind::MySql, &e),
            "UPDATE `shop`.`orders` SET `status` = 'cancelled' WHERE `id` = 141352 AND `status` = 'paid'"
        );
        let mut e = set(DialectKind::Sqlite);
        e.updates.push(update(vec![change(
            "status",
            text("paid"),
            nv("cancelled"),
        )]));
        assert_eq!(
            one_sql(DialectKind::Sqlite, &e),
            r#"UPDATE "main"."orders" SET "status" = 'cancelled' WHERE "id" = 141352 AND "status" = 'paid'"#
        );
    }

    #[test]
    fn old_null_uses_is_null_and_new_null_sets_null() {
        for k in ALL {
            let mut e = set(k);
            e.updates.push(update(vec![
                change("shipped_at", Cell::Null, nv("2026-01-01")),
                change("note", text("x"), NewValue::Null),
            ]));
            assert_eq!(
                one_sql(k, &e),
                format!(
                    "UPDATE {} SET {s} = '2026-01-01', {n} = NULL WHERE {i} = 141352 AND {s} IS NULL AND {n} = 'x'",
                    table(k),
                    s = q(k, "shipped_at"),
                    n = q(k, "note"),
                    i = q(k, "id"),
                )
            );
        }
    }

    #[test]
    fn composite_key_in_key_order() {
        let columns = vec![
            col("a", "int", true),
            col("b", "text", true),
            col("v", "text", false),
        ];
        let mut e = set(DialectKind::Postgres);
        e.updates.push(RowUpdate {
            key: vec![key("b", text("x")), key("a", num("1"))],
            changes: vec![change("v", Cell::Null, nv("n"))],
        });
        let plan = plan_edits(DialectKind::Postgres, &columns, &e).unwrap();
        assert_eq!(
            plan[0].sql,
            r#"UPDATE "public"."orders" SET "v" = 'n' WHERE "b" = 'x' AND "a" = 1 AND "v" IS NULL"#
        );
    }

    #[test]
    fn string_literals() {
        for k in ALL {
            let mut e = set(k);
            e.updates
                .push(update(vec![change("note", Cell::Null, nv("it's"))]));
            assert!(one_sql(k, &e).contains("= 'it''s'"));
        }
        let mut e = set(DialectKind::MySql);
        e.updates
            .push(update(vec![change("note", Cell::Null, nv("a\\b"))]));
        assert!(one_sql(DialectKind::MySql, &e).contains("= _utf8mb4 X'615c62'"));
        for k in [DialectKind::Postgres, DialectKind::Sqlite] {
            let mut e = set(k);
            e.updates
                .push(update(vec![change("note", Cell::Null, nv("a\\b"))]));
            assert!(one_sql(k, &e).contains("= 'a\\b'"));
        }
    }

    #[test]
    fn inexact_types_skip_old_value() {
        for (name, old) in [("price", num("1.5")), ("meta", text("{}"))] {
            for k in ALL {
                let mut e = set(k);
                e.updates
                    .push(update(vec![change(name, old.clone(), nv("2"))]));
                assert_eq!(
                    one_sql(k, &e),
                    format!(
                        "UPDATE {} SET {} = '2' WHERE {} = 141352",
                        table(k),
                        q(k, name),
                        q(k, "id")
                    )
                );
            }
        }
    }

    #[test]
    fn skipped_type_matches_first_word_case_insensitively() {
        let columns = vec![
            col("id", "int", true),
            col("a", "DOUBLE PRECISION", false),
            col("b", "Float4", false),
            col("c", "varchar(20)", false),
        ];
        let mut e = set(DialectKind::MySql);
        e.updates.push(update(vec![
            change("a", num("1"), nv("2")),
            change("b", num("1"), nv("2")),
            change("c", text("z"), nv("y")),
        ]));
        let plan = plan_edits(DialectKind::MySql, &columns, &e).unwrap();
        assert!(plan[0].sql.ends_with("WHERE `id` = 141352 AND `c` = 'z'"));
    }

    #[test]
    fn delete_uses_key_only() {
        let mut e = set(DialectKind::MySql);
        e.deletes.push(RowDelete {
            key: vec![key("id", num("141360"))],
        });
        assert_eq!(
            one_sql(DialectKind::MySql, &e),
            "DELETE FROM `shop`.`orders` WHERE `id` = 141360"
        );
    }

    #[test]
    fn insert_lists_given_columns_only() {
        for k in ALL {
            let mut e = set(k);
            e.inserts.push(RowInsert {
                values: vec![
                    ("status".into(), nv("new")),
                    ("note".into(), NewValue::Null),
                ],
            });
            assert_eq!(
                one_sql(k, &e),
                format!(
                    "INSERT INTO {} ({}, {}) VALUES ('new', NULL)",
                    table(k),
                    q(k, "status"),
                    q(k, "note")
                )
            );
        }
    }

    #[test]
    fn insert_with_no_values() {
        let plain = |k: DialectKind| {
            let mut e = set(k);
            e.table = ObjectPath {
                database: "d".into(),
                schema: Some("public".into()),
                name: "t".into(),
            };
            e.inserts.push(RowInsert { values: vec![] });
            one_sql(k, &e)
        };
        assert_eq!(
            plain(DialectKind::MySql),
            "INSERT INTO `d`.`t` () VALUES ()"
        );
        assert_eq!(
            plain(DialectKind::Postgres),
            r#"INSERT INTO "public"."t" DEFAULT VALUES"#
        );
        assert_eq!(
            plain(DialectKind::Sqlite),
            r#"INSERT INTO "d"."t" DEFAULT VALUES"#
        );
    }

    #[test]
    fn order_and_flags() {
        let mut e = set(DialectKind::Postgres);
        e.inserts.push(RowInsert { values: vec![] });
        e.updates
            .push(update(vec![change("note", Cell::Null, nv("a"))]));
        e.updates.push(RowUpdate {
            key: vec![key("id", num("2"))],
            changes: vec![change("note", Cell::Null, nv("b"))],
        });
        e.deletes.push(RowDelete {
            key: vec![key("id", num("9"))],
        });
        e.deletes.push(RowDelete {
            key: vec![key("id", num("8"))],
        });
        let plan = plan_edits(DialectKind::Postgres, &cols(), &e).unwrap();
        let heads: Vec<&str> = plan.iter().map(|p| &p.sql[..6]).collect();
        assert_eq!(heads, ["DELETE", "DELETE", "UPDATE", "UPDATE", "INSERT"]);
        assert!(plan[0].sql.ends_with("\"id\" = 9"));
        assert!(plan[1].sql.ends_with("\"id\" = 8"));
        assert!(plan[2].sql.contains("= 141352"));
        assert!(plan[3].sql.contains("\"id\" = 2 "));
        assert_eq!(
            plan.iter().map(|p| p.one_row).collect::<Vec<_>>(),
            [true, true, true, true, false]
        );
        assert_eq!(plan[0].key, vec![key("id", num("9"))]);
        assert_eq!(plan[2].key, vec![key("id", num("141352"))]);
        assert!(plan[4].key.is_empty());
    }

    #[test]
    fn cut_short_or_binary_key_and_old_are_rejected() {
        let cut = Cell::Text {
            value: "ab".into(),
            truncated: true,
            total_bytes: 9000,
        };
        let bytes = Cell::Bytes {
            preview_hex: "00".into(),
            truncated: false,
            total_bytes: 1,
        };
        let mut e = set(DialectKind::Postgres);
        e.updates
            .push(update(vec![change("status", cut.clone(), nv("x"))]));
        assert!(matches!(
            plan_edits(DialectKind::Postgres, &cols(), &e),
            Err(Error::InvalidInput(_))
        ));
        for bad in [cut, bytes] {
            let mut e = set(DialectKind::Postgres);
            e.deletes.push(RowDelete {
                key: vec![key("id", bad)],
            });
            assert!(matches!(
                plan_edits(DialectKind::Postgres, &cols(), &e),
                Err(Error::InvalidInput(_))
            ));
        }
    }

    #[test]
    fn no_primary_key_blocks_update_and_delete_not_insert() {
        let columns = vec![col("a", "text", false)];
        let mut e = set(DialectKind::Sqlite);
        e.updates.push(RowUpdate {
            key: vec![],
            changes: vec![change("a", Cell::Null, nv("x"))],
        });
        assert!(matches!(
            plan_edits(DialectKind::Sqlite, &columns, &e),
            Err(Error::NoPrimaryKey)
        ));
        let mut e = set(DialectKind::Sqlite);
        e.deletes.push(RowDelete { key: vec![] });
        assert!(matches!(
            plan_edits(DialectKind::Sqlite, &columns, &e),
            Err(Error::NoPrimaryKey)
        ));
        let mut e = set(DialectKind::Sqlite);
        e.inserts.push(RowInsert {
            values: vec![("a".into(), nv("x"))],
        });
        assert!(plan_edits(DialectKind::Sqlite, &columns, &e).is_ok());
    }

    #[test]
    fn unknown_column_and_bad_number_are_rejected() {
        let mut e = set(DialectKind::Postgres);
        e.updates
            .push(update(vec![change("nope", Cell::Null, nv("x"))]));
        assert!(matches!(
            plan_edits(DialectKind::Postgres, &cols(), &e),
            Err(Error::InvalidInput(_))
        ));
        let mut e = set(DialectKind::Postgres);
        e.deletes.push(RowDelete {
            key: vec![key("id", num("1; DROP TABLE x"))],
        });
        assert!(matches!(
            plan_edits(DialectKind::Postgres, &cols(), &e),
            Err(Error::InvalidInput(_))
        ));
    }
}
