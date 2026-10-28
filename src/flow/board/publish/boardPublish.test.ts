// Plan B4 Task 2: what each part of a board publishes (Decisions 1, 2, 4 and 7), as pure data.
import { expect, test, vi } from "vitest";
import type { Box, Scene } from "../../../diagram/export/scene";
import type { FlowDoc } from "../../../lang/flow/model";
import { createFlowService, type FrameResult } from "../../../lang/flow/service";
import { DIAGRAM_KIND_WORD } from "../../diagramKinds";
import type { FlowLayout } from "../../layout";
import { emptyPositions } from "../../layout";
import type { BoardLayout, FrameLayout, Sketch } from "../boardLayout";
import { FRAME_TAB_H, type FrameBox, TAB_GAP, TAB_ICON, TAB_PAD_X, TAB_TITLE_MAX } from "../boardScene";
import { SAMPLES } from "../../../lang/flow/fixtures/samples";
import { parseFlow } from "../../../lang/flow/parse";
import { frameGraph } from "../boardLayout";
import {
  anyFrameDrawn,
  type BoardPublishInput,
  boardPublishInput,
  frameDraws,
  defaultPart,
  intersects,
  partContent,
  partEnabled,
  type PublishFrame,
  selectionRegion,
  sketchBox,
  tabWidth,
} from "./boardPublish";

// Every frame graph built, counted (final review I2): the Publish guards run on each keystroke.
const graphs = vi.hoisted(() => ({ n: 0 }));
vi.mock("../boardLayout", async (load) => {
  const real = await load<typeof import("../boardLayout")>();
  return {
    ...real,
    frameGraph: (...a: Parameters<typeof real.frameGraph>) => {
      graphs.n++;
      return real.frameGraph(...a);
    },
  };
});

// The fixture board (R29): a flowchart, an ERD, a sequence frame with no layout entry and a frame with an empty title.
const CHECKOUT = 'diagram flow "Checkout"\nCart\nPay\nCart > Pay\n';
const ORDERS = 'diagram er "Orders"\norders {\n  id int pk\n  customer_id int\n}\ncustomers {\n  id int pk\n}\norders.customer_id > customers.id\n';
const PAY = 'diagram sequence "Pay"\nparticipant A\nparticipant B\nA -> B : hi\n';
const BLANK = 'diagram flow ""\nStart\nEnd\nStart > End\n';
const TEXT = [CHECKOUT, ORDERS, PAY, BLANK].join("\n");
const KEYS = ["Checkout", "Orders", "Pay", ""];

function entry(at: { x: number; y: number }, nodes: Record<string, { x: number; y: number }>, more: Partial<FrameLayout> = {}): FrameLayout {
  return { at, nodes: Object.assign(emptyPositions(), nodes), style: "modern", direction: "TB", ...more };
}

function board(sketches: Sketch[] = []): BoardLayout {
  return {
    frames: new Map([
      ["Checkout", entry({ x: 0, y: 0 }, { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } })],
      ["Orders", entry({ x: 600, y: 0 }, { orders: { x: 0, y: 0 }, customers: { x: 300, y: 0 } })],
      // "Pay" has no entry: a sequence is placed from its text (R2).
      ["", entry({ x: 0, y: 600 }, { Start: { x: 0, y: 0 }, End: { x: 0, y: 120 } })],
    ]),
    sketches,
  };
}

const parse = (text: string) => createFlowService().parse("board", text).frames;

/** Each frame's canvas box (origin-relative), as `createBoardScene` gives them. */
function boxes(frames: readonly FrameResult[], keys: readonly string[], b: BoardLayout, origin = { x: 0, y: 0 }): FrameBox[] {
  return frames.map((f, i) => {
    const key: string | undefined = keys[i];
    const at = (key === undefined ? undefined : b.frames.get(key)?.at) ?? { x: 0, y: 0 };
    const clash = key?.startsWith("\u0000#") ?? false;
    return { key: clash || key === undefined ? null : key, index: i, title: f.title, kind: f.kind, x: at.x - origin.x, y: at.y - origin.y, w: 400, h: 300, problems: 0, clash };
  });
}

