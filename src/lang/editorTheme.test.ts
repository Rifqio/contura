import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, test } from "vitest";
import { mockEditorDom } from "../test/editor";
import { appIsDark, editorTheme, TOOLTIP_RULES, TOOLTIP_THEME } from "./editorTheme";

mockEditorDom();
afterEach(() => document.documentElement.removeAttribute("data-theme"));

test("the completion list, its selected row, matched letters, detail and info panel take the app tokens (item 50)", () => {
  for (const sel of [
    ".cm-tooltip",
    ".cm-tooltip-autocomplete > ul > li",
    ".cm-tooltip-autocomplete > ul > li[aria-selected]",
    ".cm-completionMatchedText",
    ".cm-completionDetail",
    ".cm-tooltip.cm-completionInfo",
  ]) {
    expect(TOOLTIP_RULES[sel], sel).toBeDefined();
  }
  for (const [sel, rule] of Object.entries(TOOLTIP_RULES)) {
    for (const [prop, value] of Object.entries(rule)) {
      if (/color/i.test(prop)) expect(value, `${sel} ${prop}`).toMatch(/^var\(--c-[a-z-]+\)$/);
      expect(value, `${sel} ${prop}`).not.toMatch(/#[0-9a-f]{3,6}\b|rgb/i);
    }
  }
});

test("the editor's dark flag follows the app theme as it changes (item 50)", async () => {
  document.documentElement.setAttribute("data-theme", "dark");
  expect(appIsDark()).toBe(true);
  const view = new EditorView({ parent: document.body, state: EditorState.create({ extensions: editorTheme() }) });
  expect(view.state.facet(EditorView.darkTheme)).toBe(true);
  document.documentElement.setAttribute("data-theme", "light");
  await new Promise((r) => setTimeout(r, 0));
  expect(view.state.facet(EditorView.darkTheme)).toBe(false);
  document.documentElement.setAttribute("data-theme", "dark");
  await new Promise((r) => setTimeout(r, 0));
  expect(view.state.facet(EditorView.darkTheme)).toBe(true);
  view.destroy();
});

test("every editor shares one tooltip theme, so opening editors adds no style rules (item 50, memory)", () => {
  const a = editorTheme() as Extension[];
  const b = editorTheme() as Extension[];
  expect(a[1]).toBe(TOOLTIP_THEME);
  expect(b[1]).toBe(a[1]);
  // Mounting and destroying editors leaves the page's style rules as they were after the first one.
  const sheets = () => [...((document as { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? []), ...Array.from(document.styleSheets)];
  const count = () => sheets().reduce((n, sh) => n + (sh.cssRules?.length ?? 0), 0) + [...document.querySelectorAll("style")].reduce((n, el) => n + (el.textContent?.length ?? 0), 0);
  new EditorView({ parent: document.body, state: EditorState.create({ extensions: editorTheme() }) }).destroy();
  const after = count();
  for (let i = 0; i < 5; i++) new EditorView({ parent: document.body, state: EditorState.create({ extensions: editorTheme() }) }).destroy();
  expect(count()).toBe(after);
});
