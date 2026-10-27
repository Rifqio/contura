import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { saveUiPrefs, uiPrefs } from "../api/client";
import { DEFAULT_UI_PREFS, type FlowAssistMode, type FlowSidePanelPref, type UiPrefs } from "../api/types";
import { readMirror } from "../theme/theme";
import { setNullDisplay } from "./gridDisplay";
import { applyInterfaceSize } from "./zoom";

/**
 * Density, striped grid rows, brighter comments and the editor font, on `root`, and how grids draw NULL (the
 * theme is `useTheme`'s, the interface size the provider's).
 */
export function applyPrefs(root: HTMLElement, p: UiPrefs): void {
  if (p.rowHeight === 24) root.setAttribute("data-density", "compact");
  else root.removeAttribute("data-density");
  if (p.stripeRows) root.setAttribute("data-grid-stripes", "");
  else root.removeAttribute("data-grid-stripes");
  setNullDisplay(p.nullAs === "symbol" || p.nullAs === "blank" ? p.nullAs : "null");
  if (p.brighterComments) root.setAttribute("data-brighter-comments", "");
  else root.removeAttribute("data-brighter-comments");
  const e = p.editor;
  root.style.setProperty("--editor-font-family", `"${e.family}", var(--font-family-code)`);
  root.style.setProperty("--editor-font-size", `${e.size}px`);
  root.style.setProperty("--editor-line-height", `${e.lineHeight}px`);
  root.style.setProperty("--editor-ligatures", e.ligatures ? "contextual" : "none");
  root.style.setProperty("--editor-features", e.ligatures ? '"calt" 1, "liga" 1' : '"calt" 0, "liga" 0');
}

/** Stored prefs over the defaults, so a field the Core leaves out keeps its default. */
function withDefaults(p: Partial<UiPrefs> | null | undefined): UiPrefs {
  return {
    ...DEFAULT_UI_PREFS,
    ...p,
    editor: { ...DEFAULT_UI_PREFS.editor, ...p?.editor },
    flowSidePanel: { ...DEFAULT_UI_PREFS.flowSidePanel, ...p?.flowSidePanel },
  };
}

interface PrefsValue {
  prefs: UiPrefs;
  update(patch: Partial<UiPrefs>): void;
  /** Each diagram tab's pane, open or closed, by file name: in memory for the session, never saved (Decision 16). */
  flowPanes: Map<string, boolean>;
}

const PrefsContext = createContext<PrefsValue | null>(null);

/**
 * The one holder of the UI prefs. Every change saves the whole struct, so nothing else may
 * keep its own copy. Changes made before the Core answers wait for it, then go on top. After
 * a failed read the first change reads once more, so it never saves the defaults over what
 * is stored; only when that read fails too does it save over the defaults.
 */
export function PrefsProvider({ children }: { children: ReactNode }) {
  // The mirrored theme is already painted; keep it until the Core answers.
  const [prefs, setPrefs] = useState<UiPrefs>(() => ({ ...DEFAULT_UI_PREFS, theme: readMirror() }));
  const current = useRef(prefs);
  /** Changes made before the Core answered, or null once it has. */
  const early = useRef<Partial<UiPrefs> | null>({});
  /** The first read failed; the next change reads once more before saving. */
  const failed = useRef(false);
  const retrying = useRef(false);
  const live = useRef(true);

  const save = (p: UiPrefs) =>
    saveUiPrefs(p).catch(() => {
      // The screen keeps the change; the Core keeps the old value until the next save.
    });

  const settle = (stored: UiPrefs | null) => {
    if (!live.current || !early.current) return;
    const pending = early.current;
    early.current = null;
    const next = { ...(stored ?? current.current), ...pending };
    current.current = next;
    setPrefs(next);
    // A size picked before the Core answered may equal the state already shown, so the effect would not run.
    if (pending.interfaceSize !== undefined) applyInterfaceSize(next.interfaceSize);
    if (Object.keys(pending).length > 0) void save(next);
  };

  const read = (retry: boolean) =>
    uiPrefs()
      .then((p) => settle(withDefaults(p)))
      .catch(() => {
        if (retry) return settle(null);
        failed.current = true;
        if (early.current && Object.keys(early.current).length > 0) retryRead();
      });

  const retryRead = () => {
    if (retrying.current) return;
    retrying.current = true;
    void read(true);
  };

  useEffect(() => {
    live.current = true;
    void read(false);
    return () => {
      live.current = false;
    };
    // Read once per mount.
  }, []);

  useEffect(() => applyPrefs(document.documentElement, prefs), [prefs]);

  // The Core zoomed the window to the saved size before the first paint; the defaults shown until it answers
  // must not undo that, so only a size from the Core or a change made after it applies.
  const size = prefs.interfaceSize;
  useEffect(() => {
    if (early.current === null) applyInterfaceSize(size);
  }, [size]);

  const update = useCallback((patch: Partial<UiPrefs>) => {
    const next = { ...current.current, ...patch };
    current.current = next;
    setPrefs(next);
    if (early.current) {
      early.current = { ...early.current, ...patch };
      if (failed.current) retryRead();
    } else void save(next);
  }, []);

  const [flowPanes] = useState(() => new Map<string, boolean>());
  const value = useMemo(() => ({ prefs, update, flowPanes }), [prefs, update, flowPanes]);
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): PrefsValue {
  const v = useContext(PrefsContext);
  if (!v) throw new Error("usePrefs needs a PrefsProvider");
  return v;
}

