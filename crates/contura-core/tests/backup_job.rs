//! Live: the Backup job (step 9, Task 3) per Dialect on the Backup fixture, through the
//! service with a recording sink. MySQL and PostgreSQL in `dbview_test_<8hex>` databases
//! as `dbview_test`; SQLite in temp files. Each script is loaded back through step 7's
//! script reader into an empty database, which must take every statement.

mod common;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::TestDb;
use common::backup_fixture::{PG_SCHEMA, mysql_conn, mysql_fixture, pg_fixture, sqlite_fixture};
use common::pg::{PgTestDb, pg_admin_client};
use contura_core::backup::format::{BackupFile, read_header};
use contura_core::backup::plan::{BackupFormat, BackupInclude, BackupRequest};
use contura_core::connections::{ConnectionInput, ConnectionService, PasswordChange};
use contura_core::jobs::JobSink;
use contura_core::jobs::script::ScriptReader;
use contura_core::model::{ConnectionId, DialectKind, SslMode};
use contura_core::query::{HistoryFilter, Outcome};
use contura_core::secrets::MemorySecretStore;
use contura_core::store::AppStore;
use mysql_async::prelude::Queryable;
use serde_json::Value as Json;

#[derive(Default)]
struct Rec(Mutex<Vec<Json>>);

impl JobSink for Rec {
    fn send(&self, event: Json) {
        self.0.lock().unwrap().push(event);
    }
}

impl Rec {
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
            if let Some(e) = last {
                return e;
            }
            assert!(Instant::now() < until, "the job never ended");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn warnings(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e["kind"] == "warning")
            .map(|e| e["message"].as_str().unwrap_or_default().to_string())
            .collect()
    }
}

#[derive(Clone, Copy, Default)]
struct Setup {
    production: bool,
    read_only: bool,
}

struct Fx {
    kind: DialectKind,
    dir: tempfile::TempDir,
    svc: Arc<ConnectionService>,
    id: ConnectionId,
    database: String,
    my: Option<TestDb>,
    pg: Option<PgTestDb>,
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
        let mut inp = ConnectionInput {
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
            read_only: setup.read_only,
        };
        let (mut my, mut pg) = (None, None);
        let database = match kind {
            DialectKind::MySql => {
                let db = TestDb::create().await;
                mysql_fixture(&db).await;
                inp.host = db.config.host.clone();
                inp.port = db.config.port;
                inp.user = db.config.user.clone();
                inp.password = PasswordChange::Set {
                    value: db.password.clone().unwrap_or_default(),
                };
                let name = db.name.clone();
                my = Some(db);
                name
            }
            DialectKind::Postgres => {
                let db = PgTestDb::create().await;
                pg_fixture(&db).await;
                inp.host = db.config.host.clone();
                inp.port = db.config.port;
                inp.user = db.config.user.clone();
                inp.database = db.config.database.clone();
                inp.password = PasswordChange::Set {
                    value: db.password.clone().unwrap_or_default(),
                };
                let name = db.name.clone();
                pg = Some(db);
                name
            }
            DialectKind::Sqlite => {
                let file = dir.path().join("freight.sqlite");
                sqlite_fixture(&file);
                inp.file = Some(file);
                "main".to_string()
            }
        };
        let saved = svc.save(inp).await.expect("save the Connection");
        svc.open(saved.id).await.expect("open the Connection");
        Fx {
            kind,
            dir,
            svc,
            id: saved.id,
            database,
            my,
            pg,
        }
    }

    fn out(&self, name: &str) -> PathBuf {
        self.dir.path().join("out").join(name)
    }

    fn req(&self, file: &str) -> BackupRequest {
        BackupRequest {
            connection_id: self.id,
            database: self.database.clone(),
            schema: (self.kind == DialectKind::Postgres).then(|| PG_SCHEMA.to_string()),
            include: BackupInclude::default(),
            format: BackupFormat::Script,
            rows_per_statement: 100,
            add_drop_tables: false,
            local_date: None,
            tables: None,
            path: self.out(file).display().to_string(),
        }
    }

    async fn run(&self, req: BackupRequest) -> (Json, Arc<Rec>) {
        let rec = Arc::new(Rec::default());
        let job = uuid::Uuid::new_v4();
        self.svc
            .start_backup(job, req, false, rec.clone())
            .await
            .expect("the backup starts");
        (rec.wait().await, rec)
    }

    async fn end(self) {
        self.svc.close(self.id).await.ok();
        if let Some(db) = self.my {
            db.drop_db().await;
        }
        if let Some(db) = self.pg {
            db.drop_db().await;
        }
    }
}

