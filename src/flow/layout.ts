// A diagram's layout file, `<name>.flow.layout.json`: where each node sits, the view, the node look and the
// direction Tidy lays out in. The text never holds any of these, so moving a node leaves the .flow file alone.
import type { Positions, Viewport } from "../diagram/layout";
import type { DiagramKind } from "../lang/flow/model";
import type { NodeLook } from "./nodes/parts";

export type FlowDirection = "TB" | "LR";

export interface FlowLayout {
  version: 1;
  /** Node positions by name; a plain-key map (no prototype), so any name is a key. */
  nodes: Positions;
  viewport?: Viewport;
  /** Modern cards or the textbook Gane-Sarson shapes (frame 6+.2); kept per diagram. */
  style: NodeLook;
  /** Used by Tidy and by the placement of new nodes; the text does not change. */
  direction: FlowDirection;
  /** Item 21: the sizes nodes were resized to on the canvas, by name; a node with none takes its kind's size. */
  sizes?: Record<string, { w: number; h: number }>;
  /**
   * Diagram step 6: the axis of a line added with a +, by `axisKey(from, to)`, so it keeps the side it was drawn on
   * (board DiagramAddNext). Only lines that still exist are kept.
   */
  axes?: Record<string, "v" | "h">;
}

/** The key a line's axis is kept under: its two ends, as JSON, so any name is safe. */
export const axisKey = (from: string, to: string) => JSON.stringify([from, to]);

/** A key's two ends, or null for a key that is not one (a hand-edited file): such a key is ignored (round 2, N-C). */
export function axisEnds(key: string): [string, string] | null {
  try {
    const v: unknown = JSON.parse(key);
    return Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string" ? [v[0], v[1]] : null;
  } catch {
    return null;
  }
}

/** A flowchart runs top to bottom (answer 7A); a data flow and a cloud diagram read left to right, as their frames do. */
export function defaultDirection(kind: DiagramKind | null): FlowDirection {
  return kind === "dfd" || kind === "cloud" ? "LR" : "TB";
}

export function emptyPositions(): Positions {
  return Object.create(null) as Positions;
}

export const isPoint = (v: unknown): v is { x: number; y: number } =>
  typeof v === "object" && v !== null && Number.isFinite((v as { x: unknown }).x) && Number.isFinite((v as { y: unknown }).y);

/** Never throws: a missing or unreadable file, or a missing field, takes the default. */
export function parseFlowLayout(json: string | null, kind: DiagramKind | null): FlowLayout {
  const out: FlowLayout = { version: 1, nodes: emptyPositions(), style: "modern", direction: defaultDirection(kind) };
  if (!json) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return out;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return out;
  return readFlowParts(r, out);
}

/** The fields of one layout object (a version 1 file, or one frame of a version 2 file) read onto `out`; never throws. */
export function readFlowParts(r: Record<string, unknown>, out: FlowLayout): FlowLayout {
  if (typeof r.nodes === "object" && r.nodes !== null) {
    for (const [k, v] of Object.entries(r.nodes)) if (isPoint(v)) out.nodes[k] = { x: v.x, y: v.y };
  }
  const vp = r.viewport as { x?: unknown; y?: unknown; zoom?: unknown } | undefined;
  const zoom = vp?.zoom;
  if (isPoint(vp) && typeof zoom === "number" && Number.isFinite(zoom)) out.viewport = { x: vp.x, y: vp.y, zoom };
  if (r.style === "modern" || r.style === "classic") out.style = r.style;
  if (r.direction === "TB" || r.direction === "LR") out.direction = r.direction;
  if (typeof r.sizes === "object" && r.sizes !== null) {
    const sizes = Object.create(null) as Record<string, { w: number; h: number }>;
    for (const [k, v] of Object.entries(r.sizes as Record<string, unknown>)) {
      const b = v as { w?: unknown; h?: unknown };
      if (typeof b?.w === "number" && typeof b.h === "number" && b.w > 0 && b.h > 0 && Number.isFinite(b.w) && Number.isFinite(b.h)) sizes[k] = { w: b.w, h: b.h };
    }
    if (Object.keys(sizes).length) out.sizes = sizes;
  }
  if (typeof r.axes === "object" && r.axes !== null) {
    const axes = Object.create(null) as Record<string, "v" | "h">;
    for (const [k, v] of Object.entries(r.axes as Record<string, unknown>)) if ((v === "v" || v === "h") && axisEnds(k)) axes[k] = v;
    if (Object.keys(axes).length) out.axes = axes;
  }
  return out;
}

/** Stable key order, sorted positions and 2-space JSON with a final line break, so the file diffs well in git. */
export function serializeFlowLayout(l: FlowLayout): string {
  const out: Record<string, unknown> = { version: 1, nodes: sortedNodes(l.nodes) };
  if (l.viewport) out.viewport = l.viewport;
  out.style = l.style;
  out.direction = l.direction;
  const sizes = sortedSizes(l.sizes);
  if (sizes) out.sizes = sizes;
  const axes = sortedAxes(l.axes);
  if (axes) out.axes = axes;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Positions in key order, as the writer lays them out. */
export function sortedNodes(nodes: Positions): Positions {
  const out = emptyPositions();
  for (const k of Object.keys(nodes).sort()) out[k] = { x: nodes[k].x, y: nodes[k].y };
  return out;
}

/** Sizes rounded and in key order; undefined when there are none. */
export function sortedSizes(sizes: FlowLayout["sizes"]): Record<string, { w: number; h: number }> | undefined {
  if (!sizes || !Object.keys(sizes).length) return undefined;
  const out: Record<string, { w: number; h: number }> = {};
  for (const k of Object.keys(sizes).sort()) out[k] = { w: Math.round(sizes[k].w), h: Math.round(sizes[k].h) };
  return out;
}

/** Axes in key order; undefined when there are none. */
export function sortedAxes(axes: FlowLayout["axes"]): Record<string, "v" | "h"> | undefined {
  if (!axes || !Object.keys(axes).length) return undefined;
  const out: Record<string, "v" | "h"> = {};
  for (const k of Object.keys(axes).sort()) out[k] = axes[k];
  return out;
}

/**
 * `nodes` without the positions of `proposed` names the text does not define (`names`): shapes the assistant's review
 * drew that did not land. The same object when there is nothing to drop.
 */
export function withoutProposed(nodes: Positions, proposed: ReadonlySet<string>, names: ReadonlySet<string> | ReadonlyMap<string, unknown>): Positions {
  const gone = [...proposed].filter((n) => !names.has(n) && Object.prototype.hasOwnProperty.call(nodes, n));
  if (gone.length === 0) return nodes;
  const out = emptyPositions();
  for (const [n, at] of Object.entries(nodes)) if (!gone.includes(n)) out[n] = at;
  return out;
}
