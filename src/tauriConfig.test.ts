import { expect, test } from "vitest";
import confRaw from "../src-tauri/tauri.conf.json?raw";
import libRs from "../src-tauri/src/lib.rs?raw";
import windowSizeRs from "../src-tauri/src/window_size.rs?raw";
import capabilityRaw from "../src-tauri/capabilities/default.json?raw";
import appCss from "./styles/app.css?raw";
import tokensCss from "./styles/tokens.css?raw";

const conf = JSON.parse(confRaw);
const security = conf.app.security;

const directive = (csp: string, name: string) =>
  csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `)) ?? "";

test("codemirror_can_insert_its_style_tags_in_the_release_build", () => {
  // CodeMirror styles the editor through <style> tags it inserts at runtime, which needs
  // 'unsafe-inline'. A nonce in style-src turns 'unsafe-inline' off, so Tauri must not add one.
  expect(directive(security.csp, "style-src")).toContain("'unsafe-inline'");
  expect(security.dangerousDisableAssetCspModification).toEqual(["style-src"]);
});

test("the_main_window_has_a_minimum_size", () => {
  // Under 1024 px wide the Connection form scrolls sideways. 480 px high lets the window fit a screen with only
  // 522 px of room. lib.rs builds the window from this entry (create: false), after it sets up the data folder.
  const main = conf.app.windows.find((w: { label: string }) => w.label === "main");
  expect(main).toMatchObject({ create: false, minWidth: 1024, minHeight: 480 });
  expect(main.width).toBeGreaterThanOrEqual(main.minWidth);
  expect(main.height).toBeGreaterThanOrEqual(main.minHeight);
  expect(libRs).toMatch(/WebviewWindowBuilder::from_config\(\s*app,/);
});

test("the_saved_interface_size_zooms_the_window_at_start_and_the_page_may_change_it", () => {
  // The Core zooms the window it just built, before the page paints; usePrefs follows later changes.
  const built = libRs.indexOf("let window = builder.build()?;");
  expect(built).toBeGreaterThan(0);
  // Read before the build, as the minimum needs it too.
  expect(libRs.indexOf("interface_size.zoom()")).toBeGreaterThan(0);
  expect(libRs.indexOf("window.set_zoom(zoom)", built)).toBeGreaterThan(built);
  // The minimum (1024 x 480 CSS px times Windows Text size and the interface size, window_size::min_size, unit-
  // tested in Rust) is set on the builder, not on the hidden window after it.
  expect(libRs.indexOf(".min_inner_size(")).toBeGreaterThan(0);
  expect(libRs.indexOf(".min_inner_size(")).toBeLessThan(built);
  // Later sizes go through the Core, which zooms, raises the minimum and grows the window to it; it refits on a
  // move to another monitor, a resize (a restore from maximized lands the pending minimum) and on focus (Windows
  // Text size changed meanwhile). Not inside ScaleFactorChanged: tao applies its own new size right after it, so
  // the Moved or Resized that follows refits instead.
  expect(libRs).toMatch(/window_size::set_interface_size,/);
  expect(libRs).toMatch(/\.on_window_event\(/);
  for (const event of ["Moved", "Resized", "Focused(true)"]) expect(libRs).toContain(`WindowEvent::${event}`);
  expect(libRs).not.toContain("WindowEvent::ScaleFactorChanged");
  // A maximized window still zooms; only its minimum waits for the restore.
  const command = windowSizeRs.slice(windowSizeRs.indexOf("pub fn set_interface_size("));
  const body = command.slice(0, command.indexOf("\n}\n"));
  expect(body).toMatch(/\n {4}refit\(.*\);\n {4}let _ = window\.set_zoom\(zoom\);/);
  // The page no longer zooms the webview itself.
  expect(JSON.parse(capabilityRaw).permissions).not.toContain("core:webview:allow-set-webview-zoom");
});

test("item_11_24_html_drag_and_drop_reaches_the_page", () => {
  // With Tauri's own drag and drop handler on, WebView2 on Windows never fires the page's dragover and
  // drop: Connections could not be dragged into Groups on Home, nor tables from the tree to a canvas.
  const main = conf.app.windows.find((w: { label: string }) => w.label === "main");
  expect(main.dragDropEnabled).toBe(false);
});

/** A `--name: Npx` token from tokens.css. */
const token = (name: string): number => {
  const m = tokensCss.match(new RegExp(`--${name}:\\s*(\\d+)px`));
  if (!m) throw new Error(`no --${name}`);
  return Number(m[1]);
};

/** The body of the app.css rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const text = appCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const at = text.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`no ${selector}`);
  const open = text.indexOf("{", at);
  return text.slice(open + 1, text.indexOf("}", open));
}

const px = (body: string, prop: string): number => Number(body.match(new RegExp(`(?:^|\\n)\\s*${prop}:\\s*(\\d+)px`))?.[1] ?? NaN);

test("the_main_layout_fits_the_minimum_window_height", () => {
  const main = conf.app.windows.find((w: { label: string }) => w.label === "main");
  // The shell: title bar, feature bar, the body (which may shrink to nothing), status bar.
  expect(ruleBody(".app")).toMatch(/grid-template-rows:\s*var\(--title-bar-height\) auto minmax\(0, 1fr\) var\(--status-bar-height\)/);
  const bar = ruleBody(".feature-bar");
  const featureBar = px(bar, "height");
  expect(featureBar).toBe(64);
  const barMargin = Number(bar.match(/margin:\s*0 6px (\d+)px/)?.[1] ?? NaN);
  // The status bar draws at the taller of its row and its own height.
  const status = Math.max(token("status-bar-height"), token("grid-footer-height"));
  const chrome = token("title-bar-height") + featureBar + barMargin + status;
  expect(chrome).toBeLessThan(200);
  // A query tab: its 32 px strip, then the editor and the results split by percent (each at least 20%).
  const editorStrip = token("strip-height");
  const left = main.minHeight - chrome - editorStrip;
  // Room for a few editor lines and a few result rows at the 20/80 split's narrow end.
  expect(left).toBeGreaterThanOrEqual(5 * 28 * 2);
});

/** The body row of the shell at the minimum window height: what a tab gets. */
function bodyAtMinimum(): number {
  const main = conf.app.windows.find((w: { label: string }) => w.label === "main");
  const bar = ruleBody(".feature-bar");
  const barMargin = Number(bar.match(/margin:\s*0 6px (\d+)px/)?.[1] ?? NaN);
  const status = Math.max(token("status-bar-height"), token("grid-footer-height"));
  return main.minHeight - token("title-bar-height") - px(bar, "height") - barMargin - status;
}

/** A part that gives way in a short window: it shrinks (`flex: 0 1 ...`) and keeps a min-height; returns that. */
function shrinks(selector: string): number {
  const body = ruleBody(selector);
  expect(body, selector).toMatch(/flex:\s*0 1 /);
  expect(body, selector).not.toMatch(/(?:^|\n)\s*height:/);
  return px(body, "min-height");
}

test("the_visual_query_tab_fits_the_minimum_window_height", () => {
  // Toolbar, an optional one-line banner, the canvas, then the panel and SQL pane below.
  const toolbar = px(ruleBody(".vq-toolbar"), "height");
  const banner = 6 * 2 + 20;
  const canvas = px(ruleBody(".vq-canvas"), "min-height");
  expect(canvas).toBeGreaterThanOrEqual(100);
  // Item 36: the panel's height is the user's (inline), and it gives way down to its tab strip and rule.
  const bottom = shrinks(".vq-bottom");
  expect(bottom).toBe(px(ruleBody(".vq-panel-tabs"), "height") + 1);
  // Item 40: the hint has its own strip under the canvas.
  const hint = px(ruleBody(".vq-hint-strip"), "height");
  expect(toolbar + banner + canvas + hint + bottom).toBeLessThanOrEqual(bodyAtMinimum());
});

test("the_table_designer_fits_the_minimum_window_height", () => {
  // Header bar, the Read-only sentence (one small line), the tabs toolbar, the rows, then the SQL island.
  const header = px(ruleBody(".table-header"), "height");
  const readOnly = 4 * 2 + 20;
  const toolbar = px(ruleBody(".design-toolbar"), "height");
  const rows = px(ruleBody(".design-body"), "min-height");
  expect(rows).toBeGreaterThanOrEqual(4 * 28);
  const island = shrinks(".design-island");
  expect(island).toBeGreaterThanOrEqual(px(ruleBody(".design-island-head"), "height") + 3 * 20);
  // The DDL island only changes its basis, never its height.
  expect(ruleBody(".design-ddl")).not.toMatch(/(?:^|\n)\s*height:/);
  expect(header + readOnly + toolbar + rows + island).toBeLessThanOrEqual(bodyAtMinimum());
});
