//! Live (M11, M8, M9): Filter by this value writes `= '<the text the grid shows>'`. That
//! text must find its own row: PostgreSQL `timestamptz` with microseconds (shown in UTC,
//! ISO whatever the database's DateStyle) and MySQL `DATETIME(6)`.

mod common;

use std::sync::Arc;

use contura_core::dialect::{Dialect, connect};
use contura_core::model::{Cell, ObjectPath, PageRequest};

fn text(cell: &Cell) -> String {
    match cell {
        Cell::Text { value, .. } | Cell::Number { value } => value.clone(),
        other => panic!("unexpected {other:?}"),
    }
}

async fn shown_then_filtered(
    db: &Arc<dyn Dialect>,
    table: ObjectPath,
    column: &str,
    quoted: &str,
) -> (String, usize) {
    let page = db
        .fetch_page(&PageRequest {
            table: table.clone(),
            page: 0,
            sort: None,
            filter: None,
        })
        .await
        .expect("page");
    let at = page.columns.iter().position(|c| c.name == column).unwrap();
    let shown = text(&page.rows[0][at]);
    let filtered = db
        .fetch_page(&PageRequest {
            table,
            page: 0,
            sort: None,
            filter: Some(format!("{quoted} = '{shown}'")),
        })
        .await
        .expect("filtered page");
    (shown, filtered.rows.len())
}

#[tokio::test]
async fn postgres_timestamptz_is_found_by_its_shown_text_in_any_datestyle() {
    let db = common::pg::PgTestDb::create().await;
    let admin = common::pg::pg_admin_client(&db.name).await;
    admin
        .batch_execute(&format!(
            "ALTER DATABASE \"{}\" SET DateStyle = 'SQL, DMY';
             CREATE TABLE public.ev (id int PRIMARY KEY, at timestamptz);
             INSERT INTO public.ev VALUES (1, '2026-10-01 09:14:07.123456+07'),
                 (2, '2026-10-01 09:14:07.123457+07');",
            db.name
        ))
        .await
        .unwrap();
    drop(admin);
    let dialect = connect(&db.config, db.password.as_deref()).await.unwrap();
    let table = ObjectPath {
        database: db.name.clone(),
        schema: Some("public".into()),
        name: "ev".into(),
    };
    let (shown, rows) = shown_then_filtered(&dialect, table, "at", "\"at\"").await;
    assert_eq!(shown, "2026-10-01 02:14:07.123456+00");
    assert_eq!(rows, 1);
    dialect.disconnect().await.ok();
    db.drop_db().await;
}

#[tokio::test]
async fn mysql_datetime6_is_found_by_its_shown_text() {
    use mysql_async::prelude::Queryable;
    let db = common::TestDb::create().await;
    let mut conn = common::backup_fixture::mysql_conn(&db, &db.name).await;
    for sql in [
        "CREATE TABLE ev (id int PRIMARY KEY, at datetime(6))",
        "INSERT INTO ev VALUES (1, '2026-10-01 09:14:07.123456'), (2, '2026-10-01 09:14:07.123457')",
    ] {
        conn.query_drop(sql).await.unwrap();
    }
    drop(conn);
    let dialect = connect(&db.config, db.password.as_deref()).await.unwrap();
    let table = ObjectPath {
        database: db.name.clone(),
        schema: None,
        name: "ev".into(),
    };
    let (shown, rows) = shown_then_filtered(&dialect, table, "at", "`at`").await;
    assert_eq!(shown, "2026-10-01 09:14:07.123456");
    assert_eq!(rows, 1);
    dialect.disconnect().await.ok();
    db.drop_db().await;
}

/// N1: the database's day order stays. A DMY database reads a typed `01/10/2026` as
/// 1 October in Contura's sessions too, while dates still come back as ISO text.
#[tokio::test]
async fn postgres_keeps_the_databases_day_order() {
    let db = common::pg::PgTestDb::create().await;
    let admin = common::pg::pg_admin_client(&db.name).await;
    admin
        .batch_execute(&format!(
            "ALTER DATABASE \"{}\" SET DateStyle = 'SQL, DMY';
             CREATE TABLE public.d (id int PRIMARY KEY, day date);
             INSERT INTO public.d VALUES (1, '2026-10-01'), (2, '2026-01-10');",
            db.name
        ))
        .await
        .unwrap();
    drop(admin);
    let dialect = connect(&db.config, db.password.as_deref()).await.unwrap();
    let page = dialect
        .fetch_page(&PageRequest {
            table: ObjectPath {
                database: db.name.clone(),
                schema: Some("public".into()),
                name: "d".into(),
            },
            page: 0,
            sort: None,
            filter: Some("\"day\" = '01/10/2026'".into()),
        })
        .await
        .expect("page");
    assert_eq!(page.rows.len(), 1);
    assert_eq!(text(&page.rows[0][0]), "1");
    assert_eq!(text(&page.rows[0][1]), "2026-10-01");
    dialect.disconnect().await.ok();
    db.drop_db().await;
}
