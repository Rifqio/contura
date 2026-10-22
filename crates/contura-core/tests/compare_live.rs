//! Live Schema Compare tests, part 1: data-loss counts on the target. A removed
//! column counts its non-null values, a removed table its rows, a narrowed
//! column its values; a count that runs past its limit falls back to the
//! server's estimate ("about"). Then the Sync Script, applied on each Dialect:
//! everything ticked, then compared again, gives no differences. Part 2: the
//! service, its pass rules and History (see `mod service`).

mod common;

use std::sync::Arc;
use std::time::Duration;

use contura_core::compare::{
    CompareOptions, DataLoss, DiffKind, DiffObject, SchemaDiff, SyncPlan, TargetDesigns,
    count_data_loss, count_data_loss_budget, count_data_loss_within, diff, plan_sync,
};
use contura_core::dialect::Dialect;
use contura_core::model::DialectKind;
use contura_core::model::ObjectPath;
use contura_core::query::SessionHandle;
use contura_core::schema_model::SchemaModel;
use contura_core::schema_model::{SmColumn, SmEndpoint, SmIndex, SmRef, SmTable};

struct Env {
    db: Arc<dyn Dialect>,
    kind: DialectKind,
    database: String,
    schema: Option<String>,
}

/// `(id, fax, code)`: fax holds 3 values in 5 rows, code 5.
const LOSS_ROWS: &str = "INSERT INTO dbview_loss (id, fax, code) VALUES \
    (1, 'a', 'x'), (2, NULL, 'x'), (3, 'b', 'x'), (4, NULL, 'x'), (5, 'c', 'x')";

impl Env {
    async fn session(&self) -> SessionHandle {
        self.db
            .open_query_session(Some(&self.database))
            .await
            .expect("query session")
    }

    async fn run(&self, s: &SessionHandle, sql: &str) {
        s.execute(sql)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }

    /// `dbview_loss` (5 rows), `dbview_old` (4 rows) and `dbview_big` (with
    /// `big`, 2,097,152 rows: too many to count in 1 ms on any host).
    async fn seed(&self, s: &SessionHandle, big: bool) {
        let big_id = match self.kind {
            DialectKind::Postgres => "id serial PRIMARY KEY",
            DialectKind::MySql => "id int AUTO_INCREMENT PRIMARY KEY",
            DialectKind::Sqlite => "id integer PRIMARY KEY",
        };
        for sql in [
            "CREATE TABLE dbview_loss (id int PRIMARY KEY, fax varchar(20), code varchar(30))",
            LOSS_ROWS,
            "CREATE TABLE dbview_old (id int PRIMARY KEY)",
            "INSERT INTO dbview_old (id) VALUES (1), (2), (3), (4)",
        ] {
            self.run(s, sql).await;
        }
        if !big {
            return;
        }
        self.run(s, &format!("CREATE TABLE dbview_big ({big_id}, v int)"))
            .await;
        match self.kind {
            DialectKind::Postgres => {
                self.run(
                    s,
                    &format!("INSERT INTO dbview_big (v) SELECT 1 FROM generate_series(1, {BIG})"),
                )
                .await
            }
            DialectKind::Sqlite => {
                self.run(
                    s,
                    &format!(
                        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < {BIG})                          INSERT INTO dbview_big (v) SELECT 1 FROM n"
                    ),
                )
                .await
            }
            // MySQL has no generate_series; 21 doublings of one row.
            DialectKind::MySql => {
                self.run(s, "INSERT INTO dbview_big (v) VALUES (1)").await;
                for _ in 0..21 {
                    self.run(s, "INSERT INTO dbview_big (v) SELECT v FROM dbview_big")
                        .await;
                }
            }
        }
        // Fresh statistics, so the estimate has something to read.
        match self.kind {
            DialectKind::Postgres => self.run(s, "ANALYZE dbview_big").await,
            DialectKind::MySql => self.run(s, "ANALYZE TABLE dbview_big").await,
            DialectKind::Sqlite => {}
        }
    }

    async fn snapshot(&self) -> SchemaModel {
        self.db
            .schema_snapshot(&self.database, self.schema.as_deref())
            .await
            .expect("snapshot")
    }

    fn compare(&self, source: &SchemaModel, target: &SchemaModel) -> SchemaDiff {
        diff(
            source,
            target,
            &CompareOptions {
                source_schema: self.schema.clone(),
                target_schema: self.schema.clone(),
                lower_case_table_names: 0,
            },
        )
    }
}

/// The source: the target without `fax`, `dbview_old` and `dbview_big.v`, with
/// `code` narrowed. `big` decides whether `dbview_big.v` goes too.
fn source_of(target: &SchemaModel, big: bool) -> SchemaModel {
    let mut s = target.clone();
    s.tables.retain(|t| t.name != "dbview_old");
    for t in &mut s.tables {
        match t.name.as_str() {
            "dbview_loss" if !big => {
                t.columns.retain(|c| c.name != "fax");
                for c in t.columns.iter_mut().filter(|c| c.name == "code") {
                    c.type_name = "varchar(10)".into();
                }
            }
            "dbview_big" if big => t.columns.retain(|c| c.name != "v"),
            _ => {}
        }
    }
    s
}

fn loss_of(
    d: &SchemaDiff,
    counts: &std::collections::HashMap<contura_core::compare::ItemId, DataLoss>,
    object: DiffObject,
    kind: DiffKind,
    name: &str,
) -> Option<DataLoss> {
    let item = d
        .items
        .iter()
        .find(|i| i.object == object && i.kind == kind && i.path.name == name)
        .unwrap_or_else(|| panic!("no {object:?} {kind:?} {name} in {:#?}", d.items));
    assert!(item.loses_data, "{name} should lose data");
    counts.get(&item.id).copied()
}

/// The big table's rows.
const BIG: u64 = 2_097_152;

async fn exact_counts(env: &Env) {
    let s = env.session().await;
    env.seed(&s, false).await;
    let target = env.snapshot().await;
    let d = env.compare(&source_of(&target, false), &target);
    let counts = count_data_loss(&s, env.kind, &d).await;
    // A removed column counts its non-null values.
    assert_eq!(
        loss_of(&d, &counts, DiffObject::Column, DiffKind::Removed, "fax"),
        Some(DataLoss {
            rows: 3,
            exact: true
        })
    );
    assert_eq!(
        loss_of(
            &d,
            &counts,
            DiffObject::Table,
            DiffKind::Removed,
            "dbview_old"
        ),
        Some(DataLoss {
            rows: 4,
            exact: true
        })
    );
    assert_eq!(
        loss_of(&d, &counts, DiffObject::Column, DiffKind::Changed, "code"),
        Some(DataLoss {
            rows: 5,
            exact: true
        })
    );
    s.close().await.ok();
}

async fn slow_count_is_an_estimate(env: &Env) {
    let s = env.session().await;
    env.seed(&s, true).await;
    let target = env.snapshot().await;
    let d = env.compare(&source_of(&target, true), &target);
    let counts = count_data_loss_within(&s, env.kind, &d, Duration::from_millis(1)).await;
    let loss =
        loss_of(&d, &counts, DiffObject::Column, DiffKind::Removed, "v").expect("an estimate");
    assert!(!loss.exact, "{loss:?}");
    assert!(
        (BIG / 2..=BIG * 2).contains(&loss.rows),
        "about {} rows",
        loss.rows
    );
    // A spent budget counts nothing.
    let none = count_data_loss_budget(&s, env.kind, &d, COUNT, Duration::ZERO).await;
    assert!(none.is_empty(), "{none:?}");
    // A budget that ends during the first count leaves the second item out.
    // (Over the network a count takes longer than 1 ms; SQLite may not.)
    if env.kind != DialectKind::Sqlite {
        let some = count_data_loss_budget(&s, env.kind, &d, COUNT, Duration::from_millis(1)).await;
        assert!(some.len() < 2, "{some:?}");
    }
    // The session still works after the stopped count.
    let again = count_data_loss(&s, env.kind, &d).await;
    let exact = loss_of(&d, &again, DiffObject::Column, DiffKind::Removed, "v").unwrap();
    assert_eq!(
        exact,
        DataLoss {
            rows: BIG,
            exact: true
        }
    );
    s.close().await.ok();
}

const COUNT: Duration = Duration::from_secs(2);

// ---------------------------------------------------------------------------
// The Sync Script, applied.

