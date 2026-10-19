use std::sync::Mutex;
use std::sync::atomic::AtomicBool;

use super::*;
use crate::backup::format::{BackupFile, Content, FORMAT_VERSION, made_by, read_header};
use crate::jobs::paths::{PartialFile, PathUse, outside_data};
use crate::jobs::source::{Chunk, SourceColumn, ValueKind};

/// Rows from memory; `fail_after` chunks, then a lost connection.
struct MemRows {
    columns: Vec<SourceColumn>,
    chunks: Vec<Vec<Vec<Value>>>,
    fail_after: Option<usize>,
    sent: usize,
}

struct NoServer;

#[async_trait::async_trait]
impl Canceller for NoServer {
    async fn cancel(&self) -> Result<()> {
        Ok(())
    }
}

#[async_trait::async_trait]
impl RowSource for MemRows {
    fn columns(&self) -> &[SourceColumn] {
        &self.columns
    }
    async fn next_chunk(&mut self) -> Result<Option<Chunk>> {
        if self.fail_after == Some(self.sent) {
            return Err(Error::Query(
                "server closed the connection unexpectedly".into(),
            ));
        }
        if self.sent >= self.chunks.len() {
            return Ok(None);
        }
        let rows = self.chunks[self.sent].clone();
        self.sent += 1;
        Ok(Some(Chunk { rows, bytes: 0 }))
    }
    fn estimate(&self) -> Option<u64> {
        None
    }
    fn sql(&self) -> &str {
        "SELECT"
    }
    fn canceller(&self) -> Arc<dyn Canceller> {
        Arc::new(NoServer)
    }
}

/// Table `t` (id, name) with `n` rows in key order, in chunks of 1,000.
struct Mem {
    n: u64,
    fail_after: Option<usize>,
    /// This row's name is a 17 MB binary value instead.
    big: Option<u64>,
}

#[async_trait::async_trait]
impl BackupSource for Mem {
    async fn rows(&mut self, _table: &str) -> Result<TableRows> {
        let col = |name: &str, t: &str| SourceColumn {
            name: name.into(),
            type_name: t.into(),
            kind: ValueKind::Other,
        };
        let rows: Vec<Vec<Value>> = (1..=self.n)
            .map(|i| {
                let name = if self.big == Some(i) {
                    Value::Bytes(vec![7; 17 * 1024 * 1024])
                } else {
                    Value::Text(format!("it's {i}"))
                };
                vec![Value::Number(i.to_string()), name]
            })
            .collect();
        Ok(TableRows {
            source: Box::new(MemRows {
                columns: vec![col("id", "integer"), col("name", "text")],
                chunks: rows.chunks(1000).map(|c| c.to_vec()).collect(),
                fail_after: self.fail_after,
                sent: 0,
            }),
            overriding: false,
            key: vec!["id".into()],
        })
    }
}

#[derive(Default)]
struct Watch {
    cancel: AtomicBool,
    seen: Mutex<Vec<BackupProgress>>,
}

impl BackupObserver for Watch {
    fn progress(&self, p: &BackupProgress) {
        self.seen.lock().unwrap().push(p.clone());
    }
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
    fn reading(&self, _: Arc<dyn Canceller>) {}
}

fn script(rows: u64, drop_tables: bool) -> BackupScript {
    BackupScript {
        dialect: DialectKind::Postgres,
        header: BackupHeader {
            format: FORMAT_VERSION,
            made_by: made_by(),
            dialect: DialectKind::Postgres,
            server_version: "17.0".into(),
            database: "freight".into(),
            schema: Some("billing".into()),
            taken_at: "2026-10-16T22:00:00Z".into(),
            contents: vec![Content::Tables, Content::Rows],
            rows: vec![("billing.t".into(), rows)],
            not_included: vec!["grants and roles".into()],
            definer_removed: false,
            drop_tables,
        },
        settings: vec!["SET TimeZone = 'UTC';".into()],
        structure: vec!["CREATE TABLE \"billing\".\"t\" (id integer, name text);".into()],
        tables: vec![RowsTable {
            name: "t".into(),
            label: "billing.t".into(),
            table_sql: "\"billing\".\"t\"".into(),
            rows,
        }],
        after_rows: vec![
            "ALTER TABLE \"billing\".\"t\" ADD CONSTRAINT t_pkey PRIMARY KEY (id);".into(),
        ],
        finish: vec![],
        rows_per_statement: 500,
    }
}

