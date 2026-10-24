//! Thread summaries over IPC, trimmed records, stale saves and thread search.

use std::sync::Arc;

use contura_core::ai::AiService;
use contura_core::ai::log::{Level, LogLine, ProcessStep, StepKind};
use contura_core::ai::memory::store::StoreThreads;
use contura_core::ai::memory::{AppendTurn, SummaryBy, ThreadStore};
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
        body_sha256: String::new(),
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
        asked_in: None,
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
            body_sha256: String::new(),
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

fn appended(t: &AiThread, messages: Vec<AiMessage>, replace_from: Option<i64>) -> AppendTurn {
    AppendTurn {
        thread_id: t.id,
        place: t.place.clone(),
        title: t.title.clone(),
        updated_at: messages.first().map(|m| m.at).unwrap_or(0),
        messages,
        replace_from,
    }
}

#[test]
fn append_makes_the_thread_then_adds_turns_after_the_stored_ones() {
    let f = fx();
    let t = thread("ungrouped", "first q", Vec::new());
    let one = f
        .svc
        .append_turn(appended(&t, turn(1, 10, "first q", None), None), None)
        .unwrap();
    assert_eq!(one.message_count, 2);
    assert_eq!(one.kept_from, Some(10));
    assert_eq!(
        (one.title.as_str(), one.place.as_str()),
        ("first q", "ungrouped")
    );
    // The stored title stays; only the new messages come back, records trimmed.
    let mut renamed = t.clone();
    renamed.title = "another title".into();
    let two = f
        .svc
        .append_turn(
            appended(
                &renamed,
                turn(1, 20, "second q", Some(heavy_record(4096))),
                None,
            ),
            None,
        )
        .unwrap();
    assert_eq!(two.title, "first q");
    assert_eq!(two.message_count, 4);
    assert_eq!(
        two.messages.iter().map(|m| m.at).collect::<Vec<_>>(),
        vec![20, 21]
    );
    let r = two.messages[1].record.as_ref().unwrap();
    assert!(r.trimmed && r.log.is_empty());
    assert_eq!(two.topics.len(), 1);
    // The store holds both turns, the full record with them.
    let view = f.svc.thread_view(t.id).unwrap().unwrap();
    assert_eq!(
        view.thread
            .messages
            .iter()
            .map(|m| m.text.as_str())
            .collect::<Vec<_>>(),
        vec!["first q", "answer", "second q", "answer"]
    );
    assert_eq!(view.thread.updated_at, 20);
    let full = f.svc.answer_record(t.id, 21).unwrap().unwrap();
    assert_eq!(full.log.len(), 1);
    assert_eq!(f.svc.list_threads("ungrouped").unwrap()[0].messages, 4);
}

#[test]
fn append_with_replace_from_replaces_the_last_turn() {
    let f = fx();
    let t = thread("ungrouped", "q", Vec::new());
    f.svc
        .append_turn(appended(&t, turn(1, 10, "q", None), None), None)
        .unwrap();
    f.svc
        .append_turn(appended(&t, turn(1, 20, "failed q", None), None), None)
        .unwrap();
    let again = f
        .svc
        .append_turn(appended(&t, turn(1, 30, "failed q", None), Some(20)), None)
        .unwrap();
    assert_eq!(again.message_count, 4);
    let view = f.svc.thread_view(t.id).unwrap().unwrap();
    assert_eq!(
        view.thread
            .messages
            .iter()
            .map(|m| m.at)
            .collect::<Vec<_>>(),
        vec![10, 11, 30, 31]
    );
}

#[test]
fn append_keeps_the_200_message_cap_in_whole_turns() {
    use contura_core::store::MESSAGE_LIMIT;
    let f = fx();
    let t = thread("ungrouped", "q", Vec::new());
    let turns = MESSAGE_LIMIT as i64 / 2 + 5;
    let mut last = None;
    for n in 0..turns {
        last = Some(
            f.svc
                .append_turn(
                    appended(&t, turn(1, 10 * (n + 1), &format!("q{n}"), None), None),
                    None,
                )
                .unwrap(),
        );
    }
    let last = last.unwrap();
    assert_eq!(last.message_count as usize, MESSAGE_LIMIT);
    // The oldest five turns are gone; the thread starts at a question.
    assert_eq!(last.kept_from, Some(60));
    let view = f.svc.thread_view(t.id).unwrap().unwrap();
    assert_eq!(view.thread.messages.len(), MESSAGE_LIMIT);
    assert_eq!(view.thread.messages[0].role, AiRole::User);
    assert_eq!(view.thread.messages[0].text, "q5");
}

