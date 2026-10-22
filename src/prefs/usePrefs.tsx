import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { saveUiPrefs, uiPrefs } from "../api/client";
import { DEFAULT_UI_PREFS, type FlowAssistMode, type FlowSidePanelPref, type UiPrefs } from "../api/types";
import { readMirror } from "../theme/theme";

/** Density, brighter comments and the editor font, on `root` (the theme is `useTheme`'s). */
export function applyPrefs(root: HTMLElement, p: UiPrefs): void {
  if (p.rowHeight === 24) root.setAttribute("data-density", "compact");
  else root.removeAttribute("data-density");
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

  const update = useCallback((patch: Partial<UiPrefs>) => {
    const next = { ...current.current, ...patch };
    current.current = next;
    setPrefs(next);
    if (early.current) {
      early.current = { ...early.current, ...patch };
      if (failed.current) retryRead();
    } else void save(next);
  }, []);

  const value = useMemo(() => ({ prefs, update }), [prefs, update]);
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): PrefsValue {
  const v = useContext(PrefsContext);
  if (!v) throw new Error("usePrefs needs a PrefsProvider");
  return v;
}

/**
 * The diagram tab's side panel choice, kept in the prefs so it is the same across tabs and restarts. Without a
 * provider (a tab drawn on its own) it lives in the component.
 */
export function useFlowSidePanel(): [FlowSidePanelPref, (patch: Partial<FlowSidePanelPref>) => void] {
  const ctx = useContext(PrefsContext);
  const [local, setLocal] = useState<FlowSidePanelPref>(DEFAULT_UI_PREFS.flowSidePanel);
  const stored = ctx?.prefs.flowSidePanel;
  const update = ctx?.update;
  const set = useCallback(
    (patch: Partial<FlowSidePanelPref>) => {
      if (update) update({ flowSidePanel: { ...(stored ?? DEFAULT_UI_PREFS.flowSidePanel), ...patch } });
      else setLocal((l) => ({ ...l, ...patch }));
    },
    [update, stored],
  );
  return [stored ?? local, set];
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
