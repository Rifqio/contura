import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  aiConfirmKeyHost,
  aiKnownModels,
  aiRecordAction,
  aiResync,
  aiSettings,
  clearAiThreads,
  errorText,
  listAiThreads,
  saveAiThread,
  setAiModelPrefs,
} from "../api/client";
import type {
  AiAccess,
  AiMessage,
  AiSettingsView,
  AiThread,
  AnswerActionKind,
  AnswerRecord,
  ConnectionConfig,
  ContextInfo,
  ItemKind,
  ModelList,
  ModelPicks,
  Preview,
  PreviewItem,
  SqlSchema,
} from "../api/types";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import Menu, { type MenuItem } from "../components/Menu";
import { PROVIDERS, resyncProblem } from "../settings/ai/providers";
import { looksLikeSql, parseAnswer } from "./answerMarkdown";
import AnswerLog from "./AnswerLog";
import { buildRecord, mainNeverLeft, onlyOutlineLeft, providerName as nameOf, recordError, recordOf, sentLine, streamRecord } from "./answerRecord";
import answerState, { aiErrorOf, answerEnd, endMark, modelToUse } from "./answerState";
import { stopText, useAnswerStream } from "./answerStream";
import ContextMeter, { type MeterPart } from "./ContextMeter";
import { type AskContext, toAskRequest } from "./context";
import ContextLine from "./ContextLine";
import { contextNotice } from "./contextText";
import ModelPicker from "./ModelPicker";
import Sends from "./Sends";
import SentRecord from "./SentRecord";
import AnswerText from "./AnswerText";
import type { InsertTarget } from "./InsertDiff";
import { useAiPreview } from "./usePreview";
import { onThreadsCleared } from "./threadsCleared";

