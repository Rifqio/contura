import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { errorText, fetchPage, isNotOpen } from "../api/client";
import type { ColumnInfo, ConnectionId, KeyPart, ObjectPath, Page, SortSpec } from "../api/types";
import CellValue from "./CellValue";
import Icon from "./Icon";
import { objectPrefix } from "../objectPath";

const PAGE_SIZE = 1000;
const NUMERIC_TYPE = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|year)\b/i;
/** Rows are one line high (app.css `.grid td`); measured once rendered. */
const FALLBACK_ROW_HEIGHT = 40;
/** Rows rendered above and below the visible ones. */
const OVERSCAN = 20;

interface Props {
  connectionId: ConnectionId;
  table: ObjectPath;
  onClose: () => void;
  /** The session is gone; the Connection must be opened again. */
  onNotOpen?: () => void;
}

/** The page on screen and its index. Replaced, never accumulated. */
type Shown = { index: number; page: Page };

function nextSort(current: SortSpec | null, column: string): SortSpec {
  if (current?.column === column) return { column, descending: !current.descending };
  return { column, descending: false };
}

/** Holds the scroll height of rows that are not rendered. */
function SpacerRow({ columns, height }: { columns: number; height: number }) {
  return (
    <tr className="grid-spacer" aria-hidden="true">
      <td colSpan={columns + 1} style={{ height }} />
    </tr>
  );
}

function rowKey(columns: ColumnInfo[], row: Page["rows"][number]): KeyPart[] {
  return columns.flatMap((c, i) => (c.isPrimaryKey ? [{ column: c.name, value: row[i] }] : []));
}

/** The visible rows, by index into the page, before overscan and clamping. */
type Visible = { first: number; last: number };

/** Column widths fixed from the page's first render, so scrolling never reflows them. */
type Widths = { page: Page; px: number[] };

/**
 * The read-only grid for one table or view. Only the current page lives in
 * state (ADR 0003): moving to another page replaces it, and the parent keys
 * this component by table so opening another table starts fresh. Only the
 * rows near the viewport are in the DOM; spacer rows stand in for the rest.
 */
