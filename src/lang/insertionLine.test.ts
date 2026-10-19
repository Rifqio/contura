import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, test } from "vitest";
import { insertionLine } from "./insertionLine";

let view: EditorView | null = null;
afterEach(() => view?.destroy());

test("the_editor_draws_its_own_insertion_line_layer", () => {
  view = new EditorView({ parent: document.body, state: EditorState.create({ doc: "SELECT 1", extensions: [insertionLine()] }) });
  expect(view.dom.querySelector(".cm-cursorLayer")).not.toBeNull();
});
