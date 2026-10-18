//! The reader and writer of an export job, joined by a channel of 2 chunks (Task 7),
//! and the read side of an import job (Task 8).
//!
//! The source runs in the job's async task; the format writer runs on a blocking thread
//! and drops each chunk once written, so neither side holds more than its chunk. Only a
//! read that ended with its end mark and a writer that wrote every chunk commit the file;
//! any other end drops the writer, which deletes the partial.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::Duration;

use tokio::sync::mpsc;

use crate::error::{Error, Result};
use crate::jobs::JobCtx;
use crate::jobs::formats::{FileRecord, FormatWriter, RecordReader, WriteSummary};
use crate::jobs::source::{Chunk, RowSource};
use crate::jobs::types::{JobPhase, JobProgress};

fn stopped(e: tokio::task::JoinError) -> Error {
    Error::File(format!("the export's writer stopped: {e}"))
}

/// Streams `source` through `writer` and commits the file. Returns the rows written and
/// the writer's summary, whose `bytes` is the committed file's size, and keeps in
/// `written` the rows the writer has written so far, so a failed or cancelled job can
/// still say how far it came. On a read error, a write error or a cancel the file is not
/// committed and the partial is removed; the error is returned as it came (`ReadStopped`
/// keeps its own sentence), except that any end after a cancel is `Cancelled` (Q41).
pub(crate) async fn export_pipeline_counted(
    mut source: Box<dyn RowSource>,
    writer: Box<dyn FormatWriter>,
    ctx: &JobCtx,
    rows_total: Option<u64>,
    written: &AtomicU64,
) -> Result<(u64, WriteSummary)> {
    let cancelled = |e: Error| {
        if ctx.is_cancelled() {
            Error::Cancelled
        } else {
            e
        }
    };
    ctx.set_canceller(source.canceller());
    let columns = source.columns().to_vec();
    let bytes_done = Arc::new(AtomicU64::new(0));
    let rows_done = Arc::new(AtomicU64::new(0));
    let (tx, mut rx) = mpsc::channel::<Chunk>(2);
    let (bytes, done) = (bytes_done.clone(), rows_done.clone());
    let write = tokio::task::spawn_blocking(move || -> Result<Box<dyn FormatWriter>> {
        let mut writer = writer;
        writer.begin(&columns)?;
        while let Some(chunk) = rx.blocking_recv() {
            writer.write_chunk(&chunk)?;
            done.fetch_add(chunk.rows.len() as u64, Ordering::SeqCst);
            drop(chunk);
            bytes.store(writer.summary().bytes, Ordering::Relaxed);
        }
        Ok(writer)
    });

    let mut rows = 0u64;
    let read: Result<()> = loop {
        if ctx.is_cancelled() {
            break Err(Error::Cancelled);
        }
        match source.next_chunk().await {
            Ok(Some(chunk)) => {
                rows += chunk.rows.len() as u64;
                // A closed channel means the writer stopped; its own error is returned.
                if tx.send(chunk).await.is_err() {
                    break Ok(());
                }
                ctx.progress(JobProgress {
                    phase: JobPhase::Writing,
                    rows_done: rows,
                    rows_total,
                    bytes_done: bytes_done.load(Ordering::Relaxed),
                    ..Default::default()
                });
            }
            Ok(None) => break Ok(()),
            Err(e) => break Err(e),
        }
    };
    drop(tx);
    // Dropping the source stops its server read at once (Q41) and closes its connection.
    drop(source);
    let joined = write.await.map_err(stopped);
    written.store(rows_done.load(Ordering::SeqCst), Ordering::SeqCst);
    let writer = match (read, joined) {
        // The writer, if it is still there, is dropped here: the partial goes with it.
        (Err(e), _) => return Err(cancelled(e)),
        (Ok(()), Err(e)) | (Ok(()), Ok(Err(e))) => return Err(cancelled(e)),
        (Ok(()), Ok(Ok(w))) => w,
    };
    if ctx.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let summary = writer.summary();
    ctx.progress(JobProgress {
        phase: JobPhase::Committing,
        rows_done: rows,
        rows_total,
        bytes_done: summary.bytes,
        ..Default::default()
    });
    // A cancel is honoured up to the rename: the finished partial is dropped, and so
    // deleted, when the flag is set by then.
    let flag = ctx.cancel_flag().clone();
    let bytes = tokio::task::spawn_blocking(move || {
        let out = writer.finish()?;
        if flag.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        out.commit()
    })
    .await
    .map_err(stopped)?
    .map_err(cancelled)?;
    Ok((
        rows,
        WriteSummary {
            bytes,
            warnings: summary.warnings,
        },
    ))
}

