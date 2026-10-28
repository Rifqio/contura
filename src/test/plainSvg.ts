// The plain SVG rule every export is held to (B4 Decision 9, R19): shapes, words, images and one <defs>, nothing else.
import { expect } from "vitest";

const DEFS = /<defs>([^]*?)<\/defs>/g;

/**
 * Only plain shapes, text, images and `use`: no foreignObject, script, style, marker or clipPath. Run on the SVG with
 * its `<defs>` taken out (`defsOnlyHold` checks those); images only from data:image/, uses only to an id in the file,
 * each by href and xlink:href alike, with the xlink namespace declared once on the root.
 */
export function plainSvg(svg: string): void {
  const rest = svg.replace(DEFS, "");
  expect(rest).not.toMatch(/<(?!\/?(svg|g|rect|text|tspan|path|image|use|defs)\b)[a-z]/i);
  for (const m of rest.matchAll(/<image\b[^>]*\bhref="([^"]*)"/g)) expect(m[1]).toMatch(/^data:image\//);
  for (const m of rest.matchAll(/<use\b[^>]*>/g)) {
    // Both references (href for SVG 2 readers, xlink:href for SVG 1.1 ones) name the same id in the file.
    const href = /\shref="([^"]*)"/.exec(m[0])?.[1];
    expect(href).toMatch(/^#[\w-]+$/);
    expect(/\sxlink:href="([^"]*)"/.exec(m[0])?.[1]).toBe(href);
  }
  // xlink:href only on a <use>, and its namespace declared once, on the root, only when one is there.
  expect(rest.match(/xlink:href=/g)?.length ?? 0).toBe(rest.match(/<use\b/g)?.length ?? 0);
  const ns = svg.match(/\sxmlns:xlink="[^"]*"/g) ?? [];
  if (/<use\b/.test(rest) && /^\s*<svg\b/.test(svg)) {
    expect(ns).toEqual([' xmlns:xlink="http://www.w3.org/1999/xlink"']);
    expect(/^\s*<svg\b[^>]*>/.exec(svg)![0]).toContain("xmlns:xlink=");
  } else expect(ns.length).toBeLessThanOrEqual(1);
}

/** At most one `<defs>`, holding only a filter made of filter primitives and `<image id href="data:image/...">`. */
export function defsOnlyHold(svg: string): void {
  const all = [...svg.matchAll(DEFS)];
  expect(all.length).toBeLessThanOrEqual(1);
  expect(svg.match(/<defs\b/g)?.length ?? 0).toBe(all.length);
  const inner = all[0]?.[1] ?? "";
  expect(inner).not.toMatch(/<(?!\/?(filter|fe[A-Z][A-Za-z]*|image)\b)[a-z]/i);
  expect(inner).not.toMatch(/url\(/i);
  for (const m of inner.matchAll(/<image\b[^>]*>/g)) {
    expect(m[0]).toMatch(/\bid="[\w-]+"/);
    expect(m[0]).toMatch(/\bhref="data:image\/[^"]*"/);
  }
  expect(inner.match(/\bhref=/g)?.length ?? 0).toBe(inner.match(/<image\b/g)?.length ?? 0);
}
