//! Diff items to edits: each item kind, the creates and drops, and the enum
//! rules per Dialect. Every table's edit list is planned by 5c to prove the
//! edits fit the target's design.

use super::*;
use crate::compare::diff::{CompareOptions, diff};
use crate::design::{
    Increment, MySqlColumn, SqliteExtras, TableColumn, TableForeignKey, plan_design_for,
};
use crate::schema_model::SmEndpoint;

const PG: DialectKind = DialectKind::Postgres;
const MY: DialectKind = DialectKind::MySql;
const LITE: DialectKind = DialectKind::Sqlite;

pub(crate) fn col(name: &str, ty: &str) -> SmColumn {
    SmColumn {
        name: name.into(),
        type_name: ty.into(),
        pk: false,
        increment: false,
        not_null: false,
        unique: false,
        default: None,
        note: None,
    }
}

pub(crate) fn pk(name: &str, ty: &str) -> SmColumn {
    SmColumn {
        pk: true,
        not_null: true,
        ..col(name, ty)
    }
}

pub(crate) fn table(schema: Option<&str>, name: &str, columns: Vec<SmColumn>) -> SmTable {
    SmTable {
        schema: schema.map(str::to_string),
        name: name.into(),
        alias: None,
        note: None,
        columns,
        indexes: Vec::new(),
    }
}

pub(crate) fn index(name: Option<&str>, columns: &[&str], unique: bool) -> SmIndex {
    SmIndex {
        name: name.map(str::to_string),
        columns: columns.iter().map(|c| c.to_string()).collect(),
        unique,
        pk: false,
    }
}

pub(crate) fn fk(
    schema: Option<&str>,
    from: (&str, &str),
    to: (&str, &str),
    on_delete: Option<&str>,
) -> SmRef {
    let end = |(t, c): (&str, &str)| SmEndpoint {
        schema: schema.map(str::to_string),
        table: t.into(),
        columns: vec![c.into()],
    };
    SmRef {
        name: None,
        from: end(from),
        to: end(to),
        on_delete: on_delete.map(str::to_string),
        on_update: None,
    }
}

pub(crate) fn model(
    d: DialectKind,
    tables: Vec<SmTable>,
    refs: Vec<SmRef>,
    enums: Vec<SmEnum>,
) -> SchemaModel {
    SchemaModel {
        dialect: d,
        tables,
        refs,
        enums,
        skipped: Vec::new(),
    }
}

pub(crate) fn en(schema: Option<&str>, name: &str, values: &[&str]) -> SmEnum {
    SmEnum {
        schema: schema.map(str::to_string),
        name: name.into(),
        values: values.iter().map(|v| v.to_string()).collect(),
    }
}

