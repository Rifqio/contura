mod introspect;
mod page;
mod snapshot;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{Connection, ErrorCode, OpenFlags};

use crate::dialect::Dialect;
use crate::error::{Error, Result};
use crate::model::{
    ConnectionConfig, DbObject, FullValue, FullValueRequest, ObjectKind, ObjectPath, Page,
    PageRequest, SchemaInfo,
};

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

pub struct SqliteDialect {
    conn: Arc<Mutex<Connection>>,
}

pub(crate) fn query_err(e: rusqlite::Error) -> Error {
    Error::Query(e.to_string())
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

fn open_existing(path: &Path) -> Result<Connection> {
    if !path.exists() {
        return Err(Error::Connect(format!(
            "cannot open {}: the file does not exist",
            path.display()
        )));
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
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
        let conn = tokio::task::spawn_blocking(move || open_existing(&path))
            .await
            .map_err(|e| Error::Connect(e.to_string()))??;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    async fn run<T, F>(&self, work: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T> + Send + 'static,
    {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let guard = conn
                .lock()
                .map_err(|_| Error::Query("connection lock poisoned".into()))?;
            work(&guard)
        })
        .await
        .map_err(|e| Error::Query(e.to_string()))?
    }
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

    async fn disconnect(&self) -> Result<()> {
        Ok(())
    }
}