const SCREEN: Box = { x: -100, y: -100, w: 2000, h: 1200 };

function input(over: Partial<Parameters<typeof boardPublishInput>[0]> = {}): BoardPublishInput {
  const frames = over.frames ?? parse(TEXT);
  const keys = over.keys ?? KEYS;
  const b = over.board ?? board();
  const origin = over.origin ?? { x: 0, y: 0 };
  return boardPublishInput({
    frames,
    board: b,
    keys,
    boxes: over.boxes ?? boxes(frames, keys, b, origin),
    origin,
    frameIndex: over.frameIndex ?? null,
    live: over.live ?? null,
    shapes: over.shapes ?? [],
    sketchIds: over.sketchIds ?? [],
    iconTitles: over.iconTitles,
    onScreen: over.onScreen ?? SCREEN,
  });
}

function sketch(id: string, x: number, y: number, w = 40, h = 40, kind: Sketch["kind"] = "rect"): Sketch {
  return { id, kind, x, y, w, h };
}

const liveOf = (b: BoardLayout, key: string): { layout: FlowLayout; folded: ReadonlySet<string>; textScale: number; notation: "crow" | "arrow" } => ({
  layout: { version: 1, nodes: b.frames.get(key)!.nodes, style: "modern", direction: "TB" },
  folded: new Set<string>(),
  textScale: 1,
  notation: "crow",
});

/** A scene node at a place, 100 by 80. */
const node = (id: string, x: number, y: number): Scene["nodes"][number] => ({ id, kind: "table", title: id, rows: [], x, y, w: 100, h: 80 });

const titles = (fs: PublishFrame[]) => fs.map((f) => f.title);

test("the_default_follows_the_selection", () => {
  const b = board([sketch("s1", 1000, 1000)]);
  expect(defaultPart(input({ board: b }))).toBe("board");
  expect(defaultPart(input({ board: b, frameIndex: 0, live: liveOf(b, "Checkout") }))).toBe("frame");
  expect(defaultPart(input({ board: b, frameIndex: 0, live: liveOf(b, "Checkout"), shapes: ["Cart"] }))).toBe("selection");
  expect(defaultPart(input({ board: b, sketchIds: ["s1"] }))).toBe("selection");
});

test("parts_are_off_without_what_they_need", () => {
  const none = input();
  expect(partEnabled(none, "board")).toBe(true);
  expect(partEnabled(none, "screen")).toBe(true);
  expect(partEnabled(none, "frame")).toBe(false);
  expect(partEnabled(none, "selection")).toBe(false);
  const b = board([sketch("s1", 1000, 1000)]);
  const one = input({ board: b, frameIndex: 0, live: liveOf(b, "Checkout") });
  expect(partEnabled(one, "frame")).toBe(true);
  expect(partEnabled(one, "selection")).toBe(false);
  expect(partEnabled(input({ board: b, sketchIds: ["s1"] }), "selection")).toBe(true);
  // A board with nothing drawn and no sketch has nothing to publish.
  const empty = input({ frames: parse('diagram flow "Lone"\nA\n'), keys: ["Lone"], board: { frames: new Map(), sketches: [] } });
  expect(empty.frames).toEqual([]);
  for (const p of ["board", "frame", "selection", "screen"] as const) expect(partEnabled(empty, p), p).toBe(false);
});

test("whole_board_takes_every_frame_and_sketch", () => {
  const sk = [sketch("under", -300, -300, 50, 50, "section"), sketch("pen", 2000, 800, 10, 10, "pen")];
  const i = input({ board: board(sk) });
  const c = partContent(i, "board", null, true);
  expect(titles(c.frames)).toEqual(["Checkout", "Orders", "Pay", ""]);
  expect(c.sketches.map((s) => s.id)).toEqual(["under", "pen"]);
  // The region holds every frame with its tab and every sketch, the Section's title line above it too (22 px).
  expect(c.region.x).toBe(-300);
  expect(c.region.y).toBe(-322);
  expect(c.region.x + c.region.w).toBe(2010);
  expect(c.region.y + c.region.h).toBe(900);
  const plain = partContent(i, "board", null, false);
  expect(plain.region.y).toBe(-322);
});

