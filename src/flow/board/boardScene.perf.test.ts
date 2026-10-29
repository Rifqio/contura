// Timing and memory: the board scene at the limit (A5's board: 50 frames, 10,000 shapes, 15,000 links).
// Run alone through `npm run test:perf`.
import { expect, test } from "vitest";
import { board, frame, FRAMES, TYPED_FRAME } from "../../lang/flow/fixtures/bigBoard";
import { bigBoardLayout, fullSketches } from "../../lang/flow/fixtures/bigBoardLayout";
import type { FrameReview } from "../ai/boardReview";
import { reviewOverlay } from "../ai/reviewOverlay";
import { bestMedian } from "../../lang/flow/perfGate";
import { createFlowService } from "../../lang/flow/service";
import { type DrawnForms, frameDraw, stepForms, SWAP_BUDGET_SHAPES } from "./boardDetail";
import { frameBounds, placeNewFrame } from "./boardLayout";
import { frameGraph } from "./boardLayout";
import { boardFrameId, createBoardScene, LIVE_ANCHOR_ID } from "./boardScene";
import { SKETCH_LAYER_ID } from "./sketches";

const heapUsed = () => (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;

const bigLayout = () => bigBoardLayout();

const KEYS = Array.from({ length: FRAMES }, (_, k) => `Area ${k}`);

test("a_50_frame_board_builds_under_100ms", () => {
  const r = createFlowService().parse("board", board());
  const b = bigLayout();
  let out = createBoardScene("modern").build(r.frames, b, KEYS, null, null, []);
  const median = bestMedian(() => {
    out = createBoardScene("modern").build(r.frames, b, KEYS, null, null, []);
  }, 3, 5);
  expect(out.boxes).toHaveLength(FRAMES);
  // 10,000 shapes (nodes and group areas) and their 50 frame boxes; 15,000 links.
  expect(out.nodes).toHaveLength(10_000 + FRAMES);
  expect(out.edges).toHaveLength(15_000);
  expect(median).toBeLessThan(100);
});

test("a_keystroke_rebuilds_one_frame_under_10ms", () => {
  const svc = createFlowService();
  const b = bigLayout();
  const scene = createBoardScene("modern");
  const seed = scene.build(svc.parse("board", board()).frames, b, KEYS, null, null, []);
  const results = Array.from({ length: 60 }, (_, run) => svc.parse("board", board(` typed ${run}`)));
  let last = seed;
  const median = bestMedian((run) => {
    last = scene.build(results[run].frames, b, KEYS, null, null, []);
  });
  // Every frame but the typed one returns the very node and edge objects.
  const byId = new Map(seed.nodes.map((n) => [n.id, n]));
  const typed = `\u0000in:Area ${TYPED_FRAME}\u0000`;
  for (const n of last.nodes) {
    if (n.id.startsWith(typed) || n.id === boardFrameId(`Area ${TYPED_FRAME}`)) continue;
    if (n.id.startsWith("\u0000in:")) expect(n).toBe(byId.get(n.id));
  }
  // And the other 49 frames' box nodes.
  for (let k = 0; k < FRAMES; k++) {
    if (k === TYPED_FRAME) continue;
    expect(last.nodes.find((n) => n.id === boardFrameId(`Area ${k}`))).toBe(byId.get(boardFrameId(`Area ${k}`)));
  }
  const edgeById = new Map(seed.edges.map((e) => [e.id, e]));
  for (const e of last.edges) if (!e.id.startsWith(typed)) expect(e).toBe(edgeById.get(e.id));
  expect(last.edges.some((e) => e.id.startsWith(typed) && e !== edgeById.get(e.id))).toBe(true);
  expect(median).toBeLessThan(10);
});

test("rebuilding_does_not_grow_the_heap", () => {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  expect(typeof gc).toBe("function");
  const svc = createFlowService();
  const b = bigLayout();
  // Two texts, so each rebuild makes frame 25 anew; the live frame moves between two frames too.
  const results = [svc.parse("board", board(" a")), svc.parse("board", board(" b"))];
  const scene = createBoardScene("modern");
  const rebuild = (run: number) => {
    const r = results[run % 2];
    const at = run % 3 === 0 ? null : (run % 3) + 10;
    scene.build(r.frames, b, KEYS, at === null ? null : { title: `Area ${at}`, index: at }, at === null ? null : { nodes: [] }, []);
  };
  for (let run = 0; run < 10; run++) rebuild(run);
  gc!();
  const after10 = heapUsed();
  for (let run = 10; run < 200; run++) rebuild(run);
  gc!();
  const after200 = heapUsed();
  expect(after200 - after10).toBeLessThan(2 * 1024 * 1024);
});

test("rebuilding_with_a_title_typed_letter_by_letter_does_not_grow_the_heap", () => {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  expect(typeof gc).toBe("function");
  const r = createFlowService().parse("board", board());
  const b = bigLayout();
  const scene = createBoardScene("modern");
  // Frame 10's key changes on every build, as a title typed letter by letter re-keys it: the gone keys leave both memos.
  const rebuild = (run: number) => {
    const keys = KEYS.slice();
    keys[10] = `Area 10 ${"x".repeat(run % 40)}${run}`;
    scene.build(r.frames, b, keys, null, null, []);
  };
  for (let run = 0; run < 10; run++) rebuild(run);
  gc!();
  const after10 = heapUsed();
  for (let run = 10; run < 200; run++) rebuild(run);
  gc!();
  expect(heapUsed() - after10).toBeLessThan(2 * 1024 * 1024);
  expect(scene.memoSize()).toBe(FRAMES);
  expect(scene.boxMemoSize()).toBe(FRAMES);
});

test("placing_frame_50_on_a_full_board_under_16ms", () => {
  // useFlowDoc's placement: every placed frame's box (frameBoxes), then the new frame beside them. Each placement
  // measures every frame again, so a frame's box must not cost a graph build while its entry and doc are the same.
  const r = createFlowService().parse("board", board());
  const b = bigLayout();
  const boxes = () => r.frames.slice(0, FRAMES - 1).map((f, k) => frameBounds(b.frames.get(`Area ${k}`)!, f.doc, "modern"));
  const first = placeNewFrame(boxes());
  let at = first;
  const median = bestMedian(() => {
    at = placeNewFrame(boxes());
  });
  expect(at).toEqual(first);
  expect(at.x).toBeGreaterThan((FRAMES - 2) * 5200);
  expect(median).toBeLessThan(16);
});

test("a_band_shift_of_49_static_frames_builds_no_graph_under_10ms", () => {
  // Frame 0 deleted: every other static frame is drawn one place earlier, so its z band moves. Its shapes
  // and lines are the same; only their z changes, so no frame's graph is built again (18.6 ms when it was).
  const svc = createFlowService();
  const r = svc.parse("board", board());
  const b = bigLayout();
  const shifted = r.frames.slice(1);
  const scene = createBoardScene("modern");
  let out = scene.build(r.frames, b, KEYS, null, null, []);
  let flip = false;
  const median = bestMedian(() => {
    flip = !flip;
    out = flip ? scene.build(shifted, b, KEYS.slice(1), null, null, []) : scene.build(r.frames, b, KEYS, null, null, []);
  }, 3, 6);
  expect(out.boxes).toHaveLength(FRAMES);
  const moved = scene.build(shifted, b, KEYS.slice(1), null, null, []);
  const frame1 = moved.nodes.filter((n) => n.parentId === boardFrameId("Area 1"));
  expect(frame1.length).toBe(200);
  for (const n of frame1) expect(n.zIndex! >= 1 && n.zIndex! <= 29).toBe(true);
  // The very nodes and lines a scene built fresh for the shifted board makes: only z moved, nothing stale.
  const fresh = createBoardScene("modern").build(shifted, b, KEYS.slice(1), null, null, []);
  expect(moved.nodes).toEqual(fresh.nodes);
  expect(moved.edges).toEqual(fresh.edges);
  console.log(`band shift of 49 static frames: median ${median.toFixed(1)} ms`);
  expect(median).toBeLessThan(10);
});

test("a_switch_rebuilds_two_frames_under_2ms", () => {
  // The limit board with its 1,000 sketches. A switch moves only
  // the live anchor and the two frames' boxes; the sketch layer, every sketch and the other 48 frames are the very same.
  const r = createFlowService().parse("board", board());
  const b = bigBoardLayout(fullSketches());
  const live = [3, 30].map((k) => {
    const e = b.frames.get(`Area ${k}`)!;
    return { sel: { title: r.frames[k].title, index: k }, nodes: { nodes: frameGraph(e, r.frames[k].doc!, e.style ?? "modern").nodes } };
  });
  const scene = createBoardScene("modern");
  const first = scene.build(r.frames, b, KEYS, live[0].sel, live[0].nodes, []);
  let out = first;
  const median = bestMedian((run) => {
    const l = live[(run + 1) % 2];
    out = scene.build(r.frames, b, KEYS, l.sel, l.nodes, []);
  }, 3, 20);
  const other = scene.build(r.frames, b, KEYS, live[1].sel, live[1].nodes, []);
  const back = scene.build(r.frames, b, KEYS, live[0].sel, live[0].nodes, []);
  // Each node as last handed over: Area 30's children from when it was last static, the rest from the switch before.
  const was = new Map([...first.nodes, ...other.nodes].map((n) => [n.id, n]));
  const fresh = back.nodes.filter((n) => n !== was.get(n.id)).map((n) => n.id);
  // Area 3's box (live again) and Area 30's (static again, its children kept from before), and the anchor.
  expect(fresh.sort()).toEqual([LIVE_ANCHOR_ID, boardFrameId("Area 3"), boardFrameId("Area 30")].sort());
  expect(back.nodes.find((n) => n.id === SKETCH_LAYER_ID)).toBe(first.nodes.find((n) => n.id === SKETCH_LAYER_ID));
  expect(out.boxes).toHaveLength(FRAMES);
  console.log(`a switch on the limit board: median ${median.toFixed(2)} ms`);
  // 0.27 to 0.32 ms measured; lowered from the provisional 5 ms.
  expect(median).toBeLessThan(2);
});

// ----- Frames outside the view are not drawn. Thresholds set in Task 9.

const VIEW_W = 1600;
const VIEW_H = 1000;

/** The plan and its drawn forms for a 100 percent view at `x`, stepped until they are the plan (`parts`: shapes and lines). */
function drawnAt(frames: readonly import("./boardScene").FrameBox[], shapes: number[], parts: number[], x: number, from: DrawnForms) {
  const view = { x, y: 0, w: VIEW_W, h: VIEW_H, zoom: 1 };
  const plan = frameDraw({ boxes: frames, sizes: frames.map(() => "m" as const), shapes, live: null, dragging: null, dragForm: null, view, wasFar: new Set() });
  const centres = frames.map((b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 }));
  let d = from;
  for (let i = 0; i < 100; i++) {
    const next = stepForms(plan, d, () => true, parts, centres, { x: x + VIEW_W / 2, y: VIEW_H / 2 }, SWAP_BUDGET_SHAPES);
    if (next.mounted.size === 0 && next.form.size === d.form.size && [...next.form].every(([k, f]) => d.form.get(k) === f)) return next;
    d = next;
  }
  return d;
}

