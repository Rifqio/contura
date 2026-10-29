//! Excel: constant-memory writer and a capped reader.
//!
//! Writing uses `rust_xlsxwriter`'s `Workbook::add_worksheet_with_constant_memory`: each
//! row is flushed to a temporary file once the next row starts, so memory holds one row.
//! The workbook is assembled into the export's `PartialWriter` at `finish`; the
//! writer never touches the target path.
//!
//! Reading uses `calamine`'s `Xlsx::worksheet_cells_reader`, which walks the sheet XML
//! cell by cell. The shared strings table is loaded whole, which is why Excel import is
//! capped at 500,000 rows and 100 MB, the one exception to streaming.

use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufReader, Read, Seek};
use std::path::Path;
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};

use calamine::{DataRef, ExcelDateTime, Reader, Xlsx};
use rust_xlsxwriter::{Workbook, XlsxError};

use super::{
    BUF_BYTES, FileRecord, FormatWriter, MAX_RECORD_BYTES, RecordReader, WriteSummary,
    header_names, read_err, value_text,
};
use crate::common::grouped;
use crate::edits::is_number;
use crate::error::{Error, Result};
use crate::jobs::paths::{HashingReader, HeldFile, PartialFile, PartialWriter, PathUse};
use crate::jobs::source::{Chunk, SourceColumn, Value, ValueKind};
use crate::jobs::types::ExportOptions;

/// Data rows per sheet; with the header row that is Excel's 1,048,576. Without a header
/// a sheet holds the same count, one row fewer than Excel allows.
pub const SHEET_ROWS: u32 = 1_048_575;
/// Excel's limit on the characters in one cell.
pub const CELL_CHARS: usize = 32_767;
/// Excel's limit on columns.
pub const MAX_COLUMNS: usize = 16_384;
/// The sheet name of a query result's export.
pub const RESULT_SHEET: &str = "result";
/// Excel import takes up to this many data rows.
pub const IMPORT_ROWS: u64 = 500_000;
/// Excel import takes workbooks up to this size.
pub const IMPORT_BYTES: u64 = 100 * MIB;

const MIB: u64 = 1024 * 1024;
const MAX_SAFE_INTEGER: i128 = 1 << 53;
/// The reading thread sends rows in batches of this many, or about 64 KB.
const BATCH_ROWS: usize = 256;

/// One cell as the writer puts it in a sheet.
#[derive(Clone, Debug, PartialEq)]
pub enum XlsxCell {
    Text(String),
    Number(f64),
    Bool(bool),
    Blank,
}

/// Whether a column of `type_name` is written as text in Excel whatever its values:
/// bigint, int8, unsigned bigint, and numeric or decimal with no scale.
pub fn text_number_type(type_name: &str) -> bool {
    let lower = type_name.trim().to_ascii_lowercase();
    if lower.contains("bigint") || lower.contains("big int") {
        return true;
    }
    let base: String = lower
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    match base.as_str() {
        "int8" | "bigserial" | "serial8" => true,
        "numeric" | "decimal" | "dec" | "fixed" => {
            let scale = lower
                .split_once('(')
                .and_then(|(_, args)| args.split_once(','))
                .map(|(_, s)| s.trim_end_matches(|c: char| c == ')' || c.is_whitespace()))
                .and_then(|s| s.trim().parse::<u32>().ok())
                .unwrap_or(0);
            scale == 0
        }
        _ => false,
    }
}

/// The kind `xlsx_cell` gets for a column: Text for the types of `text_number_type`,
/// else the column's own kind. The writer and the export preview both use it.
pub fn sheet_kind(column: &SourceColumn) -> ValueKind {
    if text_number_type(&column.type_name) {
        ValueKind::Text
    } else {
        column.kind
    }
}

/// A value as a cell: integers within 2^53 and floats are numbers; larger integers,
/// decimals, NaN and Infinity, dates and times are text exactly as given (spec
/// open question 8). Text is never a formula.
pub fn xlsx_cell(v: &Value, kind: ValueKind, opts: &ExportOptions) -> XlsxCell {
    let s = match v {
        Value::Null => return XlsxCell::Blank,
        Value::Bool(b) => return XlsxCell::Bool(*b),
        Value::Bytes(_) => return XlsxCell::Text(value_text(v, opts).unwrap_or_default()),
        Value::Number(s) | Value::Text(s) => s,
    };
    let t = s.trim();
    match kind {
        ValueKind::Integer => match t.parse::<i128>() {
            Ok(n) if (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&n) => {
                XlsxCell::Number(n as f64)
            }
            _ => XlsxCell::Text(s.clone()),
        },
        ValueKind::Float if is_number(t) => match t.parse::<f64>() {
            Ok(f) if f.is_finite() => XlsxCell::Number(f),
            _ => XlsxCell::Text(s.clone()),
        },
        ValueKind::Bool => match t.to_ascii_lowercase().as_str() {
            "true" | "t" | "1" => XlsxCell::Bool(true),
            "false" | "f" | "0" => XlsxCell::Bool(false),
            _ => XlsxCell::Text(s.clone()),
        },
        _ => XlsxCell::Text(s.clone()),
    }
}

/// `name` as a sheet name: `[]:*?/\` become `_`, a leading or trailing `'` too, and it
/// is cut so that `name N` fits Excel's 31 characters (UTF-16 units, as Excel counts).
/// Sheet 1 has no number. Excel reserves "History", so that name gets a `_`.
pub fn sheet_name(name: &str, n: u32) -> String {
    let suffix = if n > 1 {
        format!(" {n}")
    } else {
        String::new()
    };
    let keep = 31 - suffix.encode_utf16().count();
    let mut units = 0;
    let mut base: Vec<char> = name
        .chars()
        .map(|c| match c {
            '[' | ']' | ':' | '*' | '?' | '/' | '\\' => '_',
            c => c,
        })
        .take_while(|c| {
            units += c.len_utf16();
            units <= keep
        })
        .collect();
    if base.is_empty() {
        base = "Sheet".chars().collect();
    }
    if base[0] == '\'' {
        base[0] = '_';
    }
    if let Some(last) = base.last_mut()
        && *last == '\''
    {
        *last = '_';
    }
    let mut out: String = base.into_iter().collect();
    out.push_str(&suffix);
    if out.eq_ignore_ascii_case("history") {
        out.push('_');
    }
    out
}

fn xlsx_err(e: XlsxError) -> Error {
    Error::File(format!("cannot write the workbook: {e}"))
}

/// `s` cut to `CELL_CHARS` characters; true when it was cut.
fn cut_cell(s: String) -> (String, bool) {
    match s.char_indices().nth(CELL_CHARS) {
        Some((at, _)) => (s[..at].to_string(), true),
        None => (s, false),
    }
}

/// Writes rows into constant-memory sheets, adding a sheet every `SHEET_ROWS` rows.
pub struct XlsxWriter {
    out: PartialWriter,
    book: Workbook,
    base: String,
    opts: ExportOptions,
    sheet_rows: u32,
    header: Vec<String>,
    kinds: Vec<ValueKind>,
    /// Sheets added so far; the current one is `sheets - 1`.
    sheets: u32,
    /// Data rows in the current sheet.
    rows_in_sheet: u32,
    cut_cells: u64,
    data_bytes: u64,
}

impl XlsxWriter {
    /// Writes into `out`, the export's partial file; `sheet` names the first sheet.
    pub fn new(out: PartialWriter, sheet: &str, opts: &ExportOptions) -> Result<XlsxWriter> {
        // Constant-memory sheets spill to temporary files: keep them beside the export,
        // not on the system drive. The default stays when that folder will not do.
        let mut book = Workbook::new();
        if let Some(dir) = out.target().parent()
            && !dir.as_os_str().is_empty()
        {
            let _ = book.set_tempdir(dir);
        }
        Ok(XlsxWriter {
            out,
            book,
            base: sheet.to_string(),
            opts: opts.clone(),
            sheet_rows: SHEET_ROWS,
            header: Vec::new(),
            kinds: Vec::new(),
            sheets: 0,
            rows_in_sheet: 0,
            cut_cells: 0,
            data_bytes: 0,
        })
    }