test("selected_frame_leaves_out_an_overlapping_frame", () => {
  // Orders dragged over Checkout; Checkout selected.
  const b = board([sketch("inside", 50, 50), sketch("onTab", 10, -20, 30, 15), sketch("across", 380, 10, 60, 40)]);
  b.frames.set("Orders", { ...b.frames.get("Orders")!, at: { x: 200, y: 100 } });
  const i = input({ board: b, frameIndex: 0, live: liveOf(b, "Checkout") });
  const c = partContent(i, "frame", null, true);
  expect(titles(c.frames)).toEqual(["Checkout"]);
  // Only what sits wholly on the box: the sketch over the tab strip and the one across the edge are out.
  expect(c.sketches.map((s) => s.id)).toEqual(["inside"]);
});

test("selected_frame_region_takes_the_tab_only_with_titles", () => {
  const b = board();
  const i = input({ board: b, frameIndex: 0, live: liveOf(b, "Checkout") });
  expect(partContent(i, "frame", null, true).region).toEqual({ x: 0, y: -FRAME_TAB_H, w: 400, h: 300 + FRAME_TAB_H });
  expect(partContent(i, "frame", null, false).region).toEqual({ x: 0, y: 0, w: 400, h: 300 });
});

test("tab_width_adds_the_pill_parts_and_caps_the_title", () => {
  const word = DIAGRAM_KIND_WORD.flow.length * 7;
  expect(tabWidth("Pay", "flow")).toBe(TAB_PAD_X + TAB_ICON + TAB_GAP + word + TAB_GAP + 3 * 7 + TAB_PAD_X);
  expect(tabWidth("", "flow")).toBe(tabWidth("Untitled", "flow"));
  expect(tabWidth("x".repeat(200), "flow")).toBe(TAB_PAD_X + TAB_ICON + TAB_GAP + word + TAB_GAP + TAB_TITLE_MAX + TAB_PAD_X);
});

test("a_long_title_widens_the_selected_frame_region", () => {
  // The title cap (240) holds the widest tab to 352 (an ERD's), so the box is 320 and the tab 352 here (R21).
  const title = "A very long title for the orders schema";
  const frames = parse(`diagram er "${title}"\norders {\n  id int pk\n}\n`);
  const b: BoardLayout = { frames: new Map([[title, entry({ x: 0, y: 0 }, { orders: { x: 0, y: 0 } })]]), sketches: [] };
  const bx = boxes(frames, [title], b).map((x) => ({ ...x, w: 320 }));
  const i = input({ frames, keys: [title], board: b, boxes: bx, frameIndex: 0, live: liveOf(b, title) });
  expect(tabWidth(title, "er")).toBe(352);
  expect(partContent(i, "frame", null, true).region.w).toBe(352);
  expect(partContent(i, "frame", null, false).region.w).toBe(320);
});

test("a_sketch_only_selection_is_the_sketch_box", () => {
  const b = board([sketch("s1", 900, 700, 60, 30)]);
  // With a live frame at a far place and no shape selected, nothing pulls the region toward (0, 0) or `at`.
  b.frames.set("Orders", { ...b.frames.get("Orders")!, at: { x: -500, y: -500 } });
  const i = input({ board: b, frameIndex: 1, live: liveOf(b, "Orders"), sketchIds: ["s1"] });
  const scene: Scene = { nodes: [node("orders", 0, 0)], edges: [] };
  expect(selectionRegion(i, scene)).toEqual({ x: 900, y: 700, w: 60, h: 30 });
  expect(selectionRegion(input({ board: b }), null)).toBeNull();
});

