// Step 12, item 19: sizes of the newer kinds' shapes, and the layouts the canvas works out from the text alone.
// A sequence runs down the page in message order, a mind map grows out from its root by the indents, and a
// timeline runs along one line in the order the text writes it. Those three are laid out here every time the
// text changes; the other kinds are laid out by dagre and dragged as the older kinds are.
import type { Positions } from "../diagram/layout";
import type { DrawnKind } from "../diagram/types";
import type { FlowDoc, FlowNode } from "../lang/flow/model";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
/** About 7 px a character of the body font, 7.2 of Code small. */
const textW = (s: string) => s.length * 7;
const CODE_CHAR = 7.2;
const codeW = (s: string) => s.length * CODE_CHAR;

/** A card row (an ER column, a class member). */
export const KIND_ROW = 22;
/** An ER card shows at most this many rows; the rest scroll inside it. */
export const ER_MAX_ROWS = 20;
/** An ER card's height without its rows: 2 px of border, the 32 px header and 3 px above and below the rows. */
export const ER_CARD_CHROME = 40;
/**
 * ER build C: where a relationship meets row `row` of an ER card `top` px down a card `h` tall, its rows scrolled by
 * `scroll`: the middle of the row (1 px of border, the 32 px header, 3 px above the rows). A row scrolled out of
 * view puts the end on the card's top or bottom edge, whichever the row is past (fix round 1, DataGrip and
 * dbdiagram). Row -1 is the header, where a line to the whole table meets it.
 */
export function erRowY(top: number, h: number, row: number, scroll = 0): number {
  if (row < 0) return top + 17;
  const y = 47 + row * KIND_ROW - scroll;
  if (y < 36) return top;
  if (y > h - 4) return top + h;
  return top + y;
}
/** ER build C: the row of `column` among an ER table's rows ("customer_id int"), or -1 (the header) when absent. */
export function erColumnRow(rows: readonly string[], column: string | undefined): number {
  if (column === undefined) return -1;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const next = row.charCodeAt(column.length);
    if (row.startsWith(column) && (row.length === column.length || next === 32 || next === 9)) return r;
  }
  return -1;
}
/** An ER card's width bounds (board ER interactions); a longer name ends in an ellipsis with its tip. */
const ER_MIN_W = 184;
const ER_MAX_W = 300;
/** A column row's own width: its name and type in Code small, then the gutter, gaps, type padding and not-null mark. */
const erRowWidth = (row: string) => {
  const at = row.search(/\s/);
  const chars = at < 0 ? row.length : at + row.slice(at + 1).trim().length;
  return Math.ceil(chars * CODE_CHAR + 92);
};
/** A sequence message row, and the participant header above the lifelines. */
export const SEQ_ROW = 44;
export const SEQ_HEAD = 40;
/** Room between the participant boxes and the first message, so its label clears the boxes. */
const SEQ_PAD = 16;
/** Room above a frame's first message for its tab, and below its last message. */
const FRAME_TAB = 28;
const FRAME_FOOT = 10;
/** Room between participants, between timeline items, and between mind map levels. */
const SEQ_GAP = 72;
const TIME_STEP = 176;
const MIND_STEP = 64;

/** A class member is a method when it has brackets: it goes in the card's third part. */
export const isMethod = (row: string) => row.includes("(");

/** The size of a step 12 shape, from its words and rows (flow-canvas.css draws them at these sizes). */
export function kindSize(kind: DrawnKind, n: Pick<FlowNode, "name" | "rows" | "text" | "depth">): { w: number; h: number } | null {
  const rows = n.rows ?? [];
  switch (kind) {
    case "document":
    case "database":
      return { w: 150, h: 52 };
    case "erTable":
    case "erWeak":
      // As wide as its longest row (name, type, key gutter and not-null mark) within 184 to 300 px, and as tall as
      // its rows; past 20 columns the card stops growing and its rows scroll inside it (board ER interactions).
      return {
        w: clamp(Math.max(textW(n.name) + 48, ...rows.map(erRowWidth)), ER_MIN_W, ER_MAX_W),
        h: ER_CARD_CHROME + Math.min(Math.max(rows.length, 1), ER_MAX_ROWS) * KIND_ROW,
      };
    case "class":
    case "interface":
    case "enum": {
      const stereotype = kind === "class" ? 0 : 14;
      const fields = rows.filter((r) => kind === "enum" || !isMethod(r)).length;
      const methods = kind === "enum" ? 0 : rows.filter(isMethod).length;
      const parts = kind === "enum" ? Math.max(fields, 1) * KIND_ROW + 8 : Math.max(fields, 0.5) * KIND_ROW + Math.max(methods, 0.5) * KIND_ROW + 16;
      return { w: clamp(Math.max(textW(n.name) + 40, ...rows.map((r) => codeW(r) + 28)), 160, 340), h: 32 + stereotype + parts };
    }
    case "state":
      return { w: clamp(textW(n.name) + 40, 96, 280), h: 40 };
    case "choice":
      return { w: 64, h: 64 };
    case "fork":
      return { w: 112, h: 10 };
    case "stateStart":
      return { w: 22, h: 22 };
    case "stateEnd":
      return { w: 26, h: 26 };
    case "participant":
    case "actor":
      return { w: clamp(textW(n.name) + 40, 120, 260), h: SEQ_HEAD };
    case "root":
      return { w: clamp(textW(n.name) + 48, 120, 300), h: 44 };
    case "topic":
      return (n.depth ?? 1) <= 1 ? { w: clamp(textW(n.name) + 32, 80, 260), h: 34 } : { w: clamp(textW(n.name) + 20, 60, 240), h: 28 };
    case "event":
    case "period":
    case "milestone":
      return { w: 152, h: 52 };
    case "note": {
      const text = n.text ?? n.name;
      const lines = Math.max(1, Math.ceil(text.length / 26));
      return { w: 200, h: 20 + lines * 18 };
    }
    default:
      return null;
  }
}

