// Task 6: every frame of a board on one canvas: frames are selected, moved by their title tabs and zoomed to
// (Decisions 2, 3, 5, 28 and 29; Review Focus 5).
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import { useStore } from "@xyflow/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import DiagramCanvas from "../../diagram/DiagramCanvas";
import { BOX_BELOW } from "../../diagram/detail";
import { LangClient } from "../../lang/client";
import { parseFlow } from "../../lang/flow/parse";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { patientFile } from "../../test/load";
import { mockReactFlowDom } from "../../test/reactFlow";
import orderHandover from "../fixtures/order-handover.flow?raw";
import boardCss from "../../styles/flow-board.css?raw";
import { buildFlowGraph } from "../flowNodes";
import FlowTab from "../FlowTab";
import { emptyPositions, serializeFlowLayout } from "../layout";
import { boardFrameId, FRAME_PICTURE_TYPE, FRAME_TAB_H, inFrameId, LIVE_ANCHOR_ID, SKETCH_PICTURE_TYPE, Z_LIVE, Z_SKETCH } from "./boardScene";
import { pictureShapes } from "../../test/framePictures";
import { shownRange } from "./frameView";
import { sketchNodeId } from "./sketches";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
patientFile();

// The real canvas draws; the test keeps its latest props and its React Flow instance, to drive what jsdom cannot.
const canvas = vi.hoisted(() => ({ props: null as DiagramCanvasProps | null, instance: null as ReactFlowInstance | null, ever: null as Set<string> | null }));
vi.mock("../../diagram/DiagramCanvas", async (load) => {
  const real = await load<typeof import("../../diagram/DiagramCanvas")>();
  return {
    ...real,
    default: (p: DiagramCanvasProps) => {
      canvas.props = p;
      if (canvas.ever) for (const n of p.nodes) canvas.ever.add(n.id);
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

let reduce = true;
beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  canvas.props = null;
  canvas.instance = null;
  canvas.ever = null;
  reduce = true;
});

const CHECKOUT = 'diagram flow "Checkout"\nCart\nPay\nCart > Pay\n';
const REFUND = 'diagram flow "Refund"\nAsk\nRefund it\nAsk > Refund it\n';
const SHIPPING = 'diagram flow "Shipping"\nPack\nSend\nPack > Send\n';
const BOARD = [CHECKOUT, REFUND, SHIPPING].join("\n");

function boardLayout(shippingAt = { x: 1200, y: 0 }) {
  return JSON.stringify({
    version: 2,
    frames: {
      Checkout: { at: { x: 0, y: 0 }, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
      Refund: { at: { x: 600, y: 0 }, nodes: { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } }, style: "modern", direction: "TB" },
      Shipping: { at: shippingAt, nodes: { Pack: { x: 0, y: 0 }, Send: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
    },
    sketches: [],
  });
}

function setup(text = BOARD, layout: string | null = boardLayout()) {
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
  });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={client} />
    </div>,
  );
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const props = () => canvas.props!;
  const inst = () => canvas.instance!;
  const nodes = () => props().nodes;
  const ids = () => nodes().map((n) => n.id);
  const nodeOf = (id: string) => nodes().find((n) => n.id === id);
  /** A frame's node on the page (its id holds a NUL, which no CSS selector can name). */
  const frameEl = (key: string) => [...utils.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === boardFrameId(key)) ?? null;
  /** Drawn selected: its title button is the current one (its AI Chat and Code Editor may hide in a short room). */
  const isSelected = (key: string) => {
    const el = frameEl(key);
    return !!el && el.querySelector(".board-frame-title")?.getAttribute("aria-current") === "true";
  };
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  /** Where a node is on screen: its flow position plus the viewport transform. */
  const screenOf = (id: string) => {
    const n = inst().getInternalNode(id)!;
    const { x, y, zoom } = inst().getViewport();
    return { x: n.internals.positionAbsolute.x * zoom + x, y: n.internals.positionAbsolute.y * zoom + y };
  };
  /** A click on the empty canvas at a flow position. */
  const clickAt = (flow: { x: number; y: number }) => {
    const s = inst().flowToScreenPosition(flow);
    const pane = utils.container.querySelector(".react-flow__pane") as HTMLElement;
    fireEvent.click(pane, { clientX: s.x, clientY: s.y });
  };
  /** A frame's box on the canvas, in flow positions. */
  const boxOf = (key: string) => {
    const n = nodeOf(boardFrameId(key))!;
    return { x: n.position.x, y: n.position.y, w: Number(n.style?.width), h: Number(n.style?.height) };
  };
  /** The flow boxes of a static frame's shapes. */
  const shapesOf = (key: string) => {
    const box = boxOf(key);
    // A pictured frame is one image: its shapes are the ones it draws (Plan F Decision 7).
    return nodes()
      .filter((n) => n.parentId === boardFrameId(key))
      .flatMap((n) => (n.type === FRAME_PICTURE_TYPE ? pictureShapes(n, box) : [{ x: box.x + n.position.x, y: box.y + n.position.y, w: n.initialWidth ?? 0, h: n.initialHeight ?? 0 }]));
  };
  const selection = () => props().selection ?? [];
  const tab = (name: string) => screen.findByRole("button", { name });
  return { ...utils, saved, canvasEl, props, inst, nodes, ids, nodeOf, frameEl, isSelected, press, screenOf, clickAt, boxOf, shapesOf, selection, tab };
}
type Setup = ReturnType<typeof setup>;

/** The text the code pane shows: the shown frame's block. */
function shownText(view: EditorView): string {
  const r = shownRange(view.state);
  return r ? view.state.sliceDoc(r.from, r.to) : view.state.doc.toString();
}

/** The board drawn: every frame's tab is on the page and the canvas has its instance. */
async function opened(s: Setup, titles = ["Checkout", "Refund", "Shipping"]) {
  for (const t of titles) await s.tab(`Flowchart ${t}`);
  await waitFor(() => expect(canvas.instance).not.toBeNull());
}

/** Selects a frame by its tab, and waits for its shapes to be live. */
async function pick(s: Setup, title: string, first: string) {
  fireEvent.click(await s.tab(`Flowchart ${title}`));
  await waitFor(() => expect(s.ids()).toContain(first));
  await waitFor(() => expect(s.isSelected(title)).toBe(true));
}

/** A point inside `outer` and every one of `inside`, on none of `avoid`. */
function freePoint(inside: { x: number; y: number; w: number; h: number }[], avoid: { x: number; y: number; w: number; h: number }[]) {
  const x0 = Math.max(...inside.map((b) => b.x));
  const y0 = Math.max(...inside.map((b) => b.y));
  const x1 = Math.min(...inside.map((b) => b.x + b.w));
  const y1 = Math.min(...inside.map((b) => b.y + b.h));
  for (let y = y0 + 4; y < y1; y += 6)
    for (let x = x0 + 4; x < x1; x += 6) if (!avoid.some((a) => x >= a.x - 2 && x <= a.x + a.w + 2 && y >= a.y - 2 && y <= a.y + a.h + 2)) return { x, y };
  throw new Error("no free point");
}

test("three_frames_draw_with_their_tabs", async () => {
  const s = setup();
  await opened(s);
  for (const t of ["Checkout", "Refund", "Shipping"]) {
    expect(s.frameEl(t)).not.toBeNull();
    expect(within(s.frameEl(t)!).getByRole("button", { name: `Flowchart ${t}` })).toBeTruthy();
    expect(s.nodeOf(boardFrameId(t))?.type).toBe("boardFrame");
    expect(s.nodeOf(boardFrameId(t))?.dragHandle).toBe(".board-frame-tab");
  }
  expect(s.ids()).toContain(inFrameId("Refund", "Ask"));
  expect(s.ids()).toContain(inFrameId("Shipping", "Send"));
});

test("a_one_frame_board_opens_selected", async () => {
  const s = setup(orderHandover, null);
  await opened(s, ["Order handover"]);
  await waitFor(() => expect(s.isSelected("Order handover")).toBe(true));
  await waitFor(() => expect(s.ids()).toContain("Order placed"));
});

test("a_three_frame_board_opens_with_none_selected", async () => {
  const s = setup();
  await opened(s);
  for (const t of ["Checkout", "Refund", "Shipping"]) expect(s.isSelected(t)).toBe(false);
  expect(screen.queryByRole("button", { name: /^Code Editor/ })).toBeNull();
  // Every shape is a static frame's: no bare name is drawn.
  for (const id of s.ids()) expect(id.startsWith("\u0000")).toBe(true);
});

test("selecting_another_frame_moves_nothing_on_screen", async () => {
  const s = setup();
  await opened(s);
  const pack = inFrameId("Shipping", "Pack");
  await waitFor(() => expect(s.inst().getInternalNode(pack)).toBeTruthy());
  const before = s.screenOf(pack);
  await pick(s, "Refund", "Ask");
  await waitFor(() => expect(s.inst().getInternalNode("Ask")).toBeTruthy());
  const after = s.screenOf(pack);
  expect(after.x).toBeCloseTo(before.x, 5);
  expect(after.y).toBeCloseTo(before.y, 5);
  // The frame that went live stays put too: its shape is where its static copy was.
  await pick(s, "Checkout", "Cart");
  await waitFor(() => expect(s.inst().getInternalNode(inFrameId("Refund", "Ask"))).toBeTruthy());
  const static_ = s.screenOf(inFrameId("Refund", "Ask"));
  await pick(s, "Refund", "Ask");
  await waitFor(() => expect(s.inst().getInternalNode("Ask")).toBeTruthy());
  const live = s.screenOf("Ask");
  expect(live.x).toBeCloseTo(static_.x, 5);
  expect(live.y).toBeCloseTo(static_.y, 5);
});

test("a_frame_switch_fades_the_canvas", async () => {
  reduce = false;
  const s = setup();
  await opened(s);
  await pick(s, "Refund", "Ask");
  expect(s.canvasEl().classList.contains("is-frame-switch")).toBe(true);
  expect(s.canvasEl().getAttribute("data-switch-ms")).toBe("120");
  // Under reduced motion the switch does not fade.
  reduce = true;
  await pick(s, "Shipping", "Pack");
  expect(s.canvasEl().classList.contains("is-frame-switch")).toBe(false);
});

test("only_flow_tab_sets_manual_z", async () => {
  const s = setup();
  await opened(s);
  expect(s.props().zIndexMode).toBe("manual");
  cleanup();
  let mode: string | null = null;
  function Probe() {
    mode = useStore((st) => st.zIndexMode);
    return null;
  }
  render(
    <div style={{ width: 800, height: 600 }}>
      <DiagramCanvas nodes={[]} edges={[]} nodeTypes={{}}>
        <Probe />
      </DiagramCanvas>
    </div>,
  );
  expect(canvas.props?.zIndexMode).toBeUndefined();
  expect(mode).toBe("basic");
});

test("a_selected_live_node_lifts_inside_the_live_band", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Refund", "Ask");
  for (const n of s.nodes().filter((n) => !n.id.startsWith("\u0000"))) expect(n.zIndex).toBeGreaterThanOrEqual(Z_LIVE);
  act(() => s.props().onSelect!(["Ask"]));
  await waitFor(() => expect(s.selection()).toEqual(["Ask"]));
  const ask = s.nodeOf("Ask")!.zIndex!;
  const other = s.nodeOf("Refund it")!.zIndex!;
  expect(ask).toBeGreaterThan(other);
  expect(ask).toBeGreaterThanOrEqual(Z_LIVE);
  expect(ask).toBeLessThan(Z_SKETCH);
  // Every live line sits in the live band as well.
  for (const e of s.props().edges.filter((e: Edge) => !e.id.startsWith("\u0000"))) expect(e.zIndex).toBeGreaterThanOrEqual(Z_LIVE);
});

