//! The script run: the file reader thread and the statement loop.

use super::*;

/// Statements between the file reader and the run.
const CHANNEL: usize = 2;

/// What the file reader sends the run.
enum Msg {
    Statement {
        s: ScriptStatement,
        facts: Facts,
        bytes: u64,
    },
    End {
        sha: Option<[u8; 32]>,
        bytes: u64,
    },
    Failed(Error),
}

/// Reads the held file on a blocking thread, up to `limit` bytes, one statement at a time
/// through a channel of 2. It stops on cancel or when the receiver is dropped; the handle
/// ends once the thread has closed the file.
fn read_statements(
    path: PathBuf,
    file: File,
    limit: u64,
    kind: DialectKind,
    run_as_is: bool,
    cancel: Arc<AtomicBool>,
) -> (mpsc::Receiver<Msg>, tokio::task::JoinHandle<()>) {
    let (tx, rx) = mpsc::channel(CHANNEL);
    let reader = tokio::task::spawn_blocking(move || {
        let mut r = match ScriptReader::from_file(&path, file, limit, kind, run_as_is) {
            Ok(r) => r,
            Err(e) => {
                let _ = tx.blocking_send(Msg::Failed(e));
                return;
            }
        };
        loop {
            if cancel.load(Ordering::SeqCst) {
                return;
            }
            let msg = match r.next_checked() {
                Ok(Some((s, facts))) => Msg::Statement {
                    s,
                    facts,
                    bytes: r.bytes_read(),
                },
                Ok(None) => Msg::End {
                    sha: r.sha256(),
                    bytes: r.bytes_read(),
                },
                Err(e) => Msg::Failed(e),
            };
            let last = !matches!(msg, Msg::Statement { .. });
            if tx.blocking_send(msg).is_err() || last {
                return;
            }
        }
    });
    (rx, reader)
}

/// The counts a script run keeps.
#[derive(Default)]
pub(super) struct Counts {
    pub(super) ran: u64,
    pub(super) creates: u64,
    pub(super) inserts: u64,
    pub(super) skipped: u64,
    /// Rows the INSERT statements wrote.
    pub(super) rows: u64,
    /// Rows that are in for good: committed, or written with nothing open (Q27).
    pub(super) committed: u64,
    /// Rows written in the open transaction.
    pub(super) open: u64,
    pub(super) bytes: u64,
    pub(super) line: u32,
    /// A file run as written has opened a transaction (or an unmodelled control
    /// statement may have, Q44).
    pub(super) in_tx: bool,
    /// MySQL `SET autocommit = 0` is in force: every write waits for a COMMIT.
    pub(super) autocommit_off: bool,
    /// Something ran in a transaction that is still open.
    pub(super) dirty: bool,
}

impl Counts {
    pub(super) fn commit_open(&mut self) {
        self.committed += std::mem::take(&mut self.open);
        self.in_tx = false;
        self.dirty = false;
    }

    fn roll_back_open(&mut self) {
        self.open = 0;
        self.in_tx = false;
        self.dirty = false;
    }

    /// A transaction is open in a file run as written.
    fn open_tx(&self) -> bool {
        self.in_tx || self.autocommit_off
    }

    /// Counts what a statement that ran in a file run as written did (Q27, Q44).
    /// `mysql` statements that commit as they run were committed before it ran.
    pub(super) fn ran_as_written(&mut self, s: &ScriptStatement, rows: u64, facts: &Facts) {
        let kind = s.kind;
        if kind == StatementKind::Insert {
            if self.open_tx() {
                self.open += rows;
            } else {
                self.committed += rows;
            }
        }
        // A write that a rollback would lose; session settings and reads are not.
        let writes = s.class == crate::safety::StatementClass::Write && !facts.session;
        // A statement that commits as it runs (MySQL DDL) leaves nothing open.
        if writes && !facts.control && !facts.ends && self.open_tx() {
            self.dirty = true;
        }
        match facts.tx {
            TxControl::Opens | TxControl::Other => self.in_tx = true,
            TxControl::Commits => self.commit_open(),
            TxControl::RollsBack => self.roll_back_open(),
            TxControl::AutocommitOff => self.autocommit_off = true,
            TxControl::AutocommitOn => {
                self.commit_open();
                self.autocommit_off = false;
            }
            TxControl::Locks => self.commit_open(),
            TxControl::None => {}
        }
    }

