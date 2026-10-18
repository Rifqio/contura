//! Live tests for `Dialect::apply_design`: PostgreSQL and SQLite run a plan in
//! one transaction, MySQL statement by statement, honest about what ran.

mod common;

use std::sync::Arc;

use contura_core::Error;
use contura_core::design::{
    ColumnDraft, DesignEdit, DesignMode, DesignOutcome, DesignPlan, DesignRequest, DesignTarget,
    ForeignKeyDraft, Increment, IndexDraft, Position, TableDesign, plan_design,
};
use contura_core::dialect::Dialect;
use contura_core::model::{Cell, DialectKind, ObjectPath, PageRequest, SortSpec};

/// The same tables on every Dialect.
const SEED: &[&str] = &[
    "CREATE TABLE customers (id int PRIMARY KEY, name varchar(40))",
    "CREATE TABLE orders (id int PRIMARY KEY, customer_id int, status varchar(16), \
     CONSTRAINT fk_a FOREIGN KEY (customer_id) REFERENCES customers (id))",
    "INSERT INTO customers VALUES (1, 'ann')",
    "INSERT INTO orders VALUES (1, 1, 'new'), (2, 1, 'paid')",
];

struct Env {
    db: Arc<dyn Dialect>,
    kind: DialectKind,
    database: String,
    /// `None` for MySQL and SQLite.
    schema: Option<String>,
}

impl Env {
    fn path(&self, name: &str) -> ObjectPath {
        ObjectPath {
            database: self.database.clone(),
            schema: self.schema.clone(),
            name: name.into(),
        }
    }

    async fn design(&self, name: &str) -> TableDesign {
        self.db
            .table_design(&self.path(name))
            .await
            .expect("table design")
    }

    fn alter(&self, base: &TableDesign, edits: Vec<DesignEdit>) -> DesignPlan {
        plan_design(
            self.kind,
            &DesignRequest {
                target: DesignTarget::Alter { base: base.clone() },
                edits,
            },
        )
        .expect("plan")
    }

    fn create(&self, name: &str, edits: Vec<DesignEdit>) -> DesignPlan {
        plan_design(
            self.kind,
            &DesignRequest {
                target: DesignTarget::Create {
                    path: self.path(name),
                },
                edits,
            },
        )
        .expect("plan")
    }

    async fn apply(&self, plan: &DesignPlan) -> contura_core::Result<DesignOutcome> {
        self.db.apply_design(&self.database, plan).await
    }

    /// One column of every row, ordered by `id`, NULL as `None`.
    async fn values(&self, table: &str, column: &str) -> Vec<Option<String>> {
        let page = self
            .db
            .fetch_page(&PageRequest {
                table: self.path(table),
                page: 0,
                sort: Some(SortSpec {
                    column: "id".into(),
                    descending: false,
                }),
                filter: None,
            })
            .await
            .expect("fetch page");
        let at = page
            .columns
            .iter()
            .position(|c| c.name == column)
            .unwrap_or_else(|| panic!("no column {column}"));
        page.rows
            .iter()
            .map(|r| match &r[at] {
                Cell::Null => None,
                Cell::Number { value } | Cell::Text { value, .. } => Some(value.clone()),
                Cell::Bytes { .. } => panic!("unexpected binary cell"),
            })
            .collect()
    }
}

fn column(name: &str, type_sql: &str, nullable: bool) -> ColumnDraft {
    ColumnDraft {
        name: name.into(),
        type_sql: type_sql.into(),
        nullable,
        default_sql: None,
        increment: false,
        comment: None,
    }
}

fn add(column: ColumnDraft) -> DesignEdit {
    DesignEdit::AddColumn {
        column,
        position: Position::Last,
    }
}

fn index(name: &str, columns: &[&str]) -> IndexDraft {
    IndexDraft {
        name: name.into(),
        columns: columns.iter().map(|c| c.to_string()).collect(),
        unique: false,
        primary: false,
    }
}

/// The column as loaded, as a draft to edit.
fn loaded(base: &TableDesign, name: &str) -> ColumnDraft {
    let c = base
        .columns
        .iter()
        .find(|c| c.name == name)
        .unwrap_or_else(|| panic!("no column {name}"));
    ColumnDraft {
        name: c.name.clone(),
        type_sql: c.type_sql.clone(),
        nullable: c.nullable,
        default_sql: c.default_sql.clone(),
        increment: c.increment != Increment::None,
        comment: c.comment.clone(),
    }
}

