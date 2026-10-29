//! The diagram Ask (step 11h): what the webview sends from a diagram tab, the preview of
//! what it would send, and the Ask itself. A diagram is not database data, so no AI access
//! level applies to the text and no Connection is read; but a frame From my database drew
//! holds a Connection's names, so the Ask is refused whole while that Connection is held,
//! and so is a node whose `table:` link resolves to one (Task 4b). Its .flow text still goes
//! through the input rail (R2.1, R2.2) and is framed (R3.1) like any outgoing text. The Ask carries one
//! tool, checks the model's one call against the outline, and shows the proposal only if
//! the file on disk did not change while the model worked.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::ai::attachment::{Attachment, AttachmentSlot, attachment_for};
use crate::ai::board::{
    ATTACH_SHARE_DIV, BoardInput, FrameFit, board_budget, board_history_gated, board_items,
    tokens_of,
};
use crate::ai::budget::{PAYLOAD_CAP, TableFit, estimate_tokens};
use crate::ai::context::store::{ContextKey, ContextStore};
use crate::ai::diagram_tool::{
    ChangeStatus, DIAGRAM_KIND_IDS, DiagramOp, DiagramScope, DropReason, FOLLOW_UP_CHARS,
    FlowOutline, INPUT_CAP, ProposeInput, ProposedChange, TOOL_NAME, base_hash_of, check,
    check_board,
};
use crate::ai::log::{Level, Log, ProcessStep, StepKind};
use crate::ai::memory::TurnStamp;
use crate::ai::models::{CachingKind, ModelInfo, ModelPicks, clamp};
use crate::ai::preview::{Preview, PreviewItem, PromptParts, count_of, long_secrets};
use crate::ai::prompt::{board_prompt, diagram_prompt};
use crate::ai::provider::url::host_of;
use crate::ai::provider::{
    AiProvider, ChatMessage, ChatRequest, ChatRole, PromptBlock, max_tokens_on_wire, tool_text,
    wire_thinking,
};
use crate::ai::rails::execution::{ExecutionRail, ToolsAllowed, tool_for};
use crate::ai::rails::retrieval::selection_label;
use crate::ai::rails::{
    Ask, InputRail, RetrievalRail, Secrets, cap_chars, framed_block, new_boundary, redact_secrets,
    run_rails, strip_invisible,
};
use crate::ai::request::{Item, ItemKind};
use crate::ai::sent::{SentRecord, fnv1a64_parts};
use crate::ai::stream::{
    AiEvent, DEFAULT_MAX_TOKENS, Ended, Pump, TOOL_CALLS, ToolCallSeen, answer_row, database_line,
    end_answer, error_line, fail, fail_build, fail_logged, request_line, request_step,
    stream_answer,
};
use crate::ai::{AiAccess, AiError, AiSettings, AiThread, ThreadId, now_ms};
use crate::common::grouped;
use crate::error::{Error, Result};
use crate::lineage::flow_table_nodes_upto;
use crate::model::{ConnectionConfig, ConnectionId};

/// The most shapes, or lines, a diagram Ask takes.
pub const MAX_SHAPES: usize = 5_000;

/// Why the diagram rows of Sends cannot be switched off.
pub const DIAGRAM_LOCK: &str = "The changes are written against this text";
const DIAGRAM_RULE: &str = "Diagrams are not database data: no AI access level applies.";
const CLEANING_RULE: &str = "Secrets are always replaced. Hidden characters are removed.";
const BOARD_RULE: &str = "Each diagram goes in full, as names only, or is left out to fit the budget; none is cut inside.";

/// What the webview sends for one diagram Ask.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagramAskRequest {
    pub request_id: String,
    /// The diagram's name, without `.flow`.
    pub file: String,
    /// The .flow text as the tab holds it.
    pub text: String,
    /// The language worker's outline of `text`.
    pub outline: FlowOutline,
    pub question: String,
    pub scope: DiagramScope,
    pub thread_id: Option<ThreadId>,
    /// The model picked for this Ask; `None` asks the settings' model.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub picks: Option<ModelPicks>,
    /// The board the Ask was made on; each change is checked in the frame it names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board: Option<BoardInput>,
    /// The frames From my database drew, from the layout file (Task 4b); none is not gated.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<FrameSourceIn>,
    /// The nodes with a `table:` the webview read, at most `MAX_TABLE_LINKS`. The Core also
    /// reads every `table:` in `text` itself, so one left out here is gated all the same.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub table_links: Vec<TableLinkIn>,
}

/// Where a frame was drawn from, as its entry in `<name>.flow.layout.json` records it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FrameSourceIn {
    /// The frame's title: its layout entry's key.
    pub frame: String,
    pub connection_id: ConnectionId,
    pub database: String,
    /// `None` on MySQL and SQLite, which have no schema.
    #[serde(default)]
    pub schema: Option<String>,
}

/// A node with a `table:` value, written as the user typed it (`shop.orders`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct TableLinkIn {
    /// The frame's title; `None` on a one-frame file.
    #[serde(default)]
    pub frame: Option<String>,
    pub node: String,
    pub table: String,
}

/// The most `table_links` a request may list; a longer list is `InvalidInput`.
pub const MAX_TABLE_LINKS: usize = 500;

/// What the diagram Ask's gate knows of the Connections, built by the command from what it
/// already reads: every Connection's id, name and stored AI access
/// (`ConnectionService::list`), those on this Ask's provider
/// (`AiService::same_provider(None, ..)`, the diagram Ask uses the ungrouped settings),
/// and for each `table:` value of the request the Connections holding a table of that path
/// (`table_owners`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SourceStanding {
    pub connections: Vec<(ConnectionId, String, AiAccess)>,
    pub same_provider: Vec<ConnectionId>,
    pub owners: Vec<(String, Vec<ConnectionId>)>,
}

/// Why a Connection holds a diagram Ask back.
enum Hold<'a> {
    Never(&'a str),
    Missing,
    OtherProvider(&'a str),
}

impl SourceStanding {
    /// Never first, then deleted, then another Group's provider; `None` when it passes.
    fn hold(&self, id: ConnectionId) -> Option<Hold<'_>> {
        let Some((_, name, access)) = self.connections.iter().find(|(c, ..)| *c == id) else {
            return Some(Hold::Missing);
        };
        if *access == AiAccess::Never {
            return Some(Hold::Never(name));
        }
        if !self.same_provider.contains(&id) {
            return Some(Hold::OtherProvider(name));
        }
        None
    }

    /// Whether `id` holds an Ask back now: at Never, deleted, or on another provider.
    pub fn holds(&self, id: ConnectionId) -> bool {
        self.hold(id).is_some()
    }

    fn owners_of(&self, table: &str) -> &[ConnectionId] {
        self.owners
            .iter()
            .find(|(v, _)| v == table)
            .map_or(&[], |(_, o)| o.as_slice())
    }
}

/// The most characters of a name in a held sentence.
const HELD_NAME_CHARS: usize = 60;

/// A name as a held sentence shows it: no invisible or control characters, at most 60.
fn held_name(s: &str) -> String {
    strip_invisible(s)
        .0
        .chars()
        .filter(|c| !c.is_control())
        .take(HELD_NAME_CHARS)
        .collect()
}

/// The sentence of the first held frame source in `sources` order, else of the first held
/// table link in `table_links` order; `None` when every one passes. A link's value several
/// Connections own is held when any of them is; a value none owns is not held.
pub fn held_sources(
    sources: &[FrameSourceIn],
    table_links: &[TableLinkIn],
    standing: &SourceStanding,
) -> Option<String> {
    for s in sources {
        let frame = held_name(&s.frame);
        match standing.hold(s.connection_id) {
            None => {}
            Some(Hold::Never(c)) => {
                return Some(format!(
                    "The frame \"{frame}\" was drawn from {}, whose AI access is Never, so this Ask was not sent. Remove the frame or change that Connection's AI access.",
                    held_name(c)
                ));
            }
            Some(Hold::Missing) => {
                return Some(format!(
                    "The frame \"{frame}\" was drawn from a Connection that no longer exists (database {}), so this Ask was not sent. Remove the frame to ask about this board.",
                    held_name(&s.database)
                ));
            }
            Some(Hold::OtherProvider(c)) => {
                return Some(format!(
                    "The frame \"{frame}\" was drawn from {}, which uses another Group's AI provider, so this Ask was not sent. Remove the frame to ask about this board.",
                    held_name(c)
                ));
            }
        }
    }
    for l in table_links {
        let (node, table) = (held_name(&l.node), held_name(&l.table));
        for id in standing.owners_of(&l.table) {
            match standing.hold(*id) {
                Some(Hold::Never(c)) => {
                    return Some(format!(
                        "The node \"{node}\" links to table {table} of {}, whose AI access is Never, so this Ask was not sent. Remove the link or change that Connection's AI access.",
                        held_name(c)
                    ));
                }
                Some(Hold::OtherProvider(c)) => {
                    return Some(format!(
                        "The node \"{node}\" links to table {table} of {}, which uses another Group's AI provider, so this Ask was not sent. Remove the link to ask about this board.",
                        held_name(c)
                    ));
                }
                // Owners come from the Connections listed, so none is missing.
                Some(Hold::Missing) | None => {}
            }
        }
    }
    None
}

