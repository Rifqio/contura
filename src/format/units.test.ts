import { expect, test } from "vitest";
import { agoShort, durationText } from "./units";

test("durationText_picks_the_compact_unit", () => {
  expect(durationText(38)).toBe("38ms");
  expect(durationText(1500)).toBe("1.5s");
  expect(durationText(38_000)).toBe("38s");
  expect(durationText(125_000)).toBe("2m 5s");
});

test("agoShort_is_now_minutes_or_hours", () => {
  const now = new Date(2026, 9, 17, 12, 0, 0);
  expect(agoShort(30_000, now)).toBe("now");
  expect(agoShort(12 * 60_000, now)).toBe("12m");
  expect(agoShort(2 * 3_600_000, now)).toBe("2h");
});

test("durationText_rounds_before_choosing_the_unit", () => {
  expect(durationText(999.6)).toBe("1.0s");
  expect(durationText(9960)).toBe("10s");
  expect(durationText(59_600)).toBe("1m");
});
