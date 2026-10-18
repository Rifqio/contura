//! CSV: RFC 4180 writer and a sniffing, streaming reader (Task 3).
//!
//! The reader is a small RFC 4180 parser of its own rather than the `csv` crate, because
//! D11 needs to know whether an empty field was quoted (`""` is empty text, an empty
//! unquoted field is NULL), and D12 needs the physical line each row starts on.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;

use super::{
    BOM, BUF_BYTES, Counting, FileRecord, FormatWriter, MAX_RECORD_BYTES, RecordReader,
    SAMPLE_BYTES, WriteSummary, header_names, read_err, read_head, value_text,
};
use crate::error::{Error, Result};
use crate::jobs::paths::{HashingReader, HeldFile, PartialWriter};
use crate::jobs::source::{Chunk, SourceColumn};
use crate::jobs::types::{Delimiter, ExportOptions, NullText};

/// A row with more values than this stops the read, so a row of bare delimiters stays
/// bounded.
pub const MAX_FIELDS: usize = 100_000;

pub fn delimiter_byte(d: Delimiter) -> u8 {
    match d {
        Delimiter::Comma => b',',
        Delimiter::Semicolon => b';',
        Delimiter::Tab => b'\t',
    }
}

/// RFC 4180 with CRLF line ends and an optional BOM. Empty text is written `""`, so it
/// stays apart from NULL (D11); with "The text NULL", text that reads `NULL` is quoted.
pub struct CsvWriter<W: Write + Send> {
    out: Counting<W>,
    opts: ExportOptions,
    delim: u8,
    line: Vec<u8>,
}

impl<W: Write + Send> CsvWriter<W> {
    pub fn new(out: W, opts: &ExportOptions) -> Self {
        Self {
            out: Counting::new(out),
            opts: opts.clone(),
            delim: delimiter_byte(opts.delimiter),
            line: Vec::with_capacity(1024),
        }
    }

    /// The BOM, when asked for, and the header line, when asked for.
    pub fn write_header(&mut self, columns: &[SourceColumn]) -> Result<()> {
        if self.opts.bom {
            self.out.put(BOM)?;
        }
        if self.opts.header {
            self.line.clear();
            for (i, c) in columns.iter().enumerate() {
                if i > 0 {
                    self.line.push(self.delim);
                }
                push_field(&mut self.line, self.delim, self.opts.null_as, Some(&c.name));
            }
            self.line.extend_from_slice(b"\r\n");
            let line = std::mem::take(&mut self.line);
            let done = self.out.put(&line);
            self.line = line;
            done?;
        }
        Ok(())
    }

    pub fn write_rows(&mut self, chunk: &Chunk) -> Result<()> {
        for row in &chunk.rows {
            self.line.clear();
            for (i, v) in row.iter().enumerate() {
                if i > 0 {
                    self.line.push(self.delim);
                }
                let text = value_text(v, &self.opts);
                push_field(
                    &mut self.line,
                    self.delim,
                    self.opts.null_as,
                    text.as_deref(),
                );
            }
            self.line.extend_from_slice(b"\r\n");
            let line = std::mem::take(&mut self.line);
            let done = self.out.put(&line);
            self.line = line;
            done?;
        }
        Ok(())
    }

    pub fn bytes(&self) -> u64 {
        self.out.bytes
    }

    /// Flushes and hands back the output.
    pub fn end(mut self) -> Result<W> {
        self.out.inner.flush().map_err(super::write_err)?;
        Ok(self.out.inner)
    }
}

impl FormatWriter for CsvWriter<PartialWriter> {
    fn begin(&mut self, columns: &[SourceColumn]) -> Result<()> {
        self.write_header(columns)
    }
    fn write_chunk(&mut self, chunk: &Chunk) -> Result<()> {
        self.write_rows(chunk)
    }
    fn summary(&self) -> WriteSummary {
        WriteSummary {
            bytes: self.bytes(),
            warnings: Vec::new(),
        }
    }
    fn finish(self: Box<Self>) -> Result<PartialWriter> {
        (*self).end()
    }
}

fn push_field(line: &mut Vec<u8>, delim: u8, null_as: NullText, text: Option<&str>) {
    let Some(s) = text else {
        if null_as == NullText::NullWord {
            line.extend_from_slice(b"NULL");
        }
        return;
    };
    let quote = s.is_empty()
        || (null_as == NullText::NullWord && s == "NULL")
        || s.bytes()
            .any(|b| b == delim || b == b'"' || b == b'\r' || b == b'\n');
    if !quote {
        line.extend_from_slice(s.as_bytes());
        return;
    }
    line.push(b'"');
    for b in s.bytes() {
        if b == b'"' {
            line.push(b'"');
        }
        line.push(b);
    }
    line.push(b'"');
}

