//! One streamed Ask: the system prompt and the preview's schema block as the cached prefix,
//! the thread's recent turns and then the preview's turn as the messages, the provider's
//! events turned into the events the webview shows.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::Notify;

use crate::ai::budget::estimate_tokens;
use crate::ai::compact::{self, CompactPlan, Plan, TopicPlan, Wrote};
use crate::ai::context::outline::{
    OUTLINE_REPLY_TOKENS, OutlineRequest, PickReply, REPLY_CAP_BYTES, TablePicker,
};
use crate::ai::context::sync::{ContextInfo, Purpose};
use crate::ai::diagram::DiagramProposal;
use crate::ai::log::{Level, Log, LogLine, ProcessStep, StepKind, error_kind};
use crate::ai::memory::{Compaction, SummaryBy, TurnStamp};
use crate::ai::models::{CachingKind, ModelInfo, ModelPicks, ThinkingLevel, clamp};
use crate::ai::preview::{
    CatalogReader, Gathered, Preview, Recall, assemble_with, check_continue, count_of, gather,
    memory_line, precheck_continue, recall,
};
use crate::ai::prompt::system_prompt;
use crate::ai::provider::url::host_of;
use crate::ai::provider::{
    AiProvider, ChatMessage, ChatRequest, ChatRole, PromptBlock, ProviderEvent, StopReason, Usage,
    max_tokens_on_wire, wire_thinking,
};
use crate::ai::rails::execution::{ExecutionRail, ToolsAllowed, tool_for};
use crate::ai::rails::output::{SqlBlock, check_answer_with, check_summary};
use crate::ai::rails::{Secrets, cap_chars, redact_secrets};
use crate::ai::request::{AskRequest, ItemKind};
use crate::ai::sent::{
    CallKind, OutlineSent, RowsSent, SentRecord, SummarySent, THINKING_CAP, fnv1a64_parts,
};
use crate::ai::{AiError, AiProviderKind, AiRole, AiSettings, AiThread, now_ms};
use crate::common::grouped;
use crate::error::{Error, Result};

/// At most one `Delta` per this long.
const DELTA_EVERY: Duration = Duration::from_millis(50);
/// R4.2: an answer over this many bytes of text is stopped.
const ANSWER_CAP: usize = 64 * 1024;
/// R4.1: `max_tokens` when the settings leave it unset.
pub(crate) const DEFAULT_MAX_TOKENS: u32 = 4096;

/// One event of a streamed Ask, in order. The last one is `Done` or `Error`.
// Events live only until the channel has sent them; boxing the Sent record would only
// move the size to the heap for every Ask.
#[allow(clippy::large_enum_variant)]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiEvent {
    Log(LogLine),
    /// The Sent record, once the request is built and before the first attempt. An outline
    /// call that left sends one first (`bytes` 0, only the outline); each Sent replaces the
    /// one before.
    Sent(SentRecord),
    /// One Steps row, as it completes.
    Process(ProcessStep),
    /// The Ask's memory stamp, right before the main `Sent`: the UI stores it on both
    /// messages of the turn.
    Memory {
        stamp: TurnStamp,
    },
    /// The thread was compacted before the request (at 85% of the window, or by Compact
    /// now): its hidden messages and its summary, before the main `Sent`.
    Compacted {
        compaction: Box<Compaction>,
    },
    /// The AI Context the Ask used, right after the Schema row; only when the schema was
    /// asked for.
    Context {
        info: ContextInfo,
    },
    Status {
        step: String,
    },
    Thinking {
        text: String,
    },
    /// The whole thinking kept, redacted again over the joined chunks once the stream
    /// ends: it replaces what the `Thinking` chunks built up.
    ThinkingKept {
        text: String,
    },
    Delta {
        text: String,
    },
    /// A diagram Ask's checked proposal, after the answer text and before `Done`, with the
    /// model's input (invisible characters stripped, at most 64 KB) for the answer record.
    Proposal {
        proposal: DiagramProposal,
        input: String,
    },
    #[serde(rename_all = "camelCase")]
    Done {
        usage: Option<Usage>,
        stop: StopReason,
        sent_bytes: u32,
        model: String,
        provider: AiProviderKind,
        millis: u32,
        notes: Vec<String>,
        sql_blocks: Vec<SqlBlock>,
        /// The `max_tokens` the request carried on the wire: Max tokens (or
        /// `DEFAULT_MAX_TOKENS`), raised by an Anthropic thinking budget. A length stop
        /// without usage stopped here.
        max_tokens: u32,
    },
    /// `partial` when some answer text was already sent.
    Error {
        error: AiError,
        partial: bool,
    },
}

/// Buffers answer text so the webview gets at most one `Delta` per 50 ms.
#[derive(Default)]
pub struct Coalescer {
    buf: String,
    last: Option<Instant>,
}

impl Coalescer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds `text`; a `Delta` with everything buffered once 50 ms have passed since the last.
    pub fn push(&mut self, text: &str, now: Instant) -> Option<AiEvent> {
        self.buf.push_str(text);
        self.due(now)
    }

    /// The buffered text when 50 ms have passed since the last `Delta`.
    pub fn due(&mut self, now: Instant) -> Option<AiEvent> {
        match self.last {
            Some(last) if now.duration_since(last) < DELTA_EVERY => None,
            _ => self.flush(now),
        }
    }

    /// Everything buffered, whatever the time: before any other event and at the end.
    pub fn flush(&mut self, now: Instant) -> Option<AiEvent> {
        if self.buf.is_empty() {
            return None;
        }
        self.last = Some(now);
        Some(AiEvent::Delta {
            text: std::mem::take(&mut self.buf),
        })
    }
}

/// What the stream has seen so far; shared by the provider's sink and the flush timer.
#[derive(Default)]
pub(crate) struct Answer {
    coalescer: Coalescer,
    /// The answer text kept, for the output rail.
    pub(crate) text: String,
    /// Bytes of answer text kept.
    pub(crate) bytes: usize,
    pub(crate) chars: usize,
    pub(crate) usage: Option<Usage>,
    stop: Option<StopReason>,
    pub(crate) capped: bool,
    /// Thinking kept, up to 64 KB.
    thinking: String,
    thinking_bytes: usize,
    thinking_chars: usize,
    /// When the last thinking came, in log time.
    thinking_at: u64,
    /// The tool calls the model made, the first `TOOL_CALLS`, checked by the Ask once the
    /// stream ends (the log is the provider's while it streams). Never answered.
    pub(crate) calls: Vec<ToolCallSeen>,
    /// Every tool call the model made, kept or not.
    pub(crate) calls_seen: usize,
}

/// A tool call as the provider sent it, before any rail has read it.
pub(crate) struct ToolCallSeen {
    pub(crate) name: String,
    pub(crate) input: String,
}

/// The most tool calls one Ask keeps and logs.
pub(crate) const TOOL_CALLS: usize = 8;

