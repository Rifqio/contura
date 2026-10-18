//! Live: ALTER plans against the real servers. The runner comes in Task 5, so
//! these send the planned statements themselves (PostgreSQL inside a transaction).

mod common;

use contura_core::design::{
    ColumnDraft, DesignEdit, DesignRequest, DesignTarget, TableDesign, plan_design,
};
use contura_core::model::{DialectKind, ObjectPath};

/// `ChangeColumn` of `name` with `edit` applied to the column as loaded.
fn change(base: &TableDesign, name: &str, edit: impl FnOnce(&mut ColumnDraft)) -> DesignEdit {
    let c = base
        .columns
        .iter()
        .find(|c| c.name == name)
        .expect("column");
    let mut column = ColumnDraft {
        name: c.name.clone(),
        type_sql: c.type_sql.clone(),
        nullable: c.nullable,
        default_sql: c.default_sql.clone(),
        increment: c.increment != contura_core::design::Increment::None,
        comment: c.comment.clone(),
    };
    edit(&mut column);
    DesignEdit::ChangeColumn {
        name: name.into(),
        column,
    }
}

fn alter(
    kind: DialectKind,
    base: &TableDesign,
    edits: Vec<DesignEdit>,
) -> contura_core::Result<Vec<String>> {
    plan_design(
        kind,
        &DesignRequest {
            target: DesignTarget::Alter { base: base.clone() },
            edits,
        },
    )
    .map(|p| p.statements)
}

mod pg {
    use super::*;
    use crate::common::pg::{PgTestDb, pg_admin_client};
    use contura_core::dialect::{Dialect, connect};
    use std::sync::Arc;
    use tokio_postgres::Client;

    async fn setup(seed: &str) -> (PgTestDb, Arc<dyn Dialect>, Client) {
        let db = PgTestDb::create().await;
        let admin = pg_admin_client(&db.name).await;
        admin.batch_execute(seed).await.expect("seed");
        let dialect = connect(&db.config, db.password.as_deref())
            .await
            .expect("connect");
        (db, dialect, admin)
    }

    fn path(db: &PgTestDb, name: &str) -> ObjectPath {
        ObjectPath {
            database: db.name.clone(),
            schema: Some("public".into()),
            name: name.into(),
        }
    }

    /// Runs the statements in one transaction; the first failure rolls back.
    async fn run(client: &Client, statements: &[String]) -> Result<(), String> {
        client.batch_execute("BEGIN").await.unwrap();
        for sql in statements {
            if let Err(e) = client.batch_execute(sql).await {
                client.batch_execute("ROLLBACK").await.unwrap();
                return Err(format!("{sql}: {e:?}"));
            }
        }
        client.batch_execute("COMMIT").await.unwrap();
        Ok(())
    }

    async fn finish(db: PgTestDb, dialect: Arc<dyn Dialect>) {
        dialect.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn narrowing_refuses_values_that_do_not_fit() {
        let (db, dialect, client) = setup(
            "CREATE TABLE public.t (id int PRIMARY KEY, v varchar(10));
             INSERT INTO public.t VALUES (1, 'abcdefgh');",
        )
        .await;
        // The explicit cast D10 used would have cut the value short.
        client.batch_execute("BEGIN").await.unwrap();
        client
            .batch_execute(
                "ALTER TABLE public.t ALTER COLUMN v TYPE varchar(5) USING v::varchar(5)",
            )
            .await
            .unwrap();
        let cut: String = client
            .query_one("SELECT v FROM public.t", &[])
            .await
            .unwrap()
            .get(0);
        assert_eq!(cut, "abcde");
        client.batch_execute("ROLLBACK").await.unwrap();

        let base = dialect.table_design(&path(&db, "t")).await.unwrap();
        let statements = alter(
            DialectKind::Postgres,
            &base,
            vec![change(&base, "v", |c| c.type_sql = "varchar(5)".into())],
        )
        .unwrap();
        let err = run(&client, &statements).await.unwrap_err();
        assert!(err.contains("too long"), "{err}");
        let row = client
            .query_one(
                "SELECT v, format_type(atttypid, atttypmod) FROM public.t, pg_attribute \
                 WHERE attrelid = 'public.t'::regclass AND attname = 'v'",
                &[],
            )
            .await
            .unwrap();
        assert_eq!(row.get::<_, String>(0), "abcdefgh");
        assert_eq!(row.get::<_, String>(1), "character varying(10)");

        // When every value fits, the same change applies.
        client
            .batch_execute("UPDATE public.t SET v = 'abc'")
            .await
            .unwrap();
        run(&client, &statements).await.unwrap();
        let after = dialect.table_design(&path(&db, "t")).await.unwrap();
        assert_eq!(after.columns[1].type_sql, "character varying(5)");
        let v: String = client
            .query_one("SELECT v FROM public.t", &[])
            .await
            .unwrap()
            .get(0);
        assert_eq!(v, "abc");
        drop(client);
        finish(db, dialect).await;
    }

    #[tokio::test]
    async fn a_change_across_families_refuses_values_that_do_not_fit() {
        let (db, dialect, client) = setup(
            "CREATE TABLE public.t (id int PRIMARY KEY, n integer);
             INSERT INTO public.t VALUES (1, 12345);",
        )
        .await;
        let base = dialect.table_design(&path(&db, "t")).await.unwrap();
        let statements = alter(
            DialectKind::Postgres,
            &base,
            vec![change(&base, "n", |c| c.type_sql = "varchar(3)".into())],
        )
        .unwrap();
        let err = run(&client, &statements).await.unwrap_err();
        assert!(err.contains("too long"), "{err}");
        let n: i32 = client
            .query_one("SELECT n FROM public.t", &[])
            .await
            .unwrap()
            .get(0);
        assert_eq!(n, 12345);

        client
            .batch_execute("UPDATE public.t SET n = 12")
            .await
            .unwrap();
        run(&client, &statements).await.unwrap();
        let v: String = client
            .query_one("SELECT n FROM public.t", &[])
            .await
            .unwrap()
            .get(0);
        assert_eq!(v, "12");
        drop(client);
        finish(db, dialect).await;
    }

    #[tokio::test]
    async fn a_type_change_with_a_default_applies() {
        let (db, dialect, client) = setup(
            "CREATE TABLE public.t (id int PRIMARY KEY, flag int DEFAULT 0);
             INSERT INTO public.t VALUES (1, 1), (2, 0);",
        )
        .await;
        let base = dialect.table_design(&path(&db, "t")).await.unwrap();
        let statements = alter(
            DialectKind::Postgres,
            &base,
            vec![change(&base, "flag", |c| {
                c.type_sql = "boolean".into();
                c.default_sql = Some("false".into());
            })],
        )
        .unwrap();
        run(&client, &statements).await.unwrap();
        let after = dialect.table_design(&path(&db, "t")).await.unwrap();
        assert_eq!(after.columns[1].type_sql, "boolean");
        assert_eq!(after.columns[1].default_sql.as_deref(), Some("false"));
        let flags: Vec<bool> = client
            .query("SELECT flag FROM public.t ORDER BY id", &[])
            .await
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect();
        assert_eq!(flags, [true, false]);
        drop(client);
        finish(db, dialect).await;
    }
}

mod mysql {
    use super::*;
    use crate::common::TestDb;
    use contura_core::Error;
    use contura_core::dialect::{Dialect, connect};
    use mysql_async::prelude::Queryable;
    use mysql_async::{Conn, Opts, OptsBuilder};
    use std::sync::Arc;

