import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { ConnectionConfig, Group } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import ConnectionList from "./ConnectionList";

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

const connections = [
  conn("a", "kfc-prod", "g1"),
  conn("b", "kfc-staging", "g1"),
  conn("c", "acme-db", "g2"),
  conn("d", "laragon", null),
];

function renderList(onChanged = vi.fn(), list: ConnectionConfig[] = connections) {
  render(
    <ConnectionList
      groupId="g1"
      groups={groups}
      connections={list}
      openIds={new Set()}
      activeId={null}
      onActivate={() => {}}
      onOpened={() => {}}
      onClosed={() => {}}
      onEdit={() => {}}
      onChanged={onChanged}
    />,
  );
  return { onChanged };
}

test("shows only the current group's connections", () => {
  routeInvoke({});
  renderList();
  const list = screen.getByRole("list", { name: "Connections" });
  expect(within(list).getByText("kfc-prod")).toBeTruthy();
  expect(within(list).getByText("kfc-staging")).toBeTruthy();
  expect(within(list).queryByText("acme-db")).toBeNull();
  expect(within(list).queryByText("laragon")).toBeNull();
});

const sqliteShop: ConnectionConfig = {
  ...conn("s", "shop-file", "g1"),
  dialect: "sqlite",
  host: "",
  port: 0,
  file: "C:\\data\\shop.db",
};

test("sqlite_row_shows_file_path", () => {
  routeInvoke({});
  renderList(vi.fn(), [sqliteShop]);
  const list = screen.getByRole("list", { name: "Connections" });
  const target = within(list).getByText("C:\\data\\shop.db");
  expect(target.getAttribute("title")).toBe("C:\\data\\shop.db");
  expect(within(list).queryByText(":0")).toBeNull();
});

test("rows_show_dialect_tag", () => {
  routeInvoke({});
  const pg = { ...conn("p", "kfc-orders", "g1"), dialect: "postgres" as const, host: "10.0.4.20", port: 5432 };
  renderList(vi.fn(), [pg, conn("a", "kfc-prod", "g1"), sqliteShop]);
  const rows = within(screen.getByRole("list", { name: "Connections" })).getAllByRole("listitem");
  expect(within(rows[0]).getByText("PostgreSQL")).toBeTruthy();
  expect(within(rows[0]).getByText("10.0.4.20:5432", { exact: false })).toBeTruthy();
  expect(within(rows[1]).getByText("MySQL")).toBeTruthy();
  expect(within(rows[2]).getByText("SQLite")).toBeTruthy();
});

test("sqlite_open_error_gets_the_file_hint", async () => {
  routeInvoke({
    open_connection: () => {
      throw { kind: "connect", message: "cannot open C:\\data\\shop.db: the file does not exist" };
    },
  });
  renderList(vi.fn(), [sqliteShop]);
  await userEvent.click(screen.getByRole("button", { name: "Open shop-file" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Cannot open C:\\data\\shop.db: the file does not exist. Check the path, or choose the file again.",
  );
});

test("move to ungrouped calls move_connection with null", async () => {
  routeInvoke({ move_connection: () => ({ ...connections[0], groupId: null }) });
  const { onChanged } = renderList();
  await userEvent.click(screen.getByRole("button", { name: "More actions for kfc-prod" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Move to Ungrouped" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(callsTo("move_connection")).toEqual([{ id: "a", groupId: null }]);
});
