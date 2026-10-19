//! Live: the structure writers on the Backup fixture per Dialect, read inside a snapshot
//! as the Backup job reads. Each test also runs the structure through step 7's script
//! reader into an empty database and reads it back: the same statements must come out.

mod common;

use common::TestDb;
use common::backup_fixture::{PG_SCHEMA, mysql_conn, mysql_fixture, pg_fixture, sqlite_fixture};
use common::pg::{PgTestDb, pg_admin_client};
use contura_core::backup::structure::StructureKind as K;
use contura_core::backup::structure::{
    StructureItem, StructureParts, mysql, postgres, sqlite, texts,
};
use contura_core::jobs::script::ScriptReader;
use contura_core::model::DialectKind;
use mysql_async::prelude::Queryable;

/// The structure as Restore reads it: the sections in file order, cut by step 7's reader.
fn split(parts: &StructureParts, dialect: DialectKind) -> Vec<String> {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("structure.sql");
    let all: Vec<&str> = parts
        .settings
        .iter()
        .chain(&parts.before_rows)
        .chain(&parts.after_rows)
        .chain(&parts.finish)
        .map(|i| i.sql.as_str())
        .collect();
    std::fs::write(&path, all.join("\n") + "\n").unwrap();
    let mut reader = ScriptReader::open(&path, dialect, true).unwrap();
    let mut out = Vec::new();
    while let Some(s) = reader.next_statement().unwrap() {
        out.push(s.text);
    }
    assert_eq!(out.len(), all.len(), "one statement per item: {out:#?}");
    out
}

fn sqls(items: &[StructureItem]) -> Vec<String> {
    items.iter().map(|i| i.sql.clone()).collect()
}

fn position(list: &[String], needle: &str) -> usize {
    list.iter()
        .position(|s| s.contains(needle))
        .unwrap_or_else(|| panic!("{needle} not in {list:#?}"))
}

