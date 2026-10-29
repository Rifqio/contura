// B3 Task 11's ERD at the board limit, shared by erBoard.perf.test.ts and scripts/write-limit-boards.mjs (Plan F Task 3,
// which writes it as a file for the release WebView milestone): 40 flowchart frames of A5's board (200 shapes each) and
// one ERD of 2,000 tables of 20 columns with 2,000 column relationships, exactly 10,000 shapes.
import { FRAMES, frame, NODES } from "./bigBoard";

export const ER_FLOW_FRAMES = 40;
/** How far apart the flowchart frames stand (bigBoardLayout's FRAME_STEP). */
const FRAME_STEP = 5200;
export const ER_TABLES = Array.from({ length: 2000 }, (_, i) => `t${i}`);
const block = (t: string) => [`${t} {`, "  id int pk", ...Array.from({ length: 19 }, (_, c) => `  c${c + 1} int`), "}"];
// Each table refers to the next one's key: 2,000 column relationships, every table meeting two lines.
const RING = ER_TABLES.map((t, i) => `${t}.c1 > ${ER_TABLES[(i + 1) % ER_TABLES.length]}.id`);
const ERD = ['diagram er "Schema"', ...ER_TABLES.flatMap(block), "", ...RING, ""].join("\n");

/** The board's text: the 40 flowchart frames, then the ERD. */
export const ER_BOARD_TEXT = `${Array.from({ length: ER_FLOW_FRAMES }, (_, k) => `${frame(k)}\n`).join("")}${ERD}`;
export const ER_BOARD_KEYS = [...Array.from({ length: ER_FLOW_FRAMES }, (_, k) => `Area ${k}`), "Schema"];

/** The ERD's 2,000 cards on a grid, 50 to a row. */
export function erPositions(): Record<string, { x: number; y: number }> {
  const at = Object.create(null) as Record<string, { x: number; y: number }>;
  ER_TABLES.forEach((t, i) => (at[t] = { x: (i % 50) * 260, y: Math.floor(i / 50) * 520 }));
  return at;
}

/** A flowchart frame's node positions (bigBoardLayout's): two groups of 99 nodes, 10 columns each. */
function framePositions(): Record<string, { x: number; y: number }> {
  const nodes = Object.create(null) as Record<string, { x: number; y: number }>;
  for (let i = 0; i < NODES; i++) nodes[`Step ${i}`] = { x: (i % 10) * 220 + (i >= NODES / 2 ? 2400 : 0), y: Math.floor((i % (NODES / 2)) / 10) * 100 };
  return nodes;
}

/** The board's layout file (version 2) as the Core reads it: every frame placed, the ERD to the right, no sketches. */
export function erBoardLayoutFile(): string {
  const frames = Object.create(null) as Record<string, unknown>;
  for (let k = 0; k < Math.min(ER_FLOW_FRAMES, FRAMES); k++) frames[`Area ${k}`] = { at: { x: k * FRAME_STEP, y: 0 }, nodes: framePositions(), style: "modern", direction: "TB" };
  frames.Schema = { at: { x: ER_FLOW_FRAMES * FRAME_STEP, y: 0 }, nodes: erPositions(), style: "modern", direction: "TB" };
  return `${JSON.stringify({ version: 2, frames, sketches: [] })}\n`;
}
