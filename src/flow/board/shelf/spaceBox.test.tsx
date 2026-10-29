// Task 11 (decision 19, R14, R16, R23, R26): the Space box. A Space tap or `/` over the canvas opens a small search at
// the pointer; Enter drops the pick at the crosshair; Tab grows it into the Shelf with the search kept.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { IconEntry } from "../../../api/types";
import type { DiagramCanvasProps } from "../../../diagram/DiagramCanvas";
import { LangClient } from "../../../lang/client";
import { mockEditorDom } from "../../../test/editor";
import { routeInvoke } from "../../../test/invoke";
import { fakeWorker } from "../../../test/langWorker";
import { patientFile } from "../../../test/load";
import { mockReactFlowDom } from "../../../test/reactFlow";
import { EDIT_MESSAGES } from "../../editWords";
import FlowTab from "../../FlowTab";
import { boardFrameId } from "../boardScene";
import { SHELF_KINDS } from "../catalog/kinds";
import { searchKinds, searchTemplates } from "../catalog/search";
import { BOARD_TEMPLATES } from "../catalog/templates";
import { KIND_HEAD, KIND_ICON } from "../chips";
import { basicCount, basicResults, makeShelfIconSource, type ShelfIconSource } from "./iconSource";
import type SpaceBoxType from "./SpaceBox";
import SpaceBox, { placeBox } from "./SpaceBox";
import shelfCss from "../../../styles/flow-shelf.css?raw";
import { spaceResults } from "./spaceResults";
import type { ShelfItem } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
patientFile();

const canvas = vi.hoisted(() => ({ props: null as DiagramCanvasProps | null, instance: null as ReactFlowInstance | null }));
vi.mock("../../../diagram/DiagramCanvas", async (load) => {
  const real = await load<typeof import("../../../diagram/DiagramCanvas")>();
  return {
    ...real,
    default: (p: DiagramCanvasProps) => {
      canvas.props = p;
      return real.default({
        ...p,
        onInit: (i) => {
          canvas.instance = i;
          p.onInit?.(i);
        },
      });
    },
  };
});
type BoxProps = Parameters<typeof SpaceBoxType>[0];
const spaceBox = vi.hoisted(() => ({ props: null as BoxProps | null }));
vi.mock("./SpaceBox", async (load) => {
  const real = await load<typeof import("./SpaceBox")>();
  return {
    ...real,
    default: (p: BoxProps) => {
      spaceBox.props = p;
      return real.default(p);
    },
  };
});
const lock = vi.hoisted(() => ({ on: false }));
vi.mock("../../ai/useBoardAsk", async (load) => {
  const real = await load<typeof import("../../ai/useBoardAsk")>();
  return {
    ...real,
    useBoardAsk: (...a: Parameters<typeof real.useBoardAsk>) => {
      const r = real.useBoardAsk(...a);
      return lock.on ? { ...r, locked: true } : r;
    },
  };
});

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
});
beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  canvas.props = null;
  canvas.instance = null;
  spaceBox.props = null;
  lock.on = false;
});

const ICONS: IconEntry[] = [
  { name: "aws-lambda", set: "aws", title: "Lambda", licence: null, aliasOf: null },
  { name: "azure-functions", set: "azure", title: "Functions", licence: null, aliasOf: null },
  { name: "database", set: "lucide", title: "Database", licence: null, aliasOf: null },
  { name: "gcp-state-store", set: "gcp", title: "State store", licence: null, aliasOf: null },
  { name: "k8s-pod", set: "k8s", title: "Pod", licence: null, aliasOf: null },
  { name: "postgresql", set: "simple", title: "PostgreSQL", licence: null, aliasOf: null },
  { name: "state-chart", set: "tabler", title: "State chart", licence: null, aliasOf: null },
];

/** An icon source over `ICONS`, already loaded. */
async function loadedIcons(): Promise<ShelfIconSource> {
  const icons = makeShelfIconSource({ entries: () => Promise.resolve(ICONS), count: basicCount, results: basicResults, remember: () => {} });
  await icons.load();
  return icons;
}

