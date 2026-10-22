mod common;

use common::TestDb;
use contura_core::Error;
use contura_core::connections::{ConnectionInput, ConnectionService, GroupInput, PasswordChange};
use contura_core::model::{
    DialectKind, EditorPrefs, FlowSidePanel, FlowSideTab, GroupColor, KeymapOverrides, RowHeight,
    SslMode, ThemeChoice, UiPrefs,
};
use contura_core::secrets::{MemorySecretStore, SecretStore};
use contura_core::store::AppStore;
use std::sync::Arc;

fn service() -> (tempfile::TempDir, Arc<MemorySecretStore>, ConnectionService) {
    let dir = tempfile::tempdir().unwrap();
    let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
    let secrets = Arc::new(MemorySecretStore::new());
    let svc = ConnectionService::new(store, secrets.clone());
    (dir, secrets, svc)
}

/// `service()` with a data folder, so it can open a SQLite file (Q45 M3).
fn lite_service() -> (tempfile::TempDir, Arc<MemorySecretStore>, ConnectionService) {
    let (dir, secrets, svc) = service();
    (dir, secrets, svc.with_data_dir(common::data_dir()))
}

fn input(name: &str, password: PasswordChange) -> ConnectionInput {
    ConnectionInput {
        id: None,
        name: name.into(),
        dialect: DialectKind::MySql,
        host: "127.0.0.1".into(),
        port: 3306,
        user: "u".into(),
        database: None,
        ssl: SslMode::Disable,
        password,
        group_id: None,
        file: None,
        query_timeout_secs: None,
        ai_access: Default::default(),
        ai_sync: Default::default(),
        production: false,
        read_only: false,
    }
}

fn live_input(db: &TestDb, name: &str) -> ConnectionInput {
    ConnectionInput {
        port: db.config.port,
        host: db.config.host.clone(),
        user: db.config.user.clone(),
        database: db.config.database.clone(),
        ..input(
            name,
            PasswordChange::Set {
                value: db.password.clone().unwrap(),
            },
        )
    }
}

fn group(name: &str) -> GroupInput {
    GroupInput {
        id: None,
        name: name.into(),
        color: GroupColor::Indigo,
    }
}

#[test]
fn store_lists_groups_with_all_nine_old_colours() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.sqlite");
    drop(AppStore::open(&path).unwrap());
    let old = [
        "red", "orange", "amber", "green", "teal", "blue", "violet", "rose", "slate",
    ];
    let raw = rusqlite::Connection::open(&path).unwrap();
    let mut ids = Vec::new();
    for (i, colour) in old.iter().enumerate() {
        let id = uuid::Uuid::new_v4();
        ids.push(id);
        raw.execute(
            "INSERT INTO groups (id, name, color) VALUES (?1, ?2, ?3)",
            rusqlite::params![id.to_string(), format!("g{i}"), colour],
        )
        .unwrap();
    }
    let store = AppStore::open(&path).unwrap();
    let groups = store.list_groups().unwrap();
    assert_eq!(groups.len(), 9);
    let want = [
        GroupColor::Indigo,
        GroupColor::Gold,
        GroupColor::Gold,
        GroupColor::Green,
        GroupColor::Teal,
        GroupColor::Sky,
        GroupColor::Violet,
        GroupColor::Indigo,
        GroupColor::Pink,
    ];
    for (i, w) in want.iter().enumerate() {
        let g = groups.iter().find(|g| g.name == format!("g{i}")).unwrap();
        assert_eq!(g.color, *w, "old colour {}", old[i]);
    }
    // Saving one rewrites its stored name to the new slot.
    let first = groups.iter().find(|g| g.name == "g0").unwrap();
    store.save_group(first).unwrap();
    let stored: String = raw
        .query_row(
            "SELECT color FROM groups WHERE id = ?1",
            [first.id.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stored, "indigo");
}

#[tokio::test]
async fn save_new_assigns_id_and_stores_secret_not_in_store() {
    let (dir, secrets, svc) = service();
    let saved = svc
        .save(input(
            "one",
            PasswordChange::Set {
                value: "pw-unique-7f3a".into(),
            },
        ))
        .await
        .unwrap();
    assert_eq!(
        secrets.get(saved.id).unwrap().as_deref(),
        Some("pw-unique-7f3a")
    );
    assert_eq!(svc.list().unwrap(), vec![saved]);
    // The WAL file may hold the freshest data, so check every file in the folder.
    for entry in std::fs::read_dir(dir.path()).unwrap() {
        let bytes = std::fs::read(entry.unwrap().path()).unwrap();
        assert!(!bytes.windows(14).any(|w| w == b"pw-unique-7f3a"));
    }
}

#[tokio::test]
async fn save_with_keep_preserves_password() {
    let (_d, secrets, svc) = service();
    let saved = svc
        .save(input("one", PasswordChange::Set { value: "pw".into() }))
        .await
        .unwrap();
    let mut edit = input("renamed", PasswordChange::Keep);
    edit.id = Some(saved.id);
    svc.save(edit).await.unwrap();
    assert_eq!(secrets.get(saved.id).unwrap().as_deref(), Some("pw"));
    assert_eq!(svc.list().unwrap()[0].name, "renamed");
}

