//! `ConnectionService` plan, confirm and apply of table designs through the 5a
//! safety check, with Query History and Recent.

mod common;

use std::sync::Arc;

use contura_core::Error;
use contura_core::connections::{ConnectionInput, ConnectionService, PasswordChange};
use contura_core::design::{
    ColumnDraft, DesignEdit, DesignOutcome, DesignRequest, DesignTarget, DesignWarning,
    ForeignKeyDraft, IndexDraft, Position, RowCount, TableDesign,
};
use contura_core::edits::{CellChange, EditSet, NewValue, RowUpdate};
use contura_core::model::{
    Cell, ConnectionId, DialectKind, KeyPart, ObjectKind, ObjectPath, SslMode,
};
use contura_core::query::{HistoryFilter, Outcome, SavedQueryInput};
use contura_core::recent::RecentTarget;
use contura_core::safety::RunVerdict;
use contura_core::secrets::MemorySecretStore;
use contura_core::store::AppStore;

struct Fixture {
    dir: tempfile::TempDir,
    svc: Arc<ConnectionService>,
    id: ConnectionId,
    file: std::path::PathBuf,
}

fn sqlite_input(file: &std::path::Path, production: bool, read_only: bool) -> ConnectionInput {
    ConnectionInput {
        id: None,
        name: "shop".into(),
        dialect: DialectKind::Sqlite,
        host: String::new(),
        port: 0,
        user: String::new(),
        database: None,
        ssl: SslMode::Disable,
        password: PasswordChange::Keep,
        group_id: None,
        file: Some(file.to_path_buf()),
        query_timeout_secs: None,
        ai_access: Default::default(),
        production,
        read_only,
    }
}

async fn fixture(production: bool, read_only: bool) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("shop.db");
    rusqlite::Connection::open(&file)
        .unwrap()
        .execute_batch(
            "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT);
             INSERT INTO t VALUES (1, 'a'), (2, 'b');
             CREATE TABLE other(id INTEGER PRIMARY KEY, name TEXT);",
        )
        .unwrap();
    let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
    let svc = Arc::new(
        ConnectionService::new(store, Arc::new(MemorySecretStore::new()))
            .with_data_dir(common::data_dir()),
    );
    let saved = svc
        .save(sqlite_input(&file, production, read_only))
        .await
        .unwrap();
    svc.open(saved.id).await.unwrap();
    Fixture {
        dir,
        svc,
        id: saved.id,
        file,
    }
}

