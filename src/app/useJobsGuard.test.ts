import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { createElement, Fragment } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { ConnectionConfig, JobEvent, JobId, JobKind } from "../api/types";
import type { JobView } from "../jobs/jobStore";
import { type JobsGuardJobs, leaveLine, useJobsGuard } from "./useJobsGuard";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(cleanup);

function conn(id: string, name: string): ConnectionConfig {
  return {
    id,
    name,
    dialect: "postgres",
    host: "127.0.0.1",
    port: 5432,
    user: "u",
    database: "shop",
    ssl: { mode: "disable" },
    file: null,
    queryTimeoutSecs: null,
    aiAccess: "schema",
    production: false,
    readOnly: false,
    groupId: null,
  };
}
const connections = [conn("c1", "Shop"), conn("c2", "Archive")];

function job(id: JobId, kind: JobKind, label: string, connectionId: string, ended = false): JobView {
  return {
    id,
    kind,
    label,
    connectionId,
    phase: null,
    rowsDone: 0,
    rowsTotal: null,
    bytesDone: 0,
    bytesTotal: null,
    statementsDone: 0,
    percent: null,
    startedAt: 0,
    background: false,
    skipped: [],
    skippedTotal: 0,
    warnings: [],
    done: ended ? { error: { kind: "cancelled" } as never } : null,
  };
}

/** A fake job holder: cancel ends the job at once with Cancelled, as the Core does. */
function fakeJobs(list: JobView[]): JobsGuardJobs & { cancel: ReturnType<typeof vi.fn> } {
  const watchers = new Map<JobId, (e: JobEvent) => void>();
  return {
    jobs: list,
    watch: (id, fn) => {
      watchers.set(id, fn);
      return () => watchers.delete(id);
    },
    cancel: vi.fn(async (id: JobId) => {
      watchers.get(id)?.({ kind: "failed", error: { kind: "cancelled" } } as unknown as JobEvent);
    }),
  };
}

function setup(list: JobView[]) {
  const jobs = fakeJobs(list);
  const hook = renderHook(() => useJobsGuard({ jobs, connections }));
  const view = render(createElement(Fragment, null, hook.result.current.dialog));
  const redraw = () => view.rerender(createElement(Fragment, null, hook.result.current.dialog));
  return { jobs, hook, redraw };
}

test("leave_lines_follow_q17", () => {
  expect(leaveLine(job("1", "import", "Importing into menu_items", "c1"), connections)).toBe(
    "Import into menu_items is running on Shop",
  );
  expect(leaveLine(job("2", "export", "Exporting orders", "c1"), connections)).toBe("Export of orders is running");
  expect(leaveLine(job("3", "export", "Exporting the query result", "c2"), connections)).toBe(
    "Export of the query result is running",
  );
  expect(leaveLine(job("4", "scriptImport", "Importing dump.sql", "c2"), connections)).toBe(
    "Import of dump.sql is running on Archive",
  );
});

