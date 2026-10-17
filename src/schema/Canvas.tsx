import "@xyflow/react/dist/style.css";
import {
  Background,
  type Connection,
  Controls,
  type Edge,
  type Node,
  ReactFlow,
  type ReactFlowInstance,
  useNodesState,
} from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SchemaModel, SmEndpoint } from "../api/types";
import { addRef, addTable, fkTargetWarning } from "../lang/dbml/edits";
import { tableKey } from "../lang/protocol";
import { CARD_WIDTH, cardHeight, type Layout } from "./layout";
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
  /** The DBML text and name the table cards ask about; absent, the cards have no Ask AI. */
  ask?: { getDbml(): string; label: string; kit: AskKit; connection?: AskContext["connection"] };
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

/** The schema a table without one parses to: Postgres models default to "public" (Ruling R4). */
const newTableSchema = (model: SchemaModel) => (model.dialect === "postgres" ? "public" : null);

export default function Canvas({ model, layout, blocked, errorAt, onLayout, onEdit, onGoToError, ask }: Props) {
  const [warning, setWarning] = useState<string | null>(null);
  const flow = useRef<ReactFlowInstance | null>(null);
  const flowRef = useRef<HTMLDivElement>(null);

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
  useEffect(() => setNodes(initial), [initial, setNodes]);

  const edges = useMemo<Edge[]>(
    () =>
      model.refs.map((r, i) => ({
        id: `ref-${i}`,
        source: tableKey({ schema: r.from.schema, name: r.from.table }),
        sourceHandle: `${r.from.columns[0]}:s`,
        target: tableKey({ schema: r.to.schema, name: r.to.table }),
        targetHandle: `${r.to.columns[0]}:t`,
        type: "smoothstep",
      })),
    [model],
  );

  useEffect(() => {
    if (!warning) return;
    const t = setTimeout(() => setWarning(null), 6000);
    return () => clearTimeout(t);
  }, [warning]);

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

  return (
    <div className="schema-canvas">
      <div className="toolbar canvas-toolbar">
        <button type="button" className="button button-small" disabled={blocked} onClick={addNewTable}>
          Add table
        </button>
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
            if (ref.warning) setWarning(ref.warning);
          }}
          nodesConnectable={!blocked}
          onlyRenderVisibleElements
          fitView
          minZoom={0.1}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {warning && (
        <p className="toast" role="status">
          {warning}
        </p>
      )}
    </div>
  );
}
