//! Live: the Restore run (step 9, Task 5) per Dialect, through the service with a
//! recording sink. Each test backs up the Backup fixture with the Backup job, then
//! restores the file. MySQL and PostgreSQL in `dbview_test_<8hex>` databases as
//! `dbview_test`, new databases named `dbview_test_<8hex>_r<n>`; SQLite in temp files.

mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::TestDb;
use common::backup_fixture::{PG_SCHEMA, mysql_conn, mysql_fixture, pg_fixture, sqlite_fixture};
use common::pg::{PgTestDb, pg_admin_client, pg_database_exists};
use contura_core::Error;
use contura_core::backup::plan::{BackupFormat, BackupInclude, BackupRequest};
use contura_core::backup::restore::{RestoreMode, RestoreRequest, RestoreTarget};
use contura_core::connections::{ConnectionInput, ConnectionService, PasswordChange};
use contura_core::jobs::JobSink;
use contura_core::model::{ConnectionId, DialectKind, SslMode};
use contura_core::query::HistoryFilter;
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
    async fn wait_for(&self, what: impl Fn(&Json) -> bool) -> Json {
        let until = Instant::now() + Duration::from_secs(120);
        loop {
            let found = self.0.lock().unwrap().iter().find(|e| what(e)).cloned();
            if let Some(e) = found {
                return e;
            }
            assert!(Instant::now() < until, "the event never came");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    async fn wait(&self) -> Json {
        self.wait_for(|e| e["kind"] == "finished" || e["kind"] == "failed")
            .await
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
    /// New databases this test may have made, dropped at the end.
    made: Vec<String>,
}

const BULK: u64 = 50_000;

impl Fx {
    async fn new(kind: DialectKind, setup: Setup) -> Fx {
        Fx::with_rows(kind, setup, 0).await
    }

    /// The fixture, plus `bulk` more audit rows (for a cancel mid-rows).
    async fn with_rows(kind: DialectKind, setup: Setup, bulk: u64) -> Fx {
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
                if bulk > 0 {
                    let mut conn = mysql_conn(&db, &db.name).await;
                    conn.query_drop("SET SESSION cte_max_recursion_depth = 10000000")
                        .await
                        .unwrap();
                    conn.query_drop(format!(
                        "INSERT INTO audit (note) WITH RECURSIVE seq(n) AS \
                         (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < {bulk}) \
                         SELECT CONCAT('bulk ', n) FROM seq"
                    ))
                    .await
                    .unwrap();
                    conn.disconnect().await.ok();
                }
                inp.host = db.config.host.clone();
                inp.port = db.config.port;
                inp.user = db.config.user.clone();
                inp.database = Some(db.name.clone());
                inp.password = PasswordChange::Set {
                    value: db.password.clone().unwrap_or_default(),
                };
                let name = db.name.clone();
                my = Some(db);
                name
            }
            DialectKind::Postgres => {
                let db = PgTestDb::create().await;
                let client = pg_fixture(&db).await;
                if bulk > 0 {
                    client
                        .batch_execute(&format!(
                            "INSERT INTO billing.audit (note) \
                             SELECT 'bulk ' || g FROM generate_series(1, {bulk}) g"
                        ))
                        .await
                        .unwrap();
                }
                drop(client);
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
                if bulk > 0 {
                    rusqlite::Connection::open(&file)
                        .unwrap()
                        .execute_batch(&format!(
                            "INSERT INTO audit (note) WITH RECURSIVE seq(n) AS \
                             (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < {bulk}) \
                             SELECT 'bulk ' || n FROM seq"
                        ))
                        .unwrap();
                }
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
            made: Vec::new(),
        }
    }

    fn out(&self, name: &str) -> PathBuf {
        self.dir.path().join("out").join(name)
    }

    /// Backs up the fixture to `out/<file>` and gives its path.
    async fn backup(&self, file: &str) -> PathBuf {
        let req = BackupRequest {
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
        };
        let rec = Arc::new(Rec::default());
        self.svc
            .start_backup(uuid::Uuid::new_v4(), req, false, rec.clone())
            .await
            .expect("the backup starts");
        let end = rec.wait().await;
        assert_eq!(end["kind"], "finished", "{end}");
        self.out(file)
    }

    /// A new database name (SQLite: a new file), remembered for the clean up.
    fn new_name(&mut self, n: u32) -> String {
        let name = match self.kind {
            DialectKind::Sqlite => self.out(&format!("new{n}.sqlite")).display().to_string(),
            _ => format!("{}_r{n}", self.database),
        };
        self.made.push(name.clone());
        name
    }

    fn target(&self) -> RestoreTarget {
        RestoreTarget {
            connection_id: self.id,
            database: Some(self.database.clone()),
            schema: (self.kind == DialectKind::Postgres).then(|| PG_SCHEMA.to_string()),
        }
    }

    fn req(&self, path: &Path, mode: RestoreMode) -> RestoreRequest {
        RestoreRequest {
            target: self.target(),
            path: path.to_path_buf(),
            mode,
            run_as_is: false,
            local_date: None,
        }
    }

    /// Plans `req` (the review), then starts it with that plan's fingerprint.
    async fn start(
        &self,
        req: RestoreRequest,
        pass: Option<uuid::Uuid>,
    ) -> Result<Arc<Rec>, Error> {
        let reviewed = self.svc.plan_restore(req.clone()).await?.fingerprint;
        self.start_with(req, reviewed, pass).await
    }

    /// Starts `req` with the fingerprint the user reviewed.
    async fn start_with(
        &self,
        req: RestoreRequest,
        reviewed: String,
        pass: Option<uuid::Uuid>,
    ) -> Result<Arc<Rec>, Error> {
        let rec = Arc::new(Rec::default());
        self.svc
            .start_restore(uuid::Uuid::new_v4(), req, reviewed, pass, rec.clone())
            .await?;
        Ok(rec)
    }

    /// Runs `sql` on the target database.
    async fn sql(&self, sql: &str) {
        match self.kind {
            DialectKind::MySql => {
                let db = self.my.as_ref().unwrap();
                let mut conn = mysql_conn(db, &db.name).await;
                conn.query_drop(sql).await.unwrap();
                conn.disconnect().await.ok();
            }
            DialectKind::Postgres => {
                pg_admin_client(&self.database)
                    .await
                    .batch_execute(sql)
                    .await
                    .unwrap();
            }
            DialectKind::Sqlite => {
                rusqlite::Connection::open(self.dir.path().join("freight.sqlite"))
                    .unwrap()
                    .execute_batch(sql)
                    .unwrap();
            }
        }
    }

    async fn restore(&self, req: RestoreRequest) -> Json {
        let rec = self.start(req, None).await.expect("the restore starts");
        rec.wait().await
    }

    async fn exists(&self, name: &str) -> bool {
        match self.kind {
            DialectKind::MySql => common::database_exists(name).await,
            DialectKind::Postgres => pg_database_exists(name).await,
            DialectKind::Sqlite => Path::new(name).exists(),
        }
    }

    /// Rows in `table` of database `db` (SQLite: the file `db`).
    async fn count(&self, db: &str, table: &str) -> i64 {
        match self.kind {
            DialectKind::MySql => {
                let mut conn = mysql_conn(self.my.as_ref().unwrap(), db).await;
                let n: Option<i64> = conn
                    .query_first(format!("SELECT COUNT(*) FROM `{table}`"))
                    .await
                    .unwrap();
                conn.disconnect().await.ok();
                n.unwrap()
            }
            DialectKind::Postgres => {
                let client = pg_admin_client(db).await;
                client
                    .query_one(&format!("SELECT count(*) FROM billing.{table}"), &[])
                    .await
                    .unwrap()
                    .get(0)
            }
            DialectKind::Sqlite => rusqlite::Connection::open(db)
                .unwrap()
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap(),
        }
    }

    async fn end(self) {
        self.svc.close(self.id).await.ok();
        for name in &self.made {
            match self.kind {
                DialectKind::MySql => {
                    let db = self.my.as_ref().unwrap();
                    let mut conn = mysql_conn(db, &db.name).await;
                    conn.query_drop(format!("DROP DATABASE IF EXISTS `{name}`"))
                        .await
                        .unwrap();
                    conn.disconnect().await.ok();
                }
                DialectKind::Postgres => {
                    pg_admin_client("postgres")
                        .await
                        .batch_execute(&format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)"))
                        .await
                        .unwrap();
                }
                DialectKind::Sqlite => {}
            }
        }
        if let Some(db) = self.my {
            db.drop_db().await;
        }
        if let Some(db) = self.pg {
            db.drop_db().await;
        }
    }
}

const KINDS: [DialectKind; 3] = [
    DialectKind::MySql,
    DialectKind::Postgres,
    DialectKind::Sqlite,
];

/// Puts `line` into the file right before its trailer.
fn insert_before_trailer(path: &Path, line: &str) {
    let text = std::fs::read_to_string(path).unwrap();
    let at = text.rfind("-- contura-backup-end").expect("a trailer");
    let edited = format!("{}{line}\n{}", &text[..at], &text[at..]);
    std::fs::write(path, edited).unwrap();
}

fn message(end: &Json) -> String {
    let m = &end["error"]["message"];
    m.as_str()
        .or_else(|| m["message"].as_str())
        .unwrap_or_default()
        .to_string()
}

#[tokio::test]
async fn new_database_round_trip() {
    for kind in KINDS {
        let mut fx = Fx::new(kind, Setup::default()).await;
        let file = fx.backup("f.sql").await;
        // The check pass as a job.
        let rec = Arc::new(Rec::default());
        fx.svc
            .inspect_restore(uuid::Uuid::new_v4(), fx.target(), file.clone(), rec.clone())
            .await
            .unwrap();
        let end = rec.wait().await;
        assert_eq!(end["kind"], "finished", "{kind:?} {end}");
        assert_eq!(end["report"]["kind"], "restoreCheck");
        assert!(
            end["report"]["restoreCheck"]["statements"]
                .as_u64()
                .unwrap()
                > 0
        );

        let name = fx.new_name(1);
        let mode = RestoreMode::NewDatabase { name: name.clone() };
        let plan = fx
            .svc
            .plan_restore(fx.req(&file, mode.clone()))
            .await
            .unwrap();
        assert!(plan.cleanup.len() <= 1);
        let end = fx.restore(fx.req(&file, mode)).await;
        assert_eq!(end["kind"], "finished", "{kind:?} {end}");
        let outcome = &end["report"]["restore"];
        assert_eq!(outcome["countsMatch"], true, "{kind:?} {end}");
        assert_eq!(outcome["rows"], 13, "{kind:?} {end}");
        if kind == DialectKind::Sqlite {
            assert_eq!(outcome["newFile"], name.as_str());
        } else {
            assert_eq!(outcome["database"], name.as_str());
        }
        assert_eq!(fx.count(&name, "orders").await, 5);
        // The trigger came after the rows, so it did not fire on load.
        assert_eq!(fx.count(&name, "audit").await, 5, "{kind:?}");
        // One history entry on the target, marked as a change.
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
        let restores: Vec<_> = history
            .iter()
            .filter(|h| h.sql.starts_with("-- Restore of f.sql"))
            .collect();
        assert_eq!(restores.len(), 1, "{kind:?}");
        assert!(restores[0].changed);
        assert!(restores[0].sql.contains("INSERT statements"));
        fx.end().await;
    }
}

#[tokio::test]
async fn fail_and_cancel_remove_new_database() {
    for kind in KINDS {
        let mut fx = Fx::with_rows(kind, Setup::default(), BULK).await;
        let file = fx.backup("f.sql").await;

        // Cancel mid-rows.
        let name = fx.new_name(1);
        let req = fx.req(&file, RestoreMode::NewDatabase { name: name.clone() });
        let rec = fx.start(req, None).await.unwrap();
        rec.wait_for(|e| e["kind"] == "progress" && e["restoreStep"] == "rows")
            .await;
        assert!(
            fx.exists(&name).await,
            "{kind:?}: the new database was made"
        );
        let id = fx.svc.jobs().list()[0].id;
        fx.svc.jobs().cancel(id).await.unwrap();
        let end = rec.wait().await;
        assert_eq!(end["kind"], "failed", "{kind:?} {end}");
        assert_eq!(end["error"]["kind"], "cancelled", "{kind:?} {end}");
        assert!(!fx.exists(&name).await, "{kind:?}: cancel removes {name}");

        // A failing statement late in the file.
        insert_before_trailer(&file, "SELECT * FROM no_such_table_restore;");
        let name = fx.new_name(2);
        let end = fx
            .restore(fx.req(&file, RestoreMode::NewDatabase { name: name.clone() }))
            .await;
        assert_eq!(end["kind"], "failed", "{kind:?} {end}");
        let m = message(&end);
        let shown = match kind {
            DialectKind::Sqlite => Path::new(&name)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            _ => name.clone(),
        };
        assert!(
            m.ends_with(&format!(" {shown} was removed.")),
            "{kind:?}: {m}"
        );
        match kind {
            DialectKind::MySql => {
                let ran = m.split(' ').next().unwrap().replace(',', "");
                let ran: u64 = ran.parse().unwrap();
                assert!(
                    m.contains(" statements ran. Statement ")
                        && m.contains(&format!("Statement {} failed: ", group(ran + 1))),
                    "{m}"
                );
                assert!(m.contains("no_such_table_restore"), "{m}");
            }
            _ => {
                assert!(m.starts_with("Statement "), "{m}");
                assert!(m.contains(" failed: "), "{m}");
                assert!(m.contains("Nothing was restored."), "{m}");
            }
        }
        assert!(!fx.exists(&name).await, "{kind:?}: failure removes {name}");
        fx.end().await;
    }
}

fn group(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

#[tokio::test]
async fn edited_after_confirm_is_refused_at_start() {
    for kind in [DialectKind::Postgres, DialectKind::Sqlite] {
        let mut fx = Fx::new(
            kind,
            Setup {
                production: true,
                ..Setup::default()
            },
        )
        .await;
        let file = fx.backup("f.sql").await;
        let name = fx.new_name(1);
        let req = fx.req(&file, RestoreMode::NewDatabase { name: name.clone() });
        let reviewed = fx.svc.plan_restore(req.clone()).await.unwrap().fingerprint;
        let pass = fx.svc.confirm_restore(req.clone()).await.unwrap();
        insert_before_trailer(&file, "-- edited after the confirm");
        match fx.start_with(req, reviewed, Some(pass)).await {
            Err(Error::FileChanged { confirmed, .. }) => assert!(confirmed),
            Err(e) => panic!("{kind:?}: expected FileChanged, got {e:?}"),
            Ok(_) => panic!("{kind:?}: an edited file started"),
        }
        assert!(!fx.exists(&name).await, "{kind:?}: nothing was made");
        assert!(fx.svc.jobs().list().is_empty());
        fx.end().await;
    }
}

#[tokio::test]
async fn production_needs_the_pass_and_runs_once() {
    for kind in KINDS {
        let mut fx = Fx::new(
            kind,
            Setup {
                production: true,
                ..Setup::default()
            },
        )
        .await;
        let file = fx.backup("f.sql").await;
        let name = fx.new_name(1);
        let req = fx.req(&file, RestoreMode::NewDatabase { name: name.clone() });
        let plan = fx.svc.plan_restore(req.clone()).await.unwrap();
        assert!(
            matches!(
                plan.verdict,
                contura_core::jobs::types::JobVerdict::NeedsConfirmation { .. }
            ),
            "{kind:?}"
        );
        assert!(matches!(
            fx.start(req.clone(), None).await,
            Err(Error::NeedsConfirmation)
        ));
        // A pass for another plan does not cover this one.
        let other = fx.new_name(2);
        let other_req = fx.req(&file, RestoreMode::NewDatabase { name: other });
        let other_pass = fx.svc.confirm_restore(other_req).await.unwrap();
        assert!(matches!(
            fx.start(req.clone(), Some(other_pass)).await,
            Err(Error::NeedsConfirmation)
        ));
        assert!(!fx.exists(&name).await);
        let pass = fx.svc.confirm_restore(req.clone()).await.unwrap();
        let end = fx
            .start(req.clone(), Some(pass))
            .await
            .unwrap()
            .wait()
            .await;
        assert_eq!(end["kind"], "finished", "{kind:?} {end}");
        // The pass is spent: the same pass for a third name is refused.
        let third = fx.new_name(3);
        let third_req = fx.req(&file, RestoreMode::NewDatabase { name: third });
        assert!(matches!(
            fx.start(third_req, Some(pass)).await,
            Err(Error::NeedsConfirmation)
        ));
        fx.end().await;
    }
}

#[tokio::test]
async fn read_only_refuses() {
    for kind in KINDS {
        let mut fx = Fx::new(
            kind,
            Setup {
                read_only: true,
                ..Setup::default()
            },
        )
        .await;
        let file = fx.backup("f.sql").await;
        let name = fx.new_name(1);
        let req = fx.req(&file, RestoreMode::NewDatabase { name });
        let rec = Arc::new(Rec::default());
        assert!(matches!(
            fx.svc
                .inspect_restore(uuid::Uuid::new_v4(), fx.target(), file.clone(), rec)
                .await,
            Err(Error::ReadOnly(0))
        ));
        assert!(matches!(
            fx.svc.plan_restore(req.clone()).await,
            Err(Error::ReadOnly(0))
        ));
        assert!(matches!(
            fx.svc.restore_statements(req.clone(), 0).await,
            Err(Error::ReadOnly(0))
        ));
        assert!(matches!(
            fx.svc.confirm_restore(req.clone()).await,
            Err(Error::ReadOnly(0))
        ));
        assert!(matches!(fx.start(req, None).await, Err(Error::ReadOnly(0))));
        fx.end().await;
    }
}

#[tokio::test]
async fn replace_lists_every_drop() {
    for kind in KINDS {
        let fx = Fx::new(kind, Setup::default()).await;
        let file = fx.backup("f.sql").await;
        let plan = fx
            .svc
            .plan_restore(fx.req(
                &file,
                RestoreMode::Replace {
                    backup_first: false,
                },
            ))
            .await
            .unwrap();
        let drops: Vec<String> = plan.drops.iter().map(|d| d.text.clone()).collect();
        let expected: Vec<&str> = match kind {
            DialectKind::MySql => vec![
                "DROP TRIGGER `orders_audit`",
                "DROP VIEW `a_top`",
                "DROP VIEW `v_base`",
                "DROP VIEW `v_doubled`",
                "DROP FUNCTION `f_double`",
                "DROP PROCEDURE `p_count`",
                "DROP TABLE `audit`",
                "DROP TABLE `customers`",
                "DROP TABLE `orders`",
            ],
            DialectKind::Postgres => vec![
                "DROP VIEW \"billing\".\"a_top\", \"billing\".\"v_base\"",
                "DROP FUNCTION \"billing\".\"audit_order\"()",
                "DROP FUNCTION \"billing\".\"double_it\"(n integer)",
                "DROP PROCEDURE \"billing\".\"noop\"()",
                "DROP TABLE \"billing\".\"audit\", \"billing\".\"customers\", \"billing\".\"orders\"",
                // R29: the standalone sequence and the enum the file makes again.
                "DROP SEQUENCE \"billing\".\"ticket_seq\"",
                "DROP TYPE \"billing\".\"mood\"",
            ],
            DialectKind::Sqlite => vec![
                "DROP TRIGGER \"orders_audit\"",
                "DROP VIEW \"a_top\"",
                "DROP VIEW \"v_base\"",
                "DROP TABLE \"audit\"",
                "DROP TABLE \"customers\"",
                "DROP TABLE \"orders\"",
            ],
        };
        let mut got = drops.clone();
        got.sort();
        let mut want: Vec<String> = expected.iter().map(|s| s.to_string()).collect();
        want.sort();
        assert_eq!(got, want, "{kind:?}: {drops:#?}");
        assert!(plan.replace_banner.is_some(), "{kind:?}");
        fx.end().await;
    }
}

#[tokio::test]
async fn mysql_replace_backs_up_first() {
    let fx = Fx::new(DialectKind::MySql, Setup::default()).await;
    let file = fx.backup("f.sql").await;
    // Change the target, then replace it with the file. `extra` is not in the file, so
    // Replace leaves it alone and the first Backup leaves it out (R30).
    fx.sql("INSERT INTO customers (name) VALUES ('Eko')").await;
    fx.sql("CREATE TABLE extra (id INT PRIMARY KEY)").await;
    fx.sql("INSERT INTO extra VALUES (42)").await;
    let mut req = fx.req(&file, RestoreMode::Replace { backup_first: true });
    req.local_date = Some("2026-01-02".into());
    let plan = fx.svc.plan_restore(req.clone()).await.unwrap();
    let first = PathBuf::from(plan.backup_first_path.clone().expect("a first Backup"));
    assert_eq!(first.parent(), file.parent());
    // R32 M-4: the file is named with the user's own date.
    assert_eq!(
        first.file_name().unwrap().to_string_lossy(),
        format!("{}-before-restore-2026-01-02.sql", fx.database)
    );
    let end = fx.restore(req.clone()).await;
    assert_eq!(end["kind"], "finished", "{end}");
    assert_eq!(end["report"]["restore"]["countsMatch"], true);
    assert_eq!(fx.count(&fx.database, "customers").await, 3);
    assert_eq!(fx.count(&fx.database, "audit").await, 5);
    // The first Backup holds the replaced rows, Eko among them.
    let text = std::fs::read_to_string(&first).unwrap();
    assert!(text.starts_with("-- Contura backup, format 1"));
    assert!(text.contains("'Eko'"));
    // Exactly the dropped tables: no other table, no view, no routine.
    assert!(
        text.contains("-- rows: audit=5, customers=4, orders=5\n"),
        "{text}"
    );
    assert!(!text.contains("extra"), "{text}");
    assert!(
        !text.contains("CREATE VIEW") && !text.contains("v_base"),
        "{text}"
    );
    assert!(
        !text.contains("f_double") && !text.contains("p_count"),
        "{text}"
    );
    assert!(text.contains("TRIGGER `orders_audit`"), "{text}");
    assert_eq!(fx.count(&fx.database, "extra").await, 1);

    // A first Backup that fails means no DROP runs: its file now exists.
    fx.sql("INSERT INTO customers (name) VALUES ('Fajar')")
        .await;
    let end = fx.restore(req).await;
    assert_eq!(end["kind"], "failed", "{end}");
    let m = message(&end);
    assert!(m.starts_with("Backing up the tables first failed: "), "{m}");
    assert!(m.ends_with("Nothing was dropped or restored."), "{m}");
    assert_eq!(fx.count(&fx.database, "customers").await, 4);
    fx.end().await;
}

#[tokio::test]
async fn a_count_mismatch_says_so() {
    for kind in KINDS {
        let mut fx = Fx::new(kind, Setup::default()).await;
        let file = fx.backup("f.sql").await;
        let label = match kind {
            DialectKind::Postgres => "billing.orders",
            _ => "orders",
        };
        let text = std::fs::read_to_string(&file).unwrap();
        let edited = text.replacen(&format!("{label}=5"), &format!("{label}=6"), 1);
        assert_ne!(text, edited);
        std::fs::write(&file, edited).unwrap();
        let name = fx.new_name(1);
        let end = fx
            .restore(fx.req(&file, RestoreMode::NewDatabase { name: name.clone() }))
            .await;
        assert_eq!(end["kind"], "failed", "{kind:?} {end}");
        let m = message(&end);
        let head = format!("{label}: the file says 6 rows, 5 were restored.");
        match kind {
            DialectKind::MySql => {
                assert_eq!(m, format!("{head} The restored rows stay."));
                assert!(fx.exists(&name).await);
            }
            DialectKind::Postgres => {
                assert_eq!(
                    m,
                    format!("{head} Nothing was restored. {name} was removed.")
                );
                assert!(!fx.exists(&name).await);
            }
            DialectKind::Sqlite => {
                assert_eq!(
                    m,
                    format!("{head} Nothing was restored. new1.sqlite was removed.")
                );
                assert!(!fx.exists(&name).await);
            }
        }
        fx.end().await;
    }
}

#[tokio::test]
async fn a_plain_start_needs_the_reviewed_plan() {
    for kind in KINDS {
        let mut fx = Fx::new(kind, Setup::default()).await;
        let file = fx.backup("f.sql").await;
        let name = fx.new_name(1);
        let req = fx.req(&file, RestoreMode::NewDatabase { name: name.clone() });
        // No fingerprint: nothing was reviewed.
        assert!(matches!(
            fx.start_with(req.clone(), String::new(), None).await,
            Err(Error::InvalidInput(_))
        ));
        // R28: the file changed after the review on a plain Connection.
        let reviewed = fx.svc.plan_restore(req.clone()).await.unwrap().fingerprint;
        insert_before_trailer(&file, "-- edited after the review");
        match fx.start_with(req.clone(), reviewed, None).await {
            Err(Error::FileChanged { confirmed, .. }) => assert!(!confirmed),
            Err(e) => panic!("{kind:?}: expected FileChanged, got {e:?}"),
            Ok(_) => panic!("{kind:?}: a changed file started"),
        }
        // A plan other than the one reviewed (another name) is refused too.
        let other = fx.new_name(2);
        let other_fp = fx
            .svc
            .plan_restore(fx.req(&file, RestoreMode::NewDatabase { name: other }))
            .await
            .unwrap()
            .fingerprint;
        assert!(matches!(
            fx.start_with(req.clone(), other_fp, None).await,
            Err(Error::FileChanged { .. })
        ));
        assert!(!fx.exists(&name).await, "{kind:?}: nothing was made");
        assert!(fx.svc.jobs().list().is_empty());
        fx.end().await;
    }
}

#[tokio::test]
async fn pg_replace_drops_enums_and_sequences() {
    let fx = Fx::new(DialectKind::Postgres, Setup::default()).await;
    // The fixture's partitioned table stays: the Backup leaves it out with its sequences
    // (R33), so Replace keeps it and nothing collides.
    let file = fx.backup("f.sql").await;
    // A changed copy: an extra row, the sequence moved on, a new enum label.
    fx.sql(
        "INSERT INTO billing.customers (name) VALUES ('Eko'); \
         SELECT nextval('billing.ticket_seq'); \
         ALTER TYPE billing.mood ADD VALUE 'glad'",
    )
    .await;
    let req = fx.req(
        &file,
        RestoreMode::Replace {
            backup_first: false,
        },
    );
    let plan = fx.svc.plan_restore(req.clone()).await.unwrap();
    let drops: Vec<&str> = plan.drops.iter().map(|d| d.text.as_str()).collect();
    let at = |w: &str| drops.iter().position(|d| d.starts_with(w)).unwrap();
    // Tables, then the functions their triggers call, then sequences and types.
    assert!(at("DROP TABLE") < at("DROP FUNCTION"), "{drops:#?}");
    assert!(at("DROP TABLE") < at("DROP SEQUENCE"), "{drops:#?}");
    assert!(at("DROP SEQUENCE") < at("DROP TYPE"), "{drops:#?}");
    let end = fx.restore(req).await;
    assert_eq!(end["kind"], "finished", "{end}");
    assert_eq!(end["report"]["restore"]["countsMatch"], true, "{end}");
    assert_eq!(fx.count(&fx.database, "customers").await, 3);
    let client = pg_admin_client(&fx.database).await;
    let labels: i64 = client
        .query_one(
            "SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid \
             JOIN pg_namespace n ON n.oid = t.typnamespace \
             WHERE n.nspname = 'billing' AND t.typname = 'mood'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(labels, 2, "the enum is the file's again");
    drop(client);
    fx.end().await;
}

#[tokio::test]
async fn dotted_table_names_count() {
    for kind in KINDS {
        let mut fx = Fx::new(kind, Setup::default()).await;
        let statements: &[&str] = match kind {
            DialectKind::MySql => &[
                "CREATE TABLE `a.b` (id INT PRIMARY KEY)",
                "INSERT INTO `a.b` VALUES (1), (2)",
            ],
            DialectKind::Postgres => &[
                "CREATE TABLE billing.\"a.b\" (id integer PRIMARY KEY)",
                "INSERT INTO billing.\"a.b\" VALUES (1), (2)",
            ],
            DialectKind::Sqlite => &[
                "CREATE TABLE \"a.b\" (id INTEGER PRIMARY KEY)",
                "INSERT INTO \"a.b\" VALUES (1), (2)",
            ],
        };
        for sql in statements {
            fx.sql(sql).await;
        }
        let file = fx.backup("f.sql").await;
        let name = fx.new_name(1);
        let end = fx
            .restore(fx.req(&file, RestoreMode::NewDatabase { name: name.clone() }))
            .await;
        assert_eq!(end["kind"], "finished", "{kind:?} {end}");
        assert_eq!(
            end["report"]["restore"]["countsMatch"], true,
            "{kind:?} {end}"
        );
        assert_eq!(end["report"]["restore"]["rows"], 15, "{kind:?} {end}");
        fx.end().await;
    }
}
