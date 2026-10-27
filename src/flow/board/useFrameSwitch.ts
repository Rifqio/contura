// Decision 29: FlowTab across a frame switch. Every per-frame thing FlowTab holds (the shape selection, the lines
// selected, an open field, band lines, glides, the node editor, a pending placement, the review focus) names shapes
// of one frame. A switch resets them all in one place, in a layout effect, so the effects that compare one doc with
// the next never see the new frame's doc beside the old frame's selection (a switch is never "every node deleted").
import { useLayoutEffect, useRef } from "react";

/**
 * Runs `reset` once each time `frameKey` (`frame#<id>`, null with nothing selected) changes after the first
 * render, in a layout effect: before the passive effects of the same commit, and before paint. Call it before any
 * other layout effect that reads the selection.
 */
export function useFrameSwitch(frameKey: string | null, reset: () => void): void {
  const was = useRef<string | null | undefined>(undefined);
  const latest = useRef(reset);
  latest.current = reset;
  useLayoutEffect(() => {
    const prev = was.current;
    was.current = frameKey;
    if (prev === undefined || prev === frameKey) return;
    latest.current();
  }, [frameKey]);
}
