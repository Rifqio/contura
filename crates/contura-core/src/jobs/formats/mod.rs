//! One streaming writer and one streaming reader per file format.

pub mod csv;
pub mod json;
pub mod sql;
pub mod xlsx;

use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

use crate::error::{Error, Result};
use crate::jobs::paths::PartialWriter;
use crate::jobs::source::{Chunk, SourceColumn, Value};
use crate::jobs::types::{BinaryText, ExportOptions, FileSummary, Format, RowCount};

/// Readers pull the file through a buffer of this size.
pub const BUF_BYTES: usize = 64 * 1024;
/// Delimiter and format sniffing look at this much of the start of a file.
pub const SAMPLE_BYTES: usize = 64 * 1024;
/// One CSV row, JSON object or Excel row larger than this stops the read: 16 MB, the
/// largest value Contura itself reads (`FULL_VALUE_LIMIT`), so the few copies an import
/// holds of a record stay inside the memory budget (ADR 0003).
pub const MAX_RECORD_BYTES: usize = 16 * 1024 * 1024;
/// `inspect` shows this many rows.
pub const PREVIEW_ROWS: usize = 20;
/// `inspect` counts every row of a file under this size; larger ones get an estimate.
pub const EXACT_COUNT_BYTES: u64 = 4 * 1024 * 1024;

const BOM: &[u8] = b"\xEF\xBB\xBF";

/// Writes an export chunk by chunk; nothing holds more than the chunk it is given.
/// Writers write into a `paths::PartialWriter`, never the target path itself.
pub trait FormatWriter: Send {
    fn begin(&mut self, columns: &[SourceColumn]) -> Result<()>;
    fn write_chunk(&mut self, chunk: &Chunk) -> Result<()>;
    /// The bytes written so far and the warnings gathered.
    fn summary(&self) -> WriteSummary;
    /// Writes the format's tail, flushes, and hands back the partial file. The
    /// caller commits it; a writer never commits itself.
    fn finish(self: Box<Self>) -> Result<PartialWriter>;
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct WriteSummary {
    pub bytes: u64,
    pub warnings: Vec<String>,
}

/// Reads an import file one record at a time.
pub trait RecordReader: Send {
    /// The header names, or "Column 1" and so on without a header.
    fn columns(&self) -> &[String];
    fn next_record(&mut self) -> Result<Option<FileRecord>>;
    fn bytes_read(&self) -> u64;
    /// The warnings gathered since the last call.
    fn warnings(&mut self) -> Vec<String>;
    /// The SHA-256 of every byte read, once the reader has reached the end of the file
    /// (None before that). Readers hash through `paths::HashingReader`.
    fn sha256(&self) -> Option<[u8; 32]>;
}

/// One data row: `row` counts data rows from 1 (header excluded), `line` is the physical
/// line it starts on. An empty unquoted CSV field is None.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct FileRecord {
    pub row: u64,
    pub line: u64,
    pub values: Vec<Option<String>>,
}

/// A value as text files write it: `None` is NULL, bytes are `0x` and lowercase hex or
/// base64, booleans are `true` and `false`.
pub fn value_text(v: &Value, opts: &ExportOptions) -> Option<String> {
    match v {
        Value::Null => None,
        Value::Number(s) | Value::Text(s) => Some(s.clone()),
        Value::Bool(b) => Some(if *b { "true" } else { "false" }.to_string()),
        Value::Bytes(b) => Some(match opts.binary {
            BinaryText::Hex => hex_text(b),
            BinaryText::Base64 => {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD.encode(b)
            }
        }),
    }
}

fn hex_text(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("0x");
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 15) as usize] as char);
    }
    s
}

/// Header names as the import shows them: a blank name becomes "Column N" (N counts from
/// 1) and a repeat becomes "name (2)", "name (3)" (Review Focus 2).
pub fn header_names(raw: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(raw.len());
    let mut seen = std::collections::HashSet::new();
    for (i, name) in raw.into_iter().enumerate() {
        let base = if name.trim().is_empty() {
            format!("Column {}", i + 1)
        } else {
            name
        };
        let mut candidate = base.clone();
        let mut n = 2;
        while seen.contains(&candidate) {
            candidate = format!("{base} ({n})");
            n += 1;
        }
        seen.insert(candidate.clone());
        out.push(candidate);
    }
    out
}

/// Counts the bytes written through it.
pub(crate) struct Counting<W> {
    pub(crate) inner: W,
    pub(crate) bytes: u64,
}

impl<W: Write> Counting<W> {
    pub(crate) fn new(inner: W) -> Self {
        Self { inner, bytes: 0 }
    }

    pub(crate) fn put(&mut self, data: &[u8]) -> Result<()> {
        self.inner.write_all(data).map_err(write_err)?;
        self.bytes += data.len() as u64;
        Ok(())
    }
}

pub(crate) fn write_err(e: std::io::Error) -> Error {
    Error::File(format!("cannot write the file: {e}"))
}

