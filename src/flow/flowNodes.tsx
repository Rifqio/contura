// The drawn diagram's nodes and lines on the engine's canvas: the Task 5 node components wrapped as React Flow
// node types (memo, with a Handle at each round port), group areas, square-routed lines with label chips, and
// the one function that turns a FlowDoc and its positions into canvas nodes and edges. FlowTab and the Mermaid
// dialog's preview both draw through it.
import { BaseEdge, type Edge, type EdgeProps, type EdgeTypes, EdgeLabelRenderer, Handle, type InternalNode, type Node, type NodeProps, type NodeTypes, Position, useInternalNode, useReactFlow, useStoreApi } from "@xyflow/react";
import { createContext, memo, type PointerEvent as ReactPointerEvent, useContext, useEffect, useRef, useState } from "react";
import { ARROW_MARKER, colourArrow, colourEnd, DIAMOND_MARKER, MANY_MARKER, ONE_MARKER, OPEN_ARROW_MARKER, TRIANGLE_MARKER } from "../diagram/edges";
import type { Positions } from "../diagram/layout";
import { EASE_IN, motionMs } from "../diagram/motion";
import { axisKey } from "./layout";
import { type Rect, routeOrthogonal, routeRows } from "../diagram/route";
import type { DrawnKind } from "../diagram/types";
import { type DiagramKind, type FlowArrow, type FlowDoc, type FlowGroup, type FlowNode, type FlowNodeKind, isStateEnd, isStateMarker, isStateStart, shownName } from "../lang/flow/model";
import { colourClass, colourStroke, colourVars, drawnColour } from "./palette";
import { ER_CARD_CHROME, ER_MAX_ROWS, erColumnRow, erRowY, fixedLayout, KIND_ROW, kindSize, SEQ_HEAD, SEQ_ROW } from "./kindLayout";
import { inStaticFrame } from "./kindEdit";
import { isStaticId } from "./board/staticIds";
import { useErScroll } from "./erScroll";
import { KindNode, type KindNodeData, MindEdge, SeqEdge, SeqFrame, SeqFrameTab, TimeAxis, TimeSection } from "./kindNodes";
import DfdNode, { type DfdNodeKind } from "./nodes/DfdNode";
import FlowchartNode, { type FlowchartNodeKind } from "./nodes/FlowchartNode";
import { useDetail } from "../diagram/detail";
import { liveResizes, ResizeZones } from "../diagram/resize";
import { useIcon } from "./icons";
import { linkBox } from "./interactions/geometry";
import type { NodeLook, NodeState, ShapeColour } from "./nodes/parts";
import type { ErNotation } from "./board/boardLayout";
import { labelScale, TEXT_SCALED } from "./textScale";
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
  /** Step 11: the words it shows (its `label:`) when it has one, and its palette colour. */
  shows?: string;
  color?: ShapeColour;
  /** The frame's text size as a label scale (Decision 22); unset at 1. */
  textScale?: number;
};

/** Item 21: what a resize tells the tab (the diagram tab provides it; previews leave it out, so nothing resizes). */
export const FlowResizeContext = createContext<((name: string, box: { x: number; y: number; w: number; h: number }) => void) | null>(null);

/** Fit to content by a double-click on a node's edge (erd-ux-research 5.5, draw.io): the tab lets go of its kept size. */
export const FlowFitContext = createContext<((name: string) => void) | null>(null);

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
  // B3 decision 7 (R8): an ER card grows to 20 rows at most; past them its rows scroll.
  if (kind === "erTable" || kind === "erWeak") return { ...NODE_LIMITS, maxH: ER_CARD_CHROME + ER_MAX_ROWS * KIND_ROW };
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
  const fit = useContext(FlowFitContext);
  const flow = useReactFlow();
  const canvas = useStoreApi();
  if (!resize || !selected) return null;
  const square = kind === "decision" || kind === "choice" || kind === "stateStart" || kind === "stateEnd";
  return (
    <ResizeZones
      square={square}
      // A node laid out bigger than the caps (a class with many rows) keeps its own size as its limit.
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
      onFit={fit ? () => fit(id) : undefined}
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
  /** Step 11: its palette colour: its border and title. */
  color?: ShapeColour;
};

