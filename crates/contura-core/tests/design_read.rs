mod common;

use contura_core::design::{Increment, TableDesign, TableIndex};
use contura_core::model::ObjectPath;

fn index<'a>(d: &'a TableDesign, name: &str) -> &'a TableIndex {
    d.indexes
        .iter()
        .find(|i| i.name == name)
        .unwrap_or_else(|| panic!("no index {name} in {:?}", d.indexes))
}

fn names(d: &TableDesign) -> Vec<&str> {
    d.columns.iter().map(|c| c.name.as_str()).collect()
}

mod mysql {
    use super::*;
    use crate::common::TestDb;
    use contura_core::Error;
    use contura_core::dialect::{Dialect, connect};
    use mysql_async::prelude::Queryable;
    use mysql_async::{Opts, OptsBuilder, Pool};
    use std::sync::Arc;

    const SEED: &[&str] = &[
        "CREATE TABLE orders (id INT PRIMARY KEY, email VARCHAR(80) UNIQUE, \
         status VARCHAR(16) NOT NULL DEFAULT 'new', total DECIMAL(10,2), \
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
        "CREATE TABLE items (id INT PRIMARY KEY, order_id INT, \
         FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE)",
    ];

    async fn exec(db: &TestDb, sqls: &[&str]) {
        let opts: Opts = OptsBuilder::default()
            .ip_or_hostname(db.config.host.clone())
            .tcp_port(db.config.port)
            .user(Some(db.config.user.clone()))
            .pass(db.password.clone())
            .db_name(Some(db.name.clone()))
            .into();
        let pool = Pool::new(opts);
        let mut conn = pool.get_conn().await.expect("connect to test MySQL");
        for sql in sqls {
            conn.query_drop(*sql)
                .await
                .unwrap_or_else(|e| panic!("{sql}: {e}"));
        }
        drop(conn);
        pool.disconnect().await.ok();
    }

    async fn setup(extra: &[&str]) -> (TestDb, Arc<dyn Dialect>) {
        let db = TestDb::create().await;
        exec(&db, SEED).await;
        exec(&db, extra).await;
        let dialect = connect(&db.config, db.password.as_deref())
            .await
            .expect("connect");
        (db, dialect)
    }

    fn path(db: &TestDb, name: &str) -> ObjectPath {
        ObjectPath {
            database: db.name.clone(),
            schema: None,
            name: name.into(),
        }
    }

