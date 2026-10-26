// Step 12, item 19: the shapes of the newer diagram kinds on the engine's canvas (frame DiagramElements). Each
// is a node type with the shared shell (selection ring, ports, levels of detail) and its own inside: ER and class
// cards with their rows, state pills and markers, sequence participants with their lifelines, mind map topics,
// timeline items and notes. The lines of these kinds are here too: sequence messages along their rows and the
// curved branches of a mind map.
import { BaseEdge, type EdgeProps, EdgeLabelRenderer, type NodeProps, useInternalNode } from "@xyflow/react";
import { memo, useContext, useLayoutEffect, useRef, useState } from "react";
import Icon from "../components/Icon";
import type { DrawnKind } from "../diagram/types";
import { ER_CARD_CHROME, ER_MAX_ROWS, isMethod, KIND_ROW, SEQ_HEAD, SEQ_ROW } from "./kindLayout";
import { type NodeLook, NodeShell, type NodeState, type ShapeColour } from "./nodes/parts";
import InlineEdit from "./interactions/InlineEdit";
import DateEdit from "./interactions/DateEdit";
import { type KindEdit, KindEditContext, useKindEdit } from "./kindEdit";
import type { ColumnFlag } from "../lang/flow/model";

/** What a step 12 node carries on the canvas. */
export type KindNodeData = {
  name: string;
  kind: DrawnKind;
  look: NodeLook;
  /** The size its kind and words lay it out at, before any resize (plain numbers, so equal data stays equal). */
  naturalW?: number;
  naturalH?: number;
  rows?: string[];
  /** An ER table's column flags, one list per row. */
  rowFlags?: ColumnFlag[][];
  text?: string;
  depth?: number;
  date?: string;
  until?: string;
  /** Item 21: resized on the canvas. */
  sized?: { w: number; h: number };
  /** A participant's activation bars, by message row. */
  activations?: { top: number; height: number }[];
  state?: NodeState;
  /** Step 11: the words it shows (its `label:`) when they are not its name, and its palette colour. */
  shows?: string;
  color?: ShapeColour;
};

/** The words a shape shows: its label, else its name. */
const wordsOf = (d: KindNodeData) => d.shows ?? d.name;

