//! Conversation memory: the Topics of a thread, its compactions and what is kept.

pub mod history;
pub mod rules;
pub mod store;

use serde::{Deserialize, Serialize};

use crate::ai::request::ItemKind;
use crate::ai::sent::AnswerRecord;
use crate::ai::{AiAccess, AiMessage, AiThread, ThreadId};
use crate::error::Result;
use crate::model::ConnectionId;

pub use history::{
    HistoryPick, HistorySummary, SummarySource, Turn, access_now, access_of, also_of, cover_ok,
    covers_of, history_allowed, legacy_covers, message_access, message_allowed, select_history,
    stamp_allowed, summary_covers_ok,
};
pub use rules::{
    AskFacts, BreakReason, EARLIER_TOPICS, RECENT_TURNS, SUMMARY_CHARS, TITLE_CHARS, TopicPick,
    rule_summary, topic_for, topic_title,
};

pub type CompactionId = uuid::Uuid;

/// The Asked in label: the where line as it went.
pub const ASKED_IN_LABEL_CHARS: usize = 120;
/// The Asked in summary of the This tab item as it went.
pub const ASKED_IN_SUMMARY_BYTES: usize = 400;
/// The Asked in steps, as the Recent steps item.
pub const ASKED_IN_STEPS_BYTES: usize = crate::ai::steps::STEPS_CAP;
/// The other Connections an Asked in names: a tab spans two at most today. An Ask that
/// names more is refused (`gather`), so the stamp always holds every one it was gated by.
pub const ASKED_IN_ALSO: usize = 4;
/// What a replayed steps line adds before the steps.
const STEPS_LEAD: &str = "steps before it: ";
/// What the replayed line of steps on other Connections adds before them.
pub(crate) const OTHER_STEPS_LEAD: &str = "steps on other Connections before it: ";
/// A tab kind id is a short word.
const TAB_ID_CHARS: usize = 32;
/// The longest tab key kept (`query:<uuid>` is 42).
pub const TAB_KEY_CHARS: usize = 128;

/// Where a question was asked (spec 6): the tab kind, the where line, a summary of the
/// This tab item and the Recent steps labels, each as they went, so it never holds more
/// than the turn sent. Kept on the question in the thread JSON and replayed framed with
/// the turn; the webview holds only `label_only`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AskedIn {
    /// The tab kind id: `query`, `object`, `visual`, `design`, `schema`, `compare`,
    /// `transfer`, `import`, `lineage`, `home`, `settings`, `savedQueries`.
    pub tab: String,
    /// The where line as it went (gated): `Visual Query "Orders over 1M" in shop`; the
    /// kind words when no This tab item went.
    pub label: String,
    /// The first facts of the This tab item as it went, joined with `; `; empty when no
    /// This tab item went.
    #[serde(default)]
    pub summary: String,
    /// The Recent steps labels that went on this Ask's Connection or on none, oldest
    /// first, without their age.
    #[serde(default)]
    pub steps: Vec<String>,
    /// The other Connections the tab spanned (`focus.also`): the turn is replayed only
    /// while each of them still allows what it carried (see `history::message_access`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub also: Vec<ConnectionId>,
    /// The Recent steps labels that went and are on another Connection, oldest first,
    /// without their age. Each is replayed only while its own Connection still allows the
    /// level its text needed (`replay_lines`), and is removed when that Connection's
    /// history is cleared or it is deleted (`AiService::forget_steps`). The webview never
    /// holds them: `label_only` drops them and the stamp it is sent leaves them out.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub other_steps: Vec<OtherStep>,
    /// The webview's key of the tab the question was asked in (`query:<id>`), so "Asked
    /// in" can show that tab again (UX step 9, A7). Set by the webview when it saves the
    /// turn; it names a tab, never what the tab holds, and is never replayed or sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_key: Option<String>,
}

/// A Recent step on a Connection other than the Ask's, kept with the Ask (the user's
/// ruling of 2026-10-23: sent and stored).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OtherStep {
    /// The Connection the step happened on.
    pub connection_id: ConnectionId,
    /// The rendered label as it went (gated at send time by that Connection's level).
    pub text: String,
    /// The access level the text needed when it was rendered (the highest part that went:
    /// Schema only for names, Schema and query text for titles and counts).
    pub level: AiAccess,
}

/// `text` on one line: control characters and line separators become spaces.
fn one_line(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') {
                ' '
            } else {
                c
            }
        })
        .collect()
}

