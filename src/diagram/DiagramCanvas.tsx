// The diagram engine's canvas: React Flow with the fixed config every diagram shares (A1).
import "@xyflow/react/dist/style.css";
import {
  Background,
  BackgroundVariant,
  type ConnectionLineComponent,
  ConnectionMode,
  type Edge,
  type EdgeChange,
  type EdgeTypes,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeSelectionChange,
  type NodeTypes,
  type OnConnectEnd,
  Panel,
  ReactFlow,
  type ReactFlowInstance,
  ReactFlowProvider,
  SelectionMode,
  applyNodeChanges as applyChanges,
  Position,
  useConnection,
  useNodesState,
  useReactFlow,
  useStore,
  useStoreApi,
  type ZIndexMode,
} from "@xyflow/react";
import { type DragEvent, type KeyboardEvent, type MutableRefObject, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Icon from "../components/Icon";
import { perfMark, perfMeasure, perfOn } from "../perf/perfRecorder";
import { ViewportLayer } from "./canvasLayers";
import { ConnectableContext } from "./CardFrame";
import { DetailContext, GRID_FROM, detailFor } from "./detail";
import { EdgeMarkers, hexArrowsIn, OrthogonalEdge, StraightEdge } from "./edges";
import { CARD_WIDTH } from "./metrics";
import { applyLive, drawsTheSame, type LivePositions, restoreBase } from "./livePositions";
import { liveResizes } from "./resize";
import { glideOptions } from "./motion";
import { GUIDE_REACH_PX, GuideIndex, type GuideLine, lockAxis } from "./guides";
import type { Port } from "./types";
import { createZoomTargets, type ZoomTargets, ZoomTargetsContext } from "./zoomVar";
import { type CanvasHandle, type CanvasView, fitBoundsView, LIVE_ANCHOR, MAX_ZOOM, MIN_ZOOM, type ViewTarget, viewOf, wheelDy, wheelZoom } from "./canvasView";

export type PortRef = { nodeId: string; column: string };
export type DragOverPorts = { from: PortRef; over: PortRef | null };

export interface DiagramCanvasProps {
  nodes: Node[];
  edges: Edge[];
  nodeTypes: NodeTypes;
  edgeTypes?: EdgeTypes;
  /** Cards can be selected but not moved or connected. */
  readOnly?: boolean;
  /** Set to the canvas's fit (Shift+1's), for an owner's own "Zoom to fit". */
  fitRef?: MutableRefObject<() => boolean>;
  /**
   * A drag from one column port dropped on another; `from` is the source side, `shift` held at the drop, `at` where
   * it was let go in flow coordinates (the port it snapped to may be off the pointer).
   */
  onConnectPorts?(from: Port, to: Port, shift: boolean, at?: { x: number; y: number }): void;
  /**
   * A column drag (from one port toward another), not the DOM dragover event: called as the drag
   * starts and each time the port it is over changes (`over` null between ports), then with null
   * once the drag ends, by a drop, a drop on nothing, or Esc.
   */
  onDragOver?(drag: DragOverPorts | null): void;
  /** Esc cancelled a column drag: no drop fires. */
  onDragCancel?(): void;
  /** Strict (default): a drag goes from a right-hand dot to a left-hand dot. Loose: any dot to any dot. */
  connectionMode?: "strict" | "loose";
  /**
   * A card was dropped after a drag (once per card of a multi-card drag). `copy`: Ctrl was held at the drop, so the
   * owner clones the cards there (draw.io's Ctrl+drag) and the dragged cards go back to where they were.
   */
  onMove?(id: string, x: number, y: number, copy?: boolean): void;
  /** Every frame of a card drag, for clients whose edges follow the cards live. */
  onDrag?(id: string, x: number, y: number): void;
  onSelect?(ids: string[]): void;
  /**
   * With this the selection is controlled: it is the selected set, the canvas draws only it, and the canvas's own
   * picks (click, Ctrl+click, a box) go to onSelect as the next set, never into the canvas directly. One place
   * holds the selection, so a pick that also changes `nodes` in the same event cannot echo back and forth.
   */
  selection?: readonly string[];
  /**
   * The selected lines (edge ids), controlled as `selection` is: a click on a line, Shift or Ctrl + click, or a click
   * that lets lines go goes to onLineSelect as the next set (diagram-ux-research F1).
   */
  lineSelection?: readonly string[];
  onLineSelect?(ids: string[]): void;
  /** Something dragged in from outside the canvas (the database tree) was dropped at a flow position. */
  onDropObject?(data: DataTransfer, at: { x: number; y: number }): void;
  /**
   * With it set, only a drag whose `dataTransfer.types` holds this type is taken: other drags get no dragover
   * `preventDefault`, no drop ring and no `onDropObject` (B2 R11). Without it every drag from outside is taken.
   */
  dropType?: string;
  onInit?(instance: ReactFlowInstance): void;
  /** Toolbar overlays and banners, drawn over the canvas. */
  children?: ReactNode;
  /** Esc stopped a card drag (F26): the cards went back and no onMove follows. */
  onMoveCancel?(): void;
  /**
   * Which level of detail the canvas provides. "legacy" (the default, every canvas but a board) is detail.ts's
   * `detailFor`: name boxes and blocks by zoom, fast over FAST_OVER nodes. "board" (Plan F Decision 1) is full at
   * every zoom and node count: a board keeps its real shapes, icons, ports and lines.
   */
  detailPolicy?: "legacy" | "board";
  /**
   * The owner moves the selection with the arrow keys itself (the drawn diagrams, with their undo history). Otherwise
   * the canvas does: 1 px, Shift 16 px, reported through onMove once the key goes up (F7, every canvas).
   */
  ownerNudges?: boolean;
  /**
   * An arrow key pressed on a card or the selection box: React Flow's own keyboard move never sees it (N1), so the
   * owner that nudges (`ownerNudges`) gets it here instead of from its own key handler.
   */
  onArrowKey?(e: KeyboardEvent): void;
  /** A drag from a port released where no port takes it; `at` in flow coordinates. Esc-cancelled drags never call it. */
  onConnectRelease?(from: Port, at: { x: number; y: number }): void;
  /** Draws the line of a drag from a port in place of React Flow's own. */
  connectionLineComponent?: ConnectionLineComponent;
  /** Drawn inside the flow, so the viewport layer can place things in flow coordinates. */
  overlay?: ReactNode;
  onEdgeDoubleClick?(id: string): void;
  /** Item 22: a node double-clicked (its editor opens). */
  /** The part double-clicked (`target`) lets a card tell its rows and title apart (diagram step 3). */
  onNodeDoubleClick?(id: string, target?: EventTarget | null): void;
  /** Item 23: the empty canvas double-clicked, at a flow position (a shape is added there); the view does not zoom. */
  onPaneDoubleClick?(at: { screen: { x: number; y: number }; flow: { x: number; y: number } }): void;
  /** A click on the minimap moves the view there in one smooth step (zoom to fit's duration). */
  minimapJump?: boolean;
  /**
   * Dragging empty canvas draws a selection box (nodes join as it touches them); Space + drag or the middle
   * button pans; the wheel pans and Ctrl + wheel zooms around the pointer.
   */
  boxSelect?: boolean;
  /**
   * Positions for some nodes this frame, over `nodes` (a glide): each frame touches only these nodes. When it
   * goes back to null or undefined, those nodes are drawn as `nodes` says again.
   */
  livePositions?: LivePositions | null;
  /**
   * A node to bring into view once it is drawn, such as the shape the assistant just added (P11-34): the view
   * moves to it, at the zoom it has, only when the node is not wholly on screen. Asked again only for another id.
   */
  reveal?: string | null;
  /**
   * A right-click on the empty canvas (`node` null) or on a node (item 20): where it was on screen and in flow
   * coordinates, and the canvas's own zoom to fit for the menu. The browser's menu never shows.
   */
  onContextMenu?(at: CanvasMenuAt): void;
  /** How React Flow orders nodes and lines; its own default ("basic") when absent. Only the board sets "manual". */
  zIndexMode?: ZIndexMode;
  /**
   * The board's Hand tool (Plan B Task 7): the left button pans as the middle one does, and draws no selection box
   * (Figma, Excalidraw).
   */
  hand?: boolean;
  /** React Flow's hold-to-pan key ("Space" on a board, Decision 26); unset keeps React Flow's own. */
  panKey?: string | null;
  /** The overview in the corner; shown unless this is false. */
  showMiniMap?: boolean;
  /**
   * A board frame's node (`\u0000board:` or `\u0000clash:`) dragged by its title tab: each frame of the drag with
   * `done` false, then once with `done` true where it was let go, or with `at` null when Esc stopped it (the frame is
   * put back). Frames never go through onDrag or onMove.
   */
  onFrameDrag?(id: string, at: { x: number; y: number } | null, done: boolean): void;
  /**
   * The view moved (Plan F Decision 8): at most once per animation frame for a pan or a wheel zoom (`landing` false),
   * and once with the landing view as a glide starts (`landing` true), then nothing until it has landed.
   */
  onViewChange?(v: CanvasView, landing: boolean, pointer?: { x: number; y: number }): void;
  /**
   * Plan F Decision 9: a capturing wheel listener takes every Ctrl or Meta wheel (a trackpad pinch too) and zooms around
   * the pointer by one clamped step, over cards that scroll and open fields alike; a plain wheel pans as before. The
   * view then reports with the pointer's flow point. Boards only; other canvases keep React Flow's wheel.
   */
  smoothWheel?: boolean;
  /** The canvas's handle once it has its React Flow instance: `glideView`, the one way a view move glides. */
  onCanvasReady?(h: CanvasHandle): void;
  /**
   * Plan F Decision 13: an overview option drawn where the MiniMap sits. Given, the zoom panel gains an "Overview"
   * toggle (off by default, not saved) and the slot shows only while it is on; the React Flow MiniMap is `showMiniMap`'s.
   */
  mapSlot?: ReactNode;
}

/** A board frame's node id: its title tab drags it, through `onFrameDrag`. */
const isFrameNode = (id: string) => id.startsWith("\u0000board:") || id.startsWith("\u0000clash:");
/**
 * A board's sketch layer: zero-size, its sketches drawn at their board places from it. Mirrors `SKETCH_LAYER_ID` in
 * src/flow/board/sketches.ts (diagram/ does not import flow/); sketches.test.ts checks the two are equal.
 */
export const SKETCH_LAYER = "\u0000sketches";

/** Where a canvas right-click landed, for the owner's menu. */
export interface CanvasMenuAt {
  node: string | null;
  /** The line right-clicked (its edge id), when the click was on a line. */
  line?: string | null;
  /** The right-click was on the box around a multi-selection (F11): the menu is the selection's. */
  selection?: boolean;
  screen: { x: number; y: number };
  flow: { x: number; y: number };
  fit(): void;
}

const MULTI_SELECT_KEYS = ["Shift", "Control", "Meta"];
/** The minor and major snap grid (DESIGN-NEXT 10.6). */
const GRID = 16;
const GRID_MAJOR = 80;

/** The column a port handle id names: `{column}:{side}`, side being s, t, sl or tr. */
export function columnOfHandle(handleId: string | null | undefined): string {
  if (!handleId) return "";
  const at = handleId.lastIndexOf(":");
  return at < 0 ? handleId : handleId.slice(0, at);
}

/**
 * Fits the view once, as soon as the pane has a size; a window resize after that keeps the view's centre and zoom
 * (F16, as Figma and draw.io). Every node
 * carries its size up front (initialWidth, initialHeight), so this does not wait for React Flow to
 * measure: with onlyRenderVisibleElements the off-screen nodes are never measured, and a wait would
 * never end. The fit never zooms past 100 percent. Also draws the zoom control: minus, the percent,
 * plus and fit.
 */
/**
 * The canvas zoom as `--rz-zoom` on the elements that read it (`useZoomVar`: the resize zones, app.css `.rz-*`, and a
 * board's frame tabs), so they keep their size on screen at any zoom. Never on the flow itself: an inherited custom
 * property changed there restyled every node on each zoom frame (Task 9 fix 2). It renders nothing; only it draws
 * again on a zoom.
 */
function ZoomVar({ targets }: { targets: ZoomTargets }) {
  const zoom = useStore((s) => s.transform[2]);
  useLayoutEffect(() => {
    targets.set(zoom);
  }, [targets, zoom]);
  return null;
}

/** The zoom buttons' and Ctrl+Plus's step (React Flow's `zoomIn`). */
const ZOOM_STEP = 1.2;

/** A glide to `zoom` (clamped) around the view's middle, as React Flow's `zoomTo` and `zoomIn` do. */
function zoomAround(st: { transform: [number, number, number]; width: number; height: number }, zoom: number): ViewTarget {
  const [x, y, z] = st.transform;
  return { center: { x: (st.width / 2 - x) / z, y: (st.height / 2 - y) / z }, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom)) };
}
const zoomBy = (st: { transform: [number, number, number]; width: number; height: number }, by: number) => zoomAround(st, st.transform[2] * by);

