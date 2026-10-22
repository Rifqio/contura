//! One streamed Ask: the system prompt and the preview's schema block as the cached prefix,
//! the preview's turn as the user message, the provider's events turned into the events the
//! webview shows.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::Notify;

use crate::ai::budget::estimate_tokens;
use crate::ai::context::outline::{
    OUTLINE_REPLY_TOKENS, OutlineRequest, PickReply, REPLY_CAP_BYTES, TablePicker,
};
use crate::ai::context::sync::{ContextInfo, Purpose};
use crate::ai::log::{Level, Log, LogLine, ProcessStep, StepKind, error_kind};
use crate::ai::models::{CachingKind, ModelInfo, ModelPicks, ThinkingLevel, clamp};
use crate::ai::preview::{CatalogReader, count_of, preview_with_log};
use crate::ai::prompt::system_prompt;
use crate::ai::provider::url::host_of;
use crate::ai::provider::{
    AiProvider, ChatMessage, ChatRequest, ChatRole, PromptBlock, ProviderEvent, StopReason, Usage,
    max_tokens_on_wire, wire_thinking,
};
use crate::ai::rails::output::{SqlBlock, check_answer_with, check_summary};
use crate::ai::rails::{Secrets, cap_chars, redact_secrets};
use crate::ai::request::{AskRequest, ItemKind};
use crate::ai::sent::{OutlineSent, SentRecord, THINKING_CAP, fnv1a64_parts};
use crate::ai::{AiError, AiProviderKind, AiSettings, now_ms};
use crate::common::grouped;
use crate::error::{Error, Result};

/// At most one `Delta` per this long.
const DELTA_EVERY: Duration = Duration::from_millis(50);
/// R4.2: an answer over this many bytes of text is stopped.
const ANSWER_CAP: usize = 64 * 1024;
/// R4.1: `max_tokens` when the settings leave it unset.
const DEFAULT_MAX_TOKENS: u32 = 4096;

/// One event of a streamed Ask, in order. The last one is `Done` or `Error`.
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
struct Answer {
    coalescer: Coalescer,
    /// The answer text kept, for the output rail.
    text: String,
    /// Bytes of answer text kept.
    bytes: usize,
    chars: usize,
    usage: Option<Usage>,
    stop: Option<StopReason>,
    capped: bool,
    /// Thinking kept, up to 64 KB.
    thinking: String,
    thinking_bytes: usize,
    thinking_chars: usize,
    /// When the last thinking came, in log time.
    thinking_at: u64,
}

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
fn to_ai(err: &Error) -> AiError {
    match err {
        Error::Ai(e) => e.clone(),
        Error::Cancelled => AiError::Cancelled,
        _ => AiError::Internal,
    }
}

