//! Thread summaries over IPC, trimmed records, stale saves and thread search.

use std::sync::Arc;

use contura_core::ai::AiService;
use contura_core::ai::log::{Level, LogLine, ProcessStep, StepKind};
use contura_core::ai::memory::store::StoreThreads;
use contura_core::ai::memory::{SummaryBy, ThreadStore};
use contura_core::ai::rails::output::{Flag, SqlBlock, StatementCheck};
use contura_core::ai::request::ItemKind;
use contura_core::ai::sent::{
    AnswerAction, AnswerActionKind, AnswerRecord, OutlineSent, SentRecord,
};
use contura_core::ai::{AiMessage, AiRole, AiThread};
use contura_core::connections::{ConnectionInput, ConnectionService, PasswordChange};
use contura_core::model::{DialectKind, SslMode};
use contura_core::safety::{RunVerdict, StatementClass};
use contura_core::secrets::MemorySecretStore;
use contura_core::store::AppStore;
use uuid::Uuid;

struct Fx {
    dir: tempfile::TempDir,
    svc: AiService,
}

fn fx() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
    let svc = AiService::new(store, Arc::new(MemorySecretStore::new()));
    Fx { dir, svc }
}

impl Fx {
    /// A second handle on the same store file, for Topic summaries.
    fn threads(&self) -> StoreThreads {
        StoreThreads::new(AppStore::open(&self.dir.path().join("app.sqlite")).unwrap())
    }
}

fn block(sql: &str) -> SqlBlock {
    SqlBlock {
        fence: 0,
        label: "1 statement: 1 read".into(),
        statements: vec![StatementCheck {
            text: sql.into(),
            class: StatementClass::Read,
            flags: Vec::new(),
        }],
    }
}

fn heavy_record(exact: usize) -> AnswerRecord {
    AnswerRecord {
        sent: Some(SentRecord {
            exact: Some("e".repeat(exact)),
            outline: Some(OutlineSent {
                exact: Some("o".repeat(exact)),
                ..OutlineSent::default()
            }),
            ..SentRecord::default()
        }),
        sql_blocks: vec![block("select 1")],
        thinking: Some("thinking hard".into()),
        log: vec![LogLine {
            at_ms: 1,
            level: Level::Info,
            source: "request".into(),
            fields: vec![("k".into(), "v".into())],
        }],
        steps: vec![ProcessStep {
            step: StepKind::Request,
            at_ms: 2,
            value: "v".into(),
            rule: "r".into(),
            evidence: Vec::new(),
            by_model: false,
            left_out: None,
        }],
        ..AnswerRecord::default()
    }
}

fn msg(role: AiRole, text: &str, at: i64, topic: u32) -> AiMessage {
    AiMessage {
        role,
        text: text.into(),
        context: Vec::new(),
        at,
        record: None,
        topic: Some(topic),
        connection_id: Some(Uuid::from_u128(7)),
        database: Some("shop".into()),
        kinds: vec![ItemKind::Question],
        tables: Vec::new(),
        action: None,
    }
}

fn turn(topic: u32, at: i64, q: &str, record: Option<AnswerRecord>) -> Vec<AiMessage> {
    let mut a = msg(AiRole::Assistant, "answer", at + 1, topic);
    a.record = record;
    vec![msg(AiRole::User, q, at, topic), a]
}

fn thread(place: &str, title: &str, messages: Vec<AiMessage>) -> AiThread {
    AiThread {
        id: Uuid::new_v4(),
        place: place.into(),
        title: title.into(),
        messages,
        updated_at: 100,
    }
}

#[test]
fn list_ships_summaries_only() {
    let f = fx();
    let t = thread(
        "ungrouped",
        "big one",
        turn(1, 10, "how many?", Some(heavy_record(200 * 1024))),
    );
    f.svc.save_thread(&t).unwrap();
    let list = f.svc.list_threads("ungrouped").unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].messages, list[0].topics), (2, 1));
    assert_eq!(list[0].title, "big one");
    let json = serde_json::to_string(&list).unwrap();
    assert!(json.len() < 2048, "{} bytes", json.len());
    assert!(json.contains("updatedAt"));
}