/// The target's tables as `table_design` would read them, with the names the
/// server gives what the model leaves unnamed.
pub(crate) fn designs_of(m: &SchemaModel, database: &str) -> TargetDesigns {
    let d = m.dialect;
    let tables = m
        .tables
        .iter()
        .map(|t| {
            let pk_cols: Vec<String> = t
                .columns
                .iter()
                .filter(|c| c.pk)
                .map(|c| c.name.clone())
                .collect();
            let columns = t
                .columns
                .iter()
                .map(|c| TableColumn {
                    name: c.name.clone(),
                    type_sql: c.type_name.clone(),
                    nullable: !(c.not_null || c.pk),
                    default_sql: c.default.as_ref().map(|x| ddl::default_sql(d, x)),
                    increment: match (c.increment, d) {
                        (false, _) => Increment::None,
                        (true, DialectKind::Postgres) => Increment::Identity,
                        (true, _) => Increment::AutoIncrement,
                    },
                    comment: c.note.clone(),
                    generated: false,
                    mysql: (d == MY).then_some(MySqlColumn {
                        charset: None,
                        collation: None,
                        on_update: None,
                    }),
                    sqlite_autoincrement: false,
                    collation: None,
                    advanced: false,
                    identity_always: false,
                })
                .collect();
            let mut indexes = Vec::new();
            if !pk_cols.is_empty() {
                indexes.push(TableIndex {
                    name: match d {
                        DialectKind::MySql => "PRIMARY".into(),
                        _ => format!("{}_pkey", t.name),
                    },
                    columns: pk_cols,
                    unique: true,
                    primary: true,
                    constraint: d == PG,
                    sql: None,
                    method: None,
                    predicate: None,
                    expression: false,
                    advanced: false,
                });
            }
            for c in t.columns.iter().filter(|c| c.unique) {
                indexes.push(TableIndex {
                    name: format!("{}_{}_key", t.name, c.name),
                    columns: vec![c.name.clone()],
                    unique: true,
                    primary: false,
                    constraint: d == PG,
                    sql: None,
                    method: None,
                    predicate: None,
                    expression: false,
                    advanced: false,
                });
            }
            for i in &t.indexes {
                let name = i
                    .name
                    .clone()
                    .unwrap_or_else(|| format!("{}_{}_idx", t.name, i.columns.join("_")));
                indexes.push(TableIndex {
                    sql: (d == LITE)
                        .then(|| format!("CREATE INDEX \"{name}\" ON \"{}\" (x)", t.name)),
                    name,
                    columns: i.columns.clone(),
                    unique: i.unique,
                    primary: false,
                    constraint: false,
                    method: None,
                    predicate: None,
                    expression: false,
                    advanced: false,
                });
            }
            let foreign_keys =
                m.refs
                    .iter()
                    .filter(|r| r.from.table == t.name)
                    .map(|r| TableForeignKey {
                        name: r.name.clone().unwrap_or_else(|| {
                            format!("{}_{}_fkey", t.name, r.from.columns.join("_"))
                        }),
                        columns: r.from.columns.clone(),
                        target: ObjectPath {
                            database: database.into(),
                            schema: r.to.schema.clone(),
                            name: r.to.table.clone(),
                        },
                        target_columns: r.to.columns.clone(),
                        on_delete: r.on_delete.clone(),
                        on_update: r.on_update.clone(),
                        advanced: false,
                    })
                    .collect();
            let sqlite = (d == LITE).then(|| {
                let one = model(d, vec![t.clone()], Vec::new(), Vec::new());
                SqliteExtras {
                    create_sql: bare(
                        &ddl::parts(&one, &ddl::DdlOptions::default())
                            .unwrap()
                            .tables[0],
                    ),
                    triggers: Vec::new(),
                    views: Vec::new(),
                    foreign_keys_on: true,
                    view_triggers: Vec::new(),
                    children: Vec::new(),
                }
            });
            TableDesign {
                path: ObjectPath {
                    database: database.into(),
                    schema: t.schema.clone(),
                    name: t.name.clone(),
                },
                columns,
                indexes,
                foreign_keys,
                referenced_by: Vec::new(),
                comment: t.note.clone(),
                unsupported: Vec::new(),
                sqlite,
            }
        })
        .collect();
    TargetDesigns {
        database: database.into(),
        tables,
        taken_names: Vec::new(),
    }
}

pub(crate) fn all(d: &SchemaDiff) -> BTreeSet<ItemId> {
    d.items.iter().map(|i| i.id.clone()).collect()
}

pub(crate) fn id(s: &str) -> ItemId {
    ItemId(s.into())
}

/// The edits of `table`, as (item, group, edit).
fn of<'a>(e: &'a SyncEdits, table: &str) -> Vec<(&'a str, SyncGroup, &'a DesignEdit)> {
    e.tables
        .iter()
        .find(|(p, _)| p.name == table)
        .map(|(_, list)| {
            list.iter()
                .map(|x| (x.item.as_str(), x.group, &x.edit))
                .collect()
        })
        .unwrap_or_default()
}

fn step(e: &SyncEdits, kind: StepKind) -> Vec<&SyncStep> {
    e.steps.iter().filter(|s| s.kind == kind).collect()
}

// ---------------------------------------------------------------------------
// PostgreSQL, every item kind.

