// Canvas edits as small text edits on the existing DBML (ADR 0007): only the
// affected ranges change, so comments, ordering and formatting survive.
import type { SchemaModel, SmEndpoint } from "../../api/types";
import type { Ranges, TextEdit } from "../protocol";
import { ident, splitSegments, typeText, unquoteName } from "./names";

export type ColumnSetting = "pk" | "increment" | "not null" | "unique";

/** Applies edits from the last offset to the first, so earlier offsets stay valid. */
export function applyEdits(text: string, edits: TextEdit[]): string {
  return [...edits]
    .sort((a, b) => b.from - a.from)
    .reduce((t, e) => t.slice(0, e.from) + e.insert + t.slice(e.to), text);
}

function tableName(key: string): string {
  return key.slice(key.indexOf(".") + 1);
}

/** Ref endpoints (`ref:<i>/from|to`) whose table is `table`, with their segments. */
function endpoints(text: string, ranges: Ranges, table: string) {
  return Object.entries(ranges)
    .filter(([k]) => /^ref:\d+\/(from|to)$/.test(k))
    .map(([, r]) => {
      const segs = splitSegments(text.slice(r.from, r.to));
      const tableSeg = segs[segs.length - 2];
      return { r, segs, tableSeg };
    })
    .filter((e) => e.tableSeg && unquoteName(e.tableSeg.text) === table);
}

export function renameTable(text: string, ranges: Ranges, tableKey: string, newName: string): TextEdit[] {
  const old = tableName(tableKey);
  const name = ranges[`table:${tableKey}/name`];
  if (!name) return [];
  const edits: TextEdit[] = [{ ...name, insert: ident(newName) }];
  for (const e of endpoints(text, ranges, old)) {
    edits.push({ from: e.r.from + e.tableSeg.from, to: e.r.from + e.tableSeg.to, insert: ident(newName) });
  }
  return edits;
}

export function renameColumn(
  text: string,
  ranges: Ranges,
  tableKey: string,
  column: string,
  newName: string,
): TextEdit[] {
  const name = ranges[`column:${tableKey}/${column}/name`];
  if (!name) return [];
  const edits: TextEdit[] = [{ ...name, insert: ident(newName) }];
  for (const e of endpoints(text, ranges, tableName(tableKey))) {
    const colSeg = e.segs[e.segs.length - 1];
    const inner = colSeg.text.startsWith("(") ? colSeg.text.slice(1, -1) : colSeg.text;
    const offset = colSeg.text.startsWith("(") ? 1 : 0;
    let at = 0;
    for (const part of inner.split(",")) {
      const lead = part.length - part.trimStart().length;
      const word = part.trim();
      if (unquoteName(word) === column) {
        const from = e.r.from + colSeg.from + offset + at + lead;
        edits.push({ from, to: from + word.length, insert: ident(newName) });
      }
      at += part.length + 1;
    }
  }
  for (const [k, r] of Object.entries(ranges)) {
    if (k.startsWith(`index:${tableKey}/`) && unquoteName(text.slice(r.from, r.to)) === column) {
      edits.push({ ...r, insert: ident(newName) });
    }
  }
  return edits;
}

export function setColumnType(_text: string, ranges: Ranges, tableKey: string, column: string, type: string): TextEdit[] {
  const r = ranges[`column:${tableKey}/${column}/type`];
  return r ? [{ ...r, insert: typeText(type) }] : [];
}

