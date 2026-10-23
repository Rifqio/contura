import { useSyncExternalStore } from "react";
import type { NullDisplay } from "../api/types";

/*
 * How the data grids draw SQL NULL, kept outside the prefs context: only the NULL cells in view
 * subscribe, so a prefs change that leaves it alone re-renders no grid row.
 */
let nullAs: NullDisplay = "null";
const listeners = new Set<() => void>();

export function setNullDisplay(next: NullDisplay): void {
  if (next === nullAs) return;
  nullAs = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

const current = () => nullAs;

export function useNullDisplay(): NullDisplay {
  return useSyncExternalStore(subscribe, current, current);
}

/** Drawn text for each choice; blank draws nothing. */
export const NULL_TEXT: Record<NullDisplay, string> = { null: "NULL", symbol: "∅", blank: "" };

/**
 * A SQL NULL as the Appearance page says: the word, the empty-set sign, or blank. The sign and blank
 * still read "NULL" to a screen reader, so NULL never sounds like an empty string.
 */
export function NullMark({ className = "cell-null" }: { className?: string }) {
  const as = useNullDisplay();
  if (as === "null") return <span className={className}>NULL</span>;
  return (
    <span className={as === "blank" ? `${className} cell-null-blank` : className}>
      {as === "symbol" && <span aria-hidden="true">{NULL_TEXT.symbol}</span>}
      <span className="visually-hidden">NULL</span>
    </span>
  );
}