const CHECKOUT = 'diagram flow "Checkout"\nCart\nPay\nCart > Pay\n';
const LOGIN = 'diagram sequence "Login"\nApp -> Api\n';
const BOARD = [CHECKOUT, LOGIN].join("\n");
const LAYOUT = JSON.stringify({
  version: 2,
  frames: {
    Checkout: { at: { x: 0, y: 0 }, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
    Login: { at: { x: 700, y: 0 }, nodes: {}, style: "modern", direction: "TB" },
  },
  sketches: [],
});

type Pt = { x: number; y: number };

function setup(text = BOARD, layout: string | null = LAYOUT) {
  const saved = { text, layout };
  routeInvoke({
    read_diagram: () => saved,
    write_diagram: (a) => {
      saved.text = a.text as string;
      saved.layout = a.layout as string;
      return null;
    },
    write_diagram_layout: (a) => {
      saved.layout = a.layout as string;
      return null;
    },
    icon_index: () => ICONS,
    icon: () => '<svg xmlns="http://www.w3.org/2000/svg"/>',
  });
  const client = new LangClient(() => fakeWorker());
  const view = () => (
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={client} />
    </div>
  );
  const utils = render(view());
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const bar = () => screen.getByRole("toolbar", { name: "Board tools" });
  const tool = (name: string) => within(bar()).getByRole("button", { name });
  const pressed = () => within(bar()).getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("aria-label"));
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const shelf = () => screen.queryByRole("dialog", { name: "Add to the board" });
  const box = () => screen.queryByRole("dialog", { name: "Add here" });
  const layoutNow = () => JSON.parse(saved.layout ?? '{"frames":{},"sketches":[]}');
  const toast = () => utils.container.querySelector(".flow-toast");
  const isSelected = (title: string) => screen.queryAllByRole("button", { name: new RegExp(` ${title}$`) }).some((b) => b.getAttribute("aria-current") === "true");
  /** The canvas laid out at (left, top), 800 by 600. */
  const sized = (left = 0, top = 0, height = 600) =>
    vi.spyOn(canvasEl(), "getBoundingClientRect").mockReturnValue({ left, top, right: left + 800, bottom: top + height, width: 800, height, x: left, y: top, toJSON() {} } as DOMRect);
  /** Date.now under the test's hand, for Space's tap timing. */
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  /** A Space tap with the pointer at `p` on screen: under `SPACE_TAP_MS`, the pointer still. */
  const tap = (p: Pt) => {
    fireEvent.pointerMove(canvasEl(), { clientX: p.x, clientY: p.y });
    press(" ");
    now += 100;
    fireEvent.keyUp(canvasEl(), { key: " " });
  };
  /** The open box, its search focused. */
  const openBox = async (p: Pt = { x: 420, y: 330 }) => {
    tap(p);
    const b = await screen.findByRole("dialog", { name: "Add here" });
    await waitFor(() => expect(document.activeElement).toBe(within(b).getByRole("combobox")));
    return b;
  };
  return { ...utils, view, saved, canvasEl, bar, tool, pressed, press, shelf, box, layoutNow, toast, isSelected, sized, tap, openBox };
}
type Setup = ReturnType<typeof setup>;

async function opened() {
  for (const n of ["Flowchart Checkout", "Sequence Login"]) await screen.findByRole("button", { name: n });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
}

async function pickFrame(s: Setup, title: string) {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(` ${title}$`) }));
  await waitFor(() => expect(s.isSelected(title)).toBe(true));
  // Live, not only drawn selected: its box holds no static shape any more.
  await waitFor(() => expect(canvas.props!.nodes.some((n) => n.parentId === boardFrameId(title))).toBe(false));
}

const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const optionNames = (el: HTMLElement) => within(el).queryAllByRole("option").map((o) => o.getAttribute("aria-label"));

// ----- opening

test("slash_over_the_canvas_opens_the_box_and_elsewhere_the_shelf", async () => {
  const s = setup();
  await opened();
  // The pointer off the canvas: `/` opens the Shelf, as Add does.
  s.press("/");
  expect(await screen.findByRole("dialog", { name: "Add to the board" })).toBeTruthy();
  expect(s.box()).toBeNull();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(s.shelf()).toBeNull());
  // Over the canvas: the Space box, and no Shelf.
  fireEvent.pointerMove(s.canvasEl(), { clientX: 300, clientY: 200 });
  s.press("/");
  const box = await screen.findByRole("dialog", { name: "Add here" });
  expect(box.getAttribute("aria-modal")).toBeNull();
  expect(s.shelf()).toBeNull();
});