    async fn finish(db: TestDb, dialect: Arc<dyn Dialect>) {
        dialect.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn reads_columns_in_table_order() {
        let (db, dialect) = setup(&[]).await;
        let d = dialect.table_design(&path(&db, "orders")).await.unwrap();
        assert_eq!(names(&d), ["id", "email", "status", "total", "created_at"]);
        let status = &d.columns[2];
        assert_eq!(status.type_sql, "varchar(16)");
        assert_eq!(status.default_sql.as_deref(), Some("'new'"));
        assert!(!status.nullable);
        assert!(d.columns[1].nullable);
        assert_eq!(d.columns[3].type_sql, "decimal(10,2)");
        assert_eq!(d.columns[3].default_sql, None);
        assert_eq!(
            d.columns[4].default_sql.as_deref(),
            Some("CURRENT_TIMESTAMP")
        );
        assert_eq!(d.columns[0].increment, Increment::None);
        assert!(d.sqlite.is_none());
        finish(db, dialect).await;
    }

    #[tokio::test]
    async fn reads_real_index_names() {
        let (db, dialect) = setup(&[]).await;
        let d = dialect.table_design(&path(&db, "orders")).await.unwrap();
        let pk = index(&d, "PRIMARY");
        assert!(pk.primary && pk.unique);
        assert_eq!(pk.columns, ["id"]);
        assert_eq!(pk.method.as_deref(), Some("btree"));
        assert_eq!(d.indexes[0].name, "PRIMARY");
        let email = index(&d, "email");
        assert!(email.unique && !email.primary);
        assert_eq!(email.columns, ["email"]);
        assert_eq!(email.method.as_deref(), Some("btree"));
        assert_eq!(email.sql, None);
        assert_eq!(email.predicate, None);
        assert!(!email.expression);
        finish(db, dialect).await;
    }

    #[tokio::test]
    async fn reads_fk_names_and_actions() {
        let (db, dialect) = setup(&[]).await;
        let d = dialect.table_design(&path(&db, "items")).await.unwrap();
        assert_eq!(d.foreign_keys.len(), 1, "{:?}", d.foreign_keys);
        let fk = &d.foreign_keys[0];
        assert_eq!(fk.name, "items_ibfk_1");
        assert_eq!(fk.columns, ["order_id"]);
        assert_eq!(fk.target, path(&db, "orders"));
        assert_eq!(fk.target_columns, ["id"]);
        assert_eq!(fk.on_delete.as_deref(), Some("CASCADE"));
        assert_eq!(fk.on_update, None);
        finish(db, dialect).await;
    }

    #[tokio::test]
    async fn reads_incoming_refs() {
        let (db, dialect) = setup(&[]).await;
        let d = dialect.table_design(&path(&db, "orders")).await.unwrap();
        assert_eq!(d.referenced_by.len(), 1, "{:?}", d.referenced_by);
        assert_eq!(d.referenced_by[0].name, "items_ibfk_1");
        assert_eq!(d.referenced_by[0].table, path(&db, "items"));
        finish(db, dialect).await;
    }

    #[tokio::test]
    async fn restates_charset_and_on_update() {
        let (db, dialect) = setup(&["CREATE TABLE notes (id INT PRIMARY KEY AUTO_INCREMENT, \
             code VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT 'it''s a code', \
             touched TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) \
             COMMENT 'all notes'"])
        .await;
        let d = dialect.table_design(&path(&db, "notes")).await.unwrap();
        assert_eq!(d.comment.as_deref(), Some("all notes"));
        assert_eq!(d.columns[0].increment, Increment::AutoIncrement);
        let code = d.columns[1].mysql.as_ref().expect("mysql extras");
        assert_eq!(code.charset.as_deref(), Some("utf8mb4"));
        assert_eq!(code.collation.as_deref(), Some("utf8mb4_bin"));
        assert_eq!(d.columns[1].collation.as_deref(), Some("utf8mb4_bin"));
        assert_eq!(code.on_update, None);
        assert_eq!(d.columns[1].comment.as_deref(), Some("it's a code"));
        let touched = &d.columns[2];
        assert_eq!(
            touched.mysql.as_ref().unwrap().on_update.as_deref(),
            Some("CURRENT_TIMESTAMP")
        );
        assert_eq!(touched.default_sql.as_deref(), Some("CURRENT_TIMESTAMP"));
        assert!(touched.nullable);
        assert_eq!(touched.collation, None);
        let orders = dialect.table_design(&path(&db, "orders")).await.unwrap();
        assert!(
            orders.columns.iter().all(|c| c.collation.is_none()),
            "{:?}",
            orders.columns
        );
        finish(db, dialect).await;
    }

    #[tokio::test]
    async fn notes_what_is_not_editable() {
        let (db, dialect) = setup(&[
            "ALTER TABLE orders ADD CONSTRAINT orders_total_ck CHECK (total >= 0)",
            "ALTER TABLE orders ADD COLUMN double_total DECIMAL(12,2) GENERATED ALWAYS AS (total * 2)",
            "CREATE TRIGGER orders_audit BEFORE INSERT ON orders FOR EACH ROW SET NEW.status = NEW.status",
            "CREATE INDEX orders_lower_email ON orders ((lower(email)))",
        ])
        .await;
        let d = dialect.table_design(&path(&db, "orders")).await.unwrap();
        assert_eq!(
            d.unsupported,
            [
                "generated column double_total",
                "check orders_total_ck",
                "trigger orders_audit"
            ]
        );
        let gen_col = d.columns.iter().find(|c| c.name == "double_total").unwrap();
        assert!(gen_col.generated);
        assert_eq!(gen_col.default_sql, None);
        let expr = index(&d, "orders_lower_email");
        assert!(expr.expression);
        assert_eq!(expr.columns.len(), 1);
        assert!(expr.columns[0].contains("lower"), "{:?}", expr.columns);
        finish(db, dialect).await;
    }

    #[tokio::test]
    async fn flags_indexes_the_model_cannot_recreate() {
        let (db, dialect) = setup(&[
            "CREATE TABLE docs (id INT PRIMARY KEY, title VARCHAR(200), body TEXT, \
             KEY docs_title_prefix (title(10)), KEY docs_id_desc (id DESC), \
             KEY docs_title (title), FULLTEXT KEY docs_body_ft (body))",
        ])
        .await;
        let d = dialect.table_design(&path(&db, "docs")).await.unwrap();
        assert_eq!(
            d.unsupported,
            [
                "index docs_body_ft (fulltext)",
                "index docs_id_desc (descending order)",
                "index docs_title_prefix (prefix length)",
            ]
        );
        for name in ["docs_body_ft", "docs_id_desc", "docs_title_prefix"] {
            assert!(index(&d, name).advanced, "{name}");
        }
        assert!(!index(&d, "docs_title").advanced);
        assert!(!index(&d, "PRIMARY").advanced);
        let items = dialect.table_design(&path(&db, "items")).await.unwrap();
        assert!(!items.foreign_keys[0].advanced);
        finish(db, dialect).await;
    }

    #[tokio::test]
    async fn missing_table_is_not_found() {
        let (db, dialect) = setup(&["CREATE VIEW v_orders AS SELECT id FROM orders"]).await;
        for name in ["nope", "v_orders"] {
            let err = dialect.table_design(&path(&db, name)).await.unwrap_err();
            assert!(
                matches!(err, Error::NotFound(ref n) if n == name),
                "{err:?}"
            );
        }
        finish(db, dialect).await;
    }
}

mod pg {
    use super::*;
    use crate::common::pg::{PgTestDb, pg_admin_client};
    use contura_core::Error;
    use contura_core::dialect::{Dialect, connect};
    use std::sync::Arc;

