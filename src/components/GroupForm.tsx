import { useId, useState } from "react";
import { deleteGroup, errorText, saveGroup } from "../api/client";
import { GROUP_COLORS, type Group, type GroupColor } from "../api/types";
import Dialog from "./Dialog";

interface Props {
  /** The Group being edited; absent for a new one. */
  group?: Group;
  /** How many Connections the Group holds, for the delete confirmation. */
  connectionCount: number;
  onSaved: (group: Group) => void;
  onDeleted: () => void;
  onCancel: () => void;
}

const COLOR_NAMES: Record<GroupColor, string> = {
  red: "Red",
  orange: "Orange",
  amber: "Amber",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  violet: "Violet",
  rose: "Rose",
  slate: "Slate",
};

function movesText(count: number): string {
  if (count === 0) return "It has no Connections.";
  if (count === 1) return "Its 1 Connection will move to Ungrouped. No Connections are deleted.";
  return `Its ${count} Connections will move to Ungrouped. No Connections are deleted.`;
}

export default function GroupForm({ group, connectionCount, onSaved, onDeleted, onCancel }: Props) {
  const id = useId();
  const [name, setName] = useState(group?.name ?? "");
  const [color, setColor] = useState<GroupColor>(group?.color ?? "teal");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim() === "") {
      setError("Give the Group a name, such as the client or project it is for.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSaved(await saveGroup({ id: group?.id ?? null, name: name.trim(), color }));
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  async function onConfirmDelete() {
    if (!group) return;
    setBusy(true);
    setError(null);
    try {
      await deleteGroup(group.id);
      onDeleted();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog title={group ? `Edit ${group.name}` : "New Group"} onClose={onCancel}>
      <form className="form" onSubmit={onSubmit} noValidate>
        <div className="dialog-body form-grid">
          <label className="field field-wide" htmlFor={`${id}-name`}>
            <span>Name</span>
            <input
              id={`${id}-name`}
              className="input"
              value={name}
              placeholder="Client or project"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <fieldset className="field field-wide swatch-field">
            <legend>Colour</legend>
            <div className="swatches">
              {GROUP_COLORS.map((c) => (
                <label key={c} className="swatch" title={COLOR_NAMES[c]}>
                  <input
                    type="radio"
                    name={`${id}-color`}
                    value={c}
                    checked={color === c}
                    aria-label={COLOR_NAMES[c]}
                    onChange={() => setColor(c)}
                  />
                  <span className="swatch-square" style={{ backgroundColor: `var(--color-group-${c})` }} />
                </label>
              ))}
            </div>
          </fieldset>
          {error && (
            <p className="error-text field-wide" role="alert">
              {error}
            </p>
          )}
          {confirming && group && (
            <div className="confirm field-wide" role="alert">
              <p>
                Delete {group.name}? {movesText(connectionCount)}
              </p>
              <div className="confirm-actions">
                <button type="button" className="button" autoFocus onClick={() => setConfirming(false)}>
                  Keep the Group
                </button>
                <button type="button" className="button button-danger-fill" disabled={busy} onClick={onConfirmDelete}>
                  Delete {group.name}
                </button>
              </div>
            </div>
          )}
        </div>
        <footer className="dialog-footer">
          {group && !confirming && (
            <button type="button" className="button button-danger" onClick={() => setConfirming(true)}>
              Delete Group
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            {group ? "Save" : "Create Group"}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
