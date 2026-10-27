// Board card previews (Decision 14): one SVG per frame, drawn through the real scene once per template and theme, kept
// only as the `data:` URL the Shelf draws. The cache holds one theme only; asking for the other theme drops every entry
// first, so it never grows past the boards.
import { exportPalette } from "../../../diagram/export/palette";
import { svgImageUrl } from "../../../diagram/export/png";
import { exampleSvg } from "../../previewScene";
import { templateById } from "./templates";

const EMPTY: readonly string[] = Object.freeze([]);

let cacheTheme: "light" | "dark" | null = null;
const urls = new Map<string, readonly string[]>();

/**
 * Each frame's preview of the board template `id` as one `data:` image URL, the same array while the theme stays.
 * The Shelf draws these as images: parsing and laying out the SVG markup in the page on every open cost about 400 ms
 * of a first open in WebKitGTK (m2), while one URL is decoded once and reused. The markup is not kept beside it.
 */
export function boardPreviewUrls(id: string, theme: "light" | "dark"): readonly string[] {
  if (theme !== cacheTheme) {
    urls.clear();
    cacheTheme = theme;
  }
  const hit = urls.get(id);
  if (hit) return hit;
  const t = templateById(id);
  if (!t || !("frames" in t)) return EMPTY;
  const palette = exportPalette(theme);
  const out = Object.freeze(t.frames.map((text) => svgImageUrl(exampleSvg(text, palette))));
  urls.set(id, out);
  return out;
}

/** How many boards are cached right now. */
export function previewCacheSize(): number {
  return urls.size;
}

/** How many strings the cache keeps, over every board: the memory tests' measure. */
export function previewStringsHeld(): number {
  let n = 0;
  for (const v of urls.values()) n += v.length;
  return n;
}
