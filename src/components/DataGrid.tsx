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
import { createPortal } from "react-dom";
import { durationText } from "../format/units";
import { applyEdits, confirmEdits, errorText, fetchFullValue, fetchPage, isNotOpen, planEdits } from "../api/client";
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
} from "../api/types";
import ConfirmRun from "../query/ConfirmRun";
import EditsBar from "./EditsBar";
import PreviewSql from "./PreviewSql";
import {
  addRow,
  batch,
  count,
  deleteRow,
  discard,
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
} from "../edits/pending";
import { cellText, cellValue, type DisplayRow, displayRows, hasKey, parsePaste } from "../edits/gridRows";
import CellEditor from "./CellEditor";
import type { LangClient } from "../lang/client";
import { type SchemaCache, schemaKey } from "../lang/sql/schemaCache";
import InlineAsk from "../assistant/InlineAsk";
import type { AskContext, AskKit } from "../assistant/context";
import SqlEditor, { type AskSelection, type SqlEditorApi } from "../query/SqlEditor";
import ResultGrid from "./ResultGrid";
import Icon from "./Icon";
import DbMark from "./DbMark";
import MenuButton, { MenuList, type MenuItem } from "./Menu";
import { useToast } from "./Toast";
import ResultTools, { cellText as plainText } from "../query/ResultTools";
import { useCommandKeys } from "../commands/useCommandKeys";
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
  /** Ctrl+I in the filter box asks AI; absent, it does nothing. */
  ask?: AskKit & { connection: AskContext["connection"] };
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
const ORDER_NOTE = "Sort by one column, such as total DESC.";

/** "Saving runs the 3 statements in one transaction.": Save writes one statement per changed row. */
function savingText(n: number): string {
  return n === 1 ? "Saving runs 1 statement in one transaction." : `Saving runs the ${n.toLocaleString("en-US")} statements in one transaction.`;
}

/** The ORDER BY field's text for a sort: `total` or `total DESC`. */
function sortText(s: SortSpec | null): string {
  return s ? `${s.column}${s.descending ? " DESC" : ""}` : "";
}

/** PR30: one column with an optional ASC or DESC; null when the text is anything else. */
export function parseOrderBy(text: string, columns: ColumnInfo[]): { sort: SortSpec | null } | null {
  const t = text.trim();
  if (t === "") return { sort: null };
  const m = /^("(?:[^"]|"")+"|`(?:[^`]|``)+`|[\p{L}_][\p{L}\p{N}_$]*)(?:\s+(asc|desc))?$/iu.exec(t);
  if (!m) return null;
  const raw = m[1];
  const quoted = raw[0] === '"' || raw[0] === "`";
  const name = quoted ? raw.slice(1, -1).replace(raw[0] === '"' ? /""/g : /``/g, raw[0]) : raw;
  // A bare name matches its column whatever its case; a quoted one is taken as written.
  const column = quoted ? name : (columns.find((c) => c.name.toLowerCase() === name.toLowerCase())?.name ?? name);
  return { sort: { column, descending: m[2]?.toLowerCase() === "desc" } };
}

/** The table as the header names it: `public.orders` with a schema, else `shop.orders`. */
function shortName(t: ObjectPath): string {
  return `${t.schema ?? t.database}.${t.name}`;
}

type Spot = { row: number; column: number };
/** `old` is the full old value of a cut-short cell, loaded before the editor opened. */
type Editing = Spot & { initial: string; multiline: boolean; old?: Cell };

const fullText = (value: string): Cell => ({
  t: "text",
  value,
  truncated: false,
  totalBytes: new TextEncoder().encode(value).length,
});
type Menu = Spot & { x: number; y: number };

/** The page on screen and its index. Replaced, never accumulated. */
type Shown = { index: number; page: Page };

function nextSort(current: SortSpec | null, column: string): SortSpec {
  if (current?.column === column) return { column, descending: !current.descending };
  return { column, descending: false };
}