fn names(design: &TableDesign) -> Vec<&str> {
    design.columns.iter().map(|c| c.name.as_str()).collect()
}

async fn apply_commits_and_reads_back(env: &Env) {
    let base = env.design("orders").await;
    let plan = env.alter(
        &base,
        vec![
            add(column("note", "varchar(40)", true)),
            DesignEdit::AddIndex {
                index: index("orders_status_ix", &["status"]),
            },
        ],
    );
    let n = plan.statements.len();
    assert_eq!(
        env.apply(&plan).await.expect("apply"),
        DesignOutcome::Done { ran: n }
    );
    let after = env.design("orders").await;
    assert_eq!(names(&after), ["id", "customer_id", "status", "note"]);
    let ix = after
        .indexes
        .iter()
        .find(|i| i.name == "orders_status_ix")
        .expect("the new index");
    assert_eq!(ix.columns, ["status"]);
    assert!(!ix.unique);
}

async fn create_reads_back_the_same(env: &Env, fk_name: &str) {
    let plan = env.create(
        "t",
        vec![
            add(column("id", "int", false)),
            add(column("owner_id", "int", true)),
            add(column("name", "varchar(40)", true)),
            DesignEdit::AddIndex {
                index: IndexDraft {
                    name: "t_pkey".into(),
                    columns: vec!["id".into()],
                    unique: true,
                    primary: true,
                },
            },
            DesignEdit::AddIndex {
                index: index("t_name_idx", &["name"]),
            },
            DesignEdit::AddForeignKey {
                key: ForeignKeyDraft {
                    name: "t_owner_fkey".into(),
                    columns: vec!["owner_id".into()],
                    target: env.path("customers"),
                    target_columns: vec!["id".into()],
                    on_delete: Some("CASCADE".into()),
                    on_update: None,
                },
            },
        ],
    );
    let n = plan.statements.len();
    assert_eq!(
        env.apply(&plan).await.expect("apply"),
        DesignOutcome::Done { ran: n }
    );
    let t = env.design("t").await;
    assert_eq!(names(&t), ["id", "owner_id", "name"]);
    let primary: Vec<_> = t.indexes.iter().filter(|i| i.primary).collect();
    assert_eq!(primary.len(), 1, "{:?}", t.indexes);
    assert_eq!(primary[0].columns, ["id"]);
    let ix = t
        .indexes
        .iter()
        .find(|i| i.name == "t_name_idx")
        .expect("t_name_idx");
    assert_eq!(ix.columns, ["name"]);
    assert!(!ix.unique);
    assert_eq!(t.foreign_keys.len(), 1);
    let fk = &t.foreign_keys[0];
    assert_eq!(fk.name, fk_name);
    assert_eq!(fk.columns, ["owner_id"]);
    assert_eq!(fk.target.name, "customers");
    assert_eq!(fk.target_columns, ["id"]);
    assert_eq!(fk.on_delete.as_deref(), Some("CASCADE"));
}

/// A rename with a type change keeps every value (Review Focus 3).
async fn rename_keeps_values(env: &Env) {
    let base = env.design("orders").await;
    let mut state = loaded(&base, "status");
    state.name = "state".into();
    state.type_sql = "varchar(32)".into();
    let plan = env.alter(
        &base,
        vec![DesignEdit::ChangeColumn {
            name: "status".into(),
            column: state,
        }],
    );
    assert!(
        !plan.statements.iter().any(|s| s.contains("DROP COLUMN")),
        "{:?}",
        plan.statements
    );
    let n = plan.statements.len();
    assert_eq!(
        env.apply(&plan).await.expect("apply"),
        DesignOutcome::Done { ran: n }
    );
    let after = env.design("orders").await;
    assert_eq!(names(&after), ["id", "customer_id", "state"]);
    assert_eq!(
        env.values("orders", "state").await,
        [Some("new".to_string()), Some("paid".to_string())]
    );
}

/// The plan for one added column, then a statement the server refuses.
async fn second_statement_fails_rolls_back(env: &Env, bad: &str) {
    let base = env.design("orders").await;
    let mut plan = env.alter(&base, vec![add(column("note", "varchar(40)", true))]);
    assert_eq!(plan.statements.len(), 1, "{:?}", plan.statements);
    plan.statements.push(bad.to_string());
    match env.apply(&plan).await {
        Ok(DesignOutcome::Failed {
            statement: 1,
            ran: 0,
            message,
        }) => assert!(message.contains("nope"), "{message}"),
        other => panic!("expected Failed at 1 with nothing run, got {other:?}"),
    }
    assert_eq!(env.design("orders").await, base);
}

