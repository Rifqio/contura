// One origin for the whole board. Canvas coordinates are board coordinates; the live
// frame's shapes hang from one zero-size anchor at its `at`, so a switch moves neither the sketch layer nor the view,
// and every gesture in the live frame converts with `toLive` (board minus `at`). FlowTab on a two-frame board whose
// live frame stands off the board's origin, at (-400, 120), with the fake worker.
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { IconEntry } from "../../api/types";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import type { Box } from "../../diagram/export/scene";
import { LangClient } from "../../lang/client";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { patientFile } from "../../test/load";
import { mockReactFlowDom } from "../../test/reactFlow";
import FlowTab from "../FlowTab";
import { resetIcons } from "../icons";
import { boardFrameId, LIVE_ANCHOR_ID } from "./boardScene";
import { SHELF_DRAG_TYPE, type ShelfItem } from "./shelf/types";
import { SKETCH_LAYER_ID } from "./sketches";

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
// The dialog has its own tests: here only what it is handed.
const dialog = vi.hoisted(() => ({ onScreen: [] as (Box | undefined)[] }));
vi.mock("../../diagram/export/PublishDialog", () => ({
  default: (p: { onScreen?: Box }) => {
    dialog.onScreen.push(p.onScreen);
    return <div role="dialog" aria-label="Publish image" />;
  },
}));

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
});
beforeEach(() => {
  resetIcons();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  canvas.props = null;
  canvas.instance = null;
  dialog.onScreen.length = 0;
});

const ICONS: IconEntry[] = [{ name: "brand-postgresql", set: "tabler", title: "PostgreSQL", licence: null, aliasOf: null }];

type Pt = { x: number; y: number };
const CHECKOUT = 'diagram flow "Checkout"\nCart\nPay\nCart > Pay\n';
const LOGIN = 'diagram sequence "Login"\nApp -> Api\n';
const BOARD = [CHECKOUT, LOGIN].join("\n");
/** Checkout, off the board's origin, with room between its shapes; a sketch far from both frames. */
const AT: Pt = { x: -400, y: 120 };
const LAYOUT = JSON.stringify({
  version: 2,
  frames: {
    Checkout: { at: AT, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 400, y: 300 } }, style: "modern", direction: "TB" },
    Login: { at: { x: 700, y: 0 }, nodes: {}, style: "modern", direction: "TB" },
  },
  sketches: [{ id: "s1", kind: "rect", x: 300, y: 900, w: 120, h: 80 }],
});

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
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={new LangClient(() => fakeWorker())} />
    </div>,
  );
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const rootEl = () => utils.container.querySelector(".diagram-canvas") as HTMLElement;
  const pane = () => utils.container.querySelector(".react-flow__pane") as HTMLElement;
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const layoutNow = () => JSON.parse(saved.layout ?? '{"frames":{},"sketches":[]}');
  const inst = () => canvas.instance!;
  const nodeOf = (id: string) => canvas.props!.nodes.find((n) => n.id === id);
  const elOf = (id: string) => [...utils.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === id) ?? null;
  /** A frame's box on the canvas (board units). */
  const boxOf = (title: string) => {
    const n = nodeOf(boardFrameId(title))!;
    return { x: n.position.x, y: n.position.y, w: Number(n.style?.width), h: Number(n.style?.height) };
  };
  const isSelected = (title: string) => screen.queryAllByRole("button", { name: new RegExp(` ${title}$`) }).some((b) => b.getAttribute("aria-current") === "true");
  /** A screen point on the board: the canvas's flow position, now board units. */
  const flow = (p: Pt) => inst().screenToFlowPosition(p);
  /** The canvas as a browser lays it out: 800 by 600 at the page's corner. */
  const sized = () =>
    vi.spyOn(canvasEl(), "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} } as DOMRect);
  /** React Flow's own box laid out (jsdom has none), so a drag in its middle does not auto-pan. */
  const paneBounds = () => {
    const el = utils.container.querySelector(".react-flow") as HTMLElement;
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} } as DOMRect);
  };
  return { ...utils, saved, canvasEl, rootEl, pane, press, layoutNow, inst, nodeOf, elOf, boxOf, isSelected, flow, sized, paneBounds };
}
type Setup = ReturnType<typeof setup>;