#[test]
fn list_is_newest_first_and_per_place() {
    let f = fx();
    let mut a = thread("ungrouped", "a", turn(1, 10, "q", None));
    a.updated_at = 1;
    let mut b = thread("ungrouped", "b", turn(1, 10, "q", None));
    b.updated_at = 2;
    let c = thread("group:1", "c", turn(1, 10, "q", None));
    for t in [&a, &b, &c] {
        f.svc.save_thread(t).unwrap();
    }
    let titles: Vec<_> = f
        .svc
        .list_threads("ungrouped")
        .unwrap()
        .into_iter()
        .map(|s| s.title)
        .collect();
    assert_eq!(titles, ["b", "a"]);
}

#[test]
fn view_records_are_trimmed() {
    let f = fx();
    let t = thread("ungrouped", "t", turn(1, 10, "q", Some(heavy_record(5000))));
    f.svc.save_thread(&t).unwrap();
    let view = f.svc.thread_view(t.id).unwrap().unwrap();
    assert_eq!(view.topics.len(), 1);
    let r = view.thread.messages[1].record.as_ref().unwrap();
    assert!(r.trimmed);
    assert!(r.log.is_empty() && r.steps.is_empty() && r.thinking.is_none());
    assert!(r.sent.as_ref().unwrap().exact.is_none());
    assert!(
        r.sent
            .as_ref()
            .unwrap()
            .outline
            .as_ref()
            .unwrap()
            .exact
            .is_none()
    );
    assert_eq!(r.sql_blocks.len(), 1);
    let json = serde_json::to_value(&view).unwrap();
    assert_eq!(
        json["thread"]["messages"][1]["record"]["sqlBlocks"][0]["statements"][0]["text"],
        "select 1"
    );
    assert!(f.svc.thread_view(Uuid::new_v4()).unwrap().is_none());
}

#[test]
fn view_trims_compaction_records() {
    use contura_core::ai::memory::Compaction;
    let f = fx();
    let t = thread("ungrouped", "t", turn(1, 10, "q", None));
    f.svc.save_thread(&t).unwrap();
    let c = Compaction {
        id: Uuid::new_v4(),
        thread_id: t.id,
        topic: 1,
        first_at: 10,
        last_at: 11,
        messages: 2,
        summary: "s".into(),
        summary_by: SummaryBy::Rules,
        connection_id: None,
        database: None,
        kinds: Vec::new(),
        before: 9,
        after: 1,
        at: 50,
        undone: false,
        record: heavy_record(100),
    };
    f.threads().add_compaction(&c).unwrap();
    let view = f.svc.thread_view(t.id).unwrap().unwrap();
    let r = &view.compactions[0].record;
    assert!(r.trimmed && r.log.is_empty());
    assert_eq!(r.sql_blocks.len(), 1);
    // The stored one is still whole.
    assert!(!f.threads().compactions(t.id).unwrap()[0].record.trimmed);
}

#[test]
fn answer_record_is_full() {
    let f = fx();
    let t = thread("ungrouped", "t", turn(1, 10, "q", Some(heavy_record(5000))));
    f.svc.save_thread(&t).unwrap();
    let r = f.svc.answer_record(t.id, 11).unwrap().unwrap();
    assert!(!r.trimmed);
    assert_eq!(r.log.len(), 1);
    assert_eq!(r.steps.len(), 1);
    assert_eq!(r.thinking.as_deref(), Some("thinking hard"));
    assert_eq!(r.sent.unwrap().exact.unwrap().len(), 5000);
    assert!(
        f.svc.answer_record(t.id, 10).unwrap().is_none(),
        "a question"
    );
    assert!(f.svc.answer_record(t.id, 99).unwrap().is_none());
}