/// The delimiter a sample of the file uses: the one that splits every line into the same
/// number of fields (the most fields wins), else the one seen on most lines; Comma when
/// nothing tells.
pub fn sniff(sample: &[u8]) -> Delimiter {
    let mut body = sample.strip_prefix(BOM).unwrap_or(sample);
    // A full sample may end inside a line; leave that line out.
    if body.len() >= SAMPLE_BYTES
        && let Some(end) = body.iter().rposition(|&b| b == b'\n')
    {
        body = &body[..end + 1];
    }
    let mut best = Delimiter::Comma;
    let mut best_score = (0u8, 0usize, 0usize);
    for d in [Delimiter::Comma, Delimiter::Semicolon, Delimiter::Tab] {
        let counts = counts_per_line(body, delimiter_byte(d));
        if counts.is_empty() {
            continue;
        }
        let first = counts[0];
        let score = if first > 0 && counts.iter().all(|&c| c == first) {
            (2, first, counts.len())
        } else {
            let hits = counts.iter().filter(|&&c| c > 0).count();
            (u8::from(hits > 0), hits, counts.iter().sum())
        };
        if score > best_score {
            best_score = score;
            best = d;
        }
    }
    best
}

/// Delimiters per record, outside quotes, for at most 100 nonblank records.
fn counts_per_line(body: &[u8], delim: u8) -> Vec<usize> {
    let mut counts = Vec::new();
    let mut quoted = false;
    let mut count = 0;
    let mut content = false;
    for &b in body {
        if b == b'"' {
            quoted = !quoted;
            content = true;
        } else if quoted {
        } else if b == b'\n' || b == b'\r' {
            if content {
                counts.push(count);
                if counts.len() == 100 {
                    return counts;
                }
            }
            count = 0;
            content = false;
        } else {
            content = true;
            if b == delim {
                count += 1;
            }
        }
    }
    if content {
        counts.push(count);
    }
    counts
}

/// One record as the parser found it; a field is None when it was empty and unquoted.
struct RawRecord {
    line: u64,
    fields: Vec<Option<Vec<u8>>>,
    /// The fields that were an unquoted `NULL` under the null word (Q31).
    nulls: Vec<usize>,
}

impl RawRecord {
    /// An empty line.
    fn blank(&self) -> bool {
        self.fields.len() == 1 && self.fields[0].is_none()
    }

    /// `empty_text`: an empty unquoted field is empty text (the import's `EmptyAs`), so a
    /// None from here is NULL alone.
    fn into_values(self, empty_text: bool) -> Result<Vec<Option<String>>> {
        // Line ends inside quoted fields move the line on; the error names the bad byte's.
        let mut line = self.line;
        let mut values = Vec::with_capacity(self.fields.len());
        // `nulls` is in field order.
        let mut nulls = self.nulls.iter().peekable();
        for (i, field) in self.fields.into_iter().enumerate() {
            let Some(bytes) = field else {
                values.push(empty_text.then(String::new));
                continue;
            };
            if nulls.next_if(|&&n| n == i).is_some() {
                line += line_ends(&bytes);
                values.push(None);
                continue;
            }
            match String::from_utf8(bytes) {
                Ok(text) => {
                    line += line_ends(text.as_bytes());
                    values.push(Some(text));
                }
                Err(e) => {
                    let good = e.utf8_error().valid_up_to();
                    let at = line + line_ends(&e.as_bytes()[..good]);
                    return Err(Error::File(format!(
                        "Line {at} is not UTF-8. Save the file as UTF-8."
                    )));
                }
            }
        }
        Ok(values)
    }
}

/// LF, CRLF and a lone CR each end one line.
fn line_ends(bytes: &[u8]) -> u64 {
    let mut n = 0;
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'\n' || (b == b'\r' && bytes.get(i + 1) != Some(&b'\n')) {
            n += 1;
        }
    }
    n
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    /// Before the first byte of a field.
    Start,
    Unquoted,
    Quoted,
    /// After a quote inside a quoted field: a second quote, a delimiter or a line end.
    QuoteEnd,
}

/// A resumable RFC 4180 parser that counts physical lines (LF, CRLF or a lone CR).
struct Parser {
    delim: u8,
    /// The line of the next byte, from 1.
    line: u64,
    consumed: u64,
    prev_cr: bool,
    /// A record ended on CR: a LF right after it belongs to that line end.
    skip_lf: bool,
    /// "Read the text NULL as NULL" (Q31), for data rows only.
    null_word: bool,
}

