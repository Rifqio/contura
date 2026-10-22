import { type ReactElement, type ReactNode, useEffect, useRef, useState } from "react";
import type { AiError, AiProviderKind, AiSettings, ModelInfo, ModelPicks } from "../api/types";
import { errorText, openUrl } from "../api/client";
import Icon, { type IconName } from "../components/Icon";
import { formatWindow, PROVIDERS } from "../settings/ai/providers";
import { secondsText } from "./answerStream";
import { formatTokens } from "./ContextMeter";

interface Options {
  /** The saved provider's display name, for the cards that name it. */
  providerName?: string;
  /** The saved provider, for its console and its built-in models. */
  provider?: AiProviderKind | null;
  /** The model the Ask used, and the provider's other models. */
  model?: ModelInfo | null;
  models?: ModelInfo[];
  /** The Connection the Ask was about, for "Nothing ran on <connection>". */
  connectionName?: string;
  /** The host the base URL points to, for a connect timeout. */
  host?: string;
  /** How many tables the schema has, for a question too big for the window. */
  tables?: number;
  onOpenSettings?(): void;
  onRetry?(): void;
  /** Switches to model `id` and asks again. */
  onUseModel?(id: string): void;
  onPickModel?(): void;
  onPickTables?(): void;
  onShowLog?(): void;
  onNewChat?(): void;
  /** Binds the saved key to `host`, then asks again. */
  onConfirmKeyHost?(host: string): void;
  /** The confirm is on its way: its button is disabled until it settles. */
  confirmingKeyHost?: boolean;
  /** Sends a question kept while offline now. */
  onSendNow?(): void;
  onCancelQueued?(): void;
  /** Stops the answer still being written. */
  onStop?(): void;
  /** Part of the answer arrived before the failure and is kept in the thread. */
  partial?: boolean;
  /** How many times in a row this failure happened; 2 and up show "Try 2". */
  tries?: number;
  /** The outline step's request left this PC before the failure: the cards that say nothing was sent say so instead. */
  outlineSent?: boolean;
}

const AI_ERROR_KINDS: string[] = [
  "notConfigured",
  "badKey",
  "rateLimited",
  "network",
  "keyHostChanged",
  "insecureUrl",
  "timeout",
  "cancelled",
  "provider",
  "badResponse",
  "tooLarge",
  "contextUnavailable",
  "overloaded",
  "urlHasCredentials",
  "offline",
  "outOfCredit",
  "modelRetired",
  "contextFull",
  "tooBig",
  "tls",
  "busy",
  "internal",
] satisfies AiError["kind"][];

function isAiError(e: unknown): e is AiError {
  const k = (e as { kind?: unknown } | null)?.kind;
  return typeof k === "string" && AI_ERROR_KINDS.includes(k);
}

/** The AiError inside a command error, or null when the error is something else. */
export function aiErrorOf(error: unknown): AiError | null {
  const e = error as { kind?: unknown; message?: unknown } | null;
  if (e && e.kind === "ai" && isAiError(e.message)) return e.message;
  return null;
}

/** The kinds a second attempt can fix: the network, the provider's load, a reply that could not be read. */
const RETRYABLE: ReadonlySet<string> = new Set(["network", "timeout", "badResponse", "overloaded", "provider", "offline", "outOfCredit"]);

type Tone = "warn" | "bad" | "neu" | "info";

/** One action button; the first action of a card can be the primary one. */
interface Action {
  label: string;
  run?(): void;
  primary?: boolean;
  /** Shown but not clickable, such as while it already runs. */
  disabled?: boolean;
}

interface CardProps {
  tone: Tone;
  icon: IconName;
  title: string;
  body?: string;
  tries?: number;
  actions?: (Action | null | false | undefined)[];
  onShowLog?(): void;
  /** The countdown bar, between the body and the actions. */
  children?: ReactNode;
}

