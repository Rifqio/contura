import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { AskRequest } from "../api/types";
import { aiStream, delta, memory, done, failed, line, sent, sentRecord, step } from "../test/aiStream";
import { callsTo, routeInvoke } from "../test/invoke";
import { type StreamEnd, secondsText, stopText, useAnswerStream } from "./answerStream";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
}));

const request = (id = "r1"): AskRequest => ({
  requestId: id,
  place: "ungrouped",
  groupId: null,
  connectionId: null,
  database: null,
  schema: null,
  action: "ask",
  question: "why slow?",
  threadId: null,
  focus: { sql: null, selection: null, error: null, filter: null, dbml: null, tables: [], untiedModel: false },
  switches: { rows: false, values: false },
  off: [],
});

let stream = aiStream();
beforeEach(() => {
  stream = aiStream();
  routeInvoke({ ai_ask_stream: stream.handler, ai_cancel: () => true });
});

test("deltas_render_in_order", async () => {
  stream.hold();
  const { result } = renderHook(() => useAnswerStream());
  let end: Promise<StreamEnd> | undefined;
  act(() => {
    end = result.current.start(request());
  });
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  expect(result.current.running).toBe(true);
  stream.emit({ type: "status", step: "Writing" });
  expect(result.current.status).toBe("Writing");
  stream.emit(delta("Add "), delta("an index "));
  expect(result.current.text).toBe("Add an index ");
  stream.emit({ type: "thinking", text: "orders is big" }, delta("on created_at."), done());
  expect(result.current.thinking).toBe("orders is big");
  const ended = await end!;
  expect(ended.text).toBe("Add an index on created_at.");
  expect(ended.done?.sentBytes).toBe(2314);
  expect(result.current.running).toBe(false);
});

test("stop_cancels_with_the_request_id_and_keeps_the_partial", async () => {
  stream.hold();
  const { result } = renderHook(() => useAnswerStream());
  let end: Promise<StreamEnd> | undefined;
  act(() => {
    end = result.current.start(request("r7"));
  });
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  stream.emit(delta("Half an"));
  act(() => result.current.stop());
  const ended = await end!;
  await waitFor(() => expect(callsTo("ai_cancel")).toEqual([{ requestId: "r7" }]));
  expect(ended).toMatchObject({ text: "Half an", stopped: true, done: null });
  // Late events of a stopped Ask change nothing.
  stream.emit(delta(" answer"));
  expect(result.current.text).toBe("Half an");
  expect(result.current.stopped).toBe(true);
});

test("a_cancelled_error_from_the_core_ends_the_stream", async () => {
  // Stop it in the panel stops the inline Ask too: the Core ends its stream with Cancelled.
  stream.hold();
  const { result } = renderHook(() => useAnswerStream());
  let end: Promise<StreamEnd> | undefined;
  act(() => {
    end = result.current.start(request("r9"));
  });
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  stream.emit(delta("Half"));
  expect(result.current.running).toBe(true);
  stream.emit({ type: "error", error: { kind: "cancelled" }, partial: false });
  const ended = await end!;
  expect(ended).toMatchObject({ text: "Half", stopped: true, error: null });
  expect(result.current.running).toBe(false);
  expect(callsTo("ai_cancel")).toEqual([]);
});

test("stop_before_start_settles_still_cancels", async () => {
  let started: (() => void) | undefined;
  routeInvoke({
    ai_ask_stream: () => new Promise<void>((resolve) => (started = resolve)),
    ai_cancel: () => true,
  });
  const { result } = renderHook(() => useAnswerStream());
  let end: Promise<StreamEnd> | undefined;
  act(() => {
    end = result.current.start(request("r5"));
  });
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  act(() => result.current.stop());
  expect((await end!).stopped).toBe(true);
  // The Core registers the Ask only when the command returns: cancelling earlier would miss it.
  expect(callsTo("ai_cancel")).toHaveLength(0);
  await act(async () => started!());
  await waitFor(() => expect(callsTo("ai_cancel")).toEqual([{ requestId: "r5" }]));
});

test("stop_after_a_refused_start_cancels_nothing", async () => {
  let refuse: ((e: unknown) => void) | undefined;
  routeInvoke({
    ai_ask_stream: () => new Promise<void>((_, reject) => (refuse = reject)),
    ai_cancel: () => true,
  });
  const { result } = renderHook(() => useAnswerStream());
  act(() => {
    void result.current.start(request("r6"));
  });
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  act(() => result.current.stop());
  await act(async () => refuse!({ kind: "ai", message: { kind: "busy" } }));
  await new Promise((r) => setTimeout(r, 0));
  expect(callsTo("ai_cancel")).toHaveLength(0);
});

test("an_error_event_keeps_the_partial_text", async () => {
  stream = aiStream(() => [delta("Partly"), failed({ kind: "network", host: "api.groq.com" }, true)]);
  routeInvoke({ ai_ask_stream: stream.handler, ai_cancel: () => true });
  const { result } = renderHook(() => useAnswerStream());
  let end: Promise<StreamEnd> | undefined;
  act(() => {
    end = result.current.start(request());
  });
  const ended = await end!;
  expect(ended).toMatchObject({ text: "Partly", partial: true, error: { kind: "ai", message: { kind: "network" } } });
  await waitFor(() => expect(result.current.error).toEqual({ kind: "ai", message: { kind: "network", host: "api.groq.com" } }));
});

