//! Import and export jobs: the Job service that runs them, limits them, cancels them
//! and reports their progress to whoever watches.

pub mod checks;
pub mod fingerprint;
pub mod formats;
pub mod insert;
pub mod limits;
pub mod mapping;
pub mod paths;
pub mod pipeline;
pub mod script;
pub mod source;
pub mod types;
pub mod writer;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::error::{Error, Result};
use crate::model::ConnectionId;
use crate::query::{Canceller, NewHistory};
use crate::safety::PassId;
use crate::store::AppStore;

use types::{JobEvent, JobId, JobKind, JobProgress, JobReport, JobSummary};

/// Where a job's events go: a Tauri channel in the app, a recorder in tests.
pub trait JobSink: Send + Sync {
    fn send(&self, event: serde_json::Value);
}

/// The file a Production import was confirmed for (D5).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileIdentity {
    pub path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
}

/// Four jobs at once in all (D13).
const MAX_JOBS: usize = 4;
/// Progress events are sent at most this often.
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
/// Final events kept for `attach` after a job ends.
const FINISHED_KEPT: usize = 32;

struct Running {
    summary: JobSummary,
    writes: bool,
    cancel: Arc<AtomicBool>,
    canceller: Option<Arc<dyn Canceller>>,
    /// The current canceller has been called; each one is called at most once.
    cancel_called: bool,
    sinks: Vec<Arc<dyn JobSink>>,
    /// The latest progress, sent or not, for `attach`.
    last_progress: Option<serde_json::Value>,
    last_sent: Option<Instant>,
}

#[derive(Default)]
struct State {
    running: HashMap<JobId, Running>,
    finished: VecDeque<(JobId, serde_json::Value)>,
    confirmed: HashMap<PassId, FileIdentity>,
}

struct Shared {
    state: Mutex<State>,
    store: Arc<Mutex<AppStore>>,
}

impl Shared {
    fn state(&self) -> Result<MutexGuard<'_, State>> {
        self.state
            .lock()
            .map_err(|_| Error::Store("lock poisoned".into()))
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The event as JSON. One that cannot be written (a path that is not UTF-8) goes out as a
/// failure the page can read, never as `null`.
fn to_json(event: &JobEvent) -> serde_json::Value {
    serde_json::to_value(event).unwrap_or_else(|e| {
        serde_json::json!({
            "kind": "failed",
            "error": { "kind": "query", "message": format!("the job's event could not be sent: {e}") },
        })
    })
}

/// Runs the import and export jobs: at most four, one writing job per Connection.
/// The state lock is never held while an event is sent or a canceller runs.
pub struct JobService {
    shared: Arc<Shared>,
}

impl JobService {
    pub fn new(store: Arc<Mutex<AppStore>>) -> Self {
        Self {
            shared: Arc::new(Shared {
                state: Mutex::new(State::default()),
                store,
            }),
        }
    }

    /// Registers job `id` (made by the client, so it can watch before the start, Q2) and
    /// hands back its context. A fifth job is refused with `InvalidInput`; a second
    /// writing job on one Connection with `JobBusy` (D13).
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &self,
        id: JobId,
        kind: JobKind,
        connection_id: ConnectionId,
        connection_name: &str,
        label: String,
        writes: bool,
        sink: Arc<dyn JobSink>,
    ) -> Result<JobCtx> {
        let mut st = self.shared.state()?;
        if st.running.contains_key(&id) || st.finished.iter().any(|(f, _)| *f == id) {
            return Err(Error::InvalidInput("That job has already started.".into()));
        }
        if st.running.len() >= MAX_JOBS {
            return Err(Error::InvalidInput(
                "Four jobs are running. Wait for one to end.".into(),
            ));
        }
        if writes
            && st
                .running
                .values()
                .any(|r| r.writes && r.summary.connection_id == connection_id)
        {
            return Err(Error::JobBusy {
                connection: connection_name.to_string(),
            });
        }
        let cancel = Arc::new(AtomicBool::new(false));
        st.running.insert(
            id,
            Running {
                summary: JobSummary {
                    id,
                    kind,
                    connection_id,
                    label,
                    percent: None,
                    started_at_ms: now_ms(),
                },
                writes,
                cancel: cancel.clone(),
                canceller: None,
                cancel_called: false,
                sinks: vec![sink],
                last_progress: None,
                last_sent: None,
            },
        );
        Ok(JobCtx {
            id,
            kind,
            shared: self.shared.clone(),
            cancel,
            done: false,
        })
    }

