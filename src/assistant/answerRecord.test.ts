import { expect, test } from "vitest";
import type { LogLine, ProcessStep } from "../api/types";
import { done, sentRecord } from "../test/aiStream";
import { errorText } from "../api/client";
import {
  buildRecord,
  logTime,
  logText,
  mainNeverLeft,
  markOf,
  neverLeft,
  onlyOutlineLeft,
  recordError,
  recordOf,
  sentLine,
  stepTime,
} from "./answerRecord";
import type { StreamEnd } from "./answerStream";

const NO_LIVE = { sent: null, steps: [], log: [], thinking: "" };

const end = (over: Partial<StreamEnd> = {}): StreamEnd => ({
  text: "",
  done: null,
  error: null,
  partial: false,
  stopped: false,
  at: 0,
  live: NO_LIVE,
  ...over,
});

test("log_time_format", () => {
  expect(logTime(0)).toBe("00.000");
  expect(logTime(214)).toBe("00.214");
  expect(logTime(1912)).toBe("01.912");
  expect(logTime(123_400)).toBe("123.400");
});

test("step_time_is_compact", () => {
  expect(stepTime(2)).toBe("2ms");
  expect(stepTime(20)).toBe("20ms");
  expect(stepTime(214)).toBe("0.2s");
  expect(stepTime(1900)).toBe("1.9s");
});

test("log_text_lines", () => {
  const lines: LogLine[] = [
    { atMs: 214, level: "info", source: "request", fields: [["provider", "groq"], ["model", "openai/gpt-oss-20b"], ["tools", "none"]] },
    { atMs: 1102, level: "debug", source: "thinking", fields: [["chars", "412"]] },
    { atMs: 1912, level: "error", source: "http", fields: [["kind", "rateLimited"], ["status", "429"]] },
    { atMs: 1912, level: "info", source: "database", fields: [] },
  ];
  expect(logText(lines)).toBe(
    [
      "00.214 INFO request provider=groq model=openai/gpt-oss-20b tools=none",
      "01.102 DEBUG thinking chars=412",
      "01.912 ERROR http kind=rateLimited status=429",
      "01.912 INFO database",
    ].join("\n"),
  );
});

test("mark_of_each_end", () => {
  expect(markOf(end({ stopped: true, text: "Half" }))).toBe("stopped");
  expect(markOf(end({ error: { kind: "ai", message: { kind: "badKey" } } }))).toBe("failed");
  expect(markOf(end({ done: done() }))).toBeNull();
  expect(markOf(end({ done: done({ stop: "length" }) }))).toBe("length");
  expect(markOf(end({ done: done({ stop: "refusal" }) }))).toBe("refusal");
  expect(markOf(end({ done: done({ stop: "dropped" }) }))).toBe("dropped");
  expect(markOf(end({ done: done({ stop: "tooLong" }) }))).toBe("tooLong");
});

test("build_record_from_a_done_answer", () => {
  const steps: ProcessStep[] = [{ step: "access", atMs: 2, value: "schema", rule: "r", evidence: [], byModel: false }];
  const log: LogLine[] = [{ atMs: 0, level: "info", source: "question", fields: [["chars", "9"]] }];
  const live = { sent: sentRecord(), steps, log, thinking: "orders is big" };
  const d = done({ notes: ["A note."], sqlBlocks: [{ fence: 0, label: "1 statement: 1 read", statements: [] }] });
  expect(buildRecord(end({ done: d, text: "x" }), live)).toEqual({
    sent: sentRecord(),
    usage: d.usage,
    millis: 1900,
    stop: "end",
    mark: null,
    error: null,
    sqlBlocks: d.sqlBlocks,
    notes: ["A note."],
    thinking: "orders is big",
    log,
    steps,
    actions: [],
    context: null,
    commandError: null,
    maxTokens: 4096,
  });
});

test("the_record_keeps_the_max_tokens_the_core_sent", () => {
  // A length stop without usage names this cap, whatever the settings say later.
  const r = buildRecord(end({ done: done({ stop: "length", usage: null, maxTokens: 28_672 }), text: "x" }), NO_LIVE);
  expect(r.maxTokens).toBe(28_672);
  expect(recordOf(JSON.parse(JSON.stringify(r)))?.maxTokens).toBe(28_672);
  // A record saved before the Core sent it has none.
  expect(recordOf({ millis: 5 })?.maxTokens).toBeUndefined();
});