/// `dbview_customers`, `dbview_orders` (a key to customers, indexes on code
/// and on the key) and `dbview_old`, a row each.
async fn seed_sync(env: &Env, s: &SessionHandle) {
    for sql in [
        "CREATE TABLE dbview_customers (id int PRIMARY KEY, email varchar(50))",
        "CREATE TABLE dbview_orders (id int PRIMARY KEY, customer_id int, fax varchar(20), \
         code varchar(16), FOREIGN KEY (customer_id) REFERENCES dbview_customers (id))",
        "CREATE INDEX dbview_ix_code ON dbview_orders (code)",
        // An index of its own for the key; a generated one is covered by
        // mysql::changed_key_with_its_own_generated_index.
        "CREATE INDEX dbview_ix_customer ON dbview_orders (customer_id)",
        "CREATE TABLE dbview_old (id int PRIMARY KEY)",
        "INSERT INTO dbview_customers (id, email) VALUES (1, 'a@x')",
        "INSERT INTO dbview_orders (id, customer_id, fax, code) VALUES (1, 1, 'f', 'c')",
        "INSERT INTO dbview_old (id) VALUES (1)",
    ] {
        env.run(s, sql).await;
    }
}

/// The target changed in every way the script handles: a column dropped,
/// widened and added, an index dropped and added, a key changed, a table
/// dropped and a table added with a key and an index.
fn sync_source(target: &SchemaModel) -> SchemaModel {
    let mut s = target.clone();
    s.tables.retain(|t| t.name != "dbview_old");
    let orders = s
        .tables
        .iter_mut()
        .find(|t| t.name == "dbview_orders")
        .expect("orders");
    let id = orders
        .columns
        .iter()
        .find(|c| c.name == "id")
        .expect("id")
        .clone();
    let schema = orders.schema.clone();
    orders.columns.retain(|c| c.name != "fax");
    for c in orders.columns.iter_mut().filter(|c| c.name == "code") {
        c.type_name = c.type_name.replace("16", "24");
    }
    orders.columns.push(SmColumn {
        name: "due".into(),
        type_name: "date".into(),
        pk: false,
        increment: false,
        not_null: false,
        unique: false,
        default: None,
        note: None,
    });
    orders
        .indexes
        .retain(|i| i.name.as_deref() != Some("dbview_ix_code"));
    let index = |name: &str, column: &str| SmIndex {
        name: Some(name.into()),
        columns: vec![column.into()],
        unique: false,
        pk: false,
    };
    orders.indexes.push(index("dbview_ix_due", "due"));
    let order_id = SmColumn {
        name: "order_id".into(),
        pk: false,
        not_null: false,
        ..id.clone()
    };
    s.tables.push(SmTable {
        schema: schema.clone(),
        name: "dbview_refunds".into(),
        alias: None,
        note: None,
        columns: vec![id, order_id],
        indexes: vec![index("dbview_ix_order", "order_id")],
    });
    for r in s
        .refs
        .iter_mut()
        .filter(|r| r.from.table == "dbview_orders")
    {
        r.on_delete = Some("CASCADE".into());
    }
    let end = |table: &str, column: &str| SmEndpoint {
        schema: schema.clone(),
        table: table.into(),
        columns: vec![column.into()],
    };
    s.refs.push(SmRef {
        name: None,
        from: end("dbview_refunds", "order_id"),
        to: end("dbview_orders", "id"),
        on_delete: None,
        on_update: None,
    });
    s
}

/// `table_design` of every target table an item changes, and every table and
/// index name in the target.
async fn designs_for(env: &Env, d: &SchemaDiff, target: &SchemaModel) -> TargetDesigns {
    let mut names = std::collections::BTreeSet::new();
    for i in d.items.iter().filter(|i| i.object != DiffObject::Enum) {
        let t = i.path.table.clone().unwrap_or_else(|| i.path.name.clone());
        if target.tables.iter().any(|x| x.name == t) {
            names.insert(t);
        }
    }
    let mut tables = Vec::new();
    for name in names {
        let path = ObjectPath {
            database: env.database.clone(),
            schema: env.schema.clone(),
            name,
        };
        tables.push(env.db.table_design(&path).await.expect("design"));
    }
    let taken_names = target
        .tables
        .iter()
        .flat_map(|t| {
            std::iter::once(t.name.clone()).chain(t.indexes.iter().filter_map(|i| i.name.clone()))
        })
        .collect();
    TargetDesigns {
        database: env.database.clone(),
        tables,
        taken_names,
    }
}

async fn apply(env: &Env, plan: &SyncPlan) {
    for run in plan.runs().expect("runs") {
        env.db
            .apply_statements(
                &env.database,
                &run,
                Arc::new(std::sync::atomic::AtomicBool::new(false)),
            )
            .await
            .unwrap_or_else(|e| panic!("{e}: {:#?}", run.statements));
    }
}

fn script(plan: &SyncPlan) -> Vec<&str> {
    plan.statements.iter().map(|s| s.sql.as_str()).collect()
}

/// Everything ticked, applied, then compared again: no differences.
async fn sync_everything(env: &Env) -> SyncPlan {
    let s = env.session().await;
    seed_sync(env, &s).await;
    s.close().await.ok();
    let target = env.snapshot().await;
    let source = sync_source(&target);
    let d = env.compare(&source, &target);
    let designs = designs_for(env, &d, &target).await;
    let every: Vec<_> = d.items.iter().map(|i| i.id.clone()).collect();
    let plan = plan_sync(&d, Some(&every), &designs, env.kind);
    assert!(
        plan.items
            .iter()
            .all(|i| i.ticked && i.not_scriptable.is_none()),
        "{:#?}",
        plan.items
    );
    apply(env, &plan).await;
    let again = env.compare(&source, &env.snapshot().await);
    assert!(
        again.items.is_empty(),
        "{:#?}\n{:#?}",
        again.items,
        script(&plan)
    );
    plan
}

mod mysql {
    use super::*;
    use crate::common::TestDb;
    use contura_core::dialect::connect;

    async fn fixture() -> (TestDb, Env) {
        let db = TestDb::create().await;
        let env = Env {
            db: connect(&db.config, db.password.as_deref())
                .await
                .expect("connect"),
            kind: DialectKind::MySql,
            database: db.name.clone(),
            schema: None,
        };
        (db, env)
    }

    #[tokio::test]
    async fn data_loss_counts_exact() {
        let (db, env) = fixture().await;
        exact_counts(&env).await;
        env.db.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn data_loss_slow_count_is_about() {
        let (db, env) = fixture().await;
        slow_count_is_an_estimate(&env).await;
        env.db.disconnect().await.ok();
        db.drop_db().await;
    }

    /// R12: a key whose index MySQL made itself, dropped and added again (here
    /// with ON DELETE CASCADE), gets a new index named after the key. Comparing
    /// again still finds no differences.
    #[tokio::test]
    async fn changed_key_with_its_own_generated_index() {
        let (db, env) = fixture().await;
        let s = env.session().await;
        for sql in [
            "CREATE TABLE dbview_customers (id int PRIMARY KEY)",
            "CREATE TABLE dbview_orders (id int PRIMARY KEY, customer_id int, \
             FOREIGN KEY (customer_id) REFERENCES dbview_customers (id))",
        ] {
            env.run(&s, sql).await;
        }
        s.close().await.ok();
        let target = env.snapshot().await;
        let mut source = target.clone();
        for r in &mut source.refs {
            r.on_delete = Some("CASCADE".into());
        }
        let d = env.compare(&source, &target);
        assert_eq!(d.items.len(), 1, "{:#?}", d.items);
        let designs = designs_for(&env, &d, &target).await;
        let plan = plan_sync(&d, None, &designs, env.kind);
        apply(&env, &plan).await;
        let after = env.snapshot().await;
        let again = env.compare(&source, &after);
        assert!(
            again.items.is_empty(),
            "{:#?}\n{:#?}",
            again.items,
            after.tables
        );
        env.db.disconnect().await.ok();
        db.drop_db().await;
    }

    /// One merged ALTER TABLE per table; DROP COLUMN and DROP TABLE run last.
    #[tokio::test]
    async fn sync_script_applies_everything() {
        let (db, env) = fixture().await;
        let plan = sync_everything(&env).await;
        let s = script(&plan);
        let n = s.len();
        assert!(s[n - 2].contains("DROP COLUMN `fax`"), "{s:#?}");
        assert!(s[n - 1].starts_with("DROP TABLE"), "{s:#?}");
        env.db.disconnect().await.ok();
        db.drop_db().await;
    }
}

mod postgres {
    use super::*;
    use crate::common::pg::PgTestDb;
    use contura_core::dialect::connect;

    async fn fixture() -> (PgTestDb, Env) {
        let db = PgTestDb::create().await;
        let env = Env {
            db: connect(&db.config, db.password.as_deref())
                .await
                .expect("connect"),
            kind: DialectKind::Postgres,
            database: db.name.clone(),
            schema: Some("public".into()),
        };
        (db, env)
    }