/** Frame-local: a board point less the live frame's `at`. */
const toLive = (p: Pt, at: Pt = AT): Pt => ({ x: p.x - at.x, y: p.y - at.y });
const near = (a: number, b: number, by = 1.5) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(by);

async function opened(titles: [string, string][] = [["Flowchart", "Checkout"], ["Sequence", "Login"]]) {
  for (const [k, t] of titles) await screen.findByRole("button", { name: `${k} ${t}` });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await waitFor(() => expect(canvas.props!.nodes.some((n) => n.type === "boardFrame")).toBe(true));
}

async function pickFrame(s: Setup, title: string, first?: string) {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(` ${title}$`) }));
  await waitFor(() => expect(s.isSelected(title)).toBe(true));
  if (first) await waitFor(() => expect(s.nodeOf(first)).toBeTruthy());
}

/** A mouse event with its view set, as d3-drag reads it (jsdom refuses the test window as `view`). */
function mouse(type: string, target: EventTarget, init: MouseEventInit) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(e, "view", { get: () => window });
  act(() => {
    target.dispatchEvent(e);
  });
}

/** A data transfer carrying a Shelf item, as a browser would. */
function carrying(item: ShelfItem) {
  const store = new Map([[SHELF_DRAG_TYPE, JSON.stringify(item)]]);
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

function dropAtScreen(s: Setup, dt: ReturnType<typeof carrying>, p: Pt) {
  for (const type of ["dragEnter", "dragOver", "drop"] as const) {
    const ev = createEvent[type](s.rootEl(), { dataTransfer: dt });
    Object.defineProperty(ev, "clientX", { value: p.x });
    Object.defineProperty(ev, "clientY", { value: p.y });
    fireEvent(s.rootEl(), ev);
  }
}

/** A live shape's centre in its frame, from the canvas node (frame-local position plus half its size). */
function centreOf(s: Setup, id: string): Pt {
  const n = s.nodeOf(id)!;
  return { x: n.position.x + (n.initialWidth ?? 0) / 2, y: n.position.y + (n.initialHeight ?? 0) / 2 };
}

/** A free board point inside Checkout, between Cart (0, 0) and Pay (400, 300) in its own units. */
const FREE_LOCAL: Pt = { x: 250, y: 40 };
const freeBoard = (): Pt => ({ x: AT.x + FREE_LOCAL.x, y: AT.y + FREE_LOCAL.y });

test("a_switch_never_moves_the_view", async () => {
  const s = setup();
  await opened();
  await pickFrame(s, "Checkout", "Cart");
  await new Promise((r) => setTimeout(r, 30));
  const before = { ...s.inst().getViewport() };
  const layer = s.nodeOf(SKETCH_LAYER_ID);
  expect(layer?.position).toEqual({ x: 0, y: 0 });
  await pickFrame(s, "Login", "App");
  await waitFor(() => expect(s.nodeOf("Cart")).toBeUndefined());
  await new Promise((r) => setTimeout(r, 30));
  // The same view and the very same layer node: nothing on the board moved on the canvas.
  expect(s.inst().getViewport()).toEqual(before);
  expect(s.nodeOf(SKETCH_LAYER_ID)).toBe(layer);
  // Nothing live: the same again.
  fireEvent.click(s.pane(), { clientX: 790, clientY: 590 });
  await waitFor(() => expect(s.isSelected("Login")).toBe(false));
  await new Promise((r) => setTimeout(r, 30));
  expect(s.inst().getViewport()).toEqual(before);
});

test("shift_1_fits_the_same_before_and_after_the_anchor", async () => {
  const s = setup();
  await opened();
  // Nothing live: the fit of every frame's box and the sketch.
  const fit = async () => {
    await act(async () => {
      await s.inst().setViewport({ x: 7, y: 9, zoom: 0.5 });
    });
    fireEvent.keyDown(s.rootEl(), { key: "!", code: "Digit1", shiftKey: true });
    await waitFor(() => expect(s.inst().getViewport().zoom).not.toBe(0.5));
    return { ...s.inst().getViewport() };
  };
  const none = await fit();
  await pickFrame(s, "Checkout", "Cart");
  // Checkout live, its shapes hanging from the anchor at (-400, 120): the fit is the same view.
  const live = await fit();
  near(live.x, none.x, 0.01);
  near(live.y, none.y, 0.01);
  near(live.zoom, none.zoom, 0.0001);
});

test("a_drop_lands_where_it_is_dropped_in_the_live_frame", async () => {
  const s = setup();
  await opened();
  await pickFrame(s, "Checkout", "Cart");
  // Every live shape hangs from the anchor at the frame's `at`.
  expect(s.nodeOf(LIVE_ANCHOR_ID)?.position).toEqual(AT);
  expect(s.nodeOf("Cart")?.parentId).toBe(LIVE_ANCHOR_ID);
  const p = s.inst().flowToScreenPosition(freeBoard());
  dropAtScreen(s, carrying({ kind: "icon", name: "brand-postgresql" }), p);
  await waitFor(() => expect(s.saved.text).toContain("PostgreSQL [icon: brand-postgresql]"));
  await waitFor(() => expect(s.nodeOf("PostgreSQL")).toBeTruthy());
  // Its centre is the drop point in the frame's own units, within the grid it snaps to.
  const want = toLive(s.flow(p));
  const c = centreOf(s, "PostgreSQL");
  near(c.x, want.x, 8);
  near(c.y, want.y, 8);
  const kept = s.layoutNow().frames.Checkout.nodes.PostgreSQL;
  near(kept.x, s.nodeOf("PostgreSQL")!.position.x, 0.5);
  expect(s.layoutNow().sketches).toHaveLength(1);
});

test("add_here_paste_and_the_space_box_land_at_the_pointer", async () => {
  const s = setup();
  await opened();
  await pickFrame(s, "Checkout", "Cart");
  // Add here: a double-click on the live frame's space; the pick is centred on it.
  const p = s.inst().flowToScreenPosition(freeBoard());
  act(() => canvas.props!.onPaneDoubleClick!({ screen: p, flow: s.flow(p) }));
  const menu = await screen.findByRole("menu", { name: "Add here" });
  fireEvent.click(within(menu).getAllByRole("menuitem")[0]);
  fireEvent.keyDown(await screen.findByRole("textbox", { name: /^Name the new/ }), { key: "Enter" });
  await waitFor(() => expect(Object.keys(s.layoutNow().frames.Checkout.nodes)).toHaveLength(3));
  const added = Object.keys(s.layoutNow().frames.Checkout.nodes).find((k) => k !== "Cart" && k !== "Pay")!;
  await waitFor(() => expect(s.nodeOf(added)).toBeTruthy());
  const want = toLive(s.flow(p));
  near(centreOf(s, added).x, want.x);
  near(centreOf(s, added).y, want.y);

  // Paste: the pasted block's top left at the pointer, in the frame's units.
  const q = s.inst().flowToScreenPosition({ x: AT.x + 150, y: AT.y + 200 });
  fireEvent.pointerMove(s.canvasEl(), { clientX: q.x, clientY: q.y });
  fireEvent.paste(s.canvasEl(), { clipboardData: { getData: () => "Item" } });
  await waitFor(() => expect(s.layoutNow().frames.Checkout.nodes.Item).toBeTruthy());
  const at = toLive(s.flow(q));
  expect(s.layoutNow().frames.Checkout.nodes.Item).toEqual({ x: Math.round(at.x), y: Math.round(at.y) });

  // The Space box at the pointer: its icon lands in the live frame at the crosshair.
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const r = s.inst().flowToScreenPosition({ x: AT.x + 120, y: AT.y + 330 });
  fireEvent.pointerMove(s.canvasEl(), { clientX: r.x, clientY: r.y });
  s.press(" ");
  now += 100;
  fireEvent.keyUp(s.canvasEl(), { key: " " });
  const box = await screen.findByRole("dialog", { name: "Add here" });
  const input = within(box).getByRole("combobox");
  fireEvent.change(input, { target: { value: "PostgreSQL" } });
  await waitFor(() => expect(within(box).queryAllByRole("option").some((o) => o.getAttribute("aria-label") === "PostgreSQL")).toBe(true));
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(s.nodeOf("PostgreSQL")).toBeTruthy());
  const cross = toLive(s.flow(r));
  near(centreOf(s, "PostgreSQL").x, cross.x, 8);
  near(centreOf(s, "PostgreSQL").y, cross.y, 8);
});