pub(crate) fn read_err(path: Option<&Path>, e: std::io::Error) -> Error {
    match path {
        Some(p) => Error::File(format!("cannot read {}: {e}", p.display())),
        None => Error::File(format!("cannot read the file: {e}")),
    }
}

/// Up to `SAMPLE_BYTES` from the start of the file.
pub(crate) fn read_head(path: &Path) -> Result<Vec<u8>> {
    let file = File::open(path).map_err(|e| read_err(Some(path), e))?;
    let mut head = Vec::with_capacity(SAMPLE_BYTES);
    file.take(SAMPLE_BYTES as u64)
        .read_to_end(&mut head)
        .map_err(|e| read_err(Some(path), e))?;
    Ok(head)
}

/// The format a file name says, if it says one.
pub fn format_from_extension(path: &Path) -> Option<Format> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "csv" | "tsv" | "txt" => Some(Format::Csv),
        "json" | "ndjson" | "jsonl" => Some(Format::Json),
        "xlsx" => Some(Format::Xlsx),
        "sql" => Some(Format::Sql),
        _ => None,
    }
}

/// The format the start of a file looks like: a zip is a workbook, `[` or `{` is JSON,
/// anything else is read as CSV.
pub fn format_from_content(head: &[u8]) -> Format {
    if head.starts_with(b"PK\x03\x04") {
        return Format::Xlsx;
    }
    let body = head.strip_prefix(BOM).unwrap_or(head);
    match body.iter().find(|b| !b.is_ascii_whitespace()) {
        Some(b'[') | Some(b'{') => Format::Json,
        _ => Format::Csv,
    }
}

/// What the file step shows: format, delimiter, encoding, size, header, the first 20
/// rows, and a row count (exact under 4 MB, else estimated from bytes per row).
/// Excel files also list their sheets; Task 5 fills in SQL files.
pub fn inspect(path: &Path, format: Option<Format>) -> Result<FileSummary> {
    let head = read_head(path)?;
    let bytes = std::fs::metadata(path)
        .map_err(|e| read_err(Some(path), e))?
        .len();
    let format = format
        .or_else(|| format_from_extension(path))
        .unwrap_or_else(|| format_from_content(&head));
    let encoding = if head.starts_with(BOM) {
        "UTF-8 with BOM"
    } else {
        "UTF-8"
    }
    .to_string();
    let mut summary = FileSummary {
        format,
        encoding,
        bytes,
        ..FileSummary::default()
    };
    match format {
        Format::Csv => {
            let mut reader = csv::CsvReader::open(path, None, true)?;
            summary.delimiter = Some(reader.delimiter());
            summarize(&mut reader, bytes, &mut summary, None)?;
        }
        Format::Json => {
            let mut reader = json::JsonReader::open(path)?;
            summarize(&mut reader, bytes, &mut summary, None)?;
        }
        Format::Xlsx => {
            let mut reader = xlsx::XlsxReader::open_unhashed(path, None, true)?;
            summary.sheets = reader.sheets().to_vec();
            // Bytes per row mean nothing in a zip: a large workbook takes the row count
            // its sheet declares.
            let declared = reader.declared_rows();
            summarize(&mut reader, bytes, &mut summary, Some(declared))?;
        }
        Format::Sql => summary.contura_backup = crate::jobs::script::backup_header(&head),
    }
    Ok(summary)
}

