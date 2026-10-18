use crate::ai::{AiThread, ThreadId};
use crate::error::{Error, Result};
use crate::model::{ConnectionConfig, ConnectionId, Group, GroupId};
use crate::query::{
    HistoryEntry, HistoryFilter, HistoryOnly, NewHistory, Outcome, SavedQuery, SavedQueryKind,
    SavedQueryRun,
};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;

/// The `user_version` this build writes and understands.
const SCHEMA_VERSION: i64 = 4;

/// Chat threads returned per place.
pub const THREAD_LIMIT: i64 = 50;

/// Query History kept per Connection.
pub const HISTORY_LIMIT: i64 = 1000;

fn store_err(e: impl std::fmt::Display) -> Error {
    Error::Store(e.to_string())
}

/// SQLite store for Connections, Groups and settings. Passwords are never
/// stored here.
pub struct AppStore {
    db: Connection,
}

impl AppStore {
    pub fn open(path: &Path) -> Result<AppStore> {
        let db = Connection::open(path).map_err(store_err)?;
        // A safety net behind the single-instance guard: wait for a lock instead of failing.
        db.busy_timeout(std::time::Duration::from_millis(5000))
            .map_err(store_err)?;
        db.pragma_update(None, "journal_mode", "WAL")
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
            db.execute_batch(
                "BEGIN;
                 CREATE TABLE connections (id TEXT PRIMARY KEY, config_json TEXT NOT NULL);
                 CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL);
                 CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 PRAGMA user_version = 1;
                 COMMIT;",
            )
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
        Ok(AppStore { db })
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

    pub fn save_ai_thread(&self, t: &AiThread) -> Result<()> {
        let json = serde_json::to_string(t).map_err(store_err)?;
        self.db
            .execute(
                "INSERT OR REPLACE INTO ai_threads (id, place, json, updated_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![t.id.to_string(), t.place, json, t.updated_at],
            )
            .map_err(store_err)?;
        Ok(())
    }

    pub fn delete_ai_thread(&self, id: ThreadId) -> Result<()> {
        self.db
            .execute(
                "DELETE FROM ai_threads WHERE id = ?1",
                params![id.to_string()],
            )
            .map_err(store_err)?;
        Ok(())
    }

    pub fn clear_ai_threads(&self, place: &str) -> Result<()> {
        self.db
            .execute("DELETE FROM ai_threads WHERE place = ?1", params![place])
            .map_err(store_err)?;
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

    pub fn delete_connection(&self, id: ConnectionId) -> Result<()> {
        self.db
            .execute(
                "DELETE FROM connections WHERE id = ?1",
                params![id.to_string()],
            )
            .map_err(store_err)?;
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
            production: false,
            read_only: false,
        }
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
            }],
            updated_at,
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
        let mut a2 = a.clone();
        a2.title = "renamed".into();
        s.save_ai_thread(&a2).unwrap();
        assert_eq!(s.list_ai_threads("ungrouped").unwrap(), vec![a2.clone()]);
        s.delete_ai_thread(a2.id).unwrap();
        assert!(s.list_ai_threads("ungrouped").unwrap().is_empty());
        assert_eq!(s.list_ai_threads("group:g1").unwrap(), vec![b]);
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
        assert_eq!(n, 55);
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
            // Back to schema 2: no ai_threads, no Saved Visual Query columns.
            s.db.execute_batch(
                "DROP TABLE ai_threads;
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
        assert_eq!(v, 4);
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
    fn a_store_newer_than_4_is_refused() {
        assert_eq!(SCHEMA_VERSION, 4);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.sqlite");
        drop(AppStore::open(&path).unwrap());
        Connection::open(&path)
            .unwrap()
            .pragma_update(None, "user_version", 5)
            .unwrap();
        assert!(
            matches!(AppStore::open(&path), Err(Error::Store(m)) if m == "data folder was written by a newer Contura")
        );
    }
}
