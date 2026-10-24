import type { ConnectionConfig, ConnectionId, DiagramEntry, DialectKind, ObjectKind, ObjectPath, RecentItem, SavedQuery } from "../api/types";
import type { Command, CommandId } from "../commands/registry";
import { fileName } from "../home/recent";
import { objectKey } from "../objectPath";
import { FuzzyScorer, type HighlightPart, foldCase, fuzzyMatch, highlightParts, isWordStart } from "./fuzzy";
import type { NameIndex } from "./nameIndex";

/** What the box lists: things to open, commands (typed `>`), or the prefixes (typed `?`). */
export type QuickMode = "open" | "commands" | "help";

export function modeOf(text: string): QuickMode {
  if (text.startsWith(">")) return "commands";
  if (text.startsWith("?")) return "help";
  return "open";
}

/** At most this many rows are drawn while typing; the best ones come first. */
export const MAX_RESULTS = 200;

export type QuickItemKind = ObjectKind | "saved" | "visual" | "flow" | "model";

export const KIND_WORD: Record<QuickItemKind, string> = {
  table: "Table",
  view: "View",
  function: "Function",
  procedure: "Procedure",
  trigger: "Trigger",
  saved: "Saved Query",
  visual: "Visual Query",
  flow: "Diagram",
  model: "Schema Model",
};

const KIND_ORDER: QuickItemKind[] = ["table", "view", "function", "procedure", "trigger", "saved", "visual", "flow", "model"];

/** How Quick Open opens an item, through the app's own open paths. */
export type QuickTarget =
  | { kind: "object"; connectionId: ConnectionId; object: ObjectKind; path: ObjectPath }
  | { kind: "saved"; query: SavedQuery }
  | { kind: "flow"; name: string }
  | { kind: "recent"; item: RecentItem };

export interface QuickConnection {
  id: ConnectionId;
  name: string;
  dialect: DialectKind;
  production: boolean;
  readOnly: boolean;
  open: boolean;
}

/** One thing Quick Open can open. `id` matches the tab key of its tab where it has one (objects, diagrams). */
export interface QuickItem {
  id: string;
  kind: QuickItemKind;
  name: string;
  /** The schema (or the MySQL database) shown before the name and matched as "schema.name"; null when none. */
  qualifier: string | null;
  connection: QuickConnection | null;
  target: QuickTarget;
}

export interface QuickSources {
  connections: readonly ConnectionConfig[];
  openIds: ReadonlySet<ConnectionId>;
  names: Pick<NameIndex, "names">;
  savedQueries: readonly SavedQuery[];
  diagrams: readonly DiagramEntry[];
  recent: readonly RecentItem[];
  /** The id of the item the active tab shows: Recent leaves it out, so Enter on an empty box always does something. */
  activeId: string | null;
}

/** An object's qualifier: its schema, the database on MySQL, nothing on SQLite. */
function qualifierOf(dialect: DialectKind | undefined, path: ObjectPath): string | null {
  if (path.schema !== null) return path.schema;
  return dialect === "sqlite" ? null : path.database;
}

export const savedItemId = (id: string) => `saved:${id}`;
export const flowItemId = (name: string) => `flow:${name}`;
const modelItemId = (file: string) => `model:${file}`;

/** Every item Quick Open can find, and the ids of Recent in Home's order (newest first). */
export function quickItems(s: QuickSources): { all: QuickItem[]; recentIds: string[] } {
  const byId = new Map(s.connections.map((c) => [c.id, c]));
  const connectionOf = (id: ConnectionId | null): QuickConnection | null => {
    const c = id === null ? undefined : byId.get(id);
    return c ? { id: c.id, name: c.name, dialect: c.dialect, production: c.production, readOnly: c.readOnly, open: s.openIds.has(c.id) } : null;
  };
  const items = new Map<string, QuickItem>();
  const add = (item: QuickItem) => {
    if (!items.has(item.id)) items.set(item.id, item);
  };
  const object = (connectionId: ConnectionId, kind: ObjectKind, path: ObjectPath): QuickItem => ({
    id: objectKey(connectionId, kind, path),
    kind,
    name: path.name,
    qualifier: qualifierOf(byId.get(connectionId)?.dialect, path),
    connection: connectionOf(connectionId),
    target: { kind: "object", connectionId, object: kind, path },
  });
  for (const c of s.connections) {
    for (const n of s.names.names(c.id)) add(object(c.id, n.kind, { database: n.database, schema: n.schema, name: n.name }));
  }
  for (const q of s.savedQueries) {
    add({
      id: savedItemId(q.id),
      kind: q.kind === "visual" ? "visual" : "saved",
      name: q.name,
      qualifier: null,
      connection: connectionOf(q.connectionId),
      target: { kind: "saved", query: q },
    });
  }
  for (const d of s.diagrams) add({ id: flowItemId(d.name), kind: "flow", name: d.name, qualifier: null, connection: null, target: { kind: "flow", name: d.name } });

  // Recent, as Home's column: its items and the diagrams by time, newest first.
  const timeline: { at: number; id: string }[] = s.diagrams.map((d) => ({ at: d.modifiedMs, id: flowItemId(d.name) }));
  for (const r of s.recent) {
    const t = r.target;
    let id: string;
    if (t.kind === "table") {
      if (r.connectionId === null || !byId.has(r.connectionId)) continue;
      // Names last seen first; Recent stands in for a Connection not loaded since Contura started.
      const item = object(r.connectionId, t.object, t.path);
      add({ ...item, target: { kind: "recent", item: r } });
      id = item.id;
    } else if (t.kind === "query") {
      id = savedItemId(t.savedId);
      if (!items.has(id)) continue;
    } else {
      id = modelItemId(t.file);
      add({ id, kind: "model", name: fileName(t.file), qualifier: null, connection: connectionOf(r.connectionId), target: { kind: "recent", item: r } });
    }
    timeline.push({ at: r.openedAtMs, id });
  }
  const recentIds = [
    ...new Set(
      timeline
        .sort((a, b) => b.at - a.at)
        .map((x) => x.id)
        .filter((id) => id !== s.activeId),
    ),
  ];
  return { all: [...items.values()], recentIds };
}