/// A chunk of file records holds at most this many records...
const IMPORT_CHUNK_ROWS: usize = 1_000;
/// ...or about this many bytes of values.
const IMPORT_CHUNK_BYTES: usize = 8 * 1024 * 1024;
/// At most this many bytes of chunks are out at once, the chunk being written included,
/// besides the channel's count of 2 (Q45): a record may be 16 MB, so a count alone would
/// let a few large ones pass the memory budget (ADR 0003).
const IMPORT_IN_FLIGHT_BYTES: usize = 32 * 1024 * 1024;

/// The bytes of the chunks the reader has sent and the statement loop still holds.
#[derive(Default)]
struct Budget {
    held: Mutex<usize>,
    freed: Condvar,
}

impl Budget {
    /// Waits until `bytes` more fit (always when nothing is out), then counts them. False
    /// when the job is cancelled or the statement loop is gone meanwhile.
    fn take(&self, bytes: usize, cancel: &AtomicBool, gone: impl Fn() -> bool) -> bool {
        let mut held = self.held.lock().unwrap_or_else(PoisonError::into_inner);
        while *held > 0 && *held + bytes > IMPORT_IN_FLIGHT_BYTES {
            if cancel.load(Ordering::SeqCst) || gone() {
                return false;
            }
            held = self
                .freed
                .wait_timeout(held, Duration::from_millis(50))
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        *held += bytes;
        true
    }
}

/// A chunk's share of the in-flight bytes, given back when the chunk is dropped.
pub(crate) struct Held {
    budget: Arc<Budget>,
    bytes: usize,
}

impl Drop for Held {
    fn drop(&mut self) {
        let mut held = self
            .budget
            .held
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        *held = held.saturating_sub(self.bytes);
        drop(held);
        self.budget.freed.notify_all();
    }
}

/// What an import's file reader sends to its statement loop.
pub(crate) enum FileMsg {
    /// Up to 1,000 records or 8 MB, with the bytes read so far and new reader warnings.
    /// `held` keeps the chunk's bytes counted until the statement loop drops it.
    Rows {
        records: Vec<FileRecord>,
        bytes_read: u64,
        warnings: Vec<String>,
        held: Held,
    },
    /// The whole file was read: its SHA-256 (Q3) and size.
    End {
        sha256: Option<[u8; 32]>,
        bytes_read: u64,
        warnings: Vec<String>,
    },
    Failed(Error),
}

fn record_bytes(r: &FileRecord) -> usize {
    r.values
        .iter()
        .map(|v| v.as_ref().map_or(1, String::len) + 8)
        .sum()
}

/// The import's read side (Task 8): a thread that reads `reader` record by record and
/// sends chunks of up to 1,000 records or 8 MB through a channel of 2, with at most 32 MB
/// of chunks out at once (Q45), starting with `first` when the caller already took it.
/// The thread stops at the next record once `cancel` is set or the receiver is gone, and
/// drops the reader as it ends; joining the handle waits until the reader has let go of
/// its file.
pub(crate) fn import_pipeline(
    mut reader: Box<dyn RecordReader>,
    first: Option<FileRecord>,
    cancel: Arc<AtomicBool>,
) -> Result<(mpsc::Receiver<FileMsg>, std::thread::JoinHandle<()>)> {
    let (tx, rx) = mpsc::channel::<FileMsg>(2);
    let budget = Arc::new(Budget::default());
    let handle = std::thread::Builder::new()
        .name("import-reader".into())
        .spawn(move || {
            let mut chunk: Vec<FileRecord> = Vec::new();
            let mut bytes = 0usize;
            let mut pending = first;
            let send_rows =
                |records: Vec<FileRecord>, bytes: usize, bytes_read: u64, warnings| -> bool {
                    if !budget.take(bytes, &cancel, || tx.is_closed()) {
                        return false;
                    }
                    let held = Held {
                        budget: budget.clone(),
                        bytes,
                    };
                    let msg = FileMsg::Rows {
                        records,
                        bytes_read,
                        warnings,
                        held,
                    };
                    tx.blocking_send(msg).is_ok()
                };
            loop {
                if cancel.load(Ordering::SeqCst) {
                    return;
                }
                let next = match pending.take() {
                    Some(r) => Ok(Some(r)),
                    None => reader.next_record(),
                };
                match next {
                    Ok(Some(record)) => {
                        bytes += record_bytes(&record);
                        chunk.push(record);
                        if chunk.len() >= IMPORT_CHUNK_ROWS || bytes >= IMPORT_CHUNK_BYTES {
                            let records = std::mem::take(&mut chunk);
                            let size = std::mem::take(&mut bytes);
                            let (read, warnings) = (reader.bytes_read(), reader.warnings());
                            if !send_rows(records, size, read, warnings) {
                                return;
                            }
                        }
                    }
                    Ok(None) => {
                        if !chunk.is_empty() {
                            let records = std::mem::take(&mut chunk);
                            if !send_rows(records, bytes, reader.bytes_read(), Vec::new()) {
                                return;
                            }
                        }
                        let _ = tx.blocking_send(FileMsg::End {
                            sha256: reader.sha256(),
                            bytes_read: reader.bytes_read(),
                            warnings: reader.warnings(),
                        });
                        return;
                    }
                    Err(e) => {
                        let _ = tx.blocking_send(FileMsg::Failed(e));
                        return;
                    }
                }
            }
        })
        .map_err(|e| Error::File(format!("cannot start the import's reader: {e}")))?;
    Ok((rx, handle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::formats::csv::CsvWriter;
    use crate::jobs::paths::{PartialFile, PartialWriter, PathUse, outside_data};
    use crate::jobs::source::{SourceColumn, Value, ValueKind};
    use crate::jobs::types::{ExportOptions, JobId, JobKind};
    use crate::jobs::{JobService, JobSink};
    use crate::model::ConnectionId;
    use crate::query::Canceller;
    use crate::store::AppStore;
    use std::collections::VecDeque;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    /// The pipeline with a counter nobody reads.
    async fn export_pipeline(
        source: Box<dyn RowSource>,
        writer: Box<dyn FormatWriter>,
        ctx: &JobCtx,
        rows_total: Option<u64>,
    ) -> Result<(u64, WriteSummary)> {
        export_pipeline_counted(source, writer, ctx, rows_total, &AtomicU64::new(0)).await
    }

    struct NoServer;

    #[async_trait::async_trait]
    impl Canceller for NoServer {
        async fn cancel(&self) -> Result<()> {
            Ok(())
        }
    }

    /// Hands out the chunks it was given, then whatever end it was given.
    struct Scripted {
        columns: Vec<SourceColumn>,
        steps: VecDeque<Result<Option<Chunk>>>,
    }

    #[async_trait::async_trait]
    impl RowSource for Scripted {
        fn columns(&self) -> &[SourceColumn] {
            &self.columns
        }
        async fn next_chunk(&mut self) -> Result<Option<Chunk>> {
            self.steps.pop_front().unwrap_or(Ok(None))
        }
        fn estimate(&self) -> Option<u64> {
            None
        }
        fn sql(&self) -> &str {
            "SELECT n FROM t"
        }
        fn canceller(&self) -> Arc<dyn Canceller> {
            Arc::new(NoServer)
        }
    }

    struct Quiet;

    impl JobSink for Quiet {
        fn send(&self, _: serde_json::Value) {}
    }

    fn chunk(from: u64, n: u64) -> Chunk {
        Chunk {
            rows: (from..from + n)
                .map(|i| vec![Value::Number(i.to_string())])
                .collect(),
            bytes: n as usize,
        }
    }

    fn source(steps: Vec<Result<Option<Chunk>>>) -> Box<dyn RowSource> {
        Box::new(Scripted {
            columns: vec![SourceColumn {
                name: "n".into(),
                type_name: "int".into(),
                kind: ValueKind::Integer,
            }],
            steps: steps.into(),
        })
    }

    struct Out {
        _dir: tempfile::TempDir,
        target: PathBuf,
    }

    impl Out {
        fn new() -> Out {
            let dir = tempfile::tempdir().unwrap();
            let target = dir.path().join("out.csv");
            Out { _dir: dir, target }
        }
        fn partial(&self) -> PathBuf {
            PathBuf::from(format!("{}.partial", self.target.display()))
        }
        fn writer(&self) -> PartialWriter {
            PartialFile::create(&self.target, false, PathUse::Export, &outside_data())
                .unwrap()
                .writer()
        }
        fn csv(&self) -> Box<dyn FormatWriter> {
            Box::new(CsvWriter::new(self.writer(), &ExportOptions::default()))
        }
        fn nothing_left(&self) {
            assert!(!self.target.exists(), "the file was committed");
            assert!(!self.partial().exists(), "the partial was left behind");
        }
    }

    fn service() -> (JobService, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
        (JobService::new(Arc::new(Mutex::new(store))), dir)
    }

    fn ctx(s: &JobService) -> JobCtx {
        s.start(
            JobId::new_v4(),
            JobKind::Export,
            ConnectionId::nil(),
            "kestrel",
            "Exporting t".into(),
            false,
            Arc::new(Quiet),
        )
        .unwrap()
    }

    fn exists(p: &Path) -> bool {
        p.exists()
    }

    #[tokio::test]
    async fn a_clean_read_commits() {
        let (s, _d) = service();
        let out = Out::new();
        let ctx = ctx(&s);
        let (rows, summary) = export_pipeline(
            source(vec![Ok(Some(chunk(1, 3))), Ok(Some(chunk(4, 2))), Ok(None)]),
            out.csv(),
            &ctx,
            None,
        )
        .await
        .expect("export");
        assert_eq!(rows, 5);
        let text = std::fs::read_to_string(&out.target).unwrap();
        assert_eq!(text, "n\r\n1\r\n2\r\n3\r\n4\r\n5\r\n");
        assert_eq!(summary.bytes, text.len() as u64);
        assert!(!exists(&out.partial()));
    }

    #[tokio::test]
    async fn read_stopped_never_commits() {
        let (s, _d) = service();
        let out = Out::new();
        let ctx = ctx(&s);
        let err = export_pipeline(
            source(vec![Ok(Some(chunk(1, 3))), Err(Error::ReadStopped)]),
            out.csv(),
            &ctx,
            None,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, Error::ReadStopped), "{err:?}");
        assert_eq!(
            err.to_string(),
            "The read stopped unexpectedly. Nothing more was written."
        );
        out.nothing_left();
    }

    #[tokio::test]
    async fn any_read_error_never_commits() {
        let (s, _d) = service();
        let out = Out::new();
        let ctx = ctx(&s);
        let err = export_pipeline(
            source(vec![
                Ok(Some(chunk(1, 3))),
                Err(Error::Query("division by zero".into())),
            ]),
            out.csv(),
            &ctx,
            None,
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, Error::Query(ref m) if m == "division by zero"),
            "{err:?}"
        );
        out.nothing_left();
    }

    /// Fails on its second chunk.
    struct Failing {
        out: PartialWriter,
        chunks: u32,
    }

    impl FormatWriter for Failing {
        fn begin(&mut self, _: &[SourceColumn]) -> Result<()> {
            Ok(())
        }
        fn write_chunk(&mut self, _: &Chunk) -> Result<()> {
            self.chunks += 1;
            if self.chunks == 2 {
                return Err(Error::File(
                    "cannot write the file: the disk is full".into(),
                ));
            }
            Ok(())
        }
        fn summary(&self) -> WriteSummary {
            WriteSummary::default()
        }
        fn finish(self: Box<Self>) -> Result<PartialWriter> {
            Ok(self.out)
        }
    }

    #[tokio::test]
    async fn a_write_error_never_commits() {
        let (s, _d) = service();
        let out = Out::new();
        let ctx = ctx(&s);
        let steps = (0..10).map(|i| Ok(Some(chunk(i * 10, 10)))).collect();
        let err = export_pipeline(
            source(steps),
            Box::new(Failing {
                out: out.writer(),
                chunks: 0,
            }),
            &ctx,
            None,
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, Error::File(ref m) if m.contains("disk is full")),
            "{err:?}"
        );
        out.nothing_left();
    }

