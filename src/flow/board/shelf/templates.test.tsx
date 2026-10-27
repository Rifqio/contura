// Task 6 (decisions 4, 12 and 14): the Shelf's template side, on the same fake icon source as shelf.test.tsx.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import type { IconEntry } from "../../../api/types";
import { exportPalette } from "../../../diagram/export/palette";
import { setIconTheme } from "../../icons";
import { routeInvoke } from "../../../test/invoke";
import { previewCacheSize } from "../catalog/preview";
import { BOARD_TEMPLATES, SINGLE_TEMPLATES } from "../catalog/templates";
import { KIND_HEAD } from "../chips";
import { basicCount, basicResults, makeShelfIconSource } from "./iconSource";
import Shelf from "./Shelf";
import { previewRenderCount } from "./TemplatesSide";
import { SHELF_DRAG_TYPE } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const FAKE: IconEntry[] = Array.from({ length: 40 }, (_, i) => ({ name: `cache-${i}`, set: "lucide", title: `cache ${i}`, licence: null, aliasOf: null }));
const source = makeShelfIconSource({ entries: () => Promise.resolve(FAKE), count: basicCount, results: basicResults, remember: () => {} });

/** The stylesheet gives each theme class its own tokens in the app; jsdom needs them stated. */
const style = document.createElement("style");
const vars = (tint: string) =>
  ["--c-bg-surface", "--c-bg-canvas", "--c-text", "--c-text-subtle", "--c-border", "--c-syn-type", "--c-syn-keyword", "--c-group-teal", "--c-group-teal-tint"]
    .map((v, i) => `${v}:#${tint}${i}${i}${i}${i}`)
    .join(";");
style.textContent = `.theme-light{${vars("a")}}.theme-dark{${vars("d")}}`;
document.head.appendChild(style);
afterAll(() => style.remove());

beforeEach(() => {
  routeInvoke({ icon_index: () => FAKE, icon: () => '<svg xmlns="http://www.w3.org/2000/svg"/>' });
});
afterEach(() => {
  cleanup();
  act(() => setIconTheme("light"));
});

function setup() {
  const onAdd = vi.fn();
  render(<Shelf id="shelf" host="board" frameKind={null} source={source} onAdd={onAdd} onClose={vi.fn()} />);
  const search = () => screen.getByRole("combobox") as HTMLInputElement;
  const side = () => screen.getByRole("listbox", { name: "Templates" });
  const names = () => within(side()).getAllByRole("option").map((o) => o.getAttribute("aria-label"));
  const active = () => {
    const id = search().getAttribute("aria-activedescendant");
    return id ? document.getElementById(id) : null;
  };
  const key = (k: string, init: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(search(), { key: k, ...init });
  const type = (v: string) => fireEvent.change(search(), { target: { value: v } });
  return { onAdd, search, side, names, active, key, type };
}

const FROM = ["From my database", "From Mermaid"];
const BOARDS = BOARD_TEMPLATES.map((b) => b.name);
const SINGLES = SINGLE_TEMPLATES.map((t) => t.name);

test("boards_then_singles_then_the_two_from_rows", () => {
  const s = setup();
  expect(screen.getByRole("heading", { name: /Start from a template/ }).textContent).toBe(`Start from a template ${BOARDS.length + SINGLES.length}`);
  expect(s.names()).toEqual([...BOARDS, ...SINGLES, ...FROM]);
  const row = within(s.side()).getByRole("option", { name: SINGLE_TEMPLATES[0].name });
  expect(row.textContent).toContain(KIND_HEAD[SINGLE_TEMPLATES[0].kind].name);
  expect(screen.getByText("Click adds it in the middle of the view, or drag it onto the board.")).toBeTruthy();
});

test("a_board_card_shows_its_preview_badge_and_frames", () => {
  const s = setup();
  const b = BOARD_TEMPLATES[0];
  const card = within(s.side()).getByRole("option", { name: b.name });
  expect(card.querySelectorAll("img.flow-shelf-preview-frame-image").length).toBe(b.frames.length);
  expect(within(card).getByText("Board")).toBeTruthy();
  const titles = b.frames.map((f) => /^diagram \w+ "([^"]*)"/.exec(f)![1]).join(" · ");
  expect(card.textContent).toContain(titles);
  expect(previewCacheSize()).toBe(BOARD_TEMPLATES.length);
  fireEvent.click(card);
  expect(s.onAdd).toHaveBeenCalledWith({ kind: "template", id: b.id });
});

