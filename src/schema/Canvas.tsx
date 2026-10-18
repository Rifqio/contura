import type { Connection, Edge, Node, ReactFlowInstance } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "../components/Icon";
import { useToast } from "../components/Toast";
import type { SchemaModel, SmEndpoint } from "../api/types";
import { addRef, addTable, fkTargetWarning } from "../lang/dbml/edits";
import { tableKey } from "../lang/protocol";
import { MANY_MARKER, ONE_MARKER } from "./EdgeMarkers";
import DiagramCanvas from "../diagram/DiagramCanvas";
import type { LayoutRequest, Positions } from "../diagram/layout";
import { CARD_WIDTH, cardHeight } from "../diagram/metrics";
import type { Port } from "../diagram/types";
import { autoLayout, type Layout } from "./layout";
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
  /** Runs a layout; the language worker's when the Builder has a client, in-process when absent. */
  runLayout?: (r: LayoutRequest) => Promise<Positions>;
  /** Opens the Publish image dialog with the part of the diagram on screen, in canvas units; absent, Publish is off. */
  onPublish?: (onScreen: { x: number; y: number; w: number; h: number }) => void;
}

const nodeTypes = { table: TableCard };

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
      // Same shape as the engine's `orthogonal` type (8 px corners); kept as smoothstep for this client's tests. New clients use `orthogonal`.
      type: "smoothstep",
      pathOptions: { borderRadius: 8 },
      markerStart: MANY_MARKER,
      markerEnd: ONE_MARKER,
    };
  });
}

/** The sides of every Ref's edge as one string, from each card's left edge. */
function sidesKeyFor(model: SchemaModel, xs: Map<string, number>): string {
  return model.refs
    .map((r) => {
      const a = xs.get(tableKey({ schema: r.from.schema, name: r.from.table })) ?? 0;
      const b = xs.get(tableKey({ schema: r.to.schema, name: r.to.table })) ?? CARD_WIDTH;
      const sides = edgeSides(a, b);
      return `${sides.source}${sides.target}`;
    })
    .join(",");
}

/** The schema a table without one parses to: Postgres models default to "public" (Ruling R4). */
const newTableSchema = (model: SchemaModel) => (model.dialect === "postgres" ? "public" : null);

export default function Canvas({ model, layout, blocked, errorAt, onLayout, onEdit, onGoToError, onSelectionChange, onShowText, ask, runLayout, onPublish }: Props) {
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

  // Each card's left edge: from the layout, and live while cards are dragged, so an edge changes
  // sides as one card passes another. Edges are rebuilt only when a side changes, not every frame.
  const baseX = useMemo(() => new Map(initial.map((n) => [n.id, n.position.x])), [initial]);
  const liveX = useRef(new Map<string, number>());
  const [dragSides, setDragSides] = useState<string | null>(null);
  useEffect(() => {
    liveX.current = new Map(baseX);
    setDragSides(null);
  }, [baseX]);
  const sidesKey = dragSides ?? sidesKeyFor(model, baseX);
  // The positions are left out on purpose: sidesKey changes when an edge's sides do.
  const edges = useMemo(() => edgesFor(model, (k) => (dragSides === null ? baseX : liveX.current).get(k)), [model, sidesKey]);
  const onDrag = useCallback(
    (id: string, x: number) => {
      liveX.current.set(id, x);
      setDragSides(sidesKeyFor(model, liveX.current));
    },
    [model],
  );

  // A multi-card drag reports each card in turn: each move builds on the one before.
  const latestLayout = useRef(layout);
  latestLayout.current = layout;
  const onMove = useCallback(
    (id: string, x: number, y: number) => {
      const next = { ...latestLayout.current, tables: { ...latestLayout.current.tables, [id]: { x, y } } };
      latestLayout.current = next;
      onLayout(next);
    },
    [onLayout],
  );

  const onConnectPorts = useCallback(
    (from: Port, to: Port) => {
      const ref = refFromConnection(model, { source: from.node, sourceHandle: `${from.port}:s`, target: to.node, targetHandle: `${to.port}:t` });
      if (!ref) return;
      onEdit((text, ranges) => addRef(text, ranges, ref.from, ref.to));
      if (ref.warning) show({ kind: "info", text: ref.warning });
    },
    [model, onEdit, show],
  );

  const onSelect = useCallback(
    (keys: string[]) => setSelected((was) => (was.length === keys.length && was.every((k, i) => k === keys[i]) ? was : keys)),
    [],
  );

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

  /** The canvas box in canvas units; the cards' frame before the canvas has been measured. */
  function onScreen() {
    const box = flowRef.current?.getBoundingClientRect();
    const f = flow.current;
    if (box && f && box.width > 0 && box.height > 0) {
      const a = f.screenToFlowPosition({ x: box.x, y: box.y });
      const b = f.screenToFlowPosition({ x: box.x + box.width, y: box.y + box.height });
      return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
    }
    const xs = initial.map((n) => n.position.x);
    const ys = initial.map((n) => n.position.y);
    if (xs.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) + CARD_WIDTH - x, h: Math.max(...initial.map((n) => n.position.y + (n.initialHeight ?? 0))) - y };
  }

  /**
   * Lays every card out again, the ones already placed included. A worker that fails (gone, or
   * answering `failed`) gives way to the in-process layout; if that fails too, the cards stay and a toast says so.
   */
  async function arrange() {
    const fresh = { ...layout, tables: {} };
    try {
      onLayout(await autoLayout(model, fresh, runLayout));
    } catch {
      try {
        onLayout(await autoLayout(model, fresh));
      } catch (e) {
        show({ kind: "error", text: `Arrange did not finish: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }

  return (
    <div className="schema-canvas">
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
        <button type="button" className="button button-small button-quiet" disabled={!onPublish} onClick={() => onPublish?.(onScreen())}>
          <Icon name="image" size={14} />
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
        <DiagramCanvas
          nodes={initial}
          edges={edges}
          nodeTypes={nodeTypes}
          onInit={(instance) => {
            flow.current = instance;
          }}
          onMove={onMove}
          onDrag={onDrag}
          onConnectPorts={blocked ? undefined : onConnectPorts}
          onSelect={onSelect}
        />
      </div>
    </div>
  );
}