/** The shape in words, for its accessible name ("Table orders", "State Draft"). */
export const KIND_WORD: Partial<Record<DrawnKind, string>> = {
  document: "Document",
  database: "Database",
  erTable: "Table",
  erWeak: "Weak table",
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

/** An ER column row's name and type: "customer_id int" is customer_id and int; a row with no type has none. */
function splitRow(row: string): { name: string; type: string } {
  const at = row.search(/\s/);
  return at < 0 ? { name: row, type: "" } : { name: row.slice(0, at), type: row.slice(at + 1).trim() };
}

/**
 * An ER table card, draw-only for now: the header, then one row per column with its key gutter, name, type and
 * not-null mark. Past 20 columns, or more than a card resized smaller holds, the rows scroll inside it.
 */
function ErCard({ d }: { d: KindNodeData }) {
  const rows = d.rows ?? [];
  const words = wordsOf(d);
  // A header name has a tip, the app's hover hint, only when it is cut off (M13).
  const nameRef = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = nameRef.current;
    setCut(!!el && el.scrollWidth > el.clientWidth);
  }, [words, d.sized?.w, d.naturalW]);
  const fits = d.sized ? Math.floor((d.sized.h - ER_CARD_CHROME) / KIND_ROW) : ER_MAX_ROWS;
  return (
    <>
      <span className="fkind-head">
        <Icon name="table" size={14} />
        <span ref={nameRef} className="fnode-name" title={cut ? words : undefined}>
          {words}
        </span>
      </span>
      {/* Rows that scroll take the wheel (I3); a card that fits lets the canvas pan, as draw.io and Figma do. */}
      <div className={rows.length > fits ? "fkind-er-body nowheel is-scroll" : "fkind-er-body"}>
        <ul className="fkind-rows fkind-er-rows">
          {rows.map((r, i) => {
            const { name, type } = splitRow(r);
            const flags = d.rowFlags?.[i] ?? [];
            const pk = flags.includes("pk");
            const nn = pk || flags.includes("not null");
            // The row's hover hint, which is also its one accessible description (M13).
            const tip = `${name}${type ? ` ${type}` : ""} (${[pk ? "primary key" : "", flags.includes("unique") && !pk ? "unique" : "", nn ? "not null" : "nullable"].filter(Boolean).join(", ")})`;
            return (
              <li key={`${i}:${name}`} className="fkind-row fkind-er-row" style={{ height: KIND_ROW }} title={tip}>
                <span className={pk ? "fkind-gut is-pk" : "fkind-gut"} aria-hidden="true">
                  {pk && <Icon name="key" size={14} className="fkind-key" />}
                </span>
                <span className="fkind-col">{name}</span>
                <span className="fkind-type">{type}</span>
                <span className={nn ? "fkind-nn is-nn" : "fkind-nn"} aria-hidden="true" />
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

/**
 * A class card's parts: fields, then methods (members with brackets); an enum lists its values. CL1: each row is
 * edited in place, and a new row is drawn where it will go (board DiagramEditInPlace).
 */
function ClassParts({ name, kind, rows }: { name: string; kind: DrawnKind; rows: string[] }) {
  const ctx = useContext(KindEditContext);
  const edit = useKindEdit(name);
  const indexed = rows.map((r, i) => ({ r, i }));
  const fields = kind === "enum" ? indexed : indexed.filter((x) => !isMethod(x.r));
  const methods = kind === "enum" ? [] : indexed.filter((x) => isMethod(x.r));
  const field = (e: KindEdit, value: string) => (
    <InlineEdit
      key={`${e.kind}:${e.kind === "member" ? e.index : e.kind === "draft" ? e.at : ""}`}
      value={value}
      label="Member"
      placeholder="+ name: type"
      className="fkind-ed fkind-ed-member"
      fresh={e.kind === "draft"}
      error={e.error ?? null}
      errorKey={e.tries}
      onCommit={(v, how) => ctx!.api.commitMember(e, v, how)}
      onCancel={() => ctx!.api.cancel(e)}
    />
  );
  // A new row shows at the end of the part it will most likely join: the fields, or an enum's values.
  const draft = edit?.kind === "draft" ? edit : null;
  const part = (list: { r: string; i: number }[], key: string, withDraft: boolean) => (
    <ul className="fkind-rows fkind-part" key={key}>
      {list.map(({ r, i }) => (
        <li
          key={`${i}:${r}`}
          className={edit?.kind === "picked" && edit.index === i ? "fkind-row is-picked" : "fkind-row"}
          aria-selected={edit?.kind === "picked" && edit.index === i ? true : undefined}
          style={{ height: KIND_ROW }}
          data-row={i}
        >
          {edit?.kind === "member" && edit.index === i ? field(edit, r) : <span className="fkind-col">{r}</span>}
        </li>
      ))}
      {withDraft && draft && (
        <li key="draft" className="fkind-row is-new" style={{ height: KIND_ROW }}>
          {field(draft, draft.value ?? "")}
        </li>
      )}
    </ul>
  );
  return kind === "enum" ? part(fields, "values", true) : [part(fields, "fields", true), part(methods, "methods", false)];
}

function KindInside({ d }: { d: KindNodeData }) {
  const rows = d.rows ?? [];
  switch (d.kind) {
    case "erTable":
    case "erWeak":
      return <ErCard d={d} />;
    case "class":
    case "interface":
    case "enum":
      return (
        <>
          <span className="fkind-head fkind-head-class">
            {d.kind !== "class" && <span className="fkind-stereotype">{`«${d.kind}»`}</span>}
            <span className="fnode-name">{d.name}</span>
          </span>
          <ClassParts name={d.name} kind={d.kind} rows={rows} />
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
              style={{ top: a.top, height: a.height }}
            />
          ))}
        </>
      );
    case "stateStart":
    case "stateEnd":
    case "fork":
      return null;
    case "choice":
      return <span className="fnode-name fkind-choice-name">{wordsOf(d)}</span>;
    case "event":
    case "period":
    case "milestone":
      return <TimeInside d={d} />;
    case "note":
      return <span className="fkind-note">{d.text ?? d.name}</span>;
    case "document":
    case "database":
      return (
        <span className="fnode-text">
          <Icon name={d.kind === "database" ? "database" : "fileQuery"} size={14} />
          <span className="fnode-name">{wordsOf(d)}</span>
        </span>
      );
    default:
      return <span className="fnode-name">{wordsOf(d)}</span>;
  }
}

/** A timeline item: its date (a date field while T1 edits it, board DiagramEditInPlace), then its name. */
function TimeInside({ d }: { d: KindNodeData }) {
  const ctx = useContext(KindEditContext);
  const edit = useKindEdit(d.name);
  return (
    <span className="fkind-time">
      {edit?.kind === "date" && d.kind !== "milestone" ? (
        <DateEdit
          date={edit.date ?? d.date ?? ""}
          until={d.kind === "period" ? (edit.until ?? d.until ?? "") : undefined}
          error={edit.error ?? null}
          errorKey={edit.tries}
          errorAt={edit.errorAt}
          onCommit={(date, until, how) => ctx!.api.commitDate(edit, date, until, how)}
          onCancel={() => ctx!.api.cancel(edit)}
        />
      ) : (
        <span className="fkind-date" data-part="date">
          {d.kind === "milestone" ? "Milestone" : d.until ? `${d.date} to ${d.until}` : d.date}
        </span>
      )}
      <span className="fnode-name">{d.name}</span>
    </span>
  );
}

/** A step 12 shape. The ports come from the caller's handles; the shell draws the ring and detail levels. */
export function KindNode({ d, selected }: { d: KindNodeData; selected: boolean }) {
  const word = KIND_WORD[d.kind] ?? "Node";
  const label = d.kind === "stateStart" || d.kind === "stateEnd" ? word : `${word} ${wordsOf(d)}`;
  const depth = d.kind === "topic" ? ` fkind-depth-${Math.min(d.depth ?? 1, 3)}` : "";
  return (
    <NodeShell kind={d.kind} family="kind" look={d.look} selected={selected} name={wordsOf(d)} state={d.state} sized={d.sized} color={d.color} label={label}>
      <span className={`fkind-inside${depth}`}>
        <KindInside d={d} />
      </span>
    </NodeShell>
  );
}

/** A sequence frame (`loop retry 3 times { ... }`): a box over its rows; its label is the SeqFrameTab above it. */
export const SeqFrame = memo(function SeqFrame({ data }: NodeProps) {
  const d = data as { label: string; depth: number };
  return <div className="fkind-frame" role="group" aria-label={`Frame ${d.label}`} />;
});

/** A frame's label in its tab, drawn over the participants so their lifelines and activation bars pass under it. */
export const SeqFrameTab = memo(function SeqFrameTab({ data }: NodeProps) {
  const d = data as { label: string };
  return (
    <span className="fkind-frame-tab" aria-hidden="true">
      {d.label}
    </span>
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

export type SeqEdgeData = { row: number; y?: number; label?: string; reply: boolean };

/** A sequence message: a straight line from lifeline to lifeline along its row; a message to itself loops out right. */
export const SeqEdge = memo(function SeqEdge(p: EdgeProps) {
  const a = useInternalNode(p.source);
  const b = useInternalNode(p.target);
  if (!a || !b) return null;
  const d = p.data as SeqEdgeData;
  const w = (n: typeof a) => n.measured.width ?? n.width ?? n.initialWidth ?? 0;
  const x1 = a.internals.positionAbsolute.x + w(a) / 2;
  const x2 = b.internals.positionAbsolute.x + w(b) / 2;
  const y = a.internals.positionAbsolute.y + (d.y ?? SEQ_HEAD + (d.row + 0.5) * SEQ_ROW);
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
