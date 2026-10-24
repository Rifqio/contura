use mysql_async::prelude::Queryable;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use mysql_async::{Conn, OptsBuilder, Pool, Row, Value};

use super::query_err;
use super::quote::quote_ident;
use crate::common::{bytes_preview, hex_lower, order_columns, sql_scoped, text_preview};
use crate::error::{Error, Result};
use crate::model::{
    COUNT_CAP, Cell, ColumnInfo, CountRequest, DialectKind, LocateRequest, ObjectPath, PAGE_SIZE,
    PREVIEW_CHARS, Page, PageRequest, RowCount, RowPlace,
};

/// How a column's values are carried to the grid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ColumnKind {
    Number,
    /// BIT(n): the text protocol sends a binary string, so it is selected as `col + 0`.
    Bit,
    Bytes,
    Text,
}

pub(crate) struct ColumnMeta {
    pub info: ColumnInfo,
    pub kind: ColumnKind,
}

pub(crate) fn classify(data_type: &str) -> ColumnKind {
    match data_type.to_ascii_lowercase().as_str() {
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "decimal"
        | "numeric" | "float" | "double" | "year" => ColumnKind::Number,
        "bit" => ColumnKind::Bit,
        "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" => {
            ColumnKind::Bytes
        }
        _ => ColumnKind::Text,
    }
}

/// Columns of a table in ordinal order, each with its classification.
pub(crate) async fn table_column_meta(
    conn: &mut Conn,
    path: &ObjectPath,
) -> Result<Vec<ColumnMeta>> {
    let rows: Vec<(String, String, String, String)> = conn
        .exec(
            "SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, COLUMN_KEY FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
            (&path.database, &path.name),
        )
        .await
        .map_err(query_err)?;
    if rows.is_empty() {
        return Err(Error::NotFound(format!(
            "table {}.{}",
            path.database, path.name
        )));
    }
    Ok(rows
        .into_iter()
        .map(|(name, type_name, data_type, key)| ColumnMeta {
            info: ColumnInfo {
                name,
                type_name,
                is_primary_key: key == "PRI",
            },
            kind: classify(&data_type),
        })
        .collect())
}

/// The text protocol sends every non-NULL value as bytes.
fn value_bytes(v: &Value) -> Option<&[u8]> {
    match v {
        Value::Bytes(b) => Some(b),
        _ => None,
    }
}

fn value_u64(v: &Value) -> Option<u64> {
    std::str::from_utf8(value_bytes(v)?).ok()?.parse().ok()
}

/// Primary keys and numbers are selected as-is; every other column is cut to
/// `PREVIEW_CHARS + 1` in the SQL, plus its full byte length.
fn is_plain(c: &ColumnMeta) -> bool {
    c.info.is_primary_key || matches!(c.kind, ColumnKind::Number | ColumnKind::Bit)
}

/// The grid's select list: numbers and keys whole, every other column cut in the SQL
/// plus its full byte length.
fn select_list(cols: &[ColumnMeta]) -> Vec<String> {
    let mut list = Vec::new();
    for c in cols {
        let q = quote_ident(&c.info.name);
        if c.kind == ColumnKind::Bit {
            list.push(format!("{q} + 0"));
        } else if is_plain(c) {
            list.push(q);
        } else {
            list.push(format!("LEFT({q}, {})", PREVIEW_CHARS + 1));
            list.push(format!("OCTET_LENGTH({q})"));
        }
    }
    list
}

fn build_select(
    table: &ObjectPath,
    cols: &[ColumnMeta],
    order_by: &[(String, bool)],
    where_sql: &str,
    offset: u64,
) -> String {
    let list = select_list(cols);
    let mut sql = format!(
        "SELECT {} FROM {}",
        list.join(", "),
        sql_scoped(DialectKind::MySql, &table.database, &table.name)
    );
    sql.push_str(where_sql);
    if !order_by.is_empty() {
        let parts: Vec<String> = order_by
            .iter()
            .map(|(c, desc)| format!("{} {}", quote_ident(c), if *desc { "DESC" } else { "ASC" }))
            .collect();
        sql.push_str(&format!(" ORDER BY {}", parts.join(", ")));
    }
    sql.push_str(&format!(" LIMIT {} OFFSET {offset}", PAGE_SIZE + 1));
    sql
}

