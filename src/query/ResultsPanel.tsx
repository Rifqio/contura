import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Cell, DialectKind, SortSpec } from "../api/types";
import InlineAsk from "../assistant/InlineAsk";
import { type AskContext, type AskSetup, tablesIn } from "../assistant/context";
import { hintFor } from "../commands/keymap";
import { useCommandKeys, useKeymap } from "../commands/useCommandKeys";
import type { ExportOrigin } from "../jobs/exportText";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import { MenuList, type MenuItem } from "../components/Menu";
import { durationText } from "../format/units";
import ResultGrid, { type GridHandle } from "../components/ResultGrid";
import { FullValueDialog } from "../components/CellValue";
import { altGraph, cellCount, isLetter, remapRows, rowsOf, type Selection, wholeRows } from "../grid/selection";
import PlanView from "./PlanView";
import QueryError from "./QueryError";
import ResultTools, { cellText } from "./ResultTools";
import type { ResultItem, RunnerState } from "./runner";

const fmt = (n: number) => n.toLocaleString("en-US");
const verbOf = (sql: string) => /^\s*(\w+)/.exec(sql.replace(/^(\s*(--[^\n]*|\/\*[\s\S]*?\*\/)\s*)+/, ""))?.[1]?.toUpperCase() ?? "";
const WRITES = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE"]);

interface Props {
  state: RunnerState;
  /** A Production Connection: the pane carries the wash. */
  production?: boolean;
  timeoutSecs: number | null;
  /** The line number of an offset in the editor text. */
  lineAt(offset: number): number;
  /** The column of an offset in the editor text, from 1. */
  columnAt?(offset: number): number;
  dialect?: DialectKind;
  connectionName?: string;
  /** Table and column names in the loaded tree, for the error's "Did you mean". */
  names?: string[];
  /** Table names alone, for a missing table. */
  tableNames?: string[];
  /** Where a missing table was looked for, such as "shop.public". */
  scope?: string | null;
  /** Run the failed statement and those after it again, once the Connection is back. */
  onReconnect?(): void;
  onCopy?(text: string): void;
  onSelect(index: number): void;
  onPin(id: number): void;
  /** Closes one result (its tab's close button, Delete, or its right-click menu). */
  onClose?(id: number): void;
  onCloseUnpinned(): void;
  onFetchMore(id: number): void;
  onCancel(): void;
  onRunAgain(id: number): void;
  onGoTo(from: number, to: number): void;
  /** Ask AI on a failed query; without it, or with `errorAsk` off, the button is absent. */
  ask?: AskSetup;
  /** One more action in a failed statement's error box. */
  errorAction?: ReactNode;
  /** The session's database, for a result export. */
  database?: string | null;
  /** Opens the Export dialog on the shown result (the menu's Export..., and Ctrl+E here). No Import here (Q16). */
  onExport?(origin: ExportOrigin): void;
  /** Item 40: one statement, one result (the Visual Query): no result tabs, only the summary and the tools. */
  single?: boolean;
}

/** After a reconnect ran statement N alone (R43): "Statements 3 and 4 did not run." */
function notRunText(index: number, count: number): string {
  const nums = Array.from({ length: count }, (_, i) => index + 1 + i);
  if (nums.length === 1) return `Statement ${nums[0]} did not run.`;
  return `Statements ${nums.slice(0, -1).join(", ")} and ${nums[nums.length - 1]} did not run.`;
}

function tabLabel(item: ResultItem): string {
  const st = item.state;
  if (st.s === "plan") return "Plan";
  if (st.s === "error") return st.index === undefined ? "Plan" : `Statement ${st.index}`;
  if (st.s === "affected") return verbOf(item.sql) || `Result ${item.id}`;
  return `Result ${item.id}`;
}

/** A result tab carries no status mark (E5); a running one shows the spinner and a failed one a danger icon. */
function StateMark({ item }: { item: ResultItem }) {
  if (item.state.s === "running") return <span className="spinner spinner-small" aria-hidden="true" />;
  if (item.state.s === "error") return <Icon name="error" size={14} className="result-tab-danger" />;
  return null;
}

