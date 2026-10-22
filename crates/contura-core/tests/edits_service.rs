//! `ConnectionService` plan, confirm and apply of pending edits through the 5a safety check.

mod common;

use std::sync::Arc;

use contura_core::Error;
use contura_core::connections::{ConnectionInput, ConnectionService, PasswordChange};
use contura_core::edits::{CellChange, EditSet, NewValue, RowDelete, RowInsert, RowUpdate};
use contura_core::model::{
    Cell, ConnectionId, DialectKind, KeyPart, ObjectPath, PageRequest, SslMode,
};
use contura_core::query::HistoryFilter;
use contura_core::safety::RunVerdict;
use contura_core::secrets::MemorySecretStore;
use contura_core::store::AppStore;

struct Fixture {
    _dir: tempfile::TempDir,
    svc: Arc<ConnectionService>,
    id: ConnectionId,
    file: std::path::PathBuf,
}

async fn fixture(production: bool, read_only: bool) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("shop.db");
    rusqlite::Connection::open(&file)
        .unwrap()
        .execute_batch(
            "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT);
             INSERT INTO t VALUES (1, 'a'), (2, 'b');
             CREATE TABLE empty(id INTEGER PRIMARY KEY, name TEXT);",
        )
        .unwrap();
    let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
    let svc = Arc::new(
        ConnectionService::new(store, Arc::new(MemorySecretStore::new()))
            .with_data_dir(common::data_dir()),
    );
    let saved = svc
        .save(ConnectionInput {
            id: None,
            name: "shop".into(),
            dialect: DialectKind::Sqlite,
            host: String::new(),
            port: 0,
            user: String::new(),
            database: None,
            ssl: SslMode::Disable,
            password: PasswordChange::Keep,
            group_id: None,
            file: Some(file.clone()),
            query_timeout_secs: None,
            ai_access: Default::default(),
            ai_sync: Default::default(),
            production,
            read_only,
        })
        .await
        .unwrap();
    svc.open(saved.id).await.unwrap();
    Fixture {
        _dir: dir,
        svc,
        id: saved.id,
        file,
    }
}

impl Fixture {
    /// Every row of `t` as (id, name), read straight from the file.
    fn rows(&self) -> Vec<(i64, Option<String>)> {
        let conn = rusqlite::Connection::open(&self.file).unwrap();
        let mut stmt = conn.prepare("SELECT id, name FROM t ORDER BY id").unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }
}

fn table(name: &str) -> ObjectPath {
    ObjectPath {
        database: "main".into(),
        schema: None,
        name: name.into(),
    }
}

fn text(v: &str) -> Cell {
    Cell::Text {
        value: v.into(),
        truncated: false,
        total_bytes: v.len() as u64,
    }
}

fn id_key(id: i64) -> Vec<KeyPart> {
    vec![KeyPart {
        column: "id".into(),
        value: Cell::Number {
            value: id.to_string(),
        },
    }]
}

fn rename(id: i64, old: &str, new: &str) -> RowUpdate {
    RowUpdate {
        key: id_key(id),
        changes: vec![CellChange {
            column: "name".into(),
            old: text(old),
            new: NewValue::Text { value: new.into() },
        }],
    }
}

/// Renames row 1 from `a` to `new`, deletes row 2 and inserts row 3.
fn mixed(new: &str) -> EditSet {
    EditSet {
        table: table("t"),
        updates: vec![rename(1, "a", new)],
        inserts: vec![RowInsert {
            values: vec![
                ("id".into(), NewValue::Text { value: "3".into() }),
                ("name".into(), NewValue::Text { value: "c".into() }),
            ],
        }],
        deletes: vec![RowDelete { key: id_key(2) }],
    }
}

fn all() -> HistoryFilter {
    HistoryFilter {
        search: None,
        only: None,
    }
}

const ORIGINAL: [(i64, &str); 2] = [(1, "a"), (2, "b")];

fn original() -> Vec<(i64, Option<String>)> {
    ORIGINAL
        .iter()
        .map(|(i, n)| (*i, Some(n.to_string())))
        .collect()
}

fn mixed_result(new: &str) -> Vec<(i64, Option<String>)> {
    vec![(1, Some(new.into())), (3, Some("c".into()))]
}