fn plain_cell(kind: ColumnKind, b: &[u8]) -> Cell {
    let total_bytes = b.len() as u64;
    match kind {
        ColumnKind::Number | ColumnKind::Bit => Cell::Number {
            value: String::from_utf8_lossy(b).into_owned(),
        },
        ColumnKind::Bytes => Cell::Bytes {
            preview_hex: hex_lower(b),
            truncated: false,
            total_bytes,
        },
        ColumnKind::Text => Cell::Text {
            value: String::from_utf8_lossy(b).into_owned(),
            truncated: false,
            total_bytes,
        },
    }
}

fn preview_cell(kind: ColumnKind, b: &[u8], total_bytes: u64) -> Cell {
    if kind == ColumnKind::Bytes {
        return bytes_preview(b, total_bytes);
    }
    text_preview(&String::from_utf8_lossy(b), total_bytes)
}

fn convert_row(row: &Row, cols: &[ColumnMeta]) -> Vec<Cell> {
    let mut idx = 0;
    let mut cells = Vec::with_capacity(cols.len());
    for c in cols {
        let value = &row[idx];
        if is_plain(c) {
            idx += 1;
            cells.push(value_bytes(value).map_or(Cell::Null, |b| plain_cell(c.kind, b)));
        } else {
            let total = value_u64(&row[idx + 1]);
            idx += 2;
            cells.push(value_bytes(value).map_or(Cell::Null, |b| {
                preview_cell(c.kind, b, total.unwrap_or(b.len() as u64))
            }));
        }
    }
    cells
}

/// Step 11f: up to `limit` rows of one base table in a read-only transaction on one
/// pooled connection, with the server's own 5 s limit as a hint. The grid's select
/// list and cells; no ORDER BY, no OFFSET, no filter. The transaction is always
/// rolled back.
pub(crate) async fn sample_rows(pool: &Pool, path: &ObjectPath, limit: u32) -> Result<Page> {
    let mut conn = pool.get_conn().await.map_err(query_err)?;
    conn.query_drop("START TRANSACTION READ ONLY")
        .await
        .map_err(query_err)?;
    let out = sample_in_transaction(&mut conn, path, limit).await;
    let _ = conn.query_drop("ROLLBACK").await;
    out
}

async fn sample_in_transaction(conn: &mut Conn, path: &ObjectPath, limit: u32) -> Result<Page> {
    let kind: Option<String> = conn
        .exec_first(
            "SELECT TABLE_TYPE FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
            (&path.database, &path.name),
        )
        .await
        .map_err(query_err)?;
    match kind.as_deref() {
        None => {
            return Err(Error::NotFound(format!(
                "table {}.{}",
                path.database, path.name
            )));
        }
        Some("BASE TABLE") => {}
        Some(_) => return Err(Error::InvalidInput("not a table".into())),
    }
    let cols = table_column_meta(conn, path).await?;
    let sql = format!(
        "SELECT /*+ MAX_EXECUTION_TIME({}) */ {} FROM {} LIMIT {limit}",
        crate::dialect::SAMPLE_TIMEOUT_MS,
        select_list(&cols).join(", "),
        sql_scoped(DialectKind::MySql, &path.database, &path.name)
    );
    let raw: Vec<Row> = conn.query(sql).await.map_err(query_err)?;
    let rows = raw.iter().map(|r| convert_row(r, &cols)).collect();
    Ok(Page {
        columns: cols.into_iter().map(|c| c.info).collect(),
        rows,
        has_more: false,
    })
}

/// MySQL's error when `MAX_EXECUTION_TIME` stops a statement (ER_QUERY_TIMEOUT).
const QUERY_TIMEOUT: u16 = 3024;
/// MariaDB's error when `max_statement_time` stops a statement (ER_STATEMENT_TIMEOUT).
const STATEMENT_TIMEOUT: u16 = 1969;
/// How long past the server's limit the client still waits before it drops the count.
const CLIENT_MARGIN_MS: u64 = 1_000;

pub(crate) fn is_timeout_code(code: u16) -> bool {
    code == QUERY_TIMEOUT || code == STATEMENT_TIMEOUT
}

