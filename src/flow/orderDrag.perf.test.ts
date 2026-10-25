import { expect, test } from "vitest";
import { createOrderDragStore, laneIndex, nearestIndex, topicDropAt, topicIndex, type TopicDrop } from "./orderDrag";

// Allocation test: runs alone through `npm run test:perf`. Diagram steps 7 and 8 at 2,000 shapes: a frame of a topic or
// message drag only reads arrays built when the drag started and writes into one result kept for the whole drag, so
// the pointer moving leaves nothing behind (memory is a requirement).

/** The heap in use (the perf run is Node's; the app's types do not name Node). */
const heapUsed = () => (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;

/** Bytes a call leaves on the heap; the least of three tries (as addNext.perf.test.ts). */
function bytesPerCall(make: (i: number) => unknown, n = 20000): number {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  expect(typeof gc).toBe("function");
  let least = Number.POSITIVE_INFINITY;
  for (let t = 0; t < 3; t++) {
    gc!();
    const before = heapUsed();
    for (let i = 0; i < n; i++) make(i);
    least = Math.min(least, (heapUsed() - before) / n);
  }
  return least;
}

// A central idea with 40 topics of 49 subtopics each: 1,961 topics.
const topics: { name: string; parent: string | null; box: { x: number; y: number; w: number; h: number } }[] = [{ name: "Root", parent: null, box: { x: 0, y: 0, w: 120, h: 44 } }];
for (let t = 0; t < 40; t++) {
  const side = t < 20 ? 1 : -1;
  const y = (t % 20) * 49 * 30;
  topics.push({ name: `T${t}`, parent: "Root", box: { x: side * 200, y, w: 100, h: 32 } });
  for (let s = 0; s < 49; s++) topics.push({ name: `T${t}.${s}`, parent: `T${t}`, box: { x: side * 400, y: y + s * 30, w: 100, h: 28 } });
}

test("a frame of a topic drag over 2,000 topics allocates nothing", () => {
  const ix = topicIndex(topics, "T3");
  const out: TopicDrop = { kind: 0, ref: -1, x1: 0, x2: 0, y: 0 };
  let hits = 0;
  const bytes = bytesPerCall((i) => {
    topicDropAt(ix, (i % 900) - 450, (i * 7) % 29000, out);
    if (out.kind !== 0) hits++;
  });
  expect(hits).toBeGreaterThan(0);
  expect(bytes).toBeLessThan(8);
});

test("a frame of a message or participant drag over 2,000 rows allocates nothing", () => {
  const slots = laneIndex(Array.from({ length: 2001 }, (_, i) => 100 + i * 44));
  let sum = 0;
  const bytes = bytesPerCall((i) => {
    sum += nearestIndex(slots, (i * 13) % 90000);
  });
  expect(sum).toBeGreaterThan(0);
  expect(bytes).toBeLessThan(8);
});

test("the drag store moves without allocating while its target stays the same, and tells only when it changes", () => {
  const store = createOrderDragStore();
  let told = 0;
  store.subscribe(() => told++);
  store.begin("topic");
  store.target(1, 4, 0, 100, 50);
  told = 0;
  const bytes = bytesPerCall((i) => {
    store.pointer(i % 300, i % 200);
    store.target(1, 4, 0, 100, 50);
  });
  expect(bytes).toBeLessThan(8);
  expect(told).toBe(0);
  store.target(2, 4, 0, 100, 50);
  expect(told).toBe(1);
});

test("fix round 1: a drawn message's frame allocates nothing, and the branch dots of 2,000 topics take under 5 ms", async () => {
  const { drawAt, foldDotsOf } = await import("./orderDrag");
  const store = createOrderDragStore();
  store.begin("draw");
  const lane = laneIndex(Array.from({ length: 50 }, (_, i) => i * 200));
  let hit = 0;
  expect(bytesPerCall((i) => {
    if (drawAt(store, lane, 3, (i * 7) % 10000, 40, 300) >= 0) hit++;
  })).toBeLessThan(8);
  expect(hit).toBeGreaterThan(0);
  // A central idea with 2,000 topics under it, and a chain 2,000 deep.
  const star = Array.from({ length: 2000 }, (_, i) => ({ from: "Root", to: `T${i}`, tree: true }));
  const chain = Array.from({ length: 2000 }, (_, i) => ({ from: i === 0 ? "Root" : `C${i - 1}`, to: `C${i}`, tree: true }));
  const b = { x: 1, y: 1, w: 10, h: 10 };
  for (const links of [star, chain]) {
    const t0 = performance.now();
    foldDotsOf(links, () => b, "Root", new Set());
    expect(performance.now() - t0).toBeLessThan(5);
  }
});
