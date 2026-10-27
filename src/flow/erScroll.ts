// ER build C, fix round 1 (ruling 4): how far each ER card's rows are scrolled, so a relationship to a row moves with
// it and one to a row scrolled out of view ends at the card's top or bottom edge (DataGrip, dbdiagram). Only cards
// scrolled away from the top have an entry, and a line subscribes to its own two cards only.
//
// B3 Task 5 (decisions 5 and 8): restored around the whole board canvas; only the live frame's cards and lines read it
// (a static one passes null), a frame switch empties it (`clear`), and a tab drag of the live frame keeps it (R26).
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

export interface ErScrollStore {
  get(table: string): number;
  set(table: string, top: number): void;
  subscribe(table: string, fn: () => void): () => void;
  /** A renamed table keeps how far its rows are scrolled; its old name keeps nothing (Task 5 fix round 1). */
  move(old: string, next: string): void;
  /** After a parse of the live frame: drops every entry whose table is not in `keep`, waking only those tables. */
  prune(keep: ReadonlySet<string>): void;
  /** A frame switch: every entry dropped, each table's listeners woken once. */
  clear(): void;
  /** For tests (R27): the listeners subscribed to `table`. */
  listeners(table: string): number;
}

export function createErScrollStore(): ErScrollStore {
  const tops = new Map<string, number>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    get: (table) => tops.get(table) ?? 0,
    set(table, top) {
      if ((tops.get(table) ?? 0) === top) return;
      if (top === 0) tops.delete(table);
      else tops.set(table, top);
      for (const fn of listeners.get(table) ?? []) fn();
    },
    move(old, next) {
      if (old === next) return;
      const top = tops.get(old) ?? 0;
      this.set(next, top);
      this.set(old, 0);
    },
    prune(keep) {
      let gone: string[] | null = null;
      for (const table of tops.keys()) if (!keep.has(table)) (gone ??= []).push(table);
      if (!gone) return;
      for (const table of gone) tops.delete(table);
      for (const table of gone) for (const fn of listeners.get(table) ?? []) fn();
    },
    clear() {
      if (tops.size === 0) return;
      const was = [...tops.keys()];
      tops.clear();
      for (const table of was) for (const fn of listeners.get(table) ?? []) fn();
    },
    listeners: (table) => listeners.get(table)?.size ?? 0,
    subscribe(table, fn) {
      let set = listeners.get(table);
      if (!set) listeners.set(table, (set = new Set()));
      set.add(fn);
      return () => {
        set!.delete(fn);
        if (set!.size === 0) listeners.delete(table);
      };
    },
  };
}

export const ErScrollContext = createContext<ErScrollStore | null>(null);

const none = () => () => {};

/** How far `table`'s rows are scrolled (0 with no store, or for null: a line that meets no row). */
export function useErScroll(table: string | null): number {
  const store = useContext(ErScrollContext);
  const subscribe = useCallback((fn: () => void) => (store && table !== null ? store.subscribe(table, fn) : none()), [store, table]);
  return useSyncExternalStore(subscribe, () => (store && table !== null ? store.get(table) : 0));
}

/**
 * Fix round 2 (I5): the one table selected alone, if any. Only it shows its column ports when not hovered, as draw.io
 * shows connection points for one shape; a selection of 2,000 cards mounts none and measures none. A card listens to
 * its own name only, so a change wakes the old and the new card.
 */
export interface ErSoleStore {
  set(table: string | null): void;
  subscribe(table: string, fn: () => void): () => void;
  is(table: string): boolean;
}

export function createErSoleStore(): ErSoleStore {
  let sole: string | null = null;
  const listeners = new Map<string, Set<() => void>>();
  const wake = (t: string | null) => {
    if (t !== null) for (const fn of listeners.get(t) ?? []) fn();
  };
  return {
    set(table) {
      if (table === sole) return;
      const was = sole;
      sole = table;
      wake(was);
      wake(table);
    },
    is: (table) => sole === table,
    subscribe(table, fn) {
      let set = listeners.get(table);
      if (!set) listeners.set(table, (set = new Set()));
      set.add(fn);
      return () => {
        set!.delete(fn);
        if (set!.size === 0) listeners.delete(table);
      };
    },
  };
}

export const ErSoleContext = createContext<ErSoleStore | null>(null);

/** True while `table` is the one table selected alone; false, with no subscription, for null (a static card). */
export function useErSole(table: string | null): boolean {
  const store = useContext(ErSoleContext);
  const subscribe = useCallback((fn: () => void) => (store && table !== null ? store.subscribe(table, fn) : none()), [store, table]);
  return useSyncExternalStore(subscribe, () => (store && table !== null ? store.is(table) : false));
}
