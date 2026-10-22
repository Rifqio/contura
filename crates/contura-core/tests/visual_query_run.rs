//! Visual Queries run through the editor's path (5a check, Query History, paged result) on a
//! fresh database per test. Each Dialect builds its own fixture; models come from the golden
//! cases with the database (and, on PostgreSQL, the schema) set to the test's own.

mod common;

use std::sync::Arc;

use contura_core::Error;
use contura_core::connections::{ConnectionInput, ConnectionService, PasswordChange};
use contura_core::model::{Cell, ConnectionId, DialectKind, SslMode};
use contura_core::query::{ExecOutcome, HistoryFilter, Outcome, QuerySessionId};
use contura_core::secrets::MemorySecretStore;
use contura_core::store::AppStore;
use contura_core::visual_query::{ColumnTypes, VisualQuery};
use serde_json::{Value, json};

struct Live {
    _dir: tempfile::TempDir,
    svc: Arc<ConnectionService>,
    id: ConnectionId,
    s: QuerySessionId,
    kind: DialectKind,
    /// The Visual Query's database: the test database, or `main` on SQLite.
    database: String,
}

impl Live {
    async fn new(
        dir: tempfile::TempDir,
        input: ConnectionInput,
        database: String,
        session_db: Option<String>,
    ) -> Live {
        let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
        let svc = Arc::new(
            ConnectionService::new(store, Arc::new(MemorySecretStore::new()))
                .with_data_dir(common::data_dir()),
        );
        let kind = input.dialect;
        let saved = svc.save(input).await.unwrap();
        svc.open(saved.id).await.unwrap();
        let s = svc.open_query_session(saved.id, session_db).await.unwrap();
        Live {
            _dir: dir,
            svc,
            id: saved.id,
            s,
            kind,
            database,
        }
    }

    async fn close(self) {
        self.svc.close_query_session(self.s).await.ok();
        self.svc.close(self.id).await.ok();
    }

    async fn rows(&self, sql: &str) -> Vec<Vec<Cell>> {
        let run = self
            .svc
            .execute_sql(self.s, sql.to_string(), None)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e:?}"));
        rows_of(run.outcome)
    }

    /// A model with its database and schemas set for this test's server.
    fn model(&self, mut query: Value) -> VisualQuery {
        query["database"] = json!(self.database);
        if self.kind == DialectKind::Postgres {
            for t in query["tables"].as_array_mut().unwrap() {
                if t["schema"].is_null() {
                    t["schema"] = json!("public");
                }
            }
        }
        serde_json::from_value(query).unwrap()
    }

    /// A golden case's model and types, with the per-Dialect override where there is one.
    fn golden(&self, case: &str) -> (VisualQuery, ColumnTypes) {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/visual_query/golden");
        let own = dir.join(format!("{case}.{}.json", dialect_name(self.kind)));
        let path = if own.exists() {
            own
        } else {
            dir.join(format!("{case}.json"))
        };
        let file: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let types: ColumnTypes = serde_json::from_value(file["types"].clone()).unwrap();
        (self.model(file["query"].clone()), types)
    }

    fn history(&self) -> Vec<contura_core::query::HistoryEntry> {
        self.svc
            .query_history(
                Some(self.id),
                HistoryFilter {
                    search: None,
                    only: None,
                },
            )
            .unwrap()
    }
}

fn dialect_name(kind: DialectKind) -> &'static str {
    match kind {
        DialectKind::MySql => "mysql",
        DialectKind::Postgres => "postgres",
        DialectKind::Sqlite => "sqlite",
    }
}

fn rows_of(outcome: ExecOutcome) -> Vec<Vec<Cell>> {
    match outcome {
        ExecOutcome::Rows { rows, has_more, .. } => {
            assert!(!has_more, "fixture results fit one page");
            rows
        }
        other => panic!("expected rows, got {other:?}"),
    }
}

fn sorted(mut rows: Vec<Vec<Cell>>) -> Vec<Vec<Cell>> {
    rows.sort_by_key(|r| format!("{r:?}"));
    rows
}

fn value(c: &Cell) -> Option<&str> {
    match c {
        Cell::Null => None,
        Cell::Number { value } | Cell::Text { value, .. } => Some(value),
        other => panic!("unexpected cell {other:?}"),
    }
}