#[test]
fn trimmed_save_keeps_heavy_fields() {
    let f = fx();
    let t = thread("ungrouped", "t", turn(1, 10, "q", Some(heavy_record(5000))));
    f.svc.save_thread(&t).unwrap();
    let mut copy = f.svc.thread_view(t.id).unwrap().unwrap().thread;
    copy.messages.extend(turn(1, 20, "and again", None));
    let view = f.svc.save_thread(&copy).unwrap();
    assert_eq!(view.thread.messages.len(), 4);
    assert!(view.thread.messages[1].record.as_ref().unwrap().trimmed);
    let r = f.svc.answer_record(t.id, 11).unwrap().unwrap();
    assert!(!r.trimmed);
    assert_eq!(r.log.len(), 1);
    assert_eq!(r.steps.len(), 1);
    assert_eq!(r.thinking.as_deref(), Some("thinking hard"));
    let sent = r.sent.unwrap();
    assert_eq!(sent.exact.unwrap().len(), 5000);
    assert_eq!(sent.outline.unwrap().exact.unwrap().len(), 5000);
}

#[test]
fn stale_save_keeps_stamps_and_actions() {
    let f = fx();
    let t = thread("ungrouped", "t", turn(1, 10, "q", Some(heavy_record(10))));
    f.svc.save_thread(&t).unwrap();
    let action = f
        .svc
        .record_action(t.id, 11, AnswerActionKind::Inserted)
        .unwrap()
        .unwrap();
    // A stale copy: no action, other stamps.
    let mut stale = f.svc.thread_view(t.id).unwrap().unwrap().thread;
    stale.messages[1].record.as_mut().unwrap().actions.clear();
    for m in &mut stale.messages {
        m.topic = Some(9);
        m.database = Some("other".into());
        m.connection_id = None;
        m.kinds.clear();
    }
    f.svc.save_thread(&stale).unwrap();
    let stored = f.threads().thread(t.id).unwrap().unwrap();
    for m in &stored.messages {
        assert_eq!(m.topic, Some(1));
        assert_eq!(m.database.as_deref(), Some("shop"));
        assert_eq!(m.connection_id, Some(Uuid::from_u128(7)));
        assert_eq!(m.kinds, vec![ItemKind::Question]);
    }
    let r = stored.messages[1].record.as_ref().unwrap();
    assert_eq!(r.actions, vec![AnswerAction { ..action }]);
}

#[test]
fn save_for_an_ask_still_writes_its_context() {
    use contura_core::ai::context::sync::ContextInfo;
    let f = fx();
    let t = thread("ungrouped", "t", turn(1, 10, "q", Some(heavy_record(10))));
    let info = ContextInfo {
        connection_id: Uuid::from_u128(42),
        database: "shop".into(),
        schema: "public".into(),
        sync: contura_core::model::AiSyncMode::Automatic,
        built_at: Some(5),
        table_count: 3,
        stale: false,
        check: contura_core::ai::context::sync::SchemaCheck::Failed,
    };
    f.svc.remember_context("req-1", info.clone());
    let view = f.svc.save_thread_for(&t, Some("req-1")).unwrap();
    let ctx = view.thread.messages[1]
        .record
        .as_ref()
        .unwrap()
        .context
        .clone();
    assert_eq!(ctx, Some(info.clone()));
    // A later plain save without it keeps it.
    let mut again = view.thread.clone();
    again.messages[1].record.as_mut().unwrap().context = None;
    f.svc.save_thread(&again).unwrap();
    let r = f.svc.answer_record(t.id, 11).unwrap().unwrap();
    assert_eq!(r.context, Some(info));
}

