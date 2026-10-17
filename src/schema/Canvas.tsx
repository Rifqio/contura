import "@xyflow/react/dist/style.css";
import {
  Background,
  BackgroundVariant,
  type Connection,
  type Edge,
  MiniMap,
  type Node,
  Panel,
  ReactFlow,
  type ReactFlowInstance,
  getViewportForBounds,
  useNodesState,
  useReactFlow,
  useStore,
  useStoreApi,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "../components/Icon";
import { useToast } from "../components/Toast";
import type { SchemaModel, SmEndpoint } from "../api/types";
import { addRef, addTable, fkTargetWarning } from "../lang/dbml/edits";
import { tableKey } from "../lang/protocol";
import EdgeMarkers, { MANY_MARKER, ONE_MARKER } from "./EdgeMarkers";
import { autoLayout, CARD_WIDTH, cardHeight, type Layout } from "./layout";
import type { AskContext, AskKit } from "../assistant/context";
import TableCard, { type MakeEdits, type TableCardData } from "./TableCard";

interface Props {
  model: SchemaModel;
  layout: Layout;
  /** True while the DBML has a syntax error: the canvas shows the last valid model, read only. */
  blocked: boolean;
  errorAt?: { line: number; message: string };
  onLayout: (l: Layout) => void;
  onEdit: (make: MakeEdits) => void;
  onGoToError: () => void;
  /** The tables selected on the canvas, as table keys; the Builder bands their blocks in the DBML. */
  onSelectionChange?: (keys: string[]) => void;
  /** Set while the DBML pane is hidden: the toolbar then offers Show DBML. */
  onShowText?: () => void;
  /** The DBML text and name the table cards ask about; absent, the cards have no Ask AI. */
  ask?: { getDbml(): string; label: string; kit: AskKit; connection?: AskContext["connection"] };
}

const nodeTypes = { table: TableCard };

/** Refit this long after the last window resize. */
const RESIZE_REFIT_MS = 150;

/**
 * Fits the view once, as soon as the pane has a size, and again after a window resize. Every
 * card has a known size up front (CARD_WIDTH, cardHeight), so this does not wait for React Flow to
 * measure the cards: with onlyRenderVisibleElements the off-screen cards are never measured, and a
 * wait would never end. Also draws the zoom control: minus, the percent, plus and fit.
 */
function ViewControls({ nodes }: { nodes: Node[] }) {
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
    const viewport = getViewportForBounds({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, w, h, minZoom, maxZoom, 0.1);
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    void setViewport(viewport, { duration: reduced ? 0 : 240 });
    return true;
  }, [nodes, store, setViewport]);

  const latestFit = useRef(fit);
  latestFit.current = fit;

  useEffect(() => {
    if (fitted.current || !ready || !width || !height) return;
    if (fit()) fitted.current = true;
  }, [ready, width, height, fit]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => latestFit.current(), RESIZE_REFIT_MS);
    };
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, []);

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
      <button type="button" className="icon-button" aria-label="Fit to view" title="Fit to view" onClick={() => fit()}>
        <Icon name="fit" size={14} />
      </button>
    </Panel>
  );
}

/** A dropped connection as a Foreign Key: the source column is the many side. */
export function refFromConnection(
  model: SchemaModel,
  c: Pick<Connection, "source" | "target" | "sourceHandle" | "targetHandle">,
): { from: SmEndpoint; to: SmEndpoint; warning: string | null } | null {
  const find = (key: string | null) => model.tables.find((t) => tableKey(t) === key);
  const from = find(c.source);
  const to = find(c.target);
  const fromCol = c.sourceHandle?.replace(/:s$/, "");
  const toCol = c.targetHandle?.replace(/:t$/, "");
  if (!from || !to || !fromCol || !toCol) return null;
  const toEnd = { schema: to.schema, table: to.name, columns: [toCol] };
  return {
    from: { schema: from.schema, table: from.name, columns: [fromCol] },
    to: toEnd,
    warning: fkTargetWarning(model, toEnd),
  };
}

export type EdgeSides = { source: "left" | "right"; target: "left" | "right" };

