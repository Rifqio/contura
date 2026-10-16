mod common;

use common::TestDb;
use dbview_core::Error;
use dbview_core::connections::{ConnectionInput, ConnectionService, GroupInput, PasswordChange};
use dbview_core::model::{DialectKind, GroupColor, SslMode};
use dbview_core::secrets::{MemorySecretStore, SecretStore};
use dbview_core::store::AppStore;
use std::sync::Arc;

fn service() -> (tempfile::TempDir, Arc<MemorySecretStore>, ConnectionService) {
    let dir = tempfile::tempdir().unwrap();
    let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
    let secrets = Arc::new(MemorySecretStore::new());
    let svc = ConnectionService::new(store, secrets.clone());
    (dir, secrets, svc)
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
        color: GroupColor::Red,
    }
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
    let config: dbview_core::model::ConnectionConfig = serde_json::from_str(json).unwrap();
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
            ..input("lite", PasswordChange::Set { value: "x".into() })
        })
        .await
        .unwrap();
    assert_eq!(secrets.get(saved.id).unwrap(), None);
}
