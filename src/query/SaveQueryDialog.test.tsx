import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import type { ConnectionConfig } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import appCss from "../styles/app.css?raw";
import SaveQueryDialog from "./SaveQueryDialog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

const conn = (id: string, name: string, database: string): ConnectionConfig => ({
  id,
  name,
  dialect: "postgres",
  host: "h",
  port: 5432,
  user: "u",
  database,
  ssl: { mode: "disable" },
  file: null,
  groupId: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
});
const connections = [conn("c1", "shop-staging", "shop"), conn("c2", "freight-prod", "freight")];
const existing = { id: "q1", name: "late shipments by carrier", sql: "SELECT old", updatedAtMs: 1, connectionId: "c2" };

function setup(over: Partial<Parameters<typeof SaveQueryDialog>[0]> = {}) {
  routeInvoke({
    list_saved_queries: () => [existing],
    save_saved_query: ({ input }) => ({ ...(input as object), id: (input as { id: string | null }).id ?? "q9", updatedAtMs: 2 }),
  });
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  render(
    <SaveQueryDialog sql="SELECT 1" connections={connections} connectionId="c1" onSaved={onSaved} onCancel={onCancel} {...over} />,
  );
  return { onSaved, onCancel };
}

test("form_dialog_with_help_and_opens_on", async () => {
  const { onSaved } = setup();
  const dialog = screen.getByRole("dialog");
  expect(dialog.className).toContain("dialog-size-form");
  expect(screen.getByRole("heading", { name: "Save query" })).toBeTruthy();
  expect(
    screen.getByText("Saved Queries are kept in Contura's data folder and listed under Saved Queries in the sidebar."),
  ).toBeTruthy();
  expect(screen.getByText("The Connection it opens on next time. You can still switch it in the editor.")).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Opens on" }).textContent).toContain("shop-staging");
  expect(document.activeElement).toBe(screen.getByLabelText("Name"));
  await userEvent.type(screen.getByLabelText("Name"), "weekly");
  await userEvent.click(screen.getByRole("combobox", { name: "Opens on" }));
  await userEvent.click(screen.getByRole("option", { name: /freight-prod/ }));
  expect(screen.getByRole("button", { name: /^Cancel/ }).textContent).toContain("Esc");
  await userEvent.click(screen.getByRole("button", { name: /^Save/ }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(callsTo("save_saved_query")).toEqual([{ input: { id: null, name: "weekly", sql: "SELECT 1", connectionId: "c2" } }]);
});

test("the_tabs_connection_is_the_default", async () => {
  setup();
  await userEvent.type(screen.getByLabelText("Name"), "weekly");
  await userEvent.click(screen.getByRole("button", { name: /^Save/ }));
  await waitFor(() => expect(callsTo("save_saved_query")).toHaveLength(1));
  expect((callsTo("save_saved_query")[0].input as { connectionId: string }).connectionId).toBe("c1");
});

test("help_line_is_12px_subtle", () => {
  setup();
  expect(document.querySelector(".field-help")).toBeTruthy();
  const all = [...appCss.matchAll(/\.field-help\s*\{([^}]*)\}/g)].map((m) => m[1]).join("\n");
  expect(all).toMatch(/--c-text-subtle/);
  expect(all).toMatch(/font:\s*var\(--font-small\)/);
});

test("taken_name_turns_save_into_replace", async () => {
  const { onSaved } = setup();
  await userEvent.type(screen.getByLabelText("Name"), "Late Shipments by Carrier");
  expect(await screen.findByText("A Saved Query with this name already exists. Replace it, or change the name.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
  const replace = screen.getByRole("button", { name: /^Replace/ });
  expect(replace.textContent).toContain("Enter");
  await userEvent.click(replace);
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(callsTo("save_saved_query")[0].input).toEqual({
    id: "q1",
    name: "Late Shipments by Carrier",
    sql: "SELECT 1",
    connectionId: "c1",
  });
});

test("renaming_asks_only_for_the_name_and_keeps_the_stored_connection", async () => {
  setup({ existing: { id: "q1", name: "late shipments by carrier" } });
  expect(screen.getByRole("heading", { name: "Rename Saved Query" })).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Opens on" })).toBeNull();
  await userEvent.type(screen.getByLabelText("Name"), " 2");
  await userEvent.click(screen.getByRole("button", { name: /^Save/ }));
  await waitFor(() => expect(callsTo("save_saved_query")).toHaveLength(1));
  expect(callsTo("save_saved_query")[0].input).toEqual({ id: "q1", name: "late shipments by carrier 2", sql: "SELECT 1" });
});
