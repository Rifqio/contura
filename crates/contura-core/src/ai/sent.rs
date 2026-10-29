//! The Sent record (R7.1) and the answer record kept with each assistant message.

use serde::{Deserialize, Serialize};

use crate::ai::context::sync::ContextInfo;
use crate::ai::diagram::DiagramProposal;
use crate::ai::diagram_tool::INPUT_CAP;
use crate::ai::log::{LogLine, ProcessStep};
use crate::ai::provider::{StopReason, Usage};
use crate::ai::rails::cap_chars;
use crate::ai::rails::output::SqlBlock;
use crate::ai::request::ItemKind;
use crate::ai::{AiError, AiProviderKind};
use crate::common::grouped;

/// The thinking kept with an answer, in bytes.
pub const THINKING_CAP: usize = 64 * 1024;
/// The log lines kept with an answer.
const LOG_CAP: usize = 500;
/// Evidence rows kept per Steps row; the rest become one "and N more" row.
const EVIDENCE_CAP: usize = 200;
/// The exact text kept, in bytes: the most R1.5 lets a request carry.
const EXACT_CAP: usize = 200 * 1024;
/// The outline call's exact text kept, in bytes.
const OUTLINE_EXACT_CAP: usize = 64 * 1024;
/// The summary call's exact text kept, in bytes: the most R1.5 lets a request carry.
const SUMMARY_EXACT_CAP: usize = 200 * 1024;
const NOTES_CAP: usize = 20;
/// Characters kept per note.
const NOTE_CHARS: usize = 300;
const BLOCKS_CAP: usize = 64;
/// Statements kept per SQL block.
const STATEMENTS_CAP: usize = 256;
/// Bytes kept per statement: the most an answer holds.
const STATEMENT_CAP: usize = 64 * 1024;
/// The user's actions kept per answer, the latest.
const ACTIONS_CAP: usize = 50;
/// A command error's text.
const COMMAND_ERROR_CAP: usize = 2 * 1024;

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// The 64-bit FNV-1a hash of `bytes`.
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    fnv1a64_parts(&[bytes])
}

/// The 64-bit FNV-1a hash of `parts` one after another, as if joined.
pub fn fnv1a64_parts(parts: &[&[u8]]) -> u64 {
    let mut hash = FNV_OFFSET;
    for part in parts {
        for b in *part {
            hash ^= u64::from(*b);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    }
    hash
}

/// What one Ask sent: measured from the request itself, never rebuilt.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SentRecord {
    /// Epoch milliseconds.
    pub at: i64,
    /// The kinds of the Sends items that went.
    pub kinds: Vec<ItemKind>,
    /// Every message text as the provider put it on the wire (`AiProvider::wire_texts`).
    /// 0 (with an empty `hash`) when only the outline call went: the Ask ended, or has not
    /// yet built its request, after that call left this PC.
    pub bytes: u32,
    /// About: an estimate from bytes.
    pub tokens: u32,
    pub provider: AiProviderKind,
    pub model: String,
    pub model_name: String,
    /// The host (with `:port` when not the default); never the URL.
    pub host: String,
    /// `fnv1a64` of those texts one after another, 16 lower-case hex digits.
    pub hash: String,
    /// Equals `outline.is_some()`.
    pub outline_call: bool,
    /// Equals `summary.is_some()`.
    pub summary_call: bool,
    /// The outline call, only once its request left this PC: a call refused before it
    /// connected (a URL refusal, no connection, a failed TLS handshake) has none.
    #[serde(default)]
    pub outline: Option<OutlineSent>,
    /// The summary or compaction call, only once its request left this PC.
    #[serde(default)]
    pub summary: Option<SummarySent>,
    /// The sample rows that went, counted from the framed items; never the values.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<RowsSent>,
    /// The chat title call that followed this answer (`CallKind::Title`), once its request
    /// left this PC; written by the Core after the turn was stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<SummarySent>,
    /// The exact text, only with "Keep the exact text sent" on (R7.2).
    pub exact: Option<String>,
    /// The Connections a diagram Ask's text drew on and that passed its gate: the frames
    /// From my database drew and the `table:` links that resolved. A later Ask
    /// leaves this turn out of its history once one of them is held. Empty elsewhere.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<crate::model::ConnectionId>,
}

