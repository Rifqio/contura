// UX step 10: undo and redo over the draft (D1), typing in the empty last row (D2) and the column row menu (D4).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, type MutableRefObject } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { ConnectionConfig, DialectKind, TableDesign } from "../api/types";
import type { GridControl } from "../components/DataGrid";
import { LangClient } from "../lang/client";
import { SchemaCache } from "../lang/sql/schemaCache";
import type { DesignTabTarget } from "../shell/tabs";
import { routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { ORDERS } from "./fixtures";
import { clearCopiedColumn } from "./columnClipboard";
import TableDesigner from "./TableDesigner";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// The copied column outlives a designer tab on purpose; each test starts with nothing copied.
afterEach(() => clearCopiedColumn());

const conn = (dialect: DialectKind): ConnectionConfig => ({
  id: "c1",
  name: "shop-staging",
  dialect,
  host: "h",
  port: 3306,
  user: "u",
  database: "shop",
  ssl: { mode: "disable" },
  file: null,
  groupId: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
});

function setup(dialect: DialectKind = "mysql", design: TableDesign = ORDERS, visible = true) {
  routeInvoke({ table_design: () => design });
  const client = new LangClient(() => fakeWorker());
  const onDirtyChange = vi.fn();
  const controlRef = createRef<GridControl | null>() as MutableRefObject<GridControl | null>;
  const target: DesignTabTarget = { kind: "alter", path: design.path };
  const view = render(
    <>
    <div id="app-status-slot" />
    <TableDesigner
      connection={conn(dialect)}
      target={target}
      group={null}
      visible={visible}
      onDirtyChange={onDirtyChange}
      controlRef={controlRef}
      onApplied={() => {}}
      lang={{ client, schemas: new SchemaCache(client) }}
    />
    </>,
  );
  return { onDirtyChange, controlRef, unmount: view.unmount };
}

const grid = () => screen.getByRole("grid", { name: /^Columns of/ });
const bodyRows = () => [...grid().querySelectorAll("tbody tr")] as HTMLElement[];
const names = () => bodyRows().map((r) => r.querySelector('td[data-field="name"]')!.textContent);
const row = (name: string) => bodyRows().find((r) => r.querySelector('td[data-field="name"]')?.textContent === name)!;
const cell = (name: string, field: string) => row(name).querySelector(`td[data-field="${field}"]`) as HTMLElement;
/** The focusable scroll box of the grid on show, which takes the grid keys. */
const scroller = () => document.querySelector(".design-scroll") as HTMLElement;
/** The empty row the grid always shows under the columns (D2). */
const emptyRow = () => grid().querySelector("tfoot tr") as HTMLElement;
const emptyCell = (field: string) => emptyRow().querySelector(`td[data-field="${field}"]`) as HTMLElement;
const key = (k: string, over: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(scroller(), { key: k, ...over });
const undoKey = () => key("z", { ctrlKey: true });
const redoKey = () => key("y", { ctrlKey: true });
const undoButton = () => screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement;
const redoButton = () => screen.getByRole("button", { name: "Redo" }) as HTMLButtonElement;

function editCell(target: HTMLElement, value: string) {
  fireEvent.doubleClick(target);
  const box = screen.getByRole(target.dataset.field === "type" ? "combobox" : "textbox", { name: "Cell value" });
  fireEvent.change(box, { target: { value } });
  fireEvent.keyDown(box, { key: "Enter" });
}

async function ready() {
  await screen.findByRole("tab", { name: "Columns 5" });
}

// D1

test("ctrl_z_undoes_a_rename_and_ctrl_y_and_ctrl_shift_z_redo_it", async () => {
  const { controlRef } = setup();
  await ready();
  editCell(cell("email", "name"), "mail");
  expect(names()).toContain("mail");
  undoKey();
  expect(names()).toContain("email");
  expect(names()).not.toContain("mail");
  expect(controlRef.current?.pendingCount()).toBe(0);
  redoKey();
  expect(names()).toContain("mail");
  undoKey();
  key("Z", { ctrlKey: true, shiftKey: true });
  expect(names()).toContain("mail");
});

test("every_column_change_kind_is_one_undo_step", async () => {
  const { controlRef, onDirtyChange } = setup();
  await ready();
  const snap = () => JSON.stringify({ names: names(), rows: bodyRows().map((r) => [r.className, r.textContent]), checks: [...grid().querySelectorAll("input")].map((i) => (i as HTMLInputElement).checked), keys: [...grid().querySelectorAll('[aria-label="Primary key"]')].map((b) => b.getAttribute("aria-pressed")) });
  const states = [snap()];
  editCell(cell("email", "type"), "varchar(120)"); // type
  states.push(snap());
  fireEvent.click(within(cell("email", "nullable")).getByRole("checkbox")); // null
  states.push(snap());
  editCell(cell("total", "default"), "0"); // default
  states.push(snap());
  fireEvent.click(within(cell("email", "key")).getByRole("button", { name: "Primary key" })); // key
  states.push(snap());
  fireEvent.mouseDown(cell("status", "name"));
  key("ArrowUp", { altKey: true }); // reorder
  states.push(snap());
  key("n", { ctrlKey: true }); // add
  states.push(snap());
  fireEvent.mouseDown(cell("total", "name"));
  key("Delete"); // remove: strike-through
  states.push(snap());
  expect(row("total").className).toContain("row-deleted");
  key("Delete"); // the strike-through's own restore is a step too
  states.push(snap());
  // Each change looks different from the one before it (the restore brings back the state before the remove).
  states.slice(1).forEach((s, i) => expect(s).not.toBe(states[i]));
  for (let i = states.length - 2; i >= 0; i--) {
    undoKey();
    expect(snap()).toBe(states[i]);
  }
  expect(controlRef.current?.pendingCount()).toBe(0);
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  for (let i = 1; i < states.length; i++) {
    redoKey();
    expect(snap()).toBe(states[i]);
  }
});

test("index_and_foreign_key_changes_undo_on_their_tabs", async () => {
  setup();
  await ready();
  fireEvent.click(screen.getByRole("tab", { name: "Indexes 1" }));
  const indexGrid = () => screen.getByRole("grid", { name: /^Indexes of/ });
  const before = indexGrid().querySelectorAll("tbody tr").length;
  fireEvent.click(screen.getByRole("button", { name: "Add index" }));
  expect(indexGrid().querySelectorAll("tbody tr")).toHaveLength(before + 1);
  undoKey();
  expect(indexGrid().querySelectorAll("tbody tr")).toHaveLength(before);
  redoKey();
  expect(indexGrid().querySelectorAll("tbody tr")).toHaveLength(before + 1);
  fireEvent.click(screen.getByRole("tab", { name: "Foreign keys 0" }));
  fireEvent.click(screen.getByRole("button", { name: "Add foreign key" }));
  expect(screen.getByRole("tab", { name: "Foreign keys 1" })).toBeTruthy();
  undoKey();
  expect(screen.getByRole("tab", { name: "Foreign keys 0" })).toBeTruthy();
});

test("the_toolbar_undo_and_redo_buttons_follow_the_history", async () => {
  setup();
  await ready();
  expect(undoButton().disabled).toBe(true);
  expect(redoButton().disabled).toBe(true);
  expect(undoButton().title).toBe("Undo (Ctrl+Z)");
  expect(redoButton().title).toBe("Redo (Ctrl+Y)");
  editCell(cell("email", "name"), "mail");
  expect(undoButton().disabled).toBe(false);
  fireEvent.click(undoButton());
  expect(names()).toContain("email");
  expect(undoButton().disabled).toBe(true);
  expect(redoButton().disabled).toBe(false);
  fireEvent.click(redoButton());
  expect(names()).toContain("mail");
});

test("an_open_cell_keeps_ctrl_z_for_its_own_text", async () => {
  setup();
  await ready();
  editCell(cell("email", "name"), "mail");
  fireEvent.doubleClick(cell("total", "name"));
  const box = screen.getByRole("textbox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "sum" } });
  const ev = fireEvent.keyDown(box, { key: "z", ctrlKey: true });
  // Not prevented: the browser's field undo takes it, and the draft is as it was.
  expect(ev).toBe(true);
  expect(screen.getByRole("textbox", { name: "Cell value" })).toBeTruthy();
  expect(names()).toContain("mail");
});

test("discard_clears_the_history", async () => {
  const { controlRef } = setup();
  await ready();
  editCell(cell("email", "name"), "mail");
  fireEvent.click(screen.getByRole("button", { name: /^Discard/ }));
  await waitFor(() => expect(names()).toContain("email"));
  expect(undoButton().disabled).toBe(true);
  undoKey();
  expect(names()).toContain("email");
  expect(controlRef.current?.pendingCount()).toBe(0);
});

test("a_cell_commit_that_changes_nothing_is_no_step", async () => {
  setup();
  await ready();
  editCell(cell("email", "name"), "email");
  expect(undoButton().disabled).toBe(true);
});

// D2

test("the_grid_shows_one_empty_row_and_typing_a_name_there_adds_a_column", async () => {
  const { controlRef } = setup();
  await ready();
  expect(emptyRow()).toBeTruthy();
  expect(bodyRows()).toHaveLength(5);
  // An untouched empty row is no change.
  expect(controlRef.current?.pendingCount()).toBe(0);
  editCell(emptyCell("name"), "note");
  expect(names()).toEqual(["id", "email", "status", "total", "created_at", "note"]);
  expect(row("note").className).toContain("row-added");
  expect(screen.getByRole("tab", { name: "Columns 6" })).toBeTruthy();
  // A new empty row is there again, and Enter moved to it.
  expect(emptyRow()).toBeTruthy();
  expect(emptyCell("name").className).toContain("cell-selected");
  expect(controlRef.current?.pendingCount()).toBe(1);
  // One step.
  undoKey();
  expect(bodyRows()).toHaveLength(5);
});

test("an_empty_commit_in_the_empty_row_adds_nothing", async () => {
  setup();
  await ready();
  editCell(emptyCell("name"), "   ");
  expect(bodyRows()).toHaveLength(5);
  expect(undoButton().disabled).toBe(true);
});

test("enter_on_the_last_real_row_moves_to_the_empty_row", async () => {
  setup();
  await ready();
  editCell(cell("created_at", "name"), "created");
  expect(emptyCell("name").className).toContain("cell-selected");
  // Down from the empty row stays on it.
  key("ArrowDown");
  expect(emptyCell("name").className).toContain("cell-selected");
  key("ArrowUp");
  expect(cell("created", "name").className).toContain("cell-selected");
});

test("typing_on_the_selected_empty_row_opens_its_editor", async () => {
  setup();
  await ready();
  fireEvent.mouseDown(emptyCell("name"));
  key("n");
  expect(screen.getByRole("textbox", { name: "Cell value" })).toBeTruthy();
});

test("an_added_blank_row_is_the_empty_row_so_there_are_never_two", async () => {
  setup();
  await ready();
  key("n", { ctrlKey: true });
  expect(bodyRows()).toHaveLength(6);
  expect(emptyRow()).toBeNull();
});

// D4

test("right_click_on_a_column_row_opens_its_menu_with_keys", async () => {
  setup();
  await ready();
  fireEvent.contextMenu(cell("status", "type"), { clientX: 40, clientY: 50 });
  const menu = screen.getByRole("menu", { name: "Column" });
  const items = within(menu).getAllByRole("menuitem");
  expect(items.map((i) => [i.getAttribute("aria-label"), i.querySelector(".menu-shortcut")?.textContent ?? null])).toEqual([
    ["Move up", "Alt+Up"],
    ["Move down", "Alt+Down"],
    ["Copy", "Ctrl+C"],
    ["Paste", "Ctrl+V"],
    ["Duplicate", "Ctrl+D"],
    ["Delete", "Delete"],
  ]);
  expect(cell("status", "type").className).toContain("cell-selected");
  // Nothing copied yet.
  expect((within(menu).getByRole("menuitem", { name: "Paste" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Move up" }));
  expect(names()).toEqual(["id", "status", "email", "total", "created_at"]);
  expect(screen.queryByRole("menu", { name: "Column" })).toBeNull();
  undoKey();
  expect(names()).toEqual(["id", "email", "status", "total", "created_at"]);
});

test("duplicate_adds_a_copy_below_with_a_free_name_as_one_step", async () => {
  setup();
  await ready();
  fireEvent.contextMenu(cell("status", "name"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
  expect(names()).toEqual(["id", "email", "status", "status_2", "total", "created_at"]);
  expect(cell("status_2", "type").textContent).toBe("varchar(16)");
  expect(cell("status_2", "default").textContent).toBe("'new'");
  undoKey();
  expect(names()).toEqual(["id", "email", "status", "total", "created_at"]);
});

test("copy_then_paste_puts_the_column_below_the_picked_row", async () => {
  setup();
  await ready();
  fireEvent.contextMenu(cell("email", "name"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
  fireEvent.contextMenu(cell("total", "name"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Paste" }));
  expect(names()).toEqual(["id", "email", "status", "total", "email_2", "created_at"]);
  expect(cell("email_2", "type").textContent).toBe("varchar(80)");
});

test("ctrl_c_ctrl_v_and_ctrl_d_work_on_the_grid", async () => {
  setup();
  await ready();
  fireEvent.mouseDown(cell("id", "name"));
  key("d", { ctrlKey: true });
  expect(names()).toEqual(["id", "id_2", "email", "status", "total", "created_at"]);
  // Fix round 1, I1: auto-increment needs a key, and keys are not copied, so the copy leaves it off and says so.
  expect((within(cell("id_2", "increment")).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  expect(document.getElementById("app-status-slot")!.textContent).toContain("auto-increment not copied");
  fireEvent.mouseDown(cell("total", "name"));
  key("c", { ctrlKey: true });
  fireEvent.mouseDown(cell("created_at", "name"));
  key("v", { ctrlKey: true });
  expect(names()).toEqual(["id", "id_2", "email", "status", "total", "created_at", "total_2"]);
});

test("delete_in_the_menu_strikes_the_row_through_and_undo_brings_it_back", async () => {
  setup();
  await ready();
  fireEvent.contextMenu(cell("email", "name"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
  expect(row("email").className).toContain("row-deleted");
  undoKey();
  expect(row("email").className).not.toContain("row-deleted");
});

test("shift_f10_and_the_menu_key_open_the_menu_and_escape_closes_it", async () => {
  setup();
  await ready();
  fireEvent.mouseDown(cell("email", "name"));
  key("F10", { shiftKey: true });
  const menu = screen.getByRole("menu", { name: "Column" });
  expect(document.activeElement).toBe(within(menu).getAllByRole("menuitem")[0]);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("menu", { name: "Column" })).toBeNull();
  key("ContextMenu");
  expect(screen.getByRole("menu", { name: "Column" })).toBeTruthy();
});

test("the_empty_row_menu_only_pastes_at_the_end", async () => {
  setup();
  await ready();
  fireEvent.contextMenu(cell("email", "name"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
  fireEvent.contextMenu(emptyCell("name"));
  const menu = screen.getByRole("menu", { name: "Column" });
  const enabled = within(menu)
    .getAllByRole("menuitem")
    .filter((i) => !(i as HTMLButtonElement).disabled)
    .map((i) => i.getAttribute("aria-label"));
  expect(enabled).toEqual(["Paste"]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Paste" }));
  expect(names()).toEqual(["id", "email", "status", "total", "created_at", "email_2"]);
});

test("on_postgresql_paste_goes_at_the_end_and_move_is_off", async () => {
  setup("postgres", { ...ORDERS, path: { database: "shop", schema: "public", name: "orders" } });
  await ready();
  fireEvent.contextMenu(cell("email", "name"));
  const menu = screen.getByRole("menu", { name: "Column" });
  expect((within(menu).getByRole("menuitem", { name: "Move up" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Duplicate" }));
  expect(names()).toEqual(["id", "email", "status", "total", "created_at", "email_2"]);
});

// Fix round 1

test("a_paste_of_a_plain_column_says_nothing_about_auto_increment", async () => {
  setup();
  await ready();
  fireEvent.mouseDown(cell("email", "name"));
  key("d", { ctrlKey: true });
  expect(document.getElementById("app-status-slot")!.textContent).not.toContain("auto-increment");
});

test("undo_that_hides_the_empty_row_moves_the_selection_to_a_real_row_and_typing_still_edits", async () => {
  setup();
  await ready();
  fireEvent.mouseDown(cell("created_at", "name"));
  key("n", { ctrlKey: true }); // a blank column: the empty row hides
  key("Delete"); // gone again: the empty row shows
  fireEvent.mouseDown(emptyCell("name"));
  undoKey(); // the blank column is back, so the empty row hides
  expect(emptyRow()).toBeNull();
  const selected = grid().querySelector("td.cell-selected") as HTMLElement;
  expect(selected).toBeTruthy();
  expect(selected.closest("tbody")).toBeTruthy();
  // A typed character opens an editor that is on screen, and the keys keep working after it.
  key("a");
  const box = screen.getByRole("textbox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "a" } });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(names()).toContain("a");
  key("ArrowUp");
  expect(cell("a", "name").className).toContain("cell-selected");
});

test("redo_that_hides_the_empty_row_moves_the_selection_too", async () => {
  setup();
  await ready();
  key("n", { ctrlKey: true });
  undoKey();
  fireEvent.mouseDown(emptyCell("type"));
  redoKey();
  expect(emptyRow()).toBeNull();
  expect((grid().querySelector("td.cell-selected") as HTMLElement).closest("tbody")).toBeTruthy();
});

test("a_right_click_in_an_open_cell_keeps_the_fields_own_menu", async () => {
  setup();
  await ready();
  fireEvent.doubleClick(cell("email", "name"));
  const box = screen.getByRole("textbox", { name: "Cell value" });
  expect(fireEvent.contextMenu(box)).toBe(true);
  expect(screen.queryByRole("menu", { name: "Column" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "Cell value" })).toBe(box);
});

test("keyboard_undo_keeps_working_after_the_toolbar_button_disables", async () => {
  setup();
  await ready();
  editCell(cell("email", "name"), "mail");
  undoButton().focus();
  fireEvent.click(undoButton());
  expect(undoButton().disabled).toBe(true);
  // Focus stays in the designer, so the next key still reaches it.
  const at = document.activeElement as HTMLElement;
  // A disabled button loses focus in the WebView, so focus goes back to the grid, not left on the button.
  expect(at).toBe(scroller());
  fireEvent.keyDown(at, { key: "y", ctrlKey: true });
  expect(names()).toContain("mail");
  redoButton().focus();
  fireEvent.click(undoButton());
  fireEvent.click(redoButton());
  expect(document.activeElement).toBe(scroller());
});

test("the_undo_and_copy_keys_work_on_other_keyboard_layouts", async () => {
  setup();
  await ready();
  editCell(cell("email", "name"), "mail");
  // A Russian layout: the Z key types "я", and Ctrl+Z must still undo, as in the data grid.
  key("я", { ctrlKey: true, code: "KeyZ" });
  expect(names()).toContain("email");
  key("н", { ctrlKey: true, code: "KeyY" });
  expect(names()).toContain("mail");
  fireEvent.mouseDown(cell("total", "name"));
  key("с", { ctrlKey: true, code: "KeyC" });
  key("м", { ctrlKey: true, code: "KeyV" });
  expect(names()).toContain("total_2");
  key("в", { ctrlKey: true, code: "KeyD" });
  expect(names()).toContain("total_3");
});

test("ctrl_shift_y_is_not_redo", async () => {
  setup();
  await ready();
  editCell(cell("email", "name"), "mail");
  undoKey();
  key("Y", { ctrlKey: true, shiftKey: true });
  expect(names()).toContain("email");
});

test("a_column_copied_from_another_dialect_does_not_paste", async () => {
  const first = setup("mysql");
  await ready();
  fireEvent.contextMenu(cell("email", "name"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
  first.unmount();
  setup("postgres", { ...ORDERS, path: { database: "shop", schema: "public", name: "orders" } });
  await ready();
  fireEvent.contextMenu(cell("total", "name"));
  expect((screen.getByRole("menuitem", { name: "Paste" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  fireEvent.mouseDown(cell("total", "name"));
  key("v", { ctrlKey: true });
  expect(names()).toEqual(["id", "email", "status", "total", "created_at"]);
});

test("index_rename_and_column_pick_each_undo_one_step", async () => {
  setup();
  await ready();
  fireEvent.click(screen.getByRole("tab", { name: "Indexes 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Add index" }));
  const indexGrid = () => screen.getByRole("grid", { name: /^Indexes of/ });
  const added = () => [...indexGrid().querySelectorAll("tbody tr")].pop() as HTMLElement;
  // Pick a column for the new index.
  await userEvent.click(within(added()).getByRole("combobox", { name: /^Add a column to Columns of/ }));
  await userEvent.click(screen.getByRole("option", { name: "email" }));
  expect(within(added()).getByRole("button", { name: /^Remove email from/ })).toBeTruthy();
  // Rename it.
  fireEvent.doubleClick(added().querySelector('td[data-field="name"]') as HTMLElement);
  const box = screen.getByRole("textbox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "by_email" } });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(added().querySelector('td[data-field="name"]')?.textContent).toContain("by_email");
  undoKey();
  expect(added().querySelector('td[data-field="name"]')?.textContent).not.toContain("by_email");
  expect(within(added()).getByRole("button", { name: /^Remove email from/ })).toBeTruthy();
  undoKey();
  expect(within(added()).queryByRole("button", { name: /^Remove email from/ })).toBeNull();
});

test("foreign_key_column_pick_undoes", async () => {
  setup();
  await ready();
  fireEvent.click(screen.getByRole("tab", { name: "Foreign keys 0" }));
  fireEvent.click(screen.getByRole("button", { name: "Add foreign key" }));
  const keyGrid = screen.getByRole("grid", { name: /^Foreign keys of/ });
  const rowEl = keyGrid.querySelector("tbody tr") as HTMLElement;
  await userEvent.click(within(rowEl).getByRole("combobox", { name: /^Add a column to Columns of/ }));
  await userEvent.click(screen.getByRole("option", { name: "email" }));
  expect(within(rowEl).getByRole("button", { name: /^Remove email from/ })).toBeTruthy();
  undoKey();
  expect(within(rowEl).queryByRole("button", { name: /^Remove email from/ })).toBeNull();
});

test("shift_f10_with_nothing_selected_opens_the_menu_on_the_first_row", async () => {
  setup();
  await ready();
  key("F10", { shiftKey: true });
  expect(screen.getByRole("menu", { name: "Column" })).toBeTruthy();
  expect(cell("id", "name").className).toContain("cell-selected");
});

test("undo_shows_the_tab_whose_part_it_changed", async () => {
  setup();
  await ready();
  editCell(cell("email", "name"), "mail");
  fireEvent.click(screen.getByRole("tab", { name: "Indexes 1" }));
  undoKey();
  expect(screen.getByRole("tab", { name: "Columns 5" }).getAttribute("aria-selected")).toBe("true");
  expect(names()).toContain("email");
});

test("a_designer_tab_not_on_show_takes_no_undo", async () => {
  setup("mysql", ORDERS, false);
  await ready();
  editCell(cell("email", "name"), "mail");
  undoKey();
  expect(names()).toContain("mail");
});

test("discard_clears_the_auto_increment_note", async () => {
  setup();
  await ready();
  fireEvent.mouseDown(cell("id", "name"));
  key("d", { ctrlKey: true });
  expect(document.getElementById("app-status-slot")!.textContent).toContain("auto-increment not copied");
  fireEvent.click(screen.getByRole("button", { name: /^Discard/ }));
  await waitFor(() => expect(names()).not.toContain("id_2"));
  expect(document.getElementById("app-status-slot")!.textContent).not.toContain("auto-increment not copied");
});

test("undo_that_opens_another_tab_puts_focus_in_its_grid", async () => {
  setup();
  await ready();
  editCell(cell("email", "name"), "mail");
  fireEvent.click(screen.getByRole("tab", { name: "Indexes 1" }));
  undoKey();
  await waitFor(() => expect(document.activeElement).toBe(document.querySelector(".design-scroll")));
  expect(screen.getByRole("tabpanel").getAttribute("aria-label")).toMatch(/^Columns/);
});
