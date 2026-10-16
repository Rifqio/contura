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
    file: null,
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

test("postgres_and_mysql_suggestions_on_one_host_both_show", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  // One host and port for both, so only the Dialect tells the two rows apart.
  routeInvoke({
    suggested_connections: () => [
      { name: "Laragon MySQL", dialect: "mysql", host: "127.0.0.1", port: 5432, user: "root" },
      { name: "Laragon PostgreSQL", dialect: "postgres", host: "127.0.0.1", port: 5432, user: "postgres" },
    ],
  });
  renderHome();
  expect(await screen.findByRole("button", { name: "Add Laragon MySQL" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add Laragon PostgreSQL" })).toBeTruthy();
  const keyWarnings = errors.mock.calls.filter((args) => String(args[0]).includes("same key"));
  errors.mockRestore();
  expect(keyWarnings).toEqual([]);
});

test("suggestion_row_keeps_user_at_host_port", async () => {
  routeInvoke({
    suggested_connections: () => [
      { name: "Laragon PostgreSQL", dialect: "postgres", host: "127.0.0.1", port: 5432, user: "postgres" },
    ],
  });
  renderHome();
  const list = await screen.findByRole("list", { name: "Suggested Connections" });
  expect(within(list).getByText("postgres@127.0.0.1:5432")).toBeTruthy();
});

test("sqlite_connection_shows_its_file", async () => {
  routeInvoke({ suggested_connections: () => [] });
  const short = { ...conn("s1", "Shop file", null), dialect: "sqlite" as const, host: "", port: 0, file: "C:\\data\\shop.db" };
  const longPath = "C:\\Users\\Rifqi\\Documents\\Projects\\kfc\\exports\\2026\\october\\stores-2026-10-15.sqlite";
  const long = { ...short, id: "s2", name: "Store exports", file: longPath };
  renderHome({ connections: [short, long] });
  const list = screen.getByRole("list", { name: "Ungrouped Connections" });
  expect(within(list).getByText("C:\\data\\shop.db").getAttribute("title")).toBe("C:\\data\\shop.db");
  const shortened = within(list).getByText("C:\\Users\\Rifqi\\…\\stores-2026-10-15.sqlite");
  expect(shortened.getAttribute("title")).toBe(longPath);
  expect(within(list).queryByText(":0")).toBeNull();
});

test("rows_show_dialect_tag", async () => {
  routeInvoke({
    suggested_connections: () => [
      { name: "Laragon PostgreSQL", dialect: "postgres", host: "127.0.0.1", port: 5432, user: "postgres" },
    ],
  });
  const sqlite = { ...conn("s1", "Shop file", null), dialect: "sqlite" as const, file: "C:\\data\\shop.db" };
  renderHome({ connections: [conn("c", "laragon", null), sqlite] });
  const ungrouped = screen.getByRole("list", { name: "Ungrouped Connections" });
  const rows = within(ungrouped).getAllByRole("listitem");
  expect(within(rows[0]).getByText("MySQL")).toBeTruthy();
  expect(within(rows[1]).getByText("SQLite")).toBeTruthy();
  const suggested = await screen.findByRole("list", { name: "Suggested Connections" });
  expect(within(suggested).getByText("PostgreSQL")).toBeTruthy();
});

test("empty state offers New Group", async () => {
  routeInvoke({ suggested_connections: () => [] });
  renderHome({ groups: [], connections: [] });
  expect(screen.getByText(/Groups keep the Connections for one client or project together/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "New Group" }));
  expect(await screen.findByRole("dialog", { name: "New Group" })).toBeTruthy();
});
