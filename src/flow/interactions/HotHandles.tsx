// The handles a hovered or selected shape shows (boards DiagramEditInPlace and DiagramAddNext): "+ member" under a
// class card (CL1, draw.io's add rows), and in step 6 a + on each side that adds the next shape. They are drawn for
// one shape at a time in the canvas overlay, never per node, so 2,000 shapes at rest add nothing; the pointer only
// moves a small store (memory is a requirement).
import { type ReactNode, useSyncExternalStore } from "react";
import Icon from "../../components/Icon";
import type { Box } from "./geometry";

export interface HotStore {
  get(): string | null;
  set(node: string | null): void;
  subscribe(fn: () => void): () => void;
}

/** How long the handles stay after the pointer leaves the shape, so it can reach a + outside it. */
const LINGER_MS = 300;

export function createHotStore(): HotStore & { leave(): void; keep(): void; dispose(): void } {
  let cur: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const subs = new Set<() => void>();
  const set = (node: string | null) => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (node === cur) return;
    cur = node;
    for (const fn of subs) fn();
  };
  return {
    get: () => cur,
    set,
    /** The pointer left the shape and its handles: they go after a moment. */
    leave() {
      // One timer for the whole time the pointer is away, not one per frame.
      if (cur !== null && timer === undefined) timer = setTimeout(() => set(null), LINGER_MS);
    },
    /** The tab goes: no timer outlives it (M2). */
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      subs.clear();
    },
    /** The pointer is on a handle: the shape stays hot. */
    keep() {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

interface Props {
  store: HotStore;
  /** The one selected shape: its handles show too (draw.io). */
  selected: string | null;
  /** Where a shape is drawn, or null when it has no handles. */
  boxOf(node: string): Box | null;
  /** A class, interface or enum: "+ member" under it. */
  hasMembers(node: string): boolean;
  onAddMember(node: string): void;
  /** Step 6: the + on each side. */
  sides?(node: string, box: Box): ReactNode;
}

export default function HotHandles({ store, selected, boxOf, hasMembers, onAddMember, sides }: Props) {
  const hot = useSyncExternalStore(store.subscribe, store.get) ?? selected;
  if (hot === null) return null;
  const box = boxOf(hot);
  if (!box) return null;
  return (
    <span className="flow-hot" data-hot={hot}>
      {hasMembers(hot) && (
        <button
          type="button"
          className="flow-hot-member nodrag nopan"
          aria-label="Add member"
          style={{ left: `${box.x}px`, top: `${box.y + box.h + 4}px` }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onAddMember(hot);
          }}
        >
          <Icon name="plus" size={14} />
          member
        </button>
      )}
      {sides?.(hot, box)}
    </span>
  );
}
