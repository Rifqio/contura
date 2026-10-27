// The canvas's short note at the bottom of the drawing, "Moved Checkout back" after an undo (motion design):
// it fades in over the toast duration and goes after a moment. A new note replaces the old one. A note with an action
// ("Deleted Refund." with Undo, Figma and Miro) stays longer, so the action can be reached.
import { useEffect, useState } from "react";

/** How long a note stays. */
export const TOAST_STAYS_MS = 1600;
/** How long a note with an action stays. */
export const TOAST_ACTION_STAYS_MS = 6000;

export interface CanvasNote {
  text: string;
  key: number;
  action?: { label: string; run(): void };
}

export default function CanvasToast({ note }: { note: CanvasNote | null }) {
  const [shown, setShown] = useState(note);
  useEffect(() => {
    setShown(note);
    if (!note) return;
    const t = setTimeout(() => setShown(null), note.action ? TOAST_ACTION_STAYS_MS : TOAST_STAYS_MS);
    return () => clearTimeout(t);
  }, [note]);
  if (!shown) return null;
  return (
    <div key={shown.key} className={shown.action ? "flow-toast has-action" : "flow-toast"} role="status">
      {shown.text}
      {shown.action && (
        <button
          type="button"
          className="flow-toast-action"
          onClick={() => {
            setShown(null);
            shown.action!.run();
          }}
        >
          {shown.action.label}
        </button>
      )}
    </div>
  );
}
