import { useEffect, useRef, type ReactNode } from "react";
import { keysFor } from "../commands/keymap";
import { keysFromEvent } from "../commands/keys";
import { useKeymap } from "../commands/useCommandKeys";
import Dialog from "./Dialog";
import Icon from "./Icon";
import Kbd from "./Kbd";

interface Props {
  /** The question, such as "Save changes to orders?". */
  title: string;
  /** What would be lost and where. */
  body: ReactNode;
  /** Saving writes to a Production Connection: the button says so and focus starts on Cancel. */
  production: boolean;
  busy: boolean;
  /** "Apply" for a design tab's unapplied changes; the save keys still apply. */
  verb?: "Save" | "Apply";
  onSave(): void;
  onDiscard(): void;
  onCancel(): void;
}

/** The body for a table's Pending Edits: how many, in which table, on which Connection. */
export function tableBody(count: number, table: string, connection: string, production: boolean): ReactNode {
  const edits = `${count} Pending ${count === 1 ? "Edit" : "Edits"}`;
  const loses = `Closing the tab without saving loses ${count === 1 ? "it" : "them"}.`;
  if (production) {
    return (
      <>
        <span>
          You have <b>{edits}</b> in {table} on <b>{connection}</b> (Production). {loses}
        </span>
        <span className="dialog-aside">Save on PROD shows the SQL and asks you to confirm before anything runs.</span>
      </>
    );
  }
  return (
    <span>
      You have <b>{edits}</b> in {table} on {connection}. {loses}
    </span>
  );
}

/** The body for a design tab's unapplied changes: how many, to which table, on which Connection. */
export function designBody(count: number, table: string, connection: string, production: boolean): ReactNode {
  const changes = `${count} unapplied ${count === 1 ? "change" : "changes"}`;
  const loses = `Closing the tab without applying loses ${count === 1 ? "it" : "them"}.`;
  if (production) {
    return (
      <>
        <span>
          You have <b>{changes}</b> to {table} on <b>{connection}</b> (Production). {loses}
        </span>
        <span className="dialog-aside">Apply on PROD shows the SQL and asks you to confirm before anything runs.</span>
      </>
    );
  }
  return (
    <span>
      You have <b>{changes}</b> to {table} on {connection}. {loses}
    </span>
  );
}

/** Asked before a tab with unsaved work is closed or left: a grid with Pending Edits, or a Saved Query's text. */
export default function UnsavedEdits({ title, body, production, busy, verb = "Save", onSave, onDiscard, onCancel }: Props) {
  const { map } = useKeymap();
  const saveKeys = keysFor(map, "query.save");
  const save = useRef(onSave);
  save.current = onSave;
  const keys = useRef(saveKeys);
  keys.current = saveKeys;
  const saveButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);

  // Focus on Save, or on Cancel on Production, where saving asks again.
  useEffect(() => {
    (production ? cancelButton : saveButton).current?.focus();
  }, [production]);

  // Ctrl+S saves from anywhere in the dialog, as the form dialogs do.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keysFromEvent(e);
      if (!k || !keys.current.includes(k)) return;
      e.preventDefault();
      save.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Dialog title={title} size="confirm" onClose={onCancel}>
      <div className="dialog-body dialog-body-stack">{body}</div>
      <footer className="dialog-footer">
        <button type="button" className="button" disabled={busy} onClick={onDiscard}>
          Discard
        </button>
        <span className="spacer" />
        <button ref={cancelButton} type="button" className="button" disabled={busy} onClick={onCancel}>
          Cancel
          <Kbd keys="Esc" />
        </button>
        {production ? (
          <button type="button" className="button button-prod" disabled={busy} onClick={onSave}>
            <Icon name="check" size={14} />
            {verb} on PROD...
          </button>
        ) : (
          <button ref={saveButton} type="button" className="button button-primary" disabled={busy} onClick={onSave}>
            {verb}
            {saveKeys[0] && <Kbd keys={saveKeys[0]} />}
          </button>
        )}
      </footer>
    </Dialog>
  );
}
