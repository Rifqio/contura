import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { answerText, commentedOut } from "../app/queryTabRefs";
import Kbd from "../components/Kbd";
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
import AnswerText, { firstSql } from "./AnswerText";
import { actionsFor, type AskContext, toAskRequest } from "./context";
import { type InsertTarget, planApply, planInsert } from "./insertPlan";
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
  /**
   * Where the question was asked in the editor (the selection or the statement): an answer's SQL shows there as a
   * diff, kept with Ctrl+Enter and discarded with Esc (A2). Without it, each SQL block keeps its own actions.
   */
  anchor?: InlineAnchor | null;
  /** The last answer on this statement, shown again by Ctrl+I (A4); nothing is asked. */
  reopen?: InlineSnapshot | null;
  /** Hears the answer each time it settles or its suggestion is kept or dropped, so Ctrl+I can bring it back. */
  onSnapshot?(s: InlineSnapshot): void;
}

/** The text an Ask was about, where it was in the editor when asked. */
export interface InlineAnchor {
  from: number;
  to: number;
  sql: string;
  /** The editor's tracked range for the statement, which follows edits above and in it (`SqlEditorApi.track`). */
  track?: number;
}

type Range = { from: number; to: number };

/**
 * Whether Ctrl+I on `sel` reopens `last` (A4): the insertion point is still in the statement it was about, or in what
 * its answer kept. `at` reads a tracked range, so edits above the statement do not matter (M2). Anywhere else Ctrl+I
 * asks afresh.
 */
export function reopens(sel: Range & { sql: string }, last: InlineSnapshot, at: (id: number) => Range | null): boolean {
  const a = last.anchor;
  if (!a) return false;
  // A range that collapsed (its text went) is gone: it never matches the statement next to where it was (N4).
  const within = (r: Range | null) => r !== null && r.from < r.to && r.from <= sel.to && sel.from <= r.to;
  if (a.track !== undefined) return within(at(a.track)) || (last.keptTrack !== null && within(at(last.keptTrack)));
  return sel.from === a.from && sel.sql === a.sql;
}