/// The sample rows of an Ask, as Sent and Sends count them.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RowsSent {
    pub tables: u32,
    pub rows: u32,
    pub bytes: u32,
}

impl Default for SentRecord {
    fn default() -> Self {
        Self {
            at: 0,
            kinds: Vec::new(),
            bytes: 0,
            tokens: 0,
            provider: AiProviderKind::Custom,
            model: String::new(),
            model_name: String::new(),
            host: String::new(),
            hash: String::new(),
            outline_call: false,
            summary_call: false,
            outline: None,
            summary: None,
            rows: None,
            title: None,
            exact: None,
            sources: Vec::new(),
        }
    }
}

/// What a summary call wrote: a closed Topic's summary, a compaction of the open one, or
/// the chat's title after its first answer.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CallKind {
    #[default]
    Summary,
    Compact,
    Title,
}

/// The summary call of an Ask or of Compact now (R4.1): measured from its request, like
/// the main record.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SummarySent {
    pub kind: CallKind,
    /// The Topic summarised; `None` for a compaction.
    pub topic: Option<u32>,
    /// The messages the call summarised.
    pub messages: u32,
    pub model: String,
    /// Every text as the provider put it on the wire.
    pub bytes: u32,
    /// About: an estimate from bytes.
    pub tokens: u32,
    pub hash: String,
    pub millis: u32,
    pub usage: Option<Usage>,
    /// The exact text, only with "Keep the exact text sent" on.
    pub exact: Option<String>,
}

/// The outline call of an Ask (R4.1): measured from its request, like the main record.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct OutlineSent {
    pub bytes: u32,
    pub tokens: u32,
    pub hash: String,
    /// The tables the outline listed.
    pub tables: u32,
    pub picked_areas: u32,
    pub picked_tables: u32,
    pub dropped: u32,
    pub usage: Option<Usage>,
    /// The exact text, only with "Keep the exact text sent" on.
    pub exact: Option<String>,
    /// The request left this PC: false while the call is being made, true once the provider
    /// answered anything or failed after connecting. Only a record that left is kept in a
    /// `SentRecord`. A record saved before this field existed reads true: it was kept only
    /// after its call was made.
    #[serde(default = "left_by_default")]
    pub left: bool,
}

fn left_by_default() -> bool {
    true
}

/// How an answer ended when it did not end normally.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AnswerMark {
    Stopped,
    Length,
    Refusal,
    Dropped,
    TooLong,
    Failed,
}

/// What the user did with an answer's SQL: the Diagram's "You:" box.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AnswerActionKind {
    Inserted,
    InsertedCommented,
    OpenedInNewTab,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnswerAction {
    pub kind: AnswerActionKind,
    /// Epoch milliseconds.
    pub at: i64,
}

/// What the user did with a diagram proposal: the changes landed and rejected.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutcome {
    pub accepted: u32,
    pub rejected: u32,
    /// Landed by Auto-apply, not by review.
    pub auto: bool,
    /// Epoch milliseconds.
    pub at: i64,
}

/// The tool call of a diagram Ask, as it was checked.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolUse {
    pub tool: String,
    /// The diagram's name, without `.flow`.
    pub file: String,
    /// The model's JSON with invisible characters stripped, at most 64 KB.
    pub input: String,
    pub proposal: DiagramProposal,
    /// `None` until the user lands or rejects the changes.
    pub outcome: Option<ToolOutcome>,
}

