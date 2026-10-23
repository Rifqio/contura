// The drawn diagram's nodes and lines on the engine's canvas: the Task 5 node components wrapped as React Flow
// node types (memo, with a Handle at each round port), group areas, square-routed lines with label chips, and
// the one function that turns a FlowDoc and its positions into canvas nodes and edges. FlowTab and the Mermaid
// dialog's preview both draw through it.
import { BaseEdge, type Edge, type EdgeProps, type EdgeTypes, EdgeLabelRenderer, Handle, type InternalNode, type Node, type NodeProps, type NodeTypes, Position, useInternalNode, useReactFlow, useStoreApi } from "@xyflow/react";
import { createContext, memo, useContext } from "react";
import { ARROW_MARKER, DIAMOND_MARKER, MANY_MARKER, ONE_MARKER, OPEN_ARROW_MARKER, TRIANGLE_MARKER } from "../diagram/edges";
import type { Positions } from "../diagram/layout";
import { type Rect, routeOrthogonal } from "../diagram/route";
import type { DrawnKind } from "../diagram/types";
import { type DiagramKind, type FlowArrow, type FlowDoc, type FlowGroup, type FlowNode, type FlowNodeKind, STATE_END, STATE_START } from "../lang/flow/model";
import { fixedLayout, kindSize, SEQ_HEAD, SEQ_ROW } from "./kindLayout";
import { KindNode, type KindNodeData, MindEdge, SeqEdge, SeqFrame, SeqFrameTab, TimeAxis, TimeSection } from "./kindNodes";
import DfdNode, { type DfdNodeKind } from "./nodes/DfdNode";
import FlowchartNode, { type FlowchartNodeKind } from "./nodes/FlowchartNode";
import { useDetail } from "../diagram/detail";
import { liveResizes, ResizeZones } from "../diagram/resize";
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
  /** Item 21: the size it was resized to on the canvas, instead of its kind's size. */
  sized?: { w: number; h: number };
  /** The size its kind and words lay it out at, before any resize (plain numbers, so equal data stays equal). */
  naturalW?: number;
  naturalH?: number;
};

/** Item 21: what a resize tells the tab (the diagram tab provides it; previews leave it out, so nothing resizes). */
export const FlowResizeContext = createContext<((name: string, box: { x: number; y: number; w: number; h: number }) => void) | null>(null);

/** Board B2 (item 51): a node is resized between these, in canvas px. */
export const NODE_LIMITS = { minW: 96, maxW: 320, minH: 44, maxH: 200 };

/**
 * The limits for a drag that starts at `from`: a node's own size widens them both ways, so a node bigger than the
 * caps or smaller than the minimum (a start pill, a choice diamond, one sized under the old 56 x 24) never jumps
 * on the first pixel. Its laid-out size (`natural`) widens them too, so a resized node can always go back to it.
 */
export function nodeLimitsFor(kind: DrawnKind, from: { w: number; h: number }, natural?: { w: number; h: number }): typeof NODE_LIMITS {
  const lim = nodeLimits(kind);
  const sizes = natural ? [from, natural] : [from];
  return {
    minW: Math.min(lim.minW, ...sizes.map((s) => s.w)),
    maxW: Math.max(lim.maxW, ...sizes.map((s) => s.w)),
    minH: Math.min(lim.minH, ...sizes.map((s) => s.h)),
    maxH: Math.max(lim.maxH, ...sizes.map((s) => s.h)),
  };
}

/** The limits for a kind: a start or end dot and a fork bar may stay smaller than other nodes. */
export function nodeLimits(kind: DrawnKind): typeof NODE_LIMITS {
  if (kind === "stateStart" || kind === "stateEnd") return { ...NODE_LIMITS, minW: 16, minH: 16 };
  if (kind === "fork") return { ...NODE_LIMITS, minH: 6 };
  return NODE_LIMITS;
}

/**
 * Board B2 (item 51): a selected node resizes from pointer zones on its edges and corners, live. Once a frame the
 * node takes the new box in React Flow, so its text reflows and its lines follow; the size goes into the layout
 * file when the drag ends.
 */
