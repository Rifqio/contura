// A PNG written in steps (Task 9 fix 3): a picture's bitmap leaves the page as one <img> of a PNG, not a <canvas>.
// @vitest-environment node
import { expect, test } from "vitest";
import { base64Steps, crc32, createDeflate, PNG_IDAT_PIECE, pngFileSteps, scanlines } from "./pngSteps";

/** Node's zlib, untyped here (the project has no Node types), as `packIcons.test.ts` reads it. */
const { inflateSync } = (
  globalThis as unknown as { process: { getBuiltinModule(id: "node:zlib"): { inflateSync(bytes: Uint8Array): Uint8Array } } }
).process.getBuiltinModule("node:zlib");

const drain = <T>(g: Generator<void, T>): { value: T; steps: number } => {
  let steps = 0;
  for (;;) {
    const r = g.next();
    if (r.done) return { value: r.value, steps };
    steps++;
  }
};

/** The PNG's chunks: type, data, and whether its CRC is right. */
function chunks(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: { type: string; data: Uint8Array; crcOk: boolean }[] = [];
  for (let at = 8; at < png.length; ) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + len);
    const crc = view.getUint32(at + 8 + len);
    out.push({ type, data, crcOk: crc === crc32([png.subarray(at + 4, at + 8 + len)]) });
    at += 12 + len;
  }
  return out;
}

test("crc32_is_the_png_one", () => {
  // The IEND chunk's CRC every PNG ends with, and "123456789"'s check value.
  expect(crc32([new TextEncoder().encode("IEND")])).toBe(0xae426082);
  expect(crc32([new TextEncoder().encode("1234"), new TextEncoder().encode("56789")])).toBe(0xcbf43926);
});

test("rows_of_pixels_become_scanlines_with_no_filter", () => {
  const px = Uint8ClampedArray.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  expect([...scanlines(px, 2, 2)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 9, 10, 11, 12, 13, 14, 15, 16]);
});

test("a_png_written_in_steps_holds_the_pixels_it_was_given", async () => {
  // 3 by 2 RGBA, two bands, deflated by the platform's own stream.
  const w = 3;
  const rows = [
    Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0]),
    Uint8ClampedArray.from([9, 9, 9, 9, 10, 10, 10, 10, 11, 11, 11, 11]),
  ];
  const deflate = createDeflate();
  for (const r of rows) deflate.write(scanlines(r, w, 1));
  const z = await deflate.done();
  const { value: png } = drain(pngFileSteps(w, 2, z));
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const cs = chunks(png);
  expect(cs.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
  expect(cs.every((c) => c.crcOk)).toBe(true);
  // IHDR: 3 by 2, 8 bits, RGBA, deflate, no filter method, no interlace.
  expect([...cs[0].data]).toEqual([0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
  expect([...inflateSync(cs[1].data)]).toEqual([0, ...rows[0], 0, ...rows[1]]);
});

test("a_big_png_is_written_an_idat_piece_a_step", () => {
  const z = new Uint8Array(PNG_IDAT_PIECE * 2 + 5).map((_, i) => i & 0xff);
  const { value: png, steps } = drain(pngFileSteps(10, 10, z));
  const cs = chunks(png);
  expect(cs.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IDAT", "IDAT", "IEND"]);
  expect(cs.every((c) => c.crcOk)).toBe(true);
  expect(steps).toBe(2);
});

test("base64_in_steps_is_btoa_of_the_whole", () => {
  const bytes = new Uint8Array(3 * 70_000 + 2).map((_, i) => (i * 7) & 0xff);
  const { value, steps } = drain(base64Steps("data:image/png;base64,", bytes));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  expect(value).toBe(`data:image/png;base64,${btoa(binary)}`);
  expect(steps).toBeGreaterThan(0);
});
