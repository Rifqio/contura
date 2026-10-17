import type { SetStateAction } from "react";
import type { QueryTabDoc } from "../query/QueryTab";
import { type WindowTab, type WorkTab, afterClose, tabKey } from "../shell/tabs";

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
  /** Shows the tab of the same file, else adds `tab`. */
  | { type: "openSchema"; tab: SchemaTab };

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
    case "openSchema": {
      const { tab } = action;
      const w = state.windowTabs;
      const open = tab.doc.path ? w.find((t) => t.kind === "schema" && t.doc.path === tab.doc.path) : undefined;
      if (open) return { ...state, activeKey: tabKey(open) };
      return { ...state, windowTabs: [...w, tab], activeKey: tabKey(tab) };
    }
  }
}