fn statements(path: &std::path::Path, kind: DialectKind) -> Vec<String> {
    let mut reader = ScriptReader::open(path, kind, true).unwrap();
    let mut out = Vec::new();
    while let Some(s) = reader.next_statement().unwrap() {
        out.push(s.text);
    }
    out
}

fn partials_left(dir: &std::path::Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.to_string_lossy().ends_with(".partial"))
        .collect()
}

/// The checks every Dialect shares; returns the file's text.
async fn backed_up(fx: &Fx, file: &str) -> (String, PathBuf) {
    let (end, _) = fx.run(fx.req(file)).await;
    assert_eq!(end["kind"], "finished", "{end}");
    let report = &end["report"];
    assert_eq!(report["kind"], "backup");
    let path = fx.out(file);
    assert_eq!(report["bytes"], std::fs::metadata(&path).unwrap().len());
    assert!(partials_left(&fx.dir.path().join("out")).is_empty());
    let text = std::fs::read_to_string(&path).unwrap();
    let BackupFile::Contura { header, trailer } = read_header(&path).unwrap() else {
        panic!("a Contura Backup");
    };
    let label = |t: &str| match fx.kind {
        DialectKind::Postgres => format!("{PG_SCHEMA}.{t}"),
        _ => t.to_string(),
    };
    let rows: std::collections::HashMap<String, u64> = header.rows.iter().cloned().collect();
    assert_eq!(rows.get(&label("orders")), Some(&5), "{:?}", header.rows);
    assert_eq!(rows.get(&label("customers")), Some(&3));
    assert_eq!(trailer.rows, report["rowsWritten"].as_u64().unwrap());
    assert_eq!(trailer.statements, report["statements"].as_u64().unwrap());
    for marker in [
        "\n-- section: settings\n",
        "\n-- section: structure\n",
        &format!("\n-- section: rows {}\n", label("orders")),
        "\n-- section: after-rows\n",
        "\n-- section: finish\n",
    ] {
        assert!(text.contains(marker), "{marker} missing");
    }
    // Rows in key order: (1, ...), (2, ...), (3, ...), ...
    let orders = text
        .split(&format!("-- section: rows {}\n", label("orders")))
        .nth(1)
        .unwrap();
    let ids: Vec<u32> = orders
        .lines()
        .take_while(|l| !l.starts_with("--"))
        .filter_map(|l| l.strip_prefix('('))
        .map(|l| l.split(',').next().unwrap().trim().parse().unwrap())
        .collect();
    assert_eq!(ids, [1, 2, 3, 4, 5], "{orders}");
    // The generated column `twice` is left out.
    assert!(
        !orders.lines().next().unwrap().contains("twice"),
        "{orders}"
    );
    // One history entry, changed: false.
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
    let entries: Vec<_> = history
        .iter()
        .filter(|h| h.sql.starts_with("-- Backup of"))
        .collect();
    assert_eq!(entries.len(), 1, "{history:?}");
    assert!(!entries[0].changed);
    assert_eq!(entries[0].outcome, Outcome::Ok);
    (text, path)
}

