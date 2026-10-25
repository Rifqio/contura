import { Fragment, type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { rowsLine, rowsState } from "./payload";
import {
  aiCompact,
  aiConfirmKeyHost,
  aiKnownModels,
  aiRecordAction,
  aiResync,
  aiSettings,
  aiUndoCompact,
  aiAnswerRecord,
  aiCancelPlace,
  clearAiThreads,
  deleteAiThread,
  errorText,
  getAiThread,
  listAiThreads,
  saveAiSettings,
  saveAiThread,
  setAiModelPrefs,
  appendAiTurn,
  withTurn,
} from "../api/client";
import type {
  AiAccess,
  AiMessage,
  AiSettingsView,
  AiThread,
  AnswerActionKind,
  AnswerRecord,
  Compaction,
  ConnectionConfig,
  ContextInfo,
  DialectKind,
  ItemKind,
  ModelList,
  ModelPicks,
  Preview,
  PreviewItem,
  SqlSchema,
  ThreadSummary,
  Topic,
  TurnStamp,
} from "../api/types";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import { useCommandKeys } from "../commands/useCommandKeys";
import { dayClock } from "../format/units";
import { PROVIDERS, resyncProblem } from "../settings/ai/providers";
import { looksLikeSql, parseAnswer, plainText } from "./answerMarkdown";
import AnswerLog from "./AnswerLog";
import { buildRecord, mainNeverLeft, onlyOutlineLeft, providerName as nameOf, recordError, recordOf, sentLine, streamRecord } from "./answerRecord";
import answerState, { aiErrorOf, answerEnd, endMark, modelToUse } from "./answerState";
import { type AnswerStream, stopText, useAnswerStream, useStreamText } from "./answerStream";
import CompactNote from "./CompactNote";
import ContextMeter, { type MeterPart } from "./ContextMeter";
import { type AskContext, REMOVED_CONNECTION, sharedSchema, toAskRequest, withTabFields } from "./context";
import { queueOffline } from "./offlineQueue";
import ContextLine from "./ContextLine";
import { contextNotice } from "./contextText";
import ModelPicker from "./ModelPicker";
import Sends from "./Sends";
import { saveSendsOpen } from "./sendsFold";
import { sampleReads } from "./StepsView";
import SentRecord from "./SentRecord";
import ThreadHistory from "./ThreadHistory";
import TopicFold, { TopicDivider } from "./TopicFold";
import { groupByTopic } from "./topics";
import { earlierLabel, SHOWN_TURNS, turnWindow } from "./turnWindow";
import AnswerText from "./AnswerText";
import type { InsertTarget } from "./insertPlan";
import SlashCommands, { optionId } from "./SlashCommands";
import { matchSlash, type SlashCommand, slashKey } from "./slash";
import { useTabAsk } from "./tabAsk";
import { useAiPreview } from "./usePreview";
import { onThreadsCleared } from "./threadsCleared";
import { clearSteps, stepsOf, takeSteps, useRecentSteps } from "./recentSteps";


interface Props {
  /** The drafts place key: "ungrouped" or "group:<id>". */
  place: string;
  /** What the place is called, for "Clear all chats in this place". */
  placeName?: string;
  groupId: string | null;
  context: AskContext | null;
  /** The active tab's key: what its screen publishes (`tabAsk.ts`) goes over `context`. */
  tabKey?: string | null;
  /** Not read: the Core reads the schema for the preview itself. Kept until the callers drop it. */
  schema: SqlSchema | null;
  onOpenSettings(): void;
  seed?: { question: string; context: AskContext };
  /** The current Connections, so a seeded question uses the access they have now, not when it was asked. */
  connections?: ConnectionConfig[];
  onClose?(): void;
  /** The query tab an answer's SQL is inserted into, through a diff; nothing runs from the panel (R6.1). */
  insertTarget?: InsertTarget | null;
  /** Opens an answer's SQL in a new query tab on the Ask's Connection. */
  onOpenInNewTab?(sql: string, connection: AskContext["connection"]): void;
  /** The open Connections: Re-sync reads a closed one's catalog only once it is open. All are taken as open when absent. */
  openIds?: ReadonlySet<string>;
  /** Shows the tab with this key (A7); false when it is closed. */
  onShowTab?(key: string): boolean;
}

/** The access chip in the header, in the words of the Connection's AI access setting. */
const ACCESS_CHIP: Record<AiAccess, { text: string; tone: string }> = {
  never: { text: "Nothing", tone: "chip-neutral" },
  schema: { text: "Schema only", tone: "chip-info" },
  schemaQuery: { text: "Schema and query text", tone: "chip-info" },
  schemaQueryRows: { text: "Plus sample rows", tone: "chip-warning" },
};

const NO_CONTEXT: AskContext = { kind: "none", connection: null, tables: [], label: "" };

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `t${Date.now()}${Math.random().toString(36).slice(2)}`;

/** The items a turn records as its context: what was on, without the question and the switches. */
const RECORDED: ReadonlySet<ItemKind> = new Set(["names", "cards", "dbml", "sql", "error", "savedQueries", "tab", "steps"]);

/**
 * "Asked in <label>" above a question asked in another tab than the question before it (spec 6.2); none on the
 * first question, nor for a stamp with no tab.
 */
export function askedInCaption(messages: readonly AiMessage[], i: number): string | null {
  const a = messages[i]?.askedIn;
  if (!a || a.tab === "" || a.label === "") return null;
  for (let j = i - 1; j >= 0; j--) {
    if (messages[j].role !== "user") continue;
    const b = messages[j].askedIn;
    return b && b.tab === a.tab && b.label === a.label ? null : `Asked in ${a.label}`;
  }
  return null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The words of a Sends item in the composer line; the schema counts the tables the Core sends (P11-11). */
function sendsLabel(item: PreviewItem, ctx: AskContext, preview: Preview | null): string {
  const fit = preview?.tables;
  // Full cards and names only go; a fit with no table at all was not worked out, so the focus tables count.
  const offered = fit ? fit.full.length + fit.namesOnly.length + fit.leftOut.length : 0;
  const n = fit && offered > 0 ? fit.full.length + fit.namesOnly.length : ctx.tables.length;
  switch (item.kind) {
    case "question":
      return "your question";
    case "cards":
      return `schema of ${n} ${n === 1 ? "table" : "tables"}`;
    case "sql":
      if (ctx.kind === "filter") return "the filter text";
      // Outside a query tab the SQL is the tab's own: the Visual Query's text, a sync script.
      return ctx.tab && ctx.tab.kind !== "query" ? item.label.toLowerCase() : "the current statement";
    case "error":
      return "the error";
    case "dbml":
      return "the DBML";
    case "rows":
      return item.label;
    default:
      return item.label;
  }
}

/** `fresh` over `known`, by id: a compaction the Core returned wins, one only this panel has seen stays. */
function mergeCompactions(fresh: Compaction[], known: Compaction[]): Compaction[] {
  return [...fresh, ...known.filter((k) => !fresh.some((f) => f.id === k.id))];
}

/** A question being answered: shown below the thread until its answer is saved. */
interface Pending {
  q: string;
  /** When it was asked. */
  at: number;
  included: string[];
  /** "continue" for the Continue button's turn. */
  action?: string;
}

/** A failed Ask, kept for its card and Retry. */
interface Failure {
  error: unknown;
  partial: boolean;
  q: string;
  /** Times in a row this failure happened. */
  tries: number;
  /** The failed turn is in the thread, so a Retry replaces it. */
  saved: boolean;
  /** This attempt is that saved turn; false when a Retry failed before sending, so Show log shows it live. */
  kept: boolean;
  /** The action of the turn ("continue"), so a Retry asks the same way. */
  action?: string;
  /** The saved turn's record, when the card is drawn from it rather than from the stream. */
  record?: AnswerRecord;
}

/** Whose record Show log shows: a saved answer by its time, or the Ask being (or last) streamed. */
type LogOf = { kind: "saved"; at: number } | { kind: "live"; q: string };

/** A folded Topic's preview: its own last answer that has text, as plain text (P11-20). */
function lastAnswerOf(messages: AiMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.text.trim() !== "") return plainText(m.text);
  }
  return undefined;
}

/** True when the answer has no complete SQL block. */
const noSql = (text: string) => !parseAnswer(text).some((b) => b.kind === "code" && b.closed && looksLikeSql(b));

