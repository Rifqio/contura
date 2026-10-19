// The canvas's short note at the bottom of the drawing, "Moved Checkout back" after an undo (motion design):
// it fades in over the toast duration and goes after a moment. A new note replaces the old one.
import { useEffect, useState } from "react";

/** How long a note stays. */
export const TOAST_STAYS_MS = 1600;

export default function CanvasToast({ note }: { note: { text: string; key: number } | null }) {
  const [shown, setShown] = useState(note);
  useEffect(() => {
    setShown(note);
    if (!note) return;
    const t = setTimeout(() => setShown(null), TOAST_STAYS_MS);
    return () => clearTimeout(t);
  }, [note]);
  if (!shown) return null;
  return (
    <div key={shown.key} className="flow-toast" role="status">
      {shown.text}
    </div>
  );
}
