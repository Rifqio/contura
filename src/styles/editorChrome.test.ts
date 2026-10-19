import { expect, test } from "vitest";
import appCss from "./app.css?raw";
import flowTabCss from "./flow-tab.css?raw";

/** The bodies of every rule whose selector list holds `sel` exactly, joined. */
function body(css: string, sel: string): string {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const out: string[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[1].split(",").map((s) => s.trim()).includes(sel)) out.push(m[2]);
  }
  return out.join("\n");
}

test("item_17_flow_gutter_follows_the_theme_with_an_edge", () => {
  const g = body(flowTabCss, ".flow-editor .cm-gutters");
  expect(g).toMatch(/background:\s*var\(--c-bg-surface\)/);
  expect(g).toMatch(/border-right:\s*1px solid var\(--c-border-subtle\)/);
  expect(body(flowTabCss, ".flow-editor .cm-editor")).toMatch(/background:\s*var\(--c-bg-surface\)/);
});

test("item_9_sql_and_dbml_gutters_have_an_edge", () => {
  for (const sel of [".sql-editor .cm-gutters", ".dbml-editor .cm-gutters"]) {
    expect({ sel, b: /border-right:\s*1px solid var\(--c-border-subtle\)/.test(body(appCss, sel)) }).toEqual({ sel, b: true });
  }
});

test("item_9_insertion_line_uses_the_text_colour_and_fades", () => {
  expect(body(appCss, ":root .cm-editor .cm-cursor")).toMatch(/border-left:\s*2px solid var\(--c-text\)/);
  expect(body(appCss, ":root .cm-editor.cm-focused > .cm-scroller > .cm-cursorLayer")).toMatch(/animation-timing-function:\s*cubic-bezier/);
});

test("item_3_the_cell_being_edited_has_one_ring", () => {
  // The cell drops its own ring; the editor draws one inset ring, no outline on top.
  expect(body(appCss, ".grid td.cell-editing.cell-selected")).toMatch(/box-shadow:\s*none/);
  const editor = body(appCss, ".cell-editor");
  expect(editor).toMatch(/outline:\s*none/);
  expect(editor).toMatch(/box-shadow:\s*inset 0 0 0 2px var\(--c-accent\)/);
});