#[test]
fn append_for_an_ask_writes_its_context_and_caps_the_record() {
    use contura_core::ai::context::sync::ContextInfo;
    let f = fx();
    let t = thread("ungrouped", "q", Vec::new());
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
    let mut record = heavy_record(10);
    record.thinking = Some("t".repeat(200 * 1024));
    f.svc
        .append_turn(
            appended(&t, turn(1, 10, "q", Some(record)), None),
            Some("req-1"),
        )
        .unwrap();
    let r = f.svc.answer_record(t.id, 11).unwrap().unwrap();
    assert_eq!(r.context, Some(info));
    assert!(r.thinking.unwrap().len() < 200 * 1024);
}

/// Task 5b: an AI service and a Connection service on one store file, with A and C
/// ungrouped and B in a Group.
struct Purge {
    dir: tempfile::TempDir,
    conns: ConnectionService,
    ai: AiService,
    a: Uuid,
    b: Uuid,
    c: Uuid,
    group: contura_core::model::GroupId,
}

async fn purge_fx() -> Purge {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app.sqlite");
    let conns = ConnectionService::new(
        AppStore::open(&app).unwrap(),
        Arc::new(MemorySecretStore::new()),
    );
    let ai = AiService::new(
        AppStore::open(&app).unwrap(),
        Arc::new(MemorySecretStore::new()),
    );
    let group = conns
        .save_group(contura_core::connections::GroupInput {
            id: None,
            name: "Kestrel staging".into(),
            color: contura_core::model::GroupColor::Teal,
        })
        .unwrap()
        .id;
    let mut ids = Vec::new();
    for (name, group_id) in [("shop", None), ("staging", Some(group)), ("archive", None)] {
        let saved = conns
            .save(ConnectionInput {
                id: None,
                name: name.into(),
                dialect: DialectKind::Sqlite,
                host: String::new(),
                port: 0,
                user: String::new(),
                database: None,
                ssl: SslMode::Disable,
                password: PasswordChange::Keep,
                group_id,
                file: Some(dir.path().join(format!("{name}.sqlite"))),
                query_timeout_secs: None,
                ai_access: Default::default(),
                ai_sync: Default::default(),
                production: false,
                read_only: false,
            })
            .await
            .unwrap();
        ids.push(saved.id);
    }
    Purge {
        dir,
        conns,
        ai,
        a: ids[0],
        b: ids[1],
        c: ids[2],
        group,
    }
}

fn other_step(id: Uuid, text: &str) -> contura_core::ai::memory::OtherStep {
    contura_core::ai::memory::OtherStep {
        connection_id: id,
        text: text.into(),
        level: contura_core::ai::AiAccess::Schema,
    }
}

impl Purge {
    /// A thread on A's place whose questions keep steps on B and C, and one of the
    /// Group's place (B's) with a step on A; returns their ids.
    fn threads(&self) -> (Uuid, Uuid) {
        use contura_core::ai::memory::AskedIn;
        let asked = |others: Vec<contura_core::ai::memory::OtherStep>| AskedIn {
            tab: "visual".into(),
            label: "Visual Query in shop".into(),
            summary: "tables orders".into(),
            steps: vec!["ticked orders.id".into()],
            other_steps: others,
            ..AskedIn::default()
        };
        let mut on_a = turn(1, 10, "what did I run?", None);
        on_a[0].asked_in = Some(asked(vec![
            other_step(self.b, "ran the Visual Query on another Connection"),
            other_step(self.c, "opened Query tab on another Connection"),
            other_step(self.b, "opened Visual Query on another Connection"),
        ]));
        let mut second = turn(1, 20, "and then?", None);
        second[0].asked_in = Some(asked(vec![other_step(
            self.c,
            "sorted orders on another Connection",
        )]));
        on_a.extend(second);
        let t = thread("ungrouped", "what did I run?", on_a);
        // As the Core stored them: a save from the webview never carries other steps.
        let store = AppStore::open(&self.dir.path().join("app.sqlite")).unwrap();
        store.save_ai_thread(&t).unwrap();
        let mut on_b = turn(1, 30, "and here?", None);
        on_b[0].asked_in = Some(asked(vec![other_step(
            self.a,
            "opened Query tab on another Connection",
        )]));
        let u = thread(&format!("group:{}", self.group), "and here?", on_b);
        store.save_ai_thread(&u).unwrap();
        (t.id, u.id)
    }