impl Parser {
    fn read_record<R: BufRead>(&mut self, src: &mut R) -> Result<Option<RawRecord>> {
        let mut fields: Vec<Option<Vec<u8>>> = Vec::new();
        let mut nulls: Vec<usize> = Vec::new();
        let mut cur: Vec<u8> = Vec::new();
        let mut state = State::Start;
        let mut start_line = 0;
        let mut seen = false;
        let mut size = 0usize;
        loop {
            let buf = src.fill_buf().map_err(|e| read_err(None, e))?;
            if buf.is_empty() {
                if !seen {
                    return Ok(None);
                }
                if state == State::Quoted {
                    return Err(Error::File(format!(
                        "Line {start_line}: a quoted value is not closed."
                    )));
                }
                end_field(&mut fields, &mut nulls, &mut cur, state, self.null_word);
                return Ok(Some(RawRecord {
                    line: start_line,
                    fields,
                    nulls,
                }));
            }
            let mut used = 0;
            let mut finished = false;
            for &b in buf {
                used += 1;
                let at = self.line;
                let skip = self.skip_lf && b == b'\n';
                self.skip_lf = false;
                match b {
                    b'\r' => {
                        self.line += 1;
                        self.prev_cr = true;
                    }
                    b'\n' => {
                        if !self.prev_cr {
                            self.line += 1;
                        }
                        self.prev_cr = false;
                    }
                    _ => self.prev_cr = false,
                }
                if !seen {
                    if skip {
                        continue;
                    }
                    seen = true;
                    start_line = at;
                }
                size += 1;
                if size > MAX_RECORD_BYTES {
                    return Err(Error::File(format!(
                        "Line {start_line}: one row is larger than 16 MB."
                    )));
                }
                let line_end = b == b'\r' || b == b'\n';
                match state {
                    State::Quoted => {
                        if b == b'"' {
                            state = State::QuoteEnd;
                        } else {
                            cur.push(b);
                        }
                    }
                    State::QuoteEnd if b == b'"' => {
                        cur.push(b'"');
                        state = State::Quoted;
                    }
                    State::Start if b == b'"' => state = State::Quoted,
                    _ if b == self.delim => {
                        end_field(&mut fields, &mut nulls, &mut cur, state, self.null_word);
                        state = State::Start;
                        if fields.len() >= MAX_FIELDS {
                            return Err(Error::File(format!(
                                "Line {start_line} has more than 100,000 values."
                            )));
                        }
                    }
                    _ if line_end => {
                        end_field(&mut fields, &mut nulls, &mut cur, state, self.null_word);
                        self.skip_lf = b == b'\r';
                        finished = true;
                        break;
                    }
                    // Text after a closing quote is kept, as most readers do.
                    _ => {
                        cur.push(b);
                        state = State::Unquoted;
                    }
                }
            }
            src.consume(used);
            self.consumed += used as u64;
            if finished {
                return Ok(Some(RawRecord {
                    line: start_line,
                    fields,
                    nulls,
                }));
            }
        }
    }
}

/// Ends a field: an empty unquoted one is None (D11). With `null_word` (Q31) an unquoted
/// `NULL` is noted in `nulls`, and becomes None in `into_values`; a quoted `"NULL"` stays
/// text (Q42 I2). A line holding only NULL is still a row, not a blank line.
fn end_field(
    fields: &mut Vec<Option<Vec<u8>>>,
    nulls: &mut Vec<usize>,
    cur: &mut Vec<u8>,
    state: State,
    null_word: bool,
) {
    if null_word && state == State::Unquoted && cur == b"NULL" {
        nulls.push(fields.len());
    }
    if state == State::Start {
        fields.push(None);
    } else {
        fields.push(Some(std::mem::take(cur)));
    }
}

/// Streams a CSV file through a 64 KB buffer and `HashingReader`. Only UTF-8 (with or
/// without a BOM) is read; rows with a different number of values stop the read.
pub struct CsvReader {
    src: BufReader<HashingReader<Box<dyn Read + Send>>>,
    parser: Parser,
    delimiter: Delimiter,
    header: bool,
    columns: Vec<String>,
    /// The first line, when it is data (no header).
    pending: Option<RawRecord>,
    /// Blank lines in a one-column file: the first one's line and how many. They become
    /// rows of one empty cell only when a row follows, so blank lines at the end are not
    /// rows.
    blanks: Option<(u64, u64)>,
    row: u64,
    eof: bool,
    /// An empty unquoted field in a data row is empty text, not None.
    empty_text: bool,
}

impl CsvReader {
    /// `delimiter: None` sniffs it from the first 64 KB.
    pub fn open(path: &Path, delimiter: Option<Delimiter>, header: bool) -> Result<CsvReader> {
        Self::open_with(path, delimiter, header, false, false)
    }

    /// As `open`, with the import's NULL rules for data rows (the header is read as it
    /// is). `null_word`: an unquoted `NULL` is None (Q31); a quoted `"NULL"` stays text (Q42
    /// I2). `empty_text`: an unquoted empty field is empty text, so None means NULL alone and
    /// "An empty cell means" never turns a NULL word into text.
    pub fn open_with(
        path: &Path,
        delimiter: Option<Delimiter>,
        header: bool,
        null_word: bool,
        empty_text: bool,
    ) -> Result<CsvReader> {
        let delimiter = match delimiter {
            Some(d) => d,
            None => sniff(&read_head(path)?),
        };
        let file = File::open(path).map_err(|e| read_err(Some(path), e))?;
        Self::from_source(
            path,
            Box::new(file),
            delimiter,
            header,
            null_word,
            empty_text,
        )
    }