impl Answer {
    /// Keeps `text` up to the 64 KB cap; true once the cap is reached.
    fn take(&mut self, text: &str, emit: &(dyn Fn(AiEvent) + Send + Sync)) -> bool {
        let room = ANSWER_CAP - self.bytes;
        let kept = if text.len() > room {
            self.capped = true;
            let mut end = room;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            &text[..end]
        } else {
            text
        };
        self.bytes += kept.len();
        self.chars += kept.chars().count();
        self.text.push_str(kept);
        if let Some(e) = self.coalescer.push(kept, Instant::now()) {
            emit(e);
        }
        self.capped
    }

    /// The part of `text` kept within the 64 KB of thinking; `None` once that is full.
    fn think(&mut self, text: &str, clock: Instant) -> Option<String> {
        let kept = cap_chars(text, THINKING_CAP - self.thinking_bytes);
        if kept.is_empty() {
            return None;
        }
        self.thinking.push_str(kept);
        self.thinking_bytes += kept.len();
        self.thinking_chars += kept.chars().count();
        self.thinking_at = clock.elapsed().as_millis() as u64;
        Some(kept.to_string())
    }

    fn flush(&mut self, emit: &(dyn Fn(AiEvent) + Send + Sync)) {
        if let Some(e) = self.coalescer.flush(Instant::now()) {
            emit(e);
        }
    }
}

/// The error the webview is shown. Contura's own failures (its store, a Connection's
/// settings) become `Internal`, so the card never waits and never shows their message.
pub(crate) fn to_ai(err: &Error) -> AiError {
    match err {
        Error::Ai(e) => e.clone(),
        Error::Cancelled => AiError::Cancelled,
        _ => AiError::Internal,
    }
}

/// Emits `err` as the last event and returns it.
pub(crate) fn fail(
    err: Error,
    partial: bool,
    emit: &(dyn Fn(AiEvent) + Send + Sync),
) -> Result<()> {
    emit(AiEvent::Error {
        error: to_ai(&err),
        partial,
    });
    Err(err)
}

/// Hands the Ask's log lines to the webview as they are pushed, wherever they are pushed
/// from (the preview, the provider): the log's sink queues each line, and the Ask drains
/// the queue before each event of its own and whenever it waits, so lines keep their order
/// and a line pushed before a Stop has already gone.
pub(crate) struct Pump {
    queue: Arc<Mutex<Vec<LogLine>>>,
    ready: Arc<Notify>,
}

impl Pump {
    pub(crate) fn new() -> Self {
        Self {
            queue: Arc::new(Mutex::new(Vec::new())),
            ready: Arc::new(Notify::new()),
        }
    }

    /// The Ask's one log, writing into the queue.
    pub(crate) fn log(&self) -> Log {
        let queue = self.queue.clone();
        let ready = self.ready.clone();
        Log::with_sink(Arc::new(move |line: &LogLine| {
            queue
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(line.clone());
            ready.notify_one();
        }))
    }

    pub(crate) fn drain(&self, emit: &(dyn Fn(AiEvent) + Send + Sync)) {
        let lines = std::mem::take(&mut *self.queue.lock().unwrap_or_else(|e| e.into_inner()));
        for line in lines {
            emit(AiEvent::Log(line));
        }
    }

    /// Runs `fut`, sending its lines as they come.
    pub(crate) async fn run<F: Future>(
        &self,
        fut: F,
        emit: &(dyn Fn(AiEvent) + Send + Sync),
    ) -> F::Output {
        tokio::pin!(fut);
        loop {
            tokio::select! {
                biased;
                _ = self.ready.notified() => self.drain(emit),
                out = &mut fut => {
                    self.drain(emit);
                    break out;
                }
            }
        }
    }
}

/// The one Error line of a failed Ask: `http` for a status error, `request` for transport
/// and timeouts, `answer` for a stream that failed (`partial` once text came).
pub(crate) fn error_line(
    err: &Error,
    partial: bool,
) -> (&'static str, Vec<(&'static str, String)>) {
    let kind = ("kind", error_kind(err));
    let status = |s: u16| ("http", vec![kind.clone(), ("status", s.to_string())]);
    let phase = |p: &str| ("request", vec![kind.clone(), ("phase", p.to_string())]);
    let answer = || {
        (
            "answer",
            vec![kind.clone(), ("partial", partial.to_string())],
        )
    };
    if partial {
        return answer();
    }
    match err {
        Error::Ai(e) => match e {
            AiError::BadKey => status(401),
            AiError::OutOfCredit { .. } => status(402),
            AiError::ModelRetired { .. } => status(404),
            AiError::TooLarge => status(413),
            AiError::RateLimited { .. } => status(429),
            AiError::Overloaded { .. } => status(529),
            AiError::Provider { status: s, .. } => status(*s),
            AiError::Network { .. } | AiError::Offline | AiError::Tls { .. } => phase("connect"),
            AiError::Timeout { phase: p } => phase(p),
            _ => answer(),
        },
        _ => answer(),
    }
}

/// The closing `database` line: what ran on the database for this Ask. Only Contura
/// ever runs anything there, the sample reads (11f); the model's path stays none.
pub(crate) fn database_line(log: &mut Log, read: Option<&RowsSent>) {
    match read {
        Some(r) => log.push(
            Level::Info,
            "database",
            &[
                ("ran", "sampleRead".into()),
                ("tables", r.tables.to_string()),
                ("rows", r.rows.to_string()),
                ("by", "contura".into()),
                ("modelPath", "none".into()),
            ],
        ),
        None => log.push(
            Level::Info,
            "database",
            &[("ran", "nothing".into()), ("modelPath", "none".into())],
        ),
    }
}

/// Logs the one Error line and the closing `database` line, sends them, then fails with `err`.
/// `read` is what Contura read from the database before the failure.
pub(crate) fn fail_logged(
    err: Error,
    (source, fields): (&str, Vec<(&str, String)>),
    partial: bool,
    read: Option<&RowsSent>,
    log: &mut Log,
    pump: &Pump,
    emit: &(dyn Fn(AiEvent) + Send + Sync),
) -> Result<()> {
    log.push(Level::Error, source, &fields);
    database_line(log, read);
    pump.drain(emit);
    fail(err, partial, emit)
}