/// Emits `err` as the last event and returns it.
fn fail(err: Error, partial: bool, emit: &(dyn Fn(AiEvent) + Send + Sync)) -> Result<()> {
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
struct Pump {
    queue: Arc<Mutex<Vec<LogLine>>>,
    ready: Arc<Notify>,
}

impl Pump {
    fn new() -> Self {
        Self {
            queue: Arc::new(Mutex::new(Vec::new())),
            ready: Arc::new(Notify::new()),
        }
    }

    /// The Ask's one log, writing into the queue.
    fn log(&self) -> Log {
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

    fn drain(&self, emit: &(dyn Fn(AiEvent) + Send + Sync)) {
        let lines = std::mem::take(&mut *self.queue.lock().unwrap_or_else(|e| e.into_inner()));
        for line in lines {
            emit(AiEvent::Log(line));
        }
    }

    /// Runs `fut`, sending its lines as they come.
    async fn run<F: Future>(&self, fut: F, emit: &(dyn Fn(AiEvent) + Send + Sync)) -> F::Output {
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
fn error_line(err: &Error, partial: bool) -> (&'static str, Vec<(&'static str, String)>) {
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

/// Logs the one Error line and the closing `database` line, sends them, then fails with `err`.
fn fail_logged(
    err: Error,
    (source, fields): (&str, Vec<(&str, String)>),
    partial: bool,
    log: &mut Log,
    pump: &Pump,
    emit: &(dyn Fn(AiEvent) + Send + Sync),
) -> Result<()> {
    log.push(Level::Error, source, &fields);
    log.push(Level::Info, "database", &[("ran", "nothing".into())]);
    pump.drain(emit);
    fail(err, partial, emit)
}

fn stop_id(stop: StopReason) -> String {
    serde_json::to_value(stop)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// The Request row: how it went and that no tools did.
fn request_step(at_ms: u64, bytes: u32, base: Option<&url::Url>) -> ProcessStep {
    let host = base.map(host_of).unwrap_or_default();
    let rule = match base {
        Some(u) if u.scheme() == "http" => format!(
            "Sent over http to {host} on this PC or a private network. No tools were offered: the assistant cannot run anything."
        ),
        _ => format!(
            "Sent over https to {host}. No tools were offered: the assistant cannot run anything."
        ),
    };
    ProcessStep {
        step: StepKind::Request,
        at_ms,
        value: format!("{} B, no tools", grouped(u64::from(bytes))),
        rule,
        evidence: Vec::new(),
        by_model: false,
        left_out: None,
    }
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
    }
}

/// Whether a provider call's request left this PC. It did once the provider answered
/// anything (the first byte, a reply, an error status) or the call failed after connecting.
/// It did not when the call was refused before any connection: a URL refusal, no
/// connection, a failed TLS handshake, a connect timeout, or a header that could not be
/// built. `http` is the `http` log lines the call pushed, one per attempt: an attempt that
/// got a status was answered; `error=connect`, `tls` or `header` never sent the request.
fn request_left(result: &Result<()>, first_byte: bool, http: &[&LogLine]) -> bool {
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
            | AiError::Internal
            // A connect failure: a failure after connecting logs an attempt.
            | AiError::Network { .. } => false,
            AiError::Timeout { phase } => phase != "connect",
            _ => true,
        },
        // Not an assistant error: it may have gone.
        _ => true,
    }
}

/// The Sent record of an Ask whose outline call left before its main request was sent:
/// `bytes` 0, no hash, no exact text, the outline item the only kind that went. The main
/// record replaces it once that request is built.
fn outline_only(
    kind: AiProviderKind,
    settings: &AiSettings,
    model: &ModelInfo,
    outline: OutlineSent,
) -> SentRecord {
    let host = settings
        .effective_base_url()
        .and_then(|base| url::Url::parse(base).ok())
        .as_ref()
        .map(host_of)
        .unwrap_or_default();
    SentRecord {
        at: now_ms(),
        kinds: vec![ItemKind::Outline],
        provider: kind,
        model: model.id.clone(),
        model_name: model.name.clone(),
        host,
        outline_call: true,
        outline: Some(outline),
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
        (self.emit)(AiEvent::Sent(outline_only(
            self.kind,
            self.settings,
            self.model,
            sent,
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
    let built = preview_with_log(
        catalog,
        settings,
        model,
        secrets,
        req,
        Purpose::Ask,
        Some(&picker),
        &mut log,
    );
    let preview = match pump.run(built, emit).await {
        Ok(p) => p,
        Err(e) => {
            let line = (
                "request",
                vec![("kind", error_kind(&e)), ("phase", "build".into())],
            );
            return fail_logged(e, line, false, &mut log, &pump, emit);
        }
    };
    for step in &preview.steps {
        emit(AiEvent::Process(step.clone()));
        if step.step == StepKind::Schema
            && let Some(info) = &preview.context
        {
            emit(AiEvent::Context { info: info.clone() });
        }
    }
    let max_tokens = settings.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS);
    // The preview read the Connection once; its Dialect is `None` at Never.
    let dialect = preview.dialect;
    // A call that failed after it left has no reply to check, but it went: its record
    // still counts.
    let outline = preview.outline_sent.clone().or_else(|| picker.take_sent());

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
    let chat = ChatRequest {
        model: model.id.clone(),
        system,
        messages: vec![ChatMessage {
            role: ChatRole::User,
            text: parts.turn,
        }],
        max_tokens,
        temperature: settings.temperature.filter(|_| model.temperature),
        thinking: wire_thinking(model, picks.thinking, settings.share_thinking),
        max_tokens_field: model.max_tokens_field,
    };
    let tokens = preview
        .tokens
        .saturating_add(estimate_tokens(&chat.system[0].text, false));
    // The system prompt and the room a thinking level raised `max_tokens` to count too.
    let needed = tokens.saturating_add(max_tokens_on_wire(kind, chat.max_tokens, &chat.thinking));
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
        // Only the outline call went: its record, now with its picks, is the Ask's.
        if let Some(o) = outline {
            emit(AiEvent::Sent(outline_only(kind, settings, model, o)));
        }
        return fail_logged(too_big, line, false, &mut log, &pump, emit);
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
    log.push(
        Level::Info,
        "request",
        &[
            ("provider", kind.id().into()),
            ("model", model.id.clone()),
            ("host", host.clone()),
            ("bytes", sent_bytes.to_string()),
            ("tokens", tokens.to_string()),
            ("tools", "none".into()),
            ("cache", if picks.caching { "on" } else { "off" }.into()),
            ("thinking", format!("{:?}", picks.thinking).to_lowercase()),
        ],
    );
    pump.drain(emit);
    emit(AiEvent::Sent(SentRecord {
        at: now_ms(),
        kinds: preview
            .items
            .iter()
            .filter(|i| i.on && i.locked.is_none())
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
        summary_call: false,
        outline,
        exact: settings.keep_exact_text.then(|| preview.exact.clone()),
    }));
    emit(AiEvent::Process(request_step(
        log.elapsed_ms(),
        sent_bytes,
        base.as_ref(),
    )));

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
        }
    };
    let result = {
        let streaming = provider.stream(&chat, &mut log, &mut sink);
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
    let usage = a.usage.unwrap_or_default();
    let stop = if a.capped {
        StopReason::TooLong
    } else {
        a.stop.unwrap_or(StopReason::Dropped)
    };
    let failed = result.as_ref().err().filter(|_| !a.capped);
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
                if failed.is_some() {
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
    let partial = failed.is_some();
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
    let counts = format!(
        "{} characters, {} output tokens",
        grouped(a.chars as u64),
        grouped(u64::from(usage.output))
    );
    if !partial {
        emit(AiEvent::Process(ProcessStep {
            step: StepKind::Answer,
            at_ms: log.elapsed_ms(),
            value: format!(
                "{}, by the model",
                count_of(sql_blocks.len(), "SQL block", "SQL blocks")
            ),
            rule: format!("{counts}."),
            evidence: Vec::new(),
            by_model: true,
            left_out: None,
        }));
    } else if received {
        emit(AiEvent::Process(ProcessStep {
            step: StepKind::Answer,
            at_ms: log.elapsed_ms(),
            value: "partial, by the model".into(),
            rule: format!("{counts}, before the answer failed."),
            evidence: Vec::new(),
            by_model: true,
            left_out: None,
        }));
    }

    match result {
        Err(e) if !a.capped => {
            let partial = a.bytes > 0;
            let line = error_line(&e, partial);
            fail_logged(e, line, partial, &mut log, &pump, emit)
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
            log.push(Level::Info, "database", &[("ran", "nothing".into())]);
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
            });
            Ok(())
        }
    }
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
