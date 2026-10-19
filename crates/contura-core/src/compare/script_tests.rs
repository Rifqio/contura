//! The Sync Script per Dialect: group order and the MySQL end-of-script drops,
//! MySQL merged per table, PostgreSQL `USING` and identity, `ADD VALUE` in its
//! own transaction, SQLite in place and rebuilt, the selection closure, the
//! default selection, copy-only plans and the same text for the same input.

use super::*;
use crate::compare::diff::{CompareOptions, diff};
use crate::compare::edits::tests::{
    all, col, designs_of, en, fk, id, index, model, pg_diff, pg_enum_diff, pk, table,
};
use crate::schema_model::{SchemaModel, SmColumn, SmDefault};
use std::collections::BTreeMap;

const PG: DialectKind = DialectKind::Postgres;
const MY: DialectKind = DialectKind::MySql;
const LITE: DialectKind = DialectKind::Sqlite;

fn every(d: &SchemaDiff) -> Vec<ItemId> {
    all(d).into_iter().collect()
}

fn sqls(p: &SyncPlan) -> Vec<&str> {
    p.statements.iter().map(|s| s.sql.as_str()).collect()
}

fn item<'a>(p: &'a SyncPlan, id: &str) -> &'a SyncItem {
    p.items
        .iter()
        .find(|i| i.id.as_str() == id)
        .unwrap_or_else(|| panic!("no item {id} in {:#?}", p.items))
}

/// The position of the first statement containing `text`.
fn at(p: &SyncPlan, text: &str) -> usize {
    p.statements
        .iter()
        .position(|s| s.sql.contains(text))
        .unwrap_or_else(|| panic!("no statement with {text} in {:#?}", sqls(p)))
}

fn billing() -> CompareOptions {
    CompareOptions {
        source_schema: Some("billing".into()),
        target_schema: Some("billing".into()),
        lower_case_table_names: 0,
    }
}

fn groups_in_order(p: &SyncPlan) {
    let groups: Vec<SyncGroup> = p.items.iter().map(|i| i.group).collect();
    let mut sorted = groups.clone();
    sorted.sort();
    assert_eq!(groups, sorted, "items in group order");
}

// ---------------------------------------------------------------------------
// MySQL: the design order, merged per table, DROP COLUMN and DROP TABLE last.

fn mysql_pair() -> (SchemaModel, SchemaModel) {
    let mut orders = table(
        None,
        "orders",
        vec![
            pk("id", "int"),
            col("customer_id", "int"),
            col("fax", "varchar(20)"),
            col("code", "varchar(16)"),
        ],
    );
    orders.indexes = vec![index(Some("ix_code"), &["code"], false)];
    let target = model(
        MY,
        vec![
            table(None, "customers", vec![pk("id", "int")]),
            orders,
            table(None, "old_logs", vec![pk("id", "int")]),
        ],
        vec![fk(
            None,
            ("orders", "customer_id"),
            ("customers", "id"),
            None,
        )],
        Vec::new(),
    );
    let mut orders = table(
        None,
        "orders",
        vec![
            pk("id", "int"),
            col("customer_id", "int"),
            col("code", "varchar(24)"),
            col("due", "date"),
        ],
    );
    orders.indexes = vec![index(Some("ix_due"), &["due"], false)];
    let source = model(
        MY,
        vec![
            table(None, "customers", vec![pk("id", "int")]),
            orders,
            table(
                None,
                "refunds",
                vec![pk("id", "int"), col("order_id", "int")],
            ),
        ],
        vec![
            fk(
                None,
                ("orders", "customer_id"),
                ("customers", "id"),
                Some("CASCADE"),
            ),
            fk(None, ("refunds", "order_id"), ("orders", "id"), None),
        ],
        Vec::new(),
    );
    (source, target)
}

