//! `run_transfer`: runs a `TransferPlan`. Each ticked table is read by step 7's
//! `RowSource` (its own consistent snapshot, R8) and written through one `BulkWriter`
//! on the target as multi-row INSERTs, with the plan's per-column conversions. A table
//! is never collected: rows go chunk by chunk from the reader's channel to the writer.
//!
//! PostgreSQL and SQLite targets run the whole plan in one transaction. MySQL runs the
//! structure first (DDL commits by itself), then each table's rows in a transaction of
//! their own (tables of one Foreign Key group together, with checks off and an orphan
//! check before COMMIT), then the indexes.

use serde::Serialize;

use super::coerce::{Conversion, coerce};
use super::plan::{RowCopy, Side, TransferMode, TransferPlan};
use super::types::parse_type;
use crate::common::grouped;
use crate::dialect::Dialect;
use crate::error::{Error, Result};
use crate::jobs::insert::{InsertBuilder, InsertLimits, conversion_for};
use crate::jobs::source::{SourceRequest, Value};
use crate::jobs::types::JobPosition;
use crate::jobs::writer::{BulkWriter, WriterSetup};
use crate::model::{DialectKind, ObjectPath};

/// Where the run reports to and asks whether to stop. The Job service adapts its
/// `JobCtx` to this (it already sends at most every 100 ms).
pub trait TransferObserver: Send + Sync {
    fn progress(&self, p: &TransferProgress);
    fn cancelled(&self) -> bool;
    /// What stayed on a MySQL target when the run was cancelled.
    fn warning(&self, text: &str);
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    /// The table being copied (source name).
    pub table: String,
    pub table_rows: u64,
    pub table_total: Option<u64>,
    /// All tables so far.
    pub rows: u64,
    pub total: Option<u64>,
    pub tables_done: usize,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TableState {
    Done,
    Failed,
    RolledBack,
    NotStarted,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableOutcome {
    pub table: String,
    pub rows_read: u64,
    pub rows_written: u64,
    pub state: TableState,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferOutcome {
    pub tables: Vec<TableOutcome>,
    pub rows: u64,
    /// `Some(true)` when every table's count was checked and matched.
    pub counts_match: Option<bool>,
}

/// The two Connections a run reads from and writes to.
pub struct RunSides<'a> {
    pub source: &'a dyn Dialect,
    pub source_side: &'a Side,
    pub target: &'a dyn Dialect,
    pub target_side: &'a Side,
    /// The target Connection's name, for messages.
    pub target_name: &'a str,
}

/// Runs `plan`. `Err` means the run stopped; what stayed is in the error's text (or, for
/// a MySQL cancel, in the observer's warning).
pub async fn run_transfer(
    plan: &TransferPlan,
    sides: RunSides<'_>,
    batch_rows: u32,
    compare_counts: bool,
    obs: &dyn TransferObserver,
) -> Result<TransferOutcome> {
    if let Some(first) = plan.blocked.first() {
        return Err(Error::InvalidInput(format!(
            "A column still needs a choice: {first}"
        )));
    }
    let totals = if compare_counts {
        let mut t = Vec::with_capacity(plan.copies.len());
        for c in &plan.copies {
            t.push(Some(source_count(&sides, plan.source_dialect, c).await?));
        }
        t
    } else {
        vec![None; plan.copies.len()]
    };
    let total: Option<u64> = totals.iter().copied().sum();

    let dst = plan.target_dialect;
    // A plan that creates the MySQL database opens without one; its USE follows.
    let creates_database = plan
        .structure
        .first()
        .is_some_and(|s| s.starts_with("CREATE DATABASE"));
    let database = match dst {
        DialectKind::Sqlite => None,
        DialectKind::MySql if creates_database => None,
        _ => Some(sides.target_side.database.as_str()),
    };
    let setup = WriterSetup {
        before: match dst {
            DialectKind::MySql => vec![
                // A value that does not fit fails instead of being cut; a copied id of 0
                // stays 0. Never INSERT IGNORE.
                "SET SESSION sql_mode = CONCAT_WS(',', @@SESSION.sql_mode, 'STRICT_ALL_TABLES', 'NO_AUTO_VALUE_ON_ZERO')".into(),
            ],
            _ => Vec::new(),
        },
        after: Vec::new(),
    };
    let mut writer = sides.target.open_bulk_writer(database, &setup).await?;
    let mut run = Run {
        plan,
        sides: &sides,
        batch_rows,
        compare_counts,
        obs,
        totals,
        total,
        rows: 0,
        created: 0,
        copied: 0,
        outcomes: plan
            .copies
            .iter()
            .map(|c| TableOutcome {
                table: c.table.clone(),
                rows_read: 0,
                rows_written: 0,
                state: TableState::NotStarted,
            })
            .collect(),
    };
    let result = match plan.mode {
        TransferMode::OneTransaction => run.one_transaction(writer.as_mut()).await,
        TransferMode::PerTable => run.per_table(writer.as_mut()).await,
    };
    writer.close().await;
    result?;
    Ok(TransferOutcome {
        counts_match: compare_counts.then_some(true),
        rows: run.rows,
        tables: run.outcomes,
    })
}

async fn source_count(sides: &RunSides<'_>, src: DialectKind, copy: &RowCopy) -> Result<u64> {
    let sql = format!("SELECT count(*) FROM {}", copy.source_sql);
    let mut s = sides
        .source
        .open_row_source(&SourceRequest::Query {
            database: match src {
                DialectKind::MySql => Some(sides.source_side.database.clone()),
                _ => None,
            },
            sql,
        })
        .await?;
    let mut n = 0;
    while let Some(chunk) = s.next_chunk().await? {
        if let Some(Value::Number(v) | Value::Text(v)) = chunk.rows.first().and_then(|r| r.first())
        {
            n = v.trim().parse().unwrap_or(0);
        }
    }
    Ok(n)
}

fn count_sql(dst: DialectKind, table_sql: &str) -> String {
    match dst {
        DialectKind::Postgres => format!("SELECT count(*)::text FROM {table_sql}"),
        DialectKind::MySql => format!("SELECT CAST(count(*) AS CHAR) FROM {table_sql}"),
        DialectKind::Sqlite => format!("SELECT count(*) FROM {table_sql}"),
    }
}

async fn target_count(w: &mut dyn BulkWriter, dst: DialectKind, table_sql: &str) -> Result<u64> {
    Ok(w.first_value(&count_sql(dst, table_sql))
        .await?
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0))
}

/// "3 tables were created and 2 were copied", with one table said as one.
fn what_stays(created: usize, copied: usize) -> String {
    let tables = if created == 1 {
        "1 table was".to_string()
    } else {
        format!("{created} tables were")
    };
    let copied = if copied == 1 {
        "1 was".to_string()
    } else {
        format!("{copied} were")
    };
    format!("{tables} created and {copied} copied")
}

/// A row the target could not take: the error names the row; the run adds what
/// happened to the target.
fn row_failed(table: &str, row: u64, key: &str, why: &str) -> Error {
    Error::JobFailed {
        at: JobPosition {
            file_row: Some(row),
            table: Some(table.to_string()),
            ..Default::default()
        },
        message: format!("{table}, row {}{key}: {why}.", grouped(row)),
    }
}

fn server_text(e: &Error) -> String {
    let text = match e {
        Error::Query(m) => m.clone(),
        other => other.to_string(),
    };
    text.trim_end_matches('.').to_string()
}

const BATCH_SAVEPOINT: &str = "contura_batch";
const ROW_SAVEPOINT: &str = "contura_row";

struct Run<'a> {
    plan: &'a TransferPlan,
    sides: &'a RunSides<'a>,
    batch_rows: u32,
    compare_counts: bool,
    obs: &'a dyn TransferObserver,
    totals: Vec<Option<u64>>,
    total: Option<u64>,
    rows: u64,
    /// MySQL: tables created, and tables whose rows were committed, so far.
    created: usize,
    copied: usize,
    outcomes: Vec<TableOutcome>,
}

