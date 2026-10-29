// A line's label finds React Flow's label layer once, not on every store update. React Flow's own
// EdgeLabelRenderer runs `domNode.querySelector(".react-flow__edgelabel-renderer")` as a store selector, so every
// mounted label walked the canvas's DOM on every view change and every measure: with a frame's 300 labelled lines in
// view that was 300 DOM walks a frame through a zoom (the release WebView's sweep missed its 50 ms frame gate).
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { type Edge, type Node, ReactFlow, type ReactFlowInstance, ReactFlowProvider } from "@xyflow/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { JoinBadge } from "../diagram/edges";
import { mockReactFlowDom } from "../test/reactFlow";
import { FLOW_EDGE_TYPES } from "./flowNodes";
import { CanvasOverlay, createOverlayStore } from "./interactions/overlay";
import type { SeqEdgeData } from "./seqNodes";

beforeAll(() => mockReactFlowDom());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const LAYER = ".react-flow__edgelabel-renderer";
const LINES = 200;

const nodes: Node[] = [
  { id: "a", position: { x: 0, y: 0 }, data: {}, width: 100, height: 40 },
  { id: "b", position: { x: 400, y: 300 }, data: {}, width: 100, height: 40 },
];

function badgeEdge({ id }: { id: string }) {
  return <JoinBadge x={10} y={10}>{id}</JoinBadge>;
}

async function drawn(edges: Edge[], inside?: ReactNode) {
  let inst: ReactFlowInstance | null = null;
  const utils = render(
    <div style={{ width: 800, height: 600 }}>
      <ReactFlowProvider>
        <ReactFlow nodes={nodes} edges={edges} edgeTypes={{ ...FLOW_EDGE_TYPES, badge: badgeEdge }} onInit={(i) => (inst = i)}>
          {inside}
        </ReactFlow>
      </ReactFlowProvider>
    </div>,
  );
  await waitFor(() => expect(inst).not.toBeNull());
  return { utils, inst: () => inst! };
}

/** Counts the lookups of `layer` while the view moves ten times. */
async function lookupsOverTenMoves(edges: Edge[], layer = LAYER, inside?: ReactNode) {
  const s = await drawn(edges, inside);
  if (layer === LAYER) expect(s.utils.container.querySelectorAll(`${LAYER} > *`).length).toBe(LINES);
  const real = Element.prototype.querySelector;
  let lookups = 0;
  vi.spyOn(Element.prototype, "querySelector").mockImplementation(function (this: Element, sel: string) {
    if (sel === layer) lookups++;
    return real.call(this, sel);
  });
  for (let i = 1; i <= 10; i++) await act(async () => void (await s.inst().setViewport({ x: -i * 5, y: 0, zoom: 1 + i / 100 })));
  return lookups;
}

test("flow_and_message_labels_find_their_layer_once", async () => {
  const flow: Edge[] = Array.from({ length: LINES / 2 }, (_, i) => ({ id: `f${i}`, source: "a", target: "b", type: "flow", data: { label: `go ${i}` } }));
  // A message carries its drawing: its path with the label's gap and the label on its chip.
  const msg = (i: number): SeqEdgeData => ({
    row: i,
    y: 20,
    at: { x: 0, y: 0 },
    chip: {},
    m: { index: i, from: "a", to: "b", self: false, reply: false, y: 20, d: "M50 20 H200 M260 20 H450", points: [{ x: 50, y: 20 }, { x: 450, y: 20 }], label: { text: `ask ${i}`, x: 230, y: 20, w: 40, chip: { x: 206, y: 11, w: 48, h: 18 }, bg: "canvas" } },
  });
  const seq: Edge[] = Array.from({ length: LINES / 2 }, (_, i) => ({ id: `s${i}`, source: "a", target: "b", type: "seq", data: msg(i) }));
  // Ten view changes with 200 labels drawn: no label looks for its layer again.
  expect(await lookupsOverTenMoves([...flow, ...seq])).toBe(0);
});

test("join_badges_find_their_layer_once", async () => {
  const edges: Edge[] = Array.from({ length: LINES }, (_, i) => ({ id: `j${i}`, source: "a", target: "b", type: "badge" }));
  expect(await lookupsOverTenMoves(edges)).toBe(0);
});

test("the_overlay_finds_the_viewport_layer_once", async () => {
  // The viewport layer is the canvas's last element: each lookup walked every node and line before it.
  const overlay = <CanvasOverlay store={createOverlayStore()} />;
  expect(await lookupsOverTenMoves([], ".react-flow__viewport-portal", overlay)).toBe(0);
});
