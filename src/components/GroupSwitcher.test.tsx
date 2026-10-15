import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { Group } from "../api/types";
import GroupSwitcher from "./GroupSwitcher";

const groups: Group[] = [
  { id: "g1", name: "KFC", color: "red" },
  { id: "g2", name: "Acme", color: "blue" },
];

function renderSwitcher() {
  const callbacks = { onHome: vi.fn(), onOpenGroup: vi.fn(), onOpenUngrouped: vi.fn() };
  render(<GroupSwitcher groups={groups} place={{ kind: "group", groupId: "g1" }} {...callbacks} />);
  return callbacks;
}

const trigger = () => screen.getByRole("button", { name: "Switch Group, current KFC" });
const itemNames = () => screen.getAllByRole("menuitem").map((i) => i.getAttribute("aria-label"));

test("menu lists Home, every Group and Ungrouped, and choosing one calls back", async () => {
  const { onHome, onOpenGroup, onOpenUngrouped } = renderSwitcher();
  expect(trigger().textContent).toContain("KFC");
  await userEvent.click(trigger());
  expect(itemNames()).toEqual(["Home", "KFC", "Acme", "Ungrouped"]);
  await userEvent.click(screen.getByRole("menuitem", { name: "Acme" }));
  expect(onOpenGroup).toHaveBeenCalledWith("g2");
  expect(screen.queryByRole("menu")).toBeNull();

  await userEvent.click(trigger());
  await userEvent.click(screen.getByRole("menuitem", { name: "Home" }));
  expect(onHome).toHaveBeenCalledTimes(1);

  await userEvent.click(trigger());
  await userEvent.click(screen.getByRole("menuitem", { name: "Ungrouped" }));
  expect(onOpenUngrouped).toHaveBeenCalledTimes(1);
});

test("arrow keys move focus through the menu and Escape returns focus to the button", async () => {
  const { onOpenGroup } = renderSwitcher();
  trigger().focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Home");
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("KFC");
  await userEvent.keyboard("{ArrowUp}{ArrowUp}");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Ungrouped");
  await userEvent.keyboard("{Home}");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Home");
  await userEvent.keyboard("{End}");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Ungrouped");
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(trigger());

  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
  expect(onOpenGroup).toHaveBeenCalledWith("g2");
});
