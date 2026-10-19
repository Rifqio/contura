use super::StructureKind as K;
use super::postgres::*;
use super::{StructureItem, texts};

fn sqls(items: &[StructureItem]) -> Vec<String> {
    items.iter().map(|i| i.sql.clone()).collect()
}

fn col(name: &str, type_sql: &str) -> PgColumn {
    PgColumn {
        name: name.into(),
        type_sql: type_sql.into(),
        ..PgColumn::default()
    }
}

fn seq(name: &str) -> PgSequence {
    PgSequence {
        name: name.into(),
        data_type: "bigint".into(),
        start: 1,
        increment: 1,
        min: 1,
        max: i64::MAX,
        cache: 1,
        cycle: false,
        last_value: 1,
        is_called: false,
        ..PgSequence::default()
    }
}

fn fixture() -> PgCatalog {
    PgCatalog {
        schema: "billing".into(),
        schema_comment: None,
        enums: vec![PgEnum {
            name: "mood".into(),
            labels: vec!["ok".into(), "it's".into()],
            comment: Some("feelings".into()),
        }],
        sequences: vec![
            PgSequence {
                last_value: 42,
                is_called: true,
                ..seq("ticket_seq")
            },
            PgSequence {
                identity_of: Some(("orders".into(), "id".into())),
                last_value: 7,
                is_called: true,
                ..seq("orders_id_seq")
            },
            PgSequence {
                identity_of: Some(("customers".into(), "id".into())),
                ..seq("customers_id_seq")
            },
        ],
        functions: vec![PgFunction {
            name: "touch".into(),
            kind: FunctionKind::Function,
            def: "CREATE OR REPLACE FUNCTION billing.touch()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$BEGIN RETURN NEW; END$function$\n".into(),
            args: "".into(),
            comment: None,
        }],
        tables: vec![
            PgTable {
                name: "customers".into(),
                columns: vec![
                    PgColumn {
                        identity: "d".into(),
                        not_null: true,
                        ..col("id", "bigint")
                    },
                    PgColumn {
                        default: Some("'ok'::billing.mood".into()),
                        ..col("mood", "billing.mood")
                    },
                    PgColumn {
                        collation: Some("pg_catalog.\"C\"".into()),
                        comment: Some("the name".into()),
                        ..col("name", "text")
                    },
                ],
                ..PgTable::default()
            },
            PgTable {
                name: "orders".into(),
                unlogged: false,
                columns: vec![
                    PgColumn {
                        identity: "a".into(),
                        not_null: true,
                        ..col("id", "bigint")
                    },
                    col("qty", "integer"),
                    PgColumn {
                        generated: "s".into(),
                        default: Some("(qty * 2)".into()),
                        ..col("twice", "integer")
                    },
                    col("customer_id", "bigint"),
                ],
                comment: Some("all orders".into()),
            },
        ],
        constraints: vec![
            PgConstraint {
                table: "orders".into(),
                name: "orders_customer_fk".into(),
                kind: 'f',
                def: "FOREIGN KEY (customer_id) REFERENCES billing.customers(id)".into(),
            },
            PgConstraint {
                table: "orders".into(),
                name: "orders_qty_check".into(),
                kind: 'c',
                def: "CHECK ((qty > 0))".into(),
            },
            PgConstraint {
                table: "orders".into(),
                name: "orders_pkey".into(),
                kind: 'p',
                def: "PRIMARY KEY (id)".into(),
            },
        ],
        indexes: vec![
            PgIndex {
                table: "orders".into(),
                def: "CREATE UNIQUE INDEX orders_pkey ON billing.orders USING btree (id)".into(),
                backs_constraint: true,
                on_materialized_view: false,
            },
            PgIndex {
                table: "orders".into(),
                def: "CREATE INDEX orders_qty ON billing.orders USING btree (qty)".into(),
                backs_constraint: false,
                on_materialized_view: false,
            },
            PgIndex {
                table: "a_totals".into(),
                def: "CREATE INDEX a_totals_q ON billing.a_totals USING btree (q)".into(),
                backs_constraint: false,
                on_materialized_view: true,
            },
        ],
        views: vec![
            PgView {
                name: "a_totals".into(),
                materialized: true,
                def: " SELECT sum(qty) AS q\n   FROM billing.v_big;".into(),
                deps: vec!["v_big".into()],
                ..PgView::default()
            },
            PgView {
                name: "v_big".into(),
                def: " SELECT id, qty\n   FROM billing.orders\n  WHERE (qty > 10);".into(),
                options: vec!["check_option=local".into()],
                ..PgView::default()
            },
        ],
        triggers: vec![(
            "orders".into(),
            "CREATE TRIGGER orders_touch BEFORE UPDATE ON billing.orders FOR EACH ROW EXECUTE FUNCTION billing.touch()".into(),
        )],
        not_included: vec!["extension pgcrypto".into(), "grants and roles".into()],
    }
}

fn position(list: &[String], needle: &str) -> usize {
    list.iter()
        .position(|s| s.contains(needle))
        .unwrap_or_else(|| panic!("{needle} not in {list:#?}"))
}

