import { expect, test } from "vitest";
import { bestMedian } from "../lang/flow/perfGate";
import { type Box, layoutGap, placeNext } from "./addNext";
import { addHereItems } from "./interactions/AddHere";
import { createHotStore } from "./interactions/HotHandles";

// Timing and allocation test: runs alone through `npm run test:perf`. Diagram step 6 at 2,000 shapes: the hover +
// handles are one small store the pointer moves (never per node), the "Add here" grid is the kind's fixed list, and
// placing the next shape looks only at the shapes near its source.
const boxes: Box[] = Array.from({ length: 2000 }, (_, i) => ({ x: (i % 50) * 200 + (i % 7), y: Math.floor(i / 50) * 140 + (i % 5), w: 120 + (i % 4) * 10, h: 48 }));

/** The heap in use (the perf run is Node's; the app's types do not name Node). */
const heapUsed = () => (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;

/** Bytes a call leaves on the heap, results kept alive; the least of three tries (as guides.perf.test.ts). */
function bytesPerCall(make: (i: number) => unknown, n = 20000): number {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  expect(typeof gc).toBe("function");
  let least = Number.POSITIVE_INFINITY;
  for (let t = 0; t < 3; t++) {
    const keep: unknown[] = new Array(n);
    gc!();
    const before = heapUsed();
    for (let i = 0; i < n; i++) keep[i] = make(i);
    least = Math.min(least, (heapUsed() - before) / n);
    expect(keep.length).toBe(n);
  }
  return least;
}

test("a pointer frame over a shape or the empty canvas allocates nothing for the + handles", () => {
  const hot = createHotStore();
  let seen = 0;
  hot.subscribe(() => seen++);
  // Moving within one shape: the same id each frame.
  hot.set("n7");
  const onShape = bytesPerCall(() => hot.set("n7"));
  // Moving over the empty canvas: one linger timer, not one per frame.
  const offShape = bytesPerCall(() => hot.leave());
  expect(onShape).toBeLessThan(8);
  expect(offShape).toBeLessThan(8);
  expect(seen).toBe(1);
  hot.set(null);
});

test("the Add here grid is the kind's fixed list: the same array each time, whatever the diagram holds", () => {
  const first = addHereItems("flow");
  expect(addHereItems("flow")).toBe(first);
  expect(bytesPerCall(() => addHereItems("flow"))).toBeLessThan(8);
});

test("placing the next shape among 2,000 takes under 5 ms", () => {
  const pairs = boxes.slice(0, 1999).map((b, i) => [b, boxes[i + 1]] as [Box, Box]);
  const gap = layoutGap(pairs, "v");
  let at = 0;
  const median = bestMedian((run) => {
    const src = boxes[(run * 37) % 2000];
    if (placeNext({ src, dir: (["t", "r", "b", "l"] as const)[run % 4], size: { w: 130, h: 48 }, gap, boxes })) at++;
  });
  expect(at).toBeGreaterThan(0);
  expect(median).toBeLessThan(5);
});
