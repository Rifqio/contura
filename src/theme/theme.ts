import type { ThemeChoice } from "../api/types";

/**
 * The localStorage key holding a copy of the saved theme. The Core setting is
 * the real one; this copy only lets the first frame paint the right theme
 * before the Core answers.
 */
export const THEME_MIRROR_KEY = "contura.theme";

const CHOICES: readonly ThemeChoice[] = ["system", "light", "dark"];

/** The `data-theme` value for a choice; null means follow Windows (no attribute). */
export function themeAttribute(c: ThemeChoice): "light" | "dark" | null {
  return c === "system" ? null : c;
}

export function applyTheme(root: HTMLElement, c: ThemeChoice): void {
  const attr = themeAttribute(c);
  if (attr) root.setAttribute("data-theme", attr);
  else root.removeAttribute("data-theme");
}

/** The mirrored choice; Dracula when nothing usable is stored. */
export function readMirror(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_MIRROR_KEY);
    return CHOICES.includes(v as ThemeChoice) ? (v as ThemeChoice) : "dark";
  } catch {
    return "dark";
  }
}

export function writeMirror(c: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_MIRROR_KEY, c);
  } catch {
    // Without storage the next start paints Dracula until the Core answers.
  }
}

/** Paints the mirrored theme and returns the one on screen. `main.tsx` calls it before the first render. */
export function applyStoredTheme(): "light" | "dark" {
  const choice = readMirror();
  applyTheme(document.documentElement, choice);
  if (choice !== "system") return choice;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
