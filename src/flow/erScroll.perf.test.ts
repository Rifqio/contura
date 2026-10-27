import type { Edge, Node } from "@xyflow/react";
import { expect, test } from "vitest";
import { bestMedian } from "../lang/flow/perfGate";
import { parseFlow } from "../lang/flow/parse";
import { createErScrollStore, type ErScrollStore } from "./erScroll";
import { buildFlowGraph, type FlowEdgeData, rowRoute } from "./flowNodes";
import { emptyPositions } from "./layout";

// B3 Task 5 at the board limit: an ERD frame of 2,000 tables of 20 columns with 2,000 column relationships, and a hub
// table with 500. The lines here are the ER edges' work without React: each subscribes to its own two cards, and a
// wake routes it at its rows with both cards' scroll (`rowRoute`), as `FlowEdge` does. Run alone through
// `npm run test:perf` (it needs --expose-gc).
const gc = () => (globalThis as unknown as { gc: () => void }).gc();
const heapUsed = () => (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;

const block = (t: string) => [`${t} {`, "  id int pk", ...Array.from({ length: 19 }, (_, c) => `  c${c + 1} int`), "}"];

/** The graph of `tables` tables of 20 columns, with `links(i)` the column relationships of table `i`. */
function graphOf(tables: string[], links: string[]) {
  const text = ['diagram er "Limit"', ...tables.flatMap(block), ...links, ""].join("\n");
  const r = parseFlow(text);
  expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
  const at = emptyPositions();
  tables.forEach((t, i) => (at[t] = { x: (i % 50) * 260, y: Math.floor(i / 50) * 520 }));
  return buildFlowGraph(r.doc!, at, "modern");
}

const rectOf = (n: Node) => ({ x: n.position.x, y: n.position.y, w: n.initialWidth ?? 0, h: n.initialHeight ?? 0 });

/** Every line subscribed to its two cards; a wake routes it, and counts the wake. */
function subscribeLines(store: ErScrollStore, graph: { nodes: Node[]; edges: Edge[] }) {
  const byId = new Map(graph.nodes.map((n) => [n.id, rectOf(n)]));
  const woken = new Map<string, number>();
  const sink = { y: 0 };
  const route = (e: Edge) => {
    const d = e.data as FlowEdgeData;
    const r = rowRoute(byId.get(e.source)!, byId.get(e.target)!, d.fromRow!, d.toRow ?? -1, e.source === e.target, store.get(e.source), store.get(e.target));
    sink.y += r.mid.y;
  };
  const offs: (() => void)[] = [];
  for (const e of graph.edges) {
    const wake = () => {
      woken.set(e.id, (woken.get(e.id) ?? 0) + 1);
      route(e);
    };
    offs.push(store.subscribe(e.source, wake));
    if (e.target !== e.source) offs.push(store.subscribe(e.target, wake));
  }
  return { woken, offs, sink };
}

const TABLES = Array.from({ length: 2000 }, (_, i) => `t${i}`);
// Each table refers to the next one's key: every table meets two lines.
const RING = TABLES.map((t, i) => `${t}.c1 > ${TABLES[(i + 1) % TABLES.length]}.id`);

test("scrolling_one_card_wakes_only_its_lines", () => {
  const graph = graphOf(TABLES, RING);
  expect(graph.edges.length).toBe(2000);
  expect(graph.edges.every((e) => (e.data as FlowEdgeData).fromRow === 1 && (e.data as FlowEdgeData).toRow === 0)).toBe(true);
  const store = createErScrollStore();
  const { woken } = subscribeLines(store, graph);
  const touching = graph.edges.filter((e) => e.source === "t700" || e.target === "t700").map((e) => e.id);
  expect(touching.length).toBe(2);
  expect(store.listeners("t700")).toBe(2);
  store.set("t700", 44);
  expect([...woken.keys()].sort()).toEqual([...touching].sort());
  for (const id of touching) expect(woken.get(id)).toBe(1);
  // The same top again wakes nothing.
  store.set("t700", 44);
  for (const id of touching) expect(woken.get(id)).toBe(1);
});

test("a_scroll_tick_routes_one_cards_lines_under_1ms", () => {
  const graph = graphOf(TABLES, RING);
  const store = createErScrollStore();
  subscribeLines(store, graph);
  // One wheel tick on one card: its top moves by 7 px and its two lines route again.
  const ms = bestMedian((run) => store.set("t700", 7 + (run % 60) * 7));
  expect(ms).toBeLessThan(1);
});

test("scrolling_a_hub_card_with_500_lines_routes_under_5ms", () => {
  const others = Array.from({ length: 500 }, (_, i) => `orders_${i}`);
  const graph = graphOf(["customers", ...others], others.map((t) => `${t}.c1 > customers.id`));
  const store = createErScrollStore();
  const { woken } = subscribeLines(store, graph);
  expect(store.listeners("customers")).toBe(500);
  const ms = bestMedian((run) => store.set("customers", 7 + (run % 60) * 7));
  expect(woken.size).toBe(500);
  expect(ms).toBeLessThan(5);
});

test("scrolled_cards_then_a_switch_leave_nothing", () => {
  const graph = graphOf(TABLES, RING);
  const store = createErScrollStore();
  const cycle = () => {
    const { offs } = subscribeLines(store, graph);
    for (const t of TABLES) store.set(t, 22 + (t.length % 7));
    expect(TABLES.every((t) => store.get(t) > 0)).toBe(true);
    // A parse that kept half the tables drops the rest; one that kept none, all of them.
    store.prune(new Set(TABLES.slice(0, 1000)));
    expect(TABLES.filter((t, i) => store.get(t) !== 0 && i >= 1000)).toEqual([]);
    store.prune(new Set());
    expect(TABLES.filter((t) => store.get(t) !== 0)).toEqual([]);
    for (const t of TABLES) store.set(t, 22);
    // The frame switch: every entry dropped.
    store.clear();
    expect(TABLES.filter((t) => store.get(t) !== 0)).toEqual([]);
    // The lines go with the frame.
    for (const off of offs) off();
    expect(TABLES.reduce((n, t) => n + store.listeners(t), 0)).toBe(0);
  };
  // The first pass warms the code paths, so the second measures growth, not the first fill.
  cycle();
  gc();
  const base = heapUsed();
  cycle();
  gc();
  expect(heapUsed() - base).toBeLessThan(1024 * 1024);
});

test("pruning_2000_tables_under_1ms", () => {
  const store = createErScrollStore();
  const keep = new Set(TABLES.slice(0, 1000));
  // A parse after 1,000 of 2,000 scrolled tables went: the refill is timed too, so the gate only errs high.
  const ms = bestMedian((run) => {
    for (const t of TABLES) store.set(t, 22 + (run % 5));
    store.prune(keep);
  });
  expect(ms).toBeLessThan(1);
  expect(TABLES.slice(1000).filter((t) => store.get(t) !== 0)).toEqual([]);
  store.prune(new Set());
  expect(TABLES.filter((t) => store.get(t) !== 0)).toEqual([]);
});