#[tokio::test]
async fn plain_connection_applies_without_a_pass() {
    let f = fixture(false, false).await;
    let plan = f.svc.plan_edits(f.id, mixed("z")).await.unwrap();
    assert_eq!(plan.verdict, RunVerdict::Ok);
    assert_eq!(plan.statements.len(), 3);
    assert!(plan.statements[0].starts_with("DELETE"));
    let out = f.svc.apply_edits(f.id, mixed("z"), None).await.unwrap();
    assert_eq!((out.updated, out.inserted, out.deleted), (1, 1, 1));
    assert_eq!(f.rows(), mixed_result("z"));
}

#[tokio::test]
async fn columns_come_from_an_empty_table_too() {
    let f = fixture(false, false).await;
    let edits = EditSet {
        table: table("empty"),
        updates: vec![],
        inserts: vec![RowInsert {
            values: vec![("name".into(), NewValue::Text { value: "x".into() })],
        }],
        deletes: vec![],
    };
    let plan = f.svc.plan_edits(f.id, edits.clone()).await.unwrap();
    assert_eq!(
        plan.statements,
        [r#"INSERT INTO "main"."empty" ("name") VALUES ('x')"#]
    );
    let out = f.svc.apply_edits(f.id, edits, None).await.unwrap();
    assert_eq!((out.updated, out.inserted, out.deleted), (0, 1, 0));
}

#[tokio::test]
async fn read_only_refuses_before_the_driver() {
    let f = fixture(false, true).await;
    let plan = f.svc.plan_edits(f.id, mixed("z")).await.unwrap();
    assert_eq!(plan.verdict, RunVerdict::ReadOnly { statement: 0 });
    let err = f.svc.apply_edits(f.id, mixed("z"), None).await.unwrap_err();
    assert!(matches!(err, Error::ReadOnly(0)), "{err:?}");
    assert_eq!(f.rows(), original());
}

#[tokio::test]
async fn production_needs_a_pass() {
    let f = fixture(true, false).await;
    let plan = f.svc.plan_edits(f.id, mixed("z")).await.unwrap();
    match &plan.verdict {
        RunVerdict::NeedsConfirmation {
            connection,
            database,
            statements,
            writes,
        } => {
            assert_eq!(connection, "shop");
            assert_eq!(database.as_deref(), Some("main"));
            assert_eq!(*writes, 3);
            let texts: Vec<&str> = statements.iter().map(|s| s.text.as_str()).collect();
            assert_eq!(texts, plan.statements);
        }
        other => panic!("{other:?}"),
    }
    let err = f.svc.apply_edits(f.id, mixed("z"), None).await.unwrap_err();
    assert!(matches!(err, Error::NeedsConfirmation), "{err:?}");
    assert_eq!(f.rows(), original());

    let pass = f.svc.confirm_edits(f.id, mixed("z")).await.unwrap();
    let out = f
        .svc
        .apply_edits(f.id, mixed("z"), Some(pass))
        .await
        .unwrap();
    assert_eq!((out.updated, out.inserted, out.deleted), (1, 1, 1));
    assert_eq!(f.rows(), mixed_result("z"));

    // Used up: the same pass covers nothing a second time.
    let again = EditSet {
        table: table("t"),
        updates: vec![rename(1, "z", "y")],
        inserts: vec![],
        deletes: vec![],
    };
    let err = f
        .svc
        .apply_edits(f.id, mixed("z"), Some(pass))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NeedsConfirmation), "{err:?}");
    let err = f
        .svc
        .apply_edits(f.id, again, Some(pass))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NeedsConfirmation), "{err:?}");
    assert_eq!(f.rows(), mixed_result("z"));
}

#[tokio::test]
async fn pass_does_not_cover_a_changed_edit_set() {
    let f = fixture(true, false).await;
    let pass = f.svc.confirm_edits(f.id, mixed("z")).await.unwrap();
    // Edited again after the dialog opened: one statement differs.
    let err = f
        .svc
        .apply_edits(f.id, mixed("w"), Some(pass))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NeedsConfirmation), "{err:?}");
    assert_eq!(f.rows(), original());
    // A smaller set made of covered statements is not the confirmed set either.
    let fewer = EditSet {
        deletes: vec![],
        inserts: vec![],
        ..mixed("z")
    };
    let err = f
        .svc
        .apply_edits(f.id, fewer, Some(pass))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NeedsConfirmation), "{err:?}");
    assert_eq!(f.rows(), original());
    // The refused attempts did not use the pass up.
    f.svc
        .apply_edits(f.id, mixed("z"), Some(pass))
        .await
        .unwrap();
    assert_eq!(f.rows(), mixed_result("z"));
}

