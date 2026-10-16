import { closeCompletion, currentCompletions } from "@codemirror/autocomplete";
import { forEachDiagnostic } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { LangClient, type WorkerLike } from "../lang/client";
import { KFC_SCHEMA } from "../lang/sql/fixtures";
import { mockEditorDom } from "../test/editor";
import { fakeWorker } from "../test/langWorker";

mockEditorDom();
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

// Language intelligence (step 4b).

function setupLang(value: string, extra: Partial<Parameters<typeof SqlEditor>[0]> = {}) {
  const client = new LangClient(() => fakeWorker());
  client.setSqlSchema("c1/kfc", KFC_SCHEMA);
  const onShowInTree = vi.fn();
  const r = setup(value, {
    lang: { client, docId: "q1", schemaKey: "c1/kfc", schemaState: "loaded" },
    onShowInTree,
    ...extra,
  });
  return { ...r, client, onShowInTree };
}

const typeText = (view: EditorView, text: string) =>
  act(() => {
    view.dispatch(view.state.replaceSelection(text), { userEvent: "input.type" });
  });
const lintRanges = (view: EditorView) => {
  const out: string[] = [];
  forEachDiagnostic(view.state, (d) => out.push(`${d.severity}:${view.state.sliceDoc(d.from, d.to)}`));
  return out;
};
const selected = (view: EditorView) => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);

test("completion_opens_as_you_type_and_on_ctrl_space", async () => {
  const { view } = setupLang("SELECT * FROM ");
  act(() => view.dispatch({ selection: { anchor: 14 } }));
  typeText(view, "ord");
  await waitFor(() => expect(currentCompletions(view.state).map((c) => c.label)).toContain("orders"));
  act(() => {
    closeCompletion(view);
  });
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "SELECT  FROM stores s" }, selection: { anchor: 7 } }));
  key(view, " ", { ctrlKey: true });
  await waitFor(() => expect(currentCompletions(view.state).map((c) => c.label)).toContain("code"));
});

test("diagnostics_where_you_are_typing_wait_1500ms", async () => {
  vi.useFakeTimers();
  try {
    const { view } = setupLang("SELECT 1");
    act(() => view.dispatch({ changes: { from: 0, to: 8, insert: "SELECT * FROM order" }, selection: { anchor: 19 } }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(lintRanges(view).some((d) => d.endsWith(":order"))).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(lintRanges(view)).toContain("error:order");
  } finally {
    vi.useRealTimers();
  }
});

test("ctrl_dot_and_alt_enter_open_the_fixes", async () => {
  const { view } = setupLang("SELECT * FROM order");
  act(() => view.dispatch({ selection: { anchor: 16 } }));
  key(view, "Enter", { altKey: true });
  await waitFor(() => expect(view.dom.querySelector(".cm-panel-lint")?.textContent).toContain("Did you mean orders?"));
  key(view, "Escape");
  // On a `*`, the panel offers to expand it.
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "SELECT * FROM stores" }, selection: { anchor: 8 } }));
  key(view, ".", { ctrlKey: true });
  await waitFor(() => expect(view.dom.querySelector(".cm-panel-lint")?.textContent).toContain("Expand column list"));
});

test("f2_selects_every_occurrence_and_typing_renames_them", async () => {
  const text = "SELECT o.id FROM orders o WHERE o.total > 0";
  const { view } = setupLang(text);
  act(() => view.dispatch({ selection: { anchor: 7 } }));
  key(view, "F2");
  await waitFor(() => expect(view.state.selection.ranges).toHaveLength(3));
  typeText(view, "ord");
  expect(view.state.doc.toString()).toBe("SELECT ord.id FROM orders ord WHERE ord.total > 0");
  // A table is renamed in the Table Designer, and the editor says so.
  act(() => view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("orders") + 1 } }));
  key(view, "F2");
  await waitFor(() => expect(view.dom.querySelector(".cm-sql-notice")?.textContent).toContain("Table Designer"));
});

