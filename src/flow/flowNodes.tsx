// The drawn diagram's nodes and lines on the engine's canvas: the Task 5 node components wrapped as React Flow
// node types (memo, with a Handle at each round port), group areas, square-routed lines with label chips, and
// the one function that turns a FlowDoc and its positions into canvas nodes and edges. FlowTab and the Mermaid
// dialog's preview both draw through it.
import { BaseEdge, type Edge, type EdgeProps, type EdgeTypes, EdgeLabelRenderer, Handle, type InternalNode, type Node, type NodeProps, type NodeTypes, Position, useInternalNode } from "@xyflow/react";
import { memo } from "react";
import { ARROW_MARKER } from "../diagram/edges";
import type { Positions } from "../diagram/layout";
import { type Rect, routeOrthogonal } from "../diagram/route";
import type { DrawnKind } from "../diagram/types";
import type { FlowArrow, FlowDoc, FlowGroup, FlowNode, FlowNodeKind } from "../lang/flow/model";
import DfdNode, { type DfdNodeKind } from "./nodes/DfdNode";
import FlowchartNode, { type FlowchartNodeKind } from "./nodes/FlowchartNode";
import { useDetail } from "../diagram/detail";
import { iconPlate, useIcon } from "./icons";
import { linkBox } from "./interactions/geometry";
import type { NodeLook, NodeState } from "./nodes/parts";
import ServiceNode from "./nodes/ServiceNode";

/** What a drawn node carries on the canvas. */
export type FlowNodeData = {
  name: string;
  kind: DrawnKind;
  look: NodeLook;
  /** The `id` attribute (`1.0`, `D1`). */
  id?: string;
  /** `schema.table`, shown with a link icon. */
  table?: string;
  /** A cloud service's `icon:` name; the node loads that one icon when it is drawn in full. */
  iconName?: string;
  /** Fading in after an add, or out before a delete. */
  state?: NodeState;
};

export type FlowAreaData = {
  name: string;
  /** 0 for a group in no group; an inner group's edge is solid (frame 6+.5). */
  depth: number;
  /** The group's `icon:` name, drawn small before its label. */
  iconName?: string;
};

export type FlowEdgeData = {
  label?: string;
  /** Fading out with a deleted node. */
  leaving?: boolean;
};

/** The family a kind's node type draws with. */
export type FlowFamily = "dfd" | "flowchart" | "service";

/** The text's kind word as the engine's node kind: a data flow's entity is the engine's outside party. */
export function drawnKind(kind: FlowNodeKind): DrawnKind {
  return kind === "entity" ? "external" : kind;
}

