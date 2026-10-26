import { expect, test } from "vitest";
import type { FromWorker } from "../protocol";
import { createHandler } from "../worker";
import { MAX_BOARD_FRAMES, MAX_BOARD_SHAPES } from "./model";
import { bestMedian } from "./perfGate";

// Timing tests: run alone through `npm run test:perf`. A board at the limit: 50 frames, each 200 shapes (198 nodes in
// two groups, and the groups, which count as shapes) and 300 labelled links, so 10,000 shapes and 15,000 links in all.
const FRAMES = 50;
const NODES = 198;
const LINKS = 300;

/** Frame `k`; `typed` is added to its last link's label, as typing in it would. */
function frame(k: number, typed = ""): string {
  const lines = [`diagram flow "Area ${k}"`, ""];
  for (const [g, side] of ["Left", "Right"].entries()) {
    lines.push(`${side} ${k} {`);
    for (let i = 0; i < NODES / 2; i++) lines.push(`  Step ${g * (NODES / 2) + i}`);
    lines.push("}");
  }
  for (let i = 0; i < LINKS; i++) lines.push(`Step ${i % NODES} > Step ${(i * 7 + 1) % NODES}: go ${i}${i === LINKS - 1 ? typed : ""}`);
  return `${lines.join("\n")}\n`;
}

const BEFORE = Array.from({ length: 25 }, (_, k) => `${frame(k)}\n`).join("");
const AFTER = Array.from({ length: FRAMES - 26 }, (_, k) => `\n${frame(k + 26)}`).join("");
const TYPED_FRAME = 25;
const board = (typed = "") => `${BEFORE}${frame(TYPED_FRAME, typed)}${AFTER}`;

function expectFullBoard(out: FromWorker | null) {
  expect(out?.type).toBe("flowResult");
  if (out?.type !== "flowResult") return;
  expect(out.result.problems).toEqual([]);
  expect(out.result.frames).toHaveLength(MAX_BOARD_FRAMES);
  expect(out.result.frames.reduce((n, f) => n + (f.doc?.nodes.length ?? 0) + (f.doc?.groups.length ?? 0), 0)).toBe(MAX_BOARD_SHAPES);
  expect(out.result.frames.reduce((n, f) => n + (f.doc?.links.length ?? 0), 0)).toBe(FRAMES * LINKS);
}

test("a_10000_shape_board_parses_and_sends_under_120ms", () => {
  const text = board();
  let last: FromWorker | null = null;
  // The clone stands in for postMessage, so the time covers sending the result as well as parsing it.
  const handle = createHandler((m) => (last = structuredClone(m)), 0);
  const ids = Array.from({ length: 30 }, (_, run) => `board ${run}`);
  const median = bestMedian((run) => {
    // A fresh document each run, so no frame's parse is reused; closing it (a map delete) keeps one board held.
    handle({ type: "flowParse", id: run, docId: ids[run], text });
    handle({ type: "flowClose", docId: ids[run] });
  }, 3, 10);
  expectFullBoard(last);
  expect(median).toBeLessThan(120);
});

test("typing_in_one_frame_of_a_10000_shape_board_parses_and_sends_under_40ms", () => {
  let last: FromWorker | null = null;
  // The result as the service made it, before the clone: a reused frame's parse gives the same doc object.
  let made: FromWorker | null = null;
  const handle = createHandler((m) => {
    made = m;
    last = structuredClone(m);
  }, 0);
  handle({ type: "flowParse", id: 0, docId: "board", text: board() });
  const seed = made as FromWorker | null;
  // 3 batches of 20 runs; the texts are built before the timing (they share the 49 unchanged frames).
  const texts = Array.from({ length: 60 }, (_, run) => board(` typed ${run}`));
  const median = bestMedian((run) => {
    // A change in frame 25 only, as typing makes one: frames 0 to 24 and 26 to 49 reuse their parse.
    handle({ type: "flowParse", id: run + 1, docId: "board", text: texts[run] });
  });
  expectFullBoard(last);
  const out = last as FromWorker | null;
  if (out?.type !== "flowResult") throw new Error("expected a parse");
  expect(out.result.frames[TYPED_FRAME].doc?.links[LINKS - 1].label).toBe(`go ${LINKS - 1} typed ${texts.length - 1}`);
  const end = made as FromWorker | null;
  if (seed?.type !== "flowResult" || end?.type !== "flowResult") throw new Error("expected a parse");
  for (let i = 0; i < FRAMES; i++) {
    if (i === TYPED_FRAME) expect(end.result.frames[i].doc).not.toBe(seed.result.frames[i].doc);
    else expect(end.result.frames[i].doc, `frame ${i} was parsed again`).toBe(seed.result.frames[i].doc);
  }
  expect(median).toBeLessThan(40);
});
