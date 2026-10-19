use super::*;
use crate::schema_model::{SmDefault, SmEndpoint};

const PG_SOURCE: &str = include_str!("fixtures/pg_source.json");
const PG_TARGET: &str = include_str!("fixtures/pg_target.json");

fn fixture(json: &str) -> SchemaModel {
    serde_json::from_str(json).expect("fixture parses")
}

fn pg_opts() -> CompareOptions {
    CompareOptions {
        source_schema: Some("staging".into()),
        target_schema: Some("billing".into()),
        lower_case_table_names: 0,
    }
}

fn model(dialect: DialectKind, tables: Vec<SmTable>) -> SchemaModel {
    SchemaModel {
        dialect,
        tables,
        refs: Vec::new(),
        enums: Vec::new(),
        skipped: Vec::new(),
    }
}

fn table(name: &str, columns: Vec<SmColumn>) -> SmTable {
    SmTable {
        schema: None,
        name: name.into(),
        alias: None,
        note: None,
        columns,
        indexes: Vec::new(),
    }
}

fn col(name: &str, ty: &str) -> SmColumn {
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

fn pk(mut c: SmColumn) -> SmColumn {
    c.pk = true;
    c.not_null = true;
    c
}

fn with_default(mut c: SmColumn, d: SmDefault) -> SmColumn {
    c.default = Some(d);
    c
}

fn index(name: Option<&str>, columns: &[&str], unique: bool) -> SmIndex {
    SmIndex {
        name: name.map(str::to_string),
        columns: columns.iter().map(|c| c.to_string()).collect(),
        unique,
        pk: false,
    }
}

fn fk(name: Option<&str>, from: (&str, &[&str]), to: (&str, &[&str])) -> SmRef {
    let end = |(t, cols): (&str, &[&str])| SmEndpoint {
        schema: None,
        table: t.into(),
        columns: cols.iter().map(|c| c.to_string()).collect(),
    };
    SmRef {
        name: name.map(str::to_string),
        from: end(from),
        to: end(to),
        on_delete: None,
        on_update: None,
    }
}

fn ids(d: &SchemaDiff) -> Vec<&str> {
    d.items.iter().map(|i| i.id.as_str()).collect()
}

fn item<'a>(d: &'a SchemaDiff, id: &str) -> &'a DiffItem {
    d.items
        .iter()
        .find(|i| i.id.as_str() == id)
        .unwrap_or_else(|| panic!("no item {id} in {:?}", ids(d)))
}

fn needs(d: &SchemaDiff, id: &str) -> Vec<String> {
    item(d, id).needs.iter().map(|n| n.0.clone()).collect()
}

#[test]
fn each_item_kind_added_removed_changed() {
    let d = diff(&fixture(PG_SOURCE), &fixture(PG_TARGET), &pg_opts());
    assert_eq!(
        ids(&d),
        [
            "enum:billing.currency:added",
            "enum:billing.invoice_status:changed",
            "enum:billing.legacy_kind:removed",
            "table:billing.audit_log:removed",
            "column:billing.customers.fax:removed",
            "table:billing.invoices:changed",
            "column:billing.invoices.note:changed",
            "index:billing.invoices.invoices_old_idx:removed",
            "foreignKey:billing.invoices.(customer_id) -> customers(id):changed",
            "column:billing.payments.id:removed",
            "primaryKey:billing.payments:changed",
            "table:billing.refunds:added",
            "foreignKey:billing.refunds.(invoice_id) -> invoices(id):added",
        ]
    );

    let note = item(&d, "column:billing.invoices.note:changed");
    assert_eq!(
        note.changes,
        [Change::Type {
            from: "varchar(16)".into(),
            to: "varchar(24)".into()
        }]
    );
    assert_eq!(note.detail, "varchar(16) to varchar(24)");
    assert!(!note.loses_data, "a wider varchar keeps every value");

    let table_note = item(&d, "table:billing.invoices:changed");
    assert_eq!(
        table_note.changes,
        [Change::Note {
            from: None,
            to: Some("Invoices".into())
        }]
    );

    let on_delete = item(
        &d,
        "foreignKey:billing.invoices.(customer_id) -> customers(id):changed",
    );
    assert_eq!(
        on_delete.changes,
        [Change::OnDelete {
            from: None,
            to: Some("CASCADE".into())
        }]
    );

    for id in [
        "table:billing.audit_log:removed",
        "column:billing.customers.fax:removed",
        "column:billing.payments.id:removed",
    ] {
        let i = item(&d, id);
        assert!(i.loses_data, "{id} loses data");
        assert_eq!(i.data_loss, None, "counts come later");
        assert_eq!(i.path.schema.as_deref(), Some("billing"));
    }
    let fax = item(&d, "column:billing.customers.fax:removed");
    assert_eq!(fax.path.table.as_deref(), Some("customers"));
    assert_eq!(fax.path.name, "fax");
    assert_eq!(fax.detail, "varchar(32)");

    let refunds = item(&d, "table:billing.refunds:added");
    match &refunds.source_def {
        Some(ObjectDef::Table { def }) => {
            assert_eq!(
                def.schema.as_deref(),
                Some("billing"),
                "the target's schema is put back"
            );
            assert_eq!(def.columns.len(), 3);
        }
        other => panic!("the added table carries its definition: {other:?}"),
    }
    assert!(refunds.target.is_none());
    assert!(refunds.target_def.is_none());
    let text = refunds.source.as_deref().expect("the definition text");
    assert!(
        text.starts_with("CREATE TABLE \"billing\".\"refunds\" ("),
        "{text}"
    );
    assert!(refunds.scriptable.is_ok());
    assert_eq!(
        needs(
            &d,
            "foreignKey:billing.refunds.(invoice_id) -> invoices(id):added"
        ),
        ["table:billing.refunds:added"]
    );
}