#[tokio::test]
async fn save_with_clear_removes_password() {
    let (_d, secrets, svc) = service();
    let saved = svc
        .save(input("one", PasswordChange::Set { value: "pw".into() }))
        .await
        .unwrap();
    let mut edit = input("one", PasswordChange::Clear);
    edit.id = Some(saved.id);
    svc.save(edit).await.unwrap();
    assert_eq!(secrets.get(saved.id).unwrap(), None);
}

#[tokio::test]
async fn blank_name_is_invalid() {
    let (_d, _s, svc) = service();
    let err = svc
        .save(input("   ", PasswordChange::Clear))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::InvalidInput(_)));
}

#[tokio::test]
async fn saving_open_connection_closes_session() {
    let (_d, _s, svc) = service();
    let db = TestDb::create().await;
    let saved = svc.save(live_input(&db, "live")).await.unwrap();
    svc.open(saved.id).await.unwrap();
    assert!(svc.is_open(saved.id));
    let mut edit = live_input(&db, "live renamed");
    edit.id = Some(saved.id);
    edit.password = PasswordChange::Keep;
    svc.save(edit).await.unwrap();
    assert!(!svc.is_open(saved.id));
    db.drop_db().await;
}

#[tokio::test]
async fn delete_removes_secret_and_session() {
    let (_d, secrets, svc) = service();
    let db = TestDb::create().await;
    let saved = svc.save(live_input(&db, "live")).await.unwrap();
    svc.open(saved.id).await.unwrap();
    svc.delete(saved.id).await.unwrap();
    assert!(!svc.is_open(saved.id));
    assert_eq!(secrets.get(saved.id).unwrap(), None);
    assert!(svc.list().unwrap().is_empty());
    db.drop_db().await;
}

#[tokio::test]
async fn open_twice_is_noop() {
    let (_d, _s, svc) = service();
    let db = TestDb::create().await;
    let saved = svc.save(live_input(&db, "live")).await.unwrap();
    svc.open(saved.id).await.unwrap();
    let first = svc.session(saved.id).await.unwrap();
    svc.open(saved.id).await.unwrap();
    let second = svc.session(saved.id).await.unwrap();
    assert!(Arc::ptr_eq(&first, &second));
    svc.close(saved.id).await.unwrap();
    svc.close(saved.id).await.unwrap();
    db.drop_db().await;
}

#[tokio::test]
async fn session_of_unopened_is_not_found() {
    let (_d, _s, svc) = service();
    let err = svc.session(uuid::Uuid::new_v4()).await.err().unwrap();
    assert!(matches!(err, Error::NotFound(_)));
}

#[test]
fn duplicate_group_name_is_invalid() {
    let (_d, _s, svc) = service();
    svc.save_group(group("KFC")).unwrap();
    let err = svc.save_group(group("kfc")).unwrap_err();
    assert!(matches!(err, Error::InvalidInput(_)));
}

#[tokio::test]
async fn move_connection_to_missing_group_is_not_found() {
    let (_d, _s, svc) = service();
    let saved = svc.save(input("one", PasswordChange::Clear)).await.unwrap();
    let err = svc
        .move_connection(saved.id, Some(uuid::Uuid::new_v4()))
        .unwrap_err();
    assert!(matches!(err, Error::NotFound(_)));
}

#[tokio::test]
async fn move_keeps_session_open() {
    let (_d, _s, svc) = service();
    let db = TestDb::create().await;
    let saved = svc.save(live_input(&db, "live")).await.unwrap();
    let g = svc.save_group(group("Dev")).unwrap();
    svc.open(saved.id).await.unwrap();
    let moved = svc.move_connection(saved.id, Some(g.id)).unwrap();
    assert_eq!(moved.group_id, Some(g.id));
    assert!(svc.is_open(saved.id));
    svc.close(saved.id).await.unwrap();
    db.drop_db().await;
}

#[test]
fn last_group_forgets_deleted_group() {
    let (_d, _s, svc) = service();
    let g = svc.save_group(group("A")).unwrap();
    svc.set_last_group(Some(g.id)).unwrap();
    assert_eq!(svc.last_group().unwrap(), Some(g.id));
    svc.delete_group(g.id).unwrap();
    assert_eq!(svc.last_group().unwrap(), None);
}

#[test]
fn ui_prefs_default_to_dark() {
    let (_d, _s, svc) = service();
    assert_eq!(svc.ui_prefs().unwrap().theme, ThemeChoice::Dark);
}

#[test]
fn ui_prefs_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.sqlite");
    let svc = ConnectionService::new(
        AppStore::open(&path).unwrap(),
        Arc::new(MemorySecretStore::new()),
    );
    svc.save_ui_prefs(UiPrefs {
        theme: ThemeChoice::Light,
        ..UiPrefs::default()
    })
    .unwrap();
    drop(svc);
    let svc = ConnectionService::new(
        AppStore::open(&path).unwrap(),
        Arc::new(MemorySecretStore::new()),
    );
    assert_eq!(svc.ui_prefs().unwrap().theme, ThemeChoice::Light);
}

#[test]
fn ui_prefs_unreadable_falls_back() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.sqlite");
    let store = AppStore::open(&path).unwrap();
    store.set_setting("ui_prefs", "{").unwrap();
    let svc = ConnectionService::new(store, Arc::new(MemorySecretStore::new()));
    assert_eq!(svc.ui_prefs().unwrap().theme, ThemeChoice::Dark);
}

fn service_with_setting(key: &str, raw: &str) -> (tempfile::TempDir, ConnectionService) {
    let dir = tempfile::tempdir().unwrap();
    let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
    store.set_setting(key, raw).unwrap();
    let svc = ConnectionService::new(store, Arc::new(MemorySecretStore::new()));
    (dir, svc)
}

