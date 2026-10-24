import { expect, test } from "vitest";
import type { Cell } from "../api/types";
import { addCell, selectAll, single } from "./selection";
import { summarize } from "./summary";

const num = (v: string): Cell => ({ t: "number", value: v });
const txt = (v: string): Cell => ({ t: "text", value: v, truncated: false, totalBytes: v.length });
const nul: Cell = { t: "null" };

const rows: Cell[][] = [
  [num("1"), txt("a"), nul],
  [num("2"), txt("b"), num("10.5")],
  [num("3"), nul, num("0.25")],
];
const at = (r: number, c: number) => rows[r]?.[c];
const numericCols = [true, false, true];

test("polish A7: one cell has no summary", () => {
  expect(summarize(single({ r: 0, c: 0 }), at, numericCols)).toBeNull();
  expect(summarize(null, at, numericCols)).toBeNull();
});

test("polish A7: several cells say how many are selected and how many hold a value", () => {
  const s = selectAll({ rows: 3, cols: 3 });
  expect(summarize(s, at, numericCols)).toBe("9 cells selected, Count 7, Sum 16.75");
});

test("polish A7: a Sum appears only when numbers are selected, and text and NULL are left out of it", () => {
  const text = { ...single({ r: 0, c: 1 }) };
  const two = { ...text, ranges: [...text.ranges, { r0: 1, c0: 1, r1: 1, c1: 1 }] };
  expect(summarize(two, at, numericCols)).toBe("2 cells selected, Count 2");
});

test("polish A7: whole numbers add exactly beyond 2^53, and thousands are grouped", () => {
  const big: Cell[][] = [[num("9007199254740993")], [num("1000")]];
  const s = selectAll({ rows: 2, cols: 1 });
  expect(summarize(s, (r, c) => big[r]?.[c], [true])).toBe("2 cells selected, Count 2, Sum 9,007,199,254,741,993");
});

test("polish A7: a Ctrl+clicked cell counts once even if clicked twice", () => {
  let s = single({ r: 0, c: 0 });
  s = addCell(s, { r: 1, c: 0 });
  s = addCell(s, { r: 1, c: 0 });
  expect(summarize(s, at, numericCols)).toBe("2 cells selected, Count 2, Sum 3");
});

test("polish A7: a very large selection is counted but not read", () => {
  const s = selectAll({ rows: 1_000_000, cols: 20 });
  let reads = 0;
  expect(summarize(s, () => (reads++, undefined), [], 1000)).toBe("20,000,000 cells selected");
  expect(reads).toBe(0);
});

test("polish A7: a text column holding numbers sums only when the column is numeric", () => {
  const edited: Cell[][] = [[txt("5")], [txt("x")]];
  const s = selectAll({ rows: 2, cols: 1 });
  expect(summarize(s, (r, c) => edited[r]?.[c], [true])).toBe("2 cells selected, Count 2, Sum 5");
  expect(summarize(s, (r, c) => edited[r]?.[c], [false])).toBe("2 cells selected, Count 2");
});

test("review M6: decimals past three places are kept in the Sum", () => {
  const d: Cell[][] = [[num("0.0001")], [num("0.0002")], [num("12.3456")]];
  expect(summarize(selectAll({ rows: 3, cols: 1 }), (r, c) => d[r]?.[c], [true])).toBe("3 cells selected, Count 3, Sum 12.3459");
});
