import { currentCompletions } from "@codemirror/autocomplete";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { LangClient } from "../lang/client";
import type { ParseResult, TextEdit } from "../lang/protocol";
import { fakeWorker } from "../test/langWorker";
import { changedLines } from "./changedLines";
import DbmlEditor from "./DbmlEditor";

const BASE = "Table stores {\n  id integer [pk]\n}\nTable orders {\n  store_id integer\n}\n";

function setup(value: string, saved = value) {
  const onChange = vi.fn();
  const onResult = vi.fn<(r: ParseResult) => void>();
  const editsRef = { current: null as ((e: TextEdit[]) => void) | null };
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <DbmlEditor
      value={value}
      savedValue={saved}
      dialect="mysql"
      onChange={onChange}
      onResult={onResult}
      editsRef={editsRef}
      client={client}
    />,
  );
  const view = EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  return { ...utils, view, onChange, onResult, editsRef };
}

const key = (view: EditorView, k: string, mods: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(view.contentDOM, { key: k, ...mods });

test("typing_reports_parse_results", async () => {
  const { view, onChange, onResult } = setup("Table a {\n  id int\n}");
  await waitFor(() => expect(onResult.mock.lastCall?.[0].model?.tables[0].name).toBe("a"));
  act(() => view.dispatch({ changes: { from: view.state.doc.length - 1, to: view.state.doc.length } }));
  expect(onChange).toHaveBeenLastCalledWith("Table a {\n  id int\n");
  await waitFor(() => expect(onResult.mock.lastCall?.[0].diagnostics.length).toBeGreaterThan(0));
});

test("ctrl_space_offers_types", async () => {
  const text = "Table t {\n  at time\n}";
  const { view } = setup(text);
  act(() => view.dispatch({ selection: { anchor: text.indexOf("time") + 4 } }));
  key(view, " ", { ctrlKey: true });
  await waitFor(() =>
    expect(currentCompletions(view.state).map((c) => c.label)).toContain("timestamp"),
  );
});

test("alt_enter_and_ctrl_dot_open_fixes", async () => {
  const { view, onResult } = setup(BASE);
  await waitFor(() => expect(onResult.mock.lastCall?.[0].model).not.toBeNull());
  const broken = `${BASE}Ref: orders.store_idd > stores.id\n`;
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: broken } }));
  await waitFor(() => expect(onResult.mock.lastCall?.[0].diagnostics.length).toBeGreaterThan(0));
  act(() => view.dispatch({ selection: { anchor: broken.indexOf("store_idd") + 2 } }));
  key(view, "Enter", { altKey: true });
  await waitFor(() => expect(view.dom.querySelector(".cm-panel-lint")?.textContent).toContain("Did you mean store_id?"));
  key(view, "Escape");
  key(view, ".", { ctrlKey: true });
  await waitFor(() => expect(view.dom.querySelector(".cm-panel-lint")).not.toBeNull());
});

test("template_tab_expands_table", () => {
  const { view } = setup("Table");
  act(() => view.dispatch({ selection: { anchor: 5 } }));
  key(view, "Tab");
  expect(view.state.doc.toString()).toMatch(/^Table name \{\n {2}id integer \[pk, increment\]\n/);
});

test("changed_lines_get_gutter_marks", () => {
  expect(changedLines("a\nb\nc", "a\nB\nc")).toEqual([2]);
  expect(changedLines("a\nb", "a\nb\nc")).toEqual([3]);
  expect(changedLines("a\nb", "a\nb")).toEqual([]);
  const { view } = setup("a\nB\nc", "a\nb\nc");
  expect(view.dom.querySelectorAll(".cm-changed-marker")).toHaveLength(1);
});

test("edits_ref_applies_one_undoable_transaction", () => {
  const { view, editsRef } = setup("Table a {\n  id int\n}");
  act(() =>
    editsRef.current!([
      { from: 6, to: 7, insert: "b" },
      { from: 12, to: 14, insert: "key" },
    ]),
  );
  expect(view.state.doc.toString()).toBe("Table b {\n  key int\n}");
  act(() => {
    undo(view);
  });
  expect(view.state.doc.toString()).toBe("Table a {\n  id int\n}");
});

test("f2_renames_column_and_refs", async () => {
  const text = `${BASE}Ref: orders.store_id > stores.id\n`;
  const { view, onResult } = setup(text);
  await waitFor(() => expect(onResult.mock.lastCall?.[0].model).not.toBeNull());
  vi.spyOn(window, "prompt").mockReturnValue("shop_id");
  act(() => view.dispatch({ selection: { anchor: text.indexOf("store_id") + 1 } }));
  key(view, "F2");
  expect(view.state.doc.toString()).toContain("  shop_id integer");
  expect(view.state.doc.toString()).toContain("Ref: orders.shop_id > stores.id");
});

test("gutter_and_content_mount_side_by_side", () => {
  const { container } = setup(BASE);
  const scroller = container.querySelector(".cm-scroller") as HTMLElement;
  const kids = Array.from(scroller.children).map((c) => c.className.split(" ")[0]);
  expect(kids.slice(0, 2)).toEqual(["cm-gutters", "cm-content"]);
});

test("selecting_a_card_bands_its_block", async () => {
  const client = new LangClient(() => fakeWorker());
  const props = { value: BASE, savedValue: BASE, dialect: "mysql" as const, onChange: vi.fn(), onResult: vi.fn(), editsRef: { current: null }, client };
  const { container, rerender } = render(<DbmlEditor {...props} />);
  const banded = () => [...container.querySelectorAll(".cm-line.cm-block-band")].map((e) => e.textContent);
  expect(banded()).toEqual([]);
  const from = BASE.indexOf("Table orders");
  rerender(<DbmlEditor {...props} band={[{ from, to: BASE.length - 1 }]} />);
  await waitFor(() => expect(banded()).toEqual(["Table orders {", "  store_id integer", "}"]));
  rerender(<DbmlEditor {...props} band={[]} />);
  await waitFor(() => expect(banded()).toEqual([]));
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

test("the_dbml_editor_has_find_and_replace_and_closes_brackets_like_the_sql_editor", () => {
  const { view } = setup("");
  key(view, "f", { ctrlKey: true });
  expect(view.dom.querySelector(".cm-search")).not.toBeNull();
  const insert = () => view.state.update({ changes: { from: 0, insert: "(" }, selection: { anchor: 1 } });
  view.state.facet(EditorView.inputHandler).some((f) => f(view, 0, 0, "(", insert));
  expect(view.state.doc.toString()).toBe("()");
});

test("esc_in_the_dbml_find_box_closes_only_the_find_panel", () => {
  const { view } = setup("Table a {\n  id int\n}");
  key(view, "f", { ctrlKey: true });
  const box = view.dom.querySelector(".cm-search [name=search]") as HTMLInputElement;
  const outer = vi.fn();
  document.addEventListener("keydown", outer);
  fireEvent.keyDown(box, { key: "Escape", keyCode: 27 });
  document.removeEventListener("keydown", outer);
  expect(view.dom.querySelector(".cm-search")).toBeNull();
  expect(outer.mock.calls.every(([e]) => (e as KeyboardEvent).defaultPrevented)).toBe(true);
});
