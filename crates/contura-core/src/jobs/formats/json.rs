//! JSON: NDJSON and array writer, and a streaming reader.
//!
//! Values stay raw (`RawValue`) between the file and the record, so numbers keep their
//! exact digits without serde_json's `arbitrary_precision`.

use std::cell::Cell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};

use serde::de::{self, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::value::RawValue;

use super::{
    BOM, BUF_BYTES, Counting, FileRecord, FormatWriter, MAX_RECORD_BYTES, RecordReader,
    WriteSummary, header_names, read_err, value_text,
};
use crate::error::{Error, Result};
use crate::jobs::paths::{HashingReader, PartialWriter};
use crate::jobs::source::{Chunk, SourceColumn, Value, ValueKind};
use crate::jobs::types::{ExportOptions, JsonLayout};

/// The objects whose keys make the columns (D9).
const KEY_OBJECTS: usize = 1_000;
/// At most this many late-key warnings, so a file of ever new keys stays bounded.
const MAX_KEY_WARNINGS: usize = 100;

/// One object per line (NDJSON) or one array. Numbers keep their digits; NaN and
/// Infinity, which JSON has no number for, are strings. A JSON column whose text parses
/// is written as a JSON value, compacted onto one line.
pub struct JsonWriter<W: Write + Send> {
    out: Counting<W>,
    opts: ExportOptions,
    /// Each column's key, encoded, with its colon.
    keys: Vec<Vec<u8>>,
    json: Vec<bool>,
    rows: u64,
    line: Vec<u8>,
}

impl<W: Write + Send> JsonWriter<W> {
    pub fn new(out: W, opts: &ExportOptions) -> Self {
        Self {
            out: Counting::new(out),
            opts: opts.clone(),
            keys: Vec::new(),
            json: Vec::new(),
            rows: 0,
            line: Vec::with_capacity(1024),
        }
    }

    /// Takes the keys; an array opens with `[`.
    pub fn write_header(&mut self, columns: &[SourceColumn]) -> Result<()> {
        let names = header_names(columns.iter().map(|c| c.name.clone()).collect());
        self.keys = names
            .iter()
            .map(|n| {
                let mut k = Vec::with_capacity(n.len() + 3);
                push_string(&mut k, n);
                k.push(b':');
                k
            })
            .collect();
        self.json = columns.iter().map(|c| c.kind == ValueKind::Json).collect();
        if self.opts.json_layout == JsonLayout::Array {
            self.out.put(b"[")?;
        }
        Ok(())
    }

    pub fn write_rows(&mut self, chunk: &Chunk) -> Result<()> {
        let array = self.opts.json_layout == JsonLayout::Array;
        for row in &chunk.rows {
            if row.len() > self.keys.len() {
                return Err(Error::InvalidInput(format!(
                    "A row has {} values; the export has {} columns.",
                    row.len(),
                    self.keys.len()
                )));
            }
            self.line.clear();
            if array {
                self.line
                    .extend_from_slice(if self.rows == 0 { b"\n" } else { b",\n" });
            }
            self.line.push(b'{');
            for (i, v) in row.iter().enumerate() {
                if i > 0 {
                    self.line.push(b',');
                }
                self.line.extend_from_slice(&self.keys[i]);
                let json = self.json.get(i).copied().unwrap_or(false);
                push_value(&mut self.line, v, json, &self.opts);
            }
            self.line.push(b'}');
            if !array {
                self.line.push(b'\n');
            }
            let line = std::mem::take(&mut self.line);
            let done = self.out.put(&line);
            self.line = line;
            done?;
            self.rows += 1;
        }
        Ok(())
    }

    pub fn bytes(&self) -> u64 {
        self.out.bytes
    }

    /// Closes an array (`[]` when it holds no rows), flushes, and hands back the output.
    pub fn end(mut self) -> Result<W> {
        if self.opts.json_layout == JsonLayout::Array {
            let tail: &[u8] = if self.rows == 0 { b"]\n" } else { b"\n]\n" };
            self.out.put(tail)?;
        }
        self.out.inner.flush().map_err(super::write_err)?;
        Ok(self.out.inner)
    }
}

impl FormatWriter for JsonWriter<PartialWriter> {
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

fn push_value(line: &mut Vec<u8>, v: &Value, json: bool, opts: &ExportOptions) {
    match v {
        Value::Null => line.extend_from_slice(b"null"),
        Value::Bool(b) => line.extend_from_slice(if *b { b"true" } else { b"false" }),
        Value::Number(s) if is_json_number(s) => line.extend_from_slice(s.as_bytes()),
        // JSON `null` would read back as NULL; it stays the text "null".
        Value::Text(s)
            if json && s.trim() != "null" && serde_json::from_str::<&RawValue>(s).is_ok() =>
        {
            compact(s, line)
        }
        other => {
            let text = value_text(other, opts).unwrap_or_default();
            push_string(line, &text);
        }
    }
}

fn push_string(line: &mut Vec<u8>, s: &str) {
    // Writing to a Vec cannot fail.
    let _ = serde_json::to_writer(&mut *line, s);
}

/// JSON's number grammar: `-? (0 | [1-9][0-9]*) (. [0-9]+)? ([eE] [+-]? [0-9]+)?`.
fn is_json_number(s: &str) -> bool {
    let b = s.as_bytes();
    let digits = |i: &mut usize| {
        let start = *i;
        while b.get(*i).is_some_and(u8::is_ascii_digit) {
            *i += 1;
        }
        *i > start
    };
    let mut i = 0;
    if b.first() == Some(&b'-') {
        i += 1;
    }
    match b.get(i) {
        Some(b'0') => i += 1,
        Some(b'1'..=b'9') => {
            digits(&mut i);
        }
        _ => return false,
    }
    if b.get(i) == Some(&b'.') {
        i += 1;
        if !digits(&mut i) {
            return false;
        }
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        if !digits(&mut i) {
            return false;
        }
    }
    i == b.len()
}

/// Valid JSON text without the whitespace outside its strings; numbers stay as written.
fn compact(s: &str, out: &mut Vec<u8>) {
    let mut in_string = false;
    let mut escaped = false;
    for &b in s.as_bytes() {
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
        } else if b.is_ascii_whitespace() {
            continue;
        } else if b == b'"' {
            in_string = true;
        }
        out.push(b);
    }
}

/// A file value as record text: null is None, a string its text, a number its digits,
/// `true`/`false` as is, and a nested object or array compact JSON text (D9).
fn raw_text(raw: &RawValue) -> Result<Option<String>> {
    let s = raw.get().trim();
    Ok(match s.as_bytes().first() {
        None | Some(b'n') => None,
        Some(b'"') => Some(
            serde_json::from_str::<String>(s)
                .map_err(|e| Error::File(format!("cannot read a JSON string: {e}")))?,
        ),
        Some(b'{' | b'[') => {
            let mut out = Vec::with_capacity(s.len());
            compact(s, &mut out);
            Some(String::from_utf8(out).map_err(|e| Error::File(e.to_string()))?)
        }
        _ => Some(s.to_string()),
    })
}

/// One object, its keys in file order and its values raw.
struct Obj {
    line: u64,
    /// The bytes read once the object ended.
    end: u64,
    fields: Vec<(String, Box<RawValue>)>,
}

impl Obj {
    fn size(&self) -> usize {
        self.fields
            .iter()
            .map(|(k, v)| k.len() + v.get().len())
            .sum()
    }
}

type Fields = Vec<(String, Box<RawValue>)>;

/// Reads one object; `line` is the line its `{` is on when the visitor starts.
struct ObjSeed<'a> {
    line: &'a Cell<u64>,
    /// Told the line of the `{` as soon as it is seen.
    started: Option<&'a Cell<Option<u64>>>,
}

