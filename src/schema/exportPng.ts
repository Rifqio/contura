/** A data: URL, because the app's CSP allows `img-src 'self' data:` and not blob:. */
export const svgImageUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** Rasterises the exported SVG at `scale`x on an offscreen canvas. */
export async function exportPng(svg: string, scale = 2): Promise<Blob> {
  const img = new Image();
  img.src = svgImageUrl(svg);
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(img.width * scale);
  canvas.height = Math.ceil(img.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("this system cannot draw the image");
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("the image could not be encoded"))), "image/png"),
  );
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