fn stop_id(stop: StopReason) -> String {
    serde_json::to_value(stop)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// The Request row: how it went and the tools it offered. `summary_bytes` is the summary or
/// compaction call that went with the Ask: its bytes crossed too, so the row counts them.
pub(crate) fn request_step(
    at_ms: u64,
    bytes: u32,
    summary_bytes: Option<u32>,
    base: Option<&url::Url>,
    tools: ToolsAllowed,
) -> ProcessStep {
    let host = base.map(host_of).unwrap_or_default();
    let how = match base {
        Some(u) if u.scheme() == "http" => {
            format!("Sent over http to {host} on this computer or a private network.")
        }
        _ => format!("Sent over https to {host}."),
    };
    let (tools, offered) = match tools {
        ToolsAllowed::None => (
            "no tools",
            "No tools were offered: the assistant cannot run anything.",
        ),
        ToolsAllowed::DiagramTool => (
            "one tool",
            "One tool was offered: it proposes changes to this .flow file and cannot run anything.",
        ),
    };
    let rule = format!("{how} {offered}");
    let plus = summary_bytes.map_or_else(String::new, |b| {
        format!(", plus {} B for the summary", grouped(u64::from(b)))
    });
    ProcessStep {
        step: StepKind::Request,
        at_ms,
        value: format!("{} B{plus}, {tools}", grouped(u64::from(bytes))),
        rule,
        evidence: Vec::new(),
        by_model: false,
        left_out: None,
    }
}

/// The `request` line: where it went, its size, the tool it offered and its picks.
pub(crate) fn request_line(
    log: &mut Log,
    kind: AiProviderKind,
    model: &ModelInfo,
    host: &str,
    (bytes, tokens): (u32, u32),
    chat: &ChatRequest,
    picks: ModelPicks,
) {
    let tools = chat.tools.as_ref().map_or("none", |t| t.name.as_str());
    log.push(
        Level::Info,
        "request",
        &[
            ("provider", kind.id().into()),
            ("model", model.id.clone()),
            ("host", host.to_string()),
            ("bytes", bytes.to_string()),
            ("tokens", tokens.to_string()),
            ("tools", tools.into()),
            ("cache", if picks.caching { "on" } else { "off" }.into()),
            ("thinking", format!("{:?}", picks.thinking).to_lowercase()),
        ],
    );
}

/// The outline call's request: the Ask's own model and its caching pick, thinking forced
/// Off (clamped to the model), no tools. The live test builds its request with this too.
#[doc(hidden)]
pub fn outline_chat_request(
    model: &ModelInfo,
    picks: ModelPicks,
    req: &OutlineRequest,
) -> ChatRequest {
    let cache_mark = model.caching == CachingKind::Breakpoints && picks.caching;
    let off = clamp(
        model,
        ModelPicks {
            thinking: ThinkingLevel::Off,
            caching: picks.caching,
        },
    );
    ChatRequest {
        model: model.id.clone(),
        system: vec![
            PromptBlock {
                text: req.system.clone(),
                cache_mark,
            },
            PromptBlock {
                text: req.outline.clone(),
                cache_mark,
            },
        ],
        messages: vec![ChatMessage {
            role: ChatRole::User,
            text: req.turn.clone(),
        }],
        max_tokens: OUTLINE_REPLY_TOKENS,
        temperature: model.temperature.then_some(0.0),
        thinking: wire_thinking(model, off.thinking, false),
        max_tokens_field: model.max_tokens_field,
        // R0.1: the outline call carries no tools.
        tools: tool_for(ToolsAllowed::None),
    }
}

/// Whether a provider call's request left this PC. It did once the provider answered
/// anything (the first byte, a reply, an error status) or the call failed after connecting.
/// It did not when the call was refused before any connection: a URL refusal, no
/// connection, a failed TLS handshake, a connect timeout, or a header that could not be
/// built. `http` is the `http` log lines the call pushed, one per attempt: an attempt that
/// got a status was answered; `error=connect`, `tls` or `header` never sent the request.
pub(crate) fn request_left(result: &Result<()>, first_byte: bool, http: &[&LogLine]) -> bool {
    if first_byte || result.is_ok() {
        return true;
    }
    let field = |l: &LogLine, key: &str| {
        l.fields
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    };
    if http.iter().any(|l| field(l, "status").is_some()) {
        return true;
    }
    if !http.is_empty() {
        return http.iter().any(|l| {
            field(l, "error").is_some_and(|e| !matches!(e.as_str(), "connect" | "tls" | "header"))
        });
    }
    // No attempt was logged: the error alone says how far the call got.
    match result {
        Err(Error::Ai(e)) => match e {
            AiError::NotConfigured
            | AiError::KeyHostChanged { .. }
            | AiError::InsecureUrl { .. }
            | AiError::UrlHasCredentials { .. }
            | AiError::Offline
            | AiError::Tls { .. }
            | AiError::Cancelled
            | AiError::Busy
            | AiError::NothingToContinue
            | AiError::Internal
            | AiError::ToolOff
            | AiError::BadFileName
            // A connect failure: a failure after connecting logs an attempt.
            | AiError::Network { .. } => false,
            AiError::Timeout { phase } => phase != "connect",
            _ => true,
        },
        // Not an assistant error: it may have gone.
        _ => true,
    }
}

/// The Sent record of an Ask whose outline or summary call left before its main request
/// was sent: `bytes` 0, no hash, no exact text, only the kinds those calls carried. The
/// main record replaces it once that request is built.
fn calls_only(
    kind: AiProviderKind,
    settings: &AiSettings,
    model: &ModelInfo,
    outline: Option<OutlineSent>,
    summary: Option<SummarySent>,
) -> SentRecord {
    let host = settings
        .effective_base_url()
        .and_then(|base| url::Url::parse(base).ok())
        .as_ref()
        .map(host_of)
        .unwrap_or_default();
    let mut kinds = Vec::new();
    if outline.is_some() {
        kinds.push(ItemKind::Outline);
    }
    if summary.is_some() {
        kinds.push(ItemKind::History);
    }
    SentRecord {
        at: now_ms(),
        kinds,
        provider: kind,
        model: model.id.clone(),
        model_name: model.name.clone(),
        host,
        outline_call: outline.is_some(),
        outline,
        summary_call: summary.is_some(),
        summary,
        ..SentRecord::default()
    }
}

/// The Ask's outline call (R4.1): the Ask's own provider, model and key, no tools, no
/// thinking shown or kept, the reply read as data up to 8 KB.
struct StreamPicker<'a> {
    provider: &'a dyn AiProvider,
    kind: AiProviderKind,
    model: &'a ModelInfo,
    settings: &'a AiSettings,
    picks: ModelPicks,
    emit: &'a (dyn Fn(AiEvent) + Send + Sync),
    pump: &'a Pump,
    /// The call's record once its request left this PC, kept when the call then fails.
    sent: Mutex<Option<OutlineSent>>,
}

impl StreamPicker<'_> {
    fn take_sent(&self) -> Option<OutlineSent> {
        self.sent.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    /// Keeps the record of a call that left and sends it as the Ask's Sent record so far:
    /// a Stop or a failure before the main request still shows the outline went.
    fn keep_sent(&self, sent: &OutlineSent) {
        let mut sent = sent.clone();
        sent.left = true;
        *self.sent.lock().unwrap_or_else(|e| e.into_inner()) = Some(sent.clone());
        self.pump.drain(self.emit);
        (self.emit)(AiEvent::Sent(calls_only(
            self.kind,
            self.settings,
            self.model,
            Some(sent),
            None,
        )));
    }
}

