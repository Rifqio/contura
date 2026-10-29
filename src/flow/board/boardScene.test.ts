// Task 5: every frame of a board on one canvas. Static frames are frame nodes with their shapes as prefixed children,
// in z bands under the live frame (Decisions 1, 2, 4 and 5); each is rebuilt only when its doc or layout changes.
import type { Edge, Node } from "@xyflow/react";
import { expect, test, vi } from "vitest";
import type { FlowProblem } from "../../lang/flow/problems";
import { createFlowService, type FrameResult } from "../../lang/flow/service";
import { buildFlowGraph, nodeSize } from "../flowNodes";
import { flowScene } from "../flowScene";
import { reviewOverlay } from "../ai/reviewOverlay";
import type { FrameReview } from "../ai/boardReview";
import { ER_MAX_ROWS } from "../kindLayout";
import { inStaticFrame } from "../kindEdit";
import { emptyPositions } from "../layout";
import { type BoardLayout, drawnBox, FRAME_MIN, FRAME_PAD, type FrameLayout, frameBounds, type Sketch } from "./boardLayout";
import { board as bigBoard, FRAMES } from "../../lang/flow/fixtures/bigBoard";
import { bigBoardLayout } from "../../lang/flow/fixtures/bigBoardLayout";
import type { DrawnForms, FrameForm } from "./boardDetail";
import { SKETCH_LAYER_ID, sketchNodeId } from "./sketches";
import type { ExportPalette } from "../../diagram/export/palette";
import { frameOf } from "../../diagram/export/svg";
import { NODE_TOKENS } from "../../diagram/types";
import { createPictureStore } from "./framePicture";
import {
  boardFrameId,
  type ClashLayout,
  clashInFrameId,
  createBoardScene,
  duplicateFrameId,
  FRAME_PICTURE_TYPE,
  type FramePictureData,
  type FrameBox,
  inFrameId,
  isStaticId,
  LIVE_ANCHOR_ID,
  liveZ,
  SKETCH_PICTURE_TYPE,
  STATIC_CLASS,
  staticZ,
  TEXT_SCALE,
  Z_BAND,
  Z_LIVE,
  Z_LIVE_BOX,
  Z_SKETCH,
  Z_SKETCH_BOX,
} from "./boardScene";

const CHECKOUT = 'diagram flow "Checkout"\nShop {\n  Cart\n  Pay\n}\nCart > Pay: card\n';
const REFUND = 'diagram flow "Refund"\nAsk\nRefund it\nAsk > Refund it\n';
const SHIPPING = 'diagram flow "Shipping"\nPack\nSend\nPack > Send\n';

function parse(text: string, svc = createFlowService()) {
  return svc.parse("board", text);
}

function entry(at: { x: number; y: number }, nodes: Record<string, { x: number; y: number }>, more: Partial<FrameLayout> = {}): FrameLayout {
  return { at, nodes: Object.assign(emptyPositions(), nodes), style: "modern", direction: "TB", ...more };
}

function layout(entries: Record<string, FrameLayout>): BoardLayout {
  return { frames: new Map(Object.entries(entries)), sketches: [] };
}

const THREE_LAYOUT = () =>
  layout({
    Checkout: entry({ x: 0, y: 0 }, { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }),
    Refund: entry({ x: 600, y: 0 }, { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } }),
    Shipping: entry({ x: 1200, y: 40 }, { Pack: { x: 0, y: 0 }, Send: { x: 0, y: 120 } }),
  });
const THREE = [CHECKOUT, REFUND, SHIPPING].join("\n");
const KEYS = ["Checkout", "Refund", "Shipping"];

/** The live frame's nodes as FlowTab builds them: bare names, at their frame-local places. */
function liveNodes(f: FrameResult, e: FrameLayout): { nodes: Node[] } {
  return { nodes: buildFlowGraph(f.doc!, e.nodes, e.style, { sizes: e.sizes }).nodes };
}

const childrenOf = (nodes: Node[], frameId: string) => nodes.filter((n) => n.parentId === frameId);
const edgesOf = (edges: Edge[], key: string) => edges.filter((e) => e.id.startsWith(`\u0000in:${key}\u0000`));

test("frames_draw_side_by_side_with_prefixed_ids", () => {
  const r = parse(THREE);
  const b = THREE_LAYOUT();
  const s = createBoardScene("modern").build(r.frames, b, KEYS, null, null, []);
  expect(s.boxes.map((x) => x.title)).toEqual(KEYS);
  // Each frame's box sits right of the one before (their entries are 600 apart), none overlapping.
  for (let i = 1; i < s.boxes.length; i++) expect(s.boxes[i].x).toBeGreaterThanOrEqual(s.boxes[i - 1].x + s.boxes[i - 1].w);
  for (const [i, key] of KEYS.entries()) {
    const frameId = boardFrameId(key);
    const box = s.nodes.find((n) => n.id === frameId)!;
    expect(box, key).toBeDefined();
    expect(box.type).toBe("boardFrame");
    // The box comes before its children (React Flow needs a parent first).
    const kids = childrenOf(s.nodes, frameId);
    expect(kids.length).toBeGreaterThan(0);
    for (const k of kids) expect(s.nodes.indexOf(k)).toBeGreaterThan(s.nodes.indexOf(box));
    const prefix = `\u0000in:${key}\u0000`;
    for (const k of kids) {
      expect(k.id.startsWith(prefix), k.id).toBe(true);
      expect(k.selectable).toBe(false);
      expect(k.draggable).toBe(false);
      expect(k.connectable).toBe(false);
      expect(k.focusable).toBe(false);
    }
    const edges = edgesOf(s.edges, key);
    expect(edges.length, key).toBe(1);
    for (const e of edges) {
      expect(e.source.startsWith(prefix)).toBe(true);
      expect(e.target.startsWith(prefix)).toBe(true);
      expect(e.selectable).toBe(false);
    }
    expect(s.boxes[i].key).toBe(key);
  }
  // The group area is a prefixed `\u0000group:` id, and its edge ends on prefixed node ids.
  expect(s.nodes.some((n) => n.id === inFrameId("Checkout", "\u0000group:Shop"))).toBe(true);
  expect(s.edges.find((e) => e.id === inFrameId("Checkout", "edge:0"))).toMatchObject({ source: inFrameId("Checkout", "Cart"), target: inFrameId("Checkout", "Pay") });
  for (const n of s.nodes) expect(n.id.startsWith("\u0000frame:")).toBe(false);
  // Every id is unique on the canvas.
  expect(new Set(s.nodes.map((n) => n.id)).size).toBe(s.nodes.length);
  expect(new Set(s.edges.map((e) => e.id)).size).toBe(s.edges.length);
});

test("a_frame_titled_0_does_not_meet_a_loop_box", () => {
  const seq = 'diagram sequence "Talk"\nparticipant A\nparticipant B\nloop again {\n  A -> B : hi\n}\n';
  const zero = 'diagram flow "0"\nX\n';
  const r = parse(`${seq}\n${zero}`);
  const b = layout({ Talk: entry({ x: 0, y: 0 }, {}), "0": entry({ x: 800, y: 0 }, { X: { x: 0, y: 0 } }) });
  const s = createBoardScene("modern").build(r.frames, b, ["Talk", "0"], null, null, []);
  const ids = s.nodes.map((n) => n.id);
  expect(new Set(ids).size).toBe(ids.length);
  // The loop box is inside the sequence frame's prefix; the board frame "0" is its own id.
  expect(ids).toContain(inFrameId("Talk", "\u0000frame:0"));
  expect(ids).toContain(boardFrameId("0"));
  expect(ids).not.toContain("\u0000frame:0");
  expect(boardFrameId("0")).not.toBe(inFrameId("Talk", "\u0000frame:0"));
  expect(childrenOf(s.nodes, boardFrameId("0")).map((n) => n.id)).toEqual([inFrameId("0", "X")]);
});

