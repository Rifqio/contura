// Loose sketches. The ops are pure and return changes; the board scene draws them as
// children of one zero-size layer node, Sections and boxes under every frame, the rest over the live frame.
import { render } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import { createElement } from "react";
import { expect, test } from "vitest";
import { createFlowService } from "../../lang/flow/service";
import { emptyPositions } from "../layout";
import {
  type BoardLayout,
  type FrameLayout,
  MAX_BOARD_SKETCH_TEXT,
  MAX_PEN_POINTS,
  MAX_SKETCH_POINTS,
  MAX_SKETCHES,
  parseBoardLayout,
  type Sketch,
  serializeBoardLayout,
} from "./boardLayout";
import { boardFrameId, createBoardScene, Z_SKETCH, Z_SKETCH_UNDER } from "./boardScene";
import { SKETCH_LAYER } from "../../diagram/DiagramCanvas";
import { SketchNode } from "./SketchNode";
import {
  addSketch,
  drawsUnder,
  finiteSketch,
  readSketchClip,
  sketchClipText,
  TOO_MANY_SKETCHES,
  invertSketchChanges,
  moveSketches,
  applySketches,
  type NewSketch,
  removeSketches,
  setSketchText,
  simplifyStroke,
  SKETCH_LAYER_ID,
  type SketchChange,
  sketchesInside,
  sketchNodeId,
} from "./sketches";

/** Adds `s` to `all` and returns the new list; fails the test on a refusal. */
function add(all: Sketch[], s: NewSketch): Sketch[] {
  const r = addSketch(all, s);
  if (!("change" in r)) throw new Error(r.refused);
  return applySketches(all, [r.change]);
}

const box = (kind: Sketch["kind"], x = 0, y = 0, w = 100, h = 60): NewSketch => ({ kind, x, y, w, h });

test("ids_count_up_and_never_repeat", () => {
  let all: Sketch[] = [];
  for (let i = 0; i < 3; i++) all = add(all, box("rect", i * 200));
  expect(all.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  // The newest deleted: its id is not given again (its delete can still be undone, and the undo brings it back).
  all = applySketches(all, removeSketches(all, ["s3"]));
  all = add(all, box("ellipse"));
  expect(all.map((s) => s.id)).toEqual(["s1", "s2", "s4"]);
  // A file with hand-made ids: the next is past the highest `s<n>`, and an id is never one the board has.
  const file: Sketch[] = [
    { id: "s9", kind: "rect", x: 0, y: 0, w: 1, h: 1 },
    { id: "mine", kind: "rect", x: 0, y: 0, w: 1, h: 1 },
    { id: "s99999999999999999999999", kind: "rect", x: 0, y: 0, w: 1, h: 1 },
  ];
  const next = add(file, box("rect"));
  expect(next[3].id).toBe("s10");
  // Ids stay far under the parse's 64 characters.
  for (const s of next) if (/^s\d+$/.test(s.id) && s !== file[2]) expect(s.id.length).toBeLessThan(64);
  // Every id on a full board is its own.
  let full: Sketch[] = [];
  for (let i = 0; i < MAX_SKETCHES; i++) {
    const r = addSketch(full, box("rect", i));
    if (!("change" in r)) throw new Error(r.refused);
    full = applySketches(full, [r.change]);
  }
  expect(new Set(full.map((s) => s.id)).size).toBe(MAX_SKETCHES);
});

test("caps_refuse_with_their_notes", () => {
  // 1,000 sketches.
  const many: Sketch[] = Array.from({ length: MAX_SKETCHES }, (_, i) => ({ id: `s${i + 1}`, kind: "rect", x: i, y: 0, w: 10, h: 10 }));
  expect(addSketch(many, box("rect"))).toEqual({ refused: "A board holds at most 1,000 sketches." });
  // 50,000 pen points across the board.
  const stroke = (n: number) => Array.from({ length: n }, (_, i) => [i * 10, (i % 2) * 50] as [number, number]);
  const pens: Sketch[] = Array.from({ length: MAX_SKETCH_POINTS / 1_000 }, (_, i) => ({ id: `p${i}`, kind: "pen", x: 0, y: 0, w: 10, h: 10, points: stroke(1_000) }));
  expect(addSketch(pens, { kind: "pen", x: 0, y: 0, w: 10, h: 50, points: stroke(3) })).toEqual({ refused: "A board holds at most 50,000 pen points. Erase some strokes first." });
  // Room for a stroke elsewhere: one of 5,000 points is simplified to the stroke cap first.
  const r = addSketch([], { kind: "pen", x: 0, y: 0, w: 50_000, h: 50, points: stroke(5_000) });
  expect("change" in r && r.change.after!.points!.length).toBeLessThanOrEqual(1_000);
  // 100,000 characters of text across the board.
  const texts: Sketch[] = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, kind: "note", x: 0, y: 0, w: 10, h: 10, text: "x".repeat(2_000) }));
  expect(texts.reduce((n, s) => n + s.text!.length, 0)).toBe(MAX_BOARD_SKETCH_TEXT);
  expect(addSketch(texts, { kind: "text", x: 0, y: 0, w: 10, h: 10, text: "one more" })).toEqual({ refused: "A board holds at most 100,000 characters of sketch text." });
  // A sketch with no text still fits on that board.
  expect("change" in addSketch(texts, box("rect"))).toBe(true);
});

