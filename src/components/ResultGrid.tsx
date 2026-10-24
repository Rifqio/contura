import {
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
  navigate,
  norm,
  type Range,
  rowCoverage,
  selectAll,
  selectRows,
  type Selection,
  single,
} from "../grid/selection";
import { writeClipboard } from "../grid/clipboard";
import CellValue, { type CellSource } from "./CellValue";
import { cellContentWidth, fitColumns, fitToContent, headerFloor, headerPadding, headerWidth } from "./columnWidths";
import Icon from "./Icon";

/** Rows are one line high (app.css `.grid td`); measured once rendered. */
const FALLBACK_ROW_HEIGHT = 28;
/** The header button's side padding (app.css `--grid-header-padding`), both sides. */
const HEADER_PADDING = 16;
const BOOL_TYPE = /^bool(ean)?$/i;
/** Rows rendered above and below the visible ones. */
const OVERSCAN = 20;

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
}

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
/** Widths the user dragged or fitted, by column name, while their `widthsKey` stays. */
type Pins = { key: unknown; px: Record<string, number> };

/**
 * A read-only, virtualized grid: only the rows near the viewport are in the DOM,
 * spacer rows stand in for the rest. Used by the table view and query results.
 */
export default function ResultGrid({
  columns,
  rows,
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
  const cols = columns.map((c) => c.name).join("\u0000");

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
    const natural = heads.map((th) => th.offsetWidth);
    // The header cell's own side borders take room from the label too.
    const measureHeads = (f: (label: HTMLElement, padding: number) => number) =>
      heads.map((th) => {
        const label = th.querySelector<HTMLElement>(".header-label");
        return label ? f(label, headerPadding(th, HEADER_PADDING)) : HEADER_PADDING;
      });
    const header = measureHeads(headerWidth);
    const floor = measureHeads(headerFloor);
    const ok = gutter > 0 && natural.length > 0 && natural.every((w) => w > 0);
    measured.current = ok;
    setMeasure(ok ? { key: resetKey, cols, gutter, natural, header, floor } : null);
    setAvailable(box.clientWidth);
  }, [resetKey, cols, epoch]);

  const rowCount = rows.length;
  const start = Math.max(0, visible.first - OVERSCAN);
  const end = Math.min(rowCount, visible.last + OVERSCAN);
  const current = measure && measure.key === resetKey && measure.cols === cols ? measure : null;
  const pinned = pins && current && pins.key === widthsKey ? columns.map((c) => pins.px[c.name] ?? null) : null;
  const fixed = current
    ? [
        current.gutter,
        ...fitColumns({
          natural: current.natural,
          header: current.header,
          // One px less: the collapsed outer border adds a fraction of a px past the set width,
          // which would otherwise show a horizontal scrollbar on a pane the grid exactly fills.
          available: available - current.gutter - 1,
          pinned: pinned ?? current.natural.map(() => null),
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
    onResized?.();
    pin(columns[ci].name, fitToContent({ header: current.header[ci], floor: current.floor[ci] ?? current.header[ci], cells }));
  }

  function startResize(e: ReactMouseEvent, ci: number) {
    if (e.button !== 0 || !current || !fixed) return;
    e.preventDefault();
    e.stopPropagation();
    stopDrag.current?.();
    const startX = e.clientX;
    const startWidth = fixed[ci + 1];
    const min = current.floor[ci] ?? current.header[ci];
    const name = columns[ci].name;
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

  // The moving corner of the selection stays in view; a row not rendered yet is scrolled to first.
  const endRow = selection?.end.r;
  const endCol = selection?.end.c;
  useEffect(() => {
    if (endRow === undefined || endCol === undefined) return;
    const box = scrollRef.current;
    const td = box?.querySelector<HTMLElement>(`tr[data-row="${endRow}"] td[data-col="${endCol}"]`);
    if (td) td.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    else if (box) box.scrollTop = Math.max(0, endRow * rowHeight.current - box.clientHeight / 2);
  }, [endRow, endCol]);

  const selectable = !!onSelection;
  const active = selection && selectable ? selection.active : null;

  // G1: the copied block wears a dashed mark until Esc or a change of the rows (an edit).
  const [copied, setCopied] = useState<Range[] | null>(null);
  useEffect(() => setCopied(null), [rows]);

  function copy(headers: boolean) {
    if (!selection) return;
    const b = block(selection);
    if (!b) {
      onNote?.("Not copied: copy takes one block, or blocks sharing rows or columns.");
      return;
    }
    const text = copyText(
      b,
      (r, c) => copyValue(rows[r]?.[c]),
      headers ? b.cols.map((c) => columns[c].name) : undefined,
    );
    // The note says it was copied at once; a clipboard that refuses takes the copy mark and the note back (M2).
    void writeClipboard(text).then((ok) => {
      if (ok) return;
      setCopied(null);
      onNote?.("Not copied: the clipboard refused.");
    });
    setCopied(selection.ranges.map((g) => ({ ...g })));
    let cut = 0;
    for (const r of b.rows) for (const c of b.cols) if (cutShort(rows[r]?.[c])) cut++;
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

  const dims = { rows: rows.length, cols: columns.length };
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
    if (!onSelection || e.button !== 0 || columns.length === 0) return;
    e.preventDefault();
    const s = latest.current;
    const next = e.shiftKey && s ? extendRowsTo(s, r, columns.length) : selectRows(s, r, r, (e.ctrlKey || e.metaKey) && !!s, columns.length);
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
      if (s.end.r !== r) onSelection(extendRowsTo(s, r, columns.length));
      return;
    }
    const td = el.closest("td[data-col]");
    if (!td) return;
    const c = Number(td.getAttribute("data-col"));
    if (s.end.r !== r || s.end.c !== c) onSelection(extendTo(s, { r, c }));
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (typing(e.target)) return;
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
      {columns.length > 0 && (
        <table
          className={stale ? "grid grid-stale" : "grid"}
          aria-label={label}
          aria-rowcount={rowCount + 1}
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
              {columns.map((c, ci) => {
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
                const thClass = [c.numeric ? "align-end" : "", cover ? `col-sel-${cover}` : ""].filter(Boolean).join(" ");
                return (
                  <th
                    key={`${ci}:${c.name}`}
                    scope="col"
                    aria-sort={onSort ? sorted : undefined}
                    aria-label={`${c.name}, ${c.typeName}`}
                    className={thClass || undefined}
                  >
                    {onSort ? (
                      <button
                        type="button"
                        className="header-button"
                        aria-label={`Sort by ${c.name}`}
                        // M9: a click sorts but leaves focus on the grid, so its keys go on working.
                        onMouseDown={
                          selectable
                            ? (e) => {
                                e.preventDefault();
                                scrollRef.current?.focus({ preventScroll: true });
                              }
                            : undefined
                        }
                        onClick={() => onSort(c.name)}
                      >
                        {name}
                      </button>
                    ) : (
                      <span className="header-static">{name}</span>
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
            {start > 0 && <SpacerRow columns={columns.length} height={start * rowHeight.current} />}
            {rows.slice(start, end).map((row, i) => {
              const r = start + i;
              // Every second row by its number, so paging keeps the pattern; a row with a state of its own
              // (new, deleted, conflict) or the selected cell keeps its own colour. `data-grid-stripes` on the
              // root turns the shade on.
              const own = rowClass?.(r);
              const alt = !own && (firstRow + r) % 2 === 0 && active?.r !== r ? "grid-row-alt" : undefined;
              const rowCover = selectable ? rowCoverage(selection, r, columns.length) : null;
              return (
                <tr key={r} data-row={r} aria-rowindex={r + 2} className={own ?? alt}>
                  <td
                    className={rowCover ? `row-number row-sel-${rowCover}` : "row-number"}
                    onMouseDown={selectable ? (e) => rowDown(e, r) : undefined}
                    onContextMenu={
                      onCellMenu
                        ? (e) => {
                            e.preventDefault();
                            const s = latest.current;
                            const full = !!s && rowCoverage(s, r, columns.length) === "full";
                            const next = full && s ? s : selectRows(s, r, r, false, columns.length);
                            if (!full) onSelection?.(next);
                            onCellMenu(r, next.active.r === r ? next.active.c : 0, e.clientX, e.clientY);
                          }
                        : undefined
                    }
                  >
                    {rowLabel?.(r) ?? (firstRow + r).toLocaleString("en-US")}
                  </td>
                  {row.map((cell, i) => {
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
                    ].filter(Boolean);
                    const custom = renderCell?.(r, i);
                    return (
                      <td
                        key={i}
                        data-col={i}
                        className={classes.length ? classes.join(" ") : undefined}
                        // A blank NULL has no size of its own to hover, so the cell says NULL.
                        title={cellTitle?.(r, i) ?? (cell.t === "null" && custom == null ? "NULL" : undefined)}
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
                            source={cellSource?.(r, columns[i].name)}
                            boolean={BOOL_TYPE.test(columns[i].typeName)}
                          />
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {end < rowCount && <SpacerRow columns={columns.length} height={(rowCount - end) * rowHeight.current} />}
          </tbody>
        </table>
      )}
      {children}
    </div>
  );
}