test("the_selected_frame_is_live_on_the_board", () => {
  const r = parse(THREE);
  const b = THREE_LAYOUT();
  const sel = r.frames[1];
  const s = createBoardScene("modern").build(r.frames, b, KEYS, { title: "Refund", index: 1 }, liveNodes(sel, b.frames.get("Refund")!), []);
  // The live frame has only its box here (and the anchor its shapes hang from): FlowTab draws its shapes with bare names.
  expect(childrenOf(s.nodes, boardFrameId("Refund"))).toEqual([]);
  expect(s.nodes.some((n) => n.id.startsWith("\u0000in:Refund\u0000"))).toBe(false);
  // Another frame's box sits at its board place (Plan F Decision 11: one origin for the whole board).
  const ship = frameBounds(b.frames.get("Shipping")!, r.frames[2].doc, "modern");
  const shipBox = s.nodes.find((n) => n.id === boardFrameId("Shipping"))!;
  expect(shipBox.position).toEqual({ x: ship.x, y: ship.y });
  expect(s.boxes[2]).toMatchObject({ x: ship.x, y: ship.y, w: ship.w, h: ship.h });
  // The live box comes with the scene (finding 9: FlowTab no longer scans every node for it).
  expect(s.live).toBe(s.boxes[1]);
  expect(s.live).toMatchObject({ key: "Refund", index: 1 });
  // A static child's absolute place is its board place.
  const pack = s.nodes.find((n) => n.id === inFrameId("Shipping", "Pack"))!;
  expect(shipBox.position.x + pack.position.x).toBe(1200 + 0);
  expect(shipBox.position.y + pack.position.y).toBe(40 + 0);
});

test("nothing_selected_has_no_live_frame_and_no_anchor", () => {
  const r = parse(THREE);
  const b = THREE_LAYOUT();
  const s = createBoardScene("modern").build(r.frames, b, KEYS, null, null, []);
  expect(s.nodes.some((n) => n.id === LIVE_ANCHOR_ID)).toBe(false);
  expect(s.live).toBeNull();
  for (const key of KEYS) {
    expect(childrenOf(s.nodes, boardFrameId(key)).length).toBeGreaterThan(0);
    expect(s.nodes.find((n) => n.id === boardFrameId(key))!.zIndex).toBeLessThan(Z_LIVE_BOX);
  }
  for (const n of s.nodes) expect(n.zIndex ?? 0).toBeLessThan(Z_LIVE_BOX);
});

test("z_bands_keep_static_frames_under_the_live_one", () => {
  const seq = 'diagram sequence "Talk"\nparticipant A\nparticipant B\nloop again {\n  A -> B : hi\n}\n';
  const r = parse(`${CHECKOUT}\n${seq}\n${REFUND}`);
  const b = layout({
    Checkout: entry({ x: 0, y: 0 }, { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }),
    Talk: entry({ x: 600, y: 0 }, {}),
    Refund: entry({ x: 1400, y: 0 }, { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } }),
  });
  const keys = ["Checkout", "Talk", "Refund"];
  const s = createBoardScene("modern").build(r.frames, b, keys, { title: "Refund", index: 2 }, liveNodes(r.frames[2], b.frames.get("Refund")!), []);
  for (const [k, key] of keys.slice(0, 2).entries()) {
    const box = s.nodes.find((n) => n.id === boardFrameId(key))!;
    expect(box.zIndex).toBe(Z_BAND * k);
    const kids = childrenOf(s.nodes, boardFrameId(key));
    for (const n of kids) {
      expect(n.zIndex!, n.id).toBeGreaterThan(Z_BAND * k);
      expect(n.zIndex!, n.id).toBeLessThanOrEqual(Z_BAND * k + 29);
      expect(n.zIndex!).toBeLessThan(Z_LIVE_BOX);
    }
    for (const e of edgesOf(s.edges, key)) {
      expect(e.zIndex!).toBeGreaterThan(Z_BAND * k);
      expect(e.zIndex!).toBeLessThanOrEqual(Z_BAND * k + 29);
    }
  }
  // A depth-0 group area (own z -21) stays above its frame's box.
  const area = s.nodes.find((n) => n.id === inFrameId("Checkout", "\u0000group:Shop"))!;
  expect(area.zIndex).toBe(staticZ(0, -21));
  expect(area.zIndex!).toBeGreaterThan(0);
  expect(area.zIndex!).toBeLessThan(s.nodes.find((n) => n.id === inFrameId("Checkout", "Cart"))!.zIndex!);
  // The loop box stays below the participants.
  const loop = s.nodes.find((n) => n.id === inFrameId("Talk", "\u0000frame:0"))!;
  const a = s.nodes.find((n) => n.id === inFrameId("Talk", "A"))!;
  expect(loop.zIndex!).toBeLessThan(a.zIndex!);
  // The loop tab (+1) stays above the participants, inside the band.
  const tab = s.nodes.find((n) => n.id === inFrameId("Talk", "\u0000frameTab:0"))!;
  expect(tab.zIndex!).toBeGreaterThan(a.zIndex!);
  // The live frame: its box at 1,995, its content from 2,000, a depth-0 area above the box.
  expect(s.nodes.find((n) => n.id === boardFrameId("Refund"))!.zIndex).toBe(Z_LIVE_BOX);
  expect(liveZ(-25)).toBe(Z_LIVE);
  expect(liveZ(-21)).toBeGreaterThan(Z_LIVE_BOX);
  expect(liveZ(3)).toBe(Z_LIVE + 28);
  expect(liveZ(100)).toBe(Z_LIVE + 28);
  // Fifty static frames end under the live box.
  expect(staticZ(49, 100)).toBe(1_499);
  expect(staticZ(49, -100)).toBe(49 * Z_BAND + 1);
});

test("a_switch_keeps_other_static_frames_ids", () => {
  const r = parse(THREE);
  const b = THREE_LAYOUT();
  const scene = createBoardScene("modern");
  const onA = scene.build(r.frames, b, KEYS, { title: "Checkout", index: 0 }, liveNodes(r.frames[0], b.frames.get("Checkout")!), []);
  const onB = scene.build(r.frames, b, KEYS, { title: "Refund", index: 1 }, liveNodes(r.frames[1], b.frames.get("Refund")!), []);
  // C (Shipping) stays static: the very same child node and edge objects, at the same ids.
  const cBefore = childrenOf(onA.nodes, boardFrameId("Shipping"));
  const cAfter = childrenOf(onB.nodes, boardFrameId("Shipping"));
  expect(cAfter.length).toBe(2);
  cAfter.forEach((n, i) => expect(n).toBe(cBefore[i]));
  const ceBefore = edgesOf(onA.edges, "Shipping");
  edgesOf(onB.edges, "Shipping").forEach((e, i) => expect(e).toBe(ceBefore[i]));
  // C's box keeps its id and its place: the board has one origin (Plan F Decision 11).
  expect(onB.nodes.find((n) => n.id === boardFrameId("Shipping"))!.position.x).toBe(onA.nodes.find((n) => n.id === boardFrameId("Shipping"))!.position.x);
  // A became static (its children drawn), B became live (none drawn).
  expect(childrenOf(onA.nodes, boardFrameId("Checkout"))).toEqual([]);
  expect(childrenOf(onB.nodes, boardFrameId("Checkout")).length).toBeGreaterThan(0);
  expect(childrenOf(onA.nodes, boardFrameId("Refund")).length).toBe(2);
  expect(childrenOf(onB.nodes, boardFrameId("Refund"))).toEqual([]);
});

// ----- Plan F Task 4 (Decision 11): one origin for the whole board.

const SKETCHED = (): BoardLayout => ({ ...THREE_LAYOUT(), sketches: [{ id: "s1", kind: "rect", x: 900, y: 500, w: 120, h: 80 } satisfies Sketch] });

test("a_switch_keeps_the_sketch_layer", () => {
  const r = parse(THREE);
  const b = SKETCHED();
  const scene = createBoardScene("modern");
  const onA = scene.build(r.frames, b, KEYS, { title: "Checkout", index: 0 }, liveNodes(r.frames[0], b.frames.get("Checkout")!), []);
  const onB = scene.build(r.frames, b, KEYS, { title: "Refund", index: 1 }, liveNodes(r.frames[1], b.frames.get("Refund")!), []);
  const none = scene.build(r.frames, b, KEYS, null, null, []);
  const layer = onA.nodes.find((n) => n.id === SKETCH_LAYER_ID)!;
  // The layer sits at (0, 0) for good: a switch, or nothing live, hands React Flow the very same node.
  expect(layer.position).toEqual({ x: 0, y: 0 });
  expect(onB.nodes.find((n) => n.id === SKETCH_LAYER_ID)).toBe(layer);
  expect(none.nodes.find((n) => n.id === SKETCH_LAYER_ID)).toBe(layer);
  expect(onB.nodes.find((n) => n.id === sketchNodeId("s1"))).toBe(onA.nodes.find((n) => n.id === sketchNodeId("s1")));
});

