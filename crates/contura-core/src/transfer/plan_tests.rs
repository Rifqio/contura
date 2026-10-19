use super::plan::*;
use crate::error::{Error, Result};
use crate::model::DialectKind::{self, MySql, Postgres, Sqlite};
use crate::schema_model::*;

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

fn id() -> SmColumn {
    SmColumn {
        pk: true,
        increment: true,
        not_null: true,
        ..col("id", "int")
    }
}

fn table(name: &str, columns: Vec<SmColumn>) -> SmTable {
    SmTable {
        schema: None,
        name: name.into(),
        alias: None,
        note: None,
        columns,
        indexes: vec![],
    }
}

fn fk(from: &str, column: &str, to: &str) -> SmRef {
    SmRef {
        name: None,
        from: SmEndpoint {
            schema: None,
            table: from.into(),
            columns: vec![column.into()],
        },
        to: SmEndpoint {
            schema: None,
            table: to.into(),
            columns: vec!["id".into()],
        },
        on_delete: None,
        on_update: None,
    }
}

/// A MySQL source: orders first in model order, so parents-first must reorder it.
fn source() -> SchemaModel {
    let mut sales = table(
        "sales",
        vec![
            id(),
            col("store_id", "int"),
            col("channel", "enum('in_store','online')"),
            col("total", "decimal(10,2)"),
        ],
    );
    sales.indexes.push(SmIndex {
        name: Some("ix_sales_store".into()),
        columns: vec!["store_id".into()],
        unique: false,
        pk: false,
    });
    SchemaModel {
        dialect: MySql,
        tables: vec![
            sales,
            table("stores", vec![id(), col("name", "varchar(80)")]),
            table("audit", vec![id(), col("note", "text")]),
        ],
        refs: vec![fk("sales", "store_id", "stores")],
        enums: vec![],
        skipped: vec!["view v_sales".into(), "trigger sales_touch".into()],
    }
}

fn side(conn: u128, database: &str, schema: Option<&str>) -> Side {
    Side {
        connection_id: uuid::Uuid::from_u128(conn),
        database: database.into(),
        schema: schema.map(str::to_string),
    }
}

fn tick(names: &[&str]) -> Vec<TableChoice> {
    names
        .iter()
        .map(|n| TableChoice {
            name: n.to_string(),
            ticked: true,
            if_exists: IfExists::Stop,
        })
        .collect()
}

fn req(target_db: &str, schema: Option<&str>) -> TransferRequest {
    TransferRequest {
        source: side(1, "pos_live", None),
        target: side(2, target_db, schema),
        tables: tick(&["sales", "stores"]),
        batch_rows: 1_000,
        compare_counts: true,
        ..Default::default()
    }
}

fn empty(dialect: DialectKind) -> TargetState {
    TargetState {
        dialect,
        connection_name: "pinecone-analytics".into(),
        tables: vec![],
    }
}

fn existing(dialect: DialectKind, tables: Vec<TargetTable>) -> TargetState {
    TargetState {
        tables,
        ..empty(dialect)
    }
}

fn tcol(name: &str, not_null: bool) -> TargetColumn {
    TargetColumn {
        name: name.into(),
        not_null,
        ..Default::default()
    }
}

