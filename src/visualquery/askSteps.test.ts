import { expect, test } from "vitest";
import type { VisualQuery } from "../api/types";
import { vqSteps } from "./askSteps";

const base: VisualQuery = {
  version: 1,
  database: "shop",
  tables: [{ id: "t1", schema: "public", name: "orders", alias: "o", x: 0, y: 0 }],
  joins: [],
  columns: [{ table: "t1", column: "id", alias: null, aggregate: null }],
  filters: [],
  groupBy: { kind: "auto" },
  orderBy: [],
  limit: null,
  distinct: false,
};
const where = { title: "Orders over 1M", connectionId: "c1", database: "shop" };
const customers = { id: "t2", schema: "public", name: "customers", alias: "c", x: 300, y: 0 };

const verbs = (prev: VisualQuery, next: VisualQuery) => vqSteps(prev, next, where).map((s) => [s.verb, s.names ?? []]);

test("add and remove a table", () => {
  const added = { ...base, tables: [...base.tables, customers] };
  expect(verbs(base, added)).toEqual([["vqTable", ["customers"]]]);
  expect(vqSteps(base, added, where)[0]).toMatchObject({ tab: "visual", title: "Orders over 1M", connectionId: "c1", database: "shop", schema: null, count: null });
  expect(verbs(added, base)).toEqual([["vqTableOff", ["customers"]]]);
});

test("tick and untick", () => {
  const ticked = { ...base, columns: [...base.columns, { table: "t1", column: "total", alias: null, aggregate: null }] };
  expect(verbs(base, ticked)).toEqual([["vqTick", ["orders.total"]]]);
  expect(verbs(ticked, base)).toEqual([["vqUntick", ["orders.total"]]]);
});

test("join", () => {
  const two = { ...base, tables: [...base.tables, customers] };
  const joined = { ...two, joins: [{ id: "j1", left: "t1", right: "t2", kind: "inner" as const, on: [{ leftColumn: "customer_id", rightColumn: "id" }] }] };
  expect(verbs(two, joined)).toEqual([["vqJoin", ["orders", "customers"]]]);
});

test("a filter goes by its column, never its value", () => {
  const filtered: VisualQuery = { ...base, filters: [{ joiner: "and", table: "t1", column: "total", op: "gt", values: ["1000000"] }] };
  const steps = vqSteps(base, filtered, where);
  expect(steps.map((s) => [s.verb, s.names])).toEqual([["vqFilter", ["orders.total"]]]);
  expect(JSON.stringify(steps)).not.toContain("1000000");
  // A new value alone is no step.
  const changed: VisualQuery = { ...filtered, filters: [{ ...filtered.filters[0], values: ["2000000"] }] };
  expect(vqSteps(filtered, changed, where)).toEqual([]);
});

test("order by changed", () => {
  const sorted: VisualQuery = { ...base, orderBy: [{ target: { kind: "column", table: "t1", column: "total" }, dir: "desc" }] };
  const steps = vqSteps(base, sorted, where);
  expect(steps.map((s) => [s.verb, s.names])).toEqual([["vqSort", ["orders.total"]]]);
  expect(steps[0].descending).toBe(true);
});

test("no step for a width drag, a move or a rename", () => {
  // Widths and the query's name live on the tab's doc, not the model, so they never reach here; a move does.
  const moved = { ...base, tables: [{ ...base.tables[0], x: 40, y: 80 }] };
  expect(vqSteps(base, moved, where)).toEqual([]);
  expect(vqSteps(base, { ...base }, where)).toEqual([]);
});

test("a self-join names the table twice", () => {
  const emp = { ...base, tables: [{ id: "e1", schema: null, name: "employees", alias: "e", x: 0, y: 0 }, { id: "e2", schema: null, name: "employees", alias: "m", x: 300, y: 0 }], columns: [] };
  const joined = { ...emp, joins: [{ id: "j1", left: "e1", right: "e2", kind: "left" as const, on: [{ leftColumn: "manager_id", rightColumn: "id" }] }] };
  expect(verbs(emp, joined)).toEqual([["vqJoin", ["employees", "employees"]]]);
});

test("removing a filter row or every sort is no step", () => {
  const two: VisualQuery = {
    ...base,
    filters: [
      { joiner: "and", table: "t1", column: "status", op: "eq", values: ["paid"] },
      { joiner: "and", table: "t1", column: "total", op: "gt", values: ["10"] },
    ],
  };
  expect(vqSteps(two, { ...two, filters: [two.filters[1]] }, where)).toEqual([]);
  // A filter moved to another column still is one.
  expect(verbs(two, { ...two, filters: [two.filters[0], { ...two.filters[1], column: "id" }] })).toEqual([["vqFilter", ["orders.id"]]]);
  // A new empty row is one, with no column yet.
  expect(verbs(two, { ...two, filters: [...two.filters, { joiner: "and", table: "t1", column: "", op: "eq", values: [] }] })).toEqual([["vqFilter", []]]);
  const sorted: VisualQuery = { ...base, orderBy: [{ target: { kind: "column", table: "t1", column: "total" }, dir: "asc" }] };
  expect(vqSteps(sorted, { ...sorted, orderBy: [] }, where)).toEqual([]);
});
