import { beforeEach, expect, test } from "vitest";
import type { AnyTab } from "../shell/tabs";
import {
  clearAllSteps,
  clearSteps,
  PLACES_KEPT,
  recordStep,
  type RecentStepInput,
  STEP_IDLE_MS,
  STEPS_PER_PLACE,
  stepsOf,
  stepsSize,
  tabSteps,
  takeSteps,
} from "./recentSteps";
import { threadsCleared } from "./threadsCleared";

const T0 = 1_700_000_000_000;

const step = (verb: RecentStepInput["verb"], over: Partial<RecentStepInput> = {}): RecentStepInput => ({
  verb,
  tab: "visual",
  title: "Orders over 1M",
  connectionId: "c1",
  database: "shop",
  schema: null,
  count: null,
  ...over,
});

beforeEach(() => clearAllSteps());

test("caps", () => {
  for (let i = 0; i < 14; i++) recordStep("p", step("runQuery", { tab: "query", title: `Query ${i}` }), T0 + i);
  const kept = stepsOf("p", T0 + 20);
  expect(kept).toHaveLength(STEPS_PER_PLACE);
  expect(kept.map((s) => s.title)).toEqual(Array.from({ length: 10 }, (_, i) => `Query ${i + 4}`));

  clearAllSteps();
  for (let p = 0; p < 9; p++) recordStep(`place${p}`, step("runQuery"), T0 + p);
  expect(stepsOf("place0", T0 + 10)).toEqual([]);
  for (let p = 1; p < 9; p++) expect(stepsOf(`place${p}`, T0 + 10)).toHaveLength(1);
  expect(PLACES_KEPT).toBe(8);
});

test("merge", () => {
  recordStep("p", step("vqTick", { names: ["orders.id"] }), T0);
  recordStep("p", step("vqTick", { names: ["orders.total"] }), T0 + 1);
  let s = stepsOf("p", T0 + 2);
  expect(s).toHaveLength(1);
  expect(s[0].names).toEqual(["orders.id", "orders.total"]);
  expect(s[0].at).toBe(T0 + 1);

  recordStep("p", step("vqTick", { names: ["orders.a", "orders.b", "orders.c", "orders.d"] }), T0 + 3);
  s = stepsOf("p", T0 + 4);
  expect(s[0].names).toHaveLength(6);
  expect(s[0].more ?? 0).toBe(0);
  recordStep("p", step("vqTick", { names: ["orders.e"] }), T0 + 5);
  s = stepsOf("p", T0 + 6);
  expect(s).toHaveLength(1);
  expect(s[0].names).toHaveLength(6);
  expect(s[0].more).toBe(1);

  clearAllSteps();
  recordStep("p", step("showTab", { tab: "query", title: "Query 1" }), T0);
  recordStep("p", step("showTab", { tab: "query", title: "Query 2" }), T0 + 1);
  s = stepsOf("p", T0 + 2);
  expect(s).toHaveLength(1);
  expect(s[0].title).toBe("Query 2");

  clearAllSteps();
  recordStep("p", step("openTab", { tab: "newTable", title: null }), T0);
  recordStep("p", step("showTab", { tab: "newTable", title: null }), T0 + 1);
  s = stepsOf("p", T0 + 2);
  expect(s.map((x) => x.verb)).toEqual(["openTab"]);
});

test("idle", () => {
  recordStep("p", step("runVisual"), T0);
  recordStep("p", step("runQuery", { tab: "query" }), T0 + 2 * 60_000);
  const at = T0 + 31 * 60_000;
  expect(stepsOf("p", at).map((s) => s.verb)).toEqual(["runQuery"]);
  expect(STEP_IDLE_MS).toBe(30 * 60_000);
});

test("takeSteps keeps steps made while the Ask streamed", () => {
  recordStep("p", step("runVisual"), T0);
  recordStep("p", step("runQuery", { tab: "query" }), T0 + 1);
  const snapshot = Math.max(...stepsOf("p", T0 + 2).map((s) => s.seq));
  // Recorded while the answer streamed.
  recordStep("p", step("gridSort", { tab: "object", names: ["orders", "created_at"] }), T0 + 3);
  takeSteps("p", snapshot);
  expect(stepsOf("p", T0 + 4).map((s) => s.verb)).toEqual(["gridSort"]);
  takeSteps("p", Number.MAX_SAFE_INTEGER);
  expect(stepsOf("p", T0 + 5)).toEqual([]);
});

