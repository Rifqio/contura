// The engine's edges: the markers, the orthogonal edge (8 px corners) with its badge slot, and the straight edge of fast mode.
import { BaseEdge, type Edge, EdgeLabelRenderer, type EdgeProps, getSmoothStepPath, getStraightPath } from "@xyflow/react";
import type { ReactNode } from "react";
import { PALETTE_TOKENS } from "./types";

/** Many side of a Foreign Key: a crow's foot with a bar (Schema Builder). */
export const MANY_MARKER = "crow-many";
/** One side of a Foreign Key: a double bar (Schema Builder). */
export const ONE_MARKER = "bar-one";
/** Lineage into the Result node: a 6 px filled arrow. */
export const ARROW_MARKER = "arrow";
/** Step 12 class lines: a hollow triangle at the parent, a filled diamond at the whole, an open arrow on a dependency. */
export const TRIANGLE_MARKER = "hollow-triangle";
export const DIAMOND_MARKER = "filled-diamond";
export const OPEN_ARROW_MARKER = "open-arrow";
/** The arrowhead of a coloured line keeps its colour: one marker per preset, one per custom hex in use (no `#` in an id). */
export const colourArrow = (colour: keyof typeof PALETTE_TOKENS | `#${string}`) => (colour[0] === "#" ? `${HEX_ARROW}${colour.slice(1)}` : `${ARROW_MARKER}-${colour}`);
const HEX_ARROW = `${ARROW_MARKER}-hex-`;
/** An ER relationship's crow's-foot end on a coloured line keeps the line's colour, as an arrowhead does. */
export const colourEnd = (end: typeof MANY_MARKER | typeof ONE_MARKER, colour: keyof typeof PALETTE_TOKENS | `#${string}`) =>
  colour[0] === "#" ? `${end}-hex-${colour.slice(1)}` : `${end}-${colour}`;
const HEX_PREFIXES = [HEX_ARROW, `${MANY_MARKER}-hex-`, `${ONE_MARKER}-hex-`];

/** The distinct custom colours the edges' coloured ends use, sorted: the marker set follows the scene and never grows. */
export function hexArrowsIn(edges: readonly Pick<Edge, "markerStart" | "markerEnd">[]): `#${string}`[] {
  const found = new Set<`#${string}`>();
  for (const e of edges) {
    for (const m of [e.markerStart, e.markerEnd]) {
      if (typeof m !== "string") continue;
      const prefix = HEX_PREFIXES.find((p) => m.startsWith(p));
      if (prefix) found.add(`#${m.slice(prefix.length)}`);
    }
  }
  return [...found].sort();
}

/** The crow's foot and the bar, in `stroke` when coloured. */
function CrowEnds({ many, one, stroke }: { many: string; one: string; stroke?: string }) {
  const style = stroke ? { stroke } : undefined;
  return (
    <>
      <marker id={many} viewBox="0 0 14 14" refX="14" refY="7" markerWidth="14" markerHeight="14" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
        <path className="edge-marker" style={style} d="M4 7L14 1M4 7H14M4 7L14 13M2 2V12" />
      </marker>
      <marker id={one} viewBox="0 0 14 14" refX="14" refY="7" markerWidth="14" markerHeight="14" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
        <path className="edge-marker" style={style} d="M6 2V12M9.5 2V12" />
      </marker>
    </>
  );
}

/** Corner radius of an orthogonal edge (DESIGN-NEXT 10.6). */
export const EDGE_RADIUS = 8;

/** What an engine edge may carry: `badge` fills the Join badge at the midpoint. */
export type DiagramEdgeData = { badge?: ReactNode };

/**
 * The marker definitions edges refer to by id (`markerStart`, `markerEnd`). Strokes and fills come
 * from `.edge-marker` in app.css, so the theme colours them.
 */