/**
 * G7: the loaded rows sorted by one column, as AG Grid and DataGrip sort on the client: NULL (and empty) last both
 * ways, numbers by value. The sort is stable, so equal values keep the order the server sent.
 */
export function sortLoaded(rows: Cell[][], ids: number[], column: number, descending: boolean): number[] {
  const blank = (c: Cell | undefined) => !c || c.t === "null" || (c.t === "text" && c.value === "");
  const dir = descending ? -1 : 1;
  return [...ids]
    .sort((ai, bi) => {
      const x = rows[ai][column];
      const y = rows[bi][column];
      if (blank(x) || blank(y)) return blank(x) && blank(y) ? ai - bi : blank(x) ? 1 : -1;
      let d: number;
      if (x.t === "number" && y.t === "number") d = Number(x.value) - Number(y.value);
      else d = cellText(x).localeCompare(cellText(y));
      return d !== 0 && !Number.isNaN(d) ? d * dir : ai - bi;
    });
}

/** G11's order on loaded rows: ascending, descending, then off. */
function nextSort(current: SortSpec | null, column: string): SortSpec | null {
  if (current?.column === column) return current.descending ? null : { column, descending: true };
  return { column, descending: false };
}

const readOnlyNote = (what: string) => `Results are read-only: ${what} works in the table grid.`;

/** The edit keys of the table grid, by what the note calls them; null for a key results act on or let pass. */
function editKeyName(e: KeyboardEvent): string | null {
  if (altGraph(e)) return "typing";
  const mod = e.ctrlKey || e.metaKey;
  const letter = (l: string) => isLetter(e, l);
  if (mod && e.altKey && letter("n")) return "Set NULL";
  if (mod && e.altKey && letter("d")) return "Set DEFAULT";
  if (e.altKey && e.key === "Delete") return "deleting rows";
  if ((e.altKey && e.key === "Insert") || (mod && !e.altKey && !e.shiftKey && letter("n"))) return "adding rows";
  if (mod && !e.altKey && !e.shiftKey && letter("d")) return "duplicating rows";
  if (mod && !e.altKey && letter("v")) return "pasting";
  if (mod || e.altKey) return null;
  if (e.key === "Delete" || e.key === "Backspace") return "Delete";
  if (e.key === "Enter" || (e.key === "F2" && !e.shiftKey)) return "editing";
  if (e.key.length === 1 && !(e.key === " " && e.shiftKey)) return "typing";
  return null;
}

/** A result tab's right-click menu at a point, kept inside the window. */
function TabMenu({ x, y, items, onClose, label = "Result" }: { x: number; y: number; items: MenuItem[]; onClose: () => void; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x, y });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || box.height === 0) return;
    setAt({ x: Math.max(4, Math.min(x, window.innerWidth - box.width - 4)), y: Math.max(4, Math.min(y, window.innerHeight - box.height - 4)) });
  }, [x, y]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);
  return (
    <div ref={ref} className="tree-menu" style={{ left: at.x, top: at.y }}>
      <MenuList items={items} label={label} onClose={onClose} compact />
    </div>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const t = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(t);
  }, []);
  return <span className="result-timer">{durationText(Math.max(0, now - since))}</span>;
}

