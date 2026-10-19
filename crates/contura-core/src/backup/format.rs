//! The Backup script's frame (spec "The script format"): a header of `-- key: value`
//! comment lines, section markers, and a trailer as the last line. Contura writes no
//! statement of its own here, so any SQL client can run the file.
//!
//! [`read_header`] looks at the first 64 KB and the last 4 KB only, never the whole file.
//! It tells three cases apart through [`BackupFile`]: a Contura Backup (header and
//! trailer both found), plain SQL (no Contura header, Restore may still offer it), and a
//! refusal (`Error::BackupRefused`: a Contura header with no trailer, a newer format, or a
//! damaged header).

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

use crate::error::{Error, Result};
use crate::model::DialectKind;

pub const FORMAT_VERSION: u32 = 1;
/// How much of the file's start `read_header` reads.
pub const HEAD_BYTES: usize = 64 * 1024;
/// How much of the file's end `read_header` reads, for the trailer.
pub const TAIL_BYTES: usize = 4 * 1024;

/// Restore's refusal text for a file that ends before its trailer.
pub const INCOMPLETE: &str = "This Backup is incomplete: it ends before the trailer. It may have been cut off while it was written.";

const FIRST_LINE: &str = "-- Contura backup, format ";
const TRAILER_PREFIX: &str = "-- contura-backup-end ";

/// What a Backup carries, in the order the header lists it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Content {
    Tables,
    Indexes,
    ForeignKeys,
    Enums,
    Sequences,
    Views,
    Routines,
    Triggers,
    Checks,
    Generated,
    Rows,
}

impl Content {
    pub fn as_str(self) -> &'static str {
        match self {
            Content::Tables => "tables",
            Content::Indexes => "indexes",
            Content::ForeignKeys => "foreign-keys",
            Content::Enums => "enums",
            Content::Sequences => "sequences",
            Content::Views => "views",
            Content::Routines => "routines",
            Content::Triggers => "triggers",
            Content::Checks => "checks",
            Content::Generated => "generated",
            Content::Rows => "rows",
        }
    }

    fn parse(s: &str) -> Option<Content> {
        Some(match s {
            "tables" => Content::Tables,
            "indexes" => Content::Indexes,
            "foreign-keys" => Content::ForeignKeys,
            "enums" => Content::Enums,
            "sequences" => Content::Sequences,
            "views" => Content::Views,
            "routines" => Content::Routines,
            "triggers" => Content::Triggers,
            "checks" => Content::Checks,
            "generated" => Content::Generated,
            "rows" => Content::Rows,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackupHeader {
    pub format: u32,
    /// "Contura 0.9.0"; see [`made_by`].
    pub made_by: String,
    pub dialect: DialectKind,
    pub server_version: String,
    pub database: String,
    /// PostgreSQL only.
    pub schema: Option<String>,
    /// UTC, `2026-10-16T22:00:00Z`.
    pub taken_at: String,
    pub contents: Vec<Content>,
    /// Qualified table name and its row count.
    pub rows: Vec<(String, u64)>,
    pub not_included: Vec<String>,
    /// MySQL: `DEFINER=` clauses were removed.
    pub definer_removed: bool,
    /// Written as `-- drop-tables: yes` only when on; a missing line reads as `false`.
    pub drop_tables: bool,
}

/// The last line's counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Trailer {
    pub statements: u64,
    pub rows: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Section<'a> {
    Settings,
    Structure,
    Rows(&'a str),
    AfterRows,
    Finish,
}

/// What `read_header` found.
#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(clippy::large_enum_variant)] // one value per opened file
pub enum BackupFile {
    /// No Contura header: an ordinary SQL script.
    PlainSql,
    Contura {
        header: BackupHeader,
        trailer: Trailer,
    },
}

/// "Contura " and this crate's version.
pub fn made_by() -> String {
    format!("Contura {}", env!("CARGO_PKG_VERSION"))
}

pub fn dialect_name(d: DialectKind) -> &'static str {
    match d {
        DialectKind::MySql => "mysql",
        DialectKind::Postgres => "postgres",
        DialectKind::Sqlite => "sqlite",
    }
}

fn parse_dialect(s: &str) -> Option<DialectKind> {
    match s {
        "mysql" => Some(DialectKind::MySql),
        "postgres" => Some(DialectKind::Postgres),
        "sqlite" => Some(DialectKind::Sqlite),
        _ => None,
    }
}

/// A comment is one line: line breaks in a name become spaces.
fn one_line(s: &str) -> String {
    s.replace(['\r', '\n'], " ")
}

/// Percent-encodes the characters that separate or break a list item.
fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '%' => out.push_str("%25"),
            ',' => out.push_str("%2C"),
            ';' => out.push_str("%3B"),
            '=' => out.push_str("%3D"),
            '\r' => out.push_str("%0D"),
            '\n' => out.push_str("%0A"),
            c => out.push(c),
        }
    }
    out
}

