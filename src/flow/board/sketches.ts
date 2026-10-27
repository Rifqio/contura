// Loose sketches on a board (Decisions 20 and 21): shapes, pen strokes, text, notes and Sections drawn outside every
// diagram frame. They live in the board layout file only, never in the .flow text. Every op here is pure: it returns
// the changes, and `useFlowDoc.sketch` applies them as one undo entry. A change holds the sketch before and after
// (its own small object; a move shares the points array), never a copy of the board's sketches.
import { cut, MAX_BOARD_SKETCH_TEXT, MAX_PEN_POINTS, MAX_SKETCH_POINTS, MAX_SKETCH_TEXT, MAX_SKETCHES, normalizeSketch, type Sketch, type SketchKind } from "./boardLayout";

export type { Sketch, SketchKind };

/**
 * One sketch before and after an op: `before` null for an add, `after` null for a delete. `at` is a deleted sketch's
 * place in the draw order, so the undo that brings it back puts it there (an add with none goes on top).
 */
export type SketchChange = { id: string; before: Sketch | null; after: Sketch | null; at?: number };

/** The layer node every sketch node is a child of, placed at `-origin` (Decision 21). */
export const SKETCH_LAYER_ID = "\u0000sketches";
const SKETCH_PREFIX = "\u0000sketch:";
/** A sketch's node id on the canvas. */
export const sketchNodeId = (id: string) => `${SKETCH_PREFIX}${id}`;
export const isSketchNodeId = (id: string) => id.startsWith(SKETCH_PREFIX);
/** The sketch id of a sketch node id; null for any other node. */
export const sketchIdOf = (nodeId: string) => (isSketchNodeId(nodeId) ? nodeId.slice(SKETCH_PREFIX.length) : null);

/** Sections and box sketches draw under every frame; the rest draw over the live frame (Decision 5, ruling C14). */
const UNDER: ReadonlySet<SketchKind> = new Set<SketchKind>(["section", "rect", "ellipse", "diamond"]);
export const drawsUnder = (kind: SketchKind) => UNDER.has(kind);

/** A sketch's kind as its accessible name says it. */
export const SKETCH_WORD: Record<SketchKind, string> = {
  rect: "Rectangle",
  ellipse: "Ellipse",
  diamond: "Diamond",
  line: "Line",
  arrow: "Arrow",
  pen: "Pen",
  text: "Text",
  note: "Note",
  section: "Section",
  icon: "Icon",
};

export const TOO_MANY_SKETCHES = "A board holds at most 1,000 sketches.";
export const TOO_MANY_POINTS = "A board holds at most 50,000 pen points. Erase some strokes first.";
export const TOO_MUCH_TEXT = "A board holds at most 100,000 characters of sketch text.";

/** A new sketch: everything but its id, which `addSketch` gives. */
export type NewSketch = Omit<Sketch, "id">;

/** The board's pen points and sketch text, in UTF-16 units as the parse counts them. */
function totals(all: readonly Sketch[]): { points: number; text: number } {
  let points = 0;
  let text = 0;
  for (const s of all) {
    points += s.points?.length ?? 0;
    text += s.text?.length ?? 0;
  }
  return { points, text };
}

/**
 * The highest `s<n>` given on each sketch list and the lists made from it by `applySketches`, so an id of a sketch
 * deleted since is never given again while its add or delete can still be undone. Held weakly by the list.
 */
const highWater = new WeakMap<readonly Sketch[], number>();

/** Ids are `s` and at most 15 digits, so `n + 1` is exact and the id stays far under the parse's 64 characters. */
const ID_FORM = /^s(\d{1,15})$/;

const idNumber = (id: string) => {
  const m = ID_FORM.exec(id);
  return m ? Number(m[1]) : 0;
};

/** The next id for `all`: one more than any `s<n>` the list has or had. */
export function nextSketchId(all: readonly Sketch[]): string {
  let n = highWater.get(all) ?? 0;
  for (const s of all) n = Math.max(n, idNumber(s.id));
  const taken = new Set(all.map((s) => s.id));
  let id = `s${n + 1}`;
  while (taken.has(id)) id = `s${++n + 1}`;
  return id;
}

