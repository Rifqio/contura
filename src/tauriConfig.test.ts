import { expect, test } from "vitest";
import confRaw from "../src-tauri/tauri.conf.json?raw";
import libRs from "../src-tauri/src/lib.rs?raw";

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
  // Under 1024 x 640 the Connection form scrolls sideways. lib.rs builds the window
  // from this entry (create: false), after it sets up the data folder.
  const main = conf.app.windows.find((w: { label: string }) => w.label === "main");
  expect(main).toMatchObject({ create: false, minWidth: 1024, minHeight: 640 });
  expect(main.width).toBeGreaterThanOrEqual(main.minWidth);
  expect(main.height).toBeGreaterThanOrEqual(main.minHeight);
  expect(libRs).toMatch(/WebviewWindowBuilder::from_config\(\s*app,/);
});

test("item_11_24_html_drag_and_drop_reaches_the_page", () => {
  // With Tauri's own drag and drop handler on, WebView2 on Windows never fires the page's dragover and
  // drop: Connections could not be dragged into Groups on Home, nor tables from the tree to a canvas.
  const main = conf.app.windows.find((w: { label: string }) => w.label === "main");
  expect(main.dragDropEnabled).toBe(false);
});
