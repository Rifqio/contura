import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { setPlatformForTests } from "../platform";
import type { Cell, ExecOutcome } from "../api/types";
import { mockReactFlowDom } from "../test/reactFlow";
import { ToastProvider } from "../components/Toast";
import { SETTLE_MS } from "../components/Menu";
import ResultsPanel, { sortLoaded } from "./ResultsPanel";
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

// G7 (UX step 3): query results select, copy and sort their loaded rows as the table grid does, and say why edit
// keys do nothing.
describe("G7: working with query results", () => {
  const t = (value: string): Cell => ({ t: "text", value, truncated: false, totalBytes: value.length });
  const n = (value: string): Cell => ({ t: "number", value });
  const grouped = (): RunnerState => {
    const s = started(["SELECT status, count(*) AS orders, sum(total) AS revenue FROM orders GROUP BY status"]);
    return runnerReducer(s, {
      type: "done",
      id: s.items[0].id,
      outcome: {
        t: "rows",
        columns: [
          { name: "status", typeName: "text", numeric: false },
          { name: "orders", typeName: "int8", numeric: true },
          { name: "revenue", typeName: "numeric", numeric: true },
        ],
        rows: [
          [t("paid"), n("3"), n("1422.00")],
          [t("pending"), n("2"), { t: "null" }],
          [t("delivered"), n("2"), n("196.25")],
          [t("refunded"), n("1"), n("19.99")],
        ],
        hasMore: false,
      },
      ms: 4,
    });
  };
  const grid = () => document.querySelector(".results .grid-scroll") as HTMLElement;
  const td = (r: number, c: number) => document.querySelector(`tr[data-row="${r}"] td[data-col="${c}"]`) as HTMLElement;
  const down = (el: HTMLElement, extra: object = {}) => fireEvent.mouseDown(el, { button: 0, ...extra });
  const key = (k: string, extra: object = {}) => fireEvent.keyDown(grid(), { key: k, ...extra });
  const note = () => document.querySelector(".results-grid-note")?.textContent ?? "";
  const column = (c: number) => Array.from(document.querySelectorAll(`tbody td[data-col="${c}"]`)).map((x) => x.textContent);
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setPlatformForTests("linux");
  });
  afterEach(() => setPlatformForTests(null));

  test("polish A7: the footer sums up the selected cells, Count and Sum", () => {
    panel(grouped());
    const summary = () => document.querySelector(".results-selection")?.textContent ?? "";
    down(td(0, 0));
    expect(summary()).toBe("");
    down(td(1, 2), { shiftKey: true });
    // paid 3 1422.00 / pending 2 NULL: five hold a value, and the numbers add to 1,427.
    expect(summary()).toBe("6 cells selected, Count 5, Sum 1,427");
  });

  test("cells select and copy as in the table grid, NULL as an empty field", () => {
    panel(grouped());
    down(td(0, 0));
    down(td(1, 2), { shiftKey: true });
    expect(document.querySelectorAll('td[aria-selected="true"]')).toHaveLength(6);
    key("c", { ctrlKey: true, code: "KeyC" });
    expect(writeText).toHaveBeenLastCalledWith("paid\t3\t1422.00\npending\t2\t");
    expect(note()).toBe("Copied 6 cells.");
    key("C", { ctrlKey: true, shiftKey: true, code: "KeyC" });
    expect(writeText).toHaveBeenLastCalledWith("status\torders\trevenue\npaid\t3\t1422.00\npending\t2\t");
    key("a", { ctrlKey: true, code: "KeyA" });
    expect(document.querySelectorAll('td[aria-selected="true"]')).toHaveLength(12);
    key("End", { ctrlKey: true });
    expect(td(3, 2).className).toContain("cell-selected");
  });

  test("I1: a copy never cuts short silently: cut-short and binary cells are named in the note", () => {
    let s = started(["SELECT body, data FROM docs"]);
    s = runnerReducer(s, {
      type: "done",
      id: s.items[0].id,
      outcome: {
        t: "rows",
        columns: [
          { name: "body", typeName: "text", numeric: false },
          { name: "data", typeName: "bytea", numeric: false },
        ],
        rows: [
          [{ t: "text", value: "long start", truncated: true, totalBytes: 5000 }, { t: "bytes", previewHex: "ff00", truncated: false, totalBytes: 2 }],
          [t("short"), { t: "null" }],
        ],
        hasMore: false,
      },
      ms: 1,
    });
    panel(s);
    down(td(0, 0));
    down(td(1, 1), { shiftKey: true });
    key("c", { ctrlKey: true, code: "KeyC" });
    // Binary cells copy as an empty field.
    expect(writeText).toHaveBeenLastCalledWith("long start\t\nshort\t");
    expect(note()).toBe("Copied 4 cells; 2 were cut short at 1 KB. Open full value (Shift+F2) copies one in full.");
  });

  test("a header click sorts the loaded rows up, down and off, NULL last both ways", () => {
    panel(grouped());
    const sortBy = () => screen.getByRole("button", { name: "Sort by revenue" });
    fireEvent.click(sortBy());
    expect(column(2)).toEqual(["19.99", "196.25", "1422.00", "NULL"]);
    fireEvent.click(sortBy());
    expect(column(2)).toEqual(["1422.00", "196.25", "19.99", "NULL"]);
    fireEvent.click(sortBy());
    expect(column(0)).toEqual(["paid", "pending", "delivered", "refunded"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort by status" }));
    expect(column(0)).toEqual(["delivered", "paid", "pending", "refunded"]);
  });

  test("M8: a sorted result keeps each row's number from the result, in the row numbers, the menu and Open full value", () => {
    panel(grouped());
    fireEvent.click(screen.getByRole("button", { name: "Sort by revenue" }));
    const numbers = () => Array.from(document.querySelectorAll("tbody td.row-number")).map((x) => x.textContent);
    // refunded (row 4), delivered (row 3), paid (row 1), pending (row 2, NULL last).
    expect(numbers()).toEqual(["4", "3", "1", "2"]);
    fireEvent.contextMenu(td(0, 0), { clientX: 10, clientY: 10 });
    expect(screen.getByText("status, row 4")).toBeTruthy();
  });

  test("M8: numbers beyond 2^53 sort by their exact value", () => {
    const big = (a: string, b: string, c: string) => [[n(a)], [n(b)], [n(c)]];
    const rows = big("9007199254740993", "9007199254740992", "-12345678901234567890.5");
    expect(sortLoaded(rows, [0, 1, 2], 0, false)).toEqual([2, 1, 0]);
    expect(sortLoaded(rows, [0, 1, 2], 0, true)).toEqual([0, 1, 2]);
    const decimals = big("123456789012345678.000000000000000002", "123456789012345678.000000000000000001", "-0.5");
    expect(sortLoaded(decimals, [0, 1, 2], 0, false)).toEqual([2, 1, 0]);
    // Equal values keep their order; a float with an exponent still sorts by value.
    expect(sortLoaded(big("1.50", "1.5", "1e-3"), [0, 1, 2], 0, false)).toEqual([2, 0, 1]);
  });

  test("I3: in a sorted result the selection follows its rows when more rows load, and the note says what was sorted", () => {
    const base = grouped();
    const id = base.items[0].id;
    const props = {
      onSelect: vi.fn(), onPin: vi.fn(), onClose: vi.fn(), onCloseUnpinned: vi.fn(), onFetchMore: vi.fn(),
      onCancel: vi.fn(), onRunAgain: vi.fn(), onGoTo: vi.fn(),
    };
    const { rerender } = render(<ResultsPanel state={base} timeoutSecs={null} lineAt={() => 2} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Sort by revenue" }));
    fireEvent.click(screen.getByRole("button", { name: "Sort by revenue" }));
    expect(note()).toBe("Sorted the 4 loaded rows.");
    // Descending: paid 1422.00, delivered 196.25; select those two rows.
    down(td(0, 0));
    down(td(1, 2), { shiftKey: true });
    const more = runnerReducer(base, { type: "more", id, rows: [[t("vip"), n("9"), n("9999.00")]], hasMore: false });
    rerender(<ResultsPanel state={more} timeoutSecs={null} lineAt={() => 2} {...props} />);
    expect(note()).toBe("Sorted the 5 loaded rows; 1 more loaded.");
    expect(column(0)[0]).toBe("vip");
    key("c", { ctrlKey: true, code: "KeyC" });
    expect(writeText).toHaveBeenLastCalledWith("paid\t3\t1422.00\ndelivered\t2\t196.25");
  });

  test("edit keys do nothing and say why", () => {
    panel(grouped());
    down(td(1, 0));
    key("Delete");
    expect(note()).toBe("Results are read-only: Delete works in the table grid.");
    key("Enter");
    expect(note()).toBe("Results are read-only: editing works in the table grid.");
    expect(key("n", { ctrlKey: true, altKey: true, code: "KeyN" })).toBe(false);
    expect(note()).toBe("Results are read-only: Set NULL works in the table grid.");
    key("x");
    expect(note()).toBe("Results are read-only: typing works in the table grid.");
    // AltGr+D (đ on some layouts) is typing, not Set DEFAULT.
    key("đ", { ctrlKey: true, altKey: true, code: "KeyD" });
    expect(note()).toBe("Results are read-only: typing works in the table grid.");
    expect(td(1, 0).textContent).toBe("pending");
  });

  test("the cell menu holds only what reads: Copy, Copy with headers, Open full value", () => {
    panel(grouped());
    fireEvent.contextMenu(td(2, 0));
    expect(document.querySelector(".tree-menu .menu-heading")!.textContent).toBe("status, row 3");
    expect(Array.from(document.querySelectorAll(".tree-menu [role=menuitem]")).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Copy",
      "Copy with headers",
      "Open full value",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
    expect(writeText).toHaveBeenLastCalledWith("delivered");
    fireEvent.contextMenu(td(2, 0));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open full value" }));
    expect(screen.getByRole("dialog", { name: "status, row 3" }).textContent).toContain("delivered");
  });
});

test("a_result_can_be_reordered_as_shown_but_run_again_brings_back_the_query_order", async () => {
  setPlatformForTests("linux");
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const onExport = vi.fn();
  const view = (s: RunnerState) => (
    <ToastProvider>
      <ResultsPanel state={s} timeoutSecs={null} lineAt={() => 1} onExport={onExport} {...noop} />
    </ToastProvider>
  );
  const { rerender } = render(view(four()));
  const heads = () => Array.from(document.querySelectorAll("thead th .header-name")).map((h) => h.textContent);
  const grid = document.querySelector(".grid-scroll") as HTMLElement;
  fireEvent.mouseDown(document.querySelector('tr[data-row="0"] td[data-col="0"]')!, { button: 0 });
  fireEvent.keyDown(grid, { key: "ArrowRight", code: "ArrowRight", altKey: true, shiftKey: true });
  expect(heads()).toEqual(["name", "id"]);
  expect(document.querySelector(".results-grid-note")?.textContent).toBe("Moved id to last. Not remembered: Run again brings back the query's order.");
  // Copy with headers, Copy as CSV and Export follow the order shown.
  fireEvent.keyDown(grid, { key: "c", code: "KeyC", ctrlKey: true, shiftKey: true });
  expect(writeText).toHaveBeenLastCalledWith("id\n1\n2\n3\n4");
  fireEvent.mouseDown(document.querySelector('tr[data-row="0"] td[data-col="0"]')!, { button: 0 });
  fireEvent.mouseDown(document.querySelector('tr[data-row="1"] td[data-col="1"]')!, { button: 0, shiftKey: true });
  fireEvent.keyDown(grid, { key: "c", code: "KeyC", ctrlKey: true, shiftKey: true });
  expect(writeText).toHaveBeenLastCalledWith("name\tid\nZinger\t1\nFries\t2");
  await userEvent.click(screen.getByRole("button", { name: "Export" }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Copy as CSV/ }));
  expect(writeText).toHaveBeenLastCalledWith(["name,id", "Zinger,1", "Fries,2", "Coleslaw,3", "Zinger Box,4"].join("\r\n"));
  fireEvent.keyDown(grid, { key: "e", code: "KeyE", ctrlKey: true });
  expect(onExport.mock.calls.slice(-1)[0]?.[0]).toMatchObject({ kind: "result", order: [1, 0] });
  // Run again: a new result, in the query's own order.
  const again = started(["SELECT * FROM menu"], four());
  rerender(view(runnerReducer(again, { type: "done", id: again.items[again.items.length - 1].id, outcome: textRows(["Zinger"]), ms: 3 })));
  expect(heads()).toEqual(["id", "name"]);
  setPlatformForTests(null);
});

test("a_press_outside_a_result_tab_menu_leaves_focus_where_it_landed_and_a_scroll_closes_it", async () => {
  render(
    <>
      <ResultsPanel state={four()} timeoutSecs={null} lineAt={() => 1} onClose={() => {}} {...noop} />
      <textarea aria-label="editor" />
    </>,
  );
  const tab = screen.getByRole("tab");
  fireEvent.contextMenu(tab.parentElement!, { clientX: 20, clientY: 20 });
  expect(screen.getByRole("menu", { name: "Result" })).toBeTruthy();
  const editor = screen.getByRole("textbox", { name: "editor" });
  editor.focus();
  fireEvent.mouseDown(editor);
  expect(screen.queryByRole("menu", { name: "Result" })).toBeNull();
  expect(document.activeElement).toBe(editor);
  fireEvent.contextMenu(tab.parentElement!, { clientX: 20, clientY: 20 });
  await act(() => new Promise((r) => setTimeout(r, SETTLE_MS + 20)));
  fireEvent.scroll(document.querySelector(".grid-scroll")!);
  expect(screen.queryByRole("menu", { name: "Result" })).toBeNull();
});
