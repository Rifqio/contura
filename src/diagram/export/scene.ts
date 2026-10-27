// A diagram as plain data for export: every client (Schema Builder, query diagram, the drawn diagrams and
// lineage) builds one, and svg.ts draws it, so exports look the same whichever screen made them.
import type { PaletteName } from "../../lang/flow/model";
import type { EdgeKind, NodeKind } from "../types";

/** The colour a drawn shape, group or line takes: one of the six presets (`color: danger`) or a custom hex. */
export type SceneColour = PaletteName | `#${string}`;

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
  /**
   * An ER column's null mark: true when it is never null (a key, or `not null`), the canvas's filled diamond; false
   * when it may be, the outline. Absent on every other card's rows.
   */
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
  /** A pale logo on light: drawn with the hairline filter in the text colour. */
  iconOutline?: boolean;
  /** The `icon:` name a service asks for. */
  iconName?: string;
  /** A mind map topic's level: 1 a branch topic (a pill), 2 and deeper plain words on a line. */
  depth?: number;
  /** A sequence participant's activation bars, measured from the node's top. */
  bars?: { top: number; height: number }[];
  /** Step 11: its palette colour, in place of its kind's. */
  color?: SceneColour;
}

/** A sequence frame (`loop`, `alt`, `opt`, `par`, `critical`): a box over its message rows, its label in a tab. */
export interface SceneFrame {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
}

/** A timeline section: a quiet dashed band behind its items, named at the top. */
export interface SceneSection {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A timeline's line at `y` from `x` for `w`, with a tick where each item meets it. */
export interface SceneAxis {
  x: number;
  y: number;
  w: number;
  ticks: { x: number; milestone: boolean }[];
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
  /** A pale logo on light: drawn with the hairline filter in the text colour. */
  iconOutline?: boolean;
  /** Step 11: its palette colour: its border, tint and title. */
  color?: SceneColour;
}

/**
 * `flow` is a drawn diagram's or lineage's line: square with 8 px corners, 6 px arrowheads, a label chip. `message` is a
 * sequence message, straight along its row (a message to itself loops out right); `branch` a mind map's curved tree line.
 */
export type SceneEdgeKind = EdgeKind | "flow" | "message" | "branch";

/**
 * A line end as the canvas marks it: a filled head, an open head, a hollow triangle (a parent), a filled diamond (a
 * whole), or an ER relationship's crow's-foot ends: a bar at a one end, a crow's foot at a many end.
 */
export type SceneMark = "arrow" | "open" | "triangle" | "diamond" | "one" | "many";

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
  /** The marks at each end of a class line, an ER relationship or a message; when set they replace `heads`. */
  marks?: { start?: SceneMark; end?: SceneMark };
  /** Step 11: its palette colour, its arrowheads too. */
  color?: SceneColour;
}

export interface Scene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  /** Group areas, outermost first; drawn behind the lines and nodes. */
  areas?: SceneArea[];
  /** A sequence's frames, outermost first: the boxes behind the participants, their tabs over them. */
  frames?: SceneFrame[];
  /** A timeline's sections, behind everything, and its axis, behind the items. */
  sections?: SceneSection[];
  axis?: SceneAxis;
  /** The frame's text size as a label scale (Decision 22): every label's font size is multiplied by it; unset at 1. */
  textScale?: number;
}

/** Every edge a crop can snap to: the left and right of each node and area, and their tops and bottoms. */
export function sceneEdges(scene: Scene): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const b of [...scene.nodes, ...(scene.areas ?? []), ...(scene.frames ?? []), ...(scene.sections ?? [])]) {
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
    for (const a of [...(scene.areas ?? []), ...(scene.frames ?? []), ...(scene.sections ?? [])]) {
      take(a.x, a.y);
      take(a.x + a.w, a.y + a.h);
    }
    if (scene.axis) {
      take(scene.axis.x, scene.axis.y - 7);
      take(scene.axis.x + scene.axis.w, scene.axis.y + 7);
    }
  }
  if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