impl Run<'_> {
    fn check_cancel(&self) -> Result<()> {
        if self.obs.cancelled() {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }

    /// Adds the target's outcome to a row failure.
    fn with_outcome(&self, e: Error) -> Error {
        match e {
            Error::JobFailed { at, message } if at.file_row.is_some() => {
                let tail = match self.plan.mode {
                    TransferMode::OneTransaction => format!(
                        "The transaction rolled back, so {} is as it was.",
                        self.sides.target_name
                    ),
                    TransferMode::PerTable => format!(
                        "{} before the failure. They stay on {}.",
                        what_stays(self.created, self.copied),
                        self.sides.target_name
                    ),
                };
                Error::JobFailed {
                    at,
                    message: format!("{message} {tail}"),
                }
            }
            other => other,
        }
    }

    /// PostgreSQL and SQLite: everything in one transaction; any failure rolls it back.
    async fn one_transaction(&mut self, w: &mut dyn BulkWriter) -> Result<()> {
        let plan = self.plan;
        // SQLite pragmas do nothing inside a transaction, so they run before BEGIN; the
        // connection's own setting is put back after.
        let (pragmas, structure): (Vec<&String>, Vec<&String>) = plan
            .structure
            .iter()
            .partition(|s| s.starts_with("PRAGMA "));
        let restore = if pragmas.is_empty() {
            None
        } else {
            w.first_value("PRAGMA foreign_keys").await?
        };
        for s in pragmas {
            w.run(s).await?;
        }
        w.begin().await?;
        let result = self.one_transaction_body(w, &structure).await;
        let ended = match result {
            Ok(()) => w.commit().await,
            Err(e) => {
                let _ = w.rollback().await;
                for o in &mut self.outcomes {
                    if o.state == TableState::Done {
                        o.state = TableState::RolledBack;
                    }
                }
                Err(self.with_outcome(e))
            }
        };
        if let Some(prior) = restore {
            let _ = w
                .run(&format!("PRAGMA foreign_keys = {}", prior.trim()))
                .await;
        }
        ended
    }

    async fn one_transaction_body(
        &mut self,
        w: &mut dyn BulkWriter,
        structure: &[&String],
    ) -> Result<()> {
        let plan = self.plan;
        for s in structure {
            self.check_cancel()?;
            w.run(s).await?;
        }
        for i in 0..plan.copies.len() {
            self.check_cancel()?;
            self.copy_table(w, i).await?;
        }
        for s in &plan.after_rows {
            self.check_cancel()?;
            if s.starts_with("PRAGMA foreign_key_check") {
                if let Some(table) = w.first_value(s).await? {
                    return Err(Error::JobFailed {
                        at: JobPosition {
                            table: Some(table.clone()),
                            ..Default::default()
                        },
                        message: format!(
                            "{table} has rows whose Foreign Key points to no row. The transaction rolled back, so {} is as it was.",
                            self.sides.target_name
                        ),
                    });
                }
            } else {
                w.run(s).await?;
            }
        }
        Ok(())
    }

    /// MySQL: the structure commits as it runs; each table's rows (or each Foreign Key
    /// group's) in their own transaction; then the indexes.
    async fn per_table(&mut self, w: &mut dyn BulkWriter) -> Result<()> {
        let result = self.per_table_body(w).await;
        match result {
            Err(Error::Cancelled) => {
                self.obs.warning(&format!(
                    "{} before you cancelled. They stay on {}.",
                    what_stays(self.created, self.copied),
                    self.sides.target_name
                ));
                Err(Error::Cancelled)
            }
            Err(e) => Err(self.with_outcome(e)),
            Ok(()) => Ok(()),
        }
    }

    async fn per_table_body(&mut self, w: &mut dyn BulkWriter) -> Result<()> {
        let plan = self.plan;
        for s in plan
            .structure
            .iter()
            .filter(|s| !s.starts_with("DELETE FROM "))
        {
            self.check_cancel()?;
            w.run(s).await?;
            if s.starts_with("CREATE TABLE ") {
                self.created += 1;
            }
        }
        let mut done = vec![false; plan.copies.len()];
        for i in 0..plan.copies.len() {
            if done[i] {
                continue;
            }
            self.check_cancel()?;
            // The tables loaded with this one: its Foreign Key group, or itself.
            let group: Option<&Vec<String>> = plan
                .fk_groups
                .iter()
                .find(|g| g.contains(&plan.copies[i].table));
            let members: Vec<usize> = match group {
                Some(g) => (0..plan.copies.len())
                    .filter(|&j| g.contains(&plan.copies[j].table))
                    .collect(),
                None => vec![i],
            };
            if group.is_some() {
                w.run("SET foreign_key_checks = 0").await?;
            }
            let loaded = self.load_group(w, &members, group.is_some()).await;
            if group.is_some() {
                // Back on before anything else runs on this connection, whatever happened.
                let _ = w.run("SET foreign_key_checks = 1").await;
            }
            loaded?;
            for &j in &members {
                done[j] = true;
            }
        }
        for s in &plan.after_rows {
            self.check_cancel()?;
            w.run(s).await?;
        }
        Ok(())
    }

    /// One MySQL transaction for `members`: Empty it first, the rows, the orphan checks of
    /// a Foreign Key group, COMMIT. A failure rolls the transaction back.
    async fn load_group(
        &mut self,
        w: &mut dyn BulkWriter,
        members: &[usize],
        keyed: bool,
    ) -> Result<()> {
        let plan = self.plan;
        w.begin().await?;
        let body = async {
            // A group empties its tables child first, as Review SQL lists them, then loads.
            for &j in members.iter().rev() {
                if let Some(d) = &plan.copies[j].delete {
                    w.run(d).await?;
                }
            }
            for &j in members {
                self.copy_table(w, j).await?;
            }
            if keyed {
                let tables: Vec<&str> = members
                    .iter()
                    .map(|&j| plan.copies[j].table.as_str())
                    .collect();
                for check in &plan.orphan_checks {
                    if !tables.contains(&check.source_table.as_str()) {
                        continue;
                    }
                    let n: u64 = w
                        .first_value(&check.count_sql)
                        .await?
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    if n > 0 {
                        let sample = w.first_value(&check.sample_sql).await?.unwrap_or_default();
                        return Err(Error::JobFailed {
                            at: JobPosition {
                                table: Some(check.table.clone()),
                                ..Default::default()
                            },
                            message: format!(
                                "{}.{} has {} values with no row in {}, for example {sample}. The table's rows were rolled back.",
                                check.table,
                                check.columns[0],
                                grouped(n),
                                check.parent
                            ),
                        });
                    }
                }
            }
            Ok(())
        }
        .await;
        match body {
            Ok(()) => {
                w.commit().await?;
                self.copied += members.len();
                Ok(())
            }
            Err(e) => {
                let _ = w.rollback().await;
                for &j in members {
                    if self.outcomes[j].state == TableState::Done {
                        self.outcomes[j].state = TableState::RolledBack;
                    }
                }
                Err(e)
            }
        }
    }

    /// Copies table `i`: reads its rows, converts them, writes them as INSERTs, then
    /// checks the count when asked.
    async fn copy_table(&mut self, w: &mut dyn BulkWriter, i: usize) -> Result<()> {
        let plan = self.plan;
        let copy = &plan.copies[i];
        let src = plan.source_dialect;
        let dst = plan.target_dialect;
        let before = if self.compare_counts {
            target_count(w, dst, &copy.target_sql).await?
        } else {
            0
        };
        let mut reader = self
            .sides
            .source
            .open_row_source(&SourceRequest::Table {
                path: ObjectPath {
                    database: self.sides.source_side.database.clone(),
                    schema: self.sides.source_side.schema.clone(),
                    name: copy.table.clone(),
                },
                columns: copy.columns.iter().map(|c| c.source.clone()).collect(),
                filter: None,
                sort: None,
                keys: Vec::new(),
            })
            .await?;
        let kinds: Vec<_> = reader.columns().iter().map(|c| c.kind).collect();
        let conversions: Vec<Conversion> = copy
            .columns
            .iter()
            .zip(&kinds)
            .map(|(c, k)| coerce(src, *k, dst, &parse_type(&c.target_type)))
            .collect();
        let keys: Vec<usize> = copy
            .key_columns
            .iter()
            .filter_map(|k| copy.columns.iter().position(|c| &c.source == k))
            .collect();
        let writer = Statements::new(dst, copy, self.batch_rows, w.statement_limit());
        let mut builder = writer.builder();
        // The rows of the statement still open, to name a row the server refuses.
        let mut open: Vec<(u64, Vec<Value>)> = Vec::new();
        let mut read = 0u64;
        let mut written = 0u64;
        while let Some(chunk) = reader.next_chunk().await? {
            self.check_cancel()?;
            for row in chunk.rows {
                read += 1;
                let key = key_text(copy, &keys, &row);
                let mut converted = Vec::with_capacity(row.len());
                for ((v, conv), col) in row.into_iter().zip(&conversions).zip(&copy.columns) {
                    converted.push(conv.apply(&col.target, v).map_err(|f| {
                        row_failed(
                            &copy.table,
                            read,
                            &key,
                            &format!("{} in {}", f.reason, f.column),
                        )
                    })?);
                }
                let built = builder
                    .push(&converted, read)
                    .map_err(|e| row_failed(&copy.table, read, &key, &server_text(&e)))?;
                // The closed statement holds exactly the rows in `open`; this row starts
                // the next one.
                if let Some(stmt) = built {
                    written += writer
                        .write(w, &stmt.sql, std::mem::take(&mut open), &keys)
                        .await?;
                }
                open.push((read, converted));
            }
            self.outcomes[i].rows_read = read;
            self.outcomes[i].rows_written = written;
            self.report(i, read);
        }
        if let Some(stmt) = builder.finish() {
            written += writer
                .write(w, &stmt.sql, std::mem::take(&mut open), &keys)
                .await?;
        }
        self.outcomes[i].rows_read = read;
        self.outcomes[i].rows_written = written;
        self.rows += read;
        self.report(i, read);

        if self.compare_counts {
            let after = target_count(w, dst, &copy.target_sql).await?;
            let landed = after.saturating_sub(before);
            if landed != read {
                self.outcomes[i].state = TableState::Failed;
                let tail = match plan.mode {
                    TransferMode::OneTransaction => "The transaction rolled back.",
                    TransferMode::PerTable => "The rows written stay.",
                };
                return Err(Error::JobFailed {
                    at: JobPosition {
                        table: Some(copy.table.clone()),
                        ..Default::default()
                    },
                    message: format!(
                        "{}: {} rows read, {} written. {tail}",
                        copy.table,
                        grouped(read),
                        grouped(landed)
                    ),
                });
            }
        }
        self.outcomes[i].state = TableState::Done;
        Ok(())
    }

    fn report(&self, i: usize, table_rows: u64) {
        self.obs.progress(&TransferProgress {
            table: self.plan.copies[i].table.clone(),
            table_rows,
            table_total: self.totals[i],
            rows: self.rows
                + if self.outcomes[i].state == TableState::Done {
                    0
                } else {
                    table_rows
                },
            total: self.total,
            tables_done: self
                .outcomes
                .iter()
                .filter(|o| o.state == TableState::Done)
                .count(),
        });
    }
}

