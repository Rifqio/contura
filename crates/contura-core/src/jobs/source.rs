//! Rows read from a server for an export: full values in chunks, never previews.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};

use crate::common::order_columns;
use crate::error::{Error, Result};
use crate::model::{Cell, ColumnInfo, DialectKind, KeyPart, ObjectPath, PageRequest, SortSpec};
use crate::query::Canceller;
use crate::query::ResultColumn;
use crate::safety::{StatementClass, classify, statement_count};

/// One full value, as the writers need it. Numbers keep their exact digits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Null,
    Number(String),
    Text(String),
    Bytes(Vec<u8>),
    Bool(bool),
}

impl Value {
    /// The bytes the value holds, for cutting chunks by size.
    pub fn size(&self) -> usize {
        match self {
            Value::Null => 0,
            Value::Bool(_) => 1,
            Value::Number(s) | Value::Text(s) => s.len(),
            Value::Bytes(b) => b.len(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ValueKind {
    Integer,
    Decimal,
    Float,
    Bool,
    Text,
    Json,
    Date,
    Time,
    Timestamp,
    TimestampTz,
    Binary,
    Other,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceColumn {
    pub name: String,
    pub type_name: String,
    pub kind: ValueKind,
}

/// Up to `CHUNK_ROWS` rows or about `CHUNK_BYTES`, with their byte size.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Chunk {
    pub rows: Vec<Vec<Value>>,
    pub bytes: usize,
}

pub const CHUNK_ROWS: usize = 1_000;
pub const CHUNK_BYTES: usize = 8 * 1024 * 1024;

/// Gathers rows into chunks. It cuts before a row would pass either limit, so a single
/// row over the byte limit (a 16 MB cell) makes a chunk of its own.
#[derive(Debug, Default)]
pub struct ChunkBuilder {
    current: Chunk,
}

impl ChunkBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds `row`; returns the chunk it closed, if any.
    pub fn push(&mut self, row: Vec<Value>) -> Option<Chunk> {
        let size: usize = row.iter().map(Value::size).sum();
        let full = !self.current.rows.is_empty()
            && (self.current.rows.len() >= CHUNK_ROWS || self.current.bytes + size > CHUNK_BYTES);
        let done = if full {
            Some(std::mem::take(&mut self.current))
        } else {
            None
        };
        self.current.rows.push(row);
        self.current.bytes += size;
        done
    }

    /// The rows still held, if any.
    pub fn finish(&mut self) -> Option<Chunk> {
        if self.current.rows.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.current))
        }
    }
}

/// What to read: a table (with an optional filter, sort and selected keys) or a Read query.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SourceRequest {
    Table {
        path: ObjectPath,
        #[serde(default)]
        columns: Vec<String>,
        #[serde(default)]
        filter: Option<String>,
        #[serde(default)]
        sort: Option<SortSpec>,
        #[serde(default)]
        keys: Vec<Vec<KeyPart>>,
    },
    Query {
        #[serde(default)]
        database: Option<String>,
        #[serde(default)]
        sql: String,
    },
}

/// A server read that streams chunk by chunk on one held connection.
#[async_trait::async_trait]
pub trait RowSource: Send {
    fn columns(&self) -> &[SourceColumn];
    /// The next chunk, or None at the end.
    async fn next_chunk(&mut self) -> Result<Option<Chunk>>;
    /// The server's row estimate for an unfiltered table (D8), else None.
    fn estimate(&self) -> Option<u64>;
    /// The SELECT it runs, for the history entry.
    fn sql(&self) -> &str;
    fn canceller(&self) -> Arc<dyn Canceller>;
}

/// How a table keeps its rows, for the export and import notes: a MyISAM table has no
/// snapshot and no rollback; a SQLite file outside WAL makes saves wait for a read.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableStorage {
    #[serde(default = "yes")]
    pub transactional: bool,
    /// The MySQL storage engine, such as `InnoDB` or `MyISAM`.
    #[serde(default)]
    pub engine: Option<String>,
    /// SQLite only: whether the file is in WAL mode.
    #[serde(default)]
    pub sqlite_wal: Option<bool>,
}

fn yes() -> bool {
    true
}

impl Default for TableStorage {
    fn default() -> Self {
        Self {
            transactional: true,
            engine: None,
            sqlite_wal: None,
        }
    }
}