test("a_view_crossing_step_builds_under_1ms", () => {
  // The limit board at 100 percent: a pan brings a frame into view, and one budgeted step mounts its first shapes.
  const r = createFlowService().parse("board", board());
  const b = bigLayout();
  const scene = createBoardScene("modern");
  const all = scene.build(r.frames, b, KEYS, null, null, []);
  const shapes = r.frames.map((_, k) => all.children.get(boardFrameId(`Area ${k}`))!.length);
  const parts = r.frames.map((_, k) => shapes[k] + all.lines.get(boardFrameId(`Area ${k}`))!);
  const before = drawnAt(all.boxes, shapes, parts, 0, { form: new Map(), mounted: new Map() });
  const step: DrawnForms = { form: before.form, mounted: new Map([[before.form.size, SWAP_BUDGET_SHAPES]]) };
  let out = scene.build(r.frames, b, KEYS, null, null, [], undefined, before);
  const median = bestMedian((run) => {
    out = scene.build(r.frames, b, KEYS, null, null, [], undefined, run % 2 ? before : step);
  }, 3, 20);
  out = scene.build(r.frames, b, KEYS, null, null, [], undefined, step);
  expect(out.nodes.filter((n) => n.parentId === boardFrameId(`Area ${before.form.size}`))).toHaveLength(SWAP_BUDGET_SHAPES);
  // Only the frames in view are drawn: far fewer than the board's 10,000 shapes.
  expect(out.nodes.length).toBeLessThan(FRAMES + (before.form.size + 1) * 200);
  console.log(`a view crossing step on the limit board: median ${median.toFixed(2)} ms`);
  // 0.05 to 0.06 ms measured; lowered from the provisional 10 ms.
  expect(median).toBeLessThan(1);
});

