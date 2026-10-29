// The canvas zoom as `--rz-zoom`, written only on the elements that read it (Task 9 fix 2): the frame tabs keep their
// screen size by it and the resize zones their screen width. Written on `.react-flow`, an inherited custom property
// changed on every zoom frame of a glide restyled every node on the canvas; written on a few elements, only they are.
import { createContext, type RefCallback, useCallback, useContext } from "react";

/** The elements of one canvas that read the zoom, and the zoom they were last given. */
export interface ZoomTargets {
  /**
   * Takes `el` until the returned function is called, giving it the zoom now and at every change; with `cap`, the zoom
   * up to `cap` (an element that reads min(zoom, cap) is not restyled past it).
   */
  add(el: HTMLElement, cap?: number): () => void;
  /** The canvas zoom changed: every element takes it. */
  set(zoom: number): void;
}

export function createZoomTargets(): ZoomTargets {
  /** Each element, its cap and the value it was last given. */
  const els = new Map<HTMLElement, { cap: number; value: string }>();
  let zoom = 1;
  const give = (el: HTMLElement, t: { cap: number; value: string }) => {
    const value = String(Math.min(zoom, t.cap));
    if (value === t.value) return;
    t.value = value;
    el.style.setProperty("--rz-zoom", value);
  };
  return {
    add(el, cap = Infinity) {
      const t = { cap, value: "" };
      els.set(el, t);
      give(el, t);
      return () => void els.delete(el);
    },
    set(next) {
      zoom = next || 1;
      for (const [el, t] of els) give(el, t);
    },
  };
}

export const ZoomTargetsContext = createContext<ZoomTargets | null>(null);

/**
 * A ref that gives its element the canvas zoom as `--rz-zoom` while it is on the page (no canvas: none, CSS's 1), up to
 * `cap` when it reads only min(zoom, cap).
 */
export function useZoomVar<T extends HTMLElement = HTMLElement>(cap?: number): RefCallback<T> {
  const targets = useContext(ZoomTargetsContext);
  return useCallback((el: T | null) => (el && targets ? targets.add(el, cap) : undefined), [targets, cap]);
}
