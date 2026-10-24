import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { connectionForgotten } from "../api/changes";
import type { ConnectionId, StepIn, StepVerb } from "../api/types";
import { type AnyTab, tabKey } from "../shell/tabs";

/**
 * Recent steps (spec 7): what the user did since their last question in a place, as typed steps, never free text.
 * In memory only, never written to disk; the Core renders and gates their labels.
 */
export interface RecentStep extends StepIn {
  /** Counts every step stored, so an Ask removes only the steps it carried. */
  seq: number;
}

/** A step as a screen records it; the store adds its time. */
export type RecentStepInput = Omit<StepIn, "at">;

export const STEPS_PER_PLACE = 10;
export const PLACES_KEPT = 8;
/** The Topic idle rule: older steps are not read. */
export const STEP_IDLE_MS = 30 * 60_000;
/** The names a step keeps; the rest count into `more`, as the Core shows them. */
const STEP_NAMES = 6;
/** The most characters of one name, as the Core cuts them. */
const NAME_CHARS = 128;

/** Verbs whose names are a plain list that adds up while the user keeps at it: ticking columns, adding tables or filters. */
const UNION: ReadonlySet<StepVerb> = new Set(["vqTable", "vqTableOff", "vqTick", "vqUntick", "vqFilter"]);
/** Verbs whose names are read by position (the left and the right table): each is its own step. */
const NEVER_MERGED: ReadonlySet<StepVerb> = new Set(["vqJoin"]);

const EMPTY: RecentStep[] = [];
/** One ring per place, least recently recorded first. */
const rings = new Map<string, RecentStep[]>();
const listeners = new Map<string, Set<() => void>>();
let seq = 0;

function notify(place: string) {
  for (const l of [...(listeners.get(place) ?? [])]) l();
}

function subscribe(place: string, l: () => void): () => void {
  let set = listeners.get(place);
  if (!set) listeners.set(place, (set = new Set()));
  set.add(l);
  return () => {
    set.delete(l);
    if (set.size === 0 && listeners.get(place) === set) listeners.delete(place);
  };
}

/**
 * Names kept as the Core shows them: six at most, each cut at 128 characters; the rest are counted. Order and repeats
 * stay, since the Core reads some by position (a self-join, a transfer of a table named as its database); `unique`
 * drops repeats, for the plain lists a merge adds up.
 */
function capNames(names: readonly string[], more: number, unique = false): { names?: string[]; more?: number } {
  const cut = names.map((n) => [...n].slice(0, NAME_CHARS).join(""));
  const all = unique ? [...new Set(cut)] : cut;
  const kept = all.slice(0, STEP_NAMES);
  const extra = more + all.length - kept.length;
  return { ...(kept.length > 0 && { names: kept }), ...(extra > 0 && { more: extra }) };
}

/** Only the typed fields go in, whatever the caller passed. */
function clean(s: RecentStepInput, at: number): StepIn {
  return {
    at,
    verb: s.verb,
    tab: s.tab,
    title: s.title,
    connectionId: s.connectionId,
    database: s.database,
    schema: s.schema,
    count: s.count,
    ...capNames(s.names ?? [], s.more ?? 0),
    ...(s.hasMore && { hasMore: true }),
    ...(s.failed && { failed: true }),
    ...(s.descending && { descending: true }),
    ...(s.sourceConnectionId != null && { sourceConnectionId: s.sourceConnectionId }),
  };
}

/** Same tab: its kind, title and place. */
const sameTab = (a: StepIn, b: StepIn) =>
  a.tab === b.tab && a.title === b.title && a.connectionId === b.connectionId && a.database === b.database && a.schema === b.schema;
/** The object a step is about: a grid's table, a designed table. */
const sameObject = (a: StepIn, b: StepIn) => (a.names?.[0] ?? null) === (b.names?.[0] ?? null);

