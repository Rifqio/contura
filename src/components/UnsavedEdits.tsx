import Dialog from "./Dialog";

interface Props {
  table: string;
  busy: boolean;
  onSave(): void;
  onDiscard(): void;
  onCancel(): void;
}

/** Asked before a grid with Pending Edits is closed or left. */
export default function UnsavedEdits({ table, busy, onSave, onDiscard, onCancel }: Props) {
  return (
    <Dialog title="Unsaved changes" onClose={onCancel}>
      <div className="dialog-body">
        <p>Save changes to {table}?</p>
      </div>
      <footer className="dialog-footer">
        <button type="button" className="button" disabled={busy} onClick={onDiscard}>
          Discard
        </button>
        <span className="spacer" />
        <button type="button" className="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button button-primary" disabled={busy} onClick={onSave}>
          Save
        </button>
      </footer>
    </Dialog>
  );
}
