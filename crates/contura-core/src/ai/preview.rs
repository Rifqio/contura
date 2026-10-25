//! The Ask preview: what one Ask would send, built and measured in the Core (R1.6).
//! It reads the stored Connection, never the request, for the access level (R1.2).

use serde::Serialize;

use std::time::Instant;

use crate::ai::budget::{
    Budget, LEFT_OUT, NAMES_ONLY, OPEN_TAB, PAYLOAD_CAP, TableFit, budget, cap_payload,
    estimate_tokens,
};
use crate::ai::context::cards::cleaner;
use crate::ai::context::outline::{
    OutlineRequest, Resolved, TablePicker, build_outline, parse_reply, resolve, should_outline,
};
use crate::ai::context::retrieve::{Retrieval, Seeds, question_terms, retrieve};
use crate::ai::context::store::{ContextKey, ContextStore};
use crate::ai::context::sync::{ContextInfo, Purpose, context_key, ensure};
use crate::ai::context::tree::{Area, areas_for};
use crate::ai::log::{Level, Log, LogLine, ProcessStep, StepKind, error_kind};
use crate::ai::memory::{
    ASKED_IN_ALSO, AskFacts, AskedIn, HistoryPick, HistorySummary, MemoryInfo, SummarySource,
    ThreadStore, TopicPick, Turn, TurnStamp, also_of, closing_topic, select_history, topic_for,
};
use crate::ai::models::{ModelInfo, clamp};
use crate::ai::prompt::outline_prompt;
use crate::ai::provider::{ChatRole, max_tokens_on_wire, wire_thinking};
use crate::ai::rails::input::{needs_access, rank};
use crate::ai::rails::retrieval::{ASKED_IN_SOURCE, framed_lines, outline_block};
use crate::ai::rails::{
    Ask, InputRail, RetrievalRail, Secrets, allowed, cap_chars, framed_text, lock_reason,
    new_boundary, run_rails, schema_text,
};
use crate::ai::request::{AskRequest, Item, ItemKind, Switches, TableRef};
use crate::ai::rows::{SAMPLE_ROWS, SampleTable, fit_rows, format_rows};
use crate::ai::scene::{AskTab, TabText, kind_id, kind_words, tab_text};
use crate::ai::sent::{CallKind, OutlineSent, RowsSent};
use crate::ai::steps::{StepIn, StepsOut, render_steps, step_connections, steps_notes};
use crate::ai::{AiAccess, AiRole, AiSettings, AiThread, now_ms};
use crate::common::grouped;
use crate::error::{Error, Result};
use crate::model::{ConnectionConfig, ConnectionId, DialectKind, ObjectKind, ObjectPath, Page};
use crate::query::SavedQuery;
use crate::schema_model::SchemaModel;

use crate::ai::stream::DEFAULT_MAX_TOKENS;

/// Exact secrets shorter than this are not matched: a 1 to 3 character password would
/// shred every text. The pattern shapes (R2.1) still catch them.
const MIN_SECRET_CHARS: usize = 4;

/// The order context is cut in when the framed text is over the 200 KB cap. DBML has no
/// budget share, so it goes before the fitted cards; the saved queries follow the cards in
/// the schema share, so they go just before them; the thread goes after the saved queries
/// (its summaries, then its oldest turns); Recent steps (oldest first) and This tab follow
/// the thread and go before the cards, which carry the facts the model needs most; query
/// text goes last; the question is never cut.
const TRIM_ORDER: [ItemKind; 10] = [
    ItemKind::Rows,
    ItemKind::Dbml,
    ItemKind::SavedQueries,
    ItemKind::History,
    ItemKind::Steps,
    ItemKind::Tab,
    ItemKind::Cards,
    ItemKind::Names,
    ItemKind::Error,
    ItemKind::Sql,
];

/// The Sends row of the This tab item; the injection note names it so.
const TAB_LABEL: &str = "This tab";
/// The Sends row of the Recent steps item, then ` · <n>`.
const STEPS_LABEL: &str = "Recent steps";
/// The SQL item of a Compare tab (its ticked statements) and of a view, routine or
/// trigger tab (its definition).
pub(crate) const SYNC_LABEL: &str = "Sync script";
const DEFINITION_LABEL: &str = "Definition";
/// How lock reasons name a Connection `focus.also` names that is gone.
const MISSING_ALSO: &str = "The other Connection";

const UNREADABLE_NOTE: &str = "The AI Context could not be read, so no tables are sent.";

/// Step 11f: the Sample rows Sends row with nothing to read.
const ROWS_LABEL: &str = "Sample rows";
const NO_NAMED_LABEL: &str = "Sample rows · no named table";
const NO_NAMED_NOTE: &str =
    "Sample rows go only for tables named in the editor or the question, or open in a tab.";
/// How the retrieval rail's injection note names a rows item.
const ROWS_NOTE_LEAD: &str = "Sample rows from ";
/// The Ask's status while the rows are read.
const READING_ROWS: &str = "Reading sample rows";
const ROWS_RULE: &str = "Read live by Contura in a read-only transaction: at most 5 rows per named table, cells cut at 200 characters, binaries as <binary>. Never stored.";
/// How long one sample read may take before it counts as failed: the Dialects' own 5 s
/// limit and a little room for the round trip.
const SAMPLE_READ_LIMIT: std::time::Duration =
    std::time::Duration::from_millis(crate::dialect::SAMPLE_TIMEOUT_MS + 500);
/// What `ConnectionService` says for a Connection that is not open.
const NOT_OPEN: &str = "connection not open";

/// The stored Connections and their schema, as the preview reads them.
#[async_trait::async_trait]
pub trait CatalogReader: Send + Sync {
    async fn connection_config(&self, id: ConnectionId) -> Result<Option<ConnectionConfig>>;
    /// A fresh snapshot, read only to build an AI Context.
    async fn schema_snapshot(
        &self,
        id: ConnectionId,
        database: &str,
        schema: Option<&str>,
    ) -> Result<SchemaModel>;
    /// The Dialect's catalog fingerprint of one database or schema; no rows are read.
    async fn schema_fingerprint(
        &self,
        id: ConnectionId,
        database: &str,
        schema: Option<&str>,
    ) -> Result<String>;
    /// Where the AI Contexts are kept.
    fn context(&self) -> &dyn ContextStore;
    /// Where the threads' Topics and compactions are kept.
    fn threads(&self) -> &dyn ThreadStore;
    /// The stored Saved Queries, for building a Context; no database call.
    async fn saved_queries(&self) -> Result<Vec<SavedQuery>> {
        Ok(Vec::new())
    }
    /// Step 11f: up to `limit` live rows of one base table, read only. Never opens a
    /// closed Connection.
    async fn sample_rows(&self, id: ConnectionId, path: &ObjectPath, limit: u32) -> Result<Page> {
        let _ = (id, path, limit);
        Err(Error::NotFound("sample rows are not available".into()))
    }
    /// Whether `id`'s Group sends to another AI provider than this Ask's, so nothing
    /// about it goes with the Ask (`SameProvider`). A plain catalog holds none back.
    fn other_provider(&self, id: ConnectionId) -> bool {
        let _ = id;
        false
    }
}

/// The catalog one Ask reads through: a Connection whose Group sends to another AI
/// provider than the Ask's (ADR 0010's per-Group override) reads as AI access Never, so
/// nothing about it is sent with this Ask, stored with its turn or replayed by it: not
/// the Ask's own Connection, not another Connection the tab spans, not a step on it.
/// `same` lists the Connections whose Group sends where the Ask sends
/// (`AiService::same_provider`); any other one is held back.
pub struct SameProvider<'a> {
    inner: &'a dyn CatalogReader,
    same: Vec<ConnectionId>,
}

impl<'a> SameProvider<'a> {
    pub fn new(inner: &'a dyn CatalogReader, same: Vec<ConnectionId>) -> Self {
        Self { inner, same }
    }

    /// At Never nothing reads a Connection's schema or rows; this holds if a path forgets.
    fn refuse(&self, id: ConnectionId) -> Result<()> {
        if self.other_provider(id) {
            return Err(Error::NotFound(
                "that Connection uses another Group's AI provider".into(),
            ));
        }
        Ok(())
    }
}

/// The Sends note for a Connection held back by `SameProvider`.
fn other_provider_note(name: &str) -> String {
    format!("{name} uses another Group's AI provider, so nothing about it goes.")
}

#[async_trait::async_trait]
impl CatalogReader for SameProvider<'_> {
    async fn connection_config(&self, id: ConnectionId) -> Result<Option<ConnectionConfig>> {
        let config = self.inner.connection_config(id).await?;
        Ok(config.map(|mut c| {
            if self.other_provider(c.id) {
                c.ai_access = AiAccess::Never;
            }
            c
        }))
    }

    async fn schema_snapshot(
        &self,
        id: ConnectionId,
        database: &str,
        schema: Option<&str>,
    ) -> Result<SchemaModel> {
        self.refuse(id)?;
        self.inner.schema_snapshot(id, database, schema).await
    }

    async fn schema_fingerprint(
        &self,
        id: ConnectionId,
        database: &str,
        schema: Option<&str>,
    ) -> Result<String> {
        self.refuse(id)?;
        self.inner.schema_fingerprint(id, database, schema).await
    }

    fn context(&self) -> &dyn ContextStore {
        self.inner.context()
    }

    fn threads(&self) -> &dyn ThreadStore {
        self.inner.threads()
    }

    async fn saved_queries(&self) -> Result<Vec<SavedQuery>> {
        self.inner.saved_queries().await
    }

    async fn sample_rows(&self, id: ConnectionId, path: &ObjectPath, limit: u32) -> Result<Page> {
        self.refuse(id)?;
        self.inner.sample_rows(id, path, limit).await
    }

    fn other_provider(&self, id: ConnectionId) -> bool {
        !self.same.contains(&id)
    }
}

/// One row of the Sends list, measured after cleaning.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewItem {
    pub kind: ItemKind,
    pub label: String,
    pub bytes: u32,
    pub tokens: u32,
    pub locked: Option<String>,
    pub on: bool,
}

/// The parts of what is sent besides the system prompt: the schema block, which goes in
/// the cached prefix, the thread's recent turns, and the turn (the per-request framed
/// block, then the question), which goes as the last user message. The turns and the turn
/// come after cache mark 2.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PromptParts {
    /// Empty when no cards go.
    pub schema: String,
    /// The thread's turns as user and assistant messages, oldest first.
    pub history: Vec<(ChatRole, String)>,
    pub turn: String,
}

/// The line "Show exactly" writes above a history message; it is not sent.
fn role_line(role: ChatRole) -> &'static str {
    match role {
        ChatRole::User => "[user]\n",
        ChatRole::Assistant => "[assistant]\n",
    }
}

impl PromptParts {
    /// What "Show exactly" displays: the schema block, a blank line, each history message
    /// after a line `[user]` or `[assistant]` and before a blank line, then the turn.
    pub fn exact(&self) -> String {
        let mut out = String::new();
        if !self.schema.is_empty() {
            out.push_str(&self.schema);
            out.push_str("\n\n");
        }
        for (role, text) in &self.history {
            out.push_str(role_line(*role));
            out.push_str(text);
            out.push_str("\n\n");
        }
        out.push_str(&self.turn);
        out
    }

    /// The bytes `exact` adds around the history messages that are never sent.
    fn role_line_bytes(&self) -> usize {
        self.history
            .iter()
            .map(|(role, _)| role_line(*role).len() + 2)
            .sum()
    }
}

/// A past question as it goes: with an Asked in, framed with the request's boundary as the
/// turn is, then `Question: `; without one, as it was asked.
fn past_question(t: &Turn, boundary: &str) -> String {
    match &t.asked_in {
        Some(lines) => {
            let mut out = framed_lines(boundary, ASKED_IN_SOURCE, lines);
            out.push_str("Question: ");
            out.push_str(&t.question);
            out
        }
        None => t.question.clone(),
    }
}

fn compose(ask: &Ask, boundary: &str, question: &str, turns: &[Turn]) -> PromptParts {
    PromptParts {
        schema: schema_text(ask),
        history: turns
            .iter()
            .flat_map(|t| {
                [
                    (ChatRole::User, past_question(t, boundary)),
                    (ChatRole::Assistant, t.answer.clone()),
                ]
            })
            .collect(),
        turn: framed_text(ask, boundary, question),
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub items: Vec<PreviewItem>,
    pub tables: TableFit,
    pub total_bytes: u32,
    /// About: an estimate from bytes, measured after framing.
    pub tokens: u32,
    /// What "Show exactly" displays, byte for byte: `parts.exact()`.
    pub exact: String,
    pub notes: Vec<String>,
    pub log: Vec<LogLine>,
    /// The AI Context the cards came from; `None` with no Connection, at Never, or with
    /// the Cards item off or locked.
    pub context: Option<ContextInfo>,
    /// The same text split where the request splits it; the Ask sends these.
    #[serde(skip)]
    pub parts: PromptParts,
    /// The Dialect the system prompt names: `None` with no Connection or one at Never, so
    /// a Connection the assistant may not see does not even give its Dialect away.
    #[serde(skip)]
    pub dialect: Option<DialectKind>,
    /// The Steps rows the preview ran: Access, Schema and Tables when the schema was read,
    /// Cleaning.
    #[serde(skip)]
    pub steps: Vec<ProcessStep>,
    /// The Connection's Dialect at any AI access, for checking the answer's SQL; it is
    /// never sent.
    #[serde(skip)]
    pub sql_dialect: Option<DialectKind>,
    /// The Connection is Read-only: the answer's writes will not run (R6.2).
    #[serde(skip)]
    pub read_only: bool,
    /// The outline step tier 3 would add, when it triggers.
    pub outline: Option<OutlinePreview>,
    /// The outline call, once it was made: only an Ask makes it.
    #[serde(skip)]
    pub outline_sent: Option<OutlineSent>,
    /// The Topic and what the thread gives this Ask; `None` without a thread of this place.
    pub memory: Option<MemoryInfo>,
    /// The stamp the Ask emits as `Memory`, with or without a thread.
    #[serde(skip)]
    pub stamp: TurnStamp,
    /// The summary step the Ask would make (a Topic summary or a compaction), never made
    /// by a preview; `None` when the Ask would make no summary call.
    pub summary: Option<SummaryPreview>,
    /// The sample rows the Ask would send; `None` until they are read.
    pub rows: Option<RowsSent>,
}

/// The summary step as Sends shows it: the call the Ask would make, not made.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SummaryPreview {
    pub kind: CallKind,
    /// The Topic summarised; `None` for a compaction.
    pub topic: Option<u32>,
    /// That Topic's title.
    pub title: Option<String>,
    pub messages: u32,
    pub bytes: u32,
    pub tokens: u32,
    /// What "Show exactly" displays: the call's user message.
    pub exact: String,
    /// False when the Summary row is switched off: Contura writes the summary by rules.
    pub on: bool,
}