#[test]
fn mysql_design_order_with_drops_last() {
    let (source, target) = mysql_pair();
    let d = diff(&source, &target, &CompareOptions::default());
    let designs = designs_of(&target, "shop");
    let p = plan_sync(&d, Some(&every(&d)), &designs, MY);
    let s = sqls(&p);
    let n = s.len();
    // The changed key is dropped first, by its real name.
    assert_eq!(
        s[0],
        "ALTER TABLE `shop`.`orders`\n  DROP FOREIGN KEY `orders_customer_id_fkey`"
    );
    // One merged ALTER TABLE per table: index drop, change and adds together.
    let merged = at(&p, "MODIFY COLUMN `code`");
    for clause in [
        "DROP INDEX `ix_code`",
        "ADD COLUMN `due`",
        "ADD INDEX `ix_due`",
    ] {
        assert!(s[merged].contains(clause), "{clause} in {}", s[merged]);
    }
    assert!(at(&p, "CREATE TABLE `shop`.`refunds`") > merged);
    let key = at(&p, "ADD CONSTRAINT `orders_customer_id_fkey` FOREIGN KEY");
    assert!(
        s[key].ends_with("REFERENCES `shop`.`customers` (`id`) ON DELETE CASCADE"),
        "{}",
        s[key]
    );
    assert!(key > at(&p, "CREATE TABLE `shop`.`refunds`"));
    assert!(at(&p, "ALTER TABLE `shop`.`refunds` ADD FOREIGN KEY") < n - 2);
    // DROP COLUMN and DROP TABLE move to the end.
    assert_eq!(s[n - 2], "ALTER TABLE `shop`.`orders`\n  DROP COLUMN `fax`");
    assert_eq!(s[n - 1], "DROP TABLE `shop`.`old_logs`");
    let dropping: Vec<bool> = p.statements.iter().map(|x| x.drops_data).collect();
    assert_eq!(dropping.iter().filter(|x| **x).count(), 2, "{dropping:?}");
    assert!(dropping[n - 2] && dropping[n - 1]);
    assert_eq!(p.statements[n - 2].object.as_deref(), Some("orders.fax"));
    assert_eq!(p.statements[n - 1].group, SyncGroup::Drop);
    assert!(p.statements.iter().all(|x| x.writes));
    // The list keeps the design groups.
    groups_in_order(&p);
    assert_eq!(p.mode, SyncMode::Sequential);
    assert_eq!(
        p.line,
        format!(
            "MySQL runs these {n} statements one by one. If one fails, the ones before it stay applied."
        )
    );
    let lines: Vec<(&str, &str)> = p
        .items
        .iter()
        .map(|i| (i.id.as_str(), i.line.as_str()))
        .collect();
    for (want_id, want_line) in [
        ("column:orders.fax:removed", "DROP COLUMN orders.fax"),
        ("table:old_logs:removed", "DROP TABLE old_logs"),
        ("index:orders.ix_code:removed", "DROP INDEX orders.ix_code"),
        (
            "column:orders.code:changed",
            "ALTER COLUMN orders.code TYPE varchar(24)",
        ),
        ("column:orders.due:added", "ADD COLUMN orders.due"),
        ("index:orders.ix_due:added", "CREATE INDEX orders.ix_due"),
        ("table:refunds:added", "CREATE TABLE refunds"),
    ] {
        assert!(
            lines.contains(&(want_id, want_line)),
            "{want_id}: {want_line} in {lines:#?}"
        );
    }
    let runs = p.runs().unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].mode, crate::design::RunMode::Sequential);
    assert_eq!(runs[0].statements.len(), n);
}

// ---------------------------------------------------------------------------
// PostgreSQL.

#[test]
fn postgres_design_order() {
    let (d, designs) = pg_diff();
    let p = plan_sync(&d, Some(&every(&d)), &designs, PG);
    let order = [
        "DROP CONSTRAINT \"invoices_customer_id_fkey\"",
        "DROP COLUMN \"fax\"",
        "DROP TABLE \"billing\".\"old_logs\"",
        "ADD VALUE 'sent'",
        "ALTER COLUMN \"code\" TYPE varchar(24)",
        "CREATE TABLE \"billing\".\"refunds\"",
        "ADD COLUMN \"total\"",
        "CREATE INDEX",
        "ALTER TABLE \"billing\".\"refunds\" ADD FOREIGN KEY",
    ];
    let places: Vec<usize> = order.iter().map(|t| at(&p, t)).collect();
    let mut sorted = places.clone();
    sorted.sort();
    assert_eq!(places, sorted, "{:#?}", sqls(&p));
    let groups: Vec<SyncGroup> = p.statements.iter().map(|s| s.group).collect();
    let mut by_group = groups.clone();
    by_group.sort();
    assert_eq!(groups, by_group, "{:#?}", sqls(&p));
    groups_in_order(&p);
    assert_eq!(p.mode, SyncMode::Transaction);
    assert_eq!(p.line, "Apply runs exactly this, in one transaction.");
    assert_eq!(p.enum_values_first, 0);
    // Statements carry their items.
    let fax = &p.statements[at(&p, "DROP COLUMN \"fax\"")];
    assert_eq!(fax.items, [id("column:billing.invoices.fax:removed")]);
    assert!(fax.drops_data);
    assert_eq!(fax.object.as_deref(), Some("billing.invoices.fax"));
}

