import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { AskTab, ConnectionId, TableRef } from "../api/types";

/**
 * What a tab tells the Ask about itself (spec 4): typed fields only; the Core renders the text.
 * `where` names the Ask's Connection and database when the screen chooses them itself (Compare's
 * target, Transfer's sides), since the window tab only holds where it started.
 */
export interface TabAskFields {
  tab: AskTab;
  sql?: string;
  filter?: string;
  dbml?: string;
  untiedModel?: boolean;
  tables?: TableRef[];
  also?: ConnectionId[];
  where?: { connectionId: ConnectionId | null; database: string | null; schema: string | null };
}

/** A published tab: a getter, not a copy of its state, and a count that changes when its state does. */
export interface TabAskEntry {
  rev: number;
  get(): TabAskFields | null;
}

/** One entry per mounted publisher, deleted on unmount, so the registry never outgrows the open tabs. */
const entries = new Map<string, TabAskEntry & { owner: object }>();
const listeners = new Map<string, Set<() => void>>();

function notify(key: string) {
  for (const l of [...(listeners.get(key) ?? [])]) l();
}

function subscribe(key: string, l: () => void): () => void {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(l);
  return () => {
    set.delete(l);
    if (set.size === 0 && listeners.get(key) === set) listeners.delete(key);
  };
}

/** The number of published tabs (and keys listened to), for the bound test. */
export function tabAskSize(): number {
  return entries.size + listeners.size;
}

/**
 * Publishes what tab `key` shows. `build` is read only when the Ask builds its request; `deps` are the
 * state it reads, and only a change there bumps `rev`, after `delayMs` of quiet when it is set. The entry goes
 * when the screen unmounts. A null key (a screen shown outside a tab) publishes nothing.
 */
export function usePublishTabAsk(key: string | null, build: () => TabAskFields | null, deps: unknown[], delayMs = 0): void {
  const buildRef = useRef(build);
  buildRef.current = build;
  const owner = useRef({}).current;
  useEffect(() => {
    if (key === null) return;
    return () => {
      if (entries.get(key)?.owner !== owner) return;
      entries.delete(key);
      notify(key);
    };
  }, [key, owner]);
  useEffect(() => {
    if (key === null) return;
    const bump = () => {
      const rev = (entries.get(key)?.rev ?? 0) + 1;
      entries.set(key, { rev, owner, get: () => buildRef.current() });
      notify(key);
    };
    // The first publish is at once; later ones wait for `delayMs` of quiet, so typing in a grid bumps once.
    if (delayMs <= 0 || entries.get(key)?.owner !== owner) {
      bump();
      return;
    }
    const timer = setTimeout(bump, delayMs);
    return () => clearTimeout(timer);
    // `deps` are the publisher's own state, spread so only a change there bumps the count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, owner, delayMs, ...deps]);
}

/** The published entry of `key`, or null; a new object each time its publisher bumps `rev`. */
export function useTabAsk(key: string | null): TabAskEntry | null {
  const sub = useCallback((l: () => void) => (key === null ? () => {} : subscribe(key, l)), [key]);
  return useSyncExternalStore(sub, () => (key === null ? null : (entries.get(key) ?? null)));
}
