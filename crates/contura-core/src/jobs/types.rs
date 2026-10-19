//! The job contract: requests, plans, events and reports that cross IPC.
//! Every request field has a serde default, so an older or shorter request still reads.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::Error;
use crate::model::{Cell, ConnectionId, KeyPart, ObjectPath, SortSpec};
use crate::query::ResultColumn;
use crate::safety::StatementClass;

pub type JobId = Uuid;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum JobKind {
    #[default]
    Export,
    Import,
    ScriptImport,
    Check,
    /// Data Transfer (step 8).
    Transfer,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    #[default]
    Csv,
    Json,
    Xlsx,
    Sql,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Delimiter {
    #[default]
    Comma,
    Semicolon,
    Tab,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum NullText {
    #[default]
    EmptyCell,
    NullWord,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum BinaryText {
    #[default]
    Hex,
    Base64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum JsonLayout {
    #[default]
    Lines,
    Array,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum SqlTableName {
    #[default]
    AsSource,
    Unqualified,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum EmptyAs {
    #[default]
    Null,
    EmptyText,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum OnError {
    #[default]
    Stop,
    Skip,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CommitMode {
    #[default]
    Once,
    Every {
        rows: u64,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ExportOptions {
    pub delimiter: Delimiter,
    pub null_as: NullText,
    pub header: bool,
    pub bom: bool,
    pub binary: BinaryText,
    pub json_layout: JsonLayout,
    pub freeze_header: bool,
    pub rows_per_statement: u32,
    pub table_name: SqlTableName,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            delimiter: Delimiter::Comma,
            null_as: NullText::EmptyCell,
            header: true,
            bom: false,
            binary: BinaryText::Hex,
            json_layout: JsonLayout::Lines,
            freeze_header: true,
            rows_per_statement: 500,
            table_name: SqlTableName::AsSource,
        }
    }
}

/// What an export reads. An empty `columns` list means all columns, in table order.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExportSource {
    Table {
        path: ObjectPath,
        #[serde(default)]
        columns: Vec<String>,
        #[serde(default)]
        filter: Option<String>,
        #[serde(default)]
        sort: Option<SortSpec>,
        /// Selected rows by key; empty means every row.
        #[serde(default)]
        keys: Vec<Vec<KeyPart>>,
    },
    Query {
        #[serde(default)]
        database: Option<String>,
        #[serde(default)]
        sql: String,
        /// The result's output columns to keep, in this order: the ones the result panel
        /// shows. Empty keeps them all. A repeated name takes the next column of that name.
        #[serde(default)]
        columns: Vec<String>,
    },
    /// The rows a result already shows, as they are (D16).
    Rows {
        #[serde(default)]
        columns: Vec<ResultColumn>,
        #[serde(default)]
        rows: Vec<Vec<Cell>>,
    },
}

/// An empty query: the Core refuses it, so a request missing its source exports nothing.
impl Default for ExportSource {
    fn default() -> Self {
        ExportSource::Query {
            database: None,
            sql: String::new(),
            columns: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ExportRequest {
    pub connection_id: ConnectionId,
    pub source: ExportSource,
    pub format: Format,
    pub options: ExportOptions,
    pub path: PathBuf,
    pub rows_hint: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ExportPreview {
    /// The first lines of a text format.
    pub lines: Vec<String>,
    /// The first rows of a sheet, for Excel.
    pub sheet: Option<Vec<Vec<String>>>,
    pub encoding: String,
    pub bytes_per_row: u64,
    pub sample_rows: u32,
    pub notes: Vec<String>,
    /// False when the classifier does not call the statement Read (D16).
    pub query_read: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ImportOptions {
    /// None sniffs it from the file.
    pub delimiter: Option<Delimiter>,
    pub header: bool,
    pub empty_as: EmptyAs,
    pub on_error: OnError,
    pub commit: CommitMode,
    pub sheet: Option<String>,
    /// "Read the text NULL as NULL" (Q31), for CSV and Excel: a cell holding exactly
    /// `NULL` is NULL. Off by default. Contura's exports write no header marker for it,
    /// so it is never turned on from the file.
    pub null_word: bool,
}

impl Default for ImportOptions {
    fn default() -> Self {
        Self {
            delimiter: None,
            header: true,
            empty_as: EmptyAs::Null,
            on_error: OnError::Stop,
            commit: CommitMode::Once,
            sheet: None,
            null_word: false,
        }
    }
}

/// One file column and the table column it goes into; `into: None` leaves it out.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ColumnMap {
    pub file_column: usize,
    pub into: Option<String>,
    pub by_hand: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ImportRequest {
    pub connection_id: ConnectionId,
    pub table: ObjectPath,
    pub file: PathBuf,
    pub format: Format,
    pub options: ImportOptions,
    /// Empty means match by name.
    pub mapping: Vec<ColumnMap>,
}

impl Default for ImportRequest {
    fn default() -> Self {
        Self {
            connection_id: ConnectionId::nil(),
            table: ObjectPath {
                database: String::new(),
                schema: None,
                name: String::new(),
            },
            file: PathBuf::new(),
            format: Format::Csv,
            options: ImportOptions::default(),
            mapping: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RowCount {
    pub rows: u64,
    pub exact: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct FileSummary {
    pub format: Format,
    pub delimiter: Option<Delimiter>,
    /// "UTF-8" or "UTF-8 with BOM".
    pub encoding: String,
    pub bytes: u64,
    pub header: Vec<String>,
    /// The first 20 rows as text.
    pub rows: Vec<Vec<Option<String>>>,
    pub rows_estimate: RowCount,
    pub sheets: Vec<String>,
    pub contura_backup: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct PlannedColumn {
    pub into: String,
    pub type_sql: String,
    pub file_column: Option<usize>,
    pub note: Option<String>,
    pub blocks: Option<String>,
    /// Filled by the database: never offered as an Into column (Q11).
    pub generated: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct PreviewCell {
    pub text: Option<String>,
    pub problem: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct InsertShape {
    pub head: String,
    /// The first 4 rows of the first statement.
    pub first_rows: Vec<String>,
    pub rows_per_statement: u64,
    pub statements: u64,
    pub rows: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum JobVerdict {
    #[default]
    Ok,
    ReadOnly {
        connection: String,
    },
    NeedsConfirmation {
        connection: String,
        database: Option<String>,
        fingerprint: String,
        file_bytes: u64,
        file_sha256: String,
    },
    Blocked {
        reasons: Vec<String>,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ImportPlan {
    pub columns: Vec<PlannedColumn>,
    pub preview: Vec<Vec<PreviewCell>>,
    pub sample_insert: String,
    pub extra: Vec<String>,
    pub shape: InsertShape,
    pub warnings: Vec<String>,
    pub verdict: JobVerdict,
    /// The whole import runs in one transaction (Q28): false for a non-transactional
    /// table (MyISAM), for Commit every N, and when the table's storage could not be read.
    pub one_transaction: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ScriptAction {
    Run,
    Skip { reason: String },
    Refuse { reason: String },
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StatementKind {
    Create,
    Insert,
    Other,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptStatement {
    pub index: u32,
    pub line: u32,
    pub text: String,
    pub class: StatementClass,
    pub kind: StatementKind,
    pub action: ScriptAction,
    /// It would be skipped, and runs because Run as is is ticked (Q12).
    #[serde(default)]
    pub run_as_is: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ScriptRequest {
    pub connection_id: ConnectionId,
    pub database: Option<String>,
    pub path: PathBuf,
    pub run_as_is: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ConfirmItem {
    Exact { line: u32, text: String },
    Shape { line: u32, shape: InsertShape },
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScriptPlan {
    pub statements: u64,
    pub creates: u64,
    pub inserts: u64,
    pub skipped: Vec<ScriptStatement>,
    pub refused: Vec<ScriptStatement>,
    pub own_transactions: bool,
    pub has_ddl: bool,
    pub contura_backup: bool,
    /// The first 50 statements.
    pub first: Vec<ScriptStatement>,
    /// The first 200 items the Production confirmation shows.
    pub confirm: Vec<ConfirmItem>,
    pub confirm_more: u64,
    pub bytes: u64,
    pub sha256: String,
    pub verdict: JobVerdict,
    /// The script runs in one transaction (Q28): false when the file manages its own
    /// transactions, holds a statement that cannot run inside one, or is MySQL with DDL.
    #[serde(default)]
    pub one_transaction: bool,
    /// Skipped statements past the 1,000 that `skipped` holds.
    #[serde(default)]
    pub skipped_more: u64,
    /// Refused statements past the 1,000 that `refused` holds.
    #[serde(default)]
    pub refused_more: u64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum JobPhase {
    Checking,
    #[default]
    Reading,
    Writing,
    Committing,
    RollingBack,
}

/// What `JobCtx::progress` takes: the fields of `JobEvent::Progress`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct JobProgress {
    pub phase: JobPhase,
    pub table: Option<String>,
    pub rows_done: u64,
    pub rows_total: Option<u64>,
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    pub statements_done: u64,
    pub file_row: Option<u64>,
    /// A Data Transfer's current table: its rows so far and its total. `rows_done` and
    /// `rows_total` count every table, so the status bar shows the whole run.
    pub table_rows: Option<u64>,
    pub table_total: Option<u64>,
}

impl JobProgress {
    /// Rows first, then bytes; None when neither total is known.
    pub fn percent(&self) -> Option<u8> {
        let of = |done: u64, total: u64| -> u8 {
            if total == 0 {
                return 100;
            }
            (done.min(total).saturating_mul(100) / total) as u8
        };
        match (self.rows_total, self.bytes_total) {
            (Some(t), _) => Some(of(self.rows_done, t)),
            (None, Some(t)) => Some(of(self.bytes_done, t)),
            _ => None,
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum JobEvent {
    Progress {
        phase: JobPhase,
        table: Option<String>,
        rows_done: u64,
        rows_total: Option<u64>,
        bytes_done: u64,
        bytes_total: Option<u64>,
        statements_done: u64,
        file_row: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        table_rows: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        table_total: Option<u64>,
    },
    Warning {
        message: String,
    },
    RowSkipped {
        file_row: u64,
        column: Option<String>,
        message: String,
    },
    Finished {
        report: JobReport,
    },
    Failed {
        error: Error,
        /// The rows a writing job left in the target (Q27): committed batches under
        /// Commit every N, or what a non-transactional table kept. Absent means 0.
        #[serde(skip_serializing_if = "Option::is_none")]
        rows_committed: Option<u64>,
    },
}

impl From<JobProgress> for JobEvent {
    fn from(p: JobProgress) -> Self {
        JobEvent::Progress {
            phase: p.phase,
            table: p.table,
            rows_done: p.rows_done,
            rows_total: p.rows_total,
            bytes_done: p.bytes_done,
            bytes_total: p.bytes_total,
            statements_done: p.statements_done,
            file_row: p.file_row,
            table_rows: p.table_rows,
            table_total: p.table_total,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CellProblem {
    pub file_row: u64,
    pub column: String,
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CheckReport {
    pub rows: u64,
    pub failing: u64,
    /// The first 20 problems.
    pub first: Vec<CellProblem>,
    pub sha256: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct JobReport {
    pub kind: JobKind,
    pub rows_read: u64,
    pub rows_written: u64,
    pub statements: u64,
    pub skipped: u64,
    pub warnings: Vec<String>,
    pub elapsed_ms: u64,
    pub file: Option<PathBuf>,
    pub bytes: u64,
    pub committed: u64,
    pub check: Option<CheckReport>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct JobSummary {
    pub id: JobId,
    pub kind: JobKind,
    pub connection_id: ConnectionId,
    /// Such as "Exporting orders".
    pub label: String,
    pub percent: Option<u8>,
    pub started_at_ms: i64,
}

/// Where a job stopped: a file row or line, a table, a statement number.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct JobPosition {
    pub file_row: Option<u64>,
    pub line: Option<u64>,
    pub table: Option<String>,
    pub statement: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_options_from_empty_json_are_defaults() {
        let o: ExportOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(o, ExportOptions::default());
        assert_eq!(o.delimiter, Delimiter::Comma);
        assert_eq!(o.null_as, NullText::EmptyCell);
        assert!(o.header);
        assert!(!o.bom);
        assert_eq!(o.binary, BinaryText::Hex);
        assert_eq!(o.json_layout, JsonLayout::Lines);
        assert!(o.freeze_header);
        assert_eq!(o.rows_per_statement, 500);
        assert_eq!(o.table_name, SqlTableName::AsSource);

        let i: ImportOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(i.delimiter, None);
        assert!(i.header);
        assert_eq!(i.commit, CommitMode::Once);
        assert_eq!(i.empty_as, EmptyAs::Null);
        assert_eq!(i.on_error, OnError::Stop);
        assert!(!i.null_word);
        let p: ImportPlan = serde_json::from_str("{}").unwrap();
        assert!(!p.one_transaction);
        assert_eq!(
            serde_json::to_value(ImportPlan::default()).unwrap()["oneTransaction"],
            false
        );

        let r: ExportRequest = serde_json::from_str("{}").unwrap();
        assert_eq!(r.options, ExportOptions::default());
        assert_eq!(r.format, Format::Csv);
        let r: ImportRequest = serde_json::from_str("{}").unwrap();
        assert!(r.mapping.is_empty());
    }

    #[test]
    fn tagged_requests_read_from_camel_case_json() {
        let s: ExportSource = serde_json::from_value(serde_json::json!({
            "kind": "table",
            "path": {"database": "shop", "schema": null, "name": "orders"},
        }))
        .unwrap();
        assert!(
            matches!(s, ExportSource::Table { ref columns, ref keys, .. }
            if columns.is_empty() && keys.is_empty())
        );
        let c: CommitMode =
            serde_json::from_value(serde_json::json!({"kind":"every","rows":1000})).unwrap();
        assert_eq!(c, CommitMode::Every { rows: 1000 });
        let k: JobKind = serde_json::from_value(serde_json::json!("scriptImport")).unwrap();
        assert_eq!(k, JobKind::ScriptImport);
    }

    #[test]
    fn job_event_progress_shape() {
        let e: JobEvent = JobProgress {
            phase: JobPhase::Writing,
            table: Some("orders".into()),
            rows_done: 10,
            rows_total: Some(100),
            bytes_done: 2048,
            bytes_total: None,
            statements_done: 1,
            file_row: Some(10),
            ..JobProgress::default()
        }
        .into();
        assert_eq!(
            serde_json::to_value(e).unwrap(),
            serde_json::json!({"kind":"progress","phase":"writing","table":"orders",
                "rowsDone":10,"rowsTotal":100,"bytesDone":2048,"bytesTotal":null,
                "statementsDone":1,"fileRow":10})
        );
        // A transfer adds its current table's count; other jobs send neither field.
        let e: JobEvent = JobProgress {
            table: Some("sales".into()),
            rows_done: 700,
            table_rows: Some(200),
            table_total: Some(500),
            ..JobProgress::default()
        }
        .into();
        let v = serde_json::to_value(e).unwrap();
        assert_eq!(
            (v["tableRows"].clone(), v["tableTotal"].clone()),
            (200.into(), 500.into())
        );
        assert_eq!(
            serde_json::to_value(JobEvent::Failed {
                error: Error::Cancelled,
                rows_committed: None,
            })
            .unwrap(),
            serde_json::json!({"kind":"failed","error":{"kind":"cancelled"}})
        );
        assert_eq!(
            serde_json::to_value(JobEvent::Failed {
                error: Error::Cancelled,
                rows_committed: Some(10_000),
            })
            .unwrap(),
            serde_json::json!({"kind":"failed","error":{"kind":"cancelled"},"rowsCommitted":10000})
        );
        assert_eq!(
            serde_json::to_value(JobEvent::RowSkipped {
                file_row: 3,
                column: None,
                message: "x".into()
            })
            .unwrap(),
            serde_json::json!({"kind":"rowSkipped","fileRow":3,"column":null,"message":"x"})
        );
    }

    #[test]
    fn verdict_shape() {
        let v = JobVerdict::NeedsConfirmation {
            connection: "freight-prod".into(),
            database: Some("freight".into()),
            fingerprint: "ab".into(),
            file_bytes: 212,
            file_sha256: "cd".into(),
        };
        assert_eq!(
            serde_json::to_value(v).unwrap(),
            serde_json::json!({"kind":"needsConfirmation","connection":"freight-prod",
                "database":"freight","fingerprint":"ab","fileBytes":212,"fileSha256":"cd"})
        );
    }

    #[test]
    fn percent_uses_rows_then_bytes() {
        let mut p = JobProgress {
            rows_done: 32,
            rows_total: Some(100),
            bytes_done: 1,
            bytes_total: Some(2),
            ..Default::default()
        };
        assert_eq!(p.percent(), Some(32));
        p.rows_total = None;
        assert_eq!(p.percent(), Some(50));
        p.bytes_total = None;
        assert_eq!(p.percent(), None);
    }
}
