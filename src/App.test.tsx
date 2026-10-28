import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { mockEditorDom } from "./test/editor";
import { LOAD_TIMEOUT, patientFile } from "./test/load";
import { mockReactFlowDom } from "./test/reactFlow";
import { callsTo, routeInvoke } from "./test/invoke";
import { fakePreview } from "./test/aiPreview";
import { aiStream, delta, done } from "./test/aiStream";
import { summaryOf, turnViewOf, viewOf } from "./test/aiThreads";
import { withTurn } from "./api/client";
import { sha256Hex } from "./assistant/sha256";
import { clearAllSteps } from "./assistant/recentSteps";
import type { AiThread, AppendTurn, AskRequest, LastWork, VisualQuery, WorkTag } from "./api/types";
import { EditorView } from "@codemirror/view";
import App from "./App";
import { appLang } from "./lang/appLang";
import appCssRaw from "./styles/app.css?raw";
import guideCssRaw from "./styles/guide.css?raw";
import { treeName } from "./test/treeName";

/** A stylesheet's top-level rules (comments dropped), enough to read one rule's body. */
function appCssRules(css: string = appCssRaw): { selector: string; body: string }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return Array.from(text.matchAll(/([^{}]+)\{([^{}]*)\}/g), (m) => ({ selector: m[1].trim(), body: m[2] }));
}

/** The tab strip's New query button (the feature bar has its own, item 16). */
const stripNew = () => screen.getAllByRole("button", { name: "New query" }).find((b) => b.closest(".tab-strip")) ?? (() => { throw new Error("no New query in the tab strip"); })();


vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
// The Import tab's Browse... picks this file.
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => "C:\\data\\orders.csv"), save: vi.fn(async () => null) }));
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
});

// Each start is its own test: three full app starts in one test passed the time limit on a busy machine.
const kfcOnly = [{ id: "g1", name: "KFC", color: "red" }];

test("startup_opens_home_in_the_last_group_when_it_restores_no_tabs", async () => {
  const groups = kfcOnly;
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
});

