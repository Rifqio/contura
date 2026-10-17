import { describe, expect, it } from "vitest";
import type { Cell, ColumnInfo, ObjectPath } from "../api/types";
import {
  addRow,
  count,
  deleteRow,
  discard,
  editCell,
  editNewCell,
  emptyPending,
  isDeleted,
  keyOf,
  newRows,
  pendingValue,
  redo,
  revertCell,
  revertRow,
  summary,
  toEditSet,
  undo,
  missingFull,
  withFullOld,
} from "./pending";

const columns: ColumnInfo[] = [
  { name: "id", typeName: "bigint", isPrimaryKey: true },
  { name: "status", typeName: "varchar", isPrimaryKey: false },
  { name: "note", typeName: "text", isPrimaryKey: false },
];
const num = (value: string): Cell => ({ t: "number", value });
const text = (value: string): Cell => ({ t: "text", value, truncated: false, totalBytes: value.length });
const NULL: Cell = { t: "null" };
const rowA: Cell[] = [num("1"), text("paid"), NULL];
const rowB: Cell[] = [num("2"), text("shipped"), text("x")];
const keyA = keyOf(columns, rowA)!;
const keyB = keyOf(columns, rowB)!;
const table: ObjectPath = { database: "shop", schema: "public", name: "orders" };
const t = (value: string) => ({ t: "text" as const, value });

describe("pending edits", () => {
  it("removes a change when the cell is edited back to its old value", () => {
    let p = editCell(emptyPending(columns), keyA, rowA, "status", t("cancelled"));
    expect(count(p)).toBe(1);
    p = editCell(p, keyA, rowA, "status", t("paid"));
    expect(count(p)).toBe(0);
    expect(pendingValue(p, keyA, "status")).toBeUndefined();
  });

  it("puts two cells of one row in one update with the loaded old values", () => {
    let p = editCell(emptyPending(columns), keyA, rowA, "status", t("cancelled"));
    p = editCell(p, keyA, rowA, "note", { t: "null" });
    p = editCell(p, keyA, rowA, "note", t("late"));
    const set = toEditSet(p, table);
    expect(set.updates).toEqual([
      {
        key: [{ column: "id", value: num("1") }],
        changes: [
          { column: "status", old: text("paid"), new: t("cancelled") },
          { column: "note", old: NULL, new: t("late") },
        ],
      },
    ]);
    expect(summary(p)).toEqual({ cells: 2, newRows: 0, deletedRows: 0 });
  });

  it("keeps edits by key whatever page is shown", () => {
    let p = editCell(emptyPending(columns), keyA, rowA, "status", t("cancelled"));
    p = editCell(p, keyB, rowB, "status", t("lost"));
    // rows of another page come and go; the model is keyed by row key only
    expect(pendingValue(p, keyA, "status")).toEqual(t("cancelled"));
    expect(pendingValue(p, keyB, "status")).toEqual(t("lost"));
    expect(count(p)).toBe(2);
  });

  it("undoes and redoes one edit at a time, and a new edit clears redo", () => {
    let p = editCell(emptyPending(columns), keyA, rowA, "status", t("cancelled"));
    let id: string;
    [p, id] = addRow(p);
    p = deleteRow(p, keyB, rowB);
    expect(summary(p)).toEqual({ cells: 1, newRows: 1, deletedRows: 1 });
    p = undo(p);
    expect(isDeleted(p, keyB)).toBe(false);
    p = undo(p);
    expect(newRows(p)).toEqual([]);
    p = redo(p);
    expect(newRows(p).map((r) => r.localId)).toEqual([id]);
    p = editNewCell(p, id, "status", t("pending"));
    p = redo(p);
    expect(isDeleted(p, keyB)).toBe(false);
  });

  it("deleting a new row removes the insert", () => {
    let [p, id] = addRow(emptyPending(columns));
    p = editNewCell(p, id, "status", t("pending"));
    p = deleteRow(p, id);
    expect(count(p)).toBe(0);
    expect(toEditSet(p, table).inserts).toEqual([]);
  });

  it("deleting an edited row drops its update and adds a delete", () => {
    let p = editCell(emptyPending(columns), keyA, rowA, "status", t("cancelled"));
    p = deleteRow(p, keyA, rowA);
    const set = toEditSet(p, table);
    expect(set.updates).toEqual([]);
    expect(set.deletes).toEqual([{ key: [{ column: "id", value: num("1") }] }]);
    expect(count(p)).toBe(1);
  });

  it("reverts a cell and a row", () => {
    let p = editCell(emptyPending(columns), keyA, rowA, "status", t("cancelled"));
    p = editCell(p, keyA, rowA, "note", t("late"));
    p = revertCell(p, keyA, "note");
    expect(summary(p).cells).toBe(1);
    p = revertRow(p, keyA);
    expect(count(p)).toBe(0);
    p = deleteRow(p, keyB, rowB);
    p = revertRow(p, keyB);
    expect(isDeleted(p, keyB)).toBe(false);
  });

  it("builds inserts from the cells that were set only", () => {
    let [p, first] = addRow(emptyPending(columns));
    p = editNewCell(p, first, "status", t("pending"));
    let second: string;
    [p, second] = addRow(p, new Map([["note", t("copy")]]));
    expect(second).not.toBe(first);
    expect(toEditSet(p, table)).toEqual({
      table,
      updates: [],
      deletes: [],
      inserts: [{ values: [["status", t("pending")]] }, { values: [["note", t("copy")]] }],
    });
  });

  it("discards everything", () => {
    let p = editCell(emptyPending(columns), keyA, rowA, "status", t("cancelled"));
    p = discard(p);
    expect(count(p)).toBe(0);
    expect(count(undo(p))).toBe(0);
  });

  it("has no row key without a primary key", () => {
    const plain = columns.map((c) => ({ ...c, isPrimaryKey: false }));
    expect(keyOf(plain, rowA)).toBeNull();
  });
});

describe("cut-short old values", () => {
  const cut: Cell = { t: "text", value: "a long", truncated: true, totalBytes: 2000 };
  const full: Cell = { t: "text", value: "a long note in full", truncated: false, totalBytes: 19 };
  const rowC: Cell[] = [num("3"), text("paid"), cut];
  const keyC = keyOf(columns, rowC)!;

  it("sends the full old value it was given, not the cut-short one", () => {
    const p = editCell(emptyPending(columns), keyC, rowC, "note", t("new note"), full);
    expect(toEditSet(p, table).updates[0].changes[0].old).toEqual(full);
  });

  it("treats typing the full old value back as no change", () => {
    let p = editCell(emptyPending(columns), keyC, rowC, "note", t("new note"), full);
    p = editCell(p, keyC, rowC, "note", t("a long note in full"));
    expect(count(p)).toBe(0);
  });

  it("lists cut-short old values still missing, and fills them in", () => {
    let p = editCell(emptyPending(columns), keyC, rowC, "note", { t: "null" });
    expect(missingFull(p)).toEqual([{ rowKey: keyC, key: [{ column: "id", value: num("3") }], column: "note" }]);
    p = withFullOld(p, keyC, "note", full);
    expect(missingFull(p)).toEqual([]);
    expect(toEditSet(p, table).updates[0].changes[0].old).toEqual(full);
  });
});
