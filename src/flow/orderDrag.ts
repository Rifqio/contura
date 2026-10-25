// Diagram steps 7 and 8 (boards DiagramMindMap and DiagramSequence): where a dragged topic, message or participant
// would land. Everything a drag reads is built once when it starts (typed arrays), and each pointer frame writes its
// answer into one object kept for the whole drag, so 2,000 shapes cost nothing per frame (memory is a requirement).
// The store tells the canvas only when the landing place changes; the pointer itself moves the chip directly.
import type { Box } from "./interactions/geometry";

/** What a topic drop does: nothing, under a topic, before or after a sibling; 4 to 6 are the same refused. */
export const DROP = { none: 0, child: 1, before: 2, after: 3, badChild: 4, badBefore: 5, badAfter: 6 } as const;

/** A topic drag's view of the map: each topic's box, parent, side and neighbour, and which ones it may not go under. */
export interface TopicIndex {
  n: number;
  names: string[];
  box: Float64Array;
  parent: Int32Array;
  /** 1 right of the central idea, -1 left, 0 the central idea itself. */
  side: Int8Array;
  /** The sibling drawn just above on the same side, or -1. */
  prev: Int32Array;
  /** 1 for the last sibling on its side. */
  last: Uint8Array;
  /** 1 for the dragged topic and its subtopics: none of them can take it. */
  bad: Uint8Array;
  self: number;
}

/** Where a topic would land: what (DROP), on or beside which topic, and the insertion line between siblings. */
export interface TopicDrop {
  kind: number;
  ref: number;
  x1: number;
  x2: number;
  y: number;
}

/** Builds a topic drag's index from the drawn topics (in text order) and the topic being dragged. */
export function topicIndex(topics: readonly { name: string; parent: string | null; box: Box }[], dragged: string): TopicIndex {
  const n = topics.length;
  const at = new Map<string, number>();
  topics.forEach((t, i) => at.set(t.name, i));
  const box = new Float64Array(n * 4);
  const parent = new Int32Array(n).fill(-1);
  const side = new Int8Array(n);
  const prev = new Int32Array(n).fill(-1);
  const last = new Uint8Array(n);
  const bad = new Uint8Array(n);
  let root = -1;
  topics.forEach((t, i) => {
    box[i * 4] = t.box.x;
    box[i * 4 + 1] = t.box.y;
    box[i * 4 + 2] = t.box.w;
    box[i * 4 + 3] = t.box.h;
    parent[i] = t.parent === null ? -1 : (at.get(t.parent) ?? -1);
    if (t.parent === null && root < 0) root = i;
  });
  const rootMid = root >= 0 ? box[root * 4] + box[root * 4 + 2] / 2 : 0;
  for (let i = 0; i < n; i++) side[i] = i === root ? 0 : box[i * 4] + box[i * 4 + 2] / 2 >= rootMid ? 1 : -1;
  // The sibling above on the same side, and the last one on each side, by parent.
  const lastOf = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    if (parent[i] < 0) continue;
    const key = `${parent[i]}:${side[i]}`;
    const before = lastOf.get(key);
    if (before !== undefined) prev[i] = before;
    lastOf.set(key, i);
  }
  for (const [key, i] of lastOf) {
    // Below the last main topic on the right is the top of the left side in the text: no "after" there (fix round 1,
    // I2); the first on the left takes a drop above it instead.
    if (root >= 0 && key === `${root}:1`) continue;
    last[i] = 1;
  }
  const self = at.get(dragged) ?? -1;
  for (let i = 0; i < n; i++) {
    for (let p = i, hops = 0; p >= 0 && hops <= n; p = parent[p], hops++) {
      if (p === self) {
        bad[i] = 1;
        break;
      }
    }
  }
  return { n, names: topics.map((t) => t.name), box, parent, side, prev, last, bad, self };
}

/**
 * Where a topic dropped at (x, y) lands (XMind, Miro): onto a topic it becomes its subtopic; just above a topic, or
 * just below the last one on its side, it goes between siblings. Its own subtopics refuse it. Writes into `out`.
 */
