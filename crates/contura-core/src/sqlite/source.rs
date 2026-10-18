//! The export read: a second, read-only connection to the file, so the browse lock is not
//! held for minutes; `BEGIN` for one read snapshot, and a lazy query stepped on a thread of
//! its own into the channel. In WAL mode browsing and saving go on meanwhile.

use std::path::PathBuf;
use std::sync::Arc;

use rusqlite::Connection;
use rusqlite::types::ValueRef;

use super::page::{has_usable_rowid, real_text, table_columns};
use super::{open_existing, query_err};
use crate::common::{quote_double, sql_scoped};
use crate::error::{Error, Result};
use crate::jobs::source::{
    Opened, Producer, RowSource, SourceColumn, SourceRequest, Value, check_one_statement,
    checked_query, start_source, value_kind,
};
use crate::model::DialectKind;
use crate::query::Canceller;

struct Interrupt(rusqlite::InterruptHandle);

#[async_trait::async_trait]
impl Canceller for Interrupt {
    async fn cancel(&self) -> Result<()> {
        self.0.interrupt();
        Ok(())
    }
}

pub(super) async fn open(path: PathBuf, req: &SourceRequest) -> Result<Box<dyn RowSource>> {
    if let SourceRequest::Query { sql, .. } = req {
        checked_query(DialectKind::Sqlite, sql)?;
    }
    let req = req.clone();
    let (spawned, failed) = tokio::sync::oneshot::channel();
    let source = start_source(move |p| {
        let started = std::thread::Builder::new()
            .name("contura-sqlite-export".into())
            .spawn(move || produce(&path, &req, p));
        if let Err(e) = started {
            let _ = spawned.send(e);
        }
    });
    match source.await {
        Ok(s) => Ok(s),
        Err(e) => match failed.await {
            Ok(io) => Err(Error::Query(format!("cannot start the export read: {io}"))),
            Err(_) => Err(e),
        },
    }
}

fn produce(path: &std::path::Path, req: &SourceRequest, p: Producer) {
    let Producer { ready, mut feed } = p;
    // Read-only whatever the Connection is: the export only reads.
    let conn = match open_existing(path, true) {
        Ok(c) => c,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let server: Arc<dyn Canceller> = Arc::new(Interrupt(conn.get_interrupt_handle()));
    if let Err(e) = conn.execute_batch("BEGIN") {
        let _ = ready.send(Err(query_err(e)));
        return;
    }
    let (sql, estimate) = match plan(&conn, req) {
        Ok(planned) => planned,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => {
            let _ = ready.send(Err(query_err(e)));
            return;
        }
    };
    let columns: Vec<SourceColumn> = stmt
        .columns()
        .iter()
        .map(|c| {
            let type_name = c.decl_type().unwrap_or_default().to_string();
            SourceColumn {
                name: c.name().to_string(),
                kind: value_kind(DialectKind::Sqlite, &type_name),
                type_name,
            }
        })
        .collect();
    if columns.is_empty() {
        let _ = ready.send(Err(Error::InvalidInput(
            "This statement returns no rows to export.".into(),
        )));
        return;
    }
    let width = columns.len();
    let opened = Opened {
        columns,
        estimate,
        sql: sql.clone(),
        server,
    };
    if ready.send(Ok(opened)).is_err() {
        return;
    }
    let mut rows = match stmt.query([]) {
        Ok(r) => r,
        Err(e) => {
            feed.fail_blocking(query_err(e));
            return;
        }
    };
    loop {
        match rows.next() {
            Ok(Some(row)) => {
                let mut values = Vec::with_capacity(width);
                for i in 0..width {
                    match row.get_ref(i) {
                        Ok(v) => values.push(value_of(v)),
                        Err(e) => {
                            feed.fail_blocking(query_err(e));
                            return;
                        }
                    }
                }
                if !feed.push_blocking(values) {
                    // Cancelled or dropped: dropping the connection ends the read.
                    return;
                }
            }
            Ok(None) => break,
            Err(e) => {
                feed.fail_blocking(query_err(e));
                return;
            }
        }
    }
    feed.finish_blocking();
}

/// The SELECT and, for a plain table, its row count (read inside the snapshot).
fn plan(conn: &Connection, req: &SourceRequest) -> Result<(String, Option<u64>)> {
    let Some(parts) = req.table_parts() else {
        let SourceRequest::Query { sql, .. } = req else {
            unreachable!("not a table, so a query");
        };
        return Ok((checked_query(DialectKind::Sqlite, sql)?, None));
    };
    let path = parts.path;
    let infos = table_columns(conn, path)?;
    let read = parts.read(DialectKind::Sqlite, &infos)?;
    let list: Vec<String> = read
        .selected
        .iter()
        .map(|&i| quote_double(&infos[i].name))
        .collect();
    let table = sql_scoped(DialectKind::Sqlite, &path.database, &path.name);
    let mut sql = format!("SELECT {} FROM {table}", list.join(", "));
    sql.push_str(&read.where_sql);
    let mut order: Vec<String> = read
        .order_by
        .iter()
        .map(|(c, desc)| format!("{} {}", quote_double(c), if *desc { "DESC" } else { "ASC" }))
        .collect();
    if !infos.iter().any(|c| c.is_primary_key) && has_usable_rowid(conn, path, &infos)? {
        order.push("rowid ASC".into());
    }
    if !order.is_empty() {
        sql.push_str(&format!(" ORDER BY {}", order.join(", ")));
    }
    if read.has_filter {
        check_one_statement(DialectKind::Sqlite, &sql)?;
    }
    let estimate = if read.plain {
        let n: i64 = conn
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .map_err(query_err)?;
        Some(n.max(0) as u64)
    } else {
        None
    };
    Ok((sql, estimate))
}

fn value_of(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => Value::Number(n.to_string()),
        ValueRef::Real(f) => Value::Number(real_text(f)),
        // Text that is not UTF-8 is kept as its bytes rather than mangled.
        ValueRef::Text(b) => match std::str::from_utf8(b) {
            Ok(s) => Value::Text(s.to_string()),
            Err(_) => Value::Bytes(b.to_vec()),
        },
        ValueRef::Blob(b) => Value::Bytes(b.to_vec()),
    }
}

/// Whether the file is in WAL mode, from the browse connection.
pub(super) fn journal_is_wal(conn: &Connection, database: &str) -> Result<bool> {
    let mode: String = conn
        .query_row(
            &format!("PRAGMA {}.journal_mode", quote_double(database)),
            [],
            |r| r.get(0),
        )
        .map_err(query_err)?;
    Ok(mode.eq_ignore_ascii_case("wal"))
}
