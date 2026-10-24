//! UX step 8 (security): the SQL string literals the UI writes into a filter (the shared
//! fixture, which the UI's escaper and `common.rs::sql_string` are both tested against)
//! find exactly the row holding that text on every Dialect, including Postgres with
//! `standard_conforming_strings` off, where `\'` would otherwise end a plain literal.

mod common;

use common::TestDb;
use common::pg::{PgTestDb, pg_admin_client};
use contura_core::dialect::{COUNT_TIMEOUT_MS, Dialect};
use contura_core::model::{
    Cell, ConnectionConfig, CountRequest, DialectKind, ObjectPath, PageRequest, RowCount, SslMode,
};
use contura_core::mysql::MySqlDialect;
use contura_core::postgres::PostgresDialect;
use contura_core::sqlite::SqliteDialect;
use mysql_async::prelude::Queryable;
use mysql_async::{Opts, OptsBuilder, Pool};

/// The fixture's values and their literals for one Dialect; values with a NUL are left
/// out, as Postgres refuses NUL in text.
fn cases(key: &str) -> Vec<(String, String)> {
    let doc: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/sql_string_cases.json")).unwrap();
    doc["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["value"].as_str().unwrap().to_string(),
                c[key].as_str().unwrap().to_string(),
            )
        })
        .filter(|(v, _)| !v.contains('\0'))
        .collect()
}

fn ids(page: &contura_core::model::Page) -> Vec<String> {
    page.rows
        .iter()
        .map(|r| match &r[0] {
            Cell::Number { value } => value.clone(),
            other => panic!("expected a number, got {other:?}"),
        })
        .collect()
}

/// Each value's literal, in a filter on `email`, finds its own row and only it, in a
/// page and in a count.
async fn finds_each_row_exactly(
    d: &dyn Dialect,
    table: ObjectPath,
    quote: fn(&str) -> String,
    key: &str,
) {
    let all = cases(key);
    for (i, (value, literal)) in all.iter().enumerate() {
        let filter = Some(format!("{} = {literal}", quote("email")));
        let page = d
            .fetch_page(&PageRequest {
                table: table.clone(),
                page: 0,
                sort: None,
                filter: filter.clone(),
            })
            .await
            .unwrap_or_else(|e| panic!("{key} {value:?}: {e:?}"));
        assert_eq!(
            ids(&page),
            vec![(i + 1).to_string()],
            "{key} {value:?} as {literal}"
        );
        let count = d
            .count_rows(
                &CountRequest {
                    table: table.clone(),
                    filter,
                },
                COUNT_TIMEOUT_MS,
            )
            .await
            .unwrap();
        assert_eq!(count, RowCount::Counted { rows: 1 }, "{key} {value:?}");
    }
}

fn dq(s: &str) -> String {
    format!("\"{s}\"")
}

fn bq(s: &str) -> String {
    format!("`{s}`")
}

#[tokio::test]
async fn pg_literals_hold_with_standard_conforming_strings_off() {
    let db = PgTestDb::create().await;
    let admin = pg_admin_client(&db.name).await;
    admin
        .batch_execute("CREATE TABLE public.people (id int PRIMARY KEY, email text)")
        .await
        .unwrap();
    for (i, (value, _)) in cases("postgres").iter().enumerate() {
        admin
            .execute(
                "INSERT INTO public.people VALUES ($1, $2)",
                &[&((i + 1) as i32), value],
            )
            .await
            .unwrap();
    }
    // Every new session of this database reads `\'` as an escaped quote in '...'.
    admin
        .batch_execute(&format!(
            "ALTER DATABASE \"{}\" SET standard_conforming_strings = off",
            db.name
        ))
        .await
        .unwrap();
    drop(admin);
    let d = PostgresDialect::connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    let table = ObjectPath {
        database: db.name.clone(),
        schema: Some("public".into()),
        name: "people".into(),
    };
    // The setting is in effect: a plain '...' literal of the value breaks out and matches
    // every row, which is what the E'..' form prevents.
    let plain = PageRequest {
        table: table.clone(),
        page: 0,
        sort: None,
        filter: Some(r#""email" = '\'' OR 1=1 --'"#.into()),
    };
    let leaked = d.fetch_page(&plain).await.unwrap();
    assert!(leaked.rows.len() > 1, "{:?}", ids(&leaked));
    finds_each_row_exactly(&d, table, dq, "postgres").await;
    drop(d);
    db.drop_db().await;
}

#[tokio::test]
async fn my_literals_find_the_exact_row() {
    let db = TestDb::create().await;
    let opts: Opts = OptsBuilder::default()
        .ip_or_hostname(db.config.host.clone())
        .tcp_port(db.config.port)
        .user(Some(db.config.user.clone()))
        .pass(db.password.clone())
        .db_name(Some(db.name.clone()))
        .into();
    let pool = Pool::new(opts);
    let mut conn = pool.get_conn().await.expect("connect to test MySQL");
    conn.query_drop(
        "CREATE TABLE people (id INT PRIMARY KEY, email VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin)",
    )
    .await
    .unwrap();
    for (i, (value, _)) in cases("mysql").iter().enumerate() {
        conn.exec_drop("INSERT INTO people VALUES (?, ?)", ((i + 1) as i32, value))
            .await
            .unwrap();
    }
    drop(conn);
    pool.disconnect().await.ok();
    let d = MySqlDialect::connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    let table = ObjectPath {
        database: db.name.clone(),
        schema: None,
        name: "people".into(),
    };
    finds_each_row_exactly(&d, table, bq, "mysql").await;
    drop(d);
    db.drop_db().await;
}

#[tokio::test]
async fn lite_literals_find_the_exact_row() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("s.sqlite");
    let conn = rusqlite::Connection::open(&file).unwrap();
    conn.execute_batch(
        "CREATE TABLE people (id INTEGER PRIMARY KEY, email TEXT);
         CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id);
         INSERT INTO orders VALUES (1, 214);",
    )
    .unwrap();
    for (i, (value, _)) in cases("sqlite").iter().enumerate() {
        conn.execute(
            "INSERT INTO people VALUES (?1, ?2)",
            ((i + 1) as i64, value),
        )
        .unwrap();
    }
    drop(conn);
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
        file: Some(file),
        query_timeout_secs: None,
        ai_access: Default::default(),
        ai_sync: Default::default(),
        production: false,
        read_only: false,
    };
    let d = SqliteDialect::connect(&config).await.expect("connect");
    let table = ObjectPath {
        database: "main".into(),
        schema: None,
        name: "people".into(),
    };
    finds_each_row_exactly(&d, table, dq, "sqlite").await;
    // A column with no type keeps 214 as an integer: only the number form matches it,
    // which is why the UI writes a number cell's key unquoted.
    let orders = ObjectPath {
        database: "main".into(),
        schema: None,
        name: "orders".into(),
    };
    let count = |filter: &str| CountRequest {
        table: orders.clone(),
        filter: Some(filter.into()),
    };
    assert_eq!(
        d.count_rows(&count("\"customer_id\" = 214"), COUNT_TIMEOUT_MS)
            .await
            .unwrap(),
        RowCount::Counted { rows: 1 }
    );
    assert_eq!(
        d.count_rows(&count("\"customer_id\" = '214'"), COUNT_TIMEOUT_MS)
            .await
            .unwrap(),
        RowCount::Counted { rows: 0 }
    );
}
