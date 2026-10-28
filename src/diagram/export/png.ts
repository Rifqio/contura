import { PNG_TOO_LARGE, pngFits } from "./limits";

/** A data: URL, because the app's CSP allows `img-src 'self' data:` and not blob:. */
export const svgImageUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/**
 * The SVG as a base64 data: URL (UTF-8 through `TextEncoder`, chunked `btoa`): about a third larger than the SVG,
 * where `encodeURIComponent` can triple it (B4 Decision 12).
 */
export function svgPreviewUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/**
 * Rasterises an exported SVG at `scale`x on an offscreen canvas. Past `PNG_MAX_SIDE` or `PNG_MAX_PIXELS` it throws
 * `PNG_TOO_LARGE` once the image is decoded and before any canvas exists (R22).
 */
export async function exportPng(svg: string, scale: 1 | 2 | 3 = 2): Promise<Blob> {
  const img = new Image();
  let canvas: HTMLCanvasElement | null = null;
  try {
    img.src = svgPreviewUrl(svg);
    await img.decode();
    if (!pngFits(img.width, img.height, scale)) throw new Error(PNG_TOO_LARGE);
    canvas = document.createElement("canvas");
    canvas.width = Math.ceil(img.width * scale);
    canvas.height = Math.ceil(img.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("this system cannot draw the image");
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    const c = canvas;
    return await new Promise<Blob>((resolve, reject) =>
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("the image could not be encoded"))), "image/png"),
    );
  } finally {
    // Let go of the pixels and the SVG at once, not when the collector gets to them: a 3x export of a large
    // diagram is tens of MB (ADR 0003).
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    img.src = "";
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