    /// MySQL commits what is open before DDL, BEGIN, LOCK and UNLOCK TABLES, and
    /// `SET autocommit = 1`.
    pub(super) fn mysql_commits_before(&mut self, facts: &Facts) {
        let alone = facts.ends && !facts.control;
        if alone
            || matches!(
                facts.tx,
                TxControl::Opens | TxControl::Locks | TxControl::AutocommitOn
            )
        {
            self.commit_open();
        }
    }
}

/// "The file left a transaction open. Its 3 rows were rolled back."
pub(super) fn left_open_text(rows: u64) -> String {
    let were = if rows == 1 { "was" } else { "were" };
    format!(
        "The file left a transaction open. Its {} {were} rolled back.",
        rows_text(rows)
    )
}

/// One script job, moved into its task.
pub(super) struct ScriptRun {
    pub(super) ctx: JobCtx,
    pub(super) connection_id: ConnectionId,
    pub(super) dialect: Arc<dyn Dialect>,
    pub(super) kind: DialectKind,
    pub(super) database: Option<String>,
    pub(super) path: PathBuf,
    /// The handle the start checked; the reader takes it.
    pub(super) file: Option<File>,
    /// A second handle on the same open, so other writers stay refused until the job
    /// ends, not only until the last statement is read. Closed before the final event.
    pub(super) hold: Option<File>,
    pub(super) run_as_is: bool,
    /// The file manages its own transactions: no outer transaction.
    pub(super) own: bool,
    /// The SHA-256 the start read; the file must still have it before COMMIT.
    pub(super) expected: [u8; 32],
    /// The bytes the start read; the run reads no more.
    pub(super) file_bytes: u64,
    /// A Production Connection: a changed file says "after you confirmed" (Q45).
    pub(super) production: bool,
}

impl ScriptRun {
    fn failed_at(&self, s: &ScriptStatement, message: String) -> Error {
        Error::JobFailed {
            at: JobPosition {
                file_row: None,
                line: Some(u64::from(s.line)),
                table: None,
                statement: Some(u64::from(s.index) + 1),
            },
            message: format!("Line {}: {message}", s.line),
        }
    }

    fn progress(&self, c: &Counts, phase: JobPhase) {
        self.ctx.progress(JobProgress {
            phase,
            table: None,
            rows_done: c.rows,
            rows_total: None,
            bytes_done: c.bytes,
            bytes_total: Some(self.file_bytes),
            statements_done: c.ran,
            // A script's place is its line.
            file_row: Some(u64::from(c.line)),
            ..JobProgress::default()
        });
    }

    fn changed(&self) -> Error {
        Error::FileChanged {
            file: file_name(&self.path),
            confirmed: self.production,
        }
    }

    /// Commits the open transaction; a COMMIT that succeeded counts its rows, also when
    /// an `after` statement then failed (`AfterCommit`, Q36).
    async fn commit(w: &mut dyn BulkWriter, c: &mut Counts) -> Result<()> {
        let done = w.commit().await;
        if matches!(done, Ok(()) | Err(Error::AfterCommit { .. })) {
            c.commit_open();
        }
        done
    }

    /// Runs one statement of the file, or skips it.
    async fn statement(
        &self,
        w: &mut dyn BulkWriter,
        c: &mut Counts,
        s: ScriptStatement,
        facts: &Facts,
    ) -> Result<()> {
        c.line = s.line;
        match &s.action {
            ScriptAction::Run => {}
            ScriptAction::Skip { .. } => {
                c.skipped += 1;
                return Ok(());
            }
            // The start found no refused statement: the file changed since.
            ScriptAction::Refuse { .. } => return Err(self.changed()),
        }
        // A statement that cannot run inside a transaction (MySQL DDL commits what is
        // open as it runs): commit first, run it alone, then start the next transaction.
        let alone = facts.ends && !facts.control;
        if alone && !self.own {
            Self::commit(w, c).await?;
        }
        if self.own && self.kind == DialectKind::MySql {
            c.mysql_commits_before(facts);
        }
        let n = match w.run(&s.text).await {
            Ok(n) => n,
            Err(_) if self.ctx.is_cancelled() => return Err(Error::Cancelled),
            Err(e) => return Err(self.failed_at(&s, plain_message(&e))),
        };
        c.ran += 1;
        match s.kind {
            StatementKind::Create => c.creates += 1,
            StatementKind::Insert => {
                c.inserts += 1;
                c.rows += n;
            }
            StatementKind::Other => {}
        }
        if self.own {
            c.ran_as_written(&s, n, facts);
        } else {
            if s.kind == StatementKind::Insert {
                c.open += n;
            }
            if alone {
                w.begin().await?;
            }
        }
        Ok(())
    }

