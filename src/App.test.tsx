import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test, vi } from "vitest";
import { mockEditorDom } from "./test/editor";
import { mockReactFlowDom } from "./test/reactFlow";
import { callsTo, routeInvoke } from "./test/invoke";
import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const closeWindow = vi.hoisted(() => ({
  handler: null as null | ((e: { preventDefault(): void }) => Promise<void>),
  destroy: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (h: (e: { preventDefault(): void }) => Promise<void>) => {
      closeWindow.handler = h;
      return () => {};
    },
    destroy: closeWindow.destroy,
  }),
}));
beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
});

test("startup opens last group when it exists, otherwise home", async () => {
  const groups = [{ id: "g1", name: "KFC", color: "red" }];
  routeInvoke({
    list_groups: () => groups,
    list_connections: () => [],
    last_group: () => "g1",
    suggested_connections: () => [],
  });
  render(<App />);
  const switcher = await screen.findByRole("button", { name: "Switch Group, current KFC" });
  expect(switcher).toBeTruthy();
  expect(await screen.findByText("No Connections in KFC yet.")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Home" })).toBeNull();
  cleanup();

  routeInvoke({
    list_groups: () => groups,
    list_connections: () => [],
    last_group: () => null,
    suggested_connections: () => [],
  });
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Home" })).toBeTruthy();
  cleanup();

  // A remembered Group that no longer exists falls back to Home.
  routeInvoke({
    list_groups: () => groups,
    list_connections: () => [],
    last_group: () => "deleted-group",
    suggested_connections: () => [],
  });
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Home" })).toBeTruthy();
});

const kfc = { id: "g1", name: "KFC", color: "red" };
const pg = {
  id: "c1",
  name: "KFC Postgres",
  dialect: "postgres",
  host: "127.0.0.1",
  port: 5432,
  user: "u",
  database: "kfc_shop",
  ssl: { mode: "disable" },
  file: null,
  groupId: "g1",
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
};

function workspaceRoutes(over: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  routeInvoke({
    list_groups: () => [kfc],
    list_connections: () => [pg],
    last_group: () => "g1",
    suggested_connections: () => [],
    load_query_tabs: () => null,
    save_query_tabs: () => null,
    list_saved_queries: () => [],
    open_connection: () => null,
    list_databases: () => ["kfc_shop"],
    open_query_session: () => "s1",
    close_query_session: () => null,
    ...over,
  });
}

test("ctrl_t_opens_numbered_query_tabs_and_closing_activates_a_neighbour", async () => {
  workspaceRoutes();
  render(<App />);
  await screen.findByRole("button", { name: "Switch Group, current KFC" });
  await userEvent.keyboard("{Control>}t{/Control}");
  expect(await screen.findByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "New query" }));
  expect(await screen.findByRole("tab", { name: "Query 2", selected: true })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Close Query 2" }));
  expect(await screen.findByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Query 2" })).toBeNull();
});

test("new_query_from_the_connection_menu_starts_on_that_connection", async () => {
  workspaceRoutes();
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "More actions for KFC Postgres" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "New query" }));
  expect(await screen.findByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
  await waitFor(() => expect(callsTo("open_connection")).toEqual([{ id: "c1" }]));
  await waitFor(() => expect(callsTo("open_query_session")).toEqual([{ id: "c1", database: "kfc_shop" }]));
  expect((screen.getByRole("combobox", { name: "Connection" }) as HTMLSelectElement).value).toBe("c1");
});

test("drafts_are_saved_per_place_and_restored_on_start", async () => {
  const draft = [
    { id: "d1", name: "Late deliveries", text: "SELECT 1", connectionId: "c1", database: "kfc_shop", savedId: null, savedText: null },
  ];
  workspaceRoutes({ load_query_tabs: ({ place }) => (place === "group:g1" ? JSON.stringify({ version: 1, tabs: draft }) : null) });
  render(<App />);
  expect(await screen.findByRole("tab", { name: "Late deliveries" })).toBeTruthy();
  await userEvent.keyboard("{Control>}t{/Control}");
  await screen.findByRole("tab", { name: "Query 1" });
  await waitFor(
    () => {
      const saved = callsTo("save_query_tabs").slice(-1)[0];
      expect(saved?.place).toBe("group:g1");
      expect(JSON.parse(saved?.json as string).tabs.map((t: { name: string }) => t.name)).toEqual([
        "Late deliveries",
        "Query 1",
      ]);
    },
    { timeout: 3000 },
  );
});

test("switching from a Group to Ungrouped forgets the last Group", async () => {
  routeInvoke({
    list_groups: () => [{ id: "g1", name: "KFC", color: "red" }],
    list_connections: () => [],
    last_group: () => "g1",
    suggested_connections: () => [],
    set_last_group: () => null,
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Switch Group, current KFC" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Ungrouped" }));
  expect(await screen.findByRole("button", { name: "Switch Group, current Ungrouped" })).toBeTruthy();
  expect(callsTo("set_last_group")).toEqual([{ id: null }]);
});