async fn read_only_refuses(rw: &Env, ro: &Env) {
    let base = rw.design("orders").await;
    let plan = ro.alter(&base, vec![add(column("note", "varchar(40)", true))]);
    match ro.apply(&plan).await {
        Err(Error::ReadOnlyRefused) => {}
        other => panic!("expected ReadOnlyRefused, got {other:?}"),
    }
    assert_eq!(rw.design("orders").await, base);
}

mod mysql {
    use super::*;
    use crate::common::TestDb;
    use contura_core::dialect::connect;
    use mysql_async::prelude::Queryable;
    use mysql_async::{Conn, Opts, OptsBuilder};

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

    async fn exec(db: &TestDb, sqls: &[&str]) {
        let mut c = conn(db).await;
        for sql in sqls {
            c.query_drop(*sql)
                .await
                .unwrap_or_else(|e| panic!("{sql}: {e}"));
        }
        c.disconnect().await.ok();
    }

    async fn env_for(db: &TestDb, read_only: bool) -> Env {
        let mut config = db.config.clone();
        config.read_only = read_only;
        Env {
            db: connect(&config, db.password.as_deref())
                .await
                .expect("connect"),
            kind: DialectKind::MySql,
            database: db.name.clone(),
            schema: None,
        }
    }

    async fn fixture() -> (TestDb, Env) {
        let db = TestDb::create().await;
        exec(&db, SEED).await;
        let env = env_for(&db, false).await;
        (db, env)
    }

    async fn finish(db: TestDb, env: Env) {
        env.db.disconnect().await.ok();
        db.drop_db().await;
    }

    /// The plan's statements as the one ALTER TABLE D4 says MySQL refuses.
    fn merged(statements: &[String]) -> String {
        let (head, _) = statements[0].split_once("\n  ").expect("ALTER TABLE head");
        let clauses: Vec<&str> = statements
            .iter()
            .map(|s| {
                let (h, rest) = s.split_once("\n  ").expect("ALTER TABLE head");
                assert_eq!(h, head);
                rest
            })
            .collect();
        format!("{head}\n  {}", clauses.join(",\n  "))
    }

    fn fk_a_again(env: &Env) -> DesignEdit {
        DesignEdit::AddForeignKey {
            key: ForeignKeyDraft {
                name: "fk_a".into(),
                columns: vec!["customer_id".into()],
                target: env.path("customers"),
                target_columns: vec!["id".into()],
                on_delete: Some("CASCADE".into()),
                on_update: None,
            },
        }
    }

    #[tokio::test]
    async fn apply_commits_and_reads_back() {
        let (db, env) = fixture().await;
        super::apply_commits_and_reads_back(&env).await;
        finish(db, env).await;
    }

    #[tokio::test]
    async fn create_reads_back_the_same() {
        let (db, env) = fixture().await;
        super::create_reads_back_the_same(&env, "t_owner_fkey").await;
        finish(db, env).await;
    }

    #[tokio::test]
    async fn rename_keeps_values() {
        let (db, env) = fixture().await;
        super::rename_keeps_values(&env).await;
        finish(db, env).await;
    }

    #[tokio::test]
    async fn read_only_refuses() {
        let (db, env) = fixture().await;
        let ro = env_for(&db, true).await;
        super::read_only_refuses(&env, &ro).await;
        ro.db.disconnect().await.ok();
        finish(db, env).await;
    }

    /// Review Focus 2: the Foreign Key drop landed and stays; the add failed.
    #[tokio::test]
    async fn mysql_split_second_statement_fails_reports_ran_1() {
        let (db, env) = fixture().await;
        let base = env.design("orders").await;
        let plan = env.alter(
            &base,
            vec![
                DesignEdit::DropForeignKey {
                    name: "fk_a".into(),
                },
                DesignEdit::AddForeignKey {
                    key: ForeignKeyDraft {
                        name: "fk_b".into(),
                        columns: vec!["customer_id".into()],
                        target: env.path("nowhere"),
                        target_columns: vec!["id".into()],
                        on_delete: None,
                        on_update: None,
                    },
                },
            ],
        );
        assert_eq!(plan.mode, DesignMode::Sequential);
        assert_eq!(plan.statements.len(), 2);
        match env.apply(&plan).await {
            Ok(DesignOutcome::Failed {
                statement: 1,
                ran: 1,
                message,
            }) => assert!(!message.is_empty()),
            other => panic!("expected Failed at 1 with 1 run, got {other:?}"),
        }
        let after = env.design("orders").await;
        assert!(after.foreign_keys.is_empty(), "{:?}", after.foreign_keys);
        finish(db, env).await;
    }

