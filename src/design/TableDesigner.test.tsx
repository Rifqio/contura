import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, type MutableRefObject } from "react";
import { expect, test, vi } from "vitest";
import type { ConnectionConfig, DialectKind, TableDesign } from "../api/types";
import type { GridControl } from "../components/DataGrid";
import { LangClient } from "../lang/client";
import { SchemaCache } from "../lang/sql/schemaCache";
import type { DesignTabTarget } from "../shell/tabs";
import { callsTo, routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { ORDERS } from "./fixtures";
import { type TabAskEntry, useTabAsk } from "../assistant/tabAsk";
import TableDesigner, { unsupportedNote } from "./TableDesigner";
import { typeSuggestions } from "./typeSuggestions";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const conn = (dialect: DialectKind, over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
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
  ...over,
});
const alter: DesignTabTarget = { kind: "alter", path: ORDERS.path };

function setup(dialect: DialectKind = "mysql", design: TableDesign = ORDERS, target: DesignTabTarget = alter) {
  routeInvoke({ table_design: () => design });
  const client = new LangClient(() => fakeWorker());
  const onDirtyChange = vi.fn();
  const controlRef = createRef<GridControl | null>() as MutableRefObject<GridControl | null>;
  render(
    <TableDesigner
      connection={conn(dialect)}
      target={target}
      group={null}
      visible
      onDirtyChange={onDirtyChange}
      controlRef={controlRef}
      onApplied={() => {}}
      lang={{ client, schemas: new SchemaCache(client) }}
    />,
  );
  return { onDirtyChange, controlRef };
}

const grid = () => screen.getByRole("grid", { name: /^Columns of/ });
/** The row whose Name cell reads `name`. */
const row = (name: string) =>
  [...grid().querySelectorAll("tbody tr")].find((r) => r.querySelector('td[data-field="name"]')?.textContent === name) as HTMLElement;
const cell = (name: string, field: string) => row(name).querySelector(`td[data-field="${field}"]`) as HTMLElement;
/** The grid's focusable scroll box, which takes the cell keys. */
const scroller = () => grid().closest(".design-scroll") as HTMLElement;
const lastRow = () => [...grid().querySelectorAll("tbody tr")].pop() as HTMLElement;

test("tabs_show_counts_and_columns_in_d16_order", async () => {
  setup("mysql");
  expect(await screen.findByRole("tab", { name: "Columns 5" })).toBeTruthy();
  const inner = screen.getByRole("tablist", { name: "Design" });
  expect(within(inner).getByRole("tab", { name: "Indexes 1" })).toBeTruthy();
  expect(within(inner).getByRole("tab", { name: "Foreign keys 0" })).toBeTruthy();
  expect(callsTo("table_design")).toEqual([{ id: "c1", path: ORDERS.path }]);
  const heads = within(grid())
    .getAllByRole("columnheader")
    .map((h) => h.textContent)
    .filter(Boolean);
  expect(heads).toEqual(["Name", "Type", "Nullable", "Default", "Auto-increment", "Key", "Comment"]);
});

test("comment_column_is_absent_on_sqlite", async () => {
  setup("sqlite", { ...ORDERS, path: { database: "main", schema: null, name: "orders" } });
  await screen.findByRole("tab", { name: "Columns 5" });
  const heads = within(grid())
    .getAllByRole("columnheader")
    .map((h) => h.textContent)
    .filter(Boolean);
  expect(heads).toEqual(["Name", "Type", "Nullable", "Default", "Auto-increment", "Key"]);
});

test("editing_a_type_marks_the_cell_and_offers_suggestions", async () => {
  const { onDirtyChange, controlRef } = setup("mysql");
  await screen.findByRole("tab", { name: "Columns 5" });
  fireEvent.doubleClick(cell("total", "type"));
  const box = screen.getByRole("combobox", { name: "Cell value" }) as HTMLInputElement;
  const list = document.getElementById(box.getAttribute("list") ?? "");
  expect(list?.tagName).toBe("DATALIST");
  expect([...list!.querySelectorAll("option")].map((o) => o.value)).toContain("varchar(255)");
  fireEvent.change(box, { target: { value: "decimal(12,2)" } });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(cell("total", "type").className).toContain("cell-edited");
  expect(cell("total", "type").textContent).toBe("decimal(12,2)");
  expect(cell("total", "name").className).not.toContain("cell-edited");
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  expect(controlRef.current?.pendingCount()).toBe(1);
});

