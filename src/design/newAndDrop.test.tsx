import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test, vi } from "vitest";
import App from "../App";
import type { DesignRequest } from "../api/types";
import { mockEditorDom } from "../test/editor";
import { callsTo, routeInvoke } from "../test/invoke";
import { patientFile } from "../test/load";
import { clearAllSteps, stepsOf } from "../assistant/recentSteps";
import { mockReactFlowDom } from "../test/reactFlow";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async () => () => {},
    destroy: async () => {},
    close: async () => {},
    isMaximized: async () => false,
    onResized: async () => () => {},
  }),
}));

patientFile();
beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
});

const shop = {
  id: "c2",
  name: "KFC Shop",
  dialect: "mysql",
  host: "127.0.0.1",
  port: 3306,
  user: "u",
  database: "shop",
  ssl: { mode: "disable" },
  file: null,
  groupId: "g1",
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
};

const ORDERS_PATH = { database: "shop", schema: null, name: "orders" };
const CREATE = "CREATE TABLE `orders` (\n  `id` int NOT NULL\n)";

const ordersDesign = {
  path: ORDERS_PATH,
  columns: [
    {
      name: "id",
      typeSql: "int",
      nullable: false,
      defaultSql: null,
      increment: { kind: "none" },
      comment: null,
      generated: false,
      mysql: null,
      sqliteAutoincrement: false,
      collation: null,
      advanced: false,
      identityAlways: false,
    },
  ],
  indexes: [],
  foreignKeys: [],
  referencedBy: [],
  comment: null,
  unsupported: [],
  sqlite: null,
};

function routes(over: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  routeInvoke({
    ui_prefs: () => ({ theme: "dark" }),
    keymap: () => ({}),
    save_keymap: () => null,
    list_groups: () => [{ id: "g1", name: "KFC", color: "red" }],
    list_connections: () => [shop],
    last_group: () => "g1",
    suggested_connections: () => [],
    load_query_tabs: () => null,
    save_query_tabs: () => null,
    list_saved_queries: () => [],
    open_connection: () => null,
    list_databases: () => ["shop"],
    list_objects: () => [{ kind: "table", name: "customers", rows: 3 }],
    open_query_session: () => "s1",
    close_query_session: () => null,
    set_last_group: () => null,
    sql_schema: () => ({ tables: [], functions: [] }),
    table_design: () => ordersDesign,
    plan_design: () => ({
      plan: { statements: [CREATE], warnings: [], mode: { kind: "atomic" }, before: 0, after: 0, checks: [], foreignKeys: null },
      verdict: { kind: "ok" },
    }),
    apply_design: () => ({ kind: "done", ran: 1 }),
    ...over,
  });
}

async function openNewTable() {
  render(<App />);
  const strip = await screen.findByRole("tablist", { name: "Open tabs" });
  await userEvent.click(await within(strip).findByRole("button", { name: "Close Home" }));
  await userEvent.click(await screen.findByRole("button", { name: "Open KFC Shop" }));
  await screen.findByRole("treeitem", { name: "customers" });
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: "shop" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "New table..." }));
  expect(await screen.findByRole("tab", { name: "New table", selected: true })).toBeTruthy();
}

const grid = () => screen.getByRole("grid", { name: /^Columns of/ });
const cell = (name: string, field: string) =>
  [...grid().querySelectorAll("tbody tr")]
    .find((r) => r.querySelector('td[data-field="name"]')?.textContent === name)!
    .querySelector(`td[data-field="${field}"]`) as HTMLElement;
const applyButton = () => screen.getByRole("button", { name: /^Apply/ }) as HTMLButtonElement;
const REASON = "Add a name and at least one column.";