    /// Sets the job's cancel flag and stops its running server call. A job that has
    /// already ended is left alone.
    pub async fn cancel(&self, id: JobId) -> Result<()> {
        let canceller = {
            let mut st = self.shared.state()?;
            let Some(r) = st.running.get_mut(&id) else {
                return Ok(());
            };
            r.cancel.store(true, Ordering::SeqCst);
            match &r.canceller {
                Some(c) if !r.cancel_called => {
                    r.cancel_called = true;
                    Some(c.clone())
                }
                _ => None,
            }
        };
        if let Some(c) = canceller {
            // The flag already stops the job at its next chunk; a failed server cancel
            // only means the current statement runs to its end.
            let _ = c.cancel().await;
        }
        Ok(())
    }

    fn summaries(&self, keep: impl Fn(&JobSummary) -> bool) -> Vec<JobSummary> {
        let Ok(st) = self.shared.state() else {
            return Vec::new();
        };
        let mut out: Vec<JobSummary> = st
            .running
            .values()
            .map(|r| r.summary.clone())
            .filter(|s| keep(s))
            .collect();
        out.sort_by_key(|s| s.started_at_ms);
        out
    }

    /// The running jobs, oldest first.
    pub fn list(&self) -> Vec<JobSummary> {
        self.summaries(|_| true)
    }

    /// Adds a watcher and sends it the last progress, or the final event, at once.
    pub fn attach(&self, id: JobId, sink: Arc<dyn JobSink>) -> Result<()> {
        let replay = {
            let mut st = self.shared.state()?;
            if let Some(r) = st.running.get_mut(&id) {
                r.sinks.push(sink.clone());
                r.last_progress.clone()
            } else if let Some((_, last)) = st.finished.iter().find(|(f, _)| *f == id) {
                Some(last.clone())
            } else {
                return Err(Error::NotFound("That job has ended.".into()));
            }
        };
        if let Some(event) = replay {
            sink.send(event);
        }
        Ok(())
    }

    /// The running jobs on Connection `c`, oldest first.
    pub fn running_on(&self, c: ConnectionId) -> Vec<JobSummary> {
        self.summaries(|s| s.connection_id == c)
    }

    /// Cancels every job on Connection `c` (closing or deleting it).
    pub async fn cancel_on(&self, c: ConnectionId) {
        for s in self.running_on(c) {
            let _ = self.cancel(s.id).await;
        }
    }

    /// Cancels every running job, such as when the app quits (Q22). Every flag is set
    /// first, then the server cancels run side by side.
    pub async fn cancel_all(&self) {
        let cancellers: Vec<Arc<dyn Canceller>> = {
            let Ok(mut st) = self.shared.state() else {
                return;
            };
            st.running
                .values_mut()
                .filter_map(|r| {
                    r.cancel.store(true, Ordering::SeqCst);
                    match &r.canceller {
                        Some(c) if !r.cancel_called => {
                            r.cancel_called = true;
                            Some(c.clone())
                        }
                        _ => None,
                    }
                })
                .collect()
        };
        let tasks: Vec<_> = cancellers
            .into_iter()
            .map(|c| tokio::spawn(async move { c.cancel().await }))
            .collect();
        for t in tasks {
            let _ = t.await;
        }
    }

    /// Records the file a pass was confirmed for (D5).
    pub fn confirm_file(&self, pass: PassId, file: FileIdentity) {
        if let Ok(mut st) = self.shared.state() {
            st.confirmed.insert(pass, file);
        }
    }