test("hidden_frames_make_no_new_objects", () => {
  // 50 pans across the limit board, each planned, stepped and built: frames leaving and coming back reuse their
  // children, so nothing is retained past the pans.
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  expect(typeof gc).toBe("function");
  const r = createFlowService().parse("board", board());
  const b = bigLayout();
  const scene = createBoardScene("modern");
  const all = scene.build(r.frames, b, KEYS, null, null, []);
  const shapes = r.frames.map((_, k) => all.children.get(boardFrameId(`Area ${k}`))!.length);
  const parts = r.frames.map((_, k) => shapes[k] + all.lines.get(boardFrameId(`Area ${k}`))!);
  const span = all.boxes[FRAMES - 1].x + all.boxes[FRAMES - 1].w;
  let d: DrawnForms = { form: new Map(), mounted: new Map() };
  const pan = (run: number) => {
    d = drawnAt(all.boxes, shapes, parts, ((run * 7919) % 50) * (span / 50), d);
    scene.build(r.frames, b, KEYS, null, null, [], undefined, d);
  };
  for (let run = 0; run < 10; run++) pan(run);
  gc!();
  const after10 = heapUsed();
  for (let run = 10; run < 60; run++) pan(run);
  gc!();
  expect(heapUsed() - after10).toBeLessThan(2 * 1024 * 1024);
  expect(scene.memoSize()).toBe(FRAMES);
});

