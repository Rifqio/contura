import { useEffect, useState } from "react";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import { bytesText, elapsedLine, timeLeft } from "./exportText";
import type { JobView } from "./jobStore";

interface Props {
  job: JobView;
  /** The file being written. */
  path: string;
  onBackground(): void;
  onCancel(): void;
}

const n = (v: number) => v.toLocaleString("en-US");

/** The Large export running frame (560 px): where it writes, how far it is, and how long it takes. */
export default function RunningFrame({ job, path, onBackground, onCancel }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const elapsed = Math.max(0, now - job.startedAt);
  // the bar and percent only with a known row total.
  const total = job.rowsTotal;
  const percent = total !== null ? job.percent : null;
  return (
    <>
      <div className="dialog-body export-running">
        <div className="export-running-head">
          <span className="export-running-path">
            Writing <span className="mono">{path}</span>
          </span>
          {percent !== null && <span className="export-running-percent">{`${percent} percent`}</span>}
        </div>
        {percent !== null && (
          <div className="export-bar" role="progressbar" aria-label="Export progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <b style={{ width: `${percent}%` }} />
          </div>
        )}
        <dl className="export-facts">
          <dt>Rows</dt>
          <dd>{total !== null ? `${n(job.rowsDone)} of ${n(total)}` : n(job.rowsDone)}</dd>
          <dt>Written</dt>
          <dd>{bytesText(job.bytesDone)}</dd>
          <dt>Time</dt>
          <dd>{elapsedLine(elapsed, timeLeft(elapsed, job.rowsDone, total))}</dd>
        </dl>
        <div className="export-banner">
          <Icon name="info" size={14} />
          <span>Reads one consistent snapshot. Rows added while it runs are not in the file.</span>
        </div>
      </div>
      <footer className="dialog-footer">
        <span className="export-hint">Cancel deletes the unfinished file.</span>
        <span className="spacer" />
        {/* Esc sends the export to the background; only Cancel cancels. */}
        <button type="button" className="button" data-view-focus onClick={onBackground}>
          Run in the background
          <Kbd keys="Esc" />
        </button>
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
      </footer>
    </>
  );
}