export interface QuickRow {
  item: QuickItem;
  label: HighlightPart[];
  /** The qualifier with its matched letters, or the kind word. */
  description: HighlightPart[];
  /** The label of the section this row starts, if it starts one. */
  section: "recently opened" | "other results" | null;
}

const squash = (text: string) => text.trim().toLowerCase().replace(/\s+/g, "");

/** Quick Open's search over one list, made once when the box opens and asked on every key. */
export interface QuickSearch {
  rows(text: string): QuickRow[];
}

/**
 * The rows for the typed text: Recent first when the box is empty; while typing, Recent matches, then the best of
 * the rest by score, then shorter name, then kind, then name. Built for typing over the index's 20,000 names:
 * every name is folded and its word starts read once, each key only scores (no allocation per name), a longer
 * query searches only what the shorter one matched, only the best `MAX_RESULTS` are kept (a bounded heap, not a
 * sort of everything), and letters are marked only on the rows drawn.
 */
export function createQuickSearch(all: readonly QuickItem[], recentIds: readonly string[]): QuickSearch {
  const n = all.length;
  const folded: string[] = new Array(n);
  const targets: string[] = new Array(n);
  const nameFrom = new Int32Array(n);
  const kindRank = new Int8Array(n);
  const recentRank = new Int32Array(n).fill(-1);
  const startsAt = new Int32Array(n + 1);
  const recentAt = new Map(recentIds.map((id, i) => [id, i]));
  for (let i = 0; i < n; i++) {
    const item = all[i];
    const target = item.qualifier === null ? item.name : `${item.qualifier}.${item.name}`;
    targets[i] = target;
    folded[i] = foldCase(target);
    nameFrom[i] = item.qualifier === null ? 0 : item.qualifier.length + 1;
    kindRank[i] = KIND_ORDER.indexOf(item.kind);
    recentRank[i] = recentAt.get(item.id) ?? -1;
    startsAt[i + 1] = startsAt[i] + target.length;
  }
  const starts = new Uint8Array(startsAt[n]);
  for (let i = 0; i < n; i++) {
    const t = targets[i];
    for (let j = 0; j < t.length; j++) if (isWordStart(t, j)) starts[startsAt[i] + j] = 1;
  }
  const scorer = new FuzzyScorer();
  const scores = new Float64Array(n);
  // What the last query matched, so a longer one only looks there.
  let lastQuery: string | null = null;
  let lastHits = new Int32Array(0);

  /** Negative when item `a` ranks above item `b`. */
  const cmp = (a: number, b: number) => {
    const d = scores[b] - scores[a] || all[a].name.length - all[b].name.length || kindRank[a] - kindRank[b];
    if (d) return d;
    const x = all[a].name;
    const y = all[b].name;
    return x < y ? -1 : x > y ? 1 : 0;
  };

  function row(i: number, positions: number[], section: QuickRow["section"]): QuickRow {
    const item = all[i];
    const offset = nameFrom[i];
    return {
      item,
      label: highlightParts(item.name, offset, positions),
      description:
        item.qualifier === null ? [{ text: KIND_WORD[item.kind], hit: false }] : highlightParts(item.qualifier, 0, positions.filter((p) => p < offset - 1)),
      section,
    };
  }

  return {
    rows(text: string): QuickRow[] {
      const q = foldCase(squash(text));
      if (!q) {
        lastQuery = null;
        const byId = new Map(all.map((item, i) => [item.id, i]));
        return recentIds.flatMap((id, k) => {
          const i = byId.get(id);
          return i === undefined ? [] : [row(i, [], k === 0 ? "recently opened" : null)];
        });
      }
      const narrow = lastQuery !== null && q.startsWith(lastQuery);
      const count = narrow ? lastHits.length : n;
      const hits = new Int32Array(count);
      let found = 0;
      const recent: number[] = [];
      for (let c = 0; c < count; c++) {
        const i = narrow ? lastHits[c] : c;
        const score = scorer.score(q, folded[i], starts, startsAt[i], nameFrom[i]);
        if (Number.isNaN(score)) continue;
        scores[i] = score;
        hits[found++] = i;
        if (recentRank[i] >= 0) recent.push(i);
      }
      lastQuery = q;
      lastHits = hits.subarray(0, found);
      recent.sort((a, b) => cmp(a, b) || recentRank[a] - recentRank[b]);
      const keep = Math.max(0, MAX_RESULTS - recent.length);
      // The best `keep` of the rest: a heap whose top is the worst kept, so each newcomer costs log(keep).
      const heap: number[] = [];
      const worse = (a: number, b: number) => cmp(a, b) > 0;
      const up = (k: number) => {
        while (k > 0) {
          const p = (k - 1) >> 1;
          if (!worse(heap[k], heap[p])) break;
          [heap[k], heap[p]] = [heap[p], heap[k]];
          k = p;
        }
      };
      const down = (k: number) => {
        for (;;) {
          const l = 2 * k + 1;
          const r = l + 1;
          let m = k;
          if (l < heap.length && worse(heap[l], heap[m])) m = l;
          if (r < heap.length && worse(heap[r], heap[m])) m = r;
          if (m === k) return;
          [heap[k], heap[m]] = [heap[m], heap[k]];
          k = m;
        }
      };
      if (keep > 0) {
        for (let c = 0; c < found; c++) {
          const i = hits[c];
          if (recentRank[i] >= 0) continue;
          if (heap.length < keep) {
            heap.push(i);
            up(heap.length - 1);
          } else if (worse(heap[0], i)) {
            heap[0] = i;
            down(0);
          }
        }
      }
      const rest = heap.sort(cmp);
      const marks = (i: number) => fuzzyMatch(q, targets[i], nameFrom[i])?.positions ?? [];
      const out = recent.slice(0, MAX_RESULTS).map((i, k) => row(i, marks(i), k === 0 ? "recently opened" : null));
      rest.forEach((i, k) => out.push(row(i, marks(i), k === 0 && out.length > 0 ? "other results" : null)));
      return out;
    },
  };
}