    #[tokio::test]
    async fn data_loss_counts_exact() {
        let (db, env) = fixture().await;
        exact_counts(&env).await;
        env.db.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn data_loss_slow_count_is_about() {
        let (db, env) = fixture().await;
        slow_count_is_an_estimate(&env).await;
        env.db.disconnect().await.ok();
        db.drop_db().await;
    }

    /// R11: a serial keeps its sequence (OWNED BY the column) when its table and
    /// column are renamed, so `table_design` and the snapshot still read it as
    /// the increment, and it matches a fresh serial table.
    #[tokio::test]
    async fn renamed_serial_stays_serial() {
        use contura_core::design::Increment;
        use contura_core::model::ObjectPath;

        let (db, env) = fixture().await;
        let s = env.session().await;
        for sql in [
            "CREATE TABLE dbview_r1 (id serial PRIMARY KEY, n serial)",
            "ALTER TABLE dbview_r1 RENAME TO dbview_r2",
            "ALTER TABLE dbview_r2 RENAME COLUMN n TO m",
            "CREATE SCHEMA fresh",
            "CREATE TABLE fresh.dbview_r2 (id serial PRIMARY KEY, m serial)",
        ] {
            env.run(&s, sql).await;
        }
        s.close().await.ok();
        let path = ObjectPath {
            database: env.database.clone(),
            schema: env.schema.clone(),
            name: "dbview_r2".into(),
        };
        let design = env.db.table_design(&path).await.expect("design");
        for c in &design.columns {
            assert_eq!(c.increment, Increment::Serial, "{c:?}");
        }
        let target = env.snapshot().await;
        for c in &target.tables[0].columns {
            assert!(c.increment && c.default.is_none(), "{c:?}");
        }
        let source = env
            .db
            .schema_snapshot(&env.database, Some("fresh"))
            .await
            .expect("fresh snapshot");
        let d = diff(
            &source,
            &target,
            &CompareOptions {
                source_schema: Some("fresh".into()),
                target_schema: env.schema.clone(),
                lower_case_table_names: 0,
            },
        );
        assert!(d.items.is_empty(), "{:#?}", d.items);
        env.db.disconnect().await.ok();
        db.drop_db().await;
    }

    /// A default reading another sequence is a plain default in the snapshot and
    /// in `table_design`, so a Sync Script edit can change it and drop it, and
    /// comparing again finds nothing.
    #[tokio::test]
    async fn foreign_sequence_default_changes_through_a_sync_edit() {
        use contura_core::compare::{TargetDesigns, items_to_edits};
        use contura_core::design::{RunMode, StatementPlan, plan_design_for};
        use contura_core::model::ObjectPath;
        use contura_core::schema_model::SmDefault;
        use std::collections::BTreeSet;
        use std::sync::atomic::AtomicBool;

        let (db, env) = fixture().await;
        let s = env.session().await;
        for sql in [
            "CREATE SEQUENCE public.ticket_seq",
            "CREATE SEQUENCE public.other_seq",
            "CREATE TABLE dbview_ticket (id int PRIMARY KEY,              ticket bigint DEFAULT nextval('public.ticket_seq'),              stub bigint DEFAULT nextval('public.ticket_seq'))",
        ] {
            env.run(&s, sql).await;
        }
        s.close().await.ok();
        let target = env.snapshot().await;
        let mut source = target.clone();
        for c in &mut source.tables[0].columns {
            match c.name.as_str() {
                "ticket" => {
                    c.default = Some(SmDefault::Expression {
                        value: "nextval('public.other_seq'::regclass)".into(),
                    })
                }
                "stub" => c.default = None,
                _ => {}
            }
        }
        let d = env.compare(&source, &target);
        assert_eq!(d.items.len(), 2, "{:#?}", d.items);
        let path = ObjectPath {
            database: env.database.clone(),
            schema: env.schema.clone(),
            name: "dbview_ticket".into(),
        };
        let design = env.db.table_design(&path).await.expect("design");
        // The same own-sequence rule as the snapshot: a plain default here too.
        for c in design.columns.iter().filter(|c| c.name != "id") {
            assert_eq!(c.increment, contura_core::design::Increment::None, "{c:?}");
        }
        let designs = TargetDesigns {
            database: env.database.clone(),
            tables: vec![design.clone()],
            taken_names: Vec::new(),
        };
        let all: BTreeSet<_> = d.items.iter().map(|i| i.id.clone()).collect();
        let e = items_to_edits(&d, &all, &designs, env.kind);
        assert!(e.not_scriptable.is_empty(), "{:?}", e.not_scriptable);
        let edits = &e.design_edits()[&design.path];
        let plan = plan_design_for(&design, edits, env.kind).expect("plan");
        let run = StatementPlan {
            statements: plan.statements.clone(),
            mode: RunMode::Transaction,
            sqlite_pragmas: false,
        };
        env.db
            .apply_statements(&env.database, &run, Arc::new(AtomicBool::new(false)))
            .await
            .unwrap_or_else(|err| panic!("{:?}: {err}", plan.statements));
        let again = env.compare(&source, &env.snapshot().await);
        assert!(again.items.is_empty(), "{:#?}", again.items);
        env.db.disconnect().await.ok();
        db.drop_db().await;
    }

    #[tokio::test]
    async fn sync_script_applies_everything() {
        let (db, env) = fixture().await;
        let plan = sync_everything(&env).await;
        assert_eq!(plan.line, "Apply runs exactly this, in one transaction.");
        env.db.disconnect().await.ok();
        db.drop_db().await;
    }

    /// A new enum value cannot be used in the transaction that adds it, so the
    /// script adds it first, in its own transaction (PostgreSQL 17).
    #[tokio::test]
    async fn add_value_commits_before_it_is_used() {
        use contura_core::design::{RunMode, StatementPlan};
        use contura_core::schema_model::SmDefault;

        let (db, env) = fixture().await;
        let s = env.session().await;
        for sql in [
            "CREATE TYPE dbview_mood AS ENUM ('a', 'b')",
            "CREATE TABLE dbview_e (id int PRIMARY KEY, m dbview_mood)",
            "INSERT INTO dbview_e (id, m) VALUES (1, 'a')",
        ] {
            env.run(&s, sql).await;
        }
        let target = env.snapshot().await;
        let mut source = target.clone();
        source.enums[0].values.push("c".into());
        source.tables[0].columns[1].default = Some(SmDefault::String { value: "c".into() });
        let d = env.compare(&source, &target);
        let designs = designs_for(&env, &d, &target).await;
        let plan = plan_sync(&d, None, &designs, env.kind);
        assert_eq!(plan.enum_values_first, 1, "{:#?}", script(&plan));
        assert_eq!(
            plan.line,
            "1 enum value is added first, in its own transaction."
        );
        // In one transaction PostgreSQL refuses the new value.
        let one = StatementPlan {
            statements: script(&plan).iter().map(|x| x.to_string()).collect(),
            mode: RunMode::Transaction,
            sqlite_pragmas: false,
        };
        let err = env
            .db
            .apply_statements(
                &env.database,
                &one,
                Arc::new(std::sync::atomic::AtomicBool::new(false)),
            )
            .await
            .expect_err("the new value is used before it commits");
        assert!(
            format!("{err:?}").contains("unsafe use of new value"),
            "{err:?}"
        );
        // Committed first, it works.
        apply(&env, &plan).await;
        env.run(&s, "INSERT INTO dbview_e (id) VALUES (2)").await;
        let row = s
            .execute("SELECT m::text FROM dbview_e WHERE id = 2")
            .await
            .expect("select");
        assert!(format!("{row:?}").contains("\"c\""), "{row:?}");
        s.close().await.ok();
        let again = env.compare(&source, &env.snapshot().await);
        assert!(again.items.is_empty(), "{:#?}", again.items);
        env.db.disconnect().await.ok();
        db.drop_db().await;
    }

    /// A column that becomes an identity starts after the values it holds.
    #[tokio::test]
    async fn new_identity_starts_after_existing_values() {
        let (db, env) = fixture().await;
        let s = env.session().await;
        for sql in [
            "CREATE TABLE dbview_ids (id int PRIMARY KEY, n int)",
            "INSERT INTO dbview_ids (id, n) VALUES (1, 1), (2, 2), (3, 3)",
        ] {
            env.run(&s, sql).await;
        }
        let target = env.snapshot().await;
        let mut source = target.clone();
        source.tables[0].columns[0].increment = true;
        let d = env.compare(&source, &target);
        let designs = designs_for(&env, &d, &target).await;
        let plan = plan_sync(&d, None, &designs, env.kind);
        assert!(
            script(&plan)
                .iter()
                .any(|x| x.starts_with("DO $contura$BEGIN PERFORM setval(")),
            "{:#?}",
            script(&plan)
        );
        apply(&env, &plan).await;
        env.run(&s, "INSERT INTO dbview_ids (n) VALUES (4)").await;
        let row = s
            .execute("SELECT max(id)::text FROM dbview_ids")
            .await
            .expect("select");
        assert!(format!("{row:?}").contains("\"4\""), "{row:?}");
        s.close().await.ok();
        let again = env.compare(&source, &env.snapshot().await);
        assert!(again.items.is_empty(), "{:#?}", again.items);
        env.db.disconnect().await.ok();
        db.drop_db().await;
    }

    /// A new identity on a column of negative values starts at 1, and a name
    /// with `$$` in it stays inside the quoted block.
    #[tokio::test]
    async fn new_identity_after_negative_values_and_odd_names() {
        let (db, env) = fixture().await;
        let s = env.session().await;
        for sql in [
            "CREATE TABLE \"dbview_n$$g\" (\"i$$d\" int PRIMARY KEY, n int)",
            "INSERT INTO \"dbview_n$$g\" VALUES (-5, 1), (-3, 2)",
        ] {
            env.run(&s, sql).await;
        }
        let target = env.snapshot().await;
        let mut source = target.clone();
        source.tables[0].columns[0].increment = true;
        let d = env.compare(&source, &target);
        let designs = designs_for(&env, &d, &target).await;
        let plan = plan_sync(&d, None, &designs, env.kind);
        apply(&env, &plan).await;
        env.run(&s, "INSERT INTO \"dbview_n$$g\" (n) VALUES (3)")
            .await;
        let row = s
            .execute("SELECT \"i$$d\"::text FROM \"dbview_n$$g\" WHERE n = 3")
            .await
            .expect("select");
        assert!(format!("{row:?}").contains("\"1\""), "{row:?}");
        s.close().await.ok();
        let again = env.compare(&source, &env.snapshot().await);
        assert!(again.items.is_empty(), "{:#?}", again.items);
        env.db.disconnect().await.ok();
        db.drop_db().await;
    }

    /// A count pass dropped half way leaves no statement_timeout on the session.
    #[tokio::test]
    async fn dropped_count_resets_the_timeout() {
        let (db, env) = fixture().await;
        let s = env.session().await;
        env.seed(&s, true).await;
        let before = s.execute("SHOW statement_timeout").await.expect("show");
        let target = env.snapshot().await;
        let d = env.compare(&source_of(&target, true), &target);
        let stopped = tokio::time::timeout(
            Duration::from_millis(20),
            count_data_loss_within(&s, env.kind, &d, Duration::from_secs(30)),
        )
        .await;
        assert!(stopped.is_err(), "the pass should still be counting");
        let after = s.execute("SHOW statement_timeout").await.expect("show");
        assert_eq!(format!("{after:?}"), format!("{before:?}"));
        s.close().await.ok();
        env.db.disconnect().await.ok();
        db.drop_db().await;
    }
}

mod sqlite {
    use std::path::Path;

