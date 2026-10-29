import { expect, test } from "vitest";
import appCss from "./app.css?raw";
import tokensCss from "./tokens.css?raw";
import fontsCss from "./fonts.css?raw";
import compareCss from "./compare.css?raw";
import flowBoardCss from "./flow-board.css?raw";

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
  // clip, not hidden: the pane itself can never be scrolled by focus (layoutFit.test.ts).
  expect(cascadedOverflowY(document.querySelector("aside.side")!)).toBe("clip");
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
  // S4, A4: the AI panel narrows the tree to 264, with or without History beside it; with both, the side columns
  // give way on a narrow window so the work area keeps 320 px (layoutFit.test.ts).
  // The Ask column follows its sash, 360 px until dragged (assistant/AskSash.tsx).
  expect(bodyOf(".body-ai")).toMatch(/grid-template-columns:\s*264px minmax\(0, 1fr\) var\(--ask-width, 360px\)/);
  expect(bodyOf(".body-history.body-ai")).toMatch(/grid-template-columns:\s*minmax\(180px, 264px\) minmax\(320px, 1fr\) minmax\(220px, 360px\) var\(--ask-width, 360px\)/);
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
  // Faint, or subtle with stripes on (gridAppearance.test.tsx).
  expect(bodyOf(".grid .row-number")).toMatch(/color:\s*var\(--grid-row-number-text\)/);
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
  expect(bodyOf(".home-main")).toMatch(/overflow:\s*clip/);
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