#[test]
fn settings_are_the_spec_lines() {
    let p = build(fixture());
    assert_eq!(
        texts(&p.settings),
        [
            "SET client_encoding = 'UTF8';",
            "SET standard_conforming_strings = on;",
            "SET check_function_bodies = false;",
            "SET search_path = '';",
            "SET TimeZone = 'UTC';",
        ]
    );
    assert!(p.finish.is_empty());
}

#[test]
fn before_rows_order_schema_types_sequences_functions_tables() {
    let p = build(fixture());
    let b = &sqls(&p.before_rows);
    assert_eq!(b[0], "CREATE SCHEMA IF NOT EXISTS \"billing\";");
    assert_eq!(
        b[1],
        "CREATE TYPE \"billing\".\"mood\" AS ENUM ('ok', 'it''s');"
    );
    assert_eq!(b[2], "COMMENT ON TYPE \"billing\".\"mood\" IS 'feelings';");
    assert_eq!(
        b[3],
        "CREATE SEQUENCE \"billing\".\"ticket_seq\" AS bigint INCREMENT BY 1 MINVALUE 1 \
         MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;"
    );
    // Identity sequences come with their column, not on their own.
    assert!(
        !b.iter()
            .any(|s| s.starts_with("CREATE SEQUENCE \"billing\".\"orders_id_seq\""))
    );
    let func = position(b, "FUNCTION billing.touch()");
    let customers = position(b, "TABLE \"billing\".\"customers\"");
    let orders = position(b, "TABLE \"billing\".\"orders\"");
    assert!(3 < func && func < customers && customers < orders);
    assert!(b[func].ends_with("$function$;"), "{}", b[func]);
    // No constraint is part of a CREATE TABLE.
    for s in b {
        assert!(!s.contains("PRIMARY KEY") && !s.contains("CHECK"), "{s}");
    }
    assert_eq!(p.tables, ["customers", "orders"]);
}

#[test]
fn identity_kinds_and_generated_columns() {
    let p = build(fixture());
    let b = &sqls(&p.before_rows);
    let orders = &b[position(b, "TABLE \"billing\".\"orders\"")];
    assert_eq!(
        orders,
        "CREATE TABLE \"billing\".\"orders\" (\n    \
         \"id\" bigint GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME \"billing\".\"orders_id_seq\" \
         INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE) NOT NULL,\n    \
         \"qty\" integer,\n    \
         \"twice\" integer GENERATED ALWAYS AS ((qty * 2)) STORED,\n    \
         \"customer_id\" bigint\n);"
    );
    let customers = &b[position(b, "TABLE \"billing\".\"customers\"")];
    assert!(customers.contains("\"id\" bigint GENERATED BY DEFAULT AS IDENTITY (SEQUENCE NAME \"billing\".\"customers_id_seq\""));
    assert!(customers.contains("\"mood\" billing.mood DEFAULT 'ok'::billing.mood"));
    assert!(customers.contains("\"name\" text COLLATE pg_catalog.\"C\""));
    assert!(
        b.contains(&"COMMENT ON COLUMN \"billing\".\"customers\".\"name\" IS 'the name';".into())
    );
    assert!(b.contains(&"COMMENT ON TABLE \"billing\".\"orders\" IS 'all orders';".into()));
}

#[test]
fn after_rows_constraints_indexes_fks_views_triggers_setval() {
    let p = build(fixture());
    let a = &sqls(&p.after_rows);
    let pk = position(a, "ADD CONSTRAINT \"orders_pkey\" PRIMARY KEY (id)");
    let check = position(a, "ADD CONSTRAINT \"orders_qty_check\" CHECK");
    let index = position(a, "CREATE INDEX orders_qty");
    let fk = position(a, "ADD CONSTRAINT \"orders_customer_fk\" FOREIGN KEY");
    let v_big = position(a, "CREATE VIEW \"billing\".\"v_big\"");
    let totals = position(a, "CREATE MATERIALIZED VIEW \"billing\".\"a_totals\"");
    let mv_index = position(a, "CREATE INDEX a_totals_q");
    let trigger = position(a, "CREATE TRIGGER orders_touch");
    let setval = position(a, "setval");
    assert!(pk < check && check < index && index < fk && fk < v_big);
    assert!(v_big < totals && totals < mv_index && mv_index < trigger && trigger < setval);
    // The index behind the primary key comes with the constraint.
    assert!(
        !a.iter()
            .any(|s| s.contains("CREATE UNIQUE INDEX orders_pkey"))
    );
    assert_eq!(
        a[v_big],
        "CREATE VIEW \"billing\".\"v_big\" WITH (check_option=local) AS\n\
         SELECT id, qty\n   FROM billing.orders\n  WHERE (qty > 10);"
    );
    assert_eq!(
        a[totals],
        "CREATE MATERIALIZED VIEW \"billing\".\"a_totals\" AS\nSELECT sum(qty) AS q\n   FROM billing.v_big\nWITH DATA;"
    );
    assert_eq!(
        &a[setval..],
        [
            "SELECT pg_catalog.setval('\"billing\".\"ticket_seq\"', 42, true);",
            "SELECT pg_catalog.setval('\"billing\".\"orders_id_seq\"', 7, true);",
            "SELECT pg_catalog.setval('\"billing\".\"customers_id_seq\"', 1, false);",
        ]
    );
}

