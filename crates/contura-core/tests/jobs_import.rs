//! The import service (Task 8): `plan_import`, `check_import_file`, `confirm_import` and
//! `start_import` per Dialect, with a recording sink. Live MySQL and PostgreSQL in
//! `dbview_test_<8hex>` databases as `dbview_test`; SQLite in temp files.

mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::TestDb;
use common::jobs::{canonical_rows, every_type_table, run_sql};
use common::pg::PgTestDb;
use contura_core::Error;
use contura_core::connections::{ConnectionInput, ConnectionService, PasswordChange};
use contura_core::dialect::Dialect;
use contura_core::jobs::JobSink;
use contura_core::jobs::source::{SourceRequest, Value};
use contura_core::jobs::types::{
    ColumnMap, CommitMode, EmptyAs, ExportOptions, ExportRequest, ExportSource, Format,
    ImportOptions, ImportRequest, JobId, JobVerdict, JsonLayout, OnError,
};
use contura_core::model::{ConnectionId, DialectKind, ObjectPath, SslMode};
use contura_core::query::HistoryFilter;
use contura_core::safety::PassId;
use contura_core::secrets::MemorySecretStore;
use contura_core::store::AppStore;
use serde_json::Value as Json;
use sha2::Digest;

// ---- The recording sink ----

#[derive(Default)]
struct Rec(Mutex<Vec<Json>>);

impl JobSink for Rec {
    fn send(&self, event: Json) {
        self.0.lock().unwrap().push(event);
    }
}

impl Rec {
    fn events(&self) -> Vec<Json> {
        self.0.lock().unwrap().clone()
    }

    fn of(&self, kind: &str) -> Vec<Json> {
        self.events()
            .into_iter()
            .filter(|e| e["kind"] == kind)
            .collect()
    }

    fn finals(&self) -> Vec<Json> {
        self.events()
            .into_iter()
            .filter(|e| e["kind"] == "finished" || e["kind"] == "failed")
            .collect()
    }

