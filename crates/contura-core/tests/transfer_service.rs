//! The Data Transfer service (step 8, Task 7): `plan_transfer`, `transfer_sample`,
//! `confirm_transfer` and `start_transfer` with a recording sink. Both sides are SQLite
//! files, so the per-target rules are checked without a server.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use contura_core::Error;
use contura_core::connections::{
    ConnectionInput, ConnectionService, PasswordChange, TARGET_CHANGED,
};
use contura_core::jobs::JobSink;
use contura_core::jobs::types::JobId;
use contura_core::model::{ConnectionId, DialectKind, SslMode};
use contura_core::query::HistoryFilter;
use contura_core::secrets::MemorySecretStore;
use contura_core::store::AppStore;
use contura_core::transfer::{Side, TableChoice, TransferRequest};
use serde_json::Value as Json;

#[derive(Default)]
struct Rec(Mutex<Vec<Json>>);

impl JobSink for Rec {
    fn send(&self, event: Json) {
        self.0.lock().unwrap().push(event);
    }
}

impl Rec {
    /// Waits for the final event, at most a minute.
    async fn wait(&self) -> Json {
        let until = Instant::now() + Duration::from_secs(60);
        loop {
            let last = self
                .0
                .lock()
                .unwrap()
                .iter()
                .find(|e| e["kind"] == "finished" || e["kind"] == "failed")
                .cloned();
            if let Some(last) = last {
                return last;
            }
            assert!(Instant::now() < until, "the job never ended");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

struct Fx {
    dir: tempfile::TempDir,
    svc: Arc<ConnectionService>,
    source: ConnectionId,
}

impl Fx {
    /// A service with an open SQLite source holding `stores` (3 rows).
    async fn new() -> Fx {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("data")).unwrap();
        let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
        let svc = Arc::new(
            ConnectionService::new(store, Arc::new(MemorySecretStore::new()))
                .with_data_dir(dir.path().join("data")),
        );
        let file = dir.path().join("source.sqlite");
        let db = rusqlite::Connection::open(&file).unwrap();
        db.execute_batch(
            "CREATE TABLE stores (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
             INSERT INTO stores VALUES (1, 'north'), (2, 'south'), (3, 'east'), (4, 'west'), (5, 'pier');",
        )
        .unwrap();
        drop(db);
        let mut fx = Fx {
            dir,
            svc,
            source: ConnectionId::nil(),
        };
        fx.source = fx.save("kestrel", "source.sqlite", true, false).await;
        fx
    }

    async fn save(
        &self,
        name: &str,
        file: &str,
        production: bool,
        read_only: bool,
    ) -> ConnectionId {
        let path = self.dir.path().join(file);
        if !path.exists() {
            drop(rusqlite::Connection::open(&path).unwrap());
        }
        let saved = self
            .svc
            .save(ConnectionInput {
                id: None,
                name: name.into(),
                dialect: DialectKind::Sqlite,
                host: String::new(),
                port: 0,
                user: String::new(),
                database: None,
                ssl: SslMode::Disable,
                password: PasswordChange::Set {
                    value: String::new(),
                },
                group_id: None,
                file: Some(path),
                query_timeout_secs: None,
                ai_access: Default::default(),
                production,
                read_only,
            })
            .await
            .expect("save the Connection");
        self.svc.open(saved.id).await.expect("open the Connection");
        saved.id
    }

    fn req(&self, target: ConnectionId) -> TransferRequest {
        TransferRequest {
            source: Side {
                connection_id: self.source,
                database: "main".into(),
                schema: None,
            },
            target: Side {
                connection_id: target,
                database: "main".into(),
                schema: None,
            },
            tables: vec![TableChoice {
                name: "stores".into(),
                ticked: true,
                ..Default::default()
            }],
            batch_rows: 2,
            compare_counts: true,
            ..Default::default()
        }
    }

    async fn start(
        &self,
        req: TransferRequest,
        reviewed: Option<String>,
        pass: Option<contura_core::safety::PassId>,
    ) -> Result<Arc<Rec>, Error> {
        let rec = Arc::new(Rec::default());
        self.svc
            .start_transfer(JobId::new_v4(), req, reviewed, pass, rec.clone())
            .await?;
        Ok(rec)
    }

    fn count(&self, file: &str) -> i64 {
        rusqlite::Connection::open(self.dir.path().join(file))
            .unwrap()
            .query_row("SELECT count(*) FROM stores", [], |r| r.get(0))
            .unwrap_or(0)
    }

    fn history(&self, id: ConnectionId) -> Vec<contura_core::query::HistoryEntry> {
        self.svc
            .query_history(
                Some(id),
                HistoryFilter {
                    search: None,
                    only: None,
                },
            )
            .expect("history")
    }
}

/// A Production source needs nothing; the History entry lands on the target only.
#[tokio::test(flavor = "multi_thread")]
async fn copies_and_records_on_the_target() {
    let fx = Fx::new().await;
    let target = fx.save("freight", "target.sqlite", false, false).await;
    let plan = fx.svc.plan_transfer(fx.req(target)).await.unwrap();
    assert_eq!(plan.fingerprint.len(), 64);
    let rec = fx
        .start(fx.req(target), Some(plan.fingerprint.clone()), None)
        .await
        .expect("start");
    let end = rec.wait().await;
    assert_eq!(end["kind"], "finished", "{end}");
    assert_eq!(end["report"]["rowsWritten"], 5);
    // Progress counts the whole run, and the current table on its own.
    let progress: Vec<Json> = rec
        .0
        .lock()
        .unwrap()
        .iter()
        .filter(|e| e["kind"] == "progress")
        .cloned()
        .collect();
    let last = progress.last().expect("a progress event");
    assert_eq!(last["table"], "stores");
    assert_eq!(last["rowsTotal"], 5);
    assert_eq!(last["tableTotal"], 5);
    assert!(last["tableRows"].as_u64().is_some(), "{last}");
    assert_eq!(fx.count("target.sqlite"), 5);
    assert!(fx.history(fx.source).is_empty(), "nothing on the source");
    let entries = fx.history(target);
    assert_eq!(entries.len(), 1);
    assert!(
        entries[0]
            .sql
            .starts_with("-- Data Transfer from kestrel (main) to freight (main)"),
        "{}",
        entries[0].sql
    );
    assert!(entries[0].sql.contains("-- 5 rows copied"));
}

#[tokio::test(flavor = "multi_thread")]
async fn sample_is_the_first_insert() {
    let fx = Fx::new().await;
    let target = fx.save("freight", "target.sqlite", false, false).await;
    let sql = fx
        .svc
        .transfer_sample(fx.req(target), "stores".into())
        .await
        .unwrap();
    assert!(sql.contains("'north'") && sql.contains("'west'"), "{sql}");
    assert!(!sql.contains("'pier'"), "four rows only: {sql}");
}

#[tokio::test(flavor = "multi_thread")]
async fn production_target_needs_a_pass_that_runs_once() {
    let fx = Fx::new().await;
    let target = fx.save("freight-prod", "target.sqlite", true, false).await;
    assert!(matches!(
        fx.start(fx.req(target), None, None).await,
        Err(Error::NeedsConfirmation)
    ));
    assert!(fx.svc.jobs().list().is_empty());
    let pass = fx.svc.confirm_transfer(fx.req(target)).await.unwrap();
    let rec = fx
        .start(fx.req(target), None, Some(pass))
        .await
        .expect("start");
    assert_eq!(rec.wait().await["kind"], "finished");
    assert_eq!(fx.count("target.sqlite"), 5);
    // The pass is spent.
    let mut again = fx.req(target);
    again.tables[0].if_exists = contura_core::transfer::IfExists::Append;
    assert!(matches!(
        fx.start(again, None, Some(pass)).await,
        Err(Error::NeedsConfirmation)
    ));
}

/// A pass covers the plan it was confirmed for; a different plan is refused.
#[tokio::test(flavor = "multi_thread")]
async fn stale_pass_refused() {
    let fx = Fx::new().await;
    let target = fx.save("freight-prod", "target.sqlite", true, false).await;
    let pass = fx.svc.confirm_transfer(fx.req(target)).await.unwrap();
    let mut other = fx.req(target);
    other.batch_rows = 3;
    other.copy = contura_core::transfer::CopyKind::StructureOnly;
    assert!(matches!(
        fx.start(other, None, Some(pass)).await,
        Err(Error::NeedsConfirmation)
    ));
    assert!(fx.svc.jobs().list().is_empty());
    assert_eq!(fx.count("target.sqlite"), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn read_only_target_refused_first() {
    let fx = Fx::new().await;
    let target = fx
        .save("kestrel-reporting", "target.sqlite", false, true)
        .await;
    assert!(matches!(
        fx.svc.plan_transfer(fx.req(target)).await,
        Err(Error::ReadOnly(_))
    ));
    assert!(matches!(
        fx.start(fx.req(target), None, None).await,
        Err(Error::ReadOnly(_))
    ));
    assert!(fx.svc.jobs().list().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn target_changed_since_review_refused() {
    let fx = Fx::new().await;
    let target = fx.save("freight", "target.sqlite", false, false).await;
    let reviewed = fx
        .svc
        .plan_transfer(fx.req(target))
        .await
        .unwrap()
        .fingerprint;
    // Someone creates the table on the target after the review.
    rusqlite::Connection::open(fx.dir.path().join("target.sqlite"))
        .unwrap()
        .execute_batch("CREATE TABLE stores (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
        .unwrap();
    match fx.start(fx.req(target), Some(reviewed), None).await {
        Err(Error::InvalidInput(m)) => assert_eq!(m, TARGET_CHANGED),
        other => panic!("expected the target-changed refusal, got {:?}", other.err()),
    }
    assert!(fx.svc.jobs().list().is_empty());
    assert_eq!(fx.count("target.sqlite"), 0);
}
