import type { Cell, ColumnInfo, NewValue, Page } from "../api/types";
import { isDeleted, keyOf, type LocalId, newRows, type Pending, pendingValue, type RowKey } from "./pending";

/** One row as the editable grid shows it: the loaded page, then the new rows under it (T3). */
export type DisplayRow =
  /** `defaults`: the unset key columns, which show `default`; other unset cells stay empty. */
  | { kind: "new"; id: LocalId; cells: Cell[]; set: boolean[]; defaults: boolean[] }
  /** `index`: the row's place on the loaded page, for its row number. */
  | { kind: "loaded"; key: RowKey | null; source: Cell[]; cells: Cell[]; deleted: boolean; index: number };

/** DEFAULT has no value until the server works it out; the grid shows it as `default` (`isDefault`). */
export function valueCell(v: NewValue): Cell {
  return v.t === "text" ? { t: "text", value: v.value, truncated: false, totalBytes: v.value.length } : { t: "null" };
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

/**
 * The loaded page, then the new rows: each under the row it was added after (G17), else at the bottom (T3).
 */
export function displayRows(p: Pending | null, page: Page | null): DisplayRow[] {
  const columns = page?.columns ?? p?.columns ?? [];
  const fresh = p ? newRows(p) : [];
  const added: DisplayRow[] = p
    ? fresh.map((r) => ({
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
  const loaded: DisplayRow[] = (page?.rows ?? []).map((row, index) => {
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
      index,
    };
  });
  if (!fresh.some((r) => r.after !== undefined)) return [...loaded, ...added];
  const out: DisplayRow[] = [...loaded];
  const refOf = (d: DisplayRow) => (d.kind === "new" ? d.id : d.key);
  const bottom: DisplayRow[] = [];
  fresh.forEach((r, i) => {
    const at = r.after === undefined ? -1 : out.findIndex((d) => refOf(d) === r.after);
    if (at < 0) bottom.push(added[i]);
    else out.splice(at + 1, 0, added[i]);
  });
  return [...out, ...bottom];
}

/**
 * Tab-separated text as rows of values, read as Excel writes it: a field that starts with a double quote runs to
 * its closing quote, takes tabs and line breaks inside it, and reads a doubled quote as one. CRLF, LF and CR all end
 * a line; a trailing line break adds no row.
 */
export function parsePaste(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let start = true;
  const endField = () => {
    row.push(field);
    field = "";
    start = true;
  };
  while (i < text.length) {
    const ch = text[i];
    if (start && ch === '"') {
      // A quoted field: to the quote not followed by another.
      i++;
      for (;;) {
        if (i >= text.length) break;
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        field += text[i++];
      }
      start = false;
      continue;
    }
    start = false;
    if (ch === "\t") {
      endField();
      i++;
    } else if (ch === "\r" || ch === "\n") {
      endField();
      rows.push(row);
      row = [];
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (!start || field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) rows.push([""]);
  return rows;
}

export function hasKey(columns: ColumnInfo[]): boolean {
  return columns.some((c) => c.isPrimaryKey);
}
