// Final review I2 timing: the Publish guards on the typing path, a one-frame board of a 2,000-shape flowchart. Each
// keystroke reparses, and FlowTab asks both guards (the strip button and Publish frame...). Run alone through
// `npm run test:perf`.
import { expect, test } from "vitest";
import { bestMedian } from "../../../lang/flow/perfGate";
import { createFlowService } from "../../../lang/flow/service";
import { emptyPositions, type FlowLayout } from "../../layout";
import type { BoardLayout } from "../boardLayout";
import { anyFrameDrawn } from "./boardPublish";

const SHAPES = 2000;

function text(typed: string): string {
  const lines = ['diagram flow "Big"'];
  for (let i = 0; i < SHAPES; i++) lines.push(`Step ${i}`);
  for (let i = 1; i < SHAPES; i++) lines.push(`Step ${i - 1} > Step ${i}`);
  // The shape being typed, new and not placed yet.
  lines.push(`Note${typed}`);
  return `${lines.join("\n")}\n`;
}

test("the_publish_guards_cost_under_0_1ms_a_keystroke_at_2000_shapes", () => {
  const svc = createFlowService();
  const nodes = emptyPositions();
  for (let i = 0; i < SHAPES; i++) nodes[`Step ${i}`] = { x: (i % 50) * 200, y: Math.floor(i / 50) * 140 };
  const board: BoardLayout = { frames: new Map([["Big", { at: { x: 0, y: 0 }, nodes, style: "modern", direction: "TB" }]]), sketches: [] };
  const layout: FlowLayout = { version: 1, nodes, style: "modern", direction: "TB" };
  // Each keystroke changes the new shape's name; the 2,000 placed shapes stay as they are.
  const results = Array.from({ length: 60 }, (_, run) => svc.parse("board", text(` typed ${run}`)).frames);
  expect(results[0][0].doc?.nodes).toHaveLength(SHAPES + 1);
  const median = bestMedian((run) => {
    const frames = results[run];
    const a = anyFrameDrawn({ frames, board, keys: ["Big"], frameIndex: 0, liveLayout: layout });
    const b = anyFrameDrawn({ frames, board, keys: ["Big"], frameIndex: 0, liveLayout: layout, only: 0 });
    if (!a || !b) throw new Error("the frame draws");
  });
  console.log(`publish guards, 2,000 shapes: ${median.toFixed(3)} ms a keystroke`);
  expect(median).toBeLessThan(0.1);
});
