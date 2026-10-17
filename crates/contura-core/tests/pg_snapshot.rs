mod common;

use common::pg::{PgTestDb, pg_admin_client};
use contura_core::Error;
use contura_core::dialect::connect;
use contura_core::schema_model::{SchemaModel, SmEnum};

async fn fixture() -> (PgTestDb, SchemaModel) {
    let db = PgTestDb::create().await;
    let admin = pg_admin_client(&db.name).await;
    admin
        .batch_execute(
            "CREATE TYPE public.store_kind AS ENUM ('drive', 'mall');
             CREATE TABLE public.stores (id serial PRIMARY KEY, kind public.store_kind DEFAULT 'mall',
                 tags text[], total numeric(10,2) DEFAULT 0);
             CREATE TABLE public.orders (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                 store_id int REFERENCES public.stores(id) ON DELETE SET NULL);
             COMMENT ON TABLE public.stores IS 'KFC stores';
             CREATE VIEW public.v_orders AS SELECT id FROM public.orders;",
        )
        .await
        .expect("seed");
    drop(admin);
    let dialect = connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    let model = dialect
        .schema_snapshot(&db.name, Some("public"))
        .await
        .expect("snapshot");
    dialect.disconnect().await.ok();
    (db, model)
}

#[tokio::test]
async fn pg_snapshot_reads_enums_identity_arrays_and_refs() {
    let (db, model) = fixture().await;
    assert_eq!(
        model.enums,
        vec![SmEnum {
            schema: Some("public".into()),
            name: "store_kind".into(),
            values: vec!["drive".into(), "mall".into()],
        }]
    );
    let stores = model
        .tables
        .iter()
        .find(|t| t.name == "stores")
        .expect("stores");
    assert_eq!(stores.schema.as_deref(), Some("public"));
    assert_eq!(stores.note.as_deref(), Some("KFC stores"));
    let col = |n: &str| stores.columns.iter().find(|c| c.name == n).expect(n);
    assert!(col("id").pk && col("id").increment);
    assert_eq!(col("id").default, None);
    assert_eq!(col("tags").type_name, "text[]");
    assert_eq!(col("kind").type_name, "store_kind");
    let orders = model
        .tables
        .iter()
        .find(|t| t.name == "orders")
        .expect("orders");
    assert!(orders.columns[0].increment);
    assert_eq!(model.refs.len(), 1);
    assert_eq!(model.refs[0].on_delete.as_deref(), Some("SET NULL"));
    assert_eq!(model.refs[0].to.table, "stores");
    db.drop_db().await;
}

#[tokio::test]
async fn pg_snapshot_skips_and_reports_inexpressible() {
    let (db, model) = fixture().await;
    assert!(
        model.skipped.contains(&"view v_orders".to_string()),
        "{:?}",
        model.skipped
    );
    db.drop_db().await;
}

#[tokio::test]
async fn pg_snapshot_requires_schema() {
    let db = PgTestDb::create().await;
    let dialect = connect(&db.config, db.password.as_deref())
        .await
        .expect("connect");
    let err = dialect.schema_snapshot(&db.name, None).await.unwrap_err();
    assert!(
        matches!(err, Error::InvalidInput(ref m) if m == "choose a schema"),
        "{err:?}"
    );
    dialect.disconnect().await.ok();
    db.drop_db().await;
}
