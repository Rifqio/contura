import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ConnectionConfig, HistoryEntry } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import HistoryPanel from "./HistoryPanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
/** A fixed Thursday afternoon, so day labels never depend on when the suite runs. */
const NOW = new Date(2026, 9, 15, 14, 0).getTime();
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const DAY = 86_400_000;

function conn(id: string, name: string, production: boolean): ConnectionConfig {
  return {
    id,
    name,
    dialect: "postgres",
    host: "127.0.0.1",
    port: 5432,
    user: "u",
    database: null,
    ssl: { mode: "disable" },
    file: null,
    groupId: null,
    queryTimeoutSecs: null,
    aiAccess: "schema",
    production,
    readOnly: false,
  };
}

const PROD = conn("c1", "freight-prod", true);
const STAGING = conn("c2", "shop-staging", false);

const entry = (id: number, over: Partial<HistoryEntry>): HistoryEntry => ({
  id,
  connectionId: "c1",
  sql: "SELECT 1",
  ranAtMs: NOW,
  elapsedMs: 21,
  outcome: "ok",
  rows: 1,
  changed: false,
  error: null,
  ...over,
});

const ENTRIES = [
  entry(4, { sql: "SELECT s.carrier, count(*)\n  FROM shipments s\n GROUP BY 1", rows: 6, elapsedMs: 112 }),
  entry(3, {
    sql: "UPDATE orders SET status = 'shipped'\n WHERE id IN (1, 2)",
    rows: 1284,
    changed: true,
    elapsedMs: 212,
  }),
  entry(2, {
    sql: "SELECT id, shiped_at FROM orders",
    outcome: "error",
    rows: null,
    elapsedMs: 4,
    error: 'column "shiped_at" does not exist',
  }),
  entry(1, {
    connectionId: "c2",
    sql: "SELECT customer_id FROM orders",
    rows: 200,
    elapsedMs: 88,
    ranAtMs: NOW - DAY,
  }),
  entry(0, {
    connectionId: "c2",
    sql: "SELECT name FROM sqlite_master",
    rows: 12,
    elapsedMs: 2,
    ranAtMs: NOW - 3 * DAY,
  }),
];

function panel(over: Partial<Parameters<typeof HistoryPanel>[0]> = {}) {
  const props = { onInsert: vi.fn(), onRun: vi.fn(), onClose: vi.fn() };
  const utils = render(
    <HistoryPanel connections={[PROD, STAGING]} scopeConnection={PROD} refreshKey={0} {...props} {...over} />,
  );
  return { ...utils, ...props };
}

const row = (name: RegExp) => screen.getByRole("button", { name });

test("row_has_kind_icon_one_line_sql_time_and_connection_line", async () => {
  routeInvoke({ query_history: () => ENTRIES });
  panel({ scopeConnection: PROD });
  const r = await screen.findByRole("button", { name: /SELECT s\.carrier/ });
  // Line 1: kind icon, the first line of the SQL only, time on the right.
  expect(r.querySelector(".history-row-icon svg")).toBeTruthy();
  expect(r.querySelector(".history-row-sql")?.textContent).toBe("SELECT s.carrier, count(*)");
  expect(r.querySelector(".history-row-time")?.textContent).toMatch(/^\d{2}:\d{2}$/);
  // Line 2: mark, Connection name, PROD, result on the right.
  const meta = r.querySelector(".history-row-meta")!;
  expect(meta.querySelector("svg.db-mark")).toBeTruthy();
  expect(within(meta as HTMLElement).getByText("freight-prod")).toBeTruthy();
  expect(within(meta as HTMLElement).getByText("PROD")).toBeTruthy();
  expect(meta.querySelector(".history-row-result")?.textContent).toBe("6 rows, 112ms");
  // A Connection that is not Production shows no PROD.
  const other = screen.getByRole("button", { name: /SELECT customer_id/ });
  expect(other.querySelector(".history-row-meta")?.textContent).not.toContain("PROD");
  expect(screen.getByRole("button", { name: /UPDATE orders/ }).querySelector(".history-row-result")?.textContent).toBe(
    "1,284 rows changed, 212ms",
  );
});

test("failed_rows_say_failed_in_danger", async () => {
  routeInvoke({ query_history: () => ENTRIES });
  panel();
  const r = await screen.findByRole("button", { name: /shiped_at/ });
  const result = r.querySelector(".history-row-result")!;
  expect(result.textContent).toBe("Failed");
  expect(result.className).toContain("history-row-failed");
  expect(r.querySelector(".history-row-icon")?.className).toContain("history-row-failed");
});

