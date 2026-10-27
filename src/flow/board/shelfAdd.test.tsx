// B2 Task 8: adding from the Shelf onto the board (decisions 2, 7 and 9; R9 to R11, R13, R16, R23, R24, R27, R28).
// FlowTab on a two-frame board with the fake worker. The Shelf is the real one; its props are kept so the template
// side's rows (Task 6), which call the same `onAdd`, can be driven before that side is on the page.
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";
import { type ReactNode, useState } from "react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { IconEntry } from "../../api/types";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { LangClient } from "../../lang/client";
import { EDIT_MESSAGES } from "../editWords";
import { BOARD_NOTES } from "../../lang/flow/boardEdits";
import { type DiagramKind, MAX_BOARD_FRAMES } from "../../lang/flow/model";
import { parseFlow } from "../../lang/flow/parse";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { patientFile } from "../../test/load";
import { mockReactFlowDom } from "../../test/reactFlow";
import { DIAGRAM_KIND_WORD } from "../diagramKinds";
import FlowTab, { type DatabaseAdd, type MermaidAdd } from "../FlowTab";
import { boardFrameId, FRAME_TAB_H } from "./boardScene";
import { MAX_SKETCHES } from "./boardLayout";
import type { ErFromModel } from "./catalog/fromDatabase";
import { SINGLE_TEMPLATES, templateById } from "./catalog/templates";
import { KIND_HEAD } from "./chips";
import type Shelf from "./shelf/Shelf";
import { shelfIconSource } from "./shelf/iconSource";
import { SHELF_DRAG_TYPE, type ShelfItem } from "./shelf/types";
import { frameAtPoint, ICON_NODE_KINDS } from "./shelfDrop";
import { NOTE_BOX } from "./SketchDraw";
import { resetIcons } from "../icons";
import { TOO_MANY_SKETCHES } from "./sketches";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
patientFile();

const canvas = vi.hoisted(() => ({ props: null as DiagramCanvasProps | null, instance: null as ReactFlowInstance | null }));
vi.mock("../../diagram/DiagramCanvas", async (load) => {
  const real = await load<typeof import("../../diagram/DiagramCanvas")>();
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
type ShelfProps = Parameters<typeof Shelf>[0];
const shelf = vi.hoisted(() => ({ props: null as ShelfProps | null }));
vi.mock("./shelf/Shelf", async (load) => {
  const real = await load<typeof import("./shelf/Shelf")>();
  return {
    ...real,
    default: (p: ShelfProps) => {
      shelf.props = p;
      return real.default(p);
    },
  };
});
const lock = vi.hoisted(() => ({ on: false }));
// `addFrames` answering a silent no-op ({ refused: "" }: the tab closed, the text kept changing), on demand.
const flowDoc = vi.hoisted(() => ({ refuseAll: false }));
vi.mock("../useFlowDoc", async (load) => {
  const real = await load<typeof import("../useFlowDoc")>();
  return {
    ...real,
    useFlowDoc: (...a: Parameters<typeof real.useFlowDoc>) => {
      const d = real.useFlowDoc(...a);
      return flowDoc.refuseAll ? { ...d, addFrames: async () => ({ refused: "" }) } : d;
    },
  };
});
vi.mock("../ai/useDiagramAsk", async (load) => {
  const real = await load<typeof import("../ai/useDiagramAsk")>();
  return {
    ...real,
    useDiagramAsk: (...a: Parameters<typeof real.useDiagramAsk>) => {
      const r = real.useDiagramAsk(...a);
      return lock.on ? { ...r, locked: true } : r;
    },
  };
});

/** Holds the icon index read until released (a title that loads slowly). */
const gates = { icons: Promise.resolve() as Promise<void> };
let reduce = true;
beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
});
beforeEach(() => {
  reduce = true;
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  canvas.props = null;
  canvas.instance = null;
  shelf.props = null;
  lock.on = false;
  flowDoc.refuseAll = false;
  gates.icons = Promise.resolve();
});

const ICONS: IconEntry[] = [
  { name: "brand-postgresql", set: "tabler", title: "PostgreSQL", licence: null, aliasOf: null },
  { name: "database", set: "lucide", title: "Database", licence: null, aliasOf: null },
];

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
const SHOP: ErFromModel = { title: "shop", text: 'diagram er "shop"\norders {\n  id int pk\n}\n', tables: 1, links: 0, leftOut: 0 };

function setup(text = BOARD, layout: string | null = LAYOUT, extra: { onFromDatabase?: (a: DatabaseAdd) => void; onMermaidFrame?: (a: MermaidAdd) => void; around?: (tab: ReactNode) => ReactNode } = {}) {
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
    icon_index: async () => {
      await gates.icons;
      return ICONS;
    },
    icon: () => '<svg xmlns="http://www.w3.org/2000/svg"/>',
  });
  const tab = <FlowTab name="board" client={new LangClient(() => fakeWorker())} onFromDatabase={extra.onFromDatabase} onMermaidFrame={extra.onMermaidFrame} />;
  const utils = render(<div style={{ width: 1280, height: 800 }}>{extra.around ? extra.around(tab) : tab}</div>);
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const dropEl = () => utils.container.querySelector(".diagram-canvas") as HTMLElement;
  const bar = () => screen.getByRole("toolbar", { name: "Board tools" });
  const tool = (name: string) => within(bar()).getByRole("button", { name });
  const pressed = () => within(bar()).getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("aria-label"));
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const panel = () => screen.queryByRole("dialog", { name: "Add to the board" });
  const layoutNow = () => JSON.parse(saved.layout ?? '{"frames":{},"sketches":[]}');
  /** A live frame's board origin: its entry's `at`. */
  const originOf = (title: string): Pt => layoutNow().frames[title]?.at ?? { x: 0, y: 0 };
  const inst = () => canvas.instance!;
  const nodeOf = (id: string) => canvas.props!.nodes.find((n) => n.id === id);
  /** A frame's box on the canvas, in flow coordinates. */
  const boxOf = (title: string) => {
    const n = nodeOf(boardFrameId(title))!;
    return { x: n.position.x, y: n.position.y, w: Number(n.style?.width), h: Number(n.style?.height) };
  };
  const isSelected = (title: string) => screen.queryAllByRole("button", { name: new RegExp(` ${title}$`) }).some((b) => b.getAttribute("aria-current") === "true");
  const toast = () => utils.container.querySelector(".flow-toast");
  /** The canvas as a browser lays it out: 800 by 600 at the page's corner, so its middle is (400, 300) on screen. */
  const sized = () =>
    vi.spyOn(canvasEl(), "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} } as DOMRect);
  return { ...utils, saved, canvasEl, dropEl, bar, tool, pressed, press, panel, layoutNow, originOf, inst, nodeOf, boxOf, isSelected, toast, sized };
}
type Setup = ReturnType<typeof setup>;

async function opened(titles: [string, string][] = [["Flowchart", "Checkout"], ["Sequence", "Login"]]) {
  for (const [k, t] of titles) await screen.findByRole("button", { name: `${k} ${t}` });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
}

async function pickFrame(s: Setup, title: string) {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(` ${title}$`) }));
  await waitFor(() => expect(s.isSelected(title)).toBe(true));
}

