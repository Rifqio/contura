// Step 12, item 19: the shapes of the newer diagram kinds on the engine's canvas (frame DiagramElements). Each
// is a node type with the shared shell (selection ring, ports, levels of detail) and its own inside: ER and class
// cards with their rows, state pills and markers, sequence participants with their lifelines, mind map topics,
// timeline items and notes. The lines of these kinds are here too: sequence messages along their rows and the
// curved branches of a mind map.
import { textSizeOf } from "./textScale";
import { BaseEdge, type EdgeProps, Handle, type NodeProps, Position, useInternalNode, useNodeId, useUpdateNodeInternals } from "@xyflow/react";
import { type CSSProperties, type MouseEvent, memo, type ReactNode, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import Icon from "../components/Icon";
import { ER_FAR_ROW, SOFT_CHAR_W } from "../diagram/canvasView";
import { useTextFar } from "./board/BoardFar";
import type { DrawnKind } from "../diagram/types";
import { perfMeasure, perfOn } from "../perf/perfRecorder";
import { ER_MAX_ROWS, ER_ROW_OVERSCAN, erFits, erMetrics, erRowWindow, erViewH, isMethod, KIND_ROW } from "./kindLayout";
import { type NodeLook, NodeShell, type NodeState, type ShapeColour, STATE_NOTE, stateClass } from "./nodes/parts";
import InlineEdit from "./interactions/InlineEdit";
import { SeqParticipant } from "./seqNodes";
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
  /** The frame's text size; unset at 1. An ER card's rows and header scale with it. */
  textScale?: number;
  state?: NodeState;
  /**
   * An ER table's rows under review, one per row in `rows` (missing or undefined: unmarked). A static
   * card's are its first ER_MAX_ROWS only; the live card scrolls its first marked row into view.
   */
  rowStates?: readonly (RowState | undefined)[];
  /** The words it shows (its `label:`) when they are not its name, and its palette colour. */
  shows?: string;
  color?: ShapeColour;
  /** A participant's or actor's icon, as a service's (`FlowNodeData.iconName`). */
  iconName?: string;
  /** A sequence participant or actor, drawn by `SeqParticipant`. */
  seq?: true;
  /** A participant's own colour, which only the sequence variables read (never `color`, so no preset fill). */
  seqColour?: ShapeColour;
};

/** An ER row's review mark: new, gone or changed in the waiting proposal, or just added by it. */
export type RowState = "suggested" | "removed" | "changed" | "airing" | "ringed";

/** What a row's review mark adds to its hint: the shapes' notes ("removal suggested by AI" for a removed row). */
const ROW_NOTE: Partial<Record<RowState, string>> = STATE_NOTE;

