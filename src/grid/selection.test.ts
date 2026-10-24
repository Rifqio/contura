import { afterEach, expect, test } from "vitest";
import { setPlatformForTests } from "../platform";
import { parsePaste } from "../edits/gridRows";
import {
  addCell,
  altGraph,
  block,
  cellCount,
  colCoverage,
  contains,
  copyText,
  extendRowsTo,
  extendTo,
  lineBreak,
  navigate,
  rowCoverage,
  rowsOf,
  selectAll,
  selectRows,
  single,
  clampSelection,
  coversAll,
  wholeRows,
} from "./selection";

const dims = { rows: 12, cols: 5 };
const key = (k: string, mods: { shift?: boolean; ctrl?: boolean; alt?: boolean; code?: string } = {}) => ({
  key: k,
  code: mods.code ?? "",
  shiftKey: !!mods.shift,
  ctrlKey: !!mods.ctrl,
  metaKey: false,
  altKey: !!mods.alt,
});

afterEach(() => setPlatformForTests(null));

test("a click selects one cell; Shift extends from the anchor and the active cell stays", () => {
  const s = single({ r: 1, c: 2 });
  expect(cellCount(s)).toBe(1);
  const e = extendTo(s, { r: 3, c: 4 });
  expect(e.active).toEqual({ r: 1, c: 2 });
  expect(cellCount(e)).toBe(9);
  expect(contains(e, 2, 3)).toBe(true);
  expect(contains(e, 0, 3)).toBe(false);
  // Extending again replaces the last range, it does not add one.
  const back = extendTo(e, { r: 1, c: 3 });
  expect(back.ranges).toHaveLength(1);
  expect(cellCount(back)).toBe(2);
});

test("Ctrl+click adds a cell; overlapping blocks are counted once", () => {
  const s = addCell(extendTo(single({ r: 0, c: 0 }), { r: 1, c: 1 }), { r: 1, c: 1 });
  expect(s.ranges).toHaveLength(2);
  expect(s.active).toEqual({ r: 1, c: 1 });
  expect(cellCount(s)).toBe(4);
});

test("row numbers select whole rows; Shift extends them; Ctrl adds", () => {
  const s = selectRows(null, 2, 2, false, 5);
  expect(s.rows).toBe(true);
  expect(wholeRows(s, 5)).toBe(true);
  const e = extendRowsTo(s, 4, 5);
  expect(rowsOf(e)).toEqual([2, 3, 4]);
  const a = selectRows(e, 8, 8, true, 5);
  expect(rowsOf(a)).toEqual([2, 3, 4, 8]);
  expect(rowCoverage(a, 3, 5)).toBe("full");
  expect(rowCoverage(single({ r: 3, c: 1 }), 3, 5)).toBe("part");
  expect(rowCoverage(a, 6, 5)).toBeNull();
});

test("select all covers every cell and every column header", () => {
  const s = selectAll(dims);
  expect(cellCount(s)).toBe(60);
  expect(colCoverage(s, 4, 12)).toBe("full");
  // Selection state stays a handful of ranges, never one entry per cell.
  expect(s.ranges).toHaveLength(1);
});

test("the keys move, extend and jump as Excel does", () => {
  let s = single({ r: 0, c: 0 });
  s = navigate(s, key("ArrowRight"), dims, 10)!;
  expect(s.active).toEqual({ r: 0, c: 1 });
  s = navigate(s, key("ArrowDown", { shift: true }), dims, 10)!;
  expect(s.active).toEqual({ r: 0, c: 1 });
  expect(cellCount(s)).toBe(2);
  s = navigate(s, key("Tab"), dims, 10)!;
  expect(s.active).toEqual({ r: 0, c: 2 });
  expect(cellCount(s)).toBe(1);
  s = navigate(single({ r: 0, c: 4 }), key("Tab"), dims, 10)!;
  expect(s.active).toEqual({ r: 1, c: 0 });
  s = navigate(s, key("Tab", { shift: true }), dims, 10)!;
  expect(s.active).toEqual({ r: 0, c: 4 });
  s = navigate(single({ r: 3, c: 2 }), key("Home"), dims, 10)!;
  expect(s.active).toEqual({ r: 3, c: 0 });
  s = navigate(s, key("End"), dims, 10)!;
  expect(s.active).toEqual({ r: 3, c: 4 });
  s = navigate(s, key("Home", { ctrl: true }), dims, 10)!;
  expect(s.active).toEqual({ r: 0, c: 0 });
  s = navigate(s, key("End", { ctrl: true }), dims, 10)!;
  expect(s.active).toEqual({ r: 11, c: 4 });
  s = navigate(single({ r: 0, c: 1 }), key("PageDown"), dims, 10)!;
  expect(s.active).toEqual({ r: 10, c: 1 });
  s = navigate(s, key("PageUp"), dims, 10)!;
  expect(s.active).toEqual({ r: 0, c: 1 });
  s = navigate(single({ r: 5, c: 1 }), key("ArrowDown", { ctrl: true }), dims, 10)!;
  expect(s.active).toEqual({ r: 11, c: 1 });
  s = navigate(single({ r: 0, c: 0 }), key("End", { ctrl: true, shift: true }), dims, 10)!;
  expect(cellCount(s)).toBe(60);
  expect(s.active).toEqual({ r: 0, c: 0 });
});

