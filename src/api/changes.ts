/** A change made through the Core that open views read again on, so they never wait for a reopen. */
export interface Change {
  /** Tells every listener. */
  emit(): void;
  /** Calls `listener` on each change; returns the unsubscribe. */
  on(listener: () => void): () => void;
}

function change(): Change {
  const listeners = new Set<() => void>();
  return {
    emit() {
      for (const listener of [...listeners]) listener();
    },
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** A thread was saved or a tool outcome recorded: Recent tool uses reads its list again. */
export const toolUsesChanged = change();

/**
 * The AI settings or the current model were saved. The diagram assistant, which stays open beside a Settings tab,
 * reads its model list again; the Ask panel and the inline box read it when they mount, and they are not mounted
 * while Settings is the active tab.
 */
export const aiSettingsChanged = change();
