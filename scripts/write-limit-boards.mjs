#!/usr/bin/env node
// Writes the ER limit board as files for the release WebView milestone (Plan F Task 3, ruling 11; Task 9):
// `er2000.flow` and `er2000.flow.layout.json`, the board erBoard.perf.test.ts builds (fixtures/erBoard.ts): 40
// flowchart frames of A5's board and one ERD of 2,000 tables of 20 columns with 2,000 column relationships, 10,000
// shapes. And the sequence limit board (Plan E Task 9, for Task 10's live run): `seq2000.flow` and its layout, the
// board sequence.perf.test.ts builds (fixtures/bigSequence.ts): the same 40 flowchart frames and one sequence of 2,000
// participants, 3,000 messages, 200 blocks and 300 activations, 10,000 shapes. write-limit-boards.test.mjs checks the
// files equal the fixtures.
//
//   node scripts/write-limit-boards.mjs <dir>
//
// The directory is made if missing; existing files of those names are replaced. Nothing else is touched.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FLOW_FRAMES = 40;
const FRAME_STEP = 5200;
const NODES = 198;
const LINKS = 300;
const TABLES = Array.from({ length: 2000 }, (_, i) => `t${i}`);

/** Frame `k` of A5's board (fixtures/bigBoard.ts `frame`). */
function frame(k) {
  const lines = [`diagram flow "Area ${k}"`, ""];
  for (const [g, side] of ["Left", "Right"].entries()) {
    lines.push(`${side} ${k} {`);
    for (let i = 0; i < NODES / 2; i++) lines.push(`  Step ${g * (NODES / 2) + i}`);
    lines.push("}");
  }
  for (let i = 0; i < LINKS; i++) lines.push(`Step ${i % NODES} > Step ${(i * 7 + 1) % NODES}: go ${i}`);
  return `${lines.join("\n")}\n`;
}

/** The board's text (fixtures/erBoard.ts `ER_BOARD_TEXT`). */
export function erBoardText() {
  const block = (t) => [`${t} {`, "  id int pk", ...Array.from({ length: 19 }, (_, c) => `  c${c + 1} int`), "}"];
  const ring = TABLES.map((t, i) => `${t}.c1 > ${TABLES[(i + 1) % TABLES.length]}.id`);
  const erd = ['diagram er "Schema"', ...TABLES.flatMap(block), "", ...ring, ""].join("\n");
  return `${Array.from({ length: FLOW_FRAMES }, (_, k) => `${frame(k)}\n`).join("")}${erd}`;
}

/** The board's layout file (fixtures/erBoard.ts `erBoardLayoutFile`). */
export function erBoardLayoutFile() {
  const steps = Object.create(null);
  for (let i = 0; i < NODES; i++) steps[`Step ${i}`] = { x: (i % 10) * 220 + (i >= NODES / 2 ? 2400 : 0), y: Math.floor((i % (NODES / 2)) / 10) * 100 };
  const frames = Object.create(null);
  for (let k = 0; k < FLOW_FRAMES; k++) frames[`Area ${k}`] = { at: { x: k * FRAME_STEP, y: 0 }, nodes: steps, style: "modern", direction: "TB" };
  const tables = Object.create(null);
  TABLES.forEach((t, i) => (tables[t] = { x: (i % 50) * 260, y: Math.floor(i / 50) * 520 }));
  frames.Schema = { at: { x: FLOW_FRAMES * FRAME_STEP, y: 0 }, nodes: tables, style: "modern", direction: "TB" };
  return `${JSON.stringify({ version: 2, frames, sketches: [] })}\n`;
}

// ----- The sequence limit board (fixtures/bigSequence.ts).

const SEQ_PARTICIPANTS = 2000;
const SEQ_MESSAGES = 3000;
const SEQ_ICONS = ["user", "monitor", "server", "credit-card", "database", "cloud", "lock", "mail"];
const SEQ_COLOURS = ["accent", "info", "success", "warning", "danger", "muted", "#3b82f6", "#e11d48"];
const SEQ_KINDS = ["loop", "alt", "opt", "par", "critical"];
const SEQ_SECTION = 30;
const SEQ_WORDS = "fetch the next page of orders for review";
const SEQ_TITLE = "Limit";
const who = (k) => `Svc ${k}`;

/** Message `i`'s label (bigSequence.ts `label`). */
function seqLabel(i) {
  const n = 4 + ((i * 13) % 37);
  const s = `m${i} ${SEQ_WORDS}`.slice(0, n);
  return s.endsWith(" ") ? `${s.slice(0, -1)}x` : s;
}

