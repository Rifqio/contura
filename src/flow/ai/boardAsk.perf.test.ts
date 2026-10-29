// Plan D Task 19 memory: twenty board Asks on the limit board (50 frames, 10,000 shapes, 1,000 sketches), each the
// whole pure chain a proposal walks: the request, the 40-change proposal as check_board returns it, the touched
// frames, the landing plan, the review, the scene built with the review, and the landing applied to an editor with
// history and undone. No React or DOM. Run alone through `npm run test:perf`.
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { expect, test } from "vitest";
import { frameHeaders, splitFrames } from "../../lang/flow/board";
import { bigProposal, board, FRAMES, PROPOSAL_FRAMES } from "../../lang/flow/fixtures/bigBoard";
import { bigBoardLayout, fullSketches } from "../../lang/flow/fixtures/bigBoardLayout";
import { createFlowService } from "../../lang/flow/service";
import { boardNodeBoxes, createBoardScene } from "../board/boardScene";
import { boardInput, onBoard, sketchNotes } from "./boardInput";
import { boardReview } from "./boardReview";
import { bestMedian } from "../../lang/flow/perfGate";
import { applyEdits } from "../../lang/flow/service";
import { isRefusal, planBoardLanding, touchedFrames } from "./proposal";
import { addedLines, frameSpans, ghostEdits, touchedLines } from "./useBoardAsk";