    /// As `open_with`, reading the held import file through its own handle, up to the
    /// size it had when it opened (Q45).
    pub fn open_held(
        held: &HeldFile,
        delimiter: Option<Delimiter>,
        header: bool,
        null_word: bool,
        empty_text: bool,
    ) -> Result<CsvReader> {
        let path = held.path();
        let delimiter = match delimiter {
            Some(d) => d,
            None => {
                let mut head = Vec::with_capacity(SAMPLE_BYTES);
                held.reader()
                    .take(SAMPLE_BYTES as u64)
                    .read_to_end(&mut head)
                    .map_err(|e| read_err(Some(path), e))?;
                sniff(&head)
            }
        };
        let file = held.reader();
        Self::from_source(
            path,
            Box::new(file),
            delimiter,
            header,
            null_word,
            empty_text,
        )
    }

    fn from_source(
        path: &Path,
        file: Box<dyn Read + Send>,
        delimiter: Delimiter,
        header: bool,
        null_word: bool,
        empty_text: bool,
    ) -> Result<CsvReader> {
        let mut src = BufReader::with_capacity(BUF_BYTES, HashingReader::new(file));
        let mut consumed = 0;
        let head = src.fill_buf().map_err(|e| read_err(Some(path), e))?;
        if head.starts_with(BOM) {
            src.consume(BOM.len());
            consumed = BOM.len() as u64;
        }
        let mut reader = CsvReader {
            src,
            parser: Parser {
                delim: delimiter_byte(delimiter),
                line: 1,
                consumed,
                prev_cr: false,
                skip_lf: false,
                // Without a header the first row is data too.
                null_word: null_word && !header,
            },
            delimiter,
            header,
            columns: Vec::new(),
            pending: None,
            blanks: None,
            row: 0,
            eof: false,
            empty_text,
        };
        let first = loop {
            match reader.parser.read_record(&mut reader.src)? {
                Some(r) if r.blank() => continue,
                Some(r) => break Some(r),
                None => {
                    reader.eof = true;
                    break None;
                }
            }
        };
        if let Some(first) = first {
            if header {
                let names = first
                    .into_values(false)?
                    .into_iter()
                    .map(Option::unwrap_or_default)
                    .collect();
                reader.columns = header_names(names);
            } else {
                reader.columns = (1..=first.fields.len())
                    .map(|i| format!("Column {i}"))
                    .collect();
                reader.pending = Some(first);
            }
        }
        reader.parser.null_word = null_word;
        Ok(reader)
    }

    pub fn delimiter(&self) -> Delimiter {
        self.delimiter
    }
}

impl RecordReader for CsvReader {
    fn columns(&self) -> &[String] {
        &self.columns
    }

    fn next_record(&mut self) -> Result<Option<FileRecord>> {
        loop {
            if self.pending.is_some()
                && let Some((line, count)) = self.blanks
            {
                self.blanks = (count > 1).then_some((line + 1, count - 1));
                self.row += 1;
                // A blank line is one empty cell: it follows "An empty cell means" (D11).
                let empty = self.empty_text.then(String::new);
                return Ok(Some(FileRecord {
                    row: self.row,
                    line,
                    values: vec![empty],
                }));
            }
            let raw = match self.pending.take() {
                Some(r) => r,
                None if self.eof => return Ok(None),
                None => match self.parser.read_record(&mut self.src)? {
                    Some(r) => r,
                    None => {
                        self.eof = true;
                        self.blanks = None;
                        return Ok(None);
                    }
                },
            };
            // An empty line is a row of one empty cell in a one-column file, and skipped
            // otherwise.
            if raw.blank() {
                if self.columns.len() == 1 {
                    match &mut self.blanks {
                        Some((_, count)) => *count += 1,
                        None => self.blanks = Some((raw.line, 1)),
                    }
                }
                continue;
            }
            if self.blanks.is_some() {
                self.pending = Some(raw);
                continue;
            }
            if raw.fields.len() != self.columns.len() {
                let of = if self.header {
                    "the header has"
                } else {
                    "the first row has"
                };
                return Err(Error::File(format!(
                    "Line {} has {} values; {of} {}.",
                    raw.line,
                    raw.fields.len(),
                    self.columns.len()
                )));
            }
            self.row += 1;
            let line = raw.line;
            return Ok(Some(FileRecord {
                row: self.row,
                line,
                values: raw.into_values(self.empty_text)?,
            }));
        }
    }

    fn bytes_read(&self) -> u64 {
        self.parser.consumed
    }

    fn warnings(&mut self) -> Vec<String> {
        Vec::new()
    }

