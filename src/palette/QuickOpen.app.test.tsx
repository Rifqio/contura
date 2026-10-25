import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import App from "../App";
import { callsTo, routeInvoke } from "../test/invoke";
import { mockEditorDom } from "../test/editor";
import { patientFile } from "../test/load";
import { objectNames } from "./nameIndex";
import { treeName } from "../test/treeName";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
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
  mockEditorDom();
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  localStorage.clear();
  for (const id of ["c1", "c2"]) objectNames.forget(id);
});

const group = { id: "g1", name: "KFC", color: "red" };
const shop = {
  id: "c1",
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
  production: true,
  readOnly: false,
};
const page = {
  columns: [{ name: "id", typeName: "int", isPrimaryKey: true }],
  rows: [[{ t: "number", value: "1" }]],
  hasMore: false,
};
const ordersTarget = { kind: "table", path: { database: "shop", schema: null, name: "orders" }, object: "table" };

function routes(over: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  routeInvoke({
    ui_prefs: () => ({ theme: "dark" }),
    keymap: () => ({}),
    save_keymap: () => null,
    list_groups: () => [group],
    list_connections: () => [shop],
    last_group: () => "g1",
    suggested_connections: () => [],
    load_query_tabs: () => null,
    save_query_tabs: () => null,
    list_saved_queries: () => [],
    open_connection: () => null,
    open_query_session: () => "s1",
    close_query_session: () => null,
    list_databases: () => ["shop"],
    list_objects: () => [
      { kind: "table", name: "orders", rows: 3 },
      { kind: "table", name: "customers", rows: 2 },
      { kind: "view", name: "order_totals", rows: null },
    ],
    fetch_page: () => page,
    set_last_group: () => null,
    sql_schema: () => ({ tables: [], functions: [] }),
    record_recent: () => null,
    recent_items: () => [],
    list_diagrams: () => [],
    ...over,
  });
}

const strip = () => screen.getByRole("tablist", { name: "Open tabs" });
const tab = (name: RegExp) => within(strip()).getByRole("tab", { name });
const isPreview = (name: RegExp) => tab(name).closest(".work-tab")!.className.includes("work-tab-preview");
const box = () => screen.getByRole("combobox");
const optionNames = () => screen.queryAllByRole("option").map((o) => o.querySelector(".qo-label")!.textContent);

async function closeHome() {
  await userEvent.click(await within(await screen.findByRole("tablist", { name: "Open tabs" })).findByRole("button", { name: "Close Home" }));
  await waitFor(() => expect(screen.queryByRole("tab", { name: "Home" })).toBeNull());
}

async function openShop() {
  render(<App />);
  await closeHome();
  await userEvent.click(await screen.findByRole("button", { name: "Open KFC Shop" }));
  await screen.findByRole("treeitem", { name: treeName("orders") });
}

test("ctrl_p_and_ctrl_k_open_quick_open_and_esc_puts_focus_back", async () => {
  routes();
  await openShop();
  const row = screen.getByRole("treeitem", { name: treeName("orders") });
  row.focus();
  await userEvent.keyboard("{Control>}p{/Control}");
  expect(screen.getByRole("dialog", { name: "Quick Open" })).toBeTruthy();
  expect(document.activeElement).toBe(box());
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Quick Open" })).toBeNull();
  expect(document.activeElement).toBe(row);
  await userEvent.keyboard("{Control>}k{/Control}");
  expect(screen.getByRole("dialog", { name: "Quick Open" })).toBeTruthy();
});

test("ctrl_p_never_reaches_the_webview", async () => {
  routes();
  render(<App />);
  await screen.findByRole("button", { name: "Switch Group, current KFC" });
  const e = new KeyboardEvent("keydown", { key: "p", code: "KeyP", ctrlKey: true, bubbles: true, cancelable: true });
  document.body.dispatchEvent(e);
  expect(e.defaultPrevented).toBe(true);
});

test("enter_opens_a_kept_tab_with_focus_in_it_and_makes_an_open_preview_kept", async () => {
  routes();
  await openShop();
  // A single click previews (item 1).
  await userEvent.click(screen.getByRole("treeitem", { name: treeName("orders") }));
  await waitFor(() => expect(isPreview(/orders/)).toBe(true));
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(box(), "cust");
  expect(optionNames()[0]).toBe("customers");
  expect(screen.getAllByRole("option")[0].textContent).toContain("KFC Shop");
  await userEvent.keyboard("{Enter}");
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(tab(/customers/).getAttribute("aria-selected")).toBe("true"));
  // Chosen by name, so meant: kept, and the preview stays where it was.
  expect(isPreview(/customers/)).toBe(false);
  expect(isPreview(/orders/)).toBe(true);
  await waitFor(() => expect(document.activeElement?.closest(".work-pane:not([hidden])")).toBeTruthy());
  // An open tab is shown again, not opened twice; a preview becomes kept.
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(box(), "orders");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(tab(/orders/).getAttribute("aria-selected")).toBe("true"));
  expect(within(strip()).getAllByRole("tab", { name: /orders/ })).toHaveLength(1);
  expect(isPreview(/orders/)).toBe(false);
});

test("right_arrow_opens_behind_and_the_list_stays", async () => {
  routes();
  await openShop();
  await userEvent.keyboard("{Control>}t{/Control}");
  await waitFor(() => expect(tab(/Query 1/).getAttribute("aria-selected")).toBe("true"));
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(box(), "order_t");
  await userEvent.keyboard("{ArrowRight}");
  expect(await within(strip()).findByRole("tab", { name: /order_totals/ })).toBeTruthy();
  expect(tab(/Query 1/).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("dialog", { name: "Quick Open" })).toBeTruthy();
  expect(document.activeElement).toBe(box());
});