test("a_shape_and_a_sketch_selection_joins_both", () => {
  const b = board([sketch("s1", 900, 700, 60, 30)]);
  const i = input({ board: b, frameIndex: 1, live: liveOf(b, "Orders"), shapes: ["orders"], sketchIds: ["s1"] });
  const scene: Scene = {
    nodes: [node("orders", 10, 20), node("customers", 300, 0)],
    edges: [],
  };
  // orders at (600 + 10, 0 + 20) to (710, 100); the sketch to (960, 730).
  expect(selectionRegion(i, scene)).toEqual({ x: 610, y: 20, w: 350, h: 710 });
  // A shape the scene does not hold adds nothing.
  const gone = input({ board: b, frameIndex: 1, live: liveOf(b, "Orders"), shapes: ["nope"] });
  expect(selectionRegion(gone, scene)).toBeNull();
});

test("selection_takes_what_meets_its_region", () => {
  const b = board([sketch("near", 450, 50), sketch("far", 5000, 5000)]);
  // Pay has no entry, so its canvas box is wherever the canvas put it: here well below the others.
  const frames = parse(TEXT);
  const bx = boxes(frames, KEYS, b).map((x) => (x.title === "Pay" ? { ...x, y: 2000 } : x));
  const i = input({ frames, board: b, boxes: bx });
  // Meets Checkout (0..400) and the sketch at 450; Orders starts at 600.
  const region = { x: 300, y: 0, w: 200, h: 100 };
  const c = partContent(i, "selection", region, true);
  expect(titles(c.frames)).toEqual(["Checkout"]);
  expect(c.sketches.map((s) => s.id)).toEqual(["near"]);
  expect(c.region).toEqual(region);
  // A region over the tab strip meets the frame only with titles on.
  const tab = { x: 610, y: -25, w: 20, h: 10 };
  expect(titles(partContent(i, "screen", tab, true).frames)).toEqual(["Orders"]);
  expect(partContent(i, "screen", tab, false).frames).toEqual([]);
});

test("frames_are_placed_in_board_units", () => {
  const b = board();
  b.frames.set("Checkout", { ...b.frames.get("Checkout")!, at: { x: -400, y: 120 } });
  const origin = { x: 200, y: 0 };
  const frames = parse(TEXT);
  const bx = boxes(frames, KEYS, b, origin);
  const i = input({ frames, board: b, boxes: bx, origin });
  const f = i.frames.find((x) => x.title === "Checkout")!;
  expect(f.at).toEqual({ x: -400, y: 120 });
  expect(f.box.x).toBe(bx[0].x + 200);
  expect(f.box.y).toBe(bx[0].y);
  expect(f.box).toEqual({ x: -400, y: 120, w: 400, h: 300 });
});

test("left_out_frames_follow_one_rule", () => {
  // Checkout with an error and no good doc yet; Orders with an error holding its last good doc; Pay a sequence with
  // no entry; "Bare" a flowchart with no placed node; a second "Checkout" whose title the first took.
  const svc = createFlowService();
  const good = svc.parse("board", [CHECKOUT, ORDERS, PAY].join("\n")).frames;
  const ordersDoc = good[1].doc!;
  const text = [CHECKOUT.replace("Cart > Pay", "Cart >"), ORDERS.replace("customers.id\n", "customers.id >\n"), PAY, 'diagram flow "Bare"\nA\n', CHECKOUT].join("\n");
  const frames = svc.parse("board", text).frames;
  const keys = ["Checkout", "Orders", "Pay", "Bare", "\u0000#4"];
  expect(frames[0].doc).toBeNull();
  expect(frames[1].doc).toBeNull();
  expect(frames[1].lastValid).toBe(ordersDoc);
  // Checkout had a good doc before too: drop it so this frame has neither.
  const f0: FrameResult = { ...frames[0], lastValid: null, lastValidId: null };
  const all = [f0, ...frames.slice(1)];
  const i = input({ frames: all, keys });
  expect(titles(i.frames)).toEqual(["Orders", "Pay"]);
  expect(i.frames[0].doc).toBe(ordersDoc);
  expect(i.frames[0].kind).toBe("er");
  expect(i.frames[1].kind).toBe("sequence");
  expect(i.nothingDrawn).toBe(2);
  expect(i.clashing).toBe(1);
});