test("a_switch_keeps_every_other_box_node", () => {
  const r = parse(THREE);
  const b = THREE_LAYOUT();
  const scene = createBoardScene("modern");
  const onA = scene.build(r.frames, b, KEYS, { title: "Checkout", index: 0 }, liveNodes(r.frames[0], b.frames.get("Checkout")!), []);
  const onB = scene.build(r.frames, b, KEYS, { title: "Refund", index: 1 }, liveNodes(r.frames[1], b.frames.get("Refund")!), []);
  const box = (s: typeof onA, key: string) => s.nodes.find((n) => n.id === boardFrameId(key))!;
  // Only the old and the new live frame's box nodes are new objects; Shipping's is the very same, at its board place.
  expect(box(onB, "Shipping")).toBe(box(onA, "Shipping"));
  expect(box(onB, "Checkout")).not.toBe(box(onA, "Checkout"));
  expect(box(onB, "Refund")).not.toBe(box(onA, "Refund"));
  const ship = frameBounds(b.frames.get("Shipping")!, r.frames[2].doc, "modern");
  expect(box(onB, "Shipping").position).toEqual({ x: ship.x, y: ship.y });
  // Every box is in board units, live or not: the same place either side of the switch.
  for (const key of KEYS) expect(box(onB, key).position).toEqual(box(onA, key).position);
  expect(onB.boxes.map((x) => [x.x, x.y, x.w, x.h])).toEqual(onA.boxes.map((x) => [x.x, x.y, x.w, x.h]));
  expect("origin" in onB).toBe(false);
});

test("live_nodes_hang_from_the_anchor", () => {
  const r = parse(THREE);
  const b = THREE_LAYOUT();
  const scene = createBoardScene("modern");
  const lv = liveNodes(r.frames[1], b.frames.get("Refund")!);
  const s = scene.build(r.frames, b, KEYS, { title: "Refund", index: 1 }, lv, []);
  const anchor = s.nodes.find((n) => n.id === LIVE_ANCHOR_ID)!;
  // Zero size, no pointer events, in the live band, at the live frame's `at`.
  expect(anchor).toBeDefined();
  expect(anchor.position).toEqual({ x: 600, y: 0 });
  expect(anchor.initialWidth).toBe(0);
  expect(anchor.initialHeight).toBe(0);
  expect(anchor.style?.pointerEvents).toBe("none");
  expect(anchor.zIndex).toBe(Z_LIVE);
  expect(anchor.selectable).toBe(false);
  expect(anchor.draggable).toBe(false);
  // The live box is `at` plus the live nodes' drawn box (frame-local), in board units.
  const r0 = drawnBox(lv.nodes);
  expect(s.live).toMatchObject({ x: 600 + r0.x, y: 0 + r0.y, w: r0.w, h: r0.h });
  // A switch moves the anchor; nothing live, no anchor.
  const onA = scene.build(r.frames, b, KEYS, { title: "Shipping", index: 2 }, liveNodes(r.frames[2], b.frames.get("Shipping")!), []);
  expect(onA.nodes.find((n) => n.id === LIVE_ANCHOR_ID)!.position).toEqual({ x: 1200, y: 40 });
  expect(scene.build(r.frames, b, KEYS, null, null, []).nodes.some((n) => n.id === LIVE_ANCHOR_ID)).toBe(false);
});

test("tab_counts_come_from_problems", () => {
  const r = parse(THREE);
  const f2 = r.frames[2];
  const err = (from: number): FlowProblem => ({ line: 1, from, to: from + 1, severity: "error", message: "x", fixes: [] });
  const s = createBoardScene("modern").build(r.frames, THREE_LAYOUT(), KEYS, null, null, [err(f2.from + 2), err(f2.to - 1)]);
  expect(s.boxes.map((x) => x.problems)).toEqual([0, 0, 2]);
});

test("a_frame_fits_its_shapes", () => {
  const r = parse(THREE);
  const b = THREE_LAYOUT();
  const s = createBoardScene("modern").build(r.frames, b, KEYS, null, null, []);
  for (const [i, key] of KEYS.entries()) {
    const want = frameBounds(b.frames.get(key)!, r.frames[i].doc, "modern");
    expect(s.boxes[i]).toMatchObject(want);
    const box = s.nodes.find((n) => n.id === boardFrameId(key))!;
    for (const k of childrenOf(s.nodes, boardFrameId(key))) {
      expect(k.position.x).toBeGreaterThanOrEqual(FRAME_PAD);
      expect(k.position.y).toBeGreaterThanOrEqual(FRAME_PAD);
      expect(k.position.x + (k.initialWidth ?? 0)).toBeLessThanOrEqual(box.initialWidth! - FRAME_PAD);
      expect(k.position.y + (k.initialHeight ?? 0)).toBeLessThanOrEqual(box.initialHeight! - FRAME_PAD);
    }
  }
  // An empty frame is FRAME_MIN at its place.
  const empty = parse('diagram flow "Empty"\n');
  const e = createBoardScene("modern").build(empty.frames, layout({ Empty: entry({ x: 50, y: 60 }, {}) }), ["Empty"], null, null, []);
  expect(e.boxes[0]).toMatchObject({ x: 50, y: 60, ...FRAME_MIN });
  // The live frame's box from its live nodes alone.
  const sel = r.frames[0];
  const lv = liveNodes(sel, b.frames.get("Checkout")!);
  const l = createBoardScene("modern").build(r.frames, b, KEYS, { title: "Checkout", index: 0 }, lv, []);
  const live = frameBounds(b.frames.get("Checkout")!, sel.doc, "modern");
  expect(l.boxes[0]).toMatchObject({ x: live.x, y: live.y, w: live.w, h: live.h });
});

test("an_unchanged_frame_is_not_rebuilt", () => {
  const svc = createFlowService();
  const r1 = parse(THREE, svc);
  const b = THREE_LAYOUT();
  const scene = createBoardScene("modern");
  const s1 = scene.build(r1.frames, b, KEYS, null, null, []);
  // A change in Refund only: Checkout and Shipping keep their docs, so their nodes are the same objects.
  const r2 = parse(THREE.replace("Ask > Refund it", "Ask > Refund it: ok"), svc);
  expect(r2.frames[0].doc).toBe(r1.frames[0].doc);
  const s2 = scene.build(r2.frames, b, KEYS, null, null, []);
  for (const key of ["Checkout", "Shipping"]) {
    childrenOf(s2.nodes, boardFrameId(key)).forEach((n, i) => expect(n).toBe(childrenOf(s1.nodes, boardFrameId(key))[i]));
    edgesOf(s2.edges, key).forEach((e, i) => expect(e).toBe(edgesOf(s1.edges, key)[i]));
    expect(s2.nodes.find((n) => n.id === boardFrameId(key))).toBe(s1.nodes.find((n) => n.id === boardFrameId(key)));
  }
  expect(edgesOf(s2.edges, "Refund")[0]).not.toBe(edgesOf(s1.edges, "Refund")[0]);
  expect((edgesOf(s2.edges, "Refund")[0].data as { label?: string }).label).toBe("ok");
  // A new entry for Shipping (a moved node) rebuilds Shipping only.
  const b2: BoardLayout = { ...b, frames: new Map(b.frames) };
  b2.frames.set("Shipping", entry({ x: 1200, y: 40 }, { Pack: { x: 10, y: 0 }, Send: { x: 0, y: 120 } }));
  const s3 = scene.build(r2.frames, b2, KEYS, null, null, []);
  expect(s3.nodes.find((n) => n.id === inFrameId("Shipping", "Pack"))).not.toBe(s2.nodes.find((n) => n.id === inFrameId("Shipping", "Pack")));
  expect(s3.nodes.find((n) => n.id === inFrameId("Checkout", "Cart"))).toBe(s2.nodes.find((n) => n.id === inFrameId("Checkout", "Cart")));
});

