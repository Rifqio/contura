import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveKeymap } from "../commands/keymap";
import { COMMANDS, type CommandId } from "../commands/registry";
import type { PaletteCommand, QuickItem } from "./entries";
import QuickOpen, { type QuickOpenProps } from "./QuickOpen";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const shop = { id: "p", name: "shop_prod", dialect: "postgres" as const, production: true, readOnly: false, open: true };
const analytics = { id: "a", name: "analytics", dialect: "mysql" as const, production: false, readOnly: false, open: false };

function item(name: string, over: Partial<QuickItem> = {}): QuickItem {
  return {
    id: `id:${name}`,
    kind: "table",
    name,
    qualifier: "public",
    connection: shop,
    target: { kind: "object", connectionId: "p", object: "table", path: { database: "shop", schema: "public", name } },
    ...over,
  };
}

const ALL: QuickItem[] = [
  item("orders"),
  item("invoices", { qualifier: "billing" }),
  item("invoice_lines", { qualifier: "billing" }),
  item("daily_orders", { qualifier: "analytics", connection: analytics }),
  item("Unpaid invoices", { id: "saved:q1", kind: "saved", qualifier: null, connection: shop }),
  item("order-flow", { id: "flow:order-flow", kind: "flow", qualifier: null, connection: null }),
  ...Array.from({ length: 30 }, (_, i) => item(`events_${i}`)),
];

const keymap = resolveKeymap({});
const cmd = (id: CommandId, note: string | null = null): PaletteCommand => ({ command: COMMANDS.find((c) => c.id === id)!, keys: keymap.get(id)?.[0] ?? null, note });

let props: QuickOpenProps;
let scrolled: Element[];

beforeEach(() => {
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  props = {
    initial: "",
    seq: 0,
    all: ALL,
    recentIds: ["id:invoices", "saved:q1", "id:daily_orders"],
    commands: [cmd("query.new"), cmd("tab.close"), cmd("tree.refresh"), cmd("group.open.1", "Shop")],
    recentCommands: ["tree.refresh"],
    quickOpenKeys: ["Ctrl+P", "Ctrl+K"],
    paletteKeys: ["Ctrl+Shift+P"],
    onOpen: vi.fn(),
    onRun: vi.fn(),
    onClose: vi.fn(),
  };
});
afterEach(() => {
  document.body.innerHTML = "";
});