#[async_trait::async_trait]
impl TablePicker for StreamPicker<'_> {
    async fn pick(&self, req: &OutlineRequest, log: &mut Log) -> Result<PickReply> {
        // The lines so far go before the status.
        self.pump.drain(self.emit);
        (self.emit)(AiEvent::Status {
            step: "Picking tables".into(),
        });
        let model = self.model;
        let chat = outline_chat_request(model, self.picks, req);
        ExecutionRail::new(ToolsAllowed::None).check_request(&chat, log)?;
        let texts = self.provider.wire_texts(&chat);
        let wire: Vec<&[u8]> = texts.iter().map(|t| t.as_bytes()).collect();
        let mut sent = OutlineSent {
            bytes: u32::try_from(wire.iter().map(|b| b.len()).sum::<usize>()).unwrap_or(u32::MAX),
            tokens: estimate_tokens(&req.system, false)
                .saturating_add(estimate_tokens(&req.outline, false))
                .saturating_add(estimate_tokens(&req.turn, true)),
            hash: format!("{:016x}", fnv1a64_parts(&wire)),
            exact: self
                .settings
                .keep_exact_text
                .then(|| format!("{}\n\n{}", req.outline, req.turn)),
            ..OutlineSent::default()
        };
        let mut text = String::new();
        let mut usage = None;
        let mut first_byte = false;
        let before = log.lines.len();
        let result = {
            let mut sink = |ev: ProviderEvent| match ev {
                // The provider answered: the request left. Its record goes at once, so a
                // Stop while the reply comes still shows it.
                ProviderEvent::FirstByte => {
                    if !first_byte {
                        first_byte = true;
                        self.keep_sent(&sent);
                    }
                }
                ProviderEvent::Text(t) => {
                    let room = REPLY_CAP_BYTES - text.len();
                    text.push_str(cap_chars(&t, room));
                }
                ProviderEvent::Usage(u) => usage = Some(u),
                // Thinking is never shown or kept for this call.
                _ => {}
            };
            self.provider.stream(&chat, log, &mut sink).await
        };
        let http: Vec<&LogLine> = log
            .lines
            .get(before..)
            .unwrap_or_default()
            .iter()
            .filter(|l| l.source == "http")
            .collect();
        // Only a request that left is recorded: a refusal before connecting sent nothing.
        if request_left(&result, first_byte, &http) {
            sent.usage = usage;
            sent.left = true;
            self.keep_sent(&sent);
        }
        result?;
        Ok(PickReply { text, sent })
    }
}

/// Fails an Ask while it is built: the Error line, the closing line, then `Error`.
pub(crate) fn fail_build(
    e: Error,
    read: Option<&RowsSent>,
    log: &mut Log,
    pump: &Pump,
    emit: &(dyn Fn(AiEvent) + Send + Sync),
) -> Result<()> {
    let line = (
        "request",
        vec![("kind", error_kind(&e)), ("phase", "build".into())],
    );
    fail_logged(e, line, false, read, log, pump, emit)
}

/// What the summary step did: the call's record once it left, and its Steps row.
struct Ran {
    sent: Option<SummarySent>,
    row: ProcessStep,
}

/// The Ask's summary step: a Topic summary or a compaction, over the Ask's own provider,
/// model and key, its log and its Sent record.
struct SummaryStep<'a> {
    provider: &'a dyn AiProvider,
    catalog: &'a dyn CatalogReader,
    kind: AiProviderKind,
    settings: &'a AiSettings,
    model: &'a ModelInfo,
    secrets: &'a Secrets,
    emit: &'a (dyn Fn(AiEvent) + Send + Sync),
    pump: &'a Pump,
    /// The outline call's record, when it went: a Sent record sent before the main one
    /// carries both.
    outline: Option<OutlineSent>,
}

impl SummaryStep<'_> {
    /// Makes the one summary call. Once its request left, its record goes as the Ask's
    /// Sent record so far, so a Stop or a failure before the main request still shows it.
    async fn call(
        &self,
        chat: ChatRequest,
        kind: CallKind,
        topic: Option<u32>,
        messages: u32,
        log: &mut Log,
    ) -> (Result<String>, Option<SummarySent>) {
        let shape = |s: &SummarySent| SummarySent {
            topic,
            messages,
            ..s.clone()
        };
        let on_left = |s: &SummarySent| {
            self.pump.drain(self.emit);
            (self.emit)(AiEvent::Sent(calls_only(
                self.kind,
                self.settings,
                self.model,
                self.outline.clone(),
                Some(shape(s)),
            )));
        };
        let secrets = crate::ai::preview::long_secrets(self.secrets);
        let call = compact::summary_call_with(
            self.provider,
            self.model,
            chat,
            kind,
            self.settings.keep_exact_text,
            &secrets,
            log,
            &on_left,
        );
        match self.pump.run(call, self.emit).await {
            Ok((text, s)) => (Ok(text), Some(shape(&s))),
            Err(f) => (Err(f.error), f.sent.as_ref().map(shape)),
        }
    }

    /// The closing Topic's summary by the model; a failure keeps its rule summary. True
    /// when the model's summary was stored.
    async fn topic(&self, p: TopicPlan, thread: crate::ai::ThreadId, log: &mut Log) -> (Ran, bool) {
        log.push(
            Level::Info,
            "compact",
            &[
                ("topic", p.seq.to_string()),
                ("kind", "summary".into()),
                ("model", self.model.id.clone()),
                ("sends", "topic_text_only".into()),
            ],
        );
        self.pump.drain(self.emit);
        (self.emit)(AiEvent::Status {
            step: "Summarising the last topic".into(),
        });
        let chat = p.request(self.model);
        let (out, sent) = self
            .call(chat, CallKind::Summary, Some(p.seq), p.messages, log)
            .await;
        let ok = match out {
            Ok(text) => {
                let by = SummaryBy::Model {
                    model: self.model.id.clone(),
                };
                match self
                    .catalog
                    .threads()
                    .set_topic_summary(thread, p.seq, &text, &by)
                {
                    Ok(()) => true,
                    Err(e) => {
                        log.push(Level::Warn, "memory", &[("error", error_kind(&e))]);
                        false
                    }
                }
            }
            Err(e) => {
                log.push(Level::Warn, "compact", &[("error", error_kind(&e))]);
                false
            }
        };
        let row = compact::topic_row(log, &p, self.model, sent.as_ref(), ok);
        (Ran { sent, row }, ok)
    }

    /// The compaction at 85%: by the model when every folded message passes the gate and
    /// the Summary row is on, else by rules. The compaction is stored, the history picked
    /// again and the turn assembled again (no second `gather`); the new turn is returned.
    async fn compact(
        &self,
        p: CompactPlan,
        req: &AskRequest,
        g: &Gathered,
        memory: &mut Recall,
        log: &mut Log,
    ) -> Result<(Ran, Option<Preview>)> {
        log.push(
            Level::Warn,
            "context",
            &[
                ("used", p.used.to_string()),
                ("window", p.window.to_string()),
                ("threshold", format!("{}%", compact::COMPACT_AT_PERCENT)),
            ],
        );
        let (summary, by, kinds, sent, wrote) = if p.by_model() {
            log.push(
                Level::Info,
                "compact",
                &[
                    ("messages", p.messages.to_string()),
                    ("model", self.model.id.clone()),
                    ("sends", "thread_text_only".into()),
                ],
            );
            self.pump.drain(self.emit);
            (self.emit)(AiEvent::Status {
                step: "Compacting the thread".into(),
            });
            let chat = p.request(self.model);
            let (out, sent) = self
                .call(chat, CallKind::Compact, None, p.messages, log)
                .await;
            match out {
                Ok(text) => (
                    text,
                    SummaryBy::Model {
                        model: self.model.id.clone(),
                    },
                    p.kinds.clone(),
                    sent,
                    Wrote::Model,
                ),
                Err(e) => {
                    log.push(Level::Warn, "compact", &[("error", error_kind(&e))]);
                    (
                        p.rules.clone(),
                        SummaryBy::Rules,
                        p.rules_kinds.clone(),
                        sent,
                        Wrote::Failed,
                    )
                }
            }
        } else {
            log.push(
                Level::Info,
                "compact",
                &[("messages", p.messages.to_string()), ("by", "rules".into())],
            );
            let wrote = if p.gate {
                Wrote::SwitchedOff
            } else {
                Wrote::Gate
            };
            (
                p.rules.clone(),
                SummaryBy::Rules,
                p.rules_kinds.clone(),
                None,
                wrote,
            )
        };
        let by_model = matches!(wrote, Wrote::Model);
        let thread = memory.source.as_ref().map(|t| t.id).unwrap_or_default();
        let mut c = compact::new_compaction(
            thread,
            &p,
            summary,
            by,
            kinds,
            req.connection_id,
            req.database.clone(),
        );
        let store = self.catalog.threads();
        let mut again = None;
        c.after = p.used;
        match store.add_compaction(&c) {
            Err(e) => log.push(Level::Warn, "memory", &[("error", error_kind(&e))]),
            Ok(()) => {
                *memory = recall(self.catalog, g, log);
                let turn = assemble_with(g, &memory.pick, memory.memory.clone(), log, false)?;
                let (_, needed) = compact::measure(&turn, req, self.settings, self.model);
                c.after = needed;
                if let Err(e) = store.add_compaction(&c) {
                    log.push(Level::Warn, "memory", &[("error", error_kind(&e))]);
                }
                if by_model {
                    log.push(
                        Level::Info,
                        "compact",
                        &[
                            (
                                "summary_tokens",
                                crate::ai::budget::estimate_tokens(&c.summary, false).to_string(),
                            ),
                            ("context_after", needed.to_string()),
                        ],
                    );
                }
                self.pump.drain(self.emit);
                (self.emit)(AiEvent::Compacted {
                    compaction: Box::new(c.clone()),
                });
                again = Some(turn);
            }
        }
        let row = compact::compact_row(
            log,
            &p,
            c.after,
            wrote,
            self.model,
            sent.as_ref(),
            &c.summary,
        );
        Ok((Ran { sent, row }, again))
    }
}