function Resizer({ id, selected, kind, naturalW, naturalH }: { id: string; selected: boolean; kind: DrawnKind; naturalW?: number; naturalH?: number }) {
  const natural = naturalW !== undefined && naturalH !== undefined ? { w: naturalW, h: naturalH } : undefined;
  const resize = useContext(FlowResizeContext);
  const flow = useReactFlow();
  const canvas = useStoreApi();
  if (!resize || !selected) return null;
  const square = kind === "decision" || kind === "choice" || kind === "stateStart" || kind === "stateEnd";
  return (
    <ResizeZones
      square={square}
      // A node laid out bigger than the caps (an ER table, a class with many rows) keeps its own size as its limit.
      limits={(from) => nodeLimitsFor(kind, from, natural)}
      start={() => {
        const n = flow.getInternalNode(id);
        if (!n) return null;
        return { x: n.position.x, y: n.position.y, w: n.measured.width ?? n.width ?? n.initialWidth ?? 0, h: n.measured.height ?? n.height ?? n.initialHeight ?? 0 };
      }}
      onLive={(box, node) => {
        node?.classList.add("is-resizing");
        liveResizes(canvas.getState().domNode).set(id, box);
        flow.updateNode(id, { position: { x: box.x, y: box.y }, width: box.w, height: box.h });
      }}
      onDone={(box, start, node) => {
        liveResizes(canvas.getState().domNode).delete(id);
        const same = box.x === start.x && box.y === start.y && box.w === start.w && box.h === start.h;
        if (same) {
          node?.classList.remove("is-resizing");
          flow.updateNode(id, { position: { x: start.x, y: start.y }, width: undefined, height: undefined });
          return;
        }
        // The node keeps the live box until the layout draws it again at its kept size.
        requestAnimationFrame(() => node?.classList.remove("is-resizing"));
        // The live box follows the pointer to the sub-pixel; the kept size is whole pixels.
        resize(id, { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) });
      }}
      onCancel={(start, node) => {
        liveResizes(canvas.getState().domNode).delete(id);
        node?.classList.remove("is-resizing");
        flow.updateNode(id, { position: { x: start.x, y: start.y }, width: undefined, height: undefined });
      }}
    />
  );
}

export type FlowAreaData = {
  name: string;
  /** 0 for a group in no group; an inner group's edge is solid (frame 6+.5). */
  depth: number;
  /** The group's `icon:` name, drawn small before its label. */
  iconName?: string;
};

export type FlowEdgeData = {
  label?: string;
  /** An ER relationship's name sits in a diamond on its line (frame DiagramElements). */
  diamond?: boolean;
  /** Fading out with a deleted node. */
  leaving?: boolean;
};

/** The family a kind's node type draws with; `kind` is the step 12 shapes. */
export type FlowFamily = "dfd" | "flowchart" | "service" | "kind";

/**
 * The text's kind word as the engine's node kind: a data flow's entity is the engine's outside party, an ER
 * file's entity is a table card, and a state diagram's start and end are its two markers.
 */
export function drawnKind(kind: FlowNodeKind, diagram?: DiagramKind | null, name?: string): DrawnKind {
  if (diagram === "er" && (kind === "entity" || kind === "weak")) return kind === "weak" ? "erWeak" : "erTable";
  if (diagram === "state" && name === STATE_START) return "stateStart";
  if (diagram === "state" && name === STATE_END) return "stateEnd";
  if (kind === "entity") return "external";
  if (kind === "weak") return "erWeak";
  return kind;
}

const KIND_FAMILY: ReadonlySet<DrawnKind> = new Set([
  "document",
  "database",
  "erTable",
  "erWeak",
  "participant",
  "actor",
  "state",
  "choice",
  "fork",
  "stateStart",
  "stateEnd",
  "class",
  "interface",
  "enum",
  "root",
  "topic",
  "event",
  "period",
  "milestone",
  "note",
]);