    use super::*;
    use contura_core::model::{ConnectionConfig, SslMode};
    use contura_core::sqlite::SqliteDialect;

    fn config(path: &Path) -> ConnectionConfig {
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
            ai_sync: Default::default(),
            production: false,
            read_only: false,
        }
    }

    async fn fixture() -> (tempfile::TempDir, Env) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("compare.sqlite");
        rusqlite::Connection::open(&path).unwrap();
        let db = SqliteDialect::connect(&config(&path))
            .await
            .expect("connect");
        let env = Env {
            db: Arc::new(db),
            kind: DialectKind::Sqlite,
            database: "main".into(),
            schema: None,
        };
        (dir, env)
    }

    #[tokio::test]
    async fn data_loss_counts_exact() {
        let (_dir, env) = fixture().await;
        exact_counts(&env).await;
        env.db.disconnect().await.ok();
    }

    #[tokio::test]
    async fn data_loss_slow_count_is_about() {
        let (_dir, env) = fixture().await;
        slow_count_is_an_estimate(&env).await;
        env.db.disconnect().await.ok();
    }

    /// The rebuilt table and the new ones in one framed transaction.
    #[tokio::test]
    async fn sync_script_applies_everything() {
        let (_dir, env) = fixture().await;
        let plan = sync_everything(&env).await;
        let s = script(&plan);
        assert_eq!(s[0], "PRAGMA foreign_keys = OFF");
        assert!(plan.sqlite_pragmas);
        env.db.disconnect().await.ok();
    }
}

// ===========================================================================
// Part 2: the service (Task 5). `compare_schemas`, `compare_ddl`, `plan_sync`,
// `confirm_sync` and `apply_sync` through `ConnectionService`, on pairs of
// databases: MySQL (two databases), PostgreSQL (two schemas in one database,
// and two databases) and SQLite (two files).

mod service {
    use std::collections::BTreeSet;
    use std::path::Path;
    use std::sync::Mutex;

    use super::*;
    use crate::common::pg::{PgTestDb, pg_base_config, pg_test_password, pg_test_user};
    use crate::common::{TestDb, base_config, data_dir, test_password, test_user};
    use contura_core::Error;
    use contura_core::compare::{ItemId, SyncVerdict};
    use contura_core::connections::{
        CompareDatabase, CompareRequest, CompareSide, ConnectionInput, ConnectionService,
        PasswordChange, SyncOutcome,
    };
    use contura_core::design::{ColumnDraft, DesignEdit, DesignRequest, DesignTarget, Position};
    use contura_core::jobs::JobSink;
    use contura_core::model::{ConnectionConfig, ConnectionId, SslMode};
    use contura_core::query::HistoryFilter;
    use contura_core::safety::PassId;
    use contura_core::secrets::MemorySecretStore;
    use contura_core::store::AppStore;
    use serde_json::Value as Json;

    #[derive(Default)]
    struct Rec(Mutex<Vec<Json>>);

    impl JobSink for Rec {
        fn send(&self, event: Json) {
            self.0.lock().unwrap().push(event);
        }
    }

    /// The target before the Sync Script: as `seed_sync`.
    const TARGET_SYNC: &[&str] = &[
        "CREATE TABLE dbview_customers (id int PRIMARY KEY, email varchar(50))",
        "CREATE TABLE dbview_orders (id int PRIMARY KEY, customer_id int, fax varchar(20), \
         code varchar(16), FOREIGN KEY (customer_id) REFERENCES dbview_customers (id))",
        "CREATE INDEX dbview_ix_code ON dbview_orders (code)",
        "CREATE INDEX dbview_ix_customer ON dbview_orders (customer_id)",
        "CREATE TABLE dbview_old (id int PRIMARY KEY)",
        "INSERT INTO dbview_customers (id, email) VALUES (1, 'a@x')",
        "INSERT INTO dbview_orders (id, customer_id, fax, code) VALUES (1, 1, 'f', 'c')",
        "INSERT INTO dbview_old (id) VALUES (1)",
    ];

    /// The source: as `sync_source`, written as SQL.
    const SOURCE_SYNC: &[&str] = &[
        "CREATE TABLE dbview_customers (id int PRIMARY KEY, email varchar(50))",
        "CREATE TABLE dbview_orders (id int PRIMARY KEY, customer_id int, code varchar(24), \
         due date, FOREIGN KEY (customer_id) REFERENCES dbview_customers (id) ON DELETE CASCADE)",
        "CREATE INDEX dbview_ix_customer ON dbview_orders (customer_id)",
        "CREATE INDEX dbview_ix_due ON dbview_orders (due)",
        "CREATE TABLE dbview_refunds (id int PRIMARY KEY, order_id int, \
         FOREIGN KEY (order_id) REFERENCES dbview_orders (id))",
        "CREATE INDEX dbview_ix_order ON dbview_refunds (order_id)",
    ];

    /// Three tables, one change each; b's unique index fails on its duplicates.
    const SOURCE_FAIL: &[&str] = &[
        "CREATE TABLE dbview_a (id int PRIMARY KEY, x int, y int)",
        "CREATE TABLE dbview_b (id int PRIMARY KEY, x int)",
        "CREATE UNIQUE INDEX dbview_ux_b ON dbview_b (x)",
        "CREATE TABLE dbview_c (id int PRIMARY KEY, x int, z int)",
    ];
    const TARGET_FAIL: &[&str] = &[
        "CREATE TABLE dbview_a (id int PRIMARY KEY, x int)",
        "CREATE TABLE dbview_b (id int PRIMARY KEY, x int)",
        "INSERT INTO dbview_b (id, x) VALUES (1, 5), (2, 5)",
        "CREATE TABLE dbview_c (id int PRIMARY KEY, x int)",
    ];

    struct Pair {
        dir: tempfile::TempDir,
        svc: Arc<ConnectionService>,
        kind: DialectKind,
        source: CompareDatabase,
        target: CompareDatabase,
        target_name: String,
    }