/// The value family of a column type, as its Dialect writes it (`numeric(12,2)`,
/// `timestamp with time zone`, `int8`, `bigint unsigned`, `DATETIME`). Unknown is Other.
pub fn value_kind(kind: DialectKind, type_name: &str) -> ValueKind {
    let lower = type_name.trim().to_ascii_lowercase();
    // PostgreSQL arrays are text in their own syntax.
    if kind == DialectKind::Postgres && (lower.ends_with(']') || lower.starts_with('_')) {
        return ValueKind::Other;
    }
    // `timestamp(6) with time zone`: the precision sits before the zone words.
    if lower.ends_with("with time zone") {
        if lower.starts_with("timestamp") {
            return ValueKind::TimestampTz;
        }
        if lower.starts_with("time") {
            return ValueKind::Time;
        }
    }
    if lower.ends_with("without time zone") {
        if lower.starts_with("timestamp") {
            return ValueKind::Timestamp;
        }
        if lower.starts_with("time") {
            return ValueKind::Time;
        }
    }
    let base = lower.split('(').next().unwrap_or_default().trim();
    let base = base
        .split_whitespace()
        .filter(|w| *w != "unsigned" && *w != "signed" && *w != "zerofill")
        .collect::<Vec<_>>()
        .join(" ");
    let named = match base.as_str() {
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "int2" | "int4"
        | "int8" | "smallserial" | "serial" | "bigserial" | "serial2" | "serial4" | "serial8"
        | "oid" | "year" => Some(ValueKind::Integer),
        // MySQL BIT is read as `col + 0`; PostgreSQL bit strings are text like `00000101`.
        "bit" if kind == DialectKind::MySql => Some(ValueKind::Integer),
        "bit" | "bit varying" | "varbit" => Some(ValueKind::Text),
        "decimal" | "numeric" | "dec" | "fixed" => Some(ValueKind::Decimal),
        "float" | "double" | "double precision" | "real" | "float4" | "float8" => {
            Some(ValueKind::Float)
        }
        // MySQL's BOOLEAN is TINYINT(1), and SQLite's holds integers.
        "boolean" | "bool" if kind == DialectKind::Postgres => Some(ValueKind::Bool),
        "boolean" | "bool" => Some(ValueKind::Integer),
        "json" | "jsonb" => Some(ValueKind::Json),
        "date" => Some(ValueKind::Date),
        "time" | "timetz" => Some(ValueKind::Time),
        "datetime" | "timestamp" => Some(ValueKind::Timestamp),
        "timestamptz" => Some(ValueKind::TimestampTz),
        "bytea" | "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" => {
            Some(ValueKind::Binary)
        }
        "char" | "character" | "varchar" | "character varying" | "bpchar" | "text" | "tinytext"
        | "mediumtext" | "longtext" | "name" | "citext" | "uuid" | "enum" | "set" | "nchar"
        | "nvarchar" | "clob" => Some(ValueKind::Text),
        _ => None,
    };
    if let Some(k) = named {
        return k;
    }
    if kind == DialectKind::Sqlite {
        // SQLite's type affinity rules, in its order.
        if base.contains("int") {
            return ValueKind::Integer;
        }
        if base.contains("char") || base.contains("clob") || base.contains("text") {
            return ValueKind::Text;
        }
        if base.contains("blob") {
            return ValueKind::Binary;
        }
        if base.contains("real") || base.contains("floa") || base.contains("doub") {
            return ValueKind::Float;
        }
    }
    ValueKind::Other
}

pub(crate) const REFUSE_WRITE: &str = "Only a statement that reads can be exported this way.";

/// The text of a Query source, checked: one statement the classifier calls Read.
pub(crate) fn checked_query(kind: DialectKind, sql: &str) -> Result<String> {
    let sql = sql.trim().trim_end_matches(';').trim_end();
    // Text with only comments holds no statement.
    if sql.is_empty() || statement_count(kind, sql) == 0 {
        return Err(Error::InvalidInput("Write a query to export.".into()));
    }
    if classify(kind, sql) != StatementClass::Read {
        return Err(Error::InvalidInput(REFUSE_WRITE.into()));
    }
    if statement_count(kind, sql) != 1 {
        return Err(Error::InvalidInput(
            "Export one statement at a time.".into(),
        ));
    }
    Ok(sql.to_string())
}

