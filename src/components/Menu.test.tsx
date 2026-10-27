import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import Icon from "./Icon";
import Menu, { type MenuItem, PointMenu } from "./Menu";

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

test("a_point_menu_opened_20_px_from_the_right_edge_moves_left_at_its_own_width", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
  const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const w = this.classList.contains("tree-menu") ? 260 : 0;
    return { left: 0, top: 0, width: w, height: w ? 120 : 0, right: w, bottom: w ? 120 : 0, x: 0, y: 0, toJSON() {} } as DOMRect;
  });
  render(
    <PointMenu
      x={1004}
      y={40}
      label="Column"
      onClose={() => {}}
      onDismiss={() => {}}
      items={[{ key: "left", label: "Move left", shortcut: "Shift+Alt+Left", onSelect: () => {} }]}
    />,
  );
  const box = document.querySelector(".tree-menu") as HTMLElement;
  // Its whole measured width fits: placed at 1024 - 260 - 4, not squeezed into the 20 px left of it.
  expect(box.style.left).toBe("760px");
  expect(box.style.top).toBe("40px");
  expect(box.style.width).toBe("");
  rect.mockRestore();
});

test("a_submenu_row_keeps_its_chevron_on_its_line", async () => {
  await open([{ key: "c", label: "Colour", hint: "Blue", submenu: [{ key: "b", label: "Blue", onSelect: () => {} }] }]);
  const row = screen.getByRole("menuitem", { name: "Colour" });
  expect(row.children).toHaveLength(3);
  const right = row.children[2];
  expect(right.querySelector(".menu-hint")).not.toBeNull();
  expect(right.querySelector(".menu-chevron")).not.toBeNull();
});

test("no_empty_overlay_survives_a_resize", async () => {
  await open([]);
  window.dispatchEvent(new Event("resize"));
  expect(document.querySelector(".menu")).toBeNull();
  render(<PointMenu x={10} y={10} items={[]} label="Cell" onClose={() => {}} onDismiss={() => {}} />);
  window.dispatchEvent(new Event("resize"));
  expect(document.querySelector(".menu")).toBeNull();
});