fn assert_all_defaults_except_theme(p: &UiPrefs) {
    assert_eq!(p.row_height.0, 28);
    assert_eq!(p.editor.family, "JetBrains Mono");
    assert_eq!((p.editor.size, p.editor.line_height), (13, 20));
    assert!(p.editor.ligatures);
    assert!(!p.brighter_comments);
    assert!(!p.inline_suggestions);
    assert_eq!(p.history_keep_days, None);
}

#[test]
fn ui_prefs_from_v070_have_every_default() {
    let (_d, _s, svc) = service();
    let p = svc.ui_prefs().unwrap();
    assert_eq!(p.theme, ThemeChoice::Dark);
    assert_all_defaults_except_theme(&p);
}

#[test]
fn ui_prefs_from_the_restyle_keep_the_theme() {
    let (_d, svc) = service_with_setting("ui_prefs", r#"{"theme":"light"}"#);
    let p = svc.ui_prefs().unwrap();
    assert_eq!(p.theme, ThemeChoice::Light);
    assert_all_defaults_except_theme(&p);
}

#[test]
fn ui_prefs_one_bad_field_keeps_the_others() {
    let (_d, svc) = service_with_setting(
        "ui_prefs",
        r#"{"theme":"light","rowHeight":"tall","editor":{"size":40,"family":"Comic"},"historyKeepDays":90}"#,
    );
    let p = svc.ui_prefs().unwrap();
    assert_eq!(p.theme, ThemeChoice::Light);
    assert_eq!(p.row_height.0, 28);
    assert_eq!(p.editor.size, 20);
    assert_eq!(p.editor.family, "JetBrains Mono");
    assert_eq!(p.history_keep_days, Some(90));
}

#[test]
fn ui_prefs_round_trip_every_field() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.sqlite");
    let svc = ConnectionService::new(
        AppStore::open(&path).unwrap(),
        Arc::new(MemorySecretStore::new()),
    );
    svc.save_ui_prefs(UiPrefs {
        theme: ThemeChoice::Light,
        row_height: RowHeight(24),
        editor: EditorPrefs {
            family: "Consolas".into(),
            size: 15,
            line_height: 22,
            ligatures: false,
        },
        brighter_comments: true,
        inline_suggestions: true,
        history_keep_days: Some(30),
        flow_side_panel: FlowSidePanel {
            hidden: true,
            tab: FlowSideTab::Assistant,
        },
        flow_assist_mode: contura_core::model::FlowAssistMode::Auto,
    })
    .unwrap();
    drop(svc);
    let svc = ConnectionService::new(
        AppStore::open(&path).unwrap(),
        Arc::new(MemorySecretStore::new()),
    );
    let p = svc.ui_prefs().unwrap();
    assert_eq!(p.theme, ThemeChoice::Light);
    assert_eq!(p.row_height.0, 24);
    assert_eq!(p.editor.family, "Consolas");
    assert_eq!((p.editor.size, p.editor.line_height), (15, 22));
    assert!(!p.editor.ligatures);
    assert!(p.brighter_comments);
    assert!(p.inline_suggestions);
    assert_eq!(p.history_keep_days, Some(30));
    assert_eq!(
        p.flow_side_panel,
        FlowSidePanel {
            hidden: true,
            tab: FlowSideTab::Assistant,
        }
    );
    assert_eq!(
        p.flow_assist_mode,
        contura_core::model::FlowAssistMode::Auto
    );
}