test("selecting_a_row_shows_the_preview_with_insert_run_and_copy", async () => {
  routeInvoke({ query_history: () => ENTRIES });
  const p = panel();
  expect(screen.queryByRole("region", { name: "Selected statement" })).toBeNull();
  await userEvent.click(await screen.findByRole("button", { name: /UPDATE orders/ }));
  const pv = screen.getByRole("region", { name: "Selected statement" });
  expect(within(pv).getByText("freight-prod")).toBeTruthy();
  expect(within(pv).getByText("PROD")).toBeTruthy();
  expect(within(pv).getByText(/^· Today \d{2}:\d{2}$/)).toBeTruthy();
  expect(pv.querySelector(".sql-block")?.textContent).toContain("UPDATE orders SET status = 'shipped'");
  await userEvent.click(within(pv).getByRole("button", { name: "Insert into the editor" }));
  expect(p.onInsert).toHaveBeenCalledWith("UPDATE orders SET status = 'shipped'\n WHERE id IN (1, 2);\n");
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
  await userEvent.click(within(pv).getByRole("button", { name: "Copy" }));
  expect(write).toHaveBeenCalledWith("UPDATE orders SET status = 'shipped'\n WHERE id IN (1, 2)");
  expect(within(pv).getByRole("button", { name: "Run" })).toBeTruthy();
  // Selecting the row again closes the preview.
  await userEvent.click(screen.getByRole("button", { name: /UPDATE orders/ }));
  expect(screen.queryByRole("region", { name: "Selected statement" })).toBeNull();
});

test("a_failed_statement_shows_its_error_in_the_preview", async () => {
  routeInvoke({ query_history: () => ENTRIES });
  panel();
  await userEvent.click(await screen.findByRole("button", { name: /shiped_at/ }));
  expect(within(screen.getByRole("region", { name: "Selected statement" })).getByText('column "shiped_at" does not exist')).toBeTruthy();
});

test("run_from_history_goes_through_the_runner", async () => {
  routeInvoke({ query_history: () => ENTRIES });
  const p = panel();
  await userEvent.click(await screen.findByRole("button", { name: /UPDATE orders/ }));
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(p.onRun).toHaveBeenCalledWith("UPDATE orders SET status = 'shipped'\n WHERE id IN (1, 2)");
  // The panel itself never executes anything.
  expect(callsTo("execute_sql")).toHaveLength(0);
  expect(callsTo("prepare_run")).toHaveLength(0);
});

test("run_is_off_for_another_connections_statement", async () => {
  routeInvoke({ query_history: () => ENTRIES });
  const p = panel({ scopeConnection: PROD });
  await userEvent.click(await screen.findByRole("radio", { name: "All" }));
  await userEvent.click(await screen.findByRole("button", { name: /SELECT customer_id/ }));
  const run = screen.getByRole("button", { name: "Run" }) as HTMLButtonElement;
  expect(run.disabled).toBe(true);
  expect(run.title).toBe("This tab is on freight-prod. Open a tab on shop-staging to run it.");
  await userEvent.click(run);
  expect(p.onRun).not.toHaveBeenCalled();
});

test("filter_and_all_or_connection_scope", async () => {
  routeInvoke({ query_history: () => ENTRIES });
  panel({ scopeConnection: PROD });
  await waitFor(() => expect(callsTo("query_history")).toHaveLength(1));
  // The Connection scope is the default beside a tab.
  expect(callsTo("query_history")[0]).toEqual({ id: "c1", filter: { search: null, only: null } });
  expect(screen.getByRole("radio", { name: "freight-prod" }).getAttribute("aria-checked")).toBe("true");
  await userEvent.click(screen.getByRole("radio", { name: "All" }));
  await waitFor(() => expect(callsTo("query_history").slice(-1)[0]).toEqual({ id: null, filter: { search: null, only: null } }));
  await userEvent.type(screen.getByRole("searchbox", { name: "Filter history" }), "orders");
  await waitFor(() =>
    expect(callsTo("query_history").slice(-1)[0]).toEqual({ id: null, filter: { search: "orders", only: null } }),
  );
  expect(screen.getByPlaceholderText("Filter history")).toBeTruthy();
});

test("opened_for_all_starts_on_all", async () => {
  routeInvoke({ query_history: () => ENTRIES });
  panel({ scopeConnection: PROD, initialScope: "all" });
  await waitFor(() => expect(callsTo("query_history")[0]).toMatchObject({ id: null }));
  expect(screen.getByRole("radio", { name: "All" }).getAttribute("aria-checked")).toBe("true");
});

test("without_a_connection_there_is_only_all", async () => {
  routeInvoke({ query_history: () => [] });
  panel({ scopeConnection: null });
  await waitFor(() => expect(callsTo("query_history")[0]).toMatchObject({ id: null }));
  expect(screen.getAllByRole("radio")).toHaveLength(1);
});

test("menu_holds_failed_changes_and_clear", async () => {
  routeInvoke({ query_history: () => ENTRIES, clear_query_history: () => null });
  panel({ scopeConnection: PROD });
  await waitFor(() => expect(callsTo("query_history")).toHaveLength(1));
  await userEvent.click(screen.getByRole("button", { name: "History options" }));
  const menu = screen.getByRole("menu", { name: "History options" });
  expect([...menu.querySelectorAll("[role^=menuitem]")].map((i) => i.textContent)).toEqual([
    "Failed only",
    "Changes only",
    "Clear Query History...",
  ]);
  await userEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Failed only" }));
  await waitFor(() =>
    expect(callsTo("query_history").slice(-1)[0]).toEqual({ id: "c1", filter: { search: null, only: "failed" } }),
  );
  await userEvent.click(screen.getByRole("button", { name: "History options" }));
  expect(screen.getByRole("menuitemcheckbox", { name: "Failed only" }).getAttribute("aria-checked")).toBe("true");
  await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Changes only" }));
  await waitFor(() =>
    expect(callsTo("query_history").slice(-1)[0]).toEqual({ id: "c1", filter: { search: null, only: "changes" } }),
  );
});