impl Fixture {
    /// The column names of `table`, read straight from the file.
    fn columns(&self, table: &str) -> Vec<String> {
        let conn = rusqlite::Connection::open(&self.file).unwrap();
        let mut stmt = conn
            .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
            .unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    fn has_table(&self, table: &str) -> bool {
        let conn = rusqlite::Connection::open(&self.file).unwrap();
        conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
            == 1
    }

    async fn design(&self, table: &str) -> TableDesign {
        self.svc
            .table_design(self.id, path(table))
            .await
            .expect("table design")
    }

    /// Adds a nullable TEXT column `column` to `table`.
    async fn add_column(&self, table: &str, column: &str) -> DesignRequest {
        DesignRequest {
            target: DesignTarget::Alter {
                base: self.design(table).await,
            },
            edits: vec![add(column)],
        }
    }

    fn history(&self) -> Vec<contura_core::query::HistoryEntry> {
        self.svc
            .query_history(
                Some(self.id),
                HistoryFilter {
                    search: None,
                    only: None,
                },
            )
            .unwrap()
    }
}

fn path(name: &str) -> ObjectPath {
    ObjectPath {
        database: "main".into(),
        schema: None,
        name: name.into(),
    }
}

fn column(name: &str, type_sql: &str) -> ColumnDraft {
    ColumnDraft {
        name: name.into(),
        type_sql: type_sql.into(),
        nullable: true,
        default_sql: None,
        increment: false,
        comment: None,
    }
}

fn add(name: &str) -> DesignEdit {
    DesignEdit::AddColumn {
        column: column(name, "TEXT"),
        position: Position::Last,
    }
}

/// CREATE TABLE `name` (id, label), plus an index on label when `indexed`.
fn create(name: &str, indexed: bool) -> DesignRequest {
    let mut edits = vec![
        DesignEdit::AddColumn {
            column: column("id", "INTEGER"),
            position: Position::Last,
        },
        add("label"),
    ];
    if indexed {
        edits.push(DesignEdit::AddIndex {
            index: IndexDraft {
                name: format!("{name}_label_ix"),
                columns: vec!["label".into()],
                unique: false,
                primary: false,
            },
        });
    }
    DesignRequest {
        target: DesignTarget::Create { path: path(name) },
        edits,
    }
}

#[tokio::test]
async fn plain_connection_applies_without_a_pass() {
    let f = fixture(false, false).await;
    let req = f.add_column("t", "note").await;
    let v = f.svc.plan_design(f.id, req.clone()).await.unwrap();
    assert_eq!(v.verdict, RunVerdict::Ok);
    let n = v.plan.statements.len();
    assert_eq!(
        f.svc.apply_design(f.id, req, None).await.unwrap(),
        DesignOutcome::Done { ran: n }
    );
    assert_eq!(f.columns("t"), ["id", "name", "note"]);
}

#[tokio::test]
async fn read_only_refuses_before_the_driver() {
    let f = fixture(false, true).await;
    let req = f.add_column("t", "note").await;
    let v = f.svc.plan_design(f.id, req.clone()).await.unwrap();
    assert_eq!(v.verdict, RunVerdict::ReadOnly { statement: 0 });
    match f.svc.apply_design(f.id, req, None).await {
        Err(Error::ReadOnly(0)) => {}
        other => panic!("expected ReadOnly(0), got {other:?}"),
    }
    assert_eq!(f.columns("t"), ["id", "name"]);
    assert!(f.history().is_empty());
}

#[tokio::test]
async fn production_needs_a_pass_then_applies_once() {
    let f = fixture(true, false).await;
    let req = f.add_column("t", "note").await;
    let v = f.svc.plan_design(f.id, req.clone()).await.unwrap();
    assert!(
        matches!(v.verdict, RunVerdict::NeedsConfirmation { writes: 1, .. }),
        "{:?}",
        v.verdict
    );
    assert!(matches!(
        f.svc.apply_design(f.id, req.clone(), None).await,
        Err(Error::NeedsConfirmation)
    ));
    assert_eq!(f.columns("t"), ["id", "name"]);
    let pass = f.svc.confirm_design(f.id, req.clone()).await.unwrap();
    assert!(matches!(
        f.svc.apply_design(f.id, req.clone(), Some(pass)).await,
        Ok(DesignOutcome::Done { .. })
    ));
    assert_eq!(f.columns("t"), ["id", "name", "note"]);
    // The pass is used up.
    assert!(matches!(
        f.svc.apply_design(f.id, req, Some(pass)).await,
        Err(Error::NeedsConfirmation)
    ));
}

/// Review Focus 5.
#[tokio::test]
async fn design_pass_does_not_cover_an_edited_design() {
    let f = fixture(true, false).await;
    let confirmed = f.add_column("t", "note").await;
    let pass = f.svc.confirm_design(f.id, confirmed).await.unwrap();
    let edited = f.add_column("t", "other").await;
    assert!(matches!(
        f.svc.apply_design(f.id, edited, Some(pass)).await,
        Err(Error::NeedsConfirmation)
    ));
    assert_eq!(f.columns("t"), ["id", "name"]);
}

/// Review Focus 5: the same edit on another table is another scope.
#[tokio::test]
async fn design_pass_does_not_cover_another_table() {
    let f = fixture(true, false).await;
    let pass = f
        .svc
        .confirm_design(f.id, f.add_column("t", "note").await)
        .await
        .unwrap();
    let elsewhere = f.add_column("other", "note").await;
    assert!(matches!(
        f.svc.apply_design(f.id, elsewhere, Some(pass)).await,
        Err(Error::NeedsConfirmation)
    ));
    assert_eq!(f.columns("other"), ["id", "name"]);
}

/// Review Focus 5: a pass for a 2-write plan does not authorize its 1-write subset.
#[tokio::test]
async fn design_pass_needs_the_exact_set() {
    let f = fixture(true, false).await;
    let full = create("fresh", true);
    let subset = create("fresh", false);
    let full_plan = f.svc.plan_design(f.id, full.clone()).await.unwrap().plan;
    let subset_plan = f.svc.plan_design(f.id, subset.clone()).await.unwrap().plan;
    assert_eq!(full_plan.statements.len(), 2, "{:?}", full_plan.statements);
    assert_eq!(subset_plan.statements.len(), 1);
    assert_eq!(subset_plan.statements[0], full_plan.statements[0]);
    let pass = f.svc.confirm_design(f.id, full.clone()).await.unwrap();
    assert!(matches!(
        f.svc.apply_design(f.id, subset, Some(pass)).await,
        Err(Error::NeedsConfirmation)
    ));
    assert!(!f.has_table("fresh"));
    // The refused attempt used nothing up: the pass still covers its own plan.
    assert!(matches!(
        f.svc.apply_design(f.id, full, Some(pass)).await,
        Ok(DesignOutcome::Done { ran: 2 })
    ));
    assert!(f.has_table("fresh"));
}

fn rename_row_1() -> EditSet {
    EditSet {
        table: path("t"),
        updates: vec![RowUpdate {
            key: vec![KeyPart {
                column: "id".into(),
                value: Cell::Number { value: "1".into() },
            }],
            changes: vec![CellChange {
                column: "name".into(),
                old: Cell::Text {
                    value: "a".into(),
                    truncated: false,
                    total_bytes: 1,
                },
                new: NewValue::Text { value: "z".into() },
            }],
        }],
        inserts: vec![],
        deletes: vec![],
    }
}

/// Review Focus 5: a pass for pending edits never covers a design of that table,
/// and a design's pass never covers a save of edits.
#[tokio::test]
async fn edits_pass_does_not_cover_design_and_reverse() {
    let f = fixture(true, false).await;
    let edits_pass = f.svc.confirm_edits(f.id, rename_row_1()).await.unwrap();
    let req = f.add_column("t", "note").await;
    assert!(matches!(
        f.svc
            .apply_design(f.id, req.clone(), Some(edits_pass))
            .await,
        Err(Error::NeedsConfirmation)
    ));
    assert_eq!(f.columns("t"), ["id", "name"]);

    let design_pass = f.svc.confirm_design(f.id, req).await.unwrap();
    assert!(matches!(
        f.svc
            .apply_edits(f.id, rename_row_1(), Some(design_pass))
            .await,
        Err(Error::NeedsConfirmation)
    ));
}

/// Review Focus 5: a query tab's pass for the very same text is another scope.
#[tokio::test]
async fn query_pass_does_not_cover_design() {
    let f = fixture(true, false).await;
    let req = f.add_column("t", "note").await;
    let plan = f.svc.plan_design(f.id, req.clone()).await.unwrap().plan;
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    let pass = f.svc.confirm_run(s, plan.statements.clone()).unwrap();
    assert!(matches!(
        f.svc.apply_design(f.id, req, Some(pass)).await,
        Err(Error::NeedsConfirmation)
    ));
    assert_eq!(f.columns("t"), ["id", "name"]);
}

/// Review Focus 5, the other way: a design's pass never covers a query tab's run
/// of the very same text.
#[tokio::test]
async fn design_pass_does_not_cover_a_query_run() {
    let f = fixture(true, false).await;
    let req = f.add_column("t", "note").await;
    let plan = f.svc.plan_design(f.id, req.clone()).await.unwrap().plan;
    assert_eq!(plan.statements.len(), 1, "{:?}", plan.statements);
    let pass = f.svc.confirm_design(f.id, req).await.unwrap();
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    assert!(matches!(
        f.svc
            .execute_sql(s, plan.statements[0].clone(), Some(pass))
            .await,
        Err(Error::NeedsConfirmation)
    ));
    assert_eq!(f.columns("t"), ["id", "name"]);
}

#[tokio::test]
async fn apply_adds_one_history_entry() {
    let f = fixture(false, false).await;
    let req = create("fresh", true);
    let plan = f.svc.plan_design(f.id, req.clone()).await.unwrap().plan;
    f.svc.apply_design(f.id, req, None).await.unwrap();
    let history = f.history();
    assert_eq!(history.len(), 1, "{history:?}");
    assert_eq!(history[0].sql, plan.statements.join(";\n"));
    assert_eq!(history[0].outcome, Outcome::Ok);
    assert!(history[0].changed);
    assert_eq!(history[0].error, None);
}

#[tokio::test]
async fn clean_failure_adds_no_history() {
    let f = fixture(false, false).await;
    // The table already exists, so the CREATE fails before anything is applied.
    match f.svc.apply_design(f.id, create("t", false), None).await {
        Err(Error::DesignFailed {
            statement: 0,
            ran: 0,
            total: 1,
            ..
        }) => {}
        other => panic!("expected DesignFailed with nothing run, got {other:?}"),
    }
    assert!(f.history().is_empty());
}

fn drop_rows(v: &contura_core::connections::DesignVerdict) -> Option<RowCount> {
    v.plan.warnings.iter().find_map(|w| match w {
        DesignWarning::DropTable { rows, .. } => *rows,
        _ => None,
    })
}

#[tokio::test]
async fn drop_counts_rows_bounded() {
    let f = fixture(false, false).await;
    {
        let conn = rusqlite::Connection::open(&f.file).unwrap();
        conn.execute_batch(
            "CREATE TABLE big(id INTEGER PRIMARY KEY);
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10001)
             INSERT INTO big SELECT i FROM n;",
        )
        .unwrap();
    }
    let drop = |base: TableDesign| DesignRequest {
        target: DesignTarget::Drop { base },
        edits: vec![],
    };
    let big = f
        .svc
        .plan_design(f.id, drop(f.design("big").await))
        .await
        .unwrap();
    assert_eq!(drop_rows(&big), Some(RowCount::Over { n: 10000 }));
    let small = f
        .svc
        .plan_design(f.id, drop(f.design("t").await))
        .await
        .unwrap();
    assert_eq!(drop_rows(&small), Some(RowCount::Exact { n: 2 }));
    // Planning never drops anything.
    assert!(f.has_table("big"));
}