test("the_box_disarms_an_armed_tool", async () => {
  const s = setup();
  await opened();
  s.press("r");
  expect(s.pressed()).toEqual(["Rectangle"]);
  const box = await s.openBox();
  expect(s.pressed()).toEqual(["Select"]);
  // Enter adds the pick (Flowchart, first with nothing typed), never a rectangle.
  fireEvent.keyDown(within(box).getByRole("combobox"), { key: "Enter" });
  await waitFor(() => expect(s.saved.text).toContain('diagram flow "Flowchart"'));
  expect(s.layoutNow().sketches ?? []).toHaveLength(0);
});

// ----- what it lists

test("nothing_typed_shows_three_kinds_a_board_and_four_icons", async () => {
  const icons = await loadedIcons();
  const rows = spaceResults("", icons);
  const top4 = icons.top("", 4);
  expect(rows.map((r) => r.name)).toEqual([...SHELF_KINDS.slice(0, 3).map((k) => KIND_HEAD[k].name), BOARD_TEMPLATES[0].name, ...top4.map((h) => h.title)]);
  expect(BOARD_TEMPLATES[0].name).toBe("Online shop");
  expect(rows.map((r) => r.tag)).toEqual(["Diagram", "Diagram", "Diagram", "Board template", "AWS icon", "Azure icon", "Icon", "Google Cloud icon"]);
  expect(rows[0]).toEqual({ item: { kind: "diagram", diagram: "flow" }, name: KIND_HEAD.flow.name, tag: "Diagram", icon: { app: KIND_ICON.flow } });
  expect(rows[3].item).toEqual({ kind: "template", id: BOARD_TEMPLATES[0].id });
  expect(rows[4]).toEqual({ item: { kind: "icon", name: "aws-lambda" }, name: "Lambda", tag: "AWS icon", icon: { pack: "aws-lambda" } });

  render(<SpaceBox at={{ x: 100, y: 100 }} bounds={{ w: 800, h: 600 }} initialQuery="" icons={icons} onPick={() => {}} onShelf={() => {}} onClose={() => {}} />);
  const box = screen.getByRole("dialog", { name: "Add here" });
  expect(optionNames(box)).toEqual(rows.map((r) => r.name));
  expect(within(box).getByRole("listbox").textContent).toContain("Board template");
});

test("typing_mixes_kinds_templates_and_icons_up_to_8", async () => {
  const icons = await loadedIcons();
  const order = (tag: string) => (tag === "Diagram" ? 0 : tag === "Board template" ? 1 : tag.endsWith(" template") ? 2 : 3);
  for (const q of ["state", "flow", "data", "a", "Shop", "pod"]) {
    const rows = spaceResults(q, icons);
    const kinds = searchKinds(q);
    const { boards, singles } = searchTemplates(q, "all");
    const want = [
      ...kinds.map((k) => KIND_HEAD[k].name),
      ...boards.map((b) => b.name),
      ...singles.map((t) => t.name),
      ...icons.top(q, 8).map((h) => h.title),
    ].slice(0, 8);
    expect(rows.map((r) => r.name), q).toEqual(want);
    expect(rows.length).toBeLessThanOrEqual(8);
    // Kinds, then board templates, then single templates, then icons.
    const ranks = rows.map((r) => order(r.tag));
    expect(ranks, q).toEqual([...ranks].sort((a, b) => a - b));
  }
  // "state" holds all three: the kind, its template, and icons.
  const tags = spaceResults("state", icons).map((r) => r.tag);
  expect(tags[0]).toBe("Diagram");
  expect(tags).toContain(`${KIND_HEAD.state.name} template`);
  expect(tags).toContain("Google Cloud icon");
  expect(tags).toContain("Icon");
  expect(spaceResults("state", icons).find((r) => r.tag === `${KIND_HEAD.state.name} template`)!.icon).toEqual({ app: KIND_ICON.state });
  // Sets name their icons: Kubernetes and logos.
  expect(spaceResults("pod", icons).find((r) => r.name === "Pod")!.tag).toBe("Kubernetes icon");
  expect(spaceResults("postgre", icons).find((r) => r.name === "PostgreSQL")!.tag).toBe("Logo");
  // A query with many hits stops at 8.
  expect(spaceResults("a", icons)).toHaveLength(8);
});

