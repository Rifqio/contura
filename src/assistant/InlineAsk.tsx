import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { rowsLine, rowsState, rowsStateLine } from "./payload";
import { aiConfirmKeyHost, aiKnownModels, aiSettings, setAiModelPrefs } from "../api/client";
import type { AiSettingsView, AnswerActionKind, ItemKind, ModelList, ModelPicks, SqlSchema } from "../api/types";
import Icon from "../components/Icon";
import { PROVIDERS } from "../settings/ai/providers";
import { looksLikeSql, parseAnswer } from "./answerMarkdown";
import answerState, { aiErrorOf, answerEnd, endMark, modelToUse } from "./answerState";
import AnswerLog from "./AnswerLog";
import { buildRecord, onlyOutlineLeft, sentLine, streamRecord } from "./answerRecord";
import { type StreamEnd, stopText, useAnswerStream, useStreamText } from "./answerStream";
import AnswerText from "./AnswerText";
import { actionsFor, type AskContext, toAskRequest } from "./context";
import type { InsertTarget } from "./InsertDiff";
import { queueOffline } from "./offlineQueue";
import Sends from "./Sends";
import { sampleReads } from "./StepsView";
import { useAiPreview } from "./usePreview";

interface Props {
  context: AskContext;
  /** Not read: the Core reads the schema for the preview itself. Kept until the callers drop it. */
  schema: SqlSchema | null;
  groupId: string | null;
  /** Absent where there is no panel to open, such as the Schema Builder. */
  onOpenInChat?(seed: { question: string; context: AskContext }): void;
  onOpenSettings(): void;
  onClose(): void;
  /** The query tab the box sits in: Insert works on its editor, through the diff. */
  insertTarget?: InsertTarget | null;
  onOpenInNewTab?(sql: string, connection: AskContext["connection"]): void;
}