#[tokio::test]
async fn forget_recent_removes_only_that_table() {
    let f = fixture(false, false).await;
    let other_conn = f
        .svc
        .save(sqlite_input(&f.dir.path().join("other.db"), false, false))
        .await
        .unwrap()
        .id;
    let q = f
        .svc
        .save_saved_query(SavedQueryInput {
            id: None,
            name: "daily".into(),
            sql: "SELECT 1".into(),
            connection_id: None,
            kind: Default::default(),
            visual_json: None,
        })
        .unwrap();
    let table = |name: &str, object: ObjectKind| RecentTarget::Table {
        path: path(name),
        object,
    };
    let svc = &f.svc;
    svc.record_recent(table("t", ObjectKind::Table), Some(f.id))
        .unwrap();
    svc.record_recent(table("t", ObjectKind::View), Some(f.id))
        .unwrap();
    svc.record_recent(table("other", ObjectKind::Table), Some(f.id))
        .unwrap();
    svc.record_recent(table("t", ObjectKind::Table), Some(other_conn))
        .unwrap();
    svc.record_recent(
        RecentTarget::Query {
            saved_id: q.id,
            name: q.name.clone(),
        },
        Some(f.id),
    )
    .unwrap();

    svc.forget_recent(f.id, &path("t")).unwrap();

    let left: Vec<(RecentTarget, Option<ConnectionId>)> = svc
        .recent_items()
        .unwrap()
        .into_iter()
        .map(|i| (i.target, i.connection_id))
        .collect();
    assert_eq!(
        left,
        vec![
            (
                RecentTarget::Query {
                    saved_id: q.id,
                    name: "daily".into(),
                },
                Some(f.id),
            ),
            (table("t", ObjectKind::Table), Some(other_conn)),
            (table("other", ObjectKind::Table), Some(f.id)),
        ]
    );
}