#[test]
fn ui_prefs_without_the_side_panel_read_the_default() {
    let (_d, svc) = service_with_setting("ui_prefs", r#"{"theme":"light","historyKeepDays":7}"#);
    let p = svc.ui_prefs().unwrap();
    assert_eq!(p.theme, ThemeChoice::Light);
    assert_eq!(p.history_keep_days, Some(7));
    assert_eq!(
        p.flow_side_panel,
        FlowSidePanel {
            hidden: false,
            tab: FlowSideTab::Editor,
        }
    );
    // A bad value keeps the rest.
    let (_d, svc) = service_with_setting(
        "ui_prefs",
        r#"{"theme":"light","flowSidePanel":{"hidden":true,"tab":"chat"}}"#,
    );
    let p = svc.ui_prefs().unwrap();
    assert_eq!(p.theme, ThemeChoice::Light);
    assert_eq!(p.flow_side_panel, FlowSidePanel::default());
}

#[test]
fn ui_prefs_flow_assist_mode_survives_and_falls_back() {
    use contura_core::model::FlowAssistMode;
    let (_d, svc) = service_with_setting("ui_prefs", r#"{"flowAssistMode":"auto"}"#);
    assert_eq!(
        svc.ui_prefs().unwrap().flow_assist_mode,
        FlowAssistMode::Auto
    );
    // Missing or unknown: Review, and the rest is kept.
    let (_d, svc) = service_with_setting("ui_prefs", r#"{"theme":"light"}"#);
    assert_eq!(
        svc.ui_prefs().unwrap().flow_assist_mode,
        FlowAssistMode::Review
    );
    let (_d, svc) =
        service_with_setting("ui_prefs", r#"{"theme":"light","flowAssistMode":"yolo"}"#);
    let p = svc.ui_prefs().unwrap();
    assert_eq!(p.theme, ThemeChoice::Light);
    assert_eq!(p.flow_assist_mode, FlowAssistMode::Review);
}

#[test]
fn ui_prefs_keep_days_of_zero_reads_one() {
    let (_d, svc) = service_with_setting("ui_prefs", r#"{"historyKeepDays":0}"#);
    assert_eq!(svc.ui_prefs().unwrap().history_keep_days, Some(1));
}

#[test]
fn ui_prefs_row_height_other_than_24_reads_28() {
    let (_d, svc) = service_with_setting("ui_prefs", r#"{"rowHeight":30}"#);
    assert_eq!(svc.ui_prefs().unwrap().row_height.0, 28);
}

#[test]
fn keymap_defaults_to_empty() {
    let (_d, _s, svc) = service();
    assert!(svc.keymap().unwrap().is_empty());
}

#[test]
fn keymap_round_trip() {
    let (_d, _s, svc) = service();
    let mut o = KeymapOverrides::new();
    o.insert("query.run".into(), vec!["Ctrl+R".into()]);
    o.insert("query.new".into(), vec![]);
    svc.save_keymap(o.clone()).unwrap();
    assert_eq!(svc.keymap().unwrap(), o);
}

#[test]
fn keymap_unreadable_is_empty() {
    let (_d, svc) = service_with_setting("keymap", "[");
    assert!(svc.keymap().unwrap().is_empty());
}

#[tokio::test]
async fn open_discards_session_when_saved_while_connecting() {
    let (_d, _s, svc) = service();
    let db = TestDb::create().await;
    let saved = svc.save(live_input(&db, "live")).await.unwrap();
    let mut edit = live_input(&db, "live renamed");
    edit.id = Some(saved.id);
    edit.password = PasswordChange::Keep;
    svc.open_with_hook(saved.id, async {
        svc.save(edit).await.unwrap();
    })
    .await
    .unwrap();
    assert!(!svc.is_open(saved.id));
    db.drop_db().await;
}

#[tokio::test]
async fn open_fails_when_deleted_while_connecting() {
    let (_d, _s, svc) = service();
    let db = TestDb::create().await;
    let saved = svc.save(live_input(&db, "live")).await.unwrap();
    let err = svc
        .open_with_hook(saved.id, async {
            svc.delete(saved.id).await.unwrap();
        })
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NotFound(_)));
    assert!(!svc.is_open(saved.id));
    db.drop_db().await;
}

#[tokio::test]
async fn open_returns_the_server_version() {
    let (dir, _s, svc) = lite_service();
    let file = dir.path().join("shop.sqlite");
    rusqlite::Connection::open(&file)
        .unwrap()
        .execute_batch("CREATE TABLE t (id INTEGER)")
        .unwrap();
    let saved = svc
        .save(ConnectionInput {
            dialect: DialectKind::Sqlite,
            file: Some(file.clone()),
            ..input("lite", PasswordChange::Keep)
        })
        .await
        .unwrap();
    let first: String = svc.open(saved.id).await.unwrap();
    assert!(first.starts_with("3."), "{first}");
    // Opening an open Connection still answers with its version.
    assert_eq!(svc.open(saved.id).await.unwrap(), first);
    svc.close(saved.id).await.unwrap();
}

/// A SQLite Connection can never open Contura's own app.sqlite, or anything else in the
/// data folder, whether it is tested or opened.
#[tokio::test]
async fn sqlite_connection_into_the_data_folder_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let store_file = dir.path().join("app.sqlite");
    let store = AppStore::open(&store_file).unwrap();
    let svc = ConnectionService::new(store, Arc::new(MemorySecretStore::new()))
        .with_data_dir(dir.path().to_path_buf());
    let lite = || ConnectionInput {
        dialect: DialectKind::Sqlite,
        file: Some(store_file.clone()),
        ..input("lite", PasswordChange::Keep)
    };
    let refused = |r: Result<String, contura_core::Error>| {
        assert!(
            matches!(&r, Err(contura_core::Error::InvalidInput(m))
                if m == "Choose a SQLite file outside Contura's data folder."),
            "{r:?}"
        );
    };
    refused(svc.test(lite()).await);
    let saved = svc.save(lite()).await.unwrap();
    refused(svc.open(saved.id).await);
    assert!(!svc.is_open(saved.id));
}

/// Q45 M3: without a data folder the guard cannot check the file, so it fails closed.
#[tokio::test]
async fn sqlite_connection_without_a_data_folder_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
    let svc = ConnectionService::new(store, Arc::new(MemorySecretStore::new()));
    let lite = || ConnectionInput {
        dialect: DialectKind::Sqlite,
        file: Some(dir.path().join("elsewhere").join("shop.sqlite")),
        ..input("lite", PasswordChange::Keep)
    };
    let refused = |r: Result<String, contura_core::Error>| {
        assert!(
            matches!(&r, Err(contura_core::Error::InvalidInput(m))
                if m == "Contura cannot find its data folder, so it cannot open this file."),
            "{r:?}"
        );
    };
    refused(svc.test(lite()).await);
    let saved = svc.save(lite()).await.unwrap();
    refused(svc.open(saved.id).await);
    assert!(!svc.is_open(saved.id));
}

#[tokio::test]
async fn visual_query_sql_previews_without_opening() {
    let (dir, _s, svc) = service();
    let saved = svc
        .save(ConnectionInput {
            dialect: DialectKind::Sqlite,
            file: Some(dir.path().join("shop.sqlite")),
            ..input("lite", PasswordChange::Keep)
        })
        .await
        .unwrap();
    let query: contura_core::visual_query::VisualQuery =
        serde_json::from_value(serde_json::json!({
            "version": 1, "database": "main",
            "tables": [
                {"id": "t1", "schema": null, "name": "orders", "alias": "o", "x": 0, "y": 0},
                {"id": "t2", "schema": null, "name": "stores", "alias": "s", "x": 0, "y": 0}
            ],
            "joins": [{"id": "j1", "left": "t1", "right": "t2", "kind": "full",
                       "on": [{"leftColumn": "store_id", "rightColumn": "id"}]}],
            "columns": [{"table": "t1", "column": "id", "alias": null, "aggregate": null}],
            "filters": [], "groupBy": {"kind": "auto"}, "orderBy": [], "limit": 5, "distinct": false
        }))
        .unwrap();
    let preview = svc
        .visual_query_sql(saved.id, query.clone(), Default::default())
        .unwrap();
    assert_eq!(preview.problems, vec![]);
    assert_eq!(
        preview.query.unwrap().sql,
        "SELECT o.id\nFROM orders AS o\nFULL JOIN stores AS s ON s.id = o.store_id\nLIMIT 5"
    );
    assert!(!svc.is_open(saved.id));

    let mysql = svc.save(input("my", PasswordChange::Keep)).await.unwrap();
    let refused = svc
        .visual_query_sql(mysql.id, query, Default::default())
        .unwrap();
    assert_eq!(refused.query, None);
    assert_eq!(
        refused.problems[0].message,
        "MySQL has no FULL JOIN. Pick Left or Right."
    );
}

#[test]
fn service_futures_are_send() {
    fn assert_send<T: Send>(_: T) {}
    let (_d, _s, svc) = service();
    let id = uuid::Uuid::new_v4();
    assert_send(svc.save(input("x", PasswordChange::Clear)));
    assert_send(svc.open(id));
    assert_send(svc.close(id));
    assert_send(svc.delete(id));
    assert_send(svc.test(input("x", PasswordChange::Clear)));
    assert_send(svc.session(id));
}

#[tokio::test]
async fn save_into_missing_group_is_not_found() {
    let (_d, _s, svc) = service();
    let mut i = input("one", PasswordChange::Clear);
    i.group_id = Some(uuid::Uuid::new_v4());
    let err = svc.save(i).await.unwrap_err();
    assert!(matches!(err, Error::NotFound(_)));
    assert!(svc.list().unwrap().is_empty());
}

#[tokio::test]
async fn test_with_keep_uses_stored_password() {
    let (_d, _s, svc) = service();
    let db = TestDb::create().await;
    let saved = svc.save(live_input(&db, "live")).await.unwrap();
    let mut probe = live_input(&db, "live");
    probe.id = Some(saved.id);
    probe.password = PasswordChange::Keep;
    let version = svc.test(probe).await.unwrap();
    assert!(!version.is_empty());
    db.drop_db().await;
}

#[tokio::test]
async fn keep_on_new_connection_behaves_like_clear() {
    let (_d, secrets, svc) = service();
    let saved = svc.save(input("one", PasswordChange::Keep)).await.unwrap();
    assert_eq!(secrets.get(saved.id).unwrap(), None);
}

#[test]
fn blank_group_name_is_invalid() {
    let (_d, _s, svc) = service();
    let err = svc.save_group(group("  ")).unwrap_err();
    assert!(matches!(err, Error::InvalidInput(_)));
}

#[tokio::test]
async fn delete_group_ungroups_connections() {
    let (_d, _s, svc) = service();
    let g = svc.save_group(group("Dev")).unwrap();
    let mut i = input("one", PasswordChange::Clear);
    i.group_id = Some(g.id);
    let saved = svc.save(i).await.unwrap();
    svc.delete_group(g.id).unwrap();
    let all = svc.list().unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].id, saved.id);
    assert_eq!(all[0].group_id, None);
}

