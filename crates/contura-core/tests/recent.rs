use contura_core::connections::{ConnectionInput, ConnectionService, PasswordChange};
use contura_core::model::{DialectKind, ObjectKind, ObjectPath, SslMode};
use contura_core::query::SavedQueryInput;
use contura_core::recent::{RECENT_LIMIT, RecentTarget};
use contura_core::secrets::MemorySecretStore;
use contura_core::store::AppStore;
use std::sync::Arc;

fn open(path: &std::path::Path) -> ConnectionService {
    ConnectionService::new(
        AppStore::open(path).unwrap(),
        Arc::new(MemorySecretStore::new()),
    )
}

fn service() -> (tempfile::TempDir, ConnectionService) {
    let dir = tempfile::tempdir().unwrap();
    let svc = open(&dir.path().join("app.sqlite"));
    (dir, svc)
}

fn model(file: &str) -> RecentTarget {
    RecentTarget::SchemaModel { file: file.into() }
}

fn table(name: &str) -> RecentTarget {
    RecentTarget::Table {
        path: ObjectPath {
            database: "d".into(),
            schema: None,
            name: name.into(),
        },
        object: ObjectKind::Table,
    }
}

async fn connection(svc: &ConnectionService, name: &str) -> uuid::Uuid {
    svc.save(ConnectionInput {
        id: None,
        name: name.into(),
        dialect: DialectKind::MySql,
        host: "127.0.0.1".into(),
        port: 3306,
        user: "u".into(),
        database: None,
        ssl: SslMode::Disable,
        password: PasswordChange::Keep,
        group_id: None,
        file: None,
        query_timeout_secs: None,
        ai_access: Default::default(),
        production: false,
        read_only: false,
    })
    .await
    .unwrap()
    .id
}

#[test]
fn records_and_lists_newest_first() {
    let (_d, svc) = service();
    svc.record_recent(model("a.dbml"), None).unwrap();
    svc.record_recent(model("b.dbml"), None).unwrap();
    svc.record_recent(model("a.dbml"), None).unwrap();
    let list = svc.recent_items().unwrap();
    let targets: Vec<_> = list.iter().map(|i| i.target.clone()).collect();
    assert_eq!(targets, vec![model("a.dbml"), model("b.dbml")]);
    assert!(list[0].opened_at_ms >= list[1].opened_at_ms);
    assert!(list[0].opened_at_ms > 0);
}

#[test]
fn keeps_at_most_the_limit() {
    let (_d, svc) = service();
    for n in 0..RECENT_LIMIT + 3 {
        svc.record_recent(model(&format!("f{n}.dbml")), None)
            .unwrap();
    }
    assert_eq!(svc.recent_items().unwrap().len(), RECENT_LIMIT);
}

#[test]
fn survives_reopening_the_store() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.sqlite");
    let svc = open(&path);
    svc.record_recent(model("a.dbml"), None).unwrap();
    drop(svc);
    let svc = open(&path);
    assert_eq!(svc.recent_items().unwrap().len(), 1);
}

#[tokio::test]
async fn drops_items_of_a_deleted_connection() {
    let (_d, svc) = service();
    let gone = connection(&svc, "gone").await;
    let kept = connection(&svc, "kept").await;
    svc.record_recent(table("t1"), Some(gone)).unwrap();
    svc.record_recent(table("t2"), Some(kept)).unwrap();
    svc.record_recent(model("m.dbml"), None).unwrap();
    svc.delete(gone).await.unwrap();
    let list = svc.recent_items().unwrap();
    assert_eq!(list.len(), 2);
    assert!(list.iter().all(|i| i.connection_id != Some(gone)));
}

#[test]
fn drops_a_deleted_saved_query() {
    let (_d, svc) = service();
    let q = svc
        .save_saved_query(SavedQueryInput {
            id: None,
            name: "q".into(),
            sql: "select 1".into(),
            connection_id: None,
        })
        .unwrap();
    svc.record_recent(
        RecentTarget::Query {
            saved_id: q.id,
            name: "q".into(),
        },
        None,
    )
    .unwrap();
    assert_eq!(svc.recent_items().unwrap().len(), 1);
    svc.delete_saved_query(q.id).unwrap();
    assert!(svc.recent_items().unwrap().is_empty());
}

#[test]
fn unreadable_value_lists_empty() {
    let dir = tempfile::tempdir().unwrap();
    let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
    store.set_setting("recent_items", "{").unwrap();
    let svc = ConnectionService::new(store, Arc::new(MemorySecretStore::new()));
    assert!(svc.recent_items().unwrap().is_empty());
    svc.record_recent(model("a.dbml"), None).unwrap();
    assert_eq!(svc.recent_items().unwrap().len(), 1);
}

#[test]
fn a_renamed_saved_query_shows_once_with_the_new_name() {
    let (_d, svc) = service();
    let q = svc
        .save_saved_query(SavedQueryInput {
            id: None,
            name: "old".into(),
            sql: "select 1".into(),
            connection_id: None,
        })
        .unwrap();
    let target = |name: &str| RecentTarget::Query {
        saved_id: q.id,
        name: name.into(),
    };
    svc.record_recent(target("old"), None).unwrap();
    svc.save_saved_query(SavedQueryInput {
        id: Some(q.id),
        name: "new".into(),
        sql: "select 1".into(),
        connection_id: None,
    })
    .unwrap();
    assert_eq!(svc.recent_items().unwrap()[0].target, target("new"));
    svc.record_recent(target("new"), None).unwrap();
    let list = svc.recent_items().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].target, target("new"));
}

#[test]
fn clear_recent_returns_the_items_and_restore_puts_them_back() {
    let (_d, svc) = service();
    svc.record_recent(model("a.dbml"), None).unwrap();
    svc.record_recent(model("b.dbml"), None).unwrap();
    let cleared = svc.clear_recent().unwrap();
    let files = |list: &[contura_core::recent::RecentItem]| -> Vec<String> {
        list.iter()
            .map(|i| match &i.target {
                RecentTarget::SchemaModel { file } => file.clone(),
                _ => String::new(),
            })
            .collect()
    };
    assert_eq!(files(&cleared), vec!["b.dbml", "a.dbml"]);
    assert!(svc.recent_items().unwrap().is_empty());
    svc.record_recent(model("c.dbml"), None).unwrap();
    svc.restore_recent(cleared).unwrap();
    assert_eq!(
        files(&svc.recent_items().unwrap()),
        vec!["c.dbml", "b.dbml", "a.dbml"]
    );
}
