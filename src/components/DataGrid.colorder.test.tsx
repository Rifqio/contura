// Moving grid columns, view only (the GridColumnOrder board): a header drag past 4 px, Esc, the DBeaver keys, the
// header menu, copy and export in the order shown, and the order remembered per table per Connection.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Cell, Page } from "../api/types";
import { mockEditorDom } from "../test/editor";
import { callsTo, routeInvoke } from "../test/invoke";
import { setPlatformForTests } from "../platform";
import { flushColumnOrders, forgetColumnOrdersForTests, tableOrderKey } from "../grid/columnOrderStore";
import type { ExportOrigin } from "../jobs/exportText";
import { useKeymap } from "../commands/useCommandKeys";
import { whilePressed } from "../commands/keys";
import DataGrid from "./DataGrid";
import { SETTLE_MS } from "./Menu";
import { ToastProvider } from "./Toast";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
mockEditorDom();

const table = { database: "shop", schema: "public", name: "orders" };
const KEY = tableOrderKey(table);
const num = (value: string): Cell => ({ t: "number", value });
const text = (value: string): Cell => ({ t: "text", value, truncated: false, totalBytes: value.length });

const DATA: [number, number, string, string, string][] = [
  [1001, 214, "paid", "2026-10-01", "129.90"],
  [1002, 87, "shipped", "2026-10-01", "58.00"],
  [1003, 214, "pending", "2026-10-02", "310.25"],
];

function orders(names = ["id", "customer_id", "status", "ordered_at", "total"]): Page {
  return {
    columns: names.map((name) => ({ name, typeName: name === "status" || name === "ordered_at" ? "text" : "int8", isPrimaryKey: name === "id" })),
    rows: DATA.map(([id, cust, status, at, total]) =>
      names.map((n) => (n === "id" ? num(String(id)) : n === "customer_id" ? num(String(cust)) : n === "status" ? text(status) : n === "total" ? num(total) : text(at))),
    ),
    hasMore: false,
  };
}

const grid = () => document.querySelector(".grid-scroll") as HTMLElement;
const td = (row: number, col: number) => document.querySelector(`tr[data-row="${row}"] td[data-col="${col}"]`) as HTMLElement;
const heads = () => Array.from(document.querySelectorAll("thead th .header-name")).map((h) => h.textContent);
const head = (name: string) => screen.getByRole("button", { name: `Sort by ${name}` });
// Moving a column speaks in the footer's live region, never in a line above the grid.
const note = () => document.querySelector(".table-foot .table-order-note")?.textContent ?? "";
const fullColumns = () => Array.from(document.querySelectorAll("thead th.col-sel-full .header-name")).map((h) => h.textContent);
const menuItems = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".tree-menu [role=menuitem]"));
const item = (label: string) => menuItems().find((b) => b.getAttribute("aria-label") === label)!;
const moveKey = (k: "ArrowLeft" | "ArrowRight") => fireEvent.keyDown(grid(), { key: k, code: k, altKey: true, shiftKey: true });

/** Headers 100 px wide from x 50 (after the gutter), in a 1000 px wide grid; jsdom lays nothing out. */
function layout(view = 1000) {
  return vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const r = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;
    if (this.classList.contains("grid-scroll")) return r(0, 0, view, 300);
    if (this.tagName === "TH" && !this.classList.contains("row-number")) {
      const i = Array.from(this.parentElement!.children).indexOf(this) - 1;
      return r(50 + i * 100, 0, 100, 38);
    }
    return r(0, 0, 0, 0);
  });
}

let writeText: ReturnType<typeof vi.fn>;
let stored: Record<string, string[]>;

beforeEach(() => {
  forgetColumnOrdersForTests();
  stored = {};
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText, readText: vi.fn(() => Promise.resolve("")) }, configurable: true });
  setPlatformForTests("linux");
});
afterEach(() => {
  vi.restoreAllMocks();
  setPlatformForTests(null);
});

async function open(props: Partial<Parameters<typeof DataGrid>[0]> = {}, page: () => Page = () => orders()) {
  routeInvoke({
    fetch_page: () => page(),
    column_orders: () => stored,
    save_column_order: ({ table: key, columns }) => {
      if (columns) stored[key as string] = columns as string[];
      else delete stored[key as string];
      return null;
    },
  });
  render(
    <ToastProvider>
      <DataGrid connectionId="c1" table={table} connectionName="local-pg" onClose={() => {}} {...props} />
    </ToastProvider>,
  );
  await screen.findByText("pending");
  await waitFor(() => expect(callsTo("column_orders")).toHaveLength(1));
}