#[test]
fn postgres_using_and_identity() {
    let s = Some("billing");
    let target = model(
        PG,
        vec![table(
            s,
            "t",
            vec![
                pk("id", "integer"),
                col("total", "varchar(10)"),
                SmColumn {
                    increment: true,
                    not_null: true,
                    ..col("n", "integer")
                },
                SmColumn {
                    not_null: true,
                    ..col("m", "integer")
                },
            ],
        )],
        Vec::new(),
        Vec::new(),
    );
    let source = model(
        PG,
        vec![table(
            s,
            "t",
            vec![
                pk("id", "integer"),
                col("total", "integer"),
                SmColumn {
                    not_null: true,
                    ..col("n", "integer")
                },
                SmColumn {
                    increment: true,
                    not_null: true,
                    ..col("m", "integer")
                },
            ],
        )],
        Vec::new(),
        Vec::new(),
    );
    let d = diff(&source, &target, &billing());
    let p = plan_sync(&d, Some(&every(&d)), &designs_of(&target, "freight"), PG);
    let s = sqls(&p);
    assert!(
        s.contains(&"ALTER TABLE \"billing\".\"t\" ALTER COLUMN \"total\" TYPE integer USING \"total\"::integer"),
        "{s:#?}"
    );
    assert!(
        s.contains(&"ALTER TABLE \"billing\".\"t\" ALTER COLUMN \"n\" DROP IDENTITY"),
        "{s:#?}"
    );
    let add = at(
        &p,
        "ALTER COLUMN \"m\" ADD GENERATED BY DEFAULT AS IDENTITY",
    );
    // The new identity starts after the values the column already holds.
    assert_eq!(
        s[add + 1],
        "DO $contura$BEGIN PERFORM setval(pg_get_serial_sequence('\"billing\".\"t\"', 'm'), \
         greatest(coalesce(max(\"m\"), 0) + 1, 1), false) FROM \"billing\".\"t\"; END$contura$"
    );
    assert_eq!(
        p.statements[add + 1].items,
        [id("column:billing.t.m:changed")]
    );
    assert!(
        p.warnings.contains(
            &"PostgreSQL rewrites t and blocks reads and writes on it until this finishes."
                .to_string()
        ),
        "{:?}",
        p.warnings
    );
    // The narrowing change drops data in its TYPE statement only.
    let total = item(&p, "column:billing.t.total:changed");
    assert!(total.loses_data);
    let marked: Vec<&str> = p
        .statements
        .iter()
        .filter(|x| x.drops_data)
        .map(|x| x.sql.as_str())
        .collect();
    assert_eq!(marked.len(), 1, "{marked:?}");
    assert!(marked[0].contains("TYPE integer"));
}

fn mood_pair(source_values: &[&str], default: Option<&str>) -> (SchemaDiff, TargetDesigns) {
    let s = Some("billing");
    let target = model(
        PG,
        vec![table(s, "t", vec![pk("id", "integer"), col("m", "mood")])],
        Vec::new(),
        vec![en(s, "mood", &["a", "b"])],
    );
    let mut m = col("m", "mood");
    m.default = default.map(|v| SmDefault::String { value: v.into() });
    let source = model(
        PG,
        vec![table(s, "t", vec![pk("id", "integer"), m])],
        Vec::new(),
        vec![en(s, "mood", source_values)],
    );
    (
        diff(&source, &target, &billing()),
        designs_of(&target, "freight"),
    )
}

#[test]
fn add_value_runs_first_in_its_own_transaction_when_used() {
    let (d, designs) = mood_pair(&["a", "b", "c", "d"], Some("c"));
    let p = plan_sync(&d, None, &designs, PG);
    let s = sqls(&p);
    assert_eq!(
        &s[..2],
        [
            "ALTER TYPE \"billing\".\"mood\" ADD VALUE 'c' AFTER 'b'",
            "ALTER TYPE \"billing\".\"mood\" ADD VALUE 'd' AFTER 'c'",
        ]
    );
    assert!(
        s[2..].iter().any(|x| x.contains("SET DEFAULT 'c'")),
        "{s:#?}"
    );
    assert_eq!(p.enum_values_first, 2);
    assert_eq!(
        p.line,
        "2 enum values are added first, in their own transaction."
    );
    // R13: the UI words the Production dialog from this.
    assert!(p.enum_values_split);
    assert_eq!(serde_json::to_value(&p).unwrap()["enumValuesFirst"], true);
    let runs = p.runs().unwrap();
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0].statements, s[..2]);
    assert_eq!(runs[1].statements, s[2..]);

    let (d, designs) = mood_pair(&["a", "b", "c"], Some("c"));
    let p = plan_sync(&d, None, &designs, PG);
    assert_eq!(
        p.line,
        "1 enum value is added first, in its own transaction."
    );

    // Nothing uses the new value: one transaction.
    let (d, designs) = mood_pair(&["a", "b", "c"], None);
    let p = plan_sync(&d, None, &designs, PG);
    assert_eq!(p.enum_values_first, 0);
    assert_eq!(p.line, "Apply runs exactly this, in one transaction.");
    assert_eq!(p.runs().unwrap().len(), 1);
    assert!(!p.enum_values_split);
}

