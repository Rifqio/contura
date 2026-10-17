import { useEffect, useRef, useState } from "react";
import { errorText } from "../../api/client";
import { type Clash, applyRebind, findClash, keyProblem, keysFor, resetCommand } from "../../commands/keymap";
import { keysFromEvent } from "../../commands/keys";
import { COMMANDS, type Command, type CommandId } from "../../commands/registry";
import { useKeymap } from "../../commands/useCommandKeys";
import Dialog from "../../components/Dialog";
import Icon from "../../components/Icon";
import Kbd from "../../components/Kbd";
import { matches } from "./layout";

/** What a key press led to while a command is being rebound. */
type Pressed = { keys: string; problem: string } | { keys: string; clash: Clash };

function clashText(keys: string, clash: Clash): string {
  return clash.kind === "command" ? `${keys} is used by ${clash.title}.` : `${keys} is used by ${clash.title} in the editor.`;
}

interface CaptureProps {
  command: Command;
  pressed: Pressed | null;
  onPress: (keys: string) => void;
  onCancel: () => void;
}

/** Takes the next key press for a command; Escape gives up, Tab moves on. */
function Capture({ command, pressed, onPress, onCancel }: CaptureProps) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  return (
    <input
      ref={field}
      readOnly
      className="input mono keymap-capture"
      aria-label={`Press the new keys for ${command.title}`}
      placeholder="Press the new keys"
      value={pressed?.keys ?? ""}
      onKeyDown={(e) => {
        const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
        if (e.key === "Tab" && plain) return;
        // Kept from the dialog and the window's own keys.
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape" && plain && !e.shiftKey) {
          onCancel();
          return;
        }
        const keys = keysFromEvent(e.nativeEvent);
        if (keys) onPress(keys);
      }}
    />
  );
}

/** Every command and its keys: search, rebind with the clash shown, reset one or all (D10). */
export default function KeymapDialog({ onClose }: { onClose: () => void }) {
  const { map, overrides, save } = useKeymap();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<CommandId | null>(null);
  const [pressed, setPressed] = useState<Pressed | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = COMMANDS.filter((c) => matches(query, c.title, keysFor(map, c.id).join(" ")));
  const overridden = (id: CommandId) => Object.prototype.hasOwnProperty.call(overrides, id);

  function stopEditing() {
    setEditing(null);
    setPressed(null);
  }

  async function store(next: typeof overrides) {
    setError(null);
    try {
      await save(next);
      stopEditing();
    } catch (e) {
      setError(errorText(e));
    }
  }

  function press(id: CommandId, keys: string) {
    const problem = keyProblem(keys);
    if (problem) return setPressed({ keys, problem });
    if (keysFor(map, id).includes(keys)) return stopEditing();
    const clash = findClash(map, id, keys);
    if (clash) return setPressed({ keys, clash });
    void store(applyRebind(overrides, map, id, keys));
  }

  return (
    <Dialog title="Keyboard shortcuts" size="wide" onClose={onClose} subtitle="VS Code">
      <div className="dialog-body keymap-body">
        <label className="keymap-search">
          <Icon name="search" size={14} />
          <input
            type="search"
            className="input"
            aria-label="Search shortcuts"
            placeholder="Search shortcuts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <table className="keymap-table" aria-label="Shortcuts">
          <thead>
            <tr>
              <th scope="col">Command</th>
              <th scope="col">Keys</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const keys = keysFor(map, c.id);
              const isEditing = editing === c.id;
              return (
                <tr key={c.id} className={isEditing ? "editing" : undefined}>
                  <th scope="row">{c.title}</th>
                  <td>
                    {isEditing ? (
                      <div className="keymap-edit">
                        <Capture command={c} pressed={pressed} onPress={(k) => press(c.id, k)} onCancel={stopEditing} />
                        {pressed && (
                          <div className="keymap-verdict">
                            <span role="alert" className={"problem" in pressed ? "field-error" : "keymap-clash"}>
                              {"problem" in pressed ? pressed.problem : clashText(pressed.keys, pressed.clash)}
                            </span>
                            {"clash" in pressed && (
                              <button
                                type="button"
                                className="button button-small button-primary"
                                onClick={() => void store(applyRebind(overrides, map, c.id, pressed.keys))}
                              >
                                Confirm
                              </button>
                            )}
                            <button type="button" className="button button-small" onClick={stopEditing}>
                              Cancel
                            </button>
                          </div>
                        )}
                      </div>
                    ) : keys.length > 0 ? (
                      <span className="kmap-keys">
                        {keys.map((k) => (
                          <Kbd key={k} keys={k} />
                        ))}
                      </span>
                    ) : (
                      <span className="muted">None</span>
                    )}
                  </td>
                  <td className="keymap-actions">
                    <button
                      type="button"
                      className="button button-small"
                      aria-label={`Edit ${c.title}`}
                      onClick={() => {
                        setPressed(null);
                        setEditing(c.id);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="button button-small button-ghost"
                      aria-label={`Reset ${c.title}`}
                      disabled={!overridden(c.id)}
                      onClick={() => void store(resetCommand(overrides, c.id))}
                    >
                      Reset
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="muted">No commands match "{query}".</p>}
      </div>
      <footer className="dialog-footer">
        <button type="button" className="button" disabled={Object.keys(overrides).length === 0} onClick={() => void store({})}>
          Reset all
        </button>
        <span className="spacer" />
        <button type="button" className="button button-primary" onClick={onClose}>
          Done
        </button>
      </footer>
    </Dialog>
  );
}
