import { expect, test } from "vitest";
import { FRAME_GAP } from "../boardLayout";
import { centredAt, placeFrames } from "./place";

test("frames_sit_in_a_row_centred_on_the_point", () => {
  expect(placeFrames([{ w: 400, h: 300 }, { w: 200, h: 100 }], { x: 0, y: 0 })).toEqual([{ x: -340, y: -150 }, { x: 140, y: -150 }]);
});
test("one_frame_is_centred", () => { expect(placeFrames([{ w: 320, h: 200 }], { x: 100, y: 100 })).toEqual([{ x: -60, y: 0 }]); });
test("the_gap_is_frame_gap", () => { expect(placeFrames([{ w: 10, h: 10 }, { w: 10, h: 10 }], { x: 0, y: 0 })[1].x).toBe(-50 + 10 + FRAME_GAP); });
test("centred_at_gives_whole_numbers", () => {
  expect(centredAt({ x: 10, y: 10 }, { w: 120, h: 80 })).toEqual({ x: -50, y: -30 });
  const p = centredAt({ x: 0.3, y: 0.7 }, { w: 33, h: 21 });
  expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
});
