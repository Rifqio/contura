// ER step 2.5 and diagram step 5 (erd-ux-research 5.5, decision 1; diagram-ux-research F7): smart alignment guides
// in place of the 16 px grid. A dragged box snaps when one of its edges or its centre comes within 6 screen px of an
// edge or centre of a nearby shape (Figma, Miro, draw.io): its left or right edge to another's left or right edge,
// its centre to another's centre. The index is built once a drag starts from the shapes on screen, sorted per axis,
// so each frame is a binary search, not a scan of every shape: it stays cheap at 2,000 shapes.

export interface GuideBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A 1 px guide: a vertical line at x = `at` (axis x) or a horizontal one at y = `at`, from `from` to `to`. */
export interface GuideLine {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
}

/** A dragged edge or centre this close to another, in screen px, snaps onto it (erd-ux-research 5.5). */
export const GUIDE_REACH_PX = 6;
/** How far a guide runs past the boxes it joins (board ER interactions). */
const OVERRUN = 8;

/** Sorted values and the box each came from. */
interface Line {
  at: Float64Array;
  box: Int32Array;
}

function lineOf(values: { v: number; i: number }[]): Line {
  values.sort((a, b) => a.v - b.v);
  const at = new Float64Array(values.length);
  const box = new Int32Array(values.length);
  values.forEach((e, k) => {
    at[k] = e.v;
    box[k] = e.i;
  });
  return { at, box };
}

/** The first index whose value is at least `v`. */
function lowerBound(a: Float64Array, v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The value in `line` nearest `v` within `reach`, as the distance to it (null when none). */
function nearest(line: Line, v: number, reach: number): number | null {
  const k = lowerBound(line.at, v - reach);
  let best: number | null = null;
  for (let j = k; j < line.at.length && line.at[j] <= v + reach; j++) {
    const d = line.at[j] - v;
    if (best === null || Math.abs(d) < Math.abs(best)) best = d;
  }
  return best;
}

/** Which boxes have a value at `at` (within half a pixel) on `line`. */
function boxesAt(line: Line, at: number): number[] {
  const out: number[] = [];
  for (let j = lowerBound(line.at, at - 0.5); j < line.at.length && line.at[j] <= at + 0.5; j++) out.push(line.box[j]);
  return out;
}

export interface GuideSnap {
  /** What to add to the box's x and y so it lines up (0 where nothing is near). */
  dx: number;
  dy: number;
  lines: GuideLine[];
}

/** The edges and centres of the shapes a drag can line up with. */
export class GuideIndex {
  private readonly boxes: readonly GuideBox[];
  private readonly xEdges: Line;
  private readonly xMids: Line;
  private readonly yEdges: Line;
  private readonly yMids: Line;

  constructor(boxes: readonly GuideBox[]) {
    this.boxes = boxes;
    const xe: { v: number; i: number }[] = [];
    const xm: { v: number; i: number }[] = [];
    const ye: { v: number; i: number }[] = [];
    const ym: { v: number; i: number }[] = [];
    boxes.forEach((b, i) => {
      xe.push({ v: b.x, i }, { v: b.x + b.w, i });
      xm.push({ v: b.x + b.w / 2, i });
      ye.push({ v: b.y, i }, { v: b.y + b.h, i });
      ym.push({ v: b.y + b.h / 2, i });
    });
    this.xEdges = lineOf(xe);
    this.xMids = lineOf(xm);
    this.yEdges = lineOf(ye);
    this.yMids = lineOf(ym);
  }

  get size(): number {
    return this.boxes.length;
  }

  /**
   * Where `box` snaps within `reach` (flow px), per axis that is free to snap, and the guides it then lies on. An
   * axis held by Shift's axis lock is left out by the caller.
   */
  snap(box: GuideBox, reach: number, axes: { x: boolean; y: boolean } = { x: true, y: true }): GuideSnap {
    const pick = (edges: Line, mids: Line, start: number, size: number): number | null => {
      let best: number | null = null;
      const consider = (d: number | null) => {
        if (d !== null && (best === null || Math.abs(d) < Math.abs(best))) best = d;
      };
      consider(nearest(edges, start, reach));
      consider(nearest(edges, start + size, reach));
      consider(nearest(mids, start + size / 2, reach));
      return best;
    };
    const dx = axes.x ? pick(this.xEdges, this.xMids, box.x, box.w) : null;
    const dy = axes.y ? pick(this.yEdges, this.yMids, box.y, box.h) : null;
    const at = { x: box.x + (dx ?? 0), y: box.y + (dy ?? 0), w: box.w, h: box.h };
    const lines: GuideLine[] = [];
    if (dx !== null) {
      for (const [v, line] of [
        [at.x, this.xEdges],
        [at.x + at.w, this.xEdges],
        [at.x + at.w / 2, this.xMids],
      ] as const) {
        const hits = boxesAt(line, v);
        if (hits.length === 0) continue;
        let from = at.y;
        let to = at.y + at.h;
        for (const i of hits) {
          from = Math.min(from, this.boxes[i].y);
          to = Math.max(to, this.boxes[i].y + this.boxes[i].h);
        }
        lines.push({ axis: "x", at: v, from: from - OVERRUN, to: to + OVERRUN });
      }
    }
    if (dy !== null) {
      for (const [v, line] of [
        [at.y, this.yEdges],
        [at.y + at.h, this.yEdges],
        [at.y + at.h / 2, this.yMids],
      ] as const) {
        const hits = boxesAt(line, v);
        if (hits.length === 0) continue;
        let from = at.x;
        let to = at.x + at.w;
        for (const i of hits) {
          from = Math.min(from, this.boxes[i].x);
          to = Math.max(to, this.boxes[i].x + this.boxes[i].w);
        }
        lines.push({ axis: "y", at: v, from: from - OVERRUN, to: to + OVERRUN });
      }
    }
    return { dx: dx ?? 0, dy: dy ?? 0, lines };
  }
}

/** Shift held while dragging keeps the move on the axis it has gone furthest along (Figma, Miro). */
export function lockAxis(dx: number, dy: number): { dx: number; dy: number; axis: "x" | "y" } {
  return Math.abs(dx) >= Math.abs(dy) ? { dx, dy: 0, axis: "x" } : { dx: 0, dy, axis: "y" };
}