/** Top-level comma-separated items of `[a, b: 'x, y']`, as offsets into the bracket text. */
function settingItems(inner: string): { text: string; from: number; to: number }[] {
  const items: { text: string; from: number; to: number }[] = [];
  let start = 0;
  for (let i = 0; i <= inner.length; i++) {
    const c = inner[i];
    if (c === "'" || c === "`" || c === '"') {
      const close = c;
      i += 1;
      while (i < inner.length && inner[i] !== close) i += inner[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === "," || i === inner.length) {
      items.push({ text: inner.slice(start, i).trim(), from: start, to: i });
      start = i + 1;
    }
  }
  return items.filter((x) => x.text !== "");
}

export function setColumnSetting(
  text: string,
  ranges: Ranges,
  tableKey: string,
  column: string,
  setting: ColumnSetting,
  on: boolean,
): TextEdit[] {
  const r = ranges[`column:${tableKey}/${column}/settings`];
  if (!r) return [];
  if (r.from === r.to) return on ? [{ from: r.from, to: r.to, insert: ` [${setting}]` }] : [];
  const inner = text.slice(r.from + 1, r.to - 1);
  const items = settingItems(inner).map((x) => x.text);
  const has = items.some((x) => x.toLowerCase() === setting);
  if (has === on) return [];
  const next = on ? [...items, setting] : items.filter((x) => x.toLowerCase() !== setting);
  if (next.length === 0) {
    // Remove the brackets and the space before them.
    const from = text[r.from - 1] === " " ? r.from - 1 : r.from;
    return [{ from, to: r.to, insert: "" }];
  }
  return [{ from: r.from, to: r.to, insert: `[${next.join(", ")}]` }];
}

function lineEnd(text: string, at: number): number {
  const nl = text.indexOf("\n", at);
  return nl === -1 ? text.length : nl + 1;
}

export function addColumn(text: string, ranges: Ranges, tableKey: string, name: string, type: string): TextEdit[] {
  const table = ranges[`table:${tableKey}`];
  if (!table) return [];
  const cols = Object.entries(ranges)
    .filter(([k]) => k.startsWith(`column:${tableKey}/`) && k.split("/").length === 2)
    .map(([, v]) => v)
    .sort((a, b) => a.from - b.from);
  const last = cols[cols.length - 1];
  if (!last) {
    const close = table.to - 1;
    return [{ from: close, to: close, insert: `  ${ident(name)} ${typeText(type)}\n` }];
  }
  const lineStart = text.lastIndexOf("\n", last.from - 1) + 1;
  const indent = text.slice(lineStart, last.from);
  const at = lineEnd(text, last.to);
  return [{ from: at, to: at, insert: `${indent}${ident(name)} ${typeText(type)}\n` }];
}

export function addTable(text: string, name: string): TextEdit[] {
  const end = text.trimEnd().length;
  return [{ from: end, to: text.length, insert: `\n\nTable ${ident(name)} {\n  id integer [pk]\n}\n` }];
}

function endpointText(e: SmEndpoint): string {
  const table = e.schema && e.schema !== "public" ? `${ident(e.schema)}.${ident(e.table)}` : ident(e.table);
  const cols = e.columns.length === 1 ? ident(e.columns[0]) : `(${e.columns.map(ident).join(", ")})`;
  return `${table}.${cols}`;
}

/** A Ref line after the last Ref, or at the end of the file. */
export function addRef(text: string, ranges: Ranges, from: SmEndpoint, to: SmEndpoint): TextEdit[] {
  const line = `Ref: ${endpointText(from)} > ${endpointText(to)}`;
  const refs = Object.entries(ranges)
    .filter(([k]) => /^ref:\d+$/.test(k))
    .map(([, v]) => v)
    .sort((a, b) => a.to - b.to);
  const last = refs[refs.length - 1];
  if (last) {
    const at = lineEnd(text, last.to);
    const needsNewline = at === text.length && !text.endsWith("\n");
    return [{ from: at, to: at, insert: `${needsNewline ? "\n" : ""}${line}\n` }];
  }
  const end = text.trimEnd().length;
  return [{ from: end, to: text.length, insert: `\n\n${line}\n` }];
}

/** A warning when the Foreign Key's target column is not a key, unique or indexed. */
export function fkTargetWarning(model: SchemaModel, to: SmEndpoint): string | null {
  const t = model.tables.find((x) => x.name === to.table && (x.schema ?? null) === (to.schema ?? null))
    ?? model.tables.find((x) => x.name === to.table);
  if (!t) return null;
  const column = to.columns[0];
  const c = t.columns.find((x) => x.name === column);
  if (!c) return null;
  const indexed = t.indexes.some((i) => i.columns[0] === column || (i.pk && i.columns.includes(column)));
  if (c.pk || c.unique || indexed) return null;
  return `${t.name}.${column} is not a key, unique or indexed. The database may refuse this Foreign Key.`;
}