    /// Reads and runs every statement, checks the file, and commits; the error leaves the
    /// transaction to the caller.
    async fn write(
        &self,
        w: &mut dyn BulkWriter,
        rx: &mut mpsc::Receiver<Msg>,
        c: &mut Counts,
    ) -> Result<()> {
        if !self.own {
            w.begin().await?;
        }
        let (sha, bytes) = loop {
            if self.ctx.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let Some(msg) = rx.recv().await else {
                if self.ctx.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                return Err(Error::File("the script's file reader stopped".into()));
            };
            match msg {
                Msg::Statement { s, facts, bytes } => {
                    c.bytes = bytes;
                    self.statement(w, c, s, &facts).await?;
                    self.progress(c, JobPhase::Writing);
                }
                Msg::End { sha, bytes } => {
                    c.bytes = bytes;
                    break (sha, bytes);
                }
                Msg::Failed(e) => return Err(e),
            }
        };
        if bytes != self.file_bytes || sha != Some(self.expected) {
            return Err(self.changed());
        }
        if self.ctx.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if !self.own {
            self.progress(c, JobPhase::Committing);
            Self::commit(w, c).await?;
        } else if c.dirty || c.open > 0 {
            // The file ended inside a transaction: closing would roll it back unseen.
            let rows = c.open;
            let _ = w.rollback().await;
            c.roll_back_open();
            return Err(Error::JobFailed {
                at: JobPosition::default(),
                message: left_open_text(rows),
            });
        }
        Ok(())
    }

    pub(super) async fn go(mut self) {
        let started = Instant::now();
        let ran_at_ms = now_ms();
        let mut c = Counts::default();
        let file = self.file.take();
        let mut reader = None;
        let result: Result<()> = async {
            let file = file.ok_or_else(|| Error::File("the script's file is gone".into()))?;
            let (mut rx, handle) = read_statements(
                self.path.clone(),
                file,
                self.file_bytes,
                self.kind,
                self.run_as_is,
                self.ctx.cancel_flag().clone(),
            );
            reader = Some(handle);
            let mut w = self
                .dialect
                .open_bulk_writer(self.database.as_deref(), &WriterSetup::default())
                .await?;
            self.ctx.set_canceller(w.canceller());
            let done = self.write(w.as_mut(), &mut rx, &mut c).await;
            if done.is_err() {
                self.progress(&c, JobPhase::RollingBack);
                let _ = w.rollback().await;
                c.open = 0;
            }
            // Dropping the receiver stops the reader thread.
            drop(rx);
            w.close().await;
            done
        }
        .await;
        // The file is free before the final event: the reader has closed its handle (its
        // receiver is gone, so it stops) and the hold is dropped.
        if let Some(handle) = reader {
            let _ = handle.await;
        }
        drop(self.hold.take());
        let kept = c.committed;
        let file = file_name(&self.path);
        let result = match result {
            Err(_) if self.ctx.is_cancelled() => Err(Error::Cancelled),
            // Q27: "Nothing was imported." only when nothing stayed.
            Err(Error::FileChanged { .. }) if kept > 0 => Err(Error::JobFailed {
                at: JobPosition::default(),
                message: format!("{file} changed while it was imported."),
            }),
            other => other,
        };
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let (outcome, error) = match &result {
            Ok(()) => (Outcome::Ok, None),
            Err(Error::Cancelled) => (Outcome::Cancelled, None),
            Err(e) => (Outcome::Error, Some(plain_message(e))),
        };
        // Anything that ran may have stayed (MySQL commits DDL): the AI Context may be old.
        if result.is_ok() || c.ran > 0 {
            self.ctx.mark_ai_context_stale(self.connection_id);
        }
        self.ctx.history(NewHistory {
            connection_id: self.connection_id,
            sql: format!(
                "Ran {} from {file}: {} create, {} insert",
                statements_text(c.ran),
                c.creates,
                c.inserts
            ),
            ran_at_ms,
            elapsed_ms,
            outcome,
            rows: Some(if result.is_ok() { c.rows } else { kept }),
            changed: true,
            error,
        });
        match result {
            Ok(()) => {
                let report = JobReport {
                    kind: JobKind::ScriptImport,
                    rows_read: 0,
                    rows_written: c.rows,
                    statements: c.ran,
                    skipped: c.skipped,
                    warnings: Vec::new(),
                    elapsed_ms,
                    file: Some(self.path.clone()),
                    bytes: self.file_bytes,
                    committed: c.committed,
                    check: None,
                    ..JobReport::default()
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