const heapUsed = () => (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;

const KEYS = Array.from({ length: FRAMES }, (_, k) => `Area ${k}`);

function setup() {
  const svc = createFlowService();
  const text = board();
  const r = svc.parse("board", text);
  const layout = bigBoardLayout(fullSketches());
  // One scene per tab, as FlowTab keeps it: its memos live across Asks.
  const scene = createBoardScene("modern");
  const titles = frameHeaders(text).map((h) => h.title);
  /** One Ask, start to undo; returns what it touched so the work is not optimised away. */
  const ask = () => {
    const o = svc.boardOutline("board", r.version);
    if (o.stale) throw new Error("expected the board's outline");
    const plain = scene.build(r.frames, layout, KEYS, null, null, []);
    const boxes = onBoard(plain);
    const request = boardInput({
      frames: o.frames,
      boxes,
      focus: ["Area 3", "Area 0"],
      selected: { frame: "Area 3", shapes: ["Step 1"], sketches: ["s120"] },
      notes: sketchNotes(layout.sketches, boxes, boardNodeBoxes(plain)),
      create: null,
      followUp: null,
      attachment: null,
    });
    const changes = bigProposal();
    const touched = touchedFrames(text, splitFrames(text), titles, changes);
    const accepted = new Set(changes.map((c) => c.index));
    const plan = planBoardLanding(text, touched, changes, accepted, { titles, shapes: 10_000 });
    if (isRefusal(plan)) throw new Error(plan.message);
    const review = boardReview(touched, plan, changes, accepted, { titles });
    const reviewed = scene.build(r.frames, layout, KEYS, null, null, [], undefined, null, undefined, null, review);
    let state = EditorState.create({ doc: text, extensions: [history()] });
    state = state.update({ changes: plan.edits }).state;
    const landed = state.doc.length !== text.length;
    undo({
      state,
      dispatch: (tr) => {
        state = tr.state;
      },
    });
    if (state.doc.toString() !== text) throw new Error("undo did not restore the board");
    if (reviewed.nodes.length === 0) throw new Error("the reviewed scene is empty");
    return request.frames.length + review.size + (landed ? 1 : 0);
  };
  return { ask };
}

test("twenty_asks_on_the_limit_board_do_not_grow_the_heap", () => {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  expect(typeof gc).toBe("function");
  const { ask } = setup();
  let seen = 0;
  // Warm up: the first Ask fills the scene's memos and the parser's caches.
  seen += ask();
  gc!();
  const before = heapUsed();
  for (let i = 0; i < 20; i++) seen += ask();
  gc!();
  const after = heapUsed();
  console.log(`twenty board Asks: heap ${((after - before) / 1024).toFixed(0)} KB`);
  // Every Ask: 50 frames in the request, 5 frames reviewed, the landing changed the text.
  expect(seen).toBe(21 * (FRAMES + PROPOSAL_FRAMES.length + 1));
  expect(after - before).toBeLessThan(2 * 1024 * 1024);
});

// Final review C1: the review's line marks (ghost edits, touched lines) and the landing's added lines on the limit
// board, diffed by touched frame through the capped line diff, never as one table over the whole board.
function marksSetup() {
  const text = board();
  const titles = frameHeaders(text).map((h) => h.title);
  const changes = bigProposal();
  const touched = touchedFrames(text, splitFrames(text), titles, changes);
  const plan = planBoardLanding(text, touched, changes, new Set(changes.map((c) => c.index)), { titles, shapes: 10_000 });
  if (isRefusal(plan)) throw new Error(plan.message);
  /** What `planned` and `land` compute for one proposal: the ghost, the review's lines and the landed lines. */
  const marks = () => {
    const spans = frameSpans(touched, plan);
    const edits = ghostEdits(text, plan.text, spans);
    return { edits, touched: touchedLines(text, plan.text, spans), added: addedLines(text, plan.text, spans) };
  };
  return { text, plan, marks };
}

test("the_review_marks_on_the_limit_board_take_under_40ms", () => {
  const { text, plan, marks } = marksSetup();
  const m = marks();
  expect(applyEdits(text, m.edits)).toBe(plan.text);
  // Each mark stays inside one of the five touched frames: nothing is marked whole.
  const slices = splitFrames(text);
  for (const e of m.edits) expect(slices.some((f) => PROPOSAL_FRAMES.includes(f.index) && e.from >= f.from && e.to <= f.to)).toBe(true);
  expect(m.added.length).toBeGreaterThan(0);
  expect(m.touched.length).toBeGreaterThan(0);
  const median = bestMedian(() => {
    marks();
  });
  console.log(`limit board review marks: median ${median.toFixed(1)} ms`);
  expect(median).toBeLessThan(40);
});

test("twenty_review_marks_on_the_limit_board_do_not_grow_the_heap", () => {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  expect(typeof gc).toBe("function");
  const { marks } = marksSetup();
  let seen = marks().edits.length;
  gc!();
  const before = heapUsed();
  for (let i = 0; i < 20; i++) seen += marks().edits.length;
  gc!();
  const after = heapUsed();
  console.log(`twenty review marks: heap ${((after - before) / 1024).toFixed(0)} KB`);
  expect(seen).toBeGreaterThan(0);
  expect(after - before).toBeLessThan(2 * 1024 * 1024);
});

test("a_12000_line_frame_changed_at_both_ends_is_marked_under_40ms", () => {
  // One From my database ER frame of 600 tables of 20 columns, a table added at each end: past the cap once its
  // shared lines are trimmed, so the frame's changed span is replaced whole instead of a 144-million-cell table.
  const tables = Array.from({ length: 600 }, (_, t) => `t${t} {\n${Array.from({ length: 19 }, (_, c) => `  c${c} int\n`).join("")}}\n`);
  const head = 'diagram er "Prod"\n';
  const frame = head + tables.join("");
  const after = `${head}first {\n  id int\n}\n${tables.join("")}last {\n  id int\n}\n`.replace("t0 {", "t0x {");
  const text = `${frame}\ndiagram flow "Other"\nA\n`;
  const next = `${after}\ndiagram flow "Other"\nA\n`;
  const spans = [{ from: 0, to: frame.length, after }];
  expect(frame.split("\n").length).toBeGreaterThan(12_000);
  const edits = ghostEdits(text, next, spans);
  expect(applyEdits(text, edits)).toBe(next);
  const median = bestMedian(() => {
    ghostEdits(text, next, spans);
    touchedLines(text, next, spans);
    addedLines(text, next, spans);
  });
  console.log(`12,000-line frame marks: median ${median.toFixed(1)} ms`);
  expect(median).toBeLessThan(40);
});