    const SEED: &str = "CREATE TABLE public.orders (id int PRIMARY KEY, email varchar(80) UNIQUE, \
         status varchar(16) NOT NULL DEFAULT 'new', total decimal(10,2), \
         created_at timestamp DEFAULT current_timestamp);
         CREATE TABLE public.items (id int PRIMARY KEY, \
         order_id int REFERENCES public.orders(id) ON DELETE CASCADE);";

    async fn setup(extra: &str) -> (PgTestDb, Arc<dyn Dialect>) {
        let db = PgTestDb::create().await;
        let admin = pg_admin_client(&db.name).await;
        admin.batch_execute(SEED).await.expect("seed");
        admin.batch_execute(extra).await.expect("extra seed");
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

    async fn finish(db: PgTestDb, dialect: Arc<dyn Dialect>) {
        dialect.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn reads_columns_in_table_order() {
        let (db, dialect) = setup("").await;
        let d = dialect.table_design(&path(&db, "orders")).await.unwrap();
        assert_eq!(names(&d), ["id", "email", "status", "total", "created_at"]);
        let status = &d.columns[2];
        assert_eq!(status.type_sql, "character varying(16)");
        assert_eq!(status.default_sql.as_deref(), Some("'new'"));
        assert!(!status.nullable);
        assert_eq!(d.columns[3].type_sql, "numeric(10,2)");
        assert_eq!(
            d.columns[4].default_sql.as_deref(),
            Some("CURRENT_TIMESTAMP")
        );
        assert!(d.columns.iter().all(|c| c.mysql.is_none()));
        finish(db, dialect).await;
    }

    #[tokio::test]
    async fn reads_a_non_default_column_collation() {
        let (db, dialect) = setup(
            "CREATE TABLE public.codes (a text COLLATE \"C\", b text, c int, d varchar(10) COLLATE \"POSIX\");
             CREATE INDEX codes_a ON public.codes (a);
             CREATE INDEX codes_b_c ON public.codes (b COLLATE \"C\");",
        )
        .await;
        let d = dialect.table_design(&path(&db, "codes")).await.unwrap();
        let collations: Vec<Option<&str>> =
            d.columns.iter().map(|c| c.collation.as_deref()).collect();
        assert_eq!(collations, [Some("C"), None, None, Some("POSIX")]);
        assert!(!index(&d, "codes_a").advanced);
        assert!(index(&d, "codes_b_c").advanced);
        assert_eq!(d.unsupported, ["index codes_b_c (collation)"]);
        finish(db, dialect).await;
    }

    #[tokio::test]
    async fn reads_increment_kinds_and_comments() {
        let (db, dialect) = setup(
            "CREATE TABLE public.counters (a serial, b int GENERATED BY DEFAULT AS IDENTITY, \
             c bigint GENERATED ALWAYS AS (b * 2) STORED, d text DEFAULT 'it''s'::text);
             COMMENT ON TABLE public.counters IS 'all counters';
             COMMENT ON COLUMN public.counters.a IS 'the a';",
        )
        .await;
        let d = dialect.table_design(&path(&db, "counters")).await.unwrap();
        assert_eq!(d.comment.as_deref(), Some("all counters"));
        assert_eq!(d.columns[0].increment, Increment::Serial);
        assert_eq!(d.columns[0].comment.as_deref(), Some("the a"));
        assert!(
            d.columns[0]
                .default_sql
                .as_deref()
                .is_some_and(|s| s.starts_with("nextval(")),
            "{:?}",
            d.columns[0].default_sql
        );
        assert_eq!(d.columns[1].increment, Increment::Identity);
        assert!(d.columns[2].generated);
        assert_eq!(d.columns[2].default_sql, None);
        assert_eq!(d.columns[3].default_sql.as_deref(), Some("'it''s'"));
        assert_eq!(d.unsupported, ["generated column c"]);
        finish(db, dialect).await;
    }

    #[tokio::test]
    async fn reads_real_index_names() {
        let (db, dialect) = setup("").await;
        let d = dialect.table_design(&path(&db, "orders")).await.unwrap();
        assert_eq!(d.indexes[0].name, "orders_pkey");
        let pk = index(&d, "orders_pkey");
        assert!(pk.primary && pk.unique && pk.constraint);
        assert_eq!(pk.columns, ["id"]);
        assert_eq!(pk.method.as_deref(), Some("btree"));
        let email = index(&d, "orders_email_key");
        assert!(email.unique && !email.primary && email.constraint);
        assert_eq!(email.columns, ["email"]);
        assert_eq!(email.method.as_deref(), Some("btree"));
        assert_eq!(email.sql, None);
        finish(db, dialect).await;
    }

    #[tokio::test]
    async fn reads_fk_names_and_actions() {
        let (db, dialect) = setup("").await;
        let d = dialect.table_design(&path(&db, "items")).await.unwrap();
        assert_eq!(d.foreign_keys.len(), 1, "{:?}", d.foreign_keys);
        let fk = &d.foreign_keys[0];
        assert_eq!(fk.name, "items_order_id_fkey");
        assert_eq!(fk.columns, ["order_id"]);
        assert_eq!(fk.target, path(&db, "orders"));
        assert_eq!(fk.target_columns, ["id"]);
        assert_eq!(fk.on_delete.as_deref(), Some("CASCADE"));
        assert_eq!(fk.on_update, None);
        finish(db, dialect).await;
    }

    #[tokio::test]
    async fn reads_incoming_refs() {
        let (db, dialect) = setup("").await;
        let d = dialect.table_design(&path(&db, "orders")).await.unwrap();
        assert_eq!(d.referenced_by.len(), 1, "{:?}", d.referenced_by);
        assert_eq!(d.referenced_by[0].name, "items_order_id_fkey");
        assert_eq!(d.referenced_by[0].table, path(&db, "items"));
        finish(db, dialect).await;
    }

    #[tokio::test]
    async fn reads_partial_index_predicate() {
        let (db, dialect) = setup(
            "CREATE INDEX orders_open_ix ON public.orders (status) WHERE status <> 'shipped';",
        )
        .await;
        let d = dialect.table_design(&path(&db, "orders")).await.unwrap();
        let ix = index(&d, "orders_open_ix");
        assert_eq!(ix.columns, ["status"]);
        assert!(!ix.unique && !ix.constraint && !ix.expression);
        assert_eq!(
            ix.predicate.as_deref(),
            Some("((status)::text <> 'shipped'::text)")
        );
        assert!(d.unsupported.is_empty(), "{:?}", d.unsupported);
        finish(db, dialect).await;
    }

    #[tokio::test]
    async fn reads_expression_index() {
        let (db, dialect) =
            setup("CREATE INDEX orders_lower_email ON public.orders (lower(email));").await;
        let d = dialect.table_design(&path(&db, "orders")).await.unwrap();
        let ix = index(&d, "orders_lower_email");
        assert!(ix.expression);
        assert_eq!(ix.columns, ["lower((email)::text)"]);
        assert_eq!(ix.predicate, None);
        assert!(d.unsupported.is_empty(), "{:?}", d.unsupported);
        finish(db, dialect).await;
    }

    #[tokio::test]
    async fn notes_what_is_not_editable() {
        let (db, dialect) = setup(
            "ALTER TABLE public.orders ADD CONSTRAINT orders_total_ck CHECK (total >= 0);
             CREATE INDEX orders_open_ix ON public.orders (status) WHERE status <> 'shipped';
             CREATE FUNCTION public.noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
             CREATE TRIGGER orders_audit BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.noop();",
        )
        .await;
        let d = dialect.table_design(&path(&db, "orders")).await.unwrap();
        assert_eq!(
            d.unsupported,
            ["check orders_total_ck", "trigger orders_audit"]
        );
        finish(db, dialect).await;
    }

    #[tokio::test]
    async fn flags_indexes_and_keys_the_model_cannot_recreate() {
        let (db, dialect) = setup(
            "CREATE INDEX orders_cover ON public.orders (status) INCLUDE (total);
             CREATE INDEX orders_email_desc ON public.orders (email DESC NULLS LAST);
             CREATE INDEX orders_email_pattern ON public.orders (email varchar_pattern_ops);
             CREATE INDEX orders_status_c ON public.orders (status COLLATE \"C\");
             CREATE UNIQUE INDEX orders_total_nnd ON public.orders (total) NULLS NOT DISTINCT;
             CREATE INDEX orders_plain ON public.orders (status, total);
             CREATE TABLE public.notes (id int PRIMARY KEY,
                 a int CONSTRAINT notes_a_fk REFERENCES public.orders(id) DEFERRABLE INITIALLY DEFERRED,
                 b int CONSTRAINT notes_b_fk REFERENCES public.orders(id) MATCH FULL,
                 c int CONSTRAINT notes_c_fk REFERENCES public.orders(id));",
        )
        .await;
        let d = dialect.table_design(&path(&db, "orders")).await.unwrap();
        assert_eq!(
            d.unsupported,
            [
                "index orders_cover (include columns)",
                "index orders_email_desc (descending order, nulls order)",
                "index orders_email_pattern (operator class)",
                "index orders_status_c (collation)",
                "index orders_total_nnd (nulls not distinct)",
            ]
        );
        assert!(index(&d, "orders_cover").advanced);
        assert_eq!(index(&d, "orders_cover").columns, ["status"]);
        assert!(!index(&d, "orders_plain").advanced);
        assert!(!index(&d, "orders_pkey").advanced);
        let notes = dialect.table_design(&path(&db, "notes")).await.unwrap();
        assert_eq!(
            notes.unsupported,
            [
                "foreign key notes_a_fk (deferrable, initially deferred)",
                "foreign key notes_b_fk (match full)",
            ]
        );
        let advanced: Vec<bool> = notes.foreign_keys.iter().map(|k| k.advanced).collect();
        assert_eq!(advanced, [true, true, false]);
        finish(db, dialect).await;
    }

    #[tokio::test]
    async fn missing_table_is_not_found() {
        let (db, dialect) =
            setup("CREATE VIEW public.v_orders AS SELECT id FROM public.orders;").await;
        for name in ["nope", "v_orders"] {
            let err = dialect.table_design(&path(&db, name)).await.unwrap_err();
            assert!(
                matches!(err, Error::NotFound(ref n) if n == name),
                "{err:?}"
            );
        }
        finish(db, dialect).await;
    }
}

mod sqlite {
    use super::*;
    use contura_core::Error;
    use contura_core::dialect::Dialect;
    use contura_core::model::{ConnectionConfig, DialectKind, SslMode};
    use contura_core::sqlite::SqliteDialect;

    const SEED: &str = "CREATE TABLE orders (id integer primary key, email varchar(80) unique, \
         status varchar(16) not null default 'new', total decimal(10,2), \
         created_at timestamp default current_timestamp);
         CREATE TABLE items (id integer primary key, \
         order_id integer references orders(id) on delete cascade);";

    async fn setup(extra: &str) -> (tempfile::TempDir, SqliteDialect) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shop.sqlite");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(SEED).unwrap();
        conn.execute_batch(extra).unwrap();
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
            file: Some(path),
            query_timeout_secs: None,
            ai_access: Default::default(),
            production: false,
            read_only: false,
        };
        let dialect = SqliteDialect::connect(&config).await.unwrap();
        (dir, dialect)
    }

    fn path(name: &str) -> ObjectPath {
        ObjectPath {
            database: "main".into(),
            schema: None,
            name: name.into(),
        }
    }

    #[tokio::test]
    async fn reads_columns_in_table_order() {
        let (_dir, dialect) = setup("").await;
        let d = dialect.table_design(&path("orders")).await.unwrap();
        assert_eq!(names(&d), ["id", "email", "status", "total", "created_at"]);
        let status = &d.columns[2];
        assert_eq!(status.type_sql, "varchar(16)");
        assert_eq!(status.default_sql.as_deref(), Some("'new'"));
        assert!(!status.nullable);
        assert_eq!(
            d.columns[4].default_sql.as_deref(),
            Some("current_timestamp")
        );
        assert_eq!(d.columns[0].increment, Increment::AutoIncrement);
        assert_eq!(d.columns[1].increment, Increment::None);
        assert_eq!(d.comment, None);
        let extras = d.sqlite.as_ref().expect("sqlite extras");
        assert!(extras.create_sql.starts_with("CREATE TABLE orders"));
        finish(dialect).await;
    }

    async fn finish(dialect: SqliteDialect) {
        dialect.disconnect().await.ok();
    }

    #[tokio::test]
    async fn reads_real_index_names() {
        let (_dir, dialect) = setup("").await;
        let d = dialect.table_design(&path("orders")).await.unwrap();
        assert_eq!(d.indexes[0].name, "primary");
        let pk = index(&d, "primary");
        assert!(pk.primary && pk.unique);
        assert_eq!(pk.columns, ["id"]);
        assert_eq!(pk.sql, None);
        assert_eq!(pk.method, None);
        let email = index(&d, "sqlite_autoindex_orders_1");
        assert!(email.unique && !email.primary && !email.constraint);
        assert_eq!(email.columns, ["email"]);
        assert_eq!(email.sql, None);
        finish(dialect).await;
    }

    #[tokio::test]
    async fn reads_composite_primary_key_once() {
        let (_dir, dialect) = setup(
            "CREATE TABLE lines (order_id integer, line integer, qty int, primary key (order_id, line));
             CREATE INDEX lines_qty ON lines (qty);",
        )
        .await;
        let d = dialect.table_design(&path("lines")).await.unwrap();
        assert_eq!(d.indexes.len(), 2, "{:?}", d.indexes);
        assert_eq!(d.indexes[0].name, "primary");
        assert_eq!(d.indexes[0].columns, ["order_id", "line"]);
        assert_eq!(d.indexes[1].name, "lines_qty");
        assert_eq!(
            d.indexes[1].sql.as_deref(),
            Some("CREATE INDEX lines_qty ON lines (qty)")
        );
        assert!(d.columns.iter().all(|c| c.increment == Increment::None));
        finish(dialect).await;
    }

    #[tokio::test]
    async fn reads_fk_names_and_actions() {
        let (_dir, dialect) = setup("").await;
        let d = dialect.table_design(&path("items")).await.unwrap();
        assert_eq!(d.foreign_keys.len(), 1, "{:?}", d.foreign_keys);
        let fk = &d.foreign_keys[0];
        assert_eq!(fk.name, "fk_0");
        assert_eq!(fk.columns, ["order_id"]);
        assert_eq!(fk.target, path("orders"));
        assert_eq!(fk.target_columns, ["id"]);
        assert_eq!(fk.on_delete.as_deref(), Some("CASCADE"));
        assert_eq!(fk.on_update, None);
        finish(dialect).await;
    }

    #[tokio::test]
    async fn reads_incoming_refs() {
        let (_dir, dialect) = setup("").await;
        let d = dialect.table_design(&path("orders")).await.unwrap();
        assert_eq!(d.referenced_by.len(), 1, "{:?}", d.referenced_by);
        assert_eq!(d.referenced_by[0].name, "fk_0");
        assert_eq!(d.referenced_by[0].table, path("items"));
        finish(dialect).await;
    }

    #[tokio::test]
    async fn keeps_triggers_views_and_pragma() {
        let (_dir, dialect) = setup(
            "CREATE TRIGGER orders_audit AFTER INSERT ON orders BEGIN SELECT 1; END;
             CREATE TRIGGER items_audit AFTER INSERT ON items BEGIN SELECT 1; END;
             CREATE VIEW open_orders AS SELECT id FROM \"orders\" WHERE status <> 'shipped';
             CREATE VIEW open_count AS SELECT count(*) AS n FROM open_orders;
             CREATE VIEW item_ids AS SELECT id FROM items;",
        )
        .await;
        let d = dialect.table_design(&path("orders")).await.unwrap();
        let extras = d.sqlite.as_ref().expect("sqlite extras");
        let triggers: Vec<&str> = extras.triggers.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(triggers, ["orders_audit"]);
        assert!(
            extras.triggers[0]
                .sql
                .starts_with("CREATE TRIGGER orders_audit")
        );
        let views: Vec<&str> = extras.views.iter().map(|v| v.name.as_str()).collect();
        assert_eq!(views, ["open_orders", "open_count"]);
        assert!(extras.views[0].sql.starts_with("CREATE VIEW open_orders"));
        assert_eq!(d.unsupported, ["trigger orders_audit"]);

        for (pragma, on) in [("OFF", false), ("ON", true)] {
            dialect
                .browse_execute_for_test(&format!("PRAGMA foreign_keys = {pragma}"))
                .await
                .unwrap();
            let d = dialect.table_design(&path("orders")).await.unwrap();
            assert_eq!(d.sqlite.unwrap().foreign_keys_on, on, "after {pragma}");
        }
        finish(dialect).await;
    }

    #[tokio::test]
    async fn reads_partial_index_predicate() {
        let (_dir, dialect) =
            setup("create index orders_open_ix on orders (status) where status <> 'shipped';")
                .await;
        let d = dialect.table_design(&path("orders")).await.unwrap();
        let ix = index(&d, "orders_open_ix");
        assert_eq!(ix.columns, ["status"]);
        assert_eq!(ix.predicate.as_deref(), Some("status <> 'shipped'"));
        assert!(!ix.expression);
        assert!(d.unsupported.is_empty(), "{:?}", d.unsupported);
        finish(dialect).await;
    }

    #[tokio::test]
    async fn reads_expression_index() {
        let (_dir, dialect) =
            setup("create index orders_lower_email on orders (lower(email), status);").await;
        let d = dialect.table_design(&path("orders")).await.unwrap();
        let ix = index(&d, "orders_lower_email");
        assert!(ix.expression);
        assert_eq!(ix.columns, ["lower(email)", "status"]);
        finish(dialect).await;
    }

    #[tokio::test]
    async fn reads_autoincrement_keyword_apart_from_rowid_alias() {
        let (_dir, dialect) =
            setup("CREATE TABLE seq (id INTEGER PRIMARY KEY AUTOINCREMENT, n int);").await;
        let plain = dialect.table_design(&path("orders")).await.unwrap();
        assert_eq!(plain.columns[0].increment, Increment::AutoIncrement);
        assert!(!plain.columns[0].sqlite_autoincrement);
        let keyword = dialect.table_design(&path("seq")).await.unwrap();
        assert_eq!(keyword.columns[0].increment, Increment::AutoIncrement);
        assert!(keyword.columns[0].sqlite_autoincrement);
        assert!(!keyword.columns[1].sqlite_autoincrement);
        finish(dialect).await;
    }

    #[tokio::test]
    async fn flags_indexes_and_keys_the_model_cannot_recreate() {
        let (_dir, dialect) = setup(
            "create index orders_email_desc on orders (email desc);
             create index orders_status_nocase on orders (status collate nocase);
             create index orders_plain on orders (status, total);
             create table notes (id integer primary key,
                 a integer references orders(id) deferrable initially deferred,
                 b integer references orders(id));",
        )
        .await;
        let d = dialect.table_design(&path("orders")).await.unwrap();
        assert_eq!(
            d.unsupported,
            [
                "index orders_email_desc (descending order)",
                "index orders_status_nocase (collation)",
            ]
        );
        assert!(index(&d, "orders_email_desc").advanced);
        assert!(index(&d, "orders_status_nocase").advanced);
        assert!(!index(&d, "orders_plain").advanced);
        assert!(!index(&d, "sqlite_autoindex_orders_1").advanced);
        let notes = dialect.table_design(&path("notes")).await.unwrap();
        let a = notes
            .foreign_keys
            .iter()
            .find(|k| k.columns == ["a"])
            .unwrap();
        let b = notes
            .foreign_keys
            .iter()
            .find(|k| k.columns == ["b"])
            .unwrap();
        assert!(a.advanced && !b.advanced);
        assert_eq!(
            notes.unsupported,
            [format!(
                "foreign key {} (deferrable, initially deferred)",
                a.name
            )]
        );
        finish(dialect).await;
    }

    #[tokio::test]
    async fn column_collation_is_not_an_index_attribute() {
        let (_dir, dialect) = setup(
            "CREATE TABLE people (id integer primary key, email text COLLATE NOCASE UNIQUE, \
                 name text collate nocase, nick text);
             CREATE INDEX people_name ON people (name);
             CREATE INDEX people_name_bin ON people (name COLLATE BINARY);
             CREATE INDEX people_nick_nocase ON people (nick COLLATE NOCASE);",
        )
        .await;
        let d = dialect.table_design(&path("people")).await.unwrap();
        let collations: Vec<Option<&str>> =
            d.columns.iter().map(|c| c.collation.as_deref()).collect();
        assert_eq!(collations, [None, Some("NOCASE"), Some("nocase"), None]);
        assert!(!index(&d, "people_name").advanced);
        assert!(!index(&d, "sqlite_autoindex_people_1").advanced);
        assert!(index(&d, "people_name_bin").advanced);
        assert!(index(&d, "people_nick_nocase").advanced);
        assert_eq!(
            d.unsupported,
            [
                "index people_name_bin (collation)",
                "index people_nick_nocase (collation)",
            ]
        );
        finish(dialect).await;
    }

    #[tokio::test]
    async fn notes_what_is_not_editable() {
        let (_dir, dialect) = setup(
            "CREATE TABLE checked (id integer primary key, \
             qty int CHECK (qty > 0), \
             price int, \
             doubled int GENERATED ALWAYS AS (price * 2), \
             note text DEFAULT 'CHECK (x)', \
             CONSTRAINT price_ck CHECK (price >= 0)) STRICT;
             create index checked_open on checked (qty) where qty <> 1;
             CREATE TABLE plain (k text primary key) WITHOUT ROWID;",
        )
        .await;
        let d = dialect.table_design(&path("checked")).await.unwrap();
        assert_eq!(
            d.unsupported,
            [
                "generated column doubled",
                "check qty > 0",
                "check price_ck",
                "strict"
            ]
        );
        let doubled = d.columns.iter().find(|c| c.name == "doubled").unwrap();
        assert!(doubled.generated);
        let d = dialect.table_design(&path("plain")).await.unwrap();
        assert_eq!(d.unsupported, ["without rowid"]);
        assert_eq!(d.indexes[0].name, "primary");
        assert_eq!(d.indexes[0].columns, ["k"]);
        finish(dialect).await;
    }

    #[tokio::test]
    async fn missing_table_is_not_found() {
        let (_dir, dialect) = setup("CREATE VIEW v_orders AS SELECT id FROM orders;").await;
        for name in ["nope", "v_orders"] {
            let err = dialect.table_design(&path(name)).await.unwrap_err();
            assert!(
                matches!(err, Error::NotFound(ref n) if n == name),
                "{err:?}"
            );
        }
        finish(dialect).await;
    }
}