test("the_board_text_budget_holds_on_edit", () => {
  const texts: Sketch[] = Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, kind: "note", x: 0, y: 0, w: 10, h: 10, text: "x".repeat(1_000) }));
  // Longer is refused on a full board; shorter, and the same length, are not.
  expect(setSketchText(texts, "t3", "x".repeat(1_001))).toEqual({ refused: "A board holds at most 100,000 characters of sketch text." });
  const shorter = setSketchText(texts, "t3", "short");
  expect(shorter && "change" in shorter && shorter.change.after?.text).toBe("short");
  const same = setSketchText(texts, "t3", "y".repeat(1_000));
  expect(same && "change" in same && same.change.after?.text).toBe("y".repeat(1_000));
  // With room on the board, a sketch's own text is still cut at 2,000 characters.
  const one: Sketch[] = [{ id: "s1", kind: "text", x: 0, y: 0, w: 10, h: 10 }];
  const long = setSketchText(one, "s1", "z".repeat(3_000));
  expect(long && "change" in long && long.change.after?.text?.length).toBe(2_000);
  // Empty text takes it away; a gone sketch is no change.
  const cleared = setSketchText(texts, "t0", "");
  expect(cleared && "change" in cleared && cleared.change.after).not.toHaveProperty("text");
  expect(setSketchText(texts, "gone", "x")).toBeNull();
});

test("simplify_keeps_ends_and_fits_the_cap", () => {
  // A wobbly stroke of 20,000 points.
  const points = Array.from({ length: 20_000 }, (_, i) => [i, Math.round(Math.sin(i / 7) * 40 + (i % 3))] as [number, number]);
  for (const max of [1_000, 200, 2]) {
    const out = simplifyStroke(points, max);
    expect(out.length).toBeLessThanOrEqual(max);
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0]).toEqual(points[0]);
    expect(out[out.length - 1]).toEqual(points[points.length - 1]);
  }
  // A straight stroke goes down to its ends at 1 px; a short one that fits keeps every point that bends.
  expect(simplifyStroke(Array.from({ length: 50 }, (_, i) => [i, i] as [number, number]), 1_000)).toEqual([
    [0, 0],
    [49, 49],
  ]);
  const zig: [number, number][] = [
    [0, 0],
    [10, 10],
    [20, 0],
    [30, 10],
  ];
  expect(simplifyStroke(zig, 1_000)).toEqual(zig);
});