pub(crate) fn is_mariadb(version: &str) -> bool {
    version.to_ascii_lowercase().contains("mariadb")
}

/// The count's SELECT. MySQL takes the `MAX_EXECUTION_TIME` hint; with `no_hint`
/// (MariaDB, which ignores it) the limit is set on the session instead.
pub(crate) fn count_sql(req: &CountRequest, timeout_ms: u64, no_hint: bool) -> String {
    let hint = if no_hint {
        String::new()
    } else {
        format!("/*+ MAX_EXECUTION_TIME({timeout_ms}) */ ")
    };
    format!(
        "SELECT {hint}COUNT(*) FROM (SELECT 1 FROM {}{} LIMIT {}) AS x",
        sql_scoped(DialectKind::MySql, &req.table.database, &req.table.name),
        req.where_sql(),
        COUNT_CAP + 1
    )
}

/// MariaDB's limit for the statements of this session, in seconds.
pub(crate) fn mariadb_limit_sql(timeout_ms: u64) -> String {
    format!(
        "SET SESSION max_statement_time = {}.{:03}",
        timeout_ms / 1000,
        timeout_ms % 1000
    )
}

/// What a timed read asks: a count, or a row's place (M3).
enum Read<'a> {
    Count(&'a CountRequest),
    Locate(&'a LocateRequest),
}

impl Read<'_> {
    fn table(&self) -> &ObjectPath {
        match self {
            Read::Count(r) => &r.table,
            Read::Locate(r) => &r.table,
        }
    }
}

/// A timed read's answer: the first column of its one row (none for a missing row), or
/// the time limit ran out.
enum ReadOut {
    Value(Option<u64>),
    TimedOut,
}

/// UX step 8: the rows matching the filter, counted up to `COUNT_CAP + 1`, on a
/// connection of its own (never one of the pool's), in a read-only transaction. The
/// server stops the count after `timeout_ms` (MySQL's hint, MariaDB's session limit),
/// and in every case the client stops waiting a second later, drops the connection and
/// asks the server to kill the query. A prepared statement is one statement, so the
/// filter can't add a second. `server_limit` false leaves the server's limit off (tests).
pub(crate) async fn count_rows(
    opts: &OptsBuilder,
    req: &CountRequest,
    timeout_ms: u64,
    server_limit: bool,
) -> Result<RowCount> {
    Ok(
        match timed_read(opts, Read::Count(req), timeout_ms, server_limit).await? {
            ReadOut::Value(n) => RowCount::Counted {
                rows: n.unwrap_or(0),
            },
            ReadOut::TimedOut => RowCount::TimedOut,
        },
    )
}

/// M3: the row's 0-based place in the page order (`fetch_page`'s ORDER BY) among the rows
/// matching the filter, read as `count_rows` reads.
pub(crate) async fn locate_row(
    opts: &OptsBuilder,
    req: &LocateRequest,
    timeout_ms: u64,
    server_limit: bool,
) -> Result<RowPlace> {
    Ok(
        match timed_read(opts, Read::Locate(req), timeout_ms, server_limit).await? {
            ReadOut::Value(Some(n)) => RowPlace::Found {
                index: n.saturating_sub(1),
            },
            ReadOut::Value(None) => RowPlace::Missing,
            ReadOut::TimedOut => RowPlace::TimedOut,
        },
    )
}

async fn timed_read(
    opts: &OptsBuilder,
    read: Read<'_>,
    timeout_ms: u64,
    server_limit: bool,
) -> Result<ReadOut> {
    let id = Arc::new(AtomicU32::new(0));
    let seen = id.clone();
    let work = async {
        let mut conn = Conn::new(opts.clone()).await.map_err(query_err)?;
        seen.store(conn.id(), Ordering::Relaxed);
        let out = read_on(&mut conn, &read, timeout_ms, server_limit).await;
        let _ = conn.disconnect().await;
        out
    };
    let limit = Duration::from_millis(timeout_ms + CLIENT_MARGIN_MS);
    match tokio::time::timeout(limit, work).await {
        Ok(out) => out,
        Err(_) => {
            // The read's connection went with the dropped future; stop its query too.
            let id = id.load(Ordering::Relaxed);
            if id != 0 {
                let opts = opts.clone();
                tokio::spawn(async move {
                    if let Ok(mut conn) = Conn::new(opts).await {
                        let _ = conn.query_drop(format!("KILL QUERY {id}")).await;
                        let _ = conn.disconnect().await;
                    }
                });
            }
            Ok(ReadOut::TimedOut)
        }
    }
}

