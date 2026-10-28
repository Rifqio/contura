//! The Topic and compaction tables of the app store.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension, params};

use super::{
    Compaction, CompactionId, LAST_WORK_SQL_BYTES, LastWork, SummaryBy, ThreadStore, ThreadSummary,
    TitleBy, Topic, WorkInput, WorkTag, rule_summary, topic_title,
};
use crate::ai::request::ItemKind;
use crate::ai::{AiAccess, AiMessage, AiRole, AiThread, ThreadId};
use crate::error::{Error, Result};
use crate::model::ConnectionId;
use crate::store::{AppStore, THREAD_LIST_INDEX};

/// The most question text one Topic keeps in its search row.
const QUESTIONS_BYTES: usize = 2048;
/// Of those, the chat's first questions keep this many; the newest fill the rest.
const QUESTIONS_HEAD_BYTES: usize = 512;

/// Weights for `thread_id seq place title summary tables questions`.
const BM25: &str = "bm25(ai_topic_fts, 0, 0, 0, 10.0, 4.0, 6.0, 0)";

fn store_err(e: impl std::fmt::Display) -> Error {
    Error::Store(e.to_string())
}

fn json<T: serde::Serialize>(v: &T) -> Result<String> {
    serde_json::to_string(v).map_err(store_err)
}

pub(crate) fn cut_bytes(mut s: String, max: usize) -> String {
    if s.len() > max {
        let mut end = max;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
    }
    s
}

/// `s` in at most `max` bytes: when it is longer, its first `QUESTIONS_HEAD_BYTES` and its
/// newest end, joined by a line break, each cut on a char boundary (final review I1: under
/// one conversation a Topic is the whole chat, so its newest questions must stay findable).
fn head_and_tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut head = QUESTIONS_HEAD_BYTES.min(max / 2);
    while !s.is_char_boundary(head) {
        head -= 1;
    }
    let mut tail = s.len() - (max - head - 1);
    while !s.is_char_boundary(tail) {
        tail += 1;
    }
    format!("{}\n{}", &s[..head], &s[tail..])
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
                    database, kinds, before_tokens, after_tokens, at, undone, record, covers
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
                r.get::<_, Option<String>>(15)?,
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
            covers,
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
            // Unreadable is unknown: the gate then fails closed, as for an old compaction.
            covers: covers.and_then(|c| serde_json::from_str(&c).ok()),
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
            connection_id, database, kinds, before_tokens, after_tokens, at, undone, record,
            covers)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
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
            c.covers.as_ref().map(json).transpose()?,
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

/// The columns a `ThreadSummary` is read from, `ai_threads` only (never `json`).
const SUMMARY_COLUMNS: &str = "id, place, title, title_by, updated_at, messages, work,
     (SELECT COUNT(*) FROM ai_topic WHERE thread_id = ai_threads.id)";

/// The statement `list_summaries` runs: `?1` the place, `?2` the limit.
pub fn list_sql() -> String {
    format!(
        "SELECT {SUMMARY_COLUMNS} FROM ai_threads INDEXED BY {THREAD_LIST_INDEX}
         WHERE place = ?1 ORDER BY updated_at DESC, id LIMIT ?2"
    )
}

/// The statement `summary` runs: `?1` the thread id.
pub fn summary_sql() -> String {
    format!(
        "SELECT {SUMMARY_COLUMNS} FROM ai_threads INDEXED BY {THREAD_LIST_INDEX}
         WHERE place = (SELECT place FROM ai_threads WHERE id = ?1) AND id = ?1"
    )
}

