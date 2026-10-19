import { useEffect, useRef } from "react";
import { errorText, fileName } from "../api/client";
import { revealInFolder } from "../api/jobs";
import type { ConnectionId, DialectKind, JobId } from "../api/types";
import { BACKUP_CANCELLED, backedUpText } from "../backup/backupText";
import Icon from "../components/Icon";
import Menu from "../components/Menu";
import { type ToastSpec, useToast } from "../components/Toast";
import { EXPORT_CANCELLED, exportedText, statusText } from "./exportText";
import type { JobView } from "./jobStore";

/** A Backup run in the background: its end toast (the dialog that would say it is closed). */
function backupEnded(job: JobView, done: NonNullable<JobView["done"]>, dialect?: DialectKind): ToastSpec {
  if ("error" in done) {
    if (done.error.kind === "cancelled") return { kind: "info", text: BACKUP_CANCELLED };
    return { kind: "error", text: errorText(done.error, dialect) };
  }
  const file = done.report.file;
  return {
    kind: "success",
    text: backedUpText(job.subject ?? "", file ? fileName(file) : "", done.report.bytes),
    action: file ? { label: "Open folder", run: () => void revealInFolder(file) } : undefined,
  };
}

const JOB_ICON: Record<JobView["kind"], "export" | "import" | "swap" | "save" | "history" | "columns"> = {
  export: "export",
  import: "import",
  scriptImport: "import",
  check: "import",
  transfer: "swap",
  backup: "save",
  restoreCheck: "history",
  restore: "history",
  sync: "columns",
};

interface Props {
  jobs: JobView[];
  /** Opens the job's progress again: the Export dialog, or the Import tab. */
  onOpen(id: JobId): void;
  /**
   * Called once when an export sent to the background ends, after its toast; the App drops
   * the job here (`useJobs().dismiss`).
   */
  onEnded?(id: JobId): void;
  /** The Dialect of a job's Connection, so an error reads in its words (M6). */
  dialectOf?(connectionId: ConnectionId): DialectKind | undefined;
}

/**
 * The status bar's job item: one running job shows its progress, several show "2 jobs running"
 * with a menu of each. An export that ends in the background shows its toast from here, since
 * its dialog is closed.
 */
export default function JobStatusItem({ jobs, onOpen, onEnded, dialectOf }: Props) {
  const toast = useToast();
  const announced = useRef(new Set<JobId>());

  useEffect(() => {
    for (const job of jobs) {
      // A Restore's end is the App's: it also refreshes the tree (step 9).
      const announces = job.kind === "export" || job.kind === "backup";
      if (!announces || !job.background || !job.done || announced.current.has(job.id)) continue;
      announced.current.add(job.id);
      const done = job.done;
      if (job.kind !== "export") {
        toast.show(backupEnded(job, done, dialectOf?.(job.connectionId)));
      } else if ("report" in done) {
        const file = done.report.file;
        toast.show({
          kind: "success",
          text: exportedText(done.report.rowsWritten, file ? fileName(file) : null),
          action: file ? { label: "Open folder", run: () => void revealInFolder(file) } : undefined,
        });
      } else {
        toast.show(done.error.kind === "cancelled" ? { kind: "info", text: EXPORT_CANCELLED } : { kind: "error", text: errorText(done.error, dialectOf?.(job.connectionId)) });
      }
      onEnded?.(job.id);
    }
  }, [jobs, toast, onEnded]);

  const running = jobs.filter((j) => j.done === null);
  if (running.length === 0) return null;
  if (running.length === 1) {
    const job = running[0];
    const text = statusText(job);
    return (
      <button type="button" className="job-status" aria-label={text} onClick={() => onOpen(job.id)}>
        <Icon name={JOB_ICON[job.kind]} size={14} />
        <span className="job-status-text">{text}</span>
      </button>
    );
  }
  return (
    <Menu
      label="Running jobs"
      align="end"
      compact
      items={running.map((j) => ({ key: j.id, label: statusText(j), onSelect: () => onOpen(j.id) }))}
      trigger={(props) => (
        <button type="button" className="job-status" aria-label={`${running.length} jobs running`} {...props}>
          <Icon name={running.every((j) => j.kind === "export") ? "export" : "import"} size={14} />
          <span className="job-status-text">{`${running.length} jobs running`}</span>
        </button>
      )}
    />
  );
}