test("build_record_from_a_failure_keeps_the_ai_error", () => {
  const r = buildRecord(end({ error: { kind: "ai", message: { kind: "rateLimited", retryAfterSecs: 20 } } }), {
    ...NO_LIVE,
    sent: sentRecord(),
  });
  expect(r.error).toEqual({ kind: "rateLimited", retryAfterSecs: 20 });
  expect(r.mark).toBe("failed");
  expect(r.stop).toBeNull();
  expect(r.thinking).toBeNull();
  expect(r.sqlBlocks).toEqual([]);
});

test("sent_line_from_the_record", () => {
  const at = new Date(2026, 9, 19, 11, 42, 30).getTime();
  const r = buildRecord(end({ done: done() }), { ...NO_LIVE, sent: sentRecord() });
  expect(sentLine(r, at)).toBe("11:42 · Sent 2,314 B to Groq, gpt-oss-20b, 1.9s");
  const cached = { ...r, usage: { input: 500, output: 120, cacheRead: 1840, cacheWrite: 0 } };
  expect(sentLine(cached, at)).toBe("11:42 · Sent 2,314 B to Groq, gpt-oss-20b, 1.9s, 1,840 cached");
  expect(sentLine({ ...r, sent: null }, at)).toBeNull();
});

test("sent_line_with_an_unknown_provider_uses_its_id", () => {
  const at = new Date(2026, 9, 19, 11, 42, 30).getTime();
  const r = buildRecord(end({ done: done() }), { ...NO_LIVE, sent: sentRecord({ provider: "mistral" as never }) });
  expect(sentLine(r, at)).toBe("11:42 · Sent 2,314 B to mistral, gpt-oss-20b, 1.9s");
});

test("sent_line_when_the_connection_failed", () => {
  const at = new Date(2026, 9, 19, 11, 42, 30).getTime();
  const r = buildRecord(end({ error: { kind: "ai", message: { kind: "timeout", phase: "connect" } } }), { ...NO_LIVE, sent: sentRecord() });
  expect(neverLeft(r)).toBe(true);
  expect(sentLine(r, at)).toBe("11:42 · Not sent to Groq, no connection");
  const late = buildRecord(end({ error: { kind: "ai", message: { kind: "timeout", phase: "first byte" } } }), { ...NO_LIVE, sent: sentRecord() });
  expect(neverLeft(late)).toBe(false);
});

test("network_connect_never_left", () => {
  const at = new Date(2026, 9, 19, 11, 42, 30).getTime();
  const refused = buildRecord(end({ error: { kind: "ai", message: { kind: "network", host: "api.groq.com", connect: true } } }), { ...NO_LIVE, sent: sentRecord() });
  expect(neverLeft(refused)).toBe(true);
  expect(sentLine(refused, at)).toBe("11:42 · Not sent to Groq, no connection");
  // A network failure after the request went is not one.
  const late = buildRecord(end({ error: { kind: "ai", message: { kind: "network", host: "api.groq.com", connect: false } } }), { ...NO_LIVE, sent: sentRecord() });
  expect(neverLeft(late)).toBe(false);
  const old = buildRecord(end({ error: { kind: "ai", message: { kind: "network", host: "api.groq.com" } } }), { ...NO_LIVE, sent: sentRecord() });
  expect(neverLeft(old)).toBe(false);
});

const OUTLINE_LEFT = { bytes: 1204, tokens: 300, hash: "00aa11bb22cc33dd", pickedAreas: 0, pickedTables: 0, dropped: 0, usage: null, exact: null, left: true };
// The outline call's own record: the main request was not sent.
const OUTLINE_ONLY = sentRecord({ bytes: 0, tokens: 0, hash: "", kinds: ["outline"], exact: null, outlineCall: true, outline: OUTLINE_LEFT });

