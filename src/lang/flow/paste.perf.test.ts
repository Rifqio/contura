import { expect, test } from "vitest";
import type { FromWorker } from "../protocol";
import { createHandler } from "../worker";
import { bestMedian } from "./perfGate";

// Timing test: runs alone through `npm run test:perf`. A paste at the cap: 1,000 shapes with 1,000 lines between
// them (2,000 lines, the most a paste reads) pasted into a 1,000-shape diagram (2,000 shapes after), and the
// refusal one shape past it, answered in the worker.
test("a_paste_up_to_the_2000_shape_cap_is_answered_under_50ms_and_a_paste_past_it_is_refused", () => {
  const base = ['diagram flow "Large"', ""];
  for (let i = 0; i < 1000; i++) base.push(`Step ${i}`);
  for (let i = 0; i < 1500; i++) base.push(`Step ${i % 1000} > Step ${(i * 7 + 1) % 1000}: go ${i}`);
  const text = base.join("\n");
  const clip: string[] = [];
  for (let i = 0; i < 1000; i++) clip.push(`Step ${i}`);
  for (let i = 0; i < 1000; i++) clip.push(`Step ${i % 1000} > Step ${(i * 3 + 2) % 1000}: copy ${i}`);
  const atCap = clip.join("\n");
  // 1,001 shapes and 999 lines: still 2,000 lines, so it is the shape count that refuses it.
  const past = [...clip.slice(0, 1000), "One more", ...clip.slice(1000, 1999)].join("\n");

  const posts: FromWorker[] = [];
  const handle = createHandler((m) => posts.push(m), 0);
  handle({ type: "flowParse", id: 0, docId: "large", text });
  const first = posts[0];
  if (first.type !== "flowResult") throw new Error("expected a parse");
  const version = first.result.version;
  let id = 1;
  const median = bestMedian(() => {
    handle({ type: "flowEdit", id: id++, docId: "large", version, edit: { op: "paste", text: atCap } });
  }, 3, 10);
  const answers = posts.slice(1);
  expect(answers.every((m) => m.type === "flowEdit" && !m.result.stale && m.result.edits.length === 2)).toBe(true);
  expect(median).toBeLessThan(50);

  posts.length = 0;
  handle({ type: "flowEdit", id: id++, docId: "large", version, edit: { op: "paste", text: past } });
  const refused = posts[0];
  expect(refused.type === "flowEdit" && !refused.result.stale && refused.result.edits.length === 0 && refused.result.note).toBe(
    "Pasting 1,001 shapes would make 2,001 shapes, and a diagram holds at most 2,000, so nothing was pasted.",
  );
});
