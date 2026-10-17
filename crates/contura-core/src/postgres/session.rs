//! A Postgres query session: its own client, owned by a task. Rows come through
//! the simple (text) protocol as a stream, so any type reads as text and a long
//! result stays open on the server between pages.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use tokio::sync::mpsc;
use tokio_postgres::error::{ErrorPosition, SqlState};
use tokio_postgres::{CancelToken, Client, NoTls, SimpleQueryMessage, SimpleQueryStream};
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::common::{bytes_preview, decode_hex, text_preview};
use crate::error::{Error, Result};
use crate::model::{Cell, PAGE_SIZE, PREVIEW_BYTES};
use crate::query::{
    CancelFlag, Canceller, Command, ExecOutcome, MoreRows, ResultColumn, SessionHandle, no_more,
    or_cancelled,
};

const NUMERIC_TYPES: &[&str] = &["int2", "int4", "int8", "numeric", "float4", "float8", "oid"];

struct PgCancel {
    token: CancelToken,
    tls: Option<MakeRustlsConnect>,
}

#[async_trait::async_trait]
impl Canceller for PgCancel {
    async fn cancel(&self) -> Result<()> {
        let sent = match &self.tls {
            None => self.token.cancel_query(NoTls).await,
            Some(tls) => self.token.cancel_query(tls.clone()).await,
        };
        sent.map_err(|e| Error::Query(format!("cannot cancel the query: {e}")))
    }
}

/// The server's message, plus where in the statement it points when it says.
/// A read-only refusal reads as "this Connection is Read-only" only when the Connection is.
pub(super) fn session_err(e: tokio_postgres::Error, read_only: bool) -> Error {
    match e.as_db_error() {
        Some(db) if read_only && *db.code() == SqlState::READ_ONLY_SQL_TRANSACTION => {
            Error::ReadOnlyRefused
        }
        Some(db) => match db.position() {
            Some(ErrorPosition::Original(p)) => {
                Error::Query(format!("{} (position {p})", db.message()))
            }
            _ => Error::Query(db.message().to_string()),
        },
        None => Error::Query(e.to_string()),
    }
}

pub(super) fn spawn(
    client: Client,
    tls: Option<MakeRustlsConnect>,
    read_only: bool,
) -> SessionHandle {
    let canceller: Arc<dyn Canceller> = Arc::new(PgCancel {
        token: client.cancel_token(),
        tls,
    });
    let flag = CancelFlag::default();
    let (tx, rx) = mpsc::channel(8);
    tokio::spawn(actor(
        client,
        rx,
        flag.clone(),
        canceller.clone(),
        read_only,
    ));
    SessionHandle::new(tx, canceller, flag)
}

/// A result with rows still on the server.
struct Open {
    stream: std::pin::Pin<Box<SimpleQueryStream>>,
    /// The first row of the next page, read ahead.
    carry: Option<Vec<Cell>>,
    bytea: Vec<bool>,
    numeric: Vec<bool>,
}

async fn actor(
    client: Client,
    mut rx: mpsc::Receiver<Command>,
    flag: CancelFlag,
    canceller: Arc<dyn Canceller>,
    read_only: bool,
) {
    let mut open: Option<Open> = None;
    while let Some(cmd) = rx.recv().await {
        if !matches!(cmd, Command::FetchMore { .. })
            && let Some(o) = open.take()
        {
            abandon(o, &client, canceller.as_ref()).await;
        }
        match cmd {
            Command::Execute { sql, reply } => {
                let result = execute(&client, &sql, &mut open, read_only).await;
                let _ = reply.send(result.map_err(|e| or_cancelled(&flag, e)));
            }
            Command::Explain { sql, reply } => {
                let result = explain(&client, &sql, read_only).await;
                let _ = reply.send(result.map_err(|e| or_cancelled(&flag, e)));
            }
            Command::FetchMore { reply } => {
                let result = match open.as_mut() {
                    None => Err(no_more()),
                    Some(o) => read_page(o, read_only)
                        .await
                        .map(|(rows, has_more)| MoreRows { rows, has_more }),
                };
                if !matches!(result, Ok(MoreRows { has_more: true, .. })) {
                    open = None;
                }
                let _ = reply.send(result.map_err(|e| or_cancelled(&flag, e)));
            }
            Command::CloseResult { reply } => {
                let _ = reply.send(());
            }
            Command::Close { reply } => {
                // Outside a transaction this only warns; inside one it undoes the work now.
                let _ = client.simple_query("ROLLBACK").await;
                let _ = reply.send(());
                break;
            }
        }
    }
}

/// How long an abandoned result may drain before the server is asked to stop it.
const DRAIN_FIRST: Duration = Duration::from_millis(250);

