// Diagram positions: the layout file helpers and the placement of new nodes with dagre.
// `layoutMissing` runs inside the language worker (ruling D14); callers without a client call it in-process.

import { type Box, placeNext } from "../flow/addNext";

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
  /**
   * diag-910 fix round 3 (L8): the group each node or group sits in. Each group is laid out as one block (dagre's
   * clusters), so nothing outside it lands on its area. The `\u0000` group ids never collide with node ids.
   */
  parents?: Record<string, string>;
}

const NODE_SEP = 40;
const RANK_SEP = 80;
/** New nodes go this far below the lowest placed one, so they never land on top of it. */
const BELOW_PLACED = 400;

/** Places only the nodes `existing` lacks, with dagre (loaded on first use); placed nodes keep their positions. */
export async function layoutMissing(req: LayoutRequest): Promise<Positions> {
  // Own keys only: a node named constructor or __proto__ is a plain name, never an inherited value.
  const has = (id: string) => Object.prototype.hasOwnProperty.call(req.existing, id);
  const missing = req.nodes.filter((n) => !has(n.id));
  if (missing.length === 0) return req.existing;
  const { default: dagre } = await import("@dagrejs/dagre");
  const compound = !!req.parents && Object.keys(req.parents).length > 0;
  const g = new dagre.graphlib.Graph(compound ? { compound: true } : undefined);
  g.setGraph({ rankdir: req.rankdir, nodesep: NODE_SEP, ranksep: RANK_SEP });
  g.setDefaultEdgeLabel(() => ({}));
  // dagre keys plain objects by id, so a name such as __proto__ would break it: it sees numbered ids only.
  const key = new Map<string, string>();
  req.nodes.forEach((n, i) => key.set(n.id, `n${i}`));
  for (const n of req.nodes) g.setNode(key.get(n.id)!, { width: n.w, height: n.h });
  if (compound) {
    // A cluster per group, each node in its innermost group; groups nest as they do in the text.
    let c = 0;
    const own = (id: string) => Object.prototype.hasOwnProperty.call(req.parents, id);
    const cluster = (id: string): string => {
      let k = key.get(id);
      if (!k) {
        k = `g${c++}`;
        key.set(id, k);
        g.setNode(k, {});
        if (own(id)) g.setParent(k, cluster(req.parents![id]));
      }
      return k;
    };
    for (const n of req.nodes) if (own(n.id)) g.setParent(key.get(n.id)!, cluster(req.parents![n.id]));
  }
  for (const e of req.edges) {
    const a = key.get(e.from);
    const b = key.get(e.to);
    if (a && b) g.setEdge(a, b);
  }
  dagre.layout(g);

  const out = Object.create(null) as Positions;
  for (const k of Object.keys(req.existing)) out[k] = req.existing[k];
  const placed = Object.values(req.existing);
  const size = new Map(req.nodes.map((n) => [n.id, n]));
  const centre = (id: string) => g.node(key.get(id)!);
  // Every box on the canvas so far: a new node is placed clear of all of them.
  const boxOf = (id: string): Box => ({ ...out[id], w: size.get(id)?.w ?? 0, h: size.get(id)?.h ?? 0 });
  const boxes: Box[] = Object.keys(out).map(boxOf);
  const own = (id: string) => Object.prototype.hasOwnProperty.call(out, id);
  // A new node linked to a placed one goes one rank from it, on the side dagre ranks it (owner's report, 1 Nov 2026:
  // a table the assistant added landed hundreds of px away from the table it relates to). Nodes placed this way
  // anchor the next ones, so a new chain grows from the placed node.
  const left = new Set(missing.map((n) => n.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of missing) {
      if (!left.has(n.id)) continue;
      const link = req.edges.find((e) => (e.from === n.id && own(e.to)) || (e.to === n.id && own(e.from)));
      if (!link) continue;
      const anchor = link.from === n.id ? link.to : link.from;
      const lr = req.rankdir === "LR";
      // An anchor known only by its saved place (not in this request) has no rank: the new node follows it.
      const a = key.has(anchor) ? centre(anchor) : null;
      const after = !a || (lr ? centre(n.id).x >= a.x : centre(n.id).y >= a.y);
      const at = placeNext({ src: boxOf(anchor), dir: lr ? (after ? "r" : "l") : after ? "b" : "t", size: n, gap: RANK_SEP, boxes });
      if (!at) continue;
      out[n.id] = { x: at.x, y: at.y };
      boxes.push(boxOf(n.id));
      left.delete(n.id);
      grew = true;
    }
  }
  // The rest keep dagre's arrangement, below the placed nodes.
  const offsetY = placed.length ? Math.max(...placed.map((p) => p.y)) + BELOW_PLACED : 0;
  for (const n of missing) {
    if (!left.has(n.id)) continue;
    const d = centre(n.id);
    out[n.id] = { x: Math.round(d.x - n.w / 2), y: Math.round(d.y - n.h / 2 + offsetY) };
  }

  const pin = req.pin;
  if (pin && size.has(pin) && !has(pin)) {
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