export default function DataGrid({ connectionId, table, onClose, onNotOpen }: Props) {
  const [pageIndex, setPageIndex] = useState(0);
  const [sort, setSort] = useState<SortSpec | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = useRef(FALLBACK_ROW_HEIGHT);
  const [visible, setVisible] = useState<Visible>({ first: 0, last: 0 });
  const [widths, setWidths] = useState<Widths | null>(null);

  // `table` is fixed for this component's lifetime: the parent re-keys it per table.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fetchPage(connectionId, { table, page: pageIndex, sort })
      .then((page) => {
        if (!live) return;
        setShown({ index: pageIndex, page });
        setVisible({ first: 0, last: 0 });
      })
      .catch((e) => {
        if (!live) return;
        if (isNotOpen(e)) onNotOpen?.();
        setError(errorText(e));
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [connectionId, pageIndex, sort, attempt]);

  function chooseSort(column: string) {
    setSort((s) => nextSort(s, column));
    setPageIndex(0);
  }

  function clearSort() {
    setSort(null);
    setPageIndex(0);
  }

  const page = shown?.page ?? null;
  const columns = page?.columns ?? [];
  const firstRow = (shown?.index ?? 0) * PAGE_SIZE + 1;

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

  // A new page starts at its top, with its row height and column widths taken
  // from this first render, before the browser paints.
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box || !page) return;
    box.scrollTop = 0;
    const firstRowEl = box.querySelector<HTMLElement>("tr[data-row]");
    if (firstRowEl && firstRowEl.offsetHeight > 0) rowHeight.current = firstRowEl.offsetHeight;
    const px = Array.from(box.querySelectorAll<HTMLElement>("thead th"), (th) => th.offsetWidth);
    setWidths(px.length > 0 && px.every((w) => w > 0) ? { page, px } : null);
    measureViewport();
  }, [page, measureViewport]);

  const rowCount = page?.rows.length ?? 0;
  const start = Math.max(0, visible.first - OVERSCAN);
  const end = Math.min(rowCount, visible.last + OVERSCAN);
  const fixed = widths && widths.page === page ? widths.px : null;
  const rangeText =
    page && page.rows.length > 0
      ? `Rows ${firstRow.toLocaleString("en-US")} to ${(firstRow + page.rows.length - 1).toLocaleString("en-US")}`
      : "";

  return (
    <section className="grid-view" aria-label={`Data of ${table.name}`}>
      <div className="toolbar">
        <Icon name="table" className="muted" />
        <h2 className="toolbar-title">
          <span className="muted">{objectPrefix(table)}</span>
          {table.name}
        </h2>
        <span className="toolbar-meta">
          {loading && <span>Loading rows…</span>}
          {rangeText && <span>{rangeText}</span>}
        </span>
        <button type="button" className="icon-button" aria-label={`Close ${table.name}`} onClick={onClose}>
          <Icon name="close" />
        </button>
        <div className={loading ? "progress progress-on" : "progress"} aria-hidden="true">
          <i />
        </div>
      </div>

      <div className="grid-scroll" ref={scrollRef} onScroll={measureViewport}>
        {error ? (
          <div className="state-panel" role="alert">
            <p className="error-text">{error}</p>
            <button type="button" className="button" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
            {sort && (
              <button type="button" className="button" onClick={clearSort}>
                Clear sort
              </button>
            )}
          </div>
        ) : (
          columns.length > 0 && (
            <table
              className={loading ? "grid grid-stale" : "grid"}
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
                  </th>
                  {columns.map((c) => {
                    const numeric = NUMERIC_TYPE.test(c.typeName);
                    const sorted = sort?.column === c.name ? (sort.descending ? "descending" : "ascending") : "none";
                    return (
                      <th key={c.name} scope="col" aria-sort={sorted} className={numeric ? "align-end" : undefined}>
                        <button
                          type="button"
                          className="header-button"
                          aria-label={`Sort by ${c.name}`}
                          onClick={() => chooseSort(c.name)}
                        >
                          <span className="header-name">
                            {c.isPrimaryKey && <Icon name="key" className="key-icon" />}
                            {c.name}
                            {sorted !== "none" && (
                              <Icon name={sorted === "ascending" ? "arrowUp" : "arrowDown"} className="sort-icon" />
                            )}
                          </span>
                          <span className="type-hint">{c.typeName}</span>
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {start > 0 && <SpacerRow columns={columns.length} height={start * rowHeight.current} />}
                {page?.rows.slice(start, end).map((row, i) => {
                  const r = start + i;
                  const key = rowKey(page.columns, row);
                  return (
                    <tr key={r} data-row={r} aria-rowindex={r + 2}>
                      <td className="row-number">{(firstRow + r).toLocaleString("en-US")}</td>
                      {row.map((cell, i) => (
                        <td key={i} className={cell.t === "number" ? "align-end" : undefined}>
                          <CellValue
                            cell={cell}
                            source={{ connectionId, table, column: page.columns[i].name, rowKey: key }}
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })}
                {end < rowCount && (
                  <SpacerRow columns={columns.length} height={(rowCount - end) * rowHeight.current} />
                )}
              </tbody>
            </table>
          )
        )}
        {!error && page && page.rows.length === 0 && (
          <p className="state-panel muted">
            {shown?.index === 0 ? `${table.name} has no rows.` : "No more rows. Go back a page."}
          </p>
        )}
      </div>

      <div className="status-bar">
        <span className="pager">
          <button
            type="button"
            className="icon-button"
            aria-label="Previous page"
            disabled={pageIndex === 0 || loading}
            onClick={() => setPageIndex((p) => p - 1)}
          >
            <Icon name="chevronLeft" />
          </button>
          <span>Page {(pageIndex + 1).toLocaleString("en-US")}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Next page"
            disabled={loading || !page?.hasMore}
            onClick={() => setPageIndex((p) => p + 1)}
          >
            <Icon name="chevronRight" />
          </button>
        </span>
      </div>
    </section>
  );
}