/**
 * The sides an edge leaves and enters by, from the two cards' left edges: each end uses the side
 * facing the other card, so no edge loops round the far side of a card. Cards that overlap
 * across (one above the other) both use their right side.
 */
export function edgeSides(sourceX: number, targetX: number, width = CARD_WIDTH): EdgeSides {
  if (sourceX + width <= targetX) return { source: "right", target: "left" };
  if (targetX + width <= sourceX) return { source: "left", target: "right" };
  return { source: "right", target: "right" };
}

/**
 * One orthogonal edge per Ref: the Foreign Key column is the many side, the column it points at the
 * one side. `xOf` gives a card's left edge, so each edge picks its sides (edgeSides).
 */
export function edgesFor(model: SchemaModel, xOf: (key: string) => number | undefined = () => undefined): Edge[] {
  return model.refs.map((r, i) => {
    const source = tableKey({ schema: r.from.schema, name: r.from.table });
    const target = tableKey({ schema: r.to.schema, name: r.to.table });
    const sides = edgeSides(xOf(source) ?? 0, xOf(target) ?? CARD_WIDTH);
    return {
      id: `ref-${i}`,
      source,
      sourceHandle: `${r.from.columns[0]}:${sides.source === "right" ? "s" : "sl"}`,
      target,
      targetHandle: `${r.to.columns[0]}:${sides.target === "left" ? "t" : "tr"}`,
      type: "smoothstep",
      pathOptions: { borderRadius: 8 },
      markerStart: MANY_MARKER,
      markerEnd: ONE_MARKER,
    };
  });
}

/** The schema a table without one parses to: Postgres models default to "public" (Ruling R4). */
const newTableSchema = (model: SchemaModel) => (model.dialect === "postgres" ? "public" : null);

