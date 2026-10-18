import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test, vi } from "vitest";
import { mockEditorDom } from "./test/editor";
import { LOAD_TIMEOUT, patientFile } from "./test/load";
import { mockReactFlowDom } from "./test/reactFlow";
import { callsTo, routeInvoke } from "./test/invoke";
import { EditorView } from "@codemirror/view";
import App from "./App";
import { appLang } from "./lang/appLang";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const closeWindow = vi.hoisted(() => ({
  handler: null as null | ((e: { preventDefault(): void }) => Promise<void>),
  destroy: vi.fn(async () => {}),
  /** Like Tauri: close() raises the close request, and the window goes only if nobody prevents it. */
  close: vi.fn(async () => {
    let prevented = false;
    await closeWindow.handler?.({ preventDefault: () => (prevented = true) });
    if (!prevented) await closeWindow.destroy();
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (h: (e: { preventDefault(): void }) => Promise<void>) => {
      closeWindow.handler = h;
      return () => {};
    },
    destroy: closeWindow.destroy,
    close: closeWindow.close,
    isMaximized: async () => false,
    onResized: async () => () => {},
  }),
}));
/** The app also reads the theme at start; every test gets Dracula unless it routes `ui_prefs` itself. */
const route = (handlers: Parameters<typeof routeInvoke>[0]) =>
  routeInvoke({ ui_prefs: () => ({ theme: "dark" }), keymap: () => ({}), save_keymap: () => null, ...handlers });

patientFile();
beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
});

test("startup opens last group when it exists, otherwise home", async () => {
  const groups = [{ id: "g1", name: "KFC", color: "red" }];
  const draft = { id: "d1", name: "Late deliveries", text: "", connectionId: null, database: null, savedId: null, savedText: null };
  // The last Group restores its tabs: no Home tab.
  route({
    list_groups: () => groups,
    list_connections: () => [],
    last_group: () => "g1",
    suggested_connections: () => [],
    load_query_tabs: ({ place }) => (place === "group:g1" ? JSON.stringify({ version: 1, tabs: [draft] }) : null),
    save_query_tabs: () => null,
    list_saved_queries: () => [],
  });
  render(<App />);
  expect(await screen.findByRole("button", { name: "Switch Group, current KFC" })).toBeTruthy();
  expect(await screen.findByRole("tab", { name: "Late deliveries", selected: true })).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Home" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Home" })).toBeNull();
  cleanup();

  // The last Group restores no tabs: Home opens there (PR6).
  route({
    list_groups: () => groups,
    list_connections: () => [],
    last_group: () => "g1",
    suggested_connections: () => [],
  });
  render(<App />);
  expect(await screen.findByRole("tab", { name: "Home", selected: true })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Switch Group, current KFC" })).toBeTruthy();
  cleanup();

  // A remembered Group that no longer exists falls back to Home in Ungrouped.
  route({
    list_groups: () => groups,
    list_connections: () => [],
    last_group: () => "deleted-group",
    suggested_connections: () => [],
  });
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Home" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Switch Group, current No Group" })).toBeTruthy();
});