async function fillIdColumn() {
  fireEvent.doubleClick(cell("", "name"));
  let box = screen.getByRole("textbox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "id" } });
  fireEvent.keyDown(box, { key: "Enter" });
  fireEvent.doubleClick(cell("id", "type"));
  box = screen.getByRole("combobox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "int" } });
  fireEvent.keyDown(box, { key: "Enter" });
}

test("new_table_opens_a_tab_with_one_empty_column_and_apply_waits_for_a_name", async () => {
  routes();
  await openNewTable();
  expect(await screen.findByRole("tab", { name: "Columns 1" })).toBeTruthy();
  expect(cell("", "type").textContent).toBe("");
  expect(applyButton().disabled).toBe(true);
  expect(screen.getByText(REASON)).toBeTruthy();
  await fillIdColumn();
  // A column alone is not enough: the table needs its name.
  expect(applyButton().disabled).toBe(true);
  expect(screen.getByText(REASON)).toBeTruthy();
  await userEvent.type(screen.getByRole("textbox", { name: "Table name" }), "orders");
  await waitFor(() => expect(applyButton().disabled).toBe(false));
  expect(screen.queryByText(REASON)).toBeNull();
});

test("apply_creates_the_table_toasts_and_the_tab_becomes_its_design", async () => {
  routes();
  await openNewTable();
  await screen.findByRole("tab", { name: "Columns 1" });
  await userEvent.type(screen.getByRole("textbox", { name: "Table name" }), "orders");
  await fillIdColumn();
  await waitFor(() => expect(applyButton().disabled).toBe(false));
  await screen.findByLabelText("SQL Apply runs");
  await userEvent.click(applyButton());
  await waitFor(() => expect(callsTo("apply_design")).toHaveLength(1));
  const sent = callsTo("apply_design")[0].request as DesignRequest;
  expect(sent.target).toEqual({ kind: "create", path: ORDERS_PATH });
  expect(callsTo("apply_design")[0].pass).toBeNull();
  expect(await screen.findByText("Created orders.")).toBeTruthy();
  expect(await screen.findByRole("tab", { name: "orders design", selected: true })).toBeTruthy();
  expect(screen.queryByRole("tab", { name: /^New table/ })).toBeNull();
  // The tab now designs the table that exists: its next Apply is an ALTER.
  await waitFor(() => expect(callsTo("table_design")).toEqual([{ id: "c2", path: ORDERS_PATH }]));
  expect(callsTo("apply_design")).toHaveLength(1);
});

test("a_create_that_changed_the_database_and_then_failed_becomes_an_alter_tab", async () => {
  routes({
    apply_design: () => {
      throw { kind: "designFailed", message: { statement: 1, ran: 1, total: 2, message: "Duplicate key name 'i'" } };
    },
  });
  await openNewTable();
  await screen.findByRole("tab", { name: "Columns 1" });
  await userEvent.type(screen.getByRole("textbox", { name: "Table name" }), "orders");
  await fillIdColumn();
  await waitFor(() => expect(applyButton().disabled).toBe(false));
  await screen.findByLabelText("SQL Apply runs");
  await userEvent.click(applyButton());
  // The table may exist now, so the tab designs it: a second Apply cannot CREATE it again.
  expect(await screen.findByRole("tab", { name: "orders design", selected: true })).toBeTruthy();
  expect(screen.queryByRole("tab", { name: /^New table/ })).toBeNull();
  expect(await screen.findByText(/^1 of 2 statements were applied\. Statement 2 failed/)).toBeTruthy();
  await waitFor(() => expect(callsTo("table_design")).toEqual([{ id: "c2", path: ORDERS_PATH }]));
});

test("a_create_where_nothing_ran_keeps_the_new_table_tab", async () => {
  routes({
    apply_design: () => {
      throw { kind: "designFailed", message: { statement: 0, ran: 0, total: 1, message: "Table 'orders' already exists" } };
    },
  });
  await openNewTable();
  await screen.findByRole("tab", { name: "Columns 1" });
  await userEvent.type(screen.getByRole("textbox", { name: "Table name" }), "orders");
  await fillIdColumn();
  await waitFor(() => expect(applyButton().disabled).toBe(false));
  await screen.findByLabelText("SQL Apply runs");
  await userEvent.click(applyButton());
  expect(await screen.findByText(/^Nothing was changed\./)).toBeTruthy();
  expect(screen.getByRole("tab", { name: /^New table/ })).toBeTruthy();
  expect(callsTo("table_design")).toHaveLength(0);
});

test("closing_a_new_table_through_the_asks_apply_creates_it_and_closes_the_tab", async () => {
  routes();
  await openNewTable();
  await screen.findByRole("tab", { name: "Columns 1" });
  await userEvent.type(screen.getByRole("textbox", { name: "Table name" }), "orders");
  await fillIdColumn();
  await waitFor(() => expect(applyButton().disabled).toBe(false));
  await screen.findByLabelText("SQL Apply runs");
  const strip = screen.getByRole("tablist", { name: "Open tabs" });
  await userEvent.click(within(strip).getByRole("button", { name: /^Close New table/ }));
  const ask = await screen.findByRole("dialog");
  await userEvent.click(within(ask).getByRole("button", { name: /^Apply/ }));
  await waitFor(() => expect(callsTo("apply_design")).toHaveLength(1));
  expect(await screen.findByText("Created orders.")).toBeTruthy();
  // The user asked to close: neither the New table tab nor the design tab it became stays open (M2).
  await waitFor(() => expect(screen.queryByRole("tab", { name: /^New table/ })).toBeNull());
  await waitFor(() => expect(screen.queryByRole("tab", { name: /^orders design/ })).toBeNull());
});

test("a_new_table_apply_is_a_recent_step_after_its_tab_was_opened", async () => {
  clearAllSteps();
  routes();
  await openNewTable();
  await screen.findByRole("tab", { name: "Columns 1" });
  await userEvent.type(screen.getByRole("textbox", { name: "Table name" }), "orders");
  await fillIdColumn();
  await waitFor(() => expect(applyButton().disabled).toBe(false));
  await screen.findByLabelText("SQL Apply runs");
  await userEvent.click(applyButton());
  expect(await screen.findByText("Created orders.")).toBeTruthy();
  const steps = stepsOf("group:g1");
  expect(steps[0]).toMatchObject({ verb: "openTab", tab: "newTable", connectionId: "c2", database: "shop" });
  expect(steps.find((s) => s.verb === "designApplied")).toMatchObject({ tab: "newTable", connectionId: "c2", database: "shop", names: ["orders"] });
  clearAllSteps();
});