pub(crate) fn pg_pair() -> (SchemaModel, SchemaModel) {
    let s = Some("staging");
    let t = Some("billing");
    let status_enum = |schema| en(schema, "invoice_status", &["draft", "paid", "void"]);
    let mut target_invoices = table(
        t,
        "invoices",
        vec![
            pk("id", "integer"),
            col("customer_id", "integer"),
            col("fax", "text"),
            col("code", "character varying(16)"),
            col("status", "invoice_status"),
        ],
    );
    target_invoices.indexes = vec![index(
        Some("invoices_customer_idx"),
        &["customer_id"],
        false,
    )];
    let target = model(
        PG,
        vec![
            table(
                t,
                "customers",
                vec![pk("id", "integer"), col("email", "text")],
            ),
            target_invoices,
            table(t, "old_logs", vec![pk("id", "integer")]),
            table(
                t,
                "payments",
                vec![
                    pk("id", "integer"),
                    SmColumn {
                        not_null: true,
                        ..col("paid_at", "date")
                    },
                ],
            ),
        ],
        vec![fk(
            t,
            ("invoices", "customer_id"),
            ("customers", "id"),
            None,
        )],
        vec![status_enum(t)],
    );

    let mut code = col("code", "varchar(24)");
    code.not_null = true;
    let mut status = col("status", "invoice_status");
    status.default = Some(SmDefault::String {
        value: "draft".into(),
    });
    let mut total = col("total", "numeric(10,2)");
    total.unique = true;
    let mut source_invoices = table(
        s,
        "invoices",
        vec![
            pk("id", "integer"),
            col("customer_id", "integer"),
            code,
            status,
            total,
        ],
    );
    source_invoices.indexes = vec![index(None, &["customer_id", "code"], false)];
    let mut email = col("email", "text");
    email.unique = true;
    let paid_at = pk("paid_at", "date");
    let source = model(
        PG,
        vec![
            table(s, "customers", vec![pk("id", "integer"), email]),
            source_invoices,
            table(s, "payments", vec![pk("id", "integer"), paid_at]),
            table(
                s,
                "refunds",
                vec![pk("id", "integer"), col("invoice_id", "integer")],
            ),
        ],
        vec![
            fk(
                s,
                ("invoices", "customer_id"),
                ("customers", "id"),
                Some("CASCADE"),
            ),
            fk(s, ("refunds", "invoice_id"), ("invoices", "id"), None),
        ],
        vec![en(
            s,
            "invoice_status",
            &["draft", "sent", "paid", "void", "refunded"],
        )],
    );
    (source, target)
}

pub(crate) fn pg_diff() -> (SchemaDiff, TargetDesigns) {
    let (source, target) = pg_pair();
    let d = diff(
        &source,
        &target,
        &CompareOptions {
            source_schema: Some("staging".into()),
            target_schema: Some("billing".into()),
            lower_case_table_names: 0,
        },
    );
    (d, designs_of(&target, "freight"))
}

