use std::path::Path;
use std::sync::Arc;

use crate::backup::data::SnapshotRead;
use crate::design::{
    DesignOutcome, DesignPlan, RunControl, RunOutcome, StatementPlan, TableDesign,
};
use crate::edits::{PlannedEdit, TxOutcome};
use crate::error::Result;
use crate::jobs::source::{RowSource, SourceRequest, TableStorage};
use crate::jobs::writer::{BulkWriter, WriterSetup};
use crate::lineage::{KeyEdge, KeyTable};
use crate::model::{
    ConnectionConfig, CountRequest, DbObject, DialectKind, FullValue, FullValueRequest,
    LocateRequest, ObjectKind, ObjectPath, Page, PageRequest, RowCount, RowPlace, SchemaInfo,
};
use crate::mysql::MySqlDialect;
use crate::postgres::PostgresDialect;
use crate::query::SessionHandle;
use crate::schema_model::SchemaModel;
use crate::sql_schema::SqlSchema;
use crate::sqlite::SqliteDialect;

/// Step 11f: how long a sample read may run, in every Dialect.
pub const SAMPLE_TIMEOUT_MS: u64 = 5_000;

/// UX step 8: how long a row count may run on the server before it stops itself.
pub const COUNT_TIMEOUT_MS: u64 = 3_000;

