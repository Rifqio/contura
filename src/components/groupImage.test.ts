import { afterEach, expect, test, vi } from "vitest";
import { IMAGE_MAX, checkImageFile, cropBox, squarePng } from "./groupImage";

afterEach(() => vi.restoreAllMocks());

test("refuses_files_over_1_mb", () => {
  expect(IMAGE_MAX).toBe(1_048_576);
  expect(checkImageFile({ type: "image/png", size: 1_048_577 })).toBe("Choose an image up to 1 MB.");
  expect(checkImageFile({ type: "image/png", size: 1_048_576 })).toBeNull();
});

test("refuses_other_types", () => {
  expect(checkImageFile({ type: "text/plain", size: 10 })).toBe("Choose a PNG, JPG, WebP or SVG image.");
  for (const type of ["image/png", "image/jpeg", "image/webp", "image/svg+xml"]) {
    expect(checkImageFile({ type, size: 10 })).toBeNull();
  }
});

test("crop_box_centres_the_square", () => {
  expect(cropBox(4000, 3000)).toEqual({ sx: 500, sy: 0, s: 3000 });
  expect(cropBox(300, 500)).toEqual({ sx: 0, sy: 100, s: 300 });
  expect(cropBox(64, 64)).toEqual({ sx: 0, sy: 0, s: 64 });
});

test("a_wide_photo_is_drawn_centre_cropped_into_a_64_px_square", async () => {
  const bitmap = { width: 4000, height: 3000, close: vi.fn() };
  vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
  const drawImage = vi.fn();
  const canvases: HTMLCanvasElement[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    canvases.push(this);
    return { drawImage, imageSmoothingQuality: "low" } as unknown as CanvasRenderingContext2D;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((done) =>
    done(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" })),
  );
  const bytes = await squarePng(new Blob(["x"], { type: "image/jpeg" }));
  expect(drawImage).toHaveBeenCalledWith(bitmap, 500, 0, 3000, 3000, 0, 0, 64, 64);
  expect(canvases[0].width).toBe(64);
  expect(canvases[0].height).toBe(64);
  expect(Array.from(bytes)).toEqual([137, 80, 78, 71]);
});