impl AskedIn {
    /// The copy the webview is given: the tab and the label only (spec 6.2, memory), and
    /// the other Connections, which are ids, not data: a copy the webview saves back for a
    /// message the Core lacks (a failed append) keeps the gate on them.
    pub fn label_only(&self) -> AskedIn {
        AskedIn {
            tab: self.tab.clone(),
            label: self.label.clone(),
            also: self.also.clone(),
            tab_key: self.tab_key.clone(),
            ..AskedIn::default()
        }
    }

    /// Held to its caps, each part on one line: the label at 120 characters, the summary
    /// at 400 bytes cut at a `; ` boundary then a character boundary, each step at 160
    /// bytes and the steps at 1 KB as their replayed lines (`steps before it: a; b`, then
    /// the other Connections' line), the Ask's own steps first and the oldest dropped
    /// first. `append_turn` stores it so, whoever built it, and the replay reads it so.
    pub fn capped(&self) -> AskedIn {
        use crate::ai::rails::cap_chars;
        let tab: String = one_line(&self.tab).chars().take(TAB_ID_CHARS).collect();
        let label = one_line(&self.label);
        let label = if label.chars().count() > ASKED_IN_LABEL_CHARS {
            let mut cut: String = label.chars().take(ASKED_IN_LABEL_CHARS - 1).collect();
            cut.push('…');
            cut
        } else {
            label
        };
        let facts: Vec<String> = one_line(&self.summary)
            .split("; ")
            .map(str::to_string)
            .collect();
        let summary = crate::ai::scene::summary(&facts);
        let mut steps: Vec<String> = Vec::new();
        let mut bytes = STEPS_LEAD.len();
        // Newest first, so the oldest whole steps are the ones dropped.
        for step in self.steps.iter().rev() {
            let step = one_line(step);
            let step = cap_chars(&step, crate::ai::steps::STEP_LABEL_CAP).to_string();
            let add = step.len() + if steps.is_empty() { 0 } else { 2 };
            if step.is_empty() || bytes + add > ASKED_IN_STEPS_BYTES {
                break;
            }
            bytes += add;
            steps.push(step);
        }
        steps.reverse();
        // The other Connections' steps share what the own steps left of the 1 KB.
        let left = ASKED_IN_STEPS_BYTES.saturating_sub(if steps.is_empty() { 0 } else { bytes });
        let mut other_steps: Vec<OtherStep> = Vec::new();
        let mut bytes = OTHER_STEPS_LEAD.len();
        for step in self.other_steps.iter().rev() {
            let text = one_line(&step.text);
            let text = cap_chars(&text, crate::ai::steps::STEP_LABEL_CAP).to_string();
            let add = text.len() + if other_steps.is_empty() { 0 } else { 2 };
            if text.is_empty() || bytes + add > left {
                break;
            }
            bytes += add;
            // A step on a Connection needs Schema only at least.
            let level = match step.level {
                AiAccess::Never => AiAccess::Schema,
                l => l,
            };
            other_steps.push(OtherStep {
                connection_id: step.connection_id,
                text,
                level,
            });
        }
        other_steps.reverse();
        let mut also: Vec<ConnectionId> = Vec::new();
        for id in &self.also {
            if !also.contains(id) && also.len() < ASKED_IN_ALSO {
                also.push(*id);
            }
        }
        let tab_key = self
            .tab_key
            .as_deref()
            .map(|k| one_line(k).chars().take(TAB_KEY_CHARS).collect());
        AskedIn {
            tab,
            label,
            summary,
            steps,
            also,
            other_steps,
            tab_key,
        }
    }