/// The outline step as Sends shows it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutlinePreview {
    pub tables: u32,
    pub areas: u32,
    pub level: u8,
    /// What "Show exactly" displays: the outline block, a blank line, the turn.
    pub exact: String,
}

fn access_id(access: AiAccess) -> &'static str {
    match access {
        AiAccess::Never => "never",
        AiAccess::Schema => "schema",
        AiAccess::SchemaQuery => "schemaQuery",
        AiAccess::SchemaQueryRows => "schemaQueryRows",
    }
}

fn bytes_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn new_item(kind: ItemKind, label: &str, text: &str) -> Item {
    Item {
        kind,
        label: label.into(),
        text: text.into(),
        locked: None,
        on: true,
    }
}

const UNTIED_DBML: &str = "DBML · not tied to a Connection";

/// The Cards row's label before the schema is read: the focus tables when there are any.
fn tables_label(req: &AskRequest) -> String {
    match req.focus.tables.as_slice() {
        [] => "Schema".into(),
        [one] => format!("Schema · {}", one.name),
        many => format!("Schema · {} tables", many.len()),
    }
}

/// The Cards row's label once the cards are cut: never less than what leaves the PC.
/// `sent` counts the tables that go (full or names only), `focus` the focus tables the
/// schema holds, which go first. "Schema · orders" only when exactly the focus table goes.
fn sent_label(req: &AskRequest, sent: usize, focus: usize) -> String {
    let tables = count_of(sent, "table", "tables");
    match (req.focus.tables.as_slice(), focus) {
        ([one], 1) if sent == 1 => format!("Schema · {}", one.name),
        ([one], 1) if sent > 1 => format!("Schema · {tables}, {} first", one.name),
        (_, k) if k > 0 && sent > k => format!("Schema · {tables}, {k} named first"),
        _ => format!("Schema · {tables}"),
    }
}

/// The open tabs among the tables that go (in full or names only), for `sent_label`: an
/// open tab the budget or the 200 KB cut left out keeps its rank rule but is not sent.
fn open_sent(fit: &TableFit) -> usize {
    fit.reasons
        .iter()
        .filter(|(table, rule, _)| {
            rule == OPEN_TAB && (fit.full.contains(table) || fit.names_only.contains(table))
        })
        .count()
}

/// A window as the UI writes it: `8K`, `131K`, `1M`, `1.5M`.
pub(crate) fn window_text(tokens: u32) -> String {
    if tokens >= 999_500 {
        let tenths = (u64::from(tokens) + 50_000) / 100_000;
        if tenths % 10 == 0 {
            format!("{}M", tenths / 10)
        } else {
            format!("{}.{}M", tenths / 10, tenths % 10)
        }
    } else if tokens >= 1000 {
        format!("{}K", (tokens + 500) / 1000)
    } else {
        tokens.to_string()
    }
}

/// Database and schema names; never the Connection's name, host or user (R2.5).
fn names_text(database: Option<&str>, schema: Option<&str>) -> Option<String> {
    match (database, schema) {
        (None, None) => None,
        (Some(d), None) => Some(format!("Database: {d}")),
        (None, Some(s)) => Some(format!("Schema: {s}")),
        (Some(d), Some(s)) => Some(format!("Database: {d}, schema: {s}")),
    }
}

/// The secrets long enough to match exactly (`MIN_SECRET_CHARS`).
pub(crate) fn long_secrets(secrets: &Secrets) -> Secrets {
    let long_enough = |list: &[String]| -> Vec<String> {
        list.iter()
            .filter(|s| s.chars().count() >= MIN_SECRET_CHARS)
            .cloned()
            .collect()
    };
    Secrets {
        keys: long_enough(&secrets.keys),
        passwords: long_enough(&secrets.passwords),
    }
}

/// The saved queries the AI Context picked, as `<name>: <masked sql>`: one item each, so
/// each is framed alone, under one Sends row. `locked` gives that row with no query when
/// the Context holds some but the AI access lets none go.
#[derive(Clone, Debug)]
struct SavedItems {
    texts: Vec<String>,
    locked: bool,
}

/// The Sends items in display order, before the gate. `cards_label` is `None` when there
/// is no Cards row: no focus tables and no Connection.
fn build_items(
    req: &AskRequest,
    tab: Option<&TabText>,
    trail: Option<&StepsOut>,
    cards_label: Option<String>,
    cards: &str,
    saved: &SavedItems,
    rows: &GatheredRows,
) -> Vec<Item> {
    let focus = &req.focus;
    let mut items = vec![new_item(ItemKind::Question, "Question", &req.question)];
    if let Some(text) = names_text(req.database.as_deref(), req.schema.as_deref()) {
        items.push(new_item(ItemKind::Names, "Database names", &text));
    }
    // This tab and Recent steps switched off keep their row with nothing in it, as Sample
    // rows does, so the row can be switched back on; the gate pass marks it off.
    let sent = |kind: ItemKind, text: &str| {
        if req.off.contains(&kind) {
            String::new()
        } else {
            text.to_string()
        }
    };
    if let Some(tab) = tab {
        items.push(new_item(
            ItemKind::Tab,
            TAB_LABEL,
            &sent(ItemKind::Tab, &tab.text),
        ));
    }
    if let Some(trail) = trail {
        let label = format!("{STEPS_LABEL} · {}", grouped(trail.lines() as u64));
        items.push(new_item(
            ItemKind::Steps,
            &label,
            &sent(ItemKind::Steps, &trail.text),
        ));
    }
    if let Some(label) = cards_label {
        items.push(new_item(ItemKind::Cards, &label, cards));
    }
    if let Some(dbml) = &focus.dbml {
        items.push(new_item(ItemKind::Dbml, "DBML", dbml));
    }
    if saved.texts.is_empty() && saved.locked {
        items.push(new_item(ItemKind::SavedQueries, "Saved queries", ""));
    }
    let label = format!("Saved queries · {}", saved.texts.len());
    for text in &saved.texts {
        items.push(new_item(ItemKind::SavedQueries, &label, text));
    }
    // Selection and filter text are SQL to the gate, so they are masked like it.
    let sql_label = match &req.tab {
        Some(AskTab::Compare { .. }) => SYNC_LABEL,
        Some(AskTab::Object { object, .. }) if *object != ObjectKind::Table => DEFINITION_LABEL,
        _ => "Query text",
    };
    let sql = [
        (sql_label, &focus.sql),
        ("Selection", &focus.selection),
        ("Filter text", &focus.filter),
    ];
    for (label, text) in sql {
        if let Some(text) = text {
            items.push(new_item(ItemKind::Sql, label, text));
        }
    }
    if let Some(error) = &focus.error {
        items.push(new_item(ItemKind::Error, "Error", error));
    }
    let has_values = items
        .iter()
        .any(|i| matches!(i.kind, ItemKind::Sql | ItemKind::Error));
    if has_values {
        let mut values = new_item(ItemKind::Values, "Literal values", "");
        values.on = req.switches.values;
        items.push(values);
    }
    // One item per table that gave rows, so each is framed alone, under one Sends row.
    if rows.tables.is_empty() {
        let label = if rows.ran && rows.named.is_empty() {
            NO_NAMED_LABEL
        } else {
            ROWS_LABEL
        };
        let mut empty = new_item(ItemKind::Rows, label, "");
        empty.on = req.switches.rows;
        items.push(empty);
    } else {
        let label = rows_label(rows.tables.len());
        for t in &rows.tables {
            items.push(new_item(ItemKind::Rows, &label, &t.text));
        }
    }
    items
}

/// The tab kind id the AI log names; never a label.
fn tab_kind(tab: Option<&AskTab>) -> String {
    tab.map_or("none", kind_id).into()
}

fn rows_label(tables: usize) -> String {
    format!("Sample rows · {}", count_of(tables, "table", "tables"))
}

/// The thread's turns as they go: none with the Thread row off.
fn sent_turns(turns: &[Turn], on: bool) -> &[Turn] {
    if on { turns } else { &[] }
}

/// Cuts framed items in `TRIM_ORDER` until the exact text fits 200 KB. Cutting `n` bytes
/// of an item's text removes at least `n` bytes of its JSON line, so each cut closes the
/// gap or empties the item. Cards are cut by whole lines and the fit is updated. The
/// thread is cut whole: its summaries one at a time, then its oldest turns one at a time.
fn trim_to_cap(
    ask: &mut Ask,
    boundary: &str,
    question: &str,
    fit: &mut TableFit,
    line_tables: &[String],
    turns: &mut Vec<Turn>,
    history_on: bool,
) -> (PromptParts, usize) {
    let mut parts = compose(ask, boundary, question, sent_turns(turns, history_on));
    let mut exact = parts.exact();
    let mut trimmed = 0;
    for kind in TRIM_ORDER {
        if kind == ItemKind::History {
            while history_on && exact.len() > PAYLOAD_CAP {
                if let Some(i) = ask.items.iter().rposition(|i| i.kind == ItemKind::History) {
                    ask.items.remove(i);
                } else if !turns.is_empty() {
                    turns.remove(0);
                } else {
                    break;
                }
                trimmed += 1;
                parts = compose(ask, boundary, question, sent_turns(turns, history_on));
                exact = parts.exact();
            }
            continue;
        }
        let picked: Vec<usize> = (0..ask.items.len())
            .rev()
            .filter(|&i| {
                let item = &ask.items[i];
                item.kind == kind && item.on && item.locked.is_none() && !item.text.is_empty()
            })
            .collect();
        for i in picked {
            if exact.len() <= PAYLOAD_CAP {
                return (parts, trimmed);
            }
            let over = exact.len() - PAYLOAD_CAP;
            let item = &mut ask.items[i];
            let keep = cap_chars(&item.text, item.text.len().saturating_sub(over)).len();
            if kind == ItemKind::Cards {
                // A newline byte is never inside a multi-byte char, so this is a boundary.
                let kept = item.text.as_bytes()[..=keep]
                    .iter()
                    .rposition(|b| *b == b'\n')
                    .unwrap_or(0);
                item.text.truncate(kept);
                drop_cut_tables(fit, line_tables, item.text.lines().count());
            } else if kind == ItemKind::Steps {
                // Whole lines, the oldest (first) ones first: from the first line start
                // at or after the bytes to cut.
                let cut = item.text.len() - keep;
                let from = match cut {
                    0 => 0,
                    _ => item.text.as_bytes()[cut - 1..]
                        .iter()
                        .position(|b| *b == b'\n')
                        .map_or(item.text.len(), |at| cut + at),
                };
                item.text.drain(..from);
            } else if kind == ItemKind::Tab {
                // Whole lines from the end; the where line, the first, always stays.
                let floor = item.text.find('\n').unwrap_or(item.text.len());
                let kept = item.text.as_bytes()[..=keep]
                    .iter()
                    .rposition(|b| *b == b'\n')
                    .unwrap_or(0)
                    .max(floor);
                item.text.truncate(kept);
            } else if kind == ItemKind::Rows {
                // A cut mid-line drops the partial last line: never a broken JSON line.
                let whole = keep == item.text.len() || item.text.as_bytes()[keep] == b'\n';
                item.text.truncate(keep);
                if !whole {
                    let at = item.text.rfind('\n').unwrap_or(0);
                    item.text.truncate(at);
                }
                if !item.text.contains('\n') {
                    // Only the header is left: no row to send.
                    item.text.clear();
                }
            } else {
                item.text.truncate(keep);
            }
            trimmed += 1;
            parts = compose(ask, boundary, question, sent_turns(turns, history_on));
            exact = parts.exact();
        }
    }
    (parts, trimmed)
}

/// The Recent steps row counts the lines that go after the rails and the 200 KB cut; with
/// none left it has no row. The Cleaning rows the rails wrote under the earlier label
/// follow it.
fn recount_steps(ask: &mut Ask, cleaned: &mut [[String; 3]]) {
    let Some(at) = ask.items.iter().position(|i| i.kind == ItemKind::Steps) else {
        return;
    };
    // Switched off, the row keeps the count it was built with: nothing of it goes.
    if !ask.items[at].on && ask.items[at].locked.is_none() {
        return;
    }
    let lines = ask.items[at].text.lines().count();
    let before = ask.items[at].label.clone();
    if lines == 0 {
        ask.items.remove(at);
        return;
    }
    let label = format!("{STEPS_LABEL} · {}", grouped(lines as u64));
    for row in cleaned.iter_mut() {
        if row[0] == before {
            row[0] = label.clone();
        }
    }
    ask.items[at].label = label;
}

