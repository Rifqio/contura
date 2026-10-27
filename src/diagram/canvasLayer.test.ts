// The canvas paints in its own compositing layer (blowup-report.md). React Flow draws each line in its own
// `<svg style="z-index">` at the flow origin with overflow visible, so the line's layer spans from the origin to the
// line. A board puts its frames thousands of pixels from the origin, and after the fit the origin lies over the code
// pane, whose scroller WebKitGTK composites. Every line then overlapped a composited layer under it and got a layer
// of its own, sized to its unscaled span: a 10-frame board (3,000 lines) grew the WebKitWebProcess past 3 GB and
// never painted. A canvas that is its own layer keeps that overlap test inside the canvas, where nothing composited
// lies under the lines. jsdom has no compositor, so this guards the rule; the WebKit check is in the report.
import { expect, test } from "vitest";
import appCss from "../styles/app.css?raw";

/** The declarations of each rule whose selector list is exactly `selector`. */
function rulesFor(css: string, selector: string): string[] {
  const out: string[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].trim() === selector) out.push(m[2]);
  }
  return out;
}

test("the_canvas_is_its_own_compositing_layer", () => {
  const body = rulesFor(appCss, ".diagram-canvas .react-flow").join(";");
  // `opacity`, not `transform`: a transform would make the canvas the containing block of its fixed menus.
  expect(body).toMatch(/(^|;)\s*will-change:\s*opacity\s*(;|$)/);
});
