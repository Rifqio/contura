//! The export service (Task 7): `preview_export` and `start_export` per Dialect, on the
//! every-type fixture, with a recording sink. Live MySQL and PostgreSQL in
//! `dbview_test_<8hex>` databases as `dbview_test`; SQLite in temp files.

mod common;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use calamine::{Data, Reader, Xlsx, open_workbook};
use common::TestDb;
use common::jobs::{canonical_rows, every_type_table, run_sql};
use common::pg::PgTestDb;
use contura_core::Error;
use contura_core::connections::{ConnectionInput, ConnectionService, PasswordChange};
use contura_core::dialect::{Dialect, connect};
use contura_core::jobs::JobSink;
use contura_core::jobs::formats::RecordReader;
use contura_core::jobs::formats::csv::CsvReader;
use contura_core::jobs::formats::json::JsonReader;
use contura_core::jobs::formats::value_text;
use contura_core::jobs::source::{SourceColumn, SourceRequest, Value};
use contura_core::jobs::types::{
    ExportOptions, ExportRequest, ExportSource, Format, JobId, JsonLayout, SqlTableName,
};
use contura_core::model::{Cell, ConnectionId, DialectKind, ObjectPath, SslMode};
use contura_core::query::{HistoryFilter, Outcome, ResultColumn};
use contura_core::secrets::MemorySecretStore;
use contura_core::store::AppStore;
use serde_json::Value as Json;

const ROWS: u64 = 3_000;
const REFUSE_WRITE: &str = "Only a statement that reads can be exported this way.";
const RERUN_NOTE: &str = "Runs the query again on its own connection.";
const PROD_BANNER: &str =
    "The file is plain text and holds Production rows. Keep it somewhere safe.";

// ---- The recording sink ----

#[derive(Default)]
struct Rec(Mutex<Vec<(Instant, Json)>>);

impl JobSink for Rec {
    fn send(&self, event: Json) {
        self.0.lock().unwrap().push((Instant::now(), event));
    }
}

impl Rec {
    fn events(&self) -> Vec<(Instant, Json)> {
        self.0.lock().unwrap().clone()
    }

    fn finals(&self) -> Vec<Json> {
        self.events()
            .into_iter()
            .map(|(_, e)| e)
            .filter(|e| e["kind"] == "finished" || e["kind"] == "failed")
            .collect()
    }

    /// Waits for the final event, at most a minute.
    async fn wait(&self) -> Json {
        let until = Instant::now() + Duration::from_secs(60);
        loop {
            if let Some(last) = self.finals().into_iter().next() {
                return last;
            }
            assert!(Instant::now() < until, "the job never ended");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

fn finished_report(event: &Json) -> &Json {
    assert_eq!(event["kind"], "finished", "{event}");
    &event["report"]
}

// ---- The fixture: a service with one open Connection holding `every` ----

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
    path: ObjectPath,
    /// Taken by `end`; on a panic, Drop closes the Connection first.
    db: Option<Db>,
}

#[derive(Clone, Copy, Default)]
struct Setup {
    production: bool,
    /// SQLite only: put the file in WAL mode.
    wal: bool,
    rows: u64,
}

fn input(kind: DialectKind, setup: Setup) -> ConnectionInput {
    ConnectionInput {
        id: None,
        name: "kestrel".into(),
        dialect: kind,
        host: String::new(),
        port: 0,
        user: String::new(),
        database: None,
        ssl: SslMode::Disable,
        password: PasswordChange::Keep,
        group_id: None,
        file: None,
        query_timeout_secs: None,
        ai_access: Default::default(),
        ai_sync: Default::default(),
        production: setup.production,
        read_only: false,
    }
}

impl Fx {
    async fn new(kind: DialectKind, setup: Setup) -> Fx {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("data")).unwrap();
        std::fs::create_dir_all(dir.path().join("out")).unwrap();
        let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
        let svc = Arc::new(
            ConnectionService::new(store, Arc::new(MemorySecretStore::new()))
                .with_data_dir(dir.path().join("data")),
        );
        let mut inp = input(kind, setup);
        let (db, path) = match kind {
            DialectKind::MySql => {
                let db = TestDb::create().await;
                inp.host = db.config.host.clone();
                inp.port = db.config.port;
                inp.user = db.config.user.clone();
                inp.database = db.config.database.clone();
                inp.password = PasswordChange::Set {
                    value: db.password.clone().unwrap_or_default(),
                };
                let path = ObjectPath {
                    database: db.name.clone(),
                    schema: None,
                    name: "every".into(),
                };
                (Db::My(db), path)
            }
            DialectKind::Postgres => {
                let db = PgTestDb::create().await;
                inp.host = db.config.host.clone();
                inp.port = db.config.port;
                inp.user = db.config.user.clone();
                inp.database = db.config.database.clone();
                inp.password = PasswordChange::Set {
                    value: db.password.clone().unwrap_or_default(),
                };
                let path = ObjectPath {
                    database: db.name.clone(),
                    schema: Some("public".into()),
                    name: "every".into(),
                };
                (Db::Pg(db), path)
            }
            DialectKind::Sqlite => {
                let file = dir.path().join("every.sqlite");
                let conn = rusqlite::Connection::open(&file).unwrap();
                if setup.wal {
                    let mode: String = conn
                        .query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))
                        .unwrap();
                    assert_eq!(mode, "wal");
                }
                drop(conn);
                inp.file = Some(file);
                let path = ObjectPath {
                    database: "main".into(),
                    schema: None,
                    name: "every".into(),
                };
                (Db::Lite, path)
            }
        };
        let saved = svc.save(inp).await.expect("save the Connection");
        svc.open(saved.id).await.expect("open the Connection");
        let fx = Fx {
            kind,
            dir,
            svc,
            id: saved.id,
            path,
            db: Some(db),
        };
        let rows = if setup.rows == 0 { ROWS } else { setup.rows };
        every_type_table(fx.dialect().await.as_ref(), kind, "every", rows).await;
        fx
    }

    async fn plain(kind: DialectKind) -> Fx {
        Fx::new(kind, Setup::default()).await
    }

    async fn dialect(&self) -> Arc<dyn Dialect> {
        self.svc
            .session(self.id)
            .await
            .expect("the Connection is open")
    }

    fn data(&self) -> PathBuf {
        self.dir.path().join("data")
    }

    fn out(&self, name: &str) -> PathBuf {
        self.dir.path().join("out").join(name)
    }

    fn table(&self, format: Format, file: &str) -> ExportRequest {
        // A `.ndjson` file is JSON Lines; the default JSON layout is one array (item 45).
        let options = if file.ends_with(".ndjson") {
            ExportOptions {
                json_layout: JsonLayout::Lines,
                ..ExportOptions::default()
            }
        } else {
            ExportOptions::default()
        };
        self.table_with(format, file, options)
    }

    fn table_with(&self, format: Format, file: &str, options: ExportOptions) -> ExportRequest {
        ExportRequest {
            connection_id: self.id,
            source: ExportSource::Table {
                path: self.path.clone(),
                columns: Vec::new(),
                filter: None,
                sort: None,
                keys: Vec::new(),
            },
            format,
            options,
            path: self.out(file),
            rows_hint: None,
        }
    }

    fn query(&self, sql: &str, format: Format, file: &str) -> ExportRequest {
        ExportRequest {
            connection_id: self.id,
            source: ExportSource::Query {
                database: None,
                sql: sql.into(),
                columns: Vec::new(),
            },
            format,
            options: ExportOptions::default(),
            path: self.out(file),
            rows_hint: None,
        }
    }

    /// Starts the export and waits for its final event.
    async fn export(&self, req: ExportRequest) -> (Json, Arc<Rec>) {
        let rec = Arc::new(Rec::default());
        self.svc
            .start_export(JobId::new_v4(), req, false, rec.clone())
            .await
            .expect("start the export");
        (rec.wait().await, rec)
    }

    async fn source_rows(&self) -> (Vec<SourceColumn>, Vec<Vec<Value>>) {
        let src = self
            .dialect()
            .await
            .open_row_source(&SourceRequest::Table {
                path: self.path.clone(),
                columns: Vec::new(),
                filter: None,
                sort: None,
                keys: Vec::new(),
            })
            .await
            .expect("open the source");
        let columns = src.columns().to_vec();
        (columns, canonical_rows(src).await)
    }

    fn table_sql(&self, name: &str) -> String {
        match self.kind {
            DialectKind::MySql => format!("`{name}`"),
            _ => format!("\"{name}\""),
        }
    }

    async fn end(mut self) {
        let _ = tokio::time::timeout(CLEANUP, self.svc.close(self.id)).await;
        let dropped = match self.db.take() {
            Some(Db::My(db)) => tokio::time::timeout(CLEANUP, db.drop_db()).await,
            Some(Db::Pg(db)) => tokio::time::timeout(CLEANUP, db.drop_db()).await,
            _ => Ok(()),
        };
        assert!(dropped.is_ok(), "the test database did not drop in time");
    }
}

