// Smart guides (erd-ux-research 5.5): edges to edges and centre to centre within the reach, the nearest wins, and
// the guide runs across both boxes.
import { expect, test } from "vitest";
import { GuideIndex, lockAxis } from "./guides";

const other = { x: 100, y: 300, w: 120, h: 50 };

test("a left edge 5 px from another's left edge snaps onto it; 7 px does not", () => {
  const g = new GuideIndex([other]);
  const s = g.snap({ x: 105, y: 100, w: 100, h: 40 }, 6);
  expect([s.dx, s.dy]).toEqual([-5, 0]);
  expect(s.lines).toEqual([{ axis: "x", at: 100, from: 92, to: 358 }]);
  expect(g.snap({ x: 107, y: 100, w: 40, h: 40 }, 6)).toEqual({ dx: 0, dy: 0, lines: [] });
});

test("a right edge meets another's left edge, and centres meet centres", () => {
  const g = new GuideIndex([other]);
  expect(g.snap({ x: -3, y: 0, w: 100, h: 40 }, 6).dx).toBe(3);
  // Centre 160 vs the dragged box's centre 157.
  const s = g.snap({ x: 127, y: 0, w: 60, h: 40 }, 6);
  expect(s.dx).toBe(3);
  expect(s.lines.map((l) => [l.axis, l.at])).toEqual([["x", 160]]);
});

test("each axis snaps on its own, the nearest line wins, and a held axis is left alone", () => {
  const g = new GuideIndex([other, { x: 400, y: 98, w: 80, h: 40 }]);
  const s = g.snap({ x: 102, y: 100, w: 100, h: 40 }, 6);
  expect([s.dx, s.dy]).toEqual([-2, -2]);
  expect(g.snap({ x: 102, y: 100, w: 100, h: 40 }, 6, { x: false, y: true })).toMatchObject({ dx: 0, dy: -2 });
});

test("Shift keeps the axis moved furthest along", () => {
  expect(lockAxis(30, -12)).toEqual({ dx: 30, dy: 0, axis: "x" });
  expect(lockAxis(3, -12)).toEqual({ dx: 0, dy: -12, axis: "y" });
});