async fn read_on(
    conn: &mut Conn,
    read: &Read<'_>,
    timeout_ms: u64,
    server_limit: bool,
) -> Result<ReadOut> {
    let version: Option<String> = conn
        .query_first("SELECT VERSION()")
        .await
        .map_err(query_err)?;
    let mariadb = version.as_deref().is_some_and(is_mariadb);
    if server_limit && mariadb {
        conn.query_drop(mariadb_limit_sql(timeout_ms))
            .await
            .map_err(query_err)?;
    }
    conn.query_drop("START TRANSACTION READ ONLY")
        .await
        .map_err(query_err)?;
    let out = read_in_transaction(conn, read, timeout_ms, mariadb || !server_limit).await;
    let _ = conn.query_drop("ROLLBACK").await;
    out
}

async fn read_in_transaction(
    conn: &mut Conn,
    read: &Read<'_>,
    timeout_ms: u64,
    no_hint: bool,
) -> Result<ReadOut> {
    let cols = table_column_meta(conn, read.table()).await?;
    let sql = match read {
        Read::Count(req) => count_sql(req, timeout_ms, no_hint),
        Read::Locate(req) => {
            let infos: Vec<ColumnInfo> = cols.iter().map(|c| c.info.clone()).collect();
            locate_sql(req, &infos, timeout_ms, no_hint)?
        }
    };
    match conn.exec_first::<u64, _, _>(sql, ()).await {
        Ok(n) => Ok(ReadOut::Value(match read {
            Read::Count(_) => Some(n.unwrap_or(0)),
            Read::Locate(_) => n,
        })),
        Err(mysql_async::Error::Server(e)) if is_timeout_code(e.code) => Ok(ReadOut::TimedOut),
        Err(e) => Err(query_err(e)),
    }
}

/// The row's place: a window over the filtered rows in the page order, then its key.
pub(crate) fn locate_sql(
    req: &LocateRequest,
    columns: &[ColumnInfo],
    timeout_ms: u64,
    no_hint: bool,
) -> Result<String> {
    let terms = crate::edits::key_terms(DialectKind::MySql, columns, &req.key)?;
    let order: Vec<String> = order_columns(columns, req.sort.as_ref())?
        .into_iter()
        .map(|(c, desc)| format!("{} {}", quote_ident(&c), if desc { "DESC" } else { "ASC" }))
        .collect();
    let keys: Vec<String> = columns
        .iter()
        .filter(|c| c.is_primary_key)
        .map(|c| quote_ident(&c.name))
        .collect();
    let hint = if no_hint {
        String::new()
    } else {
        format!("/*+ MAX_EXECUTION_TIME({timeout_ms}) */ ")
    };
    Ok(format!(
        "SELECT {hint}contura_n FROM (SELECT {}, ROW_NUMBER() OVER (ORDER BY {}) AS contura_n \
         FROM {}{}) AS s WHERE {}",
        keys.join(", "),
        order.join(", "),
        sql_scoped(DialectKind::MySql, &req.table.database, &req.table.name),
        req.where_sql(),
        terms.join(" AND ")
    ))
}