// ---------------------------------------------------------------------------
// SQLite.

fn sqlite_orders(extra: Vec<SmColumn>, code: &str) -> SchemaModel {
    let mut columns = vec![pk("id", "integer"), col("code", code)];
    columns.extend(extra);
    model(
        LITE,
        vec![table(None, "orders", columns)],
        Vec::new(),
        Vec::new(),
    )
}

#[test]
fn sqlite_in_place_and_rebuild() {
    let target = sqlite_orders(Vec::new(), "integer");
    let designs = designs_of(&target, "main");

    // A new column and index: in place, no pragma lines.
    let mut source = sqlite_orders(vec![col("note", "text")], "integer");
    source.tables[0].indexes = vec![index(Some("ix_note"), &["note"], false)];
    let d = diff(&source, &target, &CompareOptions::default());
    let p = plan_sync(&d, None, &designs, LITE);
    let s = sqls(&p);
    assert_eq!(s.len(), 2, "{s:#?}");
    assert!(s[0].contains("ADD COLUMN \"note\""), "{s:#?}");
    assert!(s[1].starts_with("CREATE INDEX"), "{s:#?}");
    assert!(!p.sqlite_pragmas);
    assert_eq!(p.line, "Apply runs exactly this, in one transaction.");
    assert!(!p.runs().unwrap()[0].sqlite_pragmas);

    // A type change: the 5c rebuild, framed once by the pragma lines.
    let source = sqlite_orders(Vec::new(), "text");
    let d = diff(&source, &target, &CompareOptions::default());
    let p = plan_sync(&d, Some(&every(&d)), &designs, LITE);
    let s = sqls(&p);
    let n = s.len();
    assert_eq!(s[0], "PRAGMA foreign_keys = OFF");
    assert_eq!(s[n - 2], "PRAGMA foreign_key_check");
    assert_eq!(s[n - 1], "PRAGMA foreign_keys = ON");
    assert_eq!(
        s.iter()
            .filter(|x| x.starts_with("PRAGMA foreign_keys"))
            .count(),
        2,
        "{s:#?}"
    );
    assert!(s.iter().any(|x| x.starts_with("INSERT INTO")), "{s:#?}");
    for st in &p.statements {
        let check = st.sql.starts_with("PRAGMA") || st.sql.starts_with("SELECT count(*)");
        assert_eq!(st.writes, !check, "{}", st.sql);
    }
    assert!(p.sqlite_pragmas);
    let runs = p.runs().unwrap();
    assert!(runs[0].sqlite_pragmas);
    crate::design::statement_design_plan(LITE, &runs[0]).expect("the runner takes the frame");
}

// ---------------------------------------------------------------------------
// Selection.

fn needs_pair() -> SchemaDiff {
    let mut orders = table(
        None,
        "orders",
        vec![pk("id", "int"), col("refund_id", "int"), col("tag", "text")],
    );
    orders.indexes = vec![index(Some("ix_tag"), &["tag"], false)];
    let source = model(
        MY,
        vec![orders, table(None, "refunds", vec![pk("id", "int")])],
        vec![fk(None, ("orders", "refund_id"), ("refunds", "id"), None)],
        Vec::new(),
    );
    let target = model(
        MY,
        vec![table(None, "orders", vec![pk("id", "int")])],
        Vec::new(),
        Vec::new(),
    );
    diff(&source, &target, &CompareOptions::default())
}

const KEY: &str = "foreignKey:orders.(refund_id) -> refunds(id):added";