    fn service() -> (tempfile::TempDir, Arc<ConnectionService>) {
        let dir = tempfile::tempdir().unwrap();
        let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
        let svc = Arc::new(
            ConnectionService::new(store, Arc::new(MemorySecretStore::new()))
                .with_data_dir(data_dir()),
        );
        (dir, svc)
    }

    async fn save(
        svc: &ConnectionService,
        base: &ConnectionConfig,
        password: Option<String>,
        name: &str,
        production: bool,
        read_only: bool,
    ) -> ConnectionId {
        let saved = svc
            .save(ConnectionInput {
                id: None,
                name: name.into(),
                dialect: base.dialect,
                host: base.host.clone(),
                port: base.port,
                user: base.user.clone(),
                database: base.database.clone(),
                ssl: SslMode::Disable,
                password: match password {
                    Some(value) => PasswordChange::Set { value },
                    None => PasswordChange::Keep,
                },
                group_id: None,
                file: base.file.clone(),
                query_timeout_secs: None,
                ai_access: Default::default(),
                ai_sync: Default::default(),
                production,
                read_only,
            })
            .await
            .expect("save the Connection");
        svc.open(saved.id).await.expect("open the Connection");
        saved.id
    }

    fn sqlite_config(path: &Path) -> ConnectionConfig {
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
            ai_sync: Default::default(),
            production: false,
            read_only: false,
        }
    }

    fn side(connection_id: ConnectionId, database: &str, schema: Option<&str>) -> CompareDatabase {
        CompareDatabase {
            connection_id,
            database: database.into(),
            schema: schema.map(str::to_string),
        }
    }

    fn ticked(plan: &SyncPlan) -> Vec<ItemId> {
        plan.items
            .iter()
            .filter(|i| i.ticked)
            .map(|i| i.id.clone())
            .collect()
    }

    impl Pair {
        async fn mysql(a: &TestDb, b: &TestDb) -> Pair {
            let (dir, svc) = service();
            let base = base_config(&test_user(), None);
            let c = save(
                &svc,
                &base,
                Some(test_password()),
                "kestrel-prod",
                false,
                false,
            )
            .await;
            Pair {
                dir,
                svc,
                kind: DialectKind::MySql,
                source: side(c, &a.name, None),
                target: side(c, &b.name, None),
                target_name: "kestrel-prod".into(),
            }
        }

        async fn pg_two_databases(a: &PgTestDb, b: &PgTestDb) -> Pair {
            let (dir, svc) = service();
            let user = pg_test_user();
            let s = save(
                &svc,
                &pg_base_config(&user, Some(a.name.clone())),
                Some(pg_test_password()),
                "freight-staging",
                false,
                false,
            )
            .await;
            let t = save(
                &svc,
                &pg_base_config(&user, Some(b.name.clone())),
                Some(pg_test_password()),
                "freight-prod",
                false,
                false,
            )
            .await;
            Pair {
                dir,
                svc,
                kind: DialectKind::Postgres,
                source: side(s, &a.name, Some("public")),
                target: side(t, &b.name, Some("public")),
                target_name: "freight-prod".into(),
            }
        }

        async fn pg_two_schemas(db: &PgTestDb) -> Pair {
            let (dir, svc) = service();
            let c = save(
                &svc,
                &pg_base_config(&pg_test_user(), Some(db.name.clone())),
                Some(pg_test_password()),
                "freight",
                false,
                false,
            )
            .await;
            let pair = Pair {
                dir,
                svc,
                kind: DialectKind::Postgres,
                source: side(c, &db.name, Some("dbview_src")),
                target: side(c, &db.name, Some("dbview_tgt")),
                target_name: "freight".into(),
            };
            let plain = side(c, &db.name, None);
            pair.exec(
                &plain,
                &["CREATE SCHEMA dbview_src", "CREATE SCHEMA dbview_tgt"],
            )
            .await;
            pair
        }

        async fn sqlite() -> Pair {
            let (dir, svc) = service();
            let mut ids = Vec::new();
            for f in ["source.sqlite", "target.sqlite"] {
                let path = dir.path().join(f);
                drop(rusqlite::Connection::open(&path).unwrap());
                ids.push(save(&svc, &sqlite_config(&path), None, f, false, false).await);
            }
            Pair {
                dir,
                svc,
                kind: DialectKind::Sqlite,
                source: side(ids[0], "main", None),
                target: side(ids[1], "main", None),
                target_name: "target.sqlite".into(),
            }
        }

        async fn exec(&self, side: &CompareDatabase, sqls: &[&str]) {
            let db = self.svc.session(side.connection_id).await.expect("session");
            let s = db
                .open_query_session(Some(&side.database))
                .await
                .expect("query session");
            if let Some(schema) = &side.schema {
                s.execute(&format!("SET search_path TO \"{schema}\""))
                    .await
                    .expect("search_path");
            }
            for sql in sqls {
                s.execute(sql)
                    .await
                    .unwrap_or_else(|e| panic!("{sql}: {e}"));
            }
            s.close().await.ok();
        }

        fn req(&self) -> CompareRequest {
            CompareRequest {
                source: CompareSide::Database {
                    connection_id: self.source.connection_id,
                    database: self.source.database.clone(),
                    schema: self.source.schema.clone(),
                },
                target: self.target.clone(),
            }
        }

        async fn ids(&self, req: &CompareRequest) -> BTreeSet<ItemId> {
            self.svc
                .compare_schemas(req.clone())
                .await
                .expect("compare")
                .items
                .into_iter()
                .map(|i| i.id)
                .collect()
        }

        /// Applies `plan`'s ticked items with its hash; the events the job sent.
        async fn apply(
            &self,
            req: &CompareRequest,
            plan: &SyncPlan,
            pass: Option<PassId>,
        ) -> (contura_core::Result<SyncOutcome>, Vec<Json>) {
            let rec = Arc::new(Rec::default());
            let out = self
                .svc
                .apply_sync(
                    uuid::Uuid::new_v4(),
                    req.clone(),
                    ticked(plan),
                    pass,
                    plan.hash.clone(),
                    rec.clone(),
                )
                .await;
            let events = rec.0.lock().unwrap().clone();
            (out, events)
        }

        fn history(&self) -> usize {
            self.svc
                .query_history(
                    Some(self.target.connection_id),
                    HistoryFilter {
                        search: None,
                        only: None,
                    },
                )
                .expect("history")
                .iter()
                .filter(|e| e.changed)
                .count()
        }

        async fn close(&self) {
            for c in [self.source.connection_id, self.target.connection_id] {
                self.svc.close(c).await.ok();
            }
        }
    }

    /// The statements done, from each progress event, and the last event's kind.
    fn progress(events: &[Json]) -> (Vec<u64>, String) {
        let done = events
            .iter()
            .filter(|e| e["kind"] == "progress")
            .map(|e| e["statementsDone"].as_u64().expect("statementsDone"))
            .collect();
        let last = events
            .last()
            .map(|e| e["kind"].as_str().unwrap_or_default().to_string())
            .unwrap_or_default();
        (done, last)
    }

    /// Default selection first: the recompare shows exactly the data-loss items.
    /// Then everything: the recompare is empty. One History entry per script.
    async fn round_trip(p: &Pair) {
        p.exec(&p.target, TARGET_SYNC).await;
        p.exec(&p.source, SOURCE_SYNC).await;
        let req = p.req();
        let first = p.svc.compare_schemas(req.clone()).await.expect("compare");
        assert_eq!(first.dialect, p.kind);
        assert!(!first.summary.matches);
        let losses: BTreeSet<ItemId> = first
            .items
            .iter()
            .filter(|i| i.loses_data)
            .map(|i| i.id.clone())
            .collect();
        assert_eq!(losses.len(), 2, "{:#?}", first.items);
        // The data-loss counts: fax holds 1 value, dbview_old 1 row.
        for i in first.items.iter().filter(|i| i.loses_data) {
            assert_eq!(
                i.data_loss,
                Some(DataLoss {
                    rows: 1,
                    exact: true
                }),
                "{}",
                i.id.as_str()
            );
        }
        let ddl = p
            .svc
            .compare_ddl(req.clone(), "dbview_orders".into())
            .await
            .expect("ddl");
        assert!(ddl.source.as_deref().unwrap().contains("due"), "{ddl:#?}");
        assert!(ddl.target.as_deref().unwrap().contains("fax"), "{ddl:#?}");
        let ddl = p
            .svc
            .compare_ddl(req.clone(), "dbview_refunds".into())
            .await
            .expect("ddl");
        assert!(ddl.source.is_some() && ddl.target.is_none(), "{ddl:#?}");

        let plan = p.svc.plan_sync(req.clone(), None).await.expect("plan");
        assert_eq!(plan.verdict, SyncVerdict::Ok);
        assert!(
            plan.items
                .iter()
                .all(|i| i.ticked != losses.contains(&i.id)),
            "{:#?}",
            plan.items
        );
        let (out, events) = p.apply(&req, &plan, None).await;
        let out = out.unwrap_or_else(|e| panic!("{e}: {:#?}", script(&plan)));
        assert_eq!(out.applied, plan.statements.len());
        assert!(out.tables.iter().any(|t| t.name == "dbview_orders"));
        assert!(!out.tables.iter().any(|t| t.name == "dbview_refunds"));
        let (done, last) = progress(&events);
        assert_eq!(last, "finished", "{events:#?}");
        assert!(done.windows(2).all(|w| w[0] <= w[1]), "{done:?}");
        assert_eq!(done.last().copied(), Some(plan.statements.len() as u64));
        assert_eq!(p.ids(&req).await, losses);
        assert_eq!(p.history(), 1);

        let every: Vec<ItemId> = losses.iter().cloned().collect();
        let plan = p
            .svc
            .plan_sync(req.clone(), Some(every))
            .await
            .expect("plan");
        // A ticked data-loss item gets its count in the plan too.
        assert!(
            plan.items.iter().all(|i| i.data_loss.is_some()),
            "{:#?}",
            plan.items
        );
        let (out, _) = p.apply(&req, &plan, None).await;
        out.unwrap_or_else(|e| panic!("{e}: {:#?}", script(&plan)));
        let again = p.svc.compare_schemas(req.clone()).await.expect("compare");
        assert!(again.items.is_empty(), "{:#?}", again.items);
        assert!(again.summary.matches);
        assert_eq!(p.history(), 2);

        // Nothing to apply leaves no History entry.
        let plan = p.svc.plan_sync(req.clone(), None).await.expect("plan");
        assert!(plan.statements.is_empty());
        let (out, _) = p.apply(&req, &plan, None).await;
        assert_eq!(out.expect("nothing to apply").applied, 0);
        assert_eq!(p.history(), 2);
    }

    /// A target changed between plan and apply: `PlanChanged`, nothing runs.
    async fn target_changed(p: &Pair) {
        p.exec(&p.target, TARGET_SYNC).await;
        p.exec(&p.source, SOURCE_SYNC).await;
        let req = p.req();
        let plan = p.svc.plan_sync(req.clone(), None).await.expect("plan");
        // A change the script depends on: an index it drops is gone; on SQLite,
        // whose rebuild writes the table's indexes again, a column it copies.
        let change = match p.kind {
            DialectKind::MySql => "DROP INDEX dbview_ix_code ON dbview_orders",
            DialectKind::Postgres => "DROP INDEX dbview_ix_code",
            DialectKind::Sqlite => "ALTER TABLE dbview_orders ADD COLUMN extra int",
        };
        p.exec(&p.target, &[change]).await;
        let (out, _) = p.apply(&req, &plan, None).await;
        match out {
            Err(Error::PlanChanged { connection }) => assert_eq!(connection, p.target_name),
            other => panic!("expected PlanChanged, got {other:?}"),
        }
        assert_eq!(p.history(), 0);
        // Nothing ran: the new table is still missing.
        assert!(
            p.ids(&req)
                .await
                .iter()
                .any(|i| i.as_str().contains("dbview_refunds"))
        );
    }

    /// A unique index fails on duplicates. PostgreSQL and SQLite change nothing;
    /// MySQL keeps the statement before it and the recompare shows the rest.
    async fn failure(p: &Pair) {
        p.exec(&p.target, TARGET_FAIL).await;
        p.exec(&p.source, SOURCE_FAIL).await;
        let req = p.req();
        let before = p.ids(&req).await;
        assert_eq!(before.len(), 3, "{before:#?}");
        let all: Vec<ItemId> = before.iter().cloned().collect();
        let plan = p.svc.plan_sync(req.clone(), Some(all)).await.expect("plan");
        let (out, events) = p.apply(&req, &plan, None).await;
        let (_, last) = progress(&events);
        assert_eq!(
            last, "failed",
            "a final event before the error: {events:#?}"
        );
        let after = p.ids(&req).await;
        match (p.kind, out) {
            (
                DialectKind::MySql,
                Err(Error::DesignFailed {
                    statement,
                    ran,
                    total,
                    ..
                }),
            ) => {
                // mysql_failure_mid_script
                assert_eq!((statement, ran, total), (1, 1, 3), "{:#?}", script(&plan));
                let left: Vec<&str> = after.iter().map(|i| i.as_str()).collect();
                assert_eq!(left.len(), 2, "{left:#?}");
                assert!(left.iter().all(|i| !i.contains("dbview_a")), "{left:#?}");
                assert_eq!(p.history(), 1);
            }
            (_, Err(Error::DesignFailed { ran, total, .. })) => {
                assert_eq!(ran, 0);
                assert_eq!(total, plan.statements.len());
                assert_eq!(after, before);
                assert_eq!(p.history(), 0);
            }
            (_, other) => panic!("expected DesignFailed, got {other:?}"),
        }
    }

    /// The source as a Schema Model (its own snapshot, schemas left out): applied
    /// to the empty target, the recompare is empty; a changed model gives only
    /// its change.
    async fn model_source(p: &Pair) {
        p.exec(&p.source, SOURCE_SYNC).await;
        let mut model = p
            .svc
            .session(p.source.connection_id)
            .await
            .unwrap()
            .schema_snapshot(&p.source.database, p.source.schema.as_deref())
            .await
            .expect("snapshot");
        for t in &mut model.tables {
            t.schema = None;
        }
        for r in &mut model.refs {
            r.from.schema = None;
            r.to.schema = None;
        }
        let req = |model: &SchemaModel| CompareRequest {
            source: CompareSide::Model {
                model: model.clone(),
                path: Some("C:/models/orders.dbml".into()),
            },
            target: p.target.clone(),
        };
        let plan = p.svc.plan_sync(req(&model), None).await.expect("plan");
        assert!(plan.items.iter().all(|i| i.ticked), "{:#?}", plan.items);
        let (out, _) = p.apply(&req(&model), &plan, None).await;
        out.unwrap_or_else(|e| panic!("{e}: {:#?}", script(&plan)));
        let left = p.ids(&req(&model)).await;
        assert!(left.is_empty(), "{left:#?}");

        let customers = model
            .tables
            .iter_mut()
            .find(|t| t.name == "dbview_customers")
            .unwrap();
        customers.columns.push(SmColumn {
            name: "note".into(),
            type_name: "varchar(40)".into(),
            pk: false,
            increment: false,
            not_null: false,
            unique: false,
            default: None,
            note: None,
        });
        let ids: Vec<String> = p.ids(&req(&model)).await.into_iter().map(|i| i.0).collect();
        assert_eq!(ids.len(), 1, "{ids:#?}");
        assert!(ids[0].starts_with("column:") && ids[0].contains("note"));
        let plan = p.svc.plan_sync(req(&model), None).await.expect("plan");
        assert_eq!(plan.statements.len(), 1, "{:#?}", script(&plan));
        let (out, _) = p.apply(&req(&model), &plan, None).await;
        out.expect("apply the change");
        assert!(p.ids(&req(&model)).await.is_empty());

        // Another Dialect is refused with the spec's sentence.
        let mut other = model.clone();
        other.dialect = if p.kind == DialectKind::MySql {
            DialectKind::Postgres
        } else {
            DialectKind::MySql
        };
        match p.svc.compare_schemas(req(&other)).await {
            Err(Error::InvalidInput(m)) => {
                assert!(m.starts_with("orders.dbml is "), "{m}");
                assert!(
                    m.ends_with("use Data Transfer to copy across Dialects."),
                    "{m}"
                );
            }
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    /// Records the events and cancels the job once one statement is done: the
    /// runner checks the flag right after this progress event, so statement 2
    /// never starts.
    struct CancelAfterOne {
        events: Mutex<Vec<Json>>,
        svc: Arc<ConnectionService>,
        job: uuid::Uuid,
    }

    impl JobSink for CancelAfterOne {
        fn send(&self, event: Json) {
            if event["kind"] == "progress" && event["statementsDone"] == 1 {
                // `cancel` awaits nothing when the job has no server canceller,
                // so one poll finishes it.
                let mut fut = std::pin::pin!(self.svc.jobs().cancel(self.job));
                let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
                assert!(fut.as_mut().poll(&mut cx).is_ready());
            }
            self.events.lock().unwrap().push(event);
        }
    }

    /// I1: a cancel between statements. MySQL keeps what ran, with a Cancelled
    /// History entry; PostgreSQL and SQLite roll back and record nothing.
    async fn cancel_mid_script(p: &Pair) {
        let target: Vec<&str> = TARGET_FAIL
            .iter()
            .copied()
            .filter(|s| !s.starts_with("INSERT"))
            .collect();
        p.exec(&p.target, &target).await;
        p.exec(&p.source, SOURCE_FAIL).await;
        let req = p.req();
        let before = p.ids(&req).await;
        assert_eq!(before.len(), 3, "{before:#?}");
        let plan = p
            .svc
            .plan_sync(req.clone(), Some(before.iter().cloned().collect()))
            .await
            .expect("plan");
        assert!(plan.statements.len() >= 3, "{:#?}", script(&plan));
        let job = uuid::Uuid::new_v4();
        let sink = Arc::new(CancelAfterOne {
            events: Mutex::new(Vec::new()),
            svc: p.svc.clone(),
            job,
        });
        let out = p
            .svc
            .apply_sync(
                job,
                req.clone(),
                ticked(&plan),
                None,
                plan.hash.clone(),
                sink.clone(),
            )
            .await;
        // I2: the cancel carries what stayed applied (MySQL: statement 1).
        let kept = usize::from(p.kind == DialectKind::MySql);
        match out {
            Err(Error::SyncCancelled { applied, total }) => {
                assert_eq!((applied, total), (kept, plan.statements.len()));
            }
            other => panic!("expected SyncCancelled, got {other:?}"),
        }
        let events = sink.events.lock().unwrap().clone();
        let (_, last) = progress(&events);
        assert_eq!(last, "failed", "{events:#?}");
        // The job itself still ends as cancelled.
        assert_eq!(
            events.last().unwrap()["error"]["kind"],
            "cancelled",
            "{events:#?}"
        );
        let after = p.ids(&req).await;
        let history = p
            .svc
            .query_history(
                Some(p.target.connection_id),
                HistoryFilter {
                    search: None,
                    only: None,
                },
            )
            .expect("history");
        if p.kind == DialectKind::MySql {
            // dbview_a's statement ran and stays; b and c are left.
            assert_eq!(after.len(), 2, "{after:#?}");
            assert!(after.iter().all(|i| !i.as_str().contains("dbview_a")));
            assert_eq!(history.len(), 1, "{history:#?}");
            assert_eq!(history[0].outcome, contura_core::query::Outcome::Cancelled);
            assert_eq!(history[0].sql, plan.statements[0].sql);
        } else {
            assert_eq!(after, before);
            assert!(history.is_empty(), "{history:#?}");
        }
    }

    /// The enum-values setup: the target lacks value 'c', which the source's
    /// default uses, and has rows that break the source's unique index.
    async fn pg_enum_values_setup(p: &Pair) {
        p.exec(
            &p.target,
            &[
                "CREATE TYPE dbview_mood AS ENUM ('a', 'b')",
                "CREATE TABLE dbview_t (id int PRIMARY KEY, m dbview_mood, x int)",
                "INSERT INTO dbview_t (id, m, x) VALUES (1, 'a', 5), (2, 'b', 5)",
            ],
        )
        .await;
        p.exec(
            &p.source,
            &[
                "CREATE TYPE dbview_mood AS ENUM ('a', 'b', 'c')",
                "CREATE TABLE dbview_t (id int PRIMARY KEY, m dbview_mood DEFAULT 'c', x int)",
                "CREATE UNIQUE INDEX dbview_ux_t ON dbview_t (x)",
            ],
        )
        .await;
    }

    /// I2: PostgreSQL cancelled after the enum values committed. The value stays
    /// and the cancel counts it as applied; the rest rolls back.
    async fn pg_cancel_after_enum_values(p: &Pair) {
        pg_enum_values_setup(p).await;
        let req = p.req();
        let before = p.ids(&req).await;
        assert_eq!(before.len(), 3, "{before:#?}");
        let plan = p
            .svc
            .plan_sync(req.clone(), Some(before.iter().cloned().collect()))
            .await
            .expect("plan");
        assert_eq!(plan.enum_values_first, 1, "{:#?}", script(&plan));
        let job = uuid::Uuid::new_v4();
        let sink = Arc::new(CancelAfterOne {
            events: Mutex::new(Vec::new()),
            svc: p.svc.clone(),
            job,
        });
        let out = p
            .svc
            .apply_sync(
                job,
                req.clone(),
                ticked(&plan),
                None,
                plan.hash.clone(),
                sink.clone(),
            )
            .await;
        match out {
            Err(Error::SyncCancelled { applied, total }) => {
                assert_eq!((applied, total), (1, plan.statements.len()));
            }
            other => panic!("expected SyncCancelled, got {other:?}"),
        }
        let after = p.ids(&req).await;
        assert_eq!(after.len(), 2, "{after:#?}");
        assert!(
            after.iter().all(|i| !i.as_str().starts_with("enum:")),
            "{after:#?}"
        );
        let history = p
            .svc
            .query_history(
                Some(p.target.connection_id),
                HistoryFilter {
                    search: None,
                    only: None,
                },
            )
            .expect("history");
        assert_eq!(history.len(), 1, "{history:#?}");
        assert_eq!(history[0].outcome, contura_core::query::Outcome::Cancelled);
    }

    /// I1: PostgreSQL fails after the enum values committed. The value stays and
    /// counts as applied; the rest rolls back; the error names the statement.
    async fn pg_failure_after_enum_values(p: &Pair) {
        pg_enum_values_setup(p).await;
        let req = p.req();
        let before = p.ids(&req).await;
        assert_eq!(before.len(), 3, "{before:#?}");
        let plan = p
            .svc
            .plan_sync(req.clone(), Some(before.iter().cloned().collect()))
            .await
            .expect("plan");
        assert!(plan.enum_values_split, "{:#?}", script(&plan));
        let first = plan.enum_values_first;
        assert_eq!(first, 1, "{:#?}", script(&plan));
        let (out, events) = p.apply(&req, &plan, None).await;
        let (_, last) = progress(&events);
        assert_eq!(last, "failed", "{events:#?}");
        match out {
            Err(Error::DesignFailed {
                statement,
                ran,
                total,
                ..
            }) => {
                assert_eq!(ran, first);
                assert_eq!(total, plan.statements.len());
                assert!(
                    plan.statements[statement].sql.contains("UNIQUE INDEX"),
                    "{statement}: {:#?}",
                    script(&plan)
                );
            }
            other => panic!("expected DesignFailed, got {other:?}"),
        }
        // The enum item is gone (its value committed); the default and the
        // index are left.
        let after = p.ids(&req).await;
        assert_eq!(after.len(), 2, "{after:#?}");
        assert!(
            after.iter().all(|i| !i.as_str().starts_with("enum:")),
            "{after:#?}"
        );
        let history = p
            .svc
            .query_history(
                Some(p.target.connection_id),
                HistoryFilter {
                    search: None,
                    only: None,
                },
            )
            .expect("history");
        assert_eq!(history.len(), 1, "{history:#?}");
        assert_eq!(history[0].sql, plan.statements[0].sql);
        assert_eq!(history[0].outcome, contura_core::query::Outcome::Error);
    }

    // --- MySQL: two databases ---------------------------------------------

    async fn mysql_case(f: impl AsyncFnOnce(&Pair)) {
        let a = TestDb::create().await;
        let b = TestDb::create().await;
        let p = Pair::mysql(&a, &b).await;
        f(&p).await;
        p.close().await;
        a.drop_db().await;
        b.drop_db().await;
    }

    #[tokio::test]
    async fn mysql_round_trip() {
        mysql_case(round_trip).await;
    }

    #[tokio::test]
    async fn mysql_target_changed_gives_plan_changed() {
        mysql_case(target_changed).await;
    }

    #[tokio::test]
    async fn mysql_failure_mid_script() {
        mysql_case(failure).await;
    }

    #[tokio::test]
    async fn mysql_model_source() {
        mysql_case(model_source).await;
    }

    #[tokio::test]
    async fn mysql_cancel_keeps_what_ran() {
        mysql_case(cancel_mid_script).await;
    }

    // --- PostgreSQL: two schemas in one database, and two databases --------

    async fn pg_schemas_case(f: impl AsyncFnOnce(&Pair)) {
        let db = PgTestDb::create().await;
        let p = Pair::pg_two_schemas(&db).await;
        f(&p).await;
        p.close().await;
        db.drop_db().await;
    }

    async fn pg_databases_case(f: impl AsyncFnOnce(&Pair)) {
        let a = PgTestDb::create().await;
        let b = PgTestDb::create().await;
        let p = Pair::pg_two_databases(&a, &b).await;
        f(&p).await;
        p.close().await;
        a.drop_db().await;
        b.drop_db().await;
    }

    #[tokio::test]
    async fn postgres_two_schemas_round_trip() {
        pg_schemas_case(round_trip).await;
    }

    #[tokio::test]
    async fn postgres_two_databases_round_trip() {
        pg_databases_case(round_trip).await;
    }

    #[tokio::test]
    async fn postgres_target_changed_gives_plan_changed() {
        pg_schemas_case(target_changed).await;
    }

    #[tokio::test]
    async fn postgres_two_schemas_failure_changes_nothing() {
        pg_schemas_case(failure).await;
    }

    #[tokio::test]
    async fn postgres_two_databases_failure_changes_nothing() {
        pg_databases_case(failure).await;
    }

    #[tokio::test]
    async fn postgres_model_source() {
        pg_databases_case(model_source).await;
    }

    #[tokio::test]
    async fn postgres_same_side_is_refused() {
        pg_schemas_case(async |p: &Pair| {
            let mut req = p.req();
            req.target = p.source.clone();
            match p.svc.compare_schemas(req).await {
                Err(Error::InvalidInput(m)) => {
                    assert_eq!(m, "Source and target are the same. Pick another target.")
                }
                other => panic!("expected InvalidInput, got {other:?}"),
            }
        })
        .await;
    }

    #[tokio::test]
    async fn postgres_cancel_rolls_back() {
        pg_databases_case(cancel_mid_script).await;
    }

    #[tokio::test]
    async fn postgres_failure_after_enum_values_committed() {
        pg_databases_case(pg_failure_after_enum_values).await;
    }

    #[tokio::test]
    async fn postgres_cancel_after_enum_values_committed() {
        pg_databases_case(pg_cancel_after_enum_values).await;
    }

    // --- SQLite: two files ---------------------------------------------------

    #[tokio::test]
    async fn sqlite_round_trip() {
        let p = Pair::sqlite().await;
        round_trip(&p).await;
        p.close().await;
    }

    #[tokio::test]
    async fn sqlite_target_changed_gives_plan_changed() {
        let p = Pair::sqlite().await;
        target_changed(&p).await;
        p.close().await;
    }

    #[tokio::test]
    async fn sqlite_failure_changes_nothing() {
        let p = Pair::sqlite().await;
        failure(&p).await;
        p.close().await;
    }

    #[tokio::test]
    async fn sqlite_model_source() {
        let p = Pair::sqlite().await;
        model_source(&p).await;
        p.close().await;
    }

    // --- Pass rules (SQLite files: the rules do not depend on the Dialect) ---

    /// A target file saved as Production or Read-only, seeded as `TARGET_SYNC`.
    async fn flagged_target(
        p: &Pair,
        file: &str,
        production: bool,
        read_only: bool,
    ) -> CompareDatabase {
        let path = p.dir.path().join(file);
        let conn = rusqlite::Connection::open(&path).unwrap();
        for sql in TARGET_SYNC {
            conn.execute_batch(sql).unwrap();
        }
        drop(conn);
        let id = save(
            &p.svc,
            &sqlite_config(&path),
            None,
            file,
            production,
            read_only,
        )
        .await;
        side(id, "main", None)
    }

    fn add_note_design(base: contura_core::design::TableDesign) -> DesignRequest {
        DesignRequest {
            target: DesignTarget::Alter { base },
            edits: vec![DesignEdit::AddColumn {
                column: ColumnDraft {
                    name: "note".into(),
                    type_sql: "TEXT".into(),
                    nullable: true,
                    default_sql: None,
                    increment: false,
                    comment: None,
                },
                position: Position::Last,
            }],
        }
    }

    #[tokio::test]
    async fn production_needs_a_sync_pass_once() {
        let p = Pair::sqlite().await;
        p.exec(&p.source, SOURCE_SYNC).await;
        let prod = flagged_target(&p, "prod.sqlite", true, false).await;
        let req = CompareRequest {
            target: prod.clone(),
            ..p.req()
        };
        // Compare, DDL and plan need no pass.
        p.svc.compare_schemas(req.clone()).await.expect("compare");
        p.svc
            .compare_ddl(req.clone(), "dbview_orders".into())
            .await
            .expect("ddl");
        let plan = p.svc.plan_sync(req.clone(), None).await.expect("plan");
        assert_eq!(plan.verdict, SyncVerdict::NeedsConfirmation);

        // No pass: asked to confirm, nothing runs.
        let (out, events) = p.apply(&req, &plan, None).await;
        assert!(matches!(out, Err(Error::NeedsConfirmation)), "{out:?}");
        assert!(events.is_empty());

        let pass = p
            .svc
            .confirm_sync(req.clone(), ticked(&plan))
            .await
            .expect("confirm");

        // Stale after the selection changes: the data-loss items ticked too.
        let more: Vec<ItemId> = plan
            .items
            .iter()
            .filter(|i| i.ticked || i.loses_data)
            .map(|i| i.id.clone())
            .collect();
        let wider = p
            .svc
            .plan_sync(req.clone(), Some(more))
            .await
            .expect("plan");
        assert_ne!(wider.hash, plan.hash);
        let (out, _) = p.apply(&req, &wider, Some(pass)).await;
        assert!(matches!(out, Err(Error::NeedsConfirmation)), "{out:?}");

        // A Sync pass never covers a Design run, and a Design pass no Sync run.
        let path = ObjectPath {
            database: "main".into(),
            schema: None,
            name: "dbview_customers".into(),
        };
        let base = p
            .svc
            .table_design(prod.connection_id, path)
            .await
            .expect("design");
        let design = add_note_design(base);
        assert!(matches!(
            p.svc
                .apply_design(prod.connection_id, design.clone(), Some(pass))
                .await,
            Err(Error::NeedsConfirmation)
        ));
        let design_pass = p
            .svc
            .confirm_design(prod.connection_id, design)
            .await
            .expect("design pass");
        let (out, _) = p.apply(&req, &plan, Some(design_pass)).await;
        assert!(matches!(out, Err(Error::NeedsConfirmation)), "{out:?}");

        // A new confirm for the target replaces the earlier pass.
        let replaced = p
            .svc
            .confirm_sync(req.clone(), ticked(&plan))
            .await
            .expect("confirm");
        let pass = p
            .svc
            .confirm_sync(req.clone(), ticked(&plan))
            .await
            .expect("confirm");
        let (out, _) = p.apply(&req, &plan, Some(replaced)).await;
        assert!(matches!(out, Err(Error::NeedsConfirmation)), "{out:?}");

        // M2: PlanChanged on Production leaves the pass unspent. The rebuilt
        // orders table would write the new index, so the script changes.
        p.exec(
            &prod,
            &["CREATE INDEX dbview_ix_extra ON dbview_orders (customer_id)"],
        )
        .await;
        let (out, events) = p.apply(&req, &plan, Some(pass)).await;
        assert!(matches!(out, Err(Error::PlanChanged { .. })), "{out:?}");
        assert!(events.is_empty());
        p.exec(&prod, &["DROP INDEX dbview_ix_extra"]).await;

        // With its pass (unspent above): applies once.
        let (out, _) = p.apply(&req, &plan, Some(pass)).await;
        out.unwrap_or_else(|e| panic!("{e}: {:#?}", script(&plan)));
        let losses: Vec<ItemId> = plan
            .items
            .iter()
            .filter(|i| i.loses_data)
            .map(|i| i.id.clone())
            .collect();
        let rest = p
            .svc
            .plan_sync(req.clone(), Some(losses))
            .await
            .expect("plan");
        assert!(!rest.statements.is_empty());
        let (out, _) = p.apply(&req, &rest, Some(pass)).await;
        assert!(matches!(out, Err(Error::NeedsConfirmation)), "{out:?}");
        p.svc.close(prod.connection_id).await.ok();
        p.close().await;
    }

    #[tokio::test]
    async fn read_only_target_compares_but_never_applies() {
        let p = Pair::sqlite().await;
        p.exec(&p.source, SOURCE_SYNC).await;
        let ro = flagged_target(&p, "ro.sqlite", true, true).await;
        let req = CompareRequest {
            target: ro.clone(),
            ..p.req()
        };
        let result = p.svc.compare_schemas(req.clone()).await.expect("compare");
        assert!(!result.items.is_empty());
        p.svc
            .compare_ddl(req.clone(), "dbview_orders".into())
            .await
            .expect("ddl");
        let plan = p.svc.plan_sync(req.clone(), None).await.expect("plan");
        assert_eq!(plan.verdict, SyncVerdict::ReadOnly);
        assert!(matches!(
            p.svc.confirm_sync(req.clone(), ticked(&plan)).await,
            Err(Error::ReadOnly(_))
        ));
        let (out, _) = p.apply(&req, &plan, None).await;
        assert!(matches!(out, Err(Error::ReadOnly(_))), "{out:?}");
        p.svc.close(ro.connection_id).await.ok();
        p.close().await;
    }
}