test("a_click_on_a_shape_in_another_frame_selects_both", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Checkout", "Cart");
  const [pack] = s.shapesOf("Shipping").filter((_, i) => i === 0);
  const packNode = s.nodes().find((n) => n.id === inFrameId("Shipping", "Pack"))!;
  const box = s.boxOf("Shipping");
  s.clickAt({ x: box.x + packNode.position.x + 10, y: box.y + packNode.position.y + 10 });
  expect(pack).toBeTruthy();
  await waitFor(() => expect(s.isSelected("Shipping")).toBe(true));
  await waitFor(() => expect(s.selection()).toEqual(["Pack"]));
  expect(s.isSelected("Checkout")).toBe(false);
  // The selection survives the switch: it is still there once the new frame's effects have run.
  await waitFor(() => expect(s.ids()).toContain("Pack"));
  expect(s.selection()).toEqual(["Pack"]);
});

test("an_open_inline_edit_commits_on_a_switch", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Refund", "Ask");
  act(() => s.props().onSelect!(["Ask"]));
  await waitFor(() => expect(s.selection()).toEqual(["Ask"]));
  s.press("F2");
  const field = (await screen.findByRole("textbox", { name: /^Rename/ })) as HTMLInputElement;
  fireEvent.change(field, { target: { value: "Asked" } });
  fireEvent.click(await s.tab("Flowchart Shipping"));
  await waitFor(() => expect(s.isSelected("Shipping")).toBe(true));
  await waitFor(() => expect(s.saved.text).toContain('diagram flow "Refund"\nAsked\n'));
  // Frames 0 and 2 are untouched, and the field is gone.
  expect(s.saved.text).toContain(CHECKOUT);
  expect(s.saved.text).toContain(SHIPPING);
  expect(screen.queryByRole("textbox", { name: /^Rename/ })).toBeNull();
});

test("clicks_inside_and_outside_the_selected_frame", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Refund", "Ask");
  act(() => s.props().onSelect!(["Ask"]));
  await waitFor(() => expect(s.selection()).toEqual(["Ask"]));
  // Empty space inside the selected frame: the shapes go, the frame stays.
  const live = s.nodes().filter((n) => !n.id.startsWith("\u0000")).map((n) => ({ x: n.position.x, y: n.position.y, w: n.initialWidth ?? 0, h: n.initialHeight ?? 0 }));
  s.clickAt(freePoint([s.boxOf("Refund")], live));
  await waitFor(() => expect(s.selection()).toEqual([]));
  expect(s.isSelected("Refund")).toBe(true);
  // Empty space inside another frame selects that frame, with no shape.
  s.clickAt(freePoint([s.boxOf("Shipping")], s.shapesOf("Shipping")));
  await waitFor(() => expect(s.isSelected("Shipping")).toBe(true));
  expect(s.selection()).toEqual([]);
  // Outside every frame: nothing is selected.
  const b = s.boxOf("Shipping");
  s.clickAt({ x: b.x + b.w + 400, y: b.y + b.h + 400 });
  await waitFor(() => expect(s.isSelected("Shipping")).toBe(false));
  for (const t of ["Checkout", "Refund"]) expect(s.isSelected(t)).toBe(false);
});

