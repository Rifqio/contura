// Task 11 (decision 19, D4): the Space box opens 12 px right and below the pointer, flipped to stay inside the canvas.
import { expect, test } from "vitest";
import { placeBox } from "./SpaceBox";

const size = { w: 320, h: 240 };
const canvas = { w: 1000, h: 700 };

test("the_box_opens_below_right_of_the_pointer", () => {
  expect(placeBox({ x: 200, y: 150 }, size, canvas)).toEqual({ x: 212, y: 162 });
});

test("it_flips_left_at_the_right_edge", () => {
  // 900 + 12 + 320 passes 1000: the box's right edge sits 12 px left of the pointer.
  expect(placeBox({ x: 900, y: 150 }, size, canvas)).toEqual({ x: 900 - 12 - 320, y: 162 });
});

test("it_flips_up_at_the_bottom_edge", () => {
  expect(placeBox({ x: 200, y: 600 }, size, canvas)).toEqual({ x: 212, y: 600 - 12 - 240 });
  // Both edges at once: up and to the left.
  expect(placeBox({ x: 950, y: 650 }, size, canvas)).toEqual({ x: 950 - 12 - 320, y: 650 - 12 - 240 });
});

test("it_stays_inside_a_canvas_smaller_than_itself", () => {
  expect(placeBox({ x: 100, y: 80 }, size, { w: 200, h: 150 })).toEqual({ x: 0, y: 0 });
  // A flip that would leave the canvas is held at its edge instead.
  expect(placeBox({ x: 300, y: 100 }, size, { w: 400, h: 400 })).toEqual({ x: 0, y: 112 });
});
