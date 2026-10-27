// Task 12: drawing and editing loose sketches (Decisions 18, 20 and 21). A generic tool, Section or the note sketch
// pressed outside every frame (or where the frame has no such shape) draws a sketch into the layout file, one undo
// entry each; Select picks, moves, deletes, nudges, edits and colours them. Only Pen stays armed (owner answer 7).
import { redo, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { LangClient } from "../../lang/client";
import { splitFrames } from "../../lang/flow/board";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { patientFile } from "../../test/load";
import { mockReactFlowDom } from "../../test/reactFlow";
import FlowTab from "../FlowTab";
import type { Sketch } from "./boardLayout";
import { boardFrameId } from "./boardScene";
import { SketchBar } from "./SketchDraw";
import { SKETCH_CLIP, sketchNodeId, TOO_MANY_SKETCHES } from "./sketches";

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

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  canvas.props = null;
  canvas.instance = null;
});

const CHECKOUT = 'diagram flow "Checkout"\nCart\nPay\nCart > Pay\n';
const REFUND = 'diagram flow "Refund"\nAsk\nRefund it\nAsk > Refund it\n';
const SHIPPING = 'diagram flow "Shipping"\nPack\nSend\nPack > Send\n';
const BOARD = [CHECKOUT, REFUND, SHIPPING].join("\n");
const FRAMES = {
  Checkout: { at: { x: 0, y: 0 }, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
  Refund: { at: { x: 600, y: 0 }, nodes: { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } }, style: "modern", direction: "TB" },
  Shipping: { at: { x: 1200, y: 0 }, nodes: { Pack: { x: 0, y: 0 }, Send: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
};
const layoutWith = (sketches: unknown[] = []) => JSON.stringify({ version: 2, frames: FRAMES, sketches });

type Box = { x: number; y: number; w: number; h: number };
type Pt = { x: number; y: number };

function setup(initial = BOARD, layout: string | null = layoutWith()) {
  const saved = { text: initial, layout, textWrites: 0 };
  routeInvoke({
    read_diagram: () => saved,
    write_diagram: (a) => {
      saved.text = a.text as string;
      saved.layout = a.layout as string;
      saved.textWrites += 1;
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
  const pane = () => utils.container.querySelector(".react-flow__pane") as HTMLElement;
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const text = () => view().state.doc.toString();
  const frame = (i: number) => {
    const t = text();
    const f = splitFrames(t)[i];
    return t.slice(f.from, f.to);
  };
  const props = () => canvas.props!;
  const inst = () => canvas.instance!;
  const nodes = () => props().nodes;
  const nodeOf = (id: string) => nodes().find((n) => n.id === id);
  /** The sketches the canvas draws, in draw order. */
  const sketches = (): Sketch[] => nodes().filter((n) => n.type === "sketch").map((n) => (n.data as { sketch: Sketch }).sketch);
  const bar = () => screen.getByRole("toolbar", { name: "Board tools" });
  const pressed = () => within(bar()).getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("aria-label"));
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const frameEl = (key: string) => [...utils.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === boardFrameId(key)) ?? null;
  const isSelected = (key: string) => {
    const el = frameEl(key);
    return !!el && within(el).queryByRole("button", { name: /^Code Editor/ }) !== null;
  };
  const boxOf = (key: string): Box => {
    const n = nodeOf(boardFrameId(key))!;
    return { x: n.position.x, y: n.position.y, w: Number(n.style?.width), h: Number(n.style?.height) };
  };
  const shapesIn = (key: string): Box[] => {
    const f = boxOf(key);
    return nodes()
      .filter((n) => n.type !== "boardFrame" && n.type !== "sketch")
      .map((n) => (n.parentId ? { x: f.x + n.position.x, y: f.y + n.position.y, w: n.initialWidth ?? 0, h: n.initialHeight ?? 0 } : { x: n.position.x, y: n.position.y, w: n.initialWidth ?? 0, h: n.initialHeight ?? 0 }));
  };
  const screenAt = (p: Pt) => inst().flowToScreenPosition(p);
  /** A press at flow `from` through `path`, let go at the last point (a click when there is none), as a browser sends it. */
  const drawPath = (from: Pt, path: Pt[] = [], init: { shiftKey?: boolean } = {}, target: Element = pane()) => {
    const a = screenAt(from);
    fireEvent.pointerDown(target, { clientX: a.x, clientY: a.y, button: 0, pointerId: 1 });
    let last = a;
    for (const p of path) {
      last = screenAt(p);
      fireEvent.pointerMove(target, { clientX: last.x, clientY: last.y, button: 0, pointerId: 1, ...init });
    }
    fireEvent.pointerUp(target, { clientX: last.x, clientY: last.y, button: 0, pointerId: 1, ...init });
    fireEvent.click(target, { clientX: last.x, clientY: last.y });
  };
  const drawAt = (from: Pt, to = from, init: { shiftKey?: boolean } = {}) => drawPath(from, to === from ? [] : [to], init);
  return { ...utils, saved, canvasEl, pane, view, text, frame, props, inst, nodes, nodeOf, sketches, bar, pressed, press, frameEl, isSelected, boxOf, shapesIn, drawAt, drawPath };
}
type Setup = ReturnType<typeof setup>;

async function opened(titles = ["Checkout", "Refund", "Shipping"]) {
  for (const t of titles) await screen.findByRole("button", { name: new RegExp(` ${t}$`) });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
}

async function pick(s: Setup, label: string, title: string, first: string) {
  fireEvent.click(await screen.findByRole("button", { name: `${label} ${title}` }));
  await waitFor(() => expect(s.nodes().some((n) => n.id === first)).toBe(true));
  await waitFor(() => expect(s.isSelected(title)).toBe(true));
}

/** A sketch's node element (its id starts with a NUL, which no CSS selector can name). */
const nodeEl = (s: Setup, id: string) => [...s.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === sketchNodeId(id)) ?? null;

/** Within a pixel: a point goes to the screen and back. */
const near = (got: number, want: number) => expect(Math.abs(got - want)).toBeLessThanOrEqual(1);
const nearBox = (s: Sketch, b: Box) => {
  near(s.x, b.x);
  near(s.y, b.y);
  near(s.w, b.w);
  near(s.h, b.h);
};

/** Below every frame: the empty canvas. */
const OUT = { x: 100, y: 900 };

test("a_rectangle_drag_on_empty_canvas_makes_a_sketch", async () => {
  const s = setup();
  await opened();
  s.press("r");
  expect(s.pressed()).toEqual(["Rectangle"]);
  s.drawAt(OUT, { x: OUT.x + 200, y: OUT.y + 100 });
  await waitFor(() => expect(s.sketches()).toHaveLength(1));
  const r = s.sketches()[0];
  expect(r.kind).toBe("rect");
  nearBox(r, { x: OUT.x, y: OUT.y, w: 200, h: 100 });
  // One use: Select again; the text is untouched.
  expect(s.pressed()).toEqual(["Select"]);
  expect(s.text()).toBe(BOARD);
  // A click places 120 by 80 around the press.
  s.press("o");
  s.drawAt({ x: 600, y: 1200 });
  await waitFor(() => expect(s.sketches()).toHaveLength(2));
  const e = s.sketches()[1];
  expect(e.kind).toBe("ellipse");
  nearBox(e, { x: 540, y: 1160, w: 120, h: 80 });
  // Each sketch is one undo entry.
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.sketches()).toHaveLength(1));
  // The sketch goes to the layout file only.
  await waitFor(() => expect(JSON.parse(s.saved.layout!).sketches).toHaveLength(1));
  expect(s.saved.textWrites).toBe(0);
});

test("shift_keeps_it_square", async () => {
  const s = setup();
  await opened();
  s.press("r");
  s.drawAt(OUT, { x: OUT.x + 200, y: OUT.y + 100 }, { shiftKey: true });
  await waitFor(() => expect(s.sketches()).toHaveLength(1));
  nearBox(s.sketches()[0], { x: OUT.x, y: OUT.y, w: 200, h: 200 });
  // Shift on a line snaps it to 45 degrees.
  s.press("l");
  s.drawAt({ x: 100, y: 1300 }, { x: 300, y: 1320 }, { shiftKey: true });
  await waitFor(() => expect(s.sketches()).toHaveLength(2));
  const l = s.sketches()[1];
  expect(l.kind).toBe("line");
  near(l.h, 0);
  near(l.w, 200);
});

test("pen_strokes_are_simplified_and_pen_stays_armed", async () => {
  const s = setup();
  await opened();
  s.press("p");
  expect(s.pressed()).toEqual(["Pen"]);
  // A straight stroke of 60 points keeps its two ends (Ramer-Douglas-Peucker at 1 px).
  const path = Array.from({ length: 60 }, (_, i) => ({ x: OUT.x + i * 5, y: OUT.y + i * 2 }));
  s.drawPath(OUT, path);
  await waitFor(() => expect(s.sketches()).toHaveLength(1));
  const pen = s.sketches()[0];
  expect(pen.kind).toBe("pen");
  expect(pen.points).toHaveLength(2);
  // Points are relative to the sketch's box.
  expect(pen.points![0]).toEqual([0, 0]);
  // A bent stroke keeps its corner.
  s.drawPath({ x: 100, y: 1300 }, [...Array.from({ length: 20 }, (_, i) => ({ x: 100 + i * 10, y: 1300 })), ...Array.from({ length: 20 }, (_, i) => ({ x: 290, y: 1300 + i * 10 }))]);
  await waitFor(() => expect(s.sketches()).toHaveLength(2));
  expect(s.sketches()[1].points).toHaveLength(3);
  // Pen stays armed until Esc or V.
  expect(s.pressed()).toEqual(["Pen"]);
  s.press("Escape");
  expect(s.pressed()).toEqual(["Select"]);
  s.press("p");
  s.press("v");
  expect(s.pressed()).toEqual(["Select"]);
});

test("text_click_types_a_text_sketch", async () => {
  const s = setup();
  await opened();
  s.press("t");
  expect(s.pressed()).toEqual(["Text"]);
  s.drawAt(OUT);
  const field = await screen.findByRole("textbox", { name: "Text sketch" });
  fireEvent.change(field, { target: { value: "Ship on Friday" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(s.sketches()).toHaveLength(1));
  const t = s.sketches()[0];
  expect(t.kind).toBe("text");
  expect(t.text).toBe("Ship on Friday");
  near(t.x, OUT.x);
  expect(s.pressed()).toEqual(["Select"]);
  // An empty text writes nothing.
  s.press("t");
  s.drawAt({ x: 100, y: 1300 });
  const again = await screen.findByRole("textbox", { name: "Text sketch" });
  fireEvent.keyDown(again, { key: "Enter" });
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Text sketch" })).toBeNull());
  expect(s.sketches()).toHaveLength(1);
});

test("n_outside_every_frame_makes_a_note_sketch", async () => {
  const s = setup();
  await opened();
  s.press("n");
  // N's pressed state shows on the Note button.
  expect(s.pressed()).toEqual(["Note"]);
  s.drawAt(OUT);
  const field = await screen.findByRole("textbox", { name: "Note sketch" });
  fireEvent.change(field, { target: { value: "Ask legal" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(s.sketches()).toHaveLength(1));
  expect(s.sketches()[0]).toMatchObject({ kind: "note", text: "Ask legal" });
  expect(s.pressed()).toEqual(["Select"]);
  expect(s.text()).toBe(BOARD);
});

test("n_in_a_flowchart_frame_adds_its_note", async () => {
  const s = setup();
  await opened();
  await pick(s, "Flowchart", "Checkout", "Cart");
  s.press("n");
  const field = await screen.findByRole("textbox", { name: /^Note text/ });
  fireEvent.change(field, { target: { value: "Check stock" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(s.frame(0)).toContain("Check stock"));
  expect(s.sketches()).toHaveLength(0);
  expect(s.frame(1)).toBe(REFUND);
});

test("esc_cancels_a_drawing", async () => {
  const s = setup();
  await opened();
  s.press("r");
  const a = s.inst().flowToScreenPosition(OUT);
  const b = s.inst().flowToScreenPosition({ x: OUT.x + 200, y: OUT.y + 100 });
  fireEvent.pointerDown(s.pane(), { clientX: a.x, clientY: a.y, button: 0, pointerId: 1 });
  fireEvent.pointerMove(s.pane(), { clientX: b.x, clientY: b.y, button: 0, pointerId: 1 });
  // The preview draws while dragging.
  await waitFor(() => expect(s.container.querySelector(".board-sketch-preview")).not.toBeNull());
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.pointerUp(s.pane(), { clientX: b.x, clientY: b.y, button: 0, pointerId: 1 });
  fireEvent.click(s.pane(), { clientX: b.x, clientY: b.y });
  await new Promise((r) => setTimeout(r, 50));
  expect(s.sketches()).toHaveLength(0);
  expect(s.container.querySelector(".board-sketch-preview")).toBeNull();
  expect(s.pressed()).toEqual(["Select"]);
});

const SECTION = { id: "s1", kind: "section", x: 0, y: 800, w: 400, h: 300, text: "Section" };
const INSIDE = { id: "s2", kind: "rect", x: 50, y: 850, w: 100, h: 60 };
const HALF = { id: "s3", kind: "rect", x: 350, y: 850, w: 100, h: 60 };
const AWAY = { id: "s4", kind: "ellipse", x: 900, y: 900, w: 100, h: 60 };

test("moving_a_section_moves_what_is_inside_it", async () => {
  const s = setup(BOARD, layoutWith([SECTION, INSIDE, HALF, AWAY]));
  await opened();
  await waitFor(() => expect(s.sketches()).toHaveLength(4));
  const id = sketchNodeId("s1");
  act(() => s.props().onSelect!([id]));
  // While it is dragged, what is inside follows.
  act(() => s.props().onDrag!(id, 40, 830));
  await waitFor(() => expect(s.props().livePositions?.[sketchNodeId("s2")]).toEqual({ x: 90, y: 880 }));
  act(() => s.props().onMove!(id, 40, 830));
  await waitFor(() => expect(s.sketches().find((x) => x.id === "s1")).toMatchObject({ x: 40, y: 830 }));
  const by = (k: string) => s.sketches().find((x) => x.id === k)!;
  expect(by("s2")).toMatchObject({ x: 90, y: 880 });
  // Half inside stays, as does what is outside.
  expect(by("s3")).toMatchObject({ x: 350, y: 850 });
  expect(by("s4")).toMatchObject({ x: 900, y: 900 });
  // One undo entry takes the whole move back.
  act(() => void undo(s.view()));
  await waitFor(() => expect(by("s1")).toMatchObject({ x: 0, y: 800 }));
  expect(by("s2")).toMatchObject({ x: 50, y: 850 });
});

test("moving_a_diagram_frame_leaves_sketches_where_they_are", async () => {
  // A note over Checkout's box and a rectangle under it.
  const over = { id: "s1", kind: "note", x: 20, y: 20, w: 160, h: 120, text: "Over" };
  const under = { id: "s2", kind: "rect", x: 10, y: 10, w: 60, h: 40 };
  const s = setup(BOARD, layoutWith([over, under]));
  await opened();
  await pick(s, "Flowchart", "Checkout", "Cart");
  const id = boardFrameId("Checkout");
  const was = s.boxOf("Checkout");
  act(() => s.props().onFrameDrag!(id, { x: was.x + 60, y: was.y + 30 }, false));
  act(() => s.props().onFrameDrag!(id, { x: was.x + 100, y: was.y + 50 }, true));
  await waitFor(() => expect(JSON.parse(s.saved.layout!).frames.Checkout.at).toEqual({ x: 100, y: 50 }));
  expect(s.sketches().map((x) => [x.id, x.x, x.y])).toEqual([
    ["s1", 20, 20],
    ["s2", 10, 10],
  ]);
});

test("delete_takes_shapes_and_sketches_in_one_undo", async () => {
  const s = setup(BOARD, layoutWith([AWAY, INSIDE]));
  await opened();
  await pick(s, "Flowchart", "Checkout", "Cart");
  act(() => s.props().onSelect!(["Pay", sketchNodeId("s4")]));
  await waitFor(() => expect(s.props().selection).toContain(sketchNodeId("s4")));
  s.press("Delete");
  await waitFor(() => expect(s.frame(0)).toBe('diagram flow "Checkout"\nCart\n'));
  await waitFor(() => expect(s.sketches().map((x) => x.id)).toEqual(["s2"]));
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.frame(0)).toBe(CHECKOUT));
  // Back in its own place in the draw order.
  expect(s.sketches().map((x) => x.id)).toEqual(["s4", "s2"]);
  // Sketches alone delete too.
  act(() => s.props().onSelect!([sketchNodeId("s2")]));
  await waitFor(() => expect(s.props().selection).toEqual([sketchNodeId("s2")]));
  s.press("Backspace");
  await waitFor(() => expect(s.sketches().map((x) => x.id)).toEqual(["s4"]));
  expect(s.frame(0)).toBe(CHECKOUT);
});

test("double_click_edits_a_note", async () => {
  const note = { id: "s1", kind: "note", x: 100, y: 900, w: 160, h: 120, text: "Ask legal" };
  const s = setup(BOARD, layoutWith([note]));
  await opened();
  await waitFor(() => expect(s.sketches()).toHaveLength(1));
  act(() => s.props().onNodeDoubleClick!(sketchNodeId("s1")));
  const field = (await screen.findByRole("textbox", { name: "Note sketch" })) as HTMLTextAreaElement;
  expect(field.value).toBe("Ask legal");
  fireEvent.change(field, { target: { value: "Ask legal by Friday" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(s.sketches()[0].text).toBe("Ask legal by Friday"));
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.sketches()[0].text).toBe("Ask legal"));
  // F2 on the one selected sketch edits it too (the keyboard path).
  act(() => s.props().onSelect!([sketchNodeId("s1")]));
  await waitFor(() => expect(s.props().selection).toEqual([sketchNodeId("s1")]));
  s.press("F2");
  expect(await screen.findByRole("textbox", { name: "Note sketch" })).toBeTruthy();
});

test("the_sketch_colour_bar_writes_the_colour", async () => {
  const s = setup(BOARD, layoutWith([INSIDE, AWAY]));
  await opened();
  act(() => s.props().onSelect!([sketchNodeId("s2"), sketchNodeId("s4")]));
  const bar = await screen.findByRole("toolbar", { name: "Sketch settings" });
  expect(within(bar).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Colour"]);
  fireEvent.click(within(bar).getByRole("button", { name: "Colour" }));
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Warning/ }));
  await waitFor(() => expect(s.sketches().map((x) => x.color)).toEqual(["warning", "warning"]));
  expect(s.text()).toBe(BOARD);
  // One undo entry for both.
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.sketches().map((x) => x.color)).toEqual([undefined, undefined]));
  // A shape in the selection too: the bar is not the sketches' alone.
  await pick(s, "Flowchart", "Checkout", "Cart");
  act(() => s.props().onSelect!(["Cart", sketchNodeId("s2")]));
  await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Sketch settings" })).toBeNull());
});

test("a_full_board_refuses_the_next_sketch_with_its_note", async () => {
  const many = Array.from({ length: 1_000 }, (_, i) => ({ id: `s${i + 1}`, kind: "rect", x: 3_000 + (i % 40) * 30, y: 3_000 + Math.floor(i / 40) * 30, w: 20, h: 20 }));
  const s = setup(BOARD, layoutWith(many));
  await opened();
  await waitFor(() => expect(s.sketches()).toHaveLength(1_000));
  s.press("r");
  s.drawAt(OUT, { x: OUT.x + 200, y: OUT.y + 100 });
  expect(await screen.findByText(TOO_MANY_SKETCHES)).toBeTruthy();
  expect(s.sketches()).toHaveLength(1_000);
});

test("arrows_nudge_sketches_as_one_move", async () => {
  const s = setup(BOARD, layoutWith([AWAY]));
  await opened();
  act(() => s.props().onSelect!([sketchNodeId("s4")]));
  await waitFor(() => expect(s.props().selection).toEqual([sketchNodeId("s4")]));
  // A held key's repeats are one move, kept when the key goes up.
  s.press("ArrowRight");
  s.press("ArrowRight", { repeat: true });
  fireEvent.keyUp(s.canvasEl(), { key: "ArrowRight" });
  await waitFor(() => expect(s.sketches()[0]).toMatchObject({ x: 902, y: 900 }));
  // Shift moves 16 px.
  s.press("ArrowDown", { shiftKey: true });
  fireEvent.keyUp(s.canvasEl(), { key: "ArrowDown" });
  await waitFor(() => expect(s.sketches()[0]).toMatchObject({ x: 902, y: 916 }));
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.sketches()[0]).toMatchObject({ x: 902, y: 900 }));
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.sketches()[0]).toMatchObject({ x: 900, y: 900 }));
  expect(s.text()).toBe(BOARD);
});

