//! Live (M3): `Dialect::locate_row` finds a row's place in the page order (the sort, then
//! the primary key) among the rows matching the filter, on all three Dialects.

mod common;

use std::sync::Arc;

use contura_core::dialect::{COUNT_TIMEOUT_MS, Dialect, connect};
use contura_core::model::{
    Cell, ConnectionConfig, DialectKind, KeyPart, LocateRequest, ObjectPath, RowPlace, SortSpec,
    SslMode,
};

/// `items`: ids 1 to 5 named e, d, c, b, a.
const SEED: &[&str] = &[
    "CREATE TABLE items (id int PRIMARY KEY, name varchar(10))",
    "INSERT INTO items VALUES (1, 'e'), (2, 'd'), (3, 'c'), (4, 'b'), (5, 'a')",
];

fn req(
    table: ObjectPath,
    id: i64,
    sort: Option<(&str, bool)>,
    filter: Option<&str>,
) -> LocateRequest {
    LocateRequest {
        table,
        sort: sort.map(|(c, d)| SortSpec {
            column: c.into(),
            descending: d,
        }),
        filter: filter.map(str::to_string),
        key: vec![KeyPart {
            column: "id".into(),
            value: Cell::Number {
                value: id.to_string(),
            },
        }],
    }
}

async fn places(db: &Arc<dyn Dialect>, table: ObjectPath) {
    let at = |p: RowPlace| match p {
        RowPlace::Found { index } => Some(index),
        RowPlace::Missing => None,
        RowPlace::TimedOut => panic!("timed out"),
        RowPlace::Unsupported => panic!("the test servers have window functions"),
    };
    let go = |r: LocateRequest| {
        let db = db.clone();
        async move { at(db.locate_row(&r, COUNT_TIMEOUT_MS).await.expect("locate")) }
    };
    // No sort: the primary key's order.
    assert_eq!(go(req(table.clone(), 3, None, None)).await, Some(2));
    // By name: a(5) b(4) c(3) d(2) e(1).
    assert_eq!(
        go(req(table.clone(), 5, Some(("name", false)), None)).await,
        Some(0)
    );
    assert_eq!(
        go(req(table.clone(), 3, Some(("name", false)), None)).await,
        Some(2)
    );
    assert_eq!(
        go(req(table.clone(), 5, Some(("name", true)), None)).await,
        Some(4)
    );
    // The filter's rows only.
    assert_eq!(
        go(req(table.clone(), 3, None, Some("id > 2"))).await,
        Some(0)
    );
    assert_eq!(go(req(table.clone(), 1, None, Some("id > 2"))).await, None);
    // No such row.
    assert_eq!(go(req(table.clone(), 9, None, None)).await, None);
}

#[tokio::test]
async fn mysql_locates_rows() {
    use mysql_async::prelude::Queryable;
    let db = common::TestDb::create().await;
    let mut conn = common::backup_fixture::mysql_conn(&db, &db.name).await;
    for sql in SEED {
        conn.query_drop(*sql).await.unwrap();
    }
    drop(conn);
    let dialect = connect(&db.config, db.password.as_deref()).await.unwrap();
    let table = ObjectPath {
        database: db.name.clone(),
        schema: None,
        name: "items".into(),
    };
    places(&dialect, table).await;
    dialect.disconnect().await.ok();
    db.drop_db().await;
}

#[tokio::test]
async fn postgres_locates_rows() {
    let db = common::pg::PgTestDb::create().await;
    let admin = common::pg::pg_admin_client(&db.name).await;
    admin.batch_execute(&SEED.join(";")).await.unwrap();
    drop(admin);
    let dialect = connect(&db.config, db.password.as_deref()).await.unwrap();
    let table = ObjectPath {
        database: db.name.clone(),
        schema: Some("public".into()),
        name: "items".into(),
    };
    places(&dialect, table).await;
    dialect.disconnect().await.ok();
    db.drop_db().await;
}

#[tokio::test]
async fn sqlite_locates_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("items.sqlite");
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(&SEED.join(";"))
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
    let table = ObjectPath {
        database: "main".into(),
        schema: None,
        name: "items".into(),
    };
    places(&dialect, table).await;
}