#[async_trait::async_trait]
pub trait Dialect: Send + Sync {
    async fn server_version(&self) -> Result<String>;
    async fn list_databases(&self) -> Result<Vec<String>>;
    /// MySQL has no schema level, so its Dialect always returns an empty list.
    async fn list_schemas(&self, database: &str) -> Result<Vec<SchemaInfo>>;
    async fn list_objects(&self, database: &str, schema: Option<&str>) -> Result<Vec<DbObject>>;
    async fn object_definition(&self, kind: ObjectKind, path: &ObjectPath) -> Result<String>;
    async fn fetch_page(&self, req: &PageRequest) -> Result<Page>;
    async fn fetch_full_value(&self, req: &FullValueRequest) -> Result<FullValue>;
    /// UX step 8: how many rows match `req`'s filter, up to `COUNT_CAP + 1`. Runs off the
    /// browse session (its own connection), read-only, and the server stops it after
    /// `timeout_ms`, which reads as `TimedOut`. The filter is the page's, one statement.
    async fn count_rows(&self, req: &CountRequest, timeout_ms: u64) -> Result<RowCount> {
        let _ = (req, timeout_ms);
        Err(crate::error::Error::InvalidInput(
            "row counts are not available here".into(),
        ))
    }
    /// M3: where the row with `req.key` is under the page's sort and filter: the same order a
    /// page is fetched in, counted by the server (a window over the filtered rows). Runs as
    /// `count_rows` does: its own read-only connection, stopped after `timeout_ms`.
    async fn locate_row(&self, req: &LocateRequest, timeout_ms: u64) -> Result<RowPlace> {
        let _ = (req, timeout_ms);
        Err(crate::error::Error::InvalidInput(
            "finding a row is not available here".into(),
        ))
    }
    /// Step 11f: up to `limit` live rows of one base table for an AI Ask, as the grid
    /// reads them (same select list and cells). No ORDER BY, no OFFSET, no filter,
    /// `has_more` false. Runs in a read-only transaction on a connection that is not
    /// the browse one, with a 5 s limit. `InvalidInput("not a table")` for a view or
    /// any other kind, `NotFound` for a missing table.
    async fn sample_rows(&self, path: &ObjectPath, limit: u32) -> Result<Page> {
        let _ = (path, limit);
        Err(crate::error::Error::InvalidInput(
            "sample rows are not available here".into(),
        ))
    }
    /// Reads one database (MySQL, SQLite) or one schema (Postgres) as a Schema Model. Read only.
    async fn schema_snapshot(&self, database: &str, schema: Option<&str>) -> Result<SchemaModel>;
    /// A short text that changes when the structure `schema_snapshot` reads changes
    /// (tables, columns, defaults, keys, indexes, comments, enum labels) and stays equal
    /// when only rows change. One catalog read, no table scans, no special rights.
    async fn schema_fingerprint(&self, database: &str, schema: Option<&str>) -> Result<String>;
    /// Reads one table for the Table Designer, with the real names of its indexes and
    /// keys. Read only. `NotFound` with the table's name when there is no such table.
    async fn table_design(&self, path: &ObjectPath) -> Result<TableDesign>;
    /// Lineage (B2, P6): every Foreign Key held by a table of one database (MySQL, SQLite)
    /// or schema (PostgreSQL) or pointing into it, in one catalog read. No row data.
    async fn key_edges(&self, database: &str, schema: Option<&str>) -> Result<Vec<KeyEdge>>;
    /// Lineage: the columns, types, nullability and primary key parts of `tables` in one
    /// database or schema, in one catalog read. A table that is not there is left out.
    async fn key_tables(
        &self,
        database: &str,
        schema: Option<&str>,
        tables: &[String],
    ) -> Result<Vec<KeyTable>>;
    /// Lineage's Views source: the views the catalog records as reading `table`, by schema
    /// (or database) and name, at most `limit`. `None` when the server keeps no such record
    /// (SQLite, MySQL before 8.0.13); the UI then falls back to a name match. Catalog only.
    async fn view_dependencies(
        &self,
        table: &ObjectPath,
        limit: usize,
    ) -> Result<Option<Vec<ObjectPath>>> {
        let _ = (table, limit);
        Ok(None)
    }
    /// The table's CREATE statements for copying, as the server holds the table (D14).
    /// MySQL and SQLite keep the text; PostgreSQL writes it from its catalog.
    async fn table_ddl(&self, path: &ObjectPath) -> Result<String> {
        self.object_definition(ObjectKind::Table, path).await
    }
    /// Names, kinds, column types and Foreign Keys of one database (tables and views), for the editor. No row data.
    async fn sql_schema(&self, database: &str) -> Result<SqlSchema>;
    /// A new connection of its own for one query tab (`database` is ignored by SQLite).
    async fn open_query_session(&self, database: Option<&str>) -> Result<SessionHandle>;
    /// Runs a planned save in one transaction on a connection of its own (SQLite: the
    /// browse connection, held for the whole save). A row count other than 1 after an
    /// UPDATE or DELETE, or a server error, rolls back and is a `TxOutcome`; `Err` means
    /// the connection failed, or the server refused the write on a Read-only Connection.
    async fn apply_planned(&self, database: &str, edits: &[PlannedEdit]) -> Result<TxOutcome>;
    /// Runs a design plan on a connection of its own (SQLite: the browse connection,
    /// held for the whole plan). PostgreSQL and SQLite run the middle of the plan in
    /// one transaction that a failure, or any statement returning a row (a failed
    /// check), rolls back; MySQL runs statement by statement (its DDL commits each
    /// one) and stops at the first failure. The plan's `after` statements run
    /// whatever happened. A `CopyOnly` plan is refused before any statement. `Err`
    /// means the connection failed, or the server refused on a Read-only Connection.
    async fn apply_design(&self, database: &str, plan: &DesignPlan) -> Result<DesignOutcome>;
    /// Runs a statement list of any length with `apply_design`'s runner: PostgreSQL
    /// and SQLite in one transaction (SQLite with the `sqlite_pragma_frame` lines
    /// when `sqlite_pragmas`), MySQL statement by statement, stopping at the first
    /// failure. `cancel` is checked before each statement: a cancel rolls back the
    /// transaction, or on MySQL stops with what already ran. A mode the Dialect does
    /// not run this way is refused before any statement. A failure is
    /// `Error::DesignFailed` (or `DesignForeignKeys` for a `foreign_key_check` row).
    async fn apply_statements(
        &self,
        database: &str,
        plan: &StatementPlan,
        cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<RunOutcome> {
        self.run_statements(database, plan, RunControl::new(cancel, None))
            .await
    }
    /// `apply_statements` with a progress callback: before each statement the
    /// runner reports how many statements of the plan are done (R4).
    async fn run_statements(
        &self,
        database: &str,
        plan: &StatementPlan,
        control: RunControl,
    ) -> Result<RunOutcome>;
    /// Starts an export read: full values in chunks of up to 1,000 rows or 8 MB, from one
    /// consistent snapshot on a connection of its own. A producer task (SQLite: a thread)
    /// reads ahead through a channel of 2 chunks; dropping the source closes the channel
    /// and the connection. A filter must keep the SELECT one statement, and a `Query`
    /// must be one statement the classifier calls Read; both are `InvalidInput` otherwise.
    async fn open_row_source(&self, req: &SourceRequest) -> Result<Box<dyn RowSource>>;
    /// How the table keeps its rows. MySQL reads its engine (`information_schema.TABLES`);
    /// SQLite its journal mode. Others are transactional with no engine.
    async fn table_storage(&self, path: &ObjectPath) -> Result<TableStorage> {
        let _ = path;
        Ok(TableStorage::default())
    }
    /// Opens a connection of its own for a job's writes, with the same Read-only backstop
    /// as a query session, runs `setup.before` on it and hands it over. MySQL sets
    /// `utf8mb4` and selects `database`; PostgreSQL signs in to `database` (or the default
    /// one); SQLite opens the file for writing on a thread of its own and ignores
    /// `database`. Never call this for a job `authorize_job` has not let through.
    async fn open_bulk_writer(
        &self,
        database: Option<&str>,
        setup: &WriterSetup,
    ) -> Result<Box<dyn BulkWriter>>;
    /// Step 9: one read snapshot for a Backup of `database` (PostgreSQL: of `schema` in
    /// it) on a connection of its own, its session in UTC, read only whatever the
    /// Connection is. It reads the structure inside the snapshot, then serves each
    /// table's rows from the same snapshot in primary key order, generated columns left
    /// out. `count_rows` counts every table's rows inside the snapshot; otherwise the
    /// server's estimates are given. Dropping the read ends the snapshot.
    async fn open_backup_read(
        &self,
        database: &str,
        schema: Option<&str>,
        count_rows: bool,
    ) -> Result<SnapshotRead> {
        let _ = (database, schema, count_rows);
        Err(crate::error::Error::InvalidInput(
            "This database type cannot be backed up.".into(),
        ))
    }
    /// SQLite only: an exact copy of the database file into `into`, which exists and is
    /// empty (`VACUUM INTO` on a read-only connection).
    async fn backup_file_copy(&self, into: &Path) -> Result<()> {
        let _ = into;
        Err(crate::error::Error::InvalidInput(
            "Only a SQLite database can be copied as a file.".into(),
        ))
    }
    async fn disconnect(&self) -> Result<()>;
}

pub async fn connect(
    config: &ConnectionConfig,
    password: Option<&str>,
) -> Result<Arc<dyn Dialect>> {
    match config.dialect {
        DialectKind::MySql => Ok(Arc::new(MySqlDialect::connect(config, password).await?)),
        DialectKind::Sqlite => Ok(Arc::new(SqliteDialect::connect(config).await?)),
        DialectKind::Postgres => Ok(Arc::new(PostgresDialect::connect(config, password).await?)),
    }
}