test("startup_falls_back_to_home_when_the_last_group_no_longer_exists", async () => {
  const groups = kfcOnly;
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
  await userEvent.click(stripNew());
  expect(await screen.findByRole("tab", { name: "Query 2", selected: true })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Close Query 2" }));
  expect(await screen.findByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Query 2" })).toBeNull();
});

test("ctrl_shift_t_reopens_closed_tabs_last_first_and_repeatedly", async () => {
  workspaceRoutes();
  render(<App />);
  await screen.findByRole("button", { name: "Switch Group, current KFC" });
  await closeHome();
  await userEvent.keyboard("{Control>}t{/Control}");
  await userEvent.click(stripNew());
  expect(await screen.findByRole("tab", { name: "Query 2", selected: true })).toBeTruthy();
  await userEvent.keyboard("{Control>}w{/Control}");
  await userEvent.keyboard("{Control>}w{/Control}");
  await waitFor(() => expect(screen.queryByRole("tab", { name: /Query/ })).toBeNull());
  await userEvent.keyboard("{Control>}{Shift>}t{/Shift}{/Control}");
  expect(await screen.findByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
  await userEvent.keyboard("{Control>}{Shift>}t{/Shift}{/Control}");
  expect(await screen.findByRole("tab", { name: "Query 2", selected: true })).toBeTruthy();
  // The stack is empty now: nothing more opens.
  await userEvent.keyboard("{Control>}{Shift>}t{/Shift}{/Control}");
  expect(tabNames()).toEqual(["Query 1", "Query 2"]);
});

test("ctrl_shift_t_reopens_a_table_tab_and_loads_its_rows_again", async () => {
  recentRoutes();
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open KFC Shop" }));
  await userEvent.click(await screen.findByRole("treeitem", { name: treeName("orders") }));
  await waitFor(() => expect(document.querySelector('tr[data-row="0"]')).not.toBeNull());
  const pages = callsTo("fetch_page").length;
  await userEvent.click(tabClose());
  await waitFor(() => expect(screen.queryByRole("tab", { name: /orders/ })).toBeNull());
  await userEvent.keyboard("{Control>}{Shift>}t{/Shift}{/Control}");
  expect(await screen.findByRole("tab", { name: /orders/, selected: true })).toBeTruthy();
  await waitFor(() => expect(callsTo("fetch_page").length).toBeGreaterThan(pages));
  await waitFor(() => expect(document.querySelector('tr[data-row="0"]')).not.toBeNull());
});

test("ctrl_shift_t_skips_a_table_that_is_gone_with_a_short_note", async () => {
  let listing = [{ kind: "table", name: "orders" }];
  recentRoutes({ list_objects: () => listing });
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open KFC Shop" }));
  await userEvent.click(await screen.findByRole("treeitem", { name: treeName("orders") }));
  await waitFor(() => expect(document.querySelector('tr[data-row="0"]')).not.toBeNull());
  await userEvent.click(tabClose());
  await waitFor(() => expect(screen.queryByRole("tab", { name: /orders/ })).toBeNull());
  listing = [];
  await userEvent.keyboard("{Control>}{Shift>}t{/Shift}{/Control}");
  expect(await screen.findByText("orders is gone, so it was not reopened.")).toBeTruthy();
  expect(screen.queryByRole("tab", { name: /orders/ })).toBeNull();
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

test("ctrl_n_is_new_connection_with_the_ask_panel_open_and_focus_in_the_tree", async () => {
  workspaceRoutes({ ai_settings: () => { throw { kind: "storage", message: "no" }; }, list_ai_threads: () => [] });
  render(<App />);
  await screen.findByRole("button", { name: "Switch Group, current KFC" });
  await closeHome();
  await userEvent.keyboard("{Control>}{Alt>}i{/Alt}{/Control}");
  expect(await screen.findByRole("complementary", { name: "Ask" })).toBeTruthy();
  (await screen.findByRole("tree")).querySelector<HTMLElement>('[role="treeitem"]')?.focus();
  expect(document.activeElement?.closest("[aria-label='Ask']")).toBeNull();
  await userEvent.keyboard("{Control>}n{/Control}");
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
  const row = await screen.findByRole("treeitem", { name: treeName("KFC Postgres, last connect failed") });
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
  const sections = await screen.findByRole("navigation", { name: "Settings sections" });
  // It opens on Appearance, one section per nav item.
  expect(within(sections).getByRole("button", { name: "Appearance" }).getAttribute("aria-current")).toBe("page");
  await userEvent.click(within(sections).getByRole("button", { name: "AI assistant" }));
  expect(await screen.findByLabelText("Use different settings for KFC")).toBeTruthy();
  // Nothing to save or cancel (D6): the tab just closes.
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Close Settings" }));
  expect(screen.queryByLabelText("Use different settings for KFC")).toBeNull();
  expect(screen.queryByRole("tab", { name: "Settings" })).toBeNull();
  expect(screen.getByText("No Connections in KFC yet.")).toBeTruthy();

  expect(within(document.querySelector("footer.app-status") as HTMLElement).queryByRole("button", { name: "Settings" })).toBeNull();
  // Closed, it opens on Appearance again.
  await userEvent.keyboard("{Control>},{/Control}");
  const again = await screen.findByRole("navigation", { name: "Settings sections" });
  expect(within(again).getByRole("button", { name: "Appearance" }).getAttribute("aria-current")).toBe("page");
  await userEvent.click(screen.getByRole("button", { name: "Close Settings" }));
  expect(screen.queryByRole("navigation", { name: "Settings sections" })).toBeNull();
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
  await userEvent.click(await screen.findByRole("treeitem", { name: treeName("orders") }));
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

test("s3_close_other_tabs_asks_for_each_tab_with_pending_edits_and_a_cancel_stops_the_rest", async () => {
  await openOrdersWithAnEdit();
  await userEvent.keyboard("{Control>}t{/Control}");
  expect(await screen.findByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
  await userEvent.keyboard("{Control>}t{/Control}");
  expect(await screen.findByRole("tab", { name: "Query 2", selected: true })).toBeTruthy();
  // Close other tabs on Query 1: orders (with Pending Edits) asks first; Cancel keeps it and stops the rest.
  fireEvent.contextMenu(screen.getByRole("tab", { name: "Query 1" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Close other tabs" }));
  await screen.findByText("Save changes to orders?");
  await userEvent.click(inAsk("Cancel"));
  expect(screen.getByRole("tab", { name: /orders/ })).toBeTruthy();
  // The tab the ask was about is shown, and the right-clicked tab was not forced on top by the Cancel.
  expect(screen.getByRole("tab", { name: /orders/, selected: true })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Query 2" })).toBeTruthy();
  // Again, and Discard: every other tab closes and Query 1 stays, shown.
  fireEvent.contextMenu(screen.getByRole("tab", { name: "Query 1" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Close other tabs" }));
  await screen.findByText("Save changes to orders?");
  await userEvent.click(inAsk("Discard"));
  await waitFor(() => expect(tabNames()).toEqual(["Query 1"]));
  expect(screen.getByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
  // The closed tabs wait for Reopen closed tab.
  await userEvent.keyboard("{Control>}{Shift>}t{/Shift}{/Control}");
  expect(await screen.findByRole("tab", { name: "Query 2" })).toBeTruthy();
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
  expect(screen.getByRole("treeitem", { name: treeName("KFC Shop, open") })).toBeTruthy();
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
  const reports = await screen.findByRole("treeitem", { name: treeName("reports") });
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
  const reports = await screen.findByRole("treeitem", { name: treeName("reports") });
  reports.focus();
  await waitFor(() => expect(bar.textContent).toContain("KFC Reporting"));
  await userEvent.keyboard("{Control>}{Alt>}1{/Alt}{/Control}");
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
  (await screen.findByRole("treeitem", { name: treeName("reports") })).focus();
  await waitFor(() => expect(bar.textContent).toContain("KFC Reporting"));
  await userEvent.keyboard("{Control>}{Alt>}1{/Alt}{/Control}");
  await waitFor(() => expect(bar.textContent).not.toContain("KFC Reporting"));
  await userEvent.keyboard("{Control>}{Alt>}2{/Alt}{/Control}");
  expect(await screen.findByRole("button", { name: "Switch Group, current KFC" })).toBeTruthy();
  await userEvent.click(await screen.findByRole("button", { name: "More actions for KFC Postgres" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "New query" }));
  expect(await screen.findByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
  await waitFor(() => expect(bar.textContent).toContain("KFC Postgres"));
  (await screen.findByRole("treeitem", { name: treeName("reports") })).focus();
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

test("item_12_opening_a_table_adds_nothing_to_recent", async () => {
  recentRoutes();
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open KFC Shop" }));
  // The default database opens with its Tables when the Connection opens.
  await userEvent.click(await screen.findByRole("treeitem", { name: treeName("orders") }));
  await waitFor(() => expect(document.querySelector('tr[data-row="0"]')).not.toBeNull());
  // Browsing is not history: only saving data or applying a design lists the table (item 12).
  expect(callsTo("record_recent")).toEqual([]);
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
  expect(stripNew()).toBeTruthy();
  await userEvent.click(within(strip()).getByRole("button", { name: "Close Home" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Home" })).toBeNull());
  expect(screen.queryByRole("tab", { name: "Home" })).toBeNull();
  // The place shows: its sidebar and the empty work area.
  expect(screen.getByRole("complementary", { name: "Ungrouped Connections" })).toBeTruthy();
  expect(stripNew()).toBeTruthy();
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
  // Groups by name: Acme is Ctrl+Alt+1, KFC Ctrl+Alt+2, then Ungrouped Ctrl+Alt+3.
  await userEvent.keyboard("{Control>}{Alt>}2{/Alt}{/Control}");
  expect(await screen.findByRole("button", { name: "Switch Group, current KFC" })).toBeTruthy();
  await waitFor(() => expect(callsTo("set_last_group")).toEqual([{ id: "g1" }]));
  await userEvent.keyboard("{Control>}{Alt>}3{/Alt}{/Control}");
  expect(await screen.findByRole("button", { name: "Switch Group, current Ungrouped" })).toBeTruthy();
  await userEvent.keyboard("{Control>}{Alt>}1{/Alt}{/Control}");
  expect(await screen.findByRole("button", { name: "Switch Group, current Acme" })).toBeTruthy();
});

test("ctrl_2_during_a_sidebar_rename_cancels_it_so_enter_renames_nothing", async () => {
  shellRoutes({ last_group: () => "g2", save_group: () => ({ ...kfc, name: "wrong" }) });
  render(<App />);
  await screen.findByRole("button", { name: "Switch Group, current Acme" });
  await closeHome();
  const side = () => screen.getByRole("complementary", { name: /Connections$/ });
  await userEvent.dblClick(within(side()).getByRole("heading", { name: "Acme" }));
  await userEvent.keyboard("Acme Prod");
  await userEvent.keyboard("{Control>}{Alt>}2{/Alt}{/Control}");
  expect(await screen.findByRole("button", { name: "Switch Group, current KFC" })).toBeTruthy();
  await waitFor(() => expect(within(side()).queryByRole("textbox")).toBeNull());
  await userEvent.keyboard("{Enter}");
  expect(callsTo("save_group")).toEqual([]);
  expect(within(side()).getByRole("heading", { name: "KFC" })).toBeTruthy();
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
  await userEvent.keyboard("{Control>}{Alt>}2{/Alt}{/Control}");
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
  await userEvent.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "AI assistant" }));
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
  expect(stripNew()).toBeTruthy();
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

test("reopening_settings_switches_to_it_and_keeps_its_page", async () => {
  shellRoutes();
  render(<App />);
  await screen.findByRole("tab", { name: "Home" });
  await userEvent.keyboard("{Control>},{/Control}");
  const sections = await screen.findByRole("navigation", { name: "Settings sections" });
  const current = () => within(sections).getByRole("button", { current: "page" }).textContent;
  expect(current()).toBe("Appearance");
  await userEvent.click(within(sections).getByRole("button", { name: "AI assistant" }));
  await userEvent.click(within(sections).getByRole("button", { name: "Privacy" }));
  expect(current()).toBe("Privacy");
  // Away and back with Ctrl+, and the status bar gear: the same tab, on the same page.
  await userEvent.click(screen.getByRole("tab", { name: "Home" }));
  await userEvent.keyboard("{Control>},{/Control}");
  expect(await screen.findByRole("tab", { name: "Settings", selected: true })).toBeTruthy();
  expect(current()).toBe("Privacy");
  await userEvent.click(screen.getByRole("tab", { name: "Home" }));
  await userEvent.click(within(document.querySelector("footer.app-status") as HTMLElement).getByRole("button", { name: /^Settings/ }));
  expect(await screen.findByRole("tab", { name: "Settings", selected: true })).toBeTruthy();
  expect(current()).toBe("Privacy");
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

test("close_other_tabs_stops_at_a_cancel_on_the_schema_models_ask_and_no_two_asks_overlap", async () => {
  shellRoutes({ last_group: () => null, list_connections: () => [{ ...pg, groupId: null }] });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Open Ungrouped" }));
  await userEvent.click(await screen.findByRole("button", { name: `More actions for ${pg.name}` }));
  await userEvent.click(screen.getByRole("menuitem", { name: "New Schema Model..." }));
  await userEvent.click(screen.getByRole("radio", { name: /Blank model/ }));
  await userEvent.click(screen.getByRole("button", { name: /^Create blank model/ }));
  await screen.findByRole("tab", { name: "untitled.dbml", selected: true });
  await userEvent.keyboard("{Control>},{/Control}");
  await screen.findByRole("tab", { name: "Settings", selected: true });
  await userEvent.keyboard("{Control>}t{/Control}");
  await screen.findByRole("tab", { name: "Query 1", selected: true });
  fireEvent.contextMenu(screen.getByRole("tab", { name: "Query 1" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Close other tabs" }));
  expect(await screen.findByText("Save changes to schema?")).toBeTruthy();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  // The Cancel stops the rest: the tabs after the model stay.
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("tab", { name: "untitled.dbml" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Settings" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Query 1" })).toBeTruthy();
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
  await userEvent.keyboard("{Control>}{Alt>}2{/Alt}{/Control}");
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
  await userEvent.click(await screen.findByRole("treeitem", { name: treeName("shop") }));
  await userEvent.click(await screen.findByRole("treeitem", { name: treeName("Procedures") }));
  await userEvent.click(await screen.findByRole("treeitem", { name: treeName("close_day") }));
  expect(await screen.findByText("CREATE PROCEDURE close_day() BEGIN END")).toBeTruthy();
  expect(callsTo("object_definition")).toEqual([
    { id: "c2", kind: "procedure", path: { database: "shop", schema: null, name: "close_day" } },
  ]);
  await userEvent.click(screen.getByRole("treeitem", { name: treeName("Triggers") }));
  await userEvent.click(await screen.findByRole("treeitem", { name: treeName("orders_audit") }));
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
  await userEvent.click(await screen.findByRole("treeitem", { name: treeName("orders") }));
  const grid = await screen.findByRole("region", { name: "Data of orders" });
  expect(within(grid).getByRole("heading", { level: 2 }).textContent).toBe("public.orders");

  // The same name in another schema is another object: a fresh grid with its own request.
  await userEvent.click(screen.getByRole("treeitem", { name: treeName("sales") }));
  await waitFor(() => expect(screen.getAllByRole("treeitem", { name: treeName("orders") })).toHaveLength(2));
  await userEvent.click(screen.getAllByRole("treeitem", { name: treeName("orders") })[1]);
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

test("an_answer_goes_into_the_editor_through_the_diff_in_the_editor_and_runs_nothing", async () => {
  const draft = [
    { id: "d1", name: "Late deliveries", text: "SELECT 1", connectionId: "c1", database: "kfc_shop", savedId: null, savedText: null },
  ];
  const answer = "Try:\n```sql\nUPDATE orders SET status = 'x'\n```";
  workspaceRoutes({
    list_connections: () => [{ ...pg, production: true }],
    load_query_tabs: ({ place }) => (place === "group:g1" ? JSON.stringify({ version: 1, tabs: draft }) : null),
    ai_settings: aiSettingsReply,
    list_ai_threads: () => [{ id: "t1", place: "group:g1", title: "fix", updatedAt: 2, messages: 2, topics: 1 }],
    get_ai_thread: () => ({
      thread: {
        id: "t1",
        place: "group:g1",
        title: "fix",
        updatedAt: 2,
        messages: [
          { role: "user", text: "fix", context: [], at: 1 },
          { role: "assistant", text: answer, context: [], at: 2 },
        ],
      },
      topics: [],
      compactions: [],
    }),
    save_ai_thread: () => null,
    ai_append_turn: (a) => ({ threadId: (a.turn as { threadId: string }).threadId, place: "group:g1", title: "fix", updatedAt: 3, messages: (a.turn as { messages: unknown[] }).messages, keptFrom: null, messageCount: 4, topics: [], compactions: [] }),
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
  // No Run on an answer (R6.1): it reaches the database only from the editor.
  expect(within(panel).queryByRole("button", { name: "Run" })).toBeNull();
  // A saved answer without the Core's SQL check goes in only commented out, and has no Open in new tab.
  await userEvent.click(await within(panel).findByRole("button", { name: "Insert commented out" }));
  expect(within(panel).queryByRole("button", { name: "Open in new tab" })).toBeNull();
  // The diff is in the editor itself, with a Keep and Discard bar; the write goes below, commented out (A2, A3).
  const bar = await waitFor(() => {
    const b = document.querySelector<HTMLElement>(".cm-suggest-bar");
    expect(b).toBeTruthy();
    return b!;
  });
  expect(bar.textContent).toContain("Insert adds line 3 of Late deliveries, below the current statement");
  // The added lines show apart from the text, which is unchanged until Keep.
  expect(Array.from(document.querySelectorAll(".cm-suggest-add")).map((l) => l.textContent)).toEqual(["", "-- UPDATE orders SET status = 'x';"]);
  expect(Array.from(document.querySelectorAll(".cm-line")).map((l) => l.textContent)).toEqual(["SELECT 1"]);
  expect(document.querySelector<HTMLButtonElement>(".editor-header-run")?.disabled).toBe(true);
  await userEvent.click(within(bar).getByRole("button", { name: /^Keep, commented out/ }));
  expect(await within(panel).findByText("Kept in the editor")).toBeTruthy();
  expect(document.querySelector(".cm-suggest-bar")).toBeNull();
  await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("-- UPDATE orders SET status = 'x';"));
  expect(callsTo("prepare_run")).toHaveLength(0);
  expect(callsTo("execute_sql")).toHaveLength(0);
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
    { name: "id", typeSql: "int", nullable: false, defaultSql: null, increment: { kind: "autoIncrement" }, comment: null, generated: false, mysql: null, sqliteAutoincrement: false, collation: null, advanced: false, identityAlways: false },
    { name: "status", typeSql: "varchar(16)", nullable: true, defaultSql: null, increment: { kind: "none" }, comment: null, generated: false, mysql: null, sqliteAutoincrement: false, collation: null, advanced: false, identityAlways: false },
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
  await userEvent.click(await screen.findByRole("treeitem", { name: treeName("orders") }));
  await screen.findByRole("tab", { name: "orders", selected: true });
}
const designButton = () =>
  within(document.querySelector(".work-pane:not([hidden]) .table-header") as HTMLElement).getByRole("button", { name: "Edit structure" });

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
  await userEvent.keyboard("{Control>}{Alt>}2{/Alt}{/Control}");
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
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: treeName("orders") }));
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
  await screen.findByRole("treeitem", { name: treeName("orders") });
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
  await screen.findByRole("treeitem", { name: treeName("orders") });
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: treeName("shop") }));
  const dbMenu = screen.getByRole("menu", { name: "shop" });
  expect(within(dbMenu).queryByRole("menuitem", { name: "New table..." })).toBeNull();
  await userEvent.keyboard("{Escape}");
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: treeName("orders") }));
  const menu = screen.getByRole("menu", { name: "orders" });
  expect(within(menu).getByRole("menuitem", { name: "Edit structure" })).toBeTruthy();
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
  // Apply runs only the plan the preview shows, so wait for the preview first.
  await within(designPane()).findByLabelText("SQL Apply runs", undefined, { timeout: LOAD_TIMEOUT });
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
  const archiveRow = await screen.findByRole("treeitem", { name: treeName("archive") });
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
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: treeName("shop") }));
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
  const row = await screen.findByRole("treeitem", { name: treeName("invoices") });
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

test("new_visual_query_from_the_connection_menu_opens_on_that_connection_and_comes_back_with_the_drafts", async () => {
  const shopSchema = { searchPath: ["public"], tables: [], fks: [] };
  workspaceRoutes({ sql_schema: () => shopSchema, visual_query_sql: () => ({ query: null, problems: [] }) });
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "More actions for KFC Postgres" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "New Visual Query" }));
  expect(await screen.findByRole("tab", { name: "New Visual Query", selected: true })).toBeTruthy();
  // A closed Connection opens first, as New query does.
  await waitFor(() => expect(callsTo("open_connection")).toEqual([{ id: "c1" }]));
  const bar = await screen.findByRole("toolbar", { name: "Visual Query" });
  expect(within(bar).getByRole("button", { name: /KFC Postgres/ })).toBeTruthy();
  let saved = "";
  await waitFor(
    () => {
      const last = callsTo("save_query_tabs").slice(-1)[0];
      const visual = JSON.parse((last?.json as string) ?? "{}").visual ?? [];
      expect(visual).toHaveLength(1);
      expect(visual[0]).toMatchObject({ name: "New Visual Query", connectionId: "c1", database: "kfc_shop", model: { database: "kfc_shop", dialect: "postgres" } });
      saved = last!.json as string;
    },
    { timeout: 3000 },
  );
  cleanup();

  workspaceRoutes({
    sql_schema: () => shopSchema,
    visual_query_sql: () => ({ query: null, problems: [] }),
    load_query_tabs: ({ place }) => (place === "group:g1" ? saved : null),
  });
  render(<App />);
  expect(await screen.findByRole("tab", { name: "New Visual Query", selected: true })).toBeTruthy();
  expect(await screen.findByRole("toolbar", { name: "Visual Query" })).toBeTruthy();
});

test("restored_drafts_keep_the_strip_order_of_query_and_visual_tabs", async () => {
  const q = { id: "d1", name: "Late deliveries", text: "SELECT 1", connectionId: "c1", database: "kfc_shop", savedId: null, savedText: null };
  const model = { version: 1, database: "kfc_shop", dialect: "postgres", tables: [], joins: [], columns: [], filters: [], groupBy: { kind: "auto" }, orderBy: [], limit: null, distinct: false };
  const v = { id: "v1", name: "New Visual Query", connectionId: "c1", database: "kfc_shop", model, savedId: null, savedJson: null };
  workspaceRoutes({
    sql_schema: () => ({ searchPath: ["public"], tables: [], fks: [] }),
    visual_query_sql: () => ({ query: null, problems: [] }),
    load_query_tabs: ({ place }) =>
      place === "group:g1" ? JSON.stringify({ version: 1, tabs: [q], visual: [v], order: ["visual:v1", "query:d1"] }) : null,
  });
  render(<App />);
  await screen.findByRole("tab", { name: "Late deliveries" });
  const strip = screen.getByRole("tablist", { name: "Open tabs" });
  expect(within(strip).getAllByRole("tab").map((t) => t.getAttribute("aria-label"))).toEqual(["New Visual Query", "Late deliveries"]);
});

test("open_in_editor_makes_a_plain_query_tab_with_the_generated_sql_and_leaves_the_visual_query", async () => {
  const model = {
    version: 1,
    database: "kfc_shop",
    dialect: "postgres",
    tables: [{ id: "t1", schema: "public", name: "orders", alias: "o", x: 48, y: 48 }],
    joins: [],
    columns: [{ table: "t1", column: "id", alias: null, aggregate: null }],
    filters: [],
    groupBy: { kind: "auto" },
    orderBy: [],
    limit: null,
    distinct: false,
  };
  const v = { id: "v1", name: "Late deliveries", connectionId: "c1", database: "kfc_shop", model, savedId: null, savedJson: null };
  const sql = "SELECT o.id\nFROM public.orders AS o";
  workspaceRoutes({
    sql_schema: () => ({ searchPath: ["public"], tables: [], fks: [] }),
    visual_query_sql: () => ({
      query: { sql, parts: [{ part: { kind: "select" }, fromLine: 1, toLine: 1 }], outputs: ["id"], warnings: [] },
      problems: [],
    }),
    load_query_tabs: ({ place }) => (place === "group:g1" ? JSON.stringify({ version: 1, tabs: [], visual: [v] }) : null),
  });
  render(<App />);
  expect(await screen.findByRole("tab", { name: "Late deliveries", selected: true })).toBeTruthy();
  // The SQL is a tab of the Visual Query's bottom panel (item 30).
  await userEvent.click(await screen.findByRole("tab", { name: "SQL" }));
  const pane = await screen.findByRole("region", { name: "SQL" });
  await waitFor(() => expect((within(pane).getByRole("button", { name: /Open in editor/ }) as HTMLButtonElement).disabled).toBe(false));
  await userEvent.keyboard("{Control>}{Shift>}e{/Shift}{/Control}");
  expect(await screen.findByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
  await waitFor(() => {
    const last = callsTo("save_query_tabs").slice(-1)[0];
    const saved = JSON.parse((last?.json as string) ?? "{}");
    expect(saved.tabs).toEqual([expect.objectContaining({ name: "Query 1", text: sql, connectionId: "c1", database: "kfc_shop", savedId: null })]);
    // Nothing links back: the Visual Query is as it was.
    expect(saved.visual).toEqual([expect.objectContaining({ id: "v1", name: "Late deliveries", model })]);
  });
  expect(screen.getByRole("tab", { name: "Late deliveries" })).toBeTruthy();
}, LOAD_TIMEOUT);

// ---------- Saved Visual Queries (Task 10) ----------

const vqModel = (database = "kfc_shop", version = 1) => ({
  version,
  database,
  dialect: "postgres",
  tables: [{ id: "t1", schema: "public", name: "orders", alias: "o", x: 48, y: 48 }],
  joins: [],
  columns: [{ table: "t1", column: "id", alias: null, aggregate: null }],
  filters: [],
  groupBy: { kind: "auto" },
  orderBy: [],
  limit: null,
  distinct: false,
});
const savedVq = (over: Record<string, unknown> = {}) => ({
  id: "sv1",
  name: "late orders by store",
  sql: "SELECT o.id\nFROM public.orders AS o",
  updatedAtMs: 1,
  connectionId: "c1",
  kind: "visual",
  visualJson: JSON.stringify(vqModel("kfc_reports")),
  ...over,
});
const vqRoutes = { sql_schema: () => ({ searchPath: ["public"], tables: [], fks: [] }), visual_query_sql: () => ({ query: null, problems: [] }) };

test("opening_a_saved_visual_query_opens_its_tab_on_its_connection_and_the_models_database", async () => {
  workspaceRoutes({ ...vqRoutes, list_saved_queries: () => [savedVq()], open_query_session: () => "s1" });
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("treeitem", { name: /^late orders by store/ }));
  expect(await screen.findByRole("tab", { name: "late orders by store", selected: true })).toBeTruthy();
  // Its Connection is closed: the canvas offers to open it.
  const banner = await screen.findByText("KFC Postgres is not open", { selector: ".vq-banner p" });
  await userEvent.click(within(banner.closest(".vq-banner") as HTMLElement).getByRole("button", { name: "Open KFC Postgres" }));
  await waitFor(() => expect(callsTo("open_connection")).toEqual([{ id: "c1" }]));
  // A run opens its session on the model's database.
  await waitFor(() => expect(callsTo("open_query_session")).toEqual([{ id: "c1", database: "kfc_reports" }]));
  // Opening it, and opening its Connection, never runs it.
  expect(callsTo("run_visual_query")).toHaveLength(0);
  // Opening it again shows the same tab.
  await userEvent.keyboard("{Control>}t{/Control}");
  await screen.findByRole("tab", { name: "Query 1", selected: true });
  await userEvent.click(screen.getByRole("treeitem", { name: /^late orders by store/ }));
  expect(await screen.findByRole("tab", { name: "late orders by store", selected: true })).toBeTruthy();
  expect(screen.getAllByRole("tab", { name: "late orders by store" })).toHaveLength(1);
}, LOAD_TIMEOUT);

test("a_saved_visual_query_from_a_newer_contura_opens_nothing_and_says_so", async () => {
  workspaceRoutes({ ...vqRoutes, list_saved_queries: () => [savedVq({ visualJson: JSON.stringify(vqModel("kfc_shop", 2)) })] });
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("treeitem", { name: /^late orders by store/ }));
  expect(await screen.findByText("This Visual Query was saved by a newer Contura. Update Contura to open it.")).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "late orders by store" })).toBeNull();
});

test("a_saved_visual_query_whose_connection_was_removed_asks_for_one_and_open_here_rebinds", async () => {
  workspaceRoutes({ ...vqRoutes, list_saved_queries: () => [savedVq({ connectionId: null })] });
  render(<App />);
  await closeHome();
  const row = await screen.findByRole("treeitem", { name: /^late orders by store/ });
  expect(row.querySelector(".tree-meta")?.textContent).toBe("Connection removed");
  await userEvent.click(row);
  expect(await screen.findByRole("tab", { name: "late orders by store", selected: true })).toBeTruthy();
  const banner = (await screen.findByText("This Visual Query's Connection was removed.")).closest(".vq-banner") as HTMLElement;
  await userEvent.click(within(banner).getByRole("button", { name: "Open here" }));
  await waitFor(() => expect(callsTo("open_connection")).toEqual([{ id: "c1" }]));
  await waitFor(() => expect(screen.queryByText("This Visual Query's Connection was removed.")).toBeNull());
  await waitFor(() => {
    const last = callsTo("save_query_tabs").slice(-1)[0];
    expect(JSON.parse((last?.json as string) ?? "{}").visual?.[0]).toMatchObject({ connectionId: "c1", savedId: "sv1" });
  });
}, LOAD_TIMEOUT);

test("restored_visual_draft_with_deleted_connection_asks_for_one", async () => {
  const v = { id: "v1", name: "Late deliveries", connectionId: "gone", database: "kfc_shop", model: vqModel(), savedId: null, savedJson: null };
  workspaceRoutes({ ...vqRoutes, load_query_tabs: ({ place }) => (place === "group:g1" ? JSON.stringify({ version: 1, tabs: [], visual: [v] }) : null) });
  render(<App />);
  expect(await screen.findByRole("tab", { name: "Late deliveries", selected: true })).toBeTruthy();
  expect(await screen.findByText("This Visual Query's Connection was removed.")).toBeTruthy();
  const banner = screen.getByText("This Visual Query's Connection was removed.").closest(".vq-banner") as HTMLElement;
  expect(within(banner).getByRole("button", { name: "Open here" })).toBeTruthy();
});

test("closing_a_changed_saved_visual_query_and_choosing_save_saves_it_and_closes", async () => {
  const saved = JSON.stringify(vqModel());
  const v = { id: "v1", name: "late orders by store", connectionId: "c1", database: "kfc_shop", model: { ...vqModel(), distinct: true }, savedId: "sv1", savedJson: saved };
  workspaceRoutes({
    ...vqRoutes,
    load_query_tabs: ({ place }) => (place === "group:g1" ? JSON.stringify({ version: 1, tabs: [], visual: [v] }) : null),
    list_saved_queries: () => [savedVq({ visualJson: saved })],
    save_saved_query: ({ input }) => ({ ...(input as object), updatedAtMs: 2, connectionId: "c1" }),
  });
  render(<App />);
  await screen.findByRole("tab", { name: /^late orders by store/, selected: true });
  await userEvent.click(screen.getByRole("button", { name: "Close late orders by store" }));
  expect(await screen.findByText(/Your edits to this Visual Query are not saved/)).toBeTruthy();
  await userEvent.click(inAsk("Save"));
  await waitFor(() => expect(callsTo("save_saved_query")).toHaveLength(1));
  const input = callsTo("save_saved_query")[0].input as Record<string, unknown>;
  expect(input).toMatchObject({ id: "sv1", name: "late orders by store", kind: "visual" });
  expect(JSON.parse(input.visualJson as string)).toMatchObject({ distinct: true });
  await waitFor(() => expect(screen.queryByRole("tab", { name: /^late orders by store/ })).toBeNull());
});

test("a_recent_saved_visual_query_opens_as_a_visual_query_tab", async () => {
  const model = { ...vqModel("shop"), dialect: "mysql", tables: [{ id: "t1", schema: null, name: "orders", alias: "o", x: 48, y: 48 }] };
  // Its own Connection id: the app's schema cache outlives a test, and earlier ones load c1.
  recentRoutes({
    ...vqRoutes,
    list_connections: () => [{ ...shopMy, id: "c7" }],
    last_group: () => null,
    list_saved_queries: () => [savedVq({ connectionId: "c7", visualJson: JSON.stringify(model) })],
    recent_items: () => [{ target: { kind: "query", savedId: "sv1", name: "late orders by store" }, connectionId: "c7", openedAtMs: Date.now() }],
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: /^late orders by store, / }));
  expect(await screen.findByRole("tab", { name: "late orders by store", selected: true })).toBeTruthy();
  expect(await screen.findByRole("toolbar", { name: "Visual Query" })).toBeTruthy();
  expect(screen.queryByRole("toolbar", { name: "Query" })).toBeNull();
}, LOAD_TIMEOUT);

// ---- Import, export and Mermaid (step 7, Task 13) ----

const exportPreview = { header: "", lines: ["id,status", "1,paid"], sheet: null, bytesPerRow: 9, notes: [], queryRead: true };
const jobRoutes = {
  table_design: () => ordersDesign,
  preview_export: () => exportPreview,
  start_export: () => undefined,
  cancel_job: () => undefined,
  list_jobs: () => [],
};

async function openShopTree(over: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  workspaceRoutes({ ...ordersRoutes(shopMy), ...jobRoutes, ...over });
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open KFC Shop" }));
  await screen.findByRole("treeitem", { name: treeName("orders") });
}

test("export_from_the_tree_opens_the_export_dialog_on_the_table", async () => {
  await openShopTree();
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: treeName("orders") }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Export..." }));
  const dialog = await screen.findByRole("dialog", { name: /Export orders/ });
  // The columns come from the table's design; the count from the tree's estimate.
  expect(within(dialog).getByText("All 2 columns")).toBeTruthy();
  expect(callsTo("table_design")).toEqual([{ id: "c2", path: { database: "shop", schema: null, name: "orders" } }]);
});

test("import_from_the_tree_opens_an_import_tab_and_closes_without_asking_when_nothing_runs", async () => {
  await openShopTree();
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: treeName("orders") }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Import..." }));
  expect(await screen.findByRole("tab", { name: "Import into orders", selected: true })).toBeTruthy();
  // The same table again shows the open tab.
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: treeName("orders") }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Import..." }));
  expect(screen.getAllByRole("tab", { name: "Import into orders" })).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Close Import into orders" }));
  await waitFor(() => expect(screen.queryByRole("tab", { name: "Import into orders" })).toBeNull());
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("export_in_the_background_shows_the_status_item_and_a_click_reopens_the_dialog", async () => {
  await openShopTree();
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: treeName("orders") }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Export..." }));
  const dialog = await screen.findByRole("dialog", { name: /Export orders/ });
  await waitFor(() => expect(callsTo("preview_export").length).toBeGreaterThan(0));
  await userEvent.click(within(dialog).getByRole("button", { name: /^Export/ }));
  await waitFor(() => expect(callsTo("start_export")).toHaveLength(1));
  // Escape while it runs sends it to the background (Q25).
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: /Export orders/ })).toBeNull());
  const item = await screen.findByRole("button", { name: "Exporting orders" });
  await userEvent.click(item);
  expect(await screen.findByRole("dialog", { name: /Export orders/ })).toBeTruthy();
  expect(callsTo("cancel_job")).toEqual([]);
});

const catalogRoutes = (over: Record<string, (a: Record<string, unknown>) => unknown> = {}) =>
  workspaceRoutes({ list_diagrams: () => [], icon_index: () => [], write_diagram: () => null, read_diagram: () => ({ text: 'diagram flow "Untitled diagram"\n', layout: null }), ...over });

test("home_new_diagram_opens_the_catalog", async () => {
  catalogRoutes();
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "New diagram" }));
  const catalog = await screen.findByRole("dialog", { name: "New diagram" });
  expect(within(catalog).getByRole("listbox", { name: "Diagrams" })).toBeTruthy();
  expect(within(catalog).getByRole("listbox", { name: "Templates" })).toBeTruthy();
  expect(within(catalog).queryByRole("button", { name: "From Mermaid..." })).toBeNull();
  // Esc closes the catalog only: Home, behind it, stays.
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New diagram" })).toBeNull());
  expect(screen.getByRole("tab", { name: "Home" })).toBeTruthy();
  expect(callsTo("write_diagram")).toEqual([]);
});