/// A filter runs inside the export's SELECT, so the whole text must stay one statement.
pub(crate) fn check_one_statement(kind: DialectKind, sql: &str) -> Result<()> {
    if statement_count(kind, sql) != 1 {
        return Err(Error::InvalidInput(
            "A filter cannot hold a second statement.".into(),
        ));
    }
    Ok(())
}

/// The parts of a Table source.
pub(crate) struct TableParts<'r> {
    pub path: &'r ObjectPath,
    pub columns: &'r [String],
    pub filter: &'r Option<String>,
    pub sort: &'r Option<SortSpec>,
    pub keys: &'r [Vec<KeyPart>],
}

/// The read a Table source runs, worked out from the table's columns.
pub(crate) struct TableRead {
    /// Indexes of the selected columns, in the order asked for (all, when none were named).
    pub selected: Vec<usize>,
    /// ` WHERE ...` from the filter (through `PageRequest::where_sql`) and the keys.
    pub where_sql: String,
    /// Sort column then primary key, as `order_columns` gives them.
    pub order_by: Vec<(String, bool)>,
    /// No filter and no keys: the table's statistics estimate its rows.
    pub plain: bool,
    pub has_filter: bool,
}

impl SourceRequest {
    pub(crate) fn table_parts(&self) -> Option<TableParts<'_>> {
        match self {
            SourceRequest::Table {
                path,
                columns,
                filter,
                sort,
                keys,
            } => Some(TableParts {
                path,
                columns,
                filter,
                sort,
                keys,
            }),
            SourceRequest::Query { .. } => None,
        }
    }
}

impl TableParts<'_> {
    /// Picks the columns and writes the WHERE and ORDER BY parts.
    pub(crate) fn read(&self, kind: DialectKind, infos: &[ColumnInfo]) -> Result<TableRead> {
        let selected = if self.columns.is_empty() {
            (0..infos.len()).collect()
        } else {
            self.columns
                .iter()
                .map(|name| {
                    infos
                        .iter()
                        .position(|c| &c.name == name)
                        .ok_or_else(|| Error::InvalidInput(format!("unknown column {name}")))
                })
                .collect::<Result<Vec<_>>>()?
        };
        let page = PageRequest {
            table: self.path.clone(),
            page: 0,
            sort: None,
            filter: self.filter.clone(),
        };
        let mut where_sql = page.where_sql();
        let has_filter = !where_sql.is_empty();
        if !self.keys.is_empty() {
            let clause = crate::edits::key_in_clause(kind, infos, self.keys)?;
            if has_filter {
                where_sql.push_str(&format!(" AND {clause}"));
            } else {
                where_sql = format!(" WHERE {clause}");
            }
        }
        Ok(TableRead {
            selected,
            where_sql,
            order_by: order_columns(infos, self.sort.as_ref())?,
            plain: !has_filter && self.keys.is_empty(),
            has_filter,
        })
    }
}

/// What a producer learned before its first row.
pub(crate) struct Opened {
    pub columns: Vec<SourceColumn>,
    pub estimate: Option<u64>,
    pub sql: String,
    /// Stops the server's running statement (KILL QUERY, a cancel request, an interrupt).
    pub server: Arc<dyn Canceller>,
}

/// Sets the source's flag, then stops whatever the server is running for it.
struct StopRead {
    flag: Arc<AtomicBool>,
    server: Arc<dyn Canceller>,
}

#[async_trait::async_trait]
impl Canceller for StopRead {
    async fn cancel(&self) -> Result<()> {
        self.flag.store(true, Ordering::SeqCst);
        // The read may have ended already; then there is nothing left to stop.
        let _ = self.server.cancel().await;
        Ok(())
    }
}

/// The producer's end: rows go in, chunks go out through the channel of 2.
pub(crate) struct Feed {
    /// `Ok(None)` is the end mark: a channel that closes without it failed.
    tx: mpsc::Sender<Result<Option<Chunk>>>,
    builder: ChunkBuilder,
    flag: Arc<AtomicBool>,
}

