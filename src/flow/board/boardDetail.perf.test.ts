import { expect, test } from "vitest";
import { bestMedian } from "../../lang/flow/perfGate";
import { type BoardView, type DrawnForms, type FrameForm, frameDraw, stepForms } from "./boardDetail";
import type { TextSize } from "./boardLayout";
import type { FrameBox } from "./boardScene";

// Timing tests: run alone through `npm run test:perf`. 50 frames, the board limit. Set in Task 9 from the readings
// (medians 0.018, 0.011 and 0.015 ms): 0.2 ms each, lowered from the provisional 1 ms.

const boxes: FrameBox[] = Array.from({ length: 50 }, (_, i) => ({
  key: `f${i}`,
  index: i,
  title: `F${i}`,
  kind: null,
  x: (i % 10) * 400,
  y: Math.floor(i / 10) * 400,
  w: 300,
  h: 300,
  problems: 0,
  clash: false,
}));
const sizes: TextSize[] = boxes.map((_, i) => (["s", "m", "l"] as const)[i % 3]);
const shapes = boxes.map(() => 200);
const centres = boxes.map((b) => ({ x: b.x + 150, y: b.y + 150 }));
const view: BoardView = { x: 0, y: 0, w: 4000, h: 2000, zoom: 0.5 };
const input = { boxes, sizes, shapes, live: 0, dragging: null, dragForm: null, view, wasFar: new Set<TextSize>() };

test("a_plan_for_the_limit_board_under_0_2ms", () => {
  const median = bestMedian(() => frameDraw(input), 3, 20);
  console.log(`a plan for the limit board: median ${median.toFixed(3)} ms`);
  expect(median).toBeLessThan(0.2);
});

test("a_step_for_the_limit_board_under_0_2ms", () => {
  const target = frameDraw(input);
  const drawn: DrawnForms = { form: new Map<number, FrameForm>(boxes.map((b) => [b.index, "picture"])), mounted: new Map() };
  const median = bestMedian(() => stepForms(target, drawn, () => true, shapes, centres, { x: 0, y: 0 }, 80), 3, 20);
  console.log(`a step for the limit board: median ${median.toFixed(3)} ms`);
  expect(median).toBeLessThan(0.2);
});

test("a_crossing_step_for_the_limit_board_under_0_2ms", () => {
  // Zooming in over a limit board of readable frames: all 50 pictures turn real, 50 shapes each, 80 per step.
  const few = boxes.map(() => 50);
  const readable = { ...input, shapes: few, live: null, sizes: boxes.map(() => "m" as TextSize), view: { ...view, zoom: 1 } };
  const target = frameDraw(readable);
  expect([...target.form.values()].every((f) => f === "real")).toBe(true);
  const drawn: DrawnForms = { form: new Map<number, FrameForm>(boxes.map((b) => [b.index, "picture"])), mounted: new Map() };
  const median = bestMedian(() => stepForms(target, drawn, () => true, few, centres, { x: 1000, y: 800 }, 80), 3, 20);
  console.log(`a crossing step for the limit board: median ${median.toFixed(3)} ms`);
  expect(median).toBeLessThan(0.2);
});
