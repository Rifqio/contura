import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
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
};

function setup(openIds: string[] = []) {
  const onStart = vi.fn<(d: ModelDoc) => void>();
  render(<StartModel connections={[kfc]} openIds={new Set(openIds)} onStart={onStart} onCancel={() => {}} />);
  return onStart;
}

test("blank_model_starts_with_template", async () => {
  const onStart = setup();
  await userEvent.selectOptions(screen.getByLabelText("Dialect"), "postgres");
  await userEvent.click(screen.getByRole("button", { name: "Start blank" }));
  const doc = onStart.mock.calls[0][0];
  expect(doc).toMatchObject({ path: null, dialect: "postgres", source: "blank" });
  expect(doc.dbml).toContain("// Dialect: PostgreSQL");
  expect(doc.dbml).toContain("Table new_table {");
  expect(doc.savedDbml).toBe("");
});

test("open_file_reads_dbml_and_layout", async () => {
  const dialog = await import("@tauri-apps/plugin-dialog");
  vi.mocked(dialog.open).mockResolvedValue("C:\\m\\shop.dbml");
  const dbml = "// Dialect: MySQL\nTable a {\n  id int\n}\n";
  routeInvoke({
    read_model_files: () => ({ dbml, layout: '{"version":1,"tables":{".a":{"x":5,"y":6}}}' }),
  });
  const onStart = setup();
  await userEvent.click(screen.getByRole("button", { name: "Open file…" }));
  await waitFor(() => expect(onStart).toHaveBeenCalled());
  expect(callsTo("read_model_files")).toEqual([{ path: "C:\\m\\shop.dbml" }]);
  const doc = onStart.mock.calls[0][0];
  expect(doc).toMatchObject({ path: "C:\\m\\shop.dbml", dialect: "mysql", source: "file", dbml, savedDbml: dbml });
  expect(doc.layout.tables[".a"]).toEqual({ x: 5, y: 6 });
});

test("open_file_without_dialect_asks", async () => {
  const dialog = await import("@tauri-apps/plugin-dialog");
  vi.mocked(dialog.open).mockResolvedValue("C:\\m\\plain.dbml");
  routeInvoke({ read_model_files: () => ({ dbml: "Table a {\n  id int\n}\n", layout: null }) });
  const onStart = setup();
  await userEvent.click(screen.getByRole("button", { name: "Open file…" }));
  expect(await screen.findByText("This file doesn't say which Dialect it targets. Choose one.")).toBeTruthy();
  await userEvent.selectOptions(screen.getByLabelText("Dialect of the file"), "sqlite");
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(onStart.mock.calls[0][0]).toMatchObject({ dialect: "sqlite", path: "C:\\m\\plain.dbml" });
});

test("from_connection_reverse_engineers_and_lays_out", async () => {
  routeInvoke({
    list_databases: () => ["shop"],
    reverse_engineer: () => "// Dialect: MySQL\nTable stores {\n  id int [pk]\n}\n",
  });
  const onStart = setup(["c1"]);
  await userEvent.selectOptions(screen.getByLabelText("Connection"), "c1");
  await userEvent.selectOptions(await screen.findByLabelText("Database"), "shop");
  await userEvent.click(screen.getByRole("button", { name: "Read the database" }));
  await waitFor(() => expect(onStart).toHaveBeenCalled());
  expect(callsTo("reverse_engineer")).toEqual([{ id: "c1", database: "shop", schema: null }]);
  const doc = onStart.mock.calls[0][0];
  expect(doc).toMatchObject({ path: null, dialect: "mysql", source: "connection", savedDbml: "" });
  expect(doc.layout.tables[".stores"]).toBeDefined();
});

test("from_connection_needs_an_open_connection", () => {
  setup([]);
  expect(screen.getByText("Open a Connection to read its schema.")).toBeTruthy();
});