#[test]
fn step1_connection_json_still_loads() {
    let json = r#"{"id":"6f1c2f0e-8c7a-4a53-9d0e-0b6f5a1d2c34","name":"Local","dialect":"mysql","host":"127.0.0.1","port":3306,"user":"root","database":null,"ssl":{"mode":"disable"},"groupId":null}"#;
    let config: contura_core::model::ConnectionConfig = serde_json::from_str(json).unwrap();
    assert_eq!(config.file, None);
    assert_eq!(config.dialect, DialectKind::MySql);
}

#[tokio::test]
async fn sqlite_connection_requires_a_file() {
    let (_dir, _secrets, svc) = service();
    for file in [None, Some("  ".into())] {
        let err = svc
            .save(ConnectionInput {
                dialect: DialectKind::Sqlite,
                file,
                ..input("lite", PasswordChange::Keep)
            })
            .await
            .unwrap_err();
        assert!(matches!(err, Error::InvalidInput(m) if m == "choose a SQLite file"));
    }
}

#[tokio::test]
async fn sqlite_save_drops_server_fields() {
    let (_dir, _secrets, svc) = service();
    let saved = svc
        .save(ConnectionInput {
            dialect: DialectKind::Sqlite,
            host: "x".into(),
            port: 3306,
            user: "someone".into(),
            database: Some("db".into()),
            ssl: SslMode::Require,
            file: Some("C:/data/shop.sqlite".into()),
            query_timeout_secs: None,
            ai_access: Default::default(),
            ai_sync: Default::default(),
            production: false,
            read_only: false,
            ..input("lite", PasswordChange::Keep)
        })
        .await
        .unwrap();
    assert_eq!(saved.host, "");
    assert_eq!(saved.port, 0);
    assert_eq!(saved.user, "");
    assert_eq!(saved.database, None);
    assert_eq!(saved.ssl, SslMode::Disable);
    assert_eq!(saved.file, Some("C:/data/shop.sqlite".into()));
    assert_eq!(svc.list().unwrap(), vec![saved]);
}

