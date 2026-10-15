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
    groupId,
  };
}

const connections = [
  conn("a", "kfc-prod", "g1"),
  conn("b", "kfc-staging", "g1"),
  conn("c", "acme-db", "g2"),
  conn("d", "laragon", null),
];

function renderList(onChanged = vi.fn()) {
  render(
    <ConnectionList
      groupId="g1"
      groups={groups}
      connections={connections}
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

test("move to ungrouped calls move_connection with null", async () => {
  routeInvoke({ move_connection: () => ({ ...connections[0], groupId: null }) });
  const { onChanged } = renderList();
  await userEvent.click(screen.getByRole("button", { name: "More actions for kfc-prod" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Move to Ungrouped" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(callsTo("move_connection")).toEqual([{ id: "a", groupId: null }]);
});
