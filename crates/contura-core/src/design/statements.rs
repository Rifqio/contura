//! A statement list of any length, run the Table Designer's way: the runner of
//! `Dialect::apply_design` without the one-table ties, for the Sync Script.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

use super::{DesignMode, DesignOutcome, DesignPlan, PLAN_MISFIT, is_foreign_key_check};
use crate::error::{Error, Result};
use crate::model::DialectKind;

/// How a statement list runs: `Transaction` on PostgreSQL and SQLite,
/// `Sequential` on MySQL, whose DDL commits each statement.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RunMode {
    Transaction,
    Sequential,
}

/// The exact statements `Dialect::apply_statements` runs, in order.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatementPlan {
    pub statements: Vec<String>,
    pub mode: RunMode,
    /// SQLite: the statements are framed by `sqlite_pragma_frame`. The first runs
    /// before `BEGIN`, the last (the restore) after the transaction whatever
    /// happened, and a row from any `foreign_key_check` rolls back.
    #[serde(default)]
    pub sqlite_pragmas: bool,
}

/// What a run did. `ran == of`: every statement ran. `ran < of`: a cancel stopped
/// it between statements, and `ran` statements stay applied (always 0 where the
/// list ran in a transaction, which rolled back). A failure is an `Err`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunOutcome {
    pub ran: usize,
    pub of: usize,
}

/// Hears the number of statements done so far, before each statement runs.
pub type Progress = Arc<dyn Fn(usize) + Send + Sync>;

/// What a statement run checks before each statement: the cancel flag, and the
/// progress callback that hears "statement n is next" (R4).
#[derive(Clone, Default)]
pub struct RunControl {
    pub cancel: Arc<AtomicBool>,
    pub progress: Option<Progress>,
}

impl RunControl {
    pub fn new(cancel: Arc<AtomicBool>, progress: Option<Progress>) -> Self {
        Self { cancel, progress }
    }

    /// Reports `at` statements done, then whether the cancel was set.
    pub(crate) fn before(&self, at: usize) -> bool {
        if let Some(p) = &self.progress {
            p(at);
        }
        self.cancel.load(Ordering::SeqCst)
    }
}

impl std::fmt::Debug for RunControl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunControl")
            .field("cancel", &self.cancel)
            .field("progress", &self.progress.is_some())
            .finish()
    }
}

const FOREIGN_KEYS_OFF: &str = "PRAGMA foreign_keys = OFF";
const FOREIGN_KEYS_ON: &str = "PRAGMA foreign_keys = ON";
const FOREIGN_KEY_CHECK: &str = "PRAGMA foreign_key_check";

/// The SQLite frame around `body`: Foreign Keys off before the transaction, a
/// `foreign_key_check` of every table at its end, then the setting the
/// Connection has now (`foreign_keys_on`) put back. These lines are shown with
/// the script and run exactly as written.
pub fn sqlite_pragma_frame(body: Vec<String>, foreign_keys_on: bool) -> Vec<String> {
    let mut statements = Vec::with_capacity(body.len() + 3);
    statements.push(FOREIGN_KEYS_OFF.to_string());
    statements.extend(body);
    statements.push(FOREIGN_KEY_CHECK.to_string());
    statements.push(
        if foreign_keys_on {
            FOREIGN_KEYS_ON
        } else {
            FOREIGN_KEYS_OFF
        }
        .to_string(),
    );
    statements
}

/// A 5c rebuild's row-count check (lower case): it returns a row only when the
/// copy holds a different number of rows than the table.
pub(crate) fn is_count_check(lower: &str) -> bool {
    lower.starts_with("select count(*) from") && lower.contains(" except select count(*) from ")
}

/// The design plan the 5c runner takes for `plan` on `kind`. Refuses a mode the
/// Dialect does not run this way, and a SQLite frame that is not
/// `sqlite_pragma_frame`'s, before any statement.
pub(crate) fn design_plan(kind: DialectKind, plan: &StatementPlan) -> Result<DesignPlan> {
    let misfit = || Error::InvalidInput(PLAN_MISFIT.into());
    let mode = match (kind, plan.mode, plan.sqlite_pragmas) {
        (DialectKind::MySql, RunMode::Sequential, false) => DesignMode::Sequential,
        (DialectKind::Postgres, RunMode::Transaction, false)
        | (DialectKind::Sqlite, RunMode::Transaction, _) => DesignMode::Transaction,
        _ => return Err(misfit()),
    };
    let n = plan.statements.len();
    let (frame, foreign_keys) = if plan.sqlite_pragmas {
        let first = plan.statements.first().map(|s| s.trim());
        let last = plan.statements.last().map(|s| s.trim());
        let restored = match last {
            Some(FOREIGN_KEYS_ON) => true,
            Some(FOREIGN_KEYS_OFF) => false,
            _ => return Err(misfit()),
        };
        if n < 2 || first != Some(FOREIGN_KEYS_OFF) {
            return Err(misfit());
        }
        (1, Some(restored))
    } else {
        (0, None)
    };
    let checks = (frame..n - frame)
        .filter(|&at| {
            let lower = plan.statements[at].trim_start().to_ascii_lowercase();
            is_foreign_key_check(&lower) || is_count_check(&lower)
        })
        .collect();
    Ok(DesignPlan {
        statements: plan.statements.clone(),
        warnings: Vec::new(),
        mode,
        before: frame,
        after: frame,
        checks,
        foreign_keys,
        loaded: None,
    })
}

