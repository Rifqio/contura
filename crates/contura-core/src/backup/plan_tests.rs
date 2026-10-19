use super::*;
use crate::backup::structure::StructureItem as I;

fn pg_parts() -> StructureParts {
    StructureParts {
        settings: vec![I::new(K::Setting, "SET TimeZone = 'UTC';")],
        before_rows: vec![
            I::new(K::Schema, "CREATE SCHEMA IF NOT EXISTS \"billing\";"),
            I::new(K::Enum, "CREATE TYPE \"billing\".\"mood\" AS ENUM ('ok');"),
            I::new(
                K::Sequence,
                "CREATE SEQUENCE \"billing\".\"ticket_seq\" AS bigint INCREMENT BY 1;",
            ),
            I::new(
                K::Function,
                "CREATE FUNCTION \"billing\".\"f\"() RETURNS int AS $$SELECT 1$$;",
            ),
            I::on(
                K::Table,
                "orders",
                "CREATE TABLE \"billing\".\"orders\" (\n    \"id\" bigint GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME \"billing\".\"orders_id_seq\" INCREMENT BY 1)\n);",
            ),
            I::on(
                K::Comment,
                "orders",
                "COMMENT ON TABLE \"billing\".\"orders\" IS 'all';",
            ),
        ],
        after_rows: vec![
            I::on(
                K::Constraint,
                "orders",
                "ALTER TABLE \"billing\".\"orders\" ADD CONSTRAINT p PRIMARY KEY (id);",
            ),
            I::on(
                K::Index,
                "orders",
                "CREATE INDEX i ON \"billing\".\"orders\" (id);",
            ),
            I::on(
                K::ForeignKey,
                "orders",
                "ALTER TABLE \"billing\".\"orders\" ADD CONSTRAINT f FOREIGN KEY (id) REFERENCES \"billing\".\"orders\" (id);",
            ),
            I::new(K::View, "CREATE VIEW \"billing\".\"v\" AS\nSELECT 1;"),
            I::new(K::Comment, "COMMENT ON VIEW \"billing\".\"v\" IS 'x';"),
            I::on(
                K::Trigger,
                "orders",
                "CREATE TRIGGER t AFTER INSERT ON \"billing\".\"orders\" FOR EACH ROW EXECUTE FUNCTION \"billing\".\"f\"();",
            ),
            I::new(
                K::Setval,
                "SELECT pg_catalog.setval('\"billing\".\"ticket_seq\"', 100, false);",
            ),
            I::on(
                K::Setval,
                "orders",
                "SELECT pg_catalog.setval('\"billing\".\"orders_id_seq\"', 5, true);",
            ),
        ],
        finish: vec![],
        not_included: vec!["extension pgcrypto".into(), "grants and roles".into()],
        tables: vec!["orders".into()],
        ..StructureParts::default()
    }
}

fn req(include: BackupInclude, drop_tables: bool) -> BackupRequest {
    BackupRequest {
        database: "freight".into(),
        schema: Some("billing".into()),
        include,
        add_drop_tables: drop_tables,
        ..BackupRequest::default()
    }
}

fn facts() -> Vec<TableFacts> {
    vec![TableFacts {
        name: "orders".into(),
        rows: 5,
    }]
}

fn build(include: BackupInclude, drop_tables: bool) -> BackupScript {
    build_script(
        DialectKind::Postgres,
        &req(include, drop_tables),
        "freight",
        &pg_parts(),
        &facts(),
        "17.0",
        "2026-10-16T22:00:00Z".into(),
    )
}

#[test]
fn everything_ticked_keeps_every_item_and_names_tables_as_their_create() {
    let s = build(BackupInclude::default(), false);
    assert_eq!(s.structure.len(), 6);
    assert_eq!(s.after_rows.len(), 8);
    assert_eq!(s.tables.len(), 1);
    assert_eq!(s.tables[0].table_sql, "\"billing\".\"orders\"");
    assert_eq!(s.tables[0].label, "billing.orders");
    assert_eq!(s.header.rows, vec![("billing.orders".to_string(), 5)]);
    assert_eq!(s.header.schema.as_deref(), Some("billing"));
    assert!(!s.header.drop_tables);
    assert!(s.header.contents.contains(&Content::Rows));
    assert_eq!(s.rows_per_statement, 500);
}

#[test]
fn add_drop_tables_writes_drop_before_each_table_and_sets_the_header() {
    let s = build(BackupInclude::default(), true);
    let drop = s
        .structure
        .iter()
        .position(|x| x == "DROP TABLE IF EXISTS \"billing\".\"orders\";")
        .expect("a DROP");
    assert!(s.structure[drop + 1].starts_with("CREATE TABLE \"billing\".\"orders\""));
    assert!(s.header.drop_tables);
    assert_eq!(
        s.structure.iter().filter(|x| x.starts_with("DROP")).count(),
        1
    );
}