#[tokio::test]
async fn server_connection_rejects_port_zero() {
    let (_dir, _secrets, svc) = service();
    let err = svc
        .save(ConnectionInput {
            port: 0,
            ..input("zero", PasswordChange::Keep)
        })
        .await
        .unwrap_err();
    assert!(matches!(err, Error::InvalidInput(m) if m == "port must be from 1 to 65535"));
}

#[tokio::test]
async fn postgres_connection_requires_a_host() {
    let (_dir, _secrets, svc) = service();
    let err = svc
        .save(ConnectionInput {
            dialect: DialectKind::Postgres,
            host: "  ".into(),
            port: 5432,
            ..input("pg", PasswordChange::Keep)
        })
        .await
        .unwrap_err();
    assert!(matches!(err, Error::InvalidInput(m) if m == "host must not be empty"));
}

#[tokio::test]
async fn postgres_save_keeps_server_fields() {
    let (_dir, _secrets, svc) = service();
    let saved = svc
        .save(ConnectionInput {
            dialect: DialectKind::Postgres,
            port: 5432,
            database: Some("shop".into()),
            file: Some("C:/ignored.sqlite".into()),
            query_timeout_secs: None,
            ai_access: Default::default(),
            ai_sync: Default::default(),
            production: false,
            read_only: false,
            ..input("pg", PasswordChange::Keep)
        })
        .await
        .unwrap();
    assert_eq!(saved.dialect, DialectKind::Postgres);
    assert_eq!((saved.host.as_str(), saved.port), ("127.0.0.1", 5432));
    assert_eq!(saved.database.as_deref(), Some("shop"));
    assert_eq!(saved.file, None);
}

#[tokio::test]
async fn sqlite_save_never_stores_a_password() {
    let (_dir, secrets, svc) = service();
    let saved = svc
        .save(ConnectionInput {
            dialect: DialectKind::Sqlite,
            file: Some("C:/data/shop.sqlite".into()),
            query_timeout_secs: None,
            ai_access: Default::default(),
            ai_sync: Default::default(),
            production: false,
            read_only: false,
            ..input("lite", PasswordChange::Set { value: "x".into() })
        })
        .await
        .unwrap();
    assert_eq!(secrets.get(saved.id).unwrap(), None);
}

#[test]
fn old_config_json_reads_safety_off() {
    let json = r#"{"id":"6f1c2f0e-1b8e-4c53-9d0a-3a6a8f4b2c11","name":"old","dialect":"mysql","host":"h","port":3306,"user":"u","database":null,"ssl":{"mode":"disable"},"groupId":null}"#;
    let c: contura_core::model::ConnectionConfig = serde_json::from_str(json).unwrap();
    assert!(!c.production);
    assert!(!c.read_only);
}

#[tokio::test]
async fn turning_production_on_sets_ai_access_never() {
    use contura_core::ai::AiAccess;
    let (_dir, _secrets, svc) = service();
    let mut i = input("one", PasswordChange::Clear);
    i.ai_access = AiAccess::Schema;
    let saved = svc.save(i).await.unwrap();
    assert_eq!(saved.ai_access, AiAccess::Schema);
    let mut again = input("one", PasswordChange::Keep);
    again.id = Some(saved.id);
    again.ai_access = AiAccess::Schema;
    again.production = true;
    let saved = svc.save(again).await.unwrap();
    assert_eq!(saved.ai_access, AiAccess::Never);
    assert_eq!(svc.list().unwrap()[0].ai_access, AiAccess::Never);
}

#[tokio::test]
async fn production_already_on_keeps_raised_ai_access() {
    use contura_core::ai::AiAccess;
    let (_dir, _secrets, svc) = service();
    let mut i = input("one", PasswordChange::Clear);
    i.production = true;
    i.ai_access = AiAccess::Never;
    let saved = svc.save(i).await.unwrap();
    let mut again = input("one", PasswordChange::Keep);
    again.id = Some(saved.id);
    again.production = true;
    again.ai_access = AiAccess::Schema;
    let saved = svc.save(again).await.unwrap();
    assert_eq!(saved.ai_access, AiAccess::Schema);
    assert_eq!(svc.list().unwrap()[0].ai_access, AiAccess::Schema);
}

#[tokio::test]
async fn turning_production_off_keeps_ai_access() {
    use contura_core::ai::AiAccess;
    let (_dir, _secrets, svc) = service();
    let mut i = input("one", PasswordChange::Clear);
    i.production = true;
    i.ai_access = AiAccess::Never;
    let saved = svc.save(i).await.unwrap();
    let mut again = input("one", PasswordChange::Keep);
    again.id = Some(saved.id);
    again.production = false;
    again.ai_access = AiAccess::Never;
    let saved = svc.save(again).await.unwrap();
    assert_eq!(saved.ai_access, AiAccess::Never);
    assert!(!svc.list().unwrap()[0].production);
}

