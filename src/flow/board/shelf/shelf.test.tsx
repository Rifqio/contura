// Task 5 (decisions 2 to 5 and 11): the Shelf alone, on a fake icon source of 4,600 entries passed as its `source`.
// The Core's `icon_index` is routed to the same pack, for the ink `useIcon` reads.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import type { IconEntry } from "../../../api/types";
import { DIAGRAM_KINDS } from "../../../lang/flow/model";
import shelfCss from "../../../styles/flow-shelf.css?raw";
import { routeInvoke } from "../../../test/invoke";
import { shapesOf } from "../../ShapePicker";
import { searchKinds } from "../catalog/search";
import { KIND_HEAD } from "../chips";
import { SKETCH_WORD } from "../sketches";
import Dialog from "../../../components/Dialog";
import { basicCount, basicResults, makeShelfIconSource, SHELF_ICON_LIMIT, type ShelfIconSource } from "./iconSource";
import Shelf from "./Shelf";
import { SHELF_TABS, type ShelfTabDef } from "./tabs";
import { SHELF_DRAG_TYPE, type ShelfTabProps } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

/** Every name holds an "a", so "a" matches the whole pack; one in eight is a database. */
const WORDS = ["database", "cache", "chart", "mail", "alarm", "table", "map", "camera"];
const FAKE: IconEntry[] = Array.from({ length: 4600 }, (_, i) => ({
  name: `${WORDS[i % WORDS.length]}-${i}`,
  set: "lucide",
  title: `${WORDS[i % WORDS.length]} ${i}`,
  licence: null,
  aliasOf: null,
}));
const DATA_ICONS = FAKE.filter((e) => e.name.includes("data")).length;

beforeEach(() => {
  routeInvoke({ icon_index: () => FAKE, icon: () => '<svg xmlns="http://www.w3.org/2000/svg"/>' });
});

/** A source over `entries`, as the app makes one. */
const sourceOf = (entries: () => Promise<IconEntry[]>): ShelfIconSource =>
  makeShelfIconSource({ entries, count: basicCount, results: basicResults, remember: () => {} });

/** The pick side's listbox; the template side has its own, tested in templates.test.tsx. */
const s_search = () => screen.getByRole("combobox") as HTMLInputElement;
const left = () => document.querySelector<HTMLElement>(".flow-shelf-list [role=listbox]")!;

