// What the canvas draws over the nodes while you edit, in flow coordinates (React Flow's viewport portal): the
// group a dragged node would join (the canvas itself draws the alignment guides), and a drawn flow waiting on
// the "Add and connect" menu or pulling back. Drag frames update a small store, not the tab, so a drag never
// re-renders the text pane.
import { ViewportLayer } from "../../diagram/canvasLayers";
import { type ReactNode, useSyncExternalStore } from "react";
import { ARROW_MARKER } from "../../diagram/edges";
import type { Box } from "./geometry";

export interface OverlayState {
  /** The area of the group the dragged node is over ("drop here"). */
  hot: Box | null;
  /** A drawn flow with no node at its end yet: its path, and whether it is pulling back into its port. */
  pending: { d: string; pulling: boolean } | null;
}

const EMPTY: OverlayState = { hot: null, pending: null };

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

/**
 * Drawn inside the canvas (DiagramCanvas `overlay`). `children` (the label box, the fields, the ghosts) and the store's
 * own drawing are the live frame's, in its own units: they hang from `at`, the live frame's place on the board, as its
 * shapes hang from the live anchor (Plan F Decision 11). `board` is drawn in board units (the sketch preview and field).
 */
export function CanvasOverlay({ store, at, board, children }: { store: OverlayStore; at?: { x: number; y: number }; board?: ReactNode; children?: ReactNode }) {
  const s = useSyncExternalStore(store.subscribe, store.get);
  return (
    <ViewportLayer>
      {board}
      <div className="flow-overlay-live" style={{ left: px(at?.x ?? 0), top: px(at?.y ?? 0) }}>
        {s.hot && <div className="flow-group-hot" aria-hidden="true" style={{ left: px(s.hot.x), top: px(s.hot.y), width: px(s.hot.w), height: px(s.hot.h) }} />}
        {s.pending && (
          <svg className="flow-overlay-svg" width="1" height="1" aria-hidden="true">
            <path className={s.pending.pulling ? "flow-pending is-pulling" : "flow-pending"} d={s.pending.d} markerEnd={`url(#${ARROW_MARKER})`} />
          </svg>
        )}
        {children}
      </div>
    </ViewportLayer>
  );
}
