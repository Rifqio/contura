// The Ask panel fits its width (user report, Windows release: the bubbles, the Sends block, the Context bar and the
// composer's foot ran past the panel's right edge). jsdom does no layout, so this holds the CSS that makes it fit:
// every track as wide as the panel at most, rows that shrink, text that wraps or ends in an ellipsis. A real browser
// check at 360, 260, 200 and 160 px is in the mem-peaks report.
import { expect, test } from "vitest";
import appCss from "../styles/app.css?raw";

const css = appCss.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of every rule whose selector list holds exactly `selector`, merged in order. */
function rule(selector: string): Record<string, string> {
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

test("every_grid_in_the_panel_has_one_column_no_wider_than_the_panel", () => {
  // An auto column grows to its widest row's content; minmax(0, 1fr) holds it to the panel.
  for (const sel of [".ai-panel", ".thread", ".msg-ai", ".comp-box", ".sends"]) {
    expect(rule(sel)["grid-template-columns"], sel).toBe("minmax(0, 1fr)");
  }
  // The composer is a column of full-width rows (see the short-window test in styles/layoutFit.test.ts).
  expect(rule(".composer")).toMatchObject({ display: "flex", "flex-direction": "column", "min-width": "0" });
  expect(rule(".thread")["overflow-x"]).toBe("hidden");
});

test("bubbles_wrap_long_words", () => {
  expect(rule(".msg-user")).toMatchObject({ "max-width": "88%", "overflow-wrap": "anywhere" });
  expect(rule(".msg-ai")).toMatchObject({ "min-width": "0", "overflow-wrap": "anywhere" });
});

test("one_line_rows_shrink_and_end_in_an_ellipsis", () => {
  for (const sel of [".ai-panel-head .chip", ".comp-sub", ".send-pill-label"]) {
    expect(rule(sel), sel).toMatchObject({ "min-width": "0", overflow: "hidden", "text-overflow": "ellipsis" });
  }
  // The model pill gives way before Enter and Send; the Sends row and the marks under an answer wrap.
  expect(rule(".mpick")["min-width"]).toBe("0");
  expect(rule(".send-pill")).toMatchObject({ "min-width": "0", "max-width": "100%" });
  expect(rule(".sends-row")["flex-wrap"]).toBe("wrap");
  expect(rule(".msg-mark")["flex-wrap"]).toBe("wrap");
  expect(rule(".meter-bar").flex).toBe("1");
});

test("no_panel_row_has_a_fixed_width_wider_than_the_narrowest_panel", () => {
  const panel = /(^|[\s.])(ai-panel|thread|msg-|composer|comp-|sends|send-pill|meter-|mpick|mpill|ts\b)/;
  const wide: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!panel.test(m[1])) continue;
    for (const d of m[2].matchAll(/(?:^|;)\s*(width|min-width)\s*:\s*(\d+)px/g)) if (Number(d[2]) > 160) wide.push(`${m[1].trim()} ${d[1]}: ${d[2]}px`);
  }
  expect(wide).toEqual([]);
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

test("nothing_in_the_ask_panel_is_wider_than_the_panel", () => {
  // Owner report (Windows): paragraph text, Show exactly and the Enter hint were cut at the panel's right edge. In a
  // real browser every row inside the panel fits it; what ran past the edge was the Ask column itself: with History
  // open the four side minimums need 1,010 px, so on a narrower window the grid ran past the window's right edge.
  // The Ask column follows the width set by its sash (--ask-width), 360 px until then.
  expect(rule(".body-ai")["grid-template-columns"]).toBe("264px minmax(0, 1fr) var(--ask-width, 360px)");
  expect(rule(".body-home.body-ai")["grid-template-columns"]).toBe("minmax(0, 1fr) var(--ask-width, 360px)");
  expect(rule(".body-history.body-ai")["grid-template-columns"]).toBe(
    "minmax(180px, 264px) minmax(320px, 1fr) minmax(220px, 360px) var(--ask-width, 360px)",
  );
  // Below 1,010 px each minimum gives way in proportion: at any window the four columns, three gaps and the padding fit.
  const narrow = /@media \(max-width: 1009px\)\s*\{\s*\.body\.body-history\.body-ai\s*\{\s*grid-template-columns:\s*([^;]+);\s*\}\s*\}/.exec(css);
  expect(narrow).not.toBeNull();
  const tracks = tracksOf(narrow![1]);
  expect(tracks).toHaveLength(4);
  const least = (track: string, box: number) => {
    const m = /^minmax\(min\((\d+)px, (\d+)%\),/.exec(track);
    expect(m, track).not.toBeNull();
    return Math.min(Number(m![1]), (Number(m![2]) / 100) * box);
  };
  for (const win of [1009, 900, 800, 640]) {
    const box = win - 2 * 6;
    expect(tracks.reduce((sum, t) => sum + least(t, box), 0) + 3 * 6, `${win} px`).toBeLessThanOrEqual(box);
  }
  // The sash is placed out of the flow on the panel's left edge: it adds no width.
  expect(rule(".ai-panel").position).toBe("relative");
  expect(rule(".ask-sash")).toMatchObject({ position: "absolute", width: "6px", cursor: "col-resize" });
  // Long words and code inside the panel wrap or scroll in their own box.
  expect(rule(".msg-ai")["overflow-wrap"]).toBe("anywhere");
  expect(rule(".answer-code")["overflow-x"]).toBe("auto");
  expect(rule(".payload").overflow).toBe("auto");
});

test("the_ask_panel_never_scrolls_sideways", () => {
  // Owner report (Windows, dark): the panel's content was cut on both sides ("k Schema only", "ELECT * FROM", "Show
  // ex..."): a box on the chain had been scrolled sideways. The panel clips in x, so it cannot be scrolled at all; the
  // thread scrolls in y, where clip would compute to hidden, so it keeps hidden and its scroll handler puts
  // scrollLeft back to 0 (AssistantPanel.test.tsx).
  expect(rule(".ai-panel")).toMatchObject({ "overflow-x": "clip", "min-width": "0", "overflow-wrap": "anywhere" });
  expect(rule(".thread")).toMatchObject({ "overflow-x": "hidden", "min-width": "0" });
  // Every flex and grid child from the panel down to the messages, the code, the Sends rows and the composer can
  // shrink to the column, at 300 px as at 360 px: none has a minimum wider than its content box.
  for (const sel of [
    ".ai-panel-head",
    ".thread",
    ".msg-user",
    ".msg-ai",
    ".msg-mark",
    ".answer-sql",
    ".answer-sql-head",
    ".answer-sql-actions",
    ".answer-code",
    ".composer",
    ".sends",
    ".sends-row",
    ".sends-list",
    ".sends-item",
    ".comp-box",
    ".comp-foot",
  ]) {
    expect(rule(sel)["min-width"], sel).toBe("0");
  }
  expect(rule(".sends-list")["grid-template-columns"]).toBe("minmax(0, 1fr)");
  // Code scrolls inside its own box; it never widens the message.
  expect(rule(".answer-sql .sql-block")["overflow-x"]).toBe("auto");
  expect(rule(".answer-code")["overflow-x"]).toBe("auto");
  expect(rule(".payload").overflow).toBe("auto");
  // The sash sits inside the panel's left edge, so the clip does not cut it off.
  expect(rule(".ask-sash")).toMatchObject({ position: "absolute", left: "0", width: "6px" });
});
