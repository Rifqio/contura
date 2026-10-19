//! The check pass and the import run.

use super::*;

const CHECK_PROGRESS_ROWS: u64 = 1_000;
const CHECK_PROGRESS_EVERY: std::time::Duration = std::time::Duration::from_millis(100);

/// The check pass over the whole file, on a blocking thread: the report and the bytes.
pub(super) fn check_all(
    ctx: &JobCtx,
    p: &Prepared,
    mut reader: Box<dyn RecordReader>,
    bytes_total: Option<u64>,
) -> Result<(CheckReport, u64)> {
    let mut report = CheckReport::default();
    // Progress every 1,000 rows or 100 ms, as the run sends it, not once a record.
    let mut last = Instant::now();
    let progress = |report: &CheckReport, reader: &dyn RecordReader, row: u64| {
        ctx.progress(JobProgress {
            phase: JobPhase::Checking,
            table: Some(p.target.path.name.clone()),
            rows_done: report.rows,
            bytes_done: reader.bytes_read(),
            bytes_total,
            file_row: Some(row),
            ..JobProgress::default()
        });
    };
    while let Some(rec) = reader.next_record()? {
        if ctx.is_cancelled() {
            return Err(Error::Cancelled);
        }
        report.rows += 1;
        let row = p.row(&rec);
        let mut failed = false;
        for (i, v) in row.iter().enumerate() {
            let Value::Text(s) = v else { continue };
            let col = p.column(i);
            if let Some(message) = check_value(p.kind, col, s) {
                failed = true;
                if report.first.len() < CHECK_FIRST {
                    report.first.push(CellProblem {
                        file_row: rec.row,
                        column: col.name.clone(),
                        message,
                    });
                }
            }
        }
        if failed {
            report.failing += 1;
        }
        if report.rows.is_multiple_of(CHECK_PROGRESS_ROWS) || last.elapsed() >= CHECK_PROGRESS_EVERY
        {
            last = Instant::now();
            progress(&report, reader.as_ref(), rec.row);
        }
    }
    progress(&report, reader.as_ref(), report.rows);
    report.sha256 = reader.sha256().map(|h| hex(&h)).unwrap_or_default();
    Ok((report, reader.bytes_read()))
}

/// The counts a run keeps.
#[derive(Default)]
pub(super) struct Tally {
    pub(super) read: u64,
    pub(super) written: u64,
    pub(super) statements: u64,
    pub(super) skipped: u64,
    /// Rows committed by earlier batches (Commit every N).
    pub(super) committed: u64,
    /// Rows written in the open transaction.
    pub(super) open: u64,
    pub(super) bytes: u64,
    pub(super) file_row: u64,
    /// The reader's warnings (a JSON key first seen late) and the binary-cell warnings,
    /// for the report.
    pub(super) warnings: Vec<String>,
    /// Binary cells that were not hex: the first are named, the rest counted.
    pub(super) binary_named: usize,
    pub(super) binary_more: u64,
}

/// Commits the open batch. A COMMIT that succeeded counts its rows as committed, also
/// when an `after` statement then failed (`AfterCommit`, Q36): those rows are in.
pub(super) async fn commit_batch(w: &mut dyn BulkWriter, t: &mut Tally) -> Result<()> {
    let done = w.commit().await;
    if matches!(done, Ok(()) | Err(Error::AfterCommit { .. })) {
        t.committed += std::mem::take(&mut t.open);
    }
    done
}

/// A failed run's end as it reads with `kept` rows staying in `table` (Q27):
/// "Nothing was imported." only when nothing stayed. The Skip cap says what stayed
/// (Q42 I1), and so does a file that changed after rows were kept (Q45 I1).
pub(super) fn kept_end(result: Result<()>, kept: u64, file: &str, table: &str) -> Result<()> {
    let at = || JobPosition {
        table: Some(table.to_string()),
        ..JobPosition::default()
    };
    match result {
        Err(Error::JobFailed { at, message }) if message == TOO_MANY => Err(Error::JobFailed {
            at,
            message: too_many_text(kept, table),
        }),
        Err(Error::FileChanged { .. }) if kept > 0 => Err(Error::JobFailed {
            at: at(),
            message: format!(
                "{file} changed while it was imported. {}",
                stayed_text(kept, table)
            ),
        }),
        other => other,
    }
}