/** What the context meter says is in use, in the words of the composer. */
export function meterParts(preview: Preview | null, ctx: AskContext): MeterPart[] {
  const words: Partial<Record<ItemKind, string>> = {
    names: "schema",
    cards: "schema",
    dbml: "DBML",
    sql: ctx.kind === "filter" ? "filter" : "current statement",
    error: "error",
    savedQueries: "saved queries",
    values: "values",
    rows: "sample rows",
  };
  const out: MeterPart[] = [];
  for (const item of preview?.items ?? []) {
    const label = words[item.kind];
    if (!label || !item.on || item.locked || item.tokens <= 0) continue;
    const same = out.find((p) => p.label === label);
    if (same) same.tokens += item.tokens;
    else out.push({ label, tokens: item.tokens });
  }
  const thread = preview?.memory?.tokens ?? 0;
  if (thread > 0) {
    // The thread sits between the schema and the current statement, as the composer lists them.
    const at = out.findIndex((p) => p.label === "current statement" || p.label === "filter");
    out.splice(at < 0 ? out.length : at, 0, { label: "thread", tokens: thread });
  }
  return out;
}

/**
 * The answer being written: its thinking, then its text or the Core's status. Only this follows the text as it
 * streams, so a delta never draws the thread's earlier turns again; `onGrow` runs after each new piece is drawn.
 */
function LiveAnswer({ stream, notes, dialect, onCopy, onGrow }: { stream: AnswerStream; notes?: string[]; dialect: DialectKind; onCopy(sql: string): void; onGrow(): void }) {
  const { text, thinking } = useStreamText(stream);
  useEffect(() => onGrow(), [text, thinking, onGrow]);
  return (
    <>
      {thinking && (
        <details className="msg-thinking">
          <summary>Thinking</summary>
          <p>{thinking}</p>
        </details>
      )}
      {text ? <AnswerText text={text} streaming notes={notes} dialect={dialect} onCopy={onCopy} /> : <p className="msg-notice">{stream.status ?? "Sending"}</p>}
    </>
  );
}

function chipLabel(item: PreviewItem, ctx: AskContext): string {
  if (item.kind === "sql" && ctx.tab && ctx.tab.kind !== "query") return item.label;
  if (item.kind === "sql" && ctx.kind !== "filter") return `Selected SQL · lines ${ctx.lines?.[0] ?? 1} to ${ctx.lines?.[1] ?? ctx.sql?.split("\n").length ?? 1}`;
  if (item.kind === "error") return "Error";
  return item.label;
}

