use contura_core::model::{ConnectionConfig, DialectKind, SslMode};
use tokio_postgres::{Client, NoTls};

pub struct PgTestDb {
    pub config: ConnectionConfig,
    pub password: Option<String>,
    pub name: String,
    /// Set by `drop_db`, so `Drop` doesn't drop the database a second time.
    dropped: bool,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

pub fn pg_test_user() -> String {
    env_or("DBVIEW_TEST_PG_USER", "dbview_test")
}

pub fn pg_test_password() -> String {
    env_or("DBVIEW_TEST_PG_PASSWORD", "dbview_test")
}

pub fn pg_base_config(user: &str, database: Option<String>) -> ConnectionConfig {
    ConnectionConfig {
        id: uuid::Uuid::new_v4(),
        name: "test".into(),
        dialect: DialectKind::Postgres,
        host: env_or("DBVIEW_TEST_PG_HOST", "127.0.0.1"),
        port: env_or("DBVIEW_TEST_PG_PORT", "5432")
            .parse()
            .expect("DBVIEW_TEST_PG_PORT"),
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

async fn connect_as(
    config: &ConnectionConfig,
    password: &str,
    database: &str,
) -> Result<Client, tokio_postgres::Error> {
    let (client, connection) = tokio_postgres::Config::new()
        .host(&config.host)
        .port(config.port)
        .user(&config.user)
        .password(password)
        .dbname(database)
        .connect(NoTls)
        .await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    Ok(client)
}

/// A client signed in as the test role, for fixtures. Never `postgres`.
pub async fn pg_admin_client(database: &str) -> Client {
    let config = pg_base_config(&pg_test_user(), None);
    connect_as(&config, &pg_test_password(), database)
        .await
        .expect("connect to test PostgreSQL")
}

fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

impl PgTestDb {
    /// Creates a fresh `dbview_test_<8 hex>` database and a config pointing at it.
    pub async fn create() -> PgTestDb {
        let password = pg_test_password();
        let mut config = pg_base_config(&pg_test_user(), None);
        let suffix = &uuid::Uuid::new_v4().simple().to_string()[..8];
        let name = format!("dbview_test_{suffix}");
        let client = pg_admin_client("postgres").await;
        client
            .batch_execute(&format!("CREATE DATABASE {}", quote(&name)))
            .await
            .expect("create test database");
        drop(client);
        config.database = Some(name.clone());
        PgTestDb {
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
impl Drop for PgTestDb {
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
            rt.block_on(drop_database(&config, &password, &name))
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
) -> Result<(), tokio_postgres::Error> {
    let client = connect_as(config, password, "postgres").await?;
    let sql = format!("DROP DATABASE IF EXISTS {} WITH (FORCE)", quote(name));
    // An autovacuum worker (a superuser process) may be in the new database for a
    // moment, and the test role may not end it: wait and try again.
    let mut tries = 0;
    loop {
        match client.batch_execute(&sql).await {
            Err(e)
                if tries < 10
                    && e.code()
                        == Some(&tokio_postgres::error::SqlState::INSUFFICIENT_PRIVILEGE) =>
            {
                tries += 1;
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            }
            other => return other,
        }
    }
}

/// Whether a database with this exact name exists on the test server.
pub async fn pg_database_exists(name: &str) -> bool {
    let client = pg_admin_client("postgres").await;
    client
        .query_opt("SELECT 1 FROM pg_database WHERE datname = $1", &[&name])
        .await
        .expect("query pg_database")
        .is_some()
}
