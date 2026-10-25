// Diagram step 6, F17 (board DiagramAddNext, "Fix: where + puts the next shape"): the next shape goes one layout
// gap from its source, centred on it; a taken spot slides across at the same gap; a full row goes further out;
// the new line never crosses a shape.
import { expect, test } from "vitest";
import { type Box, layoutGap, placeNext } from "./addNext";

const box = (x: number, y: number, w = 120, h = 48): Box => ({ x, y, w, h });

test("the gap is the diagram's own: the median edge-to-edge distance per axis, clamped to 32..120", () => {
  const a = box(0, 0);
  const b = box(0, 94); // 46 below
  const c = box(0, 188); // 46 below
  const d = box(230, 188); // 110 to the right
  const pairs = [
    [a, b],
    [b, c],
    [c, d],
  ] as [Box, Box][];
  expect(layoutGap(pairs, "v")).toBe(46);
  expect(layoutGap(pairs, "h")).toBe(110);
  // No lines on that axis: the other axis's, else 48.
  expect(layoutGap([[a, b]], "h")).toBe(46);
  expect(layoutGap([], "v")).toBe(48);
  expect(layoutGap([[a, box(0, 500)]], "v")).toBe(120);
});

test("the first spot is one gap from the source, centred on it", () => {
  const src = box(100, 100, 120, 48);
  const at = placeNext({ src, dir: "b", size: { w: 100, h: 40 }, gap: 46, boxes: [src] });
  expect(at).toMatchObject({ x: 110, y: 194, slid: 0, out: 0 });
  const right = placeNext({ src, dir: "r", size: { w: 100, h: 40 }, gap: 60, boxes: [src] });
  expect(right).toMatchObject({ x: 280, y: 104 });
  const up = placeNext({ src, dir: "t", size: { w: 100, h: 40 }, gap: 46, boxes: [src] });
  expect(up).toMatchObject({ x: 110, y: 14 });
  const left = placeNext({ src, dir: "l", size: { w: 100, h: 40 }, gap: 60, boxes: [src] });
  expect(left).toMatchObject({ x: -60, y: 104 });
});

test("a taken spot slides across at the same gap, clear of every shape by 24 px, its line crossing none", () => {
  const src = box(100, 100, 120, 48);
  const blocker = box(100, 190, 120, 48);
  const at = placeNext({ src, dir: "b", size: { w: 100, h: 40 }, gap: 46, boxes: [src, blocker] })!;
  expect(at.y).toBe(194);
  expect(at.slid).not.toBe(0);
  const nb = { x: at.x, y: at.y, w: 100, h: 40 };
  expect(nb.x >= blocker.x + blocker.w + 24 || nb.x + nb.w + 24 <= blocker.x).toBe(true);
});

test("with no free spot one gap away it goes further out in the same direction", () => {
  const src = box(0, 0, 120, 48);
  // A wall below, wider than the slide reaches, with a slot the line passes through but no shape fits in.
  const left = box(-2000, 80, 2040, 60);
  const right = box(80, 80, 2000, 60);
  const at = placeNext({ src, dir: "b", size: { w: 100, h: 40 }, gap: 46, boxes: [src, left, right] })!;
  expect(at.out).toBeGreaterThan(0);
  expect(at.y).toBeGreaterThanOrEqual(140 + 24);
});

test("a group the new shape will not join is kept clear", () => {
  const src = box(0, 0, 120, 48);
  const at = placeNext({ src, dir: "r", size: { w: 100, h: 40 }, gap: 60, boxes: [src], avoid: [box(150, -40, 300, 140)] })!;
  expect(at.x + 100 + 24 <= 150 || at.x >= 450 + 24 || at.y + 40 + 24 <= -40 || at.y >= 100 + 24).toBe(true);
});

test("only shapes near the source are checked, so 2,000 shapes cost little", () => {
  const boxes: Box[] = [];
  for (let i = 0; i < 2000; i++) boxes.push(box((i % 50) * 200, Math.floor(i / 50) * 120));
  const src = boxes[0];
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) placeNext({ src, dir: "b", size: { w: 120, h: 48 }, gap: 46, boxes });
  expect((performance.now() - t0) / 20).toBeLessThan(25);
});

test("a shape from the Shapes list goes in a free spot near the middle of the view", async () => {
  const { freeSpotNear } = await import("./addNext");
  expect(freeSpotNear({ x: 500, y: 300 }, { w: 100, h: 40 }, [])).toEqual({ x: 450, y: 280 });
  const taken = box(430, 260, 140, 80);
  const at = freeSpotNear({ x: 500, y: 300 }, { w: 100, h: 40 }, [taken]);
  const nb = { ...at, w: 100, h: 40 };
  expect(nb.x >= taken.x + taken.w + 24 || nb.x + nb.w + 24 <= taken.x || nb.y >= taken.y + taken.h + 24 || nb.y + nb.h + 24 <= taken.y).toBe(true);
  expect(Math.abs(at.x - 450) + Math.abs(at.y - 280)).toBeLessThan(200);
});