/// Every `table:` link of the request: the Core's own read of `text`, in text order, then
/// any the webview listed that the text read did not give. More than `MAX_TABLE_LINKS`
/// from the webview is `InvalidInput`.
pub fn table_links_of(req: &DiagramAskRequest) -> Result<Vec<TableLinkIn>> {
    let too_many = || {
        Error::InvalidInput(format!(
            "This board lists more than {} table links, so this Ask was not sent. Remove some table: links and ask again.",
            grouped(MAX_TABLE_LINKS as u64)
        ))
    };
    if req.table_links.len() > MAX_TABLE_LINKS {
        return Err(too_many());
    }
    let mut out: Vec<TableLinkIn> = flow_table_nodes_upto(&req.text, MAX_TABLE_LINKS)
        .ok_or_else(too_many)?
        .into_iter()
        .map(|(frame, node, table)| TableLinkIn { frame, node, table })
        .collect();
    let mut seen: HashSet<TableLinkIn> = out.iter().cloned().collect();
    for l in &req.table_links {
        if seen.insert(l.clone()) {
            out.push(l.clone());
        }
    }
    Ok(out)
}

/// The distinct `table:` values of the request, in order: what the command resolves into
/// `SourceStanding::owners`.
pub fn table_values(req: &DiagramAskRequest) -> Result<Vec<String>> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for l in table_links_of(req)? {
        if seen.insert(l.table.clone()) {
            out.push(l.table);
        }
    }
    Ok(out)
}

/// One part of a `table:` value with its quotes taken off.
fn unquote(part: &str) -> &str {
    let p = part.trim();
    for (a, b) in [('"', '"'), ('`', '`'), ('[', ']')] {
        if let Some(inner) = p.strip_prefix(a).and_then(|r| r.strip_suffix(b)) {
            return inner;
        }
    }
    p
}

/// The Connections each value names a table of, as the Lineage tab matches `table:` values
/// (`flowMatches`): the last part is the table, ignoring case; one more is its schema or
/// database, two more its database and schema. A Connection owns a value when one of its
/// saved AI Contexts (`contexts`, each key with its tables) holds such a table, or when the
/// value is qualified by the database its config names: a Connection at Never keeps no
/// Context, and its own database still names it. Each Connection once, Contexts first.
pub fn table_owners(
    values: &[String],
    connections: &[ConnectionConfig],
    contexts: &[(ContextKey, Vec<String>)],
) -> Vec<(String, Vec<ConnectionId>)> {
    // Each name lowered once: the preview runs on every pause in typing.
    let low = |s: &str| s.to_lowercase();
    let saved: Vec<(&ContextKey, String, String, HashSet<String>)> = contexts
        .iter()
        .map(|(key, tables)| {
            let names = tables.iter().map(|t| low(t)).collect();
            (key, low(&key.database), low(&key.schema), names)
        })
        .collect();
    let databases: Vec<(ConnectionId, String)> = connections
        .iter()
        .filter_map(|c| c.database.as_deref().map(|db| (c.id, low(db))))
        .filter(|(_, db)| !db.is_empty())
        .collect();
    let eq = |a: &str, b: &str| !b.is_empty() && a == b;
    values
        .iter()
        .map(|v| {
            let parts: Vec<String> = v.split('.').map(|p| low(unquote(p))).collect();
            let name = &parts[parts.len() - 1];
            let mut owners: Vec<ConnectionId> = Vec::new();
            for (key, database, schema, names) in &saved {
                let place = match parts.len() {
                    1 => true,
                    2 => eq(&parts[0], schema) || eq(&parts[0], database),
                    3 => eq(&parts[0], database) && eq(&parts[1], schema),
                    _ => false,
                };
                if place && names.contains(name) && !owners.contains(&key.connection_id) {
                    owners.push(key.connection_id);
                }
            }
            if matches!(parts.len(), 2 | 3) {
                for (id, db) in &databases {
                    if parts[0] == *db && !owners.contains(id) {
                        owners.push(*id);
                    }
                }
            }
            (v.clone(), owners)
        })
        .collect()
}

/// Every saved AI Context's key with its table names, for `table_owners`.
pub fn saved_tables(store: &dyn ContextStore) -> Result<Vec<(ContextKey, Vec<String>)>> {
    let mut out = Vec::new();
    for (key, _) in store.context_list(None)? {
        let tables = store
            .context_graph(&key)?
            .into_iter()
            .map(|r| r.table)
            .collect();
        out.push((key, tables));
    }
    Ok(out)
}

/// What runs before anything of a diagram Ask is read or built, in this order: the file
/// name, the tool switch, then the Connections its frames were drawn from and its `table:`
/// links resolve to (Task 4b), refused `DiagramHeld` with the first held one's sentence.
/// Gives the Connections the Ask draws on, each once, frames first: its Sent record names
/// them so a later Ask can hold its turn back (`board_history_gated`).
pub fn diagram_gate(
    settings: &AiSettings,
    req: &DiagramAskRequest,
    standing: &SourceStanding,
) -> Result<Vec<ConnectionId>> {
    check_file_name(&req.file)?;
    if !settings.diagram_tool {
        return Err(Error::Ai(AiError::ToolOff));
    }
    let links = table_links_of(req)?;
    if let Some(message) = held_sources(&req.sources, &links, standing) {
        return Err(Error::Ai(AiError::DiagramHeld { message }));
    }
    let mut drew: Vec<ConnectionId> = Vec::new();
    let owned = links.iter().flat_map(|l| standing.owners_of(&l.table));
    for id in req.sources.iter().map(|s| &s.connection_id).chain(owned) {
        if !drew.contains(id) {
            drew.push(*id);
        }
    }
    Ok(drew)
}

/// The Diagram step's rule: today's line, or with sourced frames the count that passed.
fn diagram_rule(req: &DiagramAskRequest) -> String {
    match req.sources.len() {
        0 => DIAGRAM_RULE.to_string(),
        n => format!(
            "Diagrams are not database data, but frames drawn from a Connection follow its AI access. Passed for {} {}.",
            grouped(n as u64),
            if n == 1 { "frame" } else { "frames" }
        ),
    }
}

/// The place a diagram Ask runs in: one Ask in flight per diagram.
pub fn diagram_place(file: &str) -> String {
    format!("diagram:{file}")
}

/// Refuses a diagram file name holding a control character (a line break, U+0000 to
/// U+001F, U+007F): it would break the `File:` line of the turn. The preview and the Ask
/// both run this before anything is built.
pub fn check_file_name(file: &str) -> Result<()> {
    if file.chars().any(|c| c.is_ascii_control()) {
        return Err(Error::Ai(AiError::BadFileName));
    }
    Ok(())
}

fn new_item(kind: ItemKind, label: String, text: String) -> Item {
    Item {
        kind,
        label,
        text,
        locked: None,
        on: true,
    }
}

/// The system prompt of a board Ask: the kinds on the board and the kind asked for.
fn board_system(board: &BoardInput) -> String {
    let kinds: Vec<String> = board.frames.iter().filter_map(|f| f.kind.clone()).collect();
    board_prompt(&kinds, board.create.as_deref())
}

/// The system prompt of any diagram Ask: a board's, else the one diagram's.
fn system_prompt(req: &DiagramAskRequest) -> String {
    match &req.board {
        Some(board) => board_system(board),
        None => diagram_prompt(req.outline.kind.as_deref(), &req.outline.kinds),
    }
}

/// The most characters of the user's reply to a follow-up question.
const REPLY_CHARS: usize = 2_000;
/// What a blank reply to a follow-up asks of the model.
const BLANK_REPLY: &str = "Choose something sensible.";