/** Presses `name`'s header at its middle and moves the pointer to `x` (client px). */
function dragTo(name: string, ...xs: number[]) {
  const at = heads().indexOf(name);
  fireEvent.mouseDown(head(name), { button: 0, clientX: 100 + at * 100, clientY: 10 });
  for (const x of xs) fireEvent.mouseMove(window, { clientX: x, clientY: 12 });
}

test("a click or a wobble of 4 px still sorts; past 4 px the header drags with a ghost, a marker and the source dimmed", async () => {
  layout();
  await open();
  // status sits at 250 to 350; a press there and a 3 px wobble is a click.
  dragTo("status", 303);
  expect(document.querySelector(".col-drag-ghost")).toBeNull();
  fireEvent.mouseUp(window);
  fireEvent.click(head("status"), { detail: 1 });
  await waitFor(() => expect(callsTo("fetch_page").slice(-1)[0]).toMatchObject({ request: { sort: { column: "status", descending: false } } }));
  await screen.findByText("pending");
  expect(heads()).toEqual(["id", "customer_id", "status", "ordered_at", "total"]);

  // Past 4 px the drag starts: the ghost names the column, the marker sits in the gap at id's left edge.
  dragTo("status", 290, 60);
  const ghost = document.querySelector(".col-drag-ghost") as HTMLElement;
  expect(ghost.textContent).toBe("statustext");
  expect((document.querySelector(".col-drag-mark") as HTMLElement).style.left).toBe("50px");
  expect(document.querySelector("thead th.col-drag-source .header-name")?.textContent).toBe("status");
  expect(td(0, 2).className).toContain("col-drag-source");
  expect(note()).toBe("Moving status. Drop it between two headers; Esc puts it back.");
  fireEvent.mouseUp(window);
  // The drag's own click does not sort.
  fireEvent.click(head("status"), { detail: 1 });
  expect(callsTo("fetch_page")).toHaveLength(2);

  expect(heads()).toEqual(["status", "id", "customer_id", "ordered_at", "total"]);
  expect(document.querySelector(".col-drag-ghost")).toBeNull();
  expect(document.querySelector(".col-drag-mark")).toBeNull();
  // The cells follow their header, and the moved column stays selected (Excel).
  expect(td(0, 0).textContent).toBe("paid");
  expect(td(0, 1).textContent).toBe("1001");
  expect(fullColumns()).toEqual(["status"]);
  expect(note()).toBe("Moved status to first. Remembered for orders on local-pg.");
  flushColumnOrders();
  expect(callsTo("save_column_order").slice(-1)[0]).toEqual({ id: "c1", table: KEY, columns: ["status", "id", "customer_id", "ordered_at", "total"] });
  // aria-colindex follows the order shown (the row number is column 1).
  expect(document.querySelector("thead th[aria-label='status, text']")?.getAttribute("aria-colindex")).toBe("2");
  expect(td(0, 0).getAttribute("aria-colindex")).toBe("2");
  // View only: nothing but the page fetches ran; no statement touched the table.
  expect(callsTo("execute_sql")).toEqual([]);
});

test("a drop after the last header moves the column last; a drop beside itself changes nothing", async () => {
  layout();
  await open();
  dragTo("customer_id", 230, 545);
  fireEvent.mouseUp(window);
  expect(heads()).toEqual(["id", "status", "ordered_at", "total", "customer_id"]);
  expect(note()).toBe("Moved customer_id to last. Remembered for orders on local-pg.");
  dragTo("id", 120, 160);
  fireEvent.mouseUp(window);
  expect(heads()).toEqual(["id", "status", "ordered_at", "total", "customer_id"]);
  expect(note()).toBe("Dropped where it was: the order is unchanged.");
  dragTo("total", 330, 280);
  fireEvent.mouseUp(window);
  expect(heads()).toEqual(["id", "status", "total", "ordered_at", "customer_id"]);
  expect(note()).toBe("Moved total after status. Remembered for orders on local-pg.");
});

test("Esc mid-drag puts the column back", async () => {
  layout();
  await open();
  dragTo("total", 480, 70);
  expect(document.querySelector(".col-drag-ghost")).not.toBeNull();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(document.querySelector(".col-drag-ghost")).toBeNull();
  expect(note()).toBe("Move cancelled: total stays where it was.");
  fireEvent.mouseUp(window);
  fireEvent.click(head("total"), { detail: 1 });
  expect(heads()).toEqual(["id", "customer_id", "status", "ordered_at", "total"]);
  flushColumnOrders();
  expect(callsTo("save_column_order")).toEqual([]);
  expect(callsTo("fetch_page")).toHaveLength(1);
});

