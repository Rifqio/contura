//! Step 11f end to end: a real SQLite Connection gives an Ask's sample rows, read live by
//! `ConnectionService` through the read-only path, cut and framed as the preview shows them.
mod common;

use std::sync::Arc;

use contura_core::ai::models::info_for;
use contura_core::ai::preview::preview;
use contura_core::ai::rails::Secrets;
use contura_core::ai::request::{AskRequest, Focus, Switches, TableRef};
use contura_core::ai::{AiAccess, AiProviderKind, AiSettings};
use contura_core::connections::{ConnectionInput, ConnectionService, PasswordChange};
use contura_core::model::{DialectKind, SslMode};
use contura_core::secrets::MemorySecretStore;
use contura_core::store::AppStore;

fn groq() -> AiSettings {
    AiSettings {
        provider: Some(AiProviderKind::Groq),
        model: "llama-3.3-70b-versatile".into(),
        // A window whose rows share holds five rows of this table.
        context_window: Some(131_072),
        ..AiSettings::default()
    }
}

#[tokio::test]
async fn sample_rows_end_to_end_sqlite() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("shop.db");
    let db = rusqlite::Connection::open(&file).unwrap();
    db.execute_batch("CREATE TABLE orders(id INTEGER PRIMARY KEY, photo BLOB, note TEXT);")
        .unwrap();
    for id in 1..=7 {
        let note = if id == 1 {
            "n".repeat(300)
        } else {
            format!("note {id}")
        };
        db.execute(
            "INSERT INTO orders(id, photo, note) VALUES (?1, x'0102ff', ?2)",
            rusqlite::params![id, note],
        )
        .unwrap();
    }
    drop(db);

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
            ai_access: AiAccess::SchemaQueryRows,
            ai_sync: Default::default(),
            production: false,
            read_only: false,
        })
        .await
        .unwrap();
    svc.open(saved.id).await.unwrap();

    let settings = groq();
    let model = info_for(AiProviderKind::Groq, None, &settings.model, None, &settings);
    let req = AskRequest {
        request_id: "r1".into(),
        place: "ungrouped".into(),
        group_id: None,
        connection_id: Some(saved.id),
        database: None,
        schema: None,
        action: "ask".into(),
        question: "what is in orders?".into(),
        thread_id: None,
        focus: Focus {
            tables: vec![TableRef {
                schema: None,
                name: "orders".into(),
            }],
            ..Focus::default()
        },
        switches: Switches {
            rows: true,
            values: false,
        },
        off: Vec::new(),
        model: None,
        picks: None,
    };
    let p = preview(&*svc, &settings, &model, &Secrets::default(), &req)
        .await
        .unwrap();

    let line = p
        .exact
        .lines()
        .find(|l| l.starts_with(r#"{"source":"rows""#))
        .unwrap_or_else(|| panic!("no rows line in {}", p.exact));
    let v: serde_json::Value = serde_json::from_str(line).unwrap();
    let text = v["text"].as_str().unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines[0], "orders(id, photo, note)");
    assert_eq!(lines.len(), 6, "{text}");
    assert_eq!(
        lines[1],
        format!(r#"["1","<binary>","{}…"]"#, "n".repeat(200))
    );
    assert_eq!(lines[5], r#"["5","<binary>","note 5"]"#);
    let sent = p.rows.expect("rows go");
    assert_eq!((sent.tables, sent.rows), (1, 5));

    // Nothing was written: the table still holds its 7 rows.
    let db = rusqlite::Connection::open(&file).unwrap();
    let n: i64 = db
        .query_row("SELECT count(*) FROM orders", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 7);
}