interface Props {
  /** The drafts place key: "ungrouped" or "group:<id>". */
  place: string;
  groupId: string | null;
  context: AskContext | null;
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
const RECORDED: ReadonlySet<ItemKind> = new Set(["names", "cards", "dbml", "sql", "error", "savedQueries"]);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The words of a Sends item in the composer line. */
function sendsLabel(item: PreviewItem, ctx: AskContext): string {
  const n = ctx.tables.length;
  switch (item.kind) {
    case "question":
      return "your question";
    case "cards":
      return `schema of ${n} ${n === 1 ? "table" : "tables"}`;
    case "sql":
      return ctx.kind === "filter" ? "the filter text" : "the current statement";
    case "error":
      return "the error";
    case "dbml":
      return "the DBML";
    case "rows":
      return "Sample rows";
    default:
      return item.label;
  }
}

/** A question being answered: shown below the thread until its answer is saved. */
interface Pending {
  q: string;
  included: string[];
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
}

/** Whose record Show log shows: a saved answer by its time, or the Ask being (or last) streamed. */
type LogOf = { kind: "saved"; at: number } | { kind: "live"; q: string };

/** True when the answer has no complete SQL block. */
const noSql = (text: string) => !parseAnswer(text).some((b) => b.kind === "code" && b.closed && looksLikeSql(b));

/** What the context meter says is in use, in the words of the composer. */
function meterParts(preview: Preview | null, ctx: AskContext): MeterPart[] {
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
  return out;
}

function chipLabel(item: PreviewItem, ctx: AskContext): string {
  if (item.kind === "sql" && ctx.kind !== "filter") return `Selected SQL · lines ${ctx.lines?.[0] ?? 1} to ${ctx.lines?.[1] ?? ctx.sql?.split("\n").length ?? 1}`;
  if (item.kind === "error") return "Error";
  return item.label;
}

export default function AssistantPanel({
  place,
  groupId,
  context,
  onOpenSettings,
  seed,
  connections,
  onClose,
  insertTarget = null,
  onOpenInNewTab,
  openIds,
}: Props) {
  const ctx = useMemo<AskContext>(() => {
    if (!seed) return context ?? NO_CONTEXT;
    const asked = seed.context;
    const was = asked.connection;
    if (!was || !connections) return asked;
    const live = connections.find((c) => c.id === was.id);
    if (!live) return { ...asked, connection: null };
    return { ...asked, connection: { ...was, name: live.name, access: live.aiAccess } };
  }, [seed, context, connections]);
  const conn = ctx.connection;
  const [settings, setSettings] = useState<AiSettingsView | null>(null);
  const [threads, setThreads] = useState<AiThread[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [off, setOff] = useState<ItemKind[]>([]);
  const [values, setValues] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  /** Show log is open, in place of the thread. */
  const [logOf, setLogOf] = useState<LogOf | null>(null);
  /** The saved answer, by its time, whose Sent record is open. */
  const [sentOpen, setSentOpen] = useState<number | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [models, setModels] = useState<ModelList | null>(null);
  /** Bumped to open the model menu from a card. */
  const [pickerOpen, setPickerOpen] = useState(0);
  const sendsRef = useRef<HTMLDivElement>(null);
  /** "Send the saved key to <host>" is on its way. */
  const confirmingRef = useRef(false);
  const [confirming, setConfirming] = useState(false);
  /** Why the last model pick could not be saved. */
  const [pickError, setPickError] = useState<string | null>(null);
  /** The input tokens the provider reported for the last answer, until the next question is typed. */
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
  const { stop: stopAnswer } = stream;
  const placeRef = useRef(place);
  placeRef.current = place;
  const input = useRef<HTMLTextAreaElement>(null);

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
    setFailure(null);
    setOff([]);
    setValues(false);
    setAnswered(null);
    listAiThreads(place)
      .then((list) => {
        if (!live) return;
        const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
        setThreads(sorted);
        setCurrentId(sorted[0]?.id ?? null);
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
        setCurrentId(null);
        setFailure(null);
        setLogOf(null);
        setSentOpen(null);
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
  const ctxKey = `${conn?.id ?? ""}|${ctx.kind}|${ctx.label}|${conn?.access ?? ""}`;
  const ctxKeyRef = useRef(ctxKey);
  ctxKeyRef.current = ctxKey;
  useEffect(() => {
    void ctxKey;
    setOff([]);
    setValues(false);
    setAnswered(null);
    setResyncError(null);
  }, [ctxKey]);

  useEffect(() => {
    if (seed) setQuestion(seed.question);
  }, [seed]);

  const switches = useMemo(() => ({ rows: false, values }), [values]);
  const modelId = model?.id ?? null;
  const picks = model?.picks ?? null;
  const previewed = useMemo(
    () => toAskRequest(ctx, question.trim(), off, switches, { groupId, threadId: currentId, model: modelId, picks }),
    [ctx, question, off, switches, groupId, currentId, modelId, picks],
  );
  const { preview, error: previewError } = useAiPreview(previewed, `${conn?.access ?? ""}|${resyncs}`);

  /** Re-sync from the Context line: rebuilds the AI Context, then previews again. */
  async function resync() {
    if (!conn || resyncing) return;
    const forKey = ctxKey;
    setResyncing(true);
    setResyncError(null);
    let problem: string | null;
    try {
      const info = await aiResync(conn.id, conn.database, null);
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

  const current = threads.find((t) => t.id === currentId) ?? null;
  const parts = useMemo(() => meterParts(preview, ctx), [preview, ctx]);

  const toggle = (kind: ItemKind) => {
    if (kind === "values") {
      setValues((v) => !v);
      return;
    }
    setOff((o) => (o.includes(kind) ? o.filter((k) => k !== kind) : [...o, kind]));
  };

  /**
   * Streams the answer to `asked` (the composer's question when absent). `again` is the failed or stopped
   * turn being asked again: its saved turn is replaced, and a repeat of its failure counts as "Try 2".
   */
  async function ask(asked?: string, again?: { saved: boolean; failure: Failure | null }, use?: { id: string; picks: ModelPicks }) {
    const q = (asked ?? question).trim();
    if (!q) return;
    if (stream.running) {
      setConfirmStop(true);
      return;
    }
    const request = toAskRequest(ctx, q, off, switches, {
      groupId,
      threadId: currentId,
      model: use?.id ?? modelId,
      picks: use?.picks ?? picks,
    });
    const included = (preview?.items ?? [])
      .filter((i) => i.on && !i.locked && RECORDED.has(i.kind))
      .map((i) => chipLabel(i, ctx));
    const forPlace = place;
    const base = current;
    const askedAt = Date.now();
    setFailure(null);
    setConfirmStop(false);
    setAnswered(null);
    setPending({ q, included });
    if (asked === undefined) setQuestion("");
    // "Include values" is off at the start of every Ask.
    setValues(false);
    const end = await stream.start(request);
    if (placeRef.current === forPlace) setPending(null);
    const usage = end.done?.usage;
    if (usage && placeRef.current === forPlace) setAnswered(usage.input + usage.cacheRead);

    let saved = again?.saved ?? false;
    // A failure is kept as a turn once something was sent, so its record and card survive a reload.
    const keep = end.done !== null || end.text !== "" || (end.error !== null && end.live.sent !== null);
    if (!keep && asked === undefined && placeRef.current === forPlace) {
      // Nothing came back: the question goes back into the composer.
      setQuestion((now) => now || q);
    }
    if (keep) {
      const record = buildRecord(end, end.live);
      record.millis ??= end.at - askedAt;
      const at = await persist(forPlace, base, saved, q, included, askedAt, end.text, end.at, record, request.requestId);
      const used = end.live.context;
      if (used) setLiveContexts((all) => new Map(all).set(at, used));
      saved = true;
    }
    if (end.error !== null && placeRef.current === forPlace) {
      const before = again?.failure;
      const same = before && aiErrorOf(before.error)?.kind === aiErrorOf(end.error)?.kind;
      setFailure({ error: end.error, partial: end.partial, q, tries: same ? before.tries + 1 : 1, saved, kept: keep });
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
  ): Promise<number> {
    const at = Math.max(answeredAt, askedAt + 1);
    const add: AiMessage[] = [
      { role: "user", text: q, context: included, at: askedAt },
      { role: "assistant", text, context: [], at, record },
    ];
    const kept = base ? (replace ? base.messages.slice(0, -2) : base.messages) : [];
    const next: AiThread = base
      ? { ...base, messages: [...kept, ...add], updatedAt: askedAt }
      : { id: newId(), place: forPlace, title: q.length > 40 ? `${q.slice(0, 40)}…` : q, messages: add, updatedAt: askedAt };
    await saveAiThread(next, requestId).catch(() => {});
    if (placeRef.current === forPlace) {
      setThreads((all) => [next, ...all.filter((t) => t.id !== next.id)]);
      setCurrentId(next.id);
    }
    return at;
  }

  /** Keeps what the user did with a saved answer's SQL in its record, here and in the Core (the Diagram's "You:" box). */
  function recordAction(threadId: string, at: number, kind: AnswerActionKind) {
    void aiRecordAction(threadId, at, kind)
      .then((action) => {
        if (!action) return;
        setThreads((all) =>
          all.map((t) =>
            t.id !== threadId
              ? t
              : {
                  ...t,
                  messages: t.messages.map((m) => {
                    const r = m.role === "assistant" && m.at === at ? recordOf(m.record) : null;
                    return r ? { ...m, record: { ...r, actions: [...r.actions, action] } } : m;
                  }),
                },
          ),
        );
      })
      .catch(() => {});
  }

  async function clear() {
    await clearAiThreads(place).catch(() => {});
    setThreads([]);
    setCurrentId(null);
    setFailure(null);
  }

  /**
   * Under a saved answer, all from its stored record: the mark and the answer state card (its action only while it is
   * the last turn), the error card of a failed Ask, the Sent line with its record, and Show log.
   */
  const answerFoot = (m: AiMessage, record: AnswerRecord, q: string, last: boolean) => {
    const live = last && !stream.running && pending === null;
    const showLog = () => setLogOf({ kind: "saved", at: m.at });
    let card: ReactNode = null;
    const error = recordError(record);
    if (error !== null) {
      // The last failed turn shows the live card below the thread while its failure is in hand.
      if (!(last && failure?.saved)) {
        card =
          live && failure === null
            ? failureCard({ error, partial: m.text !== "", q, tries: 1, saved: true, kept: true })
            : answerState(error, {
                providerName,
                provider,
                connectionName: conn?.name,
                partial: m.text !== "",
                outlineSent: onlyOutlineLeft(record),
                onShowLog: showLog,
              });
      }
    } else if (record.mark && record.mark !== "tooLong" && record.mark !== "failed") {
      card = answerEnd(record.mark, {
        sqlMissing: noSql(m.text),
        output: record.usage?.output ?? null,
        millis: record.millis,
        onRetry: live ? () => void ask(q, { saved: true, failure: null }) : undefined,
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
        {sentOpen === m.at && record.sent && (
          <SentRecord sent={record.sent} usage={record.usage} notSent={mainNeverLeft(record)} onClose={() => setSentOpen(null)} />
        )}
      </>
    );
  };

  /** The card of a failed Ask and what its actions do. */
  const failureCard = (f: Failure) => {
    const again = { saved: f.saved, failure: f };
    const retry = () => void ask(f.q, again);
    const giveBack = () => setQuestion((now) => now || f.q);
    const fit = preview?.tables;
    return answerState(f.error, {
      providerName,
      provider,
      model,
      models: models?.models ?? [],
      connectionName: conn?.name,
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
        void ask(f.q, again, use);
      },
      onPickModel: () => setPickerOpen((n) => n + 1),
      onPickTables: () => {
        const pill = sendsRef.current?.querySelector<HTMLElement>(".sends .send-pill[aria-pressed]");
        pill?.scrollIntoView?.({ block: "nearest" });
        pill?.focus();
      },
      onNewChat: () => {
        setCurrentId(null);
        setFailure(null);
        giveBack();
      },
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
      onStop: () => {
        stream.stop();
        setFailure(null);
      },
    });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void ask();
    }
  };

  const historyItems: MenuItem[] = [
    ...(threads.length > 0 ? [{ key: "chats", label: "Chats", heading: "Chats" }] : []),
    ...threads.map((t) => ({
      key: `thread-${t.id}`,
      label: t.title,
      current: t.id === currentId,
      disabled: stream.running,
      onSelect: () => {
        setCurrentId(t.id);
        setFailure(null);
      },
    })),
    {
      key: "new",
      label: "New chat",
      icon: <Icon name="plus" size={14} />,
      separatorBefore: threads.length > 0,
      disabled: stream.running,
      onSelect: () => {
        setCurrentId(null);
        setFailure(null);
      },
    },
    {
      key: "clear",
      label: "Clear chats",
      icon: <Icon name="trash" size={14} />,
      danger: true,
      disabled: threads.length === 0 || stream.running,
      onSelect: () => void clear(),
    },
  ];

  const liveNotice = contextNotice(stream.context);
  const copySql = (sql: string) => void navigator.clipboard?.writeText(sql).catch(() => {});
  const openInNewTab = onOpenInNewTab && ((sql: string) => onOpenInNewTab(sql, conn));

  // Show log replaces the thread and the composer (board 11.3): a saved answer's record, or the Ask being streamed.
  let logView: ReactNode = null;
  if (logOf) {
    const msgs = current?.messages ?? [];
    const i = logOf.kind === "saved" ? msgs.findIndex((m) => m.at === logOf.at && m.role === "assistant") : -1;
    const saved = i >= 0 ? recordOf(msgs[i].record) : null;
    const record = saved ?? streamRecord(stream);
    const q = i >= 0 ? (msgs[i - 1]?.role === "user" ? msgs[i - 1].text : "") : logOf.kind === "live" ? logOf.q : "";
    logView = (
      <AnswerLog
        question={q}
        answer={i >= 0 ? msgs[i].text : stream.text}
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
    <aside className="ai-panel" aria-label="Ask">
      <header className="ai-panel-head">
        <span className="t">Ask</span>
        {accessChip && conn && (
          <span className={`chip ${accessChip.tone}`} title={`AI access for ${conn.name}`}>
            {accessChip.text}
          </span>
        )}
        <span className="spacer" />
        <Menu
          label="History"
          align="end"
          items={historyItems}
          trigger={(p) => (
            <button type="button" className="icon-button" aria-label="History" title="History" {...p}>
              <Icon name="history" size={14} />
            </button>
          )}
        />
        <button type="button" className="icon-button" aria-label="Close" title="Close" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </header>

      {logView ?? (
      <>
      <div className="thread" aria-live="polite">
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
        {current?.messages.map((m, mi) =>
          m.role === "user" ? (
            <div key={`${m.at}-u`} className="msg-user">
              {m.text}
            </div>
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
                    onOpenInNewTab={openInNewTab}
                    onCopy={copySql}
                    onAction={(kind) => recordAction(current.id, m.at, kind)}
                  />
                  {record && answerFoot(m, record, q, mi === current.messages.length - 1)}
                </div>
              );
            })()
          ) : (
            <p key={`${m.at}-n`} className="msg-notice">
              {m.text}
            </p>
          ),
        )}
        {pending && (
          <>
            <div className="msg-user">{pending.q}</div>
            <div className="msg-ai" aria-busy="true">
              {stream.thinking && (
                <details className="msg-thinking">
                  <summary>Thinking</summary>
                  <p>{stream.thinking}</p>
                </details>
              )}
              {stream.text ? (
                <AnswerText
                  text={stream.text}
                  streaming
                  notes={liveNotice ? [liveNotice] : undefined}
                  dialect={conn?.dialect ?? "postgres"}
                  onCopy={copySql}
                />
              ) : (
                <p className="msg-notice">{stream.status ?? "Sending"}</p>
              )}
              <div className="msg-mark">
                <button type="button" className="link-button" onClick={() => setLogOf({ kind: "live", q: pending.q })}>
                  Show log
                </button>
              </div>
            </div>
          </>
        )}
        {failure !== null && failureCard(failure)}
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
          labelOf={(i) => sendsLabel(i, ctx)}
          connection={conn}
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
        <div className="comp-box">
          {model && (
            <ContextMeter
              used={answered ?? preview?.tokens ?? 0}
              window={model.contextWindow}
              parts={parts}
              exact={answered !== null}
            />
          )}
          <textarea
            ref={input}
            aria-label="Message"
            placeholder={`Ask about ${conn?.name ?? "your database"}`}
            value={question}
            onChange={(e) => {
              setQuestion(e.target.value);
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
                used={answered ?? preview?.tokens ?? 0}
                parts={parts}
                exact={answered !== null}
              />
            )}
            <span className="comp-sub">No sample rows are sent</span>
            <span className="spacer" />
            <Kbd keys="Enter" />
            {stream.running ? (
              <button
                type="button"
                className="button ai-send"
                aria-label="Stop"
                title="Stop"
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
                onClick={() => void ask()}
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
