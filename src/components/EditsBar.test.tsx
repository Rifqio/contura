import { expect, test } from "vitest";
import { summaryText } from "./EditsBar";

test("summary names only what changed", () => {
  expect(summaryText({ cells: 1, newRows: 1, deletedRows: 1 })).toBe("1 edited cell, 1 new row, 1 deleted row");
  expect(summaryText({ cells: 3, newRows: 0, deletedRows: 2 })).toBe("3 edited cells, 2 deleted rows");
});