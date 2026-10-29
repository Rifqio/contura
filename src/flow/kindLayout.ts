// Step 12, item 19: sizes of the newer kinds' shapes, and the layouts the canvas works out from the text alone.
// A sequence runs down the page in message order, a mind map grows out from its root by the indents, and a
// timeline runs along one line in the order the text writes it. Those three are laid out here every time the
// text changes; the other kinds are laid out by dagre and dragged as the older kinds are.
import type { Positions } from "../diagram/layout";
import type { DrawnKind } from "../diagram/types";
import type { FlowDoc, FlowNode } from "../lang/flow/model";
import { messageNumbers } from "../lang/flow/numbering";
import { drawnColour } from "./palette";
import { ACT_W, FOOT_GAP, FRAME_LEFT, FRAME_RIGHT, GapTree, LABEL_PAD, labelChip, numberWidth, ROW_LINE, SEG_MIN, SELF_DROP, SEQ_SELF_ROW, type SeqBar, type SeqBlock, type SeqDrawing, type SeqLane, type SeqMessage, TAB_STEP, TAB_W } from "./seqGeometry";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
/** About 7 px a character of the body font, 7.2 of Code small. */
const textW = (s: string) => s.length * 7;

/**
 * diag-910 fix round 2 (L2): a state's name as it is drawn, in the canvas's bold 13 px UI font, so the pill is as wide as
 * its name. Measured once per name with a canvas where there is one (the app); a guess elsewhere. Tests set their own.
 * A sequence's message labels and captions (`message`, 400 12 px) and its block words (`word`,
 * 600 11 px) are measured the same way, one cache per font, each cleared when it holds 4,000 entries before an insert.
 */
export type LabelFont = "state" | "message" | "word";
const LABEL_FONTS: Record<LabelFont, string> = { state: "600 13px", message: "400 12px", word: "600 11px" };
/** Px a letter with nothing to measure with: wide enough for the widest common letters. */
const LABEL_GUESS: Record<LabelFont, number> = { state: 8.2, message: 7, word: 7 };
const LABEL_CACHE_MAX = 4000;
let labelMeasure: ((s: string, font: LabelFont) => number) | null | undefined;
const measured: Record<LabelFont, Map<string, number>> = { state: new Map(), message: new Map(), word: new Map() };
export function setLabelMeasure(fn: ((s: string, font: LabelFont) => number) | null): void {
  labelMeasure = fn;
  for (const m of Object.values(measured)) m.clear();
}
/**
 * `s` as a string of its own. A label the parser cut from the text is a slice of it in V8, which keeps
 * the whole text alive: kept as a cache key, every edited label held its whole board's text (about 250 KB a keystroke
 * on the sequence limit, up to 4,000 of them).
 */
const ownCopy = (s: string): string => JSON.parse(JSON.stringify(s)) as string;
function measureLabel(s: string, font: LabelFont): number {
  if (labelMeasure === undefined) {
    labelMeasure = null;
    try {
      const ctx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
      if (ctx) {
        const family = getComputedStyle(document.documentElement).getPropertyValue("--font-family-ui").trim() || "sans-serif";
        labelMeasure = (t, f) => {
          ctx.font = `${LABEL_FONTS[f]} ${family}`;
          return ctx.measureText(t).width;
        };
      }
    } catch {
      labelMeasure = null;
    }
  }
  if (!labelMeasure) return Math.ceil(s.length * LABEL_GUESS[font]);
  const cache = measured[font];
  let w = cache.get(s);
  if (w === undefined) {
    // Bounded: names and labels come and go as they are typed.
    if (cache.size >= LABEL_CACHE_MAX) cache.clear();
    w = Math.ceil(labelMeasure(s, font));
    cache.set(ownCopy(s), w);
  }
  return w;
}
const labelW = (s: string) => measureLabel(s, "state");
/** A sequence label's (or a participant's words', `state`) drawn width in `font`, times the frame's text size (the scale multiplies after the cache). */
export function messageLabelW(s: string, font: LabelFont, scale = 1): number {
  return measureLabel(s, font) * scale;
}
/** How many widths `font`'s cache holds (never more than 4,000). */
export function labelCacheSize(font: LabelFont): number {
  return measured[font].size;
}
const CODE_CHAR = 7.2;
const codeW = (s: string) => s.length * CODE_CHAR;