export function familyOf(kind: DrawnKind): FlowFamily {
  if (kind === "process" || kind === "store" || kind === "external") return "dfd";
  if (kind === "service") return "service";
  if (KIND_FAMILY.has(kind)) return "kind";
  return "flowchart";
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
/** About 7 px per character of the body font: enough to size a node before it is measured. */
const textW = (s: string) => s.length * 7;

/** The size a node is laid out and fitted at, by kind and look (flow-canvas.css draws them). */
export function nodeSize(kind: DrawnKind, look: NodeLook, name: string, id?: string, node?: Partial<FlowNode>): { w: number; h: number } {
  const shaped = kindSize(kind, { name, rows: node?.rows, text: node?.text, depth: node?.depth });
  if (shaped) return shaped;
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

const DfdFlowNode = memo(function DfdFlowNode({ id, data, selected }: NodeProps) {
  const d = data as FlowNodeData;
  return (
    <>
      <Resizer id={id} selected={!!selected} kind={d.kind} naturalW={d.naturalW} naturalH={d.naturalH} />
      <DfdNode kind={d.kind as DfdNodeKind} name={d.name} id={d.id} table={d.table} style={d.look} selected={!!selected} state={d.state} sized={d.sized} />
      <Handles />
    </>
  );
});

const FlowchartFlowNode = memo(function FlowchartFlowNode({ id, data, selected }: NodeProps) {
  const d = data as FlowNodeData;
  return (
    <>
      <Resizer id={id} selected={!!selected} kind={d.kind} naturalW={d.naturalW} naturalH={d.naturalH} />
      <FlowchartNode kind={d.kind as FlowchartNodeKind} name={d.name} id={d.id} table={d.table} style={d.look} selected={!!selected} state={d.state} sized={d.sized} />
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
          <div
            className={["flow-chip nodrag nopan", data?.diamond && "flow-chip-diamond", data?.leaving && "is-leaving"].filter(Boolean).join(" ")}
            style={{ transform: `translate(-50%, -50%) translate(${route.mid.x}px, ${route.mid.y}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

/** A step 12 shape, with the four ports a line is drawn from. */
const KindFlowNode = memo(function KindFlowNode({ id, data, selected, draggable }: NodeProps) {
  const d = data as KindNodeData;
  return (
    <>
      {/* A sequence, mind map or timeline is laid out from its text: its shapes are not resized by hand. */}
      {draggable !== false && <Resizer id={id} selected={!!selected} kind={d.kind} naturalW={d.naturalW} naturalH={d.naturalH} />}
      <KindNode d={d} selected={!!selected} />
      <Handles />
    </>
  );
});

export const FLOW_NODE_TYPES = {
  dfd: DfdFlowNode,
  flowchart: FlowchartFlowNode,
  service: ServiceFlowNode,
  kind: KindFlowNode,
  area: FlowArea,
  seqFrame: SeqFrame,
  seqFrameTab: SeqFrameTab,
  timeAxis: TimeAxis,
  timeSection: TimeSection,
} satisfies NodeTypes;

export const FLOW_EDGE_TYPES = { flow: FlowEdge, seq: SeqEdge, mind: MindEdge } satisfies EdgeTypes;

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

/** The marker at each end of a line, by its arrow (step 12 adds the ER ends and the class marks). */
function markers(arrow: FlowArrow, diagram: DiagramKind): { start?: string; end?: string } {
  switch (arrow) {
    case "-":
    case "..>":
      return diagram === "class" && arrow === "..>" ? { end: OPEN_ARROW_MARKER } : {};
    case "<>":
      return { start: ARROW_MARKER, end: ARROW_MARKER };
    case "--":
      return {};
    case "1--*":
      return { start: ONE_MARKER, end: MANY_MARKER };
    case "*--1":
      return { start: MANY_MARKER, end: ONE_MARKER };
    case "1--1":
      return { start: ONE_MARKER, end: ONE_MARKER };
    case "*--*":
      return { start: MANY_MARKER, end: MANY_MARKER };
    case "<|--":
      return { start: TRIANGLE_MARKER };
    case "*--":
      return { start: DIAMOND_MARKER };
    case "-->":
      return diagram === "sequence" ? { end: OPEN_ARROW_MARKER } : { end: ARROW_MARKER };
    default:
      return { end: ARROW_MARKER };
  }
}

/** A node's canvas data: its words, rows and dates, whatever its family draws. */
function nodeData(n: FlowNode, kind: DrawnKind, look: NodeLook): FlowNodeData & KindNodeData {
  const data: FlowNodeData & KindNodeData = { name: n.name, kind, look };
  if (n.attrs.id !== undefined) data.id = n.attrs.id;
  if (n.attrs.table !== undefined) data.table = n.attrs.table;
  if (kind === "service" && n.attrs.icon) data.iconName = n.attrs.icon;
  if (n.rows) data.rows = n.rows;
  if (n.text !== undefined) data.text = n.text;
  if (n.depth !== undefined) data.depth = n.depth;
  if (n.date !== undefined) data.date = n.date;
  if (n.until !== undefined) data.until = n.until;
  return data;
}

/** A sequence, mind map or timeline: laid out from the text every time, with its frames, lifelines and axis. */
function fixedGraph(doc: FlowDoc, look: NodeLook, opts: GraphOptions): { nodes: Node[]; edges: Edge[] } | null {
  const size = (n: FlowNode) => nodeSize(drawnKind(n.kind, doc.kind, n.name), look, n.name, n.attrs.id, n);
  const lay = fixedLayout(doc, size);
  if (!lay) return null;
  const acts = new Map<string, { top: number; height: number }[]>();
  // An activation bar runs from the top of its first message row to the bottom of its last, as the layout spaced them.
  const rowY = (i: number) => lay.rows?.[i] ?? SEQ_HEAD + (i + 0.5) * SEQ_ROW;
  for (const a of doc.activations ?? []) {
    const top = rowY(a.from) - SEQ_ROW / 2 + 6;
    const bar = { top, height: Math.max(SEQ_ROW - 12, rowY(Math.max(a.from, a.to)) + SEQ_ROW / 2 - 6 - top) };
    acts.set(a.name, [...(acts.get(a.name) ?? []), bar]);
  }
  const nodes: Node[] = doc.nodes.map((n) => {
    const kind = drawnKind(n.kind, doc.kind, n.name);
    const p = lay.positions[n.name] ?? { x: 0, y: 0 };
    const s = lay.sizes.get(n.name) ?? size(n);
    const data = nodeData(n, kind, look);
    if (acts.has(n.name)) data.activations = acts.get(n.name);
    const state = opts.states?.get(n.name);
    if (state) data.state = state;
    return { id: n.name, type: "kind", position: p, initialWidth: s.w, initialHeight: s.h, style: { width: s.w, height: s.h }, data, draggable: false };
  });
  const behind = (id: string, type: string, box: { x: number; y: number; w: number; h: number }, data: Record<string, unknown>, z: number): Node => ({
    id,
    type,
    position: { x: box.x, y: box.y },
    initialWidth: box.w,
    initialHeight: box.h,
    style: { width: box.w, height: box.h },
    data,
    selectable: false,
    draggable: false,
    focusable: false,
    connectable: false,
    zIndex: z,
  });
  const extras: Node[] = [];
  (lay.frames ?? []).forEach((f, i) => {
    extras.push(behind(`\u0000frame:${i}`, "seqFrame", f.box, { label: f.label, depth: f.depth }, -2 + Math.min(f.depth, 1)));
    // The tab goes over the participants, so a lifeline or an activation bar never runs through its words.
    const tab = { x: f.box.x, y: f.box.y, w: f.label.length * 7 + 18, h: 21 };
    extras.push(behind(`\u0000frameTab:${i}`, "seqFrameTab", tab, { label: f.label }, 1));
  });
  (lay.sections ?? []).forEach((sec, i) => extras.push(behind(`\u0000section:${i}`, "timeSection", sec.box, { name: sec.name }, -3)));
  if (lay.axis) {
    const kinds = new Map(doc.nodes.map((n) => [n.name, n.kind]));
    const ticks = [...(lay.ticks ?? new Map()).entries()].map(([name, t]) => ({ x: t.x - lay.axis!.x, above: t.above, milestone: kinds.get(name) === "milestone" }));
    extras.push(behind("\u0000axis", "timeAxis", { ...lay.axis, y: lay.axis.y - 6, h: 14 }, { ticks }, -1));
  }
  const edges: Edge[] = [];
  doc.links.forEach((l, i) => {
    if (!lay.positions[l.from] || !lay.positions[l.to]) return;
    const leaving = opts.states?.get(l.from) === "leaving" || opts.states?.get(l.to) === "leaving";
    const cls = (leaving ? " is-leaving" : "") + (opts.fresh === i ? " is-new" : "") + markClass(opts, i);
    if (doc.kind === "sequence") {
      const reply = l.arrow === "-->";
      edges.push({
        id: `edge:${i}`,
        source: l.from,
        target: l.to,
        type: "seq",
        className: (reply ? "flow-line flow-line-dashed" : "flow-line") + cls,
        markerEnd: reply ? OPEN_ARROW_MARKER : ARROW_MARKER,
        data: { row: i, y: lay.rows?.[i], label: l.label, reply },
      });
      return;
    }
    if (l.tree) {
      edges.push({ id: `edge:${i}`, source: l.from, target: l.to, type: "mind", className: "flow-line flow-line-branch" + cls, data: {} });
      return;
    }
    const m = markers(l.arrow, doc.kind);
    edges.push({
      id: `edge:${i}`,
      source: l.from,
      target: l.to,
      type: "flow",
      className: "flow-line flow-line-dashed" + cls,
      markerEnd: m.end,
      markerStart: m.start,
      data: l.label ? { label: l.label } : {},
    });
  });
  return { nodes: [...extras, ...nodes], edges };
}

export interface GraphOptions {
  /** Nodes fading in or out; a line to a node fading out fades with it. */
  states?: ReadonlyMap<string, NodeState>;
  /** The index of a flow just drawn, kept in accent while its label box is open. */
  fresh?: number;
  /** Item 21: sizes nodes were resized to. */
  sizes?: Record<string, { w: number; h: number }>;
  /** The diagram assistant's review: links (by index) it would add or remove. */
  marks?: ReadonlyMap<number, "add" | "del">;
}

/** The class a link takes from the assistant's review. */
const markClass = (opts: GraphOptions, i: number) => {
  const m = opts.marks?.get(i);
  return m ? ` is-ai-${m}` : "";
};

/** The canvas nodes and edges of `doc`, at `positions` (a node without one is drawn at 0, 0 until it is placed). */
export function buildFlowGraph(doc: FlowDoc, positions: Positions, look: NodeLook, opts: GraphOptions = {}): { nodes: Node[]; edges: Edge[] } {
  const fixed = fixedGraph(doc, look, opts);
  if (fixed) return fixed;
  const placed = new Map<string, Box>();
  const nodes: Node[] = doc.nodes.map((n: FlowNode) => {
    const kind = drawnKind(n.kind, doc.kind, n.name);
    const own = opts.sizes && Object.prototype.hasOwnProperty.call(opts.sizes, n.name) ? opts.sizes[n.name] : null;
    const s = own ?? nodeSize(kind, look, n.name, n.attrs.id, n);
    // Own keys only: a node named constructor or __proto__ is a plain name.
    const p = Object.prototype.hasOwnProperty.call(positions, n.name) ? positions[n.name] : { x: 0, y: 0 };
    placed.set(n.name, { x: p.x, y: p.y, w: s.w, h: s.h });
    const data = nodeData(n, kind, look);
    const state = opts.states?.get(n.name);
    if (state) data.state = state;
    const family = familyOf(kind);
    if (own) data.sized = { w: own.w, h: own.h };
    const natural = own ? nodeSize(kind, look, n.name, n.attrs.id, n) : s;
    data.naturalW = natural.w;
    data.naturalH = natural.h;
    // A step 12 shape fills the box its rows and words size; one resized by hand draws at its own size instead.
    const style = family === "kind" && !own ? { style: { width: s.w, height: s.h } } : {};
    return { id: n.name, type: family, position: { x: p.x, y: p.y }, initialWidth: s.w, initialHeight: s.h, ...style, data };
  });
  // Links to a group are allowed by the language (Mermaid writes them); the canvas draws lines between nodes only.
  const edges: Edge[] = [];
  doc.links.forEach((l, i) => {
    if (!placed.has(l.from) || !placed.has(l.to)) return;
    const data: FlowEdgeData = {};
    if (l.label) data.label = l.label;
    if (l.arrow === "--" && doc.kind === "er" && l.label) data.diamond = true;
    const leaving = opts.states?.get(l.from) === "leaving" || opts.states?.get(l.to) === "leaving";
    if (leaving) data.leaving = true;
    // A dotted "assumes" line has no head (frame 6+.5): it is a permission, not data going one way.
    const m = markers(l.arrow, doc.kind);
    edges.push({
      id: `edge:${i}`,
      source: l.from,
      target: l.to,
      type: "flow",
      className: (DASH[l.arrow] ?? "flow-line") + (leaving ? " is-leaving" : "") + (opts.fresh === i ? " is-new" : "") + markClass(opts, i),
      markerEnd: m.end,
      markerStart: m.start,
      data,
    });
  });
  return { nodes: [...areaNodes(doc.groups, placed), ...nodes], edges };
}

/** The layout request for dagre: every node's size and the links between nodes. */
export function layoutInput(doc: FlowDoc, look: NodeLook): { nodes: { id: string; w: number; h: number }[]; edges: { from: string; to: string }[] } {
  const names = new Set(doc.nodes.map((n) => n.name));
  return {
    nodes: doc.nodes.map((n) => ({ id: n.name, ...nodeSize(drawnKind(n.kind, doc.kind, n.name), look, n.name, n.attrs.id, n) })),
    edges: doc.links.filter((l) => names.has(l.from) && names.has(l.to)).map((l) => ({ from: l.from, to: l.to })),
  };
}
