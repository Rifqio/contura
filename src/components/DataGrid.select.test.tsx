// UX step 3 (G1, G2, G3, G4, G9, G13, G14, G17): selection and clipboard in the table grid, gesture by gesture as the
// GridSelection board clicks through them, with the rulings that override the board.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Cell, Page, TableColumn, TableDesign } from "../api/types";
import { mockEditorDom } from "../test/editor";
import { callsTo, routeInvoke } from "../test/invoke";
import { setPlatformForTests } from "../platform";
import { useCommandKeys } from "../commands/useCommandKeys";
import { cyclePane, rememberPaneFocus } from "../app/panes";
import DataGrid from "./DataGrid";
import { ToastProvider } from "./Toast";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
mockEditorDom();

const table = { database: "shop", schema: "public", name: "orders" };
const num = (value: string): Cell => ({ t: "number", value });
const text = (value: string): Cell => ({ t: "text", value, truncated: false, totalBytes: value.length });
const NULL: Cell = { t: "null" };

const DATA: [number, number, string, string | null, string | null][] = [
  [1001, 214, "paid", "2026-10-01 09:14:07+07", "129.90"],
  [1002, 87, "shipped", "2026-10-01 11:02:45+07", "58.00"],
  [1003, 214, "pending", "2026-10-02 08:30:12+07", "310.25"],
  [1004, 552, "delivered", "2026-10-02 16:48:33+07", "42.50"],
  [1005, 87, "cancelled", "2026-10-03 10:05:09+07", "0.00"],
  [1006, 903, "paid", null, "1204.00"],
  [1007, 318, "shipped", "2026-10-04 13:21:56+07", "76.40"],
  [1008, 552, "refunded", "2026-10-05 09:59:01+07", "19.99"],
  [1009, 214, "pending", "2026-10-05 18:12:44+07", "245.00"],
  [1010, 641, "paid", "2026-10-06 07:45:30+07", "88.10"],
  [1011, 318, "delivered", "2026-10-07 12:00:00+07", "153.75"],
  [1012, 903, "shipped", "2026-10-08 15:33:18+07", null],
];

function orders(): Page {
  return {
    columns: [
      { name: "id", typeName: "int8", isPrimaryKey: true },
      { name: "customer_id", typeName: "int8", isPrimaryKey: false },
      { name: "status", typeName: "text", isPrimaryKey: false },
      { name: "ordered_at", typeName: "timestamptz", isPrimaryKey: false },
      { name: "total", typeName: "numeric(12,2)", isPrimaryKey: false },
    ],
    rows: DATA.map(([id, cust, status, at, total]) => [
      num(String(id)),
      num(String(cust)),
      text(status),
      at === null ? NULL : text(at),
      total === null ? NULL : num(total),
    ]),
    hasMore: false,
  };
}

const column = (name: string, typeSql: string, nullable: boolean, defaultSql: string | null): TableColumn => ({
  name,
  typeSql,
  nullable,
  defaultSql,
  increment: { kind: "none" as const },
  comment: null,
  generated: false,
  mysql: null,
  sqliteAutoincrement: false,
  collation: null,
  advanced: null,
  identityAlways: false,
} as unknown as TableColumn);

const design: TableDesign = {
  path: table,
  columns: [
    column("id", "int8", false, null),
    column("customer_id", "int8", false, null),
    column("status", "text", false, "'pending'::text"),
    column("ordered_at", "timestamptz", true, "now()"),
    column("total", "numeric(12,2)", true, "0"),
  ],
  indexes: [],
  foreignKeys: [],
  referencedBy: [],
  comment: null,
  unsupported: [],
  sqlite: null,
};

const grid = () => document.querySelector(".grid-scroll") as HTMLElement;
const td = (row: number, col: number) => document.querySelector(`tr[data-row="${row}"] td[data-col="${col}"]`) as HTMLElement;
const rowNumber = (row: number) => document.querySelector(`tr[data-row="${row}"] td.row-number`) as HTMLElement;
const corner = () => document.querySelector("thead th.row-number") as HTMLElement;
const key = (k: string, extra: object = {}) => fireEvent.keyDown(grid(), { key: k, ...extra });
const selectedCells = () =>
  Array.from(document.querySelectorAll<HTMLElement>('td[aria-selected="true"]')).map(
    (c) => `${c.closest("tr")!.getAttribute("data-row")}:${c.getAttribute("data-col")}`,
  );