test("a_live_drag_tick_rebuilds_no_static_frame", () => {
  const r = parse(THREE);
  const b = THREE_LAYOUT();
  const scene = createBoardScene("modern");
  const sel = { title: "Checkout", index: 0 };
  const lv = liveNodes(r.frames[0], b.frames.get("Checkout")!);
  const s1 = scene.build(r.frames, b, KEYS, sel, lv, []);
  // A drag tick: the live nodes move, nothing else changes.
  const moved = { nodes: lv.nodes.map((n) => (n.id === "Pay" ? { ...n, position: { x: 400, y: 300 } } : n)) };
  const s2 = scene.build(r.frames, b, KEYS, sel, moved, []);
  for (const key of ["Refund", "Shipping"]) {
    expect(s2.nodes.find((n) => n.id === boardFrameId(key))).toBe(s1.nodes.find((n) => n.id === boardFrameId(key)));
    childrenOf(s2.nodes, boardFrameId(key)).forEach((n, i) => expect(n).toBe(childrenOf(s1.nodes, boardFrameId(key))[i]));
    edgesOf(s2.edges, key).forEach((e, i) => expect(e).toBe(edgesOf(s1.edges, key)[i]));
  }
  // The live box grew to the moved node.
  const box = s2.boxes[0];
  const pay = moved.nodes.find((n) => n.id === "Pay")!;
  expect(box.x + box.w).toBe(400 + (pay.initialWidth ?? 0) + FRAME_PAD);
  expect(box.y + box.h).toBe(300 + (pay.initialHeight ?? 0) + FRAME_PAD);
});

test("gone_frames_leave_the_memo", () => {
  const r = parse(THREE);
  const b = THREE_LAYOUT();
  const scene = createBoardScene("modern");
  const s1 = scene.build(r.frames, b, KEYS, null, null, []);
  const two = parse([CHECKOUT, SHIPPING].join("\n"));
  scene.build(two.frames, b, ["Checkout", "Shipping"], null, null, []);
  expect(scene.memoSize()).toBe(2);
  expect(scene.boxMemoSize()).toBe(2);
  // Refund comes back: built anew, not the old objects.
  const s3 = scene.build(r.frames, b, KEYS, null, null, []);
  expect(scene.memoSize()).toBe(3);
  expect(scene.boxMemoSize()).toBe(3);
  expect(s3.nodes.find((n) => n.id === inFrameId("Refund", "Ask"))).not.toBe(s1.nodes.find((n) => n.id === inFrameId("Refund", "Ask")));
});

