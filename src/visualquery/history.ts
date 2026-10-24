/** Undo and redo over the Visual Query model: snapshots share structure, and the stack is capped. */
export const HISTORY_CAP = 100;
/** Edits to one field closer together than this are one step (typing a filter value). */
const MERGE_MS = 1000;

export type History<T> = {
  past: T[];
  future: T[];
  /** Set for the rest of the tick a step was recorded in, so one gesture that changes many things is one step. */
  open: boolean;
  mergeKey: string | null;
  mergeAt: number;
};

export function createHistory<T>(): History<T> {
  return { past: [], future: [], open: false, mergeKey: null, mergeAt: 0 };
}

export function clearHistory<T>(h: History<T>): void {
  h.past = [];
  h.future = [];
  h.mergeKey = null;
}

/** Records `before`, the model as it was ahead of a change. */
export function record<T>(h: History<T>, before: T, opts: { now: number; merge?: string }): void {
  const merged = opts.merge !== undefined && opts.merge === h.mergeKey && opts.now - h.mergeAt < MERGE_MS;
  h.mergeKey = opts.merge ?? null;
  h.mergeAt = opts.now;
  if (merged || h.open) return;
  h.past.push(before);
  if (h.past.length > HISTORY_CAP) h.past.shift();
  h.future = [];
  h.open = true;
  queueMicrotask(() => {
    h.open = false;
  });
}

/** The model one step back, or null at the start. `current` is kept for redo. */
export function undo<T>(h: History<T>, current: T): T | null {
  const back = h.past.pop();
  h.mergeKey = null;
  if (back === undefined) return null;
  h.future.push(current);
  return back;
}

export function redo<T>(h: History<T>, current: T): T | null {
  const ahead = h.future.pop();
  h.mergeKey = null;
  if (ahead === undefined) return null;
  h.past.push(current);
  return ahead;
}