test("a_sketch_drawn_over_a_frame_lands_where_drawn", async () => {
  const s = setup();
  await opened();
  await pickFrame(s, "Checkout", "Cart");
  const bar = screen.getByRole("toolbar", { name: "Board tools" });
  fireEvent.click(within(bar).getByRole("button", { name: "Section" }));
  expect(within(bar).getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("aria-label"))).toEqual(["Section"]);
  // A Section dragged over the live frame, between Cart and Pay: a sketch, in board units.
  const from = { x: AT.x + 200, y: AT.y + 60 };
  const to = { x: AT.x + 380, y: AT.y + 260 };
  const a = s.inst().flowToScreenPosition(from);
  const b = s.inst().flowToScreenPosition(to);
  fireEvent.pointerDown(s.pane(), { clientX: a.x, clientY: a.y, button: 0, pointerId: 1 });
  fireEvent.pointerMove(s.pane(), { clientX: b.x, clientY: b.y, button: 0, pointerId: 1 });
  // The preview is drawn at the board point, as the sketch will be.
  await waitFor(() => expect(s.container.querySelector(".board-sketch-preview")).not.toBeNull());
  const preview = s.container.querySelector(".board-sketch-preview") as HTMLElement | null;
  near(parseFloat(preview!.style.left), s.flow(a).x);
  near(parseFloat(preview!.style.top), s.flow(a).y);
  fireEvent.pointerUp(s.pane(), { clientX: b.x, clientY: b.y, button: 0, pointerId: 1 });
  fireEvent.click(s.pane(), { clientX: b.x, clientY: b.y });
  await waitFor(() => expect(s.layoutNow().sketches).toHaveLength(2));
  const line = s.layoutNow().sketches[1];
  expect(line.kind).toBe("section");
  const pa = s.flow(a);
  const pb = s.flow(b);
  near(line.x, Math.min(pa.x, pb.x));
  near(line.y, Math.min(pa.y, pb.y));
  near(line.w, Math.abs(pb.x - pa.x));
  near(line.h, Math.abs(pb.y - pa.y));
});

