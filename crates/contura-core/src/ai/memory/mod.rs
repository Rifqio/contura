//! Conversation memory: the Topics of a thread, its compactions and what is kept.

pub mod history;
pub mod rules;
pub mod store;

use serde::{Deserialize, Serialize};

use crate::ai::request::ItemKind;
use crate::ai::sent::AnswerRecord;
use crate::ai::{AiThread, ThreadId};
use crate::error::Result;
use crate::model::ConnectionId;

pub use history::{
    HistoryPick, HistorySummary, SummarySource, Turn, closing_topic, history_allowed,
    select_history,
};
pub use rules::{
    AskFacts, BreakReason, EARLIER_TOPICS, IDLE_MS, RECENT_TURNS, SUMMARY_CHARS, TITLE_CHARS,
    TopicPick, rule_summary, topic_for, topic_title,
};

pub type CompactionId = uuid::Uuid;

/// The memory stamp of one Ask: the UI stores it on both messages of the turn, and the
/// gate on history reads it back (R1.7). `kinds` are the kinds the turn sent, the thread
/// itself left out.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnStamp {
    pub topic: u32,
    pub opened: bool,
    pub reason: Option<BreakReason>,
    pub title: String,
    pub connection_id: Option<ConnectionId>,
    pub database: Option<String>,
    pub action: String,
    pub tables: Vec<String>,
    pub kinds: Vec<ItemKind>,
}

/// What the thread gives one Ask, as Sends shows it: the Topic and what goes of it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    pub topic: u32,
    pub opened: bool,
    pub reason: Option<BreakReason>,
    pub title: String,
    /// Turns and summaries that go, after the 200 KB cut; 0 with the Thread row off.
    pub turns: u32,
    pub summaries: u32,
    /// Messages the gate on history held back on this Connection and database (see
    /// `HistoryPick::blocked`).
    pub blocked: u32,
    pub tokens: u32,
}

/// Who wrote a summary. Stored as `''`, `rules` or `model:<id>`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SummaryBy {
    None,
    Rules,
    Model { model: String },
}

impl SummaryBy {
    pub(crate) fn to_column(&self) -> String {
        match self {
            SummaryBy::None => String::new(),
            SummaryBy::Rules => "rules".into(),
            SummaryBy::Model { model } => format!("model:{model}"),
        }
    }

    pub(crate) fn from_column(s: &str) -> SummaryBy {
        match s {
            "rules" => SummaryBy::Rules,
            _ => match s.strip_prefix("model:") {
                Some(model) => SummaryBy::Model {
                    model: model.into(),
                },
                None => SummaryBy::None,
            },
        }
    }
}

/// One run of a thread's turns on one subject, in one Connection and database.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Topic {
    pub thread_id: ThreadId,
    pub seq: u32,
    pub title: String,
    pub summary: String,
    pub summary_by: SummaryBy,
    pub tables: Vec<String>,
    pub connection_id: Option<ConnectionId>,
    pub database: Option<String>,
    pub kinds: Vec<ItemKind>,
    pub first_at: i64,
    pub last_at: i64,
    pub messages: u32,
    pub closed: bool,
}

/// A span of messages folded into a summary. A message is hidden when its `at` lies in
/// `[first_at, last_at]` of a compaction of its thread that is not undone.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Compaction {
    pub id: CompactionId,
    pub thread_id: ThreadId,
    pub topic: u32,
    pub first_at: i64,
    pub last_at: i64,
    pub messages: u32,
    pub summary: String,
    pub summary_by: SummaryBy,
    pub connection_id: Option<ConnectionId>,
    pub database: Option<String>,
    pub kinds: Vec<ItemKind>,
    pub before: u32,
    pub after: u32,
    pub at: i64,
    pub undone: bool,
    /// The log and Sent record of a Compact now run; empty for a compaction made inside
    /// an Ask, whose record is the Ask's.
    pub record: AnswerRecord,
}

impl Compaction {
    /// A copy with its record trimmed, as the webview is given it.
    pub fn trimmed_copy(&self) -> Compaction {
        Compaction {
            record: self.record.trimmed_copy(),
            ..self.clone()
        }
    }
}

/// A thread as the list shows it: no messages.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: ThreadId,
    pub place: String,
    pub title: String,
    pub updated_at: i64,
    pub messages: u32,
    pub topics: u32,
}

/// A thread with its Topics and compactions. Every record is trimmed (see
/// `AnswerRecord::trimmed_copy`), and so is the record of every compaction.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadView {
    pub thread: AiThread,
    pub topics: Vec<Topic>,
    pub compactions: Vec<Compaction>,
}

/// One Topic found by a search of a place's threads.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadHit {
    pub thread_id: ThreadId,
    pub title: String,
    pub topic: u32,
    pub topic_title: String,
    /// The Topic's summary, else its first question, cut to 120 characters.
    pub snippet: String,
    pub at: i64,
}

/// Where a thread's Topics and compactions are kept.
pub trait ThreadStore: Send + Sync {
    fn thread(&self, id: ThreadId) -> Result<Option<AiThread>>;
    /// By `seq`.
    fn topics(&self, thread: ThreadId) -> Result<Vec<Topic>>;
    /// By `at`, undone ones included.
    fn compactions(&self, thread: ThreadId) -> Result<Vec<Compaction>>;
    /// The `seq` of closed Topics whose title, summary or tables hold one of `terms`
    /// (questions are not searched), best first.
    fn match_topics(&self, thread: ThreadId, terms: &[String], limit: usize) -> Result<Vec<u32>>;
    /// Also rewrites the Topic's FTS row.
    fn set_topic_summary(
        &self,
        thread: ThreadId,
        seq: u32,
        summary: &str,
        by: &SummaryBy,
    ) -> Result<()>;
    fn add_compaction(&self, c: &Compaction) -> Result<()>;
    /// False when the compaction is missing or already undone.
    fn undo_compaction(&self, thread: ThreadId, id: CompactionId) -> Result<bool>;
}