/** Opens the Shelf with Add and waits for its search to take focus. */
async function openShelf(s: Setup) {
  fireEvent.click(s.tool("Add"));
  const p = await screen.findByRole("dialog", { name: "Add to the board" });
  await waitFor(() => expect(p.contains(document.activeElement)).toBe(true));
  return p;
}

/** A data transfer a browser would carry: what is set is what is read, and `types` lists it. */
function transfer(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    get types() {
      return [...store.keys()];
    },
    setData: (t: string, v: string) => void store.set(t, v),
    getData: (t: string) => store.get(t) ?? "",
    effectAllowed: "all",
    dropEffect: "none",
  };
}
const carrying = (item: ShelfItem) => transfer({ [SHELF_DRAG_TYPE]: JSON.stringify(item) });

/** A drag event at a screen point: jsdom has no DragEvent, so the point is set on the event by hand. */
function dragEvent(type: "dragEnter" | "dragOver" | "drop", el: HTMLElement, dt: ReturnType<typeof transfer>, p: Pt) {
  const ev = createEvent[type](el, { dataTransfer: dt });
  Object.defineProperty(ev, "clientX", { value: p.x });
  Object.defineProperty(ev, "clientY", { value: p.y });
  return fireEvent(el, ev);
}

/** Drags over and drops on the canvas at a flow position. */
function dropAt(s: Setup, dt: ReturnType<typeof transfer>, flow: Pt) {
  const p = s.inst().flowToScreenPosition(flow);
  dragEvent("dragEnter", s.dropEl(), dt, p);
  dragEvent("dragOver", s.dropEl(), dt, p);
  dragEvent("drop", s.dropEl(), dt, p);
}

/** The view's middle on the board, as the add reads it: the canvas centre on screen, plus the live origin. */
function middle(s: Setup, origin: Pt): Pt {
  const f = s.inst().screenToFlowPosition({ x: 400, y: 300 });
  return { x: f.x + origin.x, y: f.y + origin.y };
}

const for_ = <T,>(xs: readonly T[], f: (x: T) => void) => xs.forEach(f);
const near = (a: number, b: number, by = 1.5) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(by);

// ----- frameAtPoint

test("frame_at_point_reads_board_boxes_and_puts_the_live_frame_first", () => {
  const box = (key: string, index: number, x: number) => ({ key, index, title: key, kind: "flow" as DiagramKind, x, y: 0, w: 200, h: 100, problems: 0, clash: false });
  const boxes = [box("A", 0, 0), box("B", 1, 100)];
  // Canvas boxes with origin (500, 0): A spans 500 to 700 on the board.
  expect(frameAtPoint(boxes, { x: 500, y: 0 }, { x: 550, y: 50 }, null)?.key).toBe("A");
  expect(frameAtPoint(boxes, { x: 500, y: 0 }, { x: 50, y: 50 }, null)).toBeNull();
  // Overlap: the later in text order, unless the live one is there.
  expect(frameAtPoint(boxes, { x: 0, y: 0 }, { x: 150, y: 50 }, null)?.key).toBe("B");
  expect(frameAtPoint(boxes, { x: 0, y: 0 }, { x: 150, y: 50 }, "A")?.key).toBe("A");
  expect([...ICON_NODE_KINDS].sort()).toEqual(["cloud", "dfd", "flow", "mindmap", "state"]);
});

// ----- opening and closing

test("add_and_slash_open_the_shelf_and_add_again_closes_it", async () => {
  const s = setup();
  await opened();
  await openShelf(s);
  expect(s.tool("Add").getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(s.tool("Add"));
  await waitFor(() => expect(s.panel()).toBeNull());
  expect(s.tool("Add").getAttribute("aria-expanded")).toBe("false");
  // `/` with the pointer off the canvas opens the Shelf.
  s.press("/");
  expect(await screen.findByRole("dialog", { name: "Add to the board" })).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(s.panel()).toBeNull());
  // Over the canvas `/` opens the Space box instead (Task 11).
  fireEvent.pointerMove(s.canvasEl(), { clientX: 300, clientY: 200 });
  s.press("/");
  expect(await screen.findByRole("dialog", { name: "Add here" })).toBeTruthy();
  expect(s.panel()).toBeNull();
});

test("opening_the_shelf_disarms_any_tool", async () => {
  const s = setup();
  await opened();
  // A drawing tool with nothing selected.
  s.press("p");
  expect(s.pressed()).toEqual(["Pen"]);
  await openShelf(s);
  expect(s.pressed()).toEqual(["Select"]);
  fireEvent.click(s.tool("Add"));
  await waitFor(() => expect(s.panel()).toBeNull());
  // A kind tool of the selected frame.
  await pickFrame(s, "Checkout");
  await waitFor(() => expect(within(s.bar()).queryByRole("button", { name: "Step" })).not.toBeNull());
  fireEvent.click(s.tool("Step"));
  expect(s.pressed()).toEqual(["Step"]);
  await openShelf(s);
  expect(s.pressed()).toEqual(["Select"]);
});

test("add_says_it_opens_a_dialog", async () => {
  const s = setup(CHECKOUT, null);
  await opened([["Flowchart", "Checkout"]]);
  await waitFor(() => expect(within(s.bar()).queryByRole("button", { name: "More shapes" })).not.toBeNull());
  for (const name of ["Add", "More shapes"]) {
    expect(s.tool(name).getAttribute("aria-haspopup")).toBe("dialog");
    expect(s.tool(name).getAttribute("aria-expanded")).toBe("false");
  }
  const p = await openShelf(s);
  expect(p.id).not.toBe("");
  expect(s.tool("Add").getAttribute("aria-controls")).toBe(p.id);
  expect(s.tool("More shapes").getAttribute("aria-controls")).toBe(p.id);
  expect(p.getAttribute("aria-modal")).toBeNull();
});

test("more_shapes_opens_the_shelf_on_shapes", async () => {
  const s = setup(CHECKOUT, null);
  await opened([["Flowchart", "Checkout"]]);
  await waitFor(() => expect(within(s.bar()).queryByRole("button", { name: "More shapes" })).not.toBeNull());
  fireEvent.click(s.tool("More shapes"));
  const p = await screen.findByRole("dialog", { name: "Add to the board" });
  expect(within(p).getByRole("tab", { name: /^Shapes/ }).getAttribute("aria-selected")).toBe("true");
  expect(within(p).getByRole("group", { name: `${KIND_HEAD.flow.name} shapes` })).toBeTruthy();
  expect(s.tool("More shapes").getAttribute("aria-expanded")).toBe("true");
  expect(s.tool("Add").getAttribute("aria-expanded")).toBe("false");
  // The old Shapes menu is gone.
  expect(screen.queryByRole("menu", { name: "Shapes" })).toBeNull();
});

test("closing_the_shelf_returns_focus_to_its_opener", async () => {
  const s = setup(CHECKOUT, null);
  await opened([["Flowchart", "Checkout"]]);
  await waitFor(() => expect(within(s.bar()).queryByRole("button", { name: "More shapes" })).not.toBeNull());
  s.tool("Add").focus();
  await openShelf(s);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(s.panel()).toBeNull());
  expect(document.activeElement).toBe(s.tool("Add"));
  fireEvent.click(s.tool("More shapes"));
  const p = await screen.findByRole("dialog", { name: "Add to the board" });
  await waitFor(() => expect(p.contains(document.activeElement)).toBe(true));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(s.panel()).toBeNull());
  expect(document.activeElement).toBe(s.tool("More shapes"));
  // Opened by `/` off the canvas: back to the canvas.
  s.canvasEl().focus();
  s.press("/");
  await screen.findByRole("dialog", { name: "Add to the board" });
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(s.panel()).toBeNull());
  expect(document.activeElement).toBe(s.canvasEl());
});