test("a_shape_drag_reports_frame_local_positions", async () => {
  const s = setup();
  await opened();
  await pickFrame(s, "Checkout", "Cart");
  await waitFor(() => expect(s.elOf("Cart")).not.toBeNull());
  const zoom = s.inst().getViewport().zoom;
  // Drawn on the board at `at` plus its frame-local place: React Flow reads it through the anchor.
  expect(s.inst().getInternalNode("Cart")!.internals.positionAbsolute).toEqual({ x: AT.x, y: AT.y });
  // The pane laid out as a browser would, the pointer in its middle: no auto-pan. Alt: no guides, so it lands exactly
  // where the pointer took it.
  s.paneBounds();
  mouse("mousedown", s.elOf("Cart")!, { clientX: 400, clientY: 300, button: 0 });
  mouse("mousemove", window, { clientX: 402, clientY: 300, altKey: true });
  mouse("mousemove", window, { clientX: 402 + 60 * zoom, clientY: 300 + 40 * zoom, altKey: true });
  mouse("mouseup", window, { clientX: 402 + 60 * zoom, clientY: 300 + 40 * zoom, altKey: true });
  await waitFor(() => expect(s.layoutNow().frames.Checkout.nodes.Cart).toEqual({ x: 60, y: 40 }));
  expect(s.layoutNow().frames.Checkout.at).toEqual(AT);
  await waitFor(() => expect(s.inst().getInternalNode("Cart")!.internals.positionAbsolute).toEqual({ x: AT.x + 60, y: AT.y + 40 }));
});

