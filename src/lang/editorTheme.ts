import { Compartment, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";

/**
 * Item 50: the pop-ups CodeMirror draws inside an editor (the completion list, its info panel, lint and hover
 * tips) take the app's tokens in both themes. Without this the base theme's light rules (`#f5f5f5` behind
 * text that inherits the editor's pale colour) made suggestions unreadable in dark mode.
 */
export const TOOLTIP_RULES: Record<string, Record<string, string>> = {
  ".cm-tooltip": {
    backgroundColor: "var(--c-bg-raised)",
    color: "var(--c-text)",
    border: "var(--border-hairline) solid var(--c-border)",
    borderRadius: "var(--rounded-md)",
    boxShadow: "var(--shadow-menu)",
  },
  ".cm-tooltip-autocomplete > ul > li": {
    color: "var(--c-text)",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--c-bg-active)",
    color: "var(--c-text)",
  },
  ".cm-completionMatchedText": {
    color: "var(--c-accent-text)",
    textDecoration: "none",
    fontWeight: "600",
  },
  ".cm-completionDetail": {
    color: "var(--c-text-muted)",
  },
  ".cm-completionIcon": {
    color: "var(--c-text-muted)",
  },
  ".cm-tooltip.cm-completionInfo": {
    backgroundColor: "var(--c-bg-raised)",
    color: "var(--c-text)",
    border: "var(--border-hairline) solid var(--c-border)",
  },
};

/** True when the app paints its dark theme: `data-theme="dark"`, or no choice and the system is dark. */
export function appIsDark(root: HTMLElement = document.documentElement): boolean {
  const attr = root.getAttribute("data-theme");
  if (attr === "dark") return true;
  if (attr === "light") return false;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

const darkFlag = new Compartment();
const flagFor = (dark: boolean) => EditorView.darkTheme.of(dark);

/** Keeps the editor's `dark` flag in step with the app theme as it changes. */
const followTheme = ViewPlugin.define((view) => {
  const sync = () => {
    const dark = appIsDark();
    if (view.state.facet(EditorView.darkTheme) !== dark) view.dispatch({ effects: darkFlag.reconfigure(flagFor(dark)) });
  };
  const observer = new MutationObserver(sync);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  media?.addEventListener?.("change", sync);
  return {
    destroy() {
      observer.disconnect();
      media?.removeEventListener?.("change", sync);
    },
  };
});

/** The app theme for a CodeMirror editor: token-coloured pop-ups and the matching `dark` flag. */
/**
 * Built once: `EditorView.theme` mounts a style module whose rules stay in the page for good, so a theme made per
 * editor would add rules with every tab opened (the RAM rule). Every editor shares this one.
 */
export const TOOLTIP_THEME: Extension = EditorView.theme(TOOLTIP_RULES);

export const editorTheme = (): Extension => [darkFlag.of(flagFor(appIsDark())), TOOLTIP_THEME, followTheme];
