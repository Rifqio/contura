import { type MutableRefObject, useEffect, useRef } from "react";
import { loadQueryTabs, saveQueryTabs } from "../api/client";
import { parseDraftOrder, parseDrafts, placeKey, serializeDrafts } from "../query/drafts";
import type { QueryTabDoc } from "../query/QueryTab";
import type { Place, VisualTabDoc, WorkTab } from "../shell/tabs";
import { keptVisualDrafts, parseVisualDrafts } from "../visualquery/drafts";
import { tabKey } from "../shell/tabs";

/** How long typing pauses before the query tab drafts are saved. */
export const DRAFT_SAVE_MS = 500;

export interface PlaceDrafts {
  /** The place shown now, set before React draws it, so an open that awaited can tell you went elsewhere. */
  placeNow: MutableRefObject<Place>;
  /** Counts every move (R23). */
  visit: MutableRefObject<number>;
  /** Runs `run` once `place`'s drafts are in the tabs: now if they are, or when they load. Dropped if you are elsewhere. */
  whenDraftsLoaded(place: Place, run: () => void): void;
  /** goTo's first half: saves this place's drafts at once, drops a queued open, points placeNow at `next`, counts a visit. */
  leaveFor(next: Place): void;
  /** goHome: counts a visit and drops a queued open. */
  dropQueued(): void;
}

export function usePlaceDrafts(opts: {
  place: Place;
  tabs: WorkTab[];
  /** startup.s === "ready" */
  ready: boolean;
  /** The place's drafts were read (empty when none or the read failed); called before the queued open runs. */
  onRestored(docs: QueryTabDoc[], visual: VisualTabDoc[], order: string[]): void;
}): PlaceDrafts {
  /** The place whose drafts are loaded, so saving never overwrites drafts not yet read. */
  const draftsLoaded = useRef<string | null>(null);
  /** An open waiting for a place's drafts, so a restored draft is found instead of duplicated (Recent). */
  const afterDrafts = useRef<{ key: string; run: () => void } | null>(null);
  /** The place shown now and a count of every move, so an open that awaited can tell you went elsewhere. */
  const placeNow = useRef<Place>(opts.place);
  const visit = useRef(0);
  const onRestoredRef = useRef(opts.onRestored);
  onRestoredRef.current = opts.onRestored;

  function runAfterDrafts(key: string) {
    const pending = afterDrafts.current;
    afterDrafts.current = null;
    // An open for another place is dropped, never kept for a later visit (ruling R23).
    if (pending?.key !== key) return;
    pending.run();
  }

  /** Runs `run` once `place`'s drafts are in the tabs: now if they are, or when they load. Dropped if you are elsewhere. */
  function whenDraftsLoaded(place: Place, run: () => void) {
    const key = placeKey(place);
    if (placeKey(placeNow.current) !== key) return;
    if (draftsLoaded.current === key) run();
    else afterDrafts.current = { key, run };
  }

  const draftKey = placeKey(opts.place);
  const queryDocs = opts.tabs.flatMap((t) => (t.kind === "query" ? [t.doc] : []));
  const visualDocs = opts.tabs.flatMap((t) => (t.kind === "visual" ? [t.doc] : []));
  /** Visual drafts of the loaded place this build cannot open, kept for the next save. */
  const kept = useRef<{ key: string; entries: unknown[] }>({ key: "", entries: [] });
  const order = opts.tabs.flatMap((t) => (t.kind === "query" || t.kind === "visual" ? [tabKey(t)] : []));
  const draftsJson = serializeDrafts(queryDocs, visualDocs, { order, kept: kept.current.key === draftKey ? kept.current.entries : [] });

  // Entering a place brings back its query and Visual Query tabs.
  useEffect(() => {
    if (!opts.ready) return;
    let live = true;
    draftsLoaded.current = null;
    const restore = (docs: QueryTabDoc[], visual: VisualTabDoc[], order: string[], keep: unknown[]) => {
      if (!live) return;
      kept.current = { key: draftKey, entries: keep };
      onRestoredRef.current(docs, visual, order);
      draftsLoaded.current = draftKey;
      runAfterDrafts(draftKey);
    };
    loadQueryTabs(draftKey)
      .then((json) =>
        json ? restore(parseDrafts(json), parseVisualDrafts(json), parseDraftOrder(json), keptVisualDrafts(json)) : restore([], [], [], []),
      )
      .catch(() => restore([], [], [], []));
    return () => {
      live = false;
    };
  }, [draftKey, opts.ready]);

  useEffect(() => {
    if (draftsLoaded.current !== draftKey) return;
    const t = setTimeout(() => void saveQueryTabs(draftKey, draftsJson).catch(() => {}), DRAFT_SAVE_MS);
    return () => clearTimeout(t);
  }, [draftsJson, draftKey]);

  function leaveFor(next: Place) {
    // Save this place's drafts now: the debounced save would be cancelled by the switch.
    if (draftsLoaded.current === draftKey) void saveQueryTabs(draftKey, draftsJson).catch(() => {});
    draftsLoaded.current = null;
    afterDrafts.current = null;
    placeNow.current = next;
    visit.current++;
  }

  function dropQueued() {
    visit.current++;
    afterDrafts.current = null;
  }

  return { placeNow, visit, whenDraftsLoaded, leaveFor, dropQueued };
}
