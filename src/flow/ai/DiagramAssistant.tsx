// The Assistant side of the diagram tab's side panel (board 11.5, scenes idle, working, review, auto and ask):
// the diagram's thread, the composer with its scope, "Review first" or "Auto-apply", the model and Send, and
// each answer's proposal as its card, its remove question or what landed. Board 11.12 adds the Sends line from the
// Core's preview, the Sent line and Show log under each answer, and the note when the tool is off in Settings. No
// hover text: aria-labels only.
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { aiSettingsChanged } from "../../api/changes";
import { aiAnswerRecord, aiKnownModels, aiSettings, errorText, setAiModelPrefs } from "../../api/client";
import type { AiMessage, AiSettingsView, AnswerRecord, FlowAssistMode, ModelList, ModelPicks, Preview } from "../../api/types";
import AnswerLog from "../../assistant/AnswerLog";
import { mainNeverLeft, providerName as nameOf, recordError, recordOf, sentLine } from "../../assistant/answerRecord";
import answerState, { aiErrorOf } from "../../assistant/answerState";
import { type TextStore, useStoreText } from "../../assistant/answerStream";
import AnswerText from "../../assistant/AnswerText";
import ModelPicker from "../../assistant/ModelPicker";
import Sends from "../../assistant/Sends";
import SentRecord from "../../assistant/SentRecord";
import Icon from "../../components/Icon";
import Kbd from "../../components/Kbd";
import Menu from "../../components/Menu";
import type { DiagramKind } from "../../lang/flow/model";
import { earlierLabel, SHOWN_TURNS, turnWindow } from "../../assistant/turnWindow";
import { foldedOutcome, outcomeText } from "./proposal";
import ProposalCard, { BrokenCard, PickCard, StaleCard } from "./ProposalCard";
import RemoveDialog from "./RemoveDialog";
import { type AskOptions, type DiagramAsk, firstAmbiguous } from "./useDiagramAsk";

interface Props {
  ai: DiagramAsk;
  /** The diagram's name: `<name>.flow`. */
  name: string;
  kind: DiagramKind | null;
  /** The canvas selection, for the "<n> selected" scope. */
  selected: string[];
  mode: FlowAssistMode;
  onMode(mode: FlowAssistMode): void;
  /** Switches to the Editor and bands these 1-based lines. */
  onShowText(lines: number[]): void;
  /** One undo in the diagram's history. */
  onUndo(): void;
  /**
   * The Assistant is in view (the tab on top, the pane shown): the AI settings are read again each time, as they may
   * have changed in Settings, and the Sends line is built only then.
   */
  active?: boolean;
  /** Open Settings on the tool-off note: the AI settings' tools table. */
  onOpenSettings?(): void;
}

/** How long typing, the selection or the text must settle before the Sends line is built again. */
const PREVIEW_MS = 300;

const TOOL_OFF = "The assistant cannot suggest diagram changes: Propose diagram changes is off in Settings.";

const isToolOff = (e: unknown) => aiErrorOf(e)?.kind === "toolOff";

/** Board 11.12, Tool off: the assistant cannot propose anything, so there is no composer; Open Settings goes to the switch. */
function ToolOffNote({ onOpenSettings }: { onOpenSettings?(): void }) {
  return (
    <div className="ccard warnc2 flow-tooloff" role="status">
      <div className="ehead">
        <Icon name="lock" size={14} />
        <span>{TOOL_OFF}</span>
      </div>
      {onOpenSettings && (
        <div className="efoot">
          <span className="spacer" />
          <button type="button" className="btn pbtn2" onClick={onOpenSettings}>
            <Icon name="gear" size={14} />
            Open Settings
          </button>
        </div>
      )}
    </div>
  );
}

const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});

/** An answer's text in the assistant's renderer; a diagram answer has no checked SQL. */
function Said({ text, notes, streaming = false }: { text: string; notes?: string[]; streaming?: boolean }) {
  if (!text && !notes?.length) return null;
  return <AnswerText text={text} notes={notes} streaming={streaming} blocks={[]} sqlBlocks={false} dialect="sqlite" onCopy={copy} />;
}

