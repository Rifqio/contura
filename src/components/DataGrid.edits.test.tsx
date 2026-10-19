import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { Cell, Page } from "../api/types";
import appCss from "../styles/app.css?raw";
import { mockEditorDom } from "../test/editor";
import { callsTo, routeInvoke } from "../test/invoke";
import DataGrid from "./DataGrid";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
mockEditorDom();

const table = { database: "shop", schema: "public", name: "orders" };
const num = (value: string): Cell => ({ t: "number", value });
const text = (value: string, truncated = false): Cell => ({ t: "text", value, truncated, totalBytes: value.length });
const bytes: Cell = { t: "bytes", previewHex: "ff00", truncated: false, totalBytes: 2 };

function orders(keyed = true, pageNo = 0): Page {
  return {
    columns: [
      { name: "id", typeName: "bigint", isPrimaryKey: keyed },
      { name: "status", typeName: "varchar", isPrimaryKey: false },
      { name: "note", typeName: "text", isPrimaryKey: false },
      { name: "data", typeName: "bytea", isPrimaryKey: false },
    ],
    rows: [
      [num(String(1 + pageNo * 10)), text("paid"), text("short"), bytes],
      [num(String(2 + pageNo * 10)), text("shipped"), text("a long note cut", true), bytes],
    ],
    hasMore: pageNo === 0,
  };
}

const grid = () => document.querySelector(".grid-scroll") as HTMLElement;
const td = (row: number, col: number) =>
  document.querySelector(`tr[data-row="${row}"] td[data-col="${col}"]`) as HTMLElement;
const editor = () => screen.queryByRole("textbox", { name: "Cell value" }) as HTMLTextAreaElement | null;
const key = (k: string, extra: object = {}) => fireEvent.keyDown(grid(), { key: k, ...extra });

async function open(
  page = orders(),
  props: Partial<Parameters<typeof DataGrid>[0]> = {},
  extra: Parameters<typeof routeInvoke>[0] = {},
) {
  routeInvoke({
    fetch_page: (a) => orders(page.columns[0].isPrimaryKey, (a.request as { page: number }).page),
    fetch_full_value: () => ({ t: "text", value: "a long note cut short no more" }),
    ...extra,
  });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} {...props} />);
  await screen.findByText("paid");
}

test("arrow keys select, enter and typing open the editor, enter keeps the value and moves down", async () => {
  await open();
  fireEvent.mouseDown(td(0, 1));
  expect(td(0, 1).className).toContain("cell-selected");
  key("ArrowRight");
  key("ArrowLeft");
  key("ArrowDown");
  expect(td(1, 1).className).toContain("cell-selected");
  key("ArrowUp");
  key("Enter");
  expect(editor()!.value).toBe("paid");
  fireEvent.change(editor()!, { target: { value: "cancelled" } });
  fireEvent.keyDown(editor()!, { key: "Enter" });
  expect(editor()).toBeNull();
  expect(td(0, 1).textContent).toBe("cancelled");
  expect(td(0, 1).className).toContain("cell-edited");
  expect(td(0, 1).title).toBe("Was paid. Edited, not saved yet.");
  expect(document.querySelector('tr[data-row="0"] .row-number-edited')).not.toBeNull();
  expect(td(1, 1).className).toContain("cell-selected");
  key("x");
  expect(editor()!.value).toBe("x");
  fireEvent.keyDown(editor()!, { key: "Escape" });
  expect(td(1, 1).textContent).toBe("shipped");
});

test("double-click and F2 open the editor; tab moves right", async () => {
  await open();
  fireEvent.doubleClick(td(0, 2));
  expect(editor()!.value).toBe("short");
  fireEvent.keyDown(editor()!, { key: "Tab" });
  expect(td(0, 3).className).toContain("cell-selected");
  fireEvent.mouseDown(td(0, 1));
  key("F2");
  expect(editor()).not.toBeNull();
});

test("a cut-short value is loaded in full before the editor opens", async () => {
  await open();
  fireEvent.doubleClick(td(1, 2));
  await waitFor(() => expect(editor()!.value).toBe("a long note cut short no more"));
  expect(callsTo("fetch_full_value")[0]).toMatchObject({
    request: { table, column: "note", key: [{ column: "id", value: num("2") }] },
  });
});