/** A box on the canvas. */
export type KindBox = { x: number; y: number; w: number; h: number };

/** Where every node of a fixed kind goes, its size, and the drawn extras (frames, lifelines, the time axis). */
export interface FixedLayout {
  positions: Positions;
  sizes: Map<string, { w: number; h: number }>;
  /** Sequence: how long each lifeline runs, each frame's box, and each message row's middle (from the top). */
  lifeline?: number;
  rows?: number[];
  frames?: { label: string; box: KindBox; depth: number }[];
  /** Timeline: the axis and each section's band. */
  axis?: KindBox;
  sections?: { name: string; box: KindBox }[];
  /** Timeline: where each item meets the axis, by name. */
  ticks?: Map<string, { x: number; above: boolean }>;
}

const pos = (): Positions => Object.create(null) as Positions;

/** Participants in a row, in the order they are written; a message row each, top to bottom. */
function sequenceLayout(doc: FlowDoc, size: (n: FlowNode) => { w: number; h: number }): FixedLayout {
  const positions = pos();
  const sizes = new Map<string, { w: number; h: number }>();
  // Each message row is SEQ_ROW tall; a frame that opens on a row adds room for its tab above it, and one that
  // closes adds a little below, so a tab never sits on a message or its label.
  const frameList = doc.frames ?? [];
  const rows: number[] = [];
  let y = SEQ_HEAD + SEQ_PAD;
  for (let i = 0; i < doc.links.length; i++) {
    y += frameList.filter((f) => f.from === i && f.to >= f.from).length * FRAME_TAB;
    rows.push(y + SEQ_ROW / 2);
    y += SEQ_ROW + frameList.filter((f) => f.to === i && f.to >= f.from).length * FRAME_FOOT;
  }
  const lifeline = y + SEQ_ROW;
  const centre = new Map<string, number>();
  let x = 0;
  for (const n of doc.nodes) {
    if (n.kind === "note") continue;
    const s = size(n);
    positions[n.name] = { x, y: 0 };
    sizes.set(n.name, { w: s.w, h: lifeline });
    centre.set(n.name, x + s.w / 2);
    x += s.w + SEQ_GAP;
  }
  // Notes sit to the right of the last participant, one under another.
  let ny = SEQ_HEAD + SEQ_PAD;
  for (const n of doc.nodes) {
    if (n.kind !== "note") continue;
    const s = size(n);
    positions[n.name] = { x, y: ny };
    sizes.set(n.name, s);
    ny += s.h + 16;
  }
  // A frame spans the participants its messages touch, over its message rows. Frames opening on the same row
  // stack their tabs, the outer one highest; their feet stack the same way below the closing row.
  const frames = frameList.map((f) => {
    const msgs = f.to >= f.from ? doc.links.slice(f.from, f.to + 1) : [];
    const xs = msgs.flatMap((l) => [centre.get(l.from), centre.get(l.to)]).filter((v): v is number => v !== undefined);
    const lo = xs.length ? Math.min(...xs) - 60 : 0;
    const hi = xs.length ? Math.max(...xs) + 60 : 120;
    const inset = f.depth * 8;
    const first = rows[f.from] ?? SEQ_HEAD + SEQ_PAD + SEQ_ROW / 2;
    const last = rows[Math.max(f.from, f.to)] ?? first;
    const above = frameList.filter((g) => g.from === f.from && g.to >= g.from && g.depth >= f.depth).length;
    const below = frameList.filter((g) => g.to === f.to && g.to >= g.from && g.depth >= f.depth).length;
    const top = first - SEQ_ROW / 2 - above * FRAME_TAB + 2;
    const bottom = last + SEQ_ROW / 2 + (below - 1) * FRAME_FOOT + 2;
    return { label: f.label, depth: f.depth, box: { x: lo + inset, y: top, w: hi - lo - inset * 2, h: bottom - top } };
  });
  return { positions, sizes, lifeline, frames, rows };
}

