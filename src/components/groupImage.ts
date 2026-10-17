/** The largest picture file a Group image may be read from (D19). */
export const IMAGE_MAX = 1_048_576;

const TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];

/** Why a chosen file cannot be a Group image, or null when it can. */
export function checkImageFile(f: { type: string; size: number }): string | null {
  if (!TYPES.includes(f.type)) return "Choose a PNG, JPG, WebP or SVG image.";
  if (f.size > IMAGE_MAX) return "Choose an image up to 1 MB.";
  return null;
}

/** The centred square inside a `w` by `h` picture: its top left corner and side. */
export function cropBox(w: number, h: number): { sx: number; sy: number; s: number } {
  const s = Math.min(w, h);
  return { sx: Math.floor((w - s) / 2), sy: Math.floor((h - s) / 2), s };
}

async function decode(file: Blob): Promise<{ source: CanvasImageSource; w: number; h: number; release(): void }> {
  if (file.type === "image/svg+xml") {
    // createImageBitmap cannot decode SVG, so an <img> does it.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { source: img, w: img.naturalWidth || 64, h: img.naturalHeight || 64, release: () => URL.revokeObjectURL(url) };
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  }
  const bitmap = await createImageBitmap(file);
  return { source: bitmap, w: bitmap.width, h: bitmap.height, release: () => bitmap.close?.() };
}

/** Centre-crops a picture to a square and draws it `size` px wide as PNG bytes. Rejects when it cannot be decoded. */
export async function squarePng(file: Blob, size = 64): Promise<Uint8Array> {
  const { source, w, h, release } = await decode(file);
  try {
    const { sx, sy, s } = cropBox(w, h);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, sx, sy, s, s, 0, 0, size, size);
    const png = await new Promise<Blob>((done, fail) =>
      canvas.toBlob((b) => (b ? done(b) : fail(new Error("no png"))), "image/png"),
    );
    return new Uint8Array(await png.arrayBuffer());
  } finally {
    release();
  }
}

/** Base64 of bytes, in chunks so a large array cannot overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

export const pngDataUrl = (base64: string) => `data:image/png;base64,${base64}`;
