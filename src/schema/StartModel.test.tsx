import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import type { ConnectionConfig } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import StartModel from "./StartModel";
import type { ModelDoc } from "./SchemaBuilder";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const kfc: ConnectionConfig = {
  id: "c1",
  name: "kfc",
  dialect: "mysql",
  host: "127.0.0.1",
  port: 3306,
  user: "dbview_test",
  database: null,
  ssl: { mode: "disable" },
  groupId: null,
  file: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
};
const prod: ConnectionConfig = { ...kfc, id: "c2", name: "ledger", dialect: "postgres", production: true, readOnly: true };

function setup(openIds: string[] = [], connections: ConnectionConfig[] = [kfc], onCancel: () => void = () => {}) {
  const onStart = vi.fn<(d: ModelDoc) => void>();
  render(<StartModel connections={connections} openIds={new Set(openIds)} onStart={onStart} onCancel={onCancel} />);
  return onStart;
}

const noRecent = () => routeInvoke({ recent_items: () => [] });

async function chooseConnection(name: RegExp | string = /kfc/) {
  await userEvent.click(screen.getByRole("combobox", { name: "Connection" }));
  await userEvent.click(screen.getByRole("option", { name }));
}

test("J2: a chosen Connection ignores a click outside; an untouched dialog closes", async () => {
  routeInvoke({ recent_items: () => [], list_databases: () => DATABASES, list_objects: () => [] });
  const onCancel = vi.fn();
  setup(["c1"], [kfc], onCancel);
  const scrim = () => screen.getByRole("dialog").parentElement as HTMLElement;
  fireEvent.mouseDown(scrim());
  expect(onCancel).toHaveBeenCalledTimes(1);
  onCancel.mockClear();
  await chooseConnection();
  fireEvent.mouseDown(scrim());
  expect(onCancel).not.toHaveBeenCalled();
});

test("three_radio_cards_with_from_a_connection_first", async () => {
  noRecent();
  setup();
  const group = screen.getByRole("radiogroup", { name: "Start from" });
  const cards = within(group).getAllByRole("radio");
  expect(cards.map((c) => c.textContent)).toEqual([
    "From a ConnectionRead the tables of a database",
    "Blank modelStart empty in one Dialect",
    "Open a .dbml filePick up a saved model",
  ]);
  expect(cards[0].getAttribute("aria-checked")).toBe("true");
  cards[0].focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(cards[1].getAttribute("aria-checked")).toBe("true");
  expect(document.activeElement).toBe(cards[1]);
  await userEvent.keyboard("{ArrowRight}");
  expect(cards[2].getAttribute("aria-checked")).toBe("true");
  await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
  expect(cards[0].getAttribute("aria-checked")).toBe("true");
});

test("only_the_chosen_cards_fields_show", async () => {
  noRecent();
  setup(["c1"]);
  expect(screen.getByRole("combobox", { name: "Connection" })).toBeTruthy();
  expect(screen.queryByRole("radiogroup", { name: "Dialect" })).toBeNull();
  await userEvent.click(screen.getByRole("radio", { name: /Blank model/ }));
  expect(screen.getByRole("radiogroup", { name: "Dialect" })).toBeTruthy();
  expect(screen.getByLabelText("Name")).toHaveProperty("value", "untitled.dbml");
  expect(screen.queryByRole("combobox", { name: "Connection" })).toBeNull();
  await userEvent.click(screen.getByRole("radio", { name: /Open a .dbml file/ }));
  expect(screen.getByText("Drop a .dbml file here")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Browse..." })).toBeTruthy();
  expect(screen.queryByLabelText("Name")).toBeNull();
});

test("footer_primary_names_the_action_and_enter_runs_it", async () => {
  noRecent();
  const onStart = setup();
  const primary = () => screen.getByRole("button", { name: /^(Read the database|Create blank model|Open\.\.\.)/ });
  expect(primary().textContent).toBe("Read the databaseEnter");
  expect(screen.getByText("Only reads the database. Nothing is changed.")).toBeTruthy();
  await userEvent.click(screen.getByRole("radio", { name: /Blank model/ }));
  expect(primary().textContent).toBe("Create blank modelEnter");
  expect(screen.getByText("You can change the Dialect later in the model.")).toBeTruthy();
  await userEvent.click(screen.getByRole("radio", { name: /PostgreSQL/ }));
  screen.getByRole("radio", { name: /Blank model/ }).focus();
  await userEvent.keyboard("{Enter}");
  expect(onStart.mock.calls[0][0]).toMatchObject({ dialect: "postgres", source: "blank" });
  await userEvent.click(screen.getByRole("radio", { name: /Open a .dbml file/ }));
  expect(primary().textContent).toBe("Open...Enter");
  expect(screen.getByText("Opens the file. It is saved back to the same place.")).toBeTruthy();
});

test("escape_cancels", async () => {
  noRecent();
  const onCancel = vi.fn();
  setup([], [kfc], onCancel);
  await userEvent.keyboard("{Escape}");
  expect(onCancel).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: /^Cancel/ }));
  expect(onCancel).toHaveBeenCalledTimes(2);
});