test("a_refused_start_is_an_error", async () => {
  routeInvoke({
    ai_ask_stream: () => {
      throw { kind: "ai", message: { kind: "busy" } };
    },
  });
  const { result } = renderHook(() => useAnswerStream());
  let end: Promise<StreamEnd> | undefined;
  act(() => {
    end = result.current.start(request());
  });
  expect((await end!).error).toEqual({ kind: "ai", message: { kind: "busy" } });
});

test("unmounting_cancels_a_running_answer", async () => {
  stream.hold();
  const { result, unmount } = renderHook(() => useAnswerStream());
  act(() => {
    void result.current.start(request("r9"));
  });
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  unmount();
  await waitFor(() => expect(callsTo("ai_cancel")).toEqual([{ requestId: "r9" }]));
});

test("collects_sent_process_log", async () => {
  stream.hold();
  const { result } = renderHook(() => useAnswerStream());
  let end: Promise<StreamEnd> | undefined;
  act(() => {
    end = result.current.start(request());
  });
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  stream.emit(line(0, "info", "question", ["chars", "9"]), step("access", "schema, query text", { atMs: 2 }));
  expect(result.current.log).toHaveLength(1);
  expect(result.current.steps.map((s) => s.step)).toEqual(["access"]);
  expect(result.current.sent).toBeNull();
  stream.emit(sent(), line(214, "info", "request", ["bytes", "2314"]), { type: "thinking", text: "orders" }, delta("Half"));
  expect(result.current.sent).toEqual(sentRecord());
  act(() => result.current.stop());
  const ended = await end!;
  // Stop keeps what arrived, and nothing later is added.
  stream.emit(step("answer", "partial, by the model"));
  expect(ended.live.sent).toEqual(sentRecord());
  expect(ended.live.steps.map((s) => s.step)).toEqual(["access"]);
  expect(ended.live.log.map((l) => l.source)).toEqual(["question", "request"]);
  expect(ended.live.thinking).toBe("orders");
  expect(result.current.steps).toHaveLength(1);
});

test("seconds_format", () => {
  expect(secondsText(800)).toBe("0.8s");
  expect(secondsText(1900)).toBe("1.9s");
  expect(secondsText(9_960)).toBe("10s");
  expect(secondsText(12_000)).toBe("12s");
  expect(secondsText(75_000)).toBe("75s");
});

test("stop_reasons_have_their_words", () => {
  expect(stopText("length")).toBe("Length limit");
  expect(stopText("refusal")).toBe("The model declined");
  expect(stopText("dropped")).toBe("The connection dropped mid answer");
  expect(stopText("tooLong")).toBe("Stopped: the answer was too long");
  expect(stopText("end")).toBeNull();
});

test("thinking_kept_replaces_the_chunks", async () => {
  stream.hold();
  const { result } = renderHook(() => useAnswerStream());
  let end: Promise<StreamEnd> | undefined;
  act(() => {
    end = result.current.start(request());
  });
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  stream.emit({ type: "thinking", text: "key gsk_ab" }, { type: "thinking", text: "cd and more" });
  expect(result.current.thinking).toBe("key gsk_abcd and more");
  stream.emit({ type: "thinkingKept", text: "key [redacted] and more" } as never, delta("ok"), done());
  const ended = await end!;
  expect(result.current.thinking).toBe("key [redacted] and more");
  expect(ended.live.thinking).toBe("key [redacted] and more");
});

test("memory_event_kept", async () => {
  stream.hold();
  const { result } = renderHook(() => useAnswerStream());
  let end: Promise<StreamEnd> | undefined;
  act(() => {
    end = result.current.start(request());
  });
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  expect(result.current.memory).toBeNull();
  stream.emit(memory({ topic: 2, opened: true, reason: "subject", title: "Biggest customers" }), sent(), delta("Ok."), done());
  expect(result.current.memory?.title).toBe("Biggest customers");
  const ended = await end!;
  expect(ended.stamp).toMatchObject({ topic: 2, opened: true, reason: "subject", kinds: ["question", "cards"] });
});

test("text_listeners_hear_at_most_once_per_frame_and_release_lets_the_answer_go", async () => {
  stream.hold();
  const { result } = renderHook(() => useAnswerStream());
  let end: Promise<StreamEnd> | undefined;
  act(() => {
    end = result.current.start(request("r3"));
  });
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  let heard = 0;
  const off = result.current.subscribe(() => heard++);
  stream.emit(delta("a"), delta("b"), delta("c"), { type: "thinking", text: "hmm" });
  expect(heard).toBe(0);
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  expect(heard).toBe(1);
  expect(result.current.text).toBe("abc");
  // The end draws what is pending at once.
  stream.emit(delta("d"), done());
  expect(heard).toBe(2);
  await end;
  act(() => result.current.release());
  expect(result.current.text).toBe("");
  expect(result.current.thinking).toBe("");
  expect(result.current.log).toEqual([]);
  off();
});