test("a_frame_tab_drag_moves_by_the_pointer", async () => {
  const s = setup();
  await opened();
  await pickFrame(s, "Checkout", "Cart");
  await new Promise((r) => setTimeout(r, 30));
  const view = { ...s.inst().getViewport() };
  const zoom = view.zoom;
  const tab = s.elOf(boardFrameId("Checkout"))!.querySelector(".board-frame-tab") as HTMLElement;
  expect(tab).not.toBeNull();
  // The live frame is drawn static while its tab is dragged: the view stays put through that.
  s.paneBounds();
  mouse("mousedown", tab, { clientX: 400, clientY: 300, button: 0 });
  // React Flow starts a drag once the pointer has gone past its threshold.
  mouse("mousemove", window, { clientX: 402, clientY: 300 });
  mouse("mousemove", window, { clientX: 404, clientY: 300 });
  await waitFor(() => expect(s.nodeOf("Cart")).toBeUndefined());
  expect(s.inst().getViewport()).toEqual(view);
  mouse("mousemove", window, { clientX: 402 + 100 * zoom, clientY: 300 + 50 * zoom });
  mouse("mouseup", window, { clientX: 402 + 100 * zoom, clientY: 300 + 50 * zoom });
  // It moved by the pointer, in board units, and is live again where it was let go.
  await waitFor(() => expect(s.layoutNow().frames.Checkout.at).toEqual({ x: AT.x + 100, y: AT.y + 50 }));
  await waitFor(() => expect(s.nodeOf(LIVE_ANCHOR_ID)?.position).toEqual({ x: AT.x + 100, y: AT.y + 50 }));
  expect(s.inst().getViewport()).toEqual(view);
});

test("one_frame_publish_on_screen_is_frame_local", async () => {
  const one = JSON.stringify({
    version: 2,
    frames: { Checkout: { at: { x: 300, y: 0 }, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, style: "modern", direction: "TB" } },
    sketches: [],
  });
  const s = setup(CHECKOUT, one);
  await opened([["Flowchart", "Checkout"]]);
  await pickFrame(s, "Checkout", "Cart");
  s.sized();
  s.press("e", { ctrlKey: true, shiftKey: true });
  await screen.findByRole("dialog", { name: "Publish image" });
  // What's on screen is the visible rect in the frame's own units: board less its `at`.
  const a = s.flow({ x: 0, y: 0 });
  const c = s.flow({ x: 800, y: 600 });
  const got = dialog.onScreen[dialog.onScreen.length - 1]!;
  near(got.x, a.x - 300, 0.01);
  near(got.y, a.y - 0, 0.01);
  near(got.w, c.x - a.x, 0.01);
  near(got.h, c.y - a.y, 0.01);
});

// ----- Fix round 1: the mind map's and the sequence's own pointer gestures map to the live frame (`flowMapper`).

const SEQ = 'diagram sequence "Login"\nparticipant App\nparticipant Api\nparticipant Bank\nApp -> Api: hi\n';
const MIND = 'diagram mindmap "Plan"\nroot Plan\n  Alpha\n  Beta\n';
const GESTURES = [CHECKOUT, SEQ, MIND].join("\n");
const GESTURES_AT = JSON.stringify({
  version: 2,
  frames: {
    Checkout: { at: AT, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 400, y: 300 } }, style: "modern", direction: "TB" },
    Login: { at: { x: 700, y: 120 }, nodes: {}, style: "modern", direction: "TB" },
    Plan: { at: { x: -300, y: 900 }, nodes: {}, style: "modern", direction: "TB" },
  },
  sketches: [],
});