impl<'de> DeserializeSeed<'de> for ObjSeed<'_> {
    type Value = (u64, Fields);
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> std::result::Result<Self::Value, D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for ObjSeed<'_> {
    type Value = (u64, Fields);
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a JSON object")
    }
    fn visit_map<A: MapAccess<'de>>(
        self,
        mut map: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let line = self.line.get();
        if let Some(started) = self.started {
            started.set(Some(line));
        }
        let mut fields = Vec::new();
        while let Some(key) = map.next_key::<String>()? {
            let value: Box<RawValue> = map.next_value()?;
            fields.push((key, value));
        }
        Ok((line, fields))
    }
}

/// "Line 3, column 14: <serde message>." with the line counted from `base`.
fn position_error(e: &serde_json::Error, base: u64) -> Error {
    if e.line() == 0 {
        return Error::File(format!("cannot read the file: {e}"));
    }
    let line = base + e.line() as u64 - 1;
    let text = e.to_string();
    let suffix = format!(" at line {} column {}", e.line(), e.column());
    let message = text.strip_suffix(&suffix).unwrap_or(&text);
    Error::File(format!("Line {line}, column {}: {message}.", e.column()))
}

type Source = BufReader<HashingReader<Box<dyn Read + Send>>>;

/// NDJSON: one object per line; blank lines are skipped.
struct Lines {
    src: Source,
    /// The line of the next line read.
    line: u64,
    consumed: u64,
    buf: Vec<u8>,
}

impl Lines {
    fn next_obj(&mut self) -> Result<Option<Obj>> {
        loop {
            self.buf.clear();
            let line = self.line;
            let n = self.read_line(line)?;
            if n == 0 {
                return Ok(None);
            }
            self.line += 1;
            self.consumed += n as u64;
            if self.buf.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let at = Cell::new(line);
            let mut de = serde_json::Deserializer::from_slice(&self.buf);
            let parsed = ObjSeed {
                line: &at,
                started: None,
            }
            .deserialize(&mut de)
            .and_then(|v| de.end().map(|()| v));
            return match parsed {
                Ok((line, fields)) => Ok(Some(Obj {
                    line,
                    end: self.consumed,
                    fields,
                })),
                // One pretty-printed object: say what the reader takes.
                Err(e) if e.is_eof() && self.buf.trim_ascii_start().starts_with(b"{") => {
                    Err(Error::File(format!(
                        "Line {line}: the object goes on past this line. Import takes one object per line, or an array of objects."
                    )))
                }
                Err(e) => Err(position_error(&e, line)),
            };
        }
    }

    /// One line into `buf`, newline included; 0 at the end of the file.
    fn read_line(&mut self, line: u64) -> Result<usize> {
        let mut total = 0;
        loop {
            let buf = self.src.fill_buf().map_err(|e| read_err(None, e))?;
            if buf.is_empty() {
                return Ok(total);
            }
            let (take, done) = match buf.iter().position(|&b| b == b'\n') {
                Some(i) => (i + 1, true),
                None => (buf.len(), false),
            };
            if self.buf.len() + take > MAX_RECORD_BYTES {
                return Err(Error::File(format!(
                    "Line {line}: one object is larger than 16 MB."
                )));
            }
            self.buf.extend_from_slice(&buf[..take]);
            self.src.consume(take);
            total += take;
            if done {
                return Ok(total);
            }
        }
    }
}

