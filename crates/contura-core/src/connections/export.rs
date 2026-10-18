//! The export service (Task 7): `preview_export` and `start_export`. An export only
//! reads, so it needs no pass on any Connection, Read-only included; it never runs a
//! statement the 5a classifier does not call a read (Q26).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use super::{ConnectionService, now_ms, plain_message};
use crate::common::sql_ident;
use crate::dialect::Dialect;
use crate::error::{Error, Result};
use crate::jobs::formats::FormatWriter;
use crate::jobs::formats::csv::CsvWriter;
use crate::jobs::formats::json::JsonWriter;
use crate::jobs::formats::sql::{SqlWriter, export_table_sql};
use crate::jobs::formats::xlsx::{RESULT_SHEET, XlsxCell, XlsxWriter, sheet_kind, xlsx_cell};
use crate::jobs::insert::{InsertBuilder, InsertLimits, conversion_for, literal_as_stored};
use crate::jobs::paths::{PartialFile, PartialWriter, PathUse};
use crate::jobs::pipeline::export_pipeline_counted;
use crate::jobs::source::{
    Chunk, REFUSE_WRITE, RowSource, RowsSource, SourceColumn, SourceRequest, TableStorage, Value,
    checked_query,
};
use crate::jobs::types::{
    ExportOptions, ExportPreview, ExportRequest, ExportSource, Format, JobId, JobKind, JobReport,
};
use crate::jobs::{JobCtx, JobSink};
use crate::model::{ConnectionId, DialectKind, ObjectPath};
use crate::query::{NewHistory, Outcome};
use crate::safety::{StatementClass, classify, statement_count};

/// The preview is written from this many rows.
const PREVIEW_ROWS: usize = 20;
/// A text preview shows this many lines.
const PREVIEW_LINES: usize = 6;
/// `InsertLimits`' byte cut: a statement ends before it would pass 1 MiB.
const STATEMENT_BYTES: usize = 1024 * 1024;

const RERUN_NOTE: &str = "Runs the query again on its own connection.";
const UTC_NOTE: &str = "timestamptz values are written in UTC";
const JOURNAL_NOTE: &str = "Saves to this file wait until the export ends.";

/// What an export reads, checked before anything opens. A read keeps only the named
/// output columns, when there are any.
enum Planned {
    Read(SourceRequest, Vec<String>),
    Rows(RowsSource),
}

/// A source that passes on only some of another source's columns, in a chosen order.
struct KeepColumns {
    inner: Box<dyn RowSource>,
    keep: Vec<usize>,
    columns: Vec<SourceColumn>,
}

/// `source` with only the `wanted` output columns, in that order; empty keeps them all.
/// A repeated name takes the next column of that name, so `id, id` from a join keeps both.
fn keep_columns(source: Box<dyn RowSource>, wanted: &[String]) -> Result<Box<dyn RowSource>> {
    if wanted.is_empty() {
        return Ok(source);
    }
    let all = source.columns();
    let mut used = vec![false; all.len()];
    let mut keep = Vec::with_capacity(wanted.len());
    for name in wanted {
        let found = (0..all.len()).find(|&i| !used[i] && all[i].name == *name);
        let Some(i) = found else {
            return Err(Error::InvalidInput(format!(
                "The result has no column {name}."
            )));
        };
        used[i] = true;
        keep.push(i);
    }
    let columns = keep.iter().map(|&i| all[i].clone()).collect();
    Ok(Box::new(KeepColumns {
        inner: source,
        keep,
        columns,
    }))
}

#[async_trait::async_trait]
impl RowSource for KeepColumns {
    fn columns(&self) -> &[SourceColumn] {
        &self.columns
    }

    async fn next_chunk(&mut self) -> Result<Option<Chunk>> {
        let Some(chunk) = self.inner.next_chunk().await? else {
            return Ok(None);
        };
        let mut bytes = 0;
        let rows = chunk
            .rows
            .into_iter()
            .map(|mut row| {
                let out: Vec<Value> = self
                    .keep
                    .iter()
                    .map(|&i| std::mem::replace(&mut row[i], Value::Null))
                    .collect();
                bytes += out.iter().map(Value::size).sum::<usize>();
                out
            })
            .collect();
        Ok(Some(Chunk { rows, bytes }))
    }

