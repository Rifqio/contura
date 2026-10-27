//! A MySQL query session: its own connection, outside the browsing pool, owned
//! by a task. A long result stays open on the server between pages; Cancel and
//! abandoning a result send `KILL QUERY` from a pool connection.

use std::sync::Arc;

use mysql_async::consts::ColumnType;
use mysql_async::prelude::Queryable;
use mysql_async::{Column, Conn, QueryResult, TextProtocol, Value};

use super::link::{Opts, Pool};
use tokio::sync::{mpsc, oneshot};

use super::quote::quote_ident;
use super::{query_err, session_err};
use crate::common::{bytes_preview, text_preview};
use crate::error::{Error, Result};
use crate::model::{Cell, PAGE_SIZE};
use crate::query::{
    CancelFlag, Canceller, Command, ExecOutcome, MoreRows, ResultColumn, SessionHandle, no_more,
    or_cancelled,
};

/// The character set number MySQL gives binary strings and BLOBs.
const BINARY_CHARSET: u16 = 63;

pub(super) struct Kill {
    pub(super) pool: Pool,
    pub(super) id: u32,
}

#[async_trait::async_trait]
impl Canceller for Kill {
    async fn cancel(&self) -> Result<()> {
        let mut conn = self.pool.get_conn().await.map_err(query_err)?;
        conn.query_drop(format!("KILL QUERY {}", self.id))
            .await
            .map_err(query_err)
    }
}

pub(super) async fn spawn(
    opts: Opts,
    database: Option<&str>,
    pool: Pool,
    read_only: bool,
) -> Result<SessionHandle> {
    let mut conn = opts
        .conn()
        .await
        .map_err(|e| Error::Connect(format!("cannot open the query session: {e}")))?;
    if let Some(db) = database {
        conn.query_drop(format!("USE {}", quote_ident(db)))
            .await
            .map_err(query_err)?;
    }
    let canceller: Arc<dyn Canceller> = Arc::new(Kill {
        pool,
        id: conn.id(),
    });
    let flag = CancelFlag::default();
    let (tx, rx) = mpsc::channel(8);
    tokio::spawn(actor(conn, rx, flag.clone(), canceller.clone(), read_only));
    Ok(SessionHandle::new(tx, canceller, flag))
}

async fn actor(
    mut conn: Conn,
    mut rx: mpsc::Receiver<Command>,
    flag: CancelFlag,
    canceller: Arc<dyn Canceller>,
    read_only: bool,
) {
    let mut pending: Option<Command> = None;
    loop {
        let cmd = match pending.take() {
            Some(c) => c,
            None => match rx.recv().await {
                Some(c) => c,
                None => break,
            },
        };
        match cmd {
            Command::Execute { sql, reply } => {
                pending = execute(
                    &mut conn,
                    &sql,
                    reply,
                    &mut rx,
                    &flag,
                    canceller.as_ref(),
                    read_only,
                )
                .await;
            }
            Command::FetchMore { reply } => {
                let _ = reply.send(Err(no_more()));
            }
            Command::Explain { sql, reply } => {
                let result = explain(&mut conn, &sql, read_only).await;
                let _ = reply.send(result.map_err(|e| or_cancelled(&flag, e)));
            }
            Command::CloseResult { reply } => {
                let _ = reply.send(());
            }
            Command::Close { reply } => {
                // Outside a transaction this does nothing; inside one it undoes the work now.
                let _ = conn.query_drop("ROLLBACK").await;
                let _ = conn.disconnect().await;
                let _ = reply.send(());
                break;
            }
        }
    }
}

