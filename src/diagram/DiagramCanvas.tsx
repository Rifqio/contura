// The diagram engine's canvas: React Flow with the fixed config every diagram shares (A1).
import "@xyflow/react/dist/style.css";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  type Edge,
  type EdgeTypes,
  MiniMap,
  type Node,
  type NodeTypes,
  type OnConnectEnd,
  Panel,
  ReactFlow,
  type ReactFlowInstance,
  ReactFlowProvider,
  getViewportForBounds,
  useConnection,
  useNodesState,
  useReactFlow,
  useStore,
  useStoreApi,
} from "@xyflow/react";
import { type DragEvent, type KeyboardEvent, type MutableRefObject, type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import Icon from "../components/Icon";
import { ConnectableContext } from "./CardFrame";
import { DetailContext, GRID_FROM, detailFor } from "./detail";
import { EdgeMarkers, OrthogonalEdge, StraightEdge } from "./edges";
import { CARD_WIDTH } from "./metrics";
import type { Port } from "./types";

export type PortRef = { nodeId: string; column: string };
export type DragOverPorts = { from: PortRef; over: PortRef | null };

export interface DiagramCanvasProps {
  nodes: Node[];
  edges: Edge[];
  nodeTypes: NodeTypes;
  edgeTypes?: EdgeTypes;
  /** Cards can be selected but not moved or connected. */
  readOnly?: boolean;
  /** A drag from one column port dropped on another; `from` is the source side, `shift` held at the drop. */
  onConnectPorts?(from: Port, to: Port, shift: boolean): void;
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
  /** A card was dropped after a drag (once per card of a multi-card drag). */
  onMove?(id: string, x: number, y: number): void;
  /** Every frame of a card drag, for clients whose edges follow the cards live. */
  onDrag?(id: string, x: number, y: number): void;
  onSelect?(ids: string[]): void;
  /** Something dragged in from outside the canvas (the database tree) was dropped at a flow position. */
  onDropObject?(data: DataTransfer, at: { x: number; y: number }): void;
  onInit?(instance: ReactFlowInstance): void;
  /** Toolbar overlays and banners, drawn over the canvas. */
  children?: ReactNode;
}

/** Refit this long after the last window resize. */
const RESIZE_REFIT_MS = 150;
const MIN_ZOOM = 0.1;
/** The minor and major snap grid (DESIGN-NEXT 10.6). */
const GRID = 16;
const GRID_MAJOR = 80;

/** The column a port handle id names: `{column}:{side}`, side being s, t, sl or tr. */
export function columnOfHandle(handleId: string | null | undefined): string {
  if (!handleId) return "";
  const at = handleId.lastIndexOf(":");
  return at < 0 ? handleId : handleId.slice(0, at);
}

const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Fits the view once, as soon as the pane has a size, and again after a window resize. Every node
 * carries its size up front (initialWidth, initialHeight), so this does not wait for React Flow to
 * measure: with onlyRenderVisibleElements the off-screen nodes are never measured, and a wait would
 * never end. The fit never zooms past 100 percent. Also draws the zoom control: minus, the percent,
 * plus and fit.
 */
function ViewControls({ nodes, fitRef }: { nodes: Node[]; fitRef: MutableRefObject<() => boolean> }) {
  const store = useStoreApi();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const ready = useStore((s) => s.panZoom !== null);
  const zoom = useStore((s) => s.transform[2]);
  const { setViewport, zoomIn, zoomOut } = useReactFlow();
  const fitted = useRef(false);

  const fit = useCallback(() => {
    const { width: w, height: h, minZoom, maxZoom, panZoom } = store.getState();
    if (!panZoom || !w || !h || nodes.length === 0) return false;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      x0 = Math.min(x0, n.position.x);
      y0 = Math.min(y0, n.position.y);
      x1 = Math.max(x1, n.position.x + (n.initialWidth ?? CARD_WIDTH));
      y1 = Math.max(y1, n.position.y + (n.initialHeight ?? 0));
    }
    const viewport = getViewportForBounds({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, w, h, minZoom, Math.min(1, maxZoom), 0.1);
    void setViewport(viewport, { duration: reducedMotion() ? 0 : 240 });
    return true;
  }, [nodes, store, setViewport]);

  fitRef.current = fit;

  useEffect(() => {
    if (fitted.current || !ready || !width || !height) return;
    if (fit()) fitted.current = true;
  }, [ready, width, height, fit]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fitRef.current(), RESIZE_REFIT_MS);
    };
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, [fitRef]);

  return (
    <Panel position="bottom-right" className="canvas-zoom" role="group" aria-label="Zoom">
      <button type="button" className="icon-button" aria-label="Zoom out" title="Zoom out" onClick={() => void zoomOut({ duration: 150 })}>
        <Icon name="minus" size={14} />
      </button>
      <span className="canvas-zoom-percent">{Math.round(zoom * 100)}%</span>
      <button type="button" className="icon-button" aria-label="Zoom in" title="Zoom in" onClick={() => void zoomIn({ duration: 150 })}>
        <Icon name="plus" size={14} />
      </button>
      <span className="canvas-zoom-divider" aria-hidden="true" />
      <button type="button" className="icon-button" aria-label="Fit to view" title="Fit to view (Shift+1)" onClick={() => fit()}>
        <Icon name="fit" size={14} />
      </button>
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

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");

function Flow(props: DiagramCanvasProps) {
  const { readOnly, onConnectPorts, onDragOver, onDragCancel, connectionMode, onMove, onDrag, onSelect, onDropObject, onInit, nodeTypes, edgeTypes, children } = props;
  const fast = detailFor(1, props.nodes.length).fast;
  const detail = useStore((s) => detailFor(s.transform[2], props.nodes.length).detail);
  const detailValue = useMemo(() => ({ detail, fast }), [detail, fast]);
  const connectable = !readOnly && !fast && !!onConnectPorts;
  const { zoomIn, zoomOut, screenToFlowPosition } = useReactFlow();
  const fitRef = useRef<() => boolean>(() => false);

  const [nodes, setNodes, onNodesChange] = useNodesState(props.nodes);
  // New nodes keep what is selected: an edit made on a card must not drop its outline.
  useEffect(
    () =>
      setNodes((prev) => {
        const picked = new Set(prev.filter((p) => p.selected).map((p) => p.id));
        return props.nodes.map((n) => ({ ...n, selected: picked.has(n.id) || undefined }));
      }),
    [props.nodes, setNodes],
  );

  // Zoomed out the column ports are gone: edges end on the box sides; fast mode draws them straight.
  const edges = useMemo(
    () =>
      detail === "full" && !fast
        ? props.edges
        : props.edges.map((e) => ({ ...e, sourceHandle: null, targetHandle: null, ...(fast ? { type: "straight" } : {}) })),
    [props.edges, detail, fast],
  );
  const allEdgeTypes = useMemo<EdgeTypes>(() => ({ orthogonal: OrthogonalEdge, straight: StraightEdge, ...edgeTypes }), [edgeTypes]);

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
      if (!onConnectPorts || !state.isValid || !state.fromHandle || !state.toHandle) return;
      const a = { node: state.fromHandle.nodeId, port: columnOfHandle(state.fromHandle.id) };
      const b = { node: state.toHandle.nodeId, port: columnOfHandle(state.toHandle.id) };
      const [from, to] = state.fromHandle.type === "target" ? [b, a] : [a, b];
      onConnectPorts(from, to, event.shiftKey);
    },
    [onConnectPorts],
  );

  const onKeyDown = (e: KeyboardEvent) => {
    if (isTyping(e.target)) return;
    if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && (e.code === "Digit1" || e.key === "!" || e.key === "1")) {
      e.preventDefault();
      fitRef.current();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "=" || e.code === "NumpadAdd")) {
      e.preventDefault();
      void zoomIn({ duration: 150 });
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "-" || e.code === "NumpadSubtract")) {
      e.preventDefault();
      void zoomOut({ duration: 150 });
    }
  };

  // The DOM dragover of a drop from outside (the tree), not the `onDragOver` prop of a column drag.
  const onDragOverPane = onDropObject
    ? (e: DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    : undefined;
  const onDropPane = onDropObject
    ? (e: DragEvent) => {
        e.preventDefault();
        onDropObject(e.dataTransfer, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      }
    : undefined;

  return (
    <div
      className={fast ? "diagram-canvas is-fast" : "diagram-canvas"}
      // The canvas takes focus so Shift+1, Ctrl+Plus and Ctrl+Minus work on it.
      tabIndex={0}
      onKeyDown={onKeyDown}
      onDragOver={onDragOverPane}
      onDrop={onDropPane}
    >
      <EdgeMarkers />
      <DetailContext.Provider value={detailValue}>
        <ConnectableContext.Provider value={connectable}>
          <ReactFlow
            onInit={onInit}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={allEdgeTypes}
            onNodesChange={onNodesChange}
            onNodeDrag={onDrag && ((_, _node, dragged) => dragged.forEach((n) => onDrag(n.id, n.position.x, n.position.y)))}
            onNodeDragStop={onMove && ((_, _node, dragged) => dragged.forEach((n) => onMove(n.id, n.position.x, n.position.y)))}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            connectionMode={connectionMode === "loose" ? ConnectionMode.Loose : ConnectionMode.Strict}
            // Removal goes through the client's model (its own Delete); Backspace never drops a card here.
            deleteKeyCode={null}
            onSelectionChange={onSelect && (({ nodes: picked }) => onSelect(picked.map((n) => n.id)))}
            nodesDraggable={!readOnly}
            nodesConnectable={connectable}
            snapToGrid={!readOnly}
            snapGrid={[GRID, GRID]}
            onlyRenderVisibleElements
            minZoom={MIN_ZOOM}
            proOptions={{ hideAttribution: true }}
          >
            <ViewControls nodes={props.nodes} fitRef={fitRef} />
            <SnapGrid />
            <ColumnDrag onDragOver={onDragOver} onDragCancel={onDragCancel} cancelled={cancelled} />
            <MiniMap pannable zoomable ariaLabel="Overview" style={{ width: 200, height: 140 }} />
          </ReactFlow>
        </ConnectableContext.Provider>
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
