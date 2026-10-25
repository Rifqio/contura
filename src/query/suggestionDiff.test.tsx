import { EditorView } from "@codemirror/view";
import { act, render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { mockEditorDom } from "../test/editor";

vi.mock("../assistant/lineDiff", async (original) => {
  const actual = await original<typeof import("../assistant/lineDiff")>();
  return { ...actual, diffLines: vi.fn(actual.diffLines) };
});

mockEditorDom();
import { diffLines } from "../assistant/lineDiff";
import SqlEditor, { type SqlEditorApi } from "./SqlEditor";

// M8: typing outside a waiting suggestion maps its diff; only a change to its own lines makes it again.
test("m8_the_diff_is_made_again_only_when_its_lines_change", () => {
  const editorRef = { current: null as SqlEditorApi | null };
  const utils = render(
    <SqlEditor value={"SELECT 1;\n\nSELECT 2;"} dialect="postgres" editorRef={editorRef} onChange={() => {}} onRun={() => {}} onFormat={() => {}} onSave={() => {}} onEscape={() => false} />,
  );
  const view = EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  act(() => editorRef.current!.suggest({ from: 11, to: 20, text: "SELECT 3;", where: "w" }));
  const made = vi.mocked(diffLines).mock.calls.length;
  expect(made).toBeGreaterThan(0);
  for (let i = 0; i < 5; i++) act(() => view.dispatch({ changes: { from: 0, insert: "-" } }));
  expect(vi.mocked(diffLines).mock.calls.length).toBe(made);
  expect(Array.from(utils.container.querySelectorAll(".cm-suggest-add")).map((e) => e.textContent)).toEqual(["SELECT 3;"]);
  expect(Array.from(utils.container.querySelectorAll(".cm-line.cm-suggest-del")).map((e) => e.textContent)).toEqual(["SELECT 2;"]);
});
