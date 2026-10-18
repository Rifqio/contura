//! SQL: INSERT statements from `InsertBuilder` (Task 4).
//!
//! The file starts with one comment line, `-- Contura export of <table> for <Dialect>`,
//! then holds statements of `rows_per_statement` rows, each ending `;` and a line feed.
//! A statement is also cut at 1 MiB, so the file loads back through the import, which
//! runs one statement at a time. Zero rows give the comment line alone.
//!
//! Values are written as the source holds them (Q34 I2): an export never refuses or
//! coerces one. A MySQL spatial value is `ST_GeomFromText(<wkt>, <srid>)` (Q34 I1).

use std::io::Write;

use super::{Counting, FormatWriter, WriteSummary};
use crate::common::{sql_ident, sql_table};
use crate::error::Result;
use crate::jobs::insert::{
    BuiltStatement, Conversion, InsertBuilder, InsertLimits, conversion_for, is_float_word,
};
use crate::jobs::limits::MAX_STATEMENT_BYTES;
use crate::jobs::paths::PartialWriter;
use crate::jobs::source::{Chunk, SourceColumn, Value};
use crate::jobs::types::{ExportOptions, SqlTableName};
use crate::model::{DialectKind, ObjectPath};

/// The Dialect's name as the comment line writes it.
pub fn dialect_name(kind: DialectKind) -> &'static str {
    match kind {
        DialectKind::MySql => "MySQL",
        DialectKind::Postgres => "PostgreSQL",
        DialectKind::Sqlite => "SQLite",
    }
}

/// The table an export's INSERTs name: qualified as in the source (MySQL database,
/// PostgreSQL schema, SQLite schema), or the bare name with "Unqualified".
pub fn export_table_sql(kind: DialectKind, path: &ObjectPath, name: SqlTableName) -> String {
    match name {
        SqlTableName::AsSource => {
            sql_table(kind, path).unwrap_or_else(|_| sql_ident(kind, &path.name))
        }
        SqlTableName::Unqualified => sql_ident(kind, &path.name),
    }
}

pub struct SqlWriter<W: Write + Send> {
    out: Counting<W>,
    kind: DialectKind,
    table_sql: String,
    opts: ExportOptions,
    builder: Option<InsertBuilder>,
    rows: u64,
    names: Vec<String>,
    conversions: Vec<Conversion>,
    /// NaN and Infinity written as NULL, by column (Q32b).
    nulled: Vec<u64>,
    row: Vec<Value>,
    /// A statement over this many bytes cannot be run by the import (M9).
    huge: usize,
    huge_statements: u64,
}

impl<W: Write + Send> SqlWriter<W> {
    /// `table_sql` is the table as it goes after INTO, already quoted (see
    /// `export_table_sql`).
    pub fn new(out: W, kind: DialectKind, table_sql: String, opts: &ExportOptions) -> Self {
        Self {
            out: Counting::new(out),
            kind,
            table_sql,
            opts: opts.clone(),
            builder: None,
            rows: 0,
            names: Vec::new(),
            conversions: Vec::new(),
            nulled: Vec::new(),
            row: Vec::new(),
            huge: MAX_STATEMENT_BYTES,
            huge_statements: 0,
        }
    }

    /// The comment line, and the INSERT head for these columns.
    pub fn write_header(&mut self, columns: &[SourceColumn]) -> Result<()> {
        // A name holding a line break must not end the comment early.
        let table: String = self
            .table_sql
            .chars()
            .map(|c| if c == '\r' || c == '\n' { ' ' } else { c })
            .collect();
        let line = format!(
            "-- Contura export of {table} for {}\n",
            dialect_name(self.kind)
        );
        self.out.put(line.as_bytes())?;
        self.names = columns.iter().map(|c| c.name.clone()).collect();
        self.conversions = columns
            .iter()
            .map(|c| conversion_for(self.kind, &c.type_name))
            .collect();
        self.nulled = vec![0; columns.len()];
        let limits = InsertLimits {
            rows: (self.opts.rows_per_statement as usize).max(1),
            ..InsertLimits::default()
        };
        self.builder = Some(
            InsertBuilder::new(
                self.kind,
                self.table_sql.clone(),
                &self.names,
                self.conversions.clone(),
                limits,
                false,
            )
            .as_stored(),
        );
        Ok(())
    }

