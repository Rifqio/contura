/** Whether the Ask panel's Sends list shows its rows; folded by default, remembered on this computer. */
export const SENDS_OPEN_KEY = "contura.sends.open";
const EVENT = "contura:sends-open";

export function loadSendsOpen(): boolean {
  try {
    return localStorage.getItem(SENDS_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** Remembers the choice and tells every open Sends list and the Settings switch. */
export function saveSendsOpen(open: boolean) {
  try {
    localStorage.setItem(SENDS_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Remembering the fold is a convenience only.
  }
  window.dispatchEvent(new CustomEvent<boolean>(EVENT, { detail: open }));
}

/** Calls `f` with each new choice; returns the unsubscribe. */
export function onSendsOpen(f: (open: boolean) => void): () => void {
  const listener = (e: Event) => f((e as CustomEvent<boolean>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