export type FlowEdgeData = {
  label?: string;
  /**
   * ER build C: a relationship between columns meets each card at its column's row (the row's index, -1 for the
   * header when that end is the whole table). Worked out once when the graph is built, never per frame.
   */
  fromRow?: number;
  toRow?: number;
  /** Fading out with a deleted node. */
  leaving?: boolean;
  /** Step 6: the axis a + drew this line on; it keeps that side. */
  axis?: "v" | "h";
  /** The frame's text size as a label scale; unset at 1. */
  textScale?: number;
};

/** The family a kind's node type draws with; `kind` is the step 12 shapes. */
export type FlowFamily = "dfd" | "flowchart" | "service" | "kind";

/**
 * The text's kind word as the engine's node kind: a data flow's entity is the engine's outside party, an ER
 * diagram's entity is a table card, and a state diagram's start and end are its two markers.
 */
export function drawnKind(kind: FlowNodeKind, diagram?: DiagramKind | null, name?: string): DrawnKind {
  if (diagram === "er" && (kind === "entity" || kind === "weak")) return kind === "weak" ? "erWeak" : "erTable";
  if (diagram === "state" && name !== undefined && isStateStart(name)) return "stateStart";
  if (diagram === "state" && name !== undefined && isStateEnd(name)) return "stateEnd";
  if (kind === "entity" || kind === "weak") return "external";
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
export function nodeSize(kind: DrawnKind, look: NodeLook, name: string, id?: string, node?: Partial<FlowNode>, scale = 1): { w: number; h: number } {
  const s = baseSize(kind, look, name, id, node);
  // A frame's text size (Small, Large) scales its labels and the boxes that hold them.
  return scale === 1 ? s : { w: Math.round(s.w * scale), h: Math.round(s.h * scale) };
}

function baseSize(kind: DrawnKind, look: NodeLook, name: string, id?: string, node?: Partial<FlowNode>): { w: number; h: number } {
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
      <DfdNode kind={d.kind as DfdNodeKind} name={d.shows ?? d.name} id={d.id} table={d.table} style={d.look} selected={!!selected} state={d.state} sized={d.sized} color={d.color} />
      <Handles />
    </>
  );
});

