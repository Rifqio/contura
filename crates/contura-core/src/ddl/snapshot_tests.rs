//! The Schema Builder export must stay byte-identical when the writer is split into
//! parts for Data Transfer (step 8, Task 3). The snapshots were captured from the
//! writer before the split; set `CONTURA_BLESS=1` only to capture them again.

use super::create_script_dated;
use crate::model::DialectKind;
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

fn ep(schema: Option<&str>, table: &str, columns: &[&str]) -> SmEndpoint {
    SmEndpoint {
        schema: schema.map(str::to_string),
        table: table.into(),
        columns: columns.iter().map(|c| c.to_string()).collect(),
    }
}

/// Enums, notes, a composite key, unnamed and unique indexes, every default shape,
/// a forward reference and a two-table cycle, all in schema `pos`.
fn rich(dialect: DialectKind) -> SchemaModel {
    let s = Some("pos".to_string());
    let id = SmColumn {
        pk: true,
        increment: true,
        not_null: true,
        ..col("id", "integer")
    };
    let table =
        |name: &str, columns: Vec<SmColumn>, indexes: Vec<SmIndex>, note: Option<&str>| SmTable {
            schema: s.clone(),
            name: name.into(),
            alias: None,
            note: note.map(str::to_string),
            columns,
            indexes,
        };
    SchemaModel {
        dialect,
        tables: vec![
            table(
                "sales",
                vec![
                    id.clone(),
                    SmColumn {
                        not_null: true,
                        ..col("store_id", "integer")
                    },
                    SmColumn {
                        default: Some(SmDefault::String {
                            value: "in_store".into(),
                        }),
                        ..col("channel", "sales_channel")
                    },
                    SmColumn {
                        default: Some(SmDefault::Expression {
                            value: "CURRENT_TIMESTAMP".into(),
                        }),
                        note: Some("when it was rung up".into()),
                        ..col("sold_at", "timestamp")
                    },
                    SmColumn {
                        default: Some(SmDefault::Number { value: "0".into() }),
                        ..col("total", "decimal(10,2)")
                    },
                    SmColumn {
                        default: Some(SmDefault::Bool { value: false }),
                        ..col("voided", "boolean")
                    },
                    SmColumn {
                        default: Some(SmDefault::Null),
                        ..col("memo", "varchar(200)")
                    },
                    SmColumn {
                        default: Some(SmDefault::Expression {
                            value: "lower('X')".into(),
                        }),
                        ..col("code", "varchar(8)")
                    },
                ],
                vec![
                    SmIndex {
                        name: None,
                        columns: vec!["store_id".into(), "sold_at".into()],
                        unique: false,
                        pk: false,
                    },
                    SmIndex {
                        name: Some("ux_sales_code".into()),
                        columns: vec!["code".into()],
                        unique: true,
                        pk: false,
                    },
                ],
                Some("one row per sale"),
            ),
            table(
                "stores",
                vec![
                    id.clone(),
                    SmColumn {
                        not_null: true,
                        unique: true,
                        ..col("name", "varchar(80)")
                    },
                    col("manager_id", "integer"),
                ],
                vec![],
                None,
            ),
            table(
                "managers",
                vec![id, col("store_id", "integer")],
                vec![],
                None,
            ),
            table(
                "sale_lines",
                vec![
                    SmColumn {
                        not_null: true,
                        ..col("sale_id", "integer")
                    },
                    SmColumn {
                        not_null: true,
                        ..col("line_no", "integer")
                    },
                    col("qty", "integer"),
                ],
                vec![SmIndex {
                    name: None,
                    columns: vec!["sale_id".into(), "line_no".into()],
                    unique: false,
                    pk: true,
                }],
                None,
            ),
        ],
        refs: vec![
            SmRef {
                name: None,
                from: ep(Some("pos"), "sales", &["store_id"]),
                to: ep(Some("pos"), "stores", &["id"]),
                on_delete: Some("RESTRICT".into()),
                on_update: Some("CASCADE".into()),
            },
            // A cycle: stores.manager_id -> managers.id and managers.store_id -> stores.id.
            SmRef {
                name: None,
                from: ep(Some("pos"), "stores", &["manager_id"]),
                to: ep(Some("pos"), "managers", &["id"]),
                on_delete: Some("SET NULL".into()),
                on_update: None,
            },
            SmRef {
                name: None,
                from: ep(Some("pos"), "managers", &["store_id"]),
                to: ep(Some("pos"), "stores", &["id"]),
                on_delete: None,
                on_update: None,
            },
            SmRef {
                name: None,
                from: ep(Some("pos"), "sale_lines", &["sale_id"]),
                to: ep(Some("pos"), "sales", &["id"]),
                on_delete: Some("CASCADE".into()),
                on_update: None,
            },
        ],
        enums: vec![SmEnum {
            schema: s.clone(),
            name: "sales_channel".into(),
            values: vec!["in_store".into(), "online".into(), "it's odd".into()],
        }],
        skipped: vec!["view v_sales".into()],
    }
}

