//! The Schema Compare service (step 10): compare, DDL panes, plan, confirm and
//! apply. Every call reads both sides fresh (the snapshots, the model from the
//! request, `table_design` of the target tables) and runs `diff` and `plan_sync`
//! again from the request, so the script shown, the Production pass and the run
//! cover the same statements. Only the selection and the hash come from the UI,
//! never a statement. Compare, DDL and plan only read, on any Connection.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::{ConnectionService, PassScope, close_handle, now_ms, plain_message};
use crate::compare::{
    CompareOptions, CompareSummary, DiffItem, DiffKind, DiffObject, ItemId, NotCompared,
    SchemaDiff, SyncMode, SyncPlan, SyncVerdict, TargetDesigns, apply_data_loss, count_data_loss,
    diff, plan_sync,
};
use crate::ddl::{self, DdlOptions};
use crate::design::{Progress, RunControl};
use crate::dialect::Dialect;
use crate::error::{Error, Result};
use crate::jobs::JobSink;
use crate::jobs::types::{JobId, JobKind, JobPhase, JobProgress, JobReport};
use crate::model::{Cell, ConnectionConfig, ConnectionId, DialectKind, ObjectPath};
use crate::query::{ExecOutcome, NewHistory, Outcome};
use crate::safety::PassId;
use crate::schema_model::SchemaModel;

/// One side read from a database: a MySQL database, a PostgreSQL database and
/// schema, SQLite's `main`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompareDatabase {
    #[serde(default)]
    pub connection_id: ConnectionId,
    #[serde(default)]
    pub database: String,
    /// PostgreSQL: the schema compared; `None` elsewhere.
    #[serde(default)]
    pub schema: Option<String>,
}

/// The source: a database, or a Schema Model as the UI parsed it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CompareSide {
    Database {
        #[serde(default)]
        connection_id: ConnectionId,
        #[serde(default)]
        database: String,
        #[serde(default)]
        schema: Option<String>,
    },
    Model {
        model: SchemaModel,
        /// The model file, for naming only.
        #[serde(default)]
        path: Option<String>,
    },
}

/// The target is always a database: the Sync Script changes it to match the source.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompareRequest {
    pub source: CompareSide,
    pub target: CompareDatabase,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompareResult {
    pub dialect: DialectKind,
    pub items: Vec<DiffItem>,
    pub not_compared: NotCompared,
    pub summary: CompareSummary,
    /// When the snapshots were read, in Unix milliseconds.
    pub compared_at_ms: i64,
}

/// One table's (or enum's) DDL on each side, by the same writer; `None` where
/// it is missing.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DdlPair {
    pub source: Option<String>,
    pub target: Option<String>,
}

/// What Apply did. A failure is an error instead.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    /// The statements that ran.
    pub applied: usize,
    pub elapsed_ms: u64,
    /// The target tables a statement changed or dropped.
    pub tables: Vec<ObjectPath>,
}

/// Everything a compare and a plan are built from, read fresh.
struct Sides {
    target: ConnectionConfig,
    target_db: Arc<dyn Dialect>,
    source: SchemaModel,
    target_model: SchemaModel,
    opts: CompareOptions,
}

impl Sides {
    fn diff(&self) -> SchemaDiff {
        diff(&self.source, &self.target_model, &self.opts)
    }
}

fn dialect_label(d: DialectKind) -> &'static str {
    match d {
        DialectKind::MySql => "MySQL",
        DialectKind::Postgres => "PostgreSQL",
        DialectKind::Sqlite => "SQLite",
    }
}

/// The spec's refusal of two Dialects.
fn dialect_mismatch(source: &str, sd: DialectKind, target: &str, td: DialectKind) -> Error {
    Error::InvalidInput(format!(
        "{source} is {} and {target} is {}. Schema Compare needs the same Dialect; use Data \
         Transfer to copy across Dialects.",
        dialect_label(sd),
        dialect_label(td)
    ))
}

/// The refusal of the same database (and schema) on both sides.
pub const SAME_SIDE: &str = "Source and target are the same. Pick another target.";

/// The model file's name, or what stands for it before a first save.
fn model_name(path: Option<&str>) -> String {
    path.and_then(|p| {
        std::path::Path::new(p)
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_string)
    })
    .unwrap_or_else(|| "The Schema Model".to_string())
}

/// The target's scope for a Sync pass: its database and schema.
fn sync_scope(req: &CompareRequest) -> PassScope {
    PassScope::Sync(
        req.target.connection_id,
        ObjectPath {
            database: req.target.database.clone(),
            schema: req.target.schema.clone(),
            name: String::new(),
        },
    )
}

