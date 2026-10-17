use serde::Serialize;

use crate::ai::AiError;

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
}

pub type Result<T> = std::result::Result<T, Error>;

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
    fn error_shape() {
        assert_eq!(
            serde_json::to_value(Error::ValueTooLarge(20)).unwrap(),
            serde_json::json!({"kind":"valueTooLarge","message":20})
        );
    }
}
