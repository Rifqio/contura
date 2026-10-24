import { closeCompletion, currentCompletions } from "@codemirror/autocomplete";
import { forEachDiagnostic } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { useKeymap } from "../commands/useCommandKeys";
import { expect, test, vi } from "vitest";
import { LangClient, type WorkerLike } from "../lang/client";
import { KFC_SCHEMA } from "../lang/sql/fixtures";
import { mockEditorDom } from "../test/editor";
import { fakeWorker } from "../test/langWorker";
import { resolveKeymap } from "../commands/keymap";
import type { CommandId } from "../commands/registry";

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

test("function_calls_are_marked_but_not_names_strings_or_keywords", () => {
  const { container } = setup("SELECT count(id) FROM orders");
  const fns = [...container.querySelectorAll(".cm-fn")].map((e) => e.textContent);
  expect(fns).toEqual(["count"]);
  const quoted = setup("SELECT 'count(' AS x -- sum(\nWHERE id IN (1) AND EXISTS (SELECT 1)");
  expect(quoted.container.querySelector(".cm-fn")).toBeNull();
});

test("table_names_before_a_column_list_are_not_function_calls", () => {
  const cases = [
    "INSERT INTO orders (id) VALUES (now())",
    "INSERT INTO public.orders (id) VALUES (now())",
    "CREATE INDEX i ON orders (id); SELECT now()",
    "CREATE VIEW v (a) AS SELECT now()",
    "CREATE UNIQUE INDEX i ON public.orders (id); SELECT now()",
  ];
  for (const text of cases) {
    const { container, unmount } = setup(text);
    expect([...container.querySelectorAll(".cm-fn")].map((e) => e.textContent)).toEqual(["now"]);
    unmount();
  }
});

test("functions_in_a_join_condition_are_marked", () => {
  const { container } = setup("SELECT 1 FROM a JOIN t ON lower(a.x) = t.y");
  expect([...container.querySelectorAll(".cm-fn")].map((e) => e.textContent)).toEqual(["lower"]);
});

const bandLines =(container: HTMLElement) =>
  [...container.querySelectorAll(".cm-line.cm-current-stmt")].map((e) => e.textContent);
const barLines = (container: HTMLElement) =>
  [...container.querySelectorAll(".cm-lineNumbers .cm-current-stmt-gutter")].map((e) => e.textContent);

test("the_current_statement_band_covers_every_line_and_follows_the_selection", () => {
  const text = "SELECT 1,\n  2;\nSELECT 3\nFROM t;";
  const { container, view } = setup(text);
  expect(bandLines(container)).toEqual(["SELECT 1,", "  2;"]);
  expect(barLines(container)).toEqual(["1", "2"]);
  act(() => view.dispatch({ selection: { anchor: text.indexOf("FROM") } }));
  expect(bandLines(container)).toEqual(["SELECT 3", "FROM t;"]);
  expect(barLines(container)).toEqual(["3", "4"]);
});

