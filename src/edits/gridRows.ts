import type { Cell, ColumnInfo, NewValue, Page } from "../api/types";
import { isDeleted, keyOf, type LocalId, newRows, type Pending, pendingValue, type RowKey } from "./pending";

/** One row as the editable grid shows it: the loaded page, then the new rows under it (T3). */
export type DisplayRow =
  /** `defaults`: the unset key columns, which show `default`; other unset cells stay empty. */
  | { kind: "new"; id: LocalId; cells: Cell[]; set: boolean[]; defaults: boolean[] }
  | { kind: "loaded"; key: RowKey | null; source: Cell[]; cells: Cell[]; deleted: boolean };

export function valueCell(v: NewValue): Cell {
  return v.t === "null" ? { t: "null" } : { t: "text", value: v.value, truncated: false, totalBytes: v.value.length };
}

/** The value a loaded cell holds, when it is whole; cut-short and binary cells have none. */
export function cellValue(c: Cell): NewValue | null {
  if (c.t === "null") return { t: "null" };
  if (c.t === "number") return { t: "text", value: c.value };
  if (c.t === "text" && !c.truncated) return { t: "text", value: c.value };
  return null;
}

export function cellText(c: Cell): string {
  if (c.t === "null") return "NULL";
  if (c.t === "bytes") return `0x${c.previewHex}`;
  return c.value;
}

export function displayRows(p: Pending | null, page: Page | null): DisplayRow[] {
  const columns = page?.columns ?? p?.columns ?? [];
  const added: DisplayRow[] = p
    ? newRows(p).map((r) => ({
        kind: "new" as const,
        id: r.localId,
        cells: columns.map((c) => {
          const v = r.values.get(c.name);
          return v ? valueCell(v) : { t: "null" as const };
        }),
        set: columns.map((c) => r.values.has(c.name)),
        defaults: columns.map((c) => c.isPrimaryKey && !r.values.has(c.name)),
      }))
    : [];
  const loaded: DisplayRow[] = (page?.rows ?? []).map((row) => {
    const key = keyOf(columns, row);
    return {
      kind: "loaded" as const,
      key,
      source: row,
      cells: row.map((cell, i) => {
        const v = p && key ? pendingValue(p, key, columns[i].name) : undefined;
        return v ? valueCell(v) : cell;
      }),
      deleted: !!(p && key && isDeleted(p, key)),
    };
  });
  return [...loaded, ...added];
}

/** Tab-separated text as rows of values; a trailing line break adds no row. */
export function parsePaste(text: string): string[][] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => l.split("\t"));
}

export function hasKey(columns: ColumnInfo[]): boolean {
  return columns.some((c) => c.isPrimaryKey);
}