test("filters_narrow_the_list", () => {
  const s = setup();
  const chips = within(screen.getByRole("radiogroup", { name: "Template filter" }));
  expect(chips.getAllByRole("radio").map((r) => r.textContent)).toEqual(["All", "Boards", "ERD", "Flow", "Cloud", "Sequence"]);
  fireEvent.click(chips.getByRole("radio", { name: "Boards" }));
  expect(s.names()).toEqual([...BOARDS, ...FROM]);
  fireEvent.click(chips.getByRole("radio", { name: "Cloud" }));
  const cloud = SINGLE_TEMPLATES.filter((t) => t.kind === "cloud").map((t) => t.name);
  expect(s.names()).toEqual([...cloud, ...FROM]);
  // A press on a chip must not take focus from the search.
  expect(fireEvent.mouseDown(chips.getByRole("radio", { name: "Boards" }))).toBe(false);
});

test("searching_filters_templates_and_hides_the_chips", () => {
  const s = setup();
  fireEvent.click(screen.getByRole("radio", { name: "Cloud" }));
  s.type("oauth");
  expect(screen.queryByRole("radiogroup", { name: "Template filter" })).toBeNull();
  expect(s.names()).toEqual(["OAuth sign-in", ...FROM]);
  s.type("");
  expect(screen.getByRole("radio", { name: "Cloud" }).getAttribute("aria-checked")).toBe("true");
});

test("the_from_rows_stay_and_never_drag", () => {
  const s = setup();
  for (const name of FROM) {
    const row = within(s.side()).getByRole("option", { name });
    expect(row.getAttribute("draggable")).toBe("false");
  }
  expect(within(s.side()).getByRole("option", { name: BOARDS[0] }).getAttribute("draggable")).toBe("true");
  const data = { setData: vi.fn(), effectAllowed: "" };
  fireEvent.dragStart(within(s.side()).getByRole("option", { name: SINGLES[0] }), { dataTransfer: data });
  expect(data.setData).toHaveBeenCalledWith(SHELF_DRAG_TYPE, JSON.stringify({ kind: "template", id: SINGLE_TEMPLATES[0].id }));
  fireEvent.click(within(s.side()).getByRole("option", { name: FROM[0] }));
  fireEvent.click(within(s.side()).getByRole("option", { name: FROM[1] }));
  expect(s.onAdd).toHaveBeenNthCalledWith(1, { kind: "fromDatabase" });
  expect(s.onAdd).toHaveBeenNthCalledWith(2, { kind: "fromMermaid" });
  s.type("zzzz-no-such");
  expect(s.names()).toEqual(FROM);
  s.type("kubernetes");
  expect(s.names().slice(-2)).toEqual(FROM);
});

test("tab_switches_sides_and_down_moves_in_the_list", () => {
  const s = setup();
  expect(s.active()?.getAttribute("aria-label")).toBe(KIND_HEAD.flow.name);
  s.key("Tab");
  expect(s.search().getAttribute("aria-controls")).toBe("shelf-templates");
  expect(s.active()?.getAttribute("aria-label")).toBe(BOARDS[0]);
  s.key("ArrowDown");
  expect(s.active()?.getAttribute("aria-label")).toBe(BOARDS[1]);
  s.key("End", { ctrlKey: true });
  expect(s.active()?.getAttribute("aria-label")).toBe("From Mermaid");
  s.key("Enter");
  expect(s.onAdd).toHaveBeenCalledWith({ kind: "fromMermaid" });
  expect(document.activeElement).toBe(s.search());
});

