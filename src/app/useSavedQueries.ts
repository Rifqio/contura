import { type SetStateAction, useState } from "react";
import { errorText, listSavedQueries } from "../api/client";
import type { SavedQuery } from "../api/types";
import type { WorkTab } from "../shell/tabs";

export function useSavedQueries(opts: {
  setTabs(next: SetStateAction<WorkTab[]>): void;
  onError(text: string): void;
}): {
  savedQueries: SavedQuery[];
  /** Startup: an unreadable list is empty. */
  load(): void;
  /** A renamed Saved Query renames its open tab; a deleted one leaves the tab as a plain query. */
  reloadSaved(): void;
  /** A query tab saved one: it replaces its old copy, sorted by name ignoring case. */
  savedOne(q: SavedQuery): void;
} {
  const { setTabs, onError } = opts;
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);

  function load() {
    listSavedQueries().then(setSavedQueries).catch(() => setSavedQueries([]));
  }

  function reloadSaved() {
    listSavedQueries()
      .then((all) => {
        setSavedQueries(all);
        // A renamed Saved Query renames its open tab; a deleted one leaves the tab as a plain query.
        setTabs((ts) =>
          ts.map((t) => {
            if (t.kind === "visual" && t.doc.savedId) {
              const v = all.find((x) => x.id === t.doc.savedId);
              if (v && v.name === t.doc.name) return t;
              return { kind: "visual", doc: v ? { ...t.doc, name: v.name } : { ...t.doc, savedId: null, savedJson: null } };
            }
            if (t.kind !== "query" || !t.doc.savedId) return t;
            const q = all.find((x) => x.id === t.doc.savedId);
            return {
              kind: "query",
              doc: q ? { ...t.doc, name: q.name } : { ...t.doc, savedId: null, savedText: null },
            };
          }),
        );
      })
      .catch((e) => onError(errorText(e)));
  }

  function savedOne(q: SavedQuery) {
    setSavedQueries((all) =>
      [...all.filter((x) => x.id !== q.id), q].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, {
          sensitivity: "base",
        }),
      ),
    );
  }

  return { savedQueries, load, reloadSaved, savedOne };
}