test("copy_and_paste_of_sketches_write_no_diagram_file", async () => {
  const s = setup(BOARD, layoutWith([AWAY]));
  await opened();
  act(() => s.props().onSelect!([sketchNodeId("s4")]));
  await waitFor(() => expect(s.props().selection).toEqual([sketchNodeId("s4")]));
  let clip = "";
  fireEvent.copy(s.canvasEl(), { clipboardData: { setData: (_t: string, v: string) => (clip = v), getData: () => "" } });
  expect(JSON.parse(clip)[SKETCH_CLIP]).toHaveLength(1);
  fireEvent.paste(s.canvasEl(), { clipboardData: { getData: () => clip } });
  await waitFor(() => expect(s.sketches()).toHaveLength(2));
  const copy = s.sketches()[1];
  expect(copy.id).not.toBe("s4");
  expect(copy.id.length).toBeLessThan(64);
  expect(copy).toMatchObject({ kind: "ellipse", w: 100, h: 60 });
  // The copy is selected; the text and the diagram file are untouched.
  expect(s.props().selection).toEqual([sketchNodeId(copy.id)]);
  expect(s.text()).toBe(BOARD);
  expect(s.saved.textWrites).toBe(0);
});

test("a_box_sketch_resizes_by_its_zones_and_a_line_by_its_ends", async () => {
  const line = { id: "s5", kind: "line", x: 100, y: 1300, w: 200, h: 0, points: [[0, 0], [200, 0]] };
  const s = setup(BOARD, layoutWith([AWAY, line]));
  await opened();
  // Only what is on screen is drawn: the view goes to the sketches, at 100 percent.
  await act(async () => void (await s.inst().setViewport({ x: -800, y: -800, zoom: 1 })));
  act(() => s.props().onSelect!([sketchNodeId("s4")]));
  const node = await waitFor(() => {
    const el = nodeEl(s, "s4");
    expect(el?.querySelector(".rz-se")).toBeTruthy();
    return el!;
  });
  const zone = node.querySelector(".rz-se") as HTMLElement;
  const z = s.inst().getViewport().zoom;
  fireEvent.pointerDown(zone, { clientX: 0, clientY: 0, button: 0, pointerId: 2 });
  fireEvent.pointerMove(zone, { clientX: 50 * z, clientY: 40 * z, pointerId: 2 });
  fireEvent.pointerUp(zone, { clientX: 50 * z, clientY: 40 * z, pointerId: 2 });
  await waitFor(() => expect(s.sketches()[0]).toMatchObject({ x: 900, y: 900 }));
  near(s.sketches()[0].w, 150);
  near(s.sketches()[0].h, 100);
  await act(async () => void (await s.inst().setViewport({ x: 0, y: -1200, zoom: 1 })));
  act(() => s.props().onSelect!([sketchNodeId("s5")]));
  const lineEl = await waitFor(() => {
    const el = nodeEl(s, "s5");
    expect(el?.querySelector('[data-end="1"]')).toBeTruthy();
    return el!;
  });
  const end = lineEl.querySelector('[data-end="1"]') as HTMLElement;
  fireEvent.pointerDown(end, { clientX: 0, clientY: 0, button: 0, pointerId: 3 });
  fireEvent.pointerMove(end, { clientX: 0, clientY: 100 * z, pointerId: 3 });
  fireEvent.pointerUp(end, { clientX: 0, clientY: 100 * z, pointerId: 3 });
  await waitFor(() => expect(s.sketches()[1].h).toBeGreaterThan(90));
  const l = s.sketches()[1];
  near(l.x, 100);
  near(l.y, 1300);
  near(l.w, 200);
  near(l.h, 100);
});

