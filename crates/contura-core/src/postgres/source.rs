//! The export read: a client of its own in one REPEATABLE READ READ ONLY transaction, read
//! through a declared cursor with `FETCH FORWARD n` over the simple-query protocol, so
//! values arrive as text that round-trips. `n` starts at 64 and adapts to the bytes
//! each batch holds (`FetchSize`), so memory is bounded by bytes, not only by rows.

use tokio_postgres::types::{Kind, Type};
use tokio_postgres::{Client, SimpleQueryMessage};

use super::page::{ColumnKind, order_term, relation};
use super::{Settings, open_client, query_err, session, session::session_err};
use crate::backup::data::{
    PendingRows, SnapshotFacts, SnapshotRead, TableAsk, TableFacts, snapshot_channel,
    snapshot_opened,
};
use crate::backup::structure::postgres::read_structure;
use crate::common::{decode_hex, quote_double};
use crate::error::{Error, Result};
use crate::jobs::source::{
    CHUNK_BYTES, Opened, Producer, RowSource, SourceColumn, SourceRequest, Value,
    check_one_statement, checked_query, source_channel, start_source, value_kind,
};
use crate::model::{DialectKind, ObjectPath};

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
    let client = match open_client(&settings, &database).await {
        Ok(c) => c,
        Err(e) => {
            let _ = p.ready.send(Err(e));
            return;
        }
    };
    let planned = match plan(&client, &req, read_only).await {
        Ok(planned) => planned,
        Err(e) => {
            let _ = p.ready.send(Err(e));
            return;
        }
    };
    let on = Cursor {
        client: &client,
        settings: &settings,
        database: &database,
        read_only,
        name: "contura_export",
    };
    stream(&on, planned, p).await;
    // Dropping the client closes the connection, which ends the read-only transaction.
}

/// Where a cursor read runs: the client in its transaction, and the cursor's name.
struct Cursor<'a> {
    client: &'a Client,
    settings: &'a Settings,
    database: &'a str,
    read_only: bool,
    name: &'a str,
}

/// Declares the cursor for `planned`, sends `ready`, and fetches into the feed until
/// the end, a failure or a stop. The cursor is left open; the caller closes it or ends
/// the transaction.
async fn stream(on: &Cursor<'_>, planned: Plan, p: Producer) {
    let Producer { ready, mut feed } = p;
    let (sql, carry, columns, estimate) = planned;
    let client = on.client;
    let declare = format!("DECLARE {} NO SCROLL CURSOR FOR {sql}", on.name);
    if let Err(e) = client.batch_execute(&declare).await {
        let _ = ready.send(Err(session_err(e, on.read_only)));
        return;
    }
    let opened = Opened {
        columns,
        estimate,
        sql,
        server: session::canceller(client, on.settings.tls.clone()),
    };
    if ready.send(Ok(opened)).is_err() {
        return;
    }
    let mut size = FetchSize::new();
    loop {
        let fetch = format!("FETCH FORWARD {} FROM {}", size.rows(), on.name);
        let messages = match client.simple_query(&fetch).await {
            Ok(m) => m,
            Err(e) => {
                feed.fail(session_err(e, on.read_only)).await;
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
                // Cancelled or dropped: the caller ends the transaction.
                return;
            }
        }
        #[cfg(any(test, feature = "test-util"))]
        if let Ok(mut log) = FETCHES.lock() {
            log.push((on.database.to_string(), fetched, bytes));
        }
        #[cfg(not(any(test, feature = "test-util")))]
        let _ = on.database;
        if fetched == 0 {
            break;
        }
        size.after(fetched, bytes);
    }
    feed.finish().await;
}

type Plan = (String, Vec<Carry>, Vec<SourceColumn>, Option<u64>);