/// The statement of `search_place`'s column pass for `terms` terms: `?1` the place, then
/// one `LIKE` pattern per term.
pub fn search_like_sql(terms: usize) -> String {
    let fields = [
        "title",
        "json_extract(CASE WHEN json_valid(work) THEN work END, '$.database')",
        "json_extract(CASE WHEN json_valid(work) THEN work END, '$.table')",
    ];
    let mut wheres = Vec::new();
    for n in 2..terms + 2 {
        for f in fields {
            wheres.push(format!("{f} LIKE ?{n} ESCAPE '\\'"));
        }
    }
    format!(
        "SELECT id FROM ai_threads INDEXED BY {THREAD_LIST_INDEX}
         WHERE place = ?1 AND ({})
         ORDER BY updated_at DESC, id",
        wheres.join(" OR ")
    )
}

fn summary_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<(String, ThreadSummary)> {
    let work: Option<String> = r.get(6)?;
    Ok((
        r.get(0)?,
        ThreadSummary {
            id: ThreadId::nil(),
            place: r.get(1)?,
            title: r.get(2)?,
            title_by: TitleBy::from_column(&r.get::<_, String>(3)?),
            updated_at: r.get(4)?,
            messages: r.get(5)?,
            // A column that no longer reads shows no place.
            work: work.and_then(|w| serde_json::from_str::<WorkTag>(&w).ok()),
            topics: r.get(7)?,
        },
    ))
}

fn with_id((id, s): (String, ThreadSummary)) -> Result<ThreadSummary> {
    Ok(ThreadSummary {
        id: id.parse().map_err(store_err)?,
        ..s
    })
}

/// The place's threads without their messages, newest first, at most `limit`, from the
/// `ai_threads` columns only: no thread's JSON is read.
pub fn list_summaries(conn: &Connection, place: &str, limit: i64) -> Result<Vec<ThreadSummary>> {
    // The covering index: the row's columns after `json` are never read from the table.
    let mut stmt = conn.prepare(&list_sql()).map_err(store_err)?;
    let rows = stmt
        .query_map(params![place, limit], summary_row)
        .map_err(store_err)?;
    rows.map(|r| with_id(r.map_err(store_err)?)).collect()
}

/// One thread as the list shows it, from the covering index; `None` when it is gone.
pub fn summary(conn: &Connection, id: ThreadId) -> Result<Option<ThreadSummary>> {
    conn.query_row(&summary_sql(), params![id.to_string()], summary_row)
        .optional()
        .map_err(store_err)?
        .map(with_id)
        .transpose()
}

