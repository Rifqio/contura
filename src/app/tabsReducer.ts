import type { SetStateAction } from "react";
import type { QueryTabDoc } from "../query/QueryTab";
import { type CompareSeed, type TransferSeed, type VisualTabDoc, type WindowTab, type WorkTab, afterClose, tabKey } from "../shell/tabs";

/** The place's tabs, the window's tabs and the active tab, in one state so each step sees the ones before it. */
export interface TabsState {
  tabs: WorkTab[];
  windowTabs: WindowTab[];
  activeKey: string | null;
}

export type SchemaTab = Extract<WindowTab, { kind: "schema" }>;

export type TabsAction =
  | { type: "tabs"; next: SetStateAction<WorkTab[]> }
  | { type: "windowTabs"; next: SetStateAction<WindowTab[]> }
  | { type: "active"; next: SetStateAction<string | null> }
  /** Removes matching place tabs, keeping the active tab when it stays, else its nearest kept neighbour in `order`. */
  | { type: "remove"; drop: (t: WorkTab) => boolean; order: string[] }
  /** Shows the tab of the same Saved Query (a restored draft included), else adds `doc`. */
  | { type: "openSaved"; doc: QueryTabDoc }
  /** Shows the tab of the same saved Visual Query (a restored draft included), else adds `doc`. */
  | { type: "openVisual"; doc: VisualTabDoc }
  /** Shows the tab of the same file, else adds `tab`. */
  | { type: "openSchema"; tab: SchemaTab }
  /** Shows the tab of diagram `name`, else adds one. */
  | { type: "openFlow"; name: string }
  /** Puts diagram `to` in the place of the tab of diagram `from` (a rename); active stays active. */
  | { type: "renameFlow"; from: string; to: string }
  /** Adds a Data Transfer tab and shows it; every Transfer data... starts its own. */
  | { type: "openTransfer"; id: string; seed: TransferSeed }
  /** A Data Transfer tab's title and mark, as the tab reports them. */
  | { type: "transferMeta"; id: string; title: string; dirty: boolean }
  /** Adds a Schema Compare tab and shows it; every Schema Compare starts its own. */
  | { type: "openCompare"; id: string; seed: CompareSeed }
  /** A Schema Compare tab's title and target Connection, as the tab reports them. */
  | { type: "compareMeta"; id: string; title: string; connectionId: string | null };

function apply<T>(prev: T, next: SetStateAction<T>): T {
  return typeof next === "function" ? (next as (p: T) => T)(prev) : next;
}

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case "tabs": {
      const tabs = apply(state.tabs, action.next);
      return tabs === state.tabs ? state : { ...state, tabs };
    }
    case "windowTabs": {
      const windowTabs = apply(state.windowTabs, action.next);
      return windowTabs === state.windowTabs ? state : { ...state, windowTabs };
    }
    case "active": {
      const activeKey = apply(state.activeKey, action.next);
      return activeKey === state.activeKey ? state : { ...state, activeKey };
    }
    case "remove": {
      const { drop, order } = action;
      const all = state.tabs;
      const gone = new Set(all.filter(drop).map(tabKey));
      if (gone.size === 0) return state;
      const a = state.activeKey;
      const activeKey = a === null || !gone.has(a) ? a : afterClose(order.filter((k) => k === a || !gone.has(k)), a, a);
      return { ...state, tabs: all.filter((t) => !drop(t)), activeKey };
    }
    case "openSaved": {
      const { doc } = action;
      const all = state.tabs;
      // Worked out on the latest tabs, so a draft of this Saved Query restored just now is reused.
      const found = all.find((t) => t.kind === "query" && doc.savedId !== null && t.doc.savedId === doc.savedId);
      if (found) return { ...state, activeKey: tabKey(found) };
      return { ...state, tabs: [...all, { kind: "query", doc }], activeKey: tabKey({ kind: "query", doc }) };
    }
    case "openVisual": {
      const { doc } = action;
      const all = state.tabs;
      const found = all.find((t) => t.kind === "visual" && doc.savedId !== null && t.doc.savedId === doc.savedId);
      if (found) return { ...state, activeKey: tabKey(found) };
      return { ...state, tabs: [...all, { kind: "visual", doc }], activeKey: tabKey({ kind: "visual", doc }) };
    }
    case "openSchema": {
      const { tab } = action;
      const w = state.windowTabs;
      const open = tab.doc.path ? w.find((t) => t.kind === "schema" && t.doc.path === tab.doc.path) : undefined;
      if (open) return { ...state, activeKey: tabKey(open) };
      return { ...state, windowTabs: [...w, tab], activeKey: tabKey(tab) };
    }
    case "openFlow": {
      // Windows names are not case-sensitive: Checkout and checkout are one file, so one tab.
      const want = action.name.toLowerCase();
      const open = state.windowTabs.find((t) => t.kind === "flow" && t.name.toLowerCase() === want);
      if (open) return { ...state, activeKey: tabKey(open) };
      const tab: WindowTab = { kind: "flow", name: action.name };
      return { ...state, windowTabs: [...state.windowTabs, tab], activeKey: tabKey(tab) };
    }
    case "renameFlow": {
      const at = state.windowTabs.findIndex((t) => t.kind === "flow" && t.name === action.from);
      if (at < 0) return state;
      const old = state.windowTabs[at];
      const tab: WindowTab = { kind: "flow", name: action.to };
      const windowTabs = state.windowTabs.map((t, i) => (i === at ? tab : t));
      return { ...state, windowTabs, activeKey: state.activeKey === tabKey(old) ? tabKey(tab) : state.activeKey };
    }
    case "openTransfer": {
      const tab: WindowTab = { kind: "transfer", id: action.id, seed: action.seed, title: "Data Transfer", dirty: true };
      return { ...state, windowTabs: [...state.windowTabs, tab], activeKey: tabKey(tab) };
    }
    case "transferMeta": {
      const { id, title, dirty } = action;
      const at = state.windowTabs.findIndex((t) => t.kind === "transfer" && t.id === id);
      const old = state.windowTabs[at];
      if (!old || old.kind !== "transfer" || (old.title === title && old.dirty === dirty)) return state;
      const windowTabs = state.windowTabs.map((t, i) => (i === at ? { ...old, title, dirty } : t));
      return { ...state, windowTabs };
    }
    case "openCompare": {
      const tab: WindowTab = { kind: "compare", id: action.id, seed: action.seed, title: "Schema Compare", connectionId: action.seed.target?.connectionId ?? null };
      return { ...state, windowTabs: [...state.windowTabs, tab], activeKey: tabKey(tab) };
    }
    case "compareMeta": {
      const { id, title, connectionId } = action;
      const at = state.windowTabs.findIndex((t) => t.kind === "compare" && t.id === id);
      const old = state.windowTabs[at];
      if (!old || old.kind !== "compare" || (old.title === title && old.connectionId === connectionId)) return state;
      const windowTabs = state.windowTabs.map((t, i) => (i === at ? { ...old, title, connectionId } : t));
      return { ...state, windowTabs };
    }
  }
}
