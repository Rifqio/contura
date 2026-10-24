import type { Cell, ColumnInfo, EditSet, KeyPart, NewValue, ObjectPath } from "../api/types";

/** A loaded row's identity: its primary key cells, in key-column order. */
export type RowKey = string;
/** A new row's identity until it is saved. Starts with "new:", unlike a RowKey. */
export type LocalId = string;

interface RowEdit {
  key: KeyPart[];
  row: Cell[];
  /** Column name to new value, in the order the cells were first edited. */
  changes: [string, NewValue][];
  /** Full old values of cut-short text cells, by column: the Core can't match a row on a cut-short value. */
  full?: [string, Cell][];
}

interface NewRow {
  localId: LocalId;
  values: [string, NewValue][];
  /** G17: the row it shows under (a loaded row's key or a new row's id); none puts it at the bottom. */
  after?: RowKey | LocalId;
}

interface RowDeletion {
  key: KeyPart[];
}

interface State {
  updates: [RowKey, RowEdit][];
  inserts: NewRow[];
  deletes: [RowKey, RowDeletion][];
}

/** Pending Edits to one table. Every operation returns a new value. */
export interface Pending {
  readonly columns: ColumnInfo[];
  readonly state: State;
  readonly past: State[];
  readonly future: State[];
  readonly nextId: number;
}

const EMPTY: State = { updates: [], inserts: [], deletes: [] };

export function emptyPending(columns: ColumnInfo[]): Pending {
  return { columns, state: EMPTY, past: [], future: [], nextId: 1 };
}

export function keyOf(columns: ColumnInfo[], row: Cell[]): RowKey | null {
  const parts = keyParts(columns, row);
  return parts ? JSON.stringify(parts.map((p) => p.value)) : null;
}

function keyParts(columns: ColumnInfo[], row: Cell[]): KeyPart[] | null {
  const parts = columns.flatMap((c, i) => (c.isPrimaryKey ? [{ column: c.name, value: row[i] }] : []));
  return parts.length ? parts : null;
}

const isNew = (ref: string) => ref.startsWith("new:");

function commit(p: Pending, state: State, nextId = p.nextId): Pending {
  return { ...p, state, past: [...p.past, p.state], future: [], nextId };
}

function sameAsLoaded(old: Cell | undefined, value: NewValue): boolean {
  if (!old) return false;
  if (value.t === "default") return false;
  if (value.t === "null") return old.t === "null";
  if (old.t === "number") return old.value === value.value;
  if (old.t === "text") return !old.truncated && old.value === value.value;
  return false;
}

const isCut = (c: Cell | undefined) => c?.t === "text" && c.truncated;

function withFull(full: [string, Cell][] | undefined, column: string, cell: Cell | undefined): [string, Cell][] | undefined {
  if (!cell || isCut(cell)) return full;
  return [...(full ?? []).filter(([c]) => c !== column), [column, cell]];
}

/**
 * Edits a loaded cell. `fullOld` is the cell's whole old value when the loaded one was cut short;
 * it is kept for the row and sent as the old value on Save.
 */
export function editCell(
  p: Pending,
  rowKey: RowKey,
  row: Cell[],
  column: string,
  value: NewValue,
  fullOld?: Cell,
): Pending {
  if (isDeleted(p, rowKey)) return p;
  const key = keyParts(p.columns, row);
  if (!key) return p;
  const current = p.state.updates.find(([k]) => k === rowKey)?.[1];
  const full = withFull(current?.full, column, fullOld);
  const old = full?.find(([c]) => c === column)?.[1] ?? row[p.columns.findIndex((c) => c.name === column)];
  const others = (current?.changes ?? []).filter(([c]) => c !== column);
  const changes: [string, NewValue][] = sameAsLoaded(old, value)
    ? others
    : current?.changes.some(([c]) => c === column)
      ? current.changes.map(([c, v]) => (c === column ? [c, value] : [c, v]))
      : [...others, [column, value]];
  const rest = p.state.updates.filter(([k]) => k !== rowKey);
  const updates: [RowKey, RowEdit][] = changes.length
    ? current
      ? p.state.updates.map(([k, e]) => (k === rowKey ? [k, { ...e, changes, full }] : [k, e]))
      : [...rest, [rowKey, { key, row, changes, full }]]
    : rest;
  return commit(p, { ...p.state, updates });
}