const note = () => document.querySelector(".grid-note")?.textContent ?? "";
const menuLabels = () =>
  Array.from(document.querySelectorAll(".tree-menu [role=menuitem]")).map((b) => b.getAttribute("aria-label"));

let writeText: ReturnType<typeof vi.fn>;
let readText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn(() => Promise.resolve());
  readText = vi.fn(() => Promise.resolve(""));
  Object.defineProperty(navigator, "clipboard", { value: { writeText, readText }, configurable: true });
  setPlatformForTests("linux");
});
afterEach(() => setPlatformForTests(null));

async function open(
  props: Partial<Parameters<typeof DataGrid>[0]> = {},
  page: () => Page = orders,
  extra: Parameters<typeof routeInvoke>[0] = {},
) {
  routeInvoke({
    fetch_page: () => page(),
    table_design: () => design,
    fetch_full_value: () => ({ t: "text", value: "x" }),
    ...extra,
  });
  render(
    <ToastProvider>
      <DataGrid connectionId="c1" table={table} onClose={() => {}} {...props} />
    </ToastProvider>,
  );
  await screen.findByText("refunded");
}

const down = (el: HTMLElement, extra: object = {}) => fireEvent.mouseDown(el, { button: 0, ...extra });

test("click, Shift+click, Ctrl+click and a drag select cells; the active cell keeps its ring", async () => {
  await open();
  down(td(0, 1));
  expect(selectedCells()).toEqual(["0:1"]);
  expect(td(0, 1).className).toContain("cell-selected");
  down(td(1, 2), { shiftKey: true });
  expect(selectedCells()).toEqual(["0:1", "0:2", "1:1", "1:2"]);
  expect(td(0, 1).className).toContain("cell-selected");
  expect(td(1, 2).className).toContain("cell-in");
  down(td(4, 4), { ctrlKey: true });
  expect(selectedCells()).toEqual(["0:1", "0:2", "1:1", "1:2", "4:4"]);
  expect(td(4, 4).className).toContain("cell-selected");
  // A drag from one cell across others selects the block it covers.
  down(td(2, 2));
  fireEvent.mouseOver(td(3, 3));
  fireEvent.mouseUp(window);
  fireEvent.mouseOver(td(5, 4));
  expect(selectedCells()).toEqual(["2:2", "2:3", "3:2", "3:3"]);
  // The row numbers and headers of the block light up.
  expect(rowNumber(2).className).toContain("row-sel-part");
  expect(document.querySelectorAll("thead th.col-sel-part")).toHaveLength(2);
});

test("row numbers select whole rows (Shift, Ctrl and a drag too) and the corner selects all", async () => {
  await open();
  down(rowNumber(2));
  expect(selectedCells()).toHaveLength(5);
  expect(rowNumber(2).className).toContain("row-sel-full");
  down(rowNumber(4), { shiftKey: true });
  expect(selectedCells()).toHaveLength(15);
  down(rowNumber(8), { ctrlKey: true });
  expect(selectedCells()).toHaveLength(20);
  down(rowNumber(0));
  fireEvent.mouseOver(rowNumber(1));
  fireEvent.mouseUp(window);
  expect(selectedCells()).toHaveLength(10);
  down(corner());
  expect(selectedCells()).toHaveLength(60);
  expect(document.querySelectorAll("thead th.col-sel-full")).toHaveLength(5);
});

