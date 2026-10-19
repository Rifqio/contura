//! Live: Backup and Restore round trips per Dialect (step 9, Task 7). The fixture is the
//! Backup fixture plus every type family in `kinds` (20,000 rows; 100,000 in the ignored
//! long run). Each run backs up, then:
//! 1. restores into a new database and compares it with the source;
//! 2. changes the source, restores over it in Replace mode, and compares again;
//! 3. backs up the source again, empties it, restores Into it, and compares again.
//!
//! "Compares" means: `schema_snapshot` equality, `object_definition` text equality for
//! views, routines and triggers, per-table counts, every row through `RowSource`, the
//! trigger did not fire during the load, and the next identity or auto-increment insert.
//! Schema Compare (step 10) is the oracle for the structure as well: comparing the source
//! with the new database must give no differences after each of the three restores.
//!
//! MySQL and PostgreSQL in `dbview_test_<8hex>` databases as `dbview_test`, the new
//! database named `dbview_test_<8hex>_restore_1019`; SQLite in temp files.

mod common;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::TestDb;
use common::backup_fixture::{
    LONG_ROUND_TRIP_ROWS, PG_SCHEMA, ROUND_TRIP_ROWS, mysql_conn, mysql_round_trip_fixture,
    pg_round_trip_fixture, sqlite_round_trip_fixture,
};
use common::pg::{PgTestDb, pg_admin_client};
use contura_core::backup::plan::{BackupFormat, BackupInclude, BackupRequest};
use contura_core::backup::restore::{RestoreMode, RestoreRequest, RestoreTarget};
use contura_core::connections::{
    CompareDatabase, CompareRequest, CompareSide, ConnectionInput, ConnectionService,
    PasswordChange,
};
use contura_core::dialect::{Dialect, connect};
use contura_core::jobs::JobSink;
use contura_core::jobs::source::SourceRequest;
use contura_core::model::{
    ConnectionConfig, ConnectionId, DialectKind, ObjectKind, ObjectPath, SslMode,
};
use contura_core::schema_model::SchemaModel;
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
        let until = Instant::now() + Duration::from_secs(600);
        loop {
            let found = self
                .0
                .lock()
                .unwrap()
                .iter()
                .find(|e| e["kind"] == "finished" || e["kind"] == "failed")
                .cloned();
            if let Some(e) = found {
                return e;
            }
            assert!(Instant::now() < until, "the job never ended");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

struct Rt {
    kind: DialectKind,
    dir: tempfile::TempDir,
    svc: Arc<ConnectionService>,
    id: ConnectionId,
    /// The source: a database name, or the SQLite file's path.
    source: String,
    my: Option<TestDb>,
    pg: Option<PgTestDb>,
    made: Vec<String>,
}

impl Rt {
    async fn new(kind: DialectKind, rows: u64) -> Rt {
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
            production: false,
            read_only: false,
        };
        let (mut my, mut pg) = (None, None);
        let source = match kind {
            DialectKind::MySql => {
                let db = TestDb::create().await;
                mysql_round_trip_fixture(&db, rows).await;
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
                pg_round_trip_fixture(&db, rows).await;
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
                sqlite_round_trip_fixture(&file, rows);
                inp.file = Some(file.clone());
                file.display().to_string()
            }
        };
        let saved = svc.save(inp).await.expect("save the Connection");
        svc.open(saved.id).await.expect("open the Connection");
        Rt {
            kind,
            dir,
            svc,
            id: saved.id,
            source,
            my,
            pg,
            made: Vec::new(),
        }
    }

    fn out(&self, name: &str) -> PathBuf {
        self.dir.path().join("out").join(name)
    }

    /// The database name a restore targets (SQLite: `main`).
    fn source_database(&self) -> String {
        match self.kind {
            DialectKind::Sqlite => "main".into(),
            _ => self.source.clone(),
        }
    }

    fn schema(&self) -> Option<String> {
        (self.kind == DialectKind::Postgres).then(|| PG_SCHEMA.to_string())
    }

    async fn backup(&self, file: &str) -> PathBuf {
        let req = BackupRequest {
            connection_id: self.id,
            database: self.source_database(),
            schema: self.schema(),
            include: BackupInclude::default(),
            format: BackupFormat::Script,
            rows_per_statement: 500,
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
        assert_eq!(end["kind"], "finished", "{:?} backup: {end}", self.kind);
        self.out(file)
    }

    /// Plans the restore (the review), starts it with that plan's fingerprint and waits.
    async fn restore(&self, path: &Path, mode: RestoreMode) -> Json {
        let req = RestoreRequest {
            target: RestoreTarget {
                connection_id: self.id,
                database: Some(self.source_database()),
                schema: self.schema(),
            },
            path: path.to_path_buf(),
            mode,
            run_as_is: false,
            local_date: None,
        };
        let plan = self.svc.plan_restore(req.clone()).await.expect("the plan");
        let rec = Arc::new(Rec::default());
        self.svc
            .start_restore(
                uuid::Uuid::new_v4(),
                req,
                plan.fingerprint,
                None,
                rec.clone(),
            )
            .await
            .expect("the restore starts");
        let end = rec.wait().await;
        assert_eq!(end["kind"], "finished", "{:?} restore: {end}", self.kind);
        assert_eq!(
            end["report"]["restore"]["countsMatch"], true,
            "{:?}: {end}",
            self.kind
        );
        end
    }

    /// A Dialect on database `db` (SQLite: the file `db`), apart from the service's own.
    async fn dialect(&self, db: &str) -> Arc<dyn Dialect> {
        let (config, password): (ConnectionConfig, Option<String>) = match self.kind {
            DialectKind::MySql => {
                let t = self.my.as_ref().unwrap();
                let mut c = t.config.clone();
                c.database = Some(db.to_string());
                (c, t.password.clone())
            }
            DialectKind::Postgres => {
                let t = self.pg.as_ref().unwrap();
                let mut c = t.config.clone();
                c.database = Some(db.to_string());
                (c, t.password.clone())
            }
            DialectKind::Sqlite => {
                let mut c = common::base_config("", None);
                c.dialect = DialectKind::Sqlite;
                c.host = String::new();
                c.port = 0;
                c.file = Some(PathBuf::from(db));
                (c, None)
            }
        };
        connect(&config, password.as_deref())
            .await
            .expect("connect to the database")
    }

    /// Runs single statements on database `db` (SQLite: the file `db`), for setup.
    async fn sql(&self, db: &str, statements: &[&str]) {
        match self.kind {
            DialectKind::MySql => {
                let mut conn = mysql_conn(self.my.as_ref().unwrap(), db).await;
                for sql in statements {
                    conn.query_drop(*sql)
                        .await
                        .unwrap_or_else(|e| panic!("{sql}: {e}"));
                }
                conn.disconnect().await.ok();
            }
            DialectKind::Postgres => {
                let client = pg_admin_client(db).await;
                for sql in statements {
                    client
                        .execute(*sql, &[])
                        .await
                        .unwrap_or_else(|e| panic!("{sql}: {e}"));
                }
            }
            DialectKind::Sqlite => {
                let conn = rusqlite::Connection::open(db).unwrap();
                for sql in statements {
                    conn.execute(sql, [])
                        .unwrap_or_else(|e| panic!("{sql}: {e}"));
                }
            }
        }
    }

    /// The Backup's tables only: PostgreSQL leaves the partitioned `events` out (and the
    /// domain `positive`, which the emptied copy loses with its schema), SQLite
    /// the virtual table `docs` and its shadow tables.
    fn kept(&self, table: &str) -> bool {
        match self.kind {
            DialectKind::Postgres => !table.starts_with("events"),
            DialectKind::Sqlite => table != "docs" && !table.starts_with("docs_"),
            DialectKind::MySql => true,
        }
    }

    /// What the comparison looks at, read from database `db` (SQLite: the file `db`).
    async fn picture(&self, db: &str) -> Picture {
        let d = self.dialect(db).await;
        let database = match self.kind {
            DialectKind::Sqlite => "main".to_string(),
            _ => db.to_string(),
        };
        let schema = self.schema();
        // The database's own name is the only expected difference in the text.
        let plain = |s: &str| match self.kind {
            DialectKind::Sqlite => s.to_string(),
            _ => s.replace(db, "<db>"),
        };

        let mut model = d
            .schema_snapshot(&database, schema.as_deref())
            .await
            .expect("schema snapshot");
        model.tables.retain(|t| self.kept(&t.name));
        model
            .refs
            .retain(|r| self.kept(&r.from.table) && self.kept(&r.to.table));
        model
            .skipped
            .retain(|s| !s.contains("events") && !s.contains("docs") && !s.contains("positive"));
        let model: SchemaModel =
            serde_json::from_str(&plain(&serde_json::to_string(&model).unwrap())).unwrap();

        let objects = d
            .list_objects(&database, schema.as_deref())
            .await
            .expect("list objects");
        let mut definitions = BTreeMap::new();
        let mut rows = BTreeMap::new();
        for o in objects {
            let path = ObjectPath {
                database: database.clone(),
                schema: schema.clone(),
                name: o.name.clone(),
            };
            if o.kind == ObjectKind::Table {
                if !self.kept(&o.name) {
                    continue;
                }
                let mut src = d
                    .open_row_source(&SourceRequest::Table {
                        path,
                        columns: Vec::new(),
                        filter: None,
                        sort: None,
                        keys: Vec::new(),
                    })
                    .await
                    .unwrap_or_else(|e| panic!("read {}: {e}", o.name));
                let mut all = Vec::new();
                while let Some(chunk) = src.next_chunk().await.expect("a chunk") {
                    all.extend(chunk.rows.into_iter().map(|r| format!("{r:?}")));
                }
                all.sort();
                rows.insert(o.name, all);
            } else {
                let text = d
                    .object_definition(o.kind, &path)
                    .await
                    .unwrap_or_else(|e| panic!("definition of {}: {e}", o.name));
                definitions.insert(format!("{:?} {}", o.kind, o.name), plain(&text));
            }
        }
        d.disconnect().await.ok();
        Picture {
            model,
            definitions,
            rows,
        }
    }

    /// A saved, open Connection on the copy `db` (SQLite: the file `db`), so Schema
    /// Compare can read it as the target.
    async fn copy_connection(&self, db: &str) -> ConnectionId {
        let (config, password) = match self.kind {
            DialectKind::MySql => {
                let t = self.my.as_ref().unwrap();
                (Some(&t.config), t.password.clone())
            }
            DialectKind::Postgres => {
                let t = self.pg.as_ref().unwrap();
                (Some(&t.config), t.password.clone())
            }
            DialectKind::Sqlite => (None, None),
        };
        let inp = ConnectionInput {
            id: None,
            name: "kestrel-copy".into(),
            dialect: self.kind,
            host: config.map(|c| c.host.clone()).unwrap_or_default(),
            port: config.map(|c| c.port).unwrap_or(0),
            user: config.map(|c| c.user.clone()).unwrap_or_default(),
            database: config.map(|_| db.to_string()),
            ssl: SslMode::Disable,
            password: match password {
                Some(value) => PasswordChange::Set { value },
                None => PasswordChange::Keep,
            },
            group_id: None,
            file: (self.kind == DialectKind::Sqlite).then(|| PathBuf::from(db)),
            query_timeout_secs: None,
            ai_access: Default::default(),
            production: false,
            read_only: false,
        };
        let saved = self
            .svc
            .save(inp)
            .await
            .expect("save the copy's Connection");
        self.svc
            .open(saved.id)
            .await
            .expect("open the copy's Connection");
        saved.id
    }

    /// Schema Compare with the source as the source and the copy `db` as the target
    /// must find no differences. The tables the Backup leaves out (`kept`) are only in
    /// the source, so their items are the one expected difference.
    async fn compare_structure(&self, what: &str, db: &str) {
        let copy = self.copy_connection(db).await;
        let req = CompareRequest {
            source: CompareSide::Database {
                connection_id: self.id,
                database: self.source_database(),
                schema: self.schema(),
            },
            target: CompareDatabase {
                connection_id: copy,
                database: match self.kind {
                    DialectKind::Sqlite => "main".into(),
                    _ => db.to_string(),
                },
                schema: self.schema(),
            },
        };
        let result = self
            .svc
            .compare_schemas(req)
            .await
            .unwrap_or_else(|e| panic!("{:?} {what}: compare: {e}", self.kind));
        let left: Vec<String> = result
            .items
            .iter()
            .filter(|i| self.kept(i.path.table.as_deref().unwrap_or(&i.path.name)))
            .map(|i| format!("{} ({})", i.id, i.detail))
            .collect();
        assert!(
            left.is_empty(),
            "{:?} {what}: Schema Compare found differences: {left:#?}",
            self.kind
        );
        assert!(
            result.summary.tables > 0,
            "{:?} {what}: compared nothing",
            self.kind
        );
        self.svc.close(copy).await.ok();
    }

    /// Inserts one customer and one order; the new ids, and the audit row the trigger
    /// wrote for the order.
    async fn next_ids(&self, db: &str) -> NextIds {
        match self.kind {
            DialectKind::MySql => {
                let mut conn = mysql_conn(self.my.as_ref().unwrap(), db).await;
                conn.query_drop("INSERT INTO customers (name) VALUES ('Next')")
                    .await
                    .unwrap();
                let customer = conn.last_insert_id().unwrap() as i64;
                conn.query_drop("INSERT INTO orders (customer_id, qty) VALUES (1, 7)")
                    .await
                    .unwrap();
                let order = conn.last_insert_id().unwrap() as i64;
                let audit: Option<i64> =
                    conn.query_first("SELECT MAX(id) FROM audit").await.unwrap();
                conn.disconnect().await.ok();
                NextIds {
                    customer,
                    order,
                    audit: audit.unwrap(),
                    ticket: None,
                }
            }
            DialectKind::Postgres => {
                let client = pg_admin_client(db).await;
                let customer: i64 = client
                    .query_one(
                        "INSERT INTO billing.customers (name) VALUES ('Next') RETURNING id",
                        &[],
                    )
                    .await
                    .unwrap()
                    .get(0);
                let row = client
                    .query_one(
                        "INSERT INTO billing.orders (customer_id, qty) VALUES (1, 7) \
                         RETURNING id, ticket",
                        &[],
                    )
                    .await
                    .unwrap();
                let audit: i32 = client
                    .query_one("SELECT max(id) FROM billing.audit", &[])
                    .await
                    .unwrap()
                    .get(0);
                NextIds {
                    customer,
                    order: row.get(0),
                    audit: audit.into(),
                    ticket: Some(row.get(1)),
                }
            }
            DialectKind::Sqlite => {
                let conn = rusqlite::Connection::open(db).unwrap();
                conn.execute("INSERT INTO customers (name) VALUES ('Next')", [])
                    .unwrap();
                let customer = conn.last_insert_rowid();
                conn.execute("INSERT INTO orders (customer_id, qty) VALUES (1, 7)", [])
                    .unwrap();
                let order = conn.last_insert_rowid();
                let audit: i64 = conn
                    .query_row("SELECT max(id) FROM audit", [], |r| r.get(0))
                    .unwrap();
                NextIds {
                    customer,
                    order,
                    audit,
                    ticket: None,
                }
            }
        }
    }

    /// The fixture's next ids: the source had 3 customers (SQLite: a 4th, deleted, so
    /// AUTOINCREMENT goes on at 5), 5 orders, 5 audit rows; tickets started at 100.
    fn expected_ids(&self) -> NextIds {
        NextIds {
            customer: if self.kind == DialectKind::Sqlite {
                5
            } else {
                4
            },
            order: 6,
            audit: 6,
            ticket: (self.kind == DialectKind::Postgres).then_some(105),
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
                        .execute(
                            &format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)"),
                            &[],
                        )
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

#[derive(Debug, PartialEq, Eq)]
struct NextIds {
    customer: i64,
    order: i64,
    audit: i64,
    ticket: Option<i64>,
}

struct Picture {
    model: SchemaModel,
    definitions: BTreeMap<String, String>,
    rows: BTreeMap<String, Vec<String>>,
}

/// `got` must equal `want`; `what` names the copy in the messages.
fn compare(kind: DialectKind, what: &str, want: &Picture, got: &Picture) {
    assert_eq!(
        want.model, got.model,
        "{kind:?} {what}: schema_snapshot differs"
    );
    assert_eq!(
        want.definitions.keys().collect::<Vec<_>>(),
        got.definitions.keys().collect::<Vec<_>>(),
        "{kind:?} {what}: views, routines and triggers differ"
    );
    for (name, text) in &want.definitions {
        assert_eq!(
            text, &got.definitions[name],
            "{kind:?} {what}: the definition of {name} differs"
        );
    }
    assert_eq!(
        want.rows.keys().collect::<Vec<_>>(),
        got.rows.keys().collect::<Vec<_>>(),
        "{kind:?} {what}: the tables differ"
    );
    for (table, rows) in &want.rows {
        let other = &got.rows[table];
        assert_eq!(
            rows.len(),
            other.len(),
            "{kind:?} {what}: {table} has {} rows, the source {}",
            other.len(),
            rows.len()
        );
        if let Some(i) = (0..rows.len()).find(|&i| rows[i] != other[i]) {
            panic!(
                "{kind:?} {what}: {table} differs at sorted row {i}:\n  source {}\n  copy   {}",
                rows[i], other[i]
            );
        }
    }
}

/// The changes made to the source before Replace: rows added, changed and removed, a
/// view and a trigger or function changed (PostgreSQL: an enum label added, the sequence
/// moved on, and a row in the left-out partitioned table, which Replace must keep).
fn changes(kind: DialectKind) -> &'static [&'static str] {
    match kind {
        DialectKind::MySql => &[
            "INSERT INTO customers (name) VALUES ('Eko')",
            "UPDATE kinds SET body = 'changed' WHERE id = 7",
            "DELETE FROM line_items WHERE line_no = 2",
            "INSERT INTO zero_dates VALUES (4, NULL, NULL)",
            "CREATE OR REPLACE VIEW v_base AS SELECT id, qty FROM orders WHERE qty > 3",
            "DROP TRIGGER orders_audit",
            "DROP PROCEDURE p_count",
            "CREATE PROCEDURE p_count() BEGIN SELECT 42; END",
        ],
        DialectKind::Postgres => &[
            "INSERT INTO billing.customers (name) VALUES ('Eko')",
            "UPDATE billing.kinds SET body = 'changed' WHERE id = 7",
            "DELETE FROM billing.line_items WHERE line_no = 2",
            "CREATE OR REPLACE VIEW billing.v_base AS SELECT id, qty FROM billing.orders WHERE qty > 3",
            "ALTER TYPE billing.mood ADD VALUE 'glad'",
            "SELECT nextval('billing.ticket_seq')",
            "INSERT INTO billing.events (at) VALUES ('2026-05-01')",
        ],
        DialectKind::Sqlite => &[
            "INSERT INTO customers (name) VALUES ('Eko')",
            "UPDATE kinds SET body = 'changed' WHERE id = 7",
            "DELETE FROM line_items WHERE line_no = 2",
            "DROP VIEW a_top",
            "DROP VIEW v_base",
            "CREATE VIEW v_base AS SELECT id FROM orders",
        ],
    }
}

impl Rt {
    /// Removes every object the Backup holds from the source, so it is empty again.
    async fn empty_source(&self) {
        match self.kind {
            DialectKind::MySql => {
                let db = self.my.as_ref().unwrap();
                let mut conn = mysql_conn(db, &db.name).await;
                let views: Vec<String> = conn
                    .exec(
                        "SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?",
                        (db.name.clone(),),
                    )
                    .await
                    .unwrap();
                let tables: Vec<String> = conn
                    .exec(
                        "SELECT TABLE_NAME FROM information_schema.TABLES \
                         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
                        (db.name.clone(),),
                    )
                    .await
                    .unwrap();
                let routines: Vec<(String, String)> = conn
                    .exec(
                        "SELECT ROUTINE_TYPE, ROUTINE_NAME FROM information_schema.ROUTINES \
                         WHERE ROUTINE_SCHEMA = ?",
                        (db.name.clone(),),
                    )
                    .await
                    .unwrap();
                conn.query_drop("SET FOREIGN_KEY_CHECKS = 0").await.unwrap();
                let q = |n: &str| format!("`{}`", n.replace('`', "``"));
                for v in &views {
                    conn.query_drop(format!("DROP VIEW {}", q(v)))
                        .await
                        .unwrap();
                }
                for t in &tables {
                    conn.query_drop(format!("DROP TABLE {}", q(t)))
                        .await
                        .unwrap();
                }
                for (kind, name) in &routines {
                    conn.query_drop(format!("DROP {kind} {}", q(name)))
                        .await
                        .unwrap();
                }
                conn.disconnect().await.ok();
            }
            DialectKind::Postgres => {
                self.sql(&self.source, &["DROP SCHEMA billing CASCADE"])
                    .await;
            }
            DialectKind::Sqlite => {
                let conn = rusqlite::Connection::open(&self.source).unwrap();
                conn.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
                let objects: Vec<(String, String)> = conn
                    .prepare(
                        "SELECT type, name FROM sqlite_master WHERE type IN ('view', 'trigger') \
                         OR (type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'docs_%') \
                         ORDER BY CASE type WHEN 'trigger' THEN 0 WHEN 'view' THEN 1 ELSE 2 END",
                    )
                    .unwrap()
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                    .unwrap()
                    .map(Result::unwrap)
                    .collect();
                for (kind, name) in objects {
                    conn.execute(
                        &format!("DROP {kind} IF EXISTS \"{}\"", name.replace('"', "\"\"")),
                        [],
                    )
                    .unwrap();
                }
                conn.execute("DELETE FROM sqlite_sequence", []).unwrap();
                conn.execute_batch("PRAGMA user_version = 0").unwrap();
            }
        }
    }
}

async fn round_trip(kind: DialectKind, rows: u64) {
    let mut rt = Rt::new(kind, rows).await;
    let source = rt.source.clone();
    let original = rt.picture(&source).await;
    assert_eq!(original.rows["kinds"].len() as u64, rows, "{kind:?}");
    // The comparison covers every table and every view, routine and trigger.
    let (tables, definitions) = match kind {
        DialectKind::MySql => (7, 6),
        DialectKind::Postgres => (7, 6),
        DialectKind::Sqlite => (6, 3),
    };
    assert_eq!(
        original.rows.len(),
        tables,
        "{kind:?}: {:?}",
        original.rows.keys()
    );
    assert_eq!(
        original.definitions.len(),
        definitions,
        "{kind:?}: {:?}",
        original.definitions.keys()
    );
    let audit_rows = original.rows["audit"].len();
    let file = rt.backup("round.sql").await;

    // 1. Into a new database.
    let name = match kind {
        DialectKind::Sqlite => rt.out("restored.sqlite").display().to_string(),
        _ => format!("{source}_restore_1019"),
    };
    rt.made.push(name.clone());
    let end = rt
        .restore(&file, RestoreMode::NewDatabase { name: name.clone() })
        .await;
    assert!(end["report"]["restore"]["rows"].as_u64().unwrap() >= rows);
    let copy = rt.picture(&name).await;
    compare(kind, "new database", &original, &copy);
    rt.compare_structure("new database", &name).await;
    // The trigger came after the rows, so the load added no audit row.
    assert_eq!(copy.rows["audit"].len(), audit_rows, "{kind:?}");

    // 2. Replace over a changed copy restores the original.
    rt.sql(&source, changes(kind)).await;
    let differs = rt.picture(&source).await;
    assert_ne!(
        differs.rows["customers"], original.rows["customers"],
        "{kind:?}: the change took"
    );
    rt.restore(
        &file,
        RestoreMode::Replace {
            backup_first: false,
        },
    )
    .await;
    compare(kind, "Replace", &original, &rt.picture(&source).await);
    rt.compare_structure("Replace", &name).await;
    if kind == DialectKind::Postgres {
        // The left-out partitioned table and its sequences were kept (R33).
        let client = pg_admin_client(&source).await;
        let events: i64 = client
            .query_one("SELECT count(*) FROM billing.events", &[])
            .await
            .unwrap()
            .get(0);
        assert_eq!(events, 1, "Replace keeps billing.events");
    }

    // 3. Back up again, empty the source, restore Into it.
    let again = rt.backup("again.sql").await;
    rt.empty_source().await;
    rt.restore(&again, RestoreMode::IntoEmpty).await;
    compare(
        kind,
        "Into the emptied database",
        &original,
        &rt.picture(&source).await,
    );
    rt.compare_structure("Into the emptied database", &name)
        .await;

    // The next identity and auto-increment insert works, in both copies.
    assert_eq!(
        rt.next_ids(&name).await,
        rt.expected_ids(),
        "{kind:?} new database"
    );
    assert_eq!(
        rt.next_ids(&source).await,
        rt.expected_ids(),
        "{kind:?} Into"
    );
    rt.end().await;
}

#[tokio::test]
async fn mysql_round_trip() {
    round_trip(DialectKind::MySql, ROUND_TRIP_ROWS).await;
}

#[tokio::test]
async fn postgres_round_trip() {
    round_trip(DialectKind::Postgres, ROUND_TRIP_ROWS).await;
}

#[tokio::test]
async fn sqlite_round_trip() {
    round_trip(DialectKind::Sqlite, ROUND_TRIP_ROWS).await;
}

/// The long run: 100,000 rows per Dialect. `cargo test --test backup_round_trip -- --ignored`.
#[tokio::test]
#[ignore = "long run: 100,000 rows per Dialect"]
async fn long_round_trips() {
    for kind in [
        DialectKind::MySql,
        DialectKind::Postgres,
        DialectKind::Sqlite,
    ] {
        round_trip(kind, LONG_ROUND_TRIP_ROWS).await;
    }
}
