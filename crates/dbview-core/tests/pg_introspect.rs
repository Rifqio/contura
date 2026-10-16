mod common;

use common::pg::{PgTestDb, pg_admin_client};
use dbview_core::Error;
use dbview_core::dialect::{Dialect, connect};
use dbview_core::model::{ObjectKind, ObjectPath};
use std::sync::Arc;

async fn fixture() -> (PgTestDb, Arc<dyn Dialect>) {
    let db = PgTestDb::create().await;
    let admin = pg_admin_client(&db.name).await;
    admin
        .batch_execute(
            "CREATE SCHEMA sales;
             CREATE TABLE public.orders (id int PRIMARY KEY);
             CREATE TABLE sales.orders (id int PRIMARY KEY);
             CREATE TABLE public.stores (id int PRIMARY KEY);
             CREATE VIEW public.v_orders AS SELECT id FROM public.orders;
             CREATE MATERIALIZED VIEW sales.mv_totals AS SELECT count(*) AS n FROM sales.orders;
             CREATE FUNCTION public.add(a integer, b integer) RETURNS integer
                 LANGUAGE sql AS 'SELECT a + b';
             CREATE FUNCTION public.add(a numeric, b numeric) RETURNS numeric
                 LANGUAGE sql AS 'SELECT a + b + 0';
             CREATE PROCEDURE public.close_day() LANGUAGE sql AS 'SELECT 1';
             CREATE FUNCTION public.audit_fn() RETURNS trigger LANGUAGE plpgsql
                 AS 'BEGIN RETURN NEW; END';
             CREATE TRIGGER audit BEFORE INSERT ON public.orders
                 FOR EACH ROW EXECUTE FUNCTION public.audit_fn();
             CREATE TRIGGER audit BEFORE INSERT ON public.stores
                 FOR EACH ROW EXECUTE FUNCTION public.audit_fn();",
        )
        .await
        .expect("seed");
    drop(admin);
    let dialect = connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    (db, dialect)
}

fn path(db: &PgTestDb, schema: &str, name: &str) -> ObjectPath {
    ObjectPath {
        database: db.name.clone(),
        schema: Some(schema.into()),
        name: name.into(),
    }
}

#[tokio::test]
async fn lists_the_test_database() {
    let (db, dialect) = fixture().await;
    let names = dialect.list_databases().await.expect("databases");
    assert!(names.contains(&db.name), "{names:?}");
    assert!(!names.iter().any(|n| n == "template0" || n == "template1"));
    dialect.disconnect().await.ok();
    db.drop_db().await;
}

#[tokio::test]
async fn schemas_mark_system_ones() {
    let (db, dialect) = fixture().await;
    let schemas = dialect.list_schemas(&db.name).await.expect("schemas");
    let system = |name: &str| {
        schemas
            .iter()
            .find(|s| s.name == name)
            .unwrap_or_else(|| panic!("no schema {name}: {schemas:?}"))
            .is_system
    };
    assert!(!system("public"));
    assert!(!system("sales"));
    assert!(system("pg_catalog"));
    assert!(system("information_schema"));
    dialect.disconnect().await.ok();
    db.drop_db().await;
}

#[tokio::test]
async fn objects_in_public_in_order() {
    let (db, dialect) = fixture().await;
    let objects = dialect
        .list_objects(&db.name, Some("public"))
        .await
        .expect("objects");
    let got: Vec<(ObjectKind, &str)> = objects.iter().map(|o| (o.kind, o.name.as_str())).collect();
    assert_eq!(
        got,
        [
            (ObjectKind::Table, "orders"),
            (ObjectKind::Table, "stores"),
            (ObjectKind::View, "v_orders"),
            (ObjectKind::Procedure, "close_day()"),
            (ObjectKind::Function, "add(a integer, b integer)"),
            (ObjectKind::Function, "add(a numeric, b numeric)"),
            (ObjectKind::Function, "audit_fn()"),
            (ObjectKind::Trigger, "audit on orders"),
            (ObjectKind::Trigger, "audit on stores"),
        ]
    );
    dialect.disconnect().await.ok();
    db.drop_db().await;
}