/// The array thread sends objects in batches of about this many bytes, so the reader
/// and the thread do not hand over every object one by one.
const BATCH_BYTES: usize = 64 * 1024;
const BATCH_OBJECTS: usize = 256;

enum Msg {
    /// Objects and their size.
    Objs(Vec<Obj>, usize),
    Fail(Error),
    /// The file's hash and size.
    End(Option<[u8; 32]>, u64),
}

/// What the array thread knows about its position. serde_json reads a byte at a time,
/// so the counts are exact.
struct Track {
    /// The line of the next byte.
    line: Cell<u64>,
    /// The bytes read so far.
    bytes: Cell<u64>,
    /// `bytes` when the current element began; one element may not pass 16 MB.
    mark: Cell<u64>,
    /// The line of the current element's `{`, once it is seen.
    element_line: Cell<Option<u64>>,
    /// The line where the element started that passed 16 MB.
    too_large: Cell<Option<u64>>,
    /// The file's hash, taken at the end.
    digest: Cell<Option<[u8; 32]>>,
}

/// What serde_json reads through: it counts lines and bytes, stops an element past
/// 16 MB before it is held whole, stops when the reader is dropped, and takes the
/// file's hash at the end.
struct Counted {
    inner: Source,
    track: Rc<Track>,
    stop: Arc<AtomicBool>,
}

impl Counted {
    fn counted(&self, n: u64) -> std::io::Result<()> {
        let t = &self.track;
        let bytes = t.bytes.get() + n;
        t.bytes.set(bytes);
        if bytes - t.mark.get() > MAX_RECORD_BYTES as u64 {
            let line = t.element_line.get().unwrap_or(t.line.get());
            t.too_large.set(Some(line));
            return Err(std::io::Error::other("one object is larger than 16 MB"));
        }
        // Checked every 64 KB, so a dropped reader frees the file soon.
        if bytes.is_multiple_of(64 * 1024) && self.stop.load(Ordering::Relaxed) {
            return Err(std::io::Error::other("stopped"));
        }
        Ok(())
    }
}

impl Read for Counted {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        // serde_json asks for one byte at a time: take it straight from the buffer.
        if buf.len() == 1
            && let Some(&b) = self.inner.buffer().first()
        {
            buf[0] = b;
            self.inner.consume(1);
            if b == b'\n' {
                self.track.line.set(self.track.line.get() + 1);
            }
            self.counted(1)?;
            return Ok(1);
        }
        let n = self.inner.read(buf)?;
        if n == 0 {
            self.track.digest.set(Some(self.inner.get_ref().digest()));
        }
        let lines = buf[..n].iter().filter(|&&b| b == b'\n').count() as u64;
        if lines > 0 {
            self.track.line.set(self.track.line.get() + lines);
        }
        self.counted(n as u64)?;
        Ok(n)
    }
}

/// Visits the top-level array element by element and sends the objects on in batches.
struct ArraySeed<'a> {
    tx: &'a SyncSender<Msg>,
    track: &'a Track,
    in_flight: &'a AtomicUsize,
}

impl<'de> DeserializeSeed<'de> for ArraySeed<'_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> std::result::Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}

impl<'de> Visitor<'de> for ArraySeed<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("an array of JSON objects")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<(), A::Error> {
        let t = self.track;
        let mut batch = Vec::new();
        let mut size = 0;
        loop {
            t.mark.set(t.bytes.get());
            t.element_line.set(None);
            let next = seq.next_element_seed(ObjSeed {
                line: &t.line,
                started: Some(&t.element_line),
            })?;
            let last = next.is_none();
            if let Some((line, fields)) = next {
                let obj = Obj {
                    line,
                    end: t.bytes.get(),
                    fields,
                };
                size += obj.size();
                batch.push(obj);
                if size < BATCH_BYTES && batch.len() < BATCH_OBJECTS {
                    continue;
                }
            }
            if !batch.is_empty() {
                self.in_flight.fetch_add(size, Ordering::Relaxed);
                if self
                    .tx
                    .send(Msg::Objs(std::mem::take(&mut batch), size))
                    .is_err()
                {
                    // The reader was dropped: stop reading.
                    return Err(de::Error::custom("stopped"));
                }
                size = 0;
            }
            if last {
                return Ok(());
            }
        }
    }
}

/// The array thread: parses the array and sends records through a channel of 2.
fn read_array(
    src: Source,
    base: u64,
    start: u64,
    tx: SyncSender<Msg>,
    in_flight: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
) {
    let track = Rc::new(Track {
        line: Cell::new(base),
        bytes: Cell::new(start),
        mark: Cell::new(start),
        element_line: Cell::new(None),
        too_large: Cell::new(None),
        digest: Cell::new(None),
    });
    let counted = Counted {
        inner: src,
        track: track.clone(),
        stop,
    };
    let mut de = serde_json::Deserializer::from_reader(counted);
    let done = ArraySeed {
        tx: &tx,
        track: &track,
        in_flight: &in_flight,
    }
    .deserialize(&mut de)
    .and_then(|()| de.end());
    let msg = match (done, track.too_large.get()) {
        (Ok(()), _) => Msg::End(track.digest.get(), track.bytes.get()),
        (Err(_), Some(line)) => Msg::Fail(too_large(line)),
        (Err(e), None) => Msg::Fail(position_error(&e, base)),
    };
    // Fails only when the reader is gone.
    let _ = tx.send(msg);
}

fn too_large(line: u64) -> Error {
    Error::File(format!("Line {line}: one object is larger than 16 MB."))
}