/// One import job, moved into its task.
pub(super) struct Run {
    pub(super) ctx: JobCtx,
    pub(super) connection_id: crate::model::ConnectionId,
    pub(super) dialect: Arc<dyn Dialect>,
    pub(super) prepared: Prepared,
    /// Taken by the reader thread; a Mutex so the run can be shared across awaits.
    pub(super) reader: Mutex<Option<Box<dyn RecordReader>>>,
    pub(super) first: Option<FileRecord>,
    /// The SHA-256 the file must still have before COMMIT: the confirmed one on
    /// Production, the one taken before the first write under Commit every N.
    pub(super) expected: Option<[u8; 32]>,
    pub(super) on_error: OnError,
    pub(super) commit: CommitMode,
    /// None when the storage engine could not be read: counted as not rolling back.
    pub(super) transactional: Option<bool>,
    pub(super) path: PathBuf,
    /// The bytes the start's handle saw; the readers read no more.
    pub(super) file_bytes: u64,
    /// The file, held with other writers refused until the job ends (Q45); dropped
    /// before the final event.
    pub(super) held: Option<HeldFile>,
    /// A Production Connection: a changed file says "after you confirmed" (Q45 M5).
    pub(super) production: bool,
    pub(super) warnings: Vec<String>,
}

/// The server's words for a failed statement.
pub(super) fn server_text(e: &Error) -> String {
    plain_message(e)
}

impl Run {
    pub(super) fn table(&self) -> String {
        self.prepared.target.path.name.clone()
    }

    pub(super) fn failed_at(&self, file_row: u64, statement: u64, message: String) -> Error {
        Error::JobFailed {
            at: JobPosition {
                file_row: Some(file_row),
                line: None,
                table: Some(self.table()),
                statement: Some(statement),
            },
            message: format!("Row {file_row} of the file: {message}"),
        }
    }

    pub(super) fn too_many(&self) -> Error {
        Error::JobFailed {
            at: JobPosition {
                table: Some(self.table()),
                ..JobPosition::default()
            },
            message: TOO_MANY.into(),
        }
    }

    pub(super) fn progress(&self, t: &Tally) {
        self.ctx.progress(JobProgress {
            phase: JobPhase::Writing,
            table: Some(self.table()),
            rows_done: t.written,
            rows_total: None,
            bytes_done: t.bytes,
            bytes_total: Some(self.file_bytes),
            statements_done: t.statements,
            file_row: Some(t.file_row),
            ..JobProgress::default()
        });
    }

    /// Warns of the row's binary cells that are not `0x` hex (Q42): the first 20 by row,
    /// the rest counted for one warning at the end.
    pub(super) fn binary_cells(&self, t: &mut Tally, file_row: u64, values: &[Value]) {
        for text in self.prepared.binary_warnings(file_row, values) {
            if t.binary_named < BINARY_WARNINGS {
                t.binary_named += 1;
                self.ctx.warning(text.clone());
                t.warnings.push(text);
            } else {
                t.binary_more += 1;
            }
        }
    }

    /// A row the INSERT refused before it was sent (a value that is not a number).
    pub(super) fn refuse_row(
        &self,
        t: &mut Tally,
        file_row: u64,
        row: &[Value],
        e: &Error,
    ) -> Result<()> {
        let (column, message) = self.prepared.refused(row, e);
        match self.on_error {
            OnError::Stop => Err(self.failed_at(file_row, t.statements + 1, message)),
            OnError::Skip => {
                t.skipped += 1;
                if t.skipped > SKIP_CAP {
                    return Err(self.too_many());
                }
                let column = (!column.is_empty()).then_some(column);
                self.ctx.skipped(file_row, column, message);
                Ok(())
            }
        }
    }

