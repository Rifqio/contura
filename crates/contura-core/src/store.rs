use crate::ai::{AiRole, AiThread, ThreadId, memory, tool_uses};
use crate::error::{Error, Result};
use crate::model::{ConnectionConfig, ConnectionId, Group, GroupId};
use crate::query::{
    HistoryEntry, HistoryFilter, HistoryOnly, NewHistory, Outcome, SavedQuery, SavedQueryKind,
    SavedQueryRun,
};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;

/// The `user_version` this build writes and understands.
const SCHEMA_VERSION: i64 = 8;

/// The covering index the chat list and search read (schema 8).
pub const THREAD_LIST_INDEX: &str = "ai_threads_list";

/// Chat threads returned per place.
pub const THREAD_LIMIT: i64 = 50;

/// Messages kept per chat thread.
pub const MESSAGE_LIMIT: usize = 200;

/// Query History kept per Connection.
pub const HISTORY_LIMIT: i64 = 1000;

/// Puts the stored title, its source, its tries and each answer's title call record (its
/// `sent.title` and its `title` log lines) on `t` when the thread is stored: a whole-thread
/// write never changes them (P3). Only the few answers that hold a title call are read.
fn keep_stored_title(conn: &Connection, id: &str, t: &mut AiThread) -> Result<()> {
    let stored: Option<(String, String, Option<i64>)> = conn
        .query_row(
            "SELECT CASE WHEN json_valid(json)
                         THEN COALESCE(json_extract(json, '$.title'), title) ELSE title END,
                    CASE WHEN json_valid(json)
                         THEN COALESCE(json_extract(json, '$.titleBy'), title_by) ELSE title_by END,
                    CASE WHEN json_valid(json) THEN json_extract(json, '$.titleTries') END
             FROM ai_threads WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(store_err)?;
    let Some((title, by, tries)) = stored else {
        return Ok(());
    };
    t.title = title;
    t.title_by = memory::TitleBy::from_column(&by);
    t.title_tries = tries.map_or(0, |n| u8::try_from(n).unwrap_or(u8::MAX));
    let mut stmt = conn
        .prepare(
            "SELECT json_extract(m.value, '$.at'),
                    json_extract(m.value, '$.record.sent.title'),
                    json_extract(m.value, '$.record.log')
             FROM ai_threads th, json_each(th.json, '$.messages') m
             WHERE th.id = ?1 AND json_valid(th.json)
               AND json_extract(m.value, '$.role') = 'assistant'
               AND (json_extract(m.value, '$.record.sent.title') IS NOT NULL
                    OR EXISTS (SELECT 1 FROM json_each(m.value, '$.record.log') l
                               WHERE json_extract(l.value, '$.source') = 'title'))",
        )
        .map_err(store_err)?;
    let rows = stmt
        .query_map(params![id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(store_err)?;
    for row in rows {
        let (at, sent, log) = row.map_err(store_err)?;
        let Some(m) = t
            .messages
            .iter_mut()
            .find(|m| m.role == AiRole::Assistant && m.at == at)
        else {
            continue;
        };
        let sent: Option<crate::ai::sent::SummarySent> =
            sent.and_then(|j| serde_json::from_str(&j).ok());
        let lines: Vec<crate::ai::log::LogLine> = log
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default();
        let record = m.record.get_or_insert_with(Default::default);
        if let Some(sent) = sent {
            let into = record.sent.get_or_insert_with(Default::default);
            if into.title.is_none() {
                into.title = Some(sent);
            } else if let Some(have) = into.title.as_mut()
                && have.exact.is_none()
            {
                have.exact = sent.exact;
            }
        }
        for line in lines.into_iter().filter(|l| l.source == "title") {
            if !record.log.contains(&line) {
                record.log.push(line);
            }
        }
    }
    Ok(())
}

fn store_err(e: impl std::fmt::Display) -> Error {
    Error::Store(e.to_string())
}

fn has_column(db: &Connection, table: &str, column: &str) -> Result<bool> {
    db.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
        params![table, column],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .map_err(store_err)
}

/// The `work` column of `t`: where it last worked without the SQL, derived from its
/// newest answer with SQL for a thread that has none kept (one saved before D2).
fn work_column(t: &AiThread) -> Result<Option<String>> {
    t.last_work
        .clone()
        .or_else(|| memory::LastWork::derive(t))
        .map(|w| serde_json::to_string(&w.without_sql()).map_err(store_err))
        .transpose()
}

/// Writes the list columns of the stored thread `id` from `t`.
fn write_thread_columns(db: &Connection, id: &str, t: &AiThread) -> Result<()> {
    db.execute(
        "UPDATE ai_threads SET title = ?2, title_by = ?3, work = ?4, messages = ?5 WHERE id = ?1",
        params![
            id,
            t.title,
            t.title_by.to_column(),
            work_column(t)?,
            t.messages.len() as i64
        ],
    )
    .map_err(store_err)?;
    Ok(())
}

/// The `settings` row of the first start guide: `show` in a data folder made by this start
/// (written with the tables), `seen` once it is closed. A data folder from before has no row,
/// so the guide never opens there on its own.
pub const FIRST_START_GUIDE_KEY: &str = "first_start_guide";

/// The store's files are for this OS user only (L1, security audit 1.0). A new file is
/// made 0600 before SQLite opens it, and SQLite gives the WAL, shared-memory and
/// journal files the mode of the database file. Files an older build left looser are
/// tightened on every open.
fn private_store_files(path: &Path) -> Result<()> {
    // Not a file: an in-memory store, or a URI SQLite parses itself.
    let raw = path.as_os_str();
    if raw.is_empty() || raw == ":memory:" || path.to_str().is_some_and(|p| p.starts_with("file:"))
    {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        if !path.exists() {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)
            {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(Error::Store(format!("cannot create the app store: {e}"))),
            }
        }
    }
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        crate::private::private_file(Path::new(&name));
    }
    Ok(())
}

/// SQLite store for Connections, Groups and settings. Passwords are never
/// stored here.
pub struct AppStore {
    db: Connection,
    /// Makes the next checkpoints fail, to test that a committed clear still succeeds.
    #[cfg(test)]
    fail_checkpoint: std::cell::Cell<bool>,
}

impl AppStore {
    pub fn open(path: &Path) -> Result<AppStore> {
        private_store_files(path)?;
        let db = Connection::open(path).map_err(store_err)?;
        // A safety net behind the single-instance guard: wait for a lock instead of failing.
        db.busy_timeout(std::time::Duration::from_millis(5000))
            .map_err(store_err)?;
        db.pragma_update(None, "journal_mode", "WAL")
            .map_err(store_err)?;
        // Deleted rows are overwritten, not left in free pages (L2, security audit 1.0).
        db.pragma_update(None, "secure_delete", "ON")
            .map_err(store_err)?;
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(store_err)?;
        if version > SCHEMA_VERSION {
            // Saving with this build would drop fields it does not know.
            return Err(Error::Store(
                "data folder was written by a newer Contura".into(),
            ));
        }
        if version == 0 {
            // A new data folder: the first start guide opens once (the key is a constant, never user text).
            db.execute_batch(&format!(
                "BEGIN;
                 CREATE TABLE connections (id TEXT PRIMARY KEY, config_json TEXT NOT NULL);
                 CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL);
                 CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO settings (key, value) VALUES ('{FIRST_START_GUIDE_KEY}', 'show');
                 PRAGMA user_version = 1;
                 COMMIT;"
            ))
            .map_err(store_err)?;
        }
        if version < 2 {
            db.execute_batch(
                "BEGIN;
                 CREATE TABLE query_history (
                   id INTEGER PRIMARY KEY, connection_id TEXT NOT NULL, sql TEXT NOT NULL,
                   ran_at_ms INTEGER NOT NULL, elapsed_ms INTEGER NOT NULL, outcome TEXT NOT NULL,
                   rows INTEGER, changed INTEGER NOT NULL, error TEXT);
                 CREATE INDEX query_history_by_connection ON query_history (connection_id, id DESC);
                 CREATE TABLE saved_queries (
                   id TEXT PRIMARY KEY, name TEXT NOT NULL, sql TEXT NOT NULL,
                   updated_at_ms INTEGER NOT NULL);
                 CREATE UNIQUE INDEX saved_queries_by_name ON saved_queries (name COLLATE NOCASE);
                 PRAGMA user_version = 2;
                 COMMIT;",
            )
            .map_err(store_err)?;
        }
        if version < 3 {
            db.execute_batch(
                "BEGIN;
                 CREATE TABLE ai_threads (
                   id TEXT PRIMARY KEY, place TEXT NOT NULL, json TEXT NOT NULL,
                   updated_at INTEGER NOT NULL);
                 CREATE INDEX ai_threads_by_place ON ai_threads (place, updated_at DESC);
                 PRAGMA user_version = 3;
                 COMMIT;",
            )
            .map_err(store_err)?;
        }
        if version < 4 {
            // Saved Visual Queries: rows from before read as SQL. The Connection a Saved Query
            // opens on stays in the settings map (D2).
            db.execute_batch(
                "BEGIN;
                 ALTER TABLE saved_queries ADD COLUMN kind TEXT NOT NULL DEFAULT 'sql';
                 ALTER TABLE saved_queries ADD COLUMN visual_json TEXT;
                 PRAGMA user_version = 4;
                 COMMIT;",
            )
            .map_err(store_err)?;
        }
        if version < 5 {
            // The AI Context. Text keys compare as written, so `Orders` and `orders` are
            // two tables.
            db.execute_batch(
                "BEGIN;
                 CREATE TABLE ai_context_meta (
                   connection_id TEXT, database TEXT, schema TEXT, fingerprint TEXT,
                   built_at INTEGER NOT NULL, checked_at INTEGER NOT NULL,
                   stale INTEGER NOT NULL DEFAULT 0, table_count INTEGER NOT NULL,
                   bytes INTEGER NOT NULL,
                   PRIMARY KEY (connection_id, database, schema));
                 CREATE TABLE ai_context_node (
                   connection_id TEXT, database TEXT, schema TEXT, node_id TEXT, parent_id TEXT,
                   kind TEXT NOT NULL, label TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                   tables TEXT NOT NULL DEFAULT '[]', tokens INTEGER NOT NULL,
                   PRIMARY KEY (connection_id, database, schema, node_id));
                 CREATE TABLE ai_context_card (
                   connection_id TEXT, database TEXT, schema TEXT, table_name TEXT,
                   card TEXT NOT NULL, card_rows TEXT NOT NULL DEFAULT '',
                   tokens INTEGER NOT NULL, rows_tokens INTEGER NOT NULL DEFAULT 0,
                   fk_out TEXT NOT NULL, fk_in TEXT NOT NULL,
                   PRIMARY KEY (connection_id, database, schema, table_name));
                 CREATE VIRTUAL TABLE ai_context_fts USING fts5(
                   connection_id UNINDEXED, database UNINDEXED, schema UNINDEXED,
                   node_id UNINDEXED, names, words, note,
                   tokenize = \"unicode61 tokenchars '_'\");
                 PRAGMA user_version = 5;
                 COMMIT;",
            )
            .map_err(store_err)?;
        }
        if version < 6 {
            // Conversation memory: a thread's Topics, their search rows and its compactions.
            db.execute_batch(
                "BEGIN;
                 CREATE TABLE ai_topic (
                   thread_id TEXT NOT NULL, seq INTEGER NOT NULL, place TEXT NOT NULL,
                   title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                   summary_by TEXT NOT NULL DEFAULT '', tables TEXT NOT NULL DEFAULT '[]',
                   connection_id TEXT, database TEXT, kinds TEXT NOT NULL DEFAULT '[]',
                   first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
                   messages INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0,
                   PRIMARY KEY (thread_id, seq));
                 CREATE VIRTUAL TABLE ai_topic_fts USING fts5(
                   thread_id UNINDEXED, seq UNINDEXED, place UNINDEXED,
                   title, summary, tables, questions,
                   tokenize = \"unicode61 tokenchars '_'\");
                 CREATE TABLE ai_compaction (
                   id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, topic INTEGER NOT NULL,
                   first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
                   messages INTEGER NOT NULL, summary TEXT NOT NULL, summary_by TEXT NOT NULL,
                   connection_id TEXT, database TEXT, kinds TEXT NOT NULL DEFAULT '[]',
                   before_tokens INTEGER NOT NULL, after_tokens INTEGER NOT NULL,
                   at INTEGER NOT NULL, undone INTEGER NOT NULL DEFAULT 0,
                   record TEXT NOT NULL DEFAULT '{}');
                 CREATE INDEX ai_compaction_by_thread ON ai_compaction (thread_id, at);
                 PRAGMA user_version = 6;
                 COMMIT;",
            )
            .map_err(store_err)?;
        }
        if version < 7 {
            // Recent tool uses: one row per answer that proposed diagram changes or picked
            // tables, filled once from the saved threads.
            let tx = db.unchecked_transaction().map_err(store_err)?;
            tx.execute_batch(
                "CREATE TABLE ai_tool_use (
                   thread_id TEXT NOT NULL, message_at INTEGER NOT NULL, at INTEGER NOT NULL,
                   tool TEXT NOT NULL, target TEXT NOT NULL, connection_id TEXT,
                   result TEXT NOT NULL,
                   PRIMARY KEY (thread_id, message_at));
                 CREATE INDEX ai_tool_use_by_at ON ai_tool_use (at);",
            )
            .map_err(store_err)?;
            let saved: Vec<String> = {
                let mut stmt = tx
                    .prepare("SELECT json FROM ai_threads")
                    .map_err(store_err)?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(store_err)?;
                rows.collect::<std::result::Result<_, _>>()
                    .map_err(store_err)?
            };
            for json in saved {
                // A thread that no longer reads has nothing to list.
                if let Ok(thread) = serde_json::from_str::<AiThread>(&json) {
                    tool_uses::sync_tool_uses(&tx, &thread)?;
                }
            }
            tx.execute_batch("PRAGMA user_version = 7")
                .map_err(store_err)?;
            tx.commit().map_err(store_err)?;
        }
        if version < 8 {
            // The chat record (D2): each thread's title, its source, where it last worked
            // (no SQL) and its message count as columns, so the list never reads the JSON,
            // filled once from the saved threads. And what a compaction's text covers
            // (D2 Task 2), which a build in between may have added in place already. Each
            // column is added only when missing.
            let tx = db.unchecked_transaction().map_err(store_err)?;
            for (table, column, ddl) in [
                ("ai_compaction", "covers", "TEXT"),
                ("ai_threads", "title", "TEXT NOT NULL DEFAULT ''"),
                ("ai_threads", "title_by", "TEXT NOT NULL DEFAULT 'rule'"),
                ("ai_threads", "work", "TEXT"),
                ("ai_threads", "messages", "INTEGER NOT NULL DEFAULT 0"),
            ] {
                if !has_column(&tx, table, column)? {
                    // The names are constants, never user text.
                    tx.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
                        .map_err(store_err)?;
                }
            }
            // One thread in memory at a time.
            let ids: Vec<String> = {
                let mut stmt = tx.prepare("SELECT id FROM ai_threads").map_err(store_err)?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(store_err)?;
                rows.collect::<std::result::Result<_, _>>()
                    .map_err(store_err)?
            };
            for id in ids {
                let json: String = tx
                    .query_row("SELECT json FROM ai_threads WHERE id = ?1", [&id], |r| {
                        r.get(0)
                    })
                    .map_err(store_err)?;
                match serde_json::from_str::<AiThread>(&json) {
                    Ok(thread) => write_thread_columns(&tx, &id, &thread)?,
                    // A thread that no longer reads as one keeps its title and count when
                    // its JSON still holds them, as the list showed it before.
                    Err(_) => {
                        tx.execute(
                            "UPDATE ai_threads
                             SET title = COALESCE(json_extract(json, '$.title'), ''),
                                 messages = COALESCE(json_array_length(json, '$.messages'), 0)
                             WHERE id = ?1 AND json_valid(json)",
                            [&id],
                        )
                        .map_err(store_err)?;
                    }
                }
            }
            // The list reads this index alone: the columns sit after `json` in the row, and
            // reading them from the table would walk each thread's JSON pages.
            tx.execute_batch(&format!(
                "CREATE INDEX IF NOT EXISTS {THREAD_LIST_INDEX} ON ai_threads
                   (place, updated_at DESC, id, title, title_by, messages, work)"
            ))
            .map_err(store_err)?;
            tx.execute_batch("PRAGMA user_version = 8")
                .map_err(store_err)?;
            tx.commit().map_err(store_err)?;
        }
        Ok(AppStore {
            db,
            #[cfg(test)]
            fail_checkpoint: std::cell::Cell::new(false),
        })
    }

    pub(crate) fn conn(&self) -> &Connection {
        &self.db
    }

    /// The page cache, as `PRAGMA cache_size = -<kib>`.
    pub fn set_cache_kib(&self, kib: u32) -> Result<()> {
        self.db
            .pragma_update(None, "cache_size", -i64::from(kib))
            .map_err(store_err)
    }

    /// Newest first, at most `THREAD_LIMIT`; older threads stay stored.
    pub fn list_ai_threads(&self, place: &str) -> Result<Vec<AiThread>> {
        let mut stmt = self
            .db
            .prepare(
                "SELECT json FROM ai_threads WHERE place = ?1
                 ORDER BY updated_at DESC LIMIT ?2",
            )
            .map_err(store_err)?;
        let rows = stmt
            .query_map(params![place, THREAD_LIMIT], |r| r.get::<_, String>(0))
            .map_err(store_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str(&row.map_err(store_err)?).map_err(store_err)?);
        }
        Ok(out)
    }

    /// The SQL statements of the answers of the place's newest `THREAD_LIMIT` threads, in
    /// the order `list_ai_threads` gives them (memory: SQLite reads only the checked
    /// statements from the JSON column; logs, thinking and message text are never built).
    pub fn ai_thread_statements(
        &self,
        place: &str,
    ) -> Result<Vec<crate::ai::rails::output::StatementCheck>> {
        // SQLite walks the JSON and hands back one statement object at a time (`json_tree`
        // over `$.messages`, keeping the objects under each record's `sqlBlocks[*].statements`),
        // so no thread is parsed whole and a field the typed shape rejects cannot fail the read.
        let mut stmt = self
            .db
            .prepare(
                "SELECT s.value
                 FROM (SELECT id, json, updated_at FROM ai_threads WHERE place = ?1
                       ORDER BY updated_at DESC LIMIT ?2) t,
                      json_tree(t.json, '$.messages') s
                 WHERE s.type = 'object'
                   AND s.path GLOB '$.messages[[]*].record.sqlBlocks[[]*].statements'
                 ORDER BY t.updated_at DESC, t.id, s.id",
            )
            .map_err(store_err)?;
        let rows = stmt
            .query_map(params![place, THREAD_LIMIT], |r| r.get::<_, String>(0))
            .map_err(store_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str(&row.map_err(store_err)?).map_err(store_err)?);
        }
        Ok(out)
    }

    pub fn get_ai_thread(&self, id: ThreadId) -> Result<Option<AiThread>> {
        let json: Option<String> = self
            .db
            .query_row(
                "SELECT json FROM ai_threads WHERE id = ?1",
                params![id.to_string()],
                |r| r.get(0),
            )
            .optional()
            .map_err(store_err)?;
        json.map(|j| serde_json::from_str(&j).map_err(store_err))
            .transpose()
    }

    /// Saves the thread in one transaction: keeps its newest `MESSAGE_LIMIT` messages
    /// (whole turns, so the first kept is not an answer), drops compactions whose range
    /// is gone, rebuilds its Topics, then drops the place's threads beyond the newest
    /// `THREAD_LIMIT` with their Topics and compactions.
    pub fn save_ai_thread(&self, t: &AiThread) -> Result<()> {
        self.write_ai_thread(t.clone()).map(|_| ())
    }

    /// As `save_ai_thread`, taking the thread and handing back what was written (its
    /// newest `MESSAGE_LIMIT` messages), so a caller can answer without reading it again.
    ///
    /// A whole-thread write never changes a stored thread's title, its source, its tries or
    /// the title call's record (P3): only `set_thread_title`, `title_failed` and
    /// `record_title_call` do. The stored ones are read in the same immediate transaction
    /// as the write, so a rename or an AI title committed after the caller read the thread
    /// is never written back over.
    pub fn write_ai_thread(&self, mut t: AiThread) -> Result<AiThread> {
        let trimmed = t.messages.len() > MESSAGE_LIMIT;
        if trimmed {
            let mut start = t.messages.len() - MESSAGE_LIMIT;
            while start < t.messages.len() && t.messages[start].role != AiRole::User {
                start += 1;
            }
            t.messages.drain(..start);
        }
        t.last_work = t.last_work.take().map(memory::LastWork::capped);
        let id = t.id.to_string();
        let tx = rusqlite::Transaction::new_unchecked(
            &self.db,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(store_err)?;
        keep_stored_title(&tx, &id, &mut t)?;
        let json = serde_json::to_string(&t).map_err(store_err)?;
        // The list columns follow the thread they are written with.
        tx.execute(
            "INSERT OR REPLACE INTO ai_threads
               (id, place, json, updated_at, title, title_by, work, messages)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                t.place,
                json,
                t.updated_at,
                t.title,
                t.title_by.to_column(),
                work_column(&t)?,
                t.messages.len() as i64
            ],
        )
        .map_err(store_err)?;
        if trimmed {
            // Every compaction ends before the oldest message kept.
            let oldest = t.messages.iter().map(|m| m.at).min().unwrap_or(i64::MAX);
            tx.execute(
                "DELETE FROM ai_compaction WHERE thread_id = ?1 AND last_at < ?2",
                params![id, oldest],
            )
            .map_err(store_err)?;
        }
        memory::store::sync_topics(&tx, &t)?;
        tool_uses::sync_tool_uses(&tx, &t)?;
        let old: Vec<String> = {
            let mut stmt = tx
                .prepare(
                    "SELECT id FROM ai_threads WHERE place = ?1
                     ORDER BY updated_at DESC, id LIMIT -1 OFFSET ?2",
                )
                .map_err(store_err)?;
            let rows = stmt
                .query_map(params![t.place, THREAD_LIMIT], |r| r.get::<_, String>(0))
                .map_err(store_err)?;
            rows.collect::<std::result::Result<_, _>>()
                .map_err(store_err)?
        };
        memory::store::delete_for_threads(&tx, &old)?;
        tool_uses::delete_for_threads(&tx, &old)?;
        for old_id in &old {
            tx.execute("DELETE FROM ai_threads WHERE id = ?1", params![old_id])
                .map_err(store_err)?;
        }
        tx.commit().map_err(store_err)?;
        Ok(t)
    }

    /// The ids of the threads of every place whose stored JSON holds `needle` or `or`: a
    /// cheap filter, so only those threads are read and parsed.
    pub fn ai_threads_holding(&self, needle: &str, or: &str) -> Result<Vec<ThreadId>> {
        let mut stmt = self
            .db
            .prepare("SELECT id FROM ai_threads WHERE instr(json, ?1) > 0 OR instr(json, ?2) > 0")
            .map_err(store_err)?;
        let rows = stmt
            .query_map(params![needle, or], |r| r.get::<_, String>(0))
            .map_err(store_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(ThreadId::parse_str(&row.map_err(store_err)?).map_err(store_err)?);
        }
        Ok(out)
    }

    pub fn delete_ai_thread(&self, id: ThreadId) -> Result<()> {
        let tx = self.db.unchecked_transaction().map_err(store_err)?;
        memory::store::delete_for_threads(&tx, &[id.to_string()])?;
        tool_uses::delete_for_threads(&tx, &[id.to_string()])?;
        tx.execute(
            "DELETE FROM ai_threads WHERE id = ?1",
            params![id.to_string()],
        )
        .map_err(store_err)?;
        tx.commit().map_err(store_err)?;
        // As the clears: the deleted chat's text leaves the WAL too (final review I2).
        self.checkpoint();
        Ok(())
    }

    /// Copies the WAL into app.sqlite and empties it, after a clear: with secure_delete
    /// the deleted text is then gone from both files (L2, security audit 1.0). Readers on
    /// other connections can hold part of the WAL back; that part goes at the next
    /// checkpoint, so a busy result is not an error. Best effort: the delete before it has
    /// committed, so a failure is logged and the clear still succeeds.
    pub fn checkpoint(&self) {
        if let Err(e) = self.try_checkpoint() {
            eprintln!("app store: the WAL checkpoint after a clear failed: {e}");
        }
    }

    fn try_checkpoint(&self) -> Result<()> {
        #[cfg(test)]
        if self.fail_checkpoint.get() {
            return Err(Error::Store("disk I/O error".into()));
        }
        self.db
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
            .map_err(store_err)
    }

    pub fn clear_ai_threads(&self, place: &str) -> Result<()> {
        // Immediate, as `write_ai_thread`: a title write committed on the other connection
        // between the read and the delete would otherwise fail the clear (final review M3).
        let tx = rusqlite::Transaction::new_unchecked(
            &self.db,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(store_err)?;
        let ids: Vec<String> = {
            let mut stmt = tx
                .prepare("SELECT id FROM ai_threads WHERE place = ?1")
                .map_err(store_err)?;
            let rows = stmt
                .query_map(params![place], |r| r.get::<_, String>(0))
                .map_err(store_err)?;
            rows.collect::<std::result::Result<_, _>>()
                .map_err(store_err)?
        };
        memory::store::delete_for_threads(&tx, &ids)?;
        tool_uses::delete_for_threads(&tx, &ids)?;
        tx.execute("DELETE FROM ai_threads WHERE place = ?1", params![place])
            .map_err(store_err)?;
        tx.commit().map_err(store_err)?;
        self.checkpoint();
        Ok(())
    }

    /// The places that hold a board's chats (`diagram:<name>`), in name order.
    pub fn diagram_ai_places(&self) -> Result<Vec<String>> {
        let mut stmt = self
            .db
            .prepare(
                "SELECT DISTINCT place FROM ai_threads \
                 WHERE substr(place, 1, 8) = 'diagram:' ORDER BY place",
            )
            .map_err(store_err)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(store_err)?;
        rows.collect::<std::result::Result<_, _>>()
            .map_err(store_err)
    }

    /// Moves every chat of place `from` to place `to` (a board's rename, A14), in one
    /// immediate transaction: the `place` column and the `place` inside each thread's JSON,
    /// the Topics, their search rows (deleted and inserted again), and the tool-use rows
    /// that targeted `<from>.flow`. Titles, messages and saved records stay as they were;
    /// nothing is left under `from`. A `to` that already holds chats keeps its newest
    /// `THREAD_LIMIT`, the older ones going with their rows. Returns how many chats moved.
    pub fn move_ai_place(&self, from: &str, to: &str) -> Result<usize> {
        if from == to {
            return Ok(0);
        }
        let tx = rusqlite::Transaction::new_unchecked(
            &self.db,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(store_err)?;
        let moved = tx
            .execute(
                "UPDATE ai_threads SET place = ?2, json = json_set(json, '$.place', ?2)
                 WHERE place = ?1",
                params![from, to],
            )
            .map_err(store_err)?;
        if moved == 0 {
            return Ok(0);
        }
        tx.execute(
            "UPDATE ai_topic SET place = ?2 WHERE place = ?1",
            params![from, to],
        )
        .map_err(store_err)?;
        type FtsRow = (String, i64, String, String, String, String);
        let fts: Vec<FtsRow> = {
            let mut stmt = tx
                .prepare(
                    "SELECT thread_id, seq, title, summary, tables, questions
                     FROM ai_topic_fts WHERE place = ?1",
                )
                .map_err(store_err)?;
            let rows = stmt
                .query_map(params![from], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                })
                .map_err(store_err)?;
            rows.collect::<std::result::Result<_, _>>()
                .map_err(store_err)?
        };
        tx.execute("DELETE FROM ai_topic_fts WHERE place = ?1", params![from])
            .map_err(store_err)?;
        for (thread_id, seq, title, summary, tables, questions) in fts {
            tx.execute(
                "INSERT INTO ai_topic_fts
                   (thread_id, seq, place, title, summary, tables, questions)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![thread_id, seq, to, title, summary, tables, questions],
            )
            .map_err(store_err)?;
        }
        if let (Some(old), Some(new)) = (from.strip_prefix("diagram:"), to.strip_prefix("diagram:"))
        {
            tx.execute(
                "UPDATE ai_tool_use SET target = ?2
                 WHERE target = ?1 AND thread_id IN (SELECT id FROM ai_threads WHERE place = ?3)",
                params![format!("{old}.flow"), format!("{new}.flow"), to],
            )
            .map_err(store_err)?;
        }
        let over: Vec<String> = {
            let mut stmt = tx
                .prepare(
                    "SELECT id FROM ai_threads WHERE place = ?1
                     ORDER BY updated_at DESC, id LIMIT -1 OFFSET ?2",
                )
                .map_err(store_err)?;
            let rows = stmt
                .query_map(params![to, THREAD_LIMIT], |r| r.get::<_, String>(0))
                .map_err(store_err)?;
            rows.collect::<std::result::Result<_, _>>()
                .map_err(store_err)?
        };
        memory::store::delete_for_threads(&tx, &over)?;
        tool_uses::delete_for_threads(&tx, &over)?;
        for id in &over {
            tx.execute("DELETE FROM ai_threads WHERE id = ?1", params![id])
                .map_err(store_err)?;
        }
        tx.commit().map_err(store_err)?;
        // The old place name and any trimmed chat leave the WAL, as after a clear.
        self.checkpoint();
        Ok(moved)
    }

    /// Every thread of every place.
    pub fn clear_all_ai_threads(&self) -> Result<()> {
        let tx = self.db.unchecked_transaction().map_err(store_err)?;
        for sql in [
            "DELETE FROM ai_topic",
            "DELETE FROM ai_topic_fts",
            "DELETE FROM ai_compaction",
            "DELETE FROM ai_tool_use",
            "DELETE FROM ai_threads",
        ] {
            tx.execute(sql, []).map_err(store_err)?;
        }
        tx.commit().map_err(store_err)?;
        self.checkpoint();
        Ok(())
    }

    /// Adds a Query History row and keeps only that Connection's newest `HISTORY_LIMIT`.
    pub fn add_history(&self, e: &NewHistory) -> Result<()> {
        let conn = e.connection_id.to_string();
        let tx = self.db.unchecked_transaction().map_err(store_err)?;
        tx.execute(
            "INSERT INTO query_history
               (connection_id, sql, ran_at_ms, elapsed_ms, outcome, rows, changed, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                conn,
                e.sql,
                e.ran_at_ms,
                e.elapsed_ms as i64,
                e.outcome.as_str(),
                e.rows.map(|r| r as i64),
                e.changed,
                e.error
            ],
        )
        .map_err(store_err)?;
        tx.execute(
            "DELETE FROM query_history WHERE connection_id = ?1 AND id NOT IN
               (SELECT id FROM query_history WHERE connection_id = ?1 ORDER BY id DESC LIMIT ?2)",
            params![conn, HISTORY_LIMIT],
        )
        .map_err(store_err)?;
        tx.commit().map_err(store_err)
    }

    /// Newest first. `search` matches anywhere in the SQL, ignoring case.
    /// `None` lists every Connection's rows together.
    pub fn query_history(
        &self,
        conn: Option<ConnectionId>,
        f: &HistoryFilter,
    ) -> Result<Vec<HistoryEntry>> {
        let only = match f.only {
            None => "",
            Some(HistoryOnly::Failed) => " AND outcome <> 'ok'",
            Some(HistoryOnly::Changes) => " AND outcome = 'ok' AND changed = 1",
        };
        let pattern = f
            .search
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| {
                format!(
                    "%{}%",
                    s.replace('\\', "\\\\")
                        .replace('%', "\\%")
                        .replace('_', "\\_")
                )
            });
        let sql = format!(
            "SELECT id, sql, ran_at_ms, elapsed_ms, outcome, rows, changed, error, connection_id
             FROM query_history
             WHERE (?1 IS NULL OR connection_id = ?1) AND (?2 IS NULL OR sql LIKE ?2 ESCAPE '\\'){only}
             ORDER BY id DESC LIMIT ?3"
        );
        let mut stmt = self.db.prepare(&sql).map_err(store_err)?;
        let rows = stmt
            .query_map(
                params![conn.map(|c| c.to_string()), pattern, HISTORY_LIMIT],
                |r| {
                    let owner: String = r.get(8)?;
                    Ok(HistoryEntry {
                        id: r.get(0)?,
                        connection_id: owner.parse().map_err(|e| {
                            rusqlite::Error::FromSqlConversionFailure(
                                8,
                                rusqlite::types::Type::Text,
                                Box::new(e),
                            )
                        })?,
                        sql: r.get(1)?,
                        ran_at_ms: r.get(2)?,
                        elapsed_ms: r.get::<_, i64>(3)? as u64,
                        outcome: Outcome::parse(&r.get::<_, String>(4)?).unwrap_or(Outcome::Error),
                        rows: r.get::<_, Option<i64>>(5)?.map(|n| n as u64),
                        changed: r.get(6)?,
                        error: r.get(7)?,
                    })
                },
            )
            .map_err(store_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(store_err)
    }

    /// Removes rows that ran before `older_than_ms`; returns how many.
    pub fn prune_history(&self, older_than_ms: i64) -> Result<u64> {
        let n = self
            .db
            .execute(
                "DELETE FROM query_history WHERE ran_at_ms < ?1",
                params![older_than_ms],
            )
            .map_err(store_err)?;
        Ok(n as u64)
    }

    pub fn clear_all_history(&self) -> Result<()> {
        self.db
            .execute("DELETE FROM query_history", [])
            .map_err(store_err)?;
        self.checkpoint();
        Ok(())
    }

    /// Bytes the history rows hold: the SQL and error text plus 64 per row.
    pub fn history_bytes(&self) -> Result<u64> {
        let n: i64 = self
            .db
            .query_row(
                "SELECT COALESCE(SUM(length(CAST(sql AS BLOB)) + length(CAST(COALESCE(error, '') AS BLOB)) + 64), 0)
                 FROM query_history",
                [],
                |r| r.get(0),
            )
            .map_err(store_err)?;
        Ok(n as u64)
    }

    /// The newest run of each Saved Query, matched on its text with surrounding whitespace and
    /// one final ";" ignored on both sides: History keeps a statement without its ";".
    pub fn saved_query_runs(&self) -> Result<Vec<SavedQueryRun>> {
        let mut stmt = self
            .db
            .prepare(&format!(
                "WITH h AS (SELECT id, {h_key} AS k FROM query_history),
                      latest AS (SELECT k, MAX(id) AS id FROM h GROUP BY k)
                 SELECT s.id, q.ran_at_ms, q.rows, q.elapsed_ms
                 FROM saved_queries s
                 JOIN latest ON latest.k = {s_key}
                 JOIN query_history q ON q.id = latest.id",
                h_key = statement_key("sql"),
                s_key = statement_key("s.sql"),
            ))
            .map_err(store_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })
            .map_err(store_err)?;
        let mut out = Vec::new();
        for row in rows {
            let (id, ran_at_ms, rows, elapsed) = row.map_err(store_err)?;
            out.push(SavedQueryRun {
                saved_id: id.parse().map_err(store_err)?,
                ran_at_ms,
                rows: rows.map(|n| n as u64),
                elapsed_ms: elapsed as u64,
            });
        }
        Ok(out)
    }

    pub fn clear_history(&self, conn: ConnectionId) -> Result<()> {
        self.db
            .execute(
                "DELETE FROM query_history WHERE connection_id = ?1",
                params![conn.to_string()],
            )
            .map_err(store_err)?;
        self.checkpoint();
        Ok(())
    }

    /// Sorted by name, ignoring case.
    pub fn list_saved_queries(&self) -> Result<Vec<SavedQuery>> {
        let mut stmt = self
            .db
            .prepare(
                "SELECT id, name, sql, updated_at_ms, kind, visual_json FROM saved_queries
                 ORDER BY name COLLATE NOCASE",
            )
            .map_err(store_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get::<_, String>(4)?,
                    r.get(5)?,
                ))
            })
            .map_err(store_err)?;
        let mut out = Vec::new();
        for row in rows {
            let (id, name, sql, updated_at_ms, kind, visual_json) = row.map_err(store_err)?;
            out.push(SavedQuery {
                id: id.parse().map_err(store_err)?,
                name,
                sql,
                updated_at_ms,
                connection_id: None,
                kind: SavedQueryKind::from_store(&kind),
                visual_json,
            });
        }
        Ok(out)
    }

    /// One Saved Query by id, without its Connection (that lives in the settings map).
    pub fn get_saved_query(&self, id: uuid::Uuid) -> Result<Option<SavedQuery>> {
        self.db
            .query_row(
                "SELECT name, sql, updated_at_ms, kind, visual_json FROM saved_queries WHERE id = ?1",
                params![id.to_string()],
                |r| {
                    Ok(SavedQuery {
                        id,
                        name: r.get(0)?,
                        sql: r.get(1)?,
                        updated_at_ms: r.get(2)?,
                        connection_id: None,
                        kind: SavedQueryKind::from_store(&r.get::<_, String>(3)?),
                        visual_json: r.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(store_err)
    }

    /// Fails with `InvalidInput` when another Saved Query has the same name, ignoring case.
    pub fn save_saved_query(&self, q: &SavedQuery) -> Result<()> {
        let saved = self.db.execute(
            "INSERT INTO saved_queries (id, name, sql, updated_at_ms, kind, visual_json)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, sql = excluded.sql,
               updated_at_ms = excluded.updated_at_ms, kind = excluded.kind,
               visual_json = excluded.visual_json",
            params![
                q.id.to_string(),
                q.name,
                q.sql,
                q.updated_at_ms,
                q.kind.as_str(),
                q.visual_json
            ],
        );
        match saved {
            Ok(_) => Ok(()),
            Err(rusqlite::Error::SqliteFailure(f, _))
                if f.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                Err(Error::InvalidInput(format!(
                    "A Saved Query named \"{}\" exists. Choose another name.",
                    q.name
                )))
            }
            Err(e) => Err(store_err(e)),
        }
    }

    pub fn delete_saved_query(&self, id: uuid::Uuid) -> Result<()> {
        self.db
            .execute(
                "DELETE FROM saved_queries WHERE id = ?1",
                params![id.to_string()],
            )
            .map_err(store_err)?;
        Ok(())
    }

    pub fn list_connections(&self) -> Result<Vec<ConnectionConfig>> {
        let mut stmt = self
            .db
            .prepare("SELECT config_json FROM connections")
            .map_err(store_err)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(store_err)?;
        let mut out = Vec::new();
        for row in rows {
            let json = row.map_err(store_err)?;
            out.push(serde_json::from_str::<ConnectionConfig>(&json).map_err(store_err)?);
        }
        out.sort_by_key(|c| c.name.to_lowercase());
        Ok(out)
    }

    pub fn save_connection(&self, c: &ConnectionConfig) -> Result<()> {
        let json = serde_json::to_string(c).map_err(store_err)?;
        self.db
            .execute(
                "INSERT OR REPLACE INTO connections (id, config_json) VALUES (?1, ?2)",
                params![c.id.to_string(), json],
            )
            .map_err(store_err)?;
        Ok(())
    }

    /// Deletes the Connection and, in the same transaction, the settings that belong to it alone
    /// (the table grids' column orders), so none outlives it whatever path deletes it.
    pub fn delete_connection(&self, id: ConnectionId) -> Result<()> {
        let tx = self.db.unchecked_transaction().map_err(store_err)?;
        tx.execute(
            "DELETE FROM connections WHERE id = ?1",
            params![id.to_string()],
        )
        .map_err(store_err)?;
        let (from, to) = prefix_range(&column_order_prefix(id));
        tx.execute(
            "DELETE FROM settings WHERE key >= ?1 AND key < ?2",
            params![from, to],
        )
        .map_err(store_err)?;
        tx.commit().map_err(store_err)?;
        self.checkpoint();
        Ok(())
    }

    pub fn list_groups(&self) -> Result<Vec<Group>> {
        let mut stmt = self
            .db
            .prepare("SELECT id, name, color FROM groups")
            .map_err(store_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(store_err)?;
        let mut out = Vec::new();
        for row in rows {
            let (id, name, color) = row.map_err(store_err)?;
            out.push(Group {
                id: id.parse().map_err(store_err)?,
                name,
                color: serde_json::from_value(serde_json::Value::String(color))
                    .map_err(store_err)?,
                has_image: false,
            });
        }
        out.sort_by_key(|g| g.name.to_lowercase());
        Ok(out)
    }

    pub fn save_group(&self, g: &Group) -> Result<()> {
        let color = serde_json::to_value(g.color)
            .map_err(store_err)?
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| Error::Store("group color is not a string".into()))?;
        self.db
            .execute(
                "INSERT OR REPLACE INTO groups (id, name, color) VALUES (?1, ?2, ?3)",
                params![g.id.to_string(), g.name, color],
            )
            .map_err(store_err)?;
        Ok(())
    }

    /// Moves the Group's Connections to Ungrouped, then deletes the Group, in
    /// one transaction. No Connection is deleted.
    pub fn delete_group(&self, id: GroupId) -> Result<()> {
        let id = id.to_string();
        let tx = self.db.unchecked_transaction().map_err(store_err)?;
        tx.execute(
            "UPDATE connections SET config_json = json_set(config_json, '$.groupId', NULL)
             WHERE json_extract(config_json, '$.groupId') = ?1",
            params![id],
        )
        .map_err(store_err)?;
        tx.execute("DELETE FROM groups WHERE id = ?1", params![id])
            .map_err(store_err)?;
        tx.commit().map_err(store_err)
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        self.db
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()
            .map_err(store_err)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.db
            .execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
                params![key, value],
            )
            .map_err(store_err)?;
        Ok(())
    }

    pub fn delete_setting(&self, key: &str) -> Result<()> {
        self.db
            .execute("DELETE FROM settings WHERE key = ?1", params![key])
            .map_err(store_err)?;
        Ok(())
    }

    /// Every setting whose key starts with `prefix`, as (key, value): a range of the key's
    /// primary key index, never a scan of the table.
    pub fn settings_with_prefix(&self, prefix: &str) -> Result<Vec<(String, String)>> {
        let (from, to) = prefix_range(prefix);
        let mut stmt = self.db.prepare(SETTINGS_IN_RANGE).map_err(store_err)?;
        let rows = stmt
            .query_map(params![from, to], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(store_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(store_err)
    }

    /// Writes one table's column order (`value`, JSON with an `at` stamp) for Connection `id`,
    /// and in the same transaction drops the least recently used other orders of that Connection
    /// while they are over `max_count` rows or `max_bytes`. Reads only that Connection's rows,
    /// through the key index. Not found when the Connection is gone, so no order outlives it.
    pub fn put_column_order(
        &self,
        id: ConnectionId,
        table: &str,
        value: &str,
        max_count: usize,
        max_bytes: usize,
    ) -> Result<()> {
        let prefix = column_order_prefix(id);
        let (from, to) = prefix_range(&prefix);
        let key = format!("{prefix}{table}");
        let tx = self.db.unchecked_transaction().map_err(store_err)?;
        let known = tx
            .query_row(
                "SELECT 1 FROM connections WHERE id = ?1",
                params![id.to_string()],
                |_| Ok(()),
            )
            .optional()
            .map_err(store_err)?;
        if known.is_none() {
            return Err(Error::NotFound("connection not found".into()));
        }
        tx.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )
        .map_err(store_err)?;
        let (mut count, mut bytes): (i64, i64) = tx
            .query_row(
                "SELECT count(*), coalesce(sum(length(CAST(key AS BLOB)) + length(CAST(value AS BLOB))), 0)
                 FROM settings WHERE key >= ?1 AND key < ?2",
                params![from, to],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(store_err)?;
        let over =
            |count: i64, bytes: i64| count as usize > max_count || bytes as usize > max_bytes;
        if over(count, bytes) {
            // Oldest stamp first; an entry that does not read (no stamp) goes before any.
            let old: Vec<(String, i64)> = {
                let mut stmt = tx
                    .prepare(
                        "SELECT key, length(CAST(key AS BLOB)) + length(CAST(value AS BLOB)) FROM settings
                         WHERE key >= ?1 AND key < ?2 AND key <> ?3
                         ORDER BY json_extract(CASE WHEN json_valid(value) THEN value END, '$.at')",
                    )
                    .map_err(store_err)?;
                stmt.query_map(params![from, to, key], |r| Ok((r.get(0)?, r.get(1)?)))
                    .map_err(store_err)?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(store_err)?
            };
            for (k, size) in old {
                if !over(count, bytes) {
                    break;
                }
                tx.execute("DELETE FROM settings WHERE key = ?1", params![k])
                    .map_err(store_err)?;
                count -= 1;
                bytes -= size;
            }
        }
        tx.commit().map_err(store_err)
    }
}

/// Settings whose keys lie in `[from, to)`: the primary key index finds them.
const SETTINGS_IN_RANGE: &str = "SELECT key, value FROM settings WHERE key >= ?1 AND key < ?2";

/// The keys that start with `prefix` are those in `[prefix, end)`, where `end` is the prefix with
/// its last character one higher (`column_order:<id>:` up to `column_order:<id>;`).
fn prefix_range(prefix: &str) -> (String, String) {
    let mut end: Vec<char> = prefix.chars().collect();
    if let Some(last) = end.pop() {
        end.push(char::from_u32(last as u32 + 1).unwrap_or(char::MAX));
    }
    (prefix.to_string(), end.into_iter().collect())
}

/// The settings key prefix of a Connection's column orders: one setting per table,
/// `column_order:<connection id>:<table key>`, so a move rewrites only its own table's row.
pub fn column_order_prefix(id: ConnectionId) -> String {
    format!("column_order:{id}:")
}

/// SQL for `column`'s text with surrounding whitespace and one final ";" removed.
fn statement_key(column: &str) -> String {
    const WS: &str = "' ' || char(9) || char(10) || char(13)";
    let t = format!("trim({column}, {WS})");
    format!(
        "CASE WHEN substr({t}, -1) = ';' THEN rtrim(substr({t}, 1, length({t}) - 1), {WS}) ELSE {t} END"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn column_orders_are_read_through_the_key_index() {
        let (_d, s) = open_tmp();
        let plan: Vec<String> =
            s.db.prepare(&format!("EXPLAIN QUERY PLAN {SETTINGS_IN_RANGE}"))
                .unwrap()
                .query_map(params!["a:", "a;"], |r| r.get::<_, String>(3))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
        assert!(
            plan.iter()
                .any(|p| p.contains("SEARCH") && p.contains("INDEX")),
            "{plan:?}"
        );
        assert_eq!(
            prefix_range("column_order:x:"),
            ("column_order:x:".into(), "column_order:x;".into())
        );
    }

    #[test]
    fn a_column_order_write_evicts_in_its_own_transaction_oldest_first() {
        let (_d, s) = open_tmp();
        let c = conn("a", None);
        s.save_connection(&c).unwrap();
        let other = conn("b", None);
        s.save_connection(&other).unwrap();
        let v = |at: i64| format!(r#"{{"columns":["x"],"at":{at}}}"#);
        s.put_column_order(c.id, "t1", &v(1), 2, 1 << 20).unwrap();
        s.put_column_order(c.id, "t2", &v(3), 2, 1 << 20).unwrap();
        s.put_column_order(other.id, "t9", &v(0), 2, 1 << 20)
            .unwrap();
        // t3 is the third: t1 (the oldest) goes, the other Connection's order is not touched.
        s.put_column_order(c.id, "t3", &v(5), 2, 1 << 20).unwrap();
        let keys = |id: ConnectionId| {
            s.settings_with_prefix(&column_order_prefix(id))
                .unwrap()
                .into_iter()
                .map(|(k, _)| k[column_order_prefix(id).len()..].to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(keys(c.id), vec!["t2", "t3"]);
        assert_eq!(keys(other.id), vec!["t9"]);
        // A byte cap smaller than two orders keeps only the one just written.
        s.put_column_order(c.id, "t4", &v(7), 10, 60).unwrap();
        assert_eq!(keys(c.id), vec!["t4"]);
        // An unknown Connection writes nothing.
        let gone = Uuid::new_v4();
        assert!(matches!(
            s.put_column_order(gone, "t", &v(1), 2, 1 << 20),
            Err(Error::NotFound(_))
        ));
        assert!(keys(gone).is_empty());
    }
    use crate::model::{ConnectionConfig, DialectKind, Group, GroupColor, SslMode};
    use crate::query::{HistoryFilter, HistoryOnly, NewHistory, Outcome};
    use uuid::Uuid;

    fn conn(name: &str, group_id: Option<Uuid>) -> ConnectionConfig {
        ConnectionConfig {
            id: Uuid::new_v4(),
            name: name.into(),
            dialect: DialectKind::MySql,
            host: "127.0.0.1".into(),
            port: 3306,
            user: "u".into(),
            database: None,
            ssl: SslMode::Disable,
            group_id,
            file: None,
            query_timeout_secs: None,
            ai_access: Default::default(),
            ai_sync: Default::default(),
            production: false,
            read_only: false,
        }
    }

    #[cfg(unix)]
    #[test]
    fn store_files_are_for_this_user_only() {
        // L1 (security audit 1.0): app.sqlite and its WAL and shared-memory files are
        // 0600, made so and tightened on open when an older build left them looser.
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.sqlite");
        let files = [
            path.clone(),
            dir.path().join("app.sqlite-wal"),
            dir.path().join("app.sqlite-shm"),
        ];
        {
            let store = AppStore::open(&path).unwrap();
            store.set_setting("k", "v").unwrap();
            for f in &files {
                assert_eq!(mode(f), 0o600, "{}", f.display());
            }
            for f in &files {
                std::fs::set_permissions(f, std::fs::Permissions::from_mode(0o644)).unwrap();
            }
            let _again = AppStore::open(&path).unwrap();
            for f in &files {
                assert_eq!(mode(f), 0o600, "{}", f.display());
            }
        }
        // An in-memory store makes no file named after it.
        drop(AppStore::open(Path::new(":memory:")).unwrap());
        assert!(!Path::new(":memory:").exists());
    }

    fn open_tmp() -> (tempfile::TempDir, AppStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
        (dir, store)
    }

    #[test]
    fn save_then_list_round_trips() {
        let (_d, s) = open_tmp();
        let c = conn("one", None);
        s.save_connection(&c).unwrap();
        assert_eq!(s.list_connections().unwrap(), vec![c]);
    }

    #[test]
    fn save_same_id_replaces() {
        let (_d, s) = open_tmp();
        let mut c = conn("one", None);
        s.save_connection(&c).unwrap();
        c.name = "renamed".into();
        s.save_connection(&c).unwrap();
        assert_eq!(s.list_connections().unwrap(), vec![c]);
    }

    #[test]
    fn delete_removes() {
        let (_d, s) = open_tmp();
        let c = conn("one", None);
        s.save_connection(&c).unwrap();
        s.delete_connection(c.id).unwrap();
        assert!(s.list_connections().unwrap().is_empty());
        s.delete_connection(c.id).unwrap();
    }

    #[test]
    fn reopen_keeps_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.sqlite");
        let c = conn("one", None);
        {
            let s = AppStore::open(&path).unwrap();
            s.save_connection(&c).unwrap();
        }
        let s = AppStore::open(&path).unwrap();
        assert_eq!(s.list_connections().unwrap(), vec![c]);
    }

    #[test]
    fn list_sorted_by_name_case_insensitive() {
        let (_d, s) = open_tmp();
        s.save_connection(&conn("beta", None)).unwrap();
        s.save_connection(&conn("Alpha", None)).unwrap();
        let names: Vec<_> = s
            .list_connections()
            .unwrap()
            .into_iter()
            .map(|c| c.name)
            .collect();
        assert_eq!(names, vec!["Alpha", "beta"]);
    }

    #[test]
    fn group_round_trips() {
        let (_d, s) = open_tmp();
        let g = Group {
            id: Uuid::new_v4(),
            name: "Prod".into(),
            color: GroupColor::Indigo,
            has_image: false,
        };
        s.save_group(&g).unwrap();
        let b = Group {
            id: Uuid::new_v4(),
            name: "alpha".into(),
            color: GroupColor::Sky,
            has_image: false,
        };
        s.save_group(&b).unwrap();
        assert_eq!(s.list_groups().unwrap(), vec![b, g]);
    }

    #[test]
    fn delete_group_ungroups_its_connections() {
        let (_d, s) = open_tmp();
        let a = Group {
            id: Uuid::new_v4(),
            name: "A".into(),
            color: GroupColor::Indigo,
            has_image: false,
        };
        let b = Group {
            id: Uuid::new_v4(),
            name: "B".into(),
            color: GroupColor::Green,
            has_image: false,
        };
        s.save_group(&a).unwrap();
        s.save_group(&b).unwrap();
        s.save_connection(&conn("a1", Some(a.id))).unwrap();
        s.save_connection(&conn("a2", Some(a.id))).unwrap();
        s.save_connection(&conn("b1", Some(b.id))).unwrap();
        s.delete_group(a.id).unwrap();
        let conns = s.list_connections().unwrap();
        assert_eq!(conns.len(), 3);
        for c in &conns {
            if c.name == "b1" {
                assert_eq!(c.group_id, Some(b.id));
            } else {
                assert_eq!(c.group_id, None);
            }
        }
        assert_eq!(s.list_groups().unwrap(), vec![b]);
    }

    #[test]
    fn newer_schema_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.sqlite");
        drop(AppStore::open(&path).unwrap());
        Connection::open(&path)
            .unwrap()
            .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        match AppStore::open(&path) {
            Err(Error::Store(msg)) => assert_eq!(msg, "data folder was written by a newer Contura"),
            Err(other) => panic!("unexpected error {other:?}"),
            Ok(_) => panic!("a newer schema must be refused"),
        }
    }

    #[test]
    fn open_sets_busy_timeout() {
        let (_d, s) = open_tmp();
        let ms: i64 =
            s.db.query_row("PRAGMA busy_timeout", [], |r| r.get(0))
                .unwrap();
        assert_eq!(ms, 5000);
    }

    #[test]
    fn store_upgrades_v1_to_v2_keeping_connections() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.sqlite");
        let c = conn("kept", None);
        {
            let v1 = Connection::open(&path).unwrap();
            v1.execute_batch(
                "CREATE TABLE connections (id TEXT PRIMARY KEY, config_json TEXT NOT NULL);
                 CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL);
                 CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 PRAGMA user_version = 1;",
            )
            .unwrap();
            // A v1 config has no queryTimeoutSecs field.
            let mut json = serde_json::to_value(&c).unwrap();
            json.as_object_mut().unwrap().remove("queryTimeoutSecs");
            v1.execute(
                "INSERT INTO connections VALUES (?1, ?2)",
                params![c.id.to_string(), json.to_string()],
            )
            .unwrap();
        }
        let s = AppStore::open(&path).unwrap();
        assert_eq!(s.list_connections().unwrap(), vec![c]);
        let v: i64 =
            s.db.query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        assert!(
            s.query_history(Some(Uuid::new_v4()), &all())
                .unwrap()
                .is_empty()
        );
    }

    fn thread(place: &str, title: &str, updated_at: i64) -> crate::ai::AiThread {
        crate::ai::AiThread {
            id: Uuid::new_v4(),
            place: place.into(),
            title: title.into(),
            messages: vec![crate::ai::AiMessage {
                role: crate::ai::AiRole::User,
                text: "how many users?".into(),
                context: vec!["Schema".into()],
                at: updated_at,
                record: None,
                topic: None,
                connection_id: None,
                database: None,
                kinds: Vec::new(),
                tables: Vec::new(),
                action: None,
                asked_in: None,
            }],
            updated_at,
            title_by: Default::default(),
            title_tries: 0,
            last_work: None,
        }
    }

    #[test]
    fn threads_round_trip_per_place() {
        let (_d, s) = open_tmp();
        let a = thread("ungrouped", "a", 1);
        let b = thread("group:g1", "b", 2);
        s.save_ai_thread(&a).unwrap();
        s.save_ai_thread(&b).unwrap();
        assert_eq!(s.list_ai_threads("ungrouped").unwrap(), vec![a.clone()]);
        assert_eq!(s.list_ai_threads("group:g1").unwrap(), vec![b.clone()]);
        // A save changes the thread but never its title (P3): only a rename does.
        let mut a2 = a.clone();
        a2.title = "renamed".into();
        a2.updated_at += 1;
        s.save_ai_thread(&a2).unwrap();
        a2.title = a.title.clone();
        assert_eq!(s.list_ai_threads("ungrouped").unwrap(), vec![a2.clone()]);
        s.delete_ai_thread(a2.id).unwrap();
        assert!(s.list_ai_threads("ungrouped").unwrap().is_empty());
        assert_eq!(s.list_ai_threads("group:g1").unwrap(), vec![b]);
    }

    #[test]
    fn thread_statements_read_only_the_sql_of_the_place_newest_first() {
        use crate::ai::rails::output::{SqlBlock, StatementCheck};
        use crate::ai::sent::AnswerRecord;
        use crate::safety::StatementClass;
        let (_d, s) = open_tmp();
        let with_sql = |place: &str, at: i64, sql: &str| {
            let mut t = thread(place, "t", at);
            let mut a = t.messages[0].clone();
            a.role = crate::ai::AiRole::Assistant;
            a.at = at + 1;
            a.record = Some(AnswerRecord {
                sql_blocks: vec![SqlBlock {
                    fence: 0,
                    body_sha256: String::new(),
                    label: "1 statement".into(),
                    statements: vec![StatementCheck {
                        text: sql.into(),
                        class: StatementClass::Read,
                        flags: Vec::new(),
                    }],
                }],
                thinking: Some("long thinking".repeat(1000)),
                ..AnswerRecord::default()
            });
            t.messages.push(a);
            t
        };
        s.save_ai_thread(&with_sql("ungrouped", 1, "select 1"))
            .unwrap();
        s.save_ai_thread(&with_sql("ungrouped", 5, "select 5"))
            .unwrap();
        s.save_ai_thread(&with_sql("group:g1", 9, "select 9"))
            .unwrap();
        s.save_ai_thread(&thread("ungrouped", "no answers", 7))
            .unwrap();
        let texts: Vec<String> = s
            .ai_thread_statements("ungrouped")
            .unwrap()
            .into_iter()
            .map(|st| st.text)
            .collect();
        assert_eq!(texts, vec!["select 5", "select 1"]);
    }

    fn place_fixture(s: &AppStore) {
        use crate::ai::rails::output::{SqlBlock, StatementCheck};
        use crate::ai::sent::AnswerRecord;
        use crate::safety::StatementClass;
        for (place, at, sqls) in [
            ("ungrouped", 1, vec!["select 1", "select 1b"]),
            ("ungrouped", 5, vec!["select 5"]),
            ("ungrouped", 9, vec![]),
        ] {
            let mut t = thread(place, "t", at);
            let mut a = t.messages[0].clone();
            a.role = crate::ai::AiRole::Assistant;
            a.at = at + 1;
            a.record = Some(AnswerRecord {
                sql_blocks: sqls
                    .iter()
                    .map(|q| SqlBlock {
                        fence: 0,
                        body_sha256: String::new(),
                        label: "1 statement".into(),
                        statements: vec![StatementCheck {
                            text: (*q).into(),
                            class: StatementClass::Read,
                            flags: Vec::new(),
                        }],
                    })
                    .collect(),
                ..AnswerRecord::default()
            });
            t.messages.push(a);
            s.save_ai_thread(&t).unwrap();
        }
    }

    #[test]
    fn place_load_reads_statements_from_columns() {
        let (_d, s) = open_tmp();
        place_fixture(&s);
        let serde_path: Vec<_> = s
            .list_ai_threads("ungrouped")
            .unwrap()
            .into_iter()
            .flat_map(|t| t.messages)
            .filter_map(|m| m.record)
            .flat_map(|r| r.sql_blocks)
            .flat_map(|b| b.statements)
            .collect();
        assert_eq!(serde_path.len(), 3);
        assert_eq!(s.ai_thread_statements("ungrouped").unwrap(), serde_path);
        // A field the typed thread rejects does not stop its statements.
        s.db.execute(
            "UPDATE ai_threads SET json = json_set(json, '$.id', 12345)",
            [],
        )
        .unwrap();
        assert!(s.list_ai_threads("ungrouped").is_err());
        assert_eq!(s.ai_thread_statements("ungrouped").unwrap(), serde_path);
    }

    #[test]
    #[ignore = "timing: a perf check, run with --release; the 20 ms bound is provisional"]
    fn place_load_of_50_large_threads_under_20ms() {
        let (_d, s) = open_tmp();
        place_fixture(&s);
        for i in 0..50 {
            let mut t = thread("big", "t", i);
            t.messages[0].text = "x".repeat(1_000_000);
            s.save_ai_thread(&t).unwrap();
        }
        let start = std::time::Instant::now();
        let n = s.ai_thread_statements("big").unwrap().len();
        let took = start.elapsed();
        assert_eq!(n, 0);
        assert!(took.as_millis() < 20, "took {took:?}");
    }

    #[test]
    fn threads_list_newest_first_and_cap_50() {
        let (_d, s) = open_tmp();
        for i in 0..55 {
            s.save_ai_thread(&thread("ungrouped", &format!("t{i}"), i))
                .unwrap();
        }
        let list = s.list_ai_threads("ungrouped").unwrap();
        assert_eq!(list.len(), 50);
        assert_eq!(list[0].title, "t54");
        assert_eq!(list[49].title, "t5");
        let n: i64 =
            s.db.query_row("SELECT COUNT(*) FROM ai_threads", [], |r| r.get(0))
                .unwrap();
        // Threads beyond the newest 50 are deleted with the save that pushes them out.
        assert_eq!(n, 50);
    }

    #[test]
    fn clear_threads_only_touches_its_place() {
        let (_d, s) = open_tmp();
        s.save_ai_thread(&thread("ungrouped", "a", 1)).unwrap();
        s.save_ai_thread(&thread("group:g1", "b", 2)).unwrap();
        s.clear_ai_threads("ungrouped").unwrap();
        assert!(s.list_ai_threads("ungrouped").unwrap().is_empty());
        assert_eq!(s.list_ai_threads("group:g1").unwrap().len(), 1);
    }

    #[test]
    fn store_upgrades_v2_to_v3_keeping_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.sqlite");
        let c = Uuid::new_v4();
        {
            let s = AppStore::open(&path).unwrap();
            s.add_history(&entry(c, "SELECT 1", Outcome::Ok, false))
                .unwrap();
            // Back to schema 2: no ai_threads, no Saved Visual Query columns, no AI Context.
            s.db.execute_batch(
                "DROP TABLE ai_context_meta;
                 DROP TABLE ai_context_node;
                 DROP TABLE ai_context_card;
                 DROP TABLE ai_context_fts;
                 DROP TABLE ai_topic;
                 DROP TABLE ai_topic_fts;
                 DROP TABLE ai_compaction;
                 DROP TABLE ai_tool_use;
                 DROP TABLE ai_threads;
                 ALTER TABLE saved_queries DROP COLUMN kind;
                 ALTER TABLE saved_queries DROP COLUMN visual_json;
                 PRAGMA user_version = 2;",
            )
            .unwrap();
        }
        let s = AppStore::open(&path).unwrap();
        let v: i64 =
            s.db.query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        let h = s.query_history(Some(c), &all()).unwrap();
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].sql, "SELECT 1");
        assert!(s.list_ai_threads("ungrouped").unwrap().is_empty());
    }

    fn all() -> HistoryFilter {
        HistoryFilter {
            search: None,
            only: None,
        }
    }

    #[test]
    fn saved_query_runs_ignore_one_final_semicolon_and_whitespace() {
        let (_d, s) = open_tmp();
        let conn = Uuid::new_v4();
        let saved = |name: &str, sql: &str| {
            let q = SavedQuery {
                id: Uuid::new_v4(),
                name: name.into(),
                sql: sql.into(),
                updated_at_ms: 1,
                connection_id: None,
                kind: SavedQueryKind::Sql,
                visual_json: None,
            };
            s.save_saved_query(&q).unwrap();
            q.id
        };
        // History stores the statement without its ";"; the Saved Query keeps it.
        let with_semi = saved("with", "SELECT * FROM users;\n");
        // The other way round, with whitespace before the ";".
        let history_semi = saved("other", " SELECT 2 ");
        let never = saved("never", "SELECT 3;");
        let double = saved("double", "SELECT 4;;");
        // Whole-text equality: "SELECT 1" never matches a run of "SELECT 10".
        let near = saved("near", "SELECT 1;");
        s.add_history(&entry(conn, "SELECT * FROM users", Outcome::Ok, false))
            .unwrap();
        s.add_history(&entry(conn, "SELECT 2 ;", Outcome::Ok, false))
            .unwrap();
        s.add_history(&entry(conn, "SELECT 4", Outcome::Ok, false))
            .unwrap();
        s.add_history(&entry(conn, "SELECT 10", Outcome::Ok, false))
            .unwrap();
        let ids: std::collections::HashSet<_> = s
            .saved_query_runs()
            .unwrap()
            .iter()
            .map(|r| r.saved_id)
            .collect();
        assert!(ids.contains(&with_semi));
        assert!(ids.contains(&history_semi));
        assert!(!ids.contains(&never));
        // Only one ";" is ignored.
        assert!(!ids.contains(&double));
        assert!(!ids.contains(&near));
    }

    /// Whether `needle` is anywhere in the store's files on disk.
    fn on_disk(dir: &Path, needle: &str) -> Vec<String> {
        ["app.sqlite", "app.sqlite-wal"]
            .into_iter()
            .filter(|f| {
                std::fs::read(dir.join(f))
                    .is_ok_and(|b| b.windows(needle.len()).any(|w| w == needle.as_bytes()))
            })
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn cleared_history_and_ai_threads_leave_no_trace_in_the_files() {
        // L2 (security audit 1.0): Clear history and Clear all AI data overwrite what
        // they delete (secure_delete) and empty the WAL (checkpoint TRUNCATE), so the
        // text cannot be read back from app.sqlite or its WAL.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.sqlite");
        let s = AppStore::open(&path).unwrap();
        let conn = Uuid::new_v4();
        s.add_history(&entry(
            conn,
            "ALTER USER app PASSWORD 'hist-7f3a-marker'",
            Outcome::Ok,
            true,
        ))
        .unwrap();
        let mut t = thread("ungrouped", "t", 1);
        t.messages[0].text = "sample row ai-9c2e-marker".into();
        s.save_ai_thread(&t).unwrap();
        let mut g = thread("group:g1", "g", 2);
        g.messages[0].text = "place row place-5d1b-marker".into();
        s.save_ai_thread(&g).unwrap();
        // A second connection, as the app has, keeps reading the same file.
        let other = AppStore::open(&path).unwrap();
        assert_eq!(other.list_ai_threads("ungrouped").unwrap().len(), 1);
        drop(other);
        assert!(!on_disk(dir.path(), "hist-7f3a-marker").is_empty());

        // I2 (final review): deleting one chat empties the WAL too.
        let mut d = thread("ungrouped", "d", 3);
        d.messages[0].text = "deleted chat del-4a7e-marker".into();
        s.save_ai_thread(&d).unwrap();
        assert!(!on_disk(dir.path(), "del-4a7e-marker").is_empty());
        s.delete_ai_thread(d.id).unwrap();
        assert_eq!(on_disk(dir.path(), "del-4a7e-marker"), Vec::<String>::new());

        s.clear_history(conn).unwrap();
        assert_eq!(
            on_disk(dir.path(), "hist-7f3a-marker"),
            Vec::<String>::new()
        );
        s.clear_ai_threads("group:g1").unwrap();
        assert_eq!(
            on_disk(dir.path(), "place-5d1b-marker"),
            Vec::<String>::new()
        );
        s.clear_all_ai_threads().unwrap();
        assert_eq!(on_disk(dir.path(), "ai-9c2e-marker"), Vec::<String>::new());
        assert_eq!(
            std::fs::metadata(dir.path().join("app.sqlite-wal"))
                .map(|m| m.len())
                .unwrap_or(0),
            0
        );

        s.add_history(&entry(conn, "select 'all-0b4c-marker'", Outcome::Ok, false))
            .unwrap();
        s.clear_all_history().unwrap();
        assert_eq!(on_disk(dir.path(), "all-0b4c-marker"), Vec::<String>::new());
    }

    #[test]
    fn a_deleted_connection_leaves_no_trace_in_the_files() {
        // L2 follow-up: deleting a Connection overwrites its row and empties the WAL.
        let dir = tempfile::tempdir().unwrap();
        let s = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
        let mut c = conn("prod-db-3e8f-marker", None);
        c.host = "db-3e8f-marker.internal".into();
        s.save_connection(&c).unwrap();
        assert!(!on_disk(dir.path(), "3e8f-marker").is_empty());
        s.delete_connection(c.id).unwrap();
        assert_eq!(on_disk(dir.path(), "3e8f-marker"), Vec::<String>::new());
    }

    #[test]
    fn a_failed_checkpoint_after_a_committed_clear_is_not_a_failed_clear() {
        // L2 review: the rows are gone once the delete commits; a checkpoint that fails
        // afterwards is logged, and the clear still reports success.
        let (_d, s) = open_tmp();
        let id = Uuid::new_v4();
        s.add_history(&entry(id, "select 1", Outcome::Ok, false))
            .unwrap();
        s.save_ai_thread(&thread("ungrouped", "t", 1)).unwrap();
        let one = thread("ungrouped", "one", 2);
        s.save_ai_thread(&one).unwrap();
        let c = conn("gone", None);
        s.save_connection(&c).unwrap();
        s.fail_checkpoint.set(true);
        s.delete_ai_thread(one.id).unwrap();
        s.clear_history(id).unwrap();
        s.clear_all_history().unwrap();
        s.clear_ai_threads("ungrouped").unwrap();
        s.clear_all_ai_threads().unwrap();
        s.delete_connection(c.id).unwrap();
        assert!(s.list_ai_threads("ungrouped").unwrap().is_empty());
        assert!(s.list_connections().unwrap().is_empty());
    }

    /// L2 timing on a large store: `cargo test -p contura-core --lib -- --ignored
    /// --nocapture clear_on_a_big_store`.
    #[test]
    #[ignore = "timing: prints how long the clears take on a large store"]
    fn clear_on_a_big_store() {
        let dir = tempfile::tempdir().unwrap();
        let s = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
        let text = "x".repeat(256 * 1024);
        for i in 0..200 {
            let mut t = thread("ungrouped", "t", i);
            t.messages[0].text = text.clone();
            s.save_ai_thread(&t).unwrap();
        }
        let sql = format!("select '{}'", "y".repeat(2000));
        let conns: Vec<Uuid> = (0..10).map(|_| Uuid::new_v4()).collect();
        for c in &conns {
            for _ in 0..HISTORY_LIMIT {
                s.add_history(&entry(*c, &sql, Outcome::Ok, false)).unwrap();
            }
        }
        let size = std::fs::metadata(dir.path().join("app.sqlite"))
            .unwrap()
            .len();
        let t0 = std::time::Instant::now();
        s.clear_all_history().unwrap();
        let history = t0.elapsed();
        let t0 = std::time::Instant::now();
        s.clear_all_ai_threads().unwrap();
        let threads = t0.elapsed();
        println!(
            "store {} MB: clear all history {:?}, clear all AI threads {:?}",
            size / (1024 * 1024),
            history,
            threads
        );
    }

    fn entry(conn: Uuid, sql: &str, outcome: Outcome, changed: bool) -> NewHistory {
        NewHistory {
            connection_id: conn,
            sql: sql.into(),
            ran_at_ms: 1,
            elapsed_ms: 5,
            outcome,
            rows: Some(1),
            changed,
            error: None,
        }
    }

    #[test]
    fn history_keeps_the_last_1000_per_connection() {
        let (_d, s) = open_tmp();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        s.add_history(&entry(b, "other", Outcome::Ok, false))
            .unwrap();
        for i in 0..1005 {
            s.add_history(&entry(a, &format!("SELECT {i}"), Outcome::Ok, false))
                .unwrap();
        }
        let h = s.query_history(Some(a), &all()).unwrap();
        assert_eq!(h.len(), 1000);
        assert_eq!(h[0].sql, "SELECT 1004");
        assert_eq!(h[999].sql, "SELECT 5");
        assert_eq!(s.query_history(Some(b), &all()).unwrap().len(), 1);
    }

    #[test]
    fn history_filters_by_search_and_kind() {
        let (_d, s) = open_tmp();
        let a = Uuid::new_v4();
        s.add_history(&entry(a, "SELECT * FROM Stores", Outcome::Ok, false))
            .unwrap();
        s.add_history(&entry(a, "UPDATE stores SET x = 1", Outcome::Ok, true))
            .unwrap();
        s.add_history(&entry(a, "SELECT * FROM store", Outcome::Error, false))
            .unwrap();
        s.add_history(&entry(a, "SELECT pg_sleep(9)", Outcome::TimedOut, false))
            .unwrap();
        s.add_history(&entry(a, "SELECT 2", Outcome::Cancelled, false))
            .unwrap();
        let sqls = |f: HistoryFilter| -> Vec<String> {
            s.query_history(Some(a), &f)
                .unwrap()
                .into_iter()
                .map(|e| e.sql)
                .collect()
        };
        assert_eq!(
            sqls(HistoryFilter {
                search: Some("stores".into()),
                only: None
            }),
            vec!["UPDATE stores SET x = 1", "SELECT * FROM Stores"]
        );
        assert_eq!(
            sqls(HistoryFilter {
                search: None,
                only: Some(HistoryOnly::Failed)
            }),
            vec!["SELECT 2", "SELECT pg_sleep(9)", "SELECT * FROM store"]
        );
        assert_eq!(
            sqls(HistoryFilter {
                search: None,
                only: Some(HistoryOnly::Changes)
            }),
            vec!["UPDATE stores SET x = 1"]
        );
        s.clear_history(a).unwrap();
        assert!(s.query_history(Some(a), &all()).unwrap().is_empty());
    }

    #[test]
    fn a_new_store_asks_for_the_first_start_guide_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.sqlite");
        let s = AppStore::open(&path).unwrap();
        assert_eq!(
            s.get_setting(FIRST_START_GUIDE_KEY).unwrap().as_deref(),
            Some("show")
        );
        s.set_setting(FIRST_START_GUIDE_KEY, "seen").unwrap();
        drop(s);
        // Opening again never writes the row back.
        let s = AppStore::open(&path).unwrap();
        assert_eq!(
            s.get_setting(FIRST_START_GUIDE_KEY).unwrap().as_deref(),
            Some("seen")
        );
    }

    #[test]
    fn setting_round_trips() {
        let (_d, s) = open_tmp();
        assert_eq!(s.get_setting("theme").unwrap(), None);
        s.set_setting("theme", "dark").unwrap();
        s.set_setting("theme", "light").unwrap();
        assert_eq!(s.get_setting("theme").unwrap(), Some("light".to_string()));
    }

    fn saved(name: &str, sql: &str, kind: SavedQueryKind, visual_json: Option<&str>) -> SavedQuery {
        SavedQuery {
            id: Uuid::new_v4(),
            name: name.into(),
            sql: sql.into(),
            updated_at_ms: 1,
            connection_id: None,
            kind,
            visual_json: visual_json.map(str::to_string),
        }
    }

    #[test]
    fn migration_4_keeps_sql_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.sqlite");
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        {
            // A store as schema 3 left it, with two Saved Queries.
            let v3 = Connection::open(&path).unwrap();
            v3.execute_batch(
                "CREATE TABLE connections (id TEXT PRIMARY KEY, config_json TEXT NOT NULL);
                 CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL);
                 CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 CREATE TABLE query_history (
                   id INTEGER PRIMARY KEY, connection_id TEXT NOT NULL, sql TEXT NOT NULL,
                   ran_at_ms INTEGER NOT NULL, elapsed_ms INTEGER NOT NULL, outcome TEXT NOT NULL,
                   rows INTEGER, changed INTEGER NOT NULL, error TEXT);
                 CREATE INDEX query_history_by_connection ON query_history (connection_id, id DESC);
                 CREATE TABLE saved_queries (
                   id TEXT PRIMARY KEY, name TEXT NOT NULL, sql TEXT NOT NULL,
                   updated_at_ms INTEGER NOT NULL);
                 CREATE UNIQUE INDEX saved_queries_by_name ON saved_queries (name COLLATE NOCASE);
                 CREATE TABLE ai_threads (
                   id TEXT PRIMARY KEY, place TEXT NOT NULL, json TEXT NOT NULL,
                   updated_at INTEGER NOT NULL);
                 CREATE INDEX ai_threads_by_place ON ai_threads (place, updated_at DESC);
                 PRAGMA user_version = 3;",
            )
            .unwrap();
            v3.execute(
                "INSERT INTO saved_queries VALUES (?1, 'late orders', 'SELECT 1', 10), (?2, 'stores', 'SELECT 2', 20)",
                params![a.to_string(), b.to_string()],
            )
            .unwrap();
        }
        let s = AppStore::open(&path).unwrap();
        let v: i64 =
            s.db.query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        // A data folder from before the guide never asks for it.
        assert_eq!(s.get_setting(FIRST_START_GUIDE_KEY).unwrap(), None);
        let list = s.list_saved_queries().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(
            (
                list[0].id,
                list[0].name.as_str(),
                list[0].sql.as_str(),
                list[0].updated_at_ms
            ),
            (a, "late orders", "SELECT 1", 10)
        );
        assert_eq!(
            (
                list[1].id,
                list[1].name.as_str(),
                list[1].sql.as_str(),
                list[1].updated_at_ms
            ),
            (b, "stores", "SELECT 2", 20)
        );
        for q in &list {
            assert_eq!(q.kind, SavedQueryKind::Sql);
            assert_eq!(q.visual_json, None);
        }
        // Opening again runs no migration twice.
        drop(s);
        let s = AppStore::open(&path).unwrap();
        assert_eq!(s.list_saved_queries().unwrap().len(), 2);
    }

    #[test]
    fn a_failed_migration_4_leaves_the_store_at_3() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.sqlite");
        {
            let s = AppStore::open(&path).unwrap();
            // A v3 file that already has visual_json: the second ALTER of migration 4 fails.
            s.db.execute_batch(
                "ALTER TABLE saved_queries DROP COLUMN kind;
                 PRAGMA user_version = 3;",
            )
            .unwrap();
        }
        assert!(AppStore::open(&path).is_err());
        let db = Connection::open(&path).unwrap();
        let v: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 3);
        let kind: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('saved_queries') WHERE name = 'kind'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kind, 0);
    }

    #[test]
    fn get_saved_query_reads_one_row() {
        let (_d, s) = open_tmp();
        let q = saved("one", "SELECT 1", SavedQueryKind::Visual, Some("{}"));
        s.save_saved_query(&q).unwrap();
        assert_eq!(s.get_saved_query(q.id).unwrap(), Some(q));
        assert_eq!(s.get_saved_query(Uuid::new_v4()).unwrap(), None);
    }

    #[test]
    fn visual_row_round_trips() {
        let (_d, s) = open_tmp();
        let json = r#"{"version":1,"tables":[]}"#;
        let q = saved(
            "Late orders by store",
            "SELECT o.id\nFROM orders AS o",
            SavedQueryKind::Visual,
            Some(json),
        );
        s.save_saved_query(&q).unwrap();
        let sql_row = saved("plain", "SELECT 1", SavedQueryKind::Sql, None);
        s.save_saved_query(&sql_row).unwrap();
        assert_eq!(s.list_saved_queries().unwrap(), vec![q.clone(), sql_row]);
        // A later save overwrites the model and the SQL.
        let mut again = q.clone();
        again.visual_json = Some(r#"{"version":1,"tables":[1]}"#.into());
        again.sql = "SELECT 2".into();
        s.save_saved_query(&again).unwrap();
        let back = s.list_saved_queries().unwrap();
        assert_eq!(back[0], again);
    }

    #[test]
    fn one_name_space_across_kinds() {
        let (_d, s) = open_tmp();
        s.save_saved_query(&saved("late orders", "SELECT 1", SavedQueryKind::Sql, None))
            .unwrap();
        let err = s
            .save_saved_query(&saved(
                "Late Orders",
                "SELECT 2",
                SavedQueryKind::Visual,
                Some("{}"),
            ))
            .unwrap_err();
        assert!(matches!(err, Error::InvalidInput(_)), "{err:?}");
        assert_eq!(s.list_saved_queries().unwrap().len(), 1);
    }

    #[test]
    fn migration_5_adds_context_tables() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.sqlite");
        let id = Uuid::new_v4();
        {
            // A store as schema 4 left it, with one Saved Query.
            let v4 = Connection::open(&path).unwrap();
            v4.execute_batch(
                "CREATE TABLE connections (id TEXT PRIMARY KEY, config_json TEXT NOT NULL);
                 CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL);
                 CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 CREATE TABLE query_history (
                   id INTEGER PRIMARY KEY, connection_id TEXT NOT NULL, sql TEXT NOT NULL,
                   ran_at_ms INTEGER NOT NULL, elapsed_ms INTEGER NOT NULL, outcome TEXT NOT NULL,
                   rows INTEGER, changed INTEGER NOT NULL, error TEXT);
                 CREATE INDEX query_history_by_connection ON query_history (connection_id, id DESC);
                 CREATE TABLE saved_queries (
                   id TEXT PRIMARY KEY, name TEXT NOT NULL, sql TEXT NOT NULL,
                   updated_at_ms INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'sql',
                   visual_json TEXT);
                 CREATE UNIQUE INDEX saved_queries_by_name ON saved_queries (name COLLATE NOCASE);
                 CREATE TABLE ai_threads (
                   id TEXT PRIMARY KEY, place TEXT NOT NULL, json TEXT NOT NULL,
                   updated_at INTEGER NOT NULL);
                 CREATE INDEX ai_threads_by_place ON ai_threads (place, updated_at DESC);
                 PRAGMA user_version = 4;",
            )
            .unwrap();
            v4.execute(
                "INSERT INTO saved_queries (id, name, sql, updated_at_ms) VALUES (?1, 'late orders', 'SELECT 1', 10)",
                params![id.to_string()],
            )
            .unwrap();
        }
        let s = AppStore::open(&path).unwrap();
        let v: i64 =
            s.db.query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        let list = s.list_saved_queries().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!((list[0].id, list[0].name.as_str()), (id, "late orders"));
        for table in [
            "ai_context_meta",
            "ai_context_node",
            "ai_context_card",
            "ai_context_fts",
        ] {
            let n: i64 =
                s.db.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
                    params![table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "{table}");
        }
        drop(s);
        AppStore::open(&path).unwrap();
    }

    #[test]
    fn cache_kib_is_set() {
        let (_d, s) = open_tmp();
        s.set_cache_kib(1024).unwrap();
        let n: i64 = s
            .conn()
            .query_row("PRAGMA cache_size", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, -1024);
    }

    #[test]
    fn a_store_newer_than_8_is_refused() {
        assert_eq!(SCHEMA_VERSION, 8);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.sqlite");
        drop(AppStore::open(&path).unwrap());
        Connection::open(&path)
            .unwrap()
            .pragma_update(None, "user_version", 9)
            .unwrap();
        assert!(
            matches!(AppStore::open(&path), Err(Error::Store(m)) if m == "data folder was written by a newer Contura")
        );
    }

    /// A stamped user and assistant message of one turn.
    fn turn(topic: u32, at: i64, q: &str) -> Vec<crate::ai::AiMessage> {
        [crate::ai::AiRole::User, crate::ai::AiRole::Assistant]
            .into_iter()
            .enumerate()
            .map(|(i, role)| crate::ai::AiMessage {
                role,
                text: q.into(),
                context: Vec::new(),
                at: at + i as i64,
                record: None,
                topic: Some(topic),
                connection_id: None,
                database: None,
                kinds: Vec::new(),
                tables: vec!["orders".into()],
                action: None,
                asked_in: None,
            })
            .collect()
    }

    fn count(s: &AppStore, table: &str) -> i64 {
        s.conn()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    fn compaction_of(thread: &crate::ai::AiThread) -> crate::ai::memory::Compaction {
        crate::ai::memory::Compaction {
            id: Uuid::new_v4(),
            thread_id: thread.id,
            topic: 1,
            first_at: 0,
            last_at: 10,
            messages: 2,
            summary: "s".into(),
            summary_by: crate::ai::memory::SummaryBy::Rules,
            connection_id: None,
            database: None,
            kinds: Vec::new(),
            before: 10,
            after: 2,
            at: 11,
            undone: false,
            record: Default::default(),
            covers: None,
        }
    }

    #[test]
    fn migration_6_adds_memory_tables() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.sqlite");
        let t = thread("ungrouped", "kept", 5);
        {
            let s = AppStore::open(&path).unwrap();
            s.save_ai_thread(&t).unwrap();
            // Put the store back at schema 5.
            for table in ["ai_topic", "ai_topic_fts", "ai_compaction", "ai_tool_use"] {
                s.conn()
                    .execute_batch(&format!("DROP TABLE {table}"))
                    .unwrap();
            }
            s.conn().pragma_update(None, "user_version", 5).unwrap();
        }
        let s = AppStore::open(&path).unwrap();
        let v: i64 =
            s.db.query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        assert_eq!(s.list_ai_threads("ungrouped").unwrap(), vec![t]);
        for table in ["ai_topic", "ai_topic_fts", "ai_compaction"] {
            let n: i64 =
                s.db.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
                    params![table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "{table}");
        }
    }

    #[test]
    fn messages_capped_at_200_whole_turns() {
        let (_d, s) = open_tmp();
        let mut t = thread("ungrouped", "long", 1);
        // Five notices, then 100 turns: 205 messages.
        t.messages = (0..5)
            .map(|i| crate::ai::AiMessage {
                role: crate::ai::AiRole::Notice,
                text: "n".into(),
                context: Vec::new(),
                at: i,
                record: None,
                topic: None,
                connection_id: None,
                database: None,
                kinds: Vec::new(),
                tables: Vec::new(),
                action: None,
                asked_in: None,
            })
            .collect();
        for n in 0..100 {
            t.messages.extend(turn(1, 100 + n * 10, "q"));
        }
        s.save_ai_thread(&t).unwrap();
        let back = s.get_ai_thread(t.id).unwrap().unwrap();
        assert_eq!(back.messages.len(), 200);
        assert_eq!(back.messages[0].role, crate::ai::AiRole::User);

        // A cut that lands on an answer drops that turn's question too.
        let mut odd = thread("ungrouped", "odd", 2);
        odd.messages = t.messages[..1].to_vec();
        for n in 0..100 {
            odd.messages.extend(turn(1, 100 + n * 10, "q"));
        }
        odd.messages.push(t.messages[0].clone());
        assert_eq!(odd.messages.len(), 202);
        assert_eq!(odd.messages[2].role, crate::ai::AiRole::Assistant);
        s.save_ai_thread(&odd).unwrap();
        let back = s.get_ai_thread(odd.id).unwrap().unwrap();
        assert_eq!(back.messages.len(), 199);
        assert_eq!(back.messages[0].role, crate::ai::AiRole::User);
    }

    #[test]
    fn a_trim_drops_compactions_whose_range_is_gone() {
        let (_d, s) = open_tmp();
        let mut t = thread("ungrouped", "long", 1);
        t.messages = (0..101).flat_map(|n| turn(1, 100 + n * 10, "q")).collect();
        let gone = compaction_of(&t);
        let mut live = compaction_of(&t);
        live.first_at = 100;
        live.last_at = 1_500;
        s.save_ai_thread(&crate::ai::AiThread {
            messages: Vec::new(),
            ..t.clone()
        })
        .unwrap();
        for c in [&gone, &live] {
            crate::ai::memory::store::add_compaction(s.conn(), c).unwrap();
        }
        s.save_ai_thread(&t).unwrap();
        let left = crate::ai::memory::store::compactions(s.conn(), t.id).unwrap();
        assert_eq!(left.iter().map(|c| c.id).collect::<Vec<_>>(), vec![live.id]);
    }

    #[test]
    fn threads_capped_at_50_per_place() {
        let (_d, s) = open_tmp();
        let other = thread("group:g1", "other", 1);
        s.save_ai_thread(&other).unwrap();
        let mut first = None;
        for i in 0..51 {
            let mut t = thread("ungrouped", "t", 10 + i);
            t.messages = turn(1, 10 + i, "q");
            first.get_or_insert(t.id);
            s.save_ai_thread(&t).unwrap();
            crate::ai::memory::store::add_compaction(s.conn(), &compaction_of(&t)).unwrap();
        }
        // The compaction of the 51st thread is added after its save; the oldest thread
        // had its compaction removed when it fell out.
        let list = s.list_ai_threads("ungrouped").unwrap();
        assert_eq!(list.len(), 50);
        assert!(list.iter().all(|t| Some(t.id) != first));
        assert_eq!(count(&s, "ai_topic WHERE place = 'ungrouped'"), 50);
        assert_eq!(count(&s, "ai_topic_fts WHERE place = 'ungrouped'"), 50);
        assert!(
            crate::ai::memory::store::topics(s.conn(), first.unwrap())
                .unwrap()
                .is_empty()
        );
        assert_eq!(s.list_ai_threads("group:g1").unwrap(), vec![other]);
    }

    #[test]
    fn clear_removes_topics_and_compactions() {
        let (_d, s) = open_tmp();
        let make = |place: &str| {
            let mut t = thread(place, "t", 1);
            t.messages = turn(1, 1, "q");
            s.save_ai_thread(&t).unwrap();
            crate::ai::memory::store::add_compaction(s.conn(), &compaction_of(&t)).unwrap();
            t
        };
        let sizes = |s: &AppStore| {
            (
                count(s, "ai_topic"),
                count(s, "ai_topic_fts"),
                count(s, "ai_compaction"),
            )
        };
        let (a, b, c) = (make("p1"), make("p1"), make("p2"));
        assert_eq!(sizes(&s), (3, 3, 3));
        s.delete_ai_thread(a.id).unwrap();
        assert_eq!(sizes(&s), (2, 2, 2));
        s.clear_ai_threads("p1").unwrap();
        assert_eq!(sizes(&s), (1, 1, 1));
        assert!(s.get_ai_thread(b.id).unwrap().is_none());
        assert!(s.get_ai_thread(c.id).unwrap().is_some());
        s.clear_all_ai_threads().unwrap();
        assert_eq!(sizes(&s), (0, 0, 0));
    }

    /// An assistant message carrying a diagram tool use, or (`file` empty) an outline call.
    fn tooled(file: &str, at: i64) -> crate::ai::AiMessage {
        use crate::ai::sent::{AnswerRecord, OutlineSent, SentRecord, ToolUse};
        let record = if file.is_empty() {
            AnswerRecord {
                sent: Some(SentRecord {
                    outline: Some(OutlineSent {
                        tables: 10,
                        picked_tables: 3,
                        ..OutlineSent::default()
                    }),
                    ..SentRecord::default()
                }),
                ..AnswerRecord::default()
            }
        } else {
            AnswerRecord {
                tool_use: Some(ToolUse {
                    tool: "propose_diagram_changes".into(),
                    file: file.into(),
                    input: "{}".into(),
                    proposal: crate::ai::diagram::DiagramProposal {
                        file: file.into(),
                        base_hash: "h".into(),
                        changes: Vec::new(),
                    },
                    outcome: None,
                }),
                ..AnswerRecord::default()
            }
        };
        crate::ai::AiMessage {
            role: crate::ai::AiRole::Assistant,
            record: Some(record),
            at,
            ..turn(1, at, "q").remove(1)
        }
    }

    fn tooled_thread(place: &str, n: i64) -> crate::ai::AiThread {
        let mut t = thread(place, "t", n);
        t.messages = vec![tooled("orders", n * 10), tooled("", n * 10 + 1)];
        t
    }

    #[test]
    fn migration_7_fills_tool_uses() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.sqlite");
        let (a, b) = (
            tooled_thread("ungrouped", 1),
            thread("ungrouped", "plain", 2),
        );
        let mut c = thread("group:g1", "outline", 3);
        c.messages = vec![tooled("", 30)];
        {
            let s = AppStore::open(&path).unwrap();
            for t in [&a, &b, &c] {
                s.save_ai_thread(t).unwrap();
            }
            // Put the store back at schema 6.
            s.conn().execute_batch("DROP TABLE ai_tool_use").unwrap();
            s.conn().pragma_update(None, "user_version", 6).unwrap();
        }
        let s = AppStore::open(&path).unwrap();
        let v: i64 = s
            .conn()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        // One thread holds a tool use and an outline call, another an outline call.
        assert_eq!(count(&s, "ai_tool_use"), 3);
        let rows = tool_uses::recent(s.conn(), 10).unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().any(|r| r.target == "orders.flow"));
    }

    #[test]
    fn rows_follow_the_thread() {
        let (_d, s) = open_tmp();
        let (a, b, c) = (
            tooled_thread("p1", 1),
            tooled_thread("p1", 2),
            tooled_thread("p2", 3),
        );
        for t in [&a, &b, &c] {
            s.save_ai_thread(t).unwrap();
        }
        assert_eq!(count(&s, "ai_tool_use"), 6);
        // A message that goes leaves its row.
        let mut a2 = a.clone();
        a2.messages.pop();
        s.save_ai_thread(&a2).unwrap();
        assert_eq!(count(&s, "ai_tool_use"), 5);
        s.delete_ai_thread(a.id).unwrap();
        assert_eq!(count(&s, "ai_tool_use"), 4);
        s.clear_ai_threads("p1").unwrap();
        assert_eq!(count(&s, "ai_tool_use"), 2);
        s.clear_all_ai_threads().unwrap();
        assert_eq!(count(&s, "ai_tool_use"), 0);

        // Retention: the place's 51st thread drops the oldest with its rows.
        for i in 0..=THREAD_LIMIT {
            s.save_ai_thread(&tooled_thread("p3", i + 1)).unwrap();
        }
        assert_eq!(count(&s, "ai_tool_use"), 2 * THREAD_LIMIT);
        let orphans: i64 = s
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM ai_tool_use
                 WHERE thread_id NOT IN (SELECT id FROM ai_threads)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphans, 0);

        // Retention of messages: a trimmed message leaves its row.
        let mut long = thread("p4", "long", 1);
        long.messages = (0..MESSAGE_LIMIT as i64 + 20)
            .flat_map(|i| {
                let mut pair = turn(1, i * 2 + 1000, "q");
                pair[1] = tooled("orders", i * 2 + 1001);
                pair
            })
            .collect();
        s.save_ai_thread(&long).unwrap();
        let kept = s.get_ai_thread(long.id).unwrap().unwrap();
        let rows: i64 = s
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM ai_tool_use WHERE thread_id = ?1",
                params![long.id.to_string()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows as usize, kept.messages.len() / 2);
    }

    /// An answer whose record checked one SQL fence, on `shop` with `orders`.
    fn sql_answer(at: i64, sql: &str) -> crate::ai::AiMessage {
        use crate::ai::rails::output::SqlBlock;
        use crate::ai::sent::AnswerRecord;
        crate::ai::AiMessage {
            role: crate::ai::AiRole::Assistant,
            text: format!("Here:\n```sql\n{sql}\n```\n"),
            record: Some(AnswerRecord {
                sql_blocks: vec![SqlBlock {
                    fence: 0,
                    label: "1 statement: 1 read".into(),
                    statements: Vec::new(),
                    body_sha256: String::new(),
                }],
                ..AnswerRecord::default()
            }),
            at,
            connection_id: Some(Uuid::from_u128(7)),
            database: Some("shop".into()),
            ..turn(1, at, "q").remove(1)
        }
    }

    fn columns(s: &AppStore, id: Uuid) -> (String, String, Option<String>, i64) {
        s.conn()
            .query_row(
                "SELECT title, title_by, work, messages FROM ai_threads WHERE id = ?1",
                params![id.to_string()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap()
    }

    fn has_column(s: &AppStore, table: &str, column: &str) -> bool {
        super::has_column(s.conn(), table, column).unwrap()
    }

    #[test]
    fn write_keeps_the_four_columns_in_step() {
        let (_d, s) = open_tmp();
        let mut t = thread("ungrouped", "first title", 5);
        s.save_ai_thread(&t).unwrap();
        assert_eq!(
            columns(&s, t.id),
            ("first title".into(), "rule".into(), None, 1)
        );
        // A turn with SQL: the work names the place, never the SQL. A save never changes
        // the title (P3): only a rename or the AI's title call does.
        t.title = "second".into();
        t.messages.extend(turn(1, 10, "how many orders?"));
        t.messages
            .push(sql_answer(20, "select count(*) from secret_orders"));
        s.save_ai_thread(&t).unwrap();
        let (title, by, work, n) = columns(&s, t.id);
        assert_eq!((title.as_str(), by.as_str(), n), ("first title", "rule", 4));
        let work = work.expect("work");
        assert!(work.contains("\"shop\""), "{work}");
        assert!(!work.contains("secret_orders"), "{work}");
        // The cap trims the stored messages; the count follows what is stored.
        t.messages = (0..MESSAGE_LIMIT as i64 + 10)
            .flat_map(|i| turn(1, 100 + i * 2, "q"))
            .collect();
        s.save_ai_thread(&t).unwrap();
        let stored = s.get_ai_thread(t.id).unwrap().unwrap();
        assert_eq!(columns(&s, t.id).3 as usize, stored.messages.len());
        assert_eq!(columns(&s, t.id).2, None);
    }

    /// Task 3 carry (a): the `covers` column comes with schema 8 and only with it, from a
    /// schema 7 store that already has it (added in place by a build in between) and from
    /// one that does not.
    #[test]
    fn schema_8_folds_in_covers_with_or_without_it() {
        for had_covers in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("app.sqlite");
            let mut t = thread("ungrouped", "kept title", 5);
            t.messages.push(sql_answer(6, "select 1"));
            {
                let s = AppStore::open(&path).unwrap();
                s.save_ai_thread(&t).unwrap();
                // A row whose JSON reads, but not as a thread.
                s.conn()
                    .execute(
                        "INSERT INTO ai_threads (id, place, json, updated_at)
                         VALUES ('odd', 'ungrouped', '{\"title\":\"odd one\",\"messages\":[1,2,3]}', 1)",
                        [],
                    )
                    .unwrap();
                // A compaction kept with its cover before the downgrade.
                let mut kept = compaction_of(&t);
                kept.covers = Some(Vec::new());
                crate::ai::memory::store::add_compaction(s.conn(), &kept).unwrap();
                // Back to schema 7: no list index, no thread columns; `covers` as the case
                // says.
                s.conn()
                    .execute_batch(&format!("DROP INDEX {THREAD_LIST_INDEX}"))
                    .unwrap();
                for col in ["title", "title_by", "work", "messages"] {
                    s.conn()
                        .execute_batch(&format!("ALTER TABLE ai_threads DROP COLUMN {col}"))
                        .unwrap();
                }
                if !had_covers {
                    s.conn()
                        .execute_batch("ALTER TABLE ai_compaction DROP COLUMN covers")
                        .unwrap();
                }
                s.conn().pragma_update(None, "user_version", 7).unwrap();
            }
            let s = AppStore::open(&path).unwrap();
            let v: i64 = s
                .conn()
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            assert_eq!(v, 8, "had covers: {had_covers}");
            assert!(has_column(&s, "ai_compaction", "covers"));
            let (title, by, work, n) = columns(&s, t.id);
            assert_eq!((title.as_str(), by.as_str(), n), ("kept title", "rule", 2));
            assert!(work.is_some_and(|w| w.contains("shop")));
            let odd: (String, i64) = s
                .conn()
                .query_row(
                    "SELECT title, messages FROM ai_threads WHERE id = 'odd'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(odd, ("odd one".into(), 3));
            // A cover kept before the migration survives it; one without reads as unknown.
            let back = crate::ai::memory::store::compactions(s.conn(), t.id).unwrap();
            assert_eq!(back.len(), 1);
            let want = if had_covers { Some(Vec::new()) } else { None };
            assert_eq!(back[0].covers, want, "had covers: {had_covers}");
            // A compaction written now keeps its cover.
            let mut c = compaction_of(&t);
            c.covers = Some(Vec::new());
            crate::ai::memory::store::add_compaction(s.conn(), &c).unwrap();
            let back = crate::ai::memory::store::compactions(s.conn(), t.id).unwrap();
            assert_eq!(
                back.iter().find(|x| x.id == c.id).unwrap().covers,
                Some(Vec::new())
            );
            let index: i64 = s
                .conn()
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                    [THREAD_LIST_INDEX],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(index, 1);
            drop(s);
            // Opening again changes nothing.
            let s = AppStore::open(&path).unwrap();
            assert_eq!(columns(&s, t.id).0, "kept title");
        }
    }

    /// A schema 7 store never gains `covers` without the version: a new store is at 8.
    #[test]
    fn a_new_store_is_at_8_with_covers() {
        let (_d, s) = open_tmp();
        let v: i64 = s
            .conn()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 8);
        assert!(has_column(&s, "ai_compaction", "covers"));
        for col in ["title", "title_by", "work", "messages"] {
            assert!(has_column(&s, "ai_threads", col), "{col}");
        }
    }
}