#[test]
fn enum_values_added_removed_reordered() {
    let d = diff(&fixture(PG_SOURCE), &fixture(PG_TARGET), &pg_opts());
    let status = item(&d, "enum:billing.invoice_status:changed");
    assert_eq!(
        status.changes,
        [Change::EnumValues {
            added: vec!["written_off".into()],
            removed: vec!["void".into()],
            reordered: false,
        }]
    );
    assert_eq!(status.detail, "+ written_off, \u{2212} void");
    assert!(status.loses_data);
    assert_eq!(
        status.scriptable,
        Err("PostgreSQL cannot remove a value from an enum. Remove void by hand.".into())
    );

    let pg = |values: &[&str]| SchemaModel {
        enums: vec![SmEnum {
            schema: None,
            name: "mood".into(),
            values: values.iter().map(|v| v.to_string()).collect(),
        }],
        ..model(DialectKind::Postgres, Vec::new())
    };
    let opts = CompareOptions::default();
    let reordered = diff(&pg(&["a", "b", "c"]), &pg(&["b", "a", "c"]), &opts);
    assert_eq!(
        reordered.items[0].changes,
        [Change::EnumValues {
            added: vec![],
            removed: vec![],
            reordered: true,
        }]
    );
    assert!(!reordered.items[0].loses_data);
    assert_eq!(
        reordered.items[0].scriptable,
        Err("PostgreSQL cannot reorder the values of an enum. Change mood by hand.".into())
    );
    let added = diff(&pg(&["a", "b", "c"]), &pg(&["a", "b"]), &opts);
    assert_eq!(ids(&added), ["enum:mood:changed"]);
    assert_eq!(added.items[0].detail, "+ c");
    assert!(added.items[0].scriptable.is_ok());
    assert!(
        diff(&pg(&["a", "b"]), &pg(&["a", "b"]), &opts)
            .items
            .is_empty()
    );

    // A MySQL enum is a column type: its values show on the column change.
    let my = |ty: &str| model(DialectKind::MySql, vec![table("t", vec![col("mood", ty)])]);
    let d = diff(&my("enum('a','b','c')"), &my("enum('a','x')"), &opts);
    let c = item(&d, "column:t.mood:changed");
    assert!(c.changes.contains(&Change::EnumValues {
        added: vec!["b".into(), "c".into()],
        removed: vec!["x".into()],
        reordered: false,
    }));
    assert!(c.loses_data, "x is removed");
}

#[test]
fn indexes_match_by_columns_and_by_name() {
    let mut s = table(
        "t",
        vec![
            col("a", "int"),
            col("b", "int"),
            col("c", "int"),
            col("d", "int"),
        ],
    );
    s.indexes = vec![
        index(Some("ix_a"), &["a"], false),
        index(None, &["b", "c"], false),
        index(Some("ix_new"), &["d"], false),
        index(None, &["c", "d"], true),
    ];
    let mut t = s.clone();
    t.indexes = vec![
        // Same name, other columns: changed.
        index(Some("ix_a"), &["a", "b"], false),
        // Named on one side only: matched by columns.
        index(Some("t_b_c_idx"), &["b", "c"], false),
        // Both named, different names: a removal and an addition.
        index(Some("ix_old"), &["d"], false),
        // Same columns, other uniqueness: no match.
        index(Some("t_c_d_idx"), &["c", "d"], false),
    ];
    let opts = CompareOptions::default();
    let d = diff(
        &model(DialectKind::Postgres, vec![s]),
        &model(DialectKind::Postgres, vec![t]),
        &opts,
    );
    assert_eq!(
        ids(&d),
        [
            "index:t.(c, d):added",
            "index:t.ix_a:changed",
            "index:t.ix_new:added",
            "index:t.ix_old:removed",
            "index:t.t_c_d_idx:removed",
        ]
    );
    assert_eq!(
        item(&d, "index:t.ix_a:changed").changes,
        [Change::Columns {
            from: vec!["a".into(), "b".into()],
            to: vec!["a".into()],
        }]
    );
    assert_eq!(item(&d, "index:t.(c, d):added").detail, "unique index");
}

#[test]
fn single_column_unique_index_is_the_unique_flag() {
    let mut s = table("t", vec![col("email", "text")]);
    s.indexes = vec![index(Some("uq_email"), &["email"], true)];
    let mut tc = col("email", "text");
    tc.unique = true;
    let t = table("t", vec![tc]);
    let d = diff(
        &model(DialectKind::MySql, vec![s]),
        &model(DialectKind::MySql, vec![t]),
        &CompareOptions::default(),
    );
    assert!(d.items.is_empty(), "{:?}", ids(&d));
}