function rowKey(columns: ColumnInfo[], row: Page["rows"][number]): KeyPart[] {
  return columns.flatMap((c, i) => (c.isPrimaryKey ? [{ column: c.name, value: row[i] }] : []));
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
  ask,
  readOnly = false,
  kind = "table",
  production = false,
  group = null,
  onDirtyChange,
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
}: Props) {
  const { show: showToast } = useToast();
  const [pageIndex, setPageIndex] = useState(0);
  const [sort, setSort] = useState<SortSpec | null>(null);
  /** What is typed in the ORDER BY field. */
  const [orderDraft, setOrderDraft] = useState("");
  /** The client-side filter and the hidden columns of the header's filter and columns menus (PR28). */
  const [rowFilter, setRowFilter] = useState("");
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  /** The filter in use, and what is typed in the box. */
  const [filter, setFilter] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const filterRef = useRef<SqlEditorApi | null>(null);
  const [askSel, setAskSel] = useState<AskSelection | null>(null);
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
    fetchPage(connectionId, { table, page: pageIndex, sort, filter })
      .then((page) => {
        if (!live) return;
        setFetchMs(performance.now() - started);
        setShown({ index: pageIndex, page });
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

  function applyFilter() {
    flushEditor();
    const text = (filterRef.current?.text() ?? draft).trim();
    setFilter(text || null);
    setPageIndex(0);
  }

  function clearFilter(): boolean {
    if (!filter && !draft) return false;
    setDraft("");
    filterRef.current?.replaceAll("");
    setFilter(null);
    setPageIndex(0);
    return true;
  }

  function chooseSort(column: string) {
    flushEditor();
    const next = nextSort(sort, column);
    setSort(next);
    setOrderDraft(sortText(next));
    setPageIndex(0);
  }

  function clearSort() {
    setSort(null);
    setOrderDraft("");
    setPageIndex(0);
  }

  /** Enter in the ORDER BY field: one column with an optional ASC or DESC, else it says what it takes. */
  function applyOrderBy() {
    const parsed = parseOrderBy(orderDraft, columns);
    if (!parsed) return setNote(ORDER_NOTE);
    if (note === ORDER_NOTE) setNote(null);
    const next = parsed.sort;
    if (sortText(next) === sortText(sort)) return;
    flushEditor();
    setSort(next);
    setPageIndex(0);
  }

  const askSchema = lang ? lang.client.sqlSchemaFor(schemaKey(connectionId, table.database)) : null;
  const page = shown?.page ?? null;
  const columns = page?.columns ?? [];
  const firstRow = (shown?.index ?? 0) * PAGE_SIZE + 1;

  // ---- Pending Edits ----
  const editable = !readOnly && kind === "table";
  const sectionRef = useRef<HTMLElement>(null);
  // The refs hold the latest values, so a save right after an edit (Ctrl+S in the editor) sees it.
  const [pending, setPendingState] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const [sel, setSel] = useState<Spot | null>(null);
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

  useEffect(() => {
    if (page && !pendingRef.current) put(emptyPending(page.columns));
    setSel(null);
    setEditing(null);
    setMenu(null);
  }, [page]);
  const view = useMemo(() => displayRows(pending, page), [pending, page]);
  // The latest page and rows, for answers that arrive after the grid moved on.
  const pageRef = useRef(page);
  pageRef.current = page;
  const viewRef = useRef(view);
  viewRef.current = view;
  const keyed = hasKey(columns);

  // The rows and columns on screen, as indexes into `view` and `columns`: the header's filter keeps
  // the rows whose loaded or edited text matches, and every new row; the columns menu hides columns.
  // Selection, editing and Pending Edits stay in `view` and `columns` indexes; only the grid maps.
  const needle = rowFilter.trim().toLowerCase();
  const shownCols = useMemo(() => columns.flatMap((c, i) => (hidden.has(c.name) ? [] : [i])), [columns, hidden]);
  const shownRows = useMemo(() => {
    const hit = (cells: Cell[]) => cells.some((c) => plainText(c).toLowerCase().includes(needle));
    return view.flatMap((d, i) => (!needle || d.kind === "new" || hit(d.cells) || hit(d.source) ? [i] : []));
  }, [view, needle]);
  const rowPos = (row: number) => shownRows.indexOf(row);
  const colPos = (column: number) => shownCols.indexOf(column);
  /** The selected cell is on screen: the header's filter or columns menu has not hidden it. */
  const selShown = !!sel && rowPos(sel.row) >= 0 && colPos(sel.column) >= 0;
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
  // A selection the filter or columns menu hides is dropped, so nothing acts on a cell off screen.
  // The cell menu follows the same rule: it closes when its row or column leaves the screen.
  useEffect(() => {
    if (sel && (!shownRows.includes(sel.row) || !shownCols.includes(sel.column))) setSel(null);
    if (menu && (!shownRows.includes(menu.row) || !shownCols.includes(menu.column))) setMenu(null);
  }, [sel, menu, shownRows, shownCols]);
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

  function openEditor(row: number, column: number, typed?: string) {
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
      setEditing({ row, column, initial, multiline: initial.includes("\n"), old });
    const cell = d.cells[column];
    if (d.kind === "loaded" && cell.t === "text" && cell.truncated) {
      // The full value is the old value Save sends, so it is loaded even when typing over the cell.
      const requested = pageRef.current;
      fetchFullValue(connectionId, { table, column: columns[column].name, key: rowKey(columns, d.source) })
        .then((v) => {
          // Drop the answer when the page or the row at this place is not the one asked about.
          const now = viewRef.current[row];
          if (pageRef.current !== requested || now?.kind !== "loaded" || now.source !== d.source) return;
          if (v.t !== "text") return setNote(BINARY_NOTE);
          if (!inflight.current) start(typed ?? v.value, fullText(v.value));
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

  function addNewRow(values?: Map<string, NewValue>) {
    if (!editable || !pendingRef.current || inflight.current) return;
    update((p) => addRow(p, values)[0]);
    // New rows go at the bottom (T3): the row just added is the last one.
    setSel({ row: view.length, column: shownCols[0] ?? 0 });
    focusGrid();
  }

  async function duplicateRow(row: number) {
    const d = view[row];
    if (!d || !editable || !pendingRef.current || inflight.current) return;
    const at = pageRef.current;
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
          return setNote(errorText(e));
        }
      }
      if (v) values.set(c.name, v);
    }
    // The page may have changed while full values loaded.
    if (pageRef.current !== at || inflight.current) return;
    setNote(binary ? "Binary values aren't copied." : null);
    addNewRow(values);
  }

  function deleteAt(row: number) {
    const d = view[row];
    if (!d || !editable) return;
    if (d.kind === "new") update((p) => deleteRow(p, d.id));
    else if (!d.key) setNote(NO_KEY);
    else update((p) => deleteRow(p, d.key!, d.source));
  }

  function deleteSelected() {
    if (sel && selShown) deleteAt(sel.row);
  }

  function onPaste(e: ClipboardEvent<HTMLDivElement>) {
    if (!editable || editing || !pendingRef.current || inflight.current) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    // The block lands on the rows and columns on screen, from the selected cell; lines past the
    // last row become new rows.
    const at = sel ?? { row: shownRows[0] ?? 0, column: shownCols[0] ?? 0 };
    const r0 = sel ? rowPos(at.row) : 0;
    const c0 = colPos(at.column);
    if (r0 < 0 || c0 < 0) return;
    const lines = parsePaste(text);
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
    update((p0) =>
      batch(p0, (p) => {
        let out = p;
        lines.forEach((line, i) => {
          const d = target(i);
          const cells = span(line).map((value, j) => [column(j).name, { t: "text", value }] as const);
          if (!d) {
            out = addRow(out, new Map<string, NewValue>(cells))[0];
          } else if (d.kind === "new") {
            for (const [name, v] of cells) out = editNewCell(out, d.id, name, v);
          } else if (d.key && !d.deleted) {
            for (const [name, v] of cells) out = editCell(out, d.key, d.source, name, v);
          }
        });
        return out;
      }),
    );
  }

  function onGridKey(e: KeyboardEvent<HTMLDivElement>) {
    if (!editable || editing) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.key === "Escape" && menu) return setMenu(null);
    // The context menu key (or Shift+F10) opens the cell menu on the selected cell.
    if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && sel && selShown) {
      e.preventDefault();
      const cell = sectionRef.current?.querySelector(`tr[data-row="${rowPos(sel.row)}"] td[data-col="${colPos(sel.column)}"]`);
      const box = (cell ?? e.currentTarget).getBoundingClientRect();
      setMenu({ row: sel.row, column: sel.column, x: box.left, y: box.bottom });
      return;
    }
    if (mod && k === "s") return e.preventDefault(), void save();
    if (mod && k === "z" && !e.shiftKey) return e.preventDefault(), update(undo);
    if (mod && (k === "y" || (k === "z" && e.shiftKey))) return e.preventDefault(), update(redo);
    if (mod && k === "n") return e.preventDefault(), addNewRow();
    if (shownRows.length === 0 || shownCols.length === 0) return;
    // Arrow keys move over the rows and columns on screen.
    const r = Math.max(0, sel ? rowPos(sel.row) : 0);
    const c = Math.max(0, sel ? colPos(sel.column) : 0);
    const at = { row: shownRows[r], column: shownCols[c] };
    const moves: Record<string, Spot> = {
      ArrowDown: { row: shownRows[Math.min(r + 1, shownRows.length - 1)], column: at.column },
      ArrowUp: { row: shownRows[Math.max(r - 1, 0)], column: at.column },
      ArrowRight: { row: at.row, column: shownCols[Math.min(c + 1, shownCols.length - 1)] },
      ArrowLeft: { row: at.row, column: shownCols[Math.max(c - 1, 0)] },
    };
    if (moves[e.key]) {
      e.preventDefault();
      setSel(selShown ? moves[e.key] : at);
    } else if (sel && !selShown) {
      // The selected cell is hidden: only the arrow keys act, selecting a cell on screen.
      return;
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      openEditor(at.row, at.column);
    } else if (e.key === "Delete") {
      e.preventDefault();
      deleteSelected();
    } else if (e.key.length === 1 && !mod && !e.altKey) {
      e.preventDefault();
      openEditor(at.row, at.column, e.key);
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

  const dirtyChange = useRef(onDirtyChange);
  dirtyChange.current = onDirtyChange;
  useEffect(() => dirtyChange.current?.(changes > 0), [changes > 0]);
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
  async function apply(edits: EditSet, pass: PassId | null, state: Pending["state"]): Promise<boolean> {
    try {
      await applyEdits(connectionId, edits, pass);
      const now = pendingRef.current;
      if (now && now.state === state) put(discard(now));
      setConflict(null);
      setSaveError(null);
      setAttempt((n) => n + 1);
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
    // The loaded page comes first, so a loaded row's place in `view` is its place on the page.
    const n = (firstRow + r).toLocaleString("en-US");
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

  /** The cell menu's rows; each acts only while its row and column are still on screen. */
  function cellMenuItems(m: Menu): MenuItem[] {
    const shown = () => shownRows.includes(m.row) && shownCols.includes(m.column);
    const items: MenuItem[] = menuItems(m).map((item) => ({
      key: item.label,
      label: item.label,
      onSelect: () => {
        if (shown()) item.run();
      },
    }));
    if (view[m.row]?.kind === "loaded" && columns[m.column]?.isPrimaryKey) {
      items.push({ key: "key-note", label: KEY_NOTE, heading: KEY_NOTE, separatorBefore: items.length > 0 });
    }
    return items;
  }

  function menuItems(m: Menu): { label: string; run: () => void }[] {
    const d = view[m.row];
    if (!d) return [];
    const items: { label: string; run: () => void }[] = [];
    if (d.kind === "new" || !d.deleted) {
      items.push({ label: "Delete row", run: () => deleteAt(m.row) });
      items.push({ label: "Duplicate row", run: () => void duplicateRow(m.row) });
    }
    if (blocked(d, m.column, true) === null) items.push({ label: "Set NULL", run: () => setNull(m.row, m.column) });
    if (d.kind === "loaded" && d.key && editedAt(m.row, m.column)) {
      const name = columns[m.column].name;
      items.push({ label: "Revert", run: () => update((p) => revertCell(p, d.key!, name)) });
    }
    const ref = d.kind === "new" ? d.id : d.key;
    if (ref && (d.kind === "new" || d.deleted || columns.some((_, i) => editedAt(m.row, i)))) {
      items.push({ label: "Revert row", run: () => update((p) => revertRow(p, ref)) });
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
  const gridRows = shownRows.map((i) => (allColumns ? view[i].cells : shownCols.map((c) => view[i].cells[c])));
  const selected = sel && rowPos(sel.row) >= 0 && colPos(sel.column) >= 0 ? { row: rowPos(sel.row), column: colPos(sel.column) } : null;
  const editingAt = editing ? rowPos(editing.row) : -1;

  return (
    <section
      className={["grid-view", production && "prod-wash", production && changes > 0 && "grid-production-edits"]
        .filter(Boolean)
        .join(" ")}
      aria-label={`Data of ${table.name}`}
      ref={sectionRef}
    >
      {/* T1: one 36 px strip: Connection, PRODUCTION, the table, WHERE and ORDER BY, then the tools. */}
      <div className="table-header" role="toolbar" aria-label="Table">
        {connectionName &&
          (onOpenQuery ? (
            <MenuButton
              label="Connection"
              compact
              trigger={(p) => (
                <button type="button" {...p} className="button button-small button-quiet table-header-connection">
                  <DbMark dialect={dialect} open size={14} label={null} />
                  <span className="editor-header-name">{connectionName}</span>
                  <Icon name="chevronDown" size={14} />
                </button>
              )}
              items={[
                {
                  key: "query",
                  label: `New query on ${connectionName}`,
                  icon: <Icon name="fileQuery" size={14} />,
                  onSelect: () => onOpenQuery(""),
                },
              ]}
            />
          ) : (
            <span className="table-header-connection">
              <DbMark dialect={dialect} open size={14} label={null} />
              <span className="editor-header-name">{connectionName}</span>
            </span>
          ))}
        {production && <span className="production-label">PRODUCTION</span>}
        {(connectionName || production) && <span className="editor-header-divider" aria-hidden="true" />}
        <Icon name={kind === "view" ? "view" : "table"} size={14} className="muted" />
        <h2 className="table-header-name" title={`${objectPrefix(table)}${table.name}`}>
          {shortName(table)}
        </h2>
        <div className="grid-filter">
          <span className="grid-filter-label" aria-hidden="true">
            WHERE
          </span>
          <SqlEditor
            oneLine
            value={draft}
            dialect={dialect}
            editorRef={filterRef}
            onChange={setDraft}
            onRun={applyFilter}
            onFormat={() => {}}
            onSave={() => void save()}
            onEscape={clearFilter}
            onAsk={ask ? setAskSel : undefined}
            lang={
              lang && {
                client: lang.client,
                docId: `filter:${connectionId}:${objectPrefix(table)}${table.name}`,
                schemaKey: schemaKey(connectionId, table.database),
                schemaState: schemaLoad === "loaded" ? "loaded" : schemaLoad === "loading" ? "loading" : "none",
                prefix: `SELECT * FROM ${sqlName(dialect, table)} WHERE `,
              }
            }
          />
          {ask && askSel && (
            <InlineAsk
              context={{
                kind: "filter",
                connection: ask.connection,
                sql: askSel.sql,
                tables: [{ schema: table.schema, name: table.name }],
                label: table.name,
              }}
              schema={askSchema}
              groupId={ask.groupId}
              onOpenInChat={ask.onOpenInChat}
              onOpenSettings={ask.onOpenSettings}
              onClose={() => {
                setAskSel(null);
                filterRef.current?.focus();
              }}
            />
          )}
        </div>
        <div className="order-by">
          <span className="order-by-label" aria-hidden="true">
            ORDER BY
          </span>
          <input
            className="order-by-input"
            type="text"
            aria-label="Order by"
            title={ORDER_NOTE}
            spellCheck={false}
            value={orderDraft}
            onChange={(e) => setOrderDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyOrderBy();
              } else if (e.key === "Escape" && (orderDraft || sort)) {
                e.preventDefault();
                if (note === ORDER_NOTE) setNote(null);
                if (sort) clearSort();
                else setOrderDraft("");
              }
            }}
          />
        </div>
        <span className="editor-header-divider" aria-hidden="true" />
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
        {onDesign && kind === "table" && (
          <button type="button" className="icon-button" aria-label="Design table" title="Design table" onClick={onDesign}>
            <Icon name="edit" size={14} />
          </button>
        )}
        {onLineage && kind === "table" && (
          <button type="button" className="icon-button" aria-label="Show lineage" title="Show lineage" onClick={onLineage}>
            <Icon name="flow" size={14} />
          </button>
        )}
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
              title="Delete row (Delete)"
              disabled={!selShown || !keyed || busy}
              onClick={deleteSelected}
            >
              <Icon name="minus" size={14} />
            </button>
          </>
        )}
        <ResultTools
          columns={columns.map((c) => ({ name: c.name, typeName: c.typeName, numeric: NUMERIC_TYPE.test(c.typeName) }))}
          rows={shownRows.map((i) => view[i].cells)}
          filter={rowFilter}
          onFilter={setRowFilter}
          hidden={hidden}
          onToggleColumn={(name) =>
            setHidden((h) => {
              const next = new Set(h);
              if (!next.delete(name)) next.add(name);
              return next;
            })
          }
          connectionName={connectionName ? `${connectionName}_${table.name}` : table.name}
          onExport={onExport ? () => onExport(exportOrigin()) : undefined}
          onImport={onImport}
        />
        <div className={loading ? "progress progress-on" : "progress"} aria-hidden="true">
          <i />
        </div>
      </div>

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
                Clear filter
              </button>
            )}
          </div>
        </div>
      ) : (
        <ResultGrid
          columns={gridColumns}
          rows={gridRows}
          resetKey={page}
          label={`Rows of ${table.name}`}
          firstRow={firstRow}
          stale={loading}
          sort={sort}
          onSort={chooseSort}
          rowLabel={(r) => rowLabel(shownRows[r])}
          {...(readOnly && kind === "table" && { onOpen: readOnlyEdit })}
          {...(editable && {
            editingRow: editingAt < 0 ? null : editingAt,
            onEditorLost: flushEditor,
            selected,
            onSelect: (row: number, column: number) => {
              setSel({ row: shownRows[row], column: shownCols[column] });
              setMenu(null);
            },
            onOpen: (row: number, column: number) => openEditor(shownRows[row], shownCols[column]),
            onGridKey,
            onPaste,
            onCellMenu: (row: number, column: number, x: number, y: number) =>
              setMenu({ row: shownRows[row], column: shownCols[column], x, y }),
            cellClass: (r: number, c: number) => (editedAt(shownRows[r], shownCols[c]) ? "cell-edited" : undefined),
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
                    initial={editing.initial}
                    multiline={editing.multiline}
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
          {page && page.rows.length === 0 && (
            <p className="state-panel muted">
              {shown?.index === 0 ? `${table.name} has no rows.` : "No more rows. Go back a page."}
            </p>
          )}
          {page && view.length > 0 && shownRows.length === 0 && <p className="state-panel muted">No loaded row matches the filter.</p>}
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
          onDiscard={() => void discardAll()}
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