    #[tokio::test]
    async fn a_cancel_never_commits() {
        let (s, _d) = service();
        let out = Out::new();
        let ctx = ctx(&s);
        s.cancel(ctx.id).await.unwrap();
        let err = export_pipeline(
            source(vec![Ok(Some(chunk(1, 3))), Ok(None)]),
            out.csv(),
            &ctx,
            None,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, Error::Cancelled), "{err:?}");
        out.nothing_left();
    }

    /// Its first chunk arrives; then the job is cancelled and the read stops with no end
    /// mark, as a producer that saw the cancel does.
    struct CancelThenStop {
        columns: Vec<SourceColumn>,
        flag: Arc<std::sync::atomic::AtomicBool>,
        calls: u32,
    }

    #[async_trait::async_trait]
    impl RowSource for CancelThenStop {
        fn columns(&self) -> &[SourceColumn] {
            &self.columns
        }
        async fn next_chunk(&mut self) -> Result<Option<Chunk>> {
            self.calls += 1;
            if self.calls == 1 {
                return Ok(Some(chunk(1, 3)));
            }
            self.flag.store(true, Ordering::SeqCst);
            Err(Error::ReadStopped)
        }
        fn estimate(&self) -> Option<u64> {
            None
        }
        fn sql(&self) -> &str {
            "SELECT n FROM t"
        }
        fn canceller(&self) -> Arc<dyn Canceller> {
            Arc::new(NoServer)
        }
    }

    fn one_column() -> Vec<SourceColumn> {
        vec![SourceColumn {
            name: "n".into(),
            type_name: "int".into(),
            kind: ValueKind::Integer,
        }]
    }

    #[tokio::test]
    async fn a_cancel_during_the_read_is_a_cancel() {
        let (s, _d) = service();
        let out = Out::new();
        let ctx = ctx(&s);
        let src = Box::new(CancelThenStop {
            columns: one_column(),
            flag: ctx.cancel_flag().clone(),
            calls: 0,
        });
        let err = export_pipeline(src, out.csv(), &ctx, None)
            .await
            .unwrap_err();
        assert!(matches!(err, Error::Cancelled), "{err:?}");
        out.nothing_left();
    }

    /// Sets the cancel flag while it finishes, as a cancel during a long zip step does.
    struct CancelOnFinish {
        inner: CsvWriter<PartialWriter>,
        flag: Arc<std::sync::atomic::AtomicBool>,
    }

    impl FormatWriter for CancelOnFinish {
        fn begin(&mut self, c: &[SourceColumn]) -> Result<()> {
            self.inner.begin(c)
        }
        fn write_chunk(&mut self, c: &Chunk) -> Result<()> {
            self.inner.write_chunk(c)
        }
        fn summary(&self) -> WriteSummary {
            self.inner.summary()
        }
        fn finish(self: Box<Self>) -> Result<PartialWriter> {
            self.flag.store(true, Ordering::SeqCst);
            Box::new(self.inner).finish()
        }
    }

    #[tokio::test]
    async fn a_cancel_during_finish_never_commits() {
        let (s, _d) = service();
        let out = Out::new();
        let ctx = ctx(&s);
        let writer = Box::new(CancelOnFinish {
            inner: CsvWriter::new(out.writer(), &ExportOptions::default()),
            flag: ctx.cancel_flag().clone(),
        });
        let err = export_pipeline(
            source(vec![Ok(Some(chunk(1, 3))), Ok(None)]),
            writer,
            &ctx,
            None,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, Error::Cancelled), "{err:?}");
        out.nothing_left();
    }

    /// Hands out `n` one-value records, then the end (or a failure).
    struct Records {
        n: u64,
        at: u64,
        fail: bool,
    }

    impl RecordReader for Records {
        fn columns(&self) -> &[String] {
            &[]
        }
        fn next_record(&mut self) -> Result<Option<FileRecord>> {
            if self.at == self.n {
                if self.fail {
                    return Err(Error::File("Line 9 has 2 values; the header has 1.".into()));
                }
                return Ok(None);
            }
            self.at += 1;
            Ok(Some(FileRecord {
                row: self.at,
                line: self.at + 1,
                values: vec![Some(self.at.to_string())],
            }))
        }
        fn bytes_read(&self) -> u64 {
            self.at
        }
        fn warnings(&mut self) -> Vec<String> {
            Vec::new()
        }
        fn sha256(&self) -> Option<[u8; 32]> {
            (self.at == self.n).then_some([7; 32])
        }
    }

    #[tokio::test]
    async fn import_reader_sends_chunks_then_the_end() {
        let first = FileRecord {
            row: 0,
            line: 1,
            values: vec![Some("first".into())],
        };
        let reader = Box::new(Records {
            n: 2_500,
            at: 0,
            fail: false,
        });
        let (mut rx, _) =
            import_pipeline(reader, Some(first), Arc::new(AtomicBool::new(false))).unwrap();
        let mut sizes = Vec::new();
        let mut rows = Vec::new();
        loop {
            match rx.recv().await.expect("a message") {
                FileMsg::Rows { records, .. } => {
                    sizes.push(records.len());
                    rows.extend(records.into_iter().map(|r| r.row));
                }
                FileMsg::End {
                    sha256, bytes_read, ..
                } => {
                    assert_eq!(sha256, Some([7; 32]));
                    assert_eq!(bytes_read, 2_500);
                    break;
                }
                FileMsg::Failed(e) => panic!("{e:?}"),
            }
        }
        assert_eq!(sizes, [1_000, 1_000, 501]);
        assert_eq!(rows[0], 0, "the record taken first leads");
        assert_eq!(rows[2_500], 2_500);
    }

    /// Hands out `n` records of one `size`-byte value.
    struct Big {
        n: u64,
        at: u64,
        size: usize,
    }

    impl RecordReader for Big {
        fn columns(&self) -> &[String] {
            &[]
        }
        fn next_record(&mut self) -> Result<Option<FileRecord>> {
            if self.at == self.n {
                return Ok(None);
            }
            self.at += 1;
            Ok(Some(FileRecord {
                row: self.at,
                line: self.at,
                values: vec![Some("x".repeat(self.size))],
            }))
        }
        fn bytes_read(&self) -> u64 {
            self.at * self.size as u64
        }
        fn warnings(&mut self) -> Vec<String> {
            Vec::new()
        }
        fn sha256(&self) -> Option<[u8; 32]> {
            (self.at == self.n).then_some([7; 32])
        }
    }

    /// Q45 I3: at most 32 MB of chunks are in flight, the one being written included, so
    /// with 12 MB records only two chunks are out while the first is still held.
    #[tokio::test]
    async fn import_reader_keeps_32mb_in_flight() {
        let reader = Box::new(Big {
            n: 6,
            at: 0,
            size: 12 * 1024 * 1024,
        });
        let (mut rx, _) = import_pipeline(reader, None, Arc::new(AtomicBool::new(false))).unwrap();
        let held = rx.recv().await.expect("the first chunk");
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let mut queued = Vec::new();
        while let Ok(msg) = rx.try_recv() {
            queued.push(msg);
        }
        assert_eq!(queued.len(), 1, "chunks out while the first is held");
        let mut rows = 1 + queued.len();
        drop(held);
        drop(queued);
        loop {
            match rx.recv().await.expect("a message") {
                FileMsg::Rows { records, .. } => rows += records.len(),
                FileMsg::End { .. } => break,
                FileMsg::Failed(e) => panic!("{e:?}"),
            }
        }
        assert_eq!(rows, 6, "every record arrives once the budget frees");
    }

    #[tokio::test]
    async fn import_reader_reports_a_file_error_and_stops_on_cancel() {
        let reader = Box::new(Records {
            n: 10,
            at: 0,
            fail: true,
        });
        let (mut rx, _) = import_pipeline(reader, None, Arc::new(AtomicBool::new(false))).unwrap();
        // The job fails on it, so the rows read before it are not sent.
        assert!(matches!(
            rx.recv().await,
            Some(FileMsg::Failed(Error::File(_)))
        ));
        assert!(rx.recv().await.is_none());

        let cancel = Arc::new(AtomicBool::new(true));
        let reader = Box::new(Records {
            n: 10,
            at: 0,
            fail: false,
        });
        let (mut rx, _) = import_pipeline(reader, None, cancel).unwrap();
        assert!(rx.recv().await.is_none(), "a cancelled read sends nothing");
    }

    #[tokio::test]
    async fn rows_written_so_far_are_counted_on_failure() {
        let (s, _d) = service();
        let out = Out::new();
        let ctx = ctx(&s);
        let written = AtomicU64::new(0);
        let err = export_pipeline_counted(
            source(vec![
                Ok(Some(chunk(1, 3))),
                Ok(Some(chunk(4, 2))),
                Err(Error::Query("boom".into())),
            ]),
            out.csv(),
            &ctx,
            None,
            &written,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, Error::Query(_)));
        assert_eq!(written.load(Ordering::SeqCst), 5);
        out.nothing_left();
    }
}
