//! The MySQL `BulkWriter`: a connection of its own, outside the browsing pool, opened
//! with the Connection's options, so a Read-only Connection's writer starts with
//! `SET SESSION TRANSACTION READ ONLY` like any query session.

use std::sync::Arc;

use mysql_async::Conn;
use mysql_async::prelude::Queryable;

use super::link::{Opts, Pool};

use super::quote::quote_ident;
use super::session::Kill;
use super::session_err;
use crate::error::{Error, Result};
use crate::jobs::writer::{BulkWriter, WriterSetup, after_commit};
use crate::query::Canceller;

/// ER_UNSUPPORTED_PS: the statement cannot be prepared.
const UNSUPPORTED_PS: u16 = 1295;

pub(super) struct MySqlWriter {
    conn: Conn,
    read_only: bool,
    after: Vec<String>,
    limit: usize,
    canceller: Arc<dyn Canceller>,
}

pub(super) async fn open(
    opts: Opts,
    pool: Pool,
    read_only: bool,
    database: Option<&str>,
    setup: &WriterSetup,
) -> Result<Box<dyn BulkWriter>> {
    let mut conn = opts
        .conn()
        .await
        .map_err(|e| Error::Connect(format!("cannot open a connection for the import: {e}")))?;
    let opened = prepare(&mut conn, read_only, database, setup).await;
    let limit = match opened {
        Ok(limit) => limit,
        Err(e) => {
            let _ = conn.disconnect().await;
            return Err(e);
        }
    };
    let canceller: Arc<dyn Canceller> = Arc::new(Kill {
        pool,
        id: conn.id(),
    });
    Ok(Box::new(MySqlWriter {
        conn,
        read_only,
        after: setup.after.clone(),
        limit,
        canceller,
    }))
}

/// Sets the character set and database, runs the setup's `before` statements, and reads
/// the statement limit: half of `max_allowed_packet`, so a statement and the protocol's
/// own bytes always fit.
async fn prepare(
    conn: &mut Conn,
    read_only: bool,
    database: Option<&str>,
    setup: &WriterSetup,
) -> Result<usize> {
    let err = |e| session_err(e, read_only);
    conn.query_drop("SET NAMES utf8mb4").await.map_err(err)?;
    if let Some(db) = database {
        conn.query_drop(format!("USE {}", quote_ident(db)))
            .await
            .map_err(err)?;
    }
    for sql in &setup.before {
        conn.query_drop(sql.as_str()).await.map_err(err)?;
    }
    let packet: Option<u64> = conn
        .query_first("SELECT @@max_allowed_packet")
        .await
        .map_err(err)?;
    let packet =
        packet.ok_or_else(|| Error::Query("the server gave no max_allowed_packet".into()))?;
    Ok(usize::try_from(packet / 2).unwrap_or(usize::MAX))
}

impl MySqlWriter {
    async fn exec(&mut self, sql: &str) -> Result<()> {
        let read_only = self.read_only;
        self.conn
            .query_drop(sql)
            .await
            .map_err(|e| session_err(e, read_only))
    }
}

#[async_trait::async_trait]
impl BulkWriter for MySqlWriter {
    async fn begin(&mut self) -> Result<()> {
        self.exec("START TRANSACTION").await
    }

    /// One statement as a prepared statement, which the server refuses to hold two of
    /// (a text query runs every statement it is given). A statement the prepared
    /// protocol does not take (ER_UNSUPPORTED_PS, which the server gives only for text it
    /// parsed as one statement) runs as text.
    async fn run(&mut self, sql: &str) -> Result<u64> {
        let read_only = self.read_only;
        match self.conn.prep(sql).await {
            Ok(stmt) => {
                let done = self.conn.exec_drop(&stmt, ()).await;
                let rows = self.conn.affected_rows();
                // Closing also drops it from the client's statement cache.
                let _ = self.conn.close(stmt).await;
                done.map_err(|e| session_err(e, read_only))?;
                Ok(rows)
            }
            // Q42 I3: the server parses the whole text before it says it cannot prepare
            // it, and a second statement fails that parse (1064) first, so 1295 means one
            // statement, such as a routine or trigger whose BEGIN ... END body holds `;`
            // (which the 5a count would split).
            Err(mysql_async::Error::Server(e)) if e.code == UNSUPPORTED_PS => {
                self.exec(sql).await?;
                Ok(self.conn.affected_rows())
            }
            Err(e) => Err(session_err(e, read_only)),
        }
    }

    async fn first_value(&mut self, sql: &str) -> Result<Option<String>> {
        let read_only = self.read_only;
        // Prepared, so a second statement is refused.
        let row: Option<mysql_async::Row> = self
            .conn
            .exec_first(sql, ())
            .await
            .map_err(|e| session_err(e, read_only))?;
        Ok(row.and_then(|r| r.as_ref(0).and_then(mysql_text)))
    }

    async fn savepoint(&mut self, name: &str) -> Result<()> {
        self.exec(&format!("SAVEPOINT {}", quote_ident(name))).await
    }

    async fn rollback_to(&mut self, name: &str) -> Result<()> {
        self.exec(&format!("ROLLBACK TO SAVEPOINT {}", quote_ident(name)))
            .await
    }

    async fn release(&mut self, name: &str) -> Result<()> {
        self.exec(&format!("RELEASE SAVEPOINT {}", quote_ident(name)))
            .await
    }

    async fn commit(&mut self) -> Result<()> {
        self.exec("COMMIT").await?;
        for sql in self.after.clone() {
            self.exec(&sql).await.map_err(|e| after_commit(&sql, e))?;
        }
        Ok(())
    }

    async fn rollback(&mut self) -> Result<()> {
        self.exec("ROLLBACK").await
    }

    fn statement_limit(&self) -> usize {
        self.limit
    }

    fn canceller(&self) -> Arc<dyn Canceller> {
        self.canceller.clone()
    }

    async fn close(self: Box<Self>) {
        let mut conn = self.conn;
        // Outside a transaction this does nothing; inside one it undoes the work now.
        let _ = conn.query_drop("ROLLBACK").await;
        let _ = conn.disconnect().await;
    }
}

/// A value the text protocol or a prepared statement gave, as text.
fn mysql_text(v: &mysql_async::Value) -> Option<String> {
    use mysql_async::Value as V;
    match v {
        V::NULL => None,
        V::Bytes(b) => Some(String::from_utf8_lossy(b).into_owned()),
        V::Int(i) => Some(i.to_string()),
        V::UInt(u) => Some(u.to_string()),
        V::Float(f) => Some(f.to_string()),
        V::Double(d) => Some(d.to_string()),
        other => Some(format!("{other:?}")),
    }
}
