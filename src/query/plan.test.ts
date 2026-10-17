import { expect, test } from "vitest";
import type { Plan, PlanNode } from "../api/types";
import { planFlags } from "./plan";

const node = (over: Partial<PlanNode> = {}): PlanNode => ({
  label: "Table scan on orders",
  object: "orders",
  rows: null,
  cost: null,
  fullScan: false,
  children: [],
  ...over,
});
const plan = (nodes: PlanNode[], totalCost: number | null = null): Plan => ({ nodes, raw: "", totalCost });

test("flags_full_scans_over_10000_rows", () => {
  expect(planFlags(plan([node({ fullScan: true, rows: 141377 })]))).toEqual([
    { path: [0], kind: "fullScan", text: "Full scan of orders, about 141,377 rows" },
  ]);
  expect(planFlags(plan([node({ fullScan: true, rows: 9000 })]))).toEqual([]);
  expect(planFlags(plan([node({ fullScan: false, rows: 500000 })]))).toEqual([]);
});

test("flags_steps_over_half_the_cost", () => {
  const heavy = planFlags(plan([node({ cost: 60, children: [] }), node({ cost: 40 })], 100));
  expect(heavy).toEqual([{ path: [0], kind: "heavyStep", text: "This step is 60 percent of the cost" }]);
  expect(planFlags(plan([node({ cost: 50 })], 100))).toEqual([]);
});

test("a_parents_cost_counts_without_its_children", () => {
  // Server costs add up the children, so the root would always read 100 percent.
  const p = plan([node({ cost: 100, children: [node({ cost: 70 })] })], 100);
  expect(planFlags(p).map((f) => f.path)).toEqual([[0, 0]]);
});

test("sqlite_plans_get_no_flags", () => {
  expect(planFlags(plan([node({ fullScan: true, rows: null, cost: null })], null))).toEqual([]);
});
