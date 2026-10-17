import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { Group } from "../api/types";
import type { Place } from "../shell/tabs";
import GroupSwitcher from "./GroupSwitcher";

const groups: Group[] = [
  { id: "g1", name: "KFC", color: "indigo", hasImage: false },
  { id: "g2", name: "Acme", color: "sky", hasImage: false },
];

function renderSwitcher(place: Place = { kind: "group", groupId: "g1" }, connectionCount = 3, list = groups) {
  const callbacks = {
    onHome: vi.fn(),
    onOpenGroup: vi.fn(),
    onOpenUngrouped: vi.fn(),
    onNewGroup: vi.fn(),
    onSettings: vi.fn(),
  };
  const view = render(<GroupSwitcher groups={list} place={place} connectionCount={connectionCount} {...callbacks} />);
  return { ...callbacks, ...view };
}

const trigger = () => screen.getByRole("button", { name: /^Switch Group, current / });
const itemNames = () => screen.getAllByRole("menuitem").map((i) => i.getAttribute("aria-label"));
const shortcutOf = (name: string) => screen.getByRole("menuitem", { name }).querySelector(".menu-shortcut")?.textContent ?? null;

test("names_the_current_group_or_no_group", () => {
  const { unmount } = renderSwitcher();
  expect(trigger().getAttribute("aria-label")).toBe("Switch Group, current KFC");
  expect(trigger().textContent).toContain("KFC");
  expect(trigger().querySelector(".group-badge")?.textContent).toBe("K");
  unmount();

  const second = renderSwitcher({ kind: "ungrouped" });
  expect(trigger().getAttribute("aria-label")).toBe("Switch Group, current Ungrouped");
  second.unmount();

  // C3: with no Connections at all the switcher says No Group, with the empty ringed square.
  renderSwitcher({ kind: "ungrouped" }, 0, []);
  expect(trigger().getAttribute("aria-label")).toBe("Switch Group, current No Group");
  expect(trigger().textContent).toContain("No Group");
  expect(trigger().querySelector(".group-badge-empty")).toBeTruthy();
});

test("menu_lists_home_groups_with_numbers_new_group_and_settings", async () => {
  const { onHome, onOpenGroup, onOpenUngrouped, onNewGroup, onSettings } = renderSwitcher();
  await userEvent.click(trigger());
  // Groups by name, then Ungrouped (PR7).
  expect(itemNames()).toEqual(["Home", "Acme", "KFC", "Ungrouped", "New Group...", "Settings"]);
  expect(screen.getByRole("menu").querySelector(".menu-heading")?.textContent).toBe("Groups");
  expect(shortcutOf("Home")).toBe("Ctrl+Shift+H");
  expect(shortcutOf("Acme")).toBe("Ctrl+1");
  expect(shortcutOf("KFC")).toBe("Ctrl+2");
  expect(shortcutOf("Ungrouped")).toBe("Ctrl+3");
  expect(shortcutOf("New Group...")).toBeNull();
  expect(shortcutOf("Settings")).toBe("Ctrl+,");
  // Separators after Home and before New Group..., and none between New Group... and Settings.
  const separatorBefore = (name: string) =>
    screen.getByRole("menuitem", { name }).parentElement?.querySelector(":scope > .menu-separator") !== null;
  expect(separatorBefore("New Group...")).toBe(true);
  expect(separatorBefore("Settings")).toBe(false);
  expect(screen.getByRole("menu").querySelectorAll(".menu-separator")).toHaveLength(2);
  // Each Group shows its initial square; Ungrouped the empty one.
  expect(screen.getByRole("menuitem", { name: "KFC" }).querySelector(".group-badge")?.textContent).toBe("K");
  expect(screen.getByRole("menuitem", { name: "Ungrouped" }).querySelector(".group-badge-empty")).toBeTruthy();

  await userEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
  expect(onSettings).toHaveBeenCalledTimes(1);
  await userEvent.click(trigger());
  await userEvent.click(screen.getByRole("menuitem", { name: "Acme" }));
  expect(onOpenGroup).toHaveBeenCalledWith("g2");
  expect(screen.queryByRole("menu")).toBeNull();
  await userEvent.click(trigger());
  await userEvent.click(screen.getByRole("menuitem", { name: "Home" }));
  expect(onHome).toHaveBeenCalledTimes(1);
  await userEvent.click(trigger());
  await userEvent.click(screen.getByRole("menuitem", { name: "Ungrouped" }));
  expect(onOpenUngrouped).toHaveBeenCalledTimes(1);
  await userEvent.click(trigger());
  await userEvent.click(screen.getByRole("menuitem", { name: "New Group..." }));
  expect(onNewGroup).toHaveBeenCalledTimes(1);
});

test("current_group_uses_the_selected_look_not_a_check", async () => {
  renderSwitcher();
  await userEvent.click(trigger());
  const kfc = screen.getByRole("menuitem", { name: "KFC" });
  expect(kfc.getAttribute("aria-current")).toBe("true");
  expect(kfc.classList.contains("menu-item-current")).toBe(true);
  expect(kfc.getAttribute("aria-checked")).toBeNull();
  expect(kfc.getAttribute("role")).toBe("menuitem");
  for (const other of ["Home", "Acme", "Ungrouped", "Settings"]) {
    expect(screen.getByRole("menuitem", { name: other }).classList.contains("menu-item-current")).toBe(false);
  }
});

test("arrow keys move focus through the menu and Escape returns focus to the button", async () => {
  const { onOpenGroup } = renderSwitcher();
  trigger().focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Home");
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Acme");
  await userEvent.keyboard("{ArrowUp}{ArrowUp}");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Settings");
  await userEvent.keyboard("{Home}");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Home");
  await userEvent.keyboard("{End}");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Settings");
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(trigger());

  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
  expect(onOpenGroup).toHaveBeenCalledWith("g1");
});
