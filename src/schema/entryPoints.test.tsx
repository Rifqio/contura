import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test, vi } from "vitest";
import App from "../App";
import { routeInvoke } from "../test/invoke";
import { patientFile } from "../test/load";
import { mockReactFlowDom } from "../test/reactFlow";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

patientFile();
beforeAll(mockReactFlowDom);

const conn = {
  id: "a",
  name: "Shop",
  dialect: "mysql" as const,
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  database: "shop",
  ssl: { mode: "disable" },
  file: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
};

test("tree_new_schema_model_opens_the_builder", async () => {
  routeInvoke({
    list_groups: () => [],
    list_connections: () => [{ ...conn, groupId: null }],
    last_group: () => null,
    suggested_connections: () => [],
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Open Ungrouped" }));
  await userEvent.click(await screen.findByRole("button", { name: "More actions for Shop" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "New Schema Model..." }));
  await userEvent.click(screen.getByRole("radio", { name: /Blank model/ }));
  await userEvent.click(screen.getByRole("button", { name: /^Create blank model/ }));
  expect(await screen.findByRole("region", { name: "Schema Model schema" })).toBeTruthy();
  // The model opens in a tab, with the strip still there.
  expect(screen.getByRole("tab", { name: "untitled.dbml", selected: true })).toBeTruthy();
  await waitFor(() => expect(screen.getByRole("group", { name: "Table new_table" })).toBeTruthy());
  // Closing the tab asks the builder, which has unsaved changes.
  await userEvent.click(screen.getByRole("button", { name: "Close untitled.dbml" }));
  await userEvent.click(screen.getByRole("button", { name: "Don't save" }));
  expect(await screen.findByRole("heading", { name: "Home" })).toBeTruthy();
});

// Reverse-engineering from a database or schema row's menu is tested in src/sidebar/OneTree.test.tsx.
