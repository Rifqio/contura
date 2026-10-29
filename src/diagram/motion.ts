// The diagram canvas's one motion table (DESIGN.md 8). Every timed move on the canvas
// reads its duration here, so reduced motion turns all of them into 0 in one place. Nothing loops.

/** Milliseconds per interaction: 80 hover and press, 120 small moves, 180 toasts, 240 canvas moves. */
export const MOTION = {
  /** Border to the kind colour on hover. */
  hover: 80,
  /** The four round ports fade in. */
  ports: 120,
  /** A dragged node settles into its cell. */
  settle: 120,
  /** A drawn flow locks onto a node. */
  lock: 80,
  /** The "Add and connect" menu and the label box. */
  menu: 120,
  /** Esc pulls a drawn flow back into its port. */
  pullBack: 120,
  /** A new node fades in from 96 percent. */
  enter: 120,
  /** A deleted node and its lines fade out. */
  exit: 120,
  /** Undo glides nodes back. */
  undo: 120,
  /** The "Moved Checkout back" toast. */
  toast: 180,
  /** The selected node's text line is banded. */
  band: 120,
  /** Tidy glides every node to its place. */
  tidy: 240,
  /** Zoom to fit and the minimap jump. */
  fit: 240,
  /** Dragging over a group turns its edge accent and solid; joining and growing use `settle`. */
  group: 80,
} as const;

export type MotionKey = keyof typeof MOTION;

/** Enter easing (DESIGN.md 8), the same curve as `--ease-enter`. */
export const EASE_IN = "cubic-bezier(.2, 0, 0, 1)";
/** Exit easing (DESIGN.md 8), the same curve as `--ease-exit`; exits are faster than enters. */
export const EASE_OUT = "cubic-bezier(.4, 0, 1, 1)";

let appPref = false;

/**
 * The app's own reduced-motion preference. It also marks the root element so the CSS motion tokens
 * drop to 0 ms with it, as they do under the system setting.
 */
export function setReducedMotionPref(on: boolean): void {
  appPref = on;
  if (typeof document === "undefined") return;
  if (on) document.documentElement.setAttribute("data-reduced-motion", "");
  else document.documentElement.removeAttribute("data-reduced-motion");
}

/** True under `prefers-reduced-motion` (Windows "Animation effects" off) or the app's preference. */
export function reducedMotion(): boolean {
  if (appPref) return true;
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The duration to use now: the table's value, or 0 under reduced motion. */
export function motionMs(key: MotionKey): number {
  return reducedMotion() ? 0 : MOTION[key];
}

/** The one option every view move on the board reads (zoom to frame, fit, Add's glide, the pane's glide): `duration: 0` under reduced motion. */
export function glideOptions(): { duration: number } {
  return { duration: motionMs("fit") };
}
