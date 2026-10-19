//! The Data Transfer service (step 8): plan, sample, confirm and start. Every call
//! builds the plan again from the request with `plan_transfer`, so Review SQL, the
//! Production pass and the run cover the same statements.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use super::{ConnectionService, now_ms, plain_message};
use crate::design::Increment;
use crate::dialect::Dialect;
use crate::error::{Error, Result};
use crate::jobs::insert::{InsertBuilder, InsertLimits, conversion_for};
use crate::jobs::source::SourceRequest;
use crate::jobs::types::{JobId, JobKind, JobPhase, JobProgress, JobReport};
use crate::jobs::{JobCtx, JobSink};
use crate::model::{ConnectionConfig, ObjectPath};
use crate::query::{NewHistory, Outcome};
use crate::safety::PassId;
use crate::schema_model::SchemaModel;
use crate::transfer::{
    RunSides, Side, TargetColumn, TargetState, TargetTable, TransferObserver, TransferPlan,
    TransferProgress, TransferRequest, coerce, parse_type, plan_transfer, run_transfer,
};

/// The refusal when the plan built at start is not the one the user reviewed.
pub const TARGET_CHANGED: &str = "The target changed since you reviewed. Check the SQL again.";

/// Everything a plan is built from.
struct Inputs {
    target: ConnectionConfig,
    source_db: Arc<dyn Dialect>,
    target_db: Arc<dyn Dialect>,
    model: SchemaModel,
    state: TargetState,
}

/// The plan's hex fingerprint as the 32 bytes a Job pass holds.
fn fingerprint_bytes(hex: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = hex
            .get(i * 2..i * 2 + 2)
            .and_then(|h| u8::from_str_radix(h, 16).ok())
            .unwrap_or(0);
    }
    out
}

/// Sends a running transfer's progress to its job.
struct JobObserver<'a>(&'a JobCtx);

impl TransferObserver for JobObserver<'_> {
    fn progress(&self, p: &TransferProgress) {
        self.0.progress(JobProgress {
            phase: JobPhase::Writing,
            table: Some(p.table.clone()),
            rows_done: p.rows,
            rows_total: p.total,
            statements_done: p.tables_done as u64,
            table_rows: Some(p.table_rows),
            table_total: p.table_total,
            ..JobProgress::default()
        });
    }

    fn cancelled(&self) -> bool {
        self.0.is_cancelled()
    }

    fn warning(&self, text: &str) {
        self.0.warning(text.to_string());
    }
}

impl ConnectionService {
    /// Reads both sides. A Read-only target is refused before anything is read.
    async fn transfer_inputs(&self, req: &TransferRequest) -> Result<Inputs> {
        let target = self.config(req.target.connection_id)?;
        if target.read_only {
            return Err(Error::ReadOnly(0));
        }
        self.config(req.source.connection_id)?;
        let source_db = self.session(req.source.connection_id).await?;
        let target_db = self.session(req.target.connection_id).await?;
        let model = source_db
            .schema_snapshot(&req.source.database, req.source.schema.as_deref())
            .await?;
        // A target schema or database that does not exist yet holds no tables.
        let existing = target_db
            .schema_snapshot(&req.target.database, req.target.schema.as_deref())
            .await
            .map(|m| m.tables)
            .unwrap_or_default();
        // The server's row estimates, for the rows Empty it first deletes.
        let estimates = estimates(target_db.as_ref(), &req.target).await;
        let wanted: Vec<&str> = req
            .tables
            .iter()
            .filter(|t| t.ticked)
            .map(|t| t.name.as_str())
            .collect();
        let mut tables = Vec::new();
        for t in existing {
            let mut columns: Vec<TargetColumn> = t
                .columns
                .iter()
                .map(|c| TargetColumn {
                    name: c.name.clone(),
                    not_null: c.not_null,
                    has_default: c.default.is_some(),
                    generated: c.increment,
                    identity_always: false,
                })
                .collect();
            // The Table Designer's read knows ALWAYS identities and generated columns.
            if wanted.iter().any(|w| w.eq_ignore_ascii_case(&t.name))
                && let Ok(design) = self
                    .table_design(
                        target.id,
                        ObjectPath {
                            database: req.target.database.clone(),
                            schema: req.target.schema.clone(),
                            name: t.name.clone(),
                        },
                    )
                    .await
            {
                for c in &mut columns {
                    if let Some(d) = design.columns.iter().find(|d| d.name == c.name) {
                        c.generated |= d.generated || !matches!(d.increment, Increment::None);
                        c.identity_always = d.identity_always;
                    }
                }
            }
            tables.push(TargetTable {
                rows: estimates.get(&t.name).copied(),
                name: t.name,
                columns,
            });
        }
        Ok(Inputs {
            state: TargetState {
                dialect: target.dialect,
                connection_name: target.name.clone(),
                tables,
            },
            target,
            source_db,
            target_db,
            model,
        })
    }

