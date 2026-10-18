import { useEffect, useRef } from "react";
import { errorText, fileName } from "../api/client";
import { revealInFolder } from "../api/jobs";
import type { ConnectionId, DialectKind, JobId } from "../api/types";
import Icon from "../components/Icon";
import Menu from "../components/Menu";
import { useToast } from "../components/Toast";
import { EXPORT_CANCELLED, exportedText, statusText } from "./exportText";
import type { JobView } from "./jobStore";

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
      if (job.kind !== "export" || !job.background || !job.done || announced.current.has(job.id)) continue;
      announced.current.add(job.id);
      const done = job.done;
      if ("report" in done) {
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
        <Icon name={job.kind === "export" ? "export" : "import"} size={14} />
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
