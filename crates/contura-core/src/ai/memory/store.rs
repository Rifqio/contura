//! The Topic and compaction tables of the app store.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension, params};

use super::{
    Compaction, CompactionId, SummaryBy, ThreadHit, ThreadStore, ThreadSummary, Topic,
    rule_summary, topic_title,
};
use crate::ai::request::ItemKind;
use crate::ai::{AiMessage, AiRole, AiThread, ThreadId};
use crate::error::{Error, Result};
use crate::model::ConnectionId;
use crate::store::AppStore;

/// The most question text one Topic keeps in its search row.
const QUESTIONS_BYTES: usize = 2048;

/// Weights for `thread_id seq place title summary tables questions`.
const BM25: &str = "bm25(ai_topic_fts, 0, 0, 0, 10.0, 4.0, 6.0, 0)";

fn store_err(e: impl std::fmt::Display) -> Error {
    Error::Store(e.to_string())
}

fn json<T: serde::Serialize>(v: &T) -> Result<String> {
    serde_json::to_string(v).map_err(store_err)
}

fn cut_bytes(mut s: String, max: usize) -> String {
    if s.len() > max {
        let mut end = max;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
    }
    s
}

pub fn thread(conn: &Connection, id: ThreadId) -> Result<Option<AiThread>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT json FROM ai_threads WHERE id = ?1",
            params![id.to_string()],
            |r| r.get(0),
        )
        .optional()
        .map_err(store_err)?;
    raw.map(|j| serde_json::from_str(&j).map_err(store_err))
        .transpose()
}

pub fn topics(conn: &Connection, thread: ThreadId) -> Result<Vec<Topic>> {
    let mut stmt = conn
        .prepare(
            "SELECT seq, title, summary, summary_by, tables, connection_id, database, kinds,
                    first_at, last_at, messages, closed
             FROM ai_topic WHERE thread_id = ?1 ORDER BY seq",
        )
        .map_err(store_err)?;
    let rows = stmt
        .query_map(params![thread.to_string()], |r| {
            Ok((
                r.get::<_, u32>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, i64>(8)?,
                r.get::<_, i64>(9)?,
                r.get::<_, u32>(10)?,
                r.get::<_, bool>(11)?,
            ))
        })
        .map_err(store_err)?;
    let mut out = Vec::new();
    for row in rows {
        let (
            seq,
            title,
            summary,
            by,
            tables,
            conn_id,
            database,
            kinds,
            first_at,
            last_at,
            n,
            closed,
        ) = row.map_err(store_err)?;
        out.push(Topic {
            thread_id: thread,
            seq,
            title,
            summary,
            summary_by: SummaryBy::from_column(&by),
            tables: serde_json::from_str(&tables).map_err(store_err)?,
            connection_id: conn_id.and_then(|c| c.parse().ok()),
            database,
            kinds: serde_json::from_str(&kinds).map_err(store_err)?,
            first_at,
            last_at,
            messages: n,
            closed,
        });
    }
    Ok(out)
}

pub fn compactions(conn: &Connection, thread: ThreadId) -> Result<Vec<Compaction>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, topic, first_at, last_at, messages, summary, summary_by, connection_id,
                    database, kinds, before_tokens, after_tokens, at, undone, record
             FROM ai_compaction WHERE thread_id = ?1 ORDER BY at, id",
        )
        .map_err(store_err)?;
    let rows = stmt
        .query_map(params![thread.to_string()], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u32>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, u32>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, Option<String>>(8)?,
                r.get::<_, String>(9)?,
                r.get::<_, u32>(10)?,
                r.get::<_, u32>(11)?,
                r.get::<_, i64>(12)?,
                r.get::<_, bool>(13)?,
                r.get::<_, String>(14)?,
            ))
        })
        .map_err(store_err)?;
    let mut out = Vec::new();
    for row in rows {
        let (
            id,
            topic,
            first_at,
            last_at,
            n,
            summary,
            by,
            conn_id,
            database,
            kinds,
            before,
            after,
            at,
            undone,
            record,
        ) = row.map_err(store_err)?;
        out.push(Compaction {
            id: id.parse().map_err(store_err)?,
            thread_id: thread,
            topic,
            first_at,
            last_at,
            messages: n,
            summary,
            summary_by: SummaryBy::from_column(&by),
            connection_id: conn_id.and_then(|c| c.parse().ok()),
            database,
            kinds: serde_json::from_str(&kinds).map_err(store_err)?,
            before,
            after,
            at,
            undone,
            record: serde_json::from_str(&record).map_err(store_err)?,
        });
    }
    Ok(out)
}