#[test]
fn edits_per_kind_postgres() {
    let (d, designs) = pg_diff();
    let e = items_to_edits(&d, &all(&d), &designs, PG);
    assert!(e.not_scriptable.is_empty(), "{:?}", e.not_scriptable);

    let invoices = of(&e, "invoices");
    let has = |item: &str, group: SyncGroup, edit: &DesignEdit| {
        assert!(
            invoices
                .iter()
                .any(|(i, g, x)| *i == item && *g == group && *x == edit),
            "missing {item} {group:?} {edit:?} in {invoices:#?}"
        );
    };
    has(
        "column:billing.invoices.fax:removed",
        SyncGroup::Drop,
        &DesignEdit::DropColumn { name: "fax".into() },
    );
    has(
        "column:billing.invoices.total:added",
        SyncGroup::Create,
        &DesignEdit::AddColumn {
            column: ColumnDraft {
                name: "total".into(),
                type_sql: "numeric(10,2)".into(),
                nullable: true,
                default_sql: None,
                increment: false,
                comment: None,
            },
            position: Position::Last,
        },
    );
    has(
        "column:billing.invoices.total:added",
        SyncGroup::Create,
        &DesignEdit::AddIndex {
            index: IndexDraft {
                name: "invoices_total_key".into(),
                columns: vec!["total".into()],
                unique: true,
                primary: false,
            },
        },
    );
    // A changed column restates the target's column with the source's values.
    has(
        "column:billing.invoices.code:changed",
        SyncGroup::Change,
        &DesignEdit::ChangeColumn {
            name: "code".into(),
            column: ColumnDraft {
                name: "code".into(),
                type_sql: "varchar(24)".into(),
                nullable: false,
                default_sql: None,
                increment: false,
                comment: None,
            },
        },
    );
    has(
        "column:billing.invoices.status:changed",
        SyncGroup::Change,
        &DesignEdit::ChangeColumn {
            name: "status".into(),
            column: ColumnDraft {
                name: "status".into(),
                type_sql: "invoice_status".into(),
                nullable: true,
                default_sql: Some("'draft'".into()),
                increment: false,
                comment: None,
            },
        },
    );
    // Drops use the real names the server gave.
    has(
        "index:billing.invoices.invoices_customer_idx:removed",
        SyncGroup::Drop,
        &DesignEdit::DropIndex {
            name: "invoices_customer_idx".into(),
        },
    );
    has(
        "index:billing.invoices.(customer_id, code):added",
        SyncGroup::Create,
        &DesignEdit::AddIndex {
            index: IndexDraft {
                name: "invoices_customer_id_code_idx".into(),
                columns: vec!["customer_id".into(), "code".into()],
                unique: false,
                primary: false,
            },
        },
    );
    let key_id = "foreignKey:billing.invoices.(customer_id) -> customers(id):changed";
    has(
        key_id,
        SyncGroup::Drop,
        &DesignEdit::DropForeignKey {
            name: "invoices_customer_id_fkey".into(),
        },
    );
    let Some((_, _, DesignEdit::AddForeignKey { key })) = invoices
        .iter()
        .find(|(i, g, _)| *i == key_id && *g == SyncGroup::Create)
    else {
        panic!("no added key in {invoices:#?}");
    };
    assert_eq!(key.name, "invoices_customer_id_fkey");
    assert_eq!(key.on_delete.as_deref(), Some("CASCADE"));
    assert_eq!(key.target.schema.as_deref(), Some("billing"));
    // Groups in order: drops, then changes, then adds.
    let groups: Vec<SyncGroup> = invoices.iter().map(|(_, g, _)| *g).collect();
    let mut sorted = groups.clone();
    sorted.sort();
    assert_eq!(groups, sorted);

    // A column that becomes unique gains a unique index.
    assert_eq!(
        of(&e, "customers"),
        vec![(
            "column:billing.customers.email:changed",
            SyncGroup::Create,
            &DesignEdit::AddIndex {
                index: IndexDraft {
                    name: "customers_email_key".into(),
                    columns: vec!["email".into()],
                    unique: true,
                    primary: false,
                }
            }
        )]
    );
    // A primary key change drops the real key and adds the new one.
    let payments = of(&e, "payments");
    assert_eq!(payments.len(), 2, "{payments:#?}");
    assert_eq!(
        payments[0].2,
        &DesignEdit::DropIndex {
            name: "payments_pkey".into()
        }
    );
    assert!(matches!(
        payments[1].2,
        DesignEdit::AddIndex { index } if index.primary && index.name.is_empty()
            && index.columns == ["id", "paid_at"]
    ));

    // Every table's edits plan through 5c.
    for (path, edits) in e.design_edits() {
        let base = designs.find(path.schema.as_deref(), &path.name).unwrap();
        let plan = plan_design_for(base, &edits, PG)
            .unwrap_or_else(|err| panic!("{} did not plan: {err}", path.name));
        if path.name == "invoices" {
            let text = plan.statements.join("\n");
            assert!(
                text.contains("ALTER COLUMN \"code\" TYPE varchar(24)"),
                "{text}"
            );
            assert!(text.contains("DROP COLUMN \"fax\""), "{text}");
            assert!(
                text.contains("ALTER COLUMN \"status\" SET DEFAULT 'draft'"),
                "{text}"
            );
        }
    }
}

#[test]
fn creates_and_drops_postgres() {
    let (d, designs) = pg_diff();
    let e = items_to_edits(&d, &all(&d), &designs, PG);
    let creates = step(&e, StepKind::CreateTable);
    assert_eq!(creates.len(), 1);
    assert_eq!(creates[0].items, [id("table:billing.refunds:added")]);
    assert_eq!(creates[0].group, SyncGroup::Create);
    assert!(
        creates[0].statements[0].starts_with("CREATE TABLE \"billing\".\"refunds\" ("),
        "{:?}",
        creates[0].statements
    );
    assert!(creates[0].statements.iter().all(|s| !s.ends_with(';')));
    // The new table's key is added once every new table exists.
    let keys = step(&e, StepKind::AddForeignKey);
    assert_eq!(keys.len(), 1);
    assert_eq!(
        keys[0].statements,
        [
            "ALTER TABLE \"billing\".\"refunds\" ADD FOREIGN KEY (\"invoice_id\") REFERENCES \"billing\".\"invoices\" (\"id\")"
        ]
    );
    let drops = step(&e, StepKind::DropTable);
    assert_eq!(drops.len(), 1);
    assert_eq!(drops[0].statements, ["DROP TABLE \"billing\".\"old_logs\""]);
    assert_eq!(drops[0].group, SyncGroup::Drop);
    // Script order of the steps: drops, changes (enum values), creates.
    let kinds: Vec<StepKind> = e.steps.iter().map(|s| s.kind).collect();
    assert_eq!(
        kinds,
        [
            StepKind::DropTable,
            StepKind::AddEnumValue,
            StepKind::AddEnumValue,
            StepKind::CreateTable,
            StepKind::AddForeignKey
        ]
    );
}

