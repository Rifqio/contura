import { type MutableRefObject, type SetStateAction, useCallback, useEffect, useLayoutEffect, useReducer, useRef } from "react";
import type { QueryTabDoc } from "../query/QueryTab";
import { type AnyTab, type TransferSeed, type VisualTabDoc, type WindowTab, type WorkTab, afterClose, stripOrder, tabKey } from "../shell/tabs";
import { type SchemaTab, tabsReducer } from "./tabsReducer";

/** The place's tabs, the window's tabs and the active tab, on one reducer so no setter runs inside another's updater. */
export function useWorkspaceTabs() {
  const [state, dispatch] = useReducer(tabsReducer, { tabs: [], windowTabs: [], activeKey: null });
  /** The place's tabs: queries and tables (PR5). */
  const tabs = state.tabs;
  /** The window's tabs, in the order they were opened: Home, Settings, Schema Models. */
  const windowTabs = state.windowTabs;
  /** The active tab by key; null shows the place with no tab chosen. */
  const activeKey = state.activeKey;
  const setTabs = useCallback((next: SetStateAction<WorkTab[]>) => dispatch({ type: "tabs", next }), []);
  const setWindowTabs = useCallback((next: SetStateAction<WindowTab[]>) => dispatch({ type: "windowTabs", next }), []);
  const setActiveKey = useCallback((next: SetStateAction<string | null>) => dispatch({ type: "active", next }), []);

  /** Each Schema Model tab's own Close, so closing its tab asks about unsaved changes. */
  const schemaCloses = useRef(new Map<string, MutableRefObject<(() => void) | null>>());
  /** The strip's keys in order, as last drawn, for picking the tab after a close. */
  const stripKeys = useRef<string[]>([]);
  /** The place tab last active, to come back to when the place is chosen again. */
  const lastPlaceKey = useRef<string | null>(null);

  /** Removes matching place tabs, keeping the active tab when it stays, else its nearest kept neighbour. */
  function removeTabs(drop: (t: WorkTab) => boolean) {
    dispatch({ type: "remove", drop, order: stripKeys.current });
  }

  // A closed Schema Model tab, by any path, takes its Close with it.
  useEffect(() => {
    const live = new Set(windowTabs.flatMap((t) => (t.kind === "schema" ? [t.id] : [])));
    for (const id of [...schemaCloses.current.keys()]) if (!live.has(id)) schemaCloses.current.delete(id);
  }, [windowTabs]);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  /** Removes a tab at once; the right neighbour, else the left, becomes active when it was. */
  function closeKey(key: string) {
    const order = stripKeys.current;
    setTabs((all) => all.filter((t) => tabKey(t) !== key));
    setWindowTabs((all) => all.filter((t) => tabKey(t) !== key));
    setActiveKey((a) => afterClose(order, a, key));
  }

  /** Each Schema Model tab's own Close, so closing its tab asks about unsaved changes. */
  function schemaClose(id: string): MutableRefObject<(() => void) | null> {
    let ref = schemaCloses.current.get(id);
    if (!ref) {
      ref = { current: null };
      schemaCloses.current.set(id, ref);
    }
    return ref;
  }

  function schemaCloseFor(id: string): (() => void) | null {
    return schemaCloses.current.get(id)?.current ?? null;
  }

  /** Opens the Home tab (one at most); `ifIdle` leaves another active tab active. */
  function showHome(ifIdle = false) {
    setWindowTabs((w) => (w.some((t) => t.kind === "home") ? w : [{ kind: "home" }, ...w]));
    setActiveKey((k) => (ifIdle && k !== null ? k : "home"));
  }

  /** Shows the place: its last active tab, else its first, else no tab. */
  function showPlace() {
    const keys = tabsRef.current.map(tabKey);
    setActiveKey((k) => {
      if (k !== null && keys.includes(k)) return k;
      const last = lastPlaceKey.current;
      return last !== null && keys.includes(last) ? last : (keys[0] ?? null);
    });
  }

  function openSavedDoc(doc: QueryTabDoc) {
    dispatch({ type: "openSaved", doc });
  }

  function openVisualDoc(doc: VisualTabDoc) {
    dispatch({ type: "openVisual", doc });
  }

  function openSchemaTab(tab: SchemaTab) {
    dispatch({ type: "openSchema", tab });
  }

  /** Opens diagram `name` in its tab, or shows the tab it already has. */
  function openFlowTab(name: string) {
    dispatch({ type: "openFlow", name });
  }

  function renameFlowTab(from: string, to: string) {
    dispatch({ type: "renameFlow", from, to });
  }

  /** Opens a new Data Transfer tab from `seed`. */
  function openTransferTab(seed: TransferSeed) {
    dispatch({ type: "openTransfer", id: crypto.randomUUID(), seed });
  }

  const setTransferMeta = useCallback((id: string, title: string, dirty: boolean) => dispatch({ type: "transferMeta", id, title, dirty }), []);

  // Kept for handlers and effects: layout effects run after each commit and before any event or passive effect reads them.
  const allTabs: AnyTab[] = stripOrder(windowTabs, tabs);
  useLayoutEffect(() => {
    stripKeys.current = allTabs.map(tabKey);
    if (tabs.some((t) => tabKey(t) === activeKey)) lastPlaceKey.current = activeKey;
  });

  return {
    tabs,
    windowTabs,
    activeKey,
    allTabs,
    setTabs,
    setWindowTabs,
    setActiveKey,
    tabsRef,
    lastPlaceKey,
    removeTabs,
    closeKey,
    showHome,
    showPlace,
    openSavedDoc,
    openVisualDoc,
    openSchemaTab,
    openFlowTab,
    renameFlowTab,
    openTransferTab,
    setTransferMeta,
    schemaClose,
    schemaCloseFor,
  };
}