/// `term` as a `LIKE` pattern that matches it anywhere, with `%`, `_` and the backslash
/// read as written.
fn like_pattern(term: &str) -> String {
    let mut out = String::from("%");
    for c in term.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// The place's chats that hold one of `terms`, as summaries, at most `limit`, each once:
/// first those whose Topic search row matches (questions, tables, Topic titles; best
/// first), then those whose title, or the database or table they last worked in, holds a
/// term (newest first; `LIKE` folds the case of ASCII letters only). Each term is quoted for the Topic search and
/// escaped for `LIKE`, so its syntax is read as words. Columns only: no thread's JSON.
pub fn search_place(
    conn: &Connection,
    place: &str,
    terms: &[String],
    limit: usize,
) -> Result<Vec<ThreadSummary>> {
    let terms: Vec<&str> = terms
        .iter()
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .collect();
    if terms.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let mut ids: Vec<String> = Vec::new();
    let query = terms
        .iter()
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ");
    {
        // Best Topic first; a thread is taken at its best Topic.
        let mut stmt = conn
            .prepare(&format!(
                "SELECT f.thread_id FROM ai_topic_fts f
                 JOIN ai_threads th ON th.id = f.thread_id AND th.place = ?2
                 WHERE ai_topic_fts MATCH ?1 AND f.place = ?2
                 ORDER BY {BM25}, f.thread_id, f.seq"
            ))
            .map_err(store_err)?;
        let rows = stmt
            .query_map(params![query, place], |r| r.get::<_, String>(0))
            .map_err(store_err)?;
        for id in rows {
            let id = id.map_err(store_err)?;
            if ids.len() >= limit {
                break;
            }
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    if ids.len() < limit {
        // A `work` that no longer reads matches nothing rather than failing the search.
        let mut args: Vec<String> = vec![place.to_string()];
        args.extend(terms.iter().map(|t| like_pattern(t)));
        let mut stmt = conn
            .prepare(&search_like_sql(terms.len()))
            .map_err(store_err)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(args.iter()), |r| {
                r.get::<_, String>(0)
            })
            .map_err(store_err)?;
        for id in rows {
            let id = id.map_err(store_err)?;
            if ids.len() >= limit {
                break;
            }
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    let mut out = Vec::new();
    for id in ids {
        if let Some(s) = summary(conn, id.parse().map_err(store_err)?)? {
            out.push(s);
        }
    }
    Ok(out)
}

/// Sets the stored thread's title and its source, in its JSON and its columns in one
/// statement, and leaves `updated_at` alone so the list keeps its order. False when the
/// thread is gone, or for an AI title over one the user gave.
pub fn set_thread_title(conn: &Connection, id: ThreadId, title: &str, by: TitleBy) -> Result<bool> {
    let n = conn
        .execute(
            "UPDATE ai_threads
             SET title = ?2, title_by = ?3,
                 json = CASE WHEN json_valid(json)
                        THEN json_set(json, '$.title', ?2, '$.titleBy', ?3) ELSE json END
             WHERE id = ?1 AND NOT (?3 = 'ai' AND title_by = 'user')",
            params![id.to_string(), title, by.to_column()],
        )
        .map_err(store_err)?;
    Ok(n > 0)
}

/// Counts one failed AI title call in the thread's JSON (`titleTries`, at most 255) and
/// returns the count; 0 when the thread is gone. `updated_at` and the columns stay.
pub fn title_failed(conn: &Connection, id: ThreadId) -> Result<u8> {
    let tries: Option<i64> = conn
        .query_row(
            "UPDATE ai_threads
             SET json = json_set(json, '$.titleTries',
                        MIN(COALESCE(json_extract(json, '$.titleTries'), 0) + 1, 255))
             WHERE id = ?1 AND json_valid(json)
             RETURNING json_extract(json, '$.titleTries')",
            params![id.to_string()],
            |r| r.get(0),
        )
        .optional()
        .map_err(store_err)?;
    Ok(tries.map_or(0, |n| u8::try_from(n).unwrap_or(u8::MAX)))
}

/// Writes the title call's record and log lines into the record of the answer at
/// `answer_at`, in one immediate transaction so a turn stored meanwhile is never lost. The
/// record is held to its caps; no column changes. Nothing is written when the thread or
/// the answer is gone.
pub fn record_title_call(
    conn: &Connection,
    id: ThreadId,
    answer_at: i64,
    sent: Option<&crate::ai::sent::SummarySent>,
    log: &[crate::ai::log::LogLine],
) -> Result<()> {
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
        .map_err(store_err)?;
    let Some(mut t) = thread(&tx, id)? else {
        return Ok(());
    };
    let Some(answer) = t
        .messages
        .iter_mut()
        .find(|m| m.role == AiRole::Assistant && m.at == answer_at)
    else {
        return Ok(());
    };
    let mut record = answer.record.take().unwrap_or_default();
    if let Some(sent) = sent {
        record.sent.get_or_insert_with(Default::default).title = Some(sent.clone());
    }
    record.log.extend(log.iter().cloned());
    answer.record = Some(record.capped());
    let json = serde_json::to_string(&t).map_err(store_err)?;
    tx.execute(
        "UPDATE ai_threads SET json = ?2 WHERE id = ?1",
        params![id.to_string(), json],
    )
    .map_err(store_err)?;
    tx.commit().map_err(store_err)
}

/// The SQL of the answer's last checked block (`record.sql_blocks`): the body of that
/// fence in the answer's text, cut to `LAST_WORK_SQL_BYTES`. `None` when the answer
/// checked none or the fence is not there.
pub fn last_ai_sql(answer: &AiMessage) -> Option<String> {
    let block = answer.record.as_ref()?.sql_blocks.last()?;
    let fence = crate::ai::rails::output::fences(&answer.text)
        .into_iter()
        .nth(usize::try_from(block.fence).ok()?)?;
    let body = fence.body.trim();
    (!body.is_empty()).then(|| cut_bytes(body.to_string(), LAST_WORK_SQL_BYTES))
}

impl LastWork {
    /// Where the thread last worked by its newest answer with SQL (Decision 4a): that SQL,
    /// the turn's stamp (Connection, database, its first table) and the tab its question
    /// was asked in. `None` when no answer holds SQL. For threads saved before D2.
    pub fn derive(thread: &AiThread) -> Option<LastWork> {
        let at = thread
            .messages
            .iter()
            .rposition(|m| m.role == AiRole::Assistant && last_ai_sql(m).is_some())?;
        Self::of_answer(&thread.messages, at)
    }

    /// Where the answer at `at` of `messages` worked (Decision 4a); `None` when it holds no
    /// SQL.
    fn of_answer(messages: &[AiMessage], at: usize) -> Option<LastWork> {
        let answer = messages.get(at).filter(|m| m.role == AiRole::Assistant)?;
        let ai_sql = last_ai_sql(answer)?;
        let asked = messages[..at]
            .iter()
            .rev()
            .find(|m| m.role == AiRole::User)
            .and_then(|q| q.asked_in.as_ref());
        Some(
            LastWork {
                tab_kind: asked.map(|a| a.tab.clone()).unwrap_or_default(),
                tab_key: asked.and_then(|a| a.tab_key.clone()),
                tab_label: asked.map(|a| a.label.clone()).filter(|l| !l.is_empty()),
                connection_id: answer.connection_id,
                database: answer.database.clone(),
                table: answer.tables.first().cloned(),
                inserted_sql: None,
                ai_sql: Some(ai_sql),
                at: answer.at,
                inserted_from: None,
                ai_from: Some(answer.at),
            }
            .capped(),
        )
    }

    /// `prev` after the answer at `at` of `messages` arrived: an answer with SQL sets the
    /// AI SQL, the place and the tab (Decision 4a); the SQL the user inserted stays while
    /// the answer is on the same Connection and database, and goes with the old place
    /// otherwise (4c, P12). An answer without SQL changes nothing.
    pub fn after_answer(
        prev: Option<LastWork>,
        messages: &[AiMessage],
        at: usize,
    ) -> Option<LastWork> {
        let Some(mut next) = Self::of_answer(messages, at) else {
            return prev;
        };
        if let Some(p) = prev
            && p.connection_id == next.connection_id
            && p.database == next.database
        {
            next.inserted_sql = p.inserted_sql;
            next.inserted_from = p.inserted_from;
        }
        Some(next)
    }

    /// `prev` after a Retry removed messages: SQL whose answer lies in the removed span
    /// (`removed(at)`) goes with it. A source that only fell off the front of the thread
    /// (`MESSAGE_LIMIT`), or was never named, keeps its SQL: `last_work` holds the SQL
    /// itself. A removed AI SQL falls back to the newest kept answer with SQL on the same
    /// place as a kept insert, or, with no insert, to the newest kept answer with SQL. A
    /// removed insert falls back to the newest kept answer the user inserted or opened (its
    /// SQL), with the newest kept AI SQL beside it when on the same place (P12); else none.
    pub fn after_cut(
        prev: Option<LastWork>,
        messages: &[AiMessage],
        removed: impl Fn(i64) -> bool,
    ) -> Option<LastWork> {
        let p = prev?;
        let gone =
            |sql: &Option<String>, at: Option<i64>| sql.is_some() && at.is_some_and(&removed);
        let insert_gone = gone(&p.inserted_sql, p.inserted_from);
        let ai_gone = gone(&p.ai_sql, p.ai_from);
        if !insert_gone && !ai_gone {
            return Some(p);
        }
        let same = |a: &LastWork, b: &LastWork| {
            a.connection_id == b.connection_id && a.database == b.database
        };
        let ai_at = messages
            .iter()
            .rposition(|m| m.role == AiRole::Assistant && last_ai_sql(m).is_some());
        let base = ai_at.and_then(|i| Self::of_answer(messages, i));
        if !insert_gone && p.inserted_sql.is_some() {
            // Only the AI SQL went: the insert, its tab and place stay.
            let mut out = p;
            let (ai_sql, ai_from) = base
                .filter(|b| same(b, &out))
                .map_or((None, None), |b| (b.ai_sql, b.ai_from));
            out.ai_sql = ai_sql;
            out.ai_from = ai_from;
            return Some(out.capped());
        }
        // The newest kept answer inserted or opened.
        let inserted = messages
            .iter()
            .rposition(|m| {
                m.role == AiRole::Assistant
                    && last_ai_sql(m).is_some()
                    && m.record.as_ref().is_some_and(|r| !r.actions.is_empty())
            })
            .and_then(|i| Some((i, Self::of_answer(messages, i)?)));
        let out = match (base, inserted) {
            (None, None) => return None,
            (Some(b), None) => b,
            (b, Some((i, w))) => {
                let mut w = w;
                w.inserted_sql = w.ai_sql.clone();
                w.inserted_from = w.ai_from;
                let newer = ai_at.is_none_or(|a| i >= a);
                match b {
                    Some(mut b) if !newer => {
                        if same(&b, &w) {
                            b.inserted_sql = w.inserted_sql;
                            b.inserted_from = w.inserted_from;
                        }
                        b
                    }
                    b => {
                        let (ai_sql, ai_from) = b
                            .filter(|b| same(b, &w))
                            .map_or((None, None), |b| (b.ai_sql, b.ai_from));
                        w.ai_sql = ai_sql;
                        w.ai_from = ai_from;
                        w
                    }
                }
            }
        };
        Some(out.capped())
    }

    /// `prev` after the user put an answer's SQL into a tab (Insert, Insert commented out,
    /// Open in new tab; Decision 4b): the tab, the place and the inserted SQL. The table
    /// and the AI SQL stay while the place does.
    pub fn after_insert(
        prev: Option<LastWork>,
        work: WorkInput,
        message_at: i64,
        at: i64,
    ) -> LastWork {
        let (table, ai_sql, ai_from) = prev
            .filter(|p| p.connection_id == work.connection_id && p.database == work.database)
            .map_or((None, None, None), |p| (p.table, p.ai_sql, p.ai_from));
        LastWork {
            tab_kind: work.tab_kind,
            tab_key: work.tab_key,
            tab_label: work.tab_label.filter(|l| !l.is_empty()),
            connection_id: work.connection_id,
            database: work.database,
            table,
            inserted_sql: Some(work.sql).filter(|s| !s.trim().is_empty()),
            ai_sql,
            at,
            inserted_from: Some(message_at),
            ai_from,
        }
        .capped()
    }

    /// The copy a resume may read under the AI access gate: no SQL for a chat whose
    /// Connection is at Never now (`access` says Never for one that is gone) or that has
    /// no Connection (Home).
    pub fn gated(self, access: impl Fn(ConnectionId) -> AiAccess) -> LastWork {
        match self.connection_id {
            Some(id) if access(id) != AiAccess::Never => self,
            _ => self.without_sql(),
        }
    }
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
        let questions = head_and_tail(
            &g.messages
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
    fn set_title(&self, t: ThreadId, title: &str, by: TitleBy) -> Result<bool> {
        set_thread_title(self.lock()?.conn(), t, title, by)
    }
    fn title_failed(&self, t: ThreadId) -> Result<u8> {
        title_failed(self.lock()?.conn(), t)
    }
    fn record_title_call(
        &self,
        t: ThreadId,
        answer_at: i64,
        sent: Option<&crate::ai::sent::SummarySent>,
        log: &[crate::ai::log::LogLine],
    ) -> Result<()> {
        record_title_call(self.lock()?.conn(), t, answer_at, sent, log)
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
            title_by: Default::default(),
            title_tries: 0,
            last_work: None,
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

    /// I1 (final review): under one conversation the open Topic is the whole chat, so its
    /// search row keeps the newest questions as well as the first, in the same budget.
    #[test]
    fn search_finds_a_late_question_of_a_long_chat() {
        let s = open();
        let mut m = Vec::new();
        for i in 1..=100i64 {
            m.extend(turn(
                1,
                i * 10,
                &format!("question {i} about the q{i}x column of the orders ledger"),
                &[],
            ));
        }
        let t = thread_of(m);
        s.save_thread(&t).unwrap();
        let store = s.lock().unwrap();
        let find = |w: &str| {
            search_place(store.conn(), "ungrouped", &[w.to_string()], 20)
                .unwrap()
                .into_iter()
                .map(|h| h.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(find("q100x"), [t.id]);
        assert_eq!(find("q99x"), [t.id]);
        assert_eq!(find("q1x"), [t.id]);
        let bytes: i64 = store
            .conn()
            .query_row(
                "SELECT length(CAST(questions AS BLOB)) FROM ai_topic_fts WHERE thread_id = ?1",
                params![t.id.to_string()],
                |r| r.get(0),
            )
            .unwrap();
        assert!(bytes as usize <= QUESTIONS_BYTES, "{bytes}");
    }

    #[test]
    fn head_and_tail_cuts_on_char_boundaries() {
        let s = "é".repeat(3000);
        let out = head_and_tail(&s, 2048);
        assert!(out.len() <= 2048);
        assert!(out.starts_with('é') && out.ends_with('é'));
        assert_eq!(head_and_tail("short", 2048), "short");
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

    /// Fix round 1: a compaction's cover is kept; one written without it reads as `None`.
    #[test]
    fn a_compaction_keeps_its_cover() {
        let s = open();
        let t = two_topics();
        s.save_thread(&t).unwrap();
        let cover = crate::ai::memory::Cover {
            connection_id: Some(Uuid::from_u128(8)),
            database: Some("ledger".into()),
            kinds: vec![ItemKind::Question, ItemKind::Names],
            also: vec![Uuid::from_u128(9)],
            steps: vec![(Uuid::from_u128(10), crate::ai::AiAccess::Schema)],
        };
        let c = Compaction {
            id: Uuid::new_v4(),
            thread_id: t.id,
            topic: 1,
            first_at: 10,
            last_at: 21,
            messages: 4,
            summary: "s".into(),
            summary_by: SummaryBy::Rules,
            connection_id: None,
            database: None,
            kinds: vec![ItemKind::Question],
            before: 900,
            after: 80,
            at: 99,
            undone: false,
            record: Default::default(),
            covers: Some(vec![cover.clone()]),
        };
        s.add_compaction(&c).unwrap();
        let old = Compaction {
            id: Uuid::new_v4(),
            covers: None,
            ..c.clone()
        };
        s.add_compaction(&old).unwrap();
        let back = s.compactions(t.id).unwrap();
        let of = |id| back.iter().find(|x| x.id == id).unwrap().covers.clone();
        assert_eq!(of(c.id), Some(vec![cover]));
        assert_eq!(of(old.id), None);
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
            covers: None,
        };
        s.add_compaction(&c).unwrap();
        assert_eq!(s.compactions(t.id).unwrap(), vec![c.clone()]);
        assert!(s.undo_compaction(t.id, c.id).unwrap());
        assert!(!s.undo_compaction(t.id, c.id).unwrap());
        assert!(!s.undo_compaction(t.id, Uuid::new_v4()).unwrap());
        assert!(s.compactions(t.id).unwrap()[0].undone);
    }
}
