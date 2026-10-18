// The engine's edges: the markers, the orthogonal edge (8 px corners) with its badge slot, and the straight edge of fast mode.
import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getSmoothStepPath, getStraightPath } from "@xyflow/react";
import type { ReactNode } from "react";

/** Many side of a Foreign Key: a crow's foot with a bar (Schema Builder). */
export const MANY_MARKER = "crow-many";
/** One side of a Foreign Key: a double bar (Schema Builder). */
export const ONE_MARKER = "bar-one";
/** Lineage into the Result node: a 6 px filled arrow. */
export const ARROW_MARKER = "arrow";

/** Corner radius of an orthogonal edge (DESIGN-NEXT 10.6). */
export const EDGE_RADIUS = 8;

/** What an engine edge may carry: `badge` fills the Join badge at the midpoint. */
export type DiagramEdgeData = { badge?: ReactNode };

/**
 * The marker definitions edges refer to by id (`markerStart`, `markerEnd`). Strokes and fills come
 * from `.edge-marker` in app.css, so the theme colours them.
 */
export function EdgeMarkers() {
  return (
    <svg className="edge-markers" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <marker
          id={MANY_MARKER}
          viewBox="0 0 14 14"
          refX="14"
          refY="7"
          markerWidth="14"
          markerHeight="14"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path className="edge-marker" d="M4 7L14 1M4 7H14M4 7L14 13M2 2V12" />
        </marker>
        <marker
          id={ONE_MARKER}
          viewBox="0 0 14 14"
          refX="14"
          refY="7"
          markerWidth="14"
          markerHeight="14"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path className="edge-marker" d="M6 2V12M9.5 2V12" />
        </marker>
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
