//! Data Transfer runs end to end (step 8, Task 5): a fixture source per Dialect, copied
//! to each target. Live MySQL and PostgreSQL in `dbview_test_<8hex>` databases; SQLite
//! in temp files.

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use common::TestDb;
use common::jobs::run_sql;
use common::pg::PgTestDb;
use contura_core::dialect::{Dialect, connect};
use contura_core::jobs::source::{SourceRequest, Value};
use contura_core::model::{ConnectionConfig, DialectKind, SslMode};
use contura_core::transfer::{
    RunSides, Side, TableChoice, TargetState, TransferObserver, TransferProgress, TransferRequest,
    plan_transfer, run_transfer,
};

const SALES: u64 = 20_000;
const STORES: u64 = 50;

enum Holder {
    My(TestDb),
    Pg(PgTestDb),
    Lite(tempfile::TempDir),
}

struct End {
    holder: Holder,
    d: Arc<dyn Dialect>,
    kind: DialectKind,
    side: Side,
}

impl End {
    async fn open(kind: DialectKind, schema: Option<&str>) -> End {
        let id = uuid::Uuid::new_v4();
        match kind {
            DialectKind::MySql => {
                let db = TestDb::create().await;
                let d = connect(&db.config, db.password.as_deref())
                    .await
                    .expect("connect");
                let side = Side {
                    connection_id: id,
                    database: db.name.clone(),
                    schema: None,
                };
                End {
                    holder: Holder::My(db),
                    d,
                    kind,
                    side,
                }
            }
            DialectKind::Postgres => {
                let db = PgTestDb::create().await;
                let d = connect(&db.config, db.password.as_deref())
                    .await
                    .expect("connect");
                let side = Side {
                    connection_id: id,
                    database: db.name.clone(),
                    schema: Some(schema.unwrap_or("public").into()),
                };
                End {
                    holder: Holder::Pg(db),
                    d,
                    kind,
                    side,
                }
            }
            DialectKind::Sqlite => {
                let dir = tempfile::tempdir().unwrap();
                let file = dir.path().join("t.sqlite");
                rusqlite::Connection::open(&file).unwrap();
                let config = ConnectionConfig {
                    id,
                    name: "t".into(),
                    dialect: DialectKind::Sqlite,
                    host: String::new(),
                    port: 0,
                    user: String::new(),
                    database: None,
                    ssl: SslMode::Disable,
                    group_id: None,
                    file: Some(file),
                    query_timeout_secs: None,
                    ai_access: Default::default(),
                    production: false,
                    read_only: false,
                };
                let d = connect(&config, None).await.expect("connect");
                End {
                    holder: Holder::Lite(dir),
                    d,
                    kind,
                    side: Side {
                        connection_id: id,
                        database: "main".into(),
                        schema: None,
                    },
                }
            }
        }
    }

    async fn close(self) {
        let _ = self.d.disconnect().await;
        match self.holder {
            Holder::My(db) => db.drop_db().await,
            Holder::Pg(db) => db.drop_db().await,
            Holder::Lite(dir) => drop(dir),
        }
    }

    /// `name` as a query on this side names it.
    fn table(&self, name: &str) -> String {
        match (self.kind, &self.side.schema) {
            (DialectKind::Postgres, Some(s)) => format!("\"{s}\".\"{name}\""),
            (DialectKind::MySql, _) => format!("`{}`.`{name}`", self.side.database),
            _ => format!("\"{name}\""),
        }
    }

