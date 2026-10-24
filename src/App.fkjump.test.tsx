// UX step 8 (G8) in the window: F4 opens the referenced row as a filtered preview tab, the tab you came from is
// kept, an open tab is reused, and Back and Forward walk back to the tab and cell, opening a closed tab again.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test, vi } from "vitest";
import type { Page } from "./api/types";
import { mockEditorDom } from "./test/editor";
import { callsTo, routeInvoke } from "./test/invoke";
import { patientFile } from "./test/load";
import { MYSQL_SHOP, ORDERS, shopPage } from "./test/shopKeys";
import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async () => () => {},
    destroy: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    isMaximized: async () => false,
    onResized: async () => () => {},
  }),
}));

patientFile();
beforeAll(() => mockEditorDom());

const shop = {
  id: "c2",
  name: "Shop",
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
const customers = [
  [87, "Budi Santoso", "budi@mail.test", "ID"],
  [214, "Ayu Lestari", "ayu@mail.test", "ID"],
];

/** M5: rows of orders the server no longer has, and whether a sort by status was asked for. */
const gone = new Set<number>();
function pages(table: string, filter: string | null, sort?: { column: string; descending: boolean } | null): Page {
  if (table === "orders") {
    const rows = ORDERS.filter((r) => !gone.has(r[0] as number));
    const by = (r: (string | number | null)[]) => String(r[3]);
    if (sort?.column === "status") rows.sort((a, b) => (sort.descending ? by(b).localeCompare(by(a)) : by(a).localeCompare(by(b))));
    return shopPage("orders", rows);
  }
  if (table === "customers") {
    const id = /`id` = (\d+)/.exec(filter ?? "")?.[1];
    return shopPage("customers", id ? customers.filter((c) => String(c[0]) === id) : customers);
  }
  return shopPage(table, []);
}

async function openOrders() {
  routeInvoke({
    ui_prefs: () => ({ theme: "dark" }),
    keymap: () => ({}),
    save_keymap: () => null,
    list_groups: () => [{ id: "g1", name: "KFC", color: "red" }],
    list_connections: () => [shop],
    last_group: () => "g1",
    set_last_group: () => null,
    suggested_connections: () => [],
    load_query_tabs: () => null,
    save_query_tabs: () => null,
    list_saved_queries: () => [],
    open_connection: () => null,
    list_databases: () => ["shop"],
    list_objects: () => ["orders", "customers", "order_items"].map((name) => ({ kind: "table", name })),
    // As the MySQL Core reads keys: the database name in the endpoints' schema.
    sql_schema: () => MYSQL_SHOP,
    fetch_page: (a) => {
      const r = a.request as { table: { name: string }; filter: string | null; sort: { column: string; descending: boolean } | null };
      return pages(r.table.name, r.filter, r.sort);
    },
  });
  render(<App />);
  const strip = await screen.findByRole("tablist", { name: "Open tabs" });
  await userEvent.click(await within(strip).findByRole("button", { name: "Close Home" }));
  await userEvent.click(await screen.findByRole("button", { name: "Open Shop" }));
  await userEvent.click(await screen.findByRole("treeitem", { name: "orders" }));
  // The keys load with the language schema: the arrow is on the key cells.
  await waitFor(() => expect(cell(2, 1).querySelector(".fk-go")).not.toBeNull());
}

const pane = () => document.querySelector(".work-pane:not([hidden]) .grid-view") as HTMLElement;
const cell = (row: number, col: number) => pane()?.querySelector(`tr[data-row="${row}"] td[data-col="${col}"]`) as HTMLElement;
const note = () => pane()?.querySelector(".grid-note")?.textContent ?? "";
const activeTab = () => within(screen.getByRole("tablist", { name: "Open tabs" })).getByRole("tab", { selected: true }).getAttribute("aria-label");
const keyIn = (el: Element, key: string, extra: object = {}) => fireEvent.keyDown(el, { key, code: key, ...extra });
const selected = () =>
  Array.from(pane().querySelectorAll<HTMLElement>('td[aria-selected="true"]')).map((c) => `${c.closest("tr")!.getAttribute("data-row")}:${c.getAttribute("data-col")}`);

test("f4_opens_the_referenced_row_as_a_filtered_preview_and_back_and_forward_return_to_the_cell", async () => {
  await openOrders();
  fireEvent.mouseDown(cell(2, 1), { button: 0 });
  keyIn(pane().querySelector(".grid-scroll")!, "F4");
  await waitFor(() => expect(activeTab()).toMatch(/^customers/));
  await waitFor(() => expect(note()).toBe("Opened from orders, row 3. Alt+Left goes back."));
  // One fetch for the target, already filtered by the key, with a chip for it.
  const filters = callsTo("fetch_page").filter((c) => (c.request as { table: { name: string } }).table.name === "customers");
  expect(filters.map((c) => (c.request as { filter: string | null }).filter)).toEqual(["`id` = 214"]);
  expect(pane().querySelector(".filter-chip")).not.toBeNull();
  expect(selected()).toEqual(["0:0", "0:1", "0:2", "0:3"]);
  expect(document.activeElement).toBe(pane().querySelector(".grid-scroll"));
  // Alt+Left from the grid: back on orders, the same cell.
  keyIn(document.activeElement!, "ArrowLeft", { altKey: true });
  await waitFor(() => expect(activeTab()).toMatch(/^orders/));
  await waitFor(() => expect(note()).toBe("Back on orders.customer_id of row 3."));
  expect(selected()).toEqual(["2:1"]);
  // Alt+Right: forward to customers.
  keyIn(document.activeElement!, "ArrowRight", { altKey: true });
  await waitFor(() => expect(activeTab()).toMatch(/^customers/));
  await waitFor(() => expect(note()).toMatch(/^Forward to customers\.id of row 1/));
  // The header's Back button does the same.
  fireEvent.click(within(pane()).getByRole("button", { name: "Back" }));
  await waitFor(() => expect(activeTab()).toMatch(/^orders/));
});

test("the_tab_you_came_from_is_kept_and_back_opens_a_closed_tab_again", async () => {
  await openOrders();
  const strip = screen.getByRole("tablist", { name: "Open tabs" });
  const preview = () => within(strip).getByRole("tab", { name: /^orders/ }).closest(".work-tab")?.className.includes("preview") ?? false;
  expect(preview()).toBe(true);
  fireEvent.mouseDown(cell(0, 1), { button: 0 });
  keyIn(pane().querySelector(".grid-scroll")!, "b", { code: "KeyB", ctrlKey: true });
  await waitFor(() => expect(activeTab()).toMatch(/^customers/));
  // orders was a preview: following a key from it keeps it (VS Code), so customers did not take its place.
  expect(within(strip).getAllByRole("tab").map((t) => t.getAttribute("aria-label")?.split(",")[0])).toEqual(["orders", "customers"]);
  expect(preview()).toBe(false);
  await userEvent.click(within(strip).getByRole("button", { name: /^Close orders/ }));
  await waitFor(() => expect(within(strip).queryByRole("tab", { name: /^orders/ })).toBeNull());
  // Ctrl+Alt+Left works wherever focus is, here on a strip tab.
  const tab = within(strip).getByRole("tab", { name: /^customers/ });
  tab.focus();
  keyIn(tab, "ArrowLeft", { altKey: true, ctrlKey: true });
  await waitFor(() => expect(activeTab()).toMatch(/^orders/));
  await waitFor(() => expect(note()).toBe("Back on orders.customer_id of row 1."));
});

test("alt_left_on_a_strip_tab_keeps_its_move_and_is_not_back", async () => {
  await openOrders();
  fireEvent.mouseDown(cell(0, 1), { button: 0 });
  keyIn(pane().querySelector(".grid-scroll")!, "F4");
  await waitFor(() => expect(activeTab()).toMatch(/^customers/));
  const strip = screen.getByRole("tablist", { name: "Open tabs" });
  const tab = within(strip).getByRole("tab", { name: /^customers/ });
  tab.focus();
  keyIn(tab, "ArrowLeft", { altKey: true });
  // The tab moved left of orders; customers is still the tab shown.
  await waitFor(() => expect(within(strip).getAllByRole("tab").map((t) => t.getAttribute("aria-label")?.split(",")[0])).toEqual(["customers", "orders"]));
  expect(activeTab()).toMatch(/^customers/);
});

test("a_tab_of_the_target_opened_from_the_tree_is_reused_and_the_note_names_the_filter_it_replaced", async () => {
  await openOrders();
  const strip = screen.getByRole("tablist", { name: "Open tabs" });
  const names = () => within(strip).getAllByRole("tab").map((t) => t.getAttribute("aria-label")?.split(",")[0]);
  // orders kept, then customers opened from the tree (a double click keeps it).
  await userEvent.dblClick(within(strip).getByRole("tab", { name: /^orders/ }));
  await userEvent.dblClick(screen.getByRole("treeitem", { name: "customers" }));
  await waitFor(() => expect(names()).toEqual(["orders", "customers"]));
  await userEvent.click(within(strip).getByRole("tab", { name: /^orders/ }));
  await waitFor(() => expect(cell(1, 1)?.querySelector(".fk-go")).toBeTruthy());
  fireEvent.mouseDown(cell(1, 1), { button: 0 });
  keyIn(pane().querySelector(".grid-scroll")!, "F4");
  await waitFor(() => expect(note()).toBe("Opened from orders, row 2. Alt+Left goes back."));
  expect(names()).toEqual(["orders", "customers"]);
  await userEvent.click(within(strip).getByRole("tab", { name: /^orders/ }));
  await waitFor(() => expect(cell(2, 1)).toBeTruthy());
  fireEvent.mouseDown(cell(2, 1), { button: 0 });
  keyIn(pane().querySelector(".grid-scroll")!, "F4");
  await waitFor(() => expect(note()).toBe("Opened from orders, row 3. Its filter id = 87 was replaced. Alt+Left goes back."));
  // The one customers tab, not a second one.
  expect(names()).toEqual(["orders", "customers"]);
});

test("M5: back opens the closed tab again with its sort and finds the row by its key after the rows changed", async () => {
  gone.clear();
  await openOrders();
  const strip = screen.getByRole("tablist", { name: "Open tabs" });
  // Sort by status, newest letters first: shipped 1002, pending 1003, pending 1008, paid 1001, paid 1006.
  fireEvent.click(within(pane()).getByRole("button", { name: "Sort by status" }));
  fireEvent.click(within(pane()).getByRole("button", { name: "Sort by status" }));
  await waitFor(() => expect(cell(1, 0).textContent).toBe("1003"));
  fireEvent.mouseDown(cell(1, 1), { button: 0 });
  keyIn(pane().querySelector(".grid-scroll")!, "F4");
  await waitFor(() => expect(activeTab()).toMatch(/^customers/));
  await userEvent.click(within(strip).getByRole("button", { name: /^Close orders/ }));
  await waitFor(() => expect(within(strip).queryByRole("tab", { name: /^orders/ })).toBeNull());
  // Meanwhile 1002 was deleted: 1003 is now the first row.
  gone.add(1002);
  const tab = within(strip).getByRole("tab", { name: /^customers/ });
  tab.focus();
  keyIn(tab, "ArrowLeft", { altKey: true, ctrlKey: true });
  await waitFor(() => expect(activeTab()).toMatch(/^orders/));
  await waitFor(() => expect(note()).toBe("Back on orders.customer_id of row 1."));
  expect(selected()).toEqual(["0:1"]);
  expect(cell(0, 0).textContent).toBe("1003");
  const orderFetches = callsTo("fetch_page").filter((c) => (c.request as { table: { name: string } }).table.name === "orders");
  const last = orderFetches[orderFetches.length - 1];
  expect((last.request as { sort: unknown }).sort).toEqual({ column: "status", descending: true });
  gone.clear();
});