    /// Runs one built statement under the savepoint. When it fails, its rows run again
    /// one at a time, each under a savepoint of its own: Skip keeps the good ones and
    /// lists the bad ones; Stop names the first bad row.
    pub(super) async fn statement(
        &self,
        w: &mut dyn BulkWriter,
        t: &mut Tally,
        stmt: BuiltStatement,
        rows: Vec<(u64, Vec<Value>)>,
    ) -> Result<()> {
        let number = t.statements + 1;
        w.savepoint(SAVEPOINT).await?;
        match w.run(&stmt.sql).await {
            Ok(_) => {
                w.release(SAVEPOINT).await?;
                t.statements += 1;
                t.written += stmt.rows;
                t.open += stmt.rows;
                return Ok(());
            }
            Err(_) if self.ctx.is_cancelled() => return Err(Error::Cancelled),
            Err(first) => {
                w.rollback_to(SAVEPOINT).await?;
                let head = self.prepared.head();
                let mut found = false;
                for (file_row, values) in rows {
                    if self.ctx.is_cancelled() {
                        return Err(Error::Cancelled);
                    }
                    let text = row_text(self.prepared.kind, &self.prepared.conversions, &values)?;
                    let one = format!("{head}\n{text}");
                    w.savepoint(ROW_SAVEPOINT).await?;
                    match w.run(&one).await {
                        Ok(_) => {
                            w.release(ROW_SAVEPOINT).await?;
                            t.written += 1;
                            t.open += 1;
                        }
                        Err(_) if self.ctx.is_cancelled() => return Err(Error::Cancelled),
                        Err(e) => {
                            found = true;
                            w.rollback_to(ROW_SAVEPOINT).await?;
                            w.release(ROW_SAVEPOINT).await?;
                            match self.on_error {
                                OnError::Stop => {
                                    return Err(self.failed_at(file_row, number, server_text(&e)));
                                }
                                OnError::Skip => {
                                    t.skipped += 1;
                                    if t.skipped > SKIP_CAP {
                                        return Err(self.too_many());
                                    }
                                    self.ctx.skipped(file_row, None, server_text(&e));
                                }
                            }
                        }
                    }
                }
                if !found {
                    // Each row went in alone: the statement failed as a whole.
                    if self.on_error == OnError::Stop {
                        return Err(self.failed_at(stmt.first_row, number, server_text(&first)));
                    }
                }
                w.release(SAVEPOINT).await?;
                t.statements += 1;
            }
        }
        Ok(())
    }

    /// Commits the open batch under Commit every N once it holds N rows.
    pub(super) async fn maybe_commit(&self, w: &mut dyn BulkWriter, t: &mut Tally) -> Result<()> {
        let CommitMode::Every { rows } = self.commit else {
            return Ok(());
        };
        if t.open < rows.max(1) {
            return Ok(());
        }
        self.ctx.progress(JobProgress {
            phase: JobPhase::Committing,
            table: Some(self.table()),
            rows_done: t.written,
            bytes_done: t.bytes,
            bytes_total: Some(self.file_bytes),
            statements_done: t.statements,
            file_row: Some(t.file_row),
            ..JobProgress::default()
        });
        commit_batch(w, t).await?;
        w.begin().await
    }

