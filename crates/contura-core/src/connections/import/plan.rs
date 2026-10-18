//! `plan_import` and `confirm_import`: the Columns step's plan and the Job pass.

use super::*;

/// What `plan_import` reads from the file, on a blocking thread.
pub(super) struct Sampled {
    pub(super) prepared: Prepared,
    pub(super) preview: Vec<Vec<PreviewCell>>,
    /// The first rows' values by file column, after the empty-cell and NULL rules.
    pub(super) sample_text: Vec<Vec<Option<String>>>,
    pub(super) sample: Option<BuiltStatement>,
    pub(super) first_rows: Vec<String>,
    /// The sample statement was cut by a limit before the file's end.
    pub(super) cut: bool,
    pub(super) rows: u64,
    pub(super) has_rows: bool,
    pub(super) warnings: Vec<String>,
}

pub(super) fn sample_file(
    target: Target,
    req: &ImportRequest,
    limits: InsertLimits,
) -> Result<Sampled> {
    let file_bytes = std::fs::metadata(&req.file)
        .map_err(|e| Error::File(format!("cannot read {}: {e}", req.file.display())))?
        .len();
    let (mut reader, declared) = open_reader(req, false)?;
    let prepared = Prepared::new(target, reader.columns().to_vec(), req)?;
    let mut builder = prepared.builder(limits);
    let mut preview = Vec::new();
    let mut sample_text = Vec::new();
    let mut first_rows = Vec::new();
    let mut sample = None;
    let mut count = 0u64;
    let start = reader.bytes_read();
    let mut eof = false;
    // The first statement as the run builds it (Q10): refused rows are left out, as the
    // run leaves them out, up to the Skip cap's worth of them.
    while count < (SAMPLE_ROWS as u64 + SKIP_CAP + 1) && sample.is_none() {
        let Some(rec) = reader.next_record()? else {
            eof = true;
            break;
        };
        count += 1;
        let row = prepared.row(&rec);
        if preview.len() < PREVIEW_ROWS {
            preview.push(
                row.iter()
                    .enumerate()
                    .map(|(i, v)| PreviewCell {
                        text: value_text(v),
                        problem: match v {
                            Value::Text(s) => check_value(prepared.kind, prepared.column(i), s),
                            _ => None,
                        },
                    })
                    .collect(),
            );
            sample_text.push(
                rec.values
                    .iter()
                    .map(|raw| value_text(&prepared.rules.value(raw.as_ref())))
                    .collect(),
            );
        }
        // A refused row adds nothing to the sample; the preview marks it.
        if let Ok(text) = row_text(prepared.kind, &prepared.conversions, &row) {
            match builder.push(&row, rec.row) {
                Ok(Some(done)) => sample = Some(done),
                Ok(None) => {
                    if first_rows.len() < SHAPE_ROWS {
                        first_rows.push(text);
                    }
                }
                Err(_) => {}
            }
        }
    }
    let cut = sample.is_some();
    if sample.is_none() {
        sample = builder.finish();
    }
    // The row count: exact for a small file or when the end was reached, else the
    // workbook's declared rows or an estimate from bytes per row.
    let rows = if eof {
        count
    } else if file_bytes < EXACT_COUNT_BYTES {
        while reader.next_record()?.is_some() {
            count += 1;
        }
        count
    } else if let Some(declared) = declared {
        declared
    } else {
        let used = reader.bytes_read().saturating_sub(start).max(1);
        let rest = file_bytes.saturating_sub(start);
        ((rest as f64) * (count as f64) / (used as f64)).round() as u64
    };
    Ok(Sampled {
        has_rows: count > 0,
        warnings: reader.warnings(),
        prepared,
        preview,
        sample_text,
        sample,
        first_rows,
        cut,
        rows,
    })
}

