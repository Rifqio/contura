#![allow(dead_code)]

pub mod jobs;
pub mod pg;

use contura_core::model::{ConnectionConfig, DialectKind, SslMode};
use mysql_async::prelude::Queryable;
use mysql_async::{Opts, OptsBuilder, Pool};

pub struct TestDb {
    pub config: ConnectionConfig,
    pub password: Option<String>,
    pub name: String,
    /// Set by `drop_db`, so `Drop` doesn't drop the database a second time.
    dropped: bool,
}

/// A data folder no test writes into. A service needs one to open a SQLite file, since
/// the path guard fails closed without it (Q45 M3); each test's files live in a temp
/// folder of its own, so they are outside it.
pub fn data_dir() -> std::path::PathBuf {
    let d = std::env::temp_dir().join("contura-test-data");
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

pub fn base_config(user: &str, database: Option<String>) -> ConnectionConfig {
    ConnectionConfig {
        id: uuid::Uuid::new_v4(),
        name: "test".into(),
        dialect: DialectKind::MySql,
        host: env_or("DBVIEW_TEST_MYSQL_HOST", "127.0.0.1"),
        port: env_or("DBVIEW_TEST_MYSQL_PORT", "3306")
            .parse()
            .expect("DBVIEW_TEST_MYSQL_PORT"),
        user: user.to_string(),
        database,
        ssl: SslMode::Disable,
        group_id: None,
        file: None,
        query_timeout_secs: None,
        ai_access: Default::default(),
        production: false,
        read_only: false,
    }
}

pub fn test_user() -> String {
    env_or("DBVIEW_TEST_MYSQL_USER", "dbview_test")
}

pub fn test_password() -> String {
    env_or("DBVIEW_TEST_MYSQL_PASSWORD", "dbview_test")
}

fn admin_pool(config: &ConnectionConfig, password: &str) -> Pool {
    let opts: Opts = OptsBuilder::default()
        .ip_or_hostname(config.host.clone())
        .tcp_port(config.port)
        .user(Some(config.user.clone()))
        .pass(Some(password.to_string()))
        .into();
    Pool::new(opts)
}

impl TestDb {
    /// Creates a fresh `dbview_test_<8 hex>` database and a config pointing at it.
    pub async fn create() -> TestDb {
        let password = test_password();
        let mut config = base_config(&test_user(), None);
        let suffix = &uuid::Uuid::new_v4().simple().to_string()[..8];
        let name = format!("dbview_test_{suffix}");
        let pool = admin_pool(&config, &password);
        let mut conn = pool.get_conn().await.expect("connect to test MySQL");
        conn.query_drop(format!("CREATE DATABASE `{name}`"))
            .await
            .expect("create test database");
        drop(conn);
        pool.disconnect().await.ok();
        config.database = Some(name.clone());
        TestDb {
            config,
            password: Some(password),
            name,
            dropped: false,
        }
    }

    /// The explicit cleanup at the end of a passing test.
    pub async fn drop_db(mut self) {
        drop_database(
            &self.config,
            self.password.as_deref().unwrap_or(""),
            &self.name,
        )
        .await
        .expect("drop test database");
        self.dropped = true;
    }
}

/// A test that panics before `drop_db` still drops its database. `Drop` can't
/// await and may run inside a runtime, so it uses a thread with its own runtime.
impl Drop for TestDb {
    fn drop(&mut self) {
        if self.dropped {
            return;
        }
        let config = self.config.clone();
        let password = self.password.clone().unwrap_or_default();
        let name = self.name.clone();
        let cleanup = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            rt.block_on(async {
                // A connection left open by a failing test can make DROP DATABASE wait;
                // the test fails rather than hanging.
                match tokio::time::timeout(
                    std::time::Duration::from_secs(30),
                    drop_database(&config, &password, &name),
                )
                .await
                {
                    Ok(r) => r.map_err(|e| e.to_string()),
                    Err(_) => Err("it did not drop within 30s".to_string()),
                }
            })
        });
        match cleanup.join() {
            Ok(Ok(())) => {}
            Ok(Err(e)) => eprintln!("could not drop test database {}: {e}", self.name),
            Err(_) => eprintln!(
                "could not drop test database {}: cleanup thread panicked",
                self.name
            ),
        }
    }
}

async fn drop_database(
    config: &ConnectionConfig,
    password: &str,
    name: &str,
) -> mysql_async::Result<()> {
    let pool = admin_pool(config, password);
    let result = async {
        let mut conn = pool.get_conn().await?;
        conn.query_drop(format!("DROP DATABASE IF EXISTS `{name}`"))
            .await
    }
    .await;
    pool.disconnect().await.ok();
    result
}

/// Whether a database with this exact name exists on the test server.
pub async fn database_exists(name: &str) -> bool {
    let config = base_config(&test_user(), None);
    let pool = admin_pool(&config, &test_password());
    let mut conn = pool.get_conn().await.expect("connect to test MySQL");
    let found: Option<String> = conn
        .exec_first("SELECT CAST(SCHEMA_NAME AS CHAR) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", (name,))
        .await
        .expect("query SCHEMATA");
    drop(conn);
    pool.disconnect().await.ok();
    found.is_some()
}