/** The error card of board 11.6: tone icon, title, one body line, actions, Show log on the right, "Try N" from 2 on. */
function Card({ tone, icon, title, body, tries, actions = [], onShowLog, children }: CardProps) {
  const shown = actions.filter((a): a is Action => !!a && !!a.run);
  return (
    <div className={`errc ${tone}`} role="alert">
      <div className="errc-head">
        <Icon name={icon} size={14} />
        <span className="errc-title">{title}</span>
        {tries !== undefined && tries > 1 && <span className="errc-try">Try {tries.toLocaleString("en-US")}</span>}
      </div>
      {body && <div className="errc-body">{body}</div>}
      {children}
      {(shown.length > 0 || onShowLog) && (
        <div className="errc-foot">
          {shown.map((a) => (
            <button
              key={a.label}
              type="button"
              className={a.primary ? "button button-primary button-small" : "button button-small"}
              disabled={a.disabled}
              onClick={a.run}
            >
              {a.label}
            </button>
          ))}
          <span className="spacer" />
          {onShowLog && (
            <button type="button" className="link-button" onClick={onShowLog}>
              Show log
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The model a "Use <model>" action switches to: its record from the list, or, when the list does not have it yet
 * (still loading, or the listing lacks a built-in id), its saved picks or the settings' defaults. The Core clamps.
 */
export function modelToUse(id: string, models: ModelInfo[], settings: AiSettings | null): { id: string; picks: ModelPicks } {
  const known = models.find((m) => m.id === id);
  if (known) return { id, picks: known.picks };
  return {
    id,
    picks: settings?.modelPrefs[id] ?? { thinking: settings?.defaultThinking ?? "medium", caching: settings?.promptCaching ?? true },
  };
}

/** The wait a rate limit names, or 10s when it names none. */
const RATE_WAIT = 10;

/** Above this wait Contura does not send the question again on its own: the user retries. */
const AUTO_RETRY_MAX = 600;

/** A wait in compact units: `38s`, `12m`, `1h`; rounded up, so it never reads shorter than it is. */
export function waitText(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.ceil(secs / 60)}m`;
  return `${Math.ceil(secs / 3600).toLocaleString("en-US")}h`;
}

/**
 * A rate limit counts down live and asks again at zero; a wait over 10m is only shown, and Retry is left to the
 * user. Remounted (by `key`) for every new failure.
 */
function RateLimited({ who, wait: asked, tries, onRetry, onShowLog }: { who: string; wait: number; tries?: number; onRetry?(): void; onShowLog?(): void }) {
  const wait = Math.max(1, Math.ceil(asked));
  const [remain, setRemain] = useState(wait);
  const retry = useRef(onRetry);
  retry.current = onRetry;
  const auto = onRetry !== undefined && wait <= AUTO_RETRY_MAX;
  useEffect(() => {
    if (!auto) return;
    const until = Date.now() + wait * 1000;
    const id = setInterval(() => {
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setRemain(left);
      if (left === 0) {
        clearInterval(id);
        retry.current?.();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [wait, auto]);
  const lead = remain > 0 ? `Retrying in ${waitText(remain)}. ` : "Retrying now. ";
  return (
    <Card
      tone="warn"
      icon="history"
      title={`${who} is limiting requests.`}
      body={
        auto
          ? `${lead}Contura retries on its own when the wait is over. Nothing was answered yet.`
          : `${who} asks to wait ${waitText(wait)}. Retry when the wait is over. Nothing was answered yet.`
      }
      tries={tries}
      actions={[{ label: auto ? "Retry now" : "Retry", run: onRetry }]}
      onShowLog={onShowLog}
    >
      {auto && (
        <div className="errc-count">
          <span className="errc-bar">
            <span className="errc-fill" style={{ width: `${Math.round((remain / wait) * 100)}%` }} />
          </span>
          <span className="errc-left">{waitText(remain)}</span>
        </div>
      )}
    </Card>
  );
}

/** A question kept while offline goes out on the window's `online` event. */
function Offline({ tries, onSendNow, onCancelQueued, onShowLog }: Pick<Options, "tries" | "onSendNow" | "onCancelQueued" | "onShowLog">) {
  const send = useRef(onSendNow);
  send.current = onSendNow;
  useEffect(() => {
    const online = () => send.current?.();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, []);
  return (
    <Card
      tone="neu"
      icon="link"
      title="No internet connection."
      body="Your question is kept and goes out as soon as this PC is back online."
      tries={tries}
      actions={[
        { label: "Send now", run: onSendNow },
        { label: "Cancel", run: onCancelQueued },
      ]}
      onShowLog={onShowLog}
    />
  );
}

/** A model's name from the list, or its id. */
const nameOf = (id: string, models: ModelInfo[] = []) => models.find((m) => m.id === id)?.name ?? id;

/** "console.groq.com/keys" is an address; "your provider's dashboard" is not. */
const isAddress = (s: string) => /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s);

/** The timeout card's title for the phase the Core names. */
function timeoutTitle(phase: string, who: string, host: string | undefined): string {
  switch (phase) {
    case "first byte":
      return `No reply from ${who} for 60s.`;
    case "idle":
      return `${who} stopped sending for 30s.`;
    case "answer":
      return "The answer took longer than 5 minutes.";
    case "connect":
      return `Could not connect to ${host ?? who} in 10s.`;
    default:
      return `No reply from ${who}.`;
  }
}

/** What the thread shows when a question could not be answered. */
export default function answerState(error: unknown, opts: Options = {}): ReactElement {
  const ai = aiErrorOf(error);
  const who = opts.providerName ?? "The provider";
  const tries = opts.tries;
  const log = opts.onShowLog;
  const settings: Action = { label: "Open Settings", run: opts.onOpenSettings };
  const retry: Action = { label: "Retry", run: opts.onRetry };
  const models = opts.models ?? [];
  const current = opts.model ?? null;
  const nothingSent = opts.outlineSent ? "Only the outline step was sent." : "Nothing was sent.";

  switch (ai?.kind) {
    case "notConfigured":
      return (
        <div className="setup">
          <span className="t">Connect an AI provider in Settings</span>
          <span className="muted">
            Then the assistant can explain SQL, fix errors and draft DBML from what you have open. Groq and DeepSeek
            have free or low-cost plans. The key is kept in Windows Credential Manager.
          </span>
          <button type="button" className="button button-primary button-small" onClick={opts.onOpenSettings}>
            <Icon name="plug" />
            Connect a provider
          </button>
        </div>
      );
    case "rateLimited":
      return (
        <RateLimited
          key={tries ?? 1}
          who={who}
          wait={ai.retryAfterSecs ?? RATE_WAIT}
          tries={tries}
          onRetry={opts.onRetry}
          onShowLog={log}
        />
      );
    case "overloaded": {
      const fastest = models.find((m) => m.tier === "fastest");
      const use = fastest && fastest.id !== current?.id && opts.onUseModel;
      return (
        <Card
          tone="warn"
          icon="alert"
          title={`${PROVIDERS[ai.provider].name} is busy right now.`}
          body="Their servers are overloaded, so nothing was charged. Try again in a moment, or use a faster model."
          tries={tries}
          actions={[retry, use && { label: `Use ${fastest.name}`, run: () => opts.onUseModel?.(fastest.id) }]}
          onShowLog={log}
        />
      );
    }
    case "timeout": {
      const connect = ai.phase === "connect";
      const ran = opts.connectionName ? ` Nothing ran on ${opts.connectionName}.` : "";
      return (
        <Card
          tone="warn"
          icon="history"
          title={timeoutTitle(ai.phase, who, opts.host)}
          body={connect ? nothingSent : `The request left this PC but nothing came back.${ran}`}
          tries={tries}
          actions={[retry]}
          onShowLog={log}
        />
      );
    }
    case "offline":
      return <Offline key="offline" tries={tries} onSendNow={opts.onSendNow} onCancelQueued={opts.onCancelQueued} onShowLog={log} />;
    case "badKey":
      return (
        <Card
          tone="bad"
          icon="key"
          title={`${who} refused the API key.`}
          body="The key in Windows Credential Manager was revoked or mistyped. Fix it in Settings, then retry."
          tries={tries}
          actions={[{ ...settings, primary: true }, retry]}
          onShowLog={log}
        />
      );
    case "outOfCredit": {
      const p = PROVIDERS[ai.provider];
      const site = isAddress(p.console) ? `https://${p.console}` : null;
      return (
        <Card
          tone="bad"
          icon="alert"
          title={`Your ${p.name} account is out of credit.`}
          body={`Add credit in the ${p.name} console, then retry. Contura never sees billing details.`}
          tries={tries}
          actions={[site !== null && { label: `Open the ${p.name} console`, run: () => void openUrl(site).catch(() => {}) }, retry]}
          onShowLog={log}
        />
      );
    }
    case "modelRetired": {
      const first = opts.provider ? PROVIDERS[opts.provider].models[0] : undefined;
      const use = first !== undefined && first !== ai.model && opts.onUseModel !== undefined;
      return (
        <Card
          tone="bad"
          icon="alert"
          title={`${nameOf(ai.model, models)} is no longer offered.`}
          body={`${who} retired this model. Pick another one: the thread stays as it is.`}
          tries={tries}
          actions={[
            use && { label: `Use ${nameOf(first, models)}`, run: () => opts.onUseModel?.(first), primary: true },
            { label: "Pick a model", run: opts.onPickModel },
          ]}
          onShowLog={log}
        />
      );
    }
    case "tooBig": {
      const largest = models.reduce<ModelInfo | null>((big, m) => (!big || m.contextWindow > big.contextWindow ? m : big), null);
      const use = largest && largest.contextWindow > ai.window && opts.onUseModel;
      const schema =
        opts.tables !== undefined
          ? `The schema of ${opts.tables.toLocaleString("en-US")} ${opts.tables === 1 ? "table" : "tables"} does not fit.`
          : "The schema does not fit.";
      return (
        <Card
          tone="warn"
          icon="cards"
          title={`This question needs ${formatTokens(ai.needed)} tokens. ${nameOf(ai.model, models)} holds ${formatWindow(ai.window)}.`}
          body={`${schema} Ask about fewer tables, or switch to a model with a larger window.`}
          tries={tries}
          actions={[
            use && {
              label: `Use ${largest.name}, ${formatWindow(largest.contextWindow)}`,
              run: () => opts.onUseModel?.(largest.id),
              primary: true,
            },
            { label: "Pick tables", run: opts.onPickTables },
          ]}
          onShowLog={log}
        />
      );
    }
    case "contextFull":
      return (
        <Card
          tone="warn"
          icon="cards"
          title={`This thread fills ${Math.round((ai.used / ai.window) * 100)}% of ${nameOf(ai.model, models)}'s ${formatWindow(ai.window)} window.`}
          body="New chat starts empty with the same context."
          tries={tries}
          actions={[{ label: "New chat", run: opts.onNewChat }]}
          onShowLog={log}
        />
      );
    case "tooLarge":
      return (
        <Card
          tone="warn"
          icon="cards"
          title={`This Ask is over the size ${current?.name ?? "this model"} accepts, even after trimming.`}
          tries={tries}
          onShowLog={log}
        />
      );
    case "keyHostChanged": {
      const host = ai.host;
      return (
        <Card
          tone="bad"
          icon="key"
          title={`The base URL now points to ${host}. Save the key again to send it there.`}
          tries={tries}
          actions={[
            {
              label: `Send the saved key to ${host}`,
              run: opts.onConfirmKeyHost && (() => opts.onConfirmKeyHost?.(host)),
              primary: true,
              disabled: opts.confirmingKeyHost,
            },
            settings,
          ]}
          onShowLog={log}
        />
      );
    }
    case "tls":
      return (
        <Card
          tone="bad"
          icon="lock"
          title={`Could not check the certificate of ${ai.host}.`}
          body={`A proxy or antivirus may be inspecting https. ${nothingSent}`}
          tries={tries}
          actions={[settings]}
          onShowLog={log}
        />
      );
    case "busy":
      return (
        <Card
          tone="neu"
          icon="alert"
          title="An answer is still being written. Stop it first."
          tries={tries}
          actions={[{ label: "Stop it", run: opts.onStop }]}
          onShowLog={log}
        />
      );
    case "network":
      return (
        <Card
          tone="warn"
          icon="link"
          title={`Could not reach ${ai.host}.`}
          body={`Check your internet connection or proxy settings.${opts.partial ? " The part that arrived is kept." : ""}`}
          tries={tries}
          actions={[retry]}
          onShowLog={log}
        />
      );
    case "urlHasCredentials":
      return (
        <Card
          tone="bad"
          icon="lock"
          title={`The base URL for ${ai.host} has a user name and password.`}
          body={`Remove them from the base URL and save the key in the key field instead. ${nothingSent}`}
          tries={tries}
          actions={[settings]}
          onShowLog={log}
        />
      );
    case undefined:
      return <Card tone="bad" icon="error" title="Something went wrong" body={errorText(error)} tries={tries} onShowLog={log} />;
    default:
      return (
        <Card
          tone="bad"
          icon="error"
          title={errorText(error)}
          tries={tries}
          actions={[ai !== null && RETRYABLE.has(ai.kind) && retry, ai?.kind === "insecureUrl" && settings]}
          onShowLog={log}
        />
      );
  }
}

/** How a streamed answer ended when it did not end normally, as the thread marks it. */
export type EndKind = "dropped" | "length" | "refusal" | "stopped";

/** The mark inside a partial answer: "Cut off", "Length limit", "Stopped"; none for a declined one. */
export function endMark(kind: EndKind): string | null {
  switch (kind) {
    case "dropped":
      return "Cut off";
    case "length":
      return "Length limit";
    case "stopped":
      return "Stopped";
    case "refusal":
      return null;
  }
}

interface EndOptions {
  /** No complete SQL block arrived before the connection dropped. */
  sqlMissing?: boolean;
  /** The output tokens the answer stopped at. */
  output?: number | null;
  /** How long the answer ran before it was stopped. */
  millis?: number | null;
  /** Absent when the action does not apply, such as under an older answer. */
  onRetry?(): void;
  onEdit?(): void;
  onShowLog?(): void;
}

/**
 * The card under a SQL block that writes in an answer to Explain, Optimize or Suggest indexes (board 11.6,
 * "Answer writes"). `writes` is what it does, such as "1 delete" or "2 updates, 1 delete".
 */
export function answerWrites(writes: string, o: { onInsert?(): void; onCopy?(): void }): ReactElement {
  return (
    <Card
      tone="warn"
      icon="alert"
      title={`This answer writes to the database: ${writes}.`}
      body="The SQL check found a write. Insert puts it in the editor commented out, so Run cannot pick it up by accident."
      actions={[
        // Shown without a query tab too, like the block's own Insert, so the way in is plain.
        { label: "Insert commented out", run: o.onInsert ?? (() => {}), disabled: !o.onInsert },
        { label: "Copy", run: o.onCopy },
      ]}
    />
  );
}

/** The card under a partial or finished answer that did not end normally (board 11.6, "The answer"). */
export function answerEnd(kind: EndKind, o: EndOptions = {}): ReactElement {
  switch (kind) {
    case "dropped":
      return (
        <Card
          tone="warn"
          icon="alert"
          title="The connection dropped mid answer."
          body={`The part above is kept and marked.${o.sqlMissing ? " The SQL never arrived, so there is nothing to insert." : ""}`}
          actions={[{ label: "Retry the answer", run: o.onRetry }]}
          onShowLog={o.onShowLog}
        />
      );
    case "length":
      return (
        <Card
          tone="info"
          icon="info"
          title="The answer reached its length limit."
          body={
            o.output != null
              ? `It stopped at ${o.output.toLocaleString("en-US")} output tokens.`
              : "It stopped at the model's output limit."
          }
          onShowLog={o.onShowLog}
        />
      );
    case "refusal":
      return (
        <Card
          tone="neu"
          icon="close"
          title="The model declined to answer this."
          body="Rephrase the question, or ask about the schema instead of the data."
          actions={[{ label: "Edit the question", run: o.onEdit }]}
          onShowLog={o.onShowLog}
        />
      );
    case "stopped":
      return (
        <Card
          tone="neu"
          icon="close"
          title="Stopped."
          body={
            o.millis != null
              ? `You stopped the answer after ${secondsText(o.millis)}. The part above is kept.`
              : "The part above is kept."
          }
          actions={[{ label: "Retry", run: o.onRetry }]}
          onShowLog={o.onShowLog}
        />
      );
  }
}
