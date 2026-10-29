// Small windows (1,024 x 480, and laptops at 125 to 150 percent scaling, about 1,280 x 650 to 1,536 x 760): nothing
// may end up below the window, under the status bar or past a pane's edge with no way to scroll to it. jsdom does no
// layout, so these hold the CSS that makes each screen fit; the real-window check at 1,024 x 480, 1,280 x 650 and
// 1,366 x 700 is in .superpowers/sdd/release-1.0/layout-report.md.
import { expect, test } from "vitest";
import { askLayout, askWidthRoom } from "../assistant/askWidth";
import appCss from "./app.css?raw";
import guideCss from "./guide.css?raw";
import compareCss from "./compare.css?raw";
import transferCss from "./transfer.css?raw";
import flowTabCss from "./flow-tab.css?raw";
import tokensCss from "./tokens.css?raw";

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of every rule whose selector list holds exactly `selector`, merged in order (at-rules unwrapped). */
function ruleIn(source: string, selector: string): Record<string, string> {
  const css = strip(source);
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(",").some((s: string) => s.trim() === selector)) continue;
    for (const d of m[2].split(";")) {
      const at = d.indexOf(":");
      if (at > 0) out[d.slice(0, at).trim()] = d.slice(at + 1).trim();
    }
  }
  return out;
}
const rule = (selector: string) => ruleIn(appCss, selector);

/** A length in px: `12px`, or a `var(--token)` that tokens.css sets to px. */
function pxOf(value: string): number {
  const v = value.trim();
  const name = /^var\((--[\w-]+)\)$/.exec(v)?.[1];
  const raw = name ? (new RegExp(`${name}:\\s*(\\d+)px`).exec(tokensCss)?.[1] ?? "") : (/^(\d+)px$/.exec(v)?.[1] ?? "");
  return raw === "" ? NaN : Number(raw);
}

test("ask_keeps_the_message_box_and_part_of_the_thread_on_a_short_window", () => {
  // User report: the Ask input sank below the window. The composer row was auto, so a long Sends list (or Show
  // exactly) grew it past the panel and the thread shrank to nothing. Now the composer row can shrink, the thread
  // keeps a minimum, and only the Sends list gives way, by scrolling.
  const rows = rule(".ai-panel")["grid-template-rows"];
  expect(rows).toMatch(/^auto minmax\(clamp\(80px, 30%, 200px\), 1fr\) minmax\(0, auto\)$/);
  expect(rule(".composer")).toMatchObject({ display: "flex", "flex-direction": "column", "min-height": "0" });
  expect(rule(".composer > *")).toMatchObject({ flex: "none" });
  expect(rule(".composer > .sends")).toMatchObject({ flex: "0 1 auto", "min-height": "0", "overflow-y": "auto", margin: "-3px", padding: "3px" });
});

test("an_open_sends_list_scrolls_under_its_own_line_on_a_short_window", () => {
  // Live check at 1,024 x 495: an open Sends list gets about 50 to 75 px between the thread's minimum and the message
  // box. Scrolled, its line (the fold chevron, the size, Show exactly) went out of view with the rows and the rows were
  // cut at the top. The line stays put while the rows, the notes and the tip scroll beneath it, and a focused switch
  // is scrolled clear of it. The message box and the Context line stay outside the scroller.
  expect(rule(".composer > .sends > .sends-row")).toMatchObject({ position: "sticky", top: "0", "z-index": "1", background: "var(--c-bg-panel)" });
  expect(rule(".composer > .sends")).toMatchObject({ "overflow-y": "auto", "scroll-padding-top": "31px" });
});

test("the_query_strip_and_the_results_fit_a_narrow_work_area", () => {
  // Beside the Ask panel at 1,024 px the work area is about 375 px: More fell past the strip's end, the result tools
  // past the pane's.
  expect(rule(".editor-header .menu-root:has(> .editor-header-connection)")).toMatchObject({ flex: "0 1 auto" });
  expect(rule(".editor-header .editor-header-connection")).toMatchObject({ "min-width": "0" });
  expect(rule(".results")["grid-template-columns"]).toBe("minmax(0, 1fr)");
  expect(rule(".results-summary")).toMatchObject({ flex: "0 1 auto", "min-width": "0", overflow: "hidden" });
  expect(rule(".result-tools")).toMatchObject({ flex: "none" });
  expect(rule(".results-foot-note")).toMatchObject({ "min-width": "0", overflow: "hidden", "text-overflow": "ellipsis" });
  expect(rule(".answer-sql-actions")).toMatchObject({ "flex-wrap": "wrap" });
});

/** A track list split at its top-level spaces: "minmax(260px, var(--ask-width, 360px))" stays one track. */
function tracksOf(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list.trim()) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

