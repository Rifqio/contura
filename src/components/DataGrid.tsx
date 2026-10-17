import {
  type ClipboardEvent,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { applyEdits, confirmEdits, errorText, fetchFullValue, fetchPage, isNotOpen, planEdits } from "../api/client";
import type {
  Cell,
  ColumnInfo,
  ConnectionId,
  DialectKind,
  EditSet,
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
  /** A Production Connection: Save asks first, and a grid with edits gets the amber outline. */
  production?: boolean;
  /** Told when the grid gains or loses Pending Edits. */
  onDirtyChange?(dirty: boolean): void;
  /** Lets the parent save before closing; resolves false when the save failed or was cancelled. */
  controlRef?: MutableRefObject<GridControl | null>;
}

export interface GridControl {
  save(): Promise<boolean>;
  discard(): void;
  /** Keeps the value in an open cell editor; true when the grid then has Pending Edits. */
  flush(): boolean;
}

type Ask = Extract<RunVerdict, { kind: "needsConfirmation" }>;

const READ_ONLY_TIP = "Read-only Connection: cells can't be edited";
const NO_KEY = "This table has no primary key, so its rows can't be edited";
const KEY_NOTE = "Key columns can't be changed here";
const BINARY_NOTE = "Binary values can only be set to NULL here";
const PASTE_KEY_NOTE = "Pasting can't change key columns.";
const PASTE_DELETED_NOTE = "Deleted rows can't be edited. Revert the row first.";

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
  onClose,
  onNotOpen,
  dialect = "postgres",
  lang,
  ask,
  readOnly = false,
  kind = "table",
  production = false,
  onDirtyChange,
  controlRef,
}: Props) {
  const [pageIndex, setPageIndex] = useState(0);
  const [sort, setSort] = useState<SortSpec | null>(null);
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

  // `table` is fixed for this component's lifetime: the parent re-keys it per table.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fetchPage(connectionId, { table, page: pageIndex, sort, filter })
      .then((page) => {
        if (!live) return;
        setShown({ index: pageIndex, page });
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
    setSort((s) => nextSort(s, column));
    setPageIndex(0);
  }

  function clearSort() {
    setSort(null);
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
  const addedCount = view.findIndex((d) => d.kind === "loaded") < 0 ? view.length : view.findIndex((d) => d.kind === "loaded");

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
    const next =
      move === "down"
        ? { row: Math.min(at.row + 1, view.length - 1), column: at.column }
        : move === "right"
          ? { row: at.row, column: Math.min(at.column + 1, columns.length - 1) }
          : { row: at.row, column: at.column };
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
    setSel({ row: 0, column: 0 });
    focusGrid();
  }

  async function duplicateRow() {
    const d = sel && view[sel.row];
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
    if (sel) deleteAt(sel.row);
  }

  function onPaste(e: ClipboardEvent<HTMLDivElement>) {
    if (!editable || editing || !pendingRef.current || inflight.current) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    const at = sel ?? { row: 0, column: 0 };
    const lines = parsePaste(text);
    const span = (line: string[]) => line.slice(0, columns.length - at.column);
    for (const [i, line] of lines.entries()) {
      const d = view[at.row + i];
      if (d?.kind !== "loaded") continue;
      if (!d.key) return setNote(NO_KEY);
      if (d.deleted) return setNote(PASTE_DELETED_NOTE);
      if (span(line).some((_, j) => columns[at.column + j].isPrimaryKey)) return setNote(PASTE_KEY_NOTE);
    }
    setNote(null);
    update((p0) =>
      batch(p0, (p) => {
        let out = p;
        lines.forEach((line, i) => {
          const d = view[at.row + i];
          const cells = span(line).map((value, j) => [columns[at.column + j].name, { t: "text", value }] as const);
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
    if (mod && k === "s") return e.preventDefault(), void save();
    if (mod && k === "z" && !e.shiftKey) return e.preventDefault(), update(undo);
    if (mod && (k === "y" || (k === "z" && e.shiftKey))) return e.preventDefault(), update(redo);
    if (mod && k === "n") return e.preventDefault(), addNewRow();
    if (view.length === 0 || columns.length === 0) return;
    const at = sel ?? { row: 0, column: 0 };
    const moves: Record<string, Spot> = {
      ArrowDown: { row: Math.min(at.row + 1, view.length - 1), column: at.column },
      ArrowUp: { row: Math.max(at.row - 1, 0), column: at.column },
      ArrowRight: { row: at.row, column: Math.min(at.column + 1, columns.length - 1) },
      ArrowLeft: { row: at.row, column: Math.max(at.column - 1, 0) },
    };
    if (moves[e.key]) {
      e.preventDefault();
      setSel(sel ? moves[e.key] : at);
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

  function discardAll() {
    setEditing(null);
    update(discard);
    setSaveError(null);
    setConflict(null);
  }

  function reloadRows() {
    flushEditor();
    setAttempt((n) => n + 1);
  }

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
    };
  }

  function rowLabel(r: number): ReactNode {
    const d = view[r];
    if (!d) return undefined;
    if (d.kind === "new") return "+";
    const n = (firstRow + r - addedCount).toLocaleString("en-US");
    if (d.deleted) return <span className="row-number-deleted">{n}</span>;
    const edited = d.key && pending && columns.some((c) => pendingValue(pending, d.key!, c.name));
    return edited ? <span className="row-number-edited">{n}</span> : n;
  }

  function editedAt(r: number, c: number): boolean {
    const d = view[r];
    return !!(d?.kind === "loaded" && d.key && pending && pendingValue(pending, d.key, columns[c].name));
  }

  function menuItems(m: Menu): { label: string; run: () => void }[] {
    const d = view[m.row];
    if (!d) return [];
    const items: { label: string; run: () => void }[] = [];
    if (d.kind === "new" || !d.deleted) items.push({ label: "Delete row", run: () => deleteAt(m.row) });
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

  const rangeText =
    page && page.rows.length > 0
      ? `Rows ${firstRow.toLocaleString("en-US")} to ${(firstRow + page.rows.length - 1).toLocaleString("en-US")}`
      : "";

  return (
    <section
      className={production && changes > 0 ? "grid-view grid-production-edits" : "grid-view"}
      aria-label={`Data of ${table.name}`}
      ref={sectionRef}
    >
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
        {editable && page && (
          <span className="toolbar-group">
            <button
              type="button"
              className="icon-button"
              aria-label="Add row"
              title="Add row (Ctrl+N)"
              disabled={busy}
              onClick={() => addNewRow()}
            >
              <Icon name="plus" />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Duplicate row"
              title="Duplicate row"
              disabled={!sel || busy}
              onClick={duplicateRow}
            >
              <Icon name="copy" />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Delete row"
              title="Delete row (Delete)"
              disabled={!sel || !keyed || busy}
              onClick={deleteSelected}
            >
              <Icon name="minus" />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Undo"
              title="Undo (Ctrl+Z)"
              disabled={!pending?.past.length || busy}
              onClick={() => update(undo)}
            >
              <Icon name="undo" />
            </button>
          </span>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label="Reload"
          title="Reload rows"
          disabled={loading}
          onClick={reloadRows}
        >
          <Icon name="refresh" />
        </button>
        <button type="button" className="icon-button" aria-label={`Close ${table.name}`} onClick={onClose}>
          <Icon name="close" />
        </button>
        <div className={loading ? "progress progress-on" : "progress"} aria-hidden="true">
          <i />
        </div>
      </div>

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

      {editable && page && (!keyed || note) && (
        <p className="grid-note" role="status">
          {!keyed ? NO_KEY : note}
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
          columns={columns.map((c) => ({ ...c, numeric: NUMERIC_TYPE.test(c.typeName) }))}
          rows={view.map((d) => d.cells)}
          resetKey={page}
          label={`Rows of ${table.name}`}
          firstRow={firstRow}
          stale={loading}
          sort={sort}
          onSort={chooseSort}
          {...(editable && {
            editingRow: editing?.row ?? null,
          onEditorLost: flushEditor,
          selected: sel,
            onSelect: (row: number, column: number) => {
              setSel({ row, column });
              setMenu(null);
            },
            onOpen: openEditor,
            onGridKey,
            onPaste,
            onCellMenu: (row: number, column: number, x: number, y: number) => setMenu({ row, column, x, y }),
            cellClass: (r: number, c: number) => (editedAt(r, c) ? "cell-edited" : undefined),
            cellTitle: (r: number, c: number) => {
              const d = view[r];
              return d?.kind === "loaded" && editedAt(r, c)
                ? `Was ${cellText(d.source[c])}. Edited, not saved yet.`
                : undefined;
            },
            rowClass: (r: number) => {
              const d = view[r];
              if (d?.kind === "new") return "row-added";
              if (d?.deleted) return "row-deleted";
              return d && conflict !== null && d.key === conflict ? "row-conflict" : undefined;
            },
            rowLabel,
            renderCell: (r: number, c: number) => {
              if (editing && editing.row === r && editing.column === c) {
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
              const d = view[r];
              return d?.kind === "new" && !d.set[c] ? <span className="cell-default">default</span> : undefined;
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
            const d = view[r];
            return page && d?.kind === "loaded" ? { connectionId, table, column, rowKey: rowKey(page.columns, d.source) } : undefined;
          }}
        >
          {page && page.rows.length === 0 && (
            <p className="state-panel muted">
              {shown?.index === 0 ? `${table.name} has no rows.` : "No more rows. Go back a page."}
            </p>
          )}
        </ResultGrid>
      )}

      {pending && previewOpen && changes > 0 && (
        <PreviewSql connectionId={connectionId} edits={toEditSet(pending, table)} onClose={() => setPreviewOpen(false)} />
      )}

      {pending && changes > 0 && (
        <EditsBar
          summary={summary(pending)}
          changes={changes}
          busy={saving}
          error={saveError}
          previewOpen={previewOpen}
          onPreview={() => setPreviewOpen((o) => !o)}
          onDiscard={discardAll}
          onSave={() => void save()}
        />
      )}

      {confirm && (
        <ConfirmRun verb="Save" verdict={confirm.verdict} noWhere={null} onRun={() => void confirmSave()} onCancel={cancelSave} onAddWhere={() => {}} />
      )}

      {menu && (
        <div className="cell-menu" role="menu" style={{ left: menu.x, top: menu.y }} onKeyDown={(e) => e.key === "Escape" && setMenu(null)}>
          {menuItems(menu).map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                item.run();
                setMenu(null);
                focusGrid();
              }}
            >
              {item.label}
            </button>
          ))}
          {view[menu.row]?.kind === "loaded" && columns[menu.column]?.isPrimaryKey && (
            <p className="menu-note">{KEY_NOTE}</p>
          )}
        </div>
      )}

      <div className="status-bar">
        <span className="pager">
          <button
            type="button"
            className="icon-button"
            aria-label="Previous page"
            disabled={pageIndex === 0 || loading}
            onClick={() => goToPage(pageIndex - 1)}
          >
            <Icon name="chevronLeft" />
          </button>
          <span>Page {(pageIndex + 1).toLocaleString("en-US")}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Next page"
            disabled={loading || !page?.hasMore}
            onClick={() => goToPage(pageIndex + 1)}
          >
            <Icon name="chevronRight" />
          </button>
        </span>
      </div>
    </section>
  );
}