fn partial(dir: &tempfile::TempDir) -> (std::path::PathBuf, crate::jobs::paths::PartialWriter) {
    let target = dir.path().join("freight.sql");
    let p = PartialFile::create(&target, false, PathUse::Backup, &outside_data()).unwrap();
    (target, p.writer())
}

fn nothing_left(dir: &tempfile::TempDir) {
    let left: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
    assert!(left.is_empty(), "{left:?}");
}

#[tokio::test]
async fn the_file_has_header_sections_rows_in_key_order_and_trailer() {
    let dir = tempfile::tempdir().unwrap();
    let (target, out) = partial(&dir);
    let watch = Watch::default();
    let (out, written) = write_script(
        &script(1_203, false),
        &mut Mem {
            n: 1_203,
            fail_after: None,
            big: None,
        },
        out,
        &target,
        &watch,
    )
    .await
    .unwrap();
    out.commit().unwrap();
    assert_eq!(written.rows, 1_203);
    // Setting, CREATE, 3 INSERTs (500, 500, 203), ALTER.
    assert_eq!(written.statements, 6);
    assert!(written.warnings.is_empty());
    let text = std::fs::read_to_string(&target).unwrap();
    assert_eq!(written.bytes, text.len() as u64);
    assert!(text.starts_with("-- Contura backup, format 1\n"));
    let at = |s: &str| {
        text.find(s)
            .unwrap_or_else(|| panic!("{s} missing:\n{text}"))
    };
    assert!(at("-- section: settings\n") < at("-- section: structure\n"));
    assert!(at("-- section: structure\n") < at("-- section: rows billing.t\n"));
    assert!(at("-- section: rows billing.t\n") < at("-- section: after-rows\n"));
    assert!(at("-- section: after-rows\n") < at("-- section: finish\n"));
    assert!(text.ends_with("-- contura-backup-end statements=6 rows=1203\n"));
    assert!(text.contains(
        "INSERT INTO \"billing\".\"t\" (\"id\", \"name\") VALUES\n(1, 'it''s 1'),\n(2, "
    ));
    // Key order: each id follows the one before it.
    let ids: Vec<u64> = text
        .lines()
        .filter_map(|l| l.strip_prefix('('))
        .map(|l| l.split(',').next().unwrap().parse().unwrap())
        .collect();
    assert_eq!(ids, (1..=1_203).collect::<Vec<_>>());
    let BackupFile::Contura { header, trailer } = read_header(&target).unwrap() else {
        panic!("a Contura Backup");
    };
    assert_eq!(header.rows, vec![("billing.t".to_string(), 1_203)]);
    assert_eq!((trailer.statements, trailer.rows), (6, 1_203));
    let last = watch.seen.lock().unwrap().last().cloned().unwrap();
    assert_eq!(
        (last.tables_done, last.tables_total, last.rows_done),
        (1, 1, 1_203)
    );
}

/// Fails with a full disk once `room` bytes are written.
struct Full {
    inner: crate::jobs::paths::PartialWriter,
    room: usize,
}

