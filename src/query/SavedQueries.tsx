import { useState } from "react";
import { deleteSavedQuery, errorText } from "../api/client";
import type { SavedQuery } from "../api/types";
import Dialog from "../components/Dialog";
import Icon from "../components/Icon";
import Menu from "../components/Menu";
import SaveQueryDialog from "./SaveQueryDialog";

interface Props {
  items: SavedQuery[];
  /** The Saved Query open in the active tab, if any. */
  activeId: string | null;
  onOpen(q: SavedQuery): void;
  /** A Saved Query was renamed or deleted; reload the list. */
  onChanged(): void;
}

/** Saved Queries, listed for every Connection in the side panel. */
export default function SavedQueries({ items, activeId, onOpen, onChanged }: Props) {
  const [renaming, setRenaming] = useState<SavedQuery | null>(null);
  const [deleting, setDeleting] = useState<SavedQuery | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(q: SavedQuery) {
    try {
      await deleteSavedQuery(q.id);
      setDeleting(null);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <section className="saved-queries" aria-labelledby="saved-queries-label">
      <h3 id="saved-queries-label" className="tree-section-label">
        Saved Queries
      </h3>
      {items.length === 0 ? (
        <p className="muted saved-empty">Save a query tab with Ctrl+S to keep it here.</p>
      ) : (
        <ul className="saved-list">
          {items.map((q) => (
            <li key={q.id} className={q.id === activeId ? "saved-row saved-row-on" : "saved-row"}>
              <button type="button" className="saved-open" title={q.sql} onClick={() => onOpen(q)}>
                <Icon name="edit" className="muted" />
                <span className="saved-name">{q.name}</span>
              </button>
              <Menu
                label={`Actions for ${q.name}`}
                align="end"
                items={[
                  { key: "rename", label: "Rename", onSelect: () => setRenaming(q) },
                  { key: "delete", label: "Delete", danger: true, onSelect: () => setDeleting(q) },
                ]}
                trigger={(props) => (
                  <button type="button" className="icon-button" aria-label={`Actions for ${q.name}`} {...props}>
                    <Icon name="more" />
                  </button>
                )}
              />
            </li>
          ))}
        </ul>
      )}
      {renaming && (
        <SaveQueryDialog
          sql={renaming.sql}
          existing={{ id: renaming.id, name: renaming.name }}
          onCancel={() => setRenaming(null)}
          onSaved={() => {
            setRenaming(null);
            onChanged();
          }}
        />
      )}
      {deleting && (
        <Dialog title="Delete Saved Query" onClose={() => setDeleting(null)}>
          <div className="dialog-body">
            <p>Delete the Saved Query "{deleting.name}"?</p>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
          </div>
          <footer className="dialog-footer">
            <span className="spacer" />
            <button type="button" className="button" onClick={() => setDeleting(null)}>
              Cancel
            </button>
            <button type="button" className="button button-danger-fill" onClick={() => void remove(deleting)}>
              Delete
            </button>
          </footer>
        </Dialog>
      )}
    </section>
  );
}
