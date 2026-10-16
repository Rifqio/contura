use crate::error::{Error, Result};
use crate::model::{ConnectionConfig, ConnectionId, Group, GroupId};
use crate::query::{HistoryEntry, HistoryFilter, HistoryOnly, NewHistory, Outcome, SavedQuery};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;

/// The `user_version` this build writes and understands.
const SCHEMA_VERSION: i64 = 2;

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
                "data folder was written by a newer DB View".into(),
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
        Ok(AppStore { db })
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
    pub fn query_history(
        &self,
        conn: ConnectionId,
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
            "SELECT id, sql, ran_at_ms, elapsed_ms, outcome, rows, changed, error FROM query_history
             WHERE connection_id = ?1 AND (?2 IS NULL OR sql LIKE ?2 ESCAPE '\\'){only}
             ORDER BY id DESC LIMIT ?3"
        );
        let mut stmt = self.db.prepare(&sql).map_err(store_err)?;
        let rows = stmt
            .query_map(params![conn.to_string(), pattern, HISTORY_LIMIT], |r| {
                Ok(HistoryEntry {
                    id: r.get(0)?,
                    connection_id: conn,
                    sql: r.get(1)?,
                    ran_at_ms: r.get(2)?,
                    elapsed_ms: r.get::<_, i64>(3)? as u64,
                    outcome: Outcome::parse(&r.get::<_, String>(4)?).unwrap_or(Outcome::Error),
                    rows: r.get::<_, Option<i64>>(5)?.map(|n| n as u64),
                    changed: r.get(6)?,
                    error: r.get(7)?,
                })
            })
            .map_err(store_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(store_err)
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
            .prepare("SELECT id, name, sql, updated_at_ms FROM saved_queries ORDER BY name COLLATE NOCASE")
            .map_err(store_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .map_err(store_err)?;
        let mut out = Vec::new();
        for row in rows {
            let (id, name, sql, updated_at_ms) = row.map_err(store_err)?;
            out.push(SavedQuery {
                id: id.parse().map_err(store_err)?,
                name,
                sql,
                updated_at_ms,
            });
        }
        Ok(out)
    }

    /// Fails with `InvalidInput` when another Saved Query has the same name, ignoring case.
    pub fn save_saved_query(&self, q: &SavedQuery) -> Result<()> {
        let saved = self.db.execute(
            "INSERT INTO saved_queries (id, name, sql, updated_at_ms) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, sql = excluded.sql,
               updated_at_ms = excluded.updated_at_ms",
            params![q.id.to_string(), q.name, q.sql, q.updated_at_ms],
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
            color: GroupColor::Red,
        };
        s.save_group(&g).unwrap();
        let b = Group {
            id: Uuid::new_v4(),
            name: "alpha".into(),
            color: GroupColor::Blue,
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
            color: GroupColor::Red,
        };
        let b = Group {
            id: Uuid::new_v4(),
            name: "B".into(),
            color: GroupColor::Green,
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
            Err(Error::Store(msg)) => assert_eq!(msg, "data folder was written by a newer DB View"),
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
        assert_eq!(v, 2);
        assert!(s.query_history(Uuid::new_v4(), &all()).unwrap().is_empty());
    }

    fn all() -> HistoryFilter {
        HistoryFilter {
            search: None,
            only: None,
        }
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
        let h = s.query_history(a, &all()).unwrap();
        assert_eq!(h.len(), 1000);
        assert_eq!(h[0].sql, "SELECT 1004");
        assert_eq!(h[999].sql, "SELECT 5");
        assert_eq!(s.query_history(b, &all()).unwrap().len(), 1);
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
            s.query_history(a, &f)
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
        assert!(s.query_history(a, &all()).unwrap().is_empty());
    }

    #[test]
    fn setting_round_trips() {
        let (_d, s) = open_tmp();
        assert_eq!(s.get_setting("theme").unwrap(), None);
        s.set_setting("theme", "dark").unwrap();
        s.set_setting("theme", "light").unwrap();
        assert_eq!(s.get_setting("theme").unwrap(), Some("light".to_string()));
    }
}