test("near the right edge the grid scrolls by itself while dragging", async () => {
  layout(400);
  await open();
  let left = 0;
  Object.defineProperty(grid(), "scrollLeft", { configurable: true, get: () => left, set: (v: number) => (left = Math.max(0, Math.min(200, v))) });
  Object.defineProperty(grid(), "scrollWidth", { configurable: true, get: () => 600 });
  Object.defineProperty(grid(), "clientWidth", { configurable: true, get: () => 400 });
  dragTo("id", 110, 395);
  expect((document.querySelector(".col-drag-edge") as HTMLElement).hidden).toBe(false);
  await act(() => new Promise((r) => setTimeout(r, 80)));
  expect(left).toBeGreaterThan(0);
  fireEvent.keyDown(window, { key: "Escape" });
});

test("Alt+Shift+Left and Right move the active column, which stays selected", async () => {
  layout();
  await open();
  fireEvent.mouseDown(td(1, 1), { button: 0 });
  moveKey("ArrowRight");
  expect(heads()).toEqual(["id", "status", "customer_id", "ordered_at", "total"]);
  expect(fullColumns()).toEqual(["customer_id"]);
  expect(td(1, 2).className).toContain("cell-selected");
  expect(note()).toBe("Moved customer_id after status. Remembered for orders on local-pg.");
  moveKey("ArrowLeft");
  moveKey("ArrowLeft");
  expect(heads()).toEqual(["customer_id", "id", "status", "ordered_at", "total"]);
  moveKey("ArrowLeft");
  expect(note()).toBe("customer_id is already first.");
  expect(heads()).toEqual(["customer_id", "id", "status", "ordered_at", "total"]);
});

test("the header menu moves left and right with their keys shown, and resets the order once moved", async () => {
  layout();
  await open();
  fireEvent.contextMenu(head("total").closest("th")!, { clientX: 470, clientY: 20 });
  expect(menuItems().map((b) => b.getAttribute("aria-label"))).toEqual(["Sort ascending", "Sort descending", "Move left", "Move right", "Reset column order"]);
  expect(document.querySelector(".tree-menu .menu-heading")?.textContent).toBe("total, column 5 of 5");
  expect(item("Move left").textContent).toContain("Shift+Alt+Left");
  expect(item("Move right").textContent).toContain("Shift+Alt+Right");
  expect(item("Move right").disabled).toBe(true);
  // The order is the table's own: nothing to reset.
  expect(item("Reset column order").disabled).toBe(true);
  // The right-click selected the column.
  expect(fullColumns()).toEqual(["total"]);
  fireEvent.click(item("Move left"));
  expect(heads()).toEqual(["id", "customer_id", "status", "total", "ordered_at"]);
  expect(document.querySelector(".tree-menu")).toBeNull();

  // Shift+F10 on the selected column opens the same menu, under its header.
  fireEvent.keyDown(grid(), { key: "F10", shiftKey: true });
  expect(document.querySelector(".tree-menu .menu-heading")?.textContent).toBe("total, column 4 of 5");
  expect(item("Reset column order").disabled).toBe(false);
  fireEvent.click(item("Reset column order"));
  expect(heads()).toEqual(["id", "customer_id", "status", "ordered_at", "total"]);
  expect(fullColumns()).toEqual(["total"]);
  expect(note()).toBe("Column order reset to the table's order.");
  flushColumnOrders();
  expect(callsTo("save_column_order").slice(-1)[0]).toEqual({ id: "c1", table: KEY, columns: null });

  // Sort descending from the menu.
  fireEvent.contextMenu(head("status").closest("th")!, { clientX: 300, clientY: 20 });
  fireEvent.click(item("Sort descending"));
  await waitFor(() => expect(callsTo("fetch_page").slice(-1)[0]).toMatchObject({ request: { sort: { column: "status", descending: true } } }));
});

test("Shift+F10 on a single cell still opens the cell menu", async () => {
  layout();
  await open();
  fireEvent.mouseDown(td(0, 2), { button: 0 });
  fireEvent.keyDown(grid(), { key: "F10", shiftKey: true });
  expect(menuItems().map((b) => b.getAttribute("aria-label"))).toContain("Copy with headers");
});