/// The table of an item, or the enum's name.
fn item_table(item: &DiffItem) -> String {
    item.path
        .table
        .clone()
        .unwrap_or_else(|| item.path.name.clone())
}

/// A not-scriptable item reached through a dependency of a picked one is
/// refused before planning, naming the item and its reason (spec, Errors).
fn refuse_unscriptable_needs(plan: &SyncPlan, picked: &[ItemId]) -> Result<()> {
    let by_id: std::collections::BTreeMap<&ItemId, &crate::compare::SyncItem> =
        plan.items.iter().map(|i| (&i.id, i)).collect();
    for p in picked {
        let Some(start) = by_id.get(p) else { continue };
        let mut seen: BTreeSet<&ItemId> = BTreeSet::new();
        let mut todo: Vec<&ItemId> = start.needs.iter().collect();
        while let Some(n) = todo.pop() {
            if !seen.insert(n) {
                continue;
            }
            let Some(need) = by_id.get(n) else { continue };
            if let Some(reason) = &need.not_scriptable {
                return Err(Error::InvalidInput(format!(
                    "{} needs {}: {reason}",
                    start.line, need.line
                )));
            }
            todo.extend(need.needs.iter());
        }
    }
    Ok(())
}

/// The same error again, for the job's final event and the command's result.
fn copy_error(e: &Error) -> Error {
    match e {
        Error::DesignFailed {
            statement,
            ran,
            total,
            message,
        } => Error::DesignFailed {
            statement: *statement,
            ran: *ran,
            total: *total,
            message: message.clone(),
        },
        Error::DesignForeignKeys { table } => Error::DesignForeignKeys {
            table: table.clone(),
        },
        Error::Cancelled | Error::SyncCancelled { .. } => Error::Cancelled,
        Error::ReadOnlyRefused => Error::ReadOnlyRefused,
        Error::InvalidInput(m) => Error::InvalidInput(m.clone()),
        Error::Connect(m) => Error::Connect(m.clone()),
        other => Error::Query(plain_message(other)),
    }
}

/// The DDL of one table (or enum) of `model`, by the `ddl` writer, schema left
/// out so both sides' lines align.
fn ddl_of(model: &SchemaModel, name: &str) -> Option<String> {
    let find = |exact: bool| {
        model.tables.iter().find(|t| {
            if exact {
                t.name == name
            } else {
                t.name.eq_ignore_ascii_case(name)
            }
        })
    };
    let one = |mut single: SchemaModel| -> Option<String> {
        for t in &mut single.tables {
            t.schema = None;
        }
        for e in &mut single.enums {
            e.schema = None;
        }
        for r in &mut single.refs {
            r.from.schema = None;
            r.to.schema = None;
        }
        let parts = ddl::parts(&single, &DdlOptions::default()).ok()?;
        let all: Vec<String> = parts
            .types
            .into_iter()
            .chain(parts.tables)
            .chain(parts.indexes)
            .collect();
        Some(all.join("\n"))
    };
    if let Some(t) = find(true).or_else(|| find(false)) {
        let refs = model
            .refs
            .iter()
            .filter(|r| r.from.table == t.name && r.from.schema == t.schema)
            .cloned()
            .collect();
        return one(SchemaModel {
            dialect: model.dialect,
            tables: vec![t.clone()],
            refs,
            enums: Vec::new(),
            skipped: Vec::new(),
        });
    }
    let e = model.enums.iter().find(|e| e.name == name).or_else(|| {
        model
            .enums
            .iter()
            .find(|e| e.name.eq_ignore_ascii_case(name))
    })?;
    if model.dialect != DialectKind::Postgres {
        return None;
    }
    one(SchemaModel {
        dialect: model.dialect,
        tables: Vec::new(),
        refs: Vec::new(),
        enums: vec![e.clone()],
        skipped: Vec::new(),
    })
}

/// A plan's statements as Query History keeps them.
fn history_sql(statements: &[String]) -> String {
    statements.join(";\n")
}

