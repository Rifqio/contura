// Diagram step 9 (board DiagramGroups, F9): a group dragged by its title moves with everything in it (draw.io
// containers, Miro and Figma frames). Everything the drag needs is read once when it starts: the shapes and inner group
// areas that move, as flat arrays, and the other groups it could be dropped into. Each pointer frame then writes into
// one of two position records kept for the whole drag, so the pointer moving leaves nothing behind (memory is a
// requirement): the canvas sees a new record each frame, and no frame builds one.
import type { Node } from "@xyflow/react";
import type { LivePositions } from "../diagram/livePositions";
import type { FlowGroup } from "../lang/flow/model";

const AREA = "\u0000group:";

export interface GroupDrag {
  /** The group dragged. */
  readonly name: string;
  /** What moves: its shapes, then its own area and the areas inside it. */
  readonly ids: readonly string[];
  /** How many of `ids` are shapes (the rest are areas). */
  readonly shapes: number;
  /** Where each of `ids` started, x then y. */
  readonly start: Float64Array;
  /** The dragged group's box when the drag began: its centre decides where it is dropped. */
  readonly box: { x: number; y: number; w: number; h: number };
  /** The groups it may be dropped into (not itself, not one inside it), their boxes as they were, and their depth. */
  readonly targets: readonly string[];
  readonly targetBox: Float64Array;
  readonly targetDepth: Int32Array;
  /** The group it is in now, or null. */
  readonly parent: string | null;
  /** The two records the frames alternate between. */
  readonly bufs: readonly [LivePositions, LivePositions];
  flip: number;
}

/** The group `name` in `groups` (any depth), with the name of the group around it. */
function findGroup(groups: readonly FlowGroup[], name: string): { g: FlowGroup; parent: string | null } | null {
  const stack: { g: FlowGroup; parent: string | null }[] = groups.map((g) => ({ g, parent: null }));
  while (stack.length) {
    const f = stack.pop()!;
    if (f.g.name === name) return f;
    for (const c of f.g.groups) stack.push({ g: c, parent: f.g.name });
  }
  return null;
}

/** The drag of group `name` over the drawn `nodes` (shapes and areas), or null when it is not drawn. */
export function startGroupDrag(name: string, groups: readonly FlowGroup[], nodes: readonly Node[]): GroupDrag | null {
  const found = findGroup(groups, name);
  if (!found) return null;
  const shapes = new Set<string>();
  const inner = new Set<string>();
  const stack = [found.g];
  while (stack.length) {
    const g = stack.pop()!;
    inner.add(g.name);
    for (const n of g.nodes) shapes.add(n);
    stack.push(...g.groups);
  }
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const own = byId.get(`${AREA}${name}`);
  if (!own) return null;
  const ids: string[] = [];
  for (const s of shapes) if (byId.has(s)) ids.push(s);
  const count = ids.length;
  for (const g of inner) if (byId.has(`${AREA}${g}`)) ids.push(`${AREA}${g}`);
  const start = new Float64Array(ids.length * 2);
  const a: LivePositions = Object.create(null);
  const b: LivePositions = Object.create(null);
  ids.forEach((id, i) => {
    const n = byId.get(id)!;
    start[i * 2] = n.position.x;
    start[i * 2 + 1] = n.position.y;
    // Each entry is made once; a frame only writes its numbers. An area keeps its size as it moves.
    const sized = i >= count ? { w: n.initialWidth ?? 0, h: n.initialHeight ?? 0 } : {};
    a[id] = { x: n.position.x, y: n.position.y, ...sized };
    b[id] = { x: n.position.x, y: n.position.y, ...sized };
  });
  const targets: string[] = [];
  const boxes: number[] = [];
  const depths: number[] = [];
  const depthOf = (g: string) => {
    let d = 0;
    for (let p = findGroup(groups, g)?.parent ?? null; p; p = findGroup(groups, p)?.parent ?? null) d++;
    return d;
  };
  for (const n of nodes) {
    if (!n.id.startsWith(AREA)) continue;
    const g = n.id.slice(AREA.length);
    if (inner.has(g)) continue;
    targets.push(g);
    boxes.push(n.position.x, n.position.y, n.initialWidth ?? 0, n.initialHeight ?? 0);
    depths.push(depthOf(g));
  }
  return {
    name,
    ids,
    shapes: count,
    start,
    box: { x: own.position.x, y: own.position.y, w: own.initialWidth ?? 0, h: own.initialHeight ?? 0 },
    targets,
    targetBox: Float64Array.from(boxes),
    targetDepth: Int32Array.from(depths),
    parent: found.parent,
    bufs: [a, b],
    flip: 0,
  };
}

/** Where everything is drawn with the group moved by (dx, dy): the other record from last frame's, written in place. */
export function groupDragFrame(d: GroupDrag, dx: number, dy: number): LivePositions {
  d.flip ^= 1;
  const live = d.bufs[d.flip];
  const ids = d.ids;
  const s = d.start;
  for (let i = 0; i < ids.length; i++) {
    const p = live[ids[i]];
    p.x = Math.round(s[i * 2] + dx);
    p.y = Math.round(s[i * 2 + 1] + dy);
  }
  return live;
}

/** The deepest group (its index in `targets`) whose start box holds the dragged group's centre, or -1. */
export function groupDropAt(d: GroupDrag, dx: number, dy: number): number {
  const cx = d.box.x + d.box.w / 2 + dx;
  const cy = d.box.y + d.box.h / 2 + dy;
  const b = d.targetBox;
  let best = -1;
  for (let i = 0; i < d.targets.length; i++) {
    const x = b[i * 4];
    const y = b[i * 4 + 1];
    if (cx > x && cx < x + b[i * 4 + 2] && cy > y && cy < y + b[i * 4 + 3] && (best < 0 || d.targetDepth[i] > d.targetDepth[best])) best = i;
  }
  return best;
}

/** The shapes' places once the group is let go (dx, dy), as whole pixels. */
export function groupDragEnd(d: GroupDrag, dx: number, dy: number): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = Object.create(null);
  for (let i = 0; i < d.shapes; i++) out[d.ids[i]] = { x: Math.round(d.start[i * 2] + dx), y: Math.round(d.start[i * 2 + 1] + dy) };
  return out;
}
