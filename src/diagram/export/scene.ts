// A diagram as plain data for export: every client (Schema Builder, query diagram, the drawn diagrams and
// lineage) builds one, and svg.ts draws it, so exports look the same whichever screen made them.
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
  /** An ER column that is never null (a key, or `not null`): the canvas's filled diamond. */
  notNull?: boolean;
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
  /** A dashed outline: lineage's diagram and view cards, and a table it could not read. */
  dashed?: boolean;
  /**
   * A drawn diagram node (step 6+) and how it looks: Modern or the Classic Gane-Sarson shapes. Set for every
   * drawn kind (process to service); card kinds leave it out and draw as table cards.
   */
  look?: "modern" | "classic";
  /** A drawn node's second line: the kind in words, or the `schema.table` it links. */
  sub?: string;
  /** A drawn node's `id` attribute (`1.0`, `D1`), in its id cell. */
  tag?: string;
  /** A drawn node links a table: the link glyph before `sub`. */
  linked?: boolean;
  /**
   * A cloud service's icon as a `data:image/` URL, drawn as an image, unchanged (ruling P9: never as markup).
   * Absent with `iconName` set means the pack has no such icon: the dashed cube tile.
   */
  icon?: string;
  /** The `icon:` name a service asks for. */
  iconName?: string;
  /** The light plate behind a general or brand icon; provider icons draw without one. */
  plate?: boolean;
}

/** A group in a drawn diagram: a tinted area behind its nodes, named at the top left. */
export interface SceneArea {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0 for a group in no group; inner groups have a solid edge. */
  depth: number;
  /** The group's icon as a `data:image/` URL, drawn small before its name. */
  icon?: string;
}

/** `flow` is a drawn diagram's or lineage's line: square with 8 px corners, 6 px arrowheads, a label chip. */
export type SceneEdgeKind = EdgeKind | "flow";

export interface SceneEdge {
  id: string;
  /** An orthogonal route: the first point leaves the source, the last enters the target. */
  points: { x: number; y: number }[];
  kind: SceneEdgeKind;
  label?: string;
  /** A `flow` line drawn dashed (`-->`, lineage's diagram lines) or dotted (a cloud `..>`). */
  line?: "dashed" | "dotted";
  /** Arrowheads on a `flow` line: at the end (the default), at both ends, at the start, or none. */
  heads?: "end" | "both" | "start" | "none";
}

export interface Scene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  /** Group areas, outermost first; drawn behind the lines and nodes. */
  areas?: SceneArea[];
}

/** Every edge a crop can snap to: the left and right of each node and area, and their tops and bottoms. */
export function sceneEdges(scene: Scene): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const b of [...scene.nodes, ...(scene.areas ?? [])]) {
    xs.push(b.x, b.x + b.w);
    ys.push(b.y, b.y + b.h);
  }
  return { xs, ys };
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
  if (!pick) {
    for (const e of scene.edges) for (const p of e.points) take(p.x, p.y);
    for (const a of scene.areas ?? []) {
      take(a.x, a.y);
      take(a.x + a.w, a.y + a.h);
    }
  }
  if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