function ViewControls({
  nodes,
  fitRef,
  glideView,
  map,
}: {
  nodes: Node[];
  fitRef: MutableRefObject<() => boolean>;
  glideView(to: ViewTarget): Promise<void>;
  /** The overview toggle's state, when the canvas has a `mapSlot`. */
  map?: { on: boolean; toggle(): void };
}) {
  const store = useStoreApi();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const ready = useStore((s) => s.panZoom !== null);
  const zoom = useStore((s) => s.transform[2]);
  const { setViewport, getViewport } = useReactFlow();
  const fitted = useRef(false);

  const fit = useCallback(() => {
    const { width: w, height: h, maxZoom, panZoom } = store.getState();
    // Frame boxes alone are not a drawing yet (their shapes are still being placed): the first fit waits for one. After
    // it, frame boxes alone are the board: a board whose frames are all out of view draws only their boxes (Plan F
    // Decision 6), and a fit from there still fits them.
    if (!panZoom || !w || !h || (!fitted.current && !nodes.some((n) => !isFrameNode(n.id) && n.id !== SKETCH_LAYER && n.id !== LIVE_ANCHOR && n.parentId !== SKETCH_LAYER))) return false;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    // Sketches are part of the drawing: each at the layer's place plus its own; the zero-size layer is not.
    const layer = nodes.find((n) => n.id === SKETCH_LAYER)?.position;
    for (const n of nodes) {
      // A child is drawn inside its parent (a board frame's shapes): its position is the parent's, not the flow's. The
      // live frame is measured by its box node, as every frame is; its zero-size anchor and the shapes hanging from it
      // are skipped (Plan F Decision 11).
      if (n.id === SKETCH_LAYER || n.id === LIVE_ANCHOR || (n.parentId && !(layer && n.parentId === SKETCH_LAYER))) continue;
      const px = n.parentId && layer ? layer.x + n.position.x : n.position.x;
      const py = n.parentId && layer ? layer.y + n.position.y : n.position.y;
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px + (n.initialWidth ?? CARD_WIDTH));
      y1 = Math.max(y1, py + (n.initialHeight ?? 0));
    }
    if (x0 === Infinity) return false;
    const bounds = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    // Too big to fit even at the least zoom, it opens at its start rather than on empty space between its parts.
    // The fit never zooms past 100 percent; `glideView` reports where it lands before it glides (Plan F Decision 8).
    void glideView({ bounds, padding: 0.1, maxZoom: Math.min(1, maxZoom) });
    return true;
  }, [nodes, store, glideView]);

  fitRef.current = fit;

  useEffect(() => {
    if (fitted.current || !ready || !width || !height) return;
    if (fit()) fitted.current = true;
  }, [ready, width, height, fit]);

  // After the first fit a resize keeps the view's centre and zoom (F16, as Figma and draw.io): the drawing moves by
  // half the change in size, so what was in the middle stays in the middle.
  const size = useRef<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const was = size.current;
    size.current = width && height ? { w: width, h: height } : was;
    if (!fitted.current || !was || !width || !height || (was.w === width && was.h === height)) return;
    const { x, y, zoom } = getViewport();
    void setViewport({ x: x + (width - was.w) / 2, y: y + (height - was.h) / 2, zoom });
  }, [width, height, getViewport, setViewport]);

  return (
    <Panel position="bottom-right" className="canvas-zoom" data-map={map ? (map.on ? "on" : "off") : undefined} role="group" aria-label="Zoom">
      <button type="button" className="icon-button" aria-label="Zoom out" title="Zoom out" onClick={() => void glideView(zoomBy(store.getState(), 1 / ZOOM_STEP))}>
        <Icon name="minus" size={14} />
      </button>
      <span className="canvas-zoom-percent">{Math.round(zoom * 100)}%</span>
      <button type="button" className="icon-button" aria-label="Zoom in" title="Zoom in" onClick={() => void glideView(zoomBy(store.getState(), ZOOM_STEP))}>
        <Icon name="plus" size={14} />
      </button>
      <span className="canvas-zoom-divider" aria-hidden="true" />
      <button type="button" className="icon-button" aria-label="Fit to view" title="Fit to view (Shift+1)" onClick={() => fit()}>
        <Icon name="fit" size={14} />
      </button>
      {map && (
        <button type="button" className={map.on ? "icon-button icon-button-on" : "icon-button"} aria-label="Overview" title="Overview" aria-pressed={map.on} onClick={map.toggle}>
          <Icon name="grid" size={14} />
        </button>
      )}
    </Panel>
  );
}