/** A card row (an ER column, a class member). */
export const KIND_ROW = 22;
/** An ER card shows at most this many rows; the rest scroll inside it. */
export const ER_MAX_ROWS = 20;
/** An ER card's height without its rows: 2 px of border, the 32 px header and 3 px above and below the rows. */
export const ER_CARD_CHROME = 40;
/** B3 decision 7: rows drawn above and below the ones in view, so a wheel step never shows a gap. */
export const ER_ROW_OVERSCAN = 1;
/** An ER card's header: its 32 px name band, under 1 px of border. */
export const ER_HEAD = 32;
/** The rows' top and bottom padding inside an ER card's scrolled body (`.fkind-rows`). */
const ER_ROWS_PAD = 3;
/** The middle of an ER card's first row below the card's top, unscrolled: 1 px of border, the header, the padding, half a row. */
export const ER_ROW_MID = 1 + ER_HEAD + ER_ROWS_PAD + KIND_ROW / 2;
/** Where a line to a whole ER table meets its card, below the card's top: the header's middle. */
export const ER_HEAD_MID = 17;

/**
 * An ER card's geometry at text size `k` (`TEXT_SCALE`), B4 fix round 1: its height, header, padding, row pitch and
 * row middle all scale together, so at every text size each row and each line end sits inside the card. The canvas,
 * its line ends, its hit tests and Publish all read these, never the bare constants.
 */
export function erMetrics(k = 1): { row: number; head: number; pad: number; chrome: number; mid: number } {
  return { row: KIND_ROW * k, head: ER_HEAD * k, pad: ER_ROWS_PAD * k, chrome: ER_CARD_CHROME * k, mid: ER_ROW_MID * k };
}
/** An ER card's natural height holding `rows` rows at text size `k`, on whole px (as `nodeSize` rounds a scaled size). */
export const erCardH = (rows: number, k = 1) => Math.round((ER_CARD_CHROME + Math.max(rows, 1) * KIND_ROW) * k);

/** How many rows an ER card `h` tall shows at text size `k` (its natural height when not resized): never more than 20. */
export const erFits = (h: number | undefined, k = 1) =>
  // A scaled height is rounded to whole px (`erCardH`), so it may sit up to half a px under its rows: allow for it.
  h === undefined ? ER_MAX_ROWS : Math.min(ER_MAX_ROWS, Math.floor((h + (k === 1 ? 0 : 0.5) - ER_CARD_CHROME * k) / (KIND_ROW * k)));
/** An ER card's height past which it never grows: 20 rows (decision 7), at text size `k`. */
const erMaxH = (k: number) => erCardH(ER_MAX_ROWS, k);
/**
 * The px an ER card `h` tall (its 20-row height when not resized) shows of its scrolled rows at text size `k`: the card
 * less its border and header. A card is never drawn past 20 rows, so neither is its view.
 */
export const erViewH = (h: number | undefined, k = 1) => Math.max(0, Math.min(h ?? erMaxH(k), erMaxH(k)) - (ER_CARD_CHROME - 2 * ER_ROWS_PAD) * k);
/**
 * B3 decision 7: the rows of `count` an ER card draws with `view` px of its body in view (`erViewH`), scrolled by
 * `scroll`: every row even partly in view, plus `ER_ROW_OVERSCAN` either side while that stays within 22 rows, rows
 * `from` to `to` (exclusive). Spacers stand for the rest, so the drawn rows and the spacers meet every visible pixel.
 */
