// The board request built from the worker's outlines and the canvas: every frame with its
// box and problems, the sketches as notes, the chips and the selection.
import type { Node } from "@xyflow/react";
import { expect, test } from "vitest";
import { createFlowService, type BoardOutlineFrame } from "../../lang/flow/service";
import { buildFlowGraph } from "../flowNodes";
import { emptyPositions } from "../layout";
import type { BoardLayout, FrameLayout, Sketch } from "../board/boardLayout";
import { boardNodeBoxes, createBoardScene, FRAME_PICTURE_TYPE, type FrameBox, inFrameId, LIVE_ANCHOR_ID } from "../board/boardScene";
import { createPictureStore } from "../board/framePicture";
import { exportPalette } from "../../diagram/export/palette";
import { MAX_BOARD_FRAMES } from "../../lang/flow/model";
import { MAX_SKETCHES } from "../board/boardLayout";
import { boardGateFields, boardInput, MAX_TABLE_LINKS, onBoard, POINT_AT_PX, SELECTED_MAX, sketchNotes } from "./boardInput";

const CHECKOUT = 'diagram flow "Checkout"\nShop {\n  Cart\n  Pay\n}\nCart > Pay: card\n';
const REFUND = 'diagram flow "Refund"\nAsk\nRefund it\nAsk > Refund it\n';
const TEXT = `${CHECKOUT}\n${REFUND}`;
const KEYS = ["Checkout", "Refund"];

function entry(at: { x: number; y: number }, nodes: Record<string, { x: number; y: number }>): FrameLayout {
  return { at, nodes: Object.assign(emptyPositions(), nodes), style: "modern", direction: "TB" };
}

function layout(sketches: Sketch[] = []): BoardLayout {
  return {
    frames: new Map([
      ["Checkout", entry({ x: 0, y: 0 }, { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } })],
      ["Refund", entry({ x: 600, y: 0 }, { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } })],
    ]),
    sketches,
  };
}

/** The board as the canvas holds it: its frames' boxes and parts in board units, and the worker's outline. */
function board(sketches: Sketch[] = [], text = TEXT, keys = KEYS) {
  const svc = createFlowService();
  const r = svc.parse("d", text);
  const b = layout(sketches);
  const scene = createBoardScene("modern").build(r.frames, b, keys, null, null, []);
  const o = svc.boardOutline("d", r.version);
  if (o.stale) throw new Error("expected the board's outline");
  return { r, b, scene, boxes: onBoard(scene), parts: boardNodeBoxes(scene), frames: o.frames };
}

const centre = (p: { x: number; y: number; w: number; h: number }) => ({ x: p.x + p.w / 2, y: p.y + p.h / 2 });

function partOf(parts: ReturnType<typeof boardNodeBoxes>, frame: string, name: string) {
  const p = parts.get(frame)?.find((x) => x.name === name);
  if (!p) throw new Error(`no ${name} in ${frame}`);
  return p;
}

/** An arrow from `tail` to `head`, in board units. */
function arrow(id: string, tail: { x: number; y: number }, head: { x: number; y: number }, kind: "arrow" | "line" = "arrow"): Sketch {
  const x = Math.min(tail.x, head.x);
  const y = Math.min(tail.y, head.y);
  return {
    id,
    kind,
    x,
    y,
    w: Math.abs(head.x - tail.x),
    h: Math.abs(head.y - tail.y),
    points: [
      [tail.x - x, tail.y - y],
      [head.x - x, head.y - y],
    ],
  };
}

const input = (b: ReturnType<typeof board>, more: Partial<Parameters<typeof boardInput>[0]> = {}) =>
  boardInput({ frames: b.frames, boxes: b.boxes, focus: [], selected: { frame: null, shapes: [], sketches: [] }, notes: [], create: null, followUp: null, attachment: null, ...more });

