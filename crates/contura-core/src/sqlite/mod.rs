mod introspect;
mod keys;
mod page;
mod session;
pub(crate) mod snapshot;
mod source;
mod sql_schema;
pub(crate) mod tokens;
mod writer;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{Connection, ErrorCode, OpenFlags, OptionalExtension};

use crate::common::quote_double;
use crate::design::{
    self, DesignOutcome, DesignPlan, LoadedSchema, Parts, RunControl, RunOutcome, StatementPlan,
};
use crate::dialect::Dialect;
use crate::edits::{PlannedEdit, TxOutcome};
use crate::error::{Error, Result, browse_result};
use crate::model::{
    ConnectionConfig, DbObject, DialectKind, FullValue, FullValueRequest, ObjectKind, ObjectPath,
    Page, PageRequest, SchemaInfo,
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
    // Create-new: a file that appeared since the check above is never taken over.
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(Error::InvalidInput(format!(
                "a file already exists at {}. Pick a new file name",
                path.display()
            )));
        }
        Err(e) => {
            return Err(Error::InvalidInput(format!(
                "cannot create {}: {e}",
                path.display()
            )));
        }
    }
    let fail =
        |e: rusqlite::Error| Error::InvalidInput(format!("cannot create {}: {e}", path.display()));
    let made = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .and_then(|conn| {
        // A fresh file stays zero bytes until something is written; this gives it a header.
        conn.pragma_update(None, "user_version", 0)
    });
    if let Err(e) = made {
        // The empty file this call made is not left behind.
        let _ = std::fs::remove_file(path);
        return Err(fail(e));
    }
    Ok(())
}

/// Step 11f: runs `work` on a connection of its own to `file`, opened read-only, inside
/// a transaction that is rolled back, with a 5 s busy timeout. A watchdog thread
/// interrupts the statement after 5 s (SQLite has no statement timeout).
async fn sample_session<T, F>(file: std::path::PathBuf, work: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&Connection) -> Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open_with_flags(
            &file,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| connect_err(&file, e))?;
        conn.busy_timeout(BUSY_TIMEOUT).map_err(query_err)?;
        let handle = conn.get_interrupt_handle();
        let (stop, stopped) = std::sync::mpsc::channel::<()>();
        let watchdog = std::thread::spawn(move || {
            let limit = Duration::from_millis(crate::dialect::SAMPLE_TIMEOUT_MS);
            if let Err(std::sync::mpsc::RecvTimeoutError::Timeout) = stopped.recv_timeout(limit) {
                handle.interrupt();
            }
        });
        let out = conn
            .execute_batch("BEGIN")
            .map_err(query_err)
            .and_then(|()| work(&conn));
        let _ = conn.execute_batch("ROLLBACK");
        drop(stop);
        let _ = watchdog.join();
        out
    })
    .await
    .map_err(|e| Error::Query(e.to_string()))?
}

impl SqliteDialect {
    /// Runs `sql` inside the sample read's setup (its own read-only connection, in a
    /// transaction that is rolled back). Public only for integration tests.
    #[cfg(any(test, feature = "test-util"))]
    #[doc(hidden)]
    pub async fn sample_probe(&self, _database: &str, sql: &str) -> Result<()> {
        let sql = sql.to_string();
        sample_session(self.path.clone(), move |c| {
            c.execute_batch(&sql).map_err(query_err)
        })
        .await
    }

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