// ----- its keys

test("up_and_down_wrap", async () => {
  const icons = await loadedIcons();
  const onPick = vi.fn();
  render(<SpaceBox at={{ x: 100, y: 100 }} bounds={{ w: 800, h: 600 }} initialQuery="" icons={icons} onPick={onPick} onShelf={() => {}} onClose={() => {}} />);
  const box = screen.getByRole("dialog", { name: "Add here" });
  const input = within(box).getByRole("combobox");
  const options = within(box).getAllByRole("option");
  const active = () => input.getAttribute("aria-activedescendant");
  expect(document.activeElement).toBe(input);
  expect(active()).toBe(options[0].id);
  expect(options[0].getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(active()).toBe(options[options.length - 1].id);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(active()).toBe(options[0].id);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(active()).toBe(options[1].id);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onPick).toHaveBeenCalledWith({ kind: "diagram", diagram: SHELF_KINDS[1] } satisfies ShelfItem);
  // A click picks too.
  fireEvent.click(options[3]);
  expect(onPick).toHaveBeenLastCalledWith({ kind: "template", id: BOARD_TEMPLATES[0].id });
});

test("enter_drops_at_the_crosshair", async () => {
  const s = setup();
  await opened();
  s.sized();
  const box = await s.openBox({ x: 420, y: 330 });
  // The crosshair is drawn at the pointer, hidden from assistive tech.
  const cross = s.container.querySelector(".flow-space-cross") as HTMLElement;
  expect(cross.getAttribute("aria-hidden")).toBe("true");
  expect([cross.style.left, cross.style.top]).toEqual(["420px", "330px"]);
  expect(box.textContent).toContain("Drops it at the crosshair");
  // The canvas is the board.
  const at = canvas.instance!.screenToFlowPosition({ x: 420, y: 330 });
  const input = within(box).getByRole("combobox");
  type(input, "state");
  expect(optionNames(box)[0]).toBe(KIND_HEAD.state.name);
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(s.saved.text).toContain('diagram state "State"'));
  await waitFor(() => expect(s.box()).toBeNull());
  await waitFor(() => expect(s.toast()?.textContent).toContain("Added State."));
  // The new frame's box is centred on the crosshair.
  await waitFor(() => expect(s.layoutNow().frames.State).toBeTruthy());
  await waitFor(() => expect(canvas.props!.nodes.some((n) => n.id === boardFrameId("State"))).toBe(true));
  const node = canvas.props!.nodes.find((n) => n.id === boardFrameId("State"))!;
  // The frame's box node is in board units, as the canvas is.
  expect(Math.abs(node.position.x + Number(node.style?.width) / 2 - at.x)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(node.position.y + Number(node.style?.height) / 2 - at.y)).toBeLessThanOrEqual(1.5);
  // After an add the keys go to the canvas.
  expect(document.activeElement).toBe(s.canvasEl());
});

test("tab_grows_into_the_shelf_with_the_search_kept", async () => {
  const s = setup();
  await opened();
  const box = await s.openBox();
  type(within(box).getByRole("combobox"), "shop");
  expect(fireEvent.keyDown(within(box).getByRole("combobox"), { key: "Tab" })).toBe(false);
  const shelf = await screen.findByRole("dialog", { name: "Add to the board" });
  expect(s.box()).toBeNull();
  const search = within(shelf).getByRole("combobox");
  expect((search as HTMLInputElement).value).toBe("shop");
  await waitFor(() => expect(document.activeElement).toBe(search));
  // It closes back to the canvas, which opened it.
  fireEvent.keyDown(search, { key: "Escape" });
  fireEvent.keyDown(search, { key: "Escape" });
  await waitFor(() => expect(s.shelf()).toBeNull());
  expect(document.activeElement).toBe(s.canvasEl());
  // Shift+Tab grows it too: focus never leaves the box for nowhere.
  const again = await s.openBox();
  type(within(again).getByRole("combobox"), "cache");
  expect(fireEvent.keyDown(within(again).getByRole("combobox"), { key: "Tab", shiftKey: true })).toBe(false);
  const shelf2 = await screen.findByRole("dialog", { name: "Add to the board" });
  expect(s.box()).toBeNull();
  expect((within(shelf2).getByRole("combobox") as HTMLInputElement).value).toBe("cache");
});

