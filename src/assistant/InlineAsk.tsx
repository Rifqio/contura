import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { aiAsk, aiSettings } from "../api/client";
import type { AiSettingsView, SqlSchema } from "../api/types";
import Icon from "../components/Icon";
import { PROVIDERS } from "../settings/ai/providers";
import answerState from "./answerState";
import { actionsFor, type AskContext } from "./context";
import { buildSends, payloadText, type SendItem } from "./payload";
import Sends from "./Sends";

interface Props {
  context: AskContext;
  schema: SqlSchema | null;
  groupId: string | null;
  /** Absent where there is no panel to open, such as the Schema Builder. */
  onOpenInChat?(seed: { question: string; context: AskContext }): void;
  onOpenSettings(): void;
  onClose(): void;
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

type Outcome = { q: string } & ({ s: "busy" } | { s: "answer"; text: string } | { s: "failed"; error: unknown });

/** The small Ask popover: a question or an action, what it would send, and the answer state. */
export default function InlineAsk({ context, schema, groupId, onOpenInChat, onOpenSettings, onClose }: Props) {
  const [settings, setSettings] = useState<AiSettingsView | null>(null);
  const [text, setText] = useState("");
  const [offKeys, setOffKeys] = useState<ReadonlySet<string>>(new Set());
  const [rowsOff, setRowsOff] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
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
    return () => {
      live = false;
    };
  }, [groupId]);

  const conn = context.connection;
  const items = useMemo<SendItem[]>(() => {
    if (conn?.access === "never") return [];
    return buildSends(context, schema, rowsOff).map((i) => (offKeys.has(i.key) && !i.locked ? { ...i, on: false } : i));
  }, [conn, context, schema, rowsOff, offKeys]);

  const provider = settings?.settings.provider ?? null;
  const providerName = provider ? PROVIDERS[provider].name : undefined;
  const header = provider
    ? `To ${hostOf(settings?.settings.baseUrl ?? "")} (${settings?.settings.model})`
    : "Nothing is sent until a provider is set.";

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

  async function ask(question: string) {
    const q = question.trim();
    if (!q || outcome?.s === "busy") return;
    setOutcome({ q, s: "busy" });
    try {
      const answer = await aiAsk(groupId, { question: q, payload: payloadText(items) });
      if (alive.current) setOutcome({ q, s: "answer", text: answer.text });
    } catch (error) {
      if (alive.current) setOutcome({ q, s: "failed", error });
    }
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const question = outcome?.q ?? text.trim();

  return (
    <div className="ask-pop" role="dialog" aria-label="Ask AI" onKeyDown={onKey}>
      <div className="pop-head">
        <span>{outcome ? outcome.q : "Ask about the selection"}</span>
        <span className="prov">{provider ? `${providerName} · ${settings?.settings.model}` : "No provider"}</span>
        <button type="button" className="icon-button" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="pop-body">
        {outcome === null && (
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
                <button key={a.key} type="button" className="act" onClick={() => void ask(a.label)}>
                  {a.label}
                </button>
              ))}
            </div>
            <Sends items={items} header={header} onToggle={toggle} />
          </>
        )}
        {outcome?.s === "busy" && <p className="muted">Asking…</p>}
        {outcome?.s === "answer" && <div className="answer-text">{outcome.text}</div>}
        {outcome?.s === "failed" &&
          answerState(outcome.error, {
            providerName,
            onOpenSettings,
            onRetry: () => void ask(outcome.q),
          })}
      </div>
      <div className="pop-foot">
        {outcome && (
          <button type="button" className="button button-small" onClick={() => setOutcome(null)}>
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