test("a header click sorts and never selects; Ctrl+Space selects the column", async () => {
  await open();
  down(td(1, 2));
  fireEvent.click(screen.getByRole("button", { name: "Sort by status" }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
  await screen.findByText("refunded");
  // Sorting shows the rows anew: nothing is selected until a click.
  expect(selectedCells()).toEqual([]);
  down(td(1, 2));
  key(" ", { ctrlKey: true });
  expect(selectedCells()).toHaveLength(12);
  expect(selectedCells().every((c) => c.endsWith(":2"))).toBe(true);
});

test("Ctrl+C copies the block tab separated with NULL empty; Ctrl+Shift+C adds the header line", async () => {
  await open();
  down(td(4, 2));
  down(td(5, 4), { shiftKey: true });
  key("c", { ctrlKey: true, code: "KeyC" });
  expect(writeText).toHaveBeenLastCalledWith("cancelled\t2026-10-03 10:05:09+07\t0.00\npaid\t\t1204.00");
  expect(note()).toBe("Copied 6 cells.");
  // The copied block wears the dashed mark until Esc, which never shrinks the selection.
  expect(td(4, 2).className).toContain("cell-copied");
  key("Escape");
  expect(td(4, 2).className).not.toContain("cell-copied");
  expect(selectedCells()).toHaveLength(6);
  key("C", { ctrlKey: true, shiftKey: true, code: "KeyC" });
  expect(writeText).toHaveBeenLastCalledWith(
    "status\tordered_at\ttotal\ncancelled\t2026-10-03 10:05:09+07\t0.00\npaid\t\t1204.00",
  );
  expect(note()).toBe("Copied 6 cells with headers.");
});

test("copy writes CRLF on Windows", async () => {
  setPlatformForTests("windows");
  await open();
  down(td(0, 0));
  down(td(1, 1), { shiftKey: true });
  key("c", { ctrlKey: true, code: "KeyC" });
  expect(writeText).toHaveBeenLastCalledWith("1001\t214\r\n1002\t87");
});

test("cells that do not make one block are not copied, and the note says why", async () => {
  await open();
  down(td(0, 0));
  down(td(2, 3), { ctrlKey: true });
  key("c", { ctrlKey: true, code: "KeyC" });
  expect(writeText).not.toHaveBeenCalled();
  expect(note()).toBe("Not copied: copy takes one block, or blocks sharing rows or columns.");
});

test("the cell menu is target first, in the board's order, with its keys", async () => {
  await open();
  fireEvent.contextMenu(td(2, 2));
  expect(document.querySelector(".tree-menu .menu-heading")!.textContent).toBe("status, row 3");
  expect(menuLabels()).toEqual([
    "Copy",
    "Copy with headers",
    "Paste",
    "Set NULL",
    "Set DEFAULT",
    "Filter by this value",
    "Open full value",
    "Duplicate row",
    "Delete row",
  ]);
  const shortcuts = Array.from(document.querySelectorAll(".tree-menu [role=menuitem]")).map((b) => b.querySelector(".menu-shortcut")?.textContent ?? "");
  expect(shortcuts).toEqual(["Ctrl+C", "Ctrl+Shift+C", "Ctrl+V", "Ctrl+Alt+N", "Ctrl+Alt+D", "", "Shift+F2", "Ctrl+D", "Alt+Delete"]);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
});

test("right-click inside the selection keeps it; whole rows read in the plural", async () => {
  await open();
  down(rowNumber(1));
  down(rowNumber(3), { shiftKey: true });
  fireEvent.contextMenu(td(2, 1));
  expect(selectedCells()).toHaveLength(15);
  expect(document.querySelector(".tree-menu .menu-heading")!.textContent).toBe("3 rows");
  expect(menuLabels()).toContain("Duplicate 3 rows");
  expect(menuLabels()).toContain("Delete 3 rows");
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete 3 rows" }));
  expect(document.querySelectorAll("tr.row-deleted")).toHaveLength(3);
  // Right-click outside the selection selects that cell first.
  fireEvent.contextMenu(td(8, 1));
  expect(selectedCells()).toEqual(["8:1"]);
});

test("Shift+F10 opens the menu at the active cell", async () => {
  await open();
  down(td(1, 1));
  key("F10", { shiftKey: true });
  expect(menuLabels()[0]).toBe("Copy");
});

test("Delete clears text to empty, nullable cells to NULL, and leaves the key and NOT NULL columns with a note", async () => {
  await open();
  down(td(0, 0));
  down(td(1, 4), { shiftKey: true });
  key("Delete");
  // The table's design (nullability, defaults) is read the first time it is needed.
  await waitFor(() => expect(td(0, 2).textContent).toBe(""));
  expect(callsTo("table_design")).toHaveLength(1);
  expect(td(0, 2).className).toContain("cell-edited");
  expect(td(0, 3).textContent).toBe("NULL");
  expect(td(0, 4).textContent).toBe("NULL");
  expect(td(0, 0).textContent).toBe("1001");
  expect(td(0, 1).textContent).toBe("214");
  expect(td(0, 1).className).not.toContain("cell-edited");
  expect(note()).toBe("Cleared 6 cells. Key column id left as it is. customer_id can't be empty or NULL, so it was left as it is.");
  expect(document.querySelectorAll("tr.row-deleted")).toHaveLength(0);
  // One undo step brings every cell back.
  key("z", { ctrlKey: true, code: "KeyZ" });
  expect(td(0, 2).textContent).toBe("paid");
  expect(td(1, 3).textContent).toBe("2026-10-01 11:02:45+07");
});

test("Ctrl+Alt+N sets NULL and Ctrl+Alt+D sets DEFAULT on the selection, as Pending Edits", async () => {
  await open();
  down(td(2, 3));
  down(td(3, 4), { shiftKey: true });
  key("n", { ctrlKey: true, altKey: true, code: "KeyN" });
  await waitFor(() => expect(td(2, 3).textContent).toBe("NULL"));
  expect(td(3, 4).textContent).toBe("NULL");
  expect(note()).toBe("Set 4 cells to NULL.");
  down(td(4, 2));
  down(td(4, 4), { shiftKey: true });
  key("d", { ctrlKey: true, altKey: true, code: "KeyD" });
  // Constant defaults are written in; an expression default is written as DEFAULT, for the server to work out.
  expect(td(4, 2).textContent).toBe("pending");
  expect(td(4, 4).textContent).toBe("0");
  expect(td(4, 3).textContent).toBe("default");
  expect(td(4, 3).className).toContain("cell-edited");
  expect(note()).toBe("Set 3 cells to DEFAULT.");
  // NOT NULL columns are not set to NULL.
  down(td(6, 1));
  key("n", { ctrlKey: true, altKey: true, code: "KeyN" });
  expect(td(6, 1).textContent).toBe("318");
  expect(note()).toBe("customer_id can't be NULL, so it was left as it is.");
});

test("Set DEFAULT on a saved row sends DEFAULT for an expression default on Postgres and MySQL", async () => {
  for (const dialect of ["postgres", "mysql"] as const) {
    cleanup();
    vi.mocked(invoke).mockClear();
    await open({ dialect }, orders, { plan_edits: () => new Promise(() => {}) });
    down(td(4, 3));
    key("d", { ctrlKey: true, altKey: true, code: "KeyD" });
    await waitFor(() => expect(td(4, 3).textContent).toBe("default"));
    key("s", { ctrlKey: true });
    await waitFor(() => expect(callsTo("plan_edits")).toHaveLength(1));
    const edits = callsTo("plan_edits")[0].edits as { updates: { changes: { column: string; new: unknown }[] }[] };
    expect(edits.updates[0].changes).toEqual([expect.objectContaining({ column: "ordered_at", new: { t: "default" } })]);
  }
});

test("M6: a pending DEFAULT shows and copies as the default marker, and Filter by this value is off with the reason", async () => {
  await open();
  down(td(4, 3));
  key("d", { ctrlKey: true, altKey: true, code: "KeyD" });
  await waitFor(() => expect(td(4, 3).textContent).toBe("default"));
  key("c", { ctrlKey: true, code: "KeyC" });
  expect(writeText).toHaveBeenLastCalledWith("default");
  fireEvent.contextMenu(td(4, 3));
  const filter = screen.getByRole("menuitem", { name: "Filter by this value" }) as HTMLButtonElement;
  expect(filter.getAttribute("aria-disabled") === "true" || filter.disabled).toBe(true);
  expect(filter.getAttribute("title")).toBe("DEFAULT has no value yet: the server works it out on Save.");
});

test("Set DEFAULT on a saved SQLite row leaves an expression default with a note: SQLite has no DEFAULT in UPDATE", async () => {
  await open({ dialect: "sqlite" });
  down(td(4, 2));
  down(td(4, 4), { shiftKey: true });
  key("d", { ctrlKey: true, altKey: true, code: "KeyD" });
  await waitFor(() => expect(td(4, 2).textContent).toBe("pending"));
  expect(td(4, 4).textContent).toBe("0");
  expect(td(4, 3).textContent).toBe("2026-10-03 10:05:09+07");
  expect(note()).toBe("Set 2 cells to DEFAULT. ordered_at's default now() is worked out by the server, so only a new row takes it.");
});

test("M1: AltGr is not Ctrl+Alt: AltGr+N types ń into the cell instead of setting NULL", async () => {
  await open();
  down(td(2, 2));
  key("ń", { ctrlKey: true, altKey: true, code: "KeyN" });
  expect(td(2, 2).textContent).not.toBe("NULL");
  expect(screen.getByRole("textbox", { name: "Cell value" })).toBeTruthy();
  expect(callsTo("table_design")).toHaveLength(0);
});

test("Ctrl+Alt+N is Set NULL only while the grid has focus; elsewhere New diagram keeps it", async () => {
  const newDiagram = vi.fn();
  function Host() {
    useCommandKeys({ "flow.new": newDiagram });
    return <DataGrid connectionId="c1" table={table} onClose={() => {}} />;
  }
  routeInvoke({ fetch_page: () => orders(), table_design: () => design });
  render(
    <ToastProvider>
      <Host />
    </ToastProvider>,
  );
  await screen.findByText("refunded");
  down(td(2, 3));
  grid().focus();
  key("n", { ctrlKey: true, altKey: true, code: "KeyN" });
  expect(newDiagram).not.toHaveBeenCalled();
  await waitFor(() => expect(td(2, 3).textContent).toBe("NULL"));
  fireEvent.keyDown(document.body, { key: "n", ctrlKey: true, altKey: true, code: "KeyN" });
  expect(newDiagram).toHaveBeenCalledTimes(1);
});

test("M13: F6 through the real keymap leaves the grid for the next pane, and Shift+F6 comes back to the same cell", async () => {
  function Host() {
    useCommandKeys({ "pane.next": () => cyclePane(1), "pane.previous": () => cyclePane(-1) });
    return (
      <>
        <nav data-pane aria-label="Tree">
          <button type="button">orders</button>
        </nav>
        <DataGrid connectionId="c1" table={table} onClose={() => {}} />
      </>
    );
  }
  const stop = rememberPaneFocus(document);
  routeInvoke({ fetch_page: () => orders(), table_design: () => design });
  render(
    <ToastProvider>
      <Host />
    </ToastProvider>,
  );
  await screen.findByText("refunded");
  down(td(2, 3));
  grid().focus();
  // Tab stays in the grid (ruling 5).
  key("Tab");
  expect(td(2, 4).className).toContain("cell-selected");
  expect(grid().contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: "F6", code: "F6" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "orders" }));
  fireEvent.keyDown(document.activeElement!, { key: "F6", code: "F6", shiftKey: true });
  expect(grid().contains(document.activeElement)).toBe(true);
  expect(td(2, 4).className).toContain("cell-selected");
  stop();
});