#[tokio::test]
async fn table_ddl_reads_the_create_statement() {
    let f = fixture(false, true).await;
    let ddl = f.svc.table_ddl(f.id, path("t")).await.unwrap();
    assert!(ddl.contains("CREATE TABLE"), "{ddl}");
    assert!(ddl.contains("name"), "{ddl}");
}

/// Review Focus 2: the statements MySQL already committed are one history entry.
#[tokio::test]
async fn mysql_partial_failure_is_one_history_entry() {
    use mysql_async::prelude::Queryable;

    let db = common::TestDb::create().await;
    {
        let opts: mysql_async::Opts = mysql_async::OptsBuilder::default()
            .ip_or_hostname(db.config.host.clone())
            .tcp_port(db.config.port)
            .user(Some(db.config.user.clone()))
            .pass(db.password.clone())
            .db_name(Some(db.name.clone()))
            .into();
        let mut c = mysql_async::Conn::new(opts).await.unwrap();
        for sql in [
            "CREATE TABLE customers (id int PRIMARY KEY, name varchar(40))",
            "CREATE TABLE orders (id int PRIMARY KEY, customer_id int, \
             CONSTRAINT fk_a FOREIGN KEY (customer_id) REFERENCES customers (id))",
        ] {
            c.query_drop(sql).await.unwrap();
        }
        c.disconnect().await.ok();
    }
    let dir = tempfile::tempdir().unwrap();
    let svc = ConnectionService::new(
        AppStore::open(&dir.path().join("app.sqlite")).unwrap(),
        Arc::new(MemorySecretStore::new()),
    )
    .with_data_dir(common::data_dir());
    let id = svc
        .save(ConnectionInput {
            id: None,
            name: "m".into(),
            dialect: DialectKind::MySql,
            host: db.config.host.clone(),
            port: db.config.port,
            user: db.config.user.clone(),
            database: db.config.database.clone(),
            ssl: SslMode::Disable,
            password: PasswordChange::Set {
                value: db.password.clone().unwrap(),
            },
            group_id: None,
            file: None,
            query_timeout_secs: None,
            ai_access: Default::default(),
            production: false,
            read_only: false,
        })
        .await
        .unwrap()
        .id;
    svc.open(id).await.unwrap();
    let orders = ObjectPath {
        database: db.name.clone(),
        schema: None,
        name: "orders".into(),
    };
    let base = svc.table_design(id, orders.clone()).await.unwrap();
    let req = DesignRequest {
        target: DesignTarget::Alter { base },
        edits: vec![
            DesignEdit::DropForeignKey {
                name: "fk_a".into(),
            },
            DesignEdit::AddForeignKey {
                key: ForeignKeyDraft {
                    name: "fk_b".into(),
                    columns: vec!["customer_id".into()],
                    target: ObjectPath {
                        database: db.name.clone(),
                        schema: None,
                        name: "nowhere".into(),
                    },
                    target_columns: vec!["id".into()],
                    on_delete: None,
                    on_update: None,
                },
            },
        ],
    };
    let plan = svc.plan_design(id, req.clone()).await.unwrap().plan;
    assert_eq!(plan.statements.len(), 2, "{:?}", plan.statements);
    match svc.apply_design(id, req, None).await {
        Err(Error::DesignFailed {
            statement: 1,
            ran: 1,
            total: 2,
            message,
        }) => assert!(!message.is_empty()),
        other => panic!("expected DesignFailed at 1 with 1 run, got {other:?}"),
    }
    let history = svc
        .query_history(
            Some(id),
            HistoryFilter {
                search: None,
                only: None,
            },
        )
        .unwrap();
    assert_eq!(history.len(), 1, "{history:?}");
    // D12: only the statement that was applied, the Foreign Key drop.
    assert_eq!(history[0].sql, plan.statements[0]);
    assert_eq!(history[0].outcome, Outcome::Error);
    assert!(history[0].changed);
    assert!(history[0].error.as_deref().is_some_and(|e| !e.is_empty()));
    // The Foreign Key drop landed.
    let after = svc.table_design(id, orders).await.unwrap();
    assert!(after.foreign_keys.is_empty(), "{:?}", after.foreign_keys);
    svc.close(id).await.unwrap();
    db.drop_db().await;
}