test("a_second_frame_with_a_taken_title_draws_faded_by_index", () => {
  // A flowchart whose title an earlier frame has: no layout entry of its own (Decision 9), yet it draws its shapes.
  const again = 'diagram flow "Checkout"\nOther\nMore\nOther > More\n';
  const r = parse(`${CHECKOUT}\n${again}`);
  const b = layout({ Checkout: entry({ x: 0, y: 0 }, { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }) });
  // useFlowDoc keys a frame whose title an earlier frame has as `\u0000#<index>`.
  const keys = ["Checkout", "\u0000#1"];
  const s = createBoardScene("modern").build(r.frames, b, keys, null, null, []);
  const ids = s.nodes.map((n) => n.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toContain(boardFrameId("Checkout"));
  expect(ids).toContain(duplicateFrameId(1));
  expect(s.boxes[1]).toMatchObject({ index: 1, title: "Checkout", key: null, clash: true });
  expect(s.boxes[0]).toMatchObject({ key: "Checkout", clash: false });
  const box = s.nodes.find((n) => n.id === duplicateFrameId(1))!;
  expect((box.data as { faded?: boolean }).faded).toBe(true);
  // Never an empty box: before its layout comes back its shapes stand in a row, faded, the line between them drawn.
  const kids = childrenOf(s.nodes, duplicateFrameId(1));
  expect(kids.map((k) => k.id).sort()).toEqual([clashInFrameId(1, "More"), clashInFrameId(1, "Other")]);
  for (const k of kids) expect(k.className).toContain("board-faded");
  expect(s.edges.filter((e) => e.id === clashInFrameId(1, "edge:0"))).toHaveLength(1);
  for (const k of childrenOf(s.nodes, boardFrameId("Checkout"))) expect(k.className ?? "").not.toContain("board-faded");
  // Its automatic layout (useFlowDoc's `clashLayouts`, never saved) places it and its shapes.
  const laid: ClashLayout = { title: "Checkout", entry: entry({ x: 900, y: 50 }, { Other: { x: 0, y: 0 }, More: { x: 0, y: 150 } }) };
  const placed = createBoardScene("modern").build(r.frames, b, keys, null, null, [], new Map([[1, laid]]));
  expect(placed.boxes[1]).toMatchObject(frameBounds(laid.entry, r.frames[1].doc, "modern"));
  const pBox = placed.nodes.find((n) => n.id === duplicateFrameId(1))!;
  const more = placed.nodes.find((n) => n.id === clashInFrameId(1, "More"))!;
  expect({ x: pBox.position.x + more.position.x, y: pBox.position.y + more.position.y }).toEqual({ x: 900, y: 200 });
  // A layout made for another title at this index is not used.
  const stale = createBoardScene("modern").build(r.frames, b, keys, null, null, [], new Map([[1, { ...laid, title: "Gone" }]]));
  expect(stale.boxes[1].x).not.toBe(placed.boxes[1].x);
  // Selecting the clashing frame never makes it live.
  const sel = createBoardScene("modern").build(r.frames, b, keys, { title: "Checkout", index: 1 }, { nodes: [] }, []);
  expect(childrenOf(sel.nodes, duplicateFrameId(1)).length).toBe(2);
  expect(sel.nodes.find((n) => n.id === duplicateFrameId(1))!.zIndex).toBe(Z_BAND);
});

test("clash_and_title_ids_never_meet", () => {
  // A frame titled "#3" (and ones titled like the other id forms) beside a clash frame at index 3.
  const f = (t: string, n: string) => `diagram flow "${t}"\n${n}\n`;
  const titles = ["A", "#3", "\u00013", "A", "\u0000clash:3"];
  const r = parse(titles.map((t, i) => f(t, `N${i}`)).join("\n"));
  const keys = ["A", "#3", "\u00013", "\u0000#3", "\u0000clash:3"];
  const b = layout(Object.fromEntries(keys.filter((k) => !k.startsWith("\u0000#")).map((k, i) => [k, entry({ x: i * 500, y: 0 }, { [`N${titles.indexOf(k)}`]: { x: 0, y: 0 } })])));
  const s = createBoardScene("modern").build(r.frames, b, keys, null, null, []);
  const ids = s.nodes.map((n) => n.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toHaveLength(titles.length * 2);
  expect(duplicateFrameId(3)).not.toBe(boardFrameId("#3"));
  expect(duplicateFrameId(3)).not.toBe(boardFrameId("\u00013"));
  // A title with a NUL never meets another frame's child id.
  expect(inFrameId("a\u0000group:X", "Y")).not.toBe(inFrameId("a", "\u0000group:X\u0000Y"));
  expect(clashInFrameId(3, "Y")).not.toBe(inFrameId("#3", "Y"));
  expect(clashInFrameId(3, "Y")).not.toBe(inFrameId("\u00013", "Y"));
});

test("a_frame_box_is_frame_bounds_with_an_empty_group", () => {
  // An empty group is drawn as an area at its kept place; the box placement uses holds it too.
  const text = 'diagram flow "Plan"\nA\nB\nLater {\n}\nA > B\n';
  const r = parse(text);
  expect(r.frames[0].doc!.groups.map((g) => g.name)).toEqual(["Later"]);
  const e = entry({ x: 100, y: 0 }, { A: { x: 0, y: 0 }, B: { x: 0, y: 120 }, Later: { x: 600, y: 400 } });
  const s = createBoardScene("modern").build(r.frames, layout({ Plan: e }), ["Plan"], null, null, []);
  const want = frameBounds(e, r.frames[0].doc, "modern");
  expect(s.boxes[0]).toMatchObject(want);
  expect(want.x + want.w).toBeGreaterThanOrEqual(100 + 600 + 240 + FRAME_PAD);
  // A sequence's loop box counts too.
  const seq = parse('diagram sequence "Talk"\nparticipant A\nparticipant B\nloop again {\n  A -> B : hi\n}\n');
  const se = entry({ x: 0, y: 0 }, {});
  expect(createBoardScene("modern").build(seq.frames, layout({ Talk: se }), ["Talk"], null, null, []).boxes[0]).toMatchObject(frameBounds(se, seq.frames[0].doc, "modern"));
  // And a frame's text size.
  const big = entry({ x: 0, y: 0 }, { A: { x: 0, y: 0 }, B: { x: 0, y: 120 } }, { textSize: "l" });
  expect(createBoardScene("modern").build(r.frames, layout({ Plan: big }), ["Plan"], null, null, []).boxes[0]).toMatchObject(frameBounds(big, r.frames[0].doc, "modern"));
});

test("a_frame_with_an_error_draws_its_last_good_doc_faded", () => {
  const svc = createFlowService();
  const r1 = parse(THREE, svc);
  const r2 = parse(THREE.replace("Pack > Send", "Pack > > Send"), svc);
  expect(r2.frames[2].doc).toBeNull();
  const s = createBoardScene("modern").build(r2.frames, THREE_LAYOUT(), KEYS, null, null, []);
  expect(r2.frames[2].lastValid ?? r1.frames[2].doc).not.toBeNull();
  const kids = childrenOf(s.nodes, boardFrameId("Shipping"));
  expect(kids.length).toBe(2);
  for (const k of kids) expect(k.className).toContain("board-faded");
  expect(s.boxes[2].clash).toBe(false);
});

test("text_size_scales_labels", () => {
  expect(TEXT_SCALE).toEqual({ s: 0.88, m: 1, l: 1.15 });
  const plain = nodeSize("process", "modern", "Take payment");
  expect(nodeSize("process", "modern", "Take payment", undefined, undefined, 1)).toEqual(plain);
  const big = nodeSize("process", "modern", "Take payment", undefined, undefined, TEXT_SCALE.l);
  expect(big.w).toBeGreaterThan(plain.w);
  expect(big.h).toBeGreaterThan(plain.h);
  const r = parse(CHECKOUT);
  const at = { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } };
  const m = createBoardScene("modern").build(r.frames, layout({ Checkout: entry({ x: 0, y: 0 }, at) }), ["Checkout"], null, null, []);
  const l = createBoardScene("modern").build(r.frames, layout({ Checkout: entry({ x: 0, y: 0 }, at, { textSize: "l" }) }), ["Checkout"], null, null, []);
  const cartM = m.nodes.find((n) => n.id === inFrameId("Checkout", "Cart"))!;
  const cartL = l.nodes.find((n) => n.id === inFrameId("Checkout", "Cart"))!;
  expect(cartL.initialWidth!).toBeGreaterThan(cartM.initialWidth!);
  expect((cartL.data as { textScale?: number }).textScale).toBe(1.15);
  expect((cartM.data as { textScale?: number }).textScale).toBeUndefined();
  const edgeL = l.edges.find((e) => e.id === inFrameId("Checkout", "edge:0"))!;
  expect((edgeL.data as { textScale?: number }).textScale).toBe(1.15);
  // GraphOptions.textScale is the same scale on the live frame's graph.
  const g = buildFlowGraph(r.frames[0].doc!, at, "modern", { textScale: TEXT_SCALE.s });
  expect(g.nodes.find((n) => n.id === "Cart")!.initialWidth!).toBeLessThanOrEqual(cartM.initialWidth!);
  expect((g.nodes.find((n) => n.id === "Cart")!.data as { textScale?: number }).textScale).toBe(0.88);
  // Publish sizes its nodes at the same scale.
  const pubM = flowScene(r.frames[0].doc!, at, "modern", new Map());
  const pubL = flowScene(r.frames[0].doc!, at, "modern", new Map(), undefined, undefined, { textScale: TEXT_SCALE.l });
  expect(pubL.nodes.find((n) => n.id === "Cart")!.w).toBe(cartL.initialWidth);
  expect(pubM.nodes.find((n) => n.id === "Cart")!.w).toBe(cartM.initialWidth);
});

test("frame_box_fields", () => {
  const r = parse(THREE);
  const s = createBoardScene("modern").build(r.frames, THREE_LAYOUT(), KEYS, null, null, []);
  const box: FrameBox = s.boxes[1];
  expect(box).toMatchObject({ key: "Refund", index: 1, title: "Refund", kind: "flow", problems: 0, clash: false });
  expect((s.nodes.find((n) => n.id === boardFrameId("Refund"))!.data as { box: FrameBox }).box).toEqual(box);
});

test("is_static_id_knows_every_static_form_and_no_live_id", () => {
  for (const id of [boardFrameId("Checkout"), duplicateFrameId(2), inFrameId("Checkout", "Cart"), inFrameId("a\u0000b", "Cart"), clashInFrameId(2, "Cart")]) expect(isStaticId(id)).toBe(true);
  for (const id of ["Cart", "\u0000group:Payments", "\u0000frame:0", "\u0000sketch:s1", "\u0000inside"]) expect(isStaticId(id)).toBe(false);
});

test("kind_edit_knows_static_shapes_as_is_static_id_does", () => {
  // kindEdit.tsx reads isStaticId from the leaf staticIds.ts (B3 R1; no import cycle through the scene), so every
  // static form, a frame preview's included, is static there too.
  for (const id of [inFrameId("User", "User"), clashInFrameId(3, "User"), boardFrameId("User"), duplicateFrameId(3)]) expect(inStaticFrame(id)).toBe(true);
  for (const id of ["User", "\u0000group:Box", "\u0000sketch:s1"]) expect(inStaticFrame(id)).toBe(false);
  expect(inStaticFrame(null)).toBe(false);
});

test("static_children_carry_their_text_size_class", () => {
  // Plan F Decision 4: each static shape carries its frame's text size, so flow-board.css fades it at that size's zoom.
  const r = parse(THREE);
  const b = layout({
    Checkout: entry({ x: 0, y: 0 }, { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, { textSize: "s" }),
    Refund: entry({ x: 600, y: 0 }, { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } }),
    Shipping: entry({ x: 1200, y: 40 }, { Pack: { x: 0, y: 0 }, Send: { x: 0, y: 120 } }, { textSize: "l" }),
  });
  const s = createBoardScene("modern").build(r.frames, b, KEYS, null, null, []);
  const want: Record<string, string> = { Checkout: "board-ts-s", Refund: "board-ts-m", Shipping: "board-ts-l" };
  for (const [key, cls] of Object.entries(want)) {
    const kids = childrenOf(s.nodes, boardFrameId(key));
    expect(kids.length, key).toBeGreaterThan(0);
    for (const n of kids) expect(n.className?.split(" "), `${key} ${n.id}`).toContain(cls);
  }
  // The frame's own box (its tab) never carries one: frame titles keep their size (Decision 5).
  for (const key of KEYS) expect(s.nodes.find((n) => n.id === boardFrameId(key))!.className ?? "").not.toMatch(/board-ts-/);
});

// ----- Plan F Task 6 (Decision 6): only frames in view are drawn; `children` still lists every static frame's shapes.

const forms = (real: number[], mounted: [number, number][] = [], picture: number[] = []): DrawnForms => ({
  form: new Map<number, FrameForm>([...real.map((i) => [i, "real"] as const), ...picture.map((i) => [i, "picture"] as const)]),
  mounted: new Map(mounted),
});

test("off_screen_frames_push_no_children", () => {
  const r = parse(bigBoard());
  const keys = Array.from({ length: FRAMES }, (_, k) => `Area ${k}`);
  const s = createBoardScene("modern").build(r.frames, bigBoardLayout(), keys, null, null, [], undefined, forms([0, 1, 2, 3, 4]));
  for (let k = 0; k < FRAMES; k++) {
    const id = boardFrameId(`Area ${k}`);
    expect(s.nodes.filter((n) => n.id === id)).toHaveLength(1);
    expect(childrenOf(s.nodes, id).length, `Area ${k}`).toBe(k < 5 ? 200 : 0);
    expect(edgesOf(s.edges, `Area ${k}`).length > 0, `Area ${k}`).toBe(k < 5);
  }
  // 45 frames push one box node each; the five drawn push their box and 200 shapes.
  expect(s.nodes).toHaveLength(FRAMES + 5 * 200);
  // Picks and hit tests still see every frame's shapes.
  expect(s.children.size).toBe(FRAMES);
  for (const kids of s.children.values()) expect(kids).toHaveLength(200);
});

test("a_frame_turning_real_pushes_its_mounted_children_only", () => {
  const r = parse(THREE);
  const b = THREE_LAYOUT();
  const scene = createBoardScene("modern");
  const all = scene.build(r.frames, b, KEYS, null, null, [], undefined, null);
  const refund = childrenOf(all.nodes, boardFrameId("Refund"));
  expect(refund.length).toBeGreaterThan(1);
  // Not drawn before: its box and its first child, no lines until the last child is in.
  const one = scene.build(r.frames, b, KEYS, null, null, [], undefined, forms([0, 2], [[1, 1]]));
  expect(childrenOf(one.nodes, boardFrameId("Refund"))).toEqual([refund[0]]);
  expect(edgesOf(one.edges, "Refund")).toEqual([]);
  // Over its picture: the picture stays under the children mounted so far.
  const over = scene.build(r.frames, b, KEYS, null, null, [], undefined, forms([0, 2], [[1, 1]], [1]), pictureStore());
  const kids = childrenOf(over.nodes, boardFrameId("Refund"));
  expect(kids.map((n) => n.type)).toEqual([FRAME_PICTURE_TYPE, refund[0].type]);
  expect(kids[1]).toBe(refund[0]);
  // A null plan draws every frame real.
  for (const key of KEYS) expect(childrenOf(all.nodes, boardFrameId(key)).length).toBeGreaterThan(0);
  // Its lines are parts too (Task 9): after its last child, one line a part, never all at once with the last child.
  const lines = edgesOf(all.edges, "Refund");
  expect(lines.length).toBeGreaterThan(0);
  expect(all.lines.get(boardFrameId("Refund"))).toBe(lines.length);
  const allKids = scene.build(r.frames, b, KEYS, null, null, [], undefined, forms([0, 2], [[1, refund.length]]));
  expect(childrenOf(allKids.nodes, boardFrameId("Refund"))).toEqual(refund);
  expect(edgesOf(allKids.edges, "Refund")).toEqual([]);
  const oneLine = scene.build(r.frames, b, KEYS, null, null, [], undefined, forms([0, 2], [[1, refund.length + 1]]));
  expect(edgesOf(oneLine.edges, "Refund")).toEqual([lines[0]]);
});

test("a_form_change_keeps_built_children", () => {
  const r = parse(THREE);
  const b = THREE_LAYOUT();
  const scene = createBoardScene("modern");
  const s1 = scene.build(r.frames, b, KEYS, null, null, [], undefined, forms([0, 1, 2]));
  // Refund leaves the view, then comes back: its node and line objects are the ones built first.
  const s2 = scene.build(r.frames, b, KEYS, null, null, [], undefined, forms([0, 2]));
  expect(childrenOf(s2.nodes, boardFrameId("Refund"))).toEqual([]);
  expect(s2.children.get(boardFrameId("Refund"))).toBe(s1.children.get(boardFrameId("Refund")));
  const s3 = scene.build(r.frames, b, KEYS, null, null, [], undefined, forms([0, 1, 2]));
  childrenOf(s3.nodes, boardFrameId("Refund")).forEach((n, i) => expect(n).toBe(childrenOf(s1.nodes, boardFrameId("Refund"))[i]));
  edgesOf(s3.edges, "Refund").forEach((e, i) => expect(e).toBe(edgesOf(s1.edges, "Refund")[i]));
  expect(s3.nodes.find((n) => n.id === boardFrameId("Refund"))).toBe(s1.nodes.find((n) => n.id === boardFrameId("Refund")));
});

// ----- Plan F Task 7 (Decision 7): a far static frame is one picture of itself over its box.

const LITERAL: ExportPalette = {
  surface: "#010101",
  canvas: "#020202",
  text: "#030303",
  subtle: "#040404",
  border: "#050505",
  type: "#060606",
  keyword: "#070707",
  nodes: Object.fromEntries(Object.keys(NODE_TOKENS).map((k) => [k, { fill: "#0e0e0e", stroke: "#0f0f0f" }])) as ExportPalette["nodes"],
  iconTile: "#101010",
  group: "#111111",
  groupTint: "#121212",
  strongBorder: "#131313",
  panel: "#141414",
  muted: "#151515",
  faint: "#161616",
  keyMark: "#171718",
};
/** A store that builds at once, as at open. */
const pictureStore = () => createPictureStore({ palette: () => LITERAL, loadIcons: async () => new Map(), onReady: () => {}, sync: true });

test("at_open_every_static_frame_is_one_picture", () => {
  const r = parse(THREE);
  const b = THREE_LAYOUT();
  const lv = liveNodes(r.frames[0], b.frames.get("Checkout")!);
  const s = createBoardScene("modern").build(r.frames, b, KEYS, { title: "Checkout", index: 0 }, lv, [], undefined, null, pictureStore());
  for (const key of ["Refund", "Shipping"]) {
    const kids = childrenOf(s.nodes, boardFrameId(key));
    expect(kids.map((n) => n.type), key).toEqual([FRAME_PICTURE_TYPE]);
    expect(s.pictured.has(boardFrameId(key))).toBe(true);
  }
  // No static shape or line is mounted; the live frame is its box and anchor (FlowTab adds its shapes).
  expect(s.edges).toEqual([]);
  expect(s.pictured.has(boardFrameId("Checkout"))).toBe(false);
  expect(s.nodes.some((n) => n.id === LIVE_ANCHOR_ID)).toBe(true);
  // Picks still see every static frame's shapes.
  expect(s.children.get(boardFrameId("Refund"))!.length).toBeGreaterThan(0);
});

test("a_picture_lies_where_its_shapes_stand", () => {
  const r = parse(THREE);
  const b = THREE_LAYOUT();
  const scene = createBoardScene("modern");
  const real = scene.build(r.frames, b, KEYS, null, null, [], undefined, forms([0, 1, 2]));
  const shapes = childrenOf(real.nodes, boardFrameId("Refund"));
  const s = scene.build(r.frames, b, KEYS, null, null, [], undefined, forms([0, 2], [], [1]), pictureStore());
  const [pic] = childrenOf(s.nodes, boardFrameId("Refund"));
  expect(pic.type).toBe(FRAME_PICTURE_TYPE);
  expect(pic).toMatchObject({ selectable: false, draggable: false, focusable: false, zIndex: staticZ(1, 0) });
  expect(pic.style?.pointerEvents).toBe("none");
  expect(pic.className).toContain("board-static");
  // The image's box is the frame's local box on whole units, so its view box lays each shape on its child's place.
  const box = s.boxes[1];
  const local = { x: box.x - 600, y: box.y, w: box.w, h: box.h };
  const f = frameOf(local, { padding: 0 });
  expect(pic.position).toEqual({ x: f.x - local.x, y: f.y - local.y });
  expect([pic.initialWidth, pic.initialHeight]).toEqual([f.w, f.h]);
  const svg = atob((pic.data as FramePictureData).url!.split(",")[1]);
  expect(svg).toContain(`viewBox="${f.x} ${f.y} ${f.w} ${f.h}"`);
  for (const n of shapes.filter((x) => x.type !== "area")) expect(svg).toContain(`data-node="${n.id.slice(n.id.lastIndexOf("\u0000") + 1)}"`);
  // No lines or shapes of its own are mounted; the other frames are real.
  expect(edgesOf(s.edges, "Refund")).toEqual([]);
  expect(s.pictured).toEqual(new Set([boardFrameId("Refund")]));
});

test("a_picture_node_is_kept_while_its_frame_is", () => {
  const r = parse(THREE);
  const b = THREE_LAYOUT();
  const scene = createBoardScene("modern");
  const store = pictureStore();
  const d = forms([0, 2], [], [1]);
  const s1 = scene.build(r.frames, b, KEYS, null, null, [], undefined, d, store);
  const s2 = scene.build(r.frames, b, KEYS, { title: "Checkout", index: 0 }, liveNodes(r.frames[0], b.frames.get("Checkout")!), [], undefined, d, store);
  const pic = (s: typeof s1) => childrenOf(s.nodes, boardFrameId("Refund"))[0];
  expect(pic(s2)).toBe(pic(s1));
  expect(pic(s2).data).toBe(pic(s1).data);
  // A frame gone from the board takes its picture with it.
  const held = store.bytes();
  expect(held).toBeGreaterThan(0);
  scene.build(r.frames.slice(0, 1), b, KEYS.slice(0, 1), null, null, [], undefined, forms([0]), store);
  expect(store.bytes()).toBe(0);
});

test("picture_ready_asks_for_the_picture", async () => {
  const r = parse(THREE);
  const b = THREE_LAYOUT();
  const scene = createBoardScene("modern");
  const onReady = vi.fn();
  // After open: a picture builds in a later task.
  const store = createPictureStore({ palette: () => LITERAL, loadIcons: async () => new Map(), onReady });
  scene.build(r.frames, b, KEYS, null, null, [], undefined, forms([0, 1, 2]), store);
  expect(scene.pictureReady(1, "picture", store)).toBe(false);
  await new Promise((done) => setTimeout(done, 0));
  expect(onReady).toHaveBeenCalledTimes(1);
  expect(scene.pictureReady(1, "picture", store)).toBe(true);
  // With real words it is another picture.
  expect(scene.pictureReady(1, "picture-text", store)).toBe(false);
  // A frame with nothing drawn has nothing to picture.
  const empty = parse('diagram flow "Empty"\n');
  scene.build(empty.frames, layout({ Empty: entry({ x: 0, y: 0 }, {}) }), ["Empty"], null, null, [], undefined, forms([0]), store);
  expect(scene.pictureReady(0, "picture", store)).toBe(true);
});

test("a_pictured_sketch_layer_draws_its_tiles_instead_of_its_sketches", () => {
  // Task 9 fix 2: below the readable zoom the sketch layer is a few pictures, not one node a sketch.
  const sketches: Sketch[] = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, kind: i % 2 ? "pen" : "rect", x: i * 300, y: 0, w: 200, h: 120 }) satisfies Sketch);
  const b: BoardLayout = { ...THREE_LAYOUT(), sketches };
  const r = parse(THREE);
  const scene = createBoardScene("modern");
  const real = scene.build(r.frames, b, KEYS, null, null, []);
  const sketchNodes = (nodes: Node[]) => nodes.filter((n) => n.parentId === SKETCH_LAYER_ID);
  expect(sketchNodes(real.nodes)).toHaveLength(30);
  const tiles = [
    { id: "u0,0", under: true, box: { x: 0, y: 0, w: 9_000, h: 120 }, image: "data:image/svg+xml;base64,dQ==" },
    { id: "o0,0", under: false, box: { x: 300, y: 0, w: 8_900, h: 120 }, image: "data:image/svg+xml;base64,bw==" },
  ];
  const far = scene.build(r.frames, b, KEYS, null, null, [], undefined, null, undefined, { tiles, mounted: 0 });
  // No sketch node and no layer node: the two tiles, under the frames and over them.
  expect(sketchNodes(far.nodes)).toHaveLength(0);
  expect(far.nodes.some((n) => n.id === SKETCH_LAYER_ID)).toBe(false);
  const drawn = far.nodes.filter((n) => n.type === SKETCH_PICTURE_TYPE);
  expect(drawn.map((n) => [n.position, n.zIndex, (n.data as FramePictureData).url])).toEqual([
    [{ x: 0, y: 0 }, Z_SKETCH_BOX, tiles[0].image],
    [{ x: 300, y: 0 }, Z_SKETCH, tiles[1].image],
  ]);
  for (const n of drawn) expect(n.selectable === false && n.focusable === false && n.className === "board-sketch-picture").toBe(true);
  // Turning real: its first sketches over the tiles, the same node objects as before.
  const turning = scene.build(r.frames, b, KEYS, null, null, [], undefined, null, undefined, { tiles, mounted: 12 });
  expect(sketchNodes(turning.nodes).map((n) => n.id)).toEqual(sketches.slice(0, 12).map((s) => sketchNodeId(s.id)));
  for (const n of sketchNodes(turning.nodes)) expect(n).toBe(real.nodes.find((m) => m.id === n.id));
  // The tiles keep their objects while their images do.
  expect(turning.nodes.filter((n) => n.type === SKETCH_PICTURE_TYPE)).toEqual(drawn);
  expect(turning.nodes.find((n) => n.type === SKETCH_PICTURE_TYPE)).toBe(drawn[0]);
  // Real again: every sketch, and no tile.
  const back = scene.build(r.frames, b, KEYS, null, null, []);
  expect(sketchNodes(back.nodes)).toHaveLength(30);
  expect(back.nodes.some((n) => n.type === SKETCH_PICTURE_TYPE)).toBe(false);
});