test("esc_in_the_shelf_leaves_the_one_frame_selection", async () => {
  const s = setup(CHECKOUT, null);
  await opened([["Flowchart", "Checkout"]]);
  await waitFor(() => expect(s.isSelected("Checkout")).toBe(true));
  await openShelf(s);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(s.panel()).toBeNull());
  await new Promise((r) => setTimeout(r, 30));
  expect(s.isSelected("Checkout")).toBe(true);
});

test("the_shelf_is_not_modal_shortcuts_act_from_its_search", async () => {
  const s = setup();
  await opened();
  const p = await openShelf(s);
  const search = within(p).getByRole("combobox");
  const side = () => s.container.querySelector(".flow-tab")!.classList.contains("is-pane-closed");
  const before = side();
  // Ctrl+B hides or shows the pane from the search, as it does elsewhere.
  expect(fireEvent.keyDown(search, { key: "b", ctrlKey: true })).toBe(false);
  await waitFor(() => expect(side()).toBe(!before));
  // Letters typed in the search are the search's: no tool arms.
  for (const key of ["p", "r", "h", "v", "/"]) fireEvent.keyDown(search, { key });
  expect(s.pressed()).toEqual(["Select"]);
  expect(screen.getAllByRole("dialog", { name: "Add to the board" })).toHaveLength(1);
});

test("the_shelf_sits_under_the_toolbar_outside_the_canvas", async () => {
  const s = setup();
  await opened();
  const p = await openShelf(s);
  // Outside `.diagram-canvas`, so the canvas's key handler never sees its keys (decision 2).
  expect(s.dropEl().contains(p)).toBe(false);
  // The frame bar and zoom controls stay clear: the live 1366 by 768 check is recorded for Checkpoint M2.
});

// ----- clicks

test("a_kind_card_adds_an_empty_frame_in_the_middle_of_the_view", async () => {
  const s = setup();
  await opened();
  s.sized();
  const mid = middle(s, { x: 0, y: 0 });
  const p = await openShelf(s);
  const glide = vi.spyOn(s.inst(), "setCenter");
  fireEvent.click(within(p).getByRole("option", { name: KIND_HEAD.er.name }));
  await waitFor(() => expect(s.saved.text).toContain(`diagram er "${DIAGRAM_KIND_WORD.er}"`));
  const title = DIAGRAM_KIND_WORD.er;
  await waitFor(() => expect(s.isSelected(title)).toBe(true));
  await waitFor(() => expect(glide).toHaveBeenCalled());
  // Reduced motion: the glide jumps.
  expect(glide.mock.calls[glide.mock.calls.length - 1][2]).toMatchObject({ duration: 0 });
  // Its box is centred on the view's middle, in board coordinates.
  await waitFor(() => expect(s.layoutNow().frames[title]).toBeTruthy());
  const o = s.originOf(title);
  const b = s.boxOf(title);
  near(b.x + o.x + b.w / 2, mid.x);
  near(b.y + o.y + b.h / 2, mid.y);
  await waitFor(() => expect(s.panel()).toBeNull());
  expect(s.toast()?.textContent).toContain(`Added ${title}.`);
});

test("a_board_template_adds_three_frames_in_one_undo_and_fits_them", async () => {
  const s = setup();
  await opened();
  await openShelf(s);
  const fit = vi.spyOn(s.inst(), "fitBounds");
  const shop = templateById("board-online-shop")!;
  act(() => shelf.props!.onAdd({ kind: "template", id: shop.id }));
  const titles = ["Orders ERD", "Checkout flow", "Pay sequence"];
  await waitFor(() => expect(s.isSelected(titles[0])).toBe(true));
  await waitFor(() => for_(titles, (t) => expect(s.saved.text).toContain(`"${t}"`)));
  await waitFor(() => expect(fit).toHaveBeenCalledTimes(1));
  // The union of the three boxes on the canvas (the new origin), with the tabs above them.
  const boxes = titles.map((t) => s.boxOf(t));
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  const [rect, opts] = fit.mock.calls[0];
  near(rect.x, x0);
  near(rect.y, y0 - FRAME_TAB_H);
  near(rect.width, x1 - x0);
  near(rect.height, y1 - y0 + FRAME_TAB_H);
  expect(opts).toMatchObject({ duration: 0 });
  expect(s.toast()?.textContent).toContain(`Added ${shop.name}.`);
  // One undo takes all three back.
  fireEvent.click(within(s.toast() as HTMLElement).getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(s.saved.text).toBe(BOARD));
});

test("a_single_template_adds_its_frame", async () => {
  const s = setup();
  await opened();
  await openShelf(s);
  const t = SINGLE_TEMPLATES.find((x) => x.kind === "sequence")!;
  act(() => shelf.props!.onAdd({ kind: "template", id: t.id }));
  await waitFor(() => expect(s.isSelected(t.name)).toBe(true));
  await waitFor(() => expect(s.saved.text).toContain(`"${t.name}"`));
  expect(s.toast()?.textContent).toContain(`Added ${t.name}.`);
});

test("a_click_with_a_flowchart_selected_puts_the_icon_in_it", async () => {
  const s = setup();
  await opened();
  await pickFrame(s, "Checkout");
  const p = await openShelf(s);
  fireEvent.click(within(p).getByRole("tab", { name: /^Icons/ }));
  fireEvent.click(await within(p).findByRole("option", { name: "PostgreSQL" }));
  await waitFor(() => expect(s.saved.text).toContain("PostgreSQL [icon: brand-postgresql]"));
  expect(s.saved.text.indexOf("PostgreSQL")).toBeLessThan(s.saved.text.indexOf('diagram sequence "Login"'));
  await waitFor(() => expect(s.toast()?.textContent).toContain("Added PostgreSQL."));
  expect(s.panel()).toBeNull();
});

test("a_click_with_nothing_selected_makes_an_icon_sketch_in_the_middle", async () => {
  const s = setup();
  await opened();
  s.sized();
  const mid = middle(s, { x: 0, y: 0 });
  const p = await openShelf(s);
  fireEvent.click(within(p).getByRole("tab", { name: /^Icons/ }));
  fireEvent.click(await within(p).findByRole("option", { name: "PostgreSQL" }));
  await waitFor(() => expect(s.layoutNow().sketches).toHaveLength(1));
  const sk = s.layoutNow().sketches[0];
  expect(sk).toMatchObject({ kind: "icon", icon: "brand-postgresql", w: 64, h: 64 });
  near(sk.x + 32, mid.x);
  near(sk.y + 32, mid.y);
  expect(s.saved.text).toBe(BOARD);
});

