import { expect, test } from "vitest";
import { BOX_HEIGHT, BOX_WIDTH, CARD_WIDTH, QUERY_CARD_WIDTH, RESULT_WIDTH, cardHeight } from "./metrics";
import { type LayoutRequest, layoutMissing, parseLayoutFile, serializeLayoutFile } from "./layout";
import { NODE_TOKENS } from "./types";

const node = (id: string, rows = 3) => ({ id, w: CARD_WIDTH, h: cardHeight(rows) });

function chain(): LayoutRequest {
  return {
    nodes: [node("a"), node("b", 5), node("c", 2), node("result", 4)],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
    existing: {},
    rankdir: "LR",
  };
}

test("engine_metrics_are_the_d1_values", () => {
  expect([BOX_WIDTH, BOX_HEIGHT, QUERY_CARD_WIDTH, RESULT_WIDTH]).toEqual([100, 48, 200, 268]);
  expect(NODE_TOKENS.table).toEqual({ fill: "--c-node-table-fill", stroke: "--c-node-table-stroke" });
  for (const k of ["view", "derived", "result"] as const) {
    expect(NODE_TOKENS[k]).toEqual({ fill: "--c-node-view-fill", stroke: "--c-node-view-stroke" });
  }
});

test("places_only_missing_nodes", async () => {
  const existing = { a: { x: 11, y: 22 }, c: { x: -5, y: 7 } };
  const out = await layoutMissing({ ...chain(), existing });
  expect(out.a).toEqual({ x: 11, y: 22 });
  expect(out.c).toEqual({ x: -5, y: 7 });
  expect(Object.keys(out).sort()).toEqual(["a", "b", "c", "result"]);
  for (const p of Object.values(out)) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
});

test("nothing_missing_returns_existing", async () => {
  const existing = { a: { x: 1, y: 2 } };
  const out = await layoutMissing({ nodes: [node("a")], edges: [], existing, rankdir: "LR" });
  expect(out).toEqual(existing);
});

test("pins_result_last", async () => {
  // The Result node has no edges, so dagre alone would put it on the first rank.
  const out = await layoutMissing({ ...chain(), pin: "result" });
  for (const id of ["a", "b", "c"]) expect(out.result.x, id).toBeGreaterThan(out[id].x);
  const tb = await layoutMissing({ ...chain(), rankdir: "TB", pin: "result" });
  for (const id of ["a", "b", "c"]) expect(tb.result.y, id).toBeGreaterThan(tb[id].y);
});

test("new_nodes_go_below_placed_ones", async () => {
  const existing = { a: { x: 0, y: 500 }, b: { x: 300, y: 120 } };
  const out = await layoutMissing({ ...chain(), existing });
  expect(out.c.y).toBeGreaterThan(500);
  expect(out.result.y).toBeGreaterThan(500);
});

test("layout_file_round_trip_with_tables_key", () => {
  const text = `${JSON.stringify(
    { version: 1, tables: { "a.t": { x: 3, y: 4 }, "b.t": { x: 1, y: 2 } }, viewport: { x: 5, y: 6, zoom: 0.5 } },
    null,
    2,
  )}\n`;
  const parsed = parseLayoutFile(text, "tables");
  expect(parsed.nodes).toEqual({ "a.t": { x: 3, y: 4 }, "b.t": { x: 1, y: 2 } });
  expect(serializeLayoutFile(parsed, "tables")).toBe(text);
  // Keys come out sorted whatever order they went in.
  const unsorted = serializeLayoutFile({ version: 1, nodes: { z: { x: 0, y: 0 }, m: { x: 1, y: 1 } } });
  expect(unsorted).toBe(`${JSON.stringify({ version: 1, nodes: { m: { x: 1, y: 1 }, z: { x: 0, y: 0 } } }, null, 2)}\n`);
  expect(parseLayoutFile(unsorted).nodes).toEqual({ m: { x: 1, y: 1 }, z: { x: 0, y: 0 } });
});

test("unreadable_layout_is_empty", () => {
  expect(parseLayoutFile("not json")).toEqual({ version: 1, nodes: {} });
  expect(parseLayoutFile('{"version":2,"nodes":{}}')).toEqual({ version: 1, nodes: {} });
  expect(parseLayoutFile('{"version":1,"tables":{"a":{"x":1,"y":2}}}')).toEqual({ version: 1, nodes: {} });
  expect(parseLayoutFile('{"version":1,"nodes":{"a":{"x":"1","y":2},"b":{"x":1,"y":2}}}')).toEqual({
    version: 1,
    nodes: { b: { x: 1, y: 2 } },
  });
});