test("the rail's gear opens Settings with the AI section, and Connections leads back", async () => {
  routeInvoke({
    list_groups: () => [{ id: "g1", name: "KFC", color: "red" }],
    list_connections: () => [],
    last_group: () => "g1",
    suggested_connections: () => [],
    ai_settings: () => ({
      settings: {
        provider: null,
        preset: null,
        baseUrl: "",
        model: "",
        temperature: null,
        maxTokens: null,
        inlineAsk: true,
        errorAsk: true,
      },
      groupOverride: false,
      keySaved: false,
      keyLast4: null,
    }),
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Settings" }));
  expect(await screen.findByLabelText("Use different settings for KFC")).toBeTruthy();
  expect(screen.getByText("AI assistant", { selector: "span" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Connections" }));
  expect(screen.queryByLabelText("Use different settings for KFC")).toBeNull();
  expect(screen.getByText("No Connections in KFC yet.")).toBeTruthy();
});

// ---- Pending Edits: ask before leaving (step 5b) ----

const shopMy = { ...pg, id: "c2", name: "KFC Shop", dialect: "mysql", port: 3306, database: "shop" };
const ordersPage = {
  columns: [
    { name: "id", typeName: "int", isPrimaryKey: true },
    { name: "status", typeName: "varchar(16)", isPrimaryKey: false },
  ],
  rows: [[{ t: "number", value: "1" }, { t: "text", value: "paid", truncated: false, totalBytes: 4 }]],
  hasMore: false,
};

async function openOrdersWithAnEdit(over: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  workspaceRoutes({
    list_connections: () => [shopMy],
    list_databases: () => ["shop"],
    list_objects: () => [{ kind: "table", name: "orders" }],
    fetch_page: () => ordersPage,
    set_last_group: () => null,
    sql_schema: () => ({ tables: [], functions: [] }),
    ...over,
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Open KFC Shop" }));
  const db = await screen.findByRole("button", { name: "shop" });
  if (db.getAttribute("aria-expanded") !== "true") await userEvent.click(db);
  const tables = await screen.findByRole("list", { name: "Tables in shop" });
  await userEvent.click(within(tables).getByRole("button", { name: "orders" }));
  const cell = await waitFor(() => {
    const el = document.querySelector('tr[data-row="0"] td[data-col="1"]');
    if (!el) throw new Error("grid not shown");
    return el as HTMLElement;
  });
  fireEvent.doubleClick(cell);
  const box = screen.getByRole("textbox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "lost" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await screen.findByRole("region", { name: "Pending Edits" });
}

const inAsk = (name: string) => within(screen.getByRole("dialog")).getByRole("button", { name });
const tabClose = () => within(screen.getByRole("tablist", { name: "Open tabs" })).getByRole("button", { name: /^Close orders/ });

test("closing a table tab with Pending Edits asks; cancel keeps it, discard closes it", async () => {
  await openOrdersWithAnEdit();
  await userEvent.click(tabClose());
  expect(await screen.findByText("Save changes to orders?")).toBeTruthy();
  await userEvent.click(inAsk("Cancel"));
  expect(screen.getByRole("tab", { name: /orders/ })).toBeTruthy();
  await userEvent.click(tabClose());
  await screen.findByText("Save changes to orders?");
  await userEvent.click(inAsk("Discard"));
  await waitFor(() => expect(screen.queryByRole("tab", { name: /orders/ })).toBeNull());
});

test("save in the ask closes the tab only after the save worked", async () => {
  let fail = true;
  await openOrdersWithAnEdit({
    plan_edits: () => ({ statements: ["UPDATE x"], verdict: { kind: "ok" } }),
    apply_edits: () => {
      if (fail) throw { kind: "editFailed", message: { statement: 0, message: "nope" } };
      return { updated: 1, inserted: 0, deleted: 0 };
    },
  });
  await userEvent.click(tabClose());
  await screen.findByText("Save changes to orders?");
  await userEvent.click(inAsk("Save"));
  expect(await screen.findByText("Save failed at statement 1: nope")).toBeTruthy();
  expect(screen.getByRole("tab", { name: /orders/ })).toBeTruthy();
  fail = false;
  await userEvent.click(tabClose());
  await screen.findByText("Save changes to orders?");
  await userEvent.click(inAsk("Save"));
  await waitFor(() => expect(screen.queryByRole("tab", { name: /orders/ })).toBeNull());
});

test("switching Group with Pending Edits asks first", async () => {
  await openOrdersWithAnEdit();
  await userEvent.click(screen.getByRole("button", { name: "Switch Group, current KFC" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Ungrouped" }));
  expect(await screen.findByText("Save changes to orders?")).toBeTruthy();
  await userEvent.click(inAsk("Cancel"));
  expect(screen.getByRole("button", { name: "Switch Group, current KFC" })).toBeTruthy();
});

test("a table tab without edits closes at once", async () => {
  await openOrdersWithAnEdit();
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  await userEvent.click(tabClose());
  await waitFor(() => expect(screen.queryByRole("tab", { name: /orders/ })).toBeNull());
  expect(screen.queryByText("Save changes to orders?")).toBeNull();
});

test("quitting with Pending Edits is held until the ask is answered", async () => {
  await openOrdersWithAnEdit();
  await waitFor(() => expect(closeWindow.handler).not.toBeNull());
  const event = { preventDefault: vi.fn() };
  const done = closeWindow.handler!(event);
  expect(event.preventDefault).toHaveBeenCalled();
  await screen.findByText("Save changes to orders?");
  await userEvent.click(inAsk("Discard"));
  await done;
  expect(closeWindow.destroy).toHaveBeenCalled();
});

// ---- Final review fixes ----

test("closing a Connection with Pending Edits asks; cancel keeps the tab and the Connection open", async () => {
  await openOrdersWithAnEdit({ close_connection: () => null });
  await userEvent.click(screen.getByRole("button", { name: "Close KFC Shop" }));
  expect(await screen.findByText("Save changes to orders?")).toBeTruthy();
  await userEvent.click(inAsk("Cancel"));
  expect(screen.getByRole("tab", { name: /orders/ })).toBeTruthy();
  expect(callsTo("close_connection")).toHaveLength(0);
  expect(screen.getByRole("button", { name: "Close KFC Shop" })).toBeTruthy();
});

test("moving a Connection with Pending Edits to another Group asks first", async () => {
  await openOrdersWithAnEdit({ move_connection: () => null });
  await userEvent.click(screen.getByRole("button", { name: "More actions for KFC Shop" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Move to Ungrouped" }));
  expect(await screen.findByText("Save changes to orders?")).toBeTruthy();
  await userEvent.click(inAsk("Cancel"));
  expect(callsTo("move_connection")).toHaveLength(0);
  expect(screen.getByRole("tab", { name: /orders/ })).toBeTruthy();
});

test("after a table tab is removed without asking, quitting does not ask about it", async () => {
  let gone = false;
  await openOrdersWithAnEdit({
    fetch_page: () => {
      if (gone) throw { kind: "notFound", message: "connection not open" };
      return ordersPage;
    },
  });
  gone = true;
  await userEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(screen.queryByRole("tab", { name: /orders/ })).toBeNull());
  await waitFor(() => expect(closeWindow.handler).not.toBeNull());
  const event = { preventDefault: vi.fn() };
  await closeWindow.handler!(event);
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(screen.queryByText("Save changes to orders?")).toBeNull();
});

test("saving from the ask on a Production Connection confirms first; cancel there keeps the tab", async () => {
  await openOrdersWithAnEdit({
    list_connections: () => [{ ...shopMy, production: true }],
    plan_edits: () => ({
      statements: ["UPDATE x"],
      verdict: {
        kind: "needsConfirmation",
        connection: "KFC Shop",
        database: "shop",
        statements: [{ text: "UPDATE x", class: "write" }],
        writes: 1,
      },
    }),
  });
  await userEvent.click(tabClose());
  await screen.findByText("Save changes to orders?");
  await userEvent.click(inAsk("Save"));
  const confirm = await screen.findByRole("dialog");
  await waitFor(() => expect(confirm.textContent).toContain("Save on KFC Shop · shop"));
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(callsTo("apply_edits")).toHaveLength(0);
  expect(screen.getByRole("tab", { name: /orders/ })).toBeTruthy();
});

// ---- 5b minors ----

test("two leave requests while the ask is open both settle", async () => {
  await openOrdersWithAnEdit();
  await waitFor(() => expect(closeWindow.handler).not.toBeNull());
  const event = { preventDefault: vi.fn() };
  const first = closeWindow.handler!(event);
  await screen.findByText("Save changes to orders?");
  const second = closeWindow.handler!(event);
  await userEvent.click(inAsk("Discard"));
  const late = new Promise((_, reject) => setTimeout(() => reject(new Error("a leave promise never settled")), 1000));
  await Promise.race([Promise.all([first, second]), late]);
  expect(closeWindow.destroy).toHaveBeenCalled();
});

test("deleting a Group asks about its tabs first; cancel deletes nothing", async () => {
  await openOrdersWithAnEdit({ delete_group: () => null });
  await userEvent.click(screen.getByTitle("Edit Group"));
  await userEvent.click(await screen.findByRole("button", { name: "Delete Group" }));
  await userEvent.click(await screen.findByRole("button", { name: "Delete KFC" }));
  expect(await screen.findByText("Save changes to orders?")).toBeTruthy();
  expect(callsTo("delete_group")).toHaveLength(0);
  const ask = screen.getByText("Save changes to orders?").closest('[role="dialog"]') as HTMLElement;
  await userEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(callsTo("delete_group")).toHaveLength(0);
  expect(screen.getByRole("tab", { name: /orders/ })).toBeTruthy();
});