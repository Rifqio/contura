//! Live: a Foreign Key to a partitioned table is one key. PostgreSQL also stores a copy of it
//! per partition (`conparentid` set); every catalog read that lists keys leaves those out.

mod common;

use std::sync::Arc;

use common::pg::{PgTestDb, pg_admin_client};
use contura_core::backup::structure::postgres;
use contura_core::dialect::{Dialect, connect};
use contura_core::model::ObjectPath;

async fn fixture() -> (PgTestDb, Arc<dyn Dialect>) {
    let db = PgTestDb::create().await;
    let admin = pg_admin_client(&db.name).await;
    admin
        .batch_execute(
            "CREATE TABLE public.customers (id int PRIMARY KEY) PARTITION BY RANGE (id);
             CREATE TABLE public.customers_p1 PARTITION OF public.customers FOR VALUES FROM (0) TO (100);
             CREATE TABLE public.customers_p2 PARTITION OF public.customers FOR VALUES FROM (100) TO (200);
             CREATE TABLE public.orders (id int PRIMARY KEY,
                 customer_id int CONSTRAINT orders_customer_fk REFERENCES public.customers (id));
             CREATE TABLE public.lines (id int, customer_id int,
                 CONSTRAINT lines_customer_fk FOREIGN KEY (customer_id) REFERENCES public.customers (id))
                 PARTITION BY RANGE (id);
             CREATE TABLE public.lines_p1 PARTITION OF public.lines FOR VALUES FROM (0) TO (100);
             CREATE TABLE public.lines2 (id int, cid int,
                 CONSTRAINT lines2_cid_fk FOREIGN KEY (cid) REFERENCES public.customers_p1 (id))
                 PARTITION BY RANGE (id);
             CREATE TABLE public.lines2_p1 PARTITION OF public.lines2 FOR VALUES FROM (0) TO (100);",
        )
        .await
        .expect("seed");
    drop(admin);
    let dialect = connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    (db, dialect)
}

fn path(db: &PgTestDb, name: &str) -> ObjectPath {
    ObjectPath {
        database: db.name.clone(),
        schema: Some("public".into()),
        name: name.into(),
    }
}

#[tokio::test]
async fn a_key_to_a_partitioned_table_is_listed_once() {
    let (db, dialect) = fixture().await;

    let sql = dialect.sql_schema(&db.name).await.expect("sql schema");
    let fks: Vec<_> = sql
        .fks
        .iter()
        .map(|f| (f.from.table.as_str(), f.to.table.as_str()))
        .collect();
    // The grid of a partition opened by itself finds its key here; no copy points at a partition.
    assert_eq!(
        fks,
        [
            ("lines", "customers"),
            ("lines2", "customers_p1"),
            ("lines2_p1", "customers_p1"),
            ("lines_p1", "customers"),
            ("orders", "customers")
        ],
        "sql_schema"
    );

    let model = dialect
        .schema_snapshot(&db.name, Some("public"))
        .await
        .expect("snapshot");
    let refs: Vec<_> = model
        .refs
        .iter()
        .map(|r| (r.from.table.as_str(), r.to.table.as_str()))
        .collect();
    // The snapshot lists the parents only, so their keys only.
    assert_eq!(
        refs,
        [
            ("lines", "customers"),
            ("lines2", "customers_p1"),
            ("orders", "customers")
        ],
        "snapshot"
    );

    let orders = dialect
        .table_design(&path(&db, "orders"))
        .await
        .expect("orders design");
    assert_eq!(orders.foreign_keys.len(), 1, "{:?}", orders.foreign_keys);
    let customers = dialect
        .table_design(&path(&db, "customers"))
        .await
        .expect("customers design");
    // Referenced by orders and lines; the copy lines_p1 holds is not one more key.
    let by: Vec<&str> = customers
        .referenced_by
        .iter()
        .map(|r| r.table.name.as_str())
        .collect();
    assert_eq!(by, ["lines", "orders"], "{:?}", customers.referenced_by);
    // A partition opened by itself still shows the key it holds, in its design and DDL.
    let lines_p1 = dialect
        .table_design(&path(&db, "lines_p1"))
        .await
        .expect("referencing partition design");
    assert_eq!(
        lines_p1.foreign_keys.len(),
        1,
        "{:?}",
        lines_p1.foreign_keys
    );
    let p1_ddl = dialect
        .table_ddl(&path(&db, "lines_p1"))
        .await
        .expect("referencing partition ddl");
    assert_eq!(p1_ddl.matches("FOREIGN KEY").count(), 1, "{p1_ddl}");
    // N4: a partition of a table that references a leaf partition directly keeps that key.
    let lines2_p1 = dialect
        .table_design(&path(&db, "lines2_p1"))
        .await
        .expect("lines2_p1 design");
    assert_eq!(
        lines2_p1.foreign_keys.len(),
        1,
        "{:?}",
        lines2_p1.foreign_keys
    );
    let l2_ddl = dialect
        .table_ddl(&path(&db, "lines2_p1"))
        .await
        .expect("lines2_p1 ddl");
    assert_eq!(l2_ddl.matches("FOREIGN KEY").count(), 1, "{l2_ddl}");
    let part = dialect
        .table_design(&path(&db, "customers_p1"))
        .await
        .expect("partition design");
    // A referenced partition opened by itself lists each key that points at it once: not
    // the copy lines_p1 holds of lines' key.
    let by: Vec<&str> = part
        .referenced_by
        .iter()
        .map(|r| r.table.name.as_str())
        .collect();
    assert_eq!(
        by,
        ["lines", "lines2", "orders"],
        "{:?}",
        part.referenced_by
    );

    let ddl = dialect
        .table_ddl(&path(&db, "orders"))
        .await
        .expect("orders ddl");
    assert_eq!(ddl.matches("FOREIGN KEY").count(), 1, "{ddl}");

    let edges = dialect
        .key_edges(&db.name, Some("public"))
        .await
        .expect("key edges");
    assert_eq!(edges.len(), 3, "{edges:?}");

    let client = pg_admin_client(&db.name).await;
    let parts = postgres::read_structure(&client, "public").await.unwrap();
    let keys: Vec<&str> = parts
        .before_rows
        .iter()
        .chain(parts.after_rows.iter())
        .filter(|i| i.sql.contains("FOREIGN KEY"))
        .map(|i| i.sql.as_str())
        .collect();
    // Backup reads plain tables: orders' key, and none of the copies.
    assert_eq!(keys.len(), 1, "backup structure: {keys:?}");
    assert!(keys[0].contains("orders"), "{keys:?}");
    drop(client);

    dialect.disconnect().await.ok();
    db.drop_db().await;
}
