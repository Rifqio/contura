// Diagram positions: the layout file helpers and the placement of new nodes with dagre.
// `layoutMissing` runs inside the language worker (ruling D14); callers without a client call it in-process.

export type Positions = Record<string, { x: number; y: number }>;
export type Viewport = { x: number; y: number; zoom: number };
export type LayoutFile = { version: 1; nodes: Positions; viewport?: Viewport };

function isPoint(v: unknown): v is { x: number; y: number } {
  return (
    typeof v === "object" && v !== null && Number.isFinite((v as { x: number }).x) && Number.isFinite((v as { y: number }).y)
  );
}

/** Never throws: anything unreadable becomes an empty layout. `key` names the positions object in the file. */
export function parseLayoutFile(json: string, key = "nodes"): LayoutFile {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const src = raw[key];
    if (raw.version !== 1 || typeof src !== "object" || src === null) return { version: 1, nodes: {} };
    const nodes: Positions = {};
    for (const [k, v] of Object.entries(src)) if (isPoint(v)) nodes[k] = { x: v.x, y: v.y };
    const vp = raw.viewport as Viewport | undefined;
    const viewport = vp && isPoint(vp) && Number.isFinite(vp.zoom) ? { x: vp.x, y: vp.y, zoom: vp.zoom } : undefined;
    return viewport ? { version: 1, nodes, viewport } : { version: 1, nodes };
  } catch {
    return { version: 1, nodes: {} };
  }
}

/** Stable key order and 2-space JSON, so the file diffs well in git. */
export function serializeLayoutFile(l: LayoutFile, key = "nodes"): string {
  const nodes = Object.fromEntries(Object.keys(l.nodes).sort().map((k) => [k, l.nodes[k]]));
  const out = l.viewport ? { version: 1, [key]: nodes, viewport: l.viewport } : { version: 1, [key]: nodes };
  return `${JSON.stringify(out, null, 2)}\n`;
}

export interface LayoutRequest {
  nodes: { id: string; w: number; h: number }[];
  /** Directed: dagre ranks `to` after `from`. */
  edges: { from: string; to: string }[];
  existing: Positions;
  rankdir: "LR" | "TB";
  /** A node placed on the last rank, after every other node. */
  pin?: string;
}

const NODE_SEP = 40;
const RANK_SEP = 80;
/** New nodes go this far below the lowest placed one, so they never land on top of it. */
const BELOW_PLACED = 400;

/** Places only the nodes `existing` lacks, with dagre (loaded on first use); placed nodes keep their positions. */
export async function layoutMissing(req: LayoutRequest): Promise<Positions> {
  const missing = req.nodes.filter((n) => !req.existing[n.id]);
  if (missing.length === 0) return req.existing;
  const { default: dagre } = await import("@dagrejs/dagre");
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: req.rankdir, nodesep: NODE_SEP, ranksep: RANK_SEP });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of req.nodes) g.setNode(n.id, { width: n.w, height: n.h });
  for (const e of req.edges) if (g.hasNode(e.from) && g.hasNode(e.to)) g.setEdge(e.from, e.to);
  dagre.layout(g);

  const out: Positions = { ...req.existing };
  const placed = Object.values(req.existing);
  const offsetY = placed.length ? Math.max(...placed.map((p) => p.y)) + BELOW_PLACED : 0;
  const size = new Map(req.nodes.map((n) => [n.id, n]));
  for (const n of missing) {
    const d = g.node(n.id);
    out[n.id] = { x: Math.round(d.x - n.w / 2), y: Math.round(d.y - n.h / 2 + offsetY) };
  }

  const pin = req.pin;
  if (pin && size.has(pin) && !req.existing[pin]) {
    const axis = req.rankdir === "LR" ? "x" : "y";
    const extent = (id: string) => (axis === "x" ? size.get(id)?.w : size.get(id)?.h) ?? 0;
    const others = Object.keys(out).filter((id) => id !== pin);
    if (others.length) {
      const end = Math.max(...others.map((id) => out[id][axis] + extent(id))) + RANK_SEP;
      if (out[pin][axis] < end) out[pin] = { ...out[pin], [axis]: end };
    }
  }
  return out;
}
