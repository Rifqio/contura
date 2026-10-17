import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Cell, SortSpec } from "../api/types";
import CellValue, { type CellSource } from "./CellValue";
import Icon from "./Icon";

/** Rows are one line high (app.css `.grid td`); measured once rendered. */
const FALLBACK_ROW_HEIGHT = 40;
/** Rows rendered above and below the visible ones. */
const OVERSCAN = 20;

export interface GridColumn {
  name: string;
  typeName: string;
  numeric: boolean;
  isPrimaryKey?: boolean;
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
  /** Shown after the table, such as an empty-state line. */
  children?: ReactNode;
  /** In the header corner above the row numbers, such as the Read-only lock. */
  corner?: ReactNode;
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
/** Column widths fixed from the first render after a reset, so scrolling never reflows them. */
type Widths = { key: unknown; px: number[] };

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
  children,
  corner,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = useRef(FALLBACK_ROW_HEIGHT);
  const [visible, setVisible] = useState<Visible>({ first: 0, last: 0 });
  const [widths, setWidths] = useState<Widths | null>(null);

  const measureViewport = useCallback(() => {
    const box = scrollRef.current;
    if (!box) return;
    const h = rowHeight.current;
    const first = Math.floor(box.scrollTop / h);
    const last = Math.ceil((box.scrollTop + box.clientHeight) / h);
    setVisible((v) => (v.first === first && v.last === last ? v : { first, last }));
  }, []);

  useEffect(() => {
    const box = scrollRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureViewport);
    observer.observe(box);
    return () => observer.disconnect();
  }, [measureViewport]);

  // A reset starts at the top, with the row height and column widths taken
  // from this first render, before the browser paints.
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    box.scrollTop = 0;
    const firstRowEl = box.querySelector<HTMLElement>("tr[data-row]");
    if (firstRowEl && firstRowEl.offsetHeight > 0) rowHeight.current = firstRowEl.offsetHeight;
    const px = Array.from(box.querySelectorAll<HTMLElement>("thead th"), (th) => th.offsetWidth);
    setWidths(px.length > 0 && px.every((w) => w > 0) ? { key: resetKey, px } : null);
    setVisible({ first: 0, last: 0 });
    measureViewport();
  }, [resetKey, measureViewport]);

  const rowCount = rows.length;
  const start = Math.max(0, visible.first - OVERSCAN);
  const end = Math.min(rowCount, visible.last + OVERSCAN);
  const fixed = widths && widths.key === resetKey ? widths.px : null;

  useEffect(() => {
    if (onNearEnd && rowCount > 0 && visible.last >= rowCount - OVERSCAN) onNearEnd();
  }, [visible.last, rowCount]);

  return (
    <div className="grid-scroll" ref={scrollRef} onScroll={measureViewport}>
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
                const name = (
                  <>
                    <span className="header-name">
                      {c.isPrimaryKey && <Icon name="key" className="key-icon" />}
                      {c.name}
                      {sorted !== "none" && (
                        <Icon name={sorted === "ascending" ? "arrowUp" : "arrowDown"} className="sort-icon" />
                      )}
                    </span>
                    <span className="type-hint">{c.typeName}</span>
                  </>
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
                <tr key={r} data-row={r} aria-rowindex={r + 2}>
                  <td className="row-number">{(firstRow + r).toLocaleString("en-US")}</td>
                  {row.map((cell, i) => (
                    <td key={i} className={cell.t === "number" ? "align-end" : undefined}>
                      <CellValue cell={cell} source={cellSource?.(r, columns[i].name)} />
                    </td>
                  ))}
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
