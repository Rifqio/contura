use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, OptionalExtension};

use super::query_err;
use crate::common::{
    bytes_preview, check_key, decode_hex, order_columns, quote_double, sql_scoped, text_preview,
};
use crate::error::{Error, Result};
use crate::model::{
    COUNT_CAP, Cell, ColumnInfo, CountRequest, DialectKind, FULL_VALUE_LIMIT, FullValue,
    FullValueRequest, LocateRequest, ObjectPath, PAGE_SIZE, PREVIEW_CHARS, Page, PageRequest,
    RowCount, RowPlace,
};

/// Stands for the implicit `rowid` sort key. It starts with NUL, so it can
/// never equal a column name from the table.
const ROWID_KEY: &str = "\u{0}rowid";

/// Columns in declaration order. Works for views too; no rows means no such object.
pub(super) fn table_columns(conn: &Connection, path: &ObjectPath) -> Result<Vec<ColumnInfo>> {
    let mut stmt = conn
        .prepare("SELECT name, type, pk FROM pragma_table_info(?1, ?2) ORDER BY cid")
        .map_err(query_err)?;
    let cols: Vec<ColumnInfo> = stmt
        .query_map([path.name.as_str(), path.database.as_str()], |r| {
            Ok(ColumnInfo {
                name: r.get(0)?,
                type_name: r.get(1)?,
                is_primary_key: r.get::<_, i64>(2)? > 0,
            })
        })
        .map_err(query_err)?
        .collect::<std::result::Result<_, _>>()
        .map_err(query_err)?;
    if cols.is_empty() {
        return Err(Error::NotFound(format!(
            "table {}.{}",
            path.database, path.name
        )));
    }
    Ok(cols)
}

/// True for an ordinary rowid table whose `rowid` is not shadowed by a column.
pub(super) fn has_usable_rowid(
    conn: &Connection,
    path: &ObjectPath,
    cols: &[ColumnInfo],
) -> Result<bool> {
    if cols.iter().any(|c| c.name.eq_ignore_ascii_case("rowid")) {
        return Ok(false);
    }
    let sql = format!(
        "SELECT sql FROM {}.sqlite_master WHERE type = 'table' AND name = ?1",
        quote_double(&path.database)
    );
    let found: Option<Option<String>> = conn
        .query_row(&sql, [path.name.as_str()], |r| r.get(0))
        .optional()
        .map_err(query_err)?;
    Ok(found
        .flatten()
        .is_some_and(|s| !s.to_ascii_uppercase().contains("WITHOUT ROWID")))
}

/// The grid's select list: primary keys whole, every other column cut in the SQL plus
/// its full byte length.
fn select_list(cols: &[ColumnInfo]) -> Vec<String> {
    let mut list = Vec::new();
    for c in cols {
        let q = quote_double(&c.name);
        if c.is_primary_key {
            list.push(q);
        } else {
            list.push(format!(
                "CASE WHEN typeof({q}) IN ('text','blob') THEN substr({q}, 1, {}) ELSE {q} END",
                PREVIEW_CHARS + 1
            ));
            list.push(format!("length(CAST({q} AS BLOB))"));
        }
    }
    list
}

/// Primary keys are selected as-is. Every other column is cut to
/// `PREVIEW_CHARS + 1` in the SQL, plus its full byte length.
fn build_select(
    path: &ObjectPath,
    cols: &[ColumnInfo],
    order_by: &[(String, bool)],
    where_sql: &str,
    offset: u64,
) -> String {
    let list = select_list(cols);
    let mut sql = format!(
        "SELECT {} FROM {}",
        list.join(", "),
        sql_scoped(DialectKind::Sqlite, &path.database, &path.name)
    );
    sql.push_str(where_sql);
    if !order_by.is_empty() {
        let parts: Vec<String> = order_by
            .iter()
            .map(|(c, desc)| {
                let dir = if *desc { "DESC" } else { "ASC" };
                if c == ROWID_KEY {
                    format!("rowid {dir}")
                } else {
                    format!("{} {dir}", quote_double(c))
                }
            })
            .collect();
        sql.push_str(&format!(" ORDER BY {}", parts.join(", ")));
    }
    sql.push_str(&format!(" LIMIT {} OFFSET {offset}", PAGE_SIZE + 1));
    sql
}

/// Shortest text that reads back as the same f64, such as `3.0` or `0.30000000000000004`.
pub(super) fn real_text(f: f64) -> String {
    format!("{f:?}")
}

pub(super) fn cell_of(value: ValueRef<'_>, total: Option<i64>) -> Cell {
    match value {
        ValueRef::Null => Cell::Null,
        ValueRef::Integer(n) => Cell::Number {
            value: n.to_string(),
        },
        ValueRef::Real(f) => Cell::Number {
            value: real_text(f),
        },
        ValueRef::Text(b) => text_preview(
            &String::from_utf8_lossy(b),
            total.map_or(b.len() as u64, |t| t as u64),
        ),
        ValueRef::Blob(b) => bytes_preview(b, total.map_or(b.len() as u64, |t| t as u64)),
    }
}

