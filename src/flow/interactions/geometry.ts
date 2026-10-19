// The canvas's editing geometry (spec 6+ section 4, the motion design): the 16 px landing cell, the 4 px
// alignment guides, the 24 px magnet that locks a drawn flow onto a node's nearest port, and which group a
// dragged node is over. Pure functions, in flow coordinates.

/** The snap grid a dropped node settles onto. */
export const SNAP = 16;
/** An edge or centre this close to another node's shows an accent guide. */
export const GUIDE_PX = 4;
/** A drawn flow within this distance of a node locks onto it. */
export const MAGNET_PX = 24;
/** How far a guide runs past the two boxes it joins. */
const GUIDE_OVERRUN = 12;

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const snapTo = (v: number) => Math.round(v / SNAP) * SNAP;

/** The grid cell a node at `box` lands on. */
export function ghostCell(box: Box): Box {
  return { x: snapTo(box.x), y: snapTo(box.y), w: box.w, h: box.h };
}

/** An accent guide: a vertical line at x = `at` (axis x) or a horizontal one at y = `at`, from `from` to `to`. */
export interface Guide {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
}

/**
 * The guides for `lead` against `others`: left edges, centres and right edges (then tops, middles and bottoms)
 * within `px` of each other. Each guide sits on the other node's line and spans both boxes.
 */
export function guidesFor(lead: Box, others: readonly Box[], px = GUIDE_PX): Guide[] {
  const out: Guide[] = [];
  const push = (g: Guide) => {
    const key = `${g.axis}:${g.at}`;
    const had = out.find((o) => `${o.axis}:${o.at}` === key);
    if (had) {
      had.from = Math.min(had.from, g.from);
      had.to = Math.max(had.to, g.to);
      return;
    }
    out.push(g);
  };
  for (const o of others) {
    const xs: [number, number][] = [
      [lead.x, o.x],
      [lead.x + lead.w / 2, o.x + o.w / 2],
      [lead.x + lead.w, o.x + o.w],
    ];
    for (const [a, b] of xs) {
      if (Math.abs(a - b) > px) continue;
      push({ axis: "x", at: b, from: Math.min(lead.y, o.y) - GUIDE_OVERRUN, to: Math.max(lead.y + lead.h, o.y + o.h) + GUIDE_OVERRUN });
    }
    const ys: [number, number][] = [
      [lead.y, o.y],
      [lead.y + lead.h / 2, o.y + o.h / 2],
      [lead.y + lead.h, o.y + o.h],
    ];
    for (const [a, b] of ys) {
      if (Math.abs(a - b) > px) continue;
      push({ axis: "y", at: b, from: Math.min(lead.x, o.x) - GUIDE_OVERRUN, to: Math.max(lead.x + lead.w, o.x + o.w) + GUIDE_OVERRUN });
    }
  }
  return out.sort((a, b) => (a.axis === b.axis ? a.at - b.at : a.axis === "x" ? -1 : 1));
}

export type Side = "r" | "l" | "t" | "b";

/** A cloud service's icon tile: 48 px, centred at the top of its node box, with the name under it. */
export const SERVICE_TILE = 48;

/**
 * The box a line starts and ends on: the whole node, except a cloud service, whose lines and ports are on its
 * 48 px tile, not on the name under it.
 */
export function linkBox(type: string | undefined, box: Box): Box {
  if (type !== "service") return box;
  return { x: box.x + (box.w - SERVICE_TILE) / 2, y: box.y, w: SERVICE_TILE, h: SERVICE_TILE };
}

/** Where a node's round port sits (flow-canvas.css: the middle of each side). */
export function portAt(box: Box, side: Side): Point {
  if (side === "r") return { x: box.x + box.w, y: box.y + box.h / 2 };
  if (side === "l") return { x: box.x, y: box.y + box.h / 2 };
  if (side === "t") return { x: box.x + box.w / 2, y: box.y };
  return { x: box.x + box.w / 2, y: box.y + box.h };
}

/** Distance from `p` to the box (0 inside it). */
function distance(p: Point, b: Box): number {
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
  return Math.hypot(dx, dy);
}

/** The node a drawn flow locks onto at `p` (the nearest within `px` of its box), and its port nearest `p`. */
export function magnetTarget(p: Point, nodes: readonly { id: string; box: Box }[], px = MAGNET_PX): { id: string; side: Side } | null {
  let best: { id: string; box: Box; d: number } | null = null;
  for (const n of nodes) {
    const d = distance(p, n.box);
    if (d > px) continue;
    if (!best || d < best.d) best = { id: n.id, box: n.box, d };
  }
  if (!best) return null;
  let side: Side = "r";
  let near = Infinity;
  for (const s of ["r", "l", "t", "b"] as const) {
    const q = portAt(best.box, s);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < near) {
      near = d;
      side = s;
    }
  }
  return { id: best.id, side };
}

/** The innermost group whose area holds `p`, or null. */
export function groupAt(p: Point, groups: readonly { name: string; box: Box; depth: number }[]): string | null {
  let hit: { name: string; depth: number } | null = null;
  for (const g of groups) {
    const b = g.box;
    if (p.x <= b.x || p.x >= b.x + b.w || p.y <= b.y || p.y >= b.y + b.h) continue;
    if (!hit || g.depth > hit.depth) hit = g;
  }
  return hit?.name ?? null;
}
