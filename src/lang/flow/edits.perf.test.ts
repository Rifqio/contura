import { expect, test } from "vitest";
import type { FromWorker } from "../protocol";
import { createHandler } from "../worker";
import { bestMedian } from "./perfGate";

// Timing test: runs alone through `npm run test:perf`. A canvas action on the 2,000-node text is answered from
// the worker's cached parse, so it costs no parse at all.
test("canvas_edits_on_2000_nodes_3000_links_answer_under_16ms_in_the_worker", () => {
  const lines = ['diagram dfd "Large"', ""];
  const kinds = ["entity", "process", "store"];
  for (let g = 0; g < 20; g++) {
    lines.push(`Area ${g} {`);
    for (let i = 0; i < 100; i++) lines.push(`  Node ${g * 100 + i} [${kinds[(g * 100 + i) % 3]}, id: ${g * 100 + i}]`);
    lines.push("}");
  }
  for (let i = 0; i < 3000; i++) lines.push(`Node ${i % 2000} > Node ${(i * 7 + 1) % 2000}: flow ${i}`);
  const text = lines.join("\n");

  const posts: FromWorker[] = [];
  const handle = createHandler((m) => posts.push(structuredClone(m)), 0);
  handle({ type: "flowParse", id: 0, docId: "large", text });
  const first = posts[0];
  if (first.type !== "flowResult") throw new Error("expected a parse");
  const version = first.result.version;
  let id = 1;
  // Three actions per run, so a run's time divided by 3 is one action.
  const median = bestMedian((run) => {
    const n = (run * 97) % 2000;
    handle({ type: "flowEdit", id: id++, docId: "large", version, edit: { op: "renameNode", old: `Node ${n}`, next: `Renamed ${n}` } });
    handle({ type: "flowEdit", id: id++, docId: "large", version, edit: { op: "deleteNode", name: `Node ${n}` } });
    handle({ type: "flowEdit", id: id++, docId: "large", version, edit: { op: "addNode", name: "Process", kind: "process", group: "Area 3", unique: true } });
  }) / 3;
  const answers = posts.slice(1);
  expect(answers.every((m) => m.type === "flowEdit" && !m.result.stale && m.result.edits.length > 0)).toBe(true);
  expect(median).toBeLessThan(16);
});
