import {
  type ClipboardEvent,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { durationText } from "../format/units";
import { applyEdits, confirmEdits, errorText, fetchFullValue, fetchPage, isNotOpen, planEdits, tableDesign } from "../api/client";
import type {
  Cell,
  ColumnInfo,
  ConnectionId,
  DialectKind,
  EditSet,
  Group,
  KeyPart,
  NewValue,
  ObjectPath,
  Page,
  PassId,
  RunVerdict,
  SortSpec,
  TableColumn,
} from "../api/types";
import ConfirmRun from "../query/ConfirmRun";
import EditsBar from "./EditsBar";
import PreviewSql from "./PreviewSql";
import {
  addRow,
  count,
  discard,
  settle,
  summary,
  toEditSet,
  editCell,
  editNewCell,
  emptyPending,
  missingFull,
  type Pending,
  pendingValue,
  withFullOld,
  redo,
  revertCell,
  revertRow,
  undo,
  applyMany,
  type CellOp,
} from "../edits/pending";
import { cellText, cellValue, type DisplayRow, displayRows, hasKey, parsePaste } from "../edits/gridRows";
import CellEditor, { type LargeEditor } from "./CellEditor";
import type { LangClient } from "../lang/client";
import { type SchemaCache, schemaKey } from "../lang/sql/schemaCache";
import type { AskContext, AskKit } from "../assistant/context";
import { type TabAskFields, usePublishTabAsk } from "../assistant/tabAsk";
import { type RecentStepInput, useRecordStep } from "../assistant/recentSteps";
import FilterBar from "../grid/FilterBar";
import { planCells, plural } from "../edits/cellOps";
import { filterForValue, filtersSql, OPS, type RowFilter, valueKind } from "../grid/rowFilters";
import {
  altGraph,
  cellCount,
  clampSelection,
  isLetter,
  norm,
  rowsOf,
  type Selection,
  single,
  wholeRows,
} from "../grid/selection";
import { readClipboard } from "../grid/clipboard";
import { FullValueDialog } from "./CellValue";
import FeatureIcon from "./FeatureIcon";
import Kbd from "./Kbd";
import ResultGrid, { type GridHandle } from "./ResultGrid";
import Icon from "./Icon";
import DbMark from "./DbMark";
import MenuButton, { MenuList, type MenuItem } from "./Menu";
import { useToast } from "./Toast";
import { toCsv } from "../query/ResultTools";
import { type CommandHandlers, useCommandKeys } from "../commands/useCommandKeys";
import type { ExportOrigin } from "../jobs/exportText";
import { objectPrefix } from "../objectPath";

/** The table as SQL names it, so the filter is checked as `SELECT * FROM <it> WHERE <filter>`. */
function sqlName(dialect: DialectKind, t: ObjectPath): string {
  const q = (s: string) => (dialect === "mysql" ? `\`${s.replace(/`/g, "``")}\`` : `"${s.replace(/"/g, '""')}"`);
  if (dialect === "postgres") return t.schema ? `${q(t.schema)}.${q(t.name)}` : q(t.name);
  return dialect === "mysql" ? `${q(t.database)}.${q(t.name)}` : q(t.name);
}

const noSubscribe = () => () => {};

const PAGE_SIZE = 1000;
const NUMERIC_TYPE = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|year)\b/i;
interface Props {
  connectionId: ConnectionId;
  table: ObjectPath;
  /** Unused since T1: the header strip has no close button; the tab strip closes the tab. */
  onClose: () => void;
  /** The session is gone; the Connection must be opened again. */
  onNotOpen?: () => void;
  /** The Connection's Dialect, for the filter box. */
  dialect?: DialectKind;
  /** Completion and checks in the filter box. */
  lang?: { client: LangClient; schemas: SchemaCache };
  /** Kept for the owner's call; the filter is built in words now (item 2), so there is no SQL box to ask about. */
  ask?: AskKit & { connection: AskContext["connection"] };
  /** Opens a Data Transfer from this table (the Table menu's Copy to another Connection...). */
  onTransfer?(): void;
  /** The Connection is Read-only: a lock in the header corner says cells can't be edited. */
  readOnly?: boolean;
  /** Views are shown but never edited. */
  kind?: "table" | "view";
  /** A Production Connection: the grid carries the wash, and Save reads "Save on PROD" and asks first. */
  production?: boolean;
  /** The Connection's Group, for the square in the confirm dialog. */
  group?: Group | null;
  /** Told when the grid gains or loses Pending Edits. */
  onDirtyChange?(dirty: boolean): void;
  /** G15: the user worked in this grid (a sort, filter, hidden column, column width or edit): a preview tab becomes a kept tab. */
  onWorked?(): void;
  /** Lets the parent save before closing; resolves false when the save failed or was cancelled. */
  controlRef?: MutableRefObject<GridControl | null>;
  /** The tab is on screen: its status (rows, time, Pending Edits) then shows in the window status bar. */
  visible?: boolean;
  /** The Connection's name, for the header's Connection button, Preview SQL and the Read-only toast. */
  connectionName?: string;
  /** The server's row estimate of the table, when the tree has it: the footer reads "1 to 200 of 1,284" (PR29). */
  rowEstimate?: number | null;
  /** Opens a new, unsaved query tab on this Connection with this SQL, without running it. */
  onOpenQuery?(sql: string): void;
  /** Opens the Export dialog on this table (the menu's Export..., and Ctrl+E inside the grid). */
  onExport?(origin: ExportOrigin): void;
  /** Opens an Import tab into this table; shown on Read-only Connections too (Q15). */
  onImport?(): void;
  /** Opens the table's design tab (tables only, D15). */
  onDesign?(): void;
  /** Opens the table's lineage tab (tables only, step 6+). */
  onLineage?(): void;
  /** Bumped when the table's design changed: the grid loads its columns and page 0 again, with no Pending Edits. */
  version?: number;
  /** A line under the header from the owner, such as a design change not loaded yet. */
  notice?: string | null;
  /** The rows were reloaded with no Pending Edits, so the owner's notice is answered. */
  onNoticeDone?(): void;
  /** Pending Edits were saved: a meaningful change, so the owner may list the table in Recent (item 12). */
  onSaved?(): void;
  /** The tab's key: the grid publishes what the Ask may know of it (`tabAsk.ts`). */
  askKey?: string | null;
}

/**
 * What a table or view tab tells the Ask (spec 4.2): the sort, the row filters' column names, the hidden columns
 * and the Pending Edits count, never a value; the filter's WHERE goes as the filter text the Core masks. Lists are
 * cut at twice the Core's caps.
 */
export function gridTabAsk(
  table: ObjectPath,
  kind: "table" | "view",
  sort: SortSpec | null,
  rowFilters: readonly RowFilter[],
  filter: string | null,
  hidden: ReadonlySet<string>,
  pendingEdits: number,
): TabAskFields {
  return {
    tab: {
      kind: "object",
      title: table.name,
      path: table,
      object: kind,
      sort,
      filterColumns: [...new Set(rowFilters.map((f) => f.column))].slice(0, 100),
      hidden: [...hidden].slice(0, 40),
      pendingEdits,
    },
    filter: filter ?? undefined,
    tables: [{ schema: table.schema, name: table.name }],
  };
}

export interface GridControl {
  save(): Promise<boolean>;
  /** Drops the Pending Edits (or the draft); false when it could not, as while a save or Apply runs. */
  discard(): boolean;
  /** Keeps the value in an open cell editor; true when the grid then has Pending Edits. */
  flush(): boolean;
  /** How many Pending Edits the grid holds, for the unsaved changes dialog. */
  pendingCount(): number;
}

type Ask = Extract<RunVerdict, { kind: "needsConfirmation" }>;

const READ_ONLY_TIP = "Read-only Connection: cells can't be edited";
const NO_KEY = "This table has no primary key, so its rows can't be edited";
const KEY_NOTE = "Key columns can't be changed here";
const BINARY_NOTE = "Binary values can only be set to NULL here";
const PASTE_KEY_NOTE = "Pasting can't change key columns.";
const PASTE_DELETED_NOTE = "Deleted rows can't be edited. Revert the row first.";
const PROD_SAVE_NOTE = "Saving runs on Production and asks you to confirm the SQL first.";
const READ_ONLY_FOOT = "Read-only Connection: cells cannot be edited";
const VIEW_NOTE = "Views are shown here, not edited.";

let filterSeq = 0;

/** "Saving runs the 3 statements in one transaction.": Save writes one statement per changed row. */
function savingText(n: number): string {
  return n === 1 ? "Saving runs 1 statement in one transaction." : `Saving runs the ${n.toLocaleString("en-US")} statements in one transaction.`;
}

/** The table as the header names it: `public.orders` with a schema, else `shop.orders`. */
function shortName(t: ObjectPath): string {
  return `${t.schema ?? t.database}.${t.name}`;
}

type Spot = { row: number; column: number };
/** `old` is the full old value of a cut-short cell, loaded before the editor opened. */
/** `large`: the larger editor under the cell (item 4), for long or many-line values and on Shift+F2. */
type Editing = Spot & { initial: string; multiline: boolean; old?: Cell; large?: boolean };

