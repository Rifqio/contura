// The Shelf's icon seam (decision 6): one source the Icons tab, the search's Icons group and the Space box read.
// It loads the pack's index once and holds that one array; the full icon pack swaps the `makeShelfIconSource({...})` call below
// for its own ranking and recents, and nothing else changes.
import { createContext } from "react";
import type { IconEntry } from "../../../api/types";
import { providerOf, rankIcons } from "../../../lang/flow/iconRank";
import { iconEntries } from "../../icons";

/** One icon as the Shelf lists it. The full pack's `IconTile` satisfies it. */
export interface ShelfIconHit {
  name: string;
  title: string;
  set: string;
}

export interface ShelfIconSource {
  /** Reads the pack's index once; a failed read is tried again on the next call. */
  load(): Promise<void>;
  /** How many icons match; null until loaded. */
  count(query: string): number | null;
  /** The best `n` matches; empty until loaded. */
  results(query: string, n: number): readonly ShelfIconHit[];
  /** `results`, kept by name for the full pack's recents-first answer to the Space box. */
  top(query: string, n: number): readonly ShelfIconHit[];
  /** Called on every icon add from the Shelf or the Space box. */
  remember(name: string): void;
}

/** The Icons tab shows at most this many tiles before the full pack windows it. */
export const SHELF_ICON_LIMIT = 48;
/** The search's Icons group shows at most this many hits, then "Show all" (decision 4). */
export const SHELF_GROUP_ICONS = 24;

const NONE: readonly ShelfIconHit[] = Object.freeze([]);

export function makeShelfIconSource(p: {
  entries(): Promise<IconEntry[]>;
  count(entries: readonly IconEntry[], query: string): number;
  results(entries: readonly IconEntry[], query: string, n: number): readonly ShelfIconHit[];
  remember(name: string): void;
}): ShelfIconSource {
  let entries: IconEntry[] | null = null;
  let loading: Promise<void> | null = null;
  const results = (query: string, n: number) => (entries ? p.results(entries, query, n) : NONE);
  return {
    load() {
      if (entries) return Promise.resolve();
      if (!loading) {
        loading = p.entries().then(
          (list) => {
            entries = list;
          },
          (e: unknown) => {
            loading = null;
            throw e;
          },
        );
      }
      return loading;
    },
    count: (query) => (entries ? p.count(entries, query) : null),
    results,
    top: results,
    remember: (name) => p.remember(name),
  };
}

/** A search as icon names are written: trimmed, lower case, spaces as dashes (as the icon picker reads it). */
const normalise = (q: string) => q.trim().toLowerCase().replace(/\s+/g, "-");

interface Prepared {
  /** Every name, A to Z. */
  names: string[];
  /** Each name lower-cased, and the part after its provider prefix: `rankIcons`'s match rule, worked out once. */
  lower: string[];
  rest: string[];
  byName: Map<string, IconEntry>;
}

/** One name list and one name-to-entry map per loaded array; a new array gets its own. */
const prepared = new WeakMap<readonly IconEntry[], Prepared>();

function prepare(entries: readonly IconEntry[]): Prepared {
  let p = prepared.get(entries);
  if (!p) {
    const byName = new Map<string, IconEntry>();
    for (const e of entries) byName.set(e.name, e);
    const names = [...byName.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const lower = names.map((n) => n.toLowerCase());
    const rest = lower.map((n) => {
      const provider = providerOf(n);
      return provider ? n.slice(provider.length + 1) : n;
    });
    p = { names, lower, rest, byName };
    prepared.set(entries, p);
  }
  return p;
}

/** How many names `rankIcons` would rank for `query`: the same match rule, with nothing kept. */
export function basicCount(entries: readonly IconEntry[], query: string): number {
  const { names, lower, rest } = prepare(entries);
  const q = normalise(query);
  if (!q) return names.length;
  let n = 0;
  for (let i = 0; i < lower.length; i++) if (lower[i].startsWith(q) || rest[i].includes(q)) n++;
  return n;
}

/** The best `n` icons for `query`, ranked as completion ranks them; A to Z with nothing typed. */
export function basicResults(entries: readonly IconEntry[], query: string, n: number): readonly ShelfIconHit[] {
  const { names, byName } = prepare(entries);
  const q = normalise(query);
  const picked = q ? rankIcons(names, q, n) : names.slice(0, n);
  return picked.map((name) => {
    const e = byName.get(name)!;
    return { name, title: e.title, set: e.set };
  });
}

/** The app's icon source: today's pack, ranked by name. The full icon pack replaces this one call. */
export const shelfIconSource = makeShelfIconSource({ entries: iconEntries, count: basicCount, results: basicResults, remember: () => {} });

/** The source the open Shelf reads: its `source` prop, so the Icons count, the Icons tab and the search agree. */
export const ShelfIconContext = createContext<ShelfIconSource>(shelfIconSource);