impl ConnectionService {
    /// The plan, and with `identity` the file's identity and the job's fingerprint.
    pub(super) async fn import_planned(
        &self,
        config: &ConnectionConfig,
        req: &ImportRequest,
        identity: bool,
    ) -> Result<(ImportPlan, Option<(FileIdentity, [u8; 32])>)> {
        self.guard_import_file(&req.file)?;
        let kind = config.dialect;
        let d = self.session(config.id).await?;
        let target = load_target(d.as_ref(), kind, &req.table).await?;
        let (mut warnings, transactional) = storage_of(d.as_ref(), &req.table).await;
        let owned = req.clone();
        let server_limit = statement_limit(d.as_ref(), kind).await;
        let limits = insert_limits(transactional, req.options.commit, server_limit);
        let s = tokio::task::spawn_blocking(move || sample_file(target, &owned, limits))
            .await
            .map_err(blocking_err)??;
        warnings.extend(s.warnings.iter().cloned());
        let p = &s.prepared;
        let columns = p
            .target
            .columns
            .iter()
            .map(|c| {
                let file_column = p
                    .mapping
                    .iter()
                    .find(|m| m.into.as_deref() == Some(c.name.as_str()))
                    .map(|m| m.file_column);
                PlannedColumn {
                    into: c.name.clone(),
                    type_sql: c.type_sql.clone(),
                    file_column,
                    note: column_note(kind, c, &p.header, &p.mapping, &s.sample_text),
                    blocks: (file_column.is_none() && c.needs_value())
                        .then(|| needs_value_text(&c.name)),
                    generated: c.generated,
                }
            })
            .collect();
        let per_statement = match (&s.sample, s.cut) {
            (Some(stmt), true) => stmt.rows,
            _ => limits.rows as u64,
        };
        let shape = InsertShape {
            head: p.head(),
            first_rows: s.first_rows.clone(),
            rows_per_statement: per_statement.min(s.rows.max(1)),
            statements: s.rows.div_ceil(per_statement.max(1)),
            rows: s.rows,
        };
        let reasons = p.blockers(s.has_rows);
        let one_transaction = transactional == Some(true) && req.options.commit == CommitMode::Once;
        let want = identity || (config.production && !config.read_only && reasons.is_empty());
        let found = if want {
            let id = file_identity(&req.file, Arc::new(AtomicBool::new(false))).await?;
            let fp = job_fingerprint(&p.job_plan(req, id.clone())?)?;
            Some((id, fp))
        } else {
            None
        };
        let verdict = if config.read_only {
            JobVerdict::ReadOnly {
                connection: config.name.clone(),
            }
        } else if !reasons.is_empty() {
            JobVerdict::Blocked { reasons }
        } else if config.production {
            let (id, fp) = found.as_ref().expect("hashed for Production");
            JobVerdict::NeedsConfirmation {
                connection: config.name.clone(),
                database: Some(req.table.database.clone()),
                fingerprint: hex(fp),
                file_bytes: id.bytes,
                file_sha256: id.sha256.clone(),
            }
        } else {
            JobVerdict::Ok
        };
        let plan = ImportPlan {
            columns,
            preview: s.preview,
            sample_insert: s.sample.map(|b| b.sql).unwrap_or_default(),
            extra: p.extra.clone(),
            shape,
            warnings,
            verdict,
            one_transaction,
        };
        Ok((plan, found))
    }

    /// The Columns step: the table's columns with the mapping and their notes, the first
    /// 20 rows as they will be written with each cell's problem, the first statement
    /// exactly as it will run (Q10), any `setval`, the warnings and the verdict. On
    /// Production the file is hashed for the fingerprint.
    pub async fn plan_import(&self, req: ImportRequest) -> Result<ImportPlan> {
        let config = self.config(req.connection_id)?;
        Ok(self.import_planned(&config, &req, false).await?.0)
    }

    /// Builds the plan again and issues the Job pass for its fingerprint, bound to the
    /// file's identity (D5, Q29).
    pub async fn confirm_import(&self, req: ImportRequest) -> Result<PassId> {
        let config = self.config(req.connection_id)?;
        if config.read_only {
            return Err(Error::ReadOnly(0));
        }
        let (plan, found) = self.import_planned(&config, &req, true).await?;
        if let JobVerdict::Blocked { reasons } = plan.verdict {
            return Err(Error::InvalidInput(reasons.join(" ")));
        }
        let (id, fp) = found.ok_or_else(|| Error::File("the file was not hashed".into()))?;
        self.issue_job_pass(config.id, fp, Some(id))
    }
}