// Plan D Task 8: the assistant's waiting changes drawn on every frame they touch.

/** A frame's review as `boardReview` gives it: the overlay of `before` to `after` (one frame's texts each). */
function frameReview(before: string, after: string, more: { renames?: ReadonlyMap<string, string>; count?: number; isNew?: boolean } = {}): FrameReview {
  const doc = (t: string) => parse(t).frames[0].doc!;
  const o = reviewOverlay(more.isNew ? { ...doc(after), nodes: [], links: [], groups: [] } : doc(before), doc(after), more.renames);
  return { ...o, count: more.count ?? 1, isNew: more.isNew ?? false };
}

const REFUND_REVIEW = () =>
  frameReview(REFUND, 'diagram flow "Refund"\nAsked\nRefund it\nClose\nAsked > Refund it: ok\nAsked > Close\n', {
    renames: new Map([["Ask", "Asked"]]),
    count: 3,
  });

const stateOf = (n: Node | undefined) => (n?.data as { state?: string } | undefined)?.state;

test("a_static_frame_draws_its_review_states", () => {
  const r = parse(THREE);
  const b = THREE_LAYOUT();
  // Refund's review: Ask renamed Asked, Close added (with no place yet), its line relabelled; Shipping loses Send.
  const review = new Map<string, FrameReview>([
    ["Refund", REFUND_REVIEW()],
    ["Shipping", frameReview(SHIPPING, 'diagram flow "Shipping"\nPack\n', { count: 1 })],
  ]);
  const s = createBoardScene("modern").build(r.frames, b, KEYS, null, null, [], undefined, null, undefined, null, review);
  const node = (key: string, name: string) => s.nodes.find((n) => n.id === inFrameId(key, name));
  expect(stateOf(node("Refund", "Asked"))).toBe("changed");
  expect(node("Refund", "Ask")).toBeUndefined();
  // A proposed shape with no place yet still draws, in a row under the placed ones, until its place comes.
  expect(stateOf(node("Refund", "Close"))).toBe("suggested");
  expect(stateOf(node("Refund", "Refund it"))).toBeUndefined();
  expect(stateOf(node("Shipping", "Send"))).toBe("removed");
  expect(stateOf(node("Shipping", "Pack"))).toBeUndefined();
  const cls = (key: string) => edgesOf(s.edges, key).map((e) => e.className ?? "");
  expect(cls("Refund").filter((c) => c.includes("is-ai-changed"))).toHaveLength(1);
  expect(cls("Refund").filter((c) => c.includes("is-ai-add"))).toHaveLength(1);
  expect(cls("Shipping").filter((c) => c.includes("is-ai-del"))).toHaveLength(1);
  // Every static mark keeps the static frame's own class.
  for (const c of cls("Refund")) expect(c).toContain(STATIC_CLASS);
  // The tab's waiting count: the frame's changes.
  const box = (key: string) => s.nodes.find((n) => n.id === boardFrameId(key))!.data as { pending?: number };
  expect([box("Checkout").pending, box("Refund").pending, box("Shipping").pending]).toEqual([undefined, 3, 1]);
  // The frame grows to hold what the review draws.
  expect(s.boxes[1].h).toBeGreaterThan(createBoardScene("modern").build(r.frames, b, KEYS, null, null, []).boxes[1].h);
});

