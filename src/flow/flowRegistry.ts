// What each open diagram tab tells the rest of the window: whether its save is done, still to come or failed
// (the tab's unsaved mark and the close guard), where you are typing and how many errors it has (the status
// bar), and how to write it now or drop what is unsaved (closing the tab or the window). One entry per tab
// instance, so a write that finishes after its tab closed never marks a tab opened again under the same name.
import { useSyncExternalStore } from "react";

/** A hold's release, with the moment a write already on its way has landed. */
export type FlowHold = (() => void) & { settled: Promise<void> };

export type FlowSaveKind = "saved" | "waiting" | "failed";

export interface FlowEntry {
  save: FlowSaveKind;
  /** Why the last save failed. */
  message?: string;
  /** 1-based, where you are typing in the text; null until the text is shown. */
  line: number | null;
  col: number | null;
  /** Errors only; hints are not counted. */
  errors: number;
  /** Writes what is waiting or failed now (and any save that comes due meanwhile); true once it is on disk. */
  flush(): Promise<boolean>;
  /** The user chose Discard: nothing more is written for this tab. */
  discard?(): void;
  /** True once discard() ran. */
  isDiscarded?(): boolean;
  /** True while a rename or delete of the file holds its writes (the close guard says so). */
  isHeld?(): boolean;
  /** A failed save left by a tab that already closed; an open tab of the same name comes first. */
  orphan?: boolean;
  /** What a save would write now: the text and the layout file (Save a copy as copies the tab, not the disk). */
  snapshot?(): { text: string; layout: string } | null;
  /**
   * Holds every write until the returned release runs; a save that came due meanwhile is written after it, even
   * when the tab closed meanwhile. `settled` resolves once a write already on its way has landed. `readOnly`
   * also keeps the text from being typed in until the release.
   */
  hold?(opts?: { readOnly?: boolean }): FlowHold;
}

/** The entry's removal; `update` changes this instance's entry only (a no-op once it is removed). */
export type FlowHandle = (() => void) & { update(part: Partial<FlowEntry>): void };

const live = new Map<symbol, { name: string; entry: FlowEntry }>();
const listeners = new Set<() => void>();
let unsavedSnapshot: ReadonlySet<string> = new Set();

function changed() {
  const unsaved = [...live.values()].filter((x) => x.entry.save !== "saved").map((x) => x.name);
  if (unsaved.length !== unsavedSnapshot.size || unsaved.some((n) => !unsavedSnapshot.has(n))) unsavedSnapshot = new Set(unsaved);
  for (const l of [...listeners]) l();
}

/**
 * The newest live instance for `name`; names are not case-sensitive (Windows: Checkout and checkout are one file).
 * An open tab comes before a failed save its closed tab left behind.
 */
function newest(name: string): symbol | undefined {
  const want = name.toLowerCase();
  let found: symbol | undefined;
  let orphan: symbol | undefined;
  for (const [id, x] of live) {
    if (x.name.toLowerCase() !== want) continue;
    if (x.entry.orphan) orphan = id;
    else found = id;
  }
  return found ?? orphan;
}

function updateId(id: symbol, part: Partial<FlowEntry>) {
  const x = live.get(id);
  if (!x) return;
  const keys = Object.keys(part) as (keyof FlowEntry)[];
  if (keys.every((k) => x.entry[k] === part[k])) return;
  live.set(id, { name: x.name, entry: { ...x.entry, ...part } });
  changed();
}

/** Adds a tab instance's entry; the handle removes it, and updates only it. */
export function registerFlow(name: string, entry: FlowEntry): FlowHandle {
  const id = Symbol(name);
  live.set(id, { name, entry });
  changed();
  const remove = (() => {
    if (live.delete(id)) changed();
  }) as FlowHandle;
  remove.update = (part) => updateId(id, part);
  return remove;
}

/**
 * A tab that closed while its writes were held (a rename or delete) writes what it still had on the release; when
 * that write fails, no tab is left to mark, so the failure joins the list as a failed save of its own (P24 M3): the
 * diagram counts as unsaved, and the close guard tries `retry` again and asks before the edits are dropped.
 * `retry` resolves to null once written, else to why it failed.
 */
export function registerOrphanFailure(name: string, message: string, retry: () => Promise<string | null>): void {
  const remove = registerFlow(name, {
    save: "failed",
    message,
    line: null,
    col: null,
    errors: 0,
    orphan: true,
    flush: async () => {
      const failed = await retry();
      if (failed === null) remove();
      else remove.update({ message: failed });
      return failed === null;
    },
    discard: () => remove(),
    isDiscarded: () => false,
  });
}

/** Updates the newest open tab of `name`. */
export function updateFlow(name: string, part: Partial<FlowEntry>) {
  const id = newest(name);
  if (id) updateId(id, part);
}

export function flowEntry(name: string): FlowEntry | undefined {
  const id = newest(name);
  return id ? live.get(id)?.entry : undefined;
}

/** The diagrams whose save is still to come or failed. */
export function unsavedFlows(): string[] {
  return [...unsavedSnapshot];
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useFlowEntry(name: string): FlowEntry | undefined {
  return useSyncExternalStore(subscribe, () => flowEntry(name));
}

export function useUnsavedFlows(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => unsavedSnapshot);
}