    /// Writes to `path` through its guarded partial file; an existing `path` is
    /// refused unless `overwrite`. Commits through `finish` like every other writer.
    pub fn create(
        path: &Path,
        overwrite: bool,
        data_dir: &Path,
        sheet: &str,
        opts: &ExportOptions,
    ) -> Result<XlsxWriter> {
        let out = PartialFile::create(path, overwrite, PathUse::Export, data_dir)?;
        Self::new(out.writer(), sheet, opts)
    }

    #[cfg(test)]
    pub fn with_sheet_rows(mut self, n: u32) -> Self {
        self.sheet_rows = n;
        self
    }

    /// A new constant-memory sheet, with the header row when asked for.
    fn add_sheet(&mut self) -> Result<()> {
        self.sheets += 1;
        let name = sheet_name(&self.base, self.sheets);
        let ws = self
            .book
            .add_worksheet_with_constant_memory()
            .map_err(xlsx_err)?;
        ws.set_name(&name).map_err(xlsx_err)?;
        if self.opts.header {
            for (c, h) in self.header.iter().enumerate() {
                let (h, cut) = cut_cell(h.clone());
                self.cut_cells += u64::from(cut);
                ws.write_string(0, c as u16, h).map_err(xlsx_err)?;
            }
            if self.opts.freeze_header {
                ws.set_freeze_panes(1, 0).map_err(xlsx_err)?;
            }
        }
        self.rows_in_sheet = 0;
        Ok(())
    }

    pub fn write_header(&mut self, columns: &[SourceColumn]) -> Result<()> {
        if columns.len() > MAX_COLUMNS {
            return Err(Error::File(format!(
                "Excel takes up to 16,384 columns; this export has {}.",
                grouped(columns.len() as u64)
            )));
        }
        self.header = columns.iter().map(|c| c.name.clone()).collect();
        self.kinds = columns.iter().map(sheet_kind).collect();
        self.add_sheet()
    }

    pub fn write_rows(&mut self, chunk: &Chunk) -> Result<()> {
        if self.sheets == 0 {
            self.add_sheet()?;
        }
        let top = u32::from(self.opts.header);
        for row in &chunk.rows {
            if self.rows_in_sheet >= self.sheet_rows {
                self.add_sheet()?;
            }
            let r = self.rows_in_sheet + top;
            let ws = self
                .book
                .worksheet_from_index(self.sheets as usize - 1)
                .map_err(xlsx_err)?;
            for (c, v) in row.iter().enumerate() {
                let kind = self.kinds.get(c).copied().unwrap_or(ValueKind::Text);
                let c = c as u16;
                match xlsx_cell(v, kind, &self.opts) {
                    XlsxCell::Text(s) => {
                        let (s, cut) = cut_cell(s);
                        self.cut_cells += u64::from(cut);
                        self.data_bytes += s.len() as u64;
                        // Always a string, never a formula (Review Focus 3).
                        ws.write_string(r, c, s).map_err(xlsx_err)?;
                    }
                    XlsxCell::Number(n) => {
                        self.data_bytes += 8;
                        ws.write_number(r, c, n).map_err(xlsx_err)?;
                    }
                    XlsxCell::Bool(b) => {
                        self.data_bytes += 1;
                        ws.write_boolean(r, c, b).map_err(xlsx_err)?;
                    }
                    XlsxCell::Blank => {}
                }
            }
            self.rows_in_sheet += 1;
        }
        Ok(())
    }

    /// "N cells were cut to 32,767 characters." when any were.
    pub fn warnings(&self) -> Vec<String> {
        match self.cut_cells {
            0 => Vec::new(),
            1 => vec!["1 cell was cut to 32,767 characters.".into()],
            n => vec![format!(
                "{} cells were cut to 32,767 characters.",
                grouped(n)
            )],
        }
    }

    /// Assembles the workbook into the partial file and hands it back, uncommitted.
    pub fn end(mut self) -> Result<PartialWriter> {
        if self.sheets == 0 {
            self.add_sheet()?;
        }
        self.book.save_to_writer(&mut self.out).map_err(xlsx_err)?;
        Ok(self.out)
    }
}

impl FormatWriter for XlsxWriter {
    fn begin(&mut self, columns: &[SourceColumn]) -> Result<()> {
        self.write_header(columns)
    }
    fn write_chunk(&mut self, chunk: &Chunk) -> Result<()> {
        self.write_rows(chunk)
    }
    /// `bytes` is the cell data written so far; the workbook is compressed at `finish`,
    /// and `PartialWriter::commit` gives the file's real size.
    fn summary(&self) -> WriteSummary {
        WriteSummary {
            bytes: self.data_bytes,
            warnings: self.warnings(),
        }
    }
    fn finish(self: Box<Self>) -> Result<PartialWriter> {
        (*self).end()
    }
}

/// The refusal for a workbook with more data rows than Excel import takes.
pub fn rows_cap_text(rows: u64, cap: u64) -> String {
    format!(
        "This workbook has {} rows. Excel import takes up to {}; save it as CSV.",
        grouped(rows),
        grouped(cap)
    )
}

/// The refusal for a workbook larger than Excel import takes. Sizes round up, so a
/// workbook just over the cap does not read as the cap itself.
pub fn bytes_cap_text(bytes: u64, cap: u64) -> String {
    format!(
        "This workbook is {} MB. Excel import takes up to {} MB; save it as CSV.",
        grouped(bytes.div_ceil(MIB)),
        grouped(cap.div_ceil(MIB))
    )
}

/// The unpacked size of the shared strings part, and of each sheet.
pub const ENTRY_UNPACKED: u64 = 256 * MIB;
/// The unpacked size of the whole workbook.
pub const TOTAL_UNPACKED: u64 = 1024 * MIB;

/// Which unpacked-size limit a workbook passed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Unpacked {
    SharedStrings,
    Sheet,
    Total,
}

/// A size as the refusals say it: whole GB when it is a whole number of them, else MB
/// rounded up.
fn size_text(bytes: u64) -> String {
    const GIB: u64 = 1024 * MIB;
    if bytes >= GIB && bytes.is_multiple_of(GIB) {
        format!("{} GB", grouped(bytes / GIB))
    } else {
        format!("{} MB", grouped(bytes.div_ceil(MIB)))
    }
}

fn unpacked_text(what: Unpacked, bytes: u64, cap: u64) -> String {
    let (size, cap) = (size_text(bytes), size_text(cap));
    match what {
        Unpacked::SharedStrings => format!(
            "This workbook's shared text unpacks to {size}. Excel import takes up to {cap}; save it as CSV."
        ),
        Unpacked::Sheet => format!(
            "A sheet in this workbook unpacks to {size}. Excel import takes up to {cap} a sheet; save it as CSV."
        ),
        Unpacked::Total => format!(
            "This workbook unpacks to {size}. Excel import takes up to {cap}; save it as CSV."
        ),
    }
}

/// The refusal when the bytes actually unpacked pass `cap`; the real size is not known
/// because reading stops there.
fn over_text(what: Unpacked, cap: u64) -> String {
    let cap = size_text(cap);
    match what {
        Unpacked::SharedStrings => format!(
            "This workbook's shared text unpacks to more than {cap}. Excel import takes up to {cap}; save it as CSV."
        ),
        Unpacked::Sheet => format!(
            "A sheet in this workbook unpacks to more than {cap}. Excel import takes up to {cap} a sheet; save it as CSV."
        ),
        Unpacked::Total => format!(
            "This workbook unpacks to more than {cap}. Excel import takes up to {cap}; save it as CSV."
        ),
    }
}

