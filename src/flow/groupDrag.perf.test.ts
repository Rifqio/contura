import { expect, test } from "vitest";
import type { FlowDoc } from "../lang/flow/model";
import { buildFlowGraph } from "./flowNodes";
import { groupDragFrame, groupDropAt, startGroupDrag } from "./groupDrag";
import { emptyPositions } from "./layout";

// Allocation test: runs alone through `npm run test:perf`. Diagram step 9: a group with 200 shapes dragged by its title.
// A frame only writes numbers into one of the two records kept for the drag, and the drop check reads arrays built when
// the drag started, so the pointer moving leaves nothing behind beyond the canvas's own drag (memory is a requirement).

const heapUsed = () => (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;

/**
 * Bytes a call leaves on the heap; the least of three tries (as orderDrag.perf.test.ts). A frame that built its 211
 * entries afresh would leave 6 KB or more, so few calls are made: enough to measure, too few to start a collection.
 */
function bytesPerCall(make: (i: number) => unknown, n = 400): number {
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

test("a frame of a group drag with 200 shapes and 10 inner groups allocates nothing, and its memory is bounded", () => {
  const doc: FlowDoc = { kind: "flow", title: "Big", comments: [], nodes: [], links: [], groups: [] };
  const at = emptyPositions();
  const big = { name: "Big", nodes: [] as string[], groups: [] as FlowDoc["groups"] };
  for (let g = 0; g < 10; g++) {
    const names: string[] = [];
    for (let i = 0; i < 20; i++) {
      const name = `S${g}.${i}`;
      names.push(name);
      doc.nodes.push({ name, kind: "step", attrs: {} });
      at[name] = { x: (i % 5) * 200, y: g * 400 + Math.floor(i / 5) * 90 };
    }
    big.groups.push({ name: `Inner ${g}`, nodes: names, groups: [] });
  }
  doc.groups.push(big);
  // Other groups to be dropped into: 50 of them.
  for (let o = 0; o < 50; o++) {
    const name = `Other ${o}`;
    doc.nodes.push({ name, kind: "step", attrs: {} });
    at[name] = { x: 2000 + (o % 10) * 220, y: Math.floor(o / 10) * 200 };
    doc.groups.push({ name: `Box ${o}`, nodes: [name], groups: [] });
  }
  const graph = buildFlowGraph(doc, at, "modern");
  const drag = startGroupDrag("Big", doc.groups, graph.nodes)!;
  expect(drag.shapes).toBe(200);
  expect(drag.ids).toHaveLength(211);
  let hits = 0;
  // Down to the row of other groups, then along it.
  const dy = 60 - (drag.box.y + drag.box.h / 2);
  const bytes = bytesPerCall((i) => {
    const live = groupDragFrame(drag, i % 900, (i * 7) % 500);
    if (groupDropAt(drag, ((i * 37) % 3000) - 100, dy) >= 0) hits++;
    return live;
  });
  expect(hits).toBeGreaterThan(0);
  // Measuring noise is a few bytes a call; a frame that built its entries would leave over 6 KB.
  expect(bytes).toBeLessThan(64);
  // Bounded: the drag holds two records of its 211 entries, whatever the number of frames.
  expect(Object.keys(drag.bufs[0])).toHaveLength(211);
  expect(Object.keys(drag.bufs[1])).toHaveLength(211);
});