fn refused(r: Result<TransferPlan>) -> String {
    match r {
        Err(Error::InvalidInput(m)) => m,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn load_order_parents_first_then_the_users_order() {
    let r = req("analytics", Some("pos"));
    let p = plan_transfer(&r, &source(), &empty(Postgres)).unwrap();
    let order: Vec<&str> = p.copies.iter().map(|c| c.table.as_str()).collect();
    assert_eq!(order, ["stores", "sales"]);

    // A child dragged before its parent keeps the user's order, with a note.
    let r = TransferRequest {
        order: vec!["sales".into(), "stores".into()],
        ..r
    };
    let p = plan_transfer(&r, &source(), &empty(Postgres)).unwrap();
    let order: Vec<&str> = p.copies.iter().map(|c| c.table.as_str()).collect();
    assert_eq!(order, ["sales", "stores"]);
    assert!(p.notes.contains(&PlanNote {
        table: "sales".into(),
        text: "sales loads before stores, which it needs".into(),
    }));
}

#[test]
fn a_cycle_keeps_model_order() {
    let mut m = source();
    m.tables[1].columns.push(col("best_sale_id", "int"));
    m.refs.push(fk("stores", "best_sale_id", "sales"));
    let p = plan_transfer(&req("analytics", Some("pos")), &m, &empty(Postgres)).unwrap();
    let order: Vec<&str> = p.copies.iter().map(|c| c.table.as_str()).collect();
    assert_eq!(order, ["sales", "stores"]);
}

#[test]
fn postgres_structure_and_after_rows() {
    let p = plan_transfer(
        &TransferRequest {
            create_target_scope: true,
            ..req("analytics", Some("pos"))
        },
        &source(),
        &empty(Postgres),
    )
    .unwrap();
    assert_eq!(p.mode, TransferMode::OneTransaction);
    assert_eq!(
        p.mode_line,
        "PostgreSQL target: everything runs in one transaction. Cancel rolls it all back."
    );
    assert_eq!(p.structure[0], "CREATE SCHEMA IF NOT EXISTS \"pos\";");
    assert_eq!(
        p.structure[1],
        "CREATE TYPE \"pos\".\"sales_channel\" AS ENUM ('in_store', 'online');"
    );
    // Tables with no Foreign Keys; they come after the rows.
    assert!(
        p.structure.iter().all(|s| !s.contains("FOREIGN KEY")),
        "{:#?}",
        p.structure
    );
    assert!(
        p.structure
            .iter()
            .any(|s| s.starts_with("CREATE TABLE \"pos\".\"stores\""))
    );
    assert_eq!(
        p.after_rows,
        vec![
            "CREATE INDEX \"ix_sales_store\" ON \"pos\".\"sales\" (\"store_id\");",
            "ALTER TABLE \"pos\".\"sales\" ADD FOREIGN KEY (\"store_id\") REFERENCES \"pos\".\"stores\" (\"id\");",
            "SELECT setval(pg_get_serial_sequence('\"pos\".\"stores\"', 'id'), coalesce(max(\"id\"), 1), max(\"id\") IS NOT NULL) FROM \"pos\".\"stores\";",
            "SELECT setval(pg_get_serial_sequence('\"pos\".\"sales\"', 'id'), coalesce(max(\"id\"), 1), max(\"id\") IS NOT NULL) FROM \"pos\".\"sales\";",
        ]
    );
    let sales = p.copies.iter().find(|c| c.table == "sales").unwrap();
    assert_eq!(sales.source, "pos_live.sales");
    assert_eq!(sales.target, "pos.sales");
    assert_eq!(
        sales.select,
        "SELECT `id`, `store_id`, `channel`, `total` FROM `pos_live`.`sales`"
    );
    assert_eq!(
        sales.insert_head,
        "INSERT INTO \"pos\".\"sales\" (\"id\", \"store_id\", \"channel\", \"total\")"
    );
    assert_eq!(sales.columns[3].target_type, "numeric(10,2)");
    assert_eq!(p.not_copied, vec!["view v_sales", "trigger sales_touch"]);
}

#[test]
fn mysql_structure_keeps_foreign_keys_with_the_table() {
    let mut m = source();
    m.dialect = Postgres;
    for t in &mut m.tables {
        for c in &mut t.columns {
            if c.type_name == "int" {
                c.type_name = "integer".into();
            }
            if c.type_name.starts_with("enum") {
                c.type_name = "text".into();
            }
        }
    }
    let p = plan_transfer(&req("analytics", None), &m, &empty(MySql)).unwrap();
    assert_eq!(p.mode, TransferMode::PerTable);
    assert_eq!(
        p.mode_line,
        "MySQL creates tables one by one and they stay if a later step fails. Each table's rows are copied in its own transaction."
    );
    let sales = p
        .structure
        .iter()
        .find(|s| s.starts_with("CREATE TABLE `sales`"))
        .unwrap();
    assert!(
        sales.contains("FOREIGN KEY (`store_id`) REFERENCES `stores` (`id`)"),
        "{sales}"
    );
    assert_eq!(
        p.after_rows,
        vec!["CREATE INDEX `ix_sales_store` ON `sales` (`store_id`);"]
    );
}

#[test]
fn sqlite_structure_with_its_pragmas() {
    let p = plan_transfer(&req("/tmp/a.sqlite", None), &source(), &empty(Sqlite)).unwrap();
    assert_eq!(p.structure[0], "PRAGMA foreign_keys = OFF;");
    let sales = p
        .structure
        .iter()
        .find(|s| s.starts_with("CREATE TABLE \"sales\""))
        .unwrap();
    assert!(sales.contains("REFERENCES \"stores\""), "{sales}");
    assert_eq!(p.after_rows.last().unwrap(), "PRAGMA foreign_key_check;");
    assert_eq!(
        p.mode_line,
        "SQLite target: everything runs in one transaction. Cancel rolls it all back. SQLite keeps any value in any column. Types here set affinity only."
    );
}

#[test]
fn empty_it_first_uses_delete_never_truncate() {
    let mut r = req("analytics", Some("pos"));
    for t in &mut r.tables {
        t.if_exists = IfExists::EmptyFirst;
    }
    let target = existing(
        Postgres,
        vec![
            TargetTable {
                name: "stores".into(),
                rows: Some(412),
                columns: vec![tcol("id", true), tcol("name", false)],
            },
            TargetTable {
                name: "sales".into(),
                rows: Some(2_316),
                columns: vec![
                    tcol("id", true),
                    tcol("store_id", false),
                    tcol("channel", false),
                    tcol("total", false),
                ],
            },
        ],
    );
    let p = plan_transfer(&r, &source(), &target).unwrap();
    // Children first, so a Foreign Key between them holds.
    assert_eq!(
        p.structure,
        vec![
            "DELETE FROM \"pos\".\"sales\";",
            "DELETE FROM \"pos\".\"stores\";",
        ]
    );
    assert!(
        p.structure
            .iter()
            .chain(&p.after_rows)
            .all(|s| !s.contains("TRUNCATE"))
    );
    assert_eq!(
        p.emptied,
        vec![
            Emptied {
                table: "sales".into(),
                rows: Some(2_316)
            },
            Emptied {
                table: "stores".into(),
                rows: Some(412)
            },
        ]
    );
    // Existing tables are not created again, and their keys are already there.
    assert!(p.after_rows.is_empty(), "{:#?}", p.after_rows);
}

#[test]
fn append_refuses_unmapped_required_column() {
    let mut r = req("analytics", Some("pos"));
    r.tables = tick(&["sales"]);
    r.tables[0].if_exists = IfExists::Append;
    // The target table has no column channel.
    let target = existing(
        Postgres,
        vec![TargetTable {
            name: "sales".into(),
            rows: None,
            columns: vec![
                tcol("id", true),
                tcol("store_id", false),
                tcol("total", false),
            ],
        }],
    );
    assert_eq!(
        refused(plan_transfer(&r, &source(), &target)),
        "pos.sales on the target has no column channel. Map it or untick it."
    );
    // A target column the copy does not fill must be nullable, have a default or be generated.
    let target = existing(
        Postgres,
        vec![TargetTable {
            name: "sales".into(),
            rows: None,
            columns: vec![
                tcol("id", true),
                tcol("store_id", false),
                tcol("channel", false),
                tcol("total", false),
                tcol("region", true),
            ],
        }],
    );
    assert_eq!(
        refused(plan_transfer(&r, &source(), &target)),
        "pos.sales on the target needs a value for region, which is not copied. Give it a default or untick it."
    );
    // With a default it appends.
    let mut ok = target.clone();
    ok.tables[0].columns[4].has_default = true;
    let p = plan_transfer(&r, &source(), &ok).unwrap();
    assert!(p.structure.is_empty());
    assert_eq!(p.copies.len(), 1);
}

#[test]
fn append_into_an_always_identity_overrides() {
    let mut r = req("analytics", Some("pos"));
    r.tables = tick(&["stores"]);
    r.tables[0].if_exists = IfExists::Append;
    let target = existing(
        Postgres,
        vec![TargetTable {
            name: "stores".into(),
            rows: None,
            columns: vec![
                TargetColumn {
                    identity_always: true,
                    generated: true,
                    ..tcol("id", true)
                },
                tcol("name", false),
            ],
        }],
    );
    let p = plan_transfer(&r, &source(), &target).unwrap();
    assert_eq!(
        p.copies[0].insert_head,
        "INSERT INTO \"pos\".\"stores\" (\"id\", \"name\") OVERRIDING SYSTEM VALUE"
    );
}

#[test]
fn stop_refuses_with_the_spec_text() {
    let target = existing(
        Postgres,
        vec![TargetTable {
            name: "stores".into(),
            rows: None,
            columns: vec![tcol("id", true)],
        }],
    );
    assert_eq!(
        refused(plan_transfer(
            &req("analytics", Some("pos")),
            &source(),
            &target
        )),
        "stores already exists on pinecone-analytics. Choose Append or Empty it first, or untick it."
    );
}

#[test]
fn rows_only_needs_the_table_on_the_target() {
    let r = TransferRequest {
        copy: CopyKind::RowsOnly,
        ..req("analytics", Some("pos"))
    };
    assert_eq!(
        refused(plan_transfer(&r, &source(), &empty(Postgres))),
        "stores is not on pinecone-analytics. Copy the structure too, or untick it."
    );
}

#[test]
fn structure_only_copies_no_rows() {
    let r = TransferRequest {
        copy: CopyKind::StructureOnly,
        ..req("analytics", Some("pos"))
    };
    let p = plan_transfer(&r, &source(), &empty(Postgres)).unwrap();
    assert!(p.copies.is_empty());
    assert!(!p.structure.is_empty());
    // No rows, so no sequence to move on.
    assert!(p.after_rows.iter().all(|s| !s.contains("setval")));
}

#[test]
fn the_same_side_is_refused() {
    let mut r = req("pos_live", None);
    r.target.connection_id = r.source.connection_id;
    assert_eq!(
        refused(plan_transfer(&r, &source(), &empty(MySql))),
        "Source and target are the same. Pick another target."
    );
}

#[test]
fn a_parent_not_ticked_is_left_out_with_a_note() {
    let mut r = req("analytics", Some("pos"));
    r.tables = tick(&["sales"]);
    let p = plan_transfer(&r, &source(), &empty(Postgres)).unwrap();
    assert!(p.notes.contains(&PlanNote {
        table: "sales".into(),
        text: "Needs stores, which is not ticked".into(),
    }));
    assert!(
        p.structure
            .iter()
            .chain(&p.after_rows)
            .all(|s| !s.contains("FOREIGN KEY")),
        "the key to stores is left out"
    );
}

#[test]
fn a_column_needing_a_choice_blocks() {
    let mut m = source();
    m.tables[1].columns.push(col("open", "tinyint(1)"));
    let r = req("analytics", Some("pos"));
    let p = plan_transfer(&r, &m, &empty(Postgres)).unwrap();
    assert_eq!(
        p.blocked,
        vec!["stores.open: tinyint(1) is often a flag. Pick boolean or smallint."]
    );
    let mut r = r;
    r.choices.push(ColumnSetting {
        table: "stores".into(),
        column: Some("open".into()),
        value: "boolean".into(),
    });
    let p = plan_transfer(&r, &m, &empty(Postgres)).unwrap();
    assert!(p.blocked.is_empty());
}

#[test]
fn fingerprint_covers_every_input() {
    let m = source();
    let base = req("analytics", Some("pos"));
    let target = empty(Postgres);
    let fp = |r: &TransferRequest, m: &SchemaModel, t: &TargetState| {
        plan_transfer(r, m, t).unwrap().fingerprint
    };
    let first = fp(&base, &m, &target);
    assert_eq!(first, fp(&base, &m, &target), "stable for the same input");
    assert_eq!(first.len(), 64);

    let mut changed: Vec<(&str, String)> = Vec::new();
    let mut r = base.clone();
    r.overrides.push(ColumnSetting {
        table: "sales".into(),
        column: Some("total".into()),
        value: "numeric(12,2)".into(),
    });
    changed.push(("a type", fp(&r, &m, &target)));
    let mut r = base.clone();
    r.tables = tick(&["stores"]);
    changed.push(("a tick", fp(&r, &m, &target)));
    let mut r = base.clone();
    r.order = vec!["sales".into(), "stores".into()];
    changed.push(("the order", fp(&r, &m, &target)));
    let mut r = base.clone();
    r.batch_rows = 500;
    changed.push(("the batch", fp(&r, &m, &target)));
    let mut r = base.clone();
    r.compare_counts = false;
    changed.push(("compare counts", fp(&r, &m, &target)));
    let mut r = base.clone();
    r.create_target_scope = true;
    changed.push(("create scope", fp(&r, &m, &target)));
    let mut r = base.clone();
    r.target.schema = Some("other".into());
    changed.push(("the target schema", fp(&r, &m, &target)));
    let mut r = base.clone();
    r.target.connection_id = uuid::Uuid::from_u128(3);
    changed.push(("the target Connection", fp(&r, &m, &target)));
    // A table appearing on the target (as Append, so the plan still builds).
    let mut r = base.clone();
    r.tables[1].if_exists = IfExists::Append;
    let appeared = existing(
        Postgres,
        vec![TargetTable {
            name: "stores".into(),
            rows: None,
            columns: vec![tcol("id", true), tcol("name", false)],
        }],
    );
    changed.push(("the target state", fp(&r, &m, &appeared)));
    let mut m2 = m.clone();
    m2.tables[1].columns[1].type_name = "varchar(90)".into();
    changed.push(("the source", fp(&base, &m2, &target)));

    for (what, fp) in &changed {
        assert_ne!(*fp, first, "{what} must change the fingerprint");
    }
}

#[test]
fn mysql_groups_keys_whose_child_loads_first() {
    // A cycle: customers.best_order_id -> orders.id and orders.customer_id -> customers.id.
    let customers = table("customers", vec![id(), col("best_order_id", "integer")]);
    let orders = table("orders", vec![id(), col("customer_id", "integer")]);
    let mut m = SchemaModel {
        dialect: Postgres,
        tables: vec![customers, orders, table("misc", vec![id()])],
        refs: vec![
            fk("orders", "customer_id", "customers"),
            fk("customers", "best_order_id", "orders"),
        ],
        enums: vec![],
        skipped: vec![],
    };
    for t in &mut m.tables {
        t.columns[0].type_name = "integer".into();
    }
    let mut r = req("analytics", None);
    r.tables = tick(&["customers", "orders", "misc"]);
    let p = plan_transfer(&r, &m, &empty(MySql)).unwrap();
    assert_eq!(
        p.fk_groups,
        vec![vec!["customers".to_string(), "orders".to_string()]]
    );
    let check = p
        .orphan_checks
        .iter()
        .find(|c| c.table == "orders")
        .unwrap();
    assert_eq!(check.columns, vec!["customer_id"]);
    assert_eq!(check.parent, "customers");
    assert_eq!(
        check.sample_sql,
        "SELECT CAST(c.`customer_id` AS CHAR) FROM `orders` c LEFT JOIN `customers` p ON p.`id` = c.`customer_id` WHERE c.`customer_id` IS NOT NULL AND p.`id` IS NULL LIMIT 1"
    );
    assert_eq!(
        check.count_sql,
        "SELECT CAST(count(*) AS CHAR) FROM `orders` c LEFT JOIN `customers` p ON p.`id` = c.`customer_id` WHERE c.`customer_id` IS NOT NULL AND p.`id` IS NULL"
    );
    // Other targets check keys themselves (PostgreSQL after the rows, SQLite by pragma).
    let p = plan_transfer(&r, &m, &empty(Postgres)).unwrap();
    assert!(p.fk_groups.is_empty() && p.orphan_checks.is_empty());
}

#[test]
fn copies_name_their_key_columns() {
    let p = plan_transfer(&req("analytics", Some("pos")), &source(), &empty(Postgres)).unwrap();
    assert_eq!(p.copies[0].key_columns, vec!["id"]);
}

#[test]
fn mysql_group_checks_keys_to_parents_loaded_before_it() {
    // customers and orders form a cycle; orders.store_id points at stores, loaded first.
    let mut m = SchemaModel {
        dialect: Postgres,
        tables: vec![
            table("stores", vec![id()]),
            table("customers", vec![id(), col("best_order_id", "integer")]),
            table(
                "orders",
                vec![
                    id(),
                    col("customer_id", "integer"),
                    col("store_id", "integer"),
                ],
            ),
        ],
        refs: vec![
            fk("orders", "customer_id", "customers"),
            fk("customers", "best_order_id", "orders"),
            fk("orders", "store_id", "stores"),
        ],
        enums: vec![],
        skipped: vec![],
    };
    for t in &mut m.tables {
        t.columns[0].type_name = "integer".into();
    }
    let mut r = req("analytics", None);
    r.tables = tick(&["stores", "customers", "orders"]);
    let p = plan_transfer(&r, &m, &empty(MySql)).unwrap();
    assert_eq!(
        p.fk_groups,
        vec![vec!["customers".to_string(), "orders".to_string()]]
    );
    assert!(
        p.orphan_checks
            .iter()
            .any(|c| c.table == "orders" && c.parent == "stores"),
        "{:?}",
        p.orphan_checks
    );
}

#[test]
fn mysql_groups_a_parent_and_child_both_emptied_first() {
    let mut m = SchemaModel {
        dialect: Postgres,
        tables: vec![
            table("stores", vec![id()]),
            table("sales", vec![id(), col("store_id", "integer")]),
        ],
        refs: vec![fk("sales", "store_id", "stores")],
        enums: vec![],
        skipped: vec![],
    };
    for t in &mut m.tables {
        t.columns[0].type_name = "integer".into();
    }
    let target = TargetState {
        dialect: MySql,
        connection_name: "analytics".into(),
        tables: vec![
            TargetTable {
                name: "stores".into(),
                rows: Some(3),
                columns: vec![tcol("id", true)],
            },
            TargetTable {
                name: "sales".into(),
                rows: Some(9),
                columns: vec![tcol("id", true), tcol("store_id", false)],
            },
        ],
    };
    let mut r = req("analytics", None);
    r.tables = tick(&["stores", "sales"]);
    for t in &mut r.tables {
        t.if_exists = IfExists::EmptyFirst;
    }
    let p = plan_transfer(&r, &m, &target).unwrap();
    assert_eq!(
        p.fk_groups,
        vec![vec!["stores".to_string(), "sales".to_string()]]
    );
    // Review SQL lists the DELETEs child first, as the group runs them.
    let deletes: Vec<&String> = p
        .structure
        .iter()
        .filter(|s| s.starts_with("DELETE"))
        .collect();
    assert_eq!(deletes, ["DELETE FROM `sales`;", "DELETE FROM `stores`;"]);
    // Append keeps the tables apart: nothing is deleted.
    for t in &mut r.tables {
        t.if_exists = IfExists::Append;
    }
    assert!(plan_transfer(&r, &m, &target).unwrap().fk_groups.is_empty());
}

#[test]
fn append_into_an_identity_table_moves_its_counter() {
    let mut r = req("analytics", Some("pos"));
    for t in &mut r.tables {
        t.if_exists = IfExists::Append;
    }
    let m = source();
    let first = &m.tables[0];
    let target = TargetState {
        dialect: Postgres,
        connection_name: "analytics".into(),
        tables: vec![TargetTable {
            name: first.name.clone(),
            rows: Some(5),
            columns: first
                .columns
                .iter()
                .map(|c| TargetColumn {
                    generated: c.name == "id",
                    ..tcol(&c.name, false)
                })
                .collect(),
        }],
    };
    let p = plan_transfer(&r, &m, &target).unwrap();
    assert!(
        p.after_rows.iter().any(|s| s.starts_with("SELECT setval(")
            && s.ends_with(&format!("FROM \"pos\".\"{}\";", first.name))),
        "{:?}",
        p.after_rows
    );
}
