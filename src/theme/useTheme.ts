import { useCallback, useEffect, useReducer } from "react";
import type { ThemeChoice } from "../api/types";
import { usePrefs } from "../prefs/usePrefs";
import { applyTheme, readMirror, writeMirror } from "./theme";

export type ThemeState = { choice: ThemeChoice; systemDark: boolean };

export type ThemeAction =
  | { type: "loaded"; choice: ThemeChoice }
  | { type: "chosen"; choice: ThemeChoice }
  | { type: "systemChanged"; systemDark: boolean };

export function themeReducer(s: ThemeState, a: ThemeAction): ThemeState {
  switch (a.type) {
    case "loaded":
    case "chosen":
      return s.choice === a.choice ? s : { ...s, choice: a.choice };
    case "systemChanged":
      return s.systemDark === a.systemDark ? s : { ...s, systemDark: a.systemDark };
  }
}

/** The theme on screen: Windows decides only while following it. */
export function effectiveTheme(s: ThemeState): "light" | "dark" {
  if (s.choice === "system") return s.systemDark ? "dark" : "light";
  return s.choice;
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemIsDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

/**
 * The theme choice. Starts from the mirrored copy (already painted by
 * `applyStoredTheme`), then takes the Core setting, which wins. The choice is kept in
 * the one prefs holder, so choosing a theme never resets the other prefs.
 */
export function useTheme(): { choice: ThemeChoice; effective: "light" | "dark"; choose(c: ThemeChoice): void } {
  const { prefs, update } = usePrefs();
  const [state, dispatch] = useReducer(themeReducer, undefined, () => ({
    choice: readMirror(),
    // Read now, so a System choice on a dark Windows never reads "light" for a render.
    systemDark: systemIsDark(),
  }));

  // The stored choice (once the Core answers, or after a choose) paints and rewrites the mirror.
  useEffect(() => {
    applyTheme(document.documentElement, prefs.theme);
    writeMirror(prefs.theme);
    dispatch({ type: "loaded", choice: prefs.theme });
  }, [prefs.theme]);

  const following = state.choice === "system";
  useEffect(() => {
    if (!following || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = (e: { matches: boolean }) => dispatch({ type: "systemChanged", systemDark: e.matches });
    dispatch({ type: "systemChanged", systemDark: systemIsDark() });
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [following]);

  const choose = useCallback(
    (c: ThemeChoice) => {
      applyTheme(document.documentElement, c);
      writeMirror(c);
      dispatch({ type: "chosen", choice: c });
      update({ theme: c });
    },
    [update],
  );

  return { choice: state.choice, effective: effectiveTheme(state), choose };
}