test("a_click_on_a_section_outside_every_frame_selects_it", async () => {
  const s = setup(BOARD, layoutWith([SECTION]));
  await opened();
  // Its title is what takes a press; its inside is the canvas until it is selected (FigJam).
  const p = s.inst().flowToScreenPosition({ x: 200, y: 950 });
  fireEvent.pointerDown(s.pane(), { clientX: p.x, clientY: p.y, button: 0 });
  fireEvent.click(s.pane(), { clientX: p.x, clientY: p.y });
  await waitFor(() => expect(s.props().selection).toEqual([sketchNodeId("s1")]));
});

test("enter_places_the_armed_sketch_and_sections_count_up", async () => {
  const s = setup();
  await opened();
  // The keyboard path (Decision 18): Enter places the armed tool's sketch in the middle of the view.
  s.press("r");
  s.press("Enter");
  await waitFor(() => expect(s.sketches()).toHaveLength(1));
  expect(s.sketches()[0]).toMatchObject({ kind: "rect", w: 120, h: 80 });
  expect(s.pressed()).toEqual(["Select"]);
  // F draws a Section titled "Section", then "Section 2" (owner answer 3).
  s.press("f");
  expect(s.pressed()).toEqual(["Section"]);
  s.drawAt(OUT, { x: OUT.x + 300, y: OUT.y + 200 });
  await waitFor(() => expect(s.sketches()).toHaveLength(2));
  expect(s.sketches()[1]).toMatchObject({ kind: "section", text: "Section" });
  s.press("f");
  s.press("Enter");
  await waitFor(() => expect(s.sketches()).toHaveLength(3));
  expect(s.sketches()[2]).toMatchObject({ kind: "section", text: "Section 2" });
  expect(s.pressed()).toEqual(["Select"]);
});

