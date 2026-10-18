//! File columns to table columns, and match by name (Task 8).
//!
//! The Core and the Import tab share one matching rule (D19), pinned by the case file
//! `src/jobs/match_cases.json` that both test suites read (Q11).

use serde::Serialize;

use crate::design::{Increment, TableColumn};
use crate::jobs::checks::check_value;
use crate::jobs::insert::{Conversion, conversion_for};
use crate::jobs::types::ColumnMap;
use crate::model::DialectKind;

/// A table column as the import sees it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TargetColumn {
    pub name: String,
    pub type_sql: String,
    pub nullable: bool,
    pub has_default: bool,
    pub increment: Increment,
    /// A computed column: never offered as an Into column.
    pub generated: bool,
    /// PostgreSQL `GENERATED ALWAYS AS IDENTITY` (D6).
    pub identity_always: bool,
}

impl From<&TableColumn> for TargetColumn {
    fn from(c: &TableColumn) -> Self {
        TargetColumn {
            name: c.name.clone(),
            type_sql: c.type_sql.clone(),
            nullable: c.nullable,
            has_default: c.default_sql.is_some(),
            increment: c.increment,
            generated: c.generated,
            identity_always: c.identity_always,
        }
    }
}

impl TargetColumn {
    /// The database fills it when the file gives it nothing.
    pub fn filled_by_database(&self) -> bool {
        self.generated || self.increment != Increment::None
    }

    /// No value from the file fails the INSERT: not nullable, no default, not filled.
    pub fn needs_value(&self) -> bool {
        !self.nullable && !self.has_default && !self.filled_by_database()
    }
}

/// A name as matching reads it: lower case, without `_`, `-` and spaces.
pub fn match_key(name: &str) -> String {
    name.chars()
        .filter(|c| !matches!(c, '_' | '-' | ' '))
        .flat_map(char::to_lowercase)
        .collect()
}

/// One entry per file column. A file column takes the first table column whose name
/// matches (ignoring case, `_`, `-` and spaces) and that no earlier file column took;
/// generated columns never match.
pub fn match_by_name(file: &[String], targets: &[TargetColumn]) -> Vec<ColumnMap> {
    let mut taken = vec![false; targets.len()];
    file.iter()
        .enumerate()
        .map(|(i, name)| {
            let key = match_key(name);
            let found = targets
                .iter()
                .enumerate()
                .position(|(t, c)| !taken[t] && !c.generated && match_key(&c.name) == key);
            if let Some(t) = found {
                taken[t] = true;
            }
            ColumnMap {
                file_column: i,
                into: found.map(|t| targets[t].name.clone()),
                by_hand: false,
            }
        })
        .collect()
}

/// The sentence a table column that needs a value and has none gives.
pub fn needs_value_text(name: &str) -> String {
    format!("{name} needs a value: map a file column to it.")
}

pub const NO_ROWS: &str = "The file has no rows.";
pub const NOTHING_MAPPED: &str = "Map at least one file column to a table column.";

/// What keeps the run from starting: every table column that needs a value and gets
/// none, then a file with no data rows (Review Focus 1), then a mapping that imports
/// nothing.
pub fn blockers(targets: &[TargetColumn], mapping: &[ColumnMap], has_rows: bool) -> Vec<String> {
    let mapped = |name: &str| mapping.iter().any(|m| m.into.as_deref() == Some(name));
    let mut out: Vec<String> = targets
        .iter()
        .filter(|t| t.needs_value() && !mapped(&t.name))
        .map(|t| needs_value_text(&t.name))
        .collect();
    if !has_rows {
        out.push(NO_ROWS.into());
    } else if !mapping.iter().any(|m| m.into.is_some()) {
        out.push(NOTHING_MAPPED.into());
    }
    out
}

const YES_NO: &[&str] = &["yes", "no", "y", "n", "on", "off"];

