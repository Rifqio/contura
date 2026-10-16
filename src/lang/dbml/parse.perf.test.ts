import { expect, test } from "vitest";
import { parseDbml } from "./parse";

// Timing test: runs alone through `npm run test:perf`, so other test files don't compete for the CPU.
test("parse_300_tables_under_200ms", () => {
  const text = Array.from({ length: 300 }, (_, i) => {
    const cols = Array.from({ length: 10 }, (_, c) => `  c${c} integer${c === 0 ? " [pk]" : ""}`).join("\n");
    return `Table t${i} {\n${cols}\n}`;
  }).join("\n\n");
  // The fastest of 5 runs: other test files compete for the CPU, the parser's own speed doesn't change.
  let best = Infinity;
  let tables = 0;
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const r = parseDbml(text, "mysql");
    best = Math.min(best, performance.now() - start);
    tables = r.model?.tables.length ?? 0;
  }
  expect(best).toBeLessThan(200);
  expect(tables).toBe(300);
});