/// `text` on one line: control characters as spaces, trimmed.
fn one_line(text: &str) -> String {
    text.split(|c: char| c.is_control())
        .filter(|p| !p.trim().is_empty())
        .map(str::trim)
        .collect::<Vec<_>>()
        .join(" ")
}

/// The question as the turn sends it (Decision 10): on a board Ask that answers a follow-up,
/// the question again, then "You asked: <asked>" and "The user replied: <reply>". It goes as
/// the Question item, so the rails clean it and Sends counts it.
fn question_text(req: &DiagramAskRequest) -> String {
    let Some(f) = req.board.as_ref().and_then(|b| b.follow_up.as_ref()) else {
        return req.question.clone();
    };
    let asked: String = one_line(&f.asked).chars().take(FOLLOW_UP_CHARS).collect();
    let reply: String = f.reply.trim().chars().take(REPLY_CHARS).collect();
    let reply = if reply.is_empty() {
        BLANK_REPLY.to_string()
    } else {
        reply
    };
    format!(
        "{}\n\nYou asked: {asked}\nThe user replied: {reply}",
        req.question
    )
}

/// The Sends label of the history item: its turns, as the database Ask counts them.
fn history_label(text: &str) -> String {
    let turns = text
        .lines()
        .filter(|l| l.starts_with(super::board::HISTORY_ASKED))
        .count();
    format!("Thread · {}", count_of(turns, "turn", "turns"))
}

/// The attachment as its item, within `share` tokens (Decision 5). Over the share it is cut
/// at a line end (at a character when no line fits) and ends with a note of what was sent;
/// the second value is the chat's line for that cut.
fn attachment_item(a: &Attachment, share: u32) -> (Item, Option<String>) {
    let name = one_line(&strip_invisible(&a.name).0);
    let item = |text: String| new_item(ItemKind::Attachment, name.clone(), text);
    if tokens_of(&a.text) <= share {
        return (item(a.text.clone()), None);
    }
    let marker = |kb: usize| {
        format!(
            "[cut to fit: the first {} KB of {name}]",
            grouped(kb as u64)
        )
    };
    // The longest the note can be, so the cut text and its note fit together.
    let room = share
        .saturating_sub(tokens_of(&marker(a.text.len() / 1024 + 1)))
        .saturating_sub(1);
    let fits = |end: usize| tokens_of(&a.text[..end]) <= room;
    let line_ends: Vec<usize> = a.text.match_indices('\n').map(|(i, _)| i + 1).collect();
    let end = match line_ends.partition_point(|&e| fits(e)) {
        0 => {
            // No whole line fits: the longest start of the first line that does.
            let bounds: Vec<usize> = a.text.char_indices().map(|(i, _)| i).collect();
            bounds[..bounds.partition_point(|&e| fits(e))]
                .last()
                .copied()
                .unwrap_or(0)
        }
        n => line_ends[n - 1],
    };
    let kept = &a.text[..end];
    let kb = (kept.len() + 512) / 1024;
    let note = format!("Sent the first {} KB of {name}.", grouped(kb as u64));
    // The note on a line of its own.
    let gap = if kept.is_empty() || kept.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    (item(format!("{kept}{gap}{}", marker(kb))), Some(note))
}

/// The tokens of the tool definition as it goes on the wire.
fn tool_tokens() -> u32 {
    tool_for(ToolsAllowed::DiagramTool)
        .and_then(|t| serde_json::to_string(&[t]).ok())
        .map_or(0, |t| estimate_tokens(&t, false))
}

/// The answer's tokens as the request will ask for them.
fn wire_max(settings: &AiSettings, model: &ModelInfo, req: &DiagramAskRequest) -> u32 {
    let max_tokens = settings.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS);
    match settings.provider {
        Some(kind) => {
            let picks = clamp(model, req.picks.unwrap_or(model.picks));
            let thinking = wire_thinking(model, picks.thinking, settings.share_thinking);
            max_tokens_on_wire(kind, max_tokens, &thinking)
        }
        None => max_tokens,
    }
}

