// Below the readable zoom the sketch layer draws as a few pictures, not one node a sketch (as frames do; WebKit paints every sketch as vector again at each new zoom). A click or a box on a
// pictured sketch still picks it, and the layer is real again once it is picked or the zoom is readable.
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { LangClient } from "../../lang/client";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { patientFile } from "../../test/load";
import { mockReactFlowDom } from "../../test/reactFlow";
import FlowTab from "../FlowTab";
import { SKETCH_PICTURE_TYPE } from "./boardScene";
import { SKETCH_LAYER_ID, sketchNodeId } from "./sketches";

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

const TEXT = 'diagram flow "Checkout"\nCart\nPay\nCart > Pay: card\n\ndiagram flow "Refund"\nAsk\nRefund it\nAsk > Refund it: yes\n';
/** A pen, a rectangle (under the frames) and a note, below the two frames. */
const SKETCHES = [
  { id: "p1", kind: "pen", x: 0, y: 1_000, w: 200, h: 120, points: [[0, 0], [100, 60], [200, 120]] },
  { id: "r1", kind: "rect", x: 400, y: 1_000, w: 200, h: 120 },
  { id: "n1", kind: "note", x: 800, y: 1_000, w: 200, h: 120, text: "Ask legal" },
];

function setup() {
  const layout = JSON.stringify({
    version: 2,
    frames: {
      Checkout: { at: { x: 0, y: 0 }, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 160 } }, style: "modern", direction: "TB" },
      Refund: { at: { x: 800, y: 0 }, nodes: { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 160 } }, style: "modern", direction: "TB" },
    },
    sketches: SKETCHES,
  });
  routeInvoke({ read_diagram: () => ({ text: TEXT, layout }), write_diagram: () => null, write_diagram_layout: () => null });
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={new LangClient(() => fakeWorker())} />
    </div>,
  );
  const nodes = () => canvas.props?.nodes ?? [];
  const sketchNodes = () => nodes().filter((n) => n.parentId === SKETCH_LAYER_ID);
  const tiles = () => nodes().filter((n) => n.type === SKETCH_PICTURE_TYPE);
  const zoomTo = async (zoom: number) => {
    await act(async () => {
      await canvas.instance!.setViewport({ x: 0, y: 0, zoom });
    });
  };
  const pane = () => utils.container.querySelector(".react-flow__pane") as HTMLElement;
  const at = (x: number, y: number) => canvas.instance!.flowToScreenPosition({ x, y });
  const selection = () => canvas.props?.selection ?? [];
  return { ...utils, nodes, sketchNodes, tiles, zoomTo, pane, at, selection };
}

async function farOut(s: ReturnType<typeof setup>) {
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await waitFor(() => expect(s.sketchNodes().length + s.tiles().length).toBeGreaterThan(0));
  await s.zoomTo(0.3);
  await waitFor(() => {
    expect(s.sketchNodes()).toHaveLength(0);
    expect(s.tiles().length).toBeGreaterThan(0);
  });
}

test("far_sketches_draw_as_pictures_not_one_node_each", async () => {
  const s = setup();
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await s.zoomTo(1);
  await waitFor(() => expect(s.sketchNodes()).toHaveLength(3));
  expect(s.tiles()).toHaveLength(0);
  await farOut(s);
  // Two pictures: the rectangle under the frames, the pen and the note over them; no sketch node and no layer node.
  expect(s.tiles()).toHaveLength(2);
  expect(s.nodes().some((n) => n.id === SKETCH_LAYER_ID)).toBe(false);
  expect(s.container.querySelectorAll(".board-sketch-picture-img")).toHaveLength(2);
  expect(s.container.querySelectorAll(".board-sketch-node")).toHaveLength(0);
  // Readable again: every sketch is real, and no picture is left.
  await s.zoomTo(1);
  await waitFor(() => expect(s.sketchNodes()).toHaveLength(3));
  expect(s.tiles()).toHaveLength(0);
});

test("a_click_on_a_pictured_sketch_picks_it", async () => {
  const s = setup();
  await farOut(s);
  const p = s.at(100, 1_060);
  fireEvent.pointerDown(s.pane(), { clientX: p.x, clientY: p.y, button: 0 });
  fireEvent.click(s.pane(), { clientX: p.x, clientY: p.y });
  // Picked: the layer is real at once, the pen selected.
  await waitFor(() => expect(s.selection()).toContain(sketchNodeId("p1")));
  await waitFor(() => expect(s.sketchNodes()).toHaveLength(3));
  expect(s.tiles()).toHaveLength(0);
  // Let go (Esc): pictured again.
  fireEvent.keyDown(s.container.querySelector(".flow-canvas")!, { key: "Escape" });
  await waitFor(() => expect(s.sketchNodes()).toHaveLength(0));
});