#[test]
fn foreign_keys_match_without_names() {
    let tables = || {
        vec![
            table(
                "customers",
                vec![pk(col("id", "integer")), col("code", "integer")],
            ),
            table(
                "orders",
                vec![pk(col("id", "integer")), col("customer_id", "integer")],
            ),
        ]
    };
    let side = |r: SmRef| SchemaModel {
        refs: vec![r],
        ..model(DialectKind::Postgres, tables())
    };
    let opts = CompareOptions::default();
    let named = fk(
        Some("fk_custom"),
        ("orders", &["customer_id"]),
        ("customers", &["id"]),
    );
    let unnamed = fk(None, ("orders", &["customer_id"]), ("customers", &["id"]));
    assert!(
        diff(&side(unnamed.clone()), &side(named.clone()), &opts)
            .items
            .is_empty()
    );
    assert!(
        diff(&side(named), &side(unnamed.clone()), &opts)
            .items
            .is_empty()
    );

    let other_target = fk(None, ("orders", &["customer_id"]), ("customers", &["code"]));
    let d = diff(&side(other_target), &side(unnamed.clone()), &opts);
    assert_eq!(
        ids(&d),
        [
            "foreignKey:orders.(customer_id) -> customers(code):added",
            "foreignKey:orders.(customer_id) -> customers(id):removed",
        ]
    );

    let mut restrict = unnamed.clone();
    restrict.on_update = Some("no action".into());
    assert!(
        diff(&side(restrict), &side(unnamed.clone()), &opts)
            .items
            .is_empty(),
        "NO ACTION is the default"
    );
    let mut cascade = unnamed.clone();
    cascade.on_update = Some("CASCADE".into());
    let d = diff(&side(cascade), &side(unnamed), &opts);
    assert_eq!(
        ids(&d),
        ["foreignKey:orders.(customer_id) -> customers(id):changed"]
    );
    assert_eq!(d.items[0].detail, "On update");
}

#[test]
fn primary_key_changes() {
    let opts = CompareOptions::default();
    let two = || {
        let mut t = table("t", vec![col("a", "int"), col("b", "int")]);
        t.indexes = vec![SmIndex {
            name: None,
            columns: vec!["a".into(), "b".into()],
            unique: true,
            pk: true,
        }];
        t
    };
    let one = || table("t", vec![pk(col("a", "int")), col("b", "int")]);
    let none = || table("t", vec![col("a", "int"), col("b", "int")]);
    let my = |t: SmTable| model(DialectKind::MySql, vec![t]);

    let d = diff(&my(two()), &my(one()), &opts);
    let pk_ids: Vec<&str> = ids(&d)
        .into_iter()
        .filter(|i| i.starts_with("primaryKey"))
        .collect();
    assert_eq!(pk_ids, ["primaryKey:t:changed"]);
    assert_eq!(
        item(&d, "primaryKey:t:changed").changes,
        [Change::Columns {
            from: vec!["a".into()],
            to: vec!["a".into(), "b".into()],
        }]
    );
    let d = diff(&my(one()), &my(none()), &opts);
    assert!(ids(&d).contains(&"primaryKey:t:added"));
    let d = diff(&my(none()), &my(one()), &opts);
    assert!(ids(&d).contains(&"primaryKey:t:removed"));
    assert!(diff(&my(one()), &my(one()), &opts).items.is_empty());
}

#[test]
fn schema_stripping() {
    let d = diff(&fixture(PG_SOURCE), &fixture(PG_TARGET), &pg_opts());
    assert!(
        d.items
            .iter()
            .all(|i| i.path.schema.as_deref() == Some("billing"))
    );
    assert!(
        !ids(&d)
            .iter()
            .any(|i| i.starts_with("column:billing.invoices.status")),
        "staging.invoice_status and invoice_status are one type"
    );

    // A model table without a schema matches the target schema's table; one in
    // another schema is not compared.
    let mut target = model(
        DialectKind::Postgres,
        vec![table("t", vec![col("a", "int")])],
    );
    target.tables[0].schema = Some("billing".into());
    let mut elsewhere = table("x", vec![col("a", "int")]);
    elsewhere.schema = Some("audit".into());
    let mut here = table("t", vec![col("a", "integer")]);
    here.schema = Some("billing".into());
    let source = model(
        DialectKind::Postgres,
        vec![table("t", vec![col("a", "int4")]), elsewhere],
    );
    let opts = CompareOptions {
        source_schema: Some("billing".into()),
        target_schema: Some("billing".into()),
        lower_case_table_names: 0,
    };
    let d = diff(&source, &target, &opts);
    assert!(d.items.is_empty(), "{:?}", ids(&d));
    assert_eq!(
        d.not_compared.source,
        [NotComparedGroup {
            kind: NotComparedKind::OtherSchema,
            count: 1,
        }]
    );
    assert!(!d.summary.matches);
    let qualified = model(DialectKind::Postgres, vec![here]);
    assert!(diff(&qualified, &target, &opts).items.is_empty());
}