test("a_renamed_group_is_tinted", () => {
  const r = parse(THREE);
  const renamed = frameReview(CHECKOUT, CHECKOUT.replace("Shop {", "Store {"), { renames: new Map([["Shop", "Store"]]) });
  const s = createBoardScene("modern").build(r.frames, THREE_LAYOUT(), KEYS, null, null, [], undefined, null, undefined, null, new Map([["Checkout", renamed]]));
  const area = s.nodes.find((n) => n.id === inFrameId("Checkout", "\u0000group:Store"))!;
  expect(area.className).toContain("is-ai-changed");
  expect(area.className).toContain(STATIC_CLASS);
  // A screen reader hears it too (Task 19): the area names itself with the shapes' note.
  expect((area.data as { state?: string }).state).toBe("changed");
  // Its shapes did not move.
  expect(stateOf(s.nodes.find((n) => n.id === inFrameId("Checkout", "Cart")))).toBeUndefined();
});

test("an_untouched_frame_keeps_its_node_objects", () => {
  const r = parse(THREE);
  const b = THREE_LAYOUT();
  const scene = createBoardScene("modern");
  const s1 = scene.build(r.frames, b, KEYS, null, null, []);
  const review = new Map([["Refund", REFUND_REVIEW()]]);
  const s2 = scene.build(r.frames, b, KEYS, null, null, [], undefined, null, undefined, null, review);
  const same = (a: { nodes: Node[]; edges: Edge[] }, z: { nodes: Node[]; edges: Edge[] }, key: string) => {
    const was = childrenOf(a.nodes, boardFrameId(key));
    const now = childrenOf(z.nodes, boardFrameId(key));
    expect(now.length).toBe(was.length);
    now.forEach((n, i) => expect(n).toBe(was[i]));
    edgesOf(z.edges, key).forEach((e, i) => expect(e).toBe(edgesOf(a.edges, key)[i]));
    expect(z.nodes.find((n) => n.id === boardFrameId(key))).toBe(a.nodes.find((n) => n.id === boardFrameId(key)));
  };
  for (const key of ["Checkout", "Shipping"]) same(s1, s2, key);
  expect(childrenOf(s2.nodes, boardFrameId("Refund"))[0]).not.toBe(childrenOf(s1.nodes, boardFrameId("Refund"))[0]);
  // The same review object again rebuilds nothing; a new one rebuilds Refund only.
  const s3 = scene.build(r.frames, b, KEYS, null, null, [], undefined, null, undefined, null, review);
  for (const key of KEYS) same(s2, s3, key);
  const s4 = scene.build(r.frames, b, KEYS, null, null, [], undefined, null, undefined, null, new Map([["Refund", REFUND_REVIEW()]]));
  for (const key of ["Checkout", "Shipping"]) same(s3, s4, key);
  expect(childrenOf(s4.nodes, boardFrameId("Refund"))[0]).not.toBe(childrenOf(s3.nodes, boardFrameId("Refund"))[0]);
  // The review over, Refund draws its own doc again, with no marks.
  const s5 = scene.build(r.frames, b, KEYS, null, null, []);
  expect(childrenOf(s5.nodes, boardFrameId("Refund")).map((n) => stateOf(n)).filter(Boolean)).toEqual([]);
  expect(s5.nodes.find((n) => n.id === inFrameId("Refund", "Ask"))).toBeDefined();
  expect((s5.nodes.find((n) => n.id === boardFrameId("Refund"))!.data as { pending?: number }).pending).toBeUndefined();
});

