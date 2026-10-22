//! The diagram Ask (step 11h): what the webview sends from a diagram tab, the preview of
//! what it would send, and the Ask itself. A diagram is not database data, so no AI access
//! level applies and no Connection is read; its .flow text still goes through the input
//! rail (R2.1, R2.2) and is framed (R3.1) like any outgoing text. The Ask carries one
//! tool, checks the model's one call against the outline, and shows the proposal only if
//! the file on disk did not change while the model worked.

use std::future::Future;
use std::pin::Pin;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::ai::budget::{PAYLOAD_CAP, TableFit, estimate_tokens};
use crate::ai::diagram_tool::{
    ChangeStatus, DiagramOp, DiagramScope, DropReason, FlowOutline, INPUT_CAP, ProposeInput,
    ProposedChange, TOOL_NAME, base_hash_of, check,
};
use crate::ai::log::{Level, Log, ProcessStep, StepKind};
use crate::ai::memory::TurnStamp;
use crate::ai::models::{CachingKind, ModelInfo, ModelPicks, clamp};
use crate::ai::preview::{Preview, PreviewItem, PromptParts, count_of, long_secrets};
use crate::ai::prompt::diagram_prompt;
use crate::ai::provider::url::host_of;
use crate::ai::provider::{
    AiProvider, ChatMessage, ChatRequest, ChatRole, PromptBlock, max_tokens_on_wire, tool_text,
    wire_thinking,
};
use crate::ai::rails::execution::{ExecutionRail, ToolsAllowed, tool_for};
use crate::ai::rails::retrieval::selection_label;
use crate::ai::rails::{
    Ask, InputRail, RetrievalRail, Secrets, cap_chars, framed_block, new_boundary, run_rails,
    strip_invisible,
};
use crate::ai::request::{Item, ItemKind};
use crate::ai::sent::{SentRecord, fnv1a64_parts};
use crate::ai::stream::{
    AiEvent, DEFAULT_MAX_TOKENS, Ended, Pump, TOOL_CALLS, ToolCallSeen, answer_row, database_line,
    end_answer, error_line, fail, fail_build, fail_logged, request_line, request_step,
    stream_answer,
};
use crate::ai::{AiAccess, AiError, AiSettings, ThreadId, now_ms};
use crate::common::grouped;
use crate::error::{Error, Result};

/// The most shapes, or lines, a diagram Ask takes.
pub const MAX_SHAPES: usize = 5_000;

/// Why the diagram rows of Sends cannot be switched off.
pub const DIAGRAM_LOCK: &str = "The changes are written against this text";
const DIAGRAM_RULE: &str = "Diagrams are not database data: no AI access level applies.";
const CLEANING_RULE: &str = "Secrets are always replaced. Hidden characters are removed.";

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
pub fn diagram_preview(
    settings: &AiSettings,
    _model: &ModelInfo,
    secrets: &Secrets,
    req: &DiagramAskRequest,
    log: &mut Log,
) -> Result<Preview> {
    check_file_name(&req.file)?;
    if !settings.diagram_tool {
        return Err(Error::Ai(AiError::ToolOff));
    }
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
    if nodes > MAX_SHAPES || links > MAX_SHAPES {
        return Err(Error::Ai(AiError::TooLarge));
    }
    // The file name is the user's own; only invisible characters go.
    let (file, _) = strip_invisible(&req.file);
    let label = format!("{file}.flow");

    let mut items = vec![
        new_item(ItemKind::Question, "Question".into(), req.question.clone()),
        new_item(ItemKind::Diagram, label.clone(), req.text.clone()),
    ];
    if let DiagramScope::Selection { names } = &req.scope {
        items.push(new_item(
            ItemKind::Diagram,
            selection_label(names.len()),
            names.join("\n"),
        ));
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

    let sent_text = ask
        .items
        .iter()
        .find(|i| i.kind == ItemKind::Diagram)
        .map_or(0, |i| i.text.len());
    let secrets_found = input.secrets_found();
    let steps = vec![
        step(
            log,
            StepKind::Diagram,
            format!("{label}, {} B", grouped(sent_text as u64)),
            DIAGRAM_RULE,
        ),
        ProcessStep {
            evidence: std::mem::take(&mut ask.cleaned),
            ..step(
                log,
                StepKind::Cleaning,
                count_of(secrets_found, "secret", "secrets"),
                CLEANING_RULE,
            )
        },
    ];

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
        .map(|i| PreviewItem {
            bytes: u32::try_from(i.text.len()).unwrap_or(u32::MAX),
            tokens: estimate_tokens(&i.text, i.kind == ItemKind::Question),
            locked: (i.kind == ItemKind::Diagram).then(|| DIAGRAM_LOCK.to_string()),
            on: true,
            kind: i.kind,
            label: i.label,
        })
        .collect();
    let stamp = TurnStamp {
        topic: 0,
        opened: false,
        reason: None,
        title: String::new(),
        connection_id: None,
        database: None,
        action: "diagram".into(),
        tables: Vec::new(),
        kinds: vec![ItemKind::Question, ItemKind::Diagram],
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

/// Checks the proposal against the outline (R0.1): the `tool` line with the counts, one
/// `tool.drop` line per dropped change (codes only), and the Tool check row.
fn check_proposal(
    input: &ProposeInput,
    req: &DiagramAskRequest,
    log: &mut Log,
) -> (Vec<ProposedChange>, ProcessStep) {
    let changes = check(input, &req.outline, &req.scope);
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

/// Reads the .flow file as saved. Async so a caller can do the read off the runtime.
pub type DiskRead<'a> =
    dyn Fn() -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> + Send + Sync + 'a;

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
pub async fn diagram_ask_stream(
    provider: &dyn AiProvider,
    settings: &AiSettings,
    model: &ModelInfo,
    secrets: &Secrets,
    req: &DiagramAskRequest,
    disk: &DiskRead<'_>,
    emit: &(dyn Fn(AiEvent) + Send + Sync),
) -> Result<()> {
    let pump = Pump::new();
    let mut log = pump.log();
    if let Err(e) = check_file_name(&req.file) {
        return fail_build(e, None, &mut log, &pump, emit);
    }
    let started = Instant::now();
    let Some(kind) = settings.provider else {
        return fail(Error::Ai(AiError::NotConfigured), false, emit);
    };
    // The file as saved before the model sees it: the end of the Ask compares against it.
    let before = match disk().await {
        Ok(text) => text,
        Err(e) => return fail_build(read_failed(&req.file, e), None, &mut log, &pump, emit),
    };
    let preview = match diagram_preview(settings, model, secrets, req, &mut log) {
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
    // The outline the preview was built from names the diagram kind and its shape kinds.
    let system = diagram_prompt(req.outline.kind.as_deref(), &req.outline.kinds);
    let chat = ChatRequest {
        model: model.id.clone(),
        // Mark 1 after the system prompt; the turn changes with every Ask.
        system: vec![PromptBlock {
            text: system.clone(),
            cache_mark,
        }],
        // No history: each Ask sends only the current text.
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
        exact: settings.keep_exact_text.then(|| preview.exact.clone()),
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
    let proposal = match first {
        None => None,
        Some(Err(e)) => {
            let line = error_line(&e, false);
            return fail_logged(e, line, false, None, &mut log, &pump, emit);
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