    fn sha256(&self) -> Option<[u8; 32]> {
        self.eof.then(|| self.src.get_ref().digest())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;
    use crate::jobs::paths::{PartialFile, PathUse, outside_data};
    use crate::jobs::source::{Value, ValueKind};
    use crate::jobs::types::NullText;

    fn cols(names: &[&str]) -> Vec<SourceColumn> {
        names
            .iter()
            .map(|n| SourceColumn {
                name: n.to_string(),
                type_name: "text".into(),
                kind: ValueKind::Text,
            })
            .collect()
    }

    fn write_csv(names: &[&str], rows: Vec<Vec<Value>>, opts: &ExportOptions) -> Vec<u8> {
        let mut w = CsvWriter::new(Vec::new(), opts);
        w.write_header(&cols(names)).unwrap();
        w.write_rows(&Chunk { rows, bytes: 0 }).unwrap();
        w.end().unwrap()
    }

    fn file(body: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("in.csv");
        std::fs::write(&p, body).unwrap();
        (dir, p)
    }

    fn read_all(
        body: &[u8],
        delimiter: Option<Delimiter>,
        header: bool,
    ) -> Result<(Vec<String>, Vec<FileRecord>)> {
        let (_dir, p) = file(body);
        let mut r = CsvReader::open(&p, delimiter, header)?;
        let mut out = Vec::new();
        while let Some(rec) = r.next_record()? {
            out.push(rec);
        }
        Ok((r.columns().to_vec(), out))
    }

    fn values(recs: &[FileRecord]) -> Vec<Vec<Option<String>>> {
        recs.iter().map(|r| r.values.clone()).collect()
    }

    fn s(v: &str) -> Option<String> {
        Some(v.to_string())
    }

    fn file_msg(r: Result<(Vec<String>, Vec<FileRecord>)>) -> String {
        match r {
            Err(Error::File(m)) => m,
            other => panic!("expected a file error, got {other:?}"),
        }
    }

    #[test]
    fn quotes_delimiters_quotes_and_line_breaks() {
        let semi = ExportOptions {
            delimiter: Delimiter::Semicolon,
            ..ExportOptions::default()
        };
        let tab = ExportOptions {
            delimiter: Delimiter::Tab,
            ..ExportOptions::default()
        };
        let comma = ExportOptions::default();
        let cases: Vec<(&ExportOptions, &str, &str)> = vec![
            (&comma, "plain", "plain"),
            (&comma, "a,b", "\"a,b\""),
            (&comma, "say \"hi\"", "\"say \"\"hi\"\"\""),
            (&comma, "l1\nl2", "\"l1\nl2\""),
            (&comma, "l1\r\nl2", "\"l1\r\nl2\""),
            (&comma, "a;b", "a;b"),
            (&semi, "a;b", "\"a;b\""),
            (&semi, "a,b", "a,b"),
            (&tab, "a\tb", "\"a\tb\""),
        ];
        for (opts, text, want) in cases {
            let out = write_csv(
                &["c", "d"],
                vec![vec![Value::Text(text.into()), Value::Text("z".into())]],
                opts,
            );
            let sep = match opts.delimiter {
                Delimiter::Comma => ",",
                Delimiter::Semicolon => ";",
                Delimiter::Tab => "\t",
            };
            let expected = format!("c{sep}d\r\n{want}{sep}z\r\n");
            assert_eq!(
                String::from_utf8(out.clone()).unwrap(),
                expected,
                "{text:?}"
            );
            // And it reads back as it was written.
            let (_, recs) = read_all(&out, Some(opts.delimiter), true).unwrap();
            assert_eq!(values(&recs), vec![vec![s(text), s("z")]], "{text:?}");
        }
    }

    #[test]
    fn null_as_empty_cell_and_null_word() {
        let word = ExportOptions {
            null_as: NullText::NullWord,
            ..ExportOptions::default()
        };
        let empty = ExportOptions::default();
        let row = || {
            vec![vec![
                Value::Null,
                Value::Text("x".into()),
                Value::Text("NULL".into()),
            ]]
        };
        let cases: Vec<(&ExportOptions, &str)> = vec![
            (&empty, "a,b,c\r\n,x,NULL\r\n"),
            (&word, "a,b,c\r\nNULL,x,\"NULL\"\r\n"),
        ];
        for (opts, want) in cases {
            let out = write_csv(&["a", "b", "c"], row(), opts);
            assert_eq!(String::from_utf8(out).unwrap(), want);
        }
        let (_, recs) = read_all(b"a,b,c\r\n,x,NULL\r\n", None, true).unwrap();
        assert_eq!(values(&recs), vec![vec![None, s("x"), s("NULL")]]);
    }

    /// Q31, Q42 I2: with "Read the text NULL as NULL", only an unquoted NULL is NULL; a
    /// quoted "NULL" stays text, so the NULL-word export reads back as it was written.
    #[test]
    fn null_word_is_unquoted_only() {
        let (_dir, p) = file(b"NULL,b\nNULL,\"NULL\"\n\"NULL\",NULL\n");
        let mut r = CsvReader::open_with(&p, None, true, true, false).unwrap();
        // The header is never read as NULL.
        assert_eq!(r.columns(), ["NULL", "b"]);
        let mut got = Vec::new();
        while let Some(rec) = r.next_record().unwrap() {
            got.push(rec.values);
        }
        assert_eq!(got, vec![vec![None, s("NULL")], vec![s("NULL"), None]]);
        // Without a header the first row is data.
        let (_dir, p) = file(b"NULL,x\n");
        let mut r = CsvReader::open_with(&p, None, false, true, false).unwrap();
        assert_eq!(r.next_record().unwrap().unwrap().values, vec![None, s("x")]);
        // With empty cells read as empty text, NULL stays NULL and the empty cell is text.
        let (_dir, p) = file(b"a,b\nNULL,\n");
        let mut r = CsvReader::open_with(&p, None, true, true, true).unwrap();
        assert_eq!(r.next_record().unwrap().unwrap().values, vec![None, s("")]);
        // Off, it is text.
        let (_dir, p) = file(b"a\nNULL\n");
        let mut r = CsvReader::open(&p, None, true).unwrap();
        assert_eq!(r.next_record().unwrap().unwrap().values, vec![s("NULL")]);
    }

    #[test]
    fn empty_text_is_quoted_empty() {
        let out = write_csv(
            &["a", "b"],
            vec![vec![Value::Text("".into()), Value::Null]],
            &ExportOptions::default(),
        );
        assert_eq!(out, b"a,b\r\n\"\",\r\n");
        let cases: Vec<(&[u8], Vec<Option<String>>)> = vec![
            (b"a,b\n\"\",\n", vec![s(""), None]),
            (b"a,b\n,\"\"\n", vec![None, s("")]),
            (b"a,b\n,\n", vec![None, None]),
            (b"a,b\n\"\",\"\"", vec![s(""), s("")]),
        ];
        for (body, want) in cases {
            let (_, recs) = read_all(body, None, true).unwrap();
            assert_eq!(values(&recs), vec![want]);
        }
    }

    #[test]
    fn bom_in_and_out() {
        let with = ExportOptions {
            bom: true,
            ..ExportOptions::default()
        };
        let out = write_csv(&["id"], vec![vec![Value::Number("1".into())]], &with);
        assert_eq!(out, b"\xEF\xBB\xBFid\r\n1\r\n");
        let out = write_csv(&["id"], vec![], &ExportOptions::default());
        assert_eq!(out, b"id\r\n");
        let (columns, recs) = read_all(b"\xEF\xBB\xBFid,name\r\n1,a\r\n", None, true).unwrap();
        assert_eq!(columns, vec!["id", "name"]);
        assert_eq!(values(&recs), vec![vec![s("1"), s("a")]]);
        let (_dir, p) = file(b"\xEF\xBB\xBFid\r\n1\r\n");
        assert_eq!(
            super::super::inspect(&p, None).unwrap().encoding,
            "UTF-8 with BOM"
        );
    }

    #[test]
    fn sniffs_comma_semicolon_tab() {
        let cases: Vec<(&[u8], Delimiter)> = vec![
            (b"a,b,c\n1,2,3\n", Delimiter::Comma),
            (b"a;b;c\n1;2,5;3\n4;5;6\n", Delimiter::Semicolon),
            (b"a\tb\n1\t2\n", Delimiter::Tab),
            (b"\"x;y\",b\n\"1;2;3\",2\n", Delimiter::Comma),
            (b"\xEF\xBB\xBFa;b\r\n1;2\r\n", Delimiter::Semicolon),
            (b"single\n1\n", Delimiter::Comma),
            (b"", Delimiter::Comma),
        ];
        for (sample, want) in cases {
            assert_eq!(sniff(sample), want, "{}", String::from_utf8_lossy(sample));
        }
        let (columns, recs) = read_all(b"a;b\n1;2\n", None, true).unwrap();
        assert_eq!(columns, vec!["a", "b"]);
        assert_eq!(values(&recs), vec![vec![s("1"), s("2")]]);
    }

    #[test]
    fn crlf_and_lf_input() {
        let cases: Vec<&[u8]> = vec![
            b"a,b\r\n1,2\r\n3,4\r\n",
            b"a,b\n1,2\n3,4\n",
            b"a,b\r\n1,2\n3,4\r\n",
            b"a,b\r1,2\r3,4\r",
        ];
        for body in cases {
            let (columns, recs) = read_all(body, None, true).unwrap();
            assert_eq!(columns, vec!["a", "b"]);
            assert_eq!(
                values(&recs),
                vec![vec![s("1"), s("2")], vec![s("3"), s("4")]]
            );
            let lines: Vec<(u64, u64)> = recs.iter().map(|r| (r.row, r.line)).collect();
            assert_eq!(
                lines,
                vec![(1, 2), (2, 3)],
                "{}",
                String::from_utf8_lossy(body)
            );
        }
        // A line break inside quotes moves the next row's line on (D12).
        let (_, recs) = read_all(b"a,b\r\n\"x\r\ny\",1\r\n2,3\r\n", None, true).unwrap();
        assert_eq!(recs[0].values[0], s("x\r\ny"));
        assert_eq!((recs[1].row, recs[1].line), (2, 4));
    }

    #[test]
    fn no_final_newline() {
        let cases: Vec<(&[u8], Vec<Option<String>>)> = vec![
            (b"a,b\n1,2", vec![s("1"), s("2")]),
            (b"a,b\n1,\"two\"", vec![s("1"), s("two")]),
            (b"a,b\n1,", vec![s("1"), None]),
        ];
        for (body, want) in cases {
            let (_, recs) = read_all(body, None, true).unwrap();
            assert_eq!(values(&recs), vec![want]);
        }
        let msg = file_msg(read_all(b"a,b\n1,\"open", None, true));
        assert_eq!(msg, "Line 2: a quoted value is not closed.");
    }

    #[test]
    fn ragged_row_names_line() {
        let cases: Vec<(&[u8], bool, &str)> = vec![
            (
                b"a,b\n1,2\n\"multi\nline\",3\n1,2,3\n",
                true,
                "Line 5 has 3 values; the header has 2.",
            ),
            (
                b"a,b,c,d,e,f\n1,2,3,4,5,6\n1,2\n",
                true,
                "Line 3 has 2 values; the header has 6.",
            ),
            (
                b"1,2\n3,4,5\n",
                false,
                "Line 2 has 3 values; the first row has 2.",
            ),
        ];
        for (body, header, want) in cases {
            assert_eq!(file_msg(read_all(body, None, header)), want);
        }
        // Blank lines are skipped, not ragged.
        let (_, recs) = read_all(b"a,b\n1,2\n\n3,4\n", None, true).unwrap();
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[1].line, 4);
    }

