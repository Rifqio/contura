import { expect, test } from "vitest";
import { bestMedian } from "../lang/flow/perfGate";
import { GuideIndex } from "./guides";
import { routeOrthogonal, routeRows } from "./route";
import { buildFlowGraph, type FlowEdgeData, rowRoute } from "../flow/flowNodes";
import { erRowY } from "../flow/kindLayout";

// Timing test: runs alone through `npm run test:perf`. A drag on a 2,000-shape ER canvas: the index is built once from
// every shape (the worst case, all on screen), then each frame snaps the dragged box. Best of three 20-run medians.
const boxes = Array.from({ length: 2000 }, (_, i) => ({ x: (i % 50) * 260 + (i % 7), y: Math.floor(i / 50) * 180 + (i % 5), w: 184 + (i % 9) * 8, h: 84 + (i % 6) * 22 }));

test("guides_index_for_2000_shapes_under_16ms", () => {
  expect(bestMedian(() => void new GuideIndex(boxes))).toBeLessThan(16);
});

test("a_guides_frame_at_2000_shapes_under_1ms", () => {
  const g = new GuideIndex(boxes);
  let hits = 0;
  const median = bestMedian((run) => {
    for (let k = 0; k < 10; k++) {
      const s = g.snap({ x: (run * 37 + k * 113) % 12000, y: (run * 53 + k * 71) % 7000, w: 200, h: 120 }, 6);
      if (s.lines.length) hits++;
    }
  });
  expect(hits).toBeGreaterThan(0);
  // Ten frames per run.
  expect(median / 10).toBeLessThan(1);
});

// ER build C: relationships between columns at 2,000 tables. Each line's rows are worked out once, when the graph
// is built, as plain numbers on the line; a frame only does arithmetic on them, so meeting a card at a row costs
// what meeting it at its middle did, and a card at rest has no column ports at all (erRelationships.test.tsx).
const tables = Array.from({ length: 2000 }, (_, i) => ({
  name: `t${i}`,
  kind: "entity" as const,
  attrs: {},
  rows: ["id int", `t${(i + 1) % 2000}_id int`, "note text"],
  rowFlags: [["pk" as const], [], []],
}));
const relDoc = {
  kind: "er" as const,
  title: "perf",
  comments: [],
  nodes: tables,
  links: tables.map((t, i) => ({ from: t.name, fromColumn: `t${(i + 1) % 2000}_id`, to: `t${(i + 1) % 2000}`, toColumn: "id", arrow: ">" as const })),
  groups: [],
};
const relPositions = Object.fromEntries(boxes.map((b, i) => [`t${i}`, { x: b.x, y: b.y }]));

test("rows_for_2000_column_relationships_are_worked_out_once_with_the_graph_under_40ms", () => {
  const g = buildFlowGraph(relDoc, relPositions, "modern");
  // Plain numbers on each line: nothing for a frame to look up or build.
  expect(g.edges).toHaveLength(2000);
  expect(g.edges.every((e) => (e.data as FlowEdgeData).fromRow === 1 && (e.data as FlowEdgeData).toRow === 0)).toBe(true);
  expect(bestMedian(() => void buildFlowGraph(relDoc, relPositions, "modern"), 3, 10)).toBeLessThan(40);
});

test("a_frame_of_2000_lines_at_their_rows_costs_no_more_than_at_their_middles", () => {
  const rects = boxes.map((b) => ({ ...b }));
  const next = (i: number) => rects[(i + 1) % rects.length];
  const byRow = bestMedian(() => {
    for (let i = 0; i < rects.length; i++) {
      const a = rects[i];
      const b = next(i);
      routeRows(a, erRowY(a.y, a.h, 1), b, erRowY(b.y, b.h, 0));
    }
  });
  const byMiddle = bestMedian(() => {
    for (let i = 0; i < rects.length; i++) routeOrthogonal(rects[i], next(i));
  });
  expect(byRow).toBeLessThan(Math.max(byMiddle * 1.5, 2));
  expect(byRow).toBeLessThan(8);
});

/** The heap in use (the perf run is Node's; the app's types do not name Node). */
const heapUsed = () => (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;

/**
 * Bytes a call leaves on the heap, each result kept alive so nothing is collected mid-count: the heap after a
 * collection, then after `n` calls (fix round 2, M9). The least of three tries.
 */
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

test("a_line_at_its_rows_allocates_per_frame_what_a_line_at_its_middles_does", () => {
  // The edge's own work each frame: its route between the two cards, at their rows (rowRoute, as FlowEdge calls
  // it) or at their middles (routeOrthogonal). The rows are numbers on the line, worked out with the graph.
  const rects = boxes.map((b) => ({ ...b }));
  const next = (i: number) => rects[(i + 1) % rects.length];
  const atRows = bytesPerCall((i) => rowRoute(rects[i % 2000], next(i % 2000), 1, 0, false, 0, 22));
  const atMiddles = bytesPerCall((i) => routeOrthogonal(rects[i % 2000], next(i % 2000)));
  expect(atRows).toBeLessThanOrEqual(atMiddles * 1.15 + 16);
});
