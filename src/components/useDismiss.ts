import { type RefObject, useEffect, useRef } from "react";

/**
 * Closes a floating menu or popover on a press outside `inside` or on Escape, wherever focus is.
 * The press is caught in the capture phase, so a canvas that stops its pointer events (React Flow's pan
 * and zoom do) still closes it; Escape is caught on the document, so it works with focus left elsewhere.
 */
export function useDismiss(open: boolean, inside: RefObject<HTMLElement | null>[], onClose: (how: "press" | "escape") => void) {
  const latest = useRef({ inside, onClose });
  latest.current = { inside, onClose };
  useEffect(() => {
    if (!open) return;
    // pointerdown and mousedown both come with one press: close once per press. The flag lives for that press
    // only (cleared by its mousedown or pointerup), so a popover that stays mounted can be dismissed again.
    let pressClosed = false;
    // A sublayer opened from inside (a Select's list, portalled to the body) counts as inside.
    const isInside = (t: EventTarget | null) =>
      t instanceof Node &&
      (latest.current.inside.some((r) => r.current?.contains(t)) || (t instanceof Element && t.closest("[data-sublayer]") !== null));
    const onPointerDown = (e: Event) => {
      pressClosed = !isInside(e.target);
      if (pressClosed) latest.current.onClose("press");
    };
    const onMouseDown = (e: Event) => {
      if (pressClosed) {
        pressClosed = false;
        return;
      }
      if (!isInside(e.target)) latest.current.onClose("press");
    };
    const onPointerUp = () => {
      pressClosed = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      latest.current.onClose("escape");
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
}