    fn estimate(&self) -> Option<u64> {
        self.inner.estimate()
    }

    fn sql(&self) -> &str {
        self.inner.sql()
    }

    fn canceller(&self) -> Arc<dyn crate::query::Canceller> {
        self.inner.canceller()
    }
}

/// The table a SQL export names and the sheet an Excel export fills: the table's own
/// name, or "result" for a query result.
struct Naming {
    table_sql: String,
    sheet: String,
    label: String,
    /// The history text when the read never opened.
    fallback_sql: String,
}

fn naming(kind: DialectKind, req: &ExportRequest) -> Naming {
    match &req.source {
        ExportSource::Table { path, .. } => Naming {
            table_sql: export_table_sql(kind, path, req.options.table_name),
            sheet: path.name.clone(),
            label: format!("Exporting {}", path.name),
            fallback_sql: format!("-- Export of {}", path.name),
        },
        ExportSource::Query { sql, .. } => Naming {
            table_sql: sql_ident(kind, RESULT_SHEET),
            sheet: RESULT_SHEET.into(),
            label: "Exporting the query result".into(),
            fallback_sql: sql.trim().to_string(),
        },
        ExportSource::Rows { rows, .. } => Naming {
            table_sql: sql_ident(kind, RESULT_SHEET),
            sheet: RESULT_SHEET.into(),
            label: "Exporting the rows shown".into(),
            fallback_sql: format!("-- The {} rows shown in a result", rows.len()),
        },
    }
}

/// The 5a classifier's word on a Query source's text, before anything runs (Q26).
fn is_read(kind: DialectKind, sql: &str) -> bool {
    let sql = sql.trim().trim_end_matches(';').trim_end();
    !sql.is_empty() && statement_count(kind, sql) > 0 && classify(kind, sql) == StatementClass::Read
}

/// Checks the source and turns it into what opens: a Query must be one read statement.
fn plan(kind: DialectKind, source: ExportSource) -> Result<Planned> {
    Ok(match source {
        ExportSource::Table {
            path,
            columns,
            filter,
            sort,
            keys,
        } => Planned::Read(
            SourceRequest::Table {
                path,
                columns,
                filter,
                sort,
                keys,
            },
            Vec::new(),
        ),
        ExportSource::Query {
            database,
            sql,
            columns,
        } => {
            if !sql.trim().is_empty() && !is_read(kind, &sql) {
                return Err(Error::InvalidInput(REFUSE_WRITE.into()));
            }
            let sql = checked_query(kind, &sql)?;
            Planned::Read(SourceRequest::Query { database, sql }, columns)
        }
        ExportSource::Rows { columns, rows } => {
            Planned::Rows(RowsSource::new(kind, &columns, rows)?)
        }
    })
}

async fn open(d: &dyn Dialect, planned: Planned) -> Result<Box<dyn RowSource>> {
    match planned {
        Planned::Read(req, keep) => keep_columns(d.open_row_source(&req).await?, &keep),
        Planned::Rows(rows) => Ok(Box::new(rows)),
    }
}

fn cut_warning(n: u64) -> Option<String> {
    match n {
        0 => None,
        1 => Some("1 value was cut to a 1 KB preview.".into()),
        n => Some(format!("{n} values were cut to 1 KB previews.")),
    }
}

fn job_writer(
    kind: DialectKind,
    req: &ExportRequest,
    naming: &Naming,
    out: PartialWriter,
) -> Result<Box<dyn FormatWriter>> {
    let opts = &req.options;
    Ok(match req.format {
        Format::Csv => Box::new(CsvWriter::new(out, opts)),
        Format::Json => Box::new(JsonWriter::new(out, opts)),
        Format::Sql => Box::new(SqlWriter::new(out, kind, naming.table_sql.clone(), opts)),
        Format::Xlsx => Box::new(XlsxWriter::new(out, &naming.sheet, opts)?),
    })
}

/// The first `n` physical lines, without line ends or a BOM: what the dialog shows.
fn first_lines(text: &str, n: usize) -> Vec<String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    // The line feed that ends the last line starts no line of its own.
    text.strip_suffix('\n')
        .unwrap_or(text)
        .split('\n')
        .filter(|_| !text.is_empty())
        .take(n)
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .collect()
}