/** The root in the middle; its topics alternate right and left, each subtree stacked under the one before. */
function mindLayout(doc: FlowDoc, size: (n: FlowNode) => { w: number; h: number }): FixedLayout {
  const positions = pos();
  const sizes = new Map<string, { w: number; h: number }>();
  const children = new Map<string, string[]>();
  for (const l of doc.links) {
    if (!l.tree) continue;
    const list = children.get(l.from) ?? [];
    list.push(l.to);
    children.set(l.from, list);
  }
  const byName = new Map(doc.nodes.map((n) => [n.name, n]));
  for (const n of doc.nodes) sizes.set(n.name, size(n));
  const height = (name: string): number => {
    const kids = children.get(name) ?? [];
    const own = (sizes.get(name)?.h ?? 30) + 14;
    if (kids.length === 0) return own;
    return Math.max(own, kids.reduce((t, k) => t + height(k), 0));
  };
  const place = (name: string, x: number, top: number, side: 1 | -1) => {
    const s = sizes.get(name)!;
    const h = height(name);
    positions[name] = { x: side === 1 ? x : x - s.w, y: top + h / 2 - s.h / 2 };
    let y = top;
    const next = side === 1 ? x + s.w + MIND_STEP : x - s.w - MIND_STEP;
    for (const k of children.get(name) ?? []) {
      place(k, next, y, side);
      y += height(k);
    }
  };
  const roots = doc.nodes.filter((n) => n.kind === "root");
  let rootTop = 0;
  for (const r of roots) {
    const s = sizes.get(r.name)!;
    const kids = children.get(r.name) ?? [];
    const right = kids.filter((_, i) => i % 2 === 0);
    const left = kids.filter((_, i) => i % 2 === 1);
    const hr = right.reduce((t, k) => t + height(k), 0);
    const hl = left.reduce((t, k) => t + height(k), 0);
    const total = Math.max(hr, hl, s.h);
    positions[r.name] = { x: -s.w / 2, y: rootTop + total / 2 - s.h / 2 };
    let y = rootTop + (total - hr) / 2;
    for (const k of right) {
      place(k, s.w / 2 + MIND_STEP, y, 1);
      y += height(k);
    }
    y = rootTop + (total - hl) / 2;
    for (const k of left) {
      place(k, -s.w / 2 - MIND_STEP, y, -1);
      y += height(k);
    }
    rootTop += total + 80;
  }
  // Topics with no root above them (written before any root) go in a column below.
  let loose = rootTop;
  for (const n of doc.nodes) {
    if (positions[n.name] || !byName.has(n.name)) continue;
    positions[n.name] = { x: 0, y: loose };
    loose += (sizes.get(n.name)?.h ?? 30) + 16;
  }
  return { positions, sizes };
}

/** Items along one line in the order written, alternating above and below it; sections band their items. */
function timelineLayout(doc: FlowDoc, size: (n: FlowNode) => { w: number; h: number }): FixedLayout {
  const positions = pos();
  const sizes = new Map<string, { w: number; h: number }>();
  const ticks = new Map<string, { x: number; above: boolean }>();
  const AXIS_Y = 120;
  const items = doc.nodes.filter((n) => n.kind !== "note");
  items.forEach((n, i) => {
    const s = size(n);
    const x = i * TIME_STEP;
    const above = i % 2 === 0;
    positions[n.name] = { x, y: above ? AXIS_Y - 36 - s.h : AXIS_Y + 36 };
    sizes.set(n.name, s);
    ticks.set(n.name, { x: x + s.w / 2, above });
  });
  const width = Math.max(items.length - 1, 0) * TIME_STEP + 152;
  const axis = { x: -24, y: AXIS_Y - 1, w: width + 48, h: 2 };
  const sections = (doc.sections ?? []).flatMap((name) => {
    const xs = items.flatMap((n, i) => (n.section === name ? [i * TIME_STEP] : []));
    if (xs.length === 0) return [];
    const lo = Math.min(...xs) - 12;
    const hi = Math.max(...xs) + 152 + 12;
    return [{ name, box: { x: lo, y: AXIS_Y - 140, w: hi - lo, h: 280 } }];
  });
  let ny = AXIS_Y + 140;
  for (const n of doc.nodes) {
    if (n.kind !== "note") continue;
    const s = size(n);
    positions[n.name] = { x: 0, y: ny };
    sizes.set(n.name, s);
    ny += s.h + 16;
  }
  return { positions, sizes, axis, sections, ticks };
}

/** The layout of a sequence, mind map or timeline; null for the kinds that are dragged into place. */
export function fixedLayout(doc: FlowDoc, size: (n: FlowNode) => { w: number; h: number }): FixedLayout | null {
  if (doc.kind === "sequence") return sequenceLayout(doc, size);
  if (doc.kind === "mindmap") return mindLayout(doc, size);
  if (doc.kind === "timeline") return timelineLayout(doc, size);
  return null;
}
