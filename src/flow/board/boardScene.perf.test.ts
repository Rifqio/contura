// Task 5 timing and memory: the board scene at the limit (A5's board: 50 frames, 10,000 shapes, 15,000 links).
// Run alone through `npm run test:perf`.
import { expect, test } from "vitest";
import { board, FRAMES, TYPED_FRAME } from "../../lang/flow/fixtures/bigBoard";
import { bigBoardLayout } from "../../lang/flow/fixtures/bigBoardLayout";
import { bestMedian } from "../../lang/flow/perfGate";
import { createFlowService } from "../../lang/flow/service";
import { frameBounds, placeNewFrame } from "./boardLayout";
import { boardFrameId, createBoardScene } from "./boardScene";

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
  // Frame 0 deleted: every other static frame is drawn one place earlier, so its z band moves (Decision 5). Its shapes
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