/// Which limit an entry's unpacked size counts against besides the total.
fn entry_kind(name: &str) -> Option<Unpacked> {
    let name = name.to_ascii_lowercase();
    if name.ends_with("sharedstrings.xml") {
        Some(Unpacked::SharedStrings)
    } else if name.contains("worksheets/") && name.ends_with(".xml") {
        Some(Unpacked::Sheet)
    } else {
        None
    }
}

/// The unpacked sizes, checked before calamine loads the shared strings whole:
/// the shared strings part and each sheet up to `caps.entry`, everything up to
/// `caps.total`. The sizes the zip directory declares are checked first, for an exact
/// figure in the refusal; then every entry is unpacked and counted, stopping past the
/// cap, because a crafted directory can declare any size (L4, security audit 1.0).
fn check_unpacked(file: Source, caps: Caps) -> Result<()> {
    let bad = |e: zip::result::ZipError| Error::File(format!("cannot read the workbook: {e}"));
    let mut zip = zip::ZipArchive::new(BufReader::with_capacity(BUF_BYTES, file)).map_err(bad)?;
    let mut total = 0u64;
    for i in 0..zip.len() {
        let entry = zip.by_index_raw(i).map_err(bad)?;
        let size = entry.size();
        if let Some(what) = entry_kind(entry.name())
            && size > caps.entry
        {
            return Err(Error::File(unpacked_text(what, size, caps.entry)));
        }
        total = total.saturating_add(size);
    }
    if total > caps.total {
        return Err(Error::File(unpacked_text(
            Unpacked::Total,
            total,
            caps.total,
        )));
    }

    let mut total = 0u64;
    for i in 0..zip.len() {
        // An entry this build cannot unpack (an unknown method, encryption) cannot be
        // unpacked by calamine either, so it holds no hidden bytes; its declared size
        // was counted above.
        let Ok(mut entry) = zip.by_index(i) else {
            continue;
        };
        let what = entry_kind(entry.name());
        let left = caps.total - total;
        let limit = if what.is_some() {
            caps.entry.min(left)
        } else {
            left
        };
        let read = std::io::copy(&mut Read::take(&mut entry, limit + 1), &mut std::io::sink())
            .map_err(|e| Error::File(format!("cannot read the workbook: {e}")))?;
        if read > limit {
            return Err(Error::File(match what {
                Some(what) if read > caps.entry => over_text(what, caps.entry),
                _ => over_text(Unpacked::Total, caps.total),
            }));
        }
        total += read;
    }
    Ok(())
}

#[derive(Clone, Copy, Debug)]
struct Caps {
    rows: u64,
    bytes: u64,
    entry: u64,
    total: u64,
    hash: bool,
}

impl Caps {
    fn import() -> Caps {
        Caps {
            rows: IMPORT_ROWS,
            bytes: IMPORT_BYTES,
            entry: ENTRY_UNPACKED,
            total: TOTAL_UNPACKED,
            hash: true,
        }
    }
}

type RawRow = (u32, Vec<Option<String>>);

/// What the reading thread sends.
enum Msg {
    /// The workbook opened: its sheets, the sheet's declared data rows and columns.
    Opened {
        sheets: Vec<String>,
        rows: u64,
        width: usize,
    },
    /// Rows in sheet order: the sheet row (0-based) and the values by column.
    Rows(Vec<RawRow>),
    Failed(Error),
    End,
}

fn book_err(e: calamine::XlsxError) -> Error {
    Error::File(format!("cannot read the workbook: {e}"))
}

/// A number as its shortest text: integers without `.0`.
fn number_text(f: f64) -> String {
    if f == 0.0 { "0".into() } else { format!("{f}") }
}

/// A date cell as ISO 8601: a date, a time, or both; a duration as hours:minutes:seconds.
fn date_text(d: &ExcelDateTime) -> String {
    if d.is_duration() {
        let secs = (d.as_f64() * 86_400.0).round() as i64;
        let sign = if secs < 0 { "-" } else { "" };
        let secs = secs.abs();
        return format!(
            "{sign}{:02}:{:02}:{:02}",
            secs / 3600,
            secs / 60 % 60,
            secs % 60
        );
    }
    let (y, mo, day, h, mi, s, ms) = d.to_ymd_hms_milli();
    let mut time = format!("{h:02}:{mi:02}:{s:02}");
    if ms > 0 {
        time.push_str(&format!(".{ms:03}"));
    }
    let v = d.as_f64();
    if (0.0..1.0).contains(&v) {
        return time;
    }
    let date = format!("{y:04}-{mo:02}-{day:02}");
    if (h, mi, s, ms) == (0, 0, 0, 0) {
        date
    } else {
        format!("{date}T{time}")
    }
}

/// A cell as import text; None for an empty cell.
fn cell_text(v: &DataRef<'_>) -> Option<String> {
    Some(match v {
        DataRef::Empty => return None,
        DataRef::String(s) => s.clone(),
        DataRef::SharedString(s) => s.to_string(),
        DataRef::Int(i) => i.to_string(),
        DataRef::Float(f) => number_text(*f),
        DataRef::Bool(b) => b.to_string(),
        DataRef::DateTime(d) => date_text(d),
        DataRef::DateTimeIso(s) | DataRef::DurationIso(s) => s.clone(),
        DataRef::Error(e) => e.to_string(),
    })
}

/// The bytes of a workbook: the file by its path, or a held import file.
trait ReadSeek: Read + Seek + Send {}

impl<T: Read + Seek + Send> ReadSeek for T {}

type Source = Box<dyn ReadSeek>;

/// The reading thread: opens the workbook, checks the row cap against the sheet's
/// dimension, then sends rows in batches until the end.
fn read_sheet(file: Source, sheet: Option<String>, header: bool, cap: u64, tx: SyncSender<Msg>) {
    let done = (|| -> Result<()> {
        let mut book: Xlsx<_> =
            Xlsx::new(BufReader::with_capacity(BUF_BYTES, file)).map_err(book_err)?;
        let sheets = book.sheet_names();
        let name = match sheet {
            Some(s) if sheets.contains(&s) => s,
            Some(s) => {
                return Err(Error::File(format!("The workbook has no sheet named {s}.")));
            }
            None => sheets
                .first()
                .cloned()
                .ok_or_else(|| Error::File("The workbook has no sheets.".into()))?,
        };
        let mut cells = book.worksheet_cells_reader(&name).map_err(book_err)?;
        let dims = cells.dimensions();
        let height = u64::from(dims.end.0.saturating_sub(dims.start.0)) + 1;
        let declared = height.saturating_sub(u64::from(header));
        if declared > cap {
            return Err(Error::File(rows_cap_text(declared, cap)));
        }
        let opened = Msg::Opened {
            sheets,
            rows: declared,
            width: dims.end.1 as usize + 1,
        };
        if tx.send(opened).is_err() {
            return Ok(());
        }
        let mut batch: Vec<RawRow> = Vec::new();
        let mut batch_bytes = 0usize;
        let mut current: Option<RawRow> = None;
        let mut row_bytes = 0usize;
        // Rows past the cap (a dimension that undercounts) are counted, not kept.
        let limit = cap + u64::from(header);
        let mut rows = 0u64;
        loop {
            let cell = cells.next_cell().map_err(book_err)?;
            let at = cell.as_ref().map(|c| c.get_position().0);
            if current.as_ref().map(|r| r.0) != at
                && let Some(row) = current.take()
            {
                rows += 1;
                if rows <= limit {
                    batch_bytes += row_bytes;
                    batch.push(row);
                }
                row_bytes = 0;
                if batch.len() >= BATCH_ROWS || batch_bytes >= BUF_BYTES {
                    batch_bytes = 0;
                    if tx.send(Msg::Rows(std::mem::take(&mut batch))).is_err() {
                        return Ok(());
                    }
                }
            }
            let Some(cell) = cell else { break };
            let Some(text) = cell_text(cell.get_value()) else {
                continue;
            };
            let (r, c) = cell.get_position();
            let row = current.get_or_insert_with(|| (r, Vec::new()));
            row_bytes += text.len();
            if row_bytes > MAX_RECORD_BYTES {
                return Err(Error::File(format!(
                    "Line {}: one row is larger than 16 MB.",
                    r + 1
                )));
            }
            let c = c as usize;
            if row.1.len() <= c {
                row.1.resize(c + 1, None);
            }
            row.1[c] = Some(text);
        }
        if rows > limit {
            return Err(Error::File(rows_cap_text(rows - u64::from(header), cap)));
        }
        if !batch.is_empty() && tx.send(Msg::Rows(batch)).is_err() {
            return Ok(());
        }
        let _ = tx.send(Msg::End);
        Ok(())
    })();
    if let Err(e) = done {
        let _ = tx.send(Msg::Failed(e));
    }
}

