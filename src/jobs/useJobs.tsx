import { type ReactNode, createContext, useCallback, useContext, useMemo, useReducer, useRef } from "react";
import { cancelJob } from "../api/jobs";
import type { ConnectionId, JobEvent, JobId, JobKind } from "../api/types";
import { type JobView, jobReducer } from "./jobStore";

type Watcher = (e: JobEvent) => void;

export interface JobsValue {
  /** Every job this window tracks, oldest first. */
  jobs: JobView[];
  /**
   * Starts tracking job `id` and returns the `onEvent` to pass to the start call. Call it
   * before the start, with the id from `newJobId`, so no event is lost. When the start call
   * rejects (`fileExists`, `jobBusy`, the job limit), call `dismiss(id)`: the job never ran.
   */
  track(id: JobId, kind: JobKind, label: string, connectionId: ConnectionId, subject?: string): (e: JobEvent) => void;
  /** Calls `fn` with each later event of `id`; returns the unsubscribe. */
  watch(id: JobId, fn: Watcher): () => void;
  /** Run in the background: the job stays listed after its dialog closes. */
  background(id: JobId): void;
  cancel(id: JobId): Promise<void>;
  /** Drops an ended job from the list. */
  dismiss(id: JobId): void;
}

const JobsContext = createContext<JobsValue | null>(null);

/** The one holder of the jobs this window watches, for the dialogs and the status bar. */
export function JobsProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(jobReducer, new Map<JobId, JobView>());
  const watchers = useRef(new Map<JobId, Set<Watcher>>());

  const track = useCallback((id: JobId, kind: JobKind, label: string, connectionId: ConnectionId, subject?: string) => {
    dispatch({ type: "track", id, kind, label, connectionId, startedAt: Date.now(), subject });
    return (event: JobEvent) => {
      dispatch({ type: "event", id, event });
      for (const fn of watchers.current.get(id) ?? []) fn(event);
    };
  }, []);

  const watch = useCallback((id: JobId, fn: Watcher) => {
    const set = watchers.current.get(id) ?? new Set<Watcher>();
    set.add(fn);
    watchers.current.set(id, set);
    return () => {
      set.delete(fn);
      if (set.size === 0) watchers.current.delete(id);
    };
  }, []);

  const background = useCallback((id: JobId) => dispatch({ type: "background", id }), []);
  const cancel = useCallback((id: JobId) => cancelJob(id), []);
  const dismiss = useCallback((id: JobId) => {
    watchers.current.delete(id);
    dispatch({ type: "remove", id });
  }, []);

  const value = useMemo<JobsValue>(
    () => ({
      jobs: [...state.values()].sort((a, b) => a.startedAt - b.startedAt),
      track,
      watch,
      background,
      cancel,
      dismiss,
    }),
    [state, track, watch, background, cancel, dismiss],
  );
  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>;
}

export function useJobs(): JobsValue {
  const value = useContext(JobsContext);
  if (!value) throw new Error("useJobs needs a JobsProvider above it");
  return value;
}