/** The answer being written. Only this follows the text as it streams; `onGrow` runs after each new piece is drawn. */
function LiveSaid({ source, onGrow }: { source: TextStore; onGrow(): void }) {
  const text = useStoreText(source);
  useEffect(() => onGrow(), [text, onGrow]);
  return <Said text={text} streaming />;
}

/** What a provider error says after it. Tool and file-name errors have their one line only. */
function keptNote(kind: string | undefined): string | null {
  if (kind === "badFileName") return null;
  if (kind === "toolRejected" || kind === "badToolInput") return null;
  return "Nothing was changed. Your request is kept below, so you can send it again.";
}

/** The card for an Ask that changed nothing: the file changed on disk, or the assistant's card for the error with Retry. */
function ErrorCard({ error, name, kept, keySaved, tries, onRetry, onDiscard, onAskAgain, onShowLog, onOpenSettings }: { error: unknown; name: string; kept: boolean; keySaved?: boolean; tries?: number; onRetry?(): void; onDiscard?(): void; onAskAgain?(): void; onShowLog?(): void; onOpenSettings?(): void }) {
  const ai = aiErrorOf(error);
  if (ai?.kind === "toolOff") return <ToolOffNote onOpenSettings={onOpenSettings} />;
  // Only the newest failed turn can be discarded or asked again; an older one shows the text alone.
  if (ai?.kind === "fileChanged")
    return <StaleCard file={ai.file || name} line={ai.line} nowReads={ai.nowReads} onDiscard={kept ? onDiscard : undefined} onAskAgain={kept ? onAskAgain : undefined} />;
  const note = kept ? keptNote(ai?.kind) : null;
  return (
    <>
      {answerState(error, { keySaved, tries, onRetry: kept && ai?.kind !== "badFileName" ? onRetry : undefined, onShowLog, onOpenSettings })}
      {note && <p className="answer-p flow-assist-kept">{note}</p>}
    </>
  );
}

