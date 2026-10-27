// Task 15 memory: the full board (A5's 50 frames and 10,000 shapes, 1,000 sketches at the caps) opened and closed
// again leaves nothing behind, with no DOM: the worker's service, the client's merge and the board scene. Run alone
// through `npm run test:perf` (it needs --expose-gc). B3 reuses the pattern: a gc baseline at the first close.
import { history, invertedEffects, isolateHistory, undo } from "@codemirror/commands";
import { EditorState, type StateEffect } from "@codemirror/state";
import { expect, test } from "vitest";
import { LangClient, type WorkerLike } from "../../lang/client";
import { frameHeaders } from "../../lang/flow/board";
import { board, FRAMES, TYPED_FRAME } from "../../lang/flow/fixtures/bigBoard";
import { bigBoardLayoutFile, SKETCH_COUNT } from "../../lang/flow/fixtures/bigBoardLayout";
import type { FromWorker, ToWorker } from "../../lang/protocol";
import { createHandler } from "../../lang/worker";
import { frameEffect } from "../useFlowDoc";
import { type FrameLayout, frameBounds, frameGraph, parseBoardLayout } from "./boardLayout";
import { createBoardScene } from "./boardScene";

const heapUsed = () => (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;
const gc = () => {
  // Twice: a weak map's entries go in a later collection than their keys.
  (globalThis as unknown as { gc: () => void }).gc();
  (globalThis as unknown as { gc: () => void }).gc();
};
const MB = 1024 * 1024;
/**
 * A turn of the event loop, then gc. Without the turn, a collection right after the last await sometimes still found
 * the last parse reachable from the finished cycle's promise jobs: 19.6 MB once in about five closes, gone by the next
 * close, and gone in every close once the jobs had run. Nothing the app holds.
 */
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  gc();
};

/** The language worker in-process, every message cloned both ways as postMessage does. */
function clonedWorker(): WorkerLike {
  const w: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (m: ToWorker) => handle(structuredClone(m)),
    terminate() {},
  };
  const handle = createHandler((m: FromWorker) => w.onmessage?.({ data: structuredClone(m) }), 0);
  return w;
}

const DOC = "flow:board";
const KEYS = Array.from({ length: FRAMES }, (_, k) => `Area ${k}`);
const TYPED = "twenty typed letters";

test("opening_and_closing_the_full_board_returns_to_baseline", async () => {
  expect(typeof (globalThis as { gc?: unknown }).gc).toBe("function");
  expect(TYPED).toHaveLength(20);
  const client = new LangClient(clonedWorker);
  // What the disk holds stays for the whole test, as the file does: the texts and the layout file.
  const file = bigBoardLayoutFile();
  const texts = Array.from({ length: TYPED.length + 1 }, (_, i) => board(TYPED.slice(0, i)));

  /** One open of the tab: read, parse, draw, select frame 25, type 20 characters, close. */
  async function openTypeClose() {
    client.openFlow(DOC);
    const layout = parseBoardLayout(file, frameHeaders(texts[0]));
    const scene = createBoardScene("modern");
    let r = await client.flow(DOC, texts[0]);
    scene.build(r.frames, layout, KEYS, null, null, r.problems);
    const sel = { title: `Area ${TYPED_FRAME}`, index: TYPED_FRAME };
    const entry = layout.frames.get(sel.title)!;
    for (let i = 1; i < texts.length; i++) {
      r = await client.flow(DOC, texts[i]);
      const live = frameGraph(entry, r.frames[TYPED_FRAME].doc!, entry.style);
      const out = scene.build(r.frames, layout, KEYS, sel, { nodes: live.nodes }, r.problems);
      expect(out.boxes).toHaveLength(FRAMES);
    }
    expect(r.frames[TYPED_FRAME].doc!.links[r.frames[TYPED_FRAME].doc!.links.length - 1].label).toBe(`go 299${TYPED}`);
    expect(scene.memoSize()).toBe(FRAMES);
    expect(scene.sketchMemoSize()).toBe(SKETCH_COUNT);
    expect(client.heldFlow.get(DOC)!.size).toBeLessThanOrEqual(FRAMES);
    client.closeFlow(DOC);
    expect(client.heldFlow.size).toBe(0);
  }

  const t0 = performance.now();
  await openTypeClose();
  const firstOpen = performance.now() - t0;
  await settle();
  const base = heapUsed();
  const after: number[] = [];
  for (let run = 0; run < 5; run++) {
    await openTypeClose();
    await settle();
    after.push(heapUsed() - base);
  }
  console.log(`reopen: first open, type and close ${firstOpen.toFixed(0)} ms; heap after each later close vs the first (KB): ${after.map((d) => (d / 1024).toFixed(0)).join(", ")}`);
  // The median of the last three closes: retention raises every close, a one-off raises one.
  const last3 = after.slice(-3).sort((x, y) => x - y);
  expect(last3[1]).toBeLessThan(2 * MB);
  client.dispose();
}, 120_000);

/** Undo of frame changes, as useFlowDoc's history inverts them. */
const frameUndo = invertedEffects.of((tr) => {
  const out: StateEffect<unknown>[] = [];
  for (const e of tr.effects) if (e.is(frameEffect)) out.push(frameEffect.of({ title: e.value.title, before: e.value.after, after: e.value.before }));
  return out;
});

test("undo_history_of_frame_moves_holds_no_old_docs", async () => {
  // A frame's box is kept per entry (frameBounds, for placement). An entry a frame move replaced stays in the undo
  // history; its kept box must not keep the doc it was measured on alive. 100 rounds of: type in frame 25 (a new doc),
  // place (every frame measured), move frame 25 (a new entry, the old one in the history).
  expect(typeof (globalThis as { gc?: unknown }).gc).toBe("function");
  const client = new LangClient(clonedWorker);
  client.openFlow(DOC);
  const layout = parseBoardLayout(bigBoardLayoutFile([]), frameHeaders(board()));
  let state = EditorState.create({ doc: "", extensions: [history({ minDepth: 200 }), frameUndo] });
  const title = `Area ${TYPED_FRAME}`;
  const round = async (i: number) => {
    const r = await client.flow(DOC, board(` typed ${i}`));
    r.frames.forEach((f, k) => frameBounds(layout.frames.get(KEYS[k])!, f.doc, "modern"));
    const before = layout.frames.get(title)!;
    const after: FrameLayout = { ...before, at: { x: before.at.x + 10, y: before.at.y } };
    layout.frames.set(title, after);
    state = state.update({ effects: frameEffect.of({ title, before, after }), annotations: isolateHistory.of("full") }).state;
  };
  for (let i = 0; i < 5; i++) await round(i);
  gc();
  const base = heapUsed();
  for (let i = 5; i < 105; i++) await round(i);
  gc();
  const grown = heapUsed() - base;
  console.log(`frame moves: 100 history entries grew the heap ${(grown / 1024).toFixed(0)} KB (${(grown / 100 / 1024).toFixed(1)} KB an entry)`);
  // An entry and its kept box are small and its 198 positions are shared; a frame doc held by one was 76 KB.
  expect(grown / 100).toBeLessThan(4 * 1024);
  // And the history holds them: undo gives each move back.
  let undone = 0;
  const view = {
    get state() {
      return state;
    },
    dispatch(tr: { state: EditorState; effects: readonly { is(t: unknown): boolean }[] }) {
      for (const e of tr.effects) if (e.is(frameEffect)) undone++;
      state = tr.state;
    },
  };
  for (let i = 0; i < 105; i++) undo(view as never);
  expect(undone).toBe(105);
  client.closeFlow(DOC);
  client.dispose();
}, 120_000);