#[test]
fn selection_closure_both_directions() {
    let d = needs_pair();
    let everything = all(&d);
    // Unticking an added column unticks its index.
    let off = toggle(&d, &everything, &id("column:orders.tag:added"), false);
    assert!(!off.contains(&id("column:orders.tag:added")));
    assert!(!off.contains(&id("index:orders.ix_tag:added")));
    assert!(off.contains(&id("table:refunds:added")));
    // Unticking a created table unticks the Foreign Key that points to it.
    let off = toggle(&d, &everything, &id("table:refunds:added"), false);
    assert!(!off.contains(&id(KEY)));
    assert!(off.contains(&id("column:orders.refund_id:added")));
    // Ticking a Foreign Key ticks its new table and column.
    let on = toggle(&d, &BTreeSet::new(), &id(KEY), true);
    let want: BTreeSet<ItemId> = [
        id(KEY),
        id("column:orders.refund_id:added"),
        id("table:refunds:added"),
    ]
    .into();
    assert_eq!(on, want);
    assert_eq!(selection_closure(&d, [&id(KEY)]), want);
    // plan_sync closes the selection it is given.
    let designs = designs_of(
        &model(
            MY,
            vec![table(None, "orders", vec![pk("id", "int")])],
            Vec::new(),
            Vec::new(),
        ),
        "shop",
    );
    let p = plan_sync(&d, Some(&[id(KEY)]), &designs, MY);
    let ticked: BTreeSet<ItemId> = p
        .items
        .iter()
        .filter(|i| i.ticked)
        .map(|i| i.id.clone())
        .collect();
    assert_eq!(ticked, want);
    assert!(!item(&p, "index:orders.ix_tag:added").ticked);
    assert_eq!(item(&p, KEY).needs.len(), 2);
}

#[test]
fn data_loss_items_start_unticked() {
    let (d, designs) = pg_diff();
    let p = plan_sync(&d, None, &designs, PG);
    for lossy in [
        "column:billing.invoices.fax:removed",
        "table:billing.old_logs:removed",
    ] {
        let i = item(&p, lossy);
        assert!(i.loses_data && !i.ticked, "{i:?}");
        assert!(
            p.statements.iter().all(|s| !s.items.contains(&i.id)),
            "{lossy} has a statement"
        );
    }
    assert!(item(&p, "table:billing.refunds:added").ticked);
    assert!(p.statements.iter().all(|s| !s.drops_data));
    // Every other item without a reason is ticked.
    for i in &p.items {
        if !i.loses_data && i.not_scriptable.is_none() {
            assert!(i.ticked, "{i:?}");
        }
    }
}

#[test]
fn copy_only_for_items_that_cannot_be_scripted() {
    let (d, designs) = pg_enum_diff(&["draft", "paid"], &["draft", "paid", "written_off"]);
    let reason = "PostgreSQL cannot remove a value from an enum. Remove written_off by hand.";
    let p = plan_sync(&d, None, &designs, PG);
    let only = &p.items[0];
    assert!(!only.ticked);
    assert_eq!(only.not_scriptable.as_deref(), Some(reason));
    assert!(p.statements.is_empty());
    assert_eq!(p.mode, SyncMode::Transaction);
    assert_eq!(p.line, "Nothing to apply.");

    let p = plan_sync(&d, Some(&every(&d)), &designs, PG);
    assert!(p.items[0].ticked);
    assert_eq!(
        p.mode,
        SyncMode::CopyOnly {
            reason: reason.into()
        }
    );
    assert_eq!(p.line, reason);
    assert!(p.runs().is_err());

    // A table Contura could not read is not scriptable and starts unticked.
    let (d, _) = pg_diff();
    let none = TargetDesigns {
        database: "freight".into(),
        ..TargetDesigns::default()
    };
    let p = plan_sync(&d, None, &none, PG);
    let total = item(&p, "column:billing.invoices.total:added");
    assert!(!total.ticked);
    assert_eq!(
        total.not_scriptable.as_deref(),
        Some("Contura could not read the table invoices on the target.")
    );
    assert!(item(&p, "table:billing.refunds:added").ticked);
    assert!(!matches!(p.mode, SyncMode::CopyOnly { .. }));
}

#[test]
fn same_input_same_text() {
    let (d, designs) = pg_diff();
    let a = plan_sync(&d, Some(&every(&d)), &designs, PG);
    let b = plan_sync(&d, Some(&every(&d)), &designs, PG);
    assert_eq!(a, b);
    assert_eq!(a.hash.len(), 64);
    assert!(a.hash.chars().all(|c| c.is_ascii_hexdigit()));
    let c = plan_sync(&d, None, &designs, PG);
    assert_ne!(a.hash, c.hash);
    // Counts in lines carry grouping commas.
    assert_eq!(grouped(18402), "18,402");
    assert_eq!(grouped(999), "999");
    assert_eq!(grouped(1_000_000), "1,000,000");

    // The contract's shape (api-contract.md).
    let v = serde_json::to_value(&a).unwrap();
    let keys = |v: &serde_json::Value| -> Vec<String> {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    };
    assert_eq!(
        keys(&v),
        [
            "enumValuesFirst",
            "hash",
            "items",
            "line",
            "mode",
            "statements",
            "verdict",
            "warnings"
        ]
    );
    assert_eq!(v["mode"], serde_json::json!({ "kind": "transaction" }));
    assert_eq!(v["verdict"], "ok");
    assert_eq!(
        keys(&v["statements"][0]),
        ["dropsData", "group", "items", "object", "sql", "writes"]
    );
    assert_eq!(
        keys(&v["items"][0]),
        [
            "dataLoss",
            "group",
            "id",
            "kind",
            "line",
            "losesData",
            "needs",
            "notScriptable",
            "object",
            "table",
            "ticked"
        ]
    );
    let copy = serde_json::to_value(SyncMode::CopyOnly { reason: "r".into() }).unwrap();
    assert_eq!(
        copy,
        serde_json::json!({ "kind": "copyOnly", "reason": "r" })
    );
}