fn unescape(s: &str) -> String {
    let mut out = Vec::with_capacity(s.len());
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let escaped = if b[i] == b'%' {
            s.get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        } else {
            None
        };
        if let Some(v) = escaped {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Writes the header lines and a blank line after them.
pub fn write_header(w: &mut impl Write, h: &BackupHeader) -> std::io::Result<()> {
    writeln!(w, "{FIRST_LINE}{}", h.format)?;
    writeln!(w, "-- made-by: {}", one_line(&h.made_by))?;
    writeln!(w, "-- dialect: {}", dialect_name(h.dialect))?;
    writeln!(w, "-- server-version: {}", one_line(&h.server_version))?;
    writeln!(w, "-- database: {}", one_line(&h.database))?;
    if let Some(schema) = &h.schema {
        writeln!(w, "-- schema: {}", one_line(schema))?;
    }
    writeln!(w, "-- taken-at: {}", one_line(&h.taken_at))?;
    let contents: Vec<&str> = h.contents.iter().map(|c| c.as_str()).collect();
    writeln!(w, "-- contents: {}", contents.join(", "))?;
    let rows: Vec<String> = h
        .rows
        .iter()
        .map(|(t, n)| format!("{}={n}", escape(t)))
        .collect();
    writeln!(w, "-- rows: {}", rows.join(", "))?;
    if !h.not_included.is_empty() {
        let items: Vec<String> = h.not_included.iter().map(|s| escape(s)).collect();
        writeln!(w, "-- not-included: {}", items.join("; "))?;
    }
    if h.definer_removed {
        writeln!(w, "-- definer: removed (MySQL only, see Per-Dialect rules)")?;
    }
    if h.drop_tables {
        writeln!(w, "-- drop-tables: yes")?;
    }
    writeln!(w)
}

pub fn section(w: &mut impl Write, s: Section<'_>) -> std::io::Result<()> {
    match s {
        Section::Settings => writeln!(w, "-- section: settings"),
        Section::Structure => writeln!(w, "-- section: structure"),
        Section::Rows(table) => writeln!(w, "-- section: rows {}", one_line(table)),
        Section::AfterRows => writeln!(w, "-- section: after-rows"),
        Section::Finish => writeln!(w, "-- section: finish"),
    }
}

/// The last line of the file.
pub fn write_trailer(w: &mut impl Write, statements: u64, rows: u64) -> std::io::Result<()> {
    writeln!(w, "{TRAILER_PREFIX}statements={statements} rows={rows}")
}

fn refused(reason: impl Into<String>) -> Error {
    Error::BackupRefused {
        reason: reason.into(),
    }
}

fn read_up_to(f: &mut File, buf: &mut Vec<u8>, max: usize) -> Result<()> {
    f.take(max as u64)
        .read_to_end(buf)
        .map_err(|e| Error::File(e.to_string()))?;
    Ok(())
}

/// Reads the first 64 KB and the last 4 KB of `path`. See the module note for the three
/// outcomes.
pub fn read_header(path: &Path) -> Result<BackupFile> {
    let mut f = File::open(path).map_err(|e| Error::File(format!("{}: {e}", path.display())))?;
    let len = f.metadata().map_err(|e| Error::File(e.to_string()))?.len();
    let mut head = Vec::new();
    read_up_to(&mut f, &mut head, HEAD_BYTES)?;
    let head_full = len > HEAD_BYTES as u64;
    let head_text = String::from_utf8_lossy(&head);
    let mut lines: Vec<&str> = head_text.split('\n').collect();
    // The last piece is a partial line when the chunk was cut, empty at a clean end.
    let last_piece = lines.pop().unwrap_or("");
    if !head_full && !last_piece.is_empty() {
        lines.push(last_piece);
    }
    let Some(version) = lines
        .first()
        .and_then(|l| l.trim_end_matches('\r').strip_prefix(FIRST_LINE))
    else {
        return Ok(BackupFile::PlainSql);
    };
    let format: u32 = version.trim().parse().map_err(|_| {
        refused("This file's Backup header is damaged: the format number is unreadable.")
    })?;
    if format != FORMAT_VERSION {
        return Err(refused(format!(
            "This Backup is format {format}. This version of Contura reads format {FORMAT_VERSION}."
        )));
    }

    let mut fields: Vec<(&str, &str)> = Vec::new();
    let mut ended = false;
    for line in lines.iter().skip(1) {
        let line = line.trim_end_matches('\r');
        let Some((key, value)) = line
            .strip_prefix("-- ")
            .and_then(|rest| rest.split_once(": "))
        else {
            ended = true;
            break;
        };
        if key == "section" {
            ended = true;
            break;
        }
        fields.push((key, value));
    }
    if !ended && head_full {
        return Err(refused(
            "This file's Backup header is damaged: it does not end within its first 64 KB.",
        ));
    }
    let header = parse_fields(format, &fields)?;

    let trailer = read_trailer(&mut f, len)?;
    Ok(BackupFile::Contura { header, trailer })
}

fn parse_fields(format: u32, fields: &[(&str, &str)]) -> Result<BackupHeader> {
    let get = |k: &str| fields.iter().find(|(key, _)| *key == k).map(|(_, v)| *v);
    let need = |k: &str| {
        get(k).ok_or_else(|| {
            refused(format!(
                "This file's Backup header is damaged: the {k} line is missing."
            ))
        })
    };
    let dialect = parse_dialect(need("dialect")?.trim())
        .ok_or_else(|| refused("This Backup is for a database type Contura does not know."))?;
    let contents = get("contents")
        .unwrap_or("")
        .split(',')
        .filter_map(|s| Content::parse(s.trim()))
        .collect();
    let mut rows = Vec::new();
    for item in get("rows")
        .unwrap_or("")
        .split(", ")
        .filter(|s| !s.is_empty())
    {
        let (name, n) = item
            .rsplit_once('=')
            .and_then(|(name, n)| Some((name, n.trim().parse::<u64>().ok()?)))
            .ok_or_else(|| {
                refused("This file's Backup header is damaged: the rows line is unreadable.")
            })?;
        rows.push((unescape(name), n));
    }
    let not_included = get("not-included")
        .unwrap_or("")
        .split("; ")
        .filter(|s| !s.is_empty())
        .map(unescape)
        .collect();
    Ok(BackupHeader {
        format,
        made_by: need("made-by")?.to_string(),
        dialect,
        server_version: need("server-version")?.to_string(),
        database: need("database")?.to_string(),
        schema: get("schema").map(str::to_string),
        taken_at: need("taken-at")?.to_string(),
        contents,
        rows,
        not_included,
        definer_removed: get("definer").is_some_and(|v| v.starts_with("removed")),
        drop_tables: get("drop-tables").is_some_and(|v| v.trim() == "yes"),
    })
}

fn read_trailer(f: &mut File, len: u64) -> Result<Trailer> {
    let start = len.saturating_sub(TAIL_BYTES as u64);
    f.seek(SeekFrom::Start(start))
        .map_err(|e| Error::File(e.to_string()))?;
    let mut tail = Vec::new();
    read_up_to(f, &mut tail, TAIL_BYTES)?;
    let text = String::from_utf8_lossy(&tail);
    // The writer ends the trailer with LF; a line cut mid-number has none.
    if !text.ends_with('\n') {
        return Err(refused(INCOMPLETE));
    }
    let last = text
        .trim_end_matches(['\n', '\r'])
        .rsplit('\n')
        .next()
        .unwrap_or("")
        .trim_end_matches('\r');
    last.strip_prefix(TRAILER_PREFIX)
        .and_then(|rest| {
            let (s, r) = rest.split_once(' ')?;
            Some(Trailer {
                statements: s.strip_prefix("statements=")?.parse().ok()?,
                rows: r.strip_prefix("rows=")?.trim().parse().ok()?,
            })
        })
        .ok_or_else(|| refused(INCOMPLETE))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header() -> BackupHeader {
        BackupHeader {
            format: FORMAT_VERSION,
            made_by: made_by(),
            dialect: DialectKind::Postgres,
            server_version: "16.4".into(),
            database: "freight".into(),
            schema: Some("billing".into()),
            taken_at: "2026-10-16T22:00:00Z".into(),
            contents: vec![Content::Tables, Content::ForeignKeys, Content::Rows],
            rows: vec![
                ("billing.customers".into(), 1204),
                ("billing.invoices".into(), 90412),
            ],
            not_included: vec!["extension pgcrypto".into(), "large objects".into()],
            definer_removed: false,
            drop_tables: false,
        }
    }

    fn file_with(content: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b.sql");
        std::fs::write(&path, content).unwrap();
        (dir, path)
    }

    fn whole(h: &BackupHeader, trailer: bool) -> Vec<u8> {
        let mut out = Vec::new();
        write_header(&mut out, h).unwrap();
        section(&mut out, Section::Structure).unwrap();
        out.extend_from_slice(b"CREATE TABLE t (id int);\n");
        section(&mut out, Section::Finish).unwrap();
        if trailer {
            write_trailer(&mut out, 1503, 742818).unwrap();
        }
        out
    }

    #[test]
    fn header_lines_match_the_spec() {
        let mut out = Vec::new();
        write_header(&mut out, &header()).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.starts_with("-- Contura backup, format 1\n-- made-by: Contura "));
        assert!(text.contains("\n-- dialect: postgres\n-- server-version: 16.4\n-- database: freight\n-- schema: billing\n-- taken-at: 2026-10-16T22:00:00Z\n"));
        assert!(text.contains("-- contents: tables, foreign-keys, rows\n"));
        assert!(text.contains("-- rows: billing.customers=1204, billing.invoices=90412\n"));
        assert!(text.contains("-- not-included: extension pgcrypto; large objects\n"));
        assert!(!text.contains("definer"));
    }

    #[test]
    fn header_round_trip() {
        let (_d, path) = file_with(&whole(&header(), true));
        let BackupFile::Contura {
            header: got,
            trailer,
        } = read_header(&path).unwrap()
        else {
            panic!("expected a Contura Backup");
        };
        assert_eq!(got, header());
        assert_eq!(
            trailer,
            Trailer {
                statements: 1503,
                rows: 742818
            }
        );
    }

    #[test]
    fn round_trip_with_mysql_fields() {
        let mut h = header();
        h.dialect = DialectKind::MySql;
        h.schema = None;
        h.not_included = vec![];
        h.definer_removed = true;
        let (_d, path) = file_with(&whole(&h, true));
        let BackupFile::Contura { header: got, .. } = read_header(&path).unwrap() else {
            panic!();
        };
        assert_eq!(got, h);
    }

    #[test]
    fn cut_file_refused() {
        let (_d, path) = file_with(&whole(&header(), false));
        let err = read_header(&path).unwrap_err();
        assert!(matches!(err, Error::BackupRefused { .. }));
        assert_eq!(
            err.to_string(),
            "This Backup is incomplete: it ends before the trailer. It may have been cut off while it was written."
        );
    }

    #[test]
    fn non_contura_file_is_plain_sql() {
        let (_d, path) = file_with(b"-- dump by something else\nCREATE TABLE t (id int);\n");
        assert_eq!(read_header(&path).unwrap(), BackupFile::PlainSql);
        let (_d, path) = file_with(b"");
        assert_eq!(read_header(&path).unwrap(), BackupFile::PlainSql);
    }

    #[test]
    fn newer_format_is_refused() {
        let (_d, path) = file_with(b"-- Contura backup, format 2\n-- dialect: mysql\n");
        assert!(matches!(
            read_header(&path),
            Err(Error::BackupRefused { .. })
        ));
    }

    #[test]
    fn markers_are_sql_comments_only() {
        let mut out = Vec::new();
        for s in [
            Section::Settings,
            Section::Structure,
            Section::Rows("billing.customers"),
            Section::AfterRows,
            Section::Finish,
        ] {
            section(&mut out, s).unwrap();
        }
        write_trailer(&mut out, 3, 9).unwrap();
        write_header(&mut out, &header()).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("-- section: rows billing.customers\n"));
        assert!(text.contains("-- section: after-rows\n"));
        assert!(text.contains("-- contura-backup-end statements=3 rows=9\n"));
        assert!(text.lines().all(|l| l.is_empty() || l.starts_with("-- ")));
    }

    #[test]
    fn only_the_ends_are_read_from_a_large_file() {
        let mut bytes = whole(&header(), false);
        bytes.extend(std::iter::repeat_n(b'x', 200_000));
        bytes.extend_from_slice(b"\n");
        write_trailer(&mut bytes, 5, 6).unwrap();
        let (_d, path) = file_with(&bytes);
        let BackupFile::Contura { trailer, .. } = read_header(&path).unwrap() else {
            panic!();
        };
        assert_eq!(
            trailer,
            Trailer {
                statements: 5,
                rows: 6
            }
        );
    }

    #[test]
    fn names_with_line_breaks_stay_on_one_line() {
        let mut h = header();
        h.database = "a\nb".into();
        let (_d, path) = file_with(&whole(&h, true));
        let BackupFile::Contura { header: got, .. } = read_header(&path).unwrap() else {
            panic!();
        };
        assert_eq!(got.database, "a b");
    }

    #[test]
    fn drop_tables_round_trips_both_ways() {
        for on in [false, true] {
            let mut h = header();
            h.drop_tables = on;
            h.definer_removed = on;
            let (_d, path) = file_with(&whole(&h, true));
            let BackupFile::Contura { header: got, .. } = read_header(&path).unwrap() else {
                panic!();
            };
            assert_eq!(got.drop_tables, on);
            assert_eq!(got, h);
        }
        let mut out = Vec::new();
        write_header(&mut out, &header()).unwrap();
        assert!(!String::from_utf8(out).unwrap().contains("drop-tables"));
    }

    #[test]
    fn awkward_names_round_trip() {
        let mut h = header();
        h.rows = vec![
            ("a, b;=c".into(), 1),
            ("x\ny\r%41".into(), 2),
            ("plain".into(), 3),
        ];
        h.not_included = vec![
            "ext a; b, c".into(),
            "line
break"
                .into(),
        ];
        let mut out = Vec::new();
        write_header(&mut out, &h).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains(
            "-- rows: a%2C b%3B%3Dc=1, x%0Ay%0D%2541=2, plain=3
"
        ));
        let (_d, path) = file_with(&whole(&h, true));
        let BackupFile::Contura { header: got, .. } = read_header(&path).unwrap() else {
            panic!();
        };
        assert_eq!(got.rows, h.rows);
        assert_eq!(got.not_included, h.not_included);
    }

    #[test]
    fn trailer_cut_mid_number_is_incomplete() {
        let full = whole(&header(), true);
        let end = b"-- contura-backup-end statements=1503 rows=742818
";
        let start = full.len() - end.len();
        for cut in [full.len() - 1, full.len() - 2, full.len() - 3, start + 30] {
            let (_d, path) = file_with(&full[..cut]);
            let err = read_header(&path).unwrap_err();
            assert_eq!(err.to_string(), INCOMPLETE, "cut at {cut}");
        }
    }
}