export default function DiagramAssistant({ ai, name, kind, selected, mode, onMode, onShowText, onUndo, active = true, onOpenSettings }: Props) {
  const [question, setQuestion] = useState("");
  const [scope, setScope] = useState<"whole" | "selection">("whole");
  const [models, setModels] = useState<ModelList | null>(null);
  /** Why the models could not be listed, or the last pick could not be saved. */
  const [modelError, setModelError] = useState<string | null>(null);
  /** Why the AI settings could not be read. */
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const chat = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  /** Failed turns whose error card the user discarded. */
  const [discarded, setDiscarded] = useState<ReadonlySet<number>>(new Set());
  /** Turns shown beyond the newest `SHOWN_TURNS`, by "Show <n> earlier"; back to none on each Ask. */
  const [more, setMore] = useState(0);
  const mounted = useRef(Date.now());
  const { thread, working, waiting, landed, failure } = ai;
  const messages = thread?.messages ?? [];
  const shown = turnWindow(messages, SHOWN_TURNS + more);
  /** Answers before this one are older than the newest turns: a proposal card there shows as one line. */
  const foldBefore = turnWindow(messages, SHOWN_TURNS).first;
  const threadId = thread?.id;
  useEffect(() => setMore(0), [threadId]);
  const n = selected.length;
  const bySelection = scope === "selection" && n > 0;
  /** The global AI settings: the provider for "Show exactly" and the diagram tool's switch. */
  const [settings, setSettings] = useState<AiSettingsView | null>(null);
  /** The Core's preview of the Ask in the composer, or why it could not be built. */
  const [sends, setSends] = useState<{ preview: Preview | null; error: unknown }>({ preview: null, error: null });
  /** The answer whose log takes the panel's place, by its time. */
  const [logAt, setLogAt] = useState<number | null>(null);
  /** The answer whose Sent record is open, by its time. */
  const [sentOpen, setSentOpen] = useState<number | null>(null);
  /** Full records of trimmed answers, fetched for Show log and the Sent record, by time; or why one could not be. */
  const [full, setFull] = useState<ReadonlyMap<number, AnswerRecord | string>>(new Map());

  const toolOn = settings?.settings.diagramTool ?? true;
  // The Core refused for the switch (it was turned off after the tab read it): the same note, until it is read on again.
  const off = !toolOn || isToolOff(sends.error) || isToolOff(failure?.error);
  const refused = useRef({ sends: sends.error, failure });
  refused.current = { sends: sends.error, failure };

  // Read each time the Assistant comes into view: the switch may have changed in Settings meanwhile. A refusal seen
  // before this read gives way when the switch reads on now.
  useEffect(() => {
    if (!active) return;
    let live = true;
    const before = refused.current;
    aiSettings(null)
      .then((v) => {
        if (!live) return;
        setSettings(v);
        setSettingsError(null);
        if (v.settings.diagramTool === false) return;
        if (isToolOff(before.sends)) setSends((now) => (now.error === before.sends ? { preview: null, error: null } : now));
        if (isToolOff(before.failure?.error) && refused.current.failure === before.failure) ai.clearFailure();
      })
      .catch((e: unknown) => {
        if (live) setSettingsError(`Could not read the AI settings. ${errorText(e)}`);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Diagram Asks use the global settings (plan ruling P7): the model list without a Group. Read again when the
  // settings or the current model are saved anywhere (Settings, the Ask panel), so the picker never goes stale.
  useEffect(() => {
    let live = true;
    let seq = 0;
    const load = () => {
      const mine = ++seq;
      aiKnownModels(null)
        .then((l) => {
          if (!live || mine !== seq) return;
          setModels(l);
          setModelError(null);
        })
        .catch((e: unknown) => {
          if (live && mine === seq) setModelError(errorText(e));
        });
    };
    let settingsSeq = 0;
    const loadSettings = () => {
      const mine = ++settingsSeq;
      aiSettings(null)
        .then((v) => {
          if (!live || mine !== settingsSeq) return;
          setSettings(v);
          setSettingsError(null);
        })
        .catch((e: unknown) => {
          if (live && mine === settingsSeq) setSettingsError(`Could not read the AI settings. ${errorText(e)}`);
        });
    };
    load();
    const off = aiSettingsChanged.on(() => {
      load();
      loadSettings();
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  const model = models?.models.find((m) => m.id === models.current) ?? null;

  // The Sends line: the Core's preview of the Ask as typed, 300 ms after the question, the scope or the text last
  // changed. Never while an Ask runs; the last one stays shown until the next arrives.
  const scopeKey = bySelection ? selected.join("\n") : "";
  const running = working !== null;
  const picksKey = JSON.stringify(model?.picks ?? null);
  useEffect(() => {
    if (running || off || !active) return;
    let live = true;
    const timer = setTimeout(() => {
      ai.preview(question, askOptions()).then(
        (preview) => {
          // No outline of the text yet: no rows, rather than the last text's.
          if (live) setSends({ preview, error: null });
        },
        (error: unknown) => {
          if (live) setSends({ preview: null, error });
        },
      );
    }, PREVIEW_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question, scopeKey, ai.version, ai.preview, model?.id, picksKey, running, off, active]);
  const provider = settings?.settings.provider ?? null;
  const header = provider ? `To ${nameOf(provider)}, ${model?.id ?? settings?.settings.model}.` : "Nothing is sent until a provider is set.";

  // Show log and the Sent record of a trimmed answer need the full stored record first.
  const trimmedAt = [logAt, sentOpen].filter((at): at is number => at !== null && !!messages.find((m) => m.role === "assistant" && m.at === at)?.record?.trimmed && !full.has(at));
  const fetchKey = thread && trimmedAt.length > 0 ? `${thread.id}:${trimmedAt.join(",")}` : null;
  // Only the records on screen are kept (memory); one closed is fetched again when it is opened again.
  useEffect(() => {
    setFull((all) => ([...all.keys()].every((at) => at === logAt || at === sentOpen) ? all : new Map([...all].filter(([at]) => at === logAt || at === sentOpen))));
  }, [logAt, sentOpen, threadId]);
  useEffect(() => {
    if (!fetchKey || !thread) return;
    let live = true;
    for (const at of trimmedAt) {
      aiAnswerRecord(thread.id, at).then(
        (r) => live && setFull((m) => new Map(m).set(at, r ? (recordOf(r) as AnswerRecord) : "This answer's record is no longer stored.")),
        (e: unknown) => live && setFull((m) => new Map(m).set(at, errorText(e))),
      );
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchKey]);
  /** An answer's record for its log and Sent record: the full one, a load message, or the stored one. */
  const fullRecord = (m: AiMessage): AnswerRecord | string | null => {
    const r = recordOf(m.record);
    if (!r?.trimmed) return r;
    return full.get(m.at) ?? "Loading the log...";
  };

  function pickModel(id: string, picks: ModelPicks) {
    setModels((l) => l && { ...l, current: id, models: l.models.map((m) => (m.id === id ? { ...m, picks } : m)) });
    setModelError(null);
    void setAiModelPrefs(null, id, picks).catch((e: unknown) => setModelError(`Could not save the model pick. ${errorText(e)}`));
  }

  // An Ask that left nothing gives its question back to the composer.
  useEffect(() => {
    if (!failure) return;
    setQuestion((q) => q || failure.q);
  }, [failure]);

  // A turn that ended in an error before it was answered gives its question back to the composer.
  const lastMessage = messages[messages.length - 1];
  const lastAsked = messages[messages.length - 2];
  const lastFailedAt = lastMessage?.role === "assistant" && lastAsked?.role === "user" && !lastMessage.text && !lastMessage.record?.toolUse && lastMessage.at >= mounted.current && aiErrorOf(lastMessage.record ? recordError(recordOf(lastMessage.record)!) : null) ? lastMessage.at : null;
  useEffect(() => {
    if (lastFailedAt !== null && lastAsked) setQuestion((q) => q || lastAsked.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastFailedAt]);

  // The newest turn stays in view.
  const turns = thread?.messages.length ?? 0;
  const toEnd = useCallback(() => {
    const el = chat.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(toEnd, [turns, waiting, landed, toEnd]);

  const askOptions = (): AskOptions => ({ scope: bySelection ? { kind: "selection", names: [...selected] } : { kind: "whole" }, model: model?.id ?? null, picks: model?.picks ?? null });

  function send() {
    const q = question.trim();
    if (!q || working || waiting) return;
    // A new question starts its own count.
    retried.current = null;
    setQuestion("");
    setMore(0);
    void ai.send(q, askOptions());
  }

  /**
   * How many times in a row each failure shown happened, by the failure (or its turn's time): a Retry of a failure
   * whose next one is of the same kind counts on, so a second rate limit in a row does not retry on its own (P11-24).
   */
  const triesOf = useRef(new Map<unknown, number>());
  /** The failure a Retry was sent for, until the next failure is counted. */
  const retried = useRef<{ kind: string | undefined; tries: number } | null>(null);
  const triesFor = (id: unknown, error: unknown): number => {
    const known = triesOf.current.get(id);
    if (known !== undefined) return known;
    const before = retried.current;
    const n = before && before.kind === aiErrorOf(error)?.kind ? before.tries + 1 : 1;
    retried.current = null;
    triesOf.current.set(id, n);
    return n;
  };

  // A count is kept only while its failure is on screen: the failure card, or a turn still in the thread.
  useEffect(() => {
    const ats = new Set(messages.map((m) => m.at));
    for (const id of [...triesOf.current.keys()]) if (id !== failure && !(typeof id === "number" && ats.has(id))) triesOf.current.delete(id);
  }, [messages, failure]);

  // An answer that did not fail ends the run of failures: a later one, on any path, is the first again (P11-24).
  const newest = messages[messages.length - 1];
  const newestRecord = newest?.role === "assistant" ? recordOf(newest.record) : null;
  const answered = newestRecord !== null && recordError(newestRecord) === null;
  useEffect(() => {
    if (answered) retried.current = null;
  }, [answered, newest]);

  /** The same question again, from an error card; the composer gives it up. */
  function retry(q: string, error?: unknown, tries = 1) {
    if (working || waiting) return;
    retried.current = { kind: aiErrorOf(error)?.kind, tries };
    setQuestion("");
    setMore(0);
    void ai.send(q, askOptions());
  }

  /** The text is read again from disk first, then the same question goes on it. */
  function askAgain(q: string, opts: AskOptions) {
    if (working) return;
    retried.current = null;
    setQuestion("");
    setMore(0);
    void ai.askAgain(q, opts);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  function answer(m: AiMessage) {
    const record = recordOf(m.record);
    const tool = m.record?.toolUse ?? null;
    const failed = record ? recordError(record) : null;
    const at = messages.indexOf(m);
    const asked = at > 0 && messages[at - 1].role === "user" ? messages[at - 1].text : null;
    // Only the newest failed turn can be tried again.
    const newest = at === messages.length - 1 && !working && !waiting && !failure && asked !== null && !discarded.has(m.at);
    const live = waiting && waiting.threadId === thread?.id && waiting.messageAt === m.at ? waiting : null;
    if (live?.step === "remove" && ai.removal) {
      return <RemoveDialog shapes={ai.removal.shapes} lines={ai.removal.lines} tables={ai.removal.tables} adds={ai.removal.adds} onCancel={ai.rejectAll} onReview={ai.reviewEach} onRemove={ai.removeAll} />;
    }
    return (
      <>
        <Said text={m.text} notes={record?.notes} />
        {failed !== null && !discarded.has(m.at) && (
          <ErrorCard
            error={failed}
            name={name}
            keySaved={settings?.keySaved}
            kept={newest}
            tries={triesFor(m.at, failed)}
            onRetry={() => asked !== null && retry(asked, failed, triesFor(m.at, failed))}
            onDiscard={() => setDiscarded((d) => new Set([...d, m.at]))}
            onAskAgain={() => asked !== null && askAgain(asked, askOptions())}
            onShowLog={record ? () => setLogAt(m.at) : undefined}
            onOpenSettings={onOpenSettings}
          />
        )}
        {live?.step === "pick" ? (
          <>
            {(() => {
              const c = firstAmbiguous(live.proposal.changes);
              return c && <PickCard change={c} problem={live.problem} onPick={ai.pick} onCancel={ai.rejectAll} />;
            })()}
          </>
        ) : live?.step === "broken" && live.broke ? (
          <BrokenCard file={name} broke={live.broke} onReview={ai.reviewEach} onAskFix={() => ai.askToFix([live.broke!.message])} />
        ) : live?.step === "stale" ? (
          <StaleCard file={name} line={null} nowReads={null} inEditor onDiscard={ai.rejectAll} onAskAgain={() => askAgain(live.q, live.opts)} />
        ) : live ? (
          <>
            <ProposalCard
              changes={live.proposal.changes}
              kind={kind}
              rejected={live.rejected}
              onReject={ai.reject}
              onAccept={ai.accept}
              onRejectAll={ai.rejectAll}
              onAcceptAll={ai.acceptAll}
              onShowText={() => onShowText(ai.lines)}
              onAskFix={ai.askToFix}
            />
            {live.problem && (
              <p className="answer-p flow-assist-problem" role="status">
                {live.problem}
              </p>
            )}
          </>
        ) : landed?.messageAt === m.at ? (
          <div className="flow-landed">
            <p className="answer-p">
              <Icon name="check" size={14} />
              <span>{landed.summary}</span>
            </p>
            <div className="flow-landed-acts">
              {/* Once the landing was undone there is nothing left to undo. */}
              {!landed.undone && (
                <button type="button" className="btn pbtn2" onClick={onUndo}>
                  Undo
                  <Kbd keys="Ctrl+Z" />
                </button>
              )}
              {/* Nor anything to show: the lines it wrote are gone. */}
              {!landed.undone && (
                <button type="button" className="btn pbtn2" onClick={() => onShowText(landed.lines)}>
                  Show in the text
                </button>
              )}
            </div>
          </div>
        ) : tool && at < foldBefore ? (
          <p className="answer-p flow-assist-outcome">{foldedOutcome(tool.proposal.changes, tool.outcome)}</p>
        ) : tool ? (
          <ProposalCard changes={tool.proposal.changes} kind={kind} outcome={tool.outcome ? outcomeText(tool.proposal.changes, tool.outcome) : null} />
        ) : failed === null && record?.mark !== "stopped" ? (
          <p className="answer-p flow-assist-none">No changes proposed.</p>
        ) : null}
        {record && foot(m, record, failed)}
      </>
    );
  }

  /**
   * Under an answer (board 11.12): Show log, unless its error card carries it, and the Sent line, which opens the
   * Sent record.
   */
  function foot(m: AiMessage, record: AnswerRecord, failed: unknown) {
    const errorKind = failed !== null && !discarded.has(m.at) ? aiErrorOf(failed)?.kind : undefined;
    // The assistant's error cards carry Show log; the changed-file card and the tool-off note do not.
    const cardHasLog = failed !== null && !discarded.has(m.at) && errorKind !== "fileChanged" && errorKind !== "toolOff";
    const line = sentLine(record, m.at, { tool: true });
    const opened = sentOpen === m.at ? fullRecord(m) : null;
    return (
      <>
        <div className="msg-mark">
          {!cardHasLog && (
            <button type="button" className="link-button" onClick={() => setLogAt(m.at)}>
              Show log
            </button>
          )}
          {line && (
            <button type="button" className="msg-sent" aria-expanded={sentOpen === m.at} onClick={() => setSentOpen((o) => (o === m.at ? null : m.at))}>
              {line}
            </button>
          )}
        </div>
        {typeof opened === "string" ? (
          <p className="msg-notice" role={full.has(m.at) ? "alert" : "status"}>
            {opened}
          </p>
        ) : (
          opened?.sent && <SentRecord sent={opened.sent} usage={opened.usage} notSent={mainNeverLeft(opened)} onClose={() => setSentOpen(null)} hoverText={false} />
        )}
      </>
    );
  }

  const empty = turns === 0 && !working && !off;
  const scopeLabel = bySelection ? `${n.toLocaleString("en-US")} selected` : "Whole diagram";

  // Show log takes the place of the thread and the composer (board 11.12).
  const logMessage = logAt !== null ? messages.find((m) => m.role === "assistant" && m.at === logAt) : undefined;
  if (logMessage) {
    const record = fullRecord(logMessage);
    const at = messages.indexOf(logMessage);
    const asked = at > 0 && messages[at - 1].role === "user" ? messages[at - 1].text : "";
    return (
      <div className="flow-assist">
        {typeof record === "string" || record === null ? (
          <div className="log-loading">
            <button type="button" className="link-button" onClick={() => setLogAt(null)}>
              Back
            </button>
            <p className="msg-notice" role={full.has(logMessage.at) ? "alert" : "status"}>
              {record ?? "This answer has no log."}
            </p>
          </div>
        ) : (
          <AnswerLog
            variant="diagram"
            file={name}
            question={asked}
            answer={logMessage.text}
            record={record}
            providerName={record.sent ? nameOf(record.sent.provider) : provider ? nameOf(provider) : undefined}
            initialStep="toolCheck"
            onBack={() => setLogAt(null)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flow-assist">
      <div ref={chat} className="flow-chat" role="log" aria-label="Assistant conversation">
        {empty && (
          <div className="flow-side-empty">
            <span className="flow-side-empty-title">Ask for a change to {name}.flow</span>
            <span>The assistant edits the text and the drawing together. While it works, the text is read-only.</span>
          </div>
        )}
        {shown.hidden > 0 && (
          <div className="msg-mark">
            <button type="button" className="link-button" onClick={() => setMore((n) => n + SHOWN_TURNS)}>
              {earlierLabel(shown.hidden)}
            </button>
          </div>
        )}
        {messages.slice(shown.first).map((m) =>
          m.role === "user" ? (
            <div key={`u${m.at}`} className="umsg">
              {m.text}
            </div>
          ) : (
            <div key={`a${m.at}`} className="amsg">
              {answer(m)}
            </div>
          ),
        )}
        {working && (
          <>
            <div className="umsg">{working.q}</div>
            <div className="amsg">
              {working.status && (
                <div className="steps">
                  {working.steps.map((t, i) => (
                    <div key={i} className="step done">
                      <span className="sdot2" />
                      {t}
                    </div>
                  ))}
                  <div className="step now">
                    <span className="sdot2" />
                    {working.status}
                  </div>
                </div>
              )}
              <LiveSaid source={ai.streamed} onGrow={toEnd} />
            </div>
          </>
        )}
        {ai.notSaved && (
          <p className="msg-notice" role="alert">
            {ai.notSaved}
          </p>
        )}
        {failure?.note && !working && (
          <p className="msg-notice" role="alert">
            {failure.note}
          </p>
        )}
        {failure && failure.error !== null && !working && (
          <ErrorCard
            error={failure.error}
            name={name}
            keySaved={settings?.keySaved}
            kept
            tries={triesFor(failure, failure.error)}
            onRetry={() => retry(failure.q, failure.error, triesFor(failure, failure.error))}
            onDiscard={() => {
              setQuestion((q) => (q === failure.q ? "" : q));
              ai.clearFailure();
            }}
            onAskAgain={() => askAgain(failure.q, askOptions())}
            onOpenSettings={onOpenSettings}
          />
        )}
        {off && !isToolOff(failure?.error) && <ToolOffNote onOpenSettings={onOpenSettings} />}
      </div>
      {!off && (
        <div className="flow-composer">
          {working ? (
            <div className="flow-working">
              <span>{`Working on ${name}.flow. Stop it to type.`}</span>
              <button type="button" className="btn pbtn2" onClick={ai.stop}>
                Stop
                <Kbd keys="Esc" />
              </button>
            </div>
          ) : (
            <>
              <div className="flow-composer-row">
                <Menu
                  label="What the assistant may change"
                  items={[
                    { key: "whole", label: "Whole diagram", current: !bySelection, onSelect: () => setScope("whole") },
                    { key: "selection", label: `${n.toLocaleString("en-US")} selected`, current: bySelection, disabled: n === 0, onSelect: () => setScope("selection") },
                  ]}
                  trigger={(p) => (
                    <button type="button" className="btn scope" {...p}>
                      {scopeLabel}
                      <Icon name="chevronDown" size={14} />
                    </button>
                  )}
                />
                <div className="seg" role="radiogroup" aria-label="How changes land">
                  {(["review", "auto"] as FlowAssistMode[]).map((m) => (
                    <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? "on" : undefined} onClick={() => onMode(m)}>
                      {m === "review" ? "Review first" : "Auto-apply"}
                    </button>
                  ))}
                </div>
              </div>
              <Sends
                variant="diagram"
                preview={sends.preview}
                error={sends.error === null ? null : errorText(sends.error)}
                header={header}
                onToggle={() => {}}
                withTip={false}
              />
              <div className="cbox">
                <textarea
                  ref={input}
                  className="cin2"
                  aria-label="Describe a change"
                  placeholder="Describe a change"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={onKey}
                />
                <div className="cbar">
                  <Kbd keys="Shift+Enter" />
                  <span>new line</span>
                  <span className="spacer" />
                  {models && model && <ModelPicker list={models} onPick={pickModel} hoverText={false} />}
                  <button type="button" className="btn sendb" aria-label="Send" disabled={!question.trim() || waiting !== null} onClick={send}>
                    <Icon name="arrowUp" size={14} />
                  </button>
                </div>
              </div>
            </>
          )}
          {modelError && !working && (
            <p className="msg-notice" role="alert">
              {modelError}
            </p>
          )}
          {settingsError && !working && (
            <p className="msg-notice" role="alert">
              {settingsError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
