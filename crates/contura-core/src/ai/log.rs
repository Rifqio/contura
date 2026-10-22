//! The answer log: what one Ask did, step by step, kept with the answer.

use std::fmt;
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::ai::AiError;
use crate::error::Error;

const MAX_LINES: usize = 500;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// Milliseconds since the log started.
    pub at_ms: u64,
    pub level: Level,
    pub source: String,
    /// Key and value pairs in push order; serialized as `[[k, v], ...]`.
    pub fields: Vec<(String, String)>,
}

/// Where each kept line goes as it is pushed: the webview, while the Ask runs.
pub type LogSink = Arc<dyn Fn(&LogLine) + Send + Sync>;

pub struct Log {
    pub lines: Vec<LogLine>,
    pub started: Instant,
    sink: Option<LogSink>,
}

/// A clone keeps the lines and the start, not the sink.
impl Clone for Log {
    fn clone(&self) -> Self {
        Log {
            lines: self.lines.clone(),
            started: self.started,
            sink: None,
        }
    }
}

impl fmt::Debug for Log {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Log")
            .field("lines", &self.lines)
            .field("started", &self.started)
            .finish_non_exhaustive()
    }
}

/// One row of the Steps record.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StepKind {
    Access,
    Schema,
    Outline,
    Tables,
    Cleaning,
    Request,
    Thinking,
    Answer,
    SqlCheck,
}

/// A Steps row, in fixed wording filled from what ran.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStep {
    pub step: StepKind,
    /// Milliseconds since the Ask's log started.
    pub at_ms: u64,
    pub value: String,
    pub rule: String,
    /// The rows of the evidence table, three cells each.
    pub evidence: Vec<[String; 3]>,
    /// Text from the provider (Thinking, Answer), not from Contura.
    pub by_model: bool,
    /// The Tables row only: how many tables the budget and the 200 KB cut left out. A
    /// ranked table keeps its rank rule when it is left out, so the evidence cannot say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left_out: Option<u32>,
}

impl Default for Log {
    fn default() -> Self {
        Self::new()
    }
}

impl Log {
    pub fn new() -> Log {
        Log {
            lines: Vec::new(),
            started: Instant::now(),
            sink: None,
        }
    }

    /// A log that hands each kept line to `sink` as it is pushed.
    pub fn with_sink(sink: LogSink) -> Log {
        Log {
            sink: Some(sink),
            ..Log::new()
        }
    }

    /// Milliseconds since the log started.
    pub fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    /// Keeps at most 500 lines: the 500th is a `truncated=true` warning and later pushes are dropped.
    pub fn push(&mut self, level: Level, source: &str, fields: &[(&str, String)]) {
        if self.lines.len() >= MAX_LINES {
            return;
        }
        let at_ms = self.started.elapsed().as_millis() as u64;
        let line = if self.lines.len() == MAX_LINES - 1 {
            LogLine {
                at_ms,
                level: Level::Warn,
                source: "log".into(),
                fields: vec![("truncated".into(), "true".into())],
            }
        } else {
            LogLine {
                at_ms,
                level,
                source: source.into(),
                fields: fields
                    .iter()
                    .map(|(k, v)| ((*k).to_string(), v.clone()))
                    .collect(),
            }
        };
        if let Some(sink) = &self.sink {
            sink(&line);
        }
        self.lines.push(line);
    }
}

/// An assistant error's kind as one bare word (its serde tag): never its message.
pub fn ai_error_kind(e: &AiError) -> String {
    serde_json::to_value(e)
        .ok()
        .and_then(|v| v.get("kind")?.as_str().map(str::to_string))
        .unwrap_or_else(|| "internal".into())
}

/// An error's kind as one bare word, for a log field: a message can name a URL, a user or
/// a path, so it is never logged.
pub fn error_kind(e: &Error) -> String {
    match e {
        Error::Ai(e) => ai_error_kind(e),
        Error::Connect(_) => "connect".into(),
        Error::Auth(_) => "auth".into(),
        Error::Query(_) => "query".into(),
        Error::TimedOut(_) => "timeout".into(),
        Error::Cancelled => "cancelled".into(),
        Error::NotFound(_) => "notFound".into(),
        _ => "internal".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_caps_at_500_lines() {
        let mut log = Log::new();
        for i in 0..600 {
            log.push(Level::Info, "test", &[("i", i.to_string())]);
        }
        assert_eq!(log.lines.len(), 500);
        assert_eq!(log.lines[498].fields, vec![("i".into(), "498".into())]);
        let last = &log.lines[499];
        assert_eq!(last.level, Level::Warn);
        assert_eq!(last.source, "log");
        assert_eq!(last.fields, vec![("truncated".into(), "true".into())]);
    }

    #[test]
    fn sink_sees_each_line_once() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let into = seen.clone();
        let mut log = Log::with_sink(Arc::new(move |l: &LogLine| {
            into.lock().unwrap().push(l.clone())
        }));
        for i in 0..502 {
            log.push(Level::Info, "test", &[("i", i.to_string())]);
        }
        assert_eq!(*seen.lock().unwrap(), log.lines);
        assert_eq!(seen.lock().unwrap().len(), 500);
        // A clone has no sink: its lines go nowhere else.
        let mut copy = log.clone();
        copy.lines.clear();
        copy.push(Level::Info, "copy", &[]);
        assert_eq!(seen.lock().unwrap().len(), 500);
    }

    #[test]
    fn debug_leaves_out_the_sink() {
        let mut log = Log::with_sink(Arc::new(|_: &LogLine| {}));
        log.push(Level::Info, "a", &[("k", "v".into())]);
        let text = format!("{log:?}");
        assert!(text.contains("lines"), "{text}");
        assert!(!text.contains("sink"), "{text}");
    }

    #[test]
    fn process_step_serializes_camel_case() {
        let step = ProcessStep {
            step: StepKind::SqlCheck,
            at_ms: 5,
            value: "v".into(),
            rule: "r".into(),
            evidence: vec![["a".into(), "b".into(), "c".into()]],
            by_model: false,
            left_out: None,
        };
        assert_eq!(
            serde_json::to_value(&step).unwrap(),
            serde_json::json!({ "step": "sqlCheck", "atMs": 5, "value": "v", "rule": "r", "evidence": [["a", "b", "c"]], "byModel": false })
        );
    }

    #[test]
    fn outline_step_serializes() {
        assert_eq!(
            serde_json::to_value(StepKind::Outline).unwrap(),
            serde_json::json!("outline")
        );
        let back: StepKind = serde_json::from_str("\"outline\"").unwrap();
        assert_eq!(back, StepKind::Outline);
    }

    #[test]
    fn log_line_serializes_camel_case_with_field_pairs() {
        let line = LogLine {
            at_ms: 12,
            level: Level::Info,
            source: "rails".into(),
            fields: vec![("k".into(), "v".into())],
        };
        assert_eq!(
            serde_json::to_value(&line).unwrap(),
            serde_json::json!({ "atMs": 12, "level": "info", "source": "rails", "fields": [["k", "v"]] })
        );
    }
}
