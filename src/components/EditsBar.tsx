import Icon from "./Icon";

interface Props {
  summary: { cells: number; newRows: number; deletedRows: number };
  /** Changed rows. */
  changes: number;
  busy: boolean;
  error: string | null;
  previewOpen: boolean;
  onPreview(): void;
  onDiscard(): void;
  onSave(): void;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function summaryText({ cells, newRows, deletedRows }: Props["summary"]): string {
  return [
    cells && plural(cells, "edited cell", "edited cells"),
    newRows && plural(newRows, "new row", "new rows"),
    deletedRows && plural(deletedRows, "deleted row", "deleted rows"),
  ]
    .filter(Boolean)
    .join(", ");
}

/** Under the grid while it has Pending Edits: what changed, and Preview SQL, Discard and Save. */
export default function EditsBar({ summary, changes, busy, error, previewOpen, onPreview, onDiscard, onSave }: Props) {
  return (
    <div className="edits-bar" role="region" aria-label="Pending Edits">
      <span className="edits-count">{plural(changes, "change", "changes")}</span>
      <span className="edits-summary">{summaryText(summary)}</span>
      {error && (
        <span className="edits-error" role="alert">
          {error}
        </span>
      )}
      <span className="edits-spacer" />
      <button type="button" className="button button-small" aria-pressed={previewOpen} onClick={onPreview}>
        Preview SQL
      </button>
      <button type="button" className="button button-small" disabled={busy} onClick={onDiscard}>
        <Icon name="undo" />
        Discard
      </button>
      <button type="button" className="button button-small button-primary" disabled={busy} onClick={onSave} title="Save (Ctrl+S)">
        <Icon name="save" />
        {busy ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
