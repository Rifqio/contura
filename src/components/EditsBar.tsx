import { plural } from "../format/plural";
import Icon from "./Icon";
import Kbd from "./Kbd";

interface Props {
  summary: { cells: number; newRows: number; deletedRows: number };
  /** Changed rows. */
  changes: number;
  busy: boolean;
  /** A Production Connection: Save reads "Save on PROD" and still asks first. */
  production: boolean;
  previewOpen: boolean;
  onPreview(): void;
  onDiscard(): void;
  onSave(): void;
}

/** R20: the grid handles Ctrl+S itself (no registry command), so the hint stays literal. */
const SAVE_KEY = "Ctrl+S";

export function summaryText({ cells, newRows, deletedRows }: Props["summary"]): string {
  return [
    cells && plural(cells, "edited cell", "edited cells"),
    newRows && plural(newRows, "new row", "new rows"),
    deletedRows && plural(deletedRows, "deleted row", "deleted rows"),
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * T2: the Pending Edits bar, above the table footer while the grid has Pending Edits: the count
 * chip, what changed, then Preview SQL, Discard and Save.
 */
export default function EditsBar({ summary, changes, busy, production, previewOpen, onPreview, onDiscard, onSave }: Props) {
  return (
    <div className="edits-bar" role="region" aria-label="Pending Edits">
      <span className="chip chip-warning edits-count">{plural(changes, "change", "changes")}</span>
      <span className="edits-summary">{summaryText(summary)}</span>
      <span className="edits-spacer" />
      <button
        type="button"
        className={previewOpen ? "button button-small button-quiet icon-button-on" : "button button-small button-quiet"}
        aria-pressed={previewOpen}
        onClick={onPreview}
      >
        <Icon name="fileCode" size={14} />
        Preview SQL
      </button>
      <button type="button" className="button button-small button-quiet" disabled={busy} onClick={onDiscard}>
        <Icon name="undo" size={14} />
        Discard
      </button>
      {production ? (
        <button
          type="button"
          className="button button-small button-prod"
          disabled={busy}
          onClick={onSave}
          title={`Saving writes on Production and asks you to confirm first (${SAVE_KEY})`}
          // R8: the button shows PROD; its spoken name keeps the word.
          aria-label="Save on Production"
          aria-keyshortcuts="Control+S"
        >
          {busy ? "Saving…" : "Save on PROD"}
          <Kbd keys={SAVE_KEY} />
        </button>
      ) : (
        <button
          type="button"
          className="button button-small button-primary"
          disabled={busy}
          onClick={onSave}
          title={`Save (${SAVE_KEY})`}
          aria-label="Save"
          aria-keyshortcuts="Control+S"
        >
          <Icon name="export" size={14} />
          {busy ? "Saving…" : "Save"}
          <Kbd keys={SAVE_KEY} />
        </button>
      )}
    </div>
  );
}