test("pasting_shapes_and_sketches_is_one_undo", async () => {
  const s = setup(BOARD, layoutWith([AWAY]));
  await opened();
  await pick(s, "Flowchart", "Checkout", "Cart");
  act(() => s.props().onSelect!(["Pay", sketchNodeId("s4")]));
  await waitFor(() => expect(s.props().selection).toEqual(["Pay", sketchNodeId("s4")]));
  let clip = "";
  fireEvent.copy(s.canvasEl(), { clipboardData: { setData: (_t: string, v: string) => (clip = v), getData: () => "" } });
  fireEvent.paste(s.canvasEl(), { clipboardData: { getData: () => clip } });
  await waitFor(() => expect(s.sketches()).toHaveLength(2));
  await waitFor(() => expect(s.frame(0)).not.toBe(CHECKOUT));
  const pasted = s.text();
  // Both are selected: the new shape and the new sketch.
  await waitFor(() => expect(s.props().selection).toHaveLength(2));
  // One Ctrl+Z takes both back; one Ctrl+Y brings both again.
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.text()).toBe(BOARD));
  expect(s.sketches()).toHaveLength(1);
  act(() => void redo(s.view()));
  await waitFor(() => expect(s.text()).toBe(pasted));
  expect(s.sketches()).toHaveLength(2);
});