fn snapshot(name: &str, got: &str) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/ddl/snapshots")
        .join(name);
    if std::env::var_os("CONTURA_BLESS").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, got).unwrap();
        return;
    }
    let want = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e} (capture with CONTURA_BLESS=1)", path.display()));
    assert_eq!(got, want.replace("\r\n", "\n"), "{name} changed");
}

#[test]
fn schema_builder_export_unchanged() {
    for (d, file) in [
        (DialectKind::MySql, "rich.mysql.sql"),
        (DialectKind::Postgres, "rich.postgres.sql"),
        (DialectKind::Sqlite, "rich.sqlite.sql"),
    ] {
        snapshot(file, &create_script_dated(&rich(d), "2026-10-19").unwrap());
    }
}

mod parts {
    use super::rich;
    use crate::ddl::{DdlOptions, parts};
    use crate::model::DialectKind;
    use crate::schema_model::SmColumn;

    #[test]
    fn postgres_parts() {
        let p = parts(&rich(DialectKind::Postgres), &DdlOptions::default()).unwrap();
        assert!(p.schema.is_empty());
        assert_eq!(
            p.types,
            vec![
                "CREATE TYPE \"pos\".\"sales_channel\" AS ENUM ('in_store', 'online', 'it''s odd');"
            ]
        );
        // The export's layout: Foreign Keys inline, forward ones deferred.
        assert_eq!(p.tables.len(), 6, "{:#?}", p.tables);
        assert!(p.tables[1].starts_with("COMMENT ON TABLE \"pos\".\"sales\""));
        assert_eq!(p.deferred_fks.len(), 2);
        // The transfer's layout on PostgreSQL: tables with no Foreign Keys, all of them after.
        assert_eq!(p.tables_without_fks.len(), 6);
        assert!(
            p.tables_without_fks
                .iter()
                .all(|s| !s.contains("FOREIGN KEY"))
        );
        assert!(p.tables_without_fks[0].contains("\"code\" varchar(8) DEFAULT lower('X')\n);"));
        assert_eq!(
            p.foreign_keys,
            vec![
                "ALTER TABLE \"pos\".\"sales\" ADD FOREIGN KEY (\"store_id\") REFERENCES \"pos\".\"stores\" (\"id\") ON DELETE RESTRICT ON UPDATE CASCADE;",
                "ALTER TABLE \"pos\".\"stores\" ADD FOREIGN KEY (\"manager_id\") REFERENCES \"pos\".\"managers\" (\"id\") ON DELETE SET NULL;",
                "ALTER TABLE \"pos\".\"managers\" ADD FOREIGN KEY (\"store_id\") REFERENCES \"pos\".\"stores\" (\"id\");",
                "ALTER TABLE \"pos\".\"sale_lines\" ADD FOREIGN KEY (\"sale_id\") REFERENCES \"pos\".\"sales\" (\"id\") ON DELETE CASCADE;",
            ]
        );
        assert_eq!(p.indexes.len(), 2);
        assert!(p.notes.is_empty());
    }

    #[test]
    fn schemas_are_created_only_when_asked() {
        let opts = DdlOptions {
            create_schemas: true,
            ..Default::default()
        };
        let p = parts(&rich(DialectKind::Postgres), &opts).unwrap();
        assert_eq!(p.schema, vec!["CREATE SCHEMA IF NOT EXISTS \"pos\";"]);
        let p = parts(&rich(DialectKind::MySql), &opts).unwrap();
        assert_eq!(
            p.schema,
            vec!["CREATE DATABASE IF NOT EXISTS `pos` DEFAULT CHARSET utf8mb4;"]
        );
        let p = parts(&rich(DialectKind::Sqlite), &opts).unwrap();
        assert!(p.schema.is_empty());
    }

    #[test]
    fn mysql_and_sqlite_parts() {
        let p = parts(&rich(DialectKind::MySql), &DdlOptions::default()).unwrap();
        assert!(p.types.is_empty(), "MySQL enums are inline");
        assert_eq!(p.tables.len(), 4);
        assert_eq!(p.foreign_keys.len(), 4);
        let p = parts(&rich(DialectKind::Sqlite), &DdlOptions::default()).unwrap();
        assert!(p.types.is_empty());
        // SQLite keeps every Foreign Key inline: it cannot add one later.
        assert!(p.deferred_fks.is_empty());
        assert!(p.tables[0].contains("REFERENCES"));
    }

    #[test]
    fn sqlite_autoincrement_as_note() {
        let mut m = rich(DialectKind::Sqlite);
        // An increment that is not a single INTEGER primary key.
        let seq = SmColumn {
            increment: true,
            ..m.tables[3].columns[2].clone()
        };
        m.tables[3].columns.push(seq);
        m.tables[3].columns[3].name = "seq".into();
        assert!(parts(&m, &DdlOptions::default()).is_err());
        let p = parts(
            &m,
            &DdlOptions {
                sqlite_autoincrement_as_note: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            p.notes,
            vec!["AUTOINCREMENT is left out; values are copied as they are (sale_lines.seq)"]
        );
        assert!(
            p.tables
                .iter()
                .all(|s| !s.contains("\"seq\" INTEGER PRIMARY KEY"))
        );
    }
}
