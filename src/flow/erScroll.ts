// ER build C, fix round 1 (ruling 4): how far each ER card's rows are scrolled, so a relationship to a row moves with
// it and one to a row scrolled out of view ends at the card's top or bottom edge (DataGrip, dbdiagram). Only cards
// scrolled away from the top have an entry, and a line subscribes to its own two cards only.
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

export interface ErScrollStore {
  get(table: string): number;
  set(table: string, top: number): void;
  subscribe(table: string, fn: () => void): () => void;
  /** A renamed table keeps how far its rows are scrolled. */
  move(old: string, next: string): void;
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
      const top = tops.get(old) ?? 0;
      this.set(next, top);
    },
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

/** True while `table` is the one table selected alone. */
export function useErSole(table: string): boolean {
  const store = useContext(ErSoleContext);
  const subscribe = useCallback((fn: () => void) => (store ? store.subscribe(table, fn) : none()), [store, table]);
  return useSyncExternalStore(subscribe, () => (store ? store.is(table) : false));
}