#[tokio::test]
async fn new_connection_marked_production_gets_never() {
    use contura_core::ai::AiAccess;
    let (_dir, _secrets, svc) = service();
    let mut i = input("one", PasswordChange::Clear);
    i.production = true;
    i.read_only = true;
    i.ai_access = AiAccess::Schema;
    let saved = svc.save(i).await.unwrap();
    assert_eq!(saved.ai_access, AiAccess::Never);
    let stored = svc.list().unwrap().remove(0);
    assert!(stored.production && stored.read_only);
}

#[tokio::test]
async fn ai_access_is_saved_with_the_connection() {
    let (_dir, _secrets, svc) = service();
    let mut i = input("one", PasswordChange::Clear);
    i.ai_access = contura_core::ai::AiAccess::Never;
    let saved = svc.save(i).await.unwrap();
    assert_eq!(saved.ai_access, contura_core::ai::AiAccess::Never);
    assert_eq!(
        svc.list().unwrap()[0].ai_access,
        contura_core::ai::AiAccess::Never
    );
}

fn history_row(sql: &str, error: Option<&str>) -> contura_core::query::NewHistory {
    contura_core::query::NewHistory {
        connection_id: uuid::Uuid::new_v4(),
        sql: sql.into(),
        ran_at_ms: 1,
        elapsed_ms: 7,
        outcome: contura_core::query::Outcome::Ok,
        rows: Some(1),
        changed: false,
        error: error.map(str::to_owned),
    }
}

#[tokio::test]
async fn data_folder_info_counts_and_history_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
    store.add_history(&history_row("SELECT 1", None)).unwrap();
    store.add_history(&history_row("SELECT 1", None)).unwrap();
    let svc = ConnectionService::new(store, Arc::new(MemorySecretStore::new()))
        .with_data_dir(dir.path().to_path_buf());
    svc.save(input("a", PasswordChange::Keep)).await.unwrap();
    svc.save(input("b", PasswordChange::Keep)).await.unwrap();
    svc.save_group(GroupInput {
        id: None,
        name: "g".into(),
        color: GroupColor::Indigo,
    })
    .unwrap();
    svc.save_saved_query(contura_core::query::SavedQueryInput {
        id: None,
        name: "q".into(),
        sql: "SELECT 2".into(),
        connection_id: None,
        kind: Default::default(),
        visual_json: None,
    })
    .unwrap();
    let info = svc.data_folder_info().unwrap();
    assert_eq!(info.path, Some(dir.path().to_path_buf()));
    assert_eq!(
        (info.connections, info.groups, info.saved_queries),
        (2, 1, 1)
    );
    assert_eq!(info.history_bytes, 2 * (8 + 64));
    let (_plain_dir, _, plain) = service();
    assert_eq!(plain.data_folder_info().unwrap().path, None);
}

fn sqlite_input(name: &str, file: std::path::PathBuf) -> ConnectionInput {
    ConnectionInput {
        dialect: DialectKind::Sqlite,
        host: String::new(),
        port: 0,
        user: String::new(),
        file: Some(file),
        ..input(name, PasswordChange::Keep)
    }
}

#[tokio::test]
async fn opening_a_connection_records_its_time() {
    let (dir, _s, svc) = lite_service();
    let file = dir.path().join("shop.db");
    rusqlite::Connection::open(&file).unwrap();
    let ok = svc.save(sqlite_input("shop", file)).await.unwrap();
    let broken = svc
        .save(ConnectionInput {
            port: 1,
            ..input("down", PasswordChange::Keep)
        })
        .await
        .unwrap();
    assert!(svc.connection_opened_times().unwrap().is_empty());
    svc.open(ok.id).await.unwrap();
    svc.open(broken.id).await.unwrap_err();
    let times = svc.connection_opened_times().unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    assert_eq!(times.len(), 1);
    assert!((now - times[&ok.id]).abs() < 5000);
    assert!(!times.contains_key(&broken.id));
}

#[tokio::test]
async fn saved_query_keeps_the_connection_it_opens_on() {
    let (_d, _s, svc) = service();
    let c = svc.save(input("a", PasswordChange::Keep)).await.unwrap();
    let q = svc
        .save_saved_query(contura_core::query::SavedQueryInput {
            id: None,
            name: "q".into(),
            sql: "SELECT 1".into(),
            connection_id: Some(c.id),
            kind: Default::default(),
            visual_json: None,
        })
        .unwrap();
    assert_eq!(q.connection_id, Some(c.id));
    assert_eq!(
        svc.list_saved_queries().unwrap()[0].connection_id,
        Some(c.id)
    );
    svc.delete(c.id).await.unwrap();
    assert_eq!(svc.list_saved_queries().unwrap()[0].connection_id, None);
}

#[tokio::test]
async fn saving_without_a_connection_keeps_the_one_it_opens_on() {
    let (_d, _s, svc) = service();
    let c = svc.save(input("a", PasswordChange::Keep)).await.unwrap();
    let q = svc
        .save_saved_query(contura_core::query::SavedQueryInput {
            id: None,
            name: "q".into(),
            sql: "SELECT 1".into(),
            connection_id: Some(c.id),
            kind: Default::default(),
            visual_json: None,
        })
        .unwrap();
    let again = svc
        .save_saved_query(contura_core::query::SavedQueryInput {
            id: Some(q.id),
            name: "renamed".into(),
            sql: "SELECT 2".into(),
            connection_id: None,
            kind: Default::default(),
            visual_json: None,
        })
        .unwrap();
    assert_eq!(again.connection_id, Some(c.id));
    assert_eq!(
        svc.list_saved_queries().unwrap()[0].connection_id,
        Some(c.id)
    );
}

