import { clearAllSteps, clearSteps } from "./recentSteps";

/** A clear of saved AI threads made outside the Assistant panel (Settings, Privacy), so an open panel drops them. */
type Listener = (place: string | null) => void;

const listeners = new Set<Listener>();

/** The place a clear of every board's chats names (Settings' Clear AI history also clears them, boards having no Group). */
export const DIAGRAM_CHATS = "diagram:*";

/** Tells every open panel that `place`'s threads were cleared; null clears every place. */
export function threadsCleared(place: string | null): void {
  // The place's Recent steps go with its threads, whether a panel is open or not.
  if (place === null) clearAllSteps();
  else clearSteps(place);
  for (const listener of [...listeners]) listener(place);
}

/** Calls `listener` on each clear; returns the unsubscribe. */
export function onThreadsCleared(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
