// Task 5: every frame of a board on one canvas. Static frames are frame nodes with their shapes as prefixed children,
// in z bands under the live frame (Decisions 1, 2, 4 and 5); each is rebuilt only when its doc or layout changes.
import type { Edge, Node } from "@xyflow/react";
import { expect, test } from "vitest";
import type { FlowProblem } from "../../lang/flow/problems";
import { createFlowService, type FrameResult } from "../../lang/flow/service";
import { buildFlowGraph, nodeSize } from "../flowNodes";
import { flowScene } from "../flowScene";
import { inStaticFrame } from "../kindEdit";
import { emptyPositions } from "../layout";
import { type BoardLayout, FRAME_MIN, FRAME_PAD, type FrameLayout, frameBounds } from "./boardLayout";
import {
  boardFrameId,
  type ClashLayout,
  clashInFrameId,
  createBoardScene,
  duplicateFrameId,
  type FrameBox,
  inFrameId,
  isStaticId,
  liveZ,
  staticZ,
  TEXT_SCALE,
  Z_BAND,
  Z_LIVE,
  Z_LIVE_BOX,
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

test("the_selected_frame_is_the_origin", () => {
  const r = parse(THREE);
  const b = THREE_LAYOUT();
  const sel = r.frames[1];
  const s = createBoardScene("modern").build(r.frames, b, KEYS, { title: "Refund", index: 1 }, liveNodes(sel, b.frames.get("Refund")!), []);
  expect(s.origin).toEqual({ x: 600, y: 0 });
  // The live frame has only its box here: FlowTab draws its shapes with bare names.
  expect(childrenOf(s.nodes, boardFrameId("Refund"))).toEqual([]);
  expect(s.nodes.some((n) => n.id.startsWith("\u0000in:Refund\u0000"))).toBe(false);
  // Another frame's box sits at its board place minus the origin.
  const ship = frameBounds(b.frames.get("Shipping")!, r.frames[2].doc, "modern");
  const shipBox = s.nodes.find((n) => n.id === boardFrameId("Shipping"))!;
  expect(shipBox.position).toEqual({ x: ship.x - 600, y: ship.y });
  expect(s.boxes[2]).toMatchObject({ x: ship.x - 600, y: ship.y, w: ship.w, h: ship.h });
  // The live box comes with the scene (finding 9: FlowTab no longer scans every node for it).
  expect(s.live).toBe(s.boxes[1]);
  expect(s.live).toMatchObject({ key: "Refund", index: 1 });
  // A static child's absolute place is its board place minus the origin.
  const pack = s.nodes.find((n) => n.id === inFrameId("Shipping", "Pack"))!;
  expect(shipBox.position.x + pack.position.x).toBe(1200 + 0 - 600);
  expect(shipBox.position.y + pack.position.y).toBe(40 + 0);
});

test("nothing_selected_has_no_live_frame_and_origin_zero", () => {
  const r = parse(THREE);
  const b = THREE_LAYOUT();
  const s = createBoardScene("modern").build(r.frames, b, KEYS, null, null, []);
  expect(s.origin).toEqual({ x: 0, y: 0 });
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
  // C's box keeps its id; only its place moves with the origin.
  expect(onB.nodes.find((n) => n.id === boardFrameId("Shipping"))!.position.x).toBe(onA.nodes.find((n) => n.id === boardFrameId("Shipping"))!.position.x - 600);
  // A became static (its children drawn), B became live (none drawn).
  expect(childrenOf(onA.nodes, boardFrameId("Checkout"))).toEqual([]);
  expect(childrenOf(onB.nodes, boardFrameId("Checkout")).length).toBeGreaterThan(0);
  expect(childrenOf(onA.nodes, boardFrameId("Refund")).length).toBe(2);
  expect(childrenOf(onB.nodes, boardFrameId("Refund"))).toEqual([]);
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
