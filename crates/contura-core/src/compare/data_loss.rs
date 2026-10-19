//! Data-loss counts: how many rows a removed table holds, and how many values a
//! removed or narrowed column holds, on the target. Read only: `count(*)` or
//! `count(col)`, each with a statement timeout (2 s), then the server's estimate,
//! shown as "about". The whole pass has a budget (10 s): items left when it
//! runs out get no count.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use super::diff::{DataLoss, DiffItem, DiffKind, DiffObject, ItemId, SchemaDiff};
use crate::common::{sql_ident, sql_string};
use crate::model::{Cell, DialectKind};
use crate::query::{ExecOutcome, SessionHandle};

/// How long one exact count may run before the estimate is read instead.
pub const COUNT_LIMIT: Duration = Duration::from_secs(2);

/// How long the whole count pass may take, about: no count starts past it, and
/// the items left get no count (`dataLoss` stays null). The count running when
/// it ends may wait `CLIENT_GRACE` longer and its estimate `ESTIMATE_FLOOR`, so
/// the pass can end up to about 1.5 s past the budget.
pub const COUNT_BUDGET: Duration = Duration::from_secs(10);

/// PostgreSQL and MySQL stop a count on the server; this much longer the
/// client waits before it cancels the statement itself.
const CLIENT_GRACE: Duration = Duration::from_secs(1);

/// The least time an estimate gets once a count ran out, even at the end of
/// the budget: estimates read catalog statistics and are quick.
const ESTIMATE_FLOOR: Duration = Duration::from_millis(500);

/// PostgreSQL: puts `statement_timeout` back when a count is dropped half way
/// (the compare closed, a Job cancelled), so the session never keeps it.
struct ResetTimeout<'a> {
    session: &'a SessionHandle,
    armed: bool,
}

impl Drop for ResetTimeout<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.session.execute_detached("RESET statement_timeout");
        }
    }
}

/// What one data-loss item counts on the target.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Counted {
    schema: Option<String>,
    table: String,
    /// `None` counts the table's rows; a column counts its non-null values.
    column: Option<String>,
}

/// The table or column a data-loss item counts: a removed table, or a removed or
/// narrowed column. Other items (a PostgreSQL enum losing a value) have no count.
fn counted(item: &DiffItem) -> Option<Counted> {
    if !item.loses_data {
        return None;
    }
    match (item.object, item.kind) {
        (DiffObject::Table, DiffKind::Removed) => Some(Counted {
            schema: item.path.schema.clone(),
            table: item.path.name.clone(),
            column: None,
        }),
        (DiffObject::Column, DiffKind::Removed | DiffKind::Changed) => Some(Counted {
            schema: item.path.schema.clone(),
            table: item.path.table.clone()?,
            column: Some(item.path.name.clone()),
        }),
        _ => None,
    }
}

/// Counts every data-loss item of `diff` on `session`, a query session on the
/// target database. An item whose count and estimate both fail is left out.
pub async fn count_data_loss(
    session: &SessionHandle,
    dialect: DialectKind,
    diff: &SchemaDiff,
) -> HashMap<ItemId, DataLoss> {
    count_data_loss_within(session, dialect, diff, COUNT_LIMIT).await
}

/// [`count_data_loss`] with each exact count limited to `limit`.
pub async fn count_data_loss_within(
    session: &SessionHandle,
    dialect: DialectKind,
    diff: &SchemaDiff,
    limit: Duration,
) -> HashMap<ItemId, DataLoss> {
    count_data_loss_budget(session, dialect, diff, limit, COUNT_BUDGET).await
}

/// [`count_data_loss_within`] with the whole pass limited to `budget`.
pub async fn count_data_loss_budget(
    session: &SessionHandle,
    dialect: DialectKind,
    diff: &SchemaDiff,
    limit: Duration,
    budget: Duration,
) -> HashMap<ItemId, DataLoss> {
    let end = Instant::now() + budget;
    let wanted: Vec<(&ItemId, Counted)> = diff
        .items
        .iter()
        .filter_map(|i| counted(i).map(|c| (&i.id, c)))
        .collect();
    let mut out = HashMap::new();
    if wanted.is_empty() {
        return out;
    }
    for (id, c) in wanted {
        let left = end.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        if let Some(loss) = count_one(session, dialect, &c, limit.min(left), end).await {
            out.insert(id.clone(), loss);
        }
    }
    out
}

