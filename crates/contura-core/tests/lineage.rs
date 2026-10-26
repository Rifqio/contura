//! Lineage from catalog details (step 6+, B2) live on MySQL, PostgreSQL and SQLite, and the
//! `table:` links of the diagrams folder.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::TestDb;
use common::pg::{PgTestDb, pg_admin_client};
use contura_core::connections::{ConnectionInput, ConnectionService, PasswordChange};
use contura_core::error::Error;
use contura_core::jobs::paths::{PathUse, check_user_path};
use contura_core::lineage::{
    Access, Direction, FlowProcess, FlowTableLink, LINEAGE_LAYOUT_MAX, Lineage,
    delete_lineage_layout, lineage_layout_path, list_flow_table_links, read_lineage_layout,
    write_lineage_layout,
};
use contura_core::model::{ConnectionId, DialectKind, ObjectPath, SslMode};
use contura_core::secrets::MemorySecretStore;
use contura_core::store::AppStore;

/// The fixture schema: customers <- orders (customer_id RESTRICT, store_id SET NULL) <-
/// order_lines CASCADE and shipments RESTRICT; line_notes -> order_lines by the composite
/// key (order_id, line_no), its columns written in the other order; employees refers to
/// itself; cyc_a and cyc_b refer to each other.
fn schema(kind: DialectKind) -> Vec<String> {
    let int = "INTEGER";
    let mut out = vec![
        format!(
            "CREATE TABLE customers (id {int} PRIMARY KEY, name VARCHAR(40), note VARCHAR(40))"
        ),
        format!("CREATE TABLE stores (id {int} PRIMARY KEY, city VARCHAR(40))"),
        format!(
            "CREATE TABLE orders (id {int} PRIMARY KEY, \
             customer_id {int} NOT NULL, store_id {int} NULL, total {int}, \
             FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT, \
             FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL)"
        ),
        format!(
            "CREATE TABLE order_lines (order_id {int} NOT NULL, line_no {int} NOT NULL, \
             qty {int}, PRIMARY KEY (order_id, line_no), \
             FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE)"
        ),
        format!(
            "CREATE TABLE shipments (id {int} PRIMARY KEY, order_id {int} NOT NULL, \
             FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT)"
        ),
        format!(
            "CREATE TABLE line_notes (id {int} PRIMARY KEY, note_line {int}, note_order {int}, \
             body VARCHAR(80), \
             FOREIGN KEY (note_order, note_line) REFERENCES order_lines(order_id, line_no))"
        ),
        format!(
            "CREATE TABLE employees (id {int} PRIMARY KEY, manager_id {int}, \
             FOREIGN KEY (manager_id) REFERENCES employees(id))"
        ),
    ];
    if kind == DialectKind::Sqlite {
        out.push(format!(
            "CREATE TABLE cyc_a (id {int} PRIMARY KEY, b_id {int} REFERENCES cyc_b(id))"
        ));
        out.push(format!(
            "CREATE TABLE cyc_b (id {int} PRIMARY KEY, a_id {int} REFERENCES cyc_a(id))"
        ));
    } else {
        out.push(format!(
            "CREATE TABLE cyc_a (id {int} PRIMARY KEY, b_id {int})"
        ));
        out.push(format!(
            "CREATE TABLE cyc_b (id {int} PRIMARY KEY, a_id {int}, \
             FOREIGN KEY (a_id) REFERENCES cyc_a(id))"
        ));
        out.push("ALTER TABLE cyc_a ADD FOREIGN KEY (b_id) REFERENCES cyc_b(id)".into());
    }
    out
}

struct Live {
    _dir: tempfile::TempDir,
    svc: Arc<ConnectionService>,
    id: ConnectionId,
    /// The table path with this Dialect's database and schema.
    at: Box<dyn Fn(&str) -> ObjectPath + Send + Sync>,
}

fn service(dir: &tempfile::TempDir) -> Arc<ConnectionService> {
    let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
    Arc::new(
        ConnectionService::new(store, Arc::new(MemorySecretStore::new()))
            .with_data_dir(common::data_dir()),
    )
}

fn input(dialect: DialectKind) -> ConnectionInput {
    ConnectionInput {
        id: None,
        name: "shop".into(),
        dialect,
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
        production: false,
        read_only: false,
    }
}

async fn open(svc: &ConnectionService, input: ConnectionInput) -> ConnectionId {
    let saved = svc.save(input).await.unwrap();
    svc.open(saved.id).await.unwrap();
    saved.id
}

