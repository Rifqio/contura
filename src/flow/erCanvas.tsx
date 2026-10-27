// ER build A (erd-ux-research 5.1 to 5.3, board ER interactions): the ER canvas edits its tables in place. The
// pointer target is the intent: double-click the header renames the table, a column's name or type edits it,
// empty card space adds a column there; the hover "+ column" row adds at the end; the key gutter and K and N
// set the key and not null. Each commit is one worker edit, so one text change and one undo step. The rules
// for where Enter, Tab, Shift+Tab, Escape and a click away go are here; the field is the shared InlineEdit.
//
// B3 (decisions 5 and 6): one store per tab holds the open edit, the selected column and the aim, and each card reads
// only its own table's slice through `useErCard`, so a field opening or closing draws one card again and a card at
// rest holds nothing. Static frames' cards share the live frame's table names, so every reader gates on its node.
import { useNodeId } from "@xyflow/react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CommitHow } from "./interactions/InlineEdit";
import { isStaticId } from "./board/staticIds";
import { EDIT_MESSAGES } from "./editWords";
import { erRefusal, isErTable } from "./erRelate";
import type { RunResult } from "./useFlowDoc";
import { ER_NOTES, type FlowEditOp } from "../lang/flow/edits";
import { COLUMN_FLAGS, type ColumnFlag, columnLine, type FlowDoc, type FlowNode, isColumnName, splitRow } from "../lang/flow/model";
import { parseFlow } from "../lang/flow/parse";
import type { FlowRequestOp } from "../lang/flow/service";

export type ErField = "name" | "type";

/** What is open for editing on the ER canvas: a table's name, a column's field, or a new column row. */
export type ErEdit =
  // `typed`: what a refused field held, so it opens again with it wherever it is drawn again (Task 3's rule).
  | { kind: "table"; table: string; error?: string; tries?: number; typed?: string }
  | { kind: "col"; table: string; index: number; field: ErField; error?: string; tries?: number; column?: string; typed?: string }
  | { kind: "draft"; table: string; at: number; field: ErField; name: string; type: string; error?: string; tries?: number };

/** A table's column by its row; `index` -1 is the table's header (an aim on the whole table). */
export type ErColumn = { table: string; index: number };

/** What one card reads: its open edit, its selected column's row and its aimed row (-1 the header), each null when none. */
export interface ErCardView {
  edit: ErEdit | null;
  selected: number | null;
  aim: number | null;
}

type ErState = { edit: ErEdit | null; selected: ErColumn | null; aim: ErColumn | null };

export interface ErStore {
  get(): ErState;
  set(patch: Partial<ErState>): void;
  /** Called when `table`'s slice changes, and only then. */
  subscribe(table: string, fn: () => void): () => void;
  /** `table`'s slice: the same object while it is unchanged, null when nothing is on that table. */
  view(table: string): ErCardView | null;
  /** Called when the open edit changes, whatever the table: the tab's one listener, so a draft row grows its card. */
  watchEdit(fn: () => void): () => void;
  /** For tests (R27): the slices held, and the listeners subscribed. */
  size(): number;
  listeners(): number;
}

const sameColumn = (a: ErColumn | null, b: ErColumn | null) => a === b || (!!a && !!b && a.table === b.table && a.index === b.index);

