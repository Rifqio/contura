//! The export read: a client of its own in one REPEATABLE READ READ ONLY transaction, read
//! through a declared cursor with `FETCH FORWARD n` over the simple-query protocol, so
//! values arrive as text that round-trips. `n` starts at 64 and adapts to the bytes
//! each batch holds (`FetchSize`), so memory is bounded by bytes, not only by rows.

use tokio_postgres::types::{Kind, Type};
use tokio_postgres::{Client, SimpleQueryMessage};

use super::page::{ColumnKind, order_term, relation};
use super::{Settings, open_client, query_err, session, session::session_err};
use crate::common::{decode_hex, quote_double};
use crate::error::{Error, Result};
use crate::jobs::source::{
    CHUNK_BYTES, Opened, Producer, RowSource, SourceColumn, SourceRequest, Value,
    check_one_statement, checked_query, start_source, value_kind,
};
use crate::model::DialectKind;

/// The most rows one FETCH asks for.
const MAX_FETCH: u64 = 1_000;
/// The first FETCH: small, so the first batch is bounded before any row width is known.
const FIRST_FETCH: u64 = 64;

/// How many rows the next FETCH asks for. It starts at 64, so the first batch holds at
/// most 64 rows whatever their width. After a batch over `CHUNK_BYTES` it at least
/// halves, and drops straight to what fits in `CHUNK_BYTES` at that batch's row width.
/// After a batch under half of `CHUNK_BYTES` it doubles, never past 1,000 or past what
/// fits. So after the first batch, uniform rows never pass 8 MB a batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct FetchSize(u64);

impl FetchSize {
    pub(super) fn new() -> Self {
        Self(FIRST_FETCH)
    }

    pub(super) fn rows(self) -> u64 {
        self.0
    }

    /// Adapts to a batch of `rows` rows holding `bytes` of values.
    pub(super) fn after(&mut self, rows: u64, bytes: usize) {
        if rows == 0 {
            return;
        }
        let width = (bytes as u64 / rows).max(1);
        let fits = (CHUNK_BYTES as u64 / width).max(1);
        if bytes > CHUNK_BYTES {
            self.0 = (self.0 / 2).min(fits).max(1);
        } else if bytes < CHUNK_BYTES / 2 {
            self.0 = (self.0 * 2).min(fits).clamp(1, MAX_FETCH);
        }
    }
}

/// Each FETCH as (database, rows, bytes), for the bounded-memory test.
#[cfg(any(test, feature = "test-util"))]
static FETCHES: std::sync::Mutex<Vec<(String, u64, usize)>> = std::sync::Mutex::new(Vec::new());

/// The (rows, bytes) of every FETCH an export read ran on `database`. Tests only.
#[cfg(any(test, feature = "test-util"))]
pub fn fetches_for_test(database: &str) -> Vec<(u64, usize)> {
    FETCHES
        .lock()
        .map(|f| {
            f.iter()
                .filter(|(d, ..)| d == database)
                .map(|(_, r, b)| (*r, *b))
                .collect()
        })
        .unwrap_or_default()
}

/// How a value's text is read.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Carry {
    /// `\x..` hex.
    Bytes,
    /// `t` or `f`.
    Bool,
    Number,
    Text,
}

const NUMERIC_TYPES: &[&str] = &["int2", "int4", "int8", "numeric", "float4", "float8", "oid"];

pub(super) async fn open(
    settings: Settings,
    database: String,
    read_only: bool,
    req: &SourceRequest,
) -> Result<Box<dyn RowSource>> {
    if let SourceRequest::Query { sql, .. } = req {
        checked_query(DialectKind::Postgres, sql)?;
    }
    let req = req.clone();
    start_source(move |p| {
        tokio::spawn(produce(settings, database, read_only, req, p));
    })
    .await
}