    /// D4: dropping and adding a Foreign Key of one name in one ALTER is refused.
    #[tokio::test]
    async fn fk_drop_add_same_name_needs_split() {
        let (db, env) = fixture().await;
        let base = env.design("orders").await;
        let plan = env.alter(
            &base,
            vec![
                DesignEdit::DropForeignKey {
                    name: "fk_a".into(),
                },
                fk_a_again(&env),
            ],
        );
        assert_eq!(plan.mode, DesignMode::Sequential);
        assert_eq!(plan.statements.len(), 2);
        let mut c = conn(&db).await;
        let one = merged(&plan.statements);
        assert!(c.query_drop(one.as_str()).await.is_err(), "{one}");
        c.disconnect().await.ok();
        assert_eq!(env.design("orders").await, base);

        assert_eq!(
            env.apply(&plan).await.expect("apply"),
            DesignOutcome::Done { ran: 2 }
        );
        let after = env.design("orders").await;
        let fk = after
            .foreign_keys
            .iter()
            .find(|k| k.name == "fk_a")
            .expect("fk_a");
        assert_eq!(fk.on_delete.as_deref(), Some("CASCADE"));
        finish(db, env).await;
    }

    /// D4 splits a Foreign Key drop from a drop of the index on its columns.
    /// MySQL 8.0.30 accepts the merged ALTER too (checked while writing this), so
    /// for this case the split is caution, not need; the split plan must still apply.
    #[tokio::test]
    async fn fk_drop_with_its_index_split_applies() {
        let (db, env) = fixture().await;
        let base = env.design("orders").await;
        // MySQL made this index for the key.
        assert!(
            base.indexes.iter().any(|i| i.name == "fk_a"),
            "{:?}",
            base.indexes
        );
        let plan = env.alter(
            &base,
            vec![
                DesignEdit::DropForeignKey {
                    name: "fk_a".into(),
                },
                DesignEdit::DropIndex {
                    name: "fk_a".into(),
                },
            ],
        );
        assert_eq!(plan.mode, DesignMode::Sequential);
        assert_eq!(plan.statements.len(), 2);
        assert_eq!(
            env.apply(&plan).await.expect("apply"),
            DesignOutcome::Done { ran: 2 }
        );
        let after = env.design("orders").await;
        assert!(after.foreign_keys.is_empty());
        assert!(!after.indexes.iter().any(|i| i.name == "fk_a"));
        finish(db, env).await;
    }

    #[tokio::test]
    async fn merged_index_and_column_changes_run_as_one() {
        let (db, env) = fixture().await;
        exec(&db, &["CREATE INDEX orders_status_ix ON orders (status)"]).await;
        let base = env.design("orders").await;
        let mut status = loaded(&base, "status");
        status.type_sql = "varchar(32)".into();
        let plan = env.alter(
            &base,
            vec![
                DesignEdit::DropIndex {
                    name: "orders_status_ix".into(),
                },
                DesignEdit::AddColumn {
                    column: column("note", "varchar(40)", true),
                    position: Position::After {
                        column: "status".into(),
                    },
                },
                DesignEdit::ChangeColumn {
                    name: "status".into(),
                    column: status,
                },
                DesignEdit::AddForeignKey {
                    key: ForeignKeyDraft {
                        name: "fk_b".into(),
                        columns: vec!["customer_id".into()],
                        target: env.path("customers"),
                        target_columns: vec!["id".into()],
                        on_delete: None,
                        on_update: None,
                    },
                },
            ],
        );
        assert_eq!(plan.mode, DesignMode::Atomic);
        assert_eq!(plan.statements.len(), 1);
        assert_eq!(
            env.apply(&plan).await.expect("apply"),
            DesignOutcome::Done { ran: 1 }
        );
        let after = env.design("orders").await;
        assert_eq!(names(&after), ["id", "customer_id", "status", "note"]);
        assert_eq!(after.columns[2].type_sql, "varchar(32)");
        assert!(!after.indexes.iter().any(|i| i.name == "orders_status_ix"));
        let mut keys: Vec<&str> = after.foreign_keys.iter().map(|k| k.name.as_str()).collect();
        keys.sort();
        assert_eq!(keys, ["fk_a", "fk_b"]);
        finish(db, env).await;
    }
}

