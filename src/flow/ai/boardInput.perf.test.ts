// Plan D Task 6 timing and memory: the board request at the limit (50 frames, 10,000 shapes, 1,000 sketches): the
// worker's outline of every frame, the parts' boxes off the built scene, the sketch notes and the request itself.
// Run alone through `npm run test:perf`.
import { expect, test } from "vitest";
import { board, FRAMES } from "../../lang/flow/fixtures/bigBoard";
import { bigBoardLayout, fullSketches, SKETCH_COUNT } from "../../lang/flow/fixtures/bigBoardLayout";
import { bestMedian } from "../../lang/flow/perfGate";
import { createFlowService } from "../../lang/flow/service";
import { boardNodeBoxes, createBoardScene } from "../board/boardScene";
import { boardInput, onBoard, sketchNotes } from "./boardInput";

const heapUsed = () => (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;

const KEYS = Array.from({ length: FRAMES }, (_, k) => `Area ${k}`);

function setup() {
  const svc = createFlowService();
  const r = svc.parse("board", board());
  const layout = bigBoardLayout(fullSketches());
  const scene = createBoardScene("modern").build(r.frames, layout, KEYS, null, null, []);
  /** One board request, as the Ask makes it. */
  const request = () => {
    const o = svc.boardOutline("board", r.version);
    if (o.stale) throw new Error("expected the board's outline");
    const boxes = onBoard(scene);
    const notes = sketchNotes(layout.sketches, boxes, boardNodeBoxes(scene));
    return boardInput({
      frames: o.frames,
      boxes,
      focus: ["Area 3", "Area 0"],
      selected: { frame: "Area 3", shapes: ["Step 1"], sketches: ["s120"] },
      notes,
      create: null,
      followUp: null,
      attachment: null,
    });
  };
  return { request };
}

test("a_limit_board_request_builds_under_150ms", () => {
  const { request } = setup();
  let out = request();
  const median = bestMedian(() => {
    out = request();
  }, 3, 5);
  expect(out.frames).toHaveLength(FRAMES);
  expect(out.frames.reduce((n, f) => n + f.outline.nodes.length + f.outline.groups.length, 0)).toBe(10_000);
  // Every sketch but the 50 pen strokes and the empty shapes is read; some arrows point at shapes.
  expect(out.sketches.length).toBeGreaterThan(0);
  expect(out.sketches.length).toBeLessThan(SKETCH_COUNT);
  expect(out.sketches.some((s) => s.pointsAt !== null)).toBe(true);
  expect(median).toBeLessThan(150);
});

test("twenty_requests_do_not_grow_the_heap", () => {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  expect(typeof gc).toBe("function");
  const { request } = setup();
  let size = 0;
  for (let i = 0; i < 3; i++) size += request().frames.length;
  gc!();
  const before = heapUsed();
  for (let i = 0; i < 20; i++) size += request().frames.length;
  gc!();
  const after = heapUsed();
  expect(size).toBe(23 * FRAMES);
  expect(after - before).toBeLessThan(2 * 1024 * 1024);
});