async fn produce(
    settings: Settings,
    database: String,
    read_only: bool,
    req: SourceRequest,
    p: Producer,
) {
    let Producer { ready, mut feed } = p;
    let client = match open_client(&settings, &database).await {
        Ok(c) => c,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let (sql, carry, columns, estimate) = match plan(&client, &req, read_only).await {
        Ok(planned) => planned,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let declare = format!("DECLARE contura_export NO SCROLL CURSOR FOR {sql}");
    if let Err(e) = client.batch_execute(&declare).await {
        let _ = ready.send(Err(session_err(e, read_only)));
        return;
    }
    let opened = Opened {
        columns,
        estimate,
        sql,
        server: session::canceller(&client, settings.tls.clone()),
    };
    if ready.send(Ok(opened)).is_err() {
        return;
    }
    let mut size = FetchSize::new();
    loop {
        let fetch = format!("FETCH FORWARD {} FROM contura_export", size.rows());
        let messages = match client.simple_query(&fetch).await {
            Ok(m) => m,
            Err(e) => {
                feed.fail(session_err(e, read_only)).await;
                return;
            }
        };
        let mut fetched = 0u64;
        let mut bytes = 0usize;
        // Each row is dropped once converted, so the batch shrinks as it is read.
        for message in messages {
            let SimpleQueryMessage::Row(row) = message else {
                continue;
            };
            fetched += 1;
            let values: Vec<Value> = carry
                .iter()
                .enumerate()
                .map(|(i, c)| {
                    let text = row.get(i);
                    bytes += text.map_or(0, str::len);
                    value_of(text, *c)
                })
                .collect();
            drop(row);
            if !feed.push(values).await {
                // Cancelled or dropped: dropping the client ends the transaction.
                return;
            }
        }
        #[cfg(any(test, feature = "test-util"))]
        if let Ok(mut log) = FETCHES.lock() {
            log.push((database.clone(), fetched, bytes));
        }
        if fetched == 0 {
            break;
        }
        size.after(fetched, bytes);
    }
    feed.finish().await;
    // Dropping the client closes the connection, which ends the read-only transaction.
}

type Plan = (String, Vec<Carry>, Vec<SourceColumn>, Option<u64>);

async fn plan(client: &Client, req: &SourceRequest, read_only: bool) -> Result<Plan> {
    // timestamptz values are written in UTC.
    client
        .batch_execute("SET TimeZone = 'UTC'; BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .await
        .map_err(query_err)?;
    let Some(parts) = req.table_parts() else {
        let SourceRequest::Query { sql, .. } = req else {
            unreachable!("not a table, so a query");
        };
        let sql = checked_query(DialectKind::Postgres, sql)?;
        let stmt = client
            .prepare(&sql)
            .await
            .map_err(|e| session_err(e, read_only))?;
        if stmt.columns().is_empty() {
            return Err(Error::InvalidInput(
                "This statement returns no rows to export.".into(),
            ));
        }
        let carry = stmt
            .columns()
            .iter()
            .map(|c| carry_of_type(c.type_()))
            .collect();
        let columns = stmt
            .columns()
            .iter()
            .map(|c| SourceColumn {
                name: c.name().to_string(),
                type_name: c.type_().name().to_string(),
                kind: value_kind(DialectKind::Postgres, c.type_().name()),
            })
            .collect();
        return Ok((sql, carry, columns, None));
    };
    let path = parts.path;
    let schema = path
        .schema
        .as_deref()
        .ok_or_else(|| Error::InvalidInput("choose a schema".into()))?;
    // The grid's catalog read, so types sort and carry exactly as they do there.
    let rel = relation(client, schema, &path.name).await?;
    let read = parts.read(DialectKind::Postgres, &rel.columns)?;
    let mut list = Vec::new();
    let mut carry = Vec::new();
    let mut columns = Vec::new();
    for &i in &read.selected {
        let c = &rel.columns[i];
        list.push(format!("t.{}", quote_double(&c.name)));
        carry.push(match (rel.bases[i].as_str(), rel.kinds[i]) {
            (_, ColumnKind::Bytes) => Carry::Bytes,
            ("bool", _) => Carry::Bool,
            (_, ColumnKind::Number) => Carry::Number,
            _ => Carry::Text,
        });
        columns.push(SourceColumn {
            name: c.name.clone(),
            type_name: c.type_name.clone(),
            kind: value_kind(DialectKind::Postgres, &c.type_name),
        });
    }
    let mut sql = format!(
        "SELECT {} FROM {}.{} AS t",
        list.join(", "),
        quote_double(schema),
        quote_double(&path.name)
    );
    sql.push_str(&read.where_sql);
    if !read.order_by.is_empty() {
        let order: Vec<String> = read
            .order_by
            .iter()
            .map(|(c, desc)| order_term(&rel, c, *desc))
            .collect();
        sql.push_str(&format!(" ORDER BY {}", order.join(", ")));
    }
    if read.has_filter {
        check_one_statement(DialectKind::Postgres, &sql)?;
        // The simple protocol runs every statement it is given; preparing the same text
        // refuses a filter that tries to add a second one, as the grid does.
        client
            .prepare(&sql)
            .await
            .map_err(|e| session_err(e, read_only))?;
    }
    let estimate =
        (read.plain && matches!(rel.relkind.as_str(), "r" | "p" | "m") && rel.reltuples >= 0.0)
            .then(|| rel.reltuples.round() as u64);
    Ok((sql, carry, columns, estimate))
}

fn carry_of_type(t: &Type) -> Carry {
    if let Kind::Domain(base) = t.kind() {
        return carry_of_type(base);
    }
    if *t == Type::BYTEA {
        Carry::Bytes
    } else if *t == Type::BOOL {
        Carry::Bool
    } else if NUMERIC_TYPES.contains(&t.name()) {
        Carry::Number
    } else {
        Carry::Text
    }
}

fn value_of(text: Option<&str>, carry: Carry) -> Value {
    let Some(text) = text else {
        return Value::Null;
    };
    match carry {
        Carry::Bytes => match text.strip_prefix("\\x").map(decode_hex) {
            Some(Ok(bytes)) => Value::Bytes(bytes),
            _ => Value::Text(text.to_string()),
        },
        Carry::Bool => match text {
            "t" => Value::Bool(true),
            "f" => Value::Bool(false),
            other => Value::Text(other.to_string()),
        },
        Carry::Number => Value::Number(text.to_string()),
        Carry::Text => Value::Text(text.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fetch_size_keeps_uniform_batches_under_the_chunk_bytes() {
        for width in [10usize, 1_000, 64 * 1024, 1024 * 1024, 16 * 1024 * 1024] {
            let mut size = FetchSize::new();
            for batch in 0..20 {
                let rows = size.rows();
                let bytes = rows as usize * width;
                if batch == 0 {
                    assert_eq!(rows, 64, "the first batch is 64 rows, whatever their width");
                } else {
                    assert!(bytes <= CHUNK_BYTES.max(width), "{width} wide: {rows} rows");
                }
                size.after(rows, bytes);
            }
        }
    }

    #[test]
    fn fetch_size_starts_small_then_grows_to_1000() {
        let mut size = FetchSize::new();
        assert_eq!(size.rows(), 64, "the first FETCH is 64 rows");
        // Small rows: it doubles up to 1,000.
        let mut seen = Vec::new();
        for _ in 0..6 {
            size.after(size.rows(), size.rows() as usize * 100);
            seen.push(size.rows());
        }
        assert_eq!(seen, [128, 256, 512, 1000, 1000, 1000]);
        // 1,000 rows of 16 KB: 16 MB, over the limit, so the count halves.
        size.after(1000, 16 * 1024 * 1000);
        assert_eq!(size.rows(), 500);
        // 500 rows of 1 MB: what fits is 8.
        size.after(500, 500 * 1024 * 1024);
        assert_eq!(size.rows(), 8);
        // A batch between half and all of the limit keeps the count.
        size.after(8, 6 * 1024 * 1024);
        assert_eq!(size.rows(), 8);
        size.after(0, 0);
        assert_eq!(size.rows(), 8);
    }
}