/** The newest step after `next` arrives: merged into `last`, or null when `next` is its own step. */
function merged(last: RecentStep, next: StepIn): StepIn | "drop" | null {
  // Opening a tab shows it: the open says it all.
  if (next.verb === "showTab" && last.verb === "openTab" && sameTab(last, next) && sameObject(last, next)) return "drop";
  // Only the last tab gone to counts.
  if (next.verb === "showTab" && last.verb === "showTab") return next;
  if (NEVER_MERGED.has(next.verb)) return null;
  if (next.verb !== last.verb || !sameTab(last, next) || (next.sourceConnectionId ?? null) !== (last.sourceConnectionId ?? null)) return null;
  if (!UNION.has(next.verb)) return sameObject(last, next) ? next : null;
  const { names, more } = capNames([...(last.names ?? []), ...(next.names ?? [])], (last.more ?? 0) + (next.more ?? 0), true);
  const { names: _n, more: _m, ...rest } = next;
  return { ...rest, ...(names && { names }), ...(more && { more }) };
}

/** Records a step in `place`'s ring; at most 10 per place and 8 places. */
export function recordStep(place: string, step: RecentStepInput, now: number = Date.now()): void {
  const next = clean(step, now);
  const ring = rings.get(place) ?? EMPTY;
  const last = ring[ring.length - 1];
  const m = last ? merged(last, next) : null;
  if (m === "drop") return;
  const out = m ? [...ring.slice(0, -1), { ...m, seq: ++seq }] : [...ring, { ...next, seq: ++seq }];
  rings.delete(place);
  rings.set(place, out.length > STEPS_PER_PLACE ? out.slice(-STEPS_PER_PLACE) : out);
  while (rings.size > PLACES_KEPT) {
    const oldest = rings.keys().next().value as string;
    rings.delete(oldest);
    notify(oldest);
  }
  notify(place);
}

const fresh = (now: number) => (s: RecentStep) => now - s.at <= STEP_IDLE_MS;

/** The place's steps, oldest first; idle ones are left out. */
export function stepsOf(place: string, now: number = Date.now()): RecentStep[] {
  return (rings.get(place) ?? EMPTY).filter(fresh(now));
}

/** Removes the steps an Ask carried (`seq <= upToSeq`); steps made while it streamed stay. */
export function takeSteps(place: string, upToSeq: number): void {
  const ring = rings.get(place);
  if (!ring) return;
  const left = ring.filter((s) => s.seq > upToSeq);
  if (left.length === ring.length) return;
  if (left.length === 0) rings.delete(place);
  else rings.set(place, left);
  notify(place);
}

export function clearSteps(place: string): void {
  if (rings.delete(place)) notify(place);
}

/** Every place's steps go (Clear all AI data). */
export function clearAllSteps(): void {
  const places = [...rings.keys()];
  rings.clear();
  for (const p of places) notify(p);
}

/**
 * Drops the steps on `id` (its own, and those that name it as a Compare or Transfer source) from every place; null
 * drops every step on any Connection. Steps on no Connection stay.
 */
export function forgetConnectionSteps(id: ConnectionId | null): void {
  const on = (c: ConnectionId | null | undefined) => c != null && (id === null || c === id);
  for (const [place, ring] of [...rings]) {
    const left = ring.filter((s) => !on(s.connectionId) && !on(s.sourceConnectionId));
    if (left.length === ring.length) continue;
    if (left.length === 0) rings.delete(place);
    else rings.set(place, left);
    notify(place);
  }
}

// One listener for the life of the app: a Connection's history cleared, or the Connection deleted.
connectionForgotten.on(forgetConnectionSteps);

/** Every stored step, for the bound test. */
export function stepsSize(): number {
  let n = 0;
  for (const r of rings.values()) n += r.length;
  return n;
}

