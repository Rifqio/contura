import type { DialectKind } from "../api/types";
import Dialog from "../components/Dialog";
import SqlBlock from "../components/SqlBlock";
import WarningBanner from "../components/WarningBanner";

interface Props {
  table: string;
  dialect: DialectKind;
  /** The plan's warnings as sentences: the bounded row count and the Foreign Keys that point at the table. */
  warnings: string[];
  sql: string;
  busy: boolean;
  onDrop(): void;
  onCancel(): void;
}

/** D7: Drop table on a plain Connection still asks, with the warning and the exact SQL. */
export default function ConfirmDrop({ table, dialect, warnings, sql, busy, onDrop, onCancel }: Props) {
  return (
    <Dialog className="dialog-confirm" size="wide" title={`Drop ${table}?`} onClose={() => !busy && onCancel()}>
      <div className="dialog-body confirm-stack">
        {warnings.map((w, i) => (
          <WarningBanner key={i}>{w}</WarningBanner>
        ))}
        <div className="confirm-sql" tabIndex={0} data-autofocus aria-label="SQL to run, read-only">
          <SqlBlock sql={sql} dialect={dialect} />
        </div>
      </div>
      <footer className="dialog-footer">
        <button type="button" className="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button button-danger-fill" disabled={busy} onClick={onDrop}>
          {busy ? "Dropping…" : `Drop ${table}`}
        </button>
      </footer>
    </Dialog>
  );
}
