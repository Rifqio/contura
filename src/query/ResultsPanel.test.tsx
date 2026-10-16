import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test, vi } from "vitest";
import type { Cell, ExecOutcome } from "../api/types";
import { mockReactFlowDom } from "../test/reactFlow";
import ResultsPanel from "./ResultsPanel";
import { EMPTY_RUNNER, type RunnerState, runnerReducer } from "./runner";
import type { Stmt } from "./statements";

beforeAll(mockReactFlowDom);

const stmt = (text: string, from = 0): Stmt => ({ from, to: from + text.length, text });
const rowsOf = (n: number, offset = 0): Cell[][] =>
  Array.from({ length: n }, (_, i) => [{ t: "number", value: String(i + 1 + offset) }]);
const rows = (n: number, hasMore: boolean): ExecOutcome => ({
  t: "rows",
  columns: [{ name: "id", typeName: "int4", numeric: true }],
  rows: rowsOf(n),
  hasMore,
});

/** Starts `texts` and begins the first one. */
function started(texts: string[], from: RunnerState = EMPTY_RUNNER): RunnerState {
  const s = runnerReducer(from, { type: "start", stmts: texts.map((t) => stmt(t)) });
  return runnerReducer(s, { type: "begin", now: 0 });
}

test("start_replaces_unpinned_results_and_keeps_pinned", () => {
  let s = started(["SELECT 1"]);
  s = runnerReducer(s, { type: "done", id: s.items[0].id, outcome: rows(1, false), ms: 3 });
  s = runnerReducer(s, { type: "pin", id: s.items[0].id });
  s = started(["SELECT 2"], s);
  s = runnerReducer(s, { type: "done", id: s.items[1].id, outcome: rows(1, false), ms: 3 });
  const keep = s.items[0].id;
  s = runnerReducer(s, { type: "start", stmts: [stmt("SELECT 3")] });
  expect(s.items.map((i) => i.id)).toEqual([keep]);
  expect(s.queue.map((q) => q.text)).toEqual(["SELECT 3"]);
});

test("a_failure_stops_the_rest_of_run_all", () => {
  let s = started(["SELECT 1", "SELECT 2", "SELECT 3"]);
  expect(s.queue).toHaveLength(2);
  s = runnerReducer(s, { type: "failed", id: s.items[0].id, error: { kind: "query", message: "boom (position 3)" } });
  expect(s.queue).toEqual([]);
  expect(s.items[0].state).toEqual({ s: "error", message: "boom", at: 2 });
});

test("only_the_newest_rows_result_stays_open", () => {
  let s = started(["SELECT 1", "SELECT 2"]);
  s = runnerReducer(s, { type: "done", id: s.items[0].id, outcome: rows(1000, true), ms: 3 });
  expect(s.items[0].state).toMatchObject({ s: "rows", open: true });
  s = runnerReducer(s, { type: "begin", now: 0 });
  expect(s.items[0].state).toMatchObject({ s: "rows", open: false });
});

test("more_rows_append_and_close_at_the_end", () => {
  let s = started(["SELECT 1"]);
  const id = s.items[0].id;
  s = runnerReducer(s, { type: "done", id, outcome: rows(1000, true), ms: 3 });
  s = runnerReducer(s, { type: "more", id, rows: rowsOf(500, 1000), hasMore: false });
  expect(s.items[0].state).toMatchObject({ s: "rows", hasMore: false, open: false });
  expect((s.items[0].state as { rows: Cell[][] }).rows).toHaveLength(1500);
});

function panel(state: RunnerState, extra: Partial<Parameters<typeof ResultsPanel>[0]> = {}) {
  const props = {
    onSelect: vi.fn(),
    onPin: vi.fn(),
    onCloseUnpinned: vi.fn(),
    onFetchMore: vi.fn(),
    onCancel: vi.fn(),
    onRunAgain: vi.fn(),
    onGoTo: vi.fn(),
  };
  render(<ResultsPanel state={state} timeoutSecs={null} lineAt={() => 2} {...props} {...extra} />);
  return props;
}

