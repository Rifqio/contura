import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import type { HistoryEntry, SavedQuery } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import HistoryPanel from "./HistoryPanel";
import SavedQueries from "./SavedQueries";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

const DAY = 86_400_000;
const entry = (id: number, over: Partial<HistoryEntry>): HistoryEntry => ({
  id,
  connectionId: "c1",
  sql: "SELECT 1",
  ranAtMs: Date.now(),
  elapsedMs: 21,
  outcome: "ok",
  rows: 1,
  changed: false,
  error: null,
  ...over,
});

const ENTRIES = [
  entry(4, { sql: "SELECT * FROM stores WHERE city = 'Bandung'", rows: 35 }),
  entry(3, { sql: "UPDATE sales.orders SET status = 'x' WHERE id < 40", rows: 37, changed: true }),
  entry(2, { sql: "SELECT * FROM store", outcome: "error", rows: null, error: 'relation "store" does not exist' }),
  entry(1, { sql: "SELECT pg_sleep(40)", outcome: "timedOut", rows: null, ranAtMs: Date.now() - DAY, elapsedMs: 30000 }),
];

function history(over: Partial<Parameters<typeof HistoryPanel>[0]> = {}) {
  const props = { onInsert: vi.fn(), onOpenInNewTab: vi.fn(), onClose: vi.fn() };
  const utils = render(
    <HistoryPanel connectionId="c1" connectionName="KFC Postgres" refreshKey={0} {...props} {...over} />,
  );
  return { ...utils, ...props };
}

test("history_lists_newest_first_grouped_by_day", async () => {
  routeInvoke({ query_history: () => ENTRIES });
  history();
  expect(await screen.findByText("Today")).toBeTruthy();
  expect(screen.getByText("Yesterday")).toBeTruthy();
  expect(screen.getByText("35 rows")).toBeTruthy();
  expect(screen.getByText("37 changed")).toBeTruthy();
  expect(screen.getByText("error")).toBeTruthy();
  expect(screen.getByText("timed out")).toBeTruthy();
  expect(screen.getByText("4 of 1,000 kept")).toBeTruthy();
  const items = screen.getAllByRole("button", { name: /^SELECT|^UPDATE/ });
  expect(items[0].textContent).toContain("Bandung");
});

test("history_search_and_filters_query_the_core", async () => {
  routeInvoke({ query_history: () => ENTRIES });
  history();
  await waitFor(() => expect(callsTo("query_history")).toHaveLength(1));
  expect(callsTo("query_history")[0]).toEqual({ id: "c1", filter: { search: null, only: null } });
  await userEvent.type(screen.getByRole("searchbox", { name: "Search history" }), "stores");
  await waitFor(() => expect(callsTo("query_history").slice(-1)[0]).toEqual({ id: "c1", filter: { search: "stores", only: null } }));
  await userEvent.click(screen.getByRole("button", { name: "Failed" }));
  await waitFor(() => expect(callsTo("query_history").slice(-1)[0]).toEqual({ id: "c1", filter: { search: "stores", only: "failed" } }));
  expect(screen.getByRole("button", { name: "Failed" }).getAttribute("aria-pressed")).toBe("true");
  await userEvent.click(screen.getByRole("button", { name: "Changes" }));
  await waitFor(() => expect(callsTo("query_history").slice(-1)[0]).toEqual({ id: "c1", filter: { search: "stores", only: "changes" } }));
});

test("history_entry_inserts_or_opens_but_never_runs", async () => {
  routeInvoke({ query_history: () => ENTRIES });
  const p = history();
  await userEvent.click(await screen.findByRole("button", { name: /Bandung/ }));
  await userEvent.click(screen.getByRole("button", { name: "Insert into editor" }));
  expect(p.onInsert).toHaveBeenCalledWith("SELECT * FROM stores WHERE city = 'Bandung';\n");
  await userEvent.click(screen.getByRole("button", { name: "Open in new tab" }));
  expect(p.onOpenInNewTab).toHaveBeenCalledWith("SELECT * FROM stores WHERE city = 'Bandung';\n");
  expect(callsTo("execute_sql")).toHaveLength(0);
});

test("history_shows_the_error_of_a_failed_entry_and_its_empty_states", async () => {
  routeInvoke({ query_history: ({ filter }) => ((filter as { search: string | null }).search ? [] : ENTRIES) });
  history();
  await userEvent.click(await screen.findByRole("button", { name: /FROM store$/ }));
  expect(screen.getByText('relation "store" does not exist')).toBeTruthy();
  await userEvent.type(screen.getByRole("searchbox", { name: "Search history" }), "zzz");
  expect(await screen.findByText('Nothing in this Connection\'s history matches "zzz".')).toBeTruthy();
});

test("history_refreshes_after_a_run", async () => {
  routeInvoke({ query_history: () => ENTRIES });
  const { rerender } = history();
  await waitFor(() => expect(callsTo("query_history")).toHaveLength(1));
  rerender(
    <HistoryPanel connectionId="c1" connectionName="KFC Postgres" refreshKey={1} onInsert={() => {}} onOpenInNewTab={() => {}} onClose={() => {}} />,
  );
  await waitFor(() => expect(callsTo("query_history")).toHaveLength(2));
});

const SAVED: SavedQuery[] = [
  { id: "q1", name: "Late deliveries", sql: "SELECT 2", updatedAtMs: 1 },
  { id: "q2", name: "Weekly sales", sql: "SELECT 1", updatedAtMs: 2 },
];

test("saved_queries_open_rename_and_delete", async () => {
  routeInvoke({
    save_saved_query: ({ input }) => {
      const i = input as { id: string; name: string; sql: string };
      if (i.name === "Late deliveries") throw { kind: "invalidInput", message: 'A Saved Query named "Late deliveries" exists. Choose another name.' };
      return { ...i, updatedAtMs: 3 };
    },
    delete_saved_query: () => null,
  });
  const onOpen = vi.fn();
  const onChanged = vi.fn();
  render(<SavedQueries items={SAVED} activeId="q2" onOpen={onOpen} onChanged={onChanged} />);
  expect(screen.getByRole("heading", { name: "Saved Queries" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Weekly sales" }));
  expect(onOpen).toHaveBeenCalledWith(SAVED[1]);

  await userEvent.click(screen.getByRole("button", { name: "Actions for Weekly sales" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  const name = screen.getByLabelText("Name");
  await userEvent.clear(name);
  await userEvent.type(name, "Late deliveries");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText('A Saved Query named "Late deliveries" exists. Choose another name.')).toBeTruthy();
  await userEvent.clear(name);
  await userEvent.type(name, "Weekly store sales");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  expect(callsTo("save_saved_query").slice(-1)[0].input).toEqual({ id: "q2", name: "Weekly store sales", sql: "SELECT 1" });

  await userEvent.click(screen.getByRole("button", { name: "Actions for Weekly sales" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
  expect(screen.getByText('Delete the Saved Query "Weekly sales"?')).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(callsTo("delete_saved_query")).toEqual([{ id: "q2" }]));
  expect(onChanged).toHaveBeenCalledTimes(2);
});

test("no_saved_queries_says_how_to_add_one", () => {
  render(<SavedQueries items={[]} activeId={null} onOpen={() => {}} onChanged={() => {}} />);
  expect(screen.getByText("Save a query tab with Ctrl+S to keep it here.")).toBeTruthy();
});