mod pg {
    use super::*;
    use crate::common::pg::{PgTestDb, pg_admin_client};
    use contura_core::dialect::connect;

    async fn env_for(db: &PgTestDb, read_only: bool) -> Env {
        let mut config = db.config.clone();
        config.read_only = read_only;
        Env {
            db: connect(&config, db.password.as_deref())
                .await
                .expect("connect"),
            kind: DialectKind::Postgres,
            database: db.name.clone(),
            schema: Some("public".into()),
        }
    }

    async fn fixture() -> (PgTestDb, Env) {
        let db = PgTestDb::create().await;
        let admin = pg_admin_client(&db.name).await;
        for sql in SEED {
            admin
                .batch_execute(sql)
                .await
                .unwrap_or_else(|e| panic!("{sql}: {e}"));
        }
        let env = env_for(&db, false).await;
        (db, env)
    }

    async fn finish(db: PgTestDb, env: Env) {
        env.db.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn apply_commits_and_reads_back() {
        let (db, env) = fixture().await;
        super::apply_commits_and_reads_back(&env).await;
        finish(db, env).await;
    }

    #[tokio::test]
    async fn create_reads_back_the_same() {
        let (db, env) = fixture().await;
        super::create_reads_back_the_same(&env, "t_owner_fkey").await;
        finish(db, env).await;
    }

    #[tokio::test]
    async fn rename_keeps_values() {
        let (db, env) = fixture().await;
        super::rename_keeps_values(&env).await;
        finish(db, env).await;
    }

    #[tokio::test]
    async fn second_statement_fails_rolls_back() {
        let (db, env) = fixture().await;
        super::second_statement_fails_rolls_back(
            &env,
            "CREATE INDEX \"orders_nope_ix\" ON \"public\".\"orders\" (\"nope\")",
        )
        .await;
        finish(db, env).await;
    }

    #[tokio::test]
    async fn read_only_refuses() {
        let (db, env) = fixture().await;
        let ro = env_for(&db, true).await;
        super::read_only_refuses(&env, &ro).await;
        ro.db.disconnect().await.ok();
        finish(db, env).await;
    }
}

mod sqlite {
    use std::path::Path;

    use super::*;
    use contura_core::model::{ConnectionConfig, SslMode};
    use contura_core::sqlite::SqliteDialect;

    fn config(path: &Path, read_only: bool) -> ConnectionConfig {
        ConnectionConfig {
            id: uuid::Uuid::new_v4(),
            name: "t".into(),
            dialect: DialectKind::Sqlite,
            host: String::new(),
            port: 0,
            user: String::new(),
            database: None,
            ssl: SslMode::Disable,
            group_id: None,
            file: Some(path.to_path_buf()),
            query_timeout_secs: None,
            ai_access: Default::default(),
            production: false,
            read_only,
        }
    }

    struct Lite {
        _dir: tempfile::TempDir,
        path: std::path::PathBuf,
        lite: Arc<SqliteDialect>,
        env: Env,
    }

    impl Lite {
        async fn exec(&self, sql: &str) {
            self.lite
                .browse_execute_for_test(sql)
                .await
                .unwrap_or_else(|e| panic!("{sql}: {e}"));
        }

        async fn int(&self, sql: &str) -> i64 {
            self.lite.browse_i64_for_test(sql).await.expect(sql)
        }

        /// Runs `sql` on the browse connection and says whether it was refused.
        async fn refused(&self, sql: &str) -> bool {
            self.lite.browse_execute_for_test(sql).await.is_err()
        }
    }

    async fn open(seed: &str) -> Lite {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("design.sqlite");
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch(seed)
            .unwrap();
        let lite = Arc::new(
            SqliteDialect::connect(&config(&path, false))
                .await
                .expect("connect"),
        );
        let env = Env {
            db: lite.clone(),
            kind: DialectKind::Sqlite,
            database: "main".into(),
            schema: None,
        };
        Lite {
            _dir: dir,
            path,
            lite,
            env,
        }
    }