#[test]
fn equivalent_forms_no_diff() {
    // PostgreSQL: a model against a snapshot.
    let source = model(
        DialectKind::Postgres,
        vec![table(
            "t",
            vec![
                pk(col("id", "serial")),
                with_default(
                    col("status", "varchar(16)"),
                    SmDefault::String {
                        value: "draft".into(),
                    },
                ),
                with_default(
                    col("created", "timestamptz"),
                    SmDefault::Expression {
                        value: "now()".into(),
                    },
                ),
                with_default(col("flag", "bool"), SmDefault::Bool { value: true }),
                col("n", "int4"),
                col("price", "decimal(10,2)"),
                col("ratio", "float8"),
                with_default(
                    col("amount", "numeric"),
                    SmDefault::Number { value: "-1".into() },
                ),
                SmColumn {
                    increment: true,
                    ..col("code", "integer")
                },
            ],
        )],
    );
    let mut target = model(
        DialectKind::Postgres,
        vec![table(
            "t",
            vec![
                SmColumn {
                    increment: true,
                    ..pk(col("id", "integer"))
                },
                with_default(
                    col("status", "character varying(16)"),
                    SmDefault::Expression {
                        value: "('draft'::character varying)".into(),
                    },
                ),
                with_default(
                    col("created", "timestamp with time zone"),
                    SmDefault::Expression {
                        value: "CURRENT_TIMESTAMP".into(),
                    },
                ),
                with_default(col("flag", "boolean"), SmDefault::Bool { value: true }),
                col("n", "integer"),
                col("price", "numeric(10,2)"),
                col("ratio", "double precision"),
                with_default(
                    col("amount", "numeric"),
                    SmDefault::String { value: "-1".into() },
                ),
                with_default(
                    col("code", "integer"),
                    SmDefault::Expression {
                        value: "nextval('t_code_seq'::regclass)".into(),
                    },
                ),
            ],
        )],
    );
    target.tables[0].schema = Some("public".into());
    let opts = CompareOptions {
        source_schema: Some("public".into()),
        target_schema: Some("public".into()),
        lower_case_table_names: 0,
    };
    let d = diff(&source, &target, &opts);
    assert!(d.items.is_empty(), "{:#?}", d.items);
    assert!(d.summary.matches);

    // MySQL: display widths, bool, decimal and CURRENT_TIMESTAMP spellings.
    let source = model(
        DialectKind::MySql,
        vec![table(
            "t",
            vec![
                SmColumn {
                    increment: true,
                    ..pk(col("id", "int(11)"))
                },
                with_default(col("active", "bool"), SmDefault::Bool { value: true }),
                col("qty", "int(10) unsigned"),
                with_default(
                    col("created", "timestamp"),
                    SmDefault::Expression {
                        value: "current_timestamp()".into(),
                    },
                ),
                with_default(
                    col("updated", "datetime"),
                    SmDefault::Expression {
                        value: "now()".into(),
                    },
                ),
                col("price", "decimal"),
            ],
        )],
    );
    let target = model(
        DialectKind::MySql,
        vec![table(
            "t",
            vec![
                SmColumn {
                    increment: true,
                    ..pk(col("id", "int"))
                },
                with_default(
                    col("active", "tinyint(1)"),
                    SmDefault::Number { value: "1".into() },
                ),
                col("qty", "int unsigned"),
                with_default(
                    col("created", "timestamp"),
                    SmDefault::Expression {
                        value: "CURRENT_TIMESTAMP".into(),
                    },
                ),
                with_default(
                    col("updated", "datetime"),
                    SmDefault::Expression {
                        value: "CURRENT_TIMESTAMP".into(),
                    },
                ),
                col("price", "decimal(10,0)"),
            ],
        )],
    );
    let d = diff(&source, &target, &CompareOptions::default());
    assert!(d.items.is_empty(), "{:#?}", d.items);

    // SQLite: the rowid key, case, and a folded unique index.
    let mut users = table(
        "Users",
        vec![
            pk(col("id", "INTEGER")),
            with_default(
                col("name", "VARCHAR(20)"),
                SmDefault::String { value: "x".into() },
            ),
            col("n", "INT"),
        ],
    );
    users.indexes = vec![index(Some("uq_name"), &["name"], true)];
    let mut name = with_default(
        col("name", "varchar(20)"),
        SmDefault::String { value: "x".into() },
    );
    name.unique = true;
    let target = model(
        DialectKind::Sqlite,
        vec![table(
            "users",
            vec![
                SmColumn {
                    increment: true,
                    ..pk(col("ID", "integer"))
                },
                name,
                col("n", "integer"),
            ],
        )],
    );
    let d = diff(
        &model(DialectKind::Sqlite, vec![users]),
        &target,
        &CompareOptions::default(),
    );
    assert!(d.items.is_empty(), "{:#?}", d.items);
}

#[test]
fn mysql_table_names_fold_by_lower_case_table_names() {
    let side = |name: &str| {
        model(
            DialectKind::MySql,
            vec![table(name, vec![col("Total", "int")])],
        )
    };
    let folded = CompareOptions {
        lower_case_table_names: 1,
        ..CompareOptions::default()
    };
    assert!(
        diff(&side("Orders"), &side("orders"), &folded)
            .items
            .is_empty()
    );
    let exact = CompareOptions::default();
    assert_eq!(
        ids(&diff(&side("Orders"), &side("orders"), &exact)),
        ["table:Orders:added", "table:orders:removed"]
    );
    // Column names never depend on case in MySQL.
    let a = model(
        DialectKind::MySql,
        vec![table("t", vec![col("Total", "int")])],
    );
    let b = model(
        DialectKind::MySql,
        vec![table("t", vec![col("total", "int")])],
    );
    assert!(diff(&a, &b, &exact).items.is_empty());
    // PostgreSQL compares names as quoted.
    let a = model(
        DialectKind::Postgres,
        vec![table("t", vec![col("Total", "int")])],
    );
    let b = model(
        DialectKind::Postgres,
        vec![table("t", vec![col("total", "int")])],
    );
    assert_eq!(
        ids(&diff(&a, &b, &exact)),
        ["column:t.Total:added", "column:t.total:removed"]
    );
}