/// Each cleanup step waits at most this long, so a failing test fails instead of hanging.
const CLEANUP: Duration = Duration::from_secs(20);

/// A test that panics closes its Connection before its database drops: an open export
/// or session connection would hold the table and make DROP DATABASE wait.
impl Drop for Fx {
    fn drop(&mut self) {
        if self.db.is_none() {
            return;
        }
        let (svc, id) = (self.svc.clone(), self.id);
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            tokio::task::block_in_place(|| {
                rt.block_on(async {
                    let _ = tokio::time::timeout(CLEANUP, svc.close(id)).await;
                })
            });
        }
    }
}

fn ext(format: Format, layout: JsonLayout) -> &'static str {
    match (format, layout) {
        (Format::Csv, _) => "csv",
        (Format::Json, JsonLayout::Lines) => "ndjson",
        (Format::Json, JsonLayout::Array) => "json",
        (Format::Xlsx, _) => "xlsx",
        (Format::Sql, _) => "sql",
    }
}

/// The first `n` physical lines of `text`, without their line ends or a BOM.
fn first_lines(text: &str, n: usize) -> Vec<String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    text.strip_suffix('\n')
        .unwrap_or(text)
        .split('\n')
        .take(n)
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .collect::<Vec<_>>()
}

fn read_all(reader: &mut dyn RecordReader) -> Vec<Vec<Option<String>>> {
    let mut out = Vec::new();
    while let Some(r) = reader.next_record().expect("read a record") {
        out.push(r.values);
    }
    out
}