/// Reads one sheet row by row on a thread of its own (calamine's cell reader borrows
/// the workbook), sending batches through a channel of 2.
pub struct XlsxReader {
    columns: Vec<String>,
    sheets: Vec<String>,
    /// The sheet's declared data rows (its `<dimension>`).
    declared_rows: u64,
    header: bool,
    width: usize,
    rx: Receiver<Msg>,
    pending: VecDeque<RawRow>,
    row: u64,
    file_bytes: u64,
    /// None when opened for `inspect`.
    hash: Option<[u8; 32]>,
    eof: bool,
}

impl XlsxReader {
    /// Opens `sheet` (the first sheet when None), with the first row as the header.
    pub fn open(path: &Path, sheet: Option<&str>) -> Result<XlsxReader> {
        Self::open_with(path, sheet, true)
    }

    /// As `open`; without a header the columns are "Column 1" and so on.
    pub fn open_with(path: &Path, sheet: Option<&str>, header: bool) -> Result<XlsxReader> {
        Self::open_capped(path, sheet, header, Caps::import())
    }

    /// As `open_with`, without the SHA-256 pass, for `inspect`; `sha256` stays None.
    pub fn open_unhashed(path: &Path, sheet: Option<&str>, header: bool) -> Result<XlsxReader> {
        Self::open_capped(
            path,
            sheet,
            header,
            Caps {
                hash: false,
                ..Caps::import()
            },
        )
    }

    /// As `open_with`, reading the held import file through its own handle, up to the
    /// size it had when it opened.
    pub fn open_held(held: &HeldFile, sheet: Option<&str>, header: bool) -> Result<XlsxReader> {
        let open = || -> Result<Source> { Ok(Box::new(held.reader())) };
        Self::from_source(
            held.path(),
            held.bytes(),
            &open,
            sheet,
            header,
            Caps::import(),
        )
    }

    /// The size cap first, then one streamed pass for the SHA-256 that enforces the
    /// cap on the bytes it reads, then the unpacked sizes from the zip directory,
    /// then calamine on its thread, which checks the row cap before reading
    /// cells.
    fn open_capped(
        path: &Path,
        sheet: Option<&str>,
        header: bool,
        caps: Caps,
    ) -> Result<XlsxReader> {
        let file_bytes = std::fs::metadata(path)
            .map_err(|e| read_err(Some(path), e))?
            .len();
        let open = || -> Result<Source> {
            Ok(Box::new(
                File::open(path).map_err(|e| read_err(Some(path), e))?,
            ))
        };
        Self::from_source(path, file_bytes, &open, sheet, header, caps)
    }

    /// `open` gives the workbook's bytes from the start each time it is called.
    fn from_source(
        path: &Path,
        mut file_bytes: u64,
        open: &dyn Fn() -> Result<Source>,
        sheet: Option<&str>,
        header: bool,
        caps: Caps,
    ) -> Result<XlsxReader> {
        if file_bytes > caps.bytes {
            return Err(Error::File(bytes_cap_text(file_bytes, caps.bytes)));
        }
        let hash = if caps.hash {
            let mut hashing = HashingReader::new(open()?);
            let read = std::io::copy(
                &mut std::io::Read::take(&mut hashing, caps.bytes + 1),
                &mut std::io::sink(),
            )
            .map_err(|e| read_err(Some(path), e))?;
            if read > caps.bytes {
                return Err(Error::File(bytes_cap_text(read, caps.bytes)));
            }
            file_bytes = read;
            Some(hashing.finish())
        } else {
            None
        };
        check_unpacked(open()?, caps)?;

        let (tx, rx) = sync_channel(2);
        let file = open()?;
        let sheet_name = sheet.map(str::to_string);
        std::thread::Builder::new()
            .name("xlsx-reader".into())
            .spawn(move || read_sheet(file, sheet_name, header, caps.rows, tx))
            .map_err(|e| Error::File(format!("cannot read the workbook: {e}")))?;
        let (sheets, declared_rows, width) = match rx.recv() {
            Ok(Msg::Opened {
                sheets,
                rows,
                width,
            }) => (sheets, rows, width),
            Ok(Msg::Failed(e)) => return Err(e),
            _ => return Err(stopped()),
        };
        let mut reader = XlsxReader {
            columns: Vec::new(),
            sheets,
            declared_rows,
            header,
            width,
            rx,
            pending: VecDeque::new(),
            row: 0,
            file_bytes,
            hash,
            eof: false,
        };
        if header {
            match reader.next_raw()? {
                Some((_, names)) => {
                    let width = reader.width.max(names.len());
                    let mut names: Vec<String> =
                        names.into_iter().map(Option::unwrap_or_default).collect();
                    names.resize(width, String::new());
                    reader.width = width;
                    reader.columns = header_names(names);
                }
                None => reader.width = 0,
            }
        } else {
            reader.columns = (1..=reader.width).map(|i| format!("Column {i}")).collect();
        }
        Ok(reader)
    }

    /// Every sheet in the workbook, in order.
    pub fn sheets(&self) -> &[String] {
        &self.sheets
    }

    /// The data rows the sheet declares.
    pub fn declared_rows(&self) -> u64 {
        self.declared_rows
    }

    fn next_raw(&mut self) -> Result<Option<RawRow>> {
        loop {
            if let Some(r) = self.pending.pop_front() {
                return Ok(Some(r));
            }
            if self.eof {
                return Ok(None);
            }
            match self.rx.recv() {
                Ok(Msg::Rows(rows)) => self.pending.extend(rows),
                Ok(Msg::End) => self.eof = true,
                Ok(Msg::Failed(e)) => return Err(e),
                Ok(Msg::Opened { .. }) | Err(_) => return Err(stopped()),
            }
        }
    }
}

fn stopped() -> Error {
    Error::File("cannot read the workbook: the reader stopped".into())
}

impl RecordReader for XlsxReader {
    fn columns(&self) -> &[String] {
        &self.columns
    }

    fn next_record(&mut self) -> Result<Option<FileRecord>> {
        let Some((r, mut values)) = self.next_raw()? else {
            return Ok(None);
        };
        if values.len() > self.width {
            let of = if self.header {
                "the header has"
            } else {
                "the first row has"
            };
            return Err(Error::File(format!(
                "Line {} has {} values; {of} {}.",
                r + 1,
                values.len(),
                self.width
            )));
        }
        values.resize(self.width, None);
        self.row += 1;
        Ok(Some(FileRecord {
            row: self.row,
            line: u64::from(r) + 1,
            values,
        }))
    }