function setup(props: Partial<Parameters<typeof Shelf>[0]> = {}) {
  props = { source: sourceOf(() => Promise.resolve(FAKE)), ...props };
  const onAdd = vi.fn();
  const onClose = vi.fn();
  const onDragStart = vi.fn();
  const onDragEnd = vi.fn();
  const parentKey = vi.fn();
  const view = (p: Partial<Parameters<typeof Shelf>[0]>) => (
    <div onKeyDown={parentKey}>
      <Shelf id="shelf" host="board" frameKind={null} onAdd={onAdd} onClose={onClose} onDragStart={onDragStart} onDragEnd={onDragEnd} {...p} />
    </div>
  );
  const utils = render(view(props));
  const search = () => screen.getByRole("combobox", { name: "Search diagrams, templates, icons and shapes" }) as HTMLInputElement;
  const active = () => {
    const id = search().getAttribute("aria-activedescendant");
    return id ? document.getElementById(id) : null;
  };
  const optionNames = (within_: HTMLElement = document.body) => within(within_).getAllByRole("option").map((o) => o.getAttribute("aria-label"));
  const type = (text: string) => fireEvent.change(search(), { target: { value: text } });
  const key = (k: string, init: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(search(), { key: k, ...init });
  return { ...utils, onAdd, onClose, onDragStart, onDragEnd, parentKey, search, active, optionNames, type, key, rerender: (p: Partial<Parameters<typeof Shelf>[0]>) => utils.rerender(view({ ...props, ...p })) };
}

/** Waits for the fake pack to load: the Icons tab shows its count. */
const loaded = () => screen.findByRole("tab", { name: "Icons, 4,600" });

test("it_opens_with_focus_in_search", () => {
  const s = setup();
  expect(document.activeElement).toBe(s.search());
  expect(s.search().placeholder).toBe("Search diagrams, templates and icons");
});

test("it_is_a_non_modal_dialog", () => {
  setup();
  const dialog = screen.getByRole("dialog", { name: "Add to the board" });
  expect(dialog.id).toBe("shelf");
  expect(dialog.hasAttribute("aria-modal")).toBe(false);
  expect(screen.getByRole("tablist", { name: "Pick" })).toBeTruthy();
});

test("diagrams_lists_nine_cards_in_spec_order", () => {
  const s = setup();
  const list = left();
  expect(s.optionNames(list)).toEqual(["flow", "er", "sequence", "cloud", "dfd", "state", "class", "mindmap", "timeline"].map((k) => KIND_HEAD[k as keyof typeof KIND_HEAD].name));
  expect(DIAGRAM_KINDS.length).toBe(9);
  expect(screen.getByRole("tab", { name: "Diagrams, 9" }).getAttribute("aria-selected")).toBe("true");
});

test("tabs_show_counts_with_commas", async () => {
  const s = setup();
  await loaded();
  expect(screen.getByRole("tab", { name: "Diagrams, 9" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Shapes, 5" })).toBeTruthy();
  s.rerender({ frameKind: "flow" });
  expect(screen.getByRole("tab", { name: `Shapes, ${shapesOf("flow").length + 5}` })).toBeTruthy();
});

test("loose_shapes_read_sketch_word", () => {
  const s = setup({ initialTab: "shapes" });
  expect(s.optionNames(left())).toEqual((["rect", "ellipse", "diamond", "note", "text"] as const).map((k) => SKETCH_WORD[k]));
  expect(screen.getByText("Loose shapes belong to no diagram. The Assistant reads them as notes on the board.")).toBeTruthy();
  expect(document.body.textContent).not.toContain("Sticky note");
});

test("left_and_right_edit_the_query", async () => {
  const s = setup();
  await loaded();
  const user = userEvent.setup();
  await user.type(s.search(), "dta");
  const before = s.search().getAttribute("aria-activedescendant");
  await user.keyboard("{ArrowLeft}{ArrowLeft}");
  expect(s.search().getAttribute("aria-activedescendant")).toBe(before);
  expect(s.search().selectionStart).toBe(1);
  await user.keyboard("a");
  expect(s.search().value).toBe("data");
});

test("up_and_down_move_in_reading_order_and_ctrl_home_end_jump", () => {
  const s = setup();
  expect(s.active()?.getAttribute("aria-label")).toBe(KIND_HEAD.flow.name);
  s.key("ArrowDown");
  expect(s.active()?.getAttribute("aria-label")).toBe(KIND_HEAD.er.name);
  s.key("ArrowDown");
  expect(s.active()?.getAttribute("aria-label")).toBe(KIND_HEAD.sequence.name);
  s.key("ArrowUp");
  expect(s.active()?.getAttribute("aria-label")).toBe(KIND_HEAD.er.name);
  s.key("End", { ctrlKey: true });
  expect(s.active()?.getAttribute("aria-label")).toBe(KIND_HEAD.timeline.name);
  s.key("Home", { ctrlKey: true });
  expect(s.active()?.getAttribute("aria-label")).toBe(KIND_HEAD.flow.name);
  expect(s.active()?.getAttribute("aria-selected")).toBe("true");
});

test("enter_adds_the_active_item", () => {
  const s = setup();
  s.key("ArrowDown");
  s.key("Enter");
  expect(s.onAdd).toHaveBeenCalledWith({ kind: "diagram", diagram: "er" });
});

test("a_click_adds_and_a_drag_carries_the_item", async () => {
  const s = setup();
  const card = screen.getByRole("option", { name: KIND_HEAD.flow.name });
  fireEvent.click(card);
  expect(s.onAdd).toHaveBeenCalledWith({ kind: "diagram", diagram: "flow" });
  const dt = { setData: vi.fn(), effectAllowed: "uninitialized", types: [] as string[] };
  fireEvent.dragStart(card, { dataTransfer: dt });
  expect(dt.setData).toHaveBeenCalledWith(SHELF_DRAG_TYPE, JSON.stringify({ kind: "diagram", diagram: "flow" }));
  expect(dt.effectAllowed).toBe("copy");
  expect(s.onDragStart).toHaveBeenCalledWith({ kind: "diagram", diagram: "flow" });
  const panel = screen.getByRole("dialog", { name: "Add to the board" });
  await waitFor(() => expect(panel.hasAttribute("data-dragging")).toBe(true));
  fireEvent.dragEnd(card);
  expect(s.onDragEnd).toHaveBeenCalled();
  expect(panel.hasAttribute("data-dragging")).toBe(false);
});

test("the_drag_fade_rule_exists", () => {
  const rule = /\.flow-shelf\[data-dragging\]\s*\{([^}]*)\}/.exec(shelfCss);
  expect(rule).not.toBeNull();
  expect(rule![1]).toMatch(/opacity:\s*0\.2;/);
  expect(rule![1]).toMatch(/pointer-events:\s*none;/);
});

test("searching_groups_the_left_side", async () => {
  const s = setup();
  await loaded();
  s.type("data");
  const list = left();
  const groups = within(list).getAllByRole("group");
  expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Diagrams", "Icons"]);
  for (const t of screen.getAllByRole("tab")) expect(t.getAttribute("aria-selected")).toBe("false");
  expect(screen.getByRole("tab", { name: `Diagrams, ${searchKinds("data").length}` })).toBeTruthy();
  expect(screen.getByRole("tab", { name: `Icons, ${DATA_ICONS.toLocaleString("en-US")}` })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Shapes, 0" })).toBeTruthy();
  expect(document.querySelector("[data-shelf-body]")).toBeNull();
});

test("the_grouped_list_handles_keys_itself", async () => {
  const handler = vi.fn(() => false);
  const registered = vi.fn();
  function Spy(p: ShelfTabProps) {
    useEffect(() => {
      registered();
      p.registerKeys(handler);
    }, [p]);
    return <div role="listbox" aria-label="Spy" />;
  }
  const tabs: ShelfTabDef[] = SHELF_TABS.map((t) => ({ ...t, Body: Spy }));
  const s = setup({ tabs });
  await loaded();
  s.type("data");
  handler.mockClear();
  registered.mockClear();
  s.key("ArrowDown");
  s.key("Enter");
  expect(handler).not.toHaveBeenCalled();
  expect(registered).not.toHaveBeenCalled();
  const kinds = searchKinds("data");
  expect(s.onAdd).toHaveBeenCalledWith({ kind: "diagram", diagram: kinds[1] });
});

test("the_icons_group_caps_at_24_and_show_all_pins_the_icons_tab", async () => {
  const seen: ShelfTabProps[] = [];
  function IconsSpy(p: ShelfTabProps) {
    seen.push(p);
    return <div role="listbox" aria-label="Icons spy" />;
  }
  const tabs: ShelfTabDef[] = SHELF_TABS.map((t) => (t.id === "icons" ? { ...t, Body: IconsSpy } : t));
  const s = setup({ tabs });
  await loaded();
  s.type("a");
  const icons = within(left()).getByRole("group", { name: "Icons" });
  const options = within(icons).getAllByRole("option");
  expect(options.length).toBe(25);
  expect(options[24].textContent).toBe("Show all 4,600 icons");
  for (let i = 0; i < 100 && s.active() !== options[24]; i++) s.key("ArrowDown");
  expect(s.active()).toBe(options[24]);
  s.key("Enter");
  expect(s.onAdd).not.toHaveBeenCalled();
  expect(seen[seen.length - 1]?.query).toBe("a");
  expect(screen.getByRole("tab", { name: "Icons, 4,600" }).getAttribute("aria-selected")).toBe("true");
});

test("down_crosses_groups_and_skips_headings", async () => {
  const s = setup();
  await loaded();
  s.type("data");
  const list = left();
  const [diagrams, icons] = within(list).getAllByRole("group");
  const n = within(diagrams).getAllByRole("option").length;
  expect(s.active()).toBe(within(diagrams).getAllByRole("option")[0]);
  for (let i = 0; i < n; i++) s.key("ArrowDown");
  expect(s.active()).toBe(within(icons).getAllByRole("option")[0]);
  s.key("ArrowUp");
  expect(s.active()).toBe(within(diagrams).getAllByRole("option")[n - 1]);
});

test("icons_before_plan_c_show_48_and_say_so", async () => {
  const s = setup();
  await loaded();
  fireEvent.click(screen.getByRole("tab", { name: "Icons, 4,600" }));
  const list = await screen.findByRole("listbox", { name: "Icons" });
  expect(within(list).getAllByRole("option").length).toBe(SHELF_ICON_LIMIT);
  expect(screen.getByText("Showing 48 of 4,600. Type to narrow.")).toBeTruthy();
  // A to Z with nothing typed.
  const names = within(list).getAllByRole("option").map((o) => o.getAttribute("data-name")!);
  expect(names).toEqual([...names].sort());
  expect(document.activeElement).toBe(s.search());
});

test("esc_clears_then_closes_and_stops_there", () => {
  const s = setup();
  s.type("flow");
  s.key("Escape");
  expect(s.search().value).toBe("");
  expect(s.onClose).not.toHaveBeenCalled();
  s.key("Escape");
  expect(s.onClose).toHaveBeenCalledWith("escape");
  expect(s.parentKey).not.toHaveBeenCalled();
});

test("ctrl_page_down_steps_the_tab_before_the_body_sees_it", () => {
  const handler = vi.fn(() => false);
  function Spy(p: ShelfTabProps) {
    useEffect(() => p.registerKeys(handler), [p]);
    return <div role="listbox" aria-label="Spy" />;
  }
  const tabs: ShelfTabDef[] = SHELF_TABS.map((t) => ({ ...t, Body: Spy }));
  const s = setup({ tabs });
  const selected = () => screen.getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")!.textContent;
  expect(selected()).toContain("Diagrams");
  s.key("PageDown", { ctrlKey: true });
  expect(selected()).toContain("Icons");
  s.key("PageDown", { ctrlKey: true });
  expect(selected()).toContain("Shapes");
  s.key("PageUp", { ctrlKey: true });
  expect(selected()).toContain("Icons");
  expect(handler).not.toHaveBeenCalled();
  s.key("ArrowDown");
  expect(handler).toHaveBeenCalledTimes(1);
});

test("the_shapes_tab_puts_the_frame_kind_first", () => {
  setup({ initialTab: "shapes", frameKind: "flow" });
  const groups = within(left()).getAllByRole("group");
  expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([`${KIND_HEAD.flow.name} shapes`, "Loose shapes"]);
  expect(within(groups[0]).getAllByRole("option").map((o) => o.getAttribute("aria-label"))).toEqual(shapesOf("flow").map((sh) => sh.label));
  // Code text in the Shelf is the shape's .flow line, as typed.
  expect(groups[0].querySelector("code")?.textContent).toBe(shapesOf("flow")[0].code);
});

test("a_shape_hint_is_its_tip_and_description_unless_disabled", () => {
  // B3 R22, A8: a shape that says what it does shows its hint as its tip and description; its <code> keeps its line.
  const view = setup({ initialTab: "shapes", frameKind: "er" });
  const column = within(within(left()).getAllByRole("group")[0]).getByRole("option", { name: "Column" });
  expect(column.getAttribute("title")).toBe("Opens a new column row on the table");
  expect(column.getAttribute("aria-description")).toBe("Opens a new column row on the table");
  expect(column.querySelector("code")?.textContent).toBe("id int");
  // Disabled, the reason takes its place.
  view.rerender({ disabled: (item) => (item.kind === "shape" && item.label === "Column" ? "Select a table first" : null) });
  const off = within(within(left()).getAllByRole("group")[0]).getByRole("option", { name: "Column" });
  expect(off.getAttribute("title")).toBe("Select a table first");
  expect(off.getAttribute("aria-description")).toBe("Select a table first");
});

test("only_node_shapes_drag", () => {
  setup({ initialTab: "shapes", frameKind: "flow" });
  const group = within(left()).getAllByRole("group")[0];
  for (const sh of shapesOf("flow")) {
    const opt = within(group).getByRole("option", { name: sh.label });
    expect(opt.getAttribute("draggable")).toBe(sh.act.kind === "node" ? "true" : "false");
  }
  expect(screen.getByRole("option", { name: "Rectangle" }).getAttribute("draggable")).toBe("true");
});

test("the_tab_registry_drives_the_tabs", () => {
  const seen: ShelfTabProps[] = [];
  function Fake(p: ShelfTabProps) {
    seen.push(p);
    return <div role="listbox" aria-label="Fake list" />;
  }
  const tabs: ShelfTabDef[] = [...SHELF_TABS, { id: "fake", label: "Fake", icon: "sparkles", count: () => 1234, Body: Fake }];
  const s = setup({ tabs, frameKind: "er" });
  fireEvent.click(screen.getByRole("tab", { name: "Fake, 1,234" }));
  expect(screen.getByRole("listbox", { name: "Fake list" })).toBeTruthy();
  const p = seen[seen.length - 1]!;
  expect(p.query).toBe("");
  expect(p.active).toBe(true);
  expect(p.frameKind).toBe("er");
  for (const f of [p.registerKeys, p.add, p.beginDrag]) expect(typeof f).toBe("function");
  act(() => p.add({ kind: "icon", name: "map-6" }));
  expect(s.onAdd).toHaveBeenCalledWith({ kind: "icon", name: "map-6" });
  act(() => p.setActiveDescendant?.("x-1"));
  expect(s.search().getAttribute("aria-activedescendant")).toBe("x-1");
});

test("nothing_matches_says_so", async () => {
  const s = setup();
  await loaded();
  s.type("zzzz");
  expect(screen.getByText('Nothing here matches "zzzz".')).toBeTruthy();
  expect(within(document.querySelector<HTMLElement>(".flow-shelf-list")!).queryAllByRole("option")).toEqual([]);
  expect(s.search().hasAttribute("aria-activedescendant")).toBe(false);
});

test("the_new_host_shows_diagrams_and_templates_and_nothing_drags", () => {
  setup({ host: "new" });
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.getByRole("heading", { name: "Diagrams" })).toBeTruthy();
  expect(within(left()).getAllByRole("option").length).toBe(9);
  expect(screen.getByRole("listbox", { name: "Templates" })).toBeTruthy();
  for (const o of screen.getAllByRole("option")) expect(o.getAttribute("draggable")).toBe("false");
});

test("the_new_host_keeps_its_initial_query_and_reports_the_typed_one", () => {
  const onQuery = vi.fn();
  setup({ host: "new", initialQuery: "flow", onQuery });
  expect(s_search().value).toBe("flow");
  fireEvent.change(s_search(), { target: { value: "er" } });
  expect(onQuery).toHaveBeenLastCalledWith("er");
});

test("the_new_host_tab_switches_sides_without_reaching_its_dialog", () => {
  const onAdd = vi.fn();
  const closeDialog = vi.fn();
  render(
    <Dialog title="New diagram" onClose={closeDialog}>
      <Shelf id="catalog" host="new" frameKind={null} source={sourceOf(() => Promise.resolve(FAKE))} onAdd={onAdd} onClose={() => {}} />
    </Dialog>,
  );
  const search = screen.getByRole("combobox");
  fireEvent.keyDown(search, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(search);
  fireEvent.keyDown(search, { key: "Enter" });
  expect(onAdd.mock.calls[0][0]).toMatchObject({ kind: "template" });
});

test("a_press_outside_closes_it_but_not_a_press_on_its_opener", () => {
  const opener = document.createElement("button");
  opener.setAttribute("aria-controls", "shelf");
  document.body.append(opener);
  const s = setup();
  fireEvent.pointerDown(opener);
  expect(s.onClose).not.toHaveBeenCalled();
  fireEvent.pointerDown(screen.getByRole("tab", { name: /^Shapes/ }));
  expect(s.onClose).not.toHaveBeenCalled();
  fireEvent.pointerDown(document.body);
  expect(s.onClose).toHaveBeenCalledWith("outside");
  const sub = document.createElement("div");
  sub.setAttribute("data-sublayer", "");
  document.body.append(sub);
  s.onClose.mockClear();
  fireEvent.pointerDown(sub);
  expect(s.onClose).not.toHaveBeenCalled();
  sub.remove();
  opener.remove();
});

test("shelf_code_text_has_no_ligatures", () => {
  const rule = /\.flow-shelf code\s*\{([^}]*)\}/.exec(shelfCss);
  expect(rule).not.toBeNull();
  expect(rule![1]).toMatch(/font-variant-ligatures:\s*none;/);
});

test("one_source_drives_the_count_the_tab_and_the_search", async () => {
  const hundred = FAKE.slice(0, 100);
  const s = setup({ source: sourceOf(() => Promise.resolve(hundred)) });
  fireEvent.click(await screen.findByRole("tab", { name: "Icons, 100" }));
  const list = await screen.findByRole("listbox", { name: "Icons" });
  expect(within(list).getAllByRole("option").length).toBe(48);
  expect(screen.getByText("Showing 48 of 100. Type to narrow.")).toBeTruthy();
  s.key("Escape");
  fireEvent.click(screen.getByRole("tab", { name: "Diagrams, 9" }));
  s.type("a");
  const icons = within(left()).getByRole("group", { name: "Icons" });
  expect(within(icons).getAllByRole("option").slice(-1)[0]?.textContent).toBe("Show all 100 icons");
  expect(screen.getByRole("tab", { name: "Icons, 100" })).toBeTruthy();
});

test("the_icons_tab_says_when_it_is_reading_and_when_the_read_fails", async () => {
  setup({ source: sourceOf(() => new Promise<IconEntry[]>(() => {})), initialTab: "icons" });
  expect(screen.getByRole("tab", { name: "Icons" })).toBeTruthy();
  expect(screen.getByText("Reading the icon list")).toBeTruthy();
  cleanup();
  setup({ source: sourceOf(() => Promise.reject(new Error("the icon pack is damaged"))), initialTab: "icons" });
  expect((await screen.findByRole("alert")).textContent).toBe("Couldn't read the icon list.");
  expect(screen.getByRole("tab", { name: "Icons" })).toBeTruthy();
});

test("a_press_on_a_heading_keeps_focus_in_the_search", () => {
  const s = setup({ initialTab: "shapes" });
  const heading = screen.getByText("Loose shapes");
  expect(fireEvent.mouseDown(heading)).toBe(false);
  expect(fireEvent.mouseDown(screen.getByText(/^Loose shapes belong/))).toBe(false);
  expect(fireEvent.mouseDown(s.search())).toBe(true);
  expect(document.activeElement).toBe(s.search());
  s.key("Escape");
  expect(s.onClose).toHaveBeenCalledWith("escape");
  expect(s.parentKey).not.toHaveBeenCalled();
});

test("ctrl_enter_and_an_ime_enter_are_not_list_keys", () => {
  const s = setup();
  s.key("Enter", { ctrlKey: true });
  expect(s.onAdd).not.toHaveBeenCalled();
  expect(s.parentKey).toHaveBeenCalledTimes(1);
  expect(s.parentKey.mock.calls[0][0].nativeEvent.defaultPrevented).toBe(false);
  s.key("Enter", { isComposing: true });
  s.key("Enter", { keyCode: 229 });
  expect(s.onAdd).not.toHaveBeenCalled();
});

test("the_new_host_leaves_esc_to_its_dialog", () => {
  const closeDialog = vi.fn();
  const onClose = vi.fn();
  render(
    <Dialog title="New diagram" onClose={closeDialog}>
      <Shelf id="catalog" host="new" frameKind={null} source={sourceOf(() => Promise.resolve(FAKE))} onAdd={() => {}} onClose={onClose} />
    </Dialog>,
  );
  const search = screen.getByRole("combobox");
  fireEvent.change(search, { target: { value: "flow" } });
  fireEvent.keyDown(search, { key: "Escape" });
  expect((search as HTMLInputElement).value).toBe("");
  expect(closeDialog).not.toHaveBeenCalled();
  fireEvent.keyDown(search, { key: "Escape" });
  expect(closeDialog).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
});

test("the_search_controls_the_listbox", async () => {
  const s = setup();
  const controlled = () => document.getElementById(s.search().getAttribute("aria-controls")!);
  expect(controlled()?.getAttribute("role")).toBe("listbox");
  expect(controlled()?.getAttribute("aria-label")).toBe("Diagrams");
  await loaded();
  s.type("data");
  expect(controlled()?.getAttribute("role")).toBe("listbox");
  expect(controlled()?.getAttribute("aria-label")).toBe("Results");
});

test("ctrl_page_keys_pin_a_tab_while_searching", async () => {
  const s = setup();
  await loaded();
  s.type("data");
  s.key("PageDown", { ctrlKey: true });
  expect(screen.getByRole("tab", { name: /^Diagrams/ }).getAttribute("aria-selected")).toBe("true");
  expect(document.querySelector("[data-shelf-body]")).not.toBeNull();
  expect(s.search().value).toBe("data");
  s.key("PageDown", { ctrlKey: true });
  expect(screen.getByRole("tab", { name: /^Icons/ }).getAttribute("aria-selected")).toBe("true");
  expect(within(screen.getByRole("listbox", { name: "Icons" })).getAllByRole("option").length).toBe(Math.min(48, DATA_ICONS));
  s.key("Escape");
  s.type("data");
  expect(document.querySelector("[data-shelf-body]")).toBeNull();
  s.key("PageUp", { ctrlKey: true });
  expect(screen.getByRole("tab", { name: "Shapes, 0" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByText('Nothing here matches "data".')).toBeTruthy();
});

test("a_press_on_a_draggable_tile_lets_the_drag_start_and_focus_comes_back_to_the_search", async () => {
  // WebKit starts no HTML drag from a mousedown whose default was prevented (m2: icon tiles never dragged). A tile
  // that drags keeps its mousedown; the search takes focus back when the press ends (decision 3, one focus owner).
  const s = setup({ initialTab: "icons" });
  const tile = (await within(screen.getByRole("listbox")).findAllByRole("option")).find((o) => o.getAttribute("draggable") === "true")!;
  expect(tile).toBeTruthy();
  expect(fireEvent.mouseDown(tile)).toBe(true);
  (document.activeElement as HTMLElement | null)?.blur();
  fireEvent.mouseUp(tile);
  expect(document.activeElement).toBe(s.search());
  // A drag ends the same way.
  fireEvent.mouseDown(tile);
  (document.activeElement as HTMLElement | null)?.blur();
  fireEvent.dragEnd(tile);
  expect(document.activeElement).toBe(s.search());
  // A tile that does not drag still keeps focus from moving at all.
  cleanup();
  const n = setup({ host: "new" });
  const still = within(screen.getAllByRole("listbox")[0]).getAllByRole("option")[0];
  expect(still.getAttribute("draggable")).not.toBe("true");
  expect(fireEvent.mouseDown(still)).toBe(false);
  void n;
});

test("initial_side_right_opens_on_the_templates", () => {
  // Plan D A11: the assistant's Template opens the board Shelf on its templates side.
  const s = setup({ initialSide: "right" });
  const dialog = screen.getByRole("dialog", { name: "Add to the board" });
  expect(dialog.getAttribute("data-side")).toBe("right");
  expect(document.activeElement).toBe(s.search());
  const templates = screen.getByRole("listbox", { name: "Templates" });
  expect(s.search().getAttribute("aria-controls")).toBe(templates.id);
  // Enter adds a template; Tab goes back to the pick side as before.
  s.key("Enter");
  expect(s.onAdd.mock.calls[0][0]).toMatchObject({ kind: "template" });
  s.key("Tab");
  expect(dialog.getAttribute("data-side")).toBe("left");
});