/// `, id 88123` for a row of a table with a primary key.
fn key_text(copy: &RowCopy, keys: &[usize], row: &[Value]) -> String {
    let parts: Vec<String> = keys
        .iter()
        .map(|&k| {
            let v = match &row[k] {
                Value::Null => "NULL".to_string(),
                Value::Number(s) | Value::Text(s) => s.clone(),
                Value::Bool(b) => b.to_string(),
                Value::Bytes(b) => format!("{} bytes", b.len()),
            };
            format!("{} {v}", copy.columns[k].source)
        })
        .collect();
    if parts.is_empty() {
        String::new()
    } else {
        format!(", {}", parts.join(", "))
    }
}

/// How one table's INSERTs are built and written.
struct Statements<'a> {
    dst: DialectKind,
    copy: &'a RowCopy,
    limits: InsertLimits,
}

impl<'a> Statements<'a> {
    fn new(dst: DialectKind, copy: &'a RowCopy, batch_rows: u32, statement_limit: usize) -> Self {
        Statements {
            dst,
            copy,
            limits: InsertLimits {
                rows: batch_rows.max(1) as usize,
                bytes: InsertLimits::default().bytes.min(statement_limit),
            },
        }
    }

    fn builder(&self) -> InsertBuilder {
        let targets: Vec<String> = self.copy.columns.iter().map(|c| c.target.clone()).collect();
        let rules = self
            .copy
            .columns
            .iter()
            .map(|c| conversion_for(self.dst, &c.target_type))
            .collect();
        InsertBuilder::new(
            self.dst,
            self.copy.target_sql.clone(),
            &targets,
            rules,
            self.limits,
            self.copy.overriding,
        )
    }