pub(crate) async fn fetch_page(pool: &Pool, req: &PageRequest) -> Result<Page> {
    let mut conn = pool.get_conn().await.map_err(query_err)?;
    let cols = table_column_meta(&mut conn, &req.table).await?;
    let infos: Vec<ColumnInfo> = cols.iter().map(|c| c.info.clone()).collect();
    let order_by = order_columns(&infos, req.sort.as_ref())?;
    let offset = u64::from(req.page) * u64::from(PAGE_SIZE);
    let sql = build_select(&req.table, &cols, &order_by, &req.where_sql(), offset);
    if req.has_filter() {
        // The text protocol runs every statement it is given; preparing first
        // refuses a filter that tries to add a second one.
        let stmt = conn.prep(&sql).await.map_err(query_err)?;
        conn.close(stmt).await.map_err(query_err)?;
    }
    let raw: Vec<Row> = conn.query(sql).await.map_err(query_err)?;
    let has_more = raw.len() > PAGE_SIZE as usize;
    let rows = raw
        .iter()
        .take(PAGE_SIZE as usize)
        .map(|r| convert_row(r, &cols))
        .collect();
    Ok(Page {
        columns: cols.into_iter().map(|c| c.info).collect(),
        rows,
        has_more,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_limits_follow_the_server_flavour() {
        assert!(is_mariadb("10.11.6-MariaDB"));
        assert!(is_mariadb("11.4.2-MariaDB-ubu2404"));
        assert!(!is_mariadb("8.0.39"));
        let req = CountRequest {
            table: ObjectPath {
                database: "db".into(),
                schema: None,
                name: "t".into(),
            },
            filter: Some("id > 3".into()),
        };
        // MySQL takes the optimizer hint; MariaDB ignores it and takes a session limit in seconds.
        assert_eq!(
            count_sql(&req, 3000, false),
            "SELECT /*+ MAX_EXECUTION_TIME(3000) */ COUNT(*) FROM (SELECT 1 FROM `db`.`t` WHERE (\nid > 3\n) LIMIT 1001) AS x"
        );
        assert_eq!(
            count_sql(&req, 3000, true),
            "SELECT COUNT(*) FROM (SELECT 1 FROM `db`.`t` WHERE (\nid > 3\n) LIMIT 1001) AS x"
        );
        assert_eq!(
            mariadb_limit_sql(3000),
            "SET SESSION max_statement_time = 3.000"
        );
        assert_eq!(
            mariadb_limit_sql(250),
            "SET SESSION max_statement_time = 0.250"
        );
        assert!(is_timeout_code(3024));
        assert!(is_timeout_code(1969));
        assert!(!is_timeout_code(1064));
    }

    fn col(name: &str, pk: bool, kind: ColumnKind) -> ColumnMeta {
        ColumnMeta {
            info: ColumnInfo {
                name: name.into(),
                type_name: "x".into(),
                is_primary_key: pk,
            },
            kind,
        }
    }

    fn table() -> ObjectPath {
        ObjectPath {
            database: "db".into(),
            schema: None,
            name: "t".into(),
        }
    }

    fn cols() -> Vec<ColumnMeta> {
        vec![
            col("id", true, ColumnKind::Number),
            col("body", false, ColumnKind::Text),
            col("data", false, ColumnKind::Bytes),
            col("n", false, ColumnKind::Number),
            col("flags", false, ColumnKind::Bit),
        ]
    }

    #[test]
    fn select_truncates_in_sql_and_orders() {
        let order = vec![("body".to_string(), true), ("id".to_string(), false)];
        let sql = build_select(&table(), &cols(), &order, "", 2000);
        assert_eq!(
            sql,
            "SELECT `id`, LEFT(`body`, 1025), OCTET_LENGTH(`body`), LEFT(`data`, 1025), OCTET_LENGTH(`data`), `n`, `flags` + 0 FROM `db`.`t` ORDER BY `body` DESC, `id` ASC LIMIT 1001 OFFSET 2000"
        );
    }

    #[test]
    fn select_without_order_has_no_order_by() {
        let sql = build_select(&table(), &[col("n", false, ColumnKind::Number)], &[], "", 0);
        assert_eq!(sql, "SELECT `n` FROM `db`.`t` LIMIT 1001 OFFSET 0");
    }

    #[test]
    fn primary_key_text_is_never_truncated() {
        let sql = build_select(&table(), &[col("k", true, ColumnKind::Text)], &[], "", 0);
        assert_eq!(sql, "SELECT `k` FROM `db`.`t` LIMIT 1001 OFFSET 0");
    }

    #[test]
    fn classifies_bit_apart_from_numbers() {
        assert_eq!(classify("bit"), ColumnKind::Bit);
        assert_eq!(classify("bigint"), ColumnKind::Number);
        assert_eq!(classify("longblob"), ColumnKind::Bytes);
        assert_eq!(classify("varchar"), ColumnKind::Text);
    }
}