/** The overlay as the app draws it: shown until it asks to close. */
function Host({ from = true }: { from?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      {from && (
        <button type="button" autoFocus>
          grid
        </button>
      )}
      <div data-testid="outside">elsewhere</div>
      {open && (
        <QuickOpen
          {...props}
          onClose={() => {
            props.onClose();
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

const box = () => screen.getByRole("combobox");
const options = () => screen.queryAllByRole("option");
const selected = () => options().find((o) => o.getAttribute("aria-selected") === "true");
const optionNames = () => options().map((o) => o.querySelector(".qo-label")!.textContent);
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(box(), { key: k, ...init });

function renderWithFocus() {
  const before = document.createElement("button");
  before.textContent = "grid";
  document.body.append(before);
  before.focus();
  const view = render(<Host from={false} />);
  return { before, ...view };
}

test("opens_with_focus_in_the_box_and_esc_puts_focus_back", () => {
  const { before } = renderWithFocus();
  expect(screen.getByRole("dialog", { name: "Quick Open" })).toBeTruthy();
  expect(document.activeElement).toBe(box());
  key("Escape");
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(before);
});

test("a_click_outside_closes", () => {
  renderWithFocus();
  fireEvent.pointerDown(screen.getByTestId("outside"));
  expect(props.onClose).toHaveBeenCalledTimes(1);
  // A click inside does not.
  render(<Host from={false} />);
  fireEvent.pointerDown(box());
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

test("an_empty_box_lists_recent_first_with_kind_and_connection", () => {
  renderWithFocus();
  expect(optionNames()).toEqual(["invoices", "Unpaid invoices", "daily_orders"]);
  expect(options()[0].textContent).toContain("recently opened");
  expect(options()[0].textContent).toContain("billing");
  expect(options()[0].textContent).toContain("shop_prod");
  expect(options()[0].textContent).toContain("PROD");
  expect(options()[1].textContent).toContain("Saved Query");
  // A closed Connection says so.
  expect(options()[2].textContent).toContain("closed");
  expect(selected()).toBe(options()[0]);
  expect(box().getAttribute("aria-activedescendant")).toBe(options()[0].id);
});

test("typing_filters_fuzzily_and_marks_the_letters", () => {
  renderWithFocus();
  type("inv");
  expect(optionNames()).toEqual(["invoices", "Unpaid invoices", "invoice_lines"]);
  for (const o of options()) expect([...o.querySelectorAll(".qo-label .qo-hit")].map((m) => m.textContent).join("")).toBe("inv");
  expect(options()[2].textContent).toContain("other results");
});

test("arrows_wrap_page_keys_jump_and_the_selection_stays_in_view", () => {
  renderWithFocus();
  type("e");
  const n = options().length;
  expect(n).toBeGreaterThan(20);
  key("ArrowUp");
  expect(selected()).toBe(options()[n - 1]);
  key("ArrowDown");
  expect(selected()).toBe(options()[0]);
  key("PageDown");
  expect(selected()).toBe(options()[9]);
  expect(scrolled[scrolled.length - 1]).toBe(options()[9]);
  key("PageUp");
  expect(selected()).toBe(options()[0]);
});

test("hover_only_highlights", () => {
  renderWithFocus();
  fireEvent.mouseEnter(options()[2]);
  fireEvent.mouseMove(options()[2]);
  expect(selected()).toBe(options()[0]);
});

test("enter_opens_the_selected_item_and_closes", () => {
  renderWithFocus();
  key("ArrowDown");
  key("Enter");
  expect(props.onOpen).toHaveBeenCalledWith(ALL[4], "enter");
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

test("a_click_on_a_row_opens_it", () => {
  renderWithFocus();
  fireEvent.click(options()[2]);
  expect(props.onOpen).toHaveBeenCalledWith(ALL[3], "enter");
});

test("right_arrow_at_the_end_opens_behind_and_the_list_stays", () => {
  renderWithFocus();
  type("inv");
  const input = box() as HTMLInputElement;
  input.setSelectionRange(1, 1);
  key("ArrowRight");
  expect(props.onOpen).not.toHaveBeenCalled();
  input.setSelectionRange(3, 3);
  key("ArrowRight");
  expect(props.onOpen).toHaveBeenCalledWith(ALL[1], "behind");
  expect(props.onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeTruthy();
  // Ctrl+Enter is not bound: it opens nothing.
  key("Enter", { ctrlKey: true });
  expect(props.onOpen).toHaveBeenCalledTimes(1);
});

test("gt_switches_to_commands_and_backspace_goes_back", () => {
  renderWithFocus();
  type(">");
  expect(screen.getByRole("dialog", { name: "Command Palette" })).toBeTruthy();
  // Recently used first, then A to Z; each with its key from the keymap.
  expect(optionNames()).toEqual(["Tree: Refresh schema", "Groups: Open Group 1", "Query: New query", "Tabs: Close tab"]);
  expect(options()[0].textContent).toContain("recently used");
  expect([...options()[0].querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["F5"]);
  expect(options()[1].textContent).toContain("Shop");
  type("");
  expect(screen.getByRole("dialog", { name: "Quick Open" })).toBeTruthy();
  expect(optionNames()[0]).toBe("invoices");
});

test("enter_on_a_command_puts_focus_back_then_runs_it", () => {
  let focusAtRun: Element | null = null;
  props.onRun = vi.fn(() => {
    focusAtRun = document.activeElement;
  });
  const { before } = renderWithFocus();
  type("> new q");
  key("Enter");
  expect(props.onRun).toHaveBeenCalledWith("query.new");
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(focusAtRun).toBe(before);
});

test("the_palette_opens_with_gt_typed_in", () => {
  props.initial = ">";
  renderWithFocus();
  expect((box() as HTMLInputElement).value).toBe(">");
  expect(screen.getByRole("dialog", { name: "Command Palette" })).toBeTruthy();
});

test("the_quick_open_key_in_the_box_moves_down_and_never_prints", () => {
  renderWithFocus();
  // fireEvent answers false when the default was prevented.
  expect(fireEvent.keyDown(box(), { key: "p", code: "KeyP", ctrlKey: true })).toBe(false);
  expect(selected()).toBe(options()[1]);
  // The palette key switches to the commands.
  key("P", { code: "KeyP", ctrlKey: true, shiftKey: true });
  expect((box() as HTMLInputElement).value).toBe(">");
});

test("empty_states_name_what_found_nothing", () => {
  renderWithFocus();
  type("zzz");
  expect(screen.getByRole("status").textContent).toBe("No matching results");
  key("Enter");
  expect(props.onOpen).not.toHaveBeenCalled();
  type(">zzz");
  expect(screen.getByRole("status").textContent).toBe("No matching commands");
});

test("question_mark_lists_the_prefixes", () => {
  renderWithFocus();
  type("?");
  expect(options()).toHaveLength(2);
  key("ArrowDown");
  key("Enter");
  expect((box() as HTMLInputElement).value).toBe(">");
});

// Polish A2: with no Connection open there is nothing to search, so say how to get something (VS Code hints when a provider is empty).
test("no_open_connection_hints_how_to_search_tables", () => {
  props = { ...props, all: [], noOpenConnection: true };
  renderWithFocus();
  type("zzz");
  expect(screen.getByRole("status").textContent).toBe("No matching results. Open a Connection to search its tables.");
  // The commands mode is not about tables.
  type(">zzz");
  expect(screen.getByRole("status").textContent).toBe("No matching commands");
});

test("no_open_connection_still_lists_saved_queries_and_diagrams", () => {
  props = { ...props, all: [item("Unpaid invoices", { id: "saved:q1", kind: "saved", qualifier: null, connection: shop }), item("order-flow", { id: "flow:f", kind: "flow", qualifier: null, connection: null })], noOpenConnection: true };
  renderWithFocus();
  type("unpaid");
  expect(screen.getAllByRole("option").length).toBe(1);
  expect(screen.queryByRole("status")).toBeNull();
});