/// Cuts the sent SQL and Error items, longest first, until their estimates together fit
/// the query share: every item over a common level is cut down to it, so two long items
/// share what is left rather than one being emptied. Returns whether anything was cut.
fn cap_query_share(ask: &mut Ask, share: u32) -> bool {
    let sent =
        |i: &Item| matches!(i.kind, ItemKind::Sql | ItemKind::Error) && i.on && i.locked.is_none();
    let tokens: Vec<u32> = ask
        .items
        .iter()
        .filter(|i| sent(i))
        .map(|i| estimate_tokens(&i.text, false))
        .collect();
    let used_at = |level: u32| {
        tokens
            .iter()
            .map(|t| u64::from(*t.min(&level)))
            .sum::<u64>()
    };
    if used_at(u32::MAX) <= u64::from(share) {
        return false;
    }
    // The highest level whose total fits; at level 0 nothing is sent, so one exists.
    let (mut lo, mut hi) = (0u32, tokens.iter().copied().max().unwrap_or(0));
    while lo < hi {
        let mid = lo + (hi - lo).div_ceil(2);
        if used_at(mid) <= u64::from(share) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    // `estimate_tokens` is bytes x 2 / 7 rounded up, so this many bytes fit `lo` tokens.
    let bytes = lo as usize * 7 / 2;
    for item in ask.items.iter_mut().filter(|i| sent(i)) {
        if estimate_tokens(&item.text, false) > lo {
            let end = cap_chars(&item.text, bytes).len();
            item.text.truncate(end);
        }
    }
    true
}

/// After the Cards text was cut to `kept` lines, the tables past them are left out.
/// `line_tables` names the table of each line of the Cards text in rank order, so the
/// lowest-ranked tables are the ones cut.
fn drop_cut_tables(fit: &mut TableFit, line_tables: &[String], kept: usize) {
    let mut cut: Vec<String> = line_tables.iter().skip(kept).cloned().collect();
    if cut.is_empty() {
        return;
    }
    fit.full.retain(|t| !cut.contains(t));
    fit.names_only.retain(|t| !cut.contains(t));
    fit.leave_out(&cut);
    cut.append(&mut fit.left_out);
    fit.left_out = cut;
}

/// Builds exactly what the Ask would send, with no network: the gate, cleaning, cards
/// fitted to the budget of `model`'s window, framing and the 200 KB cap.
pub async fn preview(
    catalog: &dyn CatalogReader,
    settings: &AiSettings,
    model: &ModelInfo,
    secrets: &Secrets,
    req: &AskRequest,
) -> Result<Preview> {
    preview_with_log(
        catalog,
        settings,
        model,
        secrets,
        req,
        Purpose::Preview,
        None,
        &mut Log::new(),
    )
    .await
}

/// The AI access level in the words of the Connection's setting.
fn access_label(access: AiAccess) -> &'static str {
    match access {
        AiAccess::Never => "Never send anything",
        AiAccess::Schema => "Schema only",
        AiAccess::SchemaQuery => "Schema and query text",
        AiAccess::SchemaQueryRows => "Schema, query text and sample rows",
    }
}

/// `n` and its noun, plural unless `n` is 1.
pub(crate) fn count_of(n: usize, one: &str, many: &str) -> String {
    format!("{} {}", grouped(n as u64), if n == 1 { one } else { many })
}

fn step(log: &Log, step: StepKind, value: String, rule: &str) -> ProcessStep {
    ProcessStep {
        step,
        at_ms: log.elapsed_ms(),
        value,
        rule: rule.into(),
        evidence: Vec::new(),
        by_model: false,
        left_out: None,
    }
}

/// The Access row: what the stored level lets go. At Plus sample rows the rows row and
/// the rule say the Ask's Sample rows switch (Board B).
fn access_step(log: &Log, access: AiAccess, switches: Switches) -> ProcessStep {
    let kinds = [
        ("schema", "schema", ItemKind::Cards),
        ("query text", "query text", ItemKind::Sql),
        ("sample rows", "rows", ItemKind::Rows),
    ];
    let by_switch = access == AiAccess::SchemaQueryRows;
    let switch = if switches.rows { "on" } else { "off" };
    let mut open: Vec<&str> = Vec::new();
    let evidence: Vec<[String; 3]> = kinds
        .iter()
        .map(|(name, short, kind)| {
            let ok = allowed(access, *kind, switches);
            if ok {
                open.push(short);
            }
            let verdict = if ok { "allowed" } else { "blocked" };
            let why = if by_switch && *kind == ItemKind::Rows {
                format!("Sample rows switch {switch}")
            } else {
                "AI access level".into()
            };
            [name.to_string(), verdict.into(), why]
        })
        .collect();
    let value = if open.is_empty() {
        "question only".to_string()
    } else {
        open.join(", ")
    };
    let level = access_label(access);
    let rule = match (by_switch, switches.rows) {
        (true, true) => format!(
            "Read from the saved Connection: AI access is {level}, and Sample rows was on for this Ask."
        ),
        (true, false) => format!(
            "Read from the saved Connection: AI access is {level}. Sample rows was off for this Ask."
        ),
        (false, _) => format!("Read from the saved Connection: AI access is {level}."),
    };
    ProcessStep {
        evidence,
        ..step(log, StepKind::Access, value, &rule)
    }
}

/// The Tables row, from the fit after every cut. `ranked`: tier 2 picked the tables;
/// `outlined`: with the outline step's picks as seeds.
fn tables_step(log: &Log, fit: &TableFit, ranked: bool, outlined: bool) -> ProcessStep {
    let evidence = fit
        .reasons
        .iter()
        .map(|(table, rule, evidence)| [table.clone(), rule.clone(), evidence.clone()])
        .collect();
    let sent = fit.full.len() + fit.names_only.len();
    let (verb, rule) = match (ranked, outlined) {
        (true, true) => ("picked", PICKED_RULE),
        (true, false) => ("picked", RANKED_RULE),
        (false, _) => ("sent", TABLES_RULE),
    };
    let value = format!(
        "{} of {} {verb}",
        grouped(sent as u64),
        grouped(fit.reasons.len() as u64)
    );
    ProcessStep {
        evidence,
        left_out: Some(u32::try_from(fit.left_out.len()).unwrap_or(u32::MAX)),
        ..step(log, StepKind::Tables, value, rule)
    }
}

/// The Cleaning row: the counts are the input rail's `rail.input` line.
fn cleaning_step(log: &Log, cleaned: Vec<[String; 3]>) -> ProcessStep {
    let count = |key: &str| {
        log.lines
            .iter()
            .rev()
            .find(|l| l.source == "rail.input" && l.fields.first().is_some_and(|f| f.0 == "masked"))
            .and_then(|l| l.fields.iter().find(|(k, _)| k == key))
            .and_then(|(_, v)| v.parse::<usize>().ok())
            .unwrap_or(0)
    };
    let value = format!(
        "{}, {}",
        count_of(count("masked"), "value masked", "values masked"),
        count_of(count("secrets"), "secret", "secrets")
    );
    ProcessStep {
        evidence: cleaned,
        ..step(log, StepKind::Cleaning, value, CLEANING_RULE)
    }
}

const TABLES_RULE: &str = "Named in the question or editor, or the whole schema when it fits.";
const RANKED_RULE: &str = "Named in the question, open in a tab, or one key away.";
const PICKED_RULE: &str =
    "Picked from the outline, named in the question, open in a tab, or one key away.";
const CLEANING_RULE: &str =
    "Values are masked unless Include values is on. Secrets are always replaced.";
/// Board B: added to the Cleaning rule when sample rows went.
const CLEANING_ROWS: &str = " Sample rows are cleaned like every other item.";

const OUTLINE_LABEL: &str = "Outline";
const OUTLINE_RULE: &str = "The model named the areas and tables it needs from an outline of table names. Contura kept only names in this database.";
const OUTLINE_FAILED: &str =
    "The outline step failed, so the tables were ranked by name and words.";
const OUTLINE_OFF: &str =
    "The outline step was switched off in Sends, so the tables were ranked by name and words.";

/// What the outline step came to.
enum OutlineOutcome {
    /// A preview: shown in Sends, never sent.
    Shown,
    /// The Sends row was off for this Ask.
    Off,
    Failed,
    Picked(Resolved),
}

/// The outline step of one Ask or preview.
struct OutlineRun {
    item: PreviewItem,
    preview: OutlinePreview,
    /// The rails' notes on the outline; only when it goes.
    notes: Vec<String>,
    /// Once the call was made.
    sent: Option<OutlineSent>,
    areas: Vec<Area>,
    outcome: OutlineOutcome,
}

/// What the outline step reads and runs with.
struct OutlineIn<'a> {
    store: &'a dyn ContextStore,
    key: &'a ContextKey,
    req: &'a AskRequest,
    access: AiAccess,
    dialect: DialectKind,
    secrets: &'a Secrets,
    keep_exact: bool,
}

/// Tier 3: builds the outline, runs it through the input and retrieval rails with its
/// own boundary and, with a picker and the Sends row on, makes the one outline call and
/// checks its reply. A failed call or reply is the outcome `Failed`, never an error of the
/// Ask; `None` when the Context has no Areas to outline.
async fn outline_step(
    o: OutlineIn<'_>,
    r: &Retrieval,
    picker: Option<&dyn TablePicker>,
    log: &mut Log,
) -> Result<Option<OutlineRun>> {
    let areas = match areas_for(o.store, o.key) {
        Ok(areas) if !areas.is_empty() => areas,
        Ok(_) => return Ok(None),
        Err(e) => {
            log.push(Level::Warn, "outline", &[("error", error_kind(&e))]);
            return Ok(None);
        }
    };
    // The tables tier 2 ranked, in rank order: a ranked table keeps its rule.
    let ranked: Vec<String> = r
        .fit
        .reasons
        .iter()
        .filter(|(_, rule, _)| rule != NAMES_ONLY && rule != LEFT_OUT)
        .map(|(table, _, _)| table.clone())
        .collect();
    let outline = build_outline(&areas, &ranked);
    let mut items = vec![new_item(ItemKind::Question, "Question", &o.req.question)];
    items.extend(
        outline
            .lines
            .iter()
            .map(|line| new_item(ItemKind::Outline, OUTLINE_LABEL, line)),
    );
    let mut ask = Ask {
        items,
        access: o.access,
        dialect: Some(o.dialect),
        notes: Vec::new(),
        untied_model: false,
        diagram: false,
        cleaned: Vec::new(),
    };
    let input = InputRail::new(o.secrets.clone());
    let boundary = new_boundary();
    let retrieval = RetrievalRail {
        boundary: boundary.clone(),
    };
    run_rails(&[&input, &retrieval], &mut ask, log)?;
    let question = ask
        .items
        .iter()
        .find(|i| i.kind == ItemKind::Question)
        .map(|i| i.text.clone())
        .unwrap_or_default();
    let block = outline_block(&ask);
    let turn = framed_text(&ask, &boundary, &question);
    let bytes = bytes_u32(block.len() + turn.len());
    let tokens = estimate_tokens(&block, false).saturating_add(estimate_tokens(&turn, true));
    let on = !o.req.off.contains(&ItemKind::Outline);
    let item = PreviewItem {
        kind: ItemKind::Outline,
        label: format!(
            "+ 1 step: the assistant picks tables from an outline of {} tables",
            grouped(u64::from(outline.tables))
        ),
        bytes,
        tokens,
        locked: None,
        on,
    };
    let exact = format!("{block}\n\n{turn}");
    let mut run = OutlineRun {
        item,
        preview: OutlinePreview {
            tables: outline.tables,
            areas: outline.areas,
            level: outline.level,
            exact: exact.clone(),
        },
        notes: if on { ask.notes } else { Vec::new() },
        sent: None,
        areas: Vec::new(),
        outcome: OutlineOutcome::Shown,
    };
    let Some(picker) = picker else {
        return Ok(Some(run));
    };
    if !on {
        run.outcome = OutlineOutcome::Off;
        return Ok(Some(run));
    }
    log.push(
        Level::Info,
        "outline",
        &[
            ("tables", outline.tables.to_string()),
            ("areas", outline.areas.to_string()),
            ("level", outline.level.to_string()),
            ("bytes", bytes.to_string()),
            ("tokens", tokens.to_string()),
        ],
    );
    let request = OutlineRequest {
        system: outline_prompt(Some(o.dialect)),
        outline: block,
        turn,
    };
    let started = Instant::now();
    let reply = match picker.pick(&request, log).await {
        Ok(reply) => reply,
        Err(e) => {
            log.push(Level::Warn, "outline", &[("error", error_kind(&e))]);
            run.outcome = OutlineOutcome::Failed;
            return Ok(Some(run));
        }
    };
    let mut sent = reply.sent;
    sent.tables = outline.tables;
    sent.exact = o.keep_exact.then_some(exact);
    let picked = parse_reply(&reply.text).map(|raw| {
        o.store
            .context_graph(o.key)
            .map(|graph| resolve(&raw, &areas, &graph))
    });
    run.outcome = match picked {
        Some(Ok(res)) => {
            let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
            sent.picked_areas = count(res.areas.len());
            sent.picked_tables = count(res.tables.len());
            sent.dropped = count(res.dropped.len());
            log.push(
                Level::Info,
                "rail.retrieval",
                &[
                    (
                        "picks_kept",
                        (res.areas.len() + res.tables.len()).to_string(),
                    ),
                    ("dropped", res.dropped.len().to_string()),
                ],
            );
            log.push(
                Level::Info,
                "outline",
                &[
                    ("picked_areas", res.areas.len().to_string()),
                    ("picked_tables", res.tables.len().to_string()),
                    ("dropped", res.dropped.len().to_string()),
                    ("ms", started.elapsed().as_millis().to_string()),
                ],
            );
            OutlineOutcome::Picked(res)
        }
        Some(Err(e)) => {
            log.push(Level::Warn, "outline", &[("error", error_kind(&e))]);
            OutlineOutcome::Failed
        }
        None => {
            log.push(Level::Warn, "outline", &[("error", "badReply".into())]);
            OutlineOutcome::Failed
        }
    };
    run.sent = Some(sent);
    run.areas = areas;
    Ok(Some(run))
}

/// The Outline Steps row of an Ask; `None` in a preview.
fn outline_row(log: &Log, run: &OutlineRun) -> Option<ProcessStep> {
    let (value, rule, evidence) = match &run.outcome {
        OutlineOutcome::Shown => return None,
        OutlineOutcome::Off => ("switched off for this Ask".into(), OUTLINE_OFF, Vec::new()),
        OutlineOutcome::Failed => (
            "could not pick, ranked instead".into(),
            OUTLINE_FAILED,
            Vec::new(),
        ),
        OutlineOutcome::Picked(res) => {
            let mut evidence: Vec<[String; 3]> = Vec::new();
            for label in &res.areas {
                let n = run
                    .areas
                    .iter()
                    .find(|a| &a.label == label)
                    .map_or(0, |a| a.tables.len());
                evidence.push([
                    label.clone(),
                    "picked area".into(),
                    count_of(n, "table", "tables"),
                ]);
            }
            for table in &res.tables {
                evidence.push([table.clone(), "picked table".into(), "by the model".into()]);
            }
            for (name, why) in &res.dropped {
                evidence.push([name.clone(), "dropped".into(), (*why).into()]);
            }
            let value = format!(
                "picked {}, {} from {}",
                count_of(res.areas.len(), "area", "areas"),
                count_of(res.tables.len(), "table", "tables"),
                grouped(u64::from(run.preview.tables))
            );
            (value, OUTLINE_RULE, evidence)
        }
    };
    Some(ProcessStep {
        evidence,
        ..step(log, StepKind::Outline, value, rule)
    })
}