/** The rows for one text over a list; a search made for one key (see `createQuickSearch`). */
export function quickRows(all: readonly QuickItem[], recentIds: readonly string[], text: string): QuickRow[] {
  return createQuickSearch(all, recentIds).rows(text);
}

/** A command the palette may list: it can run now, with its first key from the live keymap. */
export interface PaletteCommand {
  command: Command;
  keys: string | null;
  /** Dim text after the title, such as the Group a numbered Open Group opens. */
  note: string | null;
}

export interface PaletteRow {
  id: CommandId;
  /** "Category: Title". */
  text: string;
  label: HighlightPart[];
  keys: string | null;
  note: string | null;
  section: "recently used" | "other commands" | null;
}

/** The palette's rows for the text after `>`: recently used first, then the rest A to Z (by score while typing). */
export function paletteRows(commands: readonly PaletteCommand[], recentIds: readonly CommandId[], text: string): PaletteRow[] {
  const q = squash(text);
  const scored: { c: PaletteCommand; text: string; score: number; positions: number[] }[] = [];
  for (const c of commands) {
    const label = `${c.command.category}: ${c.command.title}`;
    const m = fuzzyMatch(q, label, c.command.category.length + 2);
    if (m) scored.push({ c, text: label, ...m });
  }
  const recent = recentIds.flatMap((id) => scored.filter((x) => x.c.command.id === id));
  const rest = scored.filter((x) => !recentIds.includes(x.c.command.id));
  rest.sort((a, b) => (q ? b.score - a.score : 0) || a.text.localeCompare(b.text));
  const row = (x: (typeof scored)[number], section: PaletteRow["section"]): PaletteRow => ({
    id: x.c.command.id,
    text: x.text,
    label: highlightParts(x.text, 0, x.positions),
    keys: x.c.keys,
    note: x.c.note,
    section,
  });
  const out = recent.map((x, i) => row(x, i === 0 ? "recently used" : null));
  rest.forEach((x, i) => out.push(row(x, i === 0 && out.length > 0 ? "other commands" : null)));
  return out;
}
