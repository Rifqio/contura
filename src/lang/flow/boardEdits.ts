// Board edits: add, append, rename, duplicate and delete frames. Each works on the whole file text and answers in file positions.
import { DIAGRAM_KIND_WORD } from "../../flow/diagramKinds";
import { type BoardParse, boardTop, frameHeaders } from "./board";
import { lineBreak, type FlowEditResult } from "./edits";
import { type DiagramKind, MAX_BOARD_FRAMES, MAX_BOARD_SHAPES, quote } from "./model";
import { parseFlow } from "./parse";

export const BOARD_NOTES = {
  full: `A board holds at most ${MAX_BOARD_FRAMES} diagrams.`,
  lastOne: "A board keeps at least one diagram.",
  emptyTitle: "A diagram needs a title.",
  titleTaken: "Another diagram on this board has that title.",
  noFrame: "That diagram is not on this board.",
  openTitle: "Close the quotes of this diagram's title first.",
  noHeader: "This diagram has no diagram line to hold a title.",
  shapes: "This board would have more than 10,000 shapes, so nothing was added.",
} as const;

/** Appends `diagram <kind> "<title>"` after one blank line; a taken title becomes `Title 2`, `Title 3`; an empty one is refused. */
export function addFrame(text: string, board: BoardParse, kind: DiagramKind, title: string): FlowEditResult {
  if (board.frames.length >= MAX_BOARD_FRAMES) return { edits: [], note: BOARD_NOTES.full };
  const want = title.trim();
  if (want === "") return { edits: [], note: BOARD_NOTES.emptyTitle };
  const taken = new Set(board.frames.map((f) => f.parse.title));
  let used = want;
  for (let n = 2; taken.has(used); n++) used = `${want} ${n}`;
  const lb = lineBreak(text);
  let cut = text.length;
  while (cut > 0 && /\s/.test(text[cut - 1])) cut--;
  const header = `diagram ${kind} ${quote(used)}${lb}`;
  return { edits: [{ from: cut, to: text.length, insert: cut === 0 ? header : `${lb}${lb}${header}` }], name: used };
}

/** What `appendFrames` reads of a board: each frame's title and the shape count. */
export type BoardCounts = { frames: readonly { parse: { title: string } }[]; shapes: number };

/**
 * Appends whole frames, each after one blank line as `addFrame` appends, in the file's line break. Each text holds
 * exactly one header with a kind; an empty title becomes the kind's word, and each title is made free against the
 * board and the frames before it (`Title 2`) by rewriting only its header's title. `names` maps each text's index to
 * the title it took. Refused whole past the frame or shape cap.
 */