/**
 * A column drag: reports where it starts and which port it is over as that changes, and cancels it
 * on Esc. React Flow has no Esc for a connection drag and would still report the drop, so the cancel
 * sets `cancelled`, which makes the next connect end a no-op.
 */
function ColumnDrag({
  onDragOver,
  onDragCancel,
  cancelled,
}: {
  onDragOver?: DiagramCanvasProps["onDragOver"];
  onDragCancel?: DiagramCanvasProps["onDragCancel"];
  cancelled: MutableRefObject<boolean>;
}) {
  const store = useStoreApi();
  // One string per state, so the selector only re-renders on a change: from, then over (empty when none).
  const drag = useConnection((c) =>
    c.inProgress && c.fromHandle
      ? [c.fromHandle.nodeId, c.fromHandle.id ?? "", ...(c.toHandle && c.isValid ? [c.toHandle.nodeId, c.toHandle.id ?? ""] : [])].join("\n")
      : null,
  );
  const report = useRef(onDragOver);
  report.current = onDragOver;
  const cancel = useRef(onDragCancel);
  cancel.current = onDragCancel;
  const was = useRef<string | null>(null);

  useEffect(() => {
    if (drag === was.current) return;
    was.current = drag;
    if (drag === null) return report.current?.(null);
    const [fromNode, fromHandle, overNode, overHandle] = drag.split("\n");
    report.current?.({
      from: { nodeId: fromNode, column: columnOfHandle(fromHandle) },
      over: overNode === undefined ? null : { nodeId: overNode, column: columnOfHandle(overHandle) },
    });
  }, [drag]);

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      cancelled.current = true;
      store.getState().cancelConnection();
      cancel.current?.();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dragging, store, cancelled]);
  return null;
}

/** The snap grid: 16 px dots in --c-border, 80 px dots in --c-border-strong at 50 percent; hidden below 40 percent. */
function SnapGrid() {
  const shown = useStore((s) => s.transform[2] >= GRID_FROM);
  if (!shown) return null;
  return (
    <>
      <Background id="minor" className="diagram-grid" patternClassName="diagram-grid-minor" variant={BackgroundVariant.Dots} gap={GRID} size={1} />
      {/* Transparent, so the minor dots show through. */}
      <Background id="major" className="diagram-grid" patternClassName="diagram-grid-major" bgColor="transparent" variant={BackgroundVariant.Dots} gap={GRID_MAJOR} size={1} />
    </>
  );
}