test("esc_and_a_press_outside_close", async () => {
  const s = setup();
  await opened();
  let box = await s.openBox();
  type(within(box).getByRole("combobox"), "flow");
  // Esc closes only the box: the board's own Esc does not also run, and focus goes back to the canvas (R16).
  expect(fireEvent.keyDown(within(box).getByRole("combobox"), { key: "Escape" })).toBe(false);
  await waitFor(() => expect(s.box()).toBeNull());
  expect(document.activeElement).toBe(s.canvasEl());
  // A press outside closes it, and that press keeps its own focus.
  box = await s.openBox();
  fireEvent.pointerDown(s.tool("Hand"), { button: 0 });
  await waitFor(() => expect(s.box()).toBeNull());
  // A press inside keeps it open.
  box = await s.openBox();
  fireEvent.pointerDown(within(box).getAllByRole("option")[0], { button: 0 });
  expect(s.box()).not.toBeNull();
  expect(s.saved.text).toBe(BOARD);
});

test("nothing_matches_offers_the_shelf", async () => {
  const s = setup();
  await opened();
  const box = await s.openBox();
  const input = within(box).getByRole("combobox");
  type(input, "zzqxjv");
  expect(within(box).queryAllByRole("option")).toHaveLength(0);
  expect(box.textContent).toContain("Nothing matches. Tab opens the full Shelf.");
  // Nothing to expand or control: the combobox says so, and points at no listbox.
  expect(input.getAttribute("aria-expanded")).toBe("false");
  expect(input.getAttribute("aria-controls")).toBeNull();
  expect(within(box).queryByRole("listbox")).toBeNull();
  type(input, "flow");
  expect(input.getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(input.getAttribute("aria-controls")!)?.getAttribute("role")).toBe("listbox");
  type(input, "zzqxjv");
  fireEvent.keyDown(input, { key: "Enter" });
  await new Promise((r) => setTimeout(r, 30));
  expect(s.saved.text).toBe(BOARD);
  expect(s.box()).not.toBeNull();
  fireEvent.keyDown(input, { key: "Tab" });
  const shelf = await screen.findByRole("dialog", { name: "Add to the board" });
  expect((within(shelf).getByRole("combobox") as HTMLInputElement).value).toBe("zzqxjv");
});

test("the_box_is_placed_by_place_box", async () => {
  const s = setup();
  await opened();
  s.sized(50, 40);
  // The box measures 320 by 200 (jsdom lays nothing out); everything else keeps React Flow's test sizes.
  const own = (box: number, other: number) =>
    function (this: HTMLElement) {
      return this.classList.contains("flow-space-box") ? box : other;
    };
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(own(320, 800));
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(own(200, 600));
  await s.openBox({ x: 700, y: 560 });
  // The pointer in the canvas's own coordinates, and the canvas's size.
  expect(spaceBox.props!.at).toEqual({ x: 650, y: 520 });
  expect(spaceBox.props!.bounds).toEqual({ w: 800, h: 600 });
  const panel = s.box()!;
  const want = placeBox({ x: 650, y: 520 }, { w: 320, h: 200 }, { w: 800, h: 600 });
  // Near the bottom right corner: flipped up and to the left.
  expect(want).toEqual({ x: 650 - 12 - 320, y: 520 - 12 - 200 });
  expect([panel.style.left, panel.style.top]).toEqual([`${want.x}px`, `${want.y}px`]);
  // The crosshair is at the pointer, inside the canvas.
  const cross = s.container.querySelector(".flow-space-cross") as HTMLElement;
  expect([cross.style.left, cross.style.top]).toEqual(["650px", "520px"]);
});

