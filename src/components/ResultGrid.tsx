import {
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Cell, SortSpec } from "../api/types";
import CellValue, { type CellSource } from "./CellValue";
import { fitColumns, headerFloor, headerPadding, headerWidth } from "./columnWidths";
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
  /** Editing hooks for the table grid; query results pass none of them. */
  selected?: { row: number; column: number } | null;
  onSelect?(row: number, column: number): void;
  onOpen?(row: number, column: number): void;
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
/** Widths the user dragged, per reset. */
type Pins = { key: unknown; cols: string; px: (number | null)[] };

/**
 * A read-only, virtualized grid: only the rows near the viewport are in the DOM,
 * spacer rows stand in for the rest. Used by the table view and query results.
 */
export default function ResultGrid({
  columns,
  rows,
  resetKey,
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
  selected = null,
  onSelect,
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
  const pinned = pins && current && pins.key === resetKey && pins.cols === cols ? pins.px : null;
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
  function startResize(e: ReactMouseEvent, ci: number) {
    if (e.button !== 0 || !current || !fixed) return;
    e.preventDefault();
    e.stopPropagation();
    stopDrag.current?.();
    const startX = e.clientX;
    const startWidth = fixed[ci + 1];
    const min = current.floor[ci] ?? current.header[ci];
    const { key, cols: sig } = current;
    const count = current.natural.length;
    const move = (ev: MouseEvent) => {
      const w = Math.max(min, Math.round(startWidth + ev.clientX - startX));
      setPins((p) => {
        const px = p && p.key === key && p.cols === sig ? [...p.px] : Array<number | null>(count).fill(null);
        px[ci] = w;
        return { key, cols: sig, px };
      });
    };
    const stop = () => {
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

  useEffect(() => {
    if (!selected) return;
    const td = scrollRef.current?.querySelector<HTMLElement>(
      `tr[data-row="${selected.row}"] td[data-col="${selected.column}"]`,
    );
    td?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selected?.row, selected?.column]);

  const editable = !!onSelect;

  return (
    <div
      className="grid-scroll"
      ref={scrollRef}
      onScroll={measureViewport}
      tabIndex={editable ? 0 : undefined}
      onKeyDown={onGridKey}
      onPaste={onPaste}
    >
      {columns.length > 0 && (
        <table
          className={stale ? "grid grid-stale" : "grid"}
          aria-label={label}
          aria-rowcount={rowCount + 1}
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
              <th className="row-number" scope="col">
                <span className="visually-hidden">Row</span>
                {corner}
              </th>
              {columns.map((c, ci) => {
                const sorted = sort?.column === c.name ? (sort.descending ? "descending" : "ascending") : "none";
                // One line: name, type hint, then a slot that keeps room for the sort icon,
                // so sorting never widens the label past its column.
                const name = (
                  <span className="header-label">
                    {c.isPrimaryKey && <Icon name="key" className="key-icon" size={14} />}
                    {c.isForeignKey && !c.isPrimaryKey && <Icon name="link" className="fk-icon" size={14} />}
                    <span className="header-name">{c.name}</span>
                    <span className="type-hint">{c.typeName}</span>
                    {onSort && (
                      <span className="sort-slot">
                        {sorted !== "none" && (
                          <Icon name={sorted === "ascending" ? "arrowUp" : "arrowDown"} className="sort-icon" />
                        )}
                      </span>
                    )}
                  </span>
                );
                return (
                  <th
                    key={`${ci}:${c.name}`}
                    scope="col"
                    aria-sort={onSort ? sorted : undefined}
                    className={c.numeric ? "align-end" : undefined}
                  >
                    {onSort ? (
                      <button
                        type="button"
                        className="header-button"
                        aria-label={`Sort by ${c.name}`}
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
              return (
                <tr key={r} data-row={r} aria-rowindex={r + 2} className={rowClass?.(r)}>
                  <td className="row-number">{rowLabel?.(r) ?? (firstRow + r).toLocaleString("en-US")}</td>
                  {row.map((cell, i) => {
                    const isSelected = selected?.row === r && selected.column === i;
                    const classes = [
                      cell.t === "number" ? "align-end" : "",
                      cellClass?.(r, i) ?? "",
                      isSelected ? "cell-selected" : "",
                    ].filter(Boolean);
                    const custom = renderCell?.(r, i);
                    return (
                      <td
                        key={i}
                        data-col={i}
                        className={classes.length ? classes.join(" ") : undefined}
                        title={cellTitle?.(r, i)}
                        aria-selected={editable ? isSelected : undefined}
                        onMouseDown={editable ? () => onSelect?.(r, i) : undefined}
                        onDoubleClick={onOpen ? () => onOpen(r, i) : undefined}
                        onContextMenu={
                          onCellMenu
                            ? (e) => {
                                e.preventDefault();
                                onSelect?.(r, i);
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