#[test]
fn only_the_selection_is_edited() {
    let (d, designs) = pg_diff();
    let pick: BTreeSet<ItemId> = [id("column:billing.invoices.fax:removed")].into();
    let e = items_to_edits(&d, &pick, &designs, PG);
    assert_eq!(e.tables.len(), 1);
    assert_eq!(of(&e, "invoices").len(), 1);
    assert!(e.steps.is_empty());
    // The same input gives the same output.
    assert_eq!(
        items_to_edits(&d, &all(&d), &designs, PG),
        items_to_edits(&d, &all(&d), &designs, PG)
    );
}

#[test]
fn dropped_tables_go_after_the_tables_whose_keys_point_at_them() {
    let t = Some("billing");
    let target = model(
        PG,
        vec![
            table(t, "a_parent", vec![pk("id", "integer")]),
            table(
                t,
                "b_child",
                vec![pk("id", "integer"), col("parent_id", "integer")],
            ),
        ],
        vec![fk(t, ("b_child", "parent_id"), ("a_parent", "id"), None)],
        Vec::new(),
    );
    let source = model(PG, Vec::new(), Vec::new(), Vec::new());
    let opts = CompareOptions {
        source_schema: Some("staging".into()),
        target_schema: Some("billing".into()),
        lower_case_table_names: 0,
    };
    let d = diff(&source, &target, &opts);
    let e = items_to_edits(&d, &all(&d), &designs_of(&target, "freight"), PG);
    let order: Vec<&str> = e.steps.iter().map(|s| s.path.name.as_str()).collect();
    assert_eq!(order, ["b_child", "a_parent"]);
}

// ---------------------------------------------------------------------------
// Enum rules.

pub(crate) fn pg_enum_diff(source: &[&str], target: &[&str]) -> (SchemaDiff, TargetDesigns) {
    let t = model(
        PG,
        Vec::new(),
        Vec::new(),
        vec![en(Some("billing"), "invoice_status", target)],
    );
    let s = model(
        PG,
        Vec::new(),
        Vec::new(),
        vec![en(Some("staging"), "invoice_status", source)],
    );
    let opts = CompareOptions {
        source_schema: Some("staging".into()),
        target_schema: Some("billing".into()),
        lower_case_table_names: 0,
    };
    (diff(&s, &t, &opts), designs_of(&t, "freight"))
}

#[test]
fn postgres_adds_enum_values_in_place() {
    let (d, designs) = pg_enum_diff(
        &["new", "draft", "sent", "paid", "void", "refunded"],
        &["draft", "paid", "void"],
    );
    let e = items_to_edits(&d, &all(&d), &designs, PG);
    let adds: Vec<&str> = step(&e, StepKind::AddEnumValue)
        .iter()
        .map(|s| s.statements[0].as_str())
        .collect();
    assert_eq!(
        adds,
        [
            "ALTER TYPE \"billing\".\"invoice_status\" ADD VALUE 'new' BEFORE 'draft'",
            "ALTER TYPE \"billing\".\"invoice_status\" ADD VALUE 'sent' AFTER 'draft'",
            "ALTER TYPE \"billing\".\"invoice_status\" ADD VALUE 'refunded' AFTER 'void'",
        ]
    );
    assert!(e.steps.iter().all(|s| s.group == SyncGroup::Change));
}

#[test]
fn postgres_cannot_remove_an_enum_value() {
    let (d, designs) = pg_enum_diff(&["draft", "paid"], &["draft", "paid", "written_off"]);
    let item = &d.items[0];
    let reason = "PostgreSQL cannot remove a value from an enum. Remove written_off by hand.";
    assert_eq!(item.scriptable, Err(reason.to_string()));
    let e = items_to_edits(&d, &all(&d), &designs, PG);
    assert!(e.steps.is_empty());
    assert_eq!(
        e.not_scriptable.get(&item.id).map(String::as_str),
        Some(reason)
    );
}

