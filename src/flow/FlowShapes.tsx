// The .flow node shapes on the engine's canvas: step, decision (diamond), start and end (pill), io
// (parallelogram), subprocess (double border), and the group around its nodes. Colours are tokens only
// (ADR 0008), by ruling D23 with frame 7.3 winning where it shows other existing tokens.
import { Handle, type NodeProps, type NodeTypes, Position } from "@xyflow/react";
import type { CSSProperties } from "react";
import Icon from "../components/Icon";
import { useDetail } from "../diagram/detail";
import type { FlowKind, FlowNode } from "./flowModel";

export type FlowNodeData = { name: string; kind: FlowKind; icon?: string; direction: "TB" | "LR" };
export type FlowGroupData = { name: string };

/** Fill and stroke token per kind. Frame 7.3 draws the decision in the enum colours, io in the queue colours and a database step in the datastore colours. */
export const FLOW_TOKENS: Record<FlowKind | "database", { fill: string; stroke: string }> = {
  step: { fill: "--c-node-service-fill", stroke: "--c-node-service-stroke" },
  subprocess: { fill: "--c-node-service-fill", stroke: "--c-node-service-stroke" },
  decision: { fill: "--c-node-enum-fill", stroke: "--c-node-enum-stroke" },
  start: { fill: "--c-node-external-fill", stroke: "--c-node-external-stroke" },
  end: { fill: "--c-node-external-fill", stroke: "--c-node-external-stroke" },
  io: { fill: "--c-node-queue-fill", stroke: "--c-node-queue-stroke" },
  database: { fill: "--c-node-datastore-fill", stroke: "--c-node-datastore-stroke" },
};

const KIND_LABEL: Record<FlowKind, string> = {
  start: "Start",
  end: "End",
  step: "Step",
  decision: "Decision",
  io: "Input or output",
  subprocess: "Subprocess",
};

/** The size a node is laid out and drawn at: wide enough for its name, a diamond taller. */
export function flowNodeSize(n: Pick<FlowNode, "name" | "kind" | "icon">): { w: number; h: number } {
  const text = n.name.length * 7 + (n.icon ? 22 : 0);
  if (n.kind === "decision") return { w: Math.min(260, Math.max(96, text + 56)), h: 64 };
  if (n.kind === "io") return { w: Math.min(260, Math.max(96, text + 48)), h: 40 };
  return { w: Math.min(240, Math.max(88, text + 32)), h: 40 };
}

function Anchors({ direction }: { direction: "TB" | "LR" }) {
  const [target, source] = direction === "LR" ? [Position.Left, Position.Right] : [Position.Top, Position.Bottom];
  return (
    <>
      <Handle type="target" position={target} isConnectable={false} className="edge-anchor" />
      <Handle type="source" position={source} isConnectable={false} className="edge-anchor" />
    </>
  );
}

/** One .flow node. Zoomed far out it is a plain block in its stroke colour, as the engine's cards are. */
function FlowShape({ data, selected }: NodeProps) {
  const d = data as FlowNodeData;
  const { detail } = useDetail();
  const tokens = FLOW_TOKENS[d.icon === "database" ? "database" : d.kind];
  const style = { "--flow-fill": `var(${tokens.fill})`, "--flow-stroke": `var(${tokens.stroke})` } as CSSProperties;
  const label = `${KIND_LABEL[d.kind]} ${d.name}`;
  const outline = d.kind === "decision" ? "50,1 99,50 50,99 1,50" : d.kind === "io" ? "12,1 99,1 88,99 1,99" : null;
  return (
    <div
      className={`flow-node flow-node-${d.kind}${detail === "block" ? " flow-node-block" : ""}${selected ? " flow-node-selected" : ""}`}
      role="group"
      aria-label={label}
      style={style}
    >
      {outline && detail !== "block" && (
        <svg className="flow-node-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polygon points={outline} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      {detail !== "block" && (
        <span className="flow-node-name">
          {d.icon === "database" && <Icon name="database" size={14} className="flow-node-icon" />}
          {d.name}
        </span>
      )}
      <Anchors direction={d.direction} />
    </div>
  );
}

/** A group: a dashed box behind its nodes, named at the top left. */
function FlowGroupBox({ data }: NodeProps) {
  const d = data as FlowGroupData;
  return (
    <div className="flow-group" role="group" aria-label={`Group ${d.name}`}>
      <span className="flow-group-name">{d.name}</span>
    </div>
  );
}

export const FLOW_NODE_TYPES = {
  step: FlowShape,
  decision: FlowShape,
  start: FlowShape,
  end: FlowShape,
  io: FlowShape,
  subprocess: FlowShape,
  group: FlowGroupBox,
} satisfies NodeTypes;
