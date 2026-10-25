// Diagram step 6, F17 (board DiagramAddNext; draw.io's hover arrows, Miro's +, Lucidchart's quick-add): where the
// next connected shape goes. One standard gap from its source, the gap the diagram already uses between connected
// shapes, centred on the source; when that spot is taken it slides across at the same gap to the first free spot;
// only when the whole row is full does it go further out. A spot is free when it is 24 px clear of every shape and
// of any group it will not join, and its line crosses no shape. Only the shapes near the source are looked at, so
// a 2,000-shape diagram costs no more than a small one.

export type Box = { x: number; y: number; w: number; h: number };
export type Side = "t" | "r" | "b" | "l";

/** Edge-to-edge distance kept between a new shape and every other one. */
const CLEAR = 24;
/** The slide and the reach further out go in 8 px steps, as far as the board's. */
const STEP = 8;
const SLIDE = 480;
const FURTHER = 400;

const median = (a: number[]) => {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
};

/**
 * The gap between connected shapes along an axis ("v" for lines above and below, "h" for left and right): the
 * median edge-to-edge distance, clamped to 32..120; the other axis's when this one has none; else 48.
 */
export function layoutGap(pairs: readonly (readonly [Box, Box])[], axis: "v" | "h"): number {
  const v: number[] = [];
  const h: number[] = [];
  for (const [a, b] of pairs) {
    const gx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
    const gy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
    if (gy > 0 && gy >= gx) v.push(gy);
    else if (gx > 0) h.push(gx);
  }
  const g = median(axis === "v" ? v : h) || median([...v, ...h]) || 48;
  return Math.round(Math.max(32, Math.min(120, g)));
}

export const DIRS: Record<Side, [number, number]> = { t: [0, -1], r: [1, 0], b: [0, 1], l: [-1, 0] };

interface PlaceArgs {
  src: Box;
  dir: Side;
  size: { w: number; h: number };
  gap: number;
  /** Every shape on the canvas (the source among them). */
  boxes: readonly Box[];
  /** Groups the new shape will not belong to, and line labels: kept clear too. */
  avoid?: readonly Box[];
}

/** Where the new shape's top left goes, how far it slid across and how far further out it went; null with no room. */
export function placeNext({ src, dir, size, gap, boxes, avoid = [] }: PlaceArgs): { x: number; y: number; slid: number; out: number } | null {
  const [vx, vy] = DIRS[dir];
  const cx = src.x + src.w / 2;
  const cy = src.y + src.h / 2;
  const ax = vx ? (vx > 0 ? src.x + src.w + gap : src.x - gap - size.w) : Math.round(cx - size.w / 2);
  const ay = vy ? (vy > 0 ? src.y + src.h + gap : src.y - gap - size.h) : Math.round(cy - size.h / 2);
  // Only what the search can reach: a window around the source, built once.
  const reach = gap + FURTHER + SLIDE + Math.max(size.w, size.h) + CLEAR;
  const win = { x: src.x - reach, y: src.y - reach, w: src.w + 2 * reach, h: src.h + 2 * reach };
  const near: Box[] = [];
  for (const b of boxes) if (b !== src && hits(b, win, 0)) near.push(b);
  const obstacles = [...near];
  for (const b of avoid) if (hits(b, win, 0)) obstacles.push(b);
  // The line leaves the source's side the + was on and enters the new shape's facing side.
  const exit = { x: vx ? (vx > 0 ? src.x + src.w : src.x) : cx, y: vy ? (vy > 0 ? src.y + src.h : src.y) : cy };
  const crosses = (x: number, y: number) => {
    const entry = { x: vx ? (vx > 0 ? x : x + size.w) : x + size.w / 2, y: vy ? (vy > 0 ? y : y + size.h) : y + size.h / 2 };
    // Orthogonal: out from the source halfway, across, then in.
    const mid = vx ? { x: (exit.x + entry.x) / 2, y: exit.y } : { x: exit.x, y: (exit.y + entry.y) / 2 };
    const turn = vx ? { x: mid.x, y: entry.y } : { x: entry.x, y: mid.y };
    const legs: [Point, Point][] = [
      [exit, mid],
      [mid, turn],
      [turn, entry],
    ];
    for (const [p, q] of legs) for (const b of near) if (segmentHits(p, q, b)) return true;
    return false;
  };
  const clear = (x: number, y: number) => {
    const nb = { x, y, w: size.w, h: size.h };
    for (const b of obstacles) if (hits(nb, b, CLEAR)) return false;
    return !crosses(x, y);
  };
  for (let out = 0; out <= FURTHER; out += STEP) {
    const steps = (out === 0 ? 2 * SLIDE : SLIDE) / STEP / 2;
    for (let k = 0; k <= steps; k++) {
      for (const sign of k ? [1, -1] : [1]) {
        const off = sign * k * STEP;
        const x = Math.round(vx ? ax + vx * out : ax + off);
        const y = Math.round(vy ? ay + vy * out : ay + off);
        if (clear(x, y)) return { x, y, slid: off, out };
      }
    }
  }
  return null;
}

type Point = { x: number; y: number };

/** Two boxes closer than `pad` on both axes. */
function hits(a: Box, b: Box, pad: number): boolean {
  return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
}

/** A horizontal or vertical segment running through the inside of a box (its 1 px rim aside). */
function segmentHits(p: Point, q: Point, b: Box): boolean {
  const x0 = Math.min(p.x, q.x);
  const x1 = Math.max(p.x, q.x);
  const y0 = Math.min(p.y, q.y);
  const y1 = Math.max(p.y, q.y);
  return x0 < b.x + b.w - 1 && x1 > b.x + 1 && y0 < b.y + b.h - 1 && y1 > b.y + 1;
}

/**
 * A free spot for a new shape near `centre` (the middle of the view, board DiagramAddNext): the first box on rings
 * of 16 px steps around it that is 24 px clear of every shape. Only the shapes near the centre are looked at.
 */
export function freeSpotNear(centre: { x: number; y: number }, size: { w: number; h: number }, boxes: readonly Box[], reach = 640): { x: number; y: number } {
  const x0 = Math.round(centre.x - size.w / 2);
  const y0 = Math.round(centre.y - size.h / 2);
  const win = { x: x0 - reach - CLEAR, y: y0 - reach - CLEAR, w: size.w + 2 * (reach + CLEAR), h: size.h + 2 * (reach + CLEAR) };
  const near = boxes.filter((b) => hits(b, win, 0));
  const free = (x: number, y: number) => {
    const nb = { x, y, w: size.w, h: size.h };
    for (const b of near) if (hits(nb, b, CLEAR)) return false;
    return true;
  };
  if (free(x0, y0)) return { x: x0, y: y0 };
  for (let r = 16; r <= reach; r += 16) {
    // The ring's spots, nearest the centre's row and column first.
    for (let k = 0; k <= r; k += 16) {
      for (const [dx, dy] of [
        [k, -r],
        [-k, -r],
        [k, r],
        [-k, r],
        [-r, k],
        [-r, -k],
        [r, k],
        [r, -k],
      ]) {
        if (free(x0 + dx, y0 + dy)) return { x: x0 + dx, y: y0 + dy };
      }
    }
  }
  return { x: x0, y: y0 };
}
