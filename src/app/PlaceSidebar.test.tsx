import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { Group } from "../api/types";
import PlaceSidebar from "./PlaceSidebar";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const orbit: Group = { id: "g1", name: "Orbit Freight", color: "indigo", hasImage: false };

function sidebar(over: Partial<ComponentProps<typeof PlaceSidebar>> = {}) {
  const props: ComponentProps<typeof PlaceSidebar> = {
    group: undefined,
    placeName: "Ungrouped",
    hidden: false,
    empty: false,
    notice: null,
    onEditGroup: vi.fn(),
    onNewConnection: vi.fn(),
    children: <div>the tree</div>,
    ...over,
  };
  render(<PlaceSidebar {...props} />);
  return props;
}

test("empty_place_offers_new_connection", async () => {
  const props = sidebar({ empty: true });
  expect(screen.getByText("No Connections in Ungrouped yet.")).toBeTruthy();
  const buttons = screen.getAllByRole("button", { name: "New Connection" });
  expect(buttons).toHaveLength(2);
  await userEvent.click(buttons[1]);
  expect(props.onNewConnection).toHaveBeenCalledTimes(1);
  expect(screen.getByText("the tree")).toBeTruthy();
});

test("notice_is_hidden_under_a_window_tab", () => {
  sidebar({ notice: "That Connection is not open any more. Open it again to continue." });
  expect(screen.getByRole("alert").textContent).toBe("That Connection is not open any more. Open it again to continue.");
  screen.getByRole("complementary", { name: "Ungrouped Connections" });
  cleanup();
  sidebar({ notice: "That Connection is not open any more.", hidden: true });
  expect(screen.queryByRole("alert", { hidden: true })).toBeNull();
  // Still mounted, only hidden.
  expect(document.querySelector("aside.side")?.hasAttribute("hidden")).toBe(true);
});

test("edit_group_shows_only_for_a_group", async () => {
  sidebar();
  expect(screen.queryByRole("button", { name: /^Edit / })).toBeNull();
  cleanup();
  const props = sidebar({ group: orbit, placeName: "Orbit Freight" });
  await userEvent.click(screen.getByRole("button", { name: "Edit Orbit Freight" }));
  expect(props.onEditGroup).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("heading", { name: "Orbit Freight" })).toBeTruthy();
});