#[tokio::test]
async fn mysql_structure_order_counts_and_round_trip() {
    let db = TestDb::create().await;
    mysql_fixture(&db).await;

    let mut conn = mysql_conn(&db, &db.name).await;
    conn.query_drop("SET SESSION sql_mode = 'ANSI_QUOTES'")
        .await
        .unwrap();
    conn.query_drop("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY")
        .await
        .unwrap();
    let parts = mysql::read_structure(&mut conn, &db.name).await.unwrap();
    conn.query_drop("COMMIT").await.unwrap();
    // It read with backticks whatever the session had, and put the session's mode back.
    let mode: Option<String> = conn.query_first("SELECT @@SESSION.sql_mode").await.unwrap();
    assert_eq!(mode.as_deref(), Some("ANSI_QUOTES"));
    assert!(
        parts
            .before_rows
            .iter()
            .all(|i| i.sql.starts_with("CREATE TABLE `"))
    );

    assert_eq!(parts.tables, ["audit", "customers", "orders"]);
    assert_eq!(parts.before_rows.len(), 3);
    let orders = &parts.before_rows[2];
    assert_eq!(
        (orders.kind, orders.table.as_deref()),
        (K::Table, Some("orders"))
    );
    assert!(orders.sql.starts_with("CREATE TABLE `orders`"));
    assert!(orders.sql.contains("AUTO_INCREMENT=6"));
    let a = &sqls(&parts.after_rows);
    let p_count = position(a, "PROCEDURE `p_count`");
    let f_double = position(a, "FUNCTION `f_double`");
    let v_base = position(a, "VIEW `v_base`");
    let a_top = position(a, "VIEW `a_top`");
    let v_doubled = position(a, "VIEW `v_doubled`");
    let trigger = position(a, "TRIGGER `orders_audit`");
    // Routines first: `v_doubled` calls `f_double`.
    assert!(p_count < f_double && f_double < v_base && v_base < a_top);
    assert!(a_top < v_doubled && v_doubled < trigger);
    assert!(a[p_count].starts_with("DELIMITER ;;\n") && a[p_count].ends_with(";;\nDELIMITER ;"));
    assert!(a[trigger].starts_with("DELIMITER ;;\n") && a[trigger].ends_with(";;\nDELIMITER ;"));
    // Each routine and trigger under the mode it was made with, the settings value between.
    assert!(a[p_count - 1].starts_with("SET sql_mode = '"), "{a:#?}");
    assert!(a[p_count - 1].contains("STRICT_TRANS_TABLES"));
    assert_eq!(a[v_base - 1], "SET sql_mode = 'NO_AUTO_VALUE_ON_ZERO';");
    assert!(a[trigger - 1].contains("STRICT_TRANS_TABLES"));
    assert_eq!(a.last().unwrap(), "SET sql_mode = 'NO_AUTO_VALUE_ON_ZERO';");
    assert_eq!(parts.after_rows[trigger].table.as_deref(), Some("orders"));
    assert!(parts.definer_removed);
    for s in a {
        assert!(!s.to_ascii_uppercase().contains("DEFINER=`"), "{s}");
        assert!(!s.contains(&db.name), "the database name stays out: {s}");
    }
    assert_eq!(parts.not_included, ["grants and roles"]);
    let c = parts.counts;
    assert_eq!(
        (c.tables, c.views, c.functions, c.procedures, c.triggers),
        (3, 3, 1, 1, 1)
    );
    assert_eq!(
        (
            c.indexes,
            c.foreign_keys,
            c.checks,
            c.generated,
            c.enums,
            c.sequences
        ),
        (6, 2, 1, 1, 1, 3)
    );

    // Into an empty database through the script reader: the same structure comes back.
    let copy = TestDb::create().await;
    let mut to = mysql_conn(&copy, &copy.name).await;
    for sql in split(&parts, DialectKind::MySql) {
        to.query_drop(sql.as_str())
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    let again = mysql::read_structure(&mut to, &copy.name).await.unwrap();
    assert_eq!(again.before_rows, parts.before_rows);
    assert_eq!(again.after_rows, parts.after_rows);
    assert_eq!(again.counts, parts.counts);
    // The view that calls the function works in the copy.
    let doubled: Vec<i64> = to
        .query("SELECT d FROM v_doubled ORDER BY d")
        .await
        .unwrap();
    assert!(doubled.is_empty());
    // The trigger did not fire: no rows were restored, and none were made.
    let audit: Option<u64> = to.query_first("SELECT COUNT(*) FROM audit").await.unwrap();
    assert_eq!(audit, Some(0));
    to.disconnect().await.ok();
    conn.disconnect().await.ok();
    copy.drop_db().await;
    db.drop_db().await;
}

#[tokio::test]
async fn postgres_structure_order_counts_and_round_trip() {
    let db = PgTestDb::create().await;
    let fixture = pg_fixture(&db).await;
    drop(fixture);

    let client = pg_admin_client(&db.name).await;
    client
        .batch_execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .await
        .unwrap();
    let parts = postgres::read_structure(&client, PG_SCHEMA).await.unwrap();
    client.batch_execute("COMMIT").await.unwrap();

    assert_eq!(parts.tables, ["audit", "customers", "orders"]);
    let b = &sqls(&parts.before_rows);
    assert_eq!(b[0], "CREATE SCHEMA IF NOT EXISTS \"billing\";");
    let mood = position(b, "CREATE TYPE \"billing\".\"mood\" AS ENUM ('ok', 'sad');");
    let ticket = position(b, "CREATE SEQUENCE \"billing\".\"ticket_seq\"");
    let serial = position(b, "CREATE SEQUENCE \"billing\".\"audit_id_seq\"");
    let audit_fn = position(b, "FUNCTION billing.audit_order()");
    let noop = position(b, "PROCEDURE billing.noop()");
    let audit = position(b, "CREATE TABLE \"billing\".\"audit\"");
    let orders = position(b, "CREATE TABLE \"billing\".\"orders\"");
    let owned = position(b, "ALTER SEQUENCE \"billing\".\"audit_id_seq\" OWNED BY");
    assert!(mood < serial && serial < ticket && ticket < audit_fn && audit_fn < noop);
    assert!(noop < audit && audit < orders && orders < owned);
    assert!(b[orders].contains("\"id\" bigint GENERATED ALWAYS AS IDENTITY"));
    assert!(b[orders].contains("GENERATED ALWAYS AS ((qty * 2)) STORED"));
    assert!(b[orders].contains("DEFAULT nextval('billing.ticket_seq'::regclass)"));
    assert!(
        b[position(b, "CREATE TABLE \"billing\".\"customers\"")]
            .contains("\"id\" bigint GENERATED BY DEFAULT AS IDENTITY")
    );
    assert!(b.contains(&"COMMENT ON TABLE \"billing\".\"orders\" IS 'all orders';".to_string()));
    for s in b {
        assert!(
            !s.contains("PRIMARY KEY") && !s.contains("REFERENCES"),
            "{s}"
        );
    }

    let a = &sqls(&parts.after_rows);
    let pk = position(a, "PRIMARY KEY");
    let check = position(a, "CHECK ((qty > 0))");
    let index = position(a, "CREATE INDEX orders_qty");
    let fk = position(a, "FOREIGN KEY");
    let v_base = position(a, "CREATE VIEW \"billing\".\"v_base\"");
    let a_top = position(a, "CREATE VIEW \"billing\".\"a_top\"");
    let trigger = position(a, "CREATE TRIGGER orders_audit");
    let setval = position(a, "pg_catalog.setval(");
    assert!(pk < check && check < index && index < fk && fk < v_base);
    assert!(v_base < a_top && a_top < trigger && trigger < setval);
    assert_eq!(
        &a[setval..],
        [
            "SELECT pg_catalog.setval('\"billing\".\"audit_id_seq\"', 5, true);",
            "SELECT pg_catalog.setval('\"billing\".\"customers_id_seq\"', 3, true);",
            "SELECT pg_catalog.setval('\"billing\".\"orders_id_seq\"', 5, true);",
            "SELECT pg_catalog.setval('\"billing\".\"ticket_seq\"', 104, true);",
        ]
    );
    assert!(
        parts
            .not_included
            .contains(&"domain billing.positive".to_string()),
        "{:?}",
        parts.not_included
    );
    for left_out in [
        "partitioned table billing.events",
        "partition billing.events_2026",
    ] {
        assert!(
            parts.not_included.contains(&left_out.to_string()),
            "{left_out}"
        );
    }
    // The partitioned table's identity and serial sequences are left out with it (R33).
    for s in b.iter().chain(a) {
        assert!(!s.contains("events_id_seq"), "{s}");
        assert!(!s.contains("events_n_seq"), "{s}");
    }
    let owned = &parts.before_rows[position(b, "OWNED BY")];
    assert_eq!(
        (owned.kind, owned.table.as_deref()),
        (K::OwnedBy, Some("audit"))
    );
    assert_eq!(parts.not_included.last().unwrap(), "grants and roles");
    let c = parts.counts;
    assert_eq!(
        (
            c.tables,
            c.indexes,
            c.foreign_keys,
            c.enums,
            c.sequences,
            c.views
        ),
        (3, 5, 2, 1, 2, 2)
    );
    assert_eq!(
        (c.functions, c.procedures, c.triggers, c.checks, c.generated),
        (2, 1, 1, 1, 1)
    );
    assert!(parts.finish.is_empty());

    // Into an empty database through the script reader: the same structure comes back.
    let copy = PgTestDb::create().await;
    let to = pg_admin_client(&copy.name).await;
    for sql in split(&parts, DialectKind::Postgres) {
        to.batch_execute(&sql)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    let again = postgres::read_structure(&to, PG_SCHEMA).await.unwrap();
    assert_eq!(again.before_rows, parts.before_rows);
    assert_eq!(again.after_rows, parts.after_rows);
    assert_eq!(again.counts, parts.counts);
    let audit: i64 = to
        .query_one("SELECT count(*) FROM billing.audit", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(audit, 0);
    drop(to);
    drop(client);
    copy.drop_db().await;
    db.drop_db().await;
}

#[tokio::test]
async fn sqlite_structure_order_counts_and_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fixture.sqlite");
    sqlite_fixture(&path);

    let conn =
        rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    conn.execute_batch("BEGIN").unwrap();
    let parts = sqlite::read_structure(&conn).unwrap();
    conn.execute_batch("COMMIT").unwrap();

    assert_eq!(texts(&parts.settings), ["PRAGMA foreign_keys = OFF;"]);
    assert_eq!(parts.tables, ["customers", "orders", "audit"]);
    assert!(
        parts.before_rows[1]
            .sql
            .starts_with("CREATE TABLE orders (id INTEGER PRIMARY KEY")
    );
    assert!(
        parts.before_rows[1]
            .sql
            .contains("GENERATED ALWAYS AS (qty * 2) STORED")
    );
    assert_eq!(
        texts(&parts.after_rows),
        [
            "DELETE FROM \"sqlite_sequence\" WHERE name = 'customers';",
            "INSERT INTO \"sqlite_sequence\" (name, seq) VALUES ('customers', 4);",
            "CREATE INDEX orders_qty ON orders (qty);",
            "CREATE VIEW v_base AS SELECT id, qty FROM orders WHERE qty > 1;",
            "CREATE VIEW a_top AS SELECT id FROM v_base;",
            "CREATE TRIGGER orders_audit AFTER INSERT ON orders\n        \
             BEGIN INSERT INTO audit (note) VALUES ('order ' || NEW.id); END;",
        ]
    );
    assert_eq!(texts(&parts.finish), ["PRAGMA user_version = 7;"]);
    assert_eq!(parts.not_included[0], "virtual table docs");
    assert!(
        parts.not_included[1..]
            .iter()
            .all(|s| s.starts_with("shadow table docs_")),
        "{:?}",
        parts.not_included
    );
    let c = parts.counts;
    assert_eq!(
        (
            c.tables,
            c.indexes,
            c.foreign_keys,
            c.sequences,
            c.views,
            c.triggers,
            c.checks,
            c.generated
        ),
        (3, 1, 2, 1, 2, 1, 2, 1)
    );

    // Into a new file through the script reader: the same structure comes back.
    let copy_path = dir.path().join("copy.sqlite");
    let to = rusqlite::Connection::open(&copy_path).unwrap();
    for sql in split(&parts, DialectKind::Sqlite) {
        to.execute_batch(&sql)
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    let again = sqlite::read_structure(&to).unwrap();
    assert_eq!(again.before_rows, parts.before_rows);
    assert_eq!(again.after_rows, parts.after_rows);
    assert_eq!(again.finish, parts.finish);
    assert!(again.not_included.is_empty());
}