/// Streams the model's answer for `chat` into `emit`, for a database Ask and a diagram
/// Ask alike: text as coalesced `Delta`s up to the 64 KB cap (R4.2, which stops reading),
/// thinking shown and kept only with sharing on and redacted (R2.1), the provider's lines
/// as they come. Tool calls are kept for the Ask to check once the stream ends; none is
/// ever answered. Returns the provider's result and what the stream kept.
pub(crate) async fn stream_answer(
    provider: &dyn AiProvider,
    chat: &ChatRequest,
    settings: &AiSettings,
    secrets: &Secrets,
    log: &mut Log,
    pump: &Pump,
    emit: &(dyn Fn(AiEvent) + Send + Sync),
) -> (Result<()>, Answer) {
    let answer = Mutex::new(Answer::default());
    let lock = || answer.lock().unwrap_or_else(|e| e.into_inner());
    let capped = Notify::new();
    let clock = log.started;
    let mut sink = |ev: ProviderEvent| {
        // The provider's lines so far go first.
        pump.drain(emit);
        let mut a = lock();
        match ev {
            ProviderEvent::FirstByte => {}
            // Past the cap the provider is about to be dropped; nothing more is kept.
            _ if a.capped => {}
            ProviderEvent::Text(text) => {
                if a.take(&text, emit) {
                    capped.notify_one();
                }
            }
            // With sharing off the thinking is neither shown nor kept.
            ProviderEvent::Thinking(_) if !settings.share_thinking => {}
            ProviderEvent::Thinking(text) => {
                a.flush(emit);
                // R2.1 over what the provider wrote, before it is shown or kept.
                let (text, _) = redact_secrets(&text, secrets);
                if let Some(kept) = a.think(&text, clock) {
                    emit(AiEvent::Thinking { text: kept });
                }
            }
            ProviderEvent::Usage(usage) => a.usage = Some(usage),
            ProviderEvent::Stop(stop) => a.stop = Some(stop),
            ProviderEvent::ToolCall { name, input } => {
                a.calls_seen += 1;
                if a.calls.len() < TOOL_CALLS {
                    a.calls.push(ToolCallSeen { name, input });
                }
            }
        }
    };
    let result = {
        let streaming = provider.stream(chat, log, &mut sink);
        tokio::pin!(streaming);
        let mut tick = tokio::time::interval(DELTA_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                biased;
                // R4.2: stop reading; dropping the stream closes the connection.
                _ = capped.notified() => break Ok(()),
                _ = pump.ready.notified() => pump.drain(emit),
                r = &mut streaming => break r,
                _ = tick.tick() => {
                    if let Some(e) = lock().coalescer.due(Instant::now()) {
                        emit(e);
                    }
                }
            }
        }
    };
    pump.drain(emit);

    let mut a = answer.into_inner().unwrap_or_else(|e| e.into_inner());
    a.flush(emit);
    // Each chunk was redacted alone; a secret split across two chunks is found in the
    // whole, which replaces the chunks before anything is kept.
    if !a.thinking.is_empty() {
        let (whole, _) = redact_secrets(&a.thinking, secrets);
        if whole != a.thinking {
            emit(AiEvent::ThinkingKept { text: whole });
        }
    }
    (result, a)
}

/// How a streamed answer ended.
pub(crate) struct Ended {
    pub(crate) usage: Usage,
    /// `TooLong` once the 64 KB cap stopped it.
    pub(crate) stop: StopReason,
    /// The stream failed (not at the cap).
    pub(crate) partial: bool,
    /// Some text or thinking came.
    pub(crate) received: bool,
}