/** The pasted shape: the live node that was not there before. */
const newShape = (s: Setup, before: Set<string>) => s.nodes().find((n) => !before.has(n.id) && !n.id.startsWith("\u0000") && n.type !== "sketch");

test("a_mixed_paste_keeps_shapes_and_sketches_in_place_relative_to_each_other", async () => {
  // Pay's top left is at (0, 120); the note 200 px to its right.
  const note = { id: "s1", kind: "note", x: 200, y: 120, w: 160, h: 160, text: "Why" };
  const s = setup(BOARD, layoutWith([note]));
  await opened();
  await pick(s, "Flowchart", "Checkout", "Cart");
  await waitFor(() => expect(s.nodeOf("Pay")).toBeTruthy());
  act(() => s.props().onSelect!(["Pay", sketchNodeId("s1")]));
  await waitFor(() => expect(s.props().selection).toEqual(["Pay", sketchNodeId("s1")]));
  let clip = "";
  fireEvent.copy(s.canvasEl(), { clipboardData: { setData: (_t: string, v: string) => (clip = v), getData: () => "" } });
  // With the pointer over the canvas the group's top left goes to the pointer (Figma).
  const anchor = { x: 400, y: 600 };
  const p = s.inst().flowToScreenPosition(anchor);
  fireEvent.pointerMove(s.canvasEl(), { clientX: p.x, clientY: p.y });
  let before = new Set(s.nodes().map((n) => n.id));
  fireEvent.paste(s.canvasEl(), { clipboardData: { getData: () => clip } });
  await waitFor(() => expect(s.sketches()).toHaveLength(2));
  await waitFor(() => expect(newShape(s, before)).toBeTruthy());
  let shape = newShape(s, before)!;
  let sk = s.sketches()[1];
  near(shape.position.x, anchor.x);
  near(shape.position.y, anchor.y);
  near(sk.x - shape.position.x, 200);
  near(sk.y - shape.position.y, 0);
  // With no pointer over the canvas: the middle of the view, the 200 px kept.
  fireEvent.pointerLeave(s.canvasEl());
  const r = s.canvasEl().getBoundingClientRect();
  const mid = s.inst().screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  before = new Set(s.nodes().map((n) => n.id));
  fireEvent.paste(s.canvasEl(), { clipboardData: { getData: () => clip } });
  await waitFor(() => expect(s.sketches()).toHaveLength(3));
  await waitFor(() => expect(newShape(s, before)).toBeTruthy());
  shape = newShape(s, before)!;
  sk = s.sketches()[2];
  near(shape.position.x, mid.x);
  near(shape.position.y, mid.y);
  near(sk.x - shape.position.x, 200);
  near(sk.y - shape.position.y, 0);
});

