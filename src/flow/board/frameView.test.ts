import { defaultKeymap, history, redo, undo, cursorDocEnd } from "@codemirror/commands";
import { findNext, SearchQuery, search, setSearchQuery } from "@codemirror/search";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canvasEdit, frameView, revealTarget, showFrame } from "./frameView";

const FRAMES = ["flow A\n  a1\n  a2\n  a3\n  a4", "flow B\n  b1\n  b2", "flow C\n  c1"];
const DOC = FRAMES.join("\n");
const range = (i: number) => {
  const from = FRAMES.slice(0, i).reduce((n, f) => n + f.length + 1, 0);
  return { from, to: from + FRAMES[i].length, line: FRAMES.slice(0, i).reduce((n, f) => n + f.split("\n").length, 0) + 1 };
};

const views: EditorView[] = [];
function make(onReveal: (pos: number) => void = () => {}, shown = 1) {
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: DOC, extensions: [history(), search(), frameView(onReveal)] }),
  });
  view.dispatch({ effects: showFrame.of(range(shown)), selection: EditorSelection.cursor(range(shown).from) });
  views.push(view);
  return view;
}
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  document.body.innerHTML = "";
});
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const gutter = (view: EditorView) => [...view.dom.querySelectorAll(".cm-lineNumbers .cm-gutterElement")].map((e) => e.textContent).slice(1);