test("steps hold no free text", () => {
  // @ts-expect-error a step has no field for SQL text
  const sql: RecentStepInput = { ...step("runQuery"), sql: "SELECT * FROM orders" };
  // @ts-expect-error nor for values
  const values: RecentStepInput = { ...step("vqFilter"), values: ["1000000"] };
  void sql;
  void values;

  const long = "x".repeat(300);
  recordStep("p", step("vqTable", { names: ["a", "b", "c", "d", "e", "f", "g", "h", long] }), T0);
  const [s] = stepsOf("p", T0 + 1);
  expect(s.names).toEqual(["a", "b", "c", "d", "e", "f"]);
  expect(s.more).toBe(3);

  clearAllSteps();
  recordStep("p", step("vqTable", { names: [long] }), T0);
  expect(stepsOf("p", T0 + 1)[0].names![0]).toHaveLength(128);
});

const objectTab = (name: string): AnyTab => ({
  kind: "object",
  key: `obj:${name}`,
  selection: { connectionId: "c1", kind: "table", path: { database: "shop", schema: "public", name } },
});

test("tabSteps", () => {
  const home: AnyTab = { kind: "home" };
  const orders = objectTab("orders");
  const customers = objectTab("customers");
  // A new key gives openTab.
  expect(tabSteps(["home"], "home", [home, orders], "obj:orders")).toEqual([
    { verb: "openTab", tab: "object", title: null, connectionId: "c1", database: "shop", schema: "public", names: ["orders"], count: null },
  ]);
  // A changed active key gives showTab.
  expect(tabSteps(["home", "obj:orders"], "obj:orders", [home, orders], "home")).toEqual([
    { verb: "showTab", tab: "home", title: null, connectionId: null, database: null, schema: null, count: null },
  ]);
  // Closing a tab gives none.
  expect(tabSteps(["home", "obj:orders", "obj:customers"], "obj:customers", [home, customers], "obj:customers")).toEqual([]);
  // A New table tab is its own kind.
  const created: AnyTab = { kind: "design", key: "d1", connectionId: "c1", target: { kind: "create", scope: { database: "shop", schema: "public" }, id: "n1" } };
  expect(tabSteps([], null, [created], "d1")[0]).toMatchObject({ verb: "openTab", tab: "newTable", database: "shop" });
  // A diagram tab is never recorded.
  expect(tabSteps([], null, [{ kind: "flow", name: "plan" }], "flow:plan")).toEqual([]);
});

test("bounded after 10,000 records over 20 places", () => {
  for (let i = 0; i < 10_000; i++) {
    recordStep(`place${i % 20}`, step(i % 2 ? "runQuery" : "gridSort", { tab: i % 2 ? "query" : "object", title: `t${i}` }), T0 + i);
  }
  expect(stepsSize()).toBeLessThanOrEqual(PLACES_KEPT * STEPS_PER_PLACE);
  clearSteps("place19");
  expect(stepsOf("place19", T0 + 10_000)).toEqual([]);
});

test("clearing a place's threads clears its steps", () => {
  recordStep("a", step("runVisual"), T0);
  recordStep("b", step("runVisual"), T0);
  threadsCleared("a");
  expect(stepsOf("a", T0 + 1)).toEqual([]);
  expect(stepsOf("b", T0 + 1)).toHaveLength(1);
  threadsCleared(null);
  expect(stepsOf("b", T0 + 1)).toEqual([]);
});

test("names keep their order and repeats where their place means something", () => {
  // A self-join, a transfer of a table named as its database, a grid sorted by a column named as its table.
  recordStep("p", step("vqJoin", { names: ["employees", "employees"] }), T0);
  recordStep("p", step("transferRan", { tab: "transfer", title: null, names: ["sales", "sales"] }), T0 + 1);
  recordStep("p", step("gridSort", { tab: "object", title: null, names: ["status", "status"] }), T0 + 2);
  expect(stepsOf("p", T0 + 3).map((s) => s.names)).toEqual([
    ["employees", "employees"],
    ["sales", "sales"],
    ["status", "status"],
  ]);

  // Two joins on one Visual Query are two steps, never one union.
  clearAllSteps();
  recordStep("p", step("vqJoin", { names: ["orders", "items"] }), T0);
  recordStep("p", step("vqJoin", { names: ["customers", "orders"] }), T0 + 1);
  expect(stepsOf("p", T0 + 2).map((s) => s.names)).toEqual([
    ["orders", "items"],
    ["customers", "orders"],
  ]);

  // Column lists still add up without repeats.
  clearAllSteps();
  recordStep("p", step("vqTick", { names: ["orders.id"] }), T0);
  recordStep("p", step("vqTick", { names: ["orders.id", "orders.total"] }), T0 + 1);
  expect(stepsOf("p", T0 + 2).map((s) => s.names)).toEqual([["orders.id", "orders.total"]]);
});
