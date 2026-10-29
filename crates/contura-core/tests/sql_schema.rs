mod common;

use common::TestDb;
use common::pg::{PgTestDb, pg_admin_client};
use contura_core::dialect::connect;
use contura_core::model::{ConnectionConfig, DialectKind, SslMode};
use contura_core::schema_model::SmEndpoint;
use contura_core::sql_schema::{SqlSchema, SqlTable, SqlTableKind};
use mysql_async::prelude::Queryable;
use mysql_async::{Opts, OptsBuilder, Pool};

fn table<'a>(s: &'a SqlSchema, name: &str) -> &'a SqlTable {
    s.tables
        .iter()
        .find(|t| t.name == name)
        .unwrap_or_else(|| panic!("no table {name}"))
}

fn cols(t: &SqlTable) -> Vec<(&str, &str, bool)> {
    t.columns
        .iter()
        .map(|c| (c.name.as_str(), c.type_name.as_str(), c.pk))
        .collect()
}

fn orders_fk(schema: Option<&str>) -> (SmEndpoint, SmEndpoint) {
    (
        SmEndpoint {
            schema: schema.map(str::to_string),
            table: "orders".into(),
            columns: vec!["store_id".into()],
        },
        SmEndpoint {
            schema: schema.map(str::to_string),
            table: "stores".into(),
            columns: vec!["id".into()],
        },
    )
}