/** Changed cells whose old value is cut short and has no full value yet. */
export function missingFull(p: Pending): { rowKey: RowKey; key: KeyPart[]; column: string }[] {
  return p.state.updates.flatMap(([rowKey, e]) =>
    e.changes.flatMap(([column]) => {
      if (e.full?.some(([c]) => c === column)) return [];
      return isCut(e.row[p.columns.findIndex((c) => c.name === column)]) ? [{ rowKey, key: e.key, column }] : [];
    }),
  );
}

/** Keeps a cell's full old value. Not an undo step: it changes no value. */
export function withFullOld(p: Pending, rowKey: RowKey, column: string, cell: Cell): Pending {
  const updates = p.state.updates.map(([k, e]): [RowKey, RowEdit] =>
    k === rowKey ? [k, { ...e, full: withFull(e.full, column, cell) }] : [k, e],
  );
  return { ...p, state: { ...p.state, updates } };
}

export function editNewCell(p: Pending, localId: LocalId, column: string, value: NewValue): Pending {
  const inserts = p.state.inserts.map((r) => {
    if (r.localId !== localId) return r;
    const has = r.values.some(([c]) => c === column);
    const values: [string, NewValue][] = has
      ? r.values.map(([c, v]) => (c === column ? [c, value] : [c, v]))
      : [...r.values, [column, value]];
    return { ...r, values };
  });
  return commit(p, { ...p.state, inserts });
}

/** Set DEFAULT on a new row: the column is left out of the INSERT, so the server's default applies. */
export function unsetNewCell(p: Pending, localId: LocalId, column: string): Pending {
  const row = p.state.inserts.find((r) => r.localId === localId);
  if (!row || !row.values.some(([c]) => c === column)) return p;
  const inserts = p.state.inserts.map((r) => (r.localId === localId ? { ...r, values: r.values.filter(([c]) => c !== column) } : r));
  return commit(p, { ...p.state, inserts });
}

export function addRow(p: Pending, values?: Map<string, NewValue>, after?: RowKey | LocalId): [Pending, LocalId] {
  const localId = `new:${p.nextId}`;
  const row: NewRow = { localId, values: values ? [...values] : [], ...(after !== undefined && { after }) };
  return [commit(p, { ...p.state, inserts: [...p.state.inserts, row] }, p.nextId + 1), localId];
}

/** Marks a loaded row deleted (`row` needed), or removes a new row. */
export function deleteRow(p: Pending, ref: RowKey | LocalId, row?: Cell[]): Pending {
  if (isNew(ref)) {
    return commit(p, { ...p.state, inserts: p.state.inserts.filter((r) => r.localId !== ref) });
  }
  const key = row && keyParts(p.columns, row);
  if (!key || isDeleted(p, ref)) return p;
  return commit(p, {
    ...p.state,
    updates: p.state.updates.filter(([k]) => k !== ref),
    deletes: [...p.state.deletes, [ref, { key }]],
  });
}

export function revertCell(p: Pending, rowKey: RowKey, column: string): Pending {
  const updates = p.state.updates.flatMap(([k, e]): [RowKey, RowEdit][] => {
    if (k !== rowKey) return [[k, e]];
    const changes = e.changes.filter(([c]) => c !== column);
    return changes.length ? [[k, { ...e, changes }]] : [];
  });
  return commit(p, { ...p.state, updates });
}

