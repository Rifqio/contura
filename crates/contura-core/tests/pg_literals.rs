//! Live: PostgreSQL text literals made from user text read the same whether
//! `standard_conforming_strings` is on or off. Each statement is sent with
//! the simple query protocol, so a literal that ended early would run the rest.

mod common;

use common::pg::{PgTestDb, pg_admin_client};
use contura_core::design::{
    ColumnDraft, DesignEdit, DesignRequest, DesignTarget, IndexDraft, Position, plan_design,
};
use contura_core::edits::{CellChange, EditSet, NewValue, RowInsert, RowUpdate, plan_edits};
use contura_core::model::{Cell, ColumnInfo, DialectKind, KeyPart, ObjectPath};

const COMMENT: &str = r"\' ; DROP TABLE x; --";
const VALUE: &str = r"a\b \' ; DROP TABLE x; -- it's";

fn path(db: &PgTestDb, name: &str) -> ObjectPath {
    ObjectPath {
        database: db.name.clone(),
        schema: Some("public".into()),
        name: name.into(),
    }
}

fn column(name: &str, type_sql: &str, nullable: bool) -> ColumnDraft {
    ColumnDraft {
        name: name.into(),
        type_sql: type_sql.into(),
        nullable,
        default_sql: None,
        increment: false,
        comment: None,
    }
}

async fn literals_survive(conforming: &str) {
    let db = PgTestDb::create().await;
    let client = pg_admin_client(&db.name).await;
    client
        .batch_execute(&format!(
            "SET standard_conforming_strings = {conforming};
             CREATE TABLE public.x (id int);"
        ))
        .await
        .expect("setup");

    // A new table whose table and column comments hold the hostile text.
    let req = DesignRequest {
        target: DesignTarget::Create {
            path: path(&db, "t"),
        },
        edits: vec![
            DesignEdit::AddColumn {
                column: column("id", "bigint", false),
                position: Position::Last,
            },
            DesignEdit::AddColumn {
                column: ColumnDraft {
                    comment: Some(COMMENT.into()),
                    ..column("note", "text", true)
                },
                position: Position::Last,
            },
            DesignEdit::AddIndex {
                index: IndexDraft {
                    name: "t_pkey".into(),
                    columns: vec!["id".into()],
                    unique: true,
                    primary: true,
                },
            },
            DesignEdit::TableComment {
                comment: Some(COMMENT.into()),
            },
        ],
    };
    let plan = plan_design(DialectKind::Postgres, &req).expect("plan");
    for sql in &plan.statements {
        client
            .batch_execute(sql)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    let row = client
        .query_one(
            "SELECT obj_description('public.t'::regclass, 'pg_class'),
                    col_description('public.t'::regclass, 2)",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(row.get::<_, String>(0), COMMENT);
    assert_eq!(row.get::<_, String>(1), COMMENT);

    // A 5b insert, then an update whose WHERE matches the old value.
    let columns = vec![
        ColumnInfo {
            name: "id".into(),
            type_name: "bigint".into(),
            is_primary_key: true,
        },
        ColumnInfo {
            name: "note".into(),
            type_name: "text".into(),
            is_primary_key: false,
        },
    ];
    let insert = EditSet {
        table: path(&db, "t"),
        updates: vec![],
        inserts: vec![RowInsert {
            values: vec![
                ("id".into(), NewValue::Text { value: "1".into() }),
                (
                    "note".into(),
                    NewValue::Text {
                        value: VALUE.into(),
                    },
                ),
            ],
        }],
        deletes: vec![],
    };
    let update = EditSet {
        table: path(&db, "t"),
        updates: vec![RowUpdate {
            key: vec![KeyPart {
                column: "id".into(),
                value: Cell::Number { value: "1".into() },
            }],
            changes: vec![CellChange {
                column: "note".into(),
                old: Cell::Text {
                    value: VALUE.into(),
                    truncated: false,
                    total_bytes: VALUE.len() as u64,
                },
                new: NewValue::Text {
                    value: format!("{VALUE}!"),
                },
            }],
        }],
        inserts: vec![],
        deletes: vec![],
    };
    for set in [&insert, &update] {
        for edit in plan_edits(DialectKind::Postgres, &columns, set).expect("plan edits") {
            client
                .batch_execute(&edit.sql)
                .await
                .unwrap_or_else(|e| panic!("{}: {e}", edit.sql));
        }
    }
    let notes: Vec<String> = client
        .query("SELECT note FROM public.t", &[])
        .await
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(notes, vec![format!("{VALUE}!")]);

    // Nothing after a literal ran: the bait table is still there.
    let x: i64 = client
        .query_one(
            "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = 'x'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(x, 1);
    drop(client);
    db.drop_db().await;
}

#[tokio::test]
async fn literals_survive_with_standard_conforming_strings_off() {
    literals_survive("off").await;
}

#[tokio::test]
async fn literals_survive_with_standard_conforming_strings_on() {
    literals_survive("on").await;
}