    /// The plan Review SQL shows: mapped columns with their notes, the structure and
    /// after-rows SQL, the row-copy shapes, what is not copied, the mode line.
    pub async fn plan_transfer(&self, req: TransferRequest) -> Result<TransferPlan> {
        let inputs = self.transfer_inputs(&req).await?;
        let mut plan = plan_transfer(&req, &inputs.model, &inputs.state)?;
        // Shown only: the fingerprint was taken without them, since estimates move.
        let rows = estimates(inputs.source_db.as_ref(), &req.source).await;
        for c in &mut plan.copies {
            c.rows_hint = rows.get(&c.source).copied();
        }
        Ok(plan)
    }

    /// The first INSERT of `table`'s copy, exactly, from 4 rows of the source.
    pub async fn transfer_sample(&self, req: TransferRequest, table: String) -> Result<String> {
        let inputs = self.transfer_inputs(&req).await?;
        let plan = plan_transfer(&req, &inputs.model, &inputs.state)?;
        let copy = plan
            .copies
            .iter()
            .find(|c| c.table == table)
            .ok_or_else(|| Error::NotFound(format!("table {table} in the plan")))?;
        let mut reader = inputs
            .source_db
            .open_row_source(&SourceRequest::Table {
                path: ObjectPath {
                    database: req.source.database.clone(),
                    schema: req.source.schema.clone(),
                    name: copy.table.clone(),
                },
                columns: copy.columns.iter().map(|c| c.source.clone()).collect(),
                filter: None,
                sort: None,
                keys: Vec::new(),
            })
            .await?;
        let kinds: Vec<_> = reader.columns().iter().map(|c| c.kind).collect();
        let targets: Vec<String> = copy.columns.iter().map(|c| c.target.clone()).collect();
        let mut builder = InsertBuilder::new(
            plan.target_dialect,
            copy.target_sql.clone(),
            &targets,
            copy.columns
                .iter()
                .map(|c| conversion_for(plan.target_dialect, &c.target_type))
                .collect(),
            InsertLimits {
                rows: 4,
                ..InsertLimits::default()
            },
            copy.overriding,
        );
        let mut taken = 0u64;
        'read: while let Some(chunk) = reader.next_chunk().await? {
            for row in chunk.rows {
                taken += 1;
                let mut converted = Vec::with_capacity(row.len());
                for ((v, kind), col) in row.into_iter().zip(&kinds).zip(&copy.columns) {
                    let conv = coerce(
                        plan.source_dialect,
                        *kind,
                        plan.target_dialect,
                        &parse_type(&col.target_type),
                    );
                    converted.push(conv.apply(&col.target, v).map_err(|f| {
                        Error::InvalidInput(format!(
                            "{}, row {taken}: {} in {}.",
                            copy.table, f.reason, f.column
                        ))
                    })?);
                }
                builder.push(&converted, taken)?;
                if taken == 4 {
                    break 'read;
                }
            }
        }
        Ok(builder
            .finish()
            .map(|s| s.sql)
            .unwrap_or_else(|| format!("{} VALUES ...", copy.insert_head)))
    }

    /// Issues the Job pass on the target for this plan's fingerprint.
    pub async fn confirm_transfer(&self, req: TransferRequest) -> Result<PassId> {
        let inputs = self.transfer_inputs(&req).await?;
        let plan = plan_transfer(&req, &inputs.model, &inputs.state)?;
        if let Some(first) = plan.blocked.first() {
            return Err(Error::InvalidInput(format!(
                "A column still needs a choice: {first}"
            )));
        }
        self.issue_job_pass(inputs.target.id, fingerprint_bytes(&plan.fingerprint), None)
    }

    /// Starts transfer `job` (the client's id). In order: Read-only refuses; Production
    /// without a pass asks; the job registers (one write job per target Connection); the
    /// plan is built again, and refused when it is not the one reviewed (`reviewed`, the
    /// fingerprint the client showed) or still needs a choice; the pass must cover it.
    /// The run goes on in the background and adds one history entry on the target.
    pub async fn start_transfer(
        &self,
        job: JobId,
        req: TransferRequest,
        reviewed: Option<String>,
        pass: Option<PassId>,
        sink: Arc<dyn JobSink>,
    ) -> Result<JobId> {
        let target = self.config(req.target.connection_id)?;
        if target.read_only {
            return Err(Error::ReadOnly(0));
        }
        if target.production && pass.is_none() {
            return Err(Error::NeedsConfirmation);
        }
        let ticked = req.tables.iter().filter(|t| t.ticked).count();
        let ctx = self.jobs.start(
            job,
            JobKind::Transfer,
            target.id,
            &target.name,
            format!(
                "Copying {ticked} {} to {}",
                if ticked == 1 { "table" } else { "tables" },
                target.name
            ),
            true,
            sink,
        )?;
        let checked = async {
            let inputs = self.transfer_inputs(&req).await?;
            // The reviewed plan was built from this same request, so a plan that now
            // fails means a side changed since.
            let plan = match plan_transfer(&req, &inputs.model, &inputs.state) {
                Err(Error::InvalidInput(_)) if reviewed.is_some() => {
                    return Err(Error::InvalidInput(TARGET_CHANGED.into()));
                }
                planned => planned?,
            };
            if reviewed.as_deref().is_some_and(|r| r != plan.fingerprint) {
                return Err(Error::InvalidInput(TARGET_CHANGED.into()));
            }
            if let Some(first) = plan.blocked.first() {
                return Err(Error::InvalidInput(format!(
                    "A column still needs a choice: {first}"
                )));
            }
            self.authorize_job(&target, fingerprint_bytes(&plan.fingerprint), pass)?;
            Ok((inputs, plan))
        }
        .await;
        let (inputs, plan) = match checked {
            Ok(c) => c,
            Err(e) => {
                ctx.discard();
                return Err(e);
            }
        };
        let source_name = self
            .config(req.source.connection_id)
            .map(|c| c.name)
            .unwrap_or_default();
        tokio::spawn(async move {
            let started = Instant::now();
            let ran_at_ms = now_ms();
            let result = run_transfer(
                &plan,
                RunSides {
                    source: inputs.source_db.as_ref(),
                    source_side: &req.source,
                    target: inputs.target_db.as_ref(),
                    target_side: &req.target,
                    target_name: &inputs.target.name,
                },
                req.batch_rows,
                req.compare_counts,
                &JobObserver(&ctx),
            )
            .await;
            let elapsed_ms = started.elapsed().as_millis() as u64;
            let (outcome, error) = match &result {
                Ok(_) => (Outcome::Ok, None),
                Err(Error::Cancelled) => (Outcome::Cancelled, None),
                Err(e) => (Outcome::Error, Some(plain_message(e))),
            };
            let rows = result.as_ref().map(|o| o.rows).ok();
            ctx.history(NewHistory {
                connection_id: inputs.target.id,
                sql: history_text(&plan, &req, &source_name, &inputs.target.name, rows),
                ran_at_ms,
                elapsed_ms,
                outcome,
                rows,
                changed: true,
                error,
            });
            ctx.finish(result.map(|o| JobReport {
                kind: JobKind::Transfer,
                rows_read: o.rows,
                rows_written: o.rows,
                statements: o.tables.len() as u64,
                elapsed_ms,
                committed: o.rows,
                ..JobReport::default()
            }));
        });
        Ok(job)
    }
}