enum Mode {
    Lines(Lines),
    Array {
        rx: Receiver<Msg>,
        /// Set on drop: the thread stops reading.
        stop: Arc<AtomicBool>,
        /// The bytes of the batches sent and not yet received.
        in_flight: Arc<AtomicUsize>,
        /// The rest of the batch last received.
        batch: VecDeque<Obj>,
    },
    Done,
}

enum Step {
    Obj(Obj),
    End(Option<[u8; 32]>, u64),
    Fail(Error),
    Nothing,
}

/// Reads NDJSON, or a top-level array element by element on a thread of its own, through
/// `HashingReader` and a 64 KB buffer. The columns come from the first 1,000 objects
/// (D9), which are held until they are read.
pub struct JsonReader {
    mode: Mode,
    keys: Vec<String>,
    index: HashMap<String, usize>,
    columns: Vec<String>,
    queue: VecDeque<Obj>,
    queued: usize,
    peak: usize,
    row: u64,
    /// The bytes read up to the end of the last record returned.
    end: u64,
    /// The whole file's bytes, once the end is reached.
    total: Option<u64>,
    sha: Option<[u8; 32]>,
    warnings: Vec<String>,
    warned: HashSet<String>,
}

impl JsonReader {
    pub fn open(path: &Path) -> Result<JsonReader> {
        let file = File::open(path).map_err(|e| read_err(Some(path), e))?;
        Self::from_reader(file)
    }

    /// A first byte `[` means an array; anything else is read as NDJSON.
    pub fn from_reader(r: impl Read + Send + 'static) -> Result<JsonReader> {
        let inner: Box<dyn Read + Send> = Box::new(r);
        let mut src: Source = BufReader::with_capacity(BUF_BYTES, HashingReader::new(inner));
        let mut consumed = 0u64;
        let mut line = 1u64;
        if src
            .fill_buf()
            .map_err(|e| read_err(None, e))?
            .starts_with(BOM)
        {
            src.consume(BOM.len());
            consumed = BOM.len() as u64;
        }
        let first = loop {
            let buf = src.fill_buf().map_err(|e| read_err(None, e))?;
            if buf.is_empty() {
                break None;
            }
            match buf.iter().position(|b| !b.is_ascii_whitespace()) {
                Some(i) => break Some(buf[i]),
                None => {
                    let n = buf.len();
                    line += buf.iter().filter(|&&b| b == b'\n').count() as u64;
                    consumed += n as u64;
                    src.consume(n);
                }
            }
        };
        let mode = if first == Some(b'[') {
            let (tx, rx) = sync_channel(2);
            let in_flight = Arc::new(AtomicUsize::new(0));
            let held = in_flight.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let stopped = stop.clone();
            std::thread::Builder::new()
                .name("json-reader".into())
                .spawn(move || read_array(src, line, consumed, tx, held, stopped))
                .map_err(|e| Error::File(format!("cannot start the JSON reader: {e}")))?;
            Mode::Array {
                rx,
                stop,
                in_flight,
                batch: VecDeque::new(),
            }
        } else {
            Mode::Lines(Lines {
                src,
                line,
                consumed,
                buf: Vec::new(),
            })
        };
        let mut reader = JsonReader {
            mode,
            keys: Vec::new(),
            index: HashMap::new(),
            columns: Vec::new(),
            queue: VecDeque::new(),
            queued: 0,
            peak: 0,
            row: 0,
            end: consumed,
            total: None,
            sha: None,
            warnings: Vec::new(),
            warned: HashSet::new(),
        };
        while reader.queue.len() < KEY_OBJECTS {
            let Some(obj) = reader.next_obj()? else {
                break;
            };
            for (k, _) in &obj.fields {
                if !reader.index.contains_key(k) {
                    reader.index.insert(k.clone(), reader.keys.len());
                    reader.keys.push(k.clone());
                }
            }
            reader.queued += obj.size();
            reader.peak = reader.peak.max(reader.queued);
            reader.queue.push_back(obj);
        }
        reader.columns = header_names(reader.keys.clone());
        Ok(reader)
    }

    /// The most record bytes held at once: the objects kept for the columns plus the
    /// ones in the channel.
    pub fn peak_buffered(&self) -> usize {
        self.peak
    }

    fn next_obj(&mut self) -> Result<Option<Obj>> {
        let step = match &mut self.mode {
            Mode::Lines(lines) => match lines.next_obj()? {
                Some(obj) => Step::Obj(obj),
                None => Step::End(Some(lines.src.get_ref().digest()), lines.consumed),
            },
            Mode::Array {
                rx,
                in_flight,
                batch,
                ..
            } => match batch.pop_front() {
                Some(obj) => Step::Obj(obj),
                None => match rx.recv() {
                    Ok(Msg::Objs(objs, size)) => {
                        // What the thread holds: this batch, the ones queued behind it.
                        let held = in_flight.load(Ordering::Relaxed);
                        self.peak = self.peak.max(self.queued + held);
                        in_flight.fetch_sub(size, Ordering::Relaxed);
                        *batch = objs.into();
                        match batch.pop_front() {
                            Some(obj) => Step::Obj(obj),
                            None => Step::Fail(Error::File("the JSON reader stopped".into())),
                        }
                    }
                    Ok(Msg::End(sha, total)) => Step::End(sha, total),
                    Ok(Msg::Fail(e)) => Step::Fail(e),
                    Err(_) => Step::Fail(Error::File("the JSON reader stopped".into())),
                },
            },
            Mode::Done => Step::Nothing,
        };
        match step {
            Step::Obj(obj) => Ok(Some(obj)),
            Step::End(sha, end) => {
                self.mode = Mode::Done;
                self.sha = sha;
                self.total = Some(end);
                Ok(None)
            }
            Step::Fail(e) => {
                self.mode = Mode::Done;
                Err(e)
            }
            Step::Nothing => Ok(None),
        }
    }
}

