//! The SQL file import service (Task 9): `plan_script`, `script_statements`,
//! `confirm_script` and `start_script` per Dialect, with a recording sink. Live MySQL and
//! PostgreSQL in `dbview_test_<8hex>` databases as `dbview_test`; SQLite in temp files.

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
    ExportOptions, ExportRequest, ExportSource, Format, JobId, JobVerdict, ScriptAction,
    ScriptRequest, SqlTableName,
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

fn job_failed_message(error: &Json) -> String {
    assert_eq!(error["kind"], "jobFailed", "{error}");
    error["message"]["message"].as_str().unwrap().to_string()
}

fn sha_hex(path: &Path) -> String {
    let bytes = std::fs::read(path).unwrap();
    sha2::Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
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
    ids: Vec<ConnectionId>,
    place: Place,
    database: String,
    db: Option<Db>,
}

const CLEANUP: Duration = Duration::from_secs(20);

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
                let file = dir.path().join("script.sqlite");
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

    fn req(&self, file: &Path) -> ScriptRequest {
        ScriptRequest {
            connection_id: self.id,
            database: Some(self.database.clone()),
            path: file.to_path_buf(),
            run_as_is: false,
        }
    }

    /// The first value of the first row `sql` reads, or None when it fails.
    async fn first_value(&self, sql: &str) -> Option<Value> {
        let req = SourceRequest::Query {
            database: None,
            sql: sql.into(),
        };
        let mut src = self.dialect().await.open_row_source(&req).await.ok()?;
        let mut first = None;
        loop {
            match src.next_chunk().await {
                Ok(Some(chunk)) => {
                    if first.is_none() {
                        first = chunk
                            .rows
                            .into_iter()
                            .next()
                            .and_then(|r| r.into_iter().next());
                    }
                }
                Ok(None) => break,
                Err(_) => return None,
            }
        }
        first
    }

    /// The rows in `table`, or None when it does not exist.
    async fn count(&self, table: &str) -> Option<u64> {
        let quoted = match self.kind {
            DialectKind::MySql => format!("`{table}`"),
            _ => format!("\"{table}\""),
        };
        match self
            .first_value(&format!("SELECT COUNT(*) FROM {quoted}"))
            .await?
        {
            Value::Number(n) | Value::Text(n) => n.parse().ok(),
            other => panic!("count is {other:?}"),
        }
    }

    async fn start(&self, req: ScriptRequest, pass: Option<PassId>) -> Result<Arc<Rec>, Error> {
        let rec = Arc::new(Rec::default());
        let id = JobId::new_v4();
        let got = self.svc.start_script(id, req, pass, rec.clone()).await?;
        assert_eq!(got, id, "the job keeps the client's id (Q21)");
        Ok(rec)
    }

    /// Starts the script and waits for its final event.
    async fn run(&self, req: ScriptRequest) -> Json {
        let rec = self.start(req, None).await.expect("start the script");
        rec.wait().await
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

fn create(kind: DialectKind, table: &str) -> String {
    match kind {
        DialectKind::MySql => {
            format!("CREATE TABLE `{table}` (id INT PRIMARY KEY, v VARCHAR(20)) ENGINE=InnoDB")
        }
        _ => format!("CREATE TABLE \"{table}\" (id INT PRIMARY KEY, v VARCHAR(20))"),
    }
}

fn insert(kind: DialectKind, table: &str, id: u64) -> String {
    match kind {
        DialectKind::MySql => format!("INSERT INTO `{table}` VALUES ({id}, 'v{id}')"),
        _ => format!("INSERT INTO \"{table}\" VALUES ({id}, 'v{id}')"),
    }
}

// ---- Shared checks, run per Dialect ----

/// 1,000 statements: ten tables, each created and filled, then a duplicate key in the
/// last statement. PostgreSQL and SQLite roll everything back; MySQL keeps the tables
/// (its DDL commits as it runs) and the rows each later CREATE committed.
async fn thousand_statements_with_ddl_late_failure(fx: &mut Fx) {
    let k = fx.kind;
    let mut lines = Vec::new();
    for t in 0..10 {
        lines.push(create(k, &format!("t{t}")));
        for id in 1..=98 {
            lines.push(insert(k, &format!("t{t}"), id));
        }
    }
    for id in 99..=107 {
        lines.push(insert(k, "t9", id));
    }
    lines.push(insert(k, "t9", 1));
    assert_eq!(lines.len(), 1_000);
    let body = lines.join(";\n") + ";\n";
    let file = fx.write("thousand.sql", &body);
    let plan = fx.svc.plan_script(fx.req(&file)).await.expect("plan");
    assert_eq!(plan.statements, 1_000);
    assert_eq!(plan.creates, 10);
    assert_eq!(plan.inserts, 990);
    assert!(plan.has_ddl);
    assert_eq!(plan.first.len(), 50);
    assert_eq!(plan.verdict, JobVerdict::Ok);
    assert_eq!(plan.one_transaction, k != DialectKind::MySql);
    assert!(!plan.own_transactions);
    assert_eq!(plan.sha256, sha_hex(&file));
    assert_eq!(plan.bytes, std::fs::metadata(&file).unwrap().len());

    let end = fx.run(fx.req(&file)).await;
    let error = failed(&end);
    let message = job_failed_message(error);
    assert!(message.starts_with("Line 1000: "), "{message}");
    assert_eq!(error["message"]["at"]["line"], 1000);
    assert_eq!(error["message"]["at"]["statement"], 1000);
    if k == DialectKind::MySql {
        for t in 0..9 {
            assert_eq!(fx.count(&format!("t{t}")).await, Some(98), "t{t}");
        }
        assert_eq!(fx.count("t9").await, Some(0));
        assert_eq!(end["rowsCommitted"], 9 * 98);
    } else {
        for t in 0..10 {
            assert_eq!(fx.count(&format!("t{t}")).await, None, "t{t} stayed");
        }
        assert_eq!(end["rowsCommitted"], 0);
    }
    let h = fx.history(fx.id);
    assert_eq!(h.len(), 1);
    assert!(h[0].changed);
    assert!(
        h[0].sql
            .starts_with("Ran 999 statements from thousand.sql: 10 create, 989 insert"),
        "{}",
        h[0].sql
    );
}

/// Task 7's SQL export of the fixture, run into an empty twin database, gives the same
/// canonical rows.
async fn sql_export_round_trip(fx: &mut Fx) {
    const ROWS: u64 = 20_000;
    let d = fx.dialect().await;
    every_type_table(d.as_ref(), fx.kind, "every", ROWS).await;
    let out = fx.file("every.sql");
    let rec = Arc::new(Rec::default());
    fx.svc
        .start_export(
            JobId::new_v4(),
            ExportRequest {
                connection_id: fx.id,
                source: ExportSource::Table {
                    path: fx.path("every"),
                    columns: Vec::new(),
                    filter: None,
                    sort: None,
                    keys: Vec::new(),
                },
                format: Format::Sql,
                options: ExportOptions {
                    table_name: SqlTableName::Unqualified,
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
    let want = canonical_rows(
        d.open_row_source(&SourceRequest::Table {
            path: fx.path("every"),
            columns: Vec::new(),
            filter: None,
            sort: None,
            keys: Vec::new(),
        })
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(want.len() as u64, ROWS);

    let twin = Fx::new(fx.kind).await;
    let td = twin.dialect().await;
    every_type_table(td.as_ref(), twin.kind, "every", 1).await;
    twin.sql(match twin.kind {
        DialectKind::MySql => "DELETE FROM `every`",
        _ => "DELETE FROM \"every\"",
    })
    .await;
    let plan = twin.svc.plan_script(twin.req(&out)).await.expect("plan");
    assert_eq!(plan.verdict, JobVerdict::Ok);
    assert_eq!(plan.inserts, plan.statements);
    let end = twin.run(twin.req(&out)).await;
    let r = report(&end);
    assert_eq!(r["rowsWritten"], ROWS, "{end}");
    let have = canonical_rows(
        td.open_row_source(&SourceRequest::Table {
            path: twin.path("every"),
            columns: Vec::new(),
            filter: None,
            sort: None,
            keys: Vec::new(),
        })
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(have.len(), want.len());
    for (i, (w, h)) in want.iter().zip(&have).enumerate() {
        assert_eq!(w, h, "row {i}");
    }
    drop(td);
    twin.end().await;
}

fn grant(kind: DialectKind) -> &'static str {
    match kind {
        DialectKind::MySql => "GRANT SELECT ON g TO 'contura_nobody'@'%'",
        _ => "GRANT SELECT ON g TO contura_nobody",
    }
}

/// A GRANT is skipped unless Run as is is ticked: it never reaches the server (the role
/// does not exist, so running it would fail the job).
async fn skipped_grant_not_run(fx: &mut Fx) {
    let k = fx.kind;
    let body = format!(
        "{};\n{};\n{};\n{};\n",
        create(k, "g"),
        grant(k),
        insert(k, "g", 1),
        insert(k, "g", 2)
    );
    let file = fx.write("grant.sql", &body);
    let plan = fx.svc.plan_script(fx.req(&file)).await.expect("plan");
    assert_eq!(plan.statements, 3);
    assert_eq!((plan.creates, plan.inserts), (1, 2));
    assert_eq!(plan.skipped.len(), 1);
    assert_eq!(plan.skipped[0].line, 2);
    assert_eq!(
        plan.skipped[0].action,
        ScriptAction::Skip {
            reason: "GRANT is skipped unless Run as is is ticked.".into()
        }
    );
    assert!(!plan.skipped[0].run_as_is);
    assert!(plan.refused.is_empty());
    assert!(plan.one_transaction == (k != DialectKind::MySql));
    // The confirmation lists what runs: the CREATE exactly, each INSERT as a shape.
    assert_eq!(plan.confirm.len(), 3);
    assert_eq!(plan.confirm_more, 0);
    let confirm = serde_json::to_value(&plan.confirm).unwrap();
    assert_eq!(confirm[0]["kind"], "exact");
    assert_eq!(confirm[0]["line"], 1);
    assert_eq!(confirm[1]["kind"], "shape");
    assert_eq!(confirm[1]["shape"]["rows"], 1);

    let end = fx.run(fx.req(&file)).await;
    let r = report(&end);
    assert_eq!(r["kind"], "scriptImport");
    assert_eq!(r["statements"], 3);
    assert_eq!(r["skipped"], 1);
    assert_eq!(r["rowsWritten"], 2);
    assert_eq!(fx.count("g").await, Some(2));
    let h = fx.history(fx.id);
    assert_eq!(h.len(), 1);
    assert_eq!(
        h[0].sql,
        "Ran 3 statements from grant.sql: 1 create, 2 insert"
    );
    assert!(h[0].changed);
}

/// A refused statement blocks the plan and the start, wherever it is in the file.
async fn refused_blocks_start(fx: &mut Fx) {
    let k = fx.kind;
    let refused = match k {
        DialectKind::Sqlite => "ATTACH DATABASE 'x.db' AS x",
        _ => "DROP DATABASE elsewhere",
    };
    let what = match k {
        DialectKind::Sqlite => "ATTACH",
        _ => "DROP DATABASE",
    };
    let mut body = format!("{};\n", create(k, "r"));
    for id in 1..=20 {
        body.push_str(&format!("{};\n", insert(k, "r", id)));
    }
    body.push_str(&format!("{refused};\n"));
    let file = fx.write("refused.sql", &body);
    let plan = fx.svc.plan_script(fx.req(&file)).await.expect("plan");
    let reason = format!("Line 22: {what} is not run from an import.");
    assert_eq!(
        plan.verdict,
        JobVerdict::Blocked {
            reasons: vec![reason.clone()]
        }
    );
    assert_eq!(plan.refused.len(), 1);
    assert_eq!(plan.refused[0].line, 22);
    let rec = Arc::new(Rec::default());
    match fx
        .svc
        .start_script(JobId::new_v4(), fx.req(&file), None, rec.clone())
        .await
    {
        Err(Error::InvalidInput(m)) => assert!(m.contains(&reason), "{m}"),
        other => panic!("not refused: {other:?}"),
    }
    assert!(matches!(
        fx.svc.confirm_script(fx.req(&file)).await,
        Err(Error::InvalidInput(_))
    ));
    assert!(fx.svc.jobs().list().is_empty());
    assert!(rec.events().is_empty());
    assert_eq!(fx.count("r").await, None);
    assert!(fx.history(fx.id).is_empty());
}

/// A file with its own transactions runs as written: what it committed stays, and its
/// open transaction rolls back at the failure.
async fn own_transactions_run_as_written(fx: &mut Fx) {
    let k = fx.kind;
    let body = [
        create(k, "o"),
        "BEGIN".into(),
        insert(k, "o", 1),
        insert(k, "o", 2),
        "COMMIT".into(),
        insert(k, "o", 3),
        "BEGIN".into(),
        insert(k, "o", 4),
        insert(k, "o", 1),
        "COMMIT".into(),
    ]
    .join(";\n")
        + ";\n";
    let file = fx.write("own.sql", &body);
    let plan = fx.svc.plan_script(fx.req(&file)).await.expect("plan");
    assert!(plan.own_transactions);
    assert!(!plan.one_transaction);
    assert_eq!(plan.statements, 10);
    let end = fx.run(fx.req(&file)).await;
    let message = job_failed_message(failed(&end));
    assert!(message.starts_with("Line 9: "), "{message}");
    assert_eq!(fx.count("o").await, Some(3));
    assert_eq!(end["rowsCommitted"], 3);
}

/// Production: no pass asks; a confirmed pass runs once; a file changed after the
/// confirmation is refused before anything runs (Q29).
async fn production_script_pass_and_file_changed(fx: &mut Fx) {
    let k = fx.kind;
    let prod = fx.other(true, false).await;
    let body = format!("{};\n{};\n", create(k, "p"), insert(k, "p", 1));
    let file = fx.write("prod.sql", &body);
    let mut req = fx.req(&file);
    req.connection_id = prod;

    let plan = fx.svc.plan_script(req.clone()).await.expect("plan");
    match &plan.verdict {
        JobVerdict::NeedsConfirmation {
            connection,
            file_bytes,
            file_sha256,
            fingerprint,
            ..
        } => {
            assert_eq!(connection, "freight-prod");
            assert_eq!(*file_bytes, body.len() as u64);
            assert_eq!(file_sha256, &sha_hex(&file));
            assert_eq!(fingerprint.len(), 64);
        }
        other => panic!("{other:?}"),
    }
    assert!(matches!(
        fx.start(req.clone(), None).await,
        Err(Error::NeedsConfirmation)
    ));
    assert_eq!(fx.count("p").await, None);

    let pass = fx.svc.confirm_script(req.clone()).await.expect("confirm");
    let rec = fx.start(req.clone(), Some(pass)).await.expect("start");
    report(&rec.wait().await);
    assert_eq!(fx.count("p").await, Some(1));
    // The pass is used up.
    assert!(matches!(
        fx.start(req.clone(), Some(pass)).await,
        Err(Error::NeedsConfirmation)
    ));

    let pass = fx.svc.confirm_script(req.clone()).await.expect("confirm");
    std::fs::write(&file, format!("{body}{};\n", insert(k, "p", 2))).unwrap();
    assert!(matches!(
        fx.start(req.clone(), Some(pass)).await,
        Err(Error::FileChanged { .. })
    ));
    assert_eq!(fx.count("p").await, Some(1));
    assert!(fx.svc.jobs().list().is_empty());
}

/// Read-only refuses the confirm and the start before any job; the plan says so.
async fn read_only_refused(fx: &mut Fx) {
    let k = fx.kind;
    let ro = fx.other(false, true).await;
    let file = fx.write("ro.sql", &format!("{};\n", create(k, "ro")));
    let mut req = fx.req(&file);
    req.connection_id = ro;
    let plan = fx.svc.plan_script(req.clone()).await.expect("plan");
    assert_eq!(
        plan.verdict,
        JobVerdict::ReadOnly {
            connection: "kestrel-reporting".into()
        }
    );
    assert!(matches!(
        fx.svc.confirm_script(req.clone()).await,
        Err(Error::ReadOnly(0))
    ));
    let rec = Arc::new(Rec::default());
    assert!(matches!(
        fx.svc
            .start_script(JobId::new_v4(), req, None, rec.clone())
            .await,
        Err(Error::ReadOnly(0))
    ));
    assert!(fx.svc.jobs().list().is_empty());
    assert!(rec.events().is_empty());
    assert_eq!(fx.count("ro").await, None);
}

/// `script_statements` pages through the file: `from: 50` gives indexes 50 to 149; a
/// statement that runs as is shows no Skip (Q12).
async fn statements_paging(fx: &mut Fx) {
    let k = fx.kind;
    let mut body = format!("{};\n", grant(k));
    for i in 1..200 {
        body.push_str(&format!("SELECT {i};\n"));
    }
    let file = fx.write("page.sql", &body);
    let page = fx
        .svc
        .script_statements(fx.id, &file, 50, false)
        .await
        .expect("page");
    let indexes: Vec<u32> = page.iter().map(|s| s.index).collect();
    assert_eq!(indexes, (50..150).collect::<Vec<_>>());
    assert_eq!(page[0].line, 51);
    assert_eq!(page[0].text, "SELECT 50");
    let tail = fx
        .svc
        .script_statements(fx.id, &file, 150, false)
        .await
        .expect("page");
    assert_eq!(tail.len(), 50);
    assert!(
        fx.svc
            .script_statements(fx.id, &file, 200, false)
            .await
            .expect("page")
            .is_empty()
    );
    let head = fx
        .svc
        .script_statements(fx.id, &file, 0, false)
        .await
        .expect("page");
    assert!(matches!(head[0].action, ScriptAction::Skip { .. }));
    let head = fx
        .svc
        .script_statements(fx.id, &file, 0, true)
        .await
        .expect("page");
    assert_eq!(head[0].action, ScriptAction::Run);
    assert!(head[0].run_as_is);
    // The path guard refuses Contura's data folder.
    let inside = fx.dir.path().join("data").join("x.sql");
    std::fs::write(&inside, "SELECT 1;").unwrap();
    assert!(
        fx.svc
            .script_statements(fx.id, &inside, 0, false)
            .await
            .is_err()
    );
}

async fn contura_backup_flagged(fx: &mut Fx) {
    let file = fx.write("backup.sql", "-- Contura backup, format 1\nSELECT 1;\n");
    let plan = fx.svc.plan_script(fx.req(&file)).await.expect("plan");
    assert!(plan.contura_backup);
    let file = fx.write("plain.sql", "-- made by hand\nSELECT 1;\n");
    let plan = fx.svc.plan_script(fx.req(&file)).await.expect("plan");
    assert!(!plan.contura_backup);
}

/// The confirmation holds the first 200 items and counts the rest.
async fn confirm_holds_200(fx: &mut Fx) {
    let k = fx.kind;
    let mut body = format!("{};\n", create(k, "c"));
    for id in 1..=250 {
        body.push_str(&format!("{};\n", insert(k, "c", id)));
    }
    let file = fx.write("confirm.sql", &body);
    let plan = fx.svc.plan_script(fx.req(&file)).await.expect("plan");
    assert_eq!(plan.confirm.len(), 200);
    assert_eq!(plan.confirm_more, 51);
}

/// Cancel rolls the script back and keeps the client's id.
async fn cancel_rolls_back(fx: &mut Fx) {
    let k = fx.kind;
    let mut body = format!("{};\n", create(k, "x"));
    for id in 1..=100_000 {
        body.push_str(&format!("{};\n", insert(k, "x", id)));
    }
    let file = fx.write("cancel.sql", &body);
    let rec = Arc::new(Rec::default());
    let id = JobId::new_v4();
    fx.svc
        .start_script(id, fx.req(&file), None, rec.clone())
        .await
        .expect("start");
    let until = Instant::now() + Duration::from_secs(60);
    // The start's read sends Checking progress; wait for the run's.
    while !rec
        .events()
        .iter()
        .any(|e| e["kind"] == "progress" && e["phase"] == "writing")
    {
        assert!(Instant::now() < until, "no progress");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    fx.svc.jobs().cancel(id).await.unwrap();
    let end = rec.wait().await;
    assert_eq!(failed(&end)["kind"], "cancelled", "{end}");
    if k == DialectKind::MySql {
        // The CREATE committed as it ran; its rows rolled back.
        assert_eq!(fx.count("x").await, Some(0));
    } else {
        assert_eq!(fx.count("x").await, None);
    }
}

macro_rules! per_dialect {
    ($($name:ident),* $(,)?) => {
        mod mysql {
            use super::*;
            $(
                #[tokio::test(flavor = "multi_thread")]
                async fn $name() {
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
                    let mut fx = Fx::new(DialectKind::Sqlite).await;
                    super::$name(&mut fx).await;
                    fx.end().await;
                }
            )*
        }
    };
}

per_dialect!(
    thousand_statements_with_ddl_late_failure,
    sql_export_round_trip,
    skipped_grant_not_run,
    refused_blocks_start,
    own_transactions_run_as_written,
    production_script_pass_and_file_changed,
    read_only_refused,
    statements_paging,
    contura_backup_flagged,
    confirm_holds_200,
    cancel_rolls_back,
    open_transaction_at_end_rolls_back,
    file_held_while_the_job_runs,
);

// ---- Dialect-only checks ----

/// Run as is (Q12, Q13): ANALYZE always runs; the REVOKE is skipped until Run as is is
/// ticked, then runs (on the test's own table, from its own user: no role is made).
#[tokio::test(flavor = "multi_thread")]
async fn pg_run_as_is_runs_revoke() {
    let fx = Fx::new(DialectKind::Postgres).await;
    fx.sql("CREATE TABLE ra (id int)").await;
    let file = fx.write(
        "revoke.sql",
        "ANALYZE ra;\nREVOKE INSERT ON ra FROM CURRENT_USER;\n",
    );
    let can_insert = || async {
        fx.first_value("SELECT has_table_privilege('ra', 'INSERT')")
            .await
    };
    let plan = fx.svc.plan_script(fx.req(&file)).await.expect("plan");
    assert_eq!(plan.statements, 1);
    assert_eq!(plan.skipped.len(), 1);
    report(&fx.run(fx.req(&file)).await);
    assert_eq!(can_insert().await, Some(Value::Bool(true)));

    let mut req = fx.req(&file);
    req.run_as_is = true;
    let plan = fx.svc.plan_script(req.clone()).await.expect("plan");
    assert_eq!(plan.statements, 2);
    assert!(plan.skipped.is_empty());
    assert!(plan.first[1].run_as_is);
    assert_eq!(plan.first[1].action, ScriptAction::Run);
    let r = report(&fx.run(req).await).clone();
    assert_eq!(r["statements"], 2);
    assert_eq!(r["skipped"], 0);
    assert_eq!(can_insert().await, Some(Value::Bool(false)));
    fx.end().await;
}

/// pg_dump's default COPY data cannot run here: the plan says how to make a dump that can.
#[tokio::test(flavor = "multi_thread")]
async fn pg_copy_from_stdin_names_inserts() {
    let fx = Fx::new(DialectKind::Postgres).await;
    let file = fx.write(
        "dump.sql",
        "CREATE TABLE cp (a int);\nCOPY public.cp (a) FROM stdin;\n1\n2\n\\.\n",
    );
    let plan = fx.svc.plan_script(fx.req(&file)).await.expect("plan");
    match &plan.verdict {
        JobVerdict::Blocked { reasons } => {
            assert_eq!(reasons.len(), 1);
            assert!(
                reasons[0].starts_with("Line 2: COPY FROM STDIN"),
                "{reasons:?}"
            );
            assert!(reasons[0].contains("pg_dump --inserts"), "{reasons:?}");
        }
        other => panic!("{other:?}"),
    }
    fx.end().await;
}

/// MySQL routine bodies run as one statement each; a body followed by a second
/// statement in the same DELIMITER block is refused by the server, and the table stays.
#[tokio::test(flavor = "multi_thread")]
async fn mysql_routine_bodies_and_smuggled_drop() {
    let fx = Fx::new(DialectKind::MySql).await;
    fx.sql("CREATE TABLE keep (id INT)").await;
    let file = fx.write(
        "routines.sql",
        "DELIMITER //\n\
         CREATE PROCEDURE p1() BEGIN SELECT 1; SELECT 2; END//\n\
         CREATE TRIGGER tr1 BEFORE INSERT ON keep FOR EACH ROW BEGIN SET NEW.id = NEW.id + 1; END//\n\
         DELIMITER ;\n\
         INSERT INTO keep VALUES (1);\n",
    );
    let r = report(&fx.run(fx.req(&file)).await).clone();
    assert_eq!(r["statements"], 3);
    assert_eq!(
        fx.first_value("SELECT id FROM keep").await,
        Some(Value::Number("2".into()))
    );

    let file = fx.write(
        "smuggled.sql",
        "DELIMITER //\nCREATE PROCEDURE p2() BEGIN SELECT 1; END; DROP TABLE keep//\nDELIMITER ;\n",
    );
    let end = fx.run(fx.req(&file)).await;
    let message = job_failed_message(failed(&end));
    assert!(message.starts_with("Line 2: "), "{message}");
    assert_eq!(fx.count("keep").await, Some(1));
    fx.end().await;
}

// ---- Fix round 1 (Q44) ----

/// A file that ends inside its own transaction fails, says its rows were rolled back,
/// and reports nothing kept (Q44 I2).
async fn open_transaction_at_end_rolls_back(fx: &mut Fx) {
    let k = fx.kind;
    let body = [
        create(k, "e"),
        "BEGIN".into(),
        insert(k, "e", 1),
        insert(k, "e", 2),
    ]
    .join(";\n")
        + ";\n";
    let file = fx.write("open.sql", &body);
    let end = fx.run(fx.req(&file)).await;
    assert_eq!(
        job_failed_message(failed(&end)),
        "The file left a transaction open. Its 2 rows were rolled back."
    );
    assert_eq!(end["rowsCommitted"], 0);
    assert_eq!(fx.count("e").await, Some(0));
}

/// The start opens the file once and holds it: no other program can write it while the
/// job runs, and it is free again after (Q44 I3).
async fn file_held_while_the_job_runs(fx: &mut Fx) {
    let k = fx.kind;
    let mut body = format!("{};\n", create(k, "h"));
    for id in 1..=100_000 {
        body.push_str(&format!("{};\n", insert(k, "h", id)));
    }
    let file = fx.write("held.sql", &body);
    let rec = Arc::new(Rec::default());
    let id = JobId::new_v4();
    fx.svc
        .start_script(id, fx.req(&file), None, rec.clone())
        .await
        .expect("start");
    let write = std::fs::OpenOptions::new().append(true).open(&file);
    #[cfg(windows)]
    assert!(
        write.is_err(),
        "another writer opened the file during the job"
    );
    drop(write);
    fx.svc.jobs().cancel(id).await.unwrap();
    rec.wait().await;
    assert!(
        std::fs::OpenOptions::new().append(true).open(&file).is_ok(),
        "the file is still held after the job"
    );
    // Held by another writer, the start refuses with a plain message.
    #[cfg(windows)]
    {
        let _writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap();
        match fx
            .svc
            .start_script(
                JobId::new_v4(),
                fx.req(&file),
                None,
                Arc::new(Rec::default()),
            )
            .await
        {
            Err(Error::File(m)) => assert_eq!(
                m,
                "held.sql is in use by another program. Close it there, then import again."
            ),
            other => panic!("{other:?}"),
        }
    }
}

/// MySQL `SET autocommit = 0`: rows wait for a COMMIT, so a failure keeps none, and a
/// file with no COMMIT is rolled back and says so (Q44 I2).
#[tokio::test(flavor = "multi_thread")]
async fn mysql_autocommit_off_counts_honestly() {
    let fx = Fx::new(DialectKind::MySql).await;
    let file = fx.write(
        "a.sql",
        "SET autocommit=0;\nCREATE TABLE a (id INT PRIMARY KEY);\nINSERT INTO a VALUES (1);\n\
         INSERT INTO a VALUES (2);\nINSERT INTO a VALUES (3);\nINSERT INTO a VALUES (1);\n",
    );
    let end = fx.run(fx.req(&file)).await;
    assert!(job_failed_message(failed(&end)).starts_with("Line 6: "));
    assert_eq!(end["rowsCommitted"], 0);
    assert_eq!(fx.count("a").await, Some(0));

    let file = fx.write(
        "b.sql",
        "SET @@session.autocommit = OFF;\nCREATE TABLE b (id INT PRIMARY KEY);\n\
         INSERT INTO b VALUES (1);\nINSERT INTO b VALUES (2);\nINSERT INTO b VALUES (3);\n",
    );
    let end = fx.run(fx.req(&file)).await;
    assert_eq!(
        job_failed_message(failed(&end)),
        "The file left a transaction open. Its 3 rows were rolled back."
    );
    assert_eq!(end["rowsCommitted"], 0);
    assert_eq!(fx.count("b").await, Some(0));

    // phpMyAdmin's shape: autocommit off, one transaction, a COMMIT at the end.
    let file = fx.write(
        "c.sql",
        "SET SQL_MODE = \"NO_AUTO_VALUE_ON_ZERO\";\nSET AUTOCOMMIT = 0;\nSTART TRANSACTION;\n\
         CREATE TABLE c (id INT PRIMARY KEY);\nINSERT INTO c VALUES (1), (2);\nCOMMIT;\n",
    );
    let r = report(&fx.run(fx.req(&file)).await).clone();
    assert_eq!(r["committed"], 2);
    assert_eq!(fx.count("c").await, Some(2));
    fx.end().await;
}

/// VACUUM and CREATE INDEX CONCURRENTLY cannot run in a transaction: each runs alone
/// between commits, and the rest still runs.
#[tokio::test(flavor = "multi_thread")]
async fn pg_vacuum_and_concurrently_run_alone() {
    let fx = Fx::new(DialectKind::Postgres).await;
    let file = fx.write(
        "vac.sql",
        "CREATE TABLE v (id int);\nINSERT INTO v VALUES (1);\nVACUUM v;\n\
         CREATE INDEX CONCURRENTLY vi ON v (id);\nINSERT INTO v VALUES (2);\n",
    );
    let plan = fx.svc.plan_script(fx.req(&file)).await.expect("plan");
    assert!(!plan.one_transaction);
    assert!(!plan.own_transactions);
    let r = report(&fx.run(fx.req(&file)).await).clone();
    assert_eq!(r["statements"], 5);
    assert_eq!(r["committed"], 2);
    assert_eq!(fx.count("v").await, Some(2));
    assert_eq!(
        fx.first_value("SELECT count(*) FROM pg_indexes WHERE indexname = 'vi'")
            .await,
        Some(Value::Number("1".into()))
    );
    fx.end().await;
}

const MYSQLDUMP: &str = r#"-- MySQL dump 10.13  Distrib 8.0.30, for Win64 (x86_64)
--
-- Host: 127.0.0.1    Database: shop
-- ------------------------------------------------------
-- Server version	8.0.30

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `items`
--

DROP TABLE IF EXISTS `items`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `items` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(40) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `items`
--

LOCK TABLES `items` WRITE;
/*!40000 ALTER TABLE `items` DISABLE KEYS */;
INSERT INTO `items` VALUES (1,'tea'),(2,'it\'s'),(3,'back\\slash');
/*!40000 ALTER TABLE `items` ENABLE KEYS */;
UNLOCK TABLES;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50003 TRIGGER `items_bi` BEFORE INSERT ON `items` FOR EACH ROW SET NEW.name = TRIM(NEW.name) */;;
DELIMITER ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;

--
-- Dumping routines for database 'shop'
--
DELIMITER ;;
CREATE PROCEDURE `item_count`()
BEGIN
  SELECT COUNT(*) FROM items;
END ;;
DELIMITER ;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-10-18 12:00:00
"#;

/// A mysqldump-shaped file (session SETs, LOCK TABLES, a trigger, a routine) runs end to
/// end as written.
#[tokio::test(flavor = "multi_thread")]
async fn mysqldump_shaped_file_runs() {
    let fx = Fx::new(DialectKind::MySql).await;
    let file = fx.write("shop.sql", MYSQLDUMP);
    let plan = fx.svc.plan_script(fx.req(&file)).await.expect("plan");
    assert_eq!(plan.verdict, JobVerdict::Ok);
    assert!(plan.skipped.is_empty());
    assert!(plan.own_transactions);
    let r = report(&fx.run(fx.req(&file)).await).clone();
    assert_eq!(r["committed"], 3);
    assert_eq!(fx.count("items").await, Some(3));
    assert_eq!(
        fx.first_value("SELECT name FROM items WHERE id = 3").await,
        Some(Value::Text("back\\slash".into()))
    );
    assert_eq!(
        fx.first_value(
            "SELECT COUNT(*) FROM information_schema.routines WHERE routine_name = 'item_count'"
        )
        .await,
        Some(Value::Number("1".into()))
    );
    fx.end().await;
}

const PG_DUMP: &str = r#"\restrict Ab12Cd34

--
-- PostgreSQL database dump
--

-- Dumped from database version 17.0
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

CREATE TABLE public.items (
    id integer NOT NULL,
    name text
);

CREATE SEQUENCE public.items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.items_id_seq OWNED BY public.items.id;

ALTER TABLE ONLY public.items ALTER COLUMN id SET DEFAULT nextval('public.items_id_seq'::regclass);

INSERT INTO public.items VALUES (1, 'tea');
INSERT INTO public.items VALUES (2, 'it''s');

SELECT pg_catalog.setval('public.items_id_seq', 2, true);

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_pkey PRIMARY KEY (id);

CREATE FUNCTION public.item_count() RETURNS bigint
    LANGUAGE sql
    AS $$SELECT count(*) FROM public.items$$;

--
-- PostgreSQL database dump complete
--

\unrestrict Ab12Cd34

"#;

/// A pg_dump --inserts file from pg_dump 17.6+ (`\restrict` and `\unrestrict` around it)
/// runs end to end; the psql lines are skipped, even with Run as is.
#[tokio::test(flavor = "multi_thread")]
async fn pg_dump_shaped_file_runs() {
    let fx = Fx::new(DialectKind::Postgres).await;
    let file = fx.write("shop.sql", PG_DUMP);
    let plan = fx.svc.plan_script(fx.req(&file)).await.expect("plan");
    assert_eq!(plan.verdict, JobVerdict::Ok);
    let reasons: Vec<String> = plan
        .skipped
        .iter()
        .map(|s| match &s.action {
            ScriptAction::Skip { reason } => reason.clone(),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(
        reasons,
        [
            "\\restrict is a psql line, so it is skipped.",
            "\\unrestrict is a psql line, so it is skipped."
        ]
    );
    assert!(plan.one_transaction);
    let mut req = fx.req(&file);
    req.run_as_is = true;
    let r = report(&fx.run(req).await).clone();
    assert_eq!(r["skipped"], 2);
    assert_eq!(r["rowsWritten"], 2);
    assert_eq!(fx.count("items").await, Some(2));
    assert_eq!(
        fx.first_value("SELECT last_value FROM public.items_id_seq")
            .await,
        Some(Value::Number("2".into()))
    );
    fx.end().await;
}

/// A second writing job refuses the start before the Production pass is spent, so the
/// same pass starts the job once the first ends (Q44 minors).
#[tokio::test(flavor = "multi_thread")]
async fn job_busy_keeps_the_production_pass() {
    let mut fx = Fx::new(DialectKind::Postgres).await;
    let prod = fx.other(true, false).await;
    let k = fx.kind;
    let mut long = format!("{};\n", create(k, "l"));
    for id in 1..=100_000 {
        long.push_str(&format!("{};\n", insert(k, "l", id)));
    }
    let long_file = fx.write("long.sql", &long);
    let short_file = fx.write("short.sql", &format!("{};\n", create(k, "s")));
    let mut long_req = fx.req(&long_file);
    long_req.connection_id = prod;
    let mut short_req = fx.req(&short_file);
    short_req.connection_id = prod;

    let long_pass = fx.svc.confirm_script(long_req.clone()).await.unwrap();
    let short_pass = fx.svc.confirm_script(short_req.clone()).await.unwrap();
    let rec = Arc::new(Rec::default());
    let long_id = JobId::new_v4();
    fx.svc
        .start_script(long_id, long_req, Some(long_pass), rec.clone())
        .await
        .expect("start");
    assert!(matches!(
        fx.start(short_req.clone(), Some(short_pass)).await,
        Err(Error::JobBusy { .. })
    ));
    fx.svc.jobs().cancel(long_id).await.unwrap();
    rec.wait().await;
    let rec = fx
        .start(short_req, Some(short_pass))
        .await
        .expect("the pass is still good");
    report(&rec.wait().await);
    assert_eq!(fx.count("s").await, Some(0));
    fx.end().await;
}