test("shift_tab_switches_back", () => {
  const s = setup();
  s.key("Tab");
  s.key("Tab", { shiftKey: true });
  expect(s.active()?.getAttribute("aria-label")).toBe(KIND_HEAD.flow.name);
  s.key("ArrowDown");
  expect(s.active()?.getAttribute("aria-label")).toBe(KIND_HEAD.er.name);
});

test("ctrl_page_down_steps_the_filter_on_the_right", () => {
  const s = setup();
  s.key("Tab");
  s.key("PageDown", { ctrlKey: true });
  expect(screen.getByRole("radio", { name: "Boards" }).getAttribute("aria-checked")).toBe("true");
  s.key("PageUp", { ctrlKey: true });
  s.key("PageUp", { ctrlKey: true });
  expect(screen.getByRole("radio", { name: "Sequence" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("tab", { name: /^Diagrams/ }).getAttribute("aria-selected")).toBe("true");
});

test("previews_follow_the_theme", () => {
  const s = setup();
  // Each frame's SVG, read back from its image's data URL.
  const svgs = () =>
    [...s.side().querySelectorAll(".flow-shelf-board")].map((c) =>
      [...c.querySelectorAll<HTMLImageElement>("img.flow-shelf-preview-frame-image")].map((v) => decodeURIComponent(v.getAttribute("src")!.split(",").slice(1).join(","))).join(""),
    );
  const light = svgs();
  expect(light).toHaveLength(BOARD_TEMPLATES.length);
  act(() => setIconTheme("dark"));
  const dark = svgs();
  const colour = exportPalette("dark").border;
  expect(colour).toMatch(/^#d/);
  dark.forEach((html, i) => {
    expect(html).not.toBe(light[i]);
    expect(html).toContain(colour);
  });
  expect(previewCacheSize()).toBeLessThanOrEqual(3);
  act(() => setIconTheme("light"));
  expect(previewCacheSize()).toBeLessThanOrEqual(3);
});

test("no_template_matches_says_so", () => {
  const s = setup();
  s.type("  qqqq ");
  expect(screen.getByText('No template matches "qqqq".')).toBeTruthy();
  expect(s.names()).toEqual(FROM);
});

test("tab_announces_the_side", () => {
  const s = setup();
  const live = () => screen.getByRole("status").textContent;
  expect(live()).toBe("");
  s.key("Tab");
  expect(live()).toBe("Templates");
  s.key("Tab", { shiftKey: true });
  expect(live()).toBe("Diagrams, icons and shapes");
});

test("typing_does_not_render_the_previews_again", () => {
  const s = setup();
  const before = previewRenderCount();
  // Whitespace changes the query but keeps every board, so no card unmounts.
  s.type(" ");
  s.type("  ");
  expect(s.names().slice(0, BOARDS.length)).toEqual(BOARDS);
  expect(previewRenderCount()).toBe(before);
});

test("a_board_preview_is_one_cached_image_url_a_frame_across_opens", () => {
  // m2: each open parsed every preview's SVG markup into the page and laid it out again (about 400 ms of a first open
  // in WebKitGTK). A preview is an image of one data URL a frame, the same string on every open: the WebView decodes it
  // once and the page holds no preview SVG.
  const b = BOARD_TEMPLATES[0];
  const srcs = () => {
    const card = screen.getByRole("option", { name: b.name });
    return [...card.querySelectorAll<HTMLImageElement>("img")].map((i) => i.getAttribute("src")!);
  };
  setup();
  const first = srcs();
  expect(first).toHaveLength(b.frames.length);
  for (const src of first) expect(src.startsWith("data:image/svg+xml")).toBe(true);
  expect(document.querySelector(".flow-shelf-preview svg")).toBeNull();
  cleanup();
  setup();
  expect(srcs()).toEqual(first);
});