test("inside_finds_whole_sketches_only", () => {
  const section: Sketch = { id: "s1", kind: "section", x: 0, y: 0, w: 400, h: 300, text: "Section" };
  const all: Sketch[] = [
    section,
    { id: "s2", kind: "rect", x: 10, y: 10, w: 100, h: 60 },
    // Half inside: not taken.
    { id: "s3", kind: "note", x: 350, y: 10, w: 100, h: 60 },
    { id: "s4", kind: "pen", x: 20, y: 200, w: 300, h: 100, points: [[0, 0], [300, 100]] },
    // Wholly outside.
    { id: "s5", kind: "text", x: 500, y: 500, w: 40, h: 20, text: "far" },
    // Edge to edge counts as inside.
    { id: "s6", kind: "ellipse", x: 0, y: 0, w: 400, h: 300 },
  ];
  expect(sketchesInside(all, section)).toEqual(["s2", "s4", "s6"]);
});

// The board scene's sketch layer.

const CHECKOUT = 'diagram flow "Checkout"\nCart\nPay\nCart > Pay\n';
const REFUND = 'diagram flow "Refund"\nAsk\nRefund it\nAsk > Refund it\n';
const KEYS = ["Checkout", "Refund"];
const entry = (at: { x: number; y: number }, nodes: Record<string, { x: number; y: number }>): FrameLayout => ({
  at,
  nodes: Object.assign(emptyPositions(), nodes),
  style: "modern",
  direction: "TB",
});

function boardWith(sketches: Sketch[]): BoardLayout {
  return {
    frames: new Map([
      ["Checkout", entry({ x: 0, y: 0 }, { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } })],
      ["Refund", entry({ x: 600, y: 40 }, { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } })],
    ]),
    sketches,
  };
}

const SKETCHES: Sketch[] = [
  { id: "s1", kind: "section", x: -100, y: -100, w: 1_400, h: 600, text: "Section" },
  { id: "s2", kind: "rect", x: 20, y: 20, w: 200, h: 100 },
  { id: "s3", kind: "pen", x: 40, y: 40, w: 100, h: 50, points: [[0, 0], [50, 50], [100, 0]] },
  { id: "s4", kind: "text", x: 300, y: 300, w: 120, h: 24, text: "slow!" },
  { id: "s5", kind: "note", x: 500, y: 300, w: 160, h: 120, text: "Ask the bank" },
  { id: "s6", kind: "diamond", x: 900, y: 300, w: 80, h: 80 },
  { id: "s7", kind: "arrow", x: 0, y: 400, w: 300, h: 0, points: [[0, 0], [300, 0]] },
];

test("sections_and_boxes_draw_under_frames", () => {
  const r = createFlowService().parse("board", [CHECKOUT, REFUND].join("\n"));
  const scene = createBoardScene("modern");
  const out = scene.build(r.frames, boardWith(SKETCHES), KEYS, null, null, []);
  const byId = new Map(out.nodes.map((n) => [n.id, n]));
  const layer = byId.get(SKETCH_LAYER_ID)!;
  expect(layer).toBeDefined();
  // Zero-size, taking no pointer events, under everything; at the board's (0, 0).
  expect(layer.width).toBe(0);
  expect(layer.height).toBe(0);
  expect(layer.style?.width).toBe(0);
  expect(layer.style?.height).toBe(0);
  expect(layer.style?.pointerEvents).toBe("none");
  expect(layer.zIndex).toBe(Z_SKETCH_UNDER);
  expect(layer.position).toEqual({ x: 0, y: 0 });
  const frame0 = byId.get(boardFrameId("Checkout"))!;
  const z = (id: string) => byId.get(sketchNodeId(id))!.zIndex!;
  // A Section and the box sketches under frame 0's box, the lowest frame; above the layer node.
  for (const id of ["s1", "s2", "s6"]) {
    expect(z(id), id).toBe(-1);
    expect(z(id)).toBeLessThan(frame0.zIndex!);
    expect(z(id)).toBeGreaterThan(Z_SKETCH_UNDER);
  }
  // Pen, text, note and arrow over the live frame.
  for (const id of ["s3", "s4", "s5", "s7"]) expect(z(id), id).toBe(Z_SKETCH);
  // Every sketch is a child of the layer, after it, at its board place, with its box.
  for (const s of SKETCHES) {
    const n = byId.get(sketchNodeId(s.id))!;
    expect(n.type).toBe("sketch");
    expect(n.parentId).toBe(SKETCH_LAYER_ID);
    expect(out.nodes.indexOf(n)).toBeGreaterThan(out.nodes.indexOf(layer));
    expect(n.position).toEqual({ x: s.x, y: s.y });
    expect(n.style).toMatchObject({ width: s.w, height: s.h });
    expect((n.data as { sketch: Sketch }).sketch).toBe(s);
  }
  // With Refund live the layer stays where it is, the very same node (one origin for the board).
  const live = scene.build(r.frames, boardWith(SKETCHES), KEYS, { title: "Refund", index: 1 }, { nodes: [] }, []);
  const layer2 = live.nodes.find((n) => n.id === SKETCH_LAYER_ID)!;
  expect(layer2).toBe(layer);
  expect(layer2.position).toEqual({ x: 0, y: 0 });
  for (const s of SKETCHES) expect(live.nodes.find((n) => n.id === sketchNodeId(s.id))).toBe(byId.get(sketchNodeId(s.id)));
  // No sketches: no layer.
  expect(scene.build(r.frames, boardWith([]), KEYS, null, null, []).nodes.some((n) => n.id === SKETCH_LAYER_ID)).toBe(false);
});