export function topicDropAt(ix: TopicIndex, x: number, y: number, out: TopicDrop): void {
  out.kind = DROP.none;
  out.ref = -1;
  const b = ix.box;
  for (let i = 0; i < ix.n; i++) {
    const bx = b[i * 4];
    const by = b[i * 4 + 1];
    if (x < bx - 4 || x > bx + b[i * 4 + 2] + 4 || y < by - 4 || y > by + b[i * 4 + 3] + 4) continue;
    if (i === ix.self) return;
    out.kind = ix.bad[i] ? DROP.badChild : DROP.child;
    out.ref = i;
    return;
  }
  for (let i = 0; i < ix.n; i++) {
    const p = ix.parent[i];
    // Beside itself is where it is (fix round 1, I1).
    if (p < 0 || i === ix.self) continue;
    const bx = b[i * 4];
    const by = b[i * 4 + 1];
    const bw = b[i * 4 + 2];
    const bh = b[i * 4 + 3];
    if (x < bx - 16 || x > bx + bw + 16) continue;
    const q = ix.prev[i];
    const qBottom = q >= 0 ? b[q * 4 + 1] + b[q * 4 + 3] : 0;
    const above = q >= 0 ? Math.max(18, (by - qBottom) / 2 + 2) : 20;
    if (y >= by - above && y < by + 2) {
      out.kind = ix.bad[p] ? DROP.badBefore : DROP.before;
      out.ref = i;
      out.x1 = bx - 6;
      out.x2 = bx + bw + 6;
      out.y = Math.round(q >= 0 ? (qBottom + by) / 2 : by - 8);
      return;
    }
    if (ix.last[i] && y > by + bh - 2 && y <= by + bh + 20) {
      out.kind = ix.bad[p] ? DROP.badAfter : DROP.after;
      out.ref = i;
      out.x1 = bx - 6;
      out.x2 = bx + bw + 6;
      out.y = Math.round(by + bh + 8);
      return;
    }
  }
}

/** A row of positions (a message slot's height, a gap between participants), kept as numbers for a drag. */
export function laneIndex(values: readonly number[]): Float64Array {
  return Float64Array.from(values);
}

/** The index of the value nearest `v`. */
export function nearestIndex(lane: Float64Array, v: number): number {
  let best = 0;
  let gap = Number.POSITIVE_INFINITY;
  for (let i = 0; i < lane.length; i++) {
    const d = Math.abs(lane[i] - v);
    if (d < gap) {
      gap = d;
      best = i;
    }
  }
  return best;
}

/**
 * The height of the gap before message row `j` (0 above the first, `rows.length` below the last): midway in the clear
 * space between the row above (or the foot of a frame closing on it) and the next row's label (or the tab of a frame
 * opening on it), as the board's guide line shows it.
 */
export function slotHeights(rows: readonly number[], frames: readonly { from: number; to: number; top: number; bottom: number }[]): number[] {
  const n = rows.length;
  const out: number[] = [];
  for (let j = 0; j <= n; j++) {
    let lower = j < n ? rows[j] - 18 : Number.NaN;
    let upper = j > 0 ? rows[j - 1] : Number.NaN;
    for (const f of frames) {
      if (j < n && f.from === j) lower = Math.min(lower, f.top);
      if (j > 0 && f.to === j - 1) upper = Math.max(upper, f.bottom);
    }
    if (Number.isNaN(upper)) out.push(Number.isNaN(lower) ? 0 : lower - 8);
    else if (Number.isNaN(lower)) out.push(upper + 16);
    else out.push((upper + lower) / 2);
  }
  return out;
}

export type OrderDragMode = "topic" | "message" | "participant" | "draw";

/** The drag under way, as the canvas draws it: plain fields, changed in place. */
export interface OrderDragState {
  mode: OrderDragMode | null;
  /** What it lands on (DROP for a topic; for the others 1 when it moves, 0 where it already is). */
  kind: number;
  ref: number;
  /** The landing line or box, by mode: a topic's insertion line (x1, x2, y); a row's height (a, b, c = x1, x2, y). */
  a: number;
  b: number;
  c: number;
  /** The pointer, in flow coordinates. */
  x: number;
  y: number;
  /** The words under the pointer ("Drop: subtopic of Redis"), set by the canvas when the target changes. */
  tag: string;
  /** The dragged item's name, on the chip that follows the pointer. */
  chip: string;
}