export function appendFrames(text: string, board: BoardCounts, frames: readonly string[]): FlowEditResult {
  if (board.frames.length + frames.length > MAX_BOARD_FRAMES) return { edits: [], note: BOARD_NOTES.full };
  const lb = lineBreak(text);
  const taken = new Set(board.frames.map((f) => f.parse.title));
  const names: Record<string, string> = {};
  const blocks: string[] = [];
  let shapes = board.shapes;
  for (let i = 0; i < frames.length; i++) {
    let t = frames[i].replace(/^\uFEFF/, "").replace(/\r?\n/g, lb).replace(/\s+$/, "");
    const heads = frameHeaders(t);
    const kind = heads.length === 1 ? heads[0].kind : null;
    if (kind === null) return { edits: [], note: BOARD_NOTES.noHeader };
    const parse = parseFlow(t);
    shapes += parse.defined.size;
    if (shapes > MAX_BOARD_SHAPES) return { edits: [], note: BOARD_NOTES.shapes };
    const span = parse.span("title");
    const k = parse.span("kind");
    if (!span && !k) return { edits: [], note: BOARD_NOTES.noHeader };
    // A title whose quote is not closed did not read: a second title after the kind would leave the line broken.
    if (!span && /^[ \t]*"/.test(t.slice(k!.to))) return { edits: [], note: BOARD_NOTES.openTitle };
    const base = parse.title.trim() === "" ? DIAGRAM_KIND_WORD[kind] : parse.title;
    let used = base;
    for (let n = 2; taken.has(used); n++) used = `${base} ${n}`;
    taken.add(used);
    names[String(i)] = used;
    if (used !== parse.title || !span) {
      t = span ? t.slice(0, span.from) + quote(used) + t.slice(span.to) : `${t.slice(0, k!.to)} ${quote(used)}${t.slice(k!.to)}`;
    }
    blocks.push(`${t}${lb}`);
  }
  if (blocks.length === 0) return { edits: [] };
  let cut = text.length;
  while (cut > 0 && /\s/.test(text[cut - 1])) cut--;
  const body = blocks.join(lb);
  return { edits: [{ from: cut, to: text.length, insert: cut === 0 ? body : `${lb}${lb}${body}` }], names };
}

/** Replaces only the title (or adds one after the kind); an empty or taken title is refused. */
export function renameFrame(text: string, board: BoardParse, frameIndex: number, title: string): FlowEditResult {
  const f = board.frames[frameIndex];
  if (!f) return { edits: [], note: BOARD_NOTES.noFrame };
  const next = title.trim();
  if (next === "") return { edits: [], note: BOARD_NOTES.emptyTitle };
  if (board.frames.some((o) => o !== f && o.parse.title === next)) return { edits: [], note: BOARD_NOTES.titleTaken };
  if (f.parse.title === next) return { edits: [] };
  const t = f.parse.span("title");
  if (t) return { edits: [{ from: f.from + t.from, to: f.from + t.to, insert: quote(next) }] };
  const k = f.parse.span("kind");
  if (!k) return { edits: [], note: BOARD_NOTES.noHeader };
  // A title whose quote is not closed did not read: a second title after the kind would leave the line broken.
  if (/^[ \t]*"/.test(text.slice(f.from + k.to, f.to))) return { edits: [], note: BOARD_NOTES.openTitle };
  return { edits: [{ from: f.from + k.to, to: f.from + k.to, insert: ` ${quote(next)}` }] };
}

/**
 * Removes the frame and the gap before it (for frame 0, the gap after it); the last frame is kept. A BOM and the
 * comment lines above the first header belong to the board, so deleting frame 0 keeps them.
 */
export function deleteFrame(text: string, board: BoardParse, frameIndex: number): FlowEditResult {
  const f = board.frames[frameIndex];
  if (!f) return { edits: [], note: BOARD_NOTES.noFrame };
  if (board.frames.length <= 1) return { edits: [], note: BOARD_NOTES.lastOne };
  if (frameIndex === 0) return { edits: [{ from: boardTop(text), to: board.frames[1].from, insert: "" }] };
  return { edits: [{ from: board.frames[frameIndex - 1].to, to: f.to, insert: "" }] };
}

/**
 * A copy of the frame right after it, after one blank line, its title made free (`Title 2`, `Title 3`; an untitled
 * frame's copy is `Untitled`). Frame 0's copy leaves out the BOM and the comment lines above its header, which belong
 * to the board. Refused past the frame or shape cap.
 */
export function duplicateFrame(text: string, board: BoardParse, frameIndex: number): FlowEditResult {
  const f = board.frames[frameIndex];
  if (!f) return { edits: [], note: BOARD_NOTES.noFrame };
  if (board.frames.length >= MAX_BOARD_FRAMES) return { edits: [], note: BOARD_NOTES.full };
  if (board.shapes + f.parse.defined.size > MAX_BOARD_SHAPES) return { edits: [], note: BOARD_NOTES.shapes };
  const start = frameIndex === 0 ? boardTop(text) : f.from;
  let end = f.to;
  while (end > start && /\s/.test(text[end - 1])) end--;
  // The title's and the kind's spans are relative to the slice, which starts at `f.from`.
  const t = f.parse.span("title");
  const k = f.parse.span("kind");
  if (!t && !k) return { edits: [], note: BOARD_NOTES.noHeader };
  if (!t && /^[ \t]*"/.test(text.slice(f.from + k!.to, f.to))) return { edits: [], note: BOARD_NOTES.openTitle };
  const taken = new Set(board.frames.map((o) => o.parse.title));
  const base = f.parse.title || "Untitled";
  let used = base;
  for (let n = 2; taken.has(used); n++) used = `${base} ${n}`;
  const cut = t ? { from: f.from + t.from, to: f.from + t.to, insert: quote(used) } : { from: f.from + k!.to, to: f.from + k!.to, insert: ` ${quote(used)}` };
  const copy = text.slice(start, cut.from) + cut.insert + text.slice(cut.to, end);
  const lb = lineBreak(text);
  return { edits: [{ from: end, to: end, insert: `${lb}${lb}${copy}` }], name: used };
}