/** The words a shape shows: its label, else its name. */
export const wordsOf = (d: KindNodeData) => d.shows ?? d.name;

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
 * show, measures them again once a frame when the rows scroll under them, so no drag uses a port's old place.
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
 * An ER table card (ER build A, board ER interactions; B3): the header, then one row per column with its key
 * gutter, name, type and not-null mark. On the live frame with the canvas's editing context each part is edited in
 * place; without it (a static frame, a preview, Publish) the card only draws, as it always has. Either way it draws
 * only the rows in view (decision 7), with spacers for the rest, so a 300-column table costs 22 rows. The header,
 * name and type carry `data-er-field` and each row `data-er-row`, so the canvas finds the field a double-click on a
 * static card meant by its rect (decision 5). `selected` is for the ports: a table selected alone shows them.
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
  // A header name has a tip, the app's hover hint, only when it is cut off.
  const nameRef = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = nameRef.current;
    setCut(!!el && el.scrollWidth > el.clientWidth);
  }, [words, d.sized?.w, d.naturalW, edit?.kind]);
  // The ports show while the pointer is over the card or the table is selected alone (draw.io), on the
  // live frame only (decision 5): a static card hears no pointer and reads no selection. A table whose name needs quotes
  // can end no column relationship, so it shows none (decision 3).
  const connectable = useContext(ConnectableContext);
  const [hot, setHot] = useState(false);
  const cool = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(cool.current), []);
  // A field open asked for on a card is measured at the paint after it mounts (the opt-in recorder; one mark, spent once).
  const fieldOpen = edit !== null;
  useEffect(() => {
    if (fieldOpen && perfOn()) requestAnimationFrame(() => perfMeasure("er_field_open", "er_field_open_req"));
  }, [fieldOpen]);
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
  // the lines to its rows read too; a static card does not scroll; a card with no store (a
  // preview) keeps its own.
  const scrolls = useContext(ErScrollContext);
  const shared = live && !!scrolls;
  const stored = useErScroll(shared ? d.name : null);
  const [own, setOwn] = useState(0);
  const scroll = !live ? 0 : shared ? stored : own;
  // The card's geometry at its frame's text size: header, padding and row pitch scale with the card.
  const textK = d.textScale ?? 1;
  const m = erMetrics(textK);
  // Far text: the rows draw as bars, unless a field is open on the card (what is typed stays).
  const far = useTextFar(textSizeOf(d.textScale));
  const fits = erFits(d.sized?.h, textK);
  const viewH = erViewH(d.sized?.h, textK);
  const scrolling = live && count > fits;
  const win = erRowWindow(count, viewH, scroll, textK);
  let { from, to } = win;
  // The open field's row is drawn whatever the scroll, so what is typed in it is never unmounted (Review Focus 1); it
  // counts within the 22-row cap, the window giving up its far end for it.
  const editK =
    edit?.kind === "draft" || lost ? at : edit?.kind === "col" ? (at >= 0 && edit.index >= at ? edit.index + 1 : edit.index) : -1;
  const pin = editK >= 0 && editK < count && (editK < from || editK >= to) ? editK : -1;
  if (pin >= 0 && to - from >= ER_MAX_ROWS + 2 * ER_ROW_OVERSCAN) {
    // An overscan row goes first: the one above when the window has one there (3 px of padding above the rows).
    if (from < Math.floor((scroll - m.pad) / m.row)) from++;
    else to--;
  }
  const bodyRef = useRef<HTMLDivElement>(null);
  // The body follows the store: a card drawn again (a rename, the end of a tab drag, panned back into view) takes up the
  // scroll kept for it (M8, R26), and a frame switch's `clear` puts it back at its top. The store keeps no top past the
  // card's last row, so a table with fewer rows under the same name starts where its rows allow (as a browser clamps).
  const most = Math.max(0, count * m.row + 2 * m.pad - viewH);
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
  // The first row the waiting proposal marks, scrolled into view as a selected row is.
  const markK = shownK(d.rowStates?.findIndex((st) => st !== undefined));
  useLayoutEffect(() => {
    if (!scrolling || !bodyRef.current) return;
    for (const k of [editK, aimK, selK, markK]) if (k >= 0 && k < count) return scrollRowIntoView(bodyRef.current, k, fits, m.row);
    // When one of them moves or the card starts to scroll; a scroll by the wheel leaves the selected row where it put it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editK, aimK, selK, markK, scrolling, fits, m.row]);
  const spacer = (key: string, n: number) => n > 0 && <li key={key} className="fkind-er-spacer" aria-hidden="true" style={{ height: n * m.row }} />;
  // A card of no known width (no size and no natural size) keeps its rows: a 0-wide picture would draw nothing.
  const cardW = d.sized?.w ?? d.naturalW ?? 0;
  const bars = far && editK < 0 && cardW > 0;
  const ks: number[] = [];
  if (!bars) for (let k = from; k < to; k++) ks.push(k);
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
        <li key="new" className="fkind-row fkind-er-row is-new" style={{ height: m.row }}>
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
        <li key={`${lost.index}:${lost.column ?? ""}`} className="fkind-row fkind-er-row" style={{ height: m.row }}>
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
    // The row's hover hint, which is also its one accessible description.
    // Its review mark, on the class and in the hint: ", changed by AI".
    const mark = d.rowStates?.[i];
    const markCls = mark ? ` is-ai-${stateClass(mark)}` : "";
    const tip = `${name}${type ? ` ${type}` : ""} (${[pk ? "primary key" : "", flags.includes("unique") && !pk ? "unique" : "", nn ? "not null" : "nullable"].filter(Boolean).join(", ")})${(mark && ROW_NOTE[mark]) ?? ""}`;
    if (!er) {
      drawn.push(
        <li key={`${i}:${name}`} className={`fkind-row fkind-er-row${markCls}`} style={{ height: m.row }} title={tip} data-er-row={i}>
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
    // The column the keyboard is on while "Make a relationship from here" picks.
    const aimed = view?.aim === i;
    const gutTip = why ?? (pk ? "Primary key. Click to remove" : "Click to make it the primary key");
    drawn.push(
      <li
        key={`${i}:${name}`}
        className={`fkind-row fkind-er-row${picked ? " is-selected" : ""}${aimed ? " is-pick" : ""}${markCls}`}
        aria-current={aimed ? true : undefined}
        style={{ height: m.row }}
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
        // A header aimed by "Make a relationship from here" stands for its table's key.
        className={`fkind-head${headAimed ? " is-pick" : ""}${bars ? " is-far" : ""}`}
        style={textK !== 1 ? { height: m.head } : undefined}
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
        {/* A far card's icon is the header's ::before (flow-board.css), with no <svg> root. */}
        {!bars && <Icon name="table" size={14} />}
        {edit?.kind === "table" ? (
          field(edit, edit.typed ?? d.name, "Table name", "fkind-ed fkind-ed-head")
        ) : (
          <span ref={nameRef} className="fnode-name" title={cut ? words : undefined} data-er-field="head">
            {words}
          </span>
        )}
      </span>
      {/* Rows that scroll take the wheel; a card that fits lets the canvas pan, as draw.io and Figma do. */}
      <div
        className={`fkind-er-body${scrolling ? " nowheel is-scroll" : ""}${bars ? " is-far" : ""}`}
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
        {bars ? (
          <ErBars rows={rows} flags={d.rowFlags} from={from} to={to} count={count} w={cardW} k={textK} ports={ports} />
        ) : (
          <ul className="fkind-rows fkind-er-rows" style={textK !== 1 ? { padding: `${m.pad}px 0` } : undefined}>
            {drawn}
            {spacer("below", count - (pin >= to ? pin + 1 : to))}
          </ul>
        )}
      </div>
      {editable && !bars && (
        <button type="button" className="fkind-addcol nodrag" aria-label="Add column" onClick={() => er.addColumn(d.name)} onDoubleClick={(ev) => ev.stopPropagation()}>
          <Icon name="plus" size={14} />
          column
        </button>
      )}
    </>
  );
}

// A far ER row's bars and key mark (canvasView.ts `ER_FAR_ROW`, shared with a frame picture's far ER card).
const { h: BAR_H, from: BAR_FROM, to: BAR_TO, key: KEY_MARK, keyMid: KEY_MID } = ER_FAR_ROW;
const BAR = "linear-gradient(var(--far-bar), var(--far-bar))";
const KEY = "linear-gradient(var(--far-key), var(--far-key))";

/**
 * An ER card's rows when its text is far (Figma and Miro draw far text as grey bars): one block the
 * height of every row whose backgrounds are the bars, a name bar then a type bar for each row in the window, and a
 * key row's mark in the gutter; no row element and no `<svg>` (WebKit gives each `<svg>` root its own
 * memory, and 705 cards at the fit had one each where main's fast box had none). The ports stay on each row in the
 * window while they show, so a line can still be drawn from a column.
 */
export function ErBars({ rows, flags, from, to, count, w, k, ports }: { rows: string[]; flags?: ColumnFlag[][]; from: number; to: number; count: number; w: number; k: number; ports: boolean }) {
  const m = erMetrics(k);
  const h = BAR_H * k;
  const images: string[] = [];
  const sizes: string[] = [];
  const places: string[] = [];
  const keys: [string, string, string][] = [];
  const handles: ReactNode[] = [];
  const bar = (x: number, y: number, bw: number) => {
    images.push(BAR);
    sizes.push(`${bw}px ${h}px`);
    places.push(`${x}px ${y}px`);
  };
  for (let i = from; i < Math.min(to, rows.length); i++) {
    const { name, type } = splitRow(rows[i]);
    const top = m.pad + i * m.row;
    const y = top + (m.row - h) / 2;
    const typeW = Math.min(type.length * SOFT_CHAR_W * k, 0.3 * w);
    bar(BAR_FROM, y, Math.min(name.length * SOFT_CHAR_W * k, 0.55 * w));
    bar(w - BAR_TO - typeW, y, typeW);
    if (flags?.[i]?.includes("pk")) keys.push([KEY, `${KEY_MARK}px ${KEY_MARK}px`, `${KEY_MID - KEY_MARK / 2}px ${top + (m.row - KEY_MARK) / 2}px`]);
    if (ports)
      handles.push(
        <span key={`${i}:${name}`} className="fkind-er-farport" style={{ top, height: m.row }}>
          <ColumnPorts column={name} />
        </span>,
      );
  }
  for (const [image, size, place] of keys) {
    images.push(image);
    sizes.push(size);
    places.push(place);
  }
  const style: CSSProperties = { width: w, height: count * m.row + 2 * m.pad };
  if (images.length > 0) Object.assign(style, { backgroundImage: images.join(", "), backgroundSize: sizes.join(", "), backgroundPosition: places.join(", ") });
  return (
    <>
      <div className="fkind-er-bars" aria-hidden="true" style={style} />
      {handles}
    </>
  );
}

/**
 * Scrolls an ER card's `body` so row `row` is inside the `fits` rows it shows, only when the row is outside them, and at
 * once (no smooth scroll): to the row's top when it is above the view, to its bottom when below (WAI-ARIA listbox).
 */
export function scrollRowIntoView(body: HTMLElement, row: number, fits: number, pitch = KIND_ROW): void {
  // Measured from the rows' top, not the body's: the body's padding above and below is in its view (`erViewH` is at
  // least `fits` rows and both paddings), so the row comes fully into view either way (`erRowY` counts the padding in).
  // `pitch` is the card's row pitch at its text size (`erMetrics(k).row`).
  const top = body.scrollTop;
  const rowTop = row * pitch;
  const rowEnd = (row + 1) * pitch;
  if (rowTop < top) body.scrollTop = rowTop;
  else if (rowEnd > top + fits * pitch) body.scrollTop = rowEnd - fits * pitch;
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
      return <SeqParticipant d={d} />;
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

// The sequence's message, block and caption live in seqNodes.tsx; flowNodes imports them from here.
export { SeqEdge, type SeqEdgeData, SeqFrame, SeqFrameTab } from "./seqNodes";

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