test("every_icon_node_kind_takes_an_icon", async () => {
  for (const kind of ICON_NODE_KINDS) {
    const t = SINGLE_TEMPLATES.find((x) => x.kind === kind)!;
    const s = setup(t.text, null);
    await screen.findByRole("button", { name: new RegExp(` ${t.name}$`) });
    await waitFor(() => expect(s.isSelected(t.name)).toBe(true));
    await waitFor(() => expect(canvas.props!.nodes.length).toBeGreaterThan(1));
    const p = await openShelf(s);
    fireEvent.click(within(p).getByRole("tab", { name: /^Icons/ }));
    fireEvent.click(await within(p).findByRole("option", { name: "PostgreSQL" }));
    await waitFor(() => expect(s.saved.text, kind).toMatch(/^\s*PostgreSQL \[.*icon: brand-postgresql\]$/m));
    expect(parseFlow(s.saved.text).problems, kind).toEqual([]);
    expect(s.layoutNow().sketches ?? [], kind).toHaveLength(0);
    cleanup();
  }
});

test("a_note_opens_its_field_and_adds_only_when_typed", async () => {
  const s = setup();
  await opened();
  s.sized();
  const mid = middle(s, { x: 0, y: 0 });
  let p = await openShelf(s);
  fireEvent.click(within(p).getByRole("tab", { name: /^Shapes/ }));
  fireEvent.click(within(p).getByRole("option", { name: "Note" }));
  const field = await screen.findByRole("textbox", { name: "Note sketch" });
  expect(s.panel()).toBeNull();
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Note sketch" })).toBeNull());
  expect(s.layoutNow().sketches ?? []).toHaveLength(0);
  p = await openShelf(s);
  fireEvent.click(within(p).getByRole("tab", { name: /^Shapes/ }));
  fireEvent.click(within(p).getByRole("option", { name: "Note" }));
  const again = await screen.findByRole("textbox", { name: "Note sketch" });
  fireEvent.change(again, { target: { value: "Hi" } });
  fireEvent.keyDown(again, { key: "Enter" });
  await waitFor(() => expect(s.layoutNow().sketches).toHaveLength(1));
  const n = s.layoutNow().sketches[0];
  expect(n).toMatchObject({ kind: "note", text: "Hi", w: NOTE_BOX.w, h: NOTE_BOX.h });
  near(n.x + NOTE_BOX.w / 2, mid.x);
  near(n.y + NOTE_BOX.h / 2, mid.y);
  expect(s.toast()?.textContent ?? "").not.toContain("Added");
});

