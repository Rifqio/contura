import { expect, test } from "vitest";
import appCss from "./app.css?raw";
import tokensCss from "./tokens.css?raw";
import fontsCss from "./fonts.css?raw";

/** Every shipped component file (tests are left out: their fixtures are not drawn). */
const TSX = Object.entries(import.meta.glob("../**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>).filter(
  ([path]) => !/\.test\.tsx$/.test(path),
);

/** The innermost rules of a stylesheet: selector text and body, at-rule wrappers unwrapped. */
function rules(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const walk = (s: string) => {
    let i = 0;
    while (i < s.length) {
      const open = s.indexOf("{", i);
      if (open < 0) return;
      const selector = s.slice(i, open).trim();
      let depth = 0;
      let close = open;
      for (; close < s.length; close++) {
        if (s[close] === "{") depth++;
        else if (s[close] === "}" && --depth === 0) break;
      }
      const body = s.slice(open + 1, close);
      if (selector.startsWith("@")) walk(body);
      else out.push({ selector, body });
      i = close + 1;
    }
  };
  walk(text);
  return out;
}

test("no_old_colour_tokens_left", () => {
  const old = (text: string) => [...text.matchAll(/--color-[\w-]+/g)].map((m) => m[0]).filter((n) => n !== "--color-scrim");
  expect(old(appCss)).toEqual([]);
  expect(old(tokensCss)).toEqual([]);
  for (const [path, src] of TSX) expect({ path, names: old(src) }).toEqual({ path, names: [] });
});

/** Review Focus 3: faint text is 3.4 to 3.9:1 in Alucard, so it draws only what carries no meaning on its own. */
const FAINT_ALLOWED = [
  /\.cm-lineNumbers/,
  /::placeholder/,
  /:disabled|\[aria-disabled="true"\]/,
  /\.db-mark/,
  /\.row-number/,
  /\.row-deleted/,
  /\.cell-null/,
  /empty-icon|\.empty-state/,
  /\.tree-guide/,
  // The column type under its name (user decision 2026-10-19); the name above it carries the meaning.
  /\.header-text \.type-hint/,
];

test("faint_text_only_on_the_allowed_selectors", () => {
  const offending = rules(appCss)
    .filter((r) => r.body.includes("var(--c-text-faint)"))
    .flatMap((r) => r.selector.split(",").map((s) => s.trim()))
    .filter((s) => !FAINT_ALLOWED.some((ok) => ok.test(s)));
  expect(offending).toEqual([]);
  // In components only the closed database mark may use it.
  const files = TSX.filter(([, src]) => src.includes("--c-text-faint")).map(([path]) => path.split("/").pop());
  expect(files).toEqual(["DbMark.tsx"]);
});

test("no_literal_colours", () => {
  const hex = /#(?:[0-9a-f]{6}|[0-9a-f]{3})(?![\w-])/gi;
  expect(appCss.match(hex) ?? []).toEqual([]);
  expect(fontsCss.match(hex) ?? []).toEqual([]);
  for (const [path, src] of TSX) expect({ path, hex: src.match(hex) ?? [] }).toEqual({ path, hex: [] });
});

/** Every tree line is a 1 px border, so guides, stubs and elbows render at one weight (a filled strip looks bolder). */
test("tree_guides_stubs_and_elbows_are_all_one_px_borders", () => {
  const body = (sel: string) => rules(appCss).find((r) => r.selector === sel)?.body ?? "";
  const lines = [".tree-guide", ".tree-stub", ".tree-stub.tree-elbow", ".tree-guide-strong", ".tree-stub-strong"];
  for (const sel of lines) expect({ sel, background: /background\s*:(?!\s*none)/.test(body(sel)) }).toEqual({ sel, background: false });
  expect(body(".tree-guide")).toMatch(/width:\s*0;[\s\S]*border-left:\s*1px solid var\(--c-tree-guide\)/);
  expect(body(".tree-stub")).toMatch(/height:\s*0;[\s\S]*border-top:\s*1px solid var\(--c-tree-guide\)/);
  const elbow = body(".tree-stub.tree-elbow");
  expect(elbow).toMatch(/border-top:\s*0/);
  expect(elbow).toMatch(/border-left:\s*1px solid var\(--c-tree-guide\)/);
  expect(elbow).toMatch(/border-bottom:\s*1px solid var\(--c-tree-guide\)/);
  expect(elbow).toMatch(/border-bottom-left-radius:\s*6px/);
  expect(elbow).toMatch(/box-sizing:\s*border-box/);
  expect(body(".tree-guide-strong")).toMatch(/border-color:\s*var\(--c-tree-guide-strong\)/);
  expect(body(".tree-stub-strong")).toMatch(/border-color:\s*var\(--c-tree-guide-strong\)/);
});

/** [ids, classes and attributes and pseudo-classes, types] of one selector. */
function specificity(selector: string): number[] {
  const s = selector.replace(/::[\w-]+/g, "").replace(/\*/g, "");
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) ?? []).length;
  const types = (s.match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return [ids, classes, types];
}