export function erRowWindow(count: number, view: number, scroll: number, k = 1): { from: number; to: number } {
  const m = erMetrics(k);
  const vf = Math.max(0, Math.min(count, Math.floor((scroll - m.pad) / m.row)));
  const vt = Math.max(vf, Math.min(count, Math.ceil((scroll + view - m.pad) / m.row)));
  let from = Math.max(0, vf - ER_ROW_OVERSCAN);
  let to = Math.min(count, vt + ER_ROW_OVERSCAN);
  // A view of 20 rows can meet 22 at once (part of one at each edge): the overscan gives way first.
  while (to - from > ER_MAX_ROWS + 2 * ER_ROW_OVERSCAN) {
    if (to > vt) to--;
    else if (from < vf) from++;
    else break;
  }
  return { from, to };
}
/**
 * ER build C: where a relationship meets row `row` of an ER card `top` px down a card `h` tall at text size `k`, its
 * rows scrolled by `scroll`: the middle of the row (`erMetrics(k).mid` on, a row pitch each). A row scrolled out of
 * view puts the end on the card's top or bottom edge, whichever the row is past (DataGrip and dbdiagram). Row -1 is
 * the header, where a line to the whole table meets it.
 */
export function erRowY(top: number, h: number, row: number, scroll = 0, k = 1): number {
  const m = erMetrics(k);
  if (row < 0) return top + ER_HEAD_MID * k;
  const y = m.mid + row * m.row - scroll;
  // Past the top of the rows, or within 4 px of the card's bottom: on that edge.
  if (y < m.mid - m.row / 2) return top;
  if (y > h - 4 * k) return top + h;
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
export const erRowWidth = (row: string) => {
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
export const FRAME_TAB = 28;
const FRAME_FOOT = 10;
/** Room between participants, between timeline items, and between mind map levels. */
const SEQ_GAP = 72;
const TIME_STEP = 176;
const MIND_STEP = 64;

/** A class member is a method when it has brackets: it goes in the card's third part. */
export const isMethod = (row: string) => row.includes("(");

/** The size of a step 12 shape, from its words and rows (flow-canvas.css draws them at these sizes). */
export function kindSize(kind: DrawnKind, n: Pick<FlowNode, "name" | "rows" | "text" | "depth"> & Partial<Pick<FlowNode, "attrs">>): { w: number; h: number } | null {
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
        h: erCardH(Math.min(rows.length, ER_MAX_ROWS)),
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
      // The pill's 16 px padding each side, its border, and a little air (L2).
      return { w: clamp(labelW(n.name) + 44, 100, 280), h: 40 };
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
      // 24 px more for the icon (an actor's is the user glyph).
      return { w: clamp(textW(n.name) + 40 + (kind === "actor" || n.attrs?.icon ? 24 : 0), 120, 260), h: SEQ_HEAD };
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
  /** Sequence: where each lifeline ends (the foot boxes' top), each message row's line (from the top), and the drawing. */
  lifeline?: number;
  rows?: number[];
  seq?: SeqDrawing;
  /** Timeline: the axis and each section's band. */
  axis?: KindBox;
  sections?: { name: string; box: KindBox }[];
  /** Timeline: where each item meets the axis, by name. */
  ticks?: Map<string, { x: number; above: boolean }>;
}

const pos = (): Positions => Object.create(null) as Positions;

/**
 * Participants in a row, in the order they are written; a message row each, top to bottom; and the one drawing the
 * canvas and Publish both read (seqGeometry.ts). Passes: rows; participant widths; the gaps grown to fit the
 * labels (through a Fenwick tree); centres; active ranges; messages; blocks, innermost first; notes right
 * of everything drawn. O((m + n) log n) for m messages and n participants, plus each block's own rows.
 */
function* sequenceLayoutSteps(doc: FlowDoc, size: (n: FlowNode) => { w: number; h: number }, scale: number): Generator<void, FixedLayout> {
  const positions = pos();
  const sizes = new Map<string, { w: number; h: number }>();
  const links = doc.links;
  const m = links.length;
  const frameList = doc.frames ?? [];
  const full = (f: { from: number; to: number }) => f.to >= f.from && f.from < m;

  // Rows: a plain row is SEQ_ROW tall and a self row SEQ_SELF_ROW, its line ROW_LINE below its top. A frame that
  // opens on a row adds room for its tab above it, and one that closes adds a little below. An empty block takes a
  // band of its own, as tall as that room, where it is written (PlantUML and Mermaid draw it as a header-height box).
  const opens = new Int32Array(m);
  const closes = new Int32Array(m);
  const empties = new Int32Array(m + 1);
  for (const f of frameList) {
    if (full(f)) {
      opens[f.from]++;
      closes[f.to]++;
    } else empties[Math.min(Math.max(f.from, 0), m)]++;
  }
  const bands = new Float64Array(m + 1);
  const rows: number[] = new Array<number>(m);
  const tops = new Float64Array(m);
  const heights = new Float64Array(m);
  let y = SEQ_HEAD + SEQ_PAD;
  for (let i = 0; i < m; i++) {
    bands[i] = y;
    y += (empties[i] + opens[i]) * FRAME_TAB;
    tops[i] = y;
    rows[i] = y + ROW_LINE;
    heights[i] = links[i].from === links[i].to ? SEQ_SELF_ROW : SEQ_ROW;
    y += heights[i] + closes[i] * FRAME_FOOT;
  }
  bands[m] = y;
  y += empties[m] * FRAME_TAB;
  const end = y;
  const bottom = end + FOOT_GAP;

  yield;
  // Participant widths, and the gaps between their boxes.
  const parts = doc.nodes.filter((n) => n.kind !== "note");
  const count = parts.length;
  const at = new Map<string, number>();
  const widths = new Float64Array(count);
  const before = new Float64Array(count + 1);
  parts.forEach((n, j) => {
    at.set(n.name, j);
    widths[j] = size(n).w;
    before[j + 1] = before[j] + widths[j];
  });
  const gaps = new GapTree(count);
  for (let j = 1; j < count; j++) gaps.add(j, SEQ_GAP);
  const centreOf = (j: number) => before[j] + gaps.sum(j) + widths[j] / 2;

  yield;
  // Active ranges per participant, merged into sorted disjoint [from, to] pairs.
  const active = new Map<string, number[]>();
  const ranges = new Map<string, [number, number][]>();
  for (const a of doc.activations ?? []) {
    if (a.to < a.from) continue;
    const list = ranges.get(a.name);
    if (list) list.push([a.from, a.to]);
    else ranges.set(a.name, [[a.from, a.to]]);
  }
  for (const [name, list] of ranges) {
    list.sort((p, q) => p[0] - q[0]);
    const flat: number[] = [];
    for (const [f, t] of list) {
      const k = flat.length;
      if (k && f <= flat[k - 1]) flat[k - 1] = Math.max(flat[k - 1], t);
      else flat.push(f, t);
    }
    active.set(name, flat);
  }
  const activeAt = (name: string, i: number) => {
    const flat = active.get(name);
    if (!flat) return false;
    let lo = 0;
    let hi = flat.length / 2 - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (flat[mid * 2] > i) hi = mid - 1;
      else if (flat[mid * 2 + 1] < i) lo = mid + 1;
      else return true;
    }
    return false;
  };

  yield;
  // Per message: its number, its start and end insets and its label's width.
  const numbers = messageNumbers(doc);
  const startIn = new Float64Array(m);
  const endIn = new Float64Array(m);
  const labelWs = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const l = links[i];
    const n = numbers[i];
    startIn[i] = n !== null ? numberWidth(n, scale) / 2 : activeAt(l.from, i) ? ACT_W / 2 : 0;
    endIn[i] = activeAt(l.to, i) ? ACT_W / 2 : 0;
    labelWs[i] = l.label ? messageLabelW(l.label, "message", scale) : 0;
  }
  const loopW = (i: number) => Math.max(74, labelWs[i] / 2 + 14);

  yield;
  // Messages spanning the fewest participants first, then in text order; each grows the gap just left
  // of its rightmost participant by what it is short. A self-message keeps the next box 12 px right of its chip.
  const order: number[] = [];
  const spans = new Int32Array(m);
  for (let i = 0; i < m; i++) {
    const a = at.get(links[i].from);
    const b = at.get(links[i].to);
    if (a === undefined || b === undefined) continue;
    spans[i] = Math.abs(a - b);
    order.push(i);
  }
  order.sort((p, q) => spans[p] - spans[q] || p - q);
  for (const i of order) {
    const a = at.get(links[i].from)!;
    const b = at.get(links[i].to)!;
    if (a === b) {
      if (a + 1 >= count) continue;
      const reach = startIn[i] + loopW(i) + (labelWs[i] ? labelWs[i] / 2 + 4 : 0) + 12;
      const room = centreOf(a + 1) - widths[a + 1] / 2 - centreOf(a);
      if (reach > room) gaps.add(a + 1, reach - room);
      continue;
    }
    if (!labelWs[i]) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const need = labelWs[i] + 2 * LABEL_PAD + 2 * SEG_MIN + startIn[i];
    const dist = centreOf(hi) - centreOf(lo);
    if (need > dist) gaps.add(hi, need - dist);
  }
  const cx = new Float64Array(count);
  for (let j = 0; j < count; j++) cx[j] = centreOf(j);

  // Bounds: the boxes, blocks, label chips and number pills.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const take = (x: number, y0: number, w: number, h: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y0 + h);
  };

  yield;
  // Lanes: each participant's node runs from its head box to its foot box.
  const lanes: SeqLane[] = [];
  parts.forEach((n, j) => {
    const left = cx[j] - widths[j] / 2;
    positions[n.name] = { x: left, y: 0 };
    sizes.set(n.name, { w: widths[j], h: bottom + SEQ_HEAD });
    take(left, 0, widths[j], bottom + SEQ_HEAD);
    const lane: SeqLane = { name: n.name, who: n.kind === "actor" ? "actor" : "participant", x: cx[j], top: SEQ_HEAD, bottom };
    const colour = drawnColour(n.attrs.color);
    if (colour) lane.colour = colour;
    lanes.push(lane);
  });

  // Activation bars, 6 px above their first message's line to 6 px below their last one's.
  const bars: SeqBar[] = [];
  for (const a of doc.activations ?? []) {
    const j = at.get(a.name);
    if (j === undefined) continue;
    const lane = lanes[j];
    const has = full(a);
    let top: number;
    let h: number;
    if (has) {
      top = rows[a.from] - 6;
      h = rows[a.to] - rows[a.from] + 12;
    } else if (a.from < m) {
      top = rows[a.from] - 6;
      h = SEQ_ROW - 12;
    } else {
      // After the last message: it ends where that row's bar would, above the foot boxes.
      const tail = m ? rows[m - 1] + 6 : bottom;
      top = Math.max(SEQ_HEAD, tail - (SEQ_ROW - 12));
      h = tail - top;
    }
    const bar: SeqBar = { name: a.name, who: lane.who, x: lane.x - ACT_W / 2, y: top, h };
    if (lane.colour) bar.colour = lane.colour;
    bars.push(bar);
  }

  // The innermost block holding each message: its label's chip takes that block's wash.
  const blockOf = new Int32Array(m).fill(-1);
  const blockDepth = new Int32Array(m).fill(-1);
  frameList.forEach((f, k) => {
    if (!full(f)) return;
    for (let i = f.from; i <= f.to; i++)
      if (f.depth > blockDepth[i]) {
        blockDepth[i] = f.depth;
        blockOf[i] = k;
      }
  });

  yield;
  // Messages.
  const messages: SeqMessage[] = [];
  const byIndex: (SeqMessage | undefined)[] = new Array(m);
  for (let i = 0; i < m; i++) {
    const l = links[i];
    const a = at.get(l.from);
    const b = at.get(l.to);
    if (a === undefined || b === undefined) continue;
    const ry = rows[i];
    const self = a === b;
    const lw = labelWs[i];
    const dir = self || cx[b] >= cx[a] ? 1 : -1;
    const x0 = cx[a] + dir * startIn[i];
    const bg: "canvas" | number = blockOf[i] >= 0 ? blockOf[i] : "canvas";
    let d: string;
    let points: { x: number; y: number }[];
    let label: SeqMessage["label"];
    if (self) {
      const x2 = x0 + loopW(i);
      const back = cx[a] + endIn[i];
      const yb = ry + SELF_DROP;
      points = [
        { x: x0, y: ry },
        { x: x2, y: ry },
        { x: x2, y: yb },
        { x: back, y: yb },
      ];
      if (lw) {
        const ly = ry + 19;
        d = `M${x0} ${ry} H${x2} V${ly - 10} M${x2} ${ly + 10} V${yb} H${back}`;
        label = { text: l.label!, x: x2, y: ly, w: lw, chip: labelChip(x2, ly, lw), bg };
      } else d = `M${x0} ${ry} H${x2} V${yb} H${back}`;
      take(x0, ry, x2 - x0, SELF_DROP);
    } else {
      const x1 = cx[b] - dir * endIn[i];
      points = [
        { x: x0, y: ry },
        { x: x1, y: ry },
      ];
      if (lw) {
        const mid = (x0 + x1) / 2;
        const half = lw / 2 + LABEL_PAD;
        d = `M${x0} ${ry} H${mid - dir * half} M${mid + dir * half} ${ry} H${x1}`;
        label = { text: l.label!, x: mid, y: ry, w: lw, chip: labelChip(mid, ry, lw), bg };
      } else d = `M${x0} ${ry} H${x1}`;
    }
    const msg: SeqMessage = { index: i, from: l.from, to: l.to, self, reply: l.arrow === "-->", y: ry, d, points };
    if (label) {
      msg.label = label;
      take(label.chip.x, label.chip.y, label.chip.w, label.chip.h);
    }
    const n = numbers[i];
    if (n !== null) {
      const lane = lanes[a];
      const w = numberWidth(n, scale);
      msg.number = { n, x: cx[a], y: ry, w, who: lane.who };
      if (lane.colour) msg.number.colour = lane.colour;
      take(cx[a] - w / 2, ry - 10 * scale, w, 20 * scale);
    }
    messages.push(msg);
    byIndex[i] = msg;
  }

  yield;
  // Blocks, in close order, so every block's inner blocks come before it: the levels nested
  // inside a block are those of the blocks one deeper that closed since the last block of its own depth did.
  const endsAt = new Map<number, number[]>();
  for (const f of frameList) {
    if (!full(f)) continue;
    (endsAt.get(f.to) ?? endsAt.set(f.to, []).get(f.to)!).push(f.depth);
  }
  const deeper = (list: number[] | undefined, depth: number) => (list ?? []).filter((d) => d >= depth).length;
  const slotTop = blockTops(frameList, m, bands, full);
  const below: number[] = [];
  // The right edge of the widest block one deeper that closed since the last block of each depth did.
  const widest: number[] = [];
  const blocks: SeqBlock[] = frameList.map((f, k) => {
    const levels = (below[f.depth + 1] ?? -1) + 1;
    below[f.depth + 1] = -1;
    below[f.depth] = Math.max(below[f.depth] ?? -1, levels);
    const inner = widest[f.depth + 1] ?? -Infinity;
    widest[f.depth + 1] = -Infinity;
    let lo = Infinity;
    let hi = -Infinity;
    let reach = -Infinity;
    if (full(f))
      for (let i = f.from; i <= f.to; i++) {
        const msg = byIndex[i];
        if (!msg) continue;
        const a = cx[at.get(msg.from)!];
        const b = cx[at.get(msg.to)!];
        lo = Math.min(lo, a, b);
        hi = Math.max(hi, a, b);
        if (msg.self) reach = Math.max(reach, msg.label ? msg.label.chip.x + msg.label.chip.w : msg.points[1].x);
      }
    if (lo === Infinity) lo = hi = count ? cx[0] : 0;
    const left = lo - FRAME_LEFT - TAB_STEP * levels;
    const caption = (f.label.startsWith(f.kind) ? f.label.slice(f.kind.length) : f.label).trim();
    const captionW = caption ? messageLabelW(caption, "message", scale) + 12 : 0;
    // A block is wide enough to hold its caption chip and the blocks inside it (PlantUML and Eraser widen a
    // fragment to fit its guard), so canvas, Publish and far pictures all keep the caption inside the outline.
    const right = Math.max(Math.max(hi + FRAME_RIGHT, reach + 12) + 8 * levels, caption ? left + TAB_W + 4 + captionW + 8 : -Infinity, inner + 8);
    widest[f.depth] = Math.max(widest[f.depth] ?? -Infinity, right);
    const top = slotTop[k];
    const foot = full(f) ? tops[f.to] + heights[f.to] + (deeper(endsAt.get(f.to), f.depth) - 1) * FRAME_FOOT + 2 : top + FRAME_TAB - 4;
    const box = { x: left, y: top, w: right - left, h: foot - top };
    take(box.x, box.y, box.w, box.h);
    const wordW = messageLabelW(f.kind, "word", scale);
    const block: SeqBlock = {
      index: k,
      kind: f.kind,
      caption,
      depth: f.depth,
      box,
      tab: { x: box.x, y: box.y, w: TAB_W, h: box.h },
      captionBox: caption ? { x: box.x + TAB_W + 4, y: box.y + 3, w: captionW, h: 18 } : null,
      word: box.h >= 5 + 18 + 8 + wordW + 8,
      wordW,
    };
    const colour = drawnColour(f.color);
    if (colour) block.colour = colour;
    return block;
  });

  const bounds = minX === Infinity ? { x: 0, y: 0, w: 0, h: 0 } : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  // Notes sit to the right of everything drawn, one under another.
  const x = minX === Infinity ? 0 : maxX + SEQ_GAP;
  let ny = SEQ_HEAD + SEQ_PAD;
  for (const n of doc.nodes) {
    if (n.kind !== "note") continue;
    const s = size(n);
    positions[n.name] = { x, y: ny };
    sizes.set(n.name, s);
    ny += s.h + 16;
  }
  return { positions, sizes, lifeline: bottom, rows, seq: { lanes, bars, messages, blocks, bounds } };
}

