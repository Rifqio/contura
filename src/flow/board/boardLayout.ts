// The board layout file, `<name>.flow.layout.json`, for a file of several diagram frames: where each frame sits, its
// node positions and look, and the sketches drawn between the frames (Decisions 4, 6, 11 and 21). A one-frame file
// with no sketches and no frame settings is still written as version 1, byte for byte as before.
import type { Positions, Viewport } from "../../diagram/layout";
import type { Edge, Node } from "@xyflow/react";
import { type DiagramKind, FIXED_KINDS, type FlowDoc, shownName } from "../../lang/flow/model";
import { buildFlowGraph, drawnKind, type GraphOptions, nodeSize } from "../flowNodes";
import {
  defaultDirection,
  emptyPositions,
  type FlowDirection,
  type FlowLayout,
  isPoint,
  readFlowParts,
  serializeFlowLayout,
  sortedAxes,
  sortedNodes,
  sortedSizes,
} from "../layout";
import type { NodeLook } from "../nodes/parts";

export type ErNotation = "crow" | "arrow";
export type TextSize = "s" | "m" | "l";

/** One frame's place on the board and its own settings; `nodes` are relative to `at`. */
export interface FrameLayout {
  at: { x: number; y: number };
  nodes: Positions;
  sizes?: FlowLayout["sizes"];
  axes?: FlowLayout["axes"];
  style: NodeLook;
  direction: FlowDirection;
  notation?: ErNotation;
  textSize?: TextSize;
}

export type SketchKind = "rect" | "ellipse" | "diamond" | "line" | "arrow" | "pen" | "text" | "note" | "section" | "icon";
export const SKETCH_KINDS: ReadonlySet<string> = new Set<SketchKind>(["rect", "ellipse", "diamond", "line", "arrow", "pen", "text", "note", "section", "icon"]);

/** A drawn thing in board coordinates, whole numbers. */
export interface Sketch {
  id: string;
  kind: SketchKind;
  x: number;
  y: number;
  w: number;
  h: number;
  points?: [number, number][];
  text?: string;
  color?: string;
  /** The pack name an icon sketch draws; read only on `kind: "icon"`. Its title is looked up at draw time, never stored. */
  icon?: string;
}

export const MAX_SKETCHES = 1_000;
export const MAX_PEN_POINTS = 1_000;
export const MAX_SKETCH_POINTS = 50_000;
export const MAX_SKETCH_TEXT = 2_000;
export const MAX_BOARD_SKETCH_TEXT = 100_000;
/** The most the layout file may hold when saved, in UTF-8 bytes; the Core refuses to open one past 5 MB. */
export const LAYOUT_SAVE_MAX = 4.5 * 1024 * 1024;
/** A sketch's id and colour are short; a longer one is a hand-edited file and the sketch is dropped. */
const MAX_SKETCH_ID = 64;
const MAX_SKETCH_COLOR = 32;
const MAX_ICON_NAME = 100;
const ICON_NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface BoardLayout {
  viewport?: Viewport;
  /** By frame title. Entries of titles no frame has stay (undo brings the frame back); the file leaves them out. */
  frames: Map<string, FrameLayout>;
  sketches: Sketch[];
}

export const utf8Length = (s: string) => new TextEncoder().encode(s).length;

function defaultFrame(kind: DiagramKind | null): FrameLayout {
  return { at: { x: 0, y: 0 }, nodes: emptyPositions(), style: "modern", direction: defaultDirection(kind) };
}

function readViewport(v: unknown): Viewport | undefined {
  const zoom = (v as { zoom?: unknown } | undefined)?.zoom;
  return isPoint(v) && typeof zoom === "number" && Number.isFinite(zoom) ? { x: v.x, y: v.y, zoom } : undefined;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** `s` cut to `max` UTF-16 units, never in the middle of a surrogate pair. */
export function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const end = max > 0 && s.charCodeAt(max - 1) >= 0xd800 && s.charCodeAt(max - 1) <= 0xdbff ? max - 1 : max;
  return s.slice(0, end);
}