test("a binary cell only offers Set NULL", async () => {
  await open();
  fireEvent.doubleClick(td(0, 3));
  expect(editor()).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Binary values can only be set to NULL here");
  fireEvent.contextMenu(td(0, 3));
  const items = screen.getAllByRole("menuitem").map((b) => b.textContent);
  expect(items).toEqual(["Delete row", "Duplicate row", "Set NULL"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Set NULL" }));
  expect(td(0, 3).textContent).toBe("NULL");
  expect(td(0, 3).className).toContain("cell-edited");
});

test("key cells of loaded rows can't be edited", async () => {
  await open();
  fireEvent.doubleClick(td(0, 0));
  expect(editor()).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Key columns can't be changed here");
});

test("a table without a primary key says so and doesn't edit loaded rows", async () => {
  await open(orders(false));
  expect(screen.getByRole("status").textContent).toBe("This table has no primary key, so its rows can't be edited");
  fireEvent.doubleClick(td(0, 1));
  expect(editor()).toBeNull();
  fireEvent.mouseDown(td(0, 1));
  key("Delete");
  expect(document.querySelector(".row-deleted")).toBeNull();
  key("n", { ctrlKey: true });
  // T3: the new row goes at the bottom, under the two loaded rows.
  expect(document.querySelector('tr[data-row="2"]')!.className).toContain("row-added");
  // the new row is selected at its first column, so the paste starts there
  fireEvent.paste(grid(), { clipboardData: { getData: () => "x\ty" } });
  expect(td(2, 0).textContent).toBe("x");
  expect(td(2, 1).textContent).toBe("y");
});

test("read-only and view grids never open the editor", async () => {
  await open(orders(), { readOnly: true });
  fireEvent.doubleClick(td(0, 1));
  expect(editor()).toBeNull();
  expect(screen.queryByRole("button", { name: "Add row" })).toBeNull();
});

test("ctrl+n adds a new row at the bottom with default in its key, and it can be typed into", async () => {
  await open();
  fireEvent.mouseDown(td(0, 1));
  key("n", { ctrlKey: true });
  const row = document.querySelector('tr[data-row="2"]')!;
  expect(row.className).toContain("row-added");
  expect(row.querySelector(".row-number")!.textContent).toBe("+");
  // T3: `default` only in the key column; the other unset cells stay empty.
  expect(td(2, 0).textContent).toBe("default");
  expect(td(2, 1).textContent).toBe("");
  expect(td(2, 0).className).toContain("cell-selected");
  expect(document.querySelector('tr[data-row="0"] .row-number')!.textContent).toBe("1");
  fireEvent.doubleClick(td(2, 1));
  fireEvent.change(editor()!, { target: { value: "pending" } });
  fireEvent.keyDown(editor()!, { key: "Enter" });
  expect(td(2, 1).textContent).toBe("pending");
});

test("duplicate copies the row except its key; delete marks and removes", async () => {
  await open();
  fireEvent.contextMenu(td(0, 1));
  fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate row" }));
  expect(td(2, 0).textContent).toBe("default");
  expect(td(2, 1).textContent).toBe("paid");
  expect(td(2, 2).textContent).toBe("short");
  key("Delete");
  expect(document.querySelector(".row-added")).toBeNull();
  fireEvent.mouseDown(td(0, 1));
  key("Delete");
  expect(document.querySelector('tr[data-row="0"]')!.className).toContain("row-deleted");
});

test("ctrl+z undoes and ctrl+y redoes", async () => {
  await open();
  fireEvent.doubleClick(td(0, 1));
  fireEvent.change(editor()!, { target: { value: "lost" } });
  fireEvent.keyDown(editor()!, { key: "Enter" });
  key("z", { ctrlKey: true });
  expect(td(0, 1).textContent).toBe("paid");
  key("y", { ctrlKey: true });
  expect(td(0, 1).textContent).toBe("lost");
});

test("paste fills a block, extra lines become new rows, and key columns are refused", async () => {
  await open();
  fireEvent.mouseDown(td(1, 1));
  fireEvent.paste(grid(), { clipboardData: { getData: () => "a\tb\nc\td\n" } });
  // the extra line became a new row at the bottom, under the row the block started on
  expect(td(1, 1).textContent).toBe("a");
  expect(td(1, 2).textContent).toBe("b");
  expect(td(2, 1).textContent).toBe("c");
  expect(td(2, 2).textContent).toBe("d");
  key("z", { ctrlKey: true });
  expect(document.querySelector(".row-added")).toBeNull();
  expect(td(1, 1).textContent).toBe("shipped");
  fireEvent.mouseDown(td(0, 0));
  fireEvent.paste(grid(), { clipboardData: { getData: () => "9\tx" } });
  expect(screen.getByRole("status").textContent).toBe("Pasting can't change key columns.");
  expect(td(0, 1).textContent).toBe("paid");
});

test("edits stay when the page changes", async () => {
  await open();
  fireEvent.doubleClick(td(0, 1));
  fireEvent.change(editor()!, { target: { value: "lost" } });
  fireEvent.keyDown(editor()!, { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByText("11");
  fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
  await screen.findByText("lost");
  expect(td(0, 1).className).toContain("cell-edited");
});

// ---- Save (Task 7) ----

const okPlan = () => ({ statements: ["UPDATE \"public\".\"orders\" SET \"status\" = 'lost' WHERE \"id\" = 1 AND \"status\" = 'paid'"], verdict: { kind: "ok" } });
const askPlan = () => ({
  statements: ["UPDATE x"],
  verdict: {
    kind: "needsConfirmation",
    connection: "freight-prod",
    database: "shop",
    statements: [{ text: "UPDATE x", class: "write" }],
    writes: 1,
  },
});
const saved = () => ({ updated: 1, inserted: 0, deleted: 0 });

async function editStatus(row = 0, value = "lost") {
  fireEvent.doubleClick(td(row, 1));
  fireEvent.change(editor()!, { target: { value } });
  fireEvent.keyDown(editor()!, { key: "Enter" });
}

test("the bar appears with the first edit, counts changes and discards", async () => {
  await open();
  expect(screen.queryByRole("region", { name: "Pending Edits" })).toBeNull();
  await editStatus(0);
  const bar = screen.getByRole("region", { name: "Pending Edits" });
  // T2: the chip counts changes.
  expect(bar.textContent).toContain("1 change");
  expect(bar.textContent).toContain("1 edited cell");
  await editStatus(1, "gone");
  expect(bar.textContent).toContain("2 changes");
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(screen.queryByRole("region", { name: "Pending Edits" })).toBeNull();
  expect(td(0, 1).textContent).toBe("paid");
});

test("save on a plain Connection plans, applies without a pass and reloads", async () => {
  await open(orders(), {}, { plan_edits: okPlan, apply_edits: saved });
  await editStatus(0);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(callsTo("apply_edits")).toHaveLength(1));
  expect(callsTo("apply_edits")[0]).toMatchObject({ id: "c1", pass: null, edits: { table } });
  expect((callsTo("apply_edits")[0].edits as { updates: unknown[] }).updates).toHaveLength(1);
  await waitFor(() => expect(screen.queryByRole("region", { name: "Pending Edits" })).toBeNull());
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
});

test("ctrl+s saves", async () => {
  await open(orders(), {}, { plan_edits: okPlan, apply_edits: saved });
  await editStatus(0);
  key("s", { ctrlKey: true });
  await waitFor(() => expect(callsTo("apply_edits")).toHaveLength(1));
});

test("on Production save asks first, then saves with the pass; cancel keeps the edits", async () => {
  await open(orders(), { production: true }, { plan_edits: askPlan, confirm_edits: () => "p1", apply_edits: saved });
  await editStatus(0);
  expect(document.querySelector(".grid-production-edits")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save on Production" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("Save on freight-prod · shop");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(callsTo("apply_edits")).toHaveLength(0);
  expect(td(0, 1).textContent).toBe("lost");
  fireEvent.click(screen.getByRole("button", { name: "Save on Production" }));
  fireEvent.click(await screen.findByRole("button", { name: "Save on freight-prod" }));
  await waitFor(() => expect(callsTo("apply_edits")).toHaveLength(1));
  expect(callsTo("confirm_edits")).toHaveLength(1);
  expect(callsTo("apply_edits")[0]).toMatchObject({ pass: "p1" });
  await waitFor(() => expect(document.querySelector(".grid-production-edits")).toBeNull());
});

/** The declaration blocks of every app.css rule whose selector names `cls`. */
const rulesFor = (cls: string) =>
  Array.from(appCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g))
    .filter((m) => m[1].includes(cls))
    .map((m) => ({ selector: m[1].trim(), body: m[2] }));

test("a Production grid with an edit keeps its class, loses the outline and saves on PROD", async () => {
  await open(orders(), { production: true });
  await editStatus(0);
  const view = document.querySelector(".grid-production-edits") as HTMLElement;
  expect(view).not.toBeNull();
  expect(view.classList.contains("prod-wash")).toBe(true);
  for (const r of rulesFor("grid-production-edits")) expect(r.body).not.toMatch(/outline/);
  const save = screen.getByRole("button", { name: "Save on Production" });
  expect(save.className).toContain("button-prod");
  // R8: the button shows PROD; its spoken name keeps the word.
  expect(save.textContent).toBe("Save on PRODCtrl+S");
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(screen.getByText("Saving runs on Production and asks you to confirm the SQL first.")).toBeTruthy();
});

test("a plain grid has no wash and a plain Save", async () => {
  await open();
  await editStatus(0);
  expect(document.querySelector(".prod-wash")).toBeNull();
  expect(screen.getByRole("button", { name: "Save" }).className).not.toContain("button-prod");
  expect(screen.queryByText("Saving runs on Production and asks you to confirm the SQL first.")).toBeNull();
});

// Review Focus 5: the Dracula warning tint sits near the wash, so the edge and the chip carry the edit.
test("pending_edit_on_production_keeps_its_edge_and_chip", async () => {
  await open(orders(), { production: true });
  await editStatus(0);
  expect(td(0, 1).className).toContain("cell-edited");
  const chip = document.querySelector(".edits-count") as HTMLElement;
  expect(chip.textContent).toBe("1 change");
  // T2: the chip sits in the Pending Edits bar above the footer, not in the header strip.
  expect(chip.closest(".edits-bar")).not.toBeNull();
  expect(chip.closest(".table-header")).toBeNull();
  const edited = rulesFor("cell-edited").find((r) => /^\.grid td\.cell-edited$/.test(r.selector));
  expect(edited).toBeTruthy();
  const decl = edited!.body.replace(/\s+/g, " ").trim();
  expect(decl).toContain("background: var(--c-warning-subtle);");
  expect(decl).toContain("box-shadow: inset 2px 0 0 var(--c-warning-solid);");
  // A selected edited cell rings in the same colour as any selected cell.
  const ring = (sel: string) => rulesFor("cell-selected").find((r) => r.selector === sel)!.body;
  expect(ring(".grid td.cell-selected")).toContain("inset 0 0 0 2px var(--c-accent)");
  expect(ring(".grid td.cell-edited.cell-selected")).toContain("inset 0 0 0 2px var(--c-accent)");
  // The wash never paints over an edited cell.
  for (const r of rulesFor("prod-wash")) expect(r.selector).not.toMatch(/cell-edited/);
});

test("an expired pass asks again with the current SQL", async () => {
  let tries = 0;
  await open(orders(), { production: true }, {
    plan_edits: askPlan,
    confirm_edits: () => `p${tries + 1}`,
    apply_edits: () => {
      tries += 1;
      if (tries === 1) throw { kind: "needsConfirmation" };
      return saved();
    },
  });
  await editStatus(0);
  fireEvent.click(screen.getByRole("button", { name: "Save on Production" }));
  fireEvent.click(await screen.findByRole("button", { name: "Save on freight-prod" }));
  fireEvent.click(await screen.findByRole("button", { name: "Save on freight-prod" }));
  await waitFor(() => expect(callsTo("apply_edits")).toHaveLength(2));
  expect(callsTo("apply_edits")[1]).toMatchObject({ pass: "p2" });
});

test("a changed row keeps every edit, marks the row and says why", async () => {
  await open(orders(), {}, {
    plan_edits: okPlan,
    apply_edits: () => {
      throw { kind: "rowChanged", message: { statement: 0, key: [{ column: "id", value: num("1") }] } };
    },
  });
  await editStatus(0);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(
    "Row id 1 changed since you loaded it. Revert the row, then Reload to see the current values.",
  );
  expect(document.querySelector('tr[data-row="0"]')!.className).toContain("row-conflict");
  expect(td(0, 1).textContent).toBe("lost");
});

test("a long save error can be read in full", async () => {
  const long = "value too long for type character varying(16) in column status of table orders, row id 1, while saving";
  await open(orders(), {}, {
    plan_edits: okPlan,
    apply_edits: () => {
      throw { kind: "editFailed", message: { statement: 0, message: long } };
    },
  });
  await editStatus(0);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const alert = await screen.findByRole("alert");
  const full = `Save failed at statement 1: ${long}`;
  expect(alert.textContent).toBe(full);
  expect(alert.getAttribute("title")).toBe(full);
  // The full message sits on its own line under the toolbar, not squeezed into it.
  expect(alert.closest(".toolbar")).toBeNull();
  expect(alert.className).toContain("edits-error");
});

test("a server error keeps every edit and shows the message", async () => {
  await open(orders(), {}, {
    plan_edits: okPlan,
    apply_edits: () => {
      throw { kind: "editFailed", message: { statement: 0, message: "value too long" } };
    },
  });
  await editStatus(0);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Save failed at statement 1: value too long");
  expect(td(0, 1).textContent).toBe("lost");
});

test("preview shows the SQL save will run", async () => {
  await open(orders(), {}, { plan_edits: okPlan });
  await editStatus(0);
  fireEvent.click(screen.getByRole("button", { name: "Preview SQL" }));
  const pre = await screen.findByLabelText("SQL to save, read-only");
  await waitFor(() => expect(pre.textContent).toContain("UPDATE \"public\".\"orders\" SET \"status\" = 'lost'"));
});

// ---- Final review fixes ----

const FULL = "a long note cut short no more";
const fullCell = { t: "text", value: FULL, truncated: false, totalBytes: FULL.length };
const firstChange = (cmd: string) =>
  (callsTo(cmd)[0].edits as { updates: { changes: { old: Cell; new: unknown }[] }[] }).updates[0].changes[0];

test("a cut-short cell edited in the editor saves with its full old value", async () => {
  await open(orders(), {}, { plan_edits: okPlan, apply_edits: saved });
  fireEvent.doubleClick(td(1, 2));
  await waitFor(() => expect(editor()!.value).toBe(FULL));
  fireEvent.change(editor()!, { target: { value: "new note" } });
  fireEvent.keyDown(editor()!, { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(callsTo("apply_edits")).toHaveLength(1));
  expect(firstChange("plan_edits").old).toEqual(fullCell);
  expect(firstChange("apply_edits").old).toEqual(fullCell);
});

test("typing over a cut-short cell loads its full value first, so it can be saved", async () => {
  await open(orders(), {}, { plan_edits: okPlan, apply_edits: saved });
  fireEvent.mouseDown(td(1, 2));
  key("x");
  await waitFor(() => expect(editor()!.value).toBe("x"));
  fireEvent.keyDown(editor()!, { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(callsTo("apply_edits")).toHaveLength(1));
  expect(firstChange("apply_edits")).toEqual({ column: "note", old: fullCell, new: { t: "text", value: "x" } });
});

test("two quick ctrl+s save once", async () => {
  await open(orders(), {}, { plan_edits: okPlan, apply_edits: saved });
  await editStatus(0);
  key("s", { ctrlKey: true });
  key("s", { ctrlKey: true });
  await waitFor(() => expect(callsTo("apply_edits")).toHaveLength(1));
  await new Promise((r) => setTimeout(r, 30));
  expect(callsTo("apply_edits")).toHaveLength(1);
  expect(callsTo("plan_edits")).toHaveLength(1);
});

test("editing is locked while a save runs", async () => {
  let finish = () => {};
  await open(orders(), {}, {
    plan_edits: okPlan,
    apply_edits: () => new Promise((r) => (finish = () => r(saved()))),
  });
  await editStatus(0);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(callsTo("apply_edits")).toHaveLength(1));
  fireEvent.doubleClick(td(1, 1));
  expect(editor()).toBeNull();
  fireEvent.mouseDown(td(1, 1));
  key("x");
  expect(editor()).toBeNull();
  fireEvent.paste(grid(), { clipboardData: { getData: () => "pasted" } });
  expect(td(1, 1).textContent).toBe("shipped");
  expect((screen.getByRole("button", { name: "Add row" }) as HTMLButtonElement).disabled).toBe(true);
  finish();
  await waitFor(() => expect(screen.queryByRole("region", { name: "Pending Edits" })).toBeNull());
});

test("clicking another cell keeps the typed value and the grid keys work again", async () => {
  await open();
  fireEvent.doubleClick(td(0, 1));
  fireEvent.change(editor()!, { target: { value: "lost" } });
  await userEvent.click(td(1, 2));
  expect(editor()).toBeNull();
  expect(td(0, 1).textContent).toBe("lost");
  expect(td(1, 2).className).toContain("cell-selected");
  key("ArrowLeft");
  expect(td(1, 1).className).toContain("cell-selected");
});

test("ctrl+s inside the editor keeps the value, then saves", async () => {
  await open(orders(), {}, { plan_edits: okPlan, apply_edits: saved });
  fireEvent.doubleClick(td(0, 1));
  fireEvent.change(editor()!, { target: { value: "lost" } });
  fireEvent.keyDown(editor()!, { key: "s", ctrlKey: true });
  await waitFor(() => expect(callsTo("apply_edits")).toHaveLength(1));
  expect(firstChange("apply_edits").new).toEqual({ t: "text", value: "lost" });
});

// ---- 5b minors ----

const NO_KEY_TEXT = "This table has no primary key, so its rows can't be edited";

test("a save refused with noPrimaryKey shows the grid's own no-key text", async () => {
  await open(orders(), {}, {
    plan_edits: okPlan,
    apply_edits: () => {
      throw { kind: "noPrimaryKey" };
    },
  });
  await editStatus(0);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toBe(NO_KEY_TEXT);
});

test("the cell menu has Delete row: it marks a loaded row and removes a new one", async () => {
  await open();
  fireEvent.contextMenu(td(0, 1));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete row" }));
  expect(document.querySelector('tr[data-row="0"]')!.className).toContain("row-deleted");
  expect(document.querySelector('tr[data-row="0"] .row-number')!.textContent).toBe("-");
  fireEvent.contextMenu(td(0, 1));
  expect(screen.queryByRole("menuitem", { name: "Delete row" })).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "Revert row" }));
  expect(document.querySelector(".row-deleted")).toBeNull();
  key("n", { ctrlKey: true });
  fireEvent.contextMenu(td(2, 1));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete row" }));
  expect(document.querySelector(".row-added")).toBeNull();
});

test("Delete row on a table without a primary key says why and deletes nothing", async () => {
  await open(orders(false));
  fireEvent.contextMenu(td(0, 1));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete row" }));
  expect(document.querySelector(".row-deleted")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe(NO_KEY_TEXT);
});

test("a paste that lands on a deleted row is refused and changes nothing", async () => {
  await open();
  fireEvent.mouseDown(td(0, 1));
  key("Delete");
  fireEvent.mouseDown(td(0, 1));
  fireEvent.paste(grid(), { clipboardData: { getData: () => "a\nb" } });
  expect(screen.getByRole("status").textContent).toBe("Deleted rows can't be edited. Revert the row first.");
  expect(td(1, 1).textContent).toBe("shipped");
  expect(td(0, 1).className).not.toContain("cell-edited");
  expect(screen.queryByRole("region", { name: "Pending Edits" })?.textContent).toContain("1 change");
});

test("duplicate loads the full value of a cut-short cell and says binary values aren't copied", async () => {
  await open();
  fireEvent.contextMenu(td(1, 1));
  fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate row" }));
  await waitFor(() => expect(td(2, 2).textContent).toBe("a long note cut short no more"));
  expect(callsTo("fetch_full_value")[0]).toMatchObject({
    request: { table, column: "note", key: [{ column: "id", value: num("2") }] },
  });
  // The binary cell is not copied: it is unset, and only key columns show `default` (T3).
  expect(td(2, 3).textContent).toBe("");
  expect(screen.getByRole("status").textContent).toBe("Binary values aren't copied.");
});

function longPage(): Page {
  return {
    columns: orders().columns,
    rows: Array.from({ length: 150 }, (_, i) => [num(String(i + 1)), text(`s${i}`), text("n"), bytes]),
    hasMore: false,
  };
}

test("an open editor keeps its typed value when its row scrolls out of the rendered rows", async () => {
  routeInvoke({ fetch_page: () => longPage() });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("s0");
  fireEvent.doubleClick(td(0, 1));
  fireEvent.change(editor()!, { target: { value: "typed" } });
  grid().scrollTop = 40 * 120;
  fireEvent.scroll(grid());
  await waitFor(() => expect(document.querySelector('tr[data-row="0"]')).toBeNull());
  expect(screen.getByRole("region", { name: "Pending Edits" }).textContent).toContain("1 edited cell");
  grid().scrollTop = 0;
  fireEvent.scroll(grid());
  await waitFor(() => expect(td(0, 1).textContent).toBe("typed"));
  expect(editor()).toBeNull();
});

test("a full value that arrives after the page changed doesn't open the editor", async () => {
  let release = (_v: unknown) => {};
  await open(orders(), {}, { fetch_full_value: () => new Promise((r) => (release = r)) });
  fireEvent.doubleClick(td(1, 2));
  await waitFor(() => expect(callsTo("fetch_full_value")).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByText("11");
  release({ t: "text", value: "late value", truncated: false, totalBytes: 10 });
  await new Promise((r) => setTimeout(r, 30));
  expect(editor()).toBeNull();
});

test("a full value that arrives after a new row was added still opens on its own row", async () => {
  // T3: new rows go at the bottom, so adding one never moves the loaded rows.
  let release = (_v: unknown) => {};
  await open(orders(), {}, { fetch_full_value: () => new Promise((r) => (release = r)) });
  fireEvent.doubleClick(td(1, 2));
  await waitFor(() => expect(callsTo("fetch_full_value")).toHaveLength(1));
  key("n", { ctrlKey: true });
  release({ t: "text", value: "late value", truncated: false, totalBytes: 10 });
  await waitFor(() => expect(editor()?.value).toBe("late value"));
  expect(editor()!.closest('tr[data-row="1"]')).not.toBeNull();
});

test("a full value that arrives after a reload doesn't open the editor", async () => {
  let release = (_v: unknown) => {};
  await open(orders(), {}, { fetch_full_value: () => new Promise((r) => (release = r)) });
  fireEvent.doubleClick(td(1, 2));
  await waitFor(() => expect(callsTo("fetch_full_value")).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
  await waitFor(() => expect(document.querySelector(".progress-on")).toBeNull());
  release({ t: "text", value: "late value", truncated: false, totalBytes: 10 });
  await new Promise((r) => setTimeout(r, 30));
  expect(editor()).toBeNull();
});

/** The Table menu's Columns list: shows or hides one column (item 5). */
async function toggleColumn(name: string) {
  await userEvent.click(screen.getByRole("button", { name: "Table" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Columns" }));
  await userEvent.click(screen.getByRole("menuitemcheckbox", { name }));
}

test("a_hidden_column_keeps_edits_on_the_right_row_and_column", async () => {
  await open();
  await toggleColumn("id");
  expect(screen.queryByRole("columnheader", { name: /^id/ })).toBeNull();
  fireEvent.doubleClick(td(1, 0));
  fireEvent.change(editor()!, { target: { value: "gone" } });
  fireEvent.keyDown(editor()!, { key: "Enter" });
  await toggleColumn("id");
  expect(td(1, 1).textContent).toBe("gone");
  expect(td(0, 1).textContent).toBe("paid");
});

test("a_selection_in_a_hidden_column_is_dropped_and_nothing_acts_on_it", async () => {
  await open();
  fireEvent.mouseDown(td(0, 1));
  expect(document.querySelector(".cell-selected")).not.toBeNull();
  await toggleColumn("status");
  expect(document.querySelector(".cell-selected")).toBeNull();
  key("Enter");
  key("x");
  expect(editor()).toBeNull();
  expect(screen.queryByRole("region", { name: "Pending Edits" })).toBeNull();
});

test("reload fetches the page again and keeps the edits", async () => {
  await open();
  await editStatus(0);
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
  await waitFor(() => expect(document.querySelector(".progress-on")).toBeNull());
  expect(td(0, 1).textContent).toBe("lost");
  expect(screen.getByRole("region", { name: "Pending Edits" })).toBeTruthy();
});

test("status_shows_rows_ms_and_pending_edits", async () => {
  const slot = document.createElement("span");
  slot.id = "app-status-slot";
  document.body.appendChild(slot);
  try {
    await open();
    const texts = () => Array.from(slot.querySelectorAll(".query-status > span")).map((s) => s.textContent);
    await waitFor(() => expect(texts()[0]).toBe("2+ rows"));
    expect(texts()[1]).toMatch(/^\d+ms$/);
    expect(texts()).toHaveLength(2);
    fireEvent.doubleClick(td(0, 1));
    fireEvent.change(editor()!, { target: { value: "cancelled" } });
    fireEvent.keyDown(editor()!, { key: "Enter" });
    await waitFor(() => expect(texts()).toContain("1 Pending Edit"));
  } finally {
    slot.remove();
  }
});

test("the cell menu closes on a press outside it and on a scroll", async () => {
  await open();
  fireEvent.contextMenu(td(0, 1));
  expect(screen.getByRole("menu", { name: "Cell" })).toBeTruthy();
  fireEvent.mouseDown(document.body);
  await waitFor(() => expect(screen.queryByRole("menu", { name: "Cell" })).toBeNull());
  fireEvent.contextMenu(td(0, 1));
  expect(screen.getByRole("menu", { name: "Cell" })).toBeTruthy();
  fireEvent.scroll(grid());
  await waitFor(() => expect(screen.queryByRole("menu", { name: "Cell" })).toBeNull());
  expect(document.querySelector(".row-deleted")).toBeNull();
});

test("the cell menu opens from the keyboard and works with the arrow keys", async () => {
  await open();
  fireEvent.mouseDown(td(0, 1));
  key("ContextMenu");
  const menu = screen.getByRole("menu", { name: "Cell" });
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete row" }));
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Duplicate row" }));
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Set NULL" }));
  fireEvent.click(document.activeElement as HTMLElement);
  expect(screen.queryByRole("menu", { name: "Cell" })).toBeNull();
  expect(td(0, 1).textContent).toBe("NULL");
  expect(document.activeElement).toBe(grid());
});

test("status_drops_the_old_rows_and_time_after_a_failed_page", async () => {
  const slot = document.createElement("span");
  slot.id = "app-status-slot";
  document.body.appendChild(slot);
  try {
    await open(orders(), {}, {
      fetch_page: (a) => {
        if ((a.request as { page: number }).page === 1) throw { kind: "query", message: "server went away" };
        return orders();
      },
    });
    const texts = () => Array.from(slot.querySelectorAll(".query-status > span")).map((s) => s.textContent);
    await waitFor(() => expect(texts()[0]).toBe("2+ rows"));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
    await waitFor(() => expect(document.querySelector(".progress-on")).toBeNull());
    expect(texts()).toEqual([]);
  } finally {
    slot.remove();
  }
});

test("item_3_the_cell_being_edited_is_marked_so_only_the_editor_draws_a_ring", async () => {
  await open();
  fireEvent.doubleClick(td(0, 2));
  expect(editor()).not.toBeNull();
  expect(td(0, 2).className).toContain("cell-editing");
  fireEvent.keyDown(editor()!, { key: "Escape" });
  expect(td(0, 2).className).not.toContain("cell-editing");
});

test("item_12_a_successful_save_tells_the_owner_once", async () => {
  const onSaved = vi.fn();
  await open(orders(), { onSaved }, { plan_edits: okPlan, apply_edits: saved });
  expect(onSaved).not.toHaveBeenCalled();
  await editStatus(0);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
});

test("item_4_a_long_value_opens_in_the_larger_editor_and_ctrl_enter_keeps_it", async () => {
  const long = "Customer disputes the fuel surcharge on the Rotterdam leg, hold reminders";
  const page = orders();
  page.rows[1][1] = text(long);
  await open(page, {}, { fetch_page: () => page });
  fireEvent.doubleClick(td(1, 1));
  const panel = screen.getByRole("dialog", { name: "Edit status" });
  expect(panel.textContent).toContain(`${long.length} characters`);
  expect(panel.textContent).toContain("row 2, id 2");
  const box = within(panel).getByRole("textbox", { name: "Cell value" }) as HTMLTextAreaElement;
  // Enter adds a line; Ctrl+Enter keeps the value.
  fireEvent.change(box, { target: { value: "short now" } });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(screen.getByRole("dialog", { name: "Edit status" })).toBeTruthy();
  fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
  expect(screen.queryByRole("dialog", { name: "Edit status" })).toBeNull();
  expect(td(1, 1).textContent).toBe("short now");
});

test("item_4_shift_f2_opens_the_larger_editor_from_the_cell_or_the_grid", async () => {
  await open();
  fireEvent.doubleClick(td(0, 1));
  // The cell editor says its keys, Shift+F2 among them.
  expect(document.querySelector(".cell-editor-tip")?.textContent).toContain("opens larger");
  fireEvent.change(editor()!, { target: { value: "typed" } });
  fireEvent.keyDown(editor()!, { key: "F2", shiftKey: true });
  const panel = screen.getByRole("dialog", { name: "Edit status" });
  expect((within(panel).getByRole("textbox", { name: "Cell value" }) as HTMLTextAreaElement).value).toBe("typed");
  await userEvent.click(within(panel).getByRole("button", { name: /Set NULL/ }));
  expect(td(0, 1).textContent).toBe("NULL");
  fireEvent.mouseDown(td(1, 1));
  key("F2", { shiftKey: true });
  expect(screen.getByRole("dialog", { name: "Edit status" })).toBeTruthy();
  fireEvent.keyDown(editor()!, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Edit status" })).toBeNull();
});
