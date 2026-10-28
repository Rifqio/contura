// B4 Decision 10: the PNG limits and the largest scale that fits them.
import { expect, test } from "vitest";
import { PNG_MAX_PIXELS, PNG_MAX_SIDE, PNG_TOO_LARGE, pngMaxScale, SVG_MAX_BYTES } from "./limits";

test("png_max_scale", () => {
  expect(pngMaxScale(3000, 2000)).toBe(2);
  expect(pngMaxScale(4000, 3000)).toBe(1);
  expect(pngMaxScale(16_384, 10)).toBe(1);
  expect(pngMaxScale(16_385, 10)).toBe(0);
  expect(pngMaxScale(7000, 7000)).toBe(0);
  expect(pngMaxScale(100, 100)).toBe(3);
});

test("the_limits_are_the_planned_values", () => {
  expect([PNG_MAX_SIDE, PNG_MAX_PIXELS, SVG_MAX_BYTES]).toEqual([16_384, 40_000_000, 24 * 1024 * 1024]);
  expect(PNG_TOO_LARGE).toBe("This drawing is too large for PNG. Save as SVG.");
});