    async fn fixture(&self) {
        let sql: &[&str] = match self.kind {
            DialectKind::MySql => &[
                "CREATE TABLE stores (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(80) NOT NULL) DEFAULT CHARSET utf8mb4",
                "CREATE TABLE sales (id INT AUTO_INCREMENT PRIMARY KEY, store_id INT NOT NULL, total DECIMAL(10,2), sold_at DATETIME NULL, note TEXT NULL, FOREIGN KEY (store_id) REFERENCES stores (id))",
                "INSERT INTO stores (name) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50) SELECT CONCAT('Café ☕ ', i) FROM n",
                "INSERT INTO sales (store_id, total, sold_at, note) WITH RECURSIVE a(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM a WHERE i < 199), b(j) AS (SELECT 0 UNION ALL SELECT j + 1 FROM b WHERE j < 99) SELECT 1 + ((i * 100 + j) % 50), ((i * 100 + j) % 1000) / 4, TIMESTAMP '2024-01-01 00:00:00' + INTERVAL (i * 100 + j) MINUTE, IF((i * 100 + j) % 7 = 0, NULL, CONCAT('n', i * 100 + j)) FROM a, b",
            ],
            DialectKind::Postgres => &[
                "CREATE TABLE stores (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name varchar(80) NOT NULL)",
                "CREATE TABLE sales (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, store_id integer NOT NULL REFERENCES stores (id), total numeric(10,2), sold_at timestamp, note text)",
                "INSERT INTO stores (name) SELECT 'Café ☕ ' || i FROM generate_series(1, 50) i",
                "INSERT INTO sales (store_id, total, sold_at, note) SELECT 1 + (i % 50), (i % 1000) / 4.0, timestamp '2024-01-01 00:00:00' + i * interval '1 minute', CASE WHEN i % 7 = 0 THEN NULL ELSE 'n' || i END FROM generate_series(0, 19999) i",
            ],
            DialectKind::Sqlite => &[
                "CREATE TABLE stores (id INTEGER PRIMARY KEY AUTOINCREMENT, name varchar(80) NOT NULL)",
                "CREATE TABLE sales (id INTEGER PRIMARY KEY AUTOINCREMENT, store_id INTEGER NOT NULL REFERENCES stores (id), total NUMERIC, sold_at TEXT, note TEXT)",
                "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50) INSERT INTO stores (name) SELECT 'Café ☕ ' || i FROM n",
                "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 19999) INSERT INTO sales (store_id, total, sold_at, note) SELECT 1 + (i % 50), (i % 1000) / 4.0, datetime('2024-01-01 00:00:00', '+' || i || ' minutes'), CASE WHEN i % 7 = 0 THEN NULL ELSE 'n' || i END FROM n",
            ],
        };
        for s in sql {
            run_sql(self.d.as_ref(), s).await;
        }
    }

    /// Every row of a query, each value in a canonical text form.
    async fn rows(&self, sql: &str) -> Vec<Vec<String>> {
        let mut src = self
            .d
            .open_row_source(&SourceRequest::Query {
                database: (self.kind == DialectKind::MySql).then(|| self.side.database.clone()),
                sql: sql.into(),
            })
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
        let mut out = Vec::new();
        while let Some(chunk) = src.next_chunk().await.unwrap() {
            for row in chunk.rows {
                out.push(row.iter().map(canonical).collect());
            }
        }
        out
    }
}

/// Numbers by value, timestamps to the second with a space, NULL as empty.
fn canonical(v: &Value) -> String {
    let text = match v {
        Value::Null => return String::new(),
        Value::Number(s) | Value::Text(s) => s.clone(),
        Value::Bool(b) => (if *b { "1" } else { "0" }).into(),
        Value::Bytes(b) => String::from_utf8_lossy(b).into_owned(),
    };
    if let Ok(f) = text.trim().parse::<f64>() {
        return format!("{f}");
    }
    let t = text.replace('T', " ");
    if t.len() >= 19 && t.as_bytes()[4] == b'-' && t.as_bytes()[13] == b':' {
        return t[..19].to_string();
    }
    text
}

#[derive(Default)]
struct Watch {
    stop: AtomicBool,
    last: std::sync::Mutex<Option<TransferProgress>>,
}