#[tokio::test]
async fn mysql_sql_schema_lists_tables_views_columns_and_fks() {
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
    for sql in [
        "CREATE TABLE stores (id INT PRIMARY KEY, name VARCHAR(80))",
        "CREATE TABLE orders (id INT PRIMARY KEY, store_id INT, total DECIMAL(10,2), \
         FOREIGN KEY (store_id) REFERENCES stores(id))",
        "CREATE VIEW v_totals AS SELECT store_id, sum(total) AS total FROM orders GROUP BY store_id",
        "CREATE TABLE `Order Items` (id INT PRIMARY KEY)",
    ] {
        conn.query_drop(sql)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    drop(conn);
    pool.disconnect().await.ok();

    let dialect = connect(&db.config, db.password.as_deref()).await.unwrap();
    let s = dialect.sql_schema(&db.name).await.unwrap();
    dialect.disconnect().await.ok();

    assert_eq!(s.search_path, vec![db.name.clone()]);
    assert_eq!(s.tables.len(), 4);
    assert_eq!(table(&s, "stores").kind, SqlTableKind::Table);
    assert_eq!(table(&s, "v_totals").kind, SqlTableKind::View);
    assert_eq!(
        table(&s, "stores").schema.as_deref(),
        Some(db.name.as_str())
    );
    // Windows MySQL lower-cases table names (lower_case_table_names=1).
    let items = s
        .tables
        .iter()
        .find(|t| t.name.eq_ignore_ascii_case("Order Items"));
    assert_eq!(items.expect("Order Items").columns.len(), 1);
    assert_eq!(
        cols(table(&s, "stores")),
        vec![("id", "int", true), ("name", "varchar(80)", false)]
    );
    assert_eq!(
        cols(table(&s, "orders")),
        vec![
            ("id", "int", true),
            ("store_id", "int", false),
            ("total", "decimal(10,2)", false)
        ]
    );
    let (from, to) = orders_fk(Some(&db.name));
    assert_eq!(s.fks.len(), 1);
    assert_eq!((s.fks[0].from.clone(), s.fks[0].to.clone()), (from, to));
    db.drop_db().await;
}

#[tokio::test]
async fn pg_sql_schema_lists_tables_views_columns_and_fks() {
    let db = PgTestDb::create().await;
    let admin = pg_admin_client(&db.name).await;
    admin
        .batch_execute(
            "CREATE TABLE public.stores (id int PRIMARY KEY, name text);
             CREATE TABLE public.orders (id int PRIMARY KEY, store_id int REFERENCES public.stores(id),
                 total numeric(10,2));
             CREATE VIEW public.v_totals AS SELECT store_id, sum(total) AS total FROM public.orders GROUP BY store_id;
             CREATE TABLE public.\"Order Items\" (id int PRIMARY KEY);
             CREATE SCHEMA sales;
             CREATE VIEW sales.v_all AS SELECT id FROM public.orders;",
        )
        .await
        .expect("seed");
    drop(admin);

    let dialect = connect(&db.config, db.password.as_deref()).await.unwrap();
    let s = dialect.sql_schema(&db.name).await.unwrap();
    dialect.disconnect().await.ok();

    assert_eq!(s.search_path, vec!["public".to_string()]);
    assert_eq!(s.tables.len(), 5);
    assert_eq!(table(&s, "stores").kind, SqlTableKind::Table);
    assert_eq!(table(&s, "v_totals").kind, SqlTableKind::View);
    assert_eq!(table(&s, "stores").schema.as_deref(), Some("public"));
    assert_eq!(table(&s, "Order Items").columns.len(), 1);
    assert_eq!(
        cols(table(&s, "stores")),
        vec![("id", "int4", true), ("name", "text", false)]
    );
    assert_eq!(
        cols(table(&s, "orders")),
        vec![
            ("id", "int4", true),
            ("store_id", "int4", false),
            ("total", "numeric", false)
        ]
    );
    let sales = table(&s, "v_all");
    assert_eq!(sales.schema.as_deref(), Some("sales"));
    assert_eq!(sales.kind, SqlTableKind::View);
    let (from, to) = orders_fk(Some("public"));
    assert_eq!(s.fks.len(), 1);
    assert_eq!((s.fks[0].from.clone(), s.fks[0].to.clone()), (from, to));
    db.drop_db().await;
}

#[tokio::test]
async fn pg_sql_schema_gives_enum_columns_their_labels_in_order() {
    let db = PgTestDb::create().await;
    let admin = pg_admin_client(&db.name).await;
    admin
        .batch_execute(
            "CREATE TYPE public.mood AS ENUM ('sad', 'it''s ok', 'a, b');
             ALTER TYPE public.mood ADD VALUE 'first' BEFORE 'sad';
             CREATE TABLE public.people (id int PRIMARY KEY, mood public.mood, name text);",
        )
        .await
        .expect("seed");
    drop(admin);

    let dialect = connect(&db.config, db.password.as_deref()).await.unwrap();
    let s = dialect.sql_schema(&db.name).await.unwrap();
    dialect.disconnect().await.ok();

    let people = table(&s, "people");
    let labels: Vec<(&str, Vec<&str>)> = people
        .columns
        .iter()
        .map(|c| {
            (
                c.name.as_str(),
                c.enum_values.iter().map(String::as_str).collect(),
            )
        })
        .collect();
    assert_eq!(
        labels,
        vec![
            ("id", vec![]),
            ("mood", vec!["first", "sad", "it's ok", "a, b"]),
            ("name", vec![]),
        ]
    );
    db.drop_db().await;
}

#[tokio::test]
async fn sqlite_sql_schema_lists_tables_views_columns_and_fks() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("shop.sqlite");
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE stores (id INTEGER PRIMARY KEY, name TEXT);
             CREATE TABLE orders (id INTEGER PRIMARY KEY, store_id INTEGER REFERENCES stores(id),
                 total NUMERIC(10,2));
             CREATE VIEW v_totals AS SELECT store_id, sum(total) AS total FROM orders GROUP BY store_id;
             CREATE TABLE \"Order Items\" (id INTEGER PRIMARY KEY);",
        )
        .unwrap();
    let config = ConnectionConfig {
        id: uuid::Uuid::new_v4(),
        name: "t".into(),
        dialect: DialectKind::Sqlite,
        host: String::new(),
        port: 0,
        user: String::new(),
        database: None,
        ssl: SslMode::Disable,
        group_id: None,
        file: Some(path),
        query_timeout_secs: None,
        ai_access: Default::default(),
        ai_sync: Default::default(),
        production: false,
        read_only: false,
    };
    let dialect = connect(&config, None).await.unwrap();
    let s = dialect.sql_schema("main").await.unwrap();

    assert_eq!(s.search_path, vec!["main".to_string()]);
    assert_eq!(s.tables.len(), 4);
    assert_eq!(table(&s, "stores").kind, SqlTableKind::Table);
    assert_eq!(table(&s, "v_totals").kind, SqlTableKind::View);
    assert_eq!(table(&s, "stores").schema.as_deref(), Some("main"));
    assert_eq!(table(&s, "Order Items").columns.len(), 1);
    assert_eq!(
        cols(table(&s, "stores")),
        vec![("id", "INTEGER", true), ("name", "TEXT", false)]
    );
    assert_eq!(
        cols(table(&s, "orders")),
        vec![
            ("id", "INTEGER", true),
            ("store_id", "INTEGER", false),
            ("total", "NUMERIC(10,2)", false)
        ]
    );
    let (from, to) = orders_fk(Some("main"));
    assert_eq!(s.fks.len(), 1);
    assert_eq!((s.fks[0].from.clone(), s.fks[0].to.clone()), (from, to));
}

