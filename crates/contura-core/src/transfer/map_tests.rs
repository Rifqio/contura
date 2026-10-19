use super::*;
use crate::model::DialectKind::{self, MySql, Postgres, Sqlite};
use crate::schema_model::{
    SchemaModel, SmColumn, SmDefault, SmEndpoint, SmEnum, SmIndex, SmRef, SmTable,
};

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

fn model(dialect: DialectKind, tables: Vec<SmTable>) -> SchemaModel {
    SchemaModel {
        dialect,
        tables,
        refs: vec![],
        enums: vec![],
        skipped: vec![],
    }
}

fn kind(k: &NoteKind) -> &'static str {
    match k {
        NoteKind::Info => "info",
        NoteKind::New => "new",
        NoteKind::NeedsChoice { .. } => "choice",
        NoteKind::NoMatch => "nomatch",
        NoteKind::Lossy => "lossy",
    }
}

/// Maps one column `c` of table `sales` and returns its target type and its notes.
fn one(src: DialectKind, ty: &str, target: DialectKind) -> (String, Vec<(&'static str, String)>) {
    let m = model(src, vec![table("sales", vec![col("c", ty)])]);
    let out = map_model(&m, target, &MapOptions::default()).unwrap();
    let c = &out.model.tables[0].columns[0];
    let notes = out
        .notes
        .iter()
        .map(|n| (kind(&n.kind), n.text.clone()))
        .collect();
    (c.type_name.clone(), notes)
}

const NO_TZ: &str = "The source has no time zone. Values are kept as they are.";
const ZERO: &str = "Zero dates (0000-00-00) are copied as NULL.";

/// (source Dialect, source type, target, target type, notes as (kind, text)).
type Row = (
    DialectKind,
    &'static str,
    DialectKind,
    &'static str,
    &'static [(&'static str, &'static str)],
);

const ROWS: &[Row] = &[
    // MySQL to PostgreSQL.
    (MySql, "tinyint", Postgres, "smallint", &[]),
    (MySql, "tinyint(4)", Postgres, "smallint", &[]),
    (MySql, "smallint", Postgres, "smallint", &[]),
    (MySql, "mediumint", Postgres, "integer", &[]),
    (MySql, "int", Postgres, "integer", &[]),
    (MySql, "int(11)", Postgres, "integer", &[]),
    (MySql, "bigint", Postgres, "bigint", &[]),
    (
        MySql,
        "int unsigned",
        Postgres,
        "bigint",
        &[("info", "int unsigned becomes bigint, so every value fits.")],
    ),
    (
        MySql,
        "bigint unsigned",
        Postgres,
        "numeric(20)",
        &[(
            "info",
            "bigint unsigned becomes numeric(20), so every value fits.",
        )],
    ),
    (
        MySql,
        "tinyint(1)",
        Postgres,
        "smallint",
        &[(
            "choice",
            "tinyint(1) is often a flag. Pick boolean or smallint.",
        )],
    ),
    (MySql, "decimal(10,2)", Postgres, "numeric(10,2)", &[]),
    (MySql, "decimal", Postgres, "numeric(10,0)", &[]),
    (MySql, "float", Postgres, "real", &[]),
    (MySql, "double", Postgres, "double precision", &[]),
    (MySql, "varchar(80)", Postgres, "varchar(80)", &[]),
    (MySql, "char(2)", Postgres, "char(2)", &[]),
    (MySql, "tinytext", Postgres, "text", &[]),
    (MySql, "mediumtext", Postgres, "text", &[]),
    (MySql, "longtext", Postgres, "text", &[]),
    (MySql, "blob", Postgres, "bytea", &[]),
    (MySql, "varbinary(16)", Postgres, "bytea", &[]),
    (MySql, "date", Postgres, "date", &[("info", ZERO)]),
    (MySql, "time", Postgres, "time", &[]),
    (
        MySql,
        "year",
        Postgres,
        "smallint",
        &[("info", "year becomes smallint.")],
    ),
    (
        MySql,
        "datetime",
        Postgres,
        "timestamp",
        &[("info", NO_TZ), ("info", ZERO)],
    ),
    (
        MySql,
        "datetime(3)",
        Postgres,
        "timestamp(3)",
        &[("info", NO_TZ), ("info", ZERO)],
    ),
    (
        MySql,
        "timestamp",
        Postgres,
        "timestamp",
        &[("info", NO_TZ), ("info", ZERO)],
    ),
    (MySql, "json", Postgres, "jsonb", &[]),
    (
        MySql,
        "point",
        Postgres,
        "text",
        &[(
            "nomatch",
            "No PostgreSQL match. Copied as text, for example POINT(-1.54 53.80).",
        )],
    ),
    (
        MySql,
        "geometry",
        Postgres,
        "text",
        &[(
            "nomatch",
            "No PostgreSQL match. Copied as text, for example POINT(-1.54 53.80).",
        )],
    ),
    (
        MySql,
        "set('a','b')",
        Postgres,
        "text",
        &[(
            "nomatch",
            "No PostgreSQL match. Copied as text, for example a,b.",
        )],
    ),
    // PostgreSQL to MySQL.
    (Postgres, "integer", MySql, "int", &[]),
    (Postgres, "smallint", MySql, "smallint", &[]),
    (Postgres, "bigint", MySql, "bigint", &[]),
    (Postgres, "boolean", MySql, "tinyint(1)", &[]),
    (Postgres, "numeric(10,2)", MySql, "decimal(10,2)", &[]),
    (
        Postgres,
        "numeric(70,10)",
        MySql,
        "text",
        &[(
            "lossy",
            "Precision 70 is above MySQL's 65. numeric(70,10) becomes text, so digits are kept.",
        )],
    ),
    (
        Postgres,
        "numeric",
        MySql,
        "text",
        &[(
            "lossy",
            "numeric has no set precision. It becomes text, so digits are kept.",
        )],
    ),
    (Postgres, "real", MySql, "float", &[]),
    (Postgres, "double precision", MySql, "double", &[]),
    (
        Postgres,
        "character varying(255)",
        MySql,
        "varchar(255)",
        &[],
    ),
    (
        Postgres,
        "character varying(20000)",
        MySql,
        "longtext",
        &[(
            "info",
            "varchar(20000) is over MySQL's 16,383 characters. It becomes longtext.",
        )],
    ),
    (Postgres, "character varying", MySql, "longtext", &[]),
    (Postgres, "character(2)", MySql, "char(2)", &[]),
    (Postgres, "text", MySql, "longtext", &[]),
    (Postgres, "bytea", MySql, "longblob", &[]),
    (Postgres, "date", MySql, "date", &[]),
    (Postgres, "time without time zone", MySql, "time", &[]),
    (
        Postgres,
        "time with time zone",
        MySql,
        "time",
        &[("info", "The time zone is not kept.")],
    ),
    (
        Postgres,
        "timestamp without time zone",
        MySql,
        "datetime(6)",
        &[],
    ),
    (
        Postgres,
        "timestamp(3) without time zone",
        MySql,
        "datetime(3)",
        &[],
    ),
    (
        Postgres,
        "timestamp with time zone",
        MySql,
        "datetime(6)",
        &[(
            "info",
            "Values are converted to UTC; the time zone is not kept.",
        )],
    ),
    (Postgres, "json", MySql, "json", &[]),
    (Postgres, "jsonb", MySql, "json", &[]),
    (
        Postgres,
        "uuid",
        MySql,
        "char(36)",
        &[(
            "choice",
            "uuid has no MySQL match. Pick char(36) or binary(16).",
        )],
    ),
    (
        Postgres,
        "inet",
        MySql,
        "text",
        &[(
            "nomatch",
            "No MySQL match. Copied as text, for example 192.168.0.1/24.",
        )],
    ),
    (
        Postgres,
        "integer[]",
        MySql,
        "text",
        &[(
            "nomatch",
            "No MySQL match. Copied as text, for example {1,2,3}.",
        )],
    ),
    (
        Postgres,
        "interval",
        MySql,
        "text",
        &[(
            "nomatch",
            "No MySQL match. Copied as text, for example 1 day 02:00:00.",
        )],
    ),
    (
        Postgres,
        "money",
        MySql,
        "text",
        &[(
            "nomatch",
            "No MySQL match. Copied as text, for example $12.50.",
        )],
    ),
    (
        Postgres,
        "int4range",
        MySql,
        "text",
        &[(
            "nomatch",
            "No MySQL match. Copied as text, for example [1,10).",
        )],
    ),
    // MySQL to SQLite.
    (MySql, "int", Sqlite, "INTEGER", &[]),
    (
        MySql,
        "bigint unsigned",
        Sqlite,
        "INTEGER",
        &[(
            "info",
            "bigint unsigned values over 9,223,372,036,854,775,807 do not fit INTEGER and stop the run.",
        )],
    ),
    (MySql, "tinyint(1)", Sqlite, "INTEGER", &[]),
    (MySql, "decimal(10,2)", Sqlite, "NUMERIC", &[]),
    (
        MySql,
        "decimal(20,2)",
        Sqlite,
        "TEXT",
        &[(
            "lossy",
            "Precision 20 is above SQLite's 15 exact digits. decimal(20,2) becomes TEXT, so digits are kept.",
        )],
    ),
    (MySql, "double", Sqlite, "REAL", &[]),
    (MySql, "varchar(80)", Sqlite, "TEXT", &[]),
    (MySql, "blob", Sqlite, "BLOB", &[]),
    (
        MySql,
        "date",
        Sqlite,
        "TEXT",
        &[("info", "Stored as ISO 8601 text."), ("info", ZERO)],
    ),
    (MySql, "json", Sqlite, "TEXT", &[]),
    (
        MySql,
        "point",
        Sqlite,
        "TEXT",
        &[(
            "nomatch",
            "No SQLite match. Copied as text, for example POINT(-1.54 53.80).",
        )],
    ),
    // PostgreSQL to SQLite.
    (Postgres, "boolean", Sqlite, "INTEGER", &[]),
    (Postgres, "uuid", Sqlite, "TEXT", &[]),
    (
        Postgres,
        "inet",
        Sqlite,
        "TEXT",
        &[(
            "nomatch",
            "No SQLite match. Copied as text, for example 192.168.0.1/24.",
        )],
    ),
    // SQLite sources, by affinity.
    (
        Sqlite,
        "INTEGER",
        Postgres,
        "bigint",
        &[(
            "info",
            "SQLite type INTEGER is copied by its affinity as bigint.",
        )],
    ),
    (
        Sqlite,
        "VARCHAR(20)",
        Postgres,
        "text",
        &[(
            "info",
            "SQLite type VARCHAR(20) is copied by its affinity as text.",
        )],
    ),
    (
        Sqlite,
        "BLOB",
        Postgres,
        "bytea",
        &[(
            "info",
            "SQLite type BLOB is copied by its affinity as bytea.",
        )],
    ),
    (
        Sqlite,
        "",
        Postgres,
        "bytea",
        &[(
            "info",
            "SQLite columns without a type are copied by their affinity as bytea.",
        )],
    ),
    (
        Sqlite,
        "REAL",
        Postgres,
        "double precision",
        &[(
            "info",
            "SQLite type REAL is copied by its affinity as double precision.",
        )],
    ),
    (
        Sqlite,
        "DATETIME",
        Postgres,
        "numeric",
        &[(
            "info",
            "SQLite type DATETIME is copied by its affinity as numeric.",
        )],
    ),
    (
        Sqlite,
        "INTEGER",
        MySql,
        "bigint",
        &[(
            "info",
            "SQLite type INTEGER is copied by its affinity as bigint.",
        )],
    ),
    (
        Sqlite,
        "TEXT",
        MySql,
        "longtext",
        &[(
            "info",
            "SQLite type TEXT is copied by its affinity as longtext.",
        )],
    ),
    (Sqlite, "TEXT", Sqlite, "TEXT", &[]),
    // The same Dialect keeps the type as it is.
    (MySql, "int unsigned", MySql, "int unsigned", &[]),
    (MySql, "point", MySql, "point", &[]),
    (Postgres, "integer[]", Postgres, "integer[]", &[]),
    (Postgres, "inet", Postgres, "inet", &[]),
];

#[test]
fn every_row_of_the_mapping_table() {
    let mut failures = Vec::new();
    for (src, ty, target, want, notes) in ROWS {
        let (got, got_notes) = one(*src, ty, *target);
        let want_notes: Vec<(&str, String)> =
            notes.iter().map(|(k, t)| (*k, t.to_string())).collect();
        if got != *want || got_notes != want_notes {
            failures.push(format!(
                "{src:?} {ty:?} -> {target:?}: got {got:?} {got_notes:?}, want {want:?} {want_notes:?}"
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn zero_dates_note_always_null() {
    for target in [MySql, Postgres, Sqlite] {
        for ty in ["date", "datetime", "timestamp"] {
            let (_, notes) = one(MySql, ty, target);
            assert!(
                notes.contains(&("info", ZERO.to_string())),
                "{ty} to {target:?}: {notes:?}"
            );
        }
    }
}

#[test]
fn uuid_to_mysql_needs_choice() {
    let m = model(Postgres, vec![table("sales", vec![col("c", "uuid")])]);
    let out = map_model(&m, MySql, &MapOptions::default()).unwrap();
    assert_eq!(out.model.tables[0].columns[0].type_name, "char(36)");
    assert_eq!(
        out.notes[0].kind,
        NoteKind::NeedsChoice {
            options: vec!["char(36)".into(), "binary(16)".into()]
        }
    );
    let mut opts = MapOptions::default();
    opts.choices
        .insert(("sales".into(), "c".into()), "binary(16)".into());
    let out = map_model(&m, MySql, &opts).unwrap();
    assert_eq!(out.model.tables[0].columns[0].type_name, "binary(16)");
    assert!(out.notes.is_empty());
}

#[test]
fn tinyint_one_choice_options_and_pick() {
    let m = model(MySql, vec![table("sales", vec![col("c", "tinyint(1)")])]);
    let out = map_model(&m, Postgres, &MapOptions::default()).unwrap();
    assert_eq!(
        out.notes[0].kind,
        NoteKind::NeedsChoice {
            options: vec!["boolean".into(), "smallint".into()]
        }
    );
    let mut opts = MapOptions::default();
    opts.choices
        .insert(("sales".into(), "c".into()), "boolean".into());
    let out = map_model(&m, Postgres, &opts).unwrap();
    assert_eq!(out.model.tables[0].columns[0].type_name, "boolean");
    assert!(out.notes.is_empty());
}

#[test]
fn enums_become_types_per_target() {
    // MySQL inline enum to PostgreSQL: a new type in the target schema.
    let m = model(
        MySql,
        vec![table(
            "sales",
            vec![col("channel", "enum('in_store','online')")],
        )],
    );
    let opts = MapOptions {
        target_schema: Some("pos".into()),
        ..Default::default()
    };
    let out = map_model(&m, Postgres, &opts).unwrap();
    assert_eq!(
        out.model.tables[0].columns[0].type_name,
        "pos.sales_channel"
    );
    assert_eq!(
        out.model.enums,
        vec![SmEnum {
            schema: Some("pos".into()),
            name: "sales_channel".into(),
            values: vec!["in_store".into(), "online".into()],
        }]
    );
    assert_eq!(out.notes[0].kind, NoteKind::New);
    assert_eq!(out.notes[0].text, "Creates the enum type pos.sales_channel");

    // To SQLite: TEXT with a CHECK on the values (the ddl writer adds it from the enum).
    let out = map_model(&m, Sqlite, &MapOptions::default()).unwrap();
    assert_eq!(out.model.tables[0].columns[0].type_name, "sales_channel");
    assert_eq!(out.model.enums[0].values, vec!["in_store", "online"]);
    assert_eq!(
        out.notes[0].text,
        "Copied as TEXT with a CHECK on its values."
    );

    // PostgreSQL enum to MySQL: an inline enum, no note.
    let mut pg = model(
        Postgres,
        vec![table("stores", vec![col("kind", "store_kind")])],
    );
    pg.enums.push(SmEnum {
        schema: Some("public".into()),
        name: "store_kind".into(),
        values: vec!["mall".into(), "street".into()],
    });
    let out = map_model(&pg, MySql, &MapOptions::default()).unwrap();
    assert_eq!(out.model.tables[0].columns[0].type_name, "store_kind");
    assert_eq!(out.model.enums[0].name, "store_kind");
    assert_eq!(out.model.enums[0].schema, None);
    assert!(out.notes.is_empty());

    // The ddl writer turns the mapped enum into the target's form.
    let script = crate::ddl::create_script(&out.model).unwrap();
    assert!(script.contains("ENUM('mall', 'street')"), "{script}");
}

#[test]
fn long_names_need_a_choice() {
    let long = "a".repeat(70);
    let m = model(MySql, vec![table("sales", vec![col(&long, "int")])]);
    let out = map_model(&m, Postgres, &MapOptions::default()).unwrap();
    let note = &out.notes[0];
    assert_eq!(note.column.as_deref(), Some(long.as_str()));
    assert_eq!(
        note.kind,
        NoteKind::NeedsChoice {
            options: vec!["a".repeat(63)]
        }
    );
    assert_eq!(
        note.text,
        format!(
            "The name {long} is longer than PostgreSQL's 63 bytes. The server would cut it, so pick a name."
        )
    );

    // A picked name that fits clears it and renames the column.
    let mut opts = MapOptions::default();
    opts.names
        .insert(("sales".into(), Some(long.clone())), "short_name".into());
    let out = map_model(&m, Postgres, &opts).unwrap();
    assert!(out.notes.is_empty());
    assert_eq!(out.model.tables[0].columns[0].name, "short_name");

    // A picked name that is still too long keeps the choice open.
    opts.names
        .insert(("sales".into(), Some(long.clone())), "b".repeat(64));
    let out = map_model(&m, Postgres, &opts).unwrap();
    assert!(matches!(out.notes[0].kind, NoteKind::NeedsChoice { .. }));

    // MySQL counts characters: 64 fit, 65 do not.
    let t65 = "t".repeat(65);
    let m = model(Postgres, vec![table(&t65, vec![col("id", "integer")])]);
    let out = map_model(&m, MySql, &MapOptions::default()).unwrap();
    assert_eq!(out.notes[0].column, None);
    assert_eq!(
        out.notes[0].text,
        format!(
            "The name {t65} is longer than MySQL's 64 characters. The server would cut it, so pick a name."
        )
    );
    let m = model(
        Postgres,
        vec![table(&"t".repeat(64), vec![col("id", "integer")])],
    );
    assert!(
        map_model(&m, MySql, &MapOptions::default())
            .unwrap()
            .notes
            .is_empty()
    );
}

#[test]
fn a_renamed_table_is_renamed_in_refs_and_indexes() {
    let long = "x".repeat(70);
    let mut m = model(
        MySql,
        vec![
            table(&long, vec![col("id", "int")]),
            table("lines", vec![col("parent_id", "int")]),
        ],
    );
    m.tables[0].indexes.push(SmIndex {
        name: None,
        columns: vec!["id".into()],
        unique: false,
        pk: true,
    });
    m.refs.push(SmRef {
        name: None,
        from: SmEndpoint {
            schema: None,
            table: "lines".into(),
            columns: vec!["parent_id".into()],
        },
        to: SmEndpoint {
            schema: None,
            table: long.clone(),
            columns: vec!["id".into()],
        },
        on_delete: None,
        on_update: None,
    });
    let mut opts = MapOptions::default();
    opts.names.insert((long.clone(), None), "parent".into());
    let out = map_model(&m, Postgres, &opts).unwrap();
    assert_eq!(out.model.tables[0].name, "parent");
    assert_eq!(out.model.refs[0].to.table, "parent");
}

#[test]
fn overrides_replace_and_recompute_notes() {
    let m = model(MySql, vec![table("sales", vec![col("c", "tinyint(1)")])]);
    let mut opts = MapOptions::default();
    opts.overrides
        .insert(("sales".into(), "c".into()), "integer".into());
    let out = map_model(&m, Postgres, &opts).unwrap();
    assert_eq!(out.model.tables[0].columns[0].type_name, "integer");
    assert!(out.notes.is_empty(), "{:?}", out.notes);
}

#[test]
fn override_not_one_expression_refused() {
    let m = model(
        MySql,
        vec![table("sales", vec![col("total", "decimal(10,2)")])],
    );
    let mut opts = MapOptions::default();
    opts.overrides
        .insert(("sales".into(), "total".into()), "int; DROP TABLE x".into());
    match map_model(&m, Postgres, &opts) {
        Err(crate::error::Error::InvalidInput(msg)) => {
            assert_eq!(msg, "The type of total is not one SQL expression.")
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn defaults_carry_or_drop_with_a_note() {
    let mut c = col("at", "datetime");
    c.default = Some(SmDefault::Expression {
        value: "CURRENT_TIMESTAMP".into(),
    });
    let mut n = col("n", "int");
    n.default = Some(SmDefault::Number { value: "0".into() });
    let mut u = col("u", "char(36)");
    u.default = Some(SmDefault::Expression {
        value: "uuid()".into(),
    });
    let m = model(MySql, vec![table("sales", vec![c, n, u])]);
    let out = map_model(&m, Postgres, &MapOptions::default()).unwrap();
    let cols = &out.model.tables[0].columns;
    assert_eq!(
        cols[0].default,
        Some(SmDefault::Expression {
            value: "now()".into()
        })
    );
    assert_eq!(
        cols[1].default,
        Some(SmDefault::Number { value: "0".into() })
    );
    assert_eq!(cols[2].default, None);
    assert!(
        out.notes
            .iter()
            .any(|n| n.text == "Default uuid() is not copied")
    );

    let mut p = col("at", "timestamp without time zone");
    p.default = Some(SmDefault::Expression {
        value: "now()".into(),
    });
    let mut s = col("id", "bigint");
    s.default = Some(SmDefault::Expression {
        value: "nextval('orders_id_seq'::regclass)".into(),
    });
    let m = model(Postgres, vec![table("orders", vec![p, s])]);
    let out = map_model(&m, MySql, &MapOptions::default()).unwrap();
    let cols = &out.model.tables[0].columns;
    assert_eq!(
        cols[0].default,
        Some(SmDefault::Expression {
            value: "CURRENT_TIMESTAMP".into()
        })
    );
    assert_eq!(cols[1].default, None);
    assert!(
        out.notes
            .iter()
            .any(|n| n.text == "Default nextval(...) is not copied")
    );

    // The same Dialect keeps every expression.
    let out = map_model(&m, Postgres, &MapOptions::default()).unwrap();
    assert!(out.notes.is_empty());
    assert_eq!(
        out.model.tables[0].columns[1].default,
        m.tables[0].columns[1].default
    );
}

#[test]
fn increments_per_target() {
    let mut id = col("id", "int");
    id.pk = true;
    id.increment = true;
    id.not_null = true;
    let m = model(MySql, vec![table("sales", vec![id.clone()])]);
    for target in [Postgres, Sqlite, MySql] {
        let out = map_model(&m, target, &MapOptions::default()).unwrap();
        assert!(out.model.tables[0].columns[0].increment, "{target:?}");
        assert!(out.notes.is_empty(), "{target:?}: {:?}", out.notes);
    }
    // SQLite: an increment that is not the single INTEGER key is left out.
    let mut k = col("k", "int");
    k.pk = true;
    let mut t = table("pairs", vec![id, k]);
    t.columns[0].pk = true;
    let m = model(MySql, vec![t]);
    let out = map_model(&m, Sqlite, &MapOptions::default()).unwrap();
    assert!(!out.model.tables[0].columns[0].increment);
    assert_eq!(
        out.notes[0].text,
        "AUTOINCREMENT is left out; values are copied as they are"
    );
}

#[test]
fn the_mapped_model_is_in_the_target_dialect_and_schema() {
    let m = model(MySql, vec![table("sales", vec![col("id", "int")])]);
    let opts = MapOptions {
        target_schema: Some("pos".into()),
        ..Default::default()
    };
    let out = map_model(&m, Postgres, &opts).unwrap();
    assert_eq!(out.model.dialect, Postgres);
    assert_eq!(out.model.tables[0].schema.as_deref(), Some("pos"));
    let out = map_model(&m, MySql, &opts).unwrap();
    assert_eq!(out.model.tables[0].schema, None);
}