/** A live shape's box on the board: its frame-local place plus the live anchor's. */
function boardBox(s: Setup, id: string) {
  const n = s.inst().getInternalNode(id)!;
  // The size it was laid out at (jsdom measures every node 800 by 600).
  return { ...n.internals.positionAbsolute, w: n.initialWidth ?? 0, h: n.initialHeight ?? 0 };
}
const screenOf = (s: Setup, x: number, y: number) => {
  const p = s.inst().flowToScreenPosition({ x, y });
  return { clientX: p.x, clientY: p.y };
};

test("a_sequence_participant_drag_lands_where_the_pointer_is", async () => {
  const s = setup(GESTURES, GESTURES_AT);
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await pickFrame(s, "Login", "Bank");
  await waitFor(() => expect(s.elOf("Bank")).not.toBeNull());
  expect(s.nodeOf("Bank")?.parentId).toBe(LIVE_ANCHOR_ID);
  const bank = boardBox(s, "Bank");
  const app = boardBox(s, "App");
  // Bank's head, dragged to the gap left of App: Bank goes first.
  const head = bank.y + 20;
  fireEvent.pointerDown(s.elOf("Bank")!, { button: 0, pointerId: 1, ...screenOf(s, bank.x + bank.w / 2, head) });
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, ...screenOf(s, bank.x + bank.w / 2 - 20, head) });
  const gap = app.x + app.w / 2 - 80;
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, ...screenOf(s, gap, head) });
  fireEvent.pointerUp(window, { pointerId: 1, ...screenOf(s, gap, head) });
  await waitFor(() => expect(s.saved.text).toContain('diagram sequence "Login"\nparticipant Bank\nparticipant App\nparticipant Api\n'));
});

test("a_mind_map_topic_drag_lands_where_the_pointer_is", async () => {
  const s = setup(GESTURES, GESTURES_AT);
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await pickFrame(s, "Plan", "Beta");
  await waitFor(() => expect(s.elOf("Beta")).not.toBeNull());
  const beta = boardBox(s, "Beta");
  const alpha = boardBox(s, "Alpha");
  // Beta dropped on Alpha's middle becomes its subtopic.
  const start = screenOf(s, beta.x + beta.w / 2, beta.y + beta.h / 2);
  fireEvent.pointerDown(s.elOf("Beta")!, { button: 0, pointerId: 1, ...start });
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: start.clientX + 10, clientY: start.clientY + 10 });
  const to = screenOf(s, alpha.x + alpha.w / 2, alpha.y + alpha.h / 2);
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, ...to });
  fireEvent.pointerUp(window, { pointerId: 1, ...to });
  await waitFor(() => expect(s.saved.text).toContain("root Plan\n  Alpha\n    Beta\n"));
});

test("the_live_overlay_hangs_from_the_live_frame", async () => {
  const s = setup();
  await opened();
  await pickFrame(s, "Checkout", "Cart");
  // The live frame's overlay sits at its `at`; what is in it is frame-local, as its shapes are.
  const wrap = s.container.querySelector(".flow-overlay-live") as HTMLElement;
  expect([wrap.style.left, wrap.style.top]).toEqual([`${AT.x}px`, `${AT.y}px`]);
  const p = s.inst().flowToScreenPosition(freeBoard());
  act(() => canvas.props!.onPaneDoubleClick!({ screen: p, flow: s.flow(p) }));
  fireEvent.click(within(await screen.findByRole("menu", { name: "Add here" })).getAllByRole("menuitem")[0]);
  await screen.findByRole("textbox", { name: /^Name the new/ });
  const ghost = wrap.querySelector(".flow-ghost") as HTMLElement;
  expect(ghost).not.toBeNull();
  // Centred on the double-click, in Checkout's own units.
  near(parseFloat(ghost.style.left) + parseFloat(ghost.style.width) / 2, FREE_LOCAL.x);
  near(parseFloat(ghost.style.top) + parseFloat(ghost.style.height) / 2, FREE_LOCAL.y);
});
