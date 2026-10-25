import { expect, test } from "vitest";
import { bestMedian } from "../lang/flow/perfGate";
import { GuideIndex } from "./guides";

// Timing test: runs alone through `npm run test:perf`. A drag on a 2,000-shape canvas: the index is built once from
// every shape (the worst case, all on screen), then each frame snaps the dragged box. Best of three 20-run medians.
const boxes = Array.from({ length: 2000 }, (_, i) => ({ x: (i % 50) * 260 + (i % 7), y: Math.floor(i / 50) * 180 + (i % 5), w: 184 + (i % 9) * 8, h: 84 + (i % 6) * 22 }));

test("guides_index_for_2000_shapes_under_16ms", () => {
  expect(bestMedian(() => void new GuideIndex(boxes))).toBeLessThan(16);
});

test("a_guides_frame_at_2000_shapes_under_1ms", () => {
  const g = new GuideIndex(boxes);
  let hits = 0;
  const median = bestMedian((run) => {
    for (let k = 0; k < 10; k++) {
      const s = g.snap({ x: (run * 37 + k * 113) % 12000, y: (run * 53 + k * 71) % 7000, w: 200, h: 120 }, 6);
      if (s.lines.length) hits++;
    }
  });
  expect(hits).toBeGreaterThan(0);
  // Ten frames per run.
  expect(median / 10).toBeLessThan(1);
});
