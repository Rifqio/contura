import { expect, test } from "vitest";
import { bestMedian } from "../lang/flow/perfGate";
import { parseFlow } from "../lang/flow/parse";
import { pickTargets, planReference, planRelationship } from "./erRelate";

// B3 Task 6 at the board limit: an ERD frame of 2,000 tables of 20 columns. Planning is pure and runs on a pointer
// release, a pick builds its list once; neither may walk the whole table list more than twice.
const block = (t: string) => [`${t} {`, "  id int pk", ...Array.from({ length: 19 }, (_, c) => `  c${c + 1} int`), "}"];
const tables = Array.from({ length: 2000 }, (_, i) => `t${i}`);
const text = ['diagram er "Limit"', ...tables.flatMap(block), ""].join("\n");
const r = parseFlow(text);
const doc = r.doc!;

test("the_fixture_is_2000_tables_of_20_columns", () => {
  expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
  expect(doc.nodes.length).toBe(2000);
  expect(doc.nodes[1999].rows?.length).toBe(20);
});

test("pick_targets_for_2000_tables_under_20ms", () => {
  let n = 0;
  const ms = bestMedian(() => {
    n = pickTargets(doc, { table: "t1000", column: "c5" }).length;
  });
  // Every other table's header and every int column, and the table's own other columns.
  expect(n).toBeGreaterThan(2000 * 20 - 25);
  expect(ms).toBeLessThan(20);
});

/** `doc` with its `nodes` counting every whole-list walk (iteration or an array method), not an indexed read. */
function counting() {
  const walks = { n: 0 };
  const walkers = new Set<string | symbol>(["find", "findIndex", "filter", "some", "every", "map", "forEach", "reduce", "indexOf", "includes", "flatMap", Symbol.iterator]);
  const nodes = new Proxy(doc.nodes, {
    get(target, key, recv) {
      if (walkers.has(key)) walks.n++;
      return Reflect.get(target, key, recv);
    },
  });
  return { walks, counted: { ...doc, nodes } };
}

test("planning_a_drop_walks_the_tables_at_most_twice", () => {
  const cases: (() => unknown)[] = [];
  const a = counting();
  cases.push(() => planRelationship(a.counted, { table: "t5", column: "c1" }, { table: "t1900", column: "c2" }));
  const b = counting();
  cases.push(() => planRelationship(b.counted, { table: "t5", column: "c1" }, { table: "t1900", column: null }));
  const c = counting();
  cases.push(() => planRelationship(c.counted, { table: "t5", column: "c1" }, { table: "t1900", column: "c2" }, "<>"));
  const d = counting();
  cases.push(() => planReference(d.counted, "t5", "t1900"));
  const e = counting();
  cases.push(() => planReference(e.counted, "t5", "t1900", "-"));
  const out = cases.map((f) => f());
  expect(out.every((p) => "ops" in (p as object))).toBe(true);
  for (const w of [a, b, c, d, e]) {
    expect(w.walks.n).toBeGreaterThan(0);
    expect(w.walks.n).toBeLessThanOrEqual(2);
  }
});