    async fn fixture() -> Lite {
        open(&SEED.join(";\n")).await
    }

    /// Orders with an autoindex, a trigger, a view, an outgoing and an incoming key.
    const SHOP: &str = "
        CREATE TABLE customers (id INTEGER PRIMARY KEY, name text);
        CREATE TABLE orders (id INTEGER PRIMARY KEY,
            customer_id int REFERENCES customers (id),
            email varchar(80) UNIQUE,
            status varchar(16) NOT NULL DEFAULT 'new',
            total decimal(10,2));
        CREATE TABLE items (id INTEGER PRIMARY KEY, order_id int REFERENCES orders (id));
        CREATE TABLE audit (what text);
        CREATE TRIGGER audit_orders AFTER INSERT ON orders
            BEGIN INSERT INTO audit VALUES ('order ' || new.id); END;
        CREATE VIEW open_orders AS SELECT id, status FROM orders WHERE status <> 'shipped';
        INSERT INTO customers VALUES (1, 'ann');
        INSERT INTO orders VALUES (1, 1, 'a@x', 'new', 1.5), (2, 1, 'b@x', 'shipped', 2);
        INSERT INTO items VALUES (1, 1);";

    /// `total` to integer: a change SQLite makes by rebuilding the table.
    fn retype_total(env: &Env, base: &TableDesign) -> DesignPlan {
        let mut total = loaded(base, "total");
        total.type_sql = "integer".into();
        env.alter(
            base,
            vec![DesignEdit::ChangeColumn {
                name: "total".into(),
                column: total,
            }],
        )
    }

    #[tokio::test]
    async fn apply_commits_and_reads_back() {
        let t = fixture().await;
        super::apply_commits_and_reads_back(&t.env).await;
    }

    #[tokio::test]
    async fn create_reads_back_the_same() {
        let t = fixture().await;
        super::create_reads_back_the_same(&t.env, "fk_0").await;
    }

    #[tokio::test]
    async fn rename_keeps_values() {
        let t = fixture().await;
        super::rename_keeps_values(&t.env).await;
    }

    #[tokio::test]
    async fn second_statement_fails_rolls_back() {
        let t = fixture().await;
        super::second_statement_fails_rolls_back(
            &t.env,
            // Unquoted: SQLite reads an unknown "nope" as a string literal.
            "CREATE INDEX \"main\".\"orders_nope_ix\" ON \"orders\" (nope)",
        )
        .await;
    }

    #[tokio::test]
    async fn read_only_refuses() {
        let t = fixture().await;
        let ro = Env {
            db: Arc::new(
                SqliteDialect::connect(&config(&t.path, true))
                    .await
                    .expect("connect"),
            ),
            kind: DialectKind::Sqlite,
            database: "main".into(),
            schema: None,
        };
        super::read_only_refuses(&t.env, &ro).await;
    }

    /// Review Focus 1.
    #[tokio::test]
    async fn sqlite_rebuild_keeps_autoindex_trigger_view_and_both_fks() {
        let t = open(SHOP).await;
        t.exec("PRAGMA foreign_keys = ON").await;
        let base = t.env.design("orders").await;
        let plan = retype_total(&t.env, &base);
        assert_eq!(plan.foreign_keys, Some(true));
        assert!(plan.statements[0].starts_with("PRAGMA foreign_keys"));
        let n = plan.statements.len();
        assert_eq!(
            t.env.apply(&plan).await.expect("apply"),
            DesignOutcome::Done { ran: n }
        );

        let after = t.env.design("orders").await;
        assert!(after.columns[4].type_sql.eq_ignore_ascii_case("integer"));
        assert_eq!(after.indexes, base.indexes, "the autoindex is back");
        assert_eq!(after.foreign_keys, base.foreign_keys);
        assert_eq!(after.referenced_by, base.referenced_by);
        assert_eq!(t.int("PRAGMA foreign_keys").await, 1);
        assert_eq!(t.int("SELECT count(*) FROM orders").await, 2);
        // The unique email still refuses a duplicate.
        assert!(
            t.refused("INSERT INTO orders (customer_id, email) VALUES (1, 'a@x')")
                .await
        );
        // The trigger fires and the view selects.
        assert_eq!(t.int("SELECT count(*) FROM audit").await, 2);
        t.exec("INSERT INTO orders (customer_id, email) VALUES (1, 'c@x')")
            .await;
        assert_eq!(t.int("SELECT count(*) FROM audit").await, 3);
        assert_eq!(t.int("SELECT count(*) FROM open_orders").await, 2);
        // Both keys still refuse an orphan.
        assert!(
            t.refused("INSERT INTO orders (customer_id, email) VALUES (42, 'z@x')")
                .await
        );
        assert!(t.refused("INSERT INTO items (order_id) VALUES (99)").await);
    }

