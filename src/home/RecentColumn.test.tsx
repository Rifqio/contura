import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { ConnectionConfig, RecentItem } from "../api/types";
import { ToastProvider } from "../components/Toast";
import { callsTo, routeInvoke } from "../test/invoke";
import RecentColumn from "./RecentColumn";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const now = new Date(2026, 9, 15, 10, 0);

function conn(id: string, name: string, production: boolean): ConnectionConfig {
  return {
    id,
    name,
    dialect: "postgres",
    host: "127.0.0.1",
    port: 5432,
    user: "postgres",
    database: "kfc",
    ssl: { mode: "disable" },
    file: null,
    queryTimeoutSecs: null,
    aiAccess: "schema",
    production,
    readOnly: false,
    groupId: null,
  };
}

const connections = [conn("c1", "kfc-prod", true), conn("c2", "kfc-staging", false)];

const orders: RecentItem = {
  target: { kind: "table", path: { database: "kfc", schema: "public", name: "orders" }, object: "table" },
  connectionId: "c1",
  openedAtMs: now.getTime() - 12 * 60_000,
};
const revenue: RecentItem = {
  target: { kind: "query", savedId: "q1", name: "monthly revenue" },
  connectionId: "c2",
  openedAtMs: new Date(2026, 9, 14, 16, 12).getTime(),
};

test("sections_are_named_by_day", () => {
  render(<RecentColumn items={[orders, revenue]} connections={connections} openIds={new Set()} now={now} onOpen={() => {}} onClear={() => {}} onShowAllHistory={() => {}} />);
  const today = screen.getByRole("region", { name: "Today" });
  expect(within(today).getByText("public.orders")).toBeTruthy();
  const yesterday = screen.getByRole("region", { name: "Yesterday" });
  expect(within(yesterday).getByText("monthly revenue")).toBeTruthy();
  expect(within(yesterday).getByText("16:12")).toBeTruthy();
});

test("a_table_row_names_its_kind_and_connection_and_shows_prod", () => {
  render(<RecentColumn items={[orders, revenue]} connections={connections} openIds={new Set(["c1"])} now={now} onOpen={() => {}} onClear={() => {}} onShowAllHistory={() => {}} />);
  const row = screen.getByRole("button", { name: "public.orders, Table on kfc-prod, Production, 12m" });
  expect(row.getAttribute("title")).toBe("Table on kfc-prod. Select to reopen it.");
  expect(within(row).getByText("PROD")).toBeTruthy();
  expect(within(row).getByText("12m")).toBeTruthy();
  const staging = screen.getByRole("button", { name: "monthly revenue, Query on kfc-staging, 16:12" });
  expect(within(staging).queryByText("PROD")).toBeNull();
});

test("two_tables_on_one_connection_have_different_names", () => {
  const customers: RecentItem = {
    target: { kind: "table", path: { database: "kfc", schema: "public", name: "customers" }, object: "table" },
    connectionId: "c1",
    openedAtMs: now.getTime() - 3 * 60_000,
  };
  render(<RecentColumn items={[customers, orders]} connections={connections} openIds={new Set()} now={now} onOpen={() => {}} onClear={() => {}} onShowAllHistory={() => {}} />);
  const today = screen.getByRole("region", { name: "Today" });
  const names = within(today)
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label"));
  expect(names).toEqual(["public.customers, Table on kfc-prod, Production, 3m", "public.orders, Table on kfc-prod, Production, 12m"]);
});

test("a_row_without_a_connection_says_so_in_its_name", () => {
  const model: RecentItem = { target: { kind: "schemaModel", file: "E:\\models\\shop.dbml" }, connectionId: null, openedAtMs: now.getTime() };
  render(<RecentColumn items={[model]} connections={connections} openIds={new Set()} now={now} onOpen={() => {}} onClear={() => {}} onShowAllHistory={() => {}} />);
  const row = screen.getByRole("button", { name: "shop.dbml, Schema model, No Connection, now" });
  expect(row.getAttribute("title")).toBe("Schema model. Select to reopen it.");
});

test("clicking_a_row_opens_that_item", async () => {
  const onOpen = vi.fn();
  render(<RecentColumn items={[orders, revenue]} connections={connections} openIds={new Set()} now={now} onOpen={onOpen} onClear={() => {}} onShowAllHistory={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "monthly revenue, Query on kfc-staging, 16:12" }));
  expect(onOpen).toHaveBeenCalledWith(revenue);
});

test("nothing_opened_yet", () => {
  render(<RecentColumn items={[]} connections={connections} openIds={new Set()} now={now} onOpen={() => {}} onClear={() => {}} onShowAllHistory={() => {}} />);
  expect(screen.getByText("Nothing opened yet")).toBeTruthy();
});

test("clear_empties_recent_with_an_undo_toast", async () => {
  routeInvoke({ clear_recent: () => [orders, revenue], restore_recent: () => null });
  const onClear = vi.fn();
  render(
    <ToastProvider>
      <RecentColumn items={[orders, revenue]} connections={connections} openIds={new Set()} now={now} onOpen={() => {}} onClear={onClear} onShowAllHistory={() => {}} />
    </ToastProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Clear" }));
  await waitFor(() => expect(callsTo("clear_recent")).toHaveLength(1));
  expect(await screen.findByText("Cleared Recent.")).toBeTruthy();
  expect(onClear).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(callsTo("restore_recent")).toEqual([{ items: [orders, revenue] }]));
  await waitFor(() => expect(onClear).toHaveBeenCalledTimes(2));
});

test("show_all_history_is_the_last_row", async () => {
  const onShowAllHistory = vi.fn();
  render(<RecentColumn items={[orders]} connections={connections} openIds={new Set()} now={now} onOpen={() => {}} onClear={() => {}} onShowAllHistory={onShowAllHistory} />);
  const all = screen.getByRole("button", { name: "Show all history" });
  const column = screen.getByRole("complementary", { name: "Recent" });
  expect(column.lastElementChild).toBe(all);
  await userEvent.click(all);
  expect(onShowAllHistory).toHaveBeenCalled();
});