/// The outline step as gathered: its Sends row, its preview and its call once made.
#[derive(Clone, Debug)]
struct GatheredOutline {
    item: PreviewItem,
    preview: OutlinePreview,
    sent: Option<OutlineSent>,
}

/// How the read of one named table went.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReadOutcome {
    /// It gave rows; its text is in `GatheredRows::tables`.
    Read,
    /// It gave no rows: nothing to sample.
    Empty,
    /// Not one row fits `ROWS_ITEM_CAP`.
    TooWide,
    /// The read failed, or the Connection was not open.
    Failed,
}

/// The sample rows stage of one Ask or preview (11f): read once in `gather`, so an Ask
/// that assembles again after a compaction never reads again.
#[derive(Clone, Default)]
struct GatheredRows {
    /// The stage ran: AI access, the switch and the Sends row allow rows and the AI
    /// Context was read.
    ran: bool,
    /// Each named table in order, with the rule that named it and how its read went.
    named: Vec<(String, &'static str, ReadOutcome)>,
    /// The tables that gave rows, as text, in named order.
    tables: Vec<SampleTable>,
}

/// Table names and counts only: a cell value never reaches a debug print.
impl std::fmt::Debug for GatheredRows {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GatheredRows")
            .field("ran", &self.ran)
            .field("named", &self.named)
            .field(
                "tables",
                &self
                    .tables
                    .iter()
                    .map(|t| (t.table.as_str(), t.rows))
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

/// Reads up to `SAMPLE_ROWS` rows of each named table, one after another, through the
/// read-only path. A failed read skips its table with a note and a Warn line; a
/// Connection that is not open stops the reads with a note. Nothing here fails the Ask,
/// and no cell value reaches the log.
async fn read_rows(
    catalog: &dyn CatalogReader,
    config: &ConnectionConfig,
    key: &ContextKey,
    named: Vec<(String, &'static str)>,
    status: &(dyn Fn(&str) + Sync),
    notes: &mut Vec<String>,
    log: &mut Log,
) -> GatheredRows {
    let mut out = GatheredRows {
        ran: true,
        ..GatheredRows::default()
    };
    if named.is_empty() {
        notes.push(NO_NAMED_NOTE.to_string());
        return out;
    }
    status(READING_ROWS);
    let started = Instant::now();
    let mut closed = false;
    for (table, rule) in named {
        if closed {
            out.named.push((table, rule, ReadOutcome::Failed));
            continue;
        }
        let path = ObjectPath {
            database: key.database.clone(),
            schema: (!key.schema.is_empty()).then(|| key.schema.clone()),
            name: table.clone(),
        };
        // A client-side bound for every Dialect: MariaDB ignores the server hint, and the
        // connect, kind check and column reads fall outside it. A timeout is a failed read.
        let read = tokio::time::timeout(
            SAMPLE_READ_LIMIT,
            catalog.sample_rows(config.id, &path, SAMPLE_ROWS),
        )
        .await
        .unwrap_or_else(|_| {
            let secs = SAMPLE_READ_LIMIT.as_secs();
            Err(Error::TimedOut(u32::try_from(secs).unwrap_or(u32::MAX)))
        });
        let outcome = match read {
            Ok(page) if page.rows.is_empty() => ReadOutcome::Empty,
            Ok(page) => {
                let text = format_rows(&table, rule, &page);
                if text.rows == 0 {
                    ReadOutcome::TooWide
                } else {
                    out.tables.push(text);
                    ReadOutcome::Read
                }
            }
            Err(Error::NotFound(m)) if m == NOT_OPEN => {
                closed = true;
                notes.push(format!("Open {} to send sample rows.", config.name));
                ReadOutcome::Failed
            }
            Err(e) => {
                log.push(
                    Level::Warn,
                    "rows",
                    &[("table", table.clone()), ("error", error_kind(&e))],
                );
                notes.push(format!("Could not read sample rows from {table}."));
                ReadOutcome::Failed
            }
        };
        out.named.push((table, rule, outcome));
    }
    let read = rows_sent(out.tables.iter().map(|t| t.text.as_str()));
    let read = read.unwrap_or_default();
    log.push(
        Level::Info,
        "rows",
        &[
            ("tables", read.tables.to_string()),
            ("rows", read.rows.to_string()),
            ("bytes", read.bytes.to_string()),
            ("readOnly", "true".into()),
            ("ms", started.elapsed().as_millis().to_string()),
        ],
    );
    out
}

/// The rows of a table's text: its lines after the header.
fn text_rows(text: &str) -> u32 {
    u32::try_from(text.lines().count().saturating_sub(1)).unwrap_or(u32::MAX)
}

/// What the rows texts hold, counted; `None` with no text.
fn rows_sent<'a>(texts: impl Iterator<Item = &'a str>) -> Option<RowsSent> {
    let mut sent = RowsSent::default();
    for text in texts.filter(|t| !t.is_empty()) {
        sent.tables += 1;
        sent.rows = sent.rows.saturating_add(text_rows(text));
        sent.bytes = sent.bytes.saturating_add(bytes_u32(text.len()));
    }
    (sent.tables > 0).then_some(sent)
}

/// R5.4: the retrieval rail scans the rows items before the budget fits them, so its
/// note can name a table whose rows were then left out; only tables whose rows go keep it.
fn drop_unsent_rows_notes(ask: &mut Ask) {
    let sent: Vec<String> = ask
        .items
        .iter()
        .filter(|i| i.kind == ItemKind::Rows && goes(i) && !i.text.is_empty())
        .map(|i| {
            format!(
                "{}{}: ",
                ROWS_NOTE_LEAD,
                i.text.split('(').next().unwrap_or("").trim()
            )
        })
        .collect();
    ask.notes
        .retain(|n| !n.starts_with(ROWS_NOTE_LEAD) || sent.iter().any(|s| n.starts_with(s)));
}

/// Whether an item is one that goes.
fn goes(i: &Item) -> bool {
    i.on && i.locked.is_none()
}

/// Fits the cleaned rows items into the rows share (re-measured after cleaning): the
/// last rows of a table go first, then whole tables; what stays is put back in place of
/// the items, relabelled with the tables left. Returns the tables kept, in order.
fn fit_sample_rows(ask: &mut Ask, g: &Gathered, log: &mut Log) -> Vec<String> {
    // Pair the items with their tables before dropping emptied ones: the input rail can
    // empty one in the middle, and pairing after would shift every later table's name.
    let all: Vec<usize> = (0..ask.items.len())
        .filter(|&i| ask.items[i].kind == ItemKind::Rows && goes(&ask.items[i]))
        .collect();
    let paired: Vec<(usize, &SampleTable)> = all
        .iter()
        .copied()
        .zip(&g.rows.tables)
        .filter(|&(i, _)| !ask.items[i].text.is_empty())
        .collect();
    if paired.is_empty() {
        return Vec::new();
    }
    // Every rows item that goes is replaced below, the emptied ones too.
    let at = all;
    let mut tables: Vec<SampleTable> = paired
        .iter()
        .map(|&(i, t)| SampleTable {
            text: ask.items[i].text.clone(),
            rows: text_rows(&ask.items[i].text),
            ..t.clone()
        })
        .collect();
    let fit = fit_rows(&mut tables, g.shares.rows);
    if !fit.cut.is_empty() || !fit.left_out.is_empty() {
        log.push(
            Level::Info,
            "rail.budget",
            &[
                ("trimmed", "rows".into()),
                ("cut", fit.cut.len().to_string()),
                ("leftOut", fit.left_out.len().to_string()),
            ],
        );
    }
    let first = at[0];
    let template = ask.items[first].clone();
    for &i in at.iter().rev() {
        ask.items.remove(i);
    }
    if tables.is_empty() {
        let empty = Item {
            label: ROWS_LABEL.into(),
            text: String::new(),
            ..template
        };
        ask.items.insert(first, empty);
        return Vec::new();
    }
    let label = rows_label(tables.len());
    let kept: Vec<String> = tables.iter().map(|t| t.table.clone()).collect();
    for (n, t) in tables.into_iter().enumerate() {
        let item = Item {
            label: label.clone(),
            text: t.text,
            ..template.clone()
        };
        ask.items.insert(first + n, item);
    }
    kept
}

/// The Rows Steps row, from what goes after every cut: one evidence row per named table.
fn rows_step(log: &Log, rows: &GatheredRows, kept: &[String], items: &[Item]) -> ProcessStep {
    let texts: Vec<&str> = if kept.is_empty() {
        Vec::new()
    } else {
        items
            .iter()
            .filter(|i| i.kind == ItemKind::Rows)
            .map(|i| i.text.as_str())
            .collect()
    };
    let sent_text = |table: &str| {
        kept.iter()
            .position(|t| t == table)
            .and_then(|n| texts.get(n))
            .filter(|t| !t.is_empty())
    };
    let evidence = rows
        .named
        .iter()
        .map(|(table, rule, outcome)| {
            let said = match outcome {
                ReadOutcome::Read => match sent_text(table) {
                    Some(text) => format!(
                        "{}, {} B",
                        count_of(text_rows(text) as usize, "row", "rows"),
                        grouped(text.len() as u64)
                    ),
                    None => LEFT_OUT.into(),
                },
                ReadOutcome::Empty => "no rows".into(),
                ReadOutcome::TooWide => LEFT_OUT.into(),
                ReadOutcome::Failed => "could not read".into(),
            };
            [table.clone(), (*rule).to_string(), said]
        })
        .collect();
    let sent = rows_sent(texts.iter().copied()).unwrap_or_default();
    let value = format!(
        "{} from {}",
        count_of(sent.rows as usize, "row", "rows"),
        count_of(sent.tables as usize, "table", "tables")
    );
    ProcessStep {
        evidence,
        ..step(log, StepKind::Rows, value, ROWS_RULE)
    }
}

/// Everything an Ask's text is built from before the thread and the framing: the stored
/// Connection's access (R1.2), the AI Context's cards, the saved queries and the outline
/// step. `assemble` builds the text from it as often as it is asked, with no database or
/// network call.
#[derive(Clone, Debug)]
pub struct Gathered {
    pub req: AskRequest,
    /// Where this Ask's lines start in the log.
    first_line: usize,
    config: Option<ConnectionConfig>,
    /// Read from the stored Connection, never from the request; `Never` without one. With
    /// `focus.also`, the lowest access among the Ask's Connection and those.
    pub access: AiAccess,
    /// The Connection the lock reasons name: the one that set `access`.
    lock_name: String,
    /// The This tab item at `access`; `None` without a tab or when none may go.
    tab: Option<TabText>,
    /// The Recent steps item, each step gated by its own Connection and `access`; `None`
    /// without steps, with the row off, or when none may go.
    pub(crate) trail: Option<StepsOut>,
    untied_model: bool,
    /// The secrets long enough to match exactly.
    secrets: Secrets,
    pub shares: Budget,
    model_name: String,
    window: u32,
    notes: Vec<String>,
    /// Access, Schema and Outline, as they ran.
    steps: Vec<ProcessStep>,
    fit: TableFit,
    cards: String,
    /// The table of each Cards line, in rank order, for the 200 KB cut.
    line_tables: Vec<String>,
    saved: SavedItems,
    context: Option<ContextInfo>,
    /// Once tables were picked: whether tier 2 ranked them.
    picked: Option<bool>,
    outline: Option<GatheredOutline>,
    /// Whether the outline step's picks were used.
    outlined: bool,
    /// The tables the Ask sends in full, else its focus table names: the Topic rules read
    /// them and the stamp carries them.
    pub tables: Vec<String>,
    /// The sample rows read for this Ask (11f).
    rows: GatheredRows,
}

impl Gathered {
    /// The secrets long enough to match exactly: the summary calls clean with them too.
    pub(crate) fn secrets(&self) -> &Secrets {
        &self.secrets
    }

    /// What Contura read from the database for this Ask, counted: the tables that gave
    /// rows; `None` when no row was read.
    pub(crate) fn rows_read(&self) -> Option<RowsSent> {
        rows_sent(self.rows.tables.iter().map(|t| t.text.as_str()))
    }
}

/// As `preview`, writing into the Ask's `log` and filling the Steps rows it ran.
/// `purpose` says whether the AI Context may be checked: an Ask may, the preview never.
/// The preview and the Ask both run `gather`, the memory stage and `assemble`, so the
/// preview shows exactly what the Ask sends, thread included (R1.6).
#[allow(clippy::too_many_arguments)]
pub async fn preview_with_log(
    catalog: &dyn CatalogReader,
    settings: &AiSettings,
    model: &ModelInfo,
    secrets: &Secrets,
    req: &AskRequest,
    purpose: Purpose,
    picker: Option<&dyn TablePicker>,
    log: &mut Log,
) -> Result<Preview> {
    precheck_continue(catalog, req)?;
    let picker = picker.filter(|_| req.action != "continue");
    let gathered = gather(
        catalog,
        settings,
        model,
        secrets,
        req,
        purpose,
        picker,
        &|_: &str| {},
        log,
    )
    .await?;
    let recall = recall(catalog, &gathered, log, None).await;
    check_continue(req, &recall)?;
    let mut preview = assemble(&gathered, &recall.pick, recall.memory.clone(), log)?;
    stamp_continued(req, &recall, &mut preview.stamp);
    // The summary step the Ask would make, under the same rules; no call is made here.
    preview.summary =
        crate::ai::compact::summary_preview(catalog, settings, model, &gathered, &recall, &preview)
            .await;
    if !recall.thread {
        preview.memory = None;
    }
    Ok(preview)
}

/// Access, the AI Context, the tables, 11d's outline step and 11f's sample rows:
/// everything the preview does before the thread and the framing. `status` tells the Ask
/// what it is doing (a no-op for the preview).
#[allow(clippy::too_many_arguments)]
pub async fn gather(
    catalog: &dyn CatalogReader,
    settings: &AiSettings,
    model: &ModelInfo,
    secrets: &Secrets,
    req: &AskRequest,
    purpose: Purpose,
    picker: Option<&dyn TablePicker>,
    status: &(dyn Fn(&str) + Sync),
    log: &mut Log,
) -> Result<Gathered> {
    let first_line = log.lines.len();
    let mut notes = Vec::new();
    let mut steps = Vec::new();
    log.push(
        Level::Info,
        "question",
        &[
            ("chars", req.question.chars().count().to_string()),
            ("action", req.action.clone()),
        ],
    );

    let config = match req.connection_id {
        Some(id) => catalog.connection_config(id).await?,
        None => None,
    };
    // A Connection whose Group sends to another AI provider reads as Never (ADR 0027):
    // Sends names each one once.
    let mut held_by_provider: Vec<String> = Vec::new();
    let mut hold = |c: &ConnectionConfig| {
        if catalog.other_provider(c.id) && !held_by_provider.contains(&c.name) {
            held_by_provider.push(c.name.clone());
        }
    };
    if let Some(c) = &config {
        hold(c);
    }
    // R1.3: no Connection, or one that is gone, sends the question only.
    let own = config.as_ref().map_or(AiAccess::Never, |c| c.ai_access);
    // A tab over two Connections is gated at the lower access; a missing one is Never.
    let (mut access, mut lock_name) = (
        own,
        config.as_ref().map_or("", |c| c.name.as_str()).to_string(),
    );
    // The stamp keeps every Connection the Ask was gated by, so more than it can hold
    // is refused, as any other input out of bounds.
    let mut also: Vec<ConnectionId> = Vec::new();
    for id in &req.focus.also {
        if !also.contains(id) {
            also.push(*id);
        }
    }
    if also.len() > ASKED_IN_ALSO {
        return Err(Error::InvalidInput(format!(
            "A tab spans at most {ASKED_IN_ALSO} other Connections."
        )));
    }
    for id in &also {
        let other = catalog.connection_config(*id).await?;
        if let Some(c) = &other {
            hold(c);
        }
        let level = other.as_ref().map_or(AiAccess::Never, |c| c.ai_access);
        if rank(level) < rank(access) {
            access = level;
            lock_name = other.map_or_else(|| MISSING_ALSO.to_string(), |c| c.name);
        }
    }
    let connection = match (&config, req.connection_id) {
        (Some(_), _) => "found",
        (None, Some(_)) => "missing",
        (None, None) => "none",
    };
    let dialect = config.as_ref().map(|c| c.dialect);
    // R1.4: only with no Connection at all; a tied model whose Connection is gone or shares
    // nothing still sends the question only.
    let untied_model = req.connection_id.is_none() && req.focus.untied_model;
    let mut fields = vec![
        ("connection", connection.into()),
        ("level", access_id(own).into()),
        (
            "dialect",
            dialect.map_or_else(String::new, |d| format!("{d:?}").to_lowercase()),
        ),
    ];
    if !req.focus.also.is_empty() {
        fields.push(("also", req.focus.also.len().to_string()));
        fields.push(("lowest", access_id(access).into()));
    }
    log.push(Level::Info, "access", &fields);
    steps.push(access_step(log, access, req.switches));

    let exact_secrets = long_secrets(secrets);
    let clean = cleaner(&exact_secrets);
    // This tab: with no Connection chosen it renders as such; a chosen one that is gone
    // is Never. The tables it shows are hints for the cards, as open tabs are.
    // Switched off, the tab is still rendered for its row, but none of it goes and its
    // tables are no hints.
    let tab_off = req.off.contains(&ItemKind::Tab);
    let tab_access = req.connection_id.map(|_| access);
    let render = |outline: &[String]| {
        req.tab.as_ref().and_then(|t| {
            tab_text(
                t,
                tab_access,
                req.database.as_deref(),
                req.schema.as_deref(),
                dialect,
                outline,
                &clean,
            )
        })
    };
    let mut tab = render(&[]);

    // Recent steps: each step's Connection is read once. A step on another Connection
    // goes at its own access; one on the Ask's Connection at the Ask's lowest access.
    let mut trail = None;
    let mut step_tables: Vec<TableRef> = Vec::new();
    // Switched off, the steps are still rendered for the row's count, but none of them go:
    // no text, no notes and no table hints.
    let steps_off = req.off.contains(&ItemKind::Steps);
    if !req.steps.is_empty() {
        let now = now_ms();
        let mut levels: Vec<(ConnectionId, Option<AiAccess>)> = Vec::new();
        for id in step_connections(&req.steps, now) {
            let level = if Some(id) == req.connection_id {
                config.as_ref().map(|c| c.ai_access)
            } else {
                let other = catalog.connection_config(id).await?;
                if let Some(c) = &other {
                    hold(c);
                }
                other.map(|c| c.ai_access)
            };
            levels.push((id, level));
        }
        // A step on a Connection of another provider is left out whole: Sends names the
        // Connection instead of counting it as held. A source there reads as Never, so
        // the label says `a database`.
        let kept_steps: Vec<StepIn>;
        let steps: &[StepIn] = if req
            .steps
            .iter()
            .any(|s| s.connection_id.is_some_and(|c| catalog.other_provider(c)))
        {
            kept_steps = req
                .steps
                .iter()
                .filter(|s| !s.connection_id.is_some_and(|c| catalog.other_provider(c)))
                .cloned()
                .collect();
            &kept_steps
        } else {
            &req.steps
        };
        let access_of = |id: ConnectionId| {
            levels
                .iter()
                .find(|(c, _)| *c == id)
                .and_then(|(_, level)| *level)
        };
        let out = render_steps(
            steps,
            now,
            (req.connection_id, req.database.as_deref()),
            &access_of,
            access,
            &clean,
        );
        if !steps_off {
            notes.extend(steps_notes(&out));
        }
        // Switched off, the log says so: nothing of it is sent.
        if steps_off {
            log.push(
                Level::Info,
                "steps",
                &[("n", "0".to_string()), ("off", "true".to_string())],
            );
        } else {
            log.push(
                Level::Info,
                "steps",
                &[
                    ("n", out.lines().to_string()),
                    ("dropped", (out.held + out.held_by_ask).to_string()),
                    ("left_out", out.left_out.to_string()),
                ],
            );
        }
        if !steps_off {
            step_tables = out.tables.clone();
        }
        trail = Some(out).filter(|o| !o.text.is_empty());
    }
    notes.splice(
        0..0,
        held_by_provider.iter().map(|n| other_provider_note(n)),
    );
    let with_tab;
    let req = match &tab {
        Some(t) if !tab_off && t.tables.iter().any(|r| !req.focus.tables.contains(r)) => {
            let mut wider = req.clone();
            for r in &t.tables {
                if !wider.focus.tables.contains(r) {
                    wider.focus.tables.push(r.clone());
                }
            }
            with_tab = wider;
            &with_tab
        }
        _ => req,
    };

    // The answer's room as the Ask sends it: a thinking budget raises it (TooBig counts it).
    let max_tokens = settings.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS);
    let picks = clamp(model, req.picks.unwrap_or(model.picks));
    let thinking = wire_thinking(model, picks.thinking, settings.share_thinking);
    let room = settings.provider.map_or(max_tokens, |kind| {
        max_tokens_on_wire(kind, max_tokens, &thinking)
    });
    let shares = budget(model.context_window, room);
    let mut fit = TableFit::default();
    let mut cards = String::new();
    // The table of each Cards line, in rank order, for the 200 KB cut.
    let mut line_tables: Vec<String> = Vec::new();
    let mut saved = SavedItems {
        texts: Vec::new(),
        locked: false,
    };
    let mut context = None;
    // Once tables were picked: whether tier 2 ranked them.
    let mut picked: Option<bool> = None;
    // The outline step, when tier 3 triggered; `outlined` once its picks were used.
    let mut outline: Option<OutlineRun> = None;
    let mut outlined = false;
    // The tables an Ask may carry rows for, once the Context was read.
    let mut named: Option<(ContextKey, Vec<(String, &'static str)>)> = None;
    if let Some(config) = &config
        && !req.off.contains(&ItemKind::Cards)
        && allowed(access, ItemKind::Cards, req.switches)
    {
        let key = context_key(
            config,
            req.database.as_deref(),
            req.schema.as_deref(),
            &req.focus.tables,
        );
        let (info, schema_step) =
            ensure(catalog, config, &key, purpose, &clean, now_ms(), log).await;
        if info.built_at.is_none() {
            notes.push(schema_step.rule.clone());
        }
        steps.push(schema_step);
        if info.built_at.is_some() {
            // The editor text the gate lets through names tables; it is only read here.
            let texts: Vec<&str> = if allowed(access, ItemKind::Sql, req.switches)
                && !req.off.contains(&ItemKind::Sql)
            {
                [&req.focus.sql, &req.focus.selection, &req.focus.filter]
                    .into_iter()
                    .flatten()
                    .map(String::as_str)
                    .collect()
            } else {
                Vec::new()
            };
            let seeds = Seeds {
                dialect: config.dialect,
                open_tables: &req.focus.tables,
                step_tables: &step_tables,
                texts,
                question: &req.question,
                picked: &[],
            };
            let with_saved = allowed(access, ItemKind::SavedQueries, req.switches);
            // Enum values are values: they go only at Schema, query text and sample rows.
            let with_rows = access == AiAccess::SchemaQueryRows;
            let store = catalog.context();
            match retrieve(store, &key, &seeds, shares.schema, with_rows, with_saved) {
                Ok(mut r) => {
                    if should_outline(
                        info.table_count,
                        &r,
                        model.context_window,
                        settings.pick_tables,
                    ) {
                        let o = OutlineIn {
                            store,
                            key: &key,
                            req,
                            access,
                            dialect: config.dialect,
                            secrets: &exact_secrets,
                            keep_exact: settings.keep_exact_text,
                        };
                        if let Some(mut run) = outline_step(o, &r, picker, log).await? {
                            // Tier 2 again, with the picks as seeds.
                            if let OutlineOutcome::Picked(res) = &run.outcome {
                                let again = Seeds {
                                    picked: &res.seeds,
                                    ..seeds
                                };
                                match retrieve(
                                    store,
                                    &key,
                                    &again,
                                    shares.schema,
                                    with_rows,
                                    with_saved,
                                ) {
                                    Ok(with_picks) => {
                                        r = with_picks;
                                        outlined = true;
                                    }
                                    Err(e) => {
                                        log.push(
                                            Level::Warn,
                                            "outline",
                                            &[("error", error_kind(&e))],
                                        );
                                        run.outcome = OutlineOutcome::Failed;
                                    }
                                }
                            }
                            if matches!(run.outcome, OutlineOutcome::Failed) {
                                notes.push(OUTLINE_FAILED.to_string());
                            }
                            notes.extend(std::mem::take(&mut run.notes));
                            if let Some(row) = outline_row(log, &run) {
                                steps.push(row);
                            }
                            outline = Some(run);
                        }
                    }
                    picked = Some(r.ranked);
                    named = Some((key.clone(), std::mem::take(&mut r.named_tables)));
                    cards = r
                        .lines
                        .iter()
                        .map(|(_, line)| line.as_str())
                        .collect::<Vec<_>>()
                        .join("\n");
                    line_tables = r.lines.into_iter().map(|(t, _)| t).collect();
                    fit = r.fit;
                    saved.texts = r
                        .saved
                        .iter()
                        .map(|q| format!("{}: {}", q.name, q.sql))
                        .collect();
                    saved.locked =
                        !with_saved && store.context_saved(&key).is_ok_and(|q| !q.is_empty());
                }
                Err(e) => {
                    log.push(Level::Warn, "schema", &[("error", error_kind(&e))]);
                    notes.push(UNREADABLE_NOTE.to_string());
                }
            }
        }
        context = Some(info);
    }

    // 11f: rows only at the rows level, with the switch on and the Sends row on (R1.2:
    // the level read from the stored Connection above), for the tables named.
    let mut rows = GatheredRows::default();
    if let (Some(config), Some((key, named))) = (&config, named)
        && allowed(access, ItemKind::Rows, req.switches)
        && !req.off.contains(&ItemKind::Rows)
    {
        rows = read_rows(catalog, config, &key, named, status, &mut notes, log).await;
    }

    // A design tab's outline: the table names of the stored AI Context, never the catalog.
    if let (Some(AskTab::Design { .. }), Some(config), Some(_), false) =
        (&req.tab, &config, &tab, tab_off)
    {
        let key = context_key(
            config,
            req.database.as_deref(),
            req.schema.as_deref(),
            &req.focus.tables,
        );
        let outline: Vec<String> = catalog
            .context()
            .context_graph(&key)
            .map(|rows| rows.into_iter().map(|r| r.table).collect())
            .unwrap_or_default();
        if !outline.is_empty() {
            tab = render(&outline);
        }
    }
    if let Some(t) = &tab {
        // Switched off, nothing of it is sent.
        let mut fields = vec![
            ("kind", tab_kind(req.tab.as_ref())),
            ("bytes", if tab_off { 0 } else { t.text.len() }.to_string()),
        ];
        if tab_off {
            fields.push(("off", "true".to_string()));
        }
        log.push(Level::Info, "tab", &fields);
    }

    let tables = if fit.full.is_empty() {
        let mut named: Vec<String> = req.focus.tables.iter().map(|t| t.name.clone()).collect();
        for t in &step_tables {
            if !named.contains(&t.name) {
                named.push(t.name.clone());
            }
        }
        named
    } else {
        fit.full.clone()
    };
    Ok(Gathered {
        req: req.clone(),
        first_line,
        config,
        access,
        lock_name,
        tab,
        trail,
        untied_model,
        secrets: exact_secrets.clone(),
        shares,
        model_name: model.name.clone(),
        window: model.context_window,
        notes,
        steps,
        fit,
        cards,
        line_tables,
        saved,
        context,
        picked,
        outline: outline.map(|run| GatheredOutline {
            item: run.item,
            preview: run.preview,
            sent: run.sent,
        }),
        outlined,
        tables,
        rows,
    })
}

/// The current access of each other Connection the questions of `thread` were asked
/// across (`AskedIn::also`), each read once; one that is gone or cannot be read is Never.
/// The gate on history lowers such a message to it (`message_access`).
pub(crate) async fn others_access(
    catalog: &dyn CatalogReader,
    thread: &AiThread,
    log: &mut Log,
) -> Vec<(ConnectionId, AiAccess)> {
    let mut out = Vec::new();
    for id in also_of(thread) {
        let level = match catalog.connection_config(id).await {
            Ok(c) => c.map_or(AiAccess::Never, |c| c.ai_access),
            Err(e) => {
                log.push(Level::Warn, "memory", &[("error", error_kind(&e))]);
                AiAccess::Never
            }
        };
        out.push((id, level));
    }
    out
}

/// What the memory stage found for one Ask.
#[derive(Clone, Debug)]
pub struct Recall {
    pub pick: HistoryPick,
    /// The Topic and the pick's counts; `assemble` sets what goes after the cut.
    pub memory: MemoryInfo,
    /// Whether the Ask had a thread of its own place to read.
    pub thread: bool,
    /// That thread as stored, for the 85% check and the summary step.
    pub source: Option<AiThread>,
    /// The current access of the other Connections the thread's questions were asked
    /// across, once read (`others_access`); an Ask reads them once and passes them on.
    pub others: Option<Vec<(ConnectionId, AiAccess)>>,
    /// The Topic pick: the Topic this Ask closes, when it opens a new one.
    pub topic: TopicPick,
}

/// The memory stage: the Topic this Ask belongs to and the history it may send. No
/// `thread_id`, a thread that is not stored, or one of another place gives no history and
/// Topic 1, `First`. The open Topic's turns and matching summaries pass the gate on history with
/// the access read from the stored Connection (R1.2, R1.7), cleaned by the input rail's
/// cleaner (R2.1, R2.2); no masking, since the gate already holds values back. A store
/// that cannot be read sends no history. `known` is the `others` an earlier recall of the
/// same Ask read, so they are read once per Ask.
pub async fn recall(
    catalog: &dyn CatalogReader,
    g: &Gathered,
    log: &mut Log,
    known: Option<Vec<(ConnectionId, AiAccess)>>,
) -> Recall {
    let req = &g.req;
    let store = catalog.threads();
    let warn = |log: &mut Log, e: &crate::error::Error| {
        log.push(Level::Warn, "memory", &[("error", error_kind(e))]);
    };
    let thread = match req.thread_id.map(|id| store.thread(id)) {
        Some(Ok(Some(t))) if t.place == req.place => Some(t),
        Some(Err(e)) => {
            warn(log, &e);
            None
        }
        _ => None,
    };
    let facts = AskFacts {
        connection_id: req.connection_id,
        database: req.database.as_deref(),
        action: &req.action,
        tables: &g.tables,
        now_ms: now_ms(),
    };
    let topic = topic_for(thread.as_ref(), &facts, &req.question);
    let picked = topic.clone();
    let mut pick = HistoryPick::default();
    let mut others = known;
    // At Never (and on Home, which has no Connection) the gate still runs: a turn that sent
    // only the conversation goes, one that sent anything about a database stays held.
    if let Some(t) = thread.as_ref() {
        if others.is_none() {
            others = Some(others_access(catalog, t, log).await);
        }
        let others = others.as_deref().unwrap_or_default();
        let read = (|| {
            let topics = store.topics(t.id)?;
            let compactions = store.compactions(t.id)?;
            let matches = store.match_topics(t.id, &question_terms(&req.question), 4)?;
            Ok::<_, crate::error::Error>((topics, compactions, matches))
        })();
        match read {
            Ok((mut topics, compactions, matches)) => {
                // The Topic this Ask closes goes as a closed one (R1.6: the preview too).
                if let Some(seq) = topic.closing {
                    closing_topic(&mut topics, t, &compactions, seq);
                }
                let clean = cleaner(&g.secrets);
                pick = select_history(
                    Some(t),
                    &topics,
                    &compactions,
                    &topic,
                    &facts,
                    g.access,
                    others,
                    req.switches,
                    &matches,
                    g.shares.history,
                    &clean,
                );
            }
            Err(e) => warn(log, &e),
        }
    }
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    let memory = MemoryInfo {
        topic: topic.seq,
        opened: topic.opened,
        reason: topic.reason,
        title: topic.title,
        turns: count(pick.turns.len()),
        summaries: count(pick.summaries.len()),
        blocked: pick.blocked,
        tokens: pick.tokens,
    };
    Recall {
        pick,
        memory,
        thread: thread.is_some(),
        source: thread,
        others,
        topic: picked,
    }
}

fn nothing_to_continue() -> crate::error::Error {
    crate::error::Error::Ai(crate::ai::AiError::NothingToContinue)
}

/// The cheap half of the Continue rule, run before anything is gathered or sent: the thread
/// is stored, belongs to the place, and ends with a question and its answer (a Notice after
/// them does not count). Other actions pass.
pub fn precheck_continue(catalog: &dyn CatalogReader, req: &AskRequest) -> Result<()> {
    if req.action != "continue" {
        return Ok(());
    }
    let thread = match req.thread_id.map(|id| catalog.threads().thread(id)) {
        Some(Ok(Some(t))) if t.place == req.place => t,
        _ => return Err(nothing_to_continue()),
    };
    let mut shown = thread.messages.iter().filter(|m| m.role != AiRole::Notice);
    let (answer, question) = (shown.next_back(), shown.next_back());
    match (question, answer) {
        (Some(q), Some(a))
            if q.role == AiRole::User
                && a.role == AiRole::Assistant
                && !a.text.trim().is_empty() =>
        {
            Ok(())
        }
        _ => Err(nothing_to_continue()),
    }
}

/// The Continue rule on the history pick (the one the Ask sends): it must end with the
/// thread's last question and answer, the cut answer's turn. A Topic broken by Place or
/// Idle, a gate that blocked it, a share that dropped it or the Thread row switched off
/// leaves nothing to continue. Shared by the preview and the Ask, so both give the same
/// error.
pub fn check_continue(req: &AskRequest, recall: &Recall) -> Result<()> {
    if req.action != "continue" {
        return Ok(());
    }
    if req.off.contains(&ItemKind::History) {
        return Err(nothing_to_continue());
    }
    let (Some(last), Some(thread)) = (recall.pick.turns.last(), recall.source.as_ref()) else {
        return Err(nothing_to_continue());
    };
    let mut shown = thread.messages.iter().filter(|m| m.role != AiRole::Notice);
    let (answer, question) = (shown.next_back(), shown.next_back());
    match (question, answer) {
        (Some(q), Some(a))
            if q.role == AiRole::User && a.role == AiRole::Assistant && q.at == last.at =>
        {
            Ok(())
        }
        _ => Err(nothing_to_continue()),
    }
}

/// A Continue extends the continued answer, so its stamp takes the continued question's
/// other Connections (`AskedIn::also`) beside its own: the extended answer is then held
/// at replay whenever the first one is (Task 3 ruling N4). Other actions are unchanged.
pub fn stamp_continued(req: &AskRequest, recall: &Recall, stamp: &mut TurnStamp) {
    if req.action != "continue" {
        return;
    }
    // The extended answer carries what the continued turn carried (I1), whether or not
    // its history row made it through the cut.
    if let Some(t) = recall.source.as_ref() {
        let mut shown = t.messages.iter().filter(|m| m.role != AiRole::Notice);
        for m in [shown.next_back(), shown.next_back()].into_iter().flatten() {
            for k in &m.kinds {
                if *k != ItemKind::History && !stamp.kinds.contains(k) {
                    stamp.kinds.push(*k);
                }
            }
        }
    }
    let continued = recall.source.as_ref().and_then(|t| {
        t.messages
            .iter()
            .rev()
            .find(|m| m.role == AiRole::User)
            .and_then(|m| m.asked_in.as_ref())
    });
    let Some(also) = continued.map(|a| &a.also).filter(|a| !a.is_empty()) else {
        return;
    };
    let asked = stamp.asked_in.get_or_insert_with(AskedIn::default);
    // The continued question's first, so the cap never drops the reason for this one.
    let mut all = also.clone();
    all.extend(asked.also.iter().copied());
    asked.also = all;
    *asked = asked.capped();
}

/// The Thread row's label: `Thread · 2 turns, 1 summary`.
fn thread_label(turns: usize, summaries: usize) -> String {
    match (turns, summaries) {
        (t, 0) => format!("Thread · {}", count_of(t, "turn", "turns")),
        (0, s) => format!("Thread · {}", count_of(s, "summary", "summaries")),
        (t, s) => format!(
            "Thread · {}, {}",
            count_of(t, "turn", "turns"),
            count_of(s, "summary", "summaries")
        ),
    }
}

/// A summary as it is framed: `<label>: <summary>`.
fn summary_text(s: &HistorySummary) -> String {
    let label = match &s.source {
        SummarySource::Topic {
            title, first_at, ..
        } => format!("Earlier topic \"{title}\" ({first_at})"),
        SummarySource::Compaction { messages, .. } => format!(
            "Earlier in this topic, {}",
            count_of(*messages as usize, "message", "messages")
        ),
    };
    format!("{label}: {}", s.text)
}

fn yes_no(b: bool) -> String {
    if b { "yes" } else { "no" }.into()
}

fn break_id(memory: &MemoryInfo) -> String {
    match memory.reason {
        None => "none".into(),
        Some(r) => serde_json::to_value(r)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default(),
    }
}

/// The Asked in stamp, built from the This tab and Recent steps items as they went (after
/// `off`, the gate, the rails and the 200 KB cut), and the highest level the parts that
/// went used. The label is the where line that went, else the tab's kind words; the
/// summary keeps only facts whose lines went; the steps are the Ask's own that went, and
/// the other steps those on other Connections that went (each gated by its own Connection
/// at replay, so they do not raise the level). `None` with no tab, no step kept and no
/// other Connection.
fn asked_in(req: &AskRequest, g: &Gathered, items: &[Item]) -> (Option<AskedIn>, u8) {
    let sent = |kind: ItemKind| {
        items
            .iter()
            .find(|i| i.kind == kind && goes(i) && !i.text.is_empty())
            .map(|i| i.text.as_str())
    };
    let clean = cleaner(&g.secrets);
    let mut used = 0;
    let (label, summary) = match (req.tab.as_ref(), g.tab.as_ref(), sent(ItemKind::Tab)) {
        (_, Some(t), Some(text)) => {
            used = t.used;
            let label = text.lines().next().unwrap_or_default().to_string();
            (label, t.sent_summary(text, &clean))
        }
        (Some(tab), _, _) => (kind_words(tab).to_string(), String::new()),
        (None, _, _) => (String::new(), String::new()),
    };
    let (steps, other_steps) = match (g.trail.as_ref(), sent(ItemKind::Steps)) {
        (Some(trail), Some(text)) => {
            // The answer may lean on the steps that went, kept or not.
            used = used.max(trail.used);
            (trail.kept_for_turn(text), trail.others_for_turn(text))
        }
        _ => (Vec::new(), Vec::new()),
    };
    if req.tab.is_none() && steps.is_empty() && other_steps.is_empty() && req.focus.also.is_empty()
    {
        return (None, used);
    }
    let stamp = AskedIn {
        tab: req.tab.as_ref().map_or("", kind_id).to_string(),
        label,
        summary,
        steps,
        also: req.focus.also.clone(),
        other_steps,
        // The webview adds the key of its tab when it saves the turn.
        tab_key: None,
    };
    (Some(stamp.capped()), used)
}

/// The kinds of the items that go, each once.
fn sent_kinds(items: &[PreviewItem]) -> Vec<ItemKind> {
    let mut kinds: Vec<ItemKind> = Vec::new();
    for i in items.iter().filter(|i| i.on && i.locked.is_none()) {
        // An empty Sample rows item carried nothing: the turn is not a rows turn.
        if i.kind == ItemKind::Rows && i.bytes == 0 {
            continue;
        }
        if !kinds.contains(&i.kind) {
            kinds.push(i.kind);
        }
    }
    kinds
}

/// Frames what was gathered with `history`: the gate on items, the rails, the query share,
/// the 200 KB cut (the thread before the cards) and "Show exactly". `memory` comes back
/// with what goes of the thread after the cut. It reads no database and calls no provider.
pub fn assemble(
    g: &Gathered,
    history: &HistoryPick,
    memory: MemoryInfo,
    log: &mut Log,
) -> Result<Preview> {
    assemble_with(g, history, memory, log, true)
}

/// The one `memory` log line: what the thread gives the Ask, counts only.
pub(crate) fn memory_line(log: &mut Log, memory: &MemoryInfo) {
    log.push(
        Level::Info,
        "memory",
        &[
            ("topic", memory.topic.to_string()),
            ("opened", yes_no(memory.opened)),
            ("break", break_id(memory)),
            ("turns", memory.turns.to_string()),
            ("summaries", memory.summaries.to_string()),
            ("blocked", memory.blocked.to_string()),
            ("tokens", memory.tokens.to_string()),
        ],
    );
}

/// As `assemble`; without `log_memory` the `memory` line is left for the caller, so an
/// Ask that assembles again after a compaction logs it once.
pub(crate) fn assemble_with(
    g: &Gathered,
    history: &HistoryPick,
    mut memory: MemoryInfo,
    log: &mut Log,
    log_memory: bool,
) -> Result<Preview> {
    let req = &g.req;
    let mut notes = g.notes.clone();
    let mut steps = g.steps.clone();
    let mut fit = g.fit.clone();
    let history_on = !req.off.contains(&ItemKind::History);
    let mut turns: Vec<Turn> = history.turns.clone();

    let name = g.lock_name.as_str();
    let cards_label =
        (g.config.is_some() || !req.focus.tables.is_empty()).then(|| tables_label(req));
    let mut items = build_items(
        req,
        g.tab.as_ref(),
        g.trail.as_ref(),
        cards_label,
        &g.cards,
        &g.saved,
        &g.rows,
    );
    // The summaries come first in the framed block, right after the question.
    let label = thread_label(turns.len(), history.summaries.len());
    for (n, s) in history.summaries.iter().enumerate() {
        items.insert(1 + n, new_item(ItemKind::History, &label, &summary_text(s)));
    }
    for item in &mut items {
        item.locked = if g.untied_model && item.kind == ItemKind::Dbml {
            item.label = UNTIED_DBML.into();
            None
        } else {
            lock_reason(g.access, item.kind, name)
        };
        let off = item.kind != ItemKind::Question && req.off.contains(&item.kind);
        if item.locked.is_some() || off {
            item.on = false;
        }
    }

    let mut ask = Ask {
        items,
        access: g.access,
        dialect: g.config.as_ref().map(|c| c.dialect),
        notes: Vec::new(),
        untied_model: g.untied_model,
        diagram: false,
        cleaned: Vec::new(),
    };
    let input = InputRail::new(g.secrets.clone());
    let boundary = new_boundary();
    let retrieval = RetrievalRail {
        boundary: boundary.clone(),
    };
    run_rails(&[&input, &retrieval], &mut ask, log)?;
    let mut cleaned = std::mem::take(&mut ask.cleaned);
    let rows_kept = fit_sample_rows(&mut ask, g, log);
    if cap_query_share(&mut ask, g.shares.query) {
        log.push(
            Level::Info,
            "rail.budget",
            &[
                ("trimmed", "query".into()),
                ("share", g.shares.query.to_string()),
            ],
        );
        notes.push(format!(
            "The current statement was shortened to fit {}'s {} window.",
            g.model_name,
            window_text(g.window)
        ));
    }

    let question = ask
        .items
        .iter()
        .find(|i| i.kind == ItemKind::Question)
        .map(|i| i.text.clone())
        .unwrap_or_default();
    let (mut parts, trimmed) = trim_to_cap(
        &mut ask,
        &boundary,
        &question,
        &mut fit,
        &g.line_tables,
        &mut turns,
        history_on,
    );
    recount_steps(&mut ask, &mut cleaned);
    let (asked_in, used) = asked_in(req, g, &ask.items);
    let cleaning = cleaning_step(log, cleaned);
    let sent = fit.full.len() + fit.names_only.len();
    log.push(
        Level::Info,
        "tables",
        &[
            ("picked", format!("{sent}/{}", fit.reasons.len())),
            ("full", fit.full.len().to_string()),
            ("namesOnly", fit.names_only.len().to_string()),
            ("leftOut", fit.left_out.len().to_string()),
        ],
    );
    if let Some(ranked) = g.picked {
        steps.push(tables_step(log, &fit, ranked, g.outlined));
        // Counted after the cut, so a left-out open tab is not "first".
        let label = sent_label(req, sent, open_sent(&fit));
        if let Some(cards) = ask.items.iter_mut().find(|i| i.kind == ItemKind::Cards) {
            cards.label = label;
        }
    }
    if g.rows.ran {
        steps.push(rows_step(log, &g.rows, &rows_kept, &ask.items));
    }
    let rows = rows_sent(
        ask.items
            .iter()
            .filter(|i| i.kind == ItemKind::Rows && goes(i))
            .map(|i| i.text.as_str()),
    );
    let mut cleaning = cleaning;
    if rows.is_some() {
        cleaning.rule.push_str(CLEANING_ROWS);
    }
    steps.push(cleaning);
    // The question is at most 16 KB, so trimming always fits; the cap is the last guard,
    // and the turn, which ends the text, loses what it cut.
    let full = parts.exact();
    let exact = cap_payload(&full).to_string();
    let cut = full.len() - exact.len();
    if cut > 0 {
        let keep = parts.turn.len().saturating_sub(cut);
        parts.turn.truncate(keep);
    }
    let framed = &exact[..exact.len().saturating_sub(question.len())];
    let tokens = estimate_tokens(framed, false).saturating_add(estimate_tokens(&question, true));
    log.push(
        Level::Info,
        "payload",
        &[
            ("bytes", exact.len().to_string()),
            ("tokens", tokens.to_string()),
            ("trimmed", trimmed.to_string()),
        ],
    );

    drop_unsent_rows_notes(&mut ask);
    notes.extend(ask.notes);
    let mut items: Vec<PreviewItem> = Vec::new();
    // The thread's summaries and turns show as one Sends row.
    let mut thread_row = PreviewItem {
        kind: ItemKind::History,
        label: String::new(),
        bytes: 0,
        tokens: 0,
        locked: None,
        on: history_on,
    };
    let mut summaries = 0usize;
    for i in ask.items {
        let bytes = bytes_u32(i.text.len());
        let tokens = estimate_tokens(&i.text, i.kind == ItemKind::Question);
        if i.kind == ItemKind::History {
            summaries += 1;
            thread_row.bytes = thread_row.bytes.saturating_add(bytes);
            thread_row.tokens = thread_row.tokens.saturating_add(tokens);
            continue;
        }
        // The saved queries and the sample rows go as one item each but show as one
        // Sends row each.
        if matches!(i.kind, ItemKind::SavedQueries | ItemKind::Rows)
            && let Some(row) = items.iter_mut().find(|r| r.kind == i.kind)
        {
            row.bytes = row.bytes.saturating_add(bytes);
            row.tokens = row.tokens.saturating_add(tokens);
            continue;
        }
        items.push(PreviewItem {
            bytes,
            tokens,
            kind: i.kind,
            label: i.label,
            locked: i.locked,
            on: i.on,
        });
    }
    for t in &turns {
        thread_row.bytes = thread_row.bytes.saturating_add(bytes_u32(
            past_question(t, &boundary).len() + t.answer.len(),
        ));
        thread_row.tokens = thread_row.tokens.saturating_add(t.tokens);
    }
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    (memory.turns, memory.summaries, memory.tokens) = if history_on {
        (count(turns.len()), count(summaries), thread_row.tokens)
    } else {
        (0, 0, 0)
    };
    if !turns.is_empty() || summaries > 0 {
        thread_row.label = thread_label(turns.len(), summaries);
        items.insert(1.min(items.len()), thread_row);
    }
    if log_memory {
        memory_line(log, &memory);
    }

    // Only the texts are sent: the role lines "Show exactly" adds are not counted.
    let mut total_bytes = bytes_u32(exact.len() - parts.role_line_bytes());
    if let Some(run) = &g.outline {
        let at = items
            .iter()
            .position(|i| i.kind == ItemKind::Cards)
            .map_or(items.len(), |i| i + 1);
        items.insert(at, run.item.clone());
        if run.item.on {
            total_bytes = total_bytes.saturating_add(run.item.bytes);
        }
    }
    let (outline, outline_sent) = match &g.outline {
        Some(run) => (Some(run.preview.clone()), run.sent.clone()),
        None => (None, None),
    };
    let mut kinds: Vec<ItemKind> = sent_kinds(&items)
        .into_iter()
        .filter(|k| *k != ItemKind::History)
        .collect();
    // The answer may lean on the history that went: the turn carries what that history
    // carried, so lowering access holds it with the turns it was built on (I1).
    if history_on && (!turns.is_empty() || summaries > 0) {
        for k in &history.kinds {
            if *k != ItemKind::History && !kinds.contains(k) {
                kinds.push(*k);
            }
        }
    }
    // The highest level the This tab and Recent steps parts used, so the gate holds their
    // replay to it (spec 6.1): names at Schema only, titles and counts at query text.
    for (level, kind) in [(1, ItemKind::Names), (2, ItemKind::Sql)] {
        if used >= level && !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }
    let stamp = TurnStamp {
        topic: memory.topic,
        opened: memory.opened,
        reason: memory.reason,
        title: memory.title.clone(),
        connection_id: req.connection_id,
        database: req.database.clone(),
        action: req.action.clone(),
        // A turn that sent nothing about the database keeps no table names: a Topic summary
        // made by rules from it would otherwise carry names that never went (C2).
        tables: if kinds.iter().any(|k| needs_access(*k)) {
            g.tables.clone()
        } else {
            Vec::new()
        },
        kinds,
        asked_in,
    };
    let config = g.config.as_ref();
    Ok(Preview {
        items,
        tables: fit,
        total_bytes,
        tokens,
        exact,
        notes,
        log: log.lines[g.first_line.min(log.lines.len())..].to_vec(),
        context: g.context.clone(),
        parts,
        dialect: config
            .filter(|_| g.access != AiAccess::Never)
            .map(|c| c.dialect),
        steps,
        sql_dialect: config.map(|c| c.dialect),
        read_only: config.is_some_and(|c| c.read_only),
        outline,
        outline_sent,
        memory: Some(memory),
        stamp,
        summary: None,
        rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fit(full: &[&str], names_only: &[&str], left_out: &[&str]) -> TableFit {
        let own = |v: &[&str]| v.iter().map(|s| s.to_string()).collect();
        TableFit {
            full: own(full),
            names_only: own(names_only),
            left_out: own(left_out),
            reasons: Vec::new(),
        }
    }

    fn own(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn gathered_rows_debug_holds_no_cell() {
        let rows = GatheredRows {
            ran: true,
            named: vec![("orders".into(), "name match", ReadOutcome::Read)],
            tables: vec![SampleTable {
                table: "orders".into(),
                reason: "name match".into(),
                text: "orders(note)\n[\"zq-cell-7731\"]".into(),
                rows: 1,
                secret_columns: vec!["zq-col-1".into()],
            }],
        };
        let shown = format!("{rows:?}");
        assert!(shown.contains("orders") && shown.contains('1'), "{shown}");
        assert!(!shown.contains("zq-cell-7731"), "{shown}");
    }

    #[test]
    fn rows_cut_mid_line_drops_the_partial_line() {
        let line = format!("[\"{}\"]", "x".repeat(40_000));
        let text = format!("t(a)\n{}", [line.as_str(); 6].join("\n"));
        let item = |kind, text: &str| Item {
            kind,
            label: String::new(),
            text: text.into(),
            locked: None,
            on: true,
        };
        let mut ask = Ask {
            items: vec![item(ItemKind::Question, "q"), item(ItemKind::Rows, &text)],
            access: AiAccess::SchemaQueryRows,
            dialect: None,
            notes: Vec::new(),
            untied_model: false,
            diagram: false,
            cleaned: Vec::new(),
        };
        let mut f = fit(&[], &[], &[]);
        let (_, trimmed) = trim_to_cap(&mut ask, "b0", "q", &mut f, &[], &mut Vec::new(), true);
        assert_eq!(trimmed, 1);
        let kept = &ask.items[1].text;
        assert!(kept.len() < text.len());
        let rows: Vec<&str> = kept.lines().skip(1).collect();
        assert!(!rows.is_empty() && rows.len() < 6, "{}", rows.len());
        assert!(rows.iter().all(|l| *l == line), "a broken line was kept");
        assert_eq!(text_rows(kept) as usize, rows.len());

        // Only the header left: nothing to send.
        let mut ask = Ask {
            items: vec![
                item(ItemKind::Question, "q"),
                item(
                    ItemKind::Rows,
                    &format!("t(a)\n[\"{}\"]", "x".repeat(210_000)),
                ),
            ],
            access: AiAccess::SchemaQueryRows,
            dialect: None,
            notes: Vec::new(),
            untied_model: false,
            diagram: false,
            cleaned: Vec::new(),
        };
        trim_to_cap(&mut ask, "b0", "q", &mut f, &[], &mut Vec::new(), true);
        assert_eq!(ask.items[1].text, "");
    }

    fn tab_req(tab: AskTab) -> AskRequest {
        AskRequest {
            request_id: "r1".into(),
            place: "ungrouped".into(),
            group_id: None,
            connection_id: None,
            database: Some("shop".into()),
            schema: None,
            action: "ask".into(),
            question: "q".into(),
            thread_id: None,
            focus: crate::ai::request::Focus {
                sql: Some("select 1".into()),
                ..Default::default()
            },
            switches: Switches::default(),
            off: Vec::new(),
            model: None,
            picks: None,
            tab: Some(tab),
            steps: Vec::new(),
        }
    }

    #[test]
    fn tab_item_order_and_trim() {
        let tab = TabText {
            where_line: "Home".into(),
            text: "Home".into(),
            summary: String::new(),
            facts: Vec::new(),
            used: 0,
            tables: Vec::new(),
        };
        let saved = SavedItems {
            texts: Vec::new(),
            locked: false,
        };
        let rows = GatheredRows::default();
        let items = build_items(
            &tab_req(AskTab::Home),
            Some(&tab),
            None,
            Some("Schema".into()),
            "orders(id int)",
            &saved,
            &rows,
        );
        let kinds: Vec<ItemKind> = items.iter().map(|i| i.kind).collect();
        assert_eq!(
            kinds[..4],
            [
                ItemKind::Question,
                ItemKind::Names,
                ItemKind::Tab,
                ItemKind::Cards
            ]
        );
        assert_eq!(items[2].label, "This tab");
        assert_eq!(items[2].text, "Home");
        let sql = items.iter().find(|i| i.kind == ItemKind::Sql).unwrap();
        assert_eq!(sql.label, "Query text");

        // The SQL a Compare tab or a view tab shows is named for what it is.
        let compare = AskTab::Compare {
            source: crate::ai::scene::CompareSide::Database {
                database: "shop".into(),
            },
            target_database: "shop_staging".into(),
            items: Vec::new(),
            added: 0,
            removed: 0,
            changed: 0,
            not_compared: 0,
            ticked: 0,
            compared: true,
        };
        let view = AskTab::Object {
            title: "v_orders".into(),
            path: ObjectPath {
                database: "shop".into(),
                schema: None,
                name: "v_orders".into(),
            },
            object: ObjectKind::View,
            sort: None,
            filter_columns: Vec::new(),
            hidden: Vec::new(),
            pending_edits: 0,
        };
        for (tab, label) in [(compare, "Sync script"), (view, "Definition")] {
            let items = build_items(&tab_req(tab), None, None, None, "", &saved, &rows);
            let sql = items.iter().find(|i| i.kind == ItemKind::Sql).unwrap();
            assert_eq!(sql.label, label);
        }

        // Over 200 KB: the thread goes first, then This tab by whole lines; the cards stay.
        let item = |kind, text: String| Item {
            kind,
            label: String::new(),
            text,
            locked: None,
            on: true,
        };
        let line = "x".repeat(99);
        let tab_text = format!("Home\n{}", vec![line.as_str(); 600].join("\n"));
        let cards: String = (0..1_400)
            .map(|i| format!("t{i:04}(id int, {})", "c".repeat(80)))
            .collect::<Vec<_>>()
            .join("\n");
        let mut ask = Ask {
            items: vec![
                item(ItemKind::Question, "q".into()),
                item(ItemKind::History, "h".repeat(30_000)),
                item(ItemKind::Tab, tab_text.clone()),
                item(ItemKind::Cards, cards.clone()),
            ],
            access: AiAccess::Schema,
            dialect: None,
            notes: Vec::new(),
            untied_model: false,
            diagram: false,
            cleaned: Vec::new(),
        };
        let mut f = fit(&[], &[], &[]);
        let (parts, _) = trim_to_cap(&mut ask, "b0", "q", &mut f, &[], &mut Vec::new(), true);
        assert!(parts.exact().len() <= PAYLOAD_CAP);
        assert!(ask.items.iter().all(|i| i.kind != ItemKind::History));
        let tab = ask.items.iter().find(|i| i.kind == ItemKind::Tab).unwrap();
        assert!(!tab.text.is_empty() && tab.text.len() < tab_text.len());
        assert!(tab.text.starts_with("Home\n"));
        assert!(
            tab.text.lines().skip(1).all(|l| l == line),
            "a broken line was kept"
        );
        let kept = ask
            .items
            .iter()
            .find(|i| i.kind == ItemKind::Cards)
            .unwrap();
        assert_eq!(kept.text, cards);
    }

    #[test]
    fn the_200_kb_cut_keeps_the_tab_where_line() {
        let item = |kind, text: String| Item {
            kind,
            label: String::new(),
            text,
            locked: None,
            on: true,
        };
        let where_line = "Schema Compare: shop to shop_staging";
        let tab_text = format!("{where_line}\n{}", vec!["x".repeat(99); 600].join("\n"));
        // Cards past 200 KB on their own: the whole tab body must go, its where line stays.
        let cards: String = (0..2_400)
            .map(|i| format!("t{i:04}(id int, {})", "c".repeat(80)))
            .collect::<Vec<_>>()
            .join("\n");
        let mut ask = Ask {
            items: vec![
                item(ItemKind::Question, "q".into()),
                item(ItemKind::Tab, tab_text),
                item(ItemKind::Cards, cards),
            ],
            access: AiAccess::Schema,
            dialect: None,
            notes: Vec::new(),
            untied_model: false,
            diagram: false,
            cleaned: Vec::new(),
        };
        let mut f = fit(&[], &[], &[]);
        let (parts, _) = trim_to_cap(&mut ask, "b0", "q", &mut f, &[], &mut Vec::new(), true);
        assert!(parts.exact().len() <= PAYLOAD_CAP);
        let tab = ask.items.iter().find(|i| i.kind == ItemKind::Tab).unwrap();
        assert_eq!(tab.text, where_line);
    }

    #[test]
    fn steps_item_order_and_trim() {
        let tab = TabText {
            where_line: "Home".into(),
            text: "Home".into(),
            summary: String::new(),
            facts: Vec::new(),
            used: 0,
            tables: Vec::new(),
        };
        let trail = StepsOut {
            text: "(2 min ago) opened Settings\n(just now) opened Home".into(),
            ..StepsOut::default()
        };
        let saved = SavedItems {
            texts: Vec::new(),
            locked: false,
        };
        let rows = GatheredRows::default();
        let items = build_items(
            &tab_req(AskTab::Home),
            Some(&tab),
            Some(&trail),
            Some("Schema".into()),
            "orders(id int)",
            &saved,
            &rows,
        );
        let kinds: Vec<ItemKind> = items.iter().map(|i| i.kind).collect();
        assert_eq!(
            kinds[..5],
            [
                ItemKind::Question,
                ItemKind::Names,
                ItemKind::Tab,
                ItemKind::Steps,
                ItemKind::Cards
            ]
        );
        assert_eq!(items[3].label, "Recent steps · 2");
        assert_eq!(items[3].text, trail.text);

        // Over 200 KB: after the thread, the oldest steps go by whole lines, before This tab.
        let item = |kind, text: String| Item {
            kind,
            label: String::new(),
            text,
            locked: None,
            on: true,
        };
        let steps_text = (0..1_000)
            .map(|i| format!("({i:04} min ago) ticked orders.é{}", "x".repeat(40)))
            .collect::<Vec<_>>()
            .join("\n");
        let tab_text = format!("Home\n{}", vec!["y".repeat(99); 600].join("\n"));
        let cards: String = (0..800)
            .map(|i| format!("t{i:04}(id int, {})", "c".repeat(80)))
            .collect::<Vec<_>>()
            .join("\n");
        let mut ask = Ask {
            items: vec![
                item(ItemKind::Question, "q".into()),
                item(ItemKind::History, "h".repeat(30_000)),
                item(ItemKind::Tab, tab_text.clone()),
                item(ItemKind::Steps, steps_text.clone()),
                item(ItemKind::Cards, cards.clone()),
            ],
            access: AiAccess::Schema,
            dialect: None,
            notes: Vec::new(),
            untied_model: false,
            diagram: false,
            cleaned: Vec::new(),
        };
        let mut f = fit(&[], &[], &[]);
        let (parts, _) = trim_to_cap(&mut ask, "b0", "q", &mut f, &[], &mut Vec::new(), true);
        assert!(parts.exact().len() <= PAYLOAD_CAP);
        let text = |ask: &Ask, kind| {
            ask.items
                .iter()
                .find(|i| i.kind == kind)
                .unwrap()
                .text
                .clone()
        };
        let steps = text(&ask, ItemKind::Steps);
        assert!(!steps.is_empty() && steps.len() < steps_text.len());
        // The newest whole lines stay.
        assert!(steps_text.ends_with(steps.as_str()));
        assert!(steps.starts_with('('), "a broken line was kept");
        let left = steps.lines().count();
        recount_steps(&mut ask, &mut []);
        let row = ask
            .items
            .iter()
            .find(|i| i.kind == ItemKind::Steps)
            .unwrap();
        assert_eq!(
            row.label,
            format!("Recent steps · {}", grouped(left as u64))
        );
        // Cut to nothing: no row.
        ask.items
            .iter_mut()
            .find(|i| i.kind == ItemKind::Steps)
            .unwrap()
            .text
            .clear();
        recount_steps(&mut ask, &mut []);
        assert!(ask.items.iter().all(|i| i.kind != ItemKind::Steps));
        assert_eq!(text(&ask, ItemKind::Tab), tab_text);
        assert_eq!(text(&ask, ItemKind::Cards), cards);
    }

    #[test]
    fn cut_cards_move_to_left_out_in_order() {
        let lines = own(&["a", "b", "c", "d"]);
        let mut f = fit(&["a", "b"], &["c", "d"], &["e"]);
        drop_cut_tables(&mut f, &lines, 3);
        assert_eq!(f, fit(&["a", "b"], &["c"], &["d", "e"]));

        let mut f = fit(&["a", "b"], &["c", "d"], &["e"]);
        drop_cut_tables(&mut f, &lines, 1);
        assert_eq!(f, fit(&["a"], &[], &["b", "c", "d", "e"]));

        let mut f = fit(&["a"], &["b"], &[]);
        drop_cut_tables(&mut f, &own(&["a", "b"]), 2);
        assert_eq!(f, fit(&["a"], &["b"], &[]));
    }

    #[test]
    fn the_cut_drops_the_lowest_ranked_first() {
        // Ranked: orders (open tab), then zebra and alpha; the lines are in rank order,
        // so the cut takes alpha, though it is first by name.
        let mut f = fit(&["alpha", "orders", "zebra"], &[], &[]);
        f.reasons = ["orders", "zebra", "alpha"]
            .iter()
            .map(|n| (n.to_string(), "r".to_string(), String::new()))
            .collect();
        drop_cut_tables(&mut f, &own(&["orders", "zebra", "alpha"]), 2);
        assert_eq!(f, {
            let mut want = fit(&["orders", "zebra"], &[], &["alpha"]);
            want.reasons = f.reasons.clone();
            want
        });
        assert_eq!(f.reasons[2].1, crate::ai::budget::LEFT_OUT);
    }

    #[test]
    fn cut_tables_get_the_left_out_rule() {
        let mut f = fit(&["a"], &["b", "c"], &[]);
        f.reasons = ["a", "b", "c"]
            .iter()
            .map(|n| (n.to_string(), "x".to_string(), String::new()))
            .collect();
        drop_cut_tables(&mut f, &own(&["a", "b", "c"]), 2);
        assert_eq!(f.left_out, ["c"]);
        assert_eq!(f.reasons[1].1, "x");
        assert_eq!(f.reasons[2].1, crate::ai::budget::LEFT_OUT);
        assert_eq!(f.reasons[2].2, crate::ai::budget::SENT_NONE);
    }

    #[test]
    fn trimmed_tables_lose_whole_schema_fits() {
        let mut f = fit(&["a", "b"], &[], &[]);
        f.reasons = ["a", "b"]
            .iter()
            .map(|n| {
                (
                    n.to_string(),
                    crate::ai::budget::WHOLE_FITS.to_string(),
                    crate::ai::budget::SENT_FULL.to_string(),
                )
            })
            .collect();
        drop_cut_tables(&mut f, &own(&["a", "b"]), 1);
        assert_eq!(f.reasons[0].1, crate::ai::budget::FULL_BEFORE_CUT);
        assert_eq!(f.reasons[1].1, crate::ai::budget::LEFT_OUT);
    }

    #[test]
    fn open_tabs_count_only_when_sent() {
        let mut f = fit(&["orders"], &["stores"], &["invoices"]);
        f.reasons = [
            ("invoices", OPEN_TAB),
            ("stores", OPEN_TAB),
            ("orders", "named"),
        ]
        .iter()
        .map(|(t, rule)| (t.to_string(), rule.to_string(), String::new()))
        .collect();
        // invoices was open but left out: only stores counts.
        assert_eq!(open_sent(&f), 1);
    }

    #[test]
    fn sends_label_never_understates() {
        use crate::ai::request::{Focus, Switches, TableRef};
        let req = |names: &[&str]| AskRequest {
            request_id: "r".into(),
            place: "p".into(),
            group_id: None,
            connection_id: None,
            database: None,
            schema: None,
            action: "ask".into(),
            question: "q".into(),
            thread_id: None,
            focus: Focus {
                tables: names
                    .iter()
                    .map(|n| TableRef {
                        schema: None,
                        name: n.to_string(),
                    })
                    .collect(),
                ..Focus::default()
            },
            switches: Switches::default(),
            off: Vec::new(),
            model: None,
            picks: None,
            tab: None,
            steps: Vec::new(),
        };
        assert_eq!(sent_label(&req(&["orders"]), 1, 1), "Schema · orders");
        assert_eq!(
            sent_label(&req(&["orders"]), 6, 1),
            "Schema · 6 tables, orders first"
        );
        assert_eq!(sent_label(&req(&["a", "b"]), 2, 2), "Schema · 2 tables");
        assert_eq!(
            sent_label(&req(&["a", "b"]), 6, 2),
            "Schema · 6 tables, 2 named first"
        );
        assert_eq!(sent_label(&req(&[]), 1, 0), "Schema · 1 table");
        assert_eq!(sent_label(&req(&[]), 1_200, 0), "Schema · 1,200 tables");
        // A focus table the schema does not hold is not claimed.
        assert_eq!(sent_label(&req(&["gone"]), 3, 0), "Schema · 3 tables");
    }

    #[test]
    fn window_text_matches_the_ui() {
        assert_eq!(window_text(8_000), "8K");
        assert_eq!(window_text(8_192), "8K");
        assert_eq!(window_text(131_072), "131K");
        assert_eq!(window_text(200_000), "200K");
        assert_eq!(window_text(1_000_000), "1M");
        assert_eq!(window_text(1_047_576), "1M");
        assert_eq!(window_text(1_500_000), "1.5M");
        assert_eq!(window_text(950), "950");
    }

    #[test]
    fn query_share_cuts_long_items_to_one_level() {
        let long = "s".repeat(7_000);
        let mut ask = Ask {
            items: vec![
                new_item(ItemKind::Sql, "Query text", &long),
                new_item(ItemKind::Sql, "Selection", &long),
                new_item(ItemKind::Error, "Error", "short"),
            ],
            access: AiAccess::SchemaQuery,
            dialect: None,
            notes: Vec::new(),
            untied_model: false,
            diagram: false,
            cleaned: Vec::new(),
        };
        assert!(cap_query_share(&mut ask, 202));
        let tokens: Vec<u32> = ask
            .items
            .iter()
            .map(|i| estimate_tokens(&i.text, false))
            .collect();
        assert_eq!(tokens, [100, 100, 2]);
        assert!(!cap_query_share(&mut ask, 202));
    }

    #[test]
    fn cards_are_cut_by_whole_lines() {
        let card = |n: char| format!("{n}({})", "x".repeat(30 * 1024));
        let cards = format!(
            "{}
{}
{}",
            card('a'),
            card('b'),
            card('c')
        );
        let sql = "s".repeat(64 * 1024);
        let mut ask = Ask {
            items: vec![
                new_item(ItemKind::Cards, "Schema · 3 tables", &cards),
                new_item(ItemKind::Sql, "Query text", &sql),
                new_item(ItemKind::Sql, "Selection", &sql),
            ],
            access: AiAccess::SchemaQuery,
            dialect: None,
            notes: Vec::new(),
            untied_model: false,
            diagram: false,
            cleaned: Vec::new(),
        };
        let mut f = fit(&["a", "b", "c"], &[], &[]);
        let (parts, trimmed) = trim_to_cap(
            &mut ask,
            "0123456789abcdef",
            "q",
            &mut f,
            &own(&["a", "b", "c"]),
            &mut Vec::new(),
            true,
        );
        assert!(parts.exact().len() <= PAYLOAD_CAP);
        assert_eq!(trimmed, 1);
        assert_eq!(
            ask.items[0].text,
            format!(
                "{}
{}",
                card('a'),
                card('b')
            )
        );
        assert_eq!(f, fit(&["a", "b"], &[], &["c"]));
        assert_eq!(ask.items[1].text.len(), sql.len());
    }
}
