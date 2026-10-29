import { errorText } from "../api/client";
import type { AiProviderKind, AnswerMark, AnswerRecord, ContextInfo, LogLine, ProcessStep, SentRecord } from "../api/types";
import { PROVIDERS } from "../settings/ai/providers";
import { aiErrorOf } from "./answerState";
import { type AnswerStream, secondsText, type StreamEnd } from "./answerStream";

/** What a streamed Ask collected besides its text: the Sent record, the Steps rows, the log and the thinking. */
export interface LiveRecord {
  sent: SentRecord | null;
  steps: ProcessStep[];
  log: LogLine[];
  thinking: string;
  /** The AI Context the Ask uses, from its `context` event. Never copied into the record: the Core writes that. */
  context?: ContextInfo | null;
}

/** How an answer ended when it did not end normally; null for a normal end. */
export function markOf(end: StreamEnd): AnswerMark | null {
  if (end.stopped) return "stopped";
  if (end.error !== null) return "failed";
  if (!end.done || end.done.stop === "end") return null;
  return end.done.stop;
}

/** The record saved with an assistant message: what the Ask sent, how it ended, its checks and its log. */
export function buildRecord(end: StreamEnd, live: LiveRecord): AnswerRecord {
  const done = end.done;
  const ai = aiErrorOf(end.error);
  return {
    sent: live.sent,
    usage: done?.usage ?? null,
    millis: done?.millis ?? null,
    stop: done?.stop ?? null,
    mark: markOf(end),
    error: ai,
    sqlBlocks: done?.sqlBlocks ?? [],
    notes: done?.notes ?? [],
    thinking: live.thinking || null,
    log: live.log,
    steps: live.steps,
    actions: [],
    context: null,
    // AnswerRecord.error holds only an AiError, so another command error is kept as its plain text.
    commandError: end.error !== null && ai === null ? errorText(end.error) : null,
    ...(done?.maxTokens != null ? { maxTokens: done.maxTokens } : {}),
  };
}

/** The record of the Ask being streamed (or last streamed), as far as it got. */
export function streamRecord(s: AnswerStream): AnswerRecord {
  const live = { sent: s.sent, steps: s.steps, log: s.log, thinking: s.thinking };
  return buildRecord({ text: s.text, done: s.done, error: s.error, partial: s.partial, stopped: s.stopped, at: 0, live }, live);
}

/** A record read from disk, with the fields an older or hand-edited thread may lack. */
export function recordOf(r: Partial<AnswerRecord> | undefined): AnswerRecord | null {
  if (!r) return null;
  return {
    sent: r.sent ?? null,
    usage: r.usage ?? null,
    millis: r.millis ?? null,
    stop: r.stop ?? null,
    mark: r.mark ?? null,
    error: r.error ?? null,
    sqlBlocks: r.sqlBlocks ?? [],
    notes: r.notes ?? [],
    thinking: r.thinking ?? null,
    log: r.log ?? [],
    steps: r.steps ?? [],
    actions: r.actions ?? [],
    context: r.context ?? null,
    commandError: r.commandError ?? null,
    ...(r.maxTokens != null ? { maxTokens: r.maxTokens } : {}),
    ...(r.trimmed ? { trimmed: true } : {}),
  };
}

/**
 * Why a saved answer failed, in the command error shape its card takes: `{ kind: "ai", message }` for an AiError, the
 * plain text of another command error, or null when it did not fail.
 */
export function recordError(record: AnswerRecord): unknown {
  if (record.error) return { kind: "ai", message: record.error };
  if (record.mark !== "failed") return null;
  return record.commandError;
}

/** A provider's name; the id itself for one this build does not know (a record from another version). */
export const providerName = (kind: AiProviderKind): string => PROVIDERS[kind]?.name ?? kind;

/**
 * The Ask's main request never left the PC: no connection (offline, a failed TLS handshake, a connect timeout), or the
 * Ask ended after the outline step, before that request was built (its record has no bytes). A network failure later
 * in the request may have sent it, so it is not one.
 */