/// The MyISAM and SQLite journal notes from a table's storage.
fn storage_notes(name: &str, found: Result<TableStorage>) -> Vec<String> {
    let mut notes = Vec::new();
    let Ok(storage) = found else {
        // Said rather than dropped: a MyISAM table would otherwise lose its note.
        notes.push("Could not check the table's storage engine.".into());
        return notes;
    };
    if !storage.transactional {
        notes.push(format!(
            "{name} uses {}: rows changed while the export runs may be in the file.",
            storage.engine.as_deref().unwrap_or("MyISAM")
        ));
    }
    if storage.sqlite_wal == Some(false) {
        notes.push(JOURNAL_NOTE.into());
    }
    notes
}

/// How a cell shows in the sheet preview, as Excel shows it.
fn cell_text(cell: XlsxCell) -> String {
    match cell {
        XlsxCell::Text(s) => s,
        XlsxCell::Number(n) if n.fract() == 0.0 && n.abs() < 1e15 => format!("{}", n as i64),
        XlsxCell::Number(n) => n.to_string(),
        XlsxCell::Bool(b) => (if b { "TRUE" } else { "FALSE" }).into(),
        XlsxCell::Blank => String::new(),
    }
}

/// Bytes a row adds to a SQL export, counting the INSERT head once per statement as the
/// file has them: `rows_per_statement` rows to a statement, fewer when the 1 MiB cut
/// comes first. `row_lens` are the sample rows' VALUES texts.
pub(crate) fn sql_bytes_per_row(head: usize, row_lens: &[usize], rows_per_statement: u32) -> u64 {
    if row_lens.is_empty() {
        return 0;
    }
    let n = row_lens.len();
    // ",\n" joins a row to the one before it.
    let avg = (row_lens.iter().map(|l| l + 2).sum::<usize>()).div_ceil(n);
    let room = STATEMENT_BYTES.saturating_sub(head + 1);
    let per_statement = (room / avg.max(1)).clamp(1, (rows_per_statement as usize).max(1)) as u64;
    // The head, its line feed and the closing ";\n".
    let overhead = (head + 3) as u64;
    avg as u64 + overhead.div_ceil(per_statement)
}

/// What the text writers write for `rows`: the bytes, and how many came before the rows.
fn write_text(
    kind: DialectKind,
    req: &ExportRequest,
    naming: &Naming,
    columns: &[SourceColumn],
    chunk: &Chunk,
) -> Result<(Vec<u8>, usize)> {
    let opts = &req.options;
    let done = match req.format {
        Format::Csv => {
            let mut w = CsvWriter::new(Vec::new(), opts);
            w.write_header(columns)?;
            let head = w.bytes() as usize;
            w.write_rows(chunk)?;
            (w.end()?, head)
        }
        Format::Json => {
            let mut w = JsonWriter::new(Vec::new(), opts);
            w.write_header(columns)?;
            let head = w.bytes() as usize;
            w.write_rows(chunk)?;
            (w.end()?, head)
        }
        Format::Sql => {
            let mut w = SqlWriter::new(Vec::new(), kind, naming.table_sql.clone(), opts);
            w.write_header(columns)?;
            let head = w.bytes() as usize;
            w.write_rows(chunk)?;
            (w.end()?, head)
        }
        Format::Xlsx => unreachable!("a workbook previews as a sheet"),
    };
    Ok(done)
}

/// The SQL estimate per row (see `sql_bytes_per_row`), from the sample's literals.
fn sql_row_bytes(
    kind: DialectKind,
    naming: &Naming,
    opts: &ExportOptions,
    columns: &[SourceColumn],
    rows: &[Vec<Value>],
) -> u64 {
    let names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();
    let conversions: Vec<_> = columns
        .iter()
        .map(|c| conversion_for(kind, &c.type_name))
        .collect();
    let builder = InsertBuilder::new(
        kind,
        naming.table_sql.clone(),
        &names,
        conversions.clone(),
        InsertLimits::default(),
        false,
    );
    let lens: Vec<usize> = rows
        .iter()
        .map(|row| {
            // "(" and ")", and ", " between values.
            2 + row
                .iter()
                .zip(&conversions)
                .map(|(v, c)| literal_as_stored(kind, *c, v).len())
                .sum::<usize>()
                + 2 * row.len().saturating_sub(1)
        })
        .collect();
    sql_bytes_per_row(builder.head().len(), &lens, opts.rows_per_statement)
}