test("esc_goes_up_and_enter_goes_in", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Refund", "Ask");
  act(() => s.props().onSelect!(["Refund it"]));
  await waitFor(() => expect(s.selection()).toEqual(["Refund it"]));
  s.press("Escape");
  await waitFor(() => expect(s.selection()).toEqual([]));
  expect(s.isSelected("Refund")).toBe(true);
  s.press("Escape");
  await waitFor(() => expect(s.isSelected("Refund")).toBe(false));
  await pick(s, "Refund", "Ask");
  s.press("Enter");
  await waitFor(() => expect(s.selection()).toEqual(["Ask"]));
});

test("ctrl_a_selects_the_frame_shapes", async () => {
  const s = setup();
  await opened(s);
  s.press("a", { ctrlKey: true });
  expect(s.selection()).toEqual([]);
  await pick(s, "Refund", "Ask");
  s.press("a", { ctrlKey: true });
  await waitFor(() => expect(s.selection()).toEqual(["Ask", "Refund it"]));
});

test("dragging_a_tab_moves_the_frame_in_one_undo", async () => {
  const s = setup();
  await opened(s);
  const id = boardFrameId("Shipping");
  const was = s.boxOf("Shipping");
  act(() => s.props().onFrameDrag!(id, { x: was.x + 60, y: was.y + 30 }, false));
  act(() => s.props().onFrameDrag!(id, { x: was.x + 100, y: was.y + 50 }, true));
  await waitFor(() => expect(s.boxOf("Shipping")).toMatchObject({ x: was.x + 100, y: was.y + 50 }));
  await waitFor(() => expect(JSON.parse(s.saved.layout!).frames.Shipping.at).toEqual({ x: 1300, y: 50 }));
  s.press("z", { ctrlKey: true });
  // The undo goes to the frame it changed (final review F4): Shipping is back where it was, and selected.
  await waitFor(() => expect(JSON.parse(s.saved.layout!).frames.Shipping.at).toEqual({ x: 1200, y: 0 }));
  await waitFor(() => expect(s.isSelected("Shipping")).toBe(true));
  // The live frame: drawn static while dragged, live again where it was let go.
  await pick(s, "Refund", "Ask");
  const live = s.boxOf("Refund");
  const askAt = s.screenOf("Ask");
  act(() => s.props().onFrameDrag!(boardFrameId("Refund"), { x: live.x + 10, y: live.y }, false));
  await waitFor(() => expect(s.ids()).toContain(inFrameId("Refund", "Ask")));
  expect(s.ids()).not.toContain("Ask");
  // The board's own level of detail: real shapes at every zoom and count, the dragged frame's too (Plan F Decision 1).
  expect(s.props().detailPolicy).toBe("board");
  const moving = s.boxOf("Refund");
  act(() => s.props().onFrameDrag!(boardFrameId("Refund"), { x: moving.x + 40, y: moving.y + 20 }, true));
  await waitFor(() => expect(s.ids()).toContain("Ask"));
  await waitFor(() => expect(s.inst().getInternalNode("Ask")).toBeTruthy());
  // Its first tick drew it static; the canvas's positions after that are the static drawing's.
  await waitFor(() => expect(JSON.parse(s.saved.layout!).frames.Refund.at).toEqual({ x: 640, y: 20 }));
  const zoom = s.inst().getViewport().zoom;
  expect(s.screenOf("Ask").x).toBeCloseTo(askAt.x + 40 * zoom, 5);
  expect(s.screenOf("Ask").y).toBeCloseTo(askAt.y + 20 * zoom, 5);
  // Esc stops a drag: nothing is written, and the frame is live again where it was.
  const again = s.boxOf("Refund");
  act(() => s.props().onFrameDrag!(boardFrameId("Refund"), { x: again.x + 70, y: again.y }, false));
  await waitFor(() => expect(s.ids()).toContain(inFrameId("Refund", "Ask")));
  act(() => s.props().onFrameDrag!(boardFrameId("Refund"), null, true));
  await waitFor(() => expect(s.ids()).toContain("Ask"));
  expect(s.boxOf("Refund")).toMatchObject({ x: again.x, y: again.y });
  expect(JSON.parse(s.saved.layout!).frames.Refund.at).toEqual({ x: 640, y: 20 });
});

test("every_fit_of_a_board_too_big_for_the_least_zoom_opens_at_its_start", async () => {
  // er2000.flow's shape: frames in a row and one far off, too wide to fit even at 10 percent. Shift+1 opens it at its
  // start (Task 3); the menus' "Zoom to fit", labelled Shift+1, must land on the same view, not the empty middle.
  const s = setup(BOARD, boardLayout({ x: 200000, y: 0 }));
  // The far frame is off screen at the open: its tab is not drawn.
  await opened(s, ["Checkout"]);
  const away = () => act(() => void s.inst().setViewport({ x: -5000, y: -3000, zoom: 1 }));
  /** Where the leftmost frame's left edge is on screen. */
  const leftEdge = () => s.inst().flowToScreenPosition({ x: s.boxOf("Checkout").x, y: 0 }).x;
  away();
  fireEvent.keyDown(s.container.querySelector(".diagram-canvas")!, { key: "!", code: "Digit1", shiftKey: true });
  await waitFor(() => expect(s.inst().getViewport().zoom).toBeCloseTo(0.1, 5));
  const shift1 = s.inst().getViewport();
  // The 800 px view (jsdom's) has its margin, 40 px, before the board's start.
  expect(leftEdge()).toBeCloseTo(40, 0);
  // The keyboard menu's Zoom to fit.
  away();
  act(() => s.props().onSelect!([]));
  fireEvent.keyDown(s.canvasEl(), { key: "F10", shiftKey: true });
  fireEvent.click(await screen.findByRole("menuitem", { name: /^Zoom to fit/ }));
  await waitFor(() => expect(s.inst().getViewport()).toEqual(shift1));
  // The canvas menu's.
  away();
  fireEvent.contextMenu(s.container.querySelector(".react-flow__pane")!, { clientX: 400, clientY: 300 });
  fireEvent.click(await screen.findByRole("menuitem", { name: /^Zoom to fit/ }));
  await waitFor(() => expect(s.inst().getViewport()).toEqual(shift1));
});

test("zoom_to_a_frame_too_tall_for_the_least_zoom_opens_at_its_top", async () => {
  // A frame taller than the view holds at 10 percent (the ER limit board's 13,004 by 20,840 ERD): zoom to frame
  // opens it at its tab, as the board opens, not on the middle of its height; its width, which fits, stays centred.
  const tall = JSON.parse(boardLayout()) as { frames: Record<string, { nodes: Record<string, { x: number; y: number }> }> };
  tall.frames.Checkout.nodes.Pay = { x: 0, y: 20000 };
  const s = setup(BOARD, JSON.stringify(tall));
  await opened(s);
  await pick(s, "Checkout", "Cart");
  act(() => s.props().onSelect!([]));
  await waitFor(() => expect(s.isSelected("Checkout")).toBe(true));
  s.press("@", { shiftKey: true, code: "Digit2" });
  await waitFor(() => expect(s.inst().getViewport().zoom).toBeCloseTo(0.1, 5));
  const b = s.boxOf("Checkout");
  const top = s.inst().flowToScreenPosition({ x: b.x, y: b.y }).y;
  // The tab (30 px on screen) sits a margin (30 px of the 600 px view) in from the top.
  expect(top).toBeGreaterThan(30);
  expect(top).toBeLessThan(80);
  const mid = s.inst().flowToScreenPosition({ x: b.x + b.w / 2, y: 0 }).x;
  expect(mid).toBeCloseTo(400, 0);
});