export function createErStore(): ErStore {
  let cur: ErState = { edit: null, selected: null, aim: null };
  /** Only the tables something is on: three at most, whatever the board holds. */
  const views = new Map<string, ErCardView>();
  const subs = new Map<string, Set<() => void>>();
  const edits = new Set<() => void>();
  const build = (table: string) => {
    const edit = cur.edit?.table === table ? cur.edit : null;
    const selected = cur.selected?.table === table ? cur.selected.index : null;
    const aim = cur.aim?.table === table ? cur.aim.index : null;
    if (!edit && selected === null && aim === null) views.delete(table);
    else views.set(table, { edit, selected, aim });
  };
  return {
    get: () => cur,
    set(patch) {
      const next: ErState = { ...cur };
      const touched = new Set<string>();
      if ("edit" in patch && (patch.edit ?? null) !== cur.edit) {
        next.edit = patch.edit ?? null;
        if (cur.edit) touched.add(cur.edit.table);
        if (next.edit) touched.add(next.edit.table);
      }
      for (const k of ["selected", "aim"] as const) {
        if (!(k in patch) || sameColumn(patch[k] ?? null, cur[k])) continue;
        next[k] = patch[k] ?? null;
        if (cur[k]) touched.add(cur[k]!.table);
        if (next[k]) touched.add(next[k]!.table);
      }
      if (!touched.size) return;
      const prev = cur;
      cur = next;
      for (const t of touched) build(t);
      for (const t of touched) for (const fn of subs.get(t) ?? []) fn();
      if (next.edit !== prev.edit) for (const fn of [...edits]) fn();
    },
    watchEdit(fn) {
      edits.add(fn);
      return () => void edits.delete(fn);
    },
    subscribe(table, fn) {
      let set = subs.get(table);
      if (!set) subs.set(table, (set = new Set()));
      set.add(fn);
      return () => {
        const s = subs.get(table);
        if (!s) return;
        s.delete(fn);
        if (!s.size) subs.delete(table);
      };
    },
    view: (table) => views.get(table) ?? null,
    size: () => views.size,
    listeners: () => {
      let n = 0;
      for (const s of subs.values()) n += s.size;
      return n;
    },
  };
}

/** What the table cards read and call. Absent (null) the cards only draw, as in a preview. */
export interface ErCanvasApi {
  readOnly: boolean;
  editTable(table: string): void;
  editColumn(table: string, index: number, field: ErField): void;
  /** Opens a new column row before `at` (at the end when absent). */
  addColumn(table: string, at?: number): void;
  /** ER build C: the first column row of a table just added, before its parse is in (Enter after a new table's name). */
  firstColumn(table: string): void;
  selectColumn(table: string, index: number): void;
  /**
   * A press on the header or the empty body: a selected column lets go (M2). The table is picked only by a plain
   * press on a table not already selected, so a multi-selection stays for a group drag and Ctrl or Shift+click
   * toggles through the canvas (N1, draw.io and Figma).
   */
  pickTable(table: string, modified?: boolean): void;
  /** Why this table's columns cannot be edited on the card, or null: an old-form frame (decision 3). */
  blocked(table: string): string | null;
  /** A right-click on a column: its table's menu acts on it. */
  pointColumn(table: string, index: number): void;
  toggleFlag(table: string, index: number, flag: ColumnFlag): void;
  /** Ctrl+Enter or the column menu's Duplicate: a copy below it, selected (draw.io). */
  duplicateColumn(table: string, index: number): void;
  /** Delete on a column or its menu's Delete column. */
  deleteColumn(table: string, index: number): void;
  commit(edit: ErEdit, value: string, how: CommitHow): void;
  cancel(edit: ErEdit): void;
}

/** The live frame's card editing; `types` is the id of its tab's list of types for the type field. */
export const ErCanvasContext = createContext<{ api: ErCanvasApi; store: ErStore; types?: string } | null>(null);

/** False on a static frame's card (decision 5): it reads and subscribes to nothing of the live frame's ER state. */
export function useErLive(): boolean {
  return !isStaticId(useNodeId() ?? "");
}

/** `table`'s slice of the ER state; the card draws again only when it changes. Null, with no subscription, when not live. */
export function useErCard(table: string): ErCardView | null {
  const ctx = useContext(ErCanvasContext);
  const live = useErLive();
  const store = live ? (ctx?.store ?? null) : null;
  const subscribe = useCallback((fn: () => void) => (store ? store.subscribe(table, fn) : () => {}), [store, table]);
  const get = useCallback(() => (store ? store.view(table) : null), [store, table]);
  return useSyncExternalStore(subscribe, get);
}

/** The types offered while a type is typed: the board's list, then the ones the diagram already uses. */
export const ER_TYPES = ["int", "bigint", "text", "varchar(255)", "numeric(12,2)", "boolean", "date", "timestamptz", "uuid", "jsonb"];

