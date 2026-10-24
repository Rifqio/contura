// UX step 8 (G8): follow a Foreign Key in the table grid, gesture by gesture as the ForeignKeys board clicks through
// them, with the rulings: the arrow on row hover and the active cell, F4 and Ctrl+B, a picker for a column in two
// keys, Alt+F7 with counts, notes that say why, and a filtered tab that says where it came from.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Page } from "../api/types";
import { LangClient } from "../lang/client";
import { SchemaCache } from "../lang/sql/schemaCache";
import { callsTo, routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { ORDERS, SHOP_SCHEMA, shopPage } from "../test/shopKeys";
import { setPlatformForTests } from "../platform";
import { forgetSlowForTests } from "../grid/keyCounts";
import { type GridJump, rowFiltersOf } from "../grid/foreignKeys";
import appCss from "../styles/app.css?raw";
import DataGrid, { type GridControl } from "./DataGrid";
import { ToastProvider } from "./Toast";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const at = (name: string) => ({ database: "shop", schema: "public", name });
const grid = () => document.querySelector(".grid-scroll") as HTMLElement;
const td = (row: number, col: number) => document.querySelector(`tr[data-row="${row}"] td[data-col="${col}"]`) as HTMLElement;
const note = () => document.querySelector(".grid-note")?.textContent ?? "";
const down = (el: HTMLElement) => fireEvent.mouseDown(el, { button: 0 });
const press = (key: string, extra: object = {}) => fireEvent.keyDown(grid(), { key, code: key, ...extra });
const selectedCells = () =>
  Array.from(document.querySelectorAll<HTMLElement>('td[aria-selected="true"]')).map(
    (c) => `${c.closest("tr")!.getAttribute("data-row")}:${c.getAttribute("data-col")}`,
  );
const picker = () => screen.getByRole("listbox");
const options = () => within(picker()).getAllByRole("option");
const optionText = () => options().map((o) => o.textContent);
const active = () => options().find((o) => o.getAttribute("aria-selected") === "true")?.getAttribute("data-table");

/** Pages by table, and the rows the counts find by their filter; "timedOut" is a count the server stopped. */
type Pages = Record<string, Page | "timedOut" | ((filter: string | null) => Page | Promise<Page>)>;

beforeEach(() => setPlatformForTests("linux"));
afterEach(() => {
  setPlatformForTests(null);
  forgetSlowForTests();
});

async function open(
  name: string,
  pages: Pages,
  props: Partial<Parameters<typeof DataGrid>[0]> = {},
  wait = true,
  extra: Parameters<typeof routeInvoke>[0] = {},
) {
  routeInvoke({
    sql_schema: () => SHOP_SCHEMA,
    fetch_page: (a) => {
      const req = a.request as { table: { name: string }; filter: string | null };
      const p = pages[req.table.name];
      if (!p || p === "timedOut") throw new Error(`no page for ${req.table.name}`);
      return typeof p === "function" ? p(req.filter) : p;
    },
    // The Core's count: the matching rows, 1,001 for more than 1,000.
    count_rows: async (a) => {
      const req = a.request as { table: { name: string }; filter: string | null };
      const p = pages[req.table.name];
      if (!p) throw new Error(`no count for ${req.table.name}`);
      if (p === "timedOut") return { kind: "timedOut" };
      const page = typeof p === "function" ? await p(req.filter) : p;
      return { kind: "counted", rows: page.rows.length + (page.hasMore ? 1 : 0) };
    },
    ...extra,
  });
  const client = new LangClient(() => fakeWorker());
  const lang = { client, schemas: new SchemaCache(client) };
  const onFollow = vi.fn();
  const utils = render(
    <ToastProvider>
      <DataGrid connectionId="c1" table={at(name)} onClose={() => {}} dialect="postgres" lang={lang} onFollow={onFollow} {...props} />
    </ToastProvider>,
  );
  if (wait) {
    await waitFor(() => expect(document.querySelector('tr[data-row="0"]')).not.toBeNull());
    // The keys load with the language schema.
    await waitFor(() => expect(lang.schemas.state("c1", "shop")).toBe("loaded"));
  }
  return { onFollow, lang, ...utils };
}

const ordersPage = () => shopPage("orders", ORDERS);

test("the_arrow_is_on_key_cells_with_a_value_never_on_null_and_shows_on_row_hover_and_the_active_cell", async () => {
  await open("orders", { orders: ordersPage(), order_items: shopPage("order_items", []) });
  // Row 1001: customer_id and ship_address_id are keys.
  const go = td(0, 1).querySelector(".fk-go") as HTMLElement;
  expect(go).not.toBeNull();
  expect(go.getAttribute("title")).toBe("Go to customers where id = 214 (F4)");
  expect(td(0, 1).classList.contains("fk-cell")).toBe(true);
  expect(td(0, 2).querySelector(".fk-go")!.getAttribute("title")).toBe("Go to addresses where id = 31 (F4)");
  // Not on other columns, and never on NULL: 1008 has no customer; its cell says why.
  expect(td(0, 3).querySelector(".fk-go")).toBeNull();
  expect(td(4, 1).querySelector(".fk-go")).toBeNull();
  expect(td(4, 1).getAttribute("title")).toBe("NULL: no row to go to");
  // A NULL key cell keeps the slot, so key columns line up.
  expect(td(4, 1).classList.contains("fk-cell")).toBe(true);
  // CSS: hidden at rest; shown on the hovered row and on the active cell; a free slot so the value never moves.
  const css = appCss.replace(/\s+/g, " ");
  expect(css).toMatch(/\.grid td\.fk-cell \{[^}]*padding-right: 26px/);
  expect(css).toMatch(/\.grid td \.fk-go \{[^}]*display: none/);
  expect(css).toMatch(/\.grid tr:hover td \.fk-go, \.grid td\.cell-selected \.fk-go \{[^}]*display: flex/);
});

test("f4_ctrl_b_and_the_arrow_go_to_the_referenced_row", async () => {
  const { onFollow } = await open("orders", { orders: ordersPage(), order_items: shopPage("order_items", []) });
  down(td(2, 1));
  press("F4");
  expect(onFollow).toHaveBeenCalledTimes(1);
  expect(onFollow.mock.calls[0][0]).toMatchObject({
    way: { dir: "out", path: at("customers"), filters: [{ column: "id", value: "214" }] },
    from: { table: "orders", row: 3 },
  });
  press("b", { code: "KeyB", ctrlKey: true });
  expect(onFollow).toHaveBeenCalledTimes(2);
  expect(onFollow.mock.calls[1][0].way.path).toEqual(at("customers"));
  // The arrow on another row's key selects that cell and follows it.
  const go = td(0, 2).querySelector(".fk-go") as HTMLElement;
  fireEvent.mouseDown(go, { button: 0 });
  fireEvent.click(go);
  expect(onFollow).toHaveBeenCalledTimes(3);
  expect(onFollow.mock.calls[2][0]).toMatchObject({ way: { path: at("addresses"), filters: [{ column: "id", value: "31" }] }, from: { row: 1 } });
  expect(selectedCells()).toEqual(["0:2"]);
});

test("a_null_key_opens_nothing_and_the_note_and_the_menu_say_why", async () => {
  const { onFollow } = await open("orders", { orders: ordersPage(), order_items: shopPage("order_items", []) });
  down(td(4, 1));
  press("F4");
  expect(onFollow).not.toHaveBeenCalled();
  expect(note()).toBe("customer_id is NULL: there is no customers row to go to.");
  fireEvent.contextMenu(td(4, 1));
  const item = screen.getByRole("menuitem", { name: "Go to referenced row" });
  expect((item as HTMLButtonElement).disabled).toBe(true);
  expect(item.getAttribute("title")).toBe("customer_id is NULL: no row to go to");
});

test("the_cell_menu_has_go_to_and_rows_that_point_here_after_open_full_value", async () => {
  const { onFollow } = await open("orders", { orders: ordersPage(), order_items: shopPage("order_items", []) });
  fireEvent.contextMenu(td(0, 1));
  const items = Array.from(document.querySelectorAll<HTMLElement>(".tree-menu [role=menuitem]"));
  const labels = items.map((b) => b.getAttribute("aria-label"));
  const i = labels.indexOf("Open full value");
  expect(labels.slice(i - 1, i + 3)).toEqual(["Filter by this value", "Open full value", "Go to referenced row", "Rows that point here..."]);
  expect(items[i + 1].querySelector(".menu-shortcut")?.textContent).toBe("F4");
  expect(items[i + 2].querySelector(".menu-shortcut")?.textContent).toBe("Alt+F7");
  expect(items[i + 1].getAttribute("title")).toBe("Opens customers where id = 214");
  expect(items[i + 1].previousElementSibling?.classList.contains("menu-separator")).toBe(true);
  fireEvent.click(items[i + 1]);
  expect(onFollow).toHaveBeenCalledTimes(1);
  expect(onFollow.mock.calls[0][0].way.path).toEqual(at("customers"));
});

const items = () =>
  shopPage("order_items", [
    [1, 1001, 5, "IDR", 1],
    [6, 1007, 6, null, 1],
  ]);

test("a_column_in_two_keys_opens_a_picker_and_a_key_with_a_null_part_is_off_with_the_reason", async () => {
  const { onFollow } = await open("order_items", { order_items: items() });
  down(td(0, 2));
  press("F4");
  expect(picker().getAttribute("aria-label")).toBe("Go to");
  expect(optionText()).toEqual(["productsid = 5via product_id", "product_pricesproduct_id = 5 AND currency = IDR"]);
  expect(options()[1].getAttribute("title")).toBe("order_items_price_fk: (product_id, currency) → product_prices(product_id, currency)");
  expect(document.activeElement).toBe(picker());
  // Down and Up wrap.
  fireEvent.keyDown(picker(), { key: "ArrowDown" });
  expect(active()).toBe("product_prices");
  fireEvent.keyDown(picker(), { key: "ArrowDown" });
  expect(active()).toBe("products");
  fireEvent.keyDown(picker(), { key: "ArrowUp" });
  expect(active()).toBe("product_prices");
  fireEvent.keyDown(picker(), { key: "Enter" });
  expect(onFollow.mock.calls[0][0].way).toMatchObject({
    path: at("product_prices"),
    filters: [
      { column: "product_id", value: "5" },
      { column: "currency", value: "IDR" },
    ],
  });
  expect(screen.queryByRole("listbox")).toBeNull();
  // Row 6 has no currency: the two-column key is listed but off, with the reason, and Down skips it.
  down(td(1, 2));
  press("F4");
  expect(options()[1].getAttribute("aria-disabled")).toBe("true");
  expect(options()[1].textContent).toContain("currency is NULL");
  fireEvent.keyDown(picker(), { key: "ArrowDown" });
  expect(active()).toBe("products");
  fireEvent.click(options()[1]);
  expect(onFollow).toHaveBeenCalledTimes(1);
  // Esc closes, and focus is back on the cell.
  fireEvent.keyDown(picker(), { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(grid());
  // The arrow on a two-key cell opens the picker too; a click outside closes it.
  fireEvent.click(td(0, 2).querySelector(".fk-go")!);
  expect(picker()).toBeTruthy();
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("f4_on_a_cell_that_is_not_a_key_shows_the_related_rows_both_ways", async () => {
  const { onFollow } = await open("orders", {
    orders: ordersPage(),
    order_items: (f) => shopPage("order_items", f === `"order_id" = 1003` ? [[3, 1003, 2, "SGD", 2], [4, 1003, 7, "SGD", 1]] : []),
  });
  down(td(2, 3));
  press("F4");
  expect(picker().getAttribute("aria-label")).toBe("Related rows");
  expect(Array.from(picker().querySelectorAll(".key-picker-group")).map((g) => g.textContent)).toEqual(["Goes to", "Points here"]);
  await waitFor(() => expect(optionText()).toEqual(["customersid = 214via customer_id", "addressesid = 32via ship_address_id", "order_itemsby order_id2 rows"]));
  fireEvent.click(options()[2]);
  expect(onFollow.mock.calls[0][0]).toMatchObject({
    way: { dir: "in", path: at("order_items"), filters: [{ column: "order_id", value: "1003" }] },
    from: { table: "orders", row: 3, key: [{ column: "id", value: "1003" }] },
  });
});

const customers = () => shopPage("customers", [[214, "Ayu Lestari", "ayu@mail.test", "ID"], [120, "Gita Maharani", "gita@mail.test", "SG"]]);

test("alt_f7_lists_the_tables_that_point_here_with_counts", async () => {
  const many = Array.from({ length: 1000 }, (_, i) => [i, 214, "Jakarta", "x"]);
  const { onFollow } = await open("customers", {
    customers: customers(),
    orders: (f) => shopPage("orders", f === `"customer_id" = 214` ? ORDERS.slice(0, 3) : []),
    addresses: (f) => shopPage("addresses", f === `"customer_id" = 214` ? many : [], f === `"customer_id" = 214`),
  });
  down(td(0, 0));
  press("F7", { altKey: true });
  expect(picker().getAttribute("aria-label")).toBe("Rows that point here");
  await waitFor(() => expect(optionText()).toEqual(["ordersby customer_id3 rows", "addressesby customer_id1,000+ rows"]));
  // The counts are the Core's, with the key as the filter.
  expect(callsTo("count_rows").map((c) => (c.request as { filter: string | null }).filter)).toContain(`"customer_id" = 214`);
  fireEvent.keyDown(picker(), { key: "Enter" });
  expect(onFollow.mock.calls[0][0]).toMatchObject({ way: { dir: "in", path: at("orders") }, from: { key: [{ column: "id", value: "214" }] } });
  // Gita: nothing points to her row, so both are off and the note says so.
  down(td(1, 0));
  press("F7", { altKey: true });
  await waitFor(() => expect(optionText()).toEqual(["ordersby customer_idnone", "addressesby customer_idnone"]));
  expect(options().every((o) => o.getAttribute("aria-disabled") === "true")).toBe(true);
  fireEvent.keyDown(picker(), { key: "Enter" });
  expect(onFollow).toHaveBeenCalledTimes(1);
});

test("counts_time_out_on_a_slow_connection_and_are_skipped_on_a_closed_one", async () => {
  let answer: (p: Page) => void = () => {};
  await open("customers", { customers: customers(), orders: "timedOut", addresses: () => new Promise<Page>((r) => (answer = r)) });
  down(td(0, 0));
  press("F7", { altKey: true });
  expect(optionText()).toEqual(["ordersby customer_idcounting", "addressesby customer_idcounting"]);
  await waitFor(() => expect(optionText()[0]).toBe("ordersby customer_idnot counted, slow"));
  // A table that was not counted can still be opened.
  expect(options()[0].getAttribute("aria-disabled")).toBe("false");
  // After a count the server stopped, the Connection's next counts are skipped for a while.
  answer(shopPage("addresses", []));
  await waitFor(() => expect(optionText()[1]).toBe("addressesby customer_idnot counted"));
});

test("closing_the_list_drops_the_counts_still_waiting_their_turn", async () => {
  let answer: (p: Page) => void = () => {};
  await open("customers", { customers: customers(), orders: () => new Promise<Page>((r) => (answer = r)), addresses: shopPage("addresses", []) });
  down(td(0, 0));
  press("F7", { altKey: true });
  // One count at a time on a Connection: addresses waits for orders.
  await waitFor(() => expect(callsTo("count_rows")).toHaveLength(1));
  fireEvent.keyDown(picker(), { key: "Escape" });
  answer(shopPage("orders", []));
  await new Promise((r) => setTimeout(r, 20));
  expect(callsTo("count_rows")).toHaveLength(1);
});

test("a_closed_connection_lists_the_tables_without_counting", async () => {
  await open("customers", { customers: customers() }, { open: false });
  down(td(0, 0));
  press("F7", { altKey: true });
  await waitFor(() => expect(optionText()).toEqual(["ordersby customer_idnot counted", "addressesby customer_idnot counted"]));
  expect(callsTo("count_rows")).toHaveLength(0);
});

test("one_table_pointing_here_opens_at_once_and_none_says_so", async () => {
  const { onFollow } = await open("orders", {
    orders: ordersPage(),
    order_items: (f) => shopPage("order_items", f === `"order_id" = 1003` ? [[3, 1003, 2, "SGD", 2]] : []),
  });
  down(td(2, 0));
  press("F7", { altKey: true });
  await waitFor(() => expect(onFollow).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(onFollow.mock.calls[0][0].way.path).toEqual(at("order_items"));
  // 1001 has no items: the list shows the table off, and the note says nothing points here.
  down(td(0, 0));
  press("F7", { altKey: true });
  await waitFor(() => expect(note()).toBe("No rows point to this orders row."));
  expect(options()[0].getAttribute("aria-disabled")).toBe("true");
  expect(onFollow).toHaveBeenCalledTimes(1);
});

const jumpTo = (filters: { column: string; value: string }[], say: GridJump["say"], seq = 1, wholeRow = true): GridJump => ({
  seq,
  filters: rowFiltersOf(filters),
  where: filters.map((f) => `"${f.column}" = '${f.value}'`).join(" AND "),
  page: 0,
  select: { row: 0, column: filters[filters.length - 1].column, wholeRow },
  say,
});

test("a_followed_key_opens_filtered_with_the_row_selected_and_says_where_it_came_from", async () => {
  const jump = jumpTo([{ column: "id", value: "214" }], { kind: "out", fromTable: "orders", fromRow: 3 });
  await open("customers", { customers: () => shopPage("customers", [[214, "Ayu Lestari", "ayu@mail.test", "ID"]]) }, { jump }, false);
  await screen.findByText("Ayu Lestari");
  // One fetch, already filtered: the tab never shows every row first.
  expect(callsTo("fetch_page").map((c) => (c.request as { filter: string | null }).filter)).toEqual([`"id" = '214'`]);
  expect(document.querySelector(".filter-chip")!.textContent).toContain("id");
  await waitFor(() => expect(selectedCells()).toEqual(["0:0", "0:1", "0:2", "0:3"]));
  expect(td(0, 0).classList.contains("cell-selected")).toBe(true);
  expect(note()).toBe("Opened from orders, row 3. Alt+Left goes back.");
  // The row flashes once.
  expect(document.querySelector('tr[data-row="0"]')!.classList.contains("row-jumped")).toBe(true);
});

test("a_reused_tab_takes_the_new_filter_and_names_the_one_it_replaced", async () => {
  const one = jumpTo([{ column: "id", value: "214" }], { kind: "out", fromTable: "orders", fromRow: 3 });
  const pages: Pages = { customers: (f) => shopPage("customers", f === `"id" = '87'` ? [[87, "Budi Santoso", "budi@mail.test", "ID"]] : [[214, "Ayu Lestari", "ayu@mail.test", "ID"]]) };
  const { rerender, lang, onFollow } = await open("customers", pages, { jump: one }, false);
  await screen.findByText("Ayu Lestari");
  const two = jumpTo([{ column: "id", value: "87" }], { kind: "out", fromTable: "orders", fromRow: 2 }, 2);
  rerender(
    <ToastProvider>
      <DataGrid connectionId="c1" table={at("customers")} onClose={() => {}} dialect="postgres" lang={lang} onFollow={onFollow} jump={two} />
    </ToastProvider>,
  );
  await screen.findByText("Budi Santoso");
  await waitFor(() => expect(note()).toBe("Opened from orders, row 2. Its filter id = 214 was replaced. Alt+Left goes back."));
  expect(document.querySelectorAll(".filter-chip")).toHaveLength(1);
});

test("a_reference_that_points_nowhere_opens_an_empty_tab_and_says_the_key_is_not_enforced", async () => {
  const jump = jumpTo([{ column: "id", value: "999" }], { kind: "out", fromTable: "orders", fromRow: 1 });
  await open("customers", { customers: shopPage("customers", []) }, { jump }, false);
  await waitFor(() => expect(note()).toBe("No customers row has id = 999: the database does not enforce this key."));
});

test("rows_that_point_here_open_with_the_first_key_cell_selected_and_a_count", async () => {
  const jump = jumpTo([{ column: "order_id", value: "1003" }], { kind: "in", toTable: "orders", toKey: [{ column: "id", value: "1003" }] }, 1, false);
  await open("order_items", { order_items: shopPage("order_items", [[3, 1003, 2, "SGD", 2], [4, 1003, 7, "SGD", 1]]) }, { jump }, false);
  await waitFor(() => expect(note()).toBe("2 rows of order_items point to orders id = 1003. Alt+Left goes back."));
  expect(selectedCells()).toEqual(["0:1"]);
});

test("back_and_forward_restore_the_cell_and_the_grid_reports_where_it_is", async () => {
  const controlRef = { current: null as GridControl | null };
  const jump: GridJump = { seq: 1, filters: [], where: null, page: 0, select: { row: 2, column: "customer_id", wholeRow: false }, say: { kind: "back" } };
  await open("orders", { orders: ordersPage(), order_items: shopPage("order_items", []) }, { jump, controlRef }, false);
  await waitFor(() => expect(selectedCells()).toEqual(["2:1"]));
  expect(note()).toBe("Back on orders.customer_id of row 3.");
  down(td(1, 3));
  expect(controlRef.current!.location!()).toEqual({
    filters: [],
    where: null,
    page: 0,
    sort: null,
    cell: { row: 1, column: "status", key: JSON.stringify([{ t: "number", value: "1002" }]) },
  });
});

test("M5: back finds the row by its key, with the sort and filter the tab had, wherever the row is now", async () => {
  const controlRef = { current: null as GridControl | null };
  // Since the jump the rows came back in another order: 1003 is now the first row.
  const moved = shopPage("orders", [ORDERS[2], ORDERS[0], ORDERS[1], ORDERS[3], ORDERS[4]]);
  const sort = { column: "status", descending: true };
  const jump: GridJump = {
    seq: 1,
    filters: [],
    where: null,
    page: 0,
    sort,
    select: { row: 2, column: "customer_id", key: JSON.stringify([{ t: "number", value: "1003" }]), wholeRow: false },
    say: { kind: "back" },
  };
  await open("orders", { orders: moved, order_items: shopPage("order_items", []) }, { jump, controlRef }, false);
  await waitFor(() => expect(selectedCells()).toEqual(["0:1"]));
  expect(note()).toBe("Back on orders.customer_id of row 1.");
  // The page was fetched with the tab's sort, and the grid reports it with the row's key.
  const fetches = callsTo("fetch_page");
  expect((fetches[fetches.length - 1].request as { sort: unknown }).sort).toEqual(sort);
  expect(controlRef.current!.location!()).toEqual({
    filters: [],
    where: null,
    page: 0,
    sort,
    cell: { row: 0, column: "customer_id", key: JSON.stringify([{ t: "number", value: "1003" }]) },
  });
});

test("M3: back asks the server for a row that is not on the page; a row no longer there is gone", async () => {
  const key = JSON.stringify([{ t: "number", value: "1005" }]);
  const jump: GridJump = { seq: 1, filters: [], where: null, page: 0, select: { row: 2, column: "customer_id", key, wholeRow: false }, say: { kind: "back" } };
  await open("orders", { orders: ordersPage(), order_items: shopPage("order_items", []) }, { jump }, false, { locate_row: () => ({ kind: "missing" }) });
  await waitFor(() => expect(note()).toBe("Back on orders. The row with id = 1005 is no longer here."));
  expect(selectedCells()).toEqual([]);
  expect(callsTo("locate_row")[0]).toMatchObject({ id: "c1", request: { table: at("orders"), sort: null, filter: null, key: [{ column: "id", value: { t: "number", value: "1005" } }] } });
});

test("M3: a row that only moved to another page is found there by its key", async () => {
  const key = JSON.stringify([{ t: "number", value: "1003" }]);
  // Page 0 no longer holds 1003; page 1 has it as its third row.
  let fetched = 0;
  const pages = () => (fetched++ === 0 ? shopPage("orders", [ORDERS[0], ORDERS[1]], true) : shopPage("orders", [ORDERS[0], ORDERS[1], ORDERS[2]]));
  const jump: GridJump = { seq: 1, filters: [], where: null, page: 0, select: { row: 2, column: "customer_id", key, wholeRow: false }, say: { kind: "back" } };
  await open("orders", { orders: pages, order_items: shopPage("order_items", []) }, { jump }, false, { locate_row: () => ({ kind: "found", index: 1002 }) });
  await waitFor(() => expect(note()).toBe("Back on orders.customer_id of row 1,003."));
  expect(selectedCells()).toEqual(["2:1"]);
  const fetches = callsTo("fetch_page");
  expect((fetches[fetches.length - 1].request as { page: number }).page).toBe(1);
});

test("M3: when the server can't say where the row is, back says it is not on this page, never that it is gone", async () => {
  const key = JSON.stringify([{ t: "number", value: "1005" }]);
  const jump: GridJump = { seq: 1, filters: [], where: null, page: 0, select: { row: 2, column: "customer_id", key, wholeRow: false }, say: { kind: "back" } };
  await open("orders", { orders: ordersPage(), order_items: shopPage("order_items", []) }, { jump }, false, { locate_row: () => ({ kind: "timedOut" }) });
  await waitFor(() => expect(note()).toBe("Back on orders. The row with id = 1005 is not on this page now."));
});

test("N5: on a server that can't look the row up, back shows its old place and says so", async () => {
  const key = JSON.stringify([{ t: "number", value: "1005" }]);
  const jump: GridJump = { seq: 1, filters: [], where: null, page: 0, select: { row: 2, column: "customer_id", key, wholeRow: false }, say: { kind: "back" } };
  await open("orders", { orders: ordersPage(), order_items: shopPage("order_items", []) }, { jump }, false, { locate_row: () => ({ kind: "unsupported" }) });
  await waitFor(() =>
    expect(note()).toBe("Back on orders.customer_id of row 3. Couldn't look up where the row moved on this server; showing its old place."),
  );
  expect(selectedCells()).toEqual(["2:1"]);
});

test("M4: a cell on a new row of a keyed table comes back by position, and never says the table has no key", async () => {
  const jump: GridJump = { seq: 1, filters: [], where: null, page: 0, select: { row: 9, column: "status", wholeRow: false }, say: { kind: "back" } };
  await open("orders", { orders: ordersPage(), order_items: shopPage("order_items", []) }, { jump }, false);
  await waitFor(() => expect(note()).toBe("Back on orders.status of row 5."));
  expect(note()).not.toContain("no key");
});

test("M4: the grid reports a new row's cell of a keyed table with no key, so Back finds it by its place", async () => {
  const controlRef = { current: null as GridControl | null };
  await open("orders", { orders: ordersPage(), order_items: shopPage("order_items", []) }, { controlRef });
  down(td(1, 3));
  press("Insert", { altKey: true });
  await waitFor(() => expect(document.querySelectorAll("tr.row-added")).toHaveLength(1));
  down(td(2, 3));
  expect(controlRef.current!.location!().cell).toEqual({ row: 2, column: "status" });
});

test("M5: a back that matches the fetch in flight waits for it, and never lands on the old page", async () => {
  let release: (p: Page) => void = () => {};
  const key = JSON.stringify([{ t: "number", value: "1003" }]);
  const sorted = shopPage("orders", [ORDERS[2], ORDERS[0], ORDERS[1], ORDERS[3], ORDERS[4]]);
  let calls = 0;
  const pages = () => {
    calls++;
    return calls === 1 ? ordersPage() : new Promise<Page>((r) => (release = r));
  };
  const controlRef = { current: null as GridControl | null };
  const { rerender, lang, onFollow } = await open("orders", { orders: pages, order_items: shopPage("order_items", []) }, { controlRef });
  // A header click: the sorted fetch is in flight.
  fireEvent.click(screen.getByRole("button", { name: "Sort by status" }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
  // Back targets this tab with that same sort before the rows arrive.
  const jump: GridJump = { seq: 5, filters: [], where: null, page: 0, sort: { column: "status", descending: false }, select: { row: 2, column: "customer_id", key, wholeRow: false }, say: { kind: "back" } };
  rerender(
    <ToastProvider>
      <DataGrid connectionId="c1" table={at("orders")} onClose={() => {}} dialect="postgres" lang={lang} onFollow={onFollow} controlRef={controlRef} jump={jump} />
    </ToastProvider>,
  );
  expect(note()).toBe("");
  await act(async () => release(sorted));
  await waitFor(() => expect(note()).toBe("Back on orders.customer_id of row 1."));
  expect(selectedCells()).toEqual(["0:1"]);
});

test("M5: a table with no key comes back by position, and says so when the row is gone", async () => {
  const keyless = () => {
    const p = shopPage("orders", ORDERS.slice(0, 2));
    return { ...p, columns: p.columns.map((c) => ({ ...c, isPrimaryKey: false })) };
  };
  const jump = (row: number): GridJump => ({ seq: row, filters: [], where: null, page: 0, select: { row, column: "status", key: null, wholeRow: false }, say: { kind: "back" } });
  const { unmount } = await open("orders", { orders: keyless(), order_items: shopPage("order_items", []) }, { jump: jump(1) }, false);
  await waitFor(() => expect(note()).toBe("Back on orders.status of row 2."));
  expect(selectedCells()).toEqual(["1:3"]);
  unmount();
  await open("orders", { orders: keyless(), order_items: shopPage("order_items", []) }, { jump: jump(4) }, false);
  await waitFor(() => expect(note()).toBe("Back on orders. Row 5 is no longer here, and orders has no key to find it by."));
  expect(selectedCells()).toEqual([]);
});

test("the_header_has_back_and_forward_buttons", async () => {
  const nav = { back: "orders", forward: null, onBack: vi.fn(), onForward: vi.fn() };
  await open("customers", { customers: customers() }, { nav });
  const back = screen.getByRole("button", { name: "Back" });
  expect(back.getAttribute("title")).toBe("Back to orders (Alt+Left)");
  fireEvent.click(back);
  expect(nav.onBack).toHaveBeenCalledTimes(1);
  const forward = screen.getByRole("button", { name: "Forward" }) as HTMLButtonElement;
  expect(forward.getAttribute("aria-disabled")).toBe("true");
  expect(forward.getAttribute("title")).toBe("Forward (Alt+Right)");
  fireEvent.click(forward);
  expect(nav.onForward).not.toHaveBeenCalled();
});

test("the_commands_run_from_anywhere_act_on_the_visible_grid", async () => {
  const { onFollow } = await open("orders", { orders: ordersPage(), order_items: shopPage("order_items", []) });
  down(td(0, 1));
  (document.activeElement as HTMLElement | null)?.blur();
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F4", code: "F4", bubbles: true, cancelable: true }));
  });
  expect(onFollow).toHaveBeenCalledTimes(1);
});

test("a_request_with_only_a_note_leaves_the_filters_and_cell", async () => {
  const { rerender, lang } = await open("orders", { orders: ordersPage(), order_items: shopPage("order_items", []) });
  down(td(1, 3));
  const pages = callsTo("fetch_page").length;
  const jump: GridJump = { seq: 7, filters: [], where: null, page: 0, select: null, say: { kind: "none", text: "Nothing to go back to." } };
  rerender(
    <ToastProvider>
      <DataGrid connectionId="c1" table={at("orders")} onClose={() => {}} dialect="postgres" lang={lang} jump={jump} />
    </ToastProvider>,
  );
  expect(note()).toBe("Nothing to go back to.");
  expect(selectedCells()).toEqual(["1:3"]);
  expect(callsTo("fetch_page")).toHaveLength(pages);
  // Moving the cell clears it.
  down(td(2, 3));
  expect(note()).toBe("");
});

test("f4_pressed_in_another_pane_leaves_the_grid_alone", async () => {
  const { onFollow } = await open("orders", { orders: ordersPage(), order_items: shopPage("order_items", []) });
  down(td(0, 1));
  // Focus in the SQL editor or the Schema Builder beside the grid: their keys are their own.
  const editor = document.createElement("textarea");
  document.body.appendChild(editor);
  editor.focus();
  act(() => {
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "F4", code: "F4", bubbles: true, cancelable: true }));
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "b", code: "KeyB", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  expect(onFollow).not.toHaveBeenCalled();
  editor.remove();
});

test("one_table_pointing_here_shows_the_list_while_it_counts_then_opens", async () => {
  let answer: (p: Page) => void = () => {};
  const { onFollow } = await open("orders", { orders: ordersPage(), order_items: () => new Promise<Page>((r) => (answer = r)) });
  down(td(2, 0));
  press("F7", { altKey: true });
  // DataGrip shows its list at once.
  expect(optionText()).toEqual(["order_itemsby order_idcounting"]);
  // The current option is announced.
  expect(picker().getAttribute("aria-activedescendant")).toBe(options()[0].id);
  expect(options()[0].id).not.toBe("");
  await waitFor(() => expect(callsTo("count_rows")).toHaveLength(1));
  answer(shopPage("order_items", [[3, 1003, 2, "SGD", 2]]));
  await waitFor(() => expect(onFollow).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("listbox")).toBeNull();
});