/// The Steps row of a board Ask: each frame's fit and bytes, by number and kind (no titles).
fn board_step(log: &Log, board: &BoardInput, fits: &[(FrameFit, u32)]) -> ProcessStep {
    let count = |fit| fits.iter().filter(|(f, _)| *f == fit).count() as u64;
    let value = format!(
        "{} in full, {} as names, {} left out",
        grouped(count(FrameFit::Full)),
        grouped(count(FrameFit::Names)),
        grouped(count(FrameFit::LeftOut))
    );
    let evidence = board
        .frames
        .iter()
        .zip(fits)
        .enumerate()
        .map(|(k, (f, (fit, bytes)))| {
            let kind = f
                .kind
                .as_deref()
                .filter(|k| DIAGRAM_KIND_IDS.contains(k))
                .unwrap_or("diagram");
            [
                format!("#{} {kind}", grouped(k as u64 + 1)),
                fit.note().to_string(),
                format!("{} B", grouped(u64::from(*bytes))),
            ]
        })
        .collect();
    ProcessStep {
        evidence,
        ..step(log, StepKind::BoardContext, value, BOARD_RULE)
    }
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

/// Builds exactly what the diagram Ask would send, with no network and no Connection:
/// the question, the .flow text and the selection, cleaned and framed. Refused with
/// `ToolOff` when the diagram tool is off, and with `TooLarge` (never cut, since the
/// changes are written against the whole text) over 5,000 shapes or lines, a cleaned
/// text over 160 KB, or a turn over the 200 KB cap.
///
/// On a board the text goes as `board_items` (Decision 4): the header, each frame in full,
/// as names or left out to fit `board_budget` of the model's window, the sketch notes and the
/// selection; the 160 KB cap applies to each of those items and 5,000 shapes to each frame.
/// A frame range outside the text is `InvalidInput`; a reserve over the budget is `TooBig`.
///
/// `history` is the chat's stored thread: `board_history` of it goes as one History item
/// (Decision 9), only when its place is this diagram's. `attachment` is the file the user
/// attached, as one Attachment item within a third of the budget (Decision 5), cut at a line
/// end past it with a note. A board's follow-up reply goes in the question (Decision 10).
/// Every one of them goes through the input rail and is framed, and each has its Sends row.
///
/// `diagram_gate` runs first (Task 4b): a frame drawn from a Connection `standing` holds,
/// or a node whose `table:` resolves to one, refuses the preview `DiagramHeld` before
/// anything is logged or built; the text is never cut to get around it. A history turn that
/// drew on a held Connection is left out.
#[allow(clippy::too_many_arguments)]
pub fn diagram_preview(
    settings: &AiSettings,
    model: &ModelInfo,
    secrets: &Secrets,
    req: &DiagramAskRequest,
    standing: &SourceStanding,
    history: Option<&AiThread>,
    attachment: Option<&Attachment>,
    log: &mut Log,
) -> Result<Preview> {
    // Before anything is logged, read or built: a held frame's text is never assembled.
    diagram_gate(settings, req, standing)?;
    build_preview(
        settings, model, secrets, req, standing, history, attachment, log,
    )
}

/// `diagram_preview` once `diagram_gate` has passed: the Ask builds with it after its own
/// gate, so the board text is read for `table:` links once per Ask.
#[allow(clippy::too_many_arguments)]
fn build_preview(
    settings: &AiSettings,
    model: &ModelInfo,
    secrets: &Secrets,
    req: &DiagramAskRequest,
    standing: &SourceStanding,
    history: Option<&AiThread>,
    attachment: Option<&Attachment>,
    log: &mut Log,
) -> Result<Preview> {
    let first_line = log.lines.len();
    let (nodes, links) = (req.outline.nodes.len(), req.outline.links.len());
    let scope = match &req.scope {
        DiagramScope::Whole => "whole",
        DiagramScope::Selection { .. } => "selection",
    };
    log.push(
        Level::Info,
        "diagram",
        &[
            ("bytes", req.text.len().to_string()),
            ("shapes", nodes.to_string()),
            ("lines", links.to_string()),
            ("scope", scope.into()),
        ],
    );
    let over = |o: &FlowOutline| o.nodes.len() > MAX_SHAPES || o.links.len() > MAX_SHAPES;
    let too_large = match &req.board {
        Some(board) => board.frames.iter().any(|f| over(&f.outline)),
        None => nodes > MAX_SHAPES || links > MAX_SHAPES,
    };
    if too_large {
        return Err(Error::Ai(AiError::TooLarge));
    }
    // The file name is the user's own; only invisible characters go.
    let (file, _) = strip_invisible(&req.file);
    let label = format!("{file}.flow");

    let question = question_text(req);
    let mut items = vec![new_item(
        ItemKind::Question,
        "Question".into(),
        question.clone(),
    )];
    let held = |id: ConnectionId| standing.holds(id);
    let history = history.and_then(|t| board_history_gated(t, &req.file, &held));
    if let Some(text) = &history {
        items.push(new_item(
            ItemKind::History,
            history_label(text),
            text.clone(),
        ));
    }
    // The budget the attachment and the board share: the window less the answer, the
    // system prompt, the question, the tool and the history.
    let fixed = estimate_tokens(&system_prompt(req), false)
        .saturating_add(estimate_tokens(&question, true))
        .saturating_add(tool_tokens())
        .saturating_add(history.as_deref().map_or(0, tokens_of));
    let budget = board_budget(model.context_window, wire_max(settings, model, req), fixed);
    let mut cut_note = None;
    let mut attached = 0;
    if let Some(a) = attachment {
        let (item, note) = attachment_item(a, budget / ATTACH_SHARE_DIV);
        attached = tokens_of(&item.text);
        cut_note = note;
        items.push(item);
    }
    // Each item's fit, for a board frame's row.
    let mut fits: Vec<Option<FrameFit>> = vec![None; items.len()];
    if let Some(board) = &req.board {
        let budget = budget.saturating_sub(attached);
        let header = items.len();
        let (board, frame_fits) = match board_items(&file, &req.text, board, budget) {
            Ok(built) => built,
            Err(Error::Ai(AiError::TooBig { needed, .. })) => {
                return Err(Error::Ai(AiError::TooBig {
                    needed: model
                        .context_window
                        .saturating_sub(budget)
                        .saturating_add(needed),
                    window: model.context_window,
                    model: model.name.clone(),
                }));
            }
            Err(e) => return Err(e),
        };
        fits.extend(board.iter().map(|_| None));
        for (k, fit) in frame_fits {
            // After the header.
            fits[header + 1 + k] = Some(fit);
        }
        items.extend(board);
    } else {
        items.push(new_item(ItemKind::Diagram, label.clone(), req.text.clone()));
        if let DiagramScope::Selection { names } = &req.scope {
            items.push(new_item(
                ItemKind::Diagram,
                selection_label(names.len()),
                names.join("\n"),
            ));
        }
        fits.resize(items.len(), None);
    }
    let mut ask = Ask {
        items,
        access: AiAccess::Never,
        dialect: None,
        notes: Vec::new(),
        untied_model: false,
        diagram: true,
        cleaned: Vec::new(),
    };
    let input = InputRail::new(long_secrets(secrets));
    let boundary = new_boundary();
    let retrieval = RetrievalRail {
        boundary: boundary.clone(),
    };
    run_rails(&[&input, &retrieval], &mut ask, log)?;
    ask.notes.extend(cut_note);

    let mut diagram_items = ask.items.iter().filter(|i| i.kind == ItemKind::Diagram);
    // A board sends its text as many items; one diagram as its one text item.
    let sent_text: usize = match req.board {
        Some(_) => diagram_items.map(|i| i.text.len()).sum(),
        None => diagram_items.next().map_or(0, |i| i.text.len()),
    };
    let secrets_found = input.secrets_found();
    let mut steps = vec![step(
        log,
        StepKind::Diagram,
        format!("{label}, {} B", grouped(sent_text as u64)),
        &diagram_rule(req),
    )];
    if let Some(board) = &req.board {
        let frame_rows: Vec<(FrameFit, u32)> = ask
            .items
            .iter()
            .zip(&fits)
            .filter_map(|(i, fit)| {
                fit.map(|f| (f, u32::try_from(i.text.len()).unwrap_or(u32::MAX)))
            })
            .collect();
        steps.push(board_step(log, board, &frame_rows));
    }
    steps.push(ProcessStep {
        evidence: std::mem::take(&mut ask.cleaned),
        ..step(
            log,
            StepKind::Cleaning,
            count_of(secrets_found, "secret", "secrets"),
            CLEANING_RULE,
        )
    });

    let question = ask
        .items
        .iter()
        .find(|i| i.kind == ItemKind::Question)
        .map(|i| i.text.clone())
        .unwrap_or_default();
    let block = framed_block(&ask, &boundary);
    // The hash is of the text as the tab holds it: the tool input must copy it back.
    let turn = format!(
        "{block}File: {label}. base_hash: {}.\n\nQuestion: {question}",
        base_hash_of(&req.text)
    );
    // R1.5, after cleaning and framing; never cut.
    if turn.len() > PAYLOAD_CAP {
        log.push(
            Level::Warn,
            "payload",
            &[("bytes", turn.len().to_string()), ("cut", "no".into())],
        );
        return Err(Error::Ai(AiError::TooLarge));
    }
    let framed = &turn[..turn.len() - question.len()];
    let tokens = estimate_tokens(framed, false).saturating_add(estimate_tokens(&question, true));
    log.push(
        Level::Info,
        "payload",
        &[
            ("bytes", turn.len().to_string()),
            ("tokens", tokens.to_string()),
        ],
    );

    let items: Vec<PreviewItem> = ask
        .items
        .into_iter()
        .zip(fits)
        .map(|(i, fit)| PreviewItem {
            bytes: u32::try_from(i.text.len()).unwrap_or(u32::MAX),
            tokens: estimate_tokens(&i.text, i.kind == ItemKind::Question),
            locked: (i.kind == ItemKind::Diagram).then(|| DIAGRAM_LOCK.to_string()),
            on: true,
            kind: i.kind,
            label: i.label,
            fit: fit.map(|f| f.note().to_string()),
        })
        .collect();
    // The kinds the turn carried, in the order they went.
    let mut kinds: Vec<ItemKind> = Vec::new();
    for i in &items {
        if !kinds.contains(&i.kind) {
            kinds.push(i.kind);
        }
    }
    let stamp = TurnStamp {
        topic: 0,
        opened: false,
        reason: None,
        title: String::new(),
        connection_id: None,
        database: None,
        action: "diagram".into(),
        tables: Vec::new(),
        kinds,
        asked_in: None,
    };
    Ok(Preview {
        items,
        tables: TableFit::default(),
        total_bytes: u32::try_from(turn.len()).unwrap_or(u32::MAX),
        tokens,
        exact: turn.clone(),
        notes: ask.notes,
        log: log.lines[first_line.min(log.lines.len())..].to_vec(),
        context: None,
        parts: PromptParts {
            schema: String::new(),
            history: Vec::new(),
            turn,
        },
        dialect: None,
        steps,
        sql_dialect: None,
        read_only: false,
        outline: None,
        outline_sent: None,
        memory: None,
        stamp,
        summary: None,
        // Board chats keep their rule titles (Plan D may name them later).
        title: None,
        rows: None,
    })
}

/// The checked proposal of a diagram Ask: the file and hash it was written against, and
/// every change with its status.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagramProposal {
    /// The diagram's name, without `.flow`.
    pub file: String,
    pub base_hash: String,
    pub changes: Vec<ProposedChange>,
}

const TOOL_CHECK_RULE: &str = "Contura checks every change against the file before you see it.";

/// A drop reason as a log and Steps code.
fn reason_code(reason: DropReason) -> &'static str {
    match reason {
        DropReason::UnknownShape => "unknown_shape",
        DropReason::UnknownGroup => "unknown_group",
        DropReason::UnknownFlow => "unknown_flow",
        DropReason::NameTaken => "name_taken",
        DropReason::IdReused => "id_reused",
        DropReason::EmptyLabel => "empty_label",
        DropReason::BadName => "bad_name",
        DropReason::UnknownKind => "unknown_kind",
        DropReason::OutsideSelection => "outside_selection",
        DropReason::DependsOnDropped => "depends_on_dropped",
        DropReason::TooMany => "too_many",
        DropReason::UnknownFrame => "unknown_frame",
        DropReason::FrameTaken => "frame_taken",
        DropReason::TooManyFrames => "too_many_frames",
        DropReason::UnknownColumn => "unknown_column",
        DropReason::ColumnTaken => "column_taken",
        DropReason::NotAnErd => "not_an_erd",
    }
}

