// G2: the grid's selection as a few ranges (Excel, DataGrip): the active cell, the anchor a Shift+click or
// Shift+Arrow extends from, and the blocks Ctrl+click adds. It is the size of its ranges, never one entry per cell,
// so selecting all of a large page costs the same as selecting one cell. Rows and columns are grid positions.
import { platform } from "../platform";

export type Pos = { r: number; c: number };
/** A block from (r0, c0) to (r1, c1), either way round. */
export type Range = { r0: number; c0: number; r1: number; c1: number };
export type Dims = { rows: number; cols: number };

export interface Selection {
  ranges: Range[];
  /** The cell that edits, opens and the menu act on. */
  active: Pos;
  /** Where Shift extends from. */
  anchor: Pos;
  /** The far corner Shift moves. */
  end: Pos;
  /** Chosen from the row numbers: Delete then deletes the rows. */
  rows: boolean;
}

type Norm = { t: number; b: number; l: number; r: number };

export function norm(g: Range): Norm {
  return { t: Math.min(g.r0, g.r1), b: Math.max(g.r0, g.r1), l: Math.min(g.c0, g.c1), r: Math.max(g.c0, g.c1) };
}

const cellRange = (p: Pos): Range => ({ r0: p.r, c0: p.c, r1: p.r, c1: p.c });

export function single(p: Pos): Selection {
  return { ranges: [cellRange(p)], active: p, anchor: p, end: p, rows: false };
}

/** Shift+click or Shift+Arrow: the last block runs from the anchor to `p`; the active cell stays. */
export function extendTo(s: Selection, p: Pos): Selection {
  const last: Range = { r0: s.anchor.r, c0: s.anchor.c, r1: p.r, c1: p.c };
  return { ...s, ranges: [...s.ranges.slice(0, -1), last], end: p, rows: false };
}

/** Ctrl+click: one more cell, which becomes the active one. */
export function addCell(s: Selection, p: Pos): Selection {
  // The same cell again adds no second range (M5); it becomes the active cell.
  const twice = s.ranges.some((g) => g.r0 === p.r && g.r1 === p.r && g.c0 === p.c && g.c1 === p.c);
  return { ranges: twice ? s.ranges : [...s.ranges, cellRange(p)], active: p, anchor: p, end: p, rows: false };
}

/** A row number: rows `r0` to `r1`, added to `s` with Ctrl. */
export function selectRows(s: Selection | null, r0: number, r1: number, add: boolean, cols: number): Selection {
  const g: Range = { r0, c0: 0, r1, c1: Math.max(0, cols - 1) };
  const keepColumn = !add && s && s.active.r === r0 ? s.active.c : 0;
  return {
    ranges: add && s ? [...s.ranges, g] : [g],
    active: { r: r0, c: keepColumn },
    anchor: { r: r0, c: 0 },
    end: { r: r1, c: Math.max(0, cols - 1) },
    rows: true,
  };
}

/** Shift+click or a drag over the row numbers. */
export function extendRowsTo(s: Selection, r: number, cols: number): Selection {
  const last: Range = { r0: s.anchor.r, c0: 0, r1: r, c1: Math.max(0, cols - 1) };
  return { ...s, ranges: [...s.ranges.slice(0, -1), last], end: { r, c: Math.max(0, cols - 1) }, rows: true };
}

export function selectAll(d: Dims, active: Pos = { r: 0, c: 0 }): Selection {
  return {
    ranges: [{ r0: 0, c0: 0, r1: Math.max(0, d.rows - 1), c1: Math.max(0, d.cols - 1) }],
    active,
    anchor: { r: 0, c: 0 },
    end: { r: Math.max(0, d.rows - 1), c: Math.max(0, d.cols - 1) },
    rows: false,
  };
}

export function contains(s: Selection | null, r: number, c: number): boolean {
  if (!s) return false;
  for (const g of s.ranges) {
    const n = norm(g);
    if (r >= n.t && r <= n.b && c >= n.l && c <= n.r) return true;
  }
  return false;
}