    /// The workbook is compressed, so this is the file's size times the share of the
    /// declared rows read so far, and the whole file at the end.
    fn bytes_read(&self) -> u64 {
        if self.eof && self.pending.is_empty() {
            return self.file_bytes;
        }
        let share = u128::from(self.file_bytes) * u128::from(self.row)
            / u128::from(self.declared_rows.max(1));
        (share as u64).min(self.file_bytes)
    }

    fn warnings(&mut self) -> Vec<String> {
        Vec::new()
    }

    fn sha256(&self) -> Option<[u8; 32]> {
        self.hash.filter(|_| self.eof && self.pending.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::formats::inspect;
    use crate::jobs::paths::outside_data;
    use crate::jobs::types::{BinaryText, Format, RowCount};
    use calamine::{Data, Reader, Xlsx, open_workbook};

    fn col(name: &str, type_name: &str, kind: ValueKind) -> SourceColumn {
        SourceColumn {
            name: name.into(),
            type_name: type_name.into(),
            kind,
        }
    }

    fn text(s: &str) -> Value {
        Value::Text(s.into())
    }
    fn num(s: &str) -> Value {
        Value::Number(s.into())
    }

    fn chunk(rows: Vec<Vec<Value>>) -> Chunk {
        Chunk { rows, bytes: 0 }
    }

    /// Writes `chunks` to `<dir>/<file>` and commits; returns the path and warnings.
    fn write_book(
        dir: &Path,
        file: &str,
        sheet: &str,
        columns: &[SourceColumn],
        chunks: &[Chunk],
        opts: &ExportOptions,
        sheet_rows: Option<u32>,
    ) -> (std::path::PathBuf, Vec<String>) {
        let target = dir.join(file);
        let mut w = XlsxWriter::create(&target, false, &outside_data(), sheet, opts).unwrap();
        if let Some(n) = sheet_rows {
            w = w.with_sheet_rows(n);
        }
        let mut w: Box<dyn FormatWriter> = Box::new(w);
        w.begin(columns).unwrap();
        for c in chunks {
            w.write_chunk(c).unwrap();
        }
        let warnings = w.summary().warnings;
        let out = w.finish().unwrap();
        assert!(
            !target.exists(),
            "the writer never writes the target itself"
        );
        out.commit().unwrap();
        (target, warnings)
    }

    fn sheet_data(path: &Path, sheet: &str) -> Vec<Vec<Data>> {
        let mut book: Xlsx<_> = open_workbook(path).unwrap();
        let range = book.worksheet_range(sheet).unwrap();
        range.rows().map(|r| r.to_vec()).collect()
    }

    fn read_all(path: &Path, sheet: Option<&str>) -> (Vec<String>, Vec<Vec<Option<String>>>) {
        let mut r = XlsxReader::open(path, sheet).unwrap();
        let mut rows = Vec::new();
        while let Some(rec) = r.next_record().unwrap() {
            rows.push(rec.values);
        }
        (r.columns().to_vec(), rows)
    }

    #[test]
    fn xlsx_cell_cases() {
        let o = ExportOptions::default();
        let b64 = ExportOptions {
            binary: BinaryText::Base64,
            ..ExportOptions::default()
        };
        use ValueKind::*;
        let big = (1i64 << 53).to_string();
        let over = ((1i64 << 53) + 1).to_string();
        let cases: Vec<(Value, ValueKind, &ExportOptions, XlsxCell)> = vec![
            (Value::Null, Integer, &o, XlsxCell::Blank),
            (num("42"), Integer, &o, XlsxCell::Number(42.0)),
            (num("-7"), Integer, &o, XlsxCell::Number(-7.0)),
            (
                num(&big),
                Integer,
                &o,
                XlsxCell::Number((1u64 << 53) as f64),
            ),
            (num(&over), Integer, &o, XlsxCell::Text(over.clone())),
            (
                num("-9223372036854775808"),
                Integer,
                &o,
                XlsxCell::Text("-9223372036854775808".into()),
            ),
            (num("1.5"), Float, &o, XlsxCell::Number(1.5)),
            (num("NaN"), Float, &o, XlsxCell::Text("NaN".into())),
            (num("inf"), Float, &o, XlsxCell::Text("inf".into())),
            (num("-inf"), Float, &o, XlsxCell::Text("-inf".into())),
            (
                num("Infinity"),
                Float,
                &o,
                XlsxCell::Text("Infinity".into()),
            ),
            (num("12.50"), Decimal, &o, XlsxCell::Text("12.50".into())),
            (Value::Bool(true), Bool, &o, XlsxCell::Bool(true)),
            (num("0"), Bool, &o, XlsxCell::Bool(false)),
            (
                text("2024-01-02"),
                Date,
                &o,
                XlsxCell::Text("2024-01-02".into()),
            ),
            (
                text("03:04:05"),
                Time,
                &o,
                XlsxCell::Text("03:04:05".into()),
            ),
            (text("=1+1"), Text, &o, XlsxCell::Text("=1+1".into())),
            (num("5"), Text, &o, XlsxCell::Text("5".into())),
            (
                Value::Bytes(vec![0xab]),
                Binary,
                &o,
                XlsxCell::Text("0xab".into()),
            ),
            (
                Value::Bytes(b"hi".to_vec()),
                Binary,
                &b64,
                XlsxCell::Text("aGk=".into()),
            ),
        ];
        for (v, kind, opts, want) in cases {
            assert_eq!(xlsx_cell(&v, kind, opts), want, "{v:?} {kind:?}");
        }
    }

    #[test]
    fn text_number_types() {
        for t in [
            "bigint",
            "int8",
            "bigint unsigned",
            "bigint(20) unsigned",
            "BIGINT",
            "UNSIGNED BIG INT",
            "bigserial",
            "numeric",
            "numeric(30)",
            "numeric(30,0)",
            "decimal(20, 0)",
            "NUMERIC",
        ] {
            assert!(text_number_type(t), "{t}");
        }
        for t in [
            "integer",
            "int4",
            "numeric(10,2)",
            "double precision",
            "text",
            "smallint",
        ] {
            assert!(!text_number_type(t), "{t}");
        }
    }

    #[test]
    fn sheet_names_cut_and_cleaned() {
        assert_eq!(sheet_name("menu_items", 1), "menu_items");
        assert_eq!(sheet_name("menu_items", 2), "menu_items 2");
        assert_eq!(sheet_name("a[b]:c*d?e/f\\g", 1), "a_b__c_d_e_f_g");
        assert_eq!(sheet_name("'quoted'", 1), "_quoted_");
        assert_eq!(sheet_name("", 1), "Sheet");
        let long = "x".repeat(40);
        assert_eq!(sheet_name(&long, 1), "x".repeat(31));
        assert_eq!(sheet_name(&long, 12), format!("{} 12", "x".repeat(28)));
        let wide = "表".repeat(40);
        assert_eq!(sheet_name(&wide, 1).chars().count(), 31);
        // Excel counts UTF-16 units: an emoji is two.
        let emoji = "😀".repeat(20);
        assert_eq!(sheet_name(&emoji, 1).encode_utf16().count(), 30);
        assert_eq!(sheet_name(&emoji, 2).encode_utf16().count(), 30);
        // "History" is reserved by Excel, in any case.
        assert_eq!(sheet_name("history", 1), "history_");
        assert_eq!(sheet_name("History", 2), "History 2");
    }

    /// A zip holding `entries` (name, size of zeros), deflated.
    fn crafted_zip(dir: &Path, name: &str, entries: &[(&str, usize)]) -> std::path::PathBuf {
        use std::io::Write as _;
        let path = dir.join(name);
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (entry, size) in entries {
            zip.start_file(*entry, opts).unwrap();
            zip.write_all(&vec![b' '; *size]).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    #[test]
    fn unpacked_sizes_capped_before_calamine() {
        // the zip directory's sizes are checked before calamine loads anything.
        assert_eq!(
            unpacked_text(Unpacked::SharedStrings, 300 * MIB, ENTRY_UNPACKED),
            "This workbook's shared text unpacks to 300 MB. Excel import takes up to 256 MB; save it as CSV."
        );
        assert_eq!(
            unpacked_text(Unpacked::Sheet, 300 * MIB, ENTRY_UNPACKED),
            "A sheet in this workbook unpacks to 300 MB. Excel import takes up to 256 MB a sheet; save it as CSV."
        );
        assert_eq!(
            unpacked_text(Unpacked::Total, 1200 * MIB, TOTAL_UNPACKED),
            "This workbook unpacks to 1,200 MB. Excel import takes up to 1 GB; save it as CSV."
        );

        let dir = tempfile::tempdir().unwrap();
        let small = Caps {
            entry: MIB,
            total: 2 * MIB,
            ..Caps::import()
        };
        let open = |path: &Path| match XlsxReader::open_capped(path, None, true, small) {
            Err(Error::File(m)) => m,
            other => panic!("{:?}", other.map(|_| ())),
        };
        let p = crafted_zip(
            dir.path(),
            "s.xlsx",
            &[("xl/sharedStrings.xml", 2 * MIB as usize)],
        );
        assert_eq!(
            open(&p),
            unpacked_text(Unpacked::SharedStrings, 2 * MIB, MIB)
        );
        let p = crafted_zip(
            dir.path(),
            "w.xlsx",
            &[("xl/worksheets/sheet1.xml", MIB as usize + 1)],
        );
        assert_eq!(open(&p), unpacked_text(Unpacked::Sheet, MIB + 1, MIB));
        let third = (MIB as usize) * 3 / 4;
        let p = crafted_zip(
            dir.path(),
            "t.xlsx",
            &[
                ("xl/a.xml", third),
                ("xl/b.xml", third),
                ("xl/c.xml", third),
            ],
        );
        assert_eq!(
            open(&p),
            unpacked_text(Unpacked::Total, 3 * third as u64, 2 * MIB)
        );
        // Under the caps, the check passes and calamine reports what it finds.
        let p = crafted_zip(dir.path(), "ok.xlsx", &[("xl/a.xml", 10)]);
        assert!(
            open(&p).starts_with("cannot read the workbook"),
            "{}",
            open(&p)
        );
    }

    /// `crafted_zip`, then every entry's declared unpacked size rewritten to `declared`
    /// in the local header and the central directory. The deflate stream and the CRC
    /// stay true, so the entry still unpacks to its real size.
    fn lying_zip(
        dir: &Path,
        name: &str,
        entries: &[(&str, usize)],
        declared: u32,
    ) -> std::path::PathBuf {
        let path = crafted_zip(dir, name, entries);
        let mut bytes = std::fs::read(&path).unwrap();
        let mut patched = 0;
        let mut i = 0;
        while i + 4 <= bytes.len() {
            let at = match bytes[i..i + 4] {
                [0x50, 0x4b, 0x03, 0x04] => Some(i + 22),
                [0x50, 0x4b, 0x01, 0x02] => Some(i + 24),
                _ => None,
            };
            if let Some(at) = at {
                bytes[at..at + 4].copy_from_slice(&declared.to_le_bytes());
                patched += 1;
            }
            i += 1;
        }
        assert_eq!(patched, entries.len() * 2);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn unpacked_sizes_counted_not_trusted() {
        // L4 (security audit 1.0): a zip directory that says 10 bytes for parts that
        // really unpack past the caps is refused on the bytes actually unpacked.
        let dir = tempfile::tempdir().unwrap();
        let small = Caps {
            entry: MIB,
            total: 2 * MIB,
            ..Caps::import()
        };
        let open = |path: &Path| match XlsxReader::open_capped(path, None, true, small) {
            Err(Error::File(m)) => m,
            other => panic!("{:?}", other.map(|_| ())),
        };
        let p = lying_zip(
            dir.path(),
            "s.xlsx",
            &[("xl/sharedStrings.xml", 4 * MIB as usize)],
            10,
        );
        assert_eq!(open(&p), over_text(Unpacked::SharedStrings, MIB));
        let p = lying_zip(
            dir.path(),
            "w.xlsx",
            &[("xl/worksheets/sheet1.xml", 2 * MIB as usize)],
            10,
        );
        assert_eq!(open(&p), over_text(Unpacked::Sheet, MIB));
        let third = (MIB as usize) * 3 / 4;
        let p = lying_zip(
            dir.path(),
            "t.xlsx",
            &[
                ("xl/a.xml", third),
                ("xl/b.xml", third),
                ("xl/c.xml", third),
            ],
            10,
        );
        assert_eq!(open(&p), over_text(Unpacked::Total, 2 * MIB));
        assert_eq!(
            over_text(Unpacked::SharedStrings, ENTRY_UNPACKED),
            "This workbook's shared text unpacks to more than 256 MB. Excel import takes up to 256 MB; save it as CSV."
        );
    }

    #[test]
    fn inspect_open_skips_the_hash() {
        let dir = tempfile::tempdir().unwrap();
        let columns = vec![col("id", "integer", ValueKind::Integer)];
        let (path, _) = write_book(
            dir.path(),
            "h.xlsx",
            "t",
            &columns,
            &[chunk(vec![vec![num("1")]])],
            &ExportOptions::default(),
            None,
        );
        let mut r = XlsxReader::open_unhashed(&path, None, true).unwrap();
        while r.next_record().unwrap().is_some() {}
        assert_eq!(r.sha256(), None);
    }

    #[test]
    fn constant_memory_read_back_with_calamine() {
        let dir = tempfile::tempdir().unwrap();
        let columns = vec![
            col("id", "integer", ValueKind::Integer),
            col("name", "text", ValueKind::Text),
            col("price", "double precision", ValueKind::Float),
            col("ok", "boolean", ValueKind::Bool),
            col("note", "text", ValueKind::Text),
        ];
        let mut chunks = Vec::new();
        for c in 0..3 {
            let rows = (0..1000)
                .map(|i| {
                    let n = c * 1000 + i;
                    vec![
                        num(&n.to_string()),
                        text(&format!("row {n}")),
                        num(&format!("{n}.25")),
                        Value::Bool(n % 2 == 0),
                        if n % 3 == 0 { Value::Null } else { text("x") },
                    ]
                })
                .collect();
            chunks.push(chunk(rows));
        }
        let (path, warnings) = write_book(
            dir.path(),
            "t.xlsx",
            "menu_items",
            &columns,
            &chunks,
            &ExportOptions::default(),
            None,
        );
        assert!(warnings.is_empty());
        // Constant-memory sheets write inline strings, so the workbook has no shared
        // strings part.
        let raw = std::fs::read(&path).unwrap();
        assert!(!raw.windows(20).any(|w| w == b"xl/sharedStrings.xml"));

        let data = sheet_data(&path, "menu_items");
        assert_eq!(data.len(), 3001);
        assert_eq!(
            data[0],
            ["id", "name", "price", "ok", "note"].map(|s| Data::String(s.into()))
        );
        assert_eq!(data[1][0], Data::Float(0.0));
        assert_eq!(data[1][1], Data::String("row 0".into()));
        assert_eq!(data[1][2], Data::Float(0.25));
        assert_eq!(data[1][3], Data::Bool(true));
        assert_eq!(data[1][4], Data::Empty);
        assert_eq!(data[3000][0], Data::Float(2999.0));
        assert_eq!(data[3000][4], Data::String("x".into()));

        let (header, rows) = read_all(&path, None);
        assert_eq!(header, ["id", "name", "price", "ok", "note"]);
        assert_eq!(rows.len(), 3000);
        assert_eq!(
            rows[2],
            vec![
                Some("2".into()),
                Some("row 2".into()),
                Some("2.25".into()),
                Some("true".into()),
                Some("x".into())
            ]
        );
        assert_eq!(rows[3][4], None);
    }

    #[test]
    fn numeric_and_bigint_as_text() {
        let dir = tempfile::tempdir().unwrap();
        let columns = vec![
            col("big", "bigint", ValueKind::Integer),
            col("amount", "numeric(12,2)", ValueKind::Decimal),
            col("whole", "numeric", ValueKind::Decimal),
            col("small", "integer", ValueKind::Integer),
            col("huge", "integer", ValueKind::Integer),
        ];
        let rows = vec![vec![
            num("5"),
            num("1.50"),
            num("12345678901234567890"),
            num("7"),
            num("9007199254740993"),
        ]];
        let (path, _) = write_book(
            dir.path(),
            "n.xlsx",
            "t",
            &columns,
            &[chunk(rows)],
            &ExportOptions::default(),
            None,
        );
        let data = sheet_data(&path, "t");
        assert_eq!(
            data[1],
            vec![
                Data::String("5".into()),
                Data::String("1.50".into()),
                Data::String("12345678901234567890".into()),
                Data::Float(7.0),
                Data::String("9007199254740993".into()),
            ]
        );
    }

    #[test]
    fn formula_like_text_stays_text() {
        let dir = tempfile::tempdir().unwrap();
        let columns = vec![col("v", "text", ValueKind::Text)];
        let values = ["=1+1", "00123", "1e5", "+31 6", "@SUM(A1)", "-2"];
        let rows = values.iter().map(|v| vec![text(v)]).collect();
        let (path, _) = write_book(
            dir.path(),
            "f.xlsx",
            "t",
            &columns,
            &[chunk(rows)],
            &ExportOptions::default(),
            None,
        );
        let data = sheet_data(&path, "t");
        let got: Vec<Data> = data[1..].iter().map(|r| r[0].clone()).collect();
        let want: Vec<Data> = values.iter().map(|v| Data::String(v.to_string())).collect();
        assert_eq!(got, want);
        let mut book: Xlsx<_> = open_workbook(&path).unwrap();
        let formulas = book.worksheet_formula("t").unwrap();
        assert!(formulas.used_cells().all(|(_, _, f)| f.is_empty()));
        let (_, rows) = read_all(&path, None);
        let got: Vec<String> = rows.into_iter().map(|r| r[0].clone().unwrap()).collect();
        assert_eq!(got, values);
    }

    #[test]
    fn cell_cut_count() {
        let dir = tempfile::tempdir().unwrap();
        let columns = vec![
            col("a", "text", ValueKind::Text),
            col("b", "text", ValueKind::Text),
        ];
        let long = "é".repeat(40_000);
        let exact = "y".repeat(CELL_CHARS);
        let rows = vec![
            vec![text(&long), text(&exact)],
            vec![text("short"), text(&long)],
        ];
        let (path, warnings) = write_book(
            dir.path(),
            "c.xlsx",
            "t",
            &columns,
            &[chunk(rows)],
            &ExportOptions::default(),
            None,
        );
        assert_eq!(
            warnings,
            vec!["2 cells were cut to 32,767 characters.".to_string()]
        );
        let (_, rows) = read_all(&path, None);
        assert_eq!(rows[0][0].as_ref().unwrap().chars().count(), CELL_CHARS);
        assert_eq!(rows[0][1].as_deref(), Some(exact.as_str()));
        assert_eq!(rows[1][1].as_ref().unwrap().chars().count(), CELL_CHARS);

        let one = vec![vec![text(&long), text("b")]];
        let (_, warnings) = write_book(
            dir.path(),
            "c1.xlsx",
            "t",
            &columns,
            &[chunk(one)],
            &ExportOptions::default(),
            None,
        );
        assert_eq!(
            warnings,
            vec!["1 cell was cut to 32,767 characters.".to_string()]
        );
    }

    #[test]
    fn sheet_split_with_small_limit() {
        let dir = tempfile::tempdir().unwrap();
        let columns = vec![col("id", "integer", ValueKind::Integer)];
        let rows: Vec<Vec<Value>> = (1..=25).map(|i| vec![num(&i.to_string())]).collect();
        let (path, _) = write_book(
            dir.path(),
            "s.xlsx",
            "t",
            &columns,
            &[chunk(rows[..12].to_vec()), chunk(rows[12..].to_vec())],
            &ExportOptions::default(),
            Some(10),
        );
        let book: Xlsx<_> = open_workbook(&path).unwrap();
        assert_eq!(book.sheet_names(), vec!["t", "t 2", "t 3"]);
        for (sheet, first, n) in [("t", 1, 10), ("t 2", 11, 10), ("t 3", 21, 5)] {
            let data = sheet_data(&path, sheet);
            assert_eq!(data[0], vec![Data::String("id".into())], "{sheet}");
            assert_eq!(data.len(), n + 1, "{sheet}");
            assert_eq!(data[1][0], Data::Float(first as f64), "{sheet}");
        }
        // Exactly the limit gives one sheet.
        let (path, _) = write_book(
            dir.path(),
            "s10.xlsx",
            "t",
            &columns,
            &[chunk(rows[..10].to_vec())],
            &ExportOptions::default(),
            Some(10),
        );
        let book: Xlsx<_> = open_workbook(&path).unwrap();
        assert_eq!(book.sheet_names(), vec!["t"]);
        let (_, back) = read_all(&path, Some("t"));
        assert_eq!(back.len(), 10);
    }

    #[test]
    #[ignore = "D18: 1,048,576 rows; run in the deferred checklist"]
    fn sheet_split_at_1048575() {
        let dir = tempfile::tempdir().unwrap();
        let columns = vec![col("id", "integer", ValueKind::Integer)];
        let target = dir.path().join("big.xlsx");
        let mut w = XlsxWriter::create(
            &target,
            false,
            &outside_data(),
            "t",
            &ExportOptions::default(),
        )
        .unwrap();
        w.write_header(&columns).unwrap();
        let total = SHEET_ROWS as u64 + 1;
        let mut n = 0u64;
        while n < total {
            let rows = (0..1000.min(total - n))
                .map(|i| vec![num(&(n + i + 1).to_string())])
                .collect::<Vec<_>>();
            n += rows.len() as u64;
            w.write_rows(&chunk(rows)).unwrap();
        }
        w.end().unwrap().commit().unwrap();
        let mut book: Xlsx<_> = open_workbook(&target).unwrap();
        assert_eq!(book.sheet_names(), vec!["t", "t 2"]);
        let second = book.worksheet_range("t 2").unwrap();
        assert_eq!(second.height(), 2);
        assert_eq!(second.get((1, 0)), Some(&Data::Float(total as f64)));
    }

    #[test]
    fn import_cap_rows_and_bytes() {
        assert_eq!(
            rows_cap_text(812_000, IMPORT_ROWS),
            "This workbook has 812,000 rows. Excel import takes up to 500,000; save it as CSV."
        );
        assert_eq!(
            bytes_cap_text(140 * 1024 * 1024, IMPORT_BYTES),
            "This workbook is 140 MB. Excel import takes up to 100 MB; save it as CSV."
        );
        // Just over the cap does not read as the cap itself.
        assert_eq!(
            bytes_cap_text(IMPORT_BYTES + 1, IMPORT_BYTES),
            "This workbook is 101 MB. Excel import takes up to 100 MB; save it as CSV."
        );
        assert_eq!(grouped(0), "0");
        assert_eq!(grouped(999), "999");
        assert_eq!(grouped(1_000), "1,000");
        assert_eq!(grouped(1_234_567), "1,234,567");

        let dir = tempfile::tempdir().unwrap();
        let columns = vec![col("id", "integer", ValueKind::Integer)];
        let rows: Vec<Vec<Value>> = (1..=30).map(|i| vec![num(&i.to_string())]).collect();
        let (path, _) = write_book(
            dir.path(),
            "cap.xlsx",
            "t",
            &columns,
            &[chunk(rows)],
            &ExportOptions::default(),
            None,
        );
        let bytes = std::fs::metadata(&path).unwrap().len();
        let open = |rows, cap_bytes| {
            XlsxReader::open_capped(
                &path,
                None,
                true,
                Caps {
                    rows,
                    bytes: cap_bytes,
                    ..Caps::import()
                },
            )
        };
        // The rows cap counts data rows, from the sheet's dimension.
        assert!(open(30, bytes).is_ok());
        match open(29, bytes) {
            Err(Error::File(m)) => assert_eq!(m, rows_cap_text(30, 29)),
            other => panic!("{:?}", other.map(|_| ())),
        }
        match open(1_000, bytes - 1) {
            Err(Error::File(m)) => assert_eq!(m, bytes_cap_text(bytes, bytes - 1)),
            other => panic!("{:?}", other.map(|_| ())),
        }
    }

    #[test]
    fn reader_numbers_and_dates_as_text() {
        use rust_xlsxwriter::{ExcelDateTime, Format as XFormat};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("typed.xlsx");
        let mut book = Workbook::new();
        let ws = book.add_worksheet();
        ws.set_name("Data").unwrap();
        let header = [
            "int", "float", "neg", "big", "date", "datetime", "time", "bool", "text",
        ];
        for (c, h) in header.iter().enumerate() {
            ws.write_string(0, c as u16, *h).unwrap();
        }
        let date = XFormat::new().set_num_format("yyyy-mm-dd");
        let datetime = XFormat::new().set_num_format("yyyy-mm-dd hh:mm:ss");
        let time = XFormat::new().set_num_format("hh:mm:ss");
        ws.write_number(1, 0, 7.0).unwrap();
        ws.write_number(1, 1, 1.25).unwrap();
        ws.write_number(1, 2, -0.1).unwrap();
        ws.write_number(1, 3, 1e20).unwrap();
        ws.write_datetime_with_format(1, 4, ExcelDateTime::from_ymd(2024, 1, 2).unwrap(), &date)
            .unwrap();
        ws.write_datetime_with_format(
            1,
            5,
            ExcelDateTime::from_ymd(2024, 1, 2)
                .unwrap()
                .and_hms(3, 4, 5)
                .unwrap(),
            &datetime,
        )
        .unwrap();
        ws.write_datetime_with_format(1, 6, ExcelDateTime::from_hms(12, 30, 0).unwrap(), &time)
            .unwrap();
        ws.write_boolean(1, 7, false).unwrap();
        ws.write_string(1, 8, "007").unwrap();
        // A row with gaps: missing cells are NULL.
        ws.write_number(2, 0, 3.0).unwrap();
        ws.write_string(2, 8, "last").unwrap();
        book.save(&path).unwrap();

        let (cols, rows) = read_all(&path, Some("Data"));
        assert_eq!(cols, header);
        assert_eq!(
            rows[0],
            vec![
                Some("7".into()),
                Some("1.25".into()),
                Some("-0.1".into()),
                Some("100000000000000000000".into()),
                Some("2024-01-02".into()),
                Some("2024-01-02T03:04:05".into()),
                Some("12:30:00".into()),
                Some("false".into()),
                Some("007".into()),
            ]
        );
        let mut gaps = vec![None; 9];
        gaps[0] = Some("3".into());
        gaps[8] = Some("last".into());
        assert_eq!(rows[1], gaps);
    }

    #[test]
    fn reader_header_rows_and_hash() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("h.xlsx");
        let mut book = Workbook::new();
        let ws = book.add_worksheet();
        ws.set_name("First").unwrap();
        ws.write_string(0, 0, "x").unwrap();
        let ws = book.add_worksheet();
        ws.set_name("Second").unwrap();
        // Header: blank, name, name (Review Focus 2).
        ws.write_string(0, 1, "name").unwrap();
        ws.write_string(0, 2, "name").unwrap();
        ws.write_number(1, 0, 1.0).unwrap();
        // Row 3 is empty and skipped; row 4 has a value.
        ws.write_string(3, 1, "b").unwrap();
        book.save(&path).unwrap();

        let mut r = XlsxReader::open(&path, Some("Second")).unwrap();
        assert_eq!(r.sheets(), ["First", "Second"]);
        assert_eq!(r.columns(), ["Column 1", "name", "name (2)"]);
        assert_eq!(r.sha256(), None);
        let a = r.next_record().unwrap().unwrap();
        assert_eq!((a.row, a.line), (1, 2));
        assert_eq!(a.values, vec![Some("1".into()), None, None]);
        let b = r.next_record().unwrap().unwrap();
        assert_eq!((b.row, b.line), (2, 4));
        assert_eq!(b.values, vec![None, Some("b".into()), None]);
        assert!(r.next_record().unwrap().is_none());
        let want = crate::jobs::paths::file_sha256(&path, &Default::default()).unwrap();
        assert_eq!(r.sha256(), Some(want));
        assert_eq!(r.bytes_read(), std::fs::metadata(&path).unwrap().len());

        // The first sheet by default; no header gives Column N and keeps row 1.
        let mut r = XlsxReader::open_with(&path, None, false).unwrap();
        assert_eq!(r.columns(), ["Column 1"]);
        let first = r.next_record().unwrap().unwrap();
        assert_eq!((first.row, first.line), (1, 1));
        assert_eq!(first.values, vec![Some("x".into())]);

        match XlsxReader::open(&path, Some("Nope")) {
            Err(Error::File(m)) => assert_eq!(m, "The workbook has no sheet named Nope."),
            other => panic!("{:?}", other.map(|_| ())),
        }
    }

    #[test]
    fn reader_value_past_the_header() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wide.xlsx");
        let mut book = Workbook::new();
        let ws = book.add_worksheet();
        ws.write_string(0, 0, "a").unwrap();
        ws.write_string(0, 1, "b").unwrap();
        ws.write_string(1, 0, "1").unwrap();
        ws.write_string(2, 3, "stray").unwrap();
        book.save(&path).unwrap();
        // The sheet's dimension reaches column D, so the header gets Column 3 and 4.
        let (cols, rows) = read_all(&path, None);
        assert_eq!(cols, ["a", "b", "Column 3", "Column 4"]);
        assert_eq!(rows[1][3].as_deref(), Some("stray"));
    }

    #[test]
    fn not_a_workbook_is_a_file_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.xlsx");
        std::fs::write(&path, b"PK\x03\x04 not really").unwrap();
        assert!(matches!(XlsxReader::open(&path, None), Err(Error::File(_))));
    }

    #[test]
    fn inspect_xlsx() {
        let dir = tempfile::tempdir().unwrap();
        let columns = vec![
            col("id", "integer", ValueKind::Integer),
            col("name", "text", ValueKind::Text),
        ];
        let rows: Vec<Vec<Value>> = (1..=30)
            .map(|i| vec![num(&i.to_string()), text(&format!("n{i}"))])
            .collect();
        let (path, _) = write_book(
            dir.path(),
            "menu.xlsx",
            "menu_items",
            &columns,
            &[chunk(rows)],
            &ExportOptions::default(),
            Some(20),
        );
        let s = inspect(&path, None).unwrap();
        assert_eq!(s.format, Format::Xlsx);
        assert_eq!(s.sheets, vec!["menu_items", "menu_items 2"]);
        assert_eq!(s.header, vec!["id", "name"]);
        assert_eq!(s.rows.len(), 20);
        assert_eq!(s.rows[19], vec![Some("20".into()), Some("n20".into())]);
        assert_eq!(
            s.rows_estimate,
            RowCount {
                rows: 20,
                exact: true
            }
        );
        assert_eq!(s.delimiter, None);
    }
}