test("copy, copy with headers, paste and export follow the order shown", async () => {
  layout();
  const onExport = vi.fn((o: ExportOrigin) => o);
  await open({ onExport });
  dragTo("status", 290, 60);
  fireEvent.mouseUp(window);
  fireEvent.mouseDown(td(0, 0), { button: 0 });
  fireEvent.mouseDown(td(1, 1), { button: 0, shiftKey: true });
  fireEvent.keyDown(grid(), { key: "c", code: "KeyC", ctrlKey: true, shiftKey: true });
  expect(writeText).toHaveBeenLastCalledWith("status\tid\npaid\t1001\nshipped\t1002");
  fireEvent.keyDown(grid(), { key: "c", code: "KeyC", ctrlKey: true });
  expect(writeText).toHaveBeenLastCalledWith("paid\t1001\nshipped\t1002");

  // A paste lands on the columns as shown: customer_id then ordered_at, at shown places 2 and 3.
  fireEvent.mouseDown(td(0, 2), { button: 0 });
  fireEvent.paste(grid(), { clipboardData: { getData: () => "7\t2026-12-31" } });
  expect(td(0, 2).textContent).toBe("7");
  expect(td(0, 3).textContent).toBe("2026-12-31");

  fireEvent.keyDown(grid(), { key: "e", code: "KeyE", ctrlKey: true });
  expect(onExport).toHaveBeenCalledTimes(1);
  expect(onExport.mock.calls[0][0]).toMatchObject({ kind: "table", columns: ["id", "customer_id", "status", "ordered_at", "total"], order: ["status", "id", "customer_id", "ordered_at", "total"] });
});

test("the order is remembered per table per Connection: it comes back on reopen", async () => {
  layout();
  await open();
  dragTo("total", 480, 60);
  fireEvent.mouseUp(window);
  expect(heads()).toEqual(["total", "id", "customer_id", "status", "ordered_at"]);
  cleanup();
  const before = callsTo("save_column_order").length;
  await open();
  await waitFor(() => expect(heads()).toEqual(["total", "id", "customer_id", "status", "ordered_at"]));
  // Opening it used the order: written again unchanged, so it is the most recently used when the cap evicts.
  expect(callsTo("save_column_order").slice(before)).toEqual([{ id: "c1", table: KEY, columns: ["total", "id", "customer_id", "status", "ordered_at"] }]);
  // Another Connection keeps its own.
  cleanup();
  routeInvoke({ fetch_page: () => orders(), column_orders: () => ({}), save_column_order: () => null });
  render(
    <ToastProvider>
      <DataGrid connectionId="c2" table={table} onClose={() => {}} />
    </ToastProvider>,
  );
  await screen.findByText("pending");
  await waitFor(() => expect(callsTo("column_orders").some((a) => a.id === "c2")).toBe(true));
  expect(heads()).toEqual(["id", "customer_id", "status", "ordered_at", "total"]);
});

test("a remembered order survives a changed table: gone columns drop out, new ones come in at their place", async () => {
  layout();
  stored = { [KEY]: ["total", "status", "dropped", "id"] };
  await open();
  await waitFor(() => expect(heads()).toEqual(["total", "status", "ordered_at", "id", "customer_id"]));
  // Every column is shown, and the cells follow.
  expect(td(0, 0).textContent).toBe("129.90");
  expect(td(0, 3).textContent).toBe("1001");
});

test("the header menu stays inside the window at the right and bottom edges", async () => {
  const rect = layout();
  const base = rect.getMockImplementation()!;
  rect.mockImplementation(function (this: Element) {
    if (this.classList.contains("tree-menu")) return { left: 0, top: 0, width: 240, height: 200, right: 240, bottom: 200, x: 0, y: 0, toJSON() {} } as DOMRect;
    return base.call(this);
  });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
  await open();
  fireEvent.contextMenu(head("total").closest("th")!, { clientX: 990, clientY: 590 });
  const box = document.querySelector(".tree-menu") as HTMLElement;
  expect(box.style.left).toBe("756px");
  expect(box.style.top).toBe("396px");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  fireEvent.contextMenu(head("id").closest("th")!, { clientX: 60, clientY: 20 });
  expect((document.querySelector(".tree-menu") as HTMLElement).style.left).toBe("60px");
  expect((document.querySelector(".tree-menu") as HTMLElement).style.top).toBe("20px");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
});

