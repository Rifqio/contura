// B3 Task 11: the ERD at the board limit. 40 flowchart frames of A5's board (fixtures/bigBoard.ts, 200 shapes each)
// and one ERD of 2,000 tables of 20 columns with 2,000 column relationships: exactly 10,000 shapes. A column edit's
// worker round trip, the scene rebuilt after it, the graph rebuilt when a draft row opens and closes (Task 10), the
// type list read from the live frame (Task 3), and the two ER stores under churn. Run alone through
// `npm run test:perf` (it needs --expose-gc). Every budget is provisional until Task 13 measures it in the release
// build, and is never raised.
import { expect, test } from "vitest";
import { frame } from "../lang/flow/fixtures/bigBoard";
import { bigBoardLayout } from "../lang/flow/fixtures/bigBoardLayout";
import { type FlowDoc, MAX_BOARD_SHAPES } from "../lang/flow/model";
import { bestMedian } from "../lang/flow/perfGate";
import { MESSAGES } from "../lang/flow/problems";
import { applyEdits, createFlowService, type FlowResult } from "../lang/flow/service";
import { docsById, fromWire, toWire } from "../lang/flow/wire";
import { type BoardLayout } from "./board/boardLayout";
import { boardFrameId, createBoardScene } from "./board/boardScene";
import { createErStore, ER_TYPES, erTypesOf } from "./erCanvas";
import { createErScrollStore } from "./erScroll";
import { buildFlowGraph } from "./flowNodes";