    async fn conn(db: &TestDb) -> Conn {
        let opts: Opts = OptsBuilder::default()
            .ip_or_hostname(db.config.host.clone())
            .tcp_port(db.config.port)
            .user(Some(db.config.user.clone()))
            .pass(db.password.clone())
            .db_name(Some(db.name.clone()))
            .into();
        Conn::new(opts).await.expect("connect to test MySQL")
    }

    fn path(db: &TestDb, name: &str) -> ObjectPath {
        ObjectPath {
            database: db.name.clone(),
            schema: None,
            name: name.into(),
        }
    }

    #[tokio::test]
    async fn attributes_are_read_whatever_the_quoting() {
        let db = TestDb::create().await;
        let mut c = conn(&db).await;
        c.query_drop("CREATE TABLE t (id int PRIMARY KEY, h int INVISIBLE, v int)")
            .await
            .unwrap();
        drop(c);
        let dialect =
            contura_core::mysql::MySqlDialect::connect(&db.config, db.password.as_deref())
                .await
                .expect("connect");
        for session in [
            "SET SESSION sql_mode = CONCAT(@@sql_mode, ',ANSI_QUOTES')",
            "SET SESSION sql_quote_show_create = 0",
        ] {
            let d = dialect
                .table_design_after_for_test(session, &path(&db, "t"))
                .await
                .unwrap();
            let advanced: Vec<bool> = d.columns.iter().map(|c| c.advanced).collect();
            assert_eq!(advanced, [false, true, false], "{session}");
            assert!(
                d.unsupported.contains(&"column h (invisible)".to_string()),
                "{session}: {:?}",
                d.unsupported
            );
        }
        dialect.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn an_invisible_column_is_renamed_only() {
        let db = TestDb::create().await;
        let mut c = conn(&db).await;
        c.query_drop("CREATE TABLE t (id int PRIMARY KEY, h int INVISIBLE, v int)")
            .await
            .unwrap();
        let dialect: Arc<dyn Dialect> = connect(&db.config, db.password.as_deref())
            .await
            .expect("connect");
        let base = dialect.table_design(&path(&db, "t")).await.unwrap();
        assert!(base.columns[1].advanced);
        assert!(!base.columns[0].advanced && !base.columns[2].advanced);
        assert!(
            base.unsupported
                .contains(&"column h (invisible)".to_string()),
            "{:?}",
            base.unsupported
        );

        let refused = alter(
            DialectKind::MySql,
            &base,
            vec![change(&base, "h", |c| c.comment = Some("x".into()))],
        )
        .unwrap_err();
        assert!(
            matches!(&refused, Error::InvalidInput(m) if m.contains("column h (invisible)")),
            "{refused:?}"
        );

        let statements = alter(
            DialectKind::MySql,
            &base,
            vec![change(&base, "h", |c| c.name = "hidden".into())],
        )
        .unwrap();
        for sql in &statements {
            c.query_drop(sql)
                .await
                .unwrap_or_else(|e| panic!("{sql}: {e}"));
        }
        let (_, create): (String, String) =
            c.query_first("SHOW CREATE TABLE t").await.unwrap().unwrap();
        assert!(
            create.contains("`hidden` int DEFAULT NULL /*!80023 INVISIBLE */"),
            "{create}"
        );
        drop(c);
        dialect.disconnect().await.ok();
        db.drop_db().await;
    }
}