test("a_mixed_paste_with_no_diagram_selected_pastes_nothing_and_says_why", async () => {
  const s = setup(BOARD, layoutWith([AWAY]));
  await opened();
  const clip = JSON.stringify({ [SKETCH_CLIP]: [{ kind: "rect", x: 0, y: 0, w: 10, h: 10 }], text: "Pack" });
  fireEvent.paste(s.canvasEl(), { clipboardData: { getData: () => clip } });
  expect(await screen.findByText("Nothing was pasted. Select a diagram to paste its shapes into, then paste again.")).toBeTruthy();
  expect(s.sketches()).toHaveLength(1);
  expect(s.text()).toBe(BOARD);
});

test("a_cut_pastes_back_in_place_and_a_full_board_refuses_a_paste", async () => {
  const s = setup(BOARD, layoutWith([AWAY]));
  await opened();
  act(() => s.props().onSelect!([sketchNodeId("s4")]));
  await waitFor(() => expect(s.props().selection).toEqual([sketchNodeId("s4")]));
  let cut = "";
  s.press("x", { ctrlKey: true });
  fireEvent.cut(s.canvasEl(), { clipboardData: { setData: (_t: string, v: string) => (cut = v), getData: () => "" } });
  await waitFor(() => expect(s.sketches()).toHaveLength(0));
  expect(JSON.parse(cut)[SKETCH_CLIP]).toHaveLength(1);
  // The cut was made here: its first paste lands where it was (M8), the next one step on.
  fireEvent.paste(s.canvasEl(), { clipboardData: { getData: () => cut } });
  await waitFor(() => expect(s.sketches()).toHaveLength(1));
  expect(s.sketches()[0]).toMatchObject({ x: 900, y: 900 });
  fireEvent.paste(s.canvasEl(), { clipboardData: { getData: () => cut } });
  await waitFor(() => expect(s.sketches()).toHaveLength(2));
  expect(s.sketches()[1]).toMatchObject({ x: 916, y: 916 });
  const clip = cut;
  cleanup();
  // At the cap a paste is refused with its note and writes nothing.
  const many = Array.from({ length: 1_000 }, (_, i) => ({ id: `s${i + 1}`, kind: "rect", x: 3_000 + (i % 40) * 30, y: 3_000 + Math.floor(i / 40) * 30, w: 20, h: 20 }));
  const full = setup(BOARD, layoutWith(many));
  await opened();
  await waitFor(() => expect(full.sketches()).toHaveLength(1_000));
  fireEvent.paste(full.canvasEl(), { clipboardData: { getData: () => clip } });
  expect(await screen.findByText(TOO_MANY_SKETCHES)).toBeTruthy();
  expect(full.sketches()).toHaveLength(1_000);
});

test("a_mixed_ctrl_drag_copy_is_one_undo", async () => {
  const s = setup(BOARD, layoutWith([AWAY]));
  await opened();
  await pick(s, "Flowchart", "Checkout", "Cart");
  act(() => s.props().onSelect!(["Pay", sketchNodeId("s4")]));
  await waitFor(() => expect(s.props().selection).toEqual(["Pay", sketchNodeId("s4")]));
  act(() => {
    s.props().onMove!("Pay", 0, 400, true);
    s.props().onMove!(sketchNodeId("s4"), 900, 1180, true);
  });
  await waitFor(() => expect(s.sketches()).toHaveLength(2));
  await waitFor(() => expect(s.frame(0)).not.toBe(CHECKOUT));
  expect(s.sketches()[1]).toMatchObject({ x: 900, y: 1180 });
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.text()).toBe(BOARD));
  expect(s.sketches()).toHaveLength(1);
});

test("the_sketch_bar_is_off_while_the_assistant_holds_the_board", () => {
  render(<SketchBar color="" disabled onColour={() => {}} />);
  const colour = screen.getByRole("button", { name: "Colour" }) as HTMLButtonElement;
  expect(colour.disabled).toBe(true);
  expect(colour.title).toBe("The Assistant is editing. Colour is off until it finishes.");
});

test("a_delete_refused_for_its_shapes_says_the_sketches_stay", async () => {
  const login = 'diagram sequence "Login"\nparticipant User\nparticipant App\nUser -> App: sign in\n';
  const s = setup(login, JSON.stringify({ version: 2, frames: { Login: { at: { x: 0, y: 0 }, nodes: {} } }, sketches: [AWAY] }));
  await opened(["Login"]);
  await waitFor(() => expect(s.nodeOf("App")).toBeTruthy());
  act(() => s.props().onSelect!(["App", sketchNodeId("s4")]));
  await waitFor(() => expect(s.props().selection).toEqual(["App", sketchNodeId("s4")]));
  s.press("Delete");
  expect(await screen.findByText("A sequence keeps at least two participants. Nothing was deleted, the selected sketches included.")).toBeTruthy();
  expect(s.sketches()).toHaveLength(1);
});

test("an_emptied_text_sketch_is_deleted", async () => {
  const text = { id: "s1", kind: "text", x: 100, y: 900, w: 80, h: 28, text: "Hi" };
  const s = setup(BOARD, layoutWith([text]));
  await opened();
  act(() => s.props().onNodeDoubleClick!(sketchNodeId("s1")));
  const field = await screen.findByRole("textbox", { name: "Text sketch" });
  fireEvent.change(field, { target: { value: "" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(s.sketches()).toHaveLength(0));
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.sketches()).toHaveLength(1));
});