#[test]
fn postgres_creates_and_drops_enum_types() {
    let t = model(
        PG,
        Vec::new(),
        Vec::new(),
        vec![en(Some("billing"), "old_mood", &["x"])],
    );
    let s = model(
        PG,
        Vec::new(),
        Vec::new(),
        vec![en(Some("staging"), "mood", &["ok", "sad"])],
    );
    let opts = CompareOptions {
        source_schema: Some("staging".into()),
        target_schema: Some("billing".into()),
        lower_case_table_names: 0,
    };
    let d = diff(&s, &t, &opts);
    let e = items_to_edits(&d, &all(&d), &designs_of(&t, "freight"), PG);
    let text: Vec<(StepKind, &str)> = e
        .steps
        .iter()
        .map(|s| (s.kind, s.statements[0].as_str()))
        .collect();
    assert_eq!(
        text,
        [
            (StepKind::DropType, "DROP TYPE \"billing\".\"old_mood\""),
            (
                StepKind::CreateType,
                "CREATE TYPE \"billing\".\"mood\" AS ENUM ('ok', 'sad')"
            ),
        ]
    );
}

#[test]
fn mysql_changes_an_enum_with_modify() {
    let target = model(
        MY,
        vec![table(
            None,
            "orders",
            vec![pk("id", "int"), col("status", "enum('a','b')")],
        )],
        Vec::new(),
        Vec::new(),
    );
    let source = model(
        MY,
        vec![table(
            None,
            "orders",
            vec![pk("id", "int"), col("status", "enum('a','b','c')")],
        )],
        Vec::new(),
        Vec::new(),
    );
    let d = diff(&source, &target, &CompareOptions::default());
    let designs = designs_of(&target, "shop");
    let e = items_to_edits(&d, &all(&d), &designs, MY);
    let edits = e.design_edits();
    let (path, list) = edits.iter().next().expect("one table");
    assert!(matches!(
        &list[..],
        [DesignEdit::ChangeColumn { name, column }]
            if name == "status" && column.type_sql == "enum('a','b','c')"
    ));
    let plan = plan_design_for(designs.find(None, &path.name).unwrap(), list, MY).unwrap();
    assert_eq!(plan.statements.len(), 1);
    assert!(
        plan.statements[0].contains("MODIFY COLUMN `status` enum('a','b','c') NULL"),
        "{:?}",
        plan.statements
    );
}

#[test]
fn mysql_model_enum_is_written_inline() {
    let target = model(
        MY,
        vec![table(None, "orders", vec![pk("id", "int")])],
        Vec::new(),
        Vec::new(),
    );
    let source = model(
        MY,
        vec![
            table(None, "orders", vec![pk("id", "int"), col("mood", "mood")]),
            table(None, "moods", vec![pk("id", "int"), col("mood", "mood")]),
        ],
        Vec::new(),
        vec![en(None, "mood", &["ok", "sad"])],
    );
    let d = diff(&source, &target, &CompareOptions::default());
    let e = items_to_edits(&d, &all(&d), &designs_of(&target, "shop"), MY);
    assert!(matches!(
        &of(&e, "orders")[..],
        [(_, _, DesignEdit::AddColumn { column, .. })] if column.type_sql == "enum('ok','sad')"
    ));
    let creates = step(&e, StepKind::CreateTable);
    assert!(
        creates[0].statements[0].starts_with("CREATE TABLE `shop`.`moods`")
            && creates[0].statements[0].contains("`mood` ENUM('ok', 'sad')"),
        "{:?}",
        creates[0].statements
    );
}