test("nothing_running_closes_without_asking", async () => {
  const { hook } = setup([job("1", "import", "Importing into menu_items", "c1", true)]);
  await expect(hook.result.current.confirmStop()).resolves.toBe(true);
  await expect(hook.result.current.confirmStop("c1")).resolves.toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("closing_a_connection_asks_about_its_import_and_cancels_on_yes", async () => {
  const { jobs, hook, redraw } = setup([job("j1", "import", "Importing into menu_items", "c1")]);
  let answer: Promise<boolean> = Promise.resolve(false);
  act(() => {
    answer = hook.result.current.confirmStop("c1");
  });
  redraw();
  expect(screen.getByText("Import into menu_items is running on Shop. Cancel it?")).toBeTruthy();
  await act(async () => screen.getByRole("button", { name: "Cancel the job" }).click());
  await expect(answer).resolves.toBe(true);
  expect(jobs.cancel).toHaveBeenCalledWith("j1");
});

test("keep_running_leaves_the_job_and_refuses_the_close", async () => {
  const { jobs, hook, redraw } = setup([job("j1", "export", "Exporting orders", "c1")]);
  let answer: Promise<boolean> = Promise.resolve(true);
  act(() => {
    answer = hook.result.current.confirmStop();
  });
  redraw();
  expect(screen.getByText("Export of orders is running. Cancel it?")).toBeTruthy();
  await act(async () => screen.getByRole("button", { name: /Keep running/ }).click());
  await expect(answer).resolves.toBe(false);
  expect(jobs.cancel).not.toHaveBeenCalled();
});

test("another_connections_jobs_are_not_asked_about", async () => {
  const { hook } = setup([job("j1", "import", "Importing into menu_items", "c1")]);
  await expect(hook.result.current.confirmStop("c2")).resolves.toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("quitting_with_two_jobs_lists_both_and_cancels_both", async () => {
  const { jobs, hook, redraw } = setup([
    job("j1", "import", "Importing into menu_items", "c1"),
    job("j2", "export", "Exporting orders", "c2"),
  ]);
  let answer: Promise<boolean> = Promise.resolve(false);
  act(() => {
    answer = hook.result.current.confirmStop();
  });
  redraw();
  expect(screen.getByText("Import into menu_items is running on Shop.")).toBeTruthy();
  expect(screen.getByText("Export of orders is running.")).toBeTruthy();
  expect(screen.getByText("Cancel them?")).toBeTruthy();
  await act(async () => screen.getByRole("button", { name: "Cancel the jobs" }).click());
  await expect(answer).resolves.toBe(true);
  expect(jobs.cancel.mock.calls.map((c) => c[0])).toEqual(["j1", "j2"]);
});

test("closing_a_running_import_tab_asks_to_roll_back", async () => {
  const { jobs, hook, redraw } = setup([job("j1", "import", "Importing into menu_items", "c1")]);
  let answer: Promise<boolean> = Promise.resolve(false);
  act(() => {
    answer = hook.result.current.confirmCloseImport("j1");
  });
  redraw();
  expect(screen.getByRole("dialog", { name: "Cancel the import and roll back?" })).toBeTruthy();
  await act(async () => screen.getByRole("button", { name: "Cancel and roll back" }).click());
  await expect(answer).resolves.toBe(true);
  expect(jobs.cancel).toHaveBeenCalledWith("j1");
});

test("an_import_tab_with_only_a_mapping_closes_without_asking", async () => {
  const { hook } = setup([job("j1", "import", "Importing into menu_items", "c1", true)]);
  await expect(hook.result.current.confirmCloseImport(null)).resolves.toBe(true);
  // An ended import (its result on screen) closes at once too.
  await expect(hook.result.current.confirmCloseImport("j1")).resolves.toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("jobs_running_reports_any_unended_job", () => {
  expect(setup([job("j1", "export", "Exporting orders", "c1", true)]).hook.result.current.running()).toBe(false);
  cleanup();
  expect(setup([job("j1", "export", "Exporting orders", "c1")]).hook.result.current.running()).toBe(true);
});

test("a_yes_never_waits_past_5s_even_when_cancel_job_hangs_q43_i2", async () => {
  vi.useFakeTimers();
  try {
    const list = [job("j1", "import", "Importing into menu_items", "c1"), job("j2", "export", "Exporting orders", "c2")];
    const cancel = vi.fn((_id: JobId) => new Promise<void>(() => {}));
    const jobs: JobsGuardJobs = { jobs: list, watch: () => () => {}, cancel };
    const hook = renderHook(() => useJobsGuard({ jobs, connections }));
    render(createElement(Fragment, null, hook.result.current.dialog));
    let answer: Promise<boolean> = Promise.resolve(false);
    act(() => {
      answer = hook.result.current.confirmStop();
    });
    cleanup();
    render(createElement(Fragment, null, hook.result.current.dialog));
    let done = false;
    act(() => screen.getByRole("button", { name: "Cancel the jobs" }).click());
    void answer.then(() => (done = true));
    // Both cancels are sent at once, not one after the other.
    await act(async () => {
      await Promise.resolve();
    });
    expect(cancel.mock.calls.map((c) => c[0])).toEqual(["j1", "j2"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(done).toBe(true);
    await expect(answer).resolves.toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("two_jobs_with_the_same_line_render_both_without_a_key_clash", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const { hook, redraw } = setup([job("j1", "export", "Exporting orders", "c1"), job("j2", "export", "Exporting orders", "c1")]);
  act(() => {
    void hook.result.current.confirmStop();
  });
  redraw();
  expect(screen.getAllByText("Export of orders is running.")).toHaveLength(2);
  expect(error.mock.calls.some((c) => String(c[0]).includes("same key"))).toBe(false);
  error.mockRestore();
});

test("closing_a_running_transfer_tab_asks_to_roll_back", async () => {
  const { jobs, hook, redraw } = setup([job("t1", "transfer", "Copying 6 tables to analytics", "c1")]);
  expect(leaveLine(job("t1", "transfer", "Copying 6 tables to analytics", "c1"), [])).toBe("Transfer to its Connection is running");
  let answer: Promise<boolean> = Promise.resolve(false);
  act(() => {
    answer = hook.result.current.confirmCloseTransfer("t1");
  });
  redraw();
  expect(screen.getByRole("dialog", { name: "Cancel the transfer and roll back?" })).toBeTruthy();
  await act(async () => screen.getByRole("button", { name: "Cancel and roll back" }).click());
  await expect(answer).resolves.toBe(true);
  expect(jobs.cancel).toHaveBeenCalledWith("t1");
  // A transfer only set up closes at once.
  await expect(hook.result.current.confirmCloseTransfer(null)).resolves.toBe(true);
});
