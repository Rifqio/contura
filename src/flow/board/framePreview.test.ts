// Task 18b: below BOX_BELOW a static frame draws as one preview node (Figma, Miro): its shapes as boxes and its lines
// as straight segments, in one svg. The live frame always draws in full; at or above BOX_BELOW every frame does.
import type { Node } from "@xyflow/react";
import { expect, test } from "vitest";
import { createFlowService } from "../../lang/flow/service";
import { buildFlowGraph } from "../flowNodes";
import { emptyPositions } from "../layout";
import type { BoardLayout, FrameLayout } from "./boardLayout";
import { boardFrameId, createBoardScene, FRAME_PREVIEW_TYPE, type FramePreviewData, isStaticId } from "./boardScene";

const CHECKOUT = 'diagram flow "Checkout"\nShop {\n  Cart\n  Pay\n}\nCart > Pay: card\n';
const REFUND = 'diagram flow "Refund"\nAsk\nRefund it\nAsk > Refund it\n';
const SHIPPING = 'diagram flow "Shipping"\nPack\nSend\nPack > Send\nSend > Pack\n';
const THREE = [CHECKOUT, REFUND, SHIPPING].join("\n");
const KEYS = ["Checkout", "Refund", "Shipping"];

function entry(at: { x: number; y: number }, nodes: Record<string, { x: number; y: number }>): FrameLayout {
  return { at, nodes: Object.assign(emptyPositions(), nodes), style: "modern", direction: "TB" };
}
const LAYOUT = (): BoardLayout => ({
  frames: new Map(
    Object.entries({
      Checkout: entry({ x: 0, y: 0 }, { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }),
      Refund: entry({ x: 600, y: 0 }, { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } }),
      Shipping: entry({ x: 1200, y: 40 }, { Pack: { x: 0, y: 0 }, Send: { x: 0, y: 120 } }),
    }),
  ),
  sketches: [],
});

const childrenOf = (nodes: Node[], frameId: string) => nodes.filter((n) => n.parentId === frameId);
const edgesIn = (edges: { id: string }[], key: string) => edges.filter((e) => e.id.startsWith(`\u0000in:${key}\u0000`));
const box = (n: Node) => ({ x: n.position.x, y: n.position.y, w: n.initialWidth ?? 0, h: n.initialHeight ?? 0 });

test("below_box_below_a_static_frame_is_one_node_and_no_lines", () => {
  const r = createFlowService().parse("board", THREE);
  const s = createBoardScene("modern").build(r.frames, LAYOUT(), KEYS, null, null, [], undefined, true);
  for (const key of KEYS) {
    const kids = childrenOf(s.nodes, boardFrameId(key));
    expect(kids, key).toHaveLength(1);
    expect(kids[0].type).toBe(FRAME_PREVIEW_TYPE);
    expect(isStaticId(kids[0].id)).toBe(true);
    // Inert, as every static frame's shape is.
    expect(kids[0].selectable).toBe(false);
    expect(kids[0].draggable).toBe(false);
    expect(edgesIn(s.edges, key)).toHaveLength(0);
  }
  expect(s.edges).toHaveLength(0);
  // The frames' shapes stay known for a click's pick.
  expect(s.children.get(boardFrameId("Refund"))!.map((n) => n.id)).toContain("\u0000in:Refund\u0000Ask");
});

test("at_or_above_box_below_every_shape_and_line_is_drawn", () => {
  const r = createFlowService().parse("board", THREE);
  const s = createBoardScene("modern").build(r.frames, LAYOUT(), KEYS, null, null, [], undefined, false);
  expect(childrenOf(s.nodes, boardFrameId("Shipping")).map((n) => n.type)).not.toContain(FRAME_PREVIEW_TYPE);
  expect(childrenOf(s.nodes, boardFrameId("Shipping")).length).toBeGreaterThanOrEqual(2);
  expect(edgesIn(s.edges, "Shipping")).toHaveLength(2);
  expect(edgesIn(s.edges, "Checkout")).toHaveLength(1);
});