test("an_arrow_from_a_note_names_the_note_and_the_shape", () => {
  const { parts, boxes } = board();
  const pay = centre(partOf(parts, "Checkout", "Pay"));
  const note: Sketch = { id: "s1", kind: "note", x: -400, y: 100, w: 120, h: 60, text: "slow!" };
  // The tail stands 10 right of the note, the head on Pay.
  const sketches = [note, arrow("s2", { x: -270, y: 130 }, pay), arrow("s3", { x: -270, y: 130 }, { x: pay.x, y: pay.y + 400 })];
  const notes = sketchNotes(sketches, boxes, parts);
  const s2 = notes.find((n) => n.id === "s2");
  expect(s2).toMatchObject({ kind: "arrow", from: "s1", pointsAt: { frame: "Checkout", name: "Pay" } });
  // The centre of its box, in whole board units.
  expect(s2!.at).toEqual({ x: Math.round((-270 + pay.x) / 2), y: Math.round((130 + pay.y) / 2) });
  // A head further than POINT_AT_PX from every part points at nothing.
  expect(notes.find((n) => n.id === "s3")?.pointsAt ?? null).toBeNull();
  // A head just inside POINT_AT_PX of a shape's edge still names it; just past it, nothing.
  const ask = partOf(parts, "Refund", "Ask");
  const at = (x: number) => sketchNotes([note, arrow("s4", { x: -270, y: 130 }, { x, y: ask.y + ask.h / 2 })], boxes, parts).find((n) => n.id === "s4")?.pointsAt ?? null;
  expect(at(ask.x + ask.w + POINT_AT_PX - 1)).toEqual({ frame: "Refund", name: "Ask" });
  expect(at(ask.x + ask.w + POINT_AT_PX + 1)).toBeNull();
  // A shape inside a group is named before the group around it.
  expect(sketchNotes([arrow("s5", { x: -900, y: -900 }, pay)], boxes, parts)[0].pointsAt).toEqual({ frame: "Checkout", name: "Pay" });
  // The note itself is a note near the frame.
  expect(notes.find((n) => n.id === "s1")).toEqual({ id: "s1", kind: "note", text: "slow!", at: { x: -340, y: 130 }, from: null, pointsAt: null, on: null, near: "Checkout" });
});

test("a_note_inside_a_frame_is_on_it", () => {
  const { boxes, parts } = board();
  const [checkout, refund] = boxes;
  const c = centre(checkout);
  const sketches: Sketch[] = [
    { id: "a", kind: "note", x: Math.round(c.x) - 20, y: Math.round(c.y) - 10, w: 40, h: 20, text: "check this" },
    { id: "b", kind: "text", x: refund.x + refund.w + 100, y: refund.y, w: 40, h: 20, text: "later" },
    { id: "c", kind: "note", x: 20_000, y: 20_000, w: 40, h: 20, text: "far away" },
    { id: "d", kind: "section", x: refund.x, y: refund.y, w: refund.w, h: refund.h, text: "Phase 2" },
    { id: "e", kind: "icon", x: refund.x + 10, y: refund.y + 10, w: 60, h: 60, icon: "aws-s3" },
  ];
  const notes = sketchNotes(sketches, boxes, parts);
  const by = (id: string) => notes.find((n) => n.id === id);
  expect(by("a")).toMatchObject({ kind: "note", text: "check this", on: "Checkout", near: null });
  expect(by("b")).toMatchObject({ kind: "text", text: "later", on: null, near: "Refund" });
  expect(by("c")).toMatchObject({ on: null, near: null });
  // A section by its title; an icon by its pack name.
  expect(by("d")).toMatchObject({ kind: "section", text: "Phase 2", on: "Refund" });
  expect(by("e")).toMatchObject({ kind: "icon", text: "aws-s3", on: "Refund" });
});

test("a_labelled_rect_is_a_note", () => {
  const { boxes, parts } = board();
  const sketches: Sketch[] = [
    { id: "r", kind: "rect", x: -500, y: 0, w: 100, h: 60, text: "todo" },
    { id: "e", kind: "ellipse", x: -500, y: 200, w: 100, h: 60, text: "ask Sam" },
    { id: "d", kind: "diamond", x: -500, y: 400, w: 100, h: 60, text: "  " },
    { id: "x", kind: "rect", x: -500, y: 600, w: 100, h: 60 },
  ];
  const notes = sketchNotes(sketches, boxes, parts);
  expect(notes.map((n) => [n.id, n.kind, n.text])).toEqual([
    ["r", "rect", "todo"],
    ["e", "ellipse", "ask Sam"],
  ]);
  // An arrow from a labelled shape names it; from an empty one it names nothing.
  const pay = centre(partOf(parts, "Checkout", "Pay"));
  const from = sketchNotes([...sketches, arrow("a1", { x: -390, y: 30 }, pay), arrow("a2", { x: -390, y: 630 }, pay)], boxes, parts);
  expect(from.find((n) => n.id === "a1")?.from).toBe("r");
  expect(from.find((n) => n.id === "a2")?.from).toBeNull();
});

