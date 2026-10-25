import { redo, undo, undoDepth } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { mockEditorDom } from "../test/editor";

mockEditorDom();
import SqlEditor, { type SqlEditorApi } from "./SqlEditor";
import { splitStatements } from "./statements";
import { ZoneWidget } from "./suggestion";

const DOC = "-- report\nSELECT id\nFROM orders\nLIMIT 5;\n\nSELECT 2;";

function setup(value = DOC, extra: Partial<Parameters<typeof SqlEditor>[0]> = {}) {
  const props = {
    onChange: vi.fn(),
    onRun: vi.fn(),
    onFormat: vi.fn(),
    onSave: vi.fn(),
    onEscape: vi.fn(() => true),
    onSuggestion: vi.fn(),
  };
  const editorRef = { current: null as SqlEditorApi | null };
  const utils = render(<SqlEditor value={value} dialect="postgres" editorRef={editorRef} {...props} {...extra} />);
  const view = EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  return { ...utils, ...props, view, editorRef, api: () => editorRef.current! };
}

const key = (view: EditorView, k: string, mods: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(view.contentDOM, { key: k, ...mods });
const texts = (c: HTMLElement, sel: string) => Array.from(c.querySelectorAll(sel)).map((e) => e.textContent);

/** Lines 2 to 4 ("SELECT id" .. "LIMIT 5;") become two lines. */
function suggestOverFirst(api: SqlEditorApi, onEnd = vi.fn()) {
  const from = DOC.indexOf("SELECT id");
  const to = DOC.indexOf(";") + 1;
  act(() => api.suggest({ from, to, text: "SELECT id\nFROM invoices;", where: "Replaces lines 2 to 4 of Query 1", onEnd }));
  return onEnd;
}

test("a_suggestion_shows_as_a_diff_in_the_editor_and_leaves_the_text_alone", () => {
  const { container, view, api, onSuggestion } = setup();
  suggestOverFirst(api());
  expect(view.state.doc.toString()).toBe(DOC);
  expect(texts(container, ".cm-line.cm-suggest-del")).toEqual(["FROM orders", "LIMIT 5;"]);
  expect(texts(container, ".cm-suggest-add")).toEqual(["FROM invoices;"]);
  expect(api().suggesting()).toBe(true);
  expect(onSuggestion).toHaveBeenLastCalledWith(true);
});

test("keep_writes_it_in_one_undo_step_and_clears_the_diff", () => {
  const { container, view, api, onSuggestion } = setup();
  const onEnd = suggestOverFirst(api());
  const before = undoDepth(view.state);
  act(() => void api().keepSuggestion());
  const kept = "-- report\nSELECT id\nFROM invoices;\n\nSELECT 2;";
  expect(view.state.doc.toString()).toBe(kept);
  expect(onEnd).toHaveBeenCalledWith("kept", expect.anything());
  expect(container.querySelectorAll(".cm-suggest-del, .cm-suggest-add").length).toBe(0);
  expect(api().suggesting()).toBe(false);
  expect(onSuggestion).toHaveBeenLastCalledWith(false);
  expect(undoDepth(view.state)).toBe(before + 1);
  act(() => void undo(view));
  expect(view.state.doc.toString()).toBe(DOC);
  // Undo takes the text back, never the suggestion.
  expect(api().suggesting()).toBe(false);
  act(() => void redo(view));
  expect(view.state.doc.toString()).toBe(kept);
});

test("discard_clears_the_diff_and_leaves_no_undo_step", () => {
  const { container, view, api } = setup();
  const onEnd = suggestOverFirst(api());
  const before = undoDepth(view.state);
  act(() => void api().discardSuggestion());
  expect(view.state.doc.toString()).toBe(DOC);
  expect(onEnd).toHaveBeenCalledWith("discarded");
  expect(container.querySelectorAll(".cm-suggest-del, .cm-suggest-add, .cm-suggest-bar").length).toBe(0);
  expect(undoDepth(view.state)).toBe(before);
});

test("ctrl_enter_keeps_and_never_runs_while_a_suggestion_waits", () => {
  const { view, api, onRun } = setup();
  const onEnd = suggestOverFirst(api());
  key(view, "Enter", { ctrlKey: true });
  expect(onRun).not.toHaveBeenCalled();
  expect(onEnd).toHaveBeenCalledWith("kept", expect.anything());
  key(view, "Enter", { ctrlKey: true });
  expect(onRun).toHaveBeenCalledWith("current");
});

test("run_all_does_nothing_while_a_suggestion_waits", () => {
  const { view, api, onRun } = setup();
  suggestOverFirst(api());
  key(view, "Enter", { ctrlKey: true, shiftKey: true });
  expect(onRun).not.toHaveBeenCalled();
  expect(api().suggesting()).toBe(true);
});

test("esc_discards_before_the_owner_hears_it", () => {
  const { view, api, onEscape } = setup();
  const onEnd = suggestOverFirst(api());
  key(view, "Escape");
  expect(onEnd).toHaveBeenCalledWith("discarded");
  expect(onEscape).not.toHaveBeenCalled();
  expect(view.state.doc.toString()).toBe(DOC);
});

test("typing_inside_the_suggested_lines_drops_it_and_elsewhere_keeps_it_in_place", () => {
  const { view, api } = setup();
  const onEnd = suggestOverFirst(api());
  act(() => view.dispatch({ changes: { from: DOC.length, insert: "\n-- more" } }));
  expect(api().suggesting()).toBe(true);
  act(() => view.dispatch({ changes: { from: 0, insert: "--\n" } }));
  expect(api().suggesting()).toBe(true);
  act(() => void api().keepSuggestion());
  expect(view.state.doc.toString()).toBe("--\n-- report\nSELECT id\nFROM invoices;\n\nSELECT 2;\n-- more");
  expect(onEnd).toHaveBeenCalledWith("kept", expect.anything());

  const onEnd2 = vi.fn();
  const at = view.state.doc.toString().indexOf("FROM invoices");
  act(() => api().suggest({ from: at, to: at + 14, text: "FROM x;", where: "w", onEnd: onEnd2 }));
  act(() => view.dispatch({ changes: { from: at + 2, insert: "Z" } }));
  expect(api().suggesting()).toBe(false);
  expect(onEnd2).toHaveBeenCalledWith("discarded");
});

test("a_new_suggestion_replaces_the_one_waiting", () => {
  const { container, api } = setup();
  const first = suggestOverFirst(api());
  const second = vi.fn();
  act(() => api().suggest({ from: DOC.length, to: DOC.length, text: "\n\nSELECT 3;", where: "Adds lines 7 to 8", onEnd: second }));
  expect(first).toHaveBeenCalledWith("replaced");
  expect(texts(container, ".cm-line.cm-suggest-del")).toEqual([]);
  expect(texts(container, ".cm-suggest-add")).toEqual(["", "SELECT 3;"]);
  act(() => void api().keepSuggestion());
  expect(second).toHaveBeenCalledWith("kept", expect.anything());
  expect(api().text()).toBe(`${DOC}\n\nSELECT 3;`);
});

test("an_insert_on_a_blank_line_adds_below_it", () => {
  const { container, api } = setup("SELECT 1;\n\n");
  act(() => api().suggest({ from: 10, to: 10, text: "SELECT 2;\n", where: "w" }));
  expect(texts(container, ".cm-line.cm-suggest-del")).toEqual([]);
  expect(texts(container, ".cm-suggest-add")).toEqual(["SELECT 2;"]);
});

test("the_bar_in_the_editor_keeps_and_discards", () => {
  const { container, api, view } = setup();
  const from = DOC.indexOf("SELECT id");
  const onEnd = vi.fn();
  act(() => api().suggest({ from, to: from + 9, text: "SELECT 1", where: "Apply replaces line 2 of Query 1", bar: true, keepLabel: "Keep", onEnd }));
  const bar = container.querySelector(".cm-suggest-bar")!;
  expect(bar.textContent).toContain("Apply replaces line 2 of Query 1");
  fireEvent.click(Array.from(bar.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Discard"))!);
  expect(onEnd).toHaveBeenCalledWith("discarded");
  expect(container.querySelector(".cm-suggest-bar")).toBeNull();
  act(() => api().suggest({ from, to: from + 9, text: "SELECT 1", where: "w", bar: true, onEnd }));
  fireEvent.click(Array.from(container.querySelectorAll(".cm-suggest-bar button")).find((b) => b.textContent?.startsWith("Keep"))!);
  expect(onEnd).toHaveBeenLastCalledWith("kept", expect.anything());
  expect(view.state.doc.toString()).toContain("SELECT 1\nFROM orders");
});

test("marks_name_the_lines_an_action_touches_and_clear", () => {
  const { container, api } = setup();
  act(() => api().markLines({ from: DOC.indexOf("SELECT id"), to: DOC.indexOf(";") }));
  expect(texts(container, ".cm-line.cm-ai-target")).toEqual(["SELECT id", "FROM orders", "LIMIT 5;"]);
  act(() => api().markLines({ after: DOC.indexOf(";") }));
  expect(texts(container, ".cm-line.cm-ai-target")).toEqual([]);
  expect(texts(container, ".cm-line.cm-ai-insert-at")).toEqual(["LIMIT 5;"]);
  act(() => api().markLines(null));
  expect(container.querySelectorAll(".cm-ai-target, .cm-ai-insert-at").length).toBe(0);
});

test("the_editor_reports_its_selection_and_statements", () => {
  const { view, api } = setup();
  act(() => view.dispatch({ selection: { anchor: 12, head: 15 } }));
  expect(api().selection()).toEqual({ from: 12, to: 15 });
  expect(api().statements()).toEqual(splitStatements(DOC, "postgres"));
  expect(api().statements()).toHaveLength(2);
});

// ---- Fix round 1 (I2, M2): ranges that follow the text ----

test("a_tracked_range_follows_edits_above_and_can_move_and_go", () => {
  const { view, api } = setup();
  const from = DOC.indexOf("SELECT 2");
  const id = api().track(from, from + 9);
  act(() => view.dispatch({ changes: { from: 0, insert: "\n\n" } }));
  expect(api().tracked(id)).toEqual({ from: from + 2, to: from + 11 });
  // Typing inside keeps it around the statement.
  act(() => view.dispatch({ changes: { from: from + 8, insert: "0" } }));
  expect(api().tracked(id)).toEqual({ from: from + 2, to: from + 12 });
  api().retrack(id, 0, 3);
  expect(api().tracked(id)).toEqual({ from: 0, to: 3 });
  api().untrack(id);
  expect(api().tracked(id)).toBeNull();
});

test("keep_reports_the_range_it_wrote", () => {
  const { api } = setup();
  const onEnd = vi.fn();
  const from = DOC.indexOf("SELECT 2");
  act(() => api().suggest({ from, to: from + 9, text: "SELECT 22;", where: "w", onEnd }));
  act(() => void api().keepSuggestion());
  expect(onEnd).toHaveBeenCalledWith("kept", { from, to: from + 10 });
});

test("a_destroyed_editor_ends_its_waiting_suggestion_as_discarded", () => {
  const { api, unmount } = setup();
  const onEnd = suggestOverFirst(api());
  unmount();
  expect(onEnd).toHaveBeenCalledWith("discarded");
});

// ---- Round 2 (N5, N6): the inline box's place ----

test("n5_a_new_box_place_lets_go_of_the_old_ones_observer", () => {
  const observers: { disconnect: ReturnType<typeof vi.fn> }[] = [];
  // The editor has observers of its own: only the ones watching a box's place count here.
  class RO {
    observe = vi.fn((el: Element) => {
      if (el.classList.contains("cm-ask-zone")) observers.push(this);
    });
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal("ResizeObserver", RO);
  try {
    const { api, unmount } = setup();
    api().askZone({ track: null, pos: 3 });
    api().askZone({ track: null, pos: 20 });
    expect(observers[0].disconnect).toHaveBeenCalled();
    expect(observers[1].disconnect).not.toHaveBeenCalled();
    unmount();
    expect(observers[1].disconnect).toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("n6_the_box_place_tells_the_editor_its_height_before_it_is_measured", () => {
  const host = document.createElement("div");
  expect(new ZoneWidget(host).estimatedHeight).toBeGreaterThan(100);
});
