import { expect, test } from "vitest";
import { MAX_ZOOM, MIN_ZOOM, wheelDy, wheelZoom } from "./canvasView";

test("zoom_limits_are_exported", () => {
  expect(MIN_ZOOM).toBe(0.1);
  expect(MAX_ZOOM).toBe(4);
});

test("a_notch_zooms_by_a_small_step", () => {
  expect(wheelZoom({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, 100).zoom).toBeCloseTo(0.8187, 4);
});

test("lines_and_pages_are_turned_into_pixels", () => {
  expect(wheelDy({ deltaY: 3, deltaMode: 1 }, 600)).toBe(48);
  expect(wheelDy({ deltaY: 1, deltaMode: 2 }, 600)).toBe(600);
  expect(wheelDy({ deltaY: 7, deltaMode: 0 }, 600)).toBe(7);
});

test("each_event_is_clamped", () => {
  expect(wheelZoom({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, 2000).zoom).toBe(0.5);
  expect(wheelZoom({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, -2000).zoom).toBe(2);
});

test("the_point_under_the_pointer_stays", () => {
  const at = { x: 300, y: 200 };
  for (const zoom of [0.1, 1, 4]) {
    const v = { x: -50, y: 80, zoom };
    for (const dy of [-120, 100, 40]) {
      const n = wheelZoom(v, at, dy);
      expect((at.x - n.x) / n.zoom).toBeCloseTo((at.x - v.x) / v.zoom, 2);
      expect((at.y - n.y) / n.zoom).toBeCloseTo((at.y - v.y) / v.zoom, 2);
    }
  }
});

test("zoom_stays_between_0_1_and_4", () => {
  let v = { x: 0, y: 0, zoom: 1 };
  for (let i = 0; i < 30; i++) v = wheelZoom(v, { x: 10, y: 10 }, 500);
  expect(v.zoom).toBe(MIN_ZOOM);
  for (let i = 0; i < 30; i++) v = wheelZoom(v, { x: 10, y: 10 }, -500);
  expect(v.zoom).toBe(MAX_ZOOM);
});
