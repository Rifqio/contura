import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { ConnectionConfig, Group } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import App from "../App";
import Home from "./Home";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const groups: Group[] = [
  { id: "g1", name: "KFC", color: "red" },
  { id: "g2", name: "Acme", color: "blue" },
];

function conn(id: string, name: string, groupId: string | null): ConnectionConfig {
  return {
    id,
    name,
    dialect: "mysql",
    host: "127.0.0.1",
    port: 3306,
    user: "root",
    database: null,
    ssl: { mode: "disable" },
    groupId,
  };
}

const connections = [conn("a", "kfc-prod", "g1"), conn("b", "kfc-staging", "g1"), conn("c", "laragon", null)];

function renderHome(props: Partial<Parameters<typeof Home>[0]> = {}) {
  render(
    <Home
      groups={groups}
      connections={connections}
      onOpenGroup={() => {}}
      onOpenUngrouped={() => {}}
      onChanged={() => {}}
      {...props}
    />,
  );
}

test("lists groups with connection counts and ungrouped connections", async () => {
  routeInvoke({ suggested_connections: () => [] });
  renderHome();
  const kfc = screen.getByRole("button", { name: /KFC/ });
  expect(within(kfc).getByText("2 Connections")).toBeTruthy();
  const acme = screen.getByRole("button", { name: /Acme/ });
  expect(within(acme).getByText("No Connections")).toBeTruthy();
  const ungrouped = screen.getByRole("list", { name: "Ungrouped Connections" });
  expect(within(ungrouped).getByText("laragon")).toBeTruthy();
  expect(within(ungrouped).queryByText("kfc-prod")).toBeNull();
});

// Opening a Group and remembering it is one path in App, so this renders the whole app starting at Home.
test("clicking a group card opens it and calls set_last_group", async () => {
  routeInvoke({
    list_groups: () => groups,
    list_connections: () => connections,
    last_group: () => null,
    suggested_connections: () => [],
    set_last_group: () => null,
  });
  render(<App />);
  await screen.findByRole("heading", { name: "Home" });
  await userEvent.click(screen.getByRole("button", { name: /KFC/ }));
  expect(await screen.findByRole("button", { name: "Switch Group, current KFC" })).toBeTruthy();
  await waitFor(() => expect(callsTo("set_last_group")).toEqual([{ id: "g1" }]));
  expect(within(screen.getByRole("list", { name: "Connections" })).getByText("kfc-prod")).toBeTruthy();
});

test("suggested connection add pre-fills form with port 3310 and no group", async () => {
  routeInvoke({
    suggested_connections: () => [
      { name: "Laragon MySQL", dialect: "mysql", host: "127.0.0.1", port: 3310, user: "root" },
    ],
  });
  renderHome();
  await userEvent.click(await screen.findByRole("button", { name: "Add Laragon MySQL" }));
  const dialog = await screen.findByRole("dialog");
  expect((within(dialog).getByLabelText("Port") as HTMLInputElement).value).toBe("3310");
  expect((within(dialog).getByLabelText("Host") as HTMLInputElement).value).toBe("127.0.0.1");
  expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("Laragon MySQL");
  expect((within(dialog).getByLabelText("Group") as HTMLSelectElement).value).toBe("");
});

test("empty state offers New Group", async () => {
  routeInvoke({ suggested_connections: () => [] });
  renderHome({ groups: [], connections: [] });
  expect(screen.getByText(/Groups keep the Connections for one client or project together/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "New Group" }));
  expect(await screen.findByRole("dialog", { name: "New Group" })).toBeTruthy();
});