const compareSpec = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The winning overflow-y (or its `overflow` shorthand) for `el` across app.css; jsdom's own cascade ignores specificity. */
function cascadedOverflowY(el: Element): string | undefined {
  let best: { spec: number[]; value: string } | undefined;
  for (const r of rules(appCss)) {
    const values = [...r.body.matchAll(/(?:^|;|\s)(?:overflow|overflow-y)\s*:\s*([^;]+)/g)].map(
      (m) => m[1].trim().split(/\s+/).pop() as string,
    );
    if (values.length === 0) continue;
    for (const sel of r.selector.split(",").map((x) => x.trim())) {
      let hit = false;
      try {
        hit = el.matches(sel);
      } catch {
        hit = false;
      }
      const spec = specificity(sel);
      // Later rules win ties, so >= 0.
      if (hit && (!best || compareSpec(spec, best.spec) >= 0)) best = { spec, value: values[values.length - 1] };
    }
  }
  return best?.value;
}

test("the_tree_scrolls_so_saved_queries_stays_reachable", () => {
  // Saved Queries is the tree's last branch: the tree scrolls inside the pane, so a long
  // tree never clips it out of reach, and the filter field stays on top.
  document.body.innerHTML =
    '<div class="body"><div class="place-wrap"><aside class="side"><div class="one-tree"><div class="tree-scroll"></div></div></aside></div></div>';
  expect(["auto", "scroll"]).toContain(cascadedOverflowY(document.querySelector(".tree-scroll")!));
  expect(cascadedOverflowY(document.querySelector("aside.side")!)).toBe("hidden");
  document.body.innerHTML = "";
});

const bodyIn = (css: string, sel: string) =>
  rules(css)
    .filter((r) => r.selector.split(",").some((x) => x.trim() === sel))
    .map((r) => r.body)
    .join("\n");
const bodyOf = (sel: string) => bodyIn(appCss, sel);

test("dialog_header_has_no_rule", () => {
  expect(bodyOf(".dialog-header")).not.toMatch(/border-bottom\s*:\s*(?!0|none)/);
  expect(bodyOf(".dialog-header")).toMatch(/height:\s*52px/);
  expect(bodyOf(".dialog-footer")).toMatch(/min-height:\s*56px/);
});

test("dialog_widths_follow_dn", () => {
  const widths = { confirm: 420, form: 560, model: 640, wide: 760 };
  for (const [name, px] of Object.entries(widths)) {
    expect({ name, body: bodyOf(`.dialog-size-${name}`) }).toEqual({ name, body: expect.stringContaining(`${px}px`) });
  }
});

