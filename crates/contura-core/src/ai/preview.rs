//! The Ask preview: what one Ask would send, built and measured in the Core (R1.6).
//! It reads the stored Connection, never the request, for the access level (R1.2).

use serde::Serialize;

use std::time::Instant;

use crate::ai::budget::{
    LEFT_OUT, NAMES_ONLY, OPEN_TAB, PAYLOAD_CAP, TableFit, budget, cap_payload, estimate_tokens,
};
use crate::ai::context::cards::cleaner;
use crate::ai::context::outline::{
    OutlineRequest, Resolved, TablePicker, build_outline, parse_reply, resolve, should_outline,
};
use crate::ai::context::retrieve::{Retrieval, Seeds, retrieve};
use crate::ai::context::store::{ContextKey, ContextStore};
use crate::ai::context::sync::{ContextInfo, Purpose, context_key, ensure};
use crate::ai::context::tree::{Area, areas_for};
use crate::ai::log::{Level, Log, LogLine, ProcessStep, StepKind, error_kind};
use crate::ai::models::{ModelInfo, clamp};
use crate::ai::prompt::outline_prompt;
use crate::ai::provider::{max_tokens_on_wire, wire_thinking};
use crate::ai::rails::retrieval::outline_block;
use crate::ai::rails::{
    Ask, InputRail, RetrievalRail, Secrets, allowed, cap_chars, framed_text, lock_reason,
    new_boundary, run_rails, schema_text,
};
use crate::ai::request::{AskRequest, Item, ItemKind, Switches};
use crate::ai::sent::OutlineSent;
use crate::ai::{AiAccess, AiSettings, now_ms};
use crate::common::grouped;
use crate::error::Result;
use crate::model::{ConnectionConfig, ConnectionId, DialectKind};
use crate::query::SavedQuery;
use crate::schema_model::SchemaModel;

/// R4.1: the answer's default `max_tokens` when the settings leave it unset.
const DEFAULT_MAX_TOKENS: u32 = 4096;

/// Exact secrets shorter than this are not matched: a 1 to 3 character password would
/// shred every text. The pattern shapes (R2.1) still catch them.
const MIN_SECRET_CHARS: usize = 4;

/// The order context is cut in when the framed text is over the 200 KB cap. DBML has no
/// budget share, so it goes before the fitted cards; the saved queries follow the cards in
/// the schema share, so they go just before them; query text goes last; the question is
/// never cut.
const TRIM_ORDER: [ItemKind; 7] = [
    ItemKind::Rows,
    ItemKind::Dbml,
    ItemKind::SavedQueries,
    ItemKind::Cards,
    ItemKind::Names,
    ItemKind::Error,
    ItemKind::Sql,
];

const UNREADABLE_NOTE: &str = "The AI Context could not be read, so no tables are sent.";

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
    /// The stored Saved Queries, for building a Context; no database call.
    async fn saved_queries(&self) -> Result<Vec<SavedQuery>> {
        Ok(Vec::new())
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

/// The two parts of what is sent besides the system prompt: the schema block, which goes
/// in the cached prefix, and the turn (the per-request framed block, then the question),
/// which goes as the user message.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PromptParts {
    /// Empty when no cards go.
    pub schema: String,
    pub turn: String,
}

impl PromptParts {
    /// What "Show exactly" displays: the schema block, a blank line, the turn.
    pub fn exact(&self) -> String {
        if self.schema.is_empty() {
            self.turn.clone()
        } else {
            format!("{}\n\n{}", self.schema, self.turn)
        }
    }
}