/// An op's kind as the tool names it.
fn op_kind(op: &DiagramOp) -> &'static str {
    match op {
        DiagramOp::AddNode { .. } => "add_node",
        DiagramOp::RemoveNode { .. } => "remove_node",
        DiagramOp::RenameNode { .. } => "rename_node",
        DiagramOp::AddFlow { .. } => "add_flow",
        DiagramOp::RemoveFlow { .. } => "remove_flow",
        DiagramOp::RelabelFlow { .. } => "relabel_flow",
        DiagramOp::MoveToGroup { .. } => "move_to_group",
        DiagramOp::AddFrame { .. } => "add_frame",
        DiagramOp::AddColumn { .. } => "add_column",
        DiagramOp::RemoveColumn { .. } => "remove_column",
        DiagramOp::SetColumn { .. } => "set_column",
    }
}

/// The file is gone, or another program changed it. `line` is the first line (1-based)
/// that differs between `before` and `after`, and `now_reads` its new text.
fn file_changed(file: &str, before: &str, after: Option<&str>) -> Error {
    let Some(after) = after else {
        return Error::Ai(AiError::file_changed(file, None, None));
    };
    let old: Vec<&str> = before.split('\n').collect();
    let new: Vec<&str> = after.split('\n').collect();
    // Same lines but other bytes between them (line endings): the first line that differs
    // in its ending, else the last.
    let at = (0..old.len().max(new.len()))
        .find(|&i| old.get(i) != new.get(i))
        .unwrap_or(new.len().saturating_sub(1));
    let now = new.get(at).map(|l| l.strip_suffix('\r').unwrap_or(l));
    let line = u32::try_from(at + 1).unwrap_or(u32::MAX);
    Error::Ai(AiError::file_changed(file, Some(line), now))
}

/// A failed read of the file before the Ask: a missing file is `FileChanged` with no line,
/// any other error (permission, bad UTF-8, I/O) stays its own.
fn read_failed(file: &str, e: Error) -> Error {
    match e {
        Error::NotFound(_) => file_changed(file, "", None),
        other => other,
    }
}

/// A Warn line of the tool step: an outcome and a reason code, nothing the model wrote.
fn tool_warn(log: &mut Log, outcome: &str, reason: &str) {
    log.push(
        Level::Warn,
        "tool",
        &[("outcome", outcome.into()), ("reason", reason.into())],
    );
}

/// The first call, through the execution rail and then against the text sent: the hash
/// and the file must be the ones the turn gave (`file` as the turn names it, or without
/// `.flow`). Returns the cleaned input and the model's JSON with invisible characters
/// stripped.
fn read_call(
    rail: &ExecutionRail,
    call: &ToolCallSeen,
    req: &DiagramAskRequest,
    log: &mut Log,
) -> Result<(ProposeInput, String)> {
    let input = rail.check_call(&call.name, &call.input, log)?;
    if input.base_hash != base_hash_of(&req.text) {
        tool_warn(log, "stop", "base_hash");
        return Err(Error::Ai(AiError::BadToolInput));
    }
    let (file, _) = strip_invisible(&req.file);
    if input.file != file && input.file != format!("{file}.flow") {
        tool_warn(log, "stop", "file");
        return Err(Error::Ai(AiError::BadToolInput));
    }
    let (json, _) = strip_invisible(&call.input);
    Ok((input, cap_chars(&json, INPUT_CAP).to_string()))
}

/// Checks the proposal against the outline, or on a board each change against its frame's
/// (R0.1): the `tool` line with the counts, one `tool.drop` line per dropped change (codes
/// only), and the Tool check row.
fn check_proposal(
    input: &ProposeInput,
    req: &DiagramAskRequest,
    log: &mut Log,
) -> (Vec<ProposedChange>, ProcessStep) {
    let changes = match &req.board {
        Some(board) => check_board(input, board),
        None => check(input, &req.outline, &req.scope),
    };
    let (mut ok, mut dropped, mut ambiguous) = (0usize, 0usize, 0usize);
    let mut evidence = Vec::with_capacity(changes.len());
    let mut drops = Vec::new();
    for c in &changes {
        let (code, verdict) = match &c.status {
            ChangeStatus::Ok => {
                ok += 1;
                ("ok", "kept")
            }
            ChangeStatus::Dropped { reason, .. } => {
                dropped += 1;
                drops.push((c.index, reason_code(*reason)));
                (reason_code(*reason), "dropped")
            }
            ChangeStatus::Ambiguous { .. } => {
                ambiguous += 1;
                ("ambiguous", "pick")
            }
        };
        evidence.push([
            format!("#{} {}", u64::from(c.index) + 1, op_kind(&c.op)),
            code.to_string(),
            verdict.to_string(),
        ]);
    }
    log.push(
        Level::Info,
        "tool",
        &[
            ("name", TOOL_NAME.into()),
            ("ops", changes.len().to_string()),
            ("ok", ok.to_string()),
            ("dropped", dropped.to_string()),
            ("ambiguous", ambiguous.to_string()),
        ],
    );
    for (index, reason) in drops {
        log.push(
            Level::Info,
            "tool.drop",
            &[("index", index.to_string()), ("reason", reason.into())],
        );
    }
    let mut value = format!(
        "{} proposed, {} dropped",
        grouped(changes.len() as u64),
        grouped(dropped as u64)
    );
    if ambiguous > 0 {
        value.push_str(&format!(", {} to pick", grouped(ambiguous as u64)));
    }
    let row = ProcessStep {
        evidence,
        ..step(log, StepKind::ToolCheck, value, TOOL_CHECK_RULE)
    };
    (changes, row)
}

/// A follow-up call (Decision 10): the `tool` line with the op count, and one `tool.drop` line
/// per op with `asked_first` (codes only).
fn asked_first(input: &ProposeInput, log: &mut Log) {
    log.push(
        Level::Info,
        "tool",
        &[
            ("name", TOOL_NAME.into()),
            ("ops", input.ops.len().to_string()),
            ("follow_up", "yes".into()),
        ],
    );
    for index in 0..input.ops.len() {
        log.push(
            Level::Info,
            "tool.drop",
            &[
                ("index", index.to_string()),
                ("reason", "asked_first".into()),
            ],
        );
    }
}

/// Reads the .flow file as saved. Async so a caller can do the read off the runtime.
pub type DiskRead<'a> =
    dyn Fn() -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> + Send + Sync + 'a;