test("an_errored_frame_never_borrows_another_frames_drawing", () => {
  // The carried B1 bug: a flowchart titled as an ERD before it, with an error, is handed the ERD's doc by title.
  const svc = createFlowService();
  svc.parse("board", 'diagram er "X"\norders {\n  id int pk\n}\n');
  const frames = svc.parse("board", ['diagram flow "X"\nA >\n', 'diagram er "X"\norders {\n  id int pk\n}\n'].join("\n")).frames;
  const erDoc = frames[1].doc!;
  expect(frames[0].doc).toBeNull();
  expect(frames[0].kind).toBe("flow");
  const b: BoardLayout = { frames: new Map([["X", entry({ x: 0, y: 0 }, { A: { x: 0, y: 0 }, orders: { x: 0, y: 0 } })]]), sketches: [] };
  const keys = ["X", "\u0000#1"];
  const i = input({ frames, keys, board: b });
  // Whatever the worker sent, the flowchart never publishes the ERD's drawing.
  for (const f of i.frames) expect(f.doc).not.toBe(erDoc);
  expect(i.frames).toEqual([]);
  expect(i.nothingDrawn).toBe(1);
  expect(i.clashing).toBe(1);

  // By hand: another kind's doc, and another live frame's very doc of the same kind, are both refused.
  const other = parse('diagram flow "Y"\nA\n')[0].doc!;
  const mk = (over: Partial<FrameResult>): FrameResult => ({ ...frames[0], title: "X", kind: "flow", doc: null, lastValid: null, docId: null, lastValidId: null, ...over });
  const y: FrameResult = { ...mk({ title: "Y", doc: other, docId: 7 }) };
  const b2: BoardLayout = { frames: new Map([["X", entry({ x: 0, y: 0 }, { A: { x: 0, y: 0 } })], ["Y", entry({ x: 500, y: 0 }, { A: { x: 0, y: 0 } })]]), sketches: [] };
  const cross = input({ frames: [mk({ lastValid: erDoc, lastValidId: 3 })], keys: ["X"], board: b2 });
  expect(cross.frames).toEqual([]);
  const borrowed = input({ frames: [mk({ lastValid: other, lastValidId: 7 }), y], keys: ["X", "Y"], board: b2 });
  expect(titles(borrowed.frames)).toEqual(["Y"]);
  // Its own last good doc (same kind, no other frame's) is drawn.
  const own: FlowDoc = parse('diagram flow "X"\nA\n')[0].doc!;
  const kept = input({ frames: [mk({ lastValid: own, lastValidId: 9 }), y], keys: ["X", "Y"], board: b2 });
  expect(titles(kept.frames)).toEqual(["X", "Y"]);
  expect(kept.frames[0].doc).toBe(own);
});

test("static_frames_take_their_entry_settings", () => {
  const b = board();
  b.frames.set("Orders", { ...b.frames.get("Orders")!, notation: "arrow", textSize: "l" });
  const i = input({ board: b });
  const orders = i.frames.find((f) => f.title === "Orders")!;
  expect(orders.notation).toBe("arrow");
  expect(orders.textScale).toBe(1.15);
  expect(orders.layout.nodes).toBe(b.frames.get("Orders")!.nodes);
  expect(orders.live).toBe(false);
  expect(orders.folded).toBeUndefined();
  const pay = i.frames.find((f) => f.title === "Pay")!;
  expect(pay.notation).toBe("crow");
  expect(pay.textScale).toBe(1);
  expect(pay.at).toEqual({ x: 0, y: 0 });
  expect(pay.layout.direction).toBeDefined();
});

