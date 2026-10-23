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
