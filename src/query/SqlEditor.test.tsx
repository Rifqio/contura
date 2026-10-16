import { EditorView } from "@codemirror/view";
import { act, fireEvent, render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import SqlEditor, { type SqlEditorApi } from "./SqlEditor";

function setup(value: string, extra: Partial<Parameters<typeof SqlEditor>[0]> = {}) {
  const props = {
    onChange: vi.fn(),
    onRun: vi.fn(),
    onFormat: vi.fn(),
    onSave: vi.fn(),
    onEscape: vi.fn(() => true),
  };
  const editorRef = { current: null as SqlEditorApi | null };
  const utils = render(<SqlEditor value={value} dialect="postgres" editorRef={editorRef} {...props} {...extra} />);
  const view = EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  return { ...utils, ...props, view, editorRef };
}

const key = (view: EditorView, k: string, mods: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(view.contentDOM, { key: k, ...mods });

test("ctrl_enter_runs_current_and_ctrl_shift_enter_runs_all", () => {
  const { view, onRun } = setup("SELECT 1;");
  key(view, "Enter", { ctrlKey: true });
  expect(onRun).toHaveBeenLastCalledWith("current");
  key(view, "Enter", { ctrlKey: true, shiftKey: true });
  expect(onRun).toHaveBeenLastCalledWith("all");
});

test("run_target_is_the_selection_when_there_is_one", () => {
  const text = "SELECT 1; SELECT 2;";
  const { view, editorRef } = setup(text);
  act(() => view.dispatch({ selection: { anchor: 2 } }));
  expect(editorRef.current!.runTarget()).toMatchObject({ text: "SELECT 1", from: 0 });
  const at = text.indexOf("SELECT 2");
  act(() => view.dispatch({ selection: { anchor: at, head: at + 8 } }));
  expect(editorRef.current!.runTarget()).toEqual({ from: at, to: at + 8, text: "SELECT 2" });
});

test("shift_alt_f_formats_and_ctrl_s_saves", () => {
  const { view, onFormat, onSave } = setup("select 1");
  // A real Shift+Alt+F reports key "F" and keyCode 70; CodeMirror matches on the key code.
  key(view, "F", { shiftKey: true, altKey: true, code: "KeyF", keyCode: 70 });
  expect(onFormat).toHaveBeenCalledTimes(1);
  key(view, "s", { ctrlKey: true });
  expect(onSave).toHaveBeenCalledTimes(1);
});

test("escape_is_offered_to_the_owner", () => {
  const { view, onEscape } = setup("SELECT 1");
  key(view, "Escape");
  expect(onEscape).toHaveBeenCalledTimes(1);
});

test("running_and_error_marks_render", () => {
  const { container, rerender, editorRef } = setup("SELECT 1; SELEC 2;");
  rerender(
    <SqlEditor
      value="SELECT 1; SELEC 2;"
      dialect="postgres"
      editorRef={editorRef}
      onChange={() => {}}
      onRun={() => {}}
      onFormat={() => {}}
      onSave={() => {}}
      onEscape={() => false}
      markRunning={{ from: 0, to: 8 }}
      markError={{ from: 10, to: 15 }}
    />,
  );
  expect(container.querySelector(".cm-run-mark")?.textContent).toBe("SELECT 1");
  expect(container.querySelector(".cm-error-mark")?.textContent).toBe("SELEC");
});

test("api_inserts_replaces_and_selects", () => {
  const { view, editorRef, onChange } = setup("SELECT 1;");
  act(() => view.dispatch({ selection: { anchor: 9 } }));
  act(() => editorRef.current!.insert("\nSELECT 2;"));
  expect(view.state.doc.toString()).toBe("SELECT 1;\nSELECT 2;");
  act(() => editorRef.current!.replaceAll("SELECT 3"));
  expect(onChange).toHaveBeenLastCalledWith("SELECT 3");
  act(() => editorRef.current!.select(0, 6));
  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("SELECT");
});
