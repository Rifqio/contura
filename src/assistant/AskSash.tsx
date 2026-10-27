import { type PointerEvent as ReactPointerEvent, useEffect, useRef } from "react";
import { ASK_WIDTH_DEFAULT, ASK_WIDTH_MIN, clampAskWidth, saveAskWidth } from "./askWidth";

interface Props {
  /** The panel's width now, in px. */
  width: number;
  /** The most it may be in this window. */
  max: number;
  /** Told once per change: at the end of a drag, on a key, on a double-click. */
  onWidth(w: number): void;
}

const STEP = 16;

/**
 * The Ask panel's left edge (the VS Code and Cursor chat side panel): drag it, or Left and Right in 16 px steps, Home
 * and End to the least and the most; a double-click puts back 360.
 *
 * A drag holds the pointer and writes --ask-width straight onto the body, once a frame, so nothing re-renders while it
 * moves; the width is set and saved once, when the drag ends. It ends on pointer up or cancel, on a lost capture, on a
 * move with no button held (a release the window never saw), and when the window loses focus.
 */
export default function AskSash({ width, max, onWidth }: Props) {
  /** Ends the drag in progress; null when none is. */
  const stop = useRef<((commit: boolean) => void) | null>(null);
  useEffect(() => () => stop.current?.(false), []);

  const set = (w: number) => {
    const next = clampAskWidth(w, max);
    onWidth(next);
    saveAskWidth(next);
  };

  function startDrag(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    stop.current?.(true);
    const el = e.currentTarget;
    const body = el.closest<HTMLElement>(".body");
    const startX = e.clientX;
    const startWidth = width;
    let last = width;
    let frame = 0;
    const paint = () => {
      frame = 0;
      body?.style.setProperty("--ask-width", `${last}px`);
      el.setAttribute("aria-valuenow", String(last));
      el.setAttribute("aria-valuetext", `${last} pixels`);
    };
    // The edge is on the left: moving it left widens the panel.
    const move = (ev: PointerEvent) => {
      if ((ev.buttons & 1) === 0) {
        end();
        return;
      }
      last = clampAskWidth(startWidth + (startX - ev.clientX), max);
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const end = () => stop.current?.(true);
    stop.current = (commit) => {
      stop.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
      el.removeEventListener("lostpointercapture", end);
      try {
        el.releasePointerCapture?.(e.pointerId);
      } catch {
        // Already released.
      }
      if (frame) cancelAnimationFrame(frame);
      el.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.removeProperty("user-select");
      if (!commit) return;
      paint();
      onWidth(last);
      saveAskWidth(last);
    };
    try {
      el.setPointerCapture?.(e.pointerId);
    } catch {
      // No capture (an old WebView): the window listeners still end the drag.
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    el.addEventListener("lostpointercapture", end);
    el.classList.add("dragging");
    // The resize pointer stays while the drag leaves the 6 px edge, and no text is selected on the way.
    document.body.style.cursor = "col-resize";
    document.body.style.setProperty("user-select", "none");
  }

  return (
    <div
      className="ask-sash"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the Ask panel"
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      aria-valuemin={ASK_WIDTH_MIN}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={startDrag}
      onDoubleClick={() => set(ASK_WIDTH_DEFAULT)}
      onKeyDown={(e) => {
        const to =
          e.key === "ArrowLeft" ? width + STEP : e.key === "ArrowRight" ? width - STEP : e.key === "Home" ? ASK_WIDTH_MIN : e.key === "End" ? max : null;
        if (to === null) return;
        e.preventDefault();
        set(to);
      }}
    />
  );
}
