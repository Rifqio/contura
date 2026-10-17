import type { ReactElement, ReactNode } from "react";
import type { AiError, AiProviderKind } from "../api/types";
import { errorText } from "../api/client";
import Icon from "../components/Icon";
import { PROVIDERS } from "../settings/ai/providers";

interface Options {
  /** The saved provider's display name, for the cards that name it. */
  providerName?: string;
  onOpenSettings?(): void;
  onRetry?(): void;
}

/** The line kept in a thread when a provider is saved but its answers are not built yet. */
export function notAvailableText(provider: AiProviderKind): string {
  return `Answers from ${PROVIDERS[provider].name} arrive in a later Contura version. Nothing was sent.`;
}

function isAiError(e: unknown): e is AiError {
  const k = (e as { kind?: unknown } | null)?.kind;
  return typeof k === "string" && ["notConfigured", "notAvailable", "badKey", "rateLimited", "network"].includes(k);
}

/** The AiError inside a command error, or null when the error is something else. */
export function aiErrorOf(error: unknown): AiError | null {
  const e = error as { kind?: unknown; message?: unknown } | null;
  if (e && e.kind === "ai" && isAiError(e.message)) return e.message;
  return null;
}

function Card({ title, body, children }: { title: string; body: string; children: ReactNode }) {
  return (
    <div className="ai-err" role="alert">
      <b>
        <Icon name="error" />
        {title}
      </b>
      <span>{body}</span>
      <div className="row">{children}</div>
    </div>
  );
}

/** What the thread shows when a question could not be answered. */
export default function answerState(error: unknown, opts: Options = {}): ReactElement {
  const ai = aiErrorOf(error);
  const who = opts.providerName ?? "The provider";
  const settingsButton = (label: string, icon = true) => (
    <button type="button" className="button button-small" onClick={opts.onOpenSettings}>
      {icon && <Icon name="settings" />}
      {label}
    </button>
  );

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
    case "notAvailable":
      return <p className="msg-notice">{notAvailableText(ai.provider)}</p>;
    case "badKey":
      return (
        <Card
          title={`${who} rejected the API key`}
          body="The key was refused (401 Unauthorized). It may have been revoked. Paste a new key in AI settings."
        >
          {settingsButton("Open AI settings")}
        </Card>
      );
    case "rateLimited":
      return (
        <Card
          title={`${who} is rate limiting this key`}
          body={`Too many requests (429). ${
            ai.retryAfterSecs === null ? "Try again in a moment" : `Try again in ${ai.retryAfterSecs}s`
          }, or switch provider.`}
        >
          {settingsButton("Switch provider", false)}
        </Card>
      );
    case "network":
      return (
        <Card
          title={`Could not reach ${ai.host}`}
          body="Check your internet connection or proxy settings. Nothing left this PC."
        >
          {opts.onRetry && (
            <button type="button" className="button button-small" onClick={opts.onRetry}>
              <Icon name="refresh" />
              Retry
            </button>
          )}
        </Card>
      );
    default:
      return (
        <div className="ai-err" role="alert">
          <b>
            <Icon name="error" />
            Something went wrong
          </b>
          <span>{errorText(error)}</span>
        </div>
      );
  }
}