test("scrollbars_are_themed_without_buttons", () => {
  expect(bodyOf("::-webkit-scrollbar")).toMatch(/width:/);
  expect(bodyOf("::-webkit-scrollbar-thumb")).toMatch(/var\(--c-/);
  expect(bodyOf("::-webkit-scrollbar-button")).toMatch(/display:\s*none/);
  expect(appCss).not.toMatch(/scrollbar-(color|width)\s*:/);
});

test("selection_uses_the_theme_colour", () => {
  expect(bodyOf("::selection")).toMatch(/background(-color)?:\s*var\(--c-accent-subtle\)/);
  expect(bodyOf("::selection")).toMatch(/color:\s*inherit/);
});

test("compact_density_sets_24", () => {
  expect(bodyIn(tokensCss, ":root")).toMatch(/--row-h:\s*28px/);
  expect(bodyIn(tokensCss, ':root[data-density="compact"]')).toMatch(/--row-h:\s*24px/);
  for (const t of ["--grid-cell-height", "--tree-row-height", "--menu-item-height"]) {
    expect(tokensCss).toMatch(new RegExp(`${t}:\\s*var\\(--row-h\\)`));
  }
  // The grid header follows the density too, with room for the type line.
  expect(tokensCss).toMatch(/--grid-header-height:\s*calc\(var\(--row-h\) \+ 10px\)/);
});

test("tabs_are_at_most_220px", () => {
  expect(bodyOf(".work-tab")).toMatch(/max-width:\s*220px/);
  // The title gives way first, so a Production + Read-only tab still shows some of its name (C8).
  expect(bodyOf(".work-tab-name")).toMatch(/min-width:\s*\d/);
  expect(bodyOf(".work-tab-button")).toMatch(/min-width:\s*0/);
});

test("prod_chip_in_tabs_is_18px", () => {
  expect(bodyOf(".work-tab .safety-tag")).toMatch(/height:\s*18px/);
  expect(bodyOf(".work-tab .safety-tag")).toMatch(/flex:\s*none/);
});

test("field_labels_are_12px_muted", () => {
  const body = rules(appCss).find((r) => r.selector === ".field > label,\n.field > .fl" || r.selector.replace(/\s+/g, " ") === ".field > label, .field > .fl")?.body ?? "";
  expect(body).toMatch(/font:\s*var\(--font-small\)/);
  expect(body).toMatch(/color:\s*var\(--c-text-muted\)/);
});

test("connection_form_body_scrolls_inside_the_dialog_only_when_the_window_is_short", () => {
  const grid = rules(appCss).find((r) => r.selector === ".connection-form .form-grid")?.body ?? "";
  expect(grid).toMatch(/grid-template-columns:\s*1fr 1fr/);
  // F5: overflow visible let a tall body push the footer out of the dialog; it scrolls instead.
  expect(grid).toMatch(/overflow:\s*auto/);
  // The dialog may use the whole window less the scrim padding, so at 1280 x 800 New Connection
  // still fits without a scrollbar (Task 13), and the header and footer always stay in view.
  const dialog = rules(appCss).find((r) => r.selector === ".dialog.connection-dialog")?.body ?? "";
  expect(dialog).toMatch(/max-height:\s*calc\(100vh - 2 \* var\(--spacing-xl\)\)/);
});

test("port_field_is_104px", () => {
  const row = rules(appCss).find((r) => r.selector === ".form-hostport")?.body ?? "";
  expect(row).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*104px/);
});

test("tree_is_288_and_264_beside_the_ai_panel", () => {
  expect(bodyIn(tokensCss, ":root")).toMatch(/--layout-tree-width:\s*288px/);
  expect(bodyOf(".body")).toMatch(/grid-template-columns:\s*var\(--layout-tree-width\)/);
  // S4, A4: the AI panel narrows the tree to 264, with or without History beside it.
  expect(bodyOf(".body-ai")).toMatch(/grid-template-columns:\s*264px minmax\(0, 1fr\) 360px/);
  expect(bodyOf(".body-history.body-ai")).toMatch(/grid-template-columns:\s*264px minmax\(0, 1fr\) 360px 360px/);
  expect(bodyOf(".body-history")).toMatch(/grid-template-columns:\s*var\(--layout-tree-width\)/);
});

test("tree_rows_are_one_row_height_with_counts_on_the_right", () => {
  expect(bodyOf(".tree-row")).toMatch(/height:\s*var\(--tree-row-height\)/);
  expect(bodyOf(".tree-count")).toMatch(/margin-left:\s*auto/);
  expect(bodyOf(".tree-count")).toMatch(/font-variant-numeric:\s*tabular-nums/);
  expect(bodyOf(".tree-rows")).toMatch(/font:\s*var\(--font-small\)/);
  expect(bodyOf(".tree-rows")).toMatch(/color:\s*var\(--c-text-subtle\)/);
  expect(bodyOf(".tree-meta")).toMatch(/color:\s*var\(--c-text-subtle\)/);
});