test("ctrl_alt_n_and_the_feature_bar_open_the_same_catalog", async () => {
  catalogRoutes();
  render(<App />);
  await screen.findByRole("button", { name: "New diagram" });
  await userEvent.keyboard("{Control>}{Alt>}n{/Alt}{/Control}");
  const viaKey = await screen.findByRole("dialog", { name: "New diagram" });
  expect(within(viaKey).getByRole("listbox", { name: "Templates" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New diagram" })).toBeNull());
  await userEvent.click(screen.getByRole("button", { name: "Diagram" }));
  const viaBar = await screen.findByRole("dialog", { name: "New diagram" });
  expect(within(viaBar).getByRole("listbox", { name: "Templates" })).toBeTruthy();
});

test("a_kind_from_the_catalog_creates_the_file_and_opens_its_tab", async () => {
  catalogRoutes();
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "New diagram" }));
  const catalog = await screen.findByRole("dialog", { name: "New diagram" });
  await userEvent.click(within(catalog).getByRole("option", { name: "Flowchart" }));
  await waitFor(() => expect(callsTo("write_diagram")).toHaveLength(1));
  expect(callsTo("write_diagram")[0]).toMatchObject({ name: "Untitled diagram", text: 'diagram flow "Untitled diagram"\n', overwrite: false });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New diagram" })).toBeNull());
  expect(await screen.findByRole("tab", { name: /Untitled diagram/ })).toBeTruthy();
});