test("escape_cancels_an_edit", async () => {
  setup("mysql");
  await screen.findByRole("tab", { name: "Columns 5" });
  fireEvent.doubleClick(cell("email", "name"));
  const box = screen.getByRole("textbox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "mail" } });
  fireEvent.keyDown(box, { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: "Cell value" })).toBeNull();
  expect(cell("email", "name").className).not.toContain("cell-edited");
  expect(row("mail")).toBeUndefined();
});

test("add_column_adds_a_row_at_the_end_and_remove_takes_it_away", async () => {
  setup("mysql");
  await screen.findByRole("tab", { name: "Columns 5" });
  await userEvent.click(screen.getByRole("button", { name: "Add column" }));
  expect(lastRow().className).toContain("row-added");
  expect(screen.getByRole("tab", { name: "Columns 6" })).toBeTruthy();
  // The new row is selected, so Remove takes it out of the list.
  await userEvent.click(screen.getByRole("button", { name: "Remove column" }));
  expect(grid().querySelectorAll("tbody tr")).toHaveLength(5);
  expect(grid().querySelector(".row-added")).toBeNull();
});

test("remove_on_a_loaded_column_strikes_it_through", async () => {
  setup("mysql");
  await screen.findByRole("tab", { name: "Columns 5" });
  await userEvent.click(cell("email", "type"));
  await userEvent.click(screen.getByRole("button", { name: "Remove column" }));
  expect(row("email").className).toContain("row-deleted");
  expect(grid().querySelectorAll("tbody tr")).toHaveLength(5);
});

test("move_buttons_are_disabled_on_postgresql_with_the_reason", async () => {
  setup("postgres", { ...ORDERS, path: { database: "shop", schema: "public", name: "orders" } }, {
    kind: "alter",
    path: { database: "shop", schema: "public", name: "orders" },
  });
  await screen.findByRole("tab", { name: "Columns 5" });
  for (const name of ["Move up", "Move down"]) {
    const b = screen.getByRole("button", { name }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.title).toBe("PostgreSQL cannot reorder columns");
  }
});

test("move_buttons_work_on_mysql", async () => {
  setup("mysql");
  await screen.findByRole("tab", { name: "Columns 5" });
  await userEvent.click(cell("status", "name"));
  const up = screen.getByRole("button", { name: "Move up" }) as HTMLButtonElement;
  expect(up.disabled).toBe(false);
  await userEvent.click(up);
  const order = [...grid().querySelectorAll('tbody td[data-field="name"]')].map((c) => c.textContent);
  expect(order).toEqual(["id", "status", "email", "total", "created_at"]);
  expect((screen.getByRole("button", { name: "Move down" }) as HTMLButtonElement).disabled).toBe(false);
});

test("key_column_draws_the_primary_key_and_foreign_key_icons", async () => {
  setup("mysql", {
    ...ORDERS,
    foreignKeys: [
      {
        name: "orders_ibfk_1",
        columns: ["email"],
        target: { database: "shop", schema: null, name: "customers" },
        targetColumns: ["email"],
        onDelete: null,
        onUpdate: null,
        advanced: false,
      },
    ],
  });
  await screen.findByRole("tab", { name: "Foreign keys 1" });
  expect(within(cell("id", "key")).getByRole("button", { name: "Primary key" }).getAttribute("aria-pressed")).toBe("true");
  expect(within(cell("email", "key")).getByRole("img", { name: "In a Foreign Key" })).toBeTruthy();
});

test("unsupported_parts_are_listed_in_a_note", async () => {
  setup("mysql", { ...ORDERS, unsupported: ["check c1", "check c2", "trigger t"] });
  expect(await screen.findByText("Not editable here: 2 checks, 1 trigger")).toBeTruthy();
});