async fn plan(client: &Client, req: &SourceRequest, read_only: bool) -> Result<Plan> {
    // timestamptz values are written in UTC.
    client
        .batch_execute("SET TimeZone = 'UTC'; BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .await
        .map_err(query_err)?;
    plan_select(client, req, read_only).await
}

/// The SELECT and how to carry its values, inside a transaction already open.
async fn plan_select(client: &Client, req: &SourceRequest, read_only: bool) -> Result<Plan> {
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

// ---- The Backup's snapshot (step 9) ----

/// The cursor each Backup table is read through, closed after the table.
const BACKUP_CURSOR: &str = "contura_backup";

/// Opens the Backup's snapshot of `schema` in `database` on a client of its own; see
/// `Dialect::open_backup_read`.
pub(super) async fn backup_read(
    settings: Settings,
    database: String,
    schema: String,
    read_only: bool,
    count_rows: bool,
) -> Result<SnapshotRead> {
    let (ready, opened, asks_tx, asks) = snapshot_channel();
    tokio::spawn(async move {
        let client = match open_client(&settings, &database).await {
            Ok(c) => c,
            Err(e) => {
                let _ = ready.send(Err(e));
                return;
            }
        };
        let facts = snapshot_facts(&client, &schema, count_rows).await;
        let ok = facts.is_ok();
        if ready.send(facts).is_ok() && ok {
            let on = Cursor {
                client: &client,
                settings: &settings,
                database: &database,
                read_only,
                name: BACKUP_CURSOR,
            };
            serve(&on, &schema, asks).await;
        }
        // Dropping the client closes the connection, which ends the transaction.
    });
    snapshot_opened(opened, asks_tx).await
}

async fn snapshot_facts(client: &Client, schema: &str, count_rows: bool) -> Result<SnapshotFacts> {
    client
        .batch_execute("SET TimeZone = 'UTC'; BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .await
        .map_err(query_err)?;
    // It sets `search_path` to '' for the rest of the session.
    let parts = read_structure(client, schema).await?;
    let stats = client
        .query(
            "SELECT c.relname::text, c.reltuples::float8, pg_catalog.pg_table_size(c.oid) \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relkind = 'r'",
            &[&schema],
        )
        .await
        .map_err(query_err)?;
    let mut tables = Vec::with_capacity(parts.tables.len());
    let mut data_bytes = 0u64;
    for name in &parts.tables {
        let stat = stats.iter().find(|r| r.get::<_, String>(0) == *name);
        let estimate = stat.map_or(-1.0, |r| r.get::<_, f64>(1));
        data_bytes += stat.map_or(0, |r| r.get::<_, i64>(2).max(0) as u64);
        // A table never analyzed has no estimate (-1): its rows are counted.
        let rows = if count_rows || estimate < 0.0 {
            let row = client
                .query_one(
                    &format!(
                        "SELECT count(*) FROM {}.{}",
                        quote_double(schema),
                        quote_double(name)
                    ),
                    &[],
                )
                .await
                .map_err(query_err)?;
            row.get::<_, i64>(0).max(0) as u64
        } else {
            estimate.round() as u64
        };
        tables.push(TableFacts {
            name: name.clone(),
            rows,
        });
    }
    Ok(SnapshotFacts {
        parts,
        tables,
        data_bytes,
        non_snapshot: Vec::new(),
    })
}

/// Serves each asked table's rows on the snapshot's client, one after the other.
async fn serve(on: &Cursor<'_>, schema: &str, mut asks: tokio::sync::mpsc::Receiver<TableAsk>) {
    while let Some(ask) = asks.recv().await {
        let planned = async {
            let BackupColumns {
                columns,
                overriding,
                key,
            } = backup_columns(on.client, schema, &ask.table).await?;
            let req = SourceRequest::Table {
                path: ObjectPath {
                    database: on.database.to_string(),
                    schema: Some(schema.to_string()),
                    name: ask.table.clone(),
                },
                columns,
                filter: None,
                sort: None,
                keys: Vec::new(),
            };
            Ok::<_, Error>((
                plan_select(on.client, &req, on.read_only).await?,
                overriding,
                key,
            ))
        }
        .await;
        match planned {
            Err(e) => {
                let _ = ask.reply.send(Err(e));
            }
            Ok((plan, overriding, key)) => {
                let (producer, pending) = source_channel();
                let rows = PendingRows {
                    source: pending,
                    overriding,
                    key,
                };
                if ask.reply.send(Ok(rows)).is_err() {
                    return;
                }
                stream(on, plan, producer).await;
                // A read stopped early leaves its cursor open; the next table needs the name.
                let _ = on.client.batch_execute(&format!("CLOSE {}", on.name)).await;
            }
        }
    }
}

/// The table's columns the Backup writes (all but generated ones), its key, and whether one of
/// them is an ALWAYS identity, which needs `OVERRIDING SYSTEM VALUE`.
async fn backup_columns(client: &Client, schema: &str, table: &str) -> Result<BackupColumns> {
    let rows = client
        .query(
            "SELECT a.attname::text, a.attgenerated::text, a.attidentity::text, \
             EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid = a.attrelid \
                     AND i.indisprimary AND a.attnum = ANY (i.indkey)) \
             FROM pg_catalog.pg_attribute a \
             JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum",
            &[&schema, &table],
        )
        .await
        .map_err(query_err)?;
    let mut out = BackupColumns::default();
    for r in rows {
        let name: String = r.get(0);
        if r.get::<_, bool>(3) {
            out.key.push(name.clone());
        }
        let generated: String = r.get(1);
        if !generated.is_empty() {
            continue;
        }
        let identity: String = r.get(2);
        out.overriding |= identity == "a";
        out.columns.push(name);
    }
    Ok(out)
}

/// A table's columns as the Backup reads them.
#[derive(Default)]
struct BackupColumns {
    /// All but generated ones.
    columns: Vec<String>,
    /// One of them is an ALWAYS identity.
    overriding: bool,
    /// The primary key's columns.
    key: Vec<String>,
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