async fn run_all(svc: &ConnectionService, id: ConnectionId, sqls: &[String]) {
    let s = svc.open_query_session(id, None).await.unwrap();
    for sql in sqls {
        svc.execute_sql(s, sql.clone(), None)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    svc.close_query_session(s).await.unwrap();
}

fn sqlite_db(sqls: &[String]) -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("shop.db");
    let conn = rusqlite::Connection::open(&file).unwrap();
    for sql in sqls {
        conn.execute_batch(sql)
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    (dir, file)
}

async fn sqlite_live(sqls: &[String]) -> Live {
    let (dir, file) = sqlite_db(sqls);
    let svc = service(&dir);
    let id = open(
        &svc,
        ConnectionInput {
            file: Some(file),
            ..input(DialectKind::Sqlite)
        },
    )
    .await;
    Live {
        _dir: dir,
        svc,
        id,
        at: Box::new(|name| ObjectPath {
            database: "main".into(),
            schema: None,
            name: name.into(),
        }),
    }
}

async fn mysql_live(db: &TestDb) -> Live {
    let dir = tempfile::tempdir().unwrap();
    let svc = service(&dir);
    let id = open(
        &svc,
        ConnectionInput {
            host: db.config.host.clone(),
            port: db.config.port,
            user: db.config.user.clone(),
            database: db.config.database.clone(),
            password: PasswordChange::Set {
                value: db.password.clone().unwrap(),
            },
            ..input(DialectKind::MySql)
        },
    )
    .await;
    run_all(&svc, id, &schema(DialectKind::MySql)).await;
    let database = db.name.clone();
    Live {
        _dir: dir,
        svc,
        id,
        at: Box::new(move |name| ObjectPath {
            database: database.clone(),
            schema: None,
            name: name.into(),
        }),
    }
}

/// A PostgreSQL service on `db`; the schema is created beforehand by the caller.
async fn pg_live(db: &PgTestDb) -> Live {
    let dir = tempfile::tempdir().unwrap();
    let svc = service(&dir);
    let id = open(
        &svc,
        ConnectionInput {
            host: db.config.host.clone(),
            port: db.config.port,
            user: db.config.user.clone(),
            database: db.config.database.clone(),
            password: PasswordChange::Set {
                value: db.password.clone().unwrap(),
            },
            ..input(DialectKind::Postgres)
        },
    )
    .await;
    let database = db.name.clone();
    Live {
        _dir: dir,
        svc,
        id,
        at: Box::new(move |name| ObjectPath {
            database: database.clone(),
            schema: Some("public".into()),
            name: name.into(),
        }),
    }
}

async fn pg_schema(db: &PgTestDb) {
    let client = pg_admin_client(&db.name).await;
    for sql in schema(DialectKind::Postgres) {
        client
            .batch_execute(&sql)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
}

impl Live {
    async fn lineage(&self, table: &str, depth: u8, direction: Direction) -> Lineage {
        self.svc
            .lineage(self.id, (self.at)(table), depth, direction)
            .await
            .unwrap_or_else(|e| panic!("lineage of {table}: {e}"))
    }

    async fn close(self) {
        self.svc.close(self.id).await.unwrap();
    }
}

/// `(name, distance)` of every table, sorted by name.
fn tables(l: &Lineage) -> Vec<(String, i32)> {
    let mut out: Vec<_> = l
        .tables
        .iter()
        .map(|t| (t.path.name.clone(), t.distance))
        .collect();
    out.sort();
    out
}

/// `from(cols)->to(cols)` of every link, sorted.
fn links(l: &Lineage) -> Vec<String> {
    let mut out: Vec<_> = l
        .links
        .iter()
        .map(|k| {
            format!(
                "{}({})->{}({})",
                k.from.name,
                k.from_columns.join(","),
                k.to.name,
                k.to_columns.join(",")
            )
        })
        .collect();
    out.sort();
    out
}

fn owned(v: &[(&str, i32)]) -> Vec<(String, i32)> {
    v.iter().map(|(n, d)| ((*n).to_string(), *d)).collect()
}

async fn check_depth_one_both(live: &Live) {
    let l = live.lineage("orders", 1, Direction::Both).await;
    assert_eq!(l.center, (live.at)("orders"));
    assert!(!l.truncated);
    assert_eq!(
        tables(&l),
        owned(&[
            ("customers", -1),
            ("order_lines", 1),
            ("orders", 0),
            ("shipments", 1),
            ("stores", -1),
        ])
    );
    assert_eq!(l.tables[0].path.name, "orders", "the center comes first");
    assert_eq!(
        links(&l),
        [
            "order_lines(order_id)->orders(id)",
            "orders(customer_id)->customers(id)",
            "orders(store_id)->stores(id)",
            "shipments(order_id)->orders(id)",
        ]
    );
    let link = |from: &str, to: &str| {
        l.links
            .iter()
            .find(|k| k.from.name == from && k.to.name == to)
            .unwrap()
    };
    assert_eq!(
        link("order_lines", "orders").on_delete.as_deref(),
        Some("CASCADE")
    );
    assert_eq!(
        link("orders", "stores").on_delete.as_deref(),
        Some("SET NULL")
    );
    assert!(link("orders", "stores").nullable);
    assert!(!link("orders", "customers").nullable);
    assert!(!link("shipments", "orders").nullable);

    let orders = l.tables.iter().find(|t| t.path.name == "orders").unwrap();
    assert_eq!(orders.column_count, 4);
    let cols: Vec<_> = orders
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c.pk, c.fk, c.nullable))
        .collect();
    assert_eq!(
        cols,
        [
            ("id", true, false, false),
            ("customer_id", false, true, false),
            ("store_id", false, true, true),
        ],
        "key and Foreign Key columns in table order"
    );
    assert!(orders.columns.iter().all(|c| !c.ty.is_empty()));
    let customers = l
        .tables
        .iter()
        .find(|t| t.path.name == "customers")
        .unwrap();
    assert_eq!(customers.column_count, 3);
    assert_eq!(customers.columns.len(), 1);

    let uses = live.lineage("orders", 1, Direction::Uses).await;
    assert_eq!(
        tables(&uses),
        owned(&[("customers", -1), ("orders", 0), ("stores", -1)])
    );
    let used_by = live.lineage("orders", 2, Direction::UsedBy).await;
    assert_eq!(
        tables(&used_by),
        owned(&[
            ("line_notes", 2),
            ("order_lines", 1),
            ("orders", 0),
            ("shipments", 1),
        ])
    );
}