export default function ResultsPanel({
  state,
  production = false,
  timeoutSecs,
  lineAt,
  columnAt,
  dialect = "postgres",
  connectionName,
  names = [],
  tableNames,
  scope = null,
  onReconnect,
  onCopy,
  onSelect,
  onPin,
  onClose,
  onCloseUnpinned,
  onFetchMore,
  onCancel,
  onRunAgain,
  onGoTo,
  ask,
  errorAction,
  database = null,
  onExport,
  single = false,
}: Props) {
  const { map } = useKeymap();
  const runKey = hintFor(map, "query.run");
  const [askOpen, setAskOpen] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ id: number; x: number; y: number } | null>(null);
  const tabRefs = useRef(new Map<number, HTMLButtonElement>());
  const item = state.items[state.active];
  const [filter, setFilter] = useState("");
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [range, setRange] = useState<{ first: number; last: number } | null>(null);
  /** G7: the result grid's selection, header sort, status line, cell menu and full value. */
  const [selection, setSelection] = useState<Selection | null>(null);
  const [sort, setSort] = useState<SortSpec | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [cellMenu, setCellMenu] = useState<{ row: number; column: number; x: number; y: number } | null>(null);
  const [full, setFull] = useState<{ title: string; cell: Cell } | null>(null);
  const gridRef = useRef<GridHandle | null>(null);
  useEffect(() => {
    setAskOpen(false);
    setFilter("");
    setHidden(new Set());
    setRange(null);
    setSelection(null);
    setSort(null);
    setNote(null);
    setCellMenu(null);
  }, [item?.id]);
  const rowsState = item?.state.s === "rows" ? item.state : null;
  const needle = filter.trim().toLowerCase();
  const filteredRows = useMemo(
    () => (rowsState && needle ? rowsState.rows.filter((r) => r.some((c) => cellText(c).toLowerCase().includes(needle))) : rowsState?.rows ?? []),
    [rowsState?.rows, needle],
  );
  // The columns on screen and the rows as shown: filtered, then sorted; one array while they stay the same.
  const keep = useMemo(
    () => (rowsState ? rowsState.columns.map((c, i) => (hidden.has(c.name) ? -1 : i)).filter((i) => i >= 0) : []),
    [rowsState?.columns, hidden],
  );
  /** I3: each row on screen by its place in load order, so a selection follows its rows. */
  const shownIds = useMemo(() => {
    const all = rowsState?.rows ?? [];
    const ids = needle ? all.flatMap((r, i) => (r.some((c) => cellText(c).toLowerCase().includes(needle)) ? [i] : [])) : all.map((_, i) => i);
    const at = sort && rowsState ? rowsState.columns.findIndex((c) => c.name === sort.column) : -1;
    return at >= 0 ? sortLoaded(all, ids, at, !!sort?.descending) : ids;
  }, [rowsState?.rows, needle, sort, rowsState?.columns]);
  const shownRows = useMemo(() => {
    const all = rowsState?.rows ?? [];
    const project = rowsState && keep.length !== rowsState.columns.length;
    return shownIds.map((i) => (project ? keep.map((k) => all[i][k]) : all[i]));
  }, [shownIds, keep, rowsState?.rows, rowsState?.columns]);
  // Another sort, filter or set of columns starts the selection over; more rows keep it on its rows.
  const viewKey = `${item?.id}|${sort?.column}|${sort?.descending}|${needle}|${keep.join(",")}`;
  const before = useRef<{ key: string; ids: number[]; count: number } | null>(null);
  useEffect(() => {
    const prev = before.current;
    const count = rowsState?.rows.length ?? 0;
    before.current = { key: viewKey, ids: shownIds, count };
    if (!prev || prev.key !== viewKey) return setSelection(null);
    if (prev.ids === shownIds) return;
    setSelection((s) => remapRows(s, prev.ids, shownIds));
    if (sort && count > prev.count) setNote(`Sorted the ${fmt(count)} loaded rows; ${fmt(count - prev.count)} more loaded.`);
  }, [shownIds, viewKey]);
  const sectionRef = useRef<HTMLElement>(null);
  // The statement as it ran, its session's database, and every row this result holds.
  const resultOrigin = (): ExportOrigin | null =>
    item && rowsState
      ? {
          kind: "result",
          database,
          sql: item.sql,
          columns: rowsState.columns,
          rows: rowsState.rows,
          hidden: rowsState.columns.filter((c) => hidden.has(c.name)).map((c) => c.name),
        }
      : null;
  const exportResult = onExport
    ? () => {
        const origin = resultOrigin();
        if (origin) onExport(origin);
      }
    : undefined;
  useCommandKeys(exportResult && rowsState ? { "export.open": exportResult } : {}, { region: sectionRef });
  const copyText = (text: string) => (onCopy ?? ((t: string) => void navigator.clipboard?.writeText(t).catch(() => {})))(text);

  let body;
  let foot = null;
  let summary = null;
  if (!item) {
    body = (
      <div className="result-state result-empty">
        <Icon name="play" size={20} />
        <h3>Run a query to see results</h3>
        <p className="muted">Results and row counts appear here.</p>
        <Kbd keys={runKey ?? "Ctrl+Enter"} />
      </div>
    );
  } else {
    const st = item.state;
    switch (st.s) {
      case "running":
        body = (
          <div className="result-state">
            <h3>
              <span className="spinner" aria-hidden="true" />
              Running <Elapsed since={item.startedAt} />
            </h3>
            <pre className="result-sql">{item.sql}</pre>
            <p className="muted">
              {state.queue.length > 0 &&
                `${fmt(state.queue.length)} more statement${state.queue.length > 1 ? "s" : ""} waiting. `}
              {timeoutSecs ? `Stops on its own after ${fmt(timeoutSecs)}s, the Connection's timeout.` : ""}
            </p>
            <div className="result-actions">
              <button type="button" className="button button-danger-fill" onClick={onCancel}>
                <Icon name="stop" />
                Cancel
              </button>
            </div>
          </div>
        );
        break;
      case "cancelled":
        body = (
          <div className="result-state result-state-warn">
            <h3>
              <Icon name="warning" />
              Cancelled after {durationText(st.ms)}
            </h3>
            <p className="muted">
              {WRITES.has(verbOf(item.sql))
                ? "The server rolled the statement back. No rows changed."
                : "The server stopped the query."}
            </p>
            <pre className="result-sql">{item.sql}</pre>
            <div className="result-actions">
              <button type="button" className="button" onClick={() => onRunAgain(item.id)}>
                Run again
              </button>
            </div>
          </div>
        );
        break;
      case "stopped":
        body = (
          <div className="result-state result-state-warn">
            <h3>
              <Icon name="warning" />
              Stopped after {durationText(st.ms)}
            </h3>
            <p className="muted">{st.why}</p>
            <pre className="result-sql">{item.sql}</pre>
            <div className="result-actions">
              <button type="button" className="button" onClick={() => onRunAgain(item.id)}>
                Run again
              </button>
            </div>
          </div>
        );
        break;
      case "timedOut":
        body = (
          <div className="result-state result-state-warn">
            <h3>
              <Icon name="warning" />
              Stopped after {fmt(st.secs)}s
            </h3>
            <p className="muted">
              The query ran longer than this Connection's timeout, so Contura cancelled it on the server. Raise the
              timeout in the Connection's settings if this query needs longer.
            </p>
            <pre className="result-sql">{item.sql}</pre>
            <div className="result-actions">
              <button type="button" className="button" onClick={() => onRunAgain(item.id)}>
                Run again
              </button>
            </div>
          </div>
        );
        break;
      case "error": {
        const line = lineAt(st.at);
        const ctx =
          ask?.errorAsk &&
          ({
            kind: "error",
            connection: ask.connection,
            sql: item.sql,
            lines: [lineAt(item.from), lineAt(item.to)],
            error: st.message,
            tables: tablesIn(item.sql, ask.schema),
            label: "Failed query",
          } satisfies AskContext);
        if (st.index === undefined) {
          // An Explain that failed: no statement number, just what went wrong.
          body = (
            <div className="result-state result-state-error" role="alert">
              <h3>
                <Icon name="error" />
                {st.message}
              </h3>
              <pre className="result-sql">{item.sql}</pre>
            </div>
          );
          break;
        }
        const earlier = state.items.find((r) => r.state.s !== "plan" && r.index === st.index! - 1);
        // Frame 2: "1 of 3 statements ran in 38ms", over this run's statements up to the failed one.
        const at = state.items.indexOf(item);
        let spent = st.ms ?? 0;
        for (let j = at - 1, want = st.index - 1; j >= 0 && want >= 1; j--, want--) {
          const prev = state.items[j];
          if (prev.index !== want) break;
          if ("ms" in prev.state) spent += prev.state.ms ?? 0;
        }
        const total = st.index + (st.notRun?.length ?? 0);
        summary = (
          <span className="results-summary">
            {total === 1 ? `Failed after ${durationText(spent)}` : `${st.index - 1} of ${total} statements ran in ${durationText(spent)}`}
          </span>
        );
        body = (
          <div className="query-error-wrap">
            <QueryError
              statementIndex={st.index}
              line={line}
              column={columnAt?.(st.at) ?? 1}
              dialect={dialect}
              message={st.message}
              own={st.own}
              note={
                st.refused
                  ? "This Connection opens every session read-only. The statement did not change anything, and statements after it did not run."
                  : undefined
              }
              notRun={st.notRun ?? []}
              names={names}
              tableNames={tableNames}
              scope={scope}
              lineOf={lineAt}
              lost={!!st.lost}
              connectionName={connectionName}
              earlierResult={earlier?.id ?? null}
              onGoTo={() => onGoTo(st.at, st.at)}
              onAsk={ctx ? () => setAskOpen((o) => !o) : undefined}
              onCopy={copyText}
              onReconnect={() => onReconnect?.()}
              extraAction={errorAction}
            />
            {ctx && askOpen && (
              <div className="ask-anchor">
                <InlineAsk
                  context={ctx}
                  schema={ask.schema}
                  groupId={ask.groupId}
                  onOpenInChat={ask.onOpenInChat}
                  onOpenSettings={ask.onOpenSettings}
                  insertTarget={ask.insertTarget}
                  onOpenInNewTab={ask.onOpenInNewTab}
                  onClose={() => setAskOpen(false)}
                />
              </div>
            )}
          </div>
        );
        break;
      }
      case "plan":
        body = <PlanView plan={st.plan} />;
        summary = <span className="results-summary">Plan in {durationText(st.ms)}</span>;
        foot = <span>Explain asks the server for the plan. The statement does not run.</span>;
        break;
      case "affected":
        body = (
          <div className="result-state result-state-ok">
            <h3>
              <Icon name="check" />
              {verbOf(item.sql) || "Done"} {fmt(st.rows)} row{st.rows === 1 ? "" : "s"}
            </h3>
            <p className="muted">Finished in {durationText(st.ms)}.</p>
            <pre className="result-sql">{item.sql}</pre>
          </div>
        );
        break;
      case "rows": {
        const columns = keep.length === st.columns.length ? st.columns : keep.map((i) => st.columns[i]);
        const gridKey = (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Escape" && cellMenu) return e.preventDefault(), setCellMenu(null);
          if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && selection) {
            e.preventDefault();
            const td = e.currentTarget.querySelector(`tr[data-row="${selection.active.r}"] td[data-col="${selection.active.c}"]`);
            const box = (td ?? e.currentTarget).getBoundingClientRect();
            setCellMenu({ row: selection.active.r, column: selection.active.c, x: box.left, y: box.bottom });
            return;
          }
          if (e.shiftKey && e.key === "F2" && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            if (selection) openFull(selection.active.r, selection.active.c);
            return;
          }
          if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === "KeyF" || e.key.toLowerCase() === "f")) {
            e.preventDefault();
            setNote("Results have no filter bar: Filter rows above searches them, and Ctrl+F filters in the table grid.");
            return;
          }
          const what = editKeyName(e);
          if (what && shownRows.length > 0) {
            e.preventDefault();
            setNote(readOnlyNote(what));
          }
        };
        const openFull = (r: number, c: number) => {
          const cell = shownRows[r]?.[c];
          if (cell) setFull({ title: `${columns[c].name}, row ${(r + 1).toLocaleString("en-US")}`, cell });
        };
        body = (
          <ResultGrid
            columns={columns}
            rows={shownRows}
            resetKey={item.id}
            label={`Result ${item.id}`}
            onRange={(first, last) => setRange({ first, last })}
            onNearEnd={st.hasMore && st.open ? () => onFetchMore(item.id) : undefined}
            sort={sort}
            onSort={(column) => {
              const next = nextSort(sort, column);
              setSort(next);
              // G7: the sort is of the loaded rows only, and says so.
              setNote(next ? `Sorted the ${fmt(st.rows.length)} loaded rows.` : "Sort off: the rows are back in the order they came.");
            }}
            selection={selection}
            onSelection={(next) => {
              setSelection(next);
              setCellMenu(null);
            }}
            onNote={setNote}
            gridRef={gridRef}
            onGridKey={gridKey}
            onPaste={(e) => {
              e.preventDefault();
              setNote(readOnlyNote("pasting"));
            }}
            onOpen={() => setNote(readOnlyNote("editing"))}
            onCellMenu={(row, column, x, y) => setCellMenu({ row, column, x, y })}
          >
            {st.rows.length === 0 && <p className="state-panel muted">The query returned no rows.</p>}
            {st.rows.length > 0 && filteredRows.length === 0 && <p className="state-panel muted">No loaded row matches the filter.</p>}
          </ResultGrid>
        );
        // R15: rows and time stay in the result toolbar; the window status bar has the Connection and position.
        summary = (
          <span className="results-summary">
            {st.hasMore ? `First ${fmt(st.rows.length)} rows` : `${fmt(st.rows.length)} row${st.rows.length === 1 ? "" : "s"}`} in{" "}
            {durationText(st.ms)}
          </span>
        );
        const total = filteredRows.length;
        const last = range ? Math.min(total, range.last) : total;
        const first = range ? Math.min(range.first, last) : total === 0 ? 0 : 1;
        foot = (
          <>
            <span className="results-range">
              {first} to {last} of {fmt(total)}
              {st.hasMore && !needle ? "+" : ""}
            </span>
            {st.hasMore &&
              (st.open ? (
                <button type="button" className="button button-small button-ghost" onClick={() => onFetchMore(item.id)}>
                  Fetch next 1,000
                </button>
              ) : (
                <span>Run it again to fetch more</span>
              ))}
            {note && (
              <span className="results-grid-note" role="status" title={note}>
                {note}
              </span>
            )}
            <span className="spacer" />
            {(() => {
              const note = production
                ? "Saving runs on Production and asks you to confirm the SQL first."
                : item.pinned
                  ? "Pinned: running again keeps this result"
                  : "Running again replaces this result";
              return (
                <span className="results-foot-note" title={note}>
                  {note}
                </span>
              );
            })()}
          </>
        );
        break;
      }
    }
  }

  const closeOne = (id: number) => (onClose ? onClose(id) : undefined);
  const menuItems = (r: ResultItem): MenuItem[] => {
    const running = r.state.s === "running";
    return [
      { key: "pin", label: r.pinned ? "Unpin result" : "Pin result", disabled: running, onSelect: () => onPin(r.id) },
      ...(onClose ? [{ key: "close", label: "Close", shortcut: "Delete", disabled: running, onSelect: () => closeOne(r.id) }] : []),
      { key: "closeUnpinned", label: "Close unpinned results", onSelect: onCloseUnpinned },
    ];
  };
  const closeMenu = () => {
    const id = tabMenu?.id;
    setTabMenu(null);
    if (id !== undefined) tabRefs.current.get(id)?.focus();
  };
  const menuItem = tabMenu ? state.items.find((r) => r.id === tabMenu.id) : undefined;
  const focusResultGrid = () => sectionRef.current?.querySelector<HTMLElement>(".grid-scroll")?.focus();
  const closeCellMenu = () => {
    setCellMenu(null);
    focusResultGrid();
  };
  /** G7: results' cell menu has only what reads (DataGrip, SSMS): Copy, Copy with headers, Open full value. */
  const cellMenuItems = (m: { row: number; column: number }): MenuItem[] => {
    const shownCols = keep.map((i) => rowsState!.columns[i]);
    const count = cellCount(selection);
    const heading =
      count > 1
        ? wholeRows(selection, shownCols.length)
          ? `${fmt(rowsOf(selection).length)} rows`
          : `${fmt(count)} cells`
        : `${shownCols[m.column]?.name}, row ${fmt(m.row + 1)}`;
    return [
      { key: "head", label: heading, heading },
      { key: "copy", label: "Copy", shortcut: "Ctrl+C", onSelect: () => gridRef.current?.copy(false) },
      { key: "copyHeaders", label: "Copy with headers", shortcut: "Ctrl+Shift+C", onSelect: () => gridRef.current?.copy(true) },
      {
        key: "full",
        label: "Open full value",
        shortcut: "Shift+F2",
        separatorBefore: true,
        onSelect: () => {
          const cell = shownRows[m.row]?.[m.column];
          if (cell) setFull({ title: `${shownCols[m.column].name}, row ${fmt(m.row + 1)}`, cell });
        },
      },
    ];
  };
  return (
    <section ref={sectionRef} className={production ? "results prod-wash" : "results"} aria-label="Results" data-pane>
      {item && (
        <div className="results-tabs">
          {/* PR28: Pin and Close live on the result tab: close on hover, Pin in its right-click menu. */}
          {!single && (
          <div role="tablist" aria-label="Result tabs" className="results-tablist">
            {state.items.map((r, i) => {
              const running = r.state.s === "running";
              const label = tabLabel(r);
              return (
                <div
                  key={r.id}
                  className={i === state.active ? "result-tab result-tab-on" : "result-tab"}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setTabMenu({ id: r.id, x: e.clientX, y: e.clientY });
                  }}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={i === state.active}
                    aria-label={r.pinned ? `${label}, pinned` : undefined}
                    aria-keyshortcuts={running || !onClose ? "Shift+F10" : "Delete Shift+F10"}
                    className="result-tab-button"
                    title={r.sql}
                    ref={(el) => {
                      if (el) tabRefs.current.set(r.id, el);
                      else tabRefs.current.delete(r.id);
                    }}
                    onClick={() => onSelect(i)}
                    onKeyDown={(e) => {
                      if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                        e.preventDefault();
                        const box = e.currentTarget.getBoundingClientRect();
                        setTabMenu({ id: r.id, x: box.left, y: box.bottom });
                      } else if (e.key === "Delete" && onClose && !running) {
                        e.preventDefault();
                        closeOne(r.id);
                      }
                    }}
                  >
                    <StateMark item={r} />
                    {label}
                    {r.pinned && <Icon name="pin" size={14} className="result-pin" />}
                  </button>
                  {onClose && !running && (
                    <button
                      type="button"
                      className="icon-button result-tab-close"
                      // Pointer only: Delete and the tab's menu give the same close to keyboards and screen readers.
                      aria-hidden="true"
                      tabIndex={-1}
                      aria-label={`Close ${label}`}
                      title={`Close ${label}`}
                      onClick={() => closeOne(r.id)}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          )}
          {summary}
          <span className="spacer" />
          {rowsState && (
            <ResultTools
              columns={rowsState.columns}
              rows={filteredRows}
              filter={filter}
              onFilter={setFilter}
              hidden={hidden}
              onToggleColumn={(name) =>
                setHidden((h) => {
                  const next = new Set(h);
                  if (!next.delete(name)) next.add(name);
                  return next;
                })
              }
              connectionName={connectionName}
              onExport={exportResult}
            />
          )}
        </div>
      )}
      {tabMenu && menuItem && <TabMenu x={tabMenu.x} y={tabMenu.y} items={menuItems(menuItem)} onClose={closeMenu} />}
      {cellMenu && rowsState && (
        <TabMenu x={cellMenu.x} y={cellMenu.y} items={cellMenuItems(cellMenu)} onClose={closeCellMenu} label="Cell" />
      )}
      {full && (
        <FullValueDialog
          title={full.title}
          cell={full.cell}
          onClose={() => {
            setFull(null);
            focusResultGrid();
          }}
        />
      )}
      <div className="results-body">{body}</div>
      {/* Frame 2: a failed statement has no footer; the error already names it. */}
      {item && !(item.state.s === "error" && item.state.index !== undefined) && (
        <div className="results-foot">
          {item.after && item.after.length > 0 && item.index !== undefined && item.state.s !== "running" && (
            <span className="results-notrun">{notRunText(item.index, item.after.length)}</span>
          )}
          {foot ?? <span>{item.sql.split("\n")[0]}</span>}
        </div>
      )}
    </section>
  );
}