/// The header, the first 20 rows, and the row count: exact under 4 MB, else `declared`
/// when the format declares one, else estimated from bytes per row.
fn summarize(
    reader: &mut dyn RecordReader,
    bytes: u64,
    summary: &mut FileSummary,
    declared: Option<u64>,
) -> Result<()> {
    summary.header = reader.columns().to_vec();
    let start = reader.bytes_read();
    let mut count = 0u64;
    while summary.rows.len() < PREVIEW_ROWS {
        match reader.next_record()? {
            Some(r) => {
                summary.rows.push(r.values);
                count += 1;
            }
            None => {
                summary.rows_estimate = RowCount {
                    rows: count,
                    exact: true,
                };
                return Ok(());
            }
        }
    }
    if bytes < EXACT_COUNT_BYTES {
        while reader.next_record()?.is_some() {
            count += 1;
        }
        summary.rows_estimate = RowCount {
            rows: count,
            exact: true,
        };
        return Ok(());
    }
    if let Some(rows) = declared {
        summary.rows_estimate = RowCount { rows, exact: false };
        return Ok(());
    }
    let used = reader.bytes_read().saturating_sub(start).max(1);
    let rest = bytes.saturating_sub(start);
    summary.rows_estimate = RowCount {
        rows: ((rest as f64) * (count as f64) / (used as f64)).round() as u64,
        exact: false,
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, body: &[u8]) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn value_text_cases() {
        let hex = ExportOptions::default();
        let b64 = ExportOptions {
            binary: BinaryText::Base64,
            ..ExportOptions::default()
        };
        let cases: Vec<(Value, &ExportOptions, Option<&str>)> = vec![
            (Value::Null, &hex, None),
            (Value::Number("-1.50".into()), &hex, Some("-1.50")),
            (Value::Text("".into()), &hex, Some("")),
            (Value::Bool(true), &hex, Some("true")),
            (Value::Bool(false), &hex, Some("false")),
            (Value::Bytes(vec![0, 0xab, 0xff]), &hex, Some("0x00abff")),
            (Value::Bytes(vec![]), &hex, Some("0x")),
            (Value::Bytes(b"hi".to_vec()), &b64, Some("aGk=")),
        ];
        for (v, opts, want) in cases {
            assert_eq!(value_text(&v, opts).as_deref(), want, "{v:?}");
        }
    }

    #[test]
    fn header_names_cases() {
        let cases: Vec<(Vec<&str>, Vec<&str>)> = vec![
            (
                vec!["", "name", "name"],
                vec!["Column 1", "name", "name (2)"],
            ),
            (
                vec!["a", " ", "a", "a"],
                vec!["a", "Column 2", "a (2)", "a (3)"],
            ),
            (vec![], vec![]),
        ];
        for (raw, want) in cases {
            let got = header_names(raw.iter().map(|s| s.to_string()).collect());
            assert_eq!(got, want);
        }
    }

    #[test]
    fn inspect_format_by_extension_and_content() {
        let dir = tempfile::tempdir().unwrap();
        let cases: Vec<(&str, &[u8], Format)> = vec![
            ("a.csv", b"a,b\n1,2\n", Format::Csv),
            ("a.tsv", b"a\tb\n1\t2\n", Format::Csv),
            ("a.json", b"[{\"a\":1}]", Format::Json),
            ("a.ndjson", b"{\"a\":1}\n", Format::Json),
            ("noext", b"  [{\"a\":1}]", Format::Json),
            ("noext2", b"{\"a\":1}\n{\"a\":2}\n", Format::Json),
            ("noext3", b"a;b\n1;2\n", Format::Csv),
            ("data.bin", b"\xEF\xBB\xBF{\"a\":1}\n", Format::Json),
        ];
        for (name, body, want) in cases {
            let p = write(dir.path(), name, body);
            let s = inspect(&p, None).unwrap();
            assert_eq!(s.format, want, "{name}");
            assert_eq!(s.bytes, body.len() as u64);
        }
        // A given format wins over the extension.
        let p = write(dir.path(), "really.txt", b"{\"a\":1}\n");
        assert_eq!(
            inspect(&p, Some(Format::Json)).unwrap().format,
            Format::Json
        );
        assert_eq!(format_from_content(b"PK\x03\x04rest"), Format::Xlsx);
    }

    #[test]
    fn inspect_reads_20_rows_and_counts_small_files_exactly() {
        let dir = tempfile::tempdir().unwrap();
        let mut csv_body = String::from("id,name\n");
        let mut json_body = String::new();
        for i in 0..30 {
            csv_body.push_str(&format!("{i},row {i}\n"));
            json_body.push_str(&format!("{{\"id\":{i},\"name\":\"row {i}\"}}\n"));
        }
        for (name, body) in [("t.csv", &csv_body), ("t.ndjson", &json_body)] {
            let p = write(dir.path(), name, body.as_bytes());
            let s = inspect(&p, None).unwrap();
            assert_eq!(s.header, vec!["id", "name"], "{name}");
            assert_eq!(s.rows.len(), 20);
            assert_eq!(s.rows[19], vec![Some("19".into()), Some("row 19".into())]);
            assert_eq!(
                s.rows_estimate,
                RowCount {
                    rows: 30,
                    exact: true
                }
            );
        }
        let p = write(dir.path(), "c.csv", csv_body.as_bytes());
        let s = inspect(&p, None).unwrap();
        assert_eq!(s.delimiter, Some(crate::jobs::types::Delimiter::Comma));
        assert_eq!(s.encoding, "UTF-8");
    }

    #[test]
    fn inspect_estimates_large_files() {
        let dir = tempfile::tempdir().unwrap();
        // Rows of a fixed width, so the estimate from the first 20 rows is close.
        let row = |i: usize| format!("{i:08},{}\n", "x".repeat(91));
        for (rows, exact) in [(30_000usize, true), (60_000, false)] {
            let mut body = String::from("id,pad\n");
            for i in 0..rows {
                body.push_str(&row(i));
            }
            let p = write(dir.path(), &format!("{rows}.csv"), body.as_bytes());
            let s = inspect(&p, None).unwrap();
            assert_eq!(s.rows_estimate.exact, exact, "{rows}");
            let got = s.rows_estimate.rows as f64;
            assert!(
                (got - rows as f64).abs() / (rows as f64) < 0.01,
                "{rows}: estimated {got}"
            );
            if exact {
                assert_eq!(s.rows_estimate.rows, rows as u64);
            }
        }
    }
}