    pub fn write_rows(&mut self, chunk: &Chunk) -> Result<()> {
        let mut builder = self
            .builder
            .take()
            .ok_or_else(|| crate::error::Error::InvalidInput("write_header comes first".into()))?;
        let done = (|| {
            for source in &chunk.rows {
                self.rows += 1;
                self.row.clear();
                for (i, v) in source.iter().enumerate() {
                    // Only PostgreSQL floats hold NaN and Infinity; elsewhere NULL (Q32b).
                    // A source number in any spelling counts (Q34 I3: SQLite's `inf`).
                    if self.kind != DialectKind::Postgres
                        && matches!(v, Value::Number(_))
                        && is_float_word(v)
                    {
                        self.nulled[i] += 1;
                        self.row.push(Value::Null);
                    } else {
                        self.row.push(v.clone());
                    }
                }
                if let Some(s) = builder.push(&self.row, self.rows)? {
                    self.put_statement(s)?;
                }
            }
            Ok(())
        })();
        self.builder = Some(builder);
        done
    }

    pub fn bytes(&self) -> u64 {
        self.out.bytes
    }

    #[cfg(test)]
    fn with_huge(mut self, bytes: usize) -> Self {
        self.huge = bytes;
        self
    }

    /// One warning per column that had NaN or Infinity the Dialect cannot store (Q32b),
    /// and one for statements over 16 MB, the most the script import reads (Q38),
    /// counting the one still open (M9).
    pub fn warnings(&self) -> Vec<String> {
        let open = self
            .builder
            .as_ref()
            .is_some_and(|b| b.open_bytes() > self.huge);
        let huge = self.huge_statements + u64::from(open);
        let mut out: Vec<String> = self
            .nulled
            .iter()
            .zip(&self.names)
            .filter(|(n, _)| **n > 0)
            .map(|(n, name)| {
                let (values, are, it) = if *n == 1 {
                    ("1 value".to_string(), "is", "it is")
                } else {
                    (format!("{n} values"), "are", "they are")
                };
                format!(
                    "{values} of {name} {are} NaN or Infinity, which {} cannot store; {it} written as NULL.",
                    dialect_name(self.kind)
                )
            })
            .collect();
        match huge {
            0 => {}
            1 => out.push(
                "1 statement is larger than 16 MB; the import and most servers cannot run it."
                    .into(),
            ),
            n => out.push(format!(
                "{n} statements are larger than 16 MB; the import and most servers cannot run them."
            )),
        }
        out
    }

    /// Writes the last statement, flushes, and hands back the output.
    pub fn end(mut self) -> Result<W> {
        if let Some(s) = self.builder.as_mut().and_then(InsertBuilder::finish) {
            self.put_statement(s)?;
        }
        self.out.inner.flush().map_err(super::write_err)?;
        Ok(self.out.inner)
    }

    fn put_statement(&mut self, s: BuiltStatement) -> Result<()> {
        if s.sql.len() > self.huge {
            self.huge_statements += 1;
        }
        self.out.put(s.sql.as_bytes())?;
        self.out.put(b";\n")
    }
}