    /// Reads, writes and commits; the error leaves the transaction to the caller.
    pub(super) async fn write(
        &self,
        w: &mut dyn BulkWriter,
        rx: &mut tokio::sync::mpsc::Receiver<FileMsg>,
        t: &mut Tally,
    ) -> Result<()> {
        let limits = insert_limits(self.transactional, self.commit, w.statement_limit());
        let mut builder = self.prepared.builder(limits);
        let mut open_rows: Vec<(u64, Vec<Value>)> = Vec::new();
        w.begin().await?;
        let sha = loop {
            if self.ctx.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let Some(msg) = rx.recv().await else {
                if self.ctx.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                return Err(Error::File("the import's file reader stopped".into()));
            };
            match msg {
                FileMsg::Rows {
                    records,
                    bytes_read,
                    warnings,
                    // The chunk's bytes stay counted until its rows are written (Q45).
                    held: _held,
                } => {
                    for w_text in warnings {
                        self.ctx.warning(w_text.clone());
                        t.warnings.push(w_text);
                    }
                    for rec in records {
                        if self.ctx.is_cancelled() {
                            return Err(Error::Cancelled);
                        }
                        t.read += 1;
                        t.file_row = rec.row;
                        let values = self.prepared.row(&rec);
                        self.binary_cells(t, rec.row, &values);
                        match builder.push(&values, rec.row) {
                            Err(e) => self.refuse_row(t, rec.row, &values, &e)?,
                            Ok(None) => open_rows.push((rec.row, values)),
                            Ok(Some(stmt)) => {
                                let rows = std::mem::take(&mut open_rows);
                                open_rows.push((rec.row, values));
                                self.statement(w, t, stmt, rows).await?;
                                self.maybe_commit(w, t).await?;
                            }
                        }
                    }
                    t.bytes = bytes_read;
                    self.progress(t);
                }
                FileMsg::End {
                    sha256,
                    bytes_read,
                    warnings,
                } => {
                    for w_text in warnings {
                        self.ctx.warning(w_text.clone());
                        t.warnings.push(w_text);
                    }
                    t.bytes = bytes_read;
                    if t.binary_more > 0 {
                        let more = t.binary_more;
                        let text = format!(
                            "{} more binary {} not 0x hex and went in as text.",
                            grouped(more),
                            if more == 1 { "cell is" } else { "cells are" }
                        );
                        self.ctx.warning(text.clone());
                        t.warnings.push(text);
                    }
                    if let Some(stmt) = builder.finish() {
                        let rows = std::mem::take(&mut open_rows);
                        self.statement(w, t, stmt, rows).await?;
                    }
                    self.progress(t);
                    break sha256;
                }
                FileMsg::Failed(e) => return Err(e),
            }
        };
        for sql in &self.prepared.extra {
            w.run(sql).await.map_err(|e| Error::JobFailed {
                at: JobPosition {
                    table: Some(self.table()),
                    ..JobPosition::default()
                },
                message: format!("{sql} failed: {}", server_text(&e)),
            })?;
        }
        // The file must still be the one confirmed (or hashed before the first write).
        if let Some(expected) = self.expected
            && sha != Some(expected)
        {
            return Err(Error::FileChanged {
                file: file_name(&self.path),
                confirmed: self.production,
            });
        }
        if self.ctx.is_cancelled() {
            return Err(Error::Cancelled);
        }
        self.ctx.progress(JobProgress {
            phase: JobPhase::Committing,
            table: Some(self.table()),
            rows_done: t.written,
            bytes_done: t.bytes,
            bytes_total: Some(self.file_bytes),
            statements_done: t.statements,
            file_row: Some(t.file_row),
            ..JobProgress::default()
        });
        commit_batch(w, t).await
    }