/// Closed Topics only, best first. Each term is quoted, so FTS syntax in a term is
/// read as words.
pub fn match_topics(
    conn: &Connection,
    thread: ThreadId,
    terms: &[String],
    limit: usize,
) -> Result<Vec<u32>> {
    let quoted: Vec<String> = terms
        .iter()
        .filter(|t| !t.trim().is_empty())
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect();
    if quoted.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let query = format!("{{title summary tables}} : ({})", quoted.join(" OR "));
    let mut stmt = conn
        .prepare(&format!(
            "SELECT f.seq FROM ai_topic_fts f
             JOIN ai_topic t ON t.thread_id = f.thread_id AND t.seq = f.seq
             WHERE ai_topic_fts MATCH ?1 AND f.thread_id = ?2 AND t.closed = 1
             ORDER BY {BM25}, f.seq LIMIT ?3"
        ))
        .map_err(store_err)?;
    let rows = stmt
        .query_map(
            params![
                query,
                thread.to_string(),
                i64::try_from(limit).unwrap_or(i64::MAX)
            ],
            |r| r.get::<_, u32>(0),
        )
        .map_err(store_err)?;
    rows.map(|r| r.map_err(store_err)).collect()
}

pub fn set_topic_summary(
    conn: &Connection,
    thread: ThreadId,
    seq: u32,
    summary: &str,
    by: &SummaryBy,
) -> Result<()> {
    let id = thread.to_string();
    conn.execute(
        "UPDATE ai_topic SET summary = ?3, summary_by = ?4 WHERE thread_id = ?1 AND seq = ?2",
        params![id, seq, summary, by.to_column()],
    )
    .map_err(store_err)?;
    // Keep the search row's other columns; only `summary` changes.
    conn.execute(
        "UPDATE ai_topic_fts SET summary = ?3 WHERE thread_id = ?1 AND seq = ?2",
        params![id, seq, summary],
    )
    .map_err(store_err)?;
    Ok(())
}

pub fn add_compaction(conn: &Connection, c: &Compaction) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO ai_compaction
           (id, thread_id, topic, first_at, last_at, messages, summary, summary_by,
            connection_id, database, kinds, before_tokens, after_tokens, at, undone, record)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            c.id.to_string(),
            c.thread_id.to_string(),
            c.topic,
            c.first_at,
            c.last_at,
            c.messages,
            c.summary,
            c.summary_by.to_column(),
            c.connection_id.map(|i| i.to_string()),
            c.database,
            json(&c.kinds)?,
            c.before,
            c.after,
            c.at,
            c.undone,
            json(&c.record)?,
        ],
    )
    .map_err(store_err)?;
    Ok(())
}

pub fn undo_compaction(conn: &Connection, thread: ThreadId, id: CompactionId) -> Result<bool> {
    let n = conn
        .execute(
            "UPDATE ai_compaction SET undone = 1
             WHERE thread_id = ?1 AND id = ?2 AND undone = 0",
            params![thread.to_string(), id.to_string()],
        )
        .map_err(store_err)?;
    Ok(n > 0)
}

