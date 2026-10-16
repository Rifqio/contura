import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { aiAsk, aiSettings, clearAiThreads, listAiThreads, saveAiThread } from "../api/client";
import type { AiMessage, AiSettingsView, AiThread, ConnectionConfig, SqlSchema } from "../api/types";
import Icon from "../components/Icon";
import { PROVIDERS } from "../settings/ai/providers";
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
}

const NO_CONTEXT: AskContext = { kind: "none", connection: null, tables: [], label: "" };

/** Ctrl+Alt+I toggles the panel, unless a modal dialog is open. */
export function useAssistantHotkey(toggle: () => void) {
  const latest = useRef(toggle);
  latest.current = toggle;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey || e.key.toLowerCase() !== "i") return;
      if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

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

function chipLabel(item: SendItem, ctx: AskContext): string {
  if (item.key === "query" && ctx.kind !== "filter") return `Selected SQL · lines ${ctx.lines?.[0] ?? 1} to ${ctx.lines?.[1] ?? ctx.sql?.split("\n").length ?? 1}`;
  if (item.key === "error") return "Error";
  return item.label;
}

export default function AssistantPanel({ place, groupId, context, schema, onOpenSettings, seed, connections }: Props) {
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
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
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
    setRemoved(new Set());
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

  // New context, new chips. The text itself is left out of the key: typing in the editor must not bring back a removed chip.
  const ctxKey = `${conn?.id ?? ""}|${ctx.kind}|${ctx.label}|${conn?.access ?? ""}`;
  useEffect(() => {
    void ctxKey;
    setRemoved(new Set());
    setOffKeys(new Set());
  }, [ctxKey]);

  useEffect(() => {
    if (seed) setQuestion(seed.question);
  }, [seed]);

  const sees = !!conn && conn.access !== "never";
  const items = useMemo<SendItem[]>(() => {
    if (!sees) return [];
    return buildSends(ctx, schema, rowsOff)
      .filter((i) => !removed.has(i.key))
      .map((i) => (offKeys.has(i.key) && !i.locked ? { ...i, on: false } : i));
  }, [sees, ctx, schema, rowsOff, removed, offKeys]);

  const chips = items.filter((i) => !i.locked && i.key !== "rows");
  const provider = settings?.settings.provider ?? null;
  const header = provider
    ? `To ${hostOf(settings?.settings.baseUrl ?? "")} (${settings?.settings.model})`
    : "Nothing is sent until a provider is set.";
  const providerName = provider ? PROVIDERS[provider].name : undefined;

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

  return (
    <aside className="ai-panel" aria-label="Assistant">
      <header className="ai-panel-head">
        <Icon name="sparkle" />
        <span className="t">Assistant</span>
        <span className="prov">{provider ? `${providerName} · ${settings?.settings.model}` : "No provider"}</span>
        <select
          className="ai-thread-select"
          aria-label="Chat"
          value={currentId ?? ""}
          onChange={(e) => {
            setCurrentId(e.target.value || null);
            setFailure(null);
          }}
        >
          <option value="">New chat</option>
          {threads.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button button-small"
          onClick={() => {
            setCurrentId(null);
            setFailure(null);
          }}
        >
          New chat
        </button>
        <button type="button" className="button button-small" disabled={threads.length === 0} onClick={() => void clear()}>
          Clear
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
              <span className="who">
                <Icon name="sparkle" />
                Assistant
              </span>
              <div>{m.text}</div>
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
        <div className="ctx-chips" role="group" aria-label="Context">
          {conn && conn.access === "never" ? (
            <span className="ctx-chip">
              <Icon name="lock" />
              <span>No context from {conn.name}</span>
            </span>
          ) : (
            chips.map((i) => {
              const label = chipLabel(i, ctx);
              return (
                <span key={i.key} className="ctx-chip">
                  <Icon name={i.key === "query" ? "play" : "schema"} />
                  <span>{label}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${label}`}
                    onClick={() => setRemoved((s) => new Set(s).add(i.key))}
                  >
                    <Icon name="close" />
                  </button>
                </span>
              );
            })
          )}
        </div>
        <div className="comp-box">
          <textarea
            aria-label="Message"
            placeholder="Ask about your SQL or schema"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={onKey}
          />
        </div>
        <Sends items={items} header={header} onToggle={toggle} />
      </div>
    </aside>
  );
}