/** The guides of the drag under way, as a tiny store, so a frame redraws only the guide layer. */
function createGuideStore() {
  let lines: GuideLine[] = [];
  const subs = new Set<() => void>();
  return {
    get: () => lines,
    set(next: GuideLine[]) {
      // The same guides as the last frame: nothing to draw again (M2).
      if (next.length === lines.length && next.every((g, i) => g.axis === lines[i].axis && g.at === lines[i].at && g.from === lines[i].from && g.to === lines[i].to)) return;
      lines = next;
      for (const f of subs) f();
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}

/** The 1 px accent guides, in flow coordinates; the stroke keeps 1 screen px at any zoom. */
function GuideLayer({ store }: { store: ReturnType<typeof createGuideStore> }) {
  const lines = useSyncExternalStore(store.subscribe, store.get);
  if (lines.length === 0) return null;
  return (
    <ViewportLayer>
      <svg className="diagram-guides" aria-hidden="true">
        {lines.map((g, i) =>
          g.axis === "x" ? <line key={i} x1={g.at} x2={g.at} y1={g.from} y2={g.to} /> : <line key={i} x1={g.from} x2={g.to} y1={g.at} y2={g.at} />,
        )}
      </svg>
    </ViewportLayer>
  );
}

/**
 * A node with its four side handles (the shapes' `Handles`: r, l, t and b at the middle of each side) when it has none
 * and a size, as React Flow's `handles` for nodes it has not measured. React Flow mounts every node it has not measured
 * whatever is on screen (`getNodesInside` forces a first render until it has handle bounds): with them it mounts only
 * the nodes in view (onlyRenderVisibleElements, as Figma and Miro draw only what is on screen) and still draws the
 * lines to the rest. A node that mounts is measured, and `settled` drops these for its real handles. Frame boxes
 * keep React Flow's own first draw.
 */
function withHandles(n: Node): Node {
  // A frame's box (at most 50, with no handles of its own) is drawn as before.
  if (n.handles || n.measured || isFrameNode(n.id)) return n;
  const w = n.initialWidth ?? n.width ?? 0;
  const h = n.initialHeight ?? n.height ?? 0;
  if (w <= 0 || h <= 0) return n;
  const at = (id: string, position: Position, x: number, y: number) => ({ id, type: "source" as const, position, x: x - 4, y: y - 4, width: 8, height: 8 });
  return { ...n, handles: [at("r", Position.Right, w, h / 2), at("l", Position.Left, 0, h / 2), at("t", Position.Top, w / 2, 0), at("b", Position.Bottom, w / 2, h)] };
}

/**
 * The nodes with `withHandles`' side handles dropped from each one React Flow has measured. React Flow rebuilds a
 * node's handle bounds from its `handles` whenever it is handed a new object (a measure, a select, a move), so a
 * measured node that kept them lost its DOM ports (an ER card's column ports) to the four sides; without `handles` a
 * measured node keeps the bounds React Flow measured.
 */
function settled(nodes: Node[]): Node[] {
  let out: Node[] | null = null;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n.measured || !n.handles) continue;
    out ??= nodes.slice();
    const { handles: _side, ...rest } = n;
    out[i] = rest;
  }
  return out ?? nodes;
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");

function Flow(props: DiagramCanvasProps) {
  const { readOnly, onConnectPorts, onDragOver, onDragCancel, connectionMode, onMove, onDrag, onSelect, onDropObject, onInit, nodeTypes, edgeTypes, children } = props;
  const { onMoveCancel, onConnectRelease, connectionLineComponent, overlay, onEdgeDoubleClick, minimapJump, boxSelect, onContextMenu, onNodeDoubleClick, onPaneDoubleClick } = props;
  const board = props.detailPolicy === "board";
  const counted = props.nodes.length;
  const fast = !board && detailFor(1, counted).fast;
  // A board reads no zoom here: nothing in the canvas draws again on a zoom tick for the level of detail.
  const detail = useStore((s) => (board ? "full" : detailFor(s.transform[2], counted).detail));
  const detailValue = useMemo(() => ({ detail, fast }), [detail, fast]);
  const zoomTargets = useMemo(() => createZoomTargets(), []);
  const connectable = !readOnly && !fast && !!onConnectPorts;
  const rf = useReactFlow();
  const { screenToFlowPosition, getZoom, getInternalNode, getViewport } = rf;
  const fitRef = useRef<() => boolean>(() => false);
  if (props.fitRef) props.fitRef.current = () => fitRef.current();
  const viewWidth = useStore((s) => s.width);
  const viewHeight = useStore((s) => s.height);

  const store = useStoreApi();

  // ----- the view (Plan F Decision 8): pans and wheel zooms reported once per animation frame; glides once, as they start.
  /** The instance React Flow hands `onInit`: glides go through it, so a spy on the owner's instance sees them. */
  const instRef = useRef<ReactFlowInstance | null>(null);
  const viewRef = useRef(props.onViewChange);
  viewRef.current = props.onViewChange;
  /** The view last reported, so an unchanged view is not reported twice. */
  const reported = useRef<CanvasView | null>(null);
  /** The glide under way (its number), 0 with none: the views it passes are not reported. */
  const gliding = useRef(0);
  /** Each glide's fallback timer, cleared when it lands and on unmount. */
  const glideTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  /** False once the canvas is gone: a glide landing after that reports nothing. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const timers = glideTimers.current;
    return () => {
      alive.current = false;
      gliding.current = 0;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);
  /**
   * A pan or zoom the user starts (React Flow passes its event; a glide's own moves have none) cuts the glide short:
   * from then on the view is reported per animation frame, as any view is.
   */
  const onMoveStart = useCallback(
    (event: MouseEvent | TouchEvent | null) => {
      if (event && gliding.current) gliding.current = 0;
    },
    [],
  );
  const report = useCallback((v: CanvasView, landing: boolean, pointer?: { x: number; y: number }) => {
    const was = reported.current;
    if (!landing && was && was.x === v.x && was.y === v.y && was.w === v.w && was.h === v.h && was.zoom === v.zoom) return;
    reported.current = v;
    viewRef.current?.(v, landing, pointer);
  }, []);
  /** The flow point a wheel zoom is around, kept until the next frame's report takes it. */
  const wheelAt = useRef<{ x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewNow = useCallback((): CanvasView | null => {
    const { transform, width, height } = store.getState();
    return width > 0 && height > 0 ? viewOf({ x: transform[0], y: transform[1], zoom: transform[2] }, width, height) : null;
  }, [store]);
  useEffect(() => {
    let frame = 0;
    const flush = () => {
      frame = 0;
      const v = gliding.current ? null : viewNow();
      const at = wheelAt.current ?? undefined;
      wheelAt.current = null;
      if (v) report(v, false, at);
    };
    flush();
    const unsubscribe = store.subscribe((st, prev) => {
      if (frame || gliding.current || (st.transform === prev.transform && st.width === prev.width && st.height === prev.height)) return;
      frame = requestAnimationFrame(flush);
    });
    return () => {
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [store, report, viewNow]);
  const smoothWheel = !!props.smoothWheel;
  useEffect(() => {
    const root = rootRef.current;
    if (!smoothWheel || !root) return;
    // The root's rect, measured at most once per animation frame: a trackpad burst does not force layout per event.
    let rect: DOMRect | null = null;
    let frame = 0;
    const forget = () => {
      frame = 0;
      rect = null;
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const f = instRef.current;
      const { width, height } = store.getState();
      if (!f || !width || !height) return;
      if (!rect) {
        rect = root.getBoundingClientRect();
        frame = requestAnimationFrame(forget);
      }
      const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const from = f.getViewport();
      const to = wheelZoom(from, at, wheelDy(e, height));
      // At a zoom limit nothing moves, and a glide under way is left alone.
      if (to.zoom === from.zoom) return;
      // A wheel during a glide ends it, as React Flow's own wheel would through `onMoveStart`.
      gliding.current = 0;
      // The flow point under the pointer, from the view before this step (the one the view after it keeps there).
      wheelAt.current = { x: (at.x - from.x) / from.zoom, y: (at.y - from.y) / from.zoom };
      void f.setViewport(to);
    };
    root.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      root.removeEventListener("wheel", onWheel, { capture: true });
      if (frame) cancelAnimationFrame(frame);
    };
  }, [smoothWheel, store]);
  const glideView = useCallback(
    (to: ViewTarget): Promise<void> => {
      // Before `onInit` (the first fit can come first), the canvas's own helpers.
      const f = instRef.current ?? rf;
      const { width: w, height: h, minZoom, maxZoom } = store.getState();
      if (!f || !w || !h) return Promise.resolve();
      const options = glideOptions();
      let land: { x: number; y: number; zoom: number };
      let run: () => Promise<boolean>;
      if ("bounds" in to) {
        const b = to.bounds;
        land = fitBoundsView(b, w, h, minZoom, to.maxZoom ?? maxZoom, to.padding);
        // React Flow's own fit where it lands the same (bounds that fit, no cap of the fit's own); else the view itself.
        const fits = b.width * land.zoom <= w && b.height * land.zoom <= h;
        run = to.maxZoom === undefined && fits ? () => f.fitBounds(b, { padding: to.padding, ...options }) : () => f.setViewport(land, options);
      } else {
        const zoom = Math.max(minZoom, Math.min(maxZoom, to.zoom));
        land = { x: w / 2 - to.center.x * zoom, y: h / 2 - to.center.y * zoom, zoom };
        run = () => f.setCenter(to.center.x, to.center.y, { zoom, ...options });
      }
      const glide = ++gliding.current;
      // The opt-in recorder (Plan F Task 9): a glide from its start to the paint after it lands, with its worst frame.
      perfMark("glide");
      report(viewOf(land, w, h), true);
      return new Promise<void>((done) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const landed = () => {
          if (gliding.current === glide && perfOn()) requestAnimationFrame(() => perfMeasure("glide_landed", "glide"));
          if (timer !== null) {
            clearTimeout(timer);
            glideTimers.current.delete(timer);
            timer = null;
          }
          if (gliding.current === glide) {
            gliding.current = 0;
            // Where it ended, should that not be where it was to land.
            const v = alive.current ? viewNow() : null;
            if (v) report(v, false);
          }
          done();
        };
        void run().then(landed, landed);
        // A glide React Flow never ends (cut short, its promise never settles) ends when its time is up.
        timer = setTimeout(landed, (options.duration ?? 0) + 50);
        glideTimers.current.add(timer);
      });
    },
    [store, report, viewNow, rf],
  );
  const cancelGlide = useCallback(() => {
    gliding.current = 0;
  }, []);
  const handle = useMemo<CanvasHandle>(() => ({ glideView, cancelGlide }), [glideView, cancelGlide]);
  const readyRef = useRef(props.onCanvasReady);
  readyRef.current = props.onCanvasReady;
  const [hasInstance, setHasInstance] = useState(false);
  // The overview option: off at every open, never saved (Decision 13).
  const [mapOn, setMapOn] = useState(false);
  useEffect(() => {
    if (hasInstance) readyRef.current?.(handle);
  }, [hasInstance, handle]);
  const initFlow = useCallback(
    (i: ReactFlowInstance) => {
      instRef.current = i;
      setHasInstance(true);
      onInit?.(i);
    },
    [onInit],
  );

  // A board's new shapes come with their side handles, so React Flow mounts only those in view (see `withHandles`).
  const [firstNodes] = useState(() => (board ? props.nodes.map(withHandles) : props.nodes));
  const [nodes, setNodes] = useNodesState(firstNodes);
  // Every change goes through here, the measure among them: a measured node leaves its side handles (`settled`).
  const applyNodeChanges = useCallback((changes: NodeChange[]) => setNodes((prev) => settled(applyChanges(changes, prev))), [setNodes]);
  const selectionRef = useRef(props.selection);
  selectionRef.current = props.selection;
  const controlled = props.selection !== undefined;
  const pickRef = useRef(onSelect);
  pickRef.current = onSelect;
  // Controlled: a select change is a request for the next set, sent to the owner; every other change applies here.
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const outside = selectionRef.current;
      if (!outside) {
        applyNodeChanges(changes);
        return;
      }
      const picks = changes.filter((c): c is NodeSelectionChange => c.type === "select");
      const rest = picks.length === changes.length ? [] : changes.filter((c) => c.type !== "select");
      if (rest.length > 0) applyNodeChanges(rest);
      if (picks.length === 0) return;
      const next = new Set(outside);
      for (const c of picks) {
        if (c.selected) next.add(c.id);
        else next.delete(c.id);
      }
      if (next.size === outside.length && outside.every((id) => next.has(id))) return;
      pickRef.current?.([...next]);
    },
    [applyNodeChanges],
  );
  // New nodes keep what is selected: an edit made on a card must not drop its outline. With `selection`, that
  // list is the selected set, so a node selected before it is drawn shows its ring once it arrives.
  /** The props node each canvas node was last made from, by id: a node made from the same object again is kept. */
  const madeFrom = useRef(new Map<string, Node>());
  useEffect(() => {
    setNodes((prev) => {
        const outside = selectionRef.current;
        const picked = new Set(outside ?? prev.filter((p) => p.selected).map((p) => p.id));
        // A node that draws the same keeps its measured size: React Flow draws every node it has not measured,
        // so dropping the sizes on each change drew all 2,000 nodes of a large diagram for a frame instead of the
        // visible ones. A node whose content changed is measured again, so its ports are found where they are now.
        const before = new Map(prev.map((p) => [p.id, p]));
        const resizing = liveResizes(store.getState().domNode);
        const from = madeFrom.current;
        const made = new Map<string, Node>();
        madeFrom.current = made;
        return props.nodes.map((n) => {
          const p = before.get(n.id);
          const selected = picked.has(n.id) || undefined;
          // A node made from this very object last time, still where it put it, as selected and not being resized, is
          // that node (its measured size kept): React Flow skips it (Task 18b: a board's switch hands over 1,000
          // unchanged sketches and 49 unchanged frames).
          const live = resizing.get(n.id);
          if (p && !live && from.get(n.id) === n && p.position === n.position && p.selected === selected) {
            made.set(n.id, n);
            return p;
          }
          const measured = n.measured ?? (p && drawsTheSame(p, n) ? p.measured : undefined);
          // A node being resized keeps its live box until the drag ends.
          const box = live ? { position: { x: live.x, y: live.y }, width: live.w, height: live.h } : {};
          made.set(n.id, n);
          // A board's shape not drawn yet is placed by its handles until it is (`withHandles`); one drawn before whose
          // content changed is measured again as before, so its ports are found where they are now.
          const fresh = board && !measured && !p?.measured ? withHandles(n) : n;
          return { ...fresh, ...(measured ? { measured } : {}), ...box, selected };
        });
      });
  }, [props.nodes, setNodes, store, board]);

  // Brings `reveal` into view once React Flow has the node; a node already wholly on screen leaves the view as it is.
  const reveal = props.reveal ?? null;
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (reveal === null) {
      revealed.current = null;
      return;
    }
    if (revealed.current === reveal || viewWidth === 0 || viewHeight === 0) return;
    const n = getInternalNode(reveal);
    if (!n) return;
    revealed.current = reveal;
    const at = n.internals.positionAbsolute;
    const w = n.measured.width ?? n.width ?? n.initialWidth ?? 0;
    const h = n.measured.height ?? n.height ?? n.initialHeight ?? 0;
    const { x, y, zoom } = getViewport();
    const left = at.x * zoom + x;
    const top = at.y * zoom + y;
    if (left >= 0 && top >= 0 && left + w * zoom <= viewWidth && top + h * zoom <= viewHeight) return;
    void glideView({ center: { x: at.x + w / 2, y: at.y + h / 2 }, zoom });
  }, [reveal, nodes, viewWidth, viewHeight, getInternalNode, getViewport, glideView]);

  // A glide: each frame replaces only the gliding nodes; at its end they are drawn from the props again.
  const live = props.livePositions ?? null;
  const liveKeys = useRef<Set<string>>(new Set());
  const baseNodes = useRef(props.nodes);
  baseNodes.current = props.nodes;
  useEffect(() => {
    if (live) {
      for (const k of Object.keys(live)) liveKeys.current.add(k);
      setNodes((prev) => applyLive(prev, live));
      return;
    }
    const keys = liveKeys.current;
    if (keys.size === 0) return;
    liveKeys.current = new Set();
    setNodes((prev) => restoreBase(prev, baseNodes.current, keys));
  }, [live, setNodes]);

  // A selection made outside the canvas: only a changed list moves it, so a pick on the canvas is not undone.
  const selectionKey = props.selection ? props.selection.join("\u0000") : null;
  useEffect(() => {
    const ids = selectionRef.current;
    if (!ids) return;
    const want = new Set(ids);
    setNodes((prev) =>
      prev.some((n) => !!n.selected !== want.has(n.id)) ? prev.map((n) => ({ ...n, selected: want.has(n.id) || undefined })) : prev,
    );
  }, [selectionKey, setNodes]);

  // Zoomed out the column ports are gone: edges end on the box sides; fast mode draws them straight.
  // Selected lines are drawn selected (F1); only they get a new object.
  const lineKey = props.lineSelection ? props.lineSelection.join("\u0000") : "";
  const edges = useMemo(() => {
    const picked = new Set(lineKey ? lineKey.split("\u0000") : []);
    const ported = detail === "full" && !fast;
    if (ported && picked.size === 0) return props.edges;
    return props.edges.map((e) => {
      const on = picked.has(e.id);
      if (ported && !on) return e;
      return { ...e, ...(ported ? {} : { sourceHandle: null, targetHandle: null, ...(fast ? { type: "straight" } : {}) }), ...(on ? { selected: true } : {}) };
    });
  }, [props.edges, detail, fast, lineKey]);
  const hexArrows = useMemo(() => hexArrowsIn(props.edges), [props.edges]);
  // Lines are picked as cards are when the selection is controlled: the next set goes to the owner.
  const lineRef = useRef(props.lineSelection);
  lineRef.current = props.lineSelection;
  const linePickRef = useRef(props.onLineSelect);
  linePickRef.current = props.onLineSelect;
  const linesControlled = props.onLineSelect !== undefined;
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const picks = changes.filter((c) => c.type === "select");
    if (picks.length === 0) return;
    const was = lineRef.current ?? [];
    const next = new Set(was);
    for (const c of picks) {
      if (c.selected) next.add(c.id);
      else next.delete(c.id);
    }
    if (next.size === was.length && was.every((id) => next.has(id))) return;
    linePickRef.current?.([...next]);
  }, []);
  const allEdgeTypes = useMemo<EdgeTypes>(() => ({ orthogonal: OrthogonalEdge, straight: StraightEdge, ...edgeTypes }), [edgeTypes]);

  // One handler for the canvas's life: React Flow reports the selection again whenever this function changes,
  // and a fresh one each render would report a stale pick back over a selection made outside (`selection`).
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const onSelectionChange = useCallback(({ nodes: picked }: { nodes: Node[] }) => selectRef.current?.(picked.map((n) => n.id)), []);

  // ----- moving cards: smart guides, Alt and Shift, Esc (erd-ux-research 5.5; F7, F26)
  const guideStore = useMemo(() => createGuideStore(), []);
  /** The drag under way: where its cards started, the guides it can meet, and whether Esc stopped it. */
  const moving = useRef<{
    start: Map<string, { x: number; y: number }>;
    /** Each dragged node's parent's place on the canvas: a child's position is its parent's (a board sketch's the layer's, a live shape's the live anchor's). */
    offset: Map<string, { x: number; y: number }>;
    index: GuideIndex;
    zoom: number;
    cancelled: boolean;
    off(): void;
  } | null>(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const sizeOf = (n: Node) => ({ w: n.measured?.width ?? n.width ?? n.initialWidth ?? 0, h: n.measured?.height ?? n.height ?? n.initialHeight ?? 0 });
  const putBack = (start: Map<string, { x: number; y: number }>) =>
    setNodes((prev) => prev.map((n) => (start.has(n.id) ? { ...n, position: start.get(n.id)! } : n)));

  // ----- a board frame dragged by its title tab: no guides, no onMove; Esc puts it back.
  const frameDrag = useRef<{ id: string; start: { x: number; y: number }; cancelled: boolean; off(): void } | null>(null);
  const onFrameDragRef = useRef(props.onFrameDrag);
  onFrameDragRef.current = props.onFrameDrag;
  const startFrameDrag = (frame: Node) => {
    frameDrag.current?.off();
    const start = { x: frame.position.x, y: frame.position.y };
    const onKey = (ev: globalThis.KeyboardEvent) => {
      const f = frameDrag.current;
      if (ev.key !== "Escape" || !f || f.cancelled) return;
      ev.preventDefault();
      ev.stopPropagation();
      f.cancelled = true;
      putBack(new Map([[f.id, f.start]]));
      onFrameDragRef.current?.(f.id, null, true);
      const up = new MouseEvent("mouseup", { bubbles: true, cancelable: true });
      Object.defineProperty(up, "view", { get: () => window });
      window.dispatchEvent(up);
    };
    window.addEventListener("keydown", onKey, true);
    frameDrag.current = { id: frame.id, start, cancelled: false, off: () => window.removeEventListener("keydown", onKey, true) };
  };
  useEffect(() => () => frameDrag.current?.off(), []);

  const onDragStart = (_e: unknown, _node: Node, dragged: Node[]) => {
    const frame = dragged.find((n) => isFrameNode(n.id));
    if (frame) {
      startFrameDrag(frame);
      return;
    }
    moving.current?.off();
    const start = new Map(dragged.map((n) => [n.id, { x: n.position.x, y: n.position.y }] as const));
    // Guides and snaps are on the canvas: a child's place is its parent's plus its own (a board's frame shapes, its
    // sketches under the layer, the live frame's shapes under its anchor), so every box is taken there.
    const byId = new Map<string, Node>();
    for (const n of nodesRef.current) byId.set(n.id, n);
    const parentAt = (n: Node): { x: number; y: number } => {
      let x = 0;
      let y = 0;
      for (let p = n.parentId ? byId.get(n.parentId) : undefined, hops = 0; p && hops < 8; p = p.parentId ? byId.get(p.parentId) : undefined, hops++) {
        x += p.position.x;
        y += p.position.y;
      }
      return { x, y };
    };
    const offset = new Map(dragged.map((n) => [n.id, parentAt(n)] as const));
    // The shapes on screen (and a screen around it) that are not moving, once per drag: each frame then only searches.
    const { x: vx, y: vy, zoom } = getViewport();
    const w = viewWidth / zoom;
    const h = viewHeight / zoom;
    const x0 = -vx / zoom - w;
    const y0 = -vy / zoom - h;
    const boxes = [];
    for (const n of nodesRef.current) {
      if (start.has(n.id) || n.selectable === false || n.hidden) continue;
      const s = sizeOf(n);
      const o = n.parentId ? parentAt(n) : { x: 0, y: 0 };
      const px = n.position.x + o.x;
      const py = n.position.y + o.y;
      if (px + s.w < x0 || py + s.h < y0 || px > x0 + 3 * w || py > y0 + 3 * h) continue;
      boxes.push({ x: px, y: py, ...s });
    }
    const onKey = (ev: globalThis.KeyboardEvent) => {
      const m = moving.current;
      if (ev.key !== "Escape" || !m) return;
      ev.preventDefault();
      ev.stopPropagation();
      m.cancelled = true;
      putBack(m.start);
      guideStore.set([]);
      onMoveCancel?.();
      // Ends the pointer drag (d3-drag listens for the release on the window), so the cards stop following.
      const up = new MouseEvent("mouseup", { bubbles: true, cancelable: true });
      Object.defineProperty(up, "view", { get: () => window });
      window.dispatchEvent(up);
    };
    // React Flow skips the drag's end when it aborts one (the node went away mid-drag): the release still ends it here,
    // so no Esc trap is left behind (M1).
    const onUp = () =>
      setTimeout(() => {
        if (moving.current === drag) {
          moving.current = null;
          drag.off();
          guideStore.set([]);
        }
      });
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchend", onUp);
    const drag = {
      start,
      offset,
      index: new GuideIndex(boxes),
      zoom: zoom || 1,
      cancelled: false,
      off: () => {
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("touchend", onUp);
      },
    };
    moving.current = drag;
  };

  /** Where the dragged cards go this frame: the pointer's move, Shift's axis, then the guides unless Alt is held. */
  const placeDragged = (e: { altKey: boolean; shiftKey: boolean }, dragged: Node[]): Map<string, { x: number; y: number }> | null => {
    const m = moving.current;
    if (!m || m.cancelled || dragged.length === 0) return null;
    const lead = dragged[0];
    const from = m.start.get(lead.id);
    if (!from) return null;
    let dx = lead.position.x - from.x;
    let dy = lead.position.y - from.y;
    let axis: "x" | "y" | null = null;
    if (e.shiftKey) ({ dx, dy, axis } = lockAxis(dx, dy));
    let lines: GuideLine[] = [];
    if (!e.altKey && m.index.size > 0) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of dragged) {
        const s0 = m.start.get(n.id);
        if (!s0) continue;
        const s = sizeOf(n);
        const o = m.offset.get(n.id) ?? { x: 0, y: 0 };
        x0 = Math.min(x0, o.x + s0.x + dx);
        y0 = Math.min(y0, o.y + s0.y + dy);
        x1 = Math.max(x1, o.x + s0.x + dx + s.w);
        y1 = Math.max(y1, o.y + s0.y + dy + s.h);
      }
      const snap = m.index.snap({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, GUIDE_REACH_PX / m.zoom, { x: axis !== "y", y: axis !== "x" });
      dx += snap.dx;
      dy += snap.dy;
      lines = snap.lines;
    }
    guideStore.set(lines);
    const out = new Map<string, { x: number; y: number }>();
    for (const n of dragged) {
      const s0 = m.start.get(n.id);
      if (s0) out.set(n.id, { x: s0.x + dx, y: s0.y + dy });
    }
    return out;
  };

  const onNodeDrag = (e: { altKey: boolean; shiftKey: boolean }, _node: Node, dragged: Node[]) => {
    const f = frameDrag.current;
    if (f) {
      const frame = dragged.find((n) => n.id === f.id);
      if (frame && !f.cancelled) onFrameDragRef.current?.(f.id, { x: frame.position.x, y: frame.position.y }, false);
      return;
    }
    const at = placeDragged(e, dragged);
    if (!at) return;
    setNodes((prev) => prev.map((n) => (at.has(n.id) ? { ...n, position: at.get(n.id)! } : n)));
    if (onDrag) for (const [id, p] of at) onDrag(id, p.x, p.y);
  };

  const onDragStop = (e: { altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }, _node: Node, dragged: Node[]) => {
    const f = frameDrag.current;
    if (f) {
      frameDrag.current = null;
      f.off();
      const frame = dragged.find((n) => n.id === f.id);
      if (!f.cancelled && frame) onFrameDragRef.current?.(f.id, { x: Math.round(frame.position.x), y: Math.round(frame.position.y) }, true);
      return;
    }
    const m = moving.current;
    if (!m) return;
    const placed = m.cancelled ? null : placeDragged(e, dragged);
    // Kept places are whole pixels on every canvas (M3).
    const at = placed && new Map([...placed].map(([id, p]) => [id, { x: Math.round(p.x), y: Math.round(p.y) }] as const));
    moving.current = null;
    m.off();
    guideStore.set([]);
    if (m.cancelled) {
      putBack(m.start);
      return;
    }
    if (!at) return;
    // Ctrl+drag clones (draw.io): the dragged cards go back, the owner adds the copies where they were let go.
    const copy = e.ctrlKey || e.metaKey;
    if (copy) setNodes((prev) => restoreBase(prev, baseNodes.current, new Set(at.keys())));
    else setNodes((prev) => prev.map((n) => (at.has(n.id) ? { ...n, position: at.get(n.id)! } : n)));
    if (onMove) for (const [id, p] of at) onMove(id, p.x, p.y, copy);
  };
  useEffect(() => () => moving.current?.off(), []);

  // B3 live fix: a drag from a port selects no text. WebKit starts a text selection from a press even inside a
  // `user-select: none` card, and asks again (`selectstart`) on what the drag passes over; carried over another frame's
  // line layer it painted the ::selection wash over the board, which stayed after the drop. React Flow does not stop
  // the press's default (that would also keep focus where it was), so every `selectstart` is refused until the button
  // is up.
  const portPress = useRef<(() => void) | null>(null);
  const onPortPress = (e: { button: number; target: EventTarget }) => {
    if (e.button !== 0 || portPress.current || !(e.target instanceof Element) || !e.target.closest(".react-flow__handle")) return;
    const refuse = (ev: Event) => ev.preventDefault();
    const end = () => {
      document.removeEventListener("selectstart", refuse, true);
      window.removeEventListener("mouseup", end, true);
      window.removeEventListener("blur", end);
      portPress.current = null;
    };
    document.addEventListener("selectstart", refuse, true);
    window.addEventListener("mouseup", end, true);
    window.addEventListener("blur", end);
    portPress.current = end;
  };
  useEffect(() => () => portPress.current?.(), []);

  const cancelled = useRef(false);
  const onConnectStart = useCallback(() => {
    cancelled.current = false;
  }, []);
  const onConnectEnd = useCallback<OnConnectEnd>(
    (event, state) => {
      // Esc cancelled this drag: the drop does nothing.
      if (cancelled.current) {
        cancelled.current = false;
        return;
      }
      if (onConnectRelease && state.fromHandle && (!state.isValid || !state.toHandle)) {
        const p = "changedTouches" in event ? event.changedTouches[0] : event;
        if (p) onConnectRelease({ node: state.fromHandle.nodeId, port: columnOfHandle(state.fromHandle.id) }, screenToFlowPosition({ x: p.clientX, y: p.clientY }));
        return;
      }
      if (!onConnectPorts || !state.isValid || !state.fromHandle || !state.toHandle) return;
      const a = { node: state.fromHandle.nodeId, port: columnOfHandle(state.fromHandle.id) };
      const b = { node: state.toHandle.nodeId, port: columnOfHandle(state.toHandle.id) };
      const [from, to] = state.fromHandle.type === "target" ? [b, a] : [a, b];
      const p = "changedTouches" in event ? event.changedTouches[0] : event;
      onConnectPorts(from, to, event.shiftKey, p ? screenToFlowPosition({ x: p.clientX, y: p.clientY }) : undefined);
    },
    [onConnectPorts, onConnectRelease, screenToFlowPosition],
  );

  /** Shift+2 (Figma): the selected cards fill the view; nothing selected, nothing moves. */
  const zoomToSelection = () => {
    const ids = new Set(props.selection ?? nodes.filter((n) => n.selected).map((n) => n.id));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      if (!ids.has(n.id)) continue;
      // Where it is drawn: a child (a board's live shape under its anchor) is at its parent's place plus its own.
      const at = n.parentId ? (getInternalNode(n.id)?.internals.positionAbsolute ?? n.position) : n.position;
      x0 = Math.min(x0, at.x);
      y0 = Math.min(y0, at.y);
      x1 = Math.max(x1, at.x + (n.initialWidth ?? n.measured?.width ?? CARD_WIDTH));
      y1 = Math.max(y1, at.y + (n.initialHeight ?? n.measured?.height ?? 0));
    }
    if (x0 === Infinity) return;
    void glideView({ bounds: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, padding: 0.1 });
  };

  // ----- the arrow keys (F7, I6): 1 px, Shift 16 px; a held key's repeats are one move, reported when it goes up.
  const nudging = useRef<Map<string, { x: number; y: number }> | null>(null);
  const endNudge = () => {
    const at = nudging.current;
    nudging.current = null;
    if (at && onMove) for (const [id, p] of at) onMove(id, p.x, p.y, false);
  };
  const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const nudge = (e: KeyboardEvent): boolean => {
    const dir = ARROWS[e.key];
    if (!dir || props.ownerNudges || readOnly || !onMove || e.ctrlKey || e.metaKey || e.altKey) return false;
    const ids = new Set(props.selection ?? nodesRef.current.filter((n) => n.selected).map((n) => n.id));
    const moved = nodesRef.current.filter((n) => ids.has(n.id) && n.draggable !== false && n.selectable !== false);
    if (moved.length === 0) return false;
    e.preventDefault();
    if (!e.repeat) endNudge();
    const step = e.shiftKey ? 16 : 1;
    const at = nudging.current ?? new Map<string, { x: number; y: number }>();
    for (const n of moved) {
      const p = at.get(n.id) ?? n.position;
      at.set(n.id, { x: Math.round(p.x) + dir[0] * step, y: Math.round(p.y) + dir[1] * step });
    }
    nudging.current = at;
    setNodes((prev) => prev.map((n) => (at.has(n.id) ? { ...n, position: at.get(n.id)! } : n)));
    return true;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isTyping(e.target)) return;
    if (nudge(e)) return;
    const shiftOnly = e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
    if (shiftOnly && (e.code === "Digit1" || e.key === "!" || e.key === "1")) {
      e.preventDefault();
      fitRef.current();
    } else if (shiftOnly && (e.code === "Digit0" || e.key === ")" || e.key === "0")) {
      // Shift+0: 100 percent, around the middle of the view (Figma).
      e.preventDefault();
      void glideView(zoomAround(store.getState(), 1));
    } else if (shiftOnly && (e.code === "Digit2" || e.key === "@" || e.key === "2")) {
      e.preventDefault();
      zoomToSelection();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "=" || e.code === "NumpadAdd")) {
      e.preventDefault();
      void glideView(zoomBy(store.getState(), ZOOM_STEP));
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "-" || e.code === "NumpadSubtract")) {
      e.preventDefault();
      void glideView(zoomBy(store.getState(), 1 / ZOOM_STEP));
    }
  };

  const menuAt = (e: { clientX: number; clientY: number; preventDefault(): void }, node: string | null, line: string | null = null, selection = false) => {
    e.preventDefault();
    onContextMenu?.({
      node,
      ...(line !== null ? { line } : {}),
      ...(selection ? { selection } : {}),
      screen: { x: e.clientX, y: e.clientY },
      flow: screenToFlowPosition({ x: e.clientX, y: e.clientY }),
      fit: () => void fitRef.current(),
    });
  };

  // The DOM dragover of a drop from outside (the tree), not the `onDragOver` prop of a column drag.
  // Item 24: while something from outside is over the canvas, the canvas rings so the drop is expected.
  const [dropping, setDropping] = useState(false);
  const dropType = props.dropType;
  const takes = (e: DragEvent) => dropType === undefined || Array.from(e.dataTransfer.types).includes(dropType);
  const onDragOverPane = onDropObject
    ? (e: DragEvent) => {
        if (!takes(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!dropping) setDropping(true);
      }
    : undefined;
  const onDragLeavePane = onDropObject
    ? (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setDropping(false);
      }
    : undefined;
  const onDropPane = onDropObject
    ? (e: DragEvent) => {
        setDropping(false);
        if (!takes(e)) return;
        e.preventDefault();
        onDropObject(e.dataTransfer, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      }
    : undefined;

  return (
    <div
      ref={rootRef}
      className={["diagram-canvas", fast && "is-fast", dropping && "is-drop-target"].filter(Boolean).join(" ")}
      // The canvas takes focus so Shift+1, Ctrl+Plus and Ctrl+Minus work on it.
      tabIndex={0}
      onKeyDownCapture={(e) => {
        // React Flow moves a focused card 5 px (20 with Shift) on any arrow, whatever modifier is held, inside its own
        // store: the key never reaches it, so the card drawn and the card kept never part (N1). The canvas's nudge
        // (1 px, Shift 16 px) or the owner's takes the key instead.
        if (isTyping(e.target) || !(e.key in ARROWS) || !(e.target as Element).closest?.(".react-flow__node, .react-flow__nodesselection")) return;
        e.stopPropagation();
        if (props.ownerNudges) props.onArrowKey?.(e);
        else nudge(e);
      }}
      onKeyDown={onKeyDown}
      onMouseDownCapture={onPortPress}
      onKeyUp={(e) => {
        if (e.key in ARROWS) endNudge();
      }}
      onBlur={() => endNudge()}
      onDoubleClick={
        onPaneDoubleClick &&
        ((e) => {
          const t = e.target as Element;
          // The pane holds the viewport, so a double-click on a card, a line or a field over them is not the pane's.
          if (!t.closest?.(".react-flow__pane") || t.closest(".react-flow__node, .react-flow__edge, .react-flow__edgelabel-renderer, .inline-edit-wrap, .flow-hot")) return;
          onPaneDoubleClick({ screen: { x: e.clientX, y: e.clientY }, flow: screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
        })
      }
      onDragOver={onDragOverPane}
      onDragLeave={onDragLeavePane}
      onDrop={onDropPane}
    >
      <EdgeMarkers hexes={hexArrows} />
      <DetailContext.Provider value={detailValue}>
      <ZoomTargetsContext.Provider value={zoomTargets}>
        <ConnectableContext.Provider value={connectable}>
          <ReactFlow
            onInit={initFlow}
            onMoveStart={onMoveStart}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={allEdgeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStart={onDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onDragStop}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            connectionMode={connectionMode === "loose" ? ConnectionMode.Loose : ConnectionMode.Strict}
            // Removal goes through the client's model (its own Delete); Backspace never drops a card here.
            deleteKeyCode={null}
            onSelectionChange={onSelect && !controlled ? onSelectionChange : undefined}
            onEdgesChange={linesControlled ? onEdgesChange : undefined}
            // Shift or Ctrl + click adds a card or line to the selection (draw.io, Figma, Miro); a drag on empty canvas still draws a box.
            multiSelectionKeyCode={MULTI_SELECT_KEYS}
            // The Hand moves the view, never a shape: a press on a shape pans too.
            nodesDraggable={!readOnly && !props.hand}
            nodesConnectable={connectable}
            onlyRenderVisibleElements
            connectionLineComponent={connectionLineComponent}
            onEdgeDoubleClick={onEdgeDoubleClick && ((_, edge) => onEdgeDoubleClick(edge.id))}
            onNodeDoubleClick={onNodeDoubleClick && ((e, node) => onNodeDoubleClick(node.id, e.target))}
            zoomOnDoubleClick={!onPaneDoubleClick && !boxSelect}
            onPaneContextMenu={onContextMenu && ((e) => menuAt(e, null))}
            onNodeContextMenu={onContextMenu && ((e, node) => menuAt(e, node.id))}
            onEdgeContextMenu={onContextMenu && ((e, edge) => menuAt(e, null, edge.id))}
            onSelectionContextMenu={onContextMenu && ((e) => menuAt(e, null, null, true))}
            {...(boxSelect ? { selectionOnDrag: !props.hand, selectionMode: SelectionMode.Partial, panOnDrag: props.hand ? [0, 1] : [1], panOnScroll: true } : props.hand ? { panOnDrag: [0, 1] } : {})}
            {...(props.panKey !== undefined ? { panActivationKeyCode: props.panKey } : {})}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            zIndexMode={props.zIndexMode}
            proOptions={{ hideAttribution: true }}
          >
            <ViewControls nodes={props.nodes} fitRef={fitRef} glideView={glideView} map={props.mapSlot ? { on: mapOn, toggle: () => setMapOn((v) => !v) } : undefined} />
            <ZoomVar targets={zoomTargets} />
            <SnapGrid />
            <GuideLayer store={guideStore} />
            <ColumnDrag onDragOver={onDragOver} onDragCancel={onDragCancel} cancelled={cancelled} />
            {props.showMiniMap !== false && (
              <MiniMap
                pannable
                zoomable
                ariaLabel="Overview"
                style={{ width: 200, height: 140 }}
                onClick={minimapJump ? (_, at) => void glideView({ center: at, zoom: getZoom() }) : undefined}
              />
            )}
            {props.mapSlot && mapOn && props.mapSlot}
            {overlay}
          </ReactFlow>
        </ConnectableContext.Provider>
      </ZoomTargetsContext.Provider>
      </DetailContext.Provider>
      {children}
    </div>
  );
}

export default function DiagramCanvas(props: DiagramCanvasProps) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
}