/// Everything kept with an assistant message besides its text.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AnswerRecord {
    pub sent: Option<SentRecord>,
    pub usage: Option<Usage>,
    pub millis: Option<u32>,
    pub stop: Option<StopReason>,
    pub mark: Option<AnswerMark>,
    pub error: Option<AiError>,
    pub sql_blocks: Vec<SqlBlock>,
    pub notes: Vec<String>,
    /// As the provider returned it, at most 64 KB.
    pub thinking: Option<String>,
    pub log: Vec<LogLine>,
    pub steps: Vec<ProcessStep>,
    /// What the user did with the answer's SQL, oldest first.
    pub actions: Vec<AnswerAction>,
    /// The AI Context the Ask used (the `Context` event), written by the Core when the
    /// answer is saved; `None` when no schema was asked for, and in records saved before
    /// 11c.
    pub context: Option<ContextInfo>,
    /// The text of a failure that is not an `AiError` (a command that could not start),
    /// at most 2 KB.
    pub command_error: Option<String>,
    /// True on a copy whose `log`, `steps`, `thinking` and `sent.exact` were left out
    /// for listing.
    #[serde(default)]
    pub trimmed: bool,
    /// The diagram Ask's tool call; kept by `trimmed_copy`.
    #[serde(default)]
    pub tool_use: Option<ToolUse>,
    /// The `max_tokens` the request carried on the wire (the `Done` event's), so a
    /// length stop without usage names the cap it was sent with; `None` in older records.
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

impl AnswerRecord {
    /// The copy a listing carries: no `log`, `steps`, `thinking`, `sent.exact`,
    /// `sent.outline.exact`, `sent.summary.exact` or `sent.title.exact`, and
    /// `trimmed` set. Everything else is kept, `sql_blocks` included.
    pub fn trimmed_copy(&self) -> AnswerRecord {
        let mut c = self.clone();
        c.log = Vec::new();
        c.steps = Vec::new();
        c.thinking = None;
        if let Some(sent) = &mut c.sent {
            sent.exact = None;
            if let Some(outline) = &mut sent.outline {
                outline.exact = None;
            }
            if let Some(summary) = &mut sent.summary {
                summary.exact = None;
            }
            if let Some(title) = &mut sent.title {
                title.exact = None;
            }
        }
        c.trimmed = true;
        c
    }

