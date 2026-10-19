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
}

/** A flowchart runs top to bottom (answer 7A); a data flow and a cloud diagram read left to right, as their frames do. */
export function defaultDirection(kind: DiagramKind | null): FlowDirection {
  return kind === "dfd" || kind === "cloud" ? "LR" : "TB";
}

export function emptyPositions(): Positions {
  return Object.create(null) as Positions;
}

const isPoint = (v: unknown): v is { x: number; y: number } =>
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
  if (typeof r.nodes === "object" && r.nodes !== null) {
    for (const [k, v] of Object.entries(r.nodes)) if (isPoint(v)) out.nodes[k] = { x: v.x, y: v.y };
  }
  const vp = r.viewport as { x?: unknown; y?: unknown; zoom?: unknown } | undefined;
  const zoom = vp?.zoom;
  if (isPoint(vp) && typeof zoom === "number" && Number.isFinite(zoom)) out.viewport = { x: vp.x, y: vp.y, zoom };
  if (r.style === "modern" || r.style === "classic") out.style = r.style;
  if (r.direction === "TB" || r.direction === "LR") out.direction = r.direction;
  return out;
}

/** Stable key order, sorted positions and 2-space JSON with a final line break, so the file diffs well in git. */
export function serializeFlowLayout(l: FlowLayout): string {
  const nodes = emptyPositions();
  for (const k of Object.keys(l.nodes).sort()) nodes[k] = { x: l.nodes[k].x, y: l.nodes[k].y };
  const out: Record<string, unknown> = { version: 1, nodes };
  if (l.viewport) out.viewport = l.viewport;
  out.style = l.style;
  out.direction = l.direction;
  return `${JSON.stringify(out, null, 2)}\n`;
}