/** `ER_TYPES`, then every other type the tables of `nodes` use, in the order met: read once per parse of the live frame. */
export function erTypesOf(nodes: readonly FlowNode[]): string[] {
  const out = new Set(ER_TYPES);
  for (const n of nodes)
    for (const r of n.rows ?? []) {
      const type = splitRow(r).type;
      if (type) out.add(type);
    }
  return [...out];
}

/** The one `splitRow` lives in model.ts beside `columnLine`; the card code reads it from here too. */
export { splitRow };

export const ER_MESSAGES = {
  tableNeedsName: "A table needs a name.",
  columnNeedsName: "A column needs a name.",
  /** A table header only: the card takes letters, digits and _ (A's text allows dots, the card does not). */
  plainName: "Use letters, digits and _ only.",
  nameFirst: "Name the column first: Shift+Tab goes back.",
  tableTaken: (name: string) => `${name} is already a table in this diagram.`,
  pkNotNull: "A primary key is never null.",
  /** A gesture that adds something (a double-click on the canvas) keeps nothing while the Assistant works (fix round 4, N5). */
  lockedAdd: "Not changed: the Assistant is editing this diagram. Your edit can wait until it finishes.",
  tableGone: (table: string) => `${table} is no longer in the text.`,
  columnGone: (table: string) => `This column of ${table} is no longer in the text.`,
  /** ER build C: a deleted column takes the relationships that use it along. */
  deletedWith: (table: string, column: string, n: number) => `Deleted ${table}.${column} and its line${n === 1 ? "" : "s"}. Ctrl+Z brings them back.`,
};

/** How many relationships use `table.column` (ER build C). */
export function relationshipsOf(doc: FlowDoc | null, table: string, column: string): number {
  let n = 0;
  for (const l of doc?.links ?? []) if ((l.from === table && l.fromColumn === column) || (l.to === table && l.toColumn === column)) n++;
  return n;
}

/** A column read off pasted text: its name as written, its type unquoted, its flags. */
export type PastedColumn = { name: string; type: string; flags: ColumnFlag[] };

/**
 * The column pasted text is, by decision 11's two inputs only, or null: (a) the line Ctrl+C or Ctrl+X put on the
 * clipboard (`copied`, `lastClip.column`), read back as a block line; (b) the old `table.column type [flags]` line, where
 * `table` is a table of `doc`. Text that only has a dot (example.com), or a word, is not a column (N1).
 */
export function columnPasteLine(text: string, doc: FlowDoc | null, copied: string | null): PastedColumn | null {
  const line = text.trim();
  if (!line) return null;
  if (copied !== null && line === copied.trim()) {
    if (line.includes("\n")) return null;
    const p = parseFlow(`diagram er "t"\nt {\n  ${line}\n}\n`);
    const t = p.doc?.nodes[0];
    if (p.problems.length > 0 || !t || t.rows?.length !== 1) return null;
    const { name, type } = splitRow(t.rows[0]);
    return { name, type, flags: [...(t.rowFlags?.[0] ?? [])] };
  }
  // The old line (5478210^ pasteColumn's regex).
  const m = /^([^\s.][^.\n]*)\.([A-Za-z_][A-Za-z0-9_]*)(?:[ \t]+([^[\n]*?))?[ \t]*(?:\[([^\]\n]*)\])?[ \t]*$/.exec(line);
  if (!m || !doc?.nodes.some((n) => n.name === m[1] && isErTable(n))) return null;
  const flags = (m[4] ?? "")
    .split(",")
    .map((f) => f.trim().toLowerCase().split(/\s+/).join(" "))
    .filter((f): f is ColumnFlag => (COLUMN_FLAGS as readonly string[]).includes(f));
  // A spaced type written quoted (`"timestamp with time zone"`) is read unquoted, as the copied line's is.
  const type = (m[3] ?? "").trim().replace(/^"(.*)"$/, "$1");
  return { name: m[2], type, flags };
}

/**
 * Pasted text on `table` as one `addColumn` before row `at` (decision 11), named `name_copy`, `name_copy2` when its
 * name is taken (case-blind, as Ctrl+Enter); null when the text is not a column by `columnPasteLine`. An op for `run`:
 * it never edits the view.
 */