#[test]
fn unticking_tables_unticks_what_needs_them() {
    let inc = BackupInclude {
        tables: false,
        ..BackupInclude::default()
    };
    let s = build(inc, true);
    assert!(s.tables.is_empty());
    assert!(s.header.rows.is_empty());
    assert!(!s.header.drop_tables);
    assert!(
        s.structure.iter().all(|x| !x.contains("TABLE")),
        "{:#?}",
        s.structure
    );
    // The standalone sequence stays with its setval; the identity one goes with its table.
    assert_eq!(
        s.after_rows,
        ["SELECT pg_catalog.setval('\"billing\".\"ticket_seq\"', 100, false);"]
    );
    assert!(s.structure.iter().any(|x| x.starts_with("CREATE SEQUENCE")));
    assert!(!s.header.contents.contains(&Content::Rows));
    assert!(!s.header.contents.contains(&Content::Views));
}

#[test]
fn postgres_enums_and_sequences_follow_tables() {
    // Ruling R21: with Tables ticked they stay, whatever the request says.
    let inc = BackupInclude {
        enums: false,
        ..BackupInclude::default()
    };
    let s = build(inc, false);
    assert!(s.structure.iter().any(|x| x.contains("ENUM")));
    assert!(s.structure.iter().any(|x| x.contains("ticket_seq")));
    assert!(s.after_rows.iter().any(|x| x.contains("ticket_seq")));
    // Without tables the tick is the user's.
    let inc = BackupInclude {
        tables: false,
        enums: false,
        ..BackupInclude::default()
    };
    let s = build(inc, false);
    assert!(
        !s.structure
            .iter()
            .any(|x| x.contains("ENUM") || x.contains("ticket_seq"))
    );
    assert!(s.after_rows.is_empty());
}

#[test]
fn effective_ties_the_ticks_per_dialect() {
    let off = |f: fn(&mut BackupInclude)| {
        let mut i = BackupInclude::default();
        f(&mut i);
        i
    };
    let no_index = off(|i| i.indexes = false);
    assert!(no_index.effective(DialectKind::MySql).indexes);
    assert!(!no_index.effective(DialectKind::Postgres).indexes);
    assert!(!no_index.effective(DialectKind::Sqlite).indexes);
    let no_enums = off(|i| i.enums = false);
    assert!(no_enums.effective(DialectKind::Postgres).enums);
    assert!(!no_enums.effective(DialectKind::MySql).enums);
    let no_tables = off(|i| i.tables = false).effective(DialectKind::MySql);
    assert!(!no_tables.indexes && !no_tables.definitions && !no_tables.rows);
}

#[test]
fn unticking_definitions_drops_views_with_their_comments_and_triggers() {
    let inc = BackupInclude {
        definitions: false,
        indexes: false,
        ..BackupInclude::default()
    };
    let s = build(inc, false);
    assert!(!s.structure.iter().any(|x| x.contains("FUNCTION")));
    assert!(
        s.structure
            .iter()
            .any(|x| x.starts_with("COMMENT ON TABLE"))
    );
    assert!(
        !s.after_rows
            .iter()
            .any(|x| x.contains("VIEW") || x.contains("TRIGGER"))
    );
    assert!(
        !s.after_rows
            .iter()
            .any(|x| x.contains("INDEX") || x.contains("FOREIGN KEY"))
    );
    assert!(s.after_rows.iter().any(|x| x.contains("PRIMARY KEY")));
}

#[test]
fn mysql_names_and_settings_follow_the_definitions_tick() {
    let parts = StructureParts {
        before_rows: vec![I::on(K::Table, "orders", "CREATE TABLE `orders` (id int);")],
        after_rows: vec![
            I::new(K::Setting, "SET sql_mode = 'STRICT_TRANS_TABLES';"),
            I::new(
                K::Procedure,
                "DELIMITER ;;\nCREATE PROCEDURE `p`() BEGIN END;;\nDELIMITER ;",
            ),
            I::new(K::Setting, "SET sql_mode = 'NO_AUTO_VALUE_ON_ZERO';"),
        ],
        tables: vec!["orders".into()],
        definer_removed: true,
        ..StructureParts::default()
    };
    let mut r = req(BackupInclude::default(), true);
    r.schema = None;
    let s = build_script(
        DialectKind::MySql,
        &r,
        "freight",
        &parts,
        &facts(),
        "8.0.30",
        "t".into(),
    );
    assert_eq!(s.structure[0], "DROP TABLE IF EXISTS `orders`;");
    assert_eq!(s.tables[0].table_sql, "`orders`");
    assert_eq!(s.tables[0].label, "orders");
    assert!(s.header.definer_removed);
    assert_eq!(s.after_rows.len(), 3);
    assert!(s.header.contents.contains(&Content::Indexes));
    r.include.definitions = false;
    let s = build_script(
        DialectKind::MySql,
        &r,
        "freight",
        &parts,
        &facts(),
        "8.0.30",
        "t".into(),
    );
    assert!(s.after_rows.is_empty());
    assert!(!s.header.definer_removed);
}