const gc = () => (globalThis as unknown as { gc: () => void }).gc();
const heapUsed = () => (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;

const FLOW_FRAMES = 40;
const ER_INDEX = FLOW_FRAMES;
const TABLES = Array.from({ length: 2000 }, (_, i) => `t${i}`);
const block = (t: string) => [`${t} {`, "  id int pk", ...Array.from({ length: 19 }, (_, c) => `  c${c + 1} int`), "}"];
// Each table refers to the next one's key: 2,000 column relationships, every table meeting two lines.
const RING = TABLES.map((t, i) => `${t}.c1 > ${TABLES[(i + 1) % TABLES.length]}.id`);
const ERD = ['diagram er "Schema"', ...TABLES.flatMap(block), "", ...RING, ""].join("\n");
const TEXT = `${Array.from({ length: FLOW_FRAMES }, (_, k) => `${frame(k)}\n`).join("")}${ERD}`;
const KEYS = [...Array.from({ length: FLOW_FRAMES }, (_, k) => `Area ${k}`), "Schema"];
const SCHEMA = { title: "Schema", index: ER_INDEX };

/** The board's layout: A5's first 40 frames, and the ERD's 2,000 cards on a grid to their right. */
function layout(): BoardLayout {
  const b = bigBoardLayout();
  for (let k = FLOW_FRAMES; k < 50; k++) b.frames.delete(`Area ${k}`);
  b.frames.set("Schema", { at: { x: FLOW_FRAMES * 5200, y: 0 }, nodes: positions(), style: "modern", direction: "TB" });
  return b;
}

function positions(): Record<string, { x: number; y: number }> {
  const at = Object.create(null) as Record<string, { x: number; y: number }>;
  TABLES.forEach((t, i) => (at[t] = { x: (i % 50) * 260, y: Math.floor(i / 50) * 520 }));
  return at;
}

/** One column edit of table `n` as the card sends it: its 6th column's type. */
const setType = (n: number, type: string) => ({ op: "setColumn" as const, table: `t${n}`, index: 5, column: "c5", type });

const shapesOf = (r: FlowResult) => r.frames.reduce((n, f) => n + (f.doc?.nodes.length ?? 0) + (f.doc?.groups.length ?? 0), 0);

test("the_fixture_is_at_the_limit_not_over", () => {
  const r = createFlowService().parse("board", TEXT);
  expect(r.frames).toHaveLength(FLOW_FRAMES + 1);
  expect(r.frames[ER_INDEX]).toMatchObject({ kind: "er", title: "Schema" });
  const erd = r.frames[ER_INDEX].doc!;
  expect(erd.nodes).toHaveLength(2000);
  expect(erd.nodes.every((n) => n.rows?.length === 20)).toBe(true);
  expect(erd.links.filter((l) => l.fromColumn && l.toColumn)).toHaveLength(2000);
  expect(shapesOf(r)).toBe(MAX_BOARD_SHAPES);
  expect(r.problems.filter((p) => p.message === MESSAGES.tooManyShapes)).toEqual([]);
  expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
});

test("a_column_edit_worker_round_trip_under_150ms", () => {
  // 3 x 10 runs: at the 150 ms budget, 30 runs and the setup take about 4.85 s, so a regression near the budget may fail
  // as the 5 s test timeout rather than the assertion. That is this gate firing; timeouts are never raised (ADR 0003).
  // The worker's side (the edit on its cached parse, the text it gives, the re-parse of that text) and the post to the
  // editor (`toWire`, the structured clone postMessage makes, `fromWire` merging it with the docs it holds).
  const svc = createFlowService();
  const sent = new Set<number>();
  const held = new Map<number, FlowDoc>();
  let text = TEXT;
  let r = svc.parse("board", text);
  const merge = (result: FlowResult) => {
    const back = fromWire(structuredClone(toWire(result, sent)), held);
    held.clear();
    for (const [k, v] of docsById(back)) held.set(k, v);
    return back;
  };
  let merged = merge(r);
  const seed = merged;
  const median = bestMedian((run) => {
    const a = svc.edit("board", r.version, setType((run * 97) % 2000, "bigint"), ER_INDEX);
    if (a.stale || a.edits.length === 0) throw new Error("the column edit was refused");
    text = applyEdits(text, a.edits);
    r = svc.parse("board", text);
    merged = merge(r);
  }, 3, 10);
  // Only the ERD was parsed again and sent; the 40 other frames are the very docs the editor held.
  expect(merged.frames[ER_INDEX].doc!.nodes.find((n) => n.name === `t${(29 * 97) % 2000}`)!.rows![5]).toBe("c5 bigint");
  for (let k = 0; k < FLOW_FRAMES; k++) expect(merged.frames[k].doc, `frame ${k}`).toBe(seed.frames[k].doc);
  console.log(`column edit round trip at the limit: median ${median.toFixed(1)} ms`);
  expect(median).toBeLessThan(150);
});

test("a_column_edit_rebuilds_the_scene_under_10ms", () => {
  // The ERD is the live frame, so the scene rebuilds its box from the live nodes and keeps every static frame's.
  const svc = createFlowService();
  const b = layout();
  const r0 = svc.parse("board", TEXT);
  const a = svc.edit("board", r0.version, setType(700, "bigint"), ER_INDEX);
  if (a.stale) throw new Error("stale");
  const r1 = svc.parse("board", applyEdits(TEXT, a.edits));
  const back = svc.parse("board", TEXT);
  const at = positions();
  const live = [r0, r1].map((r) => ({ nodes: buildFlowGraph(r.frames[ER_INDEX].doc!, at, "modern").nodes }));
  const scene = createBoardScene("modern");
  const seed = scene.build(r0.frames, b, KEYS, SCHEMA, live[0], []);
  const results = [r1, back];
  let last = seed;
  const median = bestMedian((run) => {
    last = scene.build(results[run % 2].frames, b, KEYS, SCHEMA, live[(run + 1) % 2], []);
  });
  expect(last.live?.title).toBe("Schema");
  // Every other frame's node and line objects are the very ones the first build made.
  const byId = new Map(seed.nodes.map((n) => [n.id, n]));
  expect(last.nodes.length).toBe(seed.nodes.length);
  for (const n of last.nodes) if (n.id !== boardFrameId("Schema")) expect(n, n.id).toBe(byId.get(n.id));
  const edgeById = new Map(seed.edges.map((e) => [e.id, e]));
  for (const e of last.edges) expect(e).toBe(edgeById.get(e.id));
  console.log(`scene rebuild after a column edit: median ${median.toFixed(2)} ms`);
  expect(median).toBeLessThan(10);
});

test("a_draft_row_opening_or_closing_rebuilds_the_graph_under_10ms", () => {
  // Task 10: a draft row grows its card by one row, so FlowTab builds the live graph once when it opens and once when
  // it closes. Each is one gesture's main-thread rebuild, so it has the scene rebuild's budget.
  const doc = createFlowService().parse("board", TEXT).frames[ER_INDEX].doc!;
  const at = positions();
  const plain = buildFlowGraph(doc, at, "modern", { sizes: {} });
  const grown = buildFlowGraph(doc, at, "modern", { sizes: {}, grow: { t700: 1 } });
  // A card of 20 rows is at its tallest, so the draft row scrolls in it; the card still eases as growing.
  expect(grown.nodes.find((n) => n.id === "t700")!.style?.transition).toBeDefined();
  expect(grown.nodes.filter((n) => n.style?.transition)).toHaveLength(1);
  expect(plain.nodes.filter((n) => n.style?.transition)).toHaveLength(0);
  const median = bestMedian((run) => void buildFlowGraph(doc, at, "modern", run % 2 ? { sizes: {} } : { sizes: {}, grow: { t700: 1 } }), 3, 10);
  console.log(`graph rebuild for a draft row open or close at 2,000 tables: median ${median.toFixed(1)} ms`);
  expect(median).toBeLessThan(10);
});

test("the_type_list_of_2000_tables_of_20_columns_under_5ms", () => {
  // Read once per parse of the live ERD (FlowTab's datalist): the common types, then the ones the frame uses. It runs
  // in the same frame as the graph and scene rebuilds after a parse, so it takes half their 10 ms.
  const doc = createFlowService().parse("board", TEXT.replace("  c3 int\n", "  c3 money\n")).frames[ER_INDEX].doc!;
  const types = erTypesOf(doc.nodes);
  expect(types.slice(0, ER_TYPES.length)).toEqual(ER_TYPES);
  expect(types.slice(ER_TYPES.length)).toEqual(["money"]);
  const median = bestMedian(() => void erTypesOf(doc.nodes));
  console.log(`type list at 2,000 x 20: median ${median.toFixed(2)} ms`);
  expect(median).toBeLessThan(5);
});

test("two_hundred_store_edits_do_not_grow_the_heap", () => {
  const store = createErStore();
  const scroll = createErScrollStore();
  const cycles = () => {
    for (let i = 0; i < 200; i++) {
      const table = TABLES[(i * 7) % TABLES.length];
      // Open a column field, select the column, aim at another table's header, then close all three.
      store.set({ edit: { kind: "col", table, index: i % 20, field: i % 2 ? "type" : "name" } });
      store.set({ selected: { table, index: i % 20 } });
      store.set({ aim: { table: TABLES[(i * 13) % TABLES.length], index: -1 } });
      scroll.set(table, 22 * ((i % 20) + 1));
      store.set({ edit: null, selected: null, aim: null });
    }
    // The frame switch that ends them: the scroll store lets every table go.
    scroll.clear();
    expect(store.size()).toBe(0);
    expect(store.listeners()).toBe(0);
    expect(store.get()).toEqual({ edit: null, selected: null, aim: null });
    expect(TABLES.filter((t) => scroll.get(t) !== 0)).toEqual([]);
  };
  // The first pass warms the code paths, so the second measures growth, not the first fill.
  cycles();
  gc();
  const base = heapUsed();
  cycles();
  gc();
  const grown = heapUsed() - base;
  console.log(`200 store edit cycles: heap growth ${grown} bytes`);
  expect(grown).toBeLessThan(1024 * 1024);
});