export function EdgeMarkers({ hexes = [] }: { hexes?: readonly `#${string}`[] }) {
  return (
    <svg className="edge-markers" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <CrowEnds many={MANY_MARKER} one={ONE_MARKER} />
        <marker
          id={ARROW_MARKER}
          viewBox="0 0 6 6"
          refX="6"
          refY="3"
          markerWidth="6"
          markerHeight="6"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path className="edge-marker-fill" d="M0 0L6 3L0 6Z" />
        </marker>
        {(Object.keys(PALETTE_TOKENS) as (keyof typeof PALETTE_TOKENS)[]).map((c) => (
          <marker key={c} id={colourArrow(c)} viewBox="0 0 6 6" refX="6" refY="3" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path className="edge-marker-fill" style={{ fill: `var(${PALETTE_TOKENS[c].stroke})` }} d="M0 0L6 3L0 6Z" />
          </marker>
        ))}
        {hexes.map((h) => (
          <marker key={h} id={colourArrow(h)} viewBox="0 0 6 6" refX="6" refY="3" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path className="edge-marker-fill" style={{ fill: h }} d="M0 0L6 3L0 6Z" />
          </marker>
        ))}
        {(Object.keys(PALETTE_TOKENS) as (keyof typeof PALETTE_TOKENS)[]).map((c) => (
          <CrowEnds key={`crow-${c}`} many={colourEnd(MANY_MARKER, c)} one={colourEnd(ONE_MARKER, c)} stroke={`var(${PALETTE_TOKENS[c].stroke})`} />
        ))}
        {hexes.map((h) => (
          <CrowEnds key={`crow-${h}`} many={colourEnd(MANY_MARKER, h)} one={colourEnd(ONE_MARKER, h)} stroke={h} />
        ))}
        <marker id={TRIANGLE_MARKER} viewBox="0 0 12 12" refX="12" refY="6" markerWidth="12" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
          <path className="edge-marker edge-marker-hollow" d="M1 1L12 6L1 11Z" />
        </marker>
        <marker id={DIAMOND_MARKER} viewBox="0 0 14 10" refX="14" refY="5" markerWidth="14" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
          <path className="edge-marker-fill" d="M0 5L7 0L14 5L7 10Z" />
        </marker>
        <marker id={OPEN_ARROW_MARKER} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
          <path className="edge-marker" d="M1 1L10 5L1 9" />
        </marker>
      </defs>
    </svg>
  );
}

export default EdgeMarkers;

/**
 * The badge at an edge's midpoint, in screen space over the edge layer: Task 8 puts the Venn mark
 * and the Join kind in it. It takes clicks; the canvas does not pan or drag from it.
 */
export function JoinBadge({ x, y, children, className }: { x: number; y: number; children: ReactNode; className?: string }) {
  return (
    <EdgeLabelRenderer>
      <div
        className={className ? `edge-badge nodrag nopan ${className}` : "edge-badge nodrag nopan"}
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
      >
        {children}
      </div>
    </EdgeLabelRenderer>
  );
}

/** The path of an orthogonal edge and its midpoint, for edge types built on it (a Join edge). */
export function orthogonalPath(p: Pick<EdgeProps, "sourceX" | "sourceY" | "sourcePosition" | "targetX" | "targetY" | "targetPosition">) {
  const [path, x, y] = getSmoothStepPath({ ...p, borderRadius: EDGE_RADIUS });
  return { path, x, y };
}

/** A box on the canvas, in flow coordinates. */
export interface FlowBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The corner points of an SVG path made of M, L and Q commands (a Q's end point is a corner's end). */
export function pathPoints(d: string): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const re = /([MLQ])([^MLQ]*)/g;
  for (let m = re.exec(d); m; m = re.exec(d)) {
    const n = (m[2].match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    if (n.length >= 2) out.push({ x: n[n.length - 2], y: n[n.length - 1] });
  }
  return out;
}

/**
 * Item 31: where an edge's badge goes so it covers no card: its midpoint when that is clear, else the middle of
 * the longest run of the path that is, else the midpoint after all. `size` is the badge's box.
 */
export function clearBadgeSpot(d: string, mid: { x: number; y: number }, boxes: FlowBox[], size = { w: 72, h: 22 }): { x: number; y: number } {
  const pad = 4;
  const covers = (p: { x: number; y: number }) =>
    boxes.some((b) => p.x + size.w / 2 + pad > b.x && p.x - size.w / 2 - pad < b.x + b.w && p.y + size.h / 2 + pad > b.y && p.y - size.h / 2 - pad < b.y + b.h);
  if (!covers(mid)) return mid;
  const pts = pathPoints(d);
  let best: { x: number; y: number } | null = null;
  let bestLen = -1;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (len > bestLen && !covers(m)) {
      best = m;
      bestLen = len;
    }
  }
  return best ?? mid;
}

/** Edge type `orthogonal`: right angles with 8 px corners, and the Join badge when `data.badge` is set. */
export function OrthogonalEdge(props: EdgeProps) {
  const { path, x, y } = orthogonalPath(props);
  const badge = (props.data as DiagramEdgeData | undefined)?.badge;
  return (
    <>
      <BaseEdge id={props.id} path={path} markerStart={props.markerStart} markerEnd={props.markerEnd} style={props.style} interactionWidth={props.interactionWidth} />
      {badge != null && <JoinBadge x={x} y={y}>{badge}</JoinBadge>}
    </>
  );
}

/** Edge type `straight`: what every edge draws as in fast mode; no badge. */
export function StraightEdge(props: EdgeProps) {
  const [path] = getStraightPath(props);
  return <BaseEdge id={props.id} path={path} markerStart={props.markerStart} markerEnd={props.markerEnd} style={props.style} interactionWidth={0} />;
}