/**
 * Each block's top. A row's band holds one tab for every block that opens there, empty or not, in the order they
 * open in the text, so an outer block's tab comes before the tabs of the blocks inside it (an empty block first inside
 * a block that opens on the same row sits under its parent's tab). Blocks come in close order, so a block's parent is
 * the next block one level up; the open order is the tree's pre-order with siblings in close order. O(blocks).
 */
function blockTops(frames: NonNullable<FlowDoc["frames"]>, m: number, bands: Float64Array, full: (f: { from: number; to: number }) => boolean): Float64Array {
  const nf = frames.length;
  const parent = new Int32Array(nf).fill(-1);
  const nextAt: number[] = [];
  for (let k = nf - 1; k >= 0; k--) {
    const d = frames[k].depth;
    if (d > 0 && nextAt[d - 1] !== undefined) parent[k] = nextAt[d - 1];
    nextAt[d] = k;
  }
  const kids: number[][] = [];
  const roots: number[] = [];
  for (let k = 0; k < nf; k++) (parent[k] < 0 ? roots : (kids[parent[k]] ??= [])).push(k);
  // Pre-order: a block opens before the blocks inside it, and siblings open in the order they close.
  const order = new Int32Array(nf);
  let next = 0;
  const stack = roots.reverse();
  while (stack.length) {
    const k = stack.pop()!;
    order[k] = next++;
    const inner = kids[k];
    if (inner) for (let j = inner.length - 1; j >= 0; j--) stack.push(inner[j]);
  }
  const rowOf = (f: { from: number; to: number }) => (full(f) ? f.from : Math.min(Math.max(f.from, 0), m));
  const byRow = new Map<number, number[]>();
  frames.forEach((f, k) => {
    const r = rowOf(f);
    (byRow.get(r) ?? byRow.set(r, []).get(r)!).push(k);
  });
  const top = new Float64Array(nf);
  for (const [r, list] of byRow) {
    list.sort((p, q) => order[p] - order[q]);
    list.forEach((k, rank) => (top[k] = bands[r] + rank * FRAME_TAB + 2));
  }
  return top;
}

