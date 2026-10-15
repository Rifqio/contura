import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { callsTo, routeInvoke } from "./test/invoke";
import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

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