test("M13: on a Production Connection, Set NULL, Delete and paste stay Pending Edits until Save on Production confirms", async () => {
  await open({ production: true, connectionName: "freight-prod" }, orders, { plan_edits: () => new Promise(() => {}) });
  down(td(0, 3));
  key("n", { ctrlKey: true, altKey: true, code: "KeyN" });
  await waitFor(() => expect(td(0, 3).textContent).toBe("NULL"));
  down(td(1, 4));
  key("Delete");
  expect(td(1, 4).textContent).toBe("NULL");
  down(td(2, 2));
  fireEvent.paste(grid(), { clipboardData: { getData: () => "cancelled" } });
  expect(td(2, 2).textContent).toBe("cancelled");
  // Nothing has reached the database: the edits wait, and Save says it is Production.
  expect(callsTo("plan_edits")).toHaveLength(0);
  expect(callsTo("apply_edits")).toHaveLength(0);
  expect(screen.getByRole("region", { name: "Pending Edits" }).textContent).toContain("3 changes");
  expect(screen.getByRole("button", { name: "Save on Production" })).toBeTruthy();
  // One undo step takes back each change.
  key("z", { ctrlKey: true, code: "KeyZ" });
  expect(td(2, 2).textContent).toBe("pending");
});

test("M13: on a Read-only Connection, Ctrl+V and Ctrl+Alt+N change nothing and say why", async () => {
  await open({ readOnly: true, connectionName: "reporting" });
  down(td(0, 2));
  fireEvent.paste(grid(), { clipboardData: { getData: () => "cancelled" } });
  expect(await screen.findByText("reporting is Read-only. Changes are not allowed.")).toBeTruthy();
  expect(td(0, 2).textContent).toBe("paid");
  down(td(0, 3));
  key("n", { ctrlKey: true, altKey: true, code: "KeyN" });
  expect(td(0, 3).textContent).toBe("2026-10-01 09:14:07+07");
  expect(screen.queryByRole("region", { name: "Pending Edits" })).toBeNull();
  expect(callsTo("table_design")).toHaveLength(0);
});