fn fk_names(s: &SqlSchema) -> Vec<(String, Option<String>, Option<String>)> {
    let mut v: Vec<_> = s
        .fks
        .iter()
        .map(|f| {
            (
                f.from.table.to_lowercase(),
                f.name.clone(),
                f.comment.clone(),
            )
        })
        .collect();
    v.sort();
    v
}

#[tokio::test]
async fn mysql_fks_carry_their_constraint_names() {
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
    for sql in [
        "CREATE TABLE stores (id INT PRIMARY KEY)",
        "CREATE TABLE orders (id INT PRIMARY KEY, store_id INT, \
         CONSTRAINT fk_order_store FOREIGN KEY (store_id) REFERENCES stores(id))",
        "CREATE TABLE refunds (id INT PRIMARY KEY, store_id INT, \
         FOREIGN KEY (store_id) REFERENCES stores(id))",
    ] {
        conn.query_drop(sql)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    drop(conn);
    pool.disconnect().await.ok();

    let dialect = connect(&db.config, db.password.as_deref()).await.unwrap();
    let s = dialect.sql_schema(&db.name).await.unwrap();
    dialect.disconnect().await.ok();
    // MySQL names an unnamed key itself; it has no comments on constraints.
    assert_eq!(
        fk_names(&s),
        vec![
            ("orders".into(), Some("fk_order_store".into()), None),
            ("refunds".into(), Some("refunds_ibfk_1".into()), None),
        ]
    );
    db.drop_db().await;
}

#[tokio::test]
async fn pg_fks_carry_their_constraint_names_and_comments() {
    let db = PgTestDb::create().await;
    let admin = pg_admin_client(&db.name).await;
    admin
        .batch_execute(
            "CREATE TABLE stores (id int PRIMARY KEY);
             CREATE TABLE orders (id int PRIMARY KEY, store_id int REFERENCES stores(id));
             CREATE TABLE refunds (id int PRIMARY KEY, store_id int,
                 CONSTRAINT \"Refund Store\" FOREIGN KEY (store_id) REFERENCES stores(id));
             COMMENT ON CONSTRAINT orders_store_id_fkey ON orders IS 'Where the order was placed';",
        )
        .await
        .expect("seed");
    drop(admin);

    let dialect = connect(&db.config, db.password.as_deref()).await.unwrap();
    let s = dialect.sql_schema(&db.name).await.unwrap();
    dialect.disconnect().await.ok();
    assert_eq!(
        fk_names(&s),
        vec![
            (
                "orders".into(),
                Some("orders_store_id_fkey".into()),
                Some("Where the order was placed".into())
            ),
            ("refunds".into(), Some("Refund Store".into()), None),
        ]
    );
    db.drop_db().await;
}

#[tokio::test]
async fn sqlite_fks_carry_their_constraint_names() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("shop.sqlite");
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE stores (id INTEGER PRIMARY KEY, code TEXT, UNIQUE (id, code));
             CREATE TABLE orders (id INTEGER PRIMARY KEY,
                 store_id INTEGER CONSTRAINT fk_order_store REFERENCES stores(id));
             CREATE TABLE refunds (id INTEGER PRIMARY KEY, store_id INTEGER REFERENCES stores(id));
             CREATE TABLE returns (id INTEGER PRIMARY KEY, store_id INTEGER, code TEXT,
                 CONSTRAINT \"Return Store\" FOREIGN KEY (store_id, code) REFERENCES stores (id, code));",
        )
        .unwrap();
    let config = ConnectionConfig {
        id: uuid::Uuid::new_v4(),
        name: "t".into(),
        dialect: DialectKind::Sqlite,
        host: String::new(),
        port: 0,
        user: String::new(),
        database: None,
        ssl: SslMode::Disable,
        group_id: None,
        file: Some(path),
        query_timeout_secs: None,
        ai_access: Default::default(),
        ai_sync: Default::default(),
        production: false,
        read_only: false,
    };
    let dialect = connect(&config, None).await.unwrap();
    let s = dialect.sql_schema("main").await.unwrap();
    // SQLite keeps a name only when the text gives one, and has no comments.
    assert_eq!(
        fk_names(&s),
        vec![
            ("orders".into(), Some("fk_order_store".into()), None),
            ("refunds".into(), None, None),
            ("returns".into(), Some("Return Store".into()), None),
        ]
    );
}

#[tokio::test]
async fn sqlite_fk_without_target_columns_points_at_the_parent_primary_key() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("shop.sqlite");
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT);
             CREATE TABLE prices (currency TEXT, product_id INTEGER, price NUMERIC,
                 PRIMARY KEY (product_id, currency));
             CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers);
             CREATE TABLE items (id INTEGER PRIMARY KEY, p INTEGER, c TEXT,
                 FOREIGN KEY (p, c) REFERENCES prices);",
        )
        .unwrap();
    let config = ConnectionConfig {
        id: uuid::Uuid::new_v4(),
        name: "t".into(),
        dialect: DialectKind::Sqlite,
        host: String::new(),
        port: 0,
        user: String::new(),
        database: None,
        ssl: SslMode::Disable,
        group_id: None,
        file: Some(path),
        query_timeout_secs: None,
        ai_access: Default::default(),
        ai_sync: Default::default(),
        production: false,
        read_only: false,
    };
    let dialect = connect(&config, None).await.unwrap();
    let s = dialect.sql_schema("main").await.unwrap();
    let to = |from: &str| {
        s.fks
            .iter()
            .find(|f| f.from.table == from)
            .unwrap_or_else(|| panic!("no key from {from}"))
            .to
            .columns
            .clone()
    };
    // `REFERENCES customers` names no column: it means the parent's primary key, in its key order.
    assert_eq!(to("orders"), vec!["id".to_string()]);
    assert_eq!(
        to("items"),
        vec!["product_id".to_string(), "currency".to_string()]
    );
}

