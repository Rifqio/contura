use serde::Serialize;

use std::path::PathBuf;

use crate::ai::AiError;
use crate::jobs::types::JobPosition;
use crate::model::KeyPart;

#[derive(thiserror::Error, Debug, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum Error {
    #[error("could not connect: {0}")]
    Connect(String),
    #[error("authentication failed: {0}")]
    Auth(String),
    #[error("query failed: {0}")]
    Query(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("table has no primary key")]
    NoPrimaryKey,
    #[error("value is {0} bytes, over the 16 MiB limit")]
    ValueTooLarge(u64),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("store error: {0}")]
    Store(String),
    #[error("secret store error: {0}")]
    Secret(String),
    /// Reading or writing a file the user chose (Schema Models, exports).
    #[error("file error: {0}")]
    File(String),
    #[error("the query was cancelled")]
    Cancelled,
    /// The Connection's timeout, in seconds.
    #[error("stopped after {0} s")]
    TimedOut(u32),
    #[error("{0}")]
    Ai(AiError),
    /// The index of the first statement that writes.
    #[error("this Connection is Read-only")]
    ReadOnly(usize),
    #[error("confirm this write on a Production Connection")]
    NeedsConfirmation,
    #[error("the server refused a write: this Connection is Read-only")]
    ReadOnlyRefused,
    /// A save's UPDATE or DELETE (by plan index) found its row changed or gone.
    #[error("a row changed since it was loaded")]
    RowChanged { statement: usize, key: Vec<KeyPart> },
    /// The server refused a save's statement (by plan index).
    #[error("{message}")]
    EditFailed { statement: usize, message: String },
    /// A design's statement (by plan index) failed after `ran` of the plan's
    /// `total` statements stayed applied (MySQL; 0 where it rolls back).
    #[error("{message}")]
    DesignFailed {
        statement: usize,
        ran: usize,
        total: usize,
        message: String,
    },
    /// An SQLite rebuild's `foreign_key_check` found rows; it was rolled back.
    #[error("rows in {table} would break a Foreign Key")]
    DesignForeignKeys { table: String },
    /// A design's closing statement `sql`, which restores the connection, failed.
    /// `applied`: the change itself was applied (in full, or in part on MySQL).
    #[error("restoring the connection with {sql} failed: {message}")]
    DesignRestoreFailed {
        applied: bool,
        sql: String,
        message: String,
    },
    /// An import or export stopped at `at`; `message` names the place and the fix.
    #[error("{message}")]
    JobFailed { at: JobPosition, message: String },
    /// An import's file changed before anything was kept: after the Production confirm
    /// (`confirmed`), or, on any other Connection, while Contura read it.
    #[error("{}", file_changed_text(file, *confirmed))]
    FileChanged {
        file: String,
        #[serde(default)]
        confirmed: bool,
    },
    /// A second writing job on one Connection (by name).
    #[error("Another import is writing to {connection}. Wait for it to end.")]
    JobBusy { connection: String },
    /// An export target exists and the request did not say to replace it.
    #[error("{} exists", .0.display())]
    FileExists(PathBuf),
    /// An export read ended without its end mark (its producer panicked or was dropped).
    /// The text is whole, so it is shown as it is.
    #[error("The read stopped unexpectedly. Nothing more was written.")]
    ReadStopped,
    /// A writer's COMMIT succeeded, then one of its setup's `after` statements, `sql`,
    /// failed with the server's `message`. The committed rows are in.
    #[error("The rows were committed, but {sql} failed afterwards: {message}")]
    AfterCommit { sql: String, message: String },
    /// A diagram `name` is saved already and the request did not say to replace it.
    #[error("{name}.flow already exists.")]
    DiagramExists { name: String },
}

pub type Result<T> = std::result::Result<T, Error>;