test("the_live_frame_draws_in_full_below_box_below", () => {
  const r = createFlowService().parse("board", THREE);
  const b = LAYOUT();
  const live = { nodes: buildFlowGraph(r.frames[1].doc!, b.frames.get("Refund")!.nodes, "modern", {}).nodes };
  const s = createBoardScene("modern").build(r.frames, b, KEYS, { title: "Refund", index: 1 }, live, [], undefined, true);
  // The live frame's box has no children from the scene: FlowTab adds its shapes.
  expect(childrenOf(s.nodes, boardFrameId("Refund"))).toHaveLength(0);
  expect(childrenOf(s.nodes, boardFrameId("Checkout"))[0].type).toBe(FRAME_PREVIEW_TYPE);
});

test("the_preview_draws_each_shape_where_the_full_frame_does", () => {
  const r = createFlowService().parse("board", THREE);
  const scene = createBoardScene("modern");
  const full = scene.build(r.frames, LAYOUT(), KEYS, null, null, [], undefined, false);
  const b = LAYOUT();
  const pre = scene.build(r.frames, b, KEYS, null, null, [], undefined, true);
  for (const key of KEYS) {
    const id = boardFrameId(key);
    // The frame's box is the same node both ways: the swap moves nothing.
    expect(pre.nodes.find((n) => n.id === id)).toEqual(full.nodes.find((n) => n.id === id));
    const p = childrenOf(pre.nodes, id)[0];
    const data = p.data as FramePreviewData;
    const kids = childrenOf(full.nodes, id);
    const areas = kids.filter((n) => n.type === "area").map(box);
    const shapes = kids.filter((n) => n.type !== "area").map(box);
    expect(data.areas).toEqual(areas);
    expect(data.shapes).toEqual(shapes);
    // The preview fills its frame's box from its corner.
    expect(p.position).toEqual({ x: 0, y: 0 });
    const frame = full.nodes.find((n) => n.id === id)!;
    expect(p.initialWidth).toBe(frame.initialWidth);
    expect(p.initialHeight).toBe(frame.initialHeight);
    // One straight segment a line, from shape centre to shape centre.
    expect(data.lines).toHaveLength(edgesIn(full.edges, key).length);
  }
  const ship = childrenOf(pre.nodes, boardFrameId("Shipping"))[0].data as FramePreviewData;
  const [pack, send] = ship.shapes;
  expect(ship.lines[0]).toEqual([pack.x + pack.w / 2, pack.y + pack.h / 2, send.x + send.w / 2, send.y + send.h / 2]);
});

test("a_keystroke_in_another_frame_keeps_the_preview", () => {
  const svc = createFlowService();
  const r1 = svc.parse("board", THREE);
  const b = LAYOUT();
  const scene = createBoardScene("modern");
  const s1 = scene.build(r1.frames, b, KEYS, null, null, [], undefined, true);
  const r2 = svc.parse("board", THREE.replace("Ask > Refund it", "Ask > Refund it: ok"));
  const s2 = scene.build(r2.frames, b, KEYS, null, null, [], undefined, true);
  for (const key of ["Checkout", "Shipping"]) expect(childrenOf(s2.nodes, boardFrameId(key))[0]).toBe(childrenOf(s1.nodes, boardFrameId(key))[0]);
  expect(childrenOf(s2.nodes, boardFrameId("Refund"))[0]).not.toBe(childrenOf(s1.nodes, boardFrameId("Refund"))[0]);
  // Zooming across BOX_BELOW and back makes no new preview either.
  scene.build(r2.frames, b, KEYS, null, null, [], undefined, false);
  const s4 = scene.build(r2.frames, b, KEYS, null, null, [], undefined, true);
  for (const key of KEYS) expect(childrenOf(s4.nodes, boardFrameId(key))[0]).toBe(childrenOf(s2.nodes, boardFrameId(key))[0]);
});