/** The place's steps as they change; an idle step leaves when it turns idle. */
export function useRecentSteps(place: string): RecentStep[] {
  const sub = useCallback((l: () => void) => subscribe(place, l), [place]);
  const ring = useSyncExternalStore(sub, () => rings.get(place) ?? EMPTY);
  const [tick, setTick] = useState(0);
  const shown = useMemo(() => {
    void tick;
    const now = Date.now();
    return ring.every(fresh(now)) ? ring : ring.filter(fresh(now));
  }, [ring, tick]);
  useEffect(() => {
    if (shown.length === 0) return;
    const oldest = Math.min(...shown.map((s) => s.at));
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, oldest + STEP_IDLE_MS - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [shown]);
  return shown;
}

/** The place screens record into; App binds it to the place shown. Outside it nothing is recorded. */
export const RecordStepContext = createContext<string | null>(null);

/** Records a step in the place shown. */
export function useRecordStep(): (step: RecentStepInput) => void {
  const place = useContext(RecordStepContext);
  return useCallback(
    (step: RecentStepInput) => {
      if (place !== null) recordStep(place, step);
    },
    [place],
  );
}

/** What a tab is, as a step: its kind, the title the user gave it, where it is and the object it shows. */
function tabFacts(t: AnyTab): Omit<RecentStepInput, "verb"> | null {
  const none = { title: null, connectionId: null, database: null, schema: null, count: null };
  switch (t.kind) {
    case "flow":
      return null;
    case "home":
    case "settings":
    case "savedQueries":
      return { tab: t.kind, ...none };
    case "query":
    case "visual":
      return { tab: t.kind, title: t.doc.name, connectionId: t.doc.connectionId, database: t.doc.database, schema: null, count: null };
    case "object": {
      const p = t.selection.path;
      return { tab: "object", title: null, connectionId: t.selection.connectionId, database: p.database, schema: p.schema, names: [p.name], count: null };
    }
    case "lineage":
      return { tab: "lineage", title: null, connectionId: t.connectionId, database: t.path.database, schema: t.path.schema, names: [t.path.name], count: null };
    case "design":
      return t.target.kind === "create"
        ? { tab: "newTable", title: null, connectionId: t.connectionId, database: t.target.scope.database, schema: t.target.scope.schema, count: null }
        : { tab: "design", title: null, connectionId: t.connectionId, database: t.target.path.database, schema: t.target.path.schema, names: [t.target.path.name], count: null };
    case "import":
      return t.target.kind === "table"
        ? { tab: "import", title: null, connectionId: t.connectionId, database: t.target.path.database, schema: t.target.path.schema, names: [t.target.path.name], count: null }
        : { tab: "import", title: null, connectionId: t.connectionId, database: t.target.database, schema: null, count: null };
    case "schema":
      // The model file's base name is a title the user gave; the Core sends it at the higher level only.
      return { tab: "schema", title: t.doc.path ? baseName(t.doc.path) : null, connectionId: t.doc.connectionId, database: null, schema: null, count: null };
    case "compare":
      // The tab's title names both Connections, so only the target goes: the step is on its Connection.
      return { tab: "compare", title: null, connectionId: t.connectionId, database: t.seed.target?.database ?? null, schema: null, count: null };
    case "transfer":
      return { tab: "transfer", title: null, connectionId: t.seed.connectionId, database: t.seed.database, schema: t.seed.schema, count: null };
  }
}

/** A path's last part, whichever separator it uses. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * The steps a change of the tab strip makes: `openTab` for each new key, `showTab` when an open tab becomes active.
 * Closing a tab is no step, nor is anything in a diagram tab.
 */
export function tabSteps(prevKeys: readonly string[], prevActive: string | null, tabs: readonly AnyTab[], active: string | null): RecentStepInput[] {
  const before = new Set(prevKeys);
  const out: RecentStepInput[] = [];
  for (const t of tabs) {
    if (before.has(tabKey(t))) continue;
    const facts = tabFacts(t);
    if (facts) out.push({ verb: "openTab", ...facts });
  }
  if (active !== null && active !== prevActive && before.has(active)) {
    const t = tabs.find((x) => tabKey(x) === active);
    const facts = t ? tabFacts(t) : null;
    if (facts) out.push({ verb: "showTab", ...facts });
  }
  return out;
}