impl Drop for JsonReader {
    fn drop(&mut self) {
        if let Mode::Array { stop, .. } = &self.mode {
            stop.store(true, Ordering::Relaxed);
        }
    }
}

impl RecordReader for JsonReader {
    fn columns(&self) -> &[String] {
        &self.columns
    }

    fn next_record(&mut self) -> Result<Option<FileRecord>> {
        let obj = match self.queue.pop_front() {
            Some(obj) => {
                self.queued -= obj.size();
                obj
            }
            None => match self.next_obj()? {
                Some(obj) => obj,
                None => return Ok(None),
            },
        };
        let mut values = vec![None; self.keys.len()];
        for (key, raw) in &obj.fields {
            match self.index.get(key) {
                Some(&i) => values[i] = raw_text(raw)?,
                // Every key of the first 1,000 objects is a column, so this one is late.
                None => {
                    if self.warned.len() < MAX_KEY_WARNINGS && self.warned.insert(key.clone()) {
                        self.warnings.push(format!(
                            "Line {}: the key {key} is not in the first 1,000 objects, so it is not imported.",
                            obj.line
                        ));
                    }
                }
            }
        }
        self.row += 1;
        self.end = obj.end;
        Ok(Some(FileRecord {
            row: self.row,
            line: obj.line,
            values,
        }))
    }

    fn bytes_read(&self) -> u64 {
        match self.total {
            Some(total) if self.queue.is_empty() => total,
            _ => self.end,
        }
    }

    fn warnings(&mut self) -> Vec<String> {
        std::mem::take(&mut self.warnings)
    }

