// The Mermaid dialog's Diagram tab: the converted flow, read only, laid out by the language worker.
import type { Edge, Node } from "@xyflow/react";
import { useEffect, useState } from "react";
import DiagramCanvas from "../diagram/DiagramCanvas";
import { ARROW_MARKER } from "../diagram/edges";
import type { Positions } from "../diagram/layout";
import type { LangClient } from "../lang/client";
import type { FlowGroup } from "./flowModel";
import { FLOW_NODE_TYPES, type FlowNodeData, flowNodeSize } from "./FlowShapes";
import type { MermaidResult } from "./mermaid";

interface Props {
  result: MermaidResult | null;
  lang: LangClient;
}

/** Room around a group's nodes, and above them for its name. */
const GROUP_PAD = 16;
const GROUP_TOP = 28;

type Box = { x: number; y: number; w: number; h: number };

/** Where nodes go when the layout worker fails: one row, or one column top to bottom. */
function fallback(result: MermaidResult): Positions {
  const out: Positions = {};
  let at = 0;
  for (const n of result.doc.nodes) {
    const s = flowNodeSize(n);
    out[n.name] = result.direction === "LR" ? { x: at, y: 0 } : { x: 0, y: at };
    at += (result.direction === "LR" ? s.w : s.h) + 60;
  }
  return out;
}

/** The group boxes, outermost first, each around its nodes and its inner groups. */
function groupNodes(groups: FlowGroup[], placed: Map<string, Box>): Node[] {
  const out: Node[] = [];
  const walk = (g: FlowGroup, path: string): Box | null => {
    const inner = g.groups.map((c, i) => walk(c, `${path}/${i}`)).filter((b): b is Box => b !== null);
    const boxes = [...g.nodes.map((n) => placed.get(n)).filter((b): b is Box => !!b), ...inner];
    if (boxes.length === 0) return null;
    const x0 = Math.min(...boxes.map((b) => b.x)) - GROUP_PAD;
    const y0 = Math.min(...boxes.map((b) => b.y)) - GROUP_TOP;
    const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + GROUP_PAD;
    const y1 = Math.max(...boxes.map((b) => b.y + b.h)) + GROUP_PAD;
    const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    out.unshift({
      id: `group:${path}`,
      type: "group",
      position: { x: box.x, y: box.y },
      initialWidth: box.w,
      initialHeight: box.h,
      style: { width: box.w, height: box.h },
      data: { name: g.name },
      selectable: false,
      zIndex: -1,
    });
    return box;
  };
  groups.forEach((g, i) => walk(g, String(i)));
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
    const sizes = new Map(result.doc.nodes.map((n) => [n.name, flowNodeSize(n)]));
    const request = {
      nodes: result.doc.nodes.map((n) => ({ id: n.name, ...sizes.get(n.name)! })),
      edges: result.doc.links.filter((l) => sizes.has(l.from) && sizes.has(l.to)).map((l) => ({ from: l.from, to: l.to })),
      existing: {},
      rankdir: result.direction,
    };
    const draw = (positions: Positions) => {
      if (!live) return;
      const placed = new Map<string, Box>();
      const nodes: Node[] = result.doc.nodes.map((n) => {
        const s = sizes.get(n.name)!;
        const p = positions[n.name] ?? { x: 0, y: 0 };
        placed.set(n.name, { ...p, ...s });
        const data: FlowNodeData = { name: n.name, kind: n.kind, icon: n.icon, direction: result.direction };
        return { id: n.name, type: n.kind, position: p, initialWidth: s.w, initialHeight: s.h, style: { width: s.w, height: s.h }, data };
      });
      const edges: Edge[] = result.doc.links
        .filter((l) => placed.has(l.from) && placed.has(l.to))
        .map((l, i) => ({
          id: `link:${i}`,
          source: l.from,
          target: l.to,
          type: "orthogonal",
          className: l.arrow === "-->" ? "flow-link flow-link-dashed" : "flow-link",
          markerEnd: l.arrow === "-" ? undefined : ARROW_MARKER,
          markerStart: l.arrow === "<>" ? ARROW_MARKER : undefined,
          data: l.label ? { badge: <span className="flow-link-label">{l.label}</span> } : undefined,
        }));
      // A node or group added or removed fits the view again; typing inside a name keeps the view.
      const key = `${result.doc.nodes.length}:${result.doc.groups.length}`;
      setDrawn({ nodes: [...groupNodes(result.doc.groups, placed), ...nodes], edges, key });
    };
    lang.layout(request).then(draw, () => draw(fallback(result)));
    return () => {
      live = false;
    };
  }, [result, lang]);

  return (
    <div className="flow-preview" role="group" aria-label="Diagram preview">
      <DiagramCanvas key={drawn.key} nodes={drawn.nodes} edges={drawn.edges} nodeTypes={FLOW_NODE_TYPES} readOnly />
    </div>
  );
}