/// I1: PostgreSQL's DDL is the server's own text, and it builds the same table.
#[tokio::test]
async fn postgres_table_ddl_is_the_servers_own_text() {
    use common::pg::{PgTestDb, pg_admin_client};

    const CUSTOMERS: &str = "CREATE TABLE customers (id int PRIMARY KEY)";
    let db = PgTestDb::create().await;
    pg_admin_client(&db.name)
        .await
        .batch_execute(&format!(
            "{CUSTOMERS};
             CREATE TABLE t (
               id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
               name text COLLATE \"C\" NOT NULL,
               email text,
               price numeric(10,2) CONSTRAINT t_price_check CHECK (price >= 0),
               doubled numeric GENERATED ALWAYS AS (price * 2) STORED,
               customer_id int REFERENCES customers (id) ON DELETE CASCADE,
               CONSTRAINT t_email_key UNIQUE (email)
             );
             CREATE INDEX t_lower_name ON t (lower(name));
             CREATE UNIQUE INDEX t_paid_email ON t (email) WHERE price > 0;
             CREATE INDEX t_name_incl ON t (name) INCLUDE (email);
             COMMENT ON TABLE t IS 'things';"
        ))
        .await
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let svc = ConnectionService::new(
        AppStore::open(&dir.path().join("app.sqlite")).unwrap(),
        Arc::new(MemorySecretStore::new()),
    )
    .with_data_dir(common::data_dir());
    let id = svc
        .save(ConnectionInput {
            id: None,
            name: "p".into(),
            dialect: DialectKind::Postgres,
            host: db.config.host.clone(),
            port: db.config.port,
            user: db.config.user.clone(),
            database: db.config.database.clone(),
            ssl: SslMode::Disable,
            password: PasswordChange::Set {
                value: db.password.clone().unwrap(),
            },
            group_id: None,
            file: None,
            query_timeout_secs: None,
            ai_access: Default::default(),
            production: false,
            read_only: true,
        })
        .await
        .unwrap()
        .id;
    svc.open(id).await.unwrap();
    let ddl = svc
        .table_ddl(
            id,
            ObjectPath {
                database: db.name.clone(),
                schema: Some("public".into()),
                name: "t".into(),
            },
        )
        .await
        .unwrap();
    for part in [
        "\"id\" integer GENERATED ALWAYS AS IDENTITY NOT NULL",
        "COLLATE pg_catalog.\"C\"",
        "GENERATED ALWAYS AS ((price * (2)::numeric)) STORED",
        "CONSTRAINT \"t_price_check\" CHECK (price >= 0::numeric)",
        "CONSTRAINT \"t_email_key\" UNIQUE (email)",
        "ON DELETE CASCADE",
        "USING btree (lower(name))",
        "WHERE (price > (0)::numeric)",
        "INCLUDE (email)",
        "COMMENT ON TABLE \"public\".\"t\" IS 'things';",
    ] {
        assert!(ddl.contains(part), "missing {part} in:\n{ddl}");
    }
    // The constraint's own index is not written a second time.
    assert!(!ddl.contains("INDEX t_email_key"), "{ddl}");
    svc.close(id).await.unwrap();

    // The text builds the same table in a fresh database.
    let fresh = PgTestDb::create().await;
    let client = pg_admin_client(&fresh.name).await;
    client.batch_execute(CUSTOMERS).await.unwrap();
    client
        .batch_execute(&ddl)
        .await
        .unwrap_or_else(|e| panic!("{e}:\n{ddl}"));
    async fn shape(client: &tokio_postgres::Client) -> (Vec<String>, Vec<String>) {
        let column = |rows: Vec<tokio_postgres::Row>| -> Vec<String> {
            rows.iter().map(|r| r.get(0)).collect()
        };
        let indexes = client
            .query(
                "SELECT indexdef FROM pg_indexes WHERE tablename = 't' ORDER BY indexname",
                &[],
            )
            .await
            .unwrap();
        let constraints = client
            .query(
                "SELECT pg_get_constraintdef(oid) FROM pg_constraint \
                 WHERE conrelid = 'public.t'::regclass ORDER BY conname",
                &[],
            )
            .await
            .unwrap();
        (column(indexes), column(constraints))
    }
    let original = pg_admin_client(&db.name).await;
    assert_eq!(shape(&client).await, shape(&original).await);
    drop((client, original));
    fresh.drop_db().await;
    db.drop_db().await;
}