fn same_json(a: &str, b: &str) -> bool {
    match (
        serde_json::from_str::<Json>(a),
        serde_json::from_str::<Json>(b),
    ) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

fn assert_text_rows(
    what: &str,
    columns: &[SourceColumn],
    rows: &[Vec<Value>],
    got: &[Vec<Option<String>>],
    opts: &ExportOptions,
) {
    assert_eq!(got.len(), rows.len(), "{what}: row count");
    for (r, (want, have)) in rows.iter().zip(got).enumerate() {
        assert_eq!(have.len(), want.len(), "{what}: row {r} width");
        for (c, (v, h)) in want.iter().zip(have).enumerate() {
            let w = value_text(v, opts);
            let json = columns[c].kind == contura_core::jobs::source::ValueKind::Json;
            let ok = match (&w, h) {
                (Some(a), Some(b)) if json => same_json(a, b),
                (a, b) => a == b,
            };
            assert!(
                ok,
                "{what}: row {r} column {}: want {w:?}, have {h:?}",
                columns[c].name
            );
        }
    }
}

/// A cell against the source value's text, independent of the writer's own mapping:
/// a number cell holds the number the text says, a bool cell its truth, a text cell the
/// text itself. Excel keeps no cell for NULL or empty text.
fn xlsx_text_matches(want: Option<&str>, have: &Data) -> bool {
    match have {
        Data::Empty => want.is_none_or(str::is_empty),
        Data::String(h) => want == Some(h.as_str()),
        Data::Float(f) => want.and_then(|w| w.trim().parse::<f64>().ok()) == Some(*f),
        Data::Int(i) => want.and_then(|w| w.trim().parse::<i64>().ok()) == Some(*i),
        Data::Bool(b) => match want.map(str::to_ascii_lowercase).as_deref() {
            Some("true" | "t" | "1") => *b,
            Some("false" | "f" | "0") => !*b,
            _ => false,
        },
        _ => false,
    }
}

// ---- Shared checks, run per Dialect ----

async fn each_format_matches_source(fx: &Fx) {
    let (columns, rows) = fx.source_rows().await;
    assert_eq!(rows.len() as u64, ROWS);
    let names: Vec<&str> = columns.iter().map(|c| c.name.as_str()).collect();
    for (format, layout) in [
        (Format::Csv, JsonLayout::Lines),
        (Format::Json, JsonLayout::Lines),
        (Format::Json, JsonLayout::Array),
        (Format::Xlsx, JsonLayout::Lines),
    ] {
        let opts = ExportOptions {
            json_layout: layout,
            ..ExportOptions::default()
        };
        let file = format!("every.{}", ext(format, layout));
        let (end, _) = fx.export(fx.table_with(format, &file, opts.clone())).await;
        let report = finished_report(&end);
        assert_eq!(report["rowsWritten"], ROWS, "{file}");
        let path = fx.out(&file);
        assert_eq!(
            report["bytes"].as_u64().unwrap(),
            std::fs::metadata(&path).unwrap().len(),
            "{file}: the report gives the file's size"
        );
        assert!(!fx.out(&format!("{file}.partial")).exists());
        match format {
            Format::Csv => {
                let mut r = CsvReader::open(&path, None, true).expect("open csv");
                assert_eq!(r.columns(), names.as_slice());
                assert_text_rows(&file, &columns, &rows, &read_all(&mut r), &opts);
            }
            Format::Json => {
                let mut r = JsonReader::open(&path).expect("open json");
                assert_eq!(r.columns(), names.as_slice());
                assert_text_rows(&file, &columns, &rows, &read_all(&mut r), &opts);
            }
            Format::Xlsx => {
                let mut book: Xlsx<_> = open_workbook(&path).expect("open xlsx");
                let range = book.worksheet_range("every").expect("sheet every");
                let mut it = range.rows();
                let header: Vec<String> =
                    it.next().unwrap().iter().map(|d| d.to_string()).collect();
                assert_eq!(header, names);
                let mut n = 0;
                for (r, (want, have)) in rows.iter().zip(it).enumerate() {
                    n += 1;
                    for (c, v) in want.iter().enumerate() {
                        let text = value_text(v, &opts);
                        let h = have.get(c).cloned().unwrap_or(Data::Empty);
                        assert!(
                            xlsx_text_matches(text.as_deref(), &h),
                            "{file}: row {r} column {}: want {text:?}, have {h:?}",
                            columns[c].name
                        );
                    }
                }
                assert_eq!(n, rows.len());
            }
            Format::Sql => unreachable!(),
        }
    }
}

async fn preview_equals_file_start(fx: &Fx) {
    for (format, layout) in [
        (Format::Csv, JsonLayout::Lines),
        (Format::Json, JsonLayout::Lines),
        (Format::Json, JsonLayout::Array),
        (Format::Sql, JsonLayout::Lines),
    ] {
        let opts = ExportOptions {
            json_layout: layout,
            ..ExportOptions::default()
        };
        let file = format!("start.{}", ext(format, layout));
        let req = fx.table_with(format, &file, opts);
        let preview = fx.svc.preview_export(req.clone()).await.expect("preview");
        assert_eq!(preview.sample_rows, 20, "{file}");
        assert!(preview.query_read, "{file}");
        assert!(preview.bytes_per_row > 0, "{file}");
        assert_eq!(preview.lines.len(), 6, "{file}");
        let (end, _) = fx.export(req).await;
        finished_report(&end);
        let text = std::fs::read_to_string(fx.out(&file)).unwrap();
        assert_eq!(preview.lines, first_lines(&text, 6), "{file}");
    }
    // Excel shows its first rows as a sheet: the header, then 20 rows.
    let preview = fx
        .svc
        .preview_export(fx.table(Format::Xlsx, "start.xlsx"))
        .await
        .expect("preview");
    let sheet = preview.sheet.expect("a sheet preview");
    assert_eq!(sheet.len(), 21);
    assert_eq!(sheet[0][0], "id");
    assert_eq!(sheet[1][0], "1");
    assert!(preview.lines.is_empty());
}

async fn zero_row_export_is_valid_per_format(fx: &Fx) {
    let zero = |format: Format, file: &str, layout: JsonLayout| {
        let mut req = fx.table_with(
            format,
            file,
            ExportOptions {
                json_layout: layout,
                ..ExportOptions::default()
            },
        );
        if let ExportSource::Table { filter, .. } = &mut req.source {
            *filter = Some("1 = 0".into());
        }
        req
    };
    let header = {
        let (columns, _) = fx.source_rows().await;
        columns.iter().map(|c| c.name.clone()).collect::<Vec<_>>()
    };

    let (end, _) = fx
        .export(zero(Format::Csv, "zero.csv", JsonLayout::Lines))
        .await;
    assert_eq!(finished_report(&end)["rowsWritten"], 0);
    let csv = std::fs::read_to_string(fx.out("zero.csv")).unwrap();
    assert_eq!(csv, format!("{}\r\n", header.join(",")));

    let (end, _) = fx
        .export(zero(Format::Json, "zero.ndjson", JsonLayout::Lines))
        .await;
    finished_report(&end);
    assert_eq!(std::fs::read_to_string(fx.out("zero.ndjson")).unwrap(), "");

    let (end, _) = fx
        .export(zero(Format::Json, "zero.json", JsonLayout::Array))
        .await;
    finished_report(&end);
    let text = std::fs::read_to_string(fx.out("zero.json")).unwrap();
    assert_eq!(
        serde_json::from_str::<Json>(&text).unwrap(),
        serde_json::json!([])
    );

    let (end, _) = fx
        .export(zero(Format::Xlsx, "zero.xlsx", JsonLayout::Lines))
        .await;
    finished_report(&end);
    let mut book: Xlsx<_> = open_workbook(fx.out("zero.xlsx")).expect("open xlsx");
    let range = book.worksheet_range("every").expect("sheet every");
    let rows: Vec<Vec<String>> = range
        .rows()
        .map(|r| r.iter().map(|d| d.to_string()).collect())
        .collect();
    assert_eq!(rows, vec![header.clone()]);

    let (end, _) = fx
        .export(zero(Format::Sql, "zero.sql", JsonLayout::Lines))
        .await;
    finished_report(&end);
    let sql = std::fs::read_to_string(fx.out("zero.sql")).unwrap();
    assert!(sql.starts_with("-- Contura export of "), "{sql}");
    assert_eq!(sql.lines().count(), 1, "{sql}");
}

async fn cancel_deletes_partial(fx: &Fx) {
    let rec = Arc::new(Rec::default());
    let job = JobId::new_v4();
    let req = fx.table(Format::Csv, "cancel.csv");
    fx.svc
        .start_export(job, req, false, rec.clone())
        .await
        .expect("start");
    fx.svc.jobs().cancel(job).await.unwrap();
    let end = rec.wait().await;
    assert_eq!(end["kind"], "failed", "{end}");
    assert_eq!(end["error"]["kind"], "cancelled", "{end}");
    assert!(!fx.out("cancel.csv").exists());
    assert!(!fx.out("cancel.csv.partial").exists());
    assert_eq!(rec.finals().len(), 1);
}

async fn existing_target_needs_overwrite(fx: &Fx) {
    let target = fx.out("there.csv");
    std::fs::write(&target, "old").unwrap();
    let rec = Arc::new(Rec::default());
    let err = fx
        .svc
        .start_export(
            JobId::new_v4(),
            fx.table(Format::Csv, "there.csv"),
            false,
            rec.clone(),
        )
        .await
        .expect_err("an existing file needs overwrite");
    assert!(
        matches!(err, Error::FileExists(ref p) if p == &target),
        "{err:?}"
    );
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "old");
    assert!(rec.events().is_empty(), "no job started");
    assert!(fx.svc.jobs().list().is_empty());

    fx.svc
        .start_export(
            JobId::new_v4(),
            fx.table(Format::Csv, "there.csv"),
            true,
            rec.clone(),
        )
        .await
        .expect("replace");
    finished_report(&rec.wait().await);
    assert!(std::fs::read_to_string(&target).unwrap().starts_with("id,"));
}

