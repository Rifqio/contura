//! A SQLite query session: its own connection to the file, on its own thread.

use std::path::PathBuf;
use std::sync::Arc;

use rusqlite::{Connection, Rows};
use tokio::sync::mpsc;

use super::page::cell_of;
use super::{open_existing, query_err};
use crate::error::{Error, Result};
use crate::model::{Cell, PAGE_SIZE};
use crate::query::{
    CancelFlag, Canceller, Command, ExecOutcome, MoreRows, ResultColumn, SessionHandle, no_more,
    or_cancelled,
};

struct Interrupt(rusqlite::InterruptHandle);

#[async_trait::async_trait]
impl Canceller for Interrupt {
    async fn cancel(&self) -> Result<()> {
        self.0.interrupt();
        Ok(())
    }
}

/// Opens a second connection to `path` and starts its session thread. Blocking.
pub(crate) fn spawn(path: PathBuf) -> Result<SessionHandle> {
    let conn = open_existing(&path)?;
    let interrupt = Interrupt(conn.get_interrupt_handle());
    let flag = CancelFlag::default();
    let (tx, rx) = mpsc::channel(8);
    let actor_flag = flag.clone();
    std::thread::Builder::new()
        .name("dbview-sqlite-session".into())
        .spawn(move || actor(conn, rx, actor_flag))
        .map_err(|e| Error::Connect(format!("cannot start the query session: {e}")))?;
    Ok(SessionHandle::new(tx, Arc::new(interrupt), flag))
}

fn actor(conn: Connection, mut rx: mpsc::Receiver<Command>, flag: CancelFlag) {
    let mut pending: Option<Command> = None;
    loop {
        let Some(cmd) = pending.take().or_else(|| rx.blocking_recv()) else {
            break;
        };
        match cmd {
            Command::Execute { sql, reply } => {
                pending = execute(&conn, &sql, reply, &mut rx, &flag);
            }
            Command::FetchMore { reply } => {
                let _ = reply.send(Err(no_more()));
            }
            Command::CloseResult { reply } => {
                let _ = reply.send(());
            }
            Command::Close { reply } => {
                if !conn.is_autocommit() {
                    let _ = conn.execute_batch("ROLLBACK");
                }
                let _ = reply.send(());
                break;
            }
        }
    }
}

/// Up to one page of rows; `carry` holds the row read ahead to learn whether more exist.
fn read_page(
    rows: &mut Rows<'_>,
    width: usize,
    carry: &mut Option<Vec<Cell>>,
) -> rusqlite::Result<(Vec<Vec<Cell>>, bool)> {
    let mut page = Vec::new();
    if let Some(row) = carry.take() {
        page.push(row);
    }
    while let Some(row) = rows.next()? {
        let cells = (0..width)
            .map(|i| row.get_ref(i).map(|v| cell_of(v, None)))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if page.len() == PAGE_SIZE as usize {
            *carry = Some(cells);
            return Ok((page, true));
        }
        page.push(cells);
    }
    Ok((page, false))
}

fn is_numeric_decl(decl: &str) -> bool {
    let d = decl.to_ascii_uppercase();
    ["INT", "REAL", "NUM", "DEC", "FLOA", "DOUB"]
        .iter()
        .any(|k| d.contains(k))
}