impl ConnectionService {
    /// Reads both sides fresh. Refuses another Dialect and the same side.
    async fn compare_sides(&self, req: &CompareRequest) -> Result<Sides> {
        let target = self.config(req.target.connection_id)?;
        let (source, source_schema) = match &req.source {
            CompareSide::Database {
                connection_id,
                database,
                schema,
            } => {
                let config = self.config(*connection_id)?;
                if config.dialect != target.dialect {
                    return Err(dialect_mismatch(
                        &config.name,
                        config.dialect,
                        &target.name,
                        target.dialect,
                    ));
                }
                if *connection_id == target.id
                    && *database == req.target.database
                    && *schema == req.target.schema
                {
                    return Err(Error::InvalidInput(SAME_SIDE.into()));
                }
                let db = self.session(*connection_id).await?;
                let model = db.schema_snapshot(database, schema.as_deref()).await?;
                (model, schema.clone())
            }
            CompareSide::Model { model, path } => {
                if model.dialect != target.dialect {
                    return Err(dialect_mismatch(
                        &model_name(path.as_deref()),
                        model.dialect,
                        &target.name,
                        target.dialect,
                    ));
                }
                // A model table in another schema is not compared (CompareOptions).
                (model.clone(), req.target.schema.clone())
            }
        };
        let target_db = self.session(target.id).await?;
        let target_model = target_db
            .schema_snapshot(&req.target.database, req.target.schema.as_deref())
            .await?;
        let lower_case_table_names = if target.dialect == DialectKind::MySql {
            lower_case_table_names(target_db.as_ref(), &req.target.database).await
        } else {
            0
        };
        Ok(Sides {
            opts: CompareOptions {
                source_schema,
                target_schema: req.target.schema.clone(),
                lower_case_table_names,
            },
            target,
            target_db,
            source,
            target_model,
        })
    }

    /// `table_design` of every target table an item touches, and every table and
    /// index name in the target schema (`taken_names`).
    async fn target_designs(
        &self,
        req: &CompareRequest,
        sides: &Sides,
        d: &SchemaDiff,
    ) -> TargetDesigns {
        let target = &sides.target_model;
        let mut names: BTreeSet<String> = BTreeSet::new();
        for i in d.items.iter().filter(|i| i.object != DiffObject::Enum) {
            let t = item_table(i);
            if let Some(found) = target.tables.iter().find(|x| x.name == t).or_else(|| {
                target
                    .tables
                    .iter()
                    .find(|x| x.name.eq_ignore_ascii_case(&t))
            }) {
                names.insert(found.name.clone());
            }
        }
        let mut tables = Vec::new();
        for name in names {
            let path = ObjectPath {
                database: req.target.database.clone(),
                schema: req.target.schema.clone(),
                name,
            };
            // A table that cannot be read leaves its items not scriptable (plan_sync).
            if let Ok(design) = sides.target_db.table_design(&path).await {
                tables.push(design);
            }
        }
        let mut taken: BTreeSet<String> = BTreeSet::new();
        for t in &target.tables {
            taken.insert(t.name.clone());
            taken.extend(t.indexes.iter().filter_map(|i| i.name.clone()));
        }
        for t in &tables {
            taken.extend(t.indexes.iter().map(|i| i.name.clone()));
        }
        TargetDesigns {
            database: req.target.database.clone(),
            tables,
            taken_names: taken.into_iter().collect(),
        }
    }

    /// The plan for `selection` (`None`: the default), from fresh reads, with the
    /// verdict for the target. An explicit selection that reaches a
    /// not-scriptable item through a dependency is refused.
    async fn fresh_plan(
        &self,
        req: &CompareRequest,
        selection: Option<&[ItemId]>,
    ) -> Result<(Sides, SchemaDiff, SyncPlan)> {
        let sides = self.compare_sides(req).await?;
        let d = sides.diff();
        let designs = self.target_designs(req, &sides, &d).await;
        let mut plan = plan_sync(&d, selection, &designs, sides.target.dialect);
        if let Some(picked) = selection {
            refuse_unscriptable_needs(&plan, picked)?;
        }
        plan.verdict = if sides.target.read_only {
            SyncVerdict::ReadOnly
        } else if sides.target.production {
            SyncVerdict::NeedsConfirmation
        } else {
            SyncVerdict::Ok
        };
        Ok((sides, d, plan))
    }

    /// Reads both sides and diffs them, with the data-loss counts on the target.
    /// Read only on both sides: no pass on Read-only or Production.
    pub async fn compare_schemas(&self, req: CompareRequest) -> Result<CompareResult> {
        let sides = self.compare_sides(&req).await?;
        let compared_at_ms = now_ms();
        let mut d = sides.diff();
        if d.items.iter().any(|i| i.loses_data) {
            self.count_losses(&sides, &req, &mut d).await;
        }
        Ok(CompareResult {
            dialect: sides.target.dialect,
            items: d.items,
            not_compared: d.not_compared,
            summary: d.summary,
            compared_at_ms,
        })
    }