    pub(super) async fn go(mut self) {
        let started = Instant::now();
        let ran_at_ms = now_ms();
        let mut t = Tally::default();
        let mut reader_thread = None;
        let result: Result<()> = async {
            if matches!(self.commit, CommitMode::Every { .. }) && self.expected.is_none() {
                // Committed batches must come from one file: hash the held bytes first.
                self.ctx.progress(JobProgress {
                    phase: JobPhase::Reading,
                    table: Some(self.table()),
                    bytes_total: Some(self.file_bytes),
                    ..JobProgress::default()
                });
                let held = self
                    .held
                    .clone()
                    .ok_or_else(|| Error::File("the import's file is gone".into()))?;
                let cancel = self.ctx.cancel_flag().clone();
                let sha = tokio::task::spawn_blocking(move || held.sha256(&cancel))
                    .await
                    .map_err(blocking_err)??;
                self.expected = Some(sha);
            }
            let reader = self
                .reader
                .lock()
                .ok()
                .and_then(|mut r| r.take())
                .ok_or_else(|| Error::File("the import's file reader is gone".into()))?;
            let (mut rx, thread) =
                import_pipeline(reader, self.first.take(), self.ctx.cancel_flag().clone())?;
            reader_thread = Some(thread);
            let database = self.prepared.target.path.database.clone();
            let mut w = self
                .dialect
                .open_bulk_writer(Some(&database), &WriterSetup::default())
                .await?;
            self.ctx.set_canceller(w.canceller());
            let done = self.write(w.as_mut(), &mut rx, &mut t).await;
            if done.is_err() {
                self.ctx.progress(JobProgress {
                    phase: JobPhase::RollingBack,
                    table: Some(self.table()),
                    rows_done: t.written,
                    ..JobProgress::default()
                });
                let _ = w.rollback().await;
            }
            // Dropping the receiver stops the reader thread.
            drop(rx);
            w.close().await;
            done
        }
        .await;
        // The file is free before the final event: the reader thread has dropped its
        // reader (its receiver is gone, so it stops), then the hold goes.
        if let Some(thread) = reader_thread {
            let _ = tokio::task::spawn_blocking(move || thread.join()).await;
        }
        drop(self.reader.lock().ok().and_then(|mut r| r.take()));
        drop(self.held.take());
        let result = match result {
            Err(_) if self.ctx.is_cancelled() => Err(Error::Cancelled),
            other => other,
        };
        let elapsed_ms = started.elapsed().as_millis() as u64;
        // Q27: what stayed in the table. A table that does not roll back keeps every
        // row written; otherwise the committed batches stay.
        let kept = if self.transactional == Some(true) {
            t.committed
        } else {
            t.written
        };
        let result = kept_end(result, kept, &file_name(&self.path), &self.table());
        let mut sql = format!(
            "{} ... {} in {}",
            self.prepared.head(),
            rows_text(t.written),
            statements_text(t.statements)
        );
        for extra in &self.prepared.extra {
            sql.push('\n');
            sql.push_str(extra);
        }
        let (outcome, error) = match &result {
            Ok(()) => (Outcome::Ok, None),
            Err(Error::Cancelled) => (Outcome::Cancelled, None),
            Err(e) => (Outcome::Error, Some(plain_message(e))),
        };
        self.ctx.history(NewHistory {
            connection_id: self.connection_id,
            sql,
            ran_at_ms,
            elapsed_ms,
            outcome,
            rows: Some(if result.is_ok() { t.written } else { kept }),
            changed: true,
            error,
        });
        match result {
            Ok(()) => {
                let report = JobReport {
                    kind: JobKind::Import,
                    rows_read: t.read,
                    rows_written: t.written,
                    statements: t.statements,
                    skipped: t.skipped,
                    warnings: self
                        .warnings
                        .iter()
                        .cloned()
                        .chain(std::mem::take(&mut t.warnings))
                        .collect(),
                    elapsed_ms,
                    file: Some(self.path.clone()),
                    bytes: self.file_bytes,
                    committed: t.committed,
                    check: None,
                };
                self.ctx.finish(Ok(report));
            }
            Err(e) => {
                if matches!(e, Error::Cancelled) && kept > 0 {
                    let were = if kept == 1 { "was" } else { "were" };
                    self.ctx.warning(format!(
                        "{} {were} committed before you cancelled.",
                        rows_text(kept)
                    ));
                }
                self.ctx.fail(e, kept);
            }
        }
    }
}