test("new_schema_model_is_640", () => {
  expect(bodyOf(".dialog-size-model")).toMatch(/640px/);
  expect(bodyOf(".model-cards")).toMatch(/repeat\(3,/);
  expect(bodyOf(".model-card-on")).toMatch(/var\(--c-accent\)/);
});

test("run_confirmation_takes_its_width_from_the_wide_dialog_and_has_a_12px_hint", () => {
  expect(bodyOf(".dialog-confirm")).not.toMatch(/width\s*:/);
  expect(bodyOf(".confirm-hint")).toMatch(/font:\s*var\(--font-small\)/);
  expect(bodyOf(".confirm-hint")).toMatch(/color:\s*var\(--c-text-muted\)/);
  expect(bodyOf(".confirm-count")).toMatch(/font:\s*var\(--font-body\)/);
});

test("editor_header_is_one_32px_row_without_wrap", () => {
  const header = rules(appCss).find((r) => r.selector === ".editor-header")?.body ?? "";
  expect(header).toMatch(/height:\s*var\(--strip-height\)/);
  expect(header).toMatch(/display:\s*flex/);
  expect(header).not.toMatch(/flex-wrap:\s*wrap/);
  // Its Connection and Database menus are absolutely positioned inside it; clipping would hide them.
  expect(header).not.toMatch(/overflow(-x|-y)?:\s*(hidden|clip|auto|scroll)/);
  expect(header).toMatch(/white-space:\s*nowrap/);
  expect(tokensCss).toMatch(/--strip-height:\s*32px/);
});

test("focused_editor_has_no_outline", () => {
  for (const sel of [".sql-editor .cm-editor.cm-focused", ".dbml-editor .cm-editor.cm-focused"]) {
    const body = rules(appCss).find((r) => r.selector === sel)?.body ?? "";
    expect({ sel, none: /outline:\s*none/.test(body) }).toEqual({ sel, none: true });
  }
});

test("editor_content_turns_ligatures_on_through_the_prefs_variables", () => {
  for (const sel of [".sql-editor .cm-editor", ".dbml-editor .cm-editor"]) {
    const body = rules(appCss).find((r) => r.selector === sel)?.body ?? "";
    expect(body).toMatch(/font-family:\s*var\(--editor-font-family/);
    expect(body).toMatch(/font-size:\s*var\(--editor-font-size/);
    expect(body).toMatch(/line-height:\s*var\(--editor-line-height/);
    expect(body).toMatch(/font-variant-ligatures:\s*var\(--editor-ligatures/);
    expect(body).toMatch(/font-feature-settings:\s*var\(--editor-features/);
  }
});

test("header_name_never_shrinks_before_its_type", () => {
  expect(bodyOf(".header-name")).toMatch(/flex:\s*none/);
  expect(bodyOf(".header-name")).not.toMatch(/text-overflow/);
  expect(bodyOf(".type-hint")).toMatch(/min-width:\s*0/);
  expect(bodyOf(".type-hint")).toMatch(/text-overflow:\s*ellipsis/);
});

test("production_wash_fills_every_result_state", () => {
  const wash = rules(appCss).filter((r) => r.selector.split(",").some((x) => x.trim() === ".prod-wash .results-body"));
  expect(wash.length).toBeGreaterThan(0);
  expect(bodyOf(".prod-wash .results-body")).toMatch(/background:\s*var\(--c-prod-wash\)/);
  for (const sel of [".prod-wash .results-foot", ".prod-wash .result-state", ".prod-wash .plan-view", ".prod-wash .query-error"]) {
    expect(bodyOf(sel), sel).toMatch(/background:\s*var\(--c-prod-wash\)/);
  }
});

test("result_toolbar_is_36px_and_does_not_clip_its_popovers", () => {
  const bar = bodyOf(".results-tabs");
  expect(bar).toMatch(/height:\s*36px/);
  expect(bar).not.toMatch(/overflow(-x|-y)?:\s*(hidden|clip|auto|scroll)/);
  expect(bodyOf(".results")).not.toMatch(/overflow(-x|-y)?:\s*(hidden|clip)/);
});

test("table_card_is_216", () => {
  const card = rules(appCss).find((r) => r.selector === ".table-card")?.body ?? "";
  expect(card).toMatch(/width:\s*216px/);
  const row = rules(appCss).find((r) => r.selector === ".table-card-column")?.body ?? "";
  expect(row).toMatch(/height:\s*24px/);
  const hd = rules(appCss).find((r) => r.selector === ".table-card-header")?.body ?? "";
  expect(hd).toMatch(/height:\s*32px/);
  // Handles show on hover or selection only.
  expect(rules(appCss).some((r) => /react-flow__handle/.test(r.selector) && /opacity:\s*0/.test(r.body))).toBe(true);
});

test("the_schema_islands_have_a_6px_gap_and_do_not_clip_their_menus", () => {
  const row = rules(appCss).find((r) => r.selector === ".schema-builder")?.body ?? "";
  expect(row).toMatch(/gap:\s*6px/);
  const island = rules(appCss).find((r) => r.selector === ".schema-island")?.body ?? "";
  expect(island).toMatch(/border-radius:\s*var\(--rounded-lg\)/);
  // The pane header's ... menu is absolutely positioned inside it.
  expect(island).not.toMatch(/overflow(-x|-y)?:\s*(hidden|clip|auto|scroll)/);
});

const CLIPS = /overflow(-x|-y)?:\s*(hidden|clip|auto|scroll)/;

test("table_header_is_one_36px_strip_that_does_not_clip_its_menus", () => {
  const strip = bodyOf(".table-header");
  expect(strip).toMatch(/height:\s*36px/);
  expect(strip).toMatch(/display:\s*flex/);
  expect(strip).not.toMatch(/flex-wrap:\s*wrap/);
  // The Connection menu and the filter, columns and export popovers are absolutely positioned inside it.
  expect(strip).not.toMatch(CLIPS);
  // Nor may any ancestor up to the tab body: the section, the work pane and the work area.
  for (const sel of [".grid-view", ".work-pane", ".work"]) expect({ sel, clips: CLIPS.test(bodyOf(sel)) }).toEqual({ sel, clips: false });
  expect(bodyOf(".table-header .grid-filter")).not.toMatch(CLIPS);
});

test("edited_row_numbers_stay_faint", () => {
  expect(bodyOf(".grid .row-number")).toMatch(/color:\s*var\(--c-text-faint\)/);
  const edited = bodyOf(".row-number-edited");
  expect(edited).not.toMatch(/color\s*:/);
  expect(edited).not.toMatch(/font-weight\s*:/);
  // Only the new row's + and the deleted row's - are coloured.
  expect(bodyOf(".grid tr.row-added td.row-number")).toMatch(/color:\s*var\(--c-success-text\)/);
  expect(bodyOf(".row-number-deleted")).toMatch(/color:\s*var\(--c-danger-text\)/);
});

test("deleted_rows_are_faint_and_struck", () => {
  const body = bodyOf(".grid tr.row-deleted td:not(.row-number)");
  expect(body).toMatch(/text-decoration:\s*line-through/);
  expect(body).toMatch(/color:\s*var\(--c-text-faint\)/);
});

test("row_hover_uses_bg_hover", () => {
  expect(bodyOf(".grid tr:hover td")).toMatch(/background:\s*var\(--c-bg-hover\)/);
});

/** H5: a Home row is padding 7/12/8 with the name and host lines 2 px apart. */
test("home_connection_row_is_7_12_8_with_2px_line_gap", () => {
  const body = bodyOf(".list-row");
  expect(body).toMatch(/padding:\s*7px 12px 8px/);
  expect(body).toMatch(/row-gap:\s*2px/);
});

/** H12: Home scrolls inside the header-less body and Recent, with the global themed thin bar; the pane itself never shows a native one. */
test("home_main_uses_the_thin_scrollbar", () => {
  expect(bodyOf(".home-main")).toMatch(/overflow:\s*hidden/);
  expect(bodyOf(".home-content")).not.toMatch(/overflow/);
  for (const sel of [".home-scroll", ".recent"]) {
    expect(bodyOf(sel)).toMatch(/overflow:\s*auto/);
    expect(bodyOf(sel)).not.toMatch(/scrollbar-/);
  }
  expect(bodyOf("::-webkit-scrollbar")).toMatch(/width:\s*10px/);
  expect(bodyOf("::-webkit-scrollbar-button")).toMatch(/display:\s*none/);
});

/** Q4: History docks at 360 px, rows follow the density token, and nothing around the menu clips it. */
test("history_panel_is_360", () => {
  expect(bodyOf(".body-history")).toMatch(/grid-template-columns:\s*var\(--layout-tree-width\) minmax\(0, 1fr\) 360px/);
  expect(bodyOf(".history-row")).toMatch(/min-height:\s*calc\(var\(--row-h\)/);
  for (const sel of [".history-panel", ".history-head"]) expect(bodyOf(sel)).not.toMatch(/overflow:\s*hidden/);
  expect(bodyOf(".history-row-failed")).toMatch(/color:\s*var\(--c-danger-text\)/);
});

/** A5: the Ask header sits on the panel with no rule under it; the composer keeps its own rule above. */
test("ai_header_has_no_rule", () => {
  expect(bodyOf(".ai-panel-head")).not.toMatch(/border-bottom\s*:\s*(?!0|none)/);
  expect(bodyOf(".ai-panel-head")).toMatch(/height:\s*36px/);
  for (const sel of [".ai-panel", ".ai-panel-head"]) expect(bodyOf(sel)).not.toMatch(/overflow:\s*hidden/);
});

/** C4: the Theme menu opens upward out of the status bar, so neither the bar nor the root clips it. */
test("status_bar_does_not_clip_its_theme_menu", () => {
  expect(bodyOf(".app-status")).not.toMatch(CLIPS);
  expect(bodyOf(".app-status .menu")).toMatch(/bottom:\s*calc\(100%/);
  // The query status inside the bar clips its own text instead.
  expect(bodyOf(".app-status-slot .query-status")).toMatch(/min-width:\s*0/);
});

/** E2: the database name shrinks with an ellipsis before the header's labels turn into icons. */
test("editor_header_database_name_gives_way_first", () => {
  const root = bodyOf(".editor-header .menu-root:has(> .editor-header-db)");
  expect(root).toMatch(/flex:\s*0 1 auto/);
  expect(root).toMatch(/min-width:\s*96px/);
  expect(bodyOf(".editor-header .editor-header-db")).toMatch(/min-width:\s*0/);
  expect(bodyOf(".editor-header .editor-header-db")).toMatch(/max-width:\s*100%/);
  expect(bodyOf(".editor-header-name")).toMatch(/text-overflow:\s*ellipsis/);
});

/** E4: CodeMirror's base theme (".ͼ1 .cm-scroller", two classes) sets monospace; a three-class rule hands the editor font down. */
test("editor_scroller_inherits_the_editor_font", () => {
  for (const sel of [".sql-editor .cm-editor .cm-scroller", ".dbml-editor .cm-editor .cm-scroller"]) {
    const body = bodyOf(sel);
    expect(body, sel).toMatch(/font-family:\s*inherit/);
    expect(body, sel).toMatch(/line-height:\s*inherit/);
  }
});

/** NF4, frame i: the Read-only write note is a short 12 px UI-font line in muted text that wraps inside the pane. */
test("read_only_write_note_is_a_12px_ui_line_that_wraps", () => {
  const note = bodyOf(".sql-editor .cm-blocked-note");
  expect(note).toMatch(/font:\s*var\(--font-label\)/);
  expect(note).toMatch(/color:\s*var\(--c-text-muted\)/);
  expect(note).toMatch(/white-space:\s*normal/);
  expect(note).toMatch(/overflow-wrap:\s*anywhere/);
  expect(note).toMatch(/max-width:\s*100%/);
  expect(note).not.toMatch(/font-family-code|font-mono/);
  expect(tokensCss).toMatch(/--font-label-family:\s*var\(--font-family-ui\)/);
  expect(tokensCss).toMatch(/--font-label-size:\s*12px/);
});

/** E6, PR28: the close on a result tab shows on hover and on keyboard focus only. */
test("result_tab_close_shows_on_hover", () => {
  expect(bodyOf(".result-tab-close")).toMatch(/visibility:\s*hidden/);
  expect(bodyOf(".result-tab:hover .result-tab-close")).toMatch(/visibility:\s*visible/);
  expect(bodyOf(".result-tab:focus-within .result-tab-close")).toMatch(/visibility:\s*visible/);
  expect(bodyOf(".result-tab-button")).toMatch(/cursor:\s*pointer/);
});

/** NF6: on a Production table the WHERE field is one background: its editor is transparent and outranks the wash rule. */
test("where_field_has_one_background_on_production", () => {
  const sel = ".table-header .grid-filter .sql-editor .cm-editor";
  expect(bodyOf(sel)).toMatch(/background:\s*transparent/);
  expect(specificity(sel)[1]).toBeGreaterThan(specificity(".prod-wash .sql-editor .cm-editor")[1]);
  expect(bodyOf(".grid-filter")).toMatch(/background:\s*var\(--c-bg-surface\)/);
});

/** NF7: the row-number gutter fits "100,000" (seven code-font characters) beside its padding. */
test("row_number_gutter_fits_six_digits_with_separators", () => {
  const body = bodyOf(".grid .row-number");
  expect(body).toMatch(/--row-number-fit:\s*max\(var\(--layout-row-number-width\), calc\(7ch \+ 2 \* var\(--spacing-sm\)\)\)/);
  expect(body).toMatch(/(?:^|\s)width:\s*var\(--row-number-fit\)/);
  expect(body).toMatch(/min-width:\s*var\(--row-number-fit\)/);
  expect(body).toMatch(/font:\s*var\(--font-mono-small\)/);
});

/** A6: a long answer SQL line scrolls inside its block; the thread's one column never widens and never scrolls sideways. */
test("answer_sql_scrolls_inside_itself_not_the_thread", () => {
  const thread = bodyOf(".thread");
  expect(thread).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
  expect(thread).toMatch(/overflow-x:\s*hidden/);
  expect(thread).toMatch(/overflow-y:\s*auto/);
  expect(bodyOf(".msg-ai")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
  expect(bodyOf(".msg-ai")).toMatch(/min-width:\s*0/);
  expect(bodyOf(".answer-sql")).toMatch(/min-width:\s*0/);
  expect(bodyOf(".answer-sql .sql-block")).toMatch(/overflow-x:\s*auto/);
  // Copy sits in the action bar under the block, inside the answer's width.
  expect(bodyOf(".answer-sql-actions")).toMatch(/display:\s*flex/);
});

/** M1, frame 8: a toast is at least 44 px and wraps a long message to two lines before the ellipsis. */
test("toast_wraps_to_two_lines", () => {
  const toast = bodyOf(".toast");
  expect(toast).toMatch(/min-height:\s*44px/);
  expect(toast).not.toMatch(/(?:^|[\s;])height:\s*44px/);
  const text = bodyOf(".toast-text");
  expect(text).toMatch(/-webkit-line-clamp:\s*2/);
  expect(text).toMatch(/-webkit-box-orient:\s*vertical/);
  expect(text).toMatch(/display:\s*-webkit-box/);
  expect(text).toMatch(/white-space:\s*normal/);
  expect(text).not.toMatch(/nowrap/);
});

/** NF1: the tab strip never shows a scrollbar under the tabs. */
test("tab_strip_scrolls_without_a_bar", () => {
  expect(bodyOf(".tab-list")).toMatch(/overflow-x:\s*auto/);
  expect(bodyOf(".tab-list::-webkit-scrollbar")).toMatch(/display:\s*none/);
  expect(bodyOf(".tab-list::-webkit-scrollbar")).toMatch(/height:\s*0/);
});

/** Frame 2: the error title is text-coloured with a red icon; the source, SQLSTATE and message share one red box. */
test("query_error_matches_frame_2", () => {
  expect(bodyOf(".query-error-head")).toMatch(/color:\s*var\(--c-text\)/);
  expect(bodyOf(".query-error-icon")).toMatch(/color:\s*var\(--c-danger-text\)/);
  const box = bodyOf(".query-error-said");
  expect(box).toMatch(/background:\s*var\(--c-danger-subtle\)/);
  expect(box).toMatch(/border-radius:\s*var\(--rounded-md\)/);
  expect(bodyOf(".query-error-message")).not.toMatch(/background|border/);
  expect(bodyOf(".query-error-code")).toMatch(/font:\s*var\(--font-mono-small\)/);
  expect(bodyOf(".query-error-quoted")).toMatch(/color:\s*var\(--c-syn-string\)/);
  expect(bodyOf(".query-error-near")).toMatch(/display:\s*flex/);
});

/** The window's minimum is 1024 px; a fixed bar wider than that must not widen the whole layout. */
test("the_feature_bar_cannot_widen_the_window", () => {
  const body = (selector: string) => rules(appCss).find((r) => r.selector === selector)?.body ?? "";
  expect(body(".app")).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  expect(body(".feature-bar")).toMatch(/min-width:\s*0/);
  expect(body(".feature-bar")).toMatch(/overflow-x:\s*auto/);
});
