import type { TextEdit } from "../protocol";
import { DIAGRAM_KINDS, type DiagramKind, MAX_BOARD_FRAMES, MAX_BOARD_SHAPES, quote } from "./model";
import { type FlowParse, type FlowParseOptions, type FlowRange, type FlowSpan, MAX_PROBLEMS, parseFlow } from "./parse";
import { FIX_TITLES, type FlowProblem, MESSAGES } from "./problems";

/** One frame's slice of the file. `line` is the 1-based file line it starts on. */
export type FrameSlice = { index: number; from: number; to: number; line: number };

/** True when the line `text[lineFrom, lineTo)` starts a frame after the first: `diagram`, a known kind, then a break. */
export function isFrameHeader(text: string, lineFrom: number, lineTo: number): boolean {
  let end = lineTo;
  if (end > lineFrom && text.charCodeAt(end - 1) === 13) end--;
  if (!text.startsWith("diagram", lineFrom) || lineFrom + 7 >= end) return false;
  let i = lineFrom + 7;
  const sep = i;
  while (i < end && (text[i] === " " || text[i] === "\t")) i++;
  if (i === sep) return false;
  const kindFrom = i;
  while (i < end && /[A-Za-z0-9_]/.test(text[i])) i++;
  if (!DIAGRAM_KINDS.includes(text.slice(kindFrom, i) as (typeof DIAGRAM_KINDS)[number])) return false;
  if (i === end) return true;
  const c = text[i];
  return c === " " || c === "\t" || c === '"' || (c === "/" && text[i + 1] === "/");
}

/** A space, a tab, the CR of a CRLF break, or a byte order mark. */
const isSpaceOrBom = (c: string) => c === " " || c === "\t" || c === "\r" || c === "\uFEFF";

/** The first position in `[from, to)` that is not a space or a BOM, or `to`. */
function skipSpace(text: string, from: number, to: number): number {
  let i = from;
  while (i < to && isSpaceOrBom(text[i])) i++;
  return i;
}

function isBlankOrComment(text: string, from: number, to: number): boolean {
  const i = skipSpace(text, from, to);
  return i === to || (text[i] === "/" && text[i + 1] === "/");
}

const isBlank = (text: string, from: number, to: number) => skipSpace(text, from, to) === to;

/** Where the first frame's own lines start: past a BOM and the blank and comment lines above its first statement. */
export function boardTop(text: string): number {
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    if (!isBlankOrComment(text, pos, nl === -1 ? text.length : nl)) return pos;
    pos = nl === -1 ? text.length : nl + 1;
  }
  return pos;
}

/** Splits a board file into frame slices. Never empty; the frame cap belongs to `parseBoard`. */
export function splitFrames(text: string): FrameSlice[] {
  const frames: FrameSlice[] = [];
  let from = 0;
  let startLine = 1;
  let lastContentEnd = 0;
  let seenHeader = false;
  let pos = 0;
  let line = 1;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const lineTo = nl === -1 ? text.length : nl;
    const next = nl === -1 ? text.length : nl + 1;
    if (!seenHeader) {
      if (!isBlankOrComment(text, pos, lineTo)) {
        seenHeader = true;
        lastContentEnd = next;
      }
    } else if (isFrameHeader(text, pos, lineTo)) {
      frames.push({ index: frames.length, from, to: lastContentEnd, line: startLine });
      from = pos;
      startLine = line;
      lastContentEnd = next;
    } else if (!isBlank(text, pos, lineTo)) {
      lastContentEnd = next;
    }
    pos = next;
    line++;
  }
  frames.push({ index: frames.length, from, to: text.length, line: startLine });
  return frames;
}

/**
 * The span of `text` a paste over `where` goes into: the frame holding `where.from`, frame 0 when there is no
 * `where`, to the frame's end or the selection's end if that is later (a gap after a frame is that frame's). Null
 * when the selection runs into the next frame.
 */
export function pasteFrame(text: string, where: { from: number; to: number } | null): { from: number; to: number } | null {
  const frames = splitFrames(text);
  if (!where) return { from: frames[0].from, to: frames[0].to };
  let i = 0;
  while (i + 1 < frames.length && frames[i + 1].from <= where.from) i++;
  const next = i + 1 < frames.length ? frames[i + 1].from : text.length;
  if (where.to > next) return null;
  return { from: frames[i].from, to: Math.max(frames[i].to, where.to) };
}

/** One frame and its parse; the parse is relative to the slice. */
export type FrameParse = FrameSlice & { text: string; parse: FlowParse };