test("from_mermaid_back_returns_to_the_catalog_with_the_search_kept", async () => {
  catalogRoutes();
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "New diagram" }));
  const catalog = await screen.findByRole("dialog", { name: "New diagram" });
  await userEvent.type(within(catalog).getByRole("combobox"), "shop");
  await userEvent.click(within(catalog).getByRole("option", { name: "From Mermaid" }));
  const mermaid = await screen.findByRole("dialog", { name: /Diagram from Mermaid/ });
  expect(screen.queryByRole("dialog", { name: "New diagram" })).toBeNull();
  await userEvent.click(within(mermaid).getByRole("button", { name: "Back" }));
  const again = await screen.findByRole("dialog", { name: "New diagram" });
  expect((within(again).getByRole("combobox") as HTMLInputElement).value).toBe("shop");
  expect(screen.queryByRole("dialog", { name: /Diagram from Mermaid/ })).toBeNull();
});

test("from_my_database_creates_a_file", async () => {
  catalogRoutes({
    ...ordersRoutes(shopMy),
    schema_snapshot: () => ({
      dialect: "mysql",
      tables: [{ schema: null, name: "orders", alias: null, note: null, indexes: [], columns: [{ name: "id", typeName: "int", pk: true, increment: false, notNull: false, unique: false, default: null, note: null }] }],
      refs: [], enums: [], skipped: [],
    }),
  });
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open KFC Shop" }));
  await screen.findByRole("treeitem", { name: treeName("orders") });
  await userEvent.keyboard("{Control>}{Alt>}n{/Alt}{/Control}");
  const catalog = await screen.findByRole("dialog", { name: "New diagram" });
  await userEvent.type(within(catalog).getByRole("combobox"), "x");
  await userEvent.clear(within(catalog).getByRole("combobox"));
  await userEvent.click(within(catalog).getByRole("option", { name: "From my database" }));
  const db = await screen.findByRole("dialog", { name: "From my database" });
  expect(screen.queryByRole("dialog", { name: "New diagram" })).toBeNull();
  await userEvent.click(within(db).getByRole("combobox", { name: "Connection" }));
  await userEvent.click(screen.getByRole("option", { name: /KFC Shop/ }));
  await within(db).findByRole("combobox", { name: "Database" });
  await userEvent.click(within(db).getByRole("button", { name: /Read the database/ }));
  await waitFor(() => expect(callsTo("write_diagram")).toHaveLength(1));
  expect(String(callsTo("write_diagram")[0].text)).toContain("orders {");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "From my database" })).toBeNull());
  expect(await screen.findByRole("tab", { name: new RegExp(String(callsTo("write_diagram")[0].name)) })).toBeTruthy();
});

test("from_my_database_back_returns_to_the_catalog", async () => {
  catalogRoutes();
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "New diagram" }));
  const catalog = await screen.findByRole("dialog", { name: "New diagram" });
  await userEvent.type(within(catalog).getByRole("combobox"), "shop");
  await userEvent.click(within(catalog).getByRole("option", { name: "From my database" }));
  const db = await screen.findByRole("dialog", { name: "From my database" });
  await userEvent.click(within(db).getByRole("button", { name: "Back" }));
  const again = await screen.findByRole("dialog", { name: "New diagram" });
  expect((within(again).getByRole("combobox") as HTMLInputElement).value).toBe("shop");
});