    /// Drops the file a pass was confirmed for: the pass was replaced, or start used it.
    pub fn forget_file(&self, pass: PassId) {
        if let Ok(mut st) = self.shared.state() {
            st.confirmed.remove(&pass);
        }
    }

    pub fn confirmed_file(&self, pass: PassId) -> Option<FileIdentity> {
        self.shared.state().ok()?.confirmed.get(&pass).cloned()
    }
}

fn send_progress(shared: &Shared, id: JobId, p: JobProgress, now_anyway: bool) {
    let percent = p.percent();
    let json = to_json(&JobEvent::from(p));
    let sinks = {
        let Ok(mut st) = shared.state() else {
            return;
        };
        let Some(r) = st.running.get_mut(&id) else {
            return;
        };
        r.summary.percent = percent;
        r.last_progress = Some(json.clone());
        let now = Instant::now();
        let due = now_anyway
            || r.last_sent
                .is_none_or(|t| now.duration_since(t) >= PROGRESS_EVERY);
        if !due {
            return;
        }
        r.last_sent = Some(now);
        r.sinks.clone()
    };
    for s in sinks {
        s.send(json.clone());
    }
}

/// Sends one job's progress and nothing else; see `JobCtx::reporter`.
#[derive(Clone)]
pub struct JobReporter {
    id: JobId,
    shared: Arc<Shared>,
}

impl JobReporter {
    /// As `JobCtx::progress_now`.
    pub fn progress_now(&self, p: JobProgress) {
        send_progress(&self.shared, self.id, p, true);
    }
}

/// One running job's handle, moved into the task that does the work. `finish` ends it;
/// dropped without `finish`, the job fails and leaves the running list all the same.
pub struct JobCtx {
    pub id: JobId,
    kind: JobKind,
    shared: Arc<Shared>,
    cancel: Arc<AtomicBool>,
    done: bool,
}

impl JobCtx {
    pub fn kind(&self) -> JobKind {
        self.kind
    }

    /// Sends `event` to every watcher, outside the lock.
    fn send(&self, event: &JobEvent) {
        let sinks = match self.shared.state() {
            Ok(st) => match st.running.get(&self.id) {
                Some(r) => r.sinks.clone(),
                None => return,
            },
            Err(_) => return,
        };
        let json = to_json(event);
        for s in sinks {
            s.send(json.clone());
        }
    }

    /// Sent at most every 100 ms; the latest is always kept for `attach`.
    pub fn progress(&self, p: JobProgress) {
        self.send_progress(p, false);
    }

    /// Sent whatever the 100 ms limit says: a step's last event (a table's end).
    pub fn progress_now(&self, p: JobProgress) {
        self.send_progress(p, true);
    }

    fn send_progress(&self, p: JobProgress, now_anyway: bool) {
        send_progress(&self.shared, self.id, p, now_anyway);
    }

    /// A handle that only sends this job's progress, for a callback that must own
    /// what it holds (a statement runner's progress, R4).
    pub fn reporter(&self) -> JobReporter {
        JobReporter {
            id: self.id,
            shared: self.shared.clone(),
        }
    }

    pub fn warning(&self, message: String) {
        self.send(&JobEvent::Warning { message });
    }

