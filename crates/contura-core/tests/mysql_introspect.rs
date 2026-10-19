mod common;

use common::TestDb;
use contura_core::dialect::connect;
use contura_core::model::{ObjectKind, ObjectPath};
use mysql_async::prelude::Queryable;
use mysql_async::{Opts, OptsBuilder, Pool};

async fn seed(db: &TestDb) {
    let opts: Opts = OptsBuilder::default()
        .ip_or_hostname(db.config.host.clone())
        .tcp_port(db.config.port)
        .user(Some(db.config.user.clone()))
        .pass(db.password.clone())
        .db_name(Some(db.name.clone()))
        .into();
    let pool = Pool::new(opts);
    let mut conn = pool.get_conn().await.expect("connect to test MySQL");
    for sql in [
        "CREATE TABLE items (id INT PRIMARY KEY)",
        "CREATE VIEW v_items AS SELECT id FROM items",
        "CREATE PROCEDURE p_noop() BEGIN END",
        "CREATE FUNCTION f_one() RETURNS INT DETERMINISTIC RETURN 1",
        "CREATE TRIGGER t_items BEFORE INSERT ON items FOR EACH ROW SET NEW.id = NEW.id",
    ] {
        conn.query_drop(sql)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    drop(conn);
    pool.disconnect().await.ok();
}

#[tokio::test]
async fn lists_test_database() {
    let db = TestDb::create().await;
    let dialect = connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    let names = dialect.list_databases().await.expect("list databases");
    assert!(names.contains(&db.name), "{names:?}");
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(names, sorted);
    dialect.disconnect().await.ok();
    db.drop_db().await;
}

#[tokio::test]
async fn lists_objects_in_kind_order() {
    let db = TestDb::create().await;
    seed(&db).await;
    let dialect = connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    let objects = dialect
        .list_objects(&db.name, None)
        .await
        .expect("list objects");
    let got: Vec<(ObjectKind, &str)> = objects.iter().map(|o| (o.kind, o.name.as_str())).collect();
    assert_eq!(
        got,
        vec![
            (ObjectKind::Table, "items"),
            (ObjectKind::View, "v_items"),
            (ObjectKind::Procedure, "p_noop"),
            (ObjectKind::Function, "f_one"),
            (ObjectKind::Trigger, "t_items"),
        ]
    );
    // Tables carry the server's size estimate; other kinds have none.
    for o in &objects {
        assert_eq!(o.bytes.is_some(), o.kind == ObjectKind::Table, "{}", o.name);
    }
    dialect.disconnect().await.ok();
    db.drop_db().await;
}

#[tokio::test]
async fn view_definition_contains_select() {
    let db = TestDb::create().await;
    seed(&db).await;
    let dialect = connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    let path = ObjectPath {
        database: db.name.clone(),
        schema: None,
        name: "v_items".into(),
    };
    let ddl = dialect
        .object_definition(ObjectKind::View, &path)
        .await
        .expect("definition");
    assert!(ddl.to_lowercase().contains("select"), "{ddl}");
    for (kind, name, needle) in [
        (ObjectKind::Table, "items", "create table"),
        (ObjectKind::Procedure, "p_noop", "procedure"),
        (ObjectKind::Function, "f_one", "function"),
        (ObjectKind::Trigger, "t_items", "trigger"),
    ] {
        let p = ObjectPath {
            database: db.name.clone(),
            schema: None,
            name: name.into(),
        };
        let ddl = dialect
            .object_definition(kind, &p)
            .await
            .expect("definition");
        assert!(ddl.to_lowercase().contains(needle), "{name}: {ddl}");
    }
    dialect.disconnect().await.ok();
    db.drop_db().await;
}

#[tokio::test]
async fn schemas_empty_for_mysql() {
    let db = TestDb::create().await;
    let dialect = connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    assert!(
        dialect
            .list_schemas(&db.name)
            .await
            .expect("schemas")
            .is_empty()
    );
    dialect.disconnect().await.ok();
    db.drop_db().await;
}

#[tokio::test]
async fn information_schema_lists_its_system_views() {
    let db = TestDb::create().await;
    let dialect = connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    let objects = dialect
        .list_objects("information_schema", None)
        .await
        .expect("list objects");
    assert!(
        objects
            .iter()
            .any(|o| o.kind == ObjectKind::View && o.name == "TABLES"),
        "{objects:?}"
    );
    dialect.disconnect().await.ok();
    db.drop_db().await;
}

#[tokio::test]
async fn tables_carry_a_row_estimate() {
    let db = TestDb::create().await;
    seed(&db).await;
    let opts: Opts = OptsBuilder::default()
        .ip_or_hostname(db.config.host.clone())
        .tcp_port(db.config.port)
        .user(Some(db.config.user.clone()))
        .pass(db.password.clone())
        .db_name(Some(db.name.clone()))
        .into();
    let pool = Pool::new(opts);
    let mut conn = pool.get_conn().await.expect("connect to test MySQL");
    for sql in [
        "INSERT INTO items (id) VALUES (1), (2), (3)",
        "ANALYZE TABLE items",
    ] {
        conn.query_drop(sql)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    drop(conn);
    pool.disconnect().await.ok();
    let dialect = connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    let objects = dialect.list_objects(&db.name, None).await.unwrap();
    let rows = |name: &str| objects.iter().find(|o| o.name == name).unwrap().rows;
    assert_eq!(rows("items"), Some(3));
    assert_eq!(rows("v_items"), None);
    assert_eq!(rows("p_noop"), None);
    dialect.disconnect().await.ok();
    db.drop_db().await;
}