async fn inside_data_dir_refused(fx: &Fx) {
    let mut req = fx.table(Format::Csv, "x.csv");
    req.path = fx.data().join("x.csv");
    let err = fx
        .svc
        .start_export(JobId::new_v4(), req, false, Arc::new(Rec::default()))
        .await
        .expect_err("the data folder is refused");
    assert!(
        matches!(err, Error::InvalidInput(ref m) if m == "Save exports outside Contura's data folder."),
        "{err:?}"
    );
    assert!(!fx.data().join("x.csv").exists());
    assert!(!fx.data().join("x.csv.partial").exists());
}

async fn same_target_twice_refused(fx: &Fx) {
    let first = Arc::new(Rec::default());
    fx.svc
        .start_export(
            JobId::new_v4(),
            fx.table(Format::Csv, "twice.csv"),
            false,
            first.clone(),
        )
        .await
        .expect("start the first");
    let err = fx
        .svc
        .start_export(
            JobId::new_v4(),
            fx.table(Format::Csv, "twice.csv"),
            true,
            Arc::new(Rec::default()),
        )
        .await
        .expect_err("the second export to the same file is refused");
    assert!(
        matches!(err, Error::InvalidInput(ref m) if m == "Another export is writing to twice.csv."),
        "{err:?}"
    );
    finished_report(&first.wait().await);
    assert!(fx.out("twice.csv").exists());
}

async fn history_entry_changed_false(fx: &Fx) {
    let (end, _) = fx.export(fx.table(Format::Csv, "history.csv")).await;
    finished_report(&end);
    let history = fx
        .svc
        .query_history(
            Some(fx.id),
            HistoryFilter {
                search: None,
                only: None,
            },
        )
        .unwrap();
    let exports: Vec<_> = history
        .iter()
        .filter(|h| h.sql.starts_with("SELECT ") && h.sql.contains("every"))
        .collect();
    assert_eq!(exports.len(), 1, "{history:?}");
    let h = exports[0];
    assert!(!h.changed);
    assert_eq!(h.rows, Some(ROWS));
    assert_eq!(h.outcome, Outcome::Ok);
}

async fn result_export_reruns_read_query(fx: &Fx) {
    let sql = format!(
        "SELECT id, body FROM {} WHERE id <= 10",
        fx.table_sql("every")
    );
    let req = fx.query(&sql, Format::Csv, "result.csv");
    let preview = fx.svc.preview_export(req.clone()).await.expect("preview");
    assert!(preview.query_read);
    assert!(
        preview.notes.iter().any(|n| n == RERUN_NOTE),
        "{:?}",
        preview.notes
    );
    assert_eq!(preview.sample_rows, 10);
    let (end, _) = fx.export(req).await;
    assert_eq!(finished_report(&end)["rowsWritten"], 10);
    let mut r = CsvReader::open(&fx.out("result.csv"), None, true).unwrap();
    assert_eq!(r.columns(), ["id", "body"]);
    assert_eq!(read_all(&mut r).len(), 10);
    // Excel names a result's sheet "result".
    let (end, _) = fx.export(fx.query(&sql, Format::Xlsx, "result.xlsx")).await;
    finished_report(&end);
    let book: Xlsx<_> = open_workbook(fx.out("result.xlsx")).unwrap();
    assert_eq!(book.sheet_names(), ["result"]);
}

/// The result panel's shown columns: only those are written, in the order sent.
async fn query_export_keeps_the_shown_columns(fx: &Fx) {
    let sql = format!(
        "SELECT id, body FROM {} WHERE id <= 5",
        fx.table_sql("every")
    );
    let mut req = fx.query(&sql, Format::Csv, "shown.csv");
    if let ExportSource::Query { columns, .. } = &mut req.source {
        *columns = vec!["body".into(), "id".into()];
    }
    let preview = fx.svc.preview_export(req.clone()).await.expect("preview");
    assert_eq!(preview.lines[0], "body,id");
    let (end, _) = fx.export(req).await;
    assert_eq!(finished_report(&end)["rowsWritten"], 5);
    let mut r = CsvReader::open(&fx.out("shown.csv"), None, true).unwrap();
    assert_eq!(r.columns(), ["body", "id"]);
    assert_eq!(read_all(&mut r).len(), 5);
    // A column the result does not have fails the job, and no file is left.
    let mut req = fx.query(&sql, Format::Csv, "missing.csv");
    if let ExportSource::Query { columns, .. } = &mut req.source {
        *columns = vec!["total".into()];
    }
    let (end, _) = fx.export(req).await;
    assert_eq!(end["kind"], "failed", "{end}");
    assert!(
        end.to_string().contains("The result has no column total."),
        "{end}"
    );
    assert!(!fx.out("missing.csv").exists());
}

async fn count_rows(fx: &Fx) -> usize {
    fx.source_rows().await.1.len()
}

async fn result_export_of_write_reports_query_read_false(fx: &Fx) {
    let t = fx.table_sql("every");
    let mut writes = vec![
        format!("DELETE FROM {t} WHERE id = 1"),
        format!("UPDATE {t} SET body = 'x'"),
    ];
    if fx.kind != DialectKind::MySql {
        writes.push(format!(
            "INSERT INTO {t} (id) VALUES ({}) RETURNING id",
            ROWS + 1
        ));
    }
    for sql in writes {
        let req = fx.query(&sql, Format::Csv, "write.csv");
        let preview = fx.svc.preview_export(req.clone()).await.expect("preview");
        assert!(!preview.query_read, "{sql}");
        assert!(preview.lines.is_empty(), "{sql}: nothing ran");
        assert_eq!(preview.sample_rows, 0);
        let err = fx
            .svc
            .start_export(JobId::new_v4(), req, false, Arc::new(Rec::default()))
            .await
            .expect_err("a write is never exported by running it");
        assert!(
            matches!(err, Error::InvalidInput(ref m) if m == REFUSE_WRITE),
            "{sql}: {err:?}"
        );
        assert!(!fx.out("write.csv").exists());
        assert!(!fx.out("write.csv.partial").exists());
    }
    assert_eq!(count_rows(fx).await as u64, ROWS, "no statement ran");
}