#[tokio::test]
async fn overloads_and_repeated_trigger_names_list_separately() {
    let (db, dialect) = fixture().await;
    let def = |kind, name: &str| {
        let p = path(&db, "public", name);
        let dialect = dialect.clone();
        async move {
            dialect
                .object_definition(kind, &p)
                .await
                .expect("definition")
        }
    };
    let int_add = def(ObjectKind::Function, "add(a integer, b integer)").await;
    let num_add = def(ObjectKind::Function, "add(a numeric, b numeric)").await;
    assert_ne!(int_add, num_add);
    assert!(
        int_add.contains("a + b") && !int_add.contains("+ 0"),
        "{int_add}"
    );
    assert!(num_add.contains("+ 0"), "{num_add}");
    let proc = def(ObjectKind::Procedure, "close_day()").await;
    assert!(proc.contains("close_day"), "{proc}");
    let on_orders = def(ObjectKind::Trigger, "audit on orders").await;
    let on_stores = def(ObjectKind::Trigger, "audit on stores").await;
    assert!(on_orders.contains("ON orders"), "{on_orders}");
    assert!(on_stores.contains("ON stores"), "{on_stores}");
    dialect.disconnect().await.ok();
    db.drop_db().await;
}

#[tokio::test]
async fn view_definition_has_a_create_header() {
    let (db, dialect) = fixture().await;
    let ddl = dialect
        .object_definition(ObjectKind::View, &path(&db, "public", "v_orders"))
        .await
        .expect("definition");
    assert!(
        ddl.starts_with("CREATE VIEW \"public\".\"v_orders\" AS\n"),
        "{ddl}"
    );
    assert!(ddl.contains("orders"), "{ddl}");
    dialect.disconnect().await.ok();
    db.drop_db().await;
}

#[tokio::test]
async fn materialized_view_is_a_view_with_its_definition() {
    let (db, dialect) = fixture().await;
    let objects = dialect
        .list_objects(&db.name, Some("sales"))
        .await
        .expect("objects");
    assert!(
        objects
            .iter()
            .any(|o| o.kind == ObjectKind::View && o.name == "mv_totals"),
        "{objects:?}"
    );
    let ddl = dialect
        .object_definition(ObjectKind::View, &path(&db, "sales", "mv_totals"))
        .await
        .expect("definition");
    assert!(
        ddl.starts_with("CREATE MATERIALIZED VIEW \"sales\".\"mv_totals\" AS\n"),
        "{ddl}"
    );
    assert!(ddl.contains("count"), "{ddl}");
    dialect.disconnect().await.ok();
    db.drop_db().await;
}

#[tokio::test]
async fn missing_schema_is_invalid_input() {
    let (db, dialect) = fixture().await;
    let result = dialect.list_objects(&db.name, None).await;
    match result {
        Err(Error::InvalidInput(m)) => assert_eq!(m, "choose a schema"),
        other => panic!("got {other:?}"),
    }
    dialect.disconnect().await.ok();
    db.drop_db().await;
}

#[tokio::test]
async fn table_definition_is_invalid_input() {
    let (db, dialect) = fixture().await;
    let result = dialect
        .object_definition(ObjectKind::Table, &path(&db, "public", "orders"))
        .await;
    match result {
        Err(Error::InvalidInput(m)) => {
            assert_eq!(m, "Postgres table definitions are not available yet")
        }
        other => panic!("got {other:?}"),
    }
    dialect.disconnect().await.ok();
    db.drop_db().await;
}

#[tokio::test]
async fn unknown_object_is_not_found() {
    let (db, dialect) = fixture().await;
    let result = dialect
        .object_definition(ObjectKind::View, &path(&db, "public", "nope"))
        .await;
    assert!(matches!(result, Err(Error::NotFound(_))), "got {result:?}");
    dialect.disconnect().await.ok();
    db.drop_db().await;
}
