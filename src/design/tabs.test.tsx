import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, type MutableRefObject } from "react";
import { expect, test, vi } from "vitest";
import type { ConnectionConfig, SqlSchema, TableDesign, TableIndex } from "../api/types";
import type { GridControl } from "../components/DataGrid";
import { LangClient } from "../lang/client";
import { SchemaCache } from "../lang/sql/schemaCache";
import { callsTo, routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import ColumnPicker from "./ColumnPicker";
import { ORDERS } from "./fixtures";
import TableDesigner from "./TableDesigner";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const conn = (over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: "c1",
  name: "shop-staging",
  dialect: "mysql",
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

const ix = (name: string, columns: string[], over: Partial<TableIndex> = {}): TableIndex => ({
  name,
  columns,
  unique: false,
  primary: false,
  constraint: false,
  sql: null,
  method: "btree",
  predicate: null,
  expression: false,
  advanced: false,
  ...over,
});

const DESIGN: TableDesign = {
  ...ORDERS,
  indexes: [...ORDERS.indexes, ix("orders_open_idx", ["status"], { predicate: "status <> 'done'" })],
  foreignKeys: [
    {
      name: "orders_customer_fkey",
      columns: ["email"],
      target: { database: "shop", schema: null, name: "customers" },
      targetColumns: ["email"],
      onDelete: null,
      onUpdate: null,
      advanced: false,
    },
  ],
};

const SCHEMA: SqlSchema = {
  searchPath: [],
  tables: [
    { schema: null, name: "customers", kind: "table", columns: [{ name: "id", typeName: "int", pk: true }, { name: "email", typeName: "varchar", pk: false }] },
    { schema: null, name: "orders", kind: "table", columns: [{ name: "id", typeName: "int", pk: true }] },
    { schema: null, name: "people", kind: "table", columns: [{ name: "mail", typeName: "varchar", pk: false }] },
    { schema: null, name: "open_orders", kind: "view", columns: [] },
  ],
  fks: [],
};

function setup(design: TableDesign = DESIGN, over: Partial<ConnectionConfig> = {}) {
  routeInvoke({ table_design: () => design, sql_schema: () => SCHEMA, plan_design: () => new Promise(() => {}) });
  const client = new LangClient(() => fakeWorker());
  const controlRef = createRef<GridControl | null>() as MutableRefObject<GridControl | null>;
  const view = render(
    <TableDesigner
      connection={conn(over)}
      target={{ kind: "alter", path: design.path }}
      group={null}
      visible
      onDirtyChange={() => {}}
      controlRef={controlRef}
      onApplied={() => {}}
      lang={{ client, schemas: new SchemaCache(client) }}
    />,
  );
  return { controlRef, container: view.container };
}

const indexGrid = () => screen.getByRole("grid", { name: /^Indexes of/ });
const keyGrid = () => screen.getByRole("grid", { name: /^Foreign keys of/ });
const rowOf = (grid: HTMLElement, name: string) =>
  [...grid.querySelectorAll("tbody tr")].find((r) => r.querySelector('td[data-field="name"]')?.textContent?.includes(name)) as HTMLElement;
const cellOf = (grid: HTMLElement, name: string, field: string) => rowOf(grid, name).querySelector(`td[data-field="${field}"]`) as HTMLElement;

test("tabs_count_indexes_and_keys_and_add_follows_the_tab", async () => {
  setup();
  const indexes = await screen.findByRole("tab", { name: "Indexes 2" });
  expect(screen.getByRole("tab", { name: "Foreign keys 1" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add column" })).toBeTruthy();
  await userEvent.click(indexes);
  const add = screen.getByRole("button", { name: "Add index" }) as HTMLButtonElement;
  expect(add.disabled).toBe(false);
  await userEvent.click(add);
  expect(screen.getByRole("tab", { name: "Indexes 3" })).toBeTruthy();
  expect([...indexGrid().querySelectorAll("tbody tr")].pop()!.className).toContain("row-added");
  await userEvent.click(screen.getByRole("tab", { name: "Foreign keys 1" }));
  expect(screen.getByRole("button", { name: "Add foreign key" })).toBeTruthy();
});

test("the_primary_row_comes_first_and_changes_only_through_the_key_toggles", async () => {
  setup();
  await userEvent.click(await screen.findByRole("tab", { name: "Indexes 2" }));
  const rows = indexGrid().querySelectorAll("tbody tr");
  expect(rows[0].querySelector('td[data-field="name"]')?.textContent).toContain("PRIMARY");
  const heads = within(indexGrid())
    .getAllByRole("columnheader")
    .map((h) => h.textContent)
    .filter(Boolean);
  expect(heads).toEqual(["Name", "Columns", "Unique", "Method", "Where"]);
  const primary = rowOf(indexGrid(), "PRIMARY");
  expect((within(primary).getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  expect((within(primary).getByRole("combobox") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.mouseDown(cellOf(indexGrid(), "PRIMARY", "name"));
  expect((screen.getByRole("button", { name: "Remove index" }) as HTMLButtonElement).disabled).toBe(true);
  // Two Key toggles in Columns: one primary row of both, in column order.
  await userEvent.click(screen.getByRole("tab", { name: /^Columns/ }));
  const columns = screen.getByRole("grid", { name: /^Columns of/ });
  const keyOf = (name: string) =>
    within(
      [...columns.querySelectorAll("tbody tr")].find((r) => r.querySelector('td[data-field="name"]')?.textContent === name) as HTMLElement,
    ).getByRole("button", { name: "Primary key" });
  await userEvent.click(keyOf("total"));
  await userEvent.click(keyOf("email"));
  await userEvent.click(screen.getByRole("tab", { name: "Indexes 2" }));
  const chips = [...rowOf(indexGrid(), "PRIMARY").querySelectorAll(".column-picker-name")].map((c) => c.textContent);
  expect(chips).toEqual(["id", "email", "total"]);
});

test("a_partial_index_shows_its_where_and_takes_only_a_name", async () => {
  setup();
  await userEvent.click(await screen.findByRole("tab", { name: "Indexes 2" }));
  const where = cellOf(indexGrid(), "orders_open_idx", "where");
  expect(where.textContent).toBe("status <> 'done'");
  expect(where.querySelector(".design-code")).toBeTruthy();
  expect(cellOf(indexGrid(), "orders_open_idx", "method").textContent).toBe("btree");
  const partial = rowOf(indexGrid(), "orders_open_idx");
  expect((within(partial).getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  expect((within(partial).getByRole("combobox") as HTMLButtonElement).disabled).toBe(true);
  expect(within(partial).queryAllByRole("button", { name: /^Remove .* from/ }).every((b) => (b as HTMLButtonElement).disabled)).toBe(
    true,
  );
  expect(partial.textContent).toContain("Only rename or remove");
  fireEvent.doubleClick(cellOf(indexGrid(), "orders_open_idx", "name"));
  const box = screen.getByRole("textbox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "orders_pending_idx" } });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(cellOf(indexGrid(), "orders_pending_idx", "name").className).toContain("cell-edited");
});

test("an_advanced_index_is_read_only_with_its_note", async () => {
  setup({
    ...DESIGN,
    indexes: [...ORDERS.indexes, ix("orders_desc_idx", ["total"], { advanced: true })],
    unsupported: ["index orders_desc_idx (descending order)"],
  });
  await userEvent.click(await screen.findByRole("tab", { name: "Indexes 2" }));
  const row = rowOf(indexGrid(), "orders_desc_idx");
  expect(row.textContent).toContain("Only rename or remove: descending order");
  expect((within(row).getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
});

test("on_delete_is_a_themed_select_and_no_native_select_is_drawn", async () => {
  const { container } = setup();
  await userEvent.click(await screen.findByRole("tab", { name: "Foreign keys 1" }));
  const heads = within(keyGrid())
    .getAllByRole("columnheader")
    .map((h) => h.textContent)
    .filter(Boolean);
  expect(heads).toEqual(["Name", "Columns", "References", "On delete", "On update"]);
  expect(cellOf(keyGrid(), "orders_customer_fkey", "references").textContent).toBe("customers (email)");
  const onDelete = screen.getByRole("combobox", { name: "On delete for orders_customer_fkey" });
  expect(onDelete.textContent).toBe("NO ACTION");
  await userEvent.click(onDelete);
  const options = within(screen.getByRole("listbox", { name: "On delete for orders_customer_fkey" }))
    .getAllByRole("option")
    .map((o) => o.textContent);
  expect(options).toEqual(["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"]);
  await userEvent.click(screen.getByRole("option", { name: "CASCADE" }));
  expect(cellOf(keyGrid(), "orders_customer_fkey", "onDelete").className).toContain("cell-edited");
  expect(container.querySelector("select")).toBeNull();
  expect(document.querySelector("select")).toBeNull();
});

test("the_target_table_list_comes_from_the_schema_cache", async () => {
  setup();
  await userEvent.click(await screen.findByRole("tab", { name: "Foreign keys 1" }));
  await waitFor(() => expect(callsTo("sql_schema")).toEqual([{ id: "c1", database: "shop" }]));
  await userEvent.click(screen.getByRole("button", { name: "Add foreign key" }));
  const table = await screen.findByRole("combobox", { name: /^Referenced table/ });
  await userEvent.click(table);
  const listed = within(screen.getByRole("listbox", { name: /^Referenced table/ }))
    .getAllByRole("option")
    .map((o) => o.textContent);
  expect(listed).toEqual(["Pick a table", "customers", "orders", "people"]);
  await userEvent.click(screen.getByRole("option", { name: "customers" }));
  // The target's columns come from the same list.
  await userEvent.click(screen.getByRole("combobox", { name: /^Add a column to Referenced columns/ }));
  const targetCols = within(screen.getByRole("listbox", { name: /^Add a column to Referenced columns/ }))
    .getAllByRole("option")
    .map((o) => o.textContent);
  expect(targetCols).toEqual(["Pick a column", "id", "email"]);
});

test("column_picker_adds_in_order_and_removes_a_chip", async () => {
  const onChange = vi.fn();
  const { rerender } = render(<ColumnPicker label="Columns" value={["email"]} options={["id", "email", "total"]} onChange={onChange} />);
  expect(screen.getByRole("button", { name: "Remove email from Columns" })).toBeTruthy();
  await userEvent.click(screen.getByRole("combobox", { name: "Add a column to Columns" }));
  const offered = within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent);
  expect(offered).toEqual(["Pick a column", "id", "total"]);
  await userEvent.click(screen.getByRole("option", { name: "total" }));
  expect(onChange).toHaveBeenLastCalledWith(["email", "total"]);
  await userEvent.click(screen.getByRole("button", { name: "Remove email from Columns" }));
  expect(onChange).toHaveBeenLastCalledWith([]);
  rerender(<ColumnPicker label="Columns" value={["email"]} options={["email"]} onChange={onChange} disabled />);
  expect((screen.getByRole("combobox") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Remove email from Columns" }) as HTMLButtonElement).disabled).toBe(true);
});

test("a_new_index_without_columns_blocks_apply_with_its_name", async () => {
  setup();
  await userEvent.click(await screen.findByRole("tab", { name: "Indexes 2" }));
  await userEvent.click(screen.getByRole("button", { name: "Add index" }));
  expect(await screen.findByText("Index orders_idx has no columns. Pick one, or remove it.")).toBeTruthy();
});

test("no_native_select_on_the_columns_or_indexes_tab", async () => {
  setup();
  await screen.findByRole("tab", { name: "Indexes 2" });
  expect(document.querySelector("select")).toBeNull();
  await userEvent.click(screen.getByRole("tab", { name: "Indexes 2" }));
  await userEvent.click(screen.getByRole("button", { name: "Add index" }));
  expect(document.querySelector("select")).toBeNull();
});

test("the_row_grid_keys_add_pick_rename_and_remove", async () => {
  setup();
  await userEvent.click(await screen.findByRole("tab", { name: "Indexes 2" }));
  const keys = indexGrid().closest(".design-scroll") as HTMLElement;
  // Ctrl+N adds on the active tab.
  expect(fireEvent.keyDown(keys, { key: "n", ctrlKey: true })).toBe(false);
  expect(screen.getByRole("tab", { name: "Indexes 3" })).toBeTruthy();
  const added = () => [...indexGrid().querySelectorAll("tbody tr")].pop() as HTMLElement;
  expect(added().getAttribute("aria-selected")).toBe("true");
  // Arrows pick a row.
  fireEvent.keyDown(keys, { key: "ArrowUp" });
  expect(rowOf(indexGrid(), "orders_open_idx").getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(keys, { key: "ArrowDown" });
  // F2 opens the name; Esc closes it unchanged.
  fireEvent.keyDown(keys, { key: "F2" });
  let box = screen.getByRole("textbox", { name: "Cell value" }) as HTMLInputElement;
  expect(box.value).toBe("orders_idx");
  fireEvent.keyDown(box, { key: "Escape" });
  // Typing starts a new name with that character, typed by the browser into the focused editor (item 47).
  expect(fireEvent.keyDown(keys, { key: "x" })).toBe(true);
  box = screen.getByRole("textbox", { name: "Cell value" }) as HTMLInputElement;
  expect(document.activeElement).toBe(box);
  expect(box.value).toBe("");
  fireEvent.change(box, { target: { value: "x" } });
  expect(box.value).toBe("x");
  fireEvent.keyDown(box, { key: "Enter" });
  expect(added().querySelector('td[data-field="name"]')?.textContent).toBe("x");
  // Delete removes the picked index.
  fireEvent.keyDown(keys, { key: "Delete" });
  expect(screen.getByRole("tab", { name: "Indexes 2" })).toBeTruthy();
});

test("removing_a_column_names_each_plain_index_it_drops", async () => {
  setup({ ...DESIGN, indexes: [...ORDERS.indexes, ix("orders_email_status_idx", ["email", "status"])] });
  await screen.findByRole("tab", { name: "Indexes 2" });
  const columns = screen.getByRole("grid", { name: /^Columns of/ });
  const email = [...columns.querySelectorAll("tbody tr")].find(
    (r) => r.querySelector('td[data-field="name"]')?.textContent === "email",
  ) as HTMLElement;
  fireEvent.mouseDown(email.querySelector('td[data-field="type"]')!);
  await userEvent.click(screen.getByRole("button", { name: "Remove column" }));
  expect(screen.getByText("Removing email also drops index orders_email_status_idx.")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Indexes 1" })).toBeTruthy();
  // The key on email went whole too; the Core's warning names it in the preview.
  expect(screen.getByRole("tab", { name: "Foreign keys 0" })).toBeTruthy();
});

test("a_postgresql_key_with_no_target_schema_matches_the_cached_public_table", async () => {
  const path = { database: "shop", schema: "public", name: "orders" };
  routeInvoke({
    table_design: () => ({ ...DESIGN, path }),
    sql_schema: () => ({ ...SCHEMA, tables: SCHEMA.tables.map((t) => ({ ...t, schema: "public" })) }),
    plan_design: () => new Promise(() => {}),
  });
  const client = new LangClient(() => fakeWorker());
  render(
    <TableDesigner
      connection={conn({ dialect: "postgres", port: 5432 })}
      target={{ kind: "alter", path }}
      group={null}
      visible
      onDirtyChange={() => {}}
      controlRef={createRef<GridControl | null>() as MutableRefObject<GridControl | null>}
      onApplied={() => {}}
      lang={{ client, schemas: new SchemaCache(client) }}
    />,
  );
  await userEvent.click(await screen.findByRole("tab", { name: "Foreign keys 1" }));
  await waitFor(() => expect(callsTo("sql_schema")).toHaveLength(1));
  fireEvent.mouseDown(cellOf(keyGrid(), "orders_customer_fkey", "name"));
  const table = await screen.findByRole("combobox", { name: "Referenced table for orders_customer_fkey" });
  await waitFor(() => expect(table.textContent).toBe("customers"));
  await userEvent.click(table);
  const listed = within(screen.getByRole("listbox", { name: /^Referenced table/ }))
    .getAllByRole("option")
    .map((o) => o.textContent);
  expect(listed).toEqual(["customers", "orders", "people"]);
  await userEvent.keyboard("{Escape}");
  // The target's columns come from the cached table, not only the loaded names.
  await userEvent.click(screen.getByRole("combobox", { name: /^Add a column to Referenced columns/ }));
  const targetCols = within(screen.getByRole("listbox", { name: /^Add a column to Referenced columns/ }))
    .getAllByRole("option")
    .map((o) => o.textContent);
  expect(targetCols).toEqual(["Pick a column", "id"]);
});

test("a_failed_table_list_says_how_to_retry_once", async () => {
  setup();
  const tab = await screen.findByRole("tab", { name: "Foreign keys 1" });
  routeInvoke({
    table_design: () => DESIGN,
    plan_design: () => new Promise(() => {}),
    sql_schema: () => {
      throw { kind: "query", message: "gone" };
    },
  });
  await userEvent.click(tab);
  expect(await screen.findByText("The table list did not load. Open this tab once more to retry.")).toBeTruthy();
});