/// The runner's outcome for a list of `of` statements: failures become the
/// errors 5c's service returns.
pub(crate) fn run_outcome(outcome: DesignOutcome, of: usize) -> Result<RunOutcome> {
    match outcome {
        DesignOutcome::Done { ran } | DesignOutcome::Cancelled { ran } => {
            Ok(RunOutcome { ran, of })
        }
        DesignOutcome::Failed {
            statement,
            ran,
            message,
        } => Err(Error::DesignFailed {
            statement,
            ran,
            total: of,
            message,
        }),
        DesignOutcome::ForeignKeys { table } => Err(Error::DesignForeignKeys { table }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(statements: Vec<String>, mode: RunMode, sqlite_pragmas: bool) -> StatementPlan {
        StatementPlan {
            statements,
            mode,
            sqlite_pragmas,
        }
    }

    fn misfit(r: Result<DesignPlan>) {
        match r {
            Err(Error::InvalidInput(m)) => assert_eq!(m, PLAN_MISFIT),
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[test]
    fn each_dialect_takes_its_own_mode() {
        let one = vec!["CREATE TABLE t (id int)".to_string()];
        let seq = plan(one.clone(), RunMode::Sequential, false);
        let tx = plan(one.clone(), RunMode::Transaction, false);
        let my = design_plan(DialectKind::MySql, &seq).unwrap();
        assert_eq!(my.mode, DesignMode::Sequential);
        assert_eq!((my.before, my.after, my.foreign_keys), (0, 0, None));
        let pg = design_plan(DialectKind::Postgres, &tx).unwrap();
        assert_eq!(pg.mode, DesignMode::Transaction);
        assert_eq!(pg.statements, one);
        misfit(design_plan(DialectKind::MySql, &tx));
        misfit(design_plan(DialectKind::Postgres, &seq));
        misfit(design_plan(DialectKind::Sqlite, &seq));
        let framed = plan(one.clone(), RunMode::Transaction, true);
        misfit(design_plan(DialectKind::Postgres, &framed));
    }

    #[test]
    fn the_sqlite_frame_is_before_checks_and_after() {
        let body = vec![
            "CREATE TABLE t (id int)".to_string(),
            "PRAGMA \"main\".foreign_key_check(\"t\")".to_string(),
        ];
        let counted = plan(
            sqlite_pragma_frame(
                vec![
                    "INSERT INTO n SELECT * FROM t".to_string(),
                    "SELECT count(*) FROM t EXCEPT SELECT count(*) FROM n".to_string(),
                ],
                true,
            ),
            RunMode::Transaction,
            true,
        );
        assert_eq!(
            design_plan(DialectKind::Sqlite, &counted).unwrap().checks,
            [2, 3]
        );
        let p = plan(
            sqlite_pragma_frame(body.clone(), true),
            RunMode::Transaction,
            true,
        );
        let d = design_plan(DialectKind::Sqlite, &p).unwrap();
        assert_eq!((d.before, d.after), (1, 1));
        assert_eq!(d.checks, [2, 3]);
        assert_eq!(d.foreign_keys, Some(true));
        let off = plan(
            sqlite_pragma_frame(body.clone(), false),
            RunMode::Transaction,
            true,
        );
        assert_eq!(
            design_plan(DialectKind::Sqlite, &off).unwrap().foreign_keys,
            Some(false)
        );
        misfit(design_plan(
            DialectKind::Sqlite,
            &plan(body, RunMode::Transaction, true),
        ));
        misfit(design_plan(
            DialectKind::Sqlite,
            &plan(vec![FOREIGN_KEYS_OFF.into()], RunMode::Transaction, true),
        ));
    }

    #[test]
    fn outcomes_become_counts_or_errors() {
        assert_eq!(
            run_outcome(DesignOutcome::Done { ran: 3 }, 3).unwrap(),
            RunOutcome { ran: 3, of: 3 }
        );
        assert_eq!(
            run_outcome(DesignOutcome::Cancelled { ran: 1 }, 3).unwrap(),
            RunOutcome { ran: 1, of: 3 }
        );
        match run_outcome(
            DesignOutcome::Failed {
                statement: 4,
                ran: 4,
                message: "no".into(),
            },
            9,
        ) {
            Err(Error::DesignFailed {
                statement: 4,
                ran: 4,
                total: 9,
                message,
            }) => assert_eq!(message, "no"),
            other => panic!("got {other:?}"),
        }
        assert!(matches!(
            run_outcome(DesignOutcome::ForeignKeys { table: "c".into() }, 2),
            Err(Error::DesignForeignKeys { table }) if table == "c"
        ));
    }
}
