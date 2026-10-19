// Step 12, item 19: the shapes of the newer diagram kinds on the engine's canvas (frame DiagramElements). Each
// is a node type with the shared shell (selection ring, ports, levels of detail) and its own inside: ER and class
// cards with their rows, state pills and markers, sequence participants with their lifelines, mind map topics,
// timeline items and notes. The lines of these kinds are here too: sequence messages along their rows and the
// curved branches of a mind map.
import { BaseEdge, type EdgeProps, EdgeLabelRenderer, type NodeProps, useInternalNode } from "@xyflow/react";
import { memo } from "react";
import Icon from "../components/Icon";
import type { DrawnKind } from "../diagram/types";
import { isMethod, KIND_ROW, SEQ_HEAD, SEQ_ROW } from "./kindLayout";
import { type NodeLook, NodeShell, type NodeState } from "./nodes/parts";

/** What a step 12 node carries on the canvas. */
export type KindNodeData = {
  name: string;
  kind: DrawnKind;
  look: NodeLook;
  rows?: string[];
  text?: string;
  depth?: number;
  date?: string;
  until?: string;
  /** Item 21: resized on the canvas. */
  sized?: { w: number; h: number };
  /** A participant's activation bars, by message row. */
  activations?: { from: number; to: number }[];
  state?: NodeState;
};

/** The shape in words, for its accessible name ("Entity customers", "State Draft"). */
export const KIND_WORD: Partial<Record<DrawnKind, string>> = {
  document: "Document",
  database: "Database",
  erTable: "Entity",
  erWeak: "Weak entity",
  participant: "Participant",
  actor: "Actor",
  state: "State",
  choice: "Choice",
  fork: "Fork",
  stateStart: "Start",
  stateEnd: "End",
  class: "Class",
  interface: "Interface",
  enum: "Enum",
  root: "Central idea",
  topic: "Topic",
  event: "Event",
  period: "Period",
  milestone: "Milestone",
  note: "Note",
};

