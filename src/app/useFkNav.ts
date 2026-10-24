// UX step 8 (G8): the window side of following a Foreign Key. A followed key opens its table through the open-table
// path (a single click's preview tab; an open tab of the table is reused) and hands that tab's grid a request: the
// key as its filter, the row to select and what to say. A preview tab you follow a key from is kept (VS Code). Back
// and Forward walk one history per window with browser semantics, opening a closed tab again.
import { type SetStateAction, useEffect, useRef, useState } from "react";
import type { GridControl } from "../components/DataGrid";
import type { FollowRequest, GridJump } from "../grid/foreignKeys";
import { type NavHistory, type NavSpot, emptyNav, navBack, navForward, navPush } from "../grid/navHistory";
import { objectKey } from "../objectPath";
import { type WorkTab, placeObject } from "../shell/tabs";

interface Options {
  tabs: WorkTab[];
  setTabs(next: SetStateAction<WorkTab[]>): void;
  activeKey: string | null;
  setActiveKey(key: string): void;
  /** Tabs with Pending Edits: a preview tab with them is never replaced. */
  dirty(): ReadonlySet<string>;
  /** The grid of a table tab, which knows where it is. */
  control(key: string): GridControl | null;
  /** The place the tabs belong to: its history goes when it changes. */
  place: string;
  /** Says what happened where no table tab is shown to say it ("Nothing to go back to."). */
  say?(text: string): void;
}

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
/** The Import and Transfer wizards, which handle Alt+Left as their Back. */
const WIZARDS = ".import-tab, .transfer-tab";

/**
 * Alt+Left and Alt+Right go Back and Forward only with focus in a grid, the tree or a tab's content: a focused strip
 * tab keeps its move, a field or an editor keeps its own keys, and a wizard keeps both. DataGrip's
 * Ctrl+Alt+Left and the command run from a menu (no keys) work everywhere.
 */
export function backKeyApplies(keys: string | null, focus: Element | null): boolean {
  if (keys === null || keys.startsWith("Ctrl+Alt+")) return true;
  if (!focus || focus === document.body) return false;
  // A wizard's Alt+Left is its own Back; its Alt+Right does not leave it either.
  if (focus.closest('[role="tablist"]') || focus.closest(EDITABLE) || focus.closest(WIZARDS)) return false;
  return !!focus.closest('.work-pane, [role="tree"]');
}

export function useFkNav({ tabs, setTabs, activeKey, setActiveKey, dirty, control, place, say }: Options) {
  const [history, setHistory] = useState<NavHistory>(emptyNav);
  const [jumps, setJumps] = useState<Record<string, GridJump>>({});
  const seq = useRef(0);
  const historyRef = useRef(history);
  historyRef.current = history;

  // The history belongs to the place's tabs.
  const placeRef = useRef(place);
  useEffect(() => {
    if (placeRef.current === place) return;
    placeRef.current = place;
    setHistory(emptyNav);
  }, [place]);

  // A closed tab's request goes with it, so a tab opened again later starts fresh.
  useEffect(() => {
    const open = new Set(tabs.map((t) => (t.kind === "object" ? t.key : "")));
    setJumps((j) => (Object.keys(j).every((k) => open.has(k)) ? j : Object.fromEntries(Object.entries(j).filter(([k]) => open.has(k)))));
  }, [tabs]);

  function ask(key: string, jump: Omit<GridJump, "seq">) {
    setJumps((j) => ({ ...j, [key]: { ...jump, seq: ++seq.current } }));
  }

  /** Where a table tab is now, from its grid. */
  function spotOf(key: string | null): NavSpot | null {
    const t = tabs.find((x) => x.kind === "object" && x.key === key);
    if (!t || t.kind !== "object" || key === null) return null;
    const at = control(key)?.location?.();
    return {
      key,
      selection: t.selection,
      preview: !!t.preview,
      filters: at?.filters ?? [],
      where: at?.where ?? null,
      page: at?.page ?? 0,
      sort: at?.sort ?? null,
      cell: at?.cell ?? null,
    };
  }

  function follow(sourceKey: string, req: FollowRequest) {
    const from = spotOf(sourceKey);
    if (from) setHistory((h) => navPush(h, { ...from, preview: false }));
    const source = tabs.find((t) => t.kind === "object" && t.key === sourceKey);
    if (!source || source.kind !== "object") return;
    const selection = { connectionId: source.selection.connectionId, kind: "table" as const, path: req.way.path };
    const key = objectKey(selection.connectionId, "table", req.way.path);
    setTabs((all) => {
      const kept = all.map((t) => (t.kind === "object" && t.key === sourceKey && t.preview ? { ...t, preview: false } : t));
      return placeObject(kept, selection, key, false, dirty());
    });
    setActiveKey(key);
    const out = req.way.dir === "out";
    ask(key, {
      filters: req.filters,
      where: req.where,
      page: 0,
      select: { row: 0, column: req.filters[req.filters.length - 1]?.column ?? "", wholeRow: out },
      say: out ? { kind: "out", fromTable: req.from.table, fromRow: req.from.row } : { kind: "in", toTable: req.from.table, toKey: req.from.key },
    });
  }

  /** Shows a place of the history: its tab, opened again when it was closed, with its filters and cell. */
  function restore(to: NavSpot, kind: "back" | "forward") {
    setTabs((all) => {
      if (all.some((t) => t.kind === "object" && t.key === to.key)) return all;
      // A kept tab comes back as its own tab; a preview one takes the preview's place, as it was.
      return to.preview ? placeObject(all, to.selection, to.key, false, dirty()) : [...all, { kind: "object", key: to.key, selection: to.selection, preview: false }];
    });
    setActiveKey(to.key);
    // The sort and filter the tab had; the row by its key, so a changed page still finds it (M5).
    ask(to.key, { filters: to.filters, where: to.where, page: to.page, sort: to.sort, select: to.cell ? { ...to.cell, wholeRow: false } : null, say: { kind } });
  }

  function go(kind: "back" | "forward") {
    const here = spotOf(activeKey);
    const step = (kind === "back" ? navBack : navForward)(historyRef.current, here);
    if (!step) {
      const text = `Nothing to go ${kind} to.`;
      if (here) ask(here.key, { filters: here.filters, where: here.where, page: here.page, select: null, say: { kind: "none", text } });
      else say?.(text);
      return;
    }
    historyRef.current = step.history;
    setHistory(step.history);
    restore(step.to, kind);
  }

  const last = (list: NavSpot[]) => list[list.length - 1]?.selection.path.name ?? null;
  return {
    jumpFor: (key: string): GridJump | null => jumps[key] ?? null,
    follow,
    back: () => go("back"),
    forward: () => go("forward"),
    nav: { back: last(history.back), forward: last(history.forward) },
  };
}
