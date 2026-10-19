import { useEffect, useState } from "react";
import { errorText } from "../api/client";
import type { TransferPlan } from "../api/types";
import Dialog from "../components/Dialog";
import Icon from "../components/Icon";
import SqlBlock from "../components/SqlBlock";
import { copyLine, emptiedLine, reviewSql } from "./transferModel";

interface Props {
  plan: TransferPlan;
  target: string;
  batchRows: number;
  /** The Core refused a start because the target changed; Review shows it above the SQL. */
  notice: string | null;
  onChangeToStop(): void;
  onOpenInEditor(sql: string): void;
  /** The first INSERT of a table's copy, from 4 source rows. */
  sample(table: string): Promise<string>;
  /** Show sample opened or closed: the tab holds its keys while it is up. */
  onDialog?(open: boolean): void;
}

/** Step 4 (frame 8.1): the exact structure SQL, the row copies, what is not copied, the mode line. */
export default function StepReview({ plan, target, batchRows, notice, onChangeToStop, onOpenInEditor, sample, onDialog }: Props) {
  const sql = reviewSql(plan.structure, plan.afterRows);
  const emptied = emptiedLine(plan.emptied, target);
  const [shown, setShown] = useState<{ table: string; sql: string | null; error: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const open = shown !== null;
  useEffect(() => {
    onDialog?.(open);
    return () => {
      if (open) onDialog?.(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function showSample(table: string) {
    setShown({ table, sql: null, error: null });
    try {
      const text = await sample(table);
      setShown((s) => (s?.table === table ? { ...s, sql: text } : s));
    } catch (e) {
      setShown((s) => (s?.table === table ? { ...s, error: errorText(e, plan.targetDialect) } : s));
    }
  }

  return (
    <div className="transfer-review">
      {notice && (
        <div className="transfer-ban transfer-ban-info" role="status">
          <Icon name="info" size={14} />
          <span>{notice}</span>
        </div>
      )}
      {emptied && (
        <div className="transfer-ban transfer-ban-bad" role="alert">
          <Icon name="alert" size={14} />
          <span>{emptied}</span>
          <button type="button" className="button button-small" onClick={onChangeToStop}>
            Change to Stop
          </button>
        </div>
      )}
      <section className="transfer-box transfer-review-sql" aria-label="Structure SQL">
        <header className="transfer-pane-head">
          <span className="transfer-sect">Structure</span>
          <span className="transfer-count">The exact statements, in the order they run.</span>
          <span className="transfer-sp" />
          <button
            type="button"
            className="button button-small"
            onClick={() => {
              void navigator.clipboard?.writeText(sql).then(() => setCopied(true), () => undefined);
            }}
          >
            <Icon name="copy" size={14} />
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className="button button-small" onClick={() => onOpenInEditor(sql)}>
            <Icon name="fileQuery" size={14} />
            Open in editor
          </button>
        </header>
        <div className="transfer-review-code" tabIndex={0} aria-label="Structure SQL, read-only">
          <SqlBlock sql={sql} dialect={plan.targetDialect} lineNumbers />
        </div>
      </section>
      <section className="transfer-box" aria-label="Row copies">
        <header className="transfer-pane-head">
          <span className="transfer-sect">Rows</span>
          <span className="transfer-count">The rows are those in the source when the run starts.</span>
        </header>
        <ul className="transfer-copies">
          {plan.copies.map((c) => (
            <li key={c.table}>
              <span className="m">{copyLine(c, batchRows)}</span>
              <button type="button" className="button button-small" onClick={() => void showSample(c.table)}>
                Show sample
              </button>
            </li>
          ))}
          {plan.copies.length === 0 && <li className="transfer-muted">Structure only: no rows are copied.</li>}
        </ul>
      </section>
      {plan.notCopied.length > 0 && (
        <section className="transfer-box" aria-label="Not copied">
          <header className="transfer-pane-head">
            <span className="transfer-sect">Not copied</span>
            <span className="transfer-count">Recreate these on the target after.</span>
          </header>
          <ul className="transfer-notcopied">
            {plan.notCopied.map((s) => (
              <li key={s} className="m">
                {s}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="transfer-hint transfer-mode">{plan.modeLine}</p>

      {shown && (
        <Dialog title={`Sample INSERT for ${shown.table}`} size="wide" onClose={() => setShown(null)}>
          <div className="dialog-body">
            <p>The first statement, from 4 rows of the source.</p>
            {shown.error ? (
              <p className="transfer-hint transfer-hint-bad" role="alert">
                {shown.error}
              </p>
            ) : shown.sql === null ? (
              <p className="transfer-muted">Reading 4 rows...</p>
            ) : (
              <div className="import-sample" tabIndex={0} data-autofocus aria-label="Sample INSERT, read-only">
                <SqlBlock sql={shown.sql} dialect={plan.targetDialect} />
              </div>
            )}
          </div>
          <footer className="dialog-footer">
            <button type="button" className="button" onClick={() => setShown(null)}>
              Close
            </button>
          </footer>
        </Dialog>
      )}
    </div>
  );
}
