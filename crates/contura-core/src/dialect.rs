use std::sync::Arc;

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
    /// Names, kinds, column types and Foreign Keys of one database (tables and views), for the editor. No row data.
    async fn sql_schema(&self, database: &str) -> Result<SqlSchema>;
    /// A new connection of its own for one query tab (`database` is ignored by SQLite).
    async fn open_query_session(&self, database: Option<&str>) -> Result<SessionHandle>;
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
