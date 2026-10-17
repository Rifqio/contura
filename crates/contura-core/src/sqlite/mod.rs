mod introspect;
mod page;
mod session;
mod snapshot;
mod sql_schema;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{Connection, ErrorCode, OpenFlags};

use crate::dialect::Dialect;
use crate::edits::{PlannedEdit, TxOutcome};
use crate::error::{Error, Result, browse_result};
use crate::model::{
    ConnectionConfig, DbObject, FullValue, FullValueRequest, ObjectKind, ObjectPath, Page,
    PageRequest, SchemaInfo,
};

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

pub struct SqliteDialect {
    conn: Arc<Mutex<Connection>>,
    /// Query sessions open their own connection to this file.
    path: std::path::PathBuf,
    read_only: bool,
}

fn is_read_only_refusal(e: &rusqlite::Error) -> bool {
    matches!(e, rusqlite::Error::SqliteFailure(f, _) if f.code == ErrorCode::ReadOnly)
}

/// Browse code uses this. `SqliteDialect::run` passes its result through
/// `browse_result`, which turns a refusal into a plain error on a Connection that is
/// not Read-only.
pub(crate) fn query_err(e: rusqlite::Error) -> Error {
    if is_read_only_refusal(&e) {
        Error::ReadOnlyRefused
    } else {
        Error::Query(e.to_string())
    }
}

/// A read-only refusal reads as "this Connection is Read-only" only when the Connection is.
pub(crate) fn session_err(e: rusqlite::Error, read_only: bool) -> Error {
    if !read_only && is_read_only_refusal(&e) {
        Error::Query(e.to_string())
    } else {
        query_err(e)
    }
}

fn is_not_a_database(e: &rusqlite::Error) -> bool {
    matches!(e, rusqlite::Error::SqliteFailure(f, _) if f.code == ErrorCode::NotADatabase)
}

fn connect_err(path: &Path, e: rusqlite::Error) -> Error {
    if is_not_a_database(&e) {
        Error::Connect(format!("{} is not a SQLite database", path.display()))
    } else {
        Error::Connect(format!("cannot open {}: {e}", path.display()))
    }
}

/// A read-only connection is opened without write access, so the file itself refuses writes.
fn open_existing(path: &Path, read_only: bool) -> Result<Connection> {
    if !path.exists() {
        return Err(Error::Connect(format!(
            "cannot open {}: the file does not exist",
            path.display()
        )));
    }
    let access = if read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    };
    let conn = Connection::open_with_flags(path, access | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| connect_err(path, e))?;
    conn.busy_timeout(BUSY_TIMEOUT)
        .map_err(|e| connect_err(path, e))?;
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
        r.get::<_, i64>(0)
    })
    .map_err(|e| connect_err(path, e))?;
    Ok(conn)
}

/// Creates an empty SQLite database file. Never overwrites anything.
pub fn create_database(path: &Path) -> Result<()> {
    if path.exists() {
        return Err(Error::InvalidInput(format!(
            "a file already exists at {}. Pick a new file name",
            path.display()
        )));
    }
    let fail =
        |e: rusqlite::Error| Error::InvalidInput(format!("cannot create {}: {e}", path.display()));
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(fail)?;
    // A fresh file stays zero bytes until something is written; this gives it a header.
    conn.pragma_update(None, "user_version", 0).map_err(fail)?;
    Ok(())
}

impl SqliteDialect {
    /// The password is ignored: SQLite files have none.
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let path = config
            .file
            .clone()
            .ok_or_else(|| Error::InvalidInput("choose a SQLite file".into()))?;
        let opened = path.clone();
        let read_only = config.read_only;
        let conn = tokio::task::spawn_blocking(move || open_existing(&opened, read_only))
            .await
            .map_err(|e| Error::Connect(e.to_string()))??;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            path,
            read_only,
        })
    }

    /// Runs one statement on the browse connection. Public only for integration tests.
    #[cfg(any(test, feature = "test-util"))]
    #[doc(hidden)]
    pub async fn browse_execute_for_test(&self, sql: &str) -> Result<()> {
        let sql = sql.to_string();
        let read_only = self.read_only;
        self.run(move |c| c.execute_batch(&sql).map_err(|e| session_err(e, read_only)))
            .await
    }

    async fn run<T, F>(&self, work: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T> + Send + 'static,
    {
        let conn = self.conn.clone();
        let result = tokio::task::spawn_blocking(move || {
            let guard = conn
                .lock()
                .map_err(|_| Error::Query("connection lock poisoned".into()))?;
            work(&guard)
        })
        .await
        .map_err(|e| Error::Query(e.to_string()))?;
        browse_result(result, self.read_only)
    }
}