/// "after you confirmed" only when there was a confirm to speak of: on Production (Q45).
fn file_changed_text(file: &str, confirmed: bool) -> String {
    if confirmed {
        format!("{file} changed after you confirmed. Nothing was imported.")
    } else {
        format!("{file} changed while Contura read it. Nothing was imported.")
    }
}

/// Browse code maps a server's read-only refusal to `ReadOnlyRefused` wherever it
/// happens. A Connection that is not Read-only must not say it is, so there it
/// becomes a plain query error (a hot standby, or a transaction the user made read-only).
pub(crate) fn browse_result<T>(result: Result<T>, read_only: bool) -> Result<T> {
    match result {
        Err(Error::ReadOnlyRefused) if !read_only => Err(Error::Query(
            "the server refused a write: the session is read-only".into(),
        )),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_too_large_states_the_size_and_the_limit() {
        assert_eq!(
            Error::ValueTooLarge(17_825_792).to_string(),
            "value is 17825792 bytes, over the 16 MiB limit"
        );
    }

    #[test]
    fn read_stopped_is_its_own_sentence() {
        assert_eq!(
            Error::ReadStopped.to_string(),
            "The read stopped unexpectedly. Nothing more was written."
        );
        assert_eq!(
            serde_json::to_value(Error::ReadStopped).unwrap(),
            serde_json::json!({"kind":"readStopped"})
        );
    }

    #[test]
    fn ai_error_shape() {
        use crate::ai::AiProviderKind;
        let json = |e: Error| serde_json::to_value(e).unwrap();
        assert_eq!(
            json(Error::Ai(AiError::NotConfigured)),
            serde_json::json!({"kind":"ai","message":{"kind":"notConfigured"}})
        );
        assert_eq!(
            json(Error::Ai(AiError::NotAvailable {
                provider: AiProviderKind::Groq
            })),
            serde_json::json!({"kind":"ai","message":{"kind":"notAvailable","provider":"groq"}})
        );
        assert_eq!(
            json(Error::Ai(AiError::RateLimited {
                retry_after_secs: Some(7)
            })),
            serde_json::json!({"kind":"ai","message":{"kind":"rateLimited","retryAfterSecs":7}})
        );
        assert_eq!(
            json(Error::Ai(AiError::Network { host: "h".into() })),
            serde_json::json!({"kind":"ai","message":{"kind":"network","host":"h"}})
        );
        assert_eq!(
            json(Error::Ai(AiError::BadKey)),
            serde_json::json!({"kind":"ai","message":{"kind":"badKey"}})
        );
    }

    #[test]
    fn browse_refusal_is_read_only_only_on_a_read_only_connection() {
        let refused = || -> Result<()> { Err(Error::ReadOnlyRefused) };
        assert!(matches!(
            browse_result(refused(), true),
            Err(Error::ReadOnlyRefused)
        ));
        assert!(matches!(
            browse_result(refused(), false),
            Err(Error::Query(_))
        ));
        assert!(browse_result(Ok(1), false).is_ok());
    }

    #[test]
    fn read_only_errors_shape() {
        let json = |e: Error| serde_json::to_value(e).unwrap();
        assert_eq!(
            json(Error::ReadOnly(1)),
            serde_json::json!({"kind":"readOnly","message":1})
        );
        assert_eq!(
            json(Error::NeedsConfirmation),
            serde_json::json!({"kind":"needsConfirmation"})
        );
        assert_eq!(
            json(Error::ReadOnlyRefused),
            serde_json::json!({"kind":"readOnlyRefused"})
        );
    }

    #[test]
    fn edit_errors_shape() {
        use crate::model::Cell;
        let json = |e: Error| serde_json::to_value(e).unwrap();
        assert_eq!(
            json(Error::RowChanged {
                statement: 1,
                key: vec![KeyPart {
                    column: "id".into(),
                    value: Cell::Number { value: "42".into() },
                }],
            }),
            serde_json::json!({"kind":"rowChanged","message":{"statement":1,
                "key":[{"column":"id","value":{"t":"number","value":"42"}}]}})
        );
        assert_eq!(
            json(Error::EditFailed {
                statement: 2,
                message: "bad value".into(),
            }),
            serde_json::json!({"kind":"editFailed","message":{"statement":2,"message":"bad value"}})
        );
    }

    #[test]
    fn design_errors_shape() {
        let json = |e: Error| serde_json::to_value(e).unwrap();
        assert_eq!(
            json(Error::DesignFailed {
                statement: 1,
                ran: 1,
                total: 2,
                message: "no such table".into(),
            }),
            serde_json::json!({"kind":"designFailed","message":{"statement":1,"ran":1,
                "total":2,"message":"no such table"}})
        );
        assert_eq!(
            json(Error::DesignForeignKeys {
                table: "orders".into()
            }),
            serde_json::json!({"kind":"designForeignKeys","message":{"table":"orders"}})
        );
        assert_eq!(
            json(Error::DesignRestoreFailed {
                applied: true,
                sql: "PRAGMA foreign_keys = ON".into(),
                message: "disk I/O error".into(),
            }),
            serde_json::json!({"kind":"designRestoreFailed","message":{"applied":true,
                "sql":"PRAGMA foreign_keys = ON","message":"disk I/O error"}})
        );
    }

    #[test]
    fn job_errors_shape() {
        let json = |e: Error| serde_json::to_value(e).unwrap();
        let failed = Error::JobFailed {
            at: JobPosition {
                file_row: Some(7),
                line: None,
                table: Some("menu_items".into()),
                statement: Some(1),
            },
            message: "Row 7 of the file: n/a is not a number for price.".into(),
        };
        assert_eq!(
            failed.to_string(),
            "Row 7 of the file: n/a is not a number for price."
        );
        assert_eq!(
            json(failed),
            serde_json::json!({"kind":"jobFailed","message":{
                "at":{"fileRow":7,"line":null,"table":"menu_items","statement":1},
                "message":"Row 7 of the file: n/a is not a number for price."}})
        );
        let changed = Error::FileChanged {
            file: "menu-oct.csv".into(),
            confirmed: true,
        };
        assert_eq!(
            changed.to_string(),
            "menu-oct.csv changed after you confirmed. Nothing was imported."
        );
        assert_eq!(
            json(changed),
            serde_json::json!({"kind":"fileChanged","message":{"file":"menu-oct.csv","confirmed":true}})
        );
        // Q45 M5: with no confirm, the text does not speak of one.
        let changed = Error::FileChanged {
            file: "menu-oct.csv".into(),
            confirmed: false,
        };
        assert_eq!(
            changed.to_string(),
            "menu-oct.csv changed while Contura read it. Nothing was imported."
        );
        let after = Error::AfterCommit {
            sql: "ANALYZE t".into(),
            message: "no such table".into(),
        };
        assert_eq!(
            after.to_string(),
            "The rows were committed, but ANALYZE t failed afterwards: no such table"
        );
        assert_eq!(
            json(after),
            serde_json::json!({"kind":"afterCommit","message":{"sql":"ANALYZE t","message":"no such table"}})
        );
        let busy = Error::JobBusy {
            connection: "kestrel-main".into(),
        };
        assert_eq!(
            busy.to_string(),
            "Another import is writing to kestrel-main. Wait for it to end."
        );
        assert_eq!(
            json(busy),
            serde_json::json!({"kind":"jobBusy","message":{"connection":"kestrel-main"}})
        );
        let exists = Error::FileExists(PathBuf::from("C:/out/orders.csv"));
        assert_eq!(exists.to_string(), "C:/out/orders.csv exists");
        assert_eq!(
            json(exists),
            serde_json::json!({"kind":"fileExists","message":"C:/out/orders.csv"})
        );
    }

    #[test]
    fn error_shape() {
        assert_eq!(
            serde_json::to_value(Error::ValueTooLarge(20)).unwrap(),
            serde_json::json!({"kind":"valueTooLarge","message":20})
        );
    }
}