    #[test]
    fn not_utf8_refused() {
        let msg = file_msg(read_all(b"a,b\n1,2\n\xff\xfe,3\n", None, true));
        assert_eq!(msg, "Line 3 is not UTF-8. Save the file as UTF-8.");
        let msg = file_msg(read_all(b"\xff\xfea\x00,\x00b\x00\n", None, true));
        assert_eq!(msg, "Line 1 is not UTF-8. Save the file as UTF-8.");
        // The line of the bad byte, not of the row's start.
        let msg = file_msg(read_all(b"a,b\n\"x\ny\",\"p\r\nq\xff\"\n", None, true));
        assert_eq!(msg, "Line 4 is not UTF-8. Save the file as UTF-8.");
    }

    #[test]
    fn row_over_16mb_is_refused_and_a_long_field_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("big.csv");
        let mut body = b"a,b\n1,2\n".to_vec();
        body.extend(std::iter::repeat_n(b'x', 17 * 1024 * 1024));
        body.extend_from_slice(b",3\n");
        std::fs::write(&p, &body).unwrap();
        drop(body);
        let mut r = CsvReader::open(&p, Some(Delimiter::Comma), true).unwrap();
        assert!(r.next_record().unwrap().is_some());
        match r.next_record() {
            Err(Error::File(m)) => assert_eq!(m, "Line 3: one row is larger than 16 MB."),
            other => panic!("{other:?}"),
        }
        let long = "y".repeat(8 * 1024 * 1024);
        let (_, recs) = read_all(format!("a\n\"{long}\"\n").as_bytes(), None, true).unwrap();
        assert_eq!(recs[0].values[0].as_deref(), Some(long.as_str()));
    }

    #[test]
    fn too_many_values_on_a_row_is_refused() {
        let mut body = b"a,b\n".to_vec();
        body.extend(std::iter::repeat_n(b',', MAX_FIELDS));
        body.push(b'\n');
        let msg = file_msg(read_all(&body, Some(Delimiter::Comma), true));
        assert_eq!(msg, "Line 2 has more than 100,000 values.");
    }

    #[test]
    fn one_column_blank_lines() {
        // A blank line between rows is a NULL; blank lines at the end are not rows.
        type Row = Vec<Option<String>>;
        let cases: Vec<(&[u8], bool, Row)> = vec![
            (b"a\n1\n\n2\n\n\n", true, vec![s("1"), None, s("2")]),
            (b"a\r\n1\r\n\r\n", true, vec![s("1")]),
            (b"\n\n1\n\n2\n", false, vec![s("1"), None, s("2")]),
        ];
        for (body, header, want) in cases {
            let (_, recs) = read_all(body, Some(Delimiter::Comma), header).unwrap();
            let got: Vec<Option<String>> = recs.iter().map(|r| r.values[0].clone()).collect();
            assert_eq!(got, want, "{}", String::from_utf8_lossy(body));
        }
        let (_, recs) = read_all(b"a\n1\n\n2\n", None, true).unwrap();
        let lines: Vec<(u64, u64)> = recs.iter().map(|r| (r.row, r.line)).collect();
        assert_eq!(lines, vec![(1, 2), (2, 3), (3, 4)]);
    }

    /// D11 (Q45): a blank line in a one-column file is an empty cell, so it follows "An
    /// empty cell means": NULL by default, empty text when the import says so.
    #[test]
    fn one_column_blank_line_follows_empty_cell_means() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("one.csv");
        std::fs::write(&p, b"a\n1\n\n2\n\n").unwrap();
        for (empty_text, blank) in [(false, None), (true, s(""))] {
            let mut r =
                CsvReader::open_with(&p, Some(Delimiter::Comma), true, false, empty_text).unwrap();
            let mut got = Vec::new();
            while let Some(rec) = r.next_record().unwrap() {
                got.push(rec.values[0].clone());
            }
            assert_eq!(got, vec![s("1"), blank, s("2")], "empty_text {empty_text}");
        }
    }

    #[test]
    fn non_finite_numbers_are_text() {
        for null_as in [NullText::EmptyCell, NullText::NullWord] {
            let opts = ExportOptions {
                null_as,
                ..ExportOptions::default()
            };
            let out = write_csv(
                &["a", "b", "c"],
                vec![vec![
                    Value::Number("NaN".into()),
                    Value::Number("Infinity".into()),
                    Value::Number("-Infinity".into()),
                ]],
                &opts,
            );
            assert_eq!(out, b"a,b,c\r\nNaN,Infinity,-Infinity\r\n");
        }
    }

    #[test]
    fn header_blank_and_duplicate_names() {
        let (columns, recs) = read_all(b",name,name\n1,2,3\n", None, true).unwrap();
        assert_eq!(columns, vec!["Column 1", "name", "name (2)"]);
        assert_eq!(values(&recs), vec![vec![s("1"), s("2"), s("3")]]);
        // Without a header, every column gets "Column N" and the first line is data.
        let (columns, recs) = read_all(b"1,2\n3,4\n", None, false).unwrap();
        assert_eq!(columns, vec!["Column 1", "Column 2"]);
        assert_eq!(
            recs.iter().map(|r| (r.row, r.line)).collect::<Vec<_>>(),
            vec![(1, 1), (2, 2)]
        );
    }

    #[test]
    fn header_only_and_empty_file() {
        use crate::jobs::types::RowCount;
        let cases: Vec<(&[u8], Vec<&str>)> = vec![
            (b"a,b\r\n", vec!["a", "b"]),
            (b"a,b", vec!["a", "b"]),
            (b"", vec![]),
        ];
        for (body, want) in cases {
            let (columns, recs) = read_all(body, None, true).unwrap();
            assert_eq!(columns, want);
            assert!(recs.is_empty());
            let (_dir, p) = file(body);
            let summary = super::super::inspect(&p, None).unwrap();
            assert_eq!(
                summary.rows_estimate,
                RowCount {
                    rows: 0,
                    exact: true
                }
            );
            assert!(summary.rows.is_empty());
        }
        // Zero rows written is the header line only.
        assert_eq!(
            write_csv(&["a", "b"], vec![], &ExportOptions::default()),
            b"a,b\r\n"
        );
        let no_header = ExportOptions {
            header: false,
            ..ExportOptions::default()
        };
        assert_eq!(write_csv(&["a", "b"], vec![], &no_header), b"");
    }

    #[test]
    fn sha256_after_eof() {
        use sha2::{Digest, Sha256};
        let body = b"a,b\n1,2\n3,4\n";
        let (_dir, p) = file(body);
        let mut r = CsvReader::open(&p, None, true).unwrap();
        assert_eq!(r.sha256(), None);
        while r.next_record().unwrap().is_some() {}
        let want: [u8; 32] = Sha256::digest(body).into();
        assert_eq!(r.sha256(), Some(want));
        assert_eq!(r.bytes_read(), body.len() as u64);
    }

    #[test]
    fn finished_writer_commits_and_dropped_writer_leaves_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("out.csv");
        let partial = PartialFile::create(&target, false, PathUse::Export, &outside_data())
            .unwrap()
            .writer();
        let mut w: Box<dyn FormatWriter> =
            Box::new(CsvWriter::new(partial, &ExportOptions::default()));
        w.begin(&cols(&["a", "b"])).unwrap();
        w.write_chunk(&Chunk {
            rows: vec![vec![Value::Number("1".into()), Value::Text("x".into())]],
            bytes: 2,
        })
        .unwrap();
        assert_eq!(w.summary().bytes, 10);
        let bytes = w.finish().unwrap().commit().unwrap();
        assert_eq!(bytes, 10);
        assert_eq!(std::fs::read(&target).unwrap(), b"a,b\r\n1,x\r\n");

        let target2 = dir.path().join("dropped.csv");
        let partial = PartialFile::create(&target2, false, PathUse::Export, &outside_data())
            .unwrap()
            .writer();
        let partial_path = partial.partial_path().to_path_buf();
        let mut w: Box<dyn FormatWriter> =
            Box::new(CsvWriter::new(partial, &ExportOptions::default()));
        w.begin(&cols(&["a"])).unwrap();
        drop(w);
        assert!(!target2.exists());
        assert!(!partial_path.exists());
    }
}