/// Each table's row estimate from the server, by name; empty when it gives none.
async fn estimates(db: &dyn Dialect, side: &Side) -> HashMap<String, u64> {
    db.list_objects(&side.database, side.schema.as_deref())
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|o| Some((o.name, o.rows?)))
        .collect()
}

/// The history entry: a summary line, the structure SQL, each row copy with its count,
/// and the after-rows SQL.
fn history_text(
    plan: &TransferPlan,
    req: &TransferRequest,
    source: &str,
    target: &str,
    rows: Option<u64>,
) -> String {
    let mut out = vec![format!(
        "-- Data Transfer from {source} ({}) to {target} ({})",
        req.source.database, req.target.database
    )];
    out.extend(plan.structure.iter().cloned());
    for c in &plan.copies {
        out.push(format!(
            "-- {} to {}: {} VALUES ...",
            c.source, c.target, c.insert_head
        ));
    }
    if let Some(n) = rows {
        out.push(format!("-- {n} rows copied"));
    }
    out.extend(plan.after_rows.iter().cloned());
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_hex_to_bytes() {
        let hex = "00ff10".to_string() + &"a".repeat(58);
        let b = fingerprint_bytes(&hex);
        assert_eq!(&b[..3], &[0x00, 0xff, 0x10]);
        assert_eq!(b[3], 0xaa);
    }
}
