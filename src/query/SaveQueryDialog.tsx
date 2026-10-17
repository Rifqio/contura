import { useId, useState } from "react";
import { errorText, saveSavedQuery } from "../api/client";
import type { SavedQuery } from "../api/types";
import Dialog from "../components/Dialog";

interface Props {
  sql: string;
  /** Set when renaming an existing Saved Query. */
  existing?: { id: string; name: string };
  onSaved(q: SavedQuery): void;
  onCancel(): void;
}

/** Asks for a Saved Query's name. Names are unique, ignoring case; the Core says so. */
export default function SaveQueryDialog({ sql, existing, onSaved, onCancel }: Props) {
  const id = useId();
  const [name, setName] = useState(existing?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim()) {
      setError("Give the query a name.");
      return;
    }
    setBusy(true);
    try {
      onSaved(await saveSavedQuery({ id: existing?.id ?? null, name: name.trim(), sql }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={existing ? "Rename Saved Query" : "Save query"} onClose={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="dialog-body">
          <label className="field" htmlFor={`${id}-name`}>
            <span>Name</span>
            <input
              id={`${id}-name`}
              className="input"
              value={name}
              autoFocus
              autoComplete="off"
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
            />
          </label>
          {error ? (
            <p className="error-text" role="alert">
              {error}
            </p>
          ) : (
            <p className="muted">
              Saved Queries are kept by name in Contura's data folder and listed under Saved Queries, for every
              Connection.
            </p>
          )}
        </div>
        <footer className="dialog-footer">
          <span className="spacer" />
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            Save
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