test("history_and_ask_together_leave_the_work_area_at_least_320px", () => {
  const cols = tracksOf(rule(".body-history.body-ai")["grid-template-columns"]);
  expect(cols).toHaveLength(4);
  const min = (track: string) => Number(/^minmax\((\d+)px,/.exec(track)?.[1] ?? NaN);
  expect(min(cols[1])).toBeGreaterThanOrEqual(320);
  // The Ask column is the sash's width, which useAskWidth holds to the room History leaves (AskSash.test.tsx).
  expect(cols[3]).toBe("var(--ask-width, 360px)");
  const ask = askLayout(360, askWidthRoom(1024, true)).width;
  // Two 6 px gaps per column boundary plus the 6 px padding each side: 1,024 px must hold every minimum.
  const total = cols.slice(0, 3).map(min).reduce((a, b) => a + b, 0) + ask + 3 * 6 + 2 * 6;
  expect(total).toBeLessThanOrEqual(1024);
});

test("home_actions_wrap_inside_the_header", () => {
  // At 1,024 px the one-line row ran under the Recent pane and hid New Connection.
  expect(rule(".home-actions")).toMatchObject({ flex: "0 1 auto", "min-width": "0", "flex-wrap": "wrap" });
});

test("first_start_guide_blocks_keep_their_height_in_the_scrolling_body", () => {
  // The "You are set" summary (overflow: hidden) shrank to a 20 px sliver at 1,024 x 480.
  expect(ruleIn(guideCss, ".fsg-body")).toMatchObject({ "min-height": "0", "overflow-y": "auto" });
  expect(ruleIn(guideCss, ".fsg-body > *")).toMatchObject({ "flex-shrink": "0" });
});

test("table_strips_keep_their_end_buttons_inside_a_narrow_pane", () => {
  // Beside the Ask panel at 1,024 px: Table, Save and Close SQL preview fell past the pane's edge.
  expect(rule(".table-header")).toMatchObject({ container: "table-header / inline-size" });
  expect(appCss).toMatch(/@container table-header \(max-width: 560px\)\s*\{\s*\.table-header-structure-label\s*\{\s*display: none;/);
  expect(rule(".table-header .table-header-name")).toMatchObject({ flex: "0 1 auto", overflow: "hidden", "text-overflow": "ellipsis" });
  expect(rule(".edits-bar")).toMatchObject({ container: "edits-bar / inline-size" });
  expect(appCss).toMatch(/@container edits-bar \(max-width: 520px\)\s*\{\s*\.edits-bar \.bar-label,\s*\.edits-bar \.kbd\s*\{\s*display: none;/);
  expect(rule(".preview-sql-head")).toMatchObject({ container: "preview-sql-head / inline-size" });
  expect(appCss).toMatch(/@container preview-sql-head \(max-width: 760px\)\s*\{\s*\.preview-sql-head \.bar-label\s*\{\s*display: none;/);
  expect(rule(".preview-sql-head > .icon-button")).toMatchObject({ flex: "none" });
});

test("a_long_sql_line_keeps_its_tag_after_the_text", () => {
  expect(rule(".sql-block-text")).toMatchObject({ flex: "1 0 auto", "white-space": "pre" });
});

test("shell_panes_clip_so_focus_cannot_scroll_them", () => {
  // A hidden box scrolls when something inside it takes focus: the Ask panel slid up, its head gone, when the
  // message box was focused below its edge. overflow: clip cannot be scrolled.
  expect(rule(".body > .place-wrap > *")).toMatchObject({ overflow: "clip" });
  expect(rule(".body > .settings-main")).toMatchObject({ overflow: "clip" });
  expect(rule(".body > .place-wrap > .side")).toMatchObject({ overflow: "clip" });
  expect(rule(".home-main")).toMatchObject({ overflow: "clip" });
});

test("the_visual_query_toolbar_drops_hints_then_words_when_narrow", () => {
  expect(rule(".vq-toolbar")).toMatchObject({ container: "vq-toolbar / inline-size" });
  expect(appCss).toMatch(/@container vq-toolbar \(max-width: 880px\)\s*\{\s*\.vq-toolbar \.kbd\s*\{\s*display: none;/);
  expect(appCss).toMatch(/@container vq-toolbar \(max-width: 560px\)\s*\{\s*\.vq-toolbar \.bar-label\s*\{\s*display: none;/);
  expect(rule(".vq-count")).toMatchObject({ "min-width": "0", overflow: "hidden" });
});

test("a_small_canvas_drops_its_overview_and_the_query_diagram_strip_fits", () => {
  expect(rule(".diagram-canvas")).toMatchObject({ container: "diagram-canvas / size" });
  expect(appCss).toMatch(
    /@container diagram-canvas \(max-height: 360px\) or \(max-width: 480px\)\s*\{\s*\.diagram-canvas \.react-flow__minimap\s*\{\s*display: none;/,
  );
  expect(rule(".query-diagram-strip")).toMatchObject({ container: "query-diagram-strip / inline-size" });
  expect(appCss).toMatch(/@container query-diagram-strip \(max-width: 480px\)\s*\{\s*\.query-diagram-readonly,\s*\.query-diagram-strip \.bar-label\s*\{\s*display: none;/);
});

test("compare_keeps_both_panes_and_the_sync_block_on_a_short_window", () => {
  // At 1,024 x 480 the source and target panes shrank to a 2 px line under the In the Sync Script block.
  expect(ruleIn(compareCss, ".compare-panes")).toMatchObject({ flex: "1", "min-height": "80px" });
  expect(ruleIn(compareCss, ".compare-inscript")).toMatchObject({ flex: "0 1 auto", display: "flex", "flex-direction": "column", "min-height": "66px" });
  expect(ruleIn(compareCss, ".compare-inscript .sql-block")).toMatchObject({ flex: "0 1 auto", "min-height": "0" });
  // The head, both minimums and the block's top and bottom margins fit the 212 px the right side has at 1,024 x 480.
  const head = pxOf(ruleIn(compareCss, ".compare-right-head").height);
  const panes = pxOf(ruleIn(compareCss, ".compare-panes")["min-height"]);
  const block = pxOf(ruleIn(compareCss, ".compare-inscript")["min-height"]);
  const [top, , bottom] = ruleIn(compareCss, ".compare-inscript").margin.split(/\s+/).map(pxOf);
  expect([head, panes, block, top, bottom].every(Number.isFinite)).toBe(true);
  expect(head + panes + block + top + bottom).toBeLessThanOrEqual(212);
  expect(ruleIn(compareCss, ".script-pane-title")).toMatchObject({ "white-space": "nowrap", "text-overflow": "ellipsis" });
});

test("transfer_tables_step_scrolls_inside_instead_of_running_under_the_footer", () => {
  expect(ruleIn(transferCss, ".transfer-tables")).toMatchObject({ "grid-template-rows": "minmax(0, 1fr)", "min-height": "0" });
  expect(ruleIn(transferCss, ".transfer-side")).toMatchObject({ "min-height": "0", "overflow-y": "auto" });
  expect(ruleIn(transferCss, ".transfer-side > *")).toMatchObject({ "flex-shrink": "0" });
  // F2: a full-width field's focus ring stays whole inside the scroller.
  expect(ruleIn(transferCss, ".transfer-side")).toMatchObject({ margin: "-3px", padding: "3px" });
});

test("dialogs_use_a_short_window", () => {
  expect(appCss).toMatch(/@media \(max-height: 600px\)\s*\{\s*\.dialog\s*\{\s*max-height: calc\(100vh - 2 \* var\(--spacing-lg\)\);/);
});

test("diagram_assistant_keeps_its_message_box_in_view_on_a_short_window", () => {
  expect(ruleIn(flowTabCss, ".flow-chat")).toMatchObject({ "min-height": "clamp(80px, 30%, 200px)", "overflow-y": "auto" });
  expect(ruleIn(flowTabCss, ".flow-composer")).toMatchObject({ flex: "0 1 auto", "min-height": "0" });
  expect(ruleIn(flowTabCss, ".flow-composer > *")).toMatchObject({ flex: "none" });
  expect(ruleIn(flowTabCss, ".flow-composer > .sends")).toMatchObject({
    flex: "0 1 auto",
    "min-height": "0",
    "overflow-y": "auto",
    margin: "-3px",
    padding: "3px",
  });
});

test("a_card_in_the_diagram_chat_keeps_its_content_height", () => {
  // Live check L1 (WebKitGTK): the follow-up card was laid out 2 px high in the chat. The chat is a scrolling flex
  // column, and a card's overflow: hidden drops its automatic minimum height to 0, so the card shrank to its borders
  // and clipped the question, the reply box and the buttons. Nothing in the chat may shrink; the chat scrolls.
  expect(ruleIn(flowTabCss, ".flow-chat")).toMatchObject({ display: "flex", "flex-direction": "column", "overflow-y": "auto" });
  expect(ruleIn(flowTabCss, ".flow-chat > *")).toMatchObject({ flex: "none" });
  expect(ruleIn(flowTabCss, ".ccard")).toMatchObject({ overflow: "hidden" });
  // No height cap on the follow-up card either: it is as tall as its content.
  const card = { ...ruleIn(flowTabCss, ".ccard"), ...ruleIn(flowTabCss, ".ccard.followup") };
  expect(card.height).toBeUndefined();
  expect(card["max-height"]).toBeUndefined();
});

test("visual_query_hints_drop_whole_in_a_narrow_pane", () => {
  expect(rule(".vq-hint-strip")).toMatchObject({ "flex-wrap": "wrap", height: "28px", overflow: "hidden" });
});