    fn sha256(&self) -> Option<[u8; 32]> {
        // Some once every record is out, not when the read-ahead hits the end.
        if self.queue.is_empty() {
            self.sha
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;
    use crate::jobs::paths::{PartialFile, PathUse, outside_data};
    use crate::jobs::source::{Value, ValueKind};
    use crate::jobs::types::{BinaryText, JsonLayout};

    fn col(name: &str, kind: ValueKind) -> SourceColumn {
        SourceColumn {
            name: name.to_string(),
            type_name: "t".into(),
            kind,
        }
    }

    /// JSON Lines, one object per line (the default layout is one array since item 45).
    fn lines() -> ExportOptions {
        ExportOptions {
            json_layout: JsonLayout::Lines,
            ..ExportOptions::default()
        }
    }

    fn array() -> ExportOptions {
        ExportOptions {
            json_layout: JsonLayout::Array,
            ..ExportOptions::default()
        }
    }

    fn write_json(columns: &[SourceColumn], rows: Vec<Vec<Value>>, opts: &ExportOptions) -> String {
        let mut w = JsonWriter::new(Vec::new(), opts);
        w.write_header(columns).unwrap();
        w.write_rows(&Chunk { rows, bytes: 0 }).unwrap();
        String::from_utf8(w.end().unwrap()).unwrap()
    }

    fn read_str(body: &str) -> Result<(Vec<String>, Vec<FileRecord>, Vec<String>)> {
        let mut r = JsonReader::from_reader(std::io::Cursor::new(body.as_bytes().to_vec()))?;
        let mut out = Vec::new();
        while let Some(rec) = r.next_record()? {
            out.push(rec);
        }
        Ok((r.columns().to_vec(), out, r.warnings()))
    }

    fn s(v: &str) -> Option<String> {
        Some(v.to_string())
    }

    fn values(recs: &[FileRecord]) -> Vec<Vec<Option<String>>> {
        recs.iter().map(|r| r.values.clone()).collect()
    }

    #[test]
    fn exact_bigint_and_decimal_both_ways() {
        let columns = [
            col("big", ValueKind::Integer),
            col("dec", ValueKind::Decimal),
        ];
        let row = vec![
            Value::Number("18446744073709551615".into()),
            Value::Number("12345678901234567890.123456789".into()),
        ];
        let out = write_json(&columns, vec![row], &lines());
        assert_eq!(
            out,
            "{\"big\":18446744073709551615,\"dec\":12345678901234567890.123456789}\n"
        );
        for body in [out.clone(), format!("[{}]", out.trim_end())] {
            let (names, recs, _) = read_str(&body).unwrap();
            assert_eq!(names, vec!["big", "dec"]);
            assert_eq!(
                values(&recs),
                vec![vec![
                    s("18446744073709551615"),
                    s("12345678901234567890.123456789")
                ]]
            );
        }
    }

    #[test]
    fn nan_and_infinity_as_strings() {
        let cases = [
            ("NaN", "\"NaN\""),
            ("Infinity", "\"Infinity\""),
            ("-Infinity", "\"-Infinity\""),
            ("inf", "\"inf\""),
            ("-0.5e-3", "-0.5e-3"),
            ("0", "0"),
            ("01", "\"01\""),
            ("1.", "\"1.\""),
        ];
        for (text, want) in cases {
            let out = write_json(
                &[col("f", ValueKind::Float)],
                vec![vec![Value::Number(text.into())]],
                &lines(),
            );
            assert_eq!(out, format!("{{\"f\":{want}}}\n"), "{text}");
        }
    }

    #[test]
    fn json_column_embedded() {
        let columns = [col("doc", ValueKind::Json), col("plain", ValueKind::Text)];
        let cases = [
            (
                "{\"a\": [1, 2],\n \"b\": \"x y\"}",
                "{\"a\":[1,2],\"b\":\"x y\"}",
            ),
            ("[1, 18446744073709551616]", "[1,18446744073709551616]"),
            ("not json", "\"not json\""),
            ("{\"a\":", "\"{\\\"a\\\":\""),
        ];
        for (text, want) in cases {
            let out = write_json(
                &columns,
                vec![vec![
                    Value::Text(text.into()),
                    Value::Text("{\"a\":1}".into()),
                ]],
                &lines(),
            );
            assert_eq!(
                out,
                format!("{{\"doc\":{want},\"plain\":\"{{\\\"a\\\":1}}\"}}\n"),
                "{text}"
            );
        }
        // Other values: NULL, booleans, bytes, text escapes.
        let b64 = ExportOptions {
            binary: BinaryText::Base64,
            ..lines()
        };
        let columns = [
            col("n", ValueKind::Text),
            col("b", ValueKind::Bool),
            col("x", ValueKind::Binary),
            col("t", ValueKind::Text),
        ];
        let row = || {
            vec![
                Value::Null,
                Value::Bool(true),
                Value::Bytes(vec![1, 255]),
                Value::Text("q\"\n".into()),
            ]
        };
        assert_eq!(
            write_json(&columns, vec![row()], &lines()),
            "{\"n\":null,\"b\":true,\"x\":\"0x01ff\",\"t\":\"q\\\"\\n\"}\n"
        );
        assert_eq!(
            write_json(&columns, vec![row()], &b64),
            "{\"n\":null,\"b\":true,\"x\":\"Af8=\",\"t\":\"q\\\"\\n\"}\n"
        );
    }

    #[test]
    fn ndjson_and_array_input() {
        let ndjson = "{\"id\":1,\"name\":\"a\"}\n\n{\"id\":2,\"name\":\"b\"}\r\n";
        let flat = "[{\"id\":1,\"name\":\"a\"},{\"id\":2,\"name\":\"b\"}]";
        let pretty = "[\n  {\n    \"id\": 1,\n    \"name\": \"a\"\n  },\n  {\n    \"id\": 2, \"name\": \"b\"\n  }\n]\n";
        let bom = "\u{feff}{\"id\":1,\"name\":\"a\"}\n{\"id\":2,\"name\":\"b\"}";
        let cases = [
            (ndjson, [1u64, 3]),
            (flat, [1, 1]),
            (pretty, [2, 6]),
            (bom, [1, 2]),
        ];
        for (body, lines) in cases {
            let (names, recs, _) = read_str(body).unwrap();
            assert_eq!(names, vec!["id", "name"], "{body}");
            assert_eq!(
                values(&recs),
                vec![vec![s("1"), s("a")], vec![s("2"), s("b")]]
            );
            let got: Vec<(u64, u64)> = recs.iter().map(|r| (r.row, r.line)).collect();
            assert_eq!(got, vec![(1, lines[0]), (2, lines[1])], "{body}");
        }
        // Reading a file by path, with its hash once the end is reached.
        use sha2::{Digest, Sha256};
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        std::fs::write(&p, pretty).unwrap();
        let mut r = JsonReader::open(&p).unwrap();
        assert_eq!(r.sha256(), None);
        while r.next_record().unwrap().is_some() {}
        let want: [u8; 32] = Sha256::digest(pretty.as_bytes()).into();
        assert_eq!(r.sha256(), Some(want));
        assert_eq!(r.bytes_read(), pretty.len() as u64);
    }

    #[test]
    fn differing_keys() {
        let body = "{\"a\":1,\"b\":2}\n{\"b\":3,\"c\":4}\n{\"c\":null}\n";
        let (names, recs, warnings) = read_str(body).unwrap();
        assert_eq!(names, vec!["a", "b", "c"]);
        assert_eq!(
            values(&recs),
            vec![
                vec![s("1"), s("2"), None],
                vec![None, s("3"), s("4")],
                vec![None, None, None]
            ]
        );
        assert!(warnings.is_empty());
        // A key first seen after object 1,000 is not imported, with one warning.
        let mut late = String::new();
        for i in 0..1000 {
            late.push_str(&format!("{{\"a\":{i}}}\n"));
        }
        late.push_str("{\"a\":1000,\"z\":1}\n{\"a\":1001,\"z\":2}\n");
        let (names, recs, warnings) = read_str(&late).unwrap();
        assert_eq!(names, vec!["a"]);
        assert_eq!(recs.len(), 1002);
        assert_eq!(recs[1000].values, vec![s("1000")]);
        assert_eq!(
            warnings,
            vec!["Line 1001: the key z is not in the first 1,000 objects, so it is not imported."]
        );
        // A key seen within the first 1,000 objects is a column.
        let mut early = String::new();
        for i in 0..999 {
            early.push_str(&format!("{{\"a\":{i}}}\n"));
        }
        early.push_str("{\"z\":1}\n");
        let (names, _, warnings) = read_str(&early).unwrap();
        assert_eq!(names, vec!["a", "z"]);
        assert!(warnings.is_empty());
        // A blank key is a "Column N" column.
        let (names, recs, _) = read_str("{\"\":1,\"b\":2}").unwrap();
        assert_eq!(names, vec!["Column 1", "b"]);
        assert_eq!(values(&recs), vec![vec![s("1"), s("2")]]);
    }

    #[test]
    fn nested_values_become_json_text() {
        let body = "{\"a\": {\"b\": [1, 2.50]}, \"c\": [true, null, \"x y\"], \"d\": true, \"e\": false, \"f\": \"s\\n\", \"g\": null}";
        let (_, recs, _) = read_str(body).unwrap();
        assert_eq!(
            values(&recs),
            vec![vec![
                s("{\"b\":[1,2.50]}"),
                s("[true,null,\"x y\"]"),
                s("true"),
                s("false"),
                s("s\n"),
                None
            ]]
        );
    }

    #[test]
    fn error_positions() {
        let cases = [
            ("{\"a\":1}\n{\"a\":2}\n{\"a\":3,}\n", "Line 3, column 8: "),
            (
                "[\n  {\"a\":1},\n  {\"a\":2},\n  {\"a\" 3}\n]",
                "Line 4, column 8: ",
            ),
            ("[{\"a\":1}] x", "Line 1, column 11: "),
            ("{\"a\":1}\n42\n", "Line 2, column 2: "),
            ("[{\"a\":1},\n{\"a\":\"\\q\"}]", "Line 2, column 8: "),
        ];
        for (body, prefix) in cases {
            let msg = match read_str(body) {
                Err(Error::File(m)) => m,
                other => panic!("{body}: expected a file error, got {other:?}"),
            };
            assert!(msg.starts_with(prefix), "{body}: {msg}");
            assert!(msg.ends_with('.'), "{msg}");
            assert!(!msg.contains(" at line "), "{msg}");
        }
    }

    #[test]
    fn zero_rows_array_is_brackets() {
        let columns = [col("a", ValueKind::Integer)];
        assert_eq!(write_json(&columns, vec![], &array()), "[]\n");
        assert_eq!(write_json(&columns, vec![], &lines()), "");
        let two = write_json(
            &columns,
            vec![
                vec![Value::Number("1".into())],
                vec![Value::Number("2".into())],
            ],
            &array(),
        );
        assert_eq!(two, "[\n{\"a\":1},\n{\"a\":2}\n]\n");
        for body in ["[]", " [ ] \n", "", "\n\n"] {
            let (names, recs, _) = read_str(body).unwrap();
            assert!(names.is_empty() && recs.is_empty(), "{body:?}");
        }
    }

    #[test]
    fn finished_writer_commits_and_dropped_writer_leaves_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("out.json");
        let partial = PartialFile::create(&target, false, PathUse::Export, &outside_data())
            .unwrap()
            .writer();
        let mut w: Box<dyn FormatWriter> = Box::new(JsonWriter::new(partial, &array()));
        w.begin(&[col("a", ValueKind::Integer)]).unwrap();
        w.write_chunk(&Chunk {
            rows: vec![vec![Value::Number("1".into())]],
            bytes: 1,
        })
        .unwrap();
        w.finish().unwrap().commit().unwrap();
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "[\n{\"a\":1}\n]\n"
        );

        let target2 = dir.path().join("dropped.json");
        let partial = PartialFile::create(&target2, false, PathUse::Export, &outside_data())
            .unwrap()
            .writer();
        let partial_path = partial.partial_path().to_path_buf();
        let mut w: Box<dyn FormatWriter> = Box::new(JsonWriter::new(partial, &array()));
        w.begin(&[col("a", ValueKind::Integer)]).unwrap();
        drop(w);
        assert!(!target2.exists());
        assert!(!partial_path.exists());
    }

