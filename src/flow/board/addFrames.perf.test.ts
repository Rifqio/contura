// B2 Task 1: `addFrames` at the board's limit, the main thread's part (decision 8): each text parsed, laid out (a fake
// layout here, the worker's dagre is off the main thread), measured with `frameBounds` and placed, then the one add
// transaction. Run alone through `npm run test:perf` (it needs --expose-gc). Thresholds are provisional (owner
// answer 4) until Task 15 measures them.
import { history, invertedEffects, undo } from "@codemirror/commands";
import { EditorState, type StateEffect, type Transaction } from "@codemirror/state";
import { expect, test } from "vitest";
import type { Positions } from "../../diagram/layout";
import { parseBoard } from "../../lang/flow/board";
import { appendFrames } from "../../lang/flow/boardEdits";
import type { FlowDoc } from "../../lang/flow/model";
import { emptyPositions } from "../layout";
import { frameAddSpec, frameEffect, measureNewFrames } from "../useFlowDoc";
import { type BoardLayout, type FrameLayout, utf8Length } from "./boardLayout";

const heapUsed = () => (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;
const gc = () => {
  // Twice: a weak map's entries go in a later collection than their keys.
  (globalThis as unknown as { gc: () => void }).gc();
  (globalThis as unknown as { gc: () => void }).gc();
};

/** Task 4's generator shape: 2,000 tables of 12 columns `c<k> int`, 1,999 references. */
function bigErFrame(): string {
  const lines = ['diagram er "Warehouse"'];
  for (let t = 0; t < 2000; t++) {
    lines.push(`t${t} {`);
    for (let k = 0; k < 12; k++) lines.push(`  c${k} int`);
    lines.push("}");
  }
  for (let t = 1; t < 2000; t++) lines.push(`t${t}.c1 > t${t - 1}.c0`);
  return `${lines.join("\n")}\n`;
}

/** The fake layout: a grid, answered at once. */
async function gridLayout(doc: FlowDoc): Promise<Positions> {
  const out = emptyPositions();
  doc.nodes.forEach((n, i) => {
    out[n.name] = { x: (i % 50) * 260, y: Math.floor(i / 50) * 360 };
  });
  return out;
}

const BOARD = 'diagram flow "Start"\nA\n';

/** Undo of frame changes, as useFlowDoc's history inverts them. */
const frameUndo = invertedEffects.of((tr) => {
  const out: StateEffect<unknown>[] = [];
  for (const e of tr.effects) if (e.is(frameEffect)) out.push(frameEffect.of({ title: e.value.title, before: e.value.after, after: e.value.before }));
  return out;
});

function applyFrames(board: BoardLayout, tr: Transaction): BoardLayout {
  let frames: Map<string, FrameLayout> | null = null;
  for (const e of tr.effects) {
    if (!e.is(frameEffect)) continue;
    frames ??= new Map(board.frames);
    if (e.value.after) frames.set(e.value.title, e.value.after);
    else frames.delete(e.value.title);
  }
  return frames ? { ...board, frames } : board;
}

test("adding_a_2000_table_frame_takes_under_400ms_on_the_main_thread", async () => {
  const text = bigErFrame();
  const parsedBoard = parseBoard(BOARD);
  const edits = appendFrames(BOARD, parsedBoard, [text]);
  expect(edits.names).toEqual({ "0": "Warehouse" });
  const times: number[] = [];
  for (let run = 0; run < 5; run++) {
    const state = EditorState.create({ doc: BOARD, extensions: [history(), frameUndo] });
    const board: BoardLayout = { frames: new Map(), sketches: [] };
    const t0 = performance.now();
    const m = await measureNewFrames([{ text }], { x: 0, y: 0 }, gridLayout);
    const tr = state.update(frameAddSpec(state, edits.edits, [{ title: "Warehouse", after: m.entries[0] }], board));
    times.push(performance.now() - t0);
    expect(tr.state.doc.length).toBe(BOARD.length + 1 + text.length);
    expect(Object.keys(m.entries[0].nodes)).toHaveLength(2000);
    expect(m.boxes[0].w).toBeGreaterThan(10_000);
  }
  const best = Math.min(...times);
  console.log(`addFrames main thread, 2,000 tables: best ${best.toFixed(0)} ms of ${times.map((t) => t.toFixed(0)).join(", ")}`);
  expect(best).toBeLessThan(400);
}, 120_000);

test("ten_adds_and_undos_hold_one_frame_of_heap", async () => {
  expect(typeof (globalThis as { gc?: unknown }).gc).toBe("function");
  const text = bigErFrame();
  const size = utf8Length(text);
  const edits = appendFrames(BOARD, parseBoard(BOARD), [text]).edits;
  let state = EditorState.create({ doc: BOARD, extensions: [history(), frameUndo] });
  let board: BoardLayout = { frames: new Map(), sketches: [] };
  const view = {
    get state() {
      return state;
    },
    dispatch(tr: Transaction) {
      board = applyFrames(board, tr);
      state = tr.state;
    },
  };
  const round = async () => {
    const m = await measureNewFrames([{ text }], { x: 0, y: 0 }, gridLayout);
    view.dispatch(state.update(frameAddSpec(state, edits, [{ title: "Warehouse", after: m.entries[0] }], board)));
    expect(board.frames.has("Warehouse")).toBe(true);
    expect(undo(view as never)).toBe(true);
    expect(board.frames.has("Warehouse")).toBe(false);
    expect(state.doc.toString()).toBe(BOARD);
  };
  // The baseline at the first undo: the redo then holds one frame, as it does after every later round.
  await round();
  await new Promise((r) => setTimeout(r, 0));
  gc();
  const base = heapUsed();
  for (let i = 0; i < 9; i++) await round();
  await new Promise((r) => setTimeout(r, 0));
  gc();
  const grown = heapUsed() - base;
  console.log(`addFrames: nine more adds and undos of a ${(size / 1024).toFixed(0)} KB frame grew the heap ${(grown / 1024).toFixed(0)} KB`);
  expect(grown).toBeLessThan(2 * size);
}, 120_000);