export function planColumnPaste(text: string, doc: FlowDoc, table: FlowNode, at: number, copied: string | null): FlowEditOp | null {
  const c = columnPasteLine(text, doc, copied);
  if (!c) return null;
  const names = (table.rows ?? []).map((r) => splitRow(r).name);
  const lower = new Set(names.map((n) => n.toLowerCase()));
  let name = c.name;
  if (lower.has(name.toLowerCase())) {
    name = `${c.name}_copy`;
    for (let n = 2; lower.has(name.toLowerCase()); n++) name = `${c.name}_copy${n}`;
  }
  return { op: "addColumn", table: table.name, at, before: names[at] ?? null, name, type: c.type, flags: c.flags };
}

interface Options {
  /** The doc the canvas edits: the current parse's, else the drawing. */
  doc(): FlowDoc | null;
  /** The worker's op (decision 2): `onRefused` hears the refusal's note, `frame` the frame the gesture started on. */
  run(op: FlowRequestOp, opts: { onRefused(note: string): void; frame: number }): Promise<RunResult | null>;
  /** The live frame's identity now (`doc.frameIdNow`), taken when a write starts. */
  frame(): number;
  /** Every write's promise (`trackCommit`), so a frame switch waits for it (R4). */
  track(p: Promise<unknown>): void;
  /** True for a frame still in the old ER form: every card edit says `ER_NOTES.oldForm` and writes nothing. */
  oldForm(): boolean;
  /** True while the assistant holds the text. */
  locked(): boolean;
  /** True while the text has an error and the canvas shows the last drawing that worked: its rows may not be the text's. */
  stale(): boolean;
  readOnly: boolean;
  /** A table was renamed: keep its place and select it under the new name. */
  onRenamed(old: string, next: string): void;
  /** A column was picked: its table becomes the selection. */
  onPick(table: string): void;
  /** The canvas's selected nodes now. */
  selection(): readonly string[];
  /** Why an edit was not kept, in the strip; null clears it. */
  /** `written`: the notice is about an edit just written, so an undo of it takes the notice too (fix round 4, N2). */
  notice(text: string | null, written?: boolean): void;
  /** Focus back on the canvas after a key leaves a field, so F2, K, N, Delete and Ctrl+Z work at once (I4). */
  refocus(): void;
  /** Ctrl+C or Ctrl+X on a column: its .flow line goes on the clipboard (diag-shell fix round 1, I4). */
  copy?(text: string): void;
  /**
   * A press on a column (index) or on a table's header or body (null) while a pick is on: true when the pick took
   * it, so it selects nothing (fix round 2, I1).
   */
  intercept?(table: string, index: number | null): boolean;
}

/** What a write came back with: whether it was kept, the refusal's note, and whether the frame changed meanwhile. */
type Written = { ok: boolean; note: string | null; moved: boolean };