/// Runs a save on `conn`. An error on a statement rolls back and is `Failed`, except a
/// read-only refusal on a Read-only Connection, which is `ReadOnlyRefused`.
fn run_planned(conn: &Connection, edits: &[PlannedEdit], read_only: bool) -> Result<TxOutcome> {
    // IMMEDIATE takes the write lock up front, so no other writer gets in between statements.
    conn.execute_batch("BEGIN IMMEDIATE").map_err(query_err)?;
    let result = run_in_transaction(conn, edits, read_only);
    // This is the shared browse connection: whatever happened (a busy COMMIT, a failed
    // ROLLBACK), no transaction may stay open on it.
    if !conn.is_autocommit() {
        let _ = conn.execute_batch("ROLLBACK");
    }
    result
}

/// Rolls back unless SQLite already did (it does on some errors, such as
/// `ON CONFLICT ROLLBACK`, SQLITE_FULL or an I/O error).
fn rollback(conn: &Connection) -> Result<()> {
    if conn.is_autocommit() {
        return Ok(());
    }
    conn.execute_batch("ROLLBACK").map_err(query_err)
}

fn run_in_transaction(
    conn: &Connection,
    edits: &[PlannedEdit],
    read_only: bool,
) -> Result<TxOutcome> {
    let mut rows = Vec::with_capacity(edits.len());
    for (statement, edit) in edits.iter().enumerate() {
        let affected = match conn.execute(&edit.sql, []) {
            Ok(n) => n as u64,
            Err(e) => {
                rollback(conn)?;
                if read_only && is_read_only_refusal(&e) {
                    return Err(Error::ReadOnlyRefused);
                }
                return Ok(TxOutcome::Failed {
                    statement,
                    message: e.to_string(),
                });
            }
        };
        if edit.one_row && affected != 1 {
            rollback(conn)?;
            return Ok(TxOutcome::RowCount {
                statement,
                rows: affected,
            });
        }
        rows.push(affected);
    }
    conn.execute_batch("COMMIT").map_err(query_err)?;
    Ok(TxOutcome::Committed { rows })
}

#[async_trait::async_trait]
impl Dialect for SqliteDialect {
    async fn server_version(&self) -> Result<String> {
        self.run(|c| {
            c.query_row("SELECT sqlite_version()", [], |r| r.get(0))
                .map_err(query_err)
        })
        .await
    }

    async fn list_databases(&self) -> Result<Vec<String>> {
        self.run(introspect::list_databases).await
    }

    async fn list_schemas(&self, _database: &str) -> Result<Vec<SchemaInfo>> {
        Ok(Vec::new())
    }

    async fn list_objects(&self, database: &str, _schema: Option<&str>) -> Result<Vec<DbObject>> {
        let database = database.to_string();
        self.run(move |c| introspect::list_objects(c, &database))
            .await
    }

    async fn object_definition(&self, kind: ObjectKind, path: &ObjectPath) -> Result<String> {
        let path = path.clone();
        self.run(move |c| introspect::object_definition(c, kind, &path))
            .await
    }

    async fn fetch_page(&self, req: &PageRequest) -> Result<Page> {
        let req = req.clone();
        self.run(move |c| page::fetch_page(c, &req)).await
    }

    async fn fetch_full_value(&self, req: &FullValueRequest) -> Result<FullValue> {
        let req = req.clone();
        self.run(move |c| page::fetch_full_value(c, &req)).await
    }

    async fn schema_snapshot(
        &self,
        database: &str,
        _schema: Option<&str>,
    ) -> Result<crate::schema_model::SchemaModel> {
        let database = database.to_string();
        self.run(move |c| snapshot::schema_snapshot(c, &database))
            .await
    }

    async fn sql_schema(&self, database: &str) -> Result<crate::sql_schema::SqlSchema> {
        let database = database.to_string();
        self.run(move |c| sql_schema::sql_schema(c, &database))
            .await
    }

    async fn open_query_session(
        &self,
        _database: Option<&str>,
    ) -> Result<crate::query::SessionHandle> {
        let path = self.path.clone();
        let read_only = self.read_only;
        tokio::task::spawn_blocking(move || session::spawn(path, read_only))
            .await
            .map_err(|e| Error::Connect(e.to_string()))?
    }

    /// SQLite has one database per file, so `database` is not used.
    async fn apply_planned(&self, _database: &str, edits: &[PlannedEdit]) -> Result<TxOutcome> {
        let edits = edits.to_vec();
        let read_only = self.read_only;
        // One `run`: the connection lock is held from BEGIN to COMMIT or ROLLBACK.
        self.run(move |c| run_planned(c, &edits, read_only)).await
    }

    async fn disconnect(&self) -> Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn readonly_failure() -> rusqlite::Error {
        rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(8), None)
    }

    #[test]
    fn read_only_refusal_maps_only_on_a_read_only_connection() {
        assert!(matches!(
            session_err(readonly_failure(), true),
            Error::ReadOnlyRefused
        ));
        assert!(matches!(
            session_err(readonly_failure(), false),
            Error::Query(_)
        ));
    }
}