impl Feed {
    /// False when the read should stop: cancelled, or the source was dropped.
    pub(crate) async fn push(&mut self, row: Vec<Value>) -> bool {
        if self.flag.load(Ordering::SeqCst) {
            return false;
        }
        match self.builder.push(row) {
            Some(chunk) => self.tx.send(Ok(Some(chunk))).await.is_ok(),
            None => true,
        }
    }

    pub(crate) fn push_blocking(&mut self, row: Vec<Value>) -> bool {
        if self.flag.load(Ordering::SeqCst) {
            return false;
        }
        match self.builder.push(row) {
            Some(chunk) => self.tx.blocking_send(Ok(Some(chunk))).is_ok(),
            None => true,
        }
    }

    /// The rows still held, then the end mark. Only a finished feed ends the read cleanly.
    pub(crate) async fn finish(mut self) {
        if let Some(chunk) = self.builder.finish()
            && self.tx.send(Ok(Some(chunk))).await.is_err()
        {
            return;
        }
        let _ = self.tx.send(Ok(None)).await;
    }

    pub(crate) fn finish_blocking(mut self) {
        if let Some(chunk) = self.builder.finish()
            && self.tx.blocking_send(Ok(Some(chunk))).is_err()
        {
            return;
        }
        let _ = self.tx.blocking_send(Ok(None));
    }

    pub(crate) async fn fail(self, e: Error) {
        let _ = self.tx.send(Err(e)).await;
    }

    pub(crate) fn fail_blocking(self, e: Error) {
        let _ = self.tx.blocking_send(Err(e));
    }
}

/// The producer's two ends: `ready` once, before the first row; then the feed.
pub(crate) struct Producer {
    pub ready: oneshot::Sender<Result<Opened>>,
    pub feed: Feed,
}

/// Starts a read: `spawn` gets the producer's ends and runs it on a task or a thread of
/// its own. Returns once the producer has sent `ready`.
pub(crate) async fn start_source(spawn: impl FnOnce(Producer)) -> Result<Box<dyn RowSource>> {
    let (producer, pending) = source_channel();
    spawn(producer);
    pending.open().await
}

/// The consumer's end of a read before the producer has sent `ready`.
pub(crate) struct PendingSource {
    opened: oneshot::Receiver<Result<Opened>>,
    rx: mpsc::Receiver<Result<Option<Chunk>>>,
    flag: Arc<AtomicBool>,
}

impl PendingSource {
    /// Waits for the producer's `ready` and hands back the source.
    pub(crate) async fn open(self) -> Result<Box<dyn RowSource>> {
        let PendingSource { opened, rx, flag } = self;
        let opened = opened
            .await
            .map_err(|_| Error::Query("the read stopped before it started".into()))??;
        Ok(Box::new(ChannelSource {
            columns: opened.columns,
            rx,
            ended: false,
            gone: false,
            estimate: opened.estimate,
            sql: opened.sql,
            canceller: Arc::new(StopRead {
                flag: flag.clone(),
                server: opened.server,
            }),
            flag,
        }))
    }
}

/// The two ends of one read, for a producer that already runs on a connection it holds
/// (a Backup reads every table on the one connection of its snapshot).
pub(crate) fn source_channel() -> (Producer, PendingSource) {
    let (tx, rx) = mpsc::channel(2);
    let (ready, opened) = oneshot::channel();
    let flag = Arc::new(AtomicBool::new(false));
    let producer = Producer {
        ready,
        feed: Feed {
            tx,
            builder: ChunkBuilder::new(),
            flag: flag.clone(),
        },
    };
    (producer, PendingSource { opened, rx, flag })
}

/// The consumer's end. Dropping it closes the channel; the producer then stops and
/// closes its connection.
struct ChannelSource {
    columns: Vec<SourceColumn>,
    rx: mpsc::Receiver<Result<Option<Chunk>>>,
    /// The producer sent its end mark.
    ended: bool,
    /// The producer is gone: it failed, or its channel closed.
    gone: bool,
    estimate: Option<u64>,
    sql: String,
    canceller: Arc<dyn Canceller>,
    flag: Arc<AtomicBool>,
}

/// A source dropped before its end (a preview that has its rows, a job whose writer
/// failed) stops its server read at once, so the snapshot and its locks go now rather
/// than when the producer next fills a chunk.
impl Drop for ChannelSource {
    fn drop(&mut self) {
        if self.ended || self.gone {
            return;
        }
        self.flag.store(true, Ordering::SeqCst);
        self.rx.close();
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            let canceller = self.canceller.clone();
            rt.spawn(async move {
                let _ = canceller.cancel().await;
            });
        }
    }
}