#[test]
fn sqlite_changes_rebuild_the_table() {
    let target = model(
        LITE,
        vec![table(
            None,
            "orders",
            vec![pk("id", "integer"), col("code", "integer")],
        )],
        Vec::new(),
        Vec::new(),
    );
    let source = model(
        LITE,
        vec![table(
            None,
            "orders",
            vec![
                pk("id", "integer"),
                col("code", "text"),
                col("mood", "mood"),
            ],
        )],
        Vec::new(),
        vec![en(None, "mood", &["ok", "sad"])],
    );
    let d = diff(&source, &target, &CompareOptions::default());
    let designs = designs_of(&target, "main");
    let e = items_to_edits(&d, &all(&d), &designs, LITE);
    let list = &e.design_edits()[&designs.tables[0].path];
    assert!(list.iter().any(|x| matches!(
        x,
        DesignEdit::AddColumn { column, .. }
            if column.type_sql == "TEXT CHECK (\"mood\" IN ('ok', 'sad'))"
    )));
    assert!(list.iter().any(|x| matches!(
        x,
        DesignEdit::ChangeColumn { column, .. } if column.type_sql == "text"
    )));
    let plan = plan_design_for(&designs.tables[0], list, LITE).unwrap();
    assert!(
        plan.statements
            .iter()
            .any(|s| s.starts_with("CREATE TABLE")),
        "{:?}",
        plan.statements
    );
    assert!(
        plan.statements.iter().any(|s| s.starts_with("INSERT INTO")),
        "{:?}",
        plan.statements
    );
}

#[test]
fn sqlite_writes_a_new_tables_keys_inline() {
    let target = model(
        LITE,
        vec![table(None, "orders", vec![pk("id", "integer")])],
        Vec::new(),
        Vec::new(),
    );
    let source = model(
        LITE,
        vec![
            table(None, "orders", vec![pk("id", "integer")]),
            table(
                None,
                "items",
                vec![pk("id", "integer"), col("order_id", "integer")],
            ),
        ],
        vec![fk(
            None,
            ("items", "order_id"),
            ("orders", "id"),
            Some("CASCADE"),
        )],
        Vec::new(),
    );
    let d = diff(&source, &target, &CompareOptions::default());
    let e = items_to_edits(&d, &all(&d), &designs_of(&target, "main"), LITE);
    assert!(step(&e, StepKind::AddForeignKey).is_empty());
    let creates = step(&e, StepKind::CreateTable);
    assert_eq!(creates.len(), 1);
    assert_eq!(creates[0].items.len(), 2, "{:?}", creates[0].items);
    assert!(
        creates[0].statements[0].contains(
            "FOREIGN KEY (\"order_id\") REFERENCES \"orders\" (\"id\") ON DELETE CASCADE"
        ),
        "{:?}",
        creates[0].statements
    );
}

#[test]
fn mysql_drops_and_new_keys_name_the_database() {
    let target = model(
        MY,
        vec![
            table(None, "orders", vec![pk("id", "int")]),
            table(None, "old_logs", vec![pk("id", "int")]),
        ],
        Vec::new(),
        Vec::new(),
    );
    let source = model(
        MY,
        vec![
            table(None, "orders", vec![pk("id", "int")]),
            table(None, "items", vec![pk("id", "int"), col("order_id", "int")]),
        ],
        vec![fk(None, ("items", "order_id"), ("orders", "id"), None)],
        Vec::new(),
    );
    let d = diff(&source, &target, &CompareOptions::default());
    let e = items_to_edits(&d, &all(&d), &designs_of(&target, "shop"), MY);
    assert_eq!(
        step(&e, StepKind::DropTable)[0].statements,
        ["DROP TABLE `shop`.`old_logs`"]
    );
    assert_eq!(
        step(&e, StepKind::AddForeignKey)[0].statements,
        [
            "ALTER TABLE `shop`.`items` ADD FOREIGN KEY (`order_id`) REFERENCES `shop`.`orders` (`id`)"
        ]
    );
}

#[test]
fn a_missing_design_is_not_scriptable() {
    let (d, _) = pg_diff();
    let e = items_to_edits(&d, &all(&d), &TargetDesigns::default(), PG);
    assert_eq!(
        e.not_scriptable
            .get(&id("column:billing.invoices.fax:removed"))
            .map(String::as_str),
        Some("Contura could not read the table invoices on the target.")
    );
}

// ---------------------------------------------------------------------------
// Names Contura makes for new indexes.

fn name_of(e: &SyncEdits, table: &str) -> String {
    match &of(e, table)[..] {
        [(_, _, DesignEdit::AddIndex { index })] => index.name.clone(),
        other => panic!("{other:?}"),
    }
}