impl TransferObserver for Watch {
    fn progress(&self, p: &TransferProgress) {
        *self.last.lock().unwrap() = Some(p.clone());
    }
    fn cancelled(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }
    fn warning(&self, _: &str) {}
}

/// Copies the fixture from `from` to `to` and checks counts, rows and the next id.
async fn copy_and_check(from: DialectKind, to: DialectKind) {
    let source = End::open(from, None).await;
    source.fixture().await;
    let target = End::open(to, Some("pos")).await;

    let model = source
        .d
        .schema_snapshot(&source.side.database, source.side.schema.as_deref())
        .await
        .expect("source snapshot");
    let req = TransferRequest {
        source: source.side.clone(),
        target: target.side.clone(),
        tables: ["stores", "sales"]
            .iter()
            .map(|n| TableChoice {
                name: n.to_string(),
                ticked: true,
                ..Default::default()
            })
            .collect(),
        batch_rows: 1_000,
        compare_counts: true,
        create_target_scope: to == DialectKind::Postgres,
        ..Default::default()
    };
    let state = TargetState {
        dialect: to,
        connection_name: "target".into(),
        tables: vec![],
    };
    let plan = plan_transfer(&req, &model, &state).expect("plan");
    assert!(plan.blocked.is_empty(), "{:?}", plan.blocked);
    let watch = Watch::default();
    let outcome = run_transfer(
        &plan,
        RunSides {
            source: source.d.as_ref(),
            source_side: &source.side,
            target: target.d.as_ref(),
            target_side: &target.side,
            target_name: "target",
        },
        req.batch_rows,
        true,
        &watch,
    )
    .await
    .unwrap_or_else(|e| panic!("{from:?} to {to:?}: {e}"));

    assert_eq!(outcome.counts_match, Some(true));
    assert_eq!(outcome.rows, SALES + STORES);
    let last = watch
        .last
        .lock()
        .unwrap()
        .clone()
        .expect("progress was sent");
    assert_eq!(last.total, Some(SALES + STORES));

    for (table, cols) in [
        ("stores", "id, name"),
        ("sales", "id, store_id, total, sold_at, note"),
    ] {
        let a = source
            .rows(&format!(
                "SELECT {cols} FROM {} ORDER BY id",
                source.table(table)
            ))
            .await;
        let b = target
            .rows(&format!(
                "SELECT {cols} FROM {} ORDER BY id",
                target.table(table)
            ))
            .await;
        assert_eq!(a.len(), b.len(), "{table}");
        assert!(
            a == b,
            "{from:?} to {to:?}: {table} rows differ, first: {:?} vs {:?}",
            a.iter().zip(&b).find(|(x, y)| x != y).map(|p| p.0),
            a.iter().zip(&b).find(|(x, y)| x != y).map(|p| p.1)
        );
    }

    // The next id continues after the copied ones.
    run_sql(
        target.d.as_ref(),
        &format!(
            "INSERT INTO {} (name) VALUES ('next')",
            target.table("stores")
        ),
    )
    .await;
    let next = target
        .rows(&format!("SELECT max(id) FROM {}", target.table("stores")))
        .await;
    assert_eq!(next[0][0], (STORES + 1).to_string(), "{from:?} to {to:?}");

    source.close().await;
    target.close().await;
}

#[tokio::test]
async fn mysql_to_postgres() {
    copy_and_check(DialectKind::MySql, DialectKind::Postgres).await;
}

#[tokio::test]
async fn postgres_to_mysql() {
    copy_and_check(DialectKind::Postgres, DialectKind::MySql).await;
}

#[tokio::test]
async fn mysql_to_mysql() {
    copy_and_check(DialectKind::MySql, DialectKind::MySql).await;
}

#[tokio::test]
async fn mysql_to_sqlite() {
    copy_and_check(DialectKind::MySql, DialectKind::Sqlite).await;
}

#[tokio::test]
async fn postgres_to_sqlite() {
    copy_and_check(DialectKind::Postgres, DialectKind::Sqlite).await;
}