const PLACEHOLDER: Record<AskContext["kind"], string> = {
  sql: "Ask about the selected SQL",
  error: "Ask about this error",
  filter: "Describe the rows you want",
  card: "Generate DBML for a loyalty_points table",
  none: "Ask about your SQL or schema",
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The question asked, and how its answer ended once it has. `tries` counts the same failure in a row. */
/** The model a "Use <model>" action asks with. */
type Use = { id: string; picks: ModelPicks };

type Outcome = { q: string; action?: string; end: StreamEnd | null; tries: number; startedAt?: number };

/** The small Ask popover: a question or an action, what it would send, and the answer state. */
export default function InlineAsk({
  context,
  groupId,
  onOpenInChat,
  onOpenSettings,
  onClose,
  insertTarget = null,
  onOpenInNewTab,
}: Props) {
  const [settings, setSettings] = useState<AiSettingsView | null>(null);
  const [text, setText] = useState("");
  const [off, setOff] = useState<ItemKind[]>([]);
  const [values, setValues] = useState(false);
  const [rows, setRows] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [models, setModels] = useState<ModelList | null>(null);
  /** Show log is open in place of the answer. */
  const [showLog, setShowLog] = useState(false);
  /** The answer went into the editor: the card folds to one line so it stops covering the code. */
  const [inserted, setInserted] = useState<"inserted" | "insertedCommented" | null>(null);
  const showAnswer = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  /** Show answer was used: focus goes to the answer, where the arrow keys scroll it. */
  const unfolded = useRef(false);
  /** "Send the saved key to <host>" is on its way. */
  const confirmingRef = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const stream = useAnswerStream();
  // The inline answer is the only thing drawn here, so it follows the text (at most once per frame).
  const { text: streamText } = useStreamText(stream);
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    input.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    aiSettings(groupId)
      .then((v) => live && setSettings(v))
      .catch(() => live && setSettings(null));
    aiKnownModels(groupId)
      .then((l) => live && setModels(l))
      .catch(() => live && setModels(null));
    return () => {
      live = false;
    };
  }, [groupId]);

  // The model the panel picked last is the settings' current model; its picks are remembered with it.
  const model = settings?.settings.provider ? settings.settings.model || null : null;
  const picks = model ? (settings?.settings.modelPrefs[model] ?? null) : null;
  const request = (question: string, action?: string, use?: Use) =>
    toAskRequest(context, question, off, { rows, values }, {
      groupId,
      action,
      model: use?.id ?? model,
      picks: use?.picks ?? picks,
    });
  const previewed = useMemo(
    () => toAskRequest(context, text.trim(), off, { rows, values }, { groupId, model, picks }),
    [context, text, off, rows, values, groupId, model, picks],
  );
  const { preview, error: previewError } = useAiPreview(previewed, context.connection?.access);

  const rowsNow = rowsState(preview);

  const provider = settings?.settings.provider ?? null;
  const providerName = provider ? PROVIDERS[provider].name : undefined;
  const header = provider
    ? `To ${hostOf(settings?.settings.baseUrl ?? "")} (${settings?.settings.model})`
    : "Nothing is sent until a provider is set.";

  const toggle = (kind: ItemKind) => {
    if (kind === "values") {
      setValues((v) => !v);
      return;
    }
    if (kind === "rows") {
      setRows((v) => !v);
      return;
    }
    setOff((o) => (o.includes(kind) ? o.filter((k) => k !== kind) : [...o, kind]));
  };

  async function ask(question: string, action?: string, before?: Outcome, use?: Use) {
    const q = question.trim();
    if (!q || stream.running) return;
    const startedAt = Date.now();
    setShowLog(false);
    setInserted(null);
    setRows(false);
    setOutcome({ q, action, end: null, tries: 0, startedAt });
    const end = await stream.start(request(q, action, use));
    const same = before?.end?.error != null && aiErrorOf(before.end.error)?.kind === aiErrorOf(end.error)?.kind;
    if (alive.current) setOutcome({ q, action, end, tries: same ? before.tries + 1 : 1, startedAt });
  }

  // Esc stops an answer being written; once nothing is running it closes the box.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (stream.running) stream.stop();
      else onClose();
    }
  };

  const end = outcome?.end ?? null;
  const endKind = end?.stopped ? "stopped" : end?.done && end.done.stop !== "end" && end.done.stop !== "tooLong" ? end.done.stop : null;
  const mark = endKind ? endMark(endKind) : end?.done ? stopText(end.done.stop) : null;
  const current = models?.models.find((m) => m.id === model) ?? null;
  const openLog = () => setShowLog(true);
  // The record of this Ask: from how it ended once it has, else as far as the stream got.
  const record = end
    ? { ...buildRecord(end, end.live), millis: end.done?.millis ?? (outcome?.startedAt !== undefined ? end.at - outcome.startedAt : null) }
    : streamRecord(stream);
  const sent = end ? sentLine(record, end.at) : null;

  // A question kept while offline goes out through the shared queue, with the panel's, one at a time.
  const askRef = useRef(ask);
  askRef.current = ask;
  const queuedOutcome = outcome?.end && aiErrorOf(outcome.end.error)?.kind === "offline" ? outcome : null;
  const place = groupId ? `group:${groupId}` : "ungrouped";
  useEffect(() => {
    if (!queuedOutcome) return;
    return queueOffline(`inline:${place}`, () => askRef.current(queuedOutcome.q, queuedOutcome.action, queuedOutcome));
  }, [queuedOutcome, place]);

  /** Back to the question box with `q` in it. */
  const askAgain = (q: string) => {
    stream.reset();
    setOutcome(null);
    setInserted(null);
    setText(q);
    input.current?.focus();
  };

  /** The card of a failed Ask and what its actions do; the inline box has no model menu, Sends list or Stop. */
  const failureCard = (o: Outcome, e: StreamEnd) => {
    const retry = () => void ask(o.q, o.action, o);
    return answerState(e.error, {
      providerName,
      provider,
      keySaved: settings?.keySaved,
      onShowLog: openLog,
      model: current,
      models: models?.models ?? [],
      connectionName: context.connection?.name,
      rowsRead: sampleReads(record),
      host: settings ? hostOf(settings.settings.baseUrl) : undefined,
      partial: e.partial,
      tries: o.tries,
      outlineSent: onlyOutlineLeft(record),
      onOpenSettings,
      onRetry: retry,
      onSendNow: retry,
      onCancelQueued: () => askAgain(o.q),
      onAskAgain: () => askAgain(o.q),
      onUseModel: (id) => {
        const use = modelToUse(id, models?.models ?? [], settings?.settings ?? null);
        setModels((l) => l && { ...l, current: id });
        void setAiModelPrefs(groupId, id, use.picks)
          .then(() => aiSettings(groupId))
          .then((v) => alive.current && setSettings(v))
          .catch(() => {});
        void ask(o.q, o.action, o, use);
      },
      confirmingKeyHost: confirming,
      onConfirmKeyHost: (host) => {
        // A second click while the first confirm is on its way would send the Ask twice.
        if (confirmingRef.current) return;
        confirmingRef.current = true;
        setConfirming(true);
        const settle = () => {
          confirmingRef.current = false;
          if (alive.current) setConfirming(false);
        };
        aiConfirmKeyHost(groupId, host).then(
          () => {
            settle();
            retry();
          },
          (error) => {
            settle();
            if (!alive.current) return;
            const same = aiErrorOf(error)?.kind === aiErrorOf(e.error)?.kind;
            setOutcome({ ...o, end: { ...e, error, partial: false }, tries: same ? o.tries + 1 : 1 });
          },
        );
      },
    });
  };

  const question = outcome?.q ?? text.trim();

  const doneId = useId();
  const insertedText = inserted === "inserted" ? "Inserted into the editor" : inserted ? "Inserted commented out" : "";
  const onAction = (kind: AnswerActionKind) => {
    if (kind === "openedInNewTab") return;
    setInserted(kind);
  };
  // The Insert button is gone with the diff; focus stays in the card so Esc still closes it.
  useEffect(() => {
    if (inserted) showAnswer.current?.focus();
    else if (unfolded.current) {
      unfolded.current = false;
      body.current?.focus();
    }
  }, [inserted]);

  return (
    <div className={inserted ? "ask-pop ask-pop-folded" : "ask-pop"} role="dialog" aria-label="Ask AI" onKeyDown={onKey}>
      {/* Mounted from the start, so screen readers announce the text when it arrives. */}
      <p className="visually-hidden" role="status">
        {insertedText}
      </p>
      {inserted && (
        <div className="pop-done">
          <Icon name="check" size={14} />
          <span className="pop-done-text" id={doneId}>
            {insertedText}
          </span>
          <button
            ref={showAnswer}
            type="button"
            className="link-button"
            aria-describedby={doneId}
            onClick={() => {
              unfolded.current = true;
              setInserted(null);
            }}
          >
            Show answer
          </button>
          <button type="button" className="icon-button" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
      )}
      <div className="pop-head" hidden={inserted !== null}>
        <span>{outcome ? outcome.q : "Ask about the selection"}</span>
        <span className="prov">{provider ? `${providerName} · ${settings?.settings.model}` : "No provider"}</span>
        <button type="button" className="icon-button" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div ref={body} className="pop-body" tabIndex={-1} hidden={inserted !== null}>
        {outcome && showLog && (
          <AnswerLog
            question={outcome.q}
            answer={streamText}
            record={record}
            live={stream.running}
            connection={context.connection?.name ?? null}
            database={context.connection?.database ?? null}
            providerName={record.sent ? PROVIDERS[record.sent.provider].name : providerName}
            onBack={() => setShowLog(false)}
          />
        )}
        {!showLog && outcome === null && (
          <>
            <input
              ref={input}
              className="ask-input"
              type="text"
              aria-label="Question"
              placeholder={PLACEHOLDER[context.kind]}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void ask(text);
                }
              }}
            />
            <div className="acts">
              {actionsFor(context.kind).map((a) => (
                <button key={a.key} type="button" className="act" onClick={() => void ask(a.label, a.key)}>
                  {a.label}
                </button>
              ))}
            </div>
            <Sends
              preview={preview}
              error={previewError}
              header={header}
              onToggle={toggle}
              connection={context.connection ? { name: context.connection.name, access: context.connection.access } : null}
              withTip={false}
            />
            <p className={rowsNow.on ? "sends-note sends-rows-on" : "sends-note"}>{rowsLine(rowsNow, preview?.rows ?? null)}</p>
            {rowsNow.allowed && <p className="sends-note">{rowsStateLine(rowsNow.on)}</p>}
          </>
        )}
        {!showLog && outcome && !streamText && stream.running && <p className="muted">{stream.status ?? "Asking…"}</p>}
        {!showLog && outcome && streamText && (
          <div className="answer-body">
            <AnswerText
              text={streamText}
              streaming={stream.running}
              blocks={end?.done?.sqlBlocks}
              notes={end?.done?.notes}
              dialect={context.connection?.dialect ?? "postgres"}
              target={insertTarget}
              onOpenInNewTab={onOpenInNewTab && ((sql) => onOpenInNewTab(sql, context.connection))}
              onCopy={(sql) => void navigator.clipboard?.writeText(sql).catch(() => {})}
              onAction={onAction}
            />
          </div>
        )}
        {!showLog && endKind && mark && <span className="cutm">{mark}</span>}
        {!showLog && outcome && end && endKind &&
          answerEnd(endKind, {
            sqlMissing: !parseAnswer(end.text).some((b) => b.kind === "code" && b.closed && looksLikeSql(b)),
            output: end.done?.usage?.output ?? null,
            millis: end.done?.millis ?? (outcome.startedAt !== undefined ? end.at - outcome.startedAt : null),
            onRetry: () => void ask(outcome.q, outcome.action),
            onEdit: () => askAgain(outcome.q),
            onShowLog: openLog,
          })}
        {!showLog && outcome && (stream.running || (end && !endKind && end.error == null)) && (
          <div className="msg-mark">
            {!endKind && mark && <span className="msg-stop">{mark}</span>}
            <button type="button" className="link-button" onClick={openLog}>
              Show log
            </button>
            {sent && <span className="msg-notice">{sent}</span>}
          </div>
        )}
        {!showLog && sent && end && (endKind || end.error != null) && <p className="msg-notice">{sent}</p>}
        {!showLog && outcome && end?.error != null && failureCard(outcome, end)}
      </div>
      <div className="pop-foot" hidden={inserted !== null}>
        {stream.running && (
          <button type="button" className="button button-small" onClick={() => stream.stop()}>
            Stop
          </button>
        )}
        {outcome && !stream.running && (
          <button
            type="button"
            className="button button-small"
            onClick={() => {
              stream.reset();
              setOutcome(null);
              setInserted(null);
            }}
          >
            Ask again
          </button>
        )}
        {onOpenInChat && (
          <button
            type="button"
            className="button button-small"
            disabled={!question}
            onClick={() => onOpenInChat({ question, context })}
          >
            Open in chat
          </button>
        )}
      </div>
    </div>
  );
}