/// Runs one statement. While its rows last, answers `FetchMore`; returns the
/// first other command so the outer loop handles it.
fn execute(
    conn: &Connection,
    sql: &str,
    reply: tokio::sync::oneshot::Sender<Result<ExecOutcome>>,
    rx: &mut mpsc::Receiver<Command>,
    flag: &CancelFlag,
) -> Option<Command> {
    let fail = |e: rusqlite::Error| or_cancelled(flag, query_err(e));
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(e) => {
            let _ = reply.send(Err(fail(e)));
            return None;
        }
    };
    let width = stmt.column_count();
    if width == 0 {
        let before = conn.total_changes();
        let outcome = stmt.raw_execute().map(|_| ExecOutcome::Affected {
            rows: conn.total_changes().saturating_sub(before),
        });
        let _ = reply.send(outcome.map_err(fail));
        return None;
    }
    let mut columns: Vec<ResultColumn> = stmt
        .columns()
        .iter()
        .map(|c| ResultColumn {
            name: c.name().to_string(),
            type_name: c.decl_type().unwrap_or("").to_string(),
            numeric: c.decl_type().is_some_and(is_numeric_decl),
        })
        .collect();
    let mut rows = match stmt.query([]) {
        Ok(r) => r,
        Err(e) => {
            let _ = reply.send(Err(fail(e)));
            return None;
        }
    };
    let mut carry = None;
    let (page, has_more) = match read_page(&mut rows, width, &mut carry) {
        Ok(p) => p,
        Err(e) => {
            let _ = reply.send(Err(fail(e)));
            return None;
        }
    };
    // An undeclared column (an expression) is numeric when its first value is.
    for (i, c) in columns.iter_mut().enumerate() {
        if c.type_name.is_empty() {
            c.numeric = page
                .iter()
                .map(|r| &r[i])
                .find(|v| !matches!(v, Cell::Null))
                .is_some_and(|v| matches!(v, Cell::Number { .. }));
        }
    }
    let _ = reply.send(Ok(ExecOutcome::Rows {
        columns,
        rows: page,
        has_more,
    }));
    if !has_more {
        return None;
    }
    loop {
        match rx.blocking_recv() {
            Some(Command::FetchMore { reply }) => match read_page(&mut rows, width, &mut carry) {
                Ok((rows_page, more)) => {
                    let _ = reply.send(Ok(MoreRows {
                        rows: rows_page,
                        has_more: more,
                    }));
                    if !more {
                        return None;
                    }
                }
                Err(e) => {
                    let _ = reply.send(Err(fail(e)));
                    return None;
                }
            },
            // Dropping `rows` here finalizes the statement: the rest is never read.
            Some(Command::CloseResult { reply }) => {
                let _ = reply.send(());
                return None;
            }
            Some(other) => return Some(other),
            None => return None,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Cell, PREVIEW_CHARS};
    use crate::query::ExecOutcome;
    use std::time::{Duration, Instant};

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("q.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, blob BLOB, amount REAL);
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2500)
             INSERT INTO t(id, name) SELECT i, 'row ' || i FROM n;",
        )
        .unwrap();
        (dir, path)
    }

    fn rows(o: ExecOutcome) -> (Vec<Vec<Cell>>, bool) {
        match o {
            ExecOutcome::Rows { rows, has_more, .. } => (rows, has_more),
            other => panic!("expected rows, got {other:?}"),
        }
    }

    fn num(c: &Cell) -> &str {
        match c {
            Cell::Number { value } => value,
            other => panic!("expected a number, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn rows_come_a_page_at_a_time() {
        let (_d, path) = fixture();
        let s = spawn(path).unwrap();
        let (first, more) = rows(s.execute("SELECT id FROM t ORDER BY id").await.unwrap());
        assert_eq!((first.len(), more), (1000, true));
        assert_eq!(num(&first[0][0]), "1");
        let second = s.fetch_more().await.unwrap();
        assert_eq!((second.rows.len(), second.has_more), (1000, true));
        assert_eq!(num(&second.rows[0][0]), "1001");
        let third = s.fetch_more().await.unwrap();
        assert_eq!((third.rows.len(), third.has_more), (500, false));
        let err = s.fetch_more().await.unwrap_err();
        assert!(
            matches!(&err, Error::InvalidInput(m) if m == "There are no more rows to fetch."),
            "{err:?}"
        );
    }

    #[tokio::test]
    async fn writes_report_affected_rows_and_commit() {
        let (_d, path) = fixture();
        let s = spawn(path.clone()).unwrap();
        let out = s
            .execute("UPDATE t SET name = 'x' WHERE id <= 12")
            .await
            .unwrap();
        assert_eq!(out, ExecOutcome::Affected { rows: 12 });
        let other = Connection::open(&path).unwrap();
        let name: String = other
            .query_row("SELECT name FROM t WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "x");
    }

    #[tokio::test]
    async fn typed_transaction_spans_statements() {
        let (_d, path) = fixture();
        let s = spawn(path.clone()).unwrap();
        s.execute("BEGIN").await.unwrap();
        s.execute("INSERT INTO t(id) VALUES (9999)").await.unwrap();
        s.execute("ROLLBACK").await.unwrap();
        let other = Connection::open(&path).unwrap();
        let n: i64 = other
            .query_row("SELECT count(*) FROM t WHERE id = 9999", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[tokio::test]
    async fn errors_keep_the_session_usable() {
        let (_d, path) = fixture();
        let s = spawn(path).unwrap();
        let err = s.execute("SELECT * FROM missing").await.unwrap_err();
        assert!(
            matches!(&err, Error::Query(m) if m.contains("no such table: missing")),
            "{err:?}"
        );
        rows(s.execute("SELECT 1").await.unwrap());
    }

    #[tokio::test]
    async fn cancel_interrupts_a_running_query() {
        let (_d, path) = fixture();
        let s = std::sync::Arc::new(spawn(path).unwrap());
        let runner = s.clone();
        let started = Instant::now();
        let run = tokio::spawn(async move {
            runner
                .execute(
                    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000000000)
                     SELECT count(*) FROM n",
                )
                .await
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        s.cancel().await.unwrap();
        let err = run.await.unwrap().unwrap_err();
        assert!(matches!(err, Error::Cancelled), "{err:?}");
        assert!(started.elapsed() < Duration::from_secs(2));
        rows(s.execute("SELECT 1").await.unwrap());
    }

    #[tokio::test]
    async fn results_preview_large_and_binary_values() {
        let (_d, path) = fixture();
        let s = spawn(path).unwrap();
        let (r, _) = rows(
            s.execute("SELECT printf('%.*c', 5000000, 'x'), x'deadbeef', NULL, 1.5")
                .await
                .unwrap(),
        );
        match &r[0][0] {
            Cell::Text {
                value,
                truncated,
                total_bytes,
            } => {
                assert!(*truncated);
                assert_eq!(*total_bytes, 5_000_000);
                assert_eq!(value.chars().count(), PREVIEW_CHARS);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            r[0][1],
            Cell::Bytes {
                preview_hex: "deadbeef".into(),
                truncated: false,
                total_bytes: 4
            }
        );
        assert_eq!(r[0][2], Cell::Null);
        assert_eq!(num(&r[0][3]), "1.5");
    }

    #[tokio::test]
    async fn new_execute_abandons_the_open_result() {
        let (_d, path) = fixture();
        let s = spawn(path).unwrap();
        let (_, more) = rows(s.execute("SELECT id FROM t").await.unwrap());
        assert!(more);
        rows(s.execute("SELECT 2").await.unwrap());
        assert!(s.fetch_more().await.is_err());
    }
}