test("shift_2_and_a_tab_double_click_zoom_to_the_frame", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Refund", "Ask");
  // The view stays where it is, so every tab stays on the page (the canvas draws only what is in view).
  const fit = vi.spyOn(s.inst(), "fitBounds").mockResolvedValue(true);
  s.press("@", { shiftKey: true, code: "Digit2" });
  const b = s.boxOf("Refund");
  expect(fit).toHaveBeenCalledTimes(1);
  // The frame with its title tab above it.
  expect(fit.mock.calls[0][0]).toEqual({ x: b.x, y: b.y - FRAME_TAB_H, width: b.w, height: b.h + FRAME_TAB_H });
  expect(fit.mock.calls[0][1]).toMatchObject({ duration: 0 });
  // With a shape selected, Shift+2 is the canvas's own zoom to the selection, not the frame's.
  act(() => s.props().onSelect!(["Ask"]));
  await waitFor(() => expect(s.selection()).toEqual(["Ask"]));
  s.press("@", { shiftKey: true, code: "Digit2" });
  expect(fit).toHaveBeenCalledTimes(1);
  // A double-click on a tab zooms to its frame.
  fireEvent.doubleClick(await s.tab("Flowchart Shipping"));
  await waitFor(() => expect(fit).toHaveBeenCalledTimes(2));
  const sh = s.boxOf("Shipping");
  expect(fit.mock.calls[1][0]).toEqual({ x: sh.x, y: sh.y - FRAME_TAB_H, width: sh.w, height: sh.h + FRAME_TAB_H });
  expect(fit.mock.calls[1][1]).toMatchObject({ duration: 0 });
});

test("the_frame_on_top_takes_the_click", async () => {
  // Shipping is dragged over Refund.
  const s = setup(BOARD, boardLayout({ x: 700, y: 60 }));
  await opened(s);
  const overlap = () => freePoint([s.boxOf("Refund"), s.boxOf("Shipping")], [...s.shapesOf("Refund"), ...s.shapesOf("Shipping")]);
  // Nothing live: the later frame in text order is on top.
  s.clickAt(overlap());
  await waitFor(() => expect(s.isSelected("Shipping")).toBe(true));
  // Refund live: it is on top.
  await pick(s, "Refund", "Ask");
  const live = s.nodes().filter((n) => !n.id.startsWith("\u0000")).map((n) => ({ x: n.position.x, y: n.position.y, w: n.initialWidth ?? 0, h: n.initialHeight ?? 0 }));
  s.clickAt(freePoint([s.boxOf("Refund"), s.boxOf("Shipping")], [...live, ...s.shapesOf("Shipping")]));
  await new Promise((r) => setTimeout(r, 50));
  expect(s.isSelected("Refund")).toBe(true);
  expect(s.isSelected("Shipping")).toBe(false);
  // Its box is drawn above every static frame.
  expect(s.nodeOf(boardFrameId("Refund"))!.zIndex!).toBeGreaterThan(s.nodeOf(boardFrameId("Shipping"))!.zIndex!);
});

test("a_frame_with_problems_shows_its_count", async () => {
  const bad = 'diagram flow "Shipping"\nPack [weird: 1]\nSend [odd: 2]\nPack > Send\n';
  const s = setup([CHECKOUT, REFUND, bad].join("\n"));
  await opened(s);
  await waitFor(() => expect(within(s.frameEl("Shipping")!).getByLabelText("2 problems")).toBeTruthy());
  expect(within(s.frameEl("Checkout")!).queryByLabelText(/problems?$/)).toBeNull();
  expect(within(s.frameEl("Refund")!).queryByLabelText(/problems?$/)).toBeNull();
});

test("the_minimap_shows_for_one_frame_only", async () => {
  const one = setup(orderHandover, null);
  await opened(one, ["Order handover"]);
  expect(one.props().showMiniMap).toBe(true);
  expect(one.container.querySelector(".react-flow__minimap")).not.toBeNull();
  cleanup();
  const three = setup();
  await opened(three);
  expect(three.props().showMiniMap).toBe(false);
  expect(three.container.querySelector(".react-flow__minimap")).toBeNull();
});

test("a_one_frame_file_draws_as_today", async () => {
  const positions = emptyPositions();
  const names = ["Order placed", "Paid?", "Ask for payment", "orders", "Handed over", "Send to kitchen", "Pack order"];
  names.forEach((n, i) => (positions[n] = { x: (i % 3) * 240, y: Math.floor(i / 3) * 160 }));
  const layout = serializeFlowLayout({ version: 1, nodes: positions, style: "modern", direction: "TB" });
  const s = setup(orderHandover, layout);
  await opened(s, ["Order handover"]);
  await waitFor(() => expect(s.ids()).toContain("Order placed"));
  // Today's drawing of the same text and layout.
  const today = buildFlowGraph(parseFlow(orderHandover).doc!, positions, "modern", { states: new Map(), sizes: undefined, marks: undefined });
  const shape = (n: Node) => ({ id: n.id, type: n.type, position: n.position, data: n.data, width: n.initialWidth, height: n.initialHeight });
  const line = (e: Edge) => ({ id: e.id, source: e.source, target: e.target, type: e.type, data: e.data, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle });
  const drawnNodes = s.nodes().filter((n) => n.id !== boardFrameId("Order handover") && n.id !== LIVE_ANCHOR_ID);
  expect(drawnNodes.map(shape)).toEqual(today.nodes.map(shape));
  expect(s.props().edges.map(line)).toEqual(today.edges.map(line));
  // Every shape hangs from the live anchor, which sits at the board's (0, 0) for a version 1 file (Plan F Decision 11).
  for (const n of drawnNodes) expect(n.parentId).toBe(LIVE_ANCHOR_ID);
  expect(s.nodeOf(LIVE_ANCHOR_ID)!.position).toEqual({ x: 0, y: 0 });
  // The only other nodes are the frame's own box, under every shape, and the anchor.
  expect(s.nodes().length).toBe(today.nodes.length + 2);
  for (const n of drawnNodes) expect(n.zIndex!).toBeGreaterThan(s.nodeOf(boardFrameId("Order handover"))!.zIndex!);
});

test("moving_the_only_frame_shifts_positions_and_stays_version_1", async () => {
  const positions = emptyPositions();
  const names = ["Order placed", "Paid?", "Ask for payment", "orders", "Handed over", "Send to kitchen", "Pack order"];
  names.forEach((n, i) => (positions[n] = { x: (i % 3) * 240, y: Math.floor(i / 3) * 160 }));
  const layout = serializeFlowLayout({ version: 1, nodes: positions, style: "modern", direction: "TB" });
  const s = setup(orderHandover, layout);
  await opened(s, ["Order handover"]);
  await waitFor(() => expect(s.ids()).toContain("Order placed"));
  const id = boardFrameId("Order handover");
  expect(s.nodeOf(id)!.draggable).toBe(true);
  const was = s.boxOf("Order handover");
  act(() => s.props().onFrameDrag!(id, { x: was.x + 10, y: was.y }, false));
  await waitFor(() => expect(s.ids()).toContain(inFrameId("Order handover", "Order placed")));
  const moving = s.boxOf("Order handover");
  act(() => s.props().onFrameDrag!(id, { x: moving.x + 40, y: moving.y + 20 }, true));
  await waitFor(() => expect(s.ids()).toContain("Order placed"));
  const moved = emptyPositions();
  for (const n of names) moved[n] = { x: positions[n].x + 40, y: positions[n].y + 20 };
  await waitFor(() => expect(s.saved.layout).toBe(serializeFlowLayout({ version: 1, nodes: moved, style: "modern", direction: "TB" })));
  expect(s.saved.text).toBe(orderHandover);
  // One undo entry takes the whole move back.
  s.press("z", { ctrlKey: true });
  await waitFor(() => expect(s.saved.layout).toBe(layout));
});