test("text_opens_its_field_at_the_point", async () => {
  const s = setup();
  await opened();
  await openShelf(s);
  const at = { x: 300, y: 900 };
  act(() => shelf.props!.onAdd({ kind: "sketch", sketch: "text" }, at));
  const field = await screen.findByRole("textbox", { name: "Text sketch" });
  fireEvent.change(field, { target: { value: "Ship it" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(s.layoutNow().sketches).toHaveLength(1));
  const t = s.layoutNow().sketches[0];
  expect(t).toMatchObject({ kind: "text", text: "Ship it", x: at.x });
  near(t.y + t.h / 2, at.y);
});

test("a_kind_shape_runs_through_the_frame_tools", async () => {
  const s = setup();
  await opened();
  await pickFrame(s, "Checkout");
  const p = await openShelf(s);
  fireEvent.click(within(p).getByRole("tab", { name: /^Shapes/ }));
  fireEvent.click(within(p).getByRole("option", { name: "Step" }));
  // As the toolbar's Step: a new shape with its name ready.
  const name = await screen.findByRole("textbox", { name: "Name the new step" });
  fireEvent.change(name, { target: { value: "Ship" } });
  fireEvent.keyDown(name, { key: "Enter" });
  await waitFor(() => expect(s.saved.text).toContain("Ship"));
  expect(s.panel()).toBeNull();
});

test("a_rectangle_click_adds_a_box_sketch_and_toasts", async () => {
  const s = setup();
  await opened();
  s.sized();
  const mid = middle(s, { x: 0, y: 0 });
  const p = await openShelf(s);
  fireEvent.click(within(p).getByRole("tab", { name: /^Shapes/ }));
  fireEvent.click(within(p).getByRole("option", { name: "Rectangle" }));
  await waitFor(() => expect(s.layoutNow().sketches).toHaveLength(1));
  const r = s.layoutNow().sketches[0];
  expect(r).toMatchObject({ kind: "rect", w: 120, h: 80 });
  near(r.x + 60, mid.x);
  near(r.y + 40, mid.y);
  expect(s.toast()?.textContent).toContain("Added Rectangle.");
  expect(s.panel()).toBeNull();
});

// ----- drops

test("a_drop_places_it_where_released", async () => {
  const s = setup();
  await opened();
  await pickFrame(s, "Login");
  const origin = s.originOf("Login");
  expect(origin).toEqual({ x: 700, y: 0 });
  await openShelf(s);
  const flow = { x: -200, y: 900 };
  dropAt(s, carrying({ kind: "diagram", diagram: "er" }), flow);
  const title = DIAGRAM_KIND_WORD.er;
  await waitFor(() => expect(s.isSelected(title)).toBe(true));
  await waitFor(() => expect(s.layoutNow().frames[title]).toBeTruthy());
  const o = s.originOf(title);
  const b = s.boxOf(title);
  near(b.x + o.x + b.w / 2, flow.x + origin.x);
  near(b.y + o.y + b.h / 2, flow.y + origin.y);
  await waitFor(() => expect(s.panel()).toBeNull());
});

test("a_drop_of_another_type_does_nothing", async () => {
  const s = setup();
  await opened();
  const before = { text: s.saved.text, layout: s.saved.layout };
  const other = transfer({ "text/plain": "hello" });
  const p = s.inst().flowToScreenPosition({ x: 100, y: 900 });
  dragEvent("dragEnter", s.dropEl(), other, p);
  expect(dragEvent("dragOver", s.dropEl(), other, p)).toBe(true);
  expect(s.dropEl().classList.contains("is-drop-target")).toBe(false);
  dragEvent("drop", s.dropEl(), other, p);
  await new Promise((r) => setTimeout(r, 50));
  expect(s.saved).toEqual(before);
  // A Shelf drag rings the canvas; a bad payload of the Shelf's type does nothing.
  const bad = transfer({ [SHELF_DRAG_TYPE]: "{not json" });
  expect(dragEvent("dragOver", s.dropEl(), bad, p)).toBe(false);
  expect(s.dropEl().classList.contains("is-drop-target")).toBe(true);
  dragEvent("drop", s.dropEl(), bad, p);
  await new Promise((r) => setTimeout(r, 50));
  expect(s.saved).toEqual(before);
});

async function iconDropOnCheckout(s: Setup) {
  await pickFrame(s, "Login");
  const origin = s.originOf("Login");
  await openShelf(s);
  const box = s.boxOf("Checkout");
  const flow = { x: box.x + box.w / 2, y: box.y + box.h - 12 };
  const board = { x: flow.x + origin.x, y: flow.y + origin.y };
  dropAt(s, carrying({ kind: "icon", name: "brand-postgresql" }), flow);
  await waitFor(() => expect(s.saved.text).toContain("PostgreSQL [icon: brand-postgresql]"));
  await waitFor(() => expect(s.isSelected("Checkout")).toBe(true));
  // The node sits at the drop point, read in Checkout's origin.
  const at = s.originOf("Checkout");
  await waitFor(() => expect(s.nodeOf("PostgreSQL")).toBeTruthy());
  const n = s.nodeOf("PostgreSQL")!;
  const w = n.initialWidth ?? n.width ?? 0;
  const h = n.initialHeight ?? n.height ?? 0;
  // Within the grid the positions snap to.
  near(n.position.x + w / 2, board.x - at.x, 8);
  near(n.position.y + h / 2, board.y - at.y, 8);
  expect(s.layoutNow().sketches ?? []).toHaveLength(0);
}

test("an_icon_dropped_on_an_unselected_flowchart_lands_in_that_frame", async () => {
  const s = setup();
  await opened();
  await iconDropOnCheckout(s);
});

test("an_icon_dropped_in_the_overview_lands_the_same", async () => {
  const s = setup();
  await opened();
  await act(async () => {
    await s.inst().setViewport({ x: 0, y: 0, zoom: 0.3 });
  });
  act(() => canvas.props!.onOverview?.(true));
  await iconDropOnCheckout(s);
});

test("an_icon_on_empty_canvas_becomes_an_icon_sketch", async () => {
  const s = setup();
  await opened();
  await openShelf(s);
  const flow = { x: 100, y: 1200 };
  dropAt(s, carrying({ kind: "icon", name: "database" }), flow);
  await waitFor(() => expect(s.layoutNow().sketches).toHaveLength(1));
  expect(s.layoutNow().sketches[0]).toMatchObject({ kind: "icon", icon: "database", x: 68, y: 1168, w: 64, h: 64 });
  expect(s.saved.text).toBe(BOARD);
  expect(s.toast()?.textContent).toContain("Added Database.");
});

test("an_icon_dropped_on_a_sequence_frame_is_a_sketch", async () => {
  const s = setup();
  await opened();
  await openShelf(s);
  const box = s.boxOf("Login");
  const flow = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  dropAt(s, carrying({ kind: "icon", name: "database" }), flow);
  await waitFor(() => expect(s.layoutNow().sketches).toHaveLength(1));
  expect(s.layoutNow().sketches[0]).toMatchObject({ kind: "icon", icon: "database" });
  expect(s.saved.text).toBe(BOARD);
});

test("a_kind_shape_dropped_in_its_frame_adds_there", async () => {
  const s = setup();
  await opened();
  await pickFrame(s, "Checkout");
  await openShelf(s);
  const box = s.boxOf("Checkout");
  dropAt(s, carrying({ kind: "shape", frameKind: "flow", label: "Step" }), { x: box.x + box.w / 2, y: box.y + box.h - 12 });
  expect(await screen.findByRole("textbox", { name: "Name the new step" })).toBeTruthy();
});

test("a_kind_shape_dropped_in_another_frame_selects_it_and_adds_nothing", async () => {
  const s = setup(`${CHECKOUT}\n${CHECKOUT.replace('"Checkout"', '"Refund"')}`, null);
  await opened([["Flowchart", "Checkout"], ["Flowchart", "Refund"]]);
  await pickFrame(s, "Checkout");
  await openShelf(s);
  const box = s.boxOf("Refund");
  const text = s.saved.text;
  dropAt(s, carrying({ kind: "shape", frameKind: "flow", label: "Step" }), { x: box.x + box.w / 2, y: box.y + box.h / 2 });
  await waitFor(() => expect(s.isSelected("Refund")).toBe(true));
  await new Promise((r) => setTimeout(r, 50));
  expect(s.saved.text).toBe(text);
  expect(screen.queryByRole("textbox", { name: "Name the new step" })).toBeNull();
});

test("a_kind_shape_dropped_on_empty_canvas_is_refused", async () => {
  const s = setup();
  await opened();
  await pickFrame(s, "Checkout");
  await openShelf(s);
  dropAt(s, carrying({ kind: "shape", frameKind: "flow", label: "Step" }), { x: 100, y: 1400 });
  await waitFor(() => expect(s.toast()?.textContent).toBe("Drop Step inside its diagram."));
  expect(within(s.toast() as HTMLElement).queryByRole("button", { name: "Undo" })).toBeNull();
  expect(s.panel()).not.toBeNull();
});

test("a_drag_ends_even_when_the_shelf_closes_under_it", async () => {
  // The Shelf closes after a drop adds; its tile is gone before the browser's dragend, which then reaches nothing.
  // Closing the Shelf ends the drag itself.
  const s = setup();
  await opened();
  await pickFrame(s, "Checkout");
  let p = await openShelf(s);
  fireEvent.click(within(p).getByRole("tab", { name: /^Shapes/ }));
  const dt = transfer();
  fireEvent.dragStart(within(p).getByRole("option", { name: "Rectangle" }), { dataTransfer: dt });
  expect(dt.types).toContain(SHELF_DRAG_TYPE);
  dropAt(s, dt, { x: 100, y: 1400 });
  await waitFor(() => expect(s.panel()).toBeNull());
  await waitFor(() => expect(s.layoutNow().sketches).toHaveLength(1));
  // No drag holds the Shapes list now: on another frame it lists that frame's shapes.
  await pickFrame(s, "Login");
  p = await openShelf(s);
  fireEvent.click(within(p).getByRole("tab", { name: /^Shapes/ }));
  expect(within(p).getByRole("group", { name: `${KIND_HEAD.sequence.name} shapes` })).toBeTruthy();
  expect(within(p).queryByRole("group", { name: `${KIND_HEAD.flow.name} shapes` })).toBeNull();
  fireEvent.click(s.tool("Add"));
  await waitFor(() => expect(s.panel()).toBeNull());
  // A drag that keeps the Shelf open holds its list still until it ends; then the list follows the frame again.
  await pickFrame(s, "Checkout");
  p = await openShelf(s);
  fireEvent.click(within(p).getByRole("tab", { name: /^Shapes/ }));
  const step = within(p).getByRole("option", { name: "Step" });
  const dt2 = transfer();
  fireEvent.dragStart(step, { dataTransfer: dt2 });
  await waitFor(() => expect(p.hasAttribute("data-dragging")).toBe(true));
  dropAt(s, dt2, { x: s.boxOf("Login").x + 20, y: s.boxOf("Login").y + 20 });
  await waitFor(() => expect(s.isSelected("Login")).toBe(true));
  expect(within(p).getByRole("group", { name: `${KIND_HEAD.flow.name} shapes` })).toBeTruthy();
  fireEvent.dragEnd(step);
  await waitFor(() => expect(within(p).queryByRole("group", { name: `${KIND_HEAD.flow.name} shapes` })).toBeNull());
  expect(p.hasAttribute("data-dragging")).toBe(false);
});

// ----- after an add, and refusals

test("the_shelf_closes_after_an_add_and_the_toast_undoes_it", async () => {
  const s = setup();
  await opened();
  const p = await openShelf(s);
  fireEvent.click(within(p).getByRole("option", { name: KIND_HEAD.flow.name }));
  await waitFor(() => expect(s.panel()).toBeNull());
  await waitFor(() => expect(s.toast()?.textContent).toContain("Added Flowchart."));
  await waitFor(() => expect(s.saved.text).not.toBe(BOARD));
  fireEvent.click(within(s.toast() as HTMLElement).getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(s.saved.text).toBe(BOARD));
});

test("a_refusal_keeps_the_shelf_open_with_its_note", async () => {
  const frames = Array.from({ length: MAX_BOARD_FRAMES }, (_, i) => `diagram flow "F${i + 1}"\nA\n`);
  const s = setup(frames.join("\n"), null);
  await waitFor(() => expect(canvas.props?.nodes.some((n) => n.id === boardFrameId(`F${MAX_BOARD_FRAMES}`))).toBe(true), { timeout: 5000 });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  const text = s.saved.text;
  const p = await openShelf(s);
  fireEvent.click(within(p).getByRole("option", { name: KIND_HEAD.flow.name }));
  await waitFor(() => expect(s.toast()?.textContent).toBe(BOARD_NOTES.full));
  expect(within(s.toast() as HTMLElement).queryByRole("button", { name: "Undo" })).toBeNull();
  expect(s.panel()).not.toBeNull();
  expect(s.saved.text).toBe(text);
});

test("a_sketch_refusal_from_the_shelf_toasts", async () => {
  const sketches = Array.from({ length: MAX_SKETCHES }, (_, i) => ({ id: `s${i}`, kind: "rect", x: (i % 40) * 10, y: 2000 + Math.floor(i / 40) * 10, w: 8, h: 8 }));
  const layout = JSON.stringify({ ...JSON.parse(LAYOUT), sketches });
  const s = setup(BOARD, layout);
  await opened();
  const p = await openShelf(s);
  fireEvent.click(within(p).getByRole("tab", { name: /^Shapes/ }));
  fireEvent.click(within(p).getByRole("option", { name: "Rectangle" }));
  await waitFor(() => expect(s.toast()?.textContent).toBe(TOO_MANY_SKETCHES));
  // In the toast, not the strip.
  expect(screen.getAllByText(TOO_MANY_SKETCHES)).toHaveLength(1);
  expect(s.panel()).not.toBeNull();
});

test("adds_are_refused_while_the_assistant_edits", async () => {
  const s = setup();
  await opened();
  lock.on = true;
  // Opening is browsing: allowed.
  const p = await openShelf(s);
  fireEvent.click(within(p).getByRole("option", { name: KIND_HEAD.flow.name }));
  await waitFor(() => expect(s.toast()?.textContent).toBe(EDIT_MESSAGES.locked));
  act(() => shelf.props!.onAdd({ kind: "template", id: "board-online-shop" }));
  dropAt(s, carrying({ kind: "diagram", diagram: "er" }), { x: 100, y: 1200 });
  dropAt(s, carrying({ kind: "icon", name: "database" }), { x: 100, y: 1200 });
  await new Promise((r) => setTimeout(r, 80));
  expect(s.saved.text).toBe(BOARD);
  expect(s.layoutNow().sketches ?? []).toHaveLength(0);
  expect(s.toast()?.textContent).toBe(EDIT_MESSAGES.locked);
});

test("an_icon_add_is_remembered", async () => {
  const remember = vi.spyOn(shelfIconSource, "remember");
  const s = setup();
  await opened();
  await openShelf(s);
  dropAt(s, carrying({ kind: "icon", name: "database" }), { x: 100, y: 1200 });
  await waitFor(() => expect(remember).toHaveBeenCalledWith("database"));
});

test("ctrl_z_right_after_a_tab_click_undoes_the_last_cross_frame_edit", async () => {
  const s = setup();
  await opened();
  await openShelf(s);
  act(() => shelf.props!.onAdd({ kind: "template", id: "board-online-shop" }));
  await waitFor(() => expect(s.isSelected("Orders ERD")).toBe(true));
  await waitFor(() => expect(s.toast()?.textContent).toContain("Added Online shop."));
  const tab = await screen.findByRole("button", { name: / Checkout$/ });
  fireEvent.pointerDown(tab, { button: 0, pointerId: 1 });
  fireEvent.pointerUp(tab, { button: 0, pointerId: 1 });
  fireEvent.click(tab);
  s.press("z", { ctrlKey: true });
  await waitFor(() => expect(s.saved.text).toBe(BOARD));
});

// ----- From my database and From Mermaid (Tasks 9 and 10)

test("from_my_database_closes_the_shelf_and_opens_the_dialog", async () => {
  const onFromDatabase = vi.fn();
  const s = setup(BOARD, LAYOUT, { onFromDatabase });
  await opened();
  await openShelf(s);
  act(() => shelf.props!.onAdd({ kind: "fromDatabase" }));
  await waitFor(() => expect(s.panel()).toBeNull());
  expect(onFromDatabase).toHaveBeenCalledTimes(1);
  expect(onFromDatabase.mock.calls[0][0].file).toBe("board");
});

test("a_database_add_is_refused_while_the_assistant_edits", async () => {
  let add: DatabaseAdd | null = null;
  const s = setup(BOARD, LAYOUT, { onFromDatabase: (a) => (add = a) });
  await opened();
  lock.on = true;
  await openShelf(s);
  act(() => shelf.props!.onAdd({ kind: "fromDatabase" }));
  await waitFor(() => expect(s.toast()?.textContent).toBe(EDIT_MESSAGES.locked));
  expect(add).toBeNull();
  // The dialog's own run, should one be open, refuses too.
  lock.on = false;
  // A render, so the lock is read again.
  fireEvent.click(s.tool("Hand"));
  act(() => shelf.props!.onAdd({ kind: "fromDatabase" }));
  await waitFor(() => expect(add).not.toBeNull());
  lock.on = true;
  // A render so the lock is read.
  fireEvent.click(s.tool("Hand"));
  let said: string | null = null;
  await act(async () => {
    said = await add!.run(SHOP);
  });
  expect(said).toBe(EDIT_MESSAGES.locked);
  expect(s.saved.text).toBe(BOARD);
});

test("a_database_add_toasts_with_undo_and_escape_on_its_dialog_keeps_the_board_selection", async () => {
  function Host({ children }: { children: (open: (a: DatabaseAdd) => void) => ReactNode }) {
    const [dlg, setDlg] = useState<DatabaseAdd | null>(null);
    return (
      <>
        {children(setDlg)}
        {dlg && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="From my database"
            tabIndex={-1}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setDlg(null);
              }
            }}
          >
            <button type="button" onClick={() => void dlg.run(SHOP)}>
              Read
            </button>
          </div>
        )}
      </>
    );
  }
  let open: (a: DatabaseAdd) => void = () => {};
  const s = setup(CHECKOUT, null, {
    around: (tab) => (
      <Host>
        {(o) => {
          open = o;
          return tab;
        }}
      </Host>
    ),
    onFromDatabase: (a) => open(a),
  });
  await opened([["Flowchart", "Checkout"]]);
  await waitFor(() => expect(s.isSelected("Checkout")).toBe(true));
  await openShelf(s);
  act(() => shelf.props!.onAdd({ kind: "fromDatabase" }));
  const dlg = await screen.findByRole("dialog", { name: "From my database" });
  fireEvent.keyDown(within(dlg).getByRole("button", { name: "Read" }), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "From my database" })).toBeNull());
  expect(s.isSelected("Checkout")).toBe(true);
  // Read: the frame is added, selected, and its toast has Undo.
  await openShelf(s);
  act(() => shelf.props!.onAdd({ kind: "fromDatabase" }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "From my database" })).getByRole("button", { name: "Read" }));
  await waitFor(() => expect(s.isSelected("shop")).toBe(true));
  const undo = within(s.toast() as HTMLElement).getByRole("button", { name: "Undo" });
  fireEvent.click(undo);
  await waitFor(() => expect(s.saved.text).toBe(CHECKOUT));
});

