import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import Icon from "./Icon";
import Menu, { type MenuItem } from "./Menu";

function open(items: MenuItem[]) {
  render(
    <Menu
      label="Actions"
      items={items}
      trigger={(props) => (
        <button type="button" {...props}>
          Open
        </button>
      )}
    />,
  );
  return userEvent.click(screen.getByRole("button", { name: "Open" }));
}

test("labels_line_up_with_and_without_icons", async () => {
  await open([
    { key: "a", label: "Plain", onSelect: () => {} },
    { key: "b", label: "Iconed", icon: <Icon name="plus" />, onSelect: () => {} },
  ]);
  const items = document.querySelectorAll(".menu-item");
  expect(items.length).toBe(2);
  for (const item of items) expect(item.querySelectorAll(".menu-icon").length).toBe(1);
});

test("shortcut_shows_in_the_right_column", async () => {
  await open([{ key: "a", label: "New query", shortcut: "Ctrl+T", onSelect: () => {} }]);
  expect(document.querySelector(".menu-shortcut")?.textContent).toBe("Ctrl+T");
});

test("submenu_opens_with_right_and_closes_with_left", async () => {
  const onSelect = vi.fn();
  await open([
    { key: "move", label: "Move to", submenu: [{ key: "g1", label: "Billing", onSelect }] },
    { key: "other", label: "Other", onSelect: () => {} },
  ]);
  const parent = screen.getByRole("menuitem", { name: "Move to" });
  parent.focus();
  await userEvent.keyboard("{ArrowRight}");
  const child = screen.getByRole("menuitem", { name: "Billing" });
  expect(document.activeElement).toBe(child);
  await userEvent.keyboard("{ArrowLeft}");
  expect(screen.queryByRole("menuitem", { name: "Billing" })).toBeNull();
  expect(document.activeElement).toBe(parent);
  await userEvent.keyboard("{ArrowRight}{Enter}");
  expect(onSelect).toHaveBeenCalled();
});

test("disabled_items_are_skipped", async () => {
  await open([
    { key: "a", label: "First", onSelect: () => {} },
    { key: "b", label: "Second", disabled: true, onSelect: () => {} },
    { key: "c", label: "Third", onSelect: () => {} },
  ]);
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "First" }));
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Third" }));
});

test("current_item_uses_the_selected_look", async () => {
  await open([{ key: "a", label: "Dark", current: true, onSelect: () => {} }]);
  const item = screen.getByRole("menuitem", { name: "Dark" });
  expect(item.getAttribute("aria-current")).toBe("true");
  expect(item.querySelector("svg")).toBeNull();
});

test("heading_is_not_focusable", async () => {
  await open([
    { key: "h", label: "Theme", heading: "Appearance" },
    { key: "a", label: "Dark", onSelect: () => {} },
  ]);
  expect(screen.getByText("Appearance").closest("[role=menuitem]")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Dark" }));
});

test("hovering_a_plain_row_keeps_focus_in_the_menu", async () => {
  await open([
    { key: "move", label: "Move to", submenu: [{ key: "g1", label: "Billing", onSelect: () => {} }] },
    { key: "other", label: "Other", onSelect: () => {} },
  ]);
  screen.getByRole("menuitem", { name: "Move to" }).focus();
  await userEvent.keyboard("{ArrowRight}");
  const other = screen.getByRole("menuitem", { name: "Other" });
  await userEvent.hover(other);
  expect(screen.queryByRole("menuitem", { name: "Billing" })).toBeNull();
  expect(document.activeElement).toBe(other);
});