test("a_sketch_node_is_named_and_draws_in_theme_tokens", () => {
  const draw = (s: Sketch) => {
    const node = { id: sketchNodeId(s.id), type: "sketch", data: { sketch: s }, position: { x: 0, y: 0 } } as Node;
    return render(createElement(SketchNode, { ...node, data: node.data, width: s.w, height: s.h } as never));
  };
  const note = draw(SKETCHES[4]);
  const named = note.container.querySelector('[aria-label="Note sketch: Ask the bank"]');
  expect(named).not.toBeNull();
  // The note's paper is the warning tint (there is no --c-warning token), its words the theme's text.
  const paper = note.container.querySelector(".board-sketch-paper") as SVGElement;
  expect(paper.getAttribute("fill")).toBe("var(--c-warning-subtle)");
  note.unmount();
  // An outline is 1.5 px in the theme's text colour, or in its colour.
  const rect = draw(SKETCHES[1]);
  const outline = rect.container.querySelector(".board-sketch-shape") as SVGElement;
  expect(outline.getAttribute("stroke")).toBe("var(--c-text)");
  expect(outline.getAttribute("stroke-width")).toBe("1.5");
  expect(rect.container.querySelector('[aria-label="Rectangle sketch"]')).not.toBeNull();
  rect.unmount();
  const red = draw({ ...SKETCHES[1], color: "danger" });
  expect((red.container.querySelector(".board-sketch-shape") as SVGElement).getAttribute("stroke")).toBe("var(--c-danger-text)");
  red.unmount();
  // A Section is a dashed box with its title above it.
  const section = draw(SKETCHES[0]);
  expect((section.container.querySelector(".board-sketch-shape") as SVGElement).getAttribute("stroke-dasharray")).not.toBeNull();
  expect(section.container.querySelector(".board-sketch-title")?.textContent).toBe("Section");
  expect(section.container.querySelector('[aria-label="Section sketch: Section"]')).not.toBeNull();
  section.unmount();
  // A pen stroke is one path through its points.
  const pen = draw(SKETCHES[2]);
  expect(pen.container.querySelectorAll("path.board-sketch-shape")).toHaveLength(1);
  expect(pen.container.querySelector("path.board-sketch-shape")?.getAttribute("d")).toBe("M0 0L50 50L100 0");
  pen.unmount();
});