export function familyOf(kind: DrawnKind): FlowFamily {
  if (kind === "process" || kind === "store" || kind === "external") return "dfd";
  if (kind === "service") return "service";
  return "flowchart";
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
/** About 7 px per character of the body font: enough to size a node before it is measured. */
const textW = (s: string) => s.length * 7;

/** The size a node is laid out and fitted at, by kind and look (flow-canvas.css draws them). */
export function nodeSize(kind: DrawnKind, look: NodeLook, name: string, id?: string): { w: number; h: number } {
  switch (kind) {
    case "process":
    case "store":
    case "external":
      if (look === "classic") {
        if (kind === "process") return { w: 156, h: 62 };
        if (kind === "store") return { w: clamp(40 + textW(name) + 24, 120, 320), h: 40 };
        return { w: clamp(textW(name) + 56, 96, 320), h: 40 };
      }
      return { w: clamp(textW(name) + 70 + (id ? id.length * 7 + 16 : 0), 168, 320), h: 52 };
    case "start":
    case "end":
      return { w: clamp(textW(name) + 36, 72, 280), h: 36 };
    case "decision":
      return { w: 116, h: 116 };
    case "step":
    case "subprocess":
    case "io":
      return { w: 150, h: 44 };
    case "service":
      return { w: 104, h: 72 };
    default:
      return { w: 150, h: 44 };
  }
}

const SIDES = [
  ["r", Position.Right],
  ["l", Position.Left],
  ["t", Position.Top],
  ["b", Position.Bottom],
] as const;

/** A handle at each round port (`.fnode-port`, data-side r, l, t, b): a flow is drawn from any of them to any other. */
const Handles = memo(function Handles() {
  return (
    <>
      {SIDES.map(([side, position]) => (
        <Handle key={side} id={side} type="source" position={position} className="fnode-handle" data-side={side} />
      ))}
    </>
  );
});

const DfdFlowNode = memo(function DfdFlowNode({ data, selected }: NodeProps) {
  const d = data as FlowNodeData;
  return (
    <>
      <DfdNode kind={d.kind as DfdNodeKind} name={d.name} id={d.id} table={d.table} style={d.look} selected={!!selected} state={d.state} />
      <Handles />
    </>
  );
});

const FlowchartFlowNode = memo(function FlowchartFlowNode({ data, selected }: NodeProps) {
  const d = data as FlowNodeData;
  return (
    <>
      <FlowchartNode kind={d.kind as FlowchartNodeKind} name={d.name} id={d.id} table={d.table} style={d.look} selected={!!selected} state={d.state} />
      <Handles />
    </>
  );
});

/**
 * A cloud service. It loads its one icon only while drawn in full, so zoomed out or in fast mode nothing is
 * fetched; an icon the pack does not have, or one that cannot be read, shows the dashed cube tile.
 */
const ServiceFlowNode = memo(function ServiceFlowNode({ data, selected }: NodeProps) {
  const d = data as FlowNodeData;
  const { detail } = useDetail();
  const name = detail === "full" && d.iconName ? d.iconName : null;
  const icon = useIcon(name);
  return (
    <>
      <ServiceNode
        name={d.name}
        id={d.id}
        icon={icon.url ?? undefined}
        unknownIcon={icon.missing || icon.failed}
        plate={d.iconName ? iconPlate(d.iconName) : true}
        style={d.look}
        selected={!!selected}
        state={d.state}
      />
      <Handles />
    </>
  );
});

/**
 * A group's icon before its label: 16 px, as an image only (ruling P7). An icon the pack does not have, or one
 * that could not be read, shows the group-colour square, as the export draws it.
 */
function AreaIcon({ name }: { name: string }) {
  const { detail } = useDetail();
  const { url, missing, failed } = useIcon(detail === "full" ? name : null);
  if (url) return <img className="flow-area-icon" src={url} alt="" draggable={false} />;
  return missing || failed ? <i className="flow-area-swatch" aria-hidden="true" /> : null;
}

/** A group: a tinted area behind its nodes, named at the top left; groups inside groups have a solid edge. */
const FlowArea = memo(function FlowArea({ data }: NodeProps) {
  const d = data as FlowAreaData;
  return (
    <div className={d.depth > 0 ? "flow-area is-inner" : "flow-area"} role="group" aria-label={`Group ${d.name}`}>
      <span className="flow-area-name">
        {d.iconName ? <AreaIcon name={d.iconName} /> : <i className="flow-area-swatch" aria-hidden="true" />}
        {d.name}
      </span>
    </div>
  );
});

/** Where lines meet a drawn node: its box, or a cloud service's 48 px tile. */
function rectOf(n: InternalNode): Rect {
  return linkBox(n.type, {
    x: n.internals.positionAbsolute.x,
    y: n.internals.positionAbsolute.y,
    w: n.measured.width ?? n.width ?? n.initialWidth ?? 0,
    h: n.measured.height ?? n.height ?? n.initialHeight ?? 0,
  });
}

/** A flow line: square-cornered with 8 px corners from the side facing the other node, its label on a chip. */
const FlowEdge = memo(function FlowEdge(p: EdgeProps) {
  const a = useInternalNode(p.source);
  const b = useInternalNode(p.target);
  if (!a || !b) return null;
  const route = routeOrthogonal(rectOf(a), rectOf(b));
  const data = p.data as FlowEdgeData | undefined;
  const label = data?.label;
  return (
    <>
      <BaseEdge id={p.id} path={route.d} markerStart={p.markerStart} markerEnd={p.markerEnd} style={p.style} interactionWidth={p.interactionWidth} />
      {label && (
        <EdgeLabelRenderer>
          <div className={data?.leaving ? "flow-chip nodrag nopan is-leaving" : "flow-chip nodrag nopan"} style={{ transform: `translate(-50%, -50%) translate(${route.mid.x}px, ${route.mid.y}px)` }}>
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const FLOW_NODE_TYPES = {
  dfd: DfdFlowNode,
  flowchart: FlowchartFlowNode,
  service: ServiceFlowNode,
  area: FlowArea,
} satisfies NodeTypes;

export const FLOW_EDGE_TYPES = { flow: FlowEdge } satisfies EdgeTypes;

/** Room around a group's nodes, and above them for its name. */
const AREA_PAD = 24;
const AREA_TOP = 36;

type Box = { x: number; y: number; w: number; h: number };

/** Each group's area around its placed nodes and inner groups, with its depth (0 outermost); an empty group has none. */
export function groupBoxes(groups: FlowGroup[], placed: Map<string, Box>): { name: string; box: Box; depth: number }[] {
  const out: { name: string; box: Box; depth: number }[] = [];
  // A stack, not recursion: groups nest at most 20 deep, but a doc built in code could go further.
  type Frame = { g: FlowGroup; inner: Box[]; at: number; depth: number };
  const finish = (g: FlowGroup, inner: Box[], depth: number): Box | null => {
    const boxes = [...g.nodes.map((n) => placed.get(n)).filter((b): b is Box => !!b), ...inner];
    if (boxes.length === 0) return null;
    const x0 = Math.min(...boxes.map((b) => b.x)) - AREA_PAD;
    const y0 = Math.min(...boxes.map((b) => b.y)) - AREA_TOP;
    const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + AREA_PAD;
    const y1 = Math.max(...boxes.map((b) => b.y + b.h)) + AREA_PAD;
    const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    out.push({ name: g.name, box, depth });
    return box;
  };
  for (const top of groups) {
    const stack: Frame[] = [{ g: top, inner: [], at: 0, depth: 0 }];
    while (stack.length) {
      const f = stack[stack.length - 1];
      if (f.at < f.g.groups.length) {
        stack.push({ g: f.g.groups[f.at++], inner: [], at: 0, depth: f.depth + 1 });
        continue;
      }
      stack.pop();
      const box = finish(f.g, f.inner, f.depth);
      if (box && stack.length) stack[stack.length - 1].inner.push(box);
    }
  }
  return out;
}

/** The group areas, outermost first, so inner areas draw over outer ones. */
function areaNodes(groups: FlowGroup[], placed: Map<string, Box>): Node[] {
  const icons = new Map<string, string>();
  const stack = [...groups];
  while (stack.length) {
    const g = stack.pop()!;
    if (g.icon) icons.set(g.name, g.icon);
    stack.push(...g.groups);
  }
  return groupBoxes(groups, placed)
    .map(({ name, box, depth }) => ({
      // A NUL in the id, so it never equals a node's id (its name).
      id: `\u0000group:${name}`,
      type: "area",
      position: { x: box.x, y: box.y },
      initialWidth: box.w,
      initialHeight: box.h,
      style: { width: box.w, height: box.h },
      data: (icons.has(name) ? { name, depth, iconName: icons.get(name) } : { name, depth }) satisfies FlowAreaData,
      selectable: false,
      draggable: false,
      focusable: false,
      connectable: false,
      zIndex: -1 - (20 - Math.min(depth, 20)),
    }))
    .sort((a, b) => a.zIndex - b.zIndex);
}

const DASH: Partial<Record<FlowArrow, string>> = { "-->": "flow-line flow-line-dashed", "..>": "flow-line flow-line-dotted" };

export interface GraphOptions {
  /** Nodes fading in or out; a line to a node fading out fades with it. */
  states?: ReadonlyMap<string, NodeState>;
  /** The index of a flow just drawn, kept in accent while its label box is open. */
  fresh?: number;
}

/** The canvas nodes and edges of `doc`, at `positions` (a node without one is drawn at 0, 0 until it is placed). */
export function buildFlowGraph(doc: FlowDoc, positions: Positions, look: NodeLook, opts: GraphOptions = {}): { nodes: Node[]; edges: Edge[] } {
  const placed = new Map<string, Box>();
  const nodes: Node[] = doc.nodes.map((n: FlowNode) => {
    const kind = drawnKind(n.kind);
    const s = nodeSize(kind, look, n.name, n.attrs.id);
    // Own keys only: a node named constructor or __proto__ is a plain name.
    const p = Object.prototype.hasOwnProperty.call(positions, n.name) ? positions[n.name] : { x: 0, y: 0 };
    placed.set(n.name, { x: p.x, y: p.y, w: s.w, h: s.h });
    const data: FlowNodeData = { name: n.name, kind, look };
    if (n.attrs.id !== undefined) data.id = n.attrs.id;
    if (n.attrs.table !== undefined) data.table = n.attrs.table;
    if (kind === "service" && n.attrs.icon) data.iconName = n.attrs.icon;
    const state = opts.states?.get(n.name);
    if (state) data.state = state;
    return { id: n.name, type: familyOf(kind), position: { x: p.x, y: p.y }, initialWidth: s.w, initialHeight: s.h, data };
  });
  // Links to a group are allowed by the language (Mermaid writes them); the canvas draws lines between nodes only.
  const edges: Edge[] = [];
  doc.links.forEach((l, i) => {
    if (!placed.has(l.from) || !placed.has(l.to)) return;
    const data: FlowEdgeData = {};
    if (l.label) data.label = l.label;
    const leaving = opts.states?.get(l.from) === "leaving" || opts.states?.get(l.to) === "leaving";
    if (leaving) data.leaving = true;
    edges.push({
      id: `edge:${i}`,
      source: l.from,
      target: l.to,
      type: "flow",
      className: (DASH[l.arrow] ?? "flow-line") + (leaving ? " is-leaving" : "") + (opts.fresh === i ? " is-new" : ""),
      // A dotted "assumes" line has no head (frame 6+.5): it is a permission, not data going one way.
      markerEnd: l.arrow === "-" || l.arrow === "..>" ? undefined : ARROW_MARKER,
      markerStart: l.arrow === "<>" ? ARROW_MARKER : undefined,
      data,
    });
  });
  return { nodes: [...areaNodes(doc.groups, placed), ...nodes], edges };
}

/** The layout request for dagre: every node's size and the links between nodes. */
export function layoutInput(doc: FlowDoc, look: NodeLook): { nodes: { id: string; w: number; h: number }[]; edges: { from: string; to: string }[] } {
  const names = new Set(doc.nodes.map((n) => n.name));
  return {
    nodes: doc.nodes.map((n) => ({ id: n.name, ...nodeSize(drawnKind(n.kind), look, n.name, n.attrs.id) })),
    edges: doc.links.filter((l) => names.has(l.from) && names.has(l.to)).map((l) => ({ from: l.from, to: l.to })),
  };
}