/** Item 4: a value this long (or with a line break) opens in the larger editor, so it can be read while edited. */
const LONG_VALUE = 48;

const fullText = (value: string): Cell => ({
  t: "text",
  value,
  truncated: false,
  totalBytes: new TextEncoder().encode(value).length,
});
type Menu = Spot & { x: number; y: number };

/** The page on screen and its index. Replaced, never accumulated. */
type Shown = { index: number; page: Page; epoch: number };

/** G11, the AG Grid order: ascending, then descending, then no sort. */
function nextSort(current: SortSpec | null, column: string): SortSpec | null {
  if (current?.column === column) return current.descending ? null : { column, descending: true };
  return { column, descending: false };
}

/**
 * G5: where the selected cell is in a reloaded page of the same view: the row with the same key and the same
 * column, or when that row is gone the row now at its place (the last one when it was past the end).
 */
function findAgain(
  prev: { columns: ColumnInfo[]; view: DisplayRow[] },
  sel: { row: number; column: number },
  columns: ColumnInfo[],
  view: DisplayRow[],
): { row: number; column: number } | null {
  const column = columns.findIndex((c) => c.name === prev.columns[sel.column]?.name);
  if (column < 0 || view.length === 0) return null;
  const old = prev.view[sel.row];
  let row = -1;
  if (old?.kind === "loaded" && hasKey(prev.columns)) {
    const text = JSON.stringify(rowKey(prev.columns, old.source));
    row = view.findIndex((d) => d.kind === "loaded" && JSON.stringify(rowKey(columns, d.source)) === text);
  }
  return { row: row >= 0 ? row : Math.min(sel.row, view.length - 1), column };
}

function rowKey(columns: ColumnInfo[], row: Page["rows"][number]): KeyPart[] {
  return columns.flatMap((c, i) => (c.isPrimaryKey ? [{ column: c.name, value: row[i] }] : []));
}

/**
 * Item 10 (frame Table, "Empty table"): what an empty page says. A table with no rows offers the first row and
 * the two ways to bring rows in; filters that match nothing offer to clear them; a page past the end goes back.
 */