/// Puts the counts on their items.
pub fn apply_data_loss(diff: &mut SchemaDiff, counts: &HashMap<ItemId, DataLoss>) {
    for item in &mut diff.items {
        if let Some(loss) = counts.get(&item.id) {
            item.data_loss = Some(*loss);
        }
    }
}

async fn count_one(
    session: &SessionHandle,
    dialect: DialectKind,
    c: &Counted,
    limit: Duration,
    end: Instant,
) -> Option<DataLoss> {
    let table = table_sql(dialect, c);
    let what = match &c.column {
        Some(col) => sql_ident(dialect, col),
        None => "*".to_string(),
    };
    let hint = match dialect {
        DialectKind::MySql => format!("/*+ MAX_EXECUTION_TIME({}) */ ", limit.as_millis().max(1)),
        _ => String::new(),
    };
    let exact = format!("SELECT {hint}COUNT({what}) FROM {table}");
    // SQLite has no statement timeout: the client interrupts the count itself.
    let wait = match dialect {
        DialectKind::Sqlite => limit,
        _ => limit + CLIENT_GRACE,
    };
    let pg = dialect == DialectKind::Postgres;
    let mut reset = ResetTimeout {
        session,
        armed: false,
    };
    if pg {
        // The server's timeout stops the count, and only the count.
        let ms = limit.as_millis().max(1);
        reset.armed = true;
        let _ = session
            .execute(&format!("SET statement_timeout = {ms}"))
            .await;
    }
    let counted = first_number(session, &exact, wait).await;
    if pg {
        // A failed RESET keeps the guard armed, so it is queued again.
        if session.execute("RESET statement_timeout").await.is_ok() {
            reset.armed = false;
        }
    }
    if let Some(rows) = counted {
        return Some(DataLoss { rows, exact: true });
    }
    let estimate = estimate_sql(dialect, c);
    let wait = (COUNT_LIMIT + CLIENT_GRACE).min(
        end.saturating_duration_since(Instant::now())
            .max(ESTIMATE_FLOOR),
    );
    first_number(session, &estimate, wait)
        .await
        .map(|rows| DataLoss { rows, exact: false })
}

fn table_sql(dialect: DialectKind, c: &Counted) -> String {
    match (dialect, &c.schema) {
        (DialectKind::Postgres, Some(s)) => {
            format!("{}.{}", sql_ident(dialect, s), sql_ident(dialect, &c.table))
        }
        _ => sql_ident(dialect, &c.table),
    }
}

/// The server's estimate: PostgreSQL's planner statistics (a column's share of
/// non-null values when it was analysed), MySQL's `TABLE_ROWS`, SQLite's
/// largest rowid. A table PostgreSQL never analysed has no estimate.
fn estimate_sql(dialect: DialectKind, c: &Counted) -> String {
    let lit = |s: &str| sql_string(dialect, s);
    match dialect {
        DialectKind::Postgres => {
            let regclass = lit(&table_sql(dialect, c));
            let share = match (&c.column, &c.schema) {
                (Some(col), Some(schema)) => format!(
                    " * (1 - COALESCE((SELECT s.null_frac FROM pg_stats s \
                     WHERE s.schemaname = {} AND s.tablename = {} AND s.attname = {}), 0))",
                    lit(schema),
                    lit(&c.table),
                    lit(col)
                ),
                _ => String::new(),
            };
            format!(
                "SELECT round(c.reltuples{share})::bigint FROM pg_class c \
                 WHERE c.oid = to_regclass({regclass}) AND c.reltuples >= 0"
            )
        }
        DialectKind::MySql => format!(
            "SELECT TABLE_ROWS FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = {}",
            lit(&c.table)
        ),
        DialectKind::Sqlite => format!(
            "SELECT COALESCE(MAX(rowid), 0) FROM {}",
            table_sql(dialect, c)
        ),
    }
}

