// Square-cornered routing for drawn diagrams (spec 6+ section 3 "Lines", the motion artifact's `route`):
// leave the side facing the other node, run square, and round each corner by up to 8 px.

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RouteOptions {
  /** Corner radius; 8 px by default, clamped on short runs. */
  radius?: number;
  /** `b` is the pointer while drawing a flow: run from the side facing it straight to its top-left corner. */
  toPoint?: boolean;
  /** The side the line must leave `a` from (the port that was pressed while drawing a flow, item 18). */
  from?: "r" | "l" | "t" | "b";
  /**
   * Diagram step 6: the axis a line was added on with a + (board DiagramAddNext): "v" leaves from the top or bottom,
   * "h" from a side, whatever the boxes' offset, so the kept line looks like the one drawn with the new shape.
   */
  axis?: "v" | "h";
}

export interface Route {
  /** SVG path data. */
  d: string;
  /** The middle of the middle run, where a label chip sits. */
  mid: Point;
  /** Where the line ends, for the arrowhead. */
  end: Point;
  /** The corners of the route before rounding, first to last (an export redraws them with `roundedPath`). */
  points: Point[];
}

/** Side by side only with this much room between the boxes; closer than that the line runs vertically. */
const SIDE_GAP = 24;

const f = (n: number) => String(Math.round(n * 100) / 100 + 0);

/** Within this distance two coordinates are the same line, so a fractional jog never curls into a corner. */
const SAME = 0.5;

/**
 * Snaps a coordinate within half a pixel of the point before it onto that point's line, then drops repeated
 * points and points in the middle of a straight run.
 */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const q of points) {
    const last = out[out.length - 1];
    const p = last ? { x: Math.abs(q.x - last.x) <= SAME ? last.x : q.x, y: Math.abs(q.y - last.y) <= SAME ? last.y : q.y } : q;
    if (last && p.x === last.x && p.y === last.y) continue;
    const prev = out[out.length - 2];
    if (prev && last && ((prev.x === last.x && last.x === p.x) || (prev.y === last.y && last.y === p.y))) out.pop();
    out.push(p);
  }
  return out;
}

/** A polyline with each corner rounded by up to `r`, never more than half of either run beside it. */
function rounded(points: Point[], r: number): string {
  const p = simplify(points);
  let d = `M ${f(p[0].x)} ${f(p[0].y)}`;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1];
    const b = p[i];
    const c = p[i + 1];
    const r1 = Math.min(r, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const u = { x: Math.sign(a.x - b.x), y: Math.sign(a.y - b.y) };
    const v = { x: Math.sign(c.x - b.x), y: Math.sign(c.y - b.y) };
    d += ` L ${f(b.x + u.x * r1)} ${f(b.y + u.y * r1)} Q ${f(b.x)} ${f(b.y)} ${f(b.x + v.x * r1)} ${f(b.y + v.y * r1)}`;
  }
  const z = p[p.length - 1];
  return p.length > 1 ? `${d} L ${f(z.x)} ${f(z.y)}` : d;
}

/** SVG path data for a square route through `points`, each corner rounded by up to `r` (8 px by default). */
export function roundedPath(points: Point[], r = 8): string {
  return points.length === 0 ? "" : rounded(points, r);
}

/** Horizontal, vertical, horizontal: from `s` across to the middle, along, then on to `e`. */
const hvh = (s: Point, e: Point): Point[] => {
  const mx = (s.x + e.x) / 2;
  return [s, { x: mx, y: s.y }, { x: mx, y: e.y }, e];
};
/** Vertical, horizontal, vertical. */
const vhv = (s: Point, e: Point): Point[] => {
  const my = (s.y + e.y) / 2;
  return [s, { x: s.x, y: my }, { x: e.x, y: my }, e];
};

/** Clear of the node before a line turns back past the side it left from. */
const STUB = 16;