/**
 * The root in the middle; the first half of its topics on the right, the rest on the left, each side top to bottom
 * (board DiagramMindMap), so a topic added beside another lands beside it and at most one topic changes side.
 * Each subtree is stacked under the one before; a folded topic's subtopics are not placed.
 */
function mindLayout(doc: FlowDoc, size: (n: FlowNode) => { w: number; h: number }, folded?: ReadonlySet<string>): FixedLayout {
  const positions = pos();
  const sizes = new Map<string, { w: number; h: number }>();
  const children = new Map<string, string[]>();
  for (const l of doc.links) {
    if (!l.tree || folded?.has(l.from)) continue;
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
    const half = Math.ceil(kids.length / 2);
    const right = kids.slice(0, half);
    const left = kids.slice(half);
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
  // Topics under a folded one are not drawn.
  const hidden = new Set<string>();
  if (folded?.size) {
    const under = new Map<string, string[]>();
    for (const l of doc.links) {
      if (!l.tree) continue;
      const list = under.get(l.from);
      if (list) list.push(l.to);
      else under.set(l.from, [l.to]);
    }
    const walk = (n: string) => {
      for (const k of under.get(n) ?? []) {
        hidden.add(k);
        walk(k);
      }
    };
    for (const f of folded) walk(f);
  }
  // Topics with no root above them (written before any root) go in a column below.
  let loose = rootTop;
  for (const n of doc.nodes) {
    if (positions[n.name] || !byName.has(n.name) || hidden.has(n.name)) continue;
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
export function fixedLayout(doc: FlowDoc, size: (n: FlowNode) => { w: number; h: number }, opts: { folded?: ReadonlySet<string>; textScale?: number } = {}): FixedLayout | null {
  if (doc.kind === "sequence") {
    const steps = sequenceLayoutSteps(doc, size, opts.textScale ?? 1);
    for (;;) {
      const r = steps.next();
      if (r.done) return r.value;
    }
  }
  if (doc.kind === "mindmap") return mindLayout(doc, size, opts.folded);
  if (doc.kind === "timeline") return timelineLayout(doc, size);
  return null;
}

/**
 * `fixedLayout` in steps: a sequence's passes yield between them, so a far picture of the sequence at
 * its limit (2,000 participants, 3,000 messages: about 5 ms in all) is laid out across time slices. Drained, it is
 * `fixedLayout`.
 */
export function* fixedLayoutSteps(doc: FlowDoc, size: (n: FlowNode) => { w: number; h: number }, opts: { folded?: ReadonlySet<string>; textScale?: number } = {}): Generator<void, FixedLayout | null> {
  if (doc.kind === "sequence") return yield* sequenceLayoutSteps(doc, size, opts.textScale ?? 1);
  return fixedLayout(doc, size, opts);
}