test("clear_asks_first_and_uses_the_scope", async () => {
  routeInvoke({ query_history: () => ENTRIES, clear_query_history: () => null });
  panel({ scopeConnection: PROD });
  await waitFor(() => expect(callsTo("query_history")).toHaveLength(1));
  await userEvent.click(screen.getByRole("button", { name: "History options" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Clear Query History..." }));
  expect(screen.getByText("Clear the Query History of freight-prod? Saved Queries are kept.")).toBeTruthy();
  expect(callsTo("clear_query_history")).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "Keep it" }));
  expect(callsTo("clear_query_history")).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "History options" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Clear Query History..." }));
  await userEvent.click(screen.getByRole("button", { name: "Clear" }));
  await waitFor(() => expect(callsTo("clear_query_history")).toEqual([{ id: "c1" }]));
});

test("clear_on_all_clears_every_connection", async () => {
  routeInvoke({ query_history: () => ENTRIES, clear_query_history: () => null });
  panel({ scopeConnection: PROD, initialScope: "all" });
  await waitFor(() => expect(callsTo("query_history")).toHaveLength(1));
  await userEvent.click(screen.getByRole("button", { name: "History options" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Clear Query History..." }));
  expect(screen.getByText("Clear the Query History of every Connection? Saved Queries are kept.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Clear" }));
  await waitFor(() => expect(callsTo("clear_query_history")).toEqual([{ id: null }]));
});

test("day_labels_and_no_done_word", async () => {
  routeInvoke({ query_history: () => ENTRIES });
  panel({ scopeConnection: null });
  expect(await screen.findByText("Today")).toBeTruthy();
  expect(screen.getByText("Yesterday")).toBeTruthy();
  expect(screen.getByText("Earlier this week")).toBeTruthy();
  expect(document.body.textContent).not.toContain("Done");
  // An older day shows its date in the row, a recent one its time.
  expect(row(/sqlite_master/).querySelector(".history-row-time")?.textContent).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
});

test("empty_and_refresh", async () => {
  routeInvoke({ query_history: ({ filter }) => ((filter as { search: string | null }).search ? [] : ENTRIES) });
  const { rerender } = panel();
  await waitFor(() => expect(callsTo("query_history")).toHaveLength(1));
  await userEvent.type(screen.getByRole("searchbox", { name: "Filter history" }), "zzz");
  expect(await screen.findByText('Nothing in the history matches "zzz".')).toBeTruthy();
  rerender(
    <HistoryPanel connections={[PROD, STAGING]} scopeConnection={PROD} refreshKey={1} onInsert={() => {}} onRun={() => {}} onClose={() => {}} />,
  );
  await waitFor(() => expect(callsTo("query_history").length).toBeGreaterThan(2));
});

test("close_button_closes", async () => {
  routeInvoke({ query_history: () => [] });
  const p = panel();
  await userEvent.click(screen.getByRole("button", { name: "Close Query History" }));
  expect(p.onClose).toHaveBeenCalled();
});

test("timed_out_and_cancelled_rows_say_so_with_the_time", async () => {
  routeInvoke({
    query_history: () => [
      entry(11, { sql: "SELECT pg_sleep(40)", outcome: "timedOut", rows: null, elapsedMs: 30000 }),
      entry(12, { sql: "SELECT pg_sleep(9)", outcome: "cancelled", rows: null, elapsedMs: 5 }),
    ],
  });
  panel();
  const slow = await screen.findByRole("button", { name: /pg_sleep\(40\)/ });
  expect(slow.querySelector(".history-row-result")?.textContent).toBe("Timed out, 30s");
  expect(row(/pg_sleep\(9\)/).querySelector(".history-row-result")?.textContent).toBe("Cancelled, 5ms");
});

test("a_single_row_reads_1_row", async () => {
  routeInvoke({
    query_history: () => [
      entry(21, { sql: "SELECT one", rows: 1, elapsedMs: 3 }),
      entry(22, { sql: "UPDATE one", rows: 1, changed: true, elapsedMs: 3 }),
    ],
  });
  panel();
  expect((await screen.findByRole("button", { name: /SELECT one/ })).querySelector(".history-row-result")?.textContent).toBe("1 row, 3ms");
  expect(row(/UPDATE one/).querySelector(".history-row-result")?.textContent).toBe("1 row changed, 3ms");
});

test("insert_does_not_double_a_trailing_semicolon", async () => {
  routeInvoke({ query_history: () => [entry(31, { sql: "SELECT 1;  \n" })] });
  const p = panel();
  await userEvent.click(await screen.findByRole("button", { name: /SELECT 1/ }));
  await userEvent.click(screen.getByRole("button", { name: "Insert into the editor" }));
  expect(p.onInsert).toHaveBeenCalledWith("SELECT 1;\n");
});