#[test]
fn sqlite_counters_go_with_their_table() {
    let parts = StructureParts {
        before_rows: vec![I::on(
            K::Table,
            "c",
            "CREATE TABLE c (id INTEGER PRIMARY KEY AUTOINCREMENT);",
        )],
        after_rows: vec![I::on(
            K::Setval,
            "c",
            "INSERT INTO \"sqlite_sequence\" (name, seq) VALUES ('c', 3);",
        )],
        finish: vec![I::new(K::UserVersion, "PRAGMA user_version = 7;")],
        tables: vec!["c".into()],
        ..StructureParts::default()
    };
    let mut r = req(BackupInclude::default(), false);
    r.schema = None;
    let s = build_script(
        DialectKind::Sqlite,
        &r,
        "app",
        &parts,
        &[],
        "3.46",
        "t".into(),
    );
    assert_eq!(s.after_rows.len(), 1);
    assert_eq!(s.finish, ["PRAGMA user_version = 7;"]);
    r.include.tables = false;
    let s = build_script(
        DialectKind::Sqlite,
        &r,
        "app",
        &parts,
        &[],
        "3.46",
        "t".into(),
    );
    assert!(s.after_rows.is_empty());
    assert_eq!(s.finish.len(), 1);
}

#[test]
fn phrases_names_and_dates() {
    assert_eq!(
        not_included_phrase("extension pgcrypto"),
        "the pgcrypto extension"
    );
    assert_eq!(not_included_phrase("large objects"), "large objects");
    assert_eq!(
        default_file_name("freight", "2026-10-17", BackupFormat::Script),
        "freight-2026-10-17.sql"
    );
    assert_eq!(
        default_file_name("a/b:c", "2026-10-17", BackupFormat::FileCopy),
        "a_b_c-2026-10-17.sqlite"
    );
    assert_eq!(
        utc_stamp(0),
        ("1970-01-01T00:00:00Z".to_string(), "1970-01-01".to_string())
    );
    // 2026-10-16T22:00:00Z.
    assert_eq!(utc_stamp(1_792_188_000).0, "2026-10-16T22:00:00Z");
    assert_eq!(utc_stamp(951_782_400).1, "2000-02-29");
    for n in [100, 500, 1_000] {
        assert_eq!(rows_per_statement(n).unwrap(), n as usize);
    }
    for n in [0, 2, 7, 999, 5_000] {
        let e = rows_per_statement(n).unwrap_err();
        assert_eq!(
            e.to_string(),
            "invalid input: Rows per INSERT must be 100, 500 or 1,000."
        );
    }
    assert_eq!(local_date(Some("2026-10-18")), Some("2026-10-18"));
    assert_eq!(local_date(Some(" 2026-10-18 ")), Some("2026-10-18"));
    for bad in ["2026-1-18", "18/10/2026", "2026-10-18T01", "", "abcd-ef-gh"] {
        assert_eq!(local_date(Some(bad)), None, "{bad}");
    }
    assert_eq!(local_date(None), None);
}

#[test]
fn requests_read_from_the_contract_json() {
    let r: BackupRequest = serde_json::from_str(
        r#"{"connectionId":"00000000-0000-0000-0000-000000000000","database":"freight",
            "schema":"billing","include":{"tables":true,"indexes":false,"enums":true,
            "definitions":true,"rows":true},"format":"fileCopy","rowsPerStatement":1000,
            "addDropTables":true,"path":"E:\\b\\f.sql","localDate":"2026-10-18"}"#,
    )
    .unwrap();
    assert_eq!(r.format, BackupFormat::FileCopy);
    assert!(!r.include.indexes && r.add_drop_tables);
    assert_eq!(r.local_date.as_deref(), Some("2026-10-18"));
    let empty: BackupRequest = serde_json::from_str("{}").unwrap();
    assert_eq!(empty, BackupRequest::default());
    let plan = serde_json::to_value(BackupPlan::default()).unwrap();
    for key in [
        "dialect",
        "counts",
        "notIncluded",
        "estimateBytes",
        "nonSnapshotTables",
        "defaultFileName",
    ] {
        assert!(plan.get(key).is_some(), "{key}");
    }
    assert!(plan["counts"].get("foreignKeys").is_some());
}
