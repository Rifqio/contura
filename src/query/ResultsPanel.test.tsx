import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test, vi } from "vitest";
import type { Cell, ExecOutcome } from "../api/types";
import { mockReactFlowDom } from "../test/reactFlow";
import { ToastProvider } from "../components/Toast";
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
  expect(s.items[0].state).toMatchObject({ s: "error", message: "boom", at: 2, index: 1, notRun: [stmt("SELECT 2"), stmt("SELECT 3")]});
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
    onClose: vi.fn(),
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
  expect(screen.getByText("First 1,000 rows in 38ms")).toBeTruthy();
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
  expect(screen.getByText("Cancelled after 2.4s")).toBeTruthy();
  c.unmount();

  s = started(["SELECT pg_sleep(40)"]);
  s = runnerReducer(s, { type: "failed", id: s.items[0].id, error: { kind: "timedOut", message: 30 } });
  const t = render(<ResultsPanel state={s} timeoutSecs={30} lineAt={() => 1} {...noop} />);
  expect(screen.getByText("Stopped after 30s")).toBeTruthy();
  t.unmount();

  s = started(["SELECT id FROM menu_itms"]);
  s = runnerReducer(s, {
    type: "failed",
    id: s.items[0].id,
    error: { kind: "query", message: 'relation "menu_itms" does not exist (position 16)' },
  });
  const p = panel(s);
  expect(document.querySelector(".query-error-message")?.textContent).toBe('relation "menu_itms" does not exist');
  // R40: no SQLSTATE chip unless the server's message carries one.
  expect(document.querySelector(".query-error-code")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Go to line 2" }));
  expect(p.onGoTo).toHaveBeenCalledWith(15, 15);
  // Ask AI on a failed query needs the app ask setup; the inline Ask itself is tested in InlineAsk.test.tsx.
  expect(screen.queryByRole("button", { name: "Ask AI" })).toBeNull();
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

test("a_cancelled_result_keeps_its_plain_tab_name", () => {
  let s = started(["SELECT pg_sleep(30)"]);
  s = runnerReducer(s, { type: "failed", id: s.items[0].id, error: { kind: "cancelled" }, ms: 2400 });
  panel(s);
  expect(screen.getByRole("tab").textContent).toBe("Result 1");
});

/** E6, PR28: Pin and Close live on the result tab, not in the toolbar. */
test("pin_and_close_live_on_the_result_tab", async () => {
  let s = started(["SELECT 1"]);
  s = runnerReducer(s, { type: "done", id: s.items[0].id, outcome: rows(1, false), ms: 3 });
  const p = panel(s);
  const toolbar = document.querySelector(".results-tabs") as HTMLElement;
  // Nothing outside the tab list pins or closes.
  for (const b of Array.from(toolbar.querySelectorAll("button")).filter((b) => !b.closest(".results-tablist")))
    expect(b.getAttribute("aria-label") ?? "").not.toMatch(/Pin|Close/);
  // Hover close on the tab.
  await userEvent.click(document.querySelector<HTMLElement>(".result-tab-close[aria-label='Close Result 1']")!);
  expect(p.onClose).toHaveBeenCalledWith(s.items[0].id);
  // Right-click the tab: Pin result, Close, Close unpinned results.
  fireEvent.contextMenu(screen.getByRole("tab", { name: "Result 1" }));
  expect(screen.getAllByRole("menuitem").map((m) => m.getAttribute("aria-label"))).toEqual(["Pin result", "Close", "Close unpinned results"]);
  await userEvent.click(screen.getByRole("menuitem", { name: "Pin result" }));
  expect(p.onPin).toHaveBeenCalledWith(s.items[0].id);
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.contextMenu(screen.getByRole("tab", { name: "Result 1" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Close unpinned results" }));
  expect(p.onCloseUnpinned).toHaveBeenCalled();
});

test("result_tab_keys_close_and_open_its_menu", async () => {
  let s = started(["SELECT 1"]);
  s = runnerReducer(s, { type: "done", id: s.items[0].id, outcome: rows(1, false), ms: 3 });
  s = runnerReducer(s, { type: "pin", id: s.items[0].id });
  const p = panel(s);
  const tab = screen.getByRole("tab", { name: "Result 1, pinned" });
  tab.focus();
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  expect(screen.getByRole("menuitem", { name: "Unpin result" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(tab);
  await userEvent.keyboard("{Delete}");
  expect(p.onClose).toHaveBeenCalledWith(s.items[0].id);
});

test("a_running_result_has_no_close", () => {
  panel(started(["SELECT pg_sleep(30)"]));
  expect(document.querySelector(".result-tab-close")).toBeNull();
  // Delete does nothing on a running result, so only the menu key is advertised.
  expect(screen.getByRole("tab").getAttribute("aria-keyshortcuts")).toBe("Shift+F10");
});

const textRows = (names: string[]): ExecOutcome => ({
  t: "rows",
  columns: [
    { name: "id", typeName: "int4", numeric: true },
    { name: "name", typeName: "text", numeric: false },
  ],
  rows: names.map((n, i) => [
    { t: "number", value: String(i + 1) },
    { t: "text", value: n, truncated: false, totalBytes: n.length },
  ]),
  hasMore: false,
});
function four(): RunnerState {
  const s = started(["SELECT * FROM menu"]);
  return runnerReducer(s, { type: "done", id: s.items[0].id, outcome: textRows(["Zinger", "Fries", "Coleslaw", "Zinger Box"]), ms: 48 });
}
const dataRows = () => document.querySelectorAll("tr[data-row]");

test("result_tab_reads_result_n_without_status_marks", () => {
  let s = started(["SELECT 1", "SELECT bad"]);
  s = runnerReducer(s, { type: "done", id: s.items[0].id, outcome: rows(1, false), ms: 3 });
  s = runnerReducer(s, { type: "begin", now: 0 });
  s = runnerReducer(s, { type: "failed", id: s.items[1].id, error: { kind: "query", message: "boom" } });
  panel(s);
  const tabs = screen.getAllByRole("tab");
  expect(tabs[0].textContent).toBe("Result 1");
  expect(tabs[0].querySelector("svg")).toBeNull();
  expect(tabs[1].textContent).toBe("Statement 2");
  expect(tabs[1].querySelector("svg")).toBeTruthy();
});

test("plan_tab_reads_plan", () => {
  let s = runnerReducer(EMPTY_RUNNER, { type: "explain", stmt: stmt("SELECT 1"), now: 0 });
  s = runnerReducer(s, { type: "planned", id: s.items[0].id, plan: { nodes: [], raw: "Result", totalCost: null }, ms: 5 });
  panel(s);
  expect(screen.getByRole("tab").textContent).toBe("Plan");
});

test("toolbar_right_has_filter_columns_and_export", () => {
  panel(four());
  expect(screen.getByText("4 rows in 48ms")).toBeTruthy();
  for (const name of ["Filter rows", "Columns", "Export"]) expect(screen.getByRole("button", { name })).toBeTruthy();
});

test("filter_narrows_loaded_rows", async () => {
  panel(four());
  expect(dataRows()).toHaveLength(4);
  await userEvent.click(screen.getByRole("button", { name: "Filter rows" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Filter loaded rows" }), "zing");
  expect(dataRows()).toHaveLength(2);
});

test("columns_menu_hides_a_column", async () => {
  panel(four());
  await userEvent.click(screen.getByRole("button", { name: "Columns" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "name" }));
  expect(document.querySelectorAll("thead th:not(.row-number)")).toHaveLength(1);
});

test("export_copies_csv_with_a_toast", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  render(
    <ToastProvider>
      <ResultsPanel state={four()} timeoutSecs={null} lineAt={() => 1} connectionName="KFC" {...noop} />
    </ToastProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Export" }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Copy as CSV/ }));
  expect(writeText).toHaveBeenCalledWith(["id,name", "1,Zinger", "2,Fries", "3,Coleslaw", "4,Zinger Box"].join("\r\n"));
  expect((await screen.findByRole("status")).textContent).toContain("Copied 4 rows as CSV.");
});

test("footer_shows_row_range_and_context_line", () => {
  const { unmount } = render(<ResultsPanel state={four()} timeoutSecs={null} lineAt={() => 1} {...noop} />);
  expect(document.querySelector(".results-foot")?.textContent).toContain("1 to 4 of 4");
  expect(document.querySelector(".results-foot")?.textContent).toContain("Running again replaces this result");
  unmount();
  render(<ResultsPanel state={four()} production timeoutSecs={null} lineAt={() => 1} {...noop} />);
  expect(document.querySelector(".results-foot")?.textContent).toContain(
    "Saving runs on Production and asks you to confirm the SQL first.",
  );
});

test("empty_results_show_only_the_empty_message", () => {
  panel(EMPTY_RUNNER);
  expect(screen.getByText("Run a query to see results")).toBeTruthy();
  expect(screen.queryByRole("tab")).toBeNull();
  expect(screen.queryByRole("button", { name: "Filter rows" })).toBeNull();
  expect(document.querySelector(".results-foot")).toBeNull();
  expect(document.querySelector(".kbd")?.textContent).toBe("Ctrl+Enter");
});

test("a_failed_statement_shows_the_query_error_screen", () => {
  let s = started(["SELECT 1", "SELECT x FROM shipment", "SELECT 3"]);
  s = runnerReducer(s, { type: "done", id: s.items[0].id, outcome: rows(1, false), ms: 3 });
  s = runnerReducer(s, { type: "begin", now: 0 });
  s = runnerReducer(s, { type: "failed", id: s.items[1].id, error: { kind: "query", message: "Table 'shop.shipment' doesn't exist" } });
  panel(s, { dialect: "mysql", names: ["shipments"], columnAt: () => 6 });
  expect(screen.getByText("Statement 2 failed")).toBeTruthy();
  expect(document.querySelector(".query-error-near")?.textContent).toBe("There is no table named shipment in shop. Did you mean shipments?");
  // Frame 2: the strip counts the run; a failed statement has no footer.
  expect(document.querySelector(".results-summary")?.textContent).toMatch(/^1 of 3 statements ran in \d+ms$/);
  expect(document.querySelector(".results-foot")).toBeNull();
  expect(screen.getByText("Not run, because statement 2 failed")).toBeTruthy();
});

test("export_says_how_many_values_were_cut_short", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  let s = started(["SELECT body FROM docs"]);
  const cut = (v: string) => ({ t: "text" as const, value: v, truncated: true, totalBytes: 99999 });
  s = runnerReducer(s, {
    type: "done",
    id: s.items[0].id,
    outcome: { t: "rows", columns: [{ name: "body", typeName: "text", numeric: false }], rows: [[cut("a")], [cut("b")], [cut("c")]], hasMore: false },
    ms: 3,
  });
  render(
    <ToastProvider>
      <ResultsPanel state={s} timeoutSecs={null} lineAt={() => 1} {...noop} />
    </ToastProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Export" }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Copy as CSV/ }));
  expect((await screen.findByRole("status")).textContent).toContain("3 values were cut short in the CSV.");
});

/** R41: not-run statements that sit apart in the editor keep their own line numbers. */
test("not_run_statements_show_their_own_editor_lines", () => {
  const text = "SELECT bad;\nSELECT 2;\n\n-- the last one\nSELECT 3;";
  const at = (t: string) => stmt(t, text.indexOf(t));
  let s = runnerReducer(EMPTY_RUNNER, { type: "start", stmts: [at("SELECT bad"), at("SELECT 2"), at("SELECT 3")] });
  s = runnerReducer(s, { type: "begin", now: 0 });
  s = runnerReducer(s, { type: "failed", id: s.items[0].id, error: { kind: "query", message: 'column "bad" does not exist' } });
  const lineAt = (offset: number) => text.slice(0, offset).split("\n").length;
  panel(s, { lineAt });
  const gutters = Array.from(document.querySelectorAll(".query-error-notrun .sql-block-gutter")).map((g) => g.textContent);
  expect(gutters).toEqual(["2", "5"]);
  expect(document.querySelector(".query-error-notrun")?.textContent).toContain("SELECT 3;");
});

test("export_menu_has_export_without_import_and_sends_the_result_origin_q16", async () => {
  const onExport = vi.fn();
  panel(four(), { onExport, database: "kfc" });
  await userEvent.click(screen.getByRole("button", { name: "Export" }));
  expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Copy as CSV", "Export...Ctrl+E"]);
  await userEvent.click(screen.getByRole("menuitem", { name: /Export\.\.\./ }));
  const s = four();
  const st = s.items[s.active].state as Extract<RunnerState["items"][number]["state"], { s: "rows" }>;
  expect(onExport).toHaveBeenCalledWith({
    kind: "result",
    database: "kfc",
    sql: s.items[s.active].sql,
    columns: st.columns,
    rows: st.rows,
    hidden: [],
  });
});

test("ctrl_e_in_the_results_opens_export", async () => {
  const onExport = vi.fn();
  panel(four(), { onExport, database: null });
  const tab = screen.getAllByRole("tab")[0];
  tab.focus();
  fireEvent.keyDown(tab, { key: "e", code: "KeyE", ctrlKey: true });
  expect(onExport).toHaveBeenCalledTimes(1);
  expect(onExport.mock.calls[0][0]).toMatchObject({ kind: "result", database: null });
});

test("the_result_origin_names_the_hidden_columns", async () => {
  const onExport = vi.fn();
  panel(four(), { onExport });
  await userEvent.click(screen.getByRole("button", { name: "Columns" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "name" }));
  await userEvent.click(screen.getByRole("button", { name: "Export" }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Export\.\.\./ }));
  expect(onExport.mock.calls[0][0]).toMatchObject({ kind: "result", hidden: ["name"] });
});