// ---------------------------------------------------------------------------
// Fix round 1 (task-4-review.md).

/// I1: no name can end the `DO` block's quote: the tag is one the body lacks.
#[test]
fn identity_start_is_quoted_with_a_free_tag() {
    assert_eq!(
        dollar_quoted("x $contura$ y"),
        "DO $contura1$x $contura$ y$contura1$"
    );
    let s = Some("billing");
    let column = |increment| SmColumn {
        increment,
        not_null: true,
        ..col("x$$y", "integer")
    };
    let target = model(
        PG,
        vec![table(s, "t", vec![pk("id", "integer"), column(false)])],
        Vec::new(),
        Vec::new(),
    );
    let source = model(
        PG,
        vec![table(s, "t", vec![pk("id", "integer"), column(true)])],
        Vec::new(),
        Vec::new(),
    );
    let d = diff(&source, &target, &billing());
    let p = plan_sync(&d, None, &designs_of(&target, "freight"), PG);
    let block = p
        .statements
        .iter()
        .map(|x| x.sql.as_str())
        .find(|x| x.starts_with("DO "))
        .expect("the identity start");
    assert!(block.starts_with("DO $contura$BEGIN"), "{block}");
    assert!(block.ends_with("END$contura$"), "{block}");
    let body = &block["DO $contura$".len()..block.len() - "$contura$".len()];
    assert!(!body.contains("$contura$"), "{block}");
    // M1: a column holding only negative values still starts at 1 or more.
    assert!(
        body.contains("greatest(coalesce(max(\"x$$y\"), 0) + 1, 1)"),
        "{block}"
    );
}

/// I2 (a): a column changed to a new enum runs after its CREATE TYPE.
#[test]
fn a_column_change_waits_for_its_new_type() {
    let s = Some("billing");
    let target = model(
        PG,
        vec![table(s, "t", vec![pk("id", "integer"), col("m", "text")])],
        Vec::new(),
        Vec::new(),
    );
    let source = model(
        PG,
        vec![table(s, "t", vec![pk("id", "integer"), col("m", "mood")])],
        Vec::new(),
        vec![en(s, "mood", &["a", "b"])],
    );
    let d = diff(&source, &target, &billing());
    let p = plan_sync(&d, Some(&every(&d)), &designs_of(&target, "freight"), PG);
    assert!(
        at(&p, "CREATE TYPE \"billing\".\"mood\"") < at(&p, "ALTER COLUMN \"m\" TYPE"),
        "{:#?}",
        sqls(&p)
    );
}

/// I2 (b): DROP TYPE runs after the column change that stops using it.
#[test]
fn drop_type_waits_for_the_column_change() {
    let s = Some("billing");
    let target = model(
        PG,
        vec![table(s, "t", vec![pk("id", "integer"), col("m", "mood")])],
        Vec::new(),
        vec![en(s, "mood", &["a", "b"])],
    );
    let source = model(
        PG,
        vec![table(s, "t", vec![pk("id", "integer"), col("m", "text")])],
        Vec::new(),
        Vec::new(),
    );
    let d = diff(&source, &target, &billing());
    let p = plan_sync(&d, Some(&every(&d)), &designs_of(&target, "freight"), PG);
    assert!(
        at(&p, "ALTER COLUMN \"m\" TYPE text") < at(&p, "DROP TYPE \"billing\".\"mood\""),
        "{:#?}",
        sqls(&p)
    );
}