/**
 * Every number of a new sketch is finite: its callers check this before `addSketch`, so the parse's refusal of the
 * rest (a NaN from a view with no size) is never their quiet no-op.
 */
export function finiteSketch(s: NewSketch): boolean {
  if (![s.x, s.y, s.w, s.h].every(Number.isFinite)) return false;
  return s.points?.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)) ?? true;
}

/**
 * Adds a sketch with the next id, made by the parse's own normaliser (`normalizeSketch`): what it holds is what the
 * file reopens as. A pen stroke past MAX_PEN_POINTS is simplified to fit first. Refused with its note when the board
 * would pass a cap (Decision 21), or with no note when it cannot be a sketch at all (a kind or number the file has no
 * place for).
 */
export function addSketch(all: readonly Sketch[], s: NewSketch): { change: SketchChange } | { refused: string } {
  if (all.length >= MAX_SKETCHES) return { refused: TOO_MANY_SKETCHES };
  const id = nextSketchId(all);
  const points = s.points && s.points.length > MAX_PEN_POINTS ? simplifyStroke(s.points, MAX_PEN_POINTS) : s.points;
  const after = normalizeSketch({ ...s, id, ...(points ? { points } : {}) });
  if (!after) return { refused: "" };
  const t = totals(all);
  if (after.points && t.points + after.points.length > MAX_SKETCH_POINTS) return { refused: TOO_MANY_POINTS };
  if (after.text && t.text + after.text.length > MAX_BOARD_SKETCH_TEXT) return { refused: TOO_MUCH_TEXT };
  return { change: { id, before: null, after } };
}

/** A sketch's text (empty takes it away), within the board's text budget; null when no sketch has `id` or the text is the same. */
export function setSketchText(all: readonly Sketch[], id: string, text: string): { change: SketchChange } | { refused: string } | null {
  const before = all.find((s) => s.id === id);
  if (!before) return null;
  const next = cut(text, MAX_SKETCH_TEXT);
  if ((before.text ?? "") === next) return null;
  const others = totals(all).text - (before.text?.length ?? 0);
  if (others + next.length > MAX_BOARD_SKETCH_TEXT) return { refused: TOO_MUCH_TEXT };
  const after = normalizeSketch({ ...before, text: next });
  if (!after) return null;
  return { change: { id, before, after } };
}

/** The sketches `ids` moved by (dx, dy): their points are relative to their box, so a move shares them. */
export function moveSketches(all: readonly Sketch[], ids: Iterable<string>, dx: number, dy: number): SketchChange[] {
  const want = new Set(ids);
  const out: SketchChange[] = [];
  const mx = Math.round(dx);
  const my = Math.round(dy);
  if (mx === 0 && my === 0) return out;
  // Whole steps on whole numbers: the moved sketch stays one the parse keeps as it is.
  for (const s of all) if (want.has(s.id)) out.push({ id: s.id, before: s, after: { ...s, x: s.x + mx, y: s.y + my } });
  return out;
}

/** The sketches `ids` deleted. */
export function removeSketches(all: readonly Sketch[], ids: Iterable<string>): SketchChange[] {
  const want = new Set(ids);
  const out: SketchChange[] = [];
  all.forEach((s, at) => {
    if (want.has(s.id)) out.push({ id: s.id, before: s, after: null, at });
  });
  return out;
}

/** The changes that take `changes` back, in reverse order. */
export function invertSketchChanges(changes: readonly SketchChange[]): SketchChange[] {
  const out: SketchChange[] = [];
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i];
    out.push(c.at === undefined ? { id: c.id, before: c.after, after: c.before } : { id: c.id, before: c.after, after: c.before, at: c.at });
  }
  return out;
}

/**
 * The sketch list with `changes` made: a changed sketch keeps its place (its draw order), a deleted one goes, and an
 * added one goes on top, or back at its `at` (an undone delete; lowest first, so several land where they were). A change whose `before` is not the sketch there now still sets `after` (undo is exact by id).
 * The other sketches are the same objects, so the board scene rebuilds only the changed nodes.
 */