function EmptyRows(p: {
  table: string;
  firstPage: boolean;
  filtered: boolean;
  canAdd: boolean;
  production: boolean;
  connectionName: string | null;
  onAdd(): void;
  onClear(): void;
  onImport?: () => void;
  onTransfer?: () => void;
}) {
  if (!p.firstPage) return <p className="state-panel muted">No more rows. Go back a page.</p>;
  if (p.filtered) {
    return (
      <div className="grid-empty" role="status">
        <Icon name="filter" size={20} className="grid-empty-icon" />
        <h3 className="grid-empty-title">No rows match the filters</h3>
        <p className="grid-empty-text">Change a filter, or clear them to see every row of {p.table}.</p>
        <div className="grid-empty-actions">
          <button type="button" className="button button-primary" onClick={p.onClear}>
            Clear filters
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="grid-empty" role="status">
      <span className="grid-empty-tile" aria-hidden="true">
        <FeatureIcon name="table" size={28} />
      </span>
      <h3 className="grid-empty-title">{p.table} has no rows yet</h3>
      <p className="grid-empty-text">
        {p.canAdd ? "The columns above are ready. Add the first row here, or bring rows in from a file or another Connection." : "Nothing has been added to it yet."}
      </p>
      {p.canAdd && (
        <div className="grid-empty-actions">
          <button type="button" className="button button-primary" onClick={p.onAdd}>
            <Icon name="plus" size={14} />
            Add row
            <Kbd keys="Ctrl+N" />
          </button>
          {p.onImport && (
            <button type="button" className="button" onClick={p.onImport}>
              <FeatureIcon name="import" size={16} />
              Import a file...
            </button>
          )}
          {p.onTransfer && (
            <button type="button" className="button" onClick={p.onTransfer}>
              <FeatureIcon name="transfer" size={16} />
              Copy from a Connection...
            </button>
          )}
        </div>
      )}
      {p.canAdd && (
        <p className="grid-empty-note">
          {p.production && p.connectionName
            ? `New rows wait as Pending Edits. Saving on ${p.connectionName} shows the SQL and asks you to confirm.`
            : "New rows wait as Pending Edits until you save."}
        </p>
      )}
    </div>
  );
}

/**
 * The read-only grid for one table or view. Only the current page lives in
 * state (ADR 0003): moving to another page replaces it, and the parent keys
 * this component by table so opening another table starts fresh. Only the
 * rows near the viewport are in the DOM; spacer rows stand in for the rest.
 */
export default function DataGrid({
  connectionId,
  table,
  onNotOpen,
  dialect = "postgres",
  lang,
  readOnly = false,
  kind = "table",
  production = false,
  group = null,
  onDirtyChange,
  onWorked,
  controlRef,
  visible = true,
  connectionName,
  rowEstimate = null,
  onOpenQuery,
  onDesign,
  onLineage,
  version = 0,
  notice = null,
  onNoticeDone,
  onExport,
  onImport,
  onSaved,
  onTransfer,
  askKey = null,
}: Props) {
  const { show: showToast } = useToast();
  const recordStep = useRecordStep();
  /** A Recent step on this table: its name first, then the columns; never a value. */
  const gridStep = (verb: RecentStepInput["verb"], columns: string[], extra: Partial<RecentStepInput> = {}) =>
    recordStep({
      verb,
      tab: "object",
      title: null,
      connectionId,
      database: table.database,
      schema: table.schema,
      names: [table.name, ...columns],
      count: null,
      ...extra,
    });
  const workedRef = useRef(onWorked);
  workedRef.current = onWorked;
  const worked = () => workedRef.current?.();
  const [pageIndex, setPageIndex] = useState(0);
  const [sort, setSort] = useState<SortSpec | null>(null);
  /** The hidden columns of the Table menu's Columns list (PR28). */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  /** Item 2: the filters, built in words; `filter` is the WHERE they make, which the page is fetched with. */
  const [rowFilters, setRowFilters] = useState<RowFilter[]>([]);
  const [filter, setFilter] = useState<string | null>(null);
  const schemaLoad = useSyncExternalStore(
    lang ? (l) => lang.schemas.subscribe(l) : noSubscribe,
    () => lang?.schemas.state(connectionId, table.database) ?? null,
  );
  useEffect(() => {
    if (lang) void lang.schemas.ensure(connectionId, table.database);
  }, [lang, connectionId, table.database]);
  const [shown, setShown] = useState<Shown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  /**
   * G5: counts the changes of what the grid shows (another page, sort, filter or design), not the reloads of it.
   * A page fetched in the same epoch as the one on screen keeps the scroll position, the selected cell and the widths.
   */
  const epochRef = useRef(0);
  const [fetchMs, setFetchMs] = useState<number | null>(null);
  const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setStatusSlot(visible ? document.getElementById("app-status-slot") : null);
  }, [visible]);

  // `table` is fixed for this component's lifetime: the parent re-keys it per table.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    const started = performance.now();
    const epoch = epochRef.current;
    fetchPage(connectionId, { table, page: pageIndex, sort, filter })
      .then((page) => {
        if (!live) return;
        setFetchMs(performance.now() - started);
        setShown({ index: pageIndex, page, epoch });
      })
      .catch((e) => {
        if (!live) return;
        if (isNotOpen(e)) onNotOpen?.();
        // The status bar no longer stands for the page on screen: its rows and time go.
        setFetchMs(null);
        setError(errorText(e));
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [connectionId, pageIndex, sort, filter, attempt]);

  /** Item 2: new filters fetch page 0 with the WHERE they make. */
  function applyFilters(next: RowFilter[]) {
    flushEditor();
    worked();
    setRowFilters(next);
    if (next.length > 0) gridStep("gridFilter", [...new Set(next.map((f) => f.column))]);
    const kinds = new Map(columns.map((c) => [c.name, valueKind(c.typeName)]));
    const where = filtersSql(dialect, next, (c) => kinds.get(c) ?? "text");
    // Only a change of what is fetched starts the view over: the same WHERE fetches nothing new.
    if (where !== filter || pageIndex !== 0) epochRef.current++;
    setFilter(where);
    setPageIndex(0);
  }

  function clearFilter(): boolean {
    if (rowFilters.length === 0 && !filter) return false;
    applyFilters([]);
    return true;
  }

  function chooseSort(column: string) {
    setSortTo(nextSort(sort, column));
  }

  function setSortTo(next: SortSpec | null) {
    flushEditor();
    worked();
    if (next?.column !== sort?.column || next?.descending !== sort?.descending || pageIndex !== 0) epochRef.current++;
    setSort(next);
    setPageIndex(0);
    if (next) gridStep("gridSort", [next.column], next.descending ? { descending: true } : {});
  }

  function clearSort() {
    setSortTo(null);
  }
  const page = shown?.page ?? null;
  const columns = page?.columns ?? [];
  const firstRow = (shown?.index ?? 0) * PAGE_SIZE + 1;

  // ---- Pending Edits ----
  const editable = !readOnly && kind === "table";
  const sectionRef = useRef<HTMLElement>(null);
  // The refs hold the latest values, so a save right after an edit (Ctrl+S in the editor) sees it.
  const [pending, setPendingState] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  /** G2: the selected ranges, in the grid's positions (rows and shown columns); `sel` is its active cell. */
  const [selection, setSelection] = useState<Selection | null>(null);
  const gridRef = useRef<GridHandle | null>(null);
  /** The Add filter form Ctrl+F opens with the active cell's column and value (G13). */
  const [filterRequest, setFilterRequest] = useState<{ draft: Omit<RowFilter, "id">; seq: number } | null>(null);
  /** Open full value on a cell the larger editor does not open for. */
  const [full, setFull] = useState<{ title: string; cell: Cell; source?: { column: string; key: KeyPart[] } } | null>(null);
  /** Nullability and defaults (ruling 2, Set DEFAULT), from the table's design; null until loaded. */
  const [design, setDesign] = useState<Map<string, TableColumn> | null>(null);
  const [editing, setEditingState] = useState<Editing | null>(null);
  const editingRef = useRef<Editing | null>(null);
  /** What is typed in the open editor. */
  const editValue = useRef("");
  const [menu, setMenu] = useState<Menu | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** The save in progress; editing is locked while it runs. */
  const inflight = useRef<Promise<boolean> | null>(null);
  const [busy, setBusy] = useState(false);

  function put(next: Pending | null) {
    pendingRef.current = next;
    setPendingState(next);
  }
  function setEditing(e: Editing | null) {
    editingRef.current = e;
    if (e) editValue.current = e.initial;
    setEditingState(e);
  }

  const view = useMemo(() => displayRows(pending, page), [pending, page]);
  /** G5: the page and rows the grid showed before this one, to find the selected cell again after a reload. */
  const before = useRef<{ epoch: number; columns: ColumnInfo[]; view: DisplayRow[] } | null>(null);
  useEffect(() => {
    if (page && !pendingRef.current) put(emptyPending(page.columns));
    const prev = before.current;
    const again = prev && shown && prev.epoch === shown.epoch && sel ? findAgain(prev, sel, page?.columns ?? [], view) : null;
    // The same row in its place keeps the whole selection; a row found elsewhere keeps the active cell.
    if (again && again.row === sel?.row && again.column === sel.column) {
      setSelection((s) => clampSelection(s, { rows: view.length, cols: shownCols.length }));
    } else setSel(again);
    setEditing(null);
    setMenu(null);
    before.current = shown ? { epoch: shown.epoch, columns: page?.columns ?? [], view } : null;
  }, [page]);
  // The latest page and rows, for answers that arrive after the grid moved on.
  const pageRef = useRef(page);
  pageRef.current = page;
  const viewRef = useRef(view);
  viewRef.current = view;
  const keyed = hasKey(columns);

  // The rows and columns on screen, as indexes into `view` and `columns`: every row (the filters run on the
  // server), and the columns the Table menu's Columns list has not hidden.
  // Selection, editing and Pending Edits stay in `view` and `columns` indexes; only the grid maps.
  const shownCols = useMemo(() => columns.flatMap((c, i) => (hidden.has(c.name) ? [] : [i])), [columns, hidden]);
  const shownRows = useMemo(() => view.map((_, i) => i), [view]);
  const rowPos = (row: number) => shownRows.indexOf(row);
  const colPos = (column: number) => shownCols.indexOf(column);
  /** The active cell, in `view` and `columns` indexes. */
  const sel: Spot | null =
    selection && shownRows[selection.active.r] !== undefined && shownCols[selection.active.c] !== undefined
      ? { row: shownRows[selection.active.r], column: shownCols[selection.active.c] }
      : null;
  /** Selects one cell, given in `view` and `columns` indexes; null clears the selection. */
  function setSel(spot: Spot | null) {
    const r = spot ? rowPos(spot.row) : -1;
    const c = spot ? colPos(spot.column) : -1;
    setSelection(r >= 0 && c >= 0 ? single({ r, c }) : null);
  }
  /** The selected cell is on screen: the header's filter or columns menu has not hidden it. */
  const selShown = !!sel;
  /** The selected cells as `view` and `columns` indexes, each once. */
  function selectedCells(): Spot[] {
    if (!selection) return [];
    const out: Spot[] = [];
    const seen = selection.ranges.map(norm);
    seen.forEach((n, i) => {
      for (let r = n.t; r <= n.b; r++)
        for (let c = n.l; c <= n.r; c++) {
          if (seen.slice(0, i).some((m) => r >= m.t && r <= m.b && c >= m.l && c <= m.r)) continue;
          if (shownRows[r] !== undefined && shownCols[c] !== undefined) out.push({ row: shownRows[r], column: shownCols[c] });
        }
    });
    return out.sort((a, b) => a.row - b.row || a.column - b.column);
  }
  /** The rows the selection spans, as `view` indexes. */
  const selectedRows = () => rowsOf(selection).flatMap((r) => (shownRows[r] === undefined ? [] : [shownRows[r]]));
  /**
   * What Export opens on: the table's columns (those hidden here start off), the applied WHERE and
   * ORDER BY, and the selected cell's row by its key (D7).
   */
  function exportOrigin(): ExportOrigin {
    const at = sel && selShown ? view[sel.row] : undefined;
    const selected = at?.kind === "loaded" && keyed ? [rowKey(columns, at.source)] : [];
    return {
      kind: "table",
      path: table,
      columns: columns.map((c) => c.name),
      hidden: columns.filter((c) => hidden.has(c.name)).map((c) => c.name),
      filter,
      sort,
      selected,
      hasPrimaryKey: keyed,
      rowEstimate,
      estimated: rowEstimate !== null,
    };
  }
  // Ctrl+E (D21): the focused grid, else the visible one, opens Export.
  useCommandKeys(onExport && kind === "table" ? { "export.open": () => onExport(exportOrigin()) } : {}, { region: sectionRef });
  // G12: F5 in the focused grid reloads its rows, as the Reload button does.
  // The handler exists only while focus is inside the grid, so with focus elsewhere F5 falls to the tree.
  const reloadKey: CommandHandlers = {};
  if (kind === "table") {
    Object.defineProperty(reloadKey, "tree.refresh", {
      enumerable: true,
      get: () => (sectionRef.current?.contains(document.activeElement) ? () => !loading && reloadRows() : undefined),
    });
  }
  useCommandKeys(reloadKey, { region: sectionRef });
  // Hiding or showing a column keeps the active cell on its column, or drops the selection when the column is
  // hidden, so nothing acts on a cell off screen. Fewer rows (an undone new row) cut the ranges back.
  // The cell menu follows the same rule: it closes when its row or column leaves the screen.
  const colsBefore = useRef(shownCols);
  useEffect(() => {
    const prev = colsBefore.current;
    colsBefore.current = shownCols;
    setSelection((s) => {
      if (!s) return s;
      if (prev.join(",") !== shownCols.join(",")) {
        const c = shownCols.indexOf(prev[s.active.c]);
        return c < 0 || s.active.r >= shownRows.length ? null : single({ r: s.active.r, c });
      }
      const fits = s.ranges.every((g) => Math.max(g.r0, g.r1) < shownRows.length && Math.max(g.c0, g.c1) < shownCols.length);
      return fits ? s : clampSelection(s, { rows: shownRows.length, cols: shownCols.length });
    });
    if (menu && (!shownRows.includes(menu.row) || !shownCols.includes(menu.column))) setMenu(null);
  }, [menu, shownRows, shownCols]);

  // A new design may change nullability and defaults: read them again when next needed.
  const designFailed = useRef(false);
  useEffect(() => {
    setDesign(null);
    designFailed.current = false;
  }, [version]);

  /**
   * Ruling 2 and Set DEFAULT need each column's nullability and default: read from the table's design the first
   * time Delete, Set NULL or Set DEFAULT is used, then kept. Null when it can't be read; every column then counts
   * as nullable with no default, and Save reports what the server refuses.
   */
  function withDesign(run: (d: Map<string, TableColumn> | null) => void) {
    if (design || designFailed.current) return run(design);
    const at = pageRef.current;
    tableDesign(connectionId, table)
      .then((d) => new Map(d.columns.map((c) => [c.name, c])))
      .catch(() => null)
      .then((m) => {
        // A failed read is not asked again until the design changes (M6).
        if (m) setDesign(m);
        else designFailed.current = true;
        if (pageRef.current === at) run(m);
      });
  }

  // A press outside the cell menu, or a scroll anywhere outside it, closes it.
  const menuBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const outside = (e: Event) => {
      if (!menuBox.current?.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("mousedown", outside, true);
    window.addEventListener("scroll", outside, true);
    return () => {
      document.removeEventListener("mousedown", outside, true);
      window.removeEventListener("scroll", outside, true);
    };
  }, [menu]);

  /** Changes the Pending Edits; does nothing while a save runs. */
  const update = (f: (p: Pending) => Pending) => {
    const p = pendingRef.current;
    if (p && !inflight.current) put(f(p));
  };
  const focusGrid = () => sectionRef.current?.querySelector<HTMLElement>(".grid-scroll")?.focus();

  /** Why a loaded cell can't be typed into, or null when it can. */
  function blocked(d: DisplayRow, column: number, forNull = false): string | null {
    if (d.kind === "new") return null;
    if (d.deleted) return "";
    if (!d.key) return NO_KEY;
    if (columns[column].isPrimaryKey) return KEY_NOTE;
    if (!forNull && d.cells[column].t === "bytes") return BINARY_NOTE;
    return null;
  }

  function openEditor(row: number, column: number, typed?: string, larger = false) {
    if (!editable || !pendingRef.current || inflight.current) return;
    const d = view[row];
    if (!d) return;
    const why = blocked(d, column);
    if (why !== null) {
      if (why) setNote(why);
      return;
    }
    setNote(null);
    const start = (initial: string, old?: Cell) =>
      setEditing({
        row,
        column,
        initial,
        multiline: initial.includes("\n"),
        old,
        large: larger || (typed === undefined && (initial.length > LONG_VALUE || initial.includes("\n"))),
      });
    const cell = d.cells[column];
    // Typing over a cut-short cell replaces it, so it opens at once; Save loads the full old value.
    if (d.kind === "loaded" && cell.t === "text" && cell.truncated && typed === undefined) {
      // Double-click, Enter or F2 on a cut-short cell: its full value is loaded before the editor opens.
      const requested = pageRef.current;
      fetchFullValue(connectionId, { table, column: columns[column].name, key: rowKey(columns, d.source) })
        .then((v) => {
          // Drop the answer when the page or the row at this place is not the one asked about.
          const now = viewRef.current[row];
          if (pageRef.current !== requested || now?.kind !== "loaded" || now.source !== d.source) return;
          if (v.t !== "text") return setNote(BINARY_NOTE);
          if (!inflight.current) start(v.value, fullText(v.value));
        })
        .catch((e) => {
          if (pageRef.current === requested) setNote(errorText(e));
        });
      return;
    }
    if (typed !== undefined) return start(typed);
    if (d.kind === "new") return start(d.set[column] && cell.t !== "null" ? cellText(cell) : "");
    start(cell.t === "null" ? "" : cellText(cell));
  }

  function setValue(row: number, column: number, value: NewValue, old?: Cell) {
    const d = view[row];
    if (!d) return;
    const name = columns[column].name;
    if (d.kind === "new") update((p) => editNewCell(p, d.id, name, value));
    else if (d.key) update((p) => editCell(p, d.key!, d.source, name, value, old));
  }

  /** Keeps the editor's value. After a blur, focus and selection stay where the user put them. */
  function commit(value: string, move: "down" | "right" | "none", blurred = false) {
    const at = editingRef.current;
    if (!at) return;
    setValue(at.row, at.column, { t: "text", value }, at.old);
    setEditing(null);
    if (blurred) return;
    const next = { row: at.row, column: at.column };
    const r = rowPos(at.row);
    const c = colPos(at.column);
    if (move === "down" && r >= 0) next.row = shownRows[Math.min(r + 1, shownRows.length - 1)];
    if (move === "right" && c >= 0) next.column = shownCols[Math.min(c + 1, shownCols.length - 1)];
    setSel(next);
    focusGrid();
  }

  /** Keeps the value of an open editor before Save, paging, sorting or closing act. */
  function flushEditor() {
    if (editingRef.current) commit(editValue.current, "none", true);
  }

  function setNull(row: number, column: number) {
    const d = view[row];
    if (!d || !editable) return;
    const why = blocked(d, column, true);
    if (why !== null) {
      if (why) setNote(why);
      return;
    }
    setValue(row, column, { t: "null" });
  }

  /** What a row is called in a note: "Row 3", or "The new row". */
  const rowName = (d: DisplayRow | undefined) => (d?.kind === "loaded" ? `Row ${(firstRow + d.index).toLocaleString("en-US")}` : "The new row");

  /**
   * G3, G4: Delete clears the selected cells (text to '', other types to NULL, ruling 2), Set NULL and Set DEFAULT
   * set them, all as one undo step of Pending Edits. Key columns, NOT NULL columns a value can't go into and rows
   * marked for deletion are left as they are, and the note says so.
   */
  function setCells(kind: "clear" | "null" | "default") {
    if (!editable || !pendingRef.current || inflight.current) return;
    withDesign((design) => applyCells(kind, design));
  }

  function applyCells(kind: "clear" | "null" | "default", design: Map<string, TableColumn> | null) {
    if (!pendingRef.current || inflight.current) return;
    const plan = planCells({ kind, view, columns, cells: selectedCells(), design });
    if (plan.ops.length) update((p) => applyMany(p, plan.ops)[0]);
    setNote(plan.note);
  }

  /** The row the new one goes under: the active cell's row (G17), or none for the bottom. */
  function placeOf(d: DisplayRow | undefined): string | undefined {
    if (!d) return undefined;
    return d.kind === "new" ? d.id : (d.key ?? undefined);
  }

  /** Ctrl+N, Alt+Insert, the Add row button: a new row under the current one (DBeaver), else at the bottom. */
  function addNewRow(values?: Map<string, NewValue>) {
    if (!editable || !pendingRef.current || inflight.current) return;
    const after = sel ? placeOf(view[sel.row]) : undefined;
    update((p) => addRow(p, values, after)[0]);
    const firstValue = shownCols.findIndex((c) => !columns[c]?.isPrimaryKey);
    const row = after !== undefined && sel ? sel.row + 1 : view.length;
    setSelection(single({ r: row, c: Math.max(0, firstValue) }));
    setNote(null);
    focusGrid();
  }

  /** The values a duplicate of `d` takes: every column but the key; cut-short text is loaded in full first. */
  async function copyOf(d: DisplayRow): Promise<{ values: Map<string, NewValue>; binary: boolean } | string> {
    const values = new Map<string, NewValue>();
    let binary = false;
    for (const [i, c] of columns.entries()) {
      if (c.isPrimaryKey || (d.kind === "new" && !d.set[i])) continue;
      const cell = d.cells[i];
      if (cell.t === "bytes") {
        binary = true;
        continue;
      }
      let v = cellValue(cell);
      if (!v && cell.t === "text" && d.kind === "loaded") {
        try {
          const full = await fetchFullValue(connectionId, { table, column: c.name, key: rowKey(columns, d.source) });
          if (full.t === "text") v = { t: "text", value: full.value };
          else binary = true;
        } catch (e) {
          return errorText(e);
        }
      }
      if (v) values.set(c.name, v);
    }
    return { values, binary };
  }

  /** Ctrl+D and the menu's Duplicate: copies of the rows, under the last of them (TablePlus). */
  async function duplicateRows(rows: number[]) {
    const ds = rows.map((r) => view[r]).filter((d): d is DisplayRow => !!d && !(d.kind === "loaded" && d.deleted));
    if (!ds.length || !editable || !pendingRef.current || inflight.current) return;
    const at = pageRef.current;
    const copies: Map<string, NewValue>[] = [];
    let binary = false;
    for (const d of ds) {
      const c = await copyOf(d);
      if (typeof c === "string") return setNote(c);
      copies.push(c.values);
      binary ||= c.binary;
    }
    // The page may have changed while full values loaded.
    if (pageRef.current !== at || inflight.current) return;
    const last = Math.max(...rows);
    const after = placeOf(view[last]);
    update((p) => applyMany(p, copies.map((values, i): CellOp => ({ t: "add", values, after: i === 0 ? after : "previous" })))[0]);
    const start = after !== undefined ? last + 1 : view.length;
    setSelection(single({ r: start, c: 0 }));
    setNote(`Duplicated ${plural(copies.length, "row")} below.${binary ? " Binary values aren't copied." : ""}`);
    focusGrid();
  }

  /** Marks the rows deleted (new rows go at once), as one undo step. */
  function deleteRows(rows: number[]) {
    if (!editable || !pendingRef.current || inflight.current) return;
    const ds = rows.map((r) => view[r]).filter((d): d is DisplayRow => !!d && !(d.kind === "loaded" && d.deleted));
    if (!ds.length) return;
    if (ds.some((d) => d.kind === "loaded" && !d.key)) return setNote(NO_KEY);
    update((p) => applyMany(p, ds.map((d): CellOp => (d.kind === "new" ? { t: "delete", ref: d.id } : { t: "delete", ref: d.key!, row: d.source })))[0]);
    setNote(ds.length === 1 ? `${rowName(ds[0])} marked for deletion. Ctrl+Z undoes.` : `${plural(ds.length, "row")} marked for deletion. Ctrl+Z undoes.`);
  }

  /** The toolbar's Delete row and Alt+Delete: the rows the selection spans (ruling 6). */
  function deleteSelected() {
    deleteRows(selectedRows());
  }

  function onPaste(e: ClipboardEvent<HTMLDivElement>) {
    if (editing) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    if (!editable) return refuse();
    pasteText(text);
  }

  /**
   * Paste lands from the top-left cell of the selection on the rows and columns on screen; lines past the last row
   * become new rows. One value pasted over several selected cells fills them all (Excel).
   */
  function pasteText(text: string) {
    if (!editable || !pendingRef.current || inflight.current) return;
    const lines = parsePaste(text);
    const many = cellCount(selection) > 1;
    if (lines.length === 1 && lines[0].length === 1 && many) {
      const cells = selectedCells();
      for (const at of cells) {
        const d = view[at.row];
        if (d?.kind !== "loaded") continue;
        if (!d.key) return setNote(NO_KEY);
        if (d.deleted) return setNote(PASTE_DELETED_NOTE);
        if (columns[at.column].isPrimaryKey) return setNote(PASTE_KEY_NOTE);
      }
      setNote(null);
      const value: NewValue = { t: "text", value: lines[0][0] };
      update((p) =>
        applyMany(
          p,
          cells.map((at): CellOp => {
            const d = view[at.row];
            const column = columns[at.column].name;
            return d.kind === "new" ? { t: "setNew", localId: d.id, column, value } : { t: "set", rowKey: d.key!, row: d.source, column, value };
          }),
        )[0],
      );
      return;
    }
    const top = selection ? norm(selection.ranges[selection.ranges.length - 1]) : null;
    const r0 = top ? top.t : 0;
    const c0 = top ? top.l : 0;
    if (r0 < 0 || c0 < 0 || c0 >= shownCols.length) return;
    const span = (line: string[]) => line.slice(0, shownCols.length - c0);
    const column = (j: number) => columns[shownCols[c0 + j]];
    const target = (i: number) => (r0 + i < shownRows.length ? view[shownRows[r0 + i]] : undefined);
    for (const [i, line] of lines.entries()) {
      const d = target(i);
      if (d?.kind !== "loaded") continue;
      if (!d.key) return setNote(NO_KEY);
      if (d.deleted) return setNote(PASTE_DELETED_NOTE);
      if (span(line).some((_, j) => column(j).isPrimaryKey)) return setNote(PASTE_KEY_NOTE);
    }
    setNote(null);
    const ops: CellOp[] = [];
    lines.forEach((line, i) => {
      const d = target(i);
      const cells = span(line).map((value, j) => [column(j).name, { t: "text", value } as NewValue] as const);
      if (!d) ops.push({ t: "add", values: new Map<string, NewValue>(cells) });
      else if (d.kind === "new") for (const [name, value] of cells) ops.push({ t: "setNew", localId: d.id, column: name, value });
      else if (d.key && !d.deleted) for (const [name, value] of cells) ops.push({ t: "set", rowKey: d.key, row: d.source, column: name, value });
    });
    update((p) => applyMany(p, ops)[0]);
  }

  /** Why an edit key does nothing here: the Read-only toast, or a note on a view. */
  function refuse() {
    if (readOnly) readOnlyEdit();
    else if (kind === "view") setNote(VIEW_NOTE);
  }

  /** G13 (TablePlus): Add filter on the active cell's column, its value filled in. */
  function filterDraft(): Omit<RowFilter, "id"> | null {
    if (!sel) {
      // M10: with no cell selected, Add filter opens on the first column, empty.
      const first = columns[shownCols[0]];
      return first ? { column: first.name, op: OPS[valueKind(first.typeName)][0].op, value: "" } : null;
    }
    const c = columns[sel.column];
    const cell = view[sel.row]?.cells[sel.column];
    if (!c || !cell) return null;
    const f = filterForValue(c.name, valueKind(c.typeName), cell);
    if (!f) setNote("Binary values can't be filtered by.");
    return f;
  }

  function filterByValue() {
    const f = filterDraft();
    if (f && sel) applyFilters([...rowFilters, { ...f, id: `cell${++filterSeq}` }]);
  }

  /** Shift+F2 and the menu's Open full value: the larger editor where the cell can be edited, else the value to read. */
  function openFull(spot: Spot) {
    const d = view[spot.row];
    const c = columns[spot.column];
    if (!d || !c) return;
    if (editable && blocked(d, spot.column) === null && !inflight.current) return openEditor(spot.row, spot.column, undefined, true);
    const where = d.kind === "loaded" ? `row ${(firstRow + d.index).toLocaleString("en-US")}` : "new row";
    setFull({
      title: `${c.name}, ${where}`,
      cell: d.cells[spot.column],
      source: d.kind === "loaded" && d.key ? { column: c.name, key: rowKey(columns, d.source) } : undefined,
    });
  }

  function openMenuAtActive(target: HTMLElement) {
    if (!sel || !selection) return;
    const cell = sectionRef.current?.querySelector(`tr[data-row="${selection.active.r}"] td[data-col="${selection.active.c}"]`);
    const box = (cell ?? target).getBoundingClientRect();
    setMenu({ row: sel.row, column: sel.column, x: box.left, y: box.bottom });
  }

  /**
   * The table grid's own keys, before the grid's movement and copy keys. A key handled here calls preventDefault, so
   * the grid does not act on it too and no app command takes it (Ctrl+Alt+N is Set NULL here, New diagram elsewhere).
   */
  function onGridKey(e: KeyboardEvent<HTMLDivElement>) {
    if (editing) return;
    const handled = () => e.preventDefault();
    if (altGraph(e)) {
      // An AltGr character types like any other (M1).
      if (!editable) return view.length > 0 ? (handled(), refuse()) : undefined;
      if (!sel) return;
      flushSync(() => openEditor(sel.row, sel.column, ""));
      if (!editingRef.current) e.preventDefault();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const letter = (l: string) => isLetter(e, l);
    if (e.key === "Escape" && menu) return handled(), setMenu(null);
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      handled();
      return openMenuAtActive(e.currentTarget);
    }
    if (mod && !e.altKey && !e.shiftKey && letter("f")) {
      handled();
      const draft = filterDraft();
      if (draft) setFilterRequest((r) => ({ draft, seq: (r?.seq ?? 0) + 1 }));
      return;
    }
    if (e.shiftKey && e.key === "F2" && !mod) {
      handled();
      if (sel) openFull(sel);
      return;
    }
    const editKey =
      (mod && e.altKey && (letter("n") || letter("d"))) ||
      (e.altKey && (e.key === "Delete" || e.key === "Insert")) ||
      (mod && !e.altKey && letter("d") && !e.shiftKey) ||
      (!mod && !e.altKey && (e.key === "Enter" || e.key === "F2" || e.key === "Delete" || e.key === "Backspace")) ||
      (e.key.length === 1 && !mod && !e.altKey && !(e.key === " " && e.shiftKey));
    if (!editable) {
      if (editKey && view.length > 0) {
        handled();
        refuse();
      }
      return;
    }
    if (mod && !e.altKey && letter("s")) return handled(), void save();
    if (mod && !e.altKey && letter("z") && !e.shiftKey) return handled(), update(undo);
    if (mod && !e.altKey && (letter("y") || (letter("z") && e.shiftKey))) return handled(), update(redo);
    if (mod && e.altKey && letter("n")) return handled(), setCells("null");
    if (mod && e.altKey && letter("d")) return handled(), setCells("default");
    if (e.altKey && !mod && e.key === "Delete") return handled(), deleteSelected();
    if ((e.altKey && !mod && e.key === "Insert") || (mod && !e.altKey && !e.shiftKey && letter("n"))) return handled(), addNewRow();
    if (mod && !e.altKey && !e.shiftKey && letter("d")) return handled(), void duplicateRows(selectedRows());
    if (!sel) return;
    if (!mod && !e.altKey && (e.key === "Enter" || e.key === "F2")) {
      handled();
      openEditor(sel.row, sel.column);
    } else if (!mod && !e.altKey && (e.key === "Delete" || e.key === "Backspace")) {
      handled();
      // Rows chosen from their numbers are deleted (TablePlus); any other selection is cleared (Excel).
      if (e.key === "Delete" && selection?.rows && wholeRows(selection, shownCols.length)) deleteSelected();
      else setCells("clear");
    } else if (e.key.length === 1 && !mod && !e.altKey && !(e.key === " " && e.shiftKey)) {
      // Item 47: the editor opens empty and takes focus before the browser handles the key, so the
      // browser types the character itself. Writing it in from here bypassed the WebView's text input
      // (the IME on Windows), which then lost it when the next characters went in (`::s` became `:s`).
      // Typing over a cut-short cell opens at once too: Save loads its full old value (`missingFull`).
      flushSync(() => openEditor(sel.row, sel.column, ""));
      if (!editingRef.current) e.preventDefault();
    }
  }

  // ---- Save ----
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  /** `state` is the Pending Edits being saved: they are cleared on success only if nothing changed since. */
  const [confirm, setConfirm] = useState<{ verdict: Ask; edits: EditSet; state: Pending["state"] } | null>(null);
  const confirmDone = useRef<((ok: boolean) => void) | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const changes = pending ? count(pending) : 0;
  usePublishTabAsk(askKey, () => gridTabAsk(table, kind, sort, rowFilters, filter, hidden, changes), [table, kind, sort, rowFilters, filter, hidden, changes]);

  const dirtyChange = useRef(onDirtyChange);
  dirtyChange.current = onDirtyChange;
  useEffect(() => dirtyChange.current?.(changes > 0), [changes > 0]);
  useEffect(() => {
    if (changes > 0) workedRef.current?.();
  }, [changes > 0]);
  // A grid that goes away takes its Pending Edits with it.
  useEffect(() => () => dirtyChange.current?.(false), []);

  function failed(e: unknown) {
    const err = e as { kind?: string; message?: { key?: KeyPart[] } };
    if (err?.kind === "rowChanged" && err.message?.key) {
      setConflict(JSON.stringify(err.message.key.map((k) => k.value)));
    }
    setSaveError(err?.kind === "noPrimaryKey" ? NO_KEY : errorText(e));
  }

  /** Applies with a pass (or none); an expired or used pass asks again with the current SQL. */
  const latestSaved = useRef(onSaved);
  latestSaved.current = onSaved;
  async function apply(edits: EditSet, pass: PassId | null, state: Pending["state"]): Promise<boolean> {
    try {
      await applyEdits(connectionId, edits, pass);
      const now = pendingRef.current;
      if (now && now.state === state) put(settle(now));
      // The rows the save sent, even when more edits were made while it ran.
      gridStep("editsSaved", [], { count: edits.updates.length + edits.inserts.length + edits.deletes.length });
      setConflict(null);
      setSaveError(null);
      setAttempt((n) => n + 1);
      latestSaved.current?.();
      return true;
    } catch (e) {
      if ((e as { kind?: string })?.kind === "needsConfirmation") return runSave();
      failed(e);
      return false;
    }
  }

  /** Saves once at a time: a second Save while one runs gets the running one. */
  function save(): Promise<boolean> {
    flushEditor();
    if (inflight.current) return inflight.current;
    const p = pendingRef.current;
    if (!p || count(p) === 0) return Promise.resolve(true);
    setBusy(true);
    const run: Promise<boolean> = runSave().finally(() => {
      if (inflight.current !== run) return;
      inflight.current = null;
      setBusy(false);
    });
    inflight.current = run;
    return run;
  }

  async function runSave(): Promise<boolean> {
    let p = pendingRef.current;
    if (!p || count(p) === 0) return true;
    setSaving(true);
    setSaveError(null);
    try {
      // A cut-short old value can't identify a row: load the full one for cells edited without the editor.
      for (const m of missingFull(p)) {
        const v = await fetchFullValue(connectionId, { table, column: m.column, key: m.key });
        if (v.t === "text") p = withFullOld(p, m.rowKey, m.column, fullText(v.value));
      }
      if (p !== pendingRef.current) put(p);
      const state = p.state;
      const edits = toEditSet(p, table);
      const plan = await planEdits(connectionId, edits);
      if (plan.verdict.kind === "needsConfirmation") {
        const verdict = plan.verdict;
        setSaving(false);
        return await new Promise<boolean>((resolve) => {
          confirmDone.current = resolve;
          setConfirm({ verdict, edits, state });
        });
      }
      if (plan.verdict.kind === "readOnly") {
        setSaveError(errorText({ kind: "readOnly", message: plan.verdict.statement }));
        return false;
      }
      return await apply(edits, null, state);
    } catch (e) {
      failed(e);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function confirmSave() {
    const current = confirm;
    const done = confirmDone.current;
    setConfirm(null);
    confirmDone.current = null;
    if (!current || !done) return;
    setSaving(true);
    try {
      const pass = await confirmEdits(connectionId, current.edits);
      done(await apply(current.edits, pass, current.state));
    } catch (e) {
      failed(e);
      done(false);
    } finally {
      setSaving(false);
    }
  }

  function cancelSave() {
    // Nothing is saving any more, so editing and Save work again at once.
    inflight.current = null;
    setBusy(false);
    confirmDone.current?.(false);
    confirmDone.current = null;
    setConfirm(null);
    focusGrid();
  }

  /** Drops every Pending Edit; false, with nothing dropped, while a save runs. */
  function discardAll(): boolean {
    if (inflight.current) return false;
    setEditing(null);
    update(discard);
    setSaveError(null);
    setConflict(null);
    return true;
  }

  /** The Discard button: one undo step, and a toast whose Undo brings the changes back. */
  function discardWithUndo() {
    const before = pendingRef.current;
    const n = before ? count(before) : 0;
    if (!discardAll() || n === 0) return;
    const emptied = pendingRef.current?.state;
    showToast({
      kind: "info",
      text: `Discarded ${n} ${n === 1 ? "change" : "changes"}.`,
      stays: 8000,
      action: {
        label: "Undo",
        run: () => {
          if (pendingRef.current?.state === emptied) update(undo);
          else showToast({ kind: "info", text: "Undo no longer applies: the grid changed since. Ctrl+Z steps back through your edits." });
        },
      },
    });
  }

  function reloadRows() {
    flushEditor();
    // With no Pending Edits the reloaded page brings its columns with it (a design may have changed them).
    if (!pendingRef.current || count(pendingRef.current) === 0) {
      put(null);
      onNoticeDone?.();
    }
    setAttempt((n) => n + 1);
  }

  // A new design: the columns and page 0 load again, and the Pending Edits (of the old columns) go.
  const shownVersion = useRef(version);
  useEffect(() => {
    if (shownVersion.current === version) return;
    shownVersion.current = version;
    epochRef.current++;
    setEditing(null);
    put(null);
    setSel(null);
    setMenu(null);
    setNote(null);
    setSaveError(null);
    setConflict(null);
    setPreviewOpen(false);
    setPageIndex(0);
    setAttempt((n) => n + 1);
  }, [version]);

  function goToPage(index: number) {
    flushEditor();
    if (index !== pageIndex) epochRef.current++;
    setPageIndex(index);
  }

  if (controlRef) {
    controlRef.current = {
      save,
      discard: discardAll,
      flush: () => {
        flushEditor();
        return !!pendingRef.current && count(pendingRef.current) > 0;
      },
      pendingCount: () => (pendingRef.current ? count(pendingRef.current) : 0),
    };
  }

  function rowLabel(r: number): ReactNode {
    const d = view[r];
    if (!d) return undefined;
    if (d.kind === "new") return "+";
    const n = (firstRow + d.index).toLocaleString("en-US");
    // A deleted row reads "-" in the gutter, as a new row reads "+"; its number stays in the tooltip.
    if (d.deleted) return <span className="row-number-deleted" title={`Row ${n}, deleted`}>-</span>;
    const edited = d.key && pending && columns.some((c) => pendingValue(pending, d.key!, c.name));
    // T6: an edited row's number stays faint; the class is kept for its hooks only.
    return edited ? <span className="row-number-edited">{n}</span> : n;
  }

  function editedAt(r: number, c: number): boolean {
    const d = view[r];
    return !!(d?.kind === "loaded" && d.key && pending && pendingValue(pending, d.key, columns[c].name));
  }

  function closeMenu() {
    setMenu(null);
    focusGrid();
  }

  /**
   * G9: the cell menu, target first (DataGrip, DBeaver): what it acts on as its heading, then Copy, Copy with
   * headers and Paste; Set NULL and Set DEFAULT; Filter by this value and Open full value; then the row items, in
   * the plural over several rows. A read-only grid keeps only what reads. Each acts while its cell is on screen.
   */
  function cellMenuItems(m: Menu): MenuItem[] {
    const d = view[m.row];
    if (!d) return [];
    const shown = () => shownRows.includes(m.row) && shownCols.includes(m.column);
    const act = (run: () => void) => () => {
      if (shown()) run();
    };
    const rows = selectedRows();
    const many = rows.length > 1;
    const count = cellCount(selection);
    const heading =
      count > 1
        ? wholeRows(selection, shownCols.length)
          ? plural(rows.length, "row")
          : plural(count, "cell")
        : `${columns[m.column].name}, ${d.kind === "loaded" ? `row ${(firstRow + d.index).toLocaleString("en-US")}` : "new row"}`;
    const items: MenuItem[] = [
      { key: "head", label: heading, heading },
      { key: "copy", label: "Copy", shortcut: "Ctrl+C", onSelect: act(() => gridRef.current?.copy(false)) },
      { key: "copyHeaders", label: "Copy with headers", shortcut: "Ctrl+Shift+C", onSelect: act(() => gridRef.current?.copy(true)) },
    ];
    if (editable) {
      items.push(
        {
          key: "paste",
          label: "Paste",
          shortcut: "Ctrl+V",
          onSelect: act(() => {
            void readClipboard().then((text) => {
              if (text) pasteText(text);
              else setNote("Nothing to paste: the clipboard has no text, or Contura may not read it. Ctrl+V pastes.");
            });
          }),
        },
        { key: "null", label: "Set NULL", shortcut: "Ctrl+Alt+N", separatorBefore: true, onSelect: act(() => setCells("null")) },
        { key: "default", label: "Set DEFAULT", shortcut: "Ctrl+Alt+D", onSelect: act(() => setCells("default")) },
      );
    }
    items.push(
      { key: "filter", label: "Filter by this value", separatorBefore: true, onSelect: act(filterByValue) },
      { key: "full", label: "Open full value", shortcut: "Shift+F2", onSelect: act(() => openFull({ row: m.row, column: m.column })) },
    );
    if (!editable) return items;
    const live = rows.some((r) => view[r] && !(view[r].kind === "loaded" && (view[r] as { deleted: boolean }).deleted));
    if (live) {
      items.push(
        {
          key: "duplicate",
          label: many ? `Duplicate ${rows.length} rows` : "Duplicate row",
          shortcut: "Ctrl+D",
          separatorBefore: true,
          onSelect: act(() => void duplicateRows(rows)),
        },
        { key: "delete", label: many ? `Delete ${rows.length} rows` : "Delete row", shortcut: "Alt+Delete", danger: true, onSelect: act(() => deleteRows(rows)) },
      );
    }
    // Contura today: a changed cell or row can be put back from its menu.
    let first = true;
    if (d.kind === "loaded" && d.key && editedAt(m.row, m.column)) {
      const name = columns[m.column].name;
      items.push({ key: "revert", label: "Revert", separatorBefore: true, onSelect: act(() => update((p) => revertCell(p, d.key!, name))) });
      first = false;
    }
    const ref = d.kind === "new" ? d.id : d.key;
    if (ref && (d.kind === "new" || d.deleted || columns.some((_, i) => editedAt(m.row, i)))) {
      items.push({ key: "revertRow", label: "Revert row", separatorBefore: first, onSelect: act(() => update((p) => revertRow(p, ref))) });
    }
    return items;
  }

  // PR31: Foreign Key columns from the language schema the filter already loads; none until it loads.
  const fkColumns = useMemo(() => {
    const out = new Set<string>();
    if (!lang || schemaLoad !== "loaded") return out;
    const schema = lang.client.sqlSchemaFor(schemaKey(connectionId, table.database));
    for (const fk of schema?.fks ?? []) {
      if (fk.from.table !== table.name) continue;
      if (table.schema !== null && fk.from.schema !== null && fk.from.schema !== table.schema) continue;
      for (const c of fk.from.columns) out.add(c);
    }
    return out;
  }, [lang, schemaLoad, connectionId, table]);

  // PR29: the page's rows, "of" the server's estimate when the tree has one.
  const loadedRows = page?.rows.length ?? 0;
  const lastRow = firstRow + loadedRows - 1;
  const rangeText =
    loadedRows > 0
      ? `${firstRow.toLocaleString("en-US")} to ${lastRow.toLocaleString("en-US")}${
          rowEstimate !== null && rowEstimate >= lastRow ? ` of ${rowEstimate.toLocaleString("en-US")}` : ""
        }`
      : "";
  const contextText =
    readOnly && kind === "table"
      ? READ_ONLY_FOOT
      : editable && production
        ? PROD_SAVE_NOTE
        : editable && changes > 0
          ? savingText(changes)
          : "";
  const noteText = note ?? notice ?? (editable && page && !keyed ? NO_KEY : null);

  /** What the larger editor names: the column and type, the row and its key, and what keeping it does. */
  function largeEditor(e: Editing): LargeEditor {
    const c = columns[e.column];
    const d = view[e.row];
    const key = d?.kind === "loaded" && keyed ? rowKey(columns, d.source)[0] : undefined;
    const where = d?.kind !== "loaded" ? "new row" : `row ${(firstRow + d.index).toLocaleString("en-US")}${key ? `, ${key.column} ${cellText(key.value)}` : ""}`;
    return {
      column: `${c.name} ${c.typeName}`,
      where,
      note: production && connectionName
        ? `Becomes a Pending Edit. Nothing is written to ${connectionName} until you save.`
        : "Becomes a Pending Edit. Nothing is written until you save.",
      onSetNull:
        d && blocked(d, e.column, true) === null
          ? () => {
              setNull(e.row, e.column);
              setEditing(null);
              focusGrid();
            }
          : undefined,
    };
  }

  /** Item 5: the one Table menu (frame Table): what the header's several menus and icons did, in words. */
  function tableMenuItems(): MenuItem[] {
    const items: MenuItem[] = [];
    if (onOpenQuery) {
      items.push({
        key: "query",
        label: "Open as a query",
        icon: <FeatureIcon name="query" size={16} />,
        description: "The SELECT behind this view, in the editor",
        onSelect: () => onOpenQuery(`SELECT * FROM ${sqlName(dialect, table)}${filter ? `\nWHERE ${filter}` : ""};`),
      });
    }
    if (onLineage && kind === "table") {
      items.push({ key: "lineage", label: "Show lineage", icon: <FeatureIcon name="diagram" size={16} />, onSelect: onLineage });
    }
    items.push({
      key: "csv",
      label: "Copy rows as CSV",
      icon: <Icon name="copy" />,
      separatorBefore: items.length > 0,
      onSelect: () =>
        void navigator.clipboard
          ?.writeText(toCsv(columns.map((c) => ({ ...c, numeric: NUMERIC_TYPE.test(c.typeName) })), view.map((d) => d.cells)))
          .catch(() => {}),
    });
    if (onExport) {
      items.push({
        key: "export",
        label: "Export rows...",
        icon: <FeatureIcon name="export" size={16} />,
        shortcut: "Ctrl+E",
        onSelect: () => onExport(exportOrigin()),
      });
    }
    if (onImport) {
      items.push({ key: "import", label: `Import into ${table.name}...`, icon: <FeatureIcon name="import" size={16} />, onSelect: onImport });
    }
    if (onTransfer) {
      items.push({ key: "transfer", label: "Copy to another Connection...", icon: <FeatureIcon name="transfer" size={16} />, onSelect: onTransfer });
    }
    if (columns.length > 0) {
      items.push({
        key: "columns",
        label: "Columns",
        icon: <Icon name="columns" />,
        separatorBefore: true,
        submenu: columns.map((c) => ({
          key: c.name,
          label: c.name,
          checked: !hidden.has(c.name),
          onSelect: () => {
            worked();
            setHidden((h) => {
              const next = new Set(h);
              if (!next.delete(c.name)) next.add(c.name);
              return next;
            });
          },
        })),
      });
    }
    items.push({
      key: "copy",
      label: "Copy name",
      icon: <Icon name="copy" />,
      separatorBefore: columns.length === 0,
      onSelect: () => void navigator.clipboard?.writeText(`${objectPrefix(table)}${table.name}`).catch(() => {}),
    });
    return items;
  }

  /** R3: a Read-only Connection never opens the cell editor; one toast says why. */
  function readOnlyEdit() {
    showToast({ kind: "readOnly", text: `${connectionName ?? "This Connection"} is Read-only. Changes are not allowed.` });
  }

  const gridColumns = shownCols.map((i) => ({
    ...columns[i],
    numeric: NUMERIC_TYPE.test(columns[i].typeName),
    isForeignKey: fkColumns.has(columns[i].name),
  }));
  const allColumns = shownCols.length === columns.length;
  // One array while the rows stay the same, so the grid keeps its copy mark until an edit changes them.
  const gridRows = useMemo(
    () => shownRows.map((i) => (allColumns ? view[i].cells : shownCols.map((c) => view[i].cells[c]))),
    [view, shownRows, shownCols, allColumns],
  );
  const editingAt = editing ? rowPos(editing.row) : -1;

  return (
    <section
      className={["grid-view", production && "prod-wash", production && changes > 0 && "grid-production-edits"]
        .filter(Boolean)
        .join(" ")}
      aria-label={`Data of ${table.name}`}
      ref={sectionRef}
      data-pane
    >
      {/*
        Item 5 (frame Table): the strip names the table and holds its tools: Refresh, the row edits, Edit
        structure in words, and one Table menu for everything else. Item 2: filters and sort are the strip under it.
      */}
      <div className="table-header" role="toolbar" aria-label="Table">
        {connectionName && (
          <span className="table-header-connection">
            <DbMark dialect={dialect} open size={14} label={null} />
            <span className="editor-header-name">{connectionName}</span>
          </span>
        )}
        {production && <span className="production-label">PRODUCTION</span>}
        {(connectionName || production) && <span className="editor-header-divider" aria-hidden="true" />}
        <FeatureIcon name={kind === "view" ? "view" : "table"} size={18} />
        <h2 className="table-header-name" title={`${objectPrefix(table)}${table.name}`}>
          {shortName(table)}
        </h2>
        {rowEstimate !== null && (
          <span className="table-header-rows">
            {rowEstimate.toLocaleString("en-US")} {rowEstimate === 1 ? "row" : "rows"}
          </span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="icon-button"
          aria-label="Reload"
          title="Reload rows"
          disabled={loading}
          onClick={reloadRows}
        >
          <Icon name="refresh" size={14} />
        </button>
        {editable && page && (
          <>
            {/* R20: the grid handles these keys itself (no registry command), so the hints stay literal. */}
            <button
              type="button"
              className="icon-button"
              aria-label="Add row"
              title="Add row (Ctrl+N)"
              disabled={busy}
              onClick={() => addNewRow()}
            >
              <Icon name="plus" size={14} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Delete row"
              title="Delete the selected rows (Alt+Delete)"
              disabled={!selShown || !keyed || busy}
              onClick={deleteSelected}
            >
              <Icon name="minus" size={14} />
            </button>
          </>
        )}
        {onDesign && kind === "table" && (
          <button
            type="button"
            className="button button-small table-header-structure"
            aria-label="Edit structure"
            title="Change columns, keys and indexes"
            onClick={onDesign}
          >
            <FeatureIcon name="designer" size={18} />
            {/* Hidden by a container query when the strip is narrow (beside the Ask panel); the icon stays. */}
            <span className="table-header-structure-label">Edit structure</span>
          </button>
        )}
        <MenuButton
          label="Table"
          align="end"
          trigger={(p) => (
            <button type="button" {...p} className="button button-small table-header-menu">
              Table
              <Icon name="chevronDown" size={14} />
            </button>
          )}
          items={tableMenuItems()}
        />
        <div className={loading ? "progress progress-on" : "progress"} aria-hidden="true">
          <i />
        </div>
      </div>

      <FilterBar
        columns={columns.map((c) => ({ name: c.name, typeName: c.typeName, kind: valueKind(c.typeName) }))}
        filters={rowFilters}
        sort={sort}
        onFilters={applyFilters}
        onSort={setSortTo}
        disabled={!page || (page.rows.length === 0 && rowFilters.length === 0 && pageIndex === 0)}
        request={filterRequest}
      />

      {page && noteText && (
        <p className="grid-note" role="status">
          {noteText}
        </p>
      )}

      {/* A save error gets its own line under the header, so the whole message can be read. */}
      {saveError && changes > 0 && (
        <p className="edits-error" role="alert" title={saveError}>
          {saveError}
        </p>
      )}

      {error ? (
        <div className="grid-scroll">
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
            {filter && (
              <button type="button" className="button" onClick={clearFilter}>
                Clear filters
              </button>
            )}
          </div>
        </div>
      ) : (
        <ResultGrid
          columns={gridColumns}
          rows={gridRows}
          resetKey={shown?.epoch ?? 0}
          widthsKey="table"
          onResized={worked}
          label={`Rows of ${table.name}`}
          firstRow={firstRow}
          stale={loading}
          sort={sort}
          onSort={chooseSort}
          rowLabel={(r) => rowLabel(shownRows[r])}
          {...(readOnly && kind === "table" && { onOpen: readOnlyEdit })}
          selection={selection}
          onSelection={(next) => {
            setSelection(next);
            setMenu(null);
          }}
          onNote={setNote}
          gridRef={gridRef}
          onGridKey={onGridKey}
          onPaste={onPaste}
          onCellMenu={(row: number, column: number, x: number, y: number) => setMenu({ row: shownRows[row], column: shownCols[column], x, y })}
          {...(editable && {
            editingRow: editingAt < 0 ? null : editingAt,
            onEditorLost: flushEditor,
            onOpen: (row: number, column: number) => openEditor(shownRows[row], shownCols[column]),
            cellClass: (r: number, c: number) => {
              // Item 3: the cell being edited draws no ring of its own; the editor's one ring is the only border.
              const on = editing && editing.row === shownRows[r] && editing.column === shownCols[c] ? "cell-editing" : "";
              return [editedAt(shownRows[r], shownCols[c]) ? "cell-edited" : "", on].filter(Boolean).join(" ") || undefined;
            },
            cellTitle: (r: number, c: number) => {
              const row = shownRows[r];
              const column = shownCols[c];
              const d = view[row];
              return d?.kind === "loaded" && editedAt(row, column)
                ? `Was ${cellText(d.source[column])}. Edited, not saved yet.`
                : undefined;
            },
            rowClass: (r: number) => {
              const d = view[shownRows[r]];
              if (d?.kind === "new") return "row-added";
              if (d?.deleted) return "row-deleted";
              return d && conflict !== null && d.key === conflict ? "row-conflict" : undefined;
            },
            renderCell: (r: number, c: number) => {
              const row = shownRows[r];
              const column = shownCols[c];
              if (editing && editing.row === row && editing.column === column) {
                return (
                  <CellEditor
                    key={editing.large ? "large" : "cell"}
                    initial={editing.initial}
                    multiline={editing.multiline}
                    large={editing.large ? largeEditor(editing) : undefined}
                    onLarger={(v) => {
                      editValue.current = v;
                      setEditing({ ...editing, initial: v, large: true });
                    }}
                    onCommit={commit}
                    onInput={(v) => (editValue.current = v)}
                    onSave={(v) => {
                      commit(v, "none");
                      void save();
                    }}
                    onCancel={() => {
                      setEditing(null);
                      focusGrid();
                    }}
                  />
                );
              }
              const d = view[row];
              // T3: an unset key column shows `default`; other unset cells of a new row stay empty.
              if (d?.kind === "new" && !d.set[column]) return d.defaults[column] ? <span className="cell-default">default</span> : "";
              return undefined;
            },
          })}
          corner={
            readOnly && (
              <span className="lock-corner" role="img" aria-label={READ_ONLY_TIP} title={READ_ONLY_TIP} tabIndex={0}>
                <Icon name="lock" />
              </span>
            )
          }
          cellSource={(r, column) => {
            const d = view[shownRows[r]];
            return page && d?.kind === "loaded" ? { connectionId, table, column, rowKey: rowKey(page.columns, d.source) } : undefined;
          }}
        >
          {page && page.rows.length === 0 && view.length === 0 && (
            <EmptyRows
              table={table.name}
              firstPage={shown?.index === 0}
              filtered={filter !== null}
              canAdd={editable}
              production={production}
              connectionName={connectionName ?? null}
              onAdd={() => addNewRow()}
              onClear={clearFilter}
              onImport={onImport}
              onTransfer={onTransfer}
            />
          )}
        </ResultGrid>
      )}

      {/* T2: Pending Edits get their own bar, above the footer. */}
      {pending && changes > 0 && (
        <EditsBar
          summary={summary(pending)}
          changes={changes}
          busy={saving}
          production={production}
          previewOpen={previewOpen}
          onPreview={() => setPreviewOpen((o) => !o)}
          onDiscard={discardWithUndo}
          onSave={() => void save()}
        />
      )}

      {/* T4, PR29: the row range and the pager on the left, what saving does on the right. */}
      <div className="table-foot">
        <span className="table-range">{rangeText}</span>
        <span className="pager">
          <button
            type="button"
            className="icon-button"
            aria-label="Previous page"
            title="Previous page"
            disabled={pageIndex === 0 || loading}
            onClick={() => goToPage(pageIndex - 1)}
          >
            <Icon name="chevronLeft" size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Next page"
            title="Next page"
            disabled={loading || !page?.hasMore}
            onClick={() => goToPage(pageIndex + 1)}
          >
            <Icon name="chevronRight" size={14} />
          </button>
        </span>
        <span className="spacer" />
        {contextText && <span className="table-context">{contextText}</span>}
      </div>

      {pending && previewOpen && changes > 0 && (
        <PreviewSql
          connectionId={connectionId}
          edits={toEditSet(pending, table)}
          onClose={() => setPreviewOpen(false)}
          connectionName={connectionName}
          database={table.database}
          dialect={dialect}
          production={production}
          onOpenQuery={onOpenQuery}
        />
      )}

      {confirm && (
        <ConfirmRun
          verb="Save"
          verdict={confirm.verdict}
          noWhere={null}
          dialect={dialect}
          group={group}
          rowEstimate={rowEstimate}
          onRun={() => void confirmSave()}
          onCancel={cancelSave}
          onAddWhere={() => {}}
        />
      )}

      {full && (
        <FullValueDialog
          title={full.title}
          cell={full.cell}
          source={full.source && { connectionId, table, column: full.source.column, rowKey: full.source.key }}
          onClose={() => {
            setFull(null);
            focusGrid();
          }}
        />
      )}

      {menu && (
        <div ref={menuBox} className="tree-menu" style={{ left: menu.x, top: menu.y }}>
          <MenuList items={cellMenuItems(menu)} label="Cell" onClose={closeMenu} compact />
        </div>
      )}

      {statusSlot &&
        page &&
        createPortal(
          <div className="query-status">
            {!error && (
              <span>{`${page.rows.length.toLocaleString("en-US")}${page.hasMore ? "+" : ""} ${page.rows.length === 1 && !page.hasMore ? "row" : "rows"}`}</span>
            )}
            {fetchMs !== null && <span>{durationText(fetchMs)}</span>}
            {changes > 0 && <span>{`${changes.toLocaleString("en-US")} Pending ${changes === 1 ? "Edit" : "Edits"}`}</span>}
          </div>,
          statusSlot,
        )}
    </section>
  );
}