test("from_mermaid_closes_the_shelf_and_opens_add_mode", async () => {
  const onMermaidFrame = vi.fn();
  const s = setup(BOARD, LAYOUT, { onMermaidFrame });
  await opened();
  await openShelf(s);
  act(() => shelf.props!.onAdd({ kind: "fromMermaid" }));
  await waitFor(() => expect(s.panel()).toBeNull());
  expect(onMermaidFrame).toHaveBeenCalledTimes(1);
  expect(onMermaidFrame.mock.calls[0][0]).toMatchObject({ file: "board" });
});

test("a_mermaid_add_toasts_selects_and_glides", async () => {
  let add: MermaidAdd | null = null;
  const s = setup(BOARD, LAYOUT, { onMermaidFrame: (a) => (add = a) });
  await opened();
  await openShelf(s);
  act(() => shelf.props!.onAdd({ kind: "fromMermaid" }));
  await waitFor(() => expect(add).not.toBeNull());
  const glide = vi.spyOn(s.inst(), "setCenter");
  await act(async () => {
    await add!.run('diagram flow "Imported"\nA\nB\nA > B\n', "TB");
  });
  await waitFor(() => expect(s.isSelected("Imported")).toBe(true));
  await waitFor(() => expect(glide).toHaveBeenCalled());
  expect(s.toast()?.textContent).toContain("Added Imported.");
  expect(within(s.toast() as HTMLElement).getByRole("button", { name: "Undo" })).toBeTruthy();
});

