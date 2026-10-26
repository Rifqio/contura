// Board edits: add, rename and delete a frame. Each works on the whole file text and answers in file positions.
import { type BoardParse, boardTop } from "./board";
import { lineBreak, type FlowEditResult } from "./edits";
import { type DiagramKind, MAX_BOARD_FRAMES, quote } from "./model";

export const BOARD_NOTES = {
  full: `A board holds at most ${MAX_BOARD_FRAMES} diagrams.`,
  lastOne: "A board keeps at least one diagram.",
  emptyTitle: "A diagram needs a title.",
  titleTaken: "Another diagram on this board has that title.",
  noFrame: "That diagram is not on this board.",
  openTitle: "Close the quotes of this diagram's title first.",
  noHeader: "This diagram has no diagram line to hold a title.",
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