/// The place's threads without their messages, newest first, at most `limit`.
pub fn list_summaries(conn: &Connection, place: &str, limit: i64) -> Result<Vec<ThreadSummary>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, json_extract(json, '$.title'), updated_at,
                    json_array_length(json, '$.messages'),
                    (SELECT COUNT(*) FROM ai_topic WHERE thread_id = ai_threads.id)
             FROM ai_threads WHERE place = ?1
             ORDER BY updated_at DESC, id LIMIT ?2",
        )
        .map_err(store_err)?;
    let rows = stmt
        .query_map(params![place, limit], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, u32>(3)?,
                r.get::<_, u32>(4)?,
            ))
        })
        .map_err(store_err)?;
    let mut out = Vec::new();
    for row in rows {
        let (id, title, updated_at, messages, topics) = row.map_err(store_err)?;
        out.push(ThreadSummary {
            id: id.parse().map_err(store_err)?,
            place: place.to_string(),
            title: title.unwrap_or_default(),
            updated_at,
            messages,
            topics,
        });
    }
    Ok(out)
}

/// The place's Topics whose title, summary, tables or questions hold one of `terms`,
/// best first. Each term is quoted, so FTS syntax in a term is read as words.
pub fn search_place(
    conn: &Connection,
    place: &str,
    terms: &[String],
    limit: usize,
) -> Result<Vec<ThreadHit>> {
    let quoted: Vec<String> = terms
        .iter()
        .filter(|t| !t.trim().is_empty())
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect();
    if quoted.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let query = quoted.join(" OR ");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT f.thread_id, json_extract(th.json, '$.title'), f.seq, t.title, t.summary,
                    f.questions, t.last_at
             FROM ai_topic_fts f
             JOIN ai_topic t ON t.thread_id = f.thread_id AND t.seq = f.seq
             JOIN ai_threads th ON th.id = f.thread_id
             WHERE ai_topic_fts MATCH ?1 AND f.place = ?2
             ORDER BY {BM25}, f.thread_id, f.seq LIMIT ?3"
        ))
        .map_err(store_err)?;
    let rows = stmt
        .query_map(
            params![query, place, i64::try_from(limit).unwrap_or(i64::MAX)],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, u32>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, i64>(6)?,
                ))
            },
        )
        .map_err(store_err)?;
    let mut out = Vec::new();
    for row in rows {
        let (thread_id, title, topic, topic_title, summary, questions, at) =
            row.map_err(store_err)?;
        let source = if summary.trim().is_empty() {
            questions.lines().next().unwrap_or("").trim().to_string()
        } else {
            summary.trim().to_string()
        };
        out.push(ThreadHit {
            thread_id: thread_id.parse().map_err(store_err)?,
            title: title.unwrap_or_default(),
            topic,
            topic_title,
            snippet: source.chars().take(120).collect(),
            at,
        });
    }
    Ok(out)
}

/// Deletes every Topic, search row and compaction of the threads.
pub(crate) fn delete_for_threads(conn: &Connection, ids: &[String]) -> Result<()> {
    for id in ids {
        for sql in [
            "DELETE FROM ai_topic WHERE thread_id = ?1",
            "DELETE FROM ai_topic_fts WHERE thread_id = ?1",
            "DELETE FROM ai_compaction WHERE thread_id = ?1",
        ] {
            conn.execute(sql, params![id]).map_err(store_err)?;
        }
    }
    Ok(())
}

struct Group<'a> {
    messages: Vec<&'a AiMessage>,
}