/// Closes a streamed answer for either Ask: the `thinking` and `answer` lines, then the
/// Thinking row (none for a failed Ask that received nothing). `failed` is a stream that
/// failed before the cap.
pub(crate) fn end_answer(
    a: &Answer,
    failed: bool,
    settings: &AiSettings,
    log: &mut Log,
    pump: &Pump,
    emit: &(dyn Fn(AiEvent) + Send + Sync),
) -> Ended {
    let usage = a.usage.unwrap_or_default();
    let stop = if a.capped {
        StopReason::TooLong
    } else {
        a.stop.unwrap_or(StopReason::Dropped)
    };
    if a.thinking_chars > 0 {
        log.push(
            Level::Debug,
            "thinking",
            &[("chars", a.thinking_chars.to_string())],
        );
    }
    log.push(
        Level::Info,
        "answer",
        &[
            ("chars", a.chars.to_string()),
            ("input", usage.input.to_string()),
            ("output", usage.output.to_string()),
            ("cache_read", usage.cache_read.to_string()),
            ("cache_write", usage.cache_write.to_string()),
            (
                "stop",
                if failed {
                    "failed".into()
                } else {
                    stop_id(stop)
                },
            ),
        ],
    );
    pump.drain(emit);
    // A failed Ask that received nothing has no Thinking or Answer to show; one that
    // received some marks both rows partial.
    let received = a.bytes > 0 || a.thinking_chars > 0;
    let partial = failed;
    if received || !partial {
        let suffix = if partial { " (partial)" } else { "" };
        let thinking = if a.thinking_chars > 0 {
            ProcessStep {
                step: StepKind::Thinking,
                at_ms: a.thinking_at,
                value: format!(
                    "{} chars, by the model{suffix}",
                    grouped(a.thinking_chars as u64)
                ),
                rule: THINKING_SHARED.into(),
                evidence: Vec::new(),
                by_model: true,
                left_out: None,
            }
        } else {
            let (value, rule) = if settings.share_thinking {
                ("not shared by the model", THINKING_NOT_SHARED)
            } else {
                ("turned off in settings", THINKING_TURNED_OFF)
            };
            ProcessStep {
                step: StepKind::Thinking,
                at_ms: log.elapsed_ms(),
                value: format!("{value}{suffix}"),
                rule: rule.into(),
                evidence: Vec::new(),
                by_model: false,
                left_out: None,
            }
        };
        emit(AiEvent::Process(thinking));
    }
    Ended {
        usage,
        stop,
        partial,
        received,
    }
}

/// The Answer row: `what` the answer held, or "partial" for a failed stream that
/// received some text; none for a failed stream that received nothing.
pub(crate) fn answer_row(
    a: &Answer,
    usage: Usage,
    (partial, received): (bool, bool),
    what: String,
    log: &Log,
    emit: &(dyn Fn(AiEvent) + Send + Sync),
) {
    let counts = format!(
        "{} characters, {} output tokens",
        grouped(a.chars as u64),
        grouped(u64::from(usage.output))
    );
    let (value, rule) = if !partial {
        (format!("{what}, by the model"), format!("{counts}."))
    } else if received {
        (
            "partial, by the model".to_string(),
            format!("{counts}, before the answer failed."),
        )
    } else {
        return;
    };
    emit(AiEvent::Process(ProcessStep {
        step: StepKind::Answer,
        at_ms: log.elapsed_ms(),
        value,
        rule,
        evidence: Vec::new(),
        by_model: true,
        left_out: None,
    }));
}