test("Delete on rows chosen by number deletes them; Alt+Delete deletes the rows the selection spans", async () => {
  await open();
  down(rowNumber(1));
  key("Delete");
  expect(document.querySelectorAll("tr.row-deleted")).toHaveLength(1);
  expect(note()).toBe("Row 2 marked for deletion. Ctrl+Z undoes.");
  // Ctrl+A then Delete clears cells; it does not delete every row.
  down(td(5, 2));
  down(td(7, 3), { shiftKey: true });
  key("Delete", { altKey: true });
  expect(document.querySelectorAll("tr.row-deleted")).toHaveLength(4);
  expect(note()).toBe("3 rows marked for deletion. Ctrl+Z undoes.");
  key("z", { ctrlKey: true, code: "KeyZ" });
  expect(document.querySelectorAll("tr.row-deleted")).toHaveLength(1);
  key("a", { ctrlKey: true, code: "KeyA" });
  key("Delete");
  expect(document.querySelectorAll("tr.row-deleted")).toHaveLength(1);
});

test("Ctrl+D duplicates the selected rows below them; Ctrl+N and Alt+Insert add a row below the current one", async () => {
  await open();
  down(rowNumber(1));
  down(rowNumber(2), { shiftKey: true });
  key("d", { ctrlKey: true, code: "KeyD" });
  const rows = () => Array.from(document.querySelectorAll("tbody tr[data-row]"));
  await waitFor(() => expect(rows()[3].className).toContain("row-added"));
  expect(rows()[4].className).toContain("row-added");
  expect(td(3, 2).textContent).toBe("shipped");
  expect(td(4, 2).textContent).toBe("pending");
  expect(rows()[5].querySelector("td.row-number")!.textContent).toBe("4");
  down(td(0, 2));
  key("Insert", { altKey: true });
  expect(rows()[1].className).toContain("row-added");
  expect(td(1, 1).className).toContain("cell-selected");
  key("n", { ctrlKey: true, code: "KeyN" });
  expect(rows()[2].className).toContain("row-added");
  expect(document.querySelectorAll("tr.row-added")).toHaveLength(4);
});