test("a_line_click_draws_nothing_and_keeps_the_tool", async () => {
  const s = setup();
  await opened();
  s.press("a");
  s.drawAt(OUT);
  await new Promise((r) => setTimeout(r, 50));
  expect(s.sketches()).toHaveLength(0);
  expect(s.pressed()).toEqual(["Arrow"]);
  // Enter still places one in the middle of the view (the keyboard path).
  s.press("Enter");
  await waitFor(() => expect(s.sketches()).toHaveLength(1));
  expect(s.sketches()[0].kind).toBe("arrow");
});

test("a_letter_typed_in_a_sketch_field_arms_no_tool", async () => {
  const s = setup();
  await opened();
  s.press("t");
  s.drawAt(OUT);
  const field = await screen.findByRole("textbox", { name: "Text sketch" });
  fireEvent.keyDown(field, { key: "r" });
  fireEvent.keyDown(field, { key: "p" });
  expect(s.pressed()).toEqual(["Select"]);
});

test("a_nested_section_moves_with_its_outer_section_and_carries_its_own", async () => {
  const outer = { id: "s1", kind: "section", x: 0, y: 800, w: 600, h: 400, text: "Section" };
  const inner = { id: "s2", kind: "section", x: 50, y: 850, w: 300, h: 200, text: "Section 2" };
  const deep = { id: "s3", kind: "rect", x: 80, y: 900, w: 60, h: 40 };
  const s = setup(BOARD, layoutWith([outer, inner, deep]));
  await opened();
  const by = (k: string) => s.sketches().find((x) => x.id === k)!;
  act(() => s.props().onDrag!(sketchNodeId("s1"), 10, 820));
  act(() => s.props().onMove!(sketchNodeId("s1"), 10, 820));
  await waitFor(() => expect(by("s1")).toMatchObject({ x: 10, y: 820 }));
  expect(by("s2")).toMatchObject({ x: 60, y: 870 });
  expect(by("s3")).toMatchObject({ x: 90, y: 920 });
  // The inner one alone carries only its own.
  act(() => s.props().onDrag!(sketchNodeId("s2"), 70, 870));
  act(() => s.props().onMove!(sketchNodeId("s2"), 70, 870));
  await waitFor(() => expect(by("s2")).toMatchObject({ x: 70, y: 870 }));
  expect(by("s3")).toMatchObject({ x: 100, y: 920 });
  expect(by("s1")).toMatchObject({ x: 10, y: 820 });
});

test("a_sketch_copy_pastes_into_another_board", async () => {
  const s = setup(BOARD, layoutWith([AWAY]));
  await opened();
  act(() => s.props().onSelect!([sketchNodeId("s4")]));
  await waitFor(() => expect(s.props().selection).toEqual([sketchNodeId("s4")]));
  let clip = "";
  fireEvent.copy(s.canvasEl(), { clipboardData: { setData: (_t: string, v: string) => (clip = v), getData: () => "" } });
  cleanup();
  const two = [REFUND, SHIPPING].join("\n");
  const other = setup(two, JSON.stringify({ version: 2, frames: { Refund: FRAMES.Refund, Shipping: FRAMES.Shipping }, sketches: [] }));
  await opened(["Refund", "Shipping"]);
  fireEvent.paste(other.canvasEl(), { clipboardData: { getData: () => clip } });
  await waitFor(() => expect(other.sketches()).toHaveLength(1));
  expect(other.sketches()[0]).toMatchObject({ kind: "ellipse", w: 100, h: 60 });
  expect(other.text()).toBe(two);
  expect(other.saved.textWrites).toBe(0);
});

test("a_section_picked_by_a_pane_click_stays_picked", async () => {
  const s = setup(BOARD, layoutWith([SECTION, AWAY]));
  await opened();
  act(() => s.props().onSelect!([sketchNodeId("s4")]));
  await waitFor(() => expect(s.props().selection).toEqual([sketchNodeId("s4")]));
  // A whole press on the pane inside the Section, as a browser sends it: React Flow lets the selection go first.
  const p = s.inst().flowToScreenPosition({ x: 200, y: 950 });
  fireEvent.pointerDown(s.pane(), { clientX: p.x, clientY: p.y, button: 0, pointerId: 1 });
  fireEvent.mouseDown(s.pane(), { clientX: p.x, clientY: p.y, button: 0 });
  fireEvent.pointerUp(s.pane(), { clientX: p.x, clientY: p.y, button: 0, pointerId: 1 });
  fireEvent.mouseUp(s.pane(), { clientX: p.x, clientY: p.y, button: 0 });
  fireEvent.click(s.pane(), { clientX: p.x, clientY: p.y });
  await waitFor(() => expect(s.props().selection).toEqual([sketchNodeId("s1")]));
  await new Promise((r) => setTimeout(r, 100));
  expect(s.props().selection).toEqual([sketchNodeId("s1")]);
});

// ---- Task 18a: the parked minors

/** A live shape by name once the paste has drawn it. */
const shapeNamed = async (s: Setup, name: string) => {
  await waitFor(() => expect(s.nodeOf(name)).toBeTruthy());
  return s.nodeOf(name)!.position;
};

test("a_mixed_paste_puts_a_shape_with_no_place_at_the_shared_anchor", async () => {
  const s = setup();
  await opened();
  await pick(s, "Flowchart", "Checkout", "Cart");
  // Ship was drawn 200 px right of the note when copied; Hold had no place.
  const note = { kind: "note", x: 0, y: 120, w: 160, h: 160, text: "Why" };
  const clip = JSON.stringify({ [SKETCH_CLIP]: [note], text: "Ship\nHold\n", at: { Ship: { x: 200, y: 120 } } });
  const anchor = { x: 400, y: 600 };
  const p = s.inst().flowToScreenPosition(anchor);
  fireEvent.pointerMove(s.canvasEl(), { clientX: p.x, clientY: p.y });
  fireEvent.paste(s.canvasEl(), { clipboardData: { getData: () => clip } });
  await waitFor(() => expect(s.sketches()).toHaveLength(1));
  // One offset for the group: the note goes to the pointer, Ship keeps its 200 px, Hold goes at the group's anchor.
  near(s.sketches()[0].x, anchor.x);
  near(s.sketches()[0].y, anchor.y);
  const ship = await shapeNamed(s, "Ship");
  near(ship.x, anchor.x + 200);
  near(ship.y, anchor.y);
  const hold = await shapeNamed(s, "Hold");
  near(hold.x, anchor.x);
  near(hold.y, anchor.y);
});