/** An ER entity's columns: the name in Code small, then its type in the type colour. */
function ErRows({ rows }: { rows: string[] }) {
  return (
    <ul className="fkind-rows">
      {rows.map((r, i) => {
        const at = r.search(/\s/);
        const col = at < 0 ? r : r.slice(0, at);
        const type = at < 0 ? "" : r.slice(at + 1).trim();
        return (
          <li key={`${i}:${r}`} className="fkind-row" style={{ height: KIND_ROW }}>
            {i === 0 && <Icon name="key" size={14} className="fkind-key" />}
            <span className="fkind-col">{col}</span>
            {type && <span className="fkind-type">{type}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** A class card's parts: fields, then methods (members with brackets); an enum lists its values. */
function ClassParts({ kind, rows }: { kind: DrawnKind; rows: string[] }) {
  const fields = kind === "enum" ? rows : rows.filter((r) => !isMethod(r));
  const methods = kind === "enum" ? [] : rows.filter(isMethod);
  const part = (list: string[], key: string) => (
    <ul className="fkind-rows fkind-part" key={key}>
      {list.map((r, i) => (
        <li key={`${i}:${r}`} className="fkind-row" style={{ height: KIND_ROW }}>
          <span className="fkind-col">{r}</span>
        </li>
      ))}
    </ul>
  );
  return kind === "enum" ? part(fields, "values") : [part(fields, "fields"), part(methods, "methods")];
}

function KindInside({ d }: { d: KindNodeData }) {
  const rows = d.rows ?? [];
  switch (d.kind) {
    case "erTable":
    case "erWeak":
      return (
        <>
          <span className="fkind-head">
            <Icon name="table" size={14} />
            <span className="fnode-name">{d.name}</span>
          </span>
          <ErRows rows={rows} />
        </>
      );
    case "class":
    case "interface":
    case "enum":
      return (
        <>
          <span className="fkind-head fkind-head-class">
            {d.kind !== "class" && <span className="fkind-stereotype">{`«${d.kind}»`}</span>}
            <span className="fnode-name">{d.name}</span>
          </span>
          <ClassParts kind={d.kind} rows={rows} />
        </>
      );
    case "participant":
    case "actor":
      return (
        <>
          <span className="fkind-head fkind-lifehead">
            {d.kind === "actor" && <Icon name="user" size={14} />}
            <span className="fnode-name">{d.name}</span>
          </span>
          <i className="fkind-lifeline" aria-hidden="true" />
          {(d.activations ?? []).map((a, i) => (
            <i
              key={i}
              className="fkind-activation"
              aria-hidden="true"
              style={{ top: SEQ_HEAD + a.from * SEQ_ROW + 6, height: Math.max(1, a.to - a.from + 1) * SEQ_ROW - 12 }}
            />
          ))}
        </>
      );
    case "stateStart":
    case "stateEnd":
    case "fork":
      return null;
    case "choice":
      return <span className="fnode-name fkind-choice-name">{d.name}</span>;
    case "event":
    case "period":
    case "milestone":
      return (
        <span className="fkind-time">
          <span className="fkind-date">{d.kind === "milestone" ? "Milestone" : d.until ? `${d.date} to ${d.until}` : d.date}</span>
          <span className="fnode-name">{d.name}</span>
        </span>
      );
    case "note":
      return <span className="fkind-note">{d.text ?? d.name}</span>;
    case "document":
    case "database":
      return (
        <span className="fnode-text">
          <Icon name={d.kind === "database" ? "database" : "fileQuery"} size={14} />
          <span className="fnode-name">{d.name}</span>
        </span>
      );
    default:
      return <span className="fnode-name">{d.name}</span>;
  }
}

/** A step 12 shape. The ports come from the caller's handles; the shell draws the ring and detail levels. */
export function KindNode({ d, selected }: { d: KindNodeData; selected: boolean }) {
  const word = KIND_WORD[d.kind] ?? "Node";
  const label = d.kind === "stateStart" || d.kind === "stateEnd" ? word : `${word} ${d.name}`;
  const depth = d.kind === "topic" ? ` fkind-depth-${Math.min(d.depth ?? 1, 3)}` : "";
  return (
    <NodeShell kind={d.kind} family="kind" look={d.look} selected={selected} name={d.name} state={d.state} sized={d.sized} label={label}>
      <span className={`fkind-inside${depth}`}>
        <KindInside d={d} />
      </span>
    </NodeShell>
  );
}

/** A sequence frame (`loop retry 3 times { ... }`): a box over its rows with its label in a tab. */
export const SeqFrame = memo(function SeqFrame({ data }: NodeProps) {
  const d = data as { label: string; depth: number };
  return (
    <div className="fkind-frame" role="group" aria-label={`Frame ${d.label}`}>
      <span className="fkind-frame-tab">{d.label}</span>
    </div>
  );
});

/** A timeline's line with a tick where each item meets it. */
export const TimeAxis = memo(function TimeAxis({ data }: NodeProps) {
  const d = data as { ticks: { x: number; above: boolean; milestone: boolean }[] };
  return (
    <div className="fkind-axis" aria-hidden="true">
      {d.ticks.map((t, i) => (
        <i key={i} className={t.milestone ? "fkind-tick is-milestone" : "fkind-tick"} style={{ left: t.x }} data-above={t.above || undefined} />
      ))}
    </div>
  );
});

/** A timeline section: a quiet band behind its items, named at the top. */
export const TimeSection = memo(function TimeSection({ data }: NodeProps) {
  const d = data as { name: string };
  return (
    <div className="fkind-section" role="group" aria-label={`Section ${d.name}`}>
      <span className="fkind-section-name">{d.name}</span>
    </div>
  );
});

export type SeqEdgeData = { row: number; label?: string; reply: boolean };

/** A sequence message: a straight line from lifeline to lifeline along its row; a message to itself loops out right. */
export const SeqEdge = memo(function SeqEdge(p: EdgeProps) {
  const a = useInternalNode(p.source);
  const b = useInternalNode(p.target);
  if (!a || !b) return null;
  const d = p.data as SeqEdgeData;
  const w = (n: typeof a) => n.measured.width ?? n.width ?? n.initialWidth ?? 0;
  const x1 = a.internals.positionAbsolute.x + w(a) / 2;
  const x2 = b.internals.positionAbsolute.x + w(b) / 2;
  const y = a.internals.positionAbsolute.y + SEQ_HEAD + (d.row + 0.5) * SEQ_ROW;
  const self = p.source === p.target;
  const path = self ? `M ${x1} ${y - 8} H ${x1 + 40} V ${y + 8} H ${x1}` : `M ${x1} ${y} H ${x2}`;
  const mid = self ? { x: x1 + 48, y: y - 8 } : { x: (x1 + x2) / 2, y: y - 10 };
  return (
    <>
      <BaseEdge id={p.id} path={path} markerEnd={p.markerEnd} style={p.style} interactionWidth={p.interactionWidth} />
      {d.label && (
        <EdgeLabelRenderer>
          <div
            className={self ? "fkind-msg nodrag nopan is-self" : "fkind-msg nodrag nopan"}
            style={{ transform: `translate(${self ? "0" : "-50%"}, -100%) translate(${mid.x}px, ${mid.y}px)` }}
          >
            {d.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

/** A mind map branch: a curve from the side of the parent that faces the child, with no arrow. */
export const MindEdge = memo(function MindEdge(p: EdgeProps) {
  const a = useInternalNode(p.source);
  const b = useInternalNode(p.target);
  if (!a || !b) return null;
  const box = (n: typeof a) => ({
    x: n.internals.positionAbsolute.x,
    y: n.internals.positionAbsolute.y,
    w: n.measured.width ?? n.width ?? n.initialWidth ?? 0,
    h: n.measured.height ?? n.height ?? n.initialHeight ?? 0,
  });
  const s = box(a);
  const t = box(b);
  const right = t.x + t.w / 2 >= s.x + s.w / 2;
  const x1 = right ? s.x + s.w : s.x;
  const x2 = right ? t.x : t.x + t.w;
  const y1 = s.y + s.h / 2;
  const y2 = t.y + t.h / 2;
  const mx = (x1 + x2) / 2;
  return <BaseEdge id={p.id} path={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} style={p.style} interactionWidth={p.interactionWidth} />;
});
