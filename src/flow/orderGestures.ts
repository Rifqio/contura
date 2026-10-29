// Diagram steps 7 and 8 (boards DiagramMindMap and DiagramSequence): what the mind map and sequence gestures read
// from the drawing, kept out of FlowTab (fix round 1, M14): the map's tree, the sequence's lifelines, rows, frames
// and slot heights, and a frame's name by its kind.
import type { Edge, Node } from "@xyflow/react";
import type { FlowDoc } from "../lang/flow/model";
import type { Box } from "./interactions/geometry";
import { FRAME_TAB, SEQ_HEAD, SEQ_ROW } from "./kindLayout";
import { slotHeights } from "./orderDrag";
import { FRAME_LEFT, ROW_LINE, TAB_STEP, TAB_W } from "./seqGeometry";

const boxOfNode = (n: Node): Box => ({ x: n.position.x, y: n.position.y, w: n.initialWidth ?? 0, h: n.initialHeight ?? 0 });

/** The map's tree as drawn: each topic's parent and its subtopics in text order. */
export function mindTreeOf(d: FlowDoc | null): { parent: Map<string, string>; kids: Map<string, string[]>; root: string | null } {
  const parent = new Map<string, string>();
  const kids = new Map<string, string[]>();
  for (const l of d?.links ?? []) {
    if (!l.tree) continue;
    parent.set(l.to, l.from);
    const list = kids.get(l.from);
    if (list) list.push(l.to);
    else kids.set(l.from, [l.to]);
  }
  return { parent, kids, root: d?.nodes.find((n) => n.kind === "root")?.name ?? null };
}

/** A topic's subtopics, all the way down. */
export function subtreeOf(name: string, kids: Map<string, string[]>): string[] {
  const out: string[] = [];
  const walk = (n: string) => {
    for (const k of kids.get(n) ?? []) {
      out.push(k);
      walk(k);
    }
  };
  walk(name);
  return out;
}

/** The sequence as drawn: participants left to right, each message's row, the frames, and the height of each slot. */
export function seqGeometryOf(d: FlowDoc | null, g: { nodes: Node[]; edges: Edge[] }) {
  const byId = new Map(g.nodes.map((n) => [n.id, n] as const));
  const parts: { name: string; cx: number; box: Box }[] = [];
  for (const n of d?.nodes ?? []) {
    const node = (n.kind === "participant" || n.kind === "actor") && byId.get(n.name);
    if (node) parts.push({ name: n.name, cx: node.position.x + (node.initialWidth ?? 0) / 2, box: boxOfNode(node) });
  }
  parts.sort((a, b) => a.cx - b.cx);
  const top = parts.length ? parts[0].box.y : 0;
  const edges = new Map(g.edges.map((e) => [e.id, e] as const));
  const rows: number[] = [];
  for (let i = 0; i < (d?.links.length ?? 0); i++) rows.push(top + ((edges.get(`edge:${i}`)?.data as { y?: number } | undefined)?.y ?? SEQ_HEAD + (i + 0.5) * SEQ_ROW));
  const frames = (d?.frames ?? []).map((f, index) => {
    const box = byId.get(`\u0000frame:${index}`);
    const tab = byId.get(`\u0000frameTab:${index}`);
    const at = box ? boxOfNode(box) : null;
    // Plan E Decision 13: the side tab down the block's left edge; `tab` is the caption (or the side tab's top).
    const side = at ? { x: at.x, y: at.y, w: TAB_W, h: at.h } : null;
    return { index, label: f.label, kind: f.kind, from: f.from, to: f.to, box: at, tab: tab ? boxOfNode(tab) : null, side };
  });
  const slots = slotHeights(
    rows,
    frames.flatMap((f) => (f.box && f.to >= f.from ? [{ from: f.from, to: f.to, top: f.box.y, bottom: f.box.y + f.box.h }] : [])),
  );
  const last = parts[parts.length - 1];
  return { parts, rows, frames, slots, left: parts.length ? parts[0].box.x : 0, right: last ? last.box.x + last.box.w : 0, top, bottom: last ? last.box.y + last.box.h : 0 };
}

/**
 * Where a new loop around messages `from` to `to` will have its caption once written (Plan E Task 6), so its label
 * field opens there: `addLoop` wraps the blocks that open on its first message and end inside it, and goes inside
 * those that hold the whole range. The layout's own rules (Decisions 13, 14): the box's left edge `FRAME_LEFT` and a
 * `TAB_STEP` per level of blocks inside it left of the leftmost lifeline, the caption `TAB_W + 4` in; the row's band
 * gains one tab, after the tabs of the blocks around it.
 */
export function newLoopCaption(d: FlowDoc, geo: ReturnType<typeof seqGeometryOf>, from: number, to: number): { x: number; y: number } | null {
  const row = geo.rows[from];
  if (row === undefined) return null;
  const cx = new Map(geo.parts.map((p) => [p.name, p.cx] as const));
  let lo = Infinity;
  for (let i = from; i <= to; i++) {
    const l = d.links[i];
    if (!l) continue;
    lo = Math.min(lo, cx.get(l.from) ?? Infinity, cx.get(l.to) ?? Infinity);
  }
  if (lo === Infinity) return null;
  const frames = d.frames ?? [];
  const full = (f: { from: number; to: number }) => f.to >= f.from;
  const atRow = frames.filter((f) => f.from === from).length;
  const around = frames.filter((f) => full(f) && f.from === from && f.to >= to).length;
  const inside = frames.filter((f) => !(f.from === from && f.to === to) && f.from >= from && (full(f) ? f.to <= to : f.from <= to));
  const levels = inside.length ? Math.max(...inside.map((f) => f.depth)) - Math.min(...inside.map((f) => f.depth)) + 1 : 0;
  const top = row - ROW_LINE - atRow * FRAME_TAB + around * FRAME_TAB + 2;
  return { x: lo - FRAME_LEFT - TAB_STEP * levels + TAB_W + 4, y: top };
}

/** Whether a press at height `y` is on a participant's head box or its foot box, not on its lifeline between them. */
export function onParticipantBox(box: Box, y: number): boolean {
  return y <= box.y + SEQ_HEAD || y >= box.y + box.h - SEQ_HEAD;
}

/** A frame by its kind word: a loop is "loop", the others "opt frame", "alt frame" (fix round 1, M9). */
export const frameWord = (label: string) => {
  const k = label.split(" ")[0];
  return k === "loop" ? "loop" : `${k} frame`;
};

