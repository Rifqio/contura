import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ConnectionConfig, SavedQuery, SavedQueryRun } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import SavedQueriesList from "./SavedQueriesList";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const NOW = new Date("2026-10-18T12:00:00Z");
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

const conn = (id: string, name: string, over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id,
  name,
  dialect: "postgres",
  host: "h",
  port: 5432,
  user: "u",
  database: "shop",
  ssl: { mode: "disable" },
  file: null,
  groupId: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
  ...over,
});
const connections = [conn("c1", "shop-staging"), conn("c2", "freight-prod", { production: true, database: "freight" })];

const saved = (id: string, name: string, connectionId: string | null, updatedAtMs: number): SavedQuery => ({
  id,
  name,
  sql: `SELECT '${name}'`,
  updatedAtMs,
  connectionId,
});
const OCT14 = Date.parse("2026-10-14T09:00:00Z");
const queries = [
  saved("s1", "carrier delays", "c1", OCT14),
  saved("s2", "daily revenue", "c2", OCT14),
  saved("s3", "late shipments by carrier", "c1", OCT14),
];
const runs: SavedQueryRun[] = [
  { savedId: "s3", ranAtMs: NOW.getTime() - 12 * 60_000, rows: 4, elapsedMs: 41 },
  { savedId: "s3", ranAtMs: NOW.getTime() - 3 * 3_600_000, rows: 9, elapsedMs: 70 },
];

function routes(over: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  routeInvoke({
    saved_query_runs: () => runs,
    list_saved_queries: () => queries,
    delete_saved_query: () => null,
    save_saved_query: ({ input }) => ({ ...(input as object), updatedAtMs: 1, connectionId: null }),
    ...over,
  });
}

function show(over: Partial<Parameters<typeof SavedQueriesList>[0]> = {}) {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  const props = { onOpen: vi.fn(), onChanged: vi.fn() };
  render(<SavedQueriesList queries={queries} connections={connections} {...props} {...over} />);
  return props;
}

test("list_columns_and_preview", async () => {
  routes();
  show();
  expect(screen.getByRole("heading", { name: "Saved Queries" })).toBeTruthy();
  expect(screen.getByText("3 queries, kept for every Connection")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Filter Saved Queries" })).toBeTruthy();
  const heads = screen.getAllByRole("columnheader").map((h) => h.textContent);
  expect(heads).toEqual(["Name", "Opens on", "Last run", "Saved"]);
  await userEvent.click(screen.getByRole("row", { name: /late shipments by carrier/ }));
  const preview = screen.getByRole("region", { name: "late shipments by carrier" });
  const facts = () => [...preview.querySelectorAll("dt, dd")].map((e) => e.textContent);
  await waitFor(() => expect(facts()).toContain("12m ago, 4 rows in 41ms"));
  expect(facts()).toEqual(["Opens on", "shop-staging · shop", "Last run", "12m ago, 4 rows in 41ms", "Saved", "Oct 14"]);
  expect(preview.querySelector(".sql-block")).toBeTruthy();
  expect(within(preview).getByRole("button", { name: /Open/ }).textContent).toContain("Enter");
  expect(within(preview).getByRole("button", { name: /Rename/ }).textContent).toContain("F2");
  expect(within(preview).getByRole("button", { name: /Delete/ })).toBeTruthy();
  // The Production Connection's row carries its mark.
  expect(within(screen.getByRole("row", { name: /daily revenue/ })).getByText("PROD")).toBeTruthy();
});

test("not_run_yet_without_a_matching_run", async () => {
  routes();
  show();
  const row = screen.getByRole("row", { name: /carrier delays/ });
  await waitFor(() => expect(within(screen.getByRole("row", { name: /late shipments/ })).getByText("12m ago")).toBeTruthy());
  expect(within(row).getByText("Not run yet")).toBeTruthy();
  await userEvent.click(row);
  expect(within(screen.getByRole("region", { name: "carrier delays" })).getByText("Not run yet")).toBeTruthy();
});

test("open_rename_delete_with_keys", async () => {
  routes();
  const { onOpen, onChanged } = show();
  await userEvent.click(screen.getByRole("row", { name: /daily revenue/ }));
  await userEvent.keyboard("{Enter}");
  expect(onOpen).toHaveBeenCalledWith(queries[1]);

  await userEvent.keyboard("{F2}");
  const rename = await screen.findByRole("dialog");
  const name = within(rename).getByRole("textbox") as HTMLInputElement;
  expect(name.value).toBe("daily revenue");
  await userEvent.clear(name);
  await userEvent.type(name, "revenue by day");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(callsTo("save_saved_query")).toHaveLength(1));
  expect((callsTo("save_saved_query")[0].input as { id: string; name: string }).id).toBe("s2");
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

  await userEvent.click(screen.getByRole("row", { name: /carrier delays/ }));
  await userEvent.keyboard("{Delete}");
  const ask = await screen.findByRole("dialog");
  expect(ask.textContent).toContain('Delete the Saved Query "carrier delays"?');
  await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(callsTo("delete_saved_query")).toEqual([{ id: "s1" }]));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
  act(() => {});
});

test("runs_are_read_again_when_the_list_is_shown_again", async () => {
  routes();
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  const props = { onOpen: vi.fn(), onChanged: vi.fn() };
  const { rerender } = render(<SavedQueriesList queries={queries} connections={connections} visible {...props} />);
  await waitFor(() => expect(callsTo("saved_query_runs")).toHaveLength(1));
  rerender(<SavedQueriesList queries={queries} connections={connections} visible={false} {...props} />);
  expect(callsTo("saved_query_runs")).toHaveLength(1);
  rerender(<SavedQueriesList queries={queries} connections={connections} visible {...props} />);
  await waitFor(() => expect(callsTo("saved_query_runs")).toHaveLength(2));
});

test("a_hidden_list_does_not_read_runs", async () => {
  routes();
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  const props = { onOpen: vi.fn(), onChanged: vi.fn() };
  render(<SavedQueriesList queries={queries} connections={connections} visible={false} {...props} />);
  await act(async () => {});
  expect(callsTo("saved_query_runs")).toHaveLength(0);
});

test("renaming_a_visual_query_from_the_list_keeps_its_kind_and_model", async () => {
  const v: SavedQuery = { ...saved("v1", "by store", null, OCT14), kind: "visual", visualJson: '{"version":1}' };
  routes({ list_saved_queries: () => [v] });
  const onChanged = vi.fn();
  render(<SavedQueriesList queries={[v]} connections={connections} onOpen={() => {}} onChanged={onChanged} />);
  expect(within(screen.getByRole("table")).getByText("Connection removed")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: /^Rename/ }));
  const name = screen.getByLabelText("Name");
  await userEvent.clear(name);
  await userEvent.type(name, "orders by store{Enter}");
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  expect(callsTo("save_saved_query")[0].input).toEqual({ id: "v1", name: "orders by store", sql: v.sql, kind: "visual", visualJson: '{"version":1}' });
});
