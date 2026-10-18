use std::sync::Arc;

use crate::design::{DesignOutcome, DesignPlan, TableDesign};
use crate::edits::{PlannedEdit, TxOutcome};
use crate::error::Result;
use crate::model::{
    ConnectionConfig, DbObject, DialectKind, FullValue, FullValueRequest, ObjectKind, ObjectPath,
    Page, PageRequest, SchemaInfo,
};
use crate::mysql::MySqlDialect;
use crate::postgres::PostgresDialect;
use crate::query::SessionHandle;
use crate::schema_model::SchemaModel;
use crate::sql_schema::SqlSchema;
use crate::sqlite::SqliteDialect;

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
    /// Reads one database (MySQL, SQLite) or one schema (Postgres) as a Schema Model. Read only.
    async fn schema_snapshot(&self, database: &str, schema: Option<&str>) -> Result<SchemaModel>;
    /// Reads one table for the Table Designer, with the real names of its indexes and
    /// keys. Read only. `NotFound` with the table's name when there is no such table.
    async fn table_design(&self, path: &ObjectPath) -> Result<TableDesign>;
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
