import { afterEach, expect, test } from "vitest";
import indexHtml from "../../index.html?raw";
import bootScript from "../../public/theme-boot.js?raw";
import libRs from "../../src-tauri/src/lib.rs?raw";
import tokensCss from "./tokens.css?raw";
import { THEME_MIRROR_KEY } from "../theme/theme";

/** --c-bg-app in the block that starts with `selector`. */
function bgApp(selector: string): string {
  const at = tokensCss.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no block ${selector}`);
  const body = tokensCss.slice(at, tokensCss.indexOf("}", at));
  const m = /--c-bg-app:\s*(#[0-9a-f]{6})/i.exec(body);
  if (!m) throw new Error(`no --c-bg-app in ${selector}`);
  return m[1].toLowerCase();
}

const alucard = bgApp(":root, .theme-light");
const dracula = bgApp(':root[data-theme="dark"], .theme-dark');

const rgb = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
};

test("index_html_has_no_inline_style_or_script", () => {
  // At release build Tauri adds a nonce to style-src for any inline <style>, and the
  // browser then ignores 'unsafe-inline', which blocks the <style> tags CodeMirror inserts.
  expect(indexHtml).not.toMatch(/<style[\s>]/i);
  expect(indexHtml).not.toMatch(/\sstyle\s*=/i);
  for (const tag of indexHtml.match(/<script[^>]*>[\s\S]*?<\/script>/gi) ?? []) {
    expect(tag).toMatch(/<script[^>]*\ssrc=/i);
    expect(tag.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "").trim()).toBe("");
  }
  // The boot script runs from the head, before the body and the module script.
  const head = indexHtml.slice(0, indexHtml.indexOf("</head>"));
  expect(head).toContain('<script src="/theme-boot.js"></script>');
  expect(dracula).toBe("#191a21");
});

const realMatchMedia = window.matchMedia;

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.backgroundColor = "";
  window.matchMedia = realMatchMedia;
  localStorage.clear();
});

const runBoot = () => new Function(bootScript)();

test("the_boot_script_reads_the_theme_mirror", () => {
  expect(bootScript).toContain(JSON.stringify(THEME_MIRROR_KEY));
  runBoot();
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  localStorage.setItem(THEME_MIRROR_KEY, "light");
  runBoot();
  expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  localStorage.setItem(THEME_MIRROR_KEY, "system");
  runBoot();
  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  localStorage.setItem(THEME_MIRROR_KEY, "nonsense");
  runBoot();
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
});

const prefersDark = (dark: boolean) => {
  window.matchMedia = ((q: string) => ({
    matches: dark && q.includes("prefers-color-scheme: dark"),
    media: q,
  })) as unknown as typeof window.matchMedia;
};

test.each([
  ["nothing stored", null, false, dracula],
  ["dark", "dark", false, dracula],
  ["light", "light", true, alucard],
  ["system on a dark OS", "system", true, dracula],
  ["system on a light OS", "system", false, alucard],
  ["an unknown value", "nonsense", false, dracula],
])("the_boot_script_paints_the_app_background_for_%s", (_label, stored, osDark, bg) => {
  prefersDark(osDark);
  if (stored !== null) localStorage.setItem(THEME_MIRROR_KEY, stored);
  runBoot();
  expect(document.documentElement.style.backgroundColor).toBe(rgb(bg));
});

test("the_native_window_background_is_dracula", () => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(dracula.slice(i, i + 2), 16));
  expect(libRs).toContain(`.background_color(Color(${r}, ${g}, ${b}, 255))`);
});