/// The note the Columns step shows for table column `target`, from the file's header,
/// the mapping and the sample rows (their values by file column, after the empty-cell
/// and NULL rules; None is NULL).
pub fn column_note(
    kind: DialectKind,
    target: &TargetColumn,
    file: &[String],
    mapping: &[ColumnMap],
    sample: &[Vec<Option<String>>],
) -> Option<String> {
    let Some(m) = mapping
        .iter()
        .find(|m| m.into.as_deref() == Some(target.name.as_str()))
    else {
        if target.increment != Increment::None {
            return Some("Filled by the database (identity)".into());
        }
        if target.generated {
            return None;
        }
        let key = match_key(&target.name);
        return Some(if file.iter().any(|f| match_key(f) == key) {
            "Not imported".into()
        } else {
            "No column with this name".into()
        });
    };
    let values = || {
        sample
            .iter()
            .filter_map(|row| row.get(m.file_column).cloned().flatten())
    };
    match conversion_for(kind, &target.type_sql) {
        Conversion::Number => {
            let bad = values()
                .filter(|v| check_value(kind, target, v).is_some())
                .count();
            match bad {
                0 => {}
                1 => return Some("1 row is not a number".into()),
                n => return Some(format!("{n} rows are not numbers")),
            }
        }
        Conversion::Bool
            if values().any(|v| YES_NO.contains(&v.trim().to_ascii_lowercase().as_str())) =>
        {
            return Some("yes and no are read as true and false".into());
        }
        _ => {}
    }
    if m.by_hand {
        return Some("By hand".into());
    }
    match file.get(m.file_column) {
        Some(name) if *name != target.name => Some("The names differ".into()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, type_sql: &str) -> TargetColumn {
        TargetColumn {
            name: name.into(),
            type_sql: type_sql.into(),
            nullable: true,
            ..TargetColumn::default()
        }
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[derive(serde::Deserialize)]
    struct Target {
        name: String,
        #[serde(rename = "type")]
        type_sql: String,
        nullable: bool,
        generated: bool,
    }

    #[derive(serde::Deserialize)]
    struct Case {
        file: Vec<String>,
        targets: Vec<Target>,
        expected: Vec<Option<String>>,
    }

    /// The case file the Import tab's tests read too (D19, Q11).
    #[test]
    fn match_cases_json() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../../../src/jobs/match_cases.json"))
                .expect("match_cases.json");
        assert!(!cases.is_empty());
        for (n, case) in cases.iter().enumerate() {
            let targets: Vec<TargetColumn> = case
                .targets
                .iter()
                .map(|t| TargetColumn {
                    name: t.name.clone(),
                    type_sql: t.type_sql.clone(),
                    nullable: t.nullable,
                    generated: t.generated,
                    ..TargetColumn::default()
                })
                .collect();
            let got = match_by_name(&case.file, &targets);
            assert_eq!(got.len(), case.file.len(), "case {n}");
            for (i, m) in got.iter().enumerate() {
                assert_eq!(m.file_column, i, "case {n}");
                assert!(!m.by_hand, "case {n}");
            }
            let into: Vec<Option<String>> = got.into_iter().map(|m| m.into).collect();
            assert_eq!(into, case.expected, "case {n}: {:?}", case.file);
        }
    }

    #[test]
    fn generated_never_offered() {
        let mut total = col("total", "numeric");
        total.generated = true;
        let targets = vec![total, col("price", "numeric")];
        let got = match_by_name(&names(&["total", "price"]), &targets);
        assert_eq!(got[0].into, None);
        assert_eq!(got[1].into.as_deref(), Some("price"));
        // A generated column needs no value and blocks nothing.
        let mut g = col("g", "int");
        g.nullable = false;
        g.generated = true;
        assert!(!g.needs_value());
    }

    #[test]
    fn blockers_for_not_null_without_default() {
        let mut price = col("price", "numeric");
        price.nullable = false;
        let mut status = col("status", "text");
        status.nullable = false;
        status.has_default = true;
        let mut id = col("id", "integer");
        id.nullable = false;
        id.increment = Increment::Identity;
        let mut sku = col("sku", "text");
        sku.nullable = false;
        let targets = vec![id, sku, price, status, col("note", "text")];
        let mapping = vec![ColumnMap {
            file_column: 0,
            into: Some("sku".into()),
            by_hand: false,
        }];
        assert_eq!(
            blockers(&targets, &mapping, true),
            ["price needs a value: map a file column to it."]
        );
        assert_eq!(
            blockers(&targets, &mapping, false),
            [
                "price needs a value: map a file column to it.",
                "The file has no rows."
            ]
        );
        let none = vec![ColumnMap {
            file_column: 0,
            into: None,
            by_hand: false,
        }];
        assert_eq!(
            blockers(&[col("note", "text")], &none, true),
            [NOTHING_MAPPED]
        );
    }

    #[test]
    fn notes() {
        let k = DialectKind::Postgres;
        let file = names(&["Unit Price", "sku", "active", "qty", "extra"]);
        let map = |i: usize, into: &str, by_hand: bool| ColumnMap {
            file_column: i,
            into: Some(into.into()),
            by_hand,
        };
        let mapping = vec![
            map(0, "unit_price", false),
            map(1, "sku", true),
            map(2, "active", false),
            map(3, "qty", false),
        ];
        let some = |s: &str| Some(s.to_string());
        let sample = vec![
            vec![some("1.50"), some("a"), some("yes"), some("n/a")],
            vec![some("2"), some("b"), some("true"), some("12,50")],
            vec![None, some("c"), None, some("3")],
        ];
        let note = |t: &TargetColumn| column_note(k, t, &file, &mapping, &sample);
        assert_eq!(
            note(&col("unit_price", "numeric")).as_deref(),
            Some("The names differ")
        );
        assert_eq!(note(&col("sku", "text")).as_deref(), Some("By hand"));
        assert_eq!(
            note(&col("active", "boolean")).as_deref(),
            Some("yes and no are read as true and false")
        );
        assert_eq!(
            note(&col("qty", "integer")).as_deref(),
            Some("2 rows are not numbers")
        );
        assert_eq!(
            note(&col("missing", "text")).as_deref(),
            Some("No column with this name")
        );
        assert_eq!(note(&col("extra", "text")).as_deref(), Some("Not imported"));
        let mut id = col("id", "integer");
        id.increment = Increment::Serial;
        assert_eq!(
            note(&id).as_deref(),
            Some("Filled by the database (identity)")
        );
        // Mapped under its own name, with good values: no note.
        let exact = vec![map(1, "sku", false)];
        assert_eq!(
            column_note(k, &col("sku", "text"), &file, &exact, &sample),
            None
        );
        let one = vec![vec![some("x")]];
        let first = vec![map(0, "n", false)];
        assert_eq!(
            column_note(k, &col("n", "int"), &names(&["n"]), &first, &one).as_deref(),
            Some("1 row is not a number")
        );
    }

    #[test]
    fn target_from_table_column() {
        let c = TableColumn {
            name: "id".into(),
            type_sql: "integer".into(),
            nullable: false,
            default_sql: Some("0".into()),
            increment: Increment::Identity,
            identity_always: true,
            ..TableColumn::default()
        };
        let t = TargetColumn::from(&c);
        assert!(t.has_default && t.identity_always && !t.nullable);
        assert_eq!(t.increment, Increment::Identity);
    }
}