test("sent_line_when_only_the_outline_step_left", () => {
  const at = new Date(2026, 9, 19, 11, 42, 30).getTime();
  // The answer request could not connect after the outline call went.
  const offline = buildRecord(end({ error: { kind: "ai", message: { kind: "offline" } } }), {
    ...NO_LIVE,
    sent: sentRecord({ outlineCall: true, outline: OUTLINE_LEFT }),
  });
  expect(neverLeft(offline)).toBe(false);
  expect(mainNeverLeft(offline)).toBe(true);
  expect(onlyOutlineLeft(offline)).toBe(true);
  expect(sentLine(offline, at)).toBe("11:42 · Only the outline step was sent to Groq, 1,204 B");
  // The answer request was too big to build, or the Ask was stopped after the outline call.
  const tooBig = buildRecord(end({ error: { kind: "ai", message: { kind: "tooBig", needed: 40000, window: 32000, model: "M" } } }), {
    ...NO_LIVE,
    sent: OUTLINE_ONLY,
  });
  expect(sentLine(tooBig, at)).toBe("11:42 · Only the outline step was sent to Groq, 1,204 B");
  const stopped = buildRecord(end({ stopped: true }), { ...NO_LIVE, sent: OUTLINE_ONLY });
  expect(neverLeft(stopped)).toBe(false);
  expect(sentLine(stopped, at)).toBe("11:42 · Only the outline step was sent to Groq, 1,204 B");
  // Both went: the line counts both.
  const both = buildRecord(end({ done: done() }), { ...NO_LIVE, sent: sentRecord({ outlineCall: true, outline: OUTLINE_LEFT }) });
  expect(onlyOutlineLeft(both)).toBe(false);
  expect(sentLine(both, at)).toBe("11:42 · Sent 3,518 B to Groq, gpt-oss-20b, 1.9s");
  // No outline: a connection that failed still sent nothing.
  const none = buildRecord(end({ error: { kind: "ai", message: { kind: "offline" } } }), { ...NO_LIVE, sent: sentRecord() });
  expect(onlyOutlineLeft(none)).toBe(false);
  expect(neverLeft(none)).toBe(true);
});

test("records_carry_their_actions", () => {
  expect(buildRecord(end({ done: done() }), NO_LIVE).actions).toEqual([]);
  expect(recordOf({})!.actions).toEqual([]);
  expect(recordOf({ actions: [{ kind: "inserted", at: 3 }] })!.actions).toEqual([{ kind: "inserted", at: 3 }]);
});

// ---- 11c carry-overs ----

test("command_error_survives_reload", () => {
  const log: LogLine[] = [{ atMs: 4, level: "info", source: "question", fields: [["chars", "9"]] }];
  const r = buildRecord(end({ error: { kind: "query", message: "the store is locked" } }), { ...NO_LIVE, sent: sentRecord(), log });
  expect(r.mark).toBe("failed");
  expect(r.error).toBeNull();
  // Kept as plain text in its own field; the Core's log is left as it came.
  expect(r.commandError).toBe("The query failed: the store is locked");
  expect(r.log).toEqual(log);
  expect(buildRecord(end({ done: done() }), NO_LIVE).commandError).toBeNull();
  // The thread goes through JSON on its way to disk and back.
  const back = recordOf(JSON.parse(JSON.stringify(r)))!;
  expect(errorText(recordError(back))).toBe("The query failed: the store is locked");
  // An AI error comes back in the command error shape; a normal end has none.
  const ai = buildRecord(end({ error: { kind: "ai", message: { kind: "badKey" } } }), NO_LIVE);
  expect(recordError(ai)).toEqual({ kind: "ai", message: { kind: "badKey" } });
  expect(recordError(buildRecord(end({ done: done() }), NO_LIVE))).toBeNull();
  expect(recordError(buildRecord(end({ stopped: true }), NO_LIVE))).toBeNull();
});

test("log_time_never_prints_1000", () => {
  expect(logTime(1999.6)).toBe("02.000");
  expect(logTime(999.5)).toBe("01.000");
  expect(logTime(214.4)).toBe("00.214");
  for (const ms of [0.5, 59_999.9, 1_000.7, 123_999.5]) expect(logTime(ms)).not.toMatch(/\.1000$/);
});

test("the_context_is_read_but_not_copied_from_the_live_event", () => {
  const info = {
    connectionId: "c1",
    database: "shop",
    schema: "public",
    sync: "automatic" as const,
    builtAt: 5,
    tableCount: 6,
    stale: false,
    check: { kind: "failed" as const },
  };
  // The Core writes AnswerRecord.context; the UI never copies the live event in.
  expect(buildRecord(end({ done: done() }), { ...NO_LIVE, context: info }).context).toBeNull();
  expect(recordOf({})!.context).toBeNull();
  expect(recordOf({ context: info })!.context).toEqual(info);
});

test("the_record_keeps_the_connections_a_diagram_ask_drew_on", () => {
  // Task 4b: the history gate reads `sent.sources` back from the saved record; a rebuild must never drop it.
  const sent = { ...sentRecord(), sources: ["c1", "c2"] };
  const r = buildRecord(end({ done: done(), text: "x" }), { ...NO_LIVE, sent });
  expect(r.sent?.sources).toEqual(["c1", "c2"]);
  expect(recordOf(JSON.parse(JSON.stringify(r)))?.sent?.sources).toEqual(["c1", "c2"]);
});
