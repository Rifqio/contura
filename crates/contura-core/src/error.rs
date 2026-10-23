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
    /// Restore refuses a Backup file; `reason` is the sentence to show.
    #[error("{reason}")]
    BackupRefused { reason: String },
    /// Schema Compare: the Sync Script rebuilt for Apply is not the one shown,
    /// because a side changed since the compare (any Connection).
    #[error(
        "{connection} changed since you compared. Compare again to see the current Sync Script."
    )]
    PlanChanged { connection: String },
    /// Schema Compare: Apply was cancelled after `applied` of the script's `total`
    /// statements stayed applied (MySQL commits one by one; PostgreSQL keeps the
    /// enum values it committed first).
    #[error("Apply was cancelled after {applied} of {total} statements were applied")]
    SyncCancelled { applied: usize, total: usize },
    /// One-click updates: the sentence to show, as `UpdateError` words it.
    #[error("{0}")]
    Update(#[serde(serialize_with = "as_text")] crate::update::UpdateError),
}

fn as_text<S: serde::Serializer>(
    e: &crate::update::UpdateError,
    s: S,
) -> std::result::Result<S::Ok, S::Error> {
    s.collect_str(e)
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
            json(Error::Ai(AiError::RateLimited {
                retry_after_secs: Some(7)
            })),
            serde_json::json!({"kind":"ai","message":{"kind":"rateLimited","retryAfterSecs":7}})
        );
        assert_eq!(
            json(Error::Ai(AiError::Network {
                host: "h".into(),
                connect: false
            })),
            serde_json::json!({"kind":"ai","message":{"kind":"network","host":"h","connect":false}})
        );
        assert_eq!(
            json(Error::Ai(AiError::BadKey)),
            serde_json::json!({"kind":"ai","message":{"kind":"badKey"}})
        );
        let ai = |e: AiError| json(Error::Ai(e));
        let msg = |v: serde_json::Value| serde_json::json!({"kind":"ai","message":v});
        assert_eq!(
            ai(AiError::KeyHostChanged { host: "h".into() }),
            msg(serde_json::json!({"kind":"keyHostChanged","host":"h"}))
        );
        assert_eq!(
            ai(AiError::InsecureUrl { host: "h".into() }),
            msg(serde_json::json!({"kind":"insecureUrl","host":"h"}))
        );
        assert_eq!(
            ai(AiError::Timeout {
                phase: "connect".into()
            }),
            msg(serde_json::json!({"kind":"timeout","phase":"connect"}))
        );
        assert_eq!(
            ai(AiError::Cancelled),
            msg(serde_json::json!({"kind":"cancelled"}))
        );
        assert_eq!(
            ai(AiError::Provider {
                status: 404,
                message: "model not found".into()
            }),
            msg(serde_json::json!({"kind":"provider","status":404,"message":"model not found"}))
        );
        assert_eq!(
            ai(AiError::BadResponse),
            msg(serde_json::json!({"kind":"badResponse"}))
        );
        assert_eq!(
            ai(AiError::TooLarge),
            msg(serde_json::json!({"kind":"tooLarge"}))
        );
        assert_eq!(
            ai(AiError::ContextUnavailable { built_at: 1234 }),
            msg(serde_json::json!({"kind":"contextUnavailable","builtAt":1234}))
        );
        assert_eq!(
            ai(AiError::Overloaded {
                provider: AiProviderKind::Groq
            }),
            msg(serde_json::json!({"kind":"overloaded","provider":"groq"}))
        );
        assert_eq!(
            ai(AiError::UrlHasCredentials {
                host: "x.example".into()
            }),
            msg(serde_json::json!({"kind":"urlHasCredentials","host":"x.example"}))
        );
        assert_eq!(
            ai(AiError::Offline),
            msg(serde_json::json!({"kind":"offline"}))
        );
        assert_eq!(
            ai(AiError::OutOfCredit {
                provider: AiProviderKind::Anthropic
            }),
            msg(serde_json::json!({"kind":"outOfCredit","provider":"anthropic"}))
        );
        assert_eq!(
            ai(AiError::ModelRetired { model: "m".into() }),
            msg(serde_json::json!({"kind":"modelRetired","model":"m"}))
        );
        assert_eq!(
            ai(AiError::ContextFull {
                used: 192000,
                window: 200000,
                model: "m".into(),
                messages: 14
            }),
            msg(
                serde_json::json!({"kind":"contextFull","used":192000,"window":200000,"model":"m","messages":14})
            )
        );
        assert_eq!(
            ai(AiError::TooBig {
                needed: 1_300_000,
                window: 200_000,
                model: "m".into()
            }),
            msg(serde_json::json!({"kind":"tooBig","needed":1300000,"window":200000,"model":"m"}))
        );
        assert_eq!(
            ai(AiError::Tls {
                host: "api.groq.com".into()
            }),
            msg(serde_json::json!({"kind":"tls","host":"api.groq.com"}))
        );
    }

    /// A stored answer record keeps its error: every kind reads back as written.
    #[test]
    fn network_connect_json() {
        let json = |e: Error| serde_json::to_value(e).unwrap();
        assert_eq!(
            json(Error::Ai(AiError::Network {
                host: "h".into(),
                connect: true
            })),
            serde_json::json!({"kind":"ai","message":{"kind":"network","host":"h","connect":true}})
        );
        // A record written before the flag existed reads as not connect.
        let old: AiError =
            serde_json::from_value(serde_json::json!({"kind":"network","host":"h"})).unwrap();
        assert_eq!(
            old,
            AiError::Network {
                host: "h".into(),
                connect: false
            }
        );
    }

    #[test]
    fn ai_error_round_trips() {
        use crate::ai::AiProviderKind;
        let all = [
            AiError::NotConfigured,
            AiError::BadKey,
            AiError::RateLimited {
                retry_after_secs: Some(7),
            },
            AiError::Network {
                host: "h".into(),
                connect: true,
            },
            AiError::KeyHostChanged { host: "h".into() },
            AiError::InsecureUrl { host: "h".into() },
            AiError::Timeout {
                phase: "connect".into(),
            },
            AiError::Cancelled,
            AiError::Provider {
                status: 404,
                message: "m".into(),
            },
            AiError::BadResponse,
            AiError::TooLarge,
            AiError::ContextUnavailable { built_at: 1234 },
            AiError::Overloaded {
                provider: AiProviderKind::Groq,
            },
            AiError::UrlHasCredentials { host: "h".into() },
            AiError::Offline,
            AiError::OutOfCredit {
                provider: AiProviderKind::Anthropic,
            },
            AiError::ModelRetired { model: "m".into() },
            AiError::ContextFull {
                used: 1,
                window: 2,
                model: "m".into(),
                messages: 4,
            },
            AiError::TooBig {
                needed: 3,
                window: 2,
                model: "m".into(),
            },
            AiError::Tls { host: "h".into() },
            AiError::Busy,
            AiError::NothingToContinue,
            AiError::Internal,
            AiError::FileChanged {
                file: "orders".into(),
                line: Some(9),
                now_reads: Some("Pack order".into()),
            },
            AiError::FileChanged {
                file: "orders".into(),
                line: None,
                now_reads: None,
            },
            AiError::ToolRejected {
                name: "run_sql".into(),
            },
            AiError::BadToolInput,
            AiError::ToolOff,
            AiError::BadFileName,
        ];
        for e in all {
            let v = serde_json::to_value(&e).unwrap();
            assert_eq!(serde_json::from_value::<AiError>(v).unwrap(), e);
        }
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
    fn plan_changed_shape_and_text() {
        let e = Error::PlanChanged {
            connection: "freight-prod".into(),
        };
        assert_eq!(
            e.to_string(),
            "freight-prod changed since you compared. Compare again to see the current Sync Script."
        );
        assert_eq!(
            serde_json::to_value(e).unwrap(),
            serde_json::json!({"kind":"planChanged","message":{"connection":"freight-prod"}})
        );
    }

    #[test]
    fn sync_cancelled_shape() {
        assert_eq!(
            serde_json::to_value(Error::SyncCancelled {
                applied: 3,
                total: 9
            })
            .unwrap(),
            serde_json::json!({"kind":"syncCancelled","message":{"applied":3,"total":9}})
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
