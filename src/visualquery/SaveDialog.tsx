// "Save Visual Query": the name of a Visual Query's first save. Later saves overwrite without asking.
import { useId, useState } from "react";
import Dialog from "../components/Dialog";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";

interface Props {
  /** The name to begin with. */
  initial: string;
  /** The other Saved Queries' names: SQL and visual share one name space, ignoring case. */
  existing: string[];
  /** Those of `existing` that are SQL queries, so a clash says whose name it is (V8). */
  sqlNames?: string[];
  onSave(name: string): void;
  onCancel(): void;
}

/** Why a Saved Query cannot take `wanted` (one name space, ignoring case), or null when it can. */
export function nameProblem(wanted: string, existing: string[], sqlNames: string[] = []): string | null {
  if (!wanted) return "Give it a name.";
  const lower = wanted.toLowerCase();
  if (sqlNames.some((n) => n.toLowerCase() === lower)) return "This name belongs to a SQL query. Pick another name.";
  if (existing.some((n) => n.toLowerCase() === lower)) return `A Saved Query named "${wanted}" already exists. Pick another name.`;
  return null;
}

export default function SaveDialog({ initial, existing, sqlNames = [], onSave, onCancel }: Props) {
  const id = useId();
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const wanted = name.trim();
    const problem = nameProblem(wanted, existing, sqlNames);
    if (problem) {
      setError(problem);
      return;
    }
    onSave(wanted);
  }

  return (
    <Dialog title="Save Visual Query" icon="bookmark" size="form" dirty={name !== initial} onClose={onCancel}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="dialog-body save-query-body">
          <div className="field">
            <label htmlFor={`${id}-name`}>Name</label>
            <input
              id={`${id}-name`}
              className={error ? "input input-error" : "input"}
              aria-invalid={error ? true : undefined}
              value={name}
              autoFocus
              autoComplete="off"
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
            />
            {error ? (
              <p className="field-error" role="alert">
                <Icon name="alert" size={14} />
                {error}
              </p>
            ) : (
              <span className="field-help">Saved Visual Queries are listed under Saved Queries in the sidebar.</span>
            )}
          </div>
        </div>
        <footer className="dialog-footer">
          <span className="spacer" />
          <button type="button" className="button" onClick={onCancel}>
            Cancel
            <Kbd keys="Esc" />
          </button>
          <button type="submit" className="button button-primary">
            Save
            <Kbd keys="Enter" />
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
