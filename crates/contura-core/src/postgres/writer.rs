//! The PostgreSQL `BulkWriter`: a client of its own, signed in with the Connection's
//! settings, so a Read-only Connection's writer starts with
//! `default_transaction_read_only=on` like any query session.

use std::sync::Arc;

use tokio_postgres::Client;

use super::session::{canceller, session_err};
use super::{Settings, open_client};
use crate::common::quote_double;
use crate::error::Result;
use crate::jobs::writer::{BulkWriter, WriterSetup, after_commit};
use crate::query::Canceller;

pub(super) struct PgWriter {
    client: Client,
    read_only: bool,
    after: Vec<String>,
    canceller: Arc<dyn Canceller>,
}

pub(super) async fn open(
    settings: &Settings,
    database: &str,
    read_only: bool,
    setup: &WriterSetup,
) -> Result<Box<dyn BulkWriter>> {
    let client = open_client(settings, database).await?;
    let canceller = canceller(&client, settings.tls.clone());
    let mut writer = PgWriter {
        client,
        read_only,
        after: setup.after.clone(),
        canceller,
    };
    for sql in &setup.before {
        writer.run(sql).await?;
    }
    Ok(Box::new(writer))
}

#[async_trait::async_trait]
impl BulkWriter for PgWriter {
    async fn begin(&mut self) -> Result<()> {
        self.run("BEGIN").await.map(drop)
    }

    /// One statement through the extended protocol, which refuses a second one (a
    /// simple query would run every statement it is given); the rows it reports.
    async fn run(&mut self, sql: &str) -> Result<u64> {
        self.client
            .execute(sql, &[])
            .await
            .map_err(|e| session_err(e, self.read_only))
    }

    async fn savepoint(&mut self, name: &str) -> Result<()> {
        self.run(&format!("SAVEPOINT {}", quote_double(name)))
            .await
            .map(drop)
    }

    async fn rollback_to(&mut self, name: &str) -> Result<()> {
        self.run(&format!("ROLLBACK TO SAVEPOINT {}", quote_double(name)))
            .await
            .map(drop)
    }

    async fn release(&mut self, name: &str) -> Result<()> {
        self.run(&format!("RELEASE SAVEPOINT {}", quote_double(name)))
            .await
            .map(drop)
    }

    async fn commit(&mut self) -> Result<()> {
        self.run("COMMIT").await?;
        for sql in self.after.clone() {
            self.run(&sql).await.map_err(|e| after_commit(&sql, e))?;
        }
        Ok(())
    }

    async fn rollback(&mut self) -> Result<()> {
        self.run("ROLLBACK").await.map(drop)
    }

    fn statement_limit(&self) -> usize {
        usize::MAX
    }

    fn canceller(&self) -> Arc<dyn Canceller> {
        self.canceller.clone()
    }

    /// Dropping the client ends its connection, which rolls back an open transaction.
    async fn close(self: Box<Self>) {
        let _ = self.client.simple_query("ROLLBACK").await;
    }
}