    /// The thread as it is on disk, read through a new handle on the file.
    fn on_disk(&self, id: Uuid) -> AiThread {
        AppStore::open(&self.dir.path().join("app.sqlite"))
            .unwrap()
            .get_ai_thread(id)
            .unwrap()
            .unwrap()
    }

    /// Each question's other steps, as (Connection, text).
    fn others(&self, id: Uuid) -> Vec<Vec<(Uuid, String)>> {
        self.on_disk(id)
            .messages
            .iter()
            .filter_map(|m| m.asked_in.as_ref())
            .map(|a| {
                a.other_steps
                    .iter()
                    .map(|s| (s.connection_id, s.text.clone()))
                    .collect()
            })
            .collect()
    }

    /// B's steps are gone everywhere; A's own steps, C's steps and A's steps elsewhere stay.
    fn assert_b_forgotten(&self, (t, u): (Uuid, Uuid)) {
        assert_eq!(
            self.others(t),
            vec![
                vec![(self.c, "opened Query tab on another Connection".to_string())],
                vec![(self.c, "sorted orders on another Connection".to_string())],
            ]
        );
        for m in self
            .on_disk(t)
            .messages
            .iter()
            .filter_map(|m| m.asked_in.as_ref())
        {
            assert_eq!(m.steps, ["ticked orders.id"]);
            assert_eq!(m.summary, "tables orders");
        }
        assert_eq!(
            self.others(u),
            vec![vec![(
                self.a,
                "opened Query tab on another Connection".to_string()
            )]]
        );
    }
}

/// Task 5b, test 4: clearing the AI history of B's place also removes B's steps from the
/// threads of every other place, on disk.
#[tokio::test]
async fn clearing_a_place_history_forgets_its_connections_steps() {
    let f = purge_fx().await;
    let (t, _) = f.threads();
    // B's own place, with a thread of its own that is cleared as today.
    let mut on_b = turn(1, 40, "B's own", None);
    on_b[0].connection_id = Some(f.b);
    let own = thread(&format!("group:{}", f.group), "B's own", on_b);
    f.ai.save_thread(&own).unwrap();
    f.ai.clear_place_history(&format!("group:{}", f.group), &f.conns)
        .unwrap();
    assert!(
        f.ai.list_threads(&format!("group:{}", f.group))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        f.others(t),
        vec![
            vec![(f.c, "opened Query tab on another Connection".to_string())],
            vec![(f.c, "sorted orders on another Connection".to_string())],
        ]
    );
    // Clearing the Ungrouped place forgets A's and C's steps in the Group's threads: none
    // are left there now, so nothing else changes.
    let (_, u2) = f.threads();
    f.ai.clear_place_history("ungrouped", &f.conns).unwrap();
    assert!(f.ai.list_threads("ungrouped").unwrap().is_empty());
    assert!(f.others(u2).iter().all(Vec::is_empty));
}

/// Task 5b, test 5: deleting B removes its steps from every stored Ask, on disk.
#[tokio::test]
async fn deleting_a_connection_forgets_its_steps() {
    let f = purge_fx().await;
    let ids = f.threads();
    f.ai.delete_connection(&f.conns, f.b).await.unwrap();
    // As the command does, off the async runtime.
    f.ai.run_pending_purges().unwrap();
    assert!(f.conns.list().unwrap().iter().all(|c| c.id != f.b));
    f.assert_b_forgotten(ids);
}

/// Task 5b: clearing B's history (its Query History, "Clear history") does the same, and
/// clearing every Connection's history forgets every stored step on another Connection.
#[tokio::test]
async fn clearing_a_connection_history_forgets_its_steps() {
    let f = purge_fx().await;
    let ids = f.threads();
    f.ai.clear_query_history(&f.conns, Some(f.b)).unwrap();
    f.assert_b_forgotten(ids);
    f.ai.clear_query_history(&f.conns, None).unwrap();
    assert!(f.others(ids.0).iter().all(Vec::is_empty));
    assert!(f.others(ids.1).iter().all(Vec::is_empty));
    // The rest of the Asked in stays.
    let t = f.on_disk(ids.0);
    assert!(
        t.messages
            .iter()
            .filter_map(|m| m.asked_in.as_ref())
            .all(|a| a.steps == ["ticked orders.id"])
    );
}