// Two frames with a group of the same name (a copied frame).
const GROUPED = [
  'diagram flow "Checkout"\nKitchen {\n  Cart\n  Pay\n}\nCart > Pay\n',
  'diagram flow "Refund"\nKitchen {\n  Ask\n  Refund it\n}\nAsk > Refund it\n',
  SHIPPING,
].join("\n");

/** A static frame's group title on the page. */
function staticTitle(s: Setup, key: string, group: string) {
  const id = inFrameId(key, `\u0000group:${group}`);
  const node = [...s.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === id);
  return { node: node ?? null, title: node?.querySelector<HTMLElement>(".flow-area-name") ?? null };
}

const stripText = (s: Setup) => (s.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement).textContent ?? "";

test("a_press_on_a_static_group_title_selects_that_frame", async () => {
  const s = setup(GROUPED);
  await opened(s);
  await pick(s, "Checkout", "Cart");
  await waitFor(() => expect(staticTitle(s, "Refund", "Kitchen").title).not.toBeNull());
  const { node, title } = staticTitle(s, "Refund", "Kitchen");
  // Nothing inside a static frame takes pointer events: the press goes through to the canvas.
  expect(node!.classList.contains("board-static")).toBe(true);
  expect(boardCss).toMatch(/\.react-flow__node\.board-static \*[^{]*\{[^}]*pointer-events: none !important/);
  const before = s.saved.text;
  // Where the title is on screen: the group's area, a little in from its corner.
  const area = s.inst().getInternalNode(inFrameId("Refund", "\u0000group:Kitchen"))!.internals.positionAbsolute;
  const at = s.inst().flowToScreenPosition({ x: area.x + 12, y: area.y + 10 });
  fireEvent.pointerDown(title!, { button: 0, clientX: at.x, clientY: at.y });
  fireEvent.click(title!, { clientX: at.x, clientY: at.y });
  await waitFor(() => expect(s.isSelected("Refund")).toBe(true));
  expect(s.isSelected("Checkout")).toBe(false);
  expect(s.selection()).toEqual([]);
  expect(stripText(s)).not.toContain("Kitchen");
  expect(s.saved.text).toBe(before);
});

test("a_static_group_title_never_edits_the_live_group", async () => {
  const s = setup(GROUPED);
  await opened(s);
  await pick(s, "Checkout", "Cart");
  await waitFor(() => expect(staticTitle(s, "Refund", "Kitchen").title).not.toBeNull());
  const before = s.saved.text;
  // A double press (the rename gesture) on the static title.
  const { title } = staticTitle(s, "Refund", "Kitchen");
  fireEvent.pointerDown(title!, { button: 0 });
  fireEvent.pointerDown(title!, { button: 0 });
  await new Promise((r) => setTimeout(r, 50));
  // No rename field opens (the frame bar's own name field aside).
  expect(screen.queryAllByRole("textbox", { name: /name$/ }).filter((e) => !e.closest(".frame-bar"))).toEqual([]);
  expect(stripText(s)).not.toContain("Kitchen");
  expect(s.isSelected("Checkout")).toBe(true);
  // A right-click on it opens no menu of the live group's.
  fireEvent.contextMenu(staticTitle(s, "Refund", "Kitchen").title!, { clientX: 300, clientY: 200 });
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByRole("menu", { name: "Group Kitchen" })).toBeNull();
  expect(stripText(s)).not.toContain("Kitchen");
  expect(s.saved.text).toBe(before);
});

test("the_only_frame_of_a_sequence_keeps_its_tab_still", async () => {
  const s = setup('diagram sequence "Pay"\nparticipant App\nparticipant Api\nApp -> Api : charge\n', null);
  await s.tab("Sequence Pay");
  await waitFor(() => expect(s.nodeOf(boardFrameId("Pay"))).toBeTruthy());
  // A sequence keeps no positions, so its only frame has nothing a drag could move.
  expect(s.nodeOf(boardFrameId("Pay"))!.draggable).toBe(false);
});

test("a_section_under_a_frame_never_takes_its_click", async () => {
  // A Section drawn behind the whole board (FigJam, Miro): it sits under every frame, and the frames win the click.
  const layout = JSON.parse(boardLayout()) as { sketches: unknown[] };
  layout.sketches = [{ id: "s1", kind: "section", x: -400, y: -400, w: 3_000, h: 1_400, text: "Section" }];
  const s = setup(BOARD, JSON.stringify(layout));
  await opened(s);
  // Readable, so the Section is a node (far out the sketch layer is pictured, Task 9 fix 2).
  await act(async () => {
    await s.inst().setViewport({ x: 0, y: 0, zoom: 0.5 });
  });
  await waitFor(() => expect(s.canvasEl().dataset.far ?? "").not.toContain("m"));
  await waitFor(() => expect(s.nodes().some((n) => n.type === SKETCH_PICTURE_TYPE)).toBe(false));
  const el = await waitFor(() => {
    const found = [...s.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === sketchNodeId("s1"));
    expect(found).toBeDefined();
    return found!;
  });
  // Drawn under frame 0's box, in the layer that takes no pointer events.
  expect(s.nodeOf(sketchNodeId("s1"))!.zIndex!).toBeLessThan(s.nodeOf(boardFrameId("Checkout"))!.zIndex!);
  expect(s.nodeOf("\u0000sketches")!.style?.pointerEvents).toBe("none");
  const shape = el.querySelector(".board-sketch-shape") as Element;
  const clickOn = (flow: { x: number; y: number }) => {
    const p = s.inst().flowToScreenPosition(flow);
    fireEvent.pointerDown(shape, { clientX: p.x, clientY: p.y });
    fireEvent.click(shape, { clientX: p.x, clientY: p.y });
  };
  // A press on the Section inside Shipping's box selects Shipping.
  clickOn(freePoint([s.boxOf("Shipping")], s.shapesOf("Shipping")));
  await waitFor(() => expect(s.isSelected("Shipping")).toBe(true));
  // Inside Refund's box: Refund.
  clickOn(freePoint([s.boxOf("Refund")], s.shapesOf("Refund")));
  await waitFor(() => expect(s.isSelected("Refund")).toBe(true));
  expect(s.isSelected("Shipping")).toBe(false);
  // Outside every frame the click selects the Section alone (Task 12): the frames let go.
  expect(s.props().selection).not.toContain(sketchNodeId("s1"));
  const b = s.boxOf("Shipping");
  clickOn({ x: b.x + b.w + 200, y: b.y + 100 });
  await waitFor(() => expect(s.isSelected("Refund")).toBe(false));
  for (const t of ["Checkout", "Shipping"]) expect(s.isSelected(t)).toBe(false);
  await waitFor(() => expect(s.props().selection).toEqual([sketchNodeId("s1")]));
});