#[test]
fn serial_sequences_are_owned_after_the_tables() {
    let mut c = fixture();
    c.sequences[0].owned_by = Some(("billing".into(), "orders".into(), "qty".into()));
    let p = build(c);
    let b = &sqls(&p.before_rows);
    let owned = position(
        b,
        "ALTER SEQUENCE \"billing\".\"ticket_seq\" OWNED BY \"billing\".\"orders\".\"qty\";",
    );
    assert!(owned > position(b, "TABLE \"billing\".\"orders\""));
}

#[test]
fn not_included_and_counts() {
    let p = build(fixture());
    assert_eq!(p.not_included, ["extension pgcrypto", "grants and roles"]);
    let c = p.counts;
    assert_eq!(
        (
            c.tables,
            c.indexes,
            c.foreign_keys,
            c.enums,
            c.sequences,
            c.views,
            c.functions,
            c.procedures,
            c.triggers,
            c.checks,
            c.generated
        ),
        (2, 3, 1, 1, 1, 2, 1, 0, 1, 1, 1)
    );
}

#[test]
fn items_carry_their_kind_and_table() {
    let mut c = fixture();
    c.sequences[0].owned_by = Some(("billing".into(), "orders".into(), "qty".into()));
    let p = build(c);
    let tag = |items: &[StructureItem], needle: &str| {
        let i = items
            .iter()
            .find(|i| i.sql.contains(needle))
            .unwrap_or_else(|| panic!("{needle}"));
        (i.kind, i.table.clone())
    };
    let orders = Some("orders".to_string());
    let b = &p.before_rows;
    assert_eq!(tag(b, "CREATE SCHEMA"), (K::Schema, None));
    assert_eq!(tag(b, "AS ENUM"), (K::Enum, None));
    assert_eq!(tag(b, "COMMENT ON TYPE"), (K::Comment, None));
    assert_eq!(tag(b, "CREATE SEQUENCE"), (K::Sequence, orders.clone()));
    assert_eq!(tag(b, "FUNCTION billing.touch()"), (K::Function, None));
    assert_eq!(
        tag(b, "TABLE \"billing\".\"orders\" ("),
        (K::Table, orders.clone())
    );
    assert_eq!(
        tag(b, "COMMENT ON COLUMN \"billing\".\"customers\""),
        (K::Comment, Some("customers".into()))
    );
    assert_eq!(tag(b, "OWNED BY"), (K::OwnedBy, orders.clone()));
    let a = &p.after_rows;
    assert_eq!(tag(a, "PRIMARY KEY"), (K::Constraint, orders.clone()));
    assert_eq!(tag(a, "CHECK ((qty > 0))"), (K::Check, orders.clone()));
    assert_eq!(
        tag(a, "CREATE INDEX orders_qty"),
        (K::Index, orders.clone())
    );
    assert_eq!(tag(a, "FOREIGN KEY"), (K::ForeignKey, orders.clone()));
    assert_eq!(tag(a, "CREATE VIEW"), (K::View, None));
    assert_eq!(tag(a, "CREATE INDEX a_totals_q"), (K::View, None));
    assert_eq!(tag(a, "CREATE TRIGGER"), (K::Trigger, orders.clone()));
    assert_eq!(tag(a, "orders_id_seq\"', 7"), (K::Setval, orders.clone()));
    assert!(p.settings.iter().all(|i| i.kind == K::Setting));
}

#[test]
fn sequences_of_left_out_tables_are_left_out() {
    let mut c = fixture();
    // `events` is a partitioned table: not in the Backup's tables.
    c.sequences.push(PgSequence {
        identity_of: Some(("events".into(), "id".into())),
        ..seq("events_id_seq")
    });
    c.sequences.push(PgSequence {
        owned_by: Some(("billing".into(), "events".into(), "n".into())),
        ..seq("events_n_seq")
    });
    c.sequences.push(PgSequence {
        owned_by: Some(("other".into(), "orders".into(), "n".into())),
        ..seq("elsewhere_seq")
    });
    let p = build(c);
    let all: Vec<&str> = texts(&p.before_rows)
        .into_iter()
        .chain(texts(&p.after_rows))
        .collect();
    assert!(!all.iter().any(|s| s.contains("events_id_seq")), "{all:#?}");
    assert!(!all.iter().any(|s| s.contains("OWNED BY")), "{all:#?}");
    // R33: a serial sequence of a left-out table is left out too (no CREATE, no setval),
    // also when its table is in another schema.
    assert!(!all.iter().any(|s| s.contains("events_n_seq")), "{all:#?}");
    assert!(!all.iter().any(|s| s.contains("elsewhere_seq")), "{all:#?}");
    assert_eq!(p.counts.sequences, 1);
}
