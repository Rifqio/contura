// A flowchart node: start and end are neutral pills, step and subprocess are the step family,
// io is a slanted step with a link icon when it names a table, and the decision is the one amber diamond.
// Flowcharts have no textbook variant, so both looks draw the same shapes.
import Icon from "../../components/Icon";
import { type NodeBaseProps, NodeShell } from "./parts";

export type FlowchartNodeKind = "start" | "end" | "step" | "decision" | "io" | "subprocess";

const WORDS: Record<FlowchartNodeKind, string> = {
  start: "Start",
  end: "End",
  step: "Step",
  decision: "Decision",
  io: "Input or output",
  subprocess: "Subprocess",
};

export interface FlowchartNodeProps extends NodeBaseProps {
  kind: FlowchartNodeKind;
  /** `schema.table` on an io node. */
  table?: string;
}

export default function FlowchartNode({ kind, name, id, table, style, selected, state, sized, color }: FlowchartNodeProps) {
  return (
    <NodeShell kind={kind} family="flowchart" look={style} selected={selected} name={name} state={state} sized={sized} color={color} label={`${WORDS[kind]} ${name}`}>
      <span className="fnode-text">
        {kind === "io" && table && <Icon name="link" size={14} className="fnode-link" />}
        <span className="fnode-name">{name}</span>
        {id && <span className="fnode-id">{id}</span>}
      </span>
    </NodeShell>
  );
}