const FlowchartFlowNode = memo(function FlowchartFlowNode({ id, data, selected }: NodeProps) {
  const d = data as FlowNodeData;
  return (
    <>
      <Resizer id={id} selected={!!selected} kind={d.kind} naturalW={d.naturalW} naturalH={d.naturalH} />
      <FlowchartNode kind={d.kind as FlowchartNodeKind} name={d.shows ?? d.name} id={d.id} table={d.table} style={d.look} selected={!!selected} state={d.state} sized={d.sized} color={d.color} />
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
        name={d.shows ?? d.name}
        color={d.color}
        id={d.id}
        icon={icon.url ?? undefined}
        unknownIcon={icon.missing || icon.failed}
        iconOutline={icon.outline}
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
  const { url, missing, failed, outline } = useIcon(detail === "full" ? name : null);
  if (url) return <img className={outline ? "flow-area-icon icon-hairline" : "flow-area-icon"} src={url} alt="" draggable={false} />;
  return missing || failed ? <i className="flow-area-swatch" aria-hidden="true" /> : null;
}

/** Step 9 (F9): the group selected by its title, drawn with a ring; null when none is. */
export const FlowGroupSelContext = createContext<string | null>(null);

/**
 * A group: a tinted area behind its nodes, named at the top left; groups inside groups have a solid edge. Its title
 * takes presses (step 9, F9: a click selects the group, a drag moves it, a double-click renames it); the rest of the
 * area stays canvas, as Miro and Figma frames do.
 */
const FlowArea = memo(function FlowArea({ id, data }: NodeProps) {
  const d = data as FlowAreaData;
  // A static frame's group of the same name is not the live frame's selected group.
  const on = useContext(FlowGroupSelContext) === d.name && !inStaticFrame(id);
  return (
    <div
      className={`flow-area${d.depth > 0 ? " is-inner" : ""}${on ? " is-selected" : ""}${d.color ? ` ${colourClass(d.color)}` : ""}`}
      role="group"
      aria-label={`Group ${d.name}`}
      style={d.color ? colourVars(d.color) : undefined}
    >
      {/* Where lines to the group end (fix round 2, L1); the line is routed to the area's edge, so these never show. */}
      <Handle type="source" position={Position.Left} isConnectable={false} className="edge-anchor flow-area-anchor" />
      <Handle type="target" position={Position.Right} isConnectable={false} className="edge-anchor flow-area-anchor" />
      <span className="flow-area-name nodrag nopan">
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

/**
 * F8: a selected line's end dragged and let go at a flow point (draw.io reattaches it to the shape there). The
 * diagram tab provides it; previews leave it out, so their lines show no end handles.
 */
export const LineEndsContext = createContext<((edge: string, end: "from" | "to", at: { x: number; y: number }) => void) | null>(null);

/** A selected line's two end handles, and while one is dragged a dashed line from the other end to the pointer. */
function LineEnds({ id, from, to }: { id: string; from: { x: number; y: number }; to: { x: number; y: number } }) {
  const reattach = useContext(LineEndsContext);
  const flow = useReactFlow();
  const [drag, setDrag] = useState<{ end: "from" | "to"; at: { x: number; y: number } } | null>(null);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  if (!reattach) return null;
  const down = (end: "from" | "to") => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const at = (ev: { clientX: number; clientY: number }) => flow.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
    const move = (ev: PointerEvent) => setDrag({ end, at: at(ev) });
    const finish = (ev: PointerEvent | null) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key, true);
      stop.current = null;
      setDrag(null);
      if (ev) reattach(id, end, at(ev));
    };
    const up = (ev: PointerEvent) => finish(ev);
    // Esc puts the end back where it was (draw.io).
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key, true);
    stop.current = () => finish(null);
    setDrag({ end, at: at(e) });
  };
  const fixed = drag?.end === "from" ? to : from;
  return (
    <>
      {drag && <path className="flow-line-end-preview" d={`M ${fixed.x} ${fixed.y} L ${drag.at.x} ${drag.at.y}`} />}
      {(["from", "to"] as const).map((end) => {
        const q = end === "from" ? from : to;
        return <circle key={end} className="flow-line-end nodrag nopan" data-end={end} cx={q.x} cy={q.y} r={5} onPointerDown={down(end)} />;
      })}
    </>
  );
}

/** A relationship between columns, at each end's row as each card's rows are scrolled (ER build C, fix round 1). */
export function rowRoute(a: Rect, b: Rect, fromRow: number, toRow: number, self: boolean, scrollA = 0, scrollB = 0) {
  return routeRows(a, erRowY(a.y, a.h, fromRow, scrollA), b, erRowY(b.y, b.h, toRow, scrollB), self);
}

/** A flow line: square-cornered with 8 px corners from the side facing the other node, its label on a chip. */
const FlowEdge = memo(function FlowEdge(p: EdgeProps) {
  const a = useInternalNode(p.source);
  const b = useInternalNode(p.target);
  const data = p.data as FlowEdgeData | undefined;
  // A line at its rows follows each card's scrolled rows (fix round 1); a static frame's line (B3 decision 5: static
  // cards do not scroll) and any other line listen to nothing.
  const rowed = data?.fromRow !== undefined && !isStaticId(p.id);
  const sa = useErScroll(rowed ? p.source : null);
  const sb = useErScroll(rowed ? p.target : null);
  if (!a || !b) return null;
  const route =
    data?.fromRow !== undefined
      ? rowRoute(rectOf(a), rectOf(b), data.fromRow, data.toRow ?? -1, p.source === p.target, sa, sb)
      : routeOrthogonal(rectOf(a), rectOf(b), data?.axis ? { axis: data.axis } : {});
  const label = data?.label;
  return (
    <>
      <BaseEdge id={p.id} path={route.d} markerStart={p.markerStart} markerEnd={p.markerEnd} style={p.style} interactionWidth={p.interactionWidth} />
      {p.selected && route.points.length > 1 && <LineEnds id={p.id} from={route.points[0]} to={route.points[route.points.length - 1]} />}
      {label && (
        <EdgeLabelRenderer>
          <div
            className={["flow-chip nodrag nopan", data?.leaving && "is-leaving"].filter(Boolean).join(" ") + labelScale(data?.textScale).cls}
            style={{ transform: `translate(-50%, -50%) translate(${route.mid.x}px, ${route.mid.y}px)`, ...labelScale(data?.textScale).style }}
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

/** Step 7: a new topic's place, dashed, until its name is kept (its field sits on it). */
const MindGhost = memo(function MindGhost() {
  return <div className="flow-ghost-topic" aria-hidden="true" />;
});

export const FLOW_NODE_TYPES = {
  mindGhost: MindGhost,
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

/** An empty group's area (diag-910 fix round 1, I5): the board's size, at the place the layout keeps under its name. */
export const EMPTY_AREA = { w: 240, h: 120 };

/** Where an empty group is drawn: its kept place, else under everything placed, so it is never lost off the canvas. */
export function emptyAreas(positions: Positions, placed: ReadonlyMap<string, Box>): (name: string) => Box | undefined {
  let below: { x: number; y: number } | null = null;
  return (name) => {
    if (Object.prototype.hasOwnProperty.call(positions, name)) return { x: positions[name].x, y: positions[name].y, ...EMPTY_AREA };
    if (!below) {
      let x = Infinity;
      let y = -Infinity;
      for (const b of placed.values()) {
        x = Math.min(x, b.x);
        y = Math.max(y, b.y + b.h);
      }
      below = { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y + 60 : 0 };
    } else below = { x: below.x + EMPTY_AREA.w + 40, y: below.y };
    return { ...below, ...EMPTY_AREA };
  };
}

/**
 * Each group's area around its placed nodes and inner groups, with its depth (0 outermost). An empty group has the
 * box `kept` gives it (I5), or none.
 */
export function groupBoxes(groups: FlowGroup[], placed: Map<string, Box>, kept?: (name: string) => Box | undefined): { name: string; box: Box; depth: number }[] {
  const out: { name: string; box: Box; depth: number }[] = [];
  // A stack, not recursion: groups nest at most 20 deep, but a doc built in code could go further.
  type Frame = { g: FlowGroup; inner: Box[]; at: number; depth: number };
  const finish = (g: FlowGroup, inner: Box[], depth: number): Box | null => {
    const boxes = [...g.nodes.map((n) => placed.get(n)).filter((b): b is Box => !!b), ...inner];
    if (boxes.length === 0) {
      const k = g.nodes.length === 0 && g.groups.length === 0 ? kept?.(g.name) : undefined;
      if (!k) return null;
      out.push({ name: g.name, box: k, depth });
      return k;
    }
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
function areaNodes(groups: FlowGroup[], placed: Map<string, Box>, kept?: (name: string) => Box | undefined): Node[] {
  const icons = new Map<string, string>();
  const colours = new Map<string, ShapeColour>();
  const stack = [...groups];
  while (stack.length) {
    const g = stack.pop()!;
    if (g.icon) icons.set(g.name, g.icon);
    const c = drawnColour(g.color);
    if (c) colours.set(g.name, c);
    stack.push(...g.groups);
  }
  return groupBoxes(groups, placed, kept)
    .map(({ name, box, depth }) => ({
      // A NUL in the id, so it never equals a node's id (its name).
      id: `\u0000group:${name}`,
      type: "area",
      position: { x: box.x, y: box.y },
      initialWidth: box.w,
      initialHeight: box.h,
      style: { width: box.w, height: box.h },
      data: { name, depth, ...(icons.has(name) ? { iconName: icons.get(name) } : {}), ...(colours.has(name) ? { color: colours.get(name) } : {}) } satisfies FlowAreaData,
      selectable: false,
      draggable: false,
      focusable: false,
      connectable: false,
      zIndex: -1 - (20 - Math.min(depth, 20)),
    }))
    .sort((a, b) => a.zIndex - b.zIndex);
}

const DASH: Partial<Record<FlowArrow, string>> = { "-->": "flow-line flow-line-dashed", "..>": "flow-line flow-line-dotted" };

/** The class names of a line's dash: `--` takes the dash of `-->` in every kind but class, where it is solid. */
function dashOf(arrow: FlowArrow, diagram: DiagramKind): string {
  if (arrow === "--" && diagram !== "class") return DASH["-->"]!;
  return DASH[arrow] ?? "flow-line";
}

/** The marker at each end of a line, by its arrow (step 12 adds the class marks); a coloured head or ER end keeps its colour (step 11). */
function markers(arrow: FlowArrow, diagram: DiagramKind, colour?: ShapeColour, notation: ErNotation = "crow"): { start?: string; end?: string } {
  const m = plainMarkers(arrow, diagram, notation);
  if (!colour) return m;
  // A crow's-foot end takes the line's colour too.
  const own = (id?: string) => (id === ARROW_MARKER ? colourArrow(colour) : id === MANY_MARKER || id === ONE_MARKER ? colourEnd(id, colour) : id);
  return { ...(m.start ? { start: own(m.start) } : {}), ...(m.end ? { end: own(m.end) } : {}) };
}

function plainMarkers(arrow: FlowArrow, diagram: DiagramKind, notation: ErNotation): { start?: string; end?: string } {
  // An ER frame drawn in Arrows (Decision 22): a plain line with a head at its second end, whatever its cardinality.
  if (diagram === "er" && notation === "arrow") return { end: ARROW_MARKER };
  // An ER relationship's ends are crow's feet: a bar at a one end, a crow's foot at a many end.
  if (diagram === "er") {
    const ends = ER_ENDS[arrow];
    if (ends) return { start: ends[0], end: ends[1] };
  }
  switch (arrow) {
    case "-":
    case "..>":
      return diagram === "class" && arrow === "..>" ? { end: OPEN_ARROW_MARKER } : {};
    case "<>":
      return { start: ARROW_MARKER, end: ARROW_MARKER };
    case "--":
      return {};
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

/** Each ER line's ends, first end then second: `>` many to one, `<` one to many, `-` one to one, `<>` many to many. */
const ER_ENDS: Partial<Record<FlowArrow, readonly [string, string]>> = {
  ">": [MANY_MARKER, ONE_MARKER],
  "<": [ONE_MARKER, MANY_MARKER],
  "-": [ONE_MARKER, ONE_MARKER],
  "<>": [MANY_MARKER, MANY_MARKER],
};

/** A node's canvas data: its words, rows and dates, whatever its family draws. */
function nodeData(n: FlowNode, kind: DrawnKind, look: NodeLook, textScale = 1): FlowNodeData & KindNodeData {
  const data: FlowNodeData & KindNodeData = { name: n.name, kind, look };
  if (textScale !== 1) data.textScale = textScale;
  if (n.attrs.label !== undefined && n.kind !== "note") data.shows = n.attrs.label;
  const colour = n.kind === "note" ? undefined : drawnColour(n.attrs.color);
  if (colour) data.color = colour;
  if (n.attrs.id !== undefined) data.id = n.attrs.id;
  if (n.attrs.table !== undefined) data.table = n.attrs.table;
  if (kind === "service" && n.attrs.icon) data.iconName = n.attrs.icon;
  if (n.rows) data.rows = n.rows;
  if (n.rowFlags) data.rowFlags = n.rowFlags;
  if (n.text !== undefined) data.text = n.text;
  if (n.depth !== undefined) data.depth = n.depth;
  if (n.date !== undefined) data.date = n.date;
  if (n.until !== undefined) data.until = n.until;
  return data;
}

/** A sequence, mind map or timeline: laid out from the text every time, with its frames, lifelines and axis. */
function fixedGraph(given: FlowDoc, look: NodeLook, opts: GraphOptions): { nodes: Node[]; edges: Edge[] } | null {
  // Step 7: a new topic's ghost takes its place in the map's layout before its name is kept (board DiagramMindMap).
  const ghost = given.kind === "mindmap" ? opts.ghost : undefined;
  const doc = ghost ? withGhost(given, ghost) : given;
  const scale = opts.textScale ?? 1;
  const size = (n: FlowNode) => (n.name === GHOST_ID && ghost ? ghost.size : nodeSize(drawnKind(n.kind, doc.kind, n.name), look, shownName(n), n.attrs.id, n, scale));
  const lay = fixedLayout(doc, size, opts.folded ? { folded: opts.folded } : {});
  if (!lay) return null;
  const acts = new Map<string, { top: number; height: number }[]>();
  // An activation bar runs from the top of its first message row to the bottom of its last, as the layout spaced them.
  const rowY = (i: number) => lay.rows?.[i] ?? SEQ_HEAD + (i + 0.5) * SEQ_ROW;
  for (const a of doc.activations ?? []) {
    const top = rowY(a.from) - SEQ_ROW / 2 + 6;
    const bar = { top, height: Math.max(SEQ_ROW - 12, rowY(Math.max(a.from, a.to)) + SEQ_ROW / 2 - 6 - top) };
    acts.set(a.name, [...(acts.get(a.name) ?? []), bar]);
  }
  const nodes: Node[] = [];
  for (const n of doc.nodes) {
    // A folded topic's subtopics are not placed, so not drawn (M3).
    if (doc.kind === "mindmap" && !lay.positions[n.name]) continue;
    const p = lay.positions[n.name] ?? { x: 0, y: 0 };
    const s = lay.sizes.get(n.name) ?? size(n);
    if (n.name === GHOST_ID) {
      nodes.push({ id: GHOST_ID, type: "mindGhost", position: p, initialWidth: s.w, initialHeight: s.h, style: { width: s.w, height: s.h }, data: {}, selectable: false, draggable: false, focusable: false, connectable: false });
      continue;
    }
    const kind = drawnKind(n.kind, doc.kind, n.name);
    const data = nodeData(n, kind, look, scale);
    if (acts.has(n.name)) data.activations = acts.get(n.name);
    const state = opts.states?.get(n.name);
    if (state) data.state = state;
    nodes.push({ id: n.name, type: "kind", position: p, initialWidth: s.w, initialHeight: s.h, style: { width: s.w, height: s.h, ...scaledStyle(scale) }, data, draggable: false, ...scaledClass(scale) });
  }
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
        data: { row: i, y: lay.rows?.[i], label: l.label, reply, ...(scale !== 1 && l.label ? { textScale: scale } : {}) },
      });
      return;
    }
    if (l.tree) {
      edges.push({ id: l.to === GHOST_ID ? "\u0000ghostBranch" : `edge:${i}`, source: l.from, target: l.to, type: "mind", className: "flow-line flow-line-branch" + cls, data: {}, ...(l.to === GHOST_ID ? { selectable: false } : {}) });
      return;
    }
    const colour = drawnColour(l.color);
    const m = markers(l.arrow, doc.kind, colour);
    edges.push({
      id: `edge:${i}`,
      source: l.from,
      target: l.to,
      type: "flow",
      className: "flow-line flow-line-dashed" + cls + (colour ? ` ${colourClass(colour)}` : ""),
      markerEnd: m.end,
      markerStart: m.start,
      data: l.label ? { label: l.label, ...(scale !== 1 ? { textScale: scale } : {}) } : {},
      ...(colour ? { style: lineStyle(colour) } : {}),
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
  /** Rows a card shows beyond its text's, by node: a member being added grows its class by one. */
  grow?: Readonly<Record<string, number>>;
  /** Step 6: the axes of lines added with a +, by `axisKey`. */
  axes?: Readonly<Record<string, "v" | "h">>;
  /** Step 7: the mind map topics folded (their subtopics are not drawn), and a new topic's ghost: under `parent`,
   *  after its sibling `after` or last, at `size`. */
  folded?: ReadonlySet<string>;
  ghost?: { parent: string; after?: string; size: { w: number; h: number } };
  /** The frame's text size as a label scale (`TEXT_SCALE`): label font size and the node sizes that hold them. */
  textScale?: number;
  /** An ER frame's line ends (Decision 22): crow's feet, or a plain line with a head at its second end; "crow" when absent. */
  notation?: ErNotation;
}

/** The id of a new topic's ghost: a NUL in it, so it never equals a topic's name. */
export const GHOST_ID = "\u0000ghost";

/** The map with the ghost topic put in: after its sibling's branch line, or as the parent's last subtopic. */
function withGhost(doc: FlowDoc, ghost: NonNullable<GraphOptions["ghost"]>): FlowDoc {
  const parent = doc.nodes.find((n) => n.name === ghost.parent);
  if (!parent) return doc;
  const node: FlowNode = { name: GHOST_ID, kind: "topic", attrs: {}, depth: (parent.depth ?? 0) + 1 };
  const link = { from: ghost.parent, to: GHOST_ID, arrow: "-" as const, tree: true };
  const links = [...doc.links];
  // After its sibling's branch, else after the parent's last subtopic: the layout orders subtopics by their branches.
  let at = -1;
  links.forEach((l, i) => {
    if (l.tree && l.from === ghost.parent && (ghost.after === undefined || l.to === ghost.after)) at = i;
  });
  links.splice(at < 0 ? links.length : at + 1, 0, link);
  return { ...doc, nodes: [...doc.nodes, node], links };
}

const scaledStyle = (scale: number): Record<string, number> => (scale !== 1 ? { "--text-scale": scale } : {});
const scaledClass = (scale: number) => (scale !== 1 ? { className: TEXT_SCALED } : {});

/** A coloured line's stroke, inline so the selected state keeps it (step 11). */
const lineStyle = (c: ShapeColour) => ({ stroke: colourStroke(c) });

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
  const scale = opts.textScale ?? 1;
  const nodes: Node[] = doc.nodes.map((n: FlowNode) => {
    const kind = drawnKind(n.kind, doc.kind, n.name);
    const kept = opts.sizes && Object.prototype.hasOwnProperty.call(opts.sizes, n.name) ? opts.sizes[n.name] : null;
    // An ER card is never drawn past 20 rows, whatever its layout says (decision 7: past them its rows scroll).
    const erMaxH = kind === "erTable" || kind === "erWeak" ? nodeLimits(kind).maxH : Infinity;
    const own = kept && kept.h > erMaxH ? { ...kept, h: erMaxH } : kept;
    const extra = opts.grow && Object.prototype.hasOwnProperty.call(opts.grow, n.name) ? opts.grow[n.name] : 0;
    const s = own ?? nodeSize(kind, look, shownName(n), n.attrs.id, extra > 0 ? { ...n, rows: [...(n.rows ?? []), ...Array<string>(extra).fill("")] } : n, scale);
    // Own keys only: a node named constructor or __proto__ is a plain name.
    const p = Object.prototype.hasOwnProperty.call(positions, n.name) ? positions[n.name] : { x: 0, y: 0 };
    placed.set(n.name, { x: p.x, y: p.y, w: s.w, h: s.h });
    const data = nodeData(n, kind, look, scale);
    const state = opts.states?.get(n.name);
    if (state) data.state = state;
    const family = familyOf(kind);
    if (own) data.sized = { w: own.w, h: own.h };
    const natural = own ? nodeSize(kind, look, shownName(n), n.attrs.id, n, scale) : s;
    data.naturalW = natural.w;
    data.naturalH = natural.h;
    // A step 12 shape fills the box its rows and words size; one resized by hand draws at its own size instead.
    const box = family === "kind" && !own ? { width: s.w, height: s.h } : null;
    // A card growing by a new row (a class's member, an ER column) eases to its new height (A5); only while the row is
    // open. `settle` and EASE_IN are the values of --motion-base and --ease-enter, which the CSS rule this replaces
    // used, so a class card keeps its timing; the duration is the motion table's, so reduced motion makes it 0 (D8).
    const grows = extra > 0 ? { transition: `height ${motionMs("settle")}ms ${EASE_IN}` } : null;
    const style = box || grows || scale !== 1 ? { style: { ...box, ...grows, ...scaledStyle(scale) } } : {};
    return { id: n.name, type: family, position: { x: p.x, y: p.y }, initialWidth: s.w, initialHeight: s.h, ...style, ...(scale !== 1 ? { className: TEXT_SCALED } : {}), data };
  });
  // A line to or from a group (a state composite, a Mermaid subgraph) ends on the group's area, as Mermaid and draw.io
  // draw lines to containers (diag-910 fix round 2, L1).
  const groupNames = groupShapes(doc.groups);
  const endOf = (name: string) => (placed.has(name) ? name : groupNames.has(name) ? `\u0000group:${name}` : null);
  const edges: Edge[] = [];
  // ER build C: a column's row, by table and column, built only when a line names a column.
  let rowsOf: Map<string, readonly string[]> | null = null;
  const rowOf = (table: string, column: string | undefined): number => {
    if (column === undefined) return -1;
    rowsOf ??= new Map(doc.nodes.map((n) => [n.name, n.rows ?? []]));
    return erColumnRow(rowsOf.get(table) ?? [], column);
  };
  doc.links.forEach((l, i) => {
    const source = endOf(l.from);
    const target = endOf(l.to);
    if (source === null || target === null) return;
    const data: FlowEdgeData = {};
    if (l.label) data.label = l.label;
    if (l.label && scale !== 1) data.textScale = scale;
    const axis = opts.axes?.[axisKey(l.from, l.to)];
    if (axis) data.axis = axis;
    if (l.fromColumn !== undefined || l.toColumn !== undefined) {
      data.fromRow = rowOf(l.from, l.fromColumn);
      data.toRow = rowOf(l.to, l.toColumn);
    }
    const leaving = opts.states?.get(l.from) === "leaving" || opts.states?.get(l.to) === "leaving";
    if (leaving) data.leaving = true;
    // A dotted "assumes" line has no head (frame 6+.5): it is a permission, not data going one way.
    // Step 11: a coloured line keeps its colour and its arrowhead, selected too.
    const colour = drawnColour(l.color);
    const m = markers(l.arrow, doc.kind, colour, opts.notation);
    edges.push({
      id: `edge:${i}`,
      source,
      target,
      type: "flow",
      className: dashOf(l.arrow, doc.kind) + (leaving ? " is-leaving" : "") + (opts.fresh === i ? " is-new" : "") + markClass(opts, i) + (colour ? ` ${colourClass(colour)}` : ""),
      markerEnd: m.end,
      markerStart: m.start,
      data,
      ...(colour ? { style: lineStyle(colour) } : {}),
    });
  });
  return { nodes: [...areaNodes(doc.groups, placed, emptyAreas(positions, placed)), ...nodes], edges };
}

/** Each group's shapes at any depth, by the group's name (a state composite's own markers left out). */
export function groupShapes(groups: readonly FlowGroup[], markers = false): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (g: FlowGroup): string[] => {
    const all = [...g.nodes.filter((n) => markers || !isStateMarker(n)), ...g.groups.flatMap(walk)];
    out.set(g.name, all);
    return all;
  };
  groups.forEach(walk);
  return out;
}

/**
 * The layout request for dagre: every node's size and the links between nodes. A line to or from a group ranks
 * against each shape in it, so the group sits after what points to it and before what it points to (fix round 2, L1).
 */
export function layoutInput(doc: FlowDoc, look: NodeLook, scale = 1): { nodes: { id: string; w: number; h: number }[]; edges: { from: string; to: string }[]; parents?: Record<string, string> } {
  const names = new Set(doc.nodes.map((n) => n.name));
  // Its own start and end too, so a group's whole block ranks after what points to it (fix round 3, L8).
  const groups = groupShapes(doc.groups, true);
  const ends = (n: string): string[] => (names.has(n) ? [n] : (groups.get(n) ?? []));
  const edges: { from: string; to: string }[] = [];
  for (const l of doc.links) for (const from of ends(l.from)) for (const to of ends(l.to)) if (from !== to) edges.push({ from, to });
  // Each group is laid out as one block (fix round 3, L8): its shapes and inner groups by the area id they draw as.
  const parents: Record<string, string> = Object.create(null);
  const walk = (g: FlowGroup, outer: string | null) => {
    const id = `\u0000group:${g.name}`;
    if (outer) parents[id] = outer;
    for (const n of g.nodes) parents[n] = id;
    for (const c of g.groups) walk(c, id);
  };
  for (const g of doc.groups) walk(g, null);
  return {
    nodes: doc.nodes.map((n) => ({ id: n.name, ...nodeSize(drawnKind(n.kind, doc.kind, n.name), look, shownName(n), n.attrs.id, n, scale) })),
    edges,
    ...(doc.groups.length ? { parents: { ...parents } } : {}),
  };
}
