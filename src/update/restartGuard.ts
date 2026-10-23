/**
 * What an update's restart asks about first. The App registers the window's unsaved work
 * (Pending Edits, unsaved Saved Queries and Visual Queries, diagrams still saving, running
 * jobs); Settings > Updates asks before it restarts.
 */
export interface RestartGuard {
  /** One line per unsaved thing, such as "Pending Edits in orders"; empty when nothing is. */
  pending(): string[];
  /** Asks Save or Discard for each one; false when one is cancelled or a save failed. */
  resolve(): Promise<boolean>;
  /** Writes now what a restart keeps anyway (the open query tabs). */
  flush(): Promise<void>;
}

const NONE: RestartGuard = {
  pending: () => [],
  resolve: () => Promise.resolve(true),
  flush: () => Promise.resolve(),
};

let current: RestartGuard = NONE;

/** Registers the guard; the returned function removes it. */
export function setRestartGuard(guard: RestartGuard): () => void {
  current = guard;
  return () => {
    if (current === guard) current = NONE;
  };
}

export function restartGuard(): RestartGuard {
  return current;
}