#[tokio::test]
async fn sqlite_to_postgres() {
    copy_and_check(DialectKind::Sqlite, DialectKind::Postgres).await;
}

#[tokio::test]
async fn sqlite_to_mysql() {
    copy_and_check(DialectKind::Sqlite, DialectKind::MySql).await;
}

// ---- Task 6: per-target rules, failure and cancel ----

use contura_core::error::Error;
use contura_core::transfer::{ColumnSetting, IfExists, TargetColumn, TargetTable, TransferOutcome};

/// Plans and runs a transfer of `tables` with `tweak` applied to the request.
async fn transfer(
    source: &End,
    target: &End,
    tables: &[&str],
    tweak: impl FnOnce(&mut TransferRequest),
    watch: &dyn TransferObserver,
) -> contura_core::Result<TransferOutcome> {
    let model = source
        .d
        .schema_snapshot(&source.side.database, source.side.schema.as_deref())
        .await
        .expect("source snapshot");
    let mut req = TransferRequest {
        source: source.side.clone(),
        target: target.side.clone(),
        tables: tables
            .iter()
            .map(|n| TableChoice {
                name: n.to_string(),
                ticked: true,
                ..Default::default()
            })
            .collect(),
        batch_rows: 100,
        compare_counts: true,
        create_target_scope: target.kind == DialectKind::Postgres,
        ..Default::default()
    };
    tweak(&mut req);
    plan_and_run(source, target, &req, model, watch).await
}

