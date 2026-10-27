// Step 12, item 19: the shapes of the newer diagram kinds on the engine's canvas (frame DiagramElements). Each
// is a node type with the shared shell (selection ring, ports, levels of detail) and its own inside: ER and class
// cards with their rows, state pills and markers, sequence participants with their lifelines, mind map topics,
// timeline items and notes. The lines of these kinds are here too: sequence messages along their rows and the
// curved branches of a mind map.
import { labelScale } from "./textScale";
import { BaseEdge, type EdgeProps, EdgeLabelRenderer, Handle, type NodeProps, Position, useInternalNode, useNodeId, useUpdateNodeInternals } from "@xyflow/react";
import { type MouseEvent, memo, type ReactNode, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import Icon from "../components/Icon";
import type { DrawnKind } from "../diagram/types";
import { ER_MAX_ROWS, ER_ROW_OVERSCAN, erFits, erRowWindow, erViewH, isMethod, KIND_ROW, SEQ_HEAD, SEQ_ROW } from "./kindLayout";
import { type NodeLook, NodeShell, type NodeState, type ShapeColour } from "./nodes/parts";
import InlineEdit from "./interactions/InlineEdit";
import DateEdit from "./interactions/DateEdit";
import { type KindEdit, KindEditContext, useKindEdit } from "./kindEdit";
import { type ColumnFlag, needsQuotes, splitRow } from "../lang/flow/model";
import { ConnectableContext } from "../diagram/CardFrame";
import { ErCanvasContext, type ErEdit, useErCard, useErLive } from "./erCanvas";
import { COLUMN_PORT } from "./erRelate";
import { ErScrollContext, useErScroll, useErSole } from "./erScroll";

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

/**
 * ER build C: a column's two side ports, as draw.io's connection points on a table row. A drag from one draws a
 * relationship from this column. Only a hovered table or the one table selected alone has them, and only on its drawn
 * rows (decision 7), so 2,000 cards at rest add no handles and a 300-column card at most 44.
 */
const ColumnPorts = memo(function ColumnPorts({ column }: { column: string }) {
  // A pointer's way in: hidden from a screen reader, which reaches the same act through the row's menu (Shift+F10,
  // "Make a relationship from here").
  return (
    <>
      <Handle type="source" id={`${COLUMN_PORT}${column}:l`} position={Position.Left} className="fkind-port nodrag nopan" data-side="l" aria-hidden="true" />
      <Handle type="source" id={`${COLUMN_PORT}${column}:r`} position={Position.Right} className="fkind-port nodrag nopan" data-side="r" aria-hidden="true" />
    </>
  );
});

/**
 * Tells the canvas the card's ports came or went, so a drag can start from them and end on them; and, while they
 * show, measures them again once a frame when the rows scroll under them, so no drag uses a port's old place (I6).
 * Mounted only while the ports show, so its one scroll listener and frame go with them.
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
export const PORTS_LINGER_MS = 150;

/**
 * An ER table card (ER build A, board ER interactions; B3 Task 2): the header, then one row per column with its key
 * gutter, name, type and not-null mark. On the live frame with the canvas's editing context each part is edited in
 * place; without it (a static frame, a preview, Publish) the card only draws, as Plan A's did. Either way it draws
 * only the rows in view (decision 7), with spacers for the rest, so a 300-column table costs 22 rows. The header,
 * name and type carry `data-er-field` and each row `data-er-row`, so the canvas finds the field a double-click on a
 * static card meant by its rect (decision 5). `selected` is for the ports (Task 7): a table selected alone shows them.
 */
function ErCard({ d, selected }: { d: KindNodeData; selected: boolean }) {
  const ctx = useContext(ErCanvasContext);
  const live = useErLive();
  const view = useErCard(d.name);
  const er = live ? (ctx?.api ?? null) : null;
  const rows = d.rows ?? [];
  const words = wordsOf(d);
  const edit = view?.edit ?? null;
  // An old-form frame's cards say why they take no column edits (decision 3).
  const why = er && !er.readOnly ? er.blocked(d.name) : null;
  const editable = !!er && !er.readOnly && !why;
  const named = !!er && !er.readOnly;
  // A column field whose row the text took away under it (an undo, the Assistant) stays open at the end, keyed as its
  // row was, so what was typed is kept and its commit says why (Review Focus 1).
  const lost = edit?.kind === "col" && edit.index >= rows.length ? edit : null;
  const at = edit?.kind === "draft" ? Math.min(edit.at, rows.length) : lost ? rows.length : -1;
  const count = rows.length + (at >= 0 ? 1 : 0);
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
  // An old-form frame's card still hears it, so the strip says why nothing opens (decision 3, Review Focus 4).
  const dbl = (fn: () => void) => (ev: MouseEvent) => {
    ev.stopPropagation();
    if (editable || why) fn();
  };
  // A header name has a tip, the app's hover hint, only when it is cut off (M13).
  const nameRef = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = nameRef.current;
    setCut(!!el && el.scrollWidth > el.clientWidth);
  }, [words, d.sized?.w, d.naturalW, edit?.kind]);
  // The ports show while the pointer is over the card or the table is selected alone (draw.io; fix round 2, I5), on the
  // live frame only (decision 5): a static card hears no pointer and reads no selection. A table whose name needs quotes
  // can end no column relationship, so it shows none (decision 3).
  const connectable = useContext(ConnectableContext);
  const [hot, setHot] = useState(false);
  const cool = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(cool.current), []);
  const enter = er
    ? () => {
        clearTimeout(cool.current);
        setHot(true);
      }
    : undefined;
  const leave = er
    ? () => {
        clearTimeout(cool.current);
        cool.current = setTimeout(() => setHot(false), PORTS_LINGER_MS);
      }
    : undefined;
  const sole = useErSole(er ? d.name : null);
  const ports = editable && connectable && !needsQuotes(d.name) && (hot || (selected && sole));
  // The rows in view (decision 7), as far as the body is scrolled. On the live frame that is the tab's scroll store, which
  // the lines to its rows read too (Task 5); a static card does not scroll (owner answer 1); a card with no store (a
  // preview) keeps its own.
  const scrolls = useContext(ErScrollContext);
  const shared = live && !!scrolls;
  const stored = useErScroll(shared ? d.name : null);
  const [own, setOwn] = useState(0);
  const scroll = !live ? 0 : shared ? stored : own;
  const fits = erFits(d.sized?.h);
  const viewH = erViewH(d.sized?.h);
  const scrolling = live && count > fits;
  const win = erRowWindow(count, viewH, scroll);
  let { from, to } = win;
  // The open field's row is drawn whatever the scroll, so what is typed in it is never unmounted (Review Focus 1); it
  // counts within the 22-row cap, the window giving up its far end for it.
  const editK =
    edit?.kind === "draft" || lost ? at : edit?.kind === "col" ? (at >= 0 && edit.index >= at ? edit.index + 1 : edit.index) : -1;
  const pin = editK >= 0 && editK < count && (editK < from || editK >= to) ? editK : -1;
  if (pin >= 0 && to - from >= ER_MAX_ROWS + 2 * ER_ROW_OVERSCAN) {
    // An overscan row goes first: the one above when the window has one there (3 px of padding above the rows).
    if (from < Math.floor((scroll - 3) / KIND_ROW)) from++;
    else to--;
  }
  const bodyRef = useRef<HTMLDivElement>(null);
  // The body follows the store: a card drawn again (a rename, the end of a tab drag, panned back into view) takes up the
  // scroll kept for it (M8, R26), and a frame switch's `clear` puts it back at its top. The store keeps no top past the
  // card's last row, so a table with fewer rows under the same name starts where its rows allow (as a browser clamps).
  const most = Math.max(0, count * KIND_ROW + 6 - viewH);
  useLayoutEffect(() => {
    if (!shared) return;
    // Clamped in the store, not only here, so the lines to its rows read the same top (wakes this table's few listeners).
    if (stored > most) return scrolls!.set(d.name, most);
    if (bodyRef.current && bodyRef.current.scrollTop !== stored) bodyRef.current.scrollTop = stored;
  }, [shared, scrolls, d.name, most, stored]);
  // A row selected, aimed or opened for edit is scrolled into view at once (decision 7; WAI-ARIA listbox and grid).
  const shownK = (i: number | null | undefined) => (i === null || i === undefined || i < 0 ? -1 : at >= 0 && i >= at ? i + 1 : i);
  const selK = shownK(view?.selected);
  const aimK = shownK(view?.aim);
  useLayoutEffect(() => {
    if (!scrolling || !bodyRef.current) return;
    for (const k of [editK, aimK, selK]) if (k >= 0 && k < count) return scrollRowIntoView(bodyRef.current, k, fits);
    // When one of them moves or the card starts to scroll; a scroll by the wheel leaves the selected row where it put it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editK, aimK, selK, scrolling, fits]);
  const spacer = (key: string, n: number) => n > 0 && <li key={key} className="fkind-er-spacer" aria-hidden="true" style={{ height: n * KIND_ROW }} />;
  const ks: number[] = [];
  for (let k = from; k < to; k++) ks.push(k);
  if (pin >= 0 && pin < from) ks.unshift(pin);
  else if (pin >= 0) ks.push(pin);
  const drawn: ReactNode[] = [];
  // The spacers stand for the rows not drawn: before the first, between the pinned row and the window, after the last.
  drawn.push(spacer("above", pin >= 0 && pin < from ? pin : from));
  for (const k of ks) {
    if (pin >= 0 && pin < from && k === from) drawn.push(spacer("mid", from - pin - 1));
    if (pin >= to && k === pin) drawn.push(spacer("mid", pin - to));
    if (k === at && edit?.kind === "draft") {
      drawn.push(
        <li key="new" className="fkind-row fkind-er-row is-new" style={{ height: KIND_ROW }}>
          <span className="fkind-gut" aria-hidden="true" />
          {edit.field === "name" ? field(edit, edit.name, "Column name", "fkind-ed", "column_name") : <span className="fkind-col">{edit.name}</span>}
          {edit.field === "type" ? field(edit, edit.type, "Column type", "fkind-ed fkind-ed-type", "type", ctx?.types) : <span className="fkind-type">{edit.type}</span>}
          <span className="fkind-nn" aria-hidden="true" />
        </li>,
      );
      continue;
    }
    if (k === at && lost) {
      drawn.push(
        <li key={`${lost.index}:${lost.column ?? ""}`} className="fkind-row fkind-er-row" style={{ height: KIND_ROW }}>
          <span className="fkind-gut" aria-hidden="true" />
          {lost.field === "name" ? field(lost, lost.typed ?? lost.column ?? "", "Column name", "fkind-ed", "column_name") : <span className="fkind-col">{lost.column}</span>}
          {lost.field === "type" ? field(lost, lost.typed ?? "", "Column type", "fkind-ed fkind-ed-type", "type", ctx?.types) : <span className="fkind-type" />}
          <span className="fkind-nn" aria-hidden="true" />
        </li>,
      );
      continue;
    }
    const i = at >= 0 && k > at ? k - 1 : k;
    const { name, type } = splitRow(rows[i]);
    const flags = d.rowFlags?.[i] ?? [];
    const pk = flags.includes("pk");
    const nn = pk || flags.includes("not null");
    // The row's hover hint, which is also its one accessible description (M13).
    const tip = `${name}${type ? ` ${type}` : ""} (${[pk ? "primary key" : "", flags.includes("unique") && !pk ? "unique" : "", nn ? "not null" : "nullable"].filter(Boolean).join(", ")})`;
    if (!er) {
      drawn.push(
        <li key={`${i}:${name}`} className="fkind-row fkind-er-row" style={{ height: KIND_ROW }} title={tip} data-er-row={i}>
          <span className={pk ? "fkind-gut is-pk" : "fkind-gut"} aria-hidden="true">
            {pk && <Icon name="key" size={14} className="fkind-key" />}
          </span>
          <span className="fkind-col" data-er-field="name">
            {name}
          </span>
          <span className="fkind-type" data-er-field="type">
            {type}
          </span>
          <span className={nn ? "fkind-nn is-nn" : "fkind-nn"} aria-hidden="true" />
        </li>,
      );
      continue;
    }
    const editing = edit?.kind === "col" && edit.index === i ? edit : null;
    const picked = view?.selected === i;
    // The column the keyboard is on while "Make a relationship from here" picks (fix round 2, I1).
    const aimed = view?.aim === i;
    const gutTip = why ?? (pk ? "Primary key. Click to remove" : "Click to make it the primary key");
    drawn.push(
      <li
        key={`${i}:${name}`}
        className={`fkind-row fkind-er-row${picked ? " is-selected" : ""}${aimed ? " is-pick" : ""}`}
        aria-current={aimed ? true : undefined}
        style={{ height: KIND_ROW }}
        title={tip}
        aria-description={tip}
        data-er-row={i}
        onClick={() => er.selectColumn(d.name, i)}
        onContextMenu={() => er.pointColumn(d.name, i)}
        onDoubleClick={dbl(() => er.editColumn(d.name, i, "name"))}
      >
        <button
          type="button"
          className={`fkind-gut nodrag${pk ? " is-pk" : ""}`}
          aria-label="Primary key"
          aria-pressed={pk}
          disabled={!editable}
          title={gutTip}
          aria-description={gutTip}
          onClick={(ev) => {
            ev.stopPropagation();
            if (editable) er.toggleFlag(d.name, i, "pk");
          }}
          onDoubleClick={(ev) => ev.stopPropagation()}
        >
          {pk && <Icon name="key" size={14} className="fkind-key" />}
        </button>
        {editing?.field === "name" ? (
          field(editing, editing.typed ?? name, "Column name", "fkind-ed", "column_name")
        ) : (
          <span className="fkind-col" data-er-field="name" onDoubleClick={dbl(() => er.editColumn(d.name, i, "name"))}>
            {name}
          </span>
        )}
        {editing?.field === "type" ? (
          field(editing, editing.typed ?? type, "Column type", "fkind-ed fkind-ed-type", "type", ctx?.types)
        ) : (
          <span className="fkind-type" data-er-field="type" onDoubleClick={dbl(() => er.editColumn(d.name, i, "type"))}>
            {type}
          </span>
        )}
        <span className={nn ? "fkind-nn is-nn" : "fkind-nn"} title={nn ? "Not null" : "Nullable"} aria-hidden="true" />
        {ports && <ColumnPorts column={name} />}
      </li>,
    );
  }
  const headAimed = view?.aim === -1;
  return (
    <>
      {ports && <PortsSync table={d.name} />}
      <span
        // A header aimed by "Make a relationship from here" stands for its table's key (fix round 3).
        className={headAimed ? "fkind-head is-pick" : "fkind-head"}
        aria-current={headAimed ? true : undefined}
        onPointerEnter={enter}
        onPointerLeave={leave}
        onPointerDown={er ? (ev) => er.pickTable(d.name, ev.ctrlKey || ev.metaKey || ev.shiftKey) : undefined}
        onDoubleClick={
          er
            ? (ev) => {
                ev.stopPropagation();
                if (named) er.editTable(d.name);
              }
            : undefined
        }
      >
        <Icon name="table" size={14} />
        {edit?.kind === "table" ? (
          field(edit, edit.typed ?? d.name, "Table name", "fkind-ed fkind-ed-head")
        ) : (
          <span ref={nameRef} className="fnode-name" title={cut ? words : undefined} data-er-field="head">
            {words}
          </span>
        )}
      </span>
      {/* Rows that scroll take the wheel (I3); a card that fits lets the canvas pan, as draw.io and Figma do. */}
      <div
        className={scrolling ? "fkind-er-body nowheel is-scroll" : "fkind-er-body"}
        ref={bodyRef}
        onPointerEnter={enter}
        onPointerLeave={leave}
        onScroll={(ev) => {
          if (!live) return;
          if (shared) scrolls!.set(d.name, ev.currentTarget.scrollTop);
          else setOwn(ev.currentTarget.scrollTop);
        }}
        onDoubleClick={
          er
            ? (ev) => {
                ev.stopPropagation();
                if ((editable || why) && !(ev.target as Element).closest(".fkind-er-row")) er.addColumn(d.name);
              }
            : undefined
        }
        onPointerDown={
          er
            ? (ev) => {
                if (!(ev.target as Element).closest(".fkind-er-row")) er.pickTable(d.name, ev.ctrlKey || ev.metaKey || ev.shiftKey);
              }
            : undefined
        }
      >
        <ul className="fkind-rows fkind-er-rows">
          {drawn}
          {spacer("below", count - (pin >= to ? pin + 1 : to))}
        </ul>
      </div>
      {editable && (
        <button type="button" className="fkind-addcol nodrag" aria-label="Add column" onClick={() => er.addColumn(d.name)} onDoubleClick={(ev) => ev.stopPropagation()}>
          <Icon name="plus" size={14} />
          column
        </button>
      )}
    </>
  );
}

/**
 * Scrolls an ER card's `body` so row `row` is inside the `fits` rows it shows, only when the row is outside them, and at
 * once (no smooth scroll): to the row's top when it is above the view, to its bottom when below (WAI-ARIA listbox).
 */
export function scrollRowIntoView(body: HTMLElement, row: number, fits: number): void {
  // Measured from the rows' top, not the body's: the body's 3 px of padding above and below is in its view (`erViewH`
  // is at least `fits * KIND_ROW + 6`), so the row comes fully into view either way (`erRowY` counts the padding in).
  const top = body.scrollTop;
  const rowTop = row * KIND_ROW;
  const rowEnd = (row + 1) * KIND_ROW;
  if (rowTop < top) body.scrollTop = rowTop;
  else if (rowEnd > top + fits * KIND_ROW) body.scrollTop = rowEnd - fits * KIND_ROW;
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

function KindInside({ d, selected }: { d: KindNodeData; selected: boolean }) {
  const rows = d.rows ?? [];
  switch (d.kind) {
    case "erTable":
    case "erWeak":
      return <ErCard d={d} selected={selected} />;
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

export type SeqEdgeData = { row: number; y?: number; label?: string; reply: boolean; textScale?: number };

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
            className={(self ? "fkind-msg nodrag nopan is-self" : "fkind-msg nodrag nopan") + labelScale(d.textScale).cls}
            style={{ transform: `translate(${self ? "0" : "-50%"}, -100%) translate(${mid.x}px, ${mid.y}px)`, ...labelScale(d.textScale).style }}
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