test("a_review_across_ten_frames_rebuilds_only_those", () => {
  // Ten frames under review, each with two new shapes, a new line and a relabelled one. Every build
  // takes new review objects (as each accept or reject makes), so the ten are drawn again each time; the other 40
  // frames hand back the very node and line objects.
  const svc = createFlowService();
  const r = svc.parse("board", board());
  const b = bigLayout();
  const touched = Array.from({ length: 10 }, (_, j) => j * 5 + 2);
  const reviewFor = (k: number, tag: string): FrameReview => {
    const after = frame(k).replace("Step 0 > Step 1: go 0", `Step 0 > Step 1: go 0 ${tag}`) + `New ${tag} a\nNew ${tag} b\nStep 3 > New ${tag} a\n`;
    const o = reviewOverlay(r.frames[k].doc!, svc.parse("one", after).frames[0].doc!);
    return { ...o, count: 4, isNew: false };
  };
  const reviews = ["x", "y"].map((tag) => () => new Map(touched.map((k) => [`Area ${k}`, reviewFor(k, tag)])));
  const scene = createBoardScene("modern");
  const seed = scene.build(r.frames, b, KEYS, null, null, []);
  let out = seed;
  let run = 0;
  const maps = Array.from({ length: 40 }, (_, i) => reviews[i % 2]());
  const median = bestMedian(() => {
    out = scene.build(r.frames, b, KEYS, null, null, [], undefined, null, undefined, null, maps[run++ % maps.length]);
  }, 3, 6);
  const under = new Set(touched.map((k) => `Area ${k}`));
  const nodeById = new Map(seed.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(seed.edges.map((e) => [e.id, e]));
  let kept = 0;
  for (let k = 0; k < FRAMES; k++) {
    const key = `Area ${k}`;
    const kids = out.nodes.filter((n) => n.parentId === boardFrameId(key));
    if (under.has(key)) {
      expect(kids.length).toBe(202);
      expect(kids.filter((n) => (n.data as { state?: string }).state === "suggested")).toHaveLength(2);
      continue;
    }
    for (const n of kids) expect(n).toBe(nodeById.get(n.id));
    expect(out.nodes.find((n) => n.id === boardFrameId(key))).toBe(nodeById.get(boardFrameId(key)));
    kept++;
  }
  expect(kept).toBe(40);
  for (const e of out.edges) {
    const key = /^\u0000in:(Area \d+)\u0000/.exec(e.id)?.[1];
    if (key && !under.has(key)) expect(e).toBe(edgeById.get(e.id));
  }
  console.log(`a review across ten frames: median ${median.toFixed(1)} ms`);
  expect(median).toBeLessThan(30);
});