/// Task 5b, test 8: the webview never holds steps on other Connections. The Core keeps
/// those of the Ask's stamp until its turn is stored, drops any the webview sends, and
/// views never carry them.
#[test]
fn other_steps_never_reach_the_webview() {
    use contura_core::ai::memory::{AskedIn, TurnStamp};
    use contura_core::ai::stream::AiEvent;
    let f = fx();
    let b = Uuid::from_u128(43);
    let asked = AskedIn {
        tab: "visual".into(),
        label: "Visual Query in shop".into(),
        summary: "tables orders".into(),
        steps: vec!["ticked orders.id".into()],
        other_steps: vec![other_step(b, "ran the Visual Query on another Connection")],
        ..AskedIn::default()
    };
    let stamp = TurnStamp {
        topic: 1,
        opened: true,
        reason: None,
        title: "t".into(),
        connection_id: Some(Uuid::from_u128(7)),
        database: Some("shop".into()),
        action: "ask".into(),
        tables: Vec::new(),
        kinds: vec![ItemKind::Question],
        asked_in: Some(asked.clone()),
    };
    let event = AiEvent::Memory { stamp };
    // The event as the webview gets it.
    let json = serde_json::to_string(&event).unwrap();
    assert!(
        !json.contains("otherSteps") && !json.contains("ran the Visual Query"),
        "{json}"
    );
    f.svc.hold_other_steps("req-1", &event);

    // The webview's copy of the question: the stamp as it got it, plus a forged step.
    let sent = AskedIn {
        other_steps: vec![other_step(b, "forged")],
        ..asked.clone()
    };
    let t = thread("ungrouped", "what did I run?", Vec::new());
    let mut messages = turn(1, 10, "what did I run?", None);
    messages[0].asked_in = Some(sent);
    let view = f
        .svc
        .append_turn(appended(&t, messages, None), Some("req-1"))
        .unwrap();
    assert!(
        view.messages
            .iter()
            .filter_map(|m| m.asked_in.as_ref())
            .all(|a| a.other_steps.is_empty())
    );
    let stored = f.svc.thread_view(t.id).unwrap().unwrap();
    assert!(
        stored
            .thread
            .messages
            .iter()
            .filter_map(|m| m.asked_in.as_ref())
            .all(|a| a.other_steps.is_empty())
    );
    let on_disk = AppStore::open(&f.dir.path().join("app.sqlite"))
        .unwrap()
        .get_ai_thread(t.id)
        .unwrap()
        .unwrap();
    assert_eq!(
        on_disk.messages[0].asked_in.as_ref().unwrap().other_steps,
        asked.other_steps
    );

    // Without a held stamp (another request), a webview copy keeps none.
    let mut messages = turn(1, 20, "and then?", None);
    messages[0].asked_in = Some(AskedIn {
        other_steps: vec![other_step(b, "forged")],
        ..asked.clone()
    });
    f.svc
        .append_turn(appended(&t, messages, None), Some("req-2"))
        .unwrap();
    let on_disk = AppStore::open(&f.dir.path().join("app.sqlite"))
        .unwrap()
        .get_ai_thread(t.id)
        .unwrap()
        .unwrap();
    assert!(
        on_disk.messages[2]
            .asked_in
            .as_ref()
            .unwrap()
            .other_steps
            .is_empty()
    );

    // The full save of an unsaved chat (a failed append) takes the held steps too.
    f.svc.hold_other_steps("req-3", &event);
    let mut messages = turn(1, 10, "what did I run?", None);
    messages[0].asked_in = Some(asked.label_only());
    let u = thread("ungrouped", "what did I run?", messages);
    let view = f.svc.save_thread_for(&u, Some("req-3")).unwrap();
    assert!(
        view.thread
            .messages
            .iter()
            .filter_map(|m| m.asked_in.as_ref())
            .all(|a| a.other_steps.is_empty())
    );
    let on_disk = AppStore::open(&f.dir.path().join("app.sqlite"))
        .unwrap()
        .get_ai_thread(u.id)
        .unwrap()
        .unwrap();
    assert_eq!(
        on_disk.messages[0].asked_in.as_ref().unwrap().other_steps,
        asked.other_steps
    );
}