/// SQLite keeps `REFERENCES Customers(ID)` as written but matches it without case: the key
/// names the parent and its columns as they are declared, and the child's columns too.
#[tokio::test]
async fn sqlite_fk_names_take_the_declared_case() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("shop.sqlite");
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT);
             CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER,
                 FOREIGN KEY (Customer_ID) REFERENCES Customers(ID));
             CREATE TABLE notes (id INTEGER PRIMARY KEY, ref INTEGER REFERENCES Nowhere(X));",
        )
        .unwrap();
    let config = ConnectionConfig {
        id: uuid::Uuid::new_v4(),
        name: "t".into(),
        dialect: DialectKind::Sqlite,
        host: String::new(),
        port: 0,
        user: String::new(),
        database: None,
        ssl: SslMode::Disable,
        group_id: None,
        file: Some(path),
        query_timeout_secs: None,
        ai_access: Default::default(),
        ai_sync: Default::default(),
        production: false,
        read_only: false,
    };
    let dialect = connect(&config, None).await.unwrap();
    let s = dialect.sql_schema("main").await.unwrap();
    let key = |from: &str| {
        s.fks
            .iter()
            .find(|f| f.from.table == from)
            .unwrap_or_else(|| panic!("no key from {from}"))
            .clone()
    };
    let orders = key("orders");
    assert_eq!(orders.to.table, "customers");
    assert_eq!(orders.to.columns, ["id"]);
    assert_eq!(orders.from.columns, ["customer_id"]);
    // A parent that does not exist keeps the name as written.
    let notes = key("notes");
    assert_eq!(notes.to.table, "Nowhere");
    assert_eq!(notes.to.columns, ["X"]);
}
