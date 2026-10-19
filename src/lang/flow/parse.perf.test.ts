import { expect, test } from "vitest";
import type { FromWorker } from "../protocol";
import { createHandler } from "../worker";
import { bestMedian } from "./perfGate";

// Timing test: runs alone through `npm run test:perf`, so other test files don't compete for the CPU.
test("parse_and_send_2000_nodes_3000_links_under_16ms_in_the_worker", () => {
  const lines = ['diagram dfd "Large"', ""];
  const kinds = ["entity", "process", "store"];
  for (let g = 0; g < 20; g++) {
    lines.push(`Area ${g} {`);
    for (let i = 0; i < 100; i++) {
      const n = g * 100 + i;
      lines.push(`  Node ${n} [${kinds[n % 3]}, id: ${n}${n % 7 === 0 ? `, table: shop.t${n}` : ""}]`);
    }
    lines.push("}");
  }
  for (let i = 0; i < 3000; i++) lines.push(`Node ${i % 2000} > Node ${(i * 7 + 1) % 2000}: flow ${i}`);
  const text = lines.join("\n");

  let last: FromWorker | null = null;
  // The clone stands in for postMessage, so the time covers sending the result as well as parsing it.
  const handle = createHandler((m) => (last = structuredClone(m)), 0);
  const median = bestMedian((run) => {
    // A change on every run, as typing makes one.
    handle({ type: "flowParse", id: run, docId: "large", text: `${text}\n// run ${run}` });
  });
  const out = last as FromWorker | null;
  expect(out?.type).toBe("flowResult");
  if (out?.type !== "flowResult") return;
  expect(out.result.problems).toEqual([]);
  expect(out.result.doc?.nodes).toHaveLength(2000);
  expect(out.result.doc?.links).toHaveLength(3000);
  expect(median).toBeLessThan(16);
});