describe("frameView", () => {
  it("only_the_shown_frame_is_visible", async () => {
    const view = make();
    await flush();
    const text = view.contentDOM.textContent ?? "";
    expect(text).toContain("b1");
    expect(text).not.toContain("a1");
    expect(text).not.toContain("c1");
    expect(gutter(view)).toEqual(["1", "2", "3"]);
    view.dispatch({ effects: showFrame.of(range(2)) });
    await flush();
    expect(view.contentDOM.textContent).toContain("c1");
    expect(view.contentDOM.textContent).not.toContain("b1");
    expect(gutter(view)).toEqual(["1", "2"]);
    view.dispatch({ effects: showFrame.of(range(0)) });
    await flush();
    expect(gutter(view)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("the_gutter_is_reconfigured_when_the_first_line_changes", async () => {
    const view = make();
    await flush();
    expect(gutter(view)).toEqual(["1", "2", "3"]);
    // Same document, same range, so only the gutter's config can make it redraw.
    view.dispatch({ effects: showFrame.of({ ...range(1), line: range(1).line + 1 }) });
    await flush();
    expect(gutter(view)).toEqual(["0", "1", "2"]);
  });

  it("the_selection_cannot_enter_a_hidden_frame", () => {
    const reveal = vi.fn();
    const view = make(reveal);
    const r = range(1);
    view.dispatch({ selection: EditorSelection.cursor(r.to), userEvent: "select" });
    // jsdom has no layout for cursorLineDown; a vertical move past the last line is this selection event.
    view.dispatch({ selection: EditorSelection.cursor(r.to + 3), userEvent: "select" });
    expect(view.state.selection.main.head).toBeLessThanOrEqual(r.to);
    view.dispatch({ selection: EditorSelection.cursor(r.from), userEvent: "select" });
    cursorDocEnd(view);
    expect(view.state.selection.main.head).toBeLessThanOrEqual(r.to);
    view.dispatch({ selection: EditorSelection.cursor(r.from), userEvent: "select" });
    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "End", ctrlKey: true }), "editor");
    expect(view.state.selection.main.head).toBe(r.to);
    view.dispatch({ selection: EditorSelection.cursor(DOC.length), userEvent: "select.pointer" });
    expect(view.state.selection.main.head).toBe(r.to);
    expect(reveal).not.toHaveBeenCalled();
  });

  it("typing_at_the_end_grows_the_shown_frame", () => {
    const view = make();
    const r = range(1);
    view.dispatch({ changes: { from: r.to, insert: "X" }, userEvent: "input.type" });
    expect(view.state.doc.toString()).toContain("  b2X");
    view.dispatch({ changes: { from: r.to + 1, insert: "Y" }, userEvent: "input.type" });
    expect(view.state.doc.toString()).toContain("  b2XY");
    expect(view.contentDOM.textContent).toContain("b2XY");
    expect(view.contentDOM.textContent).not.toContain("c1");
  });

  it("select_all_selects_the_frame", () => {
    const view = make();
    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "a", ctrlKey: true }), "editor");
    const r = range(1);
    expect(view.state.selection.main.from).toBe(r.from);
    expect(view.state.selection.main.to).toBe(r.to);
  });

  it("a_user_edit_across_a_hidden_range_is_dropped", () => {
    const view = make();
    const r = range(1);
    view.dispatch({ changes: { from: r.from - 3, to: r.from + 3 }, userEvent: "delete" });
    view.dispatch({ changes: { from: 0, insert: "Z" }, userEvent: "input.type" });
    view.dispatch({ changes: { from: r.to, to: r.to + 2 }, userEvent: "delete" });
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it("a_canvas_edit_in_a_hidden_frame_passes", () => {
    const view = make();
    view.dispatch({ changes: { from: 0, insert: "Z" }, annotations: canvasEdit.of(true) });
    expect(view.state.doc.toString()).toBe("Z" + DOC);
    const r = range(1);
    expect(view.state.doc.sliceString(r.from + 1, r.to + 1)).toBe(FRAMES[1]);
    expect(view.contentDOM.textContent).toContain("b2");
    expect(view.contentDOM.textContent).not.toContain("a1");
  });

  it("a_search_match_in_a_hidden_frame_reveals_it", () => {
    const reveal = vi.fn();
    const view = make(reveal);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "c1" })) });
    findNext(view);
    const at = DOC.indexOf("c1");
    expect(reveal).toHaveBeenCalledWith(at + 2);
    view.dispatch({ selection: EditorSelection.cursor(3) });
    expect(reveal).toHaveBeenLastCalledWith(3);
  });

  it("an_undo_outside_reports_its_target", () => {
    const view = make();
    view.dispatch({ changes: { from: 2, insert: "Q" }, annotations: canvasEdit.of(true) });
    let target: number | null | undefined;
    const probe = view.state.update({ changes: { from: 2, to: 3 }, userEvent: "undo" });
    target = revealTarget(probe);
    expect(target).toBe(2);
    const inside = view.state.update({ changes: { from: range(1).from + 5 + 1, insert: "I" }, userEvent: "undo", annotations: Transaction.addToHistory.of(false) });
    expect(revealTarget(inside)).toBeNull();
  });

  it("undo_and_redo_outside_reveal_through_the_extender", async () => {
    const reveal = vi.fn();
    const view = make(reveal);
    view.dispatch({ changes: { from: 2, insert: "Q" }, annotations: canvasEdit.of(true), userEvent: "input.canvas" });
    reveal.mockClear();
    expect(undo(view)).toBe(true);
    expect(reveal).toHaveBeenCalledWith(2);
    await flush();
    expect(reveal).toHaveBeenCalledTimes(1);
    let h = view.state.selection.main.head;
    expect(h).toBe(2);
    view.dispatch({ selection: EditorSelection.cursor(range(1).from), userEvent: "select" });
    reveal.mockClear();
    expect(redo(view)).toBe(true);
    expect(reveal).toHaveBeenCalledWith(2);
    await flush();
    expect(reveal).toHaveBeenCalledTimes(1);
    h = view.state.selection.main.head;
    expect(h).toBeGreaterThanOrEqual(2);
    expect(h).toBeLessThanOrEqual(3);
  });

  it("an_undo_that_leaves_the_cursor_in_a_hidden_frame_puts_it_back_in_the_shown_one", async () => {
    // The live bug: an undo restores the selection it started from, in a frame no longer shown; its change lies in the
    // shown frame, so nothing is revealed. The cursor comes back into the shown block, on the nearest line.
    const reveal = vi.fn();
    const view = make(reveal, 0);
    const a2 = DOC.indexOf("a2");
    view.dispatch({ selection: EditorSelection.cursor(a2), userEvent: "select" });
    view.dispatch({ changes: { from: DOC.length, insert: "\n  c2" }, annotations: canvasEdit.of(true), userEvent: "input.canvas" });
    const c = range(2);
    view.dispatch({ effects: showFrame.of({ ...c, to: c.to + 5 }) });
    reveal.mockClear();
    expect(undo(view)).toBe(true);
    await flush();
    const head = view.state.selection.main.head;
    expect(head).toBeGreaterThanOrEqual(c.from);
    expect(head).toBeLessThanOrEqual(c.to);
    // The first body line, the column kept.
    expect(head).toBe(DOC.indexOf("c1"));
    expect(reveal).not.toHaveBeenCalled();
    view.dispatch({ changes: { from: head, insert: "x" }, userEvent: "input.type" });
    expect(view.state.doc.toString()).toBe(DOC.replace("  c1", "  xc1"));
  });

  it("showing_another_frame_moves_the_selection_to_its_start", () => {
    const view = make();
    const c = range(2);
    view.dispatch({ effects: showFrame.of(c) });
    expect(view.state.selection.main.head).toBe(c.from);
    view.dispatch({ changes: { from: view.state.selection.main.head, insert: "x" }, userEvent: "input.type" });
    expect(view.state.doc.toString()).toContain("xflow C");
  });

  it("the_hidden_ranges_are_atomic", () => {
    const view = make();
    const sets = view.state.facet(EditorView.atomicRanges).map((f) => f(view));
    const covers = (pos: number) => sets.some((s) => { let hit = false; s.between(pos, pos, () => { hit = true; }); return hit; });
    expect(covers(2)).toBe(true);
    expect(covers(range(1).from + 3)).toBe(false);
    expect(covers(range(1).to - 2)).toBe(false);
  });

  it("revealTarget_reports_a_change_that_runs_past_the_end", () => {
    const view = make();
    const r = range(1);
    const tr = view.state.update({ changes: { from: r.to - 1, insert: "XXXX" }, effects: showFrame.of(r), userEvent: "undo" });
    expect(revealTarget(tr)).toBe(r.to + 3);
  });

  it("the_shown_keys_win_against_the_default_keymap", () => {
    const parent = document.body.appendChild(document.createElement("div"));
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: DOC, extensions: [history(), keymap.of(defaultKeymap), frameView(() => {})] }),
    });
    views.push(view);
    const r = range(1);
    view.dispatch({ effects: showFrame.of(r) });
    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "a", ctrlKey: true }), "editor");
    expect([view.state.selection.main.from, view.state.selection.main.to]).toEqual([r.from, r.to]);
    view.dispatch({ selection: EditorSelection.cursor(r.from), userEvent: "select" });
    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "End", ctrlKey: true }), "editor");
    expect(view.state.selection.main.head).toBe(r.to);
  });
});