test("a_right_click_on_the_live_frame_mid_drag_is_not_a_static_frames", async () => {
  // Task 18a: dragged by its tab the live frame is drawn static, but a pick on it is still the live frame's, never a
  // switch to its own static drawing (which drops the shape selection).
  const s = setup();
  await opened(s);
  await pick(s, "Refund", "Ask");
  act(() => s.props().onSelect!(["Ask"]));
  await waitFor(() => expect(s.selection()).toEqual(["Ask"]));
  const live = s.boxOf("Refund");
  act(() => s.props().onFrameDrag!(boardFrameId("Refund"), { x: live.x + 10, y: live.y }, false));
  await waitFor(() => expect(s.ids()).toContain(inFrameId("Refund", "Ask")));
  const ghost = s.boxOf("Refund");
  const at = freePoint([ghost], s.shapesOf("Refund"));
  act(() => s.props().onContextMenu!({ node: null, screen: s.inst().flowToScreenPosition(at), flow: at, fit() {} }));
  fireEvent.keyDown(document.body, { key: "Escape" });
  const moving = s.boxOf("Refund");
  act(() => s.props().onFrameDrag!(boardFrameId("Refund"), { x: moving.x + 40, y: moving.y }, true));
  await waitFor(() => expect(s.ids()).toContain("Ask"));
  await waitFor(() => expect(s.selection()).toEqual(["Ask"]));
});

test("a_paste_answered_after_a_frame_switch_moves_nothing_in_the_frame_switched_to", async () => {
  // Final review F1: frames A and B both have Step 2 and Step 3. A paste in A that the worker answers once B is
  // selected writes nothing: not A's text, and not B's Step 3 moved to where A's copy would go.
  const A = 'diagram flow "A"\nStep 1\nStep 2\n';
  const B = 'diagram flow "B"\nStep 2\nStep 3\n';
  const text = `${A}\n${B}`;
  const layout = JSON.stringify({
    version: 2,
    frames: {
      A: { at: { x: 0, y: 0 }, nodes: { "Step 1": { x: 0, y: 0 }, "Step 2": { x: 0, y: 120 } }, style: "modern", direction: "TB" },
      B: { at: { x: 600, y: 0 }, nodes: { "Step 2": { x: 0, y: 0 }, "Step 3": { x: 0, y: 120 } }, style: "modern", direction: "TB" },
    },
    sketches: [],
  });
  const s = setup(text, layout);
  await opened(s, ["A", "B"]);
  await pick(s, "A", "Step 1");
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const real = LangClient.prototype.flowEdit;
  const ask = vi.spyOn(LangClient.prototype, "flowEdit").mockImplementation(async function (this: LangClient, ...args: Parameters<LangClient["flowEdit"]>) {
    await gate;
    return real.apply(this, args);
  });
  try {
    fireEvent.pointerMove(s.canvasEl(), { clientX: 900, clientY: 600 });
    fireEvent.paste(s.canvasEl(), { clipboardData: { getData: () => "Step 2" } });
    await waitFor(() => expect(ask).toHaveBeenCalled());
    await pick(s, "B", "Step 3");
    const before = { ...s.nodeOf("Step 3")!.position };
    release();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    expect(s.nodeOf("Step 3")!.position).toEqual(before);
    expect(s.saved.text).toBe(text);
    expect(JSON.parse(s.saved.layout!).frames.B.nodes).toEqual({ "Step 2": { x: 0, y: 0 }, "Step 3": { x: 0, y: 120 } });
    // Nothing to say: the switch was the user's own.
    expect(screen.queryByText(/nothing was pasted/)).toBeNull();
  } finally {
    ask.mockRestore();
  }
});

// ----- Re-review R1 and R2: commits and fallbacks that await the worker stay in their own frame.

/** Selects a frame of any kind by its tab and waits for `first` to be live. */
async function pickTitled(s: Setup, title: string, first: string) {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(` ${title}$`) }));
  await waitFor(() => expect(s.ids()).toContain(first));
  await waitFor(() => expect(s.isSelected(title)).toBe(true));
}
const liveEl = (s: Setup, id: string) => [...s.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === id) ?? null;
/** A press and click on a frame's tab, as a browser sends them. */
async function pressTab(title: string) {
  const tab = await screen.findByRole("button", { name: new RegExp(` ${title}$`) });
  fireEvent.pointerDown(tab, { button: 0, pointerId: 1 });
  fireEvent.pointerUp(tab, { button: 0, pointerId: 1 });
  fireEvent.click(tab);
}
const block = (text: string, title: string) => {
  const from = text.indexOf(`"${title}"`);
  const next = text.indexOf("\ndiagram ", from);
  return text.slice(from, next < 0 ? text.length : next);
};

test("a_details_edit_saved_by_a_press_on_another_tab_lands_in_its_own_frame", async () => {
  const A = 'diagram flow "A"\nCart\nPay\nCart > Pay\n';
  const B = 'diagram flow "B"\nCart\nShip\nCart > Ship\n';
  const text = `${A}\n${B}`;
  const s = setup(text, null);
  await screen.findByRole("button", { name: / B$/ });
  await pickTitled(s, "A", "Cart");
  fireEvent.contextMenu(liveEl(s, "Cart")!, { clientX: 300, clientY: 200 });
  fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Details..." }));
  const panel = await screen.findByRole("dialog", { name: "Edit Cart" });
  fireEvent.change(within(panel).getByRole("textbox", { name: "Name" }), { target: { value: "Basket" } });
  await pressTab("B");
  await waitFor(() => expect(s.isSelected("B")).toBe(true));
  await waitFor(() => expect(block(s.saved.text, "A")).toContain("Basket"));
  expect(block(s.saved.text, "B")).toContain("Cart\n");
  expect(block(s.saved.text, "B")).not.toContain("Basket");
  expect(screen.queryByRole("dialog", { name: /^Edit / })).toBeNull();
});

// C1: a drop onto a group is an awaited commit (`trackCommit`): a tab clicked meanwhile waits for it, so the edit lands
// in its own frame and the other frame is selected after.
const C1_GROUPED = 'diagram flow "A"\nBox {\n  Step 1\n}\nInner {\n  Step 3\n}\nStep 2\n';
const OTHER = 'diagram flow "B"\nStep 2\nStep 3\n';
const C1_LAYOUT = JSON.stringify({
  version: 2,
  frames: {
    A: { at: { x: 0, y: 0 }, nodes: { "Step 1": { x: 0, y: 0 }, "Step 3": { x: 500, y: 0 }, "Step 2": { x: 0, y: 300 } }, style: "modern", direction: "TB" },
    B: { at: { x: 1200, y: 0 }, nodes: { "Step 2": { x: 0, y: 0 }, "Step 3": { x: 0, y: 120 } }, style: "modern", direction: "TB" },
  },
  sketches: [],
});

/** Holds every worker edit until released. */
function holdEdits() {
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const real = LangClient.prototype.flowEdit;
  const ask = vi.spyOn(LangClient.prototype, "flowEdit").mockImplementation(async function (this: LangClient, ...args: Parameters<LangClient["flowEdit"]>) {
    await gate;
    return real.apply(this, args);
  });
  return { ask, release: () => release() };
}

test("a_group_drop_lands_in_its_frame_across_a_fast_switch", async () => {
  const text = `${C1_GROUPED}\n${OTHER}`;
  const s = setup(text, C1_LAYOUT);
  await opened(s, ["A", "B"]);
  await pickTitled(s, "A", "Step 2");
  const held = holdEdits();
  try {
    act(() => {
      s.props().onDrag!("Step 2", 10, 10);
      s.props().onMove!("Step 2", 10, 10);
    });
    await waitFor(() => expect(held.ask).toHaveBeenCalled());
    expect(held.ask.mock.calls[0][2]).toMatchObject({ op: "moveToGroup", name: "Step 2", group: "Box" });
    await pressTab("B");
    held.release();
    await waitFor(() => expect(s.isSelected("B")).toBe(true));
    await waitFor(() => expect(block(s.saved.text, "A")).toMatch(/Box \{\n {2}Step 1\n {2}Step 2\n\}/));
    expect(block(s.saved.text, "B")).toBe('"B"\nStep 2\nStep 3\n');
    expect(JSON.parse(s.saved.layout!).frames.B.nodes).toEqual({ "Step 2": { x: 0, y: 0 }, "Step 3": { x: 0, y: 120 } });
  } finally {
    held.ask.mockRestore();
  }
});