test("a_mixed_clip_from_before_shape_places_pastes_both_at_the_anchor", async () => {
  // A clip copied before Task 12 has the shapes' lines and no `at`: shapes and sketches both start at the anchor.
  const s = setup();
  await opened();
  await pick(s, "Flowchart", "Checkout", "Cart");
  const clip = JSON.stringify({ [SKETCH_CLIP]: [{ kind: "rect", x: 900, y: 900, w: 40, h: 40 }], text: "Ship\n" });
  const anchor = { x: 400, y: 600 };
  const p = s.inst().flowToScreenPosition(anchor);
  fireEvent.pointerMove(s.canvasEl(), { clientX: p.x, clientY: p.y });
  fireEvent.paste(s.canvasEl(), { clipboardData: { getData: () => clip } });
  await waitFor(() => expect(s.sketches()).toHaveLength(1));
  near(s.sketches()[0].x, anchor.x);
  near(s.sketches()[0].y, anchor.y);
  const ship = await shapeNamed(s, "Ship");
  near(ship.x, anchor.x);
  near(ship.y, anchor.y);
  expect(s.frame(0)).toBe('diagram flow "Checkout"\nCart\nPay\nShip\nCart > Pay\n');
});

test("a_ctrl_drag_whose_shapes_cannot_be_copied_still_copies_its_sketches", async () => {
  const s = setup(BOARD, layoutWith([AWAY]));
  await opened();
  await pick(s, "Flowchart", "Checkout", "Cart");
  // A shape the text no longer has (typed away mid-drag) gives no lines to paste: the sketch copy still lands, alone.
  act(() => {
    s.props().onMove!("Gone", 0, 400, true);
    s.props().onMove!(sketchNodeId("s4"), 900, 1180, true);
  });
  await waitFor(() => expect(s.sketches()).toHaveLength(2));
  expect(s.sketches()[1]).toMatchObject({ x: 900, y: 1180 });
  expect(s.text()).toBe(BOARD);
  await waitFor(() => expect(s.props().selection).toEqual([sketchNodeId(s.sketches()[1].id)]));
  // One undo takes it back.
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.sketches()).toHaveLength(1));
});

// ----- Final review F2 (owner ruling): the only frame can be let go, so a one-frame board draws sketches too.

const ONE_LAYOUT = JSON.stringify({ version: 1, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, style: "modern", direction: "TB" });

/** A click on the empty canvas at a flow point, as a browser sends it. */
function clickAt(s: Setup, p: Pt) {
  const at = s.inst().flowToScreenPosition(p);
  fireEvent.click(s.pane(), { clientX: at.x, clientY: at.y });
}

test("the_only_frame_lets_go_on_a_click_outside_it_or_esc_and_its_tab_selects_it_again", async () => {
  const s = setup(CHECKOUT, ONE_LAYOUT);
  await opened(["Checkout"]);
  // It opens selected, with its kind's tools.
  await waitFor(() => expect(s.isSelected("Checkout")).toBe(true));
  expect(within(s.bar()).queryByRole("button", { name: "Rectangle" })).toBeNull();
  clickAt(s, OUT);
  await waitFor(() => expect(s.isSelected("Checkout")).toBe(false));
  expect(within(s.bar()).getByRole("button", { name: "Rectangle" })).toBeTruthy();
  // Its tab selects it again, with its kind's tools.
  fireEvent.click(await screen.findByRole("button", { name: "Flowchart Checkout" }));
  await waitFor(() => expect(s.isSelected("Checkout")).toBe(true));
  await waitFor(() => expect(within(s.bar()).queryByRole("button", { name: "Rectangle" })).toBeNull());
  // Esc with nothing else to close lets it go, as on a board of several.
  s.press("Escape");
  await waitFor(() => expect(s.isSelected("Checkout")).toBe(false));
  // A click on the frame selects it again.
  const box = s.boxOf("Checkout");
  clickAt(s, { x: box.x + box.w - 4, y: box.y + box.h - 4 });
  await waitFor(() => expect(s.isSelected("Checkout")).toBe(true));
});

test("r_then_a_drag_draws_a_rectangle_sketch_on_a_one_frame_board", async () => {
  const s = setup(CHECKOUT, ONE_LAYOUT);
  await opened(["Checkout"]);
  await waitFor(() => expect(s.isSelected("Checkout")).toBe(true));
  clickAt(s, OUT);
  await waitFor(() => expect(s.isSelected("Checkout")).toBe(false));
  s.press("r");
  expect(s.pressed()).toEqual(["Rectangle"]);
  s.drawAt(OUT, { x: OUT.x + 200, y: OUT.y + 100 });
  await waitFor(() => expect(s.sketches()).toHaveLength(1));
  expect(s.sketches()[0].kind).toBe("rect");
  nearBox(s.sketches()[0], { x: OUT.x, y: OUT.y, w: 200, h: 100 });
  expect(s.text()).toBe(CHECKOUT);
});

test("a_one_frame_file_opened_let_go_and_closed_is_not_saved", async () => {
  vi.mocked(invoke).mockClear();
  const s = setup(CHECKOUT, ONE_LAYOUT);
  await opened(["Checkout"]);
  await waitFor(() => expect(s.isSelected("Checkout")).toBe(true));
  clickAt(s, OUT);
  await waitFor(() => expect(s.isSelected("Checkout")).toBe(false));
  s.unmount();
  await new Promise((r) => setTimeout(r, 600));
  const writes = vi.mocked(invoke).mock.calls.filter(([c]) => c === "write_diagram" || c === "write_diagram_layout");
  expect(writes).toEqual([]);
  expect(s.saved.layout).toBe(ONE_LAYOUT);
  expect(s.saved.text).toBe(CHECKOUT);
});