test("space_in_either_search_types_a_space", async () => {
  const s = setup();
  await opened();
  const box = await s.openBox();
  const input = within(box).getByRole("combobox");
  // Not cancelled: the search types the space, and no hold or second box starts.
  expect(fireEvent.keyDown(input, { key: " " })).toBe(true);
  fireEvent.keyUp(input, { key: " " });
  await new Promise((r) => setTimeout(r, 30));
  expect(s.canvasEl().classList.contains("is-space-held")).toBe(false);
  expect(screen.getAllByRole("dialog", { name: "Add here" })).toHaveLength(1);
  expect(document.activeElement).toBe(input);
  // The Shelf's search, the same.
  fireEvent.keyDown(input, { key: "Tab" });
  const shelf = await screen.findByRole("dialog", { name: "Add to the board" });
  const search = within(shelf).getByRole("combobox");
  await waitFor(() => expect(document.activeElement).toBe(search));
  expect(fireEvent.keyDown(search, { key: " " })).toBe(true);
  fireEvent.keyUp(search, { key: " " });
  await new Promise((r) => setTimeout(r, 30));
  expect(s.canvasEl().classList.contains("is-space-held")).toBe(false);
  expect(s.box()).toBeNull();
  expect(s.shelf()).not.toBeNull();
});

test("a_tap_with_the_shelf_open_swaps_it_for_the_box", async () => {
  const s = setup();
  await opened();
  fireEvent.click(s.tool("Add"));
  await screen.findByRole("dialog", { name: "Add to the board" });
  await s.openBox();
  expect(s.shelf()).toBeNull();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  // And Add swaps the box for the Shelf.
  fireEvent.click(s.tool("Add"));
  await screen.findByRole("dialog", { name: "Add to the board" });
  expect(s.box()).toBeNull();
});

test("the_box_ends_a_shelf_drag_it_closes", async () => {
  // Task 8 re-review carry: a drag the box cuts off must not hold the next Shelf's Shapes list on the old frame.
  const s = setup();
  await opened();
  await pickFrame(s, "Checkout");
  fireEvent.click(s.tool("Add"));
  let p = await screen.findByRole("dialog", { name: "Add to the board" });
  fireEvent.click(within(p).getByRole("tab", { name: /^Shapes/ }));
  fireEvent.dragStart(within(p).getByRole("option", { name: "Step" }), { dataTransfer: { setData() {}, types: [], effectAllowed: "all" } });
  await s.openBox();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(s.box()).toBeNull());
  await pickFrame(s, "Login");
  fireEvent.click(s.tool("Add"));
  p = await screen.findByRole("dialog", { name: "Add to the board" });
  fireEvent.click(within(p).getByRole("tab", { name: /^Shapes/ }));
  expect(within(p).getByRole("group", { name: `${KIND_HEAD.sequence.name} shapes` })).toBeTruthy();
});

test("a_double_click_in_the_selected_frame_still_opens_add_here", async () => {
  const s = setup();
  await opened();
  await pickFrame(s, "Checkout");
  const n = canvas.props!.nodes.find((x) => x.id === boardFrameId("Checkout"));
  const inside = n ? { x: n.position.x + 40, y: n.position.y + Number(n.style?.height ?? 200) - 30 } : { x: 200, y: 300 };
  act(() => canvas.props!.onPaneDoubleClick!({ screen: { x: 300, y: 300 }, flow: inside }));
  expect(await screen.findByRole("menu", { name: "Add here" })).toBeTruthy();
  // The double-click is Add here's alone (R14): no Space box.
  expect(s.box()).toBeNull();
});

