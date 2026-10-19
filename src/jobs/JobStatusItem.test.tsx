import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { JobReport } from "../api/types";
import { ToastProvider } from "../components/Toast";
import JobStatusItem from "./JobStatusItem";
import type { JobView } from "./jobStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));

function job(over: Partial<JobView> = {}): JobView {
  return {
    id: "j1",
    kind: "export",
    label: "Exporting orders",
    connectionId: "c1",
    phase: "writing",
    rowsDone: 412_000,
    rowsTotal: 1_284_339,
    bytesDone: 0,
    bytesTotal: null,
    statementsDone: 0,
    percent: 32,
    startedAt: 0,
    background: true,
    skipped: [],
    skippedTotal: 0,
    warnings: [],
    done: null,
    ...over,
  };
}

test("nothing_shows_without_running_jobs", () => {
  const { container } = render(<JobStatusItem jobs={[]} onOpen={() => {}} />);
  expect(container.textContent).toBe("");
});

test("one_job_shows_its_status_and_opens_on_click", async () => {
  const onOpen = vi.fn();
  render(<JobStatusItem jobs={[job()]} onOpen={onOpen} />);
  await userEvent.click(screen.getByRole("button", { name: "Exporting orders, 32 percent" }));
  expect(onOpen).toHaveBeenCalledWith("j1");
});

test("two_jobs_show_a_count_with_a_menu_of_each", async () => {
  const onOpen = vi.fn();
  const second = job({ id: "j2", label: "Exporting stores", percent: null, rowsTotal: null, bytesDone: 3 * 1024 * 1024 });
  render(<JobStatusItem jobs={[job(), second]} onOpen={onOpen} />);
  await userEvent.click(screen.getByRole("button", { name: "2 jobs running" }));
  const menu = screen.getByRole("menu");
  const items = within(menu).getAllByRole("menuitem").map((m) => m.getAttribute("aria-label"));
  expect(items).toEqual(["Exporting orders, 32 percent", "Exporting stores, 3 MB"]);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Exporting stores, 3 MB" }));
  expect(onOpen).toHaveBeenCalledWith("j2");
});

test("ended_jobs_are_not_counted", () => {
  const report: JobReport = {
    kind: "export",
    rowsRead: 5,
    rowsWritten: 5,
    statements: 0,
    skipped: 0,
    warnings: [],
    elapsedMs: 10,
    file: "E:\\x\\a.csv",
    bytes: 10,
    committed: 0,
    check: null,
  };
  render(<JobStatusItem jobs={[job(), job({ id: "j2", done: { report } })]} onOpen={() => {}} />);
  expect(screen.getByRole("button", { name: "Exporting orders, 32 percent" })).toBeTruthy();
});

test("a_background_export_that_ends_shows_the_toast_once", async () => {
  const onEnded = vi.fn();
  const report: JobReport = {
    kind: "export",
    rowsRead: 1_284_339,
    rowsWritten: 1_284_339,
    statements: 0,
    skipped: 0,
    warnings: [],
    elapsedMs: 10,
    file: "E:\\Exports\\orders-oct.ndjson",
    bytes: 10,
    committed: 0,
    check: null,
  };
  const ended = job({ done: { report } });
  const { rerender } = render(
    <ToastProvider>
      <JobStatusItem jobs={[ended]} onOpen={() => {}} onEnded={onEnded} />
    </ToastProvider>,
  );
  expect(await screen.findByText("Exported 1,284,339 rows to orders-oct.ndjson")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open folder" })).toBeTruthy();
  rerender(
    <ToastProvider>
      <JobStatusItem jobs={[ended]} onOpen={() => {}} onEnded={onEnded} />
    </ToastProvider>,
  );
  expect(onEnded).toHaveBeenCalledTimes(1);
  expect(onEnded).toHaveBeenCalledWith("j1");
});

test("a_background_failure_reads_in_its_connections_dialect_m6", async () => {
  const failed = job({ done: { error: { kind: "connect", message: "unable to open database file" } } });
  render(
    <ToastProvider>
      <JobStatusItem jobs={[failed]} onOpen={() => {}} dialectOf={(id) => (id === "c1" ? "sqlite" : undefined)} />
    </ToastProvider>,
  );
  // The SQLite wording, not "Check the host and port".
  const toast = await screen.findByText(/unable to open database file/i);
  expect(toast.textContent).not.toMatch(/host and port/);
});

test("an_import_job_shows_the_import_icon", () => {
  const { container } = render(<JobStatusItem jobs={[job({ kind: "import", label: "Importing orders" })]} onOpen={() => {}} />);
  expect(container.querySelector("button")?.innerHTML).toContain("M12 3v12");
});

test("a_report_without_a_file_names_no_empty_file", async () => {
  const report: JobReport = {
    kind: "export",
    rowsRead: 3,
    rowsWritten: 3,
    statements: 0,
    skipped: 0,
    warnings: [],
    elapsedMs: 10,
    file: null,
    bytes: 10,
    committed: 0,
    check: null,
  };
  render(
    <ToastProvider>
      <JobStatusItem jobs={[job({ done: { report } })]} onOpen={() => {}} />
    </ToastProvider>,
  );
  expect(await screen.findByText("Exported 3 rows")).toBeTruthy();
});

test("a_background_backup_announces_its_end_with_its_database", async () => {
  const report: JobReport = {
    kind: "backup",
    rowsRead: 742_818,
    rowsWritten: 742_818,
    statements: 1503,
    skipped: 0,
    warnings: [],
    elapsedMs: 214_000,
    file: "E:\\Backups\\freight-2026-10-17.sql",
    bytes: Math.round(48.2 * 1024 * 1024),
    committed: 0,
    check: null,
  };
  const backup = job({ id: "b1", kind: "backup", label: "Backing up", subject: "freight", done: { report } });
  render(
    <ToastProvider>
      <JobStatusItem jobs={[backup]} onOpen={() => {}} />
    </ToastProvider>,
  );
  expect(await screen.findByText("Backed up freight to freight-2026-10-17.sql, 48.2 MB")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open folder" })).toBeTruthy();
});