    /// Counts the data-loss items of `d` on a session of its own on the target.
    /// A session that cannot open leaves the items without counts.
    async fn count_losses(&self, sides: &Sides, req: &CompareRequest, d: &mut SchemaDiff) {
        let Ok(session) = sides
            .target_db
            .open_query_session(Some(&req.target.database))
            .await
        else {
            return;
        };
        let counts = count_data_loss(&session, sides.target.dialect, d).await;
        close_handle(&session).await;
        apply_data_loss(d, &counts);
    }

    /// One table's (or enum's) `CREATE` on each side, by the same writer.
    pub async fn compare_ddl(&self, req: CompareRequest, table: String) -> Result<DdlPair> {
        let sides = self.compare_sides(&req).await?;
        Ok(DdlPair {
            source: ddl_of(&sides.source, &table),
            target: ddl_of(&sides.target_model, &table),
        })
    }

    /// The Sync Script for `selection` (`None`: the default selection). Read
    /// only; the ticked data-loss items get their counts.
    pub async fn plan_sync(
        &self,
        req: CompareRequest,
        selection: Option<Vec<ItemId>>,
    ) -> Result<SyncPlan> {
        let (sides, d, mut plan) = self.fresh_plan(&req, selection.as_deref()).await?;
        let ticked: BTreeSet<&ItemId> = plan
            .items
            .iter()
            .filter(|i| i.ticked && i.loses_data)
            .map(|i| &i.id)
            .collect();
        if !ticked.is_empty() {
            let mut losing = SchemaDiff {
                items: d
                    .items
                    .iter()
                    .filter(|i| ticked.contains(&i.id))
                    .cloned()
                    .collect(),
                ..SchemaDiff::default()
            };
            self.count_losses(&sides, &req, &mut losing).await;
            for item in &mut plan.items {
                if let Some(found) = losing.items.iter().find(|i| i.id == item.id) {
                    item.data_loss = found.data_loss;
                }
            }
        }
        Ok(plan)
    }

    /// The Production confirmation: a Sync pass on the target for exactly the
    /// statements of this selection's script, once, for a limited time.
    pub async fn confirm_sync(
        &self,
        req: CompareRequest,
        selection: Vec<ItemId>,
    ) -> Result<PassId> {
        let (sides, _, plan) = self.fresh_plan(&req, Some(&selection)).await?;
        if sides.target.read_only {
            return Err(Error::ReadOnly(0));
        }
        if let SyncMode::CopyOnly { reason } = &plan.mode {
            return Err(Error::InvalidInput(reason.clone()));
        }
        let statements: Vec<String> = plan.statements.iter().map(|s| s.sql.clone()).collect();
        self.issue_pass(sync_scope(&req), &statements)
    }

