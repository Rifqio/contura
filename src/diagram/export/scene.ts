// A diagram as plain data for export: every client (Schema Builder, query diagram) builds one,
// and svg.ts draws it, so exports look the same whichever screen made them.
import type { EdgeKind, NodeKind } from "../types";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SceneRow {
  left: string;
  right?: string;
  mark?: "pk" | "fk";
}

export interface SceneNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  subtitle?: string;
  rows: SceneRow[];
  /** Lines under the rows, such as a Result's clauses; the first word is drawn as a keyword. */
  footer?: string[];
}

export interface SceneEdge {
  id: string;
  /** An orthogonal route: the first point leaves the source, the last enters the target. */
  points: { x: number; y: number }[];
  kind: EdgeKind;
  label?: string;
}

export interface Scene {
  nodes: SceneNode[];
  edges: SceneEdge[];
}

/** The box around the chosen nodes (every node and edge when `ids` is absent); all zero when empty. */
export function sceneBounds(scene: Scene, ids?: string[]): Box {
  const pick = ids ? new Set(ids) : null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const take = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const n of scene.nodes) {
    if (pick && !pick.has(n.id)) continue;
    take(n.x, n.y);
    take(n.x + n.w, n.y + n.h);
  }
  if (!pick) for (const e of scene.edges) for (const p of e.points) take(p.x, p.y);
  if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