    /// The lines a past turn replays, each framed as `asked_in`: `<label>: <summary>` (the
    /// label alone with no summary), then `steps before it: <steps>` when steps went, then
    /// the steps on other Connections whose Connection's current access in `others` (the
    /// gate of `also`, `access_now`: one not listed is Never) still reaches the level each
    /// needed. One that does not is left out silently; the turn itself is gated as before.
    pub fn replay_lines(&self, others: &[(ConnectionId, AiAccess)]) -> Vec<String> {
        let a = self.capped();
        let mut out = Vec::new();
        match (a.label.is_empty(), a.summary.is_empty()) {
            (true, true) => {}
            (false, true) => out.push(a.label),
            (true, false) => out.push(a.summary),
            (false, false) => out.push(format!("{}: {}", a.label, a.summary)),
        }
        if !a.steps.is_empty() {
            out.push(format!("{STEPS_LEAD}{}", a.steps.join("; ")));
        }
        use crate::ai::rails::input::rank;
        let go: Vec<&str> = a
            .other_steps
            .iter()
            .filter(|s| {
                let now = access_now(s.connection_id, others);
                now != AiAccess::Never && rank(now) >= rank(s.level)
            })
            .map(|s| s.text.as_str())
            .collect();
        if !go.is_empty() {
            out.push(format!("{OTHER_STEPS_LEAD}{}", go.join("; ")));
        }
        out
    }
}

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
    /// Where the question was asked; `None` with no tab, steps or other Connection. The
    /// UI stores it on the question only. Sent to the webview without `other_steps`: the
    /// Core holds those until the turn is stored (`AiService::hold_other_steps`).
    #[serde(serialize_with = "without_other_steps")]
    pub asked_in: Option<AskedIn>,
}

/// The stamp's Asked in as the webview is sent it: no steps on other Connections.
fn without_other_steps<S: serde::Serializer>(
    asked_in: &Option<AskedIn>,
    s: S,
) -> std::result::Result<S::Ok, S::Error> {
    asked_in
        .as_ref()
        .map(|a| AskedIn {
            other_steps: Vec::new(),
            ..a.clone()
        })
        .serialize(s)
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
    /// What its text covers, kept with it so the gate never depends on messages the thread
    /// may have dropped since (`MESSAGE_LIMIT`, a replaced turn): every folded message's
    /// stamp, and those the earlier summary it folded covered (Task 2 fix round 1).
    /// `None` for a compaction written before it was kept: the gate then fails closed
    /// (`history::legacy_covers`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub covers: Option<Vec<Cover>>,
}

/// The stamp of messages a summary's text covers: the Connection (`None`: Home) and
/// database they were asked on, the kinds they carried, the Connections they were asked
/// across and their steps on other Connections with the level each needed. The gate on
/// history reads a `Cover` exactly as it reads a message (`history::cover_ok`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Cover {
    pub connection_id: Option<ConnectionId>,
    #[serde(default)]
    pub database: Option<String>,
    pub kinds: Vec<ItemKind>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub also: Vec<ConnectionId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub steps: Vec<(ConnectionId, AiAccess)>,
}