test("the_box_adds_nothing_while_the_assistant_edits", async () => {
  const s = setup();
  await opened();
  // Under the lock the box still opens (decision 22: browsing is allowed), as the Shelf does.
  lock.on = true;
  s.rerender(s.view());
  const box = await s.openBox();
  // Enter is refused with the lock's note, no Undo, and the box stays open (R23, R10).
  fireEvent.keyDown(within(box).getByRole("combobox"), { key: "Enter" });
  await waitFor(() => expect(s.toast()?.textContent).toBe(EDIT_MESSAGES.locked));
  expect(within(s.toast() as HTMLElement).queryByRole("button", { name: "Undo" })).toBeNull();
  await new Promise((r) => setTimeout(r, 50));
  expect(s.saved.text).toBe(BOARD);
  expect(s.box()).not.toBeNull();
  // `/` over the canvas opens it under the lock too.
  fireEvent.keyDown(within(box).getByRole("combobox"), { key: "Escape" });
  await waitFor(() => expect(s.box()).toBeNull());
  fireEvent.pointerMove(s.canvasEl(), { clientX: 300, clientY: 200 });
  s.press("/");
  expect(await screen.findByRole("dialog", { name: "Add here" })).toBeTruthy();
  expect(s.saved.text).toBe(BOARD);
});

test("a_space_tap_with_no_pointer_opens_the_shelf", async () => {
  // The keyboard's way in: the canvas focused, the pointer never over it, so there is no point to open the box at.
  const s = setup();
  await opened();
  s.canvasEl().focus();
  s.press(" ");
  fireEvent.keyUp(s.canvasEl(), { key: " " });
  const shelf = await screen.findByRole("dialog", { name: "Add to the board" });
  expect(s.box()).toBeNull();
  await waitFor(() => expect(shelf.contains(document.activeElement)).toBe(true));
});

test("the_box_holds_still_while_typing_and_when_the_icons_load", async () => {
  // Its height follows its rows (jsdom lays nothing out): a box placed again per row count would move.
  const own = (box: (el: HTMLElement) => number, other: number) =>
    function (this: HTMLElement) {
      return this.classList.contains("flow-space-box") ? box(this) : other;
    };
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(own(() => 320, 800));
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(own((el) => 80 + 30 * el.querySelectorAll("[role=option]").length, 600));
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const icons = makeShelfIconSource({ entries: () => gate.then(() => ICONS), count: basicCount, results: basicResults, remember: () => {} });
  // Near the bottom: flipped up, its search at its top.
  render(<SpaceBox at={{ x: 200, y: 560 }} bounds={{ w: 800, h: 600 }} initialQuery="" icons={icons} onPick={() => {}} onShelf={() => {}} onClose={() => {}} />);
  const box = screen.getByRole("dialog", { name: "Add here" });
  const input = within(box).getByRole("combobox");
  expect(within(box).getAllByRole("option")).toHaveLength(4);
  const top = box.style.top;
  expect(Number.parseFloat(top)).toBeLessThan(560);
  // The icons arrive: 8 rows, the same place.
  await act(async () => {
    release();
    await gate;
  });
  await waitFor(() => expect(within(box).getAllByRole("option")).toHaveLength(8));
  expect(box.style.top).toBe(top);
  // Typing changes the rows, never the place; the search is the same field.
  for (const q of ["state", "zzqxjv", "a", ""]) {
    type(input, q);
    expect(box.style.top, q).toBe(top);
    expect(within(box).getByRole("combobox")).toBe(input);
  }
});

test("menu_keys_in_the_search_stay_in_the_box", async () => {
  const s = setup();
  await opened();
  // A frame selected: from the canvas, the menu key opens its menu.
  await pickFrame(s, "Checkout");
  s.canvasEl().focus();
  s.press("ContextMenu");
  await screen.findByRole("menu");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryAllByRole("menu")).toHaveLength(0));
  const box = await s.openBox();
  const input = within(box).getByRole("combobox");
  fireEvent.keyDown(input, { key: "ContextMenu" });
  fireEvent.keyDown(input, { key: "F10", shiftKey: true });
  await new Promise((r) => setTimeout(r, 30));
  // No board menu opened behind it, and the box keeps the keys.
  expect(screen.queryAllByRole("menu")).toHaveLength(0);
  expect(s.box()).not.toBeNull();
  expect(document.activeElement).toBe(input);
});