test("the_unsupported_note_names_each_kind_with_real_plurals_and_leaves_out_advanced_rows", () => {
  expect(
    unsupportedNote([
      "generated column total_cents",
      "index orders_cover_idx (include columns)",
      "index orders_other_idx (include columns)",
      "foreign key fk_c (deferrable)",
      "column note (invisible)",
      "check constraint chk_total",
      "check c2",
    ]),
  ).toBe("Not editable here: 1 generated column, 2 checks");
  expect(unsupportedNote(["generated column a", "generated column b", "trigger t"])).toBe(
    "Not editable here: 2 generated columns, 1 trigger",
  );
  expect(unsupportedNote(["without rowid", "strict"])).toBe("Not editable here: WITHOUT ROWID, STRICT");
  // Only advanced rows: the grid says "Only rename or remove" on them, so there is no note.
  expect(unsupportedNote(["index ix (include columns)"])).toBeNull();
});

test("keys_add_remove_and_move_without_the_window_commands", async () => {
  setup("mysql");
  await screen.findByRole("tab", { name: "Columns 5" });
  await userEvent.click(cell("status", "name"));
  const keys = scroller();
  fireEvent.keyDown(keys, { key: "ArrowUp", altKey: true });
  expect([...grid().querySelectorAll('tbody td[data-field="name"]')].map((c) => c.textContent)[1]).toBe("status");
  // Outside the grid Ctrl+N stays the window's New Connection. D3: in the grid it adds a column, as in the data grid.
  expect(fireEvent.keyDown(screen.getByRole("tab", { name: /^Columns/ }), { key: "n", ctrlKey: true })).toBe(true);
  expect(grid().querySelector(".row-added")).toBeNull();
  expect(fireEvent.keyDown(keys, { key: "n", ctrlKey: true })).toBe(false);
  expect(lastRow().className).toContain("row-added");
  expect(grid().querySelectorAll(".row-added")).toHaveLength(1);
  fireEvent.keyDown(keys, { key: "Delete" });
  expect(grid().querySelector(".row-added")).toBeNull();
  // Delete on a struck-through row brings it back.
  fireEvent.mouseDown(cell("email", "type"));
  fireEvent.keyDown(keys, { key: "Delete" });
  expect(row("email").className).toContain("row-deleted");
  fireEvent.keyDown(keys, { key: "Delete" });
  expect(row("email").className).not.toContain("row-deleted");
});

test("space_on_a_toolbar_button_presses_it_and_leaves_the_grid_alone", async () => {
  setup("mysql");
  await screen.findByRole("tab", { name: "Columns 5" });
  await userEvent.click(cell("total", "name"));
  // Walk to total's Key cell with the grid's own keys.
  for (let i = 0; i < 5; i++) fireEvent.keyDown(scroller(), { key: "ArrowRight" });
  expect(cell("total", "key").className).toContain("cell-selected");
  screen.getByRole("button", { name: "Add column" }).focus();
  await userEvent.keyboard(" ");
  expect(lastRow().className).toContain("row-added");
  expect(within(cell("total", "key")).getByRole("button", { name: "Primary key" }).getAttribute("aria-pressed")).toBe("false");
  // Arrow keys on the inner tabs do not move the grid's selection (the new row's Name).
  const selectedNow = () => grid().querySelector("td.cell-selected");
  const before = selectedNow();
  expect(before).toBe(lastRow().querySelector('td[data-field="name"]'));
  fireEvent.keyDown(screen.getByRole("tab", { name: /^Columns/ }), { key: "ArrowUp" });
  expect(selectedNow()).toBe(before);
});

test("tab_reaches_the_grid_and_typing_starts_an_edit", async () => {
  setup("mysql");
  await screen.findByRole("tab", { name: "Columns 5" });
  let steps = 0;
  while (document.activeElement !== scroller() && steps++ < 12) await userEvent.tab();
  expect(document.activeElement).toBe(scroller());
  await userEvent.keyboard("{ArrowDown}");
  expect(cell("id", "name").className).toContain("cell-selected");
  await userEvent.keyboard("x");
  expect((screen.getByRole("textbox", { name: "Cell value" }) as HTMLTextAreaElement).value).toBe("x");
});