async fn check_cycles_and_composite(live: &Live) {
    // A self-reference: one table, one link.
    let l = live.lineage("employees", 0, Direction::Both).await;
    assert_eq!(tables(&l), owned(&[("employees", 0)]));
    assert_eq!(links(&l), ["employees(manager_id)->employees(id)"]);
    assert!(l.links[0].nullable);

    // A cycle between two tables terminates, and each key is one link.
    let l = live.lineage("cyc_a", 0, Direction::Both).await;
    assert_eq!(tables(&l).len(), 2);
    assert_eq!(
        l.tables.iter().filter(|t| t.path.name == "cyc_b").count(),
        1
    );
    assert_eq!(
        links(&l),
        ["cyc_a(b_id)->cyc_b(id)", "cyc_b(a_id)->cyc_a(id)"]
    );

    // The composite key keeps its column order on both ends.
    let l = live.lineage("line_notes", 0, Direction::Uses).await;
    assert_eq!(
        tables(&l),
        owned(&[
            ("customers", -3),
            ("line_notes", 0),
            ("order_lines", -1),
            ("orders", -2),
            ("stores", -3),
        ])
    );
    let notes = l
        .links
        .iter()
        .find(|k| k.from.name == "line_notes")
        .unwrap();
    assert_eq!(notes.from_columns, ["note_order", "note_line"]);
    assert_eq!(notes.to_columns, ["order_id", "line_no"]);
    let card = |name: &str| l.tables.iter().find(|t| t.path.name == name).unwrap();
    let names =
        |name: &str| -> Vec<String> { card(name).columns.iter().map(|c| c.name.clone()).collect() };
    assert_eq!(names("line_notes"), ["id", "note_line", "note_order"]);
    assert_eq!(names("order_lines"), ["order_id", "line_no"]);
    assert!(card("order_lines").columns.iter().all(|c| c.pk));

    // Everything from orders: every table once, every link once, every column named.
    let l = live.lineage("orders", 0, Direction::Both).await;
    let mut seen = links(&l);
    let n = seen.len();
    seen.dedup();
    assert_eq!(seen.len(), n, "a link appears twice: {seen:?}");
    let mut names: Vec<_> = l.tables.iter().map(|t| t.path.name.clone()).collect();
    names.sort();
    let all = names.len();
    names.dedup();
    assert_eq!(names.len(), all, "a table appears twice");
    for k in &l.links {
        assert!(!k.from_columns.is_empty() && k.from_columns.len() == k.to_columns.len());
        assert!(
            k.from_columns
                .iter()
                .chain(&k.to_columns)
                .all(|c| !c.is_empty())
        );
    }
}

#[tokio::test]
async fn lineage_depth_one_both() {
    let live = sqlite_live(&schema(DialectKind::Sqlite)).await;
    check_depth_one_both(&live).await;
    live.close().await;

    let db = TestDb::create().await;
    let live = mysql_live(&db).await;
    check_depth_one_both(&live).await;
    live.close().await;
    db.drop_db().await;

    let db = PgTestDb::create().await;
    pg_schema(&db).await;
    let live = pg_live(&db).await;
    check_depth_one_both(&live).await;
    live.close().await;
    db.drop_db().await;
}

#[tokio::test]
async fn lineage_cycles_and_composite() {
    let live = sqlite_live(&schema(DialectKind::Sqlite)).await;
    check_cycles_and_composite(&live).await;
    live.close().await;

    let db = TestDb::create().await;
    let live = mysql_live(&db).await;
    check_cycles_and_composite(&live).await;
    live.close().await;
    db.drop_db().await;

    let db = PgTestDb::create().await;
    pg_schema(&db).await;
    let live = pg_live(&db).await;
    check_cycles_and_composite(&live).await;
    live.close().await;
    db.drop_db().await;
}

#[tokio::test]
async fn lineage_all_caps_at_300() {
    let mut sqls = vec!["CREATE TABLE t0 (id INTEGER PRIMARY KEY)".to_string()];
    for i in 1..320 {
        sqls.push(format!(
            "CREATE TABLE t{i} (id INTEGER PRIMARY KEY, prev INTEGER REFERENCES t{}(id))",
            i - 1
        ));
    }
    let live = sqlite_live(&[sqls.join(";\n")]).await;
    let l = live.lineage("t0", 0, Direction::UsedBy).await;
    assert!(l.truncated);
    assert_eq!(l.tables.len(), 300);
    assert_eq!(l.links.len(), 299);
    assert_eq!(l.tables.last().unwrap().distance, 299);

    let l = live.lineage("t0", 3, Direction::Both).await;
    assert!(!l.truncated);
    assert_eq!(l.tables.len(), 4);
    live.close().await;
}

/// Sequential and index scans of every user table, as the server's counters show them.
async fn pg_scans(client: &tokio_postgres::Client) -> i64 {
    client
        .batch_execute("SELECT pg_stat_clear_snapshot()")
        .await
        .unwrap();
    client
        .query_one(
            "SELECT COALESCE(SUM(seq_scan + COALESCE(idx_scan, 0)), 0)::bigint \
             FROM pg_stat_user_tables",
            &[],
        )
        .await
        .unwrap()
        .get(0)
}