impl Write for Full {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if buf.len() > self.room {
            return Err(std::io::Error::from(std::io::ErrorKind::StorageFull));
        }
        self.room -= buf.len();
        self.inner.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

#[tokio::test]
async fn a_full_disk_gives_the_spec_message_and_deletes_the_partial() {
    let dir = tempfile::tempdir().unwrap();
    let (target, out) = partial(&dir);
    let err = write_script(
        &script(5_000, false),
        &mut Mem {
            n: 5_000,
            fail_after: None,
            big: None,
        },
        Full {
            inner: out,
            room: 4_000,
        },
        &target,
        &Watch::default(),
    )
    .await
    .err()
    .expect("the disk is full");
    assert_eq!(
        err.to_string(),
        format!(
            "Cannot write {}: the disk is full. The unfinished file was deleted.",
            target.display()
        )
    );
    nothing_left(&dir);
}

#[tokio::test]
async fn a_lost_connection_deletes_the_partial() {
    let dir = tempfile::tempdir().unwrap();
    let (target, out) = partial(&dir);
    let err = write_script(
        &script(3_000, false),
        &mut Mem {
            n: 3_000,
            fail_after: Some(2),
            big: None,
        },
        out,
        &target,
        &Watch::default(),
    )
    .await
    .err()
    .expect("the read fails");
    assert!(
        matches!(err, Error::Query(ref m) if m.contains("closed")),
        "{err:?}"
    );
    nothing_left(&dir);
}

#[tokio::test]
async fn a_cancel_deletes_the_partial() {
    let dir = tempfile::tempdir().unwrap();
    let (target, out) = partial(&dir);
    let watch = Watch::default();
    watch.cancel.store(true, Ordering::SeqCst);
    let err = write_script(
        &script(10, false),
        &mut Mem {
            n: 10,
            fail_after: None,
            big: None,
        },
        out,
        &target,
        &watch,
    )
    .await
    .err()
    .expect("cancelled");
    assert!(matches!(err, Error::Cancelled), "{err:?}");
    nothing_left(&dir);
}

#[tokio::test]
async fn a_count_that_moved_is_a_warning() {
    let dir = tempfile::tempdir().unwrap();
    let (target, out) = partial(&dir);
    let (_, written) = write_script(
        &script(12, false),
        &mut Mem {
            n: 10,
            fail_after: None,
            big: None,
        },
        out,
        &target,
        &Watch::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        written.warnings,
        ["billing.t: 10 rows were written, but the header counted 12 when the backup started."]
    );
}

#[test]
fn sqlite_infinity_is_written_back() {
    let k = DialectKind::Sqlite;
    assert_eq!(
        fix_value(k, Value::Number("inf".into())),
        Value::Number("9e999".into())
    );
    assert_eq!(
        fix_value(k, Value::Number("-inf".into())),
        Value::Number("-9e999".into())
    );
    assert_eq!(
        fix_value(DialectKind::MySql, Value::Number("inf".into())),
        Value::Number("inf".into())
    );
}

#[test]
fn grouping_commas() {
    assert_eq!(group(0), "0");
    assert_eq!(group(999), "999");
    assert_eq!(group(1_503), "1,503");
    assert_eq!(group(742_818), "742,818");
    assert_eq!(group(1_000_000), "1,000,000");
}

#[tokio::test]
async fn a_row_over_16_mb_fails_naming_its_key_and_deletes_the_partial() {
    let dir = tempfile::tempdir().unwrap();
    let (target, out) = partial(&dir);
    let err = write_script(
        &script(3, false),
        &mut Mem {
            n: 3,
            fail_after: None,
            big: Some(2),
        },
        out,
        &target,
        &Watch::default(),
    )
    .await
    .err()
    .expect("too large");
    assert_eq!(
        err.to_string(),
        "billing.t: the row with id = 2 is over 16 MB as SQL, so Restore could not read this file. \
         The unfinished file was deleted."
    );
    nothing_left(&dir);
}

#[test]
fn a_row_without_a_key_is_named_by_its_number() {
    let e = too_large("t", &["a".into()], &[], &[Value::Null], 1_204);
    assert!(
        e.to_string()
            .starts_with("t: row 1,204 is over 16 MB as SQL"),
        "{e}"
    );
}

#[tokio::test]
async fn each_table_end_is_sent_past_the_throttle() {
    #[derive(Default)]
    struct Now(Mutex<Vec<BackupProgress>>, AtomicBool);
    impl BackupObserver for Now {
        fn progress(&self, _: &BackupProgress) {}
        fn progress_now(&self, p: &BackupProgress) {
            self.0.lock().unwrap().push(p.clone());
        }
        fn cancelled(&self) -> bool {
            self.1.load(Ordering::SeqCst)
        }
        fn reading(&self, _: Arc<dyn Canceller>) {}
    }
    let dir = tempfile::tempdir().unwrap();
    let (target, out) = partial(&dir);
    let now = Now::default();
    write_script(
        &script(4, false),
        &mut Mem {
            n: 4,
            fail_after: None,
            big: None,
        },
        out,
        &target,
        &now,
    )
    .await
    .unwrap();
    let sent = now.0.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(
        (sent[0].tables_done, sent[0].tables_total, sent[0].rows_done),
        (1, 1, 4)
    );
}