    /// Holds the record to its caps, so one message cannot grow a thread by much: 64 KB
    /// of thinking, 500 log lines, 200 evidence rows per Steps row (then "and N more"),
    /// 200 KB of exact text, 20 notes of 300 characters, 64 SQL blocks of 256 statements,
    /// 64 KB of tool input.
    pub fn capped(mut self) -> Self {
        let cut = |t: &mut String, bytes: usize| {
            let keep = cap_chars(t, bytes).len();
            t.truncate(keep);
        };
        if let Some(t) = &mut self.thinking {
            cut(t, THINKING_CAP);
        }
        self.log.truncate(LOG_CAP);
        for step in &mut self.steps {
            let more = step.evidence.len().saturating_sub(EVIDENCE_CAP);
            if more > 0 {
                step.evidence.truncate(EVIDENCE_CAP);
                step.evidence.push([
                    format!("and {} more", grouped(more as u64)),
                    String::new(),
                    String::new(),
                ]);
            }
        }
        if let Some(exact) = self.sent.as_mut().and_then(|s| s.exact.as_mut()) {
            cut(exact, EXACT_CAP);
        }
        if let Some(exact) = self
            .sent
            .as_mut()
            .and_then(|s| s.outline.as_mut())
            .and_then(|o| o.exact.as_mut())
        {
            cut(exact, OUTLINE_EXACT_CAP);
        }
        if let Some(exact) = self
            .sent
            .as_mut()
            .and_then(|s| s.summary.as_mut())
            .and_then(|o| o.exact.as_mut())
        {
            cut(exact, SUMMARY_EXACT_CAP);
        }
        if let Some(exact) = self
            .sent
            .as_mut()
            .and_then(|s| s.title.as_mut())
            .and_then(|o| o.exact.as_mut())
        {
            cut(exact, SUMMARY_EXACT_CAP);
        }
        if let Some(t) = &mut self.command_error {
            cut(t, COMMAND_ERROR_CAP);
        }
        if let Some(t) = &mut self.tool_use {
            cut(&mut t.input, INPUT_CAP);
        }
        self.notes.truncate(NOTES_CAP);
        for note in &mut self.notes {
            if note.chars().count() > NOTE_CHARS {
                *note = note.chars().take(NOTE_CHARS).collect();
            }
        }
        let old = self.actions.len().saturating_sub(ACTIONS_CAP);
        self.actions.drain(..old);
        self.sql_blocks.truncate(BLOCKS_CAP);
        for block in &mut self.sql_blocks {
            block.statements.truncate(STATEMENTS_CAP);
            for s in &mut block.statements {
                cut(&mut s.text, STATEMENT_CAP);
            }
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::log::{Level, StepKind};
    use crate::ai::rails::output::{Flag, StatementCheck};
    use crate::ai::{AiMessage, AiRole, AiThread};
    use crate::safety::StatementClass;

    #[test]
    fn fnv1a64_known_values() {
        assert_eq!(format!("{:016x}", fnv1a64(b"")), "cbf29ce484222325");
        assert_eq!(format!("{:016x}", fnv1a64(b"a")), "af63dc4c8601ec8c");
        assert_eq!(
            fnv1a64_parts(&[b"ab", b"", b"c"]),
            fnv1a64(b"abc"),
            "parts hash as if joined"
        );
    }

    #[test]
    fn trimmed_copy_keeps_sql_blocks() {
        let mut full = record();
        full.sent.as_mut().unwrap().exact = Some("x".repeat(1000));
        full.sent.as_mut().unwrap().outline = Some(OutlineSent {
            exact: Some("o".repeat(1000)),
            ..OutlineSent::default()
        });
        let t = full.trimmed_copy();
        let outline = t.sent.as_ref().unwrap().outline.as_ref().unwrap();
        assert!(outline.exact.is_none());
        assert!(t.trimmed && !full.trimmed);
        assert!(t.log.is_empty() && t.steps.is_empty() && t.thinking.is_none());
        assert!(t.sent.as_ref().unwrap().exact.is_none());
        assert_eq!(t.sql_blocks, full.sql_blocks);
        assert_eq!(t.actions, full.actions);
        assert_eq!(t.context, full.context);
        assert_eq!(t.usage, full.usage);
        assert_eq!(
            t.sent.as_ref().unwrap().hash,
            full.sent.as_ref().unwrap().hash
        );
    }

    #[test]
    fn sent_record_rows_round_trips() {
        let none = serde_json::to_value(SentRecord::default()).unwrap();
        assert!(none.get("rows").is_none(), "{none}");
        let old: SentRecord = serde_json::from_value(none).unwrap();
        assert_eq!(old.rows, None);
        let with = SentRecord {
            rows: Some(RowsSent {
                tables: 2,
                rows: 7,
                bytes: 900,
            }),
            ..SentRecord::default()
        };
        let v = serde_json::to_value(&with).unwrap();
        assert_eq!(
            v["rows"],
            serde_json::json!({"tables": 2, "rows": 7, "bytes": 900})
        );
        let back: SentRecord = serde_json::from_value(v).unwrap();
        assert_eq!(back, with);
    }

    fn record() -> AnswerRecord {
        AnswerRecord {
            sent: Some(SentRecord {
                at: 1_760_000_000_000,
                kinds: vec![ItemKind::Question, ItemKind::Cards],
                bytes: 2314,
                tokens: 640,
                provider: AiProviderKind::Groq,
                model: "llama-3.3-70b-versatile".into(),
                model_name: "Llama 3.3 70B".into(),
                host: "api.groq.com".into(),
                hash: "af63dc4c8601ec8c".into(),
                outline_call: false,
                summary_call: false,
                outline: None,
                summary: None,
                rows: None,
                title: None,
                exact: None,
                sources: Vec::new(),
            }),
            usage: Some(Usage {
                input: 1,
                output: 2,
                cache_read: 3,
                cache_write: 4,
            }),
            millis: Some(1900),
            stop: Some(StopReason::End),
            mark: None,
            error: None,
            sql_blocks: vec![SqlBlock {
                fence: 0,
                body_sha256: String::new(),
                label: "1 statement: 1 read".into(),
                statements: vec![StatementCheck {
                    text: "select 1".into(),
                    class: StatementClass::Read,
                    flags: vec![Flag::NoWhere {
                        verb: "UPDATE".into(),
                    }],
                }],
            }],
            notes: vec!["n".into()],
            thinking: Some("hm".into()),
            log: vec![LogLine {
                at_ms: 3,
                level: Level::Info,
                source: "request".into(),
                fields: vec![("bytes".into(), "2314".into())],
            }],
            steps: vec![ProcessStep {
                step: StepKind::Request,
                at_ms: 4,
                value: "2,314 B, no tools".into(),
                rule: "r".into(),
                evidence: Vec::new(),
                by_model: false,
                left_out: None,
            }],
            actions: vec![AnswerAction {
                kind: AnswerActionKind::Inserted,
                at: 5,
            }],
            context: Some(ContextInfo {
                connection_id: uuid::Uuid::from_u128(42),
                database: "shop".into(),
                schema: "public".into(),
                sync: crate::model::AiSyncMode::Automatic,
                built_at: Some(1_760_000_000_000),
                table_count: 6,
                stale: false,
                check: crate::ai::context::sync::SchemaCheck::Failed,
            }),
            command_error: Some("Connection refused".into()),
            trimmed: false,
            tool_use: None,
            max_tokens: Some(28_672),
        }
    }

    #[test]
    fn record_round_trips() {
        let thread = AiThread {
            id: uuid::Uuid::from_u128(7),
            place: "ungrouped".into(),
            title: "t".into(),
            messages: vec![
                AiMessage {
                    role: AiRole::User,
                    text: "q".into(),
                    context: Vec::new(),
                    at: 1,
                    record: None,
                    topic: None,
                    connection_id: None,
                    database: None,
                    kinds: Vec::new(),
                    tables: Vec::new(),
                    action: None,
                    asked_in: None,
                },
                AiMessage {
                    role: AiRole::Assistant,
                    text: "a".into(),
                    context: Vec::new(),
                    at: 2,
                    record: Some(record()),
                    topic: None,
                    connection_id: None,
                    database: None,
                    kinds: Vec::new(),
                    tables: Vec::new(),
                    action: None,
                    asked_in: None,
                },
            ],
            updated_at: 2,
            title_by: Default::default(),
            title_tries: 0,
            last_work: None,
        };
        let json = serde_json::to_string(&thread).unwrap();
        assert_eq!(serde_json::from_str::<AiThread>(&json).unwrap(), thread);
        // A message with no record leaves the field out.
        let value = serde_json::to_value(&thread).unwrap();
        assert!(value["messages"][0].get("record").is_none());
        assert_eq!(
            value["messages"][1]["record"]["sent"]["hash"],
            "af63dc4c8601ec8c"
        );
        assert_eq!(
            value["messages"][1]["record"]["context"]["check"],
            serde_json::json!({ "kind": "failed" })
        );
        assert_eq!(
            value["messages"][1]["record"]["context"]["builtAt"],
            1_760_000_000_000_i64
        );
        assert_eq!(
            value["messages"][1]["record"]["commandError"],
            "Connection refused"
        );
        assert_eq!(value["messages"][1]["record"]["maxTokens"], 28_672);

        // A thread saved before records were kept still loads.
        let old = r#"{"id":"00000000-0000-0000-0000-000000000007","place":"ungrouped","title":"t","messages":[{"role":"assistant","text":"a","context":[],"at":2}],"updatedAt":2}"#;
        let loaded: AiThread = serde_json::from_str(old).unwrap();
        assert_eq!(loaded.messages[0].record, None);
        // A record missing fields loads with their defaults.
        let partial: AnswerRecord = serde_json::from_str(r#"{"millis":5}"#).unwrap();
        assert_eq!(partial.millis, Some(5));
        assert_eq!(partial.context, None);
        assert_eq!(partial.command_error, None);
        assert!(partial.steps.is_empty());
        assert_eq!(partial.max_tokens, None);
    }

    #[test]
    fn outline_sent_round_trips() {
        let mut r = record();
        // A record saved before 11d has no outline.
        let old: SentRecord = serde_json::from_str(r#"{"bytes":5,"outlineCall":false}"#).unwrap();
        assert_eq!(old.outline, None);
        let sent = r.sent.as_mut().unwrap();
        sent.outline_call = true;
        sent.outline = Some(OutlineSent {
            bytes: 900,
            tokens: 250,
            hash: "af63dc4c8601ec8c".into(),
            tables: 40,
            picked_areas: 2,
            picked_tables: 11,
            dropped: 1,
            usage: Some(Usage {
                input: 1,
                output: 2,
                cache_read: 0,
                cache_write: 0,
            }),
            exact: Some("é".repeat(OUTLINE_EXACT_CAP)),
            left: true,
        });
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["sent"]["outline"]["pickedAreas"], 2);
        assert_eq!(json["sent"]["outline"]["left"], true);
        // An outline saved before `left` existed went: it reads true.
        let older: OutlineSent = serde_json::from_str(r#"{"bytes":900}"#).unwrap();
        assert!(older.left);
        // And one saved before `tables` existed lists none.
        assert_eq!(older.tables, 0);
        assert_eq!(json["sent"]["outline"]["tables"], 40);
        assert_eq!(json["sent"]["outline"]["pickedTables"], 11);
        let back: AnswerRecord = serde_json::from_value(json).unwrap();
        assert_eq!(back, r);
        let capped = r.capped();
        let exact = capped.sent.unwrap().outline.unwrap().exact.unwrap();
        assert!(exact.len() <= OUTLINE_EXACT_CAP && exact.len() > OUTLINE_EXACT_CAP - 4);
    }

    /// The title call's record round-trips, is left out when absent, loses its exact
    /// text in a listing copy and is held to the summary cap.
    #[test]
    fn the_title_call_record_is_trimmed_and_capped() {
        let none = serde_json::to_value(SentRecord::default()).unwrap();
        assert!(none.get("title").is_none(), "{none}");
        let mut r = record();
        r.sent.as_mut().unwrap().title = Some(SummarySent {
            kind: CallKind::Title,
            messages: 2,
            exact: Some("t".repeat(SUMMARY_EXACT_CAP + 10)),
            ..SummarySent::default()
        });
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["sent"]["title"]["kind"], "title");
        let back: AnswerRecord = serde_json::from_value(json).unwrap();
        assert_eq!(back, r);
        let t = r.trimmed_copy();
        let title = t.sent.as_ref().unwrap().title.as_ref().unwrap();
        assert_eq!(title.kind, CallKind::Title);
        assert!(title.exact.is_none());
        let capped = r.capped();
        let exact = capped.sent.unwrap().title.unwrap().exact.unwrap();
        assert_eq!(exact.len(), SUMMARY_EXACT_CAP);
    }

    #[test]
    fn record_is_capped() {
        let mut r = record();
        r.thinking = Some("é".repeat(THINKING_CAP));
        r.log = vec![r.log[0].clone(); 600];
        let r = r.capped();
        assert!(r.thinking.as_ref().unwrap().len() <= THINKING_CAP);
        assert_eq!(r.log.len(), 500);
    }

    #[test]
    fn record_sizes_are_capped() {
        let mut r = record();
        r.steps[0].evidence = (0..500)
            .map(|i| [format!("t{i}"), "rule".into(), "e".into()])
            .collect();
        r.sent.as_mut().unwrap().exact = Some("x".repeat(EXACT_CAP + 10));
        r.notes = vec!["n".repeat(1000); 50];
        r.sql_blocks = vec![r.sql_blocks[0].clone(); 100];
        r.sql_blocks[0].statements = vec![r.sql_blocks[0].statements[0].clone(); 400];
        r.sql_blocks[0].statements[0].text = "s".repeat(STATEMENT_CAP + 5);
        r.command_error = Some("e".repeat(5_000));
        let r = r.capped();
        assert_eq!(r.command_error.as_ref().unwrap().len(), 2 * 1024);
        let evidence = &r.steps[0].evidence;
        assert_eq!(evidence.len(), EVIDENCE_CAP + 1);
        assert_eq!(
            evidence[EVIDENCE_CAP],
            ["and 300 more".to_string(), String::new(), String::new()]
        );
        assert_eq!(
            r.sent.as_ref().unwrap().exact.as_ref().unwrap().len(),
            EXACT_CAP
        );
        assert_eq!(r.notes.len(), NOTES_CAP);
        assert!(r.notes.iter().all(|n| n.chars().count() <= NOTE_CHARS));
        assert_eq!(r.sql_blocks.len(), BLOCKS_CAP);
        assert_eq!(r.sql_blocks[0].statements.len(), STATEMENTS_CAP);
        assert_eq!(r.sql_blocks[0].statements[0].text.len(), STATEMENT_CAP);
    }
}
