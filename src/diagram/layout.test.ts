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

test("new_nodes_go_beside_their_link_or_below_placed_ones", async () => {
  const existing = { a: { x: 0, y: 500 }, b: { x: 300, y: 120 } };
  const out = await layoutMissing({ ...chain(), existing });
  // c follows b: one rank to its right. result links to nothing placed: below every placed node.
  expect(out.c.x).toBe(300 + CARD_WIDTH + 80);
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

test("names_like_constructor_and___proto___are_placed_as_plain_names", async () => {
  // An own key, as JSON gives it.
  const existing = JSON.parse('{"toString":{"x":1,"y":2}}') as Record<string, { x: number; y: number }>;
  const out = await layoutMissing({
    nodes: [node("constructor"), node("__proto__"), node("toString")],
    edges: [{ from: "constructor", to: "__proto__" }],
    existing,
    rankdir: "LR",
  });
  expect(Object.keys(out).sort()).toEqual(["__proto__", "constructor", "toString"]);
  expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
  expect(typeof out.constructor).toBe("object");
  expect(out.toString).toEqual({ x: 1, y: 2 });
  // A plain object as `existing` (what the worker receives) does not count inherited keys as placed.
  const plain = await layoutMissing({ nodes: [node("constructor")], edges: [], existing: {}, rankdir: "LR" });
  expect(Object.prototype.hasOwnProperty.call(plain, "constructor")).toBe(true);
});

test("a_new_node_lands_beside_the_placed_node_it_links_to", async () => {
  // An ER frame: orders is placed by hand, the assistant adds users linked to it (owner's report, 1 Nov 2026).
  const req = (from: string, to: string): LayoutRequest => ({
    nodes: [node("orders", 6), node("users", 6)],
    edges: [{ from, to }],
    existing: { orders: { x: 600, y: 300 } },
    rankdir: "TB",
  });
  const h = cardHeight(6);
  // orders -> users: users goes one rank below orders, lined up with it.
  const below = (await layoutMissing(req("orders", "users"))).users;
  expect(below.x).toBe(600);
  expect(below.y).toBe(300 + h + 80);
  // users -> orders: users goes one rank above.
  const above = (await layoutMissing(req("users", "orders"))).users;
  expect(above.x).toBe(600);
  expect(above.y).toBe(300 - 80 - h);
  // Left to right, the same rank gap runs across.
  const lr = (await layoutMissing({ ...req("orders", "users"), rankdir: "LR" })).users;
  expect(lr).toEqual({ x: 600 + CARD_WIDTH + 80, y: 300 });
});

test("a_new_node_never_lands_on_a_placed_one", async () => {
  // The spot below orders is taken by lines: the new node slides clear of it.
  const out = await layoutMissing({
    nodes: [node("orders", 6), node("lines", 6), node("users", 6)],
    edges: [{ from: "orders", to: "users" }],
    existing: { orders: { x: 600, y: 300 }, lines: { x: 600, y: 300 + cardHeight(6) + 80 } },
    rankdir: "TB",
  });
  const a = { ...out.users, w: CARD_WIDTH, h: cardHeight(6) };
  for (const id of ["orders", "lines"]) {
    const b = { ...out[id], w: CARD_WIDTH, h: cardHeight(6) };
    const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    expect(overlap, id).toBe(false);
  }
});