export function applySketches(all: readonly Sketch[], changes: readonly SketchChange[]): Sketch[] {
  if (changes.length === 0) return all as Sketch[];
  const last = new Map<string, Sketch | null>();
  const place = new Map<string, number | undefined>();
  for (const c of changes) {
    last.set(c.id, c.after);
    place.set(c.id, c.at);
  }
  const out: Sketch[] = [];
  const seen = new Set<string>();
  for (const s of all) {
    if (!last.has(s.id)) {
      out.push(s);
      continue;
    }
    seen.add(s.id);
    const next = last.get(s.id);
    if (next) out.push(next);
  }
  const back: { at: number; s: Sketch }[] = [];
  const top: Sketch[] = [];
  for (const [id, next] of last) {
    if (!next || seen.has(id)) continue;
    const at = place.get(id);
    if (at === undefined) top.push(next);
    else back.push({ at, s: next });
  }
  back.sort((a, b) => a.at - b.at);
  for (const { at, s } of back) out.splice(Math.min(at, out.length), 0, s);
  for (const s of top) out.push(s);
  let n = highWater.get(all) ?? 0;
  for (const c of changes) n = Math.max(n, idNumber(c.id));
  highWater.set(out, n);
  return out;
}

/** Squared distance from `p` to the segment a-b. */
function segmentDist2(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0];
  const y = a[1] + t * dy - p[1];
  return x * x + y * y;
}

/** Ramer-Douglas-Peucker at `eps`, without recursion (a long stroke never deepens the stack). */
function rdp(points: readonly [number, number][], eps: number): [number, number][] {
  const n = points.length;
  if (n <= 2) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const eps2 = eps * eps;
  const stack: number[] = [0, n - 1];
  while (stack.length) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    let far = -1;
    let most = eps2;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDist2(points[i], points[a], points[b]);
      if (d > most) {
        most = d;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push(a, far, far, b);
    }
  }
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * A pen stroke simplified on release (Decision 21): Ramer-Douglas-Peucker at 1 px, the tolerance doubled until at
 * most `max` points are left. The first and last points always stay.
 */
export function simplifyStroke(points: readonly [number, number][], max: number): [number, number][] {
  const limit = Math.max(2, max);
  let eps = 1;
  let out = rdp(points, eps);
  while (out.length > limit) {
    eps *= 2;
    out = rdp(points, eps);
  }
  return out;
}

/** The ids of the sketches wholly inside `section`'s box, the Section itself left out (Decision 20). */
export function sketchesInside(all: readonly Sketch[], section: Sketch): string[] {
  const x1 = section.x + section.w;
  const y1 = section.y + section.h;
  const out: string[] = [];
  for (const s of all) {
    if (s.id === section.id) continue;
    if (s.x >= section.x && s.y >= section.y && s.x + s.w <= x1 && s.y + s.h <= y1) out.push(s.id);
  }
  return out;
}

/**
 * One sketch changed by `patch` (a resize, new ends, a colour), made by the parse's own normaliser, so the change holds
 * what the file reopens as. Null when no sketch has `id`, the patch cannot be a sketch, or nothing changes.
 */
export function changeSketch(all: readonly Sketch[], id: string, patch: Partial<Omit<Sketch, "id" | "kind">>): SketchChange | null {
  const before = all.find((s) => s.id === id);
  if (!before) return null;
  const next: Record<string, unknown> = { ...before, ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === null) delete next[k];
  const after = normalizeSketch(next);
  if (!after) return null;
  if (JSON.stringify(after) === JSON.stringify(before)) return null;
  return { id, before, after };
}

/** The sketches `ids` given `color` (null takes it away), one change each where it differs. */
export function setSketchColour(all: readonly Sketch[], ids: Iterable<string>, color: string | null): SketchChange[] {
  const out: SketchChange[] = [];
  for (const id of new Set(ids)) {
    const c = changeSketch(all, id, { color: color ?? undefined });
    if (c) out.push(c);
  }
  return out;
}

/**
 * A line, arrow or pen stroke through board points `abs`: its box is the points' bounds and its points are relative to
 * that box (Task 11's convention), all whole numbers.
 */