/// Rebuilds the thread's Topics from its stamped messages. A stored summary is kept;
/// messages without a `topic` belong to none.
pub fn sync_topics(conn: &Connection, thread: &AiThread) -> Result<()> {
    let id = thread.id.to_string();
    let mut groups: BTreeMap<u32, Group> = BTreeMap::new();
    for m in &thread.messages {
        if let Some(seq) = m.topic {
            groups
                .entry(seq)
                .or_insert_with(|| Group {
                    messages: Vec::new(),
                })
                .messages
                .push(m);
        }
    }
    let highest = groups.keys().next_back().copied();
    let existing: BTreeMap<u32, (String, String)> = topics(conn, thread.id)?
        .into_iter()
        .map(|t| (t.seq, (t.summary, t.summary_by.to_column())))
        .collect();

    // Drop rows of seqs that are gone.
    for seq in existing.keys().filter(|s| !groups.contains_key(s)) {
        conn.execute(
            "DELETE FROM ai_topic WHERE thread_id = ?1 AND seq = ?2",
            params![id, seq],
        )
        .map_err(store_err)?;
        conn.execute(
            "DELETE FROM ai_topic_fts WHERE thread_id = ?1 AND seq = ?2",
            params![id, seq],
        )
        .map_err(store_err)?;
    }

    for (seq, g) in &groups {
        let first_user = g.messages.iter().find(|m| m.role == AiRole::User);
        let title = topic_title(
            first_user
                .or_else(|| g.messages.first())
                .map(|m| m.text.as_str())
                .unwrap_or(""),
        );
        let tables: BTreeSet<&str> = g
            .messages
            .iter()
            .flat_map(|m| m.tables.iter().map(String::as_str))
            .collect();
        let tables: Vec<&str> = tables.into_iter().collect();
        let mut kinds: BTreeMap<String, ItemKind> = BTreeMap::new();
        for k in g.messages.iter().flat_map(|m| m.kinds.iter()) {
            kinds.insert(json(k)?, *k);
        }
        let kinds: Vec<ItemKind> = kinds.into_values().collect();
        let head = g.messages[0];
        let connection_id: Option<ConnectionId> = head.connection_id;
        let first_at = g.messages.iter().map(|m| m.at).min().unwrap_or(0);
        let last_at = g.messages.iter().map(|m| m.at).max().unwrap_or(0);
        let closed = Some(*seq) != highest;
        let (mut summary, mut by) = existing.get(seq).cloned().unwrap_or_default();
        if closed && summary.is_empty() {
            summary = rule_summary(&g.messages);
            by = SummaryBy::Rules.to_column();
        }
        let questions = cut_bytes(
            g.messages
                .iter()
                .filter(|m| m.role == AiRole::User)
                .map(|m| m.text.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
            QUESTIONS_BYTES,
        );
        conn.execute(
            "INSERT OR REPLACE INTO ai_topic
               (thread_id, seq, place, title, summary, summary_by, tables, connection_id,
                database, kinds, first_at, last_at, messages, closed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                id,
                seq,
                thread.place,
                title,
                summary,
                by,
                json(&tables)?,
                connection_id.map(|c| c.to_string()),
                head.database,
                json(&kinds)?,
                first_at,
                last_at,
                g.messages.len() as i64,
                closed,
            ],
        )
        .map_err(store_err)?;
        conn.execute(
            "DELETE FROM ai_topic_fts WHERE thread_id = ?1 AND seq = ?2",
            params![id, seq],
        )
        .map_err(store_err)?;
        conn.execute(
            "INSERT INTO ai_topic_fts (thread_id, seq, place, title, summary, tables, questions)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                seq,
                thread.place,
                title,
                summary,
                tables.join(" "),
                questions
            ],
        )
        .map_err(store_err)?;
    }
    Ok(())
}

/// The thread functions over an `AppStore` of their own (test fakes use it).
pub struct StoreThreads(Mutex<AppStore>);

impl StoreThreads {
    pub fn new(store: AppStore) -> Self {
        Self(Mutex::new(store))
    }

    fn lock(&self) -> Result<MutexGuard<'_, AppStore>> {
        self.0
            .lock()
            .map_err(|_| Error::Store("lock poisoned".into()))
    }

    /// Saves a thread (test fakes use it to fill the store).
    pub fn save_thread(&self, t: &AiThread) -> Result<()> {
        self.lock()?.save_ai_thread(t)
    }
}

