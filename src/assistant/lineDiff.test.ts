import { expect, test } from "vitest";
import { DIFF_CELLS_MAX, diffLines, lineDiff } from "./lineDiff";

test("replace_middle_line", () => {
  expect(lineDiff("SELECT id\nFROM orders\nLIMIT 5", "SELECT id\nFROM invoices\nLIMIT 5")).toEqual([
    { op: "same", text: "SELECT id" },
    { op: "del", text: "FROM orders" },
    { op: "add", text: "FROM invoices" },
    { op: "same", text: "LIMIT 5" },
  ]);
});

test("pure_add", () => {
  expect(lineDiff("", "SELECT 1;\nSELECT 2;")).toEqual([
    { op: "add", text: "SELECT 1;" },
    { op: "add", text: "SELECT 2;" },
  ]);
});

test("pure_remove_and_same", () => {
  expect(lineDiff("a\nb", "")).toEqual([
    { op: "del", text: "a" },
    { op: "del", text: "b" },
  ]);
  expect(lineDiff("a\nb", "a\nb")).toEqual([
    { op: "same", text: "a" },
    { op: "same", text: "b" },
  ]);
});

test("past the table cap every old line goes and every new one comes, without the table", () => {
  const a = Array.from({ length: 1100 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 1000 }, (_, i) => `b${i}`);
  const out = diffLines(a, b);
  expect(a.length * b.length).toBeGreaterThan(DIFF_CELLS_MAX);
  expect(out).toHaveLength(2100);
  expect(out[0]).toEqual({ op: "del", text: "a0" });
  expect(out[1100]).toEqual({ op: "add", text: "b0" });
});

test("diffLines counts an empty line as a line", () => {
  expect(diffLines([""], ["", "SELECT 1;"])).toEqual([
    { op: "same", text: "" },
    { op: "add", text: "SELECT 1;" },
  ]);
});
