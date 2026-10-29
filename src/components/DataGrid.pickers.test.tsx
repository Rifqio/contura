// Typed cell editors in the table grid: a calendar for dates, an enum's values from the column's type (MySQL) or
// the schema index (PostgreSQL), NULL only when the column takes it, and typing that keeps working as before.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { Cell, DialectKind, Page, SqlSchema, TableColumn } from "../api/types";
import { LangClient } from "../lang/client";
import { SchemaCache } from "../lang/sql/schemaCache";
import { routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import DataGrid from "./DataGrid";
import { ToastProvider } from "./Toast";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const table = { database: "shop", schema: "public", name: "orders" };
const num = (value: string): Cell => ({ t: "number", value });
const text = (value: string): Cell => ({ t: "text", value, truncated: false, totalBytes: value.length });
const td = (row: number, col: number) => document.querySelector(`tr[data-row="${row}"] td[data-col="${col}"]`) as HTMLElement;
const editor = () => screen.queryByRole("textbox", { name: "Cell value" }) as HTMLTextAreaElement | null;

function page(statusType: string, placedType: string): Page {
  return {
    columns: [
      { name: "id", typeName: "bigint", isPrimaryKey: true },
      { name: "status", typeName: statusType, isPrimaryKey: false },
      { name: "placed", typeName: placedType, isPrimaryKey: false },
      { name: "note", typeName: "text", isPrimaryKey: false },
    ],
    rows: [[num("1"), text("paid"), text("2026-03-05"), text("hi")]],
    hasMore: false,
  };
}

const designCol = (name: string, nullable: boolean): TableColumn => ({
  name,
  typeSql: "",
  nullable,
  defaultSql: null,
  increment: { kind: "none" },
  comment: null,
  generated: false,
  mysql: null,
  sqliteAutoincrement: false,
  collation: null,
  advanced: false,
  identityAlways: false,
});

const PG_SCHEMA: SqlSchema = {
  searchPath: ["public"],
  tables: [
    {
      schema: "public",
      name: "orders",
      kind: "table",
      columns: [
        { name: "id", typeName: "int8", pk: true },
        { name: "status", typeName: "order_status", pk: false, enumValues: ["paid", "shipped", "void"] },
        { name: "placed", typeName: "date", pk: false },
        { name: "note", typeName: "text", pk: false },
      ],
    },
  ],
  fks: [],
};

async function open(dialect: DialectKind, p: Page, nullable = true) {
  routeInvoke({
    fetch_page: () => p,
    sql_schema: () => PG_SCHEMA,
    table_design: () => ({ columns: [designCol("id", false), designCol("status", nullable), designCol("placed", true), designCol("note", true)] }),
  });
  const client = new LangClient(() => fakeWorker());
  const lang = { client, schemas: new SchemaCache(client) };
  render(
    <ToastProvider>
      <DataGrid connectionId="c1" table={table} onClose={() => {}} dialect={dialect} lang={lang} />
    </ToastProvider>,
  );
  await screen.findByText("paid");
  await waitFor(() => expect(lang.schemas.state("c1", "shop")).toBe("loaded"));
}

test("mysql: an enum column lists the values of its full type, with NULL once the design says it is nullable", async () => {
  await open("mysql", page("enum('paid','shipped','it''s void')", "date"));
  fireEvent.doubleClick(td(0, 1));
  const list = screen.getByRole("listbox", { name: "Values of status" });
  await waitFor(() => expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["NULL", "paid", "shipped", "it's void"]));
  fireEvent.click(within(list).getByRole("option", { name: "it's void" }));
  expect(editor()).toBeNull();
  expect(td(0, 1).textContent).toBe("it's void");
  expect(td(0, 1).className).toContain("cell-edited");
});

test("a column that is not nullable has no NULL row; NULL on a nullable one sets the cell to NULL", async () => {
  await open("mysql", page("enum('paid','shipped')", "date"), false);
  fireEvent.doubleClick(td(0, 1));
  await waitFor(() => expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["paid", "shipped"]));
});

test("NULL from the enum list sets the cell to NULL", async () => {
  await open("mysql", page("enum('paid','shipped')", "date"));
  fireEvent.doubleClick(td(0, 1));
  fireEvent.click(await screen.findByRole("option", { name: "NULL" }));
  expect(editor()).toBeNull();
  expect(td(0, 1).getAttribute("title")).toBe("Was paid. Edited, not saved yet.");
  expect(td(0, 1).textContent).toBe("NULL");
});

test("postgres: an enum column's labels come from the schema index", async () => {
  await open("postgres", page("order_status", "date"));
  fireEvent.doubleClick(td(0, 1));
  await waitFor(() =>
    expect(within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent)).toEqual(["NULL", "paid", "shipped", "void"]),
  );
  fireEvent.keyDown(editor()!, { key: "ArrowDown", altKey: true });
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "End" });
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
  expect(td(0, 1).textContent).toBe("void");
});

test("a date column gets the calendar; typing a full value still commits it unchanged", async () => {
  await open("postgres", page("order_status", "date"));
  fireEvent.doubleClick(td(0, 2));
  expect(screen.getByRole("dialog", { name: "Pick a date for placed" })).toBeTruthy();
  expect(screen.getByRole("grid", { name: "March 2026" })).toBeTruthy();
  fireEvent.change(editor()!, { target: { value: "2026-04-01" } });
  fireEvent.keyDown(editor()!, { key: "Enter" });
  expect(td(0, 2).textContent).toBe("2026-04-01");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("keys typed in the calendar do not reach the grid", async () => {
  await open("postgres", page("order_status", "date"));
  fireEvent.doubleClick(td(0, 2));
  fireEvent.keyDown(editor()!, { key: "ArrowDown", altKey: true });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  expect(td(0, 2).textContent).toBe("2026-03-06");
});

test("plain text columns, and the larger editor, have no picker", async () => {
  await open("postgres", page("order_status", "date"));
  fireEvent.doubleClick(td(0, 3));
  expect(editor()).not.toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.keyDown(editor()!, { key: "Escape" });
  fireEvent.doubleClick(td(0, 2));
  fireEvent.keyDown(editor()!, { key: "F2", shiftKey: true });
  expect(screen.queryByRole("dialog", { name: /Pick/ })).toBeNull();
});
