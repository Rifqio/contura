import { expect, test } from "vitest";
import { lineDiff } from "./lineDiff";

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