/**
 * A sketch as the file keeps it, or null when it cannot be one: whole numbers, points only on pen, line and arrow
 * (at most MAX_PEN_POINTS), text cut to MAX_SKETCH_TEXT, no empty text, no colour over 32 characters, an id under 64.
 * The one normaliser: the parse reads with it and every sketch op makes its sketches with it, so what an op holds is
 * what the file reopens as.
 */
export function normalizeSketch(v: unknown): Sketch | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id === "" || r.id.length > MAX_SKETCH_ID) return null;
  if (typeof r.kind !== "string" || !SKETCH_KINDS.has(r.kind)) return null;
  if (!num(r.x) || !num(r.y) || !num(r.w) || !num(r.h)) return null;
  const s: Sketch = { id: r.id, kind: r.kind as SketchKind, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
  if (Array.isArray(r.points) && (r.kind === "pen" || r.kind === "line" || r.kind === "arrow")) {
    const points: [number, number][] = [];
    for (const p of r.points) {
      if (points.length >= MAX_PEN_POINTS) break;
      if (Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1])) points.push([Math.round(p[0]), Math.round(p[1])]);
    }
    if (points.length) s.points = points;
  }
  if (r.kind === "icon") {
    if (typeof r.icon !== "string" || r.icon.length > MAX_ICON_NAME || !ICON_NAME.test(r.icon)) return null;
    s.icon = r.icon;
  }
  if (r.kind !== "icon" && typeof r.text === "string" && r.text !== "") s.text = cut(r.text, MAX_SKETCH_TEXT);
  if (typeof r.color === "string" && r.color !== "" && r.color.length <= MAX_SKETCH_COLOR) s.color = r.color;
  return s;
}

/** The sketches of a file: bad ones dropped, then the count, then the board's point and text budgets in order. */
function readSketches(raw: unknown): Sketch[] {
  if (!Array.isArray(raw)) return [];
  const out: Sketch[] = [];
  const ids = new Set<string>();
  let points = 0;
  let text = 0;
  for (const v of raw) {
    if (out.length >= MAX_SKETCHES) break;
    const s = normalizeSketch(v);
    if (!s || ids.has(s.id)) continue;
    ids.add(s.id);
    if (s.points) {
      s.points = s.points.slice(0, MAX_SKETCH_POINTS - points);
      points += s.points.length;
      if (!s.points.length) delete s.points;
    }
    if (s.text !== undefined) {
      if (text + s.text.length > MAX_BOARD_SKETCH_TEXT) delete s.text;
      else text += s.text.length;
    }
    out.push(s);
  }
  return out;
}

/**
 * Never throws: a missing or unreadable file reads as the defaults. Version 1 is frame 0's entry at (0, 0); version 2
 * has every frame's entry by title. Only entries the file holds are made: a frame without one has none in `frames`
 * (Task 4 places it), and `frameLayoutView` gives it its kind's defaults.
 */