export function mainNeverLeft(record: AnswerRecord): boolean {
  const e = record.error;
  if ((record.sent?.outline || record.sent?.summary) && record.sent.bytes === 0) return true;
  return e?.kind === "offline" || e?.kind === "tls" || (e?.kind === "network" && e.connect === true) || (e?.kind === "timeout" && e.phase === "connect");
}

/** The outline step's request left the PC but the main request did not. The Core keeps an outline record only once it left. */
export function onlyOutlineLeft(record: AnswerRecord): boolean {
  const o = record.sent?.outline;
  return !!o && o.left !== false && mainNeverLeft(record);
}

/** The summary or compaction call left the PC but the main request did not (no outline step went either). */
export function onlySummaryLeft(record: AnswerRecord): boolean {
  return !!record.sent?.summary && !onlyOutlineLeft(record) && mainNeverLeft(record);
}

/** Nothing of the Ask left the PC: the main request never went, and no outline or summary step went before it. */
export function neverLeft(record: AnswerRecord): boolean {
  return mainNeverLeft(record) && !onlyOutlineLeft(record) && !onlySummaryLeft(record);
}

/** A log line's time from the start, seconds and milliseconds: `00.214`, `01.912`, `123.400`. */
export function logTime(atMs: number): string {
  // Rounded before the split, so 1,999.6 reads 02.000 and never 01.1000.
  const ms = Math.round(atMs);
  return `${String(Math.floor(ms / 1000)).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

/** A Steps time, compact: `20ms` below a tenth of a second, then `0.2s`, `1.9s`. */
export function stepTime(atMs: number): string {
  return atMs < 100 ? `${Math.round(atMs)}ms` : secondsText(atMs);
}

/** A line's fields as `key=value`, space separated. */
export function fieldsText(line: LogLine): string {
  return line.fields.map(([k, v]) => `${k}=${v}`).join(" ");
}

/** The log as plain lines: `00.214 INFO request provider=groq model=openai/gpt-oss-20b`. */
export function logText(lines: LogLine[]): string {
  return lines
    .map((l) => [logTime(l.atMs), l.level.toUpperCase(), l.source, fieldsText(l)].filter(Boolean).join(" "))
    .join("\n");
}

/** The local clock, `09:05`. */
function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** A model id without its vendor folder: `openai/gpt-oss-20b` reads `gpt-oss-20b`. */
export const shortModel = (id: string) => id.slice(id.lastIndexOf("/") + 1);

/** Every byte the Ask sent: the main request, the outline step and the summary step (the Sent cell, the line, the Diagram). */
export const sentBytes = (s: SentRecord): number => s.bytes + (s.outline?.bytes ?? 0) + (s.summary?.bytes ?? 0);

/**
 * The line under an answer: "11:42 · Sent 2,314 B to Groq, gpt-oss-20b, 1.9s", plus ", 1,840 cached" when the
 * provider read from its cache; every call counts (the main request, the outline step, the summary step); "Only the outline step was sent to Groq, 1,204 B" when the main request did not go.
 * Null when there is no Sent record.
 */
export function sentLine(record: AnswerRecord, at: number, opts: { tool?: boolean } = {}): string | null {
  const s = record.sent;
  if (!s) return null;
  if (onlyOutlineLeft(record) && s.outline) {
    return `${clock(at)} · Only the outline step was sent to ${providerName(s.provider)}, ${s.outline.bytes.toLocaleString("en-US")} B`;
  }
  if (onlySummaryLeft(record) && s.summary) {
    const step = s.summary.kind === "compact" ? "compaction" : "summary";
    return `${clock(at)} · Only the ${step} step was sent to ${providerName(s.provider)}, ${s.summary.bytes.toLocaleString("en-US")} B`;
  }
  if (neverLeft(record)) return `${clock(at)} · Not sent to ${providerName(s.provider)}, no connection`;
  const parts = [`${clock(at)} · Sent ${sentBytes(s).toLocaleString("en-US")} B to ${providerName(s.provider)}`, shortModel(s.model)];
  // A diagram Ask carries one tool.
  if (opts.tool) parts.push("one tool");
  if (record.millis != null) parts.push(secondsText(record.millis));
  const cached = record.usage?.cacheRead ?? 0;
  if (cached > 0) parts.push(`${cached.toLocaleString("en-US")} cached`);
  return parts.join(", ");
}