test("panel_shows_rows_footer_and_fetch_next", async () => {
  let s = started(["SELECT 1"]);
  s = runnerReducer(s, { type: "done", id: s.items[0].id, outcome: rows(1000, true), ms: 38 });
  const p = panel(s);
  expect(screen.getByText("First 1,000 rows")).toBeTruthy();
  expect(screen.getByText("38 ms")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Fetch next 1,000" }));
  expect(p.onFetchMore).toHaveBeenCalledWith(s.items[0].id);
});

test("a_closed_result_says_to_run_it_again", () => {
  let s = started(["SELECT 1", "SELECT 2"]);
  s = runnerReducer(s, { type: "done", id: s.items[0].id, outcome: rows(1000, true), ms: 3 });
  s = runnerReducer(s, { type: "begin", now: 0 });
  s = runnerReducer(s, { type: "select", index: 0 });
  panel(s);
  expect(screen.getByText("Run it again to fetch more")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Fetch next 1,000" })).toBeNull();
});

test("panel_shows_affected_cancelled_timeout_and_error_states", async () => {
  let s = started(["UPDATE t SET a = 1 WHERE b = 2"]);
  s = runnerReducer(s, { type: "done", id: s.items[0].id, outcome: { t: "affected", rows: 12 }, ms: 41 });
  const { unmount } = render(
    <ResultsPanel
      state={s}
      timeoutSecs={null}
      lineAt={() => 1}
      onSelect={() => {}}
      onPin={() => {}}
      onCloseUnpinned={() => {}}
      onFetchMore={() => {}}
      onCancel={() => {}}
      onRunAgain={() => {}}
      onGoTo={() => {}}
    />,
  );
  expect(screen.getByText("UPDATE 12 rows")).toBeTruthy();
  expect(screen.getByRole("tab", { name: /UPDATE/ })).toBeTruthy();
  unmount();

  s = started(["SELECT pg_sleep(30)"]);
  s = runnerReducer(s, { type: "failed", id: s.items[0].id, error: { kind: "cancelled" }, ms: 2400 });
  const c = render(<ResultsPanel state={s} timeoutSecs={null} lineAt={() => 1} {...noop} />);
  expect(screen.getByText("Cancelled after 2.4 s")).toBeTruthy();
  c.unmount();

  s = started(["SELECT pg_sleep(40)"]);
  s = runnerReducer(s, { type: "failed", id: s.items[0].id, error: { kind: "timedOut", message: 30 } });
  const t = render(<ResultsPanel state={s} timeoutSecs={30} lineAt={() => 1} {...noop} />);
  expect(screen.getByText("Stopped after 30 s")).toBeTruthy();
  t.unmount();

  s = started(["SELECT id FROM menu_itms"]);
  s = runnerReducer(s, {
    type: "failed",
    id: s.items[0].id,
    error: { kind: "query", message: 'relation "menu_itms" does not exist (position 16)' },
  });
  const p = panel(s);
  expect(screen.getByText('relation "menu_itms" does not exist')).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Go to line 2" }));
  expect(p.onGoTo).toHaveBeenCalledWith(15, 15);
  await userEvent.click(screen.getByRole("button", { name: "Ask AI" }));
  expect(screen.getByText("Connect an AI provider in Settings.")).toBeTruthy();
});

const noop = {
  onSelect: () => {},
  onPin: () => {},
  onCloseUnpinned: () => {},
  onFetchMore: () => {},
  onCancel: () => {},
  onRunAgain: () => {},
  onGoTo: () => {},
};

test("running_shows_timer_and_cancel", async () => {
  const s = started(["SELECT pg_sleep(30)"]);
  const p = panel(s);
  expect(screen.getByText("Running")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(p.onCancel).toHaveBeenCalled();
});

test("pin_and_close_unpinned_call_back", async () => {
  let s = started(["SELECT 1"]);
  s = runnerReducer(s, { type: "done", id: s.items[0].id, outcome: rows(1, false), ms: 3 });
  const p = panel(s);
  await userEvent.click(screen.getByRole("button", { name: "Pin result" }));
  expect(p.onPin).toHaveBeenCalledWith(s.items[0].id);
  await userEvent.click(screen.getByRole("button", { name: "Close unpinned results" }));
  expect(p.onCloseUnpinned).toHaveBeenCalled();
});
