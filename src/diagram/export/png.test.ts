// The PNG path lets go of its pixels once the file is encoded, so a large export does not stay in memory after
// the Publish dialog closes (ADR 0003's budget; spec 6+: closing frees what it held).
import { afterEach, expect, test, vi } from "vitest";
import { exportPng } from "./png";

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
