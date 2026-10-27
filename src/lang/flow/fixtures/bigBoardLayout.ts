// The layout of A5's board at the limit (bigBoard.ts), with Decision 21's sketches at their caps: every frame placed
// side by side, every node on a grid, and 1,000 sketches holding 50,000 pen points and 100,000 characters of text in
// all. Shared by the board perf and memory tests (B1 Task 15; B3 and B4 reuse it).
import type { BoardLayout, Sketch } from "../../../flow/board/boardLayout";
import { FRAMES, NODES } from "./bigBoard";

const KINDS: Sketch["kind"][] = ["rect", "ellipse", "diamond", "line", "arrow", "pen", "text", "note", "section"];

/** How far apart the frames stand: each is about 4,700 wide (two groups of 10 columns). */
export const FRAME_STEP = 5200;
export const SKETCH_COUNT = 1_000;
/** 50 strokes of 1,000 points. */
export const SKETCH_POINTS = 50_000;
/** 50 notes of 2,000 characters. */
export const SKETCH_TEXT = 100_000;

/** 1,000 sketches of every kind at the point and text caps: 50 strokes of 1,000 points, 50 notes of 2,000 characters. */
export function fullSketches(): Sketch[] {
  return Array.from({ length: SKETCH_COUNT }, (_, i) => {
    const kind = KINDS[i % KINDS.length];
    const s: Sketch = { id: `s${i + 1}`, kind, x: (i % 40) * 300, y: Math.floor(i / 40) * 300, w: 200, h: 120 };
    if (i < 50) {
      s.kind = "pen";
      s.points = Array.from({ length: SKETCH_POINTS / 50 }, (_, j) => [j % 200, (j * 7) % 120] as [number, number]);
    } else if (i < 100) {
      s.kind = "note";
      s.text = "n".repeat(SKETCH_TEXT / 50);
    }
    return s;
  });
}

/** Frame `k`'s node positions: two groups of 99 nodes, 10 columns each, the right group 2,400 to the right. */
function framePositions(): Record<string, { x: number; y: number }> {
  const nodes = Object.create(null) as Record<string, { x: number; y: number }>;
  for (let i = 0; i < NODES; i++) nodes[`Step ${i}`] = { x: (i % 10) * 220 + (i >= NODES / 2 ? 2400 : 0), y: Math.floor((i % (NODES / 2)) / 10) * 100 };
  return nodes;
}

/** The board's layout in memory, every frame placed; `sketches` defaults to none. */
export function bigBoardLayout(sketches: Sketch[] = []): BoardLayout {
  const frames: BoardLayout["frames"] = new Map();
  for (let k = 0; k < FRAMES; k++) frames.set(`Area ${k}`, { at: { x: k * FRAME_STEP, y: 0 }, nodes: framePositions(), style: "modern", direction: "TB" });
  return { frames, sketches };
}

/** The board's layout file (version 2) as the Core reads it: every frame placed, the 1,000 sketches at the caps. */
export function bigBoardLayoutFile(sketches: Sketch[] = fullSketches()): string {
  const frames = Object.create(null) as Record<string, unknown>;
  for (let k = 0; k < FRAMES; k++) frames[`Area ${k}`] = { at: { x: k * FRAME_STEP, y: 0 }, nodes: framePositions(), style: "modern", direction: "TB" };
  return `${JSON.stringify({ version: 2, frames, sketches })}\n`;
}