test("a_restart_drops_import_tabs", async () => {
  let saved: string | null = null;
  await openShopTree({
    save_query_tabs: ({ json }) => {
      saved = json as string;
      return null;
    },
  });
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: treeName("orders") }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Import..." }));
  await screen.findByRole("tab", { name: "Import into orders" });
  await userEvent.keyboard("{Control>}t{/Control}");
  await screen.findByRole("tab", { name: "Query 1" });
  await waitFor(() => expect(saved).not.toBeNull());
  cleanup();
  workspaceRoutes({ ...ordersRoutes(shopMy), ...jobRoutes, load_query_tabs: () => saved });
  render(<App />);
  expect(await screen.findByRole("tab", { name: "Query 1" })).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Import into orders" })).toBeNull();
});

// ---- Fix round 1 (Q43): leaving with a running import ----

const importSummary = {
  format: "csv",
  delimiter: "comma",
  encoding: "UTF-8",
  bytes: 64,
  header: ["id", "status"],
  rows: [["1", "paid"]],
  rowsEstimate: { rows: 1, exact: true },
  sheets: [],
  conturaBackup: false,
};
const importPlan = {
  columns: [
    { into: "id", typeSql: "int", fileColumn: 0, note: null, blocks: null, generated: false },
    { into: "status", typeSql: "varchar(16)", fileColumn: 1, note: null, blocks: null, generated: false },
  ],
  preview: [[{ text: "1", problem: null }, { text: "paid", problem: null }]],
  sampleInsert: "INSERT INTO `orders` (`id`, `status`) VALUES (1, 'paid')",
  extra: [],
  shape: { head: "INSERT INTO `orders` (`id`, `status`) VALUES", firstRows: ["(1, 'paid')"], rowsPerStatement: 500, statements: 1, rows: 1 },
  warnings: [],
  oneTransaction: true,
  verdict: { kind: "ok" },
};
const importRoutes = {
  inspect_import_file: () => importSummary,
  plan_import: () => importPlan,
  check_import_file: () => "chk-1",
  // The run never ends: it stays running for the test.
  start_import: () => undefined,
};

/** Opens an Import tab into orders and starts a run that keeps running. */
async function startRunningImport(over: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  await openShopTree({ ...importRoutes, ...over });
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: treeName("orders") }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Import..." }));
  await screen.findByRole("tab", { name: "Import into orders", selected: true });
  const pane = () => document.querySelector(".work-pane:not([hidden]) .import-tab") as HTMLElement;
  await userEvent.click(within(pane()).getByRole("button", { name: "Browse..." }));
  await within(pane()).findByText(/columns, /);
  await userEvent.click(within(pane()).getByRole("button", { name: "Next" }));
  await userEvent.click(await within(pane()).findByRole("button", { name: /^Import 1 row/ }));
  await waitFor(() => expect(callsTo("start_import")).toHaveLength(1));
}

test("closing_a_running_import_tab_asks_and_keep_running_keeps_it", async () => {
  await startRunningImport();
  await userEvent.click(screen.getByRole("button", { name: "Close Import into orders" }));
  const ask = await screen.findByRole("dialog", { name: "Cancel the import and roll back?" });
  await userEvent.click(within(ask).getByRole("button", { name: /Keep running/ }));
  expect(screen.getByRole("tab", { name: "Import into orders" })).toBeTruthy();
  expect(callsTo("cancel_job")).toEqual([]);
  await userEvent.click(screen.getByRole("button", { name: "Close Import into orders" }));
  const again = await screen.findByRole("dialog", { name: "Cancel the import and roll back?" });
  await userEvent.click(within(again).getByRole("button", { name: "Cancel and roll back" }));
  await waitFor(() => expect(screen.queryByRole("tab", { name: "Import into orders" })).toBeNull());
  expect(callsTo("cancel_job")).toEqual([{ job: callsTo("start_import")[0].job }]);
}, LOAD_TIMEOUT);

