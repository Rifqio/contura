/** A clear of saved AI threads made outside the Assistant panel (Settings, Privacy), so an open panel drops them. */
type Listener = (place: string | null) => void;

const listeners = new Set<Listener>();

/** Tells every open panel that `place`'s threads were cleared; null clears every place. */
export function threadsCleared(place: string | null): void {
  for (const listener of [...listeners]) listener(place);
}

/** Calls `listener` on each clear; returns the unsubscribe. */
export function onThreadsCleared(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
