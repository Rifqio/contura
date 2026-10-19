import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect, test } from "vitest";
import { focusFlowText } from "./focusFlowText";

test("focus_finds_the_tab_whatever_the_case_of_its_name", () => {
  const pane = document.createElement("div");
  pane.className = "work-pane";
  pane.dataset.flowName = "Checkout";
  document.body.append(pane);
  const view = new EditorView({ parent: pane, state: EditorState.create({ doc: 'diagram dfd "Checkout"\n' }) });
  const stop = focusFlowText("checkout");
  expect(view.hasFocus).toBe(true);
  expect(view.state.selection.main.head).toBe('diagram dfd "Checkout"'.length);
  stop();
  view.destroy();
  pane.remove();
});