fn compose(ask: &Ask, boundary: &str, question: &str) -> PromptParts {
    PromptParts {
        schema: schema_text(ask),
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
fn window_text(tokens: u32) -> String {
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
struct SavedItems {
    texts: Vec<String>,
    locked: bool,
}

/// The Sends items in display order, before the gate. `cards_label` is `None` when there
/// is no Cards row: no focus tables and no Connection.
fn build_items(
    req: &AskRequest,
    cards_label: Option<String>,
    cards: &str,
    saved: &SavedItems,
) -> Vec<Item> {
    let focus = &req.focus;
    let mut items = vec![new_item(ItemKind::Question, "Question", &req.question)];
    if let Some(text) = names_text(req.database.as_deref(), req.schema.as_deref()) {
        items.push(new_item(ItemKind::Names, "Database names", &text));
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
    let sql = [
        ("Query text", &focus.sql),
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
    let mut rows = new_item(ItemKind::Rows, "Sample rows", "");
    rows.on = req.switches.rows;
    items.push(rows);
    items
}

/// Cuts framed items in `TRIM_ORDER` until the exact text fits 200 KB. Cutting `n` bytes
/// of an item's text removes at least `n` bytes of its JSON line, so each cut closes the
/// gap or empties the item. Cards are cut by whole lines and the fit is updated.
fn trim_to_cap(
    ask: &mut Ask,
    boundary: &str,
    question: &str,
    fit: &mut TableFit,
    line_tables: &[String],
) -> (PromptParts, usize) {
    let mut parts = compose(ask, boundary, question);
    let mut exact = parts.exact();
    let mut trimmed = 0;
    for kind in TRIM_ORDER {
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
            } else {
                item.text.truncate(keep);
            }
            trimmed += 1;
            parts = compose(ask, boundary, question);
            exact = parts.exact();
        }
    }
    (parts, trimmed)
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

/// The Access row: what the stored level lets go.
fn access_step(log: &Log, access: AiAccess, switches: Switches) -> ProcessStep {
    let kinds = [
        ("schema", ItemKind::Cards),
        ("query text", ItemKind::Sql),
        ("sample rows", ItemKind::Rows),
    ];
    let evidence: Vec<[String; 3]> = kinds
        .iter()
        .map(|(name, kind)| {
            let verdict = if allowed(access, *kind, switches) {
                "allowed"
            } else {
                "blocked"
            };
            [name.to_string(), verdict.into(), "AI access level".into()]
        })
        .collect();
    let open: Vec<&str> = evidence
        .iter()
        .filter(|row| row[1] == "allowed")
        .map(|row| row[0].as_str())
        .collect();
    let value = if open.is_empty() {
        "question only".to_string()
    } else {
        open.join(", ")
    };
    let rule = format!(
        "Read from the saved Connection: AI access is {}.",
        access_label(access)
    );
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
        cleaned: Vec::new(),
    };
    let input = InputRail {
        secrets: o.secrets.clone(),
    };
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

/// As `preview`, writing into the Ask's `log` and filling the Steps rows it ran.
/// `purpose` says whether the AI Context may be checked: an Ask may, the preview never.
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
    // R1.3: no Connection, or one that is gone, sends the question only.
    let access = config.as_ref().map_or(AiAccess::Never, |c| c.ai_access);
    let connection = match (&config, req.connection_id) {
        (Some(_), _) => "found",
        (None, Some(_)) => "missing",
        (None, None) => "none",
    };
    let dialect = config.as_ref().map(|c| c.dialect);
    // R1.4: only with no Connection at all; a tied model whose Connection is gone or shares
    // nothing still sends the question only.
    let untied_model = req.connection_id.is_none() && req.focus.untied_model;
    log.push(
        Level::Info,
        "access",
        &[
            ("connection", connection.into()),
            ("level", access_id(access).into()),
            (
                "dialect",
                dialect.map_or_else(String::new, |d| format!("{d:?}").to_lowercase()),
            ),
        ],
    );
    steps.push(access_step(log, access, req.switches));

    let exact_secrets = long_secrets(secrets);

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
    if let Some(config) = &config
        && !req.off.contains(&ItemKind::Cards)
        && allowed(access, ItemKind::Cards, req.switches)
    {
        let key = context_key(config, req.database.as_deref(), req.schema.as_deref());
        let clean = cleaner(&exact_secrets);
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

    let name = config.as_ref().map_or("", |c| c.name.as_str());
    let cards_label = (config.is_some() || !req.focus.tables.is_empty()).then(|| tables_label(req));
    let mut items = build_items(req, cards_label, &cards, &saved);
    for item in &mut items {
        item.locked = if untied_model && item.kind == ItemKind::Dbml {
            item.label = UNTIED_DBML.into();
            None
        } else {
            lock_reason(access, item.kind, name)
        };
        let off = item.kind != ItemKind::Question && req.off.contains(&item.kind);
        if item.locked.is_some() || off {
            item.on = false;
        }
    }

    let mut ask = Ask {
        items,
        access,
        dialect,
        notes: Vec::new(),
        untied_model,
        cleaned: Vec::new(),
    };
    let input = InputRail {
        secrets: exact_secrets,
    };
    let boundary = new_boundary();
    let retrieval = RetrievalRail {
        boundary: boundary.clone(),
    };
    run_rails(&[&input, &retrieval], &mut ask, log)?;
    let cleaning = cleaning_step(log, std::mem::take(&mut ask.cleaned));
    if cap_query_share(&mut ask, shares.query) {
        log.push(
            Level::Info,
            "rail.budget",
            &[
                ("trimmed", "query".into()),
                ("share", shares.query.to_string()),
            ],
        );
        notes.push(format!(
            "The current statement was shortened to fit {}'s {} window.",
            model.name,
            window_text(model.context_window)
        ));
    }

    let question = ask
        .items
        .iter()
        .find(|i| i.kind == ItemKind::Question)
        .map(|i| i.text.clone())
        .unwrap_or_default();
    let (mut parts, trimmed) = trim_to_cap(&mut ask, &boundary, &question, &mut fit, &line_tables);
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
    if let Some(ranked) = picked {
        steps.push(tables_step(log, &fit, ranked, outlined));
        // Counted after the cut, so a left-out open tab is not "first".
        let label = sent_label(req, sent, open_sent(&fit));
        if let Some(cards) = ask.items.iter_mut().find(|i| i.kind == ItemKind::Cards) {
            cards.label = label;
        }
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

    notes.extend(ask.notes);
    let mut items: Vec<PreviewItem> = Vec::new();
    for i in ask.items {
        let bytes = bytes_u32(i.text.len());
        let tokens = estimate_tokens(&i.text, i.kind == ItemKind::Question);
        // The saved queries go as one item each but show as one Sends row.
        if i.kind == ItemKind::SavedQueries
            && let Some(row) = items.iter_mut().find(|r| r.kind == ItemKind::SavedQueries)
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
    let mut total_bytes = bytes_u32(exact.len());
    if let Some(run) = &outline {
        let at = items
            .iter()
            .position(|i| i.kind == ItemKind::Cards)
            .map_or(items.len(), |i| i + 1);
        items.insert(at, run.item.clone());
        if run.item.on {
            total_bytes = total_bytes.saturating_add(run.item.bytes);
        }
    }
    let (outline, outline_sent) = match outline {
        Some(run) => (Some(run.preview), run.sent),
        None => (None, None),
    };
    Ok(Preview {
        items,
        tables: fit,
        total_bytes,
        tokens,
        exact,
        notes,
        log: log.lines[first_line..].to_vec(),
        context,
        parts,
        dialect: config
            .as_ref()
            .filter(|c| c.ai_access != AiAccess::Never)
            .map(|c| c.dialect),
        steps,
        sql_dialect: config.as_ref().map(|c| c.dialect),
        read_only: config.is_some_and(|c| c.read_only),
        outline,
        outline_sent,
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
            cleaned: Vec::new(),
        };
        let mut f = fit(&["a", "b", "c"], &[], &[]);
        let (parts, trimmed) = trim_to_cap(
            &mut ask,
            "0123456789abcdef",
            "q",
            &mut f,
            &own(&["a", "b", "c"]),
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