export function parseBoardLayout(json: string | null, frames: readonly { title: string; kind: DiagramKind | null }[]): BoardLayout {
  const out: BoardLayout = { frames: new Map(), sketches: [] };
  const kindOf = new Map<string, DiagramKind | null>();
  for (const f of frames) if (!kindOf.has(f.title)) kindOf.set(f.title, f.kind);
  let raw: unknown;
  try {
    raw = json ? JSON.parse(json) : null;
  } catch {
    return out;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (r.version === 1) {
    const first = frames[0];
    if (first) {
      const read = readFlowParts(r, { version: 1, nodes: emptyPositions(), style: "modern", direction: defaultDirection(first.kind) });
      const entry: FrameLayout = { at: { x: 0, y: 0 }, nodes: read.nodes, style: read.style, direction: read.direction };
      if (read.sizes) entry.sizes = read.sizes;
      if (read.axes) entry.axes = read.axes;
      out.frames.set(first.title, entry);
    }
    const vp = readViewport(r.viewport);
    if (vp) out.viewport = vp;
    return out;
  }
  if (r.version !== 2) return out;
  const vp = readViewport(r.viewport);
  if (vp) out.viewport = vp;
  if (typeof r.frames === "object" && r.frames !== null && !Array.isArray(r.frames)) {
    for (const [title, v] of Object.entries(r.frames)) {
      if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
      const e = v as Record<string, unknown>;
      const read = readFlowParts(e, { version: 1, nodes: emptyPositions(), style: "modern", direction: defaultDirection(kindOf.get(title) ?? null) });
      const entry: FrameLayout = { at: isPoint(e.at) ? { x: e.at.x, y: e.at.y } : { x: 0, y: 0 }, nodes: read.nodes, style: read.style, direction: read.direction };
      if (read.sizes) entry.sizes = read.sizes;
      if (read.axes) entry.axes = read.axes;
      if (e.notation === "crow" || e.notation === "arrow") entry.notation = e.notation;
      if (e.textSize === "s" || e.textSize === "m" || e.textSize === "l") entry.textSize = e.textSize;
      out.frames.set(title, entry);
    }
  }
  out.sketches = readSketches(r.sketches);
  return out;
}

const hasSettings = (e: FrameLayout) => e.notation !== undefined || e.textSize !== undefined;

/**
 * The file text. Version 1 when the board is one frame with no sketches and no frame settings (a moved frame folds
 * into its node positions); otherwise version 2. Entries of titles not in `live` are left out unless `keepAll` (a
 * header that fails to read must never drop a frame's positions). A frame with no entry is not written in version 2.
 */
export function serializeBoardLayout(
  b: BoardLayout,
  live: ReadonlySet<string>,
  keepAll: boolean,
  /** The frames' kinds by title, for the default direction of a live frame that has no entry (version 1 only). */
  kinds: ReadonlyMap<string, DiagramKind | null>,
): string {
  const entries = [...b.frames].filter(([title]) => keepAll || live.has(title)).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  if (live.size === 1 && b.sketches.length === 0 && entries.every(([title, e]) => live.has(title) && !hasSettings(e))) {
    const e = entries[0]?.[1] ?? defaultFrame(kinds.get([...live][0]) ?? null);
    const nodes = emptyPositions();
    for (const [k, p] of Object.entries(e.nodes)) nodes[k] = { x: p.x + e.at.x, y: p.y + e.at.y };
    const one: FlowLayout = { version: 1, nodes, style: e.style, direction: e.direction };
    if (b.viewport) one.viewport = b.viewport;
    if (e.sizes) one.sizes = e.sizes;
    if (e.axes) one.axes = e.axes;
    return serializeFlowLayout(one);
  }
  const frames = Object.create(null) as Record<string, unknown>;
  for (const [title, e] of entries) {
    const o: Record<string, unknown> = { at: { x: e.at.x, y: e.at.y }, nodes: sortedNodes(e.nodes) };
    const sizes = sortedSizes(e.sizes);
    if (sizes) o.sizes = sizes;
    const axes = sortedAxes(e.axes);
    if (axes) o.axes = axes;
    o.style = e.style;
    o.direction = e.direction;
    if (e.notation) o.notation = e.notation;
    if (e.textSize) o.textSize = e.textSize;
    frames[title] = o;
  }
  const out: Record<string, unknown> = { version: 2 };
  if (b.viewport) out.viewport = b.viewport;
  out.frames = frames;
  out.sketches = b.sketches.map((s) => {
    const o: Record<string, unknown> = { id: s.id, kind: s.kind, x: Math.round(s.x), y: Math.round(s.y), w: Math.round(s.w), h: Math.round(s.h) };
    if (s.points) o.points = s.points.map(([x, y]) => [Math.round(x), Math.round(y)]);
    if (s.text !== undefined) o.text = s.text;
    if (s.color !== undefined) o.color = s.color;
    if (s.kind === "icon" && s.icon !== undefined) o.icon = s.icon;
    return o;
  });
  return `${writeJson(out, "")}\n`;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * 2-space pretty JSON with a point pair `[x, y]` and an `{ "x", "y" }` leaf on one line, so a pen stroke costs about 12
 * bytes a point, not 40. Written structurally: every string goes through JSON.stringify, and no text is ever rewritten.
 */
function writeJson(v: unknown, indent: string): string {
  if (Array.isArray(v)) {
    if (v.length === 2 && isNum(v[0]) && isNum(v[1])) return `[${v[0]}, ${v[1]}]`;
    if (v.length === 0) return "[]";
    const inner = `${indent}  `;
    return `[\n${v.map((x) => `${inner}${writeJson(x, inner)}`).join(",\n")}\n${indent}]`;
  }
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined);
    if (keys.length === 2 && keys[0] === "x" && keys[1] === "y" && isNum(o.x) && isNum(o.y)) return `{ "x": ${o.x}, "y": ${o.y} }`;
    if (keys.length === 0) return "{}";
    const inner = `${indent}  `;
    return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${writeJson(o[k], inner)}`).join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * What a frame's canvas reads: the frame's entry (its kind's defaults when it has none) with the board's viewport. The
 * `nodes`, `sizes` and `axes` are the entry's own objects: a caller that edits them edits the board.
 */
export function frameLayoutView(b: BoardLayout, key: string, kind: DiagramKind | null): FlowLayout {
  const e = b.frames.get(key) ?? defaultFrame(kind);
  const out: FlowLayout = { version: 1, nodes: e.nodes, style: e.style, direction: e.direction };
  if (b.viewport) out.viewport = b.viewport;
  if (e.sizes) out.sizes = e.sizes;
  if (e.axes) out.axes = e.axes;
  return out;
}

/** The gap between frames on the board: a new frame and a frame's copy go this far right of the box beside them. */
export const FRAME_GAP = 80;

/** Where a new frame goes: right of the rightmost box, at the top of the boxes; the origin on an empty board. */
export function placeNewFrame(boxes: readonly { x: number; y: number; w: number; h: number }[]): { x: number; y: number } {
  if (boxes.length === 0) return { x: 0, y: 0 };
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  for (const b of boxes) {
    right = Math.max(right, b.x + b.w);
    top = Math.min(top, b.y);
  }
  return { x: right + FRAME_GAP, y: top };
}

export const FRAME_PAD = 40;
export const FRAME_MIN = { w: 320, h: 200 };
/** A frame's text size as a label scale (Decision 22). */
export const TEXT_SCALE: Record<TextSize, number> = { s: 0.88, m: 1, l: 1.15 };

/**
 * The layout a frame whose title an earlier frame has is drawn with (Decision 9): it has no entry of its own, so
 * `useFlowDoc` lays it out for drawing only, by frame index, and never saves it. `title` is the frame's title when it
 * was made: a layout made for another frame at that index is not used.
 */
export type ClashLayout = { title: string; entry: FrameLayout };

type Rect = { x: number; y: number; w: number; h: number };

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * What a frame draws, in frame-local positions: its graph as the canvas builds it, with the entry's sizes, axes and
 * text size. A node with no place is not drawn (FlowTab places it), unless `placeAll`: then it stands in a row under
 * the placed ones, as `useFlowDoc` places nodes when the layout call fails.
 */
export function frameGraph(entry: FrameLayout | undefined, doc: FlowDoc, look: NodeLook, placeAll = false): { nodes: Node[]; edges: Edge[] } {
  const scale = TEXT_SCALE[entry?.textSize ?? "m"];
  const opts: GraphOptions = {};
  if (scale !== 1) opts.textScale = scale;
  if (entry?.notation === "arrow") opts.notation = "arrow";
  if (FIXED_KINDS.has(doc.kind)) return buildFlowGraph(doc, entry?.nodes ?? emptyPositions(), look, opts);
  if (entry?.sizes) opts.sizes = entry.sizes;
  if (entry?.axes) opts.axes = entry.axes;
  let at = entry?.nodes ?? emptyPositions();
  if (placeAll && doc.nodes.some((n) => !own(at, n.name))) {
    const out = Object.assign(emptyPositions(), at);
    let below = 0;
    for (const n of doc.nodes) if (own(at, n.name)) below = Math.max(below, at[n.name].y);
    below += 200;
    let x = 0;
    for (const n of doc.nodes) {
      if (own(at, n.name)) continue;
      out[n.name] = { x, y: below };
      x += nodeSize(drawnKind(n.kind, doc.kind, n.name), look, shownName(n), n.attrs.id, n, scale).w + 40;
    }
    at = out;
  }
  const placed = doc.nodes.filter((n) => own(at, n.name));
  return buildFlowGraph(placed.length === doc.nodes.length ? doc : { ...doc, nodes: placed }, at, look, opts);
}

const widthOf = (n: Node) => {
  const s = n.style?.width;
  return n.measured?.width ?? n.width ?? (typeof s === "number" ? s : undefined) ?? n.initialWidth ?? 0;
};
const heightOf = (n: Node) => {
  const s = n.style?.height;
  return n.measured?.height ?? n.height ?? (typeof s === "number" ? s : undefined) ?? n.initialHeight ?? 0;
};

/**
 * A frame's box around drawn nodes (Decision 4): their bounds plus FRAME_PAD, at least FRAME_MIN; FRAME_MIN at (0, 0)
 * when none is drawn. In the nodes' own coordinates.
 */
export function drawnBox(nodes: readonly Node[]): Rect {
  if (nodes.length === 0) return { x: 0, y: 0, ...FRAME_MIN };
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const n of nodes) {
    x0 = Math.min(x0, n.position.x);
    y0 = Math.min(y0, n.position.y);
    x1 = Math.max(x1, n.position.x + widthOf(n));
    y1 = Math.max(y1, n.position.y + heightOf(n));
  }
  x0 -= FRAME_PAD;
  y0 -= FRAME_PAD;
  x1 += FRAME_PAD;
  y1 += FRAME_PAD;
  return { x: x0, y: y0, w: Math.max(FRAME_MIN.w, x1 - x0), h: Math.max(FRAME_MIN.h, y1 - y0) };
}

/**
 * A frame's box in board coordinates (Decision 4): `drawnBox` of what `frameGraph` draws (shapes, group areas, empty
 * groups' areas, a sequence's loop boxes, a timeline's sections and axis), from `entry.at`. The board scene draws the
 * same box, so placement and the canvas agree.
 */
export function frameBounds(entry: FrameLayout, doc: FlowDoc | null, look: NodeLook, placeAll = false): Rect {
  // Placement measures every frame on each placement: a frame's box is kept while its entry, doc and look are the
  // same objects (entries and their parts are replaced, never edited in place), so that costs no graph build. Held
  // weakly by both the entry and the doc: an entry an undo entry still holds must not keep the doc it was measured on
  // alive (Task 15 measured 76 KB a history entry at the limit).
  const kept = boundsKept.get(entry);
  const was = kept?.get(doc ?? NO_DOC);
  if (was && was.look === look && was.placeAll === placeAll && was.at === entry.at) return was.box;
  const r = doc ? drawnBox(frameGraph(entry, doc, look, placeAll).nodes) : drawnBox([]);
  const box = { x: entry.at.x + r.x, y: entry.at.y + r.y, w: r.w, h: r.h };
  const byDoc = kept ?? new WeakMap<object, KeptBounds>();
  if (!kept) boundsKept.set(entry, byDoc);
  byDoc.set(doc ?? NO_DOC, { look, placeAll, at: entry.at, box });
  return box;
}

type KeptBounds = { look: NodeLook; placeAll: boolean; at: FrameLayout["at"]; box: Rect };
/** The key of a frame drawn with no doc. */
const NO_DOC = {};
const boundsKept = new WeakMap<FrameLayout, WeakMap<object, KeptBounds>>();
