//! Runs each exported script against a fresh database, reads it back with
//! `schema_snapshot`, and checks the structure survived. Tests only: the
//! product never executes these scripts in step 3.

mod common;

use common::TestDb;
use common::pg::{PgTestDb, pg_admin_client};
use dbview_core::ddl::create_script;
use dbview_core::dialect::connect;
use dbview_core::model::{ConnectionConfig, DialectKind, SslMode};
use dbview_core::schema_model::*;
use mysql_async::prelude::Queryable;
use mysql_async::{Opts, OptsBuilder, Pool};

fn col(name: &str, type_name: &str) -> SmColumn {
    SmColumn {
        name: name.into(),
        type_name: type_name.into(),
        pk: false,
        increment: false,
        not_null: false,
        unique: false,
        default: None,
        note: None,
    }
}

fn ep(table: &str, column: &str) -> SmEndpoint {
    SmEndpoint {
        schema: None,
        table: table.into(),
        columns: vec![column.into()],
    }
}

/// Same shape as the unit-test model; `orders` comes first, so the script must reorder.
fn model(dialect: DialectKind) -> SchemaModel {
    let id = SmColumn {
        pk: true,
        increment: true,
        ..col("id", "integer")
    };
    SchemaModel {
        dialect,
        tables: vec![
            SmTable {
                schema: None,
                name: "orders".into(),
                alias: None,
                note: None,
                columns: vec![
                    id.clone(),
                    SmColumn {
                        not_null: true,
                        ..col("store_id", "integer")
                    },
                    SmColumn {
                        default: Some(SmDefault::String {
                            value: "new".into(),
                        }),
                        ..col("status", "varchar(10)")
                    },
                ],
                indexes: vec![SmIndex {
                    name: Some("ix_store".into()),
                    columns: vec!["store_id".into()],
                    unique: false,
                    pk: false,
                }],
            },
            SmTable {
                schema: None,
                name: "stores".into(),
                alias: None,
                note: Some("KFC stores".into()),
                columns: vec![
                    id,
                    SmColumn {
                        not_null: true,
                        unique: true,
                        ..col("name", "varchar(80)")
                    },
                ],
                indexes: vec![],
            },
        ],
        refs: vec![SmRef {
            name: None,
            from: ep("orders", "store_id"),
            to: ep("stores", "id"),
            on_delete: Some("CASCADE".into()),
            on_update: None,
        }],
        enums: vec![],
        skipped: vec![],
    }
}

/// Table name to (column name, pk) pairs, sorted, plus refs as (from table, to table, columns).
type Shape = (
    Vec<(String, Vec<(String, bool)>)>,
    Vec<(String, String, Vec<String>, Vec<String>)>,
);

fn shape(m: &SchemaModel) -> Shape {
    let mut tables: Vec<_> = m
        .tables
        .iter()
        .map(|t| {
            (
                t.name.clone(),
                t.columns.iter().map(|c| (c.name.clone(), c.pk)).collect(),
            )
        })
        .collect();
    tables.sort();
    let refs = m
        .refs
        .iter()
        .map(|r| {
            (
                r.from.table.clone(),
                r.to.table.clone(),
                r.from.columns.clone(),
                r.to.columns.clone(),
            )
        })
        .collect();
    (tables, refs)
}

#[tokio::test]
async fn round_trip_mysql() {
    let original = model(DialectKind::MySql);
    let script = create_script(&original).expect("script");
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
    for stmt in script.split("\n\n").filter(|s| !s.starts_with("--")) {
        conn.query_drop(stmt)
            .await
            .unwrap_or_else(|e| panic!("{stmt}: {e}"));
    }
    drop(conn);
    pool.disconnect().await.ok();
    let dialect = connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    let back = dialect
        .schema_snapshot(&db.name, None)
        .await
        .expect("snapshot");
    dialect.disconnect().await.ok();
    assert_eq!(shape(&back), shape(&original));
    db.drop_db().await;
}

#[tokio::test]
async fn round_trip_postgres() {
    let original = model(DialectKind::Postgres);
    let script = create_script(&original).expect("script");
    let db = PgTestDb::create().await;
    let admin = pg_admin_client(&db.name).await;
    admin.batch_execute(&script).await.expect("run script");
    drop(admin);
    let dialect = connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    let back = dialect
        .schema_snapshot(&db.name, Some("public"))
        .await
        .expect("snapshot");
    dialect.disconnect().await.ok();
    assert_eq!(shape(&back), shape(&original));
    db.drop_db().await;
}

#[tokio::test]
async fn round_trip_sqlite() {
    let original = model(DialectKind::Sqlite);
    let script = create_script(&original).expect("script");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rt.sqlite");
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(&script)
        .expect("run script");
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
    };
    let dialect = connect(&config, None).await.unwrap();
    let back = dialect.schema_snapshot("main", None).await.unwrap();
    dialect.disconnect().await.ok();
    assert_eq!(shape(&back), shape(&original));
}