test("Ctrl+A, Shift+Space and Ctrl+Space select all, the row and the column", () => {
  const a = navigate(single({ r: 2, c: 2 }), key("a", { ctrl: true, code: "KeyA" }), dims, 10)!;
  expect(cellCount(a)).toBe(60);
  const row = navigate(single({ r: 2, c: 2 }), key(" ", { shift: true }), dims, 10)!;
  expect(rowsOf(row)).toEqual([2]);
  expect(wholeRows(row, 5)).toBe(true);
  expect(row.active).toEqual({ r: 2, c: 2 });
  const col = navigate(single({ r: 2, c: 2 }), key(" ", { ctrl: true }), dims, 10)!;
  expect(cellCount(col)).toBe(12);
  expect(colCoverage(col, 2, 12)).toBe("full");
});

test("keys that are not movement are left to the grid", () => {
  expect(navigate(single({ r: 0, c: 0 }), key("Delete"), dims, 10)).toBeNull();
  expect(navigate(single({ r: 0, c: 0 }), key("c", { ctrl: true, code: "KeyC" }), dims, 10)).toBeNull();
});

test("a block is the rows and columns it covers; blocks that do not line up are not one", () => {
  const s = extendTo(single({ r: 1, c: 1 }), { r: 2, c: 3 });
  expect(block(s)).toEqual({ rows: [1, 2], cols: [1, 2, 3] });
  // Two blocks sharing their columns stack into one.
  const stacked = addCell(s, { r: 5, c: 1 });
  expect(block(extendTo(stacked, { r: 5, c: 3 }))).toEqual({ rows: [1, 2, 5], cols: [1, 2, 3] });
  expect(block(addCell(s, { r: 5, c: 0 }))).toBeNull();
});

test("copied text is tab separated, NULL as an empty field, with a header line on request", () => {
  setPlatformForTests("linux");
  const values = [
    ["1001", "paid", null],
    ["1002", "shipped", "58.00"],
  ];
  const s = extendTo(single({ r: 0, c: 0 }), { r: 1, c: 2 });
  const get = (r: number, c: number) => values[r][c];
  expect(copyText(block(s)!, get)).toBe("1001\tpaid\t\n1002\tshipped\t58.00");
  expect(copyText(block(s)!, get, ["id", "status", "total"])).toBe("id\tstatus\ttotal\n1001\tpaid\t\n1002\tshipped\t58.00");
  setPlatformForTests("windows");
  expect(lineBreak()).toBe("\r\n");
  expect(copyText(block(s)!, get)).toBe("1001\tpaid\t\r\n1002\tshipped\t58.00");
});

test("a selection past the rows that are left is cut back to them", () => {
  const s = extendTo(single({ r: 8, c: 1 }), { r: 11, c: 3 });
  const c = clampSelection(s, { rows: 10, cols: 5 })!;
  expect(c.active).toEqual({ r: 8, c: 1 });
  expect(rowsOf(c)).toEqual([8, 9]);
  expect(clampSelection(s, { rows: 0, cols: 5 })).toBeNull();
});

test("I2: a value with a tab, line break or quote is quoted as Excel does, and paste reads it back", () => {
  setPlatformForTests("windows");
  const values = [["a\tb", "two\nlines", 'say "hi"'], ["cr\r\nlf", "", null]];
  const b = { rows: [0, 1], cols: [0, 1, 2] };
  const text = copyText(b, (r, c) => values[r][c]);
  expect(text).toBe('"a\tb"\t"two\nlines"\t"say ""hi"""\r\n"cr\r\nlf"\t\t');
  expect(parsePaste(text)).toEqual([
    ["a\tb", "two\nlines", 'say "hi"'],
    ["cr\r\nlf", "", ""],
  ]);
  setPlatformForTests("linux");
  expect(parsePaste(copyText(b, (r, c) => values[r][c]))).toEqual([
    ["a\tb", "two\nlines", 'say "hi"'],
    ["cr\r\nlf", "", ""],
  ]);
  // Plain text pastes as before; a quote inside a field that does not start with one is kept.
  expect(parsePaste("x\ty\r\nz\tw\r\n")).toEqual([["x", "y"], ["z", "w"]]);
  expect(parsePaste('5" pipe\tok')).toEqual([['5" pipe', "ok"]]);
});

test("M5: Ctrl+click on a selected cell adds no duplicate range, and checking select-all stays cheap with many ranges", () => {
  let s = single({ r: 0, c: 0 });
  s = addCell(s, { r: 0, c: 0 });
  expect(s.ranges).toHaveLength(1);
  for (let i = 0; i < 400; i++) s = addCell(s, { r: i % 200, c: (i * 7) % 19 });
  const t = performance.now();
  for (let i = 0; i < 50; i++) coversAll(s, { rows: 1000, cols: 19 });
  expect(performance.now() - t).toBeLessThan(50);
  expect(coversAll(s, { rows: 1000, cols: 19 })).toBe(false);
  expect(coversAll(selectAll({ rows: 3, cols: 2 }), { rows: 3, cols: 2 })).toBe(true);
  // Two halves that make the whole still count.
  expect(coversAll(extendTo(addCell(extendTo(single({ r: 0, c: 0 }), { r: 0, c: 1 }), { r: 1, c: 0 }), { r: 1, c: 1 }), { rows: 2, cols: 2 })).toBe(true);
});

const ctrlAlt = (key: string) => ({ key, ctrlKey: true, altKey: true });

test("altGraph leaves Ctrl+Alt plus a digit to the app's shortcuts (Ctrl+Alt+1 opens Group 1)", () => {
  expect(altGraph(ctrlAlt("1"))).toBe(false);
  expect(altGraph(ctrlAlt("9"))).toBe(false);
});

test("altGraph still treats AltGr characters as typing", () => {
  expect(altGraph(ctrlAlt("{"))).toBe(true);
  expect(altGraph(ctrlAlt("@"))).toBe(true);
  expect(altGraph(ctrlAlt("ń"))).toBe(true);
});