test("startup_without_a_last_group_opens_home_in_ungrouped", async () => {
  const loose = { ...pg, id: "c9", name: "Scratch", groupId: null };
  route({
    list_groups: () => [kfc],
    list_connections: () => [pg, loose],
    last_group: () => null,
    suggested_connections: () => [],
    load_query_tabs: () => null,
    save_query_tabs: () => null,
    list_saved_queries: () => [],
  });
  render(<App />);
  expect(await screen.findByRole("tab", { name: "Home", selected: true })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Switch Group, current Ungrouped" })).toBeTruthy();
  // Ungrouped is the place underneath: its drafts are read.
  await waitFor(() => expect(callsTo("load_query_tabs")).toEqual([{ place: "ungrouped" }]));
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

/** Closes the Home tab startup opened (PR6), so the place's sidebar and work area show. */
async function closeHome() {
  const strip = await screen.findByRole("tablist", { name: "Open tabs" });
  await userEvent.click(await within(strip).findByRole("button", { name: "Close Home" }));
  await waitFor(() => expect(screen.queryByRole("tab", { name: "Home" })).toBeNull());
}

function workspaceRoutes(over: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  route({
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

test("ctrl_alt_i_toggles_the_assistant_through_the_registry", async () => {
  workspaceRoutes({ ai_settings: () => { throw { kind: "storage", message: "no" }; }, list_ai_threads: () => [] });
  render(<App />);
  await screen.findByRole("button", { name: "Switch Group, current KFC" });
  await closeHome();
  expect(screen.queryByRole("complementary", { name: "Ask" })).toBeNull();
  await userEvent.keyboard("{Control>}{Alt>}i{/Alt}{/Control}");
  expect(await screen.findByRole("complementary", { name: "Ask" })).toBeTruthy();
  await userEvent.keyboard("{Control>}{Alt>}i{/Alt}{/Control}");
  await waitFor(() => expect(screen.queryByRole("complementary", { name: "Ask" })).toBeNull());
});

test("handled_keys_prevent_the_browser_default", async () => {
  workspaceRoutes();
  render(<App />);
  await screen.findByRole("button", { name: "Switch Group, current KFC" });
  const f5 = new KeyboardEvent("keydown", { key: "F5", code: "F5", bubbles: true, cancelable: true });
  document.body.dispatchEvent(f5);
  expect(f5.defaultPrevented).toBe(true);
  const ctrlN = new KeyboardEvent("keydown", { key: "n", code: "KeyN", ctrlKey: true, bubbles: true, cancelable: true });
  document.body.dispatchEvent(ctrlN);
  expect(ctrlN.defaultPrevented).toBe(true);
  // Ctrl+N is New Connection.
  expect(await screen.findByRole("dialog", { name: "New Connection" })).toBeTruthy();
});

test("a_failed_open_from_the_tree_marks_the_row_not_the_sidebar", async () => {
  workspaceRoutes({
    open_connection: () => {
      throw { kind: "connect", message: "refused" };
    },
  });
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open KFC Postgres" }));
  const row = await screen.findByRole("treeitem", { name: "KFC Postgres, last connect failed" });
  const failed = row.querySelector(".tree-conn-failed")!;
  expect(failed.textContent).toBe("Failed");
  expect(failed.getAttribute("title")).toMatch(/^Could not connect: refused/);
  // Frame 10c: no red paragraph above the Filter field.
  expect(document.querySelector(".side-notice")).toBeNull();
});

test("new_query_from_the_connection_menu_starts_on_that_connection", async () => {
  workspaceRoutes();
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "More actions for KFC Postgres" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "New query" }));
  expect(await screen.findByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
  await waitFor(() => expect(callsTo("open_connection")).toEqual([{ id: "c1" }]));
  await waitFor(() => expect(callsTo("open_query_session")).toEqual([{ id: "c1", database: "kfc_shop" }]));
  expect(within(screen.getByRole("toolbar", { name: "Query" })).getByRole("button", { name: /KFC Postgres/ })).toBeTruthy();
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
  route({
    list_groups: () => [{ id: "g1", name: "KFC", color: "red" }],
    list_connections: () => [],
    last_group: () => "g1",
    suggested_connections: () => [],
    set_last_group: () => null,
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Switch Group, current KFC" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Ungrouped" }));
  // No Connections at all, so the switcher says No Group (C3).
  expect(await screen.findByRole("button", { name: "Switch Group, current No Group" })).toBeTruthy();
  expect(callsTo("set_last_group")).toEqual([{ id: null }]);
});

test("settings_opens_from_the_switcher_and_ctrl_comma", async () => {
  route({
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
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Switch Group, current KFC" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
  expect(await screen.findByLabelText("Use different settings for KFC")).toBeTruthy();
  const sections = screen.getByRole("navigation", { name: "Settings sections" });
  // It opens at the top; every section is on the one page.
  expect(within(sections).getByRole("button", { name: "Appearance" }).getAttribute("aria-current")).toBe("page");
  expect(within(sections).getByRole("button", { name: "AI assistant" })).toBeTruthy();
  // Nothing to save or cancel (D6): the tab just closes.
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Close Settings" }));
  expect(screen.queryByLabelText("Use different settings for KFC")).toBeNull();
  expect(screen.queryByRole("tab", { name: "Settings" })).toBeNull();
  expect(screen.getByText("No Connections in KFC yet.")).toBeTruthy();

  expect(within(document.querySelector("footer.app-status") as HTMLElement).queryByRole("button", { name: "Settings" })).toBeNull();
  await userEvent.keyboard("{Control>},{/Control}");
  expect(await screen.findByLabelText("Use different settings for KFC")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Close Settings" }));
  expect(screen.queryByLabelText("Use different settings for KFC")).toBeNull();
  expect(screen.getByText("No Connections in KFC yet.")).toBeTruthy();
});

test("no_rail_is_rendered", async () => {
  route({
    list_groups: () => [kfc],
    list_connections: () => [],
    last_group: () => "g1",
    suggested_connections: () => [],
  });
  render(<App />);
  await screen.findByText("No Connections in KFC yet.");
  expect(screen.queryByRole("navigation", { name: "Sections" })).toBeNull();
  expect(document.querySelector(".rail")).toBeNull();
});

test("status_bar_shows_the_opened_connections_server_version", async () => {
  workspaceRoutes({ open_connection: () => "16.4" });
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open KFC Postgres" }));
  const bar = document.querySelector("footer.app-status") as HTMLElement;
  expect(await within(bar).findByText("PostgreSQL 16.4")).toBeTruthy();
  expect(bar.textContent).toContain("KFC Postgres");
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
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open KFC Shop" }));
  // The default database opens with its Tables when the Connection opens.
  await userEvent.click(await screen.findByRole("treeitem", { name: "orders" }));
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

const inAsk = (name: string) => within(screen.getByRole("dialog")).getByRole("button", { name: new RegExp(`^${name}`) });
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

test("title_bar_close_asks_about_pending_edits_first", async () => {
  await openOrdersWithAnEdit();
  await waitFor(() => expect(closeWindow.handler).not.toBeNull());
  closeWindow.destroy.mockClear();
  const bar = document.querySelector("header.title-bar") as HTMLElement;
  await userEvent.click(within(bar).getByRole("button", { name: "Close" }));
  expect(closeWindow.close).toHaveBeenCalled();
  await screen.findByText("Save changes to orders?");
  expect(closeWindow.destroy).not.toHaveBeenCalled();
  await userEvent.click(inAsk("Discard"));
  await waitFor(() => expect(closeWindow.destroy).toHaveBeenCalled());
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
  await userEvent.click(screen.getByRole("menuitem", { name: "Move to Group" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Ungrouped" }));
  expect(await screen.findByText("Save changes to orders?")).toBeTruthy();
  await userEvent.click(inAsk("Cancel"));
  expect(callsTo("move_connection")).toHaveLength(0);
  expect(screen.getByRole("tab", { name: /orders/ })).toBeTruthy();
});

test("delete_still_asks_about_pending_edits_first", async () => {
  await openOrdersWithAnEdit({ delete_connection: () => null });
  await userEvent.click(screen.getByRole("button", { name: "More actions for KFC Shop" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Delete Connection..." }));
  // The tree's own confirmation comes first, then the Pending Edits ask (D4).
  await userEvent.click(within(screen.getByRole("dialog", { name: "Delete KFC Shop?" })).getByRole("button", { name: "Delete Connection" }));
  expect(await screen.findByText("Save changes to orders?")).toBeTruthy();
  await userEvent.click(inAsk("Cancel"));
  expect(callsTo("delete_connection")).toHaveLength(0);
  expect(screen.getByRole("tab", { name: /orders/ })).toBeTruthy();
  expect(screen.getByRole("treeitem", { name: "KFC Shop, open" })).toBeTruthy();
});

test("edit_connection_from_the_tree_with_pending_edits_asks_first", async () => {
  await openOrdersWithAnEdit();
  await userEvent.click(screen.getByRole("button", { name: "Edit KFC Shop" }));
  expect(await screen.findByText("Save changes to orders?")).toBeTruthy();
  await userEvent.click(inAsk("Cancel"));
  expect(screen.queryByRole("dialog", { name: "Edit Connection" })).toBeNull();
  expect(screen.getByRole("tab", { name: /orders/ })).toBeTruthy();
});

test("edit_connection_from_a_failed_query_tab_opens_the_form", async () => {
  workspaceRoutes({
    open_connection: () => {
      throw { kind: "connect", message: "refused" };
    },
  });
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "More actions for KFC Postgres" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "New query" }));
  const closed = await screen.findByRole("group", { name: "Connection state" });
  await userEvent.click(within(closed).getByRole("button", { name: /^Open KFC Postgres/ }));
  await userEvent.click(await within(closed).findByRole("button", { name: "Edit Connection..." }));
  expect(await screen.findByRole("dialog", { name: "Edit Connection" })).toBeTruthy();
});

test("status_follows_the_selected_branch_while_the_tree_has_focus", async () => {
  const other = { ...pg, id: "c3", name: "KFC Reporting", database: "reports" };
  workspaceRoutes({
    list_connections: () => [pg, other],
    open_connection: ({ id }) => (id === "c1" ? "16.4" : "15.2"),
    list_databases: ({ id }) => (id === "c1" ? ["kfc_shop"] : ["reports"]),
    list_schemas: () => [{ name: "public", isSystem: false }],
    list_objects: () => [{ kind: "table", name: "orders", rows: 3 }],
  });
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open KFC Reporting" }));
  await userEvent.click(await screen.findByRole("button", { name: "More actions for KFC Postgres" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "New query" }));
  expect(await screen.findByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
  const bar = document.querySelector("footer.app-status") as HTMLElement;
  await waitFor(() => expect(bar.textContent).toContain("KFC Postgres"));
  // Focus in the tree: the status bar follows the focused branch.
  const reports = await screen.findByRole("treeitem", { name: "reports" });
  reports.focus();
  await waitFor(() => expect(bar.textContent).toContain("KFC Reporting"));
  expect(bar.textContent).toContain("PostgreSQL 15.2");
  // Focus on the tab again: the status bar follows the tab.
  screen.getByRole("tab", { name: "Query 1" }).focus();
  await waitFor(() => expect(bar.textContent).toContain("KFC Postgres"));
  expect(bar.textContent).not.toContain("KFC Reporting");
});

const reportsRoutes = () => {
  const other = { ...pg, id: "c3", name: "KFC Reporting", database: "reports" };
  shellRoutes({
    list_connections: () => [pg, other],
    open_connection: ({ id }) => (id === "c1" ? "16.4" : "15.2"),
    list_databases: ({ id }) => (id === "c1" ? ["kfc_shop"] : ["reports"]),
    list_schemas: () => [{ name: "public", isSystem: false }],
    list_objects: () => [{ kind: "table", name: "orders", rows: 3 }],
  });
};

test("a_group_change_while_the_tree_has_focus_drops_the_tree_branch_from_the_status_bar", async () => {
  reportsRoutes();
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open KFC Reporting" }));
  const bar = document.querySelector("footer.app-status") as HTMLElement;
  const reports = await screen.findByRole("treeitem", { name: "reports" });
  reports.focus();
  await waitFor(() => expect(bar.textContent).toContain("KFC Reporting"));
  await userEvent.keyboard("{Control>}1{/Control}");
  expect(await screen.findByRole("button", { name: "Switch Group, current Acme" })).toBeTruthy();
  await waitFor(() => expect(bar.textContent).not.toContain("KFC Reporting"));
  expect(bar.textContent).toContain("No Connection open");
});

test("back_in_the_place_the_focused_branch_leads_the_status_bar_again", async () => {
  reportsRoutes();
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open KFC Reporting" }));
  const bar = document.querySelector("footer.app-status") as HTMLElement;
  (await screen.findByRole("treeitem", { name: "reports" })).focus();
  await waitFor(() => expect(bar.textContent).toContain("KFC Reporting"));
  await userEvent.keyboard("{Control>}1{/Control}");
  await waitFor(() => expect(bar.textContent).not.toContain("KFC Reporting"));
  await userEvent.keyboard("{Control>}2{/Control}");
  expect(await screen.findByRole("button", { name: "Switch Group, current KFC" })).toBeTruthy();
  await userEvent.click(await screen.findByRole("button", { name: "More actions for KFC Postgres" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "New query" }));
  expect(await screen.findByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
  await waitFor(() => expect(bar.textContent).toContain("KFC Postgres"));
  (await screen.findByRole("treeitem", { name: "reports" })).focus();
  await waitFor(() => expect(bar.textContent).toContain("KFC Reporting"));
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
  await userEvent.click(inAsk("Cancel"));
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
  await userEvent.click(await screen.findByRole("button", { name: /^Delete Group\.\.\./ }));
  await userEvent.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "Delete Group" }));
  expect(await screen.findByText("Save changes to orders?")).toBeTruthy();
  expect(callsTo("delete_group")).toHaveLength(0);
  const ask = screen.getByText("Save changes to orders?").closest('[role="dialog"]') as HTMLElement;
  await userEvent.click(within(ask).getByRole("button", { name: /^Cancel/ }));
  expect(callsTo("delete_group")).toHaveLength(0);
  expect(screen.getByRole("tab", { name: /orders/ })).toBeTruthy();
});

// ---- Recent items (restyle Task 12) ----

const shopC1 = { ...shopMy, id: "c1" };
const ordersTarget = { kind: "table", path: { database: "shop", schema: null, name: "orders" }, object: "table" };

function recentRoutes(over: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  workspaceRoutes({
    list_connections: () => [shopC1],
    list_databases: () => ["shop"],
    list_objects: () => [{ kind: "table", name: "orders" }],
    fetch_page: () => ordersPage,
    set_last_group: () => null,
    sql_schema: () => ({ tables: [], functions: [] }),
    record_recent: () => null,
    recent_items: () => [],
    ...over,
  });
}

test("opening_a_table_records_it_as_recent", async () => {
  recentRoutes();
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open KFC Shop" }));
  // The default database opens with its Tables when the Connection opens.
  await userEvent.click(await screen.findByRole("treeitem", { name: "orders" }));
  await waitFor(() => expect(callsTo("record_recent")).toEqual([{ target: ordersTarget, connectionId: "c1" }]));
  // The list is read again after each record.
  await waitFor(() => expect(callsTo("recent_items").length).toBeGreaterThanOrEqual(2));
});

test("a_recent_table_on_home_opens_its_tab", async () => {
  recentRoutes({
    last_group: () => null,
    recent_items: () => [{ target: ordersTarget, connectionId: "c1", openedAtMs: Date.now() - 60_000 }],
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: /^shop\.orders, Table on KFC Shop, / }));
  expect(await screen.findByRole("tab", { name: /orders/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Switch Group, current KFC" })).toBeTruthy();
  await waitFor(() => expect(callsTo("open_connection")).toEqual([{ id: "c1" }]));
  await waitFor(() => expect(document.querySelector('tr[data-row="0"]')).not.toBeNull());
});

test("a_recent_model_whose_file_is_gone_says_so_and_keeps_the_item", async () => {
  const item = { target: { kind: "schemaModel", file: "E:\\models\\shop.dbml" }, connectionId: null, openedAtMs: Date.now() };
  recentRoutes({
    last_group: () => null,
    recent_items: () => [item],
    read_model_files: () => {
      throw { kind: "file", message: "cannot read E:\\models\\shop.dbml: The system cannot find the file specified. (os error 2)" };
    },
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: /^shop\.dbml, Schema model, No Connection, / }));
  expect(await screen.findByText("shop.dbml is no longer there.")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
  expect(screen.getByRole("button", { name: /^shop\.dbml, Schema model, No Connection, / })).toBeTruthy();
});

/** Resolves after the drafts have loaded, so the draft restore runs before the Connection is open. */
const later = <T,>(value: T) => () => new Promise<T>((done) => setTimeout(() => done(value), 80));
const lateDraft = { id: "d1", name: "Late deliveries", text: "SELECT 1", connectionId: "c1", database: "shop", savedId: null, savedText: null };

test("a_recent_saved_query_already_in_the_drafts_opens_once", async () => {
  const q = { id: "q1", name: "Unpaid orders", sql: "SELECT * FROM orders" };
  const draft = { ...lateDraft, id: "d2", name: "Unpaid orders", text: q.sql, savedId: "q1", savedText: q.sql };
  recentRoutes({
    last_group: () => null,
    list_saved_queries: () => [q],
    load_query_tabs: ({ place }) => (place === "group:g1" ? JSON.stringify({ version: 1, tabs: [lateDraft, draft] }) : null),
    open_connection: later(null),
    recent_items: () => [{ target: { kind: "query", savedId: "q1", name: "Unpaid orders" }, connectionId: "c1", openedAtMs: Date.now() }],
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: /^Unpaid orders, Query on KFC Shop, / }));
  await waitFor(() => expect(callsTo("record_recent").length).toBe(1));
  await waitFor(() => expect(screen.getByRole("tab", { name: "Unpaid orders", selected: true })).toBeTruthy());
  expect(screen.getAllByRole("tab", { name: "Unpaid orders" })).toHaveLength(1);
});

test("a_recent_table_on_a_closed_connection_is_active_after_the_drafts", async () => {
  recentRoutes({
    last_group: () => null,
    load_query_tabs: ({ place }) => (place === "group:g1" ? JSON.stringify({ version: 1, tabs: [lateDraft] }) : null),
    open_connection: later(null),
    recent_items: () => [{ target: ordersTarget, connectionId: "c1", openedAtMs: Date.now() }],
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: /^shop\.orders, Table on KFC Shop, / }));
  expect(await screen.findByRole("tab", { name: "Late deliveries" })).toBeTruthy();
  await waitFor(() => expect(screen.getByRole("tab", { name: /orders/, selected: true })).toBeTruthy());
});

test("a_recent_open_is_dropped_when_you_leave_during_the_connection_open", async () => {
  let finishOpen: (v: null) => void = () => {};
  recentRoutes({
    last_group: () => null,
    open_connection: () => new Promise<null>((done) => (finishOpen = done)),
    recent_items: () => [{ target: ordersTarget, connectionId: "c1", openedAtMs: Date.now() }],
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: /^shop\.orders, Table on KFC Shop, / }));
  await userEvent.click(await screen.findByRole("button", { name: "Switch Group, current KFC" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Home" }));
  expect(await screen.findByRole("heading", { name: "Home" })).toBeTruthy();
  // Coming back to the Group on your own, then the slow open finishing, must not open the old item.
  await userEvent.click(screen.getByRole("button", { name: "Switch Group, current KFC" }));
  await userEvent.click(screen.getByRole("menuitem", { name: /KFC/ }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Home" })).toBeNull());
  await waitFor(() => expect(callsTo("load_query_tabs").filter((a) => a.place === "group:g1").length).toBe(1));
  await new Promise((done) => setTimeout(done, 20));
  finishOpen(null);
  await new Promise((done) => setTimeout(done, 40));
  expect(screen.queryByRole("tab", { name: /orders/ })).toBeNull();
  expect(callsTo("open_connection")).toEqual([{ id: "c1" }]);
});

test("a_recent_model_without_a_dialect_asks_for_one", async () => {
  const item = { target: { kind: "schemaModel", file: "E:\\models\\shop.dbml" }, connectionId: null, openedAtMs: Date.now() };
  recentRoutes({
    last_group: () => null,
    recent_items: () => [item],
    read_model_files: () => ({ dbml: "Table orders {\n  id int [pk]\n}\n", layout: null }),
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: /^shop\.dbml, Schema model, No Connection, / }));
  expect(await screen.findByText("This file doesn't say which Dialect it targets. Choose one.")).toBeTruthy();
  expect(document.querySelector(".schema-main")).toBeNull();
  await userEvent.click(within(screen.getByRole("radiogroup", { name: "Dialect of the file" })).getByRole("radio", { name: /PostgreSQL/ }));
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(document.querySelector(".schema-main")).not.toBeNull());
});

test("a_recent_model_opens_even_when_its_connection_fails", async () => {
  const item = { target: { kind: "schemaModel", file: "E:\\models\\shop.dbml" }, connectionId: "c1", openedAtMs: Date.now() };
  recentRoutes({
    last_group: () => null,
    recent_items: () => [item],
    open_connection: () => {
      throw { kind: "connect", message: "refused" };
    },
    read_model_files: () => ({ dbml: "// Dialect: MySQL\n\nTable orders {\n  id int [pk]\n}\n", layout: null }),
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: /^shop\.dbml, Schema model on KFC Shop, / }));
  await waitFor(() => expect(document.querySelector(".schema-main")).not.toBeNull());
  await waitFor(() => expect(callsTo("open_connection")).toEqual([{ id: "c1" }]));
});

test("a_recent_model_opens_in_the_schema_builder", async () => {
  const item = { target: { kind: "schemaModel", file: "E:\\models\\shop.dbml" }, connectionId: null, openedAtMs: Date.now() };
  recentRoutes({
    last_group: () => null,
    recent_items: () => [item],
    read_model_files: () => ({ dbml: "// Dialect: MySQL\n\nTable orders {\n  id int [pk]\n}\n", layout: null }),
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: /^shop\.dbml, Schema model, No Connection, / }));
  await waitFor(() => expect(document.querySelector(".schema-main")).not.toBeNull());
  await waitFor(() =>
    expect(callsTo("record_recent")).toEqual([{ target: { kind: "schemaModel", file: "E:\\models\\shop.dbml" }, connectionId: null }]),
  );
});
// ---- Window tabs, title bar and Group switcher (design parity Task 8) ----

const acme = { id: "g2", name: "Acme", color: "sky" };
const aiSettingsReply = () => ({
  settings: { provider: null, preset: null, baseUrl: "", model: "", temperature: null, maxTokens: null, inlineAsk: true, errorAsk: true },
  groupOverride: false,
  keySaved: false,
  keyLast4: null,
});

function shellRoutes(over: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  workspaceRoutes({
    list_groups: () => [kfc, acme],
    set_last_group: () => null,
    ai_settings: aiSettingsReply,
    ...over,
  });
}

const strip = () => screen.getByRole("tablist", { name: "Open tabs" });
const tabNames = () => within(strip()).getAllByRole("tab").map((t) => t.getAttribute("aria-label"));

test("home_is_a_tab_that_closes_like_any_tab", async () => {
  shellRoutes({ last_group: () => null });
  render(<App />);
  const home = await screen.findByRole("tab", { name: "Home", selected: true });
  expect(home).toBeTruthy();
  // C1: the strip and its "+" are there on Home.
  expect(screen.getByRole("button", { name: "New query" })).toBeTruthy();
  await userEvent.click(within(strip()).getByRole("button", { name: "Close Home" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Home" })).toBeNull());
  expect(screen.queryByRole("tab", { name: "Home" })).toBeNull();
  // The place shows: its sidebar and the empty work area.
  expect(screen.getByRole("complementary", { name: "Ungrouped Connections" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "New query" })).toBeTruthy();
});

test("home_opens_from_the_switcher_and_ctrl_shift_h", async () => {
  shellRoutes();
  render(<App />);
  await closeHome();
  await userEvent.click(screen.getByRole("button", { name: "Switch Group, current KFC" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Home" }));
  expect(await screen.findByRole("tab", { name: "Home", selected: true })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
  // Home is not a place: the switcher still names the Group, and nothing is forgotten.
  expect(screen.getByRole("button", { name: "Switch Group, current KFC" })).toBeTruthy();
  expect(callsTo("set_last_group")).toEqual([]);

  await closeHome();
  await userEvent.keyboard("{Control>}{Shift>}h{/Shift}{/Control}");
  expect(await screen.findByRole("tab", { name: "Home", selected: true })).toBeTruthy();
  // Asked again while open, it is the same one tab.
  await userEvent.keyboard("{Control>}{Shift>}h{/Shift}{/Control}");
  expect(screen.getAllByRole("tab", { name: "Home" })).toHaveLength(1);
});

test("ctrl_2_opens_the_second_group", async () => {
  shellRoutes({ last_group: () => "g2" });
  render(<App />);
  await screen.findByRole("button", { name: "Switch Group, current Acme" });
  // Groups by name: Acme is Ctrl+1, KFC Ctrl+2, then Ungrouped Ctrl+3.
  await userEvent.keyboard("{Control>}2{/Control}");
  expect(await screen.findByRole("button", { name: "Switch Group, current KFC" })).toBeTruthy();
  await waitFor(() => expect(callsTo("set_last_group")).toEqual([{ id: "g1" }]));
  await userEvent.keyboard("{Control>}3{/Control}");
  expect(await screen.findByRole("button", { name: "Switch Group, current Ungrouped" })).toBeTruthy();
  await userEvent.keyboard("{Control>}1{/Control}");
  expect(await screen.findByRole("button", { name: "Switch Group, current Acme" })).toBeTruthy();
});

test("window_tabs_survive_a_group_change", async () => {
  shellRoutes({ last_group: () => "g2" });
  render(<App />);
  await screen.findByRole("tab", { name: "Home" });
  await userEvent.keyboard("{Control>}t{/Control}");
  expect(await screen.findByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
  await userEvent.keyboard("{Control>},{/Control}");
  expect(await screen.findByRole("tab", { name: "Settings", selected: true })).toBeTruthy();
  expect(tabNames()).toEqual(["Home", "Query 1", "Settings"]);
  await userEvent.keyboard("{Control>}2{/Control}");
  expect(await screen.findByRole("button", { name: "Switch Group, current KFC" })).toBeTruthy();
  // The query tab belonged to Acme; Home and Settings belong to the window.
  await waitFor(() => expect(tabNames()).toEqual(["Home", "Settings"]));
});

test("settings_is_a_tab_not_an_overlay", async () => {
  shellRoutes();
  render(<App />);
  await screen.findByRole("tab", { name: "Home", selected: true });
  await userEvent.click(screen.getByRole("button", { name: "Switch Group, current KFC" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
  expect(await screen.findByRole("tab", { name: "Settings", selected: true })).toBeTruthy();
  expect(await screen.findByLabelText("Use different settings for KFC")).toBeTruthy();
  // It is a pane of the work area, beside the other tabs, not a layer over them.
  const work = document.querySelector("main.work") as HTMLElement;
  expect(work.querySelector(".settings-view")).not.toBeNull();
  expect(document.querySelector(".place-wrap[hidden]")).toBeNull();
  expect(tabNames()).toEqual(["Home", "Settings"]);
  // Moving to another tab keeps it open in the strip; coming back shows it again.
  await userEvent.click(screen.getByRole("tab", { name: "Home" }));
  expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
  expect(screen.queryByRole("switch", { name: "Use different settings for KFC" })).toBeNull();
  await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
  expect(screen.getByRole("switch", { name: "Use different settings for KFC" })).toBeTruthy();
  // Opening Settings again reuses the tab.
  await userEvent.keyboard("{Control>},{/Control}");
  expect(screen.getAllByRole("tab", { name: "Settings" })).toHaveLength(1);
});

test("schema_builder_is_a_tab_with_the_strip_present", async () => {
  shellRoutes({ last_group: () => null, list_connections: () => [{ ...pg, groupId: null }] });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Open Ungrouped" }));
  await userEvent.click(await screen.findByRole("button", { name: `More actions for ${pg.name}` }));
  await userEvent.click(screen.getByRole("menuitem", { name: "New Schema Model..." }));
  await userEvent.click(screen.getByRole("radio", { name: /Blank model/ }));
  await userEvent.click(screen.getByRole("button", { name: /^Create blank model/ }));
  expect(await screen.findByRole("tab", { name: "untitled.dbml", selected: true })).toBeTruthy();
  expect(tabNames()).toEqual(["Home", "untitled.dbml"]);
  expect(screen.getByRole("button", { name: "New query" })).toBeTruthy();
  const work = document.querySelector("main.work") as HTMLElement;
  expect(work.querySelector(".schema-main")).not.toBeNull();
  expect(await screen.findByRole("region", { name: "Schema Model schema" })).toBeTruthy();
  // Closing the model's tab asks about its unsaved text, like the builder's own Close.
  await userEvent.click(within(strip()).getByRole("button", { name: "Close untitled.dbml" }));
  expect(await screen.findByText("Save changes to schema?")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("tab", { name: "untitled.dbml", selected: true })).toBeTruthy();
  await userEvent.click(within(strip()).getByRole("button", { name: "Close untitled.dbml" }));
  await userEvent.click(await screen.findByRole("button", { name: "Don't save" }));
  await waitFor(() => expect(screen.queryByRole("tab", { name: "untitled.dbml" })).toBeNull());
  expect(screen.getByRole("tab", { name: "Home", selected: true })).toBeTruthy();
});

test("new_group_from_the_switcher_opens_the_group_form", async () => {
  shellRoutes();
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Switch Group, current KFC" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "New Group..." }));
  expect(await screen.findByRole("dialog", { name: "New Group" })).toBeTruthy();
});

// ---- Task 8 review fixes ----

test("reopening_settings_moves_back_to_the_asked_section", async () => {
  shellRoutes();
  render(<App />);
  await screen.findByRole("tab", { name: "Home" });
  await userEvent.keyboard("{Control>},{/Control}");
  const sections = await screen.findByRole("navigation", { name: "Settings sections" });
  const current = () => within(sections).getByRole("button", { current: "page" }).textContent;
  expect(current()).toBe("Appearance");
  await userEvent.click(within(sections).getByRole("button", { name: "AI assistant" }));
  expect(current()).toBe("AI assistant");
  // The same section as last asked: it still moves there.
  await userEvent.keyboard("{Control>},{/Control}");
  await waitFor(() => expect(current()).toBe("Appearance"));
  expect(screen.getAllByRole("tab", { name: "Settings" })).toHaveLength(1);
});

test("ctrl_w_on_a_table_tab_with_pending_edits_asks_like_the_close_button", async () => {
  await openOrdersWithAnEdit();
  expect(screen.getByRole("tab", { name: /orders/, selected: true })).toBeTruthy();
  await userEvent.keyboard("{Control>}w{/Control}");
  expect(await screen.findByText("Save changes to orders?")).toBeTruthy();
  await userEvent.click(inAsk("Cancel"));
  expect(screen.getByRole("tab", { name: /orders/ })).toBeTruthy();
  await userEvent.keyboard("{Control>}w{/Control}");
  await screen.findByText("Save changes to orders?");
  await userEvent.click(inAsk("Discard"));
  await waitFor(() => expect(screen.queryByRole("tab", { name: /orders/ })).toBeNull());
});

test("a_schema_models_unsaved_text_survives_a_group_change", async () => {
  shellRoutes({ last_group: () => "g2", list_connections: () => [{ ...pg, groupId: "g2" }] });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Open Acme" }));
  await userEvent.click(await screen.findByRole("button", { name: `More actions for ${pg.name}` }));
  await userEvent.click(screen.getByRole("menuitem", { name: "New Schema Model..." }));
  await userEvent.click(screen.getByRole("radio", { name: /Blank model/ }));
  await userEvent.click(screen.getByRole("button", { name: /^Create blank model/ }));
  await screen.findByRole("tab", { name: "untitled.dbml", selected: true });
  const pane = () => document.querySelector(".schema-main") as HTMLElement;
  const view = () => EditorView.findFromDOM(pane().querySelector(".cm-editor") as HTMLElement)!;
  await waitFor(() => expect(pane().querySelector(".cm-editor")).not.toBeNull());
  view().dispatch({ changes: { from: 0, insert: "// kept across Groups\n" } });
  await userEvent.keyboard("{Control>}2{/Control}");
  expect(await screen.findByRole("button", { name: "Switch Group, current KFC" })).toBeTruthy();
  await userEvent.click(screen.getByRole("tab", { name: "untitled.dbml" }));
  expect(view().state.doc.toString().startsWith("// kept across Groups\n")).toBe(true);
  expect(within(pane()).getByText("Unsaved")).toBeTruthy();
});

// ---- Object tree in the App (ported from the old ObjectTree tests) ----

test("selecting_a_routine_or_trigger_shows_its_definition", async () => {
  workspaceRoutes({
    list_connections: () => [{ ...shopMy, name: "kfc-prod", database: null }],
    list_databases: () => ["shop"],
    list_objects: () => [
      { kind: "table", name: "orders", rows: null },
      { kind: "procedure", name: "close_day", rows: null },
      { kind: "trigger", name: "orders_audit", rows: null },
    ],
    object_definition: (a) =>
      a.kind === "trigger" ? "CREATE TRIGGER orders_audit AFTER INSERT" : "CREATE PROCEDURE close_day() BEGIN END",
  });
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open kfc-prod" }));
  // No default database: open it, then its Procedures folder.
  await userEvent.click(await screen.findByRole("treeitem", { name: "shop" }));
  await userEvent.click(await screen.findByRole("treeitem", { name: "Procedures" }));
  await userEvent.click(await screen.findByRole("treeitem", { name: "close_day" }));
  expect(await screen.findByText("CREATE PROCEDURE close_day() BEGIN END")).toBeTruthy();
  expect(callsTo("object_definition")).toEqual([
    { id: "c2", kind: "procedure", path: { database: "shop", schema: null, name: "close_day" } },
  ]);
  await userEvent.click(screen.getByRole("treeitem", { name: "Triggers" }));
  await userEvent.click(await screen.findByRole("treeitem", { name: "orders_audit" }));
  expect(await screen.findByText("CREATE TRIGGER orders_audit AFTER INSERT")).toBeTruthy();
  expect(callsTo("fetch_page")).toHaveLength(0);
});

test("app_titles_postgres_objects_with_their_schema", async () => {
  const onePage = {
    columns: [{ name: "id", typeName: "int4", isPrimaryKey: true }],
    rows: [[{ t: "number", value: "7" }]],
    hasMore: false,
  };
  workspaceRoutes({
    list_connections: () => [{ ...pg, name: "kfc-orders", database: "shop" }],
    list_databases: () => ["postgres", "shop"],
    list_schemas: () => [
      { name: "public", isSystem: false },
      { name: "sales", isSystem: false },
    ],
    list_objects: () => [{ kind: "table", name: "orders", rows: null }],
    fetch_page: () => onePage,
    set_last_group: () => null,
    sql_schema: () => ({ tables: [], functions: [] }),
    record_recent: () => null,
    recent_items: () => [],
  });
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open kfc-orders" }));
  // public opens with the database; its orders is the only one shown yet.
  await userEvent.click(await screen.findByRole("treeitem", { name: "orders" }));
  const grid = await screen.findByRole("region", { name: "Data of orders" });
  expect(within(grid).getByRole("heading", { level: 2 }).textContent).toBe("public.orders");

  // The same name in another schema is another object: a fresh grid with its own request.
  await userEvent.click(screen.getByRole("treeitem", { name: "sales" }));
  await waitFor(() => expect(screen.getAllByRole("treeitem", { name: "orders" })).toHaveLength(2));
  await userEvent.click(screen.getAllByRole("treeitem", { name: "orders" })[1]);
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "Data of orders" })).getByRole("heading", { level: 2 }).textContent,
    ).toBe("sales.orders"),
  );
  await waitFor(() =>
    expect(callsTo("fetch_page").map((a) => (a.request as { table: { schema: string } }).table.schema)).toEqual([
      "public",
      "sales",
    ]),
  );
});

// ---- Task 14: dialogs and Group images ----

test("pending_edits_guard_still_saves_through_the_grid", async () => {
  await openOrdersWithAnEdit({
    plan_edits: () => ({ statements: ["UPDATE x"], verdict: { kind: "ok" } }),
    apply_edits: () => ({ updated: 1, inserted: 0, deleted: 0 }),
  });
  await userEvent.click(tabClose());
  expect(await screen.findByText("Save changes to orders?")).toBeTruthy();
  expect(screen.getByRole("dialog").textContent).toContain(
    "You have 1 Pending Edit in shop.orders on KFC Shop. Closing the tab without saving loses it.",
  );
  await userEvent.click(inAsk("Save"));
  await waitFor(() => expect(callsTo("apply_edits")).toHaveLength(1));
  await waitFor(() => expect(screen.queryByRole("tab", { name: /orders/ })).toBeNull());
});

test("the_production_ask_says_save_on_prod_and_focuses_cancel", async () => {
  await openOrdersWithAnEdit({ list_connections: () => [{ ...shopMy, production: true }] });
  await userEvent.click(tabClose());
  await screen.findByText("Save changes to orders?");
  expect(screen.getByRole("dialog").textContent).toContain("on KFC Shop (Production)");
  expect(screen.getByRole("button", { name: "Save on PROD..." })).toBeTruthy();
  expect(document.activeElement).toBe(inAsk("Cancel"));
});

const savedQ = { id: "q1", name: "late shipments by carrier", sql: "SELECT 1", updatedAtMs: new Date(2026, 9, 14, 12).getTime(), connectionId: "c1" };
const editedSaved = {
  id: "d1",
  name: "late shipments by carrier",
  text: "SELECT 2",
  connectionId: "c1",
  database: "kfc_shop",
  savedId: "q1",
  savedText: "SELECT 1",
};

function savedRoutes(over: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  workspaceRoutes({
    list_saved_queries: () => [savedQ],
    load_query_tabs: ({ place }) => (place === "group:g1" ? JSON.stringify({ version: 1, tabs: [editedSaved] }) : null),
    ...over,
  });
}

test("closing_an_edited_saved_query_asks", async () => {
  savedRoutes();
  render(<App />);
  const close = await screen.findByRole("button", { name: /^Close late shipments by carrier/ });
  await userEvent.click(close);
  expect(await screen.findByText("Save changes to late shipments by carrier?")).toBeTruthy();
  expect(screen.getByRole("dialog").textContent).toContain(
    "Your edits to this Saved Query are not saved. Discard keeps the version saved on Oct 14.",
  );
  await userEvent.click(inAsk("Cancel"));
  expect(screen.getByRole("tab", { name: /late shipments by carrier/ })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: /^Close late shipments by carrier/ }));
  await screen.findByText("Save changes to late shipments by carrier?");
  await userEvent.click(inAsk("Discard"));
  await waitFor(() => expect(screen.queryByRole("tab", { name: /late shipments by carrier/ })).toBeNull());
  expect(callsTo("save_saved_query")).toHaveLength(0);
});

test("saving_from_the_saved_query_ask_saves_then_closes", async () => {
  savedRoutes({ save_saved_query: ({ input }) => ({ ...savedQ, ...(input as object) }) });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: /^Close late shipments by carrier/ }));
  await screen.findByText("Save changes to late shipments by carrier?");
  await userEvent.click(inAsk("Save"));
  await waitFor(() => expect(callsTo("save_saved_query")).toEqual([{ input: { id: "q1", name: "late shipments by carrier", sql: "SELECT 2" } }]));
  await waitFor(() => expect(screen.queryByRole("tab", { name: /late shipments by carrier/ })).toBeNull());
});

test("a_saved_query_without_edits_closes_at_once", async () => {
  savedRoutes({
    load_query_tabs: ({ place }) =>
      place === "group:g1" ? JSON.stringify({ version: 1, tabs: [{ ...editedSaved, text: "SELECT 1" }] }) : null,
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: /^Close late shipments by carrier/ }));
  await waitFor(() => expect(screen.queryByRole("tab", { name: /late shipments by carrier/ })).toBeNull());
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("group_square_shows_the_image_in_the_switcher", async () => {
  workspaceRoutes({
    list_groups: () => [{ ...kfc, color: "indigo", hasImage: true }],
    group_image: ({ id }) => (id === "g1" ? "AAAA" : null),
  });
  render(<App />);
  const switcher = await screen.findByRole("button", { name: "Switch Group, current KFC" });
  await waitFor(() => expect(switcher.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA"));
  expect(callsTo("group_image")).toEqual([{ id: "g1" }]);
  // The sidebar header draws the same square before the Group name (layout A, D19).
  await waitFor(() =>
    expect(document.querySelector(".side-header .group-badge-image img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA"),
  );
});

test("sidebar_header_shows_the_group_letter_square_without_an_image", async () => {
  workspaceRoutes({ list_groups: () => [{ ...kfc, color: "indigo", hasImage: false }] });
  render(<App />);
  const side = await screen.findByRole("complementary", { name: "KFC Connections", hidden: true });
  const badge = side.querySelector(".side-header > .group-badge");
  expect(badge?.textContent).toBe("K");
  expect(badge?.nextElementSibling?.textContent).toBe("KFC");
});

test("run_from_an_answer_on_production_opens_the_confirmation", async () => {
  const draft = [
    { id: "d1", name: "Late deliveries", text: "SELECT 1", connectionId: "c1", database: "kfc_shop", savedId: null, savedText: null },
  ];
  const answer = "Try:\n```sql\nUPDATE orders SET status = 'x'\n```";
  workspaceRoutes({
    list_connections: () => [{ ...pg, production: true }],
    load_query_tabs: ({ place }) => (place === "group:g1" ? JSON.stringify({ version: 1, tabs: draft }) : null),
    ai_settings: aiSettingsReply,
    list_ai_threads: () => [
      {
        id: "t1",
        place: "group:g1",
        title: "fix",
        updatedAt: 2,
        messages: [
          { role: "user", text: "fix", context: [], at: 1 },
          { role: "assistant", text: answer, context: [], at: 2 },
        ],
      },
    ],
    save_ai_thread: () => null,
    classify_sql: () => "write",
    prepare_run: ({ statements }) => ({
      kind: "needsConfirmation",
      connection: "KFC Postgres",
      database: "kfc_shop",
      statements: (statements as string[]).map((text) => ({ text, class: "write" })),
      writes: 1,
    }),
    confirm_run: () => "p1",
    execute_sql: () => ({ outcome: { t: "affected", rows: 1 }, elapsedMs: 2 }),
  });
  render(<App />);
  await screen.findByRole("tab", { name: "Late deliveries, Production" });
  await userEvent.click(await screen.findByRole("button", { name: "Open KFC Postgres" }));
  await userEvent.keyboard("{Control>}{Alt>}i{/Alt}{/Control}");
  const panel = await screen.findByRole("complementary", { name: "Ask" });
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  await userEvent.click(await within(panel).findByRole("button", { name: "Run" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("1 of 1 statement writes.");
  expect(callsTo("execute_sql")).toHaveLength(0);
  // Declined: nothing ran, so the line must not say it did.
  expect(screen.queryByText(/Inserted into the editor/)).toBeNull();
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(await screen.findByText("Inserted into the editor")).toBeTruthy();
  expect(screen.queryByText(/and run/)).toBeNull();
  expect(callsTo("execute_sql")).toHaveLength(0);
  // Confirmed: it ran, and the line carries the count.
  await userEvent.click(within(panel).getByRole("button", { name: "Run" }));
  await userEvent.click(await screen.findByRole("button", { name: "Run on KFC Postgres" }));
  expect(await screen.findByText("Inserted into the editor and run, 1 row")).toBeTruthy();
  expect(callsTo("execute_sql")).toHaveLength(1);
});

// ---- final review fixes: Home's Connection changes keep the Pending Edits ask (F1), tree Saved Query (F10), Filter key (F11) ----

const dragData = () => {
  const data = new Map<string, string>();
  return {
    setData: (k: string, v: string) => data.set(k, v),
    getData: (k: string) => data.get(k) ?? "",
    effectAllowed: "",
    dropEffect: "",
    types: ["text/plain"],
  };
};

async function showHomeTab() {
  await userEvent.keyboard("{Control>}{Shift>}h{/Shift}{/Control}");
  await screen.findByRole("tab", { name: "Home", selected: true });
}

function dragShopToAcme() {
  const dataTransfer = dragData();
  const row = within(screen.getByRole("region", { name: "KFC" })).getByRole("listitem");
  fireEvent.dragStart(row, { dataTransfer });
  const target = screen.getByRole("region", { name: "Acme" });
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
}

test("home_drag_move_with_pending_edits_asks_cancel_moves_nothing_save_saves_then_moves", async () => {
  const order: string[] = [];
  await openOrdersWithAnEdit({
    list_groups: () => [kfc, acme],
    plan_edits: () => ({ statements: ["UPDATE x"], verdict: { kind: "ok" } }),
    apply_edits: () => {
      order.push("save");
      return { updated: 1, inserted: 0, deleted: 0 };
    },
    move_connection: () => {
      order.push("move");
      return { ...shopMy, groupId: "g2" };
    },
  });
  await showHomeTab();
  dragShopToAcme();
  expect(await screen.findByText("Save changes to orders?")).toBeTruthy();
  await userEvent.click(inAsk("Cancel"));
  expect(callsTo("move_connection")).toHaveLength(0);
  expect(screen.getByRole("tab", { name: /orders/ })).toBeTruthy();
  expect(await screen.findByRole("tab", { name: "Home", selected: true })).toBeTruthy();

  dragShopToAcme();
  await screen.findByText("Save changes to orders?");
  await userEvent.click(inAsk("Save"));
  await waitFor(() => expect(callsTo("move_connection")).toEqual([{ id: "c2", groupId: "g2" }]));
  expect(order).toEqual(["save", "move"]);
});

test("home_group_delete_with_pending_edits_asks_and_moves_the_window_to_ungrouped", async () => {
  let groupsNow = [kfc];
  let shop: Omit<typeof shopMy, "groupId"> & { groupId: string | null } = shopMy;
  const order: string[] = [];
  await openOrdersWithAnEdit({
    list_groups: () => groupsNow,
    list_connections: () => [shop],
    plan_edits: () => ({ statements: ["UPDATE x"], verdict: { kind: "ok" } }),
    apply_edits: () => {
      order.push("save");
      return { updated: 1, inserted: 0, deleted: 0 };
    },
    delete_group: () => {
      order.push("delete");
      groupsNow = [];
      shop = { ...shopMy, groupId: null };
      return null;
    },
  });
  await showHomeTab();
  const deleteFromHome = async () => {
    await userEvent.click(screen.getByRole("button", { name: "Group actions for KFC" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit Group" }));
    await userEvent.click(await screen.findByRole("button", { name: /^Delete Group\.\.\./ }));
    await userEvent.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "Delete Group" }));
  };
  await deleteFromHome();
  const ask = () => screen.getByText("Save changes to orders?").closest('[role="dialog"]') as HTMLElement;
  expect(await screen.findByText("Save changes to orders?")).toBeTruthy();
  await userEvent.click(within(ask()).getByRole("button", { name: /^Cancel/ }));
  expect(callsTo("delete_group")).toHaveLength(0);
  expect(screen.getByRole("tab", { name: /orders/ })).toBeTruthy();

  // The Group form stays open after a cancelled delete: close it.
  for (let i = 0; i < 3 && screen.queryByRole("dialog"); i++) await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  await showHomeTab();
  await deleteFromHome();
  await screen.findByText("Save changes to orders?");
  await userEvent.click(within(ask()).getByRole("button", { name: /^Save/ }));
  await waitFor(() => expect(callsTo("delete_group")).toEqual([{ id: "g1" }]));
  expect(order).toEqual(["save", "delete"]);
  // The place's Group is gone, so the window is in Ungrouped, Home still showing.
  expect(await screen.findByRole("button", { name: /^Switch Group, current (Ungrouped|No Group)$/ })).toBeTruthy();
  expect(await screen.findByRole("tab", { name: "Home", selected: true })).toBeTruthy();
});

test("a_saved_query_opened_from_the_tree_opens_on_its_opens_on_connection", async () => {
  const prodConn = { ...pg, id: "c9", name: "KFC Prod", production: true };
  const staging = { ...pg, id: "c1", name: "KFC Staging" };
  workspaceRoutes({
    list_connections: () => [prodConn, staging],
    list_saved_queries: () => [{ ...savedQ, connectionId: "c1" }],
    set_last_group: () => null,
  });
  render(<App />);
  await closeHome();
  // Production is the active Connection: its row was focused last.
  fireEvent.focus(await screen.findByRole("treeitem", { name: /^KFC Prod/ }));
  await userEvent.click(await screen.findByRole("treeitem", { name: /^late shipments by carrier/ }));
  await waitFor(() => expect(document.querySelector(".editor-header-connection")?.textContent).toContain("KFC Staging"));
});

test("a_saved_query_opened_from_the_saved_queries_list_opens_on_its_opens_on_connection", async () => {
  const prodConn = { ...pg, id: "c9", name: "KFC Prod", production: true };
  const staging = { ...pg, id: "c1", name: "KFC Staging" };
  workspaceRoutes({
    list_connections: () => [prodConn, staging],
    list_saved_queries: () => [{ ...savedQ, connectionId: "c1" }],
    saved_query_runs: () => [],
    set_last_group: () => null,
  });
  render(<App />);
  await closeHome();
  fireEvent.focus(await screen.findByRole("treeitem", { name: /^KFC Prod/ }));
  await userEvent.click(await screen.findByRole("button", { name: "Open the Saved Queries list" }));
  const preview = await screen.findByRole("region", { name: "late shipments by carrier" });
  await userEvent.click(within(preview).getByRole("button", { name: /^Open/ }));
  await waitFor(() => expect(document.querySelector(".editor-header-connection")?.textContent).toContain("KFC Staging"));
});

test("the_saved_queries_list_keeps_its_filter_across_a_tab_switch", async () => {
  workspaceRoutes({ list_saved_queries: () => [savedQ], saved_query_runs: () => [] });
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open the Saved Queries list" }));
  await userEvent.type(await screen.findByRole("textbox", { name: "Filter Saved Queries" }), "late");
  await userEvent.keyboard("{Control>}t{/Control}");
  await screen.findByRole("tab", { name: "Query 1", selected: true });
  await userEvent.click(screen.getByRole("tab", { name: "Saved Queries" }));
  expect((screen.getByRole("textbox", { name: "Filter Saved Queries" }) as HTMLInputElement).value).toBe("late");
  await waitFor(() => expect(callsTo("saved_query_runs")).toHaveLength(2));
});

test("ctrl_shift_f_reaches_the_tree_filter_while_home_is_in_the_strip_but_hidden", async () => {
  workspaceRoutes();
  render(<App />);
  expect(await screen.findByRole("tab", { name: "Home", selected: true })).toBeTruthy();
  await userEvent.keyboard("{Control>}t{/Control}");
  await waitFor(() => expect(screen.getByRole("tab", { name: "Home", selected: false })).toBeTruthy());
  await userEvent.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Filter objects");
});

test("ctrl_shift_f_on_the_home_tab_focuses_the_home_filter", async () => {
  workspaceRoutes();
  render(<App />);
  expect(await screen.findByRole("tab", { name: "Home", selected: true })).toBeTruthy();
  await userEvent.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
  expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Filter Connections" }));
});

// ---- Table Designer tab (step 5c) ----

const ordersDesign = {
  path: { database: "shop", schema: null, name: "orders" },
  columns: [
    { name: "id", typeSql: "int", nullable: false, defaultSql: null, increment: { kind: "autoIncrement" }, comment: null, generated: false, mysql: null, sqliteAutoincrement: false, collation: null, advanced: false },
    { name: "status", typeSql: "varchar(16)", nullable: true, defaultSql: null, increment: { kind: "none" }, comment: null, generated: false, mysql: null, sqliteAutoincrement: false, collation: null, advanced: false },
  ],
  indexes: [],
  foreignKeys: [],
  referencedBy: [],
  comment: null,
  unsupported: [],
  sqlite: null,
};

async function openOrders(over: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  workspaceRoutes({
    list_connections: () => [shopMy],
    list_databases: () => ["shop"],
    list_objects: () => [{ kind: "table", name: "orders" }],
    fetch_page: () => ordersPage,
    set_last_group: () => null,
    sql_schema: () => ({ tables: [], functions: [] }),
    table_design: () => ordersDesign,
    ...over,
  });
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open KFC Shop" }));
  await userEvent.click(await screen.findByRole("treeitem", { name: "orders" }));
  await screen.findByRole("tab", { name: "orders", selected: true });
}
const designButton = () =>
  within(document.querySelector(".work-pane:not([hidden]) .table-header") as HTMLElement).getByRole("button", { name: "Design table" });

test("design_table_opens_one_design_tab_beside_the_table", async () => {
  await openOrders();
  await userEvent.click(designButton());
  expect(await screen.findByRole("tab", { name: "orders design", selected: true })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "orders" })).toBeTruthy();
  expect(await screen.findByRole("tab", { name: "Columns 2" })).toBeTruthy();
  // The status bar follows the design tab's Connection.
  const bar = document.querySelector("footer.app-status") as HTMLElement;
  expect(bar.textContent).toContain("KFC Shop");
  await userEvent.click(screen.getByRole("tab", { name: "orders" }));
  await userEvent.click(designButton());
  expect(await screen.findByRole("tab", { name: "orders design", selected: true })).toBeTruthy();
  expect(screen.getAllByRole("tab", { name: /^orders design/ })).toHaveLength(1);
  expect(callsTo("table_design")).toHaveLength(1);
});

test("closing_a_design_tab_with_changes_asks_first", async () => {
  await openOrders();
  await userEvent.click(designButton());
  await screen.findByRole("tab", { name: "Columns 2" });
  await userEvent.click(screen.getByRole("button", { name: "Add column" }));
  const tab = await screen.findByRole("tab", { name: "orders design, unsaved changes" });
  expect(tab).toBeTruthy();
  const strip = screen.getByRole("tablist", { name: "Open tabs" });
  await userEvent.click(within(strip).getByRole("button", { name: "Close orders design" }));
  expect(await screen.findByText("Apply changes to orders?")).toBeTruthy();
  await userEvent.click(inAsk("Cancel"));
  expect(screen.getByRole("tab", { name: /^orders design/ })).toBeTruthy();
  await userEvent.click(within(strip).getByRole("button", { name: "Close orders design" }));
  await screen.findByText("Apply changes to orders?");
  await userEvent.click(inAsk("Discard"));
  await waitFor(() => expect(screen.queryByRole("tab", { name: /^orders design/ })).toBeNull());
  expect(screen.getByRole("tab", { name: "orders" })).toBeTruthy();
});

test("group_switch_with_an_unapplied_design_asks_by_click_and_by_ctrl_number", async () => {
  await openOrders();
  await userEvent.click(designButton());
  await screen.findByRole("tab", { name: "Columns 2" });
  await userEvent.click(screen.getByRole("button", { name: "Add column" }));
  await screen.findByRole("tab", { name: "orders design, unsaved changes" });
  await userEvent.click(screen.getByRole("button", { name: "Switch Group, current KFC" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Ungrouped" }));
  expect(await screen.findByText("Apply changes to orders?")).toBeTruthy();
  await userEvent.click(inAsk("Cancel"));
  expect(screen.getByRole("button", { name: "Switch Group, current KFC" })).toBeTruthy();
  // Ctrl+2 is Ungrouped here (KFC is the only Group).
  (document.activeElement as HTMLElement | null)?.blur();
  await userEvent.keyboard("{Control>}2{/Control}");
  expect(await screen.findByText("Apply changes to orders?")).toBeTruthy();
  await userEvent.click(inAsk("Cancel"));
  expect(screen.getByRole("button", { name: "Switch Group, current KFC" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "orders design, unsaved changes" })).toBeTruthy();
});

// ---- New table and Drop table (step 5c, Task 10) ----

const DROP = "DROP TABLE `orders`";
const dropPlan = (verdict: Record<string, unknown> = { kind: "ok" }) => ({
  plan: {
    statements: [DROP],
    warnings: [{ kind: "dropTable", table: "orders", rows: { kind: "exact", n: 1204 }, referencedBy: [] }],
    mode: { kind: "atomic" },
    before: 0,
    after: 0,
    checks: [],
    foreignKeys: null,
  },
  verdict,
});
const dropRoutes = {
  table_design: () => ordersDesign,
  plan_design: () => dropPlan(),
  apply_design: () => ({ kind: "done", ran: 1 }),
  forget_recent: () => null,
  recent_items: () => [],
};
const ordersRoutes = (c: typeof shopMy) => ({
  list_connections: () => [c],
  list_databases: () => ["shop"],
  list_objects: () => [{ kind: "table", name: "orders", rows: 1204 }],
  fetch_page: () => ordersPage,
  set_last_group: () => null,
  sql_schema: () => ({ tables: [], functions: [] }),
});
const dropFromTree = async () => {
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: "orders" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Drop table..." }));
};

test("drop_asks_about_pending_edits_before_it_runs", async () => {
  await openOrdersWithAnEdit(dropRoutes);
  await dropFromTree();
  expect(await screen.findByText("Save changes to orders?")).toBeTruthy();
  await userEvent.click(inAsk("Cancel"));
  // Cancel stops the drop: nothing planned, the table and its edits stay.
  await waitFor(() => expect(screen.queryByText("Save changes to orders?")).toBeNull());
  expect(callsTo("plan_design")).toHaveLength(0);
  expect(screen.getByRole("tab", { name: /^orders/ })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Pending Edits" })).toBeTruthy();
  await dropFromTree();
  await screen.findByText("Save changes to orders?");
  await userEvent.click(inAsk("Discard"));
  const dialog = await screen.findByRole("dialog", { name: "Drop orders?" });
  expect(callsTo("plan_design")).toHaveLength(1);
  await userEvent.click(within(dialog).getByRole("button", { name: "Drop orders" }));
  await waitFor(() => expect(screen.queryByRole("tab", { name: /^orders/ })).toBeNull());
  // The tab closes without a second ask.
  expect(screen.queryByText("Save changes to orders?")).toBeNull();
  expect(callsTo("apply_design")).toHaveLength(1);
});

test("plain_drop_warns_closes_both_tabs_and_reloads_tree_and_recent", async () => {
  await openOrders(dropRoutes);
  await userEvent.click(designButton());
  await screen.findByRole("tab", { name: "Columns 2" });
  const listsBefore = callsTo("list_objects").length;
  await dropFromTree();
  const dialog = await screen.findByRole("dialog", { name: "Drop orders?" });
  expect(within(dialog).getByText("Dropping orders deletes its 1,204 rows.")).toBeTruthy();
  expect(dialog.querySelector(".sql-block")?.textContent).toContain(DROP);
  const plan = callsTo("plan_design").slice(-1)[0].request as { target: { kind: string; base: unknown }; edits: unknown[] };
  expect(plan).toEqual({ target: { kind: "drop", base: ordersDesign }, edits: [] });
  await userEvent.click(within(dialog).getByRole("button", { name: "Drop orders" }));
  expect(await screen.findByText("Dropped orders.")).toBeTruthy();
  expect(callsTo("apply_design").slice(-1)[0].pass).toBeNull();
  await waitFor(() => expect(screen.queryByRole("tab", { name: /^orders/ })).toBeNull());
  await waitFor(() => expect(callsTo("list_objects").length).toBeGreaterThan(listsBefore));
  expect(callsTo("list_objects").slice(listsBefore).every((a) => a.id === "c2")).toBe(true);
  await waitFor(() =>
    expect(callsTo("forget_recent")).toEqual([{ connectionId: "c2", path: { database: "shop", schema: null, name: "orders" } }]),
  );
});

test("drop_from_the_designer_strip_asks_the_same_way", async () => {
  await openOrders(dropRoutes);
  await userEvent.click(designButton());
  await screen.findByRole("tab", { name: "Columns 2" });
  await userEvent.click(screen.getByRole("button", { name: "Drop table orders" }));
  const dialog = await screen.findByRole("dialog", { name: "Drop orders?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Drop orders?" })).toBeNull());
  expect(callsTo("apply_design")).toHaveLength(0);
  expect(screen.getByRole("tab", { name: "orders design", selected: true })).toBeTruthy();
});

test("production_drop_opens_confirm_run_and_applies_with_the_pass", async () => {
  const prod = { ...shopMy, name: "freight-prod", production: true };
  const ask = {
    kind: "needsConfirmation",
    connection: "freight-prod",
    database: "shop",
    statements: [{ text: DROP, class: "write" }],
    writes: 1,
  };
  workspaceRoutes({
    ...ordersRoutes(prod),
    ...dropRoutes,
    plan_design: () => dropPlan(ask),
    confirm_design: () => "pass-1",
  });
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open freight-prod" }));
  await screen.findByRole("treeitem", { name: "orders" });
  await dropFromTree();
  const dialog = await screen.findByRole("dialog", { name: "Drop on freight-prod · shop" });
  expect(within(dialog).getByText("Dropping orders deletes its 1,204 rows.")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Drop on freight-prod" }));
  await waitFor(() => expect(callsTo("apply_design")).toHaveLength(1));
  expect(callsTo("confirm_design")).toHaveLength(1);
  expect(callsTo("apply_design")[0].pass).toBe("pass-1");
  expect(await screen.findByText("Dropped orders.")).toBeTruthy();
});

test("read_only_shows_neither_new_table_nor_drop_table", async () => {
  const ro = { ...shopMy, name: "shop-ro", readOnly: true };
  workspaceRoutes({ ...ordersRoutes(ro), ...dropRoutes });
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open shop-ro" }));
  await screen.findByRole("treeitem", { name: "orders" });
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: "shop" }));
  const dbMenu = screen.getByRole("menu", { name: "shop" });
  expect(within(dbMenu).queryByRole("menuitem", { name: "New table..." })).toBeNull();
  await userEvent.keyboard("{Escape}");
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: "orders" }));
  const menu = screen.getByRole("menu", { name: "orders" });
  expect(within(menu).getByRole("menuitem", { name: "Design table" })).toBeTruthy();
  expect(within(menu).queryByRole("menuitem", { name: "Drop table..." })).toBeNull();
});

// ---- Refresh after Apply and the leave asks (step 5c, Task 11) ----

const ordersPageWide = {
  ...ordersPage,
  columns: [...ordersPage.columns, { name: "total", typeName: "int", isPrimaryKey: false }],
  rows: [[...ordersPage.rows[0], { t: "number", value: "7" }]],
};
const okPlan = {
  plan: {
    statements: ["ALTER TABLE `orders` MODIFY `status` varchar(32)"],
    warnings: [],
    mode: { kind: "atomic" },
    before: 0,
    after: 0,
    checks: [],
    foreignKeys: null,
  },
  verdict: { kind: "ok" },
};
const designPane = () => document.querySelector(".work-pane:not([hidden]) .design-view") as HTMLElement;
const designCell = (name: string, field: string) => {
  const rows = [...designPane().querySelectorAll("tbody tr")];
  const row = rows.find((r) => r.querySelector('td[data-field="name"]')?.textContent === name) as HTMLElement;
  return row.querySelector(`td[data-field="${field}"]`) as HTMLElement;
};
const designApply = () => within(designPane()).getByRole("button", { name: /^Apply/ }) as HTMLButtonElement;

/** Opens orders' design tab (beside the grid tab) and changes status's type. */
async function changeStatusInDesign() {
  await userEvent.click(designButton());
  await screen.findByRole("tab", { name: "Columns 2" });
  fireEvent.doubleClick(designCell("status", "type"));
  const box = within(designPane()).getByRole("combobox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "varchar(32)" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await screen.findByRole("tab", { name: "orders design, unsaved changes" });
  await waitFor(() => expect(designApply().disabled).toBe(false));
}

type Routes = Record<string, (a: Record<string, unknown>) => unknown>;
const applyRoutes = (over: Routes = {}): Routes => {
  let applied = false;
  return {
    table_design: () => ordersDesign,
    plan_design: () => okPlan,
    apply_design: () => {
      applied = true;
      return { kind: "done", ran: 1 };
    },
    fetch_page: () => (applied ? ordersPageWide : ordersPage),
    ...over,
  };
};

test("after_apply_a_grid_tab_with_pending_edits_asks_and_discard_reloads_it", async () => {
  const invalidate = vi.spyOn(appLang().schemas, "invalidate");
  try {
    await openOrdersWithAnEdit(applyRoutes());
    await changeStatusInDesign();
    const fetches = callsTo("fetch_page").length;
    const lists = callsTo("list_objects").length;
    await userEvent.click(designApply());
    // The grid of the same table has Pending Edits: it is asked about before it reloads.
    expect(await screen.findByText("Save changes to orders?")).toBeTruthy();
    await userEvent.click(inAsk("Discard"));
    await waitFor(() => expect(callsTo("fetch_page").length).toBeGreaterThan(fetches));
    expect((callsTo("fetch_page").slice(-1)[0].request as { page: number }).page).toBe(0);
    expect(await screen.findByRole("columnheader", { name: /total/ })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Pending Edits" })).toBeNull();
    expect(invalidate).toHaveBeenCalledWith("c2", "shop");
    await waitFor(() => expect(callsTo("list_objects").length).toBeGreaterThan(lists));
  } finally {
    invalidate.mockRestore();
  }
});

test("after_apply_cancel_keeps_the_grid_and_says_it_changed", async () => {
  await openOrdersWithAnEdit(applyRoutes());
  await changeStatusInDesign();
  const fetches = callsTo("fetch_page").length;
  await userEvent.click(designApply());
  await screen.findByText("Save changes to orders?");
  await userEvent.click(inAsk("Cancel"));
  expect(await screen.findByText("orders changed. Reload to see its new columns.")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Pending Edits" })).toBeTruthy();
  expect(callsTo("fetch_page")).toHaveLength(fetches);
});

test("after_apply_a_clean_grid_reloads_without_asking", async () => {
  await openOrders(applyRoutes());
  await changeStatusInDesign();
  const fetches = callsTo("fetch_page").length;
  await userEvent.click(designApply());
  await waitFor(() => expect(callsTo("fetch_page").length).toBeGreaterThan(fetches));
  expect(screen.queryByText("Save changes to orders?")).toBeNull();
});

test("after_apply_the_tree_reloads_the_applied_connection_only_while_another_branch_is_focused", async () => {
  const archive = { ...shopMy, id: "c4", name: "KFC Archive", database: "archive" };
  await openOrders({
    ...applyRoutes(),
    list_connections: () => [shopMy, archive],
    list_databases: ({ id }) => (id === "c4" ? ["archive"] : ["shop"]),
  });
  await changeStatusInDesign();
  await userEvent.click(await screen.findByRole("button", { name: "Open KFC Archive" }));
  const archiveRow = await screen.findByRole("treeitem", { name: "archive" });
  await waitFor(() => expect(callsTo("list_objects").some((a) => a.id === "c4")).toBe(true));
  archiveRow.focus();
  const lists = callsTo("list_objects").length;
  await userEvent.click(designApply());
  await waitFor(() => expect(callsTo("list_objects").length).toBeGreaterThan(lists));
  expect(callsTo("list_objects").slice(lists).every((a) => a.id === "c2")).toBe(true);
});

test("a_created_table_is_revealed_in_the_tree", async () => {
  let created = false;
  await openOrders({
    ...applyRoutes(),
    plan_design: () => ({ ...okPlan, plan: { ...okPlan.plan, statements: ["CREATE TABLE `invoices` (`id` int)"] } }),
    apply_design: () => {
      created = true;
      return { kind: "done", ran: 1 };
    },
    list_objects: () => [{ kind: "table", name: "orders" }, ...(created ? [{ kind: "table", name: "invoices" }] : [])],
  });
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: "shop" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "New table..." }));
  await screen.findByRole("tab", { name: "Columns 1" });
  fireEvent.doubleClick(designCell("", "name"));
  let box = within(designPane()).getByRole("textbox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "id" } });
  fireEvent.keyDown(box, { key: "Enter" });
  fireEvent.doubleClick(designCell("id", "type"));
  box = within(designPane()).getByRole("combobox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "int" } });
  fireEvent.keyDown(box, { key: "Enter" });
  fireEvent.change(within(designPane()).getByRole("textbox", { name: "Table name" }), { target: { value: "invoices" } });
  await waitFor(() => expect(designApply().disabled).toBe(false));
  // Apply runs what the preview shows (S13 I2).
  await within(designPane()).findByLabelText("SQL Apply runs");
  await userEvent.click(designApply());
  const row = await screen.findByRole("treeitem", { name: "invoices" });
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(await screen.findByRole("tab", { name: /^invoices design/ })).toBeTruthy();
});

test("closing_an_unapplied_design_asks_apply_and_a_failed_apply_keeps_the_tab", async () => {
  await openOrders(
    applyRoutes({
      apply_design: () => {
        throw { kind: "designFailed", message: { statement: 0, ran: 0, total: 1, message: "Unknown column 'status'" } };
      },
    }),
  );
  await changeStatusInDesign();
  const strip = screen.getByRole("tablist", { name: "Open tabs" });
  await userEvent.click(within(strip).getByRole("button", { name: "Close orders design" }));
  expect(await screen.findByText("Apply changes to orders?")).toBeTruthy();
  const dialog = screen.getByRole("dialog");
  expect(dialog.querySelector(".dialog-body")?.textContent).toBe(
    "You have 1 unapplied change to orders on KFC Shop. Closing the tab without applying loses it.",
  );
  expect(within(dialog).queryByRole("button", { name: /^Save/ })).toBeNull();
  await userEvent.click(inAsk("Apply"));
  await waitFor(() => expect(callsTo("apply_design")).toHaveLength(1));
  expect(await screen.findByText("Nothing was changed. Statement 1 failed: Unknown column 'status'")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "orders design, unsaved changes" })).toBeTruthy();
});

test("window_close_is_prevented_while_a_design_is_unapplied", async () => {
  await openOrders(applyRoutes());
  await changeStatusInDesign();
  await waitFor(() => expect(closeWindow.handler).not.toBeNull());
  closeWindow.destroy.mockClear();
  const event = { preventDefault: vi.fn() };
  const done = closeWindow.handler!(event);
  expect(event.preventDefault).toHaveBeenCalled();
  await screen.findByText("Apply changes to orders?");
  await userEvent.click(inAsk("Cancel"));
  await done;
  expect(closeWindow.destroy).not.toHaveBeenCalled();
});

/** A plan_design held until the test releases it, so Apply stays running. */
function heldPlanRoute() {
  // The preview plans too, so every held call is kept and released together.
  const held: (() => void)[] = [];
  const gate = { hold: false, release: () => held.splice(0).forEach((go) => go()) };
  const plan_design = () => {
    if (!gate.hold) return okPlan;
    return new Promise((resolve) => held.push(() => resolve(okPlan)));
  };
  return { gate, plan_design };
}

test("a_refused_discard_while_apply_runs_keeps_the_tab_the_group_and_the_connection", async () => {
  const { gate, plan_design } = heldPlanRoute();
  await openOrders(applyRoutes({ plan_design, close_connection: () => null }));
  await changeStatusInDesign();
  gate.hold = true;
  await userEvent.click(designApply());
  await waitFor(() => expect(designApply().textContent).toContain("Applying"));
  const strip = screen.getByRole("tablist", { name: "Open tabs" });
  const gone = () => waitFor(() => expect(screen.queryByText("Apply changes to orders?")).toBeNull());
  // Closing the tab.
  await userEvent.click(within(strip).getByRole("button", { name: "Close orders design" }));
  await screen.findByText("Apply changes to orders?");
  await userEvent.click(inAsk("Discard"));
  await gone();
  expect(screen.getByRole("tab", { name: "orders design, unsaved changes" })).toBeTruthy();
  // Switching Group.
  await userEvent.click(screen.getByRole("button", { name: "Switch Group, current KFC" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Ungrouped" }));
  await screen.findByText("Apply changes to orders?");
  await userEvent.click(inAsk("Discard"));
  await gone();
  expect(screen.getByRole("button", { name: "Switch Group, current KFC" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "orders design, unsaved changes" })).toBeTruthy();
  // Closing the Connection.
  await userEvent.click(screen.getByRole("button", { name: "Close KFC Shop" }));
  await screen.findByText("Apply changes to orders?");
  await userEvent.click(inAsk("Discard"));
  await gone();
  expect(callsTo("close_connection")).toHaveLength(0);
  expect(screen.getByRole("tab", { name: "orders design, unsaved changes" })).toBeTruthy();
  gate.release();
  await waitFor(() => expect(callsTo("apply_design")).toHaveLength(1));
}, LOAD_TIMEOUT);
