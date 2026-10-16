mod full_value;
mod introspect;
pub(crate) mod page;
pub mod quote;
mod session;
mod snapshot;

use std::time::Duration;

use mysql_async::prelude::Queryable;
use mysql_async::{OptsBuilder, Pool, PoolConstraints, PoolOpts, SslOpts};

use crate::dialect::Dialect;
use crate::error::{Error, Result};
use crate::model::{
    ConnectionConfig, DbObject, FullValue, FullValueRequest, ObjectKind, ObjectPath, Page,
    PageRequest, SchemaInfo, SslMode,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CONN_TTL: Duration = Duration::from_secs(5 * 60);
const MYSQL_ACCESS_DENIED: u16 = 1045;

pub struct MySqlDialect {
    pool: Pool,
    /// Query sessions open their own connection with these, outside the pool.
    opts: OptsBuilder,
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
                Ok(Self { pool, opts })
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
    OptsBuilder::default()
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

pub(crate) fn query_err(e: mysql_async::Error) -> Error {
    Error::Query(e.to_string())
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
        introspect::list_databases(&self.pool).await
    }

    async fn list_schemas(&self, _database: &str) -> Result<Vec<SchemaInfo>> {
        Ok(Vec::new())
    }

    async fn list_objects(&self, database: &str, _schema: Option<&str>) -> Result<Vec<DbObject>> {
        introspect::list_objects(&self.pool, database).await
    }

    async fn object_definition(&self, kind: ObjectKind, path: &ObjectPath) -> Result<String> {
        introspect::object_definition(&self.pool, kind, path).await
    }

    async fn fetch_page(&self, req: &PageRequest) -> Result<Page> {
        page::fetch_page(&self.pool, req).await
    }

    async fn fetch_full_value(&self, req: &FullValueRequest) -> Result<FullValue> {
        full_value::fetch_full_value(&self.pool, req).await
    }

    async fn schema_snapshot(
        &self,
        database: &str,
        _schema: Option<&str>,
    ) -> Result<crate::schema_model::SchemaModel> {
        snapshot::schema_snapshot(&self.pool, database).await
    }

    async fn open_query_session(
        &self,
        database: Option<&str>,
    ) -> Result<crate::query::SessionHandle> {
        session::spawn(self.opts.clone(), database, self.pool.clone()).await
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