#[test]
fn needs_follow_dependencies() {
    let opts = CompareOptions::default();
    let mut s_orders = table(
        "orders",
        vec![
            pk(col("id", "int")),
            col("refund_id", "int"),
            col("tag", "text"),
        ],
    );
    s_orders.indexes = vec![index(Some("ix_tag"), &["tag"], false)];
    let source = SchemaModel {
        refs: vec![fk(None, ("orders", &["refund_id"]), ("refunds", &["id"]))],
        ..model(
            DialectKind::MySql,
            vec![s_orders, table("refunds", vec![pk(col("id", "int"))])],
        )
    };
    let target = SchemaModel {
        refs: vec![fk(None, ("lines", &["order_id"]), ("old", &["id"]))],
        ..model(
            DialectKind::MySql,
            vec![
                table("orders", vec![pk(col("id", "int"))]),
                table("old", vec![pk(col("id", "int"))]),
                table("lines", vec![pk(col("id", "int")), col("order_id", "int")]),
            ],
        )
    };
    let d = diff(&source, &target, &opts);
    assert_eq!(
        needs(&d, "index:orders.ix_tag:added"),
        ["column:orders.tag:added"]
    );
    assert_eq!(
        needs(&d, "foreignKey:orders.(refund_id) -> refunds(id):added"),
        ["column:orders.refund_id:added", "table:refunds:added"]
    );
    // Dropping `old` needs the table whose key points at it dropped first.
    assert_eq!(needs(&d, "table:old:removed"), ["table:lines:removed"]);
    assert!(needs(&d, "table:lines:removed").is_empty());

    // A key from a kept table to a removed one is dropped before the table.
    let target = SchemaModel {
        refs: vec![fk(None, ("orders", &["id"]), ("old", &["id"]))],
        ..model(
            DialectKind::MySql,
            vec![
                table("orders", vec![pk(col("id", "int"))]),
                table("old", vec![pk(col("id", "int"))]),
            ],
        )
    };
    let source = model(
        DialectKind::MySql,
        vec![table("orders", vec![pk(col("id", "int"))])],
    );
    let d = diff(&source, &target, &opts);
    assert_eq!(
        needs(&d, "table:old:removed"),
        ["foreignKey:orders.(id) -> old(id):removed"]
    );
}

#[test]
fn enum_needs_on_postgres() {
    let mood = |values: &[&str]| SmEnum {
        schema: None,
        name: "mood".into(),
        values: values.iter().map(|v| v.to_string()).collect(),
    };
    let source = SchemaModel {
        enums: vec![mood(&["a", "b"])],
        ..model(
            DialectKind::Postgres,
            vec![table("t", vec![col("m", "mood")])],
        )
    };
    let target = SchemaModel {
        enums: vec![mood(&["a"])],
        ..model(DialectKind::Postgres, vec![table("t", vec![])])
    };
    let d = diff(&source, &target, &CompareOptions::default());
    assert_eq!(needs(&d, "column:t.m:added"), ["enum:mood:changed"]);
    assert_eq!(item(&d, "column:t.m:added").detail, "mood");
}

#[test]
fn summary_names_not_compared() {
    let base = || {
        model(
            DialectKind::Postgres,
            vec![table("t", vec![pk(col("id", "integer"))])],
        )
    };
    let opts = CompareOptions::default();
    let mut source = base();
    source.skipped = vec!["view a".into()];
    let mut target = base();
    target.skipped = vec!["view a".into(), "trigger t_audit on t".into()];
    let d = diff(&source, &target, &opts);
    assert!(d.items.is_empty());
    assert!(
        !d.summary.matches,
        "different not-compared lists never read as a match"
    );
    assert!(!d.summary.not_compared_same);
    assert_eq!(
        d.summary.not_compared_line.as_deref(),
        Some("Not compared yet: 1 view in the source; 1 view, 1 trigger in the target.")
    );
    assert_eq!(
        d.not_compared.target,
        [
            NotComparedGroup {
                kind: NotComparedKind::View,
                count: 1,
            },
            NotComparedGroup {
                kind: NotComparedKind::Trigger,
                count: 1,
            },
        ]
    );

    let mut same = base();
    same.skipped = vec![
        "view a".into(),
        "view b".into(),
        "check constraint c".into(),
        "expression index ix".into(),
    ];
    let d = diff(&same, &same, &opts);
    assert!(d.summary.matches);
    assert_eq!(
        d.summary.not_compared_line.as_deref(),
        Some("Not compared yet: 2 views, 1 check constraint, 1 expression index.")
    );
    assert_eq!(d.summary.counts_line, "1 table");

    let d = diff(&base(), &base(), &opts);
    assert!(d.summary.matches);
    assert_eq!(d.summary.not_compared_line, None);

    let d = diff(&fixture(PG_SOURCE), &fixture(PG_TARGET), &pg_opts());
    assert_eq!(
        d.summary.counts_line,
        "4 tables, 2 enums, 3 indexes, 3 Foreign Keys"
    );
    assert_eq!(
        (d.summary.added, d.summary.removed, d.summary.changed),
        (3, 5, 5)
    );
}

#[test]
fn stable_ids() {
    let source = fixture(PG_SOURCE);
    let target = fixture(PG_TARGET);
    let first = diff(&source, &target, &pg_opts());
    let mut shuffled_source = source.clone();
    shuffled_source.tables.reverse();
    shuffled_source.refs.reverse();
    shuffled_source.enums.reverse();
    for t in &mut shuffled_source.tables {
        t.indexes.reverse();
    }
    let mut shuffled_target = target.clone();
    shuffled_target.tables.reverse();
    shuffled_target.refs.reverse();
    for t in &mut shuffled_target.tables {
        t.indexes.reverse();
    }
    let second = diff(&shuffled_source, &shuffled_target, &pg_opts());
    // The same ids in the same order, whatever order the snapshots listed things in.
    assert_eq!(ids(&first), ids(&second));
    assert!(ids(&first).contains(&"column:billing.customers.fax:removed"));
}

#[test]
fn same_input_same_output() {
    let source = fixture(PG_SOURCE);
    let target = fixture(PG_TARGET);
    let a = diff(&source, &target, &pg_opts());
    let b = diff(&source, &target, &pg_opts());
    assert_eq!(a, b);
    assert_eq!(
        serde_json::to_string(&a).unwrap(),
        serde_json::to_string(&b).unwrap()
    );
}

