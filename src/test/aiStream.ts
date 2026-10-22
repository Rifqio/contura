import { act } from "@testing-library/react";
import type { AiDone, AiError, AiEvent, AskRequest, LogLevel, ProcessStep, SentRecord, StepKind } from "../api/types";

type Sink = { onmessage: (e: AiEvent) => void };

/**
 * A scripted `ai_ask_stream` for `routeInvoke`. Each test file must mock
 * `@tauri-apps/api/core` with a `Channel` class that has an `onmessage` field.
 * `reply` gives the events of each Ask; they arrive after the command returns, as from the Core.
 * `hold()` keeps the next Asks open so a test can `emit` into them and press Stop.
 */
export function aiStream(reply: (request: AskRequest, n: number) => AiEvent[] = () => []) {
  const sinks: { request: AskRequest; sink: Sink }[] = [];
  let held = false;
  const handler = (a: Record<string, unknown>) => {
    const request = a.request as AskRequest;
    const sink = a.events as Sink;
    sinks.push({ request, sink });
    if (held) return undefined;
    const events = reply(request, sinks.length);
    setTimeout(() => events.forEach((e) => sink.onmessage(e)), 0);
    return undefined;
  };
  return {
    handler,
    hold() {
      held = true;
    },
    /** Sends events into the last Ask, inside act. */
    emit(...events: AiEvent[]) {
      const last = sinks[sinks.length - 1];
      act(() => events.forEach((e) => last.sink.onmessage(e)));
    },
    requests: () => sinks.map((s) => s.request),
  };
}

export const delta = (text: string): AiEvent => ({ type: "delta", text });

export const done = (over: Partial<AiDone> = {}): AiDone => ({
  type: "done",
  usage: { input: 500, output: 120, cacheRead: 0, cacheWrite: 0 },
  stop: "end",
  sentBytes: 2314,
  model: "llama-3.3-70b-versatile",
  provider: "groq",
  millis: 1900,
  notes: [],
  sqlBlocks: [],
  ...over,
});

export const failed = (error: AiError, partial = false): AiEvent => ({ type: "error", error, partial });

/** The Core's Sent record event: 2,314 B to Groq's gpt-oss-20b, exact text not kept. */
export const sent = (over: Partial<SentRecord> = {}): AiEvent => ({ type: "sent", ...sentRecord(over) });

export const sentRecord = (over: Partial<SentRecord> = {}): SentRecord => ({
  at: 0,
  kinds: ["question", "names", "cards"],
  bytes: 2314,
  tokens: 640,
  provider: "groq",
  model: "openai/gpt-oss-20b",
  modelName: "GPT OSS 20B",
  host: "api.groq.com",
  hash: "8f2c0a1b3d4e5f60",
  outlineCall: false,
  summaryCall: false,
  exact: null,
  ...over,
});

/** A Steps row event. */
export const step = (kind: StepKind, value: string, over: Partial<ProcessStep> = {}): AiEvent => ({
  type: "process",
  step: kind,
  atMs: 0,
  value,
  rule: "",
  evidence: [],
  byModel: false,
  ...over,
});

/** A log line event: `line(214, "info", "request", ["bytes", "2314"])`. */
export const line = (atMs: number, level: LogLevel, source: string, ...fields: [string, string][]): AiEvent => ({
  type: "log",
  atMs,
  level,
  source,
  fields,
});