#[tokio::test]
async fn mysql_backup_writes_the_file_and_loads_back() {
    let fx = Fx::new(DialectKind::MySql, Setup::default()).await;
    let (text, path) = backed_up(&fx, "freight.sql").await;
    assert!(text.contains("\nSET time_zone = '+00:00';\n"));
    assert!(text.contains("INSERT INTO `orders` (`id`, `customer_id`, `qty`) VALUES\n"));
    let copy = TestDb::create().await;
    let mut to = mysql_conn(&copy, &copy.name).await;
    for sql in statements(&path, DialectKind::MySql) {
        to.query_drop(sql.as_str())
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    let n: Option<u64> = to.query_first("SELECT COUNT(*) FROM orders").await.unwrap();
    assert_eq!(n, Some(5));
    // The trigger did not fire on load: audit holds the source's 5 rows, not 10.
    let n: Option<u64> = to.query_first("SELECT COUNT(*) FROM audit").await.unwrap();
    assert_eq!(n, Some(5));
    let twice: Option<i64> = to
        .query_first("SELECT twice FROM orders WHERE id = 3")
        .await
        .unwrap();
    assert_eq!(twice, Some(6));
    to.disconnect().await.ok();
    copy.drop_db().await;
    fx.end().await;
}

#[tokio::test]
async fn postgres_backup_writes_the_file_and_loads_back() {
    let fx = Fx::new(DialectKind::Postgres, Setup::default()).await;
    let (text, path) = backed_up(&fx, "freight.sql").await;
    // An ALWAYS identity gets its values back.
    assert!(text.contains(
        "INSERT INTO \"billing\".\"orders\" (\"id\", \"customer_id\", \"qty\", \"ticket\") OVERRIDING SYSTEM VALUE VALUES\n"
    ));
    assert!(text.contains("\nSET TimeZone = 'UTC';\n"));
    let copy = PgTestDb::create().await;
    let client = pg_admin_client(&copy.name).await;
    for sql in statements(&path, DialectKind::Postgres) {
        client
            .batch_execute(&sql)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    let n: i64 = client
        .query_one("SELECT count(*) FROM billing.orders", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(n, 5);
    let audit: i64 = client
        .query_one("SELECT count(*) FROM billing.audit", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(audit, 5, "the trigger fired during load");
    // The next identity value follows the restored ones.
    let next: i64 = client
        .query_one(
            "INSERT INTO billing.orders (customer_id, qty) VALUES (1, 9) RETURNING id",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(next, 6);
    drop(client);
    copy.drop_db().await;
    fx.end().await;
}

#[tokio::test]
async fn sqlite_backup_writes_the_file_and_loads_back() {
    let fx = Fx::new(DialectKind::Sqlite, Setup::default()).await;
    let (_, path) = backed_up(&fx, "freight.sql").await;
    let copy = fx.dir.path().join("copy.sqlite");
    let conn = rusqlite::Connection::open(&copy).unwrap();
    for sql in statements(&path, DialectKind::Sqlite) {
        conn.execute_batch(&sql)
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    let n: i64 = conn
        .query_row("SELECT count(*) FROM orders", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 5);
    let audit: i64 = conn
        .query_row("SELECT count(*) FROM audit", [], |r| r.get(0))
        .unwrap();
    assert_eq!(audit, 5);
    let v: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(v, 7);
    drop(conn);
    fx.end().await;
}

#[tokio::test]
async fn backup_needs_no_pass_on_production_or_read_only() {
    for setup in [
        Setup {
            production: true,
            read_only: false,
        },
        Setup {
            production: false,
            read_only: true,
        },
    ] {
        for kind in [
            DialectKind::MySql,
            DialectKind::Postgres,
            DialectKind::Sqlite,
        ] {
            let fx = Fx::new(kind, setup).await;
            let (end, _) = fx.run(fx.req("prod.sql")).await;
            assert_eq!(end["kind"], "finished", "{kind:?}: {end}");
            assert!(fx.out("prod.sql").exists());
            fx.end().await;
        }
    }
}

#[tokio::test]
async fn cancel_deletes_the_partial() {
    let fx = Fx::new(DialectKind::MySql, Setup::default()).await;
    let rec = Arc::new(Rec::default());
    let job = uuid::Uuid::new_v4();
    fx.svc
        .start_backup(job, fx.req("cancel.sql"), false, rec.clone())
        .await
        .unwrap();
    fx.svc.jobs().cancel(job).await.unwrap();
    let end = rec.wait().await;
    assert_eq!(end["kind"], "failed", "{end}");
    assert_eq!(end["error"]["kind"], "cancelled", "{end}");
    assert!(!fx.out("cancel.sql").exists());
    assert!(partials_left(&fx.dir.path().join("out")).is_empty());
    fx.end().await;
}

#[tokio::test]
async fn an_existing_file_needs_overwrite() {
    let fx = Fx::new(DialectKind::Sqlite, Setup::default()).await;
    std::fs::write(fx.out("there.sql"), "old").unwrap();
    let err = fx
        .svc
        .start_backup(
            uuid::Uuid::new_v4(),
            fx.req("there.sql"),
            false,
            Arc::new(Rec::default()),
        )
        .await
        .unwrap_err();
    assert!(matches!(err, contura_core::Error::FileExists(_)), "{err:?}");
    fx.end().await;
}

#[tokio::test]
async fn mysql_myisam_note() {
    let fx = Fx::new(DialectKind::MySql, Setup::default()).await;
    let mut conn = mysql_conn(fx.my.as_ref().unwrap(), &fx.database).await;
    conn.query_drop("CREATE TABLE notes (id INT PRIMARY KEY, body TEXT) ENGINE=MyISAM")
        .await
        .unwrap();
    conn.query_drop("INSERT INTO notes VALUES (1, 'a'), (2, 'b')")
        .await
        .unwrap();
    conn.disconnect().await.ok();
    let plan = fx.svc.plan_backup(fx.req("plan.sql")).await.unwrap();
    assert_eq!(plan.non_snapshot_tables, ["notes"]);
    assert_eq!(plan.counts.tables, 4);
    assert!(
        plan.default_file_name
            .starts_with(&format!("{}-", fx.database))
    );
    assert!(plan.default_file_name.ends_with(".sql"));
    assert_eq!(plan.not_included, ["grants and roles"]);
    let (end, rec) = fx.run(fx.req("myisam.sql")).await;
    assert_eq!(end["kind"], "finished", "{end}");
    assert!(
        rec.warnings().contains(
            &"notes uses MyISAM, so its rows may not match the moment the backup starts."
                .to_string()
        ),
        "{:?}",
        rec.warnings()
    );
    fx.end().await;
}

#[tokio::test]
async fn postgres_plan_counts_and_not_included() {
    let fx = Fx::new(DialectKind::Postgres, Setup::default()).await;
    let plan = fx.svc.plan_backup(fx.req("plan.sql")).await.unwrap();
    assert_eq!(plan.counts.tables, 3);
    assert_eq!(plan.counts.views, 2);
    assert_eq!(plan.counts.functions, 3);
    assert_eq!(plan.counts.triggers, 1);
    assert_eq!(plan.counts.rows, 13);
    assert!(plan.not_included.contains(&"grants and roles".to_string()));
    assert!(plan.not_included.iter().any(|s| s.contains("domain")));
    fx.end().await;
}

#[tokio::test]
async fn sqlite_vacuum_into_copy_opens_and_matches() {
    let fx = Fx::new(DialectKind::Sqlite, Setup::default()).await;
    let mut req = fx.req("freight-copy.sqlite");
    req.format = BackupFormat::FileCopy;
    let plan = fx.svc.plan_backup(req.clone()).await.unwrap();
    assert!(plan.default_file_name.starts_with("freight-"));
    assert!(plan.default_file_name.ends_with(".sqlite"));
    let (end, _) = fx.run(req).await;
    assert_eq!(end["kind"], "finished", "{end}");
    let copy = rusqlite::Connection::open(fx.out("freight-copy.sqlite")).unwrap();
    let n: i64 = copy
        .query_row("SELECT count(*) FROM orders", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 5);
    let v: i64 = copy
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(v, 7);
    let ok: String = copy
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    assert_eq!(ok, "ok");
    assert!(partials_left(&fx.dir.path().join("out")).is_empty());
    drop(copy);
    fx.end().await;
}

#[tokio::test]
async fn add_drop_tables_writes_drops_and_sets_the_header() {
    let fx = Fx::new(DialectKind::MySql, Setup::default()).await;
    let mut req = fx.req("drops.sql");
    req.add_drop_tables = true;
    let (end, _) = fx.run(req).await;
    assert_eq!(end["kind"], "finished", "{end}");
    let path = fx.out("drops.sql");
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.contains("\n-- drop-tables: yes\n"));
    for t in ["audit", "customers", "orders"] {
        let drop = text
            .find(&format!("DROP TABLE IF EXISTS `{t}`;\nCREATE TABLE `{t}`"))
            .unwrap_or_else(|| panic!("no DROP before {t}"));
        assert!(drop > 0);
    }
    let BackupFile::Contura { header, .. } = read_header(&path).unwrap() else {
        panic!();
    };
    assert!(header.drop_tables);
    fx.end().await;
}

#[tokio::test]
async fn rows_come_in_key_order_whatever_the_storage_order() {
    // PostgreSQL keeps a heap in the order rows were written, so without ORDER BY the
    // rows would come back 30, 10, 20.
    let fx = Fx::new(DialectKind::Postgres, Setup::default()).await;
    let client = pg_admin_client(&fx.database).await;
    client
        .batch_execute(
            "CREATE TABLE billing.shuffled (id integer PRIMARY KEY, v text); \
             INSERT INTO billing.shuffled VALUES (30, 'c'); \
             INSERT INTO billing.shuffled VALUES (10, 'a'); \
             INSERT INTO billing.shuffled VALUES (20, 'b');",
        )
        .await
        .unwrap();
    let heap: Vec<i32> = client
        .query("SELECT id FROM billing.shuffled", &[])
        .await
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(
        heap,
        [30, 10, 20],
        "the fixture must be stored out of key order"
    );
    drop(client);
    let (end, _) = fx.run(fx.req("order.sql")).await;
    assert_eq!(end["kind"], "finished", "{end}");
    let text = std::fs::read_to_string(fx.out("order.sql")).unwrap();
    let rows = text
        .split("-- section: rows billing.shuffled\n")
        .nth(1)
        .unwrap();
    let ids: Vec<u32> = rows
        .lines()
        .take_while(|l| !l.starts_with("--"))
        .filter_map(|l| l.strip_prefix('('))
        .map(|l| l.split(',').next().unwrap().trim().parse().unwrap())
        .collect();
    assert_eq!(ids, [10, 20, 30], "{rows}");
    fx.end().await;
}

#[tokio::test]
async fn rows_per_insert_must_be_offered_and_the_local_date_names_the_file() {
    let fx = Fx::new(DialectKind::Sqlite, Setup::default()).await;
    let mut req = fx.req("odd.sql");
    req.rows_per_statement = 7;
    let err = fx
        .svc
        .start_backup(
            uuid::Uuid::new_v4(),
            req.clone(),
            false,
            Arc::new(Rec::default()),
        )
        .await
        .unwrap_err();
    assert_eq!(
        err.to_string(),
        "invalid input: Rows per INSERT must be 100, 500 or 1,000."
    );
    assert!(!fx.out("odd.sql").exists());
    req.rows_per_statement = 1_000;
    req.local_date = Some("2026-10-19".into());
    let plan = fx.svc.plan_backup(req).await.unwrap();
    assert_eq!(plan.default_file_name, "freight-2026-10-19.sql");
    fx.end().await;
}