test("a_member_drag_onto_a_group_survives_a_fast_switch", async () => {
  const text = `${C1_GROUPED}\n${OTHER}`;
  const s = setup(text, C1_LAYOUT);
  await opened(s, ["A", "B"]);
  await pickTitled(s, "A", "Step 2");
  const titleOf = (g: string) => s.container.querySelector<HTMLElement>(`.flow-area[aria-label="Group ${g}"] .flow-area-name`);
  await waitFor(() => expect(titleOf("Inner")).not.toBeNull());
  const area = (g: string) => {
    const n = s.nodeOf(`\u0000group:${g}`)!;
    return { x: n.position.x, y: n.position.y, w: n.initialWidth ?? 0, h: n.initialHeight ?? 0 };
  };
  const box = area("Box");
  const inner = area("Inner");
  const dx = box.x + box.w / 2 - (inner.x + inner.w / 2);
  const dy = box.y + box.h / 2 - (inner.y + inner.h / 2);
  const at = (x: number, y: number) => {
    const p = s.inst().flowToScreenPosition({ x, y });
    return { clientX: p.x, clientY: p.y };
  };
  const from = at(inner.x + 20, inner.y + 14);
  const to = at(inner.x + 20 + dx, inner.y + 14 + dy);
  const held = holdEdits();
  try {
    fireEvent.pointerDown(titleOf("Inner")!, { button: 0, buttons: 1, pointerId: 1, ...from });
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: from.clientX + 6, clientY: from.clientY + 3 });
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: (from.clientX + to.clientX) / 2, clientY: (from.clientY + to.clientY) / 2 });
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, ...to });
    fireEvent.pointerUp(window, { button: 0, pointerId: 1, ...to });
    await waitFor(() => expect(held.ask).toHaveBeenCalled());
    expect(held.ask.mock.calls[0][2]).toMatchObject({ op: "moveToGroup", name: "Inner", group: "Box" });
    await pressTab("B");
    held.release();
    await waitFor(() => expect(s.isSelected("B")).toBe(true));
    await waitFor(() => expect(block(s.saved.text, "A")).toMatch(/Box \{\n {2}Step 1\n {2}Inner \{/));
    expect(block(s.saved.text, "B")).not.toContain("Inner");
  } finally {
    held.ask.mockRestore();
  }
});

// C3: a right-click on a shape in a static frame selects that frame and opens that shape's menu in one go (Figma).
test("a_right_click_on_a_static_shape_selects_the_frame_and_opens_its_menu", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Checkout", "Cart");
  await waitFor(() => expect(liveEl(s, inFrameId("Refund", "Ask"))).not.toBeNull());
  const el = liveEl(s, inFrameId("Refund", "Ask"))!;
  const r = s.shapesOf("Refund")[0];
  const p = s.inst().flowToScreenPosition({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  fireEvent.contextMenu(el, { clientX: p.x, clientY: p.y });
  await waitFor(() => expect(s.isSelected("Refund")).toBe(true));
  await waitFor(() => expect(s.selection()).toEqual(["Ask"]));
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByRole("menuitem", { name: "Details..." })).toBeTruthy();
});