test("pen_strokes_are_not_notes", () => {
  const { boxes, parts } = board();
  const sketches: Sketch[] = [
    { id: "p", kind: "pen", x: 10, y: 10, w: 50, h: 50, points: [[0, 0], [50, 50]], text: "never read" },
    { id: "o", kind: "ellipse", x: 10, y: 10, w: 50, h: 50 },
    { id: "l", kind: "line", x: -900, y: -900, w: 10, h: 10, points: [[0, 0], [10, 10]] },
  ];
  expect(sketchNotes(sketches, boxes, parts)).toEqual([]);
  // A pen stroke is never an arrow's tail either.
  const pay = centre(partOf(parts, "Checkout", "Pay"));
  const notes = sketchNotes([...sketches, arrow("a", { x: 40, y: 40 }, pay)], boxes, parts);
  expect(notes.map((n) => [n.id, n.from])).toEqual([["a", null]]);
});

test("focus_drops_gone_and_clashing_titles", () => {
  const b = board();
  // A third frame whose title the canvas reads as taken (it is never a target).
  const draft: FrameBox = { ...b.boxes[1], index: 2, key: null, title: "Draft", clash: true, x: 1200.6, y: 3.4 };
  const frames: BoardOutlineFrame[] = [...b.frames, { ...b.frames[1], index: 2, title: "Draft" }];
  const out = boardInput({ frames, boxes: [...b.boxes, draft], focus: ["Gone", "Refund", "Draft", "Checkout", "Refund"], selected: { frame: null, shapes: [], sketches: [] }, notes: [], create: null, followUp: null, attachment: null });
  expect(out.focus).toEqual(["Refund", "Checkout"]);
  expect(out.frames.map((f) => [f.title, f.clash])).toEqual([
    ["Checkout", false],
    ["Refund", false],
    ["Draft", true],
  ]);
  // Boxes in whole board units.
  expect(out.frames[2].box).toEqual({ x: 1201, y: 3, w: Math.round(draft.w), h: Math.round(draft.h) });
  expect(out.frames.every((f) => Object.values(f.box).every(Number.isInteger))).toBe(true);
  expect(out.frames[0]).toMatchObject({ index: 0, title: "Checkout", kind: "flow", from: 0, line: 1, outline: b.frames[0].outline, problems: [] });
});

test("overview_frames_still_give_node_boxes", () => {
  const svc = createFlowService();
  const r = svc.parse("d", TEXT);
  const b = layout();
  const full = createBoardScene("modern").build(r.frames, b, KEYS, null, null, []);
  // Far static frames draw as one picture each (in place of the preview below BOX_BELOW).
  const pictures = () => createPictureStore({ palette: (t) => exportPalette(t), loadIcons: async () => new Map(), onReady: () => {}, sync: true });
  const overview = createBoardScene("modern").build(r.frames, b, KEYS, null, null, [], undefined, null, pictures());
  // Pictured, the static frames are one node each, yet their parts are the same.
  expect(overview.nodes.some((n) => n.id === inFrameId("Checkout", "Pay"))).toBe(false);
  expect(overview.nodes.filter((n) => n.type === FRAME_PICTURE_TYPE)).toHaveLength(2);
  const parts = boardNodeBoxes(overview);
  expect(parts).toEqual(boardNodeBoxes(full));
  expect([...parts.keys()]).toEqual(["Checkout", "Refund"]);
  expect(parts.get("Checkout")!.map((p) => p.name).sort()).toEqual(["Cart", "Pay", "Shop"]);
  // In board units: the frame's place plus the shape's own.
  expect(partOf(parts, "Refund", "Ask")).toMatchObject({ x: 600, y: 0 });
  expect(partOf(parts, "Checkout", "Pay")).toMatchObject({ x: 0, y: 120 });
  // With Refund live (its anchor at its place), its parts come from the canvas's live nodes,
  // frame-local, still in board units.
  const live: Node[] = buildFlowGraph(r.frames[1].doc!, b.frames.get("Refund")!.nodes, "modern").nodes;
  const withLive = createBoardScene("modern").build(r.frames, b, KEYS, { title: "Refund", index: 1 }, { nodes: live }, [], undefined, null, pictures());
  expect(withLive.nodes.find((n) => n.id === LIVE_ANCHOR_ID)?.position).toEqual({ x: 600, y: 0 });
  const liveParts = boardNodeBoxes({ ...withLive, nodes: [...withLive.nodes, ...live] });
  expect(liveParts).toEqual(parts);
  expect(onBoard(withLive).map((x) => [x.title, x.x, x.y])).toEqual(onBoard(full).map((x) => [x.title, x.x, x.y]));
});

