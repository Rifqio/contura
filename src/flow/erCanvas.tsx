// ER build A (erd-ux-research 5.1 to 5.3, board ER interactions): the ER canvas edits its tables in place. The
// pointer target is the intent: double-click the header renames the table, a column's name or type edits it,
// empty card space adds a column there; the hover "+ column" row adds at the end; the key gutter and K and N
// set the key and not null. Each commit is one worker edit, so one text change and one undo step. The rules
// for where Enter, Tab, Shift+Tab, Escape and a click away go are here; the field is the shared InlineEdit.
import { createContext, useCallback, useMemo, useRef, useState } from "react";
import type { CommitHow } from "./interactions/InlineEdit";
import { type ColumnFlag, columnFlagsText, columnsWritable, type FlowDoc, type FlowNode, isColumnName, isColumnType } from "../lang/flow/model";
import type { FlowRequestOp } from "../lang/flow/service";

export type ErField = "name" | "type";

/** What is open for editing on the ER canvas: a table's name, a column's field, or a new column row. */
export type ErEdit =
  | { kind: "table"; table: string; error?: string; tries?: number }
  | { kind: "col"; table: string; index: number; field: ErField; error?: string; tries?: number; column?: string }
  | { kind: "draft"; table: string; at: number; field: ErField; name: string; type: string; error?: string; tries?: number };

export type ErColumn = { table: string; index: number };

