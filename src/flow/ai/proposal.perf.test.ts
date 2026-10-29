// Plan D Task 7 timing and memory: re-planning a 40-change proposal over 5 frames of the limit board (50 frames,
// 10,000 shapes) when one row is toggled, from the touched frames held while the proposal waits. Run alone through
// `npm run test:perf`.
import { expect, test } from "vitest";
import { frameHeaders, splitFrames } from "../../lang/flow/board";
import { bigProposal, board, FRAMES, PROPOSAL_FRAMES } from "../../lang/flow/fixtures/bigBoard";
import { bestMedian } from "../../lang/flow/perfGate";
import { boardWouldBreak, isRefusal, planBoardLanding, touchedFrames } from "./proposal";

const heapUsed = () => (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;

function setup() {
  const text = board();
  const titles = frameHeaders(text).map((h) => h.title);
  const changes = bigProposal();
  // Made once per proposal and held while it waits.
  const touched = touchedFrames(text, splitFrames(text), titles, changes);
  const counts = { titles, frames: FRAMES, shapes: 10_000 };
  const all = changes.map((c) => c.index);
  // The rows no other change needs: rejecting one takes nothing else with it.
  const rows = changes.filter((c) => !changes.some((d) => d.dependsOn.includes(c.index))).map((c) => c.index);
  /** A row toggled off (on again for odd runs), re-planned and checked. */
  const toggle = (run: number) => {
    const row = rows[run % rows.length];
    const accepted = new Set(run % 2 ? all : all.filter((i) => i !== row));
    const plan = planBoardLanding(text, touched, changes, accepted, { titles, shapes: counts.shapes });
    if (isRefusal(plan)) return null;
    boardWouldBreak(touched, plan, counts);
    return plan;
  };
  return { touched, toggle };
}

test("toggling_a_row_on_the_limit_board_plans_under_30ms", () => {
  const { touched, toggle } = setup();
  expect(touched.map((t) => t.index)).toEqual(PROPOSAL_FRAMES);
  const plan = toggle(1);
  expect(plan?.touched).toHaveLength(PROPOSAL_FRAMES.length);
  expect(plan?.edits).toHaveLength(PROPOSAL_FRAMES.length);
  const median = bestMedian((run) => {
    toggle(run);
  });
  expect(median).toBeLessThan(30);
});

test("fifty_toggles_do_not_grow_the_heap", () => {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  expect(typeof gc).toBe("function");
  const { toggle } = setup();
  let landed = 0;
  for (let i = 0; i < 5; i++) landed += toggle(i) ? 1 : 0;
  gc!();
  const before = heapUsed();
  for (let i = 0; i < 50; i++) landed += toggle(i) ? 1 : 0;
  gc!();
  const after = heapUsed();
  expect(landed).toBe(55);
  expect(after - before).toBeLessThan(1024 * 1024);
});