/// One result row of a `select_list` query as cells.
fn read_row(row: &rusqlite::Row<'_>, cols: &[ColumnInfo]) -> Result<Vec<Cell>> {
    let mut idx = 0;
    let mut cells = Vec::with_capacity(cols.len());
    for c in cols {
        let value = row.get_ref(idx).map_err(query_err)?;
        if c.is_primary_key {
            idx += 1;
            cells.push(cell_of(value, None));
        } else {
            let total: Option<i64> = row.get(idx + 1).map_err(query_err)?;
            idx += 2;
            cells.push(cell_of(value, total));
        }
    }
    Ok(cells)
}

/// Step 11f: up to `limit` rows of one base table on `conn`, which the caller opened
/// read-only and put in a transaction. The grid's select list and cells; no ORDER BY,
/// no OFFSET, no filter.
pub(super) fn sample_rows(conn: &Connection, path: &ObjectPath, limit: u32) -> Result<Page> {
    let kind_sql = format!(
        "SELECT type FROM {}.sqlite_master WHERE name = ?1 COLLATE NOCASE \
           AND type IN ('table', 'view')",
        quote_double(&path.database)
    );
    let kind: Option<String> = conn
        .query_row(&kind_sql, [path.name.as_str()], |r| r.get(0))
        .optional()
        .map_err(query_err)?;
    match kind.as_deref() {
        None => {
            return Err(Error::NotFound(format!(
                "table {}.{}",
                path.database, path.name
            )));
        }
        Some("table") => {}
        Some(_) => return Err(Error::InvalidInput("not a table".into())),
    }
    let cols = table_columns(conn, path)?;
    let sql = format!(
        "SELECT {} FROM {} LIMIT {limit}",
        select_list(&cols).join(", "),
        sql_scoped(DialectKind::Sqlite, &path.database, &path.name)
    );
    let mut stmt = conn.prepare(&sql).map_err(query_err)?;
    let mut raw = stmt.query([]).map_err(query_err)?;
    let mut rows = Vec::new();
    while let Some(row) = raw.next().map_err(query_err)? {
        rows.push(read_row(row, &cols)?);
    }
    drop(raw);
    drop(stmt);
    Ok(Page {
        columns: cols,
        rows,
        has_more: false,
    })
}

/// UX step 8: the rows matching the filter, counted up to `COUNT_CAP + 1`, on a session
/// whose watchdog interrupts the statement at its time limit, which reads as `TimedOut`.
/// `prepare` refuses text with a second statement after the first.
pub(crate) fn count_rows(conn: &Connection, req: &CountRequest) -> Result<RowCount> {
    let sql = format!(
        "SELECT count(*) FROM (SELECT 1 FROM {}{} LIMIT {})",
        sql_scoped(DialectKind::Sqlite, &req.table.database, &req.table.name),
        req.where_sql(),
        COUNT_CAP + 1
    );
    let counted = conn
        .prepare(&sql)
        .and_then(|mut stmt| stmt.query_row([], |r| r.get::<_, i64>(0)));
    match counted {
        Ok(n) => Ok(RowCount::Counted { rows: n as u64 }),
        Err(rusqlite::Error::SqliteFailure(e, _))
            if e.code == rusqlite::ErrorCode::OperationInterrupted =>
        {
            Ok(RowCount::TimedOut)
        }
        Err(e) => Err(query_err(e)),
    }
}

/// M3: the row's 0-based place in the page order (`fetch_page`'s ORDER BY) among the rows
/// matching the filter. `prepare` refuses a second statement.
pub(crate) fn locate_row(conn: &Connection, req: &LocateRequest) -> Result<RowPlace> {
    let cols = table_columns(conn, &req.table)?;
    let terms = crate::edits::key_terms(DialectKind::Sqlite, &cols, &req.key)?;
    let order: Vec<String> = order_columns(&cols, req.sort.as_ref())?
        .into_iter()
        .map(|(c, desc)| format!("{} {}", quote_double(&c), if desc { "DESC" } else { "ASC" }))
        .collect();
    let keys: Vec<String> = cols
        .iter()
        .filter(|c| c.is_primary_key)
        .map(|c| quote_double(&c.name))
        .collect();
    let sql = format!(
        "SELECT contura_n FROM (SELECT {}, row_number() OVER (ORDER BY {}) AS contura_n FROM {}{}) \
         WHERE {}",
        keys.join(", "),
        order.join(", "),
        sql_scoped(DialectKind::Sqlite, &req.table.database, &req.table.name),
        req.where_sql(),
        terms.join(" AND ")
    );
    let found = conn.prepare(&sql).and_then(|mut stmt| {
        let mut rows = stmt.query([])?;
        match rows.next()? {
            Some(r) => Ok(Some(r.get::<_, i64>(0)?)),
            None => Ok(None),
        }
    });
    match found {
        Ok(Some(n)) => Ok(RowPlace::Found {
            index: (n - 1) as u64,
        }),
        Ok(None) => Ok(RowPlace::Missing),
        Err(rusqlite::Error::SqliteFailure(e, _))
            if e.code == rusqlite::ErrorCode::OperationInterrupted =>
        {
            Ok(RowPlace::TimedOut)
        }
        Err(e) => Err(query_err(e)),
    }
}

