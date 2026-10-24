// Step 12, item 19: the shapes of the newer diagram kinds on the engine's canvas (frame DiagramElements). Each
// is a node type with the shared shell (selection ring, ports, levels of detail) and its own inside: ER and class
// cards with their rows, state pills and markers, sequence participants with their lifelines, mind map topics,
// timeline items and notes. The lines of these kinds are here too: sequence messages along their rows and the
// curved branches of a mind map.
import { BaseEdge, type EdgeProps, EdgeLabelRenderer, Handle, type NodeProps, Position, useInternalNode, useNodeId, useUpdateNodeInternals } from "@xyflow/react";
import { type MouseEvent, memo, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import Icon from "../components/Icon";
import type { DrawnKind } from "../diagram/types";
import { ER_CARD_CHROME, ER_MAX_ROWS, isMethod, KIND_ROW, SEQ_HEAD, SEQ_ROW } from "./kindLayout";
import { type NodeLook, NodeShell, type NodeState } from "./nodes/parts";
import { ErCanvasContext, type ErEdit, splitRow } from "./erCanvas";
import InlineEdit from "./interactions/InlineEdit";
import { ConnectableContext } from "../diagram/CardFrame";
import { COLUMN_PORT } from "./erRelate";
import { ErScrollContext, useErSole } from "./erScroll";
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

/**
 * An ER table card (ER build A, board ER interactions): the header, then one row per column with its key gutter,
 * name, type and not-null mark. With the canvas's editing context each part is edited in place; without it (a
 * preview) the card only draws.
 */
/**
 * ER build C: a column's two side ports, as draw.io's connection points on a table row. A drag from one draws a
 * relationship from this column. Only a hovered or selected table has them, so 2,000 cards at rest add no handles.
 */
const ColumnPorts = memo(function ColumnPorts({ column }: { column: string }) {
  return (
    <>
      <Handle type="source" id={`${COLUMN_PORT}${column}:l`} position={Position.Left} className="fkind-port nodrag nopan" data-side="l" />
      <Handle type="source" id={`${COLUMN_PORT}${column}:r`} position={Position.Right} className="fkind-port nodrag nopan" data-side="r" />
    </>
  );
});

/**
 * Tells the canvas the card's ports came or went, so a drag can start from them and end on them; and, while they
 * show, measures them again once a frame when the rows scroll under them, so no drag uses a port's old place (I6).
 */
function PortsSync({ table }: { table: string }) {
  const id = useNodeId();
  const update = useUpdateNodeInternals();
  const scroll = useContext(ErScrollContext);
  useEffect(() => {
    if (id) update(id);
    let frame = 0;
    const off = scroll?.subscribe(table, () => {
      if (frame || !id) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update(id);
      });
    });
    return () => {
      off?.();
      cancelAnimationFrame(frame);
      if (id) update(id);
    };
  }, [id, update, scroll, table]);
  return null;
}

/** How long the ports stay after the pointer leaves the card, so moving from the header to a row keeps them. */
const PORTS_LINGER_MS = 150;