    /// Runs one multi-row INSERT inside a savepoint. When the server refuses it, the
    /// rows are run one by one to find the one it refuses, which names the error.
    async fn write(
        &self,
        w: &mut dyn BulkWriter,
        sql: &str,
        rows: Vec<(u64, Vec<Value>)>,
        keys: &[usize],
    ) -> Result<u64> {
        w.savepoint(BATCH_SAVEPOINT).await?;
        match w.run(sql).await {
            Ok(n) => {
                w.release(BATCH_SAVEPOINT).await?;
                Ok(n)
            }
            Err(batch_error) => {
                w.rollback_to(BATCH_SAVEPOINT).await?;
                for (row, values) in &rows {
                    let mut one = self.builder();
                    let Ok(Some(stmt)) = one.push(values, *row).map(|_| one.finish()) else {
                        continue;
                    };
                    w.savepoint(ROW_SAVEPOINT).await?;
                    match w.run(&stmt.sql).await {
                        Ok(_) => w.rollback_to(ROW_SAVEPOINT).await?,
                        Err(e) => {
                            w.rollback_to(ROW_SAVEPOINT).await?;
                            return Err(row_failed(
                                &self.copy.table,
                                *row,
                                &key_text(self.copy, keys, values),
                                &server_text(&e),
                            ));
                        }
                    }
                }
                Err(batch_error)
            }
        }
    }
}