test("a_mermaid_add_is_refused_while_the_assistant_edits", async () => {
  const onMermaidFrame = vi.fn();
  const s = setup(BOARD, LAYOUT, { onMermaidFrame });
  await opened();
  lock.on = true;
  await openShelf(s);
  act(() => shelf.props!.onAdd({ kind: "fromMermaid" }));
  await waitFor(() => expect(s.toast()?.textContent).toBe(EDIT_MESSAGES.locked));
  expect(onMermaidFrame).not.toHaveBeenCalled();
  expect(s.saved.text).toBe(BOARD);
});

// ----- fix round 1

test("a_silent_no_op_says_nothing_and_keeps_the_shelf_open", async () => {
  // T1: `addFrames` answers { refused: "" } when nothing could be written for no reason to show.
  const s = setup();
  await opened();
  const p = await openShelf(s);
  flowDoc.refuseAll = true;
  // A render of the board, so the hook's answer is the one read.
  fireEvent.click(s.tool("Hand"));
  fireEvent.click(s.tool("Select"));
  expect(s.panel()).not.toBeNull();
  fireEvent.click(within(p).getByRole("option", { name: KIND_HEAD.flow.name }));
  act(() => shelf.props!.onAdd({ kind: "template", id: "board-online-shop" }));
  await new Promise((r) => setTimeout(r, 80));
  expect(s.toast()).toBeNull();
  expect(s.panel()).not.toBeNull();
  expect(s.saved.text).toBe(BOARD);
});

