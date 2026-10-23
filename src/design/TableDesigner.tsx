import {
  type KeyboardEvent,
  type MutableRefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { DIALECT_LABEL, applyDesign, confirmDesign, errorText, planDesign, tableDdl, tableDesign } from "../api/client";
import type {
  ConnectionConfig,
  DesignRequest,
  DesignVerdict,
  Group,
  ObjectPath,
  PassId,
  RunVerdict,
  TableDesign,
} from "../api/types";
import type { GridControl } from "../components/DataGrid";
import Dialog from "../components/Dialog";
import Icon from "../components/Icon";
import SqlBlock from "../components/SqlBlock";
import { useToast } from "../components/Toast";
import { plural } from "../format/plural";
import ConfirmRun from "../query/ConfirmRun";
import type { LangClient } from "../lang/client";
import type { SchemaCache } from "../lang/sql/schemaCache";
import type { DesignTabTarget } from "../shell/tabs";
import DesignBar from "./DesignBar";
import DesignPreview, { modeLine } from "./DesignPreview";
import ColumnsTab, { CELL_FIELD, type CellAt, TEXT_CELLS, cellEditable, columnCells } from "./ColumnsTab";
import {
  type Draft,
  addColumn,
  addForeignKey,
  addIndex,
  changeCount,
  droppedIndexNotes,
  editColumn,
  editForeignKey,
  editIndex,
  emptyDraft,
  fromDesign,
  keysProblem,
  moveColumn,
  removeColumn,
  removeForeignKey,
  removeIndex,
  renameTable,
  restoreColumn,
  toEdits,
  togglePrimary,
} from "./draft";
import ForeignKeysTab, { foreignKeyNameEditable } from "./ForeignKeysTab";
import IndexesTab, { indexNameEditable } from "./IndexesTab";
import { warningText } from "./warnings";

interface Props {
  connection: ConnectionConfig;
  target: DesignTabTarget;
  group: Group | null;
  /** The tab is on screen: its counts then show in the window status bar (D29). */
  visible: boolean;
  /** Told when the draft gains or loses changes. */
  onDirtyChange(dirty: boolean): void;
  /** The App's leave ask saves (applies), discards and counts through this. */
  controlRef: MutableRefObject<GridControl | null>;
  onApplied(path: ObjectPath, kind: "altered" | "created" | "dropped"): void;
  onDrop?(path: ObjectPath): void;
  lang: { client: LangClient; schemas: SchemaCache };
}

type InnerTab = "columns" | "indexes" | "foreignKeys";
type RowTab = Exclude<InnerTab, "columns">;
/** An open cell editor: a column's cell, or an index's or key's name. */
type ColumnEdit = CellAt & { initial: string };
type RowEdit = { row: RowTab; id: string; initial: string };
type Editing = ColumnEdit | RowEdit;
const isRowEdit = (e: Editing | null): e is RowEdit => !!e && "row" in e;
type Load = { s: "loading" } | { s: "failed"; message: string } | { s: "ready" };

const PG_MOVE = "PostgreSQL cannot reorder columns";
const ADD_LABEL: Record<InnerTab, string> = { columns: "Add column", indexes: "Add index", foreignKeys: "Add foreign key" };
const REMOVE_LABEL: Record<InnerTab, string> = {
  columns: "Remove column",
  indexes: "Remove index",
  foreignKeys: "Remove foreign key",
};

const COPY_ONLY = "Contura cannot rebuild this table safely. Copy the SQL preview to run it yourself.";
const CREATE_NEEDS = "Add a name and at least one column.";
/** Apply planned SQL other than the preview showed (S13 I2): the new plan is shown instead of run. */
export const PREVIEW_CHANGED = "The preview changed. Check it and Apply again.";

const sameStatements = (a: string[], b: string[] | null) => !!b && a.length === b.length && a.every((s, i) => s === b[i]);

/** A new table needs its name and one column with a name and a type before Apply. */
function createReady(dr: Draft): boolean {
  return (
    dr.path.name.trim() !== "" &&
    dr.columns.some((c) => !dr.removed.includes(c.id) && c.name.trim() !== "" && c.typeSql.trim() !== "")
  );
}

type Ask = Extract<RunVerdict, { kind: "needsConfirmation" }>;
/** The last Apply's failure; `reload` when the table may differ from the loaded design. */
type ApplyError = { text: string; reload: boolean };

/**
 * Why the draft cannot be planned yet (M4): a blank added row, a column without a name or type,
 * or an index or key that is not whole, named in the message.
 */
export function draftProblem(dr: Draft): string | null {
  for (const c of dr.columns) {
    if (dr.removed.includes(c.id)) continue;
    const name = c.name.trim();
    const type = c.typeSql.trim();
    if (c.origin === null && name === "" && type === "") return "Fill in the new column's name and type, or remove it.";
    if (name === "") return "A column has no name. Name it, or remove it.";
    if (type === "") return `Column ${name} has no type. Type one, such as int.`;
  }
  return keysProblem(dr);
}

/** The read model's note kinds, as one and as many. */
const NOTE_KINDS: [prefix: string, one: string, many: string][] = [
  ["generated column ", "generated column", "generated columns"],
  ["check constraint ", "check", "checks"],
  ["check ", "check", "checks"],
  ["trigger ", "trigger", "triggers"],
];
/** Table options the read model names whole. */
const TABLE_NOTES: Record<string, string> = { "without rowid": "WITHOUT ROWID", strict: "STRICT" };
/** `index ix (include columns)`: the row says "Only rename or remove" already, so this line leaves it out. */
const ADVANCED_NOTE = /^(index|foreign key|column) .* \(.*\)$/;

/** "2 checks, 1 trigger" from the read model's `check c1`, `check c2`, `trigger t` (M1). */
export function unsupportedNote(items: string[]): string | null {
  const counts = new Map<string, { one: string; many: string; n: number }>();
  const count = (one: string, many = one) => {
    const had = counts.get(one);
    counts.set(one, { one, many, n: (had?.n ?? 0) + 1 });
  };
  for (const raw of items) {
    const item = raw.trim();
    if (item === "" || ADVANCED_NOTE.test(item)) continue;
    const table = TABLE_NOTES[item.toLowerCase()];
    if (table) {
      count(table);
      continue;
    }
    const kind = NOTE_KINDS.find(([prefix]) => item.toLowerCase().startsWith(prefix));
    // A kind not known here is named as the read model wrote it.
    if (kind) count(kind[1], kind[2]);
    else count(item);
  }
  if (counts.size === 0) return null;
  return `Not editable here: ${[...counts.values()].map(({ one, many, n }) => (one === many ? one : plural(n, one, many))).join(", ")}`;
}

function startDraft(target: DesignTabTarget, design: TableDesign | null): Draft {
  if (target.kind === "alter") return design ? fromDesign(design) : emptyDraft(target.path);
  return emptyDraft({ database: target.scope.database, schema: target.scope.schema, name: "" });
}

/** The Table Designer: a table's columns, indexes and keys as a draft, applied as one plan. */
export default function TableDesigner({
  connection,
  target,
  group,
  visible,
  onDirtyChange,
  controlRef,
  onApplied,
  onDrop,
  lang,
}: Props) {
  const readOnly = connection.readOnly;
  const dialect = connection.dialect;
  const [load, setLoad] = useState<Load>(target.kind === "alter" ? { s: "loading" } : { s: "ready" });
  const [attempt, setAttempt] = useState(0);
  const [design, setDesign] = useState<TableDesign | null>(null);
  const [draft, setDraftState] = useState<Draft | null>(() => (target.kind === "create" ? startDraft(target, null) : null));
  const draftRef = useRef(draft);
  const setDraft = useCallback((next: Draft | null) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);
  const [tab, setTab] = useState<InnerTab>("columns");
  const [selected, setSelected] = useState<CellAt | null>(null);
  /** The selected row of the Indexes and Foreign keys tabs, by id. */
  const [picked, setPicked] = useState<Record<RowTab, string | null>>({ indexes: null, foreignKeys: null });
  const [editing, setEditingState] = useState<Editing | null>(null);
  const editingRef = useRef(editing);
  const setEditing = (next: Editing | null) => {
    editingRef.current = next;
    setEditingState(next);
  };
  /** The value in the open cell editor, kept so a leave ask can save it. */
  const editValue = useRef("");
  const tableRef = useRef<HTMLDivElement>(null);
  const { show: showToast } = useToast();
  /** The preview's latest plan, for the CopyOnly check. */
  const [plan, setPlan] = useState<DesignVerdict | null>(null);
  const [busy, setBusyState] = useState(false);
  /** Apply is planning, confirming or applying: the draft is locked until it ends (I1). */
  const busyRef = useRef(false);
  const setBusy = (b: boolean) => {
    busyRef.current = b;
    setBusyState(b);
  };
  /** Read-only, or an Apply in flight: nothing may change the draft. */
  const locked = () => readOnly || busyRef.current;
  const [applyError, setApplyError] = useState<ApplyError | null>(null);
  const [confirm, setConfirm] = useState<{
    verdict: Ask;
    request: DesignRequest;
    count: number;
    replanned: boolean;
    warnings: string[];
  } | null>(null);
  const confirmDone = useRef<((ok: boolean) => void) | null>(null);
  const inflight = useRef<Promise<boolean> | null>(null);
  /**
   * An Apply changed the database (S13 I1): the draft is spent until the reload lands, so nothing
   * applies it again and nothing counts it. A create stays spent: the App turns this tab into an alter tab.
   */
  const [spent, setSpentState] = useState(false);
  const spentRef = useRef(false);
  const setSpent = (s: boolean) => {
    spentRef.current = s;
    setSpentState(s);
  };
  /** The statements the preview shows now; Apply runs only these without asking (S13 I2). */
  const shownRef = useRef<string[] | null>(null);
  /** A plan Apply made that the preview did not show yet: the preview shows it at once. */
  const [fresh, setFresh] = useState<{ key: string; plan: DesignVerdict } | null>(null);
  const [askReload, setAskReload] = useState(false);
  const [ddl, setDdl] = useState<{ sql: string } | { error: string } | null>(null);

  // `target` is fixed for this component's lifetime: the App keys it per tab.
  useEffect(() => {
    if (target.kind !== "alter") return;
    let live = true;
    setLoad({ s: "loading" });
    tableDesign(connection.id, target.path).then(
      (d) => {
        if (!live) return;
        setDesign(d);
        setDraft(fromDesign(d));
        setSpent(false);
        setLoad({ s: "ready" });
      },
      (e) => live && setLoad({ s: "failed", message: errorText(e) }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  // D20: a Read-only Connection shows the table's DDL where the preview would be.
  useEffect(() => {
    if (!readOnly || target.kind !== "alter") return;
    let live = true;
    tableDdl(connection.id, target.path).then(
      (sql) => live && setDdl({ sql }),
      (e) => live && setDdl({ error: errorText(e, dialect) }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  const changes = draft && !spent ? changeCount(draft) : 0;
  const dirty = changes > 0;
  useEffect(() => {
    onDirtyChange(dirty);
    // Told on a change only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  /** Keeps the value of an open cell editor in the draft; returns the draft after it. */
  function keepEditor(value = editValue.current): Draft | null {
    const at = editingRef.current;
    const dr = draftRef.current;
    if (!at || !dr) return dr;
    setEditing(null);
    if (isRowEdit(at)) {
      const next = at.row === "indexes" ? editIndex(dr, at.id, { name: value }) : editForeignKey(dr, at.id, { name: value });
      change(next);
      return next;
    }
    const field = CELL_FIELD[at.cell];
    if (!field) return dr;
    const next = editColumn(dr, at.id, { [field]: value });
    change(next);
    return next;
  }

  const tableName = target.kind === "alter" ? target.path.name : (draft?.path.name ?? "");

  /** A user edit: the draft moves on, so the last Apply's error no longer describes it. */
  function change(next: Draft) {
    setApplyError(null);
    setDraft(next);
  }

  /** The request for a draft: Alter carries the design as loaded (D1). */
  function requestFor(dr: Draft): DesignRequest | null {
    if (target.kind === "alter") return design ? { target: { kind: "alter", base: design }, edits: toEdits(dr) } : null;
    return { target: { kind: "create", path: { ...dr.path, name: dr.path.name.trim() } }, edits: toEdits(dr) };
  }

  /** Why Apply cannot plan the draft yet; a new table first needs its name and a column. */
  function problemOf(dr: Draft): string | null {
    if (target.kind === "create" && !createReady(dr)) return CREATE_NEEDS;
    return draftProblem(dr);
  }

  function rename(name: string) {
    const dr = draftRef.current;
    if (!dr || locked()) return;
    change(renameTable(dr, name));
  }

  function readOnlyToast() {
    showToast({ kind: "readOnly", text: `${connection.name} is Read-only. Changes are not allowed.` });
  }

  /** Loads the design from the server again; the draft goes with it. */
  function reload() {
    setAskReload(false);
    setApplyError(null);
    setPlan(null);
    setEditing(null);
    setSelected(null);
    setAttempt((n) => n + 1);
  }

  /** The table a sent request changed: from the request, never from the draft edited since. */
  function sentPath(request: DesignRequest): ObjectPath {
    return request.target.kind === "create" ? request.target.path : request.target.base.path;
  }

  function succeeded(request: DesignRequest, count: number) {
    setApplyError(null);
    const path = sentPath(request);
    if (request.target.kind === "create") {
      // The App turns this tab into the new table's design tab.
      showToast({ kind: "success", text: `Created ${path.name}.` });
      setSpent(true);
      onApplied(path, "created");
      return;
    }
    setSpent(true);
    showToast({ kind: "success", text: `Applied ${plural(count, "change", "changes")} to ${path.name}.` });
    onApplied(path, "altered");
    reload();
  }

  function failed(e: unknown, request?: DesignRequest) {
    const err = e as { kind?: string; message?: { ran?: number; applied?: boolean } };
    if (err?.kind === "readOnly" || err?.kind === "readOnlyRefused") {
      readOnlyToast();
      return;
    }
    const text = errorText(e, dialect);
    // Statements already committed are on the server: show the table as it is now (Review Focus 2).
    const changed =
      (err?.kind === "designFailed" && (err.message?.ran ?? 0) > 0) ||
      (err?.kind === "designRestoreFailed" && err.message?.applied === true);
    if (changed && request?.target.kind === "create") {
      // The table may exist now (M4): the App turns this tab into its design tab, so the next
      // Apply is an ALTER. This tab goes, so the error stays in a toast until it is closed.
      showToast({ kind: "error", text });
      setSpent(true);
      onApplied(request.target.path, "created");
      return;
    }
    if (changed) {
      setSpent(true);
      reload();
      setApplyError({ text, reload: false });
      return;
    }
    // Nothing ran: the table may have changed on the server since it was loaded (D1).
    setApplyError({ text, reload: err?.kind === "designFailed" && target.kind === "alter" });
  }

  /** Applies with a pass (or none); an expired or used pass is planned and confirmed once more. */
  async function send(request: DesignRequest, pass: PassId | null, count: number, replanned: boolean): Promise<boolean> {
    try {
      await applyDesign(connection.id, request, pass);
      succeeded(request, count);
      return true;
    } catch (e) {
      // Plans again once; a second refusal is shown rather than asked about forever.
      if ((e as { kind?: string })?.kind === "needsConfirmation" && !replanned) return runApply(request, count, true);
      failed(e, request);
      return false;
    }
  }

  async function runApply(request: DesignRequest, count: number, replanned = false): Promise<boolean> {
    try {
      const p = await planDesign(connection.id, request);
      setPlan(p);
      if (p.plan.mode.kind === "copyOnly") {
        setApplyError({ text: COPY_ONLY, reload: false });
        return false;
      }
      if (p.verdict.kind === "readOnly") {
        readOnlyToast();
        return false;
      }
      if (p.verdict.kind === "needsConfirmation") {
        const verdict = p.verdict;
        return await new Promise<boolean>((resolve) => {
          confirmDone.current = resolve;
          // A Sequential plan's risk is what the user confirms, so the dialog says it too.
          const mode = p.plan.mode.kind === "sequential" ? [modeLine(p.plan.mode, p.plan.statements.length)] : [];
          setConfirm({ verdict, request, count, replanned, warnings: [...mode, ...p.plan.warnings.map(warningText)] });
        });
      }
      // Nothing confirms this plan, so it runs only as the preview shows it (S13 I2).
      if (!sameStatements(p.plan.statements, shownRef.current)) {
        setFresh({ key: JSON.stringify(request), plan: p });
        setApplyError({ text: PREVIEW_CHANGED, reload: false });
        return false;
      }
      return await send(request, null, count, replanned);
    } catch (e) {
      failed(e, request);
      return false;
    }
  }

  /** Apply: plan, confirm on Production, run; one at a time. Resolves true when nothing is left to apply. */
  function apply(): Promise<boolean> {
    const dr = keepEditor();
    // Read-only refuses before anything runs.
    if (readOnly) {
      readOnlyToast();
      return Promise.resolve(false);
    }
    if (inflight.current) return inflight.current;
    // The draft is applied already: until the reload lands nothing is left to apply, and a second
    // CREATE must never go out (the alter tab that replaces this one applies from here on).
    if (spentRef.current) return Promise.resolve(true);
    if (!dr || changeCount(dr) === 0) return Promise.resolve(true);
    const problem = problemOf(dr);
    const request = requestFor(dr);
    if (problem || !request) {
      if (problem) setApplyError({ text: problem, reload: false });
      return Promise.resolve(false);
    }
    setBusy(true);
    setApplyError(null);
    const run: Promise<boolean> = runApply(request, changeCount(dr)).finally(() => {
      if (inflight.current !== run) return;
      inflight.current = null;
      setBusy(false);
    });
    inflight.current = run;
    return run;
  }

  async function confirmApply() {
    const current = confirm;
    const done = confirmDone.current;
    setConfirm(null);
    confirmDone.current = null;
    if (!current || !done) return;
    try {
      const pass = await confirmDesign(connection.id, current.request);
      done(await send(current.request, pass, current.count, current.replanned));
    } catch (e) {
      failed(e, current.request);
      done(false);
    }
  }

  function cancelApply() {
    // Nothing is applying any more, so editing and Apply work again at once.
    inflight.current = null;
    setBusy(false);
    confirmDone.current?.(false);
    confirmDone.current = null;
    setConfirm(null);
  }

  /** Drops the draft's changes; false, with nothing dropped, while Apply runs. */
  function discard(): boolean {
    if (busyRef.current) return false;
    setApplyError(null);
    setEditing(null);
    setSelected(null);
    setDraft(startDraft(target, design));
    return true;
  }

  useEffect(() => {
    controlRef.current = {
      save: apply,
      discard,
      flush: () => {
        if (spentRef.current) return false;
        const dr = keepEditor();
        return dr ? changeCount(dr) > 0 : false;
      },
      pendingCount: () => (draftRef.current && !spentRef.current ? changeCount(draftRef.current) : 0),
    };
  });
  useEffect(
    () => () => {
      controlRef.current = null;
    },
    [controlRef],
  );

  const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setStatusSlot(visible ? document.getElementById("app-status-slot") : null);
  }, [visible]);

  const cells = columnCells(dialect);
  const columns = draft?.columns ?? [];
  const shownColumns = draft ? columns.filter((c) => !draft.removed.includes(c.id)).length : 0;
  const rowAt = selected ? columns.findIndex((c) => c.id === selected.id) : -1;
  const pgAlter = dialect === "postgres" && target.kind === "alter";
  const canEdit = !readOnly && !busy && load.s === "ready" && !!draft;
  const canMove = canEdit && !pgAlter && tab === "columns" && rowAt >= 0;
  const rowTab: RowTab | null = tab === "columns" ? null : tab;
  const rows: { id: string; primary?: boolean }[] = !draft || !rowTab ? [] : rowTab === "indexes" ? draft.indexes : draft.foreignKeys;
  const pickedId = rowTab ? picked[rowTab] : null;
  const pickedAt = rows.findIndex((r) => r.id === pickedId);
  const pickedRow = pickedAt >= 0 ? rows[pickedAt] : null;

  // D18: the Foreign Key target list is the schema cache's table list for this database.
  const database = draft?.path.database ?? (target.kind === "alter" ? target.path.database : target.scope.database);
  const schemas = lang.schemas;
  const subscribe = useCallback((l: () => void) => schemas.subscribe(l), [schemas]);
  const schemaState = useSyncExternalStore(subscribe, () => schemas.state(connection.id, database));
  useEffect(() => {
    if (tab === "foreignKeys" && !readOnly) void schemas.ensure(connection.id, database);
  }, [schemas, tab, readOnly, connection.id, database]);
  const tables = schemaState === null ? null : schemas.tables(connection.id, database);

  function focusGrid() {
    tableRef.current?.focus();
  }

  function pick(t: RowTab, id: string | null) {
    setPicked((p) => ({ ...p, [t]: id }));
  }

  function switchTab(t: InnerTab) {
    if (t === tab) return;
    keepEditor();
    setTab(t);
  }

  function add() {
    if (!canEdit || !draft || locked()) return;
    const dr = keepEditor() ?? draftRef.current ?? draft;
    if (tab === "indexes") {
      const next = addIndex(dr);
      change(next);
      pick("indexes", next.indexes[next.indexes.length - 1].id);
      return;
    }
    if (tab === "foreignKeys") {
      const next = addForeignKey(dr);
      change(next);
      pick("foreignKeys", next.foreignKeys[next.foreignKeys.length - 1].id);
      return;
    }
    const next = addColumn(dr);
    change(next);
    setSelected({ id: next.columns[next.columns.length - 1].id, cell: "name" });
  }

  /** Removes the picked index or key; the row after it (or before, at the end) is picked next. */
  function removeRow(t: RowTab) {
    const id = picked[t];
    const dr = keepEditor() ?? draftRef.current;
    if (!canEdit || !dr || !id || locked()) return;
    const list: { id: string }[] = t === "indexes" ? dr.indexes : dr.foreignKeys;
    const at = list.findIndex((r) => r.id === id);
    const next = t === "indexes" ? removeIndex(dr, id) : removeForeignKey(dr, id);
    if (next === dr) return;
    change(next);
    const left: { id: string }[] = t === "indexes" ? next.indexes : next.foreignKeys;
    pick(t, left[Math.min(at, left.length - 1)]?.id ?? null);
  }

  function remove() {
    if (rowTab) return removeRow(rowTab);
    if (!canEdit || !draftRef.current || !selected || locked()) return;
    const dr = keepEditor() ?? draftRef.current!;
    const at = dr.columns.findIndex((c) => c.id === selected.id);
    const c = dr.columns[at];
    if (!c) return;
    // Delete on a struck-through row brings it back.
    if (dr.removed.includes(c.id)) {
      change(restoreColumn(dr, c.id));
      return;
    }
    const next = removeColumn(dr, c.id);
    change(next);
    if (c.origin === null) {
      const near = next.columns[Math.min(at, next.columns.length - 1)];
      setSelected(near ? { id: near.id, cell: selected.cell } : null);
    }
  }

  function move(by: -1 | 1) {
    const dr = draftRef.current;
    if (!canMove || !dr || !selected || locked()) return;
    keepEditor();
    change(moveColumn(draftRef.current ?? dr, selected.id, by));
  }

  function open(at: CellAt, typed?: string) {
    const dr = draftRef.current;
    const c = dr?.columns.find((x) => x.id === at.id);
    if (!dr || !c || !TEXT_CELLS.includes(at.cell) || !cellEditable(dr, c, at.cell, locked())) return;
    const field = CELL_FIELD[at.cell]!;
    const initial = typed ?? ((c[field] as string | null) ?? "");
    editValue.current = initial;
    setSelected(at);
    setEditing({ ...at, initial });
  }

  function toggle(at: CellAt) {
    const dr = draftRef.current;
    const c = dr?.columns.find((x) => x.id === at.id);
    if (!dr || !c || !cellEditable(dr, c, at.cell, locked())) return;
    setSelected(at);
    if (at.cell === "key") change(togglePrimary(dr, at.id, dialect));
    else if (at.cell === "nullable") change(editColumn(dr, at.id, { nullable: !c.nullable }));
    else if (at.cell === "increment") change(editColumn(dr, at.id, { increment: !c.increment }));
  }

  function step(rows: number, cols: number) {
    if (!selected) {
      if (columns[0]) setSelected({ id: columns[0].id, cell: cells[0] });
      return;
    }
    const r = Math.max(0, Math.min(columns.length - 1, rowAt + rows));
    const c = Math.max(0, Math.min(cells.length - 1, cells.indexOf(selected.cell) + cols));
    if (columns[r]) setSelected({ id: columns[r].id, cell: cells[c] });
  }

  /** Opens the Name editor of an index or key; `typed` starts it with that text instead. */
  function openName(t: RowTab, id: string, typed?: string) {
    const dr = draftRef.current;
    if (!dr) return;
    const name =
      t === "indexes"
        ? dr.indexes.find((i) => i.id === id && indexNameEditable(i, locked()))?.name
        : dr.foreignKeys.find((k) => k.id === id && foreignKeyNameEditable(k, locked()))?.name;
    if (name === undefined) return;
    const initial = typed ?? name;
    editValue.current = initial;
    pick(t, id);
    setEditing({ row: t, id, initial });
  }

  function commit(value: string, move: "down" | "right" | "none", blurred?: boolean) {
    const at = editingRef.current;
    keepEditor(value);
    if (isRowEdit(at)) {
      if (!blurred) focusGrid();
      return;
    }
    if (at && move === "down") step(1, 0);
    else if (at && move === "right") step(0, 1);
    if (!blurred) focusGrid();
  }

  // D27: Ctrl+S works anywhere in the designer, so the window's Save skips it; it also works while a cell is being
  // edited (Apply keeps the open edit first, as the grid's Save does). Ctrl+N is the window's New Connection everywhere.
  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === "s") {
      e.preventDefault();
      void apply();
    }
  }

  // The cell keys belong to the grid alone, as in the data grid, so the toolbar and tabs keep theirs.
  function onGridKey(e: KeyboardEvent<HTMLElement>) {
    if (editingRef.current) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Delete" && selected) {
      e.preventDefault();
      remove();
    } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      move(e.key === "ArrowUp" ? -1 : 1);
    } else if (!e.altKey && !mod && e.key.startsWith("Arrow")) {
      e.preventDefault();
      if (e.key === "ArrowUp") step(-1, 0);
      else if (e.key === "ArrowDown") step(1, 0);
      else if (e.key === "ArrowLeft") step(0, -1);
      else step(0, 1);
    } else if ((e.key === "Enter" || e.key === "F2") && selected) {
      e.preventDefault();
      if (TEXT_CELLS.includes(selected.cell)) open(selected);
      else toggle(selected);
    } else if (e.key === " " && selected && !TEXT_CELLS.includes(selected.cell)) {
      e.preventDefault();
      toggle(selected);
    } else if (e.key.length === 1 && !mod && !e.altKey && selected && TEXT_CELLS.includes(selected.cell)) {
      // Typing on a text cell starts editing it with that character, as in the data grid (item 47): the
      // editor opens empty and takes focus inside this key press, so the browser types the character itself.
      flushSync(() => open(selected, ""));
      if (!editingRef.current) e.preventDefault();
    }
  }

  // The Indexes and Foreign keys grids: arrows pick a row, Enter or F2 renames it, typing starts
  // a new name, Delete removes it. Keys from a control inside a row (a column picker, a Select)
  // stay with that control.
  function onRowKey(e: KeyboardEvent<HTMLElement>) {
    if (editingRef.current || !rowTab || e.target !== e.currentTarget) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Delete" && pickedRow) {
      e.preventDefault();
      remove();
    } else if (!mod && !e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const to = pickedAt < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, pickedAt + (e.key === "ArrowUp" ? -1 : 1)));
      if (rows[to]) pick(rowTab, rows[to].id);
    } else if ((e.key === "Enter" || e.key === "F2") && pickedRow) {
      e.preventDefault();
      openName(rowTab, pickedRow.id);
    } else if (e.key.length === 1 && e.key !== " " && !mod && !e.altKey && pickedRow) {
      // Item 47: the browser types the opening key into the new name's editor.
      flushSync(() => openName(rowTab, pickedRow.id, ""));
      if (!editingRef.current) e.preventDefault();
    }
  }

  const rowEdit = isRowEdit(editing) ? editing : null;
  const rowGrid = {
    readOnly: readOnly || busy,
    onInput: (v: string) => (editValue.current = v),
    onCommit: commit,
    onCancel: () => {
      setEditing(null);
      focusGrid();
    },
    onSave: (v: string) => {
      keepEditor(v);
      void apply();
    },
  };

  const counts: Record<InnerTab, number> = {
    columns: shownColumns,
    indexes: draft?.indexes.length ?? 0,
    foreignKeys: draft?.foreignKeys.length ?? 0,
  };
  const tabNames: Record<InnerTab, string> = { columns: "Columns", indexes: "Indexes", foreignKeys: "Foreign keys" };
  const note = design ? unsupportedNote(design.unsupported) : null;
  const moveTip = (label: string, keys: string) => (pgAlter ? PG_MOVE : `${label} (${keys})`);
  const selectedRemoved = !!(selected && draft?.removed.includes(selected.id));

  const problem = draft && (dirty || target.kind === "create") ? problemOf(draft) : null;
  const request = !readOnly && draft && dirty && !problem ? requestFor(draft) : null;
  const copyOnly = !!(request && plan?.plan.mode.kind === "copyOnly");
  const canApply = !readOnly && load.s === "ready" && dirty && !problem && !copyOnly;
  const reason = readOnly ? null : (problem ?? (copyOnly ? COPY_ONLY : null));
  const wash = connection.production ? " prod-wash" : "";

  /** The full-width Add row under each grid (frame Designer, `.addrow`): the toolbar's Add, where the list ends. */
  const addRow = canEdit ? (
    <button type="button" className="design-addrow" aria-label={`${ADD_LABEL[tab]} at the end`} onClick={add}>
      <span className="design-addrow-plus" aria-hidden="true">
        <Icon name="plus" size={14} />
      </span>
      {ADD_LABEL[tab]}
    </button>
  ) : null;

  return (
    <section
      className={["design-view", connection.production && "prod-wash"].filter(Boolean).join(" ")}
      aria-label={`Design of ${target.kind === "alter" ? target.path.name : "a new table"}`}
      onKeyDown={onKeyDown}
    >
      <DesignBar
        connection={connection}
        path={target.kind === "alter" ? target.path : null}
        changes={readOnly ? 0 : changes}
        busy={busy}
        error={applyError?.text ?? null}
        production={connection.production}
        readOnly={readOnly}
        canApply={canApply}
        reason={applyError ? null : reason}
        onDiscard={() => void discard()}
        onApply={() => void apply()}
        onDrop={onDrop && target.kind === "alter" ? () => onDrop(target.path) : undefined}
        name={target.kind === "create" ? { value: draft?.path.name ?? "", onChange: rename, disabled: busy } : undefined}
        onReload={applyError?.reload ? () => !busyRef.current && (dirty ? setAskReload(true) : reload()) : undefined}
        asking={!!confirm}
      />
      {readOnly && (
        <p className="design-readonly">
          {connection.name} is Read-only. You can look at this design but not change it.
        </p>
      )}
      <div className="design-toolbar" role="toolbar" aria-label="Designer">
        <div role="tablist" aria-label="Design" className="design-tablist">
          {(Object.keys(tabNames) as InnerTab[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? "design-tab design-tab-on" : "design-tab"}
              onClick={() => switchTab(t)}
            >
              {/* Item 6: the count is its own item after a gap, so it never runs into the name ("Columns 5"). */}
              <span className="design-tab-name">{tabNames[t]}</span> <span className="design-tab-count">{counts[t]}</span>
            </button>
          ))}
        </div>
        <span className="editor-header-divider" aria-hidden="true" />
        {/* R20 / D27: these keys are the designer's own, so the hints stay literal. */}
        <button
          type="button"
          className="button button-small button-quiet"
          title={ADD_LABEL[tab]}
          disabled={!canEdit}
          onClick={add}
        >
          <Icon name="plus" size={14} />
          {ADD_LABEL[tab]}
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={REMOVE_LABEL[tab]}
          title={`${REMOVE_LABEL[tab]} (Delete)`}
          disabled={!canEdit || (rowTab ? !pickedRow || !!pickedRow.primary : rowAt < 0 || selectedRemoved)}
          onClick={remove}
        >
          <Icon name="minus" size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Move up"
          title={moveTip("Move up", "Alt+Up")}
          disabled={!canMove || rowAt === 0}
          onClick={() => move(-1)}
        >
          <Icon name="arrowUp" size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Move down"
          title={moveTip("Move down", "Alt+Down")}
          disabled={!canMove || rowAt === columns.length - 1}
          onClick={() => move(1)}
        >
          <Icon name="arrowDown" size={14} />
        </button>
      </div>

      {load.s === "loading" && <p className="state-panel muted">Loading the design...</p>}
      {load.s === "failed" && (
        <div className="state-panel" role="alert">
          <p>{load.message}</p>
          <button type="button" className="button button-small" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}
      {load.s === "ready" && draft && (
        <div className="design-body" role="tabpanel" aria-label={tabNames[tab]}>
          {tab === "columns" && (
            <div className="grid-scroll design-scroll" ref={tableRef} tabIndex={0} onKeyDown={onGridKey}>
              <ColumnsTab
                draft={draft}
                dialect={dialect}
                readOnly={readOnly || busy}
                selected={selected}
                editing={isRowEdit(editing) ? null : editing}
                onSelect={(at) => {
                  const was = editingRef.current;
                  if (was && (isRowEdit(was) || was.id !== at.id || was.cell !== at.cell)) keepEditor();
                  setSelected(at);
                }}
                onOpen={open}
                onToggle={toggle}
                onCommit={commit}
                onCancel={() => {
                  setEditing(null);
                  focusGrid();
                }}
                onInput={(v) => (editValue.current = v)}
                onSave={(v) => {
                  keepEditor(v);
                  void apply();
                }}
              />
              {addRow}
            </div>
          )}
          {rowTab && (
            <div className="grid-scroll design-scroll" ref={tableRef} tabIndex={0} onKeyDown={onRowKey}>
              {rowTab === "indexes" ? (
                <IndexesTab
                  {...rowGrid}
                  draft={draft}
                  selected={picked.indexes}
                  editing={rowEdit?.row === "indexes" ? rowEdit : null}
                  onSelect={(id) => {
                    if (rowEdit && rowEdit.id !== id) keepEditor();
                    pick("indexes", id);
                  }}
                  onOpen={(id) => openName("indexes", id)}
                  onChange={(id, patch) => {
                    const dr = draftRef.current;
                    if (dr && !locked()) change(editIndex(dr, id, patch));
                  }}
                />
              ) : (
                <ForeignKeysTab
                  {...rowGrid}
                  draft={draft}
                  tables={tables}
                  selected={picked.foreignKeys}
                  editing={rowEdit?.row === "foreignKeys" ? rowEdit : null}
                  onSelect={(id) => {
                    if (rowEdit && rowEdit.id !== id) keepEditor();
                    pick("foreignKeys", id);
                  }}
                  onOpen={(id) => openName("foreignKeys", id)}
                  onChange={(id, patch) => {
                    const dr = draftRef.current;
                    if (dr && !locked()) change(editForeignKey(dr, id, patch));
                  }}
                />
              )}
              {addRow}
            </div>
          )}
          {rowTab === "foreignKeys" && schemaState === "failed" && !readOnly && (
            <p className="design-note" role="alert">
              The table list did not load. Open this tab once more to retry.
            </p>
          )}
          {droppedIndexNotes(draft).map((text) => (
            <p key={text} className="design-note">
              {text}
            </p>
          ))}
          {note && <p className="design-note">{note}</p>}
        </div>
      )}

      {readOnly ? (
        <section className={`design-island design-ddl${wash}`} aria-label="DDL">
          <div className="design-island-head">
            <Icon name="fileCode" size={14} className="muted" />
            <span className="design-island-title">DDL</span>
            <span className="design-island-sub">What this table looks like in {DIALECT_LABEL[dialect]}</span>
          </div>
          <div className="design-island-body">
            {ddl && "error" in ddl && (
              <p className="error-text" role="alert">
                {ddl.error}
              </p>
            )}
            {ddl && "sql" in ddl && <SqlBlock sql={ddl.sql} dialect={dialect} className="design-sql" ariaLabel="Table DDL" />}
          </div>
        </section>
      ) : (
        <DesignPreview
          connectionId={connection.id}
          dialect={dialect}
          request={request}
          fresh={fresh}
          onPlan={(p) => {
            shownRef.current = p ? p.plan.statements : null;
            setPlan(p);
          }}
          production={connection.production}
          idle={dirty ? "" : "Change the design to see the SQL Apply runs."}
        />
      )}

      {confirm && (
        <ConfirmRun
          verb="Apply"
          verdict={confirm.verdict}
          warnings={confirm.warnings}
          dialect={dialect}
          group={group}
          onRun={() => void confirmApply()}
          onCancel={cancelApply}
        />
      )}

      {askReload && (
        <Dialog title={`Reload ${tableName}?`} size="confirm" onClose={() => setAskReload(false)}>
          <div className="dialog-body dialog-body-stack">
            <span>
              Reloading drops your {plural(changes, "change", "changes")} to the design and loads {tableName} as it is on the
              server now.
            </span>
          </div>
          <footer className="dialog-footer">
            <span className="spacer" />
            <button type="button" className="button" onClick={() => setAskReload(false)}>
              Cancel
            </button>
            {/* Ctrl+S from this ask can start an Apply: Reload then waits, so the draft is never replaced mid-Apply. */}
            <button type="button" className="button button-primary" disabled={busy} onClick={() => !busyRef.current && reload()}>
              Reload
            </button>
          </footer>
        </Dialog>
      )}

      {statusSlot &&
        draft &&
        createPortal(
          <div className="query-status">
            <span>
              {plural(shownColumns, "column", "columns")}
              {dirty && !readOnly ? `, ${plural(changes, "change", "changes")}` : ""}
            </span>
          </div>,
          statusSlot,
        )}
    </section>
  );
}