export default function AssistantPanel({
  place,
  placeName,
  groupId,
  context,
  tabKey = null,
  onOpenSettings,
  seed,
  connections,
  onClose,
  insertTarget = null,
  onOpenInNewTab,
  openIds,
  onShowTab,
}: Props) {
  /** The questions whose "Asked in" tab was found closed: the caption says so until it shows again (A7). */
  const [closedAsked, setClosedAsked] = useState<ReadonlySet<number>>(() => new Set());
  // Only the active tab is listened to, and its getter is read once per change it publishes, never per draw.
  const published = useTabAsk(seed ? null : tabKey);
  const fields = useMemo(() => published?.get() ?? null, [published]);
  const ctx = useMemo<AskContext>(() => {
    if (!seed) return withTabFields(context ?? NO_CONTEXT, fields, connections ?? []);
    const asked = seed.context;
    const was = asked.connection;
    if (!was || !connections) return asked;
    const live = connections.find((c) => c.id === was.id);
    if (!live) return { ...asked, connection: null };
    return { ...asked, connection: { ...was, name: live.name, access: live.aiAccess } };
  }, [seed, context, fields, connections]);
  const conn = ctx.connection;
  const [settings, setSettings] = useState<AiSettingsView | null>(null);
  /** The place's chats as summaries; the open one is fetched in full. */
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  // A closed-tab note belongs to the thread it was said in.
  useEffect(() => setClosedAsked((all) => (all.size === 0 ? all : new Set())), [currentId]);
  /** The open chat, as the Core last returned it (its records are trimmed). */
  const [current, setCurrent] = useState<AiThread | null>(null);
  /** The open chat's Topics, from the Core's view of it. */
  const [topics, setTopics] = useState<Topic[]>([]);
  /** The open chat's compactions, from the Core's view of it and the Asks run in this panel. */
  const [compactions, setCompactions] = useState<Compaction[]>([]);
  /** The compaction whose Undo is on its way. */
  const [undoing, setUndoing] = useState<string | null>(null);
  /** What a Compact now or "Turn on auto-compact" from the full-thread card is doing, in words; null when neither runs. */
  const [working, setWorking] = useState<string | null>(null);
  /** The closed Topics the user has unfolded (by number). */
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(new Set());
  /** Turns shown beyond the newest `SHOWN_TURNS`, by "Show <n> earlier"; back to none on each Ask and chat opened. */
  const [more, setMore] = useState(0);
  /** Full records of trimmed answers fetched for Show log and the Sent record, by `threadId:at`, and why a fetch failed. */
  const [fullRecords, setFullRecords] = useState<ReadonlyMap<string, AnswerRecord>>(new Map());
  const [fullErrors, setFullErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const fetching = useRef(new Set<string>());
  /** Chats whose last save failed: the next Ask saves them whole, since the Core may lack turns they show. */
  const unsaved = useRef(new Set<string>());
  const [question, setQuestion] = useState("");
  const [off, setOff] = useState<ItemKind[]>([]);
  const [values, setValues] = useState(false);
  const [rows, setRows] = useState(false);
  /** Recent steps left out of this Ask only, from the Sends row; back on after every Ask and on a new context. */
  const [stepsOff, setStepsOff] = useState(false);
  const recent = useRecentSteps(place);
  /** The steps as they go: typed fields only, without the store's count. */
  const steps = useMemo(() => recent.map(({ seq: _seq, ...s }) => s), [recent]);
  const [failure, setFailure] = useState<Failure | null>(null);
  /** Stopped before anything arrived (P11-29): nothing is saved, the question is back in the composer, the card says so. */
  const [stoppedEarly, setStoppedEarly] = useState<{ q: string; millis: number; action?: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  /** Show log is open, in place of the thread. */
  const [logOf, setLogOf] = useState<LogOf | null>(null);
  /** The saved answer, by its time, whose Sent record is open. */
  const [sentOpen, setSentOpen] = useState<number | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [models, setModels] = useState<ModelList | null>(null);
  /** Bumped to open the model menu from a card. */
  const [pickerOpen, setPickerOpen] = useState(0);
  /** The slash list: the active row, the draft it was closed on with Esc, and the requests to the history popover and the Sends list. */
  const slashId = useId();
  const [slashActive, setSlashActive] = useState(0);
  const [slashClosedOn, setSlashClosedOn] = useState<string | null>(null);
  const [historyCommand, setHistoryCommand] = useState({ n: 0, kind: "open" as "open" | "clear" });
  const [sendsOpenSignal, setSendsOpenSignal] = useState(0);
  const sendsRef = useRef<HTMLDivElement>(null);
  /** Pick tables was pressed: the first switch takes focus once the Sends rows are drawn (after the unfold, and the preview). */
  const [pickTablesPending, setPickTablesPending] = useState(false);
  /** "Send the saved key to <host>" is on its way. */
  const confirmingRef = useRef(false);
  const [confirming, setConfirming] = useState(false);
  /** Why the last model pick could not be saved. */
  const [pickError, setPickError] = useState<string | null>(null);
  /** The tokens the provider reported for the last answer (in and out), until the next question is typed. */
  const [answered, setAnswered] = useState<number | null>(null);
  /** Re-sync from the Context line: running, why it did not work, and a count that asks for a new preview. */
  const [resyncing, setResyncing] = useState(false);
  const [resyncError, setResyncError] = useState<string | null>(null);
  const [resyncs, setResyncs] = useState(0);
  /**
   * The AI Context of answers given in this panel, by the answer's time, from their `context` event. The Core writes
   * it into the saved record, which this panel's copy only has after a reload; until then this keeps the failed-check
   * notice on the answer.
   */
  const [liveContexts, setLiveContexts] = useState<ReadonlyMap<number, ContextInfo>>(new Map());
  const stream = useAnswerStream();
  /** Show log on the answer being written follows its text; otherwise the panel does not draw again per delta. */
  const liveLog = useStreamText(stream, logOf?.kind === "live");
  // The AI Context of an answer given here is kept only while its answer is in the open chat.
  useEffect(() => {
    setLiveContexts((all) => {
      if (all.size === 0) return all;
      const ats = new Set(current?.messages.filter((m) => m.role === "assistant").map((m) => m.at) ?? []);
      return [...all.keys()].every((at) => ats.has(at)) ? all : new Map([...all].filter(([at]) => ats.has(at)));
    });
  }, [current]);
  // A finished answer's text, thinking and log are let go once it left the screen (its turn holds them). The card of
  // a failed or stopped Ask and Show log on it keep them until they close.
  const releaseAnswer = stream.release;
  const answerShown = stream.running || pending !== null || failure !== null || stoppedEarly !== null || logOf?.kind === "live";
  useEffect(() => {
    if (!answerShown) releaseAnswer();
  }, [answerShown, releaseAnswer]);
  const { stop: stopAnswer } = stream;
  const placeRef = useRef(place);
  placeRef.current = place;
  const input = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null);
  /** The thread, and whether it follows the newest turn: from each Send until the user scrolls up (P11-15). */
  const threadRef = useRef<HTMLDivElement>(null);
  const follow = useRef(false);
  /** Counts opens, so only the last one's thread lands. */
  const openSeq = useRef(0);
  /** Why a chat could not be opened or cleared, shown where the thread is. */
  const [chatError, setChatError] = useState<string | null>(null);

  /** Opens a chat: the summary list has no messages, so the thread is fetched. */
  function openThread(id: string | null) {
    const seq = ++openSeq.current;
    setChatError(null);
    const show = (thread: AiThread | null, list: Topic[] = [], compacted: Compaction[] = []) => {
      setCurrentId(thread?.id ?? null);
      setCurrent(thread);
      setTopics(list);
      setCompactions(compacted);
      setUndoing(null);
      setUnfolded(new Set());
      setMore(0);
      setFailure(null);
      setStoppedEarly(null);
      setLogOf(null);
      setSentOpen(null);
    };
    if (id === null) {
      show(null);
      return;
    }
    // The previous chat stays open until the new one has arrived.
    getAiThread(id).then(
      (v) => {
        if (openSeq.current !== seq) return;
        if (v) {
          show(v.thread, v.topics, v.compactions);
          return;
        }
        setThreads((all) => all.filter((t) => t.id !== id));
        setChatError("That chat is no longer stored.");
      },
      (e: unknown) => {
        if (openSeq.current === seq) setChatError(errorText(e));
      },
    );
  }

  // A Group's threads are its own: entering another place stops its answer, reloads them and starts a clean composer.
  useEffect(() => {
    let live = true;
    stopAnswer();
    setPending(null);
    setLogOf(null);
    setSentOpen(null);
    setConfirmStop(false);
    setThreads([]);
    setCurrentId(null);
    setCurrent(null);
    setTopics([]);
    setCompactions([]);
    setWorking(null);
    setChatError(null);
    openSeq.current++;
    setFailure(null);
    setStoppedEarly(null);
    setOff([]);
    setValues(false);
    setRows(false);
    setStepsOff(false);
    setAnswered(null);
    setFullRecords(new Map());
    setFullErrors(new Map());
    setLiveContexts(new Map());
    listAiThreads(place)
      .then((list) => {
        if (!live) return;
        const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
        setThreads(sorted);
        openThread(sorted[0]?.id ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [place, stopAnswer]);

  // The ages in the Context line and the Sends list move on while the panel stays open.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Clear AI history or Clear all AI data in Settings: this place's threads are gone.
  useEffect(
    () =>
      onThreadsCleared((cleared) => {
        if (cleared !== null && cleared !== placeRef.current) return;
        setThreads([]);
        openThread(null);
        setLiveContexts(new Map());
      }),
    [],
  );

  useEffect(() => {
    let live = true;
    setPickError(null);
    aiSettings(groupId)
      .then((v) => {
        if (live) setSettings(v);
      })
      .catch(() => {
        if (live) setSettings(null);
      });
    aiKnownModels(groupId)
      .then((l) => {
        if (live) setModels(l);
      })
      .catch(() => {
        if (live) setModels(null);
      });
    return () => {
      live = false;
    };
  }, [groupId]);

  const model = models?.models.find((m) => m.id === models.current) ?? null;

  const groupRef = useRef(groupId);
  groupRef.current = groupId;
  /** Counts picks, so only the last one's re-read lands. */
  const pickSeq = useRef(0);
  /**
   * Shows the pick at once, then has the Core remember it and make the model current (ruling 10). When the Core
   * could not save it, the re-read puts the pill back and the line under the composer says why.
   */
  const pickModel = (id: string, picks: ModelPicks) => {
    setModels((l) => l && { ...l, current: id, models: l.models.map((m) => (m.id === id ? { ...m, picks } : m)) });
    setPickError(null);
    const forGroup = groupId;
    const seq = ++pickSeq.current;
    const latest = () => groupRef.current === forGroup && seq === pickSeq.current;
    void setAiModelPrefs(forGroup, id, picks)
      .then(
        () => null,
        (e: unknown) => errorText(e),
      )
      .then(async (failed) => {
        if (failed && latest()) setPickError(`Could not save the model pick. ${failed}`);
        const [l, v] = await Promise.all([aiKnownModels(forGroup), aiSettings(forGroup)]);
        if (!latest()) return;
        setModels(l);
        setSettings(v);
      })
      .catch(() => {});
  };

  // New context, new items. The text itself is left out of the key: typing in the editor must not switch a turned-off item back on.
  const ctxKey = `${conn?.id ?? ""}|${ctx.tab?.kind ?? ""}|${ctx.kind}|${ctx.label}|${conn?.access ?? ""}`;
  const ctxKeyRef = useRef(ctxKey);
  ctxKeyRef.current = ctxKey;
  useEffect(() => {
    void ctxKey;
    setOff([]);
    setValues(false);
    setRows(false);
    setStepsOff(false);
    setAnswered(null);
    setResyncError(null);
  }, [ctxKey]);

  useEffect(() => {
    if (seed) setQuestion(seed.question);
  }, [seed]);

  const switches = useMemo(() => ({ rows, values }), [rows, values]);
  /** What Sends leaves out: the rows switched off, and the Recent steps when their pill is off for this Ask. */
  const offNow = useMemo<ItemKind[]>(() => (stepsOff ? [...off, "steps"] : off), [off, stepsOff]);
  const modelId = model?.id ?? null;
  const picks = model?.picks ?? null;
  const previewed = useMemo(
    () => toAskRequest(ctx, question.trim(), offNow, switches, { groupId, threadId: currentId, model: modelId, picks, steps }),
    [ctx, question, offNow, switches, groupId, currentId, modelId, picks, steps],
  );
  const { preview, error: previewError } = useAiPreview(previewed, `${conn?.access ?? ""}|${resyncs}`);
  useEffect(() => {
    if (!pickTablesPending) return;
    // No preview to pick from: drop the request so a later one never takes focus from what the user does next.
    if (previewError) return setPickTablesPending(false);
    if (!preview) return;
    const pill = sendsRef.current?.querySelector<HTMLElement>(".sends .send-pill[aria-pressed]");
    if (!pill) return;
    setPickTablesPending(false);
    pill.scrollIntoView?.({ block: "nearest" });
    pill.focus();
  }, [pickTablesPending, preview, previewError]);

  /** Re-sync from the Context line: rebuilds the AI Context, then previews again. */
  async function resync() {
    if (!conn || resyncing) return;
    const forKey = ctxKey;
    setResyncing(true);
    setResyncError(null);
    let problem: string | null;
    try {
      // The schema the Ask uses, so Re-sync rebuilds the Context the Ask reads.
      const info = await aiResync(conn.id, conn.database, sharedSchema(ctx.tables));
      problem = resyncProblem(info, openIds ? openIds.has(conn.id) : true);
    } catch (e) {
      problem = errorText(e, conn.dialect);
    }
    setResyncing(false);
    if (ctxKeyRef.current !== forKey) return;
    setResyncError(problem);
    setResyncs((n) => n + 1);
  }

  const provider = settings?.settings.provider ?? null;
  const header = provider
    ? `To ${hostOf(settings?.settings.baseUrl ?? "")} (${settings?.settings.model})`
    : "Nothing is sent until a provider is set.";
  const providerName = provider ? PROVIDERS[provider].name : undefined;
  const accessChip = conn ? ACCESS_CHIP[conn.access] : null;
  /** The tab's Connection is gone: it asks at Nothing under its id, and is not named as if it were there. */
  const removed = !!conn && conn.name === REMOVED_CONNECTION;

  // A compaction made by the Ask that is running: its messages give way to the note at once.
  const liveCompaction = stream.compaction;
  useEffect(() => {
    // What the panel already holds wins: the Core's view may have marked it undone since.
    if (liveCompaction && liveCompaction.threadId === currentId) setCompactions((cs) => mergeCompactions(cs, [liveCompaction]));
  }, [liveCompaction, currentId]);
  const active = useMemo(() => compactions.filter((c) => !c.undone), [compactions]);
  /** The compaction that hides a message, by its Topic and time. */
  const hiddenBy = (m: AiMessage) => active.find((c) => m.topic === c.topic && m.at >= c.firstAt && m.at <= c.lastAt) ?? null;
  /** Where each note stands: at the first message its compaction hides. */
  const noteAt = useMemo(() => {
    const at = new Map<string, number>();
    for (const m of current?.messages ?? []) {
      const c = active.find((x) => m.topic === x.topic && m.at >= x.firstAt && m.at <= x.lastAt);
      if (c && !at.has(c.id)) at.set(c.id, m.at);
    }
    return at;
  }, [active, current]);
  /** The measured tokens of a compaction's summary: its own Sent record, or the one of the Ask that made it. */
  const tokensOf = (c: Compaction): number | null => {
    const own = c.record.sent?.summary;
    if (own?.kind === "compact") return own.tokens;
    if (stream.compaction?.id === c.id && stream.sent?.summary?.kind === "compact") return stream.sent.summary.tokens;
    const after = current?.messages.find((m) => m.role === "assistant" && m.at > c.lastAt);
    const made = recordOf(after?.record)?.sent?.summary;
    return made?.kind === "compact" ? made.tokens : null;
  };
  const modelNameOf = (id: string) => models?.models.find((m) => m.id === id)?.name ?? id;
  // While an Ask runs its compaction shows the figure after it; then the provider's count takes over.
  // The next Ask's estimate counts its summary step too, as the Sends list does (P11-39).
  const nextSend = preview ? preview.tokens + (preview.summary?.on ? preview.summary.tokens : 0) : 0;
  const meterUsed = stream.running && liveCompaction ? liveCompaction.after : (answered ?? nextSend);

  const rowsNow = rowsState(preview);
  const parts = useMemo(() => meterParts(preview, ctx), [preview, ctx]);
  const groups = useMemo(() => groupByTopic(current?.messages ?? [], topics), [current, topics]);
  /** The newest turns are drawn; earlier ones wait behind "Show <n> earlier". */
  const shownTurns = useMemo(() => turnWindow(current?.messages ?? [], SHOWN_TURNS + more), [current, more]);
  // A live Ask that opens a new Topic shows its divider before the question once the Core has said so.
  const liveDivider = stream.memory?.opened === true && (current?.messages.length ?? 0) > 0;

  // After Send the thread keeps the new turn in view as it streams, then its card or the saved answer.
  const turnCount = current?.messages.length ?? 0;
  const followEnd = useCallback(() => {
    const el = threadRef.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(followEnd, [pending, stream.status, failure, stoppedEarly, turnCount, working, followEnd]);
  /** Scrolled up away from the end while it streams: the thread stays where the user put it. */
  const onThreadScroll = () => {
    const el = threadRef.current;
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const toggle = (kind: ItemKind) => {
    if (kind === "values") {
      setValues((v) => !v);
      return;
    }
    if (kind === "rows") {
      setRows((v) => !v);
      return;
    }
    if (kind === "steps") {
      setStepsOff((v) => !v);
      return;
    }
    setOff((o) => (o.includes(kind) ? o.filter((k) => k !== kind) : [...o, kind]));
  };

  /**
   * Streams the answer to `asked` (the composer's question when absent). `again` is the failed or stopped
   * turn being asked again: its saved turn is replaced, and a repeat of its failure counts as "Try 2".
   */
  async function ask(asked?: string, again?: { saved: boolean; failure: Failure | null }, use?: { id: string; picks: ModelPicks }, action?: string) {
    const q = (asked ?? question).trim();
    if (!q) return;
    // A draft like "/compact" is a command, never a question.
    if (matchSlash(q) !== null) return;
    if (working !== null) return;
    if (stream.running) {
      setConfirmStop(true);
      return;
    }
    // The tab's fields as they are now, not as the last bump left them: the DBML being typed, a draft cell just set.
    const now = seed ? ctx : withTabFields(context ?? NO_CONTEXT, published?.get() ?? null, connections ?? []);
    // The trail as it is now; only these go, and only these leave the store once the turn is kept.
    const carried = stepsOf(place);
    const carriedUpTo = carried.reduce((m, s) => Math.max(m, s.seq), 0);
    const request = toAskRequest(now, q, offNow, switches, {
      groupId,
      threadId: currentId,
      model: use?.id ?? modelId,
      picks: use?.picks ?? picks,
      action,
      steps: carried.map(({ seq: _seq, ...s }) => s),
    });
    const included = (preview?.items ?? [])
      .filter((i) => i.on && !i.locked && RECORDED.has(i.kind))
      .map((i) => chipLabel(i, ctx));
    const forPlace = place;
    const base = current;
    const askedAt = Date.now();
    // The tab it was asked in, as it is now: the user may move on while the answer streams.
    const askedTab = tabKey;
    setFailure(null);
    setStoppedEarly(null);
    setConfirmStop(false);
    setAnswered(null);
    setPending({ q, included, at: askedAt, action });
    setMore(0);
    follow.current = true;
    if (asked === undefined) setQuestion("");
    // "Include values" and "Sample rows" are off at the start of every Ask; Recent steps are back on.
    setValues(false);
    setRows(false);
    setStepsOff(false);
    const end = await stream.start(request);
    if (placeRef.current === forPlace) setPending(null);
    const usage = end.done?.usage;
    // What the answer measured: what went in, what was read from the cache, and the answer itself (P11-39).
    if (usage && placeRef.current === forPlace) setAnswered(usage.input + usage.cacheRead + usage.output);

    let saved = again?.saved ?? false;
    // A failure is kept as a turn once something was sent, so its record and card survive a reload.
    const keep = end.done !== null || end.text !== "" || (end.error !== null && end.live.sent !== null);
    if (!keep && asked === undefined && placeRef.current === forPlace) {
      // Nothing came back: the question goes back into the composer.
      setQuestion((now) => now || q);
    }
    if (!keep && end.stopped && end.error === null && placeRef.current === forPlace) {
      // Stopped before anything arrived: the board's "Stopped." card, with nothing saved (P11-29).
      setStoppedEarly({ q, millis: end.at - askedAt, action });
    }
    if (keep) {
      // The steps went with this turn; steps made while it streamed stay for the next Ask.
      if (carriedUpTo > 0) takeSteps(forPlace, carriedUpTo);
      const record = buildRecord(end, end.live);
      record.millis ??= end.at - askedAt;
      const at = await persist(forPlace, base, saved, q, included, askedAt, end.text, end.at, record, request.requestId, end.stamp ?? null, action, askedTab);
      const used = end.live.context;
      if (used) setLiveContexts((all) => new Map(all).set(at, used));
      saved = true;
    }
    if (end.error !== null && placeRef.current === forPlace) {
      const before = again?.failure;
      const same = before && aiErrorOf(before.error)?.kind === aiErrorOf(end.error)?.kind;
      setFailure({ error: end.error, partial: end.partial, q, tries: same ? before.tries + 1 : 1, saved, kept: keep, action });
    }
  }

  /** Saves the turn, replacing the thread's last turn when `replace`; returns the answer's time. */
  async function persist(
    forPlace: string,
    base: AiThread | null,
    replace: boolean,
    q: string,
    included: string[],
    askedAt: number,
    text: string,
    answeredAt: number,
    record: AnswerRecord,
    requestId: string,
    stamp: TurnStamp | null,
    action?: string,
    askedTab: string | null = null,
  ): Promise<number> {
    const at = Math.max(answeredAt, askedAt + 1);
    const stamped = (m: AiMessage): AiMessage =>
      stamp
        ? {
            ...m,
            topic: stamp.topic,
            ...(stamp.connectionId !== null && { connectionId: stamp.connectionId }),
            ...(stamp.database !== null && { database: stamp.database }),
            kinds: stamp.kinds,
            tables: stamp.tables,
            action: stamp.action,
            // Where it was asked goes on the question only.
            // With the key of the tab it was asked in, so the caption can show that tab again (A7).
            ...(m.role === "user" && stamp.askedIn && { askedIn: askedTab ? { ...stamp.askedIn, tabKey: askedTab } : stamp.askedIn }),
          }
        : m;
    // The Core's stamp carries the action; without one the Continue turn is still marked, so its bubble stays muted.
    const asking = (m: AiMessage): AiMessage => (action === "continue" && m.action === undefined ? { ...m, action } : m);
    const add: AiMessage[] = [
      asking(stamped({ role: "user", text: q, context: included, at: askedAt })),
      stamped({ role: "assistant", text, context: [], at, record }),
    ];
    // The open copy keeps the Asked in label only (memory): its summary and steps go to the Core with the turn. The other
    // Connections' ids stay, so a later save of this copy (a failed append) keeps the gate on them.
    const shown = add.map((m) => {
      if (!m.askedIn) return m;
      const { tab, label, also, tabKey: key } = m.askedIn;
      return { ...m, askedIn: { tab, label, summary: "", steps: [], ...(also && also.length > 0 && { also }), ...(key && { tabKey: key }) } };
    });
    const kept = base ? (replace ? base.messages.slice(0, -2) : base.messages) : [];
    const next: AiThread = base
      ? { ...base, messages: [...kept, ...shown], updatedAt: askedAt }
      : { id: newId(), place: forPlace, title: q.length > 40 ? `${q.slice(0, 40)}…` : q, messages: shown, updatedAt: askedAt };
    // Only the new turn goes to the Core, which adds it to the stored thread (memory: the whole thread used to go
    // both ways on each Ask). A chat whose last save failed goes whole once more: the Core may lack turns it shows.
    // The Core's copy replaces ours: it holds the memory stamps and the trimmed records.
    const replaceFrom = base && replace ? base.messages[base.messages.length - 2]?.at : undefined;
    let returned: { thread: (now: AiThread | null) => AiThread; count: number; topics: Topic[]; compactions: Compaction[] } | null;
    if (base && unsaved.current.has(base.id)) {
      returned = await saveAiThread({ ...next, messages: [...kept, ...add] }, requestId).then(
        (v) => ({ thread: () => v.thread, count: v.thread.messages.length, topics: v.topics, compactions: v.compactions }),
        () => null,
      );
    } else {
      const turn = { threadId: next.id, place: next.place, title: next.title, updatedAt: askedAt, messages: add, replaceFrom };
      returned = await appendAiTurn(turn, requestId).then(
        // The open copy may have changed meanwhile (an action kept with an earlier answer): the turn goes after it.
        (v) => ({ thread: (now: AiThread | null) => withTurn(now?.id === v.threadId ? now : base, v, replaceFrom), count: v.messageCount, topics: v.topics, compactions: v.compactions }),
        () => null,
      );
    }
    if (returned) unsaved.current.delete(next.id);
    else unsaved.current.add(next.id);
    if (placeRef.current === forPlace) {
      const row: ThreadSummary = {
        id: next.id,
        place: next.place,
        title: next.title,
        updatedAt: next.updatedAt,
        messages: returned?.count ?? next.messages.length,
        topics: returned?.topics.length ?? 0,
      };
      setThreads((all) => [row, ...all.filter((t) => t.id !== row.id)]);
      setCurrentId(next.id);
      setCurrent((now) => (returned ? returned.thread(now) : next));
      if (returned) {
        setTopics(returned.topics);
        setCompactions((known) => mergeCompactions(returned.compactions, known));
      }
    }
    return at;
  }

  /** Compact now from the full-thread card: the older messages become a summary, then the same Ask goes again. */
  async function compactNow(f: Failure) {
    const threadId = currentId;
    if (!threadId || working !== null) return;
    const forPlace = place;
    setChatError(null);
    setWorking("Compacting the thread");
    let compaction: Compaction;
    try {
      compaction = await aiCompact({ requestId: newId(), place: forPlace, groupId, threadId, model: modelId }, (e) => {
        if (e.type === "status") setWorking(e.step);
      });
    } catch (error) {
      if (placeRef.current !== forPlace) return;
      setWorking(null);
      setFailure({ error, partial: false, q: f.q, tries: 1, saved: f.saved, kept: false, action: f.action });
      return;
    }
    if (placeRef.current !== forPlace) return;
    setWorking(null);
    setCompactions((known) => mergeCompactions([compaction], known));
    void ask(f.q, { saved: f.saved, failure: null }, undefined, f.action);
  }

  /** /compact: Compact now for the open chat, without asking again; a failure is said above the thread. */
  async function compactChat() {
    const threadId = currentId;
    if (!threadId || working !== null || stream.running || undoing !== null) return;
    const forPlace = place;
    setChatError(null);
    setWorking("Compacting the thread");
    let compaction: Compaction;
    try {
      compaction = await aiCompact({ requestId: newId(), place: forPlace, groupId, threadId, model: modelId }, (e) => {
        if (e.type === "status") setWorking(e.step);
      });
    } catch (error) {
      if (placeRef.current !== forPlace) return;
      setWorking(null);
      setChatError(`Could not compact the chat. ${errorText(error)}`);
      return;
    }
    if (placeRef.current !== forPlace) return;
    setWorking(null);
    setCompactions((known) => mergeCompactions([compaction], known));
  }

  /** "Turn on auto-compact" from the full-thread card: saved in the global settings, then the same Ask goes again. */
  async function turnOnAutoCompact(f: Failure) {
    if (working !== null) return;
    const forPlace = place;
    setChatError(null);
    setWorking("Turning on auto-compact");
    try {
      // The switch is the same for every Group, so it is saved with the global settings.
      const global = await aiSettings(null);
      await saveAiSettings(null, { ...global.settings, autoCompact: true }, false, { t: "keep" });
    } catch (error) {
      if (placeRef.current !== forPlace) return;
      setWorking(null);
      setChatError(`Could not turn on auto-compact. ${errorText(error)}`);
      return;
    }
    if (placeRef.current !== forPlace) return;
    setWorking(null);
    void ask(f.q, { saved: f.saved, failure: null }, undefined, f.action);
  }

  /** Undo on a note: the Core brings the messages back and returns the thread; a failure is said where the thread is. */
  async function undoCompaction(c: Compaction) {
    if (undoing !== null || stream.running || working !== null) return;
    const forPlace = place;
    setChatError(null);
    setUndoing(c.id);
    try {
      const v = await aiUndoCompact(c.threadId, c.id);
      if (placeRef.current !== forPlace) return;
      setCurrent(v.thread);
      setTopics(v.topics);
      setCompactions(v.compactions);
    } catch (e) {
      if (placeRef.current === forPlace) setChatError(`Could not undo the compaction. ${errorText(e)}`);
    } finally {
      setUndoing(null);
    }
  }

  /** Keeps what the user did with a saved answer's SQL in its record, here and in the Core (the Diagram's "You:" box). */
  function recordAction(threadId: string, at: number, kind: AnswerActionKind) {
    void aiRecordAction(threadId, at, kind)
      .then((action) => {
        if (!action) return;
        setCurrent((t) =>
          t === null || t.id !== threadId
            ? t
            : {
                ...t,
                messages: t.messages.map((m) => {
                  const r = m.role === "assistant" && m.at === at ? recordOf(m.record) : null;
                  return r ? { ...m, record: { ...r, actions: [...r.actions, action] } } : m;
                }),
              },
        );
      })
      .catch(() => {});
  }

  /** Clear all chats: a failed delete keeps the list, since the chats are still stored. */
  async function clear() {
    try {
      await clearAiThreads(place);
    } catch (e) {
      setChatError(errorText(e));
      return;
    }
    clearSteps(place);
    setThreads([]);
    openThread(null);
  }

  /** Clear this chat: the open chat is deleted and a new one starts. */
  async function clearThread() {
    const id = currentId;
    if (!id) return;
    try {
      await deleteAiThread(id);
    } catch (e) {
      setChatError(errorText(e));
      return;
    }
    setThreads((all) => all.filter((t) => t.id !== id));
    openThread(null);
  }

  const newChat = () => {
    if (!stream.running) openThread(null);
  };
  useCommandKeys({ "assistant.newChat": newChat }, { region: panel });

  // Show log and the Sent record of a trimmed answer need the full stored record first.
  const trimmedKey = (at: number | null) => {
    if (at === null || !current) return null;
    const m = current.messages.find((x) => x.role === "assistant" && x.at === at);
    return m?.record?.trimmed ? `${current.id}:${at}` : null;
  };
  const wantedLog = trimmedKey(logOf?.kind === "saved" ? logOf.at : null);
  const wantedSent = trimmedKey(sentOpen);
  useEffect(() => {
    // Only the records on screen are kept (memory: a full record holds up to 64 KB of thinking, 200 KB of exact text
    // and 500 log lines); one closed is fetched again when it is opened again.
    const shown = (all: ReadonlyMap<string, unknown>) => [...all.keys()].every((k) => k === wantedLog || k === wantedSent);
    const keepShown = <V,>(all: ReadonlyMap<string, V>): ReadonlyMap<string, V> =>
      shown(all) ? all : new Map([...all].filter(([k]) => k === wantedLog || k === wantedSent));
    if (!shown(fullRecords)) setFullRecords(keepShown);
    if (!shown(fullErrors)) setFullErrors(keepShown);
    for (const key of [wantedLog, wantedSent]) {
      if (!key || fullRecords.has(key) || fullErrors.has(key) || fetching.current.has(key)) continue;
      fetching.current.add(key);
      const [threadId, at] = [key.slice(0, key.lastIndexOf(":")), Number(key.slice(key.lastIndexOf(":") + 1))];
      aiAnswerRecord(threadId, at)
        .then(
          (r) => {
            if (r) setFullRecords((all) => new Map(all).set(key, recordOf(r) as AnswerRecord));
            else setFullErrors((all) => new Map(all).set(key, "This answer's record is no longer stored."));
          },
          (e: unknown) => setFullErrors((all) => new Map(all).set(key, errorText(e))),
        )
        .finally(() => fetching.current.delete(key));
    }
  }, [wantedLog, wantedSent, fullRecords, fullErrors]);

  /**
   * Under a saved answer, all from its stored record: the mark and the answer state card (its action only while it is
   * the last turn), the error card of a failed Ask, the Sent line with its record, and Show log.
   */
  const answerFoot = (m: AiMessage, record: AnswerRecord, q: string, last: boolean, action?: string) => {
    const live = last && !stream.running && pending === null;
    const showLog = () => setLogOf({ kind: "saved", at: m.at });
    let card: ReactNode = null;
    const error = recordError(record);
    if (error !== null) {
      // The last failed turn shows the live card below the thread while its failure is in hand.
      if (!(last && failure?.saved)) {
        card =
          live && failure === null
            ? failureCard({ error, partial: m.text !== "", q, tries: 1, saved: true, kept: true, action, record })
            : answerState(error, {
                providerName,
                provider,
                keySaved: settings?.keySaved,
                connectionName: conn?.name,
                rowsRead: sampleReads(record),
                partial: m.text !== "",
                outlineSent: onlyOutlineLeft(record),
                onShowLog: showLog,
              });
      }
    } else if (record.mark && record.mark !== "tooLong" && record.mark !== "failed") {
      card = answerEnd(record.mark, {
        sqlMissing: noSql(m.text),
        // The output tokens it stopped at; without usage, the cap the Core says the request carried. An older record
        // without it says "the model's output limit".
        output: record.usage?.output ?? record.maxTokens ?? undefined,
        millis: record.millis,
        onRetry: live ? () => void ask(q, { saved: true, failure: null }, undefined, action) : undefined,
        onContinue: live && record.mark === "length" ? () => void ask("Continue", undefined, undefined, "continue") : undefined,
        onEdit: live
          ? () => {
              setQuestion(q);
              input.current?.focus();
            }
          : undefined,
        onShowLog: showLog,
      });
    }
    const chip = record.mark && record.mark !== "tooLong" && record.mark !== "failed" ? endMark(record.mark) : null;
    const line = sentLine(record, m.at);
    const hasCard = card !== null || (error !== null && last && failure?.saved === true);
    return (
      <>
        {chip && <span className="cutm">{chip}</span>}
        {card}
        <div className="msg-mark">
          {record.mark === "tooLong" && <span className="msg-stop">{stopText("tooLong")}</span>}
          {!hasCard && (
            <button type="button" className="link-button" onClick={showLog}>
              Show log
            </button>
          )}
          {line && (
            <button
              type="button"
              className="msg-sent"
              aria-expanded={sentOpen === m.at}
              onClick={() => setSentOpen((o) => (o === m.at ? null : m.at))}
            >
              {line}
            </button>
          )}
        </div>
        {sentOpen === m.at && record.sent && sentRecord(m.at, record)}
      </>
    );
  };

  /** The Sent record of a saved answer; a trimmed one shows the fetched full record, or why it could not be loaded. */
  const sentRecord = (at: number, record: AnswerRecord) => {
    const key = record.trimmed && current ? `${current.id}:${at}` : null;
    const full = key ? fullRecords.get(key) : undefined;
    if (key && !full) {
      const err = fullErrors.get(key);
      return (
        <p className="msg-notice" role={err ? "alert" : "status"}>
          {err ?? "Loading the log..."}
        </p>
      );
    }
    const r = full ?? record;
    return r.sent ? <SentRecord sent={r.sent} usage={r.usage} notSent={mainNeverLeft(r)} onClose={() => setSentOpen(null)} /> : null;
  };

  // A question kept while offline goes out through the shared queue: one online event sends the panel's and the inline box's.
  const askRef = useRef(ask);
  askRef.current = ask;
  const offline = failure !== null && aiErrorOf(failure.error)?.kind === "offline" ? failure : null;
  useEffect(() => {
    if (!offline) return;
    return queueOffline(`panel:${place}`, () => askRef.current(offline.q, { saved: offline.saved, failure: offline }, undefined, offline.action));
  }, [offline, place]);

  /** The busy card's "Stop it": every Ask of this place stops (the inline Ask too), then the waiting question goes out. */
  async function stopPlace(f: Failure) {
    const forPlace = place;
    try {
      await aiCancelPlace(forPlace);
    } catch (e) {
      if (placeRef.current === forPlace) setChatError(`Could not stop the answer. ${errorText(e)}`);
      return;
    }
    if (placeRef.current !== forPlace) return;
    void ask(f.q, { saved: f.saved, failure: f }, undefined, f.action);
  }

  /** The question of the thread's last answer that has text: the one a Continue would follow. */
  const cutQuestion = () => {
    const ms = current?.messages ?? [];
    for (let i = ms.length - 1; i > 0; i--) {
      if (ms[i].role === "assistant" && ms[i].text.trim() !== "" && ms[i - 1].role === "user") return ms[i - 1].text;
    }
    return "";
  };

  /** The card of a failed Ask and what its actions do. */
  const failureCard = (f: Failure) => {
    const again = { saved: f.saved, failure: f };
    const retry = () => void ask(f.q, again, undefined, f.action);
    // A Continue's own text is "Continue", which means nothing outside its thread: give back the cut question.
    const giveBack = () => {
      const q = f.action === "continue" ? cutQuestion() : f.q;
      setQuestion((now) => now || q);
    };
    const fit = preview?.tables;
    return answerState(f.error, {
      providerName,
      provider,
      keySaved: settings?.keySaved,
      model,
      models: models?.models ?? [],
      connectionName: conn?.name,
      rowsRead: sampleReads(f.record ?? streamRecord(stream)),
      host: settings ? hostOf(settings.settings.baseUrl) : undefined,
      tables: fit && fit.full.length + fit.namesOnly.length + fit.leftOut.length > 0
        ? fit.full.length + fit.namesOnly.length + fit.leftOut.length
        : undefined,
      partial: f.partial,
      tries: f.tries,
      // The cards that read it say the main request never went; an outline record is one that left.
      outlineSent: !!stream.sent?.outline,
      onShowLog: () => {
        const last = current?.messages[current.messages.length - 1];
        setLogOf(f.saved && f.kept && last?.role === "assistant" ? { kind: "saved", at: last.at } : { kind: "live", q: f.q });
      },
      onOpenSettings,
      onRetry: retry,
      onSendNow: retry,
      onCancelQueued: () => {
        setFailure(null);
        giveBack();
      },
      onUseModel: (id) => {
        const use = modelToUse(id, models?.models ?? [], settings?.settings ?? null);
        pickModel(use.id, use.picks);
        void ask(f.q, again, use, f.action);
      },
      onPickModel: () => setPickerOpen((n) => n + 1),
      onPickTables: () => {
        // The switches are drawn only while Sends is open; open it (remembered, as the chevron does), then focus.
        saveSendsOpen(true);
        setPickTablesPending(true);
      },
      onNewChat: () => {
        openThread(null);
        giveBack();
      },
      onAskAgain: () => {
        setFailure(null);
        setQuestion(cutQuestion());
        input.current?.focus();
      },
      onCompactNow: () => void compactNow(f),
      onTurnOnAutoCompact: () => void turnOnAutoCompact(f),
      compacting: working !== null,
      confirmingKeyHost: confirming,
      onConfirmKeyHost: (host) => {
        // A second click while the first confirm is on its way would send the Ask twice.
        if (confirmingRef.current) return;
        confirmingRef.current = true;
        setConfirming(true);
        const forGroup = groupId;
        const settle = () => {
          confirmingRef.current = false;
          setConfirming(false);
        };
        aiConfirmKeyHost(forGroup, host).then(
          () => {
            settle();
            retry();
          },
          (error) => {
            settle();
            if (groupRef.current !== forGroup) return;
            const same = aiErrorOf(error)?.kind === aiErrorOf(f.error)?.kind;
            setFailure({ ...f, error, partial: false, tries: same ? f.tries + 1 : 1 });
          },
        );
      },
      onStop: () => void stopPlace(f),
    });
  };

  // Slash commands: "/" first in the composer, no space yet. Each does what its control does.
  const matches = matchSlash(question);
  const slashOpen = matches !== null && slashClosedOn !== question;
  const slashRow = matches ? Math.min(slashActive, Math.max(0, matches.length - 1)) : 0;
  const lastAnswerAt = (() => {
    const msgs = current?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "assistant" && recordOf(msgs[i].record)) return msgs[i].at;
    return null;
  })();
  const waiting = "Wait until the answer finishes";
  const unavailable: Record<string, string> = {};
  if (!currentId) unavailable.compact = "Nothing to compact yet";
  else if (stream.running || working !== null || undoing !== null) unavailable.compact = waiting;
  if (stream.running) unavailable.new = waiting;
  if (lastAnswerAt === null && !pending) unavailable.log = "No answer yet";
  if (!currentId) unavailable.clear = "No chat to clear";
  else if (stream.running) unavailable.clear = waiting;

  const runSlash = (c: SlashCommand) => {
    if (unavailable[c.name]) return;
    setQuestion("");
    setSlashActive(0);
    setSlashClosedOn(null);
    switch (c.name) {
      case "compact":
        void compactChat();
        break;
      case "new":
        newChat();
        break;
      case "history":
        setHistoryCommand((h) => ({ n: h.n + 1, kind: "open" }));
        break;
      case "model":
        setPickerOpen((n) => n + 1);
        break;
      case "sends":
        setSendsOpenSignal((n) => n + 1);
        break;
      case "log":
        if (lastAnswerAt !== null) setLogOf({ kind: "saved", at: lastAnswerAt });
        else if (pending) setLogOf({ kind: "live", q: pending.q });
        break;
      case "clear":
        setHistoryCommand((h) => ({ n: h.n + 1, kind: "clear" }));
        break;
    }
  };

  /** Send and Enter: a "/word" draft runs its one matching command or does nothing; anything else is an Ask. */
  const send = () => {
    if (matches !== null) {
      if (matches.length === 1) runSlash(matches[0]);
      return;
    }
    void ask();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (slashOpen && matches) {
      const k = slashKey(e.key, slashRow, matches.length);
      if (k !== null) {
        e.preventDefault();
        if (k === "close") {
          // Only the list closes: the draft stays and no outer Esc handler sees the key.
          e.stopPropagation();
          setSlashClosedOn(question);
        }
        else if (k === "run") runSlash(matches[slashRow]);
        else setSlashActive(k.active);
        return;
      }
    }
    if (e.key === "Escape" && stream.running) {
      // "Stop Esc" (board 11.6): Esc where you type stops the answer being written.
      e.preventDefault();
      e.stopPropagation();
      setConfirmStop(false);
      stream.stop();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const liveNotice = contextNotice(stream.context);
  const copySql = (sql: string) => void navigator.clipboard?.writeText(sql).catch(() => {});
  const openInNewTab = onOpenInNewTab && ((sql: string) => onOpenInNewTab(sql, conn));
  // A tab with no editor (Home, a grid, New table, ...): answers open in a new query tab instead (spec 8).
  const noEditor = !insertTarget && !!ctx.tabKind && ctx.tabKind !== "query";

  // Show log replaces the thread and the composer (board 11.3): a saved answer's record, or the Ask being streamed.
  let logView: ReactNode = null;
  if (logOf) {
    const msgs = current?.messages ?? [];
    const i = logOf.kind === "saved" ? msgs.findIndex((m) => m.at === logOf.at && m.role === "assistant") : -1;
    const stored = i >= 0 ? recordOf(msgs[i].record) : null;
    const fullKey = stored?.trimmed && current ? `${current.id}:${logOf.kind === "saved" ? logOf.at : 0}` : null;
    const saved = fullKey ? (fullRecords.get(fullKey) ?? null) : stored;
    const record = saved ?? streamRecord(stream);
    const q = i >= 0 ? (msgs[i - 1]?.role === "user" ? msgs[i - 1].text : "") : logOf.kind === "live" ? logOf.q : "";
    logView = fullKey && !saved ? (
      <div className="log-loading">
        <button type="button" className="link-button" onClick={() => setLogOf(null)}>
          Back
        </button>
        <p className="msg-notice" role={fullErrors.has(fullKey) ? "alert" : "status"}>
          {fullErrors.get(fullKey) ?? "Loading the log..."}
        </p>
      </div>
    ) : (
      <AnswerLog
        question={q}
        answer={i >= 0 ? msgs[i].text : liveLog.text}
        record={record}
        live={saved === null && stream.running}
        connection={conn?.name ?? null}
        database={conn?.database ?? null}
        providerName={record.sent ? nameOf(record.sent.provider) : providerName}
        onBack={() => setLogOf(null)}
      />
    );
  }

  return (
    <aside className="ai-panel" aria-label="Ask" ref={panel} data-pane>
      <header className="ai-panel-head">
        <span className="t">Ask</span>
        {accessChip && conn && (
          <span className={`chip ${accessChip.tone}`} title={`AI access for ${conn.name}`}>
            {accessChip.text}
          </span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="icon-button"
          aria-label="New chat"
          title="New chat  Ctrl+Shift+N"
          disabled={stream.running}
          onClick={newChat}
        >
          <Icon name="plus" size={16} />
        </button>
        <ThreadHistory
          place={place}
          placeName={placeName}
          threads={threads}
          currentId={currentId}
          busy={stream.running}
          onOpen={openThread}
          onNewChat={newChat}
          onClearThread={() => void clearThread()}
          onClearAll={() => void clear()}
          command={historyCommand}
        />
        <button type="button" className="icon-button" aria-label="Close the Ask panel" title="Close  Ctrl+Alt+I" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </header>

      {logView ?? (
      <>
      <div className="thread" aria-live="polite" ref={threadRef} onScroll={onThreadScroll}>
        {chatError && (
          <p className="msg-notice" role="alert">
            {chatError}
          </p>
        )}
        {conn && conn.access === "never" && !current && (
          <div className="setup">
            <span className="t">
              <Icon name="lock" /> AI can't see {conn.name}
            </span>
            <span className="muted">
              {conn.name} shares nothing with AI, so no schema, SQL or rows are sent. You can still ask general
              questions.
            </span>
            <button type="button" className="button button-small" onClick={onOpenSettings}>
              <Icon name="settings" />
              Connection settings
            </button>
          </div>
        )}
        {current && shownTurns.hidden > 0 && (
          <div className="msg-mark">
            <button type="button" className="link-button" onClick={() => setMore((n) => n + SHOWN_TURNS)}>
              {earlierLabel(shownTurns.hidden)}
            </button>
          </div>
        )}
        {groups.map((g, gi) => {
          if (!current) return null;
          const start = groups.slice(0, gi).reduce((n, x) => n + x.messages.length, 0);
          // A Topic wholly before the newest turns waits behind "Show <n> earlier".
          if (start + g.messages.length <= shownTurns.first) return null;
          const folded = g.topic?.closed === true;
          const open = !folded || unfolded.has(g.topic?.seq ?? -1);
          return (
            <Fragment key={`${g.topic?.seq ?? "none"}-${gi}`}>
              {folded && g.topic && (
                <TopicFold
                  topic={g.topic}
                  preview={lastAnswerOf(g.messages)}
                  open={open}
                  onToggle={() =>
                    setUnfolded((u) => {
                      const next = new Set(u);
                      if (!next.delete(g.topic!.seq)) next.add(g.topic!.seq);
                      return next;
                    })
                  }
                />
              )}
              {!folded && g.topic && gi > 0 && <TopicDivider title={g.topic.title} />}
              {open &&
                g.messages.map((m, j) => {
                  const mi = start + j;
                  if (mi < shownTurns.first) return null;
                  const hidden = hiddenBy(m);
                  if (hidden) {
                    return noteAt.get(hidden.id) === m.at ? (
                      <CompactNote
                        key={`${hidden.id}-note`}
                        compaction={hidden}
                        modelName={hidden.summaryBy.kind === "model" ? modelNameOf(hidden.summaryBy.model) : null}
                        tokens={tokensOf(hidden)}
                        onUndo={stream.running ? undefined : () => void undoCompaction(hidden)}
                        busy={undoing === hidden.id}
                      />
                    ) : null;
                  }
                  return (
                m.role === "user" ? (
                  <Fragment key={`${m.at}-u`}>
                    {(() => {
                      const caption = askedInCaption(current.messages, mi);
                      const key = m.askedIn?.tabKey;
                      if (!caption) return null;
                      if (!key || !onShowTab) return <div className="msg-asked-in">{caption}</div>;
                      const label = m.askedIn!.label;
                      const closed = closedAsked.has(m.at);
                      return (
                        <div className="msg-asked-in">
                          Asked in{" "}
                          <button
                            type="button"
                            className="link-button"
                            title={`Show ${label}`}
                            onClick={() => {
                              const shown = onShowTab(key);
                              setClosedAsked((all) => {
                                if (shown === !all.has(m.at)) return all;
                                const next = new Set(all);
                                if (shown) next.delete(m.at);
                                else next.add(m.at);
                                return next;
                              });
                            }}
                          >
                            {label}
                          </button>
                          {closed && (
                            <span className="msg-asked-closed" role="status">
                              {" "}
                              {label} is closed.
                            </span>
                          )}
                        </div>
                      );
                    })()}
                    <div className={m.action === "continue" ? "msg-user msg-user-muted" : "msg-user"}>{m.text}</div>
                    <div className="ts">{dayClock(m.at, Date.now())}</div>
                  </Fragment>
                ) : m.role === "assistant" ? (
                  (() => {
                    const record = recordOf(m.record);
                    const q = current.messages[mi - 1]?.role === "user" ? current.messages[mi - 1].text : "";
                    const notice = contextNotice(record?.context ?? liveContexts.get(m.at) ?? null);
                    return (
                      <div key={`${m.at}-a`} className="msg-ai">
                        <AnswerText
                          text={m.text}
                          // The Core checked the SQL only when the answer finished; otherwise Insert stays commented out.
                          blocks={record?.stop ? record.sqlBlocks : null}
                          notes={notice ? [notice, ...(record?.notes ?? [])] : record?.notes}
                          dialect={conn?.dialect ?? "postgres"}
                          target={insertTarget}
                          noEditor={noEditor}
                          onOpenInNewTab={openInNewTab}
                          onCopy={copySql}
                          onAction={(kind) => recordAction(current.id, m.at, kind)}
                        />
                        {record && answerFoot(m, record, q, mi === current.messages.length - 1, current.messages[mi - 1]?.action)}
                      </div>
                    );
                  })()
                ) : (
                  <p key={`${m.at}-n`} className="msg-notice">
                    {m.text}
                  </p>
                )
                  );
                })}
            </Fragment>
          );
        })}
        {pending && (
          <>
            {liveDivider && stream.memory && <TopicDivider title={stream.memory.title} />}
            <div className={pending.action === "continue" ? "msg-user msg-user-muted" : "msg-user"}>{pending.q}</div>
            <div className="ts">{dayClock(pending.at, Date.now(), true)}</div>
            <div className="msg-ai" aria-busy="true">
              <LiveAnswer stream={stream} notes={liveNotice ? [liveNotice] : undefined} dialect={conn?.dialect ?? "postgres"} onCopy={copySql} onGrow={followEnd} />
              <div className="msg-mark">
                <button type="button" className="link-button" onClick={() => setLogOf({ kind: "live", q: pending.q })}>
                  Show log
                </button>
              </div>
            </div>
          </>
        )}
        {working !== null && (
          <p className="msg-notice" role="status">
            {working}
          </p>
        )}
        {failure !== null && failureCard(failure)}
        {stoppedEarly !== null &&
          !stream.running &&
          answerEnd("stopped", {
            millis: stoppedEarly.millis,
            nothing: true,
            onRetry: () => {
              const { q, action } = stoppedEarly;
              // The composer gives the question up to the Retry.
              setQuestion((now) => (now === q ? "" : now));
              void ask(q, undefined, undefined, action);
            },
          })}
        {confirmStop && (
          <div className="msg-mark" role="alert">
            <span>Stop the current answer?</span>
            <button
              type="button"
              className="button button-small"
              onClick={() => {
                setConfirmStop(false);
                stream.stop();
              }}
            >
              Stop it
            </button>
            <button type="button" className="button button-small" onClick={() => setConfirmStop(false)}>
              Keep writing
            </button>
          </div>
        )}
      </div>

      <div className="composer" ref={sendsRef}>
        <Sends
          preview={preview}
          error={previewError}
          header={header}
          onToggle={toggle}
          labelOf={(i) => sendsLabel(i, ctx, preview)}
          connection={conn}
          modelName={model?.name ?? null}
          openSignal={sendsOpenSignal}
          foldable
        />
        {pickError && (
          <p className="sends-note" role="alert">
            {pickError}
          </p>
        )}
        <ContextLine
          info={preview?.context ?? null}
          connection={conn}
          onResync={() => void resync()}
          busy={resyncing}
          error={resyncError}
        />
        {slashOpen && matches && (
          <SlashCommands
            id={slashId}
            commands={matches}
            active={slashRow}
            unavailable={unavailable}
            draft={question}
            onRun={runSlash}
          />
        )}
        <div className="comp-box">
          {model && (
            <ContextMeter
              used={meterUsed}
              window={model.contextWindow}
              parts={parts}
              exact={answered !== null}
            />
          )}
          <textarea
            ref={input}
            aria-label="Message"
            placeholder={conn && !removed ? `Ask about ${conn.name}, or type / for commands` : "Ask about Contura or SQL"}
            value={question}
            aria-controls={slashOpen ? slashId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={slashOpen && matches && matches.length > 0 ? optionId(slashId, matches[slashRow].name) : undefined}
            onChange={(e) => {
              setQuestion(e.target.value);
              setSlashActive(0);
              if (e.target.value.trim()) setAnswered(null);
            }}
            onKeyDown={onKey}
          />
          <div className="comp-foot">
            {models && model && (
              <ModelPicker
                list={models}
                onPick={pickModel}
                openSignal={pickerOpen}
                providerName={providerName}
                used={meterUsed}
                parts={parts}
                exact={answered !== null}
              />
            )}
            <span className={rowsNow.on ? "comp-sub comp-sub-rows" : "comp-sub"}>
              {rowsNow.on && <Icon name="grid" size={14} />}
              {rowsLine(rowsNow, preview?.rows ?? null)}
            </span>
            <span className="spacer" />
            <Kbd keys={stream.running ? "Esc" : "Enter"} />
            {stream.running ? (
              <button
                type="button"
                className="button ai-send"
                aria-label="Stop"
                title="Stop  Esc"
                onClick={() => {
                  setConfirmStop(false);
                  stream.stop();
                }}
              >
                <Icon name="stop" size={14} />
              </button>
            ) : (
              <button
                type="button"
                className="button button-primary ai-send"
                aria-label="Send"
                disabled={!question.trim()}
                onClick={send}
              >
                <Icon name="arrowUp" size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
      </>
      )}
    </aside>
  );
}