test("a_box_over_pictured_sketches_picks_them", async () => {
  const s = setup();
  await farOut(s);
  const from = s.at(-100, 950);
  const to = s.at(650, 1_200);
  fireEvent.pointerDown(s.pane(), { clientX: from.x, clientY: from.y, button: 0 });
  fireEvent.pointerUp(s.pane(), { clientX: to.x, clientY: to.y, button: 0 });
  // The pen and the rectangle meet the box; the note does not.
  await waitFor(() => expect([...s.selection()].sort()).toEqual([sketchNodeId("p1"), sketchNodeId("r1")].sort()));
});

test("a_press_drag_on_a_pictured_sketch_moves_it", async () => {
  // Task 9 fix 3: as on a real sketch (draw.io, Figma), a press on a pictured sketch picks it and a drag from there
  // moves it; it does not draw a box. The layer turns real at the press.
  const s = setup();
  await farOut(s);
  const from = s.at(100, 1_060);
  const to = s.at(400, 1_160);
  fireEvent.pointerDown(s.pane(), { clientX: from.x, clientY: from.y, button: 0, pointerId: 1 });
  await waitFor(() => expect(s.selection()).toContain(sketchNodeId("p1")));
  await waitFor(() => expect(s.sketchNodes()).toHaveLength(3));
  fireEvent.pointerMove(window, { clientX: (from.x + to.x) / 2, clientY: (from.y + to.y) / 2, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: to.x, clientY: to.y, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: to.x, clientY: to.y, pointerId: 1 });
  fireEvent.click(s.pane(), { clientX: to.x, clientY: to.y });
  await waitFor(() => expect(s.sketchNodes().find((n) => n.id === sketchNodeId("p1"))?.position).toEqual({ x: 300, y: 1_100 }));
  // Only the pen: no box picked the rectangle on the way, and it is still the one selected.
  expect(s.selection()).toEqual([sketchNodeId("p1")]);
  expect(s.sketchNodes().find((n) => n.id === sketchNodeId("r1"))?.position).toEqual({ x: 400, y: 1_000 });
});

/** Two animation frames: room for the sketch layer to step, were it going to. */
const frames = () =>
  act(async () => {
    for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r));
  });

test("tab_into_the_canvas_reaches_a_sketch_when_far", async () => {
  // Final review I2, controller ruling: while the canvas has keyboard focus (moved in by a key, not a press), the
  // sketch layer is real, so Tab reaches a sketch at any zoom; once focus leaves, the pictures are back.
  const s = setup();
  await farOut(s);
  const canvasEl = s.container.querySelector(".flow-canvas") as HTMLElement;
  const sketchIds = new Set(["p1", "r1", "n1"].map(sketchNodeId));
  const onSketch = () => {
    const el = document.activeElement as HTMLElement | null;
    return !!el?.classList.contains("react-flow__node") && sketchIds.has(el.getAttribute("data-id") ?? "");
  };
  // From the header's last button, the stop before the canvas's.
  act(() => (s.getByRole("button", { name: "Publish" }) as HTMLElement).focus());
  let entered = false;
  for (let i = 0; i < 40 && !onSketch(); i++) {
    await userEvent.tab();
    if (!entered && canvasEl.contains(document.activeElement)) {
      entered = true;
      // In by a key: the layer turns real (over the swap budget).
      await waitFor(() => expect(s.sketchNodes()).toHaveLength(3));
      expect(s.tiles()).toHaveLength(0);
    }
  }
  expect(entered).toBe(true);
  expect(onSketch()).toBe(true);
  // Focus leaves the canvas: pictures again.
  act(() => (document.activeElement as HTMLElement).blur());
  await waitFor(() => {
    expect(s.sketchNodes()).toHaveLength(0);
    expect(s.tiles().length).toBeGreaterThan(0);
  });
});

test("a_pointer_only_session_keeps_the_sketch_pictures", async () => {
  const s = setup();
  await farOut(s);
  const canvasEl = s.container.querySelector(".flow-canvas") as HTMLElement;
  // A press on empty canvas, far from the sketches, and the focus it gives the canvas.
  const p = s.at(3_000, -2_000);
  fireEvent.pointerDown(s.pane(), { clientX: p.x, clientY: p.y, button: 0 });
  act(() => canvasEl.focus());
  fireEvent.pointerUp(s.pane(), { clientX: p.x, clientY: p.y, button: 0 });
  fireEvent.click(s.pane(), { clientX: p.x, clientY: p.y });
  expect(canvasEl.contains(document.activeElement)).toBe(true);
  await frames();
  expect(s.sketchNodes()).toHaveLength(0);
  expect(s.tiles().length).toBeGreaterThan(0);
});