    #[tokio::test]
    async fn fk_check_failure_rolls_back() {
        let t = open(SHOP).await;
        // An orphan written while the keys were off.
        t.exec("PRAGMA foreign_keys = OFF").await;
        t.exec("INSERT INTO orders (customer_id, email) VALUES (42, 'o@x')")
            .await;
        t.exec("PRAGMA foreign_keys = ON").await;
        let base = t.env.design("orders").await;
        let plan = retype_total(&t.env, &base);
        assert_eq!(
            t.env.apply(&plan).await.expect("apply"),
            DesignOutcome::ForeignKeys {
                table: "orders".into()
            }
        );
        assert_eq!(t.env.design("orders").await, base);
        assert_eq!(t.int("SELECT count(*) FROM orders").await, 3);
        assert_eq!(t.int("PRAGMA foreign_keys").await, 1);
    }

    /// A statement that fails in the middle rolls back, and `after` still runs.
    #[tokio::test]
    async fn failed_statement_rolls_back_and_restores_foreign_keys() {
        let t = open(SHOP).await;
        // A trigger on another table that names orders: the rename step fails.
        t.exec(
            "CREATE TRIGGER items_touch AFTER INSERT ON items \
             BEGIN UPDATE orders SET status = status WHERE id = new.order_id; END",
        )
        .await;
        t.exec("PRAGMA foreign_keys = ON").await;
        let base = t.env.design("orders").await;
        let plan = retype_total(&t.env, &base);
        let rename = plan
            .statements
            .iter()
            .position(|s| s.starts_with("ALTER TABLE"))
            .expect("rename step");
        match t.env.apply(&plan).await {
            Ok(DesignOutcome::Failed {
                statement,
                ran: 0,
                message,
            }) => {
                assert_eq!(statement, rename);
                assert!(message.contains("items_touch"), "{message}");
            }
            other => panic!("expected Failed, got {other:?}"),
        }
        assert_eq!(t.env.design("orders").await, base);
        assert_eq!(t.int("SELECT count(*) FROM orders").await, 2);
        assert_eq!(t.int("PRAGMA foreign_keys").await, 1);
    }

    /// S9: the setting changed since loading, so nothing runs.
    #[tokio::test]
    async fn changed_foreign_keys_setting_is_refused() {
        let t = open(SHOP).await;
        t.exec("PRAGMA foreign_keys = OFF").await;
        let base = t.env.design("orders").await;
        let plan = retype_total(&t.env, &base);
        assert_eq!(plan.foreign_keys, Some(false));
        t.exec("PRAGMA foreign_keys = ON").await;
        match t.env.apply(&plan).await {
            Err(Error::InvalidInput(m)) => assert!(m.contains("Reload the table"), "{m}"),
            other => panic!("expected a refusal, got {other:?}"),
        }
        // Not even the leading PRAGMA foreign_keys = OFF ran.
        assert_eq!(t.int("PRAGMA foreign_keys").await, 1);
        assert_eq!(t.env.design("orders").await.columns, base.columns);
    }

    #[tokio::test]
    async fn copy_only_is_refused() {
        let t = open(
            "CREATE TABLE c (id INTEGER PRIMARY KEY, n int CHECK (n > 0));
             INSERT INTO c VALUES (1, 5);",
        )
        .await;
        let base = t.env.design("c").await;
        let mut n = loaded(&base, "n");
        n.type_sql = "bigint".into();
        let plan = t.env.alter(
            &base,
            vec![DesignEdit::ChangeColumn {
                name: "n".into(),
                column: n,
            }],
        );
        assert!(matches!(plan.mode, DesignMode::CopyOnly { .. }));
        match t.env.apply(&plan).await {
            Err(Error::InvalidInput(m)) => {
                assert_eq!(m, "Contura cannot rebuild this table safely.")
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert_eq!(t.env.design("c").await, base);
    }
}
