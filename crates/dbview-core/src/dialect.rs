use std::sync::Arc;

use crate::error::Result;
use crate::model::{
    ConnectionConfig, DbObject, DialectKind, FullValue, FullValueRequest, ObjectKind, ObjectPath,
    Page, PageRequest,
};
use crate::mysql::MySqlDialect;

#[async_trait::async_trait]
pub trait Dialect: Send + Sync {
    async fn server_version(&self) -> Result<String>;
    async fn list_databases(&self) -> Result<Vec<String>>;
    /// MySQL has no schema level, so its Dialect always returns an empty list.
    async fn list_schemas(&self, database: &str) -> Result<Vec<String>>;
    async fn list_objects(&self, database: &str, schema: Option<&str>) -> Result<Vec<DbObject>>;
    async fn object_definition(&self, kind: ObjectKind, path: &ObjectPath) -> Result<String>;
    async fn fetch_page(&self, req: &PageRequest) -> Result<Page>;
    async fn fetch_full_value(&self, req: &FullValueRequest) -> Result<FullValue>;
    async fn disconnect(&self) -> Result<()>;
}

pub async fn connect(
    config: &ConnectionConfig,
    password: Option<&str>,
) -> Result<Arc<dyn Dialect>> {
    match config.dialect {
        DialectKind::MySql => Ok(Arc::new(MySqlDialect::connect(config, password).await?)),
    }
}