test("switching_group_with_a_running_import_asks_and_no_keeps_the_place_q43_i1", async () => {
  await startRunningImport();
  // Ctrl+2 is Ungrouped, after KFC.
  await userEvent.keyboard("{Control>}{Alt>}2{/Alt}{/Control}");
  const ask = await screen.findByRole("dialog", { name: "Cancel the import and roll back?" });
  await userEvent.click(within(ask).getByRole("button", { name: /Keep running/ }));
  expect(screen.getByRole("button", { name: "Switch Group, current KFC" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Import into orders" })).toBeTruthy();
  expect(callsTo("cancel_job")).toEqual([]);
}, LOAD_TIMEOUT);

test("a_retargeted_import_tab_takes_the_new_key_and_a_second_one_there_folds_into_it_q43", async () => {
  const ro = { ...shopMy, id: "c3", name: "shop-ro", readOnly: true };
  workspaceRoutes({ ...ordersRoutes(shopMy), ...jobRoutes, ...importRoutes, list_connections: () => [shopMy, ro] });
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open shop-ro" }));
  const importFromTree = async () => {
    fireEvent.contextMenu(await screen.findByRole("treeitem", { name: treeName("orders") }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Import..." }));
  };
  const retarget = async () => {
    const pane = document.querySelector(".work-pane:not([hidden]) .import-tab") as HTMLElement;
    await userEvent.click(within(pane).getByRole("combobox", { name: "Choose Connection..." }));
    await userEvent.click(screen.getByRole("option", { name: /KFC Shop/ }));
  };
  await importFromTree();
  await screen.findByRole("tab", { name: "Import into orders, Read-only", selected: true });
  await retarget();
  await screen.findByRole("tab", { name: "Import into orders", selected: true });
  // The Read-only table no longer has a tab: Import... opens a new one.
  await importFromTree();
  await screen.findByRole("tab", { name: "Import into orders, Read-only", selected: true });
  expect(screen.getAllByRole("tab", { name: /^Import into orders/ })).toHaveLength(2);
  // Choosing KFC Shop again: its tab exists, so that one shows and this one goes.
  await retarget();
  await screen.findByRole("tab", { name: "Import into orders", selected: true });
  expect(screen.getAllByRole("tab", { name: /^Import into orders/ })).toHaveLength(1);
}, LOAD_TIMEOUT);

test("item_13_the_title_bars_home_button_goes_home_from_anywhere", async () => {
  workspaceRoutes();
  render(<App />);
  await closeHome();
  expect(screen.queryByRole("heading", { name: "Home" })).toBeNull();
  const home = document.querySelector(".title-bar .title-home") as HTMLElement;
  expect(home.textContent).toBe("Home");
  expect(home.getAttribute("title")).toBe("Home (Ctrl+Shift+H)");
  await userEvent.click(home);
  expect(await screen.findByRole("heading", { name: "Home" })).toBeTruthy();
  expect(home.getAttribute("aria-current")).toBe("page");
  // The feature bar is under the title bar on every screen.
  expect(screen.getByRole("toolbar", { name: "Features" })).toBeTruthy();
});

test("item_8_a_new_query_opens_on_the_database_used_last", async () => {
  recentRoutes({ list_databases: () => ["shop", "hc_backend"], save_query_tabs: () => null });
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open KFC Shop" }));
  await userEvent.click(await screen.findByRole("treeitem", { name: treeName("hc_backend") }));
  await userEvent.click(stripNew());
  await waitFor(() => {
    const saved = callsTo("save_query_tabs").map((a) => JSON.parse(a.json as string) as { tabs: { database: string | null }[] });
    expect(saved.some((s) => s.tabs.some((t) => t.database === "hc_backend"))).toBe(true);
  });
});

// ---- AI Context (step 11c) ----

test("refresh_marks_ai_context_changed", async () => {
  await openOrders({ ai_context_changed: () => null });
  await userEvent.click(screen.getByRole("button", { name: "More actions for KFC Shop" }));
  await userEvent.click(within(screen.getByRole("menu", { name: "KFC Shop" })).getByRole("menuitem", { name: "Refresh schema" }));
  await waitFor(() => expect(callsTo("ai_context_changed")).toEqual([{ connectionId: "c2" }]));
});

/** A new data folder: no Groups, no Connections, and the Core asks for the first start guide. */
function firstStart() {
  route({
    list_groups: () => [],
    list_connections: () => [],
    last_group: () => null,
    suggested_connections: () => [],
    first_start_guide: () => true,
    first_start_guide_seen: () => undefined,
    secret_store_kind: () => "keyring",
    update_status: () => ({ checks: null, currentVersion: "1.0.0", lastCheckMs: null, lastResult: null, offer: null, install: "portable", canInstall: false, ready: false, releasesUrl: "" }),
    set_update_checks: (a) => ({ checks: a.on, currentVersion: "1.0.0", lastCheckMs: null, lastResult: null, offer: null, install: "portable", canInstall: false, ready: false, releasesUrl: "" }),
    ai_settings: () => {
      throw new Error("not needed");
    },
  });
}

test("first_start_guide_opens_on_a_new_data_folder_skip_marks_it_seen_and_home_offers_it_again", async () => {
  firstStart();
  render(<App />);
  expect(await screen.findByRole("dialog", { name: "Welcome to Contura" })).toBeTruthy();
  // The update banner is gone: the guide's step 4 asks instead.
  expect(screen.queryByRole("region", { name: "Update checks" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Skip the guide" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(callsTo("first_start_guide_seen")).toEqual([{}]);
  expect(await screen.findByText("Guide skipped")).toBeTruthy();
  expect(callsTo("set_update_checks")).toEqual([]);
  // Home's empty state opens it again; Esc closes it like Skip.
  await userEvent.click(screen.getByRole("button", { name: "Show the first start guide" }));
  expect(await screen.findByRole("dialog", { name: "Welcome to Contura" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("first_start_guide_stays_closed_on_a_data_folder_that_has_seen_it", async () => {
  route({ list_groups: () => [], list_connections: () => [], last_group: () => null, suggested_connections: () => [], first_start_guide: () => false });
  render(<App />);
  expect(await screen.findByRole("heading", { name: "No Connections yet" })).toBeTruthy();
  await waitFor(() => expect(callsTo("first_start_guide")).toHaveLength(1));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("first_start_guide_ends_on_the_chosen_connection_form", async () => {
  firstStart();
  render(<App />);
  await screen.findByRole("dialog", { name: "Welcome to Contura" });
  await userEvent.click(screen.getByRole("button", { name: "Get started" }));
  for (let i = 0; i < 4; i++) await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await userEvent.click(screen.getByRole("button", { name: "Add the PostgreSQL Connection" }));
  const form = await screen.findByRole("dialog", { name: /New Connection/ });
  const db = within(form).getByRole("radiogroup", { name: "Database" });
  expect(within(db).getByRole("radio", { name: /PostgreSQL/, checked: true })).toBeTruthy();
  expect(callsTo("set_update_checks")).toEqual([{ on: false }]);
  expect(callsTo("first_start_guide_seen")).toEqual([{}]);
});

test("shell_grid_children_are_exactly_its_four_rows_and_the_guide_is_not_one", async () => {
  // The grid defines four rows: title bar, feature bar, body, status bar. An extra child (the old update
  // banner was one) gets squeezed and the status bar overlaps it.
  const shell = appCssRules().find((r) => r.selector === ".app")?.body ?? "";
  const rows = /grid-template-rows:\s*([^;]+);/.exec(shell)?.[1] ?? "";
  expect(rows.trim().split(/\s+(?![^(]*\))/)).toHaveLength(4);
  firstStart();
  render(<App />);
  await screen.findByRole("dialog", { name: "Welcome to Contura" });
  const app = document.querySelector(".app") as HTMLElement;
  const kids = Array.from(app.children).map((c) => `${c.tagName.toLowerCase()}.${c.classList[0]}`);
  expect(kids).toHaveLength(4);
  expect(kids[0]).toBe("header.title-bar");
  expect(kids[3]).toBe("footer.app-status");
  // The guide sits outside the grid, on a fixed cover.
  expect(app.contains(screen.getByRole("dialog"))).toBe(false);
  expect(appCssRules(guideCssRaw).find((r) => r.selector === ".fsg-cover")?.body).toMatch(/position:\s*fixed/);
});

test("first_start_guide_keeps_the_title_bar_out_of_reach_and_owns_esc", async () => {
  firstStart();
  render(<App />);
  const dialog = await screen.findByRole("dialog", { name: "Welcome to Contura" });
  const header = document.querySelector("header.title-bar") as HTMLElement;
  const home = header.querySelector(".title-home") as HTMLElement;
  // A click on the title bar lands on the cover in the app; focus that gets there anyway comes back.
  act(() => home.focus());
  expect(dialog.contains(document.activeElement)).toBe(true);
  await userEvent.tab();
  expect(dialog.contains(document.activeElement)).toBe(true);
  await userEvent.tab({ shift: true });
  expect(dialog.contains(document.activeElement)).toBe(true);
  // The window buttons stay usable: they sit above the cover.
  expect(document.documentElement.classList.contains("fsg-open")).toBe(true);
  expect(within(header).getByRole("button", { name: "Minimize" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.documentElement.classList.contains("fsg-open")).toBe(false);
  expect(callsTo("first_start_guide_seen")).toEqual([{}]);
});

// ---- Ask on every tab (spec 9) ----

const askPanel = () => screen.queryByRole("complementary", { name: "Ask" });
const toggleAsk = () => userEvent.keyboard("{Control>}{Alt>}i{/Alt}{/Control}");

test("the Ask panel shows on Home and Settings, not on a diagram, where the toggle says why", async () => {
  workspaceRoutes({
    ai_settings: () => {
      throw { kind: "storage", message: "no" };
    },
    list_ai_threads: () => [],
    list_diagrams: () => [{ name: "checkout", kind: "flow", title: "Checkout", modifiedMs: Date.now() - 60_000 }],
    read_diagram: () => ({ text: 'diagram flow "Checkout"\n\nStart [start]\n', layout: null }),
  });
  render(<App />);
  expect(await screen.findByRole("tab", { name: "Home", selected: true })).toBeTruthy();
  expect(askPanel()).toBeNull();
  await toggleAsk();
  expect(await screen.findByRole("complementary", { name: "Ask" })).toBeTruthy();
  // The window pane narrows by the panel's width, which its left edge sets.
  expect(document.querySelector(".body")!.className).toBe("body body-home body-ai");
  expect((document.querySelector(".body") as HTMLElement).style.getPropertyValue("--ask-width")).toBe("360px");
  expect(screen.getByRole("separator", { name: "Resize the Ask panel" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Message" }).getAttribute("placeholder")).toBe("Ask about Contura or SQL");

  await userEvent.keyboard("{Control>},{/Control}");
  expect(await screen.findByRole("tab", { name: "Settings", selected: true })).toBeTruthy();
  expect(askPanel()).toBeTruthy();

  await userEvent.click(screen.getByRole("tab", { name: "Home" }));
  await userEvent.click(await screen.findByRole("button", { name: /^checkout, / }));
  await waitFor(() => expect(screen.getByRole("tab", { name: /checkout/, selected: true })).toBeTruthy());
  expect(askPanel()).toBeNull();
  expect(document.querySelector(".body")!.className).toBe("body body-home");
  // S11: the toggle opens no panel on a diagram, and says why; the panel is still open on Home.
  await toggleAsk();
  expect(askPanel()).toBeNull();
  expect(await screen.findByText("A diagram has its own Assistant, so the Ask panel stays closed here.")).toBeTruthy();
  await userEvent.click(screen.getByRole("tab", { name: "Home" }));
  expect(await screen.findByRole("complementary", { name: "Ask" })).toBeTruthy();
});

test("the Ask panel shows on New table and Schema Compare", async () => {
  await openOrders({
    ai_settings: () => {
      throw { kind: "storage", message: "no" };
    },
    list_ai_threads: () => [],
  });
  await toggleAsk();
  expect(await screen.findByRole("complementary", { name: "Ask" })).toBeTruthy();
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: treeName("shop") }));
  await userEvent.click(screen.getByRole("menuitem", { name: "New table..." }));
  await screen.findByRole("tab", { name: "Columns 1" });
  expect(askPanel()).toBeTruthy();
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: treeName("shop") }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Schema Compare" }));
  await waitFor(() => expect(document.querySelector(".compare-main:not([hidden])")).toBeTruthy());
  expect(askPanel()).toBeTruthy();
  expect(document.querySelector(".body")!.className).toBe("body body-home body-ai");
});

// ---- Ask everywhere, end to end (spec 11): a Visual Query, then New table ----

test("visual query to new table", async () => {
  // The trail is a module store: earlier tests of this file recorded steps in this place.
  clearAllSteps();
  const hope = { ...pg, id: "c4", name: "hope-4", dialect: "mysql", port: 3306, database: "shop", aiAccess: "schemaQuery" };
  const col = (name: string, typeName: string, pk = false) => ({ name, typeName, pk });
  const shopSchema = {
    searchPath: [],
    tables: [
      { schema: null, name: "orders", kind: "table", columns: [col("id", "int", true), col("customer_id", "int"), col("total", "decimal(14,2)"), col("created_at", "datetime")] },
      { schema: null, name: "customers", kind: "table", columns: [col("id", "int", true), col("name", "varchar(80)")] },
    ],
    functions: [],
    fks: [{ from: { schema: null, table: "orders", columns: ["customer_id"] }, to: { schema: null, table: "customers", columns: ["id"] } }],
  };
  const model = {
    version: 1,
    database: "shop",
    dialect: "mysql",
    tables: [{ id: "t1", schema: null, name: "orders", alias: "o", x: 48, y: 48 }],
    joins: [],
    columns: [],
    filters: [],
    groupBy: { kind: "auto" },
    orderBy: [],
    limit: null,
    distinct: false,
  };
  const sqlOf = (q: VisualQuery) => `SELECT ${q.columns.length ? q.columns.map((c) => `o.${c.column}`).join(", ") : "*"}\nFROM orders AS o${q.filters.length ? "\nWHERE o.total > ?" : ""}`;
  const create = "CREATE TABLE monthly_totals (customer_id int not null, month date not null, total decimal(14,2) not null, primary key (customer_id, month))";
  // The Core's check of that answer: a write, so it opens only commented out.
  const createBlock = { fence: 0, label: "1 statement: 1 write (CREATE)", statements: [{ text: create, class: "write" as const, flags: [] }], bodySha256: sha256Hex(create) };
  const stream = aiStream((_, n) =>
    n === 1 ? [delta("Add a filter on orders.total greater than one million."), done()] : [delta("```sql\n" + create + "\n```"), done({ sqlBlocks: [createBlock] })],
  );
  let stored: AiThread | null = null;
  workspaceRoutes({
    list_connections: () => [hope],
    list_databases: () => ["shop"],
    list_objects: () => [
      { kind: "table", name: "orders", rows: 1204 },
      { kind: "table", name: "customers", rows: 40 },
    ],
    set_last_group: () => null,
    sql_schema: () => shopSchema,
    list_saved_queries: () => [
      { id: "sv1", name: "Untitled 1", sql: "SELECT *\nFROM orders AS o", updatedAtMs: 1, connectionId: "c4", kind: "visual", visualJson: JSON.stringify(model) },
    ],
    visual_query_sql: ({ query }) => {
      const q = query as VisualQuery;
      return { query: { sql: sqlOf(q), parts: [{ part: { kind: "select" }, fromLine: 1, toLine: 1 }], outputs: q.columns.map((c) => c.column), warnings: [] }, problems: [] };
    },
    run_visual_query: ({ query }) => ({
      sql: sqlOf(query as VisualQuery),
      execution: { outcome: { t: "rows", columns: [{ name: "id", typeName: "int", numeric: true }], rows: [[{ t: "number", value: "7" }]], hasMore: false }, elapsedMs: 12 },
    }),
    close_query_result: () => null,
    cancel_query: () => null,
    ai_settings: () => ({
      settings: { ...aiSettingsReply().settings, provider: "groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
      groupOverride: false,
      keySaved: true,
      keyLast4: "abcd",
    }),
    ai_known_models: () => ({ current: "llama-3.3-70b-versatile", models: [], fetchedAt: null, error: null }),
    ai_preview: (a) => fakePreview(a.request as AskRequest),
    list_ai_threads: ({ place }) => (stored && stored.place === place ? [summaryOf(stored)] : []),
    get_ai_thread: () => (stored ? viewOf(stored) : null),
    ai_answer_record: () => null,
    ai_append_turn: (a) => {
      const turn = a.turn as AppendTurn;
      stored = withTurn(stored, turnViewOf(turn, stored), turn.replaceFrom);
      const v = viewOf(stored);
      return { ...turnViewOf(turn, null, v.topics, v.compactions), title: stored.title, messages: stored.messages.slice(-turn.messages.length) };
    },
    save_ai_thread: (a) => {
      stored = a.thread as AiThread;
      return viewOf(stored);
    },
    ai_ask_stream: (a) => stream.handler(a),
    ai_cancel: () => true,
    table_design: () => ordersDesign,
  });
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open hope-4" }));

  // 1. Open the Visual Query on shop with orders on the canvas, and tick three columns.
  await userEvent.click(await screen.findByRole("treeitem", { name: /^Untitled 1/ }));
  expect(await screen.findByRole("tab", { name: "Untitled 1", selected: true })).toBeTruthy();
  for (const c of ["o.id", "o.customer_id", "o.total"]) await userEvent.click(await screen.findByRole("checkbox", { name: c }));

  // 2. Ask in the Visual Query.
  await toggleAsk();
  const panel = await screen.findByRole("complementary", { name: "Ask" });
  await userEvent.type(within(panel).getByRole("textbox", { name: "Message" }), "find orders over 1M{Enter}");
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  const first = callsTo("ai_ask_stream")[0].request as AskRequest;
  expect(first.tab?.kind).toBe("visual");
  expect(first.question).toBe("find orders over 1M");
  expect(first.steps!.map((x) => x.verb)).toEqual(["openTab", "vqTick"]);
  await within(panel).findByText("Add a filter on orders.total greater than one million.");

  // 3. Add the filter on the canvas's query and run it: 1 row.
  await userEvent.click(screen.getByRole("tab", { name: /^Filter and sort/ }));
  await userEvent.click(screen.getByRole("button", { name: "Add condition" }));
  await userEvent.click(screen.getByRole("combobox", { name: "Column for filter 1" }));
  await userEvent.click(await screen.findByRole("option", { name: "o.total" }));
  await userEvent.click(screen.getByRole("combobox", { name: "Operator for filter 1" }));
  await userEvent.click(await screen.findByRole("option", { name: ">" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Value for filter 1" }), "1000000");
  const run = within(screen.getByRole("toolbar", { name: "Visual Query" })).getByRole("button", { name: /^Run/ }) as HTMLButtonElement;
  await waitFor(() => expect(run.disabled).toBe(false));
  await userEvent.click(run);
  await waitFor(() => expect(callsTo("run_visual_query")).toHaveLength(1));
  expect(JSON.stringify(callsTo("run_visual_query")[0].query)).toContain("1000000");
  expect(await screen.findByText(/^1 row in/)).toBeTruthy();

  // 4. New table on shop, from the tree.
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: treeName("shop") }));
  await userEvent.click(screen.getByRole("menuitem", { name: "New table..." }));
  await screen.findByRole("tab", { name: "Columns 1" });

  // 5. Ask in New table: the request carries the tab and the three steps since the first Ask.
  await userEvent.type(within(panel).getByRole("textbox", { name: "Message" }), "make a pivot table for monthly totals per customer{Enter}");
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
  const second = callsTo("ai_ask_stream")[1].request as AskRequest;
  expect(second.tab?.kind).toBe("design");
  expect(second.tab).toMatchObject({ kind: "design", create: true });
  expect(second.connectionId).toBe("c4");
  expect(second.database).toBe("shop");
  expect(second.threadId).toBe(first.threadId ?? stored!.id);
  expect(second.steps!.map((x) => [x.verb, x.names ?? [], x.count])).toEqual([
    ["vqFilter", ["orders.total"], null],
    ["runVisual", [], 1],
    ["openTab", [], null],
  ]);
  // No filter value is ever in the request.
  expect(JSON.stringify(second)).not.toContain("1000000");

  // 6. The answer's write opens only commented out in a new query tab, and nothing runs.
  expect(await within(panel).findByRole("button", { name: "Open in new query tab, commented out" })).toBeTruthy();
  expect(within(panel).queryByRole("button", { name: "Open in new query tab" })).toBeNull();
  expect(within(panel).queryByRole("button", { name: "Run" })).toBeNull();
  expect(within(panel).queryByRole("button", { name: "Insert" })).toBeNull();
}, LOAD_TIMEOUT);

test("clearing_recent_shows_the_cleared_toast_with_undo", async () => {
  const item = { target: ordersTarget, connectionId: "c1", openedAtMs: Date.now() - 60_000 };
  recentRoutes({ last_group: () => null, recent_items: () => [item], clear_recent: () => [item] });
  render(<App />);
  await screen.findByRole("button", { name: /^shop\.orders, Table on KFC Shop, / });
  await userEvent.click(screen.getByRole("button", { name: "Clear" }));
  const toast = (await screen.findByText("Cleared Recent.", {}, { timeout: 2000 })).closest(".toast") as HTMLElement;
  expect(toast.getAttribute("role")).toBe("status");
  expect(within(toast).getByRole("button", { name: "Undo" })).toBeTruthy();
});

test("discarding_pending_edits_in_a_table_tab_shows_the_undo_toast", async () => {
  await openOrdersWithAnEdit();
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Pending Edits" })).toBeNull());
  const toast = (await screen.findByText("Discarded 1 change.", {}, { timeout: 2000 })).closest(".toast") as HTMLElement;
  expect(toast.getAttribute("role")).toBe("status");
  expect(within(toast).getByRole("button", { name: "Undo" })).toBeTruthy();
});

test("G15: single-click orders, sort by status, single-click customers, single-click orders keeps the sorted orders tab", async () => {
  workspaceRoutes({
    list_connections: () => [shopMy],
    list_databases: () => ["shop"],
    list_objects: () => [
      { kind: "table", name: "customers" },
      { kind: "table", name: "orders" },
    ],
    fetch_page: () => ordersPage,
    set_last_group: () => null,
    sql_schema: () => ({ tables: [], functions: [] }),
  });
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open KFC Shop" }));
  await userEvent.click(await screen.findByRole("treeitem", { name: treeName("orders") }));
  await userEvent.click(await screen.findByRole("button", { name: "Sort by status" }));
  await waitFor(() => expect(callsTo("fetch_page").some((a) => (a.request as { sort: unknown }).sort)).toBe(true));
  await userEvent.click(await screen.findByRole("treeitem", { name: treeName("customers") }));
  expect(await screen.findByRole("tab", { name: /customers/ })).toBeTruthy();
  await userEvent.click(await screen.findByRole("treeitem", { name: treeName("orders") }));
  expect(screen.getByRole("tab", { name: /orders/ })).toBeTruthy();
  expect(screen.getByRole("tab", { name: /customers/ })).toBeTruthy();
  // The worked-in tab is a kept tab; the later single click made customers the preview.
  expect(screen.getByRole("tab", { name: /orders/ }).closest(".work-tab")!.className).not.toContain("work-tab-preview");
  expect(screen.getByRole("tab", { name: /customers/ }).closest(".work-tab")!.className).toContain("work-tab-preview");
});

describe("S13: a single click on a table right after switching tables is not ignored", () => {
  const routes = (over: Record<string, (a: Record<string, unknown>) => unknown> = {}) =>
    workspaceRoutes({
      list_connections: () => [shopMy],
      list_databases: () => ["shop"],
      list_objects: () => [
        { kind: "table", name: "customers" },
        { kind: "table", name: "orders" },
        { kind: "table", name: "stores" },
      ],
      fetch_page: () => ordersPage,
      set_last_group: () => null,
      sql_schema: () => ({ tables: [], functions: [] }),
      ...over,
    });

  test("each of three quick clicks on different tables shows that table at once", async () => {
    routes();
    render(<App />);
    await closeHome();
    await userEvent.click(await screen.findByRole("button", { name: "Open KFC Shop" }));
    for (const name of ["orders", "customers", "stores", "orders"]) {
      await userEvent.click(await screen.findByRole("treeitem", { name }));
      expect(screen.getByRole("tab", { name: new RegExp(name), selected: true })).toBeTruthy();
    }
  });

  test("the same while the first table's rows are still loading", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    routes({ fetch_page: async () => (await held, ordersPage) });
    render(<App />);
    await closeHome();
    await userEvent.click(await screen.findByRole("button", { name: "Open KFC Shop" }));
    await userEvent.click(await screen.findByRole("treeitem", { name: treeName("orders") }));
    await userEvent.click(await screen.findByRole("treeitem", { name: treeName("customers") }));
    expect(screen.getByRole("tab", { name: /customers/, selected: true })).toBeTruthy();
    release();
  });
});

// ---- Resume where the chat ended (Plan D2 Task 8, Decision 9) ----
describe("resume where the chat ended", () => {
  const invoice = { ...pg, id: "c7", name: "invoice", database: "hc-backend" };
  const TITLE = "Unpaid clients to date";
  const INSERTED = "SELECT name FROM clients WHERE paid = false";
  const chatOf = (id: string, place: string, title: string, at: number): AiThread => ({
    id,
    place,
    title,
    updatedAt: at,
    messages: [
      { role: "user", text: `${title}?`, context: [], at: at - 1 },
      { role: "assistant", text: "```sql\nSELECT count(*) FROM clients\n```", context: [], at },
    ],
  });
  const chat = chatOf("t1", "group:g1", TITLE, 5);
  const workOf = (over: Partial<LastWork> = {}): LastWork => ({
    tabKind: "query",
    tabKey: "query:closed-long-ago",
    tabLabel: "Query 4",
    connectionId: "c7",
    database: "hc-backend",
    table: "clients",
    insertedSql: INSERTED,
    aiSql: "SELECT count(*) FROM clients",
    at: 5,
    ...over,
  });
  /** The tab the place restores: another Connection and database are shown when the chat is clicked. */
  const shown = { id: "d1", name: "Late deliveries", text: "SELECT 1", connectionId: "c1", database: "kfc_shop", savedId: null, savedText: null };

  function resumeRoutes(
    opts: {
      chats?: AiThread[];
      /** The list's tag for a chat; null for a chat that never touched a database. */
      tag?: (t: AiThread) => WorkTag | null;
      work?: LastWork | null;
      drafts?: unknown[];
      connections?: unknown[];
      over?: Record<string, (a: Record<string, unknown>) => unknown>;
    } = {},
  ) {
    const chats = opts.chats ?? [chat];
    const tag = opts.tag ?? (() => ({ connectionId: "c7", database: "hc-backend", table: "clients", tabLabel: "Query 4" }));
    const drafts = opts.drafts ?? [shown];
    shellRoutes({
      list_connections: () => opts.connections ?? [pg, invoice],
      load_query_tabs: ({ place }) => (place === "group:g1" ? JSON.stringify({ version: 1, tabs: drafts }) : null),
      list_databases: ({ id }) => (id === "c7" ? ["hc-backend", "hc-archive"] : ["kfc_shop"]),
      list_ai_threads: ({ place }) => chats.filter((c) => c.place === place).map((c) => ({ ...summaryOf(c), work: tag(c) })),
      get_ai_thread: ({ threadId }) => {
        const t = chats.find((c) => c.id === threadId);
        return t ? viewOf(t) : null;
      },
      ai_thread_work: () => (opts.work === undefined ? workOf() : opts.work),
      save_ai_thread: () => null,
      ...opts.over,
    });
  }

  const askPanel = () => screen.getByRole("complementary", { name: "Ask" });
  /** Opens the Ask panel on the place's newest chat. */
  async function openAsk(firstQuestion = `${TITLE}?`) {
    await screen.findByRole("tab", { name: "Late deliveries", selected: true });
    await toggleAsk();
    await within(await screen.findByRole("complementary", { name: "Ask" })).findByText(firstQuestion, { selector: ".msg-user" });
  }
  async function clickRow(title = TITLE) {
    await userEvent.click(within(askPanel()).getByRole("button", { name: "Show history" }));
    await userEvent.click(await screen.findByRole("button", { name: new RegExp(`^${title}`) }));
  }
  const shownEditor = () => document.querySelector(".work-pane:not([hidden]) .cm-content")?.textContent ?? null;
  const statusSpans = () => Array.from(document.querySelectorAll("#app-status-slot .query-status > span")).map((s) => s.textContent);
  const strip = () => askPanel().querySelector(".ask-strip");
  const NOT_AVAILABLE = "hc-backend is not available. The chat is open without its tab.";

  test("opening_a_chat_resumes_its_connection_database_and_query", async () => {
    resumeRoutes();
    render(<App />);
    await openAsk();
    // The place load opened the chat; it resumed nothing.
    expect(callsTo("ai_thread_work")).toEqual([]);
    await clickRow();
    await waitFor(() => expect(callsTo("ai_thread_work")).toEqual([{ threadId: "t1" }]));
    // invoice opens, and a new query tab on it and hc-backend holds the SQL the user last inserted.
    await waitFor(() => expect(callsTo("open_connection")).toEqual([{ id: "c7" }]));
    expect(await screen.findByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
    await waitFor(() => expect(shownEditor()).toBe(INSERTED));
    await waitFor(() => expect(statusSpans()).toContain(`From chat: ${TITLE}`));
    expect(statusSpans()).toContain("hc-backend");
    // The place stays; the chat stays open; no strip.
    expect(screen.getByRole("button", { name: "Switch Group, current KFC" })).toBeTruthy();
    expect(within(askPanel()).getByText(`${TITLE}?`, { selector: ".msg-user" })).toBeTruthy();
    expect(strip()).toBeNull();
  });

  test("a_gated_resume_shows_from_chat_with_no_hint_of_withheld_sql", async () => {
    // The chat's Connection is at Never now: the Core gives back the place and the tab, never the SQL.
    resumeRoutes({ work: workOf({ insertedSql: undefined, aiSql: undefined }) });
    render(<App />);
    await openAsk();
    const notesBefore = askPanel().querySelectorAll(".msg-notice, [role=alert], [role=status]").length;
    await clickRow();
    expect(await screen.findByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
    await waitFor(() => expect(statusSpans()).toContain(`From chat: ${TITLE}`));
    // The tab reads as any resume: the same From chat line, an empty editor with no placeholder, no note.
    expect(shownEditor()).toBe("");
    expect(document.querySelector(".work-pane:not([hidden]) .cm-placeholder")).toBeNull();
    const line = statusSpans().join(" | ");
    expect(line).not.toMatch(/withheld|hidden|not shared|never|no sql|ai access|kept back/i);
    expect(statusSpans().filter((t) => t?.startsWith("From chat"))).toEqual([`From chat: ${TITLE}`]);
    // Nothing in the Ask panel says anything either.
    expect(strip()).toBeNull();
    expect(askPanel().querySelectorAll(".msg-notice, [role=alert], [role=status]").length).toBe(notesBefore);
    expect(askPanel().textContent ?? "").not.toMatch(/withheld|not shared|kept back/i);
  });

  test("an_open_tab_is_focused_and_left_as_it_is", async () => {
    const held = { id: "d2", name: "Unpaid", text: "SELECT 2 -- mine", connectionId: "c7", database: "hc-backend", savedId: null, savedText: null };
    resumeRoutes({ drafts: [shown, held], work: workOf({ tabKey: "query:d2" }) });
    render(<App />);
    await screen.findByRole("tab", { name: "Unpaid" });
    await userEvent.click(screen.getByRole("tab", { name: "Late deliveries" }));
    await openAsk();
    await clickRow();
    expect(await screen.findByRole("tab", { name: "Unpaid", selected: true })).toBeTruthy();
    await waitFor(() => expect(shownEditor()).toBe("SELECT 2 -- mine"));
    // No new tab, and the open one is not touched: no From chat on it.
    expect(tabNames()).toEqual(["Late deliveries", "Unpaid"]);
    expect(statusSpans().some((t) => t?.startsWith("From chat"))).toBe(false);
  });

  test("a_gone_connection_shows_the_strip_and_opens_no_tab", async () => {
    resumeRoutes({ work: workOf({ connectionId: "c9" }), tag: () => ({ connectionId: "c9", database: "hc-backend", table: null, tabLabel: null }) });
    render(<App />);
    await openAsk();
    await clickRow();
    await waitFor(() => expect(strip()?.textContent).toBe(NOT_AVAILABLE));
    expect(callsTo("open_connection")).toEqual([]);
    expect(tabNames()).toEqual(["Late deliveries"]);
    expect(within(askPanel()).getByText(`${TITLE}?`, { selector: ".msg-user" })).toBeTruthy();
  });

  test("a_connection_in_another_desktop_is_not_available", async () => {
    resumeRoutes({ connections: [pg, { ...invoice, groupId: "g2" }] });
    render(<App />);
    await openAsk();
    await clickRow();
    await waitFor(() => expect(strip()?.textContent).toBe(NOT_AVAILABLE));
    // The place stays where it is: the Connection is not followed to Acme.
    expect(screen.getByRole("button", { name: "Switch Group, current KFC" })).toBeTruthy();
    expect(callsTo("open_connection")).toEqual([]);
    expect(tabNames()).toEqual(["Late deliveries"]);
  });

  test("a_connection_that_fails_to_open_shows_the_strip", async () => {
    resumeRoutes({
      over: {
        open_connection: () => {
          throw { kind: "connect", message: "refused" };
        },
      },
    });
    render(<App />);
    await openAsk();
    await clickRow();
    await waitFor(() => expect(strip()?.textContent).toBe(NOT_AVAILABLE));
    expect(callsTo("open_connection")).toEqual([{ id: "c7" }]);
    expect(tabNames()).toEqual(["Late deliveries"]);
  });

  test("a_home_chat_only_opens", async () => {
    const home = chatOf("t2", "group:g1", "What is a CTE", 3);
    resumeRoutes({ chats: [chat, home], tag: (t) => (t.id === "t1" ? { connectionId: "c7", database: "hc-backend", table: null, tabLabel: null } : null) });
    render(<App />);
    await openAsk();
    await clickRow("What is a CTE");
    expect(await within(askPanel()).findByText("What is a CTE?", { selector: ".msg-user" })).toBeTruthy();
    expect(callsTo("ai_thread_work")).toEqual([]);
    expect(callsTo("open_connection")).toEqual([]);
    expect(tabNames()).toEqual(["Late deliveries"]);
    expect(strip()).toBeNull();
  });

  test("resume_never_runs_the_query", async () => {
    resumeRoutes();
    render(<App />);
    await openAsk();
    await clickRow();
    await waitFor(() => expect(shownEditor()).toBe(INSERTED));
    await waitFor(() => expect(statusSpans()).toContain(`From chat: ${TITLE}`));
    for (const cmd of ["run_query", "execute_sql", "prepare_run", "confirm_run", "fetch_page", "run_visual_query"]) expect(callsTo(cmd)).toEqual([]);
  });

  test("clicking_the_open_chat_resumes_it", async () => {
    // The app reopened: the place load opens its newest chat, the one the owner then clicks.
    resumeRoutes();
    render(<App />);
    await openAsk();
    expect(callsTo("ai_thread_work")).toEqual([]);
    expect(within(askPanel()).getByRole("button", { name: "Show history" })).toBeTruthy();
    await userEvent.click(within(askPanel()).getByRole("button", { name: "Show history" }));
    const row = await screen.findByRole("button", { name: new RegExp(`^${TITLE}`) });
    expect(row.getAttribute("aria-current")).toBe("true");
    await userEvent.click(row);
    await waitFor(() => expect(callsTo("ai_thread_work")).toEqual([{ threadId: "t1" }]));
    expect(await screen.findByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
    await waitFor(() => expect(shownEditor()).toBe(INSERTED));
  });

  test("a_place_change_opens_the_newest_chat_without_resuming", async () => {
    const there = chatOf("t3", "group:g2", "Acme refunds", 9);
    resumeRoutes({ chats: [chat, there] });
    render(<App />);
    await openAsk();
    await userEvent.click(screen.getByRole("button", { name: "Switch Group, current KFC" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Acme" }));
    await screen.findByRole("button", { name: "Switch Group, current Acme" });
    expect(await within(askPanel()).findByText("Acme refunds?", { selector: ".msg-user" })).toBeTruthy();
    expect(callsTo("ai_thread_work")).toEqual([]);
    expect(callsTo("open_connection")).toEqual([]);
    expect(screen.queryByRole("tab", { name: /^Query/ })).toBeNull();
  });

  test("an_overtaken_resume_opens_no_tab", async () => {
    // invoice is slow to connect: the user picks another chat, then starts a new one, before it opens.
    let release: () => void = () => {};
    const connecting = new Promise<void>((r) => (release = r));
    const other = chatOf("t2", "group:g1", "What is a CTE", 3);
    resumeRoutes({
      chats: [chat, other],
      tag: (t) => (t.id === "t1" ? { connectionId: "c7", database: "hc-backend", table: null, tabLabel: null } : null),
      over: { open_connection: async () => (await connecting, null) },
    });
    render(<App />);
    await openAsk();
    await clickRow();
    await waitFor(() => expect(callsTo("open_connection")).toEqual([{ id: "c7" }]));
    await clickRow("What is a CTE");
    expect(await within(askPanel()).findByText("What is a CTE?", { selector: ".msg-user" })).toBeTruthy();
    await userEvent.click(within(askPanel()).getByRole("button", { name: "New chat" }));
    await act(async () => release());
    // The Connection may finish opening, but no tab opens for the chat left behind, and nothing says From chat.
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(tabNames()).toEqual(["Late deliveries"]);
    expect(screen.getByRole("tab", { name: "Late deliveries", selected: true })).toBeTruthy();
    expect(statusSpans().some((t) => t?.startsWith("From chat"))).toBe(false);
    expect(strip()).toBeNull();
  });

  test("a_chat_in_ungrouped_resumes_its_own_connection", async () => {
    // Ungrouped: no desktop on either side, so the Connection is in the shown place.
    const loosePg = { ...pg, groupId: null };
    const looseInvoice = { ...invoice, groupId: null };
    const loose = { ...chat, place: "ungrouped" };
    shellRoutes({
      last_group: () => null,
      list_connections: () => [loosePg, looseInvoice],
      load_query_tabs: ({ place }) => (place === "ungrouped" ? JSON.stringify({ version: 1, tabs: [shown] }) : null),
      list_databases: ({ id }) => (id === "c7" ? ["hc-backend", "hc-archive"] : ["kfc_shop"]),
      list_ai_threads: ({ place }) => (place === "ungrouped" ? [{ ...summaryOf(loose), work: { connectionId: "c7", database: "hc-backend", table: null, tabLabel: null } }] : []),
      get_ai_thread: () => viewOf(loose),
      ai_thread_work: () => workOf(),
      save_ai_thread: () => null,
    });
    render(<App />);
    // No last Group: startup opens Home in Ungrouped, over the place's restored tab.
    await closeHome();
    await openAsk();
    await clickRow();
    await waitFor(() => expect(callsTo("open_connection")).toEqual([{ id: "c7" }]));
    expect(await screen.findByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
    await waitFor(() => expect(shownEditor()).toBe(INSERTED));
    await waitFor(() => expect(statusSpans()).toContain(`From chat: ${TITLE}`));
    expect(strip()).toBeNull();
  });
});
