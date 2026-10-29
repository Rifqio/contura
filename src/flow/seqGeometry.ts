// Plan E: the one sequence drawing (Decision 15). `sequenceLayout` (kindLayout.ts) works out every coordinate once,
// for the frame's text size, into a SeqDrawing: the lanes, activation bars, messages with their paths, label chips
// and number circles, and the blocks with their side tabs and captions. The canvas and Publish both draw from it.
// Everything here is in the sequence's own coordinates and holds numbers and short strings only (Decision 16).
import type { KindBox } from "./kindLayout";
import type { DrawnColour } from "./palette";
import type { SeqWho } from "./seqColour";

/** A row that holds a self-message is this tall (a plain row is `SEQ_ROW`, 44). */
export const SEQ_SELF_ROW = 62;
/** A row's line (`rows[i]`) is this far below the row's top, in plain and self rows alike. */
export const ROW_LINE = 22;
/** A labelled line stops this far short of its label on each side. */
export const LABEL_PAD = 7;
/** The shortest visible run of a labelled line on each side of its label (Decision 8). */
export const SEG_MIN = 16;
/** An activation bar's width. */
export const ACT_W = 12;
/** How far a self-message's loop runs down. */
export const SELF_DROP = 38;
/** The foot boxes start this far below the last row. */
export const FOOT_GAP = 10;
/** A block's side tab's width. */
export const TAB_W = 24;
/** Each level of blocks nested inside a block moves its left edge this far out, so no tab covers another. */
export const TAB_STEP = 30;
/** A block's box reaches this far left of the leftmost lifeline its messages touch, and this far right of the rightmost. */
export const FRAME_LEFT = 54;
export const FRAME_RIGHT = 60;

/** A participant's lifeline: `x` its centre, from `top` (the head box's bottom) to `bottom` (the foot box's top). */
export interface SeqLane {
  name: string;
  who: SeqWho;
  colour?: DrawnColour;
  x: number;
  top: number;
  bottom: number;
}

/** An activation bar, `ACT_W` wide: `x` its left edge, `y` its top, `h` its height. */
export interface SeqBar {
  name: string;
  who: SeqWho;
  colour?: DrawnColour;
  x: number;
  y: number;
  h: number;
}

/**
 * A message. `y` is its row's line; `d` its path, with a gap at the label (`M..H..M..H..`, or a self-message's
 * `M..H..V..M..V..H..`); `points` the path's vertices in order, gaps left out. A label is centred at `(x, y)`, `w`
 * wide, on `chip`, whose colour is the canvas's or the wash of block `bg`. A number sits at `(x, y)`, `w` wide.
 */
export interface SeqMessage {
  index: number;
  from: string;
  to: string;
  self: boolean;
  reply: boolean;
  y: number;
  d: string;
  points: { x: number; y: number }[];
  label?: { text: string; x: number; y: number; w: number; chip: KindBox; bg: "canvas" | number };
  number?: { n: number; x: number; y: number; w: number; who: SeqWho; colour?: DrawnColour };
}

/**
 * A block (a sequence frame, `FlowDoc.frames[index]`): its box, its side tab down the box's left edge, and its
 * caption's chip (null with no caption). `word` is whether the tab has room for its kind word, `wordW` wide.
 */
export interface SeqBlock {
  index: number;
  kind: string;
  caption: string;
  colour?: DrawnColour;
  depth: number;
  box: KindBox;
  tab: KindBox;
  captionBox: KindBox | null;
  word: boolean;
  wordW: number;
}

/** The whole drawing; `bounds` holds the boxes, blocks, label chips and number pills (not notes). */
export interface SeqDrawing {
  lanes: SeqLane[];
  bars: SeqBar[];
  messages: SeqMessage[];
  blocks: SeqBlock[];
  bounds: KindBox;
}

/** Message `m`'s path moved by `(dx, dy)`. */
export function messagePath(m: SeqMessage, dx: number, dy: number): string {
  if (dx === 0 && dy === 0) return m.d;
  return m.d.replace(/([MHV])([^MHV]+)/g, (_s, c: string, rest: string) => {
    const v = rest.trim().split(/\s+/).map(Number);
    if (c === "M") return `M${v[0] + dx} ${v[1] + dy} `;
    return `${c}${v[0] + (c === "H" ? dx : dy)} `;
  }).trimEnd();
}

/** A number circle's width: 20, or a pill past two digits (Decision 10), times the text size. */
export function numberWidth(n: number, scale: number): number {
  return Math.max(20, String(n).length * 6.5 + 7) * scale;
}

/** The chip under a label `w` wide centred at `(x, y)`: 4 px each side, 18 tall. */
export function labelChip(x: number, y: number, w: number): KindBox {
  return { x: x - (w + 8) / 2, y: y - 9, w: w + 8, h: 18 };
}

/**
 * A Fenwick tree over the gaps left of each participant box (Decision 8): `add(i, by)` grows gap `i`, `sum(i)` is
 * gaps 0 to `i`, both O(log n), so the spacing pass stays O((m + n) log n).
 */
export class GapTree {
  private readonly t: Float64Array;
  constructor(n: number) {
    this.t = new Float64Array(n + 1);
  }
  add(i: number, by: number): void {
    for (let k = i + 1; k < this.t.length; k += k & -k) this.t[k] += by;
  }
  sum(i: number): number {
    let s = 0;
    for (let k = Math.min(i + 1, this.t.length - 1); k > 0; k -= k & -k) s += this.t[k];
    return s;
  }
}
