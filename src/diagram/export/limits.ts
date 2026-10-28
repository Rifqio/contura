// Publish's size limits (B4 Decision 10): an image past them is refused with a note, never drawn as a giant raster
// (draw.io refuses an oversized PNG and points to SVG). Measured in B4 Task 7 (the 50-frame, 10,000-shape board saves a 3.7 MB SVG), kept, never raised.

/** The longest side a PNG may have, in px. */
export const PNG_MAX_SIDE = 16_384;
/** The most pixels a PNG may hold. */
export const PNG_MAX_PIXELS = 40_000_000;
/** The largest SVG, in UTF-8 bytes, its `<defs>` counted. */
export const SVG_MAX_BYTES = 24 * 1024 * 1024;
/** What `exportPng` throws past either PNG limit (A14). */
export const PNG_TOO_LARGE = "This drawing is too large for PNG. Save as SVG.";

/** Whether a `w` by `h` image at `scale` stays inside both PNG limits, on the canvas's whole pixels. */
export function pngFits(w: number, h: number, scale: number): boolean {
  const pw = Math.ceil(w * scale);
  const ph = Math.ceil(h * scale);
  return pw <= PNG_MAX_SIDE && ph <= PNG_MAX_SIDE && pw * ph <= PNG_MAX_PIXELS;
}

/** The largest PNG scale a `w` by `h` image fits at; 0 when even 1x does not, and PNG is off. */
export function pngMaxScale(w: number, h: number): 0 | 1 | 2 | 3 {
  for (const s of [3, 2, 1] as const) if (pngFits(w, h, s)) return s;
  return 0;
}
