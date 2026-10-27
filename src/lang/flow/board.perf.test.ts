import { expect, test } from "vitest";
import type { FromWorker } from "../protocol";
import { createHandler } from "../worker";
import { frameHeaders } from "./board";
import { board, FRAMES, LINKS, TYPED_FRAME } from "./fixtures/bigBoard";
import { type FlowDoc, MAX_BOARD_FRAMES, MAX_BOARD_SHAPES } from "./model";
import { bestMedian } from "./perfGate";
import { createFlowService, type FlowResult } from "./service";
import { docsById, fromWire, toWire } from "./wire";

// Timing tests: run alone through `npm run test:perf`. The board is A5's, at the limit (fixtures/bigBoard.ts).

/** The editor side's merge of a worker post: what the client resolves with. */
function merge(out: FromWorker | null, held: Map<number, FlowDoc>): FlowResult {
  if (out?.type !== "flowResult") throw new Error("expected a flow result");
  const r = fromWire(out.result, held);
  held.clear();
  for (const [k, v] of docsById(r)) held.set(k, v);
  return r;
}

function expectFullBoard(r: FlowResult) {
  expect(r.problems).toEqual([]);
  expect(r.frames).toHaveLength(MAX_BOARD_FRAMES);
  expect(r.frames.reduce((n, f) => n + (f.doc?.nodes.length ?? 0) + (f.doc?.groups.length ?? 0), 0)).toBe(MAX_BOARD_SHAPES);
  expect(r.frames.reduce((n, f) => n + (f.doc?.links.length ?? 0), 0)).toBe(FRAMES * LINKS);
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
  expectFullBoard(merge(last, new Map()));
  expect(median).toBeLessThan(120);
});

test("typing_in_one_frame_of_a_10000_shape_board_parses_and_sends_under_40ms", () => {
  let last: FromWorker | null = null;
  const handle = createHandler((m) => (last = structuredClone(m)), 0);
  const held = new Map<number, FlowDoc>();
  handle({ type: "flowParse", id: 0, docId: "board", text: board() });
  const seed = merge(last, held);
  // 3 batches of 20 runs; the texts are built before the timing (they share the 49 unchanged frames).
  const texts = Array.from({ length: 60 }, (_, run) => board(` typed ${run}`));
  let merged = seed;
  const median = bestMedian((run) => {
    // A change in frame 25 only, as typing makes one: frames 0 to 24 and 26 to 49 reuse their parse.
    handle({ type: "flowParse", id: run + 1, docId: "board", text: texts[run] });
    merged = merge(last, held);
  });
  expectFullBoard(merged);
  expect(merged.frames[TYPED_FRAME].doc?.links[LINKS - 1].label).toBe(`go ${LINKS - 1} typed ${texts.length - 1}`);
  for (let i = 0; i < FRAMES; i++) {
    if (i === TYPED_FRAME) expect(merged.frames[i].doc).not.toBe(seed.frames[i].doc);
    else expect(merged.frames[i].doc, `frame ${i} was parsed again`).toBe(seed.frames[i].doc);
  }
  expect(median).toBeLessThan(40);
});

test("typing_in_one_frame_posts_and_merges_under_12ms", () => {
  const svc = createFlowService();
  const sent = new Set<number>();
  const held = new Map<number, FlowDoc>();
  const send = (text: string) => {
    const wire = toWire(svc.parse("board", text), sent);
    const r = fromWire(structuredClone(wire), held);
    held.clear();
    for (const [k, v] of docsById(r)) held.set(k, v);
    return { wire, r };
  };
  send(board());
  // A change in frame 25 only (its last link's label): one doc on the wire, the other 49 by id.
  const texts = Array.from({ length: 60 }, (_, run) => board(` typed ${run}`));
  let last = send(board());
  const median = bestMedian((run) => {
    last = send(texts[run]);
  });
  expect(last.wire.frames.filter((f) => f.doc !== undefined)).toHaveLength(1);
  expectFullBoard(last.r);
  expect(median).toBeLessThan(12);
});

test("frame_headers_on_a_full_board_under_2ms", () => {
  const text = board();
  expect(frameHeaders(text)).toHaveLength(FRAMES);
  expect(frameHeaders(text)[TYPED_FRAME]).toMatchObject({ kind: "flow", title: `Area ${TYPED_FRAME}` });
  expect(bestMedian(() => frameHeaders(text))).toBeLessThan(2);
});
