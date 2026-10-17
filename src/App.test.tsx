import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test, vi } from "vitest";
import { mockEditorDom } from "./test/editor";
import { mockReactFlowDom } from "./test/reactFlow";
import { callsTo, routeInvoke } from "./test/invoke";
import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
});

test("startup opens last group when it exists, otherwise home", async () => {
  const groups = [{ id: "g1", name: "KFC", color: "red" }];
  routeInvoke({
    list_groups: () => groups,
    list_connections: () => [],
    last_group: () => "g1",
    suggested_connections: () => [],
  });
  render(<App />);
  const switcher = await screen.findByRole("button", { name: "Switch Group, current KFC" });
  expect(switcher).toBeTruthy();
  expect(await screen.findByText("No Connections in KFC yet.")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Home" })).toBeNull();
  cleanup();

  routeInvoke({
    list_groups: () => groups,
    list_connections: () => [],
    last_group: () => null,
    suggested_connections: () => [],
  });
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Home" })).toBeTruthy();
  cleanup();

  // A remembered Group that no longer exists falls back to Home.
  routeInvoke({
    list_groups: () => groups,
    list_connections: () => [],
    last_group: () => "deleted-group",
    suggested_connections: () => [],
  });
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Home" })).toBeTruthy();
});

const kfc = { id: "g1", name: "KFC", color: "red" };
const pg = {
  id: "c1",
  name: "KFC Postgres",
  dialect: "postgres",
  host: "127.0.0.1",
  port: 5432,
  user: "u",
  database: "kfc_shop",
  ssl: { mode: "disable" },
  file: null,
  groupId: "g1",
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
};

function workspaceRoutes(over: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  routeInvoke({
    list_groups: () => [kfc],
    list_connections: () => [pg],
    last_group: () => "g1",
    suggested_connections: () => [],
    load_query_tabs: () => null,
    save_query_tabs: () => null,
    list_saved_queries: () => [],
    open_connection: () => null,
    list_databases: () => ["kfc_shop"],
    open_query_session: () => "s1",
    close_query_session: () => null,
    ...over,
  });
}

test("ctrl_t_opens_numbered_query_tabs_and_closing_activates_a_neighbour", async () => {
  workspaceRoutes();
  render(<App />);
  await screen.findByRole("button", { name: "Switch Group, current KFC" });
  await userEvent.keyboard("{Control>}t{/Control}");
  expect(await screen.findByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "New query" }));
  expect(await screen.findByRole("tab", { name: "Query 2", selected: true })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Close Query 2" }));
  expect(await screen.findByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Query 2" })).toBeNull();
});

test("new_query_from_the_connection_menu_starts_on_that_connection", async () => {
  workspaceRoutes();
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "More actions for KFC Postgres" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "New query" }));
  expect(await screen.findByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
  await waitFor(() => expect(callsTo("open_connection")).toEqual([{ id: "c1" }]));
  await waitFor(() => expect(callsTo("open_query_session")).toEqual([{ id: "c1", database: "kfc_shop" }]));
  expect((screen.getByRole("combobox", { name: "Connection" }) as HTMLSelectElement).value).toBe("c1");
});

test("drafts_are_saved_per_place_and_restored_on_start", async () => {
  const draft = [
    { id: "d1", name: "Late deliveries", text: "SELECT 1", connectionId: "c1", database: "kfc_shop", savedId: null, savedText: null },
  ];
  workspaceRoutes({ load_query_tabs: ({ place }) => (place === "group:g1" ? JSON.stringify({ version: 1, tabs: draft }) : null) });
  render(<App />);
  expect(await screen.findByRole("tab", { name: "Late deliveries" })).toBeTruthy();
  await userEvent.keyboard("{Control>}t{/Control}");
  await screen.findByRole("tab", { name: "Query 1" });
  await waitFor(
    () => {
      const saved = callsTo("save_query_tabs").slice(-1)[0];
      expect(saved?.place).toBe("group:g1");
      expect(JSON.parse(saved?.json as string).tabs.map((t: { name: string }) => t.name)).toEqual([
        "Late deliveries",
        "Query 1",
      ]);
    },
    { timeout: 3000 },
  );
});

test("switching from a Group to Ungrouped forgets the last Group", async () => {
  routeInvoke({
    list_groups: () => [{ id: "g1", name: "KFC", color: "red" }],
    list_connections: () => [],
    last_group: () => "g1",
    suggested_connections: () => [],
    set_last_group: () => null,
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Switch Group, current KFC" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Ungrouped" }));
  expect(await screen.findByRole("button", { name: "Switch Group, current Ungrouped" })).toBeTruthy();
  expect(callsTo("set_last_group")).toEqual([{ id: null }]);
});

test("the rail's gear opens Settings with the AI section, and Connections leads back", async () => {
  routeInvoke({
    list_groups: () => [{ id: "g1", name: "KFC", color: "red" }],
    list_connections: () => [],
    last_group: () => "g1",
    suggested_connections: () => [],
    ai_settings: () => ({
      settings: {
        provider: null,
        preset: null,
        baseUrl: "",
        model: "",
        temperature: null,
        maxTokens: null,
        inlineAsk: true,
        errorAsk: true,
      },
      groupOverride: false,
      keySaved: false,
      keyLast4: null,
    }),
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Settings" }));
  expect(await screen.findByLabelText("Use different settings for KFC")).toBeTruthy();
  expect(screen.getByText("AI assistant", { selector: "span" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Connections" }));
  expect(screen.queryByLabelText("Use different settings for KFC")).toBeNull();
  expect(screen.getByText("No Connections in KFC yet.")).toBeTruthy();
});