#[async_trait::async_trait]
impl RowSource for ChannelSource {
    fn columns(&self) -> &[SourceColumn] {
        &self.columns
    }

    async fn next_chunk(&mut self) -> Result<Option<Chunk>> {
        if self.flag.load(Ordering::SeqCst) {
            self.rx.close();
            return Err(Error::Cancelled);
        }
        if self.ended {
            return Ok(None);
        }
        let got = self.rx.recv().await;
        if matches!(got, None | Some(Err(_))) {
            self.gone = true;
        }
        match got {
            // A producer that panicked, or whose task the runtime dropped, sent no end
            // mark: the read fails rather than ending short.
            None if self.flag.load(Ordering::SeqCst) => Err(Error::Cancelled),
            None => Err(Error::ReadStopped),
            Some(Ok(None)) => {
                self.ended = true;
                Ok(None)
            }
            Some(Ok(Some(chunk))) => Ok(Some(chunk)),
            Some(Err(_)) if self.flag.load(Ordering::SeqCst) => Err(Error::Cancelled),
            Some(Err(e)) => Err(e),
        }
    }

    fn estimate(&self) -> Option<u64> {
        self.estimate
    }

    fn sql(&self) -> &str {
        &self.sql
    }

    fn canceller(&self) -> Arc<dyn Canceller> {
        self.canceller.clone()
    }
}

/// Nothing runs on a server for the rows a result already holds.
struct NoRead;

#[async_trait::async_trait]
impl Canceller for NoRead {
    async fn cancel(&self) -> Result<()> {
        Ok(())
    }
}

/// The rows a result already shows, as they are (D16): no server read. A value the
/// grid holds as a 1 KB preview stays cut; `cut_values` counts them.
pub struct RowsSource {
    columns: Vec<SourceColumn>,
    rows: std::vec::IntoIter<Vec<Value>>,
    pending: Option<Vec<Value>>,
    total: u64,
    cut: u64,
    sql: String,
}

fn unhex(text: &str) -> Result<Vec<u8>> {
    let bad = || Error::InvalidInput("A binary value in the rows is not hex.".into());
    if !text.len().is_multiple_of(2) {
        return Err(bad());
    }
    (0..text.len())
        .step_by(2)
        .map(|i| {
            text.get(i..i + 2)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
                .ok_or_else(bad)
        })
        .collect()
}

impl RowsSource {
    pub fn new(kind: DialectKind, columns: &[ResultColumn], rows: Vec<Vec<Cell>>) -> Result<Self> {
        let mut cut = 0u64;
        let mut values = Vec::with_capacity(rows.len());
        for row in rows {
            if row.len() != columns.len() {
                return Err(Error::InvalidInput(format!(
                    "A row has {} values; the result has {} columns.",
                    row.len(),
                    columns.len()
                )));
            }
            let mut out = Vec::with_capacity(row.len());
            for cell in row {
                out.push(match cell {
                    Cell::Null => Value::Null,
                    Cell::Number { value } => Value::Number(value),
                    Cell::Text {
                        value, truncated, ..
                    } => {
                        cut += u64::from(truncated);
                        Value::Text(value)
                    }
                    Cell::Bytes {
                        preview_hex,
                        truncated,
                        ..
                    } => {
                        cut += u64::from(truncated);
                        Value::Bytes(unhex(&preview_hex)?)
                    }
                });
            }
            values.push(out);
        }
        let total = values.len() as u64;
        Ok(Self {
            columns: columns
                .iter()
                .map(|c| SourceColumn {
                    name: c.name.clone(),
                    type_name: c.type_name.clone(),
                    kind: value_kind(kind, &c.type_name),
                })
                .collect(),
            rows: values.into_iter(),
            pending: None,
            total,
            cut,
            sql: format!("-- The {total} rows shown in a result"),
        })
    }

    /// Values held as 1 KB previews, written as they are.
    pub fn cut_values(&self) -> u64 {
        self.cut
    }
}

#[async_trait::async_trait]
impl RowSource for RowsSource {
    fn columns(&self) -> &[SourceColumn] {
        &self.columns
    }

