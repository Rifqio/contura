use serde::Serialize;

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
}

pub type Result<T> = std::result::Result<T, Error>;

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
    fn error_shape() {
        assert_eq!(
            serde_json::to_value(Error::ValueTooLarge(20)).unwrap(),
            serde_json::json!({"kind":"valueTooLarge","message":20})
        );
    }
}