export interface OrderDragStore {
  state: OrderDragState;
  begin(mode: OrderDragMode, chip?: string): void;
  /** Sets the landing place; tells the canvas only when it changed. */
  target(kind: number, ref: number, a: number, b: number, c: number): boolean;
  /** Moves the pointer: the chip follows through `onPointer`, with no render. */
  pointer(x: number, y: number): void;
  setTag(tag: string): void;
  end(): void;
  version(): number;
  subscribe(fn: () => void): () => void;
  onPointer(fn: ((x: number, y: number) => void) | null): void;
}

export function createOrderDragStore(): OrderDragStore {
  const state: OrderDragState = { mode: null, kind: 0, ref: -1, a: 0, b: 0, c: 0, x: 0, y: 0, tag: "", chip: "" };
  let v = 0;
  const subs = new Set<() => void>();
  let follow: ((x: number, y: number) => void) | null = null;
  const tell = () => {
    v++;
    for (const fn of subs) fn();
  };
  return {
    state,
    begin(mode, chip = "") {
      state.mode = mode;
      state.kind = 0;
      state.ref = -1;
      state.tag = "";
      state.chip = chip;
      tell();
    },
    target(kind, ref, a, b, c) {
      if (state.kind === kind && state.ref === ref && state.a === a && state.b === b && state.c === c) return false;
      state.kind = kind;
      state.ref = ref;
      state.a = a;
      state.b = b;
      state.c = c;
      tell();
      return true;
    },
    pointer(x, y) {
      state.x = x;
      state.y = y;
      if (follow) follow(x, y);
    },
    setTag(tag) {
      if (state.tag === tag) return;
      state.tag = tag;
      tell();
    },
    end() {
      if (state.mode === null) return;
      state.mode = null;
      state.kind = 0;
      state.ref = -1;
      state.tag = "";
      state.chip = "";
      tell();
    },
    version: () => v,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    onPointer(fn) {
      follow = fn;
    },
  };
}

/**
 * A message drawn from lifeline `from` (fix round 1, I4): the lifeline within 44 px of the pointer, or -1. The canvas
 * is told only when that changes; the arrow's free end follows the pointer through `onPointer`.
 */
export function drawAt(store: OrderDragStore, lane: Float64Array, from: number, x: number, y: number, slotY: number): number {
  const k = nearestIndex(lane, x);
  const to = k !== from && Math.abs(lane[k] - x) <= 44 ? k : -1;
  store.pointer(x, y);
  store.target(to < 0 ? 0 : 1, to, lane[from], to < 0 ? lane[from] : lane[to], slotY);
  return to;
}

/** A topic's branch dot (M3): on its outer side, with how many topics it holds, all the way down. */
export interface FoldDot {
  name: string;
  x: number;
  y: number;
  count: number;
  folded: boolean;
}

/** Every topic with subtopics, its dot and its count, worked out once per drawing in linear time (fix round 1, M4). */
export function foldDotsOf(links: readonly { from: string; to: string; tree?: boolean }[], boxOf: (n: string) => Box | undefined, root: string, folded: ReadonlySet<string>): FoldDot[] {
  const kids = new Map<string, string[]>();
  for (const l of links) {
    if (!l.tree) continue;
    const list = kids.get(l.from);
    if (list) list.push(l.to);
    else kids.set(l.from, [l.to]);
  }
  const r = boxOf(root);
  if (!r) return [];
  // Top down once, then the counts bottom up.
  const order: string[] = [root];
  for (let i = 0; i < order.length; i++) for (const k of kids.get(order[i]) ?? []) order.push(k);
  const count = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    let c = 0;
    for (const k of kids.get(order[i]) ?? []) c += 1 + (count.get(k) ?? 0);
    count.set(order[i], c);
  }
  const out: FoldDot[] = [];
  for (const name of kids.keys()) {
    const b = name === root ? undefined : boxOf(name);
    if (!b) continue;
    const right = b.x + b.w / 2 >= r.x + r.w / 2;
    out.push({ name, x: right ? b.x + b.w + 9 : b.x - 9, y: b.y + b.h / 2, count: count.get(name) ?? 0, folded: folded.has(name) });
  }
  return out;
}