impl ThreadStore for StoreThreads {
    fn thread(&self, id: ThreadId) -> Result<Option<AiThread>> {
        thread(self.lock()?.conn(), id)
    }
    fn topics(&self, t: ThreadId) -> Result<Vec<Topic>> {
        topics(self.lock()?.conn(), t)
    }
    fn compactions(&self, t: ThreadId) -> Result<Vec<Compaction>> {
        compactions(self.lock()?.conn(), t)
    }
    fn match_topics(&self, t: ThreadId, terms: &[String], limit: usize) -> Result<Vec<u32>> {
        match_topics(self.lock()?.conn(), t, terms, limit)
    }
    fn set_topic_summary(
        &self,
        t: ThreadId,
        seq: u32,
        summary: &str,
        by: &SummaryBy,
    ) -> Result<()> {
        set_topic_summary(self.lock()?.conn(), t, seq, summary, by)
    }
    fn add_compaction(&self, c: &Compaction) -> Result<()> {
        add_compaction(self.lock()?.conn(), c)
    }
    fn undo_compaction(&self, t: ThreadId, id: CompactionId) -> Result<bool> {
        undo_compaction(self.lock()?.conn(), t, id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{AiMessage, AiRole};
    use uuid::Uuid;

    fn open() -> StoreThreads {
        StoreThreads::new(AppStore::open(std::path::Path::new(":memory:")).unwrap())
    }

    fn msg(role: AiRole, text: &str, at: i64, topic: Option<u32>, tables: &[&str]) -> AiMessage {
        AiMessage {
            role,
            text: text.into(),
            context: Vec::new(),
            at,
            record: None,
            topic,
            connection_id: topic.map(|_| Uuid::from_u128(7)),
            database: topic.map(|_| "shop".into()),
            kinds: if topic.is_some() {
                vec![ItemKind::Question]
            } else {
                Vec::new()
            },
            tables: tables.iter().map(|t| t.to_string()).collect(),
            action: None,
            asked_in: None,
        }
    }

    fn turn(topic: u32, at: i64, q: &str, tables: &[&str]) -> Vec<AiMessage> {
        vec![
            msg(AiRole::User, q, at, Some(topic), tables),
            msg(AiRole::Assistant, "ok", at + 1, Some(topic), tables),
        ]
    }

    fn thread_of(messages: Vec<AiMessage>) -> AiThread {
        AiThread {
            id: Uuid::new_v4(),
            place: "ungrouped".into(),
            title: "t".into(),
            messages,
            updated_at: 1,
        }
    }

    fn two_topics() -> AiThread {
        let mut m = turn(1, 10, "How many invoices were paid late?", &["invoices"]);
        m.extend(turn(1, 20, "and by month", &["payments"]));
        m.extend(turn(2, 30, "list the shipments", &["shipments"]));
        thread_of(m)
    }

    #[test]
    fn sync_builds_topics() {
        let s = open();
        let t = two_topics();
        s.save_thread(&t).unwrap();
        let topics = s.topics(t.id).unwrap();
        assert_eq!(topics.len(), 2);
        let (a, b) = (&topics[0], &topics[1]);
        assert_eq!((a.seq, a.closed, b.seq, b.closed), (1, true, 2, false));
        assert_eq!(a.title, "How many invoices were paid late?");
        assert_eq!(a.tables, vec!["invoices", "payments"]);
        assert_eq!(a.kinds, vec![ItemKind::Question]);
        assert_eq!(a.connection_id, Some(Uuid::from_u128(7)));
        assert_eq!(a.database.as_deref(), Some("shop"));
        assert_eq!((a.first_at, a.last_at, a.messages), (10, 21, 4));
        assert_eq!(a.summary_by, SummaryBy::Rules);
        assert_eq!(
            a.summary,
            "Asked: How many invoices were paid late?. Tables: invoices, payments. Answers: ok / ok."
        );
        assert_eq!((b.summary.as_str(), &b.summary_by), ("", &SummaryBy::None));
        // A closed Topic is found by its table; the open one by nothing.
        assert_eq!(s.match_topics(t.id, &["payments".into()], 5).unwrap(), [1]);
        assert!(
            s.match_topics(t.id, &["shipments".into()], 5)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn sync_keeps_model_summary() {
        let s = open();
        let mut t = two_topics();
        let by = SummaryBy::Model {
            model: "llama".into(),
        };
        s.save_thread(&t).unwrap();
        s.set_topic_summary(t.id, 1, "late invoices, by month", &by)
            .unwrap();
        assert_eq!(
            s.match_topics(t.id, &["late".into()], 5).unwrap(),
            [1],
            "the summary is searchable"
        );
        t.messages
            .extend(turn(2, 40, "and the carriers", &["carriers"]));
        s.save_thread(&t).unwrap();
        let a = &s.topics(t.id).unwrap()[0];
        assert_eq!(
            (a.summary.as_str(), &a.summary_by),
            ("late invoices, by month", &by)
        );
        assert_eq!(s.topics(t.id).unwrap()[1].messages, 4);
    }

    #[test]
    fn unstamped_messages_make_no_topic() {
        let s = open();
        let t = thread_of(vec![
            msg(AiRole::User, "old question", 1, None, &[]),
            msg(AiRole::Assistant, "old answer", 2, None, &[]),
        ]);
        s.save_thread(&t).unwrap();
        assert!(s.topics(t.id).unwrap().is_empty());
        // Seqs that are gone lose their rows.
        let mut u = two_topics();
        s.save_thread(&u).unwrap();
        u.messages.retain(|m| m.topic == Some(2));
        s.save_thread(&u).unwrap();
        assert_eq!(s.topics(u.id).unwrap().len(), 1);
        assert_eq!(s.thread(u.id).unwrap().unwrap().messages.len(), 2);
    }

    #[test]
    fn match_topics_reads_closed_only_and_not_questions() {
        let s = open();
        let mut m = turn(1, 10, "tell me about zebra crossings", &["invoices"]);
        m.extend(turn(2, 30, "walrus counts", &["walrus_log"]));
        let t = thread_of(m);
        s.save_thread(&t).unwrap();
        let find = |w: &str| s.match_topics(t.id, &[w.into()], 5).unwrap();
        // Closed Topic 1: title words and table names hit; the second word of the title
        // is in the title column too, so only a word that is in no matched column misses.
        assert_eq!(find("zebra"), [1]);
        assert_eq!(find("invoices"), [1]);
        // The open Topic 2 gives none, even for a word in its title.
        assert!(find("walrus").is_empty());
        // A word only in a later question of a closed Topic is not read.
        let mut m = turn(1, 10, "first", &[]);
        m.extend(turn(1, 20, "quokka sightings", &[]));
        m.extend(turn(2, 30, "next", &[]));
        let u = thread_of(m);
        s.save_thread(&u).unwrap();
        assert!(
            s.match_topics(u.id, &["quokka".into()], 5)
                .unwrap()
                .is_empty()
        );
        assert_eq!(s.match_topics(u.id, &["first".into()], 5).unwrap(), [1]);
    }

    #[test]
    fn match_with_fts_syntax_is_words() {
        let s = open();
        let t = two_topics();
        s.save_thread(&t).unwrap();
        for term in ["\"", "NEAR", "x*", "-a", "a AND (", ""] {
            assert!(
                s.match_topics(t.id, &[term.to_string()], 5).is_ok(),
                "{term:?}"
            );
        }
    }

    #[test]
    fn undo_twice_returns_false() {
        let s = open();
        let t = two_topics();
        s.save_thread(&t).unwrap();
        let c = Compaction {
            id: Uuid::new_v4(),
            thread_id: t.id,
            topic: 1,
            first_at: 10,
            last_at: 21,
            messages: 4,
            summary: "s".into(),
            summary_by: SummaryBy::Rules,
            connection_id: Some(Uuid::from_u128(7)),
            database: Some("shop".into()),
            kinds: vec![ItemKind::Question],
            before: 900,
            after: 80,
            at: 99,
            undone: false,
            record: Default::default(),
        };
        s.add_compaction(&c).unwrap();
        assert_eq!(s.compactions(t.id).unwrap(), vec![c.clone()]);
        assert!(s.undo_compaction(t.id, c.id).unwrap());
        assert!(!s.undo_compaction(t.id, c.id).unwrap());
        assert!(!s.undo_compaction(t.id, Uuid::new_v4()).unwrap());
        assert!(s.compactions(t.id).unwrap()[0].undone);
    }
}