const TABLE_CHANGED: &str =
    "The table changed since it was opened. Reload it and make the change again.";

fn assert_table_changed(result: contura_core::error::Result<DesignOutcome>) {
    match result {
        Err(Error::InvalidInput(m)) if m == TABLE_CHANGED => {}
        other => panic!("expected the table-changed refusal, got {other:?}"),
    }
}

fn retype(name: &str, type_sql: &str) -> DesignEdit {
    DesignEdit::ChangeColumn {
        name: name.into(),
        column: column(name, type_sql),
    }
}

fn alter(base: TableDesign, edits: Vec<DesignEdit>) -> DesignRequest {
    DesignRequest {
        target: DesignTarget::Alter { base },
        edits,
    }
}

fn drop_request(base: TableDesign) -> DesignRequest {
    DesignRequest {
        target: DesignTarget::Drop { base },
        edits: vec![],
    }
}

impl Fixture {
    fn sql(&self, sql: &str) {
        rusqlite::Connection::open(&self.file)
            .unwrap()
            .execute_batch(sql)
            .unwrap();
    }

    fn texts(&self, sql: &str) -> Vec<String> {
        let conn = rusqlite::Connection::open(&self.file).unwrap();
        let mut stmt = conn.prepare(sql).unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }
}

/// S14 (C1): a SQLite rebuild planned from a design loaded before a column, an
/// index and a trigger were added is refused, and nothing is lost.
#[tokio::test]
async fn sqlite_rebuild_of_a_table_changed_since_load_is_refused() {
    let f = fixture(false, false).await;
    let base = f.design("t").await;
    f.sql(
        "ALTER TABLE t ADD COLUMN note TEXT;
         UPDATE t SET note = 'keep';
         CREATE INDEX t_name ON t (name);
         CREATE TRIGGER t_touch AFTER UPDATE ON t BEGIN SELECT 1; END;",
    );
    let req = alter(base, vec![retype("name", "INTEGER")]);
    let plan = f.svc.plan_design(f.id, req.clone()).await.unwrap().plan;
    assert!(
        plan.statements.len() > 1,
        "a rebuild: {:?}",
        plan.statements
    );
    assert_table_changed(f.svc.apply_design(f.id, req, None).await);
    assert_eq!(f.columns("t"), ["id", "name", "note"]);
    assert_eq!(f.texts("SELECT note FROM t ORDER BY id"), ["keep", "keep"]);
    assert_eq!(
        f.texts(
            "SELECT name FROM sqlite_master WHERE tbl_name = 't' AND type <> 'table' ORDER BY name"
        ),
        ["t_name", "t_touch"]
    );
    assert!(f.history().is_empty());

    // Reloaded, the same change applies and keeps what was added.
    let req = alter(f.design("t").await, vec![retype("name", "INTEGER")]);
    f.svc.apply_design(f.id, req, None).await.unwrap();
    assert_eq!(f.columns("t"), ["id", "name", "note"]);
    assert_eq!(f.texts("SELECT note FROM t ORDER BY id"), ["keep", "keep"]);
}