#[tokio::test]
async fn a_new_confirmation_replaces_the_tables_earlier_pass() {
    let f = fixture(true, false).await;
    let first = f.svc.confirm_edits(f.id, mixed("z")).await.unwrap();
    let second = f.svc.confirm_edits(f.id, mixed("z")).await.unwrap();
    let err = f
        .svc
        .apply_edits(f.id, mixed("z"), Some(first))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NeedsConfirmation), "{err:?}");
    f.svc
        .apply_edits(f.id, mixed("z"), Some(second))
        .await
        .unwrap();
}

#[tokio::test]
async fn expired_pass_is_refused() {
    let f = fixture(true, false).await;
    f.svc
        .set_pass_ttl_for_test(std::time::Duration::from_millis(0));
    let pass = f.svc.confirm_edits(f.id, mixed("z")).await.unwrap();
    let err = f
        .svc
        .apply_edits(f.id, mixed("z"), Some(pass))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NeedsConfirmation), "{err:?}");
    assert_eq!(f.rows(), original());
}

fn single_update() -> EditSet {
    EditSet {
        table: table("t"),
        updates: vec![rename(1, "a", "z")],
        inserts: vec![],
        deletes: vec![],
    }
}

#[tokio::test]
async fn query_pass_does_not_cover_edits() {
    let f = fixture(true, false).await;
    let plan = f.svc.plan_edits(f.id, single_update()).await.unwrap();
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    let pass = f.svc.confirm_run(s, plan.statements.clone()).unwrap();
    let err = f
        .svc
        .apply_edits(f.id, single_update(), Some(pass))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NeedsConfirmation), "{err:?}");
    assert_eq!(f.rows(), original());
}

#[tokio::test]
async fn edits_pass_does_not_cover_a_query() {
    let f = fixture(true, false).await;
    let plan = f.svc.plan_edits(f.id, single_update()).await.unwrap();
    let pass = f.svc.confirm_edits(f.id, single_update()).await.unwrap();
    let s = f.svc.open_query_session(f.id, None).await.unwrap();
    let err = f
        .svc
        .execute_sql(s, plan.statements[0].clone(), Some(pass))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NeedsConfirmation), "{err:?}");
    assert_eq!(f.rows(), original());
}