/**
 * The diagram tab's side panel: the last tab shown (Editor or Assistant), kept in the prefs so it is the same across
 * tabs and restarts. Only the tab is written; the stored `hidden` is left as it is, since a board keeps its open state
 * per tab (`useFlowPaneOpen`). Without a provider (a tab drawn on its own) it lives in the component.
 */
export function useFlowSidePanel(): [FlowSidePanelPref["tab"], (tab: FlowSidePanelPref["tab"]) => void] {
  const ctx = useContext(PrefsContext);
  const [local, setLocal] = useState<FlowSidePanelPref["tab"]>(DEFAULT_UI_PREFS.flowSidePanel.tab);
  const stored = ctx?.prefs.flowSidePanel;
  const update = ctx?.update;
  const set = useCallback(
    (tab: FlowSidePanelPref["tab"]) => {
      if (update) {
        if (stored?.tab !== tab) update({ flowSidePanel: { ...(stored ?? DEFAULT_UI_PREFS.flowSidePanel), tab } });
      } else setLocal(tab);
    },
    [update, stored],
  );
  const tab = stored?.tab === "assistant" || stored?.tab === "editor" ? stored.tab : local;
  return [ctx ? tab : local, set];
}

/**
 * Whether diagram tab `name` has its pane open (Decision 16): its own, remembered in memory by file name for the
 * session; a tab opened for the first time opens with it open (owner answer 6). Without a provider it lives in the
 * component.
 */
export function useFlowPaneOpen(name: string): [boolean, (open: boolean) => void] {
  const panes = useContext(PrefsContext)?.flowPanes;
  const [open, setOpenState] = useState(() => panes?.get(name) ?? true);
  const [was, setWas] = useState(name);
  if (was !== name) {
    setWas(name);
    setOpenState(panes?.get(name) ?? true);
  }
  const setOpen = useCallback(
    (next: boolean) => {
      panes?.set(name, next);
      setOpenState(next);
    },
    [panes, name],
  );
  return [open, setOpen];
}

/** "Review first" or "Auto-apply" for the diagram assistant, kept in the prefs; without a provider it lives in the component. */
export function useFlowAssistMode(): [FlowAssistMode, (mode: FlowAssistMode) => void] {
  const ctx = useContext(PrefsContext);
  const [local, setLocal] = useState<FlowAssistMode>(DEFAULT_UI_PREFS.flowAssistMode);
  const stored = ctx?.prefs.flowAssistMode;
  const update = ctx?.update;
  const set = useCallback(
    (mode: FlowAssistMode) => {
      if (update) update({ flowAssistMode: mode });
      else setLocal(mode);
    },
    [update],
  );
  return [stored === "auto" || stored === "review" ? stored : local, set];
}

/**
 * Item 36: the Visual Query's bottom panel height, the same in every tab and remembered for the user (null is the
 * default). Without a provider (a tab drawn on its own) it lives in the component.
 */
export function useVqPanelHeight(): [number | null, (h: number | null) => void] {
  const ctx = useContext(PrefsContext);
  const [local, setLocal] = useState<number | null>(null);
  const update = ctx?.update;
  const set = useCallback(
    (h: number | null) => {
      if (update) update({ vqPanelHeight: h });
      else setLocal(h);
    },
    [update],
  );
  const stored = ctx?.prefs.vqPanelHeight;
  return [ctx ? (typeof stored === "number" ? stored : null) : local, set];
}

/** The name Ungrouped goes by when the user has not renamed it. */
export const UNGROUPED = "Ungrouped";

/** The longest name for Ungrouped, as in the Core. */
export const UNGROUPED_LABEL_MAX = 60;

/**
 * What to call the place for Connections in no Group, and how to rename it. Without a provider (a part drawn on its
 * own) the name is "Ungrouped" and a rename lives in the component.
 */
export function useUngroupedLabel(): { label: string; custom: string | null; set: (name: string | null) => void } {
  const ctx = useContext(PrefsContext);
  const [local, setLocal] = useState<string | null>(null);
  const update = ctx?.update;
  const set = useCallback(
    (name: string | null) => {
      const next = name?.trim() ? name.trim() : null;
      if (update) update({ ungroupedLabel: next });
      else setLocal(next);
    },
    [update],
  );
  const stored = ctx ? ctx.prefs.ungroupedLabel : local;
  const custom = typeof stored === "string" && stored.trim() ? stored.trim() : null;
  return { label: custom ?? UNGROUPED, custom, set };
}
