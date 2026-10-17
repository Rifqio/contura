import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { aiAsk, aiSettings, clearAiThreads, listAiThreads, saveAiThread } from "../api/client";
import type { AiAccess, AiMessage, AiSettingsView, AiThread, ConnectionConfig, SqlSchema } from "../api/types";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import Menu, { type MenuItem } from "../components/Menu";
import { PROVIDERS } from "../settings/ai/providers";
import AnswerSql from "./AnswerSql";
import { answerParts } from "./answerParts";
import answerState, { aiErrorOf, notAvailableText } from "./answerState";
import type { AskContext } from "./context";
import { buildSends, payloadText, type SendItem } from "./payload";
import Sends from "./Sends";

interface Props {
  /** The drafts place key: "ungrouped" or "group:<id>". */
  place: string;
  groupId: string | null;
  context: AskContext | null;
  schema: SqlSchema | null;
  onOpenSettings(): void;
  seed?: { question: string; context: AskContext };
  /** The current Connections, so a seeded question uses the access they have now, not when it was asked. */
  connections?: ConnectionConfig[];
  onClose?(): void;
  /** Puts an answer's SQL into the query tab's editor. */
  onInsert?(sql: string): void;
  /** Inserts an answer's SQL and runs it through the query tab's runner, so the Production and Read-only checks apply. */
  onRun?(sql: string): Promise<{ ran: boolean; rows?: number; more?: boolean }>;
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

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The words of a Sends item in the composer line. */
function sendsLabel(item: SendItem, ctx: AskContext): string {
  const n = ctx.tables.length;
  switch (item.key) {
    case "schema":
      return `schema of ${n} ${n === 1 ? "table" : "tables"}`;
    case "query":
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

function chipLabel(item: SendItem, ctx: AskContext): string {
  if (item.key === "query" && ctx.kind !== "filter") return `Selected SQL · lines ${ctx.lines?.[0] ?? 1} to ${ctx.lines?.[1] ?? ctx.sql?.split("\n").length ?? 1}`;
  if (item.key === "error") return "Error";
  return item.label;
}

export default function AssistantPanel({ place, groupId, context, schema, onOpenSettings, seed, connections, onClose, onInsert, onRun }: Props) {
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
  const [ran, setRan] = useState<ReadonlyMap<string, { ran: boolean; rows?: number; more?: boolean }>>(new Map());
  const [offKeys, setOffKeys] = useState<ReadonlySet<string>>(new Set());
  const [rowsOff, setRowsOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const placeRef = useRef(place);
  placeRef.current = place;

  // A Group's threads are its own: entering another place reloads them and starts a clean composer.
  useEffect(() => {
    let live = true;
    setThreads([]);
    setCurrentId(null);
    setFailure(null);
    setRan(new Map());
    setOffKeys(new Set());
    setRowsOff(false);
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
  }, [place]);

  useEffect(() => {
    let live = true;
    aiSettings(groupId)
      .then((v) => {
        if (live) setSettings(v);
      })
      .catch(() => {
        if (live) setSettings(null);
      });
    return () => {
      live = false;
    };
  }, [groupId]);

  // New context, new items. The text itself is left out of the key: typing in the editor must not switch a turned-off item back on.
  const ctxKey = `${conn?.id ?? ""}|${ctx.kind}|${ctx.label}|${conn?.access ?? ""}`;
  useEffect(() => {
    void ctxKey;
    setOffKeys(new Set());
  }, [ctxKey]);

  useEffect(() => {
    if (seed) setQuestion(seed.question);
  }, [seed]);

  const sees = !!conn && conn.access !== "never";
  const items = useMemo<SendItem[]>(() => {
    if (!sees) return [];
    return buildSends(ctx, schema, rowsOff).map((i) => (offKeys.has(i.key) && !i.locked ? { ...i, on: false } : i));
  }, [sees, ctx, schema, rowsOff, offKeys]);

  const provider = settings?.settings.provider ?? null;
  const header = provider
    ? `To ${hostOf(settings?.settings.baseUrl ?? "")} (${settings?.settings.model})`
    : "Nothing is sent until a provider is set.";
  const providerName = provider ? PROVIDERS[provider].name : undefined;
  const accessChip = conn ? ACCESS_CHIP[conn.access] : null;

  const current = threads.find((t) => t.id === currentId) ?? null;

  const toggle = (key: SendItem["key"]) => {
    if (key === "rows") {
      setRowsOff((o) => !o);
      return;
    }
    setOffKeys((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  };

  async function ask() {
    const q = question.trim();
    if (!q || busy) return;
    const payload = payloadText(items);
    const included = items.filter((i) => i.on && !i.locked && i.key !== "rows").map((i) => chipLabel(i, ctx));
    const forPlace = place;
    setBusy(true);
    setFailure(null);
    try {
      const answer = await aiAsk(groupId, { question: q, payload });
      await persist(forPlace, q, included, { role: "assistant", text: answer.text });
    } catch (e) {
      const ai = aiErrorOf(e);
      if (ai?.kind === "notAvailable") {
        await persist(forPlace, q, included, { role: "notice", text: notAvailableText(ai.provider) });
      } else if (placeRef.current === forPlace) {
        setFailure(e);
      }
    } finally {
      setBusy(false);
    }
  }

  async function persist(forPlace: string, q: string, included: string[], reply: { role: AiMessage["role"]; text: string }) {
    const at = Date.now();
    const add: AiMessage[] = [
      { role: "user", text: q, context: included, at },
      { ...reply, context: [], at: at + 1 },
    ];
    const base = threads.find((t) => t.id === currentId);
    const next: AiThread = base
      ? { ...base, messages: [...base.messages, ...add], updatedAt: at }
      : { id: newId(), place: forPlace, title: q.length > 40 ? `${q.slice(0, 40)}…` : q, messages: add, updatedAt: at };
    await saveAiThread(next).catch(() => {});
    if (placeRef.current !== forPlace) return;
    setThreads((all) => [next, ...all.filter((t) => t.id !== next.id)]);
    setCurrentId(next.id);
    setQuestion("");
    setRowsOff(false);
  }

  async function clear() {
    await clearAiThreads(place).catch(() => {});
    setThreads([]);
    setCurrentId(null);
    setFailure(null);
  }

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
      disabled: threads.length === 0,
      onSelect: () => void clear(),
    },
  ];

  const runAnswer = async (key: string, sql: string) => {
    if (!onRun) return;
    const outcome = await onRun(sql).catch(() => ({ ran: false }));
    setRan((r) => new Map(r).set(key, outcome));
  };

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
        {current?.messages.map((m) =>
          m.role === "user" ? (
            <div key={`${m.at}-u`} className="msg-user">
              {m.text}
            </div>
          ) : m.role === "assistant" ? (
            <div key={`${m.at}-a`} className="msg-ai">
              {answerParts(m.text).map((part, i) => {
                const key = `${m.at}-${i}`;
                return part.kind === "text" ? (
                  <p key={key}>{part.text}</p>
                ) : (
                  <AnswerSql
                    key={key}
                    sql={part.sql}
                    dialect={conn?.dialect ?? "postgres"}
                    onInsert={onInsert}
                    onRun={onRun ? (sql) => void runAnswer(key, sql) : undefined}
                    onCopy={(sql) => void navigator.clipboard?.writeText(sql).catch(() => {})}
                    ran={ran.get(key) ?? null}
                  />
                );
              })}
            </div>
          ) : (
            <p key={`${m.at}-n`} className="msg-notice">
              {m.text}
            </p>
          ),
        )}
        {failure !== null &&
          answerState(failure, { providerName, onOpenSettings, onRetry: () => void ask() })}
      </div>

      <div className="composer">
        <Sends items={items} header={header} onToggle={toggle} withQuestion labelOf={(i) => sendsLabel(i, ctx)} />
        <div className="comp-box">
          <textarea
            aria-label="Message"
            placeholder={`Ask about ${conn?.name ?? "your database"}`}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={onKey}
          />
          <div className="comp-foot">
            <span className="comp-sub">No sample rows are sent</span>
            <span className="spacer" />
            <Kbd keys="Enter" />
            <button
              type="button"
              className="button button-primary ai-send"
              aria-label="Send"
              disabled={busy || !question.trim()}
              onClick={() => void ask()}
            >
              <Icon name="arrowUp" size={14} />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