test("paste fills the selection with one value, or lands a block from its top-left cell", async () => {
  await open();
  down(td(0, 2));
  down(td(2, 2), { shiftKey: true });
  fireEvent.paste(grid(), { clipboardData: { getData: () => "void" } });
  expect([td(0, 2), td(1, 2), td(2, 2)].map((c) => c.textContent)).toEqual(["void", "void", "void"]);
  down(td(3, 3));
  down(td(5, 4), { shiftKey: true });
  fireEvent.paste(grid(), { clipboardData: { getData: () => "a\t1\nb\t2" } });
  expect([td(3, 3), td(3, 4), td(4, 3), td(4, 4)].map((c) => c.textContent)).toEqual(["a", "1", "b", "2"]);
  expect(td(5, 4).textContent).toBe("1204.00");
  // The menu's Paste reads the clipboard.
  readText.mockResolvedValueOnce("menu");
  fireEvent.contextMenu(td(6, 2));
  fireEvent.click(screen.getByRole("menuitem", { name: "Paste" }));
  await waitFor(() => expect(td(6, 2).textContent).toBe("menu"));
});

test("Tab stays in the grid and wraps; Home, End, Ctrl+Home, Ctrl+End, PageUp and PageDown move", async () => {
  await open();
  down(td(0, 3));
  expect(key("Tab")).toBe(false);
  expect(td(0, 4).className).toContain("cell-selected");
  key("Tab");
  expect(td(1, 0).className).toContain("cell-selected");
  key("Tab", { shiftKey: true });
  expect(td(0, 4).className).toContain("cell-selected");
  key("Home");
  expect(td(0, 0).className).toContain("cell-selected");
  key("End");
  expect(td(0, 4).className).toContain("cell-selected");
  key("End", { ctrlKey: true });
  expect(td(11, 4).className).toContain("cell-selected");
  key("Home", { ctrlKey: true });
  expect(td(0, 0).className).toContain("cell-selected");
  key("PageDown");
  expect(document.querySelector("td.cell-selected")!.closest("tr")!.getAttribute("data-row")).not.toBe("0");
  key("PageUp");
  expect(td(0, 0).className).toContain("cell-selected");
  key("ArrowDown", { shiftKey: true });
  key("ArrowRight", { shiftKey: true });
  expect(selectedCells()).toHaveLength(4);
});