export type BoardParse = {
  text: string;
  frames: FrameParse[];
  /**
   * In file positions: each frame's problems and the board's own, sorted by `from`, at most MAX_PROBLEMS. The
   * board's own are always kept; the frames' fill the room left.
   */
  problems: FlowProblem[];
  /** Every frame's defined names and groups. */
  shapes: number;
  /** The frame holding `pos`; a gap between frames counts as the frame before it. */
  frameAt(pos: number): number;
};

export function shiftEdits(edits: readonly TextEdit[], by: number): TextEdit[] {
  return edits.map((e) => ({ from: e.from + by, to: e.to + by, insert: e.insert }));
}

const shiftRange = (r: FlowRange, by: number): FlowRange => ({ from: r.from + by, to: r.to + by });

const SPAN_PARTS = ["name", "attrs", "kind", "open", "close", "fromName", "toName", "arrow", "label", "line"] as const;

/** `span` moved by `by`, every range in it, `values` included. */
export function shiftSpan(span: FlowSpan | null, by: number): FlowSpan | null {
  if (!span) return null;
  const out: FlowSpan = { from: span.from + by, to: span.to + by };
  for (const part of SPAN_PARTS) {
    const r = span[part];
    if (r) out[part] = shiftRange(r, by);
  }
  if (span.values) {
    const values: Record<string, FlowRange> = Object.create(null);
    for (const key of Object.keys(span.values)) values[key] = shiftRange(span.values[key], by);
    out.values = values;
  }
  return out;
}

/** A slice-relative problem in file positions: offsets and fix edits by `frame.from`, its line by `frame.line - 1`. */
export function shiftProblem(p: FlowProblem, frame: FrameSlice): FlowProblem {
  return {
    ...p,
    line: p.line + frame.line - 1,
    from: p.from + frame.from,
    to: p.to + frame.from,
    fixes: p.fixes.map((f) => ({ title: f.title, edits: shiftEdits(f.edits, frame.from) })),
  };
}

/** A frame's header in file positions: its `diagram` statement when it was read, else its first line. */
function headerOf(text: string, frame: FrameSlice, parse: FlowParse | null): { from: number; to: number; line: number } {
  const d = parse?.span("diagram");
  if (d) {
    let line = frame.line;
    for (let i = text.indexOf("\n", frame.from); i !== -1 && i < frame.from + d.from; i = text.indexOf("\n", i + 1)) line++;
    return { from: frame.from + d.from, to: frame.from + d.to, line };
  }
  const nl = text.indexOf("\n", frame.from);
  let to = nl === -1 || nl > frame.to ? frame.to : nl;
  if (to > frame.from && text.charCodeAt(to - 1) === 13) to--;
  return { from: frame.from, to, line: frame.line };
}

/** Two frames with one title: an error on the second, renaming it to the first free "<title> <n>". */
function titleProblems(text: string, frames: FrameParse[]): FlowProblem[] {
  const out: FlowProblem[] = [];
  const seen = new Set<string>();
  const taken = new Set(frames.map((f) => f.parse.title));
  for (const f of frames) {
    const title = f.parse.title;
    if (!seen.has(title)) {
      seen.add(title);
      continue;
    }
    const head = headerOf(text, f, f.parse);
    const base = title || "Untitled";
    let n = 2;
    while (taken.has(`${base} ${n}`)) n++;
    const next = `${base} ${n}`;
    taken.add(next);
    const t = f.parse.span("title");
    const k = f.parse.span("kind");
    const edit = t ? { from: f.from + t.from, to: f.from + t.to, insert: quote(next) } : k ? { from: f.from + k.to, to: f.from + k.to, insert: ` ${quote(next)}` } : null;
    const at = t ? { from: f.from + t.from, to: f.from + t.to } : head;
    out.push({
      line: head.line,
      from: at.from,
      to: at.to,
      severity: "error",
      message: MESSAGES.frameTwice(title),
      fixes: edit ? [{ title: FIX_TITLES.renameSecond, edits: [edit] }] : [],
    });
  }
  return out;
}

/**
 * Parses a board: each frame alone with parseFlow, then the board's own checks (titles, the frame count, the shape
 * count). A frame whose text equals a frame of `previous` keeps that frame's parse (unless it is owed icon
 * suggestions); `opts` are not compared, so a
 * caller whose options changed passes no `previous`. One frame skips the shape count, so a one-diagram file has
 * exactly the problems parseFlow gives it.
 */
