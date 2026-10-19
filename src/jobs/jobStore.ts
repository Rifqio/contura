import type { CommandError, ConnectionId, JobEvent, JobId, JobKind, JobPhase, JobReport } from "../api/types";

/** The skipped-rows list keeps the first 1,000; `skippedTotal` counts them all. */
export const SKIPPED_CAP = 1000;

export interface SkippedRow {
  fileRow: number;
  column: string | null;
  message: string;
}

/** What the UI knows of one job, built from its events. */
export interface JobView {
  id: JobId;
  kind: JobKind;
  label: string;
  connectionId: ConnectionId;
  /** What the job is about, kept for its end text (a Backup's or Restore's source database). */
  subject?: string;
  /** The last progress event as sent, for views that show more than the counters (step 9). */
  last?: Extract<JobEvent, { kind: "progress" }> | null;
  /** null until the first progress event. */
  phase: JobPhase | null;
  rowsDone: number;
  rowsTotal: number | null;
  bytesDone: number;
  bytesTotal: number | null;
  statementsDone: number;
  percent: number | null;
  /** Epoch ms. */
  startedAt: number;
  /** Run in the background: its dialog closed, the status bar shows it. */
  background: boolean;
  skipped: SkippedRow[];
  skippedTotal: number;
  warnings: string[];
  done: { report: JobReport } | { error: CommandError } | null;
}

export type JobAction =
  | { type: "track"; id: JobId; kind: JobKind; label: string; connectionId: ConnectionId; startedAt: number; subject?: string }
  | { type: "event"; id: JobId; event: JobEvent }
  | { type: "background"; id: JobId }
  | { type: "remove"; id: JobId };

type Counts = Pick<JobView, "rowsDone" | "rowsTotal" | "bytesDone" | "bytesTotal">;

/** Rows first, then bytes; null when neither total is known. */
export function percentOf(v: Counts): number | null {
  const of = (done: number, total: number) => (total <= 0 ? 100 : Math.min(100, Math.floor((done / total) * 100)));
  if (v.rowsTotal !== null) return of(v.rowsDone, v.rowsTotal);
  if (v.bytesTotal !== null) return of(v.bytesDone, v.bytesTotal);
  return null;
}

function applyEvent(v: JobView, e: JobEvent): JobView {
  switch (e.kind) {
    case "progress": {
      const next = {
        ...v,
        phase: e.phase,
        rowsDone: e.rowsDone,
        rowsTotal: e.rowsTotal,
        bytesDone: e.bytesDone,
        bytesTotal: e.bytesTotal,
        statementsDone: e.statementsDone,
        last: e,
      };
      return { ...next, percent: percentOf(next) };
    }
    case "warning":
      return { ...v, warnings: [...v.warnings, e.message] };
    case "rowSkipped": {
      const row = { fileRow: e.fileRow, column: e.column, message: e.message };
      const skipped = v.skipped.length < SKIPPED_CAP ? [...v.skipped, row] : v.skipped;
      return { ...v, skipped, skippedTotal: v.skippedTotal + 1 };
    }
    case "finished":
      return { ...v, done: { report: e.report } };
    case "failed":
      return { ...v, done: { error: e.error } };
  }
}

/** The jobs this window watches, by id. Unknown ids leave the state as it is. */
export function jobReducer(state: Map<JobId, JobView>, a: JobAction): Map<JobId, JobView> {
  if (a.type === "track") {
    const next = new Map(state);
    next.set(a.id, {
      id: a.id,
      kind: a.kind,
      label: a.label,
      connectionId: a.connectionId,
      ...(a.subject !== undefined && { subject: a.subject }),
      last: null,
      phase: null,
      rowsDone: 0,
      rowsTotal: null,
      bytesDone: 0,
      bytesTotal: null,
      statementsDone: 0,
      percent: null,
      startedAt: a.startedAt,
      background: false,
      skipped: [],
      skippedTotal: 0,
      warnings: [],
      done: null,
    });
    return next;
  }
  const v = state.get(a.id);
  if (!v) return state;
  const next = new Map(state);
  switch (a.type) {
    case "event":
      next.set(a.id, applyEvent(v, a.event));
      break;
    case "background":
      next.set(a.id, { ...v, background: true });
      break;
    case "remove":
      next.delete(a.id);
      break;
  }
  return next;
}