test("the_live_frame_uses_the_live_layout_folds_and_settings", () => {
  const b = board();
  b.frames.set("Orders", { ...b.frames.get("Orders")!, notation: "crow", textSize: "s" });
  const layout: FlowLayout = { version: 1, nodes: Object.assign(emptyPositions(), { orders: { x: 5, y: 5 } }), style: "modern", direction: "LR" };
  const folded = new Set(["orders"]);
  const i = input({ board: b, frameIndex: 1, live: { layout, folded, textScale: 1.15, notation: "arrow" } });
  const orders = i.frames.find((f) => f.title === "Orders")!;
  expect(orders.live).toBe(true);
  expect(orders.layout).toBe(layout);
  expect(orders.folded).toBe(folded);
  expect(orders.textScale).toBe(1.15);
  expect(orders.notation).toBe("arrow");
  expect(orders.at).toEqual({ x: 600, y: 0 });
  expect(i.frames.filter((f) => f.live)).toHaveLength(1);
  expect(i.frameIndex).toBe(1);
});

test("the_input_keeps_shapes_and_sketches_apart", () => {
  const b = board([sketch("s1", 0, 0)]);
  const titlesMap = new Map([["aws-s3", "S3"]]);
  const i = input({ board: b, frameIndex: 0, live: liveOf(b, "Checkout"), shapes: ["Cart", "sketch:s1"], sketchIds: ["s1"], iconTitles: titlesMap });
  expect(i.shapes).toEqual(["Cart", "sketch:s1"]);
  expect(i.sketchIds).toEqual(["s1"]);
  expect(i.sketches).toBe(b.sketches);
  expect(i.iconTitles).toBe(titlesMap);
  expect(i.onScreen).toEqual(SCREEN);
  expect(input().iconTitles.size).toBe(0);
});