test("changes_apply_and_invert_by_id", () => {
  const all: Sketch[] = SKETCHES.slice(0, 3);
  const moved = { ...all[1], x: 999 };
  const changes: SketchChange[] = [{ id: "s2", before: all[1], after: moved }];
  const next = applySketches(all, changes);
  // The changed sketch keeps its draw order; the others are the same objects.
  expect(next.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  expect(next[1]).toBe(moved);
  expect(next[0]).toBe(all[0]);
  expect(next[2]).toBe(all[2]);
});

test("undoing_a_delete_restores_the_draw_order", () => {
  const all: Sketch[] = SKETCHES.slice();
  // Two deleted from the middle, one from the bottom: undo puts each back where it was drawn.
  const removed = removeSketches(all, ["s2", "s5", "s1"]);
  const less = applySketches(all, removed);
  expect(less.map((s) => s.id)).toEqual(["s3", "s4", "s6", "s7"]);
  const back = applySketches(less, invertSketchChanges(removed));
  expect(back.map((s) => s.id)).toEqual(SKETCHES.map((s) => s.id));
  for (const [i, s] of back.entries()) expect(s).toBe(SKETCHES[i]);
  // A new sketch still goes on top.
  const r = addSketch(back, box("rect"));
  if (!("change" in r)) throw new Error(r.refused);
  const withNew = applySketches(back, [r.change]);
  expect(withNew[withNew.length - 1].id).toBe(r.change.id);
});

test("every_sketch_an_op_makes_round_trips_byte_for_byte", () => {
  // What an op holds is what the file reopens as: one normaliser for the parse and the ops.
  const wobble = (n: number) => Array.from({ length: n }, (_, i) => [i, (i * 13) % 97] as [number, number]);
  const made: NewSketch[] = [
    { kind: "rect", x: 1.4, y: 2.6, w: 100, h: 60 },
    // Points on a box kind are not kept.
    { kind: "rect", x: 0, y: 0, w: 10, h: 10, points: [[1, 2], [3, 4]] },
    { kind: "ellipse", x: 0, y: 0, w: 80, h: 40, color: "danger" },
    // A colour of 33 characters is not kept (the parse drops it).
    { kind: "diamond", x: 0, y: 0, w: 80, h: 80, color: "x".repeat(33) },
    { kind: "line", x: 0, y: 0, w: 100, h: 0, points: [[0, 0], [100.4, 0]] },
    { kind: "arrow", x: 5, y: 5, w: 100, h: 50, points: [[0, 0], [100, 50]], color: "teal" },
    // Pen points over the stroke cap: simplified to fit.
    { kind: "pen", x: 0, y: 0, w: 2_000, h: 97, points: wobble(MAX_PEN_POINTS * 3) },
    { kind: "text", x: 0, y: 0, w: 120, h: 24, text: "slow!" },
    { kind: "note", x: 0, y: 0, w: 160, h: 120, text: "Ask the bank\nby Friday" },
    { kind: "section", x: -100, y: -100, w: 1_400, h: 600, text: "Section" },
    // An id given by the caller (here 65 characters) is never used: the op gives its own.
    { ...({ id: "i".repeat(65) } as object), kind: "rect", x: 0, y: 0, w: 10, h: 10 } as NewSketch,
  ];
  const frames = [{ title: "A", kind: "flow" as const }];
  const live = new Set(["A"]);
  const kinds = new Map([["A", "flow" as const]]);
  const fileOf = (sketches: Sketch[]) => serializeBoardLayout({ frames: new Map(), sketches }, live, false, kinds);
  let all: Sketch[] = [];
  for (const s of made) {
    all = add(all, s);
    const one = fileOf(all);
    const back = parseBoardLayout(one, frames);
    expect(back.sketches).toEqual(all);
    expect(fileOf(back.sketches)).toBe(one);
  }
  expect(all.find((s) => s.points && s.kind === "rect")).toBeUndefined();
  expect(all[3]).not.toHaveProperty("color");
  expect(all[6].points!.length).toBeLessThanOrEqual(MAX_PEN_POINTS);
  for (const s of all) expect(s.id.length).toBeLessThan(64);
  // And after a text edit and a move.
  const edited = setSketchText(all, all[8].id, "Ask the bank");
  if (!edited || !("change" in edited)) throw new Error("no edit");
  all = applySketches(all, [edited.change, ...moveSketches(all, [all[2].id], 10.6, -3.2)]);
  const one = fileOf(all);
  expect(parseBoardLayout(one, frames).sketches).toEqual(all);
});

test("the_same_text_is_no_change", () => {
  const one: Sketch[] = [{ id: "s1", kind: "text", x: 0, y: 0, w: 10, h: 10, text: "same" }];
  expect(setSketchText(one, "s1", "same")).toBeNull();
});

test("the_canvas_names_the_same_sketch_layer", () => {
  expect(SKETCH_LAYER).toBe(SKETCH_LAYER_ID);
});

test("a_sketch_with_a_nan_number_is_caught_before_addSketch", () => {
  // AddSketch's quiet refusal ('' note) is only for a caller bug; callers check finiteSketch first.
  const ok: NewSketch = { kind: "rect", x: 0, y: 0, w: 10, h: 10 };
  expect(finiteSketch(ok)).toBe(true);
  expect(finiteSketch({ kind: "pen", x: 0, y: 0, w: 10, h: 10, points: [[0, 0], [5, 5]] })).toBe(true);
  for (const bad of [{ ...ok, x: Number.NaN }, { ...ok, h: Number.POSITIVE_INFINITY }, { kind: "pen", x: 0, y: 0, w: 10, h: 10, points: [[0, Number.NaN]] } as NewSketch]) {
    expect(finiteSketch(bad)).toBe(false);
  }
  // The refusal with no note stays for any other caller.
  expect(addSketch([], { ...ok, x: Number.NaN })).toEqual({ refused: "" });
});

test("icon_sketches_count_toward_the_cap", () => {
  const icon: NewSketch = { kind: "icon", x: 0, y: 0, w: 64, h: 64, icon: "database" };
  let all: Sketch[] = [];
  for (let i = 0; i < MAX_SKETCHES; i++) {
    const r = addSketch(all, icon);
    if ("refused" in r) throw new Error(r.refused);
    all = applySketches(all, [r.change]);
  }
  expect(all).toHaveLength(MAX_SKETCHES);
  expect(addSketch(all, icon)).toEqual({ refused: TOO_MANY_SKETCHES });
  expect(addSketch([], { ...icon, icon: "Bad Name" })).toEqual({ refused: "" });
});

test("icon_sketches_draw_over_frames", () => {
  expect(drawsUnder("icon")).toBe(false);
  const b: BoardLayout = { frames: new Map(), sketches: [{ id: "i1", kind: "icon", x: 5, y: 6, w: 64, h: 64, icon: "database" }] };
  const out = createBoardScene("modern").build([], b, [], null, null, []);
  expect(out.nodes.find((n) => n.id === sketchNodeId("i1"))?.zIndex).toBe(Z_SKETCH);
});

test("an_icon_sketch_survives_copy_and_paste", () => {
  const s: Sketch = { id: "i1", kind: "icon", x: 1, y: 2, w: 64, h: 64, icon: "brand-postgresql" };
  const clip = readSketchClip(sketchClipText([s]));
  expect(clip?.sketches).toEqual([{ kind: "icon", x: 1, y: 2, w: 64, h: 64, icon: "brand-postgresql" }]);
  expect(readSketchClip(sketchClipText([{ ...s, icon: undefined }]))?.sketches).toEqual([]);
});

test("an_icon_sketch_stores_no_title", () => {
  const r = addSketch([], { kind: "icon", x: 0, y: 0, w: 64, h: 64, icon: "database" });
  if ("refused" in r) throw new Error(r.refused);
  expect(r.change.after?.text).toBeUndefined();
  expect(r.change.after?.icon).toBe("database");
  expect(MAX_BOARD_SKETCH_TEXT).toBe(100_000);
});