/// Runs one Ask and reports it through `emit`, ending with `Done` or `Error`. The schema
/// block and the user message are exactly what the preview showed (R1.6). The request
/// follows `model`'s record: the picks (the request's, else the model's stored ones)
/// clamped to it, cache marks only for a model with breakpoints and caching on, a
/// temperature only where the model takes one. A text that does not fit the model's window
/// with room for the answer fails `TooBig` and nothing is sent. Every error is emitted as
/// `Error` and also returned; one that is not an assistant error (reading the stored
/// Connection) is emitted as `Internal`. Dropping the future (Stop) drops the connection
/// and sends nothing more.
///
/// One log runs through the whole Ask: the preview's lines, the request, the provider's
/// `http` and `retry` lines, the answer; each reaches the webview as it is pushed. The
/// Steps rows go as `Process` as each completes, and the Sent record as `Sent` once the
/// request is built, before the first attempt. An outline call that left sends its own
/// Sent record first, so a Stop or a failure before the main request still shows it.
///
/// Between the memory stage and the request runs the summary step (R4.1, at most one
/// call): at 85% of the window the open Topic's older turns are compacted (`Compacted`,
/// then the turn is assembled again), or with auto-compact off the Ask fails
/// `ContextFull` and nothing is sent; otherwise the Topic this Ask closes is summarised.
/// The call goes over this same provider and shows in the log, the Steps (Compact row)
/// and the Sent record (`summary`); a failed call falls back to the rule summary.
pub async fn ask_stream(
    provider: &dyn AiProvider,
    catalog: &dyn CatalogReader,
    settings: &AiSettings,
    model: &ModelInfo,
    secrets: &Secrets,
    req: &AskRequest,
    emit: &(dyn Fn(AiEvent) + Send + Sync),
) -> Result<()> {
    let started = Instant::now();
    let Some(kind) = settings.provider else {
        return fail(Error::Ai(AiError::NotConfigured), false, emit);
    };
    let pump = Pump::new();
    let mut log = pump.log();
    emit(AiEvent::Status {
        step: "Checking the schema".into(),
    });
    let picks = clamp(model, req.picks.unwrap_or(model.picks));
    // The one outline call, when tier 3 triggers, goes over this same provider.
    let picker = StreamPicker {
        provider,
        kind,
        model,
        settings,
        picks,
        emit,
        pump: &pump,
        sent: Mutex::new(None),
    };
    // The preview's stages, run apart so the summary step goes between the memory stage
    // and the request: `gather`, the memory stage and `assemble`, as the preview does.
    // A Continue without a cut answer to follow is refused before anything is read or
    // sent, and a Continue never makes the outline call.
    if let Err(e) = precheck_continue(catalog, req) {
        return fail_build(e, None, &mut log, &pump, emit);
    }
    let outline_picker: Option<&dyn TablePicker> =
        (req.action != "continue").then_some(&picker as &dyn TablePicker);
    // The lines so far go before each status.
    let status = |step: &str| {
        pump.drain(emit);
        emit(AiEvent::Status { step: step.into() });
    };
    let gathered = gather(
        catalog,
        settings,
        model,
        secrets,
        req,
        Purpose::Ask,
        outline_picker,
        &status,
        &mut log,
    );
    let gathered = match pump.run(gathered, emit).await {
        Ok(g) => g,
        Err(e) => return fail_build(e, None, &mut log, &pump, emit),
    };
    // Read once, here: assembling again after a summary step reads nothing.
    let read = gathered.rows_read();
    let read = read.as_ref();
    let mut memory = recall(catalog, &gathered, &mut log);
    if let Err(e) = check_continue(req, &memory) {
        return fail_build(e, read, &mut log, &pump, emit);
    }
    let mut preview = match assemble_with(
        &gathered,
        &memory.pick,
        memory.memory.clone(),
        &mut log,
        false,
    ) {
        Ok(p) => p,
        Err(e) => return fail_build(e, read, &mut log, &pump, emit),
    };
    // A call that failed after it left has no reply to check, but it went: its record
    // still counts.
    let outline = preview.outline_sent.clone().or_else(|| picker.take_sent());

    // The summary step: at most one call, before the request (R4.1).
    let step = SummaryStep {
        provider,
        catalog,
        kind,
        settings,
        model,
        secrets,
        emit,
        pump: &pump,
        outline: outline.clone(),
    };
    let (mut tokens, mut needed) = compact::measure(&preview, req, settings, model);
    let plan = compact::plan(
        catalog, settings, model, &gathered, &memory, needed, &mut log,
    );
    let plan = pump.run(plan, emit).await;
    let ran = match plan {
        Plan::Nothing => None,
        Plan::Full {
            used,
            window,
            messages,
        } => {
            let full = Error::Ai(AiError::ContextFull {
                used,
                window,
                model: model.name.clone(),
                messages,
            });
            let line = (
                "context",
                vec![
                    ("used", used.to_string()),
                    ("window", window.to_string()),
                    ("auto_compact", "off".into()),
                    ("sent", "nothing".into()),
                ],
            );
            if let Some(o) = outline {
                emit(AiEvent::Sent(calls_only(
                    kind,
                    settings,
                    model,
                    Some(o),
                    None,
                )));
            }
            return fail_logged(full, line, false, read, &mut log, &pump, emit);
        }
        Plan::TopicSkipped { seq, reason } => {
            log.push(
                Level::Info,
                "compact",
                &[
                    ("topic", seq.to_string()),
                    ("kind", "summary".into()),
                    ("by", "rules".into()),
                    ("reason", reason.into()),
                ],
            );
            None
        }
        Plan::Topic(p) if !p.on => {
            log.push(
                Level::Info,
                "compact",
                &[
                    ("topic", p.seq.to_string()),
                    ("kind", "summary".into()),
                    ("by", "rules".into()),
                    ("reason", "setting".into()),
                ],
            );
            None
        }
        Plan::Topic(p) => {
            let thread = memory.source.as_ref().map(|t| t.id).unwrap_or_default();
            let (ran, stored) = step.topic(p, thread, &mut log).await;
            // The model's summary replaces the rule summary the history picked: pick
            // again and assemble the turn again, as after a compaction.
            if stored {
                memory = recall(catalog, &gathered, &mut log);
                match assemble_with(
                    &gathered,
                    &memory.pick,
                    memory.memory.clone(),
                    &mut log,
                    false,
                ) {
                    Ok(again) => {
                        preview = again;
                        (tokens, needed) = compact::measure(&preview, req, settings, model);
                    }
                    Err(e) => return fail_build(e, read, &mut log, &pump, emit),
                }
            }
            Some(ran)
        }
        Plan::Compact(p) => match step.compact(p, req, &gathered, &mut memory, &mut log).await {
            Ok((ran, again)) => {
                if let Some(again) = again {
                    preview = again;
                    (tokens, needed) = compact::measure(&preview, req, settings, model);
                }
                Some(ran)
            }
            Err(e) => return fail_build(e, read, &mut log, &pump, emit),
        },
    };
    let (summary, compact_row) = match ran {
        Some(Ran { sent, row }) => (sent, Some(row)),
        None => (None, None),
    };
    if let Some(m) = &preview.memory {
        memory_line(&mut log, m);
    }
    pump.drain(emit);
    for step in &preview.steps {
        emit(AiEvent::Process(step.clone()));
        if step.step == StepKind::Schema
            && let Some(info) = &preview.context
        {
            emit(AiEvent::Context { info: info.clone() });
        }
    }
    // After Cleaning, before Request.
    if let Some(row) = compact_row {
        emit(AiEvent::Process(row));
    }
    let max_tokens = settings.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS);
    // The preview read the Connection once; its Dialect is `None` at Never.
    let dialect = preview.dialect;

    let cache_mark = model.caching == CachingKind::Breakpoints && picks.caching;
    // Mark 1 after the system prompt, mark 2 after the schema block; nothing that changes
    // per request comes before mark 2.
    let mut system = vec![PromptBlock {
        text: system_prompt(&req.action, dialect),
        cache_mark,
    }];
    let parts = preview.parts;
    if !parts.schema.is_empty() {
        system.push(PromptBlock {
            text: parts.schema,
            cache_mark,
        });
    }
    // The thread's turns, then the turn: all after mark 2.
    let mut messages: Vec<ChatMessage> = parts
        .history
        .into_iter()
        .map(|(role, text)| ChatMessage { role, text })
        .collect();
    messages.push(ChatMessage {
        role: ChatRole::User,
        text: parts.turn,
    });
    let chat = ChatRequest {
        model: model.id.clone(),
        system,
        messages,
        max_tokens,
        temperature: settings.temperature.filter(|_| model.temperature),
        thinking: wire_thinking(model, picks.thinking, settings.share_thinking),
        max_tokens_field: model.max_tokens_field,
        // R0.1: a database Ask carries no tools.
        tools: tool_for(ToolsAllowed::None),
    };
    let wire_max_tokens = max_tokens_on_wire(kind, chat.max_tokens, &chat.thinking);
    // A refused call's name reaches only the error, cleaned with the saved secrets.
    let execution = ExecutionRail {
        allowed: ToolsAllowed::None,
        secrets: crate::ai::preview::long_secrets(secrets),
    };
    if let Err(e) = execution.check_request(&chat, &mut log) {
        if outline.is_some() || summary.is_some() {
            emit(AiEvent::Sent(calls_only(
                kind, settings, model, outline, summary,
            )));
        }
        return fail_build(e, read, &mut log, &pump, emit);
    }
    // The system prompt and the room a thinking level raised `max_tokens` to count too.
    debug_assert_eq!(needed, tokens.saturating_add(wire_max_tokens));
    if needed > model.context_window {
        let too_big = Error::Ai(AiError::TooBig {
            needed,
            window: model.context_window,
            model: model.name.clone(),
        });
        let line = (
            "request",
            vec![("kind", error_kind(&too_big)), ("phase", "build".into())],
        );
        // Only the outline or summary call went: its record, now with its picks, is the
        // Ask's.
        if outline.is_some() || summary.is_some() {
            emit(AiEvent::Sent(calls_only(
                kind, settings, model, outline, summary,
            )));
        }
        return fail_logged(too_big, line, false, read, &mut log, &pump, emit);
    }
    emit(AiEvent::Status {
        step: "Writing".into(),
    });
    // Exactly the texts this provider puts on the wire (an OpenAI-compatible body joins
    // the system blocks into one message).
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
    let summary_bytes = summary.as_ref().map(|s| s.bytes);
    emit(AiEvent::Sent(SentRecord {
        at: now_ms(),
        kinds: preview
            .items
            .iter()
            .filter(|i| i.on && i.locked.is_none())
            // Rows count as sent only when rows text went.
            .filter(|i| i.kind != ItemKind::Rows || i.bytes > 0)
            .map(|i| i.kind)
            .collect(),
        bytes: sent_bytes,
        tokens,
        provider: kind,
        model: model.id.clone(),
        model_name: model.name.clone(),
        host,
        hash,
        outline_call: outline.is_some(),
        summary_call: summary.is_some(),
        outline,
        summary,
        rows: preview.rows.clone(),
        // Never stored: the kept text shows where rows went without holding them.
        exact: settings
            .keep_exact_text
            .then(|| crate::ai::rails::retrieval::without_rows(&preview.exact)),
    }));
    emit(AiEvent::Process(request_step(
        log.elapsed_ms(),
        sent_bytes,
        summary_bytes,
        base.as_ref(),
        ToolsAllowed::None,
    )));

    let (result, mut a) =
        stream_answer(provider, &chat, settings, secrets, &mut log, &pump, emit).await;
    // R0.1: a database Ask offers no tool, so the rail refuses any call. It is never
    // answered; the answer text so far is kept and the Ask goes on.
    for call in std::mem::take(&mut a.calls) {
        let _refused = execution.check_call(&call.name, &call.input, &mut log);
    }
    let failed = result.as_ref().err().filter(|_| !a.capped);
    let Ended {
        usage,
        stop,
        partial,
        received,
    } = end_answer(&a, failed.is_some(), settings, &mut log, &pump, emit);
    // R5: the output rail runs on the final text of an answer that reaches Done; a capped
    // or partial one is checked too, without an unclosed last fence.
    let sql_blocks: Vec<SqlBlock> = if partial {
        Vec::new()
    } else {
        let ended = !a.capped && stop == StopReason::End;
        check_answer_with(
            &a.text,
            preview.sql_dialect,
            &req.action,
            preview.read_only,
            ended,
        )
    };
    answer_row(
        &a,
        usage,
        (partial, received),
        count_of(sql_blocks.len(), "SQL block", "SQL blocks"),
        &log,
        emit,
    );

    match result {
        Err(e) if !a.capped => {
            let partial = a.bytes > 0;
            let line = error_line(&e, partial);
            fail_logged(e, line, partial, read, &mut log, &pump, emit)
        }
        _ => {
            let check = check_summary(&sql_blocks, preview.sql_dialect, log.elapsed_ms());
            log.push(
                Level::Info,
                "sql_check",
                &[
                    ("reads", check.reads.to_string()),
                    ("writes", check.writes.to_string()),
                    ("flags", check.flags.to_string()),
                ],
            );
            pump.drain(emit);
            emit(AiEvent::Process(check.step));
            database_line(&mut log, read);
            pump.drain(emit);
            emit(AiEvent::Done {
                usage: a.usage,
                stop,
                sent_bytes,
                model: model.id.clone(),
                provider: kind,
                millis: u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX),
                notes: preview.notes,
                sql_blocks,
                max_tokens: wire_max_tokens,
            });
            Ok(())
        }
    }
}

