// One glide's frames (Tidy, a settle, an undo): the moving nodes part of the way to their new places, and the
// group areas around them, which grow and shrink with them. A frame touches only those entries; the canvas
// applies them over the nodes it already has (ruling P20), so no frame rebuilds the drawing.
import type { Node } from "@xyflow/react";
import type { Positions } from "../../diagram/layout";
import type { LivePositions } from "../../diagram/livePositions";
import type { FlowGroup } from "../../lang/flow/model";
import { groupBoxes } from "../flowNodes";
import type { Box } from "./geometry";

const AREA = "\u0000group:";

/** The frame at eased progress `p` (0 to 1) of a glide from `from` to `to`. */
export function glideFrames(from: Positions, to: Positions, groups: readonly FlowGroup[], nodes: readonly Node[]): (p: number) => LivePositions {
  const keys = Object.keys(to);
  // Group areas move only when a gliding node is in a group.
  let placed: Map<string, Box> | null = null;
  if (groups.length > 0) {
    const grouped = new Set<string>();
    const stack = [...groups];
    while (stack.length) {
      const g = stack.pop()!;
      for (const n of g.nodes) grouped.add(n);
      stack.push(...g.groups);
    }
    if (keys.some((k) => grouped.has(k))) {
      placed = new Map();
      for (const n of nodes) {
        if (n.id.startsWith("\u0000")) continue;
        placed.set(n.id, { x: n.position.x, y: n.position.y, w: n.initialWidth ?? 0, h: n.initialHeight ?? 0 });
      }
    }
  }
  return (p) => {
    const live = Object.create(null) as LivePositions;
    for (const k of keys) {
      const a = Object.prototype.hasOwnProperty.call(from, k) ? from[k] : to[k];
      const b = to[k];
      const at = p >= 1 ? { x: b.x, y: b.y } : { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p };
      live[k] = at;
      const box = placed?.get(k);
      if (box) placed!.set(k, { ...box, x: at.x, y: at.y });
    }
    if (placed) for (const g of groupBoxes(groups as FlowGroup[], placed)) live[`${AREA}${g.name}`] = { x: g.box.x, y: g.box.y, w: g.box.w, h: g.box.h };
    return live;
  };
}