#[test]
fn serde_shape() {
    let d = diff(&fixture(PG_SOURCE), &fixture(PG_TARGET), &pg_opts());
    let v = serde_json::to_value(item(&d, "enum:billing.invoice_status:changed")).unwrap();
    assert_eq!(v["kind"], "changed");
    assert_eq!(v["object"], "enum");
    assert_eq!(v["losesData"], true);
    assert_eq!(
        v["notScriptable"],
        "PostgreSQL cannot remove a value from an enum. Remove void by hand."
    );
    assert_eq!(v["changes"][0]["kind"], "enumValues");
    let fk = serde_json::to_value(item(
        &d,
        "foreignKey:billing.refunds.(invoice_id) -> invoices(id):added",
    ))
    .unwrap();
    assert_eq!(fk["notScriptable"], serde_json::Value::Null);
    assert_eq!(fk["object"], "foreignKey");
    assert_eq!(
        fk["source"],
        "FOREIGN KEY (\"invoice_id\") REFERENCES \"billing\".\"invoices\" (\"id\")"
    );
    let json = serde_json::to_value(&d).unwrap();
    let back: SchemaDiff = serde_json::from_value(json.clone()).unwrap();
    assert_eq!(serde_json::to_value(&back).unwrap(), json);
    let empty: DiffItem = serde_json::from_str("{}").unwrap();
    assert!(empty.scriptable.is_ok());
}