export function useErCanvas(o: Options) {
  const [store] = useState(createErStore);
  /** The column a right-click landed on, for the menu that opens next. */
  const menuColumn = useRef<ErColumn | null>(null);
  /** The edit whose commit is being written: its field's later blur is not a second commit. */
  const busy = useRef<ErEdit | null>(null);
  const opts = useRef(o);
  opts.current = o;

  const setEdit = useCallback((e: ErEdit | null) => store.set({ edit: e }), [store]);
  const setSelected = useCallback((c: ErColumn | null) => store.set({ selected: c }), [store]);

  const table = (name: string): FlowNode | undefined => opts.current.doc()?.nodes.find((n) => n.name === name && isErTable(n));
  const columns = (t: FlowNode) => (t.rows ?? []).map(splitRow);

  /**
   * True when no card edit may be written now (`erRefusal`'s chain: the lock, an old-form frame, a text with an error),
   * with the reason in the strip; the lock's is not, as the card under it takes no gesture (decision 3, I5).
   */
  const refused = useCallback(() => {
    const r = erRefusal(opts.current);
    if (r && r.why !== "locked") opts.current.notice(r.note);
    return r !== null;
  }, []);

  const open = useCallback(
    (e: ErEdit) => {
      if (refused()) return false;
      opts.current.notice(null);
      setEdit(e);
      return true;
    },
    [setEdit, refused],
  );

  /** One worker op in the frame it started in, tracked across a switch (R4); a refusal's note goes to the strip. */
  const send = useCallback((op: FlowRequestOp, then?: (r: RunResult) => void): Promise<void> => {
    const frame = opts.current.frame();
    let note: string | null = null;
    const p = opts.current.run(op, { onRefused: (n) => (note = n), frame });
    opts.current.track(p);
    return p.then((r) => {
      if (opts.current.frame() !== frame) return;
      if (r) then?.(r);
      else opts.current.notice(note ?? EDIT_MESSAGES.changed);
    });
  }, []);
  /** A flag write on its way: a second press (a double press, a key the repeat check misses) writes nothing. */
  const flagging = useRef(false);

  const api = useMemo(() => {
    const editNow = () => store.get().edit;
    /** Closed by a key (or Escape): focus goes back to the canvas; a click away leaves it where the click put it. */
    const done = (how: CommitHow | "cancel") => {
      setEdit(null);
      if (how !== "blur") opts.current.refocus();
    };
    /** Refused: the field stays open with the reason, however it was left; only Escape discards (I1). */
    const refuse = (e: ErEdit, error: string, next?: Partial<ErEdit>) => {
      setEdit({ ...e, ...next, error, tries: (e.tries ?? 0) + 1 } as ErEdit);
    };
    /** A field's write: the worker's note, else "changed", stays in the field when refused (decision 2). */
    const write = async (e: ErEdit, op: FlowRequestOp): Promise<Written> => {
      busy.current = e;
      const frame = opts.current.frame();
      let note: string | null = null;
      const p = opts.current.run(op, { onRefused: (n) => (note = n), frame });
      opts.current.track(p);
      try {
        const r = await p;
        return { ok: !!r, note, moved: opts.current.frame() !== frame };
      } finally {
        if (busy.current === e) busy.current = null;
      }
    };
    const why = (w: Written) => w.note ?? EDIT_MESSAGES.changed;

    const commitTable = async (e: Extract<ErEdit, { kind: "table" }>, v: string, how: CommitHow) => {
      // Its own name kept is no rename, whatever the field would say of it as typed (final review Minor 6).
      if (v === e.table) return done(how);
      const other = opts.current.doc()?.nodes.find((n) => n.name !== e.table && n.name.toLowerCase() === v.toLowerCase());
      const bad = !v
        ? ER_MESSAGES.tableNeedsName
        : !isColumnName(v)
          ? ER_MESSAGES.plainName
          : other
            ? other.name === v
              ? ER_MESSAGES.tableTaken(v)
              : ER_NOTES.caseTaken(other.name)
            : "";
      if (bad) return refuse(e, bad, { typed: v });
      const w = await write(e, { op: "renameNode", old: e.table, next: v });
      // Another frame was selected meanwhile: its reset already closed the field, and this frame keeps nothing.
      if (w.moved) return;
      if (!w.ok) return refuse(e, why(w), { typed: v });
      opts.current.onRenamed(e.table, v);
      if (editNow() === e) done(how);
    };

    const commitColumn = async (e: Extract<ErEdit, { kind: "col" }>, t: FlowNode, v: string, how: CommitHow) => {
      const cols = columns(t);
      const cur = cols[e.index];
      // Gone from the text meanwhile (an edit in the text, the Assistant): the field keeps what was typed.
      if (!cur || (e.column !== undefined && cur.name !== e.column)) return refuse(e, ER_MESSAGES.columnGone(t.name), { typed: v });
      const last = e.index === cols.length - 1;
      if (e.field === "name") {
        const taken = cols.some((c, i) => i !== e.index && c.name.toLowerCase() === v.toLowerCase());
        const bad = !v ? ER_MESSAGES.columnNeedsName : !isColumnName(v) ? ER_NOTES.columnName : taken ? ER_NOTES.columnTaken(t.name, v) : "";
        if (bad) return refuse(e, bad, { typed: v });
        if (v !== cur.name) {
          const w = await write(e, { op: "setColumn", table: e.table, index: e.index, column: cur.name, name: v });
          if (w.moved) return;
          if (!w.ok) return refuse(e, why(w), { typed: v });
        }
        if (editNow() !== e) return;
        if (how === "tab") return setEdit({ kind: "col", table: e.table, index: e.index, field: "type" });
        // Shift+Tab goes to the row above's type; on the first column it stays (M3).
        if (how === "shifttab") return setEdit({ kind: "col", table: e.table, index: Math.max(0, e.index - 1), field: e.index > 0 ? "type" : "name" });
        return done(how);
      }
      // Any one-line type: the worker quotes a spaced one and refuses what does not read back (decision 3).
      if (v !== cur.type) {
        const w = await write(e, { op: "setColumn", table: e.table, index: e.index, column: cur.name, type: v });
        if (w.moved) return;
        if (!w.ok) return refuse(e, why(w), { typed: v });
      }
      if (editNow() !== e) return;
      if (how === "tab") return setEdit(last ? draft(e.table, cols.length) : { kind: "col", table: e.table, index: e.index + 1, field: "name" });
      if (how === "shifttab") return setEdit({ kind: "col", table: e.table, index: e.index, field: "name" });
      // Enter on the last column's type keeps it and starts the next column (draw.io, Lucid).
      if (how === "enter" && last) return setEdit(draft(e.table, cols.length));
      done(how);
    };

    const commitDraft = async (e: Extract<ErEdit, { kind: "draft" }>, t: FlowNode, v: string, how: CommitHow) => {
      const name = e.field === "name" ? v : e.name;
      const type = e.field === "type" ? v : e.type;
      const above = (): ErEdit => (e.at > 0 ? { kind: "col", table: e.table, index: e.at - 1, field: "type" } : { ...e, name, type, error: undefined });
      if (!name) {
        if (e.field === "type" && type) return refuse(e, ER_MESSAGES.nameFirst, { type });
        // Shift+Tab from an empty new row goes to the row above's type (M3).
        if (how === "shifttab") return setEdit(above());
        return done(how);
      }
      if (!isColumnName(name)) return refuse(e, ER_NOTES.columnName, { field: "name", name, type });
      if (columns(t).some((c) => c.name.toLowerCase() === name.toLowerCase())) return refuse(e, ER_NOTES.columnTaken(t.name, name), { field: "name", name, type });
      if (e.field === "name" && how === "tab") return setEdit({ ...e, name, type, field: "type", error: undefined });
      if (e.field === "type" && how === "shifttab") return setEdit({ ...e, name, type, field: "name", error: undefined });
      const w = await write(e, { op: "addColumn", table: e.table, at: e.at, before: columns(t)[e.at]?.name ?? null, name, type });
      if (w.moved) return;
      if (!w.ok) return refuse(e, why(w), { name, type });
      if (editNow() !== e) return;
      setSelected({ table: e.table, index: e.at });
      // Enter keeps adding (spreadsheets, draw.io tables); a click away stops.
      if (how === "enter" || how === "tab") return setEdit(draft(e.table, e.at + 1));
      // Kept, then back to the row above (or the new column's own name on the first row).
      if (how === "shifttab") return setEdit(e.at > 0 ? above() : { kind: "col", table: e.table, index: 0, field: "name" });
      done(how);
    };

    /** The name of a table's column at `index` as the canvas drew it, or null. */
    const columnAt = (name: string, index: number): string | null => {
      const row = table(name)?.rows?.[index];
      return row === undefined ? null : splitRow(row).name;
    };
    const draft = (tableName: string, at: number): ErEdit => ({ kind: "draft", table: tableName, at, field: "name", name: "", type: "" });
    /** True when `v` leaves the field as it opened: the table's name, the column's value, an empty new row. */
    const untouched = (e: ErEdit, t: FlowNode | undefined, v: string): boolean => {
      if (e.kind === "table") return v === e.table;
      if (e.kind === "draft") return !(e.field === "name" ? v : e.name) && !(e.field === "type" ? v : e.type);
      const cur = t ? columns(t)[e.index] : undefined;
      return !!cur && (e.column === undefined || cur.name === e.column) && v === (e.field === "name" ? cur.name : cur.type);
    };

    const out: ErCanvasApi = {
      readOnly: false,
      // What is edited is selected too (board ER interactions), so its keys work once the field closes (I4).
      editTable: (name) => {
        if (!open({ kind: "table", table: name })) return;
        setSelected(null);
        opts.current.onPick(name);
      },
      editColumn: (name, index, field) => {
        const at = table(name)?.rows?.[index];
        if (!open({ kind: "col", table: name, index, field, ...(at !== undefined ? { column: splitRow(at).name } : {}) })) return;
        setSelected({ table: name, index });
        opts.current.onPick(name);
      },
      blocked: () => (opts.current.oldForm() ? ER_NOTES.oldForm : null),
      addColumn: (name, at) => {
        const t = table(name);
        if (t) open(draft(name, at ?? (t.rows ?? []).length));
      },
      firstColumn: (name) => {
        if (open(draft(name, 0))) setSelected(null);
      },
      pickTable: (name, modified) => {
        if (opts.current.intercept?.(name, null)) return;
        setSelected(null);
        if (!modified && !opts.current.selection().includes(name)) opts.current.onPick(name);
      },
      selectColumn: (name, index) => {
        if (opts.current.intercept?.(name, index)) return;
        setSelected({ table: name, index });
        opts.current.onPick(name);
      },
      pointColumn: (name, index) => {
        menuColumn.current = { table: name, index };
        setSelected({ table: name, index });
      },
      toggleFlag: (name, index, flag) => {
        if (flagging.current || refused()) return;
        const t = table(name);
        const flags = t?.rowFlags?.[index] ?? [];
        if (!t || index >= (t.rows ?? []).length) return;
        opts.current.notice(null);
        setSelected({ table: name, index });
        if (flag === "not null" && flags.includes("pk")) {
          opts.current.notice(ER_MESSAGES.pkNotNull);
          return;
        }
        flagging.current = true;
        void send({ op: "setColumnFlag", table: name, index, column: splitRow((t.rows ?? [])[index]).name, flag, on: !flags.includes(flag) }).finally(() => {
          flagging.current = false;
        });
      },
      duplicateColumn: (name, index) => {
        const column = columnAt(name, index);
        if (column === null || refused()) return;
        send({ op: "duplicateColumn", table: name, index, column }, () => setSelected({ table: name, index: index + 1 }));
      },
      deleteColumn: (name, index) => {
        const column = columnAt(name, index);
        if (column === null || refused()) return;
        const lines = relationshipsOf(opts.current.doc(), name, column);
        send({ op: "deleteColumn", table: name, index, column }, () => {
          setSelected(null);
          if (lines > 0) opts.current.notice(ER_MESSAGES.deletedWith(name, column, lines), true);
        });
      },
      commit: (e, v, how) => {
        if (editNow() !== e || busy.current === e) return;
        // Never dropped: under the Assistant's lock the field stays open with what was typed (I6).
        if (opts.current.locked()) return refuse(e, EDIT_MESSAGES.locked, e.kind === "draft" ? (e.field === "name" ? { name: v } : { type: v }) : { typed: v });
        const t = table(e.table);
        if (opts.current.stale()) {
          // Nothing typed is nothing to write: an untouched field closes, so a text that broke meanwhile holds no
          // field (and no frame switch) open (final review Minor 6).
          if (untouched(e, t, v)) return done(how);
          return setEdit({ ...e, ...(e.kind === "draft" ? (e.field === "name" ? { name: v } : { type: v }) : { typed: v }), error: EDIT_MESSAGES.stale } as ErEdit);
        }
        if (!t) return refuse(e, ER_MESSAGES.tableGone(e.table), e.kind === "draft" ? (e.field === "name" ? { name: v } : { type: v }) : { typed: v });
        // The whole commit is tracked, its refusal included, so a switch waiting for it sees the field refused (R4).
        opts.current.track(e.kind === "table" ? commitTable(e, v, how) : e.kind === "col" ? commitColumn(e, t, v, how) : commitDraft(e, t, v, how));
      },
      cancel: (e) => {
        if (editNow() === e) done("cancel");
      },
    };
    return out;
  }, [open, setEdit, setSelected, refused, send, store]);

  /** The selected column's keys (erd-ux-research 5.8); true when the key was taken. */
  const onKey = useCallback(
    (e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; repeat?: boolean; preventDefault(): void }, selection: readonly string[]): boolean => {
      const selected = store.get().selected;
      // Tab and Shift+Tab step through the selected table's columns, as draw.io's Tab selects the next cell in a
      // table (fix round 2, I1: a column reached from the keyboard); past either end, focus moves on as usual.
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey && selection.length === 1) {
        const t = opts.current.doc()?.nodes.find((n) => n.name === selection[0] && isErTable(n));
        const count = t?.rows?.length ?? 0;
        if (!t || count === 0) return false;
        const at = selected && selected.table === t.name ? selected.index + (e.shiftKey ? -1 : 1) : e.shiftKey ? count - 1 : 0;
        if (at < 0 || at >= count) {
          setSelected(null);
          return false;
        }
        e.preventDefault();
        setSelected({ table: t.name, index: at });
        return true;
      }
      const col = selected;
      if (!col || selection.length !== 1 || selection[0] !== col.table || e.altKey) return false;
      const ctrl = e.ctrlKey || e.metaKey;
      const t = opts.current.doc()?.nodes.find((n) => n.name === col.table);
      if (!t || col.index >= (t.rows ?? []).length) return false;
      const k = e.key.toLowerCase();
      // The clipboard keys act on the column, as on a draw.io table row: Ctrl+C copies its line, Ctrl+X cuts it.
      if (ctrl && !e.shiftKey && (k === "c" || k === "x")) {
        // A cut that will be refused (the lock, an old-form frame, a stale drawing) says why and copies nothing.
        const cuts = k === "x" && !erRefusal(opts.current);
        if (k === "c" || cuts) opts.current.copy?.(`${columnLine(t, col.index, { comment: false })}\n`);
        if (k === "c") return true;
        e.preventDefault();
        api.deleteColumn(col.table, col.index);
        return true;
      }
      // Ctrl+D duplicates the column below, as Ctrl+Enter.
      if ((e.key === "Enter" || (k === "d" && !e.shiftKey)) && ctrl) {
        e.preventDefault();
        api.duplicateColumn(col.table, col.index);
        return true;
      }
      if (ctrl) return false;
      if (e.key === "Enter" || e.key === "F2") {
        e.preventDefault();
        api.editColumn(col.table, col.index, "name");
        return true;
      }
      // Backspace deletes as Delete does (F25).
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        api.deleteColumn(col.table, col.index);
        return true;
      }
      if (k === "k" || k === "n") {
        e.preventDefault();
        // Held down, the key repeats: one press is one toggle (M7).
        if (e.repeat) return true;
        api.toggleFlag(col.table, col.index, k === "k" ? "pk" : "not null");
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSelected(null);
        return true;
      }
      return false;
    },
    [api, store, setSelected],
  );

  /** The selection moved off the column's table: the column lets go. */
  const syncSelection = useCallback(
    (selection: readonly string[]) => {
      const c = store.get().selected;
      if (c && !(selection.length === 1 && selection[0] === c.table)) setSelected(null);
    },
    [store, setSelected],
  );

  const readOnly = o.readOnly;
  const value = useMemo(() => ({ api: { ...api, readOnly }, store }), [api, readOnly, store]);
  /** The column the right-click that opened this menu was on, if it was on this table's column. */
  const takeMenuColumn = useCallback((tableName: string): ErColumn | null => {
    const c = menuColumn.current;
    menuColumn.current = null;
    return c && c.table === tableName ? c : null;
  }, []);
  /** A frame switch (decision 8): the store holds nothing for the old frame. */
  const reset = useCallback(() => {
    menuColumn.current = null;
    busy.current = null;
    flagging.current = false;
    store.set({ edit: null, selected: null, aim: null });
  }, [store]);
  const selected = useCallback(() => store.get().selected, [store]);
  return { value, onKey, syncSelection, takeMenuColumn, reset, selected };
}