test("a_closed_connections_table_from_recent_opens_the_connection_first", async () => {
  routes({ recent_items: () => [{ target: ordersTarget, connectionId: "c1", openedAtMs: Date.now() - 60_000 }] });
  render(<App />);
  await closeHome();
  await userEvent.keyboard("{Control>}p{/Control}");
  const first = await screen.findByRole("option", { name: /orders/ });
  expect(first.textContent).toContain("closed");
  expect(first.textContent).toContain("recently opened");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(callsTo("open_connection")).toEqual([{ id: "c1" }]));
  await waitFor(() => expect(tab(/orders/).getAttribute("aria-selected")).toBe("true"));
  expect(isPreview(/orders/)).toBe(false);
});

test("names_kept_from_a_schema_load_still_open_after_the_connection_closes", async () => {
  routes({ close_connection: () => null });
  await openShop();
  await userEvent.click(screen.getByRole("button", { name: "More actions for KFC Shop" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Close Connection" }));
  await waitFor(() => expect(screen.queryByRole("treeitem", { name: treeName("orders") })).toBeNull());
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(box(), "custo");
  const row = screen.getByRole("option", { name: /customers/ });
  expect(row.textContent).toContain("closed");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(callsTo("open_connection")).toHaveLength(2));
  await waitFor(() => expect(tab(/customers/).getAttribute("aria-selected")).toBe("true"));
});

test("the_palette_lists_registry_commands_with_categories_and_live_keys_and_hides_what_cannot_run", async () => {
  routes({ keymap: () => ({ "query.new": ["Ctrl+Q"] }) });
  render(<App />);
  await closeHome();
  await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
  expect(screen.getByRole("dialog", { name: "Command Palette" })).toBeTruthy();
  expect((box() as HTMLInputElement).value).toBe(">");
  const names = optionNames();
  const row = screen.getByRole("option", { name: /Query: New query/ });
  expect([...row.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["Ctrl+Q"]);
  expect(names).toContain("View: Settings");
  expect(names).toContain("Groups: Open Group 1");
  expect(screen.getByRole("option", { name: /Groups: Open Group 1/ }).textContent).toContain("KFC");
  // No table, query, Visual Query or diagram tab, and no Connection open: their commands are hidden.
  for (const hidden of ["Data: Export...", "Diagram: Rename diagram", "Query: Run the current statement", "Tree: Refresh schema", "Tabs: Close tab", "Groups: Open Group 3"]) {
    expect(names).not.toContain(hidden);
  }
  // Names in A to Z order with nothing used yet.
  expect([...names].sort((a, b) => a!.localeCompare(b!))).toEqual(names);
  await userEvent.type(box(), "new q");
  await userEvent.keyboard("{Enter}");
  expect(await within(strip()).findByRole("tab", { name: /Query 1/, selected: true })).toBeTruthy();
  // Recently used first next time.
  await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
  const first = screen.getAllByRole("option")[0];
  expect(first.querySelector(".qo-label")!.textContent).toBe("Query: New query");
  expect(first.textContent).toContain("recently used");
  // On a query tab its editor commands show.
  expect(optionNames()).toContain("Query: Run the current statement");
  expect(optionNames()).toContain("Tabs: Close tab");
});

test("backspace_over_gt_goes_back_to_quick_open", async () => {
  routes();
  render(<App />);
  await closeHome();
  await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
  await userEvent.keyboard("{Backspace}");
  expect(screen.getByRole("dialog", { name: "Quick Open" })).toBeTruthy();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("an_empty_box_with_nothing_recent_says_so_while_typing", async () => {
  routes();
  render(<App />);
  await closeHome();
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(box(), "zzz");
  expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toBe("No matching results. Open a Connection to search its tables.");
});

test("enter_on_the_tab_already_shown_puts_focus_in_it_and_leaves_nothing_behind", async () => {
  routes();
  await openShop();
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(box(), "orders");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(tab(/orders/).getAttribute("aria-selected")).toBe("true"));
  // From the tree, Quick Open on the tab already shown: focus goes into it (VS Code).
  screen.getByRole("treeitem", { name: treeName("customers") }).focus();
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(box(), "orders");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(document.activeElement?.closest(".work-pane:not([hidden])")).toBeTruthy());
  // Nothing is left armed: a later tree click keeps focus in the tree.
  const row = screen.getByRole("treeitem", { name: treeName("customers") });
  await userEvent.click(row);
  await waitFor(() => expect(tab(/customers/).getAttribute("aria-selected")).toBe("true"));
  expect(document.activeElement?.closest('[role="tree"]')).toBeTruthy();
});

test("ctrl_k_and_ctrl_p_in_the_sql_editor_open_quick_open_and_type_nothing", async () => {
  routes();
  render(<App />);
  await closeHome();
  await userEvent.keyboard("{Control>}t{/Control}");
  await within(strip()).findByRole("tab", { name: /Query 1/, selected: true });
  const content = await waitFor(() => document.querySelector<HTMLElement>(".work-pane:not([hidden]) .cm-content")!);
  const view = EditorView.findFromDOM(content)!;
  view.dispatch({ changes: { from: 0, insert: "SELECT 1" } });
  view.focus();
  for (const keys of ["{Control>}k{/Control}", "{Control>}p{/Control}", "{Control>}{Shift>}p{/Shift}{/Control}"]) {
    await userEvent.keyboard(keys);
    expect(screen.getByRole("dialog")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    // Focus is back in the editor and nothing was typed or deleted there.
    expect(content.contains(document.activeElement)).toBe(true);
    expect(view.state.doc.toString()).toBe("SELECT 1");
  }
});