test("connection_picker_shows_marks_prod_and_read_only", async () => {
  noRecent();
  setup(["c2"], [kfc, prod]);
  await userEvent.click(screen.getByRole("combobox", { name: "Connection" }));
  const list = screen.getByRole("listbox", { name: "Connection" });
  const ledger = within(list).getByRole("option", { name: /ledger/ });
  expect(within(ledger).getByRole("img", { name: "PostgreSQL, open" })).toBeTruthy();
  expect(ledger.textContent).toContain("PROD");
  expect(ledger.textContent).toContain("Read-only");
  const shop = within(list).getByRole("option", { name: /kfc/ });
  expect(within(shop).getByRole("img", { name: "MySQL, closed" })).toBeTruthy();
  expect(shop.getAttribute("aria-disabled")).toBe("true");
  expect(list.querySelector(".status-dot, .odot")).toBeNull();
});

const DATABASES = ["information_schema", "mysql", "performance_schema", "shop", "sys", "pg_catalog"];

test("database_picker_hides_system_databases_until_switched", async () => {
  routeInvoke({ recent_items: () => [], list_databases: () => DATABASES, list_objects: () => [] });
  setup(["c1"]);
  await chooseConnection();
  await userEvent.click(await screen.findByRole("combobox", { name: "Database" }));
  const names = () => screen.getAllByRole("option").map((o) => o.textContent);
  expect(names()).toEqual(["shop"]);
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("switch", { name: "Show system databases" }));
  await userEvent.click(screen.getByRole("combobox", { name: "Database" }));
  expect(names()).toEqual(DATABASES);
});

test("chosen_database_shows_its_table_count", async () => {
  const tables = Array.from({ length: 12 }, (_, i) => ({ kind: "table", name: `t${i}`, rows: null }));
  routeInvoke({
    recent_items: () => [],
    list_databases: () => ["shop"],
    list_objects: () => [...tables, { kind: "view", name: "v", rows: null }],
  });
  setup(["c1"]);
  await chooseConnection();
  expect(await screen.findByText("12 tables")).toBeTruthy();
  expect(callsTo("list_objects")).toEqual([{ id: "c1", database: "shop", schema: null }]);
});

afterEach(() => vi.useRealTimers());

test("file_card_lists_recent_models", async () => {
  // Midday on a fixed day, so "2h" never turns into a clock time after midnight.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 15, 14, 0));
  const now = Date.now();
  routeInvoke({
    recent_items: () => [
      { target: { kind: "schemaModel", file: "C:\\m\\shop.dbml" }, connectionId: null, openedAtMs: now - 2 * 3_600_000 },
      { target: { kind: "query", savedId: "q", name: "only-a-query" }, connectionId: null, openedAtMs: now },
    ],
    read_model_files: () => ({ dbml: "// Dialect: MySQL\nTable a {\n  id int\n}\n", layout: null }),
  });
  const onStart = setup();
  await userEvent.click(screen.getByRole("radio", { name: /Open a .dbml file/ }));
  expect(screen.getByText("Recent models")).toBeTruthy();
  const item = await screen.findByRole("button", { name: /shop\.dbml/ });
  expect(item.textContent).toContain("2h");
  expect(screen.queryByText("only-a-query")).toBeNull();
  await userEvent.click(item);
  await waitFor(() => expect(onStart).toHaveBeenCalled());
  expect(onStart.mock.calls[0][0]).toMatchObject({ path: "C:\\m\\shop.dbml", dialect: "mysql", source: "file" });
});

test("blank_model_starts_with_template", async () => {
  noRecent();
  const onStart = setup();
  await userEvent.click(screen.getByRole("radio", { name: /Blank model/ }));
  await userEvent.click(screen.getByRole("radio", { name: /PostgreSQL/ }));
  await userEvent.click(screen.getByRole("button", { name: /^Create blank model/ }));
  const doc = onStart.mock.calls[0][0];
  expect(doc).toMatchObject({ path: null, dialect: "postgres", source: "blank" });
  expect(doc.dbml).toContain("// Dialect: PostgreSQL");
  expect(doc.dbml).toContain("Table new_table {");
  expect(doc.savedDbml).toBe("");
});

async function pickFile(path: string) {
  const dialog = await import("@tauri-apps/plugin-dialog");
  vi.mocked(dialog.open).mockResolvedValue(path);
  await userEvent.click(screen.getByRole("radio", { name: /Open a .dbml file/ }));
  await userEvent.click(screen.getByRole("button", { name: /^Open\.\.\./ }));
}

test("open_file_reads_dbml_and_layout", async () => {
  const dbml = "// Dialect: MySQL\nTable a {\n  id int\n}\n";
  routeInvoke({
    recent_items: () => [],
    read_model_files: () => ({ dbml, layout: '{"version":1,"tables":{".a":{"x":5,"y":6}}}' }),
  });
  const onStart = setup();
  await pickFile("C:\\m\\shop.dbml");
  await waitFor(() => expect(onStart).toHaveBeenCalled());
  expect(callsTo("read_model_files")).toEqual([{ path: "C:\\m\\shop.dbml" }]);
  const doc = onStart.mock.calls[0][0];
  expect(doc).toMatchObject({ path: "C:\\m\\shop.dbml", dialect: "mysql", source: "file", dbml, savedDbml: dbml });
  expect(doc.layout.tables[".a"]).toEqual({ x: 5, y: 6 });
});