test("a_new_frame_draws_dashed_at_its_place", () => {
  const r = parse(THREE);
  const b = THREE_LAYOUT();
  const returns = 'diagram flow "Returns"\nLabel\nDrop off\nLabel > Drop off\n';
  const review = new Map([["Returns", frameReview("", returns, { isNew: true, count: 4 })]]);
  const at = new Map([["Returns", { x: 1800, y: 0 }]]);
  const scene = createBoardScene("modern");
  const sel = { title: "Refund", index: 1 };
  const lv = liveNodes(r.frames[1], b.frames.get("Refund")!);
  const s = scene.build(r.frames, b, KEYS, sel, lv, [], undefined, null, undefined, null, review, at);
  const box = s.nodes.find((n) => n.type === "boardFrame" && (n.data as { box: FrameBox }).box.title === "Returns")!;
  expect(box).toBeDefined();
  const data = box.data as { box: FrameBox; isNew?: boolean; pending?: number };
  expect([data.isNew, data.pending]).toEqual([true, 4]);
  // At its place on the board as an entry's `at` places a frame: in board units (Plan F Decision 11; Refund is live
  // at 600, 0 and moves nothing), its box FRAME_PAD around its shapes; it follows its place.
  expect(box.position.x).toBe(1800 - FRAME_PAD);
  const moved = createBoardScene("modern").build(r.frames, b, KEYS, sel, lv, [], undefined, null, undefined, null, review, new Map([["Returns", { x: 1900, y: 50 }]]));
  expect(moved.nodes.find((n) => n.id === box.id)!.position).toEqual({ x: box.position.x + 100, y: box.position.y + 50 });
  expect(isStaticId(box.id)).toBe(true);
  // Not on the board yet: not one of the frames' boxes, which a click or a fit reads; its own list instead.
  expect(s.boxes.map((x) => x.title)).toEqual(KEYS);
  expect(s.proposed?.map((x) => x.title)).toEqual(["Returns"]);
  // Its shapes and line are drawn as suggested, inside it.
  const kids = childrenOf(s.nodes, box.id);
  expect(kids.map((n) => stateOf(n))).toEqual(["suggested", "suggested"]);
  expect(s.edges.filter((e) => e.source.startsWith("\u0000in:") && kids.some((k) => k.id === e.source))).toHaveLength(1);
  for (const k of kids) expect(isStaticId(k.id)).toBe(true);
  // No place for it, no box; the review over, nothing of it is kept.
  expect(scene.build(r.frames, b, KEYS, sel, lv, [], undefined, null, undefined, null, review).nodes.some((n) => n.id === box.id)).toBe(false);
  scene.build(r.frames, b, KEYS, sel, lv, []);
  expect([scene.memoSize(), scene.boxMemoSize()]).toEqual([2, 3]);
});

test("an_overview_frame_under_review_draws_as_nodes", () => {
  const r = parse(THREE);
  const b = THREE_LAYOUT();
  const review = new Map([["Refund", REFUND_REVIEW()]]);
  const scene = createBoardScene("modern");
  // Plan F replaced the overview's preview with pictures (Decision 7): every static frame is a picture at open.
  const pictures = pictureStore();
  const s = scene.build(r.frames, b, KEYS, null, null, [], undefined, null, pictures, null, review);
  // Refund draws its shapes and lines with their marks; the others stay one picture node each (Decision 19).
  const kinds = (key: string) => childrenOf(s.nodes, boardFrameId(key)).map((n) => n.type);
  expect(kinds("Checkout")).toEqual([FRAME_PICTURE_TYPE]);
  expect(kinds("Shipping")).toEqual([FRAME_PICTURE_TYPE]);
  expect(kinds("Refund")).not.toContain(FRAME_PICTURE_TYPE);
  expect(s.pictured.has(boardFrameId("Refund"))).toBe(false);
  expect(stateOf(s.nodes.find((n) => n.id === inFrameId("Refund", "Close")))).toBe("suggested");
  expect(edgesOf(s.edges, "Refund").length).toBeGreaterThan(0);
  expect(edgesOf(s.edges, "Checkout")).toHaveLength(0);
  // The review over, Refund returns to its picture.
  const after = scene.build(r.frames, b, KEYS, null, null, [], undefined, null, pictures);
  expect(childrenOf(after.nodes, boardFrameId("Refund")).map((n) => n.type)).toEqual([FRAME_PICTURE_TYPE]);
});

test("a_changed_row_past_the_window_is_counted_not_drawn", () => {
  // A static card draws its first ER_MAX_ROWS rows and never scrolls (B3 decision 7, owner answer 1).
  const cols = (typeOf: (i: number) => string) => Array.from({ length: 25 }, (_, i) => `  c${i} ${typeOf(i)}`);
  const before = ['diagram er "Data"', "wide {", ...cols(() => "int"), "}"].join("\n") + "\n";
  const after = ['diagram er "Data"', "wide {", ...cols((i) => (i === 3 || i === 24 ? "text" : "int")), "  c25 int", "}"].join("\n") + "\n";
  const r = parse(`${CHECKOUT}\n${before}`);
  const b = layout({ Checkout: entry({ x: 0, y: 0 }, { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }), Data: entry({ x: 600, y: 0 }, { wide: { x: 0, y: 0 } }) });
  const fr = frameReview(before, after, { count: 3 });
  expect([...fr.changedRows.get("wide")!]).toEqual(["c3", "c24"]);
  expect([...fr.addedRows.get("wide")!]).toEqual(["c25"]);
  const s = createBoardScene("modern").build(r.frames, b, ["Checkout", "Data"], null, null, [], undefined, null, undefined, null, new Map([["Data", fr]]));
  const card = s.nodes.find((n) => n.id === inFrameId("Data", "wide"))!;
  const rows = (card.data as { rowStates?: (string | undefined)[] }).rowStates!;
  // Row 3 is marked on the card; rows 24 and 25 are past what a static card draws: only the count holds them.
  expect(rows[3]).toBe("changed");
  expect(rows.length).toBeLessThanOrEqual(ER_MAX_ROWS);
  expect(rows.filter(Boolean)).toEqual(["changed"]);
  expect(stateOf(card)).toBeUndefined();
  expect((s.nodes.find((n) => n.id === boardFrameId("Data"))!.data as { pending?: number }).pending).toBe(3);
});