    /// Streams `head`, then `fill` repeated `count` times, then `tail`, holding none of it.
    struct Repeated {
        parts: Vec<(Vec<u8>, u64)>,
        part: usize,
        at: usize,
        left: u64,
    }

    impl Repeated {
        fn new(head: &str, fill: u8, count: u64, tail: &str) -> Self {
            let parts = vec![
                (head.as_bytes().to_vec(), 1),
                (vec![fill; 64 * 1024], count / (64 * 1024)),
                (vec![fill; (count % (64 * 1024)) as usize], 1),
                (tail.as_bytes().to_vec(), 1),
            ];
            let left = parts[0].1;
            Self {
                parts,
                part: 0,
                at: 0,
                left,
            }
        }
    }

    impl Read for Repeated {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            loop {
                let Some((bytes, _)) = self.parts.get(self.part) else {
                    return Ok(0);
                };
                if self.left > 0 && self.at < bytes.len() {
                    let n = buf.len().min(bytes.len() - self.at);
                    buf[..n].copy_from_slice(&bytes[self.at..self.at + n]);
                    self.at += n;
                    return Ok(n);
                }
                self.at = 0;
                if self.left > 1 {
                    self.left -= 1;
                    continue;
                }
                self.part += 1;
                self.left = self.parts.get(self.part).map_or(0, |p| p.1);
            }
        }
    }

    fn read_source(src: impl Read + Send + 'static) -> Result<u64> {
        let mut r = JsonReader::from_reader(src)?;
        let mut rows = 0;
        while r.next_record()?.is_some() {
            rows += 1;
        }
        Ok(rows)
    }

    fn file_msg<T: std::fmt::Debug>(r: Result<T>) -> String {
        match r {
            Err(Error::File(m)) => m,
            other => panic!("expected a file error, got {other:?}"),
        }
    }

    const OVER: u64 = 17 * 1024 * 1024;

    #[test]
    fn array_element_over_16mb_is_refused() {
        let cases = [
            // One huge string inside an object.
            Repeated::new("[{\"id\":1},\n{\"a\":\"", b'x', OVER, "\"}]"),
            // One huge nested array, "0,0,0,...".
            Repeated {
                parts: vec![
                    (b"[{\"id\":1},\n{\"a\":[".to_vec(), 1),
                    (b"0,".repeat(32 * 1024), OVER / (64 * 1024)),
                    (b"0]}]".to_vec(), 1),
                ],
                part: 0,
                at: 0,
                left: 1,
            },
        ];
        for src in cases {
            assert_eq!(
                file_msg(read_source(src)),
                "Line 2: one object is larger than 16 MB."
            );
        }
    }

    #[test]
    fn ndjson_object_over_16mb_is_refused() {
        let src = Repeated::new("{\"id\":1}\n{\"a\":\"", b'x', OVER, "\"}\n");
        assert_eq!(
            file_msg(read_source(src)),
            "Line 2: one object is larger than 16 MB."
        );
    }

    #[test]
    fn long_value_under_the_limit_reads_back() {
        let size = 8 * 1024 * 1024;
        for head in ["[{\"a\":\"", "{\"a\":\""] {
            let tail = if head.starts_with('[') {
                "\"}]"
            } else {
                "\"}\n"
            };
            let mut r = JsonReader::from_reader(Repeated::new(head, b'y', size, tail)).unwrap();
            let rec = r.next_record().unwrap().unwrap();
            let v = rec.values[0].clone().unwrap();
            assert_eq!(v.len() as u64, size);
            assert!(v.bytes().all(|b| b == b'y'));
            assert!(r.next_record().unwrap().is_none());
        }
    }

    #[test]
    fn one_pretty_object_says_one_object_per_line() {
        let msg = file_msg(read_str("{\n  \"a\": 1\n}\n"));
        assert_eq!(
            msg,
            "Line 1: the object goes on past this line. Import takes one object per line, or an array of objects."
        );
    }

    #[test]
    fn json_text_null_is_written_as_a_string() {
        let out = write_json(
            &[col("doc", ValueKind::Json)],
            vec![vec![Value::Text("null".into())], vec![Value::Null]],
            &lines(),
        );
        assert_eq!(out, "{\"doc\":\"null\"}\n{\"doc\":null}\n");
    }

    #[test]
    fn row_wider_than_columns_is_refused() {
        let mut w = JsonWriter::new(Vec::new(), &lines());
        w.write_header(&[col("a", ValueKind::Integer)]).unwrap();
        let wide = Chunk {
            rows: vec![vec![Value::Number("1".into()), Value::Number("2".into())]],
            bytes: 2,
        };
        assert!(matches!(w.write_rows(&wide), Err(Error::InvalidInput(_))));
    }

    #[test]
    fn non_finite_numbers_are_strings_in_every_column_kind() {
        for kind in [
            ValueKind::Float,
            ValueKind::Decimal,
            ValueKind::Json,
            ValueKind::Text,
        ] {
            for (text, want) in [
                ("NaN", "\"NaN\""),
                ("Infinity", "\"Infinity\""),
                ("-Infinity", "\"-Infinity\""),
            ] {
                let out = write_json(
                    &[col("f", kind)],
                    vec![vec![Value::Number(text.into())]],
                    &array(),
                );
                assert_eq!(out, format!("[\n{{\"f\":{want}}}\n]\n"), "{kind:?} {text}");
            }
        }
    }

    /// Makes a JSON array of `size` bytes on the fly, so the test holds none of it.
    struct GeneratedArray {
        size: u64,
        made: u64,
        next: u64,
        pending: Vec<u8>,
        at: usize,
        closed: bool,
    }

    impl GeneratedArray {
        fn new(size: u64) -> Self {
            Self {
                size,
                made: 0,
                next: 0,
                pending: b"[".to_vec(),
                at: 0,
                closed: false,
            }
        }
    }

    impl Read for GeneratedArray {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.at == self.pending.len() {
                if self.closed {
                    return Ok(0);
                }
                self.pending.clear();
                self.at = 0;
                if self.made >= self.size {
                    self.pending.extend_from_slice(b"\n]\n");
                    self.closed = true;
                } else {
                    let sep = if self.next == 0 { "\n" } else { ",\n" };
                    let obj = format!(
                        "{sep}{{\"id\":{n},\"name\":\"row {n}\",\"amount\":12345678901234567890.25,\"tags\":[\"a\",\"b\"]}}",
                        n = self.next
                    );
                    self.pending.extend_from_slice(obj.as_bytes());
                    self.next += 1;
                }
                self.made += self.pending.len() as u64;
            }
            let n = buf.len().min(self.pending.len() - self.at);
            buf[..n].copy_from_slice(&self.pending[self.at..self.at + n]);
            self.at += n;
            Ok(n)
        }
    }

    fn bounded_read(size: u64) {
        let source = GeneratedArray::new(size);
        let mut r = JsonReader::from_reader(source).unwrap();
        assert_eq!(r.columns(), ["id", "name", "amount", "tags"]);
        let mut rows = 0u64;
        while let Some(rec) = r.next_record().unwrap() {
            rows += 1;
            assert_eq!(rec.row, rows);
            if rows == 1 {
                assert_eq!(rec.values[2], s("12345678901234567890.25"));
                assert_eq!(rec.values[3], s("[\"a\",\"b\"]"));
            }
        }
        assert!(r.bytes_read() >= size, "{}", r.bytes_read());
        assert!(r.sha256().is_some());
        assert!(rows > 100_000, "{rows}");
        assert!(
            r.peak_buffered() < 1024 * 1024,
            "peak {}",
            r.peak_buffered()
        );
    }

    #[test]
    fn array_read_in_bounded_memory() {
        bounded_read(64 * 1024 * 1024);
    }

    /// D18: run in the deferred checklist (`-- --ignored jobs::formats`).
    #[test]
    #[ignore]
    fn array_read_1gb_in_bounded_memory() {
        bounded_read(1024 * 1024 * 1024);
    }
}