test("an_empty_editor_has_no_current_statement_band", () => {
  const { container } = setup("");
  expect(container.querySelector(".cm-current-stmt")).toBeNull();
  expect(container.querySelector(".cm-current-stmt-gutter")).toBeNull();
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

test("a_confirmed_override_beats_the_editor_default", () => {
  const typeX = (view: EditorView) => {
    // A typed character, as its own undo step.
    act(() => view.dispatch({ changes: { from: 0, insert: "x" }, selection: { anchor: 1 }, userEvent: "input.type" }));
  };
  const run = vi.fn((id: CommandId) => id === "query.new");
  const over = setup("", { commands: { map: resolveKeymap({ "query.new": ["Ctrl+Z"] }), run } });
  typeX(over.view);
  key(over.view, "z", { ctrlKey: true, code: "KeyZ" });
  expect(run).toHaveBeenCalledWith("query.new");
  expect(over.view.state.doc.toString()).toBe("x");
  over.unmount();

  const plain = setup("", { commands: { map: resolveKeymap({}), run } });
  typeX(plain.view);
  key(plain.view, "z", { ctrlKey: true, code: "KeyZ" });
  expect(plain.view.state.doc.toString()).toBe("");
});

test("a_rebound_editor_command_moves_off_its_default_key", () => {
  const { view, onRun } = setup("SELECT 1;", { commands: { map: resolveKeymap({ "query.run": ["F9"] }), run: () => false } });
  key(view, "Enter", { ctrlKey: true });
  expect(onRun).not.toHaveBeenCalled();
  key(view, "F9");
  expect(onRun).toHaveBeenLastCalledWith("current");
});

test("gutter_and_content_mount_side_by_side", () => {
  const { container } = setup("SELECT 1");
  const scroller = container.querySelector(".cm-scroller") as HTMLElement;
  const kids = Array.from(scroller.children).map((c) => c.className.split(" ")[0]);
  expect(kids.slice(0, 2)).toEqual(["cm-gutters", "cm-content"]);
});

test("replace_range_replaces_and_leaves_you_typing_after_it", () => {
  const { view, editorRef, onChange } = setup("SELECT 1; SELECT 2;");
  act(() => editorRef.current!.replaceRange(10, 18, "SELECT 3"));
  expect(view.state.doc.toString()).toBe("SELECT 1; SELECT 3;");
  expect(view.state.selection.main.head).toBe(18);
  expect(onChange).toHaveBeenLastCalledWith("SELECT 1; SELECT 3;");
  // Past the end it clamps rather than throws.
  act(() => editorRef.current!.replaceRange(99, 120, "!"));
  expect(view.state.doc.toString()).toBe("SELECT 1; SELECT 3;!");
});

test("the editor takes the dark flag in the dark theme, so its suggestions are readable (item 50)", () => {
  document.documentElement.setAttribute("data-theme", "dark");
  try {
    const { view } = setup("");
    expect(view.state.facet(EditorView.darkTheme)).toBe(true);
  } finally {
    document.documentElement.removeAttribute("data-theme");
  }
});

// ---- Editing basics: Find and Replace, brackets, Ctrl+D, Alt+Click (UX step 1) ----

const panel = (view: EditorView) => view.dom.querySelector(".cm-search") as HTMLElement | null;
const field = (view: EditorView, name: string) => view.dom.querySelector(`.cm-search [name=${name}]`) as HTMLInputElement;
const typeInto = (input: HTMLInputElement, text: string) => {
  input.value = text;
  fireEvent.input(input);
  fireEvent.change(input);
};
const typeChar = (view: EditorView, ch: string) => {
  const { from, to } = view.state.selection.main;
  act(() => {
    const insert = () => view.state.update({ changes: { from, to, insert: ch }, selection: { anchor: from + ch.length } });
    view.state.facet(EditorView.inputHandler).some((f) => f(view, from, to, ch, insert));
  });
};

test("ctrl_f_opens_find_and_enter_moves_to_the_next_match", () => {
  const { view } = setup("SELECT a, b FROM t WHERE a = 1 AND a = 2");
  expect(panel(view)).toBeNull();
  key(view, "f", { ctrlKey: true });
  expect(panel(view)).not.toBeNull();
  const search = field(view, "search");
  expect(document.activeElement).toBe(search);
  typeInto(search, "a =");
  fireEvent.keyDown(search, { key: "Enter", keyCode: 13 });
  const first = view.state.doc.toString().indexOf("a =");
  expect(view.state.selection.main).toMatchObject({ from: first, to: first + 3 });
  fireEvent.keyDown(search, { key: "Enter", keyCode: 13 });
  const second = view.state.doc.toString().lastIndexOf("a =");
  expect(view.state.selection.main).toMatchObject({ from: second, to: second + 3 });
});

test("f3_and_shift_f3_step_through_matches_and_escape_closes_find_before_the_owner", () => {
  const { view, onEscape } = setup("one two one two one");
  key(view, "f", { ctrlKey: true });
  typeInto(field(view, "search"), "one");
  view.focus();
  key(view, "F3");
  const first = view.state.selection.main.from;
  key(view, "F3");
  const second = view.state.selection.main.from;
  expect(second).toBeGreaterThan(first);
  key(view, "F3", { shiftKey: true });
  expect(view.state.selection.main.from).toBe(first);
  key(view, "Escape");
  expect(panel(view)).toBeNull();
  expect(onEscape).not.toHaveBeenCalled();
  key(view, "Escape");
  expect(onEscape).toHaveBeenCalledTimes(1);
});

test("ctrl_h_opens_replace_with_the_replace_field_focused_and_replace_all_works", () => {
  const { view } = setup("SELECT a, a FROM a");
  key(view, "h", { ctrlKey: true });
  expect(panel(view)).not.toBeNull();
  expect(document.activeElement).toBe(field(view, "replace"));
  typeInto(field(view, "search"), "a");
  typeInto(field(view, "replace"), "zz");
  fireEvent.click(view.dom.querySelector(".cm-search [name=replaceAll]") as HTMLElement);
  expect(view.state.doc.toString().replace(/SELECT|FROM/g, "")).toBe(" zz, zz  zz");
});

test("typing_an_open_bracket_or_quote_inserts_the_pair_and_leaves_you_between", () => {
  const { view } = setup("");
  typeChar(view, "(");
  expect(view.state.doc.toString()).toBe("()");
  expect(view.state.selection.main.head).toBe(1);
  typeChar(view, ")");
  expect(view.state.doc.toString()).toBe("()");
  expect(view.state.selection.main.head).toBe(2);
  typeChar(view, "'");
  expect(view.state.doc.toString()).toBe("()''");
  expect(view.state.selection.main.head).toBe(3);
});

test("typing_a_bracket_through_a_real_input_event_closes_it", () => {
  const { view } = setup("");
  view.contentDOM.focus();
  // The platform path: the browser's beforeinput reaches CodeMirror's input handlers.
  const ev = new InputEvent("beforeinput", { data: "(", inputType: "insertText", bubbles: true, cancelable: true });
  act(() => {
    view.contentDOM.dispatchEvent(ev);
  });
  const typed = view.state.doc.toString();
  // jsdom may leave the insert to the browser; then CodeMirror's own handler is what we drive.
  if (typed === "") typeChar(view, "(");
  expect(view.state.doc.toString()).toBe("()");
});

test("the_bracket_next_to_where_you_are_typing_is_marked_with_its_partner", () => {
  const { view } = setup("SELECT (1 + 2)");
  act(() => view.dispatch({ selection: { anchor: 8 } }));
  expect(view.dom.querySelectorAll(".cm-matchingBracket").length).toBe(2);
});

test("ctrl_d_extends_the_selection_to_the_next_match", () => {
  const { view } = setup("foo bar foo baz foo");
  act(() => view.dispatch({ selection: { anchor: 0, head: 3 } }));
  key(view, "d", { ctrlKey: true });
  expect(view.state.selection.ranges.map((r) => [r.from, r.to])).toEqual([
    [0, 3],
    [8, 11],
  ]);
  key(view, "d", { ctrlKey: true });
  expect(view.state.selection.ranges).toHaveLength(3);
});

test("alt_click_adds_a_selection_range_and_ctrl_click_does_not", () => {
  const { view } = setup("SELECT 1; SELECT 2");
  // jsdom has no layout, so a click is mapped to the position under it by hand.
  const at = vi.spyOn(view, "posAndSideAtCoords").mockReturnValue({ pos: 12, assoc: 1 });
  act(() => view.dispatch({ selection: { anchor: 2 } }));
  const click = (init: MouseEventInit) =>
    fireEvent.mouseDown(view.contentDOM, { button: 0, detail: 1, clientX: 5, clientY: 5, ...init });
  click({ ctrlKey: true });
  act(() => view.dispatch({ selection: { anchor: 2 } }));
  expect(view.state.selection.ranges).toHaveLength(1);
  click({ altKey: true });
  expect(view.state.selection.ranges.map((r) => r.head).sort((a, b) => a - b)).toEqual([2, 12]);
  at.mockRestore();
});

test("ctrl_g_and_the_other_search_extras_are_not_bound", () => {
  const { view } = setup("SELECT 1");
  key(view, "g", { ctrlKey: true, code: "KeyG", keyCode: 71 });
  key(view, "g", { ctrlKey: true, altKey: true, code: "KeyG", keyCode: 71 });
  key(view, "L", { ctrlKey: true, shiftKey: true, code: "KeyL", keyCode: 76 });
  expect(panel(view)).toBeNull();
  expect(view.dom.querySelector(".cm-gotoLine")).toBeNull();
});

test("replace_is_cmd_alt_f_on_a_mac_and_never_cmd_h", async () => {
  const { setPlatformForTests } = await import("../platform");
  setPlatformForTests("mac");
  try {
    const { view } = setup("abc");
    // CodeMirror reads "Mod" from the real navigator (Ctrl in jsdom), so Ctrl stands in for Cmd here.
    key(view, "h", { ctrlKey: true, code: "KeyH", keyCode: 72 });
    expect(panel(view)).toBeNull();
    key(view, "f", { ctrlKey: true, altKey: true, code: "KeyF", keyCode: 70 });
    expect(panel(view)).not.toBeNull();
    expect(document.activeElement).toBe(field(view, "replace"));
  } finally {
    setPlatformForTests(null);
  }
});

test("ctrl_shift_f_in_the_editor_still_goes_to_the_tree_filter", () => {
  const run = vi.fn((id: CommandId) => id === "tree.filter");
  const { view } = setup("SELECT 1", { commands: { map: resolveKeymap({}), run } });
  key(view, "F", { ctrlKey: true, shiftKey: true, code: "KeyF", keyCode: 70 });
  expect(run).toHaveBeenCalledWith("tree.filter");
  expect(panel(view)).toBeNull();
});

test("only_the_editor_that_offers_them_gives_the_command_palette_its_commands", () => {
  const probe = renderHook(() => useKeymap());
  const plain = setup("SELECT 1;");
  // A SQL editor elsewhere (not a query tab's own) is never what the palette runs.
  expect(probe.result.current.available("query.run")).toBe(false);
  plain.unmount();
  const main = setup("SELECT 1;", { paletteCommands: true });
  expect(probe.result.current.available("query.run")).toBe(true);
  main.view.focus();
  expect(probe.result.current.invoke("query.run")).toBe(true);
  expect(main.onRun).toHaveBeenLastCalledWith("current");
  main.unmount();
  expect(probe.result.current.available("query.run")).toBe(false);
});
