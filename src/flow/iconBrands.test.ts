import { expect, test } from "vitest";
import { BRANDS, OLD_BRANDS } from "../../scripts/icon-brands.mjs";

test("the_brand_list_grows_and_keeps_every_old_logo", () => {
  expect(new Set(BRANDS).size).toBe(BRANDS.length);
  for (const slug of BRANDS) expect(slug).toMatch(/^[a-z0-9]+$/);
  expect(BRANDS.length).toBeGreaterThanOrEqual(600);
  expect(OLD_BRANDS.length).toBe(219);
  const all = new Set(BRANDS);
  for (const slug of OLD_BRANDS) expect(all.has(slug), slug).toBe(true);
});