/// The first cell of `sql`'s first row as a whole number. After `wait` the
/// statement is cancelled; a failure, a cancel or no row is `None`.
async fn first_number(session: &SessionHandle, sql: &str, wait: Duration) -> Option<u64> {
    let run = session.execute(sql);
    tokio::pin!(run);
    let result = tokio::select! {
        r = &mut run => r,
        _ = tokio::time::sleep(wait) => {
            let _ = session.cancel().await;
            run.await
        }
    };
    let ExecOutcome::Rows { rows, .. } = result.ok()? else {
        return None;
    };
    number(rows.first()?.first()?)
}

fn number(cell: &Cell) -> Option<u64> {
    let text = match cell {
        Cell::Number { value } | Cell::Text { value, .. } => value.trim(),
        _ => return None,
    };
    text.parse::<u64>().ok().or_else(|| {
        text.parse::<f64>()
            .ok()
            .filter(|f| f.is_finite() && *f >= 0.0)
            .map(|f| f.round() as u64)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compare::diff::ItemPath;

    fn item(object: DiffObject, kind: DiffKind, table: Option<&str>, name: &str) -> DiffItem {
        DiffItem {
            id: ItemId(format!("{name}:{kind:?}")),
            kind,
            object,
            path: ItemPath {
                schema: Some("billing".into()),
                table: table.map(str::to_string),
                name: name.into(),
            },
            loses_data: true,
            ..DiffItem::default()
        }
    }

    #[test]
    fn what_each_item_counts() {
        let t = item(DiffObject::Table, DiffKind::Removed, None, "refunds");
        assert_eq!(
            counted(&t),
            Some(Counted {
                schema: Some("billing".into()),
                table: "refunds".into(),
                column: None,
            })
        );
        let c = item(
            DiffObject::Column,
            DiffKind::Removed,
            Some("invoices"),
            "fax",
        );
        assert_eq!(counted(&c).unwrap().column.as_deref(), Some("fax"));
        let narrowed = item(
            DiffObject::Column,
            DiffKind::Changed,
            Some("invoices"),
            "code",
        );
        assert!(counted(&narrowed).is_some());
        let e = item(DiffObject::Enum, DiffKind::Changed, None, "status");
        assert_eq!(counted(&e), None);
        let mut kept = item(
            DiffObject::Column,
            DiffKind::Changed,
            Some("invoices"),
            "note",
        );
        kept.loses_data = false;
        assert_eq!(counted(&kept), None);
    }

    #[test]
    fn count_and_estimate_text() {
        let c = Counted {
            schema: Some("billing".into()),
            table: "invoices".into(),
            column: Some("fax".into()),
        };
        assert_eq!(
            table_sql(DialectKind::Postgres, &c),
            "\"billing\".\"invoices\""
        );
        assert_eq!(table_sql(DialectKind::MySql, &c), "`invoices`");
        let pg = estimate_sql(DialectKind::Postgres, &c);
        assert!(
            pg.contains("to_regclass('\"billing\".\"invoices\"')"),
            "{pg}"
        );
        assert!(pg.contains("s.attname = 'fax'"), "{pg}");
        assert!(estimate_sql(DialectKind::MySql, &c).contains("TABLE_NAME = 'invoices'"));
        assert_eq!(
            estimate_sql(DialectKind::Sqlite, &c),
            "SELECT COALESCE(MAX(rowid), 0) FROM \"invoices\""
        );
    }

    #[test]
    fn numbers_from_cells() {
        assert_eq!(
            number(&Cell::Number {
                value: "18402".into()
            }),
            Some(18402)
        );
        assert_eq!(
            number(&Cell::Text {
                value: "12.6".into(),
                truncated: false,
                total_bytes: 4
            }),
            Some(13)
        );
        assert_eq!(number(&Cell::Null), None);
    }
}