export default function Canvas({ model, layout, blocked, errorAt, onLayout, onEdit, onGoToError, onSelectionChange, onShowText, ask }: Props) {
  const { show } = useToast();
  const flow = useRef<ReactFlowInstance | null>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const selectionRef = useRef(onSelectionChange);
  selectionRef.current = onSelectionChange;
  useEffect(() => selectionRef.current?.(selected), [selected]);

  const initial = useMemo<Node[]>(() => {
    const fk = new Map<string, string[]>();
    for (const r of model.refs) {
      const k = tableKey({ schema: r.from.schema, name: r.from.table });
      fk.set(k, [...(fk.get(k) ?? []), ...r.from.columns]);
    }
    return model.tables.map((t, i) => {
      const key = tableKey(t);
      const data: TableCardData = {
        table: t,
        tableKey: key,
        dialect: model.dialect,
        fkColumns: fk.get(key) ?? [],
        blocked,
        onEdit,
        ask: ask && { ...ask, tables: model.tables.map((x) => ({ schema: x.schema, name: x.name })) },
      };
      return {
        id: key,
        type: "table",
        position: layout.tables[key] ?? { x: (i % 4) * 300, y: Math.floor(i / 4) * 320 },
        // A size before the first measure, so culling and the first paint work without layout.
        initialWidth: CARD_WIDTH,
        initialHeight: cardHeight(t.columns.length),
        data,
      };
    });
  }, [model, layout, blocked, onEdit, ask]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initial);
  // A new model keeps what is selected: an edit made on a card must not drop its outline.
  useEffect(
    () => setNodes((prev) => initial.map((n) => ({ ...n, selected: prev.find((p) => p.id === n.id)?.selected }))),
    [initial, setNodes],
  );

  // Recomputed only when a side changes, not on every drag frame.
  const xs = new Map(nodes.map((n) => [n.id, n.position.x]));
  const sidesKey = model.refs
    .map((r) => {
      const a = xs.get(tableKey({ schema: r.from.schema, name: r.from.table })) ?? 0;
      const b = xs.get(tableKey({ schema: r.to.schema, name: r.to.table })) ?? CARD_WIDTH;
      const sides = edgeSides(a, b);
      return `${sides.source}${sides.target}`;
    })
    .join(",");
  // `xs` is left out on purpose: it changes on every drag frame, and sidesKey changes when an edge's sides do.
  const edges = useMemo(() => edgesFor(model, (k) => xs.get(k)), [model, sidesKey]);

  const addNewTable = () => {
    const used = new Set(model.tables.map((t) => t.name));
    let name = "new_table";
    for (let n = 2; used.has(name); n++) name = `new_table_${n}`;
    // Place the card where the user is looking, not at the next grid slot, which may be out of view.
    const box = flowRef.current?.getBoundingClientRect();
    const center = box && flow.current?.screenToFlowPosition({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    const at = center ? { x: center.x - CARD_WIDTH / 2, y: center.y - cardHeight(1) / 2 } : { x: 0, y: 0 };
    onLayout({ ...layout, tables: { ...layout.tables, [tableKey({ schema: newTableSchema(model), name })]: at } });
    onEdit((text) => addTable(text, name));
  };

  const selectedName = model.tables.find((t) => tableKey(t) === selected[0])?.name;

  /** Lays every card out again, the ones already placed included. */
  async function arrange() {
    onLayout(await autoLayout(model, { ...layout, tables: {} }));
  }

  return (
    <div className="schema-canvas">
      <EdgeMarkers />
      <div className="canvas-toolbar" role="toolbar" aria-label="Canvas">
        {onShowText && (
          <>
            <button type="button" className="button button-small button-quiet" onClick={onShowText}>
              Show DBML
            </button>
            <span className="canvas-toolbar-divider" aria-hidden="true" />
          </>
        )}
        <button type="button" className="button button-small button-quiet button-on" aria-pressed="true">
          <Icon name="select" size={14} />
          Select
        </button>
        <button type="button" className="button button-small button-quiet" disabled={blocked} onClick={addNewTable}>
          <Icon name="table" size={14} />
          Add table
        </button>
        <button type="button" className="button button-small button-quiet" disabled={blocked || model.tables.length === 0} onClick={() => void arrange()}>
          <Icon name="arrange" size={14} />
          Arrange
        </button>
        <span className="canvas-toolbar-divider" aria-hidden="true" />
        {selected.length > 0 && (
          <span className="canvas-toolbar-note">{selected.length === 1 ? `${selectedName} selected` : `${selected.length} tables selected`}</span>
        )}
        <span className="spacer" />
        <button type="button" className="button button-small button-quiet" disabled>
          <Icon name="export" size={14} />
          Publish
        </button>
        <span title="Arrives with Schema Compare">
          <button type="button" className="button button-small" disabled>
            <Icon name="database" size={14} />
            Apply to Connection...
          </button>
        </span>
      </div>
      {blocked && errorAt && (
        <div className="canvas-banner" role="alert">
          <span>
            The DBML has an error on line {errorAt.line}: {errorAt.message}. The canvas shows the last valid version.
          </span>
          <button type="button" className="button button-small" onClick={onGoToError}>
            Go to error
          </button>
        </div>
      )}
      <div className="canvas-flow" ref={flowRef}>
        <ReactFlow
          onInit={(instance) => {
            flow.current = instance;
          }}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={(_, node) =>
            onLayout({ ...layout, tables: { ...layout.tables, [node.id]: { x: node.position.x, y: node.position.y } } })
          }
          onConnect={(c) => {
            if (blocked) return;
            const ref = refFromConnection(model, c);
            if (!ref) return;
            onEdit((text, ranges) => addRef(text, ranges, ref.from, ref.to));
            if (ref.warning) show({ kind: "info", text: ref.warning });
          }}
          onSelectionChange={({ nodes: picked }) => {
            const keys = picked.map((n) => n.id);
            setSelected((was) => (was.length === keys.length && was.every((k, i) => k === keys[i]) ? was : keys));
          }}
          nodesConnectable={!blocked}
          onlyRenderVisibleElements
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
        >
          <ViewControls nodes={initial} />
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
          <MiniMap pannable zoomable ariaLabel="Overview" style={{ width: 200, height: 140 }} />
        </ReactFlow>
      </div>
    </div>
  );
}