test("selected_sketches_go_as_ids", () => {
  const b = board();
  const sketches: Sketch[] = [{ id: "s7", kind: "note", x: -400, y: 0, w: 100, h: 60, text: "the text stays on the board" }];
  const notes = sketchNotes(sketches, b.boxes, b.parts);
  const out = input(b, { notes, selected: { frame: "Checkout", shapes: ["Pay"], sketches: ["s7"] }, create: "er", followUp: { asked: "Which one?", reply: "" }, attachment: "tok" });
  expect(out.selected).toEqual({ frame: "Checkout", shapes: ["Pay"], sketches: ["s7"] });
  expect(out.sketches).toBe(notes);
  expect(out).toMatchObject({ create: "er", followUp: { asked: "Which one?", reply: "" }, attachment: "tok" });
  expect(JSON.stringify(out.selected)).not.toContain("the text stays");
});

test("board_gate_fields_carry_every_frames_table_links_and_held_sources", () => {
  const text = 'diagram flow "Orders"\nO [table: shop.orders]\n\ndiagram flow "Users"\nU [table: shop.users]\nV\n';
  const b = board([], text, ["Orders", "Users"]);
  b.b.frames.set("Orders", { ...entry({ x: 0, y: 0 }, {}), source: { connectionId: "c1", database: "shop", schema: null } });
  b.b.held = [{ frame: "Old", source: { connectionId: "c2", database: "crm", schema: "public" } }];
  const out = boardGateFields({ result: b.r, keys: ["Orders", "Users"] }, b.b, b.frames);
  expect(out.sources).toEqual([
    { frame: "Orders", connectionId: "c1", database: "shop", schema: null },
    { frame: "Old", connectionId: "c2", database: "crm", schema: "public" },
  ]);
  expect(out.tableLinks).toEqual([
    { frame: "Orders", node: "O", table: "shop.orders" },
    { frame: "Users", node: "U", table: "shop.users" },
  ]);
});

test("table_links_stop_at_500_across_frames", () => {
  // Four frames of 200 linked shapes: 800 links, of which the first 500 go.
  const text = [0, 1, 2, 3].map((k) => [`diagram flow "F${k}"`, ...Array.from({ length: 200 }, (_, i) => `N${i} [table: t${k}_${i}]`), ""].join("\n")).join("\n");
  const keys = ["F0", "F1", "F2", "F3"];
  const svc = createFlowService();
  const r = svc.parse("d", text);
  const o = svc.boardOutline("d", r.version);
  if (o.stale) throw new Error("expected the board's outline");
  const out = boardGateFields({ result: r, keys }, { frames: new Map() }, o.frames);
  expect(out.tableLinks).toHaveLength(MAX_TABLE_LINKS);
  expect(out.tableLinks![MAX_TABLE_LINKS - 1]).toEqual({ frame: "F2", node: "N99", table: "t2_99" });
});

test("the_selection_names_at_most_200_shapes_and_sketches", () => {
  const b = board();
  const many = (p: string) => Array.from({ length: SELECTED_MAX + 50 }, (_, i) => `${p}${i}`);
  const out = input(b, { selected: { frame: "Checkout", shapes: many("S"), sketches: many("k") } });
  expect(out.selected.shapes).toEqual(many("S").slice(0, 200));
  expect(out.selected.sketches).toEqual(many("k").slice(0, 200));
  expect(SELECTED_MAX).toBe(200);
});

test("a_clash_frame_has_no_node_boxes", () => {
  const text = `${CHECKOUT}\n${REFUND}\n${CHECKOUT}`;
  const svc = createFlowService();
  const r = svc.parse("d", text);
  const scene = createBoardScene("modern").build(r.frames, layout(), ["Checkout", "Refund", "\u0000#2"], null, null, []);
  expect(scene.boxes.map((x) => x.clash)).toEqual([false, false, true]);
  const parts = boardNodeBoxes(scene);
  expect([...parts.keys()]).toEqual(["Checkout", "Refund"]);
  // The first Checkout's own parts, not the clash frame's (which stands elsewhere).
  expect(partOf(parts, "Checkout", "Pay")).toMatchObject({ x: 0, y: 120 });
  expect(parts.get("Checkout")).toHaveLength(3);
});

test("the_request_holds_at_most_the_board_limits_of_frames_and_notes", () => {
  const b = board();
  const frames: BoardOutlineFrame[] = Array.from({ length: MAX_BOARD_FRAMES + 5 }, (_, i) => ({ ...b.frames[0], index: i, title: `F${i}` }));
  const notes = Array.from({ length: MAX_SKETCHES + 5 }, (_, i) => ({ id: `s${i}`, kind: "note", text: "x", at: { x: 0, y: 0 }, from: null, pointsAt: null, on: null, near: null }));
  const out = input(b, { frames, notes });
  expect(out.frames).toHaveLength(MAX_BOARD_FRAMES);
  expect(out.sketches).toHaveLength(MAX_SKETCHES);
  expect(out.sketches[MAX_SKETCHES - 1].id).toBe(`s${MAX_SKETCHES - 1}`);
});