#[test]
fn search_finds_topics_by_question_and_summary() {
    let f = fx();
    let mut m = turn(1, 10, "which zebra crossings are busiest", None);
    m.extend(turn(2, 30, "plain follow up", None));
    let t = thread("ungrouped", "Crossings", m);
    f.svc.save_thread(&t).unwrap();
    let other = thread("group:2", "Elsewhere", turn(1, 10, "zebra elsewhere", None));
    f.svc.save_thread(&other).unwrap();
    f.threads()
        .set_topic_summary(t.id, 1, "pedestrian walkways by traffic", &SummaryBy::Rules)
        .unwrap();

    let by_question = f.svc.search_threads("ungrouped", "zebra").unwrap();
    assert_eq!(by_question.len(), 1, "{by_question:?}");
    let hit = &by_question[0];
    assert_eq!(
        (hit.thread_id, hit.topic, hit.title.as_str()),
        (t.id, 1, "Crossings")
    );
    assert_eq!(hit.snippet, "pedestrian walkways by traffic");
    assert_eq!(hit.at, 11);
    assert!(!hit.topic_title.is_empty());

    let by_summary = f.svc.search_threads("ungrouped", "walkways").unwrap();
    assert_eq!(by_summary.len(), 1);
    // The open Topic has no summary: its first question is the snippet.
    let open = f.svc.search_threads("ungrouped", "follow").unwrap();
    assert_eq!(open[0].topic, 2);
    assert_eq!(open[0].snippet, "plain follow up");
    // Another place's thread does not show, and the other place finds its own.
    assert_eq!(
        f.svc.search_threads("group:2", "zebra").unwrap()[0].thread_id,
        other.id
    );
    assert!(
        f.svc
            .search_threads("ungrouped", "elsewhere")
            .unwrap()
            .is_empty()
    );
    // Syntax in the text is read as words.
    assert!(f.svc.search_threads("ungrouped", "\"zebra* AND (").is_ok());
}

#[test]
fn search_snippet_is_cut_to_120() {
    let f = fx();
    let long = format!("zebra {}", "x".repeat(300));
    let t = thread("ungrouped", "t", turn(1, 10, &long, None));
    f.svc.save_thread(&t).unwrap();
    let hits = f.svc.search_threads("ungrouped", "zebra").unwrap();
    assert_eq!(hits[0].snippet.chars().count(), 120);
}

#[test]
fn search_empty_text_is_empty() {
    let f = fx();
    let t = thread("ungrouped", "t", turn(1, 10, "zebra", None));
    f.svc.save_thread(&t).unwrap();
    assert!(f.svc.search_threads("ungrouped", "").unwrap().is_empty());
    assert!(f.svc.search_threads("ungrouped", "   ").unwrap().is_empty());
}

#[tokio::test]
async fn list_registers_sql_of_every_thread() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("shop.db");
    rusqlite::Connection::open(&file)
        .unwrap()
        .execute_batch("CREATE TABLE t(a INTEGER);")
        .unwrap();
    let app = dir.path().join("app.sqlite");
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let conns = ConnectionService::new(
        AppStore::open(&app).unwrap(),
        Arc::new(MemorySecretStore::new()),
    )
    .with_data_dir(data);
    let ai = AiService::new(
        AppStore::open(&app).unwrap(),
        Arc::new(MemorySecretStore::new()),
    );
    let saved = conns
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
            file: Some(file),
            query_timeout_secs: None,
            ai_access: Default::default(),
            ai_sync: Default::default(),
            production: true,
            read_only: false,
        })
        .await
        .unwrap();
    conns.open(saved.id).await.unwrap();
    let s = conns.open_query_session(saved.id, None).await.unwrap();

    let record = AnswerRecord {
        sql_blocks: vec![SqlBlock {
            fence: 0,
            label: "1 statement".into(),
            statements: vec![StatementCheck {
                text: "select pg_sleep(1)".into(),
                class: StatementClass::Read,
                flags: vec![Flag::RiskyFunction {
                    name: "pg_sleep".into(),
                }],
            }],
        }],
        ..AnswerRecord::default()
    };
    // Two threads; the flagged one is never opened.
    let t = thread("ungrouped", "old", turn(1, 10, "q", Some(record)));
    ai.save_thread(&t).unwrap();
    let mut other = thread("ungrouped", "new", turn(1, 10, "q", None));
    other.updated_at = 200;
    ai.save_thread(&other).unwrap();

    let sql = "select pg_sleep(1)";
    assert_eq!(
        conns.prepare_run(s, vec![sql.into()]).unwrap(),
        RunVerdict::Ok
    );
    let list = ai.list_threads_registering("ungrouped", &conns).unwrap();
    assert_eq!(list.len(), 2);
    assert!(matches!(
        conns.prepare_run(s, vec![sql.into()]).unwrap(),
        RunVerdict::NeedsConfirmation { .. }
    ));
}
