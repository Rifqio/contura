import {
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { Cell, SortSpec } from "../api/types";
import {
  addCell,
  block,
  colCoverage,
  coversAll,
  contains,
  copyText,
  extendRowsTo,
  extendTo,
  isOneColumn,
  navigate,
  norm,
  type Range,
  rowCoverage,
  selectAll,
  selectColumn,
  selectRows,
  type Selection,
  single,
} from "../grid/selection";
import { writeClipboard } from "../grid/clipboard";
import { isOwnOrder, ownOrder } from "../grid/columnOrder";
import { type CommandHandlers, useCommandKeys, useKeymap } from "../commands/useCommandKeys";
import { hintFor } from "../commands/keymap";
import { pressedKeys } from "../commands/keys";
import CellValue, { type CellSource } from "./CellValue";
import { cellContentWidth, fitColumns, fitToContent, headerFloor, headerPadding, headerWidth } from "./columnWidths";
import Icon from "./Icon";
import { type MenuItem, PointMenu } from "./Menu";

/** Rows are one line high (app.css `.grid td`); measured once rendered. */
const FALLBACK_ROW_HEIGHT = 28;
/** The header button's side padding (app.css `--grid-header-padding`), both sides. */
const HEADER_PADDING = 16;
const BOOL_TYPE = /^bool(ean)?$/i;
/** Rows rendered above and below the visible ones. */
const OVERSCAN = 20;
/** A press on a header moves its column once the pointer has gone further than this; less is a click (AG Grid). */
const DRAG_START = 4;
/** While a column is dragged this close to the grid's side, the grid scrolls that way (AG Grid, Excel). */
const EDGE = 28;

export interface GridColumn {
  name: string;
  typeName: string;
  numeric: boolean;
  isPrimaryKey?: boolean;
  /** A Foreign Key column: a link icon before its name (T5). */
  isForeignKey?: boolean;
}

interface Props {
  columns: GridColumn[];
  rows: Cell[][];
  /**
   * The columns in the order shown, as indexes into `columns` and into every row; every column in its own order when
   * left out. Every position the grid gives back (selection, cells, menus) is a place in this order.
   */
  order?: readonly number[];
  /**
   * Moves the column at shown position `from` into the gap `slot` (0 to the column count), view only: dragging a
   * header, the move keys and the header menu. Without it columns stay where they are.
   */
  onMoveColumn?(from: number, slot: number, by: MoveBy): void;
  /** The header menu's Reset column order; offered, and on while `order` is not the columns' own. */
  onResetOrder?(): void;
  /** Said after a move, such as " Remembered for orders." */
  orderMemo?: string;
  /**
   * Whether the whole order (hidden columns too) is the columns' own; Reset column order is on when it is not. Left out,
   * the shown columns decide.
   */
  orderIsOwn?: boolean;
  /** What the columns' own order is called, for the note a reset leaves: "the table's order". */
  ownOrderText?: string;
  /**
   * Where the notes of moving a column go (a live region that is always there, such as the footer's), so nothing
   * appears above the grid and moves under the pointer during a drag. `onNote` when left out.
   */
  onOrderNote?(text: string): void;
  /** The header menu's Sort ascending and Sort descending. */
  onSortTo?(sort: SortSpec): void;
  /** Changing it starts the grid over at the top, with fresh column widths. */
  resetKey: unknown;
  /** Dragged and fitted widths are kept, by column name, while this stays the same; it defaults to `resetKey`. */
  widthsKey?: unknown;
  /** The user dragged or fitted a column. */
  onResized?(): void;
  label: string;
  /** The number shown on the first row. */
  firstRow?: number;
  stale?: boolean;
  sort?: SortSpec | null;
  onSort?(column: string): void;
  cellSource?(row: number, column: string): CellSource | undefined;
  /** Called when the last rows come into view, to fetch more. */
  onNearEnd?(): void;
  /** The rows in view, as 1-based numbers, once the grid has a height. */
  onRange?(first: number, last: number): void;
  /** Shown after the table, such as an empty-state line. */
  children?: ReactNode;
  /** In the header corner above the row numbers, such as the Read-only lock. */
  corner?: ReactNode;
  /** The row with an open cell editor; when it leaves the rendered rows, `onEditorLost` runs. */
  editingRow?: number | null;
  onEditorLost?(): void;
  /**
   * G2: the selected ranges, in grid positions. With `onSelection` the grid selects: clicks, Shift and Ctrl clicks,
   * drags, the row numbers, the corner, and the movement keys; Ctrl+C and Ctrl+Shift+C copy (G1).
   */
  selection?: Selection | null;
  onSelection?(next: Selection): void;
  /** What the grid says about a copy, for the owner's status line. */
  onNote?(text: string): void;
  /** Lets the owner's menu copy as Ctrl+C does. */
  gridRef?: MutableRefObject<GridHandle | null>;
  onOpen?(row: number, column: number): void;
  /** The owner's keys run first; a key it handles (`preventDefault`) is not moved or copied on. */
  onGridKey?(e: KeyboardEvent<HTMLDivElement>): void;
  onCellMenu?(row: number, column: number, x: number, y: number): void;
  onPaste?(e: ClipboardEvent<HTMLDivElement>): void;
  cellClass?(row: number, column: number): string | undefined;
  cellTitle?(row: number, column: number): string | undefined;
  rowClass?(row: number): string | undefined;
  rowLabel?(row: number): ReactNode | undefined;
  /** Replaces the cell's content, such as the open editor. */
  renderCell?(row: number, column: number): ReactNode | undefined;
  /** The text a copy takes for a cell whose shown text is not its value, such as the `default` marker. */
  copyCell?(row: number, column: number): string | undefined;
  /**
   * UX step 8: a Foreign Key cell. `go` draws the arrow at the cell's right (TablePlus), shown on row hover and on the
   * active cell; `null` is a NULL key, which has no arrow. Either keeps the arrow's slot free so values line up.
   */
  keyCell?(row: number, column: number): { kind: "go"; title: string; onFollow(): void } | { kind: "null" } | null;
}

/** Registers app command handlers for as long as it is rendered. */
function CommandKeys({ handlers, region }: { handlers: CommandHandlers; region: RefObject<HTMLElement | null> }) {
  useCommandKeys(handlers, { region });
  return null;
}

/** A NULL key has no row to go to; its cell says so. */
const NULL_KEY_TIP = "NULL: no row to go to";

/** How a column was moved: a held key repeats, so its saves may wait for the run to end; a drag or a menu item never. */
export type MoveBy = "drag" | "menu" | "keys";

export interface GridHandle {
  /** Copies the selection, with a header line when asked: as Ctrl+C and Ctrl+Shift+C. */
  copy(headers: boolean): void;
}

const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : `${one}s`}`;

/** A cell as copied text: NULL is an empty field (ruling 3), and so is a binary value, which has only a preview. */
function copyValue(c: Cell | undefined): string | null {
  if (!c || c.t === "null" || c.t === "bytes") return null;
  return c.value;
}

/** A cell whose copy is not its whole value: text cut short at the preview limit, or binary. */
const cutShort = (c: Cell | undefined) => !!c && (c.t === "bytes" || (c.t === "text" && c.truncated));

/** A field: a key typed into it is its own. */
function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(el.tagName) || el.isContentEditable;
}

/** Holds the scroll height of rows that are not rendered. */
function SpacerRow({ columns, height }: { columns: number; height: number }) {
  return (
    <tr className="grid-spacer" aria-hidden="true">
      <td colSpan={columns + 1} style={{ height }} />
    </tr>
  );
}

type Visible = { first: number; last: number };
/**
 * Widths taken from the first render after a reset (or a new set of columns),
 * so scrolling never reflows them: each column's content and header label, and
 * the row-number gutter.
 */
type Measure = { key: unknown; cols: string; gutter: number; natural: number[]; header: number[]; floor: number[] };
/** The columns' widths are measured once per set of columns shown; moving one keeps them (by column index). */
/** Widths the user dragged or fitted, by column name, while their `widthsKey` stays. */
type Pins = { key: unknown; px: Record<string, number> };

/**
 * A read-only, virtualized grid: only the rows near the viewport are in the DOM,
 * spacer rows stand in for the rest. Used by the table view and query results.
 */
export default function ResultGrid({
  columns,
  rows,
  order,
  onMoveColumn,
  onResetOrder,
  orderMemo = "",
  ownOrderText = "their own order",
  orderIsOwn,
  onSortTo,
  onOrderNote,
  resetKey,
  widthsKey = resetKey,
  onResized,
  label,
  firstRow = 1,
  stale = false,
  sort = null,
  onSort,
  cellSource,
  onNearEnd,
  onRange,
  children,
  corner,
  editingRow = null,
  onEditorLost,
  selection = null,
  onSelection,
  onNote,
  gridRef,
  onOpen,
  onGridKey,
  onCellMenu,
  onPaste,
  cellClass,
  cellTitle,
  rowClass,
  rowLabel,
  renderCell,
  copyCell,
  keyCell,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = useRef(FALLBACK_ROW_HEIGHT);
  const [visible, setVisible] = useState<Visible>({ first: 0, last: 0 });
  const [measure, setMeasure] = useState<Measure | null>(null);
  const [pins, setPins] = useState<Pins | null>(null);
  const [available, setAvailable] = useState(0);
  /** Bumped to measure the widths again (fonts loaded, or a hidden grid shown). */
  const [epoch, setEpoch] = useState(0);
  const measured = useRef(false);
  const own = useRef<number[]>([]);
  if (!order && own.current.length !== columns.length) own.current = ownOrder(columns.length);
  /** Shown position to column index: the one mapping every cell, header and copy goes through. */
  const at = order ?? own.current;
  const count = at.length;
  // Which columns are shown, not their order: a move never measures again.
  const cols = `${columns.map((c) => c.name).join("\u0000")}|${[...at].sort((a, b) => a - b).join(",")}`;

  // Clearing the measure renders the table without fixed widths, which the measuring
  // effect below then reads.
  const remeasure = useCallback(() => {
    setMeasure(null);
    setEpoch((e) => e + 1);
  }, []);

  const measureViewport = useCallback(() => {
    const box = scrollRef.current;
    if (!box) return;
    const h = rowHeight.current;
    const first = Math.floor(box.scrollTop / h);
    const last = Math.ceil((box.scrollTop + box.clientHeight) / h);
    setVisible((v) => (v.first === first && v.last === last ? v : { first, last }));
    setAvailable(box.clientWidth);
  }, []);

  useEffect(() => {
    const box = scrollRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    // A grid first rendered while hidden measured nothing: measure once it has a width.
    const observer = new ResizeObserver(() => {
      measureViewport();
      if (!measured.current && box.clientWidth > 0) remeasure();
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [measureViewport, remeasure]);

  // Widths taken before the bundled code font loaded are too narrow for it: measure again
  // once it has. Pinned (dragged) widths stay.
  useEffect(() => {
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    if (!fonts) return;
    let alive = true;
    const again = () => {
      if (alive) remeasure();
    };
    if (fonts.status !== "loaded") void fonts.ready.then(again);
    fonts.addEventListener?.("loadingdone", again);
    return () => {
      alive = false;
      fonts.removeEventListener?.("loadingdone", again);
    };
  }, [remeasure]);

  // A reset starts at the top, with the row height taken from this first
  // render, before the browser paints.
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    box.scrollTop = 0;
    const firstRowEl = box.querySelector<HTMLElement>("tr[data-row]");
    if (firstRowEl && firstRowEl.offsetHeight > 0) rowHeight.current = firstRowEl.offsetHeight;
    setVisible({ first: 0, last: 0 });
    measureViewport();
  }, [resetKey, measureViewport]);

  // Column widths come from the first render of a reset or of new columns,
  // which is laid out by the browser because no widths are fixed for it yet.
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const gutter = box.querySelector<HTMLElement>("thead th.row-number")?.offsetWidth ?? 0;
    const heads = Array.from(box.querySelectorAll<HTMLElement>("thead th:not(.row-number)"));
    // Kept by column index (the headers are in the order shown), so a moved column keeps its width.
    const byColumn = (values: number[]) => {
      const out = new Array<number>(columns.length).fill(0);
      values.forEach((v, p) => {
        if (at[p] !== undefined) out[at[p]] = v;
      });
      return out;
    };
    const shownNatural = heads.map((th) => th.offsetWidth);
    // The header cell's own side borders take room from the label too.
    const measureHeads = (f: (label: HTMLElement, padding: number) => number) =>
      heads.map((th) => {
        const label = th.querySelector<HTMLElement>(".header-label");
        return label ? f(label, headerPadding(th, HEADER_PADDING)) : HEADER_PADDING;
      });
    const natural = byColumn(shownNatural);
    const header = byColumn(measureHeads(headerWidth));
    const floor = byColumn(measureHeads(headerFloor));
    const ok = gutter > 0 && shownNatural.length > 0 && shownNatural.every((w) => w > 0);
    measured.current = ok;
    setMeasure(ok ? { key: resetKey, cols, gutter, natural, header, floor } : null);
    setAvailable(box.clientWidth);
  }, [resetKey, cols, epoch]);

  const rowCount = rows.length;
  const start = Math.max(0, visible.first - OVERSCAN);
  const end = Math.min(rowCount, visible.last + OVERSCAN);
  const current = measure && measure.key === resetKey && measure.cols === cols ? measure : null;
  const pinned = pins && current && pins.key === widthsKey ? at.map((c) => pins.px[columns[c].name] ?? null) : null;
  const fixed = current
    ? [
        current.gutter,
        ...fitColumns({
          natural: at.map((c) => current.natural[c]),
          header: at.map((c) => current.header[c]),
          // One px less: the collapsed outer border adds a fraction of a px past the set width,
          // which would otherwise show a horizontal scrollbar on a pane the grid exactly fills.
          available: available - current.gutter - 1,
          pinned: pinned ?? at.map(() => null),
        }),
      ]
    : null;

  // Dragging a header's right edge pins that column's width, never under its header label.
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  function pin(name: string, w: number) {
    setPins((p) => ({ key: widthsKey, px: { ...(p && p.key === widthsKey ? p.px : {}), [name]: w } }));
  }

  // Double-clicking a header's right edge fits the column to its header and the cells in view.
  function fitColumn(e: ReactMouseEvent, ci: number) {
    if (!current) return;
    e.preventDefault();
    e.stopPropagation();
    const cells = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>(`tbody td[data-col="${ci}"]`) ?? [], cellContentWidth);
    const c = at[ci];
    onResized?.();
    pin(columns[c].name, fitToContent({ header: current.header[c], floor: current.floor[c] ?? current.header[c], cells }));
  }

  function startResize(e: ReactMouseEvent, ci: number) {
    if (e.button !== 0 || !current || !fixed) return;
    e.preventDefault();
    e.stopPropagation();
    stopDrag.current?.();
    const startX = e.clientX;
    const startWidth = fixed[ci + 1];
    const min = current.floor[at[ci]] ?? current.header[at[ci]];
    const name = columns[at[ci]].name;
    let moved = false;
    const move = (ev: MouseEvent) => {
      moved = true;
      const w = Math.max(min, Math.round(startWidth + ev.clientX - startX));
      pin(name, w);
    };
    const stop = () => {
      if (moved) onResized?.();
      moved = false;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      document.body.classList.remove("col-resizing");
      stopDrag.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    document.body.classList.add("col-resizing");
    stopDrag.current = stop;
  }

  useEffect(() => {
    const box = scrollRef.current;
    if (onRange && box && box.clientHeight > 0 && rowCount > 0) {
      onRange(Math.min(rowCount, visible.first + 1), Math.min(rowCount, Math.max(visible.first + 1, visible.last)));
    }
  }, [visible.first, visible.last, rowCount]);

  useEffect(() => {
    if (onNearEnd && rowCount > 0 && visible.last >= rowCount - OVERSCAN) onNearEnd();
  }, [visible.last, rowCount]);

  // An editor whose row is no longer rendered is gone from the page: keep what was typed.
  const editorLost = useRef(onEditorLost);
  editorLost.current = onEditorLost;
  useEffect(() => {
    if (editingRow !== null && (editingRow < start || editingRow >= end)) editorLost.current?.();
  }, [editingRow, start, end]);

  // The moving corner of the selection stays in view; a row not rendered yet is scrolled to first. A whole column
  // (a header, Ctrl+Space, a moved column) keeps the rows where they are and only brings the column into view
  // sideways; whole rows keep the columns; everything (Ctrl+A) moves nothing (Excel, DataGrip, AG Grid).
  const endRow = selection?.end.r;
  const endCol = selection?.end.c;
  const lastRange = selection?.ranges[selection.ranges.length - 1];
  const span = lastRange ? norm(lastRange) : null;
  const allRows = !!span && rows.length > 1 && span.t === 0 && span.b >= rows.length - 1;
  const allCols = !!span && count > 1 && span.l === 0 && span.r >= count - 1;
  useEffect(() => {
    if (endRow === undefined || endCol === undefined) return;
    const box = scrollRef.current;
    if (!box || (allRows && allCols)) return;
    if (allRows) {
      const th = box.querySelector<HTMLElement>(`thead th[aria-colindex="${endCol + 2}"]`);
      if (!th) return;
      const b = box.getBoundingClientRect();
      const h = th.getBoundingClientRect();
      if (h.left < b.left) box.scrollLeft -= b.left - h.left;
      else if (h.right > b.left + box.clientWidth) box.scrollLeft += Math.min(h.left - b.left, h.right - b.left - box.clientWidth);
      return;
    }
    const td = box.querySelector<HTMLElement>(`tr[data-row="${endRow}"] td[data-col="${endCol}"]`);
    if (allCols) {
      const tr = td?.parentElement;
      if (!tr) {
        box.scrollTop = Math.max(0, endRow * rowHeight.current - box.clientHeight / 2);
        return;
      }
      const b = box.getBoundingClientRect();
      const r = tr.getBoundingClientRect();
      const head = box.querySelector("thead")?.getBoundingClientRect().height ?? 0;
      if (r.top < b.top + head) box.scrollTop -= b.top + head - r.top;
      else if (r.bottom > b.top + box.clientHeight) box.scrollTop += r.bottom - b.top - box.clientHeight;
      return;
    }
    if (td) td.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    else box.scrollTop = Math.max(0, endRow * rowHeight.current - box.clientHeight / 2);
  }, [endRow, endCol, allRows, allCols]);

  const selectable = !!onSelection;
  const active = selection && selectable ? selection.active : null;

  // G1: the copied block wears a dashed mark until Esc or a change of the rows (an edit).
  const [copied, setCopied] = useState<Range[] | null>(null);
  // A moved column moves the places the mark stood on, so it goes too.
  useEffect(() => setCopied(null), [rows, at]);

  function copy(headers: boolean) {
    if (!selection) return;
    const b = block(selection);
    if (!b) {
      onNote?.("Not copied: copy takes one block, or blocks sharing rows or columns.");
      return;
    }
    // In the order shown (DataGrip, Excel): each shown place goes through the one mapping.
    const text = copyText(
      b,
      (r, c) => copyCell?.(r, c) ?? copyValue(rows[r]?.[at[c]]),
      headers ? b.cols.map((c) => columns[at[c]].name) : undefined,
    );
    // The note says it was copied at once; a clipboard that refuses takes the copy mark and the note back (M2).
    void writeClipboard(text).then((ok) => {
      if (ok) return;
      setCopied(null);
      onNote?.("Not copied: the clipboard refused.");
    });
    setCopied(selection.ranges.map((g) => ({ ...g })));
    let cut = 0;
    for (const r of b.rows) for (const c of b.cols) if (cutShort(rows[r]?.[at[c]])) cut++;
    const copied = `Copied ${plural(b.rows.length * b.cols.length, "cell")}${headers ? " with headers" : ""}`;
    // I1: never a silent cut. The Core sends at most 1 KB of a value (PREVIEW_BYTES).
    onNote?.(
      cut
        ? `${copied}; ${cut.toLocaleString("en-US")} ${cut === 1 ? "was" : "were"} cut short at 1 KB. Open full value (Shift+F2) copies one in full.`
        : `${copied}.`,
    );
  }
  const copyRef = useRef(copy);
  copyRef.current = copy;
  if (gridRef) gridRef.current = { copy: (headers) => copyRef.current(headers) };

  const dims = { rows: rows.length, cols: count };
  /** A drag from a cell or a row number extends the selection over what the pointer passes. */
  const drag = useRef<"cells" | "rows" | null>(null);
  useEffect(() => {
    const up = () => (drag.current = null);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);
  const latest = useRef(selection);
  latest.current = selection;

  function cellDown(e: ReactMouseEvent, r: number, c: number) {
    // A press in the cell's editor, or in a panel it opened elsewhere on the page, is the editor's own.
    if (!onSelection || e.button !== 0 || !e.currentTarget.contains(e.target as Node) || typing(e.target)) return;
    const s = latest.current;
    const p = { r, c };
    const next = e.shiftKey && s ? extendTo(s, p) : (e.ctrlKey || e.metaKey) && s ? addCell(s, p) : single(p);
    drag.current = "cells";
    // Keys work on the grid at once, whatever had focus.
    if (!scrollRef.current?.contains(document.activeElement)) scrollRef.current?.focus({ preventScroll: true });
    onSelection(next);
  }

  function rowDown(e: ReactMouseEvent, r: number) {
    if (!onSelection || e.button !== 0 || count === 0) return;
    e.preventDefault();
    const s = latest.current;
    const next = e.shiftKey && s ? extendRowsTo(s, r, count) : selectRows(s, r, r, (e.ctrlKey || e.metaKey) && !!s, count);
    drag.current = "rows";
    scrollRef.current?.focus({ preventScroll: true });
    onSelection(next);
  }

  function dragOver(e: ReactMouseEvent) {
    const mode = drag.current;
    const s = latest.current;
    if (!mode || !onSelection || !s) return;
    const el = e.target as HTMLElement;
    const tr = el.closest?.("tr[data-row]");
    if (!tr) return;
    const r = Number(tr.getAttribute("data-row"));
    if (mode === "rows") {
      if (s.end.r !== r) onSelection(extendRowsTo(s, r, count));
      return;
    }
    const td = el.closest("td[data-col]");
    if (!td) return;
    const c = Number(td.getAttribute("data-col"));
    if (s.end.r !== r || s.end.c !== c) onSelection(extendTo(s, { r, c }));
  }

  // ---- Moving columns, view only: drag a header, the move keys (DBeaver's Alt+Shift+Left and Right), the header menu ----
  const movable = !!onMoveColumn && count > 0;
  const { map: keymap } = useKeymap();
  /** A move command's first key, arrows named as people say them ("Shift+Alt+Left"). */
  const moveKey = (id: "grid.moveColumnLeft" | "grid.moveColumnRight") =>
    hintFor(keymap, id)?.replace(/Arrow(Left|Right|Up|Down)/, "$1") ?? undefined;
  const nameAt = (p: number) => columns[at[p]]?.name ?? "";
  const orderNote = (text: string) => (onOrderNote ?? onNote)?.(text);

  /** Moves the column at `from` into the gap `slot`, keeps it selected and says where it went. */
  function moved(from: number, slot: number, by: MoveBy) {
    if (!onMoveColumn || slot === from || slot === from + 1 || slot < 0 || slot > count) return;
    const to = slot > from ? slot - 1 : slot;
    // The column before the gap, which is the column before it once moved.
    const where = to === 0 ? "to first" : to === count - 1 ? "to last" : `after ${nameAt(slot - 1)}`;
    const name = nameAt(from);
    onMoveColumn(from, slot, by);
    // Excel: the moved column stays selected, so the keys can move it on.
    if (rows.length > 0) onSelection?.(selectColumn(to, rows.length, latest.current?.active.r ?? 0));
    orderNote(`Moved ${name} ${where}.${orderMemo}`);
  }

  /** The move keys and the menu's Move left and Move right: the active cell's column, one place. */
  function moveBy(d: -1 | 1) {
    const s = latest.current;
    if (!movable) return;
    if (!s) return orderNote("Select a cell in the column to move first.");
    const p = s.active.c;
    if (p + d < 0 || p + d >= count) return orderNote(`${nameAt(p)} is already ${d < 0 ? "first" : "last"}.`);
    moved(p, d < 0 ? p - 1 : p + 2, "keys");
  }

  /** Reset column order (DataGrip's Reset View): the columns' own order, the active column still active. */
  function resetOrder() {
    if (!onResetOrder) return;
    const s = latest.current;
    const column = s ? at[s.active.c] : undefined;
    onResetOrder();
    if (s && column !== undefined && rows.length > 0) {
      const p = [...at].sort((a, b) => a - b).indexOf(column);
      onSelection?.(isOneColumn(s, rows.length) ? selectColumn(p, rows.length, s.active.r) : single({ r: s.active.r, c: p }));
    }
    orderNote(`Column order reset to ${ownOrderText}.`);
  }

  // The keys act on the focused grid; from the Command Palette (no key pressed) on the one on screen.
  const moveKeys: CommandHandlers = {};
  if (onMoveColumn) {
    const mine = () => pressedKeys() === null || !!scrollRef.current?.contains(document.activeElement);
    for (const [id, d] of [
      ["grid.moveColumnLeft", -1],
      ["grid.moveColumnRight", 1],
    ] as const) {
      Object.defineProperty(moveKeys, id, { enumerable: true, get: () => (mine() ? () => moveBy(d) : undefined) });
    }
  }

  /** The column being dragged (its shown position), while a drag is on: its header and cells dim. */
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLSpanElement>(null);
  const edgeRef = useRef<HTMLSpanElement>(null);
  type Drag = { from: number; slot: number; x: number; offset: number; width: number; started: boolean; stop(): void };
  const dragging = useRef<Drag | null>(null);
  /** The press ended a drag: the header's click must not sort too. */
  const noClick = useRef(false);
  useEffect(() => () => dragging.current?.stop(), []);

  /**
   * Puts the drop marker in the gap nearest the pointer and the ghost header under it (AG Grid), straight on the
   * page: a pointer move never renders the grid again.
   */
  function place() {
    const d = dragging.current;
    const box = scrollRef.current;
    if (!d || !box) return;
    const heads = Array.from(box.querySelectorAll<HTMLElement>("thead th:not(.row-number)"), (th) => th.getBoundingClientRect());
    let slot = 0;
    heads.forEach((b, i) => {
      if (b.left + b.width / 2 < d.x) slot = i + 1;
    });
    d.slot = slot;
    const view = box.getBoundingClientRect();
    const gap = slot < heads.length ? heads[slot].left : (heads[heads.length - 1]?.right ?? view.left);
    const mark = markRef.current;
    if (mark) {
      mark.style.left = `${Math.round(Math.max(view.left + 1, Math.min(view.right - 1, gap)))}px`;
      mark.style.top = `${Math.round(view.top)}px`;
      mark.style.height = `${box.clientHeight}px`;
    }
    const ghost = ghostRef.current;
    if (ghost) {
      ghost.style.left = `${Math.round(Math.max(view.left, Math.min(view.right - d.width, d.x - d.offset)))}px`;
      ghost.style.top = `${Math.round((heads[0]?.top ?? view.top) + 2)}px`;
      ghost.style.width = `${Math.round(d.width)}px`;
    }
    const edge = edgeRef.current;
    if (edge) {
      const left = d.x < view.left + EDGE && box.scrollLeft > 0;
      const right = d.x > view.right - EDGE && box.scrollLeft < box.scrollWidth - box.clientWidth;
      edge.hidden = !left && !right;
      edge.className = left ? "col-drag-edge col-drag-edge-left" : "col-drag-edge col-drag-edge-right";
      edge.style.left = `${Math.round(left ? view.left : view.right - EDGE)}px`;
      edge.style.top = `${Math.round(view.top)}px`;
      edge.style.height = `${box.clientHeight}px`;
    }
  }
  useLayoutEffect(() => {
    if (dragFrom !== null) place();
  }, [dragFrom]);

  /** A press on a header: a click sorts as before; past 4 px it drags the column (AG Grid, DataGrip). */
  function headDown(e: ReactMouseEvent<HTMLElement>, ci: number) {
    noClick.current = false;
    if (selectable) {
      // M9: a click sorts but leaves focus on the grid, so its keys go on working.
      e.preventDefault();
      scrollRef.current?.focus({ preventScroll: true });
    }
    if (!movable || e.button !== 0) return;
    const th = e.currentTarget.closest("th");
    if (!th) return;
    e.preventDefault();
    const head = th.getBoundingClientRect();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let timer: ReturnType<typeof setInterval> | undefined;
    const d: Drag = { from: ci, slot: ci, x: x0, offset: x0 - head.left, width: head.width, started: false, stop: () => {} };
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("keydown", key, true);
      clearInterval(timer);
      document.body.classList.remove("col-moving");
      if (dragging.current === d) dragging.current = null;
      if (d.started) setDragFrom(null);
    };
    const move = (ev: MouseEvent) => {
      d.x = ev.clientX;
      if (!d.started) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) <= DRAG_START) return;
        d.started = true;
        dragging.current = d;
        setDragFrom(ci);
        document.body.classList.add("col-moving");
        orderNote(`Moving ${nameAt(ci)}. Drop it between two headers; Esc puts it back.`);
        // Near a side the grid scrolls on its own, faster the closer the pointer is, so a column can go past the view.
        timer = setInterval(() => {
          const box = scrollRef.current;
          if (!box) return;
          const v = box.getBoundingClientRect();
          const step =
            d.x < v.left + EDGE ? -Math.ceil((v.left + EDGE - d.x) / 3) - 2 : d.x > v.right - EDGE ? Math.ceil((d.x - (v.right - EDGE)) / 3) + 2 : 0;
          if (!step) return;
          const before = box.scrollLeft;
          box.scrollLeft = before + step;
          if (box.scrollLeft !== before) place();
        }, 16);
      }
      place();
    };
    const up = () => {
      stop();
      // A press that never went past 4 px is a click: the header's click sorts.
      if (!d.started) return;
      // Only this release's click is the drag's: a release off the header fires none, so the mark goes once the
      // click would have come, and the next sort (a click or Enter on the header) is never lost.
      noClick.current = true;
      setTimeout(() => (noClick.current = false), 0);
      if (d.slot === d.from || d.slot === d.from + 1) {
        if (rows.length > 0) onSelection?.(selectColumn(d.from, rows.length, latest.current?.active.r ?? 0));
        orderNote("Dropped where it was: the order is unchanged.");
      } else moved(d.from, d.slot, "drag");
    };
    // Esc mid-drag puts the column back (Excel, Windows drag and drop).
    const key = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== "Escape" || !d.started) return;
      ev.preventDefault();
      ev.stopPropagation();
      stop();
      // The button is still held: the click its release may fire is the drag's, not a sort.
      noClick.current = true;
      window.addEventListener("mouseup", () => setTimeout(() => (noClick.current = false), 0), { capture: true, once: true });
      orderNote(`Move cancelled: ${nameAt(d.from)} stays where it was.`);
    };
    d.stop = stop;
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("keydown", key, true);
  }

  /** The header menu: right-click a header, or Shift+F10 and the Menu key on a selected column (DataGrip, DBeaver). */
  const [headMenu, setHeadMenu] = useState<{ pos: number; x: number; y: number } | null>(null);
  // A move or a new set of columns closes it, so it never acts on a column that is no longer there.
  useEffect(() => setHeadMenu(null), [at]);

  function closeHeadMenu() {
    setHeadMenu(null);
    scrollRef.current?.focus({ preventScroll: true });
  }

  function headMenuItems(pos: number): MenuItem[] {
    const c = columns[at[pos]];
    if (!c) return [];
    const heading = `${c.name}, column ${pos + 1} of ${count}`;
    const items: MenuItem[] = [{ key: "head", label: heading, heading }];
    if (onSortTo) {
      items.push(
        { key: "asc", label: "Sort ascending", onSelect: () => onSortTo({ column: c.name, descending: false }) },
        { key: "desc", label: "Sort descending", onSelect: () => onSortTo({ column: c.name, descending: true }) },
      );
    }
    items.push(
      { key: "left", label: "Move left", shortcut: moveKey("grid.moveColumnLeft"), separatorBefore: !!onSortTo, disabled: pos === 0, onSelect: () => moved(pos, pos - 1, "menu") },
      {
        key: "right",
        label: "Move right",
        shortcut: moveKey("grid.moveColumnRight"),
        disabled: pos === count - 1,
        onSelect: () => moved(pos, pos + 2, "menu"),
      },
    );
    if (onResetOrder) {
      const own = orderIsOwn ?? isOwnOrder(at);
      items.push({
        key: "reset",
        label: "Reset column order",
        separatorBefore: true,
        disabled: own,
        title: own ? `The columns are already in ${ownOrderText}` : undefined,
        onSelect: resetOrder,
      });
    }
    return items;
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (typing(e.target)) return;
    // A selected column's menu is its header's: Move left, Move right and Reset column order.
    if (movable && (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && selection && isOneColumn(selection, rows.length)) {
      e.preventDefault();
      const th = scrollRef.current?.querySelectorAll<HTMLElement>("thead th:not(.row-number)")[selection.active.c];
      const b = th?.getBoundingClientRect();
      setHeadMenu({ pos: selection.active.c, x: b ? b.left + 8 : 0, y: b ? b.bottom : 0 });
      return;
    }
    onGridKey?.(e);
    if (e.defaultPrevented || !onSelection) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") {
      // Esc clears the copy mark; it never shrinks the selection (ruling 8).
      if (copied) {
        e.preventDefault();
        setCopied(null);
      }
      return;
    }
    if (mod && !e.altKey && (e.code === "KeyC" || e.key.toLowerCase() === "c")) {
      e.preventDefault();
      copy(e.shiftKey);
      return;
    }
    const page = Math.max(1, visible.last - visible.first - 1);
    const next = navigate(selection, e, dims, page);
    if (next) {
      e.preventDefault();
      onSelection(next);
    }
  }

  const dragged = dragFrom === null ? null : columns[at[dragFrom]];
  return (
    <div
      className="grid-scroll"
      ref={scrollRef}
      onScroll={measureViewport}
      tabIndex={selectable ? 0 : undefined}
      data-pane-focus={selectable || undefined}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onMouseOver={selectable ? dragOver : undefined}
    >
      {count > 0 && (
        <table
          className={[stale ? "grid grid-stale" : "grid", dragFrom !== null ? "grid-moving" : ""].filter(Boolean).join(" ")}
          aria-label={label}
          aria-rowcount={rowCount + 1}
          aria-colcount={count + 1}
          aria-multiselectable={selectable || undefined}
          style={fixed ? { tableLayout: "fixed", width: fixed.reduce((a, b) => a + b, 0) } : undefined}
        >
          {fixed && (
            <colgroup>
              {fixed.map((w, i) => (
                <col key={i} style={{ width: w }} />
              ))}
            </colgroup>
          )}
          <thead>
            <tr aria-rowindex={1}>
              <th
                className={selectable && coversAll(selection, dims) ? "row-number corner-all" : "row-number"}
                scope="col"
                aria-colindex={1}
                title={selectable ? "Select all (Ctrl+A)" : undefined}
                onMouseDown={
                  selectable
                    ? (e) => {
                        if (e.button !== 0 || rowCount === 0) return;
                        e.preventDefault();
                        scrollRef.current?.focus({ preventScroll: true });
                        onSelection?.(selectAll(dims, latest.current?.active));
                      }
                    : undefined
                }
              >
                <span className="visually-hidden">Row</span>
                {corner}
              </th>
              {at.map((di, ci) => {
                const c = columns[di];
                const sorted = sort?.column === c.name ? (sort.descending ? "descending" : "ascending") : "none";
                // The key icon, the name over its type, then a slot that keeps room for the sort icon,
                // so sorting never widens the label past its column.
                const name = (
                  <span className="header-label">
                    {c.isPrimaryKey && <Icon name="key" className="key-icon" size={14} />}
                    {c.isForeignKey && !c.isPrimaryKey && <Icon name="link" className="fk-icon" size={14} />}
                    {/* The name, and its type on a line under it, so "name text" never reads as one label. */}
                    <span className="header-text">
                      <span className="header-name">{c.name}</span>
                      <span className="type-hint">{c.typeName}</span>
                    </span>
                    {onSort && (
                      <span className="sort-slot">
                        {sorted !== "none" && (
                          <Icon name={sorted === "ascending" ? "arrowUp" : "arrowDown"} className="sort-icon" />
                        )}
                      </span>
                    )}
                  </span>
                );
                const cover = selectable ? colCoverage(selection, ci, rowCount) : null;
                const thClass = [c.numeric ? "align-end" : "", cover ? `col-sel-${cover}` : "", dragFrom === ci ? "col-drag-source" : ""]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <th
                    key={`${di}:${c.name}`}
                    scope="col"
                    aria-colindex={ci + 2}
                    aria-sort={onSort ? sorted : undefined}
                    aria-label={`${c.name}, ${c.typeName}`}
                    className={thClass || undefined}
                    onContextMenu={
                      movable
                        ? (e) => {
                            e.preventDefault();
                            // The header's menu acts on its column, which it selects first (DataGrip).
                            if (rows.length > 0) onSelection?.(selectColumn(ci, rows.length, latest.current?.active.r ?? 0));
                            setHeadMenu({ pos: ci, x: e.clientX, y: e.clientY });
                          }
                        : undefined
                    }
                  >
                    {onSort ? (
                      <button
                        type="button"
                        className="header-button"
                        aria-label={`Sort by ${c.name}`}
                        title={movable ? `${c.name} ${c.typeName}. Click to sort; drag sideways to move` : undefined}
                        onMouseDown={selectable || movable ? (e) => headDown(e, ci) : undefined}
                        onClick={(e) => {
                          // A keyboard click (Enter, Space) always sorts.
                          if (noClick.current && e.detail !== 0) {
                            noClick.current = false;
                            return;
                          }
                          onSort(c.name);
                        }}
                      >
                        {name}
                      </button>
                    ) : (
                      <span className="header-static" onMouseDown={movable ? (e) => headDown(e, ci) : undefined}>
                        {name}
                      </span>
                    )}
                    {fixed && ci > 0 && (
                      <span
                        className="col-resize-lead"
                        aria-hidden="true"
                        onMouseDown={(e) => startResize(e, ci - 1)}
                        onDoubleClick={(e) => fitColumn(e, ci - 1)}
                      />
                    )}
                    {fixed && (
                      <span
                        className="col-resize"
                        aria-hidden="true"
                        onMouseDown={(e) => startResize(e, ci)}
                        onDoubleClick={(e) => fitColumn(e, ci)}
                      />
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {start > 0 && <SpacerRow columns={count} height={start * rowHeight.current} />}
            {rows.slice(start, end).map((row, i) => {
              const r = start + i;
              // Every second row by its number, so paging keeps the pattern; a row with a state of its own
              // (new, deleted, conflict) or the selected cell keeps its own colour. `data-grid-stripes` on the
              // root turns the shade on.
              const own = rowClass?.(r);
              const alt = !own && (firstRow + r) % 2 === 0 && active?.r !== r ? "grid-row-alt" : undefined;
              const rowCover = selectable ? rowCoverage(selection, r, count) : null;
              return (
                <tr key={r} data-row={r} aria-rowindex={r + 2} className={own ?? alt}>
                  <td
                    className={rowCover ? `row-number row-sel-${rowCover}` : "row-number"}
                    aria-colindex={1}
                    onMouseDown={selectable ? (e) => rowDown(e, r) : undefined}
                    onContextMenu={
                      onCellMenu
                        ? (e) => {
                            e.preventDefault();
                            const s = latest.current;
                            const full = !!s && rowCoverage(s, r, count) === "full";
                            const next = full && s ? s : selectRows(s, r, r, false, count);
                            if (!full) onSelection?.(next);
                            onCellMenu(r, next.active.r === r ? next.active.c : 0, e.clientX, e.clientY);
                          }
                        : undefined
                    }
                  >
                    {rowLabel?.(r) ?? (firstRow + r).toLocaleString("en-US")}
                  </td>
                  {at.map((di, i) => {
                    // The cell shown at place `i` is column `di` of the row: no row is copied to show an order.
                    const cell = row[di];
                    const isSelected = active?.r === r && active.c === i;
                    const inSel = selectable && contains(selection, r, i);
                    const mark = copied && copied.some((g) => {
                      const n = norm(g);
                      return r >= n.t && r <= n.b && i >= n.l && i <= n.r;
                    });
                    const classes = [
                      cell.t === "number" ? "align-end" : "",
                      cellClass?.(r, i) ?? "",
                      isSelected ? "cell-selected" : "",
                      inSel && !isSelected ? "cell-in" : "",
                      inSel && !contains(selection, r - 1, i) ? "sel-t" : "",
                      inSel && !contains(selection, r + 1, i) ? "sel-b" : "",
                      inSel && !contains(selection, r, i - 1) ? "sel-l" : "",
                      inSel && !contains(selection, r, i + 1) ? "sel-r" : "",
                      mark ? "cell-copied" : "",
                      dragFrom === i ? "col-drag-source" : "",
                    ].filter(Boolean);
                    const custom = renderCell?.(r, i);
                    const link = custom == null ? keyCell?.(r, i) : null;
                    if (link) classes.push("fk-cell");
                    return (
                      <td
                        key={di}
                        data-col={i}
                        aria-colindex={i + 2}
                        className={classes.length ? classes.join(" ") : undefined}
                        // A blank NULL has no size of its own to hover, so the cell says NULL.
                        title={cellTitle?.(r, i) ?? (link?.kind === "null" ? NULL_KEY_TIP : cell.t === "null" && custom == null ? "NULL" : undefined)}
                        aria-selected={selectable ? inSel : undefined}
                        onMouseDown={selectable ? (e) => cellDown(e, r, i) : undefined}
                        onDoubleClick={onOpen ? () => onOpen(r, i) : undefined}
                        onContextMenu={
                          onCellMenu
                            ? (e) => {
                                e.preventDefault();
                                // A right-click inside the selection keeps it; outside, it selects the cell first.
                                const s = latest.current;
                                if (s && contains(s, r, i)) onSelection?.({ ...s, active: { r, c: i } });
                                else onSelection?.(single({ r, c: i }));
                                onCellMenu(r, i, e.clientX, e.clientY);
                              }
                            : undefined
                        }
                      >
                        {custom ?? (
                          <CellValue
                            cell={cell}
                            source={cellSource?.(r, columns[di].name)}
                            boolean={BOOL_TYPE.test(columns[di].typeName)}
                          />
                        )}
                        {link?.kind === "go" && (
                          <button
                            type="button"
                            className="fk-go"
                            tabIndex={-1}
                            title={link.title}
                            aria-label={link.title}
                            // The press selects the cell, as a press anywhere in it does, and keeps focus on the grid.
                            onMouseDown={(e) => {
                              if (e.button !== 0) return;
                              e.preventDefault();
                              e.stopPropagation();
                              scrollRef.current?.focus({ preventScroll: true });
                              onSelection?.(single({ r, c: i }));
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              link.onFollow();
                            }}
                          >
                            <Icon name="arrowRight" size={14} />
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {end < rowCount && <SpacerRow columns={count} height={(rowCount - end) * rowHeight.current} />}
          </tbody>
        </table>
      )}
      {children}
      {/* Only a grid that moves columns takes the keys; a preview grid (Import, Export) adds no key listener. */}
      {onMoveColumn && <CommandKeys handlers={moveKeys} region={scrollRef} />}
      {/* While a column is dragged: a copy of its header under the pointer, the drop marker between two headers and
          the glow of a side the grid is scrolling to. On the page itself, so no pane clips or contains them. */}
      {dragged &&
        createPortal(
          <>
            <div ref={ghostRef} className="col-drag-ghost" aria-hidden="true">
              <span className="header-text">
                <span className="header-name">{dragged.name}</span>
                <span className="type-hint">{dragged.typeName}</span>
              </span>
            </div>
            <span ref={markRef} className="col-drag-mark" aria-hidden="true" />
            <span ref={edgeRef} className="col-drag-edge" aria-hidden="true" hidden />
          </>,
          document.body,
        )}
      {headMenu &&
        createPortal(
          <PointMenu x={headMenu.x} y={headMenu.y} items={headMenuItems(headMenu.pos)} label="Column" onClose={closeHeadMenu} onDismiss={() => setHeadMenu(null)} />,
          document.body,
        )}
    </div>
  );
}