test("item_47_the_key_that_opens_a_designer_cell_is_typed_by_the_browser", async () => {
  setup("mysql");
  await screen.findByRole("tab", { name: "Columns 5" });
  fireEvent.mouseDown(cell("id", "name"));
  scroller().focus();
  const prevented: string[] = [];
  const watch = (e: KeyboardEvent) => {
    if (e.defaultPrevented) prevented.push(e.key);
  };
  document.addEventListener("keydown", watch);
  try {
    // The grid leaves the opening key to the browser, which types it into the focused editor.
    expect(fireEvent.keyDown(scroller(), { key: ":", shiftKey: true })).toBe(true);
    const box = screen.getByRole("textbox", { name: "Cell value" }) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(box);
    expect(box.value).toBe("");
    fireEvent.keyDown(box, { key: "Escape" });
    // Typed for real, `::s` stays `::s`, with no key cancelled on the way.
    scroller().focus();
    await userEvent.keyboard("::s");
    expect((screen.getByRole("textbox", { name: "Cell value" }) as HTMLTextAreaElement).value).toBe("::s");
    expect(prevented).toEqual([]);
  } finally {
    document.removeEventListener("keydown", watch);
  }
});

test("discard_returns_to_the_loaded_design", async () => {
  const { controlRef, onDirtyChange } = setup("mysql");
  await screen.findByRole("tab", { name: "Columns 5" });
  await userEvent.click(screen.getByRole("button", { name: "Add column" }));
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  expect(controlRef.current?.flush()).toBe(true);
  controlRef.current?.discard();
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  expect(grid().querySelector(".row-added")).toBeNull();
});

// ---- What the designer tells the Ask (spec 4.4) ----

test("the published draft follows edits and carries the Dialect's types", async () => {
  routeInvoke({ table_design: () => ORDERS });
  const client = new LangClient(() => fakeWorker());
  let entry: TabAskEntry | null = null;
  function Reader() {
    entry = useTabAsk("design:orders");
    return null;
  }
  render(
    <>
      <TableDesigner
        askKey="design:orders"
        connection={conn("mysql")}
        target={alter}
        group={null}
        visible
        onDirtyChange={() => {}}
        controlRef={createRef<GridControl | null>() as MutableRefObject<GridControl | null>}
        onApplied={() => {}}
        lang={{ client, schemas: new SchemaCache(client) }}
      />
      <Reader />
    </>,
  );
  await screen.findByRole("tab", { name: "Columns 5" });
  const design = () => {
    const t = entry?.get()?.tab;
    if (t?.kind !== "design") throw new Error("no design tab published");
    return t;
  };
  await waitFor(() => expect(design().columns.map((c) => c.name)).toEqual(["id", "email", "status", "total", "created_at"]));
  expect(design()).toMatchObject({ create: false, path: ORDERS.path, primary: ["id"], removed: [] });
  expect(design().types).toEqual(typeSuggestions("mysql"));

  // Add a column and name it.
  await userEvent.click(screen.getByRole("button", { name: "Add column" }));
  fireEvent.doubleClick(lastRow().querySelector('td[data-field="name"]') as HTMLElement);
  const box = screen.getByRole("textbox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "note" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(design().columns.map((c) => c.name)).toContain("note"));

  // Rename a column.
  fireEvent.doubleClick(cell("email", "name"));
  const rename = screen.getByRole("textbox", { name: "Cell value" });
  fireEvent.change(rename, { target: { value: "mail" } });
  fireEvent.keyDown(rename, { key: "Enter" });
  await waitFor(() => expect(design().columns.map((c) => c.name)).toEqual(["id", "mail", "status", "total", "created_at", "note"]));

  // The primary key takes another column.
  await userEvent.click(within(cell("total", "key")).getByRole("button", { name: "Primary key" }));
  await waitFor(() => expect(design().primary).toEqual(["id", "total"]));
});

// UX step 2 minor 6: while a cell is being typed in, Ctrl+N is not the window's New Connection either.
test("ctrl_n_while_a_cell_is_edited_is_kept_from_new_connection_and_adds_no_row", async () => {
  setup("mysql");
  await screen.findByRole("tab", { name: "Columns 5" });
  fireEvent.doubleClick(cell("email", "name"));
  const box = screen.getByRole("textbox", { name: "Cell value" });
  // keyDown returns false when the key was prevented, which keeps the window's command from running.
  expect(fireEvent.keyDown(box, { key: "n", ctrlKey: true })).toBe(false);
  // Also when the key reaches the grid itself with the cell still open.
  expect(fireEvent.keyDown(scroller(), { key: "n", ctrlKey: true })).toBe(false);
  expect(grid().querySelector(".row-added")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Cell value" })).toBeTruthy();
});