#[tokio::test]
async fn row_changed_maps_to_error_with_key() {
    let f = fixture(false, false).await;
    // Row 2 is `b`, not `x`, so the update finds no row.
    let edits = EditSet {
        table: table("t"),
        updates: vec![rename(1, "a", "z"), rename(2, "x", "y")],
        inserts: vec![],
        deletes: vec![],
    };
    let err = f.svc.apply_edits(f.id, edits, None).await.unwrap_err();
    match err {
        Error::RowChanged { statement, key } => {
            assert_eq!(statement, 1);
            assert_eq!(key, id_key(2));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(f.rows(), original());
}

#[tokio::test]
async fn server_error_maps_to_edit_failed() {
    let f = fixture(false, false).await;
    // Row 1 already exists.
    let edits = EditSet {
        table: table("t"),
        updates: vec![rename(2, "b", "z")],
        inserts: vec![RowInsert {
            values: vec![("id".into(), NewValue::Text { value: "1".into() })],
        }],
        deletes: vec![],
    };
    let err = f.svc.apply_edits(f.id, edits, None).await.unwrap_err();
    assert!(
        matches!(err, Error::EditFailed { statement: 1, .. }),
        "{err:?}"
    );
    assert_eq!(f.rows(), original());
}

#[tokio::test]
async fn save_adds_one_history_entry() {
    let f = fixture(false, false).await;
    let plan = f.svc.plan_edits(f.id, mixed("z")).await.unwrap();
    f.svc.apply_edits(f.id, mixed("z"), None).await.unwrap();
    let history = f.svc.query_history(Some(f.id), all()).unwrap();
    assert_eq!(history.len(), 1);
    let entry = &history[0];
    assert_eq!(entry.sql, plan.statements.join(";\n"));
    assert!(entry.changed);
    assert_eq!(entry.rows, Some(3));
    assert_eq!(entry.error, None);
    // A refused save is not recorded.
    let bad = EditSet {
        table: table("t"),
        updates: vec![rename(1, "nope", "y")],
        inserts: vec![],
        deletes: vec![],
    };
    f.svc.apply_edits(f.id, bad, None).await.unwrap_err();
    assert_eq!(f.svc.query_history(Some(f.id), all()).unwrap().len(), 1);
}

#[tokio::test]
async fn production_save_on_mysql() {
    let db = common::TestDb::create().await;
    {
        use mysql_async::prelude::Queryable;
        let mut conn = mysql_async::Conn::new(
            mysql_async::OptsBuilder::default()
                .ip_or_hostname(db.config.host.clone())
                .tcp_port(db.config.port)
                .user(Some(db.config.user.clone()))
                .pass(db.password.clone())
                .db_name(Some(db.name.clone())),
        )
        .await
        .unwrap();
        conn.query_drop(
            "CREATE TABLE t(id INT PRIMARY KEY, name VARCHAR(20));
             INSERT INTO t VALUES (1, 'a'), (2, 'b');",
        )
        .await
        .unwrap();
        conn.disconnect().await.unwrap();
    }
    let dir = tempfile::tempdir().unwrap();
    let svc = ConnectionService::new(
        AppStore::open(&dir.path().join("app.sqlite")).unwrap(),
        Arc::new(MemorySecretStore::new()),
    )
    .with_data_dir(common::data_dir());
    let saved = svc
        .save(ConnectionInput {
            id: None,
            name: "freight-prod".into(),
            dialect: DialectKind::MySql,
            host: db.config.host.clone(),
            port: db.config.port,
            user: db.config.user.clone(),
            database: Some(db.name.clone()),
            ssl: SslMode::Disable,
            password: PasswordChange::Set {
                value: db.password.clone().unwrap_or_default(),
            },
            group_id: None,
            file: None,
            query_timeout_secs: None,
            ai_access: Default::default(),
            ai_sync: Default::default(),
            production: true,
            read_only: false,
        })
        .await
        .unwrap();
    svc.open(saved.id).await.unwrap();
    let edits = || EditSet {
        table: ObjectPath {
            database: db.name.clone(),
            schema: None,
            name: "t".into(),
        },
        updates: vec![rename(1, "a", "z")],
        inserts: vec![RowInsert {
            values: vec![
                ("id".into(), NewValue::Text { value: "3".into() }),
                ("name".into(), NewValue::Text { value: "c".into() }),
            ],
        }],
        deletes: vec![RowDelete { key: id_key(2) }],
    };
    let plan = svc.plan_edits(saved.id, edits()).await.unwrap();
    assert!(
        matches!(&plan.verdict, RunVerdict::NeedsConfirmation { writes: 3, database: Some(d), .. } if *d == db.name),
        "{:?}",
        plan.verdict
    );
    let err = svc.apply_edits(saved.id, edits(), None).await.unwrap_err();
    assert!(matches!(err, Error::NeedsConfirmation), "{err:?}");
    let pass = svc.confirm_edits(saved.id, edits()).await.unwrap();
    let out = svc
        .apply_edits(saved.id, edits(), Some(pass))
        .await
        .unwrap();
    assert_eq!((out.updated, out.inserted, out.deleted), (1, 1, 1));
    let err = svc
        .apply_edits(saved.id, edits(), Some(pass))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NeedsConfirmation), "{err:?}");
    let page = svc
        .session(saved.id)
        .await
        .unwrap()
        .fetch_page(&PageRequest {
            table: edits().table,
            page: 0,
            sort: None,
            filter: None,
        })
        .await
        .unwrap();
    let names: Vec<Cell> = page.rows.iter().map(|r| r[1].clone()).collect();
    assert_eq!(names.len(), 2);
    assert!(matches!(&names[0], Cell::Text { value, .. } if value == "z"));
    assert!(matches!(&names[1], Cell::Text { value, .. } if value == "c"));
    svc.close(saved.id).await.unwrap();
    db.drop_db().await;
}