/** What the table cards read and call. Absent (null) the cards only draw, as in a preview. */
export interface ErCanvasApi {
  edit: ErEdit | null;
  selected: ErColumn | null;
  /** While "Make a relationship from here" picks (fix round 2, I1): the column the keyboard is on. */
  aim?: ErColumn | null;
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
  /** Why this table's columns cannot be edited on the card, or null. */
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

export const ErCanvasContext = createContext<ErCanvasApi | null>(null);

/** The types offered while a type is typed: the board's list, then the ones the diagram already uses. */
export const ER_TYPES = ["int", "bigint", "text", "varchar(255)", "numeric(12,2)", "boolean", "date", "timestamptz", "uuid", "jsonb"];

/** A column row's name and type, as the card draws them. */
export function splitRow(row: string): { name: string; type: string } {
  const at = row.search(/\s/);
  return at < 0 ? { name: row, type: "" } : { name: row.slice(0, at), type: row.slice(at + 1).trim() };
}

export const ER_MESSAGES = {
  tableNeedsName: "A table needs a name.",
  columnNeedsName: "A column needs a name.",
  plainName: "Use letters, digits and _ only.",
  plainType: "Use a type without [ ] { } : < > or quotes.",
  nameFirst: "Name the column first: Shift+Tab goes back.",
  tableTaken: (name: string) => `${name} is already a table in this diagram.`,
  columnTaken: (name: string, table: string) => `${name} is already a column of ${table}.`,
  pkNotNull: "A primary key is never null.",
  changed: "The text changed meanwhile. Try again.",
  stale: "Fix the text first: the drawing is from the last text that worked.",
  locked: "The Assistant is working on the text. Your edit is kept until it finishes.",
  /** A gesture that adds something (a double-click on the canvas) keeps nothing while the Assistant works (fix round 4, N5). */
  lockedAdd: "Not changed: the Assistant is editing this diagram. Your edit can wait until it finishes.",
  tableGone: (table: string) => `${table} is no longer in the text.`,
  columnGone: (table: string) => `This column of ${table} is no longer in the text.`,
  notWritable: "Edit this table's columns in the text: its name has a dot or needs quotes.",
  /** ER build C: a deleted column takes the relationships that use it along. */
  deletedWith: (table: string, column: string, n: number) => `Deleted ${table}.${column} and its line${n === 1 ? "" : "s"}. Ctrl+Z brings them back.`,
};

/** How many relationships use `table.column` (ER build C). */
export function relationshipsOf(doc: FlowDoc | null, table: string, column: string): number {
  let n = 0;
  for (const l of doc?.links ?? []) if ((l.from === table && l.fromColumn === column) || (l.to === table && l.toColumn === column)) n++;
  return n;
}

interface Options {
  /** The doc the canvas edits: the current parse's, else the drawing. */
  doc(): FlowDoc | null;
  run(op: FlowRequestOp): Promise<unknown | null>;
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
  /** The column the keyboard is on while a pick is on. */
  aim?: ErColumn | null;
}

const isEntity = (n: FlowNode) => n.kind === "entity" || n.kind === "weak";

export function useErCanvas(o: Options) {
  const [edit, setEditState] = useState<ErEdit | null>(null);
  const [selected, setSelected] = useState<ErColumn | null>(null);
  const editRef = useRef<ErEdit | null>(null);
  /** The column a right-click landed on, for the menu that opens next. */
  const menuColumn = useRef<ErColumn | null>(null);
  /** The edit whose commit is being written: its field's later blur is not a second commit. */
  const busy = useRef<ErEdit | null>(null);
  const opts = useRef(o);
  opts.current = o;

  const setEdit = useCallback((e: ErEdit | null) => {
    editRef.current = e;
    setEditState(e);
  }, []);

  const table = (name: string): FlowNode | undefined => opts.current.doc()?.nodes.find((n) => n.name === name && isEntity(n));
  const columns = (t: FlowNode) => (t.rows ?? []).map(splitRow);

  /** False, with the reason in the strip, while the drawing may not be the text (I5). */
  const fresh = useCallback(() => {
    if (!opts.current.stale()) return true;
    opts.current.notice(ER_MESSAGES.stale);
    return false;
  }, []);

  const open = useCallback(
    (e: ErEdit) => {
      if (opts.current.locked() || !fresh()) return false;
      opts.current.notice(null);
      setEdit(e);
      return true;
    },
    [setEdit, fresh],
  );

  const api = useMemo(() => {
    /** Closed by a key (or Escape): focus goes back to the canvas; a click away leaves it where the click put it. */
    const done = (how: CommitHow | "cancel") => {
      setEdit(null);
      if (how !== "blur") opts.current.refocus();
    };
    /** Refused: the field stays open with the reason, however it was left; only Escape discards (I1). */
    const refuse = (e: ErEdit, error: string, next?: Partial<ErEdit>) => {
      setEdit({ ...e, ...next, error, tries: (e.tries ?? 0) + 1 } as ErEdit);
    };
    const write = async (e: ErEdit, op: FlowRequestOp) => {
      busy.current = e;
      try {
        return !!(await opts.current.run(op));
      } finally {
        if (busy.current === e) busy.current = null;
      }
    };

    const commitTable = async (e: Extract<ErEdit, { kind: "table" }>, v: string, how: CommitHow) => {
      const docNow = opts.current.doc();
      const taken = docNow?.nodes.some((n) => n.name !== e.table && n.name.toLowerCase() === v.toLowerCase());
      const bad = !v ? ER_MESSAGES.tableNeedsName : !isColumnName(v) ? ER_MESSAGES.plainName : taken ? ER_MESSAGES.tableTaken(v) : "";
      if (bad) return refuse(e, bad);
      if (v === e.table) return done(how);
      if (!(await write(e, { op: "renameNode", old: e.table, next: v }))) return refuse(e, ER_MESSAGES.changed);
      opts.current.onRenamed(e.table, v);
      if (editRef.current === e) done(how);
    };

    const commitColumn = async (e: Extract<ErEdit, { kind: "col" }>, t: FlowNode, v: string, how: CommitHow) => {
      const cols = columns(t);
      const cur = cols[e.index];
      // Gone from the text meanwhile (an edit in the text, the Assistant): the field keeps what was typed.
      if (!cur || (e.column !== undefined && cur.name !== e.column)) return refuse(e, ER_MESSAGES.columnGone(t.name));
      const last = e.index === cols.length - 1;
      if (e.field === "name") {
        const taken = cols.some((c, i) => i !== e.index && c.name.toLowerCase() === v.toLowerCase());
        const bad = !v ? ER_MESSAGES.columnNeedsName : !isColumnName(v) ? ER_MESSAGES.plainName : taken ? ER_MESSAGES.columnTaken(v, t.name) : "";
        if (bad) return refuse(e, bad);
        if (v !== cur.name && !(await write(e, { op: "setColumn", table: e.table, index: e.index, column: cur.name, name: v }))) return refuse(e, ER_MESSAGES.changed);
        if (editRef.current !== e) return;
        if (how === "tab") return setEdit({ kind: "col", table: e.table, index: e.index, field: "type" });
        // Shift+Tab goes to the row above's type; on the first column it stays (M3).
        if (how === "shifttab") return setEdit({ kind: "col", table: e.table, index: Math.max(0, e.index - 1), field: e.index > 0 ? "type" : "name" });
        return done(how);
      }
      if (!isColumnType(v)) return refuse(e, ER_MESSAGES.plainType);
      if (v !== cur.type && !(await write(e, { op: "setColumn", table: e.table, index: e.index, column: cur.name, type: v }))) return refuse(e, ER_MESSAGES.changed);
      if (editRef.current !== e) return;
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
      if (!isColumnName(name)) return refuse(e, ER_MESSAGES.plainName, { field: "name", name, type });
      if (columns(t).some((c) => c.name.toLowerCase() === name.toLowerCase())) {
        const taken = ER_MESSAGES.columnTaken(name, t.name);
        return refuse(e, taken, { field: "name", name, type });
      }
      if (e.field === "name" && how === "tab") return setEdit({ ...e, name, type, field: "type", error: undefined });
      if (e.field === "type" && how === "shifttab") return setEdit({ ...e, name, type, field: "name", error: undefined });
      if (!isColumnType(type)) return refuse(e, ER_MESSAGES.plainType, { field: "type", name, type });
      if (!(await write(e, { op: "addColumn", table: e.table, at: e.at, before: columns(t)[e.at]?.name ?? null, name, type }))) return refuse(e, ER_MESSAGES.changed, { name, type });
      if (editRef.current !== e) return;
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

    const out: Omit<ErCanvasApi, "edit" | "selected" | "readOnly"> = {
      // What is edited is selected too (board ER interactions), so its keys work once the field closes (I4).
      editTable: (name) => {
        if (!open({ kind: "table", table: name })) return;
        setSelected(null);
        opts.current.onPick(name);
      },
      editColumn: (name, index, field) => {
        if (!columnsWritable(name)) return opts.current.notice(ER_MESSAGES.notWritable);
        const at = table(name)?.rows?.[index];
        if (!open({ kind: "col", table: name, index, field, ...(at !== undefined ? { column: splitRow(at).name } : {}) })) return;
        setSelected({ table: name, index });
        opts.current.onPick(name);
      },
      blocked: (name) => (columnsWritable(name) ? null : ER_MESSAGES.notWritable),
      addColumn: (name, at) => {
        if (!columnsWritable(name)) return opts.current.notice(ER_MESSAGES.notWritable);
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
        if (opts.current.locked() || !fresh()) return;
        if (!columnsWritable(name)) return opts.current.notice(ER_MESSAGES.notWritable);
        const t = table(name);
        const flags = t?.rowFlags?.[index] ?? [];
        if (!t || index >= (t.rows ?? []).length) return;
        opts.current.notice(null);
        setSelected({ table: name, index });
        if (flag === "not null" && flags.includes("pk")) {
          opts.current.notice(ER_MESSAGES.pkNotNull);
          return;
        }
        void opts.current.run({ op: "setColumnFlag", table: name, index, column: splitRow((t.rows ?? [])[index]).name, flag, on: !flags.includes(flag) });
      },
      duplicateColumn: (name, index) => {
        const column = columnAt(name, index);
        if (column === null || opts.current.locked() || !fresh()) return;
        void opts.current.run({ op: "duplicateColumn", table: name, index, column }).then((r) => {
          if (r) setSelected({ table: name, index: index + 1 });
        });
      },
      deleteColumn: (name, index) => {
        const column = columnAt(name, index);
        if (column === null || opts.current.locked() || !fresh()) return;
        const lines = relationshipsOf(opts.current.doc(), name, column);
        void opts.current.run({ op: "deleteColumn", table: name, index, column }).then((r) => {
          if (!r) return;
          setSelected(null);
          if (lines > 0) opts.current.notice(ER_MESSAGES.deletedWith(name, column, lines), true);
        });
      },
      commit: (e, v, how) => {
        if (editRef.current !== e || busy.current === e) return;
        // Never dropped: under the Assistant's lock the field stays open with what was typed (I6).
        if (opts.current.locked()) return refuse(e, ER_MESSAGES.locked, e.kind === "draft" ? (e.field === "name" ? { name: v } : { type: v }) : undefined);
        if (opts.current.stale()) return setEdit({ ...e, error: ER_MESSAGES.stale });
        const t = table(e.table);
        if (!t) return refuse(e, ER_MESSAGES.tableGone(e.table), e.kind === "draft" ? (e.field === "name" ? { name: v } : { type: v }) : undefined);
        if (e.kind === "table") void commitTable(e, v, how);
        else if (e.kind === "col") void commitColumn(e, t, v, how);
        else void commitDraft(e, t, v, how);
      },
      cancel: (e) => {
        if (editRef.current === e) done("cancel");
      },
    };
    return out;
  }, [open, setEdit, fresh]);

  /** The selected column's keys (erd-ux-research 5.8); true when the key was taken. */
  const onKey = useCallback(
    (e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; repeat?: boolean; preventDefault(): void }, selection: readonly string[]): boolean => {
      // Tab and Shift+Tab step through the selected table's columns, as draw.io's Tab selects the next cell in a
      // table (fix round 2, I1: a column reached from the keyboard); past either end, focus moves on as usual.
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey && selection.length === 1) {
        const t = opts.current.doc()?.nodes.find((n) => n.name === selection[0] && isEntity(n));
        const count = t?.rows?.length ?? 0;
        if (!t || count === 0 || !columnsWritable(t.name)) return false;
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
      const column = splitRow((t.rows ?? [])[col.index]).name;
      const k = e.key.toLowerCase();
      // The clipboard keys act on the column, as on a draw.io table row: Ctrl+C copies its line, Ctrl+X cuts it.
      if (ctrl && !e.shiftKey && (k === "c" || k === "x")) {
        opts.current.copy?.(`${col.table}.${(t.rows ?? [])[col.index]}${columnFlagsText(t.rowFlags?.[col.index] ?? [])}\n`);
        if (k === "c") return true;
        e.preventDefault();
        if (opts.current.locked() || !fresh()) return true;
        const lines = relationshipsOf(opts.current.doc(), col.table, column);
        void opts.current.run({ op: "deleteColumn", table: col.table, index: col.index, column }).then((r) => {
          if (!r) return;
          setSelected(null);
          if (lines > 0) opts.current.notice(ER_MESSAGES.deletedWith(col.table, column, lines), true);
        });
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
    [selected, api, fresh],
  );

  /** The selection moved off the column's table: the column lets go. */
  const syncSelection = useCallback((selection: readonly string[]) => {
    setSelected((c) => (c && selection.length === 1 && selection[0] === c.table ? c : null));
  }, []);

  const aim = o.aim ?? null;
  const value: ErCanvasApi = useMemo(() => ({ ...api, edit, selected, readOnly: o.readOnly, aim }), [api, edit, selected, o.readOnly, aim]);
  /** The column the right-click that opened this menu was on, if it was on this table's column. */
  const takeMenuColumn = useCallback((tableName: string): ErColumn | null => {
    const c = menuColumn.current;
    menuColumn.current = null;
    return c && c.table === tableName ? c : null;
  }, []);
  const close = useCallback(() => setEdit(null), [setEdit]);
  return { value, edit, onKey, syncSelection, takeMenuColumn, close };
}