async fn plan_and_run(
    source: &End,
    target: &End,
    req: &TransferRequest,
    model: contura_core::schema_model::SchemaModel,
    watch: &dyn TransferObserver,
) -> contura_core::Result<TransferOutcome> {
    let target_model = target
        .d
        .schema_snapshot(&target.side.database, target.side.schema.as_deref())
        .await
        .ok();
    let state = TargetState {
        dialect: target.kind,
        connection_name: "target".into(),
        tables: target_model
            .map(|m| {
                m.tables
                    .iter()
                    .map(|t| TargetTable {
                        name: t.name.clone(),
                        rows: None,
                        columns: t
                            .columns
                            .iter()
                            .map(|c| TargetColumn {
                                name: c.name.clone(),
                                not_null: c.not_null,
                                has_default: c.default.is_some(),
                                generated: c.increment,
                                identity_always: false,
                            })
                            .collect(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    };
    let plan = plan_transfer(req, &model, &state)?;
    run_transfer(
        &plan,
        RunSides {
            source: source.d.as_ref(),
            source_side: &source.side,
            target: target.d.as_ref(),
            target_side: &target.side,
            target_name: "target",
        },
        req.batch_rows,
        req.compare_counts,
        watch,
    )
    .await
}

fn failed(r: contura_core::Result<TransferOutcome>) -> String {
    match r {
        Err(Error::JobFailed { message, .. }) => message,
        other => panic!("expected the run to fail, got {other:?}"),
    }
}

async fn table_count(end: &End) -> usize {
    end.d
        .schema_snapshot(&end.side.database, end.side.schema.as_deref())
        .await
        .map(|m| m.tables.len())
        .unwrap_or(0)
}

async fn count(end: &End, table: &str) -> String {
    end.rows(&format!("SELECT count(*) FROM {}", end.table(table)))
        .await[0][0]
        .clone()
}

/// A PostgreSQL source with a NaN in row 500 of sales_lines.
async fn nan_source() -> End {
    let source = End::open(DialectKind::Postgres, None).await;
    for s in [
        "CREATE TABLE a (id integer PRIMARY KEY, v double precision)",
        "CREATE TABLE b (id integer PRIMARY KEY, v double precision)",
        "CREATE TABLE sales_lines (id integer PRIMARY KEY, unit_price double precision)",
        "INSERT INTO a SELECT i, i FROM generate_series(1, 300) i",
        "INSERT INTO b SELECT i, i FROM generate_series(1, 300) i",
        "INSERT INTO sales_lines SELECT i, CASE WHEN i = 500 THEN 'NaN'::float8 ELSE i / 4.0 END FROM generate_series(1, 1000) i",
    ] {
        run_sql(source.d.as_ref(), s).await;
    }
    source
}

fn typed(table: &str, column: &str, value: &str) -> ColumnSetting {
    ColumnSetting {
        table: table.into(),
        column: Some(column.into()),
        value: value.into(),
    }
}

#[tokio::test]
async fn nan_on_postgres_rolls_back() {
    let source = nan_source().await;
    let target = End::open(DialectKind::Postgres, Some("pos")).await;
    let r = transfer(
        &source,
        &target,
        &["a", "sales_lines"],
        |req| {
            req.overrides
                .push(typed("sales_lines", "unit_price", "numeric(10,2)"))
        },
        &Watch::default(),
    )
    .await;
    assert_eq!(
        failed(r),
        "sales_lines, row 500, id 500: the value NaN is not valid for numeric(10,2) in unit_price. The transaction rolled back, so target is as it was."
    );
    assert_eq!(table_count(&target).await, 0, "nothing stays on PostgreSQL");
    source.close().await;
    target.close().await;
}

#[tokio::test]
async fn a_server_refusal_names_the_source_row() {
    // The server refuses one value (longer than the typed type), so the batch is
    // replayed row by row to name the row.
    let source = End::open(DialectKind::Postgres, None).await;
    run_sql(
        source.d.as_ref(),
        "CREATE TABLE codes (id integer PRIMARY KEY, code text)",
    )
    .await;
    run_sql(
        source.d.as_ref(),
        "INSERT INTO codes SELECT i, CASE WHEN i = 77 THEN 'far too long' ELSE 'c' || (i % 9) END FROM generate_series(1, 150) i",
    )
    .await;
    for to in [DialectKind::Postgres, DialectKind::MySql] {
        let target = End::open(to, Some("pos")).await;
        let r = transfer(
            &source,
            &target,
            &["codes"],
            |req| req.overrides.push(typed("codes", "code", "varchar(4)")),
            &Watch::default(),
        )
        .await;
        let message = failed(r);
        assert!(
            message.starts_with("codes, row 77, id 77: "),
            "{to:?}: {message}"
        );
        target.close().await;
    }
    // The bad row last in its batch, then in a later batch: the replay tests exactly
    // the refused statement's rows.
    for bad in [100, 230] {
        run_sql(source.d.as_ref(), "DELETE FROM codes").await;
        run_sql(
            source.d.as_ref(),
            &format!("INSERT INTO codes SELECT i, CASE WHEN i = {bad} THEN 'far too long' ELSE 'c' || (i % 9) END FROM generate_series(1, 300) i"),
        )
        .await;
        let target = End::open(DialectKind::Postgres, Some("pos")).await;
        let r = transfer(
            &source,
            &target,
            &["codes"],
            |req| req.overrides.push(typed("codes", "code", "varchar(4)")),
            &Watch::default(),
        )
        .await;
        let message = failed(r);
        assert!(
            message.starts_with(&format!("codes, row {bad}, id {bad}: ")),
            "row {bad}: {message}"
        );
        target.close().await;
    }
    source.close().await;
}

#[tokio::test]
async fn mysql_failure_lists_what_stays() {
    let source = nan_source().await;
    let target = End::open(DialectKind::MySql, None).await;
    let r = transfer(
        &source,
        &target,
        &["a", "b", "sales_lines"],
        |_| {},
        &Watch::default(),
    )
    .await;
    assert_eq!(
        failed(r),
        "sales_lines, row 500, id 500: the value NaN is not valid for double in unit_price. 3 tables were created and 2 were copied before the failure. They stay on target."
    );
    assert_eq!(count(&target, "a").await, "300");
    assert_eq!(
        count(&target, "sales_lines").await,
        "0",
        "the failing table rolled back"
    );
    source.close().await;
    target.close().await;
}

/// Cancels at the first progress report.
#[derive(Default)]
struct CancelSoon {
    seen: AtomicBool,
    warnings: std::sync::Mutex<Vec<String>>,
}

impl TransferObserver for CancelSoon {
    fn progress(&self, _: &TransferProgress) {
        self.seen.store(true, Ordering::SeqCst);
    }
    fn cancelled(&self) -> bool {
        self.seen.load(Ordering::SeqCst)
    }
    fn warning(&self, text: &str) {
        self.warnings.lock().unwrap().push(text.to_string());
    }
}

#[tokio::test]
async fn cancel_mid_run_per_target() {
    for to in [
        DialectKind::Postgres,
        DialectKind::Sqlite,
        DialectKind::MySql,
    ] {
        let source = End::open(DialectKind::MySql, None).await;
        source.fixture().await;
        let target = End::open(to, Some("pos")).await;
        let watch = CancelSoon::default();
        let r = transfer(
            &source,
            &target,
            &["stores", "sales"],
            |req| req.compare_counts = false,
            &watch,
        )
        .await;
        assert!(matches!(r, Err(Error::Cancelled)), "{to:?}: {r:?}");
        match to {
            DialectKind::MySql => assert_eq!(
                *watch.warnings.lock().unwrap(),
                // The first report comes once stores (one chunk) is committed.
                vec![
                    "2 tables were created and 1 was copied before you cancelled. They stay on target."
                ]
            ),
            _ => assert_eq!(table_count(&target).await, 0, "{to:?} is unchanged"),
        }
        source.close().await;
        target.close().await;
    }
}

#[tokio::test]
async fn mysql_cycle_orphan_restores_checks() {
    let source = End::open(DialectKind::MySql, None).await;
    for s in [
        "CREATE TABLE customers (id INT PRIMARY KEY, best_order_id INT NULL)",
        "CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT NOT NULL)",
        "INSERT INTO customers VALUES (1, 10), (2, NULL)",
        "INSERT INTO orders VALUES (10, 1), (11, 9912), (12, 9912), (13, 9913)",
    ] {
        run_sql(source.d.as_ref(), s).await;
    }
    // The source model carries a cycle of keys the source never enforced.
    let mut model = source
        .d
        .schema_snapshot(&source.side.database, None)
        .await
        .unwrap();
    for (from, col, to) in [
        ("orders", "customer_id", "customers"),
        ("customers", "best_order_id", "orders"),
    ] {
        model.refs.push(contura_core::schema_model::SmRef {
            name: None,
            from: contura_core::schema_model::SmEndpoint {
                schema: None,
                table: from.into(),
                columns: vec![col.into()],
            },
            to: contura_core::schema_model::SmEndpoint {
                schema: None,
                table: to.into(),
                columns: vec!["id".into()],
            },
            on_delete: None,
            on_update: None,
        });
    }
    let target = End::open(DialectKind::MySql, None).await;
    let req = TransferRequest {
        source: source.side.clone(),
        target: target.side.clone(),
        tables: ["customers", "orders"]
            .iter()
            .map(|n| TableChoice {
                name: n.to_string(),
                ticked: true,
                ..Default::default()
            })
            .collect(),
        batch_rows: 100,
        compare_counts: true,
        ..Default::default()
    };
    let r = plan_and_run(&source, &target, &req, model, &Watch::default()).await;
    assert_eq!(
        failed(r),
        "orders.customer_id has 3 values with no row in customers, for example 9912. The table's rows were rolled back."
    );
    assert_eq!(count(&target, "orders").await, "0");
    assert_eq!(count(&target, "customers").await, "0");
    source.close().await;
    target.close().await;
}

#[tokio::test]
async fn empty_it_first_replaces_and_append_adds() {
    for to in [
        DialectKind::Postgres,
        DialectKind::MySql,
        DialectKind::Sqlite,
    ] {
        let source = End::open(DialectKind::MySql, None).await;
        source.fixture().await;
        let target = End::open(to, Some("pos")).await;
        transfer(&source, &target, &["stores"], |_| {}, &Watch::default())
            .await
            .unwrap_or_else(|e| panic!("{to:?} first: {e}"));
        run_sql(
            target.d.as_ref(),
            &format!(
                "INSERT INTO {} (id, name) VALUES (900, 'extra')",
                target.table("stores")
            ),
        )
        .await;
        transfer(
            &source,
            &target,
            &["stores"],
            |req| {
                req.tables[0].if_exists = IfExists::EmptyFirst;
                req.create_target_scope = false;
            },
            &Watch::default(),
        )
        .await
        .unwrap_or_else(|e| panic!("{to:?} empty first: {e}"));
        assert_eq!(count(&target, "stores").await, "50", "{to:?}: replaced");

        // Append into a table that holds other ids.
        run_sql(
            target.d.as_ref(),
            &format!("DELETE FROM {} WHERE id > 25", target.table("stores")),
        )
        .await;
        run_sql(
            source.d.as_ref(),
            &format!("DELETE FROM {} WHERE store_id <= 25", source.table("sales")),
        )
        .await;
        run_sql(
            source.d.as_ref(),
            &format!("DELETE FROM {} WHERE id <= 25", source.table("stores")),
        )
        .await;
        transfer(
            &source,
            &target,
            &["stores"],
            |req| {
                req.tables[0].if_exists = IfExists::Append;
                req.create_target_scope = false;
            },
            &Watch::default(),
        )
        .await
        .unwrap_or_else(|e| panic!("{to:?} append: {e}"));
        assert_eq!(
            count(&target, "stores").await,
            "50",
            "{to:?}: 25 kept and 25 added"
        );
        source.close().await;
        target.close().await;
    }
}

#[tokio::test]
async fn mysql_target_in_a_new_database() {
    let source = End::open(DialectKind::MySql, None).await;
    source.fixture().await;
    let mut target = End::open(DialectKind::MySql, None).await;
    // A database under the test prefix that does not exist yet.
    let fresh = format!("{}_n", target.side.database);
    target.side.database = fresh.clone();
    let r = transfer(
        &source,
        &target,
        &["stores"],
        |req| req.create_target_scope = true,
        &Watch::default(),
    )
    .await;
    let copied = target
        .rows(&format!("SELECT count(*) FROM `{fresh}`.`stores`"))
        .await;
    run_sql(
        target.d.as_ref(),
        &format!("DROP DATABASE IF EXISTS `{fresh}`"),
    )
    .await;
    r.expect("the transfer creates the database first");
    assert_eq!(copied[0][0], "50");
    source.close().await;
    target.close().await;
}

#[tokio::test]
async fn mysql_empties_a_parent_and_child_together() {
    let source = End::open(DialectKind::MySql, None).await;
    source.fixture().await;
    let target = End::open(DialectKind::MySql, None).await;
    transfer(
        &source,
        &target,
        &["stores", "sales"],
        |_| {},
        &Watch::default(),
    )
    .await
    .expect("first copy");
    // Both tables hold rows and sales.store_id points at stores.
    transfer(
        &source,
        &target,
        &["stores", "sales"],
        |req| {
            for t in &mut req.tables {
                t.if_exists = IfExists::EmptyFirst;
            }
        },
        &Watch::default(),
    )
    .await
    .expect("empty both and copy again");
    assert_eq!(
        count(&target, "stores").await,
        count(&source, "stores").await
    );
    assert_eq!(count(&target, "sales").await, count(&source, "sales").await);
    source.close().await;
    target.close().await;
}