/// Task 5b follow-up: with Keep the exact text on, forgetting B also scrubs B's step lines
/// from every kept exact text (the Steps item and the replayed Asked in lines), on disk. A
/// line that cannot be tied to one Connection goes too; A's own steps and C's stay, and one
/// line says what was cleared.
#[tokio::test]
async fn forgetting_a_connection_scrubs_the_kept_exact_text() {
    use contura_core::ai::memory::AskedIn;
    use contura_core::ai::sent::OutlineSent;
    let f = purge_fx().await;
    let late = "ran the Visual Query \"Late orders\" on another Connection, 3 rows";
    let b_open = "opened Visual Query on another Connection";
    let c_sort = "sorted orders on another Connection";
    let unknown = "opened Schema Builder on another Connection";
    let asked = |others: Vec<contura_core::ai::memory::OtherStep>| AskedIn {
        tab: "visual".into(),
        label: "Visual Query in shop".into(),
        summary: "tables orders".into(),
        steps: vec!["ticked orders.id".into()],
        other_steps: others,
        ..AskedIn::default()
    };
    let line = |source: &str, text: &str| {
        serde_json::json!({ "source": source, "text": text }).to_string()
    };
    let exact = [
        "<<contura:context id=abcdefabcdefabcd>>".to_string(),
        line("asked_in", "Visual Query in shop: tables orders"),
        line(
            "asked_in",
            &format!("steps on other Connections before it: {b_open}; {c_sort}"),
        ),
        "<</contura:context id=abcdefabcdefabcd>>".to_string(),
        String::new(),
        "Question: what did I run?".to_string(),
        line(
            "steps",
            &format!(
                "(3 min ago) {late}\n(2 min ago) added orders to the Visual Query\n(1 min ago) {c_sort}\n(just now) {unknown}"
            ),
        ),
        "Question: and then?".to_string(),
    ]
    .join("\n");
    let mut messages = turn(1, 10, "what did I run?", None);
    messages[0].asked_in = Some(asked(vec![
        other_step(f.b, b_open),
        other_step(f.c, c_sort),
    ]));
    let mut record = heavy_record(10);
    record.sent.as_mut().unwrap().exact = Some(exact.clone());
    record.sent.as_mut().unwrap().outline = Some(OutlineSent {
        exact: Some(exact.clone()),
        ..OutlineSent::default()
    });
    let mut second = turn(1, 20, "and then?", Some(record));
    second[0].asked_in = Some(asked(vec![other_step(f.b, late), other_step(f.c, c_sort)]));
    messages.extend(second);
    let t = thread("ungrouped", "what did I run?", messages);
    AppStore::open(&f.dir.path().join("app.sqlite"))
        .unwrap()
        .save_ai_thread(&t)
        .unwrap();

    f.ai.delete_connection(&f.conns, f.b).await.unwrap();
    f.ai.run_pending_purges().unwrap();

    let raw: String = rusqlite::Connection::open(f.dir.path().join("app.sqlite"))
        .unwrap()
        .query_row(
            "SELECT json FROM ai_threads WHERE id = ?1",
            [t.id.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    for gone in ["Late orders", b_open, "Schema Builder"] {
        assert!(!raw.contains(gone), "{gone} is still in {raw}");
    }
    for kept in [
        "added orders to the Visual Query",
        "ticked orders.id",
        c_sort,
    ] {
        assert!(raw.contains(kept), "{kept} is gone from {raw}");
    }
    let back = f.on_disk(t.id);
    let sent = back.messages[3]
        .record
        .as_ref()
        .unwrap()
        .sent
        .as_ref()
        .unwrap();
    let marker = "(steps from a removed Connection were cleared)";
    let want = [
        "<<contura:context id=abcdefabcdefabcd>>".to_string(),
        line("asked_in", "Visual Query in shop: tables orders"),
        line(
            "asked_in",
            &format!("steps on other Connections before it: {marker}; {c_sort}"),
        ),
        "<</contura:context id=abcdefabcdefabcd>>".to_string(),
        String::new(),
        "Question: what did I run?".to_string(),
        line(
            "steps",
            &format!(
                "{marker}\n(2 min ago) added orders to the Visual Query\n(1 min ago) {c_sort}"
            ),
        ),
        "Question: and then?".to_string(),
    ]
    .join("\n");
    assert_eq!(sent.exact.as_deref(), Some(want.as_str()));
    assert_eq!(
        sent.outline.as_ref().unwrap().exact.as_deref(),
        Some(want.as_str())
    );

    // A second forget (C) finds nothing of B and leaves the marker alone.
    f.ai.forget_steps(Some(&[f.c])).unwrap();
    let back = f.on_disk(t.id);
    let exact = back.messages[3]
        .record
        .as_ref()
        .unwrap()
        .sent
        .as_ref()
        .unwrap()
        .exact
        .clone()
        .unwrap();
    assert!(!exact.contains(c_sort), "{exact}");
    assert!(exact.contains("added orders to the Visual Query"));
    assert!(
        exact.contains(&line(
            "steps",
            &format!("{marker}\n(2 min ago) added orders to the Visual Query")
        )),
        "{exact}"
    );
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn framed_line(source: &str, text: &str) -> String {
    serde_json::json!({ "source": source, "text": text }).to_string()
}

/// The Memory event of an Ask whose stamp keeps `others`.
fn memory_event(
    others: Vec<contura_core::ai::memory::OtherStep>,
) -> contura_core::ai::stream::AiEvent {
    use contura_core::ai::memory::{AskedIn, TurnStamp};
    contura_core::ai::stream::AiEvent::Memory {
        stamp: TurnStamp {
            topic: 1,
            opened: true,
            reason: None,
            title: "t".into(),
            connection_id: Some(Uuid::from_u128(7)),
            database: Some("shop".into()),
            action: "ask".into(),
            tables: Vec::new(),
            kinds: vec![ItemKind::Question],
            asked_in: Some(AskedIn {
                tab: "visual".into(),
                label: "Visual Query in shop".into(),
                steps: vec!["added orders to the Visual Query".into()],
                other_steps: others,
                ..AskedIn::default()
            }),
        },
    }
}

const LATE: &str = "ran the Visual Query \"Late orders\" on another Connection, 3 rows";
const C_SORT: &str = "sorted orders on another Connection";

/// The turn as the webview saves it: the question's Asked in as the stamp it was sent
/// (no other steps), the answer's record with its exact text kept.
fn streamed_turn(at: i64) -> Vec<AiMessage> {
    let mut m = turn(1, at, "what did I run?", None);
    m[0].asked_in = Some(contura_core::ai::memory::AskedIn {
        tab: "visual".into(),
        label: "Visual Query in shop".into(),
        steps: vec!["added orders to the Visual Query".into()],
        ..Default::default()
    });
    let mut record = heavy_record(1);
    record.sent.as_mut().unwrap().exact = Some(
        [
            "Question: what did I run?".to_string(),
            framed_line(
                "steps",
                &format!(
                    "(3 min ago) {LATE}\n(2 min ago) added orders to the Visual Query\n(1 min ago) {C_SORT}"
                ),
            ),
        ]
        .join("\n"),
    );
    m[1].record = Some(record);
    m
}

/// Fix round 1, finding 1: a purge while an Ask streams holds that Ask's turn when it is
/// stored, whatever the webview sends back; an Ask begun after it keeps its steps.
#[tokio::test]
async fn a_purge_while_an_ask_streams_holds_its_turn() {
    use contura_core::ai::AiAccess;
    let f = purge_fx().await;
    let all_on = [
        (f.b, AiAccess::SchemaQueryRows),
        (f.c, AiAccess::SchemaQueryRows),
    ];
    let raw = |id: Uuid| -> String {
        rusqlite::Connection::open(f.dir.path().join("app.sqlite"))
            .unwrap()
            .query_row(
                "SELECT json FROM ai_threads WHERE id = ?1",
                [id.to_string()],
                |r| r.get(0),
            )
            .unwrap()
    };

    // Clear history of B while the Ask streams; the turn is appended after.
    let started = now_ms() - 5_000;
    f.ai.hold_other_steps(
        "r1",
        &memory_event(vec![other_step(f.b, LATE), other_step(f.c, C_SORT)]),
    );
    f.ai.clear_query_history(&f.conns, Some(f.b)).unwrap();
    let t = thread("ungrouped", "what did I run?", Vec::new());
    f.ai.append_turn(appended(&t, streamed_turn(started), None), Some("r1"))
        .unwrap();
    let json = raw(t.id);
    assert!(!json.contains("Late orders"), "{json}");
    assert!(
        json.contains(C_SORT) && json.contains("added orders to the Visual Query"),
        "{json}"
    );
    let q = f.on_disk(t.id).messages[0].asked_in.clone().unwrap();
    assert_eq!(q.other_steps, vec![other_step(f.c, C_SORT)]);
    // A later replay, even with B allowing everything, sends nothing of B.
    let replayed = q.replay_lines(&all_on).join("\n");
    assert!(
        !replayed.contains("Late") && replayed.contains(C_SORT),
        "{replayed}"
    );

    // An Ask begun after the Clear keeps its step on B.
    let later = now_ms() + 1_000;
    f.ai.hold_other_steps("r3", &memory_event(vec![other_step(f.b, LATE)]));
    let u = thread("ungrouped", "what did I run?", Vec::new());
    f.ai.append_turn(appended(&u, streamed_turn(later), None), Some("r3"))
        .unwrap();
    assert_eq!(
        f.on_disk(u.id).messages[0]
            .asked_in
            .as_ref()
            .unwrap()
            .other_steps,
        vec![other_step(f.b, LATE)]
    );

    // Delete B while another Ask streams; its turn comes back by the full save.
    let started = now_ms() - 5_000;
    f.ai.hold_other_steps(
        "r2",
        &memory_event(vec![other_step(f.b, LATE), other_step(f.c, C_SORT)]),
    );
    f.ai.delete_connection(&f.conns, f.b).await.unwrap();
    f.ai.run_pending_purges().unwrap();
    let v = thread("ungrouped", "what did I run?", streamed_turn(started));
    f.ai.save_thread_for(&v, Some("r2")).unwrap();
    for id in [t.id, u.id, v.id] {
        let json = raw(id);
        assert!(!json.contains("Late orders"), "{json}");
    }
    assert!(raw(v.id).contains(C_SORT));
}

/// Fix round 1, finding 2: the steps held for an Ask stay until its turn is written, so
/// the full save after a failed append still stores them.
#[test]
fn held_steps_survive_a_failed_append() {
    let f = fx();
    let b = Uuid::from_u128(43);
    f.svc
        .hold_other_steps("r1", &memory_event(vec![other_step(b, LATE)]));
    let t = thread("ungrouped", "what did I run?", Vec::new());
    let db = rusqlite::Connection::open(f.dir.path().join("app.sqlite")).unwrap();
    // A stored row that cannot be read makes the append fail.
    db.execute(
        "INSERT INTO ai_threads (id, place, json, updated_at) VALUES (?1, 'ungrouped', '{', 1)",
        [t.id.to_string()],
    )
    .unwrap();
    assert!(
        f.svc
            .append_turn(appended(&t, streamed_turn(10), None), Some("r1"))
            .is_err()
    );
    db.execute("DELETE FROM ai_threads WHERE id = ?1", [t.id.to_string()])
        .unwrap();
    let full = thread("ungrouped", "what did I run?", streamed_turn(10));
    let full = AiThread { id: t.id, ..full };
    f.svc.save_thread_for(&full, Some("r1")).unwrap();
    let back = AppStore::open(&f.dir.path().join("app.sqlite"))
        .unwrap()
        .get_ai_thread(t.id)
        .unwrap()
        .unwrap();
    assert_eq!(
        back.messages[0].asked_in.as_ref().unwrap().other_steps,
        vec![other_step(b, LATE)]
    );
}

/// Fix round 1, finding 4: a purge that fails after the delete committed is kept pending
/// in the AI store and runs again on the next start.
#[tokio::test]
async fn a_failed_purge_after_a_delete_runs_on_the_next_start() {
    let f = purge_fx().await;
    let ids = f.threads();
    f.ai.fail_next_purge();
    f.ai.delete_connection(&f.conns, f.b).await.unwrap();
    assert!(f.conns.list().unwrap().iter().all(|c| c.id != f.b));
    assert!(f.ai.run_pending_purges().is_err());
    // B is gone; its steps are still on disk, and the purge is pending.
    assert!(f.others(ids.0).iter().flatten().any(|(c, _)| *c == f.b));
    let app = f.dir.path().join("app.sqlite");
    assert!(
        AppStore::open(&app)
            .unwrap()
            .get_setting(contura_core::ai::PENDING_PURGE_KEY)
            .unwrap()
            .is_some()
    );
    // The next start runs it.
    let next = AiService::open(
        AppStore::open(&app).unwrap(),
        Arc::new(MemorySecretStore::new()),
    );
    f.assert_b_forgotten(ids);
    assert!(
        AppStore::open(&app)
            .unwrap()
            .get_setting(contura_core::ai::PENDING_PURGE_KEY)
            .unwrap()
            .is_none()
    );
    assert_eq!(next.run_pending_purges().unwrap().rewritten, 0);
}

/// Task 5b review N2: a thread row that cannot be read is skipped, and the purge goes on
/// through the others: the delete's pending purge is cleared, and a Clear history works.
#[tokio::test]
async fn an_unreadable_thread_row_does_not_block_a_purge() {
    let f = purge_fx().await;
    let ids = f.threads();
    let db = rusqlite::Connection::open(f.dir.path().join("app.sqlite")).unwrap();
    // A cut write that still names other steps, so the purge reads it.
    db.execute(
        "INSERT INTO ai_threads (id, place, json, updated_at) VALUES (?1, 'ungrouped', '{\"otherSteps\":[', 1)",
        [Uuid::new_v4().to_string()],
    )
    .unwrap();
    f.ai.delete_connection(&f.conns, f.b).await.unwrap();
    let done = f.ai.run_pending_purges().unwrap();
    assert_eq!((done.rewritten, done.unreadable), (1, 1));
    f.assert_b_forgotten(ids);
    let app = f.dir.path().join("app.sqlite");
    assert!(
        AppStore::open(&app)
            .unwrap()
            .get_setting(contura_core::ai::PENDING_PURGE_KEY)
            .unwrap()
            .is_none()
    );
    f.ai.clear_query_history(&f.conns, Some(f.c)).unwrap();
    assert!(f.others(ids.0).iter().all(Vec::is_empty));
}

/// Task 5b review N1: deletes that overlap each other and the purges they start lose no
/// pending purge: every deleted Connection's steps are gone once the purges have run.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn overlapping_deletes_lose_no_pending_purge() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app.sqlite");
    let conns = Arc::new(ConnectionService::new(
        AppStore::open(&app).unwrap(),
        Arc::new(MemorySecretStore::new()),
    ));
    let ai = Arc::new(AiService::new(
        AppStore::open(&app).unwrap(),
        Arc::new(MemorySecretStore::new()),
    ));
    let mut ids = Vec::new();
    for n in 0..32 {
        let saved = conns
            .save(ConnectionInput {
                id: None,
                name: format!("kestrel {n}"),
                dialect: DialectKind::Sqlite,
                host: String::new(),
                port: 0,
                user: String::new(),
                database: None,
                ssl: SslMode::Disable,
                password: PasswordChange::Keep,
                group_id: None,
                file: Some(dir.path().join(format!("k{n}.sqlite"))),
                query_timeout_secs: None,
                ai_access: Default::default(),
                ai_sync: Default::default(),
                production: false,
                read_only: false,
            })
            .await
            .unwrap();
        ids.push(saved.id);
    }
    let mut messages = turn(1, 10, "what did I run?", None);
    messages[0].asked_in = Some(contura_core::ai::memory::AskedIn {
        tab: "home".into(),
        label: "Home".into(),
        other_steps: ids
            .iter()
            .map(|id| other_step(*id, "opened Query tab on another Connection"))
            .collect(),
        ..Default::default()
    });
    let t = thread("ungrouped", "what did I run?", messages);
    AppStore::open(&app).unwrap().save_ai_thread(&t).unwrap();

    // Each delete as the command runs it: the delete, then its purges off the runtime.
    let tasks: Vec<_> = ids
        .iter()
        .map(|id| {
            let (ai, conns, id) = (ai.clone(), conns.clone(), *id);
            tokio::spawn(async move {
                ai.delete_connection(&conns, id).await.unwrap();
                let ai = ai.clone();
                tokio::task::spawn_blocking(move || ai.run_pending_purges().unwrap())
                    .await
                    .unwrap();
            })
        })
        .collect();
    for t in tasks {
        t.await.unwrap();
    }
    let left: Vec<Uuid> = AppStore::open(&app)
        .unwrap()
        .get_ai_thread(t.id)
        .unwrap()
        .unwrap()
        .messages[0]
        .asked_in
        .as_ref()
        .unwrap()
        .other_steps
        .iter()
        .map(|s| s.connection_id)
        .collect();
    assert_eq!(left, Vec::<Uuid>::new(), "steps left behind");
    assert!(
        AppStore::open(&app)
            .unwrap()
            .get_setting(contura_core::ai::PENDING_PURGE_KEY)
            .unwrap()
            .is_none()
    );
}