impl ConnectionService {
    /// The notes the dialog shows over the preview. The Production banner is the
    /// dialog's own and is never repeated here (Q20).
    async fn export_notes(
        &self,
        d: &dyn Dialect,
        kind: DialectKind,
        req: &ExportRequest,
    ) -> Vec<String> {
        let mut notes = Vec::new();
        let storage_of = match &req.source {
            ExportSource::Table { path, .. } => Some(path.clone()),
            ExportSource::Query { database, .. } if kind == DialectKind::Sqlite => {
                Some(ObjectPath {
                    database: database.clone().unwrap_or_else(|| "main".into()),
                    schema: None,
                    name: String::new(),
                })
            }
            _ => None,
        };
        if let Some(path) = storage_of {
            notes.extend(storage_notes(&path.name, d.table_storage(&path).await));
        }
        // The grid's sessions run in UTC too, so "Rows shown" gets the note as well.
        if kind == DialectKind::Postgres && matches!(req.format, Format::Csv | Format::Json) {
            notes.push(UTC_NOTE.into());
        }
        if matches!(req.source, ExportSource::Query { .. }) {
            notes.push(RERUN_NOTE.into());
        }
        notes
    }

    /// The first lines (or, for Excel, the first rows of the sheet) exactly as the export
    /// writes them, from its first 20 rows, and a size per row. A query the classifier
    /// does not call a read is described (`query_read: false`), never run (Q26).
    pub async fn preview_export(&self, req: ExportRequest) -> Result<ExportPreview> {
        let config = self.config(req.connection_id)?;
        let kind = config.dialect;
        let encoding = match req.format {
            Format::Csv if req.options.bom => "UTF-8 with BOM",
            Format::Xlsx => "Excel workbook",
            _ => "UTF-8",
        }
        .to_string();
        if let ExportSource::Query { sql, .. } = &req.source
            && !sql.trim().is_empty()
            && !is_read(kind, sql)
        {
            return Ok(ExportPreview {
                encoding,
                query_read: false,
                ..ExportPreview::default()
            });
        }
        let d = self.session(req.connection_id).await?;
        let naming = naming(kind, &req);
        let notes = self.export_notes(d.as_ref(), kind, &req).await;
        let mut source = open(d.as_ref(), plan(kind, req.source.clone())?).await?;
        let columns = source.columns().to_vec();
        let mut rows: Vec<Vec<Value>> = Vec::new();
        while rows.len() < PREVIEW_ROWS {
            match source.next_chunk().await? {
                Some(chunk) => rows.extend(chunk.rows),
                None => break,
            }
        }
        // Dropping the source stops its read and closes its connection.
        drop(source);
        rows.truncate(PREVIEW_ROWS);
        let n = rows.len();
        let chunk = Chunk {
            bytes: rows.iter().flatten().map(Value::size).sum(),
            rows,
        };
        let mut preview = ExportPreview {
            encoding,
            sample_rows: n as u32,
            notes,
            query_read: true,
            ..ExportPreview::default()
        };
        if req.format == Format::Xlsx {
            let kinds: Vec<_> = columns.iter().map(sheet_kind).collect();
            let mut sheet = Vec::with_capacity(n + 1);
            if req.options.header {
                sheet.push(columns.iter().map(|c| c.name.clone()).collect());
            }
            let mut bytes = 0u64;
            for row in &chunk.rows {
                let cells: Vec<String> = row
                    .iter()
                    .zip(&kinds)
                    .map(|(v, k)| cell_text(xlsx_cell(v, *k, &req.options)))
                    .collect();
                bytes += cells.iter().map(|c| c.len() as u64 + 8).sum::<u64>();
                sheet.push(cells);
            }
            preview.sheet = Some(sheet);
            preview.bytes_per_row = if n == 0 { 0 } else { bytes.div_ceil(n as u64) };
            return Ok(preview);
        }
        let (bytes, head) = write_text(kind, &req, &naming, &columns, &chunk)?;
        let text = String::from_utf8_lossy(&bytes);
        preview.lines = first_lines(&text, PREVIEW_LINES);
        preview.bytes_per_row = match (req.format, n) {
            (_, 0) => 0,
            (Format::Sql, _) => sql_row_bytes(kind, &naming, &req.options, &columns, &chunk.rows),
            _ => ((bytes.len() - head) as u64).div_ceil(n as u64),
        };
        Ok(preview)
    }