async fn rows_shown_export_warns_cut_values(fx: &Fx) {
    let columns = vec![
        ResultColumn {
            name: "id".into(),
            type_name: "int".into(),
            numeric: true,
        },
        ResultColumn {
            name: "body".into(),
            type_name: "text".into(),
            numeric: false,
        },
        ResultColumn {
            name: "bin".into(),
            type_name: "blob".into(),
            numeric: false,
        },
    ];
    let text = |v: &str, truncated: bool| Cell::Text {
        value: v.into(),
        truncated,
        total_bytes: if truncated { 5000 } else { v.len() as u64 },
    };
    let rows = vec![
        vec![
            Cell::Number { value: "1".into() },
            text("short", false),
            Cell::Bytes {
                preview_hex: "00ff".into(),
                truncated: false,
                total_bytes: 2,
            },
        ],
        vec![
            Cell::Number { value: "2".into() },
            text("cut a", true),
            Cell::Bytes {
                preview_hex: "0102".into(),
                truncated: true,
                total_bytes: 4000,
            },
        ],
        vec![
            Cell::Number { value: "3".into() },
            text("cut b", true),
            Cell::Null,
        ],
    ];
    let req = ExportRequest {
        connection_id: fx.id,
        source: ExportSource::Rows { columns, rows },
        format: Format::Csv,
        options: ExportOptions::default(),
        path: fx.out("shown.csv"),
        rows_hint: None,
    };
    let preview = fx.svc.preview_export(req.clone()).await.expect("preview");
    assert_eq!(preview.sample_rows, 3);
    assert!(!preview.notes.iter().any(|n| n == RERUN_NOTE));
    let (end, _) = fx.export(req).await;
    let report = finished_report(&end);
    assert_eq!(report["rowsWritten"], 3);
    let warnings: Vec<&str> = report["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w.as_str().unwrap())
        .collect();
    assert!(
        warnings.contains(&"3 values were cut to 1 KB previews."),
        "{warnings:?}"
    );
    let csv = std::fs::read_to_string(fx.out("shown.csv")).unwrap();
    assert_eq!(
        csv,
        "id,body,bin\r\n1,short,0x00ff\r\n2,cut a,0x0102\r\n3,cut b,\r\n"
    );
}

async fn progress_throttled_and_finished_once(kind: DialectKind) {
    let fx = Fx::new(
        kind,
        Setup {
            rows: 100_000,
            ..Setup::default()
        },
    )
    .await;
    let (end, rec) = fx.export(fx.table(Format::Json, "progress.ndjson")).await;
    finished_report(&end);
    // Nothing comes after the final event.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let events = rec.events();
    assert_eq!(rec.finals().len(), 1, "{events:?}");
    assert!(
        matches!(events.last(), Some((_, e)) if e["kind"] == "finished"),
        "the final event is the last"
    );
    let progress: Vec<Instant> = events
        .iter()
        .filter(|(_, e)| e["kind"] == "progress")
        .map(|(t, _)| *t)
        .collect();
    assert!(progress.len() >= 2, "{} progress events", progress.len());
    for pair in progress.windows(2) {
        assert!(
            pair[1].duration_since(pair[0]) >= Duration::from_millis(95),
            "progress came {:?} apart",
            pair[1].duration_since(pair[0])
        );
    }
    fx.end().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn progress_throttled_and_finished_once_mysql() {
    progress_throttled_and_finished_once(DialectKind::MySql).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn progress_throttled_and_finished_once_pg() {
    progress_throttled_and_finished_once(DialectKind::Postgres).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn progress_throttled_and_finished_once_sqlite() {
    progress_throttled_and_finished_once(DialectKind::Sqlite).await;
}

async fn production_banner_never_in_notes(kind: DialectKind) {
    let fx = Fx::new(
        kind,
        Setup {
            production: true,
            ..Setup::default()
        },
    )
    .await;
    for format in [Format::Csv, Format::Json, Format::Xlsx, Format::Sql] {
        let preview = fx
            .svc
            .preview_export(fx.table(format, "prod.out"))
            .await
            .expect("preview");
        assert!(
            !preview.notes.iter().any(|n| n == PROD_BANNER),
            "{format:?}: {:?}",
            preview.notes
        );
    }
    fx.end().await;
}

/// The SQL file of `fx`'s table, run into an empty twin of it, gives the same rows.
async fn sql_export_loads_back(
    fx: &Fx,
    twin: &dyn Dialect,
    twin_path: &ObjectPath,
    run: impl AsyncRun,
) {
    let opts = ExportOptions {
        table_name: SqlTableName::Unqualified,
        rows_per_statement: 100,
        ..ExportOptions::default()
    };
    let (end, _) = fx
        .export(fx.table_with(Format::Sql, "every.sql", opts))
        .await;
    finished_report(&end);
    let sql = std::fs::read_to_string(fx.out("every.sql")).unwrap();
    run.run(sql).await;
    let (_, want) = fx.source_rows().await;
    let have = canonical_rows(
        twin.open_row_source(&SourceRequest::Table {
            path: twin_path.clone(),
            columns: Vec::new(),
            filter: None,
            sort: None,
            keys: Vec::new(),
        })
        .await
        .expect("open the twin"),
    )
    .await;
    assert_eq!(have.len(), want.len());
    for (w, h) in want.iter().zip(&have) {
        assert_eq!(w, h);
    }
}

/// Runs a whole SQL file on the twin, through the driver.
trait AsyncRun {
    fn run(self, sql: String) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()>>>;
}

macro_rules! per_dialect {
    ($($name:ident),* $(,)?) => {
        mod mysql {
            use super::*;
            $(
                #[tokio::test(flavor = "multi_thread")]
                async fn $name() {
                    let fx = Fx::plain(DialectKind::MySql).await;
                    super::$name(&fx).await;
                    fx.end().await;
                }
            )*
        }
        mod pg {
            use super::*;
            $(
                #[tokio::test(flavor = "multi_thread")]
                async fn $name() {
                    let fx = Fx::plain(DialectKind::Postgres).await;
                    super::$name(&fx).await;
                    fx.end().await;
                }
            )*
        }
        mod sqlite {
            use super::*;
            $(
                #[tokio::test(flavor = "multi_thread")]
                async fn $name() {
                    let fx = Fx::plain(DialectKind::Sqlite).await;
                    super::$name(&fx).await;
                    fx.end().await;
                }
            )*
        }
    };
}

per_dialect!(
    each_format_matches_source,
    preview_equals_file_start,
    zero_row_export_is_valid_per_format,
    cancel_deletes_partial,
    existing_target_needs_overwrite,
    inside_data_dir_refused,
    same_target_twice_refused,
    history_entry_changed_false,
    result_export_reruns_read_query,
    query_export_keeps_the_shown_columns,
    result_export_of_write_reports_query_read_false,
);

#[tokio::test(flavor = "multi_thread")]
async fn rows_shown_export_warns_cut_values_sqlite() {
    let fx = Fx::plain(DialectKind::Sqlite).await;
    rows_shown_export_warns_cut_values(&fx).await;
    fx.end().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn production_banner_never_in_notes_each_dialect() {
    for kind in [
        DialectKind::Sqlite,
        DialectKind::Postgres,
        DialectKind::MySql,
    ] {
        production_banner_never_in_notes(kind).await;
    }
}

// ---- Notes ----

#[tokio::test(flavor = "multi_thread")]
async fn myisam_note() {
    let fx = Fx::plain(DialectKind::MySql).await;
    run_sql(
        fx.dialect().await.as_ref(),
        "CREATE TABLE m (id INT PRIMARY KEY, name TEXT) ENGINE=MyISAM",
    )
    .await;
    run_sql(fx.dialect().await.as_ref(), "INSERT INTO m VALUES (1, 'a')").await;
    let mut req = fx.table(Format::Csv, "m.csv");
    if let ExportSource::Table { path, .. } = &mut req.source {
        path.name = "m".into();
    }
    let preview = fx.svc.preview_export(req).await.expect("preview");
    assert!(
        preview
            .notes
            .iter()
            .any(|n| n == "m uses MyISAM: rows changed while the export runs may be in the file."),
        "{:?}",
        preview.notes
    );
    // InnoDB has a snapshot: no note.
    let preview = fx
        .svc
        .preview_export(fx.table(Format::Csv, "every.csv"))
        .await
        .expect("preview");
    assert!(
        !preview.notes.iter().any(|n| n.contains("MyISAM")),
        "{:?}",
        preview.notes
    );
    fx.end().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn sqlite_journal_note() {
    let fx = Fx::plain(DialectKind::Sqlite).await;
    let note = "Saves to this file wait until the export ends.";
    let preview = fx
        .svc
        .preview_export(fx.table(Format::Csv, "a.csv"))
        .await
        .unwrap();
    assert!(
        preview.notes.iter().any(|n| n == note),
        "{:?}",
        preview.notes
    );
    fx.end().await;
    let fx = Fx::new(
        DialectKind::Sqlite,
        Setup {
            wal: true,
            ..Setup::default()
        },
    )
    .await;
    let preview = fx
        .svc
        .preview_export(fx.table(Format::Csv, "a.csv"))
        .await
        .unwrap();
    assert!(
        !preview.notes.iter().any(|n| n == note),
        "{:?}",
        preview.notes
    );
    fx.end().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn postgres_utc_note_for_text_formats() {
    let fx = Fx::plain(DialectKind::Postgres).await;
    let note = "timestamptz values are written in UTC";
    for (format, has) in [
        (Format::Csv, true),
        (Format::Json, true),
        (Format::Xlsx, false),
        (Format::Sql, false),
    ] {
        let preview = fx
            .svc
            .preview_export(fx.table(format, "a.out"))
            .await
            .unwrap();
        assert_eq!(
            preview.notes.iter().any(|n| n == note),
            has,
            "{format:?}: {:?}",
            preview.notes
        );
    }
    // Q45 M1: the grid's PostgreSQL session runs in UTC, so "Rows shown" is UTC too.
    let shown = |format: Format| ExportRequest {
        connection_id: fx.id,
        source: ExportSource::Rows {
            columns: vec![ResultColumn {
                name: "at".into(),
                type_name: "timestamptz".into(),
                numeric: false,
            }],
            rows: vec![vec![Cell::Text {
                value: "2026-10-18 09:00:00+00".into(),
                truncated: false,
                total_bytes: 22,
            }]],
        },
        format,
        options: ExportOptions::default(),
        path: fx.out("shown.out"),
        rows_hint: None,
    };
    for (format, has) in [
        (Format::Csv, true),
        (Format::Json, true),
        (Format::Xlsx, false),
    ] {
        let preview = fx.svc.preview_export(shown(format)).await.unwrap();
        assert_eq!(
            preview.notes.iter().any(|n| n == note),
            has,
            "rows shown {format:?}: {:?}",
            preview.notes
        );
    }
    fx.end().await;
}

// ---- NaN and Infinity are never bare numbers (Q32b) ----

#[tokio::test(flavor = "multi_thread")]
async fn non_finite_never_bare_postgres() {
    let fx = Fx::plain(DialectKind::Postgres).await;
    // Rows 2, 3 and 4 hold NaN, Infinity and -Infinity in float_n.
    let (end, _) = fx.export(fx.table(Format::Json, "nf.ndjson")).await;
    finished_report(&end);
    let text = std::fs::read_to_string(fx.out("nf.ndjson")).unwrap();
    let lines: Vec<Json> = text
        .lines()
        .map(|l| serde_json::from_str(l).expect("every line is JSON"))
        .collect();
    assert_eq!(lines[1]["float_n"], "NaN");
    assert_eq!(lines[2]["float_n"], "Infinity");
    assert_eq!(lines[3]["float_n"], "-Infinity");
    let (end, _) = fx.export(fx.table(Format::Sql, "nf.sql")).await;
    finished_report(&end);
    let sql = std::fs::read_to_string(fx.out("nf.sql")).unwrap();
    assert!(
        sql.contains("'NaN'::float8"),
        "PostgreSQL keeps NaN as its literal"
    );
    fx.end().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn non_finite_never_bare_sqlite() {
    let fx = Fx::plain(DialectKind::Sqlite).await;
    run_sql(
        fx.dialect().await.as_ref(),
        "UPDATE every SET float_n = 9e999 WHERE id = 7",
    )
    .await;
    let (end, _) = fx.export(fx.table(Format::Json, "nf.ndjson")).await;
    finished_report(&end);
    let text = std::fs::read_to_string(fx.out("nf.ndjson")).unwrap();
    let row7: Json = serde_json::from_str(text.lines().nth(6).unwrap()).unwrap();
    assert!(row7["float_n"].is_string(), "{row7}");
    let (end, _) = fx.export(fx.table(Format::Sql, "nf.sql")).await;
    let report = finished_report(&end);
    let warnings = report["warnings"].to_string();
    assert!(warnings.contains("NaN or Infinity"), "{warnings}");
    fx.end().await;
}

// ---- A read error never commits the file ----

#[tokio::test(flavor = "multi_thread")]
async fn failed_read_keeps_no_file() {
    let fx = Fx::plain(DialectKind::Postgres).await;
    // A filter the server refuses while reading: division by zero on row 2,500.
    let mut req = fx.table(Format::Csv, "broken.csv");
    if let ExportSource::Table { filter, .. } = &mut req.source {
        *filter = Some("1 / (id - 2500) IS NOT NULL".into());
    }
    let (end, _) = fx.export(req).await;
    assert_eq!(end["kind"], "failed", "{end}");
    assert_ne!(end["error"]["kind"], "cancelled");
    assert!(!fx.out("broken.csv").exists());
    assert!(!fx.out("broken.csv.partial").exists());
    let history = fx
        .svc
        .query_history(
            Some(fx.id),
            HistoryFilter {
                search: None,
                only: None,
            },
        )
        .unwrap();
    assert!(
        history
            .iter()
            .any(|h| h.outcome == Outcome::Error && !h.changed)
    );
    fx.end().await;
}

// ---- The SQL preview counts the statement cuts ----

/// A SQLite table under a long INSERT head: 300 integer columns with long names.
async fn wide_table(d: &dyn Dialect, rows: usize, body: usize) {
    let names: Vec<String> = (0..300)
        .map(|i| format!("a_rather_long_column_name_number_{i:04}"))
        .collect();
    run_sql(d, "DROP TABLE IF EXISTS wide").await;
    run_sql(
        d,
        &format!(
            "CREATE TABLE wide (id INTEGER PRIMARY KEY, body TEXT, {})",
            names
                .iter()
                .map(|n| format!("{n} INTEGER"))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    )
    .await;
    run_sql(
        d,
        &format!(
            "INSERT INTO wide
             WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < {rows})
             SELECT n, substr(replace(hex(zeroblob({body})), '0', 'x'), 1, {body}), {}
             FROM seq",
            vec!["n % 7"; 300].join(", ")
        ),
    )
    .await;
}

/// The size line multiplies `bytes_per_row` by the row count, so for SQL it must count
/// a head per statement as the file has them: 500 rows to a statement for narrow rows,
/// fewer when the 1 MiB cut comes first.
#[tokio::test(flavor = "multi_thread")]
async fn sql_preview_size_counts_statement_cuts() {
    let fx = Fx::plain(DialectKind::Sqlite).await;
    for (rows, body) in [(2_000usize, 1usize), (60, 300_000)] {
        wide_table(fx.dialect().await.as_ref(), rows, body).await;
        let mut req = fx.table(Format::Sql, &format!("wide{rows}.sql"));
        if let ExportSource::Table { path, .. } = &mut req.source {
            path.name = "wide".into();
        }
        let preview = fx.svc.preview_export(req.clone()).await.unwrap();
        let (end, _) = fx.export(req).await;
        let bytes = finished_report(&end)["bytes"].as_u64().unwrap() as f64;
        let estimate = (preview.bytes_per_row * rows as u64) as f64;
        let off = (estimate - bytes).abs() / bytes;
        assert!(
            off < 0.03,
            "{rows} rows: estimate {estimate}, file {bytes} ({:.1}% off)",
            off * 100.0
        );
    }
    fx.end().await;
}

// ---- Live load-back of the SQL output ----

struct MyRun(mysql_async::Opts);

impl AsyncRun for MyRun {
    fn run(self, sql: String) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()>>> {
        Box::pin(async move {
            use mysql_async::prelude::Queryable;
            let mut conn = mysql_async::Conn::new(self.0)
                .await
                .expect("connect the twin");
            conn.query_drop(sql).await.expect("the SQL file runs");
            conn.disconnect().await.ok();
        })
    }
}

struct PgRun(String);

impl AsyncRun for PgRun {
    fn run(self, sql: String) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()>>> {
        Box::pin(async move {
            let client = common::pg::pg_admin_client(&self.0).await;
            client.batch_execute(&sql).await.expect("the SQL file runs");
        })
    }
}

struct LiteRun(PathBuf);

impl AsyncRun for LiteRun {
    fn run(self, sql: String) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()>>> {
        Box::pin(async move {
            let conn = rusqlite::Connection::open(&self.0).unwrap();
            conn.execute_batch(&sql).expect("the SQL file runs");
        })
    }
}

fn my_opts(db: &TestDb) -> mysql_async::Opts {
    mysql_async::OptsBuilder::default()
        .ip_or_hostname(db.config.host.clone())
        .tcp_port(db.config.port)
        .user(Some(db.config.user.clone()))
        .pass(db.password.clone())
        .db_name(Some(db.name.clone()))
        .into()
}

#[tokio::test(flavor = "multi_thread")]
async fn sql_export_loads_back_mysql() {
    let fx = Fx::plain(DialectKind::MySql).await;
    // Values outside the declared type's usual form are written as stored (Q34 I2).
    run_sql(
        fx.dialect().await.as_ref(),
        "UPDATE every SET flag = 2 WHERE id = 6",
    )
    .await;
    let twin = TestDb::create().await;
    let twin_d = connect(&twin.config, twin.password.as_deref())
        .await
        .unwrap();
    every_type_table(twin_d.as_ref(), DialectKind::MySql, "every", 1).await;
    run_sql(twin_d.as_ref(), "DELETE FROM every").await;
    let path = ObjectPath {
        database: twin.name.clone(),
        schema: None,
        name: "every".into(),
    };
    sql_export_loads_back(&fx, twin_d.as_ref(), &path, MyRun(my_opts(&twin))).await;
    twin_d.disconnect().await.ok();
    twin.drop_db().await;
    fx.end().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn sql_export_loads_back_postgres() {
    let fx = Fx::plain(DialectKind::Postgres).await;
    let twin = PgTestDb::create().await;
    let twin_d = connect(&twin.config, twin.password.as_deref())
        .await
        .unwrap();
    every_type_table(twin_d.as_ref(), DialectKind::Postgres, "every", 1).await;
    run_sql(twin_d.as_ref(), "DELETE FROM every").await;
    let path = ObjectPath {
        database: twin.name.clone(),
        schema: Some("public".into()),
        name: "every".into(),
    };
    sql_export_loads_back(&fx, twin_d.as_ref(), &path, PgRun(twin.name.clone())).await;
    twin_d.disconnect().await.ok();
    twin.drop_db().await;
    fx.end().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn sql_export_loads_back_sqlite() {
    let fx = Fx::plain(DialectKind::Sqlite).await;
    // Values outside the declared type's usual form are written as stored (Q34 I2).
    run_sql(
        fx.dialect().await.as_ref(),
        "UPDATE every SET int_n = '' WHERE id = 5",
    )
    .await;
    run_sql(
        fx.dialect().await.as_ref(),
        "UPDATE every SET flag = 'yes' WHERE id = 6",
    )
    .await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("twin.sqlite");
    let config = contura_core::model::ConnectionConfig {
        id: uuid::Uuid::new_v4(),
        name: "twin".into(),
        dialect: DialectKind::Sqlite,
        host: String::new(),
        port: 0,
        user: String::new(),
        database: None,
        ssl: SslMode::Disable,
        group_id: None,
        file: Some(file.clone()),
        query_timeout_secs: None,
        ai_access: Default::default(),
        ai_sync: Default::default(),
        production: false,
        read_only: false,
    };
    rusqlite::Connection::open(&file).unwrap();
    let twin_d = connect(&config, None).await.unwrap();
    every_type_table(twin_d.as_ref(), DialectKind::Sqlite, "every", 1).await;
    run_sql(twin_d.as_ref(), "DELETE FROM every").await;
    let path = ObjectPath {
        database: "main".into(),
        schema: None,
        name: "every".into(),
    };
    sql_export_loads_back(&fx, twin_d.as_ref(), &path, LiteRun(file)).await;
    twin_d.disconnect().await.ok();
    fx.end().await;
}

/// MySQL geometry keeps its SRID through a SQL export (Q34 I1): a column declared with
/// an SRID, and a plain GEOMETRY column holding values of several SRIDs.
#[tokio::test(flavor = "multi_thread")]
async fn mysql_geometry_srid_loads_back() {
    let fx = Fx::plain(DialectKind::MySql).await;
    let create = "CREATE TABLE geo (id INT PRIMARY KEY, p POINT SRID 4326, g GEOMETRY)";
    run_sql(fx.dialect().await.as_ref(), create).await;
    run_sql(
        fx.dialect().await.as_ref(),
        "INSERT INTO geo VALUES
           (1, ST_GeomFromText('POINT(10 20)', 4326), ST_GeomFromText('POINT(1 2)', 3857)),
           (2, ST_GeomFromText('POINT(30 40)', 4326), ST_GeomFromText('LINESTRING(0 0, 1 1)')),
           (3, NULL, NULL)",
    )
    .await;
    let mut req = fx.table_with(
        Format::Sql,
        "geo.sql",
        ExportOptions {
            table_name: SqlTableName::Unqualified,
            ..ExportOptions::default()
        },
    );
    if let ExportSource::Table { path, .. } = &mut req.source {
        path.name = "geo".into();
    }
    let (end, _) = fx.export(req).await;
    finished_report(&end);
    let sql = std::fs::read_to_string(fx.out("geo.sql")).unwrap();

    let twin = TestDb::create().await;
    let twin_d = connect(&twin.config, twin.password.as_deref())
        .await
        .unwrap();
    run_sql(twin_d.as_ref(), create).await;
    MyRun(my_opts(&twin)).run(sql).await;

    use mysql_async::prelude::Queryable;
    let read = "SELECT id, ST_AsText(p), ST_SRID(p), ST_AsText(g), ST_SRID(g) FROM geo ORDER BY id";
    type Geo = (
        i32,
        Option<String>,
        Option<u32>,
        Option<String>,
        Option<u32>,
    );
    let mut a = mysql_async::Conn::new(my_opts(match &fx.db {
        Some(Db::My(db)) => db,
        _ => unreachable!(),
    }))
    .await
    .unwrap();
    let want: Vec<Geo> = a.query(read).await.unwrap();
    a.disconnect().await.ok();
    let mut b = mysql_async::Conn::new(my_opts(&twin)).await.unwrap();
    let have: Vec<Geo> = b.query(read).await.unwrap();
    b.disconnect().await.ok();
    assert_eq!(want.len(), 3);
    assert_eq!(want[0].4, Some(3857));
    assert_eq!(have, want);
    twin_d.disconnect().await.ok();
    twin.drop_db().await;
    fx.end().await;
}

// ---- Fix round 1 (Q41) ----

/// The history entries of `fx`'s Connection, newest first.
fn history(fx: &Fx) -> Vec<contura_core::query::HistoryEntry> {
    fx.svc
        .query_history(
            Some(fx.id),
            HistoryFilter {
                search: None,
                only: None,
            },
        )
        .unwrap()
}

/// Cancels a slow read after its first progress event: the job ends Cancelled (never
/// "The read stopped unexpectedly"), no file or partial is left, and the history entry
/// says Cancelled with the rows written so far.
async fn cancel_mid_read(fx: &Fx, sql: &str) {
    let rec = Arc::new(Rec::default());
    let job = JobId::new_v4();
    fx.svc
        .start_export(
            job,
            fx.query(sql, Format::Csv, "mid.csv"),
            false,
            rec.clone(),
        )
        .await
        .expect("start");
    let until = Instant::now() + Duration::from_secs(60);
    while !rec.events().iter().any(|(_, e)| e["kind"] == "progress") {
        assert!(Instant::now() < until, "no progress came");
        assert!(rec.finals().is_empty(), "the read ended before the cancel");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // Let the writer take the first chunk.
    tokio::time::sleep(Duration::from_millis(100)).await;
    fx.svc.jobs().cancel(job).await.unwrap();
    let end = rec.wait().await;
    assert_eq!(end["kind"], "failed", "{end}");
    assert_eq!(end["error"]["kind"], "cancelled", "{end}");
    assert!(!fx.out("mid.csv").exists());
    assert!(!fx.out("mid.csv.partial").exists());
    let h = &history(fx)[0];
    assert_eq!(h.outcome, Outcome::Cancelled, "{h:?}");
    assert!(!h.changed);
    assert!(h.rows.is_some_and(|n| n > 0), "rows so far: {:?}", h.rows);
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_mid_read_is_cancelled_postgres() {
    let fx = Fx::plain(DialectKind::Postgres).await;
    cancel_mid_read(
        &fx,
        "SELECT g, pg_sleep(0.001) FROM generate_series(1, 30000) g",
    )
    .await;
    fx.end().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_mid_read_is_cancelled_mysql() {
    let fx = Fx::plain(DialectKind::MySql).await;
    cancel_mid_read(&fx, "SELECT id, SLEEP(0.002) FROM `every`").await;
    fx.end().await;
}

/// A preview takes its rows and drops the source: the read stops at once and its
/// snapshot goes, so DDL on the table is not held up while the server reads on (every
/// row after the first 1,001 costs 10ms, about 20s in all).
#[tokio::test(flavor = "multi_thread")]
async fn dropped_preview_releases_the_snapshot_mysql() {
    let fx = Fx::plain(DialectKind::MySql).await;
    let req = fx.query(
        "SELECT id, SLEEP(IF(id > 1001, 0.01, 0)) FROM `every`",
        Format::Csv,
        "p.csv",
    );
    let preview = fx.svc.preview_export(req).await.expect("preview");
    assert_eq!(preview.sample_rows, 20);
    let d = fx.dialect().await;
    let dropped = tokio::time::timeout(
        Duration::from_secs(5),
        run_sql(d.as_ref(), "DROP TABLE `every`"),
    )
    .await;
    assert!(
        dropped.is_ok(),
        "DROP TABLE waited on the preview's snapshot"
    );
    fx.end().await;
}

/// With overwrite on, a run that fails or is cancelled leaves the existing file as it was.
#[tokio::test(flavor = "multi_thread")]
async fn existing_target_survives_failed_and_cancelled_runs() {
    let fx = Fx::plain(DialectKind::Postgres).await;
    let target = fx.out("keep.csv");
    std::fs::write(&target, "old").unwrap();
    let mut failing = fx.table(Format::Csv, "keep.csv");
    if let ExportSource::Table { filter, .. } = &mut failing.source {
        *filter = Some("1 / (id - 2500) IS NOT NULL".into());
    }
    let rec = Arc::new(Rec::default());
    fx.svc
        .start_export(JobId::new_v4(), failing, true, rec.clone())
        .await
        .expect("start");
    let end = rec.wait().await;
    assert_eq!(end["kind"], "failed", "{end}");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "old");

    let rec = Arc::new(Rec::default());
    let job = JobId::new_v4();
    fx.svc
        .start_export(
            job,
            fx.query(
                "SELECT g, pg_sleep(0.001) FROM generate_series(1, 30000) g",
                Format::Csv,
                "keep.csv",
            ),
            true,
            rec.clone(),
        )
        .await
        .expect("start");
    fx.svc.jobs().cancel(job).await.unwrap();
    let end = rec.wait().await;
    assert_eq!(end["error"]["kind"], "cancelled", "{end}");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "old");
    assert!(!fx.out("keep.csv.partial").exists());
    fx.end().await;
}