    /// The first column of the first row of `sql` as an integer, from the browse
    /// connection. Public only for integration tests.
    #[cfg(any(test, feature = "test-util"))]
    #[doc(hidden)]
    pub async fn browse_i64_for_test(&self, sql: &str) -> Result<i64> {
        let sql = sql.to_string();
        self.run(move |c| c.query_row(&sql, [], |r| r.get(0)).map_err(query_err))
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

/// Runs `sql` to its first row. `Some` (the first column as text, empty when it
/// is not text or a number) when it returned a row.
fn first_row(conn: &Connection, sql: &str) -> rusqlite::Result<Option<String>> {
    let mut statement = conn.prepare(sql)?;
    let mut rows = statement.query([])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    Ok(Some(match row.get_ref(0) {
        Ok(rusqlite::types::ValueRef::Text(t)) => String::from_utf8_lossy(t).into_owned(),
        Ok(rusqlite::types::ValueRef::Integer(n)) => n.to_string(),
        _ => String::new(),
    }))
}

/// Runs a design plan on `conn`: refuses when `PRAGMA foreign_keys` is not the
/// value the plan was made with (S9), then the `before` statements, the middle in
/// one transaction, and the `after` statements whatever happened.
fn run_design(
    conn: &Connection,
    plan: &DesignPlan,
    parts: &Parts,
    read_only: bool,
    control: Option<&RunControl>,
) -> Result<DesignOutcome> {
    if let Some(loaded) = plan.foreign_keys {
        let on: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .map_err(query_err)?;
        if (on == 1) != loaded {
            return Err(Error::InvalidInput(design::FOREIGN_KEYS_CHANGED.into()));
        }
    }
    let outcome = run_design_body(conn, plan, parts, read_only, control);
    // This is the shared browse connection: whatever happened, no transaction may
    // stay open on it.
    if !conn.is_autocommit() {
        let _ = conn.execute_batch("ROLLBACK");
    }
    for at in parts.after.clone() {
        let sql = &plan.statements[at];
        if let Err(e) = first_row(conn, sql) {
            return Err(design::after_failed(&outcome, sql, &e.to_string()));
        }
    }
    outcome
}

/// The saved SQL of the table, its indexes and triggers, and the loaded views and
/// their triggers, is still what the plan was made from (S14). A rebuild built
/// from an older design would drop what was added since, so any difference refuses.
fn schema_unchanged(conn: &Connection, loaded: &LoadedSchema) -> rusqlite::Result<bool> {
    let master = format!("{}.sqlite_master", quote_double(&loaded.database));
    let key = |(kind, name, sql): &(String, String, String)| {
        (kind.clone(), name.to_lowercase(), sql.clone())
    };
    let mut found: Vec<(String, String, String)> = conn
        .prepare(&format!(
            "SELECT type, name, sql FROM {master} \
             WHERE tbl_name = ?1 COLLATE NOCASE AND sql IS NOT NULL"
        ))?
        .query_map([&loaded.table], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .iter()
        .map(key)
        .collect();
    let mut expected: Vec<_> = loaded.own.iter().map(key).collect();
    found.sort();
    expected.sort();
    if found != expected {
        return Ok(false);
    }
    let mut statement = conn.prepare(&format!(
        "SELECT sql FROM {master} WHERE type = ?1 AND name = ?2 COLLATE NOCASE"
    ))?;
    for (kind, name, sql) in &loaded.named {
        let now: Option<Option<String>> =
            statement.query_row((kind, name), |r| r.get(0)).optional()?;
        if now.flatten().as_deref() != Some(sql.as_str()) {
            return Ok(false);
        }
    }
    if let Some(children) = &loaded.children {
        // Every other table whose Foreign Keys point at the table, as saved now.
        let key = |(name, sql): &(String, String)| (name.to_lowercase(), sql.clone());
        let mut found: Vec<(String, String)> = conn
            .prepare(&format!(
                "SELECT m.name, m.sql FROM {master} m WHERE m.type = 'table' \
                 AND m.name <> ?1 COLLATE NOCASE AND m.sql IS NOT NULL \
                 AND EXISTS (SELECT 1 FROM pragma_foreign_key_list(m.name, ?2) f \
                 WHERE f.\"table\" = ?1 COLLATE NOCASE)"
            ))?
            .query_map((&loaded.table, &loaded.database), |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .map(key)
            .collect();
        let mut expected: Vec<_> = children.iter().map(key).collect();
        found.sort();
        expected.sort();
        if found != expected {
            return Ok(false);
        }
    }
    Ok(true)
}

fn run_design_body(
    conn: &Connection,
    plan: &DesignPlan,
    parts: &Parts,
    read_only: bool,
    control: Option<&RunControl>,
) -> Result<DesignOutcome> {
    let failed = |statement: usize, e: rusqlite::Error| {
        if read_only && is_read_only_refusal(&e) {
            return Err(Error::ReadOnlyRefused);
        }
        Ok(DesignOutcome::Failed {
            statement,
            ran: 0,
            message: e.to_string(),
        })
    };
    for at in parts.before.clone() {
        if design::stop(control, at) {
            return Ok(DesignOutcome::Cancelled { ran: 0 });
        }
        if let Err(e) = first_row(conn, &plan.statements[at]) {
            return failed(at, e);
        }
    }
    // IMMEDIATE takes the write lock up front, so no other writer gets in between statements.
    conn.execute_batch("BEGIN IMMEDIATE").map_err(query_err)?;
    // With the write lock held, the table cannot change between this check and the change.
    if let Some(loaded) = &plan.loaded
        && !schema_unchanged(conn, loaded).map_err(query_err)?
    {
        let _ = rollback(conn);
        return Err(Error::InvalidInput(design::TABLE_CHANGED.into()));
    }
    for at in parts.middle.clone() {
        if design::stop(control, at) {
            let _ = rollback(conn);
            return Ok(DesignOutcome::Cancelled { ran: 0 });
        }
        match first_row(conn, &plan.statements[at]) {
            Ok(None) => {}
            // A row from any statement in the middle is a failed check.
            // `run_design` rolls back again if this ROLLBACK fails.
            Ok(Some(first)) => {
                let _ = rollback(conn);
                return Ok(design::returned_row(plan, at, 0, Some(first)));
            }
            Err(e) => {
                let _ = rollback(conn);
                return failed(at, e);
            }
        }
    }
    conn.execute_batch("COMMIT").map_err(query_err)?;
    Ok(DesignOutcome::Done {
        ran: plan.statements.len(),
    })
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

    async fn sample_rows(&self, path: &ObjectPath, limit: u32) -> Result<Page> {
        let path = path.clone();
        sample_session(self.path.clone(), move |c| {
            page::sample_rows(c, &path, limit)
        })
        .await
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

    async fn schema_fingerprint(&self, database: &str, _schema: Option<&str>) -> Result<String> {
        let database = database.to_string();
        self.run(move |c| snapshot::schema_fingerprint(c, &database))
            .await
    }

    async fn table_design(&self, path: &ObjectPath) -> Result<crate::design::TableDesign> {
        let path = path.clone();
        self.run(move |c| snapshot::table_design(c, &path)).await
    }

    async fn key_edges(
        &self,
        database: &str,
        _schema: Option<&str>,
    ) -> Result<Vec<crate::lineage::KeyEdge>> {
        let database = database.to_string();
        self.run(move |c| keys::key_edges(c, &database)).await
    }

    async fn key_tables(
        &self,
        database: &str,
        _schema: Option<&str>,
        tables: &[String],
    ) -> Result<Vec<crate::lineage::KeyTable>> {
        let database = database.to_string();
        let tables = tables.to_vec();
        self.run(move |c| keys::key_tables(c, &database, &tables))
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

    /// SQLite has one database per file, so `database` is not used.
    async fn apply_design(&self, _database: &str, plan: &DesignPlan) -> Result<DesignOutcome> {
        let parts = design::runnable(plan)?;
        let plan = plan.clone();
        let read_only = self.read_only;
        // One `run`: the connection lock is held from the first statement to the last
        // `after` statement, so nothing else uses the connection in between.
        self.run(move |c| run_design(c, &plan, &parts, read_only, None))
            .await
    }

    /// SQLite has one database per file, so `database` is not used.
    async fn run_statements(
        &self,
        _database: &str,
        plan: &StatementPlan,
        control: RunControl,
    ) -> Result<RunOutcome> {
        let design = design::statement_design_plan(DialectKind::Sqlite, plan)?;
        let parts = design::runnable(&design)?;
        let of = design.statements.len();
        let read_only = self.read_only;
        // One `run`, as for `apply_design`: the lock is held from first to last statement.
        let outcome = self
            .run(move |c| run_design(c, &design, &parts, read_only, Some(&control)))
            .await?;
        design::run_outcome(outcome, of)
    }

    async fn open_row_source(
        &self,
        req: &crate::jobs::source::SourceRequest,
    ) -> Result<Box<dyn crate::jobs::source::RowSource>> {
        source::open(self.path.clone(), req).await
    }

    async fn table_storage(&self, path: &ObjectPath) -> Result<crate::jobs::source::TableStorage> {
        let database = path.database.clone();
        let wal = self
            .run(move |c| source::journal_is_wal(c, &database))
            .await?;
        Ok(crate::jobs::source::TableStorage {
            transactional: true,
            engine: None,
            sqlite_wal: Some(wal),
        })
    }

    async fn open_bulk_writer(
        &self,
        database: Option<&str>,
        setup: &crate::jobs::writer::WriterSetup,
    ) -> Result<Box<dyn crate::jobs::writer::BulkWriter>> {
        // A SQLite Connection is one file: `database` names nothing more to open.
        let _ = database;
        writer::open(self.path.clone(), self.read_only, setup.clone()).await
    }

    /// A SQLite file is one database: `database` and `schema` are not used, and every
    /// table's rows are counted whatever `count_rows` says.
    async fn open_backup_read(
        &self,
        _database: &str,
        _schema: Option<&str>,
        _count_rows: bool,
    ) -> Result<crate::backup::data::SnapshotRead> {
        source::backup_read(self.path.clone()).await
    }

    async fn backup_file_copy(&self, into: &Path) -> Result<()> {
        let path = self.path.clone();
        let into = into.to_path_buf();
        tokio::task::spawn_blocking(move || source::file_copy(&path, &into))
            .await
            .map_err(|e| Error::Query(format!("the file copy stopped: {e}")))?
    }

    async fn disconnect(&self) -> Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::design::DesignMode;

    fn readonly_failure() -> rusqlite::Error {
        rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(8), None)
    }

    /// One leading and one trailing statement, as a rebuild has.
    fn plan(statements: &[&str], before: usize, checks: Vec<usize>) -> DesignPlan {
        DesignPlan {
            statements: statements.iter().map(|s| s.to_string()).collect(),
            warnings: vec![],
            mode: DesignMode::Transaction,
            before,
            after: 1,
            checks,
            foreign_keys: Some(true),
            loaded: None,
        }
    }

    fn keys_on() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON; CREATE TABLE a (n int); INSERT INTO a VALUES (1);",
        )
        .unwrap();
        conn
    }

    fn run(conn: &Connection, plan: &DesignPlan) -> Result<DesignOutcome> {
        let parts = design::runnable(plan).unwrap();
        run_design(conn, plan, &parts, false, None)
    }

    fn int(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_check_that_returns_a_row_rolls_back_and_after_runs() {
        let conn = keys_on();
        let p = plan(
            &[
                "PRAGMA foreign_keys = OFF",
                "CREATE TABLE x (n int)",
                "SELECT count(*) FROM a EXCEPT SELECT 0",
                "PRAGMA foreign_keys = ON",
            ],
            1,
            vec![2],
        );
        assert_eq!(
            run(&conn, &p).unwrap(),
            DesignOutcome::Failed {
                statement: 2,
                ran: 0,
                message: "The copy of the table has a different number of rows than the table."
                    .into()
            }
        );
        assert_eq!(
            int(&conn, "SELECT count(*) FROM sqlite_master WHERE name = 'x'"),
            0
        );
        assert_eq!(int(&conn, "PRAGMA foreign_keys"), 1);
        assert!(conn.is_autocommit());
    }

    #[test]
    fn any_statement_in_the_middle_that_returns_a_row_fails() {
        let conn = keys_on();
        let p = plan(
            &[
                "PRAGMA foreign_keys = OFF",
                "CREATE TABLE x (n int)",
                "SELECT n FROM a",
                "PRAGMA foreign_keys = ON",
            ],
            1,
            vec![],
        );
        match run(&conn, &p).unwrap() {
            DesignOutcome::Failed {
                statement: 2,
                ran: 0,
                message,
            } => assert!(message.contains("returned rows"), "{message}"),
            other => panic!("expected Failed, got {other:?}"),
        }
        assert_eq!(
            int(&conn, "SELECT count(*) FROM sqlite_master WHERE name = 'x'"),
            0
        );
        assert_eq!(int(&conn, "PRAGMA foreign_keys"), 1);
    }

    #[test]
    fn a_failed_leading_statement_still_runs_after() {
        let conn = keys_on();
        let p = plan(
            &[
                "PRAGMA foreign_keys = OFF",
                "SELECT * FROM missing",
                "CREATE TABLE x (n int)",
                "PRAGMA foreign_keys = ON",
            ],
            2,
            vec![],
        );
        match run(&conn, &p).unwrap() {
            DesignOutcome::Failed {
                statement: 1,
                ran: 0,
                message,
            } => assert!(message.contains("missing"), "{message}"),
            other => panic!("expected Failed, got {other:?}"),
        }
        assert_eq!(
            int(&conn, "SELECT count(*) FROM sqlite_master WHERE name = 'x'"),
            0
        );
        assert_eq!(int(&conn, "PRAGMA foreign_keys"), 1);
    }

    #[test]
    fn success_commits_and_after_runs() {
        let conn = keys_on();
        let p = plan(
            &[
                "PRAGMA foreign_keys = OFF",
                "CREATE TABLE x (n int)",
                "PRAGMA foreign_key_check(\"x\")",
                "PRAGMA foreign_keys = ON",
            ],
            1,
            vec![2],
        );
        assert_eq!(run(&conn, &p).unwrap(), DesignOutcome::Done { ran: 4 });
        assert_eq!(
            int(&conn, "SELECT count(*) FROM sqlite_master WHERE name = 'x'"),
            1
        );
        assert_eq!(int(&conn, "PRAGMA foreign_keys"), 1);
    }

    #[test]
    fn a_failed_after_statement_says_whether_the_change_was_applied() {
        let conn = keys_on();
        let p = plan(
            &[
                "PRAGMA foreign_keys = OFF",
                "CREATE TABLE x (n int)",
                "SELECT * FROM missing_after",
            ],
            1,
            vec![],
        );
        match run(&conn, &p) {
            Err(Error::DesignRestoreFailed {
                applied: true,
                sql,
                message,
            }) => {
                assert_eq!(sql, "SELECT * FROM missing_after");
                assert!(message.contains("missing_after"), "{message}");
            }
            other => panic!("expected DesignRestoreFailed, applied, got {other:?}"),
        }
        assert_eq!(
            int(&conn, "SELECT count(*) FROM sqlite_master WHERE name = 'x'"),
            1
        );
        // The failed restore left Foreign Keys off; this test turns them back on.
        assert_eq!(int(&conn, "PRAGMA foreign_keys"), 0);
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();

        let p = plan(
            &[
                "PRAGMA foreign_keys = OFF",
                "CREATE TABLE a (n int)",
                "SELECT * FROM missing_after",
            ],
            1,
            vec![],
        );
        assert!(matches!(
            run(&conn, &p),
            Err(Error::DesignRestoreFailed { applied: false, .. })
        ));
    }

    #[test]
    fn a_plan_that_does_not_fit_its_statements_is_refused() {
        let mut p = plan(&["PRAGMA foreign_keys = OFF"], 1, vec![]);
        assert!(matches!(design::runnable(&p), Err(Error::InvalidInput(_))));
        p.after = 0;
        p.checks = vec![3];
        assert!(matches!(design::runnable(&p), Err(Error::InvalidInput(_))));
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