/** Message `i` (bigSequence.ts `message`). */
function seqMessage(i) {
  const k = i % (SEQ_PARTICIPANTS - 6);
  if (i % 50 === 0) return `${who(k)} -> ${who(k)}: ${seqLabel(i)}`;
  if (i % 40 === 0) return `${who(k)} -> ${who(k + 5)}: ${seqLabel(i)}`;
  return i % 2 ? `${who(k + 1)} --> ${who(k)}: ${seqLabel(i)}` : `${who(k)} -> ${who(k + 1)}: ${seqLabel(i)}`;
}

/** The sequence at its limit (fixtures/bigSequence.ts `bigSequence`). */
export function bigSequenceText(title = SEQ_TITLE) {
  const out = [`diagram sequence "${title}"`, "autonumber"];
  for (let i = 0; i < SEQ_PARTICIPANTS; i++) out.push(`participant ${who(i)} [icon: ${SEQ_ICONS[i % 8]}, color: ${SEQ_COLOURS[i % 8]}]`);
  out.push("");
  let block = 0;
  let pad = "";
  const open = () => {
    out.push(`${pad}${SEQ_KINDS[block % SEQ_KINDS.length]} step ${block} [color: ${SEQ_COLOURS[block % 8]}] {`);
    block++;
    pad += "  ";
  };
  const close = () => {
    pad = pad.slice(2);
    out.push(`${pad}}`);
  };
  let active = null;
  const send = (i) => {
    if (i === SEQ_MESSAGES / 2) out.push(`${pad}autonumber 500`);
    if (i % 10 === 5) {
      active = who((i % (SEQ_PARTICIPANTS - 6)) + 1);
      out.push(`${pad}activate ${active}`);
    }
    out.push(`${pad}${seqMessage(i)}`);
    if (i % 10 === 7 && active) {
      out.push(`${pad}deactivate ${active}`);
      active = null;
    }
  };
  for (let s = 0; s < SEQ_MESSAGES / SEQ_SECTION; s++) {
    const at = s * SEQ_SECTION;
    open();
    if (s % 2 === 0) {
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
      for (let i = 0; i < SEQ_SECTION; i++) send(at + i);
    }
    close();
  }
  return `${out.join("\n")}\n`;
}

/** The sequence limit board's text (fixtures/bigSequence.ts `seqBoardText`). */
export function seqBoardText() {
  return `${Array.from({ length: FLOW_FRAMES }, (_, k) => `${frame(k)}\n`).join("")}${bigSequenceText(SEQ_TITLE)}`;
}

/** The sequence limit board's layout file (fixtures/bigSequence.ts `seqBoardLayoutFile`). */
export function seqBoardLayoutFile() {
  const steps = Object.create(null);
  for (let i = 0; i < NODES; i++) steps[`Step ${i}`] = { x: (i % 10) * 220 + (i >= NODES / 2 ? 2400 : 0), y: Math.floor((i % (NODES / 2)) / 10) * 100 };
  const frames = Object.create(null);
  for (let k = 0; k < FLOW_FRAMES; k++) frames[`Area ${k}`] = { at: { x: k * FRAME_STEP, y: 0 }, nodes: steps, style: "modern", direction: "TB" };
  frames[SEQ_TITLE] = { at: { x: FLOW_FRAMES * FRAME_STEP, y: 0 }, nodes: {}, style: "modern", direction: "TB" };
  return `${JSON.stringify({ version: 2, frames, sketches: [] })}\n`;
}

/** Writes the four files into `dir`; returns their paths. */
export function writeLimitBoards(dir) {
  mkdirSync(dir, { recursive: true });
  const flow = join(dir, "er2000.flow");
  const layout = join(dir, "er2000.flow.layout.json");
  const seqFlow = join(dir, "seq2000.flow");
  const seqLayout = join(dir, "seq2000.flow.layout.json");
  writeFileSync(flow, erBoardText());
  writeFileSync(layout, erBoardLayoutFile());
  writeFileSync(seqFlow, seqBoardText());
  writeFileSync(seqLayout, seqBoardLayoutFile());
  return { flow, layout, seqFlow, seqLayout };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir || process.argv.length > 3) {
    console.error("usage: node scripts/write-limit-boards.mjs <dir>");
    process.exit(2);
  }
  const out = writeLimitBoards(resolve(dir));
  console.log(`wrote ${out.flow}\nwrote ${out.layout}\nwrote ${out.seqFlow}\nwrote ${out.seqLayout}`);
}