#[tokio::test]
async fn deleting_a_connection_forgets_its_opened_time() {
    let (dir, _s, svc) = lite_service();
    let file = dir.path().join("shop.db");
    rusqlite::Connection::open(&file).unwrap();
    let c = svc.save(sqlite_input("shop", file)).await.unwrap();
    svc.open(c.id).await.unwrap();
    assert_eq!(svc.connection_opened_times().unwrap().len(), 1);
    svc.delete(c.id).await.unwrap();
    assert!(svc.connection_opened_times().unwrap().is_empty());
}

#[tokio::test]
async fn saved_query_runs_match_the_trimmed_text() {
    let dir = tempfile::tempdir().unwrap();
    let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
    store.add_history(&history_row(" SELECT 1", None)).unwrap();
    let svc = ConnectionService::new(store, Arc::new(MemorySecretStore::new()));
    let ran = svc
        .save_saved_query(contura_core::query::SavedQueryInput {
            id: None,
            name: "ran".into(),
            sql: "SELECT 1\n".into(),
            connection_id: None,
            kind: Default::default(),
            visual_json: None,
        })
        .unwrap();
    svc.save_saved_query(contura_core::query::SavedQueryInput {
        id: None,
        name: "never".into(),
        sql: "SELECT 99".into(),
        connection_id: None,
        kind: Default::default(),
        visual_json: None,
    })
    .unwrap();
    let runs = svc.saved_query_runs().unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].saved_id, ran.id);
    assert_eq!(
        (runs[0].ran_at_ms, runs[0].rows, runs[0].elapsed_ms),
        (1, Some(1), 7)
    );
}

const PNG_SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 13, 10, 26, 10];

fn png_bytes() -> Vec<u8> {
    let mut b = PNG_SIG.to_vec();
    b.extend_from_slice(b"fake-body");
    b
}

fn service_with_data() -> (tempfile::TempDir, ConnectionService) {
    let dir = tempfile::tempdir().unwrap();
    let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
    let svc = ConnectionService::new(store, Arc::new(MemorySecretStore::new()))
        .with_data_dir(dir.path().to_path_buf());
    (dir, svc)
}

#[test]
fn group_image_round_trips_and_sets_has_image() {
    let (_dir, svc) = service_with_data();
    let g = svc.save_group(group("Shop")).unwrap();
    assert!(!g.has_image);
    assert_eq!(svc.group_image(g.id).unwrap(), None);
    let png = png_bytes();
    let updated = svc.set_group_image(g.id, &png).unwrap();
    assert!(updated.has_image);
    assert_eq!(svc.group_image(g.id).unwrap(), Some(png));
    assert!(svc.list_groups().unwrap()[0].has_image);
}

#[test]
fn group_image_refuses_bytes_that_are_not_png() {
    let (dir, svc) = service_with_data();
    let g = svc.save_group(group("Shop")).unwrap();
    let err = svc.set_group_image(g.id, b"GIF89a-not-a-png").unwrap_err();
    assert!(matches!(err, Error::InvalidInput(_)));
    assert!(
        !dir.path()
            .join("group-images")
            .join(format!("{}.png", g.id))
            .exists()
    );
}

#[test]
fn group_image_refuses_more_than_256_kb() {
    let (_dir, svc) = service_with_data();
    let g = svc.save_group(group("Shop")).unwrap();
    let mut big = PNG_SIG.to_vec();
    big.resize(262_145, 0);
    assert!(matches!(
        svc.set_group_image(g.id, &big).unwrap_err(),
        Error::InvalidInput(_)
    ));
    big.truncate(262_144);
    assert!(svc.set_group_image(g.id, &big).is_ok());
}

#[test]
fn clearing_or_deleting_the_group_removes_the_file() {
    let (dir, svc) = service_with_data();
    let a = svc.save_group(group("A")).unwrap();
    let b = svc.save_group(group("B")).unwrap();
    let file = |id: uuid::Uuid| dir.path().join("group-images").join(format!("{id}.png"));
    svc.set_group_image(a.id, &png_bytes()).unwrap();
    svc.set_group_image(b.id, &png_bytes()).unwrap();
    assert!(file(a.id).exists() && file(b.id).exists());
    let cleared = svc.clear_group_image(a.id).unwrap();
    assert!(!cleared.has_image);
    assert!(!file(a.id).exists());
    svc.delete_group(b.id).unwrap();
    assert!(!file(b.id).exists());
}

#[test]
fn group_image_without_a_data_folder_is_refused() {
    let (_dir, _secrets, svc) = service();
    let g = svc.save_group(group("Shop")).unwrap();
    assert!(matches!(
        svc.set_group_image(g.id, &png_bytes()).unwrap_err(),
        Error::InvalidInput(m) if m == "no data folder"
    ));
}

#[test]
fn oversize_base64_is_refused_before_decoding() {
    use contura_core::connections::decode_group_image;
    let huge = "A".repeat(262_144 / 3 * 4 + 5);
    assert!(
        matches!(decode_group_image(&huge), Err(Error::InvalidInput(m)) if m.contains("256 KB"))
    );
    assert_eq!(
        decode_group_image("iVBORw==").unwrap(),
        vec![137, 80, 78, 71]
    );
}
