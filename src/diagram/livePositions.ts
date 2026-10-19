// Positions drawn part of the way through a glide (Tidy, a settle, an undo): one frame replaces only the nodes
// that move, so a frame on a 2,000-node diagram stays far under 16 ms (ruling P20). Every other node object is
// kept, and React Flow keeps its measured internals for it.
import type { Node } from "@xyflow/react";

/** Where a node is drawn this frame; `w` and `h` resize it (a group area growing with its nodes). */
export type LivePositions = Record<string, { x: number; y: number; w?: number; h?: number }>;

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** `nodes` with the live entries applied; the same array when nothing changes. */
export function applyLive(nodes: Node[], live: LivePositions): Node[] {
  let out: Node[] | null = null;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!own(live, n.id)) continue;
    const p = live[n.id];
    const sized = p.w !== undefined && p.h !== undefined;
    if (n.position.x === p.x && n.position.y === p.y && (!sized || (n.initialWidth === p.w && n.initialHeight === p.h))) continue;
    out ??= nodes.slice();
    out[i] = sized
      ? { ...n, position: { x: p.x, y: p.y }, initialWidth: p.w, initialHeight: p.h, style: { ...n.style, width: p.w, height: p.h } }
      : { ...n, position: { x: p.x, y: p.y } };
  }
  return out ?? nodes;
}

/**
 * True when two versions of a node draw the same box: same type and size, and data equal key by key. Such a node
 * keeps its measured size: React Flow draws every node it has not measured, visible or not.
 */
export function drawsTheSame(a: Node, b: Node): boolean {
  if (a.type !== b.type || a.initialWidth !== b.initialWidth || a.initialHeight !== b.initialHeight) return false;
  if (a.data === b.data) return true;
  const ka = Object.keys(a.data);
  const kb = Object.keys(b.data);
  return ka.length === kb.length && ka.every((k) => Object.is(a.data[k], b.data[k]));
}

/** Puts the nodes named in `keys` back to how `base` (the props) draws them, once a glide ends. */
export function restoreBase(nodes: Node[], base: readonly Node[], keys: ReadonlySet<string>): Node[] {
  if (keys.size === 0) return nodes;
  const byId = new Map<string, Node>();
  for (const b of base) if (keys.has(b.id)) byId.set(b.id, b);
  let out: Node[] | null = null;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const b = byId.get(n.id);
    if (!b) continue;
    out ??= nodes.slice();
    // Keep the measured size of a node that draws the same, or the end of a Tidy draws all 2,000 nodes at once.
    out[i] = { ...b, ...(n.measured && !b.measured && drawsTheSame(n, b) ? { measured: n.measured } : {}), selected: n.selected };
  }
  return out ?? nodes;
}