test("Enter and F2 edit the active cell; Esc cancels and keeps the selection", async () => {
  await open();
  down(td(0, 2));
  down(td(1, 3), { shiftKey: true });
  key("Enter");
  const editor = screen.getByRole("textbox", { name: "Cell value" });
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: "Cell value" })).toBeNull();
  key("F2");
  expect(screen.getByRole("textbox", { name: "Cell value" })).toBeTruthy();
});

test("Ctrl+F opens Add filter with the active cell's column and value filled in", async () => {
  await open();
  down(td(3, 2));
  key("f", { ctrlKey: true, code: "KeyF" });
  const dialog = await screen.findByRole("dialog", { name: "Add filter" });
  expect((dialog.querySelector("input[aria-label=Value]") as HTMLInputElement).value).toBe("delivered");
  expect(dialog.textContent).toContain("status");
});

test("Filter by this value adds the filter at once", async () => {
  await open();
  fireEvent.contextMenu(td(1, 2));
  fireEvent.click(screen.getByRole("menuitem", { name: "Filter by this value" }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
  expect((callsTo("fetch_page")[1].request as { filter: string }).filter).toContain("shipped");
});

test("M11: Filter by this value on a timestamp filters by the exact value shown, not its day", async () => {
  await open();
  fireEvent.contextMenu(td(1, 3));
  fireEvent.click(screen.getByRole("menuitem", { name: "Filter by this value" }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
  expect((callsTo("fetch_page")[1].request as { filter: string }).filter).toBe(`"ordered_at" = '2026-10-01 11:02:45+07'`);
});

test("a Read-only Connection still selects and copies; edit keys say why they do nothing", async () => {
  await open({ readOnly: true, connectionName: "reporting" });
  down(td(0, 1));
  down(td(1, 2), { shiftKey: true });
  key("c", { ctrlKey: true, code: "KeyC" });
  expect(writeText).toHaveBeenLastCalledWith("214\tpaid\n87\tshipped");
  key("Delete");
  expect(td(0, 2).textContent).toBe("paid");
  expect(await screen.findByText("reporting is Read-only. Changes are not allowed.")).toBeTruthy();
  fireEvent.contextMenu(td(0, 1));
  expect(menuLabels()).toEqual(["Copy", "Copy with headers", "Filter by this value", "Open full value"]);
});

test("M2: a copy the clipboard refuses says so", async () => {
  writeText.mockRejectedValueOnce(new Error("denied"));
  await open();
  down(td(0, 1));
  key("c", { ctrlKey: true, code: "KeyC" });
  await waitFor(() => expect(note()).toBe("Not copied: the clipboard refused."));
});

test("M6: a design that can't be read is asked for once, and the note says nullability is unknown", async () => {
  routeInvoke({
    fetch_page: () => orders(),
    table_design: () => {
      throw { kind: "query", message: "no access" };
    },
  });
  render(
    <ToastProvider>
      <DataGrid connectionId="c1" table={table} onClose={() => {}} />
    </ToastProvider>,
  );
  await screen.findByText("refunded");
  down(td(0, 3));
  key("Delete");
  await waitFor(() => expect(td(0, 3).textContent).toBe("NULL"));
  expect(note()).toBe("Cleared 1 cell. Column details could not be read, so Save may refuse NULL in a NOT NULL column.");
  down(td(1, 3));
  key("Delete");
  await waitFor(() => expect(td(1, 3).textContent).toBe("NULL"));
  expect(callsTo("table_design")).toHaveLength(1);
});

test("M9: a header click keeps focus on the grid, so its keys still work", async () => {
  await open();
  grid().focus();
  const sort = screen.getByRole("button", { name: "Sort by status" });
  expect(fireEvent.mouseDown(sort, { button: 0 })).toBe(false);
  expect(document.activeElement).toBe(grid());
});

test("M10: Ctrl+F with no cell selected opens Add filter on the first column", async () => {
  await open();
  key("f", { ctrlKey: true, code: "KeyF" });
  const dialog = await screen.findByRole("dialog", { name: "Add filter" });
  expect(dialog.textContent).toContain("id");
});

// Polish A7 (M7): the status line under the grid sums up the selection, as Excel's does.
const summary = () => document.querySelector(".table-selection")?.textContent ?? "";

test("polish A7: the status line says how many cells are selected, with their Count and Sum", async () => {
  await open();
  expect(summary()).toBe("");
  down(td(4, 2));
  expect(summary()).toBe("");
  down(td(5, 4), { shiftKey: true });
  // status, ordered_at and total of rows 5 and 6: one NULL, and 0.00 + 1204.00.
  expect(summary()).toBe("6 cells selected, Count 5, Sum 1,204");
  // M7: no live region, so holding Shift+Arrow does not read the status out on every repeat.
  expect(document.querySelector(".table-selection")?.getAttribute("role")).toBeNull();

  // A column of text has a Count and no Sum.
  down(td(0, 2));
  down(td(3, 2), { shiftKey: true });
  expect(summary()).toBe("4 cells selected, Count 4");
  key("Escape");
});

test("polish A7: Select all counts every cell of the page", async () => {
  await open();
  down(td(0, 0));
  key("a", { ctrlKey: true, code: "KeyA" });
  expect(summary()).toMatch(/^60 cells selected, Count 58, Sum /);
});

// Polish A7 (M3, M4): a paste skips what can't be edited and says how many, and a block does not land on several ranges.
test("polish A7 M3: a block paste skips key cells, says how many, and still fills the rest", async () => {
  await open();
  down(td(0, 0));
  fireEvent.paste(grid(), { clipboardData: { getData: () => "9\tx\ny\tz" } });
  // The key cells id of rows 1 and 2 are left; the other two cells are written.
  expect(td(0, 0).textContent).toBe("1001");
  expect(td(1, 0).textContent).toBe("1002");
  expect(td(0, 1).textContent).toBe("x");
  expect(td(1, 1).textContent).toBe("z");
  expect(note()).toBe("Pasted 2 cells. Key column id left as it is.");
});

test("polish A7 M3: one value over cells that include a key column fills the others and says what it left", async () => {
  await open();
  down(td(0, 0));
  down(td(1, 1), { shiftKey: true });
  fireEvent.paste(grid(), { clipboardData: { getData: () => "7" } });
  expect([td(0, 1).textContent, td(1, 1).textContent]).toEqual(["7", "7"]);
  expect(td(0, 0).textContent).toBe("1001");
  expect(note()).toBe("Pasted 2 cells. Key column id left as it is.");
});

test("polish A7 M3: binary cells are skipped like key cells", async () => {
  const withBytes = (): Page => {
    const p = orders();
    p.columns[4] = { name: "blob", typeName: "bytea", isPrimaryKey: false };
    p.rows[0][4] = { t: "bytes", previewHex: "00ff", truncated: false, totalBytes: 2 };
    return p;
  };
  await open({}, withBytes);
  down(td(0, 2));
  fireEvent.paste(grid(), { clipboardData: { getData: () => "a\tb\tc" } });
  expect([td(0, 2).textContent, td(0, 3).textContent]).toEqual(["a", "b"]);
  expect(note()).toBe("Pasted 2 cells. Binary value left as it is.");
});

test("polish A7 M3: a paste with nothing editable says so and changes nothing", async () => {
  await open();
  down(td(0, 0));
  fireEvent.paste(grid(), { clipboardData: { getData: () => "9" } });
  expect(td(0, 0).textContent).toBe("1001");
  expect(note()).toBe("Nothing pasted. Key column id left as it is.");
  expect(document.querySelector(".cell-edited")).toBeNull();
});

test("polish A7 M4: a block is not pasted into several selected ranges, as Excel refuses it", async () => {
  await open();
  down(td(0, 2));
  down(td(3, 2), { ctrlKey: true });
  fireEvent.paste(grid(), { clipboardData: { getData: () => "a\nb" } });
  expect(note()).toBe("This action won't work on multiple selections.");
  expect([td(0, 2).textContent, td(3, 2).textContent]).toEqual(["paid", "delivered"]);
  // One value still fills every range.
  fireEvent.paste(grid(), { clipboardData: { getData: () => "one" } });
  expect([td(0, 2).textContent, td(3, 2).textContent]).toEqual(["one", "one"]);
});