test("open_file_without_dialect_asks", async () => {
  routeInvoke({ recent_items: () => [], read_model_files: () => ({ dbml: "Table a {\n  id int\n}\n", layout: null }) });
  const onStart = setup();
  await pickFile("C:\\m\\plain.dbml");
  expect(await screen.findByText("This file doesn't say which Dialect it targets. Choose one.")).toBeTruthy();
  await userEvent.click(within(screen.getByRole("radiogroup", { name: "Dialect of the file" })).getByRole("radio", { name: /SQLite/ }));
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(onStart.mock.calls[0][0]).toMatchObject({ dialect: "sqlite", path: "C:\\m\\plain.dbml" });
});

test("an ER diagram opened as DBML asks its Dialect and starts unsaved, under its name (ADR 0030)", async () => {
  noRecent();
  const onStart = vi.fn<(d: ModelDoc) => void>();
  const dbml = "Table a {\n  id int\n}\n";
  render(<StartModel connections={[kfc]} openIds={new Set()} file={{ path: null, name: "billing", dbml, layout: null }} onStart={onStart} onCancel={() => {}} />);
  expect(await screen.findByText("This model doesn't say which Dialect it targets. Choose one.")).toBeTruthy();
  await userEvent.click(within(screen.getByRole("radiogroup", { name: "Dialect of the file" })).getByRole("radio", { name: /PostgreSQL/ }));
  await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
  expect(onStart.mock.calls[0][0]).toMatchObject({ path: null, name: "billing", dbml, savedDbml: "", dialect: "postgres" });
});

test("E1: Open as DBML shows only the Dialect question and says the model opens unsaved, never the .dbml file picker", async () => {
  noRecent();
  const onStart = vi.fn<(d: ModelDoc) => void>();
  render(<StartModel connections={[kfc]} openIds={new Set()} file={{ path: null, name: "billing", dbml: "Table a {\n  id int\n}\n", layout: null }} onStart={onStart} onCancel={() => {}} />);
  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByText("This model doesn't say which Dialect it targets. Choose one.")).toBeTruthy();
  // Nothing of the "Open a .dbml file" way: no drop box, no Browse, no file footer, no ways to start.
  expect(within(dialog).queryByText("Drop a .dbml file here")).toBeNull();
  expect(within(dialog).queryByRole("button", { name: /Browse/ })).toBeNull();
  expect(within(dialog).queryByRole("button", { name: /Open\.\.\./ })).toBeNull();
  expect(dialog.textContent).not.toContain("Opens the file. It is saved back to the same place.");
  expect(within(dialog).queryByRole("radiogroup", { name: "Start from" })).toBeNull();
  expect(within(dialog).queryByText("Recent models")).toBeNull();
  expect(dialog.textContent).toContain("The converted model opens unsaved. The first Save asks where to keep it.");
  // One Continue, and Enter takes it too.
  expect(within(dialog).getAllByRole("button", { name: /Continue/ })).toHaveLength(1);
  fireEvent.keyDown(within(dialog).getByRole("radiogroup", { name: "Dialect of the file" }), { key: "Enter" });
  expect(onStart.mock.calls[0][0]).toMatchObject({ path: null, name: "billing", dialect: "mysql" });
});

const REVERSE = {
  recent_items: () => [],
  list_databases: () => ["shop"],
  list_objects: () => [],
  reverse_engineer: () => "// Dialect: MySQL\nTable stores {\n  id int [pk]\n}\n",
};

test("from_connection_reverse_engineers_and_lays_out", async () => {
  routeInvoke(REVERSE);
  const onStart = setup(["c1"]);
  await chooseConnection();
  await screen.findByText("0 tables");
  await userEvent.click(screen.getByRole("button", { name: /^Read the database/ }));
  await waitFor(() => expect(onStart).toHaveBeenCalled());
  expect(callsTo("reverse_engineer")).toEqual([{ id: "c1", database: "shop", schema: null }]);
  const doc = onStart.mock.calls[0][0];
  expect(doc).toMatchObject({ path: null, dialect: "mysql", source: "connection", savedDbml: "", connectionId: "c1" });
  expect(doc.layout.tables[".stores"]).toBeDefined();
});

test("from_connection_needs_an_open_connection", () => {
  noRecent();
  setup([]);
  expect(screen.getByText("Open a Connection to read its schema.")).toBeTruthy();
});

test("the_table_count_has_grouping_commas", async () => {
  routeInvoke({ recent_items: () => [], list_databases: () => DATABASES, list_objects: () => Array.from({ length: 1234 }, () => ({ kind: "table" })) });
  setup(["c1"]);
  await chooseConnection();
  await screen.findByText("1,234 tables");
});