function ErCard({ d, selected }: { d: KindNodeData; selected: boolean }) {
  const er = useContext(ErCanvasContext);
  const connectable = useContext(ConnectableContext);
  const rows = d.rows ?? [];
  const edit = er?.edit && er.edit.table === d.name ? er.edit : null;
  // A table whose column lines the writer cannot write (a dotted or quoted name) is edited in the text.
  const why = er && !er.readOnly ? er.blocked(d.name) : null;
  const live = !!er && !er.readOnly && !why;
  const named = !!er && !er.readOnly;
  const at = edit?.kind === "draft" ? Math.min(edit.at, rows.length) : -1;
  const shown: ({ i: number; name: string; type: string; flags: readonly ColumnFlag[] } | null)[] = rows.map((r, i) => ({ i, ...splitRow(r), flags: d.rowFlags?.[i] ?? [] }));
  if (at >= 0) shown.splice(at, 0, null);
  const field = (e: ErEdit, value: string, label: string, cls: string, placeholder?: string, list?: string) => (
    <InlineEdit
      key={`${e.kind}:${e.kind === "table" ? "" : e.kind === "col" ? e.index : e.at}:${e.kind === "table" ? "name" : e.field}`}
      value={value}
      label={label}
      className={cls}
      placeholder={placeholder}
      list={list}
      error={e.error}
      errorKey={e.tries}
      onCommit={(v, how) => er!.commit(e, v, how)}
      onCancel={() => er!.cancel(e)}
    />
  );
  // A double-click on text edits that text; on the card's empty space it adds a column there (decision 2).
  const dbl = (fn: () => void) => (ev: MouseEvent) => {
    ev.stopPropagation();
    if (live) fn();
  };
  // The card's tips are titles, drawn by the app's one tooltip (tooltipGuard): it takes each title off while the
  // pointer is on it, so the system's window never draws, and hides it while a button is held, a port's drag
  // included (fix round 2, live bug (b)). A header name has one only when it is cut off (M13).
  const nameRef = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = nameRef.current;
    setCut(!!el && el.scrollWidth > el.clientWidth);
  }, [d.name, d.sized?.w, d.naturalW, edit?.kind]);
  // The ports show while the pointer is over the card or the table is selected (draw.io).
  const [hot, setHot] = useState(false);
  const cool = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(cool.current), []);
  const enter = () => {
    clearTimeout(cool.current);
    setHot(true);
  };
  const leave = () => {
    clearTimeout(cool.current);
    cool.current = setTimeout(() => setHot(false), PORTS_LINGER_MS);
  };
  // Hovered, or the one table selected alone (fix round 2, I5): a selection of many shows no ports.
  const sole = useErSole(d.name);
  const ports = live && connectable && (hot || (selected && sole));
  // Lines to its rows follow the rows as they scroll (fix round 1); a card that goes takes its scroll with it.
  const scroll = useContext(ErScrollContext);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // A card drawn again under a new name (a rename) takes up the scroll it had (M8).
    const top = scroll?.get(d.name) ?? 0;
    if (top > 0 && bodyRef.current) bodyRef.current.scrollTop = top;
    return () => scroll?.set(d.name, 0);
  }, [scroll, d.name]);
  return (
    <>
      {ports && <PortsSync table={d.name} />}
      <span
        // A header aimed by "Make a relationship from here" stands for its table's key (fix round 3).
        className={er?.aim?.table === d.name && er.aim.index === -1 ? "fkind-head is-pick" : "fkind-head"}
        aria-current={er?.aim?.table === d.name && er.aim.index === -1 ? true : undefined}
        onPointerEnter={enter}
        onPointerLeave={leave}
        onPointerDown={(ev) => {
          er?.pickTable(d.name, ev.ctrlKey || ev.metaKey || ev.shiftKey);
        }}
        onDoubleClick={(ev) => {
          ev.stopPropagation();
          if (named) er!.editTable(d.name);
        }}
      >
        <Icon name="table" size={14} />
        {edit?.kind === "table" ? (
          field(edit, d.name, "Table name", "fkind-ed fkind-ed-head")
        ) : (
          <span ref={nameRef} className="fnode-name" title={cut ? d.name : undefined} aria-description={d.name}>
            {d.name}
          </span>
        )}
      </span>
      <div
        // Rows that scroll take the wheel (I3); a card that fits lets the canvas pan, as draw.io and Figma do.
        className={shown.length > (d.sized ? Math.floor((d.sized.h - ER_CARD_CHROME) / KIND_ROW) : ER_MAX_ROWS) ? "fkind-er-body nowheel is-scroll" : "fkind-er-body"}
        onPointerEnter={enter}
        onPointerLeave={leave}
        ref={bodyRef}
        onScroll={(ev) => scroll?.set(d.name, ev.currentTarget.scrollTop)}
        onDoubleClick={(ev) => {
          ev.stopPropagation();
          if (live && !(ev.target as Element).closest(".fkind-er-row")) er!.addColumn(d.name);
        }}
        onPointerDown={(ev) => {
          if (!(ev.target as Element).closest(".fkind-er-row")) er?.pickTable(d.name, ev.ctrlKey || ev.metaKey || ev.shiftKey);
        }}
      >
        <ul className="fkind-rows fkind-er-rows">
          {shown.map((c) => {
            if (c === null && edit?.kind === "draft") {
              return (
                <li key="new" className="fkind-row fkind-er-row is-new" style={{ height: KIND_ROW }}>
                  <span className="fkind-gut" aria-hidden="true" />
                  {edit.field === "name" ? field(edit, edit.name, "Column name", "fkind-ed", "column_name") : <span className="fkind-col">{edit.name}</span>}
                  {edit.field === "type" ? field(edit, edit.type, "Column type", "fkind-ed fkind-ed-type", "type", "er-types") : <span className="fkind-type">{edit.type}</span>}
                  <span className="fkind-nn" aria-hidden="true" />
                </li>
              );
            }
            if (!c) return null;
            const pk = c.flags.includes("pk");
            const nn = pk || c.flags.includes("not null");
            const editing = edit?.kind === "col" && edit.index === c.i ? edit : null;
            const picked = er?.selected?.table === d.name && er.selected.index === c.i;
            // The column the keyboard is on while "Make a relationship from here" picks (fix round 2, I1).
            const aimed = er?.aim?.table === d.name && er.aim.index === c.i;
            // Said by the card's tip and, for a screen reader, as the row's description (M13).
            const rowTip = `${c.name}${c.type ? ` ${c.type}` : ""} (${[pk ? "primary key" : "", c.flags.includes("unique") && !pk ? "unique" : "", nn ? "not null" : "nullable"].filter(Boolean).join(", ")})`;
            const gutTip = why ?? (pk ? "Primary key. Click to remove" : "Click to make it the primary key");
            return (
              <li
                key={`${c.i}:${c.name}`}
                className={`fkind-row fkind-er-row${picked ? " is-selected" : ""}${aimed ? " is-pick" : ""}`}
                aria-current={aimed ? true : undefined}
                style={{ height: KIND_ROW }}
                title={rowTip}
                aria-description={rowTip}
                onClick={() => er?.selectColumn(d.name, c.i)}
                onContextMenu={() => er?.pointColumn(d.name, c.i)}
                onDoubleClick={dbl(() => er!.editColumn(d.name, c.i, "name"))}
              >
                <button
                  type="button"
                  className={`fkind-gut nodrag${pk ? " is-pk" : ""}`}
                  aria-label="Primary key"
                  aria-pressed={pk}
                  disabled={!live}
                  title={gutTip}
                  aria-description={gutTip}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    if (live) er!.toggleFlag(d.name, c.i, "pk");
                  }}
                  onDoubleClick={(ev) => ev.stopPropagation()}
                >
                  {pk && <Icon name="key" size={14} className="fkind-key" />}
                </button>
                {editing?.field === "name" ? (
                  field(editing, c.name, "Column name", "fkind-ed", "column_name")
                ) : (
                  <span className="fkind-col" onDoubleClick={dbl(() => er!.editColumn(d.name, c.i, "name"))}>
                    {c.name}
                  </span>
                )}
                {editing?.field === "type" ? (
                  field(editing, c.type, "Column type", "fkind-ed fkind-ed-type", "type", "er-types")
                ) : (
                  <span className="fkind-type" onDoubleClick={dbl(() => er!.editColumn(d.name, c.i, "type"))}>
                    {c.type}
                  </span>
                )}
                <span className={nn ? "fkind-nn is-nn" : "fkind-nn"} title={nn ? "Not null" : "Nullable"} aria-description={nn ? "Not null" : "Nullable"} />
                {ports && <ColumnPorts column={c.name} />}
              </li>
            );
          })}
        </ul>
      </div>
      {live && (
        <button type="button" className="fkind-addcol nodrag" aria-label="Add column"
          onClick={() => er!.addColumn(d.name)} onDoubleClick={(ev) => ev.stopPropagation()}>
          <Icon name="plus" size={14} />
          column
        </button>
      )}
    </>
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

function KindInside({ d, selected }: { d: KindNodeData; selected: boolean }) {
  const rows = d.rows ?? [];
  switch (d.kind) {
    case "erTable":
    case "erWeak":
      return (
        <ErCard d={d} selected={selected} />
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
        <KindInside d={d} selected={selected} />
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