export function parseBoard(text: string, opts: FlowParseOptions = {}, previous: BoardParse | null = null): BoardParse {
  const slices = splitFrames(text);
  const reuse = new Map<string, FlowParse>();
  // A parse still owed icon suggestions is not kept, so a later parse can look them up.
  if (previous) for (const f of previous.frames) if (!f.parse.iconsDeferred) reuse.set(f.text, f.parse);
  const frames: FrameParse[] = [];
  for (const slice of slices.slice(0, MAX_BOARD_FRAMES)) {
    const own = text.slice(slice.from, slice.to);
    frames.push({ ...slice, text: own, parse: reuse.get(own) ?? parseFlow(own, opts) });
  }
  const problems: FlowProblem[] = [];
  for (const f of frames) for (const p of f.parse.problems) problems.push(f.from === 0 && f.line === 1 ? p : shiftProblem(p, f));
  const board = titleProblems(text, frames);
  if (slices.length > MAX_BOARD_FRAMES) {
    const head = headerOf(text, slices[MAX_BOARD_FRAMES], null);
    board.push({ ...head, severity: "error", message: MESSAGES.tooManyFrames, fixes: [] });
  }
  let shapes = 0;
  for (const f of frames) {
    const before = shapes;
    shapes += f.parse.defined.size;
    if (slices.length > 1 && before <= MAX_BOARD_SHAPES && shapes > MAX_BOARD_SHAPES) {
      board.push({ ...headerOf(text, f, f.parse), severity: "error", message: MESSAGES.tooManyShapes, fixes: [] });
    }
  }
  if (board.length) {
    // The board's own problems are never cut: the frames' fill what room is left.
    if (problems.length > MAX_PROBLEMS - board.length) problems.length = Math.max(0, MAX_PROBLEMS - board.length);
    problems.push(...board);
    problems.sort((a, b) => a.from - b.from);
  } else if (problems.length > MAX_PROBLEMS) problems.length = MAX_PROBLEMS;
  const frameAt = (pos: number) => {
    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (frames[mid].from <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return { text, frames, problems, shapes, frameAt };
}

const isWsCode = (c: number) => c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0xfeff || c === 0x3000 || (c >= 0x2000 && c <= 0x200a);

/**
 * Each frame's kind and title, read from its header line as `parse.ts` reads it (kind null when the word is no
 * kind, title "" when there is none or its quote never closes), without a parse. `from` is the frame's start.
 */
export function frameHeaders(text: string): { kind: DiagramKind | null; title: string; from: number }[] {
  const out: { kind: DiagramKind | null; title: string; from: number }[] = [];
  for (const f of splitFrames(text)) {
    // The header is the frame's first statement line: past a BOM and the blank and comment lines above it.
    let p = f.index === 0 ? boardTop(text) : f.from;
    const nl = text.indexOf("\n", p);
    const e = Math.min(nl === -1 ? text.length : nl, f.to);
    const at = (i: number) => text.charCodeAt(i);
    while (p < e && isWsCode(at(p))) p++;
    if (!(text.startsWith("diagram", p) && (p + 7 >= e || isWsCode(at(p + 7))))) {
      out.push({ kind: null, title: "", from: f.from });
      continue;
    }
    let q = p + 7;
    while (q < e && isWsCode(at(q))) q++;
    let r = q;
    while (r < e && !isWsCode(at(r)) && at(r) !== 34 && !(at(r) === 47 && r + 1 < e && at(r + 1) === 47)) r++;
    const word = text.slice(q, r);
    const kind = (DIAGRAM_KINDS as readonly string[]).includes(word) ? (word as DiagramKind) : null;
    let t = r;
    while (t < e && isWsCode(at(t))) t++;
    let title = "";
    if (t < e && at(t) === 34) {
      let value = "";
      let chunk = t + 1;
      for (let j = t + 1; j < e; j++) {
        const c = at(j);
        if (c === 92 && j + 1 < e) {
          const n = at(j + 1);
          value += text.slice(chunk, j) + (n === 110 ? "\n" : n === 114 ? "\r" : text[j + 1]);
          j++;
          chunk = j + 1;
        } else if (c === 34) {
          title = value + text.slice(chunk, j);
          break;
        }
      }
    } else if (t < e && !(at(t) === 47 && t + 1 < e && at(t + 1) === 47)) {
      let j = t;
      while (j < e && !(at(j) === 47 && j + 1 < e && at(j + 1) === 47)) j++;
      while (j > t && isWsCode(at(j - 1))) j--;
      title = text.slice(t, j);
    }
    out.push({ kind, title, from: f.from });
  }
  return out;
}