fn input(kind: DialectKind, name: &str) -> ConnectionInput {
    ConnectionInput {
        id: None,
        name: name.into(),
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
        production: false,
        read_only: false,
    }
}

/// Text quoted for this Dialect: double quotes, or backticks on MySQL.
fn q(kind: DialectKind, name: &str) -> String {
    match kind {
        DialectKind::MySql => format!("`{}`", name.replace('`', "``")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// The fixture, the same rows on every Dialect.
fn fixture_sql(kind: DialectKind) -> Vec<String> {
    let my = kind == DialectKind::MySql;
    let ts = if my { "datetime" } else { "timestamp" };
    let mut sql = vec![
        "CREATE TABLE regions (id int primary key, name varchar(40))".to_string(),
        "CREATE TABLE stores (id int primary key, name varchar(120), city varchar(60), \
         region_id int references regions(id))"
            .to_string(),
        format!(
            "CREATE TABLE customers (id int primary key, name varchar(80), {} varchar(20))",
            q(kind, "café")
        ),
        format!(
            "CREATE TABLE orders (id int primary key, store_id int references stores(id), \
             pickup_store_id int references stores(id), customer_id int references customers(id), \
             channel varchar(16), status varchar(16), total numeric(12,2), placed_at date, \
             note varchar(40), ref varchar(8), deleted_at {ts} null, paid boolean)"
        ),
        "CREATE TABLE menu_items (id int primary key, category varchar(40), store_id int, \
         name varchar(40))"
            .to_string(),
        "CREATE TABLE order_lines (order_id int, line_no int, primary key (order_id, line_no))"
            .to_string(),
        "CREATE TABLE shipments (order_id int, line_no int, shipped_at date, \
         primary key (order_id, line_no), \
         foreign key (order_id, line_no) references order_lines(order_id, line_no))"
            .to_string(),
        format!(
            "CREATE TABLE {} (id int primary key, {} varchar(10), {} varchar(20), {} varchar(10), \
             {} varchar(10), {} int)",
            q(kind, "order"),
            q(kind, "select"),
            q(kind, "First Name"),
            q(kind, "say \"hi\""),
            q(kind, "back`tick"),
            q(kind, "CustomerId"),
        ),
        format!(
            "CREATE TABLE {} (id int primary key, label varchar(20))",
            q(kind, "Odd Name")
        ),
        format!(
            "CREATE TABLE {} (id int primary key, {} varchar(10))",
            q(kind, "Mixed"),
            q(kind, "a\"b")
        ),
        "INSERT INTO regions VALUES (1, 'North'), (2, 'South'), (3, 'East')".to_string(),
        "INSERT INTO stores VALUES (1, 'Kemang', 'Jakarta', 1), (2, 'Dago', 'Bandung', 1), \
         (3, 'Tunjungan', 'Surabaya', 2), (4, 'Orphan', 'Medan', NULL)"
            .to_string(),
        "INSERT INTO customers VALUES (1, 'Ana', 'a'), (2, 'Budi', 'b'), (3, 'Citra', 'c')"
            .to_string(),
        format!(
            "INSERT INTO orders VALUES \
             (1, 1, 2, 1, 'app', 'late', 10.00, '2026-10-02', 'plain', '12', NULL, true), \
             (2, 1, 1, 2, 'kiosk', 'late', 25.50, '2026-10-05', '{backslash}', '7', NULL, false), \
             (3, 2, NULL, NULL, 'web', 'late', 40.00, '2026-10-03', 'w', '12', '2026-10-04 10:00:00', true), \
             (4, 2, 2, 3, 'app', 'it''s', 15.00, '2026-09-30', 'x', '12', NULL, false), \
             (5, 3, 1, 1, 'kiosk', 'late', 12.75, '2026-10-10', 'y', '12', NULL, true), \
             (6, 4, NULL, 2, 'app', 'late', 99.00, '2026-10-11', 'z', '3', NULL, false)",
            backslash = if my { "a\\\\b" } else { "a\\b" }
        ),
        "INSERT INTO menu_items VALUES (1, 'drinks', 1, 'Tea'), (2, 'food', 1, 'Rice'), \
         (3, 'food', 2, 'Noodle'), (4, 'snack', NULL, 'Chips')"
            .to_string(),
        "INSERT INTO order_lines VALUES (1, 1), (1, 2), (2, 1), (3, 1)".to_string(),
        "INSERT INTO shipments VALUES (1, 1, '2026-10-03'), (1, 2, '2026-10-04'), \
         (3, 1, '2026-10-05')"
            .to_string(),
        format!(
            "INSERT INTO {} VALUES (1, 'x', 'Ana', 'hi', 'b1', 1), (2, 'y', 'Budi', 'yo', 'b2', 2), \
             (3, 'x', 'Citra', 'hey', 'b3', 3)",
            q(kind, "order")
        ),
        format!(
            "INSERT INTO {} VALUES (1, 'one'), (2, 'two'), (3, 'three')",
            q(kind, "Odd Name")
        ),
        format!(
            "INSERT INTO {} VALUES (1, 'q'), (2, 'r'), (3, 'q')",
            q(kind, "Mixed")
        ),
    ];
    if kind == DialectKind::Postgres {
        // Names are case-sensitive here, so the `names` case's "Customers" is its own table.
        // `sales.orders` holds every order but 6, so a run that reads the wrong schema differs.
        sql.extend([
            "CREATE TABLE \"Customers\" (\"Id\" int primary key, \"café\" varchar(20))".to_string(),
            "INSERT INTO \"Customers\" VALUES (1, 'a'), (2, 'b'), (3, 'c')".to_string(),
            "CREATE SCHEMA sales".to_string(),
            "CREATE TABLE sales.orders (LIKE public.orders INCLUDING ALL)".to_string(),
            "INSERT INTO sales.orders SELECT * FROM public.orders WHERE id <> 6".to_string(),
        ]);
    }
    if kind == DialectKind::MySql {
        // The `names` case's model names "Customers". Windows servers fold table names, so
        // that is `customers`; a server with case-sensitive names (Linux, CI) gets a copy with
        // the same rows, so the hand-written query over `customers` still matches.
        sql.push("CREATE TABLE IF NOT EXISTS Customers AS SELECT * FROM customers".to_string());
    }
    if kind == DialectKind::Sqlite {
        // A computed view column has no declared type.
        sql.push(
            "CREATE VIEW order_counts AS SELECT store_id, count(*) AS n FROM orders \
             GROUP BY store_id"
                .to_string(),
        );
    }
    sql
}

/// The same query as each golden case, written by hand in another style.
fn hand_written(kind: DialectKind, case: &str) -> String {
    let full = kind != DialectKind::MySql;
    match case {
        "late_orders_by_store" => {
            let orders = if kind == DialectKind::Postgres {
                "sales.orders"
            } else {
                "orders"
            };
            format!(
                "SELECT st.name, st.city, COUNT(ord.id), SUM(ord.total) \
                 FROM {orders} ord INNER JOIN stores st ON ord.store_id = st.id \
                 LEFT OUTER JOIN customers cu ON ord.customer_id = cu.id \
                 WHERE ord.status = 'late' AND ord.placed_at >= '2026-10-01' \
                   AND ord.channel IN ('app','kiosk') \
                 GROUP BY st.name, st.city ORDER BY 3 DESC, 1 LIMIT 50"
            )
        }
        "inner_left_right_full" => {
            let (m_col, m_join) = if full {
                (
                    ", m.name",
                    " FULL OUTER JOIN menu_items m ON s.id = m.store_id",
                )
            } else {
                ("", "")
            };
            format!(
                "SELECT o.id, s.name, c.name, r.name{m_col} FROM orders o \
                 INNER JOIN stores s ON o.store_id = s.id \
                 LEFT OUTER JOIN customers c ON o.customer_id = c.id \
                 RIGHT OUTER JOIN regions r ON s.region_id = r.id{m_join}"
            )
        }
        "composite_on" => "SELECT l.order_id, l.line_no, sh.shipped_at FROM order_lines l \
             INNER JOIN shipments sh ON l.line_no = sh.line_no AND l.order_id = sh.order_id"
            .to_string(),
        "cross_join_groups" => "SELECT o.id, c.name, m.name, s2.name \
             FROM orders o JOIN stores s ON o.store_id = s.id, customers c, \
             menu_items m JOIN stores s2 ON m.store_id = s2.id"
            .to_string(),
        "literals" => {
            let (note, paid, id) = match kind {
                DialectKind::MySql => ("'a\\\\b'", "true", "o.id"),
                DialectKind::Postgres => ("'a\\b'", "true", "CAST(o.id AS text)"),
                DialectKind::Sqlite => ("'a\\b'", "1", "o.id"),
            };
            format!(
                "SELECT o.id FROM orders o WHERE \
                 (o.status = 'it''s' AND o.note <> {note} AND o.total > 12.5 AND o.id <= 5 \
                  AND o.ref = '12' AND o.channel IN ('app', 'kiosk, web') \
                  AND o.total BETWEEN 10 AND 20) \
                 OR (o.deleted_at IS NULL AND o.paid = {paid} AND o.status NOT LIKE '%test%' \
                  AND {id} LIKE '1%' AND o.channel NOT IN ('it''s', 'fax')) \
                 OR o.deleted_at IS NOT NULL"
            )
        }
        "names" => {
            let (customers, id) = if kind == DialectKind::Postgres {
                ("\"Customers\"", "\"Id\"")
            } else {
                ("customers", "id")
            };
            format!(
                "SELECT o.{sel}, o.{first}, o.{hi}, o.{tick}, c.{cafe}, c.{id} \
                 FROM {order} o INNER JOIN {customers} c ON o.{cid} = c.{id} \
                 WHERE o.{sel} = 'x' ORDER BY c.{id} DESC, o.{first}",
                sel = q(kind, "select"),
                first = q(kind, "First Name"),
                hi = q(kind, "say \"hi\""),
                tick = q(kind, "back`tick"),
                cafe = q(kind, "café"),
                order = q(kind, "order"),
                cid = q(kind, "CustomerId"),
            )
        }
        "odd_and_mixed" => format!(
            "SELECT n.label, m.{ab} FROM {odd} n JOIN {mixed} m ON n.id = m.id \
             WHERE m.{ab} = 'q'",
            ab = q(kind, "a\"b"),
            odd = q(kind, "Odd Name"),
            mixed = q(kind, "Mixed"),
        ),
        other => panic!("no hand-written query for {other}"),
    }
}

/// The fixture's names with a space and a quote, which no golden case reads.
fn odd_and_mixed() -> Value {
    json!({
        "version": 1, "database": null,
        "tables": [
            {"id": "t1", "schema": null, "name": "Odd Name", "alias": "n", "x": 0, "y": 0},
            {"id": "t2", "schema": null, "name": "Mixed", "alias": "m", "x": 300, "y": 0}
        ],
        "joins": [{"id": "j1", "left": "t1", "right": "t2", "kind": "inner",
                   "on": [{"leftColumn": "id", "rightColumn": "id"}]}],
        "columns": [
            {"table": "t1", "column": "label", "alias": null, "aggregate": null},
            {"table": "t2", "column": "a\"b", "alias": null, "aggregate": null}
        ],
        "filters": [{"joiner": "and", "table": "t2", "column": "a\"b", "op": "eq", "values": ["q"]}],
        "groupBy": {"kind": "auto"}, "orderBy": [], "limit": null, "distinct": false
    })
}

/// Stores and their order counts, sorted by the count's output name and then the plain
/// column's while customers also has a `name`: the plain column, written without AS, is
/// sorted by its qualified name (`ORDER BY count_id DESC, s.name`), since SQLite reads a
/// bare `name` as an ambiguous input column.
fn counts_by_store() -> Value {
    json!({
        "version": 1, "database": null,
        "tables": [
            {"id": "t1", "schema": null, "name": "orders", "alias": "o", "x": 0, "y": 0},
            {"id": "t2", "schema": null, "name": "stores", "alias": "s", "x": 300, "y": 0},
            {"id": "t3", "schema": null, "name": "customers", "alias": "c", "x": 300, "y": 200}
        ],
        "joins": [
            {"id": "j1", "left": "t1", "right": "t2", "kind": "inner",
             "on": [{"leftColumn": "store_id", "rightColumn": "id"}]},
            {"id": "j2", "left": "t1", "right": "t3", "kind": "left",
             "on": [{"leftColumn": "customer_id", "rightColumn": "id"}]}
        ],
        "columns": [
            {"table": "t2", "column": "name", "alias": null, "aggregate": null},
            {"table": "t1", "column": "id", "alias": null, "aggregate": "count"}
        ],
        "filters": [],
        "groupBy": {"kind": "auto"},
        "orderBy": [
            {"target": {"kind": "output", "index": 1}, "dir": "desc"},
            {"target": {"kind": "output", "index": 0}, "dir": "asc"}
        ],
        "limit": null, "distinct": false
    })
}

fn one_order(id: &str) -> Value {
    json!({
        "version": 1, "database": null,
        "tables": [{"id": "t1", "schema": null, "name": "orders", "alias": "o", "x": 0, "y": 0}],
        "joins": [],
        "columns": [
            {"table": "t1", "column": "id", "alias": null, "aggregate": null},
            {"table": "t1", "column": "status", "alias": null, "aggregate": null}
        ],
        "filters": [{"joiner": "and", "table": "t1", "column": "id", "op": "eq", "values": [id]}],
        "groupBy": {"kind": "auto"}, "orderBy": [], "limit": null, "distinct": false
    })
}

async fn golden_runs_match_hand_written(l: &Live) {
    let cases = [
        ("late_orders_by_store", true),
        ("inner_left_right_full", false),
        ("composite_on", false),
        ("cross_join_groups", false),
        ("literals", false),
        ("names", true),
        ("odd_and_mixed", false),
    ];
    for (case, ordered) in cases {
        let (query, types) = if case == "odd_and_mixed" {
            (l.model(odd_and_mixed()), ColumnTypes::new())
        } else {
            l.golden(case)
        };
        let run = l
            .svc
            .run_visual_query(l.s, query, types, None)
            .await
            .unwrap_or_else(|e| panic!("{case}: {e:?}"));
        let got = rows_of(run.execution.outcome);
        let want = l.rows(&hand_written(l.kind, case)).await;
        assert!(!want.is_empty(), "{case}: the fixture gives no rows");
        if ordered {
            assert_eq!(got, want, "{case}:\n{}", run.sql);
        } else {
            assert_eq!(sorted(got), sorted(want), "{case}:\n{}", run.sql);
        }
    }
    // Spot checks that the fixture exercises what each case is about.
    let (q, t) = l.golden("late_orders_by_store");
    let run = l.svc.run_visual_query(l.s, q, t, None).await.unwrap();
    let names: Vec<_> = rows_of(run.execution.outcome)
        .iter()
        .map(|r| value(&r[0]).unwrap().to_string())
        .collect();
    let want: &[&str] = if l.kind == DialectKind::Postgres {
        &["Kemang", "Tunjungan"]
    } else {
        &["Kemang", "Orphan", "Tunjungan"]
    };
    assert_eq!(names, want);
    let (q, t) = l.golden("inner_left_right_full");
    let run = l.svc.run_visual_query(l.s, q, t, None).await.unwrap();
    let rows = rows_of(run.execution.outcome);
    assert!(
        rows.iter()
            .any(|r| r[0] == Cell::Null && value(&r[3]) == Some("East")),
        "the RIGHT JOIN keeps a region with no store"
    );
    if l.kind != DialectKind::MySql {
        assert!(
            rows.iter()
                .any(|r| r[0] == Cell::Null && value(&r[4]) == Some("Chips")),
            "the FULL JOIN keeps a menu item with no store"
        );
    }
}

async fn order_by_output_name_with_auto_group_by_runs(l: &Live) {
    if l.kind == DialectKind::MySql {
        let mode = l.rows("SELECT @@SESSION.sql_mode").await;
        let mode = value(&mode[0][0]).unwrap_or_default().to_string();
        assert!(
            mode.contains("ONLY_FULL_GROUP_BY"),
            "the MySQL 8.0 default sql_mode has ONLY_FULL_GROUP_BY: {mode}"
        );
    }
    let query = l.model(counts_by_store());
    let run = l
        .svc
        .run_visual_query(l.s, query, ColumnTypes::new(), None)
        .await
        .unwrap();
    // Ruling V2: an output without its own alias sorts by its expression.
    assert!(
        run.sql.contains("GROUP BY s.name")
            && run.sql.contains("ORDER BY count(o.id) DESC, s.name"),
        "{}",
        run.sql
    );
    let first = rows_of(run.execution.outcome);
    // An output the user named sorts by that name, with the same rows.
    let mut named = counts_by_store();
    named["columns"][1]["alias"] = json!("order_count");
    let run = l
        .svc
        .run_visual_query(l.s, l.model(named), ColumnTypes::new(), None)
        .await
        .unwrap();
    assert!(
        run.sql.contains("ORDER BY order_count DESC, s.name"),
        "{}",
        run.sql
    );
    assert_eq!(rows_of(run.execution.outcome), first);
    let got: Vec<(String, String)> = first
        .iter()
        .map(|r| {
            (
                value(&r[0]).unwrap().to_string(),
                value(&r[1]).unwrap().to_string(),
            )
        })
        .collect();
    let want = [
        ("Dago", "2"),
        ("Kemang", "2"),
        ("Orphan", "1"),
        ("Tunjungan", "1"),
    ]
    .map(|(a, b)| (a.to_string(), b.to_string()));
    assert_eq!(got, want);
}

async fn text_literal_on_int_column_runs(l: &Live) {
    // Types not loaded yet: the value is written as text.
    let run = l
        .svc
        .run_visual_query(l.s, l.model(one_order("5")), ColumnTypes::new(), None)
        .await
        .unwrap();
    assert!(run.sql.contains("o.id = '5'"), "{}", run.sql);
    let rows = rows_of(run.execution.outcome);
    assert_eq!(rows.len(), 1);
    assert_eq!(value(&rows[0][0]), Some("5"));
    assert_eq!(value(&rows[0][1]), Some("late"));
}

fn like_on_id(op: &str) -> Value {
    let mut q = one_order("1%");
    q["filters"][0]["op"] = json!(op);
    q
}

fn integer_id() -> ColumnTypes {
    serde_json::from_value(json!({"t1": {"id": "integer"}})).unwrap()
}

async fn like_on_number_column_runs(l: &Live) {
    let column = if l.kind == DialectKind::Postgres {
        "o.id::text"
    } else {
        "o.id"
    };
    let run = l
        .svc
        .run_visual_query(l.s, l.model(like_on_id("like")), integer_id(), None)
        .await
        .unwrap();
    assert!(
        run.sql.contains(&format!("{column} LIKE '1%'")),
        "{}",
        run.sql
    );
    let ids: Vec<_> = rows_of(run.execution.outcome)
        .iter()
        .map(|r| value(&r[0]).unwrap().to_string())
        .collect();
    assert_eq!(ids, ["1"]);
    let run = l
        .svc
        .run_visual_query(l.s, l.model(like_on_id("notLike")), integer_id(), None)
        .await
        .unwrap();
    assert!(
        run.sql.contains(&format!("{column} NOT LIKE '1%'")),
        "{}",
        run.sql
    );
    assert_eq!(rows_of(run.execution.outcome).len(), 5);
}

async fn untyped_column_takes_a_number_bare(l: &Live) {
    if l.kind != DialectKind::Sqlite {
        return;
    }
    let model = json!({
        "version": 1, "database": null,
        "tables": [{"id": "t1", "schema": null, "name": "order_counts", "alias": "c", "x": 0, "y": 0}],
        "joins": [],
        "columns": [{"table": "t1", "column": "store_id", "alias": null, "aggregate": null}],
        "filters": [{"joiner": "and", "table": "t1", "column": "n", "op": "eq", "values": ["2"]}],
        "groupBy": {"kind": "auto"}, "orderBy": [], "limit": null, "distinct": false
    });
    let types: ColumnTypes =
        serde_json::from_value(json!({"t1": {"store_id": "", "n": ""}})).unwrap();
    let run = l
        .svc
        .run_visual_query(l.s, l.model(model.clone()), types.clone(), None)
        .await
        .unwrap();
    assert!(run.sql.contains("c.n = 2"), "{}", run.sql);
    let mut stores: Vec<_> = rows_of(run.execution.outcome)
        .iter()
        .map(|r| value(&r[0]).unwrap().to_string())
        .collect();
    stores.sort();
    assert_eq!(stores, ["1", "2"]);
    // A value typed in quotes stays text, which SQLite never finds equal to a number.
    let mut quoted = model;
    quoted["filters"][0]["values"] = json!(["'2'"]);
    let run = l
        .svc
        .run_visual_query(l.s, l.model(quoted), types, None)
        .await
        .unwrap();
    assert!(run.sql.contains("c.n = '2'"), "{}", run.sql);
    assert!(rows_of(run.execution.outcome).is_empty());
}

async fn a_changed_database_is_refused(l: &Live) {
    let mut query = l.model(one_order("1"));
    query.database = Some(format!("{}_elsewhere", l.database));
    let result = l
        .svc
        .run_visual_query(l.s, query, ColumnTypes::new(), None)
        .await;
    if l.kind == DialectKind::Sqlite {
        // SQLite's model names a scope, not the session's database.
        assert!(result.is_ok(), "{result:?}");
        return;
    }
    match result {
        Err(Error::InvalidInput(m)) => assert_eq!(m, "The tab's database changed. Run again."),
        other => panic!("expected the refusal, got {other:?}"),
    }
    assert!(l.history().is_empty());
}

async fn runs_without_a_pass(l: &Live) {
    let (query, types) = l.golden("late_orders_by_store");
    let run = l
        .svc
        .run_visual_query(l.s, query, types, None)
        .await
        .unwrap();
    assert!(!rows_of(run.execution.outcome).is_empty());
}

async fn history_entry_written(l: &Live) {
    let (query, types) = l.golden("late_orders_by_store");
    let run = l
        .svc
        .run_visual_query(l.s, query, types, None)
        .await
        .unwrap();
    let n = rows_of(run.execution.outcome).len() as u64;
    let h = l.history();
    assert_eq!(h.len(), 1, "{h:?}");
    assert_eq!(h[0].sql, run.sql);
    assert_eq!(h[0].outcome, Outcome::Ok);
    assert_eq!(h[0].rows, Some(n));
    assert!(!h[0].changed);
}

async fn run_returns_the_sql_it_ran(l: &Live) {
    let (query, types) = l.golden("late_orders_by_store");
    let preview = l
        .svc
        .visual_query_sql(l.id, query.clone(), types.clone())
        .unwrap();
    let run = l
        .svc
        .run_visual_query(l.s, query, types, None)
        .await
        .unwrap();
    assert_eq!(run.sql, preview.query.unwrap().sql);
}

async fn refusal_never_reaches_the_server(l: &Live) {
    let (mut query, types) = l.golden("late_orders_by_store");
    query.columns.clear();
    query.order_by.clear();
    let err = l
        .svc
        .run_visual_query(l.s, query, types, None)
        .await
        .unwrap_err();
    match err {
        Error::InvalidInput(m) => assert_eq!(m, "Tick at least one column."),
        other => panic!("expected InvalidInput, got {other:?}"),
    }
    assert!(l.history().is_empty());
}

/// One `#[tokio::test]` per shared body, each on its own fresh database.
macro_rules! live_tests {
    ($setup:ident) => {
        live_tests!(@one $setup, golden_runs_match_hand_written, false, false);
        live_tests!(@one $setup, order_by_output_name_with_auto_group_by_runs, false, false);
        live_tests!(@one $setup, text_literal_on_int_column_runs, false, false);
        live_tests!(@one $setup, like_on_number_column_runs, false, false);
        live_tests!(@one $setup, untyped_column_takes_a_number_bare, false, false);
        live_tests!(@one $setup, a_changed_database_is_refused, false, false);
        live_tests!(@named $setup, production_runs_without_a_pass, runs_without_a_pass, true, false);
        live_tests!(@named $setup, read_only_runs, runs_without_a_pass, false, true);
        live_tests!(@one $setup, history_entry_written, false, false);
        live_tests!(@one $setup, run_returns_the_sql_it_ran, false, false);
        live_tests!(@one $setup, refusal_never_reaches_the_server, false, false);
    };
    (@one $setup:ident, $name:ident, $production:expr, $read_only:expr) => {
        live_tests!(@named $setup, $name, $name, $production, $read_only);
    };
    (@named $setup:ident, $name:ident, $body:ident, $production:expr, $read_only:expr) => {
        #[tokio::test]
        async fn $name() {
            let (live, guard) = $setup($production, $read_only).await;
            super::$body(&live).await;
            live.close().await;
            guard.finish().await;
        }
    };
}

/// What a test drops once it passes; a failing test's database is dropped by `Drop`.
trait Finish {
    async fn finish(self);
}

impl Finish for () {
    async fn finish(self) {}
}

impl Finish for common::TestDb {
    async fn finish(self) {
        self.drop_db().await;
    }
}

impl Finish for common::pg::PgTestDb {
    async fn finish(self) {
        self.drop_db().await;
    }
}

mod mysql {
    use super::*;
    use common::TestDb;
    use mysql_async::prelude::Queryable;
    use mysql_async::{Opts, OptsBuilder, Pool};

    async fn setup(production: bool, read_only: bool) -> (Live, TestDb) {
        let db = TestDb::create().await;
        let opts: Opts = OptsBuilder::default()
            .ip_or_hostname(db.config.host.clone())
            .tcp_port(db.config.port)
            .user(Some(db.config.user.clone()))
            .pass(db.password.clone())
            .db_name(Some(db.name.clone()))
            .into();
        let pool = Pool::new(opts);
        let mut conn = pool.get_conn().await.expect("connect");
        for sql in fixture_sql(DialectKind::MySql) {
            conn.query_drop(&sql)
                .await
                .unwrap_or_else(|e| panic!("{sql}: {e}"));
        }
        drop(conn);
        pool.disconnect().await.ok();
        let live = Live::new(
            tempfile::tempdir().unwrap(),
            ConnectionInput {
                host: db.config.host.clone(),
                port: db.config.port,
                user: db.config.user.clone(),
                database: Some(db.name.clone()),
                password: PasswordChange::Set {
                    value: db.password.clone().unwrap(),
                },
                production,
                read_only,
                ..input(DialectKind::MySql, "my")
            },
            db.name.clone(),
            Some(db.name.clone()),
        )
        .await;
        (live, db)
    }

    live_tests!(setup);
}

mod postgres {
    use super::*;
    use common::pg::{PgTestDb, pg_admin_client};

    async fn setup(production: bool, read_only: bool) -> (Live, PgTestDb) {
        let db = PgTestDb::create().await;
        let admin = pg_admin_client(&db.name).await;
        for sql in fixture_sql(DialectKind::Postgres) {
            admin
                .batch_execute(&sql)
                .await
                .unwrap_or_else(|e| panic!("{sql}: {e}"));
        }
        drop(admin);
        let live = Live::new(
            tempfile::tempdir().unwrap(),
            ConnectionInput {
                host: db.config.host.clone(),
                port: db.config.port,
                user: db.config.user.clone(),
                database: Some(db.name.clone()),
                password: PasswordChange::Set {
                    value: db.password.clone().unwrap(),
                },
                production,
                read_only,
                ..input(DialectKind::Postgres, "pg")
            },
            db.name.clone(),
            None,
        )
        .await;
        (live, db)
    }

    live_tests!(setup);
}

mod sqlite {
    use super::*;

    async fn setup(production: bool, read_only: bool) -> (Live, ()) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("shop.sqlite");
        let conn = rusqlite::Connection::open(&file).unwrap();
        for sql in fixture_sql(DialectKind::Sqlite) {
            conn.execute_batch(&sql)
                .unwrap_or_else(|e| panic!("{sql}: {e}"));
        }
        drop(conn);
        let live = Live::new(
            dir,
            ConnectionInput {
                file: Some(file),
                production,
                read_only,
                ..input(DialectKind::Sqlite, "lite")
            },
            "main".into(),
            None,
        )
        .await;
        (live, ())
    }

    live_tests!(setup);
}
