// One timed move on the canvas: a glide of node positions, a line pulling back. Every duration comes from
// motion.ts, so reduced motion (0 ms) applies the final state at once. A tween runs once and stops; nothing loops.
import type { Positions } from "../../diagram/layout";
import { emptyPositions } from "../layout";

/** The enter curve, cubic-bezier(.2, 0, 0, 1), as the motion design approximates it. */
export const easeEnter = (t: number) => 1 - (1 - t) ** 4;
/** The exit curve, cubic-bezier(.4, 0, 1, 1): slow start, fast end. */
export const easeExit = (t: number) => t * t;

const frame = (cb: (now: number) => void): (() => void) => {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(() => cb(performance.now()), 16);
  return () => clearTimeout(id);
};

/**
 * Calls `step` with the eased progress (0 to 1) on each frame for `ms`, then `done`. With `ms` 0 it calls
 * `step(1)` and `done` at once. Returns a cancel that stops it where it is (no `done`).
 */
export function tween(ms: number, step: (p: number) => void, done?: () => void, ease = easeEnter): () => void {
  if (ms <= 0) {
    step(1);
    done?.();
    return () => {};
  }
  let start: number | null = null;
  let cancel = () => {};
  let live = true;
  const tick = (now: number) => {
    if (!live) return;
    start ??= now;
    const t = Math.min(1, (now - start) / ms);
    step(ease(t));
    if (t < 1) cancel = frame(tick);
    else {
      live = false;
      done?.();
    }
  };
  cancel = frame(tick);
  return () => {
    live = false;
    cancel();
  };
}

/** Positions part of the way from `from` to `to` (names in `to` only; a name missing from `from` is at `to`). */
export function between(from: Positions, to: Positions, p: number): Positions {
  const out = emptyPositions();
  for (const k of Object.keys(to)) {
    const a = Object.prototype.hasOwnProperty.call(from, k) ? from[k] : to[k];
    const b = to[k];
    out[k] = p >= 1 ? b : { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p };
  }
  return out;
}

/** Runs `fn` after the next two frames: once a just-drawn element has painted, so a class change transitions. */
export function afterPaint(fn: () => void): () => void {
  let stop2 = () => {};
  const stop1 = frame(() => {
    stop2 = frame(() => fn());
  });
  return () => {
    stop1();
    stop2();
  };
}