impl Cover {
    pub fn of(m: &AiMessage) -> Cover {
        let asked = m.asked_in.as_ref();
        Cover {
            connection_id: m.connection_id,
            database: m.database.clone(),
            kinds: m.kinds.clone(),
            also: asked.map(|a| a.also.clone()).unwrap_or_default(),
            steps: asked
                .map(|a| {
                    a.other_steps
                        .iter()
                        .map(|s| (s.connection_id, s.level))
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    /// `covers` with each place (Connection, database and the Connections asked across)
    /// once, its kinds and steps unioned: a union is never less strict than its parts.
    pub fn merged(covers: impl IntoIterator<Item = Cover>) -> Vec<Cover> {
        let mut out: Vec<Cover> = Vec::new();
        for mut c in covers {
            c.also.sort();
            c.also.dedup();
            match out.iter_mut().find(|o| {
                o.connection_id == c.connection_id && o.database == c.database && o.also == c.also
            }) {
                Some(o) => {
                    for k in c.kinds {
                        if !o.kinds.contains(&k) {
                            o.kinds.push(k);
                        }
                    }
                    for s in c.steps {
                        if !o.steps.contains(&s) {
                            o.steps.push(s);
                        }
                    }
                }
                None => out.push(c),
            }
        }
        out
    }
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

/// Who wrote a chat's title: the rule (its first question), the AI (one short call after
/// the first answer) or the user (Rename). Stored as `rule`, `ai` or `user`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum TitleBy {
    #[default]
    Rule,
    Ai,
    User,
}

impl TitleBy {
    pub fn is_rule(&self) -> bool {
        *self == TitleBy::Rule
    }

    pub fn to_column(self) -> &'static str {
        match self {
            TitleBy::Rule => "rule",
            TitleBy::Ai => "ai",
            TitleBy::User => "user",
        }
    }

    /// An unknown value reads as the rule's.
    pub fn from_column(s: &str) -> TitleBy {
        match s {
            "ai" => TitleBy::Ai,
            "user" => TitleBy::User,
            _ => TitleBy::Rule,
        }
    }
}

/// The most bytes of SQL `LastWork` keeps, each of its two.
pub const LAST_WORK_SQL_BYTES: usize = 64 * 1024;
/// The longest tab label, database or table name `LastWork` keeps, in characters.
pub const LAST_WORK_LABEL_CHARS: usize = 120;

/// Where a chat last worked: the tab, the place, and the SQL a resume puts back (the SQL
/// the user inserted, else the newest the AI wrote). Kept in the thread JSON; the
/// `ai_threads.work` column holds it without either SQL field.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LastWork {
    /// The tab kind id (`AskedIn::tab`); empty when the question named none.
    #[serde(default)]
    pub tab_kind: String,
    #[serde(default)]
    pub tab_key: Option<String>,
    #[serde(default)]
    pub tab_label: Option<String>,
    #[serde(default)]
    pub connection_id: Option<ConnectionId>,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub table: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inserted_sql: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_sql: Option<String>,
    #[serde(default)]
    pub at: i64,
    /// The time of the answer `inserted_sql` came from, so a Retry that drops that answer
    /// drops it too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inserted_from: Option<i64>,
    /// The time of the answer `ai_sql` came from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_from: Option<i64>,
}

impl LastWork {
    /// Held to its caps: each SQL at `LAST_WORK_SQL_BYTES` (a character boundary), the tab
    /// key at `TAB_KEY_CHARS`, the label and names at `LAST_WORK_LABEL_CHARS`.
    pub fn capped(mut self) -> LastWork {
        let chars = |s: Option<String>, n: usize| s.map(|s| s.chars().take(n).collect());
        self.tab_kind = self.tab_kind.chars().take(TAB_ID_CHARS).collect();
        self.tab_key = chars(self.tab_key, TAB_KEY_CHARS);
        self.tab_label = chars(self.tab_label, LAST_WORK_LABEL_CHARS);
        self.database = chars(self.database, LAST_WORK_LABEL_CHARS);
        self.table = chars(self.table, LAST_WORK_LABEL_CHARS);
        self.inserted_sql = self
            .inserted_sql
            .map(|s| store::cut_bytes(s, LAST_WORK_SQL_BYTES));
        self.ai_sql = self
            .ai_sql
            .map(|s| store::cut_bytes(s, LAST_WORK_SQL_BYTES));
        self
    }

    /// The copy the `work` column holds, and a gated resume reads: no SQL, and nothing
    /// that tells there was any.
    pub fn without_sql(&self) -> LastWork {
        LastWork {
            inserted_sql: None,
            ai_sql: None,
            inserted_from: None,
            ai_from: None,
            ..self.clone()
        }
    }
}

/// What the user did with an answer's SQL, from the webview (`record_action`): the tab it
/// went into (the new tab for Open in new tab), its place, and the SQL as it went in.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkInput {
    #[serde(default)]
    pub tab_kind: String,
    #[serde(default)]
    pub tab_key: Option<String>,
    #[serde(default)]
    pub tab_label: Option<String>,
    #[serde(default)]
    pub connection_id: Option<ConnectionId>,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub sql: String,
}

/// Where a chat last worked, as its list row shows it: no SQL, ever.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkTag {
    #[serde(default)]
    pub connection_id: Option<ConnectionId>,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub table: Option<String>,
    #[serde(default)]
    pub tab_label: Option<String>,
}

/// A thread as the list shows it: no messages, read from the `ai_threads` columns only.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: ThreadId,
    pub place: String,
    pub title: String,
    pub title_by: TitleBy,
    pub updated_at: i64,
    pub messages: u32,
    pub topics: u32,
    pub work: Option<WorkTag>,
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

/// One Ask's turn for `append_turn`: its messages go after the stored thread's, so the
/// thread itself never crosses IPC (memory: an Ask used to send and rewrite it whole).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppendTurn {
    pub thread_id: ThreadId,
    /// For a thread the store does not have yet.
    pub place: String,
    /// For a thread the store does not have yet; a stored thread keeps its title.
    pub title: String,
    pub updated_at: i64,
    /// The question and its answer.
    pub messages: Vec<AiMessage>,
    /// A Retry: the stored messages from the one at this time on are replaced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace_from: Option<i64>,
}