/// I2: statements that need each other in a cycle come out once each, in rank
/// order; a statement outside the cycle keeps its place.
#[test]
fn a_cycle_keeps_the_rank_order() {
    let (a, b, c) = (id("a"), id("b"), id("c"));
    let needs_a = vec![b.clone()];
    let needs_b = vec![a.clone()];
    let needs: BTreeMap<&ItemId, &[ItemId]> =
        [(&a, needs_a.as_slice()), (&b, needs_b.as_slice())].into();
    let st = |sql: &str, it: &ItemId, rank: u8| Stmt {
        sql: sql.into(),
        items: vec![it.clone()],
        rank,
        group: None,
        block: false,
    };
    let out = ordered(
        vec![st("second", &b, 5), st("free", &c, 3), st("first", &a, 1)],
        &needs,
    );
    let order: Vec<&str> = out.iter().map(|s| s.sql.as_str()).collect();
    assert_eq!(order, ["first", "free", "second"]);
}

/// M3: the new value's text in a statement about another column is no use of it.
#[test]
fn a_value_in_an_unrelated_statement_does_not_split() {
    let s = Some("billing");
    let tables = |note_default: Option<&str>| {
        let mut note = col("note", "text");
        note.default = note_default.map(|v| SmDefault::String { value: v.into() });
        vec![
            table(s, "t", vec![pk("id", "integer"), col("m", "mood")]),
            table(s, "u", vec![pk("id", "integer"), note]),
        ]
    };
    let target = model(
        PG,
        tables(None),
        Vec::new(),
        vec![en(s, "mood", &["a", "b"])],
    );
    let source = model(
        PG,
        tables(Some("c")),
        Vec::new(),
        vec![en(s, "mood", &["a", "b", "c"])],
    );
    let d = diff(&source, &target, &billing());
    let p = plan_sync(&d, None, &designs_of(&target, "freight"), PG);
    assert!(
        sqls(&p).iter().any(|x| x.contains("SET DEFAULT 'c'")),
        "{:#?}",
        sqls(&p)
    );
    assert_eq!(p.enum_values_first, 0);
    assert_eq!(p.line, "Apply runs exactly this, in one transaction.");
    assert_eq!(literals("a 'x''y' b 'c'"), ["'x''y'", "'c'"]);
}

/// M5: one MySQL statement.
#[test]
fn one_mysql_statement_line() {
    let target = model(
        MY,
        vec![table(None, "orders", vec![pk("id", "int")])],
        Vec::new(),
        Vec::new(),
    );
    let source = model(
        MY,
        vec![table(
            None,
            "orders",
            vec![pk("id", "int"), col("note", "text")],
        )],
        Vec::new(),
        Vec::new(),
    );
    let d = diff(&source, &target, &CompareOptions::default());
    let p = plan_sync(&d, None, &designs_of(&target, "shop"), MY);
    assert_eq!(p.statements.len(), 1);
    assert_eq!(
        p.line,
        "MySQL runs this statement. If it fails, nothing changes."
    );
}

/// M6: a SQLite change whose rebuild is copy-only is not scriptable and starts
/// unticked; a change done in place on the same table still applies.
#[test]
fn sqlite_copy_only_rebuild_is_not_scriptable() {
    let target = sqlite_orders(Vec::new(), "integer");
    let mut designs = designs_of(&target, "main");
    designs.tables[0].sqlite.as_mut().unwrap().create_sql =
        "CREATE TABLE \"orders\" (\"id\" integer PRIMARY KEY, \"code\" integer CHECK (code > 0))"
            .into();
    let mut source = sqlite_orders(vec![col("extra", "text")], "integer");
    source.tables[0].columns[1].not_null = true;
    let d = diff(&source, &target, &CompareOptions::default());
    let p = plan_sync(&d, None, &designs, LITE);
    let code = item(&p, "column:orders.code:changed");
    assert!(!code.ticked);
    assert_eq!(
        code.not_scriptable.as_deref(),
        Some("it has a CHECK constraint")
    );
    let extra = item(&p, "column:orders.extra:added");
    assert!(extra.ticked && extra.not_scriptable.is_none());
    assert_eq!(sqls(&p).len(), 1, "{:#?}", sqls(&p));
    assert!(sqls(&p)[0].contains("ADD COLUMN \"extra\""));
    assert!(!p.sqlite_pragmas);

    let p = plan_sync(&d, Some(&every(&d)), &designs, LITE);
    assert_eq!(
        p.mode,
        SyncMode::CopyOnly {
            reason: "it has a CHECK constraint".into()
        }
    );
    // The copy-only rebuild's statements never run, so the script does not show them.
    assert!(sqls(&p).is_empty(), "{:#?}", sqls(&p));
}