test("enter_ends_a_rename_without_a_newline", async () => {
  const { view, onRun } = setupLang("SELECT o.id FROM orders o WHERE o.total > 0");
  act(() => view.dispatch({ selection: { anchor: 7 } }));
  key(view, "F2");
  await waitFor(() => expect(view.state.selection.ranges).toHaveLength(3));
  typeText(view, "ord");
  key(view, "Enter");
  expect(view.state.doc.toString()).toBe("SELECT ord.id FROM orders ord WHERE ord.total > 0");
  expect(view.state.selection.ranges).toHaveLength(1);
  // Ctrl+Enter during a rename runs the statement, not the selected alias.
  act(() => view.dispatch({ selection: { anchor: 7 } }));
  key(view, "F2");
  await waitFor(() => expect(view.state.selection.ranges).toHaveLength(3));
  key(view, "Enter", { ctrlKey: true });
  expect(onRun).toHaveBeenLastCalledWith("current");
  expect(view.state.selection.ranges).toHaveLength(1);
});

test("after_an_engine_restart_the_checks_run_again", async () => {
  const workers: WorkerLike[] = [];
  const client = new LangClient(() => {
    const w = fakeWorker();
    workers.push(w);
    return w;
  });
  client.setSqlSchema("c1/kfc", KFC_SCHEMA);
  const { view } = setup("SELECT * FROM order", {
    lang: { client, docId: "q1", schemaKey: "c1/kfc", schemaState: "loaded" },
  });
  await waitFor(() => expect(lintRanges(view)).toContain("error:order"));
  const asked = vi.spyOn(client, "analyzeSql");
  act(() => workers[0].onerror?.());
  // The new worker is asked again without waiting for an edit.
  await waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(lintRanges(view)).toContain("error:order"));
});

test("f12_on_an_alias_moves_to_its_declaration_and_on_a_table_calls_onShowInTree", async () => {
  const text = "SELECT o.id FROM orders o";
  const { view, onShowInTree } = setupLang(text);
  act(() => view.dispatch({ selection: { anchor: 7 } }));
  key(view, "F12");
  await waitFor(() => expect(view.state.selection.main.from).toBe(24));
  act(() => view.dispatch({ selection: { anchor: text.indexOf("orders") + 2 } }));
  key(view, "F12");
  await waitFor(() => expect(onShowInTree).toHaveBeenCalledWith({ schema: "sales", name: "orders" }));
});

test("ctrl_shift_space_shows_parameter_hints", async () => {
  const text = "SELECT date_trunc('day', ";
  const { view } = setupLang(text);
  act(() => view.dispatch({ selection: { anchor: text.length } }));
  key(view, " ", { ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(view.dom.querySelector(".cm-sql-params")?.textContent).toContain("date_trunc(field text, source timestamptz)"));
  expect(view.dom.querySelector(".cm-sql-params .cm-sql-param-active")?.textContent).toBe("source timestamptz");
  key(view, "Escape");
  await waitFor(() => expect(view.dom.querySelector(".cm-sql-params")).toBeNull());
});

test("tab_expands_a_template_and_moves_between_fields", () => {
  const { view } = setupLang("sel");
  act(() => view.dispatch({ selection: { anchor: 3 } }));
  key(view, "Tab");
  expect(view.state.doc.toString()).toBe("SELECT * FROM table");
  expect(selected(view)).toBe("table");
  key(view, "Tab");
  expect(selected(view)).toBe("*");
  // `ins` fills in every column once its table is named.
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "ins" }, selection: { anchor: 3 } }));
  key(view, "Tab");
  expect(selected(view)).toBe("table");
  typeText(view, "stores");
  key(view, "Tab");
  expect(view.state.doc.toString()).toBe(
    "INSERT INTO stores (id, code, name, city, opened_on, is_active)\nVALUES (0, '', '', '', current_date, true);",
  );
  expect(selected(view)).toBe("0");
  // Not at the start of a statement, Tab does not expand.
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "SELECT sel" }, selection: { anchor: 10 } }));
  key(view, "Tab");
  expect(view.state.doc.toString()).not.toContain("FROM table");
});

test("one_line_mode_has_no_gutters_and_enter_runs", () => {
  const { container, view, onRun } = setupLang("status = 'paid'", { oneLine: true });
  expect(container.querySelector(".cm-gutters")).toBeNull();
  key(view, "Enter");
  expect(onRun).toHaveBeenLastCalledWith("current");
  act(() => view.dispatch({ changes: { from: 0, insert: "a\nb " } }));
  expect(view.state.doc.lines).toBe(1);
});