#[test]
fn new_index_names_fit_and_are_free() {
    let long = "t".repeat(60);
    let target = model(
        PG,
        vec![
            table(
                Some("billing"),
                &long,
                vec![pk("id", "integer"), col("a", "integer")],
            ),
            table(
                Some("billing"),
                "orders",
                vec![pk("id", "integer"), col("b", "integer")],
            ),
        ],
        Vec::new(),
        Vec::new(),
    );
    let mut source = target.clone();
    source.tables[0].indexes = vec![index(None, &["a"], false)];
    source.tables[1].indexes = vec![index(None, &["b"], false)];
    let opts = CompareOptions {
        source_schema: Some("billing".into()),
        target_schema: Some("billing".into()),
        lower_case_table_names: 0,
    };
    let d = diff(&source, &target, &opts);
    let mut designs = designs_of(&target, "freight");
    // Another table in the schema already has the name the index would get.
    designs.taken_names = vec!["orders_b_idx".into()];
    let e = items_to_edits(&d, &all(&d), &designs, PG);
    let cut = name_of(&e, &long);
    assert_eq!(cut.len(), 63, "{cut}");
    assert!(cut.starts_with(&"t".repeat(55)), "{cut}");
    assert_eq!(name_of(&e, "orders"), "orders_b_idx_2");

    // MySQL counts 64 characters, per table.
    let my_target = model(
        MY,
        vec![table(
            None,
            &"m".repeat(70),
            vec![pk("id", "int"), col("a", "int")],
        )],
        Vec::new(),
        Vec::new(),
    );
    let mut my_source = my_target.clone();
    my_source.tables[0].indexes = vec![index(None, &["a"], false)];
    let d = diff(&my_source, &my_target, &CompareOptions::default());
    let e = items_to_edits(&d, &all(&d), &designs_of(&my_target, "shop"), MY);
    let name = name_of(&e, &"m".repeat(70));
    assert_eq!(name.chars().count(), 64, "{name}");
}

// ---------------------------------------------------------------------------
// A selected item whose needs are not selected (review M3, M4).

#[test]
fn a_need_outside_the_selection_is_not_scriptable() {
    // MySQL: a key on a kept table to an unticked new table.
    let target = model(
        MY,
        vec![table(None, "orders", vec![pk("id", "int")])],
        Vec::new(),
        Vec::new(),
    );
    let source = model(
        MY,
        vec![
            table(
                None,
                "orders",
                vec![pk("id", "int"), col("refund_id", "int")],
            ),
            table(None, "refunds", vec![pk("id", "int")]),
        ],
        vec![fk(None, ("orders", "refund_id"), ("refunds", "id"), None)],
        Vec::new(),
    );
    let d = diff(&source, &target, &CompareOptions::default());
    let key = id("foreignKey:orders.(refund_id) -> refunds(id):added");
    let pick: BTreeSet<ItemId> = [id("column:orders.refund_id:added"), key.clone()].into();
    let e = items_to_edits(&d, &pick, &designs_of(&target, "shop"), MY);
    assert_eq!(
        e.not_scriptable.get(&key).map(String::as_str),
        Some("Needs CREATE TABLE refunds")
    );
    assert!(
        of(&e, "orders")
            .iter()
            .all(|(_, _, x)| !matches!(x, DesignEdit::AddForeignKey { .. }))
    );

    // SQLite: a new table's inline key to an unticked new table is left out.
    let target = model(LITE, Vec::new(), Vec::new(), Vec::new());
    let source = model(
        LITE,
        vec![
            table(None, "a_orders", vec![pk("id", "integer")]),
            table(
                None,
                "b_items",
                vec![pk("id", "integer"), col("order_id", "integer")],
            ),
        ],
        vec![fk(None, ("b_items", "order_id"), ("a_orders", "id"), None)],
        Vec::new(),
    );
    let d = diff(&source, &target, &CompareOptions::default());
    let key = id("foreignKey:b_items.(order_id) -> a_orders(id):added");
    let pick: BTreeSet<ItemId> = [id("table:b_items:added"), key.clone()].into();
    let e = items_to_edits(&d, &pick, &designs_of(&target, "main"), LITE);
    assert_eq!(
        e.not_scriptable.get(&key).map(String::as_str),
        Some("Needs CREATE TABLE a_orders")
    );
    let creates = step(&e, StepKind::CreateTable);
    assert_eq!(creates.len(), 1);
    assert_eq!(creates[0].items, [id("table:b_items:added")]);
    assert!(
        !creates[0].statements[0].contains("FOREIGN KEY"),
        "{:?}",
        creates[0].statements
    );
}