/** Out of side `side` of `a` to the point `e`: straight on when `e` lies beyond that side, else out a stub and around. */
function fromSide(a: Rect, side: "r" | "l" | "t" | "b", e: Point): Point[] {
  const acy = a.y + a.h / 2;
  const acx = a.x + a.w / 2;
  if (side === "r" || side === "l") {
    const dir = side === "r" ? 1 : -1;
    const s = { x: side === "r" ? a.x + a.w : a.x, y: acy };
    if ((e.x - s.x) * dir >= STUB) return hvh(s, e);
    const sx = s.x + dir * STUB;
    return [s, { x: sx, y: s.y }, { x: sx, y: e.y }, e];
  }
  const dir = side === "b" ? 1 : -1;
  const s = { x: acx, y: side === "b" ? a.y + a.h : a.y };
  if ((e.y - s.y) * dir >= STUB) return vhv(s, e);
  const sy = s.y + dir * STUB;
  return [s, { x: s.x, y: sy }, { x: e.x, y: sy }, e];
}

/** The square route from box `a` to box `b` (or to the pointer with `toPoint`). */
export function routeOrthogonal(a: Rect, b: Rect, opts: RouteOptions = {}): Route {
  const acy = a.y + a.h / 2;
  const acx = a.x + a.w / 2;
  let pts: Point[];
  if (opts.toPoint && opts.from) {
    pts = fromSide(a, opts.from, { x: b.x, y: b.y });
  } else if (opts.axis === "v") {
    const bcy = b.y + b.h / 2;
    pts = bcy >= acy ? vhv({ x: acx, y: a.y + a.h }, { x: b.x + b.w / 2, y: b.y }) : vhv({ x: acx, y: a.y }, { x: b.x + b.w / 2, y: b.y + b.h });
  } else if (opts.axis === "h") {
    const bcx = b.x + b.w / 2;
    pts = bcx >= acx ? hvh({ x: a.x + a.w, y: acy }, { x: b.x, y: b.y + b.h / 2 }) : hvh({ x: a.x, y: acy }, { x: b.x + b.w, y: b.y + b.h / 2 });
  } else if (opts.toPoint) {
    const e = { x: b.x, y: b.y };
    pts = hvh(e.x < a.x ? { x: a.x, y: acy } : { x: a.x + a.w, y: acy }, e);
  } else if (b.x >= a.x + a.w + SIDE_GAP) {
    pts = hvh({ x: a.x + a.w, y: acy }, { x: b.x, y: b.y + b.h / 2 });
  } else if (b.x + b.w <= a.x - SIDE_GAP) {
    pts = hvh({ x: a.x, y: acy }, { x: b.x + b.w, y: b.y + b.h / 2 });
  } else if (b.y >= a.y) {
    pts = vhv({ x: acx, y: a.y + a.h }, { x: b.x + b.w / 2, y: b.y });
  } else {
    pts = vhv({ x: acx, y: a.y }, { x: b.x + b.w / 2, y: b.y + b.h });
  }
  return {
    d: rounded(pts, opts.radius ?? 8),
    mid: { x: (pts[1].x + pts[2].x) / 2, y: (pts[1].y + pts[2].y) / 2 },
    end: pts[3],
    points: simplify(pts),
  };
}

/**
 * ER build C (erd-ux-research 5.4): a relationship between columns leaves and enters at each row's y (`ay`, `by`)
 * on the side that faces the other card, as draw.io's ERD tables and MySQL Workbench draw a foreign key. Cards
 * that overlap across are both left on the right, around the further edge; a relationship between two columns of
 * one card (`self`) loops out on its right.
 */
export function routeRows(a: Rect, ay: number, b: Rect, by: number, self = false): Route {
  let pts: Point[];
  if (self) {
    const x = a.x + a.w;
    const out = x + SIDE_GAP;
    pts = [{ x, y: ay }, { x: out, y: ay }, { x: out, y: by }, { x, y: by }];
  } else if (b.x >= a.x + a.w + SIDE_GAP) {
    pts = hvh({ x: a.x + a.w, y: ay }, { x: b.x, y: by });
  } else if (b.x + b.w <= a.x - SIDE_GAP) {
    pts = hvh({ x: a.x, y: ay }, { x: b.x + b.w, y: by });
  } else {
    const sx = a.x + a.w;
    const ex = b.x + b.w;
    const out = Math.max(sx, ex) + SIDE_GAP;
    pts = [{ x: sx, y: ay }, { x: out, y: ay }, { x: out, y: by }, { x: ex, y: by }];
  }
  return {
    d: rounded(pts, 8),
    mid: { x: (pts[1].x + pts[2].x) / 2, y: (pts[1].y + pts[2].y) / 2 },
    end: pts[3],
    points: simplify(pts),
  };
}