test("sketch_box_and_intersects", () => {
  expect(sketchBox(sketch("a", 1, 2, 3, 4))).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  expect(intersects({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
  expect(intersects({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 })).toBe(false);
  // A flat line sketch inside a box still meets it.
  expect(intersects({ x: 0, y: 0, w: 10, h: 10 }, { x: 2, y: 5, w: 4, h: 0 })).toBe(true);
});

// ---- Carried from Task 2's review into Task 5. ----

test("selection_is_off_when_every_selected_shape_is_stale", () => {
  const b = board();
  // "Gone" was deleted from the text after it was selected: Selection would draw an empty picture.
  const stale = input({ board: b, frameIndex: 0, live: liveOf(b, "Checkout"), shapes: ["Gone"] });
  expect(partEnabled(stale, "selection")).toBe(false);
  expect(defaultPart(stale)).toBe("frame");
  // One live name among stale ones is enough.
  expect(partEnabled(input({ board: b, frameIndex: 0, live: liveOf(b, "Checkout"), shapes: ["Gone", "Cart"] }), "selection")).toBe(true);
  // A name in the text with no place on the canvas is not drawn either.
  const unplaced = { ...liveOf(b, "Checkout"), layout: { version: 1 as const, nodes: Object.assign(emptyPositions(), { Pay: { x: 0, y: 0 } }), style: "modern" as const, direction: "TB" as const } };
  expect(partEnabled(input({ board: b, frameIndex: 0, live: unplaced, shapes: ["Cart"] }), "selection")).toBe(false);
});

test("an_undefined_key_is_not_counted_as_clashing", () => {
  const all = input();
  // Keys shorter than frames: a plumbing slip, never a repeated title for the note.
  const short = input({ keys: KEYS.slice(0, 3) });
  expect(short.clashing).toBe(0);
  // The keyless frame has no layout entry, so a flowchart with no placed node draws nothing.
  expect(short.nothingDrawn).toBe(all.nothingDrawn + 1);
  expect(titles(short.frames)).toEqual(["Checkout", "Orders", "Pay"]);
});

test("the_live_frames_nothing_drawn_reads_the_live_layout", () => {
  const b = board();
  // The board entry still has places, the live layout has none yet: the live frame has nothing drawn.
  const emptyLive = { ...liveOf(b, "Checkout"), layout: { version: 1 as const, nodes: emptyPositions(), style: "modern" as const, direction: "TB" as const } };
  const a = input({ board: b, frameIndex: 0, live: emptyLive });
  expect(titles(a.frames)).not.toContain("Checkout");
  expect(a.nothingDrawn).toBe(input({ board: b }).nothingDrawn + 1);
  // The reverse: a stale empty entry, a live layout with a place: drawn.
  const b2 = board();
  b2.frames.set("Checkout", entry({ x: 0, y: 0 }, {}));
  const live = { ...liveOf(b, "Checkout") };
  const c = input({ board: b2, frameIndex: 0, live });
  expect(titles(c.frames)).toContain("Checkout");
  expect(c.frames.find((f) => f.title === "Checkout")!.live).toBe(true);
});

// ----- Final review I2: the Publish guards are cheap and give frameGraph's answer.

test("the_publish_guards_build_no_graph_per_keystroke", () => {
  const svc = createFlowService();
  const b = board();
  // Each keystroke is a new parse; FlowTab then asks both guards (the strip button and Publish frame...).
  for (const typed of ["", " x", " xy"]) {
    const frames = svc.parse("board", TEXT.replace("Pay\n", `Pay${typed}\n`)).frames;
    const live = b.frames.get("Checkout")!;
    const layout: FlowLayout = { version: 1, nodes: live.nodes, style: "modern", direction: "TB" };
    graphs.n = 0;
    expect(anyFrameDrawn({ frames, board: b, keys: KEYS, frameIndex: 0, liveLayout: layout })).toBe(true);
    expect(anyFrameDrawn({ frames, board: b, keys: KEYS, frameIndex: 0, liveLayout: layout, only: 0 })).toBe(true);
    // A static frame asked alone: the ERD, whose tables are placed.
    expect(anyFrameDrawn({ frames, board: b, keys: KEYS, frameIndex: 0, liveLayout: layout, only: 1 })).toBe(true);
    // The sequence frame, placed from its text.
    expect(anyFrameDrawn({ frames, board: b, keys: KEYS, frameIndex: 0, liveLayout: layout, only: 2 })).toBe(true);
    expect(graphs.n, `typed "${typed}"`).toBe(0);
  }
});

test("the_cheap_guard_agrees_with_frame_graph", () => {
  const docs: FlowDoc[] = [];
  const extra = [
    'diagram flow "Groups"\ngroup Team {\n}\n',
    'diagram flow "Grouped"\ngroup Team {\n  A\n}\nB\n',
    'diagram mindmap "Empty"\n',
    'diagram sequence "Empty"\n',
    'diagram timeline "Empty"\n',
    'diagram er "Empty"\n',
    'diagram flow "Empty"\n',
  ];
  for (const t of [...SAMPLES, ...extra]) {
    const d = parseFlow(t).doc;
    if (d) docs.push(d);
  }
  expect(docs.length).toBeGreaterThan(10);
  let checked = 0;
  for (const d of docs) {
    const names = d.nodes.map((n) => n.name);
    const placements: (Record<string, { x: number; y: number }> | null)[] = [null, {}, Object.fromEntries(names.slice(0, 1).map((n) => [n, { x: 0, y: 0 }])), Object.fromEntries(names.map((n, i) => [n, { x: i * 200, y: 0 }])), { "not a node": { x: 0, y: 0 } }];
    for (const nodes of placements) {
      const e = nodes === null ? undefined : entry({ x: 0, y: 0 }, nodes);
      expect(frameDraws(e, d), `${d.kind} ${d.title} ${JSON.stringify(nodes)}`).toBe(frameGraph(e, d, e?.style ?? "modern").nodes.length > 0);
      checked++;
    }
  }
  expect(checked).toBe(docs.length * 5);
});