    /// Waits for the final event, at most three minutes.
    async fn wait(&self) -> Json {
        let until = Instant::now() + Duration::from_secs(180);
        loop {
            if let Some(last) = self.finals().into_iter().next() {
                return last;
            }
            assert!(Instant::now() < until, "the job never ended");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

fn report(event: &Json) -> &Json {
    assert_eq!(event["kind"], "finished", "{event}");
    &event["report"]
}

fn failed(event: &Json) -> &Json {
    assert_eq!(event["kind"], "failed", "{event}");
    &event["error"]
}

// ---- The fixture: a service with one open Connection ----

enum Db {
    My(TestDb),
    Pg(PgTestDb),
    Lite,
}

struct Fx {
    kind: DialectKind,
    dir: tempfile::TempDir,
    svc: Arc<ConnectionService>,
    id: ConnectionId,
    /// Every Connection saved, closed at the end.
    ids: Vec<ConnectionId>,
    place: Place,
    database: String,
    db: Option<Db>,
}

const CLEANUP: Duration = Duration::from_secs(20);

/// Where a Connection points; every Connection of a test points at the same place.
#[derive(Clone, Default)]
struct Place {
    host: String,
    port: u16,
    user: String,
    database: Option<String>,
    password: String,
    file: Option<PathBuf>,
}

fn input(kind: DialectKind, place: &Place, name: &str) -> ConnectionInput {
    ConnectionInput {
        id: None,
        name: name.into(),
        dialect: kind,
        host: place.host.clone(),
        port: place.port,
        user: place.user.clone(),
        database: place.database.clone(),
        ssl: SslMode::Disable,
        password: PasswordChange::Set {
            value: place.password.clone(),
        },
        group_id: None,
        file: place.file.clone(),
        query_timeout_secs: None,
        ai_access: Default::default(),
        ai_sync: Default::default(),
        production: false,
        read_only: false,
    }
}

impl Fx {
    async fn new(kind: DialectKind) -> Fx {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("data")).unwrap();
        std::fs::create_dir_all(dir.path().join("in")).unwrap();
        let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
        let svc = Arc::new(
            ConnectionService::new(store, Arc::new(MemorySecretStore::new()))
                .with_data_dir(dir.path().join("data")),
        );
        let mut place = Place::default();
        let (db, database) = match kind {
            DialectKind::MySql => {
                let db = TestDb::create().await;
                place.host = db.config.host.clone();
                place.port = db.config.port;
                place.user = db.config.user.clone();
                place.database = db.config.database.clone();
                place.password = db.password.clone().unwrap_or_default();
                let name = db.name.clone();
                (Db::My(db), name)
            }
            DialectKind::Postgres => {
                let db = PgTestDb::create().await;
                place.host = db.config.host.clone();
                place.port = db.config.port;
                place.user = db.config.user.clone();
                place.database = db.config.database.clone();
                place.password = db.password.clone().unwrap_or_default();
                let name = db.name.clone();
                (Db::Pg(db), name)
            }
            DialectKind::Sqlite => {
                let file = dir.path().join("import.sqlite");
                drop(rusqlite::Connection::open(&file).unwrap());
                place.file = Some(file);
                (Db::Lite, "main".to_string())
            }
        };
        let saved = svc
            .save(input(kind, &place, "kestrel"))
            .await
            .expect("save the Connection");
        svc.open(saved.id).await.expect("open the Connection");
        Fx {
            kind,
            dir,
            svc,
            id: saved.id,
            ids: vec![saved.id],
            place,
            database,
            db: Some(db),
        }
    }

    /// Another Connection to the same database, Production or Read-only.
    async fn other(&mut self, production: bool, read_only: bool) -> ConnectionId {
        let name = if read_only {
            "kestrel-reporting"
        } else {
            "freight-prod"
        };
        let mut inp = input(self.kind, &self.place, name);
        inp.production = production;
        inp.read_only = read_only;
        let saved = self.svc.save(inp).await.expect("save the Connection");
        self.svc.open(saved.id).await.expect("open the Connection");
        self.ids.push(saved.id);
        saved.id
    }

    async fn dialect(&self) -> Arc<dyn Dialect> {
        self.svc.session(self.id).await.expect("open")
    }

    async fn sql(&self, sql: &str) {
        run_sql(self.dialect().await.as_ref(), sql).await;
    }

    fn path(&self, table: &str) -> ObjectPath {
        ObjectPath {
            database: self.database.clone(),
            schema: (self.kind == DialectKind::Postgres).then(|| "public".to_string()),
            name: table.into(),
        }
    }

    fn file(&self, name: &str) -> PathBuf {
        self.dir.path().join("in").join(name)
    }

    fn write(&self, name: &str, body: &str) -> PathBuf {
        let p = self.file(name);
        std::fs::write(&p, body).unwrap();
        p
    }

    fn req(&self, table: &str, file: &Path, format: Format) -> ImportRequest {
        ImportRequest {
            connection_id: self.id,
            table: self.path(table),
            file: file.to_path_buf(),
            format,
            options: ImportOptions::default(),
            mapping: Vec::new(),
        }
    }

    /// `t (id, name varchar(20), price decimal(10,2))`, with id the primary key.
    async fn small_table(&self, name: &str) {
        let sql = match self.kind {
            DialectKind::MySql => format!(
                "CREATE TABLE `{name}` (id INT PRIMARY KEY, name VARCHAR(20), price DECIMAL(10,2)) ENGINE=InnoDB"
            ),
            DialectKind::Postgres => format!(
                "CREATE TABLE public.\"{name}\" (id int PRIMARY KEY, name varchar(20), price numeric(10,2))"
            ),
            DialectKind::Sqlite => format!(
                "CREATE TABLE \"{name}\" (id INTEGER PRIMARY KEY, name TEXT, price NUMERIC)"
            ),
        };
        self.sql(&sql).await;
    }

    async fn rows(&self, table: &str) -> Vec<Vec<Value>> {
        let src = self
            .dialect()
            .await
            .open_row_source(&SourceRequest::Table {
                path: self.path(table),
                columns: Vec::new(),
                filter: None,
                sort: None,
                keys: Vec::new(),
            })
            .await
            .expect("open the source");
        canonical_rows(src).await
    }

    async fn count(&self, table: &str) -> usize {
        self.rows(table).await.len()
    }

    async fn start(
        &self,
        req: ImportRequest,
        pass: Option<PassId>,
    ) -> Result<(JobId, Arc<Rec>), Error> {
        let rec = Arc::new(Rec::default());
        let id = JobId::new_v4();
        self.svc.start_import(id, req, pass, rec.clone()).await?;
        Ok((id, rec))
    }

    /// Starts the import and waits for its final event.
    async fn import(&self, req: ImportRequest) -> (Json, Arc<Rec>) {
        let (_, rec) = self.start(req, None).await.expect("start the import");
        (rec.wait().await, rec)
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

    async fn end(mut self) {
        for id in self.ids.clone() {
            let _ = tokio::time::timeout(CLEANUP, self.svc.close(id)).await;
        }
        let dropped = match self.db.take() {
            Some(Db::My(db)) => tokio::time::timeout(CLEANUP, db.drop_db()).await,
            Some(Db::Pg(db)) => tokio::time::timeout(CLEANUP, db.drop_db()).await,
            _ => Ok(()),
        };
        assert!(dropped.is_ok(), "the test database did not drop in time");
    }
}

impl Drop for Fx {
    fn drop(&mut self) {
        if self.db.is_none() {
            return;
        }
        let (svc, ids) = (self.svc.clone(), self.ids.clone());
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            tokio::task::block_in_place(|| {
                rt.block_on(async {
                    for id in ids {
                        let _ = tokio::time::timeout(CLEANUP, svc.close(id)).await;
                    }
                })
            });
        }
    }
}

/// `id,name,price` and `n` rows; `bad` replaces a row's text by file row (from 1).
fn csv_rows(n: u64, bad: &[(u64, &str)]) -> String {
    let mut out = String::from("id,name,price\n");
    for i in 1..=n {
        match bad.iter().find(|(r, _)| *r == i) {
            Some((_, line)) => out.push_str(line),
            None => out.push_str(&format!("{i},n{i},{i}.50")),
        }
        out.push('\n');
    }
    out
}

fn sha_hex(path: &Path) -> String {
    let bytes = std::fs::read(path).unwrap();
    sha2::Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn job_failed_message(error: &Json) -> String {
    assert_eq!(error["kind"], "jobFailed", "{error}");
    error["message"]["message"].as_str().unwrap().to_string()
}

// ---- Shared checks, run per Dialect ----

const ROUND_ROWS: u64 = 100_000;
const XLSX_ROWS: u64 = 10_000;

/// Task 7's export, then an import into a twin table of the same shape: the twin holds
/// the same canonical rows (D18: Excel with the first 10,000 rows).
async fn round_trip_each_format(fx: &Fx) {
    let d = fx.dialect().await;
    every_type_table(d.as_ref(), fx.kind, "every", ROUND_ROWS).await;
    every_type_table(d.as_ref(), fx.kind, "twin", 1).await;
    let source = |filter: Option<&str>| SourceRequest::Table {
        path: fx.path("every"),
        columns: Vec::new(),
        filter: filter.map(str::to_string),
        sort: None,
        keys: Vec::new(),
    };
    let all = canonical_rows(d.open_row_source(&source(None)).await.unwrap()).await;
    let first = canonical_rows(
        d.open_row_source(&source(Some("id <= 10000")))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(all.len() as u64, ROUND_ROWS);
    assert_eq!(first.len() as u64, XLSX_ROWS);
    let cases = [
        (Format::Csv, JsonLayout::Lines, "every.csv", None),
        (Format::Json, JsonLayout::Lines, "every.ndjson", None),
        (Format::Json, JsonLayout::Array, "every.json", None),
        (
            Format::Xlsx,
            JsonLayout::Lines,
            "every.xlsx",
            Some("id <= 10000"),
        ),
    ];
    for (format, layout, name, filter) in cases {
        let twin = fx.path("twin");
        let clear = match fx.kind {
            DialectKind::MySql => "DELETE FROM `twin`",
            _ => "DELETE FROM \"twin\"",
        };
        fx.sql(clear).await;
        let out = fx.file(name);
        let rec = Arc::new(Rec::default());
        fx.svc
            .start_export(
                JobId::new_v4(),
                ExportRequest {
                    connection_id: fx.id,
                    source: ExportSource::Table {
                        path: fx.path("every"),
                        columns: Vec::new(),
                        filter: filter.map(str::to_string),
                        sort: None,
                        keys: Vec::new(),
                    },
                    format,
                    options: ExportOptions {
                        json_layout: layout,
                        ..ExportOptions::default()
                    },
                    path: out.clone(),
                    rows_hint: None,
                },
                false,
                rec.clone(),
            )
            .await
            .expect("start the export");
        report(&rec.wait().await);
        let mut req = fx.req("twin", &out, format);
        req.table = twin;
        let (end, _) = fx.import(req).await;
        let want = if filter.is_some() { &first } else { &all };
        let r = report(&end);
        assert_eq!(r["rowsWritten"], want.len() as u64, "{name}");
        assert_eq!(r["committed"], want.len() as u64, "{name}");
        let have = fx.rows("twin").await;
        assert_eq!(have.len(), want.len(), "{name}: count");
        for (i, (w, h)) in want.iter().zip(&have).enumerate() {
            assert_eq!(w, h, "{name}: row {i}");
        }
    }
}

/// Stop: a server error rolls back everything and names the file row; so does a value
/// Contura refuses before sending it.
async fn stop_rolls_back_and_names_row(fx: &Fx) {
    fx.small_table("t").await;
    // Row 700 repeats id 5: the server refuses it.
    let file = fx.write("dup.csv", &csv_rows(1_200, &[(700, "5,dup,1.00")]));
    let (end, _) = fx.import(fx.req("t", &file, Format::Csv)).await;
    let error = failed(&end);
    let message = job_failed_message(error);
    assert!(message.starts_with("Row 700 of the file: "), "{message}");
    assert_eq!(error["message"]["at"]["fileRow"], 700);
    assert_eq!(end["rowsCommitted"], 0);
    assert_eq!(fx.count("t").await, 0);

    let file = fx.write("bad.csv", &csv_rows(30, &[(7, "7,x,n/a")]));
    let (end, _) = fx.import(fx.req("t", &file, Format::Csv)).await;
    assert_eq!(
        job_failed_message(failed(&end)),
        "Row 7 of the file: n/a is not a number for price."
    );
    assert_eq!(fx.count("t").await, 0);
}

async fn skip_keeps_rest_and_lists_row(fx: &Fx) {
    fx.small_table("t").await;
    let file = fx.write(
        "dup.csv",
        &csv_rows(1_200, &[(700, "5,dup,1.00"), (9, "9,x,n/a")]),
    );
    let mut req = fx.req("t", &file, Format::Csv);
    req.options.on_error = OnError::Skip;
    let (end, rec) = fx.import(req).await;
    let r = report(&end);
    assert_eq!(r["rowsWritten"], 1_198);
    assert_eq!(r["skipped"], 2);
    let skipped = rec.of("rowSkipped");
    let rows: Vec<u64> = skipped
        .iter()
        .map(|e| e["fileRow"].as_u64().unwrap())
        .collect();
    assert_eq!(rows, [9, 700]);
    assert_eq!(skipped[0]["column"], "price");
    assert_eq!(skipped[0]["message"], "n/a is not a number for price.");
    assert!(skipped[1]["message"].as_str().unwrap().len() > 3);
    assert_eq!(fx.count("t").await, 1_198);
}

async fn skip_over_1000_rolls_back(fx: &Fx) {
    fx.small_table("t").await;
    let bad: Vec<(u64, String)> = (1..=1_001)
        .map(|i| (i * 2, format!("{},x,oops", i * 2)))
        .collect();
    let bad_ref: Vec<(u64, &str)> = bad.iter().map(|(r, s)| (*r, s.as_str())).collect();
    let file = fx.write("many.csv", &csv_rows(3_000, &bad_ref));
    let mut req = fx.req("t", &file, Format::Csv);
    req.options.on_error = OnError::Skip;
    let (end, _) = fx.import(req).await;
    assert_eq!(
        job_failed_message(failed(&end)),
        "More than 1,000 rows failed. Nothing was imported."
    );
    assert_eq!(end["rowsCommitted"], 0);
    assert_eq!(fx.count("t").await, 0);
}

/// Q27: with Commit every N the committed batches stay, and the failure says how many.
async fn commit_every_n_keeps_earlier_chunks(fx: &Fx) {
    fx.small_table("t").await;
    let file = fx.write("every.csv", &csv_rows(3_000, &[(2_500, "5,dup,1.00")]));
    let mut req = fx.req("t", &file, Format::Csv);
    req.options.commit = CommitMode::Every { rows: 1_000 };
    let (end, _) = fx.import(req).await;
    assert!(
        job_failed_message(failed(&end)).starts_with("Row 2500 of the file: "),
        "{end}"
    );
    assert_eq!(end["rowsCommitted"], 2_000);
    assert_eq!(fx.count("t").await, 2_000);

    // With nothing failing, every row is committed and counted.
    let file = fx.write("ok.csv", &csv_rows(2_500, &[]));
    let mut req = fx.req("t", &file, Format::Csv);
    req.options.commit = CommitMode::Every { rows: 1_000 };
    let clear = match fx.kind {
        DialectKind::MySql => "DELETE FROM `t`",
        _ => "DELETE FROM \"t\"",
    };
    fx.sql(clear).await;
    let (end, _) = fx.import(req).await;
    assert_eq!(report(&end)["committed"], 2_500);
}

async fn cancel_mid_way_leaves_target_unchanged(fx: &Fx) {
    fx.small_table("t").await;
    let file = fx.write("big.csv", &csv_rows(400_000, &[]));
    let (id, rec) = fx
        .start(fx.req("t", &file, Format::Csv), None)
        .await
        .expect("start");
    let until = Instant::now() + Duration::from_secs(60);
    loop {
        let written = rec
            .of("progress")
            .iter()
            .any(|e| e["rowsDone"].as_u64().unwrap_or(0) > 0);
        if written {
            break;
        }
        assert!(rec.finals().is_empty(), "it ended before the cancel");
        assert!(Instant::now() < until, "no progress");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    fx.svc.jobs().cancel(id).await.unwrap();
    let end = rec.wait().await;
    assert_eq!(failed(&end)["kind"], "cancelled", "{end}");
    assert_eq!(end["rowsCommitted"], 0);
    assert_eq!(fx.count("t").await, 0);
}

/// D5, Q29: Production needs the pass; the pass covers one run of the file it was
/// confirmed for.
async fn production_without_pass_needs_confirmation(fx: &mut Fx) {
    fx.small_table("t").await;
    let prod = fx.other(true, false).await;
    let file = fx.write("p.csv", &csv_rows(10, &[]));
    let mut req = fx.req("t", &file, Format::Csv);
    req.connection_id = prod;
    let plan = fx.svc.plan_import(req.clone()).await.unwrap();
    match &plan.verdict {
        JobVerdict::NeedsConfirmation {
            connection,
            file_bytes,
            file_sha256,
            fingerprint,
            ..
        } => {
            assert_eq!(connection, "freight-prod");
            assert_eq!(*file_bytes, std::fs::metadata(&file).unwrap().len());
            assert_eq!(*file_sha256, sha_hex(&file));
            assert_eq!(fingerprint.len(), 64);
        }
        other => panic!("{other:?}"),
    }
    assert!(matches!(
        fx.start(req, None).await,
        Err(Error::NeedsConfirmation)
    ));
    assert!(fx.svc.jobs().list().is_empty());
    assert_eq!(fx.count("t").await, 0);
}

async fn production_pass_runs_once(fx: &mut Fx) {
    fx.small_table("t").await;
    let prod = fx.other(true, false).await;
    let file = fx.write("p.csv", &csv_rows(10, &[]));
    let mut req = fx.req("t", &file, Format::Csv);
    req.connection_id = prod;
    let pass = fx.svc.confirm_import(req.clone()).await.unwrap();
    assert!(fx.svc.jobs().confirmed_file(pass).is_some());
    let (_, rec) = fx.start(req.clone(), Some(pass)).await.expect("start");
    assert_eq!(report(&rec.wait().await)["rowsWritten"], 10);
    // Q29: start used the pass, so its file is forgotten and the pass is spent.
    assert!(fx.svc.jobs().confirmed_file(pass).is_none());
    assert!(matches!(
        fx.start(req.clone(), Some(pass)).await,
        Err(Error::NeedsConfirmation)
    ));
    // A pass for one mapping does not cover another.
    let pass = fx.svc.confirm_import(req.clone()).await.unwrap();
    req.mapping = vec![
        ColumnMap {
            file_column: 0,
            into: Some("id".into()),
            by_hand: true,
        },
        ColumnMap {
            file_column: 1,
            into: Some("name".into()),
            by_hand: true,
        },
    ];
    assert!(matches!(
        fx.start(req, Some(pass)).await,
        Err(Error::NeedsConfirmation)
    ));
    assert_eq!(fx.count("t").await, 10);
}

async fn file_changed_after_confirm_refused(fx: &mut Fx) {
    fx.small_table("t").await;
    let prod = fx.other(true, false).await;
    let file = fx.write("menu-oct.csv", &csv_rows(10, &[]));
    let mut req = fx.req("t", &file, Format::Csv);
    req.connection_id = prod;
    let pass = fx.svc.confirm_import(req.clone()).await.unwrap();
    // One byte changes: name n3 becomes n4.
    let body = csv_rows(10, &[(3, "3,n4,3.50")]);
    assert_eq!(body.len(), csv_rows(10, &[]).len());
    std::fs::write(&file, body).unwrap();
    match fx.start(req, Some(pass)).await {
        Err(Error::FileChanged { file, confirmed }) => {
            assert_eq!(file, "menu-oct.csv");
            assert!(confirmed, "a Production confirm was made");
        }
        Err(e) => panic!("expected FileChanged, got {e:?}"),
        Ok(_) => panic!("the changed file was imported"),
    }
    assert!(fx.svc.jobs().confirmed_file(pass).is_none());
    assert!(fx.svc.jobs().list().is_empty());
    assert_eq!(fx.count("t").await, 0);
}

/// Q45 M2: the blockers are checked before the Production pass is spent, so a start
/// refused for them leaves the pass and its file for the next start.
async fn blocked_start_keeps_the_pass(fx: &mut Fx) {
    fx.small_table("t").await;
    let prod = fx.other(true, false).await;
    let body = csv_rows(10, &[]);
    let file = fx.write("p.csv", &body);
    let mut req = fx.req("t", &file, Format::Csv);
    req.connection_id = prod;
    let pass = fx.svc.confirm_import(req.clone()).await.unwrap();
    std::fs::write(&file, "id,name,price\n").unwrap();
    match fx.start(req.clone(), Some(pass)).await {
        Err(Error::InvalidInput(m)) => assert_eq!(m, "The file has no rows."),
        Err(e) => panic!("expected the blocker, got {e:?}"),
        Ok(_) => panic!("an empty file started"),
    }
    assert!(fx.svc.jobs().confirmed_file(pass).is_some());
    assert!(fx.svc.jobs().list().is_empty());
    std::fs::write(&file, &body).unwrap();
    let (_, rec) = fx
        .start(req, Some(pass))
        .await
        .expect("the pass still works");
    assert_eq!(report(&rec.wait().await)["rowsWritten"], 10);
}

/// Q45 I1: the file is held for the whole run, so under Commit every N no other program
/// can change it between batches, and every batch comes from the bytes that were hashed.
async fn commit_every_n_holds_the_file(fx: &mut Fx) {
    fx.small_table("t").await;
    let file = fx.write("held.csv", &csv_rows(200_000, &[]));
    let mut req = fx.req("t", &file, Format::Csv);
    req.options.commit = CommitMode::Every { rows: 1_000 };
    let (_, rec) = fx.start(req, None).await.expect("start");
    let until = Instant::now() + Duration::from_secs(60);
    while !rec
        .of("progress")
        .iter()
        .any(|e| e["rowsDone"].as_u64().unwrap_or(0) > 1_000)
    {
        assert!(rec.finals().is_empty(), "it ended before the write");
        assert!(Instant::now() < until, "no progress");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let write = std::fs::OpenOptions::new().append(true).open(&file);
    #[cfg(windows)]
    assert!(
        write.is_err(),
        "another writer opened the file during the job"
    );
    #[cfg(not(windows))]
    if let Ok(mut f) = write {
        use std::io::Write;
        f.write_all(b"200001,late,1.00\n").unwrap();
    }
    // Elsewhere the advisory lock does not stop a plain writer, but the run reads only
    // the bytes it checked, so the appended row is never imported.
    let end = rec.wait().await;
    assert_eq!(report(&end)["committed"], 200_000);
    assert!(
        std::fs::OpenOptions::new().append(true).open(&file).is_ok(),
        "the file is still held after the job"
    );
}

async fn read_only_refuses_before_any_job(fx: &mut Fx) {
    fx.small_table("t").await;
    let ro = fx.other(false, true).await;
    let file = fx.write("r.csv", &csv_rows(10, &[]));
    let mut req = fx.req("t", &file, Format::Csv);
    req.connection_id = ro;
    let plan = fx.svc.plan_import(req.clone()).await.unwrap();
    assert_eq!(
        plan.verdict,
        JobVerdict::ReadOnly {
            connection: "kestrel-reporting".into()
        }
    );
    assert!(matches!(
        fx.start(req.clone(), None).await,
        Err(Error::ReadOnly(0))
    ));
    assert!(matches!(
        fx.svc.confirm_import(req).await,
        Err(Error::ReadOnly(0))
    ));
    assert!(fx.svc.jobs().list().is_empty());
    assert!(fx.history(ro).is_empty());
    assert_eq!(fx.count("t").await, 0);
}

async fn job_busy_second_import_same_connection(fx: &Fx) {
    fx.small_table("t").await;
    fx.small_table("u").await;
    let file = fx.write("big.csv", &csv_rows(300_000, &[]));
    let (id, rec) = fx
        .start(fx.req("t", &file, Format::Csv), None)
        .await
        .expect("start");
    let small = fx.write("s.csv", &csv_rows(5, &[]));
    match fx.start(fx.req("u", &small, Format::Csv), None).await {
        Err(Error::JobBusy { connection }) => assert_eq!(connection, "kestrel"),
        Err(e) => panic!("expected JobBusy, got {e:?}"),
        Ok(_) => panic!("a second import started"),
    }
    fx.svc.jobs().cancel(id).await.unwrap();
    rec.wait().await;
}

async fn zero_row_file_is_blocked(fx: &Fx) {
    fx.small_table("t").await;
    let file = fx.write("empty.csv", "id,name,price\n");
    let req = fx.req("t", &file, Format::Csv);
    let plan = fx.svc.plan_import(req.clone()).await.unwrap();
    assert_eq!(
        plan.verdict,
        JobVerdict::Blocked {
            reasons: vec!["The file has no rows.".into()]
        }
    );
    match fx.start(req, None).await {
        Err(Error::InvalidInput(m)) => assert_eq!(m, "The file has no rows."),
        other => panic!("{:?}", other.map(|_| ())),
    }
    assert!(fx.svc.jobs().list().is_empty());
}

/// Review Focus 2: `,name,name` reads as Column 1, name, name (2); match by name takes
/// the first `name`, and a mapping by index takes any of them.
async fn duplicate_header_names_map_by_index(fx: &Fx) {
    fx.small_table("t").await;
    let file = fx.write("dup.csv", ",name,name\n1,first,second\n2,a,b\n");
    let mut req = fx.req("t", &file, Format::Csv);
    req.mapping = vec![ColumnMap {
        file_column: 0,
        into: Some("id".into()),
        by_hand: true,
    }];
    let plan = fx.svc.plan_import(req.clone()).await.unwrap();
    let name_col = plan.columns.iter().find(|c| c.into == "name").unwrap();
    assert_eq!(name_col.file_column, None);
    // Match by name: Column 1 matches nothing, so id needs a value.
    let by_name = fx
        .svc
        .plan_import(fx.req("t", &file, Format::Csv))
        .await
        .unwrap();
    let name_col = by_name.columns.iter().find(|c| c.into == "name").unwrap();
    assert_eq!(name_col.file_column, Some(1));
    // By index: id from column 1, name from the second `name`.
    req.mapping.push(ColumnMap {
        file_column: 2,
        into: Some("name".into()),
        by_hand: true,
    });
    let (end, _) = fx.import(req).await;
    report(&end);
    let rows = fx.rows("t").await;
    assert_eq!(rows[0][1], Value::Text("second".into()));
    assert_eq!(rows[1][1], Value::Text("b".into()));
}

/// Review Focus 5: a missing key is NULL, whatever "An empty cell means" says (D9).
async fn json_missing_keys_are_null(fx: &Fx) {
    fx.small_table("t").await;
    let file = fx.write(
        "keys.ndjson",
        "{\"id\":1,\"name\":\"a\",\"price\":1.5}\n{\"id\":2,\"price\":2}\n{\"id\":3,\"name\":\"\"}\n",
    );
    let mut req = fx.req("t", &file, Format::Json);
    req.options.empty_as = EmptyAs::EmptyText;
    let (end, _) = fx.import(req).await;
    assert_eq!(report(&end)["rowsWritten"], 3);
    let rows = fx.rows("t").await;
    assert_eq!(rows[1][1], Value::Null, "a missing key");
    assert_eq!(rows[2][1], Value::Text(String::new()), "an empty string");
    assert_eq!(rows[2][2], Value::Null);
}

async fn check_pass_reports_failing_rows_and_sha256(fx: &Fx) {
    fx.small_table("t").await;
    let file = fx.write(
        "check.csv",
        &csv_rows(400, &[(7, "7,x,n/a"), (388, "388,y,\"12,50\"")]),
    );
    let rec = Arc::new(Rec::default());
    let job = JobId::new_v4();
    let got = fx
        .svc
        .check_import_file(job, fx.req("t", &file, Format::Csv), rec.clone())
        .await
        .unwrap();
    assert_eq!(got, job);
    let end = rec.wait().await;
    let r = report(&end);
    assert_eq!(r["kind"], "check");
    let check = &r["check"];
    assert_eq!(check["rows"], 400);
    assert_eq!(check["failing"], 2);
    assert_eq!(check["first"][0]["fileRow"], 7);
    assert_eq!(check["first"][0]["column"], "price");
    assert_eq!(
        check["first"][0]["message"],
        "n/a is not a number for price."
    );
    assert_eq!(check["first"][1]["fileRow"], 388);
    assert_eq!(check["first"][1]["message"], "12,50 uses a comma.");
    assert_eq!(check["sha256"], sha_hex(&file));
    // A check writes nothing and adds no history.
    assert_eq!(fx.count("t").await, 0);
    assert!(fx.history(fx.id).is_empty());
}

async fn history_entry_per_job(fx: &Fx) {
    fx.small_table("t").await;
    let file = fx.write("h.csv", &csv_rows(1_204, &[]));
    let (end, _) = fx.import(fx.req("t", &file, Format::Csv)).await;
    report(&end);
    let file = fx.write("h2.csv", &csv_rows(3, &[(1, "1,dup,1.00")]));
    let (end, _) = fx.import(fx.req("t", &file, Format::Csv)).await;
    failed(&end);
    let history = fx.history(fx.id);
    let imports: Vec<_> = history
        .iter()
        .filter(|h| h.sql.starts_with("INSERT INTO"))
        .collect();
    assert_eq!(imports.len(), 2, "{history:?}");
    let ok = imports
        .iter()
        .find(|h| h.sql.contains("1,204 rows"))
        .expect("the import's entry");
    assert!(ok.changed);
    assert!(
        ok.sql.ends_with("VALUES ... 1,204 rows in 3 statements"),
        "{}",
        ok.sql
    );
    assert!(imports.iter().all(|h| h.changed));
}

/// Q28: the plan says whether the run is one transaction; the sample is the first
/// statement exactly (Q10), and the preview marks the cells the checks reject.
async fn plan_shows_sample_and_one_transaction(fx: &Fx) {
    fx.small_table("t").await;
    let file = fx.write("plan.csv", &csv_rows(1_204, &[(2, "2,x,n/a")]));
    let req = fx.req("t", &file, Format::Csv);
    let plan = fx.svc.plan_import(req.clone()).await.unwrap();
    assert!(plan.one_transaction);
    assert_eq!(plan.verdict, JobVerdict::Ok);
    assert_eq!(plan.preview.len(), 20);
    assert_eq!(
        plan.preview[1][2].problem.as_deref(),
        Some("n/a is not a number for price.")
    );
    assert_eq!(plan.preview[0][2].text.as_deref(), Some("1.50"));
    assert_eq!(plan.shape.rows, 1_204);
    assert_eq!(plan.shape.rows_per_statement, 500);
    assert_eq!(plan.shape.statements, 3);
    assert_eq!(plan.shape.first_rows.len(), 4);
    assert!(plan.sample_insert.starts_with(&plan.shape.head));
    // The refused row is left out of the sample: 500 good rows.
    assert_eq!(plan.sample_insert.matches("\n(").count(), 500);
    let price = plan.columns.iter().find(|c| c.into == "price").unwrap();
    assert_eq!(price.note.as_deref(), Some("1 row is not a number"));
    let mut every = req.clone();
    every.options.commit = CommitMode::Every { rows: 10_000 };
    assert!(!fx.svc.plan_import(every).await.unwrap().one_transaction);
}

/// Q31: "Read the text NULL as NULL" for CSV, off by default.
async fn null_word_option(fx: &Fx) {
    fx.small_table("t").await;
    let file = fx.write("nulls.csv", "id,name,price\n1,NULL,NULL\n");
    let mut req = fx.req("t", &file, Format::Csv);
    req.mapping = vec![
        ColumnMap {
            file_column: 0,
            into: Some("id".into()),
            by_hand: false,
        },
        ColumnMap {
            file_column: 1,
            into: Some("name".into()),
            by_hand: false,
        },
    ];
    let (end, _) = fx.import(req.clone()).await;
    report(&end);
    assert_eq!(fx.rows("t").await[0][1], Value::Text("NULL".into()));
    let clear = match fx.kind {
        DialectKind::MySql => "DELETE FROM `t`",
        _ => "DELETE FROM \"t\"",
    };
    fx.sql(clear).await;
    req.options.null_word = true;
    req.mapping.clear();
    let (end, _) = fx.import(req).await;
    report(&end);
    let rows = fx.rows("t").await;
    assert_eq!(rows[0][1], Value::Null);
    assert_eq!(rows[0][2], Value::Null);
}

fn clear_sql(kind: DialectKind, table: &str) -> String {
    match kind {
        DialectKind::MySql => format!("DELETE FROM `{table}`"),
        _ => format!("DELETE FROM \"{table}\""),
    }
}

/// Exports `table` with Task 7's export and waits for it.
async fn export_file(
    fx: &Fx,
    table: &str,
    format: Format,
    options: ExportOptions,
    name: &str,
) -> PathBuf {
    let out = fx.file(name);
    let rec = Arc::new(Rec::default());
    fx.svc
        .start_export(
            JobId::new_v4(),
            ExportRequest {
                connection_id: fx.id,
                source: ExportSource::Table {
                    path: fx.path(table),
                    columns: Vec::new(),
                    filter: None,
                    sort: None,
                    keys: Vec::new(),
                },
                format,
                options,
                path: out.clone(),
                rows_hint: None,
            },
            false,
            rec.clone(),
        )
        .await
        .expect("start the export");
    report(&rec.wait().await);
    out
}

/// Q42 I1: when the Skip cap is passed after committed batches, the message says what
/// stayed, never "Nothing was imported." (Q27).
async fn skip_cap_after_committed_batches_says_what_stayed(fx: &Fx) {
    fx.small_table("t").await;
    // Rows 1 to 2,100 are good, so the batches up to row 2,000 commit; then 1,001 rows fail.
    let bad: Vec<(u64, String)> = (2_101..=3_101)
        .map(|i| (i, format!("{i},x,oops")))
        .collect();
    let bad_ref: Vec<(u64, &str)> = bad.iter().map(|(r, s)| (*r, s.as_str())).collect();
    let file = fx.write("cap.csv", &csv_rows(3_500, &bad_ref));
    let mut req = fx.req("t", &file, Format::Csv);
    req.options.on_error = OnError::Skip;
    req.options.commit = CommitMode::Every { rows: 1_000 };
    let (end, _) = fx.import(req).await;
    let message = job_failed_message(failed(&end));
    assert_eq!(end["rowsCommitted"], 2_000);
    assert_eq!(
        message,
        "More than 1,000 rows failed. 2,000 rows were written before the stop and stay in t."
    );
    assert!(!message.contains("Nothing was imported"));
    assert_eq!(fx.count("t").await, 2_000);
}

/// Q42 I2: a table holding both NULL and the text 'NULL', exported with "NULL is
/// written as The text NULL" and imported with "Read the text NULL as NULL", reads
/// back exactly.
async fn null_word_round_trip(fx: &Fx) {
    fx.small_table("t").await;
    fx.small_table("twin").await;
    let insert = match fx.kind {
        DialectKind::MySql => {
            "INSERT INTO `t` VALUES (1, NULL, 1.50), (2, 'NULL', NULL), (3, '', 3.00)"
        }
        _ => "INSERT INTO \"t\" VALUES (1, NULL, 1.50), (2, 'NULL', NULL), (3, '', 3.00)",
    };
    fx.sql(insert).await;
    let file = export_file(
        fx,
        "t",
        Format::Csv,
        ExportOptions {
            null_as: contura_core::jobs::types::NullText::NullWord,
            ..ExportOptions::default()
        },
        "nullword.csv",
    )
    .await;
    let mut req = fx.req("twin", &file, Format::Csv);
    req.options.null_word = true;
    req.options.empty_as = EmptyAs::EmptyText;
    let (end, _) = fx.import(req).await;
    report(&end);
    assert_eq!(fx.rows("twin").await, fx.rows("t").await);
    assert_eq!(fx.rows("twin").await[1][1], Value::Text("NULL".into()));
}

/// Q42 minor: Commit every N below 500 commits at N, so a failure keeps every full batch.
async fn commit_every_n_below_500(fx: &Fx) {
    fx.small_table("t").await;
    let file = fx.write("n.csv", &csv_rows(350, &[(250, "5,dup,1.00")]));
    let mut req = fx.req("t", &file, Format::Csv);
    req.options.commit = CommitMode::Every { rows: 100 };
    let (end, _) = fx.import(req).await;
    failed(&end);
    assert_eq!(end["rowsCommitted"], 200);
    assert_eq!(fx.count("t").await, 200);
}

/// Q42 minor: a binary cell that is not `0x` hex goes in as text, with a warning that
/// names its row.
async fn binary_cells_not_hex_warn(fx: &Fx) {
    let ddl = match fx.kind {
        DialectKind::MySql => {
            "CREATE TABLE b (id INT PRIMARY KEY, bin VARBINARY(16)) ENGINE=InnoDB"
        }
        DialectKind::Postgres => "CREATE TABLE public.b (id int PRIMARY KEY, bin bytea)",
        DialectKind::Sqlite => "CREATE TABLE b (id INTEGER PRIMARY KEY, bin BLOB)",
    };
    fx.sql(ddl).await;
    let file = fx.write("b.csv", "id,bin\n1,0x0a\n2,0xzz\n3,abc\n4,\n");
    let (end, rec) = fx.import(fx.req("b", &file, Format::Csv)).await;
    let r = report(&end);
    assert_eq!(r["rowsWritten"], 4);
    let want = [
        "Row 2 of the file: 0xzz is not 0x hex, so it goes into bin as text.",
        "Row 3 of the file: abc is not 0x hex, so it goes into bin as text.",
    ];
    let sent: Vec<String> = rec
        .of("warning")
        .iter()
        .map(|w| w["message"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(sent, want);
    let kept: Vec<&str> = r["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w.as_str().unwrap())
        .collect();
    assert_eq!(kept, want);
    assert_eq!(fx.rows("b").await[0][1], Value::Bytes(vec![0x0a]));
}

/// Q42: on Production the streamed hash is checked before COMMIT, so a file changed
/// while the import runs is refused and nothing is imported.
async fn file_changed_mid_run_fails_before_commit(fx: &mut Fx) {
    fx.small_table("t").await;
    let prod = fx.other(true, false).await;
    let file = fx.write("late.csv", &csv_rows(400_000, &[]));
    let mut req = fx.req("t", &file, Format::Csv);
    req.connection_id = prod;
    let pass = fx.svc.confirm_import(req.clone()).await.unwrap();
    let (_, rec) = fx.start(req, Some(pass)).await.expect("start");
    let until = Instant::now() + Duration::from_secs(60);
    while !rec
        .of("progress")
        .iter()
        .any(|e| e["rowsDone"].as_u64().unwrap_or(0) > 0)
    {
        assert!(rec.finals().is_empty(), "it ended before the change");
        assert!(Instant::now() < until, "no progress");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    // The last row's price 400000.50 becomes 400000.60: one byte, same size.
    let opened = std::fs::OpenOptions::new().write(true).open(&file);
    // Q45 I1: on Windows the held file refuses the writer, so the confirmed bytes run.
    #[cfg(windows)]
    {
        assert!(
            opened.is_err(),
            "another writer opened the file during the job"
        );
        let end = rec.wait().await;
        assert_eq!(report(&end)["rowsWritten"], 400_000);
    }
    #[cfg(not(windows))]
    {
        use std::io::{Seek, SeekFrom, Write};
        let len = std::fs::metadata(&file).unwrap().len();
        let mut f = opened.unwrap();
        f.seek(SeekFrom::Start(len - 3)).unwrap();
        f.write_all(b"6").unwrap();
        drop(f);
        let end = rec.wait().await;
        assert_eq!(failed(&end)["kind"], "fileChanged", "{end}");
        assert_eq!(end["rowsCommitted"], 0);
        assert_eq!(fx.count("t").await, 0);
    }
}

/// Q42: a Production import from Excel and from JSON runs with its pass.
async fn production_excel_and_json(fx: &mut Fx) {
    fx.small_table("t").await;
    fx.small_table("twin").await;
    let file = fx.write("seed.csv", &csv_rows(300, &[]));
    report(&fx.import(fx.req("t", &file, Format::Csv)).await.0);
    let prod = fx.other(true, false).await;
    for (format, name) in [(Format::Xlsx, "t.xlsx"), (Format::Json, "t.ndjson")] {
        fx.sql(&clear_sql(fx.kind, "twin")).await;
        let out = export_file(fx, "t", format, ExportOptions::default(), name).await;
        let mut req = fx.req("twin", &out, format);
        req.connection_id = prod;
        let plan = fx.svc.plan_import(req.clone()).await.unwrap();
        assert!(
            matches!(plan.verdict, JobVerdict::NeedsConfirmation { .. }),
            "{name}: {:?}",
            plan.verdict
        );
        let pass = fx.svc.confirm_import(req.clone()).await.unwrap();
        let (_, rec) = fx.start(req, Some(pass)).await.expect("start");
        assert_eq!(report(&rec.wait().await)["rowsWritten"], 300, "{name}");
        assert_eq!(fx.rows("twin").await, fx.rows("t").await, "{name}");
    }
}

/// Q42: the check pass is refused on a Read-only Connection before any job starts.
async fn read_only_check_pass_refused(fx: &mut Fx) {
    fx.small_table("t").await;
    let ro = fx.other(false, true).await;
    let file = fx.write("r.csv", &csv_rows(10, &[]));
    let mut req = fx.req("t", &file, Format::Csv);
    req.connection_id = ro;
    let rec = Arc::new(Rec::default());
    assert!(matches!(
        fx.svc
            .check_import_file(JobId::new_v4(), req, rec.clone())
            .await,
        Err(Error::ReadOnly(0))
    ));
    assert!(fx.svc.jobs().list().is_empty());
    assert!(rec.events().is_empty());
}

macro_rules! per_dialect {
    ($($name:ident),* $(,)?) => {
        mod mysql {
            use super::*;
            $(
                #[tokio::test(flavor = "multi_thread")]
                async fn $name() {
                    #[allow(unused_mut)]
                    let mut fx = Fx::new(DialectKind::MySql).await;
                    super::$name(&mut fx).await;
                    fx.end().await;
                }
            )*
        }
        mod pg {
            use super::*;
            $(
                #[tokio::test(flavor = "multi_thread")]
                async fn $name() {
                    #[allow(unused_mut)]
                    let mut fx = Fx::new(DialectKind::Postgres).await;
                    super::$name(&mut fx).await;
                    fx.end().await;
                }
            )*
        }
        mod sqlite {
            use super::*;
            $(
                #[tokio::test(flavor = "multi_thread")]
                async fn $name() {
                    #[allow(unused_mut)]
                    let mut fx = Fx::new(DialectKind::Sqlite).await;
                    super::$name(&mut fx).await;
                    fx.end().await;
                }
            )*
        }
    };
}

per_dialect!(
    round_trip_each_format,
    stop_rolls_back_and_names_row,
    skip_keeps_rest_and_lists_row,
    skip_over_1000_rolls_back,
    commit_every_n_keeps_earlier_chunks,
    cancel_mid_way_leaves_target_unchanged,
    production_without_pass_needs_confirmation,
    production_pass_runs_once,
    file_changed_after_confirm_refused,
    read_only_refuses_before_any_job,
    job_busy_second_import_same_connection,
    zero_row_file_is_blocked,
    duplicate_header_names_map_by_index,
    json_missing_keys_are_null,
    check_pass_reports_failing_rows_and_sha256,
    history_entry_per_job,
    plan_shows_sample_and_one_transaction,
    null_word_option,
    skip_cap_after_committed_batches_says_what_stayed,
    null_word_round_trip,
    commit_every_n_below_500,
    binary_cells_not_hex_warn,
    file_changed_mid_run_fails_before_commit,
    blocked_start_keeps_the_pass,
    commit_every_n_holds_the_file,
    production_excel_and_json,
    read_only_check_pass_refused,
);

// ---- Dialect-only checks ----

/// D6: a value for an ALWAYS identity column needs OVERRIDING SYSTEM VALUE; `setval`
/// then leaves the next plain INSERT working.
#[tokio::test(flavor = "multi_thread")]
async fn pg_identity_always_gets_overriding_and_setval() {
    let fx = Fx::new(DialectKind::Postgres).await;
    fx.sql("CREATE TABLE public.ids (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text)")
        .await;
    let file = fx.write("ids.csv", "id,name\n5,a\n9,b\n");
    let req = fx.req("ids", &file, Format::Csv);
    let plan = fx.svc.plan_import(req.clone()).await.unwrap();
    assert!(
        plan.shape.head.contains("OVERRIDING SYSTEM VALUE"),
        "{}",
        plan.shape.head
    );
    assert_eq!(plan.extra.len(), 1);
    assert!(
        plan.extra[0].starts_with("SELECT setval("),
        "{}",
        plan.extra[0]
    );
    let (end, _) = fx.import(req).await;
    report(&end);
    fx.sql("INSERT INTO public.ids (name) VALUES ('next')")
        .await;
    let rows = fx.rows("ids").await;
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[2][0], Value::Number("10".into()));
    let history = fx.history(fx.id);
    assert!(history.iter().any(|h| h.sql.contains("setval")));
    fx.end().await;
}

/// Q42 minor: imported ids below the sequence's MINVALUE do not fail the `setval`.
#[tokio::test(flavor = "multi_thread")]
async fn pg_setval_below_minvalue() {
    let fx = Fx::new(DialectKind::Postgres).await;
    fx.sql(
        "CREATE TABLE public.ids (id int GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name text)",
    )
    .await;
    let file = fx.write("ids.csv", "id,name\n0,a\n-5,b\n");
    let (end, _) = fx.import(fx.req("ids", &file, Format::Csv)).await;
    report(&end);
    fx.sql("INSERT INTO public.ids (name) VALUES ('next')")
        .await;
    assert_eq!(fx.count("ids").await, 3);
    fx.end().await;
}

/// Q42: on Production a second import on a busy Connection is JobBusy before the pass
/// is spent, so the same pass runs once the first import ends.
#[tokio::test(flavor = "multi_thread")]
async fn job_busy_keeps_the_pass() {
    let mut fx = Fx::new(DialectKind::Sqlite).await;
    fx.small_table("t").await;
    fx.small_table("u").await;
    let prod = fx.other(true, false).await;
    let big = fx.write("big.csv", &csv_rows(300_000, &[]));
    let mut first = fx.req("t", &big, Format::Csv);
    first.connection_id = prod;
    let pass = fx.svc.confirm_import(first.clone()).await.unwrap();
    let (id, rec) = fx.start(first, Some(pass)).await.expect("start");
    let small = fx.write("s.csv", &csv_rows(5, &[]));
    let mut second = fx.req("u", &small, Format::Csv);
    second.connection_id = prod;
    let pass2 = fx.svc.confirm_import(second.clone()).await.unwrap();
    assert!(matches!(
        fx.start(second.clone(), Some(pass2)).await,
        Err(Error::JobBusy { .. })
    ));
    assert!(fx.svc.jobs().confirmed_file(pass2).is_some());
    fx.svc.jobs().cancel(id).await.unwrap();
    rec.wait().await;
    let (_, rec) = fx
        .start(second, Some(pass2))
        .await
        .expect("the pass still works");
    assert_eq!(report(&rec.wait().await)["rowsWritten"], 5);
    fx.end().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn mysql_auto_increment_continues() {
    let fx = Fx::new(DialectKind::MySql).await;
    fx.sql("CREATE TABLE ids (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(20)) ENGINE=InnoDB")
        .await;
    let file = fx.write("ids.csv", "id,name\n5,a\n9,b\n");
    let (end, _) = fx.import(fx.req("ids", &file, Format::Csv)).await;
    report(&end);
    fx.sql("INSERT INTO ids (name) VALUES ('next')").await;
    let rows = fx.rows("ids").await;
    assert_eq!(rows[2][0], Value::Number("10".into()));
    // An auto-increment column needs no value.
    let file = fx.write("names.csv", "name\nc\n");
    let (end, _) = fx.import(fx.req("ids", &file, Format::Csv)).await;
    report(&end);
    assert_eq!(fx.rows("ids").await[3][0], Value::Number("11".into()));
    fx.end().await;
}

/// Q27, Q28: a MyISAM table keeps what was written before a failure, and says so.
#[tokio::test(flavor = "multi_thread")]
async fn mysql_myisam_failure_reports_rows_kept() {
    let fx = Fx::new(DialectKind::MySql).await;
    fx.sql("CREATE TABLE m (id INT PRIMARY KEY, name VARCHAR(20)) ENGINE=MyISAM")
        .await;
    let mut body = String::from("id,name\n");
    for i in 1..=1_200 {
        body.push_str(&format!("{},n\n", if i == 1_100 { 3 } else { i }));
    }
    let file = fx.write("m.csv", &body);
    let req = fx.req("m", &file, Format::Csv);
    let plan = fx.svc.plan_import(req.clone()).await.unwrap();
    assert!(!plan.one_transaction);
    assert!(
        plan.warnings
            .contains(&"m uses MyISAM: rows written before a failure stay".to_string()),
        "{:?}",
        plan.warnings
    );
    let (end, _) = fx.import(req).await;
    failed(&end);
    // MyISAM takes one row a statement, so exactly the rows before the failing one
    // stay, and the count says so.
    let message = job_failed_message(failed(&end));
    assert!(message.starts_with("Row 1100 of the file: "), "{message}");
    let kept = fx.count("m").await as u64;
    assert_eq!(end["rowsCommitted"], kept);
    assert_eq!(kept, 1_099);
    fx.end().await;
}

/// Task 7 writes a non-zero SRID as `SRID=n;<wkt>`; the import reads it back into the
/// column with that SRID, and a column declared with an SRID gives it to plain WKT.
#[tokio::test(flavor = "multi_thread")]
async fn mysql_geometry_srid_imports() {
    let fx = Fx::new(DialectKind::MySql).await;
    fx.sql("CREATE TABLE g (id INT PRIMARY KEY, any_g GEOMETRY NULL, p POINT SRID 4326 NULL) ENGINE=InnoDB")
        .await;
    let file = fx.write(
        "g.csv",
        "id,any_g,p\n1,SRID=3857;POINT(1 2),POINT(10 20)\n2,POINT(3 4),\n",
    );
    let req = fx.req("g", &file, Format::Csv);
    let plan = fx.svc.plan_import(req.clone()).await.unwrap();
    assert!(
        plan.sample_insert
            .contains("ST_GeomFromText('POINT(1 2)', 3857)"),
        "{}",
        plan.sample_insert
    );
    assert!(
        plan.sample_insert
            .contains("ST_GeomFromText('POINT(10 20)', 4326)"),
        "{}",
        plan.sample_insert
    );
    let (end, _) = fx.import(req).await;
    report(&end);
    let src = fx
        .dialect()
        .await
        .open_row_source(&SourceRequest::Query {
            database: None,
            sql: "SELECT id, ST_SRID(any_g), ST_AsText(any_g), ST_SRID(p) FROM g ORDER BY id"
                .into(),
        })
        .await
        .unwrap();
    let rows = canonical_rows(src).await;
    let text = |v: &Value| match v {
        Value::Number(s) | Value::Text(s) => s.clone(),
        other => format!("{other:?}"),
    };
    let got: Vec<Vec<String>> = rows.iter().map(|r| r.iter().map(text).collect()).collect();
    assert_eq!(got[0], ["1", "3857", "POINT(1 2)", "4326"]);
    assert_eq!(got[1][1], "0");
    fx.end().await;
}
