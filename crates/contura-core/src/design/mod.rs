//! The Table Designer: the read model of one table, design edits and the
//! planner that turns them into DDL.

mod fragment;
mod model;
mod mysql;
mod plan;
mod postgres;
mod sqlite;
mod warning;

pub(crate) use fragment::check_fragment;
pub use model::{
    IncomingRef, Increment, MySqlColumn, SavedObject, SqliteExtras, TableColumn, TableDesign,
    TableForeignKey, TableIndex,
};
pub(crate) use model::{add_attribute, advanced_note};
pub use plan::{
    ColumnDraft, DesignEdit, DesignMode, DesignPlan, DesignRequest, DesignTarget, ForeignKeyDraft,
    IndexDraft, Position, plan_design,
};
pub(crate) use plan::{LoadedSchema, TABLE_CHANGED};
pub use warning::{ChildAction, DesignWarning, RowCount, Rule};

/// What `Dialect::apply_design` did with a plan.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DesignOutcome {
    /// Every statement ran; `ran` is the plan's statement count.
    Done { ran: usize },
    /// Statement `statement` (its place in the plan) failed. `ran` statements
    /// before it stay applied: always 0 where the plan ran in a transaction that
    /// rolled back, the count of statements already run on MySQL.
    Failed {
        statement: usize,
        ran: usize,
        message: String,
    },
    /// A Foreign Key check found rows in `table` that break a key; rolled back.
    ForeignKeys { table: String },
}

/// The refusal for a plan Apply must not run.
pub(crate) const CANNOT_REBUILD: &str = "Contura cannot rebuild this table safely.";

/// The refusal when `PRAGMA foreign_keys` differs from the value the plan was
/// made with (S9): the `after` statements would restore the wrong value.
pub(crate) const FOREIGN_KEYS_CHANGED: &str = "Foreign Key enforcement on this Connection changed \
     since the table was loaded. Reload the table and apply again.";

/// Where the plan's parts start and end: `before` statements, the middle (the
/// transaction), the `after` statements that run whatever happened.
pub(crate) struct Parts {
    pub before: std::ops::Range<usize>,
    pub middle: std::ops::Range<usize>,
    pub after: std::ops::Range<usize>,
}

/// Refuses a copy-only or malformed plan before any statement runs.
pub(crate) fn runnable(plan: &DesignPlan) -> crate::error::Result<Parts> {
    if matches!(plan.mode, DesignMode::CopyOnly { .. }) {
        return Err(crate::error::Error::InvalidInput(CANNOT_REBUILD.into()));
    }
    let n = plan.statements.len();
    if plan.before + plan.after > n || plan.checks.iter().any(|&c| c >= n) {
        return Err(crate::error::Error::InvalidInput(
            "This plan does not fit its statements. Plan it again.".into(),
        ));
    }
    Ok(Parts {
        before: 0..plan.before,
        middle: plan.before..n - plan.after,
        after: n - plan.after..n,
    })
}

/// `PRAGMA [schema.]foreign_key_check(..)`, lower case.
fn is_foreign_key_check(lower: &str) -> bool {
    lower
        .strip_prefix("pragma")
        .and_then(|rest| rest.find("foreign_key_check").map(|at| &rest[..at]))
        .is_some_and(|schema| {
            let schema = schema.trim();
            schema.is_empty() || schema.ends_with('.')
        })
}

/// The outcome when statement `statement` returned a row: every such statement
/// is a failed check. `first` is the row's first column as text, which for
/// `PRAGMA foreign_key_check` names the table holding the offending row.
pub(crate) fn returned_row(
    plan: &DesignPlan,
    statement: usize,
    ran: usize,
    first: Option<String>,
) -> DesignOutcome {
    let sql = plan.statements[statement].trim_start();
    let check = plan.checks.contains(&statement);
    let lower = sql.to_ascii_lowercase();
    if check
        && ran == 0
        && is_foreign_key_check(&lower)
        && let Some(table) = first.filter(|t| !t.is_empty())
    {
        return DesignOutcome::ForeignKeys { table };
    }
    let message = if check && lower.starts_with("select count(*)") {
        "The copy of the table has a different number of rows than the table.".to_string()
    } else if check {
        format!("This check found rows that do not fit: {sql}")
    } else {
        format!("This statement returned rows, so Contura stopped: {sql}")
    };
    DesignOutcome::Failed {
        statement,
        ran,
        message,
    }
}

/// The error when an `after` statement fails: the person must know both what
/// happened to the change and that the setting was not restored.
pub(crate) fn after_failed(
    outcome: &crate::error::Result<DesignOutcome>,
    sql: &str,
    error: &str,
) -> crate::error::Error {
    let applied = match outcome {
        Ok(DesignOutcome::Done { .. }) => true,
        Ok(DesignOutcome::Failed { ran, .. }) => *ran > 0,
        _ => false,
    };
    crate::error::Error::DesignRestoreFailed {
        applied,
        sql: sql.to_string(),
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::is_foreign_key_check;

    #[test]
    fn foreign_key_check_with_or_without_a_schema() {
        assert!(is_foreign_key_check("pragma foreign_key_check(\"t\")"));
        assert!(is_foreign_key_check(
            "pragma \"main\".foreign_key_check(\"t\")"
        ));
        assert!(!is_foreign_key_check("pragma foreign_keys = on"));
        assert!(!is_foreign_key_check("select 'foreign_key_check'"));
    }
}
