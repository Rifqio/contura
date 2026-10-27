import { expect, test } from "vitest";
import type { SchemaModel } from "../../../api/types";
import { overTextLimit } from "../../../lang/flow/model";
import { modelToErFrame } from "./fromDatabase";

function big(): SchemaModel {
  const tables = Array.from({ length: 2000 }, (_, i) => ({
    schema: "public", name: `t${i}`, alias: null, note: null, indexes: [],
    columns: Array.from({ length: 12 }, (_, k) => ({ name: `c${k}`, typeName: "int", pk: k === 0, increment: false, notNull: false, unique: false, default: null, note: null })),
  }));
  const refs = Array.from({ length: 1999 }, (_, i) => ({
    name: null, onDelete: null, onUpdate: null,
    from: { schema: "public", table: `t${i + 1}`, columns: ["c1"] },
    to: { schema: "public", table: `t${i}`, columns: ["c0"] },
  }));
  return { dialect: "postgres", tables, refs, enums: [], skipped: [] };
}

test("a_2000_table_schema_converts_under_150ms", () => {
  const m = big();
  modelToErFrame(m, "warm");
  const t0 = performance.now();
  const out = modelToErFrame(m, "big");
  const ms = performance.now() - t0;
  expect("text" in out && out.tables === 2000).toBe(true);
  expect("text" in out && !overTextLimit(out.text)).toBe(true);
  expect(ms).toBeLessThan(150);
});

test("converting_ten_times_holds_nothing", () => {
  const gc = (globalThis as { gc?: () => void }).gc;
  expect(gc).toBeTypeOf("function");
  const m = big();
  const heap = () => { gc!(); gc!(); return (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed; };
  modelToErFrame(m, "x");
  const first = heap();
  for (let i = 0; i < 10; i++) modelToErFrame(m, "x");
  expect(heap() - first).toBeLessThan(2 * 1024 * 1024);
});

test("five_thousand_colliding_names_in_one_table_convert_under_150ms", () => {
  const columns = Array.from({ length: 5000 }, (_, k) => ({ name: k % 2 ? "a b" : "a:b", typeName: "int", pk: false, increment: false, notNull: false, unique: false, default: null, note: null }));
  const m: SchemaModel = { dialect: "postgres", tables: [{ schema: "public", name: "t", alias: null, note: null, indexes: [], columns }], refs: [], enums: [], skipped: [] };
  modelToErFrame(m, "warm");
  const t0 = performance.now();
  const out = modelToErFrame(m, "x");
  const ms = performance.now() - t0;
  expect("text" in out && out.tables === 1).toBe(true);
  expect(ms).toBeLessThan(150);
});