    /// Applies the Sync Script of `selection` as Job `job` (kind Sync). In order:
    /// Read-only refuses; Production without a pass asks; the job registers; the
    /// script is rebuilt from fresh reads and refused with `PlanChanged` when its
    /// hash is not `expected_hash` (on every Connection); a copy-only script is
    /// refused; the pass must cover exactly its statements. Progress events carry
    /// the statements done; the job's final event comes before an error. One
    /// Query History entry on the target for what was applied.
    pub async fn apply_sync(
        &self,
        job: JobId,
        req: CompareRequest,
        selection: Vec<ItemId>,
        pass: Option<PassId>,
        expected_hash: String,
        sink: Arc<dyn JobSink>,
    ) -> Result<SyncOutcome> {
        let target = self.config(req.target.connection_id)?;
        if target.read_only {
            return Err(Error::ReadOnly(0));
        }
        if target.production && pass.is_none() {
            return Err(Error::NeedsConfirmation);
        }
        let ctx = self.jobs.start(
            job,
            JobKind::Sync,
            target.id,
            &target.name,
            format!("Applying the Sync Script on {}", target.name),
            true,
            sink,
        )?;
        let checked = async {
            let (sides, _, plan) = self.fresh_plan(&req, Some(&selection)).await?;
            // Refused before `authorize`: a Production pass stays unspent here; it
            // expires, and the next confirm for this target replaces it (M2).
            if plan.hash != expected_hash {
                return Err(Error::PlanChanged {
                    connection: target.name.clone(),
                });
            }
            let runs = plan.runs()?;
            let statements: Vec<String> = plan.statements.iter().map(|s| s.sql.clone()).collect();
            self.authorize(&sync_scope(&req), &target, &statements, pass)?;
            Ok((sides, plan, runs, statements))
        }
        .await;
        let (sides, plan, runs, statements) = match checked {
            Ok(c) => c,
            Err(e) => {
                ctx.discard();
                return Err(e);
            }
        };

        let total = statements.len();
        let ran_at_ms = now_ms();
        let started = Instant::now();
        let mut offset = 0usize;
        let mut result: Result<()> = Ok(());
        for run in &runs {
            let reporter = ctx.reporter();
            let base = offset;
            let progress: Progress = Arc::new(move |at: usize| {
                reporter.progress_now(JobProgress {
                    phase: JobPhase::Writing,
                    statements_done: (base + at) as u64,
                    ..JobProgress::default()
                });
            });
            let control = RunControl::new(ctx.cancel_flag().clone(), Some(progress));
            let of = run.statements.len();
            match sides
                .target_db
                .run_statements(&req.target.database, run, control)
                .await
            {
                Ok(out) if out.ran < out.of => {
                    // A cancel between statements: MySQL keeps what ran.
                    offset += out.ran;
                    result = Err(Error::Cancelled);
                    break;
                }
                Ok(_) => offset += of,
                Err(Error::DesignFailed {
                    statement,
                    ran,
                    message,
                    ..
                }) => {
                    result = Err(Error::DesignFailed {
                        statement: base + statement,
                        ran: base + ran,
                        total,
                        message,
                    });
                    offset += ran;
                    break;
                }
                Err(e) => {
                    result = Err(e);
                    break;
                }
            }
        }
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let applied = offset.min(total);
        // A cancel says what stayed: MySQL's committed statements, PostgreSQL's
        // enum values committed before the cancelled transaction.
        let result = sync_cancel(result, applied, total);
        if result.is_ok() {
            ctx.reporter().progress_now(JobProgress {
                phase: JobPhase::Writing,
                statements_done: total as u64,
                ..JobProgress::default()
            });
        }
        if applied > 0 {
            ctx.mark_ai_context_stale(target.id);
            let (outcome, error) = match &result {
                Ok(()) => (Outcome::Ok, None),
                Err(Error::SyncCancelled { .. }) => (Outcome::Cancelled, None),
                Err(e) => (Outcome::Error, Some(plain_message(e))),
            };
            ctx.history(NewHistory {
                connection_id: target.id,
                sql: history_sql(&statements[..applied]),
                ran_at_ms,
                elapsed_ms,
                outcome,
                rows: None,
                changed: true,
                error,
            });
        }
        match result {
            Ok(()) => {
                ctx.finish(Ok(JobReport {
                    kind: JobKind::Sync,
                    statements: total as u64,
                    elapsed_ms,
                    ..JobReport::default()
                }));
                Ok(SyncOutcome {
                    applied,
                    elapsed_ms,
                    tables: changed_tables(&plan, &req),
                })
            }
            Err(e) => {
                ctx.finish(Err(copy_error(&e)));
                Err(e)
            }
        }
    }
}

/// A Sync run's cancel carries the statements that stayed applied.
fn sync_cancel(result: Result<()>, applied: usize, total: usize) -> Result<()> {
    match result {
        Err(Error::Cancelled) => Err(Error::SyncCancelled { applied, total }),
        other => other,
    }
}

/// The target tables the ticked items change or drop (not the ones they create).
fn changed_tables(plan: &SyncPlan, req: &CompareRequest) -> Vec<ObjectPath> {
    let created: BTreeSet<&String> = plan
        .items
        .iter()
        .filter(|i| i.object == DiffObject::Table && i.kind == DiffKind::Added)
        .filter_map(|i| i.table.as_ref())
        .collect();
    let mut names: Vec<String> = Vec::new();
    for i in plan.items.iter().filter(|i| i.ticked) {
        if i.object == DiffObject::Enum || i.table.as_ref().is_some_and(|t| created.contains(t)) {
            continue;
        }
        if let Some(t) = &i.table
            && !names.contains(t)
        {
            names.push(t.clone());
        }
    }
    names
        .into_iter()
        .map(|name| ObjectPath {
            database: req.target.database.clone(),
            schema: req.target.schema.clone(),
            name,
        })
        .collect()
}