/** A finished inline answer, kept per query tab so Ctrl+I on the same statement reopens it (A4). */
export interface InlineSnapshot {
  q: string;
  action?: string;
  follow: string[];
  end: StreamEnd;
  startedAt?: number;
  /** What became of its SQL: kept in the editor, not in it, or there was none. */
  state: "kept" | "discarded" | "none";
  /** The text Keep wrote, so the statement it became still counts as the same one. */
  keptText: string | null;
  anchor: InlineAnchor | null;
  /** The editor's tracked range for what Keep wrote, so a follow-up refines it and Ctrl+I finds it (I2). */
  keptTrack: number | null;
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

/** `follow` holds the follow-ups after the first question, each refining the same suggestion (A1). */
type Sug = "waiting" | "kept" | "discarded" | "none";

type Outcome = { q: string; action?: string; follow: string[]; end: StreamEnd | null; tries: number; startedAt?: number };

/** The question an Ask sends: the first one, then each follow-up on its own line. */
const asked = (q: string, follow: readonly string[]) => [q, ...follow.map((f) => `Then: ${f}`)].join("\n");

/** What the box says once an answer's SQL went in. */
const KEPT_TEXT = { inserted: "Kept in the editor. Ctrl+Z takes it back.", insertedCommented: "Kept, commented out. Ctrl+Z takes it back." };

/** The small Ask popover: a question or an action, what it would send, and the answer state. */
export default function InlineAsk({
  context,
  groupId,
  onOpenInChat,
  onOpenSettings,
  onClose,
  insertTarget = null,
  onOpenInNewTab,
  anchor = null,
  reopen = null,
  onSnapshot,
}: Props) {
  const [settings, setSettings] = useState<AiSettingsView | null>(null);
  const [text, setText] = useState("");
  const [off, setOff] = useState<ItemKind[]>([]);
  const [values, setValues] = useState(false);
  const [rows, setRows] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(() =>
    reopen ? { q: reopen.q, action: reopen.action, follow: reopen.follow, end: reopen.end, tries: 1, startedAt: reopen.startedAt } : null,
  );
  /** Brought back by Ctrl+I: says so until the next question. */
  const [reopened, setReopened] = useState(reopen !== null);
  /** The follow-up being typed (A1). */
  const [followText, setFollowText] = useState("");
  /** The answer's SQL in the editor: waiting as a diff, kept, or not there. */
  const [sug, setSugState] = useState<Sug>(
    reopen ? (reopen.state === "kept" ? "kept" : reopen.state === "none" ? "none" : "discarded") : "none",
  );
  const [where, setWhere] = useState("");
  const [keptText, setKeptText] = useState<string | null>(reopen?.keptText ?? null);
  const [keptTrack, setKeptTrack] = useState<number | null>(reopen?.keptTrack ?? null);
  /** The suggestion of ours the editor holds; an end heard for an older one is not ours to act on. */
  const sugToken = useRef(0);
  // Read by the key handlers and the unmount, which may come before the next draw.
  const sugRef = useRef(sug);
  const setSug = (next: Sug) => {
    sugRef.current = next;
    setSugState(next);
  };
  /** What Keep wrote last was commented out: a commented follow-up replaces it. */
  const keptCommented = useRef(reopen?.keptText?.trimStart().startsWith("--") ?? false);
  /** The answer whose SQL was shown already, so a reopened answer is not shown again by itself. */
  const shownFor = useRef<StreamEnd | null>(reopen?.end ?? null);
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

  const followInput = useRef<HTMLInputElement>(null);
  const targetRef = useRef(insertTarget);
  targetRef.current = insertTarget;

  useEffect(() => {
    alive.current = true;
    // A reopened answer puts the caret in Refine, as Cursor's Ctrl+K does: typing goes to the box, not the SQL.
    if (reopen) (followInput.current ?? body.current)?.focus();
    else input.current?.focus();
    return () => {
      alive.current = false;
      // A box that goes takes its waiting suggestion with it: nothing stays in the editor unasked.
      if (sugRef.current === "waiting") targetRef.current?.editor()?.discardSuggestion();
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

  async function ask(question: string, action?: string, before?: Outcome, use?: Use, follow: string[] = before?.follow ?? []) {
    const q = question.trim();
    if (!q || stream.running) return;
    const startedAt = Date.now();
    setShowLog(false);
    setInserted(null);
    setRows(false);
    setReopened(false);
    setOutcome({ q, action, follow, end: null, tries: 0, startedAt });
    const seq = ++askSeq.current;
    const end = await stream.start(request(asked(q, follow), action, use));
    // Esc before anything came put the question back in the field: this Ask is over.
    if (seq !== askSeq.current) return;
    const same = before?.end?.error != null && aiErrorOf(before.end.error)?.kind === aiErrorOf(end.error)?.kind;
    if (alive.current) setOutcome({ q, action, follow, end, tries: same ? before.tries + 1 : 1, startedAt });
  }

  /** Counts the Asks, so one given up (Esc before any text) does not come back when it ends. */
  const askSeq = useRef(0);

  /** Drops our suggestion from the editor if it still waits there. */
  const dropOurs = () => {
    if (sugRef.current !== "waiting") return;
    sugToken.current++;
    insertTarget?.editor()?.discardSuggestion();
    setSug("discarded");
  };
  const close = () => {
    dropOurs();
    onClose();
  };
  const keepOurs = () => {
    if (sugRef.current !== "waiting") return false;
    return insertTarget?.editor()?.keepSuggestion() ?? false;
  };

  // Esc stops an answer being written; else it discards a waiting suggestion and closes, or closes (A2, A4).
  // Ctrl+Enter keeps a waiting suggestion, wherever the keyboard is in the box.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (stream.running && !stream.text && outcome && outcome.follow.length === 0) {
        // Esc while asking: stop, and the question goes back in the field to change and send again (board, M7).
        askSeq.current++;
        stream.stop();
        askAgain(outcome.action ? "" : outcome.q);
      } else if (stream.running) stream.stop();
      else close();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && sugRef.current === "waiting") {
      e.preventDefault();
      e.stopPropagation();
      keepOurs();
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
    dropOurs();
    stream.reset();
    setOutcome(null);
    setInserted(null);
    setReopened(false);
    setSug("none");
    setKeptText(null);
    setKeptTrack(null);
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

  // ---- The answer's SQL in the editor (A2) ----
  const finished = end && !stream.running && end.error == null && !end.stopped && end.done ? end : null;
  const first = useMemo(() => (finished ? firstSql(finished.text, finished.done?.sqlBlocks) : null), [finished]);
  const inEditor = anchor !== null && insertTarget !== null && first !== null;
  const writes = !!first?.check?.statements.some((x) => x.class === "write" || x.flags.some((f) => f.kind === "writeInReadAnswer"));
  const commented = !!first && (first.unchecked || writes);

  /** Shows the answer's SQL in the editor as a diff over what was asked about; a write goes below it, commented out. */
  const showInEditor = () => {
    const ed = insertTarget?.editor();
    if (!ed || !insertTarget || !first) return;
    const sql = commented ? commentedOut(answerText(first.sql)) : answerText(first.sql);
    const doc = ed.text();
    const stmts = ed.statements();
    // After Keep, a follow-up refines what was kept, wherever the insertion point has gone since (I2).
    // A range whose text went (it collapsed) is gone, never a pointer at the statement beside it (N4).
    const live = (r: Range | null) => (r && r.from < r.to ? r : null);
    const kept = sugRef.current === "kept" && keptTrack !== null ? live(ed.tracked(keptTrack)) : null;
    // Else the statement asked about, followed through edits; without a tracked range, the text if it is still there.
    const tracked = anchor?.track !== undefined ? live(ed.tracked(anchor.track)) : null;
    const at = kept ?? tracked ?? (anchor && doc.slice(anchor.from, anchor.to) === anchor.sql ? { from: anchor.from, to: anchor.to } : ed.selection());
    // A commented block replaces the one kept before it, never adds a second; any other write goes below.
    const plan =
      commented && !(kept && keptCommented.current)
        ? planInsert(doc, { from: at.to, to: at.to }, stmts, insertTarget.name, sql, ed.dialect())
        : planApply(doc, at, stmts, insertTarget.name, sql, ed.dialect());
    if (!plan) {
      setSug("discarded");
      return;
    }
    const token = ++sugToken.current;
    const kind = commented ? "insertedCommented" : "inserted";
    setWhere(plan.where);
    setSug("waiting");
    ed.suggest({
      from: plan.from,
      to: plan.to,
      text: plan.text,
      where: plan.where,
      keepLabel: commented ? "Keep, commented out" : "Keep",
      bar: false,
      focus: false,
      onEnd: (how, range) => {
        if (!alive.current || token !== sugToken.current) return;
        if (how === "kept") {
          if (range) {
            if (keptTrack !== null && ed.tracked(keptTrack)) ed.retrack(keptTrack, range.from, range.to);
            else setKeptTrack(ed.track(range.from, range.to));
          }
          keptCommented.current = commented;
          setSug("kept");
          setKeptText(plan.text);
          setInserted(kind);
        } else setSug("discarded");
      },
    });
  };
  const showRef = useRef(showInEditor);
  showRef.current = showInEditor;
  // A new answer with SQL shows in the editor by itself, in place of the one before (A1: the diff updates in place).
  useEffect(() => {
    if (!finished || shownFor.current === finished) return;
    shownFor.current = finished;
    if (inEditor) showRef.current();
    else setSug("none");
    followInput.current?.focus();
  }, [finished, inEditor]);

  // The answer as it settles, and what became of its SQL, for Ctrl+I to bring back (A4).
  const snapRef = useRef(onSnapshot);
  snapRef.current = onSnapshot;
  useEffect(() => {
    if (!outcome?.end || stream.running) return;
    snapRef.current?.({
      q: outcome.q,
      action: outcome.action,
      follow: outcome.follow,
      end: outcome.end,
      startedAt: outcome.startedAt,
      state: sug === "kept" ? "kept" : sug === "none" ? "none" : "discarded",
      keptText,
      anchor,
      keptTrack,
    });
  }, [outcome, sug, keptText, keptTrack, stream.running]);

  const followUp = () => {
    const t = followText.trim();
    if (!t || !outcome || stream.running) return;
    setFollowText("");
    void ask(outcome.q, undefined, undefined, undefined, [...outcome.follow, t]);
  };
  const canFollow = !showLog && !!outcome && !stream.running && !!end && end.error == null;
  const shown = streamText || (stream.running ? "" : (end?.text ?? ""));

  const doneId = useId();
  const insertedText = inserted ? KEPT_TEXT[inserted] : "";
  const onAction = (kind: AnswerActionKind) => {
    if (kind === "openedInNewTab") return;
    setInserted(kind);
  };
  const openNew = () => {
    if (!onOpenInNewTab || !first) return;
    onOpenInNewTab(commented ? commentedOut(answerText(first.sql)) : first.sql, context.connection);
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
          <button type="button" className="icon-button" aria-label="Close" title="Close (Esc)" onClick={close}>
            <Icon name="close" />
          </button>
        </div>
      )}
      <div className="pop-head" hidden={inserted !== null}>
        <span>{outcome ? outcome.q : "Ask about the selection"}</span>
        <span className="prov">{provider ? `${providerName} · ${settings?.settings.model}` : "No provider"}</span>
        <button type="button" className="icon-button" aria-label="Close" title="Close (Esc)" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      <div ref={body} className="pop-body" tabIndex={-1} hidden={inserted !== null}>
        {reopened && <p className="pop-reopened">Reopened with Ctrl+I: the last answer on this statement.</p>}
        {outcome && outcome.follow.length > 0 && <p className="pop-turns">{outcome.follow.map((f) => `Then: ${f}`).join(" · ")}</p>}
        {outcome && showLog && (
          <AnswerLog
            question={outcome.q}
            answer={shown}
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
        {!showLog && outcome && shown && (
          <div className="answer-body">
            <AnswerText
              text={shown}
              streaming={stream.running}
              blocks={end?.done?.sqlBlocks}
              notes={end?.done?.notes}
              dialect={context.connection?.dialect ?? "postgres"}
              target={insertTarget}
              onOpenInNewTab={onOpenInNewTab && ((sql) => onOpenInNewTab(sql, context.connection))}
              onCopy={(sql) => void navigator.clipboard?.writeText(sql).catch(() => {})}
              onAction={onAction}
              bareFence={inEditor ? (first?.fence ?? null) : null}
            />
          </div>
        )}
        {!showLog && inEditor && !stream.running && (
          <div className="pop-sql">
            {commented && (
              <p className="pop-writes" role="note">
                <strong>{writes ? "Answer writes." : "Not checked."}</strong> It goes in below the statement, commented out, so
                Run cannot pick it up by accident.
              </p>
            )}
            <p className="pop-where">
              {sug === "waiting" ? `${where}. Nothing runs: you press Run when ready.` : sug === "kept" ? "Kept in the editor." : "Not in the editor."}
            </p>
            <div className="pop-sql-acts">
              {sug === "waiting" && (
                <>
                  <button type="button" className="button button-small button-primary" onClick={keepOurs}>
                    {commented ? "Keep, commented out" : "Keep"} <Kbd keys="Ctrl+Enter" />
                  </button>
                  <button type="button" className="button button-small" onClick={dropOurs}>
                    Discard <Kbd keys="Esc" />
                  </button>
                </>
              )}
              {(sug === "discarded" || sug === "none") && (
                <button type="button" className="button button-small button-primary" onClick={showInEditor}>
                  {commented ? "Insert below, commented out" : "Apply to the statement"}
                </button>
              )}
              <span className="spacer" />
              {onOpenInNewTab && (
                <button type="button" className="button button-small button-ghost" onClick={openNew}>
                  {commented ? "Open in new query tab, commented out" : "Open in new query tab"}
                </button>
              )}
            </div>
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
        {canFollow && (
          <input
            ref={followInput}
            className="ask-input pop-follow"
            type="text"
            aria-label="Follow-up"
            placeholder="Refine it: only active customers, top 20…"
            value={followText}
            onChange={(e) => setFollowText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                followUp();
              }
            }}
          />
        )}
      </div>
      <div className="pop-foot" hidden={inserted !== null}>
        {stream.running && (
          <button type="button" className="button button-small" onClick={() => stream.stop()}>
            Stop
          </button>
        )}
        {outcome && !stream.running && (
          <button type="button" className="button button-small" onClick={() => askAgain("")}>
            New question
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