export function revertRow(p: Pending, ref: RowKey | LocalId): Pending {
  if (isNew(ref)) return deleteRow(p, ref);
  return commit(p, {
    ...p.state,
    updates: p.state.updates.filter(([k]) => k !== ref),
    deletes: p.state.deletes.filter(([k]) => k !== ref),
  });
}

/** Runs several operations as one undo step, such as a paste. */
export function batch(p: Pending, run: (p: Pending) => Pending): Pending {
  const out = run(p);
  if (out.state === p.state) return p;
  return { ...out, past: [...p.past, p.state], future: [] };
}

export function undo(p: Pending): Pending {
  const last = p.past[p.past.length - 1];
  if (!last) return p;
  return { ...p, state: last, past: p.past.slice(0, -1), future: [p.state, ...p.future] };
}

export function redo(p: Pending): Pending {
  const [next, ...future] = p.future;
  if (!next) return p;
  return { ...p, state: next, past: [...p.past, p.state], future };
}

/** Throws every change away as one undo step, so Ctrl+Z brings them back. */
export function discard(p: Pending): Pending {
  if (count(p) === 0) return p;
  return commit(p, emptyPending(p.columns).state);
}

/** Empties the changes and the history after a save: the saved edits cannot be undone. */
export function settle(p: Pending): Pending {
  return { ...emptyPending(p.columns), nextId: p.nextId };
}

/** Lookups by row key, built once per state, so showing a page with many edits stays linear. */
const indexes = new WeakMap<State, { values: Map<RowKey, Map<string, NewValue>>; deleted: Set<RowKey> }>();
function indexOf(state: State) {
  let ix = indexes.get(state);
  if (!ix) {
    ix = {
      values: new Map(state.updates.map(([k, e]) => [k, new Map(e.changes)])),
      deleted: new Set(state.deletes.map(([k]) => k)),
    };
    indexes.set(state, ix);
  }
  return ix;
}

export function pendingValue(p: Pending, rowKey: RowKey, column: string): NewValue | undefined {
  return indexOf(p.state).values.get(rowKey)?.get(column);
}

export function isDeleted(p: Pending, rowKey: RowKey): boolean {
  return indexOf(p.state).deleted.has(rowKey);
}

/** One edit of a batch: what `editCell`, `editNewCell`, `unsetNewCell`, `addRow` and `deleteRow` do one at a time. */
export type CellOp =
  | { t: "set"; rowKey: RowKey; row: Cell[]; column: string; value: NewValue }
  | { t: "setNew"; localId: LocalId; column: string; value: NewValue }
  | { t: "unsetNew"; localId: LocalId; column: string }
  /** `after: "previous"` puts the row under the one this batch added before it. */
  | { t: "add"; values: Map<string, NewValue>; after?: RowKey | LocalId | "previous" }
  | { t: "delete"; ref: RowKey | LocalId; row?: Cell[] };

/**
 * C1: applies many edits (Ctrl+A then Delete, a paste, Alt+Delete over a page) to one working state and commits
 * once, so the batch is one undo step and costs time and memory in proportion to the edits. Returns the ids of the
 * rows it added. With nothing changed, returns `p` itself.
 */