    /// Starts export `job` (the client's id, Q2) and returns it. The path guard and the
    /// partial file come first, so an existing target (`FileExists`), the data folder and
    /// a target another export is writing are refused here, before any job starts. The
    /// job reads and writes in the background; it commits the file only after a clean
    /// read, and adds one history entry with `changed: false`.
    pub async fn start_export(
        &self,
        job: JobId,
        req: ExportRequest,
        overwrite: bool,
        sink: Arc<dyn JobSink>,
    ) -> Result<JobId> {
        let config = self.config(req.connection_id)?;
        let kind = config.dialect;
        let d = self.session(req.connection_id).await?;
        let naming = naming(kind, &req);
        // Q26: refused before any file or connection opens.
        let planned = plan(kind, req.source.clone())?;
        let cut = match &planned {
            Planned::Rows(rows) => cut_warning(rows.cut_values()),
            Planned::Read(..) => None,
        };
        // Fails closed: without the data folder the guard cannot run.
        let data = self.data_dir.as_deref().ok_or_else(|| {
            Error::InvalidInput("Contura cannot find its data folder, so it cannot export.".into())
        })?;
        let partial = PartialFile::create(&req.path, overwrite, PathUse::Export, data)?;
        let writer = job_writer(kind, &req, &naming, partial.writer())?;
        let ctx = self.jobs.start(
            job,
            JobKind::Export,
            config.id,
            &config.name,
            naming.label.clone(),
            false,
            sink,
        )?;
        let run = Run {
            ctx,
            connection_id: config.id,
            dialect: d,
            planned,
            writer,
            rows_hint: req.rows_hint,
            path: req.path.clone(),
            sql: naming.fallback_sql,
            cut,
        };
        tokio::spawn(run.go());
        Ok(job)
    }
}

/// One export job, moved into its task.
struct Run {
    ctx: JobCtx,
    connection_id: ConnectionId,
    dialect: Arc<dyn Dialect>,
    planned: Planned,
    writer: Box<dyn FormatWriter>,
    rows_hint: Option<u64>,
    path: PathBuf,
    /// The history text: the SELECT the source ran, once it opens.
    sql: String,
    cut: Option<String>,
}