/// MySQL's `lower_case_table_names` on the target server; 0 when it cannot be read.
async fn lower_case_table_names(db: &dyn Dialect, database: &str) -> u8 {
    let Ok(session) = db.open_query_session(Some(database)).await else {
        return 0;
    };
    let result = session.execute("SELECT @@lower_case_table_names").await;
    close_handle(&session).await;
    let Ok(ExecOutcome::Rows { rows, .. }) = result else {
        return 0;
    };
    match rows.first().and_then(|r| r.first()) {
        Some(Cell::Number { value } | Cell::Text { value, .. }) => {
            value.trim().parse().unwrap_or(0)
        }
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compare::{SyncItem, SyncStatement};

    fn sync_item(id: &str, line: &str, needs: &[&str], not: Option<&str>) -> SyncItem {
        SyncItem {
            id: ItemId(id.into()),
            line: line.into(),
            needs: needs.iter().map(|n| ItemId((*n).into())).collect(),
            not_scriptable: not.map(str::to_string),
            ..SyncItem::default()
        }
    }

    #[test]
    fn a_cancel_carries_what_stayed_and_the_job_still_ends_cancelled() {
        let e = sync_cancel(Err(Error::Cancelled), 3, 9).unwrap_err();
        assert!(
            matches!(
                e,
                Error::SyncCancelled {
                    applied: 3,
                    total: 9
                }
            ),
            "{e:?}"
        );
        assert!(matches!(copy_error(&e), Error::Cancelled));
        assert!(sync_cancel(Ok(()), 9, 9).is_ok());
        assert!(matches!(
            sync_cancel(Err(Error::ReadOnlyRefused), 0, 9),
            Err(Error::ReadOnlyRefused)
        ));
    }

    #[test]
    fn a_need_that_cannot_be_scripted_is_refused_by_name() {
        let mut plan = SyncPlan::default();
        plan.items = vec![
            sync_item("a", "SET DEFAULT t.m 'c'", &["b"], None),
            sync_item("b", "ALTER COLUMN t.m", &["c"], None),
            sync_item(
                "c",
                "Remove mood value 'x'",
                &[],
                Some("PostgreSQL cannot remove a value from an enum. Remove x by hand."),
            ),
        ];
        plan.statements = vec![SyncStatement::default()];
        match refuse_unscriptable_needs(&plan, &[ItemId("a".into())]) {
            Err(Error::InvalidInput(m)) => assert_eq!(
                m,
                "SET DEFAULT t.m 'c' needs Remove mood value 'x': PostgreSQL cannot remove a \
                 value from an enum. Remove x by hand."
            ),
            other => panic!("{other:?}"),
        }
        // The item itself is not refused here: its plan is copy-only.
        assert!(refuse_unscriptable_needs(&plan, &[ItemId("c".into())]).is_ok());
    }

    #[test]
    fn request_json_matches_the_contract() {
        let id = uuid::Uuid::new_v4();
        let json = serde_json::json!({
            "source": {"kind": "database", "connectionId": id, "database": "freight", "schema": "billing"},
            "target": {"connectionId": id, "database": "freight", "schema": "prod"}
        });
        let req: CompareRequest = serde_json::from_value(json).unwrap();
        assert_eq!(
            req.source,
            CompareSide::Database {
                connection_id: id,
                database: "freight".into(),
                schema: Some("billing".into())
            }
        );
        let model = serde_json::json!({
            "source": {"kind": "model", "model": {"dialect": "postgres", "tables": [], "refs": [], "enums": [], "skipped": []}},
            "target": {"connectionId": id, "database": "freight", "schema": null}
        });
        let req: CompareRequest = serde_json::from_value(model).unwrap();
        assert!(matches!(req.source, CompareSide::Model { path: None, .. }));
        let out = serde_json::to_value(SyncOutcome {
            applied: 2,
            elapsed_ms: 5,
            tables: Vec::new(),
        })
        .unwrap();
        assert_eq!(
            out,
            serde_json::json!({"applied": 2, "elapsedMs": 5, "tables": []})
        );
    }

    #[test]
    fn mismatch_and_model_names() {
        assert_eq!(
            plain_message(&dialect_mismatch(
                "freight-staging",
                DialectKind::Postgres,
                "kestrel-pos",
                DialectKind::MySql
            )),
            "freight-staging is PostgreSQL and kestrel-pos is MySQL. Schema Compare needs the \
             same Dialect; use Data Transfer to copy across Dialects."
        );
        assert_eq!(model_name(Some("C:/models/orders.dbml")), "orders.dbml");
        assert_eq!(model_name(None), "The Schema Model");
    }
}