test("a_canvas_resize_closes_the_box", async () => {
  // Every ResizeObserver made from here on, by what it observes (React Flow's own included).
  const real = globalThis.ResizeObserver;
  const seen: { cb: ResizeObserverCallback; target: Element; self: ResizeObserver; live: boolean }[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: ResizeObserverCallback) {}
      observe(target: Element) {
        const o = { cb: this.cb, target, self: this as unknown as ResizeObserver, live: true };
        seen.push(o);
        // A first observation comes at once, as browsers send one.
        this.cb([{ target, contentRect: { width: 800, height: 600 } } as unknown as ResizeObserverEntry], o.self);
      }
      unobserve() {}
      disconnect() {
        for (const o of seen) if (o.self === (this as unknown as ResizeObserver)) o.live = false;
      }
    },
  );
  try {
    const s = setup();
    await opened();
    const box = await s.openBox();
    // The first observation is the size it opened at: the box stays.
    await new Promise((r) => setTimeout(r, 30));
    expect(s.box()).toBe(box);
    const watch = seen.filter((o) => o.target === s.canvasEl() && o.live);
    expect(watch.length).toBeGreaterThan(0);
    // The canvas narrows (a window resize, Ctrl+J's Assistant pane): the box closes, focus back on the canvas.
    act(() => {
      for (const o of watch) o.cb([{ target: o.target, contentRect: { width: 520, height: 600 } } as unknown as ResizeObserverEntry], o.self);
    });
    await waitFor(() => expect(s.box()).toBeNull());
    expect(document.activeElement).toBe(s.canvasEl());
    // Nothing is left watching once it is closed.
    expect(seen.filter((o) => o.target === s.canvasEl() && o.live && watch.includes(o))).toHaveLength(0);
  } finally {
    vi.stubGlobal("ResizeObserver", real);
  }
});

test("a_view_move_closes_the_box", async () => {
  // Figma and Miro close an insert popover when the view pans or zooms: its crosshair would no longer mark the drop.
  const s = setup();
  await opened();
  await s.openBox();
  // The view holding still keeps it.
  await new Promise((r) => setTimeout(r, 30));
  expect(s.box()).not.toBeNull();
  const v = canvas.instance!.getViewport();
  act(() => void canvas.instance!.setViewport({ x: v.x + 60, y: v.y, zoom: v.zoom }));
  await waitFor(() => expect(s.box()).toBeNull());
  // A zoom too.
  await s.openBox();
  act(() => void canvas.instance!.zoomTo(canvas.instance!.getZoom() * 1.5));
  await waitFor(() => expect(s.box()).toBeNull());
});

test("a_short_canvas_never_clips_the_box", async () => {
  const s = setup();
  await opened();
  s.sized(0, 0, 300);
  const box = await s.openBox({ x: 420, y: 150 });
  // The box is held to the canvas's height, and its list gives way and scrolls inside it.
  expect(box.style.maxHeight).toBe("300px");
  const top = Number.parseFloat(box.style.top);
  expect(top).toBeGreaterThanOrEqual(0);
  expect(top + Math.min(box.offsetHeight, 300)).toBeLessThanOrEqual(300);
  const list = /\.flow-space-list\s*\{([^}]*)\}/.exec(shelfCss)![1];
  expect(list).toMatch(/flex:\s*0 1 calc\(8 \* 30px/);
  expect(list).toMatch(/min-height:\s*0;/);
  expect(list).toMatch(/overflow-y:\s*auto;/);
  const panel = /\.flow-space-box\s*\{([^}]*)\}/.exec(shelfCss)![1];
  expect(panel).toMatch(/display:\s*flex;/);
  expect(panel).toMatch(/flex-direction:\s*column;/);
});

test("kind_menu_is_gone", async () => {
  // Every source file under src, this one's folder and up.
  const sources = import.meta.glob("../../../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const paths = Object.keys(sources);
  expect(paths.length).toBeGreaterThan(100);
  expect(paths.some((f) => f.endsWith("/board/KindMenu.tsx"))).toBe(false);
  const importers = paths.filter((f) => /from ["'][^"']*\/KindMenu(\.tsx)?(\?raw)?["']/.test(sources[f]));
  expect(importers).toEqual([]);
  // A tap opens the box, never B1's menu.
  const s = setup();
  await opened();
  await s.openBox();
  expect(screen.queryByRole("menu", { name: "Add diagram" })).toBeNull();
});
