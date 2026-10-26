import { expect, test } from "vitest";
import { parseFlow } from "./parse";

const lines = (...l: string[]) => `${l.join("\n")}\n`;

// Timing test: runs alone through `npm run test:perf`, so other test files don't compete for the CPU.
test("long_dotted_names_stay_fast", () => {
  const long = lines("diagram er", `a${".b".repeat(20_000)}`);
  const many = lines("diagram er", ...Array.from({ length: 2000 }, (_, i) => `t${i}${".c".repeat(500)}`));
  // The best of a few runs, so a garbage collection in one does not decide it.
  let best = Infinity;
  for (let run = 0; run < 5; run++) {
    const t0 = performance.now();
    parseFlow(long);
    parseFlow(many);
    best = Math.min(best, performance.now() - t0);
  }
  expect(best).toBeLessThan(20);
});