export function strokeBox(abs: readonly { x: number; y: number }[]): Pick<Sketch, "x" | "y" | "w" | "h" | "points"> {
  const pts = abs.map((p) => [Math.round(p.x), Math.round(p.y)] as [number, number]);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, points: pts.map(([x, y]) => [x - x0, y - y0]) };
}

/** The key a sketch copy's JSON holds its sketches under on the clipboard (the app's clipboard, as text). */
export const SKETCH_CLIP = "contura.sketches";

/**
 * The clipboard text for sketches: JSON, their ids left out (a paste gives fresh ones). Shapes copied with them keep
 * their .flow lines, as `text`.
 */
export function sketchClipText(list: readonly Sketch[], text?: string, at?: Record<string, { x: number; y: number }>): string {
  return JSON.stringify({ [SKETCH_CLIP]: list.map(({ id: _id, ...rest }) => rest), ...(text ? { text, ...(at ? { at } : {}) } : {}) });
}

export type SketchClip = { sketches: NewSketch[]; text?: string; at?: Record<string, { x: number; y: number }> };

/**
 * The sketches a clipboard text holds, the shapes' lines copied with them, and those shapes' top lefts on the board
 * (`at`, by the names the lines give them); null when it is not a sketch copy.
 */
export function readSketchClip(text: string): SketchClip | null {
  if (!text.startsWith("{") || !text.includes(SKETCH_CLIP)) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const list = typeof v === "object" && v !== null ? (v as Record<string, unknown>)[SKETCH_CLIP] : null;
  if (!Array.isArray(list)) return null;
  const out: NewSketch[] = [];
  for (const raw of list) {
    // The parse's normaliser decides what a sketch is; the id it needs is a stand-in that addSketch replaces.
    const s = normalizeSketch(typeof raw === "object" && raw !== null ? { ...raw, id: "clip" } : null);
    if (!s) continue;
    const { id: _id, ...rest } = s;
    out.push(rest);
  }
  const r = v as Record<string, unknown>;
  if (typeof r.text !== "string" || r.text === "") return { sketches: out };
  const at: Record<string, { x: number; y: number }> = Object.create(null);
  if (typeof r.at === "object" && r.at !== null && !Array.isArray(r.at))
    for (const [k, p] of Object.entries(r.at as Record<string, unknown>)) {
      const q = p as { x?: unknown; y?: unknown } | null;
      if (q && typeof q.x === "number" && typeof q.y === "number" && Number.isFinite(q.x) && Number.isFinite(q.y)) at[k] = { x: q.x, y: q.y };
    }
  return { sketches: out, text: r.text, at };
}

/**
 * Sketches added together (a paste), each with a fresh id, as one list of changes; all or none, with the note of the
 * first cap they would pass.
 */
export function addSketches(all: readonly Sketch[], list: readonly NewSketch[]): { changes: SketchChange[] } | { refused: string } {
  let now: readonly Sketch[] = all;
  const changes: SketchChange[] = [];
  for (const s of list) {
    const r = addSketch(now, s);
    if ("refused" in r) {
      if (r.refused === "") continue;
      return { refused: r.refused };
    }
    changes.push(r.change);
    now = applySketches(now, [r.change]);
  }
  return { changes };
}

/**
 * `changes` as they can be made on `all` now. Sketches added in them whose ids another sketch took since they were
 * picked (one drawn while the worker planned a paste) get fresh ids; `applySketches` would otherwise overwrite that
 * sketch. The same array when every id is still free.
 */
export function freeSketchIds(all: readonly Sketch[], changes: SketchChange[]): { changes: SketchChange[] } | { refused: string } {
  const taken = new Set(all.map((s) => s.id));
  if (!changes.some((c) => c.before === null && taken.has(c.id))) return { changes };
  const kept = changes.filter((c) => c.before !== null);
  const added: NewSketch[] = [];
  for (const c of changes) {
    if (c.before !== null || c.after === null) continue;
    const { id: _id, ...rest } = c.after;
    added.push(rest);
  }
  const r = addSketches(applySketches(all, kept), added);
  return "refused" in r ? r : { changes: [...kept, ...r.changes] };
}