/// S14 (C1): an in-place change and a drop are checked too.
#[tokio::test]
async fn sqlite_in_place_change_and_drop_of_a_changed_table_are_refused() {
    let f = fixture(false, false).await;
    let base = f.design("t").await;
    f.sql("CREATE INDEX t_name ON t (name);");
    let req = alter(base.clone(), vec![add("note")]);
    assert_table_changed(f.svc.apply_design(f.id, req, None).await);
    assert_eq!(f.columns("t"), ["id", "name"]);
    assert_table_changed(f.svc.apply_design(f.id, drop_request(base), None).await);
    assert!(f.has_table("t"));
}

/// I1: with Foreign Keys on, a SQLite drop names what it does to each child
/// table, and does it.
#[tokio::test]
async fn sqlite_drop_names_each_child_action() {
    use contura_core::design::ChildAction;

    let f = fixture(false, false).await;
    f.sql(
        "CREATE TABLE customers (id INTEGER PRIMARY KEY);
         CREATE TABLE orders (id INTEGER PRIMARY KEY,
           customer_id INTEGER REFERENCES customers (id) ON DELETE CASCADE);
         CREATE TABLE notes (id INTEGER PRIMARY KEY,
           customer_id INTEGER REFERENCES customers (id) ON DELETE SET NULL);
         INSERT INTO customers VALUES (1);
         INSERT INTO orders VALUES (1, 1), (2, 1);
         INSERT INTO notes VALUES (1, 1);",
    );
    let base = f.design("customers").await;
    assert!(base.sqlite.as_ref().unwrap().foreign_keys_on);
    let req = drop_request(base);
    let plan = f.svc.plan_design(f.id, req.clone()).await.unwrap().plan;
    let child = |child: &str, action| DesignWarning::ChildRows {
        table: "customers".into(),
        child: child.into(),
        action,
    };
    assert_eq!(
        plan.warnings[1..],
        [
            child("orders", ChildAction::Delete),
            child("notes", ChildAction::Clear)
        ],
        "{:?}",
        plan.warnings
    );
    f.svc.apply_design(f.id, req, None).await.unwrap();
    assert!(!f.has_table("customers"));
    assert!(f.texts("SELECT CAST(id AS TEXT) FROM orders").is_empty());
    assert_eq!(
        f.texts("SELECT coalesce(CAST(customer_id AS TEXT), 'null') FROM notes"),
        ["null"]
    );
}

/// S15: a SQLite Drop also refuses when a child table changed since loading,
/// here its key turned to CASCADE, so the warning shown is never stale.
#[tokio::test]
async fn sqlite_drop_refuses_when_a_child_changed_since_load() {
    let f = fixture(false, false).await;
    f.sql(
        "CREATE TABLE customers (id INTEGER PRIMARY KEY);
         CREATE TABLE orders (id INTEGER PRIMARY KEY,
           customer_id INTEGER REFERENCES customers (id) ON DELETE RESTRICT);
         INSERT INTO customers VALUES (1);
         INSERT INTO orders VALUES (1, 1), (2, 1);",
    );
    let base = f.design("customers").await;
    assert_eq!(base.sqlite.as_ref().unwrap().children.len(), 1);
    f.sql(
        "CREATE TABLE orders_new (id INTEGER PRIMARY KEY,
           customer_id INTEGER REFERENCES customers (id) ON DELETE CASCADE);
         INSERT INTO orders_new SELECT * FROM orders;
         DROP TABLE orders;
         ALTER TABLE orders_new RENAME TO orders;",
    );
    assert_table_changed(f.svc.apply_design(f.id, drop_request(base), None).await);
    assert!(f.has_table("customers"));
    assert_eq!(
        f.texts("SELECT CAST(id AS TEXT) FROM orders ORDER BY id"),
        ["1", "2"]
    );

    // A child created since loading refuses too.
    let base = f.design("customers").await;
    f.sql("CREATE TABLE notes (id INTEGER PRIMARY KEY, c INTEGER REFERENCES customers (id));");
    assert_table_changed(f.svc.apply_design(f.id, drop_request(base), None).await);
    assert!(f.has_table("customers"));
}

async fn server_service(
    dialect: DialectKind,
    config: &contura_core::model::ConnectionConfig,
    password: &str,
) -> (tempfile::TempDir, ConnectionService, ConnectionId) {
    let dir = tempfile::tempdir().unwrap();
    let svc = ConnectionService::new(
        AppStore::open(&dir.path().join("app.sqlite")).unwrap(),
        Arc::new(MemorySecretStore::new()),
    )
    .with_data_dir(common::data_dir());
    let id = svc
        .save(ConnectionInput {
            id: None,
            name: "s".into(),
            dialect,
            host: config.host.clone(),
            port: config.port,
            user: config.user.clone(),
            database: config.database.clone(),
            ssl: SslMode::Disable,
            password: PasswordChange::Set {
                value: password.to_string(),
            },
            group_id: None,
            file: None,
            query_timeout_secs: None,
            ai_access: Default::default(),
            production: false,
            read_only: false,
        })
        .await
        .unwrap()
        .id;
    svc.open(id).await.unwrap();
    (dir, svc, id)
}