impl FormatWriter for SqlWriter<PartialWriter> {
    fn begin(&mut self, columns: &[SourceColumn]) -> Result<()> {
        self.write_header(columns)
    }
    fn write_chunk(&mut self, chunk: &Chunk) -> Result<()> {
        self.write_rows(chunk)
    }
    fn summary(&self) -> WriteSummary {
        WriteSummary {
            bytes: self.bytes(),
            warnings: self.warnings(),
        }
    }
    fn finish(self: Box<Self>) -> Result<PartialWriter> {
        (*self).end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::paths::{PartialFile, PathUse, outside_data};
    use crate::jobs::source::{Value, ValueKind};

    fn cols() -> Vec<SourceColumn> {
        vec![
            SourceColumn {
                name: "id".into(),
                type_name: "integer".into(),
                kind: ValueKind::Integer,
            },
            SourceColumn {
                name: "name".into(),
                type_name: "text".into(),
                kind: ValueKind::Text,
            },
        ]
    }

    fn rows(n: usize) -> Chunk {
        let mut c = Chunk::default();
        for i in 1..=n {
            c.rows.push(vec![
                Value::Number(i.to_string()),
                Value::Text(format!("n{i}")),
            ]);
        }
        c
    }

    fn export(
        kind: DialectKind,
        table_sql: &str,
        opts: &ExportOptions,
        chunks: &[Chunk],
    ) -> String {
        let mut w = SqlWriter::new(Vec::new(), kind, table_sql.to_string(), opts);
        w.write_header(&cols()).unwrap();
        for c in chunks {
            w.write_rows(c).unwrap();
        }
        // The open statement is written at the end, so `bytes` lags by at most one.
        let n = w.bytes();
        let out = String::from_utf8(w.end().unwrap()).unwrap();
        assert!(n <= out.len() as u64);
        out
    }

    #[test]
    fn rows_per_statement_100_500_1000() {
        for per in [100u32, 500, 1000] {
            let opts = ExportOptions {
                rows_per_statement: per,
                ..ExportOptions::default()
            };
            // 2,345 rows in chunks of 1,000, as the pipeline sends them.
            let chunks = [rows(1000), rows(1000), rows(345)];
            let out = export(DialectKind::Postgres, "\"public\".\"t\"", &opts, &chunks);
            let mut lines = out.lines();
            assert_eq!(
                lines.next().unwrap(),
                "-- Contura export of \"public\".\"t\" for PostgreSQL"
            );
            let statements: Vec<&str> = out.split(";\n").filter(|s| !s.is_empty()).collect();
            let want = 2345usize.div_ceil(per as usize);
            // The comment line rides on the first piece.
            assert_eq!(statements.len(), want, "{per}");
            for (i, s) in statements.iter().enumerate() {
                let n = s.matches("\n(").count();
                let full = if i + 1 == want {
                    2345 - per as usize * (want - 1)
                } else {
                    per as usize
                };
                assert_eq!(n, full, "{per} statement {i}");
                assert!(s.contains("INSERT INTO \"public\".\"t\" (\"id\", \"name\") VALUES\n"));
            }
            assert!(out.ends_with(";\n"));
        }
    }

    #[test]
    fn unqualified_table_name() {
        let pg = ObjectPath {
            database: "app".into(),
            schema: Some("sales".into()),
            name: "menu items".into(),
        };
        let my = ObjectPath {
            database: "shop".into(),
            schema: None,
            name: "menu`items".into(),
        };
        let lite = ObjectPath {
            database: "main".into(),
            schema: None,
            name: "t".into(),
        };
        use DialectKind::*;
        assert_eq!(
            export_table_sql(Postgres, &pg, SqlTableName::AsSource),
            "\"sales\".\"menu items\""
        );
        assert_eq!(
            export_table_sql(Postgres, &pg, SqlTableName::Unqualified),
            "\"menu items\""
        );
        assert_eq!(
            export_table_sql(MySql, &my, SqlTableName::AsSource),
            "`shop`.`menu``items`"
        );
        assert_eq!(
            export_table_sql(MySql, &my, SqlTableName::Unqualified),
            "`menu``items`"
        );
        assert_eq!(
            export_table_sql(Sqlite, &lite, SqlTableName::AsSource),
            "\"main\".\"t\""
        );
        assert_eq!(
            export_table_sql(Sqlite, &lite, SqlTableName::Unqualified),
            "\"t\""
        );
        // A PostgreSQL path without a schema is written unqualified.
        let bare = ObjectPath {
            schema: None,
            ..pg.clone()
        };
        assert_eq!(
            export_table_sql(Postgres, &bare, SqlTableName::AsSource),
            "\"menu items\""
        );

        let out = export(
            MySql,
            &export_table_sql(MySql, &my, SqlTableName::Unqualified),
            &ExportOptions::default(),
            &[rows(2)],
        );
        assert_eq!(
            out,
            "-- Contura export of `menu``items` for MySQL\n\
             INSERT INTO `menu``items` (`id`, `name`) VALUES\n(1, 'n1'),\n(2, 'n2');\n"
        );
    }

    #[test]
    fn comment_line_cannot_break_out() {
        let table = sql_ident(DialectKind::Sqlite, "x\nDROP TABLE y;\r");
        let out = export(DialectKind::Sqlite, &table, &ExportOptions::default(), &[]);
        assert_eq!(out.lines().count(), 1, "{out:?}");
        assert!(out.starts_with("-- Contura export of \"x DROP TABLE y; \" for SQLite"));
    }

    #[test]
    fn literals_follow_column_types() {
        let columns = vec![
            SourceColumn {
                name: "ok".into(),
                type_name: "tinyint(1)".into(),
                kind: ValueKind::Bool,
            },
            SourceColumn {
                name: "data".into(),
                type_name: "blob".into(),
                kind: ValueKind::Binary,
            },
            SourceColumn {
                name: "at".into(),
                type_name: "datetime".into(),
                kind: ValueKind::Timestamp,
            },
        ];
        let mut w = SqlWriter::new(
            Vec::new(),
            DialectKind::MySql,
            "`t`".into(),
            &ExportOptions::default(),
        );
        w.write_header(&columns).unwrap();
        w.write_rows(&Chunk {
            rows: vec![vec![
                Value::Number("1".into()),
                Value::Bytes(vec![1, 2]),
                Value::Text("2024-01-02 03:04:05".into()),
            ]],
            bytes: 0,
        })
        .unwrap();
        let out = String::from_utf8(w.end().unwrap()).unwrap();
        assert!(
            out.ends_with("VALUES\n(1, X'0102', '2024-01-02 03:04:05');\n"),
            "{out}"
        );
    }

    #[test]
    fn nan_and_infinity_per_dialect() {
        // Q32b: PostgreSQL floats can hold NaN and Infinity; MySQL and SQLite cannot.
        let columns = vec![SourceColumn {
            name: "score".into(),
            type_name: "double precision".into(),
            kind: ValueKind::Float,
        }];
        let chunk = Chunk {
            rows: ["NaN", "Infinity", "-Infinity", "1.5"]
                .iter()
                .map(|v| vec![Value::Number(v.to_string())])
                .collect(),
            bytes: 0,
        };
        let run = |kind| {
            let mut w = SqlWriter::new(Vec::new(), kind, "t".into(), &ExportOptions::default());
            w.write_header(&columns).unwrap();
            w.write_rows(&chunk).unwrap();
            let warnings = w.warnings();
            (String::from_utf8(w.end().unwrap()).unwrap(), warnings)
        };
        let (out, warnings) = run(DialectKind::Postgres);
        assert!(
            out.ends_with(
                "VALUES\n('NaN'::float8),\n('Infinity'::float8),\n('-Infinity'::float8),\n(1.5);\n"
            ),
            "{out}"
        );
        assert!(warnings.is_empty());
        for (kind, name) in [
            (DialectKind::MySql, "MySQL"),
            (DialectKind::Sqlite, "SQLite"),
        ] {
            let (out, warnings) = run(kind);
            assert!(
                out.ends_with("VALUES\n(NULL),\n(NULL),\n(NULL),\n(1.5);\n"),
                "{out}"
            );
            assert_eq!(
                warnings,
                vec![format!(
                    "3 values of score are NaN or Infinity, which {name} cannot store; they are written as NULL."
                )]
            );
        }
    }

    fn one_column(
        kind: DialectKind,
        name: &str,
        type_name: &str,
        values: Vec<Value>,
    ) -> (String, Vec<String>) {
        let columns = vec![SourceColumn {
            name: name.into(),
            type_name: type_name.into(),
            kind: ValueKind::Other,
        }];
        let mut w = SqlWriter::new(Vec::new(), kind, "t".into(), &ExportOptions::default());
        w.write_header(&columns).unwrap();
        w.write_rows(&Chunk {
            rows: values.into_iter().map(|v| vec![v]).collect(),
            bytes: 0,
        })
        .unwrap();
        let warnings = w.warnings();
        (String::from_utf8(w.end().unwrap()).unwrap(), warnings)
    }

    #[test]
    fn geometry_on_mysql() {
        // Q34 I1: WKT with the column's SRID, or the value's own `SRID=n;`.
        let (out, _) = one_column(
            DialectKind::MySql,
            "at",
            "point srid 4326",
            vec![Value::Text("POINT(1 2)".into()), Value::Null],
        );
        assert!(
            out.ends_with("VALUES\n(ST_GeomFromText('POINT(1 2)', 4326)),\n(NULL);\n"),
            "{out}"
        );
        let (out, _) = one_column(
            DialectKind::MySql,
            "shape",
            "geometry",
            vec![Value::Text("SRID=3857;POLYGON((0 0,1 0,1 1,0 0))".into())],
        );
        assert!(
            out.ends_with("VALUES\n(ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 0))', 3857));\n"),
            "{out}"
        );
    }

    #[test]
    fn values_as_stored() {
        // Q34 I2: an export never refuses or rewrites a value the source holds.
        let (out, w) = one_column(
            DialectKind::MySql,
            "flag",
            "tinyint(1)",
            vec![Value::Number("2".into()), Value::Number("0".into())],
        );
        assert!(out.ends_with("VALUES\n(2),\n(0);\n"), "{out}");
        assert!(w.is_empty());
        let (out, _) = one_column(
            DialectKind::Sqlite,
            "n",
            "INTEGER",
            vec![Value::Text("".into()), Value::Number("7".into())],
        );
        assert!(out.ends_with("VALUES\n(''),\n(7);\n"), "{out}");
        let (out, _) = one_column(
            DialectKind::Sqlite,
            "ok",
            "BOOLEAN",
            vec![Value::Text("yes".into()), Value::Number("2".into())],
        );
        assert!(out.ends_with("VALUES\n('yes'),\n(2);\n"), "{out}");
    }

    #[test]
    fn sqlite_infinity_is_null_with_warning() {
        // Q34 I3: SQLite spells them inf and -inf.
        let (out, warnings) = one_column(
            DialectKind::Sqlite,
            "score",
            "REAL",
            vec![
                Value::Number("inf".into()),
                Value::Number("-inf".into()),
                Value::Number("2.5".into()),
            ],
        );
        assert!(out.ends_with("VALUES\n(NULL),\n(NULL),\n(2.5);\n"), "{out}");
        assert_eq!(
            warnings,
            vec![
                "2 values of score are NaN or Infinity, which SQLite cannot store; they are written as NULL."
                    .to_string()
            ]
        );
        let (_, warnings) = one_column(
            DialectKind::MySql,
            "score",
            "double",
            vec![Value::Number("NaN".into())],
        );
        assert_eq!(
            warnings,
            vec![
                "1 value of score is NaN or Infinity, which MySQL cannot store; it is written as NULL."
                    .to_string()
            ]
        );
    }

    #[test]
    fn huge_statement_warns() {
        let columns = cols();
        let mut w = SqlWriter::new(
            Vec::new(),
            DialectKind::Sqlite,
            "t".into(),
            &ExportOptions::default(),
        )
        .with_huge(1000);
        w.write_header(&columns).unwrap();
        w.write_rows(&Chunk {
            rows: vec![
                vec![Value::Number("1".into()), Value::Text("x".repeat(2000))],
                vec![Value::Number("2".into()), Value::Text("small".into())],
            ],
            bytes: 0,
        })
        .unwrap();
        // The open statement counts too, so the summary before `finish` has it.
        assert_eq!(
            w.warnings(),
            vec![
                "1 statement is larger than 16 MB; the import and most servers cannot run it."
                    .to_string()
            ]
        );
        // Q38: the warning starts where the script import stops.
        let w = SqlWriter::new(
            Vec::new(),
            DialectKind::Sqlite,
            "t".into(),
            &ExportOptions::default(),
        );
        assert_eq!(w.huge, MAX_STATEMENT_BYTES);
    }

    #[test]
    fn sqlite_load_back() {
        // M8: the file runs in SQLite and gives back the rows it was made from.
        let columns = vec![
            SourceColumn {
                name: "id".into(),
                type_name: "INTEGER".into(),
                kind: ValueKind::Integer,
            },
            SourceColumn {
                name: "name".into(),
                type_name: "TEXT".into(),
                kind: ValueKind::Text,
            },
            SourceColumn {
                name: "data".into(),
                type_name: "BLOB".into(),
                kind: ValueKind::Binary,
            },
            SourceColumn {
                name: "score".into(),
                type_name: "REAL".into(),
                kind: ValueKind::Float,
            },
        ];
        let big = "b".repeat(400 * 1024);
        let rows = vec![
            vec![
                Value::Number("1".into()),
                Value::Text(r"it's a\b ñ".into()),
                Value::Bytes(vec![0, 1, 255]),
                Value::Number("1.5".into()),
            ],
            vec![
                Value::Text("".into()),
                Value::Null,
                Value::Bytes(vec![]),
                Value::Number("inf".into()),
            ],
            vec![
                Value::Number("3".into()),
                Value::Text(big.clone()),
                Value::Null,
                Value::Number("-2".into()),
            ],
            vec![
                Value::Number("4".into()),
                Value::Text(big.clone()),
                Value::Null,
                Value::Null,
            ],
            vec![
                Value::Number("5".into()),
                Value::Text(big.clone()),
                Value::Null,
                Value::Null,
            ],
        ];
        let mut w = SqlWriter::new(
            Vec::new(),
            DialectKind::Sqlite,
            "\"t\"".into(),
            &ExportOptions::default(),
        );
        w.write_header(&columns).unwrap();
        w.write_rows(&Chunk { rows, bytes: 0 }).unwrap();
        let sql = String::from_utf8(w.end().unwrap()).unwrap();
        // Three 400 KB rows pass 1 MiB, so the file has two statements.
        assert_eq!(sql.matches("INSERT INTO").count(), 2);

        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE t (id INTEGER, name TEXT, data BLOB, score REAL)")
            .unwrap();
        db.execute_batch(&sql).unwrap();
        let mut stmt = db
            .prepare("SELECT typeof(id), id, name, data, score FROM t ORDER BY rowid")
            .unwrap();
        type Row = (
            String,
            rusqlite::types::Value,
            Option<String>,
            Option<Vec<u8>>,
            Option<f64>,
        );
        let got: Vec<Row> = stmt
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        use rusqlite::types::Value as V;
        assert_eq!(got.len(), 5);
        assert_eq!(
            got[0],
            (
                "integer".to_string(),
                V::Integer(1),
                Some(r"it's a\b ñ".to_string()),
                Some(vec![0, 1, 255]),
                Some(1.5)
            )
        );
        assert_eq!(
            got[1],
            (
                "text".to_string(),
                V::Text(String::new()),
                None,
                Some(vec![]),
                None
            )
        );
        assert_eq!(got[2].2.as_deref(), Some(big.as_str()));
        assert_eq!(got[2].4, Some(-2.0));
        assert_eq!(got[4].1, V::Integer(5));
    }

    #[test]
    fn zero_rows_sql_and_xlsx() {
        let out = export(
            DialectKind::Postgres,
            "\"t\"",
            &ExportOptions::default(),
            &[Chunk::default()],
        );
        assert_eq!(out, "-- Contura export of \"t\" for PostgreSQL\n");

        // The Excel half: a sheet holding only its header.
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("empty.xlsx");
        let out = PartialFile::create(&target, false, PathUse::Export, &outside_data())
            .unwrap()
            .writer();
        let mut w: Box<dyn FormatWriter> = Box::new(
            super::super::xlsx::XlsxWriter::new(out, "t", &ExportOptions::default()).unwrap(),
        );
        w.begin(&cols()).unwrap();
        w.write_chunk(&Chunk::default()).unwrap();
        w.finish().unwrap().commit().unwrap();
        use calamine::{Data, Reader, Xlsx, open_workbook};
        let mut book: Xlsx<_> = open_workbook(&target).unwrap();
        assert_eq!(book.sheet_names(), vec!["t".to_string()]);
        let range = book.worksheet_range("t").unwrap();
        let got: Vec<Vec<Data>> = range.rows().map(|r| r.to_vec()).collect();
        assert_eq!(
            got,
            vec![vec![Data::String("id".into()), Data::String("name".into())]]
        );
    }

    #[test]
    fn finished_writer_commits() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("t.sql");
        let out = PartialFile::create(&target, false, PathUse::Export, &outside_data())
            .unwrap()
            .writer();
        let mut w: Box<dyn FormatWriter> = Box::new(SqlWriter::new(
            out,
            DialectKind::Sqlite,
            "\"t\"".into(),
            &ExportOptions::default(),
        ));
        w.begin(&cols()).unwrap();
        w.write_chunk(&rows(1)).unwrap();
        assert!(w.summary().bytes > 0);
        let committed = w.finish().unwrap().commit().unwrap();
        assert_eq!(committed, std::fs::metadata(&target).unwrap().len());
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "-- Contura export of \"t\" for SQLite\nINSERT INTO \"t\" (\"id\", \"name\") VALUES\n(1, 'n1');\n"
        );
    }
}