pub(crate) fn fetch_page(conn: &Connection, req: &PageRequest) -> Result<Page> {
    let cols = table_columns(conn, &req.table)?;
    let mut order_by = order_columns(&cols, req.sort.as_ref())?;
    if !cols.iter().any(|c| c.is_primary_key) && has_usable_rowid(conn, &req.table, &cols)? {
        order_by.push((ROWID_KEY.to_string(), false));
    }
    let offset = u64::from(req.page) * u64::from(PAGE_SIZE);
    let sql = build_select(&req.table, &cols, &order_by, &req.where_sql(), offset);
    // `prepare` refuses text with a second statement after the first.
    let mut stmt = conn.prepare(&sql).map_err(query_err)?;
    let mut raw = stmt.query([]).map_err(query_err)?;
    let mut rows = Vec::new();
    let mut has_more = false;
    while let Some(row) = raw.next().map_err(query_err)? {
        if rows.len() == PAGE_SIZE as usize {
            has_more = true;
            break;
        }
        rows.push(read_row(row, &cols)?);
    }
    drop(raw);
    drop(stmt);
    Ok(Page {
        columns: cols,
        rows,
        has_more,
    })
}

fn key_param(cell: &Cell) -> Result<Value> {
    match cell {
        Cell::Text {
            truncated: true, ..
        } => Err(Error::InvalidInput(
            "a truncated text value cannot identify a row".into(),
        )),
        Cell::Number { value } => {
            if let Ok(n) = value.parse::<i64>() {
                Ok(Value::Integer(n))
            } else {
                value
                    .parse::<f64>()
                    .map(Value::Real)
                    .map_err(|_| Error::InvalidInput(format!("{value} is not a number")))
            }
        }
        Cell::Text { value, .. } => Ok(Value::Text(value.clone())),
        Cell::Bytes {
            truncated: true, ..
        } => Err(Error::InvalidInput(
            "a truncated binary value cannot identify a row".into(),
        )),
        Cell::Bytes { preview_hex, .. } => Ok(Value::Blob(decode_hex(preview_hex)?)),
        Cell::Null => Err(Error::InvalidInput("key values must not be NULL".into())),
    }
}

pub(crate) fn fetch_full_value(conn: &Connection, req: &FullValueRequest) -> Result<FullValue> {
    let cols = table_columns(conn, &req.table)?;
    let target = cols
        .iter()
        .find(|c| c.name == req.column)
        .ok_or_else(|| Error::InvalidInput(format!("unknown column {}", req.column)))?;
    check_key(&cols, &req.key)?;
    let mut parts = Vec::new();
    let mut params = Vec::new();
    for part in &req.key {
        parts.push(format!("{} = ?", quote_double(&part.column)));
        params.push(key_param(&part.value)?);
    }
    let from = sql_scoped(DialectKind::Sqlite, &req.table.database, &req.table.name);
    let col = quote_double(&target.name);
    let where_sql = parts.join(" AND ");

    let len_sql = format!("SELECT length(CAST({col} AS BLOB)) FROM {from} WHERE {where_sql}");
    let len: Option<Option<i64>> = conn
        .query_row(&len_sql, rusqlite::params_from_iter(params.iter()), |r| {
            r.get(0)
        })
        .optional()
        .map_err(query_err)?;
    let len = len.ok_or_else(|| Error::NotFound("row no longer exists".into()))?;
    let Some(len) = len else {
        return Ok(FullValue::Text {
            value: String::new(),
        });
    };
    let len = len as u64;
    if len > FULL_VALUE_LIMIT {
        return Err(Error::ValueTooLarge(len));
    }

    let sql = format!("SELECT {col} FROM {from} WHERE {where_sql}");
    let value: Option<Value> = conn
        .query_row(&sql, rusqlite::params_from_iter(params.iter()), |r| {
            r.get(0)
        })
        .optional()
        .map_err(query_err)?;
    let value = value.ok_or_else(|| Error::NotFound("row no longer exists".into()))?;
    Ok(match value {
        Value::Blob(b) => FullValue::Bytes {
            base64: STANDARD.encode(b),
        },
        Value::Text(t) => FullValue::Text { value: t },
        Value::Integer(n) => FullValue::Text {
            value: n.to_string(),
        },
        Value::Real(f) => FullValue::Text {
            value: real_text(f),
        },
        Value::Null => FullValue::Text {
            value: String::new(),
        },
    })
}