/** D2 Task 6 (P30): the Ask's chat history draws with its own classes, all under `.history-menu`, so it and the query History never style each other. */
test("chat_history_rows_are_their_own_classes", () => {
  const own = [
    "history-find",
    "history-items",
    "history-group",
    "history-item",
    "history-chat",
    "history-chat-title",
    "history-chat-time",
    "history-chat-place",
    "history-chat-table",
    "history-tag",
    "history-actions",
    "history-edit",
    "history-rename",
    "history-ask",
    "history-clear-all",
    "history-none",
  ];
  const all = rules(appCss).flatMap((r) => r.selector.split(",").map((s) => ({ sel: s.trim(), body: r.body })));
  for (const name of own) {
    const uses = all.filter((r) => new RegExp(`\\.${name}(?![\\w-])`).test(r.sel));
    expect({ name, styled: uses.length > 0 }).toEqual({ name, styled: true });
    for (const r of uses) expect({ name, sel: r.sel }).toEqual({ name, sel: expect.stringMatching(/^\.history-menu\s/) });
  }
  // The popover reuses none of the query History's classes.
  const tsx = TSX.find(([path]) => path.endsWith("assistant/ThreadHistory.tsx"))![1];
  for (const theirs of ["history-row", "history-day", "history-section", "history-list", "history-search", "history-empty", "history-hit"]) {
    expect({ theirs, used: new RegExp(`["\\s]${theirs}["\\s]`).test(tsx) }).toEqual({ theirs, used: false });
  }
  const body = (sel: string) =>
    all
      .filter((r) => r.sel === sel)
      .map((r) => r.body)
      .join("\n");
  expect(body(".history-menu")).toMatch(/width:\s*360px/);
  expect(body(".history-menu .history-items")).toMatch(/max-height:\s*320px/);
  expect(body(".history-menu .history-item")).toMatch(/height:\s*52px/);
  expect(body(".history-menu .history-group")).toMatch(/height:\s*28px/);
  expect(body(".history-menu .history-group")).toMatch(/font-weight:\s*600/);
  expect(body(".history-menu .history-group")).not.toMatch(/text-transform|letter-spacing/);
  expect(body('.history-menu .history-chat[aria-current="true"]')).toMatch(/background:\s*var\(--c-bg-active\)/);
  expect(body('.history-menu .history-chat[aria-current="true"]')).not.toMatch(/border-left|box-shadow/);
  expect(body(".history-menu .history-chat:focus-visible")).toMatch(/outline:\s*var\(--focus-ring-width\) solid var\(--c-focus\)/);
  expect(body(".history-menu .history-tag")).toMatch(/border-radius:\s*4px/);
  expect(body(".history-menu .history-tag")).toMatch(/background:\s*var\(--c-bg-raised\)/);
  expect(body(".history-menu .history-tag")).not.toMatch(/border:\s*[^0\s]/);
  expect(body(".history-menu .history-ask")).toMatch(/background:\s*var\(--c-danger-subtle\)/);
  expect(body(".history-menu .history-clear-all")).toMatch(/color:\s*var\(--c-danger-text\)/);
  // Tokens only, never a hex colour, so both themes follow.
  for (const r of all.filter((x) => x.sel.startsWith(".history-menu"))) {
    expect({ sel: r.sel, hex: /#[0-9a-f]{3,8}\b/i.test(r.body) }).toEqual({ sel: r.sel, hex: false });
  }
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
  // P11-36: the groups clip inside their own box instead of the bar scrolling Ask out of reach.
  expect(body(".feature-groups")).toMatch(/overflow-x:\s*clip/);
});

/** P11-3: the AI access table keeps to the Settings column (512px) instead of widening the page. */
test("parity_P11_3_access_table_fits_the_settings_column", () => {
  const fit = bodyOf(".share-table-fit");
  expect(fit).toMatch(/table-layout:\s*fixed/);
  expect(fit).toMatch(/width:\s*100%/);
  // The selects take their column's width, never a minimum wider than it.
  const select = bodyOf(".share-table-fit .select");
  expect(select).toMatch(/min-width:\s*0/);
  expect(select).toMatch(/width:\s*100%/);
  expect(bodyOf(".share-table-fit .sync-select")).toMatch(/min-width:\s*0/);
  // The Connection name and the Context text give way with an ellipsis or a wrap, not overflow.
  expect(bodyOf(".share-table-fit .cname")).toMatch(/min-width:\s*0/);
  // An ellipsis shows only on text that does not wrap.
  const name = bodyOf(".share-table-fit .cname-text");
  expect(name).toMatch(/white-space:\s*nowrap/);
  expect(name).toMatch(/text-overflow:\s*ellipsis/);
  expect(bodyOf(".share-table-fit .share-dialect")).toMatch(/text-overflow:\s*ellipsis/);
  expect(bodyOf(".share-table-fit .share-dialect")).toMatch(/white-space:\s*nowrap/);
  expect(bodyOf(".share-table-fit .share-ctx")).toMatch(/white-space:\s*normal/);
  const widths = ["conn", "dialect", "access", "sync", "ctx"].map((c) => /width:\s*(\d+)%/.exec(bodyOf(`.share-col-${c}`))?.[1]).map(Number);
  expect(widths.reduce((a, b) => a + b, 0)).toBe(100);
});

/** P11-33: a diagram Sends row keeps the file name and its size on one line each. */
test("parity_P11_33_sends_row_does_not_wrap_the_name_or_size", () => {
  // A pill keeps one line and may shrink: a long label ends in an ellipsis instead of wrapping or overflowing.
  const pill = bodyOf(".send-pill");
  expect(pill).toMatch(/white-space:\s*nowrap/);
  expect(pill).toMatch(/min-width:\s*0/);
  expect(pill).not.toMatch(/flex:\s*none/);
  const label = bodyOf(".send-pill-label");
  expect(label).toMatch(/overflow:\s*hidden/);
  expect(label).toMatch(/text-overflow:\s*ellipsis/);
  // The outline pill's long label still wraps (board 11.7).
  expect(bodyOf(".send-pill-tall .send-pill-label")).toMatch(/white-space:\s*normal/);
  const size = bodyOf(".sends-item .sends-size");
  expect(size).toMatch(/white-space:\s*nowrap/);
  expect(size).toMatch(/flex:\s*none/);
  // The reason takes only the room left (basis 0), so the pill's name gives way last.
  expect(bodyOf(".sends-item .sends-lock")).toMatch(/flex:\s*1 1 0/);
  expect(bodyOf(".sends-item .sends-lock")).toMatch(/min-width:\s*0/);
});

test("parity_P11_23_answer_log_labels_wrap_instead_of_cutting", () => {
  // Diagram boxes wrap their time or detail under the label instead of ending it in an ellipsis.
  expect(bodyOf(".dbox")).toMatch(/flex-wrap:\s*wrap/);
  const t = bodyOf(".dbox .t");
  expect(t).not.toMatch(/white-space:\s*nowrap/);
  expect(t).not.toMatch(/text-overflow:\s*ellipsis/);
  // The Log's source column is wide enough for the longest source, "rail.execution".
  expect(bodyOf(".lrow")).toMatch(/grid-template-columns:\s*14px 44px 6ch 14ch minmax\(0, 1fr\)/);
  // The level column fits "DEBUG" on one line (it wrapped to "DEBU G" in a 38 px column).
  expect(bodyOf(".lv")).toMatch(/white-space:\s*nowrap/);
});

test("parity_P11_12_a_sends_label_stays_on_one_line_from_the_left", () => {
  const pill = bodyOf(".send-pill");
  expect(pill).toMatch(/white-space:\s*nowrap/);
  expect(pill).toMatch(/text-align:\s*left/);
});

test("parity_P11_14_the_query_toolbar_never_widens_its_column", () => {
  // One track that may shrink to nothing: the strip's min-content width cannot push the tab past its column.
  expect(bodyOf(".query-tab")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
  expect(bodyOf(".editor-header-more")).toMatch(/flex:\s*none/);
});

test("parity_P11_36_ask_stays_outside_the_feature_bar_overflow", () => {
  // The groups clip inside their own box; Ask and More never shrink or scroll away.
  const groups = bodyOf(".feature-groups");
  expect(groups).toMatch(/min-width:\s*0/);
  expect(groups).toMatch(/overflow-x:\s*clip/);
  expect(groups).toMatch(/overflow-y:\s*visible/);
  expect(bodyOf(".feature-bar")).not.toMatch(/overflow-x:\s*auto/);
  expect(bodyOf(".feature-bar > .feature-button")).toMatch(/flex:\s*none/);
  expect(bodyOf(".feature-groups .feature-button[data-overflow]")).toMatch(/visibility:\s*hidden/);
});

test("parity_P11_37_a_held_tooltip_does_not_show", () => {
  expect(bodyOf(".feature-button[data-tip-off]::after")).toMatch(/opacity:\s*0/);
});

// Item 49: the tinted rows draw their column dividers with the tint divider token.
test("tinted_grid_cells_draw_their_column_dividers_with_the_tint_token", () => {
  const plain = appCss.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const sel of [".grid tr.row-added td", ".grid tr.row-deleted td", ".grid td.cell-edited"]) {
    const bodies = [...plain.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter((m) => m[1].split(",").map((s) => s.trim()).includes(sel))
      .map((m) => m[2]);
    expect(bodies.some((b) => /border-right-color:\s*var\(--grid-tint-divider\)/.test(b)), sel).toBe(true);
  }
});

// Item 43: the Differences tree, its chips, the legend and the DDL lines take the diff status tokens.
test("item_43_compare_status_colours_come_from_the_diff_tokens", () => {
  expect(compareCss.length).toBeGreaterThan(0);
  const all = rules(compareCss);
  const body = (sel: string) => all.filter((r) => r.selector.split(",").map((s) => s.trim()).includes(sel)).map((r) => r.body).join("\n");
  for (const k of ["added", "removed", "changed"]) {
    expect(body(`.diff-${k}`)).toMatch(new RegExp(`color:\\s*var\\(--diff-${k}\\)`));
    expect(body(`.compare-mark-${k}`)).toMatch(new RegExp(`color:\\s*var\\(--diff-${k}\\)`));
    expect(body(`.compare-chip-${k} .compare-chip-dot`)).toMatch(new RegExp(`background:\\s*var\\(--diff-${k}\\)`));
    expect(body(`.compare-chip-${k}.compare-chip-on`)).toMatch(new RegExp(`var\\(--diff-${k}-tint\\)`));
    expect(body(`.compare-chip-${k}.compare-chip-on`)).toMatch(new RegExp(`border-color:\\s*var\\(--diff-${k}\\)`));
  }
  expect(body(".compare-dl-add")).toMatch(/var\(--diff-added-tint\)/);
  expect(body(".compare-dl-rem")).toMatch(/var\(--diff-removed-tint\)/);
  expect(body(".compare-dl-chg")).toMatch(/var\(--diff-changed-tint\)/);
  // The letter badge sits at the right edge in the mono face; removed rows are never struck through.
  expect(body(".compare-trow-badge")).toMatch(/margin-left:\s*auto/);
  expect(body(".compare-trow-badge")).toMatch(/font-family:\s*var\(--font-mono-family\)/);
  expect(compareCss).not.toMatch(/line-through/);
  // The neutral rows keep the text colour.
  expect(body(".compare-trow-name")).toMatch(/color:\s*var\(--c-text\)/);
});

// Item 42: every item in the 40 px title bar is 32 px tall on one centre line, 24 px down.
test("item_42_title_bar_items_share_one_height_and_centre_line", () => {
  expect(bodyOf(".title-bar")).toMatch(/align-items:\s*flex-end/);
  expect(bodyOf(".title-bar-glyph")).toMatch(/height:\s*32px/);
  expect(bodyOf(".title-home")).toMatch(/height:\s*32px/);
  expect(bodyOf(".group-switcher")).toMatch(/height:\s*32px/);
  expect(bodyOf(".group-switcher")).not.toMatch(/align-self:\s*center/);
  expect(bodyOf(".tab-strip")).toMatch(/height:\s*32px/);
  expect(bodyOf(".tab-strip > .icon-button")).not.toMatch(/align-self:\s*center/);
  expect(bodyOf(".work-tab")).toMatch(/height:\s*var\(--tab-height\)/);
  // The window buttons fill the bar's height, their glyph on the same centre line.
  expect(bodyOf(".window-button")).toMatch(/height:\s*40px/);
  expect(bodyOf(".window-button")).toMatch(/padding-top:\s*8px/);
  // The divider sits on the centre line: 18 px tall, 7 px up from the bottom.
  expect(bodyOf(".title-divider")).toMatch(/margin:\s*0 6px 7px/);
});

// Item 48: Edge-style tabs.
test("item_48_tabs_are_edge_style", () => {
  // Steady widths from the strip's one observer, at most 220 px; the active one at least 96 px.
  expect(bodyOf(".work-tab")).toMatch(/width:\s*var\(--tab-w,\s*220px\)/);
  expect(bodyOf(".work-tab-on")).toMatch(/width:\s*var\(--tab-active-w,\s*220px\)/);
  expect(bodyOf(".work-tab-on")).toMatch(/min-width:\s*96px/);
  // No gap: a divider between inactive tabs instead, hidden beside the active and the hovered tab.
  expect(bodyOf(".tab-list")).toMatch(/gap:\s*0/);
  expect(bodyOf(".work-tab::before")).toMatch(/background:\s*var\(--tab-divider\)/);
  expect(bodyOf(".work-tab:first-child::before")).toMatch(/opacity:\s*0/);
  for (const sel of [".work-tab-on + .work-tab::before", ".work-tab:hover + .work-tab::before", ".work-tab:not(.work-tab-on):hover::before"]) {
    expect(bodyOf(sel)).toMatch(/opacity:\s*0/);
  }
  // Hover is a soft fill inside the tab.
  expect(bodyOf(".work-tab:not(.work-tab-on):hover::after")).toMatch(/background:\s*var\(--tab-hover-fill\)/);
  // The active tab is raised in the surface colour, with no Group underline, and joins the bar below.
  expect(bodyOf(".work-tab-on")).toMatch(/background:\s*var\(--tab-active-background\)/);
  expect(appCss).not.toMatch(/inset 0 -2px 0 var\(--group/);
  expect(bodyOf(".work-tab-on::before")).toMatch(/radial-gradient/);
  expect(bodyOf(".work-tab-on::after")).toMatch(/radial-gradient/);
  // Narrow: inactive closes show on hover only; compact: inactive tabs keep only their icon.
  expect(bodyOf(".tab-list-narrow .work-tab:not(.work-tab-on):not(:hover) .work-tab-close")).toMatch(/display:\s*none/);
  expect(bodyOf(".tab-list-compact .work-tab:not(.work-tab-on) .work-tab-name")).toMatch(/display:\s*none/);
  // The feature bar is the surface colour with no border, so the active tab joins it.
  expect(bodyOf(".feature-bar")).toMatch(/background:\s*var\(--c-bg-surface\)/);
  expect(bodyOf(".feature-bar")).toMatch(/border:\s*0/);
});

// Review fix 2 (item 48): the active tab's left foot is the ::before the divider rules hide; it always draws, as the
// first tab and beside a hovered tab.
test("item_48_the_active_tabs_feet_beat_every_divider_hiding_rule", () => {
  const all = rules(appCss);
  const foot = all.find((r) => r.selector === ".work-tab-on::before")?.body ?? "";
  expect(foot).toMatch(/opacity:\s*1\s*!important/);
  // Every rule that hides a tab's ::before is a plain declaration, so the foot's !important wins over each.
  const hiders = all.filter((r) => /\.work-tab[^,{]*::before/.test(r.selector) && /opacity:\s*0\b/.test(r.body));
  expect(hiders.map((r) => r.selector).join("\n")).toMatch(/\.work-tab:first-child::before/);
  expect(hiders.map((r) => r.selector).join("\n")).toMatch(/\.work-tab:hover \+ \.work-tab::before/);
  for (const r of hiders) expect({ sel: r.selector, important: /opacity:\s*0\s*!important/.test(r.body) }).toEqual({ sel: r.selector, important: false });
});

test("the Windows webview's own password reveal and clear buttons are hidden, so only Contura's Show password shows", () => {
  expect(appCss).toMatch(/input::-ms-reveal,\s*input::-ms-clear\s*\{\s*display:\s*none;\s*\}/);
});

test("the_appearance_preview_draws_its_rows_on_the_grid_surface", () => {
  // On the surface, as `.grid td`: the stripe is darker than its rows, as in the real grid, not lighter. The
  // palette tokens themselves, so they follow the preview's own theme class.
  expect(bodyOf(".spv-grid")).toMatch(/background:\s*var\(--c-bg-surface\)/);
  expect(bodyOf(".spv-row.alt")).toMatch(/background:\s*var\(--c-grid-stripe\)/);
});

// Polish A1: rows that hover inside a raised surface use the raised-hover fill, which Dracula keeps apart from the surface.
test("hover_on_raised_surfaces_uses_the_raised_hover_token", () => {
  const all = rules(appCss);
  const fill = (selector: string) => {
    const hit = all.find((r) => r.selector.split(",").map((x) => x.trim()).includes(selector));
    expect(hit, selector).toBeTruthy();
    return (hit as { body: string }).body.match(/background:\s*([^;]+);/)?.[1];
  };
  for (const sel of [
    ".menu-item:hover",
    ".select-option-active",
    ".new-tab-item:hover",
    ".mrow:hover",
    ".qo-row:hover",
    ".filter-quick-button:hover",
  ]) {
    expect(fill(sel), sel).toBe("var(--c-bg-raised-hover)");
  }
});

// Fix round 1: a hover anywhere inside a raised surface (dialog X, toast Undo, popovers) uses the raised-hover fill,
// found by scope: every rule that paints --c-bg-raised also sets --c-bg-hover to it for itself and its children.
test("every_raised_surface_scopes_the_hover_token_to_raised_hover", () => {
  const all = rules(appCss);
  const raised = all.filter((r) => /(^|;|\s)background:\s*var\(--c-bg-raised\)/.test(r.body));
  expect(raised.length).toBeGreaterThan(20);
  // The canvas zoom panel belongs to the diagram work in another branch.
  const exempt = new Set([".diagram-canvas .react-flow__panel.canvas-zoom", ".feature-button::after", ".inline-name-error", ".app-tip", ".cm-editor .cm-search .cm-button"]);
  const scoped = new Set(
    all
      .filter((r) => /--c-bg-hover:\s*var\(--c-bg-raised-hover\)/.test(r.body))
      .flatMap((r) => r.selector.split(",").map((x) => x.trim())),
  );
  const missing = raised.flatMap((r) => r.selector.split(",").map((x) => x.trim())).filter((sel) => !exempt.has(sel) && !scoped.has(sel));
  expect(missing).toEqual([]);
});

test("select_hint_on_the_active_option_still_steps_up_for_the_menu_rows", () => {
  const all = rules(appCss);
  const stepUp = all.filter((r) => /color:\s*var\(--c-text-muted\)/.test(r.body)).map((r) => r.selector).join("\n");
  expect(stepUp).toContain(".select-option-active .select-hint");
});

// Fix round 2 (R1, N2): hovers inside raised surfaces that are not a selected state use the raised-hover fill, and a
// button's hover is visibly apart from its resting fill in every theme.
test("raised_surface_hovers_use_raised_hover_and_the_search_button_hover_shows", () => {
  const all = rules(appCss);
  const fill = (sel: string) => all.find((r) => r.selector.split(",").map((x) => x.trim()).includes(sel))?.body.match(/background:\s*([^;]+);/)?.[1] ?? "";
  for (const sel of [".key-picker-item:hover", ".vq-join-kind:hover:not(:disabled)", ".vq-pick-choice:hover", ".cm-editor .cm-search .cm-button:hover"]) {
    expect(fill(sel), sel).toBe("var(--c-bg-raised-hover)");
  }
  const css = tokensCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const block = (start: string) => {
    const open = css.indexOf("{", css.indexOf(start));
    return css.slice(open + 1, css.indexOf("}", open));
  };
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const [theme, body] of [["light", block(":root, .theme-light {")], ["dark", block(':root[data-theme="dark"], .theme-dark {')]] as const) {
    const t = new Map([...body.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]));
    // The search panel is a raised surface: its --c-bg-hover is the raised one.
    const resolve = (v: string) => {
      const name = v.match(/var\((--[\w-]+)\)/)?.[1] ?? "";
      return t.get(name === "--c-bg-hover" ? "--c-bg-raised-hover" : name) as string;
    };
    const [a, b] = [lum(resolve(fill(".cm-editor .cm-search .cm-button"))), lum(resolve(fill(".cm-editor .cm-search .cm-button:hover")))];
    expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), theme).toBeGreaterThanOrEqual(1.15);
  }
});

// Fix round 4 (live check): a point menu opened near the right edge keeps its natural width, so its labels are never
// cut; the clamp in PointMenu moves it left instead.
test("a_point_menu_keeps_its_natural_width_at_the_right_edge", () => {
  const menu = rules(appCss).filter((r) => r.selector.split(",").map((x) => x.trim()).includes(".tree-menu"));
  expect(menu.some((r) => /width:\s*max-content/.test(r.body))).toBe(true);
});

test("soft_lines_use_tokens_and_no_transition", () => {
  // Plan F Decision 2: far text keeps its layout and draws as soft bars of the faint text token, with no transition.
  for (const size of ["s", "m", "l"]) {
    const soft = rules(flowBoardCss).filter((r) => r.selector.includes(`[data-far~="${size}"] .board-ts-${size}`));
    expect(soft.length, size).toBeGreaterThan(0);
    const body = soft.map((r) => r.body).join("\n");
    expect(body).toMatch(/color:\s*transparent/);
    expect(body).toContain("color-mix(in srgb, var(--c-text-faint) 45%, transparent)");
    expect(body).toMatch(/border-radius:\s*2px/);
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(body).not.toMatch(/transition/);
  }
  // The ER bars take the same colour.
  expect(bodyIn(flowBoardCss, ".fkind-er-bars")).toContain("color-mix(in srgb, var(--c-text-faint) 45%, transparent)");
});
