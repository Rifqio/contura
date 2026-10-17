import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import Dialog from "./Dialog";
import Select, { listPlacement } from "./Select";

const OPTIONS = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "cherry", label: "Cherry" },
];

test("opens_with_enter_and_picks_with_arrows", async () => {
  const onChange = vi.fn();
  render(<Select value="apple" options={OPTIONS} onChange={onChange} label="Fruit" />);
  screen.getByRole("combobox", { name: "Fruit" }).focus();
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("listbox")).toBeTruthy();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  expect(onChange).toHaveBeenLastCalledWith("cherry");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("typeahead_jumps_to_the_first_match", async () => {
  const onChange = vi.fn();
  render(<Select value="apple" options={OPTIONS} onChange={onChange} label="Fruit" />);
  screen.getByRole("combobox").focus();
  await userEvent.keyboard("{Enter}ch{Enter}");
  expect(onChange).toHaveBeenLastCalledWith("cherry");
});

test("escape_closes_and_keeps_the_value", async () => {
  const onChange = vi.fn();
  render(<Select value="apple" options={OPTIONS} onChange={onChange} label="Fruit" />);
  const box = screen.getByRole("combobox");
  box.focus();
  await userEvent.keyboard("{Enter}{ArrowDown}{Escape}");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(box);
});

test("options_carry_a_lead_and_a_hint", async () => {
  render(
    <Select
      value="a"
      label="Kind"
      onChange={() => {}}
      options={[
        { value: "a", label: "Alpha", lead: <i data-testid="lead" />, hint: "first" },
        { value: "b", label: "Beta" },
      ]}
    />,
  );
  await userEvent.click(screen.getByRole("combobox"));
  const opt = screen.getByRole("option", { name: /Alpha/ });
  expect(opt.querySelector("[data-testid=lead]")).toBeTruthy();
  expect(opt.querySelector(".select-hint")?.textContent).toBe("first");
});

test("combobox_names_and_active_descendant", async () => {
  render(<Select value="banana" options={OPTIONS} onChange={() => {}} label="Fruit" />);
  const box = screen.getByRole("combobox", { name: "Fruit" });
  expect(box.getAttribute("aria-expanded")).toBe("false");
  expect(box.textContent).toContain("Banana");
  await userEvent.click(box);
  expect(box.getAttribute("aria-expanded")).toBe("true");
  const active = box.getAttribute("aria-activedescendant");
  expect(active).toBeTruthy();
  expect(document.getElementById(active!)?.textContent).toContain("Banana");
  expect(screen.getByRole("listbox", { name: "Fruit" })).toBeTruthy();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.getElementById(box.getAttribute("aria-activedescendant")!)?.textContent).toContain("Cherry");
});

test("escape_in_a_dialog_closes_only_the_select", async () => {
  const onClose = vi.fn();
  render(
    <Dialog title="Pick" onClose={onClose}>
      <Select value="apple" options={OPTIONS} onChange={() => {}} label="Fruit" />
    </Dialog>,
  );
  const box = screen.getByRole("combobox");
  box.focus();
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("listbox")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalled();
});

test("the_open_list_is_portalled_to_the_body_outside_a_scrolling_dialog_body", async () => {
  const onChange = vi.fn();
  const onClose = vi.fn();
  render(
    <Dialog title="Edit" onClose={onClose}>
      <div className="dialog-body">
        <Select value="apple" options={OPTIONS} onChange={onChange} label="Fruit" />
      </div>
    </Dialog>,
  );
  await userEvent.click(screen.getByRole("combobox", { name: "Fruit" }));
  const list = screen.getByRole("listbox");
  expect(list.parentElement).toBe(document.body);
  expect(list.closest(".dialog-body")).toBeNull();
  // Picking an option is not an outside click: the dialog stays, the value changes.
  await userEvent.click(screen.getByRole("option", { name: "Banana" }));
  expect(onChange).toHaveBeenLastCalledWith("banana");
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("keyboard_still_picks_from_the_portalled_list", async () => {
  const onChange = vi.fn();
  render(<Select value="apple" options={OPTIONS} onChange={onChange} label="Fruit" />);
  const box = screen.getByRole("combobox", { name: "Fruit" });
  box.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(box.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "Apple" }).id);
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(onChange).toHaveBeenLastCalledWith("banana");
  expect(document.activeElement).toBe(box);
});

test("the_list_sits_under_the_button_or_flips_up_near_the_bottom", () => {
  const button = { top: 100, bottom: 132, left: 40, width: 200 };
  expect(listPlacement(button, 120, 800)).toEqual({ top: 136, left: 40, minWidth: 200, up: false });
  const low = { top: 720, bottom: 752, left: 40, width: 200 };
  expect(listPlacement(low, 120, 800)).toEqual({ top: 596, left: 40, minWidth: 200, up: true });
});

test("near_the_bottom_the_open_list_is_placed_above_the_button", async () => {
  render(<Select value="apple" options={OPTIONS} onChange={() => {}} label="Fruit" />);
  const box = screen.getByRole("combobox", { name: "Fruit" });
  const h = window.innerHeight;
  box.getBoundingClientRect = () => ({ top: h - 40, bottom: h - 8, left: 10, right: 210, width: 200, height: 32, x: 10, y: h - 40, toJSON: () => ({}) });
  await userEvent.click(box);
  const list = screen.getByRole("listbox");
  // Three rows: 3 * 28 + 2 * 4 + 2 = 94 tall, ending 4 px above the button.
  expect(list.style.top).toBe(`${h - 40 - 4 - 94}px`);
  expect(list.style.minWidth).toBe("200px");
});

test("a_scroll_outside_the_list_closes_it", async () => {
  render(<Select value="apple" options={OPTIONS} onChange={() => {}} label="Fruit" />);
  await userEvent.click(screen.getByRole("combobox", { name: "Fruit" }));
  expect(screen.getByRole("listbox")).toBeTruthy();
  document.body.dispatchEvent(new Event("scroll"));
  await screen.findByRole("combobox");
  expect(screen.queryByRole("listbox")).toBeNull();
});
