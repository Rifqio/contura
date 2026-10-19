mod full_value;
mod introspect;
mod keys;
pub(crate) mod page;
pub mod quote;
mod session;
mod snapshot;
mod source;
mod sql_schema;
mod writer;

use std::time::Duration;

use mysql_async::prelude::Queryable;
use mysql_async::{Conn, OptsBuilder, Pool, PoolConstraints, PoolOpts, SslOpts};

use crate::design::{self, DesignOutcome, DesignPlan, Parts};
use crate::dialect::Dialect;
use crate::edits::{PlannedEdit, TxOutcome};
use crate::error::{Error, Result, browse_result};
use crate::model::{
    ConnectionConfig, DbObject, FullValue, FullValueRequest, ObjectKind, ObjectPath, Page,
    PageRequest, SchemaInfo, SslMode,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CONN_TTL: Duration = Duration::from_secs(5 * 60);
const MYSQL_ACCESS_DENIED: u16 = 1045;
/// ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION.
const MYSQL_READ_ONLY_TRANSACTION: u16 = 1792;

pub struct MySqlDialect {
    pool: Pool,
    /// Query sessions open their own connection with these, outside the pool.
    opts: OptsBuilder,
    read_only: bool,
}

impl MySqlDialect {
    /// Builds the pool and checks out one connection, so a bad config fails right away.
    pub async fn connect(config: &ConnectionConfig, password: Option<&str>) -> Result<Self> {
        let opts = build_opts(config, password);
        let pool = Pool::new(opts.clone());
        let target = format!("{}:{}", config.host, config.port);
        match tokio::time::timeout(CONNECT_TIMEOUT, pool.get_conn()).await {
            Ok(Ok(conn)) => {
                drop(conn);
                Ok(Self {
                    pool,
                    opts,
                    read_only: config.read_only,
                })
            }
            Ok(Err(e)) => {
                let _ = pool.disconnect().await;
                Err(map_connect_error(e, &target))
            }
            Err(_) => {
                let _ = pool.disconnect().await;
                Err(Error::Connect(format!(
                    "timed out after {} s connecting to {target}",
                    CONNECT_TIMEOUT.as_secs()
                )))
            }
        }
    }

    /// The first column of the first row of `sql`, from a pooled (browse) connection.
    /// Public only for integration tests.
    #[cfg(any(test, feature = "test-util"))]
    #[doc(hidden)]
    pub async fn browse_first_for_test(&self, sql: &str) -> Result<Option<String>> {
        let mut conn = self.pool.get_conn().await.map_err(query_err)?;
        conn.query_first(sql).await.map_err(query_err)
    }

    /// `table_design` on a pooled connection after `session_sql` ran on it, such as
    /// a `SET SESSION sql_mode`. Public only for integration tests.
    #[cfg(any(test, feature = "test-util"))]
    #[doc(hidden)]
    pub async fn table_design_after_for_test(
        &self,
        session_sql: &str,
        path: &ObjectPath,
    ) -> Result<crate::design::TableDesign> {
        let mut conn = self.pool.get_conn().await.map_err(query_err)?;
        conn.query_drop(session_sql).await.map_err(query_err)?;
        snapshot::table_design_on(&mut conn, path).await
    }
}

fn build_opts(config: &ConnectionConfig, password: Option<&str>) -> OptsBuilder {
    let constraints = PoolConstraints::new(0, 2).expect("min 0 <= max 2");
    let ssl = match &config.ssl {
        SslMode::Disable => None,
        SslMode::Require => Some(
            SslOpts::default()
                .with_danger_accept_invalid_certs(true)
                .with_danger_skip_domain_validation(true),
        ),
        SslMode::VerifyCa { ca_path } => Some(
            SslOpts::default()
                .with_root_certs(vec![ca_path.clone().into()])
                // Only the given CA: with built-in roots, any publicly trusted cert would pass.
                .with_disable_built_in_roots(true)
                .with_danger_skip_domain_validation(true),
        ),
    };
    // `setup` runs at connect and again after every pool reset (COM_RESET_CONNECTION
    // restores the server default), so pooled connections stay read-only on reuse.
    // `init` would run only once per connection.
    let setup: Vec<&str> = if config.read_only {
        vec!["SET SESSION TRANSACTION READ ONLY"]
    } else {
        Vec::new()
    };
    OptsBuilder::default()
        .setup(setup)
        .ip_or_hostname(config.host.clone())
        .tcp_port(config.port)
        .user(Some(config.user.clone()))
        .pass(password.map(str::to_string))
        .db_name(config.database.clone())
        .ssl_opts(ssl)
        .conn_ttl(Some(CONN_TTL))
        .pool_opts(PoolOpts::default().with_constraints(constraints))
}

fn map_connect_error(e: mysql_async::Error, target: &str) -> Error {
    match e {
        mysql_async::Error::Server(ref s) if s.code == MYSQL_ACCESS_DENIED => {
            Error::Auth(s.message.clone())
        }
        // The server answered, so host and port are fine (e.g. 1049 unknown database).
        mysql_async::Error::Server(s) => Error::Query(s.message),
        mysql_async::Error::Io(io) => Error::Connect(format!("cannot reach {target}: {io}")),
        other => Error::Connect(format!("{target}: {other}")),
    }
}

fn is_read_only_refusal(e: &mysql_async::Error) -> bool {
    matches!(e, mysql_async::Error::Server(s) if s.code == MYSQL_READ_ONLY_TRANSACTION)
}

/// Browse code uses this. The Dialect methods pass their result through
/// `browse_result`, which turns a refusal into a plain error on a Connection that is
/// not Read-only.
pub(crate) fn query_err(e: mysql_async::Error) -> Error {
    if is_read_only_refusal(&e) {
        Error::ReadOnlyRefused
    } else {
        Error::Query(e.to_string())
    }
}

/// A read-only refusal reads as "this Connection is Read-only" only when the Connection is.
pub(crate) fn session_err(e: mysql_async::Error, read_only: bool) -> Error {
    if !read_only && is_read_only_refusal(&e) {
        Error::Query(e.to_string())
    } else {
        query_err(e)
    }
}

/// Runs a save on `conn`. A server error on a statement rolls back and is `Failed`,
/// except a read-only refusal on a Read-only Connection, which is `ReadOnlyRefused`.
async fn run_planned(conn: &mut Conn, edits: &[PlannedEdit], read_only: bool) -> Result<TxOutcome> {
    conn.query_drop("START TRANSACTION")
        .await
        .map_err(query_err)?;
    let mut rows = Vec::with_capacity(edits.len());
    for (statement, edit) in edits.iter().enumerate() {
        if let Err(e) = conn.query_drop(edit.sql.as_str()).await {
            let refused = is_read_only_refusal(&e);
            let mysql_async::Error::Server(server) = e else {
                return Err(query_err(e));
            };
            conn.query_drop("ROLLBACK").await.map_err(query_err)?;
            if read_only && refused {
                return Err(Error::ReadOnlyRefused);
            }
            return Ok(TxOutcome::Failed {
                statement,
                message: server.message,
            });
        }
        let affected = conn.affected_rows();
        if edit.one_row && affected != 1 {
            conn.query_drop("ROLLBACK").await.map_err(query_err)?;
            return Ok(TxOutcome::RowCount {
                statement,
                rows: affected,
            });
        }
        rows.push(affected);
    }
    conn.query_drop("COMMIT").await.map_err(query_err)?;
    Ok(TxOutcome::Committed { rows })
}

/// Runs `sql`. `Some` (the first column of the first row as text, empty when it
/// is not text) when it returned a row.
async fn first_row(conn: &mut Conn, sql: &str) -> mysql_async::Result<Option<String>> {
    let rows: Vec<mysql_async::Row> = conn.query(sql).await?;
    Ok(rows.first().map(|row| {
        row.get_opt::<String, usize>(0)
            .and_then(|v| v.ok())
            .unwrap_or_default()
    }))
}

/// Runs a design plan on `conn`, statement by statement: MySQL commits each DDL
/// statement on its own, so there is no transaction and the statements before a
/// failure stay applied (`ran`). The `after` statements run whatever happened.
async fn run_design(
    conn: &mut Conn,
    plan: &DesignPlan,
    parts: &Parts,
    read_only: bool,
) -> Result<DesignOutcome> {
    let outcome = run_design_body(conn, plan, parts, read_only).await;
    for at in parts.after.clone() {
        let sql = &plan.statements[at];
        if let Err(e) = first_row(conn, sql).await {
            return Err(design::after_failed(&outcome, sql, &e.to_string()));
        }
    }
    outcome
}

async fn run_design_body(
    conn: &mut Conn,
    plan: &DesignPlan,
    parts: &Parts,
    read_only: bool,
) -> Result<DesignOutcome> {
    for at in parts.before.start..parts.middle.end {
        // Every statement before this one ran (and committed).
        let ran = at;
        match first_row(conn, &plan.statements[at]).await {
            Ok(None) => {}
            Ok(Some(first)) => return Ok(design::returned_row(plan, at, ran, Some(first))),
            Err(e) => {
                if ran == 0 && read_only && is_read_only_refusal(&e) {
                    return Err(Error::ReadOnlyRefused);
                }
                let message = match e {
                    mysql_async::Error::Server(server) => server.message,
                    // The connection failed: the statement may or may not have run.
                    other => format!(
                        "{other}. The connection failed, so this statement may or may not \
                         have run: reload the table to see where it stands."
                    ),
                };
                return Ok(DesignOutcome::Failed {
                    statement: at,
                    ran,
                    message,
                });
            }
        }
    }
    Ok(DesignOutcome::Done {
        ran: plan.statements.len(),
    })
}

#[async_trait::async_trait]
impl Dialect for MySqlDialect {
    async fn server_version(&self) -> Result<String> {
        let mut conn = self.pool.get_conn().await.map_err(query_err)?;
        let version: Option<String> = conn
            .query_first("SELECT VERSION()")
            .await
            .map_err(query_err)?;
        version.ok_or_else(|| Error::Query("server returned no version".into()))
    }

    async fn list_databases(&self) -> Result<Vec<String>> {
        browse_result(introspect::list_databases(&self.pool).await, self.read_only)
    }

    async fn list_schemas(&self, _database: &str) -> Result<Vec<SchemaInfo>> {
        Ok(Vec::new())
    }

    async fn list_objects(&self, database: &str, _schema: Option<&str>) -> Result<Vec<DbObject>> {
        browse_result(
            introspect::list_objects(&self.pool, database).await,
            self.read_only,
        )
    }

    async fn object_definition(&self, kind: ObjectKind, path: &ObjectPath) -> Result<String> {
        browse_result(
            introspect::object_definition(&self.pool, kind, path).await,
            self.read_only,
        )
    }

    async fn fetch_page(&self, req: &PageRequest) -> Result<Page> {
        browse_result(page::fetch_page(&self.pool, req).await, self.read_only)
    }

    async fn fetch_full_value(&self, req: &FullValueRequest) -> Result<FullValue> {
        browse_result(
            full_value::fetch_full_value(&self.pool, req).await,
            self.read_only,
        )
    }

    async fn schema_snapshot(
        &self,
        database: &str,
        _schema: Option<&str>,
    ) -> Result<crate::schema_model::SchemaModel> {
        browse_result(
            snapshot::schema_snapshot(&self.pool, database).await,
            self.read_only,
        )
    }

    async fn table_design(&self, path: &ObjectPath) -> Result<crate::design::TableDesign> {
        browse_result(
            snapshot::table_design(&self.pool, path).await,
            self.read_only,
        )
    }

    async fn key_edges(
        &self,
        database: &str,
        _schema: Option<&str>,
    ) -> Result<Vec<crate::lineage::KeyEdge>> {
        browse_result(keys::key_edges(&self.pool, database).await, self.read_only)
    }

    async fn key_tables(
        &self,
        database: &str,
        _schema: Option<&str>,
        tables: &[String],
    ) -> Result<Vec<crate::lineage::KeyTable>> {
        browse_result(
            keys::key_tables(&self.pool, database, tables).await,
            self.read_only,
        )
    }

    async fn view_dependencies(
        &self,
        table: &ObjectPath,
        limit: usize,
    ) -> Result<Option<Vec<ObjectPath>>> {
        browse_result(
            keys::view_dependencies(&self.pool, table, limit).await,
            self.read_only,
        )
    }

    async fn sql_schema(&self, database: &str) -> Result<crate::sql_schema::SqlSchema> {
        browse_result(
            sql_schema::sql_schema(&self.pool, database).await,
            self.read_only,
        )
    }

    async fn open_query_session(
        &self,
        database: Option<&str>,
    ) -> Result<crate::query::SessionHandle> {
        session::spawn(
            self.opts.clone(),
            database,
            self.pool.clone(),
            self.read_only,
        )
        .await
    }

    /// The planned statements name their database, so `database` is not used.
    async fn apply_planned(&self, _database: &str, edits: &[PlannedEdit]) -> Result<TxOutcome> {
        // Found rows, not changed rows: an UPDATE to a value equal after conversion
        // (`1` into a DECIMAL holding `1.00`) still counts its row.
        let opts = self.opts.clone().client_found_rows(true);
        let mut conn = Conn::new(opts)
            .await
            .map_err(|e| Error::Connect(format!("cannot open a connection for the save: {e}")))?;
        let outcome = run_planned(&mut conn, edits, self.read_only).await;
        // Closing without COMMIT rolls back whatever is still open.
        let _ = conn.disconnect().await;
        browse_result(outcome, self.read_only)
    }

    /// The planned statements name their database, so `database` is not used.
    async fn apply_design(&self, _database: &str, plan: &DesignPlan) -> Result<DesignOutcome> {
        let parts = design::runnable(plan)?;
        let mut conn = Conn::new(self.opts.clone())
            .await
            .map_err(|e| Error::Connect(format!("cannot open a connection for the change: {e}")))?;
        let outcome = run_design(&mut conn, plan, &parts, self.read_only).await;
        let _ = conn.disconnect().await;
        browse_result(outcome, self.read_only)
    }

    async fn open_row_source(
        &self,
        req: &crate::jobs::source::SourceRequest,
    ) -> Result<Box<dyn crate::jobs::source::RowSource>> {
        source::open(self.opts.clone(), self.pool.clone(), self.read_only, req).await
    }

    async fn table_storage(&self, path: &ObjectPath) -> Result<crate::jobs::source::TableStorage> {
        browse_result(
            source::table_storage(&self.pool, path).await,
            self.read_only,
        )
    }

    async fn open_bulk_writer(
        &self,
        database: Option<&str>,
        setup: &crate::jobs::writer::WriterSetup,
    ) -> Result<Box<dyn crate::jobs::writer::BulkWriter>> {
        writer::open(
            self.opts.clone(),
            self.pool.clone(),
            self.read_only,
            database,
            setup,
        )
        .await
    }

    async fn disconnect(&self) -> Result<()> {
        self.pool.clone().disconnect().await.map_err(query_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DialectKind;

    fn config_with(ssl: SslMode) -> ConnectionConfig {
        ConnectionConfig {
            id: uuid::Uuid::new_v4(),
            name: "t".into(),
            dialect: DialectKind::MySql,
            host: "db.example.com".into(),
            port: 3306,
            user: "u".into(),
            database: None,
            ssl,
            group_id: None,
            file: None,
            query_timeout_secs: None,
            ai_access: Default::default(),
            production: false,
            read_only: false,
        }
    }

    #[test]
    fn verify_ca_trusts_only_the_given_ca() {
        let config = config_with(SslMode::VerifyCa {
            ca_path: "C:/ca.pem".into(),
        });
        let opts: mysql_async::Opts = build_opts(&config, None).into();
        let ssl = opts.ssl_opts().expect("ssl on");
        assert!(
            ssl.disable_built_in_roots(),
            "public CAs must not satisfy verify-CA"
        );
    }

    #[test]
    fn read_only_is_a_setup_command_so_pool_resets_keep_it() {
        let mut config = config_with(SslMode::Disable);
        config.read_only = true;
        let opts: mysql_async::Opts = build_opts(&config, None).into();
        assert_eq!(opts.setup(), ["SET SESSION TRANSACTION READ ONLY"]);
        assert!(opts.init().is_empty());
        config.read_only = false;
        let opts: mysql_async::Opts = build_opts(&config, None).into();
        assert!(opts.setup().is_empty() && opts.init().is_empty());
    }

    #[tokio::test]
    async fn connection_charset_is_utf8mb4() {
        let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
        let config = ConnectionConfig {
            id: uuid::Uuid::new_v4(),
            name: "t".into(),
            dialect: DialectKind::MySql,
            host: env("DBVIEW_TEST_MYSQL_HOST", "127.0.0.1"),
            port: env("DBVIEW_TEST_MYSQL_PORT", "3306").parse().unwrap(),
            user: env("DBVIEW_TEST_MYSQL_USER", "dbview_test"),
            database: None,
            ssl: SslMode::Disable,
            group_id: None,
            file: None,
            query_timeout_secs: None,
            ai_access: Default::default(),
            production: false,
            read_only: false,
        };
        let pw = env("DBVIEW_TEST_MYSQL_PASSWORD", "dbview_test");
        let pool = Pool::new(build_opts(&config, Some(&pw)));
        let mut conn = pool.get_conn().await.expect("connect");
        let (results, client): (String, String) = conn
            .query_first("SELECT @@character_set_results, @@character_set_client")
            .await
            .expect("query")
            .expect("row");
        assert_eq!((results.as_str(), client.as_str()), ("utf8mb4", "utf8mb4"));
        drop(conn);
        pool.disconnect().await.ok();
    }
}