/// The wire shape of api-contract.md (ruling R2/R7): exact keys, tags and values.
#[test]
fn contract_shape() {
    use serde_json::{Value, json};
    let keys = |v: &Value| -> Vec<String> {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    };
    let d = diff(&fixture(PG_SOURCE), &fixture(PG_TARGET), &pg_opts());
    let v = serde_json::to_value(&d).unwrap();

    let item = &v["items"][0];
    assert_eq!(
        keys(item),
        [
            "changes",
            "dataLoss",
            "detail",
            "id",
            "kind",
            "losesData",
            "needs",
            "notScriptable",
            "object",
            "path",
            "source",
            "target"
        ]
    );
    assert_eq!(keys(&item["path"]), ["name", "schema", "table"]);
    for i in v["items"].as_array().unwrap() {
        assert!(["added", "removed", "changed"].contains(&i["kind"].as_str().unwrap()));
        assert!(
            [
                "table",
                "column",
                "primaryKey",
                "index",
                "foreignKey",
                "enum"
            ]
            .contains(&i["object"].as_str().unwrap())
        );
        assert!(i["source"].is_string() || i["source"].is_null());
        assert!(i["target"].is_string() || i["target"].is_null());
        assert!(i["notScriptable"].is_string() || i["notScriptable"].is_null());
        assert!(i["dataLoss"].is_null());
        for c in i["changes"].as_array().unwrap() {
            assert!(c["kind"].is_string(), "{c}");
        }
    }

    let by_id = |id: &str| {
        v["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["id"] == id)
            .unwrap()
            .clone()
    };
    assert_eq!(
        by_id("column:billing.invoices.note:changed")["changes"],
        json!([{ "kind": "type", "from": "varchar(16)", "to": "varchar(24)" }])
    );
    assert_eq!(
        by_id("foreignKey:billing.invoices.(customer_id) -> customers(id):changed")["changes"],
        json!([{ "kind": "onDelete", "from": null, "to": "CASCADE" }])
    );
    assert_eq!(
        by_id("table:billing.invoices:changed")["changes"],
        json!([{ "kind": "note", "from": null, "to": "Invoices" }])
    );
    let pk = by_id("primaryKey:billing.payments:changed");
    assert_eq!(
        pk["path"],
        json!({ "schema": "billing", "table": "payments", "name": "(invoice_id, paid_at)" })
    );
    assert_eq!(
        pk["changes"],
        json!([{ "kind": "columns", "from": ["id"], "to": ["invoice_id", "paid_at"] }])
    );
    assert_eq!(pk["source"], "PRIMARY KEY (\"invoice_id\", \"paid_at\")");
    assert_eq!(pk["target"], "PRIMARY KEY (\"id\")");
    assert_eq!(
        by_id("enum:billing.invoice_status:changed")["changes"],
        json!([{ "kind": "enumValues", "added": ["written_off"], "removed": ["void"], "reordered": false }])
    );
    assert_eq!(
        by_id("column:billing.customers.fax:removed")["target"],
        "\"fax\" character varying(32)"
    );

    assert_eq!(
        v["notCompared"],
        json!({
            "source": [{ "kind": "view", "count": 1 }],
            "target": [{ "kind": "view", "count": 1 }, { "kind": "trigger", "count": 1 }]
        })
    );
    for key in [
        "tables",
        "enums",
        "indexes",
        "foreignKeys",
        "matches",
        "notComparedLine",
    ] {
        assert!(v["summary"].get(key).is_some(), "summary.{key}");
    }
    assert_eq!(v["summary"]["matches"], false);

    // Every not-compared kind is one of the contract's names.
    let all = [
        NotComparedKind::View,
        NotComparedKind::Routine,
        NotComparedKind::Trigger,
        NotComparedKind::Check,
        NotComparedKind::GeneratedColumn,
        NotComparedKind::ExpressionIndex,
        NotComparedKind::PartialIndex,
        NotComparedKind::Comment,
        NotComparedKind::OtherSchema,
    ];
    assert_eq!(
        serde_json::to_value(all).unwrap(),
        json!([
            "view",
            "routine",
            "trigger",
            "check",
            "generatedColumn",
            "expressionIndex",
            "partialIndex",
            "comment",
            "otherSchema"
        ])
    );
}

#[test]
fn snapshot_skipped_words_map_to_kinds() {
    let mut m = model(DialectKind::Postgres, Vec::new());
    m.skipped = [
        "view v",
        "materialized view mv",
        "foreign table ft",
        "function f",
        "procedure p",
        "trigger t on x",
        "check constraint c",
        "domain dm",
        "generated column t.g",
        "expression index ix",
    ]
    .iter()
    .map(|e| e.to_string())
    .collect();
    let d = diff(&m, &m, &CompareOptions::default());
    assert_eq!(
        d.not_compared.source,
        [
            NotComparedGroup {
                kind: NotComparedKind::View,
                count: 3
            },
            NotComparedGroup {
                kind: NotComparedKind::Routine,
                count: 2
            },
            NotComparedGroup {
                kind: NotComparedKind::Trigger,
                count: 1
            },
            NotComparedGroup {
                kind: NotComparedKind::Check,
                count: 2
            },
            NotComparedGroup {
                kind: NotComparedKind::GeneratedColumn,
                count: 1
            },
            NotComparedGroup {
                kind: NotComparedKind::ExpressionIndex,
                count: 1
            },
        ]
    );
    assert_eq!(
        d.summary.not_compared_line.as_deref(),
        Some(
            "Not compared yet: 3 views, 2 routines, 1 trigger, 2 check constraints, \
             1 generated column, 1 expression index."
        )
    );
}

#[test]
fn real_differences_survive_normalising() {
    let pair = |d: DialectKind, a: SmColumn, b: SmColumn| {
        diff(
            &model(d, vec![table("t", vec![a])]),
            &model(d, vec![table("t", vec![b])]),
            &CompareOptions::default(),
        )
    };
    let differs = |d: DialectKind, a: SmColumn, b: SmColumn| {
        let r = pair(d, a.clone(), b.clone());
        assert_eq!(
            ids(&r),
            ["column:t.c:changed"],
            "{} against {} on {d:?}",
            a.type_name,
            b.type_name
        );
    };
    use DialectKind::{MySql, Postgres};
    differs(Postgres, col("c", "varchar(16)"), col("c", "varchar(24)"));
    differs(
        Postgres,
        col("c", "numeric(10,2)"),
        col("c", "numeric(12,2)"),
    );
    differs(Postgres, col("c", "timestamp"), col("c", "timestamptz"));
    let mut not_null = col("c", "text");
    not_null.not_null = true;
    differs(Postgres, col("c", "text"), not_null);
    differs(
        Postgres,
        with_default(
            col("c", "varchar(8)"),
            SmDefault::Expression {
                value: "'draft'::character varying".into(),
            },
        ),
        with_default(
            col("c", "varchar(8)"),
            SmDefault::String {
                value: "sent".into(),
            },
        ),
    );
    differs(MySql, col("c", "int"), col("c", "int unsigned"));
    differs(MySql, col("c", "tinyint(1)"), col("c", "tinyint"));
    differs(MySql, col("c", "int(5) zerofill"), col("c", "int(5)"));

    // A foreign sequence on invoices.id is a real default, not the increment.
    let model_side = model(
        Postgres,
        vec![table(
            "invoices",
            vec![with_default(
                col("id", "integer"),
                SmDefault::Expression {
                    value: "nextval('orders_id_seq'::regclass)".into(),
                },
            )],
        )],
    );
    let serial = model(Postgres, vec![table("invoices", vec![col("id", "serial")])]);
    let d = diff(&model_side, &serial, &CompareOptions::default());
    let changes = &item(&d, "column:invoices.id:changed").changes;
    assert!(
        changes.contains(&Change::Default {
            from: None,
            to: Some("NEXTVAL('orders_id_seq')".into()),
        }),
        "{changes:?}"
    );
    // Its own sequence is the increment.
    let own = model(
        Postgres,
        vec![table(
            "invoices",
            vec![with_default(
                {
                    let mut c = col("id", "integer");
                    c.not_null = true;
                    c
                },
                SmDefault::Expression {
                    value: "nextval('invoices_id_seq'::regclass)".into(),
                },
            )],
        )],
    );
    assert!(
        diff(&own, &serial, &CompareOptions::default())
            .items
            .is_empty()
    );
}

#[test]
fn serial_off_the_key_is_not_null() {
    let mut pg = col("n", "integer");
    pg.increment = true;
    pg.not_null = true;
    let d = diff(
        &model(
            DialectKind::Postgres,
            vec![table("t", vec![col("n", "serial")])],
        ),
        &model(DialectKind::Postgres, vec![table("t", vec![pg])]),
        &CompareOptions::default(),
    );
    assert!(d.items.is_empty(), "{:#?}", d.items);
    let mut my = col("n", "bigint unsigned");
    my.increment = true;
    my.not_null = true;
    my.unique = true;
    let d = diff(
        &model(
            DialectKind::MySql,
            vec![table("t", vec![col("n", "SERIAL")])],
        ),
        &model(DialectKind::MySql, vec![table("t", vec![my])]),
        &CompareOptions::default(),
    );
    assert!(d.items.is_empty(), "{:#?}", d.items);
}

#[test]
fn cross_schema_enum_is_not_the_local_one() {
    let status = |schema: &str| SmEnum {
        schema: Some(schema.into()),
        name: "status".into(),
        values: vec!["a".into()],
    };
    let side = |ty: &str| {
        let mut t = table("t", vec![col("s", ty)]);
        t.schema = Some("billing".into());
        SchemaModel {
            enums: vec![status("billing"), status("other")],
            ..model(DialectKind::Postgres, vec![t])
        }
    };
    let opts = CompareOptions {
        source_schema: Some("billing".into()),
        target_schema: Some("billing".into()),
        lower_case_table_names: 0,
    };
    let d = diff(&side("other.status"), &side("status"), &opts);
    assert_eq!(
        item(&d, "column:billing.t.s:changed").changes,
        [Change::Type {
            from: "status".into(),
            to: "other.status".into(),
        }]
    );
    assert!(
        diff(&side("billing.status"), &side("status"), &opts)
            .items
            .is_empty()
    );
}

#[test]
fn duplicate_ids_get_a_number() {
    let tables = || {
        vec![
            table("customers", vec![pk(col("id", "integer"))]),
            table(
                "orders",
                vec![pk(col("id", "integer")), col("customer_id", "integer")],
            ),
        ]
    };
    let source = model(DialectKind::Postgres, tables());
    let target = SchemaModel {
        refs: vec![
            fk(
                Some("fk_a"),
                ("orders", &["customer_id"]),
                ("customers", &["id"]),
            ),
            fk(
                Some("fk_b"),
                ("orders", &["customer_id"]),
                ("customers", &["id"]),
            ),
        ],
        ..model(DialectKind::Postgres, tables())
    };
    let d = diff(&source, &target, &CompareOptions::default());
    assert_eq!(
        ids(&d),
        [
            "foreignKey:orders.(customer_id) -> customers(id):removed",
            "foreignKey:orders.(customer_id) -> customers(id):removed#2",
        ]
    );
}

#[test]
fn sqlite_notes_are_not_compared() {
    let mut t = table("t", vec![col("a", "integer")]);
    t.note = Some("Orders".into());
    t.columns[0].note = Some("the amount".into());
    let source = model(DialectKind::Sqlite, vec![t]);
    let target = model(
        DialectKind::Sqlite,
        vec![table("t", vec![col("a", "integer")])],
    );
    let d = diff(&source, &target, &CompareOptions::default());
    assert!(d.items.is_empty());
    assert_eq!(
        d.not_compared.source,
        [NotComparedGroup {
            kind: NotComparedKind::Comment,
            count: 2,
        }]
    );
    assert!(!d.summary.matches);
    assert_eq!(
        d.summary.not_compared_line.as_deref(),
        Some("Not compared yet: 2 comments in the source.")
    );
}

/// R12: MySQL names the index it makes for a Foreign Key after the key or its
/// column, and makes it again under the key's name when the key is dropped and
/// added. An index on exactly a key's columns matches by columns on MySQL.
#[test]
fn mysql_key_index_matches_by_columns() {
    let side = |index_name: &str| {
        let mut orders = table(
            "orders",
            vec![pk(col("id", "int")), col("customer_id", "int")],
        );
        orders.indexes = vec![index(Some(index_name), &["customer_id"], false)];
        SchemaModel {
            refs: vec![fk(
                None,
                ("orders", &["customer_id"]),
                ("customers", &["id"]),
            )],
            ..model(
                DialectKind::MySql,
                vec![orders, table("customers", vec![pk(col("id", "int"))])],
            )
        }
    };
    let opts = CompareOptions::default();
    let d = diff(&side("customer_id"), &side("orders_ibfk_1"), &opts);
    assert!(d.items.is_empty(), "{:#?}", ids(&d));

    // Without the key on both sides, or on PostgreSQL, the names still count.
    let mut no_key = side("orders_ibfk_1");
    no_key.refs.clear();
    let d = diff(&side("customer_id"), &no_key, &opts);
    assert_eq!(d.items.len(), 3, "{:#?}", ids(&d));
    let pg = |name: &str| SchemaModel {
        dialect: DialectKind::Postgres,
        ..side(name)
    };
    let d = diff(&pg("customer_id"), &pg("orders_ibfk_1"), &opts);
    assert_eq!(
        ids(&d),
        [
            "index:orders.customer_id:added",
            "index:orders.orders_ibfk_1:removed"
        ]
    );
}

/// R14: only MySQL's own names match by columns. A user rename of an index on a
/// key's columns still shows as removed plus added.
#[test]
fn mysql_user_index_rename_on_key_columns_shows() {
    let side = |index_name: &str, key_name: Option<&str>| {
        let mut orders = table(
            "orders",
            vec![pk(col("id", "int")), col("customer_id", "int")],
        );
        orders.indexes = vec![index(Some(index_name), &["customer_id"], false)];
        SchemaModel {
            refs: vec![fk(
                key_name,
                ("orders", &["customer_id"]),
                ("customers", &["id"]),
            )],
            ..model(
                DialectKind::MySql,
                vec![orders, table("customers", vec![pk(col("id", "int"))])],
            )
        }
    };
    let opts = CompareOptions::default();
    let d = diff(&side("idx_b", None), &side("idx_a", None), &opts);
    assert_eq!(
        ids(&d),
        ["index:orders.idx_b:added", "index:orders.idx_a:removed"]
    );
    // One generated side is not enough.
    let d = diff(&side("idx_b", None), &side("customer_id", None), &opts);
    assert_eq!(d.items.len(), 2, "{:#?}", ids(&d));
    // The key's own name (a named key) counts as MySQL's name.
    let d = diff(
        &side("customer_id", Some("fk_customer")),
        &side("fk_customer", Some("fk_customer")),
        &opts,
    );
    assert!(d.items.is_empty(), "{:#?}", ids(&d));
    // `<table>_ibfk_<n>` on both sides (MySQL's own key names, M4): no item.
    let d = diff(
        &side("orders_ibfk_2", None),
        &side("orders_ibfk_1", None),
        &opts,
    );
    assert!(d.items.is_empty(), "{:#?}", ids(&d));
    // Not that pattern: another table's, or no number. The names count.
    let d = diff(
        &side("customers_ibfk_1", None),
        &side("orders_ibfk_1", None),
        &opts,
    );
    assert_eq!(d.items.len(), 2, "{:#?}", ids(&d));
    let d = diff(
        &side("orders_ibfk_x", None),
        &side("customer_id", None),
        &opts,
    );
    assert_eq!(d.items.len(), 2, "{:#?}", ids(&d));
}
