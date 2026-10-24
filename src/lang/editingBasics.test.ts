import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, test } from "vitest";
import { editingBasics, openFind } from "./editingBasics";

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

test("the find bar's labels are in sentence case like the rest of the app", () => {
  view = new EditorView({ state: EditorState.create({ doc: "select 1", extensions: editingBasics() }), parent: document.body });
  openFind(view);
  const panel = view.dom.querySelector(".cm-search")!;
  const buttons = [...panel.querySelectorAll("button")].map((b) => b.textContent);
  expect(buttons).toEqual(expect.arrayContaining(["Next", "Previous", "Select all", "Replace", "Replace all"]));
  expect(panel.textContent).toContain("Match case");
  expect(panel.textContent).toContain("Regular expression");
  expect(panel.textContent).toContain("Whole word");
});