/// M6: the hash covers only the statements' text.
#[test]
fn the_hash_covers_only_the_sql() {
    let one = |items: Vec<ItemId>, group, writes| SyncStatement {
        sql: "ALTER TABLE t ADD COLUMN c int".into(),
        items,
        group,
        writes,
        drops_data: false,
        object: None,
    };
    let a = hash(&[one(vec![id("x")], SyncGroup::Create, true)]);
    let b = hash(&[one(Vec::new(), SyncGroup::Drop, false)]);
    assert_eq!(a, b);
    let mut other = one(Vec::new(), SyncGroup::Drop, false);
    other.sql.push(' ');
    assert_ne!(a, hash(&[other]));
}

// ---------------------------------------------------------------------------
// R14: more uses of a new enum value split the transaction.

fn stmt(sql: &str, items: &[&str]) -> Stmt {
    Stmt {
        sql: sql.into(),
        items: items.iter().map(|i| id(i)).collect(),
        rank: rank::CHANGE,
        group: None,
        block: false,
    }
}

#[test]
fn a_value_in_a_partial_index_or_check_splits() {
    let (d, _) = mood_pair(&["a", "b", "c"], None);
    let add = "ALTER TYPE \"billing\".\"mood\" ADD VALUE 'c' AFTER 'b'";
    for using in [
        "CREATE INDEX \"t_m_c\" ON \"billing\".\"t\" (\"id\") WHERE \"m\" = 'c'",
        "ALTER TABLE \"billing\".\"t\" ADD CONSTRAINT \"t_m\" CHECK (\"m\" <> 'c')",
        "ALTER TABLE \"billing\".\"u\" ALTER COLUMN \"x\" SET DEFAULT 'c'::\"billing\".\"mood\"",
    ] {
        let mut stmts = vec![stmt(using, &[]), stmt(add, &[])];
        assert_eq!(values_first(&mut stmts, &d), 1, "{using}");
        assert_eq!(stmts[0].sql, add, "{using}");
    }
    // A value in a CHECK that names another value only does not split.
    let mut stmts = vec![
        stmt(
            "ALTER TABLE \"billing\".\"t\" ADD CONSTRAINT \"t_m\" CHECK (\"m\" <> 'a')",
            &[],
        ),
        stmt(add, &[]),
    ];
    assert_eq!(values_first(&mut stmts, &d), 0);
}

#[test]
fn a_value_in_an_enum_array_default_splits() {
    let s = Some("billing");
    let target = model(
        PG,
        vec![table(s, "t", vec![pk("id", "integer"), col("m", "mood[]")])],
        Vec::new(),
        vec![en(s, "mood", &["a", "b"])],
    );
    let mut m = col("m", "mood[]");
    m.default = Some(SmDefault::String {
        value: "{a,c}".into(),
    });
    let source = model(
        PG,
        vec![table(s, "t", vec![pk("id", "integer"), m])],
        Vec::new(),
        vec![en(s, "mood", &["a", "b", "c"])],
    );
    let d = diff(&source, &target, &billing());
    let p = plan_sync(&d, None, &designs_of(&target, "freight"), PG);
    assert!(
        sqls(&p).iter().any(|x| x.contains("'{a,c}'")),
        "{:#?}",
        sqls(&p)
    );
    assert_eq!(p.enum_values_first, 1, "{:#?}", sqls(&p));
    assert!(p.enum_values_split);
    assert_eq!(
        literal_values("'{a,\"c\"}' 'x''y'"),
        ["{a,\"c\"}", "a", "c", "x'y"]
    );
}

#[test]
fn an_escaped_string_value_is_an_added_value() {
    // `pg_string` writes a value holding a backslash as `E'..'`.
    let add = r#"ALTER TYPE "billing"."mood" ADD VALUE E'a\\b' AFTER 'b'"#;
    assert_eq!(added_value(add), Some((r#""billing"."mood""#, r"'a\\b'")));
    // A backslash-escaped quote does not end the value.
    let quoted = r#"ALTER TYPE "mood" ADD VALUE E'it\'s'"#;
    assert_eq!(added_value(quoted), Some((r#""mood""#, r"'it\'s'")));
    assert_eq!(
        added_value("ALTER TYPE \"mood\" ADD VALUE 'c'"),
        Some(("\"mood\"", "'c'"))
    );

    let (d, _) = mood_pair(&["a", "b", "c"], None);
    let using =
        r#"ALTER TABLE "billing"."u" ALTER COLUMN "x" SET DEFAULT E'a\\b'::"billing"."mood""#;
    let mut stmts = vec![stmt(using, &[]), stmt(add, &[])];
    assert_eq!(values_first(&mut stmts, &d), 1);
    assert_eq!(stmts[0].sql, add);
}