test("a_right_click_on_a_pictured_frame_only_selects_the_frame", async () => {
  // Controller ruling (B2 C3, Plan F Decision 7): a pictured static frame is one image, so a right-click over a shape's
  // spot selects the frame alone and opens no shape menu.
  const s = setup();
  await opened(s);
  await pick(s, "Checkout", "Cart");
  const r = s.shapesOf("Refund")[0];
  await act(async () => {
    await s.inst().setViewport({ x: 0, y: 0, zoom: 0.3 });
  });
  await waitFor(() => expect(s.nodes().some((n) => n.parentId === boardFrameId("Refund") && n.type === FRAME_PICTURE_TYPE)).toBe(true));
  const p = s.inst().flowToScreenPosition({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  fireEvent.contextMenu(s.frameEl("Refund")!, { clientX: p.x, clientY: p.y });
  await waitFor(() => expect(s.isSelected("Refund")).toBe(true));
  await new Promise((res) => setTimeout(res, 50));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(s.selection()).toEqual([]);
});

test("a_right_click_on_empty_static_space_only_selects_the_frame", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Checkout", "Cart");
  const at = freePoint([s.boxOf("Refund")], s.shapesOf("Refund"));
  const p = s.inst().flowToScreenPosition(at);
  const frame = s.frameEl("Refund")!;
  fireEvent.contextMenu(frame, { clientX: p.x, clientY: p.y });
  await waitFor(() => expect(s.isSelected("Refund")).toBe(true));
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(s.selection()).toEqual([]);
});

/** The viewport fits `ids`: each shape's box wholly inside the pane (jsdom's 800 by 600, from mockReactFlowDom). */
async function fitsOnScreen(s: Setup, ids: string[]) {
  await waitFor(() => {
    const { zoom } = s.inst().getViewport();
    for (const id of ids) {
      expect(s.inst().getInternalNode(id), id).toBeTruthy();
      const n = s.nodeOf(id)!;
      const p = s.screenOf(id);
      expect(p.x, id).toBeGreaterThanOrEqual(0);
      expect(p.y, id).toBeGreaterThanOrEqual(0);
      expect(p.x + (n.initialWidth ?? 0) * zoom, id).toBeLessThanOrEqual(800);
      expect(p.y + (n.initialHeight ?? 0) * zoom, id).toBeLessThanOrEqual(600);
    }
  });
}

test("a_one_frame_board_off_the_origin_opens_fitted", async () => {
  const layout = JSON.stringify({
    version: 2,
    frames: { Checkout: { at: { x: 5200, y: 0 }, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, style: "modern", direction: "TB" } },
    sketches: [],
  });
  const s = setup(CHECKOUT, layout);
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await waitFor(() => expect(s.ids()).toContain("Cart"));
  await fitsOnScreen(s, ["Cart", "Pay"]);
});

test("a_board_cut_to_one_frame_reopens_fitted", async () => {
  // What a board cut to Shipping saves when Shipping keeps a text size (boardDoc.test: version 2, its `at` kept).
  const layout = JSON.stringify({
    version: 2,
    frames: { Shipping: { at: { x: 5200, y: 300 }, nodes: { Pack: { x: 0, y: 0 }, Send: { x: 0, y: 120 } }, style: "modern", direction: "TB", textSize: "l" } },
    sketches: [],
  });
  const s = setup(SHIPPING, layout);
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await waitFor(() => expect(s.ids()).toContain("Pack"));
  await fitsOnScreen(s, ["Pack", "Send"]);
  // The frame's tab is drawn with it.
  await s.tab("Flowchart Shipping");
});

test("far_static_frames_draw_as_pictures_and_swap_back_in_place", async () => {
  const s = setup();
  await opened(s);
  const ask = inFrameId("Refund", "Ask");
  await waitFor(() => expect(s.ids()).toContain(ask));
  const boxes = ["Checkout", "Refund", "Shipping"].map((k) => s.boxOf(k));
  const shapes = s.shapesOf("Refund");
  const lines = s.props().edges.length;
  expect(lines).toBeGreaterThan(0);
  // Out where their text is far: one picture a static frame, no static lines, the boxes where they were.
  await act(async () => {
    await s.inst().setViewport({ x: 0, y: 0, zoom: 0.3 });
  });
  await waitFor(() => expect(s.ids()).not.toContain(ask));
  for (const k of ["Checkout", "Refund", "Shipping"]) {
    await waitFor(() => expect(s.nodes().filter((n) => n.parentId === boardFrameId(k)).map((n) => n.type)).toEqual([FRAME_PICTURE_TYPE]));
  }
  expect(s.props().edges).toHaveLength(0);
  expect(["Checkout", "Refund", "Shipping"].map((k) => s.boxOf(k))).toEqual(boxes);
  // The picture's shapes are where the shapes were drawn.
  expect(s.shapesOf("Refund")).toEqual(shapes);
  // Back in: every shape and line again, in place.
  await act(async () => {
    await s.inst().setViewport({ x: 0, y: 0, zoom: 1 });
  });
  await waitFor(() => expect(s.ids()).toContain(ask));
  expect(s.shapesOf("Refund")).toEqual(shapes);
  expect(s.props().edges).toHaveLength(lines);
  expect(["Checkout", "Refund", "Shipping"].map((k) => s.boxOf(k))).toEqual(boxes);
});

test("a_board_opening_below_box_below_never_draws_its_static_shapes", async () => {
  // Frames 3,000 apart: the fit lands far below BOX_BELOW.
  const far = JSON.parse(boardLayout({ x: 6000, y: 0 }));
  far.frames.Refund.at = { x: 3000, y: 0 };
  canvas.ever = new Set();
  const s = setup(BOARD, JSON.stringify(far));
  await opened(s);
  await waitFor(() => expect(s.inst().getViewport().zoom).toBeLessThan(0.45));
  await waitFor(() => expect(s.nodes().filter((n) => n.type === FRAME_PICTURE_TYPE)).toHaveLength(3));
  // No canvas update ever held a static frame's shape.
  for (const id of canvas.ever) expect(id.startsWith("\u0000in:") && !id.endsWith("\u0000\u0000picture"), JSON.stringify(id)).toBe(false);
});

test("a_frame_switch_below_box_below_moves_nothing_on_screen", async () => {
  const far = JSON.parse(boardLayout({ x: 6000, y: 0 }));
  far.frames.Refund.at = { x: 3000, y: 0 };
  const s = setup(BOARD, JSON.stringify(far));
  await opened(s);
  await waitFor(() => expect(s.nodes().filter((n) => n.type === FRAME_PICTURE_TYPE)).toHaveLength(3));
  const picture = (k: string) => s.nodes().find((n) => n.parentId === boardFrameId(k) && n.type === FRAME_PICTURE_TYPE)!.id;
  const ship = picture("Shipping");
  await waitFor(() => expect(s.inst().getInternalNode(ship)).toBeTruthy());
  const before = s.screenOf(ship);
  await pick(s, "Refund", "Ask");
  // Refund is live in full; Shipping stays a picture, where it was on screen.
  expect(s.nodes().filter((n) => n.type === FRAME_PICTURE_TYPE)).toHaveLength(2);
  await waitFor(() => expect(s.inst().getInternalNode(ship)).toBeTruthy());
  expect(s.screenOf(ship)).toEqual(before);
});

/** The far board: frames 3,000 apart, so the fit lands below BOX_BELOW. */
function farLayout() {
  const far = JSON.parse(boardLayout({ x: 6000, y: 0 }));
  far.frames.Refund.at = { x: 3000, y: 0 };
  return JSON.stringify(far);
}

test("below_box_below_the_live_frame_draws_in_full", async () => {
  const s = setup(BOARD, farLayout());
  await opened(s);
  await waitFor(() => expect(s.nodes().filter((n) => n.type === FRAME_PICTURE_TYPE)).toHaveLength(3));
  await pick(s, "Refund", "Ask");
  // Plan F ruling 1: the live frame is never fast, below BOX_BELOW too (was Task 18b's fast overview).
  const canvasRoot = () => s.container.querySelector(".diagram-canvas") as HTMLElement;
  // The view has settled below BOX_BELOW and the live frame's line is drawn.
  await waitFor(() => expect(s.inst().getViewport().zoom).toBeLessThan(BOX_BELOW));
  await waitFor(() => expect(s.container.querySelector(".react-flow__edge")).not.toBeNull());
  expect(canvasRoot().classList.contains("is-fast")).toBe(false);
  expect(s.container.querySelector(".react-flow__edge-straight")).toBeNull();
  // Select and drag still work: the live shapes stay selectable and draggable.
  expect(s.nodeOf("Ask")!.selectable).not.toBe(false);
  expect(s.nodeOf("Ask")!.draggable).not.toBe(false);
  // At or above BOX_BELOW the live frame draws in full as well.
  await act(async () => {
    await s.inst().setViewport({ x: 0, y: 0, zoom: 1 });
  });
  await waitFor(() => expect(s.inst().getViewport().zoom).toBe(1));
  expect(canvasRoot().classList.contains("is-fast")).toBe(false);
  expect(s.container.querySelector(".react-flow__edge-straight")).toBeNull();
});

test("a_switch_paints_the_canvas_before_the_pane_swaps_its_text", async () => {
  const s = setup(BOARD, farLayout());
  await opened(s);
  await pick(s, "Checkout", "Cart");
  const view = () => EditorView.findFromDOM(s.container.querySelector(".cm-editor") as HTMLElement)!;
  await waitFor(() => expect(shownText(view())).toContain('diagram flow "Checkout"'));
  /** One animation frame, and with `task` the task after it (a switch's landing, Plan F Decision 12). */
  const frame = (task: boolean) =>
    act(async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => (task ? setTimeout(r, 0) : r())));
    });
  // The click draws Refund selected, its shapes still static; the landing a paint later makes them live while the
  // pane still shows Checkout (Task 18b: the canvas paints first, the pane swaps in the frame after).
  fireEvent.click(screen.getByRole("button", { name: "Flowchart Refund" }));
  expect(s.ids()).not.toContain("Ask");
  await frame(true);
  expect(s.ids()).toContain("Ask");
  expect(shownText(view())).toContain('diagram flow "Checkout"');
  // Shipping picked before the pane's swap to Refund: its landing cancels that swap and schedules its own, so the pane
  // never shows Refund, and stays on Checkout for a frame after Shipping is live.
  fireEvent.click(screen.getByRole("button", { name: "Flowchart Shipping" }));
  await frame(true);
  expect(s.ids()).toContain("Pack");
  expect(shownText(view())).toContain('diagram flow "Checkout"');
  await frame(false);
  expect(shownText(view())).toContain('diagram flow "Checkout"');
  // Settled: the pane shows the selected frame's text, and only it.
  await waitFor(() => expect(shownText(view())).toContain('diagram flow "Shipping"'));
  expect(shownText(view())).not.toContain('diagram flow "Checkout"');
  expect(shownText(view())).not.toContain('diagram flow "Refund"');
});

test("a_three_frame_board_at_fit_shows_both_pane_buttons", async () => {
  // The tab strips fit their room (coordinator ruling on F1): at the board's fit there is room for both buttons.
  const s = setup();
  await opened(s);
  await pick(s, "Refund", "Ask");
  const el = s.frameEl("Refund")!;
  expect(s.inst().getViewport().zoom).toBeLessThan(1);
  expect(within(el).getByRole("button", { name: /^AI Chat/ })).toBeTruthy();
  expect(within(el).getByRole("button", { name: /^Code Editor/ })).toBeTruthy();
});