/// The counters once they stop moving: other sessions report theirs when they end.
async fn pg_settled_scans(client: &tokio_postgres::Client) -> i64 {
    let mut last = pg_scans(client).await;
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(1100)).await;
        let now = pg_scans(client).await;
        if now == last {
            return now;
        }
        last = now;
    }
    panic!("the scan counters kept moving");
}

#[tokio::test]
async fn lineage_reads_no_rows() {
    let db = PgTestDb::create().await;
    pg_schema(&db).await;
    let watch = pg_admin_client(&db.name).await;
    let before = pg_settled_scans(&watch).await;

    let live = pg_live(&db).await;
    let l = live.lineage("orders", 0, Direction::Both).await;
    assert_eq!(l.tables.len(), 6);
    let svc = live.svc.clone();
    let id = live.id;
    live.close().await;
    assert_eq!(
        pg_settled_scans(&watch).await,
        before,
        "lineage scanned a user table"
    );

    // The counter does see a session that reads rows, so the check above can fail.
    svc.open(id).await.unwrap();
    let s = svc.open_query_session(id, None).await.unwrap();
    svc.execute_sql(s, "SELECT * FROM orders".into(), None)
        .await
        .unwrap();
    svc.close_query_session(s).await.unwrap();
    svc.close(id).await.unwrap();
    let mut seen = false;
    for _ in 0..20 {
        if pg_scans(&watch).await > before {
            seen = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(seen, "a row read never reached the scan counters");
    drop(watch);
    db.drop_db().await;
}

/// The lineage catalog reader's keys match the Table Designer's, table by table.
async fn check_edges_match_design(live: &Live) {
    let session = live.svc.session(live.id).await.unwrap();
    let at = (live.at)("orders");
    let edges = session
        .key_edges(&at.database, at.schema.as_deref())
        .await
        .unwrap();
    for table in [
        "customers",
        "stores",
        "orders",
        "order_lines",
        "shipments",
        "line_notes",
        "employees",
        "cyc_a",
        "cyc_b",
    ] {
        let design = live
            .svc
            .table_design(live.id, (live.at)(table))
            .await
            .unwrap();
        let mut want: Vec<_> = design
            .foreign_keys
            .iter()
            .map(|k| {
                (
                    k.columns.clone(),
                    k.target.clone(),
                    k.target_columns.clone(),
                    k.on_delete.clone(),
                    k.on_update.clone(),
                )
            })
            .collect();
        let mut got: Vec<_> = edges
            .iter()
            .filter(|e| e.from == (live.at)(table))
            .map(|e| {
                (
                    e.from_columns.clone(),
                    e.to.clone(),
                    e.to_columns.clone(),
                    e.on_delete.clone(),
                    e.on_update.clone(),
                )
            })
            .collect();
        want.sort_by(|a, b| format!("{a:?}").cmp(&format!("{b:?}")));
        got.sort_by(|a, b| format!("{a:?}").cmp(&format!("{b:?}")));
        assert_eq!(got, want, "the keys of {table}");
    }
}

#[tokio::test]
async fn key_edges_match_table_design() {
    let live = sqlite_live(&schema(DialectKind::Sqlite)).await;
    check_edges_match_design(&live).await;
    live.close().await;

    let db = TestDb::create().await;
    let live = mysql_live(&db).await;
    check_edges_match_design(&live).await;
    live.close().await;
    db.drop_db().await;

    let db = PgTestDb::create().await;
    pg_schema(&db).await;
    let live = pg_live(&db).await;
    check_edges_match_design(&live).await;
    live.close().await;
    db.drop_db().await;
}

#[tokio::test]
async fn lineage_missing_neighbour() {
    // SQLite takes a reference to a table that does not exist.
    let live = sqlite_live(&[
        "CREATE TABLE holder (id INTEGER PRIMARY KEY, gone_id INTEGER REFERENCES missing(id))"
            .to_string(),
    ])
    .await;
    let l = live.lineage("holder", 1, Direction::Both).await;
    assert_eq!(tables(&l), owned(&[("holder", 0), ("missing", -1)]));
    assert_eq!(links(&l), ["holder(gone_id)->missing(id)"]);
    let card = |name: &str| l.tables.iter().find(|t| t.path.name == name).unwrap();
    assert_eq!(card("holder").unreadable, None);
    assert!(
        card("missing")
            .unreadable
            .as_deref()
            .is_some_and(|r| !r.is_empty())
    );
    assert_eq!(card("missing").column_count, 0);
    assert_eq!(card("holder").column_count, 2);

    // The center itself missing still fails the call.
    let err = live
        .svc
        .lineage(live.id, (live.at)("nope"), 1, Direction::Both)
        .await;
    assert!(
        matches!(err, Err(contura_core::Error::NotFound(_))),
        "{err:?}"
    );
    live.close().await;
}

#[tokio::test]
async fn lineage_mixed_case_sqlite() {
    let live = sqlite_live(&[
        "CREATE TABLE customers (id INTEGER PRIMARY KEY)".to_string(),
        "CREATE TABLE orders (id INTEGER PRIMARY KEY, \
         customer_id INTEGER REFERENCES Customers(id), \
         again_id INTEGER REFERENCES CUSTOMERS(id))"
            .to_string(),
    ])
    .await;
    let l = live.lineage("customers", 1, Direction::UsedBy).await;
    assert_eq!(tables(&l), owned(&[("customers", 0), ("orders", 1)]));
    assert_eq!(
        links(&l),
        [
            "orders(again_id)->customers(id)",
            "orders(customer_id)->customers(id)",
        ]
    );
    // A center typed in another case: one card per table, in the real spelling.
    let l = live.lineage("ORDERS", 1, Direction::Uses).await;
    assert_eq!(tables(&l), owned(&[("customers", -1), ("orders", 0)]));
    assert_eq!(l.links.len(), 2);
    assert!(l.tables.iter().all(|t| t.unreadable.is_none()));
    live.close().await;
}

#[tokio::test]
async fn lineage_cross_schema_pg() {
    let db = PgTestDb::create().await;
    pg_schema(&db).await;
    let client = pg_admin_client(&db.name).await;
    client
        .batch_execute(
            "CREATE SCHEMA sales; \
             CREATE TABLE sales.returns (id INTEGER PRIMARY KEY, \
               order_id INTEGER REFERENCES public.orders(id)); \
             CREATE TABLE public.events (id INTEGER, order_id INTEGER REFERENCES orders(id)) \
               PARTITION BY RANGE (id); \
             CREATE TABLE public.events_1 PARTITION OF events FOR VALUES FROM (0) TO (100); \
             CREATE TABLE public.events_2 PARTITION OF events FOR VALUES FROM (100) TO (200);",
        )
        .await
        .unwrap();
    drop(client);
    let live = pg_live(&db).await;

    let l = live.lineage("orders", 1, Direction::UsedBy).await;
    assert_eq!(
        tables(&l),
        owned(&[
            ("events", 1),
            ("order_lines", 1),
            ("orders", 0),
            ("returns", 1),
            ("shipments", 1),
        ]),
        "partitions are not cards of their own"
    );
    let returns = l.tables.iter().find(|t| t.path.name == "returns").unwrap();
    assert_eq!(returns.path.schema.as_deref(), Some("sales"));
    assert!(returns.unreadable.is_none());

    let sales = |name: &str| ObjectPath {
        database: db.name.clone(),
        schema: Some("sales".into()),
        name: name.into(),
    };
    let l = live
        .svc
        .lineage(live.id, sales("returns"), 2, Direction::Uses)
        .await
        .unwrap();
    assert_eq!(
        tables(&l),
        owned(&[
            ("customers", -2),
            ("orders", -1),
            ("returns", 0),
            ("stores", -2),
        ])
    );
    assert_eq!(l.links.len(), 3);
    live.close().await;
    db.drop_db().await;
}

fn write(dir: &std::path::Path, name: &str, text: &str) {
    std::fs::write(dir.join(name), text).unwrap();
}

fn link(
    file: &str,
    node: &str,
    kind: &str,
    table: &str,
    access: Access,
    processes: &[(&str, Access)],
) -> FlowTableLink {
    FlowTableLink {
        file: file.into(),
        node: node.into(),
        kind: kind.into(),
        table: table.into(),
        frame: None,
        access,
        processes: processes
            .iter()
            .map(|(node, access)| FlowProcess {
                node: (*node).into(),
                access: *access,
            })
            .collect(),
    }
}

#[test]
fn flow_links_folder() {
    let data = tempfile::tempdir().unwrap();
    assert!(list_flow_table_links(data.path()).unwrap().is_empty());
    let dir = data.path().join("diagrams");
    std::fs::create_dir_all(&dir).unwrap();
    write(
        &dir,
        "checkout.flow",
        "diagram dfd \"Checkout\"\n\
         \n\
         Customer [entity]\n\
         Checkout [process, id: 1]\n\
         Orders [store, id: D1, table: shop.orders]\n\
         Ledger [store, table: shop.ledger]\n\
         Audit [store, table: shop.audit]\n\
         Unused [store, table: shop.unused]\n\
         \n\
         Payments {\n\
         \x20 \"Charge: card\" [process, id: 2]\n\
         }\n\
         \n\
         Customer > Checkout: order details\n\
         Checkout > Orders: new order\n\
         Orders --> Checkout: stock level\n\
         \"Charge: card\" > Ledger > Customer\n\
         Audit <> Checkout\n\
         Unused - Checkout\n",
    );
    write(
        &dir,
        "handover.flow",
        "diagram flow \"Handover\"\n\
         // Load [io, table: shop.not_a_node]\n\
         Start [start]\n\
         \"Read orders\" [io, table: \"shop.orders\"]\n\
         Start > \"Read orders\"\n\
         \"Read orders\" > Done\n",
    );
    // Not a diagram file: skipped.
    write(&dir, "notes.txt", "Orders [store, table: shop.orders]\n");

    let mut got = list_flow_table_links(data.path()).unwrap();
    got.sort_by(|a, b| (&a.file, &a.node).cmp(&(&b.file, &b.node)));
    assert_eq!(
        got,
        [
            // The process or step on the other end of each line; the entity Customer and the
            // start node are not processes.
            link(
                "checkout",
                "Audit",
                "store",
                "shop.audit",
                Access::Both,
                &[("Checkout", Access::Both)]
            ),
            link(
                "checkout",
                "Ledger",
                "store",
                "shop.ledger",
                Access::Both,
                &[("Charge: card", Access::Writes)]
            ),
            link(
                "checkout",
                "Orders",
                "store",
                "shop.orders",
                Access::Both,
                &[("Checkout", Access::Both)]
            ),
            link(
                "handover",
                "Read orders",
                "io",
                "shop.orders",
                Access::Both,
                // A flowchart's io node is itself the step that touches the table.
                &[("Read orders", Access::Both)]
            ),
        ]
    );
}

#[test]
fn flow_links_reads_and_writes() {
    let data = tempfile::tempdir().unwrap();
    let dir = data.path().join("diagrams");
    std::fs::create_dir_all(&dir).unwrap();
    write(
        &dir,
        "a.flow",
        "diagram dfd \"A\"\n\
         Ship [process]\n\
         Orders [store, table: shop.orders]\n\
         Out [store, table: shop.out]\n\
         Pack [process]\n\
         Orders > Ship\n\
         Ship > Out: new row\n\
         Orders > Pack > Out2\n\
         Orders > Ship\n",
    );
    let mut got = list_flow_table_links(data.path()).unwrap();
    got.sort_by(|a, b| a.node.cmp(&b.node));
    assert_eq!(
        got,
        [
            // Each process once, in the order its first line was written.
            link(
                "a",
                "Orders",
                "store",
                "shop.orders",
                Access::Reads,
                &[("Ship", Access::Reads), ("Pack", Access::Reads)]
            ),
            link(
                "a",
                "Out",
                "store",
                "shop.out",
                Access::Writes,
                &[("Ship", Access::Writes)]
            ),
        ]
    );
}

#[test]
fn a_step_with_a_table_names_itself() {
    let data = tempfile::tempdir().unwrap();
    let dir = data.path().join("diagrams");
    std::fs::create_dir_all(&dir).unwrap();
    write(
        &dir,
        "save.flow",
        "diagram flow \"Save\"\n\
         Validate [step]\n\
         \"Save order\" [io, table: shop.orders]\n\
         Load [table: shop.stock]\n\
         Validate > \"Save order\"\n\
         Load > Validate\n",
    );
    write(
        &dir,
        "dfd.flow",
        "diagram dfd \"D\"\n\
         Entry [entity]\n\
         Ship [process, table: shop.shipments]\n\
         Entry > Ship\n",
    );
    let mut got = list_flow_table_links(data.path()).unwrap();
    got.sort_by(|a, b| (&a.file, &a.node).cmp(&(&b.file, &b.node)));
    assert_eq!(
        got,
        [
            // A process with a table: names itself, not the entity on its line.
            link(
                "dfd",
                "Ship",
                "process",
                "shop.shipments",
                Access::Writes,
                &[("Ship", Access::Writes)]
            ),
            // An unkinded flowchart node is a step: itself, not Validate.
            link(
                "save",
                "Load",
                "step",
                "shop.stock",
                Access::Reads,
                &[("Load", Access::Reads)]
            ),
            link(
                "save",
                "Save order",
                "io",
                "shop.orders",
                Access::Writes,
                &[("Save order", Access::Writes)]
            ),
        ]
    );
}

#[test]
fn lineage_layout_read_goes_through_the_guard() {
    let data = tempfile::tempdir().unwrap();
    let id = uuid::Uuid::new_v4();
    let orders = path_of("kestrel", Some("shop"), "orders");
    let file = lineage_layout_path(data.path(), id, &orders);
    // `.lineage` is a plain file, not a folder: the guard refuses, which reads as no layout.
    std::fs::create_dir_all(data.path().join("diagrams")).unwrap();
    std::fs::write(file.parent().unwrap(), LAYOUT).unwrap();
    assert_eq!(read_lineage_layout(data.path(), id, &orders).unwrap(), None);
    std::fs::remove_file(file.parent().unwrap()).unwrap();
    // At most 1 MB: one byte over reads as no layout, exactly at the limit reads.
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let head = "{\"version\":1,\"cards\":{},\"pad\":\"";
    let fill = LINEAGE_LAYOUT_MAX - head.len() - 2;
    let at_limit = format!("{head}{}\"}}", "x".repeat(fill));
    assert_eq!(at_limit.len(), LINEAGE_LAYOUT_MAX);
    std::fs::write(&file, &at_limit).unwrap();
    assert_eq!(
        read_lineage_layout(data.path(), id, &orders)
            .unwrap()
            .map(|t| t.len()),
        Some(LINEAGE_LAYOUT_MAX)
    );
    std::fs::write(&file, format!("{at_limit} ")).unwrap();
    assert_eq!(read_lineage_layout(data.path(), id, &orders).unwrap(), None);
}

#[test]
fn flow_processes_are_bounded_and_skip_stores() {
    let data = tempfile::tempdir().unwrap();
    let dir = data.path().join("diagrams");
    std::fs::create_dir_all(&dir).unwrap();
    let mut text = String::from(
        "diagram dfd \"Big\"\nOrders [store, table: shop.orders]\nArchive [store, table: shop.archive]\nOrders > Archive\n",
    );
    for i in 0..100 {
        text.push_str(&format!("P{i} [process]\nP{i} > Orders\n"));
    }
    write(&dir, "big.flow", &text);
    let got = list_flow_table_links(data.path()).unwrap();
    let orders = got.iter().find(|l| l.node == "Orders").unwrap();
    // Another table node is not a process; at most 20 processes are named.
    assert_eq!(orders.processes.len(), 20);
    assert_eq!(orders.processes[0].node, "P0");
    assert!(orders.processes.iter().all(|p| p.access == Access::Writes));
    let archive = got.iter().find(|l| l.node == "Archive").unwrap();
    assert!(archive.processes.is_empty());
}

fn path_of(database: &str, schema: Option<&str>, name: &str) -> ObjectPath {
    ObjectPath {
        database: database.into(),
        schema: schema.map(str::to_string),
        name: name.into(),
    }
}

const LAYOUT: &str = "{\n  \"version\": 1,\n  \"cards\": {}\n}\n";

#[test]
fn lineage_layout_round_trip() {
    let data = tempfile::tempdir().unwrap();
    let id = uuid::Uuid::new_v4();
    let orders = path_of("kestrel", Some("shop"), "orders");
    assert_eq!(read_lineage_layout(data.path(), id, &orders).unwrap(), None);

    write_lineage_layout(data.path(), id, &orders, LAYOUT).unwrap();
    assert_eq!(
        read_lineage_layout(data.path(), id, &orders)
            .unwrap()
            .as_deref(),
        Some(LAYOUT)
    );

    // The file sits in <data>\diagrams\.lineage, named by a hash: no table name in it.
    let file = lineage_layout_path(data.path(), id, &orders);
    assert!(file.is_file());
    assert_eq!(
        file.parent().unwrap(),
        data.path().join("diagrams").join(".lineage")
    );
    let name = file.file_name().unwrap().to_str().unwrap().to_string();
    let stem = name.strip_suffix(".layout.json").unwrap();
    assert_eq!(stem.len(), 32);
    assert!(
        stem.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    );
    // Only that file: no partial or moved-aside file is left.
    assert_eq!(
        std::fs::read_dir(file.parent().unwrap()).unwrap().count(),
        1
    );
    // The diagram list and the table-link scan do not see it.
    assert!(
        contura_core::diagrams::list_diagrams(data.path())
            .unwrap()
            .is_empty()
    );
    assert!(list_flow_table_links(data.path()).unwrap().is_empty());

    // Another table, schema, database or Connection is another file.
    for other in [
        lineage_layout_path(
            data.path(),
            id,
            &path_of("kestrel", Some("shop"), "orders2"),
        ),
        lineage_layout_path(
            data.path(),
            id,
            &path_of("kestrel", Some("sales"), "orders"),
        ),
        lineage_layout_path(data.path(), id, &path_of("other", Some("shop"), "orders")),
        lineage_layout_path(data.path(), id, &path_of("kestrel", None, "orders")),
        lineage_layout_path(data.path(), uuid::Uuid::new_v4(), &orders),
    ] {
        assert_ne!(other, file);
    }
    // A save replaces the file.
    let moved = "{\"version\":1,\"cards\":{\"t:x\":{\"x\":1,\"y\":2}}}";
    write_lineage_layout(data.path(), id, &orders, moved).unwrap();
    assert_eq!(
        read_lineage_layout(data.path(), id, &orders)
            .unwrap()
            .as_deref(),
        Some(moved)
    );

    // Reset removes it; removing a file that is not there is fine.
    delete_lineage_layout(data.path(), id, &orders).unwrap();
    assert!(!file.exists());
    assert_eq!(read_lineage_layout(data.path(), id, &orders).unwrap(), None);
    delete_lineage_layout(data.path(), id, &orders).unwrap();
}

#[test]
fn lineage_layout_names_never_leave_the_folder() {
    let data = tempfile::tempdir().unwrap();
    let id = uuid::Uuid::new_v4();
    let lineage_dir = data.path().join("diagrams").join(".lineage");
    for name in [
        "..\\..\\evil",
        "../../evil",
        "C:\\Windows\\evil",
        "CON",
        "a:b*c?",
        "",
        &"x".repeat(5000),
    ] {
        let p = path_of("..", Some("/etc"), name);
        let file = lineage_layout_path(data.path(), id, &p);
        assert_eq!(file.parent().unwrap(), lineage_dir, "{name}");
        write_lineage_layout(data.path(), id, &p, LAYOUT).unwrap();
        assert!(file.is_file(), "{name}");
    }
    let names: Vec<String> = std::fs::read_dir(data.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["diagrams"]);
}

#[test]
fn lineage_layout_refuses_what_is_not_a_layout() {
    let data = tempfile::tempdir().unwrap();
    let id = uuid::Uuid::new_v4();
    let orders = path_of("kestrel", Some("shop"), "orders");
    let big = format!(
        "{{\"version\":1,\"cards\":{{}},\"pad\":\"{}\"}}",
        "x".repeat(LINEAGE_LAYOUT_MAX)
    );
    for bad in [
        "not json",
        "[1, 2]",
        "{\"cards\":{}}",
        "{\"version\":2,\"cards\":{}}",
        big.as_str(),
    ] {
        match write_lineage_layout(data.path(), id, &orders, bad) {
            Err(Error::InvalidInput(_)) => {}
            other => panic!("{}: {other:?}", &bad[..bad.len().min(40)]),
        }
    }
    assert!(!lineage_layout_path(data.path(), id, &orders).exists());

    // A file too large or not a layout on disk reads as no layout.
    let file = lineage_layout_path(data.path(), id, &orders);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, &big).unwrap();
    assert_eq!(read_lineage_layout(data.path(), id, &orders).unwrap(), None);
}

#[test]
fn the_flow_guard_takes_only_lineage_layout_files() {
    let data = tempfile::tempdir().unwrap();
    let id = uuid::Uuid::new_v4();
    let orders = path_of("kestrel", Some("shop"), "orders");
    write_lineage_layout(data.path(), id, &orders, LAYOUT).unwrap();
    let file = lineage_layout_path(data.path(), id, &orders);
    check_user_path(&file, data.path(), PathUse::Flow).unwrap();

    let lineage_dir = file.parent().unwrap().to_path_buf();
    let diagrams = data.path().join("diagrams");
    std::fs::create_dir_all(diagrams.join("other")).unwrap();
    let hex = "0123456789abcdef0123456789abcdef";
    for bad in [
        lineage_dir.join("orders.layout.json"),
        lineage_dir.join(format!("{hex}.flow")),
        lineage_dir.join(format!("{hex}.json")),
        lineage_dir.join(format!("{}.layout.json", hex.to_uppercase())),
        lineage_dir.join(format!("{hex}0.layout.json")),
        diagrams.join("other").join(format!("{hex}.layout.json")),
        diagrams.join(format!("{hex}.layout.json")),
        data.path()
            .join(".lineage")
            .join(format!("{hex}.layout.json")),
    ] {
        assert!(
            matches!(
                check_user_path(&bad, data.path(), PathUse::Flow),
                Err(Error::InvalidInput(_))
            ),
            "{}",
            bad.display()
        );
    }
}

/// The views the catalog says read `table`, sorted.
async fn view_names(live: &Live, table: ObjectPath) -> (bool, Vec<String>, bool) {
    let deps = live
        .svc
        .view_dependencies(live.id, table)
        .await
        .unwrap_or_else(|e| panic!("view dependencies: {e}"));
    let mut names: Vec<String> = deps
        .views
        .iter()
        .map(|v| match &v.schema {
            Some(s) => format!("{s}.{}", v.name),
            None => format!("{}.{}", v.database, v.name),
        })
        .collect();
    names.sort();
    (deps.catalog, names, deps.capped)
}

#[tokio::test]
async fn view_dependencies_come_from_the_catalog() {
    // SQLite keeps no record: the UI falls back to the name match.
    let mut sqls = schema(DialectKind::Sqlite);
    sqls.push("CREATE VIEW daily AS SELECT count(*) AS n FROM orders".into());
    let live = sqlite_live(&sqls).await;
    let (catalog, names, _) = view_names(&live, (live.at)("orders")).await;
    assert!(!catalog);
    assert!(names.is_empty());
    live.close().await;

    let db = TestDb::create().await;
    let live = mysql_live(&db).await;
    run_all(
        &live.svc,
        live.id,
        &[
            "CREATE VIEW daily AS SELECT count(*) AS n FROM orders".into(),
            // Names orders only in text: no dependency.
            "CREATE VIEW mentions AS SELECT 'orders' AS note, id FROM customers".into(),
            "CREATE VIEW joined AS SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id"
                .into(),
        ],
    )
    .await;
    let (catalog, names, capped) = view_names(&live, (live.at)("orders")).await;
    let d = &db.name;
    assert!(catalog);
    assert_eq!(names, [format!("{d}.daily"), format!("{d}.joined")]);
    assert!(!capped);
    let (_, names, _) = view_names(&live, (live.at)("customers")).await;
    assert_eq!(names, [format!("{d}.joined"), format!("{d}.mentions")]);
    live.close().await;
    db.drop_db().await;

    let db = PgTestDb::create().await;
    pg_schema(&db).await;
    let client = pg_admin_client(&db.name).await;
    client
        .batch_execute(
            "CREATE VIEW daily AS SELECT count(*) AS n FROM orders; \
             CREATE VIEW mentions AS SELECT 'orders' AS note, id FROM customers; \
             CREATE SCHEMA sales; \
             CREATE TABLE sales.orders (id INTEGER PRIMARY KEY); \
             CREATE VIEW sales.big AS SELECT id FROM public.orders WHERE total > 100; \
             CREATE VIEW sales.own AS SELECT id FROM sales.orders; \
             CREATE MATERIALIZED VIEW sales.totals AS SELECT sum(total) AS t FROM public.orders; \
             CREATE VIEW on_daily AS SELECT n FROM daily;",
        )
        .await
        .unwrap();
    drop(client);
    let live = pg_live(&db).await;
    let (catalog, names, capped) = view_names(&live, (live.at)("orders")).await;
    assert!(catalog);
    // Views in other schemas count; a view on another schema's orders, or on a view, does not.
    assert_eq!(names, ["public.daily", "sales.big", "sales.totals"]);
    assert!(!capped);
    let sales_orders = ObjectPath {
        schema: Some("sales".into()),
        ..(live.at)("orders")
    };
    let (_, names, _) = view_names(&live, sales_orders).await;
    assert_eq!(names, ["sales.own"]);
    // A view's own dependencies: a view reading a view.
    let (_, names, _) = view_names(&live, (live.at)("daily")).await;
    assert_eq!(names, ["public.on_daily"]);
    live.close().await;
    db.drop_db().await;
}

#[tokio::test]
async fn view_dependencies_stop_at_200() {
    let db = PgTestDb::create().await;
    pg_schema(&db).await;
    let client = pg_admin_client(&db.name).await;
    client
        .batch_execute(
            "DO $$ BEGIN FOR i IN 1..205 LOOP \
               EXECUTE format('CREATE VIEW v%s AS SELECT id FROM orders', i); \
             END LOOP; END $$;",
        )
        .await
        .unwrap();
    drop(client);
    let live = pg_live(&db).await;
    let (catalog, names, capped) = view_names(&live, (live.at)("orders")).await;
    assert!(catalog);
    assert_eq!(names.len(), 200);
    assert!(capped);
    live.close().await;
    db.drop_db().await;
}