impl Run {
    async fn go(self) {
        let Run {
            ctx,
            connection_id,
            dialect,
            planned,
            writer,
            rows_hint,
            path,
            mut sql,
            cut,
        } = self;
        let started = Instant::now();
        let ran_at_ms = now_ms();
        let written = std::sync::atomic::AtomicU64::new(0);
        let result = async {
            let source = open(dialect.as_ref(), planned).await?;
            sql = source.sql().to_string();
            let total = rows_hint.or_else(|| source.estimate());
            export_pipeline_counted(source, writer, &ctx, total, &written).await
        }
        .await;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let so_far = written.load(std::sync::atomic::Ordering::SeqCst);
        let (outcome, rows, error) = match &result {
            Ok((rows, _)) => (Outcome::Ok, Some(*rows), None),
            // The rows written before the stop, for the record (the file is deleted).
            Err(Error::Cancelled) => (Outcome::Cancelled, Some(so_far), None),
            Err(e) => (Outcome::Error, Some(so_far), Some(plain_message(e))),
        };
        ctx.history(NewHistory {
            connection_id,
            sql,
            ran_at_ms,
            elapsed_ms,
            outcome,
            rows,
            changed: false,
            error,
        });
        let report = result.map(|(rows, summary)| JobReport {
            kind: JobKind::Export,
            rows_read: rows,
            rows_written: rows,
            warnings: cut.into_iter().chain(summary.warnings).collect(),
            elapsed_ms,
            file: Some(path),
            bytes: summary.bytes,
            ..JobReport::default()
        });
        ctx.finish(report);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_size_counts_a_head_per_statement() {
        // Narrow rows: 500 to a statement, so the head adds a 500th of itself.
        let rows = vec![98; 20];
        assert_eq!(
            sql_bytes_per_row(997, &rows, 500),
            100 + 1000_u64.div_ceil(500)
        );
        // Wide rows: the 1 MiB cut comes first, 3 rows to a statement.
        let wide = vec![300_000; 20];
        assert_eq!(
            sql_bytes_per_row(997, &wide, 500),
            300_002 + 1000_u64.div_ceil(3)
        );
        // A row over 1 MiB is a statement of its own.
        assert_eq!(sql_bytes_per_row(97, &[2_000_000], 500), 2_000_002 + 100);
        assert_eq!(sql_bytes_per_row(97, &[], 500), 0);
    }

    #[test]
    fn first_lines_are_physical_lines() {
        assert_eq!(first_lines("", 6), Vec::<String>::new());
        // The line feed that ends the last line starts no line of its own.
        assert_eq!(first_lines("\u{feff}a\r\nb\r\n", 6), ["a", "b"]);
        assert_eq!(first_lines("a\nb", 6), ["a", "b"]);
        assert_eq!(first_lines("1\n2\n3\n4\n5\n6\n7\n", 6).len(), 6);
    }

    #[test]
    fn a_failed_storage_lookup_says_so() {
        assert_eq!(
            storage_notes("t", Err(Error::Query("denied".into()))),
            ["Could not check the table's storage engine."]
        );
        assert!(storage_notes("t", Ok(TableStorage::default())).is_empty());
    }

    #[test]
    fn a_query_must_read() {
        let k = DialectKind::Postgres;
        assert!(is_read(k, "SELECT 1;"));
        assert!(!is_read(k, "DELETE FROM t"));
        assert!(!is_read(k, "INSERT INTO t VALUES (1) RETURNING id"));
        assert!(!is_read(k, "SELECT 1; DELETE FROM t"));
        let q = |sql: &str| ExportSource::Query {
            database: None,
            sql: sql.into(),
            columns: Vec::new(),
        };
        assert!(matches!(
            plan(k, q("UPDATE t SET a = 1")),
            Err(Error::InvalidInput(m)) if m == REFUSE_WRITE
        ));
        assert!(matches!(
            plan(k, q("  ")),
            Err(Error::InvalidInput(m)) if m == "Write a query to export."
        ));
        assert!(matches!(plan(k, q("SELECT 1")), Ok(Planned::Read(..))));
    }

    fn three_columns() -> Box<dyn RowSource> {
        let col = |name: &str| crate::query::ResultColumn {
            name: name.into(),
            type_name: "text".into(),
            numeric: false,
        };
        let text = |v: &str| crate::model::Cell::Text {
            value: v.into(),
            truncated: false,
            total_bytes: v.len() as u64,
        };
        let rows = vec![
            vec![text("1"), text("a"), text("x")],
            vec![text("2"), text("b"), text("y")],
        ];
        Box::new(
            RowsSource::new(
                DialectKind::Postgres,
                &[col("id"), col("name"), col("id")],
                rows,
            )
            .unwrap(),
        )
    }

    fn names(s: &dyn RowSource) -> Vec<String> {
        s.columns().iter().map(|c| c.name.clone()).collect()
    }

    #[tokio::test]
    async fn a_query_export_keeps_only_the_chosen_columns_in_order() {
        let mut s = keep_columns(three_columns(), &["name".into(), "id".into()]).unwrap();
        assert_eq!(names(s.as_ref()), ["name", "id"]);
        let chunk = s.next_chunk().await.unwrap().unwrap();
        assert_eq!(
            chunk.rows,
            [
                vec![Value::Text("a".into()), Value::Text("1".into())],
                vec![Value::Text("b".into()), Value::Text("2".into())],
            ]
        );
        assert_eq!(chunk.bytes, 4);
        assert!(s.next_chunk().await.unwrap().is_none());
        // A repeated name takes the next column of that name.
        let mut s = keep_columns(three_columns(), &["id".into(), "id".into()]).unwrap();
        let chunk = s.next_chunk().await.unwrap().unwrap();
        assert_eq!(
            chunk.rows[0],
            [Value::Text("1".into()), Value::Text("x".into())]
        );
        // Empty keeps every column.
        let s = keep_columns(three_columns(), &[]).unwrap();
        assert_eq!(names(s.as_ref()), ["id", "name", "id"]);
        // A name the result does not have is refused.
        assert!(matches!(
            keep_columns(three_columns(), &["total".into()]),
            Err(Error::InvalidInput(m)) if m == "The result has no column total."
        ));
    }
}