    async fn next_chunk(&mut self) -> Result<Option<Chunk>> {
        let mut builder = ChunkBuilder::new();
        if let Some(row) = self.pending.take() {
            builder.push(row);
        }
        for row in self.rows.by_ref() {
            if let Some(chunk) = builder.push(row) {
                // The row that closed the chunk starts the next one.
                self.pending = builder.finish().and_then(|c| c.rows.into_iter().next());
                return Ok(Some(chunk));
            }
        }
        Ok(builder.finish())
    }

    fn estimate(&self) -> Option<u64> {
        Some(self.total)
    }

    fn sql(&self) -> &str {
        &self.sql
    }

    fn canceller(&self) -> Arc<dyn Canceller> {
        Arc::new(NoRead)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoServer;

    #[async_trait::async_trait]
    impl Canceller for NoServer {
        async fn cancel(&self) -> Result<()> {
            Ok(())
        }
    }

    fn opened() -> Opened {
        Opened {
            columns: Vec::new(),
            estimate: None,
            sql: "SELECT n".into(),
            server: Arc::new(NoServer),
        }
    }

    fn unexpected(e: Error) -> bool {
        matches!(e, Error::ReadStopped)
    }

    #[tokio::test]
    async fn a_producer_that_panics_fails_the_read() {
        let mut src = start_source(|p| {
            tokio::spawn(async move {
                let Producer { ready, mut feed } = p;
                let _ = ready.send(Ok(opened()));
                for i in 0..1500 {
                    feed.push(vec![Value::Number(i.to_string())]).await;
                }
                panic!("the producer died");
            });
        })
        .await
        .expect("open");
        let first = src.next_chunk().await.expect("chunk").expect("rows");
        assert_eq!(first.rows.len(), CHUNK_ROWS);
        // The other 500 rows are lost: the read fails rather than ending short.
        assert!(unexpected(src.next_chunk().await.unwrap_err()));
        assert!(unexpected(src.next_chunk().await.unwrap_err()));
    }

    #[tokio::test]
    async fn a_thread_that_drops_its_feed_fails_the_read() {
        let mut src = start_source(|p| {
            std::thread::spawn(move || {
                let Producer { ready, mut feed } = p;
                let _ = ready.send(Ok(opened()));
                feed.push_blocking(vec![Value::Null]);
                drop(feed);
            });
        })
        .await
        .expect("open");
        assert!(unexpected(src.next_chunk().await.unwrap_err()));
    }

    #[tokio::test]
    async fn a_clean_finish_ends_the_read() {
        let mut src = start_source(|p| {
            tokio::spawn(async move {
                let Producer { ready, mut feed } = p;
                let _ = ready.send(Ok(opened()));
                feed.push(vec![Value::Null]).await;
                feed.finish().await;
            });
        })
        .await
        .expect("open");
        assert_eq!(src.next_chunk().await.unwrap().unwrap().rows.len(), 1);
        assert!(src.next_chunk().await.unwrap().is_none());
        assert!(src.next_chunk().await.unwrap().is_none());
    }

    fn small() -> Vec<Value> {
        vec![Value::Number("1".into()), Value::Null]
    }

    #[test]
    fn value_kind_per_dialect() {
        use DialectKind::{MySql, Postgres, Sqlite};
        use ValueKind::*;
        let cases = [
            (MySql, "int", Integer),
            (MySql, "bigint unsigned", Integer),
            (MySql, "tinyint(1)", Integer),
            (MySql, "bit(8)", Integer),
            (Postgres, "bit(8)", Text),
            (Postgres, "bit varying(8)", Text),
            (MySql, "decimal(20,6)", Decimal),
            (MySql, "double", Float),
            (MySql, "float", Float),
            (MySql, "longtext", Text),
            (MySql, "varbinary(16)", Binary),
            (MySql, "json", Json),
            (MySql, "date", Date),
            (MySql, "time", Time),
            (MySql, "datetime(6)", Timestamp),
            (MySql, "timestamp(6)", Timestamp),
            (MySql, "enum('happy','sad')", Text),
            (MySql, "char(36)", Text),
            (MySql, "point", Other),
            (Postgres, "bigint", Integer),
            (Postgres, "int8", Integer),
            (Postgres, "numeric(20,6)", Decimal),
            (Postgres, "numeric", Decimal),
            (Postgres, "double precision", Float),
            (Postgres, "real", Float),
            (Postgres, "boolean", Bool),
            (Postgres, "bool", Bool),
            (Postgres, "character varying(20)", Text),
            (Postgres, "bytea", Binary),
            (Postgres, "jsonb", Json),
            (Postgres, "time without time zone", Time),
            (Postgres, "time(3) with time zone", Time),
            (Postgres, "timestamp(6) without time zone", Timestamp),
            (Postgres, "timestamp with time zone", TimestampTz),
            (Postgres, "timestamp(6) with time zone", TimestampTz),
            (Postgres, "timestamptz", TimestampTz),
            (Postgres, "uuid", Text),
            (Postgres, "integer[]", Other),
            (Postgres, "_int4", Other),
            (Postgres, "every_mood", Other),
            (Sqlite, "INTEGER", Integer),
            (Sqlite, "BOOLEAN", Integer),
            (Sqlite, "DECIMAL(20,6)", Decimal),
            (Sqlite, "REAL", Float),
            (Sqlite, "TEXT", Text),
            (Sqlite, "BLOB", Binary),
            (Sqlite, "JSON", Json),
            (Sqlite, "DATETIME", Timestamp),
            (Sqlite, "UNSIGNED BIG INT", Integer),
            (Sqlite, "NVARCHAR(10)", Text),
            (Sqlite, "", Other),
        ];
        for (kind, name, want) in cases {
            assert_eq!(value_kind(kind, name), want, "{kind:?} {name}");
        }
    }

    #[test]
    fn checked_query_takes_one_read() {
        let k = DialectKind::Postgres;
        assert_eq!(checked_query(k, " SELECT 1; ").unwrap(), "SELECT 1");
        for write in [
            "INSERT INTO t (id) VALUES (0) RETURNING id",
            "UPDATE t SET a = 1",
            "SELECT 1; DELETE FROM t",
        ] {
            assert!(
                matches!(checked_query(k, write), Err(Error::InvalidInput(m)) if m == REFUSE_WRITE),
                "{write}"
            );
        }
        assert!(matches!(
            checked_query(k, "SELECT 1; SELECT 2"),
            Err(Error::InvalidInput(_))
        ));
        for empty in ["  ", "-- a note", "/* only a comment */ ;"] {
            assert!(
                matches!(checked_query(k, empty), Err(Error::InvalidInput(m)) if m == "Write a query to export."),
                "{empty}"
            );
        }
    }

    #[test]
    fn chunk_builder_cuts_by_rows_and_bytes() {
        // By rows: 1,000 rows fill a chunk; the next row closes it.
        let mut b = ChunkBuilder::new();
        for _ in 0..CHUNK_ROWS {
            assert!(b.push(small()).is_none());
        }
        let c = b.push(small()).expect("the 1,001st row closes the chunk");
        assert_eq!(c.rows.len(), CHUNK_ROWS);
        assert_eq!(c.bytes, CHUNK_ROWS);
        assert_eq!(b.finish().unwrap().rows.len(), 1);
        assert!(b.finish().is_none());

        // By bytes: eight 1 MB rows make exactly 8 MB; the ninth would pass the limit.
        let mb = || vec![Value::Text("x".repeat(1024 * 1024))];
        let mut b = ChunkBuilder::new();
        for _ in 0..8 {
            assert!(b.push(mb()).is_none());
        }
        let c = b.push(mb()).expect("the ninth 1 MB row closes the chunk");
        assert_eq!(c.rows.len(), 8);
        assert_eq!(c.bytes, CHUNK_BYTES);

        // One 16 MB row makes a chunk of its own.
        let mut b = ChunkBuilder::new();
        assert!(b.push(small()).is_none());
        let big = vec![Value::Bytes(vec![0; 16 * 1024 * 1024])];
        let c = b.push(big).expect("the big row closes the small chunk");
        assert_eq!(c.rows.len(), 1);
        let c = b.push(small()).expect("the next row closes the big one");
        assert_eq!(c.rows.len(), 1);
        assert_eq!(c.bytes, 16 * 1024 * 1024);
        assert_eq!(b.finish().unwrap().rows, vec![small()]);
    }
}