export function applyMany(p: Pending, ops: CellOp[]): [Pending, LocalId[]] {
  const col = new Map(p.columns.map((c, i) => [c.name, i]));
  const updates = new Map(p.state.updates);
  /** Rows changed in this batch, with their changes as a map; written back at the end. */
  const work = new Map<RowKey, { edit: RowEdit; changes: Map<string, NewValue> }>();
  const deletes = new Map(p.state.deletes);
  const inserts = new Map(p.state.inserts.map((r) => [r.localId, r]));
  const freshValues = new Map<LocalId, Map<string, NewValue>>();
  const made: LocalId[] = [];
  let nextId = p.nextId;
  let changed = false;
  const newValues = (id: LocalId) => {
    let v = freshValues.get(id);
    if (!v) {
      const r = inserts.get(id);
      if (!r) return null;
      v = new Map(r.values);
      freshValues.set(id, v);
    }
    return v;
  };
  for (const op of ops) {
    switch (op.t) {
      case "set": {
        if (deletes.has(op.rowKey)) break;
        let w = work.get(op.rowKey);
        if (!w) {
          const current = updates.get(op.rowKey);
          const key = current?.key ?? keyParts(p.columns, op.row);
          if (!key) break;
          const edit: RowEdit = current ?? { key, row: op.row, changes: [] };
          w = { edit, changes: new Map(edit.changes) };
          work.set(op.rowKey, w);
          if (!current) updates.set(op.rowKey, edit);
        }
        const old = w.edit.full?.find(([c]) => c === op.column)?.[1] ?? w.edit.row[col.get(op.column) ?? -1];
        if (sameAsLoaded(old, op.value)) {
          if (w.changes.delete(op.column)) changed = true;
        } else if (w.changes.get(op.column) !== op.value) {
          w.changes.set(op.column, op.value);
          changed = true;
        }
        break;
      }
      case "setNew": {
        const v = newValues(op.localId);
        if (v) (v.set(op.column, op.value), (changed = true));
        break;
      }
      case "unsetNew": {
        const v = newValues(op.localId);
        if (v?.delete(op.column)) changed = true;
        break;
      }
      case "add": {
        const localId = `new:${nextId++}`;
        const after = op.after === "previous" ? made[made.length - 1] : op.after;
        inserts.set(localId, { localId, values: [...op.values], ...(after !== undefined && { after }) });
        made.push(localId);
        changed = true;
        break;
      }
      case "delete": {
        if (isNew(op.ref)) {
          if (inserts.delete(op.ref)) changed = true;
          break;
        }
        const key = op.row && keyParts(p.columns, op.row);
        if (!key || deletes.has(op.ref)) break;
        updates.delete(op.ref);
        work.delete(op.ref);
        deletes.set(op.ref, { key });
        changed = true;
        break;
      }
    }
  }
  if (!changed) return [p, []];
  for (const [k, w] of work) {
    if (w.changes.size === 0) updates.delete(k);
    else updates.set(k, { ...w.edit, changes: [...w.changes] });
  }
  for (const [id, v] of freshValues) {
    const r = inserts.get(id);
    if (r) inserts.set(id, { ...r, values: [...v] });
  }
  const state: State = { updates: [...updates], inserts: [...inserts.values()], deletes: [...deletes] };
  return [commit(p, state, nextId), made];
}

export function newRows(p: Pending): { localId: LocalId; values: Map<string, NewValue>; after?: RowKey | LocalId }[] {
  return p.state.inserts.map((r) => ({ localId: r.localId, values: new Map(r.values), after: r.after }));
}

/** Changed rows: updated, inserted and deleted. */
export function count(p: Pending): number {
  return p.state.updates.length + p.state.inserts.length + p.state.deletes.length;
}

export function summary(p: Pending): { cells: number; newRows: number; deletedRows: number } {
  return {
    cells: p.state.updates.reduce((n, [, e]) => n + e.changes.length, 0),
    newRows: p.state.inserts.length,
    deletedRows: p.state.deletes.length,
  };
}

export function toEditSet(p: Pending, table: ObjectPath): EditSet {
  const index = (column: string) => p.columns.findIndex((c) => c.name === column);
  return {
    table,
    updates: p.state.updates.map(([, e]) => ({
      key: e.key,
      changes: e.changes.map(([column, value]) => ({
        column,
        old: e.full?.find(([c]) => c === column)?.[1] ?? e.row[index(column)],
        new: value,
      })),
    })),
    inserts: p.state.inserts.map((r) => ({ values: r.values })),
    deletes: p.state.deletes.map(([, d]) => ({ key: d.key })),
  };
}
