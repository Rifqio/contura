import { useEffect, useState } from "react";
import { errorText } from "../api/client";
import type { DialectKind } from "../api/types";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import { rowsPhrase, secondsText, writtenText } from "./importModel";
import type { JobView } from "./jobStore";

interface Props {
  /** null until a SQL file's job id is known. */
  view: JobView | null;
  /** The file row being written, from the latest progress event. */
  fileRow: number | null;
  /** Q27: rows that stay in the database after a failure or a cancel. */
  rowsCommitted: number;
  /** A cancel rolls everything back (one transaction); MyISAM and Commit every N do not. */
  rollsBack: boolean;
  /** What the end line names: the table, or the database for a SQL file. */
  into: string;
  script: boolean;
  dialect: DialectKind;
  onCancel(): void;
  onBack(): void;
  /** Offered at the end of a table import. */
  onOpenTable?(): void;
}

const n = (v: number) => v.toLocaleString("en-US");

/** The Run step: progress while the job runs, then how it ended. The tab stays either way. */
export default function ImportRunView({ view, fileRow, rowsCommitted, rollsBack, into, script, dialect, onCancel, onBack, onOpenTable }: Props) {
  const done = view?.done ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (done) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [done]);

  const skipped = view && view.skippedTotal > 0 && (
    <section className="import-skipped">
      <h3>Rows skipped</h3>
      <table aria-label="Rows skipped">
        <thead>
          <tr>
            <th scope="col">File row</th>
            <th scope="col">Column</th>
            <th scope="col">Message</th>
          </tr>
        </thead>
        <tbody>
          {view.skipped.map((s, i) => (
            <tr key={i}>
              <td className="import-num">{n(s.fileRow)}</td>
              <td>{s.column ?? ""}</td>
              <td>{s.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.skippedTotal > view.skipped.length && (
        <p className="field-help">
          Showing the first {n(view.skipped.length)} of {n(view.skippedTotal)}.
        </p>
      )}
    </section>
  );

  if (done) {
    const ok = "report" in done;
    let title: string;
    // Q27: a stop says what stayed; "Nothing was imported." only when nothing did.
    let stayed: string | null = null;
    if ("report" in done) {
      const r = done.report;
      title = script
        ? `Ran ${n(r.statements)} ${r.statements === 1 ? "statement" : "statements"} in ${into} in ${secondsText(r.elapsedMs)}`
        : `Imported ${rowsPhrase(r.rowsWritten)} into ${into} in ${secondsText(r.elapsedMs)}`;
    } else if (done.error.kind === "cancelled") {
      title = rowsCommitted > 0 ? "Import cancelled." : "Import cancelled. Nothing was imported.";
      if (rowsCommitted > 0) stayed = writtenText(rowsCommitted, into);
    } else if (done.error.kind === "fileChanged" && rowsCommitted > 0) {
      title = `${done.error.message.file} changed while it was imported.`;
      stayed = writtenText(rowsCommitted, into);
    } else {
      title = errorText(done.error, dialect);
      // A changed file always says it itself; nothing else to add.
      // The Core's own end texts (a changed file with kept rows, the Skip cap) already say what stayed.
      const saysWhatStayed = title.includes("before the stop") || title.includes("Nothing was imported.");
      if (done.error.kind !== "fileChanged" && !saysWhatStayed) stayed = rowsCommitted > 0 ? writtenText(rowsCommitted, into) : "Nothing was imported.";
    }
    const warnings = view?.warnings ?? [];
    return (
      <div className="import-run import-end">
        <div className={ok ? "import-end-head import-end-ok" : "import-end-head import-end-failed"}>
          <Icon name={ok ? "check" : "error"} />
          <p className="import-end-title">{title}</p>
        </div>
        {stayed && <p className="import-stayed">{stayed}</p>}
        {ok && done.report.skipped > 0 && <p>{done.report.skipped === 1 ? "1 row was skipped." : `${n(done.report.skipped)} rows were skipped.`}</p>}
        {warnings.map((w, i) => (
          <p key={i} className="field-help">
            {w}
          </p>
        ))}
        <div className="import-end-actions">
          {ok && onOpenTable && (
            <button type="button" className="button button-primary" onClick={onOpenTable}>
              Open table
            </button>
          )}
          <button type="button" className="button" onClick={onBack}>
            Back <Kbd keys="Alt+Left" />
          </button>
        </div>
        {skipped}
      </div>
    );
  }

  const percent = view?.percent ?? null;
  const elapsed = view ? Math.max(0, now - view.startedAt) : 0;
  const rows = view ? (view.rowsTotal !== null ? `${n(view.rowsDone)} of ${n(view.rowsTotal)}` : n(view.rowsDone)) : "0";
  return (
    <div className="import-run">
      <div
        className="import-bar"
        role="progressbar"
        aria-label="Import progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <span style={{ width: `${percent ?? 0}%` }} />
      </div>
      <dl className="import-stats">
        <div>
          <dt>Rows</dt>
          <dd>{rows}</dd>
        </div>
        <div>
          <dt>Statements</dt>
          <dd>{n(view?.statementsDone ?? 0)}</dd>
        </div>
        <div>
          <dt>Time</dt>
          <dd>{elapsed < 60_000 ? `${Math.floor(elapsed / 1000)}s` : secondsText(elapsed)}</dd>
        </div>
        {fileRow !== null && (
          <div>
            <dt>File row</dt>
            <dd>{n(fileRow)}</dd>
          </div>
        )}
      </dl>
      <div className="import-end-actions">
        <button type="button" className="button button-danger" onClick={onCancel} disabled={!view}>
          {rollsBack ? "Cancel and roll back" : "Cancel"}
        </button>
      </div>
      {skipped}
    </div>
  );
}
