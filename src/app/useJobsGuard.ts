import { type ReactNode, createElement, useRef, useState } from "react";
import type { ConnectionConfig, ConnectionId, JobId } from "../api/types";
import Dialog from "../components/Dialog";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import type { JobView } from "../jobs/jobStore";
import type { JobsValue } from "../jobs/useJobs";

/** What the guard needs of `useJobs()`. */
export type JobsGuardJobs = Pick<JobsValue, "jobs" | "cancel" | "watch">;

export interface JobsGuard {
  /** Whether any job of this window is still running (the window's close asks then, Q22). */
  running(): boolean;
  /**
   * Before the window closes, a Connection closes, or a Connection's settings are saved: asks
   * about the jobs running there (all of them without `only`) and cancels them on yes. Resolves
   * true when nothing runs or the jobs were cancelled, false when the user keeps them running.
   */
  confirmStop(only?: ConnectionId): Promise<boolean>;
  /**
   * Before an Import tab closes: while its job runs, asks "Cancel the import and roll back?" and
   * cancels on yes. A tab with no job, or an ended one (only a mapping, or a result), closes at once.
   */
  confirmCloseImport(jobId: JobId | null): Promise<boolean>;
  /** The same for a Data Transfer tab: "Cancel the transfer and roll back?" */
  confirmCloseTransfer(jobId: JobId | null): Promise<boolean>;
  /** The same for a Schema Compare tab while Apply runs: "Cancel Apply?" */
  confirmCloseCompare(jobId: JobId | null): Promise<boolean>;
  /** The open ask, else null. */
  dialog: ReactNode;
}

/** How long a yes waits for the cancelled jobs to end before the close goes on. */
const END_WAIT_MS = 5000;

/**
 * The leave-prompt line of a job (Q17): "Import into menu_items is running on Shop", or
 * "Export of orders is running". Built from the job's label ("Importing into x", "Exporting x").
 */
export function leaveLine(job: JobView, connections: ConnectionConfig[]): string {
  const conn = connections.find((c) => c.id === job.connectionId)?.name ?? "its Connection";
  if (job.kind === "export") return `Export of ${job.label.replace(/^Exporting /, "")} is running`;
  if (job.kind === "transfer") return `Transfer to ${conn} is running`;
  if (job.kind === "sync") return `Apply on ${conn} is running`;
  const what = /^Importing into /.test(job.label)
    ? job.label.replace(/^Importing into /, "Import into ")
    : `Import of ${job.label.replace(/^Importing /, "")}`;
  return `${what} is running on ${conn}`;
}

type Ask = {
  title: string;
  /** Each line with the id of its job, for a stable React key. */
  lines: { key: string; text: string }[];
  question: string;
  yes: string;
  ids: JobId[];
  resolve(ok: boolean): void;
};

/** Asks before running jobs are cut short: closing the window, a Connection, or an Import tab. */
export function useJobsGuard(opts: { jobs: JobsGuardJobs; connections: ConnectionConfig[] }): JobsGuard {
  const [ask, setAsk] = useState<Ask | null>(null);
  const latest = useRef(opts);
  latest.current = opts;

  const live = (only?: ConnectionId) =>
    latest.current.jobs.jobs.filter((j) => j.done === null && (only === undefined || j.connectionId === only));

  /**
   * Cancels the jobs and waits for them to end, END_WAIT_MS at most in all (Q43). Every cancel_job
   * is sent at once and none is awaited: the Core sets the cancel flag before its network step, and
   * a server cancel to an unreachable host must not hold the window open.
   */
  async function stop(ids: JobId[]) {
    const { jobs } = latest.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, END_WAIT_MS);
    });
    const ended = ids.map(
      (id) =>
        new Promise<void>((resolve) => {
          const off = jobs.watch(id, (e) => {
            if (e.kind === "finished" || e.kind === "failed") {
              off();
              resolve();
            }
          });
          void cap.then(off);
        }),
    );
    for (const id of ids) void jobs.cancel(id).catch(() => {});
    await Promise.race([Promise.all(ended), cap]);
    clearTimeout(timer);
  }

  function open(a: Omit<Ask, "resolve">): Promise<boolean> {
    return new Promise<boolean>((resolve) => setAsk({ ...a, resolve }));
  }

  async function confirmStop(only?: ConnectionId): Promise<boolean> {
    const running = live(only);
    if (running.length === 0) return true;
    const lines = running.map((j) => ({ key: j.id, text: leaveLine(j, latest.current.connections) }));
    const one = running.length === 1;
    return open({
      title: one ? "A job is running" : `${running.length} jobs are running`,
      lines: one ? [{ key: lines[0].key, text: `${lines[0].text}. Cancel it?` }] : lines.map((l) => ({ key: l.key, text: `${l.text}.` })),
      question: one ? "" : "Cancel them?",
      yes: one ? "Cancel the job" : "Cancel the jobs",
      ids: running.map((j) => j.id),
    });
  }

  async function confirmCloseImport(jobId: JobId | null, title = "Cancel the import and roll back?", yes = "Cancel and roll back"): Promise<boolean> {
    if (jobId === null || !live().some((j) => j.id === jobId)) return true;
    return open({
      title,
      lines: [],
      question: "",
      yes,
      ids: [jobId],
    });
  }

  const finish = async (a: Ask, yes: boolean) => {
    setAsk(null);
    if (yes) await stop(a.ids);
    a.resolve(yes);
  };

  let dialog: ReactNode = null;
  if (ask) {
    const body =
      ask.lines.length > 0 || ask.question
        ? createElement(
            "div",
            { key: "body", className: "dialog-body dialog-body-stack" },
            ...ask.lines.map((l) => createElement("span", { key: l.key }, l.text)),
            ask.question ? createElement("span", { key: "q" }, ask.question) : null,
          )
        : null;
    const footer = createElement(
      "footer",
      { key: "footer", className: "dialog-footer" },
      createElement("span", { className: "spacer" }),
      createElement(
        "button",
        { type: "button", className: "button", autoFocus: true, onClick: () => void finish(ask, false) },
        "Keep running",
        createElement(Kbd, { keys: "Esc" }),
      ),
      createElement(
        "button",
        { type: "button", className: "button button-danger-fill", onClick: () => void finish(ask, true) },
        createElement(Icon, { name: "stop", size: 14 }),
        ask.yes,
      ),
    );
    dialog = createElement(Dialog, {
      title: ask.title,
      size: "confirm",
      icon: "warning",
      onClose: () => void finish(ask, false),
      children: [body, footer],
    });
  }

  const confirmCloseTransfer = (jobId: JobId | null) => confirmCloseImport(jobId, "Cancel the transfer and roll back?");
  // MySQL keeps the statements that ran, so the answer says Cancel, not roll back.
  const confirmCloseCompare = (jobId: JobId | null) => confirmCloseImport(jobId, "Cancel Apply?", "Cancel Apply");

  return { running: () => live().length > 0, confirmStop, confirmCloseImport: (id) => confirmCloseImport(id), confirmCloseTransfer, confirmCloseCompare, dialog };
}