test("an_icon_add_lands_in_its_frame_across_a_fast_tab_click", async () => {
  const s = setup();
  await opened();
  await pickFrame(s, "Checkout");
  await openShelf(s);
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const real = LangClient.prototype.flowEdit;
  const ask = vi.spyOn(LangClient.prototype, "flowEdit").mockImplementation(async function (this: LangClient, ...args: Parameters<LangClient["flowEdit"]>) {
    await gate;
    return real.apply(this, args);
  });
  try {
    act(() => shelf.props!.onAdd({ kind: "icon", name: "brand-postgresql" }));
    await waitFor(() => expect(ask).toHaveBeenCalled());
    const tab = await screen.findByRole("button", { name: / Login$/ });
    fireEvent.pointerDown(tab, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(tab, { button: 0, pointerId: 1 });
    fireEvent.click(tab);
    release();
    await waitFor(() => expect(s.isSelected("Login")).toBe(true));
    await waitFor(() => expect(s.saved.text).toContain("PostgreSQL [icon: brand-postgresql]"));
    expect(s.saved.text.indexOf("PostgreSQL")).toBeLessThan(s.saved.text.indexOf('diagram sequence "Login"'));
    // The add said so and the Shelf closed.
    await waitFor(() => expect(s.panel()).toBeNull());
    expect(s.toast()?.textContent).toContain("Added PostgreSQL.");
  } finally {
    ask.mockRestore();
  }
});

test("an_icon_click_goes_to_the_frame_selected_when_its_title_arrives", async () => {
  resetIcons();
  let release = () => {};
  gates.icons = new Promise<void>((r) => (release = r));
  const s = setup();
  await opened();
  await pickFrame(s, "Login");
  await openShelf(s);
  act(() => shelf.props!.onAdd({ kind: "icon", name: "brand-postgresql" }));
  // The title is still loading when a flowchart is selected.
  await pickFrame(s, "Checkout");
  release();
  await waitFor(() => expect(s.saved.text).toContain("PostgreSQL [icon: brand-postgresql]"));
  expect(s.saved.text.indexOf("PostgreSQL")).toBeLessThan(s.saved.text.indexOf('diagram sequence "Login"'));
  expect(s.layoutNow().sketches ?? []).toHaveLength(0);
});

test("add_switches_a_more_shapes_shelf_to_diagrams", async () => {
  const s = setup(CHECKOUT, null);
  await opened([["Flowchart", "Checkout"]]);
  await waitFor(() => expect(within(s.bar()).queryByRole("button", { name: "More shapes" })).not.toBeNull());
  fireEvent.click(s.tool("More shapes"));
  let p = await screen.findByRole("dialog", { name: "Add to the board" });
  expect(within(p).getByRole("tab", { name: /^Shapes/ }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(s.tool("Add"));
  await waitFor(() => expect(within(s.panel()!).getByRole("tab", { name: /^Diagrams/ }).getAttribute("aria-selected")).toBe("true"));
  p = s.panel()!;
  expect(s.tool("Add").getAttribute("aria-expanded")).toBe("true");
  expect(s.tool("More shapes").getAttribute("aria-expanded")).toBe("false");
  // Add again now closes it.
  fireEvent.click(s.tool("Add"));
  await waitFor(() => expect(s.panel()).toBeNull());
});

test("a_shape_that_needs_a_selection_shows_disabled_and_says_why", async () => {
  const s = setup(CHECKOUT, null);
  await opened([["Flowchart", "Checkout"]]);
  await waitFor(() => expect(within(s.bar()).queryByRole("button", { name: "More shapes" })).not.toBeNull());
  fireEvent.click(s.tool("More shapes"));
  const p = await screen.findByRole("dialog", { name: "Add to the board" });
  const group = within(p).getByRole("option", { name: "Group" });
  expect(group.getAttribute("aria-disabled")).toBe("true");
  expect(group.getAttribute("title")).toBe("Select shapes first");
  expect(group.getAttribute("aria-description")).toBe("Select shapes first");
  expect(group.textContent).toContain("Select shapes first");
  expect(group.getAttribute("draggable")).toBe("false");
  // Enter on it adds nothing: the reason shows and the Shelf stays open.
  const text = s.saved.text;
  const search = within(p).getByRole("combobox");
  for (let i = 0; i < 20 && search.getAttribute("aria-activedescendant") !== group.id; i++) fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(search.getAttribute("aria-activedescendant")).toBe(group.id);
  fireEvent.keyDown(search, { key: "Enter" });
  await waitFor(() => expect(s.toast()?.textContent).toBe("Group: select shapes first."));
  expect(s.panel()).not.toBeNull();
  expect(s.saved.text).toBe(text);
  // With a shape selected it is enabled.
  act(() => canvas.props!.onSelect!(["Cart"]));
  await waitFor(() => expect(within(s.panel()!).getByRole("option", { name: "Group" }).getAttribute("aria-disabled")).toBeNull());
});

// ----- final review: one add per press (Important 1)

/** How many frames in `text` have the title `title` exactly. */
const framesTitled = (text: string, title: string) => text.split(`"${title}"`).length - 1;

test("a_double_click_on_a_diagrams_card_adds_one_frame_and_one_undo_entry", async () => {
  const s = setup();
  await opened();
  const p = await openShelf(s);
  const card = within(p).getByRole("option", { name: KIND_HEAD.er.name });
  fireEvent.click(card);
  fireEvent.click(card);
  const title = DIAGRAM_KIND_WORD.er;
  await waitFor(() => expect(s.isSelected(title)).toBe(true));
  await waitFor(() => expect(s.toast()?.textContent).toContain(`Added ${title}.`));
  await waitFor(() => expect(framesTitled(s.saved.text, title)).toBe(1));
  await new Promise((r) => setTimeout(r, 80));
  expect(framesTitled(s.saved.text, title)).toBe(1);
  expect(s.saved.text).not.toContain(`"${title} 2"`);
  fireEvent.click(within(s.toast() as HTMLElement).getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(s.saved.text).toBe(BOARD));
});

test("a_double_click_on_a_board_card_adds_it_once_and_one_undo_entry", async () => {
  const s = setup();
  await opened();
  const p = await openShelf(s);
  const shop = templateById("board-online-shop")!;
  const card = within(p).getByRole("option", { name: shop.name });
  fireEvent.click(card);
  fireEvent.click(card);
  await waitFor(() => expect(s.isSelected("Orders ERD")).toBe(true));
  await waitFor(() => expect(s.toast()?.textContent).toContain(`Added ${shop.name}.`));
  await waitFor(() => expect(framesTitled(s.saved.text, "Orders ERD")).toBe(1));
  await new Promise((r) => setTimeout(r, 80));
  for (const t of ["Orders ERD", "Checkout flow", "Pay sequence"]) expect(framesTitled(s.saved.text, t)).toBe(1);
  expect(s.saved.text).not.toContain('"Orders ERD 2"');
  fireEvent.click(within(s.toast() as HTMLElement).getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(s.saved.text).toBe(BOARD));
});

test("enter_held_on_a_shelf_card_adds_one_frame_and_one_undo_entry", async () => {
  const s = setup();
  await opened();
  const p = await openShelf(s);
  const search = within(p).getByRole("combobox");
  const first = document.getElementById(search.getAttribute("aria-activedescendant")!)!;
  expect(first.getAttribute("aria-label")).toBe(KIND_HEAD.flow.name);
  fireEvent.keyDown(search, { key: "Enter" });
  fireEvent.keyDown(search, { key: "Enter", repeat: true });
  fireEvent.keyDown(search, { key: "Enter", repeat: true });
  await waitFor(() => expect(s.toast()?.textContent).toContain("Added Flowchart."));
  await waitFor(() => expect(framesTitled(s.saved.text, "Flowchart")).toBe(1));
  await new Promise((r) => setTimeout(r, 80));
  expect(framesTitled(s.saved.text, "Flowchart")).toBe(1);
  expect(s.saved.text).not.toContain('"Flowchart 2"');
  fireEvent.click(within(s.toast() as HTMLElement).getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(s.saved.text).toBe(BOARD));
});

test("enter_twice_in_the_space_box_adds_once", async () => {
  const s = setup();
  await opened();
  fireEvent.pointerMove(s.canvasEl(), { clientX: 300, clientY: 200 });
  s.press("/");
  const box = await screen.findByRole("dialog", { name: "Add here" });
  const input = within(box).getByRole("combobox");
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(s.toast()?.textContent).toContain("Added Flowchart."));
  await waitFor(() => expect(framesTitled(s.saved.text, "Flowchart")).toBe(1));
  await new Promise((r) => setTimeout(r, 80));
  expect(framesTitled(s.saved.text, "Flowchart")).toBe(1);
  expect(s.saved.text).not.toContain('"Flowchart 2"');
  fireEvent.click(within(s.toast() as HTMLElement).getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(s.saved.text).toBe(BOARD));
});

// ----- final review: Minors 1, 2 and 7

test("menu_keys_in_the_shelf_search_stay_in_the_shelf", async () => {
  const s = setup();
  await opened();
  await pickFrame(s, "Checkout");
  const p = await openShelf(s);
  const search = within(p).getByRole("combobox");
  fireEvent.keyDown(search, { key: "ContextMenu" });
  fireEvent.keyDown(search, { key: "F10", shiftKey: true });
  await new Promise((r) => setTimeout(r, 30));
  // No board menu opened behind it, and the Shelf keeps the keys.
  expect(screen.queryAllByRole("menu")).toHaveLength(0);
  expect(s.panel()).not.toBeNull();
  expect(document.activeElement).toBe(search);
});

test("a_database_add_under_a_taken_title_toasts_the_title_it_got", async () => {
  let add: DatabaseAdd | null = null;
  const s = setup([BOARD, 'diagram er "shop"\ncustomers {\n  id int pk\n}\n'].join("\n"), LAYOUT, { onFromDatabase: (a) => (add = a) });
  await opened([["Flowchart", "Checkout"], ["Sequence", "Login"]]);
  await openShelf(s);
  act(() => shelf.props!.onAdd({ kind: "fromDatabase" }));
  await waitFor(() => expect(add).not.toBeNull());
  await act(async () => {
    await add!.run(SHOP);
  });
  await waitFor(() => expect(s.saved.text).toContain('diagram er "shop 2"'));
  await waitFor(() => expect(s.toast()?.textContent).toContain("Added shop 2: 1 table."));
});

test("an_add_undone_before_it_is_drawn_is_not_picked_up_when_redone", async () => {
  const s = setup();
  await opened();
  const p = await openShelf(s);
  // Parses wait, so the add's frame is not drawn before it is undone.
  const held: (() => void)[] = [];
  let holding = true;
  const real = LangClient.prototype.flow;
  const parse = vi.spyOn(LangClient.prototype, "flow").mockImplementation(async function (this: LangClient, ...args: Parameters<LangClient["flow"]>) {
    if (holding) await new Promise<void>((r) => held.push(r));
    return real.apply(this, args);
  });
  try {
    fireEvent.click(within(p).getByRole("option", { name: KIND_HEAD.er.name }));
    await waitFor(() => expect(s.panel()).toBeNull());
    s.canvasEl().focus();
    s.press("z", { ctrlKey: true });
    holding = false;
    act(() => held.splice(0).forEach((r) => r()));
    await waitFor(() => expect(s.saved.text).toBe(BOARD));
    await new Promise((r) => setTimeout(r, 50));
    // Redo brings the frame back: it is drawn, but not selected and toasted as a fresh add with an Undo.
    s.press("y", { ctrlKey: true });
    const title = DIAGRAM_KIND_WORD.er;
    await screen.findByRole("button", { name: new RegExp(` ${title}$`) });
    await new Promise((r) => setTimeout(r, 80));
    expect(s.toast()?.textContent ?? "").not.toContain(`Added ${title}.`);
    expect(s.isSelected(title)).toBe(false);
  } finally {
    parse.mockRestore();
  }
});
