// Task 11 timing and memory: the sketch layer at the caps (1,000 sketches, Decision 21). Run alone through
// `npm run test:perf`.
import { history, isolateHistory, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { expect, test } from "vitest";
import { board, FRAMES } from "../../lang/flow/fixtures/bigBoard";
import { fullSketches } from "../../lang/flow/fixtures/bigBoardLayout";
import { bestMedian } from "../../lang/flow/perfGate";
import { createFlowService } from "../../lang/flow/service";
import { emptyPositions } from "../layout";
import { sketchEffect, sketchUndo } from "../useFlowDoc";
import { type BoardLayout, MAX_SKETCHES, type Sketch } from "./boardLayout";
import { createBoardScene } from "./boardScene";
import { applySketches, moveSketches, SKETCH_LAYER_ID, sketchNodeId } from "./sketches";

const heapUsed = () => (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;

function bigLayout(sketches: Sketch[]): BoardLayout {
  const frames: BoardLayout["frames"] = new Map();
  for (let k = 0; k < FRAMES; k++) frames.set(`Area ${k}`, { at: { x: k * 5200, y: 0 }, nodes: emptyPositions(), style: "modern", direction: "TB" });
  return { frames, sketches };
}

const KEYS = Array.from({ length: FRAMES }, (_, k) => `Area ${k}`);

test("a_board_with_1000_sketches_builds_its_layer_under_20ms", () => {
  // Timed with no frames, so the time is the sketch layer's alone (a cold scene: every node made).
  const r = createFlowService().parse("board", board());
  const frames = r.frames.slice(0, 5);
  const sketches = fullSketches();
  const b = bigLayout(sketches);
  let out = createBoardScene("modern").build([], b, [], null, null, []);
  const median = bestMedian(() => {
    out = createBoardScene("modern").build([], b, [], null, null, []);
  }, 3, 5);
  expect(out.nodes.filter((n) => n.parentId === SKETCH_LAYER_ID)).toHaveLength(MAX_SKETCHES);
  expect(median).toBeLessThan(20);
  // A sketch move rebuilds that one node object; the rest, and the layer, are the very same.
  const scene = createBoardScene("modern");
  const seed = scene.build(frames, b, KEYS, null, null, []);
  const moved = applySketches(sketches, moveSketches(sketches, ["s500"], 40, 0));
  const after = scene.build(frames, { ...b, sketches: moved }, KEYS, null, null, []);
  const was = new Map(seed.nodes.map((n) => [n.id, n]));
  let fresh = 0;
  for (const n of after.nodes) if (n.id === SKETCH_LAYER_ID || n.parentId === SKETCH_LAYER_ID) if (n !== was.get(n.id)) fresh++;
  expect(fresh).toBe(1);
  expect(after.nodes.find((n) => n.id === sketchNodeId("s500"))?.position).toEqual({ x: (499 % 40) * 300 + 40, y: Math.floor(499 / 40) * 300 });
});

test("an_origin_shift_rebuilds_no_sketch_node", () => {
  const r = createFlowService().parse("board", board());
  const frames = r.frames.slice(0, 5);
  const b = bigLayout(fullSketches());
  const scene = createBoardScene("modern");
  const a = scene.build(frames, b, KEYS, { title: "Area 0", index: 0 }, { nodes: [] }, []);
  const c = scene.build(frames, b, KEYS, { title: "Area 3", index: 3 }, { nodes: [] }, []);
  const was = new Map(a.nodes.map((n) => [n.id, n]));
  let same = 0;
  for (const n of c.nodes) {
    if (n.parentId !== SKETCH_LAYER_ID) continue;
    expect(n).toBe(was.get(n.id));
    same++;
  }
  expect(same).toBe(MAX_SKETCHES);
  // The layer alone moves, to -origin.
  expect(c.nodes.find((n) => n.id === SKETCH_LAYER_ID)?.position).toEqual({ x: -3 * 5200, y: 0 });
});

test("undo_history_of_sketch_moves_holds_changes_not_copies", () => {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  expect(typeof gc).toBe("function");
  let all = fullSketches();
  let state = EditorState.create({ doc: "diagram flow\n", extensions: [history(), sketchUndo] });
  const moveOne = (i: number) => {
    const changes = moveSketches(all, [`s${((i * 37) % MAX_SKETCHES) + 1}`], 10, 5);
    state = state.update({ effects: sketchEffect.of(changes), annotations: isolateHistory.of("full") }).state;
    all = applySketches(all, changes);
  };
  for (let i = 0; i < 5; i++) moveOne(i);
  gc!();
  const before = heapUsed();
  for (let i = 5; i < 105; i++) moveOne(i);
  gc!();
  const grown = heapUsed() - before;
  expect(grown).toBeLessThan(1024 * 1024);
  // And per move, under what even a list of 1,000 references would cost (8 KB): a move holds its one sketch.
  expect(grown / 100).toBeLessThan(4 * 1024);
  // And the history holds them: undo gives back each move as its own entry.
  let undone = 0;
  const view = {
    get state() {
      return state;
    },
    dispatch(tr: { state: EditorState }) {
      for (const e of (tr as unknown as { effects: readonly { is(t: unknown): boolean }[] }).effects) if (e.is(sketchEffect)) undone++;
      state = tr.state;
    },
  };
  for (let i = 0; i < 105; i++) undo(view as never);
  expect(undone).toBe(105);
});

test("a_board_of_1000_icon_sketches_builds_under_20ms", () => {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  expect(typeof gc).toBe("function");
  const sketches: Sketch[] = Array.from({ length: MAX_SKETCHES }, (_, i) => ({ id: `s${i + 1}`, kind: "icon" as const, x: (i % 40) * 80, y: Math.floor(i / 40) * 80, w: 64, h: 64, icon: `icon-${i}` }));
  const b = bigLayout(sketches);
  let out = createBoardScene("modern").build([], b, [], null, null, []);
  const median = bestMedian(() => {
    out = createBoardScene("modern").build([], b, [], null, null, []);
  }, 3, 5);
  expect(out.nodes.filter((n) => n.parentId === SKETCH_LAYER_ID)).toHaveLength(MAX_SKETCHES);
  // Provisional until measured: never raised.
  expect(median).toBeLessThan(20);
  const scene = createBoardScene("modern");
  for (let i = 0; i < 3; i++) scene.build([], b, [], null, null, []);
  gc!();
  const before = heapUsed();
  for (let i = 0; i < 10; i++) out = scene.build([], b, [], null, null, []);
  gc!();
  expect(heapUsed() - before).toBeLessThan(1024 * 1024);
});
