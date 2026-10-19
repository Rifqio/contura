//! The export read: a second, read-only connection to the file, so the browse lock is not
//! held for minutes; `BEGIN` for one read snapshot, and a lazy query stepped on a thread of
//! its own into the channel. In WAL mode browsing and saving go on meanwhile.

use std::path::PathBuf;
use std::sync::Arc;

use rusqlite::Connection;
use rusqlite::types::ValueRef;

use super::page::{has_usable_rowid, real_text, table_columns};
use super::{open_existing, query_err};
use crate::backup::data::{
    PendingRows, SnapshotFacts, SnapshotRead, TableAsk, TableFacts, snapshot_channel,
    snapshot_opened,
};
use crate::backup::structure::sqlite::read_structure;
use crate::common::{quote_double, sql_scoped};
use crate::error::{Error, Result};
use crate::jobs::source::{
    Opened, Producer, RowSource, SourceColumn, SourceRequest, Value, check_one_statement,
    checked_query, source_channel, start_source, value_kind,
};
use crate::model::{DialectKind, ObjectPath};
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
    // Read-only whatever the Connection is: the export only reads.
    let conn = match open_existing(path, true) {
        Ok(c) => c,
        Err(e) => {
            let _ = p.ready.send(Err(e));
            return;
        }
    };
    let server: Arc<dyn Canceller> = Arc::new(Interrupt(conn.get_interrupt_handle()));
    if let Err(e) = conn.execute_batch("BEGIN") {
        let _ = p.ready.send(Err(query_err(e)));
        return;
    }
    let planned = match plan(&conn, req) {
        Ok(planned) => planned,
        Err(e) => {
            let _ = p.ready.send(Err(e));
            return;
        }
    };
    stream(&conn, planned, server, p);
}

/// Runs the planned SELECT on `conn`, sends `ready`, and steps it into the feed until
/// the end, a failure or a stop.
fn stream(
    conn: &Connection,
    planned: (String, Option<u64>),
    server: Arc<dyn Canceller>,
    p: Producer,
) {
    let Producer { ready, mut feed } = p;
    let (sql, estimate) = planned;
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
    drop(rows);
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

// ---- The Backup's snapshot (step 9) ----

/// Opens the Backup's read transaction on a read-only connection of its own, on a
/// thread of its own; see `Dialect::open_backup_read`. A SQLite file is one database,
/// so every table's rows are counted (the counts cost one scan each).
pub(super) async fn backup_read(path: PathBuf) -> Result<SnapshotRead> {
    let (ready, opened, asks_tx, asks) = snapshot_channel();
    std::thread::Builder::new()
        .name("contura-sqlite-backup".into())
        .spawn(move || {
            let conn = match open_existing(&path, true) {
                Ok(c) => c,
                Err(e) => {
                    let _ = ready.send(Err(e));
                    return;
                }
            };
            let facts = snapshot_facts(&conn);
            let ok = facts.is_ok();
            if ready.send(facts).is_ok() && ok {
                serve(&conn, asks);
            }
            // Dropping the connection ends the read transaction.
        })
        .map_err(|e| Error::Query(format!("cannot start the backup read: {e}")))?;
    snapshot_opened(opened, asks_tx).await
}

fn snapshot_facts(conn: &Connection) -> Result<SnapshotFacts> {
    conn.execute_batch("BEGIN").map_err(query_err)?;
    let parts = read_structure(conn)?;
    let mut tables = Vec::with_capacity(parts.tables.len());
    for name in &parts.tables {
        let n: i64 = conn
            .query_row(
                &format!("SELECT count(*) FROM main.{}", quote_double(name)),
                [],
                |r| r.get(0),
            )
            .map_err(query_err)?;
        tables.push(TableFacts {
            name: name.clone(),
            rows: n.max(0) as u64,
        });
    }
    let pages: i64 = conn
        .query_row("PRAGMA main.page_count", [], |r| r.get(0))
        .map_err(query_err)?;
    let size: i64 = conn
        .query_row("PRAGMA main.page_size", [], |r| r.get(0))
        .map_err(query_err)?;
    Ok(SnapshotFacts {
        parts,
        tables,
        data_bytes: (pages.max(0) * size.max(0)) as u64,
        non_snapshot: Vec::new(),
    })
}

/// Serves each asked table's rows on the snapshot's connection. `PRAGMA table_info`
/// leaves generated columns out, so the SELECT reads every other column.
fn serve(conn: &Connection, mut asks: tokio::sync::mpsc::Receiver<TableAsk>) {
    let server: Arc<dyn Canceller> = Arc::new(Interrupt(conn.get_interrupt_handle()));
    while let Some(ask) = asks.blocking_recv() {
        let req = SourceRequest::Table {
            path: ObjectPath {
                database: "main".into(),
                schema: None,
                name: ask.table.clone(),
            },
            columns: Vec::new(),
            filter: None,
            sort: None,
            keys: Vec::new(),
        };
        let planned = plan(conn, &req).and_then(|p| {
            let path = req.table_parts().map(|t| t.path.clone());
            let key = match path {
                Some(path) => table_columns(conn, &path)?
                    .into_iter()
                    .filter(|c| c.is_primary_key)
                    .map(|c| c.name)
                    .collect(),
                None => Vec::new(),
            };
            Ok((p, key))
        });
        match planned {
            Err(e) => {
                let _ = ask.reply.send(Err(e));
            }
            Ok((planned, key)) => {
                let (producer, pending) = source_channel();
                let rows = PendingRows {
                    source: pending,
                    overriding: false,
                    key,
                };
                if ask.reply.send(Ok(rows)).is_err() {
                    return;
                }
                stream(conn, planned, server.clone(), producer);
            }
        }
    }
}

/// An exact copy of the file at `path` into `into` (which exists and is empty), made
/// with `VACUUM INTO` on a read-only connection.
pub(super) fn file_copy(path: &std::path::Path, into: &std::path::Path) -> Result<()> {
    let conn = open_existing(path, true)?;
    let target = into
        .to_str()
        .ok_or_else(|| Error::InvalidInput("The file path is not valid text.".into()))?;
    conn.execute("VACUUM INTO ?1", [target])
        .map_err(query_err)?;
    Ok(())
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
