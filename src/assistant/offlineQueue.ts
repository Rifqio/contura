/**
 * Questions kept while this PC is offline. The panel and the inline box both queue here, so one `online` event
 * sends them one at a time, oldest first, each after the previous one settled.
 */
type Send = () => Promise<void>;

const queue = new Map<string, Send>();
let listening = false;
let draining = false;

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.size > 0) {
      const [key, send] = queue.entries().next().value as [string, Send];
      queue.delete(key);
      try {
        await send();
      } catch (e) {
        // A failed send must not hold back the others, and it is never silent.
        console.error("A queued question could not be sent.", e);
      }
    }
  } finally {
    draining = false;
  }
}

function onOnline() {
  void drain();
}

/**
 * Keeps `send` until the window's `online` event. A key queued twice keeps the latest send (and its place at the end).
 * Returns a cancel that removes this send, and only this one.
 */
export function queueOffline(key: string, send: Send): () => void {
  queue.delete(key);
  queue.set(key, send);
  if (!listening) {
    listening = true;
    window.addEventListener("online", onOnline);
  }
  return () => {
    if (queue.get(key) === send) queue.delete(key);
  };
}