/// What `append_turn` gives back: the new messages as stored (records trimmed), where the
/// thread now starts (older messages went over the cap), and its Topics and compactions.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TurnView {
    pub thread_id: ThreadId,
    pub place: String,
    pub title: String,
    pub updated_at: i64,
    pub messages: Vec<AiMessage>,
    /// Who wrote the title, and the AI title calls that failed: the webview names a chat
    /// whose title is still the rule's while it has tries left.
    pub title_by: TitleBy,
    pub title_tries: u8,
    /// The time of the oldest message kept; `None` for an empty thread.
    pub kept_from: Option<i64>,
    /// How many messages the thread holds now.
    pub message_count: u32,
    pub topics: Vec<Topic>,
    pub compactions: Vec<Compaction>,
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
    /// Sets the title and who wrote it, in the JSON and the list columns in one statement,
    /// leaving `updated_at` alone. False when the thread is gone, or when an AI title would
    /// replace the user's (`store::set_thread_title`).
    fn set_title(&self, thread: ThreadId, title: &str, by: TitleBy) -> Result<bool>;
    /// Counts one failed AI title call; returns the tries now counted (0 when the thread is
    /// gone). `updated_at` is left alone.
    fn title_failed(&self, thread: ThreadId) -> Result<u8>;
    /// Writes the title call's record (`SentRecord.title`, when its request left this PC)
    /// and its log lines into the record of the answer at `answer_at`, leaving everything
    /// else of the thread as it is stored now.
    fn record_title_call(
        &self,
        thread: ThreadId,
        answer_at: i64,
        sent: Option<&crate::ai::sent::SummarySent>,
        log: &[crate::ai::log::LogLine],
    ) -> Result<()>;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A7: the key of the tab a question was asked in goes back to the webview with the
    /// label, so "Asked in" can show that tab; it is held to one line and its cap, and it
    /// is never part of a replayed turn.
    #[test]
    fn the_tab_key_stays_with_the_label_and_is_never_replayed() {
        let a = AskedIn {
            tab: "query".into(),
            label: "Query 2".into(),
            summary: "current statement".into(),
            tab_key: Some(format!("query:{}", "k".repeat(300))),
            ..AskedIn::default()
        };
        assert_eq!(a.label_only().tab_key, a.tab_key);
        assert_eq!(a.capped().tab_key.unwrap().chars().count(), TAB_KEY_CHARS);
        let line = AskedIn {
            tab_key: Some("query:a\nb".into()),
            ..AskedIn::default()
        };
        assert_eq!(line.capped().tab_key.as_deref(), Some("query:a b"));
        let replayed = a.replay_lines(&[]).join("\n");
        assert!(!replayed.contains("query:"), "{replayed}");
        // An Asked in saved before the key has none, and one without it writes none.
        let old: AskedIn = serde_json::from_str(r#"{"tab":"query","label":"Query 2"}"#).unwrap();
        assert_eq!(old.tab_key, None);
        assert!(!serde_json::to_string(&old).unwrap().contains("tabKey"));
    }

    #[test]
    fn asked_in_caps() {
        // A 2 KB summary is cut at the last `; ` that fits 400 bytes.
        let fact = format!("ticked {}", "é".repeat(60));
        let facts: Vec<String> = (0..20).map(|i| format!("{fact}{i}")).collect();
        let long = facts.join("; ");
        assert!(long.len() > 2_000);
        let a = AskedIn {
            tab: "visual".into(),
            label: format!("Visual Query \"{}\" in shop", "ü".repeat(200)),
            summary: long,
            steps: (0..30)
                .map(|i| format!("ran the query {i} {}", "ß".repeat(40)))
                .collect(),
            also: Vec::new(),
            other_steps: Vec::new(),
            tab_key: None,
        }
        .capped();
        assert!(a.summary.len() <= ASKED_IN_SUMMARY_BYTES);
        assert_eq!(a.summary, facts[..3].join("; "));
        assert!(!a.summary.ends_with("; "));
        // The label at 120 characters, `…` last; multi-byte characters stay whole.
        assert_eq!(a.label.chars().count(), ASKED_IN_LABEL_CHARS);
        assert!(a.label.ends_with('…'));
        // Steps over 1 KB lose the oldest whole steps; the newest stays last.
        // The cap holds for the replayed line, its lead and `; ` joins counted.
        let replayed = a.replay_lines(&[]).pop().unwrap();
        assert!(replayed.starts_with(STEPS_LEAD), "{replayed}");
        assert!(replayed.len() <= ASKED_IN_STEPS_BYTES, "{}", replayed.len());
        assert!(a.steps.len() < 30);
        assert!(a.steps.last().unwrap().starts_with("ran the query 29 "));
        assert!(a.steps[0].starts_with(&format!("ran the query {} ", 30 - a.steps.len())));

        // One fact alone over 400 bytes is cut at a character boundary.
        let one = AskedIn {
            summary: "ü".repeat(300),
            ..AskedIn::default()
        }
        .capped();
        assert_eq!(one.summary, "ü".repeat(200));
        // A step over 160 bytes is cut at a character boundary.
        let step = AskedIn {
            steps: vec!["ü".repeat(100)],
            ..AskedIn::default()
        }
        .capped();
        assert_eq!(step.steps, vec!["ü".repeat(80)]);
        // Line breaks never reach a framed line.
        let lines = AskedIn {
            tab: "query".into(),
            label: "Query tab\n\"x\"".into(),
            summary: "a\u{2028}b".into(),
            steps: vec!["ran\rit".into()],
            also: Vec::new(),
            other_steps: Vec::new(),
            tab_key: None,
        }
        .replay_lines(&[]);
        assert_eq!(
            lines,
            vec![
                "Query tab \"x\": a b".to_string(),
                "steps before it: ran it".to_string()
            ]
        );
    }

    #[test]
    fn replay_lines_follow_what_is_kept() {
        let a = AskedIn {
            tab: "visual".into(),
            label: "Visual Query in shop".into(),
            summary: "tables orders".into(),
            steps: vec![
                "opened Visual Query in shop".into(),
                "ticked orders.id".into(),
            ],
            also: Vec::new(),
            other_steps: Vec::new(),
            tab_key: None,
        };
        assert_eq!(
            a.replay_lines(&[]),
            vec![
                "Visual Query in shop: tables orders".to_string(),
                "steps before it: opened Visual Query in shop; ticked orders.id".to_string()
            ]
        );
        let bare = AskedIn {
            summary: String::new(),
            steps: Vec::new(),
            ..a.clone()
        };
        assert_eq!(
            bare.replay_lines(&[]),
            vec!["Visual Query in shop".to_string()]
        );
        assert!(AskedIn::default().replay_lines(&[]).is_empty());
        let label = a.label_only();
        assert_eq!(
            (label.tab.as_str(), label.label.as_str()),
            ("visual", "Visual Query in shop")
        );
        assert!(label.summary.is_empty() && label.steps.is_empty());
        // The other Connections stay: the gate on them must survive a save of the copy.
        let other = uuid::Uuid::from_u128(43);
        let across = AskedIn {
            also: vec![other],
            ..a.clone()
        };
        assert_eq!(across.label_only().also, vec![other]);
    }

    fn other(id: u128, text: &str, level: AiAccess) -> OtherStep {
        OtherStep {
            connection_id: uuid::Uuid::from_u128(id),
            text: text.into(),
            level,
        }
    }

    /// Task 5b, test 6: own steps and other steps share the 1 KB; own steps are kept first,
    /// then the newest other steps, each whole.
    #[test]
    fn other_steps_share_the_steps_budget() {
        let b = uuid::Uuid::from_u128(43);
        let all = [(b, AiAccess::SchemaQuery)];
        let own: Vec<String> = (0..5)
            .map(|i| format!("ran the query {i} {}", "s".repeat(100)))
            .collect();
        let others: Vec<OtherStep> = (0..10)
            .map(|i| {
                other(
                    43,
                    &format!(
                        "ran the Visual Query {i} on another Connection {}",
                        "o".repeat(90)
                    ),
                    AiAccess::Schema,
                )
            })
            .collect();
        let a = AskedIn {
            steps: own.clone(),
            other_steps: others.clone(),
            ..AskedIn::default()
        }
        .capped();
        // Every own step fits and is kept; the other steps fill what is left.
        assert_eq!(a.steps, own);
        assert!(!a.other_steps.is_empty() && a.other_steps.len() < 10);
        // The newest other steps are the ones kept.
        assert_eq!(a.other_steps.last(), others.last());
        let lines = a.replay_lines(&all);
        let bytes: usize = lines[lines.len() - 2..].iter().map(String::len).sum();
        assert!(bytes <= ASKED_IN_STEPS_BYTES, "{bytes}");
        assert!(lines.last().unwrap().starts_with(OTHER_STEPS_LEAD));

        // Own steps over 1 KB leave no room for other steps.
        let many: Vec<String> = (0..30)
            .map(|i| format!("ran the query {i} {}", "s".repeat(100)))
            .collect();
        let a = AskedIn {
            steps: many,
            other_steps: others.clone(),
            ..AskedIn::default()
        }
        .capped();
        assert!(!a.steps.is_empty());
        assert!(a.other_steps.is_empty());

        // Other steps alone have the whole 1 KB; each is one line of at most 160 bytes.
        let a = AskedIn {
            other_steps: vec![other(
                43,
                &format!("a\nb{}", "ü".repeat(100)),
                AiAccess::Schema,
            )],
            ..AskedIn::default()
        }
        .capped();
        assert_eq!(a.other_steps[0].text, format!("a b{}", "ü".repeat(78)));
        assert!(a.other_steps[0].text.len() <= crate::ai::steps::STEP_LABEL_CAP);
    }

    /// Task 5b, test 2 (unit): each other step is replayed only while its own Connection's
    /// current access reaches the level its text needed; a deleted one counts as Never.
    #[test]
    fn other_steps_replay_at_their_connection_access() {
        let b = uuid::Uuid::from_u128(43);
        let c = uuid::Uuid::from_u128(44);
        let a = AskedIn {
            tab: "visual".into(),
            label: "Visual Query in shop".into(),
            steps: vec!["ticked orders.id".into()],
            other_steps: vec![
                other(
                    43,
                    "opened Visual Query on another Connection",
                    AiAccess::Schema,
                ),
                other(
                    43,
                    "ran the Visual Query \"Late\" on another Connection, 3 rows",
                    AiAccess::SchemaQuery,
                ),
                other(
                    44,
                    "opened Query tab on another Connection",
                    AiAccess::Schema,
                ),
            ],
            ..AskedIn::default()
        };
        let lead = OTHER_STEPS_LEAD;
        let at = |others: &[(ConnectionId, AiAccess)]| a.replay_lines(others);
        assert_eq!(
            at(&[(b, AiAccess::SchemaQuery), (c, AiAccess::Schema)]),
            vec![
                "Visual Query in shop".to_string(),
                "steps before it: ticked orders.id".to_string(),
                format!(
                    "{lead}opened Visual Query on another Connection; ran the Visual Query \"Late\" on another Connection, 3 rows; opened Query tab on another Connection"
                ),
            ]
        );
        // B lowered to Schema only: its query-text line is dropped, the rest replays.
        assert_eq!(
            at(&[(b, AiAccess::Schema), (c, AiAccess::Schema)])[2],
            format!(
                "{lead}opened Visual Query on another Connection; opened Query tab on another Connection"
            )
        );
        // B at Never, or deleted (not listed): none of B's lines.
        for others in [
            vec![(b, AiAccess::Never), (c, AiAccess::Schema)],
            vec![(c, AiAccess::Schema)],
        ] {
            assert_eq!(
                at(&others)[2],
                format!("{lead}opened Query tab on another Connection")
            );
        }
        // None may go: no other steps line at all; the own steps and label stay.
        assert_eq!(
            at(&[]),
            vec![
                "Visual Query in shop".to_string(),
                "steps before it: ticked orders.id".to_string()
            ]
        );
        // The webview's copy never carries them.
        assert!(a.label_only().other_steps.is_empty());
    }

    /// Task 5b, test 7: an Asked in stored before other steps loads, and saves back without
    /// the field.
    #[test]
    fn asked_in_without_other_steps_loads() {
        let old = r#"{"tab":"visual","label":"Visual Query in shop","summary":"tables orders","steps":["ticked orders.id"]}"#;
        let a: AskedIn = serde_json::from_str(old).unwrap();
        assert!(a.other_steps.is_empty());
        assert_eq!(serde_json::to_string(&a).unwrap(), old);
        let with = AskedIn {
            other_steps: vec![other(
                43,
                "opened Query tab on another Connection",
                AiAccess::SchemaQuery,
            )],
            ..a
        };
        let json = serde_json::to_string(&with).unwrap();
        assert!(
            json.contains(r#""otherSteps":[{"connectionId":"00000000-0000-0000-0000-00000000002b","text":"opened Query tab on another Connection","level":"schemaQuery"}]"#),
            "{json}"
        );
        assert_eq!(serde_json::from_str::<AskedIn>(&json).unwrap(), with);
    }
}