pub(super) fn type_name(c: &Column) -> &'static str {
    let binary = c.character_set() == BINARY_CHARSET;
    match c.column_type() {
        ColumnType::MYSQL_TYPE_DECIMAL | ColumnType::MYSQL_TYPE_NEWDECIMAL => "decimal",
        ColumnType::MYSQL_TYPE_TINY => "tinyint",
        ColumnType::MYSQL_TYPE_SHORT => "smallint",
        ColumnType::MYSQL_TYPE_INT24 => "mediumint",
        ColumnType::MYSQL_TYPE_LONG => "int",
        ColumnType::MYSQL_TYPE_LONGLONG => "bigint",
        ColumnType::MYSQL_TYPE_FLOAT => "float",
        ColumnType::MYSQL_TYPE_DOUBLE => "double",
        ColumnType::MYSQL_TYPE_YEAR => "year",
        ColumnType::MYSQL_TYPE_DATE => "date",
        ColumnType::MYSQL_TYPE_TIME => "time",
        ColumnType::MYSQL_TYPE_DATETIME => "datetime",
        ColumnType::MYSQL_TYPE_TIMESTAMP => "timestamp",
        ColumnType::MYSQL_TYPE_BIT => "bit",
        ColumnType::MYSQL_TYPE_JSON => "json",
        ColumnType::MYSQL_TYPE_ENUM => "enum",
        ColumnType::MYSQL_TYPE_SET => "set",
        ColumnType::MYSQL_TYPE_GEOMETRY => "geometry",
        ColumnType::MYSQL_TYPE_NULL => "null",
        ColumnType::MYSQL_TYPE_VARCHAR | ColumnType::MYSQL_TYPE_VAR_STRING => {
            if binary {
                "varbinary"
            } else {
                "varchar"
            }
        }
        ColumnType::MYSQL_TYPE_STRING => {
            if binary {
                "binary"
            } else {
                "char"
            }
        }
        ColumnType::MYSQL_TYPE_TINY_BLOB
        | ColumnType::MYSQL_TYPE_BLOB
        | ColumnType::MYSQL_TYPE_MEDIUM_BLOB
        | ColumnType::MYSQL_TYPE_LONG_BLOB => {
            if binary {
                "blob"
            } else {
                "text"
            }
        }
        _ => "",
    }
}

pub(super) const NUMERIC: &[&str] = &[
    "decimal",
    "tinyint",
    "smallint",
    "mediumint",
    "int",
    "bigint",
    "float",
    "double",
    "year",
];
/// Shown as hex: binary strings, BLOBs, and BIT, which the text protocol sends as raw bytes.
pub(super) const BYTES: &[&str] = &["varbinary", "binary", "blob", "bit", "geometry"];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Number,
    Bytes,
    Text,
}

fn cell(value: Option<&Value>, kind: Kind) -> Cell {
    match value {
        None | Some(Value::NULL) => Cell::Null,
        Some(Value::Bytes(b)) => match kind {
            Kind::Number => Cell::Number {
                value: String::from_utf8_lossy(b).into_owned(),
            },
            Kind::Bytes => bytes_preview(b, b.len() as u64),
            // Text that is not UTF-8 is shown as bytes rather than mangled.
            Kind::Text => match std::str::from_utf8(b) {
                Ok(s) => text_preview(s, b.len() as u64),
                Err(_) => bytes_preview(b, b.len() as u64),
            },
        },
        // The text protocol sends bytes; anything else is formatted as SQL would show it.
        Some(other) => text_preview(&other.as_sql(true), 0),
    }
}

/// Every cell of every row as full text.
async fn explain(conn: &mut Conn, sql: &str, read_only: bool) -> Result<Vec<Vec<String>>> {
    let rows: Vec<mysql_async::Row> = conn
        .query(sql)
        .await
        .map_err(|e| session_err(e, read_only))?;
    Ok(rows
        .iter()
        .map(|row| {
            (0..row.len())
                .map(|i| match row.as_ref(i) {
                    None | Some(Value::NULL) => String::new(),
                    Some(Value::Bytes(b)) => String::from_utf8_lossy(b).into_owned(),
                    Some(other) => other.as_sql(true),
                })
                .collect()
        })
        .collect())
}

type Result_<'a> = QueryResult<'a, 'static, TextProtocol>;

/// Up to one page; `carry` holds the row read ahead to learn whether more exist.
async fn read_page(
    result: &mut Result_<'_>,
    kinds: &[Kind],
    carry: &mut Option<Vec<Cell>>,
    read_only: bool,
) -> Result<(Vec<Vec<Cell>>, bool)> {
    let mut page: Vec<Vec<Cell>> = carry.take().into_iter().collect();
    while let Some(row) = result.next().await.map_err(|e| session_err(e, read_only))? {
        let cells = kinds
            .iter()
            .enumerate()
            .map(|(i, k)| cell(row.as_ref(i), *k))
            .collect();
        if page.len() == PAGE_SIZE as usize {
            *carry = Some(cells);
            return Ok((page, true));
        }
        page.push(cells);
    }
    Ok((page, false))
}

