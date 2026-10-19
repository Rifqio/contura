// The Mermaid dialog's Diagram tab: the converted flow, read only, laid out by the language worker and drawn
// with the same nodes and lines as the diagram tab.
import type { Edge, Node } from "@xyflow/react";
import { useEffect, useState } from "react";
import DiagramCanvas from "../diagram/DiagramCanvas";
import type { Positions } from "../diagram/layout";
import type { LangClient } from "../lang/client";
import { buildFlowGraph, FLOW_EDGE_TYPES, FLOW_NODE_TYPES, layoutInput } from "./flowNodes";
import type { MermaidResult } from "./mermaid";

interface Props {
  result: MermaidResult | null;
  lang: LangClient;
}

/** Where nodes go when the layout worker fails: one row, or one column top to bottom. */
function fallback(result: MermaidResult, sizes: { id: string; w: number; h: number }[]): Positions {
  const out: Positions = {};
  let at = 0;
  for (const s of sizes) {
    out[s.id] = result.direction === "LR" ? { x: at, y: 0 } : { x: 0, y: at };
    at += (result.direction === "LR" ? s.w : s.h) + 60;
  }
  return out;
}

export default function FlowPreview({ result, lang }: Props) {
  const [drawn, setDrawn] = useState<{ nodes: Node[]; edges: Edge[]; key: string }>({ nodes: [], edges: [], key: "" });

  useEffect(() => {
    if (!result) {
      setDrawn({ nodes: [], edges: [], key: "" });
      return;
    }
    let live = true;
    const input = layoutInput(result.doc, "modern");
    const draw = (positions: Positions) => {
      if (!live) return;
      const { nodes, edges } = buildFlowGraph(result.doc, positions, "modern");
      // A node or group added or removed fits the view again; typing inside a name keeps the view.
      setDrawn({ nodes, edges, key: `${result.doc.nodes.length}:${result.doc.groups.length}` });
    };
    lang.layout({ ...input, existing: {}, rankdir: result.direction }).then(draw, () => draw(fallback(result, input.nodes)));
    return () => {
      live = false;
    };
  }, [result, lang]);

  return (
    <div className="flow-preview" role="group" aria-label="Diagram preview">
      <DiagramCanvas key={drawn.key} nodes={drawn.nodes} edges={drawn.edges} nodeTypes={FLOW_NODE_TYPES} edgeTypes={FLOW_EDGE_TYPES} readOnly />
    </div>
  );
}