    pub fn skipped(&self, file_row: u64, column: Option<String>, message: String) {
        self.send(&JobEvent::RowSkipped {
            file_row,
            column,
            message,
        });
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// The flag itself, for loops that check it without the context (`file_sha256`).
    pub fn cancel_flag(&self) -> &Arc<AtomicBool> {
        &self.cancel
    }

    /// The server call to stop on cancel; replaces any earlier one. Each canceller is
    /// called at most once (setting the same one again changes nothing). When the job was
    /// cancelled before this, it is called at once on the running Tokio runtime; with no
    /// runtime it is not called, and the cancel flag alone stops the job at its next check.
    pub fn set_canceller(&self, canceller: Arc<dyn Canceller>) {
        let call = {
            let Ok(mut st) = self.shared.state() else {
                return;
            };
            let Some(r) = st.running.get_mut(&self.id) else {
                return;
            };
            let same = r
                .canceller
                .as_ref()
                .is_some_and(|c| std::ptr::addr_eq(Arc::as_ptr(c), Arc::as_ptr(&canceller)));
            if !same {
                r.canceller = Some(canceller.clone());
                r.cancel_called = false;
            }
            let runtime = tokio::runtime::Handle::try_current().ok();
            match runtime {
                Some(rt) if self.is_cancelled() && !r.cancel_called => {
                    r.cancel_called = true;
                    Some(rt)
                }
                _ => None,
            }
        };
        if let Some(rt) = call {
            rt.spawn(async move {
                let _ = canceller.cancel().await;
            });
        }
    }

    /// Adds a Query History entry. History is a record: a store failure is ignored.
    pub fn history(&self, entry: NewHistory) {
        if let Ok(store) = self.shared.store.lock() {
            let _ = store.add_history(&entry);
        }
    }

    /// Sends `event` as the final one, keeps it for `attach`, and leaves the running list.
    fn end(&mut self, event: JobEvent) {
        if self.done {
            return;
        }
        self.done = true;
        let json = to_json(&event);
        let sinks = {
            let Ok(mut st) = self.shared.state() else {
                return;
            };
            let sinks = st
                .running
                .remove(&self.id)
                .map(|r| r.sinks)
                .unwrap_or_default();
            st.finished.push_back((self.id, json.clone()));
            while st.finished.len() > FINISHED_KEPT {
                st.finished.pop_front();
            }
            sinks
        };
        for s in sinks {
            s.send(json.clone());
        }
    }

    /// Leaves the running list without a final event, for a start refused before its run
    /// began (the start call itself returns the error). The id is not kept as ended.
    pub fn discard(mut self) {
        self.done = true;
        if let Ok(mut st) = self.shared.state() {
            st.running.remove(&self.id);
        }
    }

    /// Sends `Finished` or `Failed` once and leaves the running list.
    pub fn finish(mut self, result: Result<JobReport>) {
        let event = match result {
            Ok(report) => JobEvent::Finished { report },
            Err(error) => JobEvent::Failed {
                error,
                rows_committed: None,
            },
        };
        self.end(event);
    }

    /// Sends `Failed` once with the rows the job left in its target (Q27), and leaves
    /// the running list.
    pub fn fail(mut self, error: Error, rows_committed: u64) {
        self.end(JobEvent::Failed {
            error,
            rows_committed: Some(rows_committed),
        });
    }
}

impl Drop for JobCtx {
    fn drop(&mut self) {
        let error = if self.is_cancelled() {
            Error::Cancelled
        } else {
            Error::Query("the job stopped before it finished".into())
        };
        self.end(JobEvent::Failed {
            error,
            rows_committed: None,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::types::JobPhase;
    use std::sync::atomic::AtomicUsize;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<serde_json::Value>>);

    impl JobSink for Recorder {
        fn send(&self, event: serde_json::Value) {
            self.0.lock().unwrap().push(event);
        }
    }

    impl Recorder {
        fn kinds(&self) -> Vec<String> {
            self.0
                .lock()
                .unwrap()
                .iter()
                .map(|e| e["kind"].as_str().unwrap_or("").to_string())
                .collect()
        }
        fn last(&self) -> serde_json::Value {
            self.0.lock().unwrap().last().cloned().unwrap()
        }
    }

    #[derive(Default)]
    struct CountCancel(AtomicUsize);

    #[async_trait::async_trait]
    impl Canceller for CountCancel {
        async fn cancel(&self) -> Result<()> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn service() -> (JobService, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
        (JobService::new(Arc::new(Mutex::new(store))), dir)
    }

    fn rec() -> Arc<Recorder> {
        Arc::new(Recorder::default())
    }

    fn start(s: &JobService, c: ConnectionId, writes: bool, sink: Arc<Recorder>) -> Result<JobCtx> {
        let kind = if writes {
            JobKind::Import
        } else {
            JobKind::Export
        };
        s.start(
            JobId::new_v4(),
            kind,
            c,
            "kestrel-main",
            "Exporting orders".into(),
            writes,
            sink,
        )
    }

    fn rows(done: u64, total: u64) -> JobProgress {
        JobProgress {
            phase: JobPhase::Writing,
            rows_done: done,
            rows_total: Some(total),
            ..Default::default()
        }
    }

    #[test]
    fn fifth_job_refused() {
        let (s, _d) = service();
        let jobs: Vec<JobCtx> = (0..4)
            .map(|_| start(&s, ConnectionId::new_v4(), false, rec()).unwrap())
            .collect();
        assert_eq!(s.list().len(), 4);
        match start(&s, ConnectionId::new_v4(), false, rec()) {
            Err(Error::InvalidInput(m)) => {
                assert_eq!(m, "Four jobs are running. Wait for one to end.")
            }
            Err(e) => panic!("expected InvalidInput, got {e:?}"),
            Ok(_) => panic!("a fifth job started"),
        }
        let mut jobs = jobs.into_iter();
        jobs.next().unwrap().finish(Ok(JobReport::default()));
        assert!(start(&s, ConnectionId::new_v4(), false, rec()).is_ok());
    }

    #[test]
    fn second_writing_job_same_connection_is_job_busy() {
        let (s, _d) = service();
        let c = ConnectionId::new_v4();
        let _first = start(&s, c, true, rec()).unwrap();
        match start(&s, c, true, rec()) {
            Err(Error::JobBusy { connection }) => assert_eq!(connection, "kestrel-main"),
            Err(e) => panic!("expected JobBusy, got {e:?}"),
            Ok(_) => panic!("a second writing job started"),
        }
        // A reading job on it, and a writing job elsewhere, still start.
        assert!(start(&s, c, false, rec()).is_ok());
        assert!(start(&s, ConnectionId::new_v4(), true, rec()).is_ok());
    }

    #[test]
    fn reading_jobs_not_limited_per_connection() {
        let (s, _d) = service();
        let c = ConnectionId::new_v4();
        let _a = start(&s, c, false, rec()).unwrap();
        let _b = start(&s, c, false, rec()).unwrap();
        let _w = start(&s, c, true, rec()).unwrap();
        assert_eq!(s.running_on(c).len(), 3);
    }

    #[test]
    fn progress_throttled() {
        let (s, _d) = service();
        let sink = rec();
        let job = start(&s, ConnectionId::new_v4(), false, sink.clone()).unwrap();
        let t = Instant::now();
        for i in 1..=50 {
            job.progress(rows(i, 100));
        }
        assert!(t.elapsed() < Duration::from_millis(10), "the loop was slow");
        assert_eq!(sink.kinds(), vec!["progress"]);
        assert_eq!(sink.last()["rowsDone"], 1);
        // The list shows the latest percent even when its event was held back.
        assert_eq!(s.list()[0].percent, Some(50));
        job.finish(Ok(JobReport::default()));
        assert_eq!(sink.kinds(), vec!["progress", "finished"]);
    }

    #[test]
    fn warnings_and_skipped_rows_are_not_throttled() {
        let (s, _d) = service();
        let sink = rec();
        let job = start(&s, ConnectionId::new_v4(), true, sink.clone()).unwrap();
        job.progress(rows(1, 10));
        job.warning("w".into());
        job.skipped(7, Some("price".into()), "n/a is not a number".into());
        assert_eq!(sink.kinds(), vec!["progress", "warning", "rowSkipped"]);
        assert_eq!(sink.last()["fileRow"], 7);
    }

    #[tokio::test]
    async fn cancel_sets_flag_and_calls_canceller() {
        let (s, _d) = service();
        let job = start(&s, ConnectionId::new_v4(), false, rec()).unwrap();
        let counter = Arc::new(CountCancel::default());
        job.set_canceller(counter.clone());
        assert!(!job.is_cancelled());
        s.cancel(job.id).await.unwrap();
        assert!(job.is_cancelled());
        assert!(job.cancel_flag().load(Ordering::SeqCst));
        assert_eq!(counter.0.load(Ordering::SeqCst), 1);
        // A job that has ended is left alone.
        let id = job.id;
        job.finish(Err(Error::Cancelled));
        s.cancel(id).await.unwrap();
        assert_eq!(counter.0.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_canceller_set_after_cancel_is_called() {
        let (s, _d) = service();
        let job = start(&s, ConnectionId::new_v4(), false, rec()).unwrap();
        s.cancel(job.id).await.unwrap();
        let counter = Arc::new(CountCancel::default());
        job.set_canceller(counter.clone());
        for _ in 0..50 {
            if counter.0.load(Ordering::SeqCst) == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(counter.0.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn each_canceller_is_called_at_most_once() {
        let (s, _d) = service();
        let job = start(&s, ConnectionId::new_v4(), false, rec()).unwrap();
        let first = Arc::new(CountCancel::default());
        job.set_canceller(first.clone());
        s.cancel(job.id).await.unwrap();
        s.cancel(job.id).await.unwrap();
        job.set_canceller(first.clone());
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(first.0.load(Ordering::SeqCst), 1);
        // A new server call's canceller is called once too.
        let second = Arc::new(CountCancel::default());
        job.set_canceller(second.clone());
        s.cancel(job.id).await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(second.0.load(Ordering::SeqCst), 1);
        assert_eq!(first.0.load(Ordering::SeqCst), 1);
    }

    /// An event that cannot be serialized still reaches the page as a failure, never `null`.
    #[cfg(windows)]
    #[test]
    fn an_unserializable_final_event_is_sent_as_a_failure() {
        use std::os::windows::ffi::OsStringExt;
        let (s, _d) = service();
        let sink = rec();
        let job = start(&s, ConnectionId::new_v4(), false, sink.clone()).unwrap();
        let bad = PathBuf::from(std::ffi::OsString::from_wide(&[0xD800, 0x61]));
        job.finish(Err(Error::FileExists(bad)));
        let last = sink.last();
        assert_eq!(last["kind"], "failed");
        assert_eq!(last["error"]["kind"], "query");
    }

    #[test]
    fn attach_replays_last_progress_then_final() {
        let (s, _d) = service();
        let job = start(&s, ConnectionId::new_v4(), false, rec()).unwrap();
        job.progress(rows(1, 100));
        job.progress(rows(42, 100));
        let late = rec();
        s.attach(job.id, late.clone()).unwrap();
        assert_eq!(late.kinds(), vec!["progress"]);
        assert_eq!(late.last()["rowsDone"], 42);
        // The new watcher gets what follows.
        job.warning("w".into());
        assert_eq!(late.kinds(), vec!["progress", "warning"]);
        let id = job.id;
        job.finish(Err(Error::Cancelled));
        assert_eq!(late.last()["kind"], "failed");
        // After the end, attach sends the final event alone.
        let after = rec();
        s.attach(id, after.clone()).unwrap();
        assert_eq!(after.kinds(), vec!["failed"]);
        assert_eq!(after.last()["error"]["kind"], "cancelled");
        assert!(matches!(
            s.attach(JobId::new_v4(), rec()),
            Err(Error::NotFound(_))
        ));
    }

    #[test]
    fn finish_leaves_running_list() {
        let (s, _d) = service();
        let sink = rec();
        let c = ConnectionId::new_v4();
        let job = start(&s, c, true, sink.clone()).unwrap();
        let listed = s.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, job.id);
        assert_eq!(listed[0].kind, JobKind::Import);
        assert_eq!(listed[0].connection_id, c);
        assert_eq!(listed[0].label, "Exporting orders");
        assert_eq!(listed[0].percent, None);
        assert!(listed[0].started_at_ms > 0);
        job.finish(Ok(JobReport {
            rows_written: 3,
            ..Default::default()
        }));
        assert!(s.list().is_empty());
        assert_eq!(sink.kinds(), vec!["finished"]);
        assert_eq!(sink.last()["report"]["rowsWritten"], 3);
        // The Connection is free for another writing job.
        assert!(start(&s, c, true, rec()).is_ok());

        // Dropped without finish: it fails and leaves the list too.
        let sink = rec();
        let job = start(&s, ConnectionId::new_v4(), false, sink.clone()).unwrap();
        drop(job);
        assert!(s.list().is_empty());
        assert_eq!(sink.kinds(), vec!["failed"]);
    }

    #[tokio::test]
    async fn cancel_on_cancels_that_connection_only() {
        let (s, _d) = service();
        let c = ConnectionId::new_v4();
        let mine_a = start(&s, c, false, rec()).unwrap();
        let mine_b = start(&s, c, true, rec()).unwrap();
        let other = start(&s, ConnectionId::new_v4(), true, rec()).unwrap();
        let counter = Arc::new(CountCancel::default());
        mine_b.set_canceller(counter.clone());
        s.cancel_on(c).await;
        assert!(mine_a.is_cancelled());
        assert!(mine_b.is_cancelled());
        assert!(!other.is_cancelled());
        assert_eq!(counter.0.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancel_all_cancels_every_running_job() {
        let (s, _d) = service();
        let a = start(&s, ConnectionId::new_v4(), false, rec()).unwrap();
        let b = start(&s, ConnectionId::new_v4(), true, rec()).unwrap();
        let counter = Arc::new(CountCancel::default());
        a.set_canceller(counter.clone());
        b.set_canceller(counter.clone());
        s.cancel_all().await;
        assert!(a.is_cancelled());
        assert!(b.is_cancelled());
        assert_eq!(counter.0.load(Ordering::SeqCst), 2);
        // Nothing running: it returns at once.
        let (empty, _e) = service();
        empty.cancel_all().await;
    }

    #[test]
    fn the_client_id_is_used_once() {
        let (s, _d) = service();
        let id = JobId::new_v4();
        let c = ConnectionId::new_v4();
        let job = s
            .start(
                id,
                JobKind::Export,
                c,
                "k",
                "Exporting orders".into(),
                false,
                rec(),
            )
            .unwrap();
        assert_eq!(job.id, id);
        assert_eq!(s.list()[0].id, id);
        assert!(matches!(
            s.start(id, JobKind::Export, c, "k", "x".into(), false, rec()),
            Err(Error::InvalidInput(_))
        ));
        job.finish(Ok(JobReport::default()));
        // An ended id stays taken, so a late attach cannot mix two jobs.
        assert!(
            s.start(id, JobKind::Export, c, "k", "x".into(), false, rec())
                .is_err()
        );
    }

    #[test]
    fn fail_says_the_rows_committed() {
        let (s, _d) = service();
        let sink = rec();
        let job = start(&s, ConnectionId::new_v4(), true, sink.clone()).unwrap();
        job.fail(Error::Cancelled, 10_000);
        assert!(s.list().is_empty());
        let last = sink.last();
        assert_eq!(last["kind"], "failed");
        assert_eq!(last["error"]["kind"], "cancelled");
        assert_eq!(last["rowsCommitted"], 10_000);
    }

    #[test]
    fn confirmed_files_by_pass() {
        let (s, _d) = service();
        let pass = PassId::new_v4();
        assert_eq!(s.confirmed_file(pass), None);
        let id = FileIdentity {
            path: PathBuf::from("C:/in/menu.csv"),
            bytes: 212,
            sha256: "ab".into(),
        };
        s.confirm_file(pass, id.clone());
        assert_eq!(s.confirmed_file(pass), Some(id));
        assert_eq!(s.confirmed_file(PassId::new_v4()), None);
        s.forget_file(pass);
        assert_eq!(s.confirmed_file(pass), None);
    }

    #[test]
    fn history_adds_an_entry() {
        let (s, _d) = service();
        let c = ConnectionId::new_v4();
        let job = start(&s, c, false, rec()).unwrap();
        job.history(NewHistory {
            connection_id: c,
            sql: "SELECT * FROM orders".into(),
            ran_at_ms: 1,
            elapsed_ms: 2,
            outcome: crate::query::Outcome::Ok,
            rows: Some(3),
            changed: false,
            error: None,
        });
        let store = s.shared.store.lock().unwrap();
        assert!(store.history_bytes().unwrap() > 0);
    }
}
