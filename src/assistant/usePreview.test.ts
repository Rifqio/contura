import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AskRequest, Preview } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import { useAiPreview } from "./usePreview";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const req = (question: string): AskRequest => ({
  requestId: `r-${question}`,
  place: "ungrouped",
  groupId: null,
  connectionId: "c1",
  database: "shop",
  schema: null,
  action: "ask",
  question,
  threadId: null,
  focus: { sql: null, selection: null, error: null, filter: null, dbml: null, tables: [], untiedModel: false },
  switches: { rows: false, values: false },
  off: [],
});

const previewOf = (exact: string): Preview => ({
  items: [],
  tables: { full: [], namesOnly: [], leftOut: [], reasons: [] },
  totalBytes: exact.length,
  tokens: 1,
  exact,
  notes: [],
  log: [],
  context: null,
  rows: null,
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test("changes_within_300_ms_preview_once", async () => {
  routeInvoke({ ai_preview: (a) => previewOf((a.request as AskRequest).question) });
  const { result, rerender } = renderHook(({ r }) => useAiPreview(r), { initialProps: { r: req("a") } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  rerender({ r: req("b") });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(299);
  });
  expect(callsTo("ai_preview")).toHaveLength(0);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(callsTo("ai_preview")).toHaveLength(1);
  expect((callsTo("ai_preview")[0].request as AskRequest).question).toBe("b");
  expect(result.current.preview?.exact).toBe("b");
});

test("only_the_request_id_changing_does_not_preview_again", async () => {
  routeInvoke({ ai_preview: () => previewOf("x") });
  const { rerender } = renderHook(({ r }) => useAiPreview(r), { initialProps: { r: req("a") } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  rerender({ r: { ...req("a"), requestId: "another" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
  expect(callsTo("ai_preview")).toHaveLength(1);
});

test("a_refresh_change_previews_again", async () => {
  routeInvoke({ ai_preview: () => previewOf("x") });
  const r = req("a");
  const { rerender } = renderHook(({ refresh }) => useAiPreview(r, refresh), { initialProps: { refresh: "never" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  rerender({ refresh: "schema" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(callsTo("ai_preview")).toHaveLength(2);
});

test("a_slow_first_response_after_the_second_is_ignored", async () => {
  let releaseFirst: (p: Preview) => void = () => {};
  routeInvoke({
    ai_preview: (a) => {
      const q = (a.request as AskRequest).question;
      if (q === "a") return new Promise<Preview>((resolve) => (releaseFirst = resolve));
      return previewOf(q);
    },
  });
  const { result, rerender } = renderHook(({ r }) => useAiPreview(r), { initialProps: { r: req("a") } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  rerender({ r: req("b") });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(result.current.preview?.exact).toBe("b");
  await act(async () => {
    releaseFirst(previewOf("a"));
  });
  expect(callsTo("ai_preview")).toHaveLength(2);
  expect(result.current.preview?.exact).toBe("b");
});

test("a_failed_preview_gives_its_error", async () => {
  routeInvoke({
    ai_preview: () => {
      throw { kind: "notFound", message: "connection not found" };
    },
  });
  const { result } = renderHook(() => useAiPreview(req("a")));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(result.current.preview).toBeNull();
  expect(result.current.error).toBeTruthy();
});
