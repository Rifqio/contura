// The PNG path lets go of its pixels once the file is encoded, so a large export does not stay in memory after
// the Publish dialog closes (ADR 0003's budget: closing frees what it held).
import { afterEach, expect, test, vi } from "vitest";
import { PNG_TOO_LARGE } from "./limits";
import { exportPng, svgPreviewUrl } from "./png";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("the_canvas_and_image_are_freed_after_the_png_is_encoded", async () => {
  const images: { src: string; width: number; height: number }[] = [];
  class FakeImage {
    src = "";
    width = 300;
    height = 200;
    constructor() {
      images.push(this);
    }
    decode() {
      return Promise.resolve();
    }
  }
  vi.stubGlobal("Image", FakeImage);
  const canvas = document.createElement("canvas");
  const draws: unknown[] = [];
  vi.spyOn(canvas, "getContext").mockReturnValue({ scale: () => {}, drawImage: (...a: unknown[]) => draws.push(a) } as unknown as RenderingContext);
  vi.spyOn(canvas, "toBlob").mockImplementation((cb) => cb(new Blob([new Uint8Array([1])], { type: "image/png" })));
  const create = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => (tag === "canvas" ? canvas : create(tag)));

  const blob = await exportPng("<svg/>", 2);
  expect(blob.size).toBe(1);
  expect(draws).toHaveLength(1);
  // Encoded: the canvas holds no pixels and the image no longer points at the SVG.
  expect([canvas.width, canvas.height]).toEqual([0, 0]);
  expect(images[0].src).toBe("");
});

test("the_canvas_is_freed_when_encoding_fails", async () => {
  class FakeImage {
    src = "";
    width = 10;
    height = 10;
    decode() {
      return Promise.resolve();
    }
  }
  vi.stubGlobal("Image", FakeImage);
  const canvas = document.createElement("canvas");
  vi.spyOn(canvas, "getContext").mockReturnValue({ scale: () => {}, drawImage: () => {} } as unknown as RenderingContext);
  vi.spyOn(canvas, "toBlob").mockImplementation((cb) => cb(null));
  const create = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => (tag === "canvas" ? canvas : create(tag)));
  await expect(exportPng("<svg/>", 1)).rejects.toThrow("the image could not be encoded");
  expect([canvas.width, canvas.height]).toEqual([0, 0]);
});

// ----- B4 Task 1 (R22, R23): the SVG loads as base64, and a raster past the limits is refused before any canvas.

/** A faked `Image` of `w` by `h` that remembers the URL it was decoded from. */
function fakeImage(w: number, h: number) {
  const loaded: string[] = [];
  class FakeImage {
    src = "";
    width = w;
    height = h;
    decode() {
      loaded.push(this.src);
      return Promise.resolve();
    }
  }
  vi.stubGlobal("Image", FakeImage);
  return loaded;
}
function fakeCanvas() {
  const canvas = document.createElement("canvas");
  const draws: unknown[] = [];
  const getContext = vi.spyOn(canvas, "getContext").mockReturnValue({ scale: () => {}, drawImage: (...a: unknown[]) => draws.push(a) } as unknown as RenderingContext);
  vi.spyOn(canvas, "toBlob").mockImplementation((cb) => cb(new Blob([new Uint8Array([1])], { type: "image/png" })));
  const create = document.createElement.bind(document);
  const made = vi.spyOn(document, "createElement").mockImplementation((tag: string) => (tag === "canvas" ? canvas : create(tag)));
  return { draws, getContext, made };
}
const decode64 = (url: string) => new TextDecoder().decode(Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0)));

test("the_preview_url_is_base64_and_decodes_to_the_svg", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><title>Café ü 漢字 🙂</title></svg>';
  const url = svgPreviewUrl(svg);
  expect(url.startsWith("data:image/svg+xml;base64,")).toBe(true);
  expect(decode64(url)).toBe(svg);
  // Long enough to cross the chunk size.
  const long = `<svg>${"é".repeat(70_000)}</svg>`;
  expect(decode64(svgPreviewUrl(long))).toBe(long);
});

test("export_png_loads_the_svg_as_base64", async () => {
  const loaded = fakeImage(300, 200);
  fakeCanvas();
  await exportPng("<svg><text>é</text></svg>", 1);
  expect(loaded).toHaveLength(1);
  expect(loaded[0].startsWith("data:image/svg+xml;base64,")).toBe(true);
  expect(decode64(loaded[0])).toBe("<svg><text>é</text></svg>");
});

test("export_png_refuses_past_the_limits", async () => {
  fakeImage(9000, 100);
  const { draws, getContext, made } = fakeCanvas();
  await expect(exportPng("<svg/>", 2)).rejects.toThrow(PNG_TOO_LARGE);
  expect(getContext).not.toHaveBeenCalled();
  expect(made.mock.calls.filter(([tag]) => tag === "canvas")).toHaveLength(0);
  // At 1x it fits and draws.
  await exportPng("<svg/>", 1);
  expect(draws).toHaveLength(1);
  // Too many pixels with both sides in the limit.
  fakeImage(7000, 7000);
  await expect(exportPng("<svg/>", 1)).rejects.toThrow(PNG_TOO_LARGE);
  expect(draws).toHaveLength(1);
});
