import { expect, test } from "vitest";
import type { JobEvent, JobId, JobReport } from "../api/types";
import { SKIPPED_CAP, type JobView, jobReducer, percentOf } from "./jobStore";

const report: JobReport = {
  kind: "export",
  rowsRead: 86,
  rowsWritten: 86,
  statements: 0,
  skipped: 0,
  warnings: [],
  elapsedMs: 120,
  file: "C:\\out\\orders.csv",
  bytes: 9000,
  committed: 0,
  check: null,
};

function tracked(): Map<JobId, JobView> {
  return jobReducer(new Map(), {
    type: "track",
    id: "j1",
    kind: "export",
    label: "Exporting orders",
    connectionId: "c1",
    startedAt: 1000,
  });
}

const event = (e: JobEvent) => ({ type: "event" as const, id: "j1", event: e });

const progress = (rowsDone: number, rowsTotal: number | null, bytesDone = 0, bytesTotal: number | null = null): JobEvent => ({
  kind: "progress",
  phase: "writing",
  table: "orders",
  rowsDone,
  rowsTotal,
  bytesDone,
  bytesTotal,
  statementsDone: 0,
  fileRow: null,
});

test("track_adds_a_job_with_no_progress", () => {
  const s = tracked();
  const v = s.get("j1")!;
  expect(v).toMatchObject({
    id: "j1",
    kind: "export",
    label: "Exporting orders",
    connectionId: "c1",
    phase: null,
    rowsDone: 0,
    rowsTotal: null,
    bytesDone: 0,
    percent: null,
    startedAt: 1000,
    background: false,
    skipped: [],
    warnings: [],
    done: null,
  });
});

test("progress_gives_a_percent_rows_first_then_bytes", () => {
  let s = jobReducer(tracked(), event(progress(32, 100, 10, 1000)));
  expect(s.get("j1")!.percent).toBe(32);
  expect(s.get("j1")!.phase).toBe("writing");
  s = jobReducer(s, event(progress(32, null, 500, 1000)));
  expect(s.get("j1")!.percent).toBe(50);
  s = jobReducer(s, event(progress(32, null, 500, null)));
  expect(s.get("j1")!.percent).toBeNull();
  expect(percentOf({ rowsDone: 5, rowsTotal: 0, bytesDone: 0, bytesTotal: null })).toBe(100);
  expect(percentOf({ rowsDone: 150, rowsTotal: 100, bytesDone: 0, bytesTotal: null })).toBe(100);
});

test("finished_and_failed_set_done", () => {
  const s = jobReducer(tracked(), event({ kind: "finished", report }));
  expect(s.get("j1")!.done).toEqual({ report });
  const f = jobReducer(tracked(), event({ kind: "failed", error: { kind: "cancelled" } }));
  expect(f.get("j1")!.done).toEqual({ error: { kind: "cancelled" } });
});

test("warnings_gather_and_row_skipped_caps_at_1000", () => {
  let s = jobReducer(tracked(), event({ kind: "warning", message: "12 values were cut to 1 KB previews." }));
  expect(s.get("j1")!.warnings).toEqual(["12 values were cut to 1 KB previews."]);
  for (let i = 1; i <= SKIPPED_CAP + 5; i++) {
    s = jobReducer(s, event({ kind: "rowSkipped", fileRow: i, column: "price", message: "not a number" }));
  }
  const v = s.get("j1")!;
  expect(SKIPPED_CAP).toBe(1000);
  expect(v.skipped).toHaveLength(1000);
  expect(v.skipped[0]).toEqual({ fileRow: 1, column: "price", message: "not a number" });
  expect(v.skippedTotal).toBe(1005);
});

test("background_keeps_the_job_listed", () => {
  let s = jobReducer(tracked(), { type: "background", id: "j1" });
  expect(s.get("j1")!.background).toBe(true);
  s = jobReducer(s, event({ kind: "finished", report }));
  expect(s.has("j1")).toBe(true);
  s = jobReducer(s, { type: "remove", id: "j1" });
  expect(s.has("j1")).toBe(false);
});

test("events_for_an_untracked_job_change_nothing", () => {
  const s = tracked();
  expect(jobReducer(s, { type: "event", id: "nope", event: progress(1, 2) })).toBe(s);
});