/// How full the window is for the 85% check: the larger of `estimate` (the preview's
/// tokens, the system prompt and the `max_tokens` sent) and what the provider reported
/// for the newest answer of `topic` (`input` plus `cache_read`): reported tokens replace
/// the estimate, so the check never runs below what the provider counted.
pub fn context_used(estimate: u32, thread: Option<&AiThread>, topic: u32) -> u32 {
    let reported = thread
        .and_then(|t| {
            t.messages
                .iter()
                .rev()
                .filter(|m| m.role == AiRole::Assistant && m.topic == Some(topic))
                .find_map(|m| m.record.as_ref().and_then(|r| r.usage))
        })
        .map_or(0, |u| u.input.saturating_add(u.cache_read));
    estimate.max(reported)
}

const THINKING_SHARED: &str =
    "Shared by the provider, as written. It is the model's own reasoning, not Contura's.";
const THINKING_TURNED_OFF: &str =
    "Share thinking is off in settings, so any thinking is neither shown nor kept.";
const THINKING_NOT_SHARED: &str =
    "This model does not share its thinking. Contura shows only what it sent and what came back.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_left_reads_the_attempts() {
        let line = |k: &str, v: &str| LogLine {
            at_ms: 0,
            level: Level::Info,
            source: "http".into(),
            fields: vec![(k.into(), v.into())],
        };
        let network = || -> Result<()> {
            Err(Error::Ai(AiError::Network {
                host: "api.groq.com".into(),
                connect: false,
            }))
        };
        let connect = line("error", "connect");
        let status = line("status", "503");
        let broke = line("error", "network");
        let header = line("error", "header");
        // Every attempt failed to connect: nothing left.
        assert!(!request_left(&network(), false, &[&connect, &connect]));
        // A 503 came back on an earlier attempt: the request left.
        assert!(request_left(&network(), false, &[&status, &connect]));
        // A failure after connecting may have sent it.
        assert!(request_left(&network(), false, &[&broke]));
        assert!(!request_left(
            &Err(Error::Ai(AiError::BadKey)),
            false,
            &[&header]
        ));
        assert!(request_left(&network(), true, &[]));
        assert!(request_left(&Ok(()), false, &[]));
        let timeout = |phase: &str| -> Result<()> {
            Err(Error::Ai(AiError::Timeout {
                phase: phase.into(),
            }))
        };
        assert!(!request_left(&timeout("connect"), false, &[]));
        assert!(request_left(&timeout("first byte"), false, &[]));
        assert!(request_left(
            &Err(Error::Ai(AiError::RateLimited {
                retry_after_secs: None
            })),
            false,
            &[]
        ));
    }

    #[test]
    fn coalescer_waits_50ms_between_deltas() {
        let t0 = Instant::now();
        let mut c = Coalescer::new();
        assert_eq!(c.push("a", t0), Some(AiEvent::Delta { text: "a".into() }));
        assert_eq!(c.push("b", t0 + Duration::from_millis(10)), None);
        assert_eq!(c.push("c", t0 + Duration::from_millis(40)), None);
        assert_eq!(c.due(t0 + Duration::from_millis(49)), None);
        assert_eq!(
            c.due(t0 + Duration::from_millis(50)),
            Some(AiEvent::Delta { text: "bc".into() })
        );
        assert_eq!(c.flush(t0 + Duration::from_millis(60)), None);
        c.push("d", t0 + Duration::from_millis(60));
        assert_eq!(
            c.flush(t0 + Duration::from_millis(61)),
            Some(AiEvent::Delta { text: "d".into() })
        );
    }

    #[test]
    fn cap_cuts_on_a_char_boundary() {
        let mut a = Answer {
            bytes: ANSWER_CAP - 2,
            ..Answer::default()
        };
        let emitted = Mutex::new(Vec::new());
        let emit = |e: AiEvent| emitted.lock().unwrap().push(e);
        // "日" is 3 bytes: it does not fit in the 2 left, so nothing of it is kept.
        assert!(a.take("日本", &emit));
        assert_eq!(a.bytes, ANSWER_CAP - 2);
        assert!(a.capped);
    }
}