/// S14 (C1): MySQL reads the table again at Apply and refuses a stale design.
#[tokio::test]
async fn mysql_change_of_a_table_changed_since_load_is_refused() {
    use mysql_async::prelude::Queryable;

    let db = common::TestDb::create().await;
    let opts: mysql_async::Opts = mysql_async::OptsBuilder::default()
        .ip_or_hostname(db.config.host.clone())
        .tcp_port(db.config.port)
        .user(Some(db.config.user.clone()))
        .pass(db.password.clone())
        .db_name(Some(db.name.clone()))
        .into();
    let mut c = mysql_async::Conn::new(opts).await.unwrap();
    c.query_drop("CREATE TABLE orders (id int PRIMARY KEY, total int)")
        .await
        .unwrap();
    c.query_drop("INSERT INTO orders VALUES (1, 10)")
        .await
        .unwrap();
    let password = db.password.clone().unwrap();
    let (_dir, svc, id) = server_service(DialectKind::MySql, &db.config, &password).await;
    let orders = ObjectPath {
        database: db.name.clone(),
        schema: None,
        name: "orders".into(),
    };
    let base = svc.table_design(id, orders.clone()).await.unwrap();
    c.query_drop("ALTER TABLE orders ADD COLUMN note varchar(20)")
        .await
        .unwrap();
    c.query_drop("UPDATE orders SET note = 'keep'")
        .await
        .unwrap();
    let req = alter(base.clone(), vec![retype("total", "bigint")]);
    assert_table_changed(svc.apply_design(id, req, None).await);
    assert_table_changed(svc.apply_design(id, drop_request(base), None).await);
    let after = svc.table_design(id, orders.clone()).await.unwrap();
    let shape: Vec<(&str, &str)> = after
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c.type_sql.as_str()))
        .collect();
    assert_eq!(
        shape,
        [("id", "int"), ("total", "int"), ("note", "varchar(20)")]
    );
    let note: Option<String> = c
        .query_first("SELECT note FROM orders WHERE id = 1")
        .await
        .unwrap();
    assert_eq!(note.as_deref(), Some("keep"));
    // Reloaded, the change applies.
    let req = alter(after, vec![retype("total", "bigint")]);
    svc.apply_design(id, req, None).await.unwrap();
    c.disconnect().await.ok();
    svc.close(id).await.unwrap();
    db.drop_db().await;
}

/// S14 (C1): PostgreSQL reads the table again at Apply and refuses a stale design.
#[tokio::test]
async fn postgres_change_of_a_table_changed_since_load_is_refused() {
    use common::pg::{PgTestDb, pg_admin_client};

    let db = PgTestDb::create().await;
    let client = pg_admin_client(&db.name).await;
    client
        .batch_execute(
            "CREATE TABLE orders (id int PRIMARY KEY, total int);
             INSERT INTO orders VALUES (1, 10);",
        )
        .await
        .unwrap();
    let password = db.password.clone().unwrap();
    let (_dir, svc, id) = server_service(DialectKind::Postgres, &db.config, &password).await;
    let orders = ObjectPath {
        database: db.name.clone(),
        schema: Some("public".into()),
        name: "orders".into(),
    };
    let base = svc.table_design(id, orders.clone()).await.unwrap();
    client
        .batch_execute(
            "ALTER TABLE orders ALTER COLUMN total SET DEFAULT 7;
             ALTER TABLE orders ADD COLUMN note text;
             UPDATE orders SET note = 'keep';",
        )
        .await
        .unwrap();
    let req = alter(base.clone(), vec![retype("total", "bigint")]);
    assert_table_changed(svc.apply_design(id, req, None).await);
    assert_table_changed(svc.apply_design(id, drop_request(base), None).await);
    let after = svc.table_design(id, orders.clone()).await.unwrap();
    let total = after.columns.iter().find(|c| c.name == "total").unwrap();
    assert_eq!(total.type_sql, "integer");
    assert_eq!(total.default_sql.as_deref(), Some("7"));
    let note: String = client
        .query_one("SELECT note FROM orders WHERE id = 1", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(note, "keep");
    // Reloaded, the change applies.
    let req = alter(after, vec![retype("total", "bigint")]);
    svc.apply_design(id, req, None).await.unwrap();
    drop(client);
    svc.close(id).await.unwrap();
    db.drop_db().await;
}
