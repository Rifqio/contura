import { expect, test } from "vitest";
import fontsCss from "./fonts.css?raw";
import appCss from "./app.css?raw";

const FILES = ["Regular", "SemiBold", "Bold", "Italic"].map((n) => `JetBrainsMono-${n}.woff2`);

test("four_faces_bundled_locally", () => {
  const faces = fontsCss.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  expect(faces).toHaveLength(4);
  for (const face of faces) {
    expect(face).toContain("font-display: swap");
    expect(face).toContain('font-family: "JetBrains Mono"');
  }
  const urls = [...fontsCss.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1].replace(/["']/g, ""));
  expect(urls).toHaveLength(4);
  for (const u of urls) expect(u.startsWith("../assets/fonts/")).toBe(true);
  expect(fontsCss).not.toContain("http");
  expect(urls.map((u) => u.split("/").pop()).sort()).toEqual([...FILES].sort());
});

test("font_files_are_small", () => {
  // ?inline gives a base64 data URL, so the byte size follows from the payload length.
  const files = import.meta.glob("../assets/fonts/*.woff2", { query: "?inline", import: "default", eager: true });
  const sizes = Object.entries(files).map(([path, url]) => {
    const b64 = (url as string).split(",")[1];
    const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    return { path, bytes: (b64.length * 3) / 4 - pad };
  });
  expect(sizes.map((s) => s.path.split("/").pop()).sort()).toEqual([...FILES].sort());
  const total = sizes.reduce((n, s) => n + s.bytes, 0);
  expect(total).toBeGreaterThan(100_000);
  expect(total).toBeLessThan(450_000);
});

test("every_code_rule_turns_ligatures_on", () => {
  const CODE = /font:\s*var\(--(font-mono|font-mono-small|font-mono-micro|font-code-editor|grid-cell-font)\)/;
  let checked = 0;
  for (const m of appCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2];
    const at = body.search(CODE);
    if (at < 0) continue;
    checked++;
    const after = body.slice(at);
    expect(after, m[1].trim()).toContain("font-variant-ligatures: contextual;");
    expect(after, m[1].trim()).toContain('font-feature-settings: "calt" 1, "liga" 1;');
  }
  expect(checked).toBeGreaterThan(10);
  expect(appCss).not.toContain("--font-code-editor-feature");
});
