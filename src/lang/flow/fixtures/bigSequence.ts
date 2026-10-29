// A sequence at its limit, for sequence.perf.test.ts and scripts/write-limit-boards.mjs (which
// writes it into a limit board for the release WebView run; write-limit-boards.test.mjs keeps the two equal).
// 2,000 participants with an icon and a colour each (eight icon names; the six presets and two custom hexes), 3,000
// messages with labels of 4 to 40 characters (every 50th a self-message, every 40th across at least four
// participants), 200 blocks nested 3 deep with colours, 300 activations, `autonumber` at the top and an
// `autonumber 500` restart half way.
import { frame, NODES } from "./bigBoard";

export const SEQ_PARTICIPANTS = 2000;
export const SEQ_MESSAGES = 3000;
export const SEQ_BLOCKS = 200;
export const SEQ_ACTIVATIONS = 300;
export const SEQ_ICONS = ["user", "monitor", "server", "credit-card", "database", "cloud", "lock", "mail"] as const;
export const SEQ_COLOURS = ["accent", "info", "success", "warning", "danger", "muted", "#3b82f6", "#e11d48"] as const;
const KINDS = ["loop", "alt", "opt", "par", "critical"];
/** Messages a section holds: 100 sections, the even ones three blocks deep, the odd ones one block. */
const SECTION = 30;
const WORDS = "fetch the next page of orders for review";

const who = (k: number) => `Svc ${k}`;

/** Message `i`'s label: 4 to 40 characters, never ending in a space. */
function label(i: number): string {
  const n = 4 + ((i * 13) % 37);
  const s = `m${i} ${WORDS}`.slice(0, n);
  return s.endsWith(" ") ? `${s.slice(0, -1)}x` : s;
}

/** Message `i`: a self-message every 50th, across five lanes every 40th, else to the next lane (every other a reply). */
function message(i: number): string {
  const k = i % (SEQ_PARTICIPANTS - 6);
  if (i % 50 === 0) return `${who(k)} -> ${who(k)}: ${label(i)}`;
  if (i % 40 === 0) return `${who(k)} -> ${who(k + 5)}: ${label(i)}`;
  return i % 2 ? `${who(k + 1)} --> ${who(k)}: ${label(i)}` : `${who(k)} -> ${who(k + 1)}: ${label(i)}`;
}

/** The sequence's text: one frame `diagram sequence "<title>"`. */
export function bigSequence(title = "Limit"): string {
  const out = [`diagram sequence "${title}"`, "autonumber"];
  for (let i = 0; i < SEQ_PARTICIPANTS; i++) out.push(`participant ${who(i)} [icon: ${SEQ_ICONS[i % 8]}, color: ${SEQ_COLOURS[i % 8]}]`);
  out.push("");
  let block = 0;
  let pad = "";
  const open = () => {
    const kind = KINDS[block % KINDS.length];
    out.push(`${pad}${kind} step ${block} [color: ${SEQ_COLOURS[block % 8]}] {`);
    block++;
    pad += "  ";
  };
  const close = () => {
    pad = pad.slice(2);
    out.push(`${pad}}`);
  };
  /** The activated participant of the open activation, closed two messages later. */
  let active: string | null = null;
  const send = (i: number) => {
    if (i === SEQ_MESSAGES / 2) out.push(`${pad}autonumber 500`);
    if (i % 10 === 5) {
      active = who((i % (SEQ_PARTICIPANTS - 6)) + 1);
      out.push(`${pad}activate ${active}`);
    }
    out.push(`${pad}${message(i)}`);
    if (i % 10 === 7 && active) {
      out.push(`${pad}deactivate ${active}`);
      active = null;
    }
  };
  for (let s = 0; s < SEQ_MESSAGES / SECTION; s++) {
    const at = s * SECTION;
    open();
    if (s % 2 === 0) {
      // loop { 5 messages, alt { 5, opt { 10 }, 5 }, 5 }: three deep.
      for (let i = 0; i < 5; i++) send(at + i);
      open();
      for (let i = 5; i < 10; i++) send(at + i);
      open();
      for (let i = 10; i < 20; i++) send(at + i);
      close();
      for (let i = 20; i < 25; i++) send(at + i);
      close();
      for (let i = 25; i < 30; i++) send(at + i);
    } else {
      for (let i = 0; i < SECTION; i++) send(at + i);
    }
    close();
  }
  return `${out.join("\n")}\n`;
}

/**
 * The sequence's limit board (for the release WebView run), shaped as the ER limit board: A5's
 * first 40 flowchart frames (200 shapes each) and the sequence (2,000 participants), exactly 10,000 shapes in 41
 * frames. A 50-frame board with one frame swapped for the sequence would hold 11,800 shapes, over MAX_BOARD_SHAPES.
 */
export const SEQ_FLOW_FRAMES = 40;
export const SEQ_TITLE = "Limit";
export const SEQ_BOARD_KEYS = [...Array.from({ length: SEQ_FLOW_FRAMES }, (_, k) => `Area ${k}`), SEQ_TITLE];
/** How far apart the frames stand (bigBoardLayout's FRAME_STEP). */
const FRAME_STEP = 5200;

/** The board's text: the 40 flowchart frames, then the sequence. */
export function seqBoardText(): string {
  return `${Array.from({ length: SEQ_FLOW_FRAMES }, (_, k) => `${frame(k)}\n`).join("")}${bigSequence(SEQ_TITLE)}`;
}

/** A flowchart frame's node positions (bigBoardLayout's): two groups of 99 nodes, 10 columns each. */
function framePositions(): Record<string, { x: number; y: number }> {
  const nodes = Object.create(null) as Record<string, { x: number; y: number }>;
  for (let i = 0; i < NODES; i++) nodes[`Step ${i}`] = { x: (i % 10) * 220 + (i >= NODES / 2 ? 2400 : 0), y: Math.floor((i % (NODES / 2)) / 10) * 100 };
  return nodes;
}

/** The board's layout file (version 2): every frame placed, the sequence to the right (it places itself), no sketches. */
export function seqBoardLayoutFile(): string {
  const frames = Object.create(null) as Record<string, unknown>;
  for (let k = 0; k < SEQ_FLOW_FRAMES; k++) frames[`Area ${k}`] = { at: { x: k * FRAME_STEP, y: 0 }, nodes: framePositions(), style: "modern", direction: "TB" };
  frames[SEQ_TITLE] = { at: { x: SEQ_FLOW_FRAMES * FRAME_STEP, y: 0 }, nodes: {}, style: "modern", direction: "TB" };
  return `${JSON.stringify({ version: 2, frames, sketches: [] })}\n`;
}