test("Reset column order is on while a moved column is hidden", async () => {
  layout();
  await open();
  dragTo("total", 480, 60);
  fireEvent.mouseUp(window);
  expect(heads()[0]).toBe("total");
  // Hide total from the Table menu's Columns list: the shown columns are in the table's order, the order is not.
  fireEvent.click(screen.getByRole("button", { name: "Table" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Columns" }));
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "total" }));
  await waitFor(() => expect(heads()).toEqual(["id", "customer_id", "status", "ordered_at"]));
  fireEvent.contextMenu(head("status").closest("th")!, { clientX: 300, clientY: 20 });
  expect(item("Reset column order").disabled).toBe(false);
  fireEvent.click(item("Reset column order"));
  flushColumnOrders();
  expect(callsTo("save_column_order").slice(-1)[0]).toEqual({ id: "c1", table: KEY, columns: null });
});

test("a run of moves writes the order once, when the moves pause", async () => {
  layout();
  await open();
  fireEvent.mouseDown(td(0, 0), { button: 0 });
  moveKey("ArrowRight");
  moveKey("ArrowRight");
  moveKey("ArrowRight");
  expect(heads()).toEqual(["customer_id", "status", "ordered_at", "id", "total"]);
  expect(callsTo("save_column_order")).toEqual([]);
  await waitFor(() => expect(callsTo("save_column_order")).toHaveLength(1), { timeout: 2000 });
  expect(callsTo("save_column_order")[0].columns).toEqual(["customer_id", "status", "ordered_at", "id", "total"]);
});

test("the move keys never leave the grid: a text field and the SQL editor keep Shift+Alt+Left and Right", async () => {
  layout();
  let run: ((id: "grid.moveColumnLeft") => boolean) | null = null;
  function Probe() {
    const k = useKeymap();
    run = (id) => whilePressed("Shift+Alt+ArrowLeft", () => k.run(id));
    return <textarea aria-label="elsewhere" />;
  }
  await open();
  render(<Probe />);
  fireEvent.mouseDown(td(0, 2), { button: 0 });
  const field = screen.getByRole("textbox", { name: "elsewhere" });
  field.focus();
  // Not taken from the field (on a Mac, Shift+Option+Left selects a word), and nothing moves.
  expect(fireEvent.keyDown(field, { key: "ArrowLeft", code: "ArrowLeft", altKey: true, shiftKey: true })).toBe(true);
  expect(fireEvent.keyDown(field, { key: "ArrowRight", code: "ArrowRight", altKey: true, shiftKey: true })).toBe(true);
  // An editor's keymap asks the app first; with focus outside the grid the app says no, so the editor keeps the key.
  expect(run!("grid.moveColumnLeft")).toBe(false);
  expect(heads()).toEqual(["id", "customer_id", "status", "ordered_at", "total"]);
  // In the grid they move the column.
  grid().focus();
  expect(fireEvent.keyDown(grid(), { key: "ArrowLeft", code: "ArrowLeft", altKey: true, shiftKey: true })).toBe(false);
  expect(heads()).toEqual(["id", "status", "customer_id", "ordered_at", "total"]);
});

test("a drag released off its header never swallows the next keyboard sort", async () => {
  layout();
  await open();
  // Released over another header: the browser fires no click on the dragged one.
  dragTo("status", 290, 480);
  fireEvent.mouseUp(window);
  expect(heads()).toEqual(["id", "customer_id", "ordered_at", "status", "total"]);
  // Enter on a header button is a click with no pointer (detail 0): it sorts.
  fireEvent.click(head("total"), { detail: 0 });
  await waitFor(() => expect(callsTo("fetch_page").slice(-1)[0]).toMatchObject({ request: { sort: { column: "total" } } }));
  await screen.findByText("pending");
  // And a later mouse click sorts too, once the drop's own click has passed.
  await act(() => new Promise((r) => setTimeout(r, 5)));
  fireEvent.click(head("id"), { detail: 1 });
  await waitFor(() => expect(callsTo("fetch_page").slice(-1)[0]).toMatchObject({ request: { sort: { column: "id" } } }));
});

test("a press outside the header menu leaves focus where it landed; Esc gives it back to the grid", async () => {
  layout();
  await open();
  render(<textarea aria-label="editor" />);
  fireEvent.contextMenu(head("status").closest("th")!, { clientX: 300, clientY: 20 });
  expect(document.querySelector(".tree-menu")).not.toBeNull();
  const editor = screen.getByRole("textbox", { name: "editor" });
  // The press focuses the editor first (as CodeMirror does in its own mousedown), then the menu closes.
  editor.focus();
  fireEvent.mouseDown(editor);
  expect(document.querySelector(".tree-menu")).toBeNull();
  expect(document.activeElement).toBe(editor);
  fireEvent.contextMenu(head("status").closest("th")!, { clientX: 300, clientY: 20 });
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(document.querySelector(".tree-menu")).toBeNull();
  expect(document.activeElement).toBe(grid());
});

