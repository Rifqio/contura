import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { bracketMatching } from "@codemirror/language";
import {
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { platform } from "../platform";
import { EditorView, keymap, type KeyBinding } from "@codemirror/view";

/** Ctrl+F: select() alone does not focus the field in every web view, so focus it too. */
export function openFind(view: EditorView): boolean {
  openSearchPanel(view);
  const field = view.dom.querySelector<HTMLInputElement>(".cm-search [name=search]");
  field?.focus();
  field?.select();
  return true;
}

/** Ctrl+H: the search panel always has its Replace row; this opens it and puts you in that field. */
export function openReplace(view: EditorView): boolean {
  openSearchPanel(view);
  const field = view.dom.querySelector<HTMLInputElement>(".cm-search [name=replace]");
  field?.focus();
  field?.select();
  return true;
}

/** Only the find keys VS Code has: Ctrl+F, Replace (Ctrl+H; Cmd+Alt+F on a Mac, where Cmd+H hides the app), F3, Esc, Ctrl+D. */
const KEPT_SEARCH_KEYS = new Set(["F3", "Escape", "Mod-d"]);

const findKeys = (): KeyBinding[] => [
  { key: "Mod-f", scope: "editor search-panel", run: openFind, preventDefault: true },
  { key: platform() === "mac" ? "Mod-Alt-f" : "Mod-h", scope: "editor search-panel", run: openReplace, preventDefault: true },
];

/** The find bar's words in the app's sentence case (CodeMirror's own are lower case). */
const findPhrases = EditorState.phrases.of({
  next: "Next",
  previous: "Previous",
  all: "Select all",
  "match case": "Match case",
  regexp: "Regular expression",
  "by word": "Whole word",
  replace: "Replace",
  "replace all": "Replace all",
  close: "Close",
});

/**
 * What a code editor does when you type, the way VS Code does it: Find and Replace (Ctrl+F, Ctrl+H, F3 and
 * Shift+F3, Esc), the matching bracket lit, brackets and quotes closed, other copies of the selection lit,
 * Ctrl+D for the next occurrence, Alt+Click for another place to type (Ctrl+Click is left free).
 * Put it after the command keys and before the default keymap. See ADR 0028.
 */
export const editingBasics = (): Extension => [
  search({ top: true }),
  findPhrases,
  bracketMatching(),
  closeBrackets(),
  highlightSelectionMatches(),
  EditorView.clickAddsSelectionRange.of((event) => event.altKey),
  keymap.of([...findKeys(), ...closeBracketsKeymap, ...searchKeymap.filter((b) => b.key && KEPT_SEARCH_KEYS.has(b.key))]),
];