/// `diagram_ask_stream` with the file the request's token names, from `slot` (Decision 15).
/// A token the slot no longer holds is refused `AttachmentGone` before anything is read,
/// built or sent. The file stays held while the Ask runs and after one that fails (network,
/// `TooBig`, `FileChanged`, Stop), so Retry sends it again; an Ask that ends well empties
/// the slot of that token only, never of a file picked meanwhile. An Ask answered with a
/// follow-up question keeps the file for its reply only (Task 18): the reply sends the same
/// text from memory, and a new question ends that hold.
#[allow(clippy::too_many_arguments)]
pub async fn diagram_ask_attached(
    provider: &dyn AiProvider,
    settings: &AiSettings,
    model: &ModelInfo,
    secrets: &Secrets,
    req: &DiagramAskRequest,
    standing: &SourceStanding,
    history: Option<&AiThread>,
    slot: &std::sync::Mutex<AttachmentSlot>,
    disk: &DiskRead<'_>,
    emit: &(dyn Fn(AiEvent) + Send + Sync),
) -> Result<()> {
    // A held board (or a bad name, or the tool off) is refused before the slot is looked
    // at: the file stays held for the next Ask, and the refusal says why it was held.
    let pump = Pump::new();
    let log = pump.log();
    let drew = match diagram_gate(settings, req, standing) {
        Ok(drew) => drew,
        Err(_) => {
            // A refused Ask ends a hold kept for a follow-up's reply: a refused reply gets no
            // other chance to send it, and a new question means the follow-up was left. A
            // fresh pick stays (Task 4b).
            if let Ok(mut s) = slot.lock() {
                s.end_reply_hold();
            }
            return diagram_ask_stream(
                provider, settings, model, secrets, req, standing, history, None, disk, emit,
            )
            .await;
        }
    };
    let token = req.board.as_ref().and_then(|b| b.attachment.as_deref());
    let reply = req.board.as_ref().is_some_and(|b| b.follow_up.is_some());
    let mut file_sent_before = false;
    let held = match slot.lock() {
        Ok(mut s) => {
            if !reply {
                s.end_reply_hold();
            }
            file_sent_before = token.is_some_and(|t| s.held_for_reply(t));
            attachment_for(&s, token, reply)
        }
        Err(_) => Err(Error::Ai(AiError::Internal)),
    };
    let gated = Gated {
        pump,
        log,
        drew,
        file_sent_before,
    };
    let attachment = match held {
        Ok(a) => a,
        Err(e) => return fail(e, false, emit),
    };
    let asked_back = std::sync::atomic::AtomicBool::new(false);
    let watch = |e: AiEvent| {
        if matches!(e, AiEvent::FollowUp { .. }) {
            asked_back.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        emit(e);
    };
    let result = ask_gated(
        provider,
        settings,
        model,
        secrets,
        req,
        standing,
        history,
        attachment.as_ref(),
        disk,
        &watch,
        gated,
    )
    .await;
    if result.is_ok()
        && let Some(token) = token
        && let Ok(mut s) = slot.lock()
    {
        if asked_back.load(std::sync::atomic::Ordering::Relaxed) {
            s.keep_for_reply(token);
        } else {
            s.take(token);
        }
    }
    result
}

/// Runs one diagram Ask and reports it through `emit`, ending with `Done` or `Error`, as
/// `ask_stream` does (the same log, Pump, sink, cap, retries, timeouts and Stop). `disk`
/// reads the .flow file as saved.
///
/// Before anything is sent the file name is checked and the file read (gone is
/// `FileChanged` with no line; any other read error is its own); the request is the preview's turn (R1.6) under the diagram
/// prompt, with `propose_diagram_changes` as its only tool. The model's first call goes
/// through the execution rail and must name the hash and the file the turn gave
/// (`BadToolInput` otherwise); a later call is dropped and never answered. The changes are
/// checked against the outline, and the file is read again: if it changed while the model
/// worked the Ask fails `FileChanged` with the first line that differs, and no proposal is
/// shown. An answer with no call ends with no `Proposal`. Nothing is ever sent back to the
/// model.
///
/// A call with `follow_up` asks first (Decision 10): its ops are ignored and logged
/// `tool.drop reason=asked_first`, no proposal is shown, the file is not read again, and the
/// question goes out as one `FollowUp` event. `history` and `attachment` go as the preview
/// sends them.
///
/// `diagram_gate` runs before the disk is read: a held board ends with one `DiagramHeld`
/// error and no request. The Sent record names the Connections the Ask drew on.
#[allow(clippy::too_many_arguments)]
pub async fn diagram_ask_stream(
    provider: &dyn AiProvider,
    settings: &AiSettings,
    model: &ModelInfo,
    secrets: &Secrets,
    req: &DiagramAskRequest,
    standing: &SourceStanding,
    history: Option<&AiThread>,
    attachment: Option<&Attachment>,
    disk: &DiskRead<'_>,
    emit: &(dyn Fn(AiEvent) + Send + Sync),
) -> Result<()> {
    let pump = Pump::new();
    let mut log = pump.log();
    // The name, the switch and the held check go first: nothing is read from disk or built
    // for a board the AI may not see.
    let drew = match diagram_gate(settings, req, standing) {
        Ok(drew) => drew,
        Err(e) => return fail_build(e, None, &mut log, &pump, emit),
    };
    let gated = Gated {
        pump,
        log,
        drew,
        file_sent_before: false,
    };
    ask_gated(
        provider, settings, model, secrets, req, standing, history, attachment, disk, emit, gated,
    )
    .await
}

/// What `diagram_gate` gave an Ask: its log, and the Connections it draws on.
struct Gated {
    pump: Pump,
    log: Log,
    drew: Vec<ConnectionId>,
    /// The attachment went already, with the Ask whose follow-up this reply answers: the
    /// reply's record names it instead of keeping its text a second time.
    file_sent_before: bool,
}

/// The exact text a reply's record keeps: the attachment's line names the file the earlier
/// turn sent (its record holds the text), so the thread keeps the file's text once. The
/// Sent record's bytes and hash stay those of what went.
fn exact_for_record(exact: &str, again: Option<&Attachment>) -> String {
    let Some(a) = again else {
        return exact.to_string();
    };
    const PREFIX: &str = r#"{"source":"attachment","text":"#;
    let name = one_line(&strip_invisible(&a.name).0);
    let named = serde_json::json!({
        "source": "attachment",
        "text": format!("[the same file as in the earlier turn: {name}]"),
    })
    .to_string();
    exact
        .split('\n')
        .map(|line| {
            if line.starts_with(PREFIX) {
                named.as_str()
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `diagram_ask_stream` once `diagram_gate` has passed.
#[allow(clippy::too_many_arguments)]
async fn ask_gated(
    provider: &dyn AiProvider,
    settings: &AiSettings,
    model: &ModelInfo,
    secrets: &Secrets,
    req: &DiagramAskRequest,
    standing: &SourceStanding,
    history: Option<&AiThread>,
    attachment: Option<&Attachment>,
    disk: &DiskRead<'_>,
    emit: &(dyn Fn(AiEvent) + Send + Sync),
    gated: Gated,
) -> Result<()> {
    let Gated {
        pump,
        mut log,
        drew,
        file_sent_before,
    } = gated;
    let started = Instant::now();
    let Some(kind) = settings.provider else {
        return fail(Error::Ai(AiError::NotConfigured), false, emit);
    };
    // The file as saved before the model sees it: the end of the Ask compares against it.
    let before = match disk().await {
        Ok(text) => text,
        Err(e) => return fail_build(read_failed(&req.file, e), None, &mut log, &pump, emit),
    };
    let preview = match build_preview(
        settings, model, secrets, req, standing, history, attachment, &mut log,
    ) {
        Ok(p) => p,
        Err(e) => return fail_build(e, None, &mut log, &pump, emit),
    };
    pump.drain(emit);
    for step in &preview.steps {
        emit(AiEvent::Process(step.clone()));
    }

    let picks = clamp(model, req.picks.unwrap_or(model.picks));
    let max_tokens = settings.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS);
    let cache_mark = model.caching == CachingKind::Breakpoints && picks.caching;
    // The outline the preview was built from names the diagram kind and its shape kinds; a
    // board's prompt names the kinds on the board and carries their grammar card.
    let system = system_prompt(req);
    let chat = ChatRequest {
        model: model.id.clone(),
        // Mark 1 after the system prompt; the turn changes with every Ask.
        system: vec![PromptBlock {
            text: system.clone(),
            cache_mark,
        }],
        // One message: the history, when any, goes framed inside the turn.
        messages: vec![ChatMessage {
            role: ChatRole::User,
            text: preview.parts.turn.clone(),
        }],
        max_tokens,
        temperature: settings.temperature.filter(|_| model.temperature),
        thinking: wire_thinking(model, picks.thinking, settings.share_thinking),
        max_tokens_field: model.max_tokens_field,
        // R0.1: the one tool, and nothing else.
        tools: tool_for(ToolsAllowed::DiagramTool),
    };
    // A refused call's name reaches only the error, cleaned with the saved secrets.
    let execution = ExecutionRail {
        allowed: ToolsAllowed::DiagramTool,
        secrets: long_secrets(secrets),
    };
    if let Err(e) = execution.check_request(&chat, &mut log) {
        return fail_build(e, None, &mut log, &pump, emit);
    }
    let tokens = preview
        .tokens
        .saturating_add(estimate_tokens(&system, false))
        .saturating_add(tool_text(&chat).map_or(0, |t| estimate_tokens(&t, false)));
    let wire_max_tokens = max_tokens_on_wire(kind, max_tokens, &chat.thinking);
    let needed = tokens.saturating_add(wire_max_tokens);
    if needed > model.context_window {
        let too_big = Error::Ai(AiError::TooBig {
            needed,
            window: model.context_window,
            model: model.name.clone(),
        });
        return fail_build(too_big, None, &mut log, &pump, emit);
    }
    emit(AiEvent::Status {
        step: "Writing".into(),
    });
    let texts = provider.wire_texts(&chat);
    let wire: Vec<&[u8]> = texts.iter().map(|t| t.as_bytes()).collect();
    let sent_bytes = u32::try_from(wire.iter().map(|b| b.len()).sum::<usize>()).unwrap_or(u32::MAX);
    let hash = format!("{:016x}", fnv1a64_parts(&wire));
    let base = settings
        .effective_base_url()
        .and_then(|base| url::Url::parse(base).ok());
    let host = base.as_ref().map(host_of).unwrap_or_default();
    request_line(
        &mut log,
        kind,
        model,
        &host,
        (sent_bytes, tokens),
        &chat,
        picks,
    );
    pump.drain(emit);
    emit(AiEvent::Memory {
        stamp: preview.stamp.clone(),
    });
    let mut kinds: Vec<ItemKind> = Vec::new();
    for i in preview.items.iter().filter(|i| i.on) {
        if !kinds.contains(&i.kind) {
            kinds.push(i.kind);
        }
    }
    emit(AiEvent::Sent(SentRecord {
        at: now_ms(),
        kinds,
        bytes: sent_bytes,
        tokens,
        provider: kind,
        model: model.id.clone(),
        model_name: model.name.clone(),
        host,
        hash,
        exact: settings
            .keep_exact_text
            .then(|| exact_for_record(&preview.exact, attachment.filter(|_| file_sent_before))),
        sources: drew,
        ..SentRecord::default()
    }));
    emit(AiEvent::Process(request_step(
        log.elapsed_ms(),
        sent_bytes,
        None,
        base.as_ref(),
        ToolsAllowed::DiagramTool,
    )));

    let (result, mut a) =
        stream_answer(provider, &chat, settings, secrets, &mut log, &pump, emit).await;
    let failed = result.is_err() && !a.capped;
    let Ended {
        usage,
        stop,
        partial,
        received,
    } = end_answer(&a, failed, settings, &mut log, &pump, emit);
    answer_row(
        &a,
        usage,
        (partial, received),
        count_of(a.calls_seen, "tool call", "tool calls"),
        &log,
        emit,
    );
    if let Err(e) = result
        && failed
    {
        let partial = a.bytes > 0;
        let line = error_line(&e, partial);
        return fail_logged(e, line, partial, None, &mut log, &pump, emit);
    }

    // Only the first call is read; the rest are dropped and never answered.
    let calls = std::mem::take(&mut a.calls);
    let first = calls
        .first()
        .map(|c| read_call(&execution, c, req, &mut log));
    for _ in 1..a.calls_seen.min(TOOL_CALLS) {
        tool_warn(&mut log, "dropped", "second_call");
    }
    if a.calls_seen > TOOL_CALLS {
        log.push(
            Level::Warn,
            "tool",
            &[
                ("outcome", "dropped".into()),
                ("reason", "over_limit".into()),
                ("calls", (a.calls_seen - TOOL_CALLS).to_string()),
            ],
        );
    }
    let mut follow_up = None;
    let proposal = match first {
        None => None,
        Some(Err(e)) => {
            let line = error_line(&e, false);
            return fail_logged(e, line, false, None, &mut log, &pump, emit);
        }
        Some(Ok((input, _))) if input.follow_up.is_some() => {
            asked_first(&input, &mut log);
            follow_up = input
                .follow_up
                .map(|f| redact_secrets(&f.question, secrets).0);
            None
        }
        Some(Ok((input, json))) => {
            let (changes, row) = check_proposal(&input, req, &mut log);
            pump.drain(emit);
            emit(AiEvent::Process(row));
            // P4: the changes are written against the text as it was; a file another
            // program changed meanwhile gets none of them.
            let after = match disk().await {
                Ok(text) => Some(text),
                Err(Error::NotFound(_)) => None,
                Err(e) => {
                    let line = error_line(&e, false);
                    return fail_logged(e, line, false, None, &mut log, &pump, emit);
                }
            };
            if after.as_deref().map(base_hash_of) != Some(base_hash_of(&before)) {
                let e = file_changed(&req.file, &before, after.as_deref());
                let line = error_line(&e, false);
                return fail_logged(e, line, false, None, &mut log, &pump, emit);
            }
            Some((
                DiagramProposal {
                    file: req.file.clone(),
                    base_hash: input.base_hash,
                    changes,
                },
                json,
            ))
        }
    };
    database_line(&mut log, None);
    pump.drain(emit);
    if let Some((proposal, input)) = proposal {
        emit(AiEvent::Proposal { proposal, input });
    }
    if let Some(question) = follow_up {
        emit(AiEvent::FollowUp { question });
    }
    emit(AiEvent::Done {
        usage: a.usage,
        stop,
        sent_bytes,
        model: model.id.clone(),
        provider: kind,
        millis: u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX),
        notes: preview.notes,
        sql_blocks: Vec::new(),
        max_tokens: wire_max_tokens,
    });
    Ok(())
}

#[cfg(test)]
mod held_tests {
    use super::*;
    use crate::model::ConnectionId;

    fn id(n: u128) -> ConnectionId {
        uuid::Uuid::from_u128(n)
    }

    fn src(frame: &str, conn: ConnectionId, database: &str) -> FrameSourceIn {
        FrameSourceIn {
            frame: frame.into(),
            connection_id: conn,
            database: database.into(),
            schema: None,
        }
    }

    fn link(node: &str, table: &str) -> TableLinkIn {
        TableLinkIn {
            frame: None,
            node: node.into(),
            table: table.into(),
        }
    }

    /// Connection 1 "prod" at Never, 2 "staging" at Schema on another Group's provider,
    /// 3 "dev" at Schema on this provider, 4 "both" at Never on another provider.
    fn standing() -> SourceStanding {
        SourceStanding {
            connections: vec![
                (id(1), "prod".into(), AiAccess::Never),
                (id(2), "staging".into(), AiAccess::Schema),
                (id(3), "dev".into(), AiAccess::Schema),
                (id(4), "both".into(), AiAccess::Never),
            ],
            same_provider: vec![id(1), id(3)],
            owners: Vec::new(),
        }
    }

    #[test]
    fn never_holds_the_ask_and_names_the_connection_and_frame() {
        assert_eq!(
            held_sources(&[src("Orders ERD", id(1), "shop")], &[], &standing()).as_deref(),
            Some(
                "The frame \"Orders ERD\" was drawn from prod, whose AI access is Never, so this Ask was not sent. Remove the frame or change that Connection's AI access."
            )
        );
    }

    #[test]
    fn a_missing_connection_holds_the_ask() {
        assert_eq!(
            held_sources(&[src("Orders ERD", id(9), "shop")], &[], &standing()).as_deref(),
            Some(
                "The frame \"Orders ERD\" was drawn from a Connection that no longer exists (database shop), so this Ask was not sent. Remove the frame to ask about this board."
            )
        );
    }

    #[test]
    fn another_groups_provider_holds_the_ask() {
        assert_eq!(
            held_sources(&[src("Ledger", id(2), "ledger")], &[], &standing()).as_deref(),
            Some(
                "The frame \"Ledger\" was drawn from staging, which uses another Group's AI provider, so this Ask was not sent. Remove the frame to ask about this board."
            )
        );
    }

    #[test]
    fn never_wins_over_another_provider() {
        let got = held_sources(&[src("F", id(4), "x")], &[], &standing()).unwrap();
        assert!(got.contains("both, whose AI access is Never"), "{got}");
    }

    #[test]
    fn a_table_link_to_a_never_connection_holds_the_ask() {
        let mut s = standing();
        s.owners = vec![("shop.orders".into(), vec![id(1)])];
        assert_eq!(
            held_sources(&[], &[link("Orders", "shop.orders")], &s).as_deref(),
            Some(
                "The node \"Orders\" links to table shop.orders of prod, whose AI access is Never, so this Ask was not sent. Remove the link or change that Connection's AI access."
            )
        );
    }

    #[test]
    fn the_same_node_without_the_link_passes() {
        let mut s = standing();
        s.owners = vec![("shop.orders".into(), vec![id(1)])];
        assert_eq!(held_sources(&[], &[], &s), None);
    }

    #[test]
    fn a_table_link_on_another_groups_provider_holds_the_ask() {
        let mut s = standing();
        s.owners = vec![("ledger.entries".into(), vec![id(2)])];
        assert_eq!(
            held_sources(&[], &[link("Entries", "ledger.entries")], &s).as_deref(),
            Some(
                "The node \"Entries\" links to table ledger.entries of staging, which uses another Group's AI provider, so this Ask was not sent. Remove the link to ask about this board."
            )
        );
    }

    #[test]
    fn a_table_no_connection_owns_is_not_held() {
        let mut s = standing();
        s.owners = vec![("shop.orders".into(), Vec::new())];
        assert_eq!(held_sources(&[], &[link("X", "shop.orders")], &s), None);
        assert_eq!(held_sources(&[], &[link("X", "nowhere.t")], &s), None);
    }

    #[test]
    fn a_value_owned_by_two_connections_is_held_when_either_is() {
        let mut s = standing();
        s.owners = vec![("shop.orders".into(), vec![id(3), id(1)])];
        let got = held_sources(&[], &[link("Orders", "shop.orders")], &s).unwrap();
        assert!(got.contains("of prod, whose AI access is Never"), "{got}");
        s.owners = vec![("shop.orders".into(), vec![id(3)])];
        assert_eq!(
            held_sources(&[], &[link("Orders", "shop.orders")], &s),
            None
        );
    }

    #[test]
    fn schema_query_and_sample_rows_pass() {
        let s = SourceStanding {
            connections: vec![
                (id(1), "a".into(), AiAccess::Schema),
                (id(2), "b".into(), AiAccess::SchemaQuery),
                (id(3), "c".into(), AiAccess::SchemaQueryRows),
            ],
            same_provider: vec![id(1), id(2), id(3)],
            owners: vec![("t".into(), vec![id(1), id(2), id(3)])],
        };
        let sources = [
            src("A", id(1), "x"),
            src("B", id(2), "x"),
            src("C", id(3), "x"),
        ];
        assert_eq!(held_sources(&sources, &[link("N", "t")], &s), None);
    }

    #[test]
    fn no_sources_is_not_gated() {
        assert_eq!(held_sources(&[], &[], &SourceStanding::default()), None);
        // A hand-typed table no Connection is known to hold is not gated either.
        assert_eq!(
            held_sources(&[], &[link("N", "shop.orders")], &SourceStanding::default()),
            None
        );
    }

    #[test]
    fn the_first_held_source_in_order_is_named() {
        let sources = [
            src("Fine", id(3), "x"),
            src("Second", id(2), "x"),
            src("Third", id(1), "x"),
        ];
        let mut s = standing();
        s.owners = vec![("t".into(), vec![id(1)])];
        let got = held_sources(&sources, &[link("N", "t")], &s).unwrap();
        assert!(
            got.starts_with("The frame \"Second\" was drawn from staging"),
            "{got}"
        );
    }

    #[test]
    fn names_are_cleaned_and_cut() {
        let long = "n".repeat(61);
        let s = SourceStanding {
            connections: vec![(id(1), format!("pro\nd{}", "\u{200b}"), AiAccess::Never)],
            same_provider: vec![id(1)],
            owners: Vec::new(),
        };
        let got = held_sources(&[src(&long, id(1), "shop")], &[], &s).unwrap();
        assert!(
            got.starts_with(&format!(
                "The frame \"{}\" was drawn from prod,",
                "n".repeat(60)
            )),
            "{got}"
        );
        let s = SourceStanding {
            connections: vec![(id(1), "c".repeat(61), AiAccess::Never)],
            ..s
        };
        let got = held_sources(&[src("F", id(1), "shop")], &[], &s).unwrap();
        assert!(
            got.contains(&format!("drawn from {}, whose", "c".repeat(60))),
            "{got}"
        );
        let got = held_sources(&[src("F", id(7), &"d".repeat(61))], &[], &s).unwrap();
        assert!(
            got.contains(&format!("(database {})", "d".repeat(60))),
            "{got}"
        );
    }

    #[test]
    fn a_link_list_over_its_cap_is_refused() {
        let mut req: DiagramAskRequest = serde_json::from_value(serde_json::json!({
            "requestId": "r", "file": "f", "text": "diagram flow\n", "question": "q",
            "outline": {"kind": null, "kinds": [], "nodes": [], "groups": [], "links": []},
            "scope": {"kind": "whole"}, "threadId": null
        }))
        .unwrap();
        assert!(req.sources.is_empty() && req.table_links.is_empty());
        req.table_links = (0..=MAX_TABLE_LINKS)
            .map(|i| link(&format!("n{i}"), "t"))
            .collect();
        match table_links_of(&req) {
            Err(Error::InvalidInput(m)) => assert_eq!(
                m,
                "This board lists more than 500 table links, so this Ask was not sent. Remove some table: links and ask again."
            ),
            other => panic!("{other:?}"),
        }
        req.table_links.truncate(MAX_TABLE_LINKS);
        assert_eq!(table_links_of(&req).unwrap().len(), MAX_TABLE_LINKS);
    }

    #[test]
    fn a_hostile_text_is_refused_at_the_cap_and_fast() {
        let mut req: DiagramAskRequest = serde_json::from_value(serde_json::json!({
            "requestId": "r", "file": "f", "text": "diagram flow\n", "question": "q",
            "outline": {"kind": null, "kinds": [], "nodes": [], "groups": [], "links": []},
            "scope": {"kind": "whole"}, "threadId": null
        }))
        .unwrap();
        req.text = (0..100_000).fold(String::from("diagram flow\n"), |mut t, i| {
            t.push_str(&format!("N{i} [table: t{i}]\n"));
            t
        });
        let start = std::time::Instant::now();
        assert!(matches!(table_values(&req), Err(Error::InvalidInput(_))));
        // Exactly at the cap still passes.
        req.text = (0..MAX_TABLE_LINKS).fold(String::from("diagram flow\n"), |mut t, i| {
            t.push_str(&format!("N{i} [table: t{i}]\n"));
            t
        });
        assert_eq!(table_values(&req).unwrap().len(), MAX_TABLE_LINKS);
        assert!(start.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn the_core_reads_table_links_from_the_text_itself() {
        // A link the webview did not list still holds the Ask: the Core reads every
        // `table:` in the text it sends.
        let req: DiagramAskRequest = serde_json::from_value(serde_json::json!({
            "requestId": "r", "file": "f",
            "text": "diagram flow \"A\"\nOrders [table: shop.orders]\n\ndiagram flow \"B\"\nX\n",
            "question": "q",
            "outline": {"kind": null, "kinds": [], "nodes": [], "groups": [], "links": []},
            "scope": {"kind": "whole"}, "threadId": null,
            "tableLinks": [{"frame": "B", "node": "X", "table": "other.x"}]
        }))
        .unwrap();
        let links = table_links_of(&req).unwrap();
        assert_eq!(
            links,
            vec![
                TableLinkIn {
                    frame: Some("A".into()),
                    node: "Orders".into(),
                    table: "shop.orders".into()
                },
                TableLinkIn {
                    frame: Some("B".into()),
                    node: "X".into(),
                    table: "other.x".into()
                },
            ]
        );
        assert_eq!(
            table_values(&req).unwrap(),
            vec!["shop.orders".to_string(), "other.x".to_string()]
        );
    }

    fn config(n: u128, name: &str, database: Option<&str>) -> crate::model::ConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "id": id(n), "name": name, "dialect": "mysql", "host": "h", "port": 3306, "user": "u",
            "database": database, "ssl": {"mode": "disable"}, "groupId": null
        }))
        .unwrap()
    }

    fn key(n: u128, database: &str, schema: &str) -> ContextKey {
        ContextKey {
            connection_id: id(n),
            database: database.into(),
            schema: schema.into(),
        }
    }

    #[test]
    fn owners_come_from_saved_contexts_and_configured_databases() {
        let contexts = vec![
            (
                key(1, "shop", ""),
                vec!["orders".to_string(), "Stock".to_string()],
            ),
            (key(2, "ledger", "public"), vec!["entries".to_string()]),
            (key(3, "shop", ""), vec!["orders".to_string()]),
        ];
        // Connection 4 has nothing saved (a Never Connection keeps no Context) but its own
        // database is `crm`: a qualified value in it is its own.
        let connections = vec![
            config(1, "a", None),
            config(2, "b", None),
            config(3, "c", None),
            config(4, "d", Some("crm")),
        ];
        let values: Vec<String> = [
            "shop.orders",
            "orders",
            "\"shop\".\"stock\"",
            "public.entries",
            "ledger.public.entries",
            "ledger.other.entries",
            "crm.leads",
            "leads",
            "nowhere.t",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let owners = table_owners(&values, &connections, &contexts);
        let of = |v: &str| {
            owners
                .iter()
                .find(|(k, _)| k == v)
                .map(|(_, o)| o.clone())
                .unwrap()
        };
        assert_eq!(of("shop.orders"), vec![id(1), id(3)]);
        assert_eq!(of("orders"), vec![id(1), id(3)]);
        assert_eq!(of("\"shop\".\"stock\""), vec![id(1)]);
        assert_eq!(of("public.entries"), vec![id(2)]);
        assert_eq!(of("ledger.public.entries"), vec![id(2)]);
        assert_eq!(of("ledger.other.entries"), Vec::<ConnectionId>::new());
        assert_eq!(of("crm.leads"), vec![id(4)]);
        assert_eq!(of("leads"), Vec::<ConnectionId>::new());
        assert_eq!(of("nowhere.t"), Vec::<ConnectionId>::new());
    }
}