test("the header menu closes when the grid scrolls", async () => {
  layout();
  await open();
  fireEvent.contextMenu(head("total").closest("th")!, { clientX: 470, clientY: 20 });
  expect(document.querySelector(".tree-menu")).not.toBeNull();
  // A scroll its own opening caused (in the same frame) leaves it open.
  fireEvent.scroll(grid());
  expect(document.querySelector(".tree-menu")).not.toBeNull();
  // Once open, a scroll closes it.
  await act(() => new Promise((r) => setTimeout(r, SETTLE_MS + 20)));
  fireEvent.scroll(grid());
  expect(document.querySelector(".tree-menu")).toBeNull();
});

test("selecting or moving a whole column keeps the rows where they are", async () => {
  layout();
  await open();
  let top = 40;
  let left = 0;
  Object.defineProperty(grid(), "scrollTop", { configurable: true, get: () => top, set: (v: number) => (top = v) });
  Object.defineProperty(grid(), "scrollLeft", { configurable: true, get: () => left, set: (v: number) => (left = v) });
  Object.defineProperty(grid(), "clientWidth", { configurable: true, get: () => 1000 });
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  // A header right-click selects the column: the menu opens and stays, and nothing scrolls.
  fireEvent.contextMenu(head("status").closest("th")!, { clientX: 300, clientY: 20 });
  expect(fullColumns()).toEqual(["status"]);
  expect(document.querySelector(".tree-menu")).not.toBeNull();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  // Ctrl+Space, a drop and the move keys select whole columns too.
  fireEvent.mouseDown(td(1, 1), { button: 0 });
  // A single cell still comes into view as before; the whole columns after it must not scroll.
  scrollIntoView.mockClear();
  fireEvent.keyDown(grid(), { key: " ", code: "Space", ctrlKey: true });
  expect(fullColumns()).toEqual(["customer_id"]);
  moveKey("ArrowRight");
  dragTo("id", 120, 480);
  fireEvent.mouseUp(window);
  expect(heads()).toEqual(["status", "customer_id", "ordered_at", "id", "total"]);
  expect(top).toBe(40);
  expect(left).toBe(0);
  expect(scrollIntoView).not.toHaveBeenCalled();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

test("a drag never adds a line above the grid: its notes are in the footer's live region", async () => {
  layout();
  await open();
  const live = document.querySelector(".table-foot .table-order-note")!;
  expect(live.getAttribute("aria-live")).toBe("polite");
  expect(live.textContent).toBe("");
  dragTo("status", 290, 60);
  expect(document.querySelector(".grid-note")).toBeNull();
  expect(live.textContent).toBe("Moving status. Drop it between two headers; Esc puts it back.");
  fireEvent.mouseUp(window);
  expect(document.querySelector(".grid-note")).toBeNull();
  expect(live.textContent).toBe("Moved status to first. Remembered for orders on local-pg.");
  // The same element all along: the footer never gains or loses a row.
  expect(document.querySelector(".table-foot .table-order-note")).toBe(live);
});

test("a drop and a menu move are saved at once; only held keys wait", async () => {
  layout();
  await open();
  dragTo("total", 480, 60);
  fireEvent.mouseUp(window);
  expect(callsTo("save_column_order")).toHaveLength(1);
  expect(callsTo("save_column_order")[0].columns).toEqual(["total", "id", "customer_id", "status", "ordered_at"]);
  fireEvent.contextMenu(head("total").closest("th")!, { clientX: 100, clientY: 20 });
  fireEvent.click(item("Move right"));
  expect(callsTo("save_column_order")).toHaveLength(2);
  expect(callsTo("save_column_order")[1].columns).toEqual(["id", "total", "customer_id", "status", "ordered_at"]);
  // A key move waits for the run; a drop right after replaces it, and nothing older is written later.
  moveKey("ArrowRight");
  expect(callsTo("save_column_order")).toHaveLength(2);
  dragTo("status", 380, 60);
  fireEvent.mouseUp(window);
  expect(callsTo("save_column_order")).toHaveLength(3);
  await flushColumnOrders();
  expect(callsTo("save_column_order")).toHaveLength(3);
  expect(callsTo("save_column_order")[2].columns).toEqual(["status", "id", "customer_id", "total", "ordered_at"]);
});