/** Sorted, merged intervals. */
function merge(spans: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

const expand = (spans: [number, number][]) => spans.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));

/** The edges between which every range starts or ends, so the union can be read block by block. */
function cuts(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Calls `f` for each piece of the plane the ranges cut, with its size and whether a range covers it. */
function pieces(s: Selection, f: (rows: [number, number], cols: [number, number], covered: boolean) => void) {
  const ns = s.ranges.map(norm);
  const rs = cuts(ns.flatMap((n) => [n.t, n.b + 1]));
  const cs = cuts(ns.flatMap((n) => [n.l, n.r + 1]));
  for (let i = 0; i + 1 < rs.length; i++) {
    for (let j = 0; j + 1 < cs.length; j++) {
      const covered = ns.some((n) => rs[i] >= n.t && rs[i] <= n.b && cs[j] >= n.l && cs[j] <= n.r);
      f([rs[i], rs[i + 1] - 1], [cs[j], cs[j + 1] - 1], covered);
    }
  }
}

/** The cells selected, each counted once. */
export function cellCount(s: Selection | null): number {
  if (!s) return 0;
  let n = 0;
  pieces(s, (r, c, covered) => {
    if (covered) n += (r[1] - r[0] + 1) * (c[1] - c[0] + 1);
  });
  return n;
}

/**
 * Every cell is selected, for the corner's look on each render: one range covering all answers at once, ranges
 * too small together to cover all answer at once, and only the rare rest counts cells (M5).
 */
export function coversAll(s: Selection | null, d: Dims): boolean {
  if (!s || d.rows === 0 || d.cols === 0) return false;
  let area = 0;
  for (const g of s.ranges) {
    const n = norm(g);
    if (n.t <= 0 && n.l <= 0 && n.b >= d.rows - 1 && n.r >= d.cols - 1) return true;
    area += (n.b - n.t + 1) * (n.r - n.l + 1);
  }
  return area >= d.rows * d.cols && cellCount(s) >= d.rows * d.cols;
}

/** The rows the selection spans, in order. */
export function rowsOf(s: Selection | null): number[] {
  return s ? expand(merge(s.ranges.map((g) => [norm(g).t, norm(g).b]))) : [];
}

export function colsOf(s: Selection | null): number[] {
  return s ? expand(merge(s.ranges.map((g) => [norm(g).l, norm(g).r]))) : [];
}

/** Every range runs across all the columns. */
export function wholeRows(s: Selection | null, cols: number): boolean {
  return !!s && s.ranges.every((g) => norm(g).l === 0 && norm(g).r >= cols - 1);
}

/** How much of row `r` is selected, for its row number. */
export function rowCoverage(s: Selection | null, r: number, cols: number): "full" | "part" | null {
  if (!s) return null;
  const spans = s.ranges.map(norm).filter((n) => r >= n.t && r <= n.b).map((n): [number, number] => [n.l, n.r]);
  if (!spans.length) return null;
  const m = merge(spans);
  return m.length === 1 && m[0][0] <= 0 && m[0][1] >= cols - 1 ? "full" : "part";
}

/** How much of column `c` is selected, for its header. */
export function colCoverage(s: Selection | null, c: number, rows: number): "full" | "part" | null {
  if (!s || rows === 0) return null;
  const spans = s.ranges.map(norm).filter((n) => c >= n.l && c <= n.r).map((n): [number, number] => [n.t, n.b]);
  if (!spans.length) return null;
  const m = merge(spans);
  return m.length === 1 && m[0][0] <= 0 && m[0][1] >= rows - 1 ? "full" : "part";
}

/**
 * The rows and columns of a selection that copies as one table: every row it spans has the same columns selected
 * (one block, or blocks sharing their rows or columns). Null otherwise, as Excel refuses such a copy.
 */
export function block(s: Selection | null): { rows: number[]; cols: number[] } | null {
  if (!s || !s.ranges.length) return null;
  const rows = merge(s.ranges.map((g) => [norm(g).t, norm(g).b]));
  const cols = merge(s.ranges.map((g) => [norm(g).l, norm(g).r]));
  let ok = true;
  pieces(s, (r, c, covered) => {
    const inRows = rows.some(([a, b]) => r[0] >= a && r[1] <= b);
    const inCols = cols.some(([a, b]) => c[0] >= a && c[1] <= b);
    if (inRows && inCols && !covered) ok = false;
  });
  return ok ? { rows: expand(rows), cols: expand(cols) } : null;
}

/** CRLF on Windows, as Excel writes it; LF elsewhere. */
export function lineBreak(): string {
  return platform() === "windows" ? "\r\n" : "\n";
}

/**
 * The block as tab-separated text, the way Excel writes it: one line a row, NULL as an empty field, and a value
 * holding a tab, a line break or a double quote wrapped in double quotes with its quotes doubled, so it pastes back
 * into one cell (`parsePaste` reads it).
 */
export function copyText(b: { rows: number[]; cols: number[] }, value: (r: number, c: number) => string | null, headers?: string[]): string {
  const field = (v: string | null) => (v === null ? "" : /[\t\r\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = b.rows.map((r) => b.cols.map((c) => field(value(r, c))).join("\t"));
  if (headers) lines.unshift(headers.map(field).join("\t"));
  return lines.join(lineBreak());
}

/** Shrinks the ranges to the rows and columns there are; null when there are none. */
export function clampSelection(s: Selection | null, d: Dims): Selection | null {
  if (!s || d.rows === 0 || d.cols === 0) return null;
  const cl = (p: Pos): Pos => ({ r: Math.max(0, Math.min(d.rows - 1, p.r)), c: Math.max(0, Math.min(d.cols - 1, p.c)) });
  const ranges = s.ranges
    .filter((g) => norm(g).t < d.rows && norm(g).l < d.cols)
    .map((g) => {
      const n = norm(g);
      return { r0: n.t, c0: n.l, r1: Math.min(n.b, d.rows - 1), c1: Math.min(n.r, d.cols - 1) };
    });
  const active = cl(s.active);
  return { ranges: ranges.length ? ranges : [cellRange(active)], active, anchor: cl(s.anchor), end: cl(s.end), rows: s.rows && ranges.length > 0 };
}

/**
 * I3: the selection moved with its rows when the rows on screen change order (more rows loaded into a sorted
 * result). `from` and `to` give each position's row id before and after. Rows no longer on screen drop out; a
 * block whose rows are now apart becomes one range per run. Null when no selected row is left.
 */
export function remapRows(s: Selection | null, from: readonly number[], to: readonly number[]): Selection | null {
  if (!s) return null;
  const at = new Map<number, number>();
  to.forEach((id, i) => at.set(id, i));
  const move = (r: number) => at.get(from[r]) ?? -1;
  const ranges: Range[] = [];
  for (const g of s.ranges) {
    const n = norm(g);
    const rows: number[] = [];
    for (let r = n.t; r <= n.b; r++) {
      const p = move(r);
      if (p >= 0) rows.push(p);
    }
    rows.sort((a, b) => a - b);
    for (let i = 0; i < rows.length; ) {
      let j = i;
      while (j + 1 < rows.length && rows[j + 1] === rows[j] + 1) j++;
      ranges.push({ r0: rows[i], c0: n.l, r1: rows[j], c1: n.r });
      i = j + 1;
    }
  }
  if (!ranges.length) return null;
  const pos = (p: Pos): Pos => {
    const r = move(p.r);
    return r >= 0 ? { r, c: p.c } : { r: ranges[0].r0, c: p.c };
  };
  return { ...s, ranges, active: pos(s.active), anchor: pos(s.anchor), end: pos(s.end) };
}

/**
 * M1: a character typed with AltGr, which Windows reports as Ctrl+Alt (ń is AltGr+N on a Polish layout, @ is
 * AltGr+Q on a German one). It types; it is never a Ctrl+Alt shortcut.
 */
export function altGraph(e: { key: string; ctrlKey: boolean; altKey: boolean; getModifierState?: (k: "AltGraph") => boolean }): boolean {
  if (e.getModifierState?.("AltGraph")) return true;
  return e.ctrlKey && e.altKey && e.key.length === 1 && !/^[a-z0-9]$/i.test(e.key);
}

/** A shortcut letter: with Alt down only the key itself counts, so another layout's AltGr character never matches. */
export function isLetter(e: { key: string; code?: string; altKey: boolean }, l: string): boolean {
  return e.key.toLowerCase() === l || (!e.altKey && e.code === `Key${l.toUpperCase()}`);
}

export interface NavKey {
  key: string;
  code?: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/**
 * Movement and selection keys (Excel, Google Sheets): arrows, Tab, Home and End, PageUp and PageDown, Ctrl+A,
 * Shift+Space and Ctrl+Space. Shift extends from the anchor; Ctrl goes to the edge. `page` is how many rows a screen
 * holds. Null for every other key, which the grid handles itself.
 */
export function navigate(s: Selection | null, e: NavKey, d: Dims, page: number): Selection | null {
  if (d.rows === 0 || d.cols === 0 || e.altKey) return null;
  const ctrl = e.ctrlKey || e.metaKey;
  const cur = s ?? single({ r: 0, c: 0 });
  const clampR = (r: number) => Math.max(0, Math.min(d.rows - 1, r));
  const clampC = (c: number) => Math.max(0, Math.min(d.cols - 1, c));
  const go = (to: Pos, extend: boolean) => {
    const p = { r: clampR(to.r), c: clampC(to.c) };
    return extend && s ? extendTo(cur, p) : single(p);
  };
  const base = e.shiftKey ? cur.end : cur.active;
  if (ctrl && !e.shiftKey && (e.code === "KeyA" || e.key.toLowerCase() === "a")) return selectAll(d, cur.active);
  if (e.key === " " && ctrl) {
    const last = norm(cur.ranges[cur.ranges.length - 1] ?? cellRange(cur.active));
    return { ranges: [{ r0: 0, c0: last.l, r1: d.rows - 1, c1: last.r }], active: cur.active, anchor: { r: 0, c: last.l }, end: { r: d.rows - 1, c: last.r }, rows: false };
  }
  if (e.key === " " && e.shiftKey) {
    const last = norm(cur.ranges[cur.ranges.length - 1] ?? cellRange(cur.active));
    return { ...selectRows(null, last.t, last.b, false, d.cols), active: cur.active };
  }
  if (ctrl && !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return null;
  switch (e.key) {
    case "ArrowUp":
      return go({ r: ctrl ? 0 : base.r - 1, c: base.c }, e.shiftKey);
    case "ArrowDown":
      return go({ r: ctrl ? d.rows - 1 : base.r + 1, c: base.c }, e.shiftKey);
    case "ArrowLeft":
      return go({ r: base.r, c: ctrl ? 0 : base.c - 1 }, e.shiftKey);
    case "ArrowRight":
      return go({ r: base.r, c: ctrl ? d.cols - 1 : base.c + 1 }, e.shiftKey);
    case "Home":
      return go(ctrl ? { r: 0, c: 0 } : { r: base.r, c: 0 }, e.shiftKey);
    case "End":
      return go(ctrl ? { r: d.rows - 1, c: d.cols - 1 } : { r: base.r, c: d.cols - 1 }, e.shiftKey);
    case "PageDown":
      return go({ r: base.r + Math.max(1, page), c: base.c }, e.shiftKey);
    case "PageUp":
      return go({ r: base.r - Math.max(1, page), c: base.c }, e.shiftKey);
    case "Tab": {
      // Excel tables: Tab moves right and wraps to the next row; Shift+Tab goes back.
      let r = cur.active.r;
      let c = cur.active.c + (e.shiftKey ? -1 : 1);
      if (c >= d.cols) [r, c] = [Math.min(d.rows - 1, r + 1), r + 1 < d.rows ? 0 : d.cols - 1];
      if (c < 0) [r, c] = [Math.max(0, r - 1), r > 0 ? d.cols - 1 : 0];
      return single({ r, c });
    }
  }
  return null;
}