/// Ends an open result without reading it into memory. Rows the server has
/// already sent drain at once and need no cancel. A cancel is sent only while
/// the server is still producing rows, because a cancel that arrives after the
/// result ends would stop the next statement instead.
async fn abandon(mut o: Open, client: &Client, canceller: &dyn Canceller) {
    let drained = tokio::time::timeout(DRAIN_FIRST, async {
        while let Some(Ok(_)) = o.stream.next().await {}
    })
    .await;
    if drained.is_ok() {
        return;
    }
    let _ = canceller.cancel().await;
    let mut cancelled = false;
    while let Some(m) = o.stream.next().await {
        if let Err(e) = m {
            cancelled = e.code() == Some(&SqlState::QUERY_CANCELED);
        }
    }
    if !cancelled {
        // The result ended on its own just as the cancel went out: let a short
        // statement take the cancel if it is still on its way.
        let _ = client.simple_query("SELECT pg_sleep(0.2)").await;
    }
}

/// More than one statement in the text. Such text cannot be prepared, and a
/// failed prepare would abort a transaction the user typed.
fn several_statements(sql: &str) -> bool {
    sql.trim().trim_end_matches(';').contains(';')
}

fn cell(value: Option<&str>, is_bytea: bool, is_numeric: bool) -> Cell {
    match value {
        None => Cell::Null,
        Some(v) if is_numeric => Cell::Number { value: v.into() },
        Some(v) if is_bytea => {
            let hex = v.strip_prefix("\\x").unwrap_or(v);
            let shown = &hex[..hex.len().min(PREVIEW_BYTES * 2)];
            match decode_hex(shown) {
                Ok(bytes) => bytes_preview(&bytes, hex.len() as u64 / 2),
                Err(_) => text_preview(v, v.len() as u64),
            }
        }
        Some(v) => text_preview(v, v.len() as u64),
    }
}

async fn execute(
    client: &Client,
    sql: &str,
    open: &mut Option<Open>,
    read_only: bool,
) -> Result<ExecOutcome> {
    let session_err = |e| session_err(e, read_only);
    // Types come from a prepare, which does not run anything. A cancel that lands
    // during it ends the run; other prepare failures leave the run to report.
    let types: Vec<String> = if several_statements(sql) {
        Vec::new()
    } else {
        match client.prepare(sql).await {
            Ok(stmt) => stmt
                .columns()
                .iter()
                .map(|c| c.type_().name().to_string())
                .collect(),
            Err(e) if e.code() == Some(&SqlState::QUERY_CANCELED) => return Err(session_err(e)),
            Err(_) => Vec::new(),
        }
    };
    let mut stream = Box::pin(client.simple_query_raw(sql).await.map_err(session_err)?);
    let names: Vec<String> = loop {
        match stream.next().await {
            None => return Ok(ExecOutcome::Affected { rows: 0 }),
            Some(Err(e)) => return Err(session_err(e)),
            Some(Ok(SimpleQueryMessage::RowDescription(cols))) => {
                break cols.iter().map(|c| c.name().to_string()).collect();
            }
            Some(Ok(SimpleQueryMessage::CommandComplete(n))) => {
                return Ok(ExecOutcome::Affected { rows: n });
            }
            Some(Ok(_)) => {}
        }
    };
    let type_of = |i: usize| types.get(i).cloned().unwrap_or_default();
    let columns: Vec<ResultColumn> = names
        .into_iter()
        .enumerate()
        .map(|(i, name)| ResultColumn {
            name,
            numeric: NUMERIC_TYPES.contains(&type_of(i).as_str()),
            type_name: type_of(i),
        })
        .collect();
    let mut o = Open {
        stream,
        carry: None,
        bytea: columns.iter().map(|c| c.type_name == "bytea").collect(),
        numeric: columns.iter().map(|c| c.numeric).collect(),
    };
    let (rows, has_more) = read_page(&mut o, read_only).await?;
    if has_more {
        *open = Some(o);
    }
    Ok(ExecOutcome::Rows {
        columns,
        rows,
        has_more,
    })
}

/// Every cell of every row as full text.
async fn explain(client: &Client, sql: &str, read_only: bool) -> Result<Vec<Vec<String>>> {
    let messages = client
        .simple_query(sql)
        .await
        .map_err(|e| session_err(e, read_only))?;
    Ok(messages
        .iter()
        .filter_map(|m| match m {
            SimpleQueryMessage::Row(row) => Some(
                (0..row.len())
                    .map(|i| row.get(i).unwrap_or("").to_string())
                    .collect(),
            ),
            _ => None,
        })
        .collect())
}

/// Up to one page; reads one message ahead to know whether more rows follow.
async fn read_page(o: &mut Open, read_only: bool) -> Result<(Vec<Vec<Cell>>, bool)> {
    let mut page: Vec<Vec<Cell>> = o.carry.take().into_iter().collect();
    while let Some(msg) = o.stream.next().await {
        match msg.map_err(|e| session_err(e, read_only))? {
            SimpleQueryMessage::Row(row) => {
                let cells = (0..row.len())
                    .map(|i| {
                        let flag = |v: &[bool]| v.get(i).copied().unwrap_or(false);
                        cell(row.get(i), flag(&o.bytea), flag(&o.numeric))
                    })
                    .collect();
                if page.len() == PAGE_SIZE as usize {
                    o.carry = Some(cells);
                    return Ok((page, true));
                }
                page.push(cells);
            }
            SimpleQueryMessage::CommandComplete(_) => break,
            _ => {}
        }
    }
    Ok((page, false))
}
