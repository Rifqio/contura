// What the canvas draws over the nodes while you edit, in flow coordinates (React Flow's viewport portal): the
// landing cell and alignment guides of a drag, the group a dragged node would join, and a drawn flow waiting on
// the "Add and connect" menu or pulling back. Drag frames update a small store, not the tab, so a drag never
// re-renders the text pane.
import { ViewportPortal } from "@xyflow/react";
import { type ReactNode, useSyncExternalStore } from "react";
import { ARROW_MARKER } from "../../diagram/edges";
import type { Box, Guide } from "./geometry";

export interface OverlayState {
  /** The grid cell the dragged node lands on. */
  ghost: Box | null;
  guides: Guide[];
  /** The area of the group the dragged node is over ("drop here"). */
  hot: Box | null;
  /** A drawn flow with no node at its end yet: its path, and whether it is pulling back into its port. */
  pending: { d: string; pulling: boolean } | null;
}

const EMPTY: OverlayState = { ghost: null, guides: [], hot: null, pending: null };

export interface OverlayStore {
  get(): OverlayState;
  set(next: Partial<OverlayState>): void;
  subscribe(fn: () => void): () => void;
}

export function createOverlayStore(): OverlayStore {
  let state = EMPTY;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      state = { ...state, ...next };
      for (const fn of subs) fn();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

const px = (n: number) => `${n}px`;

/** Drawn inside the canvas (DiagramCanvas `overlay`); `children` adds the label box. */
export function CanvasOverlay({ store, children }: { store: OverlayStore; children?: ReactNode }) {
  const s = useSyncExternalStore(store.subscribe, store.get);
  return (
    <ViewportPortal>
      {s.hot && <div className="flow-group-hot" aria-hidden="true" style={{ left: px(s.hot.x), top: px(s.hot.y), width: px(s.hot.w), height: px(s.hot.h) }} />}
      {s.ghost && <div className="flow-ghost" aria-hidden="true" style={{ left: px(s.ghost.x), top: px(s.ghost.y), width: px(s.ghost.w), height: px(s.ghost.h) }} />}
      {s.guides.map((g) => (
        <div
          key={`${g.axis}:${g.at}`}
          className="flow-guide"
          aria-hidden="true"
          style={
            g.axis === "x"
              ? { left: px(g.at), top: px(g.from), width: "1px", height: px(g.to - g.from) }
              : { left: px(g.from), top: px(g.at), width: px(g.to - g.from), height: "1px" }
          }
        />
      ))}
      {s.pending && (
        <svg className="flow-overlay-svg" width="1" height="1" aria-hidden="true">
          <path className={s.pending.pulling ? "flow-pending is-pulling" : "flow-pending"} d={s.pending.d} markerEnd={`url(#${ARROW_MARKER})`} />
        </svg>
      )}
      {children}
    </ViewportPortal>
  );
}