/// Reads every result left in `result`, from the current one on, and sums the rows they
/// changed: the first error from any of them is the error. A result with rows adds none.
async fn drain(result: &mut Result_<'_>) -> mysql_async::Result<u64> {
    let mut changed = 0;
    while let Some(columns) = result.columns() {
        if columns.is_empty() {
            changed += result.affected_rows();
        }
        while result.next().await?.is_some() {}
    }
    // No result is left, or a later one failed: the driver keeps that error pending, and
    // reading on gives it.
    result.next().await?;
    Ok(changed)
}

/// Runs one statement. While its rows last, answers `FetchMore`; returns the
/// first other command so the outer loop handles it.
async fn execute(
    conn: &mut Conn,
    sql: &str,
    reply: oneshot::Sender<Result<ExecOutcome>>,
    rx: &mut mpsc::Receiver<Command>,
    flag: &CancelFlag,
    canceller: &dyn Canceller,
    read_only: bool,
) -> Option<Command> {
    let fail = |e: Error| or_cancelled(flag, e);
    let mut result = match conn.query_iter(sql).await {
        Ok(r) => r,
        Err(e) => {
            let _ = reply.send(Err(fail(session_err(e, read_only))));
            return None;
        }
    };
    // A routine or compound statement sent whole (several `;`-parts) may answer with
    // several results: its first one is not paged, so the rest can be read now.
    let several = crate::safety::statement_count(crate::model::DialectKind::MySql, sql) > 1;
    let columns = result.columns().filter(|c| !c.is_empty());
    let Some(columns) = columns else {
        let done = drain(&mut result)
            .await
            .map_err(|e| session_err(e, read_only));
        let _ = reply.send(
            done.map(|rows| ExecOutcome::Affected { rows })
                .map_err(fail),
        );
        return None;
    };
    let shown: Vec<ResultColumn> = columns
        .iter()
        .map(|c| {
            let t = type_name(c);
            ResultColumn {
                name: c.name_str().into_owned(),
                type_name: t.to_string(),
                numeric: NUMERIC.contains(&t),
            }
        })
        .collect();
    let kinds: Vec<Kind> = shown
        .iter()
        .map(|c| {
            if c.numeric {
                Kind::Number
            } else if BYTES.contains(&c.type_name.as_str()) {
                Kind::Bytes
            } else {
                Kind::Text
            }
        })
        .collect();
    let mut carry = None;
    let (page, mut has_more) = match read_page(&mut result, &kinds, &mut carry, read_only).await {
        Ok(p) => p,
        Err(e) => {
            let _ = result.drop_result().await;
            let _ = reply.send(Err(fail(e)));
            return None;
        }
    };
    // Every later result is read before the outcome goes back, so its error is this
    // statement's error. A first result still open is read on only for a single statement.
    if !has_more || several {
        let skipped = async {
            while result.next().await?.is_some() {}
            drain(&mut result).await
        };
        if let Err(e) = skipped.await {
            let _ = result.drop_result().await;
            let _ = reply.send(Err(fail(session_err(e, read_only))));
            return None;
        }
        has_more = false;
    }
    // A killed function call (SLEEP, BENCHMARK) ends with a normal-looking row, not an
    // error. The user asked to stop it, so its row is not a result.
    if flag.take() {
        let _ = result.drop_result().await;
        let _ = reply.send(Err(Error::Cancelled));
        return None;
    }
    let _ = reply.send(Ok(ExecOutcome::Rows {
        columns: shown,
        rows: page,
        has_more,
    }));
    if !has_more {
        let _ = result.drop_result().await;
        return None;
    }
    loop {
        match rx.recv().await {
            Some(Command::FetchMore { reply }) => {
                match read_page(&mut result, &kinds, &mut carry, read_only).await {
                    Ok((rows, more)) => {
                        let _ = reply.send(Ok(MoreRows {
                            rows,
                            has_more: more,
                        }));
                        if !more {
                            let _ = result.drop_result().await;
                            return None;
                        }
                    }
                    Err(e) => {
                        let _ = result.drop_result().await;
                        let _ = reply.send(Err(fail(e)));
                        return None;
                    }
                }
            }
            other => {
                // Stop the server sending the rest, then discard what is in flight.
                let _ = canceller.cancel().await;
                let _ = result.drop_result().await;
                return match other {
                    Some(Command::CloseResult { reply }) => {
                        let _ = reply.send(());
                        None
                    }
                    other => other,
                };
            }
        }
    }
}
